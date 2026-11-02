/**
 * Density stored only where a voxel is partly full.
 *
 * A voxel's shape is implied by its material: air is empty, anything else
 * is full. Only a voxel whose shape differs from that, a **surface voxel**
 * (a partly full cell on a smooth surface, a liquid's top cell, or any
 * other cell whose stored shape is not the implied one), carries its own
 * density byte. Voxels inside the ground or a wall and the air around them
 * carry none.
 *
 * In memory the surface voxels of a chunk are one sorted array of
 * `cell << 8 | density`, found by binary search: a chunk with a surface
 * holds about one such voxel per column (a few hundred to a thousand), and
 * only reads of surface voxels search it.
 */
import { MATERIAL_AIR, SHAPE_EMPTY, SHAPE_FULL } from './record';

/** The shape a voxel has without a stored density byte. */
export function impliedShape(material: number): number {
  return material === MATERIAL_AIR ? SHAPE_EMPTY : SHAPE_FULL;
}

/** Whether a voxel carries its own density byte (its shape is not the one its material implies). */
export function isSurfaceVoxel(material: number, shape: number): boolean {
  return shape !== impliedShape(material);
}

export class SurfaceDensity {
  private cells: Uint32Array;
  private n: number;

  private constructor(cells: Uint32Array, n: number) {
    this.cells = cells;
    this.n = n;
  }

  /** An empty list. */
  static empty(): SurfaceDensity {
    return new SurfaceDensity(new Uint32Array(4), 0);
  }

  /** The list of `count` surface voxels: cell indices (ascending) and their density bytes. */
  static from(cells: ArrayLike<number>, density: ArrayLike<number>, count: number): SurfaceDensity {
    const a = new Uint32Array(Math.max(4, count));
    for (let k = 0; k < count; k++) a[k] = ((cells[k]! << 8) | density[k]!) >>> 0;
    return new SurfaceDensity(a, count);
  }

  /** The sorted `cell << 8 | density` words for a worker message (copied when `copy`, else handed over). */
  toWire(copy: boolean): Uint32Array {
    return copy || this.cells.length !== this.n ? this.cells.slice(0, this.n) : this.cells;
  }

  /** A list over a wire's words (adopted); throws unless they ascend by cell and lie inside a chunk of `cells` cells. */
  static fromWire(words: Uint32Array, cells: number): SurfaceDensity {
    for (let k = 0; k < words.length; k++) {
      const c = words[k]! >>> 8;
      if (c >= cells || (k > 0 && c <= words[k - 1]! >>> 8)) throw new RangeError('density wire: cells out of order or outside the chunk');
    }
    return new SurfaceDensity(words.length > 0 ? words : new Uint32Array(4), words.length);
  }

  /** Surface voxels held. */
  get count(): number {
    return this.n;
  }

  private search(cell: number): number {
    let lo = 0;
    let hi = this.n - 1;
    const a = this.cells;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = a[mid]! >>> 8;
      if (c < cell) lo = mid + 1;
      else if (c > cell) hi = mid - 1;
      else return mid;
    }
    return ~lo;
  }

  /** The density byte of a surface voxel (0 when the cell is not in the list). */
  get(cell: number): number {
    const k = this.search(cell);
    return k >= 0 ? this.cells[k]! & 0xff : 0;
  }

  /** Stores a cell's density byte. */
  put(cell: number, density: number): void {
    const k = this.search(cell);
    const v = ((cell << 8) | density) >>> 0;
    if (k >= 0) {
      this.cells[k] = v;
      return;
    }
    const at = ~k;
    if (this.n === this.cells.length) {
      const grown = new Uint32Array(Math.ceil(this.cells.length * 1.5) + 1);
      grown.set(this.cells);
      this.cells = grown;
    }
    this.cells.copyWithin(at + 1, at, this.n);
    this.cells[at] = v;
    this.n++;
  }

  /** Forgets a cell (no-op when absent). */
  remove(cell: number): void {
    const k = this.search(cell);
    if (k < 0) return;
    this.cells.copyWithin(k, k + 1, this.n);
    this.n--;
  }

  /** The k-th surface voxel's cell and density (ascending cell order). */
  cellAt(k: number): number {
    return this.cells[k]! >>> 8;
  }

  densityAt(k: number): number {
    return this.cells[k]! & 0xff;
  }

  bytes(): number {
    return this.cells.byteLength;
  }
}
