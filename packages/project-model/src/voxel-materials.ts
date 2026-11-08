/**
 * The voxel use of a material record (`MaterialDef.voxel`), its derived
 * shader family, and the kit binding the voxel derive's piece table is built
 * from.
 *
 * One record serves meshes and voxels: a material with a `voxel` part is
 * also a voxel material, with
 * - `id`: its voxel material id (1–4,095, the voxel value's 12 bits; 0 is
 *   air), unique in the project, so every world of the project shares them;
 * - `use`: construction (grid-anchored 4 × 4 m tiles), terrain (triplanar,
 *   2 m) or liquid;
 * - `kit`: the voxel kit whose detail pieces its edges draw (not with
 *   liquid);
 * - `tileMetres`: metres one texture repeat covers (absent: the use's
 *   default, the derive's own constants);
 * - `heightDepth`: metres the height map's 0 lies below its 1, the
 *   material's own (sand shallow, rock deep), so no shared height scale
 *   crushes a texture;
 * - `surfaces`: wall, floor and ceiling texture sets (role and face
 *   direction pick one; floor and ceiling fall back to wall, wall to the
 *   material's own look), so a voxel stays one material id.
 *
 * **Variants are material instances.** An instance inherits its chain's
 * physical block, game data and voxel fields and overrides any; a voxel
 * variant names its own `voxel.id` (the id is identity, never inherited): an
 * instance without its own `voxel` is a mesh variant only.
 *
 * **The kit binding.** A material's `voxel.kit` binds its id to that kit. A
 * kit's own test list (kit format 1's `materials`) still binds the ids no
 * material record names, so a project made before material records keeps
 * drawing; a record naming an id decides for it, kit or none.
 *
 * Pure value rules: no I/O.
 */
import { isPlainObject, isPlainObjectStrict } from '@thirdlight/shared';
import { CONSTRUCTION_TILE_METRES, MATERIAL_AIR, MATERIAL_ID_MAX, TERRAIN_TILE_METRES } from '@thirdlight/voxel';
import type { ModelErrorV2 } from './errors';
import { ID_RE } from './validate';

/** What a voxel material is used for. */
export const VOXEL_MATERIAL_USES = ['construction', 'terrain', 'liquid'] as const;
export type VoxelMaterialUse = (typeof VOXEL_MATERIAL_USES)[number];

/** The surfaces a voxel material dresses (picked by role and face direction). */
export const VOXEL_SURFACES = ['wall', 'floor', 'ceiling'] as const;
export type VoxelSurface = (typeof VOXEL_SURFACES)[number];

/** The maps of a texture set (the standard layout: albedo with height in alpha, normal, roughness/metal/AO). */
export const VOXEL_TEXTURE_MAPS = ['albedoHeight', 'normal', 'orm'] as const;
export type VoxelTextureMap = (typeof VOXEL_TEXTURE_MAPS)[number];

/** One texture set: a texture asset per map (a map left out: the engine's flat stand-in). */
export type VoxelTextureSet = Partial<Record<VoxelTextureMap, string>>;

export interface MaterialVoxel {
  /** The voxel material id, 1–{@link VOXEL_MATERIAL_LIMITS.idMax}, unique in the project. */
  id: number;
  /** Required on a material; an instance may leave it to its chain. */
  use?: VoxelMaterialUse;
  /** The voxel kit whose pieces its edges draw (absent: none; never with liquid). */
  kit?: string;
  /** Metres one texture repeat covers (absent: {@link voxelTileMetresDefault}). */
  tileMetres?: number;
  /** Metres between the height map's 1 (the surface) and 0 (absent: {@link VOXEL_MATERIAL_LIMITS.heightDepthDefault}). */
  heightDepth?: number;
  /** Texture sets per surface (absent: the material's own look on every surface). */
  surfaces?: Partial<Record<VoxelSurface, VoxelTextureSet>>;
}

export const VOXEL_MATERIAL_LIMITS = Object.freeze({
  /** The voxel value's material field (0 is air). */
  idMin: MATERIAL_AIR + 1,
  idMax: MATERIAL_ID_MAX,
  /** One voxel cell (0.5 m) is the finest repeat that still reads as a texture; 64 m covers a cliff face. */
  tileMetresMin: 0.5,
  tileMetresMax: 64,
  /**
   * Relief only recesses (the surface is the height's 1), and half a 0.5 m cell keeps the two sides of a
   * one-cell wall from meeting.
   */
  heightDepthMax: 0.25,
  /** A material that says nothing: shallow, like packed earth. */
  heightDepthDefault: 0.02,
});

const VOXEL_FIELDS = ['id', 'use', 'kit', 'tileMetres', 'heightDepth', 'surfaces'];

/** Metres one repeat covers when a material sets none: the derive's tile for its use. */
export function voxelTileMetresDefault(use: VoxelMaterialUse): number {
  return use === 'construction' ? CONSTRUCTION_TILE_METRES : TERRAIN_TILE_METRES;
}

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

function textureSet(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObjectStrict(v)) return err(errors, 'field_type', path, `a texture set is {${VOXEL_TEXTURE_MAPS.map((m) => `${m}?`).join(', ')}}`, v, 'object');
  for (const [k, id] of Object.entries(v)) {
    if (!(VOXEL_TEXTURE_MAPS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown texture map "${k}"`, k, VOXEL_TEXTURE_MAPS.join(', '));
    else if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${path}/${k}`, 'a texture map names a texture asset id', id);
  }
}

/**
 * A material's voxel part, its shape (what it names, and its id against the other materials', is checked with the
 * whole list: {@link validateVoxelMaterialRules}). `instance`: an instance may leave `use` to its chain.
 */
export function validateMaterialVoxel(v: unknown, path: string, errors: ModelErrorV2[], instance: boolean): void {
  if (!isPlainObjectStrict(v)) return err(errors, 'field_type', path, 'voxel is {id, use, kit?, tileMetres?, heightDepth?, surfaces?}', v, 'object');
  for (const k of Object.keys(v)) if (!VOXEL_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown voxel field "${k}"`, k, VOXEL_FIELDS.join(', '));
  const L = VOXEL_MATERIAL_LIMITS;
  const id = v['id'];
  if (id === undefined) err(errors, 'field_missing', `${path}/id`, `a voxel material has its id (${L.idMin}-${L.idMax}; a variant takes its own)`, undefined, 'id');
  else if (typeof id !== 'number' || !Number.isInteger(id) || id < L.idMin || id > L.idMax) err(errors, 'field_value', `${path}/id`, `a voxel material id is ${L.idMin}-${L.idMax} (0 is air)`, id);
  const use = v['use'];
  if (use === undefined) {
    if (!instance) err(errors, 'field_missing', `${path}/use`, `a voxel material has its use (${VOXEL_MATERIAL_USES.join(', ')})`, undefined, 'use');
  } else if (typeof use !== 'string' || !(VOXEL_MATERIAL_USES as readonly string[]).includes(use)) err(errors, 'field_value', `${path}/use`, `use is one of ${VOXEL_MATERIAL_USES.join(', ')}`, use);
  if (v['kit'] !== undefined && (typeof v['kit'] !== 'string' || !ID_RE.test(v['kit']))) err(errors, 'id_invalid', `${path}/kit`, 'kit names a voxel kit id', v['kit']);
  const tile = v['tileMetres'];
  if (tile !== undefined && (typeof tile !== 'number' || !Number.isFinite(tile) || tile < L.tileMetresMin || tile > L.tileMetresMax)) err(errors, 'field_value', `${path}/tileMetres`, `tileMetres is ${L.tileMetresMin}-${L.tileMetresMax} m`, tile);
  const depth = v['heightDepth'];
  if (depth !== undefined && (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0 || depth > L.heightDepthMax)) err(errors, 'field_value', `${path}/heightDepth`, `heightDepth is 0-${L.heightDepthMax} m`, depth);
  const surfaces = v['surfaces'];
  if (surfaces !== undefined) {
    if (!isPlainObjectStrict(surfaces)) err(errors, 'field_type', `${path}/surfaces`, `surfaces is {${VOXEL_SURFACES.map((s) => `${s}?`).join(', ')}}`, surfaces, 'object');
    else {
      for (const [k, set] of Object.entries(surfaces)) {
        if (!(VOXEL_SURFACES as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/surfaces/${k}`, `unknown surface "${k}"`, k, VOXEL_SURFACES.join(', '));
        else textureSet(set, `${path}/surfaces/${k}`, errors);
      }
    }
  }
}

function canonicalSet(s: VoxelTextureSet): VoxelTextureSet {
  const out: VoxelTextureSet = {};
  for (const m of VOXEL_TEXTURE_MAPS) if (s[m] !== undefined) out[m] = s[m];
  return out;
}

/** The voxel part in canonical form: fields in a fixed order, surfaces and maps in theirs, empty sets left out. */
export function canonicalMaterialVoxel(v: MaterialVoxel): MaterialVoxel {
  const surfaces: Partial<Record<VoxelSurface, VoxelTextureSet>> = {};
  for (const s of VOXEL_SURFACES) {
    const set = v.surfaces?.[s];
    if (set === undefined) continue;
    const c = canonicalSet(set);
    if (Object.keys(c).length > 0) surfaces[s] = c;
  }
  return {
    id: v.id,
    ...(v.use !== undefined ? { use: v.use } : {}),
    ...(v.kit !== undefined ? { kit: v.kit } : {}),
    ...(v.tileMetres !== undefined ? { tileMetres: v.tileMetres } : {}),
    ...(v.heightDepth !== undefined ? { heightDepth: v.heightDepth } : {}),
    ...(Object.keys(surfaces).length > 0 ? { surfaces } : {}),
  };
}

/** Voxel parts along an instance chain (the root first, the instance last): each level's fields over the farther ones', sets map by map, the id the instance's own. */
export function mergeMaterialVoxel(chain: readonly (MaterialVoxel | undefined)[]): MaterialVoxel | undefined {
  const own = chain[chain.length - 1];
  if (own === undefined) return undefined;
  const out: MaterialVoxel = { id: own.id };
  const surfaces: Partial<Record<VoxelSurface, VoxelTextureSet>> = {};
  for (const v of chain) {
    if (v === undefined) continue;
    if (v.use !== undefined) out.use = v.use;
    if (v.kit !== undefined) out.kit = v.kit;
    if (v.tileMetres !== undefined) out.tileMetres = v.tileMetres;
    if (v.heightDepth !== undefined) out.heightDepth = v.heightDepth;
    for (const s of VOXEL_SURFACES) if (v.surfaces?.[s] !== undefined) surfaces[s] = { ...surfaces[s], ...v.surfaces[s] };
  }
  if (Object.keys(surfaces).length > 0) out.surfaces = surfaces;
  return out;
}

/** The texture set a surface draws with: its own, else the wall's (null: the material's own look). */
export function voxelSurfaceSet(v: MaterialVoxel, surface: VoxelSurface): VoxelTextureSet | null {
  return v.surfaces?.[surface] ?? v.surfaces?.wall ?? null;
}

/** The texture assets a voxel part names, ascending. */
export function voxelTextureRefs(v: MaterialVoxel | undefined): string[] {
  const out = new Set<string>();
  for (const s of VOXEL_SURFACES) for (const m of VOXEL_TEXTURE_MAPS) {
    const id = v?.surfaces?.[s]?.[m];
    if (id !== undefined) out.add(id);
  }
  return [...out].sort();
}

/**
 * The shader families (a handful of shaders that hundreds of materials share as data):
 * - `standard`: meshes (props, characters, kit pieces) — the standard, foliage, atlas, trim and unlit shaders, a
 *   family with feature toggles;
 * - `projected`: voxel construction and terrain surfaces (triplanar, height-blended);
 * - `liquid`: water and other liquids;
 * - `decal`: decals;
 * - `effect`: particle effects' shading (effect records, not material records);
 * - `graph`: a custom node graph that compiles its own shader.
 */
export const MATERIAL_FAMILIES = ['standard', 'projected', 'liquid', 'decal', 'effect', 'graph'] as const;
export type MaterialFamily = (typeof MATERIAL_FAMILIES)[number];

/**
 * The family a (resolved) material draws with, derived from its shader, graph and voxel use, never stored: a graph
 * is its own; a decal a decal; water or a liquid voxel use a liquid; construction or terrain use projected (the
 * same record on a mesh draws as standard); everything else standard.
 */
export function materialFamilyOf(m: { readonly shader: string; readonly graph?: unknown; readonly voxel?: Partial<MaterialVoxel> }): MaterialFamily {
  if (m.graph !== undefined) return 'graph';
  if (m.shader === 'decal') return 'decal';
  if (m.shader === 'water' || m.voxel?.use === 'liquid') return 'liquid';
  if (m.voxel?.use === 'construction' || m.voxel?.use === 'terrain') return 'projected';
  return 'standard';
}

/** What the project rules read of a resolved material. */
export interface VoxelRulesMaterial {
  readonly materialId: string;
  readonly voxel?: MaterialVoxel;
  readonly physical?: { readonly profile?: string };
}

/**
 * The rules between resolved materials, the voxel kits and the profiles (each reported at the material's index in
 * the stored list): a voxel id is used once (`voxel_id_taken`), a kit named exists (`kit_missing`), a liquid names
 * no kit, an instance's chain gives it a use, a profile named exists.
 */
export function validateVoxelMaterialRules(
  resolved: readonly VoxelRulesMaterial[],
  indexOf: (materialId: string) => number,
  kitIds: ReadonlySet<string>,
  profileIds: ReadonlySet<string>,
  errors: ModelErrorV2[],
): void {
  const owner = new Map<number, string>();
  for (const m of resolved) {
    const at = `/materials/${indexOf(m.materialId)}`;
    const profile = m.physical?.profile;
    if (profile !== undefined && !profileIds.has(profile)) err(errors, 'reference_missing', `${at}/physical/profile`, `no physical profile "${profile}" (an engine profile or one of content.materialProfiles)`, profile, [...profileIds].sort().join(', '));
    const v = m.voxel;
    if (v === undefined) continue;
    const taken = owner.get(v.id);
    if (taken !== undefined) err(errors, 'voxel_id_taken', `${at}/voxel/id`, `voxel material id ${v.id} is material "${taken}"'s`, v.id);
    else owner.set(v.id, m.materialId);
    if (v.use === undefined) err(errors, 'field_missing', `${at}/voxel/use`, 'a voxel variant whose chain gives no use needs its own', undefined, 'use');
    if (v.kit !== undefined && !kitIds.has(v.kit)) err(errors, 'kit_missing', `${at}/voxel/kit`, `no voxel kit "${v.kit}" in this project`, v.kit);
    if (v.kit !== undefined && v.use === 'liquid') err(errors, 'field_value', `${at}/voxel/kit`, 'a liquid draws no kit pieces: leave kit out', v.kit);
  }
}

/** A kit as the binding reads it (its id and kit format 1's test list). */
export interface BindableKit {
  readonly voxelKitId: string;
  readonly materials?: readonly number[];
}

/** A material as the binding reads it (stored, instances not folded in). */
export interface BindableMaterial {
  readonly materialId: string;
  readonly instanceOf?: string;
  readonly voxel?: MaterialVoxel;
}

/**
 * Each material's voxel part with its instance chain folded in (`mergeMaterialVoxel`), by materialId; a material
 * without its own part has none, and a broken chain (refused by the project rules) folds what it reaches.
 */
export function resolvedVoxelParts(materials: readonly BindableMaterial[]): Map<string, MaterialVoxel> {
  const byId = new Map(materials.map((m) => [m.materialId, m]));
  const out = new Map<string, MaterialVoxel>();
  for (const m of materials) {
    if (m.voxel === undefined) continue;
    const chain: (MaterialVoxel | undefined)[] = [m.voxel];
    const seen = new Set<string>([m.materialId]);
    let cur = m.instanceOf !== undefined ? byId.get(m.instanceOf) : undefined;
    while (cur !== undefined && !seen.has(cur.materialId)) {
      seen.add(cur.materialId);
      chain.unshift(cur.voxel);
      cur = cur.instanceOf !== undefined ? byId.get(cur.instanceOf) : undefined;
    }
    out.set(m.materialId, mergeMaterialVoxel(chain)!);
  }
  return out;
}

/**
 * The kits with the material ids each binds, as the piece table reads them (`materials`, ascending; left out when
 * none): the ids whose material names the kit, then the kit's own test list for ids no material names. A liquid
 * binds none.
 */
export function boundVoxelKits<K extends BindableKit>(kits: readonly K[], materials: readonly BindableMaterial[]): K[] {
  const named = new Set<number>();
  const byKit = new Map<string, number[]>();
  for (const v of resolvedVoxelParts(materials).values()) {
    named.add(v.id);
    if (v.kit === undefined || v.use === 'liquid') continue;
    const list = byKit.get(v.kit);
    if (list === undefined) byKit.set(v.kit, [v.id]);
    else list.push(v.id);
  }
  return kits.map((k) => {
    const ids = [...(byKit.get(k.voxelKitId) ?? []), ...(k.materials ?? []).filter((id) => !named.has(id))];
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    const { materials: _old, ...rest } = k as K & { materials?: readonly number[] };
    return (sorted.length > 0 ? { ...rest, materials: sorted } : rest) as unknown as K;
  });
}

/** The voxel material ids the materials name (a kit's test list binds only the others). */
export function namedVoxelIds(materials: readonly unknown[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const m of materials) {
    const v = isPlainObject(m) ? m['voxel'] : undefined;
    if (isPlainObject(v) && typeof v['id'] === 'number') out.add(v['id']);
  }
  return out;
}
