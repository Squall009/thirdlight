/**
 * Culling inside one draw: the members of an instanced batch, the copies of
 * an instance-set chunk and the objects merged into a static cell are tested
 * against the view one by one, and only those in view are drawn by the view's
 * pass.
 *
 * three culls a whole object by its bounding sphere, so a batch or a merged
 * cell that is partly on screen draws all of its content: in the village class
 * the automatic batches drew 108k triangles a frame of which 26k were in view
 * (their members are spread over the scene), and `?batching=off` was faster on
 * a GPU-bound frame.
 *
 * One draw serves several passes in a frame (the view, the shadow maps, a
 * probe), and the buffers it reads are written once per frame for all of them.
 * So nothing is removed from the draw's data: its content is put in an order
 * where what the view sees comes first (instance matrices, or a merged cell's
 * index), and the draw's count is chosen per pass right before it is drawn
 * (`onBeforeRender`): the view's camera draws the leading part, every other
 * camera (a shadow map, which needs off-screen casters too) draws all of it.
 * A draw is put in order again only when what is in view changed, so a still
 * camera writes nothing.
 *
 * The view is the camera the host draws the frame with; a camera that is not
 * it, or the same one moved since it was culled, draws everything (never too
 * little).
 */
import * as THREE from 'three';

import type { BatchMembership } from './batching';

/**
 * `camera.userData[STATIC_SHADOW_CAMERA_KEY]`: the camera of a cached static
 * shadow map. It is drawn rarely and kept, so what it draws must not depend on
 * the view: an instance set draws every copy at its most detailed level there.
 */
export const STATIC_SHADOW_CAMERA_KEY = '__tlStaticShadowCamera';

/** `object.userData[VIEW_CULL_KEY]`: the drawable culls inside its draw ({@link ViewCullable}). */
export const VIEW_CULL_KEY = '__tlViewCull';

/** A draw whose content is culled one item at a time. */
export interface ViewCullable {
  /** Bring the draw's order and in-view count up to date for `view` (nothing to do when neither changed); true when it was put in order again. */
  cull(view: CullView): boolean;
  /**
   * Culled through this one instead of on its own (an instance-set chunk culls its draws: one check a frame for
   * all of them while neither the view nor the chunk changed).
   */
  readonly group?: ViewCullable;
}

/** Where a sphere stands against the view: outside, crossing a plane, or wholly inside. */
export const SphereSide = { Outside: 0, Crossing: 1, Inside: 2 } as const;
export type SphereSide = (typeof SphereSide)[keyof typeof SphereSide];

/** Relative difference of a camera matrix entry below which the view counts as unchanged (far below a texel). */
const VIEW_SAME_TOLERANCE = 1e-9;

const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

/** The view a frame is culled for: its camera, frustum planes and a stamp that changes with it. */
export class CullView {
  camera: THREE.Camera | null = null;
  /** Changes whenever the view changes (a draw culled at another stamp is out of date). */
  stamp = 0;
  /** The frustum's six planes (normal xyz, constant), pointing inwards. */
  private readonly planes = new Float64Array(24);
  /** The camera's matrices as culled (view and projection). */
  private readonly snap = new Float64Array(32);
  /** The camera's world position and zoom as culled (levels of detail are picked from them). */
  readonly eye = new Float64Array(3);
  zoom = 1;

  /** The frame's view is `camera` as it is now; true when that changed what is in view. */
  set(camera: THREE.Camera): boolean {
    if (camera === this.camera && this.same(camera)) return false;
    this.camera = camera;
    this.snap.set(camera.matrixWorldInverse.elements, 0);
    this.snap.set(camera.projectionMatrix.elements, 16);
    const w = camera.matrixWorld.elements;
    this.eye[0] = w[12]!;
    this.eye[1] = w[13]!;
    this.eye[2] = w[14]!;
    this.zoom = (camera as THREE.PerspectiveCamera).zoom ?? 1;
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const c = camera as THREE.Camera & { reversedDepth?: boolean };
    _frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem, c.reversedDepth === true);
    for (let i = 0; i < 6; i += 1) {
      const p = _frustum.planes[i]!;
      this.planes[i * 4] = p.normal.x;
      this.planes[i * 4 + 1] = p.normal.y;
      this.planes[i * 4 + 2] = p.normal.z;
      this.planes[i * 4 + 3] = p.constant;
    }
    this.stamp += 1;
    return true;
  }

  /** No view: every draw draws all of its content. */
  clear(): void {
    if (this.camera === null) return;
    this.camera = null;
    this.stamp += 1;
  }

  /** Whether `camera`, as it is now, is the view the draws were culled for. */
  is(camera: THREE.Camera): boolean {
    return camera === this.camera && this.same(camera);
  }

  /**
   * The same view as culled, within {@link VIEW_SAME_TOLERANCE}: a camera blended between two equal steps
   * comes out a rounding error apart every other frame (seen: 6e-17 on the village class's still camera), which
   * must not cull everything again.
   */
  private same(camera: THREE.Camera): boolean {
    const v = camera.matrixWorldInverse.elements;
    const p = camera.projectionMatrix.elements;
    const s = this.snap;
    for (let k = 0; k < 16; k += 1) {
      if (Math.abs(s[k]! - v[k]!) > VIEW_SAME_TOLERANCE * (1 + Math.abs(v[k]!))) return false;
      if (Math.abs(s[16 + k]! - p[k]!) > VIEW_SAME_TOLERANCE * (1 + Math.abs(p[k]!))) return false;
    }
    return true;
  }

  /** How far ahead of the camera a world point is (view-space depth, metres). */
  depth(x: number, y: number, z: number): number {
    const m = this.snap;
    return -(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
  }

  /** Where a world-space sphere stands against the view. */
  side(x: number, y: number, z: number, r: number): SphereSide {
    const pl = this.planes;
    let side: SphereSide = SphereSide.Inside;
    for (let i = 0; i < 24; i += 4) {
      const d = pl[i]! * x + pl[i + 1]! * y + pl[i + 2]! * z + pl[i + 3]!;
      if (d < -r) return SphereSide.Outside;
      if (d < r) side = SphereSide.Crossing;
    }
    return side;
  }
}

/** The largest axis scale of a column-major 4×4 matrix (three's bound for a transformed sphere). */
export function maxScaleOf(e: ArrayLike<number>, o = 0): number {
  const sx = e[o]! * e[o]! + e[o + 1]! * e[o + 1]! + e[o + 2]! * e[o + 2]!;
  const sy = e[o + 4]! * e[o + 4]! + e[o + 5]! * e[o + 5]! + e[o + 6]! * e[o + 6]!;
  const sz = e[o + 8]! * e[o + 8]! + e[o + 9]! * e[o + 9]! + e[o + 10]! * e[o + 10]!;
  return Math.sqrt(Math.max(sx, sy, sz));
}

export interface ViewCullDiagnostics {
  /** Draws culled inside. */
  readonly draws: number;
  /** Draws put in order again in the last frame (what the view sees changed). */
  readonly reorders: number;
}

/**
 * The draws culled inside, and the frame's view. It hears from the render
 * graph what enters and leaves the scene (an instance set's chunks); the
 * batcher adds its batches and merged cells itself.
 */
export class ViewCuller implements BatchMembership {
  readonly view = new CullView();
  private readonly items = new Set<ViewCullable>();
  private readonly byRoot = new Map<THREE.Object3D, ViewCullable[]>();
  /** How many listed objects hold each cullable found below them (a chunk's group: one per draw). */
  private readonly listings = new Map<ViewCullable, number>();
  private reorders = 0;
  private lastReorders = 0;

  add(c: ViewCullable): void {
    this.items.add(c);
  }

  remove(c: ViewCullable): void {
    this.items.delete(c);
  }

  listed(o: THREE.Object3D): void {
    if (this.byRoot.has(o)) return;
    const list: ViewCullable[] = [];
    o.traverse((x) => {
      const found = x.userData[VIEW_CULL_KEY] as ViewCullable | undefined;
      if (found === undefined) return;
      const c = found.group ?? found;
      list.push(c);
      this.items.add(c);
      this.listings.set(c, (this.listings.get(c) ?? 0) + 1);
    });
    if (list.length > 0) this.byRoot.set(o, list);
  }

  unlisted(o: THREE.Object3D): void {
    const list = this.byRoot.get(o);
    if (list === undefined) return;
    this.byRoot.delete(o);
    for (const c of list) {
      // A group stays while any of its members is listed.
      const left = (this.listings.get(c) ?? 1) - 1;
      if (left > 0) {
        this.listings.set(c, left);
        continue;
      }
      this.listings.delete(c);
      this.items.delete(c);
    }
  }

  moved(): void {
    // Each draw compares its own world matrix when it is culled.
  }

  dropped(): void {
    // Nothing kept of a drawable not in the scene.
  }

  /** Cull every draw for the frame drawn with `camera` (after the world matrices and the batches are current). */
  update(camera: THREE.Camera): void {
    this.reorders = 0;
    this.view.set(camera);
    for (const c of this.items) if (c.cull(this.view)) this.reorders += 1;
    this.lastReorders = this.reorders;
  }

  diagnostics(): ViewCullDiagnostics {
    return { draws: this.items.size, reorders: this.lastReorders };
  }

  dispose(): void {
    this.items.clear();
    this.byRoot.clear();
    this.listings.clear();
    this.view.clear();
  }
}

/** Tell both `a` and `b` what enters and leaves the scene (either may be absent). */
export function bothMemberships(a: BatchMembership | null, b: BatchMembership | null): BatchMembership | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    listed: (o) => {
      a.listed(o);
      b.listed(o);
    },
    unlisted: (o) => {
      a.unlisted(o);
      b.unlisted(o);
    },
    moved: (o) => {
      a.moved(o);
      b.moved(o);
    },
    dropped: (o) => {
      a.dropped(o);
      b.dropped(o);
    },
  };
}
