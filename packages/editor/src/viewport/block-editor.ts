/**
 * The Scene view's block-layer editing — the grid of the
 * selected layer with its movable height slice, the cell under the pointer,
 * brush strokes, the selection box, region outlines and the metadata overlay.
 *
 * Strokes follow the gizmo-drag rule (charter): a freehand stroke (paint,
 * erase, raise/lower, metadata cells) previews locally — its new cells are
 * applied with the project-model's own `applyBlockEdits` to a copy of the
 * layer and the touched chunks re-meshed — and the release commits ONE
 * `editBlocks` command (one undo step per gesture, no round trip per pointer
 * move). Shape tools (line, rectangle, box, region, select, stamp, paste)
 * show a ghost of the cells they will cover; click tools (flood, replace-all,
 * eyedropper) act on release.
 *
 * Picking walks the layer's cells (the project-model DDA, the same the
 * runtime's `ctx.grid.pick` uses) against the stroke-start cells, so a stroke
 * never climbs onto the cells it has just painted; where no block is under
 * the pointer the target is the slice plane.
 *
 * The terrain brushes (height, smooth, flatten) aim at the ground itself
 * (the layer's drawn surface under the pointer) and drop `sculpt` dabs along
 * the drag — each previewed on the layer copy as it lands, all of them sent
 * as one `editBlocks` on release. The Paint mode (the `paint`
 * tool) works the same way with `paint` dabs of the paint brush.
 *
 * Browser-only (three.js); the maths is `session/block-brush.ts`.
 */
import * as THREE from 'three';
import { BLOCK_EDIT_MAX_EDITS, BlockGrid, applyBlockEdits, effectiveCellMeta, pickCell } from '@thirdlight/runtime';
import type { BlockCell, BlockChunk, BlockEdit, BlockLayerComponent, BlockRegion, BlockStamp, BlockType, CellField } from '@thirdlight/project-model';
import type { BlockLayerView } from '@thirdlight/three-adapter';
import {
  DEFAULT_BRUSH,
  beginStroke,
  boxBetween,
  brushCell,
  clipBox,
  dabSpacing,
  extendStroke,
  lineCells,
  rectBetween,
  sculptEdit,
  paintEdit,
  strokeEdits,
  toolAdds,
  toolFreehand,
  toolRect,
  toolDabs,
  type BlockToolId,
  type BrushState,
  type Cell3,
  type CellBox,
  type PasteSource,
  type Stroke,
  type StrokeContext,
} from '../session/block-brush';
import { overlayColor } from '../session/block-overlay';

/** What the panel sets (the tool, the brush and its options). */
export interface BlockToolOptions {
  tool: BlockToolId;
  brush: BrushState;
  /** Lower columns / remove from a region (the panel's toggle; Ctrl held inverts it for one stroke). */
  invert: boolean;
  meta: { field: string; value: import('@thirdlight/project-model').CellMetaValue | null; occupiedOnly: boolean; shape: 'cells' | 'rect' } | null;
  region: string | null;
  stamp: { stampId: string; rot: 0 | 90 | 180 | 270; mirror: 'x' | 'z' | null } | null;
  paste: PasteSource | null;
  /** The copied box's size (the paste ghost). */
  pasteSize: [number, number, number] | null;
}

/** The selected layer as the editor holds it. */
export interface BlockEditLayer {
  entityId: string;
  component: BlockLayerComponent;
  origin: readonly number[];
  chunks: ReadonlyMap<string, BlockChunk>;
  regions: readonly BlockRegion[];
  /** The layer's object is locked (Hierarchy flag): nothing is edited. */
  locked: boolean;
  /** The layer's object is inactive (hidden). */
  hidden: boolean;
}

export interface BlockEditorCallbacks {
  /** Commit one stroke (one editBlocks); resolves true when stored. */
  onCommit(entityId: string, edits: BlockEdit[]): Promise<boolean>;
  /** The eyedropper took a cell (null: an empty cell). */
  onPick(cell: BlockCell | null): void;
  /** A selection box was dragged (null: cleared). */
  onSelect(box: CellBox | null): void;
  /** The cell under the pointer (null: none), for the panel's readout. */
  onHover(at: Cell3 | null, cell: BlockCell | null): void;
  /** Something cannot be done (a locked or hidden layer, no block chosen). */
  onRefused(message: string): void;
}

export interface BlockEditorHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly canvas: HTMLCanvasElement;
  requestRender(): void;
  /** The chunk renderer (the preview writes into it). */
  view(): BlockLayerView;
  /**
   * The tools were armed or disarmed. Armed, they own the left button in the
   * Scene view, so the host stands its transform gizmo aside (the layer they
   * edit is the selection, and its gizmo would sit over the cells).
   */
  armed?(on: boolean): void;
}

const HOVER_ADD = 0x6ee7a0;
const HOVER_HIT = 0xffc857;
const HOVER_ERASE = 0xff6b6b;
const SELECTION = 0xffe066;
const REGION = 0x4cc9f0;
const GHOST = 0x9ad7ff;

function edgesBox(color: number): THREE.LineSegments {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  geo.translate(0.5, 0.5, 0.5);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const l = new THREE.LineSegments(geo, mat);
  l.renderOrder = 20;
  l.visible = false;
  return l;
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry !== undefined) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export class BlockEditor {
  private readonly host: BlockEditorHost;
  private readonly cb: BlockEditorCallbacks;
  private readonly root = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private active = false;
  private layer: BlockEditLayer | null = null;
  private layerKey = '';
  /** The layer's stored cells (picking, targets, the overlay). */
  private grid: BlockGrid | null = null;
  private types = new Map<string, BlockType>();
  private fields: readonly CellField[] = [];
  private stamps = new Map<string, BlockStamp>();
  private opts: BlockToolOptions = { tool: 'single', brush: DEFAULT_BRUSH, invert: false, meta: null, region: null, stamp: null, paste: null, pasteSize: null };
  private slice = 0;
  private shownFields = new Set<string>();
  private showRegions = false;
  private selection: CellBox | null = null;
  // Scene objects.
  private gridLines: THREE.LineSegments | null = null;
  private slicePlane: THREE.Mesh | null = null;
  private readonly hover = edgesBox(HOVER_ADD);
  private readonly ghost: THREE.Mesh;
  private readonly ghostEdges = edgesBox(GHOST);
  private lineGhost: THREE.InstancedMesh | null = null;
  private readonly selectionBox = edgesBox(SELECTION);
  private regionLines: THREE.LineSegments | null = null;
  private overlay: THREE.Group | null = null;
  private overlayKey = '';
  // The stroke in flight.
  private stroke: Stroke | null = null;
  private strokeInvert = false;
  private scratch: BlockGrid | null = null;
  private previewChunks = new Set<string>();
  private previewMs = 0;
  private target: { cell: Cell3; value: BlockCell | null } | null = null;
  /** A terrain brush stroke: its dabs (sent on release), the last dab's centre (columns) and the flatten height (rows). */
  private sculpt: { tool: 'height' | 'smooth' | 'flatten' | 'paint'; dabs: BlockEdit[]; last: [number, number]; level: number; invert: boolean } | null = null;
  private readonly ring: THREE.LineLoop;
  /** Measured stroke timings (tests read them from the canvas). */
  private lastStroke: { tool: BlockToolId; cells: number; previewMs: number; commitMs: number | null } | null = null;

  constructor(host: BlockEditorHost, cb: BlockEditorCallbacks) {
    this.host = host;
    this.cb = cb;
    this.root.name = 'block-editor';
    this.root.visible = false;
    const ghostMat = new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.25, depthWrite: false });
    const ghostGeo = new THREE.BoxGeometry(1, 1, 1);
    ghostGeo.translate(0.5, 0.5, 0.5);
    this.ghost = new THREE.Mesh(ghostGeo, ghostMat);
    this.ghost.renderOrder = 18;
    this.ghost.visible = false;
    // The terrain brush's footprint: a unit circle scaled to the radius, laid on the ground under the pointer.
    const circle: number[] = [];
    for (let i = 0; i < 48; i++) circle.push(Math.cos((i / 48) * Math.PI * 2), 0, Math.sin((i / 48) * Math.PI * 2));
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(circle, 3));
    this.ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: HOVER_HIT, depthTest: false, transparent: true }));
    this.ring.renderOrder = 20;
    this.ring.visible = false;
    this.root.add(this.hover, this.ghost, this.ghostEdges, this.selectionBox, this.ring);
    host.scene.add(this.root);
  }

  // ---- state ------------------------------------------------------------------------

  /** Arm or disarm the block tools (disarmed: nothing drawn, no pointer handling). */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) this.cancel();
    this.syncVisibility();
    this.host.canvas.setAttribute('data-block-tool', on ? this.opts.tool : '');
    this.host.armed?.(on);
  }

  isActive(): boolean {
    return this.active;
  }

  /** The block types, cell fields and stamps (the overlay and brushes read them). */
  setContent(types: readonly BlockType[], fields: readonly CellField[], stamps: readonly BlockStamp[]): void {
    const nextTypes = new Map(types.map((t) => [t.blockId, t]));
    const changed = JSON.stringify(fields) !== JSON.stringify(this.fields) || JSON.stringify([...nextTypes]) !== JSON.stringify([...this.types]);
    this.types = nextTypes;
    this.fields = fields;
    this.stamps = new Map(stamps.map((s) => [s.stampId, s]));
    if (changed) this.overlayKey = '';
    this.refreshOverlay();
  }

  /** The selected layer (null: none) and its cells; `revision` changes whenever its cells do. */
  setLayer(layer: BlockEditLayer | null, revision: number): void {
    const key = layer === null ? '' : `${layer.entityId}|${revision}|${JSON.stringify(layer.component)}`;
    const originChanged = layer !== null && this.layer !== null && (layer.origin[0] !== this.layer.origin[0] || layer.origin[1] !== this.layer.origin[1] || layer.origin[2] !== this.layer.origin[2]);
    const layerChanged = layer?.entityId !== this.layer?.entityId || JSON.stringify(layer?.component) !== JSON.stringify(this.layer?.component);
    this.layer = layer;
    if (key !== this.layerKey) {
      this.layerKey = key;
      this.grid = layer === null ? null : BlockGrid.from(layer.component, { entityId: layer.entityId, chunks: [...layer.chunks.values()] });
      this.overlayKey = '';
    }
    if (layerChanged && layer !== null) {
      const b = layer.component.bounds;
      this.slice = Math.min(b.max[1] - 1, Math.max(b.min[1], this.slice));
      this.selection = null;
    }
    if (layerChanged || originChanged) this.rebuildGrid();
    this.root.position.set(layer?.origin[0] ?? 0, layer?.origin[1] ?? 0, layer?.origin[2] ?? 0);
    this.root.updateMatrixWorld(true);
    this.rebuildRegions();
    this.refreshOverlay();
    this.syncVisibility();
    this.host.requestRender();
  }

  setOptions(o: BlockToolOptions): void {
    this.opts = o;
    // The terrain brushes show their round footprint instead of a cell.
    if (toolDabs(o.tool)) this.placeBox(this.hover, null);
    else this.ring.visible = false;
    if (this.active) this.host.canvas.setAttribute('data-block-tool', o.tool);
    this.rebuildRegions();
    this.host.requestRender();
  }

  /** The slice row (clamped to the layer's bounds). */
  setSlice(y: number): number {
    const b = this.layer?.component.bounds;
    this.slice = b === undefined ? y : Math.min(b.max[1] - 1, Math.max(b.min[1], Math.round(y)));
    this.rebuildGrid();
    this.host.canvas.setAttribute('data-block-slice', String(this.slice));
    this.host.requestRender();
    return this.slice;
  }

  getSlice(): number {
    return this.slice;
  }

  /** Which cell fields the overlay colours. */
  setShownFields(keys: ReadonlySet<string>): void {
    this.shownFields = new Set(keys);
    this.overlayKey = '';
    this.refreshOverlay();
    this.host.requestRender();
  }

  setShowRegions(on: boolean): void {
    this.showRegions = on;
    this.rebuildRegions();
    this.host.requestRender();
  }

  setSelection(box: CellBox | null): void {
    this.selection = box;
    this.placeBox(this.selectionBox, box);
    this.host.canvas.setAttribute('data-block-selection', box === null ? '' : box.join(','));
    this.host.requestRender();
  }

  /** A stored cell of the selected layer (null: empty). */
  cellAt(x: number, y: number, z: number): BlockCell | null {
    return this.grid?.get(x, y, z) ?? null;
  }

  /** The selected layer's column top (null: no block). */
  columnTop(x: number, z: number): number | null {
    return this.grid?.columnTop(x, z) ?? null;
  }

  /** Overlay plates drawn (tests read the count). */
  overlayCount(): number {
    let n = 0;
    this.overlay?.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh === true) n += (o as THREE.InstancedMesh).count;
    });
    return n;
  }

  // ---- pointer ---------------------------------------------------------------------

  /** A press in the Scene view: begins a stroke when the tools are armed (true: consumed). */
  pointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0 || e.altKey) return false;
    const layer = this.layer;
    if (layer === null) {
      this.cb.onRefused('Select a block layer first (its tools are in the Inspector).');
      return true;
    }
    if (layer.locked && this.opts.tool !== 'eyedropper' && this.opts.tool !== 'select') {
      this.cb.onRefused('The layer is locked (unlock it in its tools in the Inspector or in the Hierarchy).');
      return true;
    }
    if (layer.hidden) {
      this.cb.onRefused('The layer is hidden (show it to edit it).');
      return true;
    }
    if (toolDabs(this.opts.tool)) {
      const at = this.surfaceUnder(e.clientX, e.clientY);
      if (at === null) return true;
      this.strokeInvert = this.opts.invert !== (e.ctrlKey || e.metaKey);
      this.previewMs = 0;
      this.previewChunks.clear();
      this.scratch = null;
      this.sculpt = { tool: this.opts.tool, dabs: [], last: [at.x, at.z], level: at.rows, invert: this.strokeInvert };
      this.addDab(at.x, at.z);
      this.drawRing(at);
      return true;
    }
    const t = this.resolveTarget(e.clientX, e.clientY, null);
    if (t === null) return true;
    this.target = t;
    this.strokeInvert = this.opts.invert !== (e.ctrlKey || e.metaKey);
    this.stroke = beginStroke(this.opts.tool, t.cell);
    this.previewMs = 0;
    this.previewChunks.clear();
    this.scratch = null;
    if (toolFreehand(this.opts.tool, this.opts.meta?.shape)) this.previewFreehand([t.cell]);
    this.drawStroke();
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    if (!this.active) return false;
    if (toolDabs(this.opts.tool) || this.sculpt !== null) {
      const at = this.surfaceUnder(e.clientX, e.clientY);
      this.drawRing(at);
      const k = this.sculpt;
      if (k === null || at === null) return k !== null;
      // Dabs every quarter radius along the drag (a fast drag leaves no gaps).
      const step = dabSpacing(this.brushRadius());
      const dx = at.x - k.last[0];
      const dz = at.z - k.last[1];
      const n = Math.floor(Math.hypot(dx, dz) / step);
      for (let i = 1; i <= n; i++) this.addDab(k.last[0] + (dx * i) / n, k.last[1] + (dz * i) / n);
      if (n > 0) k.last = [at.x, at.z];
      return true;
    }
    const s = this.stroke;
    if (s === null) {
      // Hover: the target cell outline and the readout.
      const t = this.resolveTarget(e.clientX, e.clientY, null);
      this.target = t;
      this.host.canvas.setAttribute('data-block-hover', t === null ? '' : t.cell.join(','));
      this.drawHover(t?.cell ?? null);
      this.cb.onHover(t?.cell ?? null, t?.value ?? null);
      return false;
    }
    const t = this.resolveTarget(e.clientX, e.clientY, s);
    if (t === null) return true;
    const freehand = toolFreehand(s.tool, this.opts.meta?.shape);
    const before = s.cells.length;
    if (extendStroke(s, t.cell, freehand)) {
      if (freehand && s.cells.length > before) this.previewFreehand(s.cells.slice(before));
      this.drawStroke();
    }
    return true;
  }

  pointerUp(e: PointerEvent): boolean {
    const k = this.sculpt;
    if (k !== null) {
      this.sculpt = null;
      void this.finishSculpt(k.dabs);
      return true;
    }
    const s = this.stroke;
    if (s === null) return false;
    this.stroke = null;
    void e;
    void this.finishStroke(s);
    return true;
  }

  /** Esc: drop the stroke in flight (nothing is sent). */
  cancel(): boolean {
    if (this.sculpt !== null) {
      this.sculpt = null;
      this.restorePreview();
      return true;
    }
    if (this.stroke === null) return false;
    this.stroke = null;
    this.restorePreview();
    this.drawStroke();
    return true;
  }

  strokeInFlight(): boolean {
    return this.stroke !== null || this.sculpt !== null;
  }

  // ---- internals: terrain brushes ---------------------------------------------------

  /**
   * The ground under the pointer: where the ray meets the layer's drawn
   * surface (its chunk meshes, so a sloped top is hit where it is), as layer
   * columns and rows; with nothing drawn under it, the slice plane's top.
   */
  private surfaceUnder(clientX: number, clientY: number): { x: number; z: number; rows: number } | null {
    const layer = this.layer;
    if (layer === null) return null;
    const ray = this.ray(clientX, clientY);
    const o = { x: layer.origin[0] ?? 0, y: layer.origin[1] ?? 0, z: layer.origin[2] ?? 0 };
    const cs = layer.component.cellSize;
    const hits = this.raycaster.intersectObjects(this.host.view().layerMeshes(layer.entityId), false);
    let p: THREE.Vector3 | null = hits[0]?.point ?? null;
    if (p === null) p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(o.y + (this.slice + 1) * cs[1])), new THREE.Vector3());
    if (p === null) return null;
    const x = (p.x - o.x) / cs[0];
    const z = (p.z - o.z) / cs[2];
    const b = layer.component.bounds;
    if (x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) return null;
    return { x, z, rows: (p.y - o.y) / cs[1] };
  }

  /** The round brush's radius in cells: the paint brush's for the paint tool, else the terrain brush's. */
  private brushRadius(): number {
    return this.opts.tool === 'paint' || this.sculpt?.tool === 'paint' ? this.opts.brush.paint.radius : this.opts.brush.radius;
  }

  private drawRing(at: { x: number; z: number; rows: number } | null): void {
    const layer = this.layer;
    this.host.canvas.setAttribute('data-block-brush', at === null ? '' : `${at.x.toFixed(3)},${at.z.toFixed(3)},${at.rows.toFixed(3)}`);
    if (layer === null || at === null) {
      this.ring.visible = false;
    } else {
      const cs = layer.component.cellSize;
      this.ring.position.set(at.x * cs[0], at.rows * cs[1] + 0.02, at.z * cs[2]);
      const r = this.brushRadius();
      this.ring.scale.set(r * cs[0], 1, r * cs[2]);
      this.ring.visible = true;
      this.ring.updateMatrixWorld(true);
    }
    this.host.requestRender();
  }

  /** One dab of the terrain brush in flight: previewed on the layer copy at once, sent with the others on release. */
  private addDab(x: number, z: number): void {
    const k = this.sculpt;
    if (k === null || k.dabs.length >= BLOCK_EDIT_MAX_EDITS) return;
    const b = this.opts.brush;
    // The brush block grows empty ground (raising where nothing stands yet).
    const cell = brushCell(b, b.block !== null ? this.types.get(b.block) : undefined);
    // The paint tool paints the surface under the paint brush (invert: erase).
    const dab = k.tool === 'paint' ? paintEdit([x, z], b.paint, k.invert) : sculptEdit(k.tool, [x, z], b, k.invert, k.level, cell);
    k.dabs.push(dab);
    this.previewEdits([dab]);
  }

  private async finishSculpt(dabs: BlockEdit[]): Promise<void> {
    const layer = this.layer;
    if (layer === null || dabs.length === 0) return;
    const previewMs = this.previewMs;
    const t0 = performance.now();
    const ok = await this.cb.onCommit(layer.entityId, dabs);
    this.lastStroke = { tool: this.opts.tool, cells: dabs.length, previewMs: Math.round(previewMs * 100) / 100, commitMs: Math.round((performance.now() - t0) * 100) / 100 };
    this.host.canvas.setAttribute('data-block-stroke', JSON.stringify(this.lastStroke));
    if (!ok) this.restorePreview();
    else {
      this.previewChunks.clear();
      this.scratch = null;
    }
  }

  // ---- internals: targets ------------------------------------------------------------

  private ray(clientX: number, clientY: number): THREE.Ray {
    const rect = this.host.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.host.camera);
    return this.raycaster.ray;
  }

  /**
   * The cell a pointer position aims at. Adding tools take the empty cell in
   * front of the block face under the pointer; the others the block itself;
   * with no block in front of the slice plane, the plane's cell. During a
   * rectangle stroke the target stays on the press cell's row.
   */
  private resolveTarget(clientX: number, clientY: number, s: Stroke | null): { cell: Cell3; value: BlockCell | null } | null {
    const layer = this.layer;
    const g = this.grid;
    if (layer === null || g === null) return null;
    const ray = this.ray(clientX, clientY);
    const o = { x: layer.origin[0] ?? 0, y: layer.origin[1] ?? 0, z: layer.origin[2] ?? 0 };
    const cs = layer.component.cellSize;
    const b = layer.component.bounds;
    const clamp = (c: Cell3): Cell3 => [Math.min(b.max[0] - 1, Math.max(b.min[0], c[0])), Math.min(b.max[1] - 1, Math.max(b.min[1], c[1])), Math.min(b.max[2] - 1, Math.max(b.min[2], c[2]))];
    const onRow = (row: number, mid: boolean): Cell3 | null => {
      const planeY = o.y + (row + (mid ? 0.5 : 0)) * cs[1];
      const p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY), new THREE.Vector3());
      if (p === null) return null;
      return clamp([Math.floor((p.x - o.x) / cs[0]), row, Math.floor((p.z - o.z) / cs[2])]);
    };
    if (s !== null && toolRect(s.tool, this.opts.meta?.shape)) {
      const c = onRow(s.start[1], true);
      return c === null ? null : { cell: c, value: g.get(c[0], c[1], c[2]) };
    }
    const tool = s?.tool ?? this.opts.tool;
    const solid = (x: number, y: number, z: number): boolean => {
      const v = g.get(x, y, z);
      return v !== null && (v.block !== undefined || g.metadataOnly);
    };
    const hit = pickCell(g, o, ray.origin, ray.direction, 10_000, solid);
    const planeCell = onRow(this.slice, false);
    const planeDist = planeCell === null ? Infinity : (ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(o.y + this.slice * cs[1])), new THREE.Vector3())?.distanceTo(ray.origin) ?? Infinity);
    if (hit !== null && hit.distance <= planeDist + 1e-6) {
      let c: Cell3 = [...hit.cell];
      if (toolAdds(tool)) {
        const n = hit.normal;
        c = [c[0] + n[0], c[1] + n[1], c[2] + n[2]];
        if (c[0] < b.min[0] || c[0] >= b.max[0] || c[1] < b.min[1] || c[1] >= b.max[1] || c[2] < b.min[2] || c[2] >= b.max[2]) return null;
      }
      return { cell: c, value: g.get(c[0], c[1], c[2]) };
    }
    if (planeCell === null) return null;
    return { cell: planeCell, value: g.get(planeCell[0], planeCell[1], planeCell[2]) };
  }

  // ---- internals: strokes ------------------------------------------------------------

  private context(): StrokeContext {
    const b = this.opts.brush;
    return {
      brush: b,
      type: b.block !== null ? this.types.get(b.block) : undefined,
      bounds: this.layer!.component.bounds,
      target: this.target?.value ?? null,
      invert: this.strokeInvert,
      ...(this.opts.meta !== null ? { meta: this.opts.meta } : {}),
      ...(this.opts.region !== null ? { region: this.opts.region } : {}),
      ...(this.opts.stamp !== null ? { stamp: this.opts.stamp } : {}),
      ...(this.opts.paste !== null ? { paste: this.opts.paste } : {}),
    };
  }

  /** Apply a freehand stroke's new cells to the layer copy and re-mesh the touched chunks (the local preview). */
  private previewFreehand(cells: readonly Cell3[]): void {
    const layer = this.layer;
    const s = this.stroke;
    if (layer === null || s === null || layer.component.metadataOnly === true) return;
    if (s.tool === 'meta') return; // metadata changes no geometry: the overlay shows it after the commit
    const part: Stroke = { ...s, cells: [...cells] };
    const edits = strokeEdits(part, this.context());
    if (edits === null) return;
    this.previewEdits(edits);
  }

  /** Apply edits to the layer copy and re-mesh the chunks they touched (a stroke's local preview). */
  private previewEdits(edits: readonly BlockEdit[]): void {
    const layer = this.layer;
    if (layer === null || layer.component.metadataOnly === true) return;
    const t0 = performance.now();
    if (this.scratch === null) this.scratch = BlockGrid.from(layer.component, { entityId: layer.entityId, chunks: [...layer.chunks.values()] });
    const res = applyBlockEdits(this.scratch, edits, { types: this.types, stamps: this.stamps });
    if (!res.ok) return;
    const dirty = this.scratch.takeDirty().chunks;
    const view = this.host.view();
    view.replaceChunks(
      layer.entityId,
      dirty.map((k) => {
        this.previewChunks.add(k);
        const [cx, cz] = k.split(',').map(Number) as [number, number];
        return { cx, cz, chunk: this.scratch!.encodeChunk(k) };
      }),
    );
    view.update();
    this.previewMs = Math.max(this.previewMs, performance.now() - t0);
    this.host.requestRender();
  }

  /** Put the previewed chunks back as the layer stores them (a cancelled or refused stroke). */
  private restorePreview(): void {
    const layer = this.layer;
    if (layer === null || this.previewChunks.size === 0) return;
    this.host.view().replaceChunks(
      layer.entityId,
      [...this.previewChunks].map((k) => {
        const [cx, cz] = k.split(',').map(Number) as [number, number];
        return { cx, cz, chunk: layer.chunks.get(k) ?? null };
      }),
    );
    this.previewChunks.clear();
    this.scratch = null;
    this.host.requestRender();
  }

  private async finishStroke(s: Stroke): Promise<void> {
    const layer = this.layer;
    this.drawStroke();
    if (layer === null) return;
    if (s.tool === 'eyedropper') {
      const c = this.target?.value ?? null;
      this.cb.onPick(c);
      return;
    }
    if (s.tool === 'select') {
      const box = clipBox(boxBetween(s.start, s.end), layer.component.bounds);
      this.setSelection(box);
      this.cb.onSelect(box);
      return;
    }
    const edits = strokeEdits(s, this.context());
    if (edits === null) {
      this.restorePreview();
      if ((s.tool === 'single' || s.tool === 'line' || s.tool === 'rect' || s.tool === 'box') && this.opts.brush.block === null) this.cb.onRefused('Choose a block in the palette first.');
      else if (s.tool === 'meta' && this.opts.meta === null) this.cb.onRefused('Choose a metadata field and value first.');
      else if (s.tool === 'region' && this.opts.region === null) this.cb.onRefused('Choose or create a region first.');
      return;
    }
    const cells = s.cells.length;
    const previewMs = this.previewMs;
    const t0 = performance.now();
    const ok = await this.cb.onCommit(layer.entityId, edits);
    this.lastStroke = { tool: s.tool, cells, previewMs: Math.round(previewMs * 100) / 100, commitMs: Math.round((performance.now() - t0) * 100) / 100 };
    this.host.canvas.setAttribute('data-block-stroke', JSON.stringify(this.lastStroke));
    if (!ok) this.restorePreview();
    else {
      // The stored chunks arrive with the change (identical cells: nothing re-meshes).
      this.previewChunks.clear();
      this.scratch = null;
    }
  }

  // ---- internals: drawing ------------------------------------------------------------

  private syncVisibility(): void {
    // A hidden layer shows none of its editing helpers either.
    const on = this.active && this.layer !== null && !this.layer.hidden;
    this.root.visible = on;
    this.host.requestRender();
  }

  /** Scale and place a unit box (a group child) over a cell box in layer space. */
  private placeBox(obj: THREE.Object3D, box: readonly number[] | null): void {
    const cs = this.layer?.component.cellSize ?? [1, 1, 1];
    if (box === null) {
      obj.visible = false;
      return;
    }
    const pad = 0.02;
    obj.position.set(box[0]! * cs[0] - pad, box[1]! * cs[1] - pad, box[2]! * cs[2] - pad);
    obj.scale.set((box[3]! - box[0]!) * cs[0] + 2 * pad, (box[4]! - box[1]!) * cs[1] + 2 * pad, (box[5]! - box[2]!) * cs[2] + 2 * pad);
    obj.visible = true;
    obj.updateMatrixWorld(true);
  }

  private drawHover(cell: Cell3 | null): void {
    const tool = this.opts.tool;
    (this.hover.material as THREE.LineBasicMaterial).color.setHex(toolAdds(tool) ? HOVER_ADD : tool === 'erase' ? HOVER_ERASE : HOVER_HIT);
    if (cell === null) this.placeBox(this.hover, null);
    else if (tool === 'stamp' && this.opts.stamp !== null) {
      const st = this.stamps.get(this.opts.stamp.stampId);
      const [w, h, d] = st?.size ?? [1, 1, 1];
      const turned = this.opts.stamp.rot === 90 || this.opts.stamp.rot === 270;
      this.placeBox(this.hover, [cell[0], cell[1], cell[2], cell[0] + (turned ? d : w), cell[1] + h, cell[2] + (turned ? w : d)]);
    } else if (tool === 'paste' && this.opts.pasteSize !== null) {
      const [w, h, d] = this.opts.pasteSize;
      this.placeBox(this.hover, [cell[0], cell[1], cell[2], cell[0] + w, cell[1] + h, cell[2] + d]);
    } else this.placeBox(this.hover, [cell[0], cell[1], cell[2], cell[0] + 1, cell[1] + 1, cell[2] + 1]);
    this.host.requestRender();
  }

  private drawStroke(): void {
    const s = this.stroke;
    this.placeBox(this.ghost, null);
    this.placeBox(this.ghostEdges, null);
    if (this.lineGhost !== null) this.lineGhost.visible = false;
    if (s === null || this.layer === null) {
      this.host.requestRender();
      return;
    }
    const bounds = this.layer.component.bounds;
    if (toolRect(s.tool, this.opts.meta?.shape)) {
      const box = s.tool === 'select' ? boxBetween(s.start, s.end) : rectBetween(s.start, s.end, s.tool === 'box' ? this.opts.brush.height : 1);
      const clipped = clipBox(box, bounds);
      this.placeBox(this.ghost, clipped);
      this.placeBox(this.ghostEdges, clipped);
      (this.ghost.material as THREE.MeshBasicMaterial).color.setHex(s.tool === 'select' ? SELECTION : s.tool === 'region' ? REGION : GHOST);
    } else if (s.tool === 'line') {
      const cells = lineCells(s.start, s.end);
      this.drawLineGhost(cells);
    } else this.drawHover(s.end);
    this.host.requestRender();
  }

  private drawLineGhost(cells: readonly Cell3[]): void {
    const cs = this.layer!.component.cellSize;
    if (this.lineGhost === null || this.lineGhost.instanceMatrix.count < cells.length) {
      if (this.lineGhost !== null) {
        this.lineGhost.removeFromParent();
        this.lineGhost.dispose();
      }
      const geo = new THREE.BoxGeometry(1, 1, 1);
      geo.translate(0.5, 0.5, 0.5);
      this.lineGhost = new THREE.InstancedMesh(geo, this.ghost.material as THREE.Material, Math.max(64, cells.length * 2));
      this.lineGhost.renderOrder = 18;
      this.root.add(this.lineGhost);
    }
    const m = new THREE.Matrix4();
    cells.forEach((c, i) => {
      m.makeScale(cs[0], cs[1], cs[2]).setPosition(c[0] * cs[0], c[1] * cs[1], c[2] * cs[2]);
      this.lineGhost!.setMatrixAt(i, m);
    });
    this.lineGhost.count = cells.length;
    this.lineGhost.instanceMatrix.needsUpdate = true;
    this.lineGhost.visible = true;
  }

  /** The grid of the slice row over the layer's bounds, and the slice plane. */
  private rebuildGrid(): void {
    if (this.gridLines !== null) {
      this.gridLines.removeFromParent();
      disposeTree(this.gridLines);
      this.gridLines = null;
    }
    if (this.slicePlane !== null) {
      this.slicePlane.removeFromParent();
      disposeTree(this.slicePlane);
      this.slicePlane = null;
    }
    const layer = this.layer;
    if (layer === null) return;
    const cs = layer.component.cellSize;
    const b = layer.component.bounds;
    const y = this.slice * cs[1] + 0.002;
    const x0 = b.min[0] * cs[0];
    const x1 = b.max[0] * cs[0];
    const z0 = b.min[2] * cs[2];
    const z1 = b.max[2] * cs[2];
    const pts: number[] = [];
    for (let x = b.min[0]; x <= b.max[0]; x++) pts.push(x * cs[0], y, z0, x * cs[0], y, z1);
    for (let z = b.min[2]; z <= b.max[2]; z++) pts.push(x0, y, z * cs[2], x1, y, z * cs[2]);
    // The bounds' vertical edges show the layer's height.
    const yb0 = b.min[1] * cs[1];
    const yb1 = b.max[1] * cs[1];
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) pts.push(x, yb0, z, x, yb1, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gridLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5c6b8a, transparent: true, opacity: 0.55, depthWrite: false }));
    this.gridLines.renderOrder = 10;
    this.gridLines.name = 'block-grid';
    this.root.add(this.gridLines);
    const plane = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    plane.rotateX(-Math.PI / 2);
    plane.translate((x0 + x1) / 2, y - 0.001, (z0 + z1) / 2);
    this.slicePlane = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: 0x3a86ff, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide }));
    this.slicePlane.renderOrder = 9;
    this.root.add(this.slicePlane);
    this.host.canvas.setAttribute('data-block-slice', String(this.slice));
  }

  private rebuildRegions(): void {
    if (this.regionLines !== null) {
      this.regionLines.removeFromParent();
      disposeTree(this.regionLines);
      this.regionLines = null;
    }
    const layer = this.layer;
    if (layer === null || !(this.showRegions || this.opts.tool === 'region')) return;
    const cs = layer.component.cellSize;
    const pts: number[] = [];
    const colors: number[] = [];
    const active = new THREE.Color(REGION);
    const other = new THREE.Color(0x2a6f86);
    for (const r of layer.regions) {
      const c = r.regionId === this.opts.region ? active : other;
      for (const bx of r.boxes) {
        const [x0, y0, z0, x1, y1, z1] = [bx[0]! * cs[0], bx[1]! * cs[1], bx[2]! * cs[2], bx[3]! * cs[0], bx[4]! * cs[1], bx[5]! * cs[2]];
        const e: number[][] = [
          [x0, y0, z0, x1, y0, z0], [x1, y0, z0, x1, y0, z1], [x1, y0, z1, x0, y0, z1], [x0, y0, z1, x0, y0, z0],
          [x0, y1, z0, x1, y1, z0], [x1, y1, z0, x1, y1, z1], [x1, y1, z1, x0, y1, z1], [x0, y1, z1, x0, y1, z0],
          [x0, y0, z0, x0, y1, z0], [x1, y0, z0, x1, y1, z0], [x1, y0, z1, x1, y1, z1], [x0, y0, z1, x0, y1, z1],
        ];
        for (const s of e) {
          pts.push(...s);
          colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      }
    }
    if (pts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.regionLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.regionLines.renderOrder = 19;
    this.root.add(this.regionLines);
  }

  /**
   * The metadata overlay: for each shown field, a coloured plate on the top
   * face of every cell whose value the field colours (schema colour, an
   * enum's generated palette, a numeric shade).
   */
  private refreshOverlay(): void {
    const layer = this.layer;
    const g = this.grid;
    const key = layer === null || g === null ? '' : `${this.layerKey}|${[...this.shownFields].sort().join(',')}`;
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    if (this.overlay !== null) {
      this.overlay.removeFromParent();
      disposeTree(this.overlay);
      this.overlay = null;
    }
    if (layer === null || g === null || this.shownFields.size === 0) {
      this.host.canvas.setAttribute('data-block-overlay', '0');
      return;
    }
    const cs = layer.component.cellSize;
    const group = new THREE.Group();
    group.name = 'block-overlay';
    const shown = this.fields.filter((f) => this.shownFields.has(f.key));
    const cells: { x: number; y: number; z: number; meta: Record<string, import('@thirdlight/project-model').CellMetaValue> }[] = [];
    g.forEach((x, y, z, idx) => cells.push({ x, y, z, meta: effectiveCellMeta(g.valueOf(idx), this.types, this.fields) }));
    const plate = new THREE.PlaneGeometry(cs[0] * 0.86, cs[2] * 0.86);
    plate.rotateX(-Math.PI / 2);
    let total = 0;
    shown.forEach((f, fi) => {
      const hits = cells.map((c) => ({ c, color: overlayColor(f, c.meta[f.key]) })).filter((h) => h.color !== null);
      if (hits.length === 0) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 - fi, polygonOffsetUnits: -2 - fi, side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(plate.clone(), mat, hits.length);
      const m = new THREE.Matrix4();
      const col = new THREE.Color();
      hits.forEach((h, i) => {
        m.makeTranslation((h.c.x + 0.5) * cs[0], (h.c.y + 1) * cs[1] + 0.01 + 0.004 * fi, (h.c.z + 0.5) * cs[2]);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.set(h.color!));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      mesh.renderOrder = 15 + fi;
      mesh.name = `block-overlay:${f.key}`;
      mesh.frustumCulled = false;
      group.add(mesh);
      total += hits.length;
    });
    plate.dispose();
    this.overlay = group;
    this.root.add(group);
    this.host.canvas.setAttribute('data-block-overlay', String(total));
  }

  dispose(): void {
    this.root.removeFromParent();
    disposeTree(this.root);
  }
}
