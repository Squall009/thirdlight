/**
 * A chunk as palettes plus entry ids plus surface densities, in plain
 * arrays: what import builds from cells, what decode reads from bytes and
 * what encode writes. Building it from cells numbers palette entries in
 * order of first appearance (cells in {@link localIndex} order), so equal
 * cells always give an equal image, whatever edits led to them.
 *
 * Two kinds: a record palette (one palette whose entries are whole voxels:
 * material, category and orientation packed in a 32-bit value, flagged when
 * its cells carry a density byte) and per-plane palettes (one palette per
 * field: material with the density flag, category, orientation).
 */
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { createPlaneImage, type PlaneImage } from './palette-plane';
import { PLANE_BIT } from './record';
import { impliedShape } from './surface-density';

/** A record palette value: material (16 bits), category (8), orientation (8). */
export function recordValue(material: number, category: number, orientation: number): number {
  return (material | (category << 16) | (orientation << 24)) >>> 0;
}

export function valueMaterial(v: number): number {
  return v & 0xffff;
}

export function valueCategory(v: number): number {
  return (v >>> 16) & 0xff;
}

export function valueOrientation(v: number): number {
  return v >>> 24;
}

export type PaletteKind = 'record' | 'planes';

/** One chunk's palettes, entry ids and surface densities. */
export interface ChunkImage {
  readonly grid: ChunkGrid;
  kind: PaletteKind;
  /** Record: [record]. Planes: [material (flagged = density), category, orientation]. */
  readonly planes: readonly [PlaneImage, PlaneImage, PlaneImage];
  /** Surface voxels: cells (ascending) and their density bytes. */
  readonly densCells: Uint16Array;
  readonly densValues: Uint8Array;
  densCount: number;
}

/** An image with room for any chunk of `grid`. */
export function createChunkImage(grid: ChunkGrid): ChunkImage {
  const n = grid.cellsPerChunk;
  return {
    grid,
    kind: 'record',
    planes: [createPlaneImage(grid), createPlaneImage(grid), createPlaneImage(grid)],
    densCells: new Uint16Array(n),
    densValues: new Uint8Array(n),
    densCount: 0,
  };
}

/** Reused key → entry maps (single-threaded use only). */
const recordIds = new Map<number, number>();
const smallIds = new Int32Array(1 << 17).fill(-1);
const smallTouched: number[] = [];

function resetSmall(): void {
  for (const k of smallTouched) smallIds[k] = -1;
  smallTouched.length = 0;
}

/**
 * Fills `img` from a chunk's cells as a record palette, keeping only the
 * planes in `mask` (a dropped plane reads 0; a dropped shape plane reads as
 * the implied shape, so no density is kept).
 */
export function recordImageFromCells(cells: DenseChunk, mask: number, img: ChunkImage): void {
  img.kind = 'record';
  const p = img.planes[0];
  const n = img.grid.cellsPerChunk;
  const { material: M, category: C, shape: S, orientation: O } = cells;
  const keepC = (mask & PLANE_BIT.category) !== 0;
  const keepO = (mask & PLANE_BIT.orientation) !== 0;
  const keepS = (mask & PLANE_BIT.shape) !== 0;
  recordIds.clear();
  let count = 0;
  let dc = 0;
  // The previous cell's key and entry: neighbouring cells (a column, y fastest) usually share one.
  let prevKey = -1;
  let prevEntry = -1;
  for (let i = 0; i < n; i++) {
    const m = M[i]!;
    const implied = impliedShape(m);
    const s = keepS ? S[i]! : implied;
    const flagged = s !== implied;
    const v = recordValue(m, keepC ? C[i]! : 0, keepO ? O[i]! : 0);
    const key = v + (flagged ? 4294967296 : 0);
    let e = prevEntry;
    if (key !== prevKey) {
      const known = recordIds.get(key);
      if (known === undefined) {
        e = count++;
        recordIds.set(key, e);
        p.values[e] = v;
        p.flags[e] = flagged ? 1 : 0;
        p.counts[e] = 0;
      } else {
        e = known;
      }
      prevKey = key;
      prevEntry = e;
    }
    p.ids[i] = e;
    p.counts[e]!++;
    if (flagged) {
      img.densCells[dc] = i;
      img.densValues[dc] = s;
      dc++;
    }
  }
  p.count = count;
  img.densCount = dc;
}

/** Fills `img` from a chunk's cells as per-plane palettes (planes outside `mask` hold one entry, 0). */
export function planesImageFromCells(cells: DenseChunk, mask: number, img: ChunkImage): void {
  img.kind = 'planes';
  const n = img.grid.cellsPerChunk;
  const keepS = (mask & PLANE_BIT.shape) !== 0;
  const [pm, pc, po] = img.planes;
  // Material plane: key = material + flag × 65536.
  resetSmall();
  let count = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    const m = cells.material[i]!;
    const implied = impliedShape(m);
    const s = keepS ? cells.shape[i]! : implied;
    const flagged = s !== implied;
    const key = m + (flagged ? 65536 : 0);
    let e = smallIds[key]!;
    if (e < 0) {
      e = count++;
      smallIds[key] = e;
      smallTouched.push(key);
      pm.values[e] = m;
      pm.flags[e] = flagged ? 1 : 0;
      pm.counts[e] = 0;
    }
    pm.ids[i] = e;
    pm.counts[e]!++;
    if (flagged) {
      img.densCells[dc] = i;
      img.densValues[dc] = s;
      dc++;
    }
  }
  pm.count = count;
  img.densCount = dc;
  bytePlaneImage(cells.category, (mask & PLANE_BIT.category) !== 0, pc, n);
  bytePlaneImage(cells.orientation, (mask & PLANE_BIT.orientation) !== 0, po, n);
}

function bytePlaneImage(src: Uint8Array, keep: boolean, p: PlaneImage, n: number): void {
  resetSmall();
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = keep ? src[i]! : 0;
    let e = smallIds[v]!;
    if (e < 0) {
      e = count++;
      smallIds[v] = e;
      smallTouched.push(v);
      p.values[e] = v;
      p.flags[e] = 0;
      p.counts[e] = 0;
    }
    p.ids[i] = e;
    p.counts[e]!++;
  }
  p.count = count;
}

/** Writes an image's cells into `out` (every plane, every cell). */
export function imageToCells(img: ChunkImage, out: DenseChunk): void {
  const n = img.grid.cellsPerChunk;
  if (img.kind === 'record') {
    const p = img.planes[0];
    for (let i = 0; i < n; i++) {
      const v = p.values[p.ids[i]!]!;
      const m = valueMaterial(v);
      out.material[i] = m;
      out.category[i] = valueCategory(v);
      out.orientation[i] = valueOrientation(v);
      out.shape[i] = impliedShape(m);
    }
  } else {
    const [pm, pc, po] = img.planes;
    for (let i = 0; i < n; i++) {
      const m = pm.values[pm.ids[i]!]!;
      out.material[i] = m;
      out.shape[i] = impliedShape(m);
      out.category[i] = pc.values[pc.ids[i]!]!;
      out.orientation[i] = po.values[po.ids[i]!]!;
    }
  }
  for (let k = 0; k < img.densCount; k++) out.shape[img.densCells[k]!] = img.densValues[k]!;
}
