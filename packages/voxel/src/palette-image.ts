/**
 * A chunk as palettes plus entry ids, in plain arrays: what import builds
 * from cells, what decode reads from bytes and what encode writes. Building
 * it from cells numbers palette entries in order of first appearance (cells
 * in {@link localIndex} order), so equal cells always give an equal image,
 * whatever edits led to them.
 *
 * Two kinds: a record palette (one palette whose entries are whole voxel
 * values, record.ts: material, role, shape and wetness in one u32) and
 * per-plane palettes (one palette per field, a measurement candidate).
 */
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { createPlaneImage, type PlaneImage } from './palette-plane';
import { PLANE_BIT, recordValue, valueMaterial, valueRole, valueShape, valueWetness } from './record';

export type PaletteKind = 'record' | 'planes';

/** One chunk's palettes and entry ids. */
export interface ChunkImage {
  readonly grid: ChunkGrid;
  kind: PaletteKind;
  /** Record: [values]. Planes: [material, role, shape, wetness]. */
  readonly planes: readonly [PlaneImage, PlaneImage, PlaneImage, PlaneImage];
}

/** An image with room for any chunk of `grid`. */
export function createChunkImage(grid: ChunkGrid): ChunkImage {
  return { grid, kind: 'record', planes: [createPlaneImage(grid), createPlaneImage(grid), createPlaneImage(grid), createPlaneImage(grid)] };
}

/** Reused key → entry maps (single-threaded use only). */
const recordIds = new Map<number, number>();
const smallIds = new Int32Array(1 << 16).fill(-1);
const smallTouched: number[] = [];

function resetSmall(): void {
  for (const k of smallTouched) smallIds[k] = -1;
  smallTouched.length = 0;
}

/**
 * Fills `img` from a chunk's cells as a record palette, keeping only the
 * fields in `mask` (a dropped field reads 0; air is always the value 0).
 */
export function recordImageFromCells(cells: DenseChunk, mask: number, img: ChunkImage): void {
  img.kind = 'record';
  const p = img.planes[0];
  const n = img.grid.cellsPerChunk;
  const { material: M, role: R, shape: S, wetness: W } = cells;
  const keepR = (mask & PLANE_BIT.role) !== 0;
  const keepS = (mask & PLANE_BIT.shape) !== 0;
  const keepW = (mask & PLANE_BIT.wetness) !== 0;
  recordIds.clear();
  let count = 0;
  // The previous cell's value and entry: neighbouring cells (a column, y fastest) usually share one.
  let prevKey = -1;
  let prevEntry = -1;
  for (let i = 0; i < n; i++) {
    const m = M[i]!;
    const v = m === 0 ? 0 : recordValue(m, keepR ? R[i]! : 0, keepS ? S[i]! : 0, keepW ? W[i]! : 0);
    let e = prevEntry;
    if (v !== prevKey) {
      const known = recordIds.get(v);
      if (known === undefined) {
        e = count++;
        recordIds.set(v, e);
        p.values[e] = v;
        p.counts[e] = 0;
      } else {
        e = known;
      }
      prevKey = v;
      prevEntry = e;
    }
    p.ids[i] = e;
    p.counts[e]!++;
  }
  p.count = count;
}

/** Fills `img` from a chunk's cells as per-plane palettes (planes outside `mask` hold one entry, 0). */
export function planesImageFromCells(cells: DenseChunk, mask: number, img: ChunkImage): void {
  img.kind = 'planes';
  const n = img.grid.cellsPerChunk;
  const [pm, pr, ps, pw] = img.planes;
  planeImage(cells.material, true, pm, n);
  planeImage(cells.role, (mask & PLANE_BIT.role) !== 0, pr, n);
  planeImage(cells.shape, (mask & PLANE_BIT.shape) !== 0, ps, n);
  planeImage(cells.wetness, (mask & PLANE_BIT.wetness) !== 0, pw, n);
}

function planeImage(src: Uint8Array | Uint16Array, keep: boolean, p: PlaneImage, n: number): void {
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
      p.counts[e] = 0;
    }
    p.ids[i] = e;
    p.counts[e]!++;
  }
  p.count = count;
}

/** Writes an image's cells into `out` (every field, every cell). */
export function imageToCells(img: ChunkImage, out: DenseChunk): void {
  const n = img.grid.cellsPerChunk;
  if (img.kind === 'record') {
    const p = img.planes[0];
    for (let i = 0; i < n; i++) {
      const v = p.values[p.ids[i]!]!;
      out.material[i] = valueMaterial(v);
      out.role[i] = valueRole(v);
      out.shape[i] = valueShape(v);
      out.wetness[i] = valueWetness(v);
    }
  } else {
    const [pm, pr, ps, pw] = img.planes;
    for (let i = 0; i < n; i++) {
      out.material[i] = pm.values[pm.ids[i]!]!;
      out.role[i] = pr.values[pr.ids[i]!]!;
      out.shape[i] = ps.values[ps.ids[i]!]!;
      out.wetness[i] = pw.values[pw.ids[i]!]!;
    }
  }
}

/** The one value of a uniform image (each palette one entry). */
export function uniformImageValue(img: ChunkImage): number {
  if (img.kind === 'record') return img.planes[0].values[0]!;
  const m = img.planes[0].values[0]!;
  return m === 0 ? 0 : recordValue(m, img.planes[1].values[0]!, img.planes[2].values[0]!, img.planes[3].values[0]!);
}

/** Whether an image is one voxel everywhere. */
export function imageIsUniform(img: ChunkImage): boolean {
  return img.kind === 'record' ? img.planes[0].count === 1 : img.planes.every((p) => p.count === 1);
}
