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

/**
 * The page flag for comparisons: `?voxelSun=off` turns a game page's sun march past the shadow map off
 * (voxel-sun-field.ts; the tier's `voxelSunSteps` decide otherwise), so a measurement or a picture can tell its share.
 */
export const VOXEL_SUN_URL_PARAM = 'voxelSun';

/** Whether a page's query string leaves the sun march to the tier (anything but `off`). */
export function voxelSunFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(VOXEL_SUN_URL_PARAM) !== 'off';
}

/**
 * Where a game page's voxel worlds keep their light (the lighting store; one switch for the stores being compared):
 * `off` draws them as before (sun, shadows and the clustered lights per pixel), `cache` lights their near surfaces in
 * the surface cache (surface-cache-voxels.ts), `volume` in a voxel light volume and `hybrid` both, the cache near and
 * the volume beyond. Set by the page's query, `?voxelLight=off|cache|volume|hybrid`.
 */
export const VOXEL_LIGHT_URL_PARAM = 'voxelLight';
export const VOXEL_LIGHT_STORES = ['off', 'cache', 'volume', 'hybrid'] as const;
export type VoxelLightStore = (typeof VOXEL_LIGHT_STORES)[number];
/** The store a page without the flag uses: today's picture, until the stores are chosen between. */
export const VOXEL_LIGHT_STORE_DEFAULT: VoxelLightStore = 'off';

/** The lighting store a page's query names (absent or unknown: the default). */
export function voxelLightStoreFromUrl(search: string): VoxelLightStore {
  const v = new URLSearchParams(search).get(VOXEL_LIGHT_URL_PARAM);
  return (VOXEL_LIGHT_STORES as readonly string[]).includes(v ?? '') ? (v as VoxelLightStore) : VOXEL_LIGHT_STORE_DEFAULT;
}

/** Whether a store keeps the near surfaces' light in the surface cache. */
export function voxelStoreUsesCache(store: VoxelLightStore): boolean {
  return store === 'cache' || store === 'hybrid';
}

/**
 * Whether the voxel surfaces read the surface cache's texels per pixel (its lamps' light with traced shadows): with
 * the cache alone. With both stores the cache's texels feed only its probes' bounce: a voxel surface's program
 * reading the texels and the volume samples more textures than the Iris Xe's fragment stage allows (16), and the
 * guard draws it with a plain fallback; so there the lamps' direct light stays per pixel, as with the volume.
 */
export function voxelStoreReadsTexels(store: VoxelLightStore): boolean {
  return store === 'cache';
}

/** Whether a store keeps light in the voxel light volume. */
export function voxelStoreUsesVolume(store: VoxelLightStore): boolean {
  return store === 'volume' || store === 'hybrid';
}
