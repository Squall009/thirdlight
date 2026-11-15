/**
 * Which program a voxel draw takes (`VoxelSurface.materialFor`), decided once
 * per draw from what its shader grid holds and its level, so no pixel pays
 * for what its draw cannot show:
 *
 * - one solid material in the whole grid (border cells included: the blend
 *   reads them): the second material's set is never read;
 * - the projection: on level 0 a draw with any terrain material reads its
 *   sets triplanar; one of construction alone reads one projection, the
 *   grid's (the same pixels); coarser levels (64 m and out) read one
 *   projection on terrain too, the normal's largest axis.
 */
import { MATERIAL_BITS, SHADER_CONSTRUCTION_BIT } from '@thirdlight/voxel';

import type { VoxelSurfacePath } from './voxel-surface';

/** The page flag for comparisons: `?voxelPaths=full` draws every voxel draw with the full program. */
export const VOXEL_PATHS_URL_PARAM = 'voxelPaths';

/** Whether a page's query string asks for per-draw paths (anything but `full`). */
export function voxelPathsFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(VOXEL_PATHS_URL_PARAM) !== 'full';
}

/**
 * The page flag for comparisons: `?voxelShadows=off` draws a game page's voxel worlds as if they had no shadows
 * (their surfaces and kit pieces neither cast nor receive), so a measurement or a picture can tell the shadows'
 * own share. Without it, a game page's voxel surfaces and kit pieces cast and receive like any lit draw.
 */
export const VOXEL_SHADOWS_URL_PARAM = 'voxelShadows';

/** Whether a page's query string leaves voxel shadows on (anything but `off`). */
export function voxelShadowsFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(VOXEL_SHADOWS_URL_PARAM) !== 'off';
}

/** The first level whose draws read terrain on one projection. */
export const AXIS_PROJECTION_LEVEL = 1;

/**
 * The path of a draw at `level` whose grid is `cells` (entries as the shader decodes them), or whose one solid
 * entry is `solid` (≥ 0: no grid).
 */
export function voxelDrawPath(cells: Uint16Array | null, solid: number, level: number): VoxelSurfacePath {
  const mask = 2 ** MATERIAL_BITS;
  let first = -1;
  let two = false;
  let terrain = false;
  const take = (entry: number): void => {
    const mat = (entry % mask) + (entry >= SHADER_CONSTRUCTION_BIT ? mask : 0);
    if (mat === 0) return;
    if (mat < mask) terrain = true;
    if (first < 0) first = mat;
    else if (mat !== first) two = true;
  };
  if (solid >= 0 || cells === null) take(Math.max(0, solid));
  else for (let i = 0; i < cells.length && !(two && terrain); i++) take(cells[i]!);
  return { materials: two ? 2 : 1, projection: level >= AXIS_PROJECTION_LEVEL || !terrain ? 'axis' : 'blend' };
}
