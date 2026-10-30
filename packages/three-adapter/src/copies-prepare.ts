/**
 * The arithmetic of a set of stored copies drawn on the GPU (`copies-gpu.ts`),
 * apart from three.js so it runs on a worker: the copies put in an order
 * where neighbours on the ground are neighbours in the list (a k-d split
 * of the set's ground into runs of a block each), cut into blocks the page culls and lists per
 * frame, and written as the texels the vertex stage reads.
 *
 * A copy is {@link COPY_TEXELS} RGBA float texels: its place and thinning
 * rank, its turn (a quaternion), its scale and its paint slot. A block is the
 * unit a draw lists: its copies' origins' sphere and their smallest and
 * largest scale, so the page can tell, without a loop over the copies, which
 * levels of detail its copies may draw at and whether the view sees it.
 *
 * The copies are first cut into chunks (the instance sets' grid,
 * `chunkCopies`: no chunk wider than the set's chunk size), and a block
 * never holds copies of two chunks: the chunk size stays what it says, how
 * finely the set is culled.
 *
 * Pure: plain arrays, no three.js (the worker bundle stays small).
 */
import { INSTANCE_FLOATS } from '@thirdlight/project-model';

import { chunkCopies, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS } from './instance-prepare';

/** Texels a copy takes in the copy texture (12 floats). */
export const COPY_TEXELS = 3;
/** Floats a copy takes in the copy texture. */
export const COPY_TEXEL_FLOATS = COPY_TEXELS * 4;
/** Copies a row of the copy texture holds (its width is three times this). */
export const COPY_ROW = 1024;
/**
 * Most copies per block (a listed block is one entry of a draw's list; a set
 * of fewer copies takes a smaller power of two). A draw runs its vertex stage
 * for a whole block's worth of instances per entry, so a small block wastes
 * little where a chunk's last block is short; the page lists a few thousand
 * blocks a frame for a landscape's forest at this size.
 */
export const COPY_BLOCK_MAX = 64;
/** Floats per block in {@link PreparedCopies.blocks}: sphere centre xyz and radius (origins), smallest and largest scale, first slot, count. */
export const BLOCK_FLOATS = 8;

/** A set's copies as the GPU and the page's culling read them. */
export interface PreparedCopies {
  readonly count: number;
  /** Chunks the copies were cut into (their blocks culled on their own). */
  readonly chunks: number;
  /** Copies per block (a power of two, at most {@link COPY_BLOCK_MAX}). */
  readonly block: number;
  /** Each slot's copy (the index in the buffer it came from). */
  readonly order: Uint32Array;
  /** The texels, slot by slot ({@link COPY_TEXEL_FLOATS} each), padded to whole rows of {@link COPY_ROW}. */
  readonly texels: Float32Array;
  readonly blocks: Float32Array;
}

/** A copy's place in the thinning order: a hash of its index, so neighbours thin evenly and the order never changes. */
export function copyRank(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The block size of a set of `count` copies: the smallest power of two that holds it, at most {@link COPY_BLOCK_MAX}. */
export function copyBlockSize(count: number): number {
  let b = 1;
  while (b < count && b < COPY_BLOCK_MAX) b *= 2;
  return b;
}

/** 2^24: a packed sort key's low part (a copy's place in its run; runs stay far below it). */
const KEY_LOW = 16777216;

/** `order[lo, hi)` sorted by the copies' coordinate `axis` (0: x, 2: z), ties by their place in the run: one native sort of packed keys. */
function sortedBy(floats: Float32Array, order: Uint32Array, lo: number, hi: number, axis: number): Uint32Array {
  const n = hi - lo;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let s = lo; s < hi; s++) {
    const v = floats[order[s]! * INSTANCE_FLOATS + axis]!;
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  // 2^28 steps across the run: exact as a float64 key with the place below it.
  const q = v1 > v0 ? 268435455 / (v1 - v0) : 0;
  const keys = new Float64Array(n);
  for (let j = 0; j < n; j++) keys[j] = Math.floor((floats[order[lo + j]! * INSTANCE_FLOATS + axis]! - v0) * q) * KEY_LOW + j;
  keys.sort();
  const out = new Uint32Array(n);
  for (let j = 0; j < n; j++) out[j] = order[lo + (keys[j]! % KEY_LOW)]!;
  return out;
}

/**
 * Order `order[lo, hi)` so every run of `block` copies from `lo` is compact on
 * the ground: a k-d tree whose leaves are the blocks, split at a multiple of
 * `block` across the wider axis. The copies are sorted along each axis once;
 * a split keeps both orders by partitioning the other one (linear a level).
 */
function splitBlocks(floats: Float32Array, order: Uint32Array, lo: number, hi: number, block: number): void {
  if (hi - lo <= block) return;
  const xs = sortedBy(floats, order, lo, hi, 0);
  const zs = sortedBy(floats, order, lo, hi, 2);
  const left = new Uint8Array(floats.length / INSTANCE_FLOATS);
  const scratch = new Uint32Array(hi - lo);
  const split = (a: number, b: number): void => {
    if (b - a <= block) {
      order.set(xs.subarray(a, b), lo + a);
      return;
    }
    const at = (list: Uint32Array, i: number, axis: number): number => floats[list[i]! * INSTANCE_FLOATS + axis]!;
    const byX = at(xs, b - 1, 0) - at(xs, a, 0) >= at(zs, b - 1, 2) - at(zs, a, 2);
    const mid = a + Math.ceil((b - a) / block / 2) * block;
    const [cut, other] = byX ? [xs, zs] : [zs, xs];
    for (let i = a; i < b; i++) left[cut[i]!] = i < mid ? 1 : 0;
    // The other order split the same way, each side keeping its order.
    let l = 0;
    let r = mid - a;
    for (let i = a; i < b; i++) scratch[left[other[i]!] === 1 ? l++ : r++] = other[i]!;
    other.set(scratch.subarray(0, b - a), a);
    split(a, mid);
    split(mid, b);
  };
  split(0, hi - lo);
}

/** Write the copy at float `o` of `floats` (position, quaternion, scale) into slot `slot` of `texels`, with its thinning rank and paint slot (0: none). */
export function writeCopyTexels(floats: ArrayLike<number>, o: number, rank: number, texels: Float32Array, slot: number, paintSlot = 0): void {
  const t = slot * COPY_TEXEL_FLOATS;
  texels[t] = floats[o]!;
  texels[t + 1] = floats[o + 1]!;
  texels[t + 2] = floats[o + 2]!;
  texels[t + 3] = rank;
  texels[t + 4] = floats[o + 3]!;
  texels[t + 5] = floats[o + 4]!;
  texels[t + 6] = floats[o + 5]!;
  texels[t + 7] = floats[o + 6]!;
  texels[t + 8] = floats[o + 7]!;
  texels[t + 9] = floats[o + 8]!;
  texels[t + 10] = floats[o + 9]!;
  texels[t + 11] = paintSlot;
}

/** Block `b`'s sphere and scales from the texels of its slots. */
export function measureBlock(texels: Float32Array, blocks: Float32Array, b: number): void {
  const o = b * BLOCK_FLOATS;
  const first = blocks[o + 6]!;
  const n = blocks[o + 7]!;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let lo = Infinity;
  let hi = 0;
  for (let s = first; s < first + n; s++) {
    const t = s * COPY_TEXEL_FLOATS;
    const x = texels[t]!, y = texels[t + 1]!, z = texels[t + 2]!;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    const sc = Math.max(Math.abs(texels[t + 8]!), Math.abs(texels[t + 9]!), Math.abs(texels[t + 10]!));
    lo = Math.min(lo, sc);
    hi = Math.max(hi, sc);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let r = 0;
  for (let s = first; s < first + n; s++) {
    const t = s * COPY_TEXEL_FLOATS;
    r = Math.max(r, Math.hypot(texels[t]! - cx, texels[t + 1]! - cy, texels[t + 2]! - cz));
  }
  blocks[o] = cx;
  blocks[o + 1] = cy;
  blocks[o + 2] = cz;
  blocks[o + 3] = r;
  blocks[o + 4] = Number.isFinite(lo) ? lo : 0;
  blocks[o + 5] = hi;
}

/** How a set's copies are cut into chunks: no chunk wider than `chunkSize` (m; absent: by count only), about `copiesPerChunk` copies each. */
export interface CopyChunking {
  readonly chunkSize?: number;
  readonly copiesPerChunk?: number;
}

/**
 * Order, chunk, block and write the first `count` copies of `floats` (see
 * the module's header); `paintSlotOf` gives a copy's paint slot (+1; 0: none).
 */
export function prepareCopies(floats: Float32Array, count: number, chunking: CopyChunking = {}, paintSlotOf?: (copy: number) => number): PreparedCopies {
  const n = Math.max(0, Math.min(count, Math.floor(floats.length / INSTANCE_FLOATS)));
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions.set(floats.subarray(i * INSTANCE_FLOATS, i * INSTANCE_FLOATS + 3), i * 3);
  const chunkOf = chunkCopies(positions, n, chunking.copiesPerChunk ?? INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, chunking.chunkSize);
  let chunks = 0;
  for (let i = 0; i < n; i++) chunks = Math.max(chunks, chunkOf[i]! + 1);
  // Each chunk's copies together, in the buffer's order within it.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => chunkOf[a]! - chunkOf[b]! || a - b);
  const block = copyBlockSize(n);
  const runs: number[] = [];
  for (let lo = 0; lo < n; ) {
    let hi = lo + 1;
    while (hi < n && chunkOf[order[hi]!] === chunkOf[order[lo]!]) hi++;
    splitBlocks(floats, order, lo, hi, block);
    for (let b = lo; b < hi; b += block) runs.push(b, Math.min(block, hi - b));
    lo = hi;
  }
  const rows = Math.max(1, Math.ceil(n / COPY_ROW));
  const texels = new Float32Array(rows * COPY_ROW * COPY_TEXEL_FLOATS);
  for (let s = 0; s < n; s++) writeCopyTexels(floats, order[s]! * INSTANCE_FLOATS, copyRank(order[s]!), texels, s, paintSlotOf?.(order[s]!) ?? 0);
  const blockCount = runs.length / 2;
  const blocks = new Float32Array(blockCount * BLOCK_FLOATS);
  for (let b = 0; b < blockCount; b++) {
    blocks[b * BLOCK_FLOATS + 6] = runs[b * 2]!;
    blocks[b * BLOCK_FLOATS + 7] = runs[b * 2 + 1]!;
    measureBlock(texels, blocks, b);
  }
  return { count: n, chunks, block, order, texels, blocks };
}

/** The buffers a prepared set hands over (a worker's answer). */
export function preparedCopyBuffers(p: PreparedCopies): ArrayBuffer[] {
  return [p.order.buffer as ArrayBuffer, p.texels.buffer as ArrayBuffer, p.blocks.buffer as ArrayBuffer];
}

/**
 * The level of detail a copy `distance` away (in the levels' units: metres
 * over the view's zoom and the project's bias) at largest scale `scale` draws
 * at: the last level whose switch distance (times the scale) it has reached.
 * The vertex stage's rule; the page lists blocks and counts copies with it.
 */
export function copyLevel(distances: ArrayLike<number>, distance: number, scale: number): number {
  let l = 0;
  for (let k = 1; k < distances.length; k++) if (distance >= distances[k]! * scale) l = k;
  return l;
}

/** The share of copies kept at `distance` for a copy whose falloff runs from `from` to `to` (`min` past it). */
export function copyDensityAt(distance: number, from: number, to: number, min: number): number {
  if (distance <= from) return 1;
  if (distance >= to || to <= from) return min;
  return 1 - ((1 - min) * (distance - from)) / (to - from);
}
