/**
 * A structure grid's voxels resampled into a world grid chunk's cells where
 * the grid stands: what the far field is built from (its kept levels are the
 * world's chunks downsampled, its baked bricks those levels' faces), so a
 * turned building is seen past its own rings at the world's cells, a cell
 * off at most, while the near field draws its own grid exactly.
 *
 * Each world cell the grid's turned box covers is sampled at
 * {@link GRID_RESAMPLE_SAMPLES}² points across its middle height; each point
 * falls in one grid cell. Where at least half the points fall in cells that
 * are not air (an opening counts: it is a construction cell drawn open), the
 * world cell takes the record the most of them hold (the first such in point
 * order on a tie): the majority of what the cell holds. Elsewhere the world's
 * own cell stands. A grid at yaw 0 on the world's cells copies its cells
 * exactly. Nothing is stored: the far cache's content is what this makes.
 */
import { localIndex, type ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import type { GridFrame } from './grid-place';
import { MATERIAL_AIR, recordValue, valueMaterial, valueRole, valueShape, valueWetness } from './record';
import { isPortalRole } from './role-traits';

/** Points a world cell is sampled at along each horizontal axis (yaw turns about the vertical: one height suffices). */
export const GRID_RESAMPLE_SAMPLES = 2;

/** A grid's record at a cell of its own frame (cells; 0: air, or outside what it holds). */
export type GridRecordAt = (x: number, y: number, z: number) => number;

/** The box of cells a grid holds, in its own frame (inclusive low, exclusive high). */
export interface GridCellBox {
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
}

/** The world cells (inclusive low, exclusive high) a grid's cell box covers where it stands. */
export function gridWorldCellBox(box: GridCellBox, frame: GridFrame, cellM: number): GridCellBox {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const w = frame.toWorld((k & 1 ? box.hi[0] : box.lo[0]) * cellM, (k & 2 ? box.hi[1] : box.lo[1]) * cellM, (k & 4 ? box.hi[2] : box.lo[2]) * cellM);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, w[a]!);
      max[a] = Math.max(max[a]!, w[a]!);
    }
  }
  const lo = min.map((v) => Math.floor(v / cellM)) as [number, number, number];
  const hi = max.map((v) => Math.ceil(v / cellM)) as [number, number, number];
  return { lo, hi };
}

/**
 * Resamples a grid (its records through `at`, its cell box `box`, standing at `frame`) into world chunk (cx, cy, cz)'s
 * cells `out` (the world's own cells already there). Returns the cells written.
 */
export function resampleGridInto(out: DenseChunk, grid: ChunkGrid, cx: number, cy: number, cz: number, frame: GridFrame, box: GridCellBox, at: GridRecordAt, cellM: number): number {
  const e = grid.edge;
  const w = gridWorldCellBox(box, frame, cellM);
  const x0 = Math.max(cx * e, w.lo[0]);
  const x1 = Math.min((cx + 1) * e, w.hi[0]);
  const y0 = Math.max(cy * e, w.lo[1]);
  const y1 = Math.min((cy + 1) * e, w.hi[1]);
  const z0 = Math.max(cz * e, w.lo[2]);
  const z1 = Math.min((cz + 1) * e, w.hi[2]);
  if (x0 >= x1 || y0 >= y1 || z0 >= z1) return 0;
  const S = GRID_RESAMPLE_SAMPLES;
  const n = S * S;
  const gx = new Int32Array(n);
  const gz = new Int32Array(n);
  const vals = new Uint32Array(n);
  let written = 0;
  for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
    // The column's points in the grid's frame, turned once for every height.
    let inside = 0;
    for (let i = 0; i < S; i++) for (let k = 0; k < S; k++) {
      const q = frame.toGrid((x + (i + 0.5) / S) * cellM, 0, (z + (k + 0.5) / S) * cellM);
      const p = i * S + k;
      gx[p] = Math.floor(q[0] / cellM);
      gz[p] = Math.floor(q[2] / cellM);
      if (gx[p]! >= box.lo[0] && gx[p]! < box.hi[0] && gz[p]! >= box.lo[2] && gz[p]! < box.hi[2]) inside++;
    }
    if (inside * 2 < n) continue;
    for (let y = y0; y < y1; y++) {
      const gy = Math.floor(((y + 0.5) * cellM - frame.position[1]) / cellM);
      if (gy < box.lo[1] || gy >= box.hi[1]) continue;
      let solid = 0;
      for (let p = 0; p < n; p++) {
        const v = gx[p]! >= box.lo[0] && gx[p]! < box.hi[0] && gz[p]! >= box.lo[2] && gz[p]! < box.hi[2] ? at(gx[p]!, gy, gz[p]!) : 0;
        vals[p] = v;
        if (v !== 0 && (valueMaterial(v) !== MATERIAL_AIR || isPortalRole(valueRole(v)))) solid++;
      }
      if (solid * 2 < n) continue;
      // The record the most points hold (the first such on a tie).
      let best = 0;
      let bestN = 0;
      for (let p = 0; p < n; p++) {
        const v = vals[p]!;
        if (v === 0 || (valueMaterial(v) === MATERIAL_AIR && !isPortalRole(valueRole(v)))) continue;
        let c = 0;
        for (let q = 0; q < n; q++) if (vals[q] === v) c++;
        if (c > bestN) {
          best = v;
          bestN = c;
        }
      }
      const i = localIndex(grid, x - cx * e, y - cy * e, z - cz * e);
      out.material[i] = valueMaterial(best);
      out.role[i] = valueRole(best);
      out.shape[i] = valueShape(best);
      out.wetness[i] = valueWetness(best);
      written++;
    }
  }
  return written;
}

/** A dense chunk's record at local index `i`. */
export function denseRecordAt(c: DenseChunk, i: number): number {
  return recordValue(c.material[i]!, c.role[i]!, c.shape[i]!, c.wetness[i]!);
}
