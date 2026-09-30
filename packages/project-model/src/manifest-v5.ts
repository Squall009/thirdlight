/**
 * Manifest v5 — a small runtime manifest and the catalog it points at.
 *
 * A v4 manifest held every asset row, prefab and rig inline, so its size grew
 * with the project (9 MB for a full-size game) and a page read all of it
 * before anything started. A v5 build splits the same content the way
 * Addressables' catalog and Godot's dependency lists do:
 *
 * - `manifest.json` keeps the build's identity, the resolved settings, the
 *   start scene ids and the location of the catalog root (`catalog`: path,
 *   digest, byte length). Its size does not depend on how many assets,
 *   resources or scenes the project has.
 * - The catalog root (a content file, like every file below) lists the
 *   project-wide blocks' files by key, every scene (its file and its
 *   dependency file) and the entry shards.
 * - A block that grows with the project (prefabs, materials, UI documents,
 *   dialogue, behaviors, …) is its own file, split into parts past
 *   `CATALOG_PART_BYTES` (a list's parts concatenate, a map's merge).
 * - Every shipped asset has one catalog entry (the v4 asset row plus its
 *   address, labels and the assets it depends on), in shards sorted by id;
 *   the root names each shard's first and last id, so a lookup reads one
 *   shard. Shard boundaries follow each id's hash, so adding an asset
 *   changes one shard, not every shard after it.
 * - Each scene's dependency file holds the entries its objects need
 *   (directly, through materials, prefabs, models' material maps and its
 *   bake), so loading a scene reads its own file and nothing else; the
 *   `dependencies` block does the same for the project-wide blocks.
 * - `facts` is what the simulation must know of every asset from its first
 *   step (model bounds and material maps, audio durations; texture ids when
 *   graph materials have parameters): a few fields per asset, not its row.
 *
 * Every file is `content/sha256/<digest>` (its compact JSON bytes), listed
 * with its digest and length by the file above it, so the manifest's
 * `buildId` covers the whole catalog. Pure: no I/O, no clock; the caller
 * supplies `capturedAt` and may supply a faster SHA-256.
 */
import { MANIFEST_CONTENT_FILE_MAX_BYTES, RUNTIME_CONTENT_MANIFEST_MAX_BYTES, RUNTIME_CONTENT_TYPE, type ManifestBehaviorInput } from './manifest';
import {
  blockDigest,
  canonicalManifestBlocks,
  contentFileBlockProblem,
  libraryRowsProblem,
  manifestBlocksProblem,
  manifestLibraryRows,
  manifestModuleRows,
  manifestToolchain,
  M3_ENGINE_PINS,
  M3_OPTIONAL_SETTINGS_KEYS,
  M3_RECIPE_VERSIONS,
  M3_SETTINGS_KEYS,
  MANIFEST_CONTENT_FILE_KEYS,
  RUNTIME_CONTENT_MANIFEST_VERSION_4,
  sortedAssetRows,
  sortedBehaviorRows,
  validateManifestV2,
  type ExpandedRuntimeContentManifest,
  type CaptureManifestV2Input,
  type ManifestAssetInputV2,
  type ManifestContentFileKey,
  type ManifestErrorV2,
  type ManifestLibraryRow,
  type ManifestSceneRow,
  type MediaBlock,
  type MediaAnimationRow,
  type RuntimeContentManifestV2,
} from './manifest-v2';
import { sha256Hex } from './sha256';
import { ID_RE, isPlainObject } from './validate';
import { isAddress, loadableRowsProblem, type LoadableRow } from './loadable';
import { isAssetLabel } from './content-assets';
import type { GameplaySettings } from './types-v2';

export const RUNTIME_CONTENT_MANIFEST_VERSION_5 = 5 as const;

/**
 * Where a block file is cut into parts: a part ends once its items pass this
 * size (an item larger than this is a part of its own), so a large block is
 * read as several files in parallel and a change rewrites one part. The
 * per-file cap is `MANIFEST_CONTENT_FILE_MAX_BYTES`.
 */
export const CATALOG_PART_BYTES = 1_048_576;

/**
 * The entries per shard on average: a shard ends after an entry whose id
 * hashes to 0 modulo this (or at `CATALOG_PART_BYTES`), so one lookup reads
 * about this many entries.
 */
export const CATALOG_SHARD_ENTRIES = 256;

/** One file of a build, listed by digest (`content/sha256/<digest>`). */
export interface CatalogFileRef {
  path: string;
  digest: string;
  byteLength: number;
}

/** A file with its bytes (what a build writes or serves). */
export interface CatalogFile extends CatalogFileRef {
  bytes: Uint8Array;
}

/** The v5 manifest keys in their canonical order (`buildId` last). */
export const MANIFEST_KEYS_V5 = [
  'manifestVersion',
  'type',
  'projectId',
  'revision',
  'snapshotId',
  'capturedAt',
  'sceneDigest',
  'contentDigest',
  'settingsDigest',
  'mediaDigest',
  'settings',
  // The scenes the game starts with.
  'start',
  // The catalog root's file.
  'catalog',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;

/** The v5 manifest document (key order = `MANIFEST_KEYS_V5`). */
export interface RuntimeContentManifestV5 {
  manifestVersion: 5;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  settingsDigest: string;
  mediaDigest: string;
  settings: GameplaySettings;
  start: string[];
  catalog: CatalogFileRef;
  modules: ReadonlyArray<Record<string, unknown>>;
  enginePins: ReadonlyArray<Record<string, unknown>>;
  recipes: Record<string, number>;
  toolchain: Record<string, unknown>;
  buildOptionsDigest: string;
  buildId: string;
}

/**
 * The catalog's blocks, in their file order. The v4 manifest's inline blocks
 * and content files, plus: `media` (the animation rows), `behaviors` (the
 * compiled behavior rows), `loadable` (what scripts may load by address or
 * label), `facts` (what the simulation needs of each asset) and
 * `dependencies` (the entries the project-wide blocks need).
 */
export const CATALOG_BLOCK_KEYS = [
  'tags',
  'effects',
  'environment',
  'lighting',
  'animators',
  'rigs',
  'prefabs',
  'blockTypes',
  'cellFields',
  'input',
  'collisionLayers',
  'saveSchema',
  'uiThemes',
  'modes',
  'timelines',
  'eventCues',
  'shell',
  'materials',
  'materialFunctions',
  'uiDocuments',
  'dialogue',
  'buffers',
  'media',
  'behaviors',
  'loadable',
  'facts',
  'dependencies',
] as const;
export type CatalogBlockKey = (typeof CATALOG_BLOCK_KEYS)[number];

/** The blocks that are maps (their parts merge); the other split blocks are lists (their parts concatenate). */
const MAP_BLOCKS: ReadonlySet<string> = new Set(['rigs', 'lighting']);

/** One block file of the root (a block in several parts has one row per part, in order). */
export interface CatalogBlockRow extends CatalogFileRef {
  key: CatalogBlockKey;
}

/** One scene of the root: its file and the file of the entries it needs. */
export interface CatalogSceneRow extends ManifestSceneRow {
  dependencies: CatalogFileRef;
}

/** One entry shard: the entries whose ids run from `first` to `last`. */
export interface CatalogShardRow extends CatalogFileRef {
  first: string;
  last: string;
  count: number;
}

/** The catalog root document. */
export interface CatalogRootV5 {
  files: CatalogBlockRow[];
  scenes?: CatalogSceneRow[];
  entries: CatalogShardRow[];
  libraries?: ManifestLibraryRow[];
}

/** One catalog entry: a v4 asset row, with its names and what it needs. */
export type CatalogEntry = Record<string, unknown> & {
  assetId: string;
  kind: string;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
  path: string;
  address?: string;
  labels?: string[];
  /** The assets this one needs to draw or play (a model's textures through its material map). */
  dependencies?: string[];
};

/** A captured asset with its names and dependencies. */
export interface ManifestAssetInputV5 extends ManifestAssetInputV2 {
  address?: string;
  labels?: readonly string[];
  dependencies?: readonly string[];
}

/** One scene of a v5 capture: its row and the asset ids it needs. */
export interface CaptureSceneV5 extends ManifestSceneRow {
  dependencies: readonly string[];
}

/**
 * The v5 capture's input: the v4 capture's (the same project-wide blocks, in
 * the same form), with the start scene ids, each scene's and each asset's
 * dependencies and what the project-wide blocks need.
 */
export type CaptureManifestV5Input = Omit<CaptureManifestV2Input, 'assets' | 'scenes' | 'scene' | 'sceneDigest' | 'contentDigest' | 'loadable'> & {
  sceneDigest: string;
  contentDigest: string;
  /** The start scene ids, in start order. */
  start: readonly string[];
  /** Every scene, with the asset ids each needs. */
  scenes?: readonly CaptureSceneV5[];
  /** Every shipped asset. */
  assets: readonly ManifestAssetInputV5[];
  /** The asset ids the project-wide blocks need (environment, effects, UI, shell, timelines, event cues, block types, animators, glyphs). */
  dependencies?: readonly string[];
  /** What scripts may load by address or label (only what the build holds). */
  loadable?: readonly LoadableRow[];
  /** SHA-256 (lowercase hex) of the files' bytes (default: project-model's portable one). */
  sha256?: (bytes: Uint8Array) => string;
};

export type CaptureManifestV5Result =
  | { ok: true; manifest: RuntimeContentManifestV5; bytes: Uint8Array; buildId: string; root: CatalogRootV5; files: CatalogFile[] }
  | { ok: false; error: ManifestErrorV2 };

function v5Error(code: string, message: string, reason?: string, found?: unknown): ManifestErrorV2 {
  return { code, cls: code === 'internal' ? 'internal' : 'validation', message: message.slice(0, 256), ...(reason !== undefined ? { reason } : {}), ...(found !== undefined ? { found } : {}) };
}

const DIGEST_RE = /^[0-9a-f]{64}$/;
const isDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST_RE.test(v);

/** The manifest's canonical bytes (`JSON.stringify(value, null, 2) + "\n"`, as every manifest before). */
function fileBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A catalog file's canonical bytes: `JSON.stringify(value) + "\n"`, compact
 * (these files are read by machines, and at full size are half the bytes to
 * send, hash and parse of the indented form).
 */
function catalogBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/** FNV-1a (32-bit) of a string: the shard boundary hash (stable across runtimes). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A value's compact JSON length (a part's size, as its file holds it). */
function approxBytes(value: unknown): number {
  return JSON.stringify(value).length + 8;
}

/** Split a list into parts near `CATALOG_PART_BYTES` (every part non-empty). */
function listParts(list: readonly unknown[]): unknown[][] {
  const parts: unknown[][] = [];
  let part: unknown[] = [];
  let size = 0;
  for (const item of list) {
    const n = approxBytes(item);
    if (part.length > 0 && size + n > CATALOG_PART_BYTES) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(item);
    size += n;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/** Split a map into parts near `CATALOG_PART_BYTES`, keys in order. */
function mapParts(map: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  let part: Record<string, unknown> = {};
  let size = 0;
  let count = 0;
  for (const key of Object.keys(map)) {
    const n = approxBytes(map[key]) + key.length;
    if (count > 0 && size + n > CATALOG_PART_BYTES) {
      parts.push(part);
      part = {};
      size = 0;
      count = 0;
    }
    part[key] = map[key];
    size += n;
    count += 1;
  }
  if (count > 0) parts.push(part);
  return parts;
}

/**
 * Entries into shards: a shard ends after an entry whose id hashes to 0
 * modulo `CATALOG_SHARD_ENTRIES`, or once it reaches `CATALOG_PART_BYTES`;
 * the versions of one id stay in one shard.
 */
function shardEntries(entries: readonly CatalogEntry[]): CatalogEntry[][] {
  const shards: CatalogEntry[][] = [];
  let shard: CatalogEntry[] = [];
  let size = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]!;
    shard.push(e);
    size += approxBytes(e);
    const next = entries[i + 1];
    if (next !== undefined && next.assetId === e.assetId) continue;
    if (fnv1a(e.assetId) % CATALOG_SHARD_ENTRIES === 0 || size >= CATALOG_PART_BYTES) {
      shards.push(shard);
      shard = [];
      size = 0;
    }
  }
  if (shard.length > 0) shards.push(shard);
  return shards;
}

/** The catalog entry of one captured asset (the v4 row, then its names and dependencies). */
function entryOf(row: Record<string, unknown>, a: ManifestAssetInputV5): CatalogEntry {
  return {
    ...(row as CatalogEntry),
    ...(a.address !== undefined ? { address: a.address } : {}),
    ...(a.labels !== undefined && a.labels.length > 0 ? { labels: [...a.labels] } : {}),
    ...(a.dependencies !== undefined && a.dependencies.length > 0 ? { dependencies: [...new Set(a.dependencies)].sort() } : {}),
  };
}

/** Whether a materials block has a graph material with parameters (the simulation then checks texture ids). */
function hasGraphParameters(materials: unknown): boolean {
  return Array.isArray(materials) && materials.some((m) => (m as { graph?: unknown } | null)?.graph !== undefined && ((m as { parameters?: unknown[] }).parameters ?? []).length > 0);
}

/**
 * The `facts` rows: what the simulation reads of every shipped asset from its
 * first step (every model with its bounds and material map, an audio file's
 * duration; a texture's id when graph materials have parameters). Ascending
 * by id.
 */
function factRows(entries: readonly CatalogEntry[], textures: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of entries) {
    // Every model (a page knows from these whether the build draws models at all).
    if (e.kind === 'model') {
      out.push({ assetId: e.assetId, kind: 'model', ...(e['bounds'] !== undefined ? { bounds: e['bounds'] } : {}), ...(e['materials'] !== undefined ? { materials: e['materials'] } : {}) });
    } else if (e.kind === 'audio' && e['durationMs'] !== undefined) {
      out.push({ assetId: e.assetId, kind: 'audio', durationMs: e['durationMs'] });
    } else if (e.kind === 'texture' && textures) {
      out.push({ assetId: e.assetId, kind: 'texture' });
    }
  }
  return out;
}

/**
 * `captureManifestV5(input)` — the v5 manifest and its catalog files from one
 * captured state (the same inputs as the v4 capture, plus each scene's and
 * each asset's dependencies). Byte-identical for the same input.
 */
export function captureManifestV5(input: CaptureManifestV5Input): CaptureManifestV5Result {
  const hash = input.sha256 ?? sha256Hex;
  for (const [name, value] of [
    ['sceneDigest', input.sceneDigest],
    ['contentDigest', input.contentDigest],
  ] as const) {
    if (!isDigest(value)) return { ok: false, error: v5Error('field_value', `${name} must be 64 lowercase hex`) };
  }
  const files = new Map<string, CatalogFile>();
  let tooLarge: string | null = null;
  const file = (value: unknown, what: string): CatalogFileRef => {
    const bytes = catalogBytes(value);
    if (bytes.length > MANIFEST_CONTENT_FILE_MAX_BYTES && tooLarge === null) tooLarge = what;
    const digest = hash(bytes);
    const ref = { path: `content/sha256/${digest}`, digest, byteLength: bytes.length };
    if (!files.has(digest)) files.set(digest, { ...ref, bytes });
    return ref;
  };

  // The entries (every shipped asset), their shards and the facts the simulation needs.
  const byKey = new Map(input.assets.map((a) => [`${a.assetId}@${a.version}`, a]));
  const entries = sortedAssetRows(input.assets).map((row) => entryOf(row, byKey.get(`${row.assetId}@${row.version}`)!));
  const entriesById = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const list = entriesById.get(e.assetId);
    if (list === undefined) entriesById.set(e.assetId, [e]);
    else list.push(e);
  }
  const entriesOf = (ids: readonly string[]): CatalogEntry[] => [...new Set(ids)].sort().flatMap((id) => entriesById.get(id) ?? []);
  const shardRows: CatalogShardRow[] = shardEntries(entries).map((shard) => ({ first: shard[0]!.assetId, last: shard[shard.length - 1]!.assetId, count: shard.length, ...file(shard, 'an entry shard') }));

  // The blocks, each in its file or parts, in the catalog's key order.
  const { inline, files: contentBlocks } = canonicalManifestBlocks(input);
  const blocks: Partial<Record<CatalogBlockKey, unknown>> = {
    ...inline,
    ...contentBlocks,
    ...(input.media.animation.length > 0 ? { media: input.media.animation } : {}),
    ...(input.behaviors.length > 0 ? { behaviors: sortedBehaviorRows(input.behaviors) } : {}),
    ...(input.loadable !== undefined && input.loadable.length > 0 ? { loadable: input.loadable.map((r) => ({ kind: r.kind, id: r.id, ...(r.address !== undefined ? { address: r.address } : {}), ...(r.labels !== undefined ? { labels: [...r.labels] } : {}) })) } : {}),
  };
  const facts = factRows(entries, hasGraphParameters(contentBlocks.materials));
  if (facts.length > 0) blocks.facts = facts;
  const shared = entriesOf(input.dependencies ?? []);
  if (shared.length > 0) blocks.dependencies = shared;
  const fileRows: CatalogBlockRow[] = [];
  for (const key of CATALOG_BLOCK_KEYS) {
    const value = blocks[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const parts: unknown[] = Array.isArray(value) ? listParts(value) : MAP_BLOCKS.has(key) && isPlainObject(value) ? mapParts(value as Record<string, unknown>) : [value];
    if (parts.length === 0) continue;
    for (const part of parts) fileRows.push({ key, ...file(part, `the ${key} file`) });
  }

  // Every scene with the file of the entries it needs.
  const sceneRows: CatalogSceneRow[] | undefined = input.scenes?.map((sc) => ({ sceneId: sc.sceneId, path: sc.path, digest: sc.digest, byteLength: sc.byteLength, start: sc.start, dependencies: file(entriesOf(sc.dependencies), `the ${sc.sceneId} dependency file`) }));

  const root: CatalogRootV5 = {
    files: fileRows,
    ...(sceneRows !== undefined ? { scenes: sceneRows } : {}),
    entries: shardRows,
    ...(input.libraries !== undefined && input.libraries.length > 0 ? { libraries: manifestLibraryRows(input.libraries) } : {}),
  };
  const catalog = file(root, 'the catalog root');
  if (tooLarge !== null) return { ok: false, error: v5Error('limits_exceeded', `${tooLarge} exceeds ${MANIFEST_CONTENT_FILE_MAX_BYTES} bytes`) };

  const { toolchain, buildOptionsDigest } = manifestToolchain();
  const withoutBuildId: Record<string, unknown> = {
    manifestVersion: RUNTIME_CONTENT_MANIFEST_VERSION_5,
    type: RUNTIME_CONTENT_TYPE,
    projectId: input.projectId,
    revision: input.revision,
    snapshotId: `${input.projectId}@r${input.revision}`,
    capturedAt: input.capturedAt,
    sceneDigest: input.sceneDigest,
    contentDigest: input.contentDigest,
    settingsDigest: blockDigest(input.settings),
    mediaDigest: blockDigest(input.media),
    settings: input.settings,
    start: [...input.start],
    catalog,
    modules: manifestModuleRows(input.moduleIds),
    enginePins: (input.enginePins ?? M3_ENGINE_PINS).map((p) => ({ id: p.id, version: p.version, apiVersion: p.apiVersion })),
    recipes: { ...(input.recipes ?? M3_RECIPE_VERSIONS) },
    toolchain,
    buildOptionsDigest,
  };
  const buildId = hash(manifestBuildIdInputV5(withoutBuildId)!);
  const manifest = { ...withoutBuildId, buildId } as unknown as RuntimeContentManifestV5;
  const bytes = fileBytes(manifest);
  if (bytes.length > RUNTIME_CONTENT_MANIFEST_MAX_BYTES) return { ok: false, error: v5Error('limits_exceeded', `the manifest exceeds ${RUNTIME_CONTENT_MANIFEST_MAX_BYTES} bytes`) };
  return { ok: true, manifest, bytes, buildId, root, files: [...files.values()] };
}

/**
 * The exact bytes `buildId` covers for a v5 manifest: the document without
 * `buildId`, keys in `MANIFEST_KEYS_V5` order. Null when a key is missing.
 */
export function manifestBuildIdInputV5(manifest: Readonly<Record<string, unknown>>): Uint8Array | null {
  const without: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS_V5) {
    if (key === 'buildId') continue;
    if (!(key in manifest)) return null;
    without[key] = manifest[key];
  }
  return fileBytes(without);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fileRefProblem(v: unknown, what: string): string | null {
  if (!isPlainObject(v)) return `${what} is not a file row`;
  const r = v as Record<string, unknown>;
  if (!isDigest(r['digest']) || r['path'] !== `content/sha256/${String(r['digest'])}`) return `${what}: path is content/sha256/<digest>`;
  const n = r['byteLength'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MANIFEST_CONTENT_FILE_MAX_BYTES) return `${what}: byteLength is 1..${MANIFEST_CONTENT_FILE_MAX_BYTES}`;
  return null;
}

/** The settings block rule (the six registry keys in order, then the optional ones set, in order; numbers). */
function settingsProblem(settings: unknown): string | null {
  if (!isPlainObject(settings)) return 'settings must be an object';
  const keys = Object.keys(settings);
  const extra = keys.slice(M3_SETTINGS_KEYS.length).map((k) => (M3_OPTIONAL_SETTINGS_KEYS as readonly string[]).indexOf(k));
  if (keys.length < M3_SETTINGS_KEYS.length || !M3_SETTINGS_KEYS.every((k, i) => keys[i] === k) || extra.some((i, n) => i < 0 || (n > 0 && i <= extra[n - 1]!))) {
    return 'settings must carry the six registry keys in registry order, then only the optional engine settings the project sets, in registry order';
  }
  for (const k of keys) if (typeof (settings as Record<string, unknown>)[k] !== 'number') return `settings.${k} must be a number`;
  return null;
}

/**
 * `validateManifestV5(doc)` — the strict v5 reader of `manifest.json`: the
 * exact key set in order, the identity fields, the settings rule and digest,
 * the start ids, the catalog row and the `buildId` over the document.
 * The media digest is checked against the media file when it is read.
 */
export function validateManifestV5(doc: unknown, opts: { sha256?: (bytes: Uint8Array) => string; /** false: the caller checks the buildId (a page hashes with WebCrypto). */ buildId?: boolean } = {}): { ok: true; manifest: RuntimeContentManifestV5 } | { ok: false; error: ManifestErrorV2 } {
  const bad = (message: string, reason = 'field_value', found?: unknown): { ok: false; error: ManifestErrorV2 } => ({ ok: false, error: v5Error('manifest_invalid', message, reason, found) });
  if (!isPlainObject(doc)) return bad('the manifest is not an object');
  const d = doc as Record<string, unknown>;
  if (d['manifestVersion'] !== RUNTIME_CONTENT_MANIFEST_VERSION_5) return bad('manifestVersion is not 5', 'manifest_version', d['manifestVersion']);
  const keys = Object.keys(d);
  if (keys.join(',') !== MANIFEST_KEYS_V5.join(',')) {
    const unknown = keys.find((k) => !(MANIFEST_KEYS_V5 as readonly string[]).includes(k));
    if (unknown !== undefined) return bad(`unknown manifest key "${unknown}"`, 'unknown_key', unknown);
    const missing = MANIFEST_KEYS_V5.find((k) => !(k in d));
    if (missing !== undefined) return bad(`missing manifest key "${missing}"`, 'missing_key');
    return bad('the manifest keys are not in their canonical order', 'key_order');
  }
  if (d['type'] !== RUNTIME_CONTENT_TYPE) return bad('type is not the runtime-content discriminator', 'field_value', d['type']);
  const projectId = d['projectId'];
  const revision = d['revision'];
  if (typeof projectId !== 'string' || typeof revision !== 'number' || !Number.isInteger(revision)) return bad('projectId/revision must be a string/integer');
  if (d['snapshotId'] !== `${projectId}@r${revision}`) return bad('snapshotId does not match <projectId>@r<revision>', 'field_value', d['snapshotId']);
  for (const key of ['sceneDigest', 'contentDigest', 'settingsDigest', 'mediaDigest', 'buildOptionsDigest', 'buildId'] as const) {
    if (!isDigest(d[key])) return bad(`${key} must be 64 lowercase hex`, 'field_value', d[key]);
  }
  const settingsWhy = settingsProblem(d['settings']);
  if (settingsWhy !== null) return bad(settingsWhy);
  if (blockDigest(d['settings']) !== d['settingsDigest']) return bad('settingsDigest does not match the settings block', 'digest_mismatch');
  const start = d['start'];
  if (!Array.isArray(start) || start.some((s) => typeof s !== 'string' || !ID_RE.test(s)) || new Set(start).size !== start.length) return bad('start is a list of distinct scene ids');
  const catalogWhy = fileRefProblem(d['catalog'], 'catalog');
  if (catalogWhy !== null) return bad(catalogWhy);
  for (const key of ['modules', 'enginePins'] as const) if (!Array.isArray(d[key])) return bad(`${key} must be a list`);
  if (!isPlainObject(d['recipes']) || !isPlainObject(d['toolchain'])) return bad('recipes and toolchain must be objects');
  const preimage = manifestBuildIdInputV5(d);
  if (preimage === null || (opts.buildId !== false && (opts.sha256 ?? sha256Hex)(preimage) !== d['buildId'])) return bad('buildId does not match the manifest document', 'digest_mismatch', d['buildId']);
  return { ok: true, manifest: doc as unknown as RuntimeContentManifestV5 };
}

/** Why a catalog root does not have its shape (null: it does). */
export function catalogRootProblem(doc: unknown): string | null {
  if (!isPlainObject(doc)) return 'the catalog root is not an object';
  const d = doc as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!['files', 'scenes', 'entries', 'libraries'].includes(k)) return `the catalog root has an unknown key "${k}"`;
  if (!Array.isArray(d['files']) || !Array.isArray(d['entries'])) return 'the catalog root lists its files and entry shards';
  let lastAt = -1;
  let lastKey = '';
  for (const [i, raw] of (d['files'] as unknown[]).entries()) {
    const why = fileRefProblem(raw, `files[${i}]`);
    if (why !== null) return why;
    const key = (raw as Record<string, unknown>)['key'];
    const at = (CATALOG_BLOCK_KEYS as readonly unknown[]).indexOf(key);
    if (at < 0) return `files[${i}] names no catalog block`;
    if (at < lastAt) return 'the block files are not in the catalog key order';
    // Only a list or a map is in several parts.
    if (at === lastAt && !MAP_BLOCKS.has(lastKey) && !LIST_BLOCKS.has(lastKey)) return `the ${lastKey} block is one file`;
    lastAt = at;
    lastKey = String(key);
    if (Object.keys(raw as object).join(',') !== 'key,path,digest,byteLength') return `files[${i}] has the keys key, path, digest, byteLength`;
  }
  if (d['scenes'] !== undefined) {
    if (!Array.isArray(d['scenes'])) return 'scenes is a list';
    const seen = new Set<string>();
    for (const [i, raw] of (d['scenes'] as unknown[]).entries()) {
      if (!isPlainObject(raw)) return `scenes[${i}] is not an object`;
      const r = raw as Record<string, unknown>;
      if (Object.keys(r).join(',') !== 'sceneId,path,digest,byteLength,start,dependencies') return `scenes[${i}] has the keys sceneId, path, digest, byteLength, start, dependencies`;
      if (typeof r['sceneId'] !== 'string' || !ID_RE.test(r['sceneId']) || seen.has(r['sceneId'])) return `scenes[${i}] has no distinct scene id`;
      seen.add(r['sceneId']);
      if (r['path'] !== `scenes/${r['sceneId']}.json` || !isDigest(r['digest']) || typeof r['byteLength'] !== 'number' || typeof r['start'] !== 'boolean') return `scenes[${i}] is not a scene file row`;
      const why = fileRefProblem(r['dependencies'], `scenes[${i}].dependencies`);
      if (why !== null) return why;
    }
  }
  let last = '';
  for (const [i, raw] of (d['entries'] as unknown[]).entries()) {
    const why = fileRefProblem(raw, `entries[${i}]`);
    if (why !== null) return why;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).join(',') !== 'first,last,count,path,digest,byteLength') return `entries[${i}] has the keys first, last, count, path, digest, byteLength`;
    if (typeof r['first'] !== 'string' || typeof r['last'] !== 'string' || !(r['first'] <= r['last']) || (i > 0 && !(last < r['first']))) return 'the entry shards are not in ascending, non-overlapping id order';
    if (typeof r['count'] !== 'number' || !Number.isInteger(r['count']) || r['count'] < 1) return `entries[${i}].count is a positive integer`;
    last = r['last'];
  }
  if (d['libraries'] !== undefined) {
    const why = libraryRowsProblem(d['libraries']);
    if (why !== null) return `libraries: ${why}`;
  }
  return null;
}

/** The blocks that are lists (their parts concatenate). */
const LIST_BLOCKS: ReadonlySet<string> = new Set(['tags', 'effects', 'animators', 'prefabs', 'blockTypes', 'cellFields', 'collisionLayers', 'uiThemes', 'modes', 'timelines', 'eventCues', 'materials', 'materialFunctions', 'uiDocuments', 'buffers', 'media', 'behaviors', 'loadable', 'facts', 'dependencies']);

/** Why a list of catalog entries is not one (null: it is): shape, ascending ids. */
export function catalogEntriesProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return 'the entries are a list';
  let last = '';
  for (const [i, raw] of v.entries()) {
    if (!isPlainObject(raw)) return `entry ${i} is not an object`;
    const e = raw as Record<string, unknown>;
    if (typeof e['assetId'] !== 'string' || !ID_RE.test(e['assetId'])) return `entry ${i} has no asset id`;
    if (!['model', 'audio', 'texture', 'font'].includes(e['kind'] as string)) return `entry ${e['assetId']}: kind must be "model", "audio", "texture" or "font"`;
    if (typeof e['version'] !== 'number' || !Number.isInteger(e['version']) || e['version'] < 1) return `entry ${e['assetId']}: version is a positive integer`;
    if (!isDigest(e['sourceDigest']) || e['path'] !== `content/sha256/${e['sourceDigest']}`) return `entry ${e['assetId']}: path does not match its sourceDigest`;
    if (typeof e['sourceByteLength'] !== 'number' || !Number.isInteger(e['sourceByteLength']) || e['sourceByteLength'] < 0) return `entry ${e['assetId']}: sourceByteLength is a byte count`;
    if (e['address'] !== undefined && !isAddress(e['address'])) return `entry ${e['assetId']}: address is not an address`;
    if (e['labels'] !== undefined && (!Array.isArray(e['labels']) || !e['labels'].every(isAssetLabel))) return `entry ${e['assetId']}: labels are not labels`;
    if (e['dependencies'] !== undefined && (!Array.isArray(e['dependencies']) || e['dependencies'].some((x) => typeof x !== 'string' || !ID_RE.test(x)))) return `entry ${e['assetId']}: dependencies are asset ids`;
    if (i > 0 && e['assetId'] < last) return 'the entries are not in ascending asset id order';
    last = e['assetId'];
  }
  return null;
}

/**
 * Why a whole catalog block (its parts put together) does not validate (null:
 * it does). `context` carries the other blocks a block is checked with (the
 * material functions for the materials, the input for the UI documents).
 */
export function catalogBlockProblem(key: CatalogBlockKey, value: unknown, context: { readonly materialFunctions?: unknown; readonly input?: unknown } = {}): string | null {
  if ((MANIFEST_CONTENT_FILE_KEYS as readonly string[]).includes(key)) return contentFileBlockProblem(key as ManifestContentFileKey, value, context);
  switch (key) {
    case 'media':
      if (!Array.isArray(value) || value.some((r) => !isPlainObject(r) || typeof (r as Record<string, unknown>)['entityId'] !== 'string' || typeof (r as Record<string, unknown>)['assetId'] !== 'string')) return 'media is a list of animation rows';
      return null;
    case 'behaviors':
      if (!Array.isArray(value) || value.some((r) => !isPlainObject(r) || typeof (r as Record<string, unknown>)['behaviorId'] !== 'string' || (r as Record<string, unknown>)['path'] !== `behaviors/${String((r as Record<string, unknown>)['outputDigest'])}.js`)) return 'behaviors is a list of behavior rows';
      return null;
    case 'loadable':
      return loadableRowsProblem(value);
    case 'facts':
      if (!Array.isArray(value) || value.some((r) => !isPlainObject(r) || typeof (r as Record<string, unknown>)['assetId'] !== 'string' || !['model', 'audio', 'texture'].includes((r as Record<string, unknown>)['kind'] as string))) return 'facts is a list of asset facts';
      return null;
    case 'dependencies':
      return catalogEntriesProblem(value);
    default: {
      const e = manifestBlocksProblem({ [key]: value });
      return e === null ? null : `${key}: ${e.message}`;
    }
  }
}

/** Put a block's parts together (a list's parts concatenate, a map's merge; a single part is itself). */
export function joinCatalogParts(key: string, parts: readonly unknown[]): unknown {
  if (parts.length === 1 && !LIST_BLOCKS.has(key)) return parts[0];
  if (MAP_BLOCKS.has(key)) return Object.assign({}, ...(parts as Record<string, unknown>[]));
  return (parts as unknown[][]).flat();
}

// ---------------------------------------------------------------------------
// Reading a whole build (tools, tests, and a v4 manifest's upgrade)
// ---------------------------------------------------------------------------

/**
 * A build read whole, in the v4 shape: every block under its key, every
 * catalog entry as `assets`, the scenes' rows. What a tool or a test reads
 * (a game page reads the catalog lazily, `game-host`).
 */
export type ExpandedRuntimeContent = ExpandedRuntimeContentManifest & {
  /** The start scene ids. */
  start?: string[];
  /** v5: every catalog entry (the `assets` rows with their names). */
  entries?: CatalogEntry[];
  /** v5: the facts the simulation reads, and what the project-wide blocks need. */
  facts?: Record<string, unknown>[];
  dependencies?: CatalogEntry[];
  /** v5: each scene's dependency entries. */
  sceneDependencies?: Record<string, CatalogEntry[]>;
};

/**
 * Read one build whole: a v5 manifest with every file of its catalog (each
 * checked against its row), or a v4 manifest with its content files. `read`
 * returns a declared path's bytes (null: missing). Throws naming the first
 * problem.
 */
export function readRuntimeContentSync(doc: unknown, read: (path: string) => Uint8Array | null, opts: { sha256?: (bytes: Uint8Array) => string } = {}): ExpandedRuntimeContent {
  const hash = opts.sha256 ?? sha256Hex;
  const readFile = (ref: CatalogFileRef, what: string): unknown => {
    const bytes = read(ref.path);
    if (bytes === null) throw new Error(`${what} (${ref.path}) is missing`);
    if (bytes.length !== ref.byteLength || hash(bytes) !== ref.digest) throw new Error(`${what} (${ref.path}) does not match its digest`);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  };
  const version = (doc as { manifestVersion?: unknown } | null)?.manifestVersion;
  if (version === RUNTIME_CONTENT_MANIFEST_VERSION_4) {
    const v = validateManifestV2(doc);
    if (!v.ok) throw new Error(v.error.message);
    const m = doc as RuntimeContentManifestV2;
    const out: Record<string, unknown> = { ...m };
    for (const row of m.contentFiles ?? []) out[row.key] = readFile(row, `content file ${row.key}`);
    return { ...(out as unknown as ExpandedRuntimeContent), ...(m.scenes !== undefined ? { start: m.scenes.filter((s) => s.start).map((s) => s.sceneId) } : {}) };
  }
  const v = validateManifestV5(doc, opts);
  if (!v.ok) throw new Error(v.error.message);
  const m = v.manifest;
  const root = readFile(m.catalog, 'the catalog root') as CatalogRootV5;
  const why = catalogRootProblem(root);
  if (why !== null) throw new Error(why);
  const parts = new Map<string, unknown[]>();
  for (const row of root.files) {
    const list = parts.get(row.key) ?? [];
    list.push(readFile(row, `the ${row.key} file`));
    parts.set(row.key, list);
  }
  const blocks: Record<string, unknown> = {};
  for (const [key, list] of parts) blocks[key] = joinCatalogParts(key, list);
  for (const key of CATALOG_BLOCK_KEYS) {
    if (!(key in blocks)) continue;
    const problem = catalogBlockProblem(key, blocks[key], { materialFunctions: blocks['materialFunctions'], input: blocks['input'] });
    if (problem !== null) throw new Error(problem);
  }
  const media: MediaBlock = { animation: (blocks['media'] as MediaAnimationRow[] | undefined) ?? [] };
  if (blockDigest(media) !== m.mediaDigest) throw new Error('mediaDigest does not match the media file');
  const entries: CatalogEntry[] = [];
  for (const shard of root.entries) {
    const list = readFile(shard, 'an entry shard');
    const problem = catalogEntriesProblem(list);
    if (problem !== null) throw new Error(problem);
    entries.push(...(list as CatalogEntry[]));
  }
  const sceneDependencies: Record<string, CatalogEntry[]> = {};
  for (const sc of root.scenes ?? []) sceneDependencies[sc.sceneId] = readFile(sc.dependencies, `the ${sc.sceneId} dependency file`) as CatalogEntry[];
  const { media: _rows, behaviors, loadable, facts, dependencies, ...rest } = blocks;
  return {
    ...(m as unknown as RuntimeContentManifestV2),
    ...(rest as Partial<ExpandedRuntimeContentManifest>),
    ...(root.scenes !== undefined ? { scenes: root.scenes.map((s) => ({ sceneId: s.sceneId, path: s.path, digest: s.digest, byteLength: s.byteLength, start: s.start })) } : {}),
    assets: entries.map(({ address: _a, labels: _l, dependencies: _d, ...row }) => row),
    ...(loadable !== undefined ? { loadable: loadable as LoadableRow[] } : {}),
    media,
    behaviors: (behaviors as Record<string, unknown>[] | undefined) ?? [],
    ...(root.libraries !== undefined ? { libraries: root.libraries } : {}),
    start: [...m.start],
    entries,
    ...(facts !== undefined ? { facts: facts as Record<string, unknown>[] } : {}),
    ...(dependencies !== undefined ? { dependencies: dependencies as CatalogEntry[] } : {}),
    sceneDependencies,
  } as ExpandedRuntimeContent;
}
