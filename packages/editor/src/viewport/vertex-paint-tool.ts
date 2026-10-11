/**
 * The Scene view's vertex paint mode: while its window is open, a left drag
 * on a placed model, a copy of an instance set, generated architecture or a
 * spline paints that object's vertices with the shared brush; Alt+drag (or
 * the right button) still orbits.
 *
 * - A press fixes what the stroke paints: the object under the pointer (a
 *   set's copy under it; a generated object's nearest path and the side its
 *   face looks to). Each move adds a dab where the pointer meets that object,
 *   a quarter radius from the last.
 * - Each dab is painted at once on the page (the adapter's preview: the
 *   object's paint bytes rewritten and drawn by the GPU in the same frame),
 *   with the functions the backend paints with.
 * - The release sends the stroke as ONE `paintVertices` (one undo). The
 *   preview stays drawn until the stored paint replaces it, so the object
 *   never blinks; a refused stroke takes it off at once and says why.
 * - A stroke that would pass the dabs one command carries is sent there and
 *   the drag goes on as the next stroke.
 * - The ring shows the brush on the surface under the pointer.
 *
 * Tests read `data-vertex-paint`: the target, the last stroke's dabs, its
 * preview cost a dab and its latency (release → stored paint drawn), and the
 * frames since the stroke in which the painted object was not drawn.
 *
 * Browser-only (three.js); the brush's data is `session/vertex-paint-brush.ts`.
 */
import * as THREE from 'three';
import type { VertexPaintPreview } from '@thirdlight/three-adapter';
import { VERTEX_PAINT_BRUSH_LIMITS, paintPathDabs, paintVertexDabs, pathPaintPoint, type PathGrid, type PaintVec3 } from '@thirdlight/runtime';

import { DAB_STEP, paintVerticesArgs, pathTargetAt, roundDab, strokeBrush, type PaintTarget, type VertexPaintSettings } from '../session/vertex-paint-brush';
import type { ProjectedEntity } from '../session/projection';
import { ringGeometry, ringLine } from './helper-shapes';

const RING_PAINT = 0x7fd0ff;
const RING_ERASE = 0xff7a6a;

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

interface Stroke {
  readonly entityId: string;
  readonly target: PaintTarget;
  readonly settings: VertexPaintSettings;
  readonly dabs: PaintVec3[];
  readonly preview: VertexPaintPreview | null;
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

export class VertexPaintTool {
  private settings: VertexPaintSettings | null = null;
  private stroke: Stroke | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly ring: THREE.Line;
  private readonly ringMaterial = new THREE.LineBasicMaterial({ color: RING_PAINT, depthTest: false, transparent: true, opacity: 0.9 });
  private last: VertexPaintStrokeTiming | null = null;
  private strokes = 0;
  /** The object the last stroke painted, watched frame by frame until the next stroke (frames drawn, frames it was missing). */
  private watch: { id: string; frames: number; gaps: number } | null = null;
  private view: number | null = null;

  constructor(private readonly host: VertexPaintToolHost, private readonly cb: VertexPaintToolCallbacks) {
    this.ring = ringLine(ringGeometry('xy'), this.ringMaterial);
    this.ring.name = 'vertex-paint-ring';
    this.ring.renderOrder = 12;
    this.ring.visible = false;
    host.overlay.add(this.ring);
  }

  armed(): boolean {
    return this.settings !== null;
  }

  /** Arm the tool with these settings (null: off; a stroke in flight is dropped). */
  arm(settings: VertexPaintSettings | null): void {
    this.settings = settings;
    if (settings === null) {
      this.cancel();
      this.ring.visible = false;
    } else this.ringMaterial.color.set(settings.erase ? RING_ERASE : RING_PAINT);
    const view = settings?.view ?? null;
    if (view !== this.view) {
      this.view = view;
      this.host.channelView(view);
    }
    this.host.requestRender();
  }

  /** A press: a stroke starts on the object under the pointer (false: none to paint there; the press is someone else's). */
  pointerDown(e: PointerEvent): boolean {
    const s = this.settings;
    if (s === null || e.button !== 0 || e.altKey) return false;
    const at = this.targetAt(e.clientX, e.clientY);
    if (at === null) return false;
    const preview = this.host.preview(at.entityId, at.target);
    this.stroke = { entityId: at.entityId, target: at.target, settings: s, dabs: [], preview, grid: preview?.kind === 'path' ? preview.grid : null, last: at.point.clone(), previewMs: 0 };
    this.watch = { id: at.entityId, frames: 0, gaps: 0 };
    this.addDab(at.point);
    return true;
  }

  /** A move: the ring follows the pointer; a stroke gains a dab every quarter radius on its object. */
  pointerMove(e: PointerEvent): boolean {
    const s = this.settings;
    if (s === null) return false;
    const st = this.stroke;
    const hit = st !== null ? this.onTarget(st, e.clientX, e.clientY) : this.surfaceAt(e.clientX, e.clientY);
    this.showRing(hit, s);
    if (st !== null && hit !== null && hit.point.distanceTo(st.last) >= st.settings.radius * DAB_STEP) this.addDab(hit.point);
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
    return true;
  }

  leave(): void {
    if (!this.ring.visible) return;
    this.ring.visible = false;
    this.host.requestRender();
  }

  /** Esc: the stroke is dropped (nothing sent, the preview taken off). */
  cancel(): boolean {
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
    if (this.settings === null && w === null) {
      if (canvas.hasAttribute('data-vertex-paint')) canvas.removeAttribute('data-vertex-paint');
      return;
    }
    canvas.setAttribute('data-vertex-paint', JSON.stringify({ armed: this.settings !== null, stroking: this.stroke !== null, strokes: this.strokes, last: this.last, watch: w, view: this.view }));
  }

  dispose(): void {
    this.cancel();
    if (this.view !== null) this.host.channelView(null);
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    this.ringMaterial.dispose();
  }

  // ---- internals

  /** What a press at the pointer paints: the object, its target, and the point (null: nothing paintable there). */
  private targetAt(clientX: number, clientY: number): { entityId: string; target: PaintTarget; point: THREE.Vector3 } | null {
    for (const h of this.host.hits(clientX, clientY)) {
      if ((h.object as THREE.Mesh).isMesh !== true) continue;
      const id = this.host.ownerOf(h.object);
      const e = id === null ? null : this.host.entity(id);
      if (id === null || e === null) continue;
      const c = e.components;
      if (c['instances'] !== undefined) {
        const copy = this.host.copyOf(id, h);
        if (copy === null) continue;
        return { entityId: id, target: { kind: 'copy', copy }, point: h.point.clone() };
      }
      if (c['model'] !== undefined) return { entityId: id, target: { kind: 'model' }, point: h.point.clone() };
      if (c['architecture'] !== undefined || c['spline'] !== undefined) {
        const n = this.normalOf(h);
        const local = pathPaintPoint(e.position, [h.point.x, h.point.y, h.point.z]);
        const path = pathTargetAt(c as Parameters<typeof pathTargetAt>[0], local, n === null ? [0, 1, 0] : [n.x, n.y, n.z]);
        if (path === null) continue;
        return { entityId: id, target: { kind: 'path', ...path }, point: h.point.clone() };
      }
      // Something else is in front (a box, a block layer, terrain): the press orbits or picks as usual.
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

  private surfaceAt(clientX: number, clientY: number): THREE.Intersection | null {
    for (const h of this.host.hits(clientX, clientY)) if ((h.object as THREE.Mesh).isMesh === true) return h;
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

  private showRing(hit: THREE.Intersection | null, s: VertexPaintSettings): void {
    this.ring.visible = hit !== null;
    if (hit === null) return;
    const n = this.normalOf(hit) ?? new THREE.Vector3(0, 1, 0);
    this.ring.position.copy(hit.point).addScaledVector(n, 0.01);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.ring.scale.setScalar(s.radius);
    this.ring.updateMatrixWorld();
  }

  private addDab(p: THREE.Vector3): void {
    const st = this.stroke!;
    if (st.dabs.length >= VERTEX_PAINT_BRUSH_LIMITS.dabs) {
      // Past what one command carries: this stroke is sent and the drag goes on as the next, from here.
      this.stroke = null;
      this.commit(st);
      const preview = this.host.preview(st.entityId, st.target);
      this.stroke = { ...st, dabs: [], preview, grid: preview?.kind === 'path' ? preview.grid : null, previewMs: 0 };
    }
    const cur = this.stroke!;
    const dab = roundDab([p.x, p.y, p.z]);
    cur.dabs.push(dab);
    cur.last.copy(p);
    const t0 = performance.now();
    const brush = strokeBrush(cur.settings);
    const pv = cur.preview;
    if (pv?.kind === 'meshes') {
      let changed = 0;
      for (const m of pv.meshes) changed += paintVertexDabs(m.points, m.values, [dab], brush);
      if (changed > 0) pv.show();
    } else if (pv?.kind === 'path') {
      const local = pathPaintPoint(pv.origin, dab);
      const t = cur.target as Extract<PaintTarget, { kind: 'path' }>;
      const r = paintPathDabs(cur.grid, pv.frame, t.side, [local], brush);
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
    const args = paintVerticesArgs(st.entityId, st.target, st.dabs, strokeBrush(st.settings));
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
