/**
 * Draws culled whole on the GPU (occlusion culling's depth pyramid path,
 * WebGPU): block chunks, architecture chunks, merged static cells and models
 * drawn alone. Each is one row of the instanced copies' table
 * (occlusion-instances.ts), tested as one copy of itself: its world box
 * against the depth pyramid (a wall chunk is long and thin: its sphere would
 * reach far past it), by the same dispatch, writing its indirect draw's
 * instance count 0 or 1.
 *
 * Each draw is encoded once a frame, in one of the two passes:
 *
 * - in the first, drawn whole, when it fills the depth (an occluder) and the
 *   last answer read back said it was seen (or none came yet);
 * - else in the second, through its indirect draw: drawn when this frame's
 *   pyramid shows it may be seen.
 *
 * The test after the pyramid runs for both, so a draw in the first pass that
 * other occluders now hide is answered hidden, and moves to the second pass a
 * few frames later (the answer's read-back). A late answer only delays a
 * saving: what the first pass draws is drawn, what the second pass draws is
 * tested against this frame's depth, which is only ever farther than the
 * finished frame's.
 *
 * Only the view's draws in the two passes change: shadow maps, probe bakes, the
 * cached static shadow and every other camera draw them as before. A draw with
 * several groups (one draw a material) or a wireframe stays drawn whole: an
 * indirect draw has one range.
 */
import * as THREE from 'three';
import { occludeeClassOf, occludeeScreenShare, OCCLUSION_MIN_COPIES_TRIANGLES, type OccludeeKind } from '@thirdlight/runtime';

import type { Occludee } from './occludees';
import type { InstanceOcclusion, WholeRow } from './occlusion-instances';
import { mergedViewDrawOf } from './static-merge';
import { occlusionMayTest } from './view-hidden';

/** The kinds tested whole here (instanced copies and terrain nodes are tested one by one; what is blended hides nothing and stays last). */
const WHOLE_KINDS: ReadonlySet<OccludeeKind> = new Set(['merged', 'blocks', 'architecture', 'single']);

/** Whether `kind` is culled whole (as one copy of itself). */
export function culledWhole(kind: OccludeeKind): boolean {
  return WHOLE_KINDS.has(kind);
}

/** What the view's draw of a mesh draws: its index (or vertex) range, as three's renderer would take it (null: not one range). */
export function viewRangeOf(mesh: THREE.Mesh, camera: THREE.Camera): { count: number; first: number } | null {
  const g = mesh.geometry;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (g.groups.length > 1 || materials.length > 1 || materials.some((m) => (m as THREE.MeshBasicMaterial).wireframe === true)) return null;
  const total = g.index !== null ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  const merged = mergedViewDrawOf(mesh, camera);
  const start = Math.max(0, g.drawRange.start);
  let end = Math.min(total, start + (merged !== null ? merged.count : g.drawRange.count));
  let first = start;
  const group = g.groups[0];
  if (group !== undefined) {
    first = Math.max(first, group.start);
    end = Math.min(end, group.start + group.count);
  }
  return { count: Math.max(0, end - first), first };
}

/** A draw tested whole: its place in the pools, its row this frame and the last answer. */
interface Entry extends WholeRow {
  readonly mesh: THREE.Mesh;
  firstPass: boolean;
  count: number;
  first: number;
  /** 1 seen, 0 hidden (by the last read-back), -1: no answer yet. */
  seen: -1 | 0 | 1;
  stamp: number;
}

/** A camera's frustum, eye and vertical half-angle, as the tests of one frame read them. */
export class TestView {
  readonly frustum = new THREE.Frustum();
  readonly eye = new THREE.Vector3();
  /** The tangent of the vertical half-angle over the zoom (0: not a perspective view: nothing is small on screen). */
  tanHalf = 0;

  set(camera: THREE.Camera): this {
    this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, (camera as THREE.Camera & { reversedDepth?: boolean }).reversedDepth === true);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    const p = camera as THREE.PerspectiveCamera;
    this.tanHalf = p.isPerspectiveCamera === true ? Math.tan(THREE.MathUtils.degToRad(p.fov) / 2) / Math.max(1e-6, p.zoom) : 0;
    return this;
  }
}

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _corners = new Float64Array(6);
const _m = new THREE.Matrix4();
const _view = new TestView();

/**
 * Whether a draw culled whole is worth a test in `view` (its camera's), and
 * what it is tested by: its range as the view draws it (returned; null: not
 * worth a test, or out of view), its world box written into `corners`
 * (min xyz, max xyz; a merged cell's over its members in view). Worth a test:
 * one range, at least `OCCLUSION_MIN_COPIES_TRIANGLES`, in the frustum, and
 * not so large on screen that it is never hidden whole (the runtime's
 * `occludeeClassOf`). Both culling paths ask this, the depth pyramid's and
 * the occlusion queries'.
 */
export function wholeTestOf(o: Occludee, camera: THREE.Camera, view: TestView, corners: Float64Array): { count: number; first: number } | null {
  const m = o.object;
  const range = viewRangeOf(m, camera);
  // Enough triangles to win back its test: asked first, it is the cheapest.
  const triangles = range === null ? 0 : Math.floor(range.count / 3);
  if (range === null || triangles < OCCLUSION_MIN_COPIES_TRIANGLES) return null;
  const merged = o.kind === 'merged' ? mergedViewDrawOf(m, camera) : null;
  if (merged !== null) {
    corners.set(merged.box);
    _sphere.set(_sphere.center.set(merged.sphere[0]!, merged.sphere[1]!, merged.sphere[2]!), merged.sphere[3]!);
  } else {
    const g = m.geometry;
    if (g.boundingBox === null) g.computeBoundingBox();
    _box.copy(g.boundingBox!).applyMatrix4(m.matrixWorld);
    if (_box.isEmpty()) return null;
    _box.getBoundingSphere(_sphere);
    corners[0] = _box.min.x;
    corners[1] = _box.min.y;
    corners[2] = _box.min.z;
    corners[3] = _box.max.x;
    corners[4] = _box.max.y;
    corners[5] = _box.max.z;
  }
  if (!(_sphere.radius >= 0) || !view.frustum.intersectsSphere(_sphere)) return null;
  const distance = _sphere.center.distanceTo(view.eye);
  const screenShare = view.tanHalf > 0 ? occludeeScreenShare(_sphere.radius, distance, view.tanHalf) : Number.POSITIVE_INFINITY;
  return occludeeClassOf({ kind: o.kind, triangles, items: 1, screenShare }) === 'whole' ? range : null;
}

export class WholeOcclusion {
  private readonly entries = new Map<THREE.Mesh, Entry>();
  private stamp = 0;
  /** The draws listed this frame (their rows are this frame's). */
  private listed = 0;

  constructor(private readonly instances: InstanceOcclusion) {}

  /**
   * Once a frame, after the view's culling: the draws worth testing whole (of `occludees`, those the view draws
   * now) are given their places and listed in the instanced copies' table, each in the pass its last answer
   * says. `occluder(o)`: whether `o` fills the depth (the first pass may draw it).
   */
  update(occludees: readonly Occludee[], camera: THREE.Camera | null, occluder: (o: Occludee) => boolean): (host: InstanceOcclusion) => void {
    this.stamp += 1;
    this.listed = 0;
    for (const e of this.entries.values()) e.row = -1;
    return (host) => {
      if (camera === null) return;
      _view.set(camera);
      for (const o of occludees) {
        const m = o.object;
        if (!occlusionMayTest(m, camera)) continue;
        const range = wholeTestOf(o, camera, _view, _corners);
        if (range === null) continue;
        let e = this.entries.get(m);
        if (e === undefined) {
          e = this.make(m);
          this.entries.set(m, e);
        }
        e.stamp = this.stamp;
        e.count = range.count;
        e.first = range.first;
        e.firstPass = occluder(o) && e.seen !== 0;
        host.wholeBox(e.base, _corners);
        host.addWhole(e);
        this.listed += 1;
      }
      // Draws not listed for a while give their places back (one listed again gets a new place and no answer).
      for (const [mesh, e] of this.entries) {
        if (this.stamp - e.stamp < FORGET_FRAMES) continue;
        this.instances.releaseWhole(e.base);
        this.entries.delete(mesh);
      }
    };
  }

  /** Whether the view's draw of `object` is encoded in the second pass this frame (tested against this frame's pyramid). */
  second(object: THREE.Object3D): boolean {
    const e = this.entries.get(object as THREE.Mesh);
    return e !== undefined && e.row >= 0 && !e.firstPass;
  }

  /**
   * Draw `object`'s view draw in the second pass: through its indirect draw when this frame's test ran (`draw`
   * runs with the geometry's indirect slot set, cleared after), else whole.
   */
  drawSecond(object: THREE.Object3D, geometry: THREE.BufferGeometry, draw: () => void): void {
    const e = this.entries.get(object as THREE.Mesh);
    if (e === undefined || e.row < 0 || e.firstPass || !this.instances.secondListed) {
      draw();
      return;
    }
    const { args, offset } = this.instances.secondArgs(e.row);
    const g = geometry as THREE.BufferGeometry & { indirect: unknown; indirectOffset: number | number[] };
    const was = { indirect: g.indirect, offset: g.indirectOffset };
    g.indirect = args;
    g.indirectOffset = offset;
    try {
      draw();
    } finally {
      g.indirect = was.indirect;
      g.indirectOffset = was.offset;
    }
  }

  /** The draws listed this frame whose last answer said hidden (the second pass draws them only if this frame's pyramid shows them). */
  *hidden(): IterableIterator<THREE.Mesh> {
    for (const e of this.entries.values()) if (e.row >= 0 && e.seen === 0) yield e.mesh;
  }

  /** Draws listed this frame. */
  get count(): number {
    return this.listed;
  }

  /** Every place given back, every answer forgotten (the path turned off, or the culling stopped). */
  clear(): void {
    for (const e of this.entries.values()) this.instances.releaseWhole(e.base);
    this.entries.clear();
    this.listed = 0;
  }

  private make(mesh: THREE.Mesh): Entry {
    const entries = this.entries;
    const e: Entry = {
      whole: true,
      mesh,
      base: this.instances.placeWhole(),
      firstPass: true,
      count: 0,
      first: 0,
      row: -1,
      seen: -1,
      stamp: this.stamp,
      answer(seen) {
        if (entries.get(mesh) === e) e.seen = seen ? 1 : 0;
      },
    };
    return e;
  }
}

/** Frames a draw may go unlisted (out of view, hidden by rooms) before it gives its place back. */
const FORGET_FRAMES = 120;
