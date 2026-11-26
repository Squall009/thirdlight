/**
 * `ctx.voxels.surfaceAt`: the surface fields at a point, where a world runs.
 * The arithmetic is `@thirdlight/voxel`'s (surface-fields.ts, the per-point
 * form: the same fields a dressing rule reads); this module reads the
 * world's loaded cells for it and names the grid that answers.
 *
 * - **Read as it is.** The cells are the world's as the game sees them now
 *   (its changes included, the same step), so an answer is never behind an
 *   edit. Where a cell it needs is not loaded the answer is null, never a
 *   guess; the open space over the surface is read as far up as the world is
 *   loaded there.
 * - **Structures.** A structure's surface under the point (its own grid's
 *   cells, by the snap of the per-point form) answers before the world's,
 *   the lower grid id first: a point on a house's floor reads the floor, in
 *   that grid's cells alone. The world's own cells read a structure through
 *   its stamp: a stamped cell is closed (no ground under a house's floor, no
 *   sky under its roof) and counts as construction.
 */
import { cellInWorld, STAMP_CLASS, SURFACE_NO_ROW, SURFACE_UNKNOWN, surfacePoint, surfacePointOut, surfaceRowUnder, valueOf, VOXEL_SIZE_M, type PropLightChannel, type SurfaceSource, type VoxelRecord, type VoxelStreamer } from '@thirdlight/voxel';

import type { VoxelSurface } from './voxel-api';
import type { VoxelGridHost } from './voxel-grid-host';

const CELL: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
const OUT = surfacePointOut();

/** A chunk box (inclusive) a grid's cells lie in; null: no bound (the world grid). */
type Extent = { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } | null;

/**
 * A streamer's cells as the per-point form reads them, for a point in the
 * cell row `y`: not loaded is not known; outside the grid's chunks (and the
 * world) is air. `built`: the world's structure stamps.
 */
function sourceOf(s: VoxelStreamer, extent: Extent, y: number, channel: PropLightChannel | null): SurfaceSource {
  const sh = s.grid.shift;
  const m = s.grid.mask;
  // Reads run along columns: the last chunk asked is remembered.
  let kx = 0;
  let ky = 0;
  let kz = 0;
  let known = -1;
  const state = (cx: number, cy: number, cz: number): number => {
    if (known >= 0 && cx === kx && cy === ky && cz === kz) return known;
    kx = cx;
    ky = cy;
    kz = cz;
    const outside = extent !== null && (cx < extent.min[0] || cx > extent.max[0] || cy < extent.min[1] || cy > extent.max[1] || cz < extent.min[2] || cz > extent.max[2]);
    return (known = outside ? 0 : s.isResident(cx, cy, cz) ? 1 : 2);
  };
  const src: SurfaceSource = {
    cellM: VOXEL_SIZE_M,
    value: (x, r, z) => {
      if (!cellInWorld(x, r, z)) return 0;
      const st = state(x >> sh, r >> sh, z >> sh);
      if (st === 0) return 0;
      if (st === 2) return SURFACE_UNKNOWN;
      return valueOf(s.voxelAt(x, r, z, CELL));
    },
    top: (x, z) => {
      // As far up as chunks are loaded over the point's own.
      let cy = y >> sh;
      while (cellInWorld(x, (cy + 1) << sh, z) && state(x >> sh, cy + 1, z >> sh) === 1) cy++;
      return ((cy + 1) << sh) - 1;
    },
  };
  if (channel === null) return src;
  return {
    ...src,
    built: (x, r, z) => {
      if (!cellInWorld(x, r, z)) return false;
      const c = channel.rooms(x >> sh, r >> sh, z >> sh);
      return c !== null && c[((((x & m) << sh) | (z & m)) << sh) | (r & m)] === STAMP_CLASS.stop;
    },
  };
}

const cellOf = (v: number): number => Math.floor(v / VOXEL_SIZE_M);

/** The surface fields as a script reads them, from the kernel's values in a grid whose cells start `dy` metres up in the world. */
function answer(grid: number, at: readonly [number, number, number], dy: number, distances: boolean): VoxelSurface {
  const p = OUT;
  return Object.freeze({
    grid,
    at: Object.freeze([at[0], at[1], at[2]] as [number, number, number]),
    height: p.height + dy,
    slope: p.slope,
    material: p.material,
    role: p.role,
    wetness: p.wetness,
    sky: p.sky === 1,
    water: p.waterMaterial === 0 ? null : Object.freeze({ top: p.waterTop + dy, depth: p.waterDepth, material: p.waterMaterial }),
    gas: p.gasMaterial === 0 ? null : Object.freeze({ bottom: p.gasBottom + dy, top: p.gasTop + dy, density: p.gasDensity, material: p.gasMaterial }),
    materialEdge: distances ? p.materialEdge : null,
    construction: distances ? p.construction : null,
  });
}

/**
 * The surface under a world point (metres) and its fields: a structure's
 * (`grids` ascending by id) where one lies under the point, else the
 * world's own. Null: no surface within reach of the point, or a cell needed
 * is not loaded.
 */
export function surfaceAt(world: VoxelStreamer, channel: PropLightChannel | null, grids: readonly VoxelGridHost[], x: number, y: number, z: number, distances: boolean): VoxelSurface | null {
  const s = VOXEL_SIZE_M;
  for (const g of grids) {
    const e = g.extent;
    if (e === null) continue;
    const p = g.frame.toGrid(x, y, z);
    const c = [cellOf(p[0]), cellOf(p[1]), cellOf(p[2])] as const;
    const sh = g.streamer.grid.shift;
    // Only a grid whose chunks reach the point's column is asked.
    if ((c[0] >> sh) < e.min[0] || (c[0] >> sh) > e.max[0] || (c[2] >> sh) < e.min[2] || (c[2] >> sh) > e.max[2]) continue;
    const src = sourceOf(g.streamer, e, c[1], null);
    const row = surfaceRowUnder(src, c[0], c[1], c[2]);
    if (row === null) return null;
    if (row === SURFACE_NO_ROW) continue;
    const got = surfacePoint(src, c[0], row, c[2], distances, OUT);
    if (got !== true) return null;
    const dy = g.frame.toWorld(0, 0, 0)[1];
    return answer(g.frame.gridId, g.frame.toWorld((c[0] + 0.5) * s, (row + 0.5) * s, (c[2] + 0.5) * s), dy, distances);
  }
  const c = [cellOf(x), cellOf(y), cellOf(z)] as const;
  if (!cellInWorld(c[0], c[1], c[2])) return null;
  const got = surfacePoint(sourceOf(world, null, c[1], channel), c[0], c[1], c[2], distances, OUT);
  if (got !== true) return null;
  return answer(0, [(c[0] + 0.5) * s, (OUT.row + 0.5) * s, (c[2] + 0.5) * s], 0, distances);
}
