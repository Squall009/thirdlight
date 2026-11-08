/**
 * Physical profiles: the shared physics (and the game's sound or break
 * defaults, as game data) a material names instead of repeating them, so
 * changing wood's density or footstep sound once changes every wood
 * material.
 *
 * - **Engine profiles** are constants here (wood, stone, metal, earth,
 *   glass, water, lava), so every project starts with a usable set.
 * - **A project's own** live in `content.materialProfiles` (in
 *   `content.json`; `setMaterialProfile` / `deleteMaterialProfile`). One
 *   with an engine profile's id overrides it field by field: a field it
 *   leaves out is the engine's.
 * - **A material's `physical` block** names a profile and overrides any of
 *   its numbers; a material without one has the engine's defaults
 *   ({@link PHYSICAL_DEFAULTS}).
 *
 * The engine reads these numbers only where its physics already has a slot
 * for them (a collider's friction and restitution); density and flow rate
 * are for the game (block health, buoyancy) and the liquid simulation. Game
 * data is the game's: kept, shipped, never read.
 *
 * Pure value rules: no I/O.
 */
import { canonicalJsonValue, isPlainObject, isPlainObjectStrict } from '@thirdlight/shared';
import type { ModelErrorV2 } from './errors';
import { ID_RE, isValidName } from './validate';
import { validateGameData, type GameDataJson } from './game-data';

/** Opaque game data (any JSON within the kit format's depth bound). */
export type MaterialGameData = GameDataJson;

/** The physical numbers a profile or a material's `physical` block holds (each optional: absent = the next level's). */
export interface PhysicalValues {
  /** Mass density, kg/m³. */
  density?: number;
  /** Coulomb friction coefficient (0 = ice-smooth). */
  friction?: number;
  /** Bounciness, 0 (none) – 1 (perfectly elastic). */
  restitution?: number;
  /** How fast a liquid spreads, relative to water (1); solids leave it out. */
  flowRate?: number;
}

export interface MaterialProfile extends PhysicalValues {
  profileId: string;
  name: string;
  /** The game's defaults for every material of the profile (sounds, break tags …), never read by the engine. */
  gameData?: MaterialGameData;
}

/** A material's physical block: a profile and the numbers it changes. */
export interface MaterialPhysical extends PhysicalValues {
  /** A profile id (an engine one or the project's). Absent: the engine's defaults. */
  profile?: string;
}

/** A material's physics with every number filled in, as the game and the engine read it. */
export interface ResolvedPhysical {
  /** The profile it came from (absent: none named). */
  readonly profile?: string;
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  /** Absent: not a liquid (no profile or override gives one). */
  readonly flowRate?: number;
}

/** The ranges of the physical numbers (a validator's and a descriptor's). */
export const PHYSICAL_LIMITS = Object.freeze({
  /** kg/m³: denser than any element (osmium ~22,600), so any real material fits. */
  densityMax: 30_000,
  /** Friction coefficients past 2 are rare even for rubber on rubber; 4 leaves room. */
  frictionMax: 4,
  restitutionMax: 1,
  /** Relative to water: 100× leaves room for gases and very thin liquids. */
  flowRateMax: 100,
});

/** What a material with no profile and no override has. */
export const PHYSICAL_DEFAULTS: ResolvedPhysical = Object.freeze({ density: 1000, friction: 0.5, restitution: 0 });

/** The engine's profiles (by id; a project's profile of the same id overrides each field it sets). */
export const ENGINE_MATERIAL_PROFILES: readonly Readonly<MaterialProfile>[] = Object.freeze([
  { profileId: 'earth', name: 'Earth', density: 1500, friction: 0.8, restitution: 0.05 },
  { profileId: 'glass', name: 'Glass', density: 2500, friction: 0.3, restitution: 0.3 },
  { profileId: 'lava', name: 'Lava', density: 3100, friction: 0, restitution: 0, flowRate: 0.05 },
  { profileId: 'metal', name: 'Metal', density: 7850, friction: 0.4, restitution: 0.15 },
  { profileId: 'stone', name: 'Stone', density: 2500, friction: 0.7, restitution: 0.1 },
  { profileId: 'water', name: 'Water', density: 1000, friction: 0, restitution: 0, flowRate: 1 },
  { profileId: 'wood', name: 'Wood', density: 700, friction: 0.6, restitution: 0.2 },
].map((p) => Object.freeze(p)));

const NUMBER_FIELDS = ['density', 'friction', 'restitution', 'flowRate'] as const;
const PROFILE_FIELDS = ['profileId', 'name', ...NUMBER_FIELDS, 'gameData'];
const PHYSICAL_FIELDS = ['profile', ...NUMBER_FIELDS];
const RANGE: Readonly<Record<(typeof NUMBER_FIELDS)[number], [number, number, boolean]>> = {
  // [min, max, min exclusive]
  density: [0, PHYSICAL_LIMITS.densityMax, true],
  friction: [0, PHYSICAL_LIMITS.frictionMax, false],
  restitution: [0, PHYSICAL_LIMITS.restitutionMax, false],
  flowRate: [0, PHYSICAL_LIMITS.flowRateMax, false],
};

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

function numbers(v: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  for (const k of NUMBER_FIELDS) {
    const x = v[k];
    if (x === undefined) continue;
    const [min, max, open] = RANGE[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x > max || (open ? x <= min : x < min)) err(errors, 'field_value', `${path}/${k}`, `${k} is a number in ${open ? '(' : '['}${min}, ${max}]`, x);
  }
}

function fields(v: Record<string, unknown>, known: readonly string[], path: string, what: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!known.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}"`, k, known.join(', '));
}

/** One profile record. */
export function validateMaterialProfile(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObjectStrict(v)) return err(errors, 'field_type', path, 'a material profile is {profileId, name, density?, friction?, restitution?, flowRate?, gameData?}', v, 'object');
  fields(v, PROFILE_FIELDS, path, 'material profile', errors);
  if (typeof v['profileId'] !== 'string' || !ID_RE.test(v['profileId'])) err(errors, 'id_invalid', `${path}/profileId`, 'profileId uses the id syntax (lower case, digits, - and _)', v['profileId']);
  if (typeof v['name'] !== 'string' || !isValidName(v['name'])) err(errors, 'field_value', `${path}/name`, 'a profile name is 1-128 characters without control characters', v['name']);
  numbers(v, path, errors);
  validateGameData(v['gameData'], `${path}/gameData`, errors);
}

/** `content.materialProfiles`: the project's profiles, each id once. */
export function validateMaterialProfiles(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'materialProfiles is a list of profiles', value, 'array');
  const seen = new Set<unknown>();
  value.forEach((p, i) => {
    validateMaterialProfile(p, `${path}/${i}`, errors);
    const id = isPlainObject(p) ? p['profileId'] : undefined;
    if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/profileId`, 'profileId is used twice', id);
    seen.add(id);
  });
}

/** A material's physical block (its shape; the profile it names is checked against the project's list). */
export function validateMaterialPhysical(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObjectStrict(v)) return err(errors, 'field_type', path, 'physical is {profile?, density?, friction?, restitution?, flowRate?}', v, 'object');
  fields(v, PHYSICAL_FIELDS, path, 'physical', errors);
  if (v['profile'] !== undefined && (typeof v['profile'] !== 'string' || !ID_RE.test(v['profile']))) err(errors, 'id_invalid', `${path}/profile`, 'profile names a profile id', v['profile']);
  numbers(v, path, errors);
}

const keepNumbers = (v: PhysicalValues): PhysicalValues => ({
  ...(v.density !== undefined ? { density: v.density } : {}),
  ...(v.friction !== undefined ? { friction: v.friction } : {}),
  ...(v.restitution !== undefined ? { restitution: v.restitution } : {}),
  ...(v.flowRate !== undefined ? { flowRate: v.flowRate } : {}),
});

/** One profile in canonical form (fields in a fixed order, game data's keys sorted). */
export function canonicalMaterialProfile(p: MaterialProfile): MaterialProfile {
  return { profileId: p.profileId, name: p.name, ...keepNumbers(p), ...(p.gameData !== undefined ? { gameData: canonicalJsonValue(p.gameData) as MaterialGameData } : {}) };
}

/** The list in canonical form: ascending profileId. */
export function canonicalMaterialProfiles(list: readonly MaterialProfile[]): MaterialProfile[] {
  return [...list].sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0)).map(canonicalMaterialProfile);
}

/** A physical block in canonical form (null when it holds nothing: the same as none). */
export function canonicalMaterialPhysical(p: MaterialPhysical): MaterialPhysical | null {
  const out: MaterialPhysical = { ...(p.profile !== undefined ? { profile: p.profile } : {}), ...keepNumbers(p) };
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Every profile a project's materials may name: the engine's, each overridden field by field by the project's
 * profile of the same id, and the project's own.
 */
export function materialProfilesOf(project: readonly MaterialProfile[] | undefined): ReadonlyMap<string, MaterialProfile> {
  const out = new Map<string, MaterialProfile>(ENGINE_MATERIAL_PROFILES.map((p) => [p.profileId, p]));
  for (const p of project ?? []) {
    const base = out.get(p.profileId);
    out.set(p.profileId, base === undefined ? p : { ...base, ...p, ...(p.gameData === undefined && base.gameData !== undefined ? { gameData: base.gameData } : {}) });
  }
  return out;
}

/**
 * A material's physics with every number filled in: its own numbers over its profile's over the defaults. A
 * profile the list lacks counts as none (the project rules refuse naming one).
 */
export function resolveMaterialPhysical(physical: MaterialPhysical | undefined, profiles: ReadonlyMap<string, MaterialProfile>): ResolvedPhysical {
  const profile = physical?.profile !== undefined ? profiles.get(physical.profile) : undefined;
  const pick = (k: (typeof NUMBER_FIELDS)[number]): number | undefined => physical?.[k] ?? profile?.[k] ?? PHYSICAL_DEFAULTS[k];
  const flowRate = pick('flowRate');
  return {
    ...(physical?.profile !== undefined ? { profile: physical.profile } : {}),
    density: pick('density')!,
    friction: pick('friction')!,
    restitution: pick('restitution')!,
    ...(flowRate !== undefined ? { flowRate } : {}),
  };
}

/**
 * Game data a material resolves to: its profile's, with the material's own top-level keys over them (both
 * objects); a material's data that is not an object replaces the profile's whole.
 */
export function withProfileGameData(own: MaterialGameData | undefined, profile: MaterialProfile | undefined): MaterialGameData | undefined {
  const base = profile?.gameData;
  if (base === undefined) return own;
  if (own === undefined) return base;
  return mergeGameData(base, own);
}

/** Game data of two levels: the nearer level's top-level keys over the farther's when both are objects, else the nearer whole. */
export function mergeGameData(far: MaterialGameData, near: MaterialGameData): MaterialGameData {
  if (isPlainObjectStrict(far) && isPlainObjectStrict(near)) return { ...(far as Record<string, MaterialGameData>), ...(near as Record<string, MaterialGameData>) };
  return near;
}

/**
 * Materials as a build ships them: a material with a physical block carries it resolved (every number filled in
 * from its profile, the profile's id kept) and the profile's game data under its own, so the runtime never reads a
 * profile. A material without one ships as it is (the engine's defaults).
 */
export function withResolvedPhysics<M extends { physical?: MaterialPhysical; gameData?: MaterialGameData }>(materials: readonly M[], projectProfiles: readonly MaterialProfile[] | undefined): M[] {
  if (!materials.some((m) => m.physical !== undefined)) return [...materials];
  const profiles = materialProfilesOf(projectProfiles);
  return materials.map((m) => {
    if (m.physical === undefined) return m;
    const profile = m.physical.profile !== undefined ? profiles.get(m.physical.profile) : undefined;
    const gameData = withProfileGameData(m.gameData, profile);
    return { ...m, physical: { ...resolveMaterialPhysical(m.physical, profiles) }, ...(gameData !== undefined ? { gameData } : {}) };
  });
}
