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
 * Measures for tests on the canvas: `data-terrain-brush` (the cursor's
 * world point), `data-terrain-stroke` (the last stroke: dabs, the preview's
 * main-thread time per frame, the commit's round trip, how long until the
 * stored tiles replaced the preview, and — with `?terrainCheck=1` — the
 * preview read back against the stored tiles).
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import type { TerrainComponent } from '@thirdlight/project-model';
import type { TerrainPreviewDab, TerrainPreviewStats, TerrainView } from '@thirdlight/three-adapter';
import { DEFAULT_TERRAIN_BRUSH, PLACED_TERRAIN_TOOLS, dabsAlong, previewDab, previewedTool, strokeArgs, strokeDabLimit, strokeKind, terrainDabSpacing, type StrokeExtra, type TerrainBrushState, type TerrainToolId } from '../session/terrain-brush';

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
  brush: TerrainBrushState;
  /** Lower / erase / fill (the panel's toggle; Ctrl held inverts it for one stroke). */
  invert: boolean;
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

const RING_POINTS = 64;
const CURSOR = 0xffc857;
const CURSOR_INVERT = 0xff6b6b;

interface Stroke {
  tool: TerrainToolId;
  invert: boolean;
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
  private readonly ring: THREE.Line;
  private readonly rampLine: THREE.Line;
  private readonly raycaster = new THREE.Raycaster();
  private active = false;
  private target: TerrainEditTarget | null = null;
  private opts: TerrainToolOptions = { tool: 'raise', brush: DEFAULT_TERRAIN_BRUSH, invert: false };
  private stroke: Stroke | null = null;
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
    const ringGeo = new THREE.BufferGeometry();
    // Closed by repeating its first point (three's WebGPU renderer draws no line loops).
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((RING_POINTS + 1) * 3), 3));
    this.ring = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: CURSOR, depthTest: false, transparent: true }));
    this.ring.renderOrder = 20;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    this.rampLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: CURSOR, depthTest: false, transparent: true }));
    this.rampLine.renderOrder = 20;
    this.rampLine.frustumCulled = false;
    this.rampLine.visible = false;
    this.root.add(this.ring, this.rampLine);
    host.scene.add(this.root);
  }

  // ---- state ------------------------------------------------------------------------

  /** Arm or disarm the tools (disarmed: no cursor, no pointer handling). */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (!on) this.cancel();
    this.root.visible = on;
    this.ring.visible = false;
    this.host.canvas.setAttribute('data-terrain-tool', on ? this.opts.tool : '');
    this.host.armed?.(on);
    this.warm();
    this.host.requestRender();
  }

  /** Have the tool's passes built ahead for the terrain (its first dab then builds none on its frame). */
  private warm(): void {
    const tool = this.opts.tool;
    if (this.active && this.target !== null && previewedTool(tool)) this.host.terrains()?.previewWarm(this.target.entityId, tool);
  }

  isActive(): boolean {
    return this.active;
  }

  /** The terrain the tools edit (null: none selected). */
  setTarget(t: TerrainEditTarget | null): void {
    if (t?.entityId !== this.target?.entityId) this.cancel();
    const changed = t?.entityId !== this.target?.entityId;
    this.target = t;
    if (t === null) this.ring.visible = false;
    else if (changed) this.warm();
  }

  setOptions(o: TerrainToolOptions): void {
    const toolChanged = o.tool !== this.opts.tool;
    this.opts = o;
    if (this.active) this.host.canvas.setAttribute('data-terrain-tool', o.tool);
    if (toolChanged) this.warm();
    (this.ring.material as THREE.LineBasicMaterial).color.setHex(o.invert && (o.tool === 'raise' || o.tool === 'paint' || o.tool === 'holes') ? CURSOR_INVERT : CURSOR);
    this.host.requestRender();
  }

  strokeInFlight(): boolean {
    return this.stroke !== null;
  }

  // ---- pointer -----------------------------------------------------------------------

  pointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0 || e.altKey) return false;
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
    const invert = this.opts.invert !== (e.ctrlKey || e.metaKey);
    const point: [number, number] = [r4(at.x), r4(at.z)];
    this.stroke = { tool, invert, dabs: [], last: point, extra: tool === 'flatten' ? { height: r4(at.y) } : {}, limit: strokeDabLimit(this.opts.brush.radius, t.component.spacing), from: tool === 'ramp' ? [point[0], r4(at.y), point[1]] : null };
    this.lastStroke = { serial: ++this.strokes, tool: strokeKind(tool, invert), dabs: 0, commitMs: null, stored: null };
    if (tool === 'ramp') this.drawRamp(at);
    else this.addDab(point);
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    if (!this.active) return false;
    const at = this.surfaceUnder(e.clientX, e.clientY);
    this.drawCursor(at);
    const k = this.stroke;
    if (k === null) return false;
    if (at === null) return true;
    if (k.tool === 'ramp') {
      this.drawRamp(at);
      return true;
    }
    const step = terrainDabSpacing(this.opts.brush.radius, this.target!.component.spacing);
    const along = dabsAlong(k.last, [at.x, at.z], step);
    for (const p of along.points) this.addDab([r4(p[0]), r4(p[1])]);
    k.last = along.last;
    return true;
  }

  pointerUp(_e: PointerEvent): boolean {
    const k = this.stroke;
    if (k === null) return false;
    this.stroke = null;
    void this.finish(k);
    return true;
  }

  /** Esc: drop the stroke in flight (nothing is stored; the preview is undone). */
  cancel(): boolean {
    const k = this.stroke;
    if (k === null) return false;
    this.stroke = null;
    this.rampLine.visible = false;
    if (this.target !== null && k.tool !== 'scatter') this.host.terrains()?.previewEnd(this.target.entityId, null);
    this.host.requestRender();
    return true;
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
    const dab = previewDab(k.tool, this.opts.brush, p, k.invert, k.extra);
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
      const dab = previewDab('ramp', this.opts.brush, [to[0], to[2]], k.invert, k.extra) as TerrainPreviewDab;
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
    const stored = await this.cb.onCommit(strokeArgs(t.entityId, k.tool, this.opts.brush, dabs, k.invert, k.extra));
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
    const t = this.target;
    const field = t === null ? null : (this.host.terrains()?.field(t.entityId) ?? null);
    if (at === null || field === null) {
      this.ring.visible = false;
      this.host.requestRender();
      return;
    }
    const r = this.opts.brush.radius;
    const pos = this.ring.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i <= RING_POINTS; i++) {
      const a = (i / RING_POINTS) * Math.PI * 2;
      const x = at.x + Math.cos(a) * r;
      const z = at.z + Math.sin(a) * r;
      pos.setXYZ(i, x, (field.heightAt(x, z) ?? at.y) + 0.05, z);
    }
    pos.needsUpdate = true;
    this.ring.geometry.computeBoundingSphere();
    this.ring.visible = true;
    this.host.requestRender();
  }

  dispose(): void {
    this.root.removeFromParent();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.rampLine.geometry.dispose();
    (this.rampLine.material as THREE.Material).dispose();
  }
}
