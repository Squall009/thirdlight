/**
 * The Scene view's vertex paint brush, armed by the vertex paint editor on
 * one object (a placed model, an instance set, generated architecture or a
 * spline): a left drag on it paints its vertices with the shared brush;
 * Alt+drag (or the right button) still orbits, a press anywhere else is
 * the view's.
 *
 * - A press fixes what the stroke paints: the copy under the pointer of a
 *   set; a generated object's nearest path and the side its face looks to.
 *   Each move adds a dab where the pointer meets that object, the brush's
 *   spacing from the last.
 * - Each dab is painted at once on the page (the adapter's preview: the
 *   object's paint bytes rewritten and drawn by the GPU in the same frame),
 *   with the functions the backend paints with, the stroke's opacity held
 *   across its dabs as the backend holds it.
 * - The release sends the stroke as ONE `paintVertices` (one undo). The
 *   preview stays drawn until the stored paint replaces it, so the object
 *   never blinks; a refused stroke takes it off at once and says why.
 * - A stroke that would pass the dabs one command carries is sent there and
 *   the drag goes on as the next stroke.
 * - The cursor is the shared one (`brush-cursor.ts`), laid flat on the face
 *   under the pointer; the keys and in-view drags are the shared ones
 *   (`brush-control.ts`). On a material that reads no paint the cursor is
 *   grey and a press paints nothing (the editor says why).
 *
 * Tests read `data-vertex-paint`: the object armed on, the last stroke's
 * dabs, its preview cost a dab and its latency (release → stored paint
 * drawn), the frames since the stroke in which the painted object was not
 * drawn, the channel shown and the cursor's state.
 *
 * Browser-only (three.js); the brush's data is `session/vertex-paint-brush.ts`.
 */
import * as THREE from 'three';
import type { VertexPaintPreview } from '@thirdlight/three-adapter';
import { VERTEX_PAINT_BRUSH_LIMITS, paintPathDabs, paintVertexDabs, pathPaintPoint, strokeCoverage, type DabStroke, type PathGrid, type PaintVec3, type VertexPaintBrush } from '@thirdlight/runtime';

import { brushRadius, strokeMask, type BrushSettings, type BrushStore } from '../session/brush';
import { VERTEX_PAINT_USES, paintVerticesArgs, pathTargetAt, roundDab, strokeBrush, type PaintTarget } from '../session/vertex-paint-brush';
import type { PaintTarget as PaintChannelTarget } from '../session/vertex-paint-channels';
import type { ProjectedEntity } from '../session/projection';
import { BrushControl } from './brush-control';
import { BrushCursor } from './brush-cursor';
import type { ToolPress } from './tool-input';

export interface VertexPaintToolHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.Camera;
  canvas(): HTMLCanvasElement;
  /** The drawables under a pointer position, nearest first. */
  hits(clientX: number, clientY: number): THREE.Intersection[];
  /** The object a drawn mesh's paint belongs to (null: none). */
  ownerOf(object: THREE.Object3D): string | null;
  /** The object as synced (null: not shown, or locked). */
  entity(id: string): ProjectedEntity | null;
  /** The copy of a set a hit names (null: not one of its copies). */
  copyOf(entityId: string, hit: THREE.Intersection): number | null;
  preview(entityId: string, target: PaintTarget): VertexPaintPreview | null;
  /** Whether the object draws anything this frame (its meshes are in the scene). */
  drawn(entityId: string): boolean;
  /** Show a paint channel as grey (null: the materials). */
  channelView(channel: number | null): void;
  requestRender(): void;
}

export interface VertexPaintToolCallbacks {
  /** Store one stroke (`paintVertices` args): ok, or why not (`no_change`: it reached nothing it changes). */
  stroke(args: Record<string, unknown>): Promise<{ ok: boolean; code?: string; message?: string; found?: unknown }>;
  refused(message: string): void;
}

/** What the vertex paint editor arms the brush with. */
export interface VertexPaintArm {
  /** The object painted (only it: a press elsewhere is the view's). */
  readonly entityId: string;
  /** The shared brush's settings (the panel shows them; keys and in-view drags change them). */
  readonly store: BrushStore;
  /** What a stroke paints: the palette tile's channels. */
  readonly target: PaintChannelTarget;
  /** The object's material reads the paint (false: the cursor is grey and a press says why instead of painting). */
  readonly paintable: boolean;
  /** Why it is not paintable, said on a press (absent: the editor shows it already). */
  readonly offReason?: string;
  /** The channel the view shows as grey (null: the materials). */
  readonly view: number | null;
}

interface Stroke {
  readonly entityId: string;
  readonly target: PaintTarget;
  /** The brush as the stroke began (a key mid-stroke changes the next one). */
  readonly brush: VertexPaintBrush;
  readonly spacing: number;
  readonly dabs: PaintVec3[];
  readonly preview: VertexPaintPreview | null;
  /** The opacity's coverage and the mask, per mesh of the preview (a path has one). */
  readonly coverage: DabStroke[];
  /** A path stroke's grid as the brush left it. */
  grid: PathGrid | null;
  last: THREE.Vector3;
  previewMs: number;
}

/** The last stroke's numbers (tests and the bench read them). */
export interface VertexPaintStrokeTiming {
  entityId: string;
  target: PaintTarget['kind'];
  dabs: number;
  /** Mean ms the page spent painting and uploading one dab's preview. */
  previewMs: number;
  /** Ms from the release to the stored paint drawn in place of the preview (null: not yet). */
  latencyMs: number | null;
  /** Ms the command took to answer. */
  commandMs: number | null;
  ok: boolean | null;
  code?: string;
}

/** The smallest gap between dabs (metres): a tiny brush's spacing still lets a drag through. */
const DAB_GAP_MIN = 0.002;

export class VertexPaintTool {
  private arming: VertexPaintArm | null = null;
  private stroke: Stroke | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly cursor: BrushCursor;
  private readonly control: BrushControl;
  private unstore: (() => void) | null = null;
  private last: VertexPaintStrokeTiming | null = null;
  private strokes = 0;
  /** The object the last stroke painted, watched frame by frame until the next stroke (frames drawn, frames it was missing). */
  private watch: { id: string; frames: number; gaps: number } | null = null;
  private view: number | null = null;
  /** The face under the pointer when it last moved (the cursor lies on it). */
  private hover: THREE.Intersection | null = null;

  constructor(private readonly host: VertexPaintToolHost, private readonly cb: VertexPaintToolCallbacks) {
    this.cursor = new BrushCursor(host.overlay, 'vertex-paint-cursor');
    this.control = new BrushControl({ canvas: host.canvas(), surfaceAt: (x, y) => this.surfaceAt(x, y)?.point ?? null, ctrlChanged: () => this.refreshLook() });
  }

  armed(): boolean {
    return this.arming !== null;
  }

  /** Arm the brush on an object (null: off; a stroke in flight is dropped). */
  arm(a: VertexPaintArm | null): void {
    if (a?.entityId !== this.arming?.entityId) this.cancel();
    if (a?.store !== this.arming?.store) {
      this.unstore?.();
      // A key, a drag or the panel changed the brush: the cursor follows at once.
      this.unstore = a?.store.subscribe(() => this.refreshLook()) ?? null;
    }
    this.arming = a;
    this.control.setStore(a?.store ?? null, VERTEX_PAINT_USES);
    this.control.arm(a !== null);
    if (a === null) {
      this.cursor.hide();
      this.hover = null;
    }
    const view = a?.view ?? null;
    if (view !== this.view) {
      this.view = view;
      this.host.channelView(view);
    }
    this.refreshLook();
  }

  /** A brush key while armed (the edit mode's key map routes it here); true when taken. */
  key(e: KeyboardEvent): boolean {
    if (this.arming === null || this.stroke !== null) return false;
    return this.control.key(e);
  }

  /** A press: a stroke starts on the armed object under the pointer ('capture'); null: not the tool's (orbit, pick). */
  pointerDown(e: PointerEvent): ToolPress {
    const a = this.arming;
    if (a === null || e.button !== 0 || e.altKey) return null;
    if (this.control.press()) return 'consume';
    const at = this.targetAt(e.clientX, e.clientY);
    if (at === null) return null;
    if (!a.paintable) {
      if (a.offReason !== undefined) this.cb.refused(a.offReason);
      return 'consume';
    }
    // Ctrl held at the press inverts this stroke (the brush's invert flipped).
    this.begin(at, a.store.get().invert !== (e.ctrlKey || e.metaKey));
    return 'capture';
  }

  /** A move: the cursor follows the pointer; a stroke gains a dab every spacing on its object. */
  pointerMove(e: PointerEvent): boolean {
    if (this.arming === null) return false;
    const st = this.stroke;
    const hit = st !== null ? this.onTarget(st, e.clientX, e.clientY) : this.surfaceAt(e.clientX, e.clientY);
    if (this.control.move(e, hit?.point ?? null)) {
      this.drawCursor(this.hover);
      return true;
    }
    this.hover = hit;
    this.drawCursor(hit);
    if (st !== null && hit !== null && hit.point.distanceTo(st.last) >= st.spacing) this.addDab(hit.point);
    this.host.requestRender();
    return st !== null;
  }

  /** The release: the stroke goes out as one command (true: the press was the tool's). */
  pointerUp(e: PointerEvent): boolean {
    const st = this.stroke;
    if (st === null) return false;
    const hit = this.onTarget(st, e.clientX, e.clientY);
    if (hit !== null && hit.point.distanceTo(st.last) > 1e-3) this.addDab(hit.point);
    this.stroke = null;
    this.commit(st);
    this.drawCursor(this.hover);
    return true;
  }

  leave(): void {
    if (this.stroke !== null || !this.control.leave()) return;
    this.hover = null;
    if (!this.cursor.visible()) return;
    this.cursor.hide();
    this.host.requestRender();
  }

  /** Esc: the stroke is dropped (nothing sent, the preview taken off), or what F was dragging put back. */
  cancel(): boolean {
    if (this.control.cancel()) return true;
    const st = this.stroke;
    if (st === null) return false;
    this.stroke = null;
    void st.preview?.end(false);
    this.host.requestRender();
    return true;
  }

  /** Strokes still being answered. */
  settled(): Promise<unknown> {
    return this.pending;
  }

  /** Each drawn frame: the watched object counted, the state published for tests. */
  frame(): void {
    const canvas = this.host.canvas();
    const w = this.watch;
    if (w !== null) {
      w.frames += 1;
      if (!this.host.drawn(w.id)) w.gaps += 1;
    }
    const a = this.arming;
    if (a === null && w === null) {
      if (canvas.hasAttribute('data-vertex-paint')) canvas.removeAttribute('data-vertex-paint');
      return;
    }
    const out = { armed: a !== null, entityId: a?.entityId ?? null, channel: a?.target.channel ?? null, cursor: this.cursor.visible() ? this.cursor.state() : null, stroking: this.stroke !== null, strokes: this.strokes, last: this.last, watch: w, view: this.view };
    canvas.setAttribute('data-vertex-paint', JSON.stringify(out));
  }

  dispose(): void {
    this.cancel();
    if (this.view !== null) this.host.channelView(null);
    this.unstore?.();
    this.control.dispose();
    this.cursor.dispose();
  }

  // ---- internals

  private settings(): BrushSettings | null {
    return this.arming?.store.get() ?? null;
  }

  /** The cursor's colour, falloff ring and fill from the settings, the tile and Ctrl; laid again where it is. */
  private refreshLook(): void {
    const a = this.arming;
    const b = this.settings();
    if (a === null || b === null) {
      this.host.requestRender();
      return;
    }
    // A tile whose strokes always erase (a layered surface's base) is painted, not inverted.
    const state = !a.paintable ? 'off' : a.target.erases !== true && this.control.inverted() ? 'erase' : 'paint';
    this.cursor.setLook({ falloff: b.falloff, hardness: b.hardness, strength: b.strength, mask: strokeMask(b, VERTEX_PAINT_USES), state });
    this.drawCursor(this.hover);
  }

  private begin(at: { entityId: string; target: PaintTarget; point: THREE.Vector3 }, invert: boolean): void {
    const a = this.arming!;
    const b = a.store.get();
    const brush = strokeBrush(b, a.target, invert);
    this.stroke = this.newStroke(at.entityId, at.target, brush, Math.max(DAB_GAP_MIN, b.spacing * b.size), at.point);
    this.watch = { id: at.entityId, frames: 0, gaps: 0 };
    this.addDab(at.point);
    this.drawCursor(this.hover);
  }

  private newStroke(entityId: string, target: PaintTarget, brush: VertexPaintBrush, spacing: number, from: THREE.Vector3): Stroke {
    const preview = this.host.preview(entityId, target);
    // One coverage per mesh (a vertex's index names it within its mesh only), one for a path's grid.
    const meshes = preview?.kind === 'meshes' ? preview.meshes.length : 1;
    const coverage = Array.from({ length: meshes }, (): DabStroke => ({ ...(brush.mask !== undefined ? { mask: brush.mask } : {}), coverage: strokeCoverage(brush.opacity) }));
    return { entityId, target, brush, spacing, dabs: [], preview, coverage, grid: preview?.kind === 'path' ? preview.grid : null, last: from.clone(), previewMs: 0 };
  }

  /** What a press at the pointer paints on the armed object: its target and the point (null: the object is not there). */
  private targetAt(clientX: number, clientY: number): { entityId: string; target: PaintTarget; point: THREE.Vector3 } | null {
    const id = this.arming?.entityId;
    for (const h of this.host.hits(clientX, clientY)) {
      if ((h.object as THREE.Mesh).isMesh !== true) continue;
      // Something else in front (the rest of the scene drawn with Context): the press is the view's.
      if (this.host.ownerOf(h.object) !== id) return null;
      const e = this.host.entity(id);
      if (e === null) return null;
      const c = e.components;
      if (c['instances'] !== undefined) {
        const copy = this.host.copyOf(id, h);
        return copy === null ? null : { entityId: id, target: { kind: 'copy', copy }, point: h.point.clone() };
      }
      if (c['model'] !== undefined) return { entityId: id, target: { kind: 'model' }, point: h.point.clone() };
      if (c['architecture'] !== undefined || c['spline'] !== undefined) {
        const n = this.normalOf(h);
        const local = pathPaintPoint(e.position, [h.point.x, h.point.y, h.point.z]);
        const path = pathTargetAt(c as Parameters<typeof pathTargetAt>[0], local, n === null ? [0, 1, 0] : [n.x, n.y, n.z]);
        return path === null ? null : { entityId: id, target: { kind: 'path', ...path }, point: h.point.clone() };
      }
      return null;
    }
    return null;
  }

  /** Where the pointer meets the stroke's object (its copy, for a set), or null. */
  private onTarget(st: Stroke, clientX: number, clientY: number): THREE.Intersection | null {
    for (const h of this.host.hits(clientX, clientY)) {
      if ((h.object as THREE.Mesh).isMesh !== true || this.host.ownerOf(h.object) !== st.entityId) continue;
      if (st.target.kind === 'copy' && this.host.copyOf(st.entityId, h) !== st.target.copy) continue;
      return h;
    }
    return null;
  }

  /** The armed object's face under the pointer (null: it is not there). */
  private surfaceAt(clientX: number, clientY: number): THREE.Intersection | null {
    const id = this.arming?.entityId;
    for (const h of this.host.hits(clientX, clientY)) if ((h.object as THREE.Mesh).isMesh === true) return this.host.ownerOf(h.object) === id ? h : null;
    return null;
  }

  /** A hit's face normal in the world (instanced copies through their own matrix), turned to face the camera. */
  private normalOf(h: THREE.Intersection): THREE.Vector3 | null {
    if (h.face === undefined || h.face === null) return null;
    const m = h.object.matrixWorld.clone();
    if (h.instanceId !== undefined && (h.object as THREE.InstancedMesh).isInstancedMesh === true) {
      const inst = new THREE.Matrix4();
      (h.object as THREE.InstancedMesh).getMatrixAt(h.instanceId, inst);
      m.multiply(inst);
    }
    const n = h.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m)).normalize();
    const toCamera = new THREE.Vector3().setFromMatrixPosition(this.host.camera.matrixWorld).sub(h.point);
    if (n.dot(toCamera) < 0) n.negate();
    return n;
  }

  /** The brush laid flat on the face under the pointer (hidden off the object). */
  private drawCursor(hit: THREE.Intersection | null): void {
    const b = this.settings();
    if (hit === null || b === null) {
      if (this.cursor.visible()) this.cursor.hide();
      this.host.requestRender();
      return;
    }
    const normal = this.normalOf(hit) ?? new THREE.Vector3(0, 1, 0);
    const r = brushRadius(b);
    this.cursor.place({ centre: hit.point, rx: r, rz: r, normal, fill: this.stroke === null });
    this.host.requestRender();
  }

  private addDab(p: THREE.Vector3): void {
    const st = this.stroke!;
    if (st.dabs.length >= VERTEX_PAINT_BRUSH_LIMITS.dabs) {
      // Past what one command carries: this stroke is sent and the drag goes on as the next, from here (its own opacity, as the backend's).
      this.stroke = null;
      this.commit(st);
      this.stroke = this.newStroke(st.entityId, st.target, st.brush, st.spacing, p);
    }
    const cur = this.stroke!;
    const dab = roundDab([p.x, p.y, p.z]);
    cur.dabs.push(dab);
    cur.last.copy(p);
    const t0 = performance.now();
    const pv = cur.preview;
    if (pv?.kind === 'meshes') {
      let changed = 0;
      pv.meshes.forEach((m, i) => (changed += paintVertexDabs(m.points, m.values, [dab], cur.brush, cur.coverage[i])));
      if (changed > 0) pv.show();
    } else if (pv?.kind === 'path') {
      const local = pathPaintPoint(pv.origin, dab);
      const t = cur.target as Extract<PaintTarget, { kind: 'path' }>;
      const r = paintPathDabs(cur.grid, pv.frame, t.side, [local], cur.brush, cur.coverage[0]);
      if (r.changed > 0) {
        cur.grid = r.grid;
        pv.show(r.grid);
      }
    }
    cur.previewMs += performance.now() - t0;
    this.host.requestRender();
  }

  private commit(st: Stroke): void {
    if (st.dabs.length === 0) {
      void st.preview?.end(false);
      return;
    }
    this.strokes += 1;
    const released = performance.now();
    const timing: VertexPaintStrokeTiming = { entityId: st.entityId, target: st.target.kind, dabs: st.dabs.length, previewMs: Math.round((st.previewMs / st.dabs.length) * 1000) / 1000, latencyMs: null, commandMs: null, ok: null };
    this.last = timing;
    // Drawn until the stored stroke replaces it (the object never shows less in between).
    const gone = st.preview?.end(true);
    if (gone !== undefined) {
      void gone.then(() =>
        requestAnimationFrame(() => {
          if (timing.ok !== false) timing.latencyMs = Math.round(performance.now() - released);
          this.host.requestRender();
        }),
      );
    }
    const args = paintVerticesArgs(st.entityId, st.target, st.dabs, st.brush);
    // Strokes go out in order (each paints over the one before).
    this.pending = this.pending.then(async () => {
      const r = await this.cb.stroke(args).catch((e: unknown) => ({ ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e) }));
      timing.commandMs = Math.round(performance.now() - released);
      timing.ok = r.ok;
      if (!r.ok) {
        if (r.code !== undefined) timing.code = r.code;
        void st.preview?.end(false);
        if (r.code !== 'no_change') this.cb.refused(r.message ?? 'the stroke was refused');
      }
      this.host.requestRender();
    });
  }
}
