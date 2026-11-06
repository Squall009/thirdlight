/**
 * Voxel kits (`content.voxelKits`): the detail pieces a material type draws
 * its voxel edges, corners, roof edges and damage with, as **slots**: every
 * case of the case catalogue is a slot (the case id is its stable name),
 * and the kit assigns each slot it fills one or more meshes, each with a
 * cube rotation. One mesh may fill every slot, or every slot its own.
 *
 * - **Every slot is optional.** A slot the kit leaves out draws nothing:
 *   that edge stays a plain voxel edge. An author checks the textures on
 *   plain voxels first and adds pieces one slot at a time.
 * - **One mesh a piece.** Pieces are drawn in the near ring (level 0) only;
 *   from level 1 out the edges are plain voxel faces, so a mesh has no
 *   lower-detail one.
 * - **A slot's meshes** are picked per piece from the project's piece seed
 *   and the piece's world position (voxel piece-table.ts), weighted, so a
 *   scene always draws the same.
 * - **Jitter** scales how far every piece of the kit moves into the solid
 *   and twists (voxel piece-placement.ts; absent: 1, the engine's stagger).
 * - **One texture set a kit** (one trim sheet or one material for every
 *   piece): the kit check's rule, never a refusal here.
 * - **A kit belongs to a material type** (wood, stone), never to one
 *   material: every material of the type shares its instanced pieces.
 * - **Slot ids are opaque here.** The case catalogue names them; a kit
 *   naming one the catalogue lacks is a kit-check problem, never a refusal,
 *   so the catalogue may grow without invalidating stored kits.
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
 * The record is versioned (`kitFormat`, still a DRAFT): a newer format is
 * refused rather than read in part, and unknown fields are refused. The
 * canonicalizer rebuilds the record field by field, so a field added here
 * must be added to {@link canonicalVoxelKit} too (a round-trip test lists every
 * field).
 *
 * Pure value validation: no I/O.
 */
import { canonicalJsonValue, isPlainObject, isPlainObjectStrict } from '@thirdlight/shared';
import { CUBE_ROTATION_COUNT, MATERIAL_AIR, MATERIAL_ID_MAX, PIECE_JITTER_DEFAULT, PIECE_JITTER_MAX } from '@thirdlight/voxel';
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

/** One mesh a slot holds: the mesh, the cube rotation that turns it into the slot's case orientation, its weight among the slot's meshes. */
export interface VoxelKitSlotMesh {
  mesh: VoxelKitMesh;
  /** One of the 24 cube rotations (voxel `CUBE_ROTATIONS`, a fixed numbering; absent: 0, the identity). */
  rotation?: number;
  /** Relative weight among the slot's meshes (absent: 1). */
  weight?: number;
}

/** One filled slot: its meshes, and the game's data for it. */
export interface VoxelKitSlot {
  /** One or more meshes (an empty slot is not stored: leave the slot out). */
  meshes: VoxelKitSlotMesh[];
  /** The game's own data for this slot (break, sound, physics …), never read by the engine. */
  gameData?: VoxelKitJson;
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
  /** Slot (case id) → its meshes (an empty kit is valid: every edge stays a plain voxel edge). */
  slots: Record<string, VoxelKitSlot>;
  /** How far every piece moves into the solid and twists, a scale of the engine's stagger (0–{@link VOXEL_KIT_LIMITS.jitterMax}; absent: 1). */
  jitter?: number;
  /** The trim layout the pieces' UVs follow (absent: the kit uses no trim sheet). */
  trimLayout?: string;
  /** The game's own data for the whole kit, never read by the engine. */
  gameData?: VoxelKitJson;
}

export const VOXEL_KIT_LIMITS = Object.freeze({
  /** Nesting depth of game data (JSON parsers stop far deeper; this keeps a walk over it bounded). */
  gameDataDepth: 32,
  /** The largest voxel material id the test binding may name (the voxel value's 12 bits; 0 is air). */
  materialIdMax: MATERIAL_ID_MAX,
  /** A slot mesh's weight range, a block kit piece's. */
  weightMax: KIT_LIMITS.weightMax,
  /** The largest jitter (voxel `PIECE_JITTER_MAX`). */
  jitterMax: PIECE_JITTER_MAX,
});

const KIT_FIELDS = ['kitFormat', 'voxelKitId', 'name', 'version', 'materialType', 'materials', 'slots', 'jitter', 'trimLayout', 'gameData'];
const SLOT_FIELDS = ['meshes', 'gameData'];
const SLOT_MESH_FIELDS = ['mesh', 'rotation', 'weight'];
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

function slot(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a slot is {meshes, gameData?}', v, 'object');
  fields(v, SLOT_FIELDS, path, 'slot', errors);
  gameData(v['gameData'], `${path}/gameData`, errors);
  const meshes = v['meshes'];
  if (!Array.isArray(meshes) || meshes.length < 1) return err(errors, 'field_value', `${path}/meshes`, 'a slot holds one or more meshes (an empty slot is not stored: leave it out)', Array.isArray(meshes) ? meshes.length : meshes);
  meshes.forEach((x, i) => {
    const p = `${path}/meshes/${i}`;
    if (!isPlainObject(x)) return err(errors, 'field_type', p, 'a slot mesh is {mesh, rotation?, weight?}', x, 'object');
    fields(x, SLOT_MESH_FIELDS, p, 'slot mesh', errors);
    mesh(x['mesh'], `${p}/mesh`, errors);
    const r = x['rotation'];
    if (r !== undefined && (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r >= CUBE_ROTATION_COUNT)) err(errors, 'field_value', `${p}/rotation`, `rotation is a cube rotation, 0-${CUBE_ROTATION_COUNT - 1}`, r);
    const w = x['weight'];
    if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > VOXEL_KIT_LIMITS.weightMax)) err(errors, 'field_value', `${p}/weight`, `weight is a number in (0, ${VOXEL_KIT_LIMITS.weightMax}]`, w);
  });
}

/** Validate one kit's shape (what its case, section and asset ids name is the kit check's, never refused here). */
export function validateVoxelKit(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a voxel kit is {kitFormat, voxelKitId, name, version, materialType, slots, materials?, jitter?, trimLayout?, gameData?}', v, 'object');
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
  const jitter = v['jitter'];
  if (jitter !== undefined && (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > VOXEL_KIT_LIMITS.jitterMax)) err(errors, 'field_value', `${path}/jitter`, `jitter is a number 0-${VOXEL_KIT_LIMITS.jitterMax} (1: the engine's stagger)`, jitter);
  if (v['trimLayout'] !== undefined) id(v['trimLayout'], `${path}/trimLayout`, 'trimLayout', errors);
  gameData(v['gameData'], `${path}/gameData`, errors);
  const slots = v['slots'];
  if (!isPlainObject(slots)) return err(errors, slots === undefined ? 'field_missing' : 'field_type', `${path}/slots`, 'slots is {caseId: {meshes, gameData?}}', slots, 'object');
  for (const [cid, c] of Object.entries(slots)) {
    const p = `${path}/slots/${cid}`;
    id(cid, p, 'a slot (case) id', errors);
    slot(c, p, errors);
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

function byKey<T, U>(rec: Record<string, T>, f: (v: T) => U): Record<string, U> {
  return Object.fromEntries(Object.keys(rec).sort(cmp).map((k) => [k, f(rec[k]!)]));
}

/**
 * One kit in canonical form, rebuilt field by field: fields in order, maps by
 * key, materials ascending, rotations of 0, weights of 1 and a jitter of 1
 * left out, game data with its keys sorted (its values exactly as given).
 */
export function canonicalVoxelKit(k: VoxelKit): VoxelKit {
  return {
    kitFormat: k.kitFormat,
    voxelKitId: k.voxelKitId,
    name: k.name,
    version: k.version,
    materialType: k.materialType,
    ...(k.materials !== undefined && k.materials.length > 0 ? { materials: [...k.materials].sort((a, b) => a - b) } : {}),
    slots: byKey(k.slots, (c) => ({
      meshes: c.meshes.map((x) => ({
        mesh: canonicalMesh(x.mesh),
        ...(x.rotation !== undefined && x.rotation !== 0 ? { rotation: x.rotation } : {}),
        ...(x.weight !== undefined && x.weight !== 1 ? { weight: x.weight } : {}),
      })),
      ...(c.gameData !== undefined ? { gameData: canonicalJsonValue(c.gameData) as VoxelKitJson } : {}),
    })),
    ...(k.jitter !== undefined && k.jitter !== PIECE_JITTER_DEFAULT ? { jitter: k.jitter } : {}),
    ...(k.trimLayout !== undefined ? { trimLayout: k.trimLayout } : {}),
    ...(k.gameData !== undefined ? { gameData: canonicalJsonValue(k.gameData) as VoxelKitJson } : {}),
  };
}

export function canonicalVoxelKits(list: readonly VoxelKit[]): VoxelKit[] {
  return [...list].sort((a, b) => cmp(a.voxelKitId, b.voxelKitId)).map(canonicalVoxelKit);
}

/** Every mesh a kit's slots draw with, in slot and mesh order (a mesh in several slots once each time). */
export function voxelKitMeshes(k: VoxelKit): VoxelKitMesh[] {
  return Object.values(k.slots).flatMap((c) => c.meshes.map((x) => x.mesh));
}
