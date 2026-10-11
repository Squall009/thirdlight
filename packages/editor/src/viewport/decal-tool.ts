/**
 * The Scene view's Decal tool: click a surface to place a decal facing out
 * of it, Shift+click to stamp more (each with a seeded random turn and
 * size), and turn or scale the selected decal with its two grips.
 *
 * - The decal under the pointer is drawn as it would be placed (projected or
 *   clipped, with its material), through the same adapter path as a stored
 *   decal: it is one object drawn besides the project's, moved as the
 *   pointer moves. A clipped preview takes an empty result as final at once
 *   (the surfaces it moves over are all there).
 * - A click (no drag: a drag orbits) places ONE `createEntity` with the decal
 *   component — one undo step, the command MCP sends for a decal too.
 * - The selected decal shows a ring about its normal with a turn knob and a
 *   corner grip. Dragging the knob turns it about the normal (one
 *   `setTransform` on release); dragging the corner scales its width and
 *   height (one `setComponent`). Both preview while dragging; Esc drops it.
 *
 * Browser-only (three.js); the placement maths is `session/decal-place.ts`.
 */
import * as THREE from 'three';
import type { DecalComponent } from '@thirdlight/project-model';
import { isDecalMark } from '@thirdlight/three-adapter';

import { decalPlaceCommand, decalPlacement, turnAboutNormal, type DecalToolSettings } from '../session/decal-place';
import type { ProjectedEntity } from '../session/projection';
import { ringGeometry, ringLine } from './helper-shapes';

/** The preview's object id: never a stored id (a NUL lead, as the generators' own objects have). */
export const DECAL_PREVIEW_ID = '\u0000decal-tool-preview';
/** How near (px) the pointer must be to a grip to take it. */
const GRIP_REACH_PX = 12;
/** A turn drag with snapping on moves in steps of this many degrees. */
const TURN_SNAP_DEG = 15;
const RING_COLOR = 0xffc857;

type V3 = [number, number, number];
type Trs = { position: number[]; rotation: number[]; scale: number[] };

export interface DecalToolHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  canvas(): HTMLCanvasElement;
  /** The surface under a pointer position (world point and the normal facing the camera), decals and the preview left out. */
  surfaceAt(clientX: number, clientY: number): { point: V3; normal: V3 } | null;
  /** Draw this object besides the project's (null: none). */
  setPreview(e: ProjectedEntity | null): void;
  /** Draw an entity at this local transform without storing it (null: as stored). */
  previewTransform(id: string, t: Trs | null): void;
  /** Draw an entity's decal as given without storing it (null: as stored). */
  previewDecal(id: string, decal: DecalComponent | null): void;
  worldOf(id: string): THREE.Matrix4 | null;
  /** The clipped mesh drawn for an object now (null: none yet). */
  clippedMesh(id: string): THREE.Mesh | null;
  snapping(): boolean;
  requestRender(): void;
}

export interface DecalToolCallbacks {
  /** Store a new decal (`createEntity` args); resolves its id (null: refused). */
  place(args: Record<string, unknown>): Promise<string | null>;
  /** Store a decal's turned transform (one `setTransform`). */
  turn(entityId: string, transform: Trs): Promise<boolean>;
  /** Store a decal's new size (one `setComponent`). */
  resize(entityId: string, decal: DecalComponent): Promise<boolean>;
  refused(message: string): void;
}

interface Target {
  id: string;
  trs: Trs;
  decal: DecalComponent;
}

interface Drag {
  kind: 'turn' | 'size';
  target: Target;
  /** The decal's centre and axes (world) when the drag began. */
  centre: THREE.Vector3;
  x: THREE.Vector3;
  y: THREE.Vector3;
  plane: THREE.Plane;
  start: { angle: number; dist: number };
  now: Trs | DecalComponent | null;
}

/**
 * The first surface among a ray's hits (nearest first) a decal is placed on, and its normal turned to face
 * the ray: decals' own marks and the preview are passed over (a decal is placed on the surface under them).
 * A hit with no triangle (terrain answers from its heights) asks `heightNormal` for the ground's normal.
 */
export function decalSurfaceOf(hits: readonly THREE.Intersection[], ray: THREE.Ray, owner: (o: THREE.Object3D) => string | null, heightNormal: (entityId: string, x: number, z: number) => readonly number[] | null): { point: V3; normal: V3 } | null {
  for (const h of hits) {
    const o = h.object as THREE.Mesh;
    if (o.isMesh !== true || isDecalMark(o)) continue;
    const id = owner(o);
    if (id === DECAL_PREVIEW_ID) continue;
    const n = new THREE.Vector3();
    if (h.face !== undefined && h.face !== null) {
      // The face's normal in the world: through the copy's own matrix for instanced and batched draws.
      const m = o.matrixWorld.clone();
      const inst = new THREE.Matrix4();
      if (h.instanceId !== undefined && (o as unknown as THREE.InstancedMesh).isInstancedMesh === true) m.multiply(((o as unknown as THREE.InstancedMesh).getMatrixAt(h.instanceId, inst), inst));
      else if (h.batchId !== undefined && (o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh === true) m.multiply(((o as unknown as THREE.BatchedMesh).getMatrixAt(h.batchId, inst), inst));
      n.copy(h.face.normal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m));
    } else {
      const g = id === null ? null : heightNormal(id, h.point.x, h.point.z);
      n.set(g?.[0] ?? 0, g?.[1] ?? 1, g?.[2] ?? 0);
    }
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    if (n.dot(ray.direction) > 0) n.negate();
    return { point: [h.point.x, h.point.y, h.point.z], normal: [n.x, n.y, n.z] };
  }
  return null;
}

export class DecalTool {
  private settings: DecalToolSettings | null = null;
  private sceneId: string | null = null;
  /** Stamps placed since the tool was armed or its seed changed (the next stamp's number). */
  private stamps = 0;
  private seed: number | null = null;
  private preview: { position: number[]; rotation: number[]; decal: DecalComponent } | null = null;
  private target: Target | null = null;
  private drag: Drag | null = null;
  private press: { x: number; y: number } | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly group = new THREE.Group();
  private readonly ring: THREE.Line;
  private readonly knob: THREE.Mesh;
  private readonly corner: THREE.Mesh;
  private placed = 0;
  /** Where the turn knob and the size corner are in the world (what a press is tested against). */
  private readonly gripWorld = { turn: new THREE.Vector3(), size: new THREE.Vector3() };

  constructor(private readonly host: DecalToolHost, private readonly cb: DecalToolCallbacks) {
    const lineMat = new THREE.LineBasicMaterial({ color: RING_COLOR, depthTest: false, transparent: true });
    this.ring = ringLine(ringGeometry('xy', 64), lineMat);
    const gripMat = new THREE.MeshBasicMaterial({ color: RING_COLOR, depthTest: false, transparent: true });
    this.knob = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), gripMat);
    this.corner = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), gripMat);
    for (const o of [this.ring, this.knob, this.corner]) {
      o.renderOrder = 14;
      o.raycast = () => undefined;
      o.frustumCulled = false;
      this.group.add(o);
    }
    this.group.name = 'decal-tool';
    this.group.visible = false;
    host.overlay.add(this.group);
  }

  armed(): boolean {
    return this.settings !== null;
  }

  /** Arm the tool with these settings for `sceneId` (null: off). */
  arm(settings: DecalToolSettings | null, sceneId: string | null): void {
    const was = this.settings;
    this.settings = settings;
    this.sceneId = sceneId;
    if (settings === null || was === null || settings.stamp.seed !== this.seed) this.stamps = 0;
    this.seed = settings?.stamp.seed ?? null;
    if (settings === null) {
      this.cancel();
      this.showPreview(null);
    }
    this.placeGrips();
  }

  /** The selected object (its decal gets the grips while the tool is armed). */
  setTarget(e: ProjectedEntity | null): void {
    const decal = e?.components['decal'] as DecalComponent | undefined;
    this.target = e === null || decal === undefined ? null : { id: e.id, trs: { position: [...e.position], rotation: [...e.rotation], scale: [...e.scale] }, decal };
    if (this.drag !== null && this.drag.target.id !== this.target?.id) this.cancel();
    this.placeGrips();
  }

  pointerDown(e: PointerEvent): boolean {
    if (this.settings === null || e.button !== 0) return false;
    this.press = { x: e.clientX, y: e.clientY };
    const grip = this.gripAt(e.clientX, e.clientY);
    if (grip === null || this.target === null) return false;
    const world = this.host.worldOf(this.target.id);
    if (world === null) return false;
    const centre = new THREE.Vector3().setFromMatrixPosition(world);
    const x = new THREE.Vector3().setFromMatrixColumn(world, 0).normalize();
    const y = new THREE.Vector3().setFromMatrixColumn(world, 1).normalize();
    const n = new THREE.Vector3().setFromMatrixColumn(world, 2).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, centre);
    const drag: Drag = { kind: grip, target: this.target, centre, x, y, plane, start: { angle: 0, dist: 0 }, now: null };
    const p = this.onPlane(drag, e.clientX, e.clientY);
    if (p === null) return false;
    drag.start = { angle: Math.atan2(p.dot(y), p.dot(x)), dist: Math.max(1e-6, p.length()) };
    this.drag = drag;
    this.press = null;
    return true;
  }

  /** A move: a grip drag previews; otherwise the decal under the pointer follows it. True while a drag owns the pointer. */
  pointerMove(e: PointerEvent): boolean {
    if (this.settings === null) return false;
    const d = this.drag;
    if (d !== null) {
      const p = this.onPlane(d, e.clientX, e.clientY);
      if (p === null) return true;
      if (d.kind === 'turn') {
        let deg = ((Math.atan2(p.dot(d.y), p.dot(d.x)) - d.start.angle) * 180) / Math.PI;
        if (this.host.snapping()) deg = Math.round(deg / TURN_SNAP_DEG) * TURN_SNAP_DEG;
        const t = { ...d.target.trs, rotation: turnAboutNormal(d.target.trs.rotation, deg) };
        d.now = t;
        this.host.previewTransform(d.target.id, t);
      } else {
        const k = p.length() / d.start.dist;
        const s = d.target.decal.size;
        const mm = (v: number): number => Math.max(0.01, Math.round(v * 1000) / 1000);
        const decal: DecalComponent = { ...d.target.decal, size: [mm(s[0] * k), mm(s[1] * k), s[2]] };
        d.now = decal;
        this.host.previewDecal(d.target.id, decal);
      }
      this.placeGrips(d.now);
      this.host.requestRender();
      return true;
    }
    if (e.buttons !== 0) return false;
    this.hover(e.clientX, e.clientY, e.shiftKey);
    return false;
  }

  /**
   * A release: ends a grip drag (stored: 'drag', its press was the tool's alone), or a click places (Shift: a
   * stamp; 'click': the press also went to the orbit controls, which must see its release). null: not the tool's.
   */
  pointerUp(e: PointerEvent, slopPx: number): 'drag' | 'click' | null {
    if (this.settings === null || e.button !== 0) return null;
    const d = this.drag;
    if (d !== null) {
      this.drag = null;
      this.commit(d);
      return 'drag';
    }
    const press = this.press;
    this.press = null;
    if (press === null || Math.hypot(e.clientX - press.x, e.clientY - press.y) > slopPx) return null;
    this.place(e.clientX, e.clientY, e.shiftKey);
    return 'click';
  }

  /** The pointer left the view: no decal under it. */
  leave(): void {
    if (this.drag === null) this.showPreview(null);
  }

  /** Drop a grip drag in flight (nothing stored); true when there was one. */
  cancel(): boolean {
    const d = this.drag;
    if (d === null) return false;
    this.drag = null;
    if (d.kind === 'turn') this.host.previewTransform(d.target.id, null);
    else this.host.previewDecal(d.target.id, null);
    this.placeGrips();
    this.host.requestRender();
    return true;
  }

  /** Before a frame: grips keep their screen size; the tool's state for tests (`data-decal-tool`). */
  frame(): void {
    const canvas = this.host.canvas();
    if (this.settings === null) {
      if (canvas.hasAttribute('data-decal-tool')) canvas.removeAttribute('data-decal-tool');
      return;
    }
    // The object's world matrix is the adapter's as of this frame (a new decal's is placed after its first sync).
    this.placeGrips(this.drag?.now ?? null);
    const cam = this.host.camera;
    const k = Math.tan((cam.fov * Math.PI) / 360) * 0.016;
    for (const g of [this.knob, this.corner]) {
      g.updateMatrixWorld();
      const at = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
      const parentScale = new THREE.Vector3().setFromMatrixScale(this.group.matrixWorld);
      g.scale.setScalar(Math.max(0.01, at.distanceTo(cam.position) * k) / Math.max(1e-6, parentScale.x));
    }
    const grips = this.group.visible ? { turn: this.clientAt(this.gripWorld.turn), size: this.clientAt(this.gripWorld.size) } : null;
    canvas.setAttribute('data-decal-tool', JSON.stringify({ preview: this.preview, target: this.target?.id ?? null, grips, stamps: this.stamps, placed: this.placed, clippedPreview: this.preview !== null && this.host.clippedMesh(DECAL_PREVIEW_ID) !== null }));
  }

  dispose(): void {
    this.showPreview(null);
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }

  // ---- internals

  private hover(clientX: number, clientY: number, stamp: boolean): void {
    const s = this.settings!;
    const hit = s.material === null ? null : this.host.surfaceAt(clientX, clientY);
    if (hit === null) return this.showPreview(null);
    this.showPreview(decalPlacement(s, s.material!, hit.point, hit.normal, stamp ? this.stamps : null));
  }

  private showPreview(p: { position: number[]; rotation: number[]; decal: DecalComponent } | null): void {
    if (p === null && this.preview === null) return;
    this.preview = p;
    this.host.setPreview(
      p === null
        ? null
        : { id: DECAL_PREVIEW_ID, name: 'Decal (preview)', parentId: null, kind: 'entity', active: true, visible: true, locked: false, static: false, keepLoaded: false, tags: 0, position: p.position, rotation: p.rotation, scale: [1, 1, 1], ...(this.sceneId !== null ? { sceneId: this.sceneId } : {}), components: { decal: p.decal } },
    );
    this.host.requestRender();
  }

  private place(clientX: number, clientY: number, stamp: boolean): void {
    const s = this.settings!;
    if (s.material === null) return this.cb.refused('Choose a decal to place first.');
    const hit = this.host.surfaceAt(clientX, clientY);
    if (hit === null) return this.cb.refused('No surface under the pointer to place the decal on.');
    const p = decalPlacement(s, s.material, hit.point, hit.normal, stamp ? this.stamps : null);
    if (stamp) this.stamps += 1;
    this.placed += 1;
    void this.cb.place(decalPlaceCommand(this.sceneId, 'Decal', p).args);
    // The next stamp's look under the pointer.
    this.hover(clientX, clientY, stamp);
  }

  private commit(d: Drag): void {
    const now = d.now;
    const restore = (): void => {
      if (d.kind === 'turn') this.host.previewTransform(d.target.id, null);
      else this.host.previewDecal(d.target.id, null);
      this.host.requestRender();
    };
    if (now === null) return restore();
    const stored = d.kind === 'turn' ? this.cb.turn(d.target.id, now as Trs) : this.cb.resize(d.target.id, now as DecalComponent);
    // The stored value arrives with the projection; the preview stands until then (none, if refused).
    void stored.then(restore, restore);
  }

  /** The pointer's point on the drag's plane, relative to the decal's centre. */
  private onPlane(d: Drag, clientX: number, clientY: number): THREE.Vector3 | null {
    this.aim(clientX, clientY);
    const p = this.ray.ray.intersectPlane(d.plane, new THREE.Vector3());
    return p === null ? null : p.sub(d.centre);
  }

  private aim(clientX: number, clientY: number): void {
    const r = this.host.canvas().getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.host.camera);
  }

  private gripAt(clientX: number, clientY: number): 'turn' | 'size' | null {
    this.placeGrips();
    if (!this.group.visible) return null;
    let best: ['turn' | 'size', number] | null = null;
    for (const kind of ['turn', 'size'] as const) {
      const c = this.clientAt(this.gripWorld[kind]);
      if (c === null) continue;
      const dist = Math.hypot(c.x - clientX, c.y - clientY);
      if (dist <= GRIP_REACH_PX && (best === null || dist < best[1])) best = [kind, dist];
    }
    return best?.[0] ?? null;
  }

  /** A world point on the page (client coordinates; null: behind the camera). */
  private clientAt(p: THREE.Vector3): { x: number; y: number } | null {
    const r = this.host.canvas().getBoundingClientRect();
    if (r.width === 0) return null;
    this.host.camera.updateMatrixWorld();
    const v = p.clone().project(this.host.camera);
    if (v.z > 1) return null;
    return { x: Math.round(r.left + ((v.x + 1) / 2) * r.width), y: Math.round(r.top + ((1 - v.y) / 2) * r.height) };
  }

  /** The ring and grips around the selected decal (as `now` while a drag previews it). */
  private placeGrips(now?: Trs | DecalComponent | null): void {
    const t = this.target;
    const world = t === null || this.settings === null ? null : this.host.worldOf(t.id);
    this.group.visible = world !== null;
    if (world === null || t === null) return;
    const m = world.clone();
    let size = t.decal.size;
    if (now !== undefined && now !== null) {
      if ('rotation' in now) {
        // The world frame turned as the preview turns it (about the decal's own Z).
        const q = new THREE.Quaternion(...(now.rotation as [number, number, number, number]));
        const q0 = new THREE.Quaternion(...(t.trs.rotation as [number, number, number, number]));
        m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q0.invert().multiply(q)));
      } else size = now.size;
    }
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(m);
    this.group.updateMatrixWorld(true);
    const [w, h] = [size[0] ?? 1, size[1] ?? 1];
    const r = 0.55 * Math.hypot(w, h);
    this.ring.scale.set(r, r, 1);
    this.knob.position.set(0, r, 0);
    this.corner.position.set(w / 2, h / 2, 0);
    this.gripWorld.turn.set(0, r, 0).applyMatrix4(m);
    this.gripWorld.size.set(w / 2, h / 2, 0).applyMatrix4(m);
  }
}
