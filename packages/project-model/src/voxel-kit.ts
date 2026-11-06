/**
 * Voxel kits (`content.voxelKits`): the detail pieces a material type draws
 * its voxel cases with — per case and run section the authored mesh of
 * each weighted variant, the outlines section ends meet by, and the game's
 * own data per kit and per case.
 *
 * - **One mesh a piece.** Pieces are drawn in the near ring (level 0) only;
 *   from level 1 out the edges are plain voxel faces, so a variant has no
 *   lower-detail mesh (a stored `low` is an unknown field, refused).
 *
 * - **A kit belongs to a material type** (wood, stone), never to one
 *   material: every material of the type shares its instanced pieces.
 * - **Case and section ids are opaque here.** The case catalogue names them;
 *   a kit naming one the catalogue lacks is a kit-check problem, never a
 *   refusal, so the catalogue may grow without invalidating stored kits.
 * - **`materials` is a test binding** (the voxel material ids the kit
 *   applies to) until the material model names each material's kit; then it
 *   is left unread, never repurposed.
 * - **`gameData` is opaque.** Break, sound and physics defaults are game
 *   behaviour: the engine validates it is JSON, keeps it, ships it, and
 *   never reads a member.
 * - **A mesh is a model asset version** (`assetId` plus the SHA-256 of the
 *   GLB the piece was made from), so it ships through the content closure as
 *   every model does and a re-import that changes the bytes is visible.
 *
 * The record is versioned (`kitFormat`): fields are only ever added, a newer
 * format is refused rather than read in part, and unknown fields are refused.
 * The canonicalizer rebuilds the record field by field, so a field added here
 * must be added to {@link canonicalVoxelKit} too (a round-trip test lists every
 * field).
 *
 * Pure value validation: no I/O.
 */
import { canonicalJsonValue, isPlainObject, isPlainObjectStrict } from '@thirdlight/shared';
import { CUBE_ROTATION_COUNT, MATERIAL_AIR, MATERIAL_ID_MAX } from '@thirdlight/voxel';
import type { ModelErrorV2 } from './errors';
import { DIGEST_RE } from './content-helpers';
import { KIT_LIMITS } from './kits';
import { ID_RE, isValidName } from './validate';

/** The kit record's format. A later format adds fields only; a reader refuses one newer than it knows. */
export const VOXEL_KIT_FORMAT = 1;

/** JSON as a kit's game data holds it. */
export type VoxelKitJson = null | boolean | number | string | VoxelKitJson[] | { [key: string]: VoxelKitJson };

/** One authored mesh: a model asset, the digest of the GLB version it was made from, optionally one node of it. */
export interface VoxelKitMesh {
  assetId: string;
  /** SHA-256 (64 lowercase hex) of the GLB bytes: the asset version's source digest. */
  digest: string;
  /** The node drawn when the file holds several pieces (absent: the whole model). */
  node?: string;
}

/** One variant of a section: its mesh, drawn in the near ring (`high`: the field's name since the first draft). */
export interface VoxelKitVariant {
  high: VoxelKitMesh;
  /** Relative weight among the section's variants (absent: 1). */
  weight?: number;
}

/** A run section's pieces and the join profiles its two ends have. */
export interface VoxelKitSection {
  /** One or several weighted variants (an empty section is not stored). */
  variants: VoxelKitVariant[];
  /** The join profile ids at the section's start and end (absent: the end is not checked against its neighbour). */
  ends?: { start?: string; end?: string };
}

/**
 * A case drawn by another case's meshes (many edge cases are one mesh on another side): `case` names a case of the
 * same kit that has sections of its own, `rotation` one of the 24 cube rotations (voxel's `CUBE_ROTATIONS`, a fixed
 * numbering; 0 the identity) the meshes are turned by in the case's own orientation. Never a mirror.
 */
export interface VoxelKitAlias {
  case: string;
  rotation: number;
}

/** One case of the kit: its sections or an alias, and the game's data for the case. */
export interface VoxelKitCase {
  /** Section id → its pieces (absent: no pieces; the fallback draws the case). */
  sections?: Record<string, VoxelKitSection>;
  /** Draw this case with another case's meshes turned (instead of sections of its own; added to kit format 1). */
  alias?: VoxelKitAlias;
  /** The game's own data for this case (break, sound, physics …), never read by the engine. */
  gameData?: VoxelKitJson;
}

/** A section end's outline: a closed polygon in the end plane, in sixteenths of a cell. */
export interface VoxelKitJoinProfile {
  /** [u, v] points, each 0–{@link VOXEL_KIT_LIMITS.profileUnits}. */
  outline: [number, number][];
}

export interface VoxelKit {
  kitFormat: typeof VOXEL_KIT_FORMAT;
  voxelKitId: string;
  name: string;
  /** The kit's own revision (a positive integer the author moves). */
  version: number;
  /** The material type the kit dresses (an id; the material model names the types). */
  materialType: string;
  /** Test binding: the voxel material ids this kit applies to (ascending, each once; absent: none). */
  materials?: number[];
  /** Case id → its pieces and data (an empty kit is valid: the fallback kit draws every case). */
  cases: Record<string, VoxelKitCase>;
  /** Profile id → the outline section ends named by it meet with (absent: none). */
  joinProfiles?: Record<string, VoxelKitJoinProfile>;
  /** The trim layout the pieces' UVs follow (absent: the kit uses no trim sheet). */
  trimLayout?: string;
  /** The game's own data for the whole kit, never read by the engine. */
  gameData?: VoxelKitJson;
}

export const VOXEL_KIT_LIMITS = Object.freeze({
  /** Sixteenths of a cell along each axis of a join profile's end plane. */
  profileUnits: 16,
  /** A join profile is a polygon: at least a triangle. */
  profilePointsMin: 3,
  /** Nesting depth of game data (JSON parsers stop far deeper; this keeps a walk over it bounded). */
  gameDataDepth: 32,
  /** The largest voxel material id the test binding may name (the voxel value's 12 bits; 0 is air). */
  materialIdMax: MATERIAL_ID_MAX,
  /** A variant's weight range, a block kit piece's. */
  weightMax: KIT_LIMITS.weightMax,
});

const KIT_FIELDS = ['kitFormat', 'voxelKitId', 'name', 'version', 'materialType', 'materials', 'cases', 'joinProfiles', 'trimLayout', 'gameData'];
const CASE_FIELDS = ['sections', 'alias', 'gameData'];
const SECTION_FIELDS = ['variants', 'ends'];
const VARIANT_FIELDS = ['high', 'weight'];
const MESH_FIELDS = ['assetId', 'digest', 'node'];
/** A model node name (as a block kit piece's). */
const NODE_RE = /^[^\u0000-\u001f]{1,128}$/;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

function fields(v: Record<string, unknown>, known: readonly string[], path: string, what: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!known.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}"`, k, known.join(', '));
}

function id(v: unknown, path: string, what: string, errors: ModelErrorV2[]): void {
  if (typeof v !== 'string' || !ID_RE.test(v)) err(errors, 'id_invalid', path, `${what} uses the id syntax (lower case, digits, - and _)`, v);
}

/** Whether a value is JSON within the depth bound (plain objects, arrays, finite numbers, strings, booleans, null). */
function isJson(v: unknown, depth: number): boolean {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth >= VOXEL_KIT_LIMITS.gameDataDepth) return false;
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isPlainObjectStrict(v)) return Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}

function gameData(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v !== undefined && !isJson(v, 0)) err(errors, 'field_value', path, `gameData is JSON (objects, lists, finite numbers, text, true/false, null) nested at most ${VOXEL_KIT_LIMITS.gameDataDepth} deep`);
}

function mesh(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a mesh is {assetId, digest, node?}', v, 'object');
  fields(v, MESH_FIELDS, path, 'mesh', errors);
  id(v['assetId'], `${path}/assetId`, 'assetId', errors);
  if (typeof v['digest'] !== 'string' || !DIGEST_RE.test(v['digest'])) err(errors, 'digest_invalid', `${path}/digest`, 'digest is the GLB\'s SHA-256 (64 lowercase hex)', v['digest'], '64 lowercase hex');
  if (v['node'] !== undefined && (typeof v['node'] !== 'string' || !NODE_RE.test(v['node']))) err(errors, 'field_value', `${path}/node`, 'node is a node name (1-128 characters)', v['node']);
}

function section(v: unknown, path: string, profiles: ReadonlySet<string> | null, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a section is {variants, ends?}', v, 'object');
  fields(v, SECTION_FIELDS, path, 'section', errors);
  const variants = v['variants'];
  if (!Array.isArray(variants) || variants.length < 1) err(errors, 'field_value', `${path}/variants`, 'a section holds one or more variants (an empty section is not stored)', Array.isArray(variants) ? variants.length : variants);
  else {
    variants.forEach((x, i) => {
      const p = `${path}/variants/${i}`;
      if (!isPlainObject(x)) return err(errors, 'field_type', p, 'a variant is {high, weight?}', x, 'object');
      fields(x, VARIANT_FIELDS, p, 'variant', errors);
      mesh(x['high'], `${p}/high`, errors);
      const w = x['weight'];
      if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > VOXEL_KIT_LIMITS.weightMax)) err(errors, 'field_value', `${p}/weight`, `weight is a number in (0, ${VOXEL_KIT_LIMITS.weightMax}]`, w);
    });
  }
  const ends = v['ends'];
  if (ends === undefined) return;
  if (!isPlainObject(ends)) return err(errors, 'field_type', `${path}/ends`, 'ends is {start?, end?} (join profile ids)', ends, 'object');
  fields(ends, ['start', 'end'], `${path}/ends`, 'ends', errors);
  for (const k of ['start', 'end']) {
    const ref = ends[k];
    if (ref === undefined) continue;
    id(ref, `${path}/ends/${k}`, 'a join profile id', errors);
    // A dangling profile is refused: the kit's own table is the only place it can be.
    if (typeof ref === 'string' && profiles !== null && !profiles.has(ref)) err(errors, 'reference_missing', `${path}/ends/${k}`, `join profile "${ref}" is not in the kit's joinProfiles`, ref);
  }
}

/** A case's alias: an own case of the same kit (with sections, not itself an alias), one of the cube rotations. */
function alias(cid: string, c: Record<string, unknown>, cases: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  const a = c['alias'];
  if (!isPlainObject(a)) return err(errors, 'field_type', path, 'an alias is {case, rotation}', a, 'object');
  fields(a, ['case', 'rotation'], path, 'alias', errors);
  if (c['sections'] !== undefined) err(errors, 'field_value', path, 'a case has sections of its own or an alias, not both', cid);
  const r = a['rotation'];
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r >= CUBE_ROTATION_COUNT) err(errors, 'field_value', `${path}/rotation`, `rotation is a cube rotation, 0-${CUBE_ROTATION_COUNT - 1}`, r);
  const to = a['case'];
  id(to, `${path}/case`, 'an alias case', errors);
  if (typeof to !== 'string') return;
  if (to === cid) return err(errors, 'field_value', `${path}/case`, 'a case cannot be an alias of itself', to);
  const target = cases[to];
  // A dangling or chained alias is refused: the kit's own cases are the only place its meshes can be.
  if (!isPlainObject(target)) return err(errors, 'reference_missing', `${path}/case`, `case "${to}" is not in the kit`, to);
  if (target['sections'] === undefined) err(errors, 'reference_missing', `${path}/case`, `case "${to}" has no sections of its own (an alias names a case with meshes)`, to);
}

function profile(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a join profile is {outline}', v, 'object');
  fields(v, ['outline'], path, 'join profile', errors);
  const o = v['outline'];
  const n = VOXEL_KIT_LIMITS.profileUnits;
  if (!Array.isArray(o) || o.length < VOXEL_KIT_LIMITS.profilePointsMin) return err(errors, 'field_value', `${path}/outline`, `an outline is at least ${VOXEL_KIT_LIMITS.profilePointsMin} [u, v] points`, Array.isArray(o) ? o.length : o);
  o.forEach((pt, i) => {
    const ok = Array.isArray(pt) && pt.length === 2 && pt.every((c) => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= n);
    if (!ok) err(errors, 'field_value', `${path}/outline/${i}`, `a point is [u, v], whole sixteenths of a cell 0-${n}`, pt);
  });
}

/** Validate one kit's shape (what its case, section and asset ids name is the kit check's, never refused here). */
export function validateVoxelKit(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a voxel kit is {kitFormat, voxelKitId, name, version, materialType, cases, materials?, joinProfiles?, trimLayout?, gameData?}', v, 'object');
  // The format first: a newer kit is refused whole, never read in part.
  const f = v['kitFormat'];
  if (f === undefined) return err(errors, 'field_missing', `${path}/kitFormat`, 'kitFormat is required', undefined, String(VOXEL_KIT_FORMAT));
  if (f !== VOXEL_KIT_FORMAT) {
    const newer = typeof f === 'number' && Number.isInteger(f) && f > VOXEL_KIT_FORMAT;
    return err(errors, newer ? 'kit_format_unsupported' : 'field_value', `${path}/kitFormat`, newer ? `kit format ${f} is newer than this engine reads (${VOXEL_KIT_FORMAT})` : `kitFormat is ${VOXEL_KIT_FORMAT}`, f, String(VOXEL_KIT_FORMAT));
  }
  fields(v, KIT_FIELDS, path, 'voxel kit', errors);
  id(v['voxelKitId'], `${path}/voxelKitId`, 'voxelKitId', errors);
  if (typeof v['name'] !== 'string' || !isValidName(v['name'])) err(errors, 'field_value', `${path}/name`, 'name is 1-128 characters without control characters', v['name']);
  const ver = v['version'];
  if (typeof ver !== 'number' || !Number.isSafeInteger(ver) || ver < 1) err(errors, 'field_value', `${path}/version`, 'version is a positive integer (the kit\'s own revision)', ver);
  id(v['materialType'], `${path}/materialType`, 'materialType', errors);
  const mats = v['materials'];
  if (mats !== undefined) {
    if (!Array.isArray(mats)) err(errors, 'field_type', `${path}/materials`, 'materials is a list of voxel material ids', mats, 'array');
    else {
      const seen = new Set<number>();
      mats.forEach((m, i) => {
        if (typeof m !== 'number' || !Number.isInteger(m) || m <= MATERIAL_AIR || m > MATERIAL_ID_MAX) err(errors, 'field_value', `${path}/materials/${i}`, `a voxel material id is 1-${MATERIAL_ID_MAX} (0 is air)`, m);
        else if (seen.has(m)) err(errors, 'id_duplicate', `${path}/materials/${i}`, `material ${m} is listed twice`, m);
        else seen.add(m);
      });
    }
  }
  const profiles = v['joinProfiles'];
  let profileIds: Set<string> | null = new Set();
  if (profiles !== undefined) {
    if (!isPlainObject(profiles)) {
      err(errors, 'field_type', `${path}/joinProfiles`, 'joinProfiles is {profileId: {outline}}', profiles, 'object');
      profileIds = null;
    } else {
      for (const [pid, p] of Object.entries(profiles)) {
        id(pid, `${path}/joinProfiles/${pid}`, 'a join profile id', errors);
        profile(p, `${path}/joinProfiles/${pid}`, errors);
        profileIds.add(pid);
      }
    }
  }
  if (v['trimLayout'] !== undefined) id(v['trimLayout'], `${path}/trimLayout`, 'trimLayout', errors);
  gameData(v['gameData'], `${path}/gameData`, errors);
  const cases = v['cases'];
  if (!isPlainObject(cases)) return err(errors, 'field_type', `${path}/cases`, 'cases is {caseId: {sections?, alias?, gameData?}}', cases, 'object');
  for (const [cid, c] of Object.entries(cases)) {
    const p = `${path}/cases/${cid}`;
    id(cid, p, 'a case id', errors);
    if (!isPlainObject(c)) {
      err(errors, 'field_type', p, 'a case is {sections?, alias?, gameData?}', c, 'object');
      continue;
    }
    fields(c, CASE_FIELDS, p, 'case', errors);
    gameData(c['gameData'], `${p}/gameData`, errors);
    if (c['alias'] !== undefined) alias(cid, c, cases, `${p}/alias`, errors);
    const secs = c['sections'];
    if (secs === undefined) continue;
    if (!isPlainObject(secs)) {
      err(errors, 'field_type', `${p}/sections`, 'sections is {sectionId: {variants, ends?}}', secs, 'object');
      continue;
    }
    for (const [sid, s] of Object.entries(secs)) {
      id(sid, `${p}/sections/${sid}`, 'a section id', errors);
      section(s, `${p}/sections/${sid}`, profileIds, errors);
    }
  }
}

export function validateVoxelKits(value: unknown, path: string, errors: ModelErrorV2[], trusted?: ReadonlySet<unknown>): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'voxelKits is a list', value, 'array of voxel kits');
  const seen = new Set<string>();
  value.forEach((k, i) => {
    if (trusted?.has(k) !== true) validateVoxelKit(k, `${path}/${i}`, errors);
    const kid = isPlainObject(k) ? k['voxelKitId'] : undefined;
    if (typeof kid === 'string') {
      if (seen.has(kid)) err(errors, 'id_duplicate', `${path}/${i}/voxelKitId`, 'voxelKitId is used twice', kid);
      seen.add(kid);
    }
  });
}

function canonicalMesh(m: VoxelKitMesh): VoxelKitMesh {
  return { assetId: m.assetId, digest: m.digest, ...(m.node !== undefined ? { node: m.node } : {}) };
}

function canonicalSection(s: VoxelKitSection): VoxelKitSection {
  const start = s.ends?.start;
  const end = s.ends?.end;
  return {
    variants: s.variants.map((x) => ({ high: canonicalMesh(x.high), ...(x.weight !== undefined && x.weight !== 1 ? { weight: x.weight } : {}) })),
    ...(start !== undefined || end !== undefined ? { ends: { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) } } : {}),
  };
}

function byKey<T, U>(rec: Record<string, T>, f: (v: T) => U): Record<string, U> {
  return Object.fromEntries(Object.keys(rec).sort(cmp).map((k) => [k, f(rec[k]!)]));
}

/**
 * One kit in canonical form, rebuilt field by field: fields in order, maps by
 * key, materials ascending, weights of 1 and empty maps left out, game data
 * with its keys sorted (its values exactly as given).
 */
export function canonicalVoxelKit(k: VoxelKit): VoxelKit {
  const profiles = k.joinProfiles !== undefined ? Object.keys(k.joinProfiles) : [];
  return {
    kitFormat: k.kitFormat,
    voxelKitId: k.voxelKitId,
    name: k.name,
    version: k.version,
    materialType: k.materialType,
    ...(k.materials !== undefined && k.materials.length > 0 ? { materials: [...k.materials].sort((a, b) => a - b) } : {}),
    cases: byKey(k.cases, (c) => {
      const secs = c.sections !== undefined && Object.keys(c.sections).length > 0 ? c.sections : undefined;
      return {
        ...(secs !== undefined ? { sections: byKey(secs, canonicalSection) } : {}),
        ...(c.alias !== undefined ? { alias: { case: c.alias.case, rotation: c.alias.rotation } } : {}),
        ...(c.gameData !== undefined ? { gameData: canonicalJsonValue(c.gameData) as VoxelKitJson } : {}),
      };
    }),
    ...(profiles.length > 0 ? { joinProfiles: byKey(k.joinProfiles!, (p) => ({ outline: p.outline.map(([u, v]) => [u, v] as [number, number]) })) } : {}),
    ...(k.trimLayout !== undefined ? { trimLayout: k.trimLayout } : {}),
    ...(k.gameData !== undefined ? { gameData: canonicalJsonValue(k.gameData) as VoxelKitJson } : {}),
  };
}

export function canonicalVoxelKits(list: readonly VoxelKit[]): VoxelKit[] {
  return [...list].sort((a, b) => cmp(a.voxelKitId, b.voxelKitId)).map(canonicalVoxelKit);
}

/** Every mesh a kit's pieces draw with, in case, section and variant order. */
export function voxelKitMeshes(k: VoxelKit): VoxelKitMesh[] {
  const out: VoxelKitMesh[] = [];
  for (const c of Object.values(k.cases)) {
    for (const s of Object.values(c.sections ?? {})) {
      for (const x of s.variants) out.push(x.high);
    }
  }
  return out;
}
