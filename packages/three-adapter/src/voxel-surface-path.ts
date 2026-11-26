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

/** The page flag that leaves the liquid parts undrawn (`?voxelLiquid=off`: what drawing them costs, by comparison). */
export const VOXEL_LIQUID_URL_PARAM = 'voxelLiquid';

/** Whether a page's query string draws the liquid parts (anything but `off`). */
export function voxelLiquidFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(VOXEL_LIQUID_URL_PARAM) !== 'off';
}

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
 * Where a game page's voxel worlds keep their light (the lighting store): `off` draws them as before (sun, shadows and
 * the clustered lights per pixel), `volume` adds sky light and bounce from a voxel light volume. The level's lighting
 * tier decides (`voxelLightVolume.enabled`, on WebGPU only); a page's query `?voxelLight=off|volume` overrides it for a
 * comparison.
 */
export const VOXEL_LIGHT_URL_PARAM = 'voxelLight';
export const VOXEL_LIGHT_STORES = ['off', 'volume'] as const;
export type VoxelLightStore = (typeof VOXEL_LIGHT_STORES)[number];

/** The lighting store a page's query names (absent or unknown: null, the tier decides). */
export function voxelLightStoreFromUrl(search: string): VoxelLightStore | null {
  const v = new URLSearchParams(search).get(VOXEL_LIGHT_URL_PARAM);
  return (VOXEL_LIGHT_STORES as readonly string[]).includes(v ?? '') ? (v as VoxelLightStore) : null;
}

/** The store a page's voxel worlds are lit by: the query's, else the volume where the tier has it on and the renderer is WebGPU (WebGL 2 has no volume). */
export function voxelLightStoreFor(query: VoxelLightStore | null, tierOn: boolean, webgpu: boolean): VoxelLightStore {
  return query ?? (tierOn && webgpu ? 'volume' : 'off');
}

/** A page's lighting store: the query's, one a bench or a check set, or the level's tier's (looked at each frame). */
export class LightStoreChoice {
  /** The store the page lights its voxel worlds by now. */
  current: VoxelLightStore = 'off';
  private set = false;
  constructor(readonly query: VoxelLightStore | null) {}

  /** The store to take now: `store` when set by a bench or a check (from then on the tier no longer decides), else the tier's while the query names none (null: keep the current one). */
  next(store: VoxelLightStore | { tierOn: boolean; webgpu: boolean }): VoxelLightStore | null {
    if (typeof store === 'string') {
      this.set = true;
      return store;
    }
    if (this.set) return null;
    return voxelLightStoreFor(this.query, store.tierOn, store.webgpu);
  }
}

/** The page flag that leaves the gas parts undrawn (`?voxelGas=off`: what drawing them costs, by comparison). */
export const VOXEL_GAS_URL_PARAM = 'voxelGas';

/** Whether a page's query string draws the gas parts (anything but `off`). */
export function voxelGasFromUrl(search: string): boolean {
  return new URLSearchParams(search).get(VOXEL_GAS_URL_PARAM) !== 'off';
}
