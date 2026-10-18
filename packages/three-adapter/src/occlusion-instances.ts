/**
 * Instanced copies culled on the GPU (occlusion culling's depth pyramid
 * path, WebGPU): the copies of instance-set chunks (scatter, ground cover,
 * kit copies), automatic batches and terrain pages' nodes
 * (terrain-node-culling.ts) the view draws are tested one by one against the
 * depth pyramid, and each pass draws only the copies its list names, through
 * an indirect draw (`geometry.setIndirect`) whose instance count the compute
 * wrote. The rule is `occlusion-instances-rule.ts`. Copies are tested as
 * their spheres, or as their world boxes where the draw carries them (terrain
 * nodes). Draws culled whole (occlusion-whole.ts) are rows of the same table,
 * each one copy tested as its box.
 *
 * - The CPU still decides what is in a draw: levels of detail, density
 *   thinning and the frustum (`view-cull.ts` puts the copies in view first,
 *   nearest first). The compute only leaves copies out of the first `n`.
 * - Every culled draw has a range in shared pools: its drawn copies'
 *   matrices (copied from its drawn buffer as written, paint slot and all),
 *   world spheres and slots, written when its drawn buffer changes; the
 *   visibility kept per slot and the two passes' lists live on the GPU only.
 * - One dispatch before the first pass writes every draw's first list (the
 *   copies visible last frame, for draws the first pass draws); one after
 *   the pyramid tests the copies and writes the second lists. A workgroup per
 *   draw, so a list keeps the drawn order (nearest first).
 * - Only the view's draws in the two passes go indirect. Shadow maps, probe
 *   bakes, the cached static shadow and every other camera draw every copy
 *   from the draw's own columns, as before.
 * - A draw is marked before its first render object is made (the culler
 *   adopts it from its first `onBeforeRender`), so its build reads copies by
 *   list from the start; marking a draw already drawn builds its program
 *   again (once, when the path turns on). Turning the path off unmarks every
 *   draw: culling off draws with the programs it had before.
 *
 * Kept out of `occlusion.ts` and `occlusion-passes.ts`, which run it.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { IndirectStorageBufferAttribute, ReadbackBuffer, StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';
import { OCCLUSION_MIN_COPIES_TRIANGLES } from '@thirdlight/runtime';

import { CULLABLE_COPIES_KEY, CULLED_COPIES_KEY, INSTANCE_CULLER_KEY, type CullableCopies, type CulledCopies, type InstanceCullerHost, type InstanceViewDraw } from './attribute-instancing';
import { releaseStorage } from './dispose';
import type { N } from './effects-tsl';
import { drawTrianglesOf, OCCLUDEE_KIND_KEY } from './occludees';
import { COPY_BOX_FLOAT, COPY_FLOATS, copiesWorthCulling, HIDDEN_DEPTH_MARGIN, HIDDEN_NEAR_MARGIN_M, HIDDEN_NEAR_MARGIN_SHARE, RangeAllocator } from './occlusion-instances-rule';
import { depthOfViewZNode, type DepthPyramid } from './occlusion-pyramid';
import { VIEW_CULL_KEY } from './view-cull';
import { occlusionMayTest } from './view-hidden';

/** TSL untyped (see effects-tsl.ts). */
const TSL: N = TSLTyped;

/** Threads of a draw's workgroup (its copies are compacted this many at a time). */
const WORKGROUP = 64;
/** Workgroups a dispatch row holds (WebGPU's guaranteed largest dispatch side): draws past it go to the next row. */
const DISPATCH_ROW = 65535;
/** u32 a draw's row of the table holds: range start, copies tested, capacity, flags, vertex or index count, first vertex or index. */
const TABLE_STRIDE = 8;
/** u32 a draw's indirect arguments take: two passes of five (indexed: count, instances, first, base vertex, first instance). */
const ARGS_STRIDE = 10;
const ARGS_PASS = 5;
/**
 * Table flags: the first pass draws the draw; its range is new (no visibility kept); a draw tested whole
 * (occlusion-whole.ts); its copies tested as their boxes (in their pool floats from `COPY_BOX_FLOAT`).
 */
const FLAG_FIRST_PASS = 1;
const FLAG_FRESH = 2;
const FLAG_WHOLE = 4;
const FLAG_BOX = 8;
/** Copies the pools hold at first (they grow as draws come). */
const POOL_COPIES = 4096;
/** Frames between read-backs of the drawn counts (diagnostics only). */
const READBACK_FRAMES = 60;

/**
 * A draw tested whole, as one copy of itself (`occlusion-whole.ts` lists them): its one place in the pools, its
 * world box written there ({@link InstanceOcclusion.wholeBox}), the pass that encodes it, and what its second pass's indirect draw draws. The late dispatch
 * writes whether it is seen into its row's first-pass instance count (no first pass draws it indirect), which the
 * read-back hands to `answer`.
 */
export interface WholeRow {
  readonly whole: true;
  readonly base: number;
  /** Encoded in the first pass (drawn whole there); else in the second, as the test says. */
  readonly firstPass: boolean;
  /** The index (or vertex) count and first the view's draw draws. */
  readonly count: number;
  readonly first: number;
  /** This frame's row (-1: none), set by {@link InstanceOcclusion.addWhole}. */
  row: number;
  /** The read-back's answer for the frame it was listed in. */
  answer(seen: boolean): void;
}

/** One instanced draw in the pools. */
interface Draw extends CulledCopies {
  readonly whole?: undefined;
  readonly handle: CullableCopies;
  readonly cap: number;
  /** Triangles one copy draws. */
  readonly triangles: number;
  base: number;
  list: number;
  /** The drawn buffer's version copied into the pools (NaN: none yet). */
  copied: number;
  fresh: boolean;
  /** Its copies are tested as their boxes. */
  readonly box: boolean;
  /** Its row in this frame's table (-1: not culled this frame), whether the first pass draws it, and the copies tested. */
  row: number;
  firstPass: boolean;
  n: number;
  seen: number;
}

/** What the culling of instanced copies reports (the counts read back from the GPU, a few frames late). */
export interface InstanceOcclusionDiagnostics {
  /** Draws culled in the last frame, and copies their pools hold. */
  readonly draws: number;
  readonly poolCopies: number;
  /** GPU memory of the pools, the table and the indirect arguments. */
  readonly bytes: number;
  /** From the last read-back: copies tested, drawn in the first pass and in the second. */
  readonly tested: number;
  readonly drawn1: number;
  readonly drawn2: number;
  /** Copies left out of the first pass (by last frame's answer) in the draws it draws. */
  readonly pass1Left: number;
  /** Why the culling of copies stopped (null: it runs). */
  readonly error: string | null;
  /** From the last read-back: draws tested whole, those the second pass tested, and of those the hidden ones. */
  readonly whole: { readonly tested: number; readonly second: number; readonly culled: number };
  /** From the last read-back: terrain nodes tested and culled (counted among the copies too). */
  readonly terrain: { readonly tested: number; readonly culled: number };
}

/** The rows of a frame: instanced draws first, then the draws tested whole. */
type Row = Draw | WholeRow;

interface Pools {
  readonly copies: number;
  readonly matrices: StorageBufferAttribute;
  readonly spheres: StorageBufferAttribute;
  readonly slots: StorageBufferAttribute;
  readonly visible: StorageBufferAttribute;
  readonly lists: StorageBufferAttribute;
}

/** Each range of a pool written since its last upload ([start, end) in array elements), joined when they touch. */
class DirtyRanges {
  private readonly ranges: [number, number][] = [];
  add(start: number, end: number): void {
    if (end > start) this.ranges.push([start, end]);
  }
  flush(attr: THREE.BufferAttribute): void {
    if (this.ranges.length === 0) return;
    this.ranges.sort((a, b) => a[0] - b[0]);
    let [s, e] = this.ranges[0]!;
    for (let i = 1; i < this.ranges.length; i += 1) {
      const r = this.ranges[i]!;
      if (r[0] <= e) e = Math.max(e, r[1]);
      else {
        attr.addUpdateRange(s, e - s);
        [s, e] = r;
      }
    }
    attr.addUpdateRange(s, e - s);
    attr.needsUpdate = true;
    this.ranges.length = 0;
  }
}

export class InstanceOcclusion implements InstanceCullerHost {
  private readonly draws = new Map<CullableCopies, Draw>();
  /** Draws that cannot be culled one copy at a time (too few triangles, blended), by the material they were judged with. */
  private readonly passed = new WeakMap<CullableCopies, THREE.Mesh['material']>();
  private readonly alloc = new RangeAllocator(POOL_COPIES);
  private pools: Pools;
  private generation = 0;
  private table: StorageBufferAttribute;
  private args: IndirectStorageBufferAttribute;
  private rows = 0;
  private readonly frameRows: Row[] = [];
  private readonly dirty = { matrices: new DirtyRanges(), spheres: new DirtyRanges(), slots: new DirtyRanges() };
  private readonly drawCount = TSL.uniform(0, 'uint');
  private readonly viewMatrix = TSL.uniform(new THREE.Matrix4());
  private readonly projection = TSL.uniform(new THREE.Matrix4());
  private readonly near = TSL.uniform(0.1);
  private readonly far = TSL.uniform(1000);
  private readonly source = { width: TSL.uniform(1, 'uint'), height: TSL.uniform(1, 'uint'), levels: TSL.uniform(1, 'uint') };
  private early: N = null;
  private late: N = null;
  private earlyKey = '';
  private lateKey = '';
  /** This frame's dispatches ran (a pass draws indirect only after its list was written). */
  private ranEarly = false;
  private ranLate = false;
  /** This frame's late dispatch is new: run after the pyramid's pass ({@link runFresh}). */
  private freshLate = false;
  private stamp = 0;
  private frames = 0;
  private reading = false;
  private read = { tested: 0, drawn1: 0, drawn2: 0, pass1Left: 0, whole: { tested: 0, second: 0, culled: 0 }, terrain: { tested: 0, culled: 0 } };
  /** Where the read-back lands (made again when the arguments grow). */
  private readback: ReadbackBuffer | null = null;
  private disposed = false;
  /** Why the culling of copies stopped (null: it runs). */
  private failed: string | null = null;

  constructor(
    private readonly renderer: WebGPURenderer,
    /** The pass drawing now (1, 2; 0: neither) and whether the first pass draws `object`. */
    private readonly passes: { readonly drawing: 0 | 1 | 2; firstPass(object: THREE.Object3D): boolean },
  ) {
    this.pools = this.makePools(this.alloc.size, null);
    this.rows = 64;
    this.table = this.makeTable();
    this.args = this.makeArgs();
  }

  /** Watch `scene`'s draws: each is adopted before it is first drawn (its build then reads copies by list). */
  attach(scene: THREE.Scene): void {
    scene.userData[INSTANCE_CULLER_KEY] = this;
  }

  detach(scene: THREE.Scene): void {
    if (scene.userData[INSTANCE_CULLER_KEY] === this) delete scene.userData[INSTANCE_CULLER_KEY];
  }

  /** Whether the second pass draws `object` too (a culled draw the first pass draws: the copies it did not). */
  bothPasses(object: THREE.Object3D): boolean {
    const d = object.userData[CULLED_COPIES_KEY] as Draw | undefined;
    return d !== undefined && d.row >= 0 && d.firstPass;
  }

  /** Whether this frame's second pass may draw through the indirect arguments (its dispatch ran). */
  get secondListed(): boolean {
    return this.ranLate;
  }

  /** The indirect arguments and the byte offset of row `row`'s second-pass draw. */
  secondArgs(row: number): { readonly args: IndirectStorageBufferAttribute; readonly offset: number } {
    return { args: this.args, offset: (row * ARGS_STRIDE + ARGS_PASS) * 4 };
  }

  /** One place in the pools for a draw tested whole (the pools may grow). */
  placeWhole(): number {
    const before = this.alloc.size;
    const base = this.alloc.alloc(1);
    if (this.alloc.size !== before) this.grow();
    (this.pools.slots.array as Uint32Array)[base] = 0;
    this.dirty.slots.add(base, base + 1);
    return base;
  }

  releaseWhole(base: number): void {
    this.alloc.release(base, 1);
  }

  /** A draw tested whole: its world box (min xyz, max xyz) at its place, which it is tested as (written only when it changed). */
  wholeBox(base: number, box: ArrayLike<number>): void {
    const m = this.pools.matrices.array as Float32Array;
    const at = base * COPY_FLOATS + COPY_BOX_FLOAT;
    let same = true;
    for (let a = 0; a < 3; a += 1) same &&= m[at + a] === Math.fround(box[a]!) && m[at + 4 + a] === Math.fround(box[3 + a]!);
    if (same) return;
    for (let a = 0; a < 3; a += 1) {
      m[at + a] = box[a]!;
      m[at + 4 + a] = box[3 + a]!;
    }
    this.dirty.matrices.add(at, at + 8);
  }

  /** List a draw tested whole in this frame's table (between {@link update}'s instanced rows and its upload). */
  addWhole(w: WholeRow): void {
    w.row = this.frameRows.length;
    this.frameRows.push(w);
  }

  adopt(handle: CullableCopies): void {
    if (this.disposed || this.failed !== null || this.draws.has(handle)) return;
    const mesh = handle.mesh;
    if (this.passed.get(handle) === mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const items = handle.capacity;
    const triangles = drawTrianglesOf(mesh.geometry);
    const worth = copiesWorthCulling(triangles, items, materials.some((m) => m.transparent));
    if (!worth) {
      this.passed.set(handle, mesh.material);
      return;
    }
    const self = this;
    const draw: Draw = {
      handle,
      cap: items,
      triangles,
      box: handle.boxes === true,
      base: -1,
      list: 0,
      copied: Number.NaN,
      fresh: true,
      row: -1,
      firstPass: false,
      n: 0,
      seen: this.stamp,
      get matrices() {
        return self.pools.matrices;
      },
      get lists() {
        return self.pools.lists;
      },
    };
    this.draws.set(handle, draw);
    mesh.userData[CULLED_COPIES_KEY] = draw;
    handle.indirect = {
      draw: (geometry, view) => this.drawPass(draw, geometry, view),
      release: () => this.forget(draw),
    };
    handle.markCulled(true);
  }

  /**
   * Once a frame, after the view's culling (for the view's `camera`): the
   * draws in the scene (`meshes`: the scene's drawables) are adopted, given ranges, copied where their
   * drawn buffers changed, and listed in the table the dispatches read.
   */
  update(meshes: Iterable<THREE.Object3D>, camera: THREE.Camera | null, wholes?: (host: InstanceOcclusion) => void): void {
    if (this.failed !== null) return;
    this.stamp += 1;
    this.ranEarly = false;
    this.ranLate = false;
    this.freshLate = false;
    this.frameRows.length = 0;
    for (const o of meshes) {
      // Draws through instance-matrix columns carry their handle as their view culling (batches' and chunks' draws),
      // terrain pages theirs on its own.
      const handle = (o.userData[VIEW_CULL_KEY] ?? o.userData[CULLABLE_COPIES_KEY]) as Partial<CullableCopies> | undefined;
      if (handle === undefined || handle.mesh !== o || typeof handle.viewDraw !== 'function') continue;
      let d = this.draws.get(handle as CullableCopies);
      if (d === undefined) {
        this.adopt(handle as CullableCopies);
        d = this.draws.get(handle as CullableCopies);
        if (d === undefined) continue;
      }
      d.seen = this.stamp;
      d.row = -1;
      const m = o as THREE.Mesh;
      if (camera === null || !occlusionMayTest(m, camera)) continue;
      const vd = d.handle.viewDraw();
      // Too few triangles in view to win back the draw's second encode and upkeep: drawn whole this frame.
      if (vd === null || vd.count * d.triangles < OCCLUSION_MIN_COPIES_TRIANGLES) continue;
      if (d.base < 0) this.place(d);
      if (d.copied !== vd.version) this.copy(d, vd);
      d.n = vd.count;
      d.firstPass = this.passes.firstPass(m);
      d.row = this.frameRows.length;
      this.frameRows.push(d);
    }
    // Draws gone from the scene give their ranges back (their marks stay: they may come back).
    for (const d of this.draws.values()) {
      if (d.seen === this.stamp || d.base < 0) continue;
      this.alloc.release(d.base, d.cap);
      d.base = -1;
      d.row = -1;
    }
    if (camera !== null) wholes?.(this);
    this.writeTable();
    this.dirty.matrices.flush(this.pools.matrices);
    this.dirty.spheres.flush(this.pools.spheres);
    this.dirty.slots.flush(this.pools.slots);
  }

  /**
   * Before the first pass: every draw's first list (the copies visible last
   * frame). A dispatch that fails (its build threw) turns the culling of
   * copies off for good, reported once: the frame is drawn whole instead of
   * not at all (the scene pass restores the renderer's targets only when its
   * render returns).
   */
  runEarly(): void {
    this.guard(() => this.early_());
  }

  /**
   * After the pyramid: the copies tested against it, the second lists, and
   * the visibility kept for the next frame. Called while the pyramid is built
   * (its layout is this frame's): returns the dispatch to run in the
   * pyramid's own compute pass, or null (none, or a dispatch new this frame,
   * which {@link runFresh} runs on its own once the pyramid's pass is
   * submitted, so that a build that throws stays out of the pyramid's pass and
   * the dispatch still reads this frame's pyramid).
   */
  lateNode(pyramid: DepthPyramid, camera: THREE.Camera): N | null {
    let node: N | null = null;
    this.guard(() => {
      node = this.late_(pyramid, camera);
    });
    return node;
  }

  /** A dispatch new this frame (see {@link lateNode}), after the pyramid's pass. */
  runFresh(): void {
    if (!this.freshLate) return;
    this.freshLate = false;
    this.guard(() => {
      void this.renderer.compute(this.late);
    });
  }

  private guard(run: () => void): void {
    if (this.failed !== null) return;
    try {
      run();
    } catch (e) {
      this.failed = String(e);
      this.ranEarly = false;
      this.ranLate = false;
      this.freshLate = false;
      this.clear();
      console.warn(`[thirdlight] occlusion culling of instanced copies is off: ${this.failed}`);
    }
  }

  private early_(): void {
    // Only draws the first pass draws have a first list (cut-out scatter and cover are drawn in the second only).
    if (this.disposed || !this.frameRows.some((d) => d.firstPass && d.whole !== true)) return;
    if (this.earlyKey !== String(this.generation)) {
      this.early?.dispose?.();
      this.early = this.kernel('early', null, false, false, true);
      this.earlyKey = String(this.generation);
    }
    this.early.dispatchSize = this.dispatchSize();
    void this.renderer.compute(this.early);
    this.ranEarly = true;
  }

  private late_(pyramid: DepthPyramid, camera: THREE.Camera): N | null {
    const layout = pyramid.layout();
    if (this.frameRows.length === 0 || this.disposed || layout === null || pyramid.storage() === null) return null;
    const r = this.renderer as unknown as { reversedDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean };
    const reversed = pyramid.reversed;
    const logarithmic = r.logarithmicDepthBuffer === true;
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    // The box test only where a row needs it (draws culled whole, terrain nodes): the sphere-only kernel is lighter.
    const boxes = this.frameRows.some((d) => d.whole === true || d.box);
    const key = `${this.generation}|${pyramid.generation}|${reversed}|${logarithmic}|${perspective}|${boxes}`;
    const fresh = key !== this.lateKey;
    if (fresh) {
      this.late?.dispose?.();
      this.late = this.kernel('late', pyramid, reversed, logarithmic, perspective, boxes);
      this.lateKey = key;
    }
    const c = camera as THREE.PerspectiveCamera;
    this.viewMatrix.value.copy(camera.matrixWorldInverse);
    this.projection.value.copy(camera.projectionMatrix);
    this.near.value = c.near;
    this.far.value = c.far;
    this.source.width.value = layout.sourceWidth;
    this.source.height.value = layout.sourceHeight;
    this.source.levels.value = layout.levels.length;
    this.late.dispatchSize = this.dispatchSize();
    this.freshLate = fresh;
    this.ranLate = true;
    for (const d of this.frameRows) if (d.whole !== true) d.fresh = false;
    this.frames += 1;
    // Read after this frame's dispatch (queued once the pyramid's pass is submitted): every frame it can while draws
    // tested whole wait for their answers (they pick their pass by it), else now and then for the diagnostics.
    const wholes = this.frameRows.length > 0 && this.frameRows.at(-1)!.whole === true;
    if (!this.reading && (wholes || this.frames % READBACK_FRAMES === 0)) queueMicrotask(() => this.readBack());
    return fresh ? null : this.late;
  }

  diagnostics(): InstanceOcclusionDiagnostics {
    const p = this.pools;
    const bytes = p.copies * (COPY_FLOATS * 4 + 16 + 4 + 4 + 8) + this.rows * (TABLE_STRIDE + ARGS_STRIDE) * 4 + (this.readback?.maxByteLength ?? 0);
    let draws = 0;
    for (const d of this.frameRows) if (d.whole !== true) draws += 1;
    return { draws, poolCopies: p.copies, bytes, ...this.read, error: this.failed };
  }

  /** Every draw unmarked and drawn as before (the path turned off). */
  clear(): void {
    for (const d of [...this.draws.values()]) {
      this.forget(d);
      d.handle.indirect = null;
      d.handle.markCulled(false);
    }
    this.frameRows.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.early?.dispose?.();
    this.late?.dispose?.();
    this.early = null;
    this.late = null;
    const p = this.pools;
    releaseStorage(this.renderer, [p.matrices, p.spheres, p.slots, p.visible, p.lists, this.table, this.args]);
    this.dropReadback();
  }

  private forget(d: Draw): void {
    if (this.draws.get(d.handle) !== d) return;
    this.draws.delete(d.handle);
    if (d.base >= 0) this.alloc.release(d.base, d.cap);
    d.base = -1;
    d.row = -1;
    d.list = 0;
    if (d.handle.mesh.userData[CULLED_COPIES_KEY] === d) delete d.handle.mesh.userData[CULLED_COPIES_KEY];
    d.handle.mesh.geometry.indirect = null;
  }

  /** How `d` is drawn by the pass drawing now: its list through its indirect slot (the view, once its list is written), else whole. */
  private drawPass(d: Draw, geometry: THREE.InstancedBufferGeometry, view: boolean): void {
    const pass = this.passes.drawing;
    const ready = pass === 1 ? this.ranEarly : pass === 2 && this.ranLate;
    if (view && ready && d.row >= 0 && d.base >= 0) {
      geometry.indirect = this.args as never;
      geometry.indirectOffset = (d.row * ARGS_STRIDE + (pass - 1) * ARGS_PASS) * 4;
      d.list = 1 + d.base * 2;
    } else {
      geometry.indirect = null;
      d.list = 0;
    }
  }

  private place(d: Draw): void {
    const before = this.alloc.size;
    d.base = this.alloc.alloc(d.cap);
    d.fresh = true;
    d.copied = Number.NaN;
    if (this.alloc.size !== before) this.grow();
  }

  /** The pools at their new size: what the CPU wrote is kept, what only the GPU holds starts again (every draw fresh). */
  private grow(): void {
    const old = this.pools;
    this.pools = this.makePools(this.alloc.size, old);
    releaseStorage(this.renderer, [old.matrices, old.spheres, old.slots, old.visible, old.lists]);
    for (const d of this.draws.values()) d.fresh = true;
    this.generation += 1;
  }

  private makePools(copies: number, from: Pools | null): Pools {
    const matrices = new Float32Array(copies * COPY_FLOATS);
    const spheres = new Float32Array(copies * 4);
    const slots = new Uint32Array(copies);
    if (from !== null) {
      matrices.set(from.matrices.array as Float32Array);
      spheres.set(from.spheres.array as Float32Array);
      slots.set(from.slots.array as Uint32Array);
    }
    const named = <T extends { name: string }>(a: T, name: string): T => {
      a.name = `tl-occlusion-${name}`;
      return a;
    };
    return {
      copies,
      matrices: named(new StorageBufferAttribute(matrices, 4), 'matrices'),
      spheres: named(new StorageBufferAttribute(spheres, 4), 'spheres'),
      slots: named(new StorageBufferAttribute(slots, 1), 'slots'),
      visible: named(new StorageBufferAttribute(new Uint32Array(copies), 1), 'visible'),
      // The pass flag first, then two lists a copy.
      lists: named(new StorageBufferAttribute(new Uint32Array(1 + copies * 2), 1), 'lists'),
    };
  }

  /** The draw's first `n` drawn copies into its range: their matrices as written, world spheres and slots. */
  private copy(d: Draw, vd: InstanceViewDraw): void {
    const { drawn, order, spheres, count: n } = vd;
    const p = this.pools;
    const m = p.matrices.array as Float32Array;
    const s = p.spheres.array as Float32Array;
    const sl = p.slots.array as Uint32Array;
    m.set(drawn.subarray(0, n * COPY_FLOATS), d.base * COPY_FLOATS);
    for (let at = 0; at < n; at += 1) {
      const slot = order[at]!;
      const to = (d.base + at) * 4;
      s[to] = spheres[slot * 4]!;
      s[to + 1] = spheres[slot * 4 + 1]!;
      s[to + 2] = spheres[slot * 4 + 2]!;
      s[to + 3] = spheres[slot * 4 + 3]!;
      sl[d.base + at] = slot;
    }
    this.dirty.matrices.add(d.base * COPY_FLOATS, (d.base + n) * COPY_FLOATS);
    this.dirty.spheres.add(d.base * 4, (d.base + n) * 4);
    this.dirty.slots.add(d.base, d.base + n);
    d.copied = vd.version;
  }

  private writeTable(): void {
    const rows = this.frameRows.length;
    if (rows > this.rows) {
      releaseStorage(this.renderer, [this.table, this.args]);
      this.dropReadback();
      this.rows = Math.max(rows, this.rows * 2);
      this.table = this.makeTable();
      this.args = this.makeArgs();
      this.generation += 1;
    }
    const t = this.table.array as Uint32Array;
    let changed = false;
    const put = (i: number, v: number): void => {
      if (t[i] === v) return;
      t[i] = v;
      changed = true;
    };
    for (let r = 0; r < rows; r += 1) {
      const d = this.frameRows[r]!;
      const o = r * TABLE_STRIDE;
      if (d.whole === true) {
        put(o, d.base);
        put(o + 1, 1);
        put(o + 2, 1);
        put(o + 3, FLAG_WHOLE | FLAG_BOX | (d.firstPass ? FLAG_FIRST_PASS : 0));
        put(o + 4, d.count);
        put(o + 5, d.first);
        continue;
      }
      const g = d.handle.mesh.geometry;
      const index = g.index;
      const total = index !== null ? index.count : (g.getAttribute('position')?.count ?? 0);
      const first = Math.max(0, g.drawRange.start);
      const count = Math.max(0, Math.min(total - first, g.drawRange.count));
      put(o, d.base);
      put(o + 1, d.n);
      put(o + 2, d.cap);
      put(o + 3, (d.firstPass ? FLAG_FIRST_PASS : 0) | (d.fresh ? FLAG_FRESH : 0) | (d.box ? FLAG_BOX : 0));
      put(o + 4, count);
      put(o + 5, first);
    }
    this.drawCount.value = rows;
    if (changed) {
      this.table.addUpdateRange(0, rows * TABLE_STRIDE);
      this.table.needsUpdate = true;
    }
  }

  private makeTable(): StorageBufferAttribute {
    const t = new StorageBufferAttribute(new Uint32Array(TABLE_STRIDE * this.rows), 1);
    t.name = 'tl-occlusion-table';
    return t;
  }

  private makeArgs(): IndirectStorageBufferAttribute {
    const a = new IndirectStorageBufferAttribute(new Uint32Array(ARGS_STRIDE * this.rows), 1);
    a.name = 'tl-occlusion-args';
    return a;
  }

  private dispatchSize(): [number, number, number] {
    const rows = this.frameRows.length;
    return [Math.min(rows, DISPATCH_ROW), Math.ceil(rows / DISPATCH_ROW), 1];
  }

  private kernel(phase: 'early' | 'late', pyramid: DepthPyramid | null, reversed: boolean, logarithmic: boolean, perspective: boolean, boxes = false): N {
    const p = this.pools;
    const table: N = TSL.storage(this.table, 'uint', this.table.count).toReadOnly();
    const args: N = TSL.storage(this.args, 'uint', this.args.count);
    const slots: N = TSL.storage(p.slots, 'uint', p.slots.count).toReadOnly();
    const visible: N = TSL.storage(p.visible, 'uint', p.visible.count);
    const lists: N = TSL.storage(p.lists, 'uint', p.lists.count);
    const spheres: N = phase === 'late' ? TSL.storage(p.spheres, 'vec4', p.spheres.count).toReadOnly() : null;
    // Boxes ride in the copies' floats (their vec4s from COPY_BOX_FLOAT / 4).
    const copies: N = phase === 'late' && boxes ? TSL.storage(p.matrices, 'vec4', p.matrices.count).toReadOnly() : null;
    const depthAttr = pyramid?.storage() ?? null;
    const levels: N = depthAttr === null ? null : TSL.storage(depthAttr, 'float', depthAttr.count).toReadOnly();
    const scan = TSL.workgroupArray('uint', WORKGROUP);
    const drawCount = this.drawCount;
    const bounds = phase === 'late' ? this.boundsTests(levels, reversed, logarithmic, perspective) : null;
    return TSL.Fn(() => {
      const d = TSL.workgroupId.x.add(TSL.workgroupId.y.mul(DISPATCH_ROW));
      const lid = TSL.localId.x;
      // Uniform for the whole workgroup (a uniform and a read-only table): the barriers below stay in uniform control flow.
      TSL.If(d.lessThan(drawCount), () => {
        const row = d.mul(TABLE_STRIDE);
        const base = table.element(row).toVar();
        const n = table.element(row.add(1)).toVar();
        const cap = table.element(row.add(2)).toVar();
        const flags = table.element(row.add(3)).toVar();
        const firstPass = flags.bitAnd(FLAG_FIRST_PASS).notEqual(0);
        const fresh = flags.bitAnd(FLAG_FRESH).notEqual(0);
        const whole = flags.bitAnd(FLAG_WHOLE).notEqual(0);
        const boxed = flags.bitAnd(FLAG_BOX).notEqual(0);
        const out = phase === 'early' ? base.mul(2).add(1).toVar() : base.mul(2).add(1).add(cap).toVar();
        // The pass the vertex stages read their list for (one write a dispatch; nothing in it reads the flag).
        TSL.If(d.equal(0).and(lid.equal(0)), () => {
          lists.element(TSL.uint(0)).assign(TSL.uint(phase === 'early' ? 0 : 1));
        });
        const running = TSL.uint(0).toVar();
        TSL.Loop({ start: TSL.uint(0), end: n, type: 'uint', condition: '<', update: WORKGROUP, name: 'chunk' }, ({ chunk }: { chunk: N }) => {
          const place = chunk.add(lid);
          const flag = TSL.uint(0).toVar();
          TSL.If(place.lessThan(n), () => {
            const slot = slots.element(base.add(place)).toVar();
            const was = firstPass.and(fresh.or(visible.element(base.add(slot)).notEqual(0)));
            if (phase === 'early') flag.assign(TSL.select(was, TSL.uint(1), TSL.uint(0)));
            else {
              const now = TSL.bool(true).toVar();
              if (boxes) {
                TSL.If(boxed, () => {
                  const v = base.add(place).mul(COPY_FLOATS / 4).add(COPY_BOX_FLOAT / 4);
                  now.assign(bounds!.box(copies.element(v).xyz, copies.element(v.add(1)).xyz));
                }).Else(() => {
                  now.assign(bounds!.sphere(spheres.element(base.add(place))));
                });
              } else now.assign(bounds!.sphere(spheres.element(base.add(place))));
              visible.element(base.add(slot)).assign(TSL.select(now, TSL.uint(1), TSL.uint(0)));
              flag.assign(TSL.select(now.and(was.not()), TSL.uint(1), TSL.uint(0)));
              // A draw tested whole is never drawn indirect by the first pass: its answer is kept there for the read-back.
              TSL.If(whole, () => {
                args.element(d.mul(ARGS_STRIDE).add(1)).assign(TSL.select(now, TSL.uint(1), TSL.uint(0)));
              });
            }
          });
          // An inclusive sum over the workgroup: each flagged copy's place in the list, in order.
          scan.element(lid).assign(flag);
          TSL.workgroupBarrier();
          for (let off = 1; off < WORKGROUP; off *= 2) {
            const v = TSL.select(lid.greaterThanEqual(off), scan.element(TSL.max(lid, TSL.uint(off)).sub(off)), TSL.uint(0)).toVar();
            TSL.workgroupBarrier();
            scan.element(lid).addAssign(v);
            TSL.workgroupBarrier();
          }
          TSL.If(flag.notEqual(0), () => {
            lists.element(out.add(running).add(scan.element(lid)).sub(1)).assign(place);
          });
          running.addAssign(scan.element(TSL.uint(WORKGROUP - 1)));
          // Every thread read the sum before the next copies overwrite it.
          TSL.workgroupBarrier();
        });
        TSL.If(lid.equal(0), () => {
          const a = d.mul(ARGS_STRIDE).add(phase === 'early' ? 0 : ARGS_PASS).toVar();
          args.element(a).assign(table.element(row.add(4)));
          args.element(a.add(1)).assign(running);
          args.element(a.add(2)).assign(table.element(row.add(5)));
          args.element(a.add(3)).assign(TSL.uint(0));
          args.element(a.add(4)).assign(TSL.uint(0));
        });
      });
    })().compute([1, 1, 1], [WORKGROUP]);
  }

  /** Whether a world sphere (vec4: centre, radius) or box (min, max) may show a pixel against the pyramid (the rule's `sphereMayShow` and `boxMayShow`, in TSL). */
  private boundsTests(levels: N, reversed: boolean, logarithmic: boolean, perspective: boolean): { sphere(s: N): N; box(lo: N, hi: N): N } {
    const { viewMatrix } = this;
    const rect = this.rectTest(levels, reversed, logarithmic, perspective);
    return {
      sphere: (s: N): N => {
        const vc = viewMatrix.mul(TSL.vec4(s.xyz, 1)).xyz.toVar();
        const r = s.w;
        const corners: N[] = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push(vc.add(TSL.vec3(sx, sy, sz).mul(r)));
        return rect(corners, vc.z.add(r));
      },
      box: (lo: N, hi: N): N => {
        const corners: N[] = [];
        for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) corners.push(viewMatrix.mul(TSL.vec4(x, y, z, 1)).xyz.toVar());
        let nearest: N = corners[0]!.z;
        for (const c of corners.slice(1)) nearest = TSL.max(nearest, c.z);
        return rect(corners, nearest);
      },
    };
  }

  /** The rule's `rectMayShow` in TSL: `corners` (view space) bound what may be drawn, `nearest` is the view-space z of its nearest point. */
  private rectTest(levels: N, reversed: boolean, logarithmic: boolean, perspective: boolean): (corners: N[], nearest: N) => N {
    const { projection, near, far } = this;
    const { width: W, height: H, levels: levelCount } = this.source;
    const farther = reversed ? (a: N, b: N) => TSL.min(a, b) : (a: N, b: N) => TSL.max(a, b);
    return (corners: N[], nearest: N): N => {
      const show = TSL.bool(true).toVar();
      const nearZ = TSL.float(nearest).add(HIDDEN_NEAR_MARGIN_M).sub(TSL.float(nearest).mul(HIDDEN_NEAR_MARGIN_SHARE)).toVar();
      // Bounds reaching the near plane are kept; else every corner is ahead of the camera.
      TSL.If(nearZ.negate().greaterThan(near), () => {
        const x0 = TSL.float(1e9).toVar();
        const x1 = TSL.float(-1e9).toVar();
        const y0 = TSL.float(1e9).toVar();
        const y1 = TSL.float(-1e9).toVar();
        for (const v of corners) {
          const c = projection.mul(TSL.vec4(v, 1));
          const ndc = c.xy.div(c.w);
          x0.assign(TSL.min(x0, ndc.x));
          x1.assign(TSL.max(x1, ndc.x));
          y0.assign(TSL.min(y0, ndc.y));
          y1.assign(TSL.max(y1, ndc.y));
        }
        const fw = TSL.float(W);
        const fh = TSL.float(H);
        const px = (v: N, size: N, f: N): N => TSL.min(TSL.uint(TSL.floor(TSL.clamp(v, 0, 1).mul(f))), size.sub(1));
        const px0 = px(x0.mul(0.5).add(0.5), W, fw).toVar();
        const px1 = px(x1.mul(0.5).add(0.5), W, fw).toVar();
        // Screen rows run down: the top of the box is the smallest row.
        const py0 = px(TSL.float(0.5).sub(y1.mul(0.5)), H, fh).toVar();
        const py1 = px(TSL.float(0.5).sub(y0.mul(0.5)), H, fh).toVar();
        const span = TSL.max(px1.sub(px0), py1.sub(py0));
        const l = TSL.select(span.greaterThan(0), TSL.uint(TSL.max(TSL.ceil(TSL.log2(TSL.float(span.add(1)))).sub(1), 0)), TSL.uint(0)).toVar();
        TSL.If(px1.shiftRight(l.add(1)).sub(px0.shiftRight(l.add(1))).greaterThan(1).or(py1.shiftRight(l.add(1)).sub(py0.shiftRight(l.add(1))).greaterThan(1)), () => {
          l.addAssign(1);
        });
        l.assign(TSL.min(l, levelCount.sub(1)));
        // The level's place in the buffer: each level half the last, rounded up.
        const offset = TSL.uint(0).toVar();
        const lw = W.add(1).div(2).toVar();
        const lh = H.add(1).div(2).toVar();
        TSL.Loop({ start: TSL.uint(0), end: l, type: 'uint', condition: '<', name: 'k' }, () => {
          offset.addAssign(lw.mul(lh));
          lw.assign(lw.add(1).div(2));
          lh.assign(lh.add(1).div(2));
        });
        const tx0 = TSL.min(px0.shiftRight(l.add(1)), lw.sub(1));
        const tx1 = TSL.min(px1.shiftRight(l.add(1)), lw.sub(1));
        const ty0 = TSL.min(py0.shiftRight(l.add(1)), lh.sub(1));
        const ty1 = TSL.min(py1.shiftRight(l.add(1)), lh.sub(1));
        const at = (x: N, y: N): N => levels.element(offset.add(y.mul(lw)).add(x));
        const farthest = farther(farther(at(tx0, ty0), at(tx1, ty0)), farther(at(tx0, ty1), at(tx1, ty1)));
        const depth = depthOfViewZNode(nearZ, near, far, { perspective, reversed, logarithmic });
        const hidden = reversed ? depth.lessThan(farthest.sub(HIDDEN_DEPTH_MARGIN)) : depth.greaterThan(farthest.add(HIDDEN_DEPTH_MARGIN));
        show.assign(hidden.not());
      });
      return show;
    };
  }

  /**
   * The last frame's drawn counts and answers, read back from the GPU (one read at a time, into one buffer): the
   * diagnostics' counts, and each draw tested whole told whether it was seen.
   */
  private readBack(): void {
    const rows: { whole: WholeRow | null; n: number; first: boolean; terrain: boolean }[] = this.frameRows.map((d) => (d.whole === true ? { whole: d, n: 1, first: d.firstPass, terrain: false } : { whole: null, n: d.n, first: d.firstPass, terrain: d.handle.mesh.userData[OCCLUDEE_KIND_KEY] === 'terrain' }));
    if (rows.length === 0) return;
    const args = this.args;
    const bytes = rows.length * ARGS_STRIDE * 4;
    this.readback ??= new ReadbackBuffer(this.rows * ARGS_STRIDE * 4);
    const target = this.readback;
    this.reading = true;
    void this.renderer
      .getArrayBufferAsync(args as never, target as never, 0, bytes)
      .then(() => {
        if (target.buffer === null) return;
        const a = new Uint32Array(target.buffer, 0, rows.length * ARGS_STRIDE);
        let tested = 0;
        let drawn1 = 0;
        let drawn2 = 0;
        let pass1Left = 0;
        const whole = { tested: 0, second: 0, culled: 0 };
        const terrain = { tested: 0, culled: 0 };
        rows.forEach((r, i) => {
          if (r.whole !== null) {
            const seen = a[i * ARGS_STRIDE + 1]! !== 0;
            whole.tested += 1;
            if (!r.first) {
              whole.second += 1;
              if (!seen) whole.culled += 1;
            }
            r.whole.answer(seen);
            return;
          }
          const n1 = r.first ? a[i * ARGS_STRIDE + 1]! : 0;
          const n2 = a[i * ARGS_STRIDE + ARGS_PASS + 1]!;
          tested += r.n;
          drawn1 += n1;
          drawn2 += n2;
          if (r.first) pass1Left += r.n - n1;
          if (r.terrain) {
            terrain.tested += r.n;
            terrain.culled += Math.max(0, r.n - n1 - n2);
          }
        });
        this.read = { tested, drawn1, drawn2, pass1Left, whole, terrain };
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        try {
          target.release();
          // Replaced while it was read (the arguments grew, or the culler was disposed): freed now.
          if (target !== this.readback) target.dispose();
        } catch {
          // The renderer was disposed while the read was in flight (Play stopped): its memory book was reset with it,
          // so three's own dispose bookkeeping throws for a buffer it no longer lists; nothing is left to free.
        }
      });
  }

  private dropReadback(): void {
    // One being read is freed once its read lands (readBack).
    const r = this.readback;
    this.readback = null;
    if (r !== null && !this.reading) r.dispose();
  }
}
