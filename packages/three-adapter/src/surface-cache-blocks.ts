/**
 * The surface cache's addressing of block layers: one chart per rectangle of
 * coplanar visible cell faces within a chunk column (greedy rectangles,
 * at most `SURFACE_CHART_METRES` a side), so neighbouring faces share their
 * texels' borders instead of each spending a margin of its own.
 *
 * A face is visible when its cell holds a block and the cell across the face
 * does not stop light (`opaque`, the tracer's own rule): every face a traced
 * ray can hit has a chart, and a face hidden behind an opaque neighbour has
 * none. Faces are named as the tracer names them: the cell, and the face as
 * axis × 2 (+ 1 when it faces −axis).
 *
 * Pure (no three.js).
 */
import { CHUNK_SIZE, type BlockCell } from '@thirdlight/runtime';

import { SURFACE_CHART_METRES, type SurfaceChart } from './surface-cache-atlas';

/** The plane axes (u, v) of a face on each axis: the tracer's (`fu`, `fv` of a block hit). */
export const FACE_PLANE_AXES: readonly (readonly [number, number])[] = [[2, 1], [0, 2], [0, 1]];

/** What a layer's addressing reads of its grid (a `BlockGridReader`). */
export interface SurfaceBlockGrid {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly cellSize: readonly number[];
  indexAt(x: number, y: number, z: number): number;
  valueOf(index: number): BlockCell;
  forEachInChunk(ck: string, cb: (x: number, y: number, z: number, index: number) => void): void;
}

/** One chunk column's charts and which chart each visible face lies in. */
export interface BlockChunkCharts {
  readonly charts: readonly SurfaceChart[];
  /** Visible faces. */
  readonly faces: number;
  /** Sorted face keys (`blockFaceKey`). */
  readonly keys: Uint32Array;
  /** Per key: its chart. */
  readonly chartOf: Uint32Array;
  /** Per key: the face's cell offset within its chart's rectangle (u | v << 8). */
  readonly offsets: Uint16Array;
  /** Per chart: its face, slice (the cells' coordinate on the face's axis) and first cell along u and v. */
  readonly frames: Int32Array;
}

/** A face's key within its chunk column: the cell's index in the column (from the grid's lowest row) × 6 + the face. */
export function blockFaceKey(grid: SurfaceBlockGrid, cx: number, cz: number, x: number, y: number, z: number, face: number): number {
  return (((y - grid.min[1]!) * CHUNK_SIZE + (z - cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)) * 6 + face;
}

/** Whether the cell at x, y, z stops light, through a per-palette-index memo of `opaque`. */
function opaqueAt(grid: SurfaceBlockGrid, opaque: (cell: BlockCell) => boolean, memo: Map<number, boolean>): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => {
    const i = grid.indexAt(x, y, z);
    if (i < 0) return false;
    let o = memo.get(i);
    if (o === undefined) memo.set(i, (o = opaque(grid.valueOf(i))));
    return o;
  };
}

/**
 * The charts of chunk column (cx, cz): its visible faces per direction and
 * slice, merged into greedy rectangles (rows along u first, then as many
 * whole rows along v as stay visible).
 */
export function blockChunkCharts(grid: SurfaceBlockGrid, opaque: (cell: BlockCell) => boolean, cx: number, cz: number, memo: Map<number, boolean> = new Map()): BlockChunkCharts {
  const isOpaque = opaqueAt(grid, opaque, memo);
  // Visible faces grouped by face and slice: the face's cells as (u, v) along its plane axes.
  const groups = new Map<string, { face: number; slice: number; cells: Set<number> }>();
  const BIAS = 1 << 15;
  const uvKey = (u: number, v: number): number => (u + BIAS) * 65536 + (v + BIAS);
  grid.forEachInChunk(`${cx},${cz}`, (x, y, z, index) => {
    if (grid.valueOf(index).block === undefined) return;
    const c = [x, y, z];
    for (let face = 0; face < 6; face += 1) {
      const axis = face >> 1;
      const n = [x, y, z];
      n[axis]! += face & 1 ? -1 : 1;
      if (isOpaque(n[0]!, n[1]!, n[2]!)) continue;
      const [pu, pv] = FACE_PLANE_AXES[axis]!;
      const gk = `${face},${c[axis]!}`;
      let g = groups.get(gk);
      if (g === undefined) groups.set(gk, (g = { face, slice: c[axis]!, cells: new Set() }));
      g.cells.add(uvKey(c[pu]!, c[pv]!));
    }
  });
  const charts: SurfaceChart[] = [];
  const frames: number[] = [];
  const entries: [number, number, number][] = [];
  let faces = 0;
  for (const g of [...groups.values()].sort((a, b) => a.face - b.face || a.slice - b.slice)) {
    const axis = g.face >> 1;
    const [pu, pv] = FACE_PLANE_AXES[axis]!;
    const maxU = Math.max(1, Math.min(255, Math.floor(SURFACE_CHART_METRES / grid.cellSize[pu]! + 1e-6)));
    const maxV = Math.max(1, Math.min(255, Math.floor(SURFACE_CHART_METRES / grid.cellSize[pv]! + 1e-6)));
    const cells = [...g.cells].map((k) => [Math.floor(k / 65536) - BIAS, (k % 65536) - BIAS] as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const taken = new Set<number>();
    const free = (u: number, v: number): boolean => g.cells.has(uvKey(u, v)) && !taken.has(uvKey(u, v));
    for (const [u0, v0] of cells) {
      if (taken.has(uvKey(u0, v0))) continue;
      let w = 1;
      while (w < maxU && free(u0 + w, v0)) w += 1;
      let h = 1;
      for (; h < maxV; h += 1) {
        let row = true;
        for (let i = 0; i < w && row; i += 1) row = free(u0 + i, v0 + h);
        if (!row) break;
      }
      const chart = charts.length;
      charts.push({ kind: 'area', w: w * grid.cellSize[pu]!, h: h * grid.cellSize[pv]! });
      frames.push(g.face, g.slice, u0, v0);
      for (let j = 0; j < h; j += 1) {
        for (let i = 0; i < w; i += 1) {
          taken.add(uvKey(u0 + i, v0 + j));
          const cell = [0, 0, 0];
          cell[axis] = g.slice;
          cell[pu] = u0 + i;
          cell[pv] = v0 + j;
          entries.push([blockFaceKey(grid, cx, cz, cell[0]!, cell[1]!, cell[2]!, g.face), chart, i | (j << 8)]);
          faces += 1;
        }
      }
    }
  }
  entries.sort((a, b) => a[0] - b[0]);
  const keys = new Uint32Array(entries.length);
  const chartOf = new Uint32Array(entries.length);
  const offsets = new Uint16Array(entries.length);
  entries.forEach(([k, c, o], i) => {
    keys[i] = k;
    chartOf[i] = c;
    offsets[i] = o;
  });
  return { charts, faces, keys, chartOf, offsets, frames: Int32Array.from(frames) };
}

/** The chart and place (metres along its u and v) of a point on a face: `fu`, `fv` its fractions across the face (null: not a visible face). */
export function locateBlockFace(grid: SurfaceBlockGrid, charts: BlockChunkCharts, cx: number, cz: number, cell: readonly number[], face: number, fu: number, fv: number): { chart: number; u: number; v: number } | null {
  const key = blockFaceKey(grid, cx, cz, cell[0]!, cell[1]!, cell[2]!, face);
  let lo = 0;
  let hi = charts.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = charts.keys[mid]!;
    if (k === key) {
      const [pu, pv] = FACE_PLANE_AXES[face >> 1]!;
      const o = charts.offsets[mid]!;
      return { chart: charts.chartOf[mid]!, u: ((o & 255) + fu) * grid.cellSize[pu]!, v: ((o >> 8) + fv) * grid.cellSize[pv]! };
    }
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** The chunk column of an absolute cell. */
export function chunkOfCell(x: number, z: number): [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
}
