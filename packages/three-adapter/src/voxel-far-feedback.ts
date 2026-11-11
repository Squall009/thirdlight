/**
 * The far field's visibility feedback on WebGPU: what its nodes were seen
 * at, for the far tree's selection where the world runs (far-seen.ts), read
 * back a frame or two late and never waited for.
 *
 * - **The reduction.** Right after the visibility pass (voxel-far-visibility.ts)
 *   has drawn its target, two compute dispatches in one pass: the first
 *   clears a storage buffer of two words a brick region of the atlas, the
 *   second reads the target a texel every {@link FAR_FEEDBACK_PIXEL_STEP}
 *   pixels a side and, where it holds a hit, adds one to its brick's count
 *   and keeps the nearest view depth (`atomicMin` on the depth's bits: a
 *   positive float orders as its bits). Per brick, not per node: the texel
 *   names the brick, and the region's node is known here, so the GPU needs
 *   no table of its own.
 * - **The readback.** The buffer is copied for reading in the same turn
 *   (three's `getArrayBufferAsync`: the copy is submitted when it is asked
 *   for, after the dispatches), and mapped whenever the GPU gets there; a
 *   round is made only while none is out, at most every
 *   {@link FAR_FEEDBACK_EVERY_FRAMES} passes. Nothing in the frame waits
 *   for it.
 * - **Versions.** Regions change hands as nodes come and go. Each region's
 *   owner is stamped with the far view's version when it was given
 *   ({@link FarRegionOwners}); a round carries the version and the atlas's
 *   shape of the frame it reduced, and a region given since (or given
 *   back) is left out of it: a late result never speaks for a node drawn
 *   after it.
 */
import type * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { DISTANCE_BRICK_SIDE, FAR_SEEN_STRIDE, mipNodeKey, VOXEL_SIZE_M, type FarSeenWire, type MipNode } from '@thirdlight/voxel';

import { releaseStorage } from './dispose';
import type { N } from './effects-tsl';
import { texelTexture } from './texel-texture-node';
import { FAR_VIS_FACE_SCALE } from './voxel-far-visibility';

const TSL: N = TSLTyped;

/** Visibility passes between two rounds at most (at 30 Hz about 7 rounds a second, each a frame or two late). */
export const FAR_FEEDBACK_EVERY_FRAMES = 4;

/**
 * Pixels a side one reduction thread stands for: a node that shows over a few pixels is met, and a quarter of
 * the threads and atomics of reading every pixel are spent.
 */
export const FAR_FEEDBACK_PIXEL_STEP = 2;

/** The page flag for comparisons: `?farFeedback=off` makes no rounds (the selection by screen error alone). */
export const FAR_FEEDBACK_URL_PARAM = 'farFeedback';

/** Whether a page's query string leaves the far field's visibility feedback on (anything but `off`). */
export function farFeedbackFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(FAR_FEEDBACK_URL_PARAM) !== 'off';
}

/** A brick's nearest depth before anything was hit there: +infinity's bits (every depth's bits are below them). */
export const FAR_FEEDBACK_NO_DEPTH = 0x7f800000;

/** Threads a side of the reduction's workgroups, and of the clear's one row. */
const GROUP_SIDE = 8;
const CLEAR_GROUP = 64;

/** A brick region's place in the feedback buffer, from its place in the atlas (regions along each axis `dims`). */
export function farFeedbackIndex(b: readonly [number, number, number], dims: readonly [number, number, number]): number {
  return b[0] + dims[0] * (b[1] + dims[1] * b[2]);
}

/** The brick a visibility texel's first float names, a byte an axis (voxel-far-visibility.ts's packing). */
function brickOf(r: number): [number, number, number] {
  return [r % 256, Math.floor(r / 256) % 256, Math.floor(r / 65536)];
}

/**
 * The reduction on the CPU (what the compute pass does, for tests and the in-page check): per brick region two
 * words, the hit texels counted (one a {@link FAR_FEEDBACK_PIXEL_STEP} a side) and the nearest view depth's bits.
 * `texels` RGBA floats, row by row from the top.
 */
export function reduceFarVisibility(texels: Float32Array, width: number, height: number, dims: readonly [number, number, number], step = FAR_FEEDBACK_PIXEL_STEP): Uint32Array {
  const cap = dims[0] * dims[1] * dims[2];
  const out = new Uint32Array(cap * 2);
  for (let i = 0; i < cap; i++) out[i * 2 + 1] = FAR_FEEDBACK_NO_DEPTH;
  const bits = new Float32Array(1);
  const asUint = new Uint32Array(bits.buffer);
  for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
    const o = (y * width + x) * 4;
    if (!(texels[o + 3]! >= FAR_VIS_FACE_SCALE - 0.5)) continue;
    const b = brickOf(Math.round(texels[o]!));
    if (b[0] >= dims[0] || b[1] >= dims[1] || b[2] >= dims[2]) continue;
    const k = farFeedbackIndex(b, dims);
    out[k * 2]!++;
    bits[0] = Math.max(0, -texels[o + 2]!);
    if (asUint[0]! < out[k * 2 + 1]!) out[k * 2 + 1] = asUint[0]!;
  }
  return out;
}

/**
 * Who holds each brick region of the atlas, and since which version of the far view: a round reduced at version
 * `v` speaks only for regions given at or before `v` and still held.
 */
export class FarRegionOwners {
  private readonly owners = new Map<number, { readonly node: MipNode; readonly since: number }>();
  /** Bumped by the far view once a change of its nodes is applied. */
  version = 0;

  /** A node's regions (texel origins) are its from this version on. */
  give(node: MipNode, regions: readonly THREE.Vector3[]): void {
    for (const r of regions) this.owners.set(packRegion(r), { node, since: this.version });
  }

  /** The regions are given back. */
  take(regions: readonly THREE.Vector3[]): void {
    for (const r of regions) this.owners.delete(packRegion(r));
  }

  get size(): number {
    return this.owners.size;
  }

  /**
   * A reduced buffer (two words a region, {@link reduceFarVisibility}'s layout) as the far field's round: each node
   * its pixels (the counted texels × the step's square) and its nearest depth in cells; regions given after
   * `version` or no longer held are left out (`stale` counts them).
   */
  round(data: Uint32Array, dims: readonly [number, number, number], version: number, step: number, round: number, farSeq: number): { wire: FarSeenWire; stale: number; bricks: number } {
    const nodes = new Map<string, { node: MipNode; pixels: number; nearest: number }>();
    const bits = new Uint32Array(1);
    const depth = new Float32Array(bits.buffer);
    const cap = Math.min(data.length / 2, dims[0] * dims[1] * dims[2]);
    let stale = 0;
    let bricks = 0;
    for (let k = 0; k < cap; k++) {
      const n = data[k * 2]!;
      if (n === 0) continue;
      const x = k % dims[0];
      const y = Math.floor(k / dims[0]) % dims[1];
      const z = Math.floor(k / (dims[0] * dims[1]));
      const o = this.owners.get(x + 256 * y + 65536 * z);
      if (o === undefined || o.since > version) {
        stale++;
        continue;
      }
      bricks++;
      bits[0] = data[k * 2 + 1]!;
      const key = mipNodeKey(o.node);
      const e = nodes.get(key);
      if (e === undefined) nodes.set(key, { node: o.node, pixels: n * step * step, nearest: depth[0]! });
      else {
        e.pixels += n * step * step;
        e.nearest = Math.min(e.nearest, depth[0]!);
      }
    }
    const flat: number[] = [];
    for (const e of nodes.values()) flat.push(e.node.level, e.node.nx, e.node.ny, e.node.nz, e.pixels, e.nearest / VOXEL_SIZE_M);
    if (flat.length !== nodes.size * FAR_SEEN_STRIDE) throw new Error('far feedback: a node took the wrong number of words');
    return { wire: { round, farSeq, nodes: flat }, stale, bricks };
  }
}

/** A region's origin (texels) as the texel's packed brick. */
function packRegion(r: THREE.Vector3): number {
  const S = DISTANCE_BRICK_SIDE;
  return r.x / S + 256 * (r.y / S) + 65536 * (r.z / S);
}

/** What the feedback dispatches and reads back with (three's WebGPU renderer). */
export interface FarFeedbackRenderer {
  compute(nodes: unknown): unknown;
  getArrayBufferAsync(attribute: unknown, target?: null, offset?: number, count?: number): Promise<ArrayBuffer>;
  readRenderTargetPixelsAsync?(target: THREE.RenderTarget, x: number, y: number, width: number, height: number): Promise<ArrayBufferView>;
}

/** The atlas as a round needs it: its regions along each axis and the far view's version. */
export interface FarFeedbackAtlas {
  readonly dims: readonly [number, number, number];
  readonly version: number;
  /** The far view's last applied far event ({@link FarSeenWire.farSeq}). */
  readonly farSeq: number;
}

/** A round read back: the buffer as reduced and what it was reduced at (the in-page check adds the CPU's reduction). */
export interface FarFeedbackResult {
  readonly round: number;
  readonly data: Uint32Array;
  readonly atlas: FarFeedbackAtlas;
  /** Passes drawn between the dispatch and the readback. */
  readonly frames: number;
  readonly ms: number;
  /** The CPU's reduction of the same target (only when a check was asked for). */
  readonly cpu?: Uint32Array;
}

/** The reduction and its readback for one far view's visibility target. */
export class FarFeedback {
  private buffer: N = null;
  private words = 0;
  private clearPass: N = null;
  private reducePass: N = null;
  private readonly size = { width: TSL.uniform(1, 'uint'), height: TSL.uniform(1, 'uint'), dimX: TSL.uniform(1, 'uint'), dimY: TSL.uniform(1, 'uint'), regions: TSL.uniform(0, 'uint') };
  private out = false;
  private passes = 0;
  private round = 0;
  /** Ask for the target's own pixels beside the next round (an e2e compares the GPU's reduction with the CPU's). */
  checkNext = false;
  readonly stats = { rounds: 0, readBack: 0, failed: 0, lastFrames: 0, lastMs: 0 };

  /** The target's texture the passes read (they are made again for another). */
  private texture: THREE.Texture | null = null;

  constructor(
    private readonly onResult: (r: FarFeedbackResult) => void,
    readonly step = FAR_FEEDBACK_PIXEL_STEP,
  ) {}

  /** GPU bytes of the buffer. */
  get gpuBytes(): number {
    return this.words * 4;
  }

  /** After a visibility pass into `target` (its size the frame's): a round when one is due and none is out. */
  frame(renderer: FarFeedbackRenderer, target: THREE.RenderTarget, atlas: FarFeedbackAtlas): void {
    this.passes++;
    if (this.out || this.passes % FAR_FEEDBACK_EVERY_FRAMES !== 0) return;
    const regions = atlas.dims[0] * atlas.dims[1] * atlas.dims[2];
    if (regions === 0) return;
    if (regions * 2 > this.words || target.texture !== this.texture) this.allocate(renderer, regions * 2, target.texture);
    const w = target.width;
    const h = target.height;
    this.size.width.value = w;
    this.size.height.value = h;
    this.size.dimX.value = atlas.dims[0];
    this.size.dimY.value = atlas.dims[1];
    this.size.regions.value = regions;
    this.clearPass.dispatchSize = [Math.ceil((regions * 2) / CLEAR_GROUP), 1, 1];
    this.reducePass.dispatchSize = [Math.ceil(Math.ceil(w / this.step) / GROUP_SIDE), Math.ceil(Math.ceil(h / this.step) / GROUP_SIDE), 1];
    void renderer.compute([this.clearPass, this.reducePass]);
    const round = ++this.round;
    const at = { dims: [atlas.dims[0], atlas.dims[1], atlas.dims[2]] as const, version: atlas.version, farSeq: atlas.farSeq };
    const t0 = performance.now();
    const p0 = this.passes;
    this.out = true;
    this.stats.rounds++;
    const check = this.checkNext && renderer.readRenderTargetPixelsAsync !== undefined;
    this.checkNext = false;
    // Both copies are submitted now, in the queue after the dispatches and before the next frame.
    const data = renderer.getArrayBufferAsync(this.buffer.value, null, 0, regions * 2 * 4);
    const pixels = check ? renderer.readRenderTargetPixelsAsync!(target, 0, 0, w, h) : Promise.resolve(null);
    Promise.all([data, pixels]).then(
      ([bytes, px]) => {
        this.out = false;
        this.stats.readBack++;
        this.stats.lastFrames = this.passes - p0;
        this.stats.lastMs = performance.now() - t0;
        const cpu = px === null ? undefined : reduceFarVisibility(new Float32Array(px.buffer, px.byteOffset, w * h * 4), w, h, at.dims, this.step);
        this.onResult({ round, data: new Uint32Array(bytes), atlas: at, frames: this.stats.lastFrames, ms: this.stats.lastMs, ...(cpu !== undefined ? { cpu } : {}) });
      },
      () => {
        this.out = false;
        this.stats.failed++;
      },
    );
  }

  private allocate(renderer: FarFeedbackRenderer, words: number, texture: THREE.Texture): void {
    this.free(renderer);
    this.texture = texture;
    // Room for the atlas to grow a while before the passes are made again.
    this.words = Math.max(1024, 2 ** Math.ceil(Math.log2(words)));
    this.buffer = TSL.instancedArray(this.words, 'uint');
    const counts: N = TSL.storage(this.buffer.value, 'uint', this.words).toAtomic();
    const { width, height, dimX, dimY, regions } = this.size;
    this.clearPass = TSL.Fn(() => {
      const i = TSL.workgroupId.x.mul(CLEAR_GROUP).add(TSL.localId.x);
      TSL.If(i.lessThan(regions.mul(2)), () => {
        TSL.atomicStore(counts.element(i), TSL.select(i.bitAnd(1).equal(1), TSL.uint(FAR_FEEDBACK_NO_DEPTH), TSL.uint(0)));
      });
    })().compute([1, 1, 1], [CLEAR_GROUP]);
    const vis = texelTexture(texture);
    const step = this.step;
    this.reducePass = TSL.Fn(() => {
      const x = TSL.workgroupId.x.mul(GROUP_SIDE).add(TSL.localId.x).mul(step);
      const y = TSL.workgroupId.y.mul(GROUP_SIDE).add(TSL.localId.y).mul(step);
      TSL.If(x.lessThan(width).and(y.lessThan(height)), () => {
        const t = vis.load(TSL.ivec2(TSL.int(x), TSL.int(y))).toVar();
        TSL.If(t.w.greaterThanEqual(FAR_VIS_FACE_SCALE - 0.5), () => {
          const r = TSL.uint(TSL.round(t.x)).toVar();
          const bx = r.bitAnd(255);
          const by = r.shiftRight(8).bitAnd(255);
          const bz = r.shiftRight(16);
          const k = bx.add(dimX.mul(by.add(dimY.mul(bz)))).toVar();
          TSL.If(bx.lessThan(dimX).and(by.lessThan(dimY)).and(k.lessThan(regions)), () => {
            TSL.atomicAdd(counts.element(k.mul(2)), TSL.uint(1));
            TSL.atomicMin(counts.element(k.mul(2).add(1)), TSL.floatBitsToUint(TSL.max(t.z.negate(), 0)));
          });
        });
      });
    })().compute([1, 1, 1], [GROUP_SIDE, GROUP_SIDE]);
  }

  private free(renderer: FarFeedbackRenderer): void {
    this.clearPass?.dispose?.();
    this.reducePass?.dispose?.();
    this.clearPass = this.reducePass = null;
    if (this.buffer !== null) releaseStorage(renderer, [this.buffer.value]);
    this.buffer = null;
    this.words = 0;
  }

  dispose(renderer: FarFeedbackRenderer): void {
    this.free(renderer);
  }
}

/** A round's texels the GPU and the CPU reduction disagree on (the in-page check; 0 is the pass). */
export function farFeedbackMismatch(gpu: Uint32Array, cpu: Uint32Array): { regions: number; hits: number; cpuHits: number; differ: number } {
  let hits = 0;
  let cpuHits = 0;
  let differ = 0;
  const n = Math.min(gpu.length, cpu.length) / 2;
  for (let k = 0; k < n; k++) {
    hits += gpu[k * 2]!;
    cpuHits += cpu[k * 2]!;
    if (gpu[k * 2] !== cpu[k * 2] || (cpu[k * 2]! > 0 && gpu[k * 2 + 1] !== cpu[k * 2 + 1])) differ++;
  }
  return { regions: n, hits, cpuHits, differ };
}
