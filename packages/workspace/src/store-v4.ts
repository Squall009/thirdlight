/**
 * Phase 12 (c): storage version 4 — a project is several files.
 *
 *   project.json            manifest schemaVersion 3 (id, name, engine, createdAt;
 *                           a 2 is upgraded on open, phase 24.8)
 *   content.json            { storageVersion: 4, type: "project-content", projectId,
 *                             revision, content (v4), retry }
 *   scenes/<sceneId>.json   { storageVersion: 4, type: "scene", projectId,
 *                             scene (schemaVersion 4), retry }
 *   .thirdlight/journal.json   only while a multi-file transaction is in flight
 *
 * - The project revision is the highest `revision` of its files; every write
 *   stamps the files it writes with the new project revision.
 * - A transaction writes the files that changed: one scene, or the content
 *   file, or both (and creates/removes a scene file when the scene index
 *   changes). One file is written with the atomic procedure `W` directly;
 *   several go through a redo journal: the journal (every new file's full
 *   bytes, or a removal) is made durable first — that is the commit point —
 *   then the files are written and the journal removed. A journal left by a
 *   crash is completed (rolled forward) before the project is read.
 * - Retry records live in the files a transaction wrote; the project's
 *   record map is the union over its files. The retry block names its record
 *   format (`recordVersion` 2 since phase 14.8: a record also stores the
 *   acked `sceneId`); a block without the key (version 1) is still read.
 * - External changes are detected per file (a changed, missing or new file
 *   in the index): the foreign bytes are snapshotted and writes pause.
 *
 * Validation is the model's (`validateProjectV4`); nothing here repairs data.
 * Phase 24.8: a schemaVersion 2 project is upgraded by the model's pure
 * `upgradeProjectDocsV24` before it is validated (the open writes the result
 * back); game data it refuses blocks the load with the model's problems.
 * Phase 25.7: a schemaVersion 3 project (and a 2 after that upgrade) goes
 * through `upgradeProjectDocsV25` to 4 (no document changes; written back).
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  migrateProjectV3ToV4,
  PROJECT_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION_UPGRADED,
  PROJECT_SCHEMA_VERSION_V24,
  isUpgradedProjectSchemaVersion,
  upgradeProjectDocsV24,
  upgradeProjectDocsV25,
  parseDocumentBytes,
  serializeCanonical,
  validateContentV3,
  validateProjectV4,
  validateSceneV3,
  type ContentCatalogV3,
  type ContentCatalogV4,
  type Manifest,
  type ProjectManifestV2,
  type SceneV3,
  type SceneV4,
  type BlockChunk,
  type BlockLayerData,
} from '@thirdlight/project-model';

import { sha256Hex } from './digest';
import { RETRY_RECORD_VERSION, RETRY_RETENTION, validateRetryBlock, type RetryRecord } from './envelope';
import { snapshotForeignBytes } from './recovery';
import { pointerSegment, type LoadDetail, type UnavailableReason } from './errors';
import { writeAtomic, type WriteOps } from './write';

export const CONTENT_REL = 'content.json';
export const MANIFEST_REL_V4 = 'project.json';
export const JOURNAL_NAME = 'journal.json';
export const sceneRel = (sceneId: string): string => `scenes/${sceneId}.json`;

const CONTENT_FILE_KEYS = ['storageVersion', 'type', 'projectId', 'revision', 'content', 'retry'] as const;
const SCENE_FILE_KEYS = ['storageVersion', 'type', 'projectId', 'scene', 'retry'] as const;
/** Phase 23.5: a scene file lists its block chunk files (only when it has some). */
const SCENE_FILE_OPTIONAL_KEYS = ['blockChunks'] as const;
const CHUNK_FILE_KEYS = ['storageVersion', 'type', 'projectId', 'sceneId', 'entityId', 'cx', 'cz', 'palette', 'columns'] as const;

/**
 * Phase 23.5: one block-layer chunk per file,
 * `scenes/<sceneId>.blocks/<entityId>.<cx>.<cz>.json`. The scene file lists
 * the chunk files it owns (`blockChunks`, the index) and carries the
 * revision and the retry records: every change to a scene's cells rewrites
 * its scene file and the chunk files that changed, in one transaction.
 */
export const chunkRel = (sceneId: string, entityId: string, cx: number, cz: number): string => `scenes/${sceneId}.blocks/${entityId}.${cx}.${cz}.json`;
const CHUNK_REL_RE = /^scenes\/[a-z0-9][a-z0-9_-]{0,63}\.blocks\/[a-z0-9][a-z0-9_-]{0,63}\.-?\d{1,4}\.-?\d{1,4}\.json$/;
/** The directory holding a scene's chunk files. */
export const chunkDirRel = (sceneId: string): string => `scenes/${sceneId}.blocks`;

/** A file as this backend last wrote or loaded it. */
export interface KnownFile {
  bytes: Uint8Array;
  hash: string;
}

/** The whole v4 project as the session holds it. */
export interface V4State {
  manifest: ProjectManifestV2;
  content: ContentCatalogV4;
  /** By scene id, in index order. */
  scenes: Map<string, SceneV4>;
  /** The project revision (the highest file revision). */
  revision: number;
  /** The last known bytes of every project file (relative path → bytes, hash). */
  files: Map<string, KnownFile>;
  /** The retry records each file carries. */
  fileRecords: Map<string, RetryRecord[]>;
}

// ---- bytes ---------------------------------------------------------------------

function jsonBytes(doc: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * Phase 21.4: the project-file layout — objects indented (two spaces), and
 * every array of objects with one element per line (an entity, a material, a
 * retry record: a diff shows one line per changed item). About a third of
 * the fully indented size, so an edit writes (and hashes) far fewer bytes.
 * Any JSON reader reads it; the files stay strict JSON.
 */
export function layoutProjectJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => v !== null && typeof v === 'object')) {
      const inner = `${indent}  `;
      return `[\n${value.map((v) => `${inner}${JSON.stringify(v)}`).join(',\n')}\n${indent}]`;
    }
    return JSON.stringify(value);
  }
  if (value !== null && typeof value === 'object') {
    const inner = `${indent}  `;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      parts.push(`${inner}${JSON.stringify(k)}: ${layoutProjectJson(v, inner)}`);
    }
    return parts.length === 0 ? '{}' : `{\n${parts.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fileJsonBytes(doc: unknown): Uint8Array {
  return new TextEncoder().encode(`${layoutProjectJson(doc)}\n`);
}

export function contentFileBytes(projectId: string, revision: number, content: ContentCatalogV4, records: readonly RetryRecord[]): Uint8Array {
  return fileJsonBytes({
    storageVersion: 4,
    type: 'project-content',
    projectId,
    revision,
    content,
    retry: { recordVersion: RETRY_RECORD_VERSION, retention: RETRY_RETENTION, records },
  });
}

export function sceneFileBytes(projectId: string, scene: SceneV4, records: readonly RetryRecord[]): Uint8Array {
  const split = splitSceneBlocks(scene);
  return fileJsonBytes({
    storageVersion: 4,
    type: 'scene',
    projectId,
    scene: split.scene,
    ...(split.index.length > 0 ? { blockChunks: split.index } : {}),
    retry: { recordVersion: RETRY_RECORD_VERSION, retention: RETRY_RETENTION, records },
  });
}

/**
 * Phase 23.5: a scene as its file stores it (each layer entry without its
 * chunks; entries with regions only keep them) plus the chunk index.
 */
function splitSceneBlocks(scene: SceneV4): { scene: SceneV4; index: { entityId: string; cx: number; cz: number }[] } {
  if (scene.blocks === undefined || scene.blocks.length === 0) return { scene, index: [] };
  const index: { entityId: string; cx: number; cz: number }[] = [];
  const entries: BlockLayerData[] = [];
  for (const b of scene.blocks) {
    for (const c of b.chunks ?? []) index.push({ entityId: b.entityId, cx: c.cx, cz: c.cz });
    entries.push({ entityId: b.entityId, ...(b.regions !== undefined ? { regions: b.regions } : {}) });
  }
  return { scene: { ...scene, blocks: entries }, index };
}

const chunkBytesCache = new WeakMap<BlockChunk, { key: string; bytes: Uint8Array; hash: string }>();

/** Phase 23.5: a chunk file's bytes (palette one value per line, one column per line: a diff shows the columns that changed). */
export function chunkFileBytes(projectId: string, sceneId: string, entityId: string, chunk: BlockChunk): { bytes: Uint8Array; hash: string } {
  const key = `${projectId}|${sceneId}|${entityId}`;
  const hit = chunkBytesCache.get(chunk);
  if (hit !== undefined && hit.key === key) return hit;
  const head = [
    `  "storageVersion": 4`,
    `  "type": "block-chunk"`,
    `  "projectId": ${JSON.stringify(projectId)}`,
    `  "sceneId": ${JSON.stringify(sceneId)}`,
    `  "entityId": ${JSON.stringify(entityId)}`,
    `  "cx": ${chunk.cx}`,
    `  "cz": ${chunk.cz}`,
    `  "palette": [\n${chunk.palette.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
    `  "columns": [\n${chunk.columns.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
  ];
  const bytes = new TextEncoder().encode(`{\n${head.join(',\n')}\n}\n`);
  const out = { key, bytes, hash: sha256Hex(bytes) };
  chunkBytesCache.set(chunk, out);
  return out;
}

/** Phase 23.5: every chunk file of a scene (relative path → bytes, hash). */
export function sceneChunkFiles(projectId: string, scene: SceneV4): Map<string, { bytes: Uint8Array; hash: string }> {
  const out = new Map<string, { bytes: Uint8Array; hash: string }>();
  for (const b of scene.blocks ?? []) for (const c of b.chunks ?? []) out.set(chunkRel(scene.sceneId, b.entityId, c.cx, c.cz), chunkFileBytes(projectId, scene.sceneId, b.entityId, c));
  return out;
}

/** Whether a relative path is a chunk file of `sceneId` (or of any scene). */
export function isChunkRel(rel: string, sceneId?: string): boolean {
  return CHUNK_REL_RE.test(rel) && (sceneId === undefined || rel.startsWith(`${chunkDirRel(sceneId)}/`));
}

export function manifestV2Bytes(manifest: ProjectManifestV2): Uint8Array {
  const s = serializeCanonical(manifest as unknown as Parameters<typeof serializeCanonical>[0]);
  return s.ok ? s.bytes : jsonBytes(manifest);
}

// ---- reading -----------------------------------------------------------------

export type LoadV4Outcome =
  /** `upgraded`: a schemaVersion 2 project read through the phase 24.8 upgrade (not yet written back; its notes). */
  | { kind: 'loaded'; state: V4State; upgraded?: { notes: string[] } }
  | { kind: 'blocked'; reason: UnavailableReason; errors: readonly LoadDetail[]; count: number };

function blocked(reason: UnavailableReason, errors: LoadDetail[]): LoadV4Outcome {
  return { kind: 'blocked', reason, errors: errors.slice(0, 10), count: errors.length };
}

function readJson(ops: WriteOps, path: string): { ok: true; value: Record<string, unknown>; bytes: Uint8Array } | { ok: false; missing: boolean; error: LoadDetail } {
  let bytes: Uint8Array;
  try {
    bytes = ops.readFile(path);
  } catch (e) {
    const missing = (e as { code?: string }).code === 'ENOENT' || !ops.fileExists(path);
    return { ok: false, missing, error: { code: 'envelope_invalid', path: '', message: `${path} is ${missing ? 'missing' : 'unreadable'}`, expected: 'a readable project file' } };
  }
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, missing: false, error: parsed.error as LoadDetail };
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, missing: false, error: { code: 'envelope_invalid', path: '', message: `${path} is not a JSON object`, expected: 'object' } };
  }
  return { ok: true, value: parsed.value as Record<string, unknown>, bytes };
}

function checkFileKeys(doc: Record<string, unknown>, keys: readonly string[], type: string, projectId: string, label: string, optional: readonly string[] = []): LoadDetail | null {
  for (const k of keys) if (!(k in doc)) return { code: 'envelope_invalid', path: `/${pointerSegment(k)}`, message: `${label}: required key '${k}' is missing`, expected: keys.join(', ') };
  for (const k of Object.keys(doc)) if (!keys.includes(k) && !optional.includes(k)) return { code: 'envelope_invalid', path: `/${pointerSegment(k)}`, message: `${label}: unknown key '${k}'`, expected: [...keys, ...optional].join(', ') };
  if (doc['storageVersion'] !== 4) return { code: 'storage_version_unsupported', path: '/storageVersion', message: `${label}: storageVersion must be 4`, expected: '4' };
  if (doc['type'] !== type) return { code: 'envelope_invalid', path: '/type', message: `${label}: type must be "${type}"`, expected: type };
  if (doc['projectId'] !== projectId) return { code: 'envelope_invalid', path: '/projectId', message: `${label}: projectId must equal the project directory name`, expected: projectId };
  return null;
}

/**
 * Read and validate a v4 project directory (the journal, if any, must have
 * been rolled forward first). Read-only.
 */
export function loadV4(ops: WriteOps, dir: string, projectId: string): LoadV4Outcome {
  const man = readJson(ops, join(dir, MANIFEST_REL_V4));
  if (!man.ok) return blocked('manifest_invalid', [man.error]);
  const content = readJson(ops, join(dir, CONTENT_REL));
  if (!content.ok) return blocked('envelope_invalid', [content.error]);
  const ce = checkFileKeys(content.value, CONTENT_FILE_KEYS, 'project-content', projectId, CONTENT_REL);
  if (ce !== null) return blocked(ce.code as UnavailableReason, [ce]);
  const contentRevision = content.value['revision'];
  if (typeof contentRevision !== 'number' || !Number.isSafeInteger(contentRevision) || contentRevision < 0) {
    return blocked('envelope_invalid', [{ code: 'revision_invalid', path: '/revision', message: `${CONTENT_REL}: revision must be a non-negative integer`, expected: 'integer >= 0' }]);
  }
  const index = (content.value['content'] as { scenes?: unknown } | null)?.scenes;
  const sceneIds = Array.isArray(index) ? index.map((e) => (e as { sceneId?: unknown })?.sceneId).filter((x): x is string => typeof x === 'string') : [];
  const files = new Map<string, KnownFile>();
  files.set(MANIFEST_REL_V4, { bytes: man.bytes, hash: sha256Hex(man.bytes) });
  files.set(CONTENT_REL, { bytes: content.bytes, hash: sha256Hex(content.bytes) });
  const sceneDocs: unknown[] = [];
  const sceneRetry: { rel: string; retry: unknown; revision: number }[] = [];
  let revision = contentRevision;
  for (const id of sceneIds) {
    const rel = sceneRel(id);
    const f = readJson(ops, join(dir, rel));
    if (!f.ok) return blocked('envelope_invalid', [{ ...f.error, path: `/${rel}` }]);
    const se = checkFileKeys(f.value, SCENE_FILE_KEYS, 'scene', projectId, rel, SCENE_FILE_OPTIONAL_KEYS);
    if (se !== null) return blocked(se.code as UnavailableReason, [se]);
    const scene = f.value['scene'] as { revision?: unknown; sceneId?: unknown } | null;
    if (scene?.sceneId !== id) {
      return blocked('manifest_scene_mismatch', [{ code: 'manifest_scene_mismatch', path: `/${rel}`, message: `${rel} holds scene "${String(scene?.sceneId)}" (the file name is the scene id)`, expected: id }]);
    }
    files.set(rel, { bytes: f.bytes, hash: sha256Hex(f.bytes) });
    // Phase 23.5: the scene's block chunks, one file each (listed by the scene file).
    const joined = joinChunkFiles(ops, dir, projectId, id, f.value['scene'], f.value['blockChunks'], files);
    if (!joined.ok) return blocked('envelope_invalid', [joined.error]);
    sceneDocs.push(joined.scene);
    const r = typeof scene.revision === 'number' ? scene.revision : 0;
    sceneRetry.push({ rel, retry: f.value['retry'], revision: r });
    if (r > revision) revision = r;
  }
  // Phase 24.8: a schemaVersion 2 project is upgraded before it is validated.
  let manifestDoc: unknown = man.value;
  let contentDoc: unknown = content.value['content'];
  let docs: unknown[] = sceneDocs;
  let upgraded: { notes: string[] } | undefined;
  const fromVersion = man.value['schemaVersion'];
  if (fromVersion === PROJECT_SCHEMA_VERSION_UPGRADED) {
    const u = upgradeProjectDocsV24(contentDoc, sceneDocs);
    if (u.errors.length > 0) {
      const first = u.errors[0] as { document?: string };
      return blocked(first.document === 'scene' ? 'scene_invalid' : 'content_invalid', u.errors as unknown as LoadDetail[]);
    }
    contentDoc = u.content;
    docs = u.scenes;
    upgraded = { notes: [`the project was upgraded from project schemaVersion ${PROJECT_SCHEMA_VERSION_UPGRADED} to ${PROJECT_SCHEMA_VERSION_V24} (phase 24: the engine has no game rules)`, ...u.notes] };
  }
  // Phase 25.7: a schemaVersion 3 project (or a 2 just upgraded to 3) becomes 4 (no document changes: old ids are kept).
  if (isUpgradedProjectSchemaVersion(fromVersion)) {
    const u = upgradeProjectDocsV25(contentDoc, docs);
    manifestDoc = { ...man.value, schemaVersion: PROJECT_SCHEMA_VERSION };
    contentDoc = u.content;
    docs = u.scenes;
    upgraded = { notes: [...(upgraded?.notes ?? [`the project was upgraded from project schemaVersion ${PROJECT_SCHEMA_VERSION_V24} to ${PROJECT_SCHEMA_VERSION}`]), ...u.notes] };
  }
  const v = validateProjectV4(manifestDoc, contentDoc, docs, revision);
  if (!v.ok) {
    // A document that fails its own validation blocks with that document's
    // reason (as the v1–v3 load does); a cross-document rule reports its code.
    const first = v.errors[0] as { code?: string; document?: string } | undefined;
    const reason =
      first?.document === 'manifest'
        ? 'manifest_invalid'
        : first?.document === 'content'
          ? 'content_invalid'
          : first?.document === 'scene'
            ? 'scene_invalid'
            : (first?.code ?? 'scene_invalid');
    return blocked(reason as UnavailableReason, v.errors as unknown as LoadDetail[]);
  }
  if (v.normalized.manifest.id !== projectId) {
    return blocked('manifest_scene_mismatch', [{ code: 'manifest_scene_mismatch', path: '/id', document: 'manifest', message: 'manifest.id must equal the project directory name', expected: projectId }]);
  }
  const fileRecords = new Map<string, RetryRecord[]>();
  const cr = validateRetryBlock(content.value['retry'], contentRevision, projectId, 4);
  if (!cr.ok) return blocked('retry_records_invalid', [{ ...cr.error, path: `/${CONTENT_REL}${cr.error.path}` }]);
  fileRecords.set(CONTENT_REL, cr.records);
  for (const { rel, retry, revision: r } of sceneRetry) {
    const res = validateRetryBlock(retry, r, projectId, 4);
    if (!res.ok) return blocked('retry_records_invalid', [{ ...res.error, path: `/${rel}${res.error.path}` }]);
    fileRecords.set(rel, res.records);
  }
  const scenes = new Map<string, SceneV4>();
  for (const e of v.normalized.content.scenes) {
    const s = v.normalized.scenes.find((x) => x.sceneId === e.sceneId);
    if (s !== undefined) scenes.set(e.sceneId, s);
  }
  return {
    kind: 'loaded',
    state: { manifest: v.normalized.manifest, content: v.normalized.content, scenes, revision, files, fileRecords },
    ...(upgraded !== undefined ? { upgraded } : {}),
  };
}

/**
 * Phase 23.5: read the chunk files a scene file lists and put the chunks
 * back into the scene's layer entries (the model validates the result).
 */
function joinChunkFiles(
  ops: WriteOps,
  dir: string,
  projectId: string,
  sceneId: string,
  scene: unknown,
  index: unknown,
  files: Map<string, KnownFile>,
): { ok: true; scene: unknown } | { ok: false; error: LoadDetail } {
  if (index === undefined) return { ok: true, scene };
  const bad = (path: string, message: string): { ok: false; error: LoadDetail } => ({ ok: false, error: { code: 'envelope_invalid', path, message, expected: 'a valid block chunk index and chunk files' } });
  const rel0 = sceneRel(sceneId);
  if (!Array.isArray(index)) return bad(`/${rel0}/blockChunks`, `${rel0}: blockChunks is a list of {entityId, cx, cz}`);
  if (typeof scene !== 'object' || scene === null) return { ok: true, scene };
  const blocks = new Map<string, Record<string, unknown>>();
  const listed = (scene as { blocks?: unknown }).blocks;
  if (Array.isArray(listed)) for (const b of listed) if (typeof b === 'object' && b !== null && typeof (b as { entityId?: unknown }).entityId === 'string') blocks.set((b as { entityId: string }).entityId, { ...(b as Record<string, unknown>) });
  for (let i = 0; i < index.length; i++) {
    const e = index[i] as { entityId?: unknown; cx?: unknown; cz?: unknown } | null;
    if (e === null || typeof e !== 'object' || typeof e.entityId !== 'string' || !Number.isSafeInteger(e.cx) || !Number.isSafeInteger(e.cz)) return bad(`/${rel0}/blockChunks/${i}`, `${rel0}: a chunk index entry is {entityId, cx, cz}`);
    const rel = chunkRel(sceneId, e.entityId, e.cx as number, e.cz as number);
    if (!CHUNK_REL_RE.test(rel)) return bad(`/${rel0}/blockChunks/${i}`, `${rel0}: a chunk index entry names no valid chunk file`);
    const f = readJson(ops, join(dir, rel));
    if (!f.ok) return { ok: false, error: { ...f.error, path: `/${rel}` } };
    const ce = checkFileKeys(f.value, CHUNK_FILE_KEYS, 'block-chunk', projectId, rel);
    if (ce !== null) return { ok: false, error: ce };
    if (f.value['sceneId'] !== sceneId || f.value['entityId'] !== e.entityId || f.value['cx'] !== e.cx || f.value['cz'] !== e.cz) return bad(`/${rel}`, `${rel} holds a different chunk than its name and the index say`);
    files.set(rel, { bytes: f.bytes, hash: sha256Hex(f.bytes) });
    let entry = blocks.get(e.entityId);
    if (entry === undefined) {
      entry = { entityId: e.entityId };
      blocks.set(e.entityId, entry);
    }
    const chunks = (entry['chunks'] as unknown[] | undefined) ?? [];
    chunks.push({ cx: f.value['cx'], cz: f.value['cz'], palette: f.value['palette'], columns: f.value['columns'] });
    entry['chunks'] = chunks;
  }
  return { ok: true, scene: { ...(scene as Record<string, unknown>), blocks: [...blocks.values()] } };
}

/** Whether a project directory uses the v4 layout (a `content.json`). */
export function isV4Layout(ops: WriteOps, dir: string): boolean {
  return ops.fileExists(join(dir, CONTENT_REL));
}

/** A `W` temp of a v4 project file: `.<target>.tmp-<pid>-<nonce>` (write.ts). */
const V4_TEMP_IN_PROJECT = /^\.(content|project)\.json\.tmp-/;
const V4_TEMP_IN_SCENES = /^\.[a-z0-9][a-z0-9_-]{0,63}\.json\.tmp-/;
const V4_TEMP_IN_THIRDLIGHT = /^\.journal\.json\.tmp-/;
const V4_TEMP_IN_CHUNKS = /^\.[a-z0-9][a-z0-9_-]{0,63}\.-?\d{1,4}\.-?\d{1,4}\.json\.tmp-/;

/**
 * Leftover `W` temps of the v4 project files (workspace.md §5.4): of
 * `content.json` / `project.json`, of every scene file, and of the journal.
 * Relative to the project directory, sorted.
 */
export function listLeftoverTempsV4(ops: WriteOps, dir: string, sceneDir: string, thirdlightDir: string): string[] {
  const out: string[] = [];
  for (const n of ops.listDir(dir)) if (V4_TEMP_IN_PROJECT.test(n)) out.push(n);
  for (const n of ops.listDir(sceneDir)) {
    if (V4_TEMP_IN_SCENES.test(n)) out.push(`scenes/${n}`);
    // Phase 23.5: temps of chunk files in a scene's `.blocks` directory.
    else if (/^[a-z0-9][a-z0-9_-]{0,63}\.blocks$/.test(n)) for (const m of ops.listDir(join(sceneDir, n))) if (V4_TEMP_IN_CHUNKS.test(m)) out.push(`scenes/${n}/${m}`);
  }
  for (const n of ops.listDir(thirdlightDir)) if (V4_TEMP_IN_THIRDLIGHT.test(n)) out.push(`.thirdlight/${n}`);
  return out.sort();
}

/** §5.4: the owner deletes every leftover v4 temp at open (before any command). */
export function cleanLeftoverTempsV4(ops: WriteOps, dir: string, sceneDir: string, thirdlightDir: string): number {
  let n = 0;
  for (const rel of listLeftoverTempsV4(ops, dir, sceneDir, thirdlightDir)) {
    const [head, ...rest] = rel.split('/');
    const path = rest.length === 0 ? join(dir, rel) : join(head === 'scenes' ? sceneDir : thirdlightDir, rest.join('/'));
    try {
      ops.removeFile(path);
      n += 1;
    } catch {
      // best effort: a temp never affects what loads (the target is renamed or not)
    }
  }
  return n;
}

/** The union of the files' retry records, ascending appliedRevision. */
export function mergedRecords(state: V4State): RetryRecord[] {
  const byId = new Map<string, RetryRecord>();
  for (const list of state.fileRecords.values()) for (const r of list) byId.set(r.requestId, r);
  return [...byId.values()].sort((a, b) => a.appliedRevision - b.appliedRevision);
}

// ---- the journal ----------------------------------------------------------------

/** One file a transaction writes (`bytes`) or removes (`bytes: null`). */
export interface FileWrite {
  rel: string;
  bytes: Uint8Array | null;
}

interface JournalDoc {
  journalVersion: 1;
  projectId: string;
  writes: { rel: string; bytes: string | null; sha256: string | null }[];
}

function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function relSafe(rel: string): boolean {
  return rel === CONTENT_REL || rel === MANIFEST_REL_V4 || /^scenes\/[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(rel) || CHUNK_REL_RE.test(rel);
}

function applyWrite(ops: WriteOps, dir: string, w: FileWrite): { ok: true } | { ok: false; errno?: string } {
  const target = join(dir, w.rel);
  if (w.bytes === null) {
    try {
      ops.removeFile(target);
      ops.fsyncDir(dirname(target));
      return { ok: true };
    } catch (e) {
      return { ok: false, errno: (e as { code?: string }).code };
    }
  }
  ensureChunkDir(ops, dir, w.rel);
  const res = writeAtomic({ dir: dirname(target), target, bytes: w.bytes, allowedPreHashes: [], previousHash: null, ops });
  if (res.failed) return { ok: false, ...(res.failed.errno !== undefined ? { errno: res.failed.errno } : {}) };
  return { ok: true };
}

/** Phase 23.5: a chunk file's directory (`scenes/<sceneId>.blocks`) is made on first write. */
function ensureChunkDir(ops: WriteOps, dir: string, rel: string): void {
  if (!CHUNK_REL_RE.test(rel)) return;
  const d = dirname(join(dir, rel));
  if (ops.dirExists(d)) return;
  try {
    mkdirSync(d, { recursive: true, mode: 0o755 });
    ops.fsyncDir(dirname(d));
  } catch {
    // the atomic write below reports a real failure
  }
}

/**
 * Complete a journal left by an interrupted transaction (the journal is the
 * commit point: its writes are redone, then it is removed). A journal that
 * does not verify is left in place and reported — never half-applied.
 */
export function rollForwardJournal(ops: WriteOps, dir: string, thirdlightDir: string, projectId: string): { ok: true; applied: number } | { ok: false; error: LoadDetail } {
  const path = join(thirdlightDir, JOURNAL_NAME);
  if (!ops.fileExists(path)) return { ok: true, applied: 0 };
  const read = readJson(ops, path);
  if (!read.ok) return { ok: false, error: { code: 'envelope_invalid', path: '/.thirdlight/journal.json', message: 'an interrupted transaction journal is unreadable', expected: 'a readable journal (restore from backup, or remove it to drop the transaction)' } };
  const doc = read.value as unknown as JournalDoc;
  const bad = (message: string): { ok: false; error: LoadDetail } => ({ ok: false, error: { code: 'envelope_invalid', path: '/.thirdlight/journal.json', message, expected: 'a valid transaction journal' } });
  if (doc.journalVersion !== 1 || doc.projectId !== projectId || !Array.isArray(doc.writes)) return bad('the transaction journal is not a journal of this project');
  const writes: FileWrite[] = [];
  for (const w of doc.writes) {
    if (typeof w?.rel !== 'string' || !relSafe(w.rel)) return bad('the transaction journal names a file outside the project layout');
    if (w.bytes === null) writes.push({ rel: w.rel, bytes: null });
    else {
      const bytes = fromBase64(w.bytes);
      if (sha256Hex(bytes) !== w.sha256) return bad(`the transaction journal entry for ${w.rel} does not match its digest`);
      writes.push({ rel: w.rel, bytes });
    }
  }
  for (const w of writes) {
    const r = applyWrite(ops, dir, w);
    if (!r.ok) return bad(`could not complete the interrupted transaction (${w.rel}: ${r.errno ?? 'I/O error'})`);
  }
  ops.removeFile(path);
  try {
    ops.fsyncDir(thirdlightDir);
  } catch {
    // best effort: the journal is removed; a re-run is idempotent
  }
  return { ok: true, applied: writes.length };
}

// ---- writing ----------------------------------------------------------------------

export type TransactionOutcome =
  | { ok: true }
  /** A file is not what this backend last wrote: the external-change protocol. */
  | { ok: false; external: { rel: string; bytes: Uint8Array; hash: string } }
  | { ok: false; unreadable: { rel: string; errno?: string } }
  /** `previous`: nothing changed on disk. `new-undurable`: committed (journal or rename), durability unproven. */
  | { ok: false; failed: { onDiskState: 'previous' | 'new-undurable'; errno?: string } };

const EMPTY_HASH = sha256Hex(new Uint8Array(0));

/** The pre-write check of one file against what this backend last knew. */
function preCheck(ops: WriteOps, dir: string, rel: string, known: KnownFile | undefined): TransactionOutcome | null {
  const target = join(dir, rel);
  let bytes: Uint8Array;
  try {
    bytes = ops.readFile(target);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || !ops.fileExists(target)) {
      if (known === undefined) return null; // a new file: absence is expected
      return { ok: false, external: { rel, bytes: new Uint8Array(0), hash: EMPTY_HASH } };
    }
    return { ok: false, unreadable: { rel, ...(code !== undefined ? { errno: code } : {}) } };
  }
  const hash = sha256Hex(bytes);
  if (known !== undefined && hash === known.hash) return null;
  return { ok: false, external: { rel, bytes, hash } };
}

/**
 * Write one transaction's files. The caller passes the files that changed
 * (`bytes: null` removes one); `known` is what this backend last wrote.
 */
export function writeTransaction(
  ops: WriteOps,
  dir: string,
  thirdlightDir: string,
  projectId: string,
  known: ReadonlyMap<string, KnownFile>,
  writes: readonly FileWrite[],
): TransactionOutcome {
  // A journal still pending from an earlier failed apply is completed first.
  const pending = rollForwardJournal(ops, dir, thirdlightDir, projectId);
  if (!pending.ok) return { ok: false, failed: { onDiskState: 'previous' } };
  for (const w of writes) {
    const pc = preCheck(ops, dir, w.rel, known.get(w.rel));
    if (pc !== null) return pc;
  }
  if (writes.length === 1) {
    const w = writes[0] as FileWrite;
    const target = join(dir, w.rel);
    if (w.bytes !== null) ensureChunkDir(ops, dir, w.rel);
    if (w.bytes === null) {
      const r = applyWrite(ops, dir, w);
      return r.ok ? { ok: true } : { ok: false, failed: { onDiskState: 'previous', ...(r.errno !== undefined ? { errno: r.errno } : {}) } };
    }
    const k = known.get(w.rel);
    const res = writeAtomic({
      dir: dirname(target),
      target,
      bytes: w.bytes,
      allowedPreHashes: k === undefined ? null : [k.hash],
      previousHash: k?.hash ?? null,
      ops,
    });
    if (res.unreadable) return { ok: false, unreadable: { rel: w.rel, ...(res.unreadable.errno !== undefined ? { errno: res.unreadable.errno } : {}) } };
    if (res.external) return { ok: false, external: { rel: w.rel, ...res.external } };
    if (res.failed) return { ok: false, failed: { onDiskState: res.failed.onDiskState === 'previous' ? 'previous' : 'new-undurable', ...(res.failed.errno !== undefined ? { errno: res.failed.errno } : {}) } };
    return { ok: true };
  }
  // Several files: the journal is the commit point.
  const journal: JournalDoc = {
    journalVersion: 1,
    projectId,
    writes: writes.map((w) => ({ rel: w.rel, bytes: w.bytes === null ? null : toBase64(w.bytes), sha256: w.bytes === null ? null : sha256Hex(w.bytes) })),
  };
  if (!ops.dirExists(thirdlightDir)) {
    return { ok: false, failed: { onDiskState: 'previous', errno: 'ENOENT' } };
  }
  const jres = writeAtomic({ dir: thirdlightDir, target: join(thirdlightDir, JOURNAL_NAME), bytes: jsonBytes(journal), allowedPreHashes: [], previousHash: null, ops });
  if (jres.failed) {
    // The journal is not durable: nothing is committed (a torn journal fails
    // its digest check and is reported at the next open, never applied).
    ops.removeFile(join(thirdlightDir, JOURNAL_NAME));
    return { ok: false, failed: { onDiskState: 'previous', ...(jres.failed.errno !== undefined ? { errno: jres.failed.errno } : {}) } };
  }
  const done = rollForwardJournal(ops, dir, thirdlightDir, projectId);
  if (!done.ok) return { ok: false, failed: { onDiskState: 'new-undurable' } };
  return { ok: true };
}

// ---- external changes --------------------------------------------------------------

/** One project file compared with what this backend last wrote (null: unchanged). */
export function changedFile(ops: WriteOps, dir: string, rel: string, known: KnownFile | undefined): { rel: string; bytes: Uint8Array; hash: string } | { rel: string; unreadable: true } | null {
  const pc = preCheck(ops, dir, rel, known);
  if (pc === null) return null;
  if ('external' in pc) return pc.external;
  if ('unreadable' in pc) return { rel, unreadable: true };
  return null;
}

/** The first project file that differs from what this backend last wrote (or null). */
export function firstChangedFile(ops: WriteOps, dir: string, state: V4State): { rel: string; bytes: Uint8Array; hash: string } | { rel: string; unreadable: true } | null {
  for (const [rel, known] of state.files) {
    const c = changedFile(ops, dir, rel, known);
    if (c !== null) return c;
  }
  return null;
}

/** Snapshot foreign bytes of one file into `.thirdlight/recovery/` (name or null). */
export function snapshotForeignFile(thirdlightDir: string, bytes: Uint8Array, ops: WriteOps, stamp?: () => string): string | null {
  return snapshotForeignBytes(thirdlightDir, bytes, ops, stamp);
}

// ---- a project's files from v3 values (the upgrade and new projects) ---------------

/** The files of a whole project at the scene's revision, retry records empty. */
export interface ProjectFilesV4 {
  project: { manifest: ProjectManifestV2; content: ContentCatalogV4; scene: SceneV4 };
  manifest: FileWrite;
  scene: FileWrite;
  content: FileWrite;
  notes: string[];
}

/**
 * The v4 files of a project given as v3 values (manifest v1, one v3 scene,
 * the v3 content block): converted by the model (`migrateProjectV3ToV4`),
 * validated and normalized by `validateProjectV4`. The automatic v3 → v4
 * upgrade and project creation both build a project this one way, so a new
 * project is byte for byte what the upgrade of the same v3 project gives.
 */
export function projectFilesFromV3(
  projectId: string,
  manifest: Manifest,
  scene: SceneV3,
  content: ContentCatalogV3,
): { ok: true; files: ProjectFilesV4 } | { ok: false; message: string } {
  const { project, notes } = migrateProjectV3ToV4(manifest, scene, content);
  const v = validateProjectV4(project.manifest, project.content, project.scenes);
  if (!v.ok) return { ok: false, message: v.errors[0]?.message ?? 'unknown' };
  const sceneV4 = v.normalized.scenes[0] as SceneV4;
  return {
    ok: true,
    files: {
      project: { manifest: v.normalized.manifest, content: v.normalized.content, scene: sceneV4 },
      manifest: { rel: MANIFEST_REL_V4, bytes: manifestV2Bytes(v.normalized.manifest) },
      scene: { rel: sceneRel(sceneV4.sceneId), bytes: sceneFileBytes(projectId, sceneV4, []) },
      content: { rel: CONTENT_REL, bytes: contentFileBytes(projectId, sceneV4.revision, v.normalized.content, []) },
      notes,
    },
  };
}

/** The id of a new project's scene (its manifest v1 view names it too). */
export const DEFAULT_SCENE_ID = 'scene-main';

/**
 * The files of a NEW project (revision 0): one scene "Main" holding the
 * camera and the two starter lights (the runtime renders lit materials, so a
 * scene without lights plays black; they are ordinary entities the user can
 * edit) and an empty content catalog. Built as a v3 project and converted
 * like the automatic upgrade (`projectFilesFromV3`), so it is exactly the
 * project a new project was before new projects were written as v4 directly.
 *
 * Phase 15.5 reasons: the camera 0.5 m up and 4 m out at 60° frames a 1 m box
 * resting at the origin (where the editor's first box lands) with room around
 * it; the sun is a white key from above-front at 1.2 casting shadows, the
 * ambient a cool fill at 0.6 so shadowed sides stay readable. The GameObject
 * menu's directional and ambient lights are these same values (descriptors).
 */
export function defaultProjectFilesV4(
  projectId: string,
  name: string,
  createdAt: string,
  engineVersion: string,
): { ok: true; files: ProjectFilesV4 } | { ok: false; message: string } {
  const identity = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const scene = validateSceneV3({
    schemaVersion: 3,
    sceneId: DEFAULT_SCENE_ID,
    revision: 0,
    entities: [
      {
        id: 'cam-main',
        name: 'Main Camera',
        components: {
          transform: { position: [0, 0.5, 4], ...identity },
          camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
        },
      },
      {
        id: 'light-0001',
        name: 'Sun',
        components: {
          transform: { position: [0, 10, 0], ...identity },
          light: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: true },
        },
      },
      {
        id: 'light-0002',
        name: 'Ambient',
        components: {
          transform: { position: [0, 0, 0], ...identity },
          light: { type: 'ambient', color: '#8090a8', intensity: 0.6 },
        },
      },
    ],
  });
  if (!scene.ok) return { ok: false, message: `the default scene failed v3 validation: ${scene.errors[0]?.message ?? 'unknown'}` };
  const content = validateContentV3({ assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null });
  if (!content.ok) return { ok: false, message: `the empty content block failed v3 validation: ${content.errors[0]?.message ?? 'unknown'}` };
  const manifest: Manifest = {
    schemaVersion: 1,
    engineVersion,
    id: projectId,
    name,
    createdAt,
    scenes: [{ id: DEFAULT_SCENE_ID, path: 'scenes/main.json' }],
  };
  return projectFilesFromV3(projectId, manifest, scene.normalized, content.normalized);
}

// ---- migration v3 → v4 on disk -----------------------------------------------------

/**
 * Upgrade a v3 project directory in place (automatic, phase 12 c): the v3
 * envelope is copied to `.thirdlight/migrated-v3/main.json` (git-ignored
 * process state — a safety copy), then one journaled transaction writes
 * `project.json` (v2), `content.json`, `scenes/<sceneId>.json` and removes
 * `scenes/main.json`. The migration notes are returned for the problems log.
 */
export function migrateDirV3ToV4(
  ops: WriteOps,
  dir: string,
  thirdlightDir: string,
  projectId: string,
  manifest: Manifest,
  scene: SceneV3,
  content: ContentCatalogV3,
  envelopeBytes: Uint8Array,
): { ok: true; notes: string[] } | { ok: false; error: LoadDetail } {
  const built = projectFilesFromV3(projectId, manifest, scene, content);
  if (!built.ok) {
    return { ok: false, error: { code: 'envelope_invalid', path: '', message: `the automatic v3 → v4 upgrade does not validate: ${built.message}`, expected: 'a valid v4 project' } };
  }
  const { files: pf } = built;
  const notes = pf.notes;
  const backupDir = join(thirdlightDir, 'migrated-v3');
  try {
    if (!ops.dirExists(thirdlightDir)) return { ok: false, error: { code: 'envelope_invalid', path: '', message: 'the project has no .thirdlight directory', expected: '.thirdlight/' } };
    if (!ops.dirExists(backupDir)) mkdirSync(backupDir, { mode: 0o755 });
  } catch {
    // mkdir raced or failed: the atomic write below reports a real failure
  }
  const copy = writeAtomic({ dir: backupDir, target: join(backupDir, 'main.json'), bytes: envelopeBytes, allowedPreHashes: [], previousHash: null, ops });
  if (copy.failed) return { ok: false, error: { code: 'envelope_invalid', path: '', message: 'could not keep a copy of the v3 envelope before upgrading', expected: 'a writable .thirdlight/' } };
  const writes: FileWrite[] = [pf.content, pf.scene, pf.manifest];
  if (pf.scene.rel !== 'scenes/main.json') writes.push({ rel: 'scenes/main.json', bytes: null });
  const known = new Map<string, KnownFile>();
  for (const rel of [MANIFEST_REL_V4, 'scenes/main.json']) {
    try {
      const b = ops.readFile(join(dir, rel));
      known.set(rel, { bytes: b, hash: sha256Hex(b) });
    } catch {
      // absent: the transaction's pre-check treats it as new
    }
  }
  const res = writeTransaction(ops, dir, thirdlightDir, projectId, known, writes);
  if (!res.ok) {
    const why = 'external' in res ? `${res.external.rel} changed during the upgrade` : 'unreadable' in res ? `${res.unreadable.rel} is unreadable` : `write failed (${res.failed.errno ?? res.failed.onDiskState})`;
    return { ok: false, error: { code: 'envelope_invalid', path: '', message: `the automatic v3 → v4 upgrade could not be written: ${why}`, expected: 'a writable project directory' } };
  }
  return { ok: true, notes: ['upgraded from storage v3 to v4 (one file per scene)', ...notes] };
}
