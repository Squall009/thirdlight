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
 * The round brushes (height, smooth, flatten, paint, scatter) aim at the
 * ground itself (the layer's drawn surface under the pointer) and drop dabs
 * along the drag — each previewed on the layer copy as it lands, all of them
 * sent as one `editBlocks` on release. Their settings are the shared brush's
 * (`session/brush.ts`: size across in metres, strength, opacity, falloff,
 * spacing, invert, the noise mask), turned into cells by `blockDab`; the
 * keys and in-view drags are the shared ones (`brush-control.ts`) and the
 * cursor is the one every brush draws. A paint stroke's dabs share one
 * coverage per surface, so its preview holds the opacity as the command
 * holding all of them does.
 *
 * The slice is drawn as a plane with its outline in the state colour; while
 * a shape tool is dragged a readout by the pointer says its size.
 *
 * With an edge piece as the brush block (a wall, door, fence) the drawing
 * tools work on cell edges: the target is the edge of the target cell's row
 * nearest the pointer (`data-block-edge`), paint and erase collect the edges
 * the drag passes, line and rectangle run along the grid lines between two
 * corners, box repeats the rectangle's outline up to the box height; each
 * stroke is one `edges` edit, previewed the same way.
 *
 * With no tool armed (Navigate) the tools take no press: a left drag orbits,
 * and a click selects — in Rooms & buildings the room, building or path
 * under the pointer (the Rooms tool's outline pick), elsewhere the block
 * under the pointer (its cell and its block type). What a click would select
 * is outlined under the pointer.
 *
 * Browser-only (three.js); the maths is `session/block-brush.ts`.
 */
import * as THREE from 'three';
import { BLOCK_EDGE_THICKNESS, BLOCK_EDIT_MAX_EDITS, BlockGrid, UNPAINTED_WALL, applyBlockEdits, cellOfKey, edgeInBox, effectiveCellMeta, pickCell } from '@thirdlight/runtime';
import type { BlockCell, BlockChunk, BlockEdge, BlockEdit, BlockLayerComponent, BlockRegion, BlockStamp, BlockType, CellField } from '@thirdlight/project-model';
import type { BlockLayerView } from '@thirdlight/three-adapter';
import type { StrokeCoverage } from '@thirdlight/project-model';
import {
  DEFAULT_BRUSH,
  beginStroke,
  boxBetween,
  brushCell,
  brushEdge,
  edgeGhostBox,
  edgeLine,
  edgeRect,
  edgeTool,
  edgesEdit,
  nearestCorner,
  nearestEdge,
  clipBox,
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
  scatterEdit,
  type BlockToolId,
  type BrushState,
  type Cell3,
  type CellBox,
  type Edge4,
  type PasteSource,
  type Stroke,
  type StrokeContext,
} from '../session/block-brush';
import { overlayColor } from '../session/block-overlay';
import { BLOCK_DEFAULT_BRUSH, blockDab, blockDabStep, blockToolUses, isBlockBrushTool, type BlockBrushTool } from '../session/block-mode';
import { brushStrokeExtras, strokeMask, type BrushSettings, type BrushStore } from '../session/brush';
import { RoomTool, type RoomToolCallbacks } from './room-tool';
import { BrushControl } from './brush-control';
import { BrushCursor, BrushHud, tokenColour } from './brush-cursor';

/** What the block editor's column sets (the tool, the brush and its options). */
export interface BlockToolOptions {
  tool: BlockToolId;
  brush: BrushState;
  /** A round brush's shared settings (the column shows them; keys and in-view drags change them); null: not a round brush. */
  store: BrushStore | null;
  /** Lower columns / remove from a region (Ctrl held inverts it for one stroke). The round brushes read their store's invert. */
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
  /** Navigate: a click on a block (its cell and what it holds; null: on no block). */
  onPickCell(at: Cell3 | null, cell: BlockCell | null): void;
  /** Something cannot be done (a locked or hidden layer, no block chosen). */
  onRefused(message: string): void;
}

export interface BlockEditorHost {
  /** Where the tools add their previews (the Scene view's overlay group). */
  readonly scene: THREE.Object3D;
  readonly camera: THREE.Camera;
  readonly canvas: HTMLCanvasElement;
  /** A pointer that moved less than this (px) between press and release is a click (the view's). */
  readonly slopPx: number;
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

/** A point of the layer's drawn surface under the pointer: columns x, z and rows up, and the face's normal there (null: the slice plane). */
interface SurfacePoint {
  x: number;
  z: number;
  rows: number;
  normal: THREE.Vector3 | null;
}

const HOVER_ADD = 0x6ee7a0;
const HOVER_HIT = 0xffc857;
const HOVER_ERASE = 0xff6b6b;
/** Navigate's hover: white, as what a click would select (no tool's colour). */
const HOVER_NAVIGATE = 0xffffff;
const SELECTION = 0xffe066;
const REGION = 0x4cc9f0;
const GHOST = 0x9ad7ff;
/** The slice plane's opacity: enough to see which row the tools work on, little enough to see the blocks through it. */
const SLICE_FILL = 0.07;

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
  /** No tool armed: a drag orbits, a click selects. */
  private navigate = false;
  /** Navigate's press (a release near it is a click). */
  private navPress: { x: number; y: number } | null = null;
  private layer: BlockEditLayer | null = null;
  private layerKey = '';
  /** The layer's stored cells (picking, targets, the overlay). */
  private grid: BlockGrid | null = null;
  private types = new Map<string, BlockType>();
  private fields: readonly CellField[] = [];
  private stamps = new Map<string, BlockStamp>();
  private opts: BlockToolOptions = { tool: 'single', brush: DEFAULT_BRUSH, store: null, invert: false, meta: null, region: null, stamp: null, paste: null, pasteSize: null };
  private slice = 0;
  private shownFields = new Set<string>();
  private showRegions = false;
  private selection: CellBox | null = null;
  // Scene objects.
  private gridLines: THREE.LineSegments | null = null;
  private slicePlane: THREE.Mesh | null = null;
  private sliceOutline: THREE.LineSegments | null = null;
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
  /**
   * A round brush's stroke: its dabs (sent on release), the last dab's centre (columns), the flatten height (rows),
   * the settings it began with (a key mid-stroke changes the next one) and its paint coverages (one per surface).
   */
  private sculpt: { tool: BlockBrushTool; dabs: BlockEdit[]; last: [number, number, number]; level: number; invert: boolean; settings: BrushSettings; coverages: Map<string, StrokeCoverage | null> } | null = null;
  /** The round brushes' cursor (the one every brush shares). */
  private readonly cursor: BrushCursor;
  /** The brush keys, F / Shift+F drags and Ctrl (shared with every Scene-view brush). */
  private readonly control: BrushControl;
  private unstore: (() => void) | null = null;
  /** The surface under the pointer the cursor was last laid on (cells), redrawn when the brush changes. */
  private lastAt: SurfacePoint | null = null;
  /** The readout of a shape being dragged (its size, what it places). */
  private readonly readout: BrushHud;
  private pointer: { x: number; y: number } | null = null;
  /** An edge stroke in flight: its row, its press and current corner (line, rectangle), the edges it collected (paint, erase) and the last point (cells). */
  private edgeStroke: { tool: BlockToolId; row: number; start: [number, number]; end: [number, number]; edges: Edge4[]; seen: Set<string>; last: [number, number] } | null = null;
  /** Measured stroke timings (tests read them from the canvas). */
  private lastStroke: { tool: BlockToolId; cells: number; previewMs: number; commitMs: number | null } | null = null;
  /** What the Rooms tool reports to (Rooms & buildings' column sets it). */
  readonly roomHandlers: { current: Omit<RoomToolCallbacks, 'onRefused'> | null } = { current: null };
  /** The Rooms tool: rooms and paths of generated architecture drawn on the layer. */
  readonly rooms: RoomTool;
  /** The cell edges the walls of rooms drawn on the layer stand on (wall paint reaches their faces). */
  private roomWalls: ReadonlyMap<number, boolean> | null = null;

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
    this.root.add(this.hover, this.ghost, this.ghostEdges, this.selectionBox);
    // The round brushes' footprint, laid on the tops under the pointer.
    this.cursor = new BrushCursor(this.root, 'block-brush-cursor');
    this.control = new BrushControl({
      canvas: host.canvas,
      surfaceAt: (x, y) => this.metresOf(this.surfaceUnder(x, y)),
      distance: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
      ctrlChanged: () => this.drawRing(this.lastAt),
    });
    this.readout = new BrushHud(host.canvas, 'ghost');
    host.scene.add(this.root);
    const rh = this.roomHandlers;
    this.rooms = new RoomTool(
      {
        root: this.root,
        canvas: host.canvas,
        layer: () => this.layer,
        slice: () => this.slice,
        ray: (x, y) => this.ray(x, y),
        slopPx: host.slopPx,
        requestRender: () => host.requestRender(),
      },
      {
        onRooms: (layerId, next, what) => rh.current?.onRooms(layerId, next, what) ?? Promise.resolve(false),
        onPreview: (id, next) => rh.current?.onPreview(id, next),
        onPickRoom: (id) => rh.current?.onPickRoom(id),
        onRefused: (m) => this.cb.onRefused(m),
      },
    );
  }

  // ---- state ------------------------------------------------------------------------

  /** Arm or disarm the block tools (disarmed: nothing drawn, no pointer handling). */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) this.cancel();
    this.control.arm(on && !this.navigate);
    if (!on) {
      this.cursor.hide();
      this.readout.hide();
      this.rooms.hoverAt(null);
    }
    this.syncVisibility();
    this.publishTool();
    this.host.armed?.(on);
  }

  isActive(): boolean {
    return this.active;
  }

  /** Navigate (no tool armed: a drag orbits, a click selects) or the tool in hand. */
  setNavigate(on: boolean): void {
    if (this.navigate === on) return;
    if (on) this.cancel();
    this.navigate = on;
    this.navPress = null;
    this.control.arm(this.active && !on);
    this.cursor.hide();
    this.readout.hide();
    this.placeBox(this.hover, null);
    this.rooms.hoverAt(null);
    this.publishTool();
    this.host.requestRender();
  }

  /** The tool in hand as tests read it ('navigate' with none; '' when the tools are off). */
  private publishTool(): void {
    this.host.canvas.setAttribute('data-block-tool', !this.active ? '' : this.navigate ? 'navigate' : this.opts.tool);
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

  /** The walls of the rooms drawn on the edited layer (`architectureWallEdges`; null: none). */
  setRoomWalls(walls: ReadonlyMap<number, boolean> | null): void {
    this.roomWalls = walls !== null && walls.size > 0 ? walls : null;
  }

  setOptions(o: BlockToolOptions): void {
    if (o.tool !== 'room' && this.opts.tool === 'room') this.rooms.cancel();
    if (o.tool === 'room') this.placeBox(this.hover, null);
    if (o.store !== this.opts.store) {
      this.unstore?.();
      // A key, a drag or the column changed the brush: the cursor follows at once.
      this.unstore = o.store?.subscribe(() => this.drawRing(this.lastAt)) ?? null;
    }
    this.control.setStore(o.store, blockToolUses(o.tool));
    this.opts = o;
    // The terrain brushes show their round footprint instead of a cell.
    if (toolDabs(o.tool)) this.placeBox(this.hover, null);
    else this.cursor.hide();
    this.publishTool();
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

  /**
   * Preview a cut-away zone of a layer in the Scene view: hidden (it fades out
   * as in the game) or back to what the subject decides (the editor has none:
   * shown). False when the layer has no such zone (yet: its component is
   * stored first).
   */
  previewCutaway(entityId: string, zone: string, on: boolean): boolean {
    const ok = this.host.view().setCutaway(entityId, zone, on ? true : null);
    this.host.requestRender();
    return ok;
  }

  setSelection(box: CellBox | null): void {
    this.selection = box;
    this.placeBox(this.selectionBox, box);
    this.host.canvas.setAttribute('data-block-selection', box === null ? '' : box.join(','));
    this.host.requestRender();
  }

  /** The selected cells' box in world metres (null: none), which Home frames. */
  selectionWorldBox(): { min: number[]; max: number[] } | null {
    const l = this.layer;
    const b = this.selection;
    if (l === null || b === null) return null;
    const cs = l.component.cellSize;
    return { min: [0, 1, 2].map((i) => (l.origin[i] ?? 0) + b[i]! * cs[i]!), max: [0, 1, 2].map((i) => (l.origin[i] ?? 0) + b[i + 3]! * cs[i]!) };
  }

  /** A stored cell of the selected layer (null: empty). */
  cellAt(x: number, y: number, z: number): BlockCell | null {
    return this.grid?.get(x, y, z) ?? null;
  }

  /** The selected layer's edge pieces on and inside a box, as rows relative to its min corner (null: none). */
  edgesIn(box: readonly number[]): { edgePalette: BlockEdge[]; edges: number[][] } | null {
    const g = this.grid;
    if (g === null || g.edgeCount === 0) return null;
    const edgePalette: BlockEdge[] = [];
    const edges: number[][] = [];
    const at = new Map<number, number>();
    g.forEachEdge((x, y, z, axis, idx) => {
      if (!edgeInBox(box, x, y, z, axis)) return;
      let p = at.get(idx);
      if (p === undefined) {
        p = edgePalette.length;
        at.set(idx, p);
        edgePalette.push({ ...g.edgeValueOf(idx) });
      }
      edges.push([x - box[0]!, z - box[2]!, y - box[1]!, axis, p]);
    });
    return edges.length > 0 ? { edgePalette, edges } : null;
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
    // Navigate: the press is the orbit's; its release may be a click that selects.
    if (this.navigate) {
      this.navPress = { x: e.clientX, y: e.clientY };
      return false;
    }
    // F / Shift+F: a click sets what was dragged.
    if (this.control.press()) return true;
    const layer = this.layer;
    if (layer === null) {
      this.cb.onRefused('Open a block layer in the block editor first.');
      return true;
    }
    if (layer.locked && this.opts.tool !== 'eyedropper' && this.opts.tool !== 'select') {
      this.cb.onRefused('The layer is locked (unlock it in the block editor or the Hierarchy).');
      return true;
    }
    if (layer.hidden) {
      this.cb.onRefused('The layer is hidden (show it to edit it).');
      return true;
    }
    if (this.opts.tool === 'room') return this.rooms.pointerDown(e);
    const tool = this.opts.tool;
    if (isBlockBrushTool(tool)) {
      const at = this.surfaceUnder(e.clientX, e.clientY);
      if (at === null) return true;
      this.strokeInvert = this.control.inverted();
      this.previewMs = 0;
      this.previewChunks.clear();
      this.scratch = null;
      if (tool === 'scatter' && this.opts.brush.scatterRule === '') {
        this.cb.onRefused('Pick a scatter rule to paint with (make one in Rules → Scatter).');
        return true;
      }
      if (tool === 'paint' && this.opts.brush.paintTarget !== 'tops' && this.layer?.component.wallPaint !== true) {
        this.cb.onRefused("This layer's walls show the paint of the tops above them: turn on \"Walls have their own paint\" (Paint) to paint walls.");
        return true;
      }
      this.sculpt = { tool, dabs: [], last: [at.x, at.z, at.rows], level: at.rows, invert: this.strokeInvert, settings: this.settings(), coverages: new Map() };
      this.addDab(at.x, at.z, at.rows);
      this.drawRing(at);
      return true;
    }
    if (this.edgeMode()) {
      const at = this.edgeTarget(e.clientX, e.clientY, null);
      if (at === null) return true;
      this.previewMs = 0;
      this.previewChunks.clear();
      this.scratch = null;
      const corner = nearestCorner(at.fx, at.fz);
      this.edgeStroke = { tool: this.opts.tool, row: at.row, start: corner, end: corner, edges: [], seen: new Set(), last: [at.fx, at.fz] };
      this.addEdges([at.edge]);
      this.drawEdgeStroke();
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
    this.pointer = { x: e.clientX, y: e.clientY };
    if (this.navigate) {
      // Nothing is outlined while a drag orbits.
      if (e.buttons === 0) this.navigateHover(e.clientX, e.clientY);
      return false;
    }
    if (this.opts.tool === 'room') return this.rooms.pointerMove(e);
    if (toolDabs(this.opts.tool) || this.sculpt !== null) {
      const at = this.surfaceUnder(e.clientX, e.clientY);
      if (this.control.move(e, this.metresOf(at))) return true;
      this.drawRing(at);
      const k = this.sculpt;
      if (k === null || at === null) return k !== null;
      // Dabs at the brush's spacing along the drag (a fast drag leaves no gaps).
      const cs = this.layer?.component.cellSize ?? [1, 1, 1];
      const step = blockDabStep(k.settings, cs);
      const dx = at.x - k.last[0];
      const dz = at.z - k.last[1];
      // Up a wall the drag moves in height (rows, in cell widths for the spacing).
      const dy = at.rows - k.last[2];
      const dyCells = k.tool === 'paint' && this.opts.brush.paintTarget !== 'tops' ? (dy * cs[1]!) / cs[0]! : 0;
      const n = Math.floor(Math.hypot(dx, dz, dyCells) / step);
      for (let i = 1; i <= n; i++) this.addDab(k.last[0] + (dx * i) / n, k.last[1] + (dz * i) / n, k.last[2] + (dy * i) / n);
      if (n > 0) k.last = [at.x, at.z, at.rows];
      return true;
    }
    if (this.edgeStroke !== null || this.edgeMode()) {
      const k = this.edgeStroke;
      const at = this.edgeTarget(e.clientX, e.clientY, k?.row ?? null);
      this.host.canvas.setAttribute('data-block-edge', at === null ? '' : at.edge.join(','));
      if (k === null) {
        this.drawEdgeHover(at?.edge ?? null);
        return false;
      }
      if (at === null) return true;
      if (k.tool === 'single' || k.tool === 'erase') {
        // Every edge the drag passed, sampled every quarter cell (a fast drag leaves no gaps).
        const dx = at.fx - k.last[0];
        const dz = at.fz - k.last[1];
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) * 4));
        const crossed: Edge4[] = [];
        for (let i = 1; i <= n; i++) crossed.push(nearestEdge(k.last[0] + (dx * i) / n, k.last[1] + (dz * i) / n, k.row));
        k.last = [at.fx, at.fz];
        this.addEdges(crossed);
      } else k.end = nearestCorner(at.fx, at.fz);
      this.drawEdgeStroke();
      return true;
    }
    const s = this.stroke;
    if (s === null) {
      this.readout.hide();
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
    this.showReadout(s);
    return true;
  }

  pointerUp(e: PointerEvent): boolean {
    if (this.opts.tool === 'room' && this.rooms.pointerUp(e)) return true;
    const es = this.edgeStroke;
    if (es !== null) {
      this.edgeStroke = null;
      void this.finishEdgeStroke(es);
      return true;
    }
    const k = this.sculpt;
    if (k !== null) {
      this.sculpt = null;
      void this.finishSculpt(k.tool, k.dabs);
      return true;
    }
    const s = this.stroke;
    if (s === null) return false;
    this.stroke = null;
    this.readout.hide();
    void e;
    void this.finishStroke(s);
    return true;
  }

  /**
   * Navigate: a release near its press selects what is under the pointer (true: it was such a click); `goIn`, a
   * double-click in Rooms & buildings, selects the room or path inside the building there.
   */
  click(e: MouseEvent, goIn = false): boolean {
    const press = this.navPress;
    this.navPress = null;
    if (!this.active || !this.navigate || e.button !== 0) return false;
    if (goIn) {
      if (this.opts.tool !== 'room') return false;
      this.rooms.pickAt(e.clientX, e.clientY, true);
      return true;
    }
    if (press === null || Math.hypot(e.clientX - press.x, e.clientY - press.y) > this.host.slopPx) return false;
    if (this.opts.tool === 'room') {
      this.rooms.pickAt(e.clientX, e.clientY);
      return true;
    }
    const t = this.blockUnder(e.clientX, e.clientY);
    this.cb.onPickCell(t?.cell ?? null, t?.value ?? null);
    return true;
  }

  /** The block under the pointer (null: none; the empty slice is no block). */
  private blockUnder(clientX: number, clientY: number): { cell: Cell3; value: BlockCell } | null {
    const t = this.resolveTarget(clientX, clientY, null, false);
    return t === null || t.value === null || t.value.block === undefined ? null : { cell: t.cell, value: t.value };
  }

  /** Navigate: outline what a click would select (a room, building or path in Rooms & buildings; else the block). */
  private navigateHover(clientX: number, clientY: number): void {
    if (this.opts.tool === 'room') {
      this.rooms.hoverAt({ x: clientX, y: clientY });
      return;
    }
    const t = this.blockUnder(clientX, clientY);
    this.host.canvas.setAttribute('data-block-hover', t === null ? '' : t.cell.join(','));
    (this.hover.material as THREE.LineBasicMaterial).color.setHex(HOVER_NAVIGATE);
    this.placeBox(this.hover, t === null ? null : [t.cell[0], t.cell[1], t.cell[2], t.cell[0] + 1, t.cell[1] + 1, t.cell[2] + 1]);
    this.cb.onHover(t?.cell ?? null, t?.value ?? null);
    this.host.requestRender();
  }

  /** A brush key (`[` / `]`, F, X, …) or the Rooms tool's (Enter finishes, Backspace takes a corner back) the edit mode routed here; true when taken. */
  key(e: KeyboardEvent): boolean {
    if (!this.active || this.navigate) return false;
    if (this.opts.tool === 'room') return this.rooms.key(e);
    if (!isBlockBrushTool(this.opts.tool)) return false;
    return this.control.key(e);
  }

  /** The pointer left the view: the cursor and its readout go (a stroke in flight keeps going). */
  leave(): void {
    this.pointer = null;
    this.readout.hide();
    this.rooms.hoverAt(null);
    if (this.navigate) this.placeBox(this.hover, null);
    if (this.sculpt !== null || !this.control.leave()) return;
    this.lastAt = null;
    this.cursor.hide();
    this.host.canvas.setAttribute('data-block-brush', '');
    this.host.requestRender();
  }

  /** Esc: drop the stroke in flight (nothing is sent), or put back what F was dragging. */
  cancel(): boolean {
    if (this.control.cancel()) return true;
    this.readout.hide();
    if (this.rooms.cancel()) return true;
    if (this.edgeStroke !== null) {
      this.edgeStroke = null;
      this.restorePreview();
      this.drawEdgeStroke();
      return true;
    }
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
    return this.stroke !== null || this.sculpt !== null || this.edgeStroke !== null || this.rooms.inFlight();
  }

  // ---- internals: edge pieces --------------------------------------------------------

  /** Whether the tool in hand draws edge pieces (its brush block is one). */
  private edgeMode(): boolean {
    const b = this.opts.brush.block;
    return edgeTool(this.opts.tool, b !== null ? this.types.get(b) : undefined);
  }

  /**
   * The edge under the pointer: on the row of the cell an adding tool would
   * fill (the one in front of the block face under it, or the slice), or on
   * `row` during a stroke, the side of the cell under the pointer it is
   * nearest; with the point on that row's floor (cells).
   */
  private edgeTarget(clientX: number, clientY: number, row: number | null): { edge: Edge4; row: number; fx: number; fz: number } | null {
    const layer = this.layer;
    if (layer === null) return null;
    let y = row;
    if (y === null) {
      const t = this.resolveTarget(clientX, clientY, null, true);
      if (t === null) return null;
      y = t.cell[1];
    }
    const ray = this.ray(clientX, clientY);
    const o = { x: layer.origin[0] ?? 0, y: layer.origin[1] ?? 0, z: layer.origin[2] ?? 0 };
    const cs = layer.component.cellSize;
    const p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(o.y + y * cs[1])), new THREE.Vector3());
    if (p === null) return null;
    const fx = (p.x - o.x) / cs[0];
    const fz = (p.z - o.z) / cs[2];
    return { edge: nearestEdge(fx, fz, y), row: y, fx, fz };
  }

  /** Add edges to the paint / erase stroke in flight (each once) and preview them. */
  private addEdges(edges: readonly Edge4[]): void {
    const k = this.edgeStroke;
    if (k === null || (k.tool !== 'single' && k.tool !== 'erase')) return;
    const fresh = edges.filter((e) => {
      const key = e.join(',');
      if (k.seen.has(key)) return false;
      k.seen.add(key);
      return true;
    });
    if (fresh.length === 0) return;
    k.edges.push(...fresh);
    const edits = edgesEdit(fresh, k.tool === 'erase' ? null : this.brushEdgeValue(), this.layer!.component.bounds);
    if (edits !== null) this.previewEdits(edits);
  }

  private brushEdgeValue(): ReturnType<typeof brushEdge> {
    const b = this.opts.brush;
    return brushEdge(b, b.block !== null ? this.types.get(b.block) : undefined);
  }

  /** The edges a stroke covers now. */
  private strokeEdges(k: NonNullable<BlockEditor['edgeStroke']>): Edge4[] {
    if (k.tool === 'line') return edgeLine(k.start, k.end, k.row);
    if (k.tool === 'rect') return edgeRect(k.start, k.end, k.row);
    // A box is the rectangle's outline on every row up to the box height: walls that tall.
    if (k.tool === 'box') {
      const rows: Edge4[] = [];
      for (let r = 0; r < Math.max(1, this.opts.brush.height); r++) rows.push(...edgeRect(k.start, k.end, k.row + r));
      return rows;
    }
    return k.edges;
  }

  private async finishEdgeStroke(k: NonNullable<BlockEditor['edgeStroke']>): Promise<void> {
    const layer = this.layer;
    this.drawEdgeStroke();
    if (layer === null) return;
    const edits = edgesEdit(this.strokeEdges(k), k.tool === 'erase' ? null : this.brushEdgeValue(), layer.component.bounds);
    if (edits === null) {
      this.restorePreview();
      return;
    }
    const previewMs = this.previewMs;
    const t0 = performance.now();
    const ok = await this.cb.onCommit(layer.entityId, edits);
    this.lastStroke = { tool: k.tool, cells: (edits[0] as { at: number[] }).at.length / 4, previewMs: Math.round(previewMs * 100) / 100, commitMs: Math.round((performance.now() - t0) * 100) / 100 };
    this.host.canvas.setAttribute('data-block-stroke', JSON.stringify({ ...this.lastStroke, edges: true }));
    if (!ok) this.restorePreview();
    else {
      this.previewChunks.clear();
      this.scratch = null;
    }
  }

  private drawEdgeHover(edge: Edge4 | null): void {
    (this.hover.material as THREE.LineBasicMaterial).color.setHex(this.opts.tool === 'erase' ? HOVER_ERASE : HOVER_ADD);
    this.placeBox(this.hover, edge === null ? null : edgeGhostBox(edge, Math.max(BLOCK_EDGE_THICKNESS, 0.1)));
    this.host.requestRender();
  }

  /** A line or rectangle stroke's ghost: a thin slab per edge it will set. */
  private drawEdgeStroke(): void {
    const k = this.edgeStroke;
    if (this.lineGhost !== null) this.lineGhost.visible = false;
    if (k === null || this.layer === null) {
      this.host.requestRender();
      return;
    }
    if (k.tool === 'line' || k.tool === 'rect' || k.tool === 'box') this.drawLineGhost(this.strokeEdges(k).map((e) => edgeGhostBox(e, Math.max(BLOCK_EDGE_THICKNESS, 0.1))));
    this.host.requestRender();
  }

  // ---- internals: terrain brushes ---------------------------------------------------

  /**
   * The ground under the pointer: where the ray meets the layer's drawn
   * surface (its chunk meshes, so a sloped top is hit where it is), as layer
   * columns and rows; with nothing drawn under it, the slice plane's top.
   */
  private surfaceUnder(clientX: number, clientY: number): SurfacePoint | null {
    const layer = this.layer;
    if (layer === null) return null;
    const ray = this.ray(clientX, clientY);
    const o = { x: layer.origin[0] ?? 0, y: layer.origin[1] ?? 0, z: layer.origin[2] ?? 0 };
    const cs = layer.component.cellSize;
    const hits = this.raycaster.intersectObjects(this.host.view().layerMeshes(layer.entityId), false);
    let p: THREE.Vector3 | null = hits[0]?.point ?? null;
    let normal: THREE.Vector3 | null = hits[0]?.face !== undefined && hits[0]?.face !== null ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : null;
    // A room's wall in front of the blocks: the paint lands on it (its faces read the layer's wall points there).
    const wall = this.roomWallHit(ray, o, cs);
    if (wall !== null && (p === null || wall.point.distanceTo(ray.origin) < p.distanceTo(ray.origin))) {
      p = wall.point;
      normal = wall.normal;
    }
    if (p === null) {
      p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(o.y + (this.slice + 1) * cs[1])), new THREE.Vector3());
      normal = null;
    }
    if (p === null) return null;
    const x = (p.x - o.x) / cs[0];
    const z = (p.z - o.z) / cs[2];
    const b = layer.component.bounds;
    if (x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) return null;
    return { x, z, rows: (p.y - o.y) / cs[1], normal };
  }

  /** A surface point in the layer's metres (the brush keys' F drag measures on it). */
  private metresOf(at: SurfacePoint | null): THREE.Vector3 | null {
    const cs = this.layer?.component.cellSize;
    return at === null || cs === undefined ? null : new THREE.Vector3(at.x * cs[0], at.rows * cs[1], at.z * cs[2]);
  }

  /** The round brush's settings now (its store's; the defaults before a column gave one). */
  private settings(): BrushSettings {
    return this.opts.store?.get() ?? BLOCK_DEFAULT_BRUSH;
  }

  /** Where the ray first meets a wall of the rooms drawn on the layer (on the cell edge's plane; world), or null. */
  private roomWallHit(ray: THREE.Ray, o: { x: number; y: number; z: number }, cs: readonly number[]): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const walls = this.roomWalls;
    if (walls === null) return null;
    let best = Infinity;
    let bestAxis = 0;
    const d = ray.direction;
    const r0 = [ray.origin.x - o.x, ray.origin.y - o.y, ray.origin.z - o.z];
    for (const [k, blocks] of walls) {
      if (!blocks) continue;
      const axis = k % 2;
      const [x, y, z] = cellOfKey(Math.floor(k / 2));
      // Axis 0: the plane x = X (along z); axis 1: z = Z (along x).
      const plane = axis === 0 ? x * cs[0]! : z * cs[2]!;
      const dn = axis === 0 ? d.x : d.z;
      if (Math.abs(dn) < 1e-9) continue;
      const t = (plane - (axis === 0 ? r0[0]! : r0[2]!)) / dn;
      if (t <= 0 || t >= best) continue;
      const hy = r0[1]! + d.y * t;
      const ha = axis === 0 ? r0[2]! + d.z * t : r0[0]! + d.x * t;
      const lo = axis === 0 ? z * cs[2]! : x * cs[0]!;
      const span = axis === 0 ? cs[2]! : cs[0]!;
      if (hy < y * cs[1]! || hy > (y + 1) * cs[1]! || ha < lo || ha > lo + span) continue;
      best = t;
      bestAxis = axis;
    }
    if (best === Infinity) return null;
    // The face looking back at the ray.
    const n = bestAxis === 0 ? new THREE.Vector3(-Math.sign(d.x) || 1, 0, 0) : new THREE.Vector3(0, 0, -Math.sign(d.z) || 1);
    return { point: ray.at(best, new THREE.Vector3()), normal: n };
  }

  /** The brush's cursor laid where the pointer is (on a wall face when the paint brush paints walls and the pointer is on one). */
  private drawRing(at: SurfacePoint | null): void {
    const layer = this.layer;
    this.lastAt = at;
    this.host.canvas.setAttribute('data-block-brush', at === null ? '' : `${at.x.toFixed(3)},${at.z.toFixed(3)},${at.rows.toFixed(3)}`);
    const tool = this.sculpt?.tool ?? this.opts.tool;
    if (layer === null || at === null || !isBlockBrushTool(tool)) {
      this.cursor.hide();
    } else {
      const cs = layer.component.cellSize;
      const b = this.sculpt?.settings ?? this.settings();
      const uses = blockToolUses(tool);
      const invert = this.sculpt?.invert ?? this.control.inverted();
      this.cursor.setLook({ falloff: uses.includes('falloff') ? b.falloff : 'smooth', hardness: b.hardness, strength: uses.includes('strength') ? Math.min(1, b.strength) : 0, mask: strokeMask(b, uses), state: invert ? 'erase' : 'paint' });
      const r = blockDab(tool, b, cs).radius;
      const onWall = tool === 'paint' && this.opts.brush.paintTarget !== 'tops' && at.normal !== null && Math.abs(at.normal.y) < 0.5;
      this.cursor.place({ centre: new THREE.Vector3(at.x * cs[0], at.rows * cs[1], at.z * cs[2]), rx: r * cs[0], rz: r * cs[2], maskOrigin: [0, 0], fill: this.sculpt === null, ...(onWall ? { normal: at.normal! } : {}) });
      this.host.canvas.setAttribute('data-block-cursor', JSON.stringify({ radius: Math.round(r * cs[0] * 1000) / 1000, state: this.cursor.state(), mask: strokeMask(b, uses) !== null, wall: onWall }));
    }
    this.host.requestRender();
  }

  /** One dab of the round brush in flight: previewed on the layer copy at once, sent with the others on release. */
  private addDab(x: number, z: number, rows: number): void {
    const k = this.sculpt;
    const layer = this.layer;
    if (k === null || layer === null || k.dabs.length >= BLOCK_EDIT_MAX_EDITS) return;
    const b = this.opts.brush;
    const s = k.settings;
    const dab = blockDab(k.tool, s, layer.component.cellSize);
    let edit: BlockEdit;
    if (k.tool === 'paint') {
      // The paint tool paints the surface under the brush (invert: erase), with the stroke's opacity, curve and mask.
      edit = paintEdit([x, z], { radius: dab.radius, strength: dab.strength, falloff: s.falloff, channel: b.paintChannel }, k.invert, b.paintTarget, rows, brushStrokeExtras(s, blockToolUses('paint')));
    } else if (k.tool === 'scatter') {
      edit = scatterEdit([x, z], b.scatterRule, dab.radius, k.invert);
    } else {
      // The brush block grows empty ground (raising where nothing stands yet).
      const cell = brushCell(b, b.block !== null ? this.types.get(b.block) : undefined);
      edit = sculptEdit(k.tool, [x, z], dab, k.invert, k.level, cell);
    }
    k.dabs.push(edit);
    this.previewEdits([edit], k.coverages);
  }

  private async finishSculpt(tool: BlockBrushTool, dabs: BlockEdit[]): Promise<void> {
    const layer = this.layer;
    if (layer === null || dabs.length === 0) return;
    const previewMs = this.previewMs;
    const t0 = performance.now();
    const ok = await this.cb.onCommit(layer.entityId, dabs);
    this.lastStroke = { tool, cells: dabs.length, previewMs: Math.round(previewMs * 100) / 100, commitMs: Math.round((performance.now() - t0) * 100) / 100 };
    this.host.canvas.setAttribute('data-block-stroke', JSON.stringify(this.lastStroke));
    if (!ok) {
      this.restorePreview();
      // A wall point nobody painted already holds the walls' own layer in full: a stroke of that layer there changes
      // nothing (the backend refuses an edit that changes nothing, quietly), which would look like a lost stroke.
      const first = dabs[0];
      if (first?.kind === 'paint' && first.target !== undefined && first.target !== 'tops' && first.erase !== true && UNPAINTED_WALL[first.channel] === 255) {
        this.cb.onRefused(`Unpainted walls already show layer ${first.channel + 1}: painting it there changes nothing. Paint another layer, or erase to bring layer ${first.channel + 1} back.`);
      }
    } else {
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
  private resolveTarget(clientX: number, clientY: number, s: Stroke | null, adds?: boolean): { cell: Cell3; value: BlockCell | null } | null {
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
      if (adds ?? toolAdds(tool)) {
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

  /**
   * Apply edits to the layer copy and re-mesh the chunks they touched (a stroke's local preview). `coverages`: a
   * paint stroke's, shared by its dabs, so the opacity holds across them as in the command that sends them all.
   */
  private previewEdits(edits: readonly BlockEdit[], coverages?: Map<string, StrokeCoverage | null>): void {
    const layer = this.layer;
    if (layer === null || layer.component.metadataOnly === true) return;
    const t0 = performance.now();
    if (this.scratch === null) this.scratch = BlockGrid.from(layer.component, { entityId: layer.entityId, chunks: [...layer.chunks.values()] });
    const res = applyBlockEdits(this.scratch, edits, { types: this.types, stamps: this.stamps, ...(this.roomWalls !== null ? { walls: this.roomWalls } : {}), ...(coverages !== undefined ? { coverages } : {}) });
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
      this.drawLineGhost(lineCells(s.start, s.end).map((c) => [c[0], c[1], c[2], c[0] + 1, c[1] + 1, c[2] + 1]));
    } else this.drawHover(s.end);
    this.host.requestRender();
  }

  /** Ghost boxes (cell units, `[x0, y0, z0, x1, y1, z1]`): one instance each. */
  private drawLineGhost(cells: readonly (readonly number[])[]): void {
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
      m.makeScale((c[3]! - c[0]!) * cs[0], (c[4]! - c[1]!) * cs[1], (c[5]! - c[2]!) * cs[2]).setPosition(c[0]! * cs[0], c[1]! * cs[1], c[2]! * cs[2]);
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
    if (this.sliceOutline !== null) {
      this.sliceOutline.removeFromParent();
      disposeTree(this.sliceOutline);
      this.sliceOutline = null;
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
    // The slice: a faint plane in the state colour with its outline, so the row the tools work on reads at a glance.
    const select = tokenColour('--select');
    const plane = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    plane.rotateX(-Math.PI / 2);
    plane.translate((x0 + x1) / 2, y - 0.001, (z0 + z1) / 2);
    this.slicePlane = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: select, transparent: true, opacity: SLICE_FILL, depthWrite: false, side: THREE.DoubleSide }));
    this.slicePlane.renderOrder = 9;
    this.slicePlane.name = 'block-slice';
    this.root.add(this.slicePlane);
    const outline = new THREE.BufferGeometry();
    outline.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0], 3));
    this.sliceOutline = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: select, transparent: true, opacity: 0.9, depthTest: false }));
    this.sliceOutline.renderOrder = 11;
    this.root.add(this.sliceOutline);
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

  /** The readout of a shape stroke by the pointer: its size in metres, the cells it covers, what it places. */
  private showReadout(s: Stroke): void {
    const layer = this.layer;
    if (layer === null || this.pointer === null || !(toolRect(s.tool, this.opts.meta?.shape) || s.tool === 'line')) return;
    const cs = layer.component.cellSize;
    const box = clipBox(s.tool === 'select' ? boxBetween(s.start, s.end) : s.tool === 'line' ? boxBetween(s.start, s.end) : rectBetween(s.start, s.end, s.tool === 'box' ? this.opts.brush.height : 1), layer.component.bounds);
    if (box === null) return this.readout.hide();
    const w = (box[3] - box[0]) * cs[0];
    const d = (box[5] - box[2]) * cs[2];
    const n = s.tool === 'line' ? lineCells(s.start, s.end).length : (box[3] - box[0]) * (box[4] - box[1]) * (box[5] - box[2]);
    const t = this.opts.brush.block !== null ? this.types.get(this.opts.brush.block) : undefined;
    const what = s.tool === 'select' ? `${n} cells selected` : s.tool === 'region' ? `${n} cells · region ${this.opts.region ?? '(none)'}` : s.tool === 'meta' ? `${n} cells · ${this.opts.meta?.field ?? ''}` : `${n} ${t?.name ?? 'cells'}`;
    const fmt = (m: number): string => (Number.isInteger(m) ? String(m) : m.toFixed(2));
    this.readout.show(this.pointer, `${fmt(w)} × ${fmt(d)} m`, `${what} · release to ${s.tool === 'select' ? 'select' : 'place'} · Esc cancels`);
  }

  dispose(): void {
    this.unstore?.();
    this.control.dispose();
    this.readout.dispose();
    this.root.removeFromParent();
    disposeTree(this.root);
  }
}
