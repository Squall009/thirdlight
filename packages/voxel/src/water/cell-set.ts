/**
 * A set of world cells held as bits in blocks of 32³ cells, and a queue of
 * cells: what the level fill walks with. A lake of 250 m across is about
 * 500 × 500 columns a few cells deep, a few hundred blocks of 4 KiB; a set
 * of numbers a cell would take tens of megabytes for the same lake.
 *
 * Pure: no I/O.
 */
import { WORLD_CELL_MAX_XZ, WORLD_CELL_MAX_Y, WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y } from '../coords';

/** Cells along a block's edge (a power of two). */
const BLOCK_SHIFT = 5;
const BLOCK_MASK = (1 << BLOCK_SHIFT) - 1;
const BLOCK_WORDS = (1 << (3 * BLOCK_SHIFT)) >>> 5;
const SPAN_XZ = (WORLD_CELL_MAX_XZ - WORLD_CELL_MIN_XZ + 1) >> BLOCK_SHIFT;
const SPAN_Y = (WORLD_CELL_MAX_Y - WORLD_CELL_MIN_Y + 1) >> BLOCK_SHIFT;

const blockKey = (x: number, y: number, z: number): number => (((x - WORLD_CELL_MIN_XZ) >> BLOCK_SHIFT) * SPAN_XZ + ((z - WORLD_CELL_MIN_XZ) >> BLOCK_SHIFT)) * SPAN_Y + ((y - WORLD_CELL_MIN_Y) >> BLOCK_SHIFT);
const bitOf = (x: number, y: number, z: number): number => (((x & BLOCK_MASK) << BLOCK_SHIFT) | (z & BLOCK_MASK)) << BLOCK_SHIFT | (y & BLOCK_MASK);

/** World cells (inside the world's bounds) as a set. */
export class CellSet {
  private readonly blocks = new Map<number, Uint32Array>();
  private n = 0;

  /** Cells in the set. */
  get size(): number {
    return this.n;
  }

  has(x: number, y: number, z: number): boolean {
    const b = this.blocks.get(blockKey(x, y, z));
    if (b === undefined) return false;
    const i = bitOf(x, y, z);
    return (b[i >>> 5]! & (1 << (i & 31))) !== 0;
  }

  /** Adds a cell; false when it was in already. */
  add(x: number, y: number, z: number): boolean {
    const k = blockKey(x, y, z);
    let b = this.blocks.get(k);
    if (b === undefined) this.blocks.set(k, (b = new Uint32Array(BLOCK_WORDS)));
    const i = bitOf(x, y, z);
    const w = i >>> 5;
    const m = 1 << (i & 31);
    if ((b[w]! & m) !== 0) return false;
    b[w] = b[w]! | m;
    this.n++;
    return true;
  }

  /** Removes a cell; false when it was not in. */
  delete(x: number, y: number, z: number): boolean {
    const k = blockKey(x, y, z);
    const b = this.blocks.get(k);
    if (b === undefined) return false;
    const i = bitOf(x, y, z);
    const w = i >>> 5;
    const m = 1 << (i & 31);
    if ((b[w]! & m) === 0) return false;
    b[w] = b[w]! & ~m;
    this.n--;
    if (this.n === 0) this.blocks.clear();
    return true;
  }

  /** Bytes the set holds (what a memory report counts). */
  get byteLength(): number {
    return this.blocks.size * BLOCK_WORDS * 4;
  }

  /** Every cell, block by block (x, z, y order inside a block): `fn(x, y, z)`. */
  forEach(fn: (x: number, y: number, z: number) => void): void {
    for (const [k, b] of this.blocks) {
      const by = (k % SPAN_Y) * (1 << BLOCK_SHIFT) + WORLD_CELL_MIN_Y;
      const rest = Math.floor(k / SPAN_Y);
      const bz = (rest % SPAN_XZ) * (1 << BLOCK_SHIFT) + WORLD_CELL_MIN_XZ;
      const bx = Math.floor(rest / SPAN_XZ) * (1 << BLOCK_SHIFT) + WORLD_CELL_MIN_XZ;
      for (let w = 0; w < BLOCK_WORDS; w++) {
        let word = b[w]!;
        while (word !== 0) {
          const t = word & -word;
          const i = (w << 5) | (31 - Math.clz32(t));
          word ^= t;
          fn(bx + (i >>> (2 * BLOCK_SHIFT)), by + (i & BLOCK_MASK), bz + ((i >>> BLOCK_SHIFT) & BLOCK_MASK));
        }
      }
    }
  }

  /** A copy (the set it was made from can change after). */
  clone(): CellSet {
    const c = new CellSet();
    for (const [k, b] of this.blocks) c.blocks.set(k, b.slice());
    c.n = this.n;
    return c;
  }
}

/** A first-in, first-out queue of cells (x, y, z), grown as it fills. */
export class CellQueue {
  private q = new Int32Array(3 * 1024);
  private head = 0;
  private tail = 0;

  get length(): number {
    return (this.tail - this.head) / 3;
  }

  push(x: number, y: number, z: number): void {
    if (this.tail + 3 > this.q.length) {
      // Reuse the consumed front before growing.
      const live = this.tail - this.head;
      if (live + 3 > this.q.length >> 1) {
        const next = new Int32Array(this.q.length * 2);
        next.set(this.q.subarray(this.head, this.tail), 0);
        this.q = next;
      } else this.q.copyWithin(0, this.head, this.tail);
      this.head = 0;
      this.tail = live;
    }
    this.q[this.tail++] = x;
    this.q[this.tail++] = y;
    this.q[this.tail++] = z;
  }

  /** The next cell into `out` (false: empty). */
  shift(out: [number, number, number]): boolean {
    if (this.head === this.tail) return false;
    out[0] = this.q[this.head++]!;
    out[1] = this.q[this.head++]!;
    out[2] = this.q[this.head++]!;
    return true;
  }
}
