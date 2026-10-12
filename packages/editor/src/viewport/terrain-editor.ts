/**
 * The Scene view's terrain tools: the brush cursor on the ground under the
 * pointer and the strokes.
 *
 * Strokes follow the gizmo-drag rule (charter), as the block tools' do: a
 * stroke previews locally and its release stores ONE `editTerrain` (one
 * undo step). The preview is drawn on the GPU (`TerrainView.preview*`,
 * three-adapter): each dab changes the drawn tiles' texels in place before
 * the next frame — no tile re-packed or meshed on the CPU, nothing sent per
 * dab. The stored edit's tiles then replace the preview as they arrive (only
 * the tiles it changed are read and uploaded again); a refused or cancelled
 * stroke has its tiles uploaded again from their stored copies.
 *
 * The cursor and the dabs aim at the ground as stored (`TerrainField.raycast`,
 * the surface the renderer and collision share): a stroke never climbs onto
 * what it has just raised. A ramp is a drag from one end to the other (the
 * line shows meanwhile); flatten levels to the height where the stroke
 * began.
 *
 * The brush is the shared one (`session/brush.ts`): its settings live in the
 * tool's store, which the panel shows and the keys change — `[` / `]` size,
 * Shift with them strength, F then a drag resizes on the ground (Shift+F:
 * strength), a click sets it and Esc puts it back, X switches paint and
 * erase, Ctrl held inverts one stroke and turns the cursor red. The cursor
 * is the shared one (`brush-cursor.ts`).
 *
 * Measures for tests on the canvas: `data-terrain-brush` (the cursor's
 * world point), `data-terrain-cursor` (its radius, colour and whether it
 * shows a mask), `data-terrain-stroke` (the last stroke: dabs, the preview's
 * main-thread time per frame, the commit's round trip, how long until the
 * stored tiles replaced the preview, and — with `?terrainCheck=1` — the
 * preview read back against the stored tiles).
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import type { SurfaceRule, TerrainComponent } from '@thirdlight/project-model';
import type { TerrainPreviewDab, TerrainPreviewStats, TerrainView } from '@thirdlight/three-adapter';
import { DEFAULT_BRUSH, brushRadius, brushSummary, dragStrength, roundSize, stepSize, stepStrength, strokeMask, type BrushSettings, type BrushStore } from '../session/brush';
import { brushKeyAction } from '../session/edit-keys';
import { DEFAULT_TERRAIN_BRUSH, PICKING_TERRAIN_TOOLS, PLACED_TERRAIN_TOOLS, dabsAlong, previewDab, previewedTool, strokeArgs, strokeDabLimit, strokeKind, terrainDabSpacing, terrainToolUses, type StampRef, type StrokeExtra, type TerrainBrushState, type TerrainToolId } from '../session/terrain-brush';
import { bakeRulesPreview, type RulesPreview } from '../session/terrain-rules-preview';
import { BrushCursor, BrushHud } from './brush-cursor';
import { TerrainTileGrid, type TileGridCell } from './terrain-tile-grid';
import { STAMP_HANDLE_PX, TerrainStampHandles, draggedPose, poseOf, type StampHandle, type StampPose } from './terrain-stamp-handles';

/** The selected terrain as the editor holds it. */
export interface TerrainEditTarget {
  entityId: string;
  component: TerrainComponent;
  /** The object is locked or hidden (Hierarchy flags): nothing is edited. */
  locked: boolean;
  hidden: boolean;
}

export interface TerrainToolOptions {
  tool: TerrainToolId;
  /** The terrain's own settings (layer, noise, scatter rule). */
  brush: TerrainBrushState;
  /** The tool's shared brush settings (the panel shows them; keys and in-view drags change them). */
  store: BrushStore | null;
  /** The placed tools (stamp, erode): what a click at world (x, z) does. */
  place?: (at: [number, number]) => void;
  /** Tiles: a click on a tile or an empty square beside the terrain, and the tile picked. */
  onTile?: (cell: TileGridCell) => void;
  pickedTile?: readonly [number, number] | null;
  /** Stack: the stamps drawn, the one picked, a pick (null: none) and a stamp moved, turned or resized (one command). */
  stamps?: { list: readonly StampRef[]; picked: { layer: string; index: number } | null; onPick: (ref: StampRef | null) => void; onChange: (ref: StampRef, pose: StampPose) => void };
}

export interface TerrainEditorCallbacks {
  /** Store one stroke (one editTerrain); the tiles it changed ([x, z]) when stored, null when not (refused, or it changed nothing). */
  onCommit(args: Record<string, unknown>): Promise<readonly (readonly number[])[] | null>;
  /** Something cannot be done (a locked or hidden terrain, the stroke's dab bound). */
  onRefused(message: string): void;
}

export interface TerrainEditorHost {
  /** Where the cursor is drawn (the Scene view's overlay group). */
  readonly scene: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  requestRender(): void;
  /** The terrains drawn (null before the renderer is up). */
  terrains(): TerrainView | null;
  /** Armed, the tools own the left button (the host stands its gizmo aside). */
  armed?(on: boolean): void;
}

/** The tools whose overlays (the tile grid, the stamps' squares) lie on the decoded ground. */
const OVERLAID_TOOLS: readonly TerrainToolId[] = ['tiles', 'stamps', 'stamp', 'erode'];

/** How long the readout stays after a key changed the brush. */
const HUD_KEY_MS = 1200;

interface Stroke {
  tool: TerrainToolId;
  invert: boolean;
  /** The brush as the stroke began (a key mid-stroke changes the next one). */
  settings: BrushSettings;
  dabs: [number, number][];
  last: [number, number];
  extra: StrokeExtra;
  limit: number;
  /** The ramp's start (world). */
  from: [number, number, number] | null;
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export class TerrainEditor {
  private readonly host: TerrainEditorHost;
  private readonly cb: TerrainEditorCallbacks;
  private readonly root = new THREE.Group();
  private readonly cursor: BrushCursor;
  private readonly hud: BrushHud;
  private readonly rampLine: THREE.Line;
  private readonly grid: TerrainTileGrid;
  private readonly stampHandles: TerrainStampHandles;
  /** A picked stamp's handle being dragged: which, its pose before, the ground point it began at. */
  /** The decoded ground the overlays were last laid on (a new one — tiles arrived — lays them again). */
  private overlayField: object | null = null;
  private overlaySerial = 0;
  private stampDrag: { handle: StampHandle; ref: StampRef; start: StampPose; from: [number, number]; pose: StampPose } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private active = false;
  private target: TerrainEditTarget | null = null;
  private opts: TerrainToolOptions = { tool: 'raise', brush: DEFAULT_TERRAIN_BRUSH, store: null };
  private stroke: Stroke | null = null;
  /** F / Shift+F: the size or strength dragged in the view (its value before, to put back on Esc; where it began). */
  private adjust: { what: 'size' | 'strength'; before: BrushSettings; anchor: THREE.Vector3 | null; from: { x: number; y: number } } | null = null;
  /** The last pointer position over the view (client px) and the ground under it. */
  private pointer: { x: number; y: number } | null = null;
  private lastAt: THREE.Vector3 | null = null;
  /** Ctrl is held (the cursor turns to inverting). */
  private ctrl = false;
  private unstore: (() => void) | null = null;
  private readonly onCtrl = (e: KeyboardEvent): void => {
    if (e.key !== 'Control' && e.key !== 'Meta') return;
    const held = e.type === 'keydown';
    if (held === this.ctrl) return;
    this.ctrl = held;
    this.refreshLook();
  };
  private readonly onBlur = (): void => {
    if (!this.ctrl) return;
    this.ctrl = false;
    this.refreshLook();
  };
  /** Read the preview back to compare with the stored tiles (`?terrainCheck=1`: a test's measure). */
  private readonly check: boolean;
  /** The last stroke as tests read it (`serial` counts strokes). */
  private lastStroke: { serial: number; tool: TerrainToolId; dabs: number; commitMs: number | null; stored: boolean | null } | null = null;
  private strokes = 0;
  private published = '';

  constructor(host: TerrainEditorHost, cb: TerrainEditorCallbacks) {
    this.host = host;
    this.cb = cb;
    this.check = typeof location !== 'undefined' && new URLSearchParams(location.search).get('terrainCheck') === '1';
    this.root.name = 'terrain-editor';
    this.root.visible = false;
    this.cursor = new BrushCursor(this.root, 'terrain-brush-cursor');
    this.hud = new BrushHud(host.canvas);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    this.rampLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.rampLine.renderOrder = 20;
    this.rampLine.frustumCulled = false;
    this.rampLine.visible = false;
    this.root.add(this.rampLine);
    this.grid = new TerrainTileGrid(this.root);
    this.stampHandles = new TerrainStampHandles(this.root);
    host.scene.add(this.root);
  }

  // ---- state ------------------------------------------------------------------------

  /** Arm or disarm the tools (disarmed: no cursor, no pointer handling). */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) this.cancel();
    this.root.visible = on;
    this.cursor.hide();
    this.hud.hide();
    if (on) {
      window.addEventListener('keydown', this.onCtrl);
      window.addEventListener('keyup', this.onCtrl);
      window.addEventListener('blur', this.onBlur);
    } else {
      window.removeEventListener('keydown', this.onCtrl);
      window.removeEventListener('keyup', this.onCtrl);
      window.removeEventListener('blur', this.onBlur);
      this.ctrl = false;
    }
    this.host.canvas.setAttribute('data-terrain-tool', on ? this.opts.tool : '');
    this.host.armed?.(on);
    this.warm();
    this.refreshOverlays();
    this.host.requestRender();
  }

  /** Have the tool's passes built ahead for the terrain (its first dab then builds none on its frame). */
  private warm(): void {
    const tool = this.opts.tool;
    // A brush painting through the mask draws with the masked passes: those are built ahead once the mask is on.
    const masked = strokeMask(this.settings(), terrainToolUses(tool)) !== null;
    this.warmedMasked = masked;
    if (this.active && this.target !== null && previewedTool(tool)) this.host.terrains()?.previewWarm(this.target.entityId, tool, masked);
  }

  /** Whether the passes last built ahead were the masked ones. */
  private warmedMasked = false;

  isActive(): boolean {
    return this.active;
  }

  /** The terrain the tools edit (null: none selected). */
  setTarget(t: TerrainEditTarget | null): void {
    if (t?.entityId !== this.target?.entityId) this.cancel();
    const changed = t?.entityId !== this.target?.entityId;
    this.target = t;
    if (t === null) this.cursor.hide();
    else if (changed) this.warm();
    this.refreshOverlays();
  }

  setOptions(o: TerrainToolOptions): void {
    const toolChanged = o.tool !== this.opts.tool;
    if (o.store !== this.opts.store) {
      this.unstore?.();
      // A key, a drag or the panel changed the brush: the cursor follows at once.
      this.unstore = o.store?.subscribe(() => this.refreshLook()) ?? null;
    }
    this.opts = o;
    if (this.active) this.host.canvas.setAttribute('data-terrain-tool', o.tool);
    if (toolChanged) this.warm();
    this.refreshOverlays();
    this.refreshLook();
  }

  /** The tile grid (Tiles) and the stamps' squares (Stack) for the tool and the terrain as they are now. */
  private refreshOverlays(): void {
    const t = this.target;
    const tool = this.opts.tool;
    const field = t === null ? null : (this.host.terrains()?.field(t.entityId) ?? null);
    if (field !== this.overlayField) {
      this.overlayField = field;
      this.overlaySerial += 1;
    }
    const tiles = this.active && t !== null && field !== null && tool === 'tiles';
    this.grid.setVisible(tiles);
    if (tiles) {
      const heightAt = (x: number, z: number): number | null => field.heightAt(x, z);
      this.grid.update(t.component, field.origin, heightAt, `${this.overlaySerial}:${t.entityId}:${t.component.tiles.map((r) => `${r.x},${r.z}`).join(';')}`);
      this.grid.setPicked(this.opts.pickedTile ?? null);
    }
    const st = this.opts.stamps;
    const stack = this.active && t !== null && field !== null && st !== undefined && (tool === 'stamps' || tool === 'stamp' || tool === 'erode');
    this.stampHandles.setVisible(stack);
    if (stack && this.stampDrag === null) this.stampHandles.set(st.list, st.picked, tool === 'stamps', (x, z) => field.heightAt(x, z));
    this.publishStamps();
    this.host.requestRender();
  }

  /** The picked stamp's handles on screen (client px) for tests: its centre, corners and turn knob. */
  private publishStamps(): void {
    const ref = this.stampHandles.pickedRef();
    if (ref === null || this.opts.tool !== 'stamps' || !this.active) {
      this.host.canvas.setAttribute('data-terrain-stamp', '');
      return;
    }
    const pose = this.stampDrag?.pose ?? poseOf(ref);
    const { corners, knob } = this.stampHandles.handlePoints(pose);
    // Its middle on the level of its corners: where a press grabs its body (its square as drawn).
    const centre = new THREE.Vector3(pose.at[0], corners.reduce((sum, c) => sum + c.y, 0) / corners.length, pose.at[1]);
    const s = (v: THREE.Vector3): [number, number] => {
      const q = this.screen(v);
      return [Math.round(q.x), Math.round(q.y)];
    };
    this.host.canvas.setAttribute('data-terrain-stamp', JSON.stringify({ layer: ref.layer, index: ref.index, centre: s(centre), corner: s(corners[2]!), knob: s(knob) }));
  }

  /** A world point on screen (client px). */
  private screen(v: THREE.Vector3): { x: number; y: number } {
    const rect = this.host.canvas.getBoundingClientRect();
    const p = v.clone().project(this.host.camera);
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  /** The tool's brush settings now. */
  private settings(): BrushSettings {
    return this.opts.store?.get() ?? DEFAULT_BRUSH;
  }

  /** The cursor's look from the settings, the tool and Ctrl; laid again where it is. */
  private refreshLook(): void {
    const b = this.settings();
    const tool = this.opts.tool;
    const uses = terrainToolUses(tool);
    if ((strokeMask(b, uses) !== null) !== this.warmedMasked) this.warm();
    const invert = uses.includes('invert') && b.invert !== this.ctrl;
    // A tool without a strength (holes, scatter, stamp, erode) shows its footprint only: no fill.
    const blend = uses.includes('strength') ? b.strength : 0;
    this.cursor.setLook({ falloff: uses.includes('falloff') ? b.falloff : 'constant', hardness: b.hardness, strength: blend, mask: strokeMask(b, uses), state: invert ? 'erase' : 'paint' });
    if (this.lastAt !== null && this.active) this.drawCursor(this.lastAt);
    else this.host.requestRender();
  }

  strokeInFlight(): boolean {
    return this.stroke !== null || this.stampDrag !== null;
  }

  // ---- pointer -----------------------------------------------------------------------

  pointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0 || e.altKey) return false;
    // F / Shift+F: a click sets what was dragged.
    if (this.adjust !== null) {
      this.adjust = null;
      this.hud.hide();
      return true;
    }
    const t = this.target;
    const view = this.host.terrains();
    if (t === null || view === null) return true;
    if (t.locked) {
      this.cb.onRefused('The terrain is locked (unlock it in the Hierarchy).');
      return true;
    }
    if (t.hidden) {
      this.cb.onRefused('The terrain is hidden (show it to edit it).');
      return true;
    }
    const tool = this.opts.tool;
    if (tool === 'tiles') {
      const cell = this.cellUnder(e.clientX, e.clientY);
      if (cell !== null) this.opts.onTile?.(cell);
      return true;
    }
    if (tool === 'stamps') {
      this.pressStamps(e.clientX, e.clientY);
      return true;
    }
    const at = this.surfaceUnder(e.clientX, e.clientY);
    this.drawCursor(at);
    // A placed tool: one click, one command (its result comes back as the stored tiles).
    if (PLACED_TERRAIN_TOOLS.includes(tool)) {
      if (at !== null) this.opts.place?.([r4(at.x), r4(at.z)]);
      return true;
    }
    if (tool === 'scatter' && this.opts.brush.rule === '') {
      this.cb.onRefused('Choose a scatter rule to paint (make one with Scatter rules…).');
      return true;
    }
    // The scatter brush has no preview: its copies come with the stored edit.
    if (at === null || (previewedTool(tool) && !view.previewBegin(t.entityId))) return true;
    const b = this.settings();
    const invert = terrainToolUses(tool).includes('invert') && b.invert !== (e.ctrlKey || e.metaKey);
    const point: [number, number] = [r4(at.x), r4(at.z)];
    this.stroke = { tool, invert, settings: b, dabs: [], last: point, extra: tool === 'flatten' ? { height: r4(at.y) } : {}, limit: strokeDabLimit(brushRadius(b), t.component.spacing), from: tool === 'ramp' ? [point[0], r4(at.y), point[1]] : null };
    this.lastStroke = { serial: ++this.strokes, tool: strokeKind(tool, invert), dabs: 0, commitMs: null, stored: null };
    // The rings alone while the stroke lasts.
    this.drawCursor(at);
    if (tool === 'ramp') this.drawRamp(at);
    else this.addDab(point);
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    if (!this.active) return false;
    this.pointer = { x: e.clientX, y: e.clientY };
    if (this.adjust !== null) {
      this.dragAdjust(e.clientX, e.clientY);
      return true;
    }
    if (this.ctrl !== (e.ctrlKey || e.metaKey)) {
      this.ctrl = e.ctrlKey || e.metaKey;
      this.refreshLook();
    }
    if (this.opts.tool === 'tiles') {
      const cell = this.cellUnder(e.clientX, e.clientY);
      this.grid.setHover(cell);
      this.host.canvas.setAttribute('data-terrain-tile', cell === null ? '' : `${cell.kind}:${cell.x},${cell.z}`);
      this.host.requestRender();
      return false;
    }
    if (this.opts.tool === 'stamps') {
      const d = this.stampDrag;
      const to = d === null ? null : this.levelUnder(e.clientX, e.clientY, d.start);
      if (d === null || to === null) return d !== null;
      d.pose = draggedPose(d.handle, d.start, d.from, to);
      this.stampHandles.drag(d.pose);
      this.publishStamps();
      this.host.requestRender();
      return true;
    }
    const at = this.surfaceUnder(e.clientX, e.clientY);
    this.drawCursor(at);
    const k = this.stroke;
    if (k === null) return false;
    if (at === null) return true;
    if (k.tool === 'ramp') {
      this.drawRamp(at);
      return true;
    }
    const step = terrainDabSpacing(k.settings, this.target!.component.spacing);
    const along = dabsAlong(k.last, [at.x, at.z], step);
    for (const p of along.points) this.addDab([r4(p[0]), r4(p[1])]);
    k.last = along.last;
    return true;
  }

  pointerUp(_e: PointerEvent): boolean {
    const d = this.stampDrag;
    if (d !== null) {
      this.stampDrag = null;
      const moved = d.pose.at[0] !== d.start.at[0] || d.pose.at[1] !== d.start.at[1] || d.pose.size !== d.start.size || d.pose.rotation !== d.start.rotation;
      if (moved) this.opts.stamps?.onChange(d.ref, d.pose);
      else this.stampHandles.drag(null);
      this.publishStamps();
      return true;
    }
    const k = this.stroke;
    if (k === null) return false;
    this.stroke = null;
    if (this.lastAt !== null) this.drawCursor(this.lastAt);
    void this.finish(k);
    return true;
  }

  /** Esc: drop the stroke in flight (nothing is stored; the preview is undone), or put back what F was dragging. */
  cancel(): boolean {
    if (this.stampDrag !== null) {
      this.stampDrag = null;
      this.stampHandles.drag(null);
      this.publishStamps();
      this.host.requestRender();
      return true;
    }
    if (this.adjust !== null) {
      const a = this.adjust;
      this.adjust = null;
      this.hud.hide();
      this.opts.store?.set({ size: a.before.size, strength: a.before.strength });
      return true;
    }
    const k = this.stroke;
    if (k === null) return false;
    this.stroke = null;
    this.rampLine.visible = false;
    if (this.lastAt !== null) this.drawCursor(this.lastAt);
    if (this.target !== null && k.tool !== 'scatter') this.host.terrains()?.previewEnd(this.target.entityId, null);
    this.host.requestRender();
    return true;
  }

  /** The pointer left the view: the cursor and its readout go (a stroke in flight keeps going). */
  leave(): void {
    if (this.stroke !== null || this.adjust !== null) return;
    this.pointer = null;
    this.lastAt = null;
    this.cursor.hide();
    this.hud.hide();
    this.grid.setHover(null);
    this.host.canvas.setAttribute('data-terrain-brush', '');
    this.host.requestRender();
  }

  /** After a frame: publish the last stroke's figures when they changed (tests read them). */
  afterFrame(): void {
    const t = this.target;
    // The ground the overlays lie on was decoded again (a tile came or changed): lay them on it.
    if (this.active && t !== null && OVERLAID_TOOLS.includes(this.opts.tool) && (this.host.terrains()?.field(t.entityId) ?? null) !== this.overlayField) this.refreshOverlays();
    if (t === null || this.lastStroke === null) return;
    const s: TerrainPreviewStats | null = this.host.terrains()?.previewStats(t.entityId) ?? null;
    const out = JSON.stringify({ ...this.lastStroke, ...(s !== null ? { preview: s } : {}) });
    if (out === this.published) return;
    this.published = out;
    this.host.canvas.setAttribute('data-terrain-stroke', out);
    // Still settling: the next frames publish its figures.
    if (s !== null && (s.active || s.settling || (this.check && s.diff === null))) this.host.requestRender();
  }

  // ---- internals ---------------------------------------------------------------------

  private addDab(p: [number, number]): void {
    const k = this.stroke;
    const t = this.target;
    if (k === null || t === null) return;
    if (k.dabs.length >= k.limit) {
      if (k.dabs.length === k.limit) this.cb.onRefused(`A stroke holds at most ${k.limit} dabs at this radius: release and begin another.`);
      k.dabs.push(p); // counted once past the bound (the notice is given once), never sent
      return;
    }
    k.dabs.push(p);
    if (this.lastStroke !== null) this.lastStroke.dabs = k.dabs.length;
    const dab = previewDab(k.tool, k.settings, this.opts.brush, p, k.invert, k.extra);
    if (dab !== null) this.host.terrains()?.previewDab(t.entityId, dab);
    this.host.requestRender();
  }

  private async finish(k: Stroke): Promise<void> {
    const t = this.target;
    const view = this.host.terrains();
    this.rampLine.visible = false;
    if (t === null || view === null) return;
    if (k.tool === 'ramp') {
      const to = this.rampTo;
      if (k.from === null || to === null || Math.hypot(to[0] - k.from[0], to[2] - k.from[2]) < 1e-3) {
        view.previewEnd(t.entityId, null);
        return;
      }
      k.extra = { from: k.from, to };
      k.dabs = [[to[0], to[2]]];
      const dab = previewDab('ramp', k.settings, this.opts.brush, [to[0], to[2]], k.invert, k.extra) as TerrainPreviewDab;
      view.previewDab(t.entityId, dab);
    }
    const previewed = k.tool !== 'scatter';
    const dabs = k.dabs.slice(0, k.limit);
    if (dabs.length === 0) {
      if (previewed) view.previewEnd(t.entityId, null);
      return;
    }
    if (previewed) view.previewRelease(t.entityId, this.check);
    this.host.requestRender();
    const t0 = performance.now();
    const serial = this.lastStroke?.serial ?? ++this.strokes;
    this.lastStroke = { serial, tool: strokeKind(k.tool, k.invert), dabs: dabs.length, commitMs: null, stored: null };
    const stored = await this.cb.onCommit(strokeArgs(t.entityId, k.tool, k.settings, this.opts.brush, dabs, k.invert, k.extra));
    if (previewed) view.previewEnd(t.entityId, stored);
    this.lastStroke = { ...this.lastStroke, commitMs: Math.round((performance.now() - t0) * 10) / 10, stored: stored !== null };
    this.host.requestRender();
  }

  /** The ramp's far end while it is dragged (world, rounded as stored). */
  private rampTo: [number, number, number] | null = null;

  private drawRamp(at: THREE.Vector3): void {
    const k = this.stroke;
    if (k?.from == null) return;
    this.rampTo = [r4(at.x), r4(at.y), r4(at.z)];
    const pos = this.rampLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, k.from[0], k.from[1] + 0.05, k.from[2]);
    pos.setXYZ(1, at.x, at.y + 0.05, at.z);
    pos.needsUpdate = true;
    this.rampLine.visible = true;
    this.host.requestRender();
  }

  /**
   * Draw `rules` on the terrain as a bake of them would paint it (the tiles
   * near what the view looks at, `terrain-rules-preview.ts`), or with null the stored
   * layers again. Returns what it covered (null: nothing drawn).
   */
  previewRules(rules: readonly SurfaceRule[] | null): (RulesPreview & { ms: number }) | null {
    const t = this.target;
    const view = this.host.terrains();
    if (t === null || view === null) return null;
    if (rules === null) {
      view.previewLayers(t.entityId, null);
      this.host.canvas.setAttribute('data-terrain-rules-preview', '');
      this.host.requestRender();
      return null;
    }
    const field = view.field(t.entityId);
    if (field === null) return null;
    const t0 = performance.now();
    // Nearest what the view looks at: the ground under its middle, else below the camera.
    const rect = this.host.canvas.getBoundingClientRect();
    const mid = this.surfaceUnder(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const cam = this.host.camera.position;
    const r = bakeRulesPreview(t.component, field.origin, (x, z) => field.tile(x, z), rules, mid !== null ? [mid.x, mid.z] : [cam.x, cam.z]);
    view.previewLayers(t.entityId, r.tiles);
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    this.host.canvas.setAttribute('data-terrain-rules-preview', JSON.stringify({ covered: r.covered, total: r.total, ms }));
    this.host.requestRender();
    return { ...r, ms };
  }

  /**
   * The picked stamp's handle, a stamp's square or nothing under a press: pick, or begin a drag. Found on the
   * screen (a corner or the knob within a few pixels, a square by its corners' outline), so a press on a stamp's
   * own mountain, or past the ground's edge, finds it as the drawing shows it; a drag is measured on the level of
   * the stamp's centre, so the mountain it raises does not pull it about.
   */
  private pressStamps(clientX: number, clientY: number): void {
    const st = this.opts.stamps;
    if (st === undefined) return;
    const picked = this.stampHandles.pickedRef();
    const near = (v: THREE.Vector3): boolean => {
      const q = this.screen(v);
      return Math.hypot(q.x - clientX, q.y - clientY) <= STAMP_HANDLE_PX;
    };
    let handle: StampHandle | null = null;
    if (picked !== null) {
      const { corners, knob } = this.stampHandles.handlePoints(poseOf(picked));
      if (near(knob)) handle = 'turn';
      else if (corners.some(near)) handle = 'size';
      else if (this.onStampScreen(picked, clientX, clientY)) handle = 'move';
    }
    const from = picked === null ? null : this.levelUnder(clientX, clientY, poseOf(picked));
    this.host.canvas.setAttribute('data-terrain-stamp-press', JSON.stringify({ handle, picked: picked === null ? null : `${picked.layer}:${picked.index}` }));
    if (handle !== null && picked !== null && from !== null) {
      const start = poseOf(picked);
      this.stampDrag = { handle, ref: picked, start, from, pose: start };
      return;
    }
    // A pick: the stamp whose square the press is on (the last drawn first), or none.
    const list = st.list;
    let hit: StampRef | null = null;
    for (let i = list.length - 1; i >= 0 && hit === null; i--) if (this.onStampScreen(list[i]!, clientX, clientY)) hit = list[i]!;
    st.onPick(hit);
  }

  /** Whether a client point lies in a stamp's square as drawn (its corners on the ground, projected). */
  private onStampScreen(r: StampRef, clientX: number, clientY: number): boolean {
    const { corners } = this.stampHandles.handlePoints(poseOf(r));
    const q = corners.map((c) => this.screen(c));
    let inside = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const a = q[i]!;
      const b = q[j]!;
      if (a.y > clientY !== b.y > clientY && clientX < ((b.x - a.x) * (clientY - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /** The point under the pointer (world x, z) on the level of a stamp's corners (null: the ray misses it). */
  private levelUnder(clientX: number, clientY: number, r: StampPose): [number, number] | null {
    const { corners } = this.stampHandles.handlePoints(r);
    const y = corners.reduce((sum, c) => sum + c.y, 0) / corners.length;
    const p = this.rayAt(clientX, clientY).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    return p === null ? null : [p.x, p.z];
  }

  /** The view's ray through a client point. */
  private rayAt(clientX: number, clientY: number): THREE.Ray {
    const rect = this.host.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.host.camera);
    return this.raycaster.ray.clone();
  }

  /** The tile grid's square under the pointer. */
  private cellUnder(clientX: number, clientY: number): TileGridCell | null {
    return this.grid.cellAt(this.rayAt(clientX, clientY), this.surfaceUnder(clientX, clientY));
  }

  /** The stored ground under the pointer (world), or null (no terrain there). */
  private surfaceUnder(clientX: number, clientY: number): THREE.Vector3 | null {
    const t = this.target;
    const field = t === null ? null : (this.host.terrains()?.field(t.entityId) ?? null);
    if (field === null) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.host.camera);
    const r = this.raycaster.ray;
    const hit = field.raycast([r.origin.x, r.origin.y, r.origin.z], [r.direction.x, r.direction.y, r.direction.z], this.host.camera.far);
    return hit === null ? null : new THREE.Vector3(...hit.point);
  }

  /** The brush's footprint laid on the ground (its points at the stored heights). */
  private drawCursor(at: THREE.Vector3 | null): void {
    this.host.canvas.setAttribute('data-terrain-brush', at === null ? '' : `${at.x.toFixed(3)},${at.y.toFixed(3)},${at.z.toFixed(3)}`);
    this.lastAt = at;
    // The picking tools have no brush: no rings.
    if (PICKING_TERRAIN_TOOLS.includes(this.opts.tool)) {
      this.cursor.hide();
      this.host.requestRender();
      return;
    }
    const t = this.target;
    const field = t === null ? null : (this.host.terrains()?.field(t.entityId) ?? null);
    if (at === null || field === null || t === null) {
      this.cursor.hide();
      this.host.requestRender();
      return;
    }
    const b = this.settings();
    const r = brushRadius(b);
    // The mask is anchored to the terrain (its object's position), as the command's.
    this.cursor.place({ centre: at, rx: r, rz: r, heightAt: (x, z) => field.heightAt(x, z), maskOrigin: [field.origin[0], field.origin[2]], fill: this.stroke === null });
    this.host.canvas.setAttribute('data-terrain-cursor', JSON.stringify({ radius: r, state: this.cursor.state(), mask: strokeMask(b, terrainToolUses(this.opts.tool)) !== null }));
    this.host.requestRender();
  }

  // ---- keys ------------------------------------------------------------------------------

  /** A brush key while the tools are armed (the edit mode's key map routes it here); true when taken. */
  key(e: KeyboardEvent): boolean {
    if (!this.active || this.stroke !== null) return false;
    const store = this.opts.store;
    if (store === null) return false;
    const uses = terrainToolUses(this.opts.tool);
    const a = brushKeyAction(e, uses);
    if (a === null) return false;
    const b = store.get();
    if (a.kind === 'size') store.set({ size: stepSize(b.size, a.dir, store.bounds) });
    else if (a.kind === 'strength') store.set({ strength: stepStrength(b.strength, a.dir) });
    else if (a.kind === 'invert') store.set({ invert: !b.invert });
    else {
      if (this.pointer === null) return true;
      this.adjust = { what: a.kind === 'resize' ? 'size' : 'strength', before: b, anchor: this.lastAt?.clone() ?? null, from: { ...this.pointer } };
      this.showAdjust();
      return true;
    }
    if (this.pointer !== null) this.hud.show(this.pointer, this.hudValue(a.kind === 'strength' ? 'strength' : 'size'), a.kind === 'invert' ? (store.get().invert ? 'inverted (X)' : 'not inverted (X)') : brushSummary(store.get(), uses), HUD_KEY_MS);
    return true;
  }

  /** F / Shift+F while dragging: the size follows the ground distance from where it began; the strength, the pointer's travel. */
  private dragAdjust(x: number, y: number): void {
    const a = this.adjust!;
    const store = this.opts.store;
    if (store === null) return;
    if (a.what === 'size') {
      const at = a.anchor === null ? null : this.surfaceUnder(x, y);
      if (at !== null && a.anchor !== null) store.set({ size: Math.max(store.bounds.size[0], Math.min(store.bounds.size[1], roundSize(2 * Math.hypot(at.x - a.anchor.x, at.z - a.anchor.z)))) });
    } else store.set({ strength: dragStrength(a.before.strength, x - a.from.x, y - a.from.y) });
    this.showAdjust();
  }

  private hudValue(what: 'size' | 'strength'): string {
    const b = this.settings();
    return what === 'size' ? `Size ${roundSize(b.size).toFixed(b.size < 10 ? 1 : 0)} m` : `Strength ${Math.round(b.strength * 100)} %`;
  }

  private showAdjust(): void {
    const a = this.adjust;
    if (a === null || this.pointer === null) return;
    this.hud.show(this.pointer, this.hudValue(a.what), a.what === 'size' ? 'F · drag to resize · click to set · Esc puts it back' : 'Shift+F · drag to set the strength · click to set · Esc puts it back');
  }

  dispose(): void {
    this.setActive(false);
    this.unstore?.();
    this.root.removeFromParent();
    this.cursor.dispose();
    this.hud.dispose();
    this.grid.dispose();
    this.stampHandles.dispose();
    this.rampLine.geometry.dispose();
    (this.rampLine.material as THREE.Material).dispose();
  }
}
