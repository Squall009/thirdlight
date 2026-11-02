/**
 * Sparse bricks under a per-chunk mask: the chunk is a grid of 4³-cell
 * bricks (8³ bricks in a 32³ chunk, 4³ in a 16³ one). A brick whose cells
 * all point at one palette entry is just that entry id; only a mixed brick
 * stores its 64 cells, bit-packed at the palette's width, in a pool of
 * brick slots. One bit per brick says which kind it is.
 *
 * Ground, sky and the inside of thick walls are uniform bricks, so a chunk
 * costs roughly its surface, not its volume. The mask is also a coarse
 * occupancy map for free: a uniform brick of an air entry is 64 empty cells
 * a ray or a mesher can skip at once.
 *
 * Mixed bricks that an edit makes uniform again go back to being one id
 * (checked by comparing the brick's words with the entry's repeated bit
 * pattern), and their slot is reused by the next brick that splits.
 */
import type { CellLayout } from './cell-layout';
import type { ChunkGrid } from './coords';
import { packedWidth } from './packed-width';

/** Cells along a brick's edge. */
export const BRICK_EDGE = 4;
const BRICK_SHIFT = 2;
/** Cells in a brick. */
export const BRICK_CELLS = BRICK_EDGE ** 3;

/** Bricks in a chunk of `grid`. */
export function bricksPerChunk(grid: ChunkGrid): number {
  return grid.cellsPerChunk / BRICK_CELLS;
}

const orders = new Map<number, Uint16Array>();

/**
 * The chunk's cell indices ({@link localIndex} order) brick by brick: brick
 * b's cells are entries b × 64 … b × 64 + 63, x then z then y inside the
 * brick, bricks numbered x, z, y like cells (y fastest). Cached per edge.
 */
export function brickOrder(grid: ChunkGrid): Uint16Array {
  let order = orders.get(grid.edge);
  if (order !== undefined) return order;
  order = new Uint16Array(grid.cellsPerChunk);
  const e = grid.edge;
  const nb = e >> BRICK_SHIFT;
  let k = 0;
  for (let bx = 0; bx < nb; bx++) for (let bz = 0; bz < nb; bz++) for (let by = 0; by < nb; by++) {
    for (let lx = 0; lx < BRICK_EDGE; lx++) for (let lz = 0; lz < BRICK_EDGE; lz++) for (let ly = 0; ly < BRICK_EDGE; ly++) {
      const x = (bx << BRICK_SHIFT) | lx;
      const z = (bz << BRICK_SHIFT) | lz;
      const y = (by << BRICK_SHIFT) | ly;
      order[k++] = (((x << grid.shift) | z) << grid.shift) | y;
    }
  }
  orders.set(grid.edge, order);
  return order;
}

/** A 32-bit word holding entry `e` in every `width`-bit field (width ≥ 1). */
export function repeatedId(e: number, width: number): number {
  let w = e;
  for (let b = width; b < 32; b <<= 1) w |= w << b;
  return w >>> 0;
}

export class BrickLayout implements CellLayout {
  readonly kind = 'bricks';
  readonly width: number;
  readonly capacity: number;
  private readonly grid: ChunkGrid;
  private readonly shift: number;
  private readonly mask: number;
  /** log2(bricks per side). */
  private readonly bshift: number;
  private readonly valueMask: number;
  /** 32-bit words a mixed brick takes (64 cells × width bits). */
  private readonly brickWords: number;
  /** Per brick: its entry id when uniform, else its slot in the pool. */
  private readonly brick: Uint16Array;
  /** One bit per brick, set when the brick is mixed. */
  private readonly mixed: Uint32Array;
  private pool: Uint32Array;
  /** Slots handed out so far; freed ones wait in `free`. */
  private slots = 0;
  private readonly free: number[] = [];

  constructor(grid: ChunkGrid, width: number, poolSlots = 0) {
    if (![0, 1, 2, 4, 8, 16].includes(width)) throw new RangeError(`brick width must be 0, 1, 2, 4, 8 or 16, got ${width}`);
    if (grid.edge < BRICK_EDGE * 2) throw new RangeError(`a ${grid.edge}³ chunk is too small for ${BRICK_EDGE}³ bricks`);
    this.width = width;
    this.capacity = 2 ** width;
    this.grid = grid;
    this.shift = grid.shift;
    this.mask = grid.mask;
    this.bshift = grid.shift - BRICK_SHIFT;
    this.valueMask = width === 0 ? 0 : (1 << width) - 1;
    this.brickWords = (BRICK_CELLS * width) >>> 5;
    const nb = bricksPerChunk(grid);
    this.brick = new Uint16Array(nb);
    this.mixed = new Uint32Array(nb >>> 5);
    this.pool = new Uint32Array(poolSlots * this.brickWords);
  }

  /** A layout of the narrowest width for `count` entries holding `ids`. */
  static from(grid: ChunkGrid, ids: Uint16Array, count: number): BrickLayout {
    const width = packedWidth(count);
    const order = brickOrder(grid);
    const nb = bricksPerChunk(grid);
    if (width === 0) return new BrickLayout(grid, 0);
    let mixedCount = 0;
    for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) if (!brickUniform(ids, order, k)) mixedCount++;
    const l = new BrickLayout(grid, width, mixedCount);
    for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) {
      if (brickUniform(ids, order, k)) {
        l.brick[b] = ids[order[k]!]!;
        continue;
      }
      const slot = l.slots++;
      l.brick[b] = slot;
      l.mixed[b >>> 5]! |= 1 << (b & 31);
      const base = slot * l.brickWords;
      for (let j = 0; j < BRICK_CELLS; j++) {
        const bit = j * width;
        l.pool[base + (bit >>> 5)]! |= ids[order[k + j]!]! << (bit & 31);
      }
    }
    return l;
  }

  /** Bricks whose cells are stored (not one id). */
  get mixedBricks(): number {
    let n = 0;
    for (const w of this.mixed) {
      let v = w;
      while (v !== 0) {
        v &= v - 1;
        n++;
      }
    }
    return n;
  }

  get(i: number): number {
    const m = this.mask;
    const s = this.shift;
    const y = i & m;
    const z = (i >>> s) & m;
    const x = i >>> (s << 1);
    const bs = this.bshift;
    const b = ((x >>> BRICK_SHIFT) << (bs << 1)) | ((z >>> BRICK_SHIFT) << bs) | (y >>> BRICK_SHIFT);
    if (((this.mixed[b >>> 5]! >>> (b & 31)) & 1) === 0) return this.brick[b]!;
    const bit = (((x & 3) << 4) | ((z & 3) << 2) | (y & 3)) * this.width;
    return (this.pool[this.brick[b]! * this.brickWords + (bit >>> 5)]! >>> (bit & 31)) & this.valueMask;
  }

  set(i: number, e: number): void {
    if (this.width === 0) return;
    const m = this.mask;
    const s = this.shift;
    const y = i & m;
    const z = (i >>> s) & m;
    const x = i >>> (s << 1);
    const bs = this.bshift;
    const b = ((x >>> BRICK_SHIFT) << (bs << 1)) | ((z >>> BRICK_SHIFT) << bs) | (y >>> BRICK_SHIFT);
    const bw = this.brickWords;
    let slot: number;
    if (((this.mixed[b >>> 5]! >>> (b & 31)) & 1) === 0) {
      const u = this.brick[b]!;
      if (u === e) return;
      slot = this.alloc();
      this.pool.fill(repeatedId(u, this.width), slot * bw, slot * bw + bw);
      this.brick[b] = slot;
      this.mixed[b >>> 5]! |= 1 << (b & 31);
    } else {
      slot = this.brick[b]!;
    }
    const bit = (((x & 3) << 4) | ((z & 3) << 2) | (y & 3)) * this.width;
    const k = slot * bw + (bit >>> 5);
    const sh = bit & 31;
    this.pool[k] = ((this.pool[k]! & ~(this.valueMask << sh)) | (e << sh)) >>> 0;
    // The brick collapses back to one id when every word is e's repeated pattern.
    const p = repeatedId(e, this.width);
    for (let j = slot * bw; j < slot * bw + bw; j++) if (this.pool[j] !== p) return;
    this.free.push(slot);
    this.brick[b] = e;
    this.mixed[b >>> 5]! &= ~(1 << (b & 31));
  }

  private alloc(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    const slot = this.slots++;
    const need = this.slots * this.brickWords;
    if (need > this.pool.length) {
      const grown = new Uint32Array(Math.max(need, Math.ceil(this.pool.length * 1.5)));
      grown.set(this.pool);
      this.pool = grown;
    }
    return slot;
  }

  unpack(ids: Uint16Array): void {
    const order = brickOrder(this.grid);
    const nb = this.brick.length;
    const w = this.width;
    const vm = this.valueMask;
    for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) {
      if (((this.mixed[b >>> 5]! >>> (b & 31)) & 1) === 0) {
        const v = this.brick[b]!;
        for (let j = 0; j < BRICK_CELLS; j++) ids[order[k + j]!] = v;
        continue;
      }
      const base = this.brick[b]! * this.brickWords;
      for (let j = 0; j < BRICK_CELLS; j++) {
        const bit = j * w;
        ids[order[k + j]!] = (this.pool[base + (bit >>> 5)]! >>> (bit & 31)) & vm;
      }
    }
  }

  bytes(): number {
    return this.brick.byteLength + this.mixed.byteLength + this.pool.byteLength;
  }
}

/** Whether the 64 cells of the brick starting at `k` in `order` share one id. */
export function brickUniform(ids: Uint16Array, order: Uint16Array, k: number): boolean {
  const v = ids[order[k]!];
  for (let j = 1; j < BRICK_CELLS; j++) if (ids[order[k + j]!] !== v) return false;
  return true;
}
