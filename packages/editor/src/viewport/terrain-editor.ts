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
import type { TerrainComponent } from '@thirdlight/project-model';
import type { TerrainPreviewDab, TerrainPreviewStats, TerrainView } from '@thirdlight/three-adapter';
import { DEFAULT_BRUSH, brushRadius, brushSummary, dragStrength, roundSize, stepSize, stepStrength, strokeMask, type BrushSettings, type BrushStore } from '../session/brush';
import { brushKeyAction } from '../session/edit-keys';
import { DEFAULT_TERRAIN_BRUSH, PLACED_TERRAIN_TOOLS, dabsAlong, previewDab, previewedTool, strokeArgs, strokeDabLimit, strokeKind, terrainDabSpacing, terrainToolUses, type StrokeExtra, type TerrainBrushState, type TerrainToolId } from '../session/terrain-brush';
import { BrushCursor, BrushHud } from './brush-cursor';

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
    this.refreshLook();
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
    return this.stroke !== null;
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
    const at = this.surfaceUnder(e.clientX, e.clientY);
    this.drawCursor(at);
    const tool = this.opts.tool;
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
    const k = this.stroke;
    if (k === null) return false;
    this.stroke = null;
    if (this.lastAt !== null) this.drawCursor(this.lastAt);
    void this.finish(k);
    return true;
  }

  /** Esc: drop the stroke in flight (nothing is stored; the preview is undone), or put back what F was dragging. */
  cancel(): boolean {
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
    this.host.canvas.setAttribute('data-terrain-brush', '');
    this.host.requestRender();
  }

  /** After a frame: publish the last stroke's figures when they changed (tests read them). */
  afterFrame(): void {
    const t = this.target;
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
    this.rampLine.geometry.dispose();
    (this.rampLine.material as THREE.Material).dispose();
  }
}
