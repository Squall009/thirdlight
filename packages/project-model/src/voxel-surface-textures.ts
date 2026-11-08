/**
 * The voxel surfaces' texture arrays: per map type one array (albedo with
 * height in A, normal, ORM), a layer per distinct texture set the voxel
 * materials dress their wall, floor and ceiling surfaces with, and each
 * voxel id's layer per surface (what the surface shader's material table
 * holds).
 *
 * The arrays are slot lists like a layered material's (`texture-slots.ts`):
 * Play and the export assemble each into one KTX2 array through the same
 * backend assembly and cache, and the editor's views fetch them by the same
 * key, so every host draws the one assembled array. A set leaving a map out
 * takes that map's neutral constant layer (a flat normal, the ORM absent
 * value), so a layer without its normal or ORM map looks as a material
 * without one does; a set without an albedo has no layer (its surfaces draw
 * the material's flat colour). Identical sets share a layer (a floor
 * falling back to its wall, two materials on the same textures).
 *
 * Every array has at least two layers: a single-layer KTX2 transcodes to a
 * plain 2D texture, and the shader samples arrays.
 *
 * The arrays hold at most `MAX_TEXTURE_LAYERS` layers (the GPU's array
 * limit, not a project cap); a set past it has no layer and is listed in
 * `dropped`, so its surfaces draw their flat colour and the caller can say so.
 *
 * Layers are numbered in ascending voxel id, wall then floor then ceiling,
 * so the same records give the same arrays and table on every host.
 *
 * Residency: sets are authored at {@link VOXEL_AUTHORED_TEXEL_DENSITY} on a
 * construction tile (4096² for 4 m) and the arrays keep every level. A
 * quality level's texel density decides the largest level a page keeps
 * resident ({@link voxelArrayTopLevel}); the page's texture budget may keep
 * less (the mip tail always stays).
 */
import { CONSTRUCTION_TILE_METRES } from '@thirdlight/voxel';

import { MAX_TEXTURE_LAYERS } from './content-limits';
import { FLAT_NORMAL_TEXEL, TEXTURE_ABSENT_VALUES } from './material-graph-kinds';
import { fillLayerId, type TextureSlotSet } from './texture-slots';
import { isVoxelMaterial, VOXEL_SURFACES, VOXEL_TEXTURE_MAPS, voxelSurfaceSet, type MaterialVoxel, type VoxelTextureMap, type VoxelTextureSet } from './voxel-materials';

/** A layer of the arrays: none (the surface draws its material's flat colour). */
export const VOXEL_NO_LAYER = -1;

/** Texels a metre the voxel texture sets are authored at, on a construction tile (4096² for the 4 m tile). */
export const VOXEL_AUTHORED_TEXEL_DENSITY = 1024;

/**
 * The largest mip level (0: full size) an array whose layers are `layerEdge` texels a side keeps resident at a
 * texel density of `texelsPerMetre` on a construction tile: the first level at or below the density. An array
 * authored smaller than the density keeps level 0.
 */
export function voxelArrayTopLevel(layerEdge: number, texelsPerMetre: number): number {
  if (!(layerEdge > 0) || !(texelsPerMetre > 0)) return 0;
  const over = layerEdge / CONSTRUCTION_TILE_METRES / texelsPerMetre;
  return over <= 1 ? 0 : Math.ceil(Math.log2(over) - 1e-9);
}

/** Fewest layers an array has (a single-layer KTX2 is not an array). */
const MIN_ARRAY_LAYERS = 2;

/** How each map's array is encoded and read (the albedo's A is a height). */
const MAP_SLOTS: Readonly<Record<VoxelTextureMap, { readonly mode: TextureSlotSet['mode']; readonly height?: true; readonly fill: string | null }>> = {
  albedoHeight: { mode: 'color', height: true, fill: null },
  normal: { mode: 'normal', fill: fillLayerId(FLAT_NORMAL_TEXEL) },
  orm: { mode: 'data', fill: fillLayerId(TEXTURE_ABSENT_VALUES.orm) },
};

/** The voxel materials' texture arrays and each id's layer per surface. */
export interface VoxelSurfaceTextures {
  /**
   * Each map's array as a slot list (the assembly's input; `textureSlotSetKey` names it). The albedo is always there;
   * a normal or ORM array no set names a texture of is left out (an array takes its size from a texture), and the
   * surface reads that map's neutral value.
   */
  readonly sets: Readonly<{ albedoHeight: TextureSlotSet } & Partial<Record<Exclude<VoxelTextureMap, 'albedoHeight'>, TextureSlotSet>>>;
  /** By voxel id, its wall, floor and ceiling layer ({@link VOXEL_NO_LAYER}: none). */
  readonly layers: ReadonlyMap<number, readonly [number, number, number]>;
  /** Voxel ids with a set that found no layer (the arrays were full). */
  readonly dropped: readonly number[];
}

/** A material record as the arrays read it (resolved: instances folded in). */
export interface VoxelTexturedMaterial {
  readonly shader: string;
  readonly voxel?: MaterialVoxel;
}

const setKey = (s: VoxelTextureSet): string => VOXEL_TEXTURE_MAPS.map((m) => s[m] ?? '').join('|');

/**
 * The arrays of the voxel materials' surface sets (`materials` resolved);
 * null when no voxel material has a set with an albedo (nothing to draw from
 * arrays). The first voxel material naming an id decides for it.
 */
export function voxelSurfaceTextures(materials: readonly VoxelTexturedMaterial[]): VoxelSurfaceTextures | null {
  const byId = new Map<number, MaterialVoxel>();
  for (const m of materials) if (isVoxelMaterial(m) && !byId.has(m.voxel!.id)) byId.set(m.voxel!.id, m.voxel!);
  const layerOf = new Map<string, number>();
  const ordered: VoxelTextureSet[] = [];
  const layers = new Map<number, [number, number, number]>();
  const dropped: number[] = [];
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    const v = byId.get(id)!;
    let any = false;
    let full = false;
    const per = VOXEL_SURFACES.map((surface) => {
      const s = voxelSurfaceSet(v, surface);
      if (s === null || s.albedoHeight === undefined) return VOXEL_NO_LAYER;
      const k = setKey(s);
      let l = layerOf.get(k);
      if (l === undefined) {
        if (ordered.length >= MAX_TEXTURE_LAYERS) {
          full = true;
          return VOXEL_NO_LAYER;
        }
        l = ordered.length;
        ordered.push(s);
        layerOf.set(k, l);
      }
      any = true;
      return l;
    }) as [number, number, number];
    if (full) dropped.push(id);
    if (any) layers.set(id, per);
  }
  if (ordered.length === 0) return null;
  // A second layer where only one set exists: the first again (never sampled by any id).
  while (ordered.length < MIN_ARRAY_LAYERS) ordered.push(ordered[0]!);
  const sets = Object.fromEntries(
    VOXEL_TEXTURE_MAPS.flatMap((map) => {
      const how = MAP_SLOTS[map];
      if (!ordered.some((s) => s[map] !== undefined)) return [];
      // An albedo is always there (a set without one has no layer); another map left out is its neutral constant.
      const list = ordered.map((s) => s[map] ?? how.fill!);
      return [[map, { layers: list, mode: how.mode, ...(how.height === true ? { height: true as const } : {}) }]];
    }),
  ) as unknown as VoxelSurfaceTextures['sets'];
  return { sets, layers, dropped };
}

/** Whether any voxel material (resolved) names a surface set with an albedo: the build ships voxel arrays. */
export function hasVoxelSurfaceTextures(materials: readonly VoxelTexturedMaterial[]): boolean {
  return voxelSurfaceTextures(materials) !== null;
}
