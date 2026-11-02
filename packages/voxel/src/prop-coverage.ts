/**
 * The prop lighting-occupancy channel: how much of each cell the props
 * marked "affects lighting" cover, as a coverage byte (0 … 255 for
 * 0 … 1). It is a memory form only: never part of the world voxels (so it
 * changes no meshing, assembly or collision), never written to a file;
 * a chunk's channel is rebuilt from the prop list when the chunk loads and
 * when a prop over it is placed or moved.
 *
 * A prop is voxelized into the grid it stands in by sampling its shape at
 * {@link PROP_SAMPLES_PER_AXIS}³ points per host cell: the cell's coverage
 * is the share of points inside. Props overlapping in a cell combine as
 * 1 − (1 − a)(1 − b), and the light tracer reads the construction's
 * coverage (derived-data.ts) combined the same way with this channel.
 */
import type { ChunkGrid } from './coords';
import { cellBit, type LightOut } from './derived-data';

/** Sample points per axis per host cell. */
export const PROP_SAMPLES_PER_AXIS = 4;

/** Combines two coverages (bytes) as 1 − (1 − a)(1 − b), rounded. */
export function combineCoverage(a: number, b: number): number {
  return 255 - Math.round(((255 - a) * (255 - b)) / 255);
}

/**
 * A placed prop's shape for voxelizing: an inside test in the prop's own
 * metres (in a game, sampled from the model's distance-field bricks),
 * its local bounds, and its placement in the host grid (position in
 * metres from the grid's origin, yaw as cos/sin, uniform scale).
 */
export interface PropShape {
  inside(x: number, y: number, z: number): boolean;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly yaw: readonly [number, number];
  readonly scale: number;
}

/** A prop's host-grid bounds in metres (its local box turned and scaled). */
function propBounds(p: PropShape): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const [c, s] = p.yaw;
  for (let k = 0; k < 8; k++) {
    const lx = (k & 1 ? p.max[0] : p.min[0]) * p.scale;
    const ly = (k & 2 ? p.max[1] : p.min[1]) * p.scale;
    const lz = (k & 4 ? p.max[2] : p.min[2]) * p.scale;
    const w = [p.position[0] + c * lx + s * lz, p.position[1] + ly, p.position[2] - s * lx + c * lz];
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, w[a]!);
      max[a] = Math.max(max[a]!, w[a]!);
    }
  }
  return { min, max };
}

/**
 * A chunk's prop channel, rebuilt from the props over it: one coverage
 * byte per cell (local index), or null when no prop covers any of it.
 */
export function propCoverageChunk(grid: ChunkGrid, cx: number, cy: number, cz: number, props: readonly PropShape[], cellM: number): Uint8Array | null {
  const e = grid.edge;
  let out: Uint8Array | null = null;
  const n = PROP_SAMPLES_PER_AXIS;
  const x0 = cx << grid.shift;
  const y0 = cy << grid.shift;
  const z0 = cz << grid.shift;
  for (const p of props) {
    const b = propBounds(p);
    const lo = (a: number, o: number): number => Math.max(0, Math.floor(b.min[a]! / cellM) - o);
    const hi = (a: number, o: number): number => Math.min(e, Math.floor(b.max[a]! / cellM) - o + 1);
    const [xl, xh, yl, yh, zl, zh] = [lo(0, x0), hi(0, x0), lo(1, y0), hi(1, y0), lo(2, z0), hi(2, z0)];
    if (xl >= xh || yl >= yh || zl >= zh) continue;
    const [c, s] = p.yaw;
    const inv = 1 / p.scale;
    for (let x = xl; x < xh; x++) for (let z = zl; z < zh; z++) for (let y = yl; y < yh; y++) {
      let inside = 0;
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) {
        // A sample point in host metres, then into the prop's own frame (inverse yaw, scale).
        const wx = (x0 + x + (i + 0.5) / n) * cellM - p.position[0];
        const wy = (y0 + y + (j + 0.5) / n) * cellM - p.position[1];
        const wz = (z0 + z + (k + 0.5) / n) * cellM - p.position[2];
        if (p.inside((c * wx - s * wz) * inv, wy * inv, (s * wx + c * wz) * inv)) inside++;
      }
      if (inside === 0) continue;
      out ??= new Uint8Array(grid.cellsPerChunk);
      const idx = (((x << grid.shift) | z) << grid.shift) | y;
      out[idx] = combineCoverage(out[idx]!, Math.round((inside * 255) / (n * n * n)));
    }
  }
  return out;
}

/**
 * The light tracer's coverage of a chunk: the construction's (a derived
 * chunk's light output) combined with the prop channel, one byte a cell.
 */
export function lightCoverage(grid: ChunkGrid, light: LightOut, props: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(grid.cellsPerChunk);
  if (light.uniform >= 0) out.fill(light.uniform);
  else {
    for (let i = 0; i < out.length; i++) if (cellBit(light.full, i)) out[i] = 255;
    for (let k = 0; k < light.partialCells.length; k++) out[light.partialCells[k]!] = light.partialCover[k]!;
  }
  if (props !== null) for (let i = 0; i < out.length; i++) if (props[i] !== 0) out[i] = combineCoverage(out[i]!, props[i]!);
  return out;
}
