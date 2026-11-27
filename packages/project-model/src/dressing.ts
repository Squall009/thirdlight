/**
 * Dressing assets (`content.dressings`): what grows on a voxel material. A
 * material names one dressing (`voxel.dressing`, voxel-materials.ts); many
 * materials may share one, and a material instance names another to grow
 * the same ground sparser, denser or with other plants.
 *
 * A dressing is its own file: an **ordered list of species entries**. An
 * entry is
 * - `model`: the model asset placed;
 * - `class`: `cover` (grass, flowers, reeds, pebbles: made near the camera
 *   from the voxels, never stored) or `large` (trees, bushes, boulders:
 *   stored here and round-tripped, placed by no engine code yet);
 * - `density`: candidates per m² (each kept where its conditions hold
 *   fully);
 * - `spacing`: no two of the entry's copies closer than this (m; absent 0);
 * - `scale`: a random uniform scale between these (absent [1, 1]);
 * - `yaw`: a random turn about up, 0 to this many degrees (absent 360);
 * - `align`: how far a copy leans to the ground's normal, 0 upright to 1
 *   along it (absent 0);
 * - `seed`: picks the entry's jitter, sizes and turns (absent 0);
 * - `conditions`: where it grows, the ten the voxel dressing rules read
 *   (`@thirdlight/voxel` dressing-rules.ts): material, role, slope, height,
 *   sky, wetness, waterDepth, materialEdge, construction, noise.
 *
 * The placement fields are a scatter rule's own (`scatter.ts`: the same
 * names, forms and bounds), so the rule scatter core places an entry as it
 * places any cover rule ({@link dressingSpeciesRule}). An entry's place in
 * the list is its identity to the core (its candidates' hashes mix its
 * index with its seed): two entries of one model never share candidates,
 * and moving an entry in the list moves its plants.
 *
 * The record is versioned (`dressingFormat`): any other format is refused
 * rather than read in part, unknown fields are refused, and a later format
 * only adds fields. The canonicalizer rebuilds the record field by field,
 * so a field added here must be added to {@link canonicalDressing} too (a
 * round-trip test lists every field).
 *
 * What an entry's `model` names is not checked here (deleting an asset is
 * never refused because a dressing names it): a model that is missing grows
 * nothing.
 *
 * Pure value validation: no I/O.
 */
import { isPlainObject } from '@thirdlight/shared';
import { DRESSING_CONDITIONS, DRESSING_ROLE_NAMES, MATERIAL_AIR, MATERIAL_ID_MAX, SURFACE_DISTANCE_CAP_M, WETNESS_MAX, type DressingConditions, type DressingNoise } from '@thirdlight/voxel';
import type { ModelErrorV2 } from './errors';
import { SCATTER_LIMITS, type ScatterRule } from './scatter';
import { canonicalRuleRange, SURFACE_RULE_LIMITS, validateRuleRange, type RuleRange } from './surface-rules';
import { ID_RE, isValidName } from './validate';
import { voxelDressingIds, type BindableMaterial } from './voxel-materials';

/** The dressing record format this build writes and reads. */
export const DRESSING_FORMAT = 1;

/** What a species is placed as. */
export const DRESSING_CLASSES = ['cover', 'large'] as const;
export type DressingClass = (typeof DRESSING_CLASSES)[number];

/** One species entry of a dressing. */
export interface DressingSpecies {
  /** The model asset placed. */
  model: string;
  class: DressingClass;
  /** Candidates per m². */
  density: number;
  /** Metres kept between the entry's copies (absent: 0). */
  spacing?: number;
  /** Random uniform scale between these (absent: [1, 1]). */
  scale?: [number, number];
  /** Random turn about up, 0 to this many degrees (absent: 360). */
  yaw?: number;
  /** 0 upright, 1 along the ground's normal (absent: 0). */
  align?: number;
  /** Picks the entry's jitter, sizes and turns with its place in the list (absent: 0). */
  seed?: number;
  /** Where it grows (absent: on every surface of a material that names the dressing). */
  conditions?: DressingConditions;
}

/** A dressing asset. */
export interface DressingDef {
  dressingFormat: typeof DRESSING_FORMAT;
  dressingId: string;
  name: string;
  species: DressingSpecies[];
}

/** Bounds of a dressing's values (dimensions of a value, not counts): the scatter rules' own where a field is one of theirs. */
export const DRESSING_LIMITS = Object.freeze({
  density: SCATTER_LIMITS.density,
  spacingMax: SCATTER_LIMITS.spacingMax,
  /**
   * A cover entry's spacing: the cover of a chunk is made from that chunk
   * and the chunks beside it, whose fields reach {@link SURFACE_DISTANCE_CAP_M}
   * past a point, so a neighbour farther than a chunk less that reach is not
   * known where a chunk is made.
   */
  coverSpacingMax: SURFACE_DISTANCE_CAP_M,
  scale: SCATTER_LIMITS.scale,
  /** Slopes are degrees from level. */
  slopeMax: 90,
  wetnessMax: WETNESS_MAX,
  /** The two distances are capped by the surface fields; a bound past the cap could never hold. */
  distanceMax: SURFACE_DISTANCE_CAP_M,
  noiseScaleMin: SURFACE_RULE_LIMITS.noiseScaleMin,
  noiseScaleMax: SURFACE_RULE_LIMITS.noiseScaleMax,
});

const DRESSING_FIELDS = ['dressingFormat', 'dressingId', 'name', 'species'];
const SPECIES_FIELDS = ['model', 'class', 'density', 'spacing', 'scale', 'yaw', 'align', 'seed', 'conditions'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

/** A range condition whose two ends lie in [lo, hi]. */
function boundedRange(c: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[], lo: number, hi: number, unit: string, extra: (o: Record<string, unknown>, q: string) => void = () => undefined, keys: readonly string[] = []): void {
  validateRuleRange(c, key, path, errors, (o, q) => {
    for (const k of ['min', 'max'] as const) if (finite(o[k]) && (o[k] < lo || o[k] > hi)) err(errors, 'field_value', `${q}/${k}`, `${key} ${k} is ${lo}-${hi} ${unit}`, o[k]);
    extra(o, q);
  }, keys);
}

function validateConditions(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) return err(errors, 'field_type', path, `conditions is {${DRESSING_CONDITIONS.map((k) => `${k}?`).join(', ')}}`, c, 'object');
  for (const k of Object.keys(c)) if (!(DRESSING_CONDITIONS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown condition "${k}"`, k, DRESSING_CONDITIONS.join(', '));
  const L = DRESSING_LIMITS;
  const set = (key: 'material' | 'role', ok: (v: unknown) => boolean, what: string): void => {
    const list = c[key];
    if (list === undefined) return;
    if (!Array.isArray(list) || list.length === 0) return err(errors, 'field_type', `${path}/${key}`, `${key} is a list of ${what} (leave it out for any)`, list, 'array');
    const seen = new Set<unknown>();
    list.forEach((v, i) => {
      if (!ok(v)) err(errors, 'field_value', `${path}/${key}/${i}`, `${key} lists ${what}`, v);
      else if (seen.has(v)) err(errors, 'id_duplicate', `${path}/${key}/${i}`, `${String(v)} is listed twice`, v);
      else seen.add(v);
    });
  };
  set('material', (v) => typeof v === 'number' && Number.isInteger(v) && v > MATERIAL_AIR && v <= MATERIAL_ID_MAX, `voxel material ids (1-${MATERIAL_ID_MAX})`);
  set('role', (v) => typeof v === 'string' && DRESSING_ROLE_NAMES.includes(v), `roles (${DRESSING_ROLE_NAMES.join(', ')})`);
  boundedRange(c, 'slope', path, errors, 0, L.slopeMax, 'degrees');
  validateRuleRange(c, 'height', path, errors);
  if (c['sky'] !== undefined && typeof c['sky'] !== 'boolean') err(errors, 'field_type', `${path}/sky`, 'sky is true (under open sky only) or false (under cover only)', c['sky'], 'boolean');
  boundedRange(c, 'wetness', path, errors, 0, L.wetnessMax, '(a cell\'s wetness)');
  boundedRange(c, 'waterDepth', path, errors, 0, SURFACE_RULE_LIMITS.value, 'm');
  boundedRange(c, 'materialEdge', path, errors, 0, L.distanceMax, `m (the distance is searched ${L.distanceMax} m out)`);
  boundedRange(c, 'construction', path, errors, 0, L.distanceMax, `m (the distance is searched ${L.distanceMax} m out)`);
  boundedRange(c, 'noise', path, errors, 0, 1, '(the noise\'s value)', (o, q) => {
    if (!(finite(o['scale']) && o['scale'] >= L.noiseScaleMin && o['scale'] <= L.noiseScaleMax)) err(errors, 'field_value', `${q}/scale`, `scale is metres, ${L.noiseScaleMin}-${L.noiseScaleMax}`, o['scale']);
    if (o['seed'] !== undefined && !Number.isSafeInteger(o['seed'])) err(errors, 'field_value', `${q}/seed`, 'seed is a whole number', o['seed']);
  }, ['scale', 'seed']);
}

function validateSpecies(s: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(s)) return err(errors, 'field_type', path, 'a species entry is {model, class, density, spacing?, scale?, yaw?, align?, seed?, conditions?}', s, 'object');
  for (const k of Object.keys(s)) if (!SPECIES_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown species field "${k}"`, k, SPECIES_FIELDS.join(', '));
  const L = DRESSING_LIMITS;
  if (typeof s['model'] !== 'string' || !ID_RE.test(s['model'])) err(errors, 'id_invalid', `${path}/model`, 'model names a model asset id', s['model']);
  const cls = s['class'];
  if (typeof cls !== 'string' || !(DRESSING_CLASSES as readonly string[]).includes(cls)) err(errors, cls === undefined ? 'field_missing' : 'field_value', `${path}/class`, `class is one of ${DRESSING_CLASSES.join(', ')}`, cls, DRESSING_CLASSES.join(' | '));
  const d = s['density'];
  if (!(finite(d) && d >= L.density.min && d <= L.density.max)) err(errors, d === undefined ? 'field_missing' : 'field_value', `${path}/density`, `density is ${L.density.min}-${L.density.max} candidates per m²`, d);
  const sp = s['spacing'];
  const spMax = cls === 'cover' ? L.coverSpacingMax : L.spacingMax;
  if (sp !== undefined && !(finite(sp) && sp >= 0 && sp <= spMax)) err(errors, 'field_value', `${path}/spacing`, `spacing is 0-${spMax} m${cls === 'cover' ? ' for a cover species' : ''}`, sp);
  const sc = s['scale'];
  if (sc !== undefined && !(Array.isArray(sc) && sc.length === 2 && sc.every((v) => finite(v) && v >= L.scale.min && v <= L.scale.max) && (sc[0] as number) <= (sc[1] as number))) err(errors, 'field_value', `${path}/scale`, `scale is [min, max] with ${L.scale.min} ≤ min ≤ max ≤ ${L.scale.max}`, sc);
  const yaw = s['yaw'];
  if (yaw !== undefined && !(finite(yaw) && yaw >= 0 && yaw <= 360)) err(errors, 'field_value', `${path}/yaw`, 'yaw is 0-360 (degrees of random turn)', yaw);
  const align = s['align'];
  if (align !== undefined && !(finite(align) && align >= 0 && align <= 1)) err(errors, 'field_value', `${path}/align`, 'align is 0-1 (0 upright, 1 along the ground\'s normal)', align);
  if (s['seed'] !== undefined && !Number.isSafeInteger(s['seed'])) err(errors, 'field_value', `${path}/seed`, 'seed is a whole number', s['seed']);
  if (s['conditions'] !== undefined) validateConditions(s['conditions'], `${path}/conditions`, errors);
}

/** Validate one dressing (its shape and values; what its models name is not checked). */
export function validateDressing(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a dressing is {dressingFormat, dressingId, name, species}', v, 'object');
  // The format first: a newer dressing is refused whole, never read in part.
  const f = v['dressingFormat'];
  if (f === undefined) return err(errors, 'field_missing', `${path}/dressingFormat`, 'dressingFormat is required', undefined, String(DRESSING_FORMAT));
  if (f !== DRESSING_FORMAT) {
    const newer = typeof f === 'number' && Number.isInteger(f) && f > DRESSING_FORMAT;
    return err(errors, newer ? 'dressing_format_unsupported' : 'field_value', `${path}/dressingFormat`, newer ? `dressing format ${f} is newer than this engine reads (${DRESSING_FORMAT})` : `dressingFormat is ${DRESSING_FORMAT}`, f, String(DRESSING_FORMAT));
  }
  for (const k of Object.keys(v)) if (!DRESSING_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown dressing field "${k}"`, k, DRESSING_FIELDS.join(', '));
  if (typeof v['dressingId'] !== 'string' || !ID_RE.test(v['dressingId'])) err(errors, 'id_invalid', `${path}/dressingId`, 'dressingId uses the id syntax (lower case, digits, - and _)', v['dressingId']);
  if (typeof v['name'] !== 'string' || !isValidName(v['name'])) err(errors, 'field_value', `${path}/name`, 'name is 1-128 characters without control characters', v['name']);
  const species = v['species'];
  if (!Array.isArray(species)) return err(errors, species === undefined ? 'field_missing' : 'field_type', `${path}/species`, 'species is the ordered list of species entries (it may be empty)', species, 'array');
  species.forEach((s, i) => validateSpecies(s, `${path}/species/${i}`, errors));
}

/** Validate the dressing list (each record, and each id once); `trusted`: records a previous block already held. */
export function validateDressings(value: unknown, path: string, errors: ModelErrorV2[], trusted?: ReadonlySet<unknown>): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'dressings is a list', value, 'array of dressings');
  const seen = new Set<string>();
  value.forEach((d, i) => {
    if (trusted?.has(d) !== true) validateDressing(d, `${path}/${i}`, errors);
    const id = isPlainObject(d) ? d['dressingId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/dressingId`, 'dressingId is used twice', id);
      seen.add(id);
    }
  });
}

function canonicalConditions(c: DressingConditions): DressingConditions | undefined {
  const out: DressingConditions = {};
  // In DRESSING_CONDITIONS order; a set ascending (its order means nothing).
  if (c.material !== undefined) out.material = [...c.material].sort((a, b) => a - b);
  if (c.role !== undefined) out.role = [...c.role].sort((a, b) => DRESSING_ROLE_NAMES.indexOf(a) - DRESSING_ROLE_NAMES.indexOf(b));
  const range = (r: RuleRange | undefined): RuleRange | undefined => {
    const k = canonicalRuleRange(r);
    return k !== undefined && Object.keys(k).length > 0 ? k : undefined;
  };
  const slope = range(c.slope);
  if (slope !== undefined) out.slope = slope;
  const height = range(c.height);
  if (height !== undefined) out.height = height;
  if (c.sky !== undefined) out.sky = c.sky;
  const wetness = range(c.wetness);
  if (wetness !== undefined) out.wetness = wetness;
  const waterDepth = range(c.waterDepth);
  if (waterDepth !== undefined) out.waterDepth = waterDepth;
  const materialEdge = range(c.materialEdge);
  if (materialEdge !== undefined) out.materialEdge = materialEdge;
  const construction = range(c.construction);
  if (construction !== undefined) out.construction = construction;
  if (c.noise !== undefined) {
    const n = canonicalRuleRange<DressingNoise>(c.noise, ['scale'])!;
    out.noise = { ...n, ...(c.noise.seed !== undefined && c.noise.seed !== 0 ? { seed: c.noise.seed } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function canonicalSpecies(s: DressingSpecies): DressingSpecies {
  const out: DressingSpecies = { model: s.model, class: s.class, density: s.density };
  if (s.spacing !== undefined && s.spacing > 0) out.spacing = s.spacing;
  if (s.scale !== undefined && !(s.scale[0] === 1 && s.scale[1] === 1)) out.scale = [s.scale[0], s.scale[1]];
  if (s.yaw !== undefined && s.yaw !== 360) out.yaw = s.yaw;
  if (s.align !== undefined && s.align !== 0) out.align = s.align;
  if (s.seed !== undefined && s.seed !== 0) out.seed = s.seed;
  const conditions = s.conditions !== undefined ? canonicalConditions(s.conditions) : undefined;
  if (conditions !== undefined) out.conditions = conditions;
  return out;
}

/** A dressing in canonical form: fields in a fixed order, defaults left out, the species in the order given (their order is theirs). */
export function canonicalDressing(d: DressingDef): DressingDef {
  return { dressingFormat: DRESSING_FORMAT, dressingId: d.dressingId, name: d.name, species: d.species.map(canonicalSpecies) };
}

/** The dressing list in canonical form (by id). */
export function canonicalDressings(list: readonly DressingDef[]): DressingDef[] {
  return [...list].sort((a, b) => cmp(a.dressingId, b.dressingId)).map(canonicalDressing);
}

/** The model assets a dressing's species name (every class: a stored large species ships with its dressing), ascending, each once. */
export function dressingModels(d: Pick<DressingDef, 'species'>): string[] {
  return [...new Set(d.species.map((s) => s.model))].sort();
}

/**
 * Species entry `index` of a dressing as the rule scatter core places it: a
 * ground cover rule with no conditions of its own (the voxel source answers
 * them, voxel-dressing-source.ts), named by its place in the list.
 */
export function dressingSpeciesRule(s: DressingSpecies, index: number): ScatterRule {
  return {
    id: `s${index}`,
    asset: { assetId: s.model },
    density: s.density,
    ...(s.spacing !== undefined ? { spacing: s.spacing } : {}),
    ...(s.scale !== undefined ? { scale: [s.scale[0], s.scale[1]] as [number, number] } : {}),
    ...(s.yaw !== undefined ? { yaw: s.yaw } : {}),
    ...(s.align !== undefined ? { align: s.align } : {}),
    ...(s.seed !== undefined ? { seed: s.seed } : {}),
    cover: true,
  };
}

/**
 * The dressings some voxel material names (its own `voxel.dressing` or its instance chain's), by id: what a build
 * ships and what a cover source is handed. A dressing nothing names is authoring data only.
 */
export function namedDressings(content: { readonly materials?: readonly BindableMaterial[]; readonly dressings?: readonly DressingDef[] } | null | undefined): DressingDef[] {
  const named = new Set(voxelDressingIds(content?.materials ?? []).values());
  return (content?.dressings ?? []).filter((d) => named.has(d.dressingId)).sort((a, b) => cmp(a.dressingId, b.dressingId));
}
