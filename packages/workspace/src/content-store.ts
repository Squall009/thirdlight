/**
 * Content storage — workspace.md §13 (layout, immutable blob publication,
 * staging §7.6, reads/integrity §13.5, derived caches §13.6, quota §13.9) and
 * project-model.md §19 (`captureContent`).
 *
 * Ownership (workspace.md §13.0): this module owns every project-relative
 * content path, immutable blob publication, staging, quota accounting, the
 * integrity report, derived-cache paths and the captured content view. It
 * never accepts a caller-supplied path or digest as authoritative, and it
 * never holds the project mutation lock (the synchronous service call is the
 * lock scope for the command pipeline only; preparation and blob publication
 * run outside it — §13.3.3).
 *
 * Derived caches are regenerable and never authoritative (§13.6): a write to
 * `.thirdlight/derived/**` changes no revision, no envelope and no catalog.
 */

import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { captureContent, isValidSourcePath, validateContent } from '@thirdlight/project-model';
import type {
  CapturedContent,
  ContentCatalog,
  ContentCatalogV3,
  ImportRecipe as ModelImportRecipe,
  Scene,
  SceneV2,
  SceneV3,
} from '@thirdlight/project-model';
import type {
  AnimationProfileRequest,
  AudioImportProposal,
  ImportJobPort,
  ImportProposal,
} from '@thirdlight/asset-pipeline';
import type { BehaviorCompiler, PreparedBehaviorSource } from '@thirdlight/behavior-build';

import { sha256Hex } from './digest';
import {
  assetSourceChanged,
  assetSourceMissing,
  blobCorrupt,
  blobMissing,
  contentPublishFailed,
  contentQuotaExceeded,
  derivedCacheUnavailable,
  importRejected,
  pathRejected,
  stageExpired,
  stageLimitsExceeded,
  stageNotFound,
  type StageLimit,
} from './errors';
import type { CommandError } from '@thirdlight/commands';
import { writeAtomic, type WriteOps } from './write';

// ---- bounds (workspace.md §13.9) --------------------------------------------

/** ≤ 32 MiB per staged source / authoritative source blob. */
export const MAX_SOURCE_BYTES = 33_554_432;
/** ≤ 8 open stages per project. */
export const MAX_OPEN_STAGES = 8;
/** ≤ 128 MiB of staged bytes per project. */
export const MAX_STAGED_BYTES_PER_PROJECT = 134_217_728;
/** Stage TTL: 3 600 s (workspace.md §7.6.2). */
export const STAGE_TTL_SECONDS = 3_600;
/** Default authoritative-bytes quota per project (512 MiB). */
export const DEFAULT_MAX_SOURCE_BYTES_PER_PROJECT = 536_870_912;
/** Device free space required before a blob write: blobBytes + 64 MiB. */
export const DEFAULT_DEVICE_SPACE_RESERVE_BYTES = 67_108_864;
/** Abandoned-stage retention: 24 h by directory mtime (non-authoritative). */
export const ABANDONED_STAGE_RETENTION_SECONDS = 86_400;
/** The bounded inspection job budget (sessions.md §11.5 / delivery.md §11). */
export const INSPECT_TIMEOUT_MS = 30_000;
/** 64 lowercase hex. */
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** project-model §5.1 ID syntax. */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The content-storage configuration (a subspace of the service core). */
export interface ContentConfig {
  maxSourceBytesPerProject: number;
  deviceSpaceReserveBytes: number;
  freeSpaceBytes: () => number;
  now: () => number;
  /**
   * The injected GLB inspector (dependencies.md §4.1: `backend` constructs
   * the `asset-pipeline` inspector and injects it; `workspace` holds only
   * its type). Absent ⇒ `inspectStage` is structurally unavailable
   * (`derived_cache_unavailable`) rather than faked.
   */
  assetInspector?: StageInspector;
  /** The bounded inspection budget (default `INSPECT_TIMEOUT_MS`). */
  inspectTimeoutMs?: number;
  /**
   * The injected behavior-source compiler (packet 33; dependencies.md §4.1:
   * `backend` constructs the `behavior-build` compiler and injects it). The
   * workspace holds only its type and calls `compile` from the preparation
   * layer — no hidden global service, no source evaluation by the workspace.
   */
  behaviorCompiler?: BehaviorCompiler;
}

/**
 * One typed inspection request (packet 48): the staged bytes' declared `kind`
 * and, for a role-aware GLB publication, the requested animation roles. The
 * workspace only forwards this to the injected inspector — it never inspects
 * bytes itself and makes no role or profile decision.
 */
export interface InspectorRequest {
  readonly kind?: 'model' | 'audio';
  /** presentation.md §41.3.3: request the animated-model profile. */
  readonly animation?: AnimationProfileRequest;
}

/** Either accepted import proposal (a model GLB or a PCM WAV). */
export type ImportedProposal = ImportProposal | AudioImportProposal;

/**
 * The injected inspector surface (asset-pipeline's `inspectGlb`/`inspectAudio`
 * bound with the pinned profile/recipe/toolchain by the backend). The workspace
 * supplies the job port so the importer never reads a clock or a PRNG itself
 * (project-model §18.8.3), and forwards the caller's typed `request` (packet 48:
 * the additive third parameter — existing two-parameter inspectors stay valid).
 */
export type StageInspector = (
  bytes: Uint8Array,
  job: ImportJobPort,
  request?: InspectorRequest,
) => ImportedProposal;

/** The minimum session shape the content operations need. */
export interface ContentContext {
  projectId: string;
  /** The verified project directory (session `dir`). */
  dir: string;
  /** The verified `.thirdlight` directory (session `thirdlightDir`). */
  thirdlightDir: string;
  storageVersion: 1 | 2 | 3;
  revision: number;
  scene: Scene | SceneV2 | SceneV3 | null;
  content: ContentCatalog | ContentCatalogV3 | null;
  /**
   * The game folder of a folder project (the folder holding `thirdlight.json`);
   * `null` for a project in the data root. Asset versions with a `sourcePath`
   * are files inside it.
   */
  gameFolder?: string | null;
}

/**
 * The workspace-side typed **prepared-media facts** of one catalog asset
 * version (project-model §18.4/§23.3.7; workspace.md §16.6 item 4): the
 * resolved `(version, sourceDigest, sourceByteLength, importRecipe)` tuple
 * the captured view pins, plus the `kind` discriminator so a caller never
 * has to guess whether a version is a model or an audio byte string. Every
 * field is derived from the last acknowledged catalog — this is a typed read
 * of authoritative state, not a new persisted shape (no contract field is
 * invented). Used by the workspace's own content readers and available to
 * the packet-48 inspector wiring.
 */
export interface PreparedMediaFacts {
  readonly assetId: string;
  readonly kind: 'model' | 'audio';
  readonly version: number;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  /** Set when the bytes are a file in the game folder (relative to it). */
  readonly sourcePath?: string;
  readonly importRecipe: ModelImportRecipe;
}

// ---- artifact path rules (workspace.md §13.1 rule 5) -------------------------

export type ContentPathResult =
  | { ok: true; dir: string }
  | { ok: false; error: CommandError };

/**
 * Verify a project-relative artifact directory chain: every component must be
 * a **real** directory (never a symlink) whose resolved realpath stays under
 * the project root. With `create` the final component (and only that one) may
 * be created; every existing component is still checked first. Any violation
 * ⇒ `path_rejected` before the first read or write of the target (the backend
 * never follows, repairs or deletes it).
 */
export function verifyArtifactDir(
  projectDir: string,
  segs: readonly string[],
  create: boolean,
): ContentPathResult {
  let projectReal: string;
  try {
    projectReal = realpathSync(projectDir);
  } catch {
    return { ok: false, error: pathRejected(projectDir, 'the project directory is unresolvable') };
  }
  let p = projectDir;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]!;
    const candidate = join(p, seg);
    let st;
    try {
      st = lstatSync(candidate);
    } catch {
      st = null;
    }
    if (st === null) {
      if (!create) {
        return {
          ok: false,
          error: pathRejected(candidate, `artifact directory component '${seg}' does not exist`),
        };
      }
      try {
        mkdirSync(candidate, { mode: 0o755 });
      } catch {
        return { ok: false, error: pathRejected(candidate, `artifact directory '${seg}' could not be created`) };
      }
      try {
        st = lstatSync(candidate);
      } catch {
        return { ok: false, error: pathRejected(candidate, `artifact directory '${seg}' could not be verified`) };
      }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return {
        ok: false,
        error: pathRejected(candidate, `artifact path component '${seg}' is not a real directory (symlinks are never followed)`),
      };
    }
    p = candidate;
  }
  let realFull: string;
  try {
    realFull = realpathSync(p);
  } catch {
    return { ok: false, error: pathRejected(p, 'the artifact directory is unresolvable') };
  }
  const inside = realFull === projectReal || realFull.startsWith(projectReal.endsWith(sep) ? projectReal : projectReal + sep);
  if (!inside) {
    return { ok: false, error: pathRejected(p, 'the artifact directory escapes the project root') };
  }
  return { ok: true, dir: p };
}

/** `sources/sha256/` for the project (created on demand). */
export function sourcesDir(projectDir: string): ContentPathResult {
  return verifyArtifactDir(projectDir, ['sources', 'sha256'], true);
}

/**
 * Remove leftover blob-publication temps (`sources/sha256/.<digest>.tmp-*`,
 * workspace.md §5.4/§13.2 rule 5). Only the owner writes them (the previous
 * owner is gone by ownership semantics), so the cleanup is safe on open.
 */
export function cleanBlobTemps(projectDir: string): number {
  const dir = join(projectDir, 'sources', 'sha256');
  let removed = 0;
  try {
    if (!lstatSync(dir).isDirectory()) return 0;
  } catch {
    return 0;
  }
  for (const name of readdirSync(dir)) {
    if (/^\.[0-9a-f]{64}\.tmp-/.test(name)) {
      try {
        unlinkSync(join(dir, name));
        removed += 1;
      } catch {
        // best effort
      }
    }
  }
  return removed;
}

/** `.thirdlight/staging/` for the project (created on demand). */
export function stagingRoot(projectDir: string, thirdlightDir: string): ContentPathResult {
  return verifyArtifactDir(projectDir, ['.thirdlight', 'staging'], true);
}

// ---- staging (workspace.md §7.6) --------------------------------------------

export interface StageRequest {
  stageId: string;
  bytes: Uint8Array;
  /** Sanitized suggestion only (never a path); 1–128 chars, no control chars. */
  displayName?: string;
}

export interface StageResultOk {
  ok: true;
  stageId: string;
  byteLength: number;
  digest: string;
  expiresAt: string;
}
export type StageResult = StageResultOk | { ok: false; error: CommandError };

export type StageDiscardResult = { ok: true; discarded: boolean } | { ok: false; error: CommandError };

/** A resolved, verified stage. */
export interface ResolvedStage {
  stageId: string;
  dir: string;
  bytes: Uint8Array;
  digest: string;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function stageLimitError(limit: StageLimit, current: number, max: number): CommandError {
  return stageLimitsExceeded(limit, current, max);
}

function listStageDirs(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => {
      const p = join(root, n);
      try {
        return lstatSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Sum the staged `source.bin` bytes under the staging root. */
function stagedBytes(root: string): number {
  let total = 0;
  for (const d of listStageDirs(root)) {
    const p = join(root, d, 'source.bin');
    try {
      total += statSync(p).size;
    } catch {
      // absent → 0
    }
  }
  return total;
}

/**
 * Remove abandoned staging directories (mtime older than 24 h) and leftover
 * staging temps. Non-authoritative cleanup only — it never touches an
 * authoritative path. Runs on a successful open (workspace.md §7.6.2).
 */
export function cleanupStages(core: { ops: WriteOps }, projectDir: string, thirdlightDir: string, nowMs: number): number {
  const root = join(thirdlightDir, 'staging');
  let removed = 0;
  try {
    if (!lstatSync(root).isDirectory()) return 0;
  } catch {
    return 0;
  }
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory()) {
        if (name.startsWith('.')) {
          // A leftover staging temp file.
          try {
            unlinkSync(p);
          } catch {
            // best effort
          }
        }
        continue;
      }
      if (nowMs - st.mtimeMs > ABANDONED_STAGE_RETENTION_SECONDS * 1000) {
        rmSync(p, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // best effort
    }
  }
  return removed;
}

/** `stageContent(projectId, { stageId, bytes, displayName? })` (workspace.md §11). */
export function stageContent(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  request: StageRequest,
): StageResult {
  if (typeof request !== 'object' || request === null) {
    return { ok: false, error: pathRejected('', 'stage request must be an object') };
  }
  const { stageId, bytes } = request;
  if (typeof stageId !== 'string' || !ID_RE.test(stageId)) {
    return { ok: false, error: stageNotFound(String(stageId)) };
  }
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: pathRejected('', 'staged bytes must be a Uint8Array') };
  }
  if (request.displayName !== undefined) {
    if (typeof request.displayName !== 'string' || request.displayName.length < 1 || request.displayName.length > 128 || CONTROL_RE.test(request.displayName)) {
      return { ok: false, error: pathRejected('', 'displayName must be 1-128 chars without control characters') };
    }
  }
  if (bytes.length > MAX_SOURCE_BYTES) {
    return { ok: false, error: stageLimitError('stage_bytes', bytes.length, MAX_SOURCE_BYTES) };
  }
  const rootRes = stagingRoot(ctx.dir, ctx.thirdlightDir);
  if (!rootRes.ok) return { ok: false, error: rootRes.error };
  const root = rootRes.dir;
  const existing = listStageDirs(root);
  if (!existing.includes(stageId) && existing.length >= MAX_OPEN_STAGES) {
    return { ok: false, error: stageLimitError('open_stages', existing.length + 1, MAX_OPEN_STAGES) };
  }
  const alreadyStaged = (() => {
    try {
      return statSync(join(root, stageId, 'source.bin')).size;
    } catch {
      return 0;
    }
  })();
  const totalAfter = stagedBytes(root) - alreadyStaged + bytes.length;
  if (totalAfter > MAX_STAGED_BYTES_PER_PROJECT) {
    return { ok: false, error: stageLimitError('staged_bytes_per_project', totalAfter, MAX_STAGED_BYTES_PER_PROJECT) };
  }
  const stageRes = verifyArtifactDir(ctx.dir, ['.thirdlight', 'staging', stageId], true);
  if (!stageRes.ok) return { ok: false, error: stageRes.error };
  const stageDir = stageRes.dir;
  // The staged source file has the fixed name source.bin; a caller-provided
  // name is never used as a path.
  const target = join(stageDir, 'source.bin');
  const wr = writeAtomic({
    dir: stageDir,
    target,
    bytes,
    // Staging is a supported edit path (workspace.md §7.6.1): no pre-write
    // check, no pause, no recovery snapshot — replacing/truncating a staged
    // file is expected (BR-4).
    allowedPreHashes: [],
    previousHash: null,
    ops: core.ops,
  });
  if (wr.failed || wr.unreadable) {
    return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  }
  if (wr.external) {
    // No pre-check: this cannot happen, but fail closed rather than absorb.
    return { ok: false, error: contentPublishFailed('write') };
  }
  // stage.json: optional displayName only (non-authoritative input).
  const metaPath = join(stageDir, 'stage.json');
  if (request.displayName !== undefined) {
    const meta = new TextEncoder().encode(JSON.stringify({ displayName: request.displayName }, null, 2) + '\n');
    const mw = writeAtomic({ dir: stageDir, target: metaPath, bytes: meta, allowedPreHashes: [], previousHash: null, ops: core.ops });
    if (mw.failed || mw.unreadable || mw.external) {
      return { ok: false, error: contentPublishFailed('write', mw.failed?.onDiskState, mw.failed?.errno) };
    }
  } else {
    try {
      unlinkSync(metaPath);
    } catch {
      // absent is fine
    }
  }
  const digest = sha256Hex(bytes);
  const expiresAt = new Date(core.content.now() + STAGE_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { ok: true, stageId, byteLength: bytes.length, digest, expiresAt };
}

export type ResolveStageResult = { ok: true; stage: ResolvedStage } | { ok: false; error: CommandError };

/**
 * Resolve a stage: `path_rejected` when the staging path is not a real
 * directory chain, `stage_not_found` when the directory does not exist,
 * `stage_expired` past the 3600 s TTL. The digest is recomputed from the
 * bytes on disk (a caller-supplied digest is never authoritative).
 */
export function resolveStage(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  stageId: unknown,
): ResolveStageResult {
  if (typeof stageId !== 'string' || !ID_RE.test(stageId)) return { ok: false, error: stageNotFound(String(stageId)) };
  const dirRes = verifyArtifactDir(ctx.dir, ['.thirdlight', 'staging', stageId], false);
  if (!dirRes.ok) {
    // A missing staging directory chain is `stage_not_found`; a symlink/escape
    // (or a non-directory component) is `path_rejected` — the two must not be
    // conflated.
    const stagingPath = join(ctx.dir, '.thirdlight', 'staging');
    const stagePath = join(stagingPath, stageId);
    let stagingStat = null;
    let stageStat = null;
    try {
      stagingStat = lstatSync(stagingPath);
    } catch {
      stagingStat = null;
    }
    try {
      stageStat = lstatSync(stagePath);
    } catch {
      stageStat = null;
    }
    if (stagingStat === null || stageStat === null) return { ok: false, error: stageNotFound(stageId) };
    return { ok: false, error: dirRes.error };
  }
  const dir = dirRes.dir;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    return { ok: false, error: stageNotFound(stageId) };
  }
  const ageSeconds = Math.floor((core.content.now() - mtimeMs) / 1000);
  if (ageSeconds > STAGE_TTL_SECONDS) {
    return { ok: false, error: stageExpired(stageId, ageSeconds, STAGE_TTL_SECONDS) };
  }
  const binPath = join(dir, 'source.bin');
  let st;
  try {
    st = lstatSync(binPath);
  } catch {
    return { ok: false, error: stageNotFound(stageId) };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, error: pathRejected(binPath, 'the staged source file is not a real file') };
  }
  if (st.size > MAX_SOURCE_BYTES) {
    return { ok: false, error: stageLimitError('stage_bytes', st.size, MAX_SOURCE_BYTES) };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(binPath));
  } catch {
    return { ok: false, error: stageNotFound(stageId) };
  }
  return { ok: true, stage: { stageId, dir, bytes, digest: sha256Hex(bytes) } };
}

/** `discardStage(projectId, stageId)` (workspace.md §11). */
export function discardStage(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  stageId: unknown,
): StageDiscardResult {
  if (typeof stageId !== 'string' || !ID_RE.test(stageId)) return { ok: false, error: stageNotFound(String(stageId)) };
  const dirRes = verifyArtifactDir(ctx.dir, ['.thirdlight', 'staging', stageId], false);
  if (!dirRes.ok) return { ok: false, error: stageNotFound(String(stageId)) };
  try {
    rmSync(dirRes.dir, { recursive: true, force: true });
  } catch {
    return { ok: false, error: stageNotFound(String(stageId)) };
  }
  return { ok: true, discarded: true };
}

// ---- immutable blob publication (workspace.md §13.2) ------------------------

export type BlobSource = { kind: 'stage'; stageId: string } | { kind: 'bytes'; bytes: Uint8Array };

export interface BlobPublishRequest {
  digest: string;
  byteLength: number;
  source: BlobSource;
}

export interface BlobPublishResultOk {
  ok: true;
  digest: string;
  byteLength: number;
  published: boolean;
  alreadyPresent: boolean;
}
export type BlobPublishResult = BlobPublishResultOk | { ok: false; error: CommandError };

function readBlobBytes(path: string): { ok: true; bytes: Uint8Array } | { ok: false; code: 'ENOENT' | 'other' | 'symlink' } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return { ok: false, code: 'ENOENT' };
    if (code === 'ELOOP') return { ok: false, code: 'symlink' };
    return { ok: false, code: 'other' };
  }
  try {
    const st = statSync(path);
    const buf = new Uint8Array(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { ok: true, bytes: off === buf.length ? buf : buf.subarray(0, off) };
  } catch {
    return { ok: false, code: 'other' };
  } finally {
    closeSync(fd);
  }
}

/** Current authoritative bytes for the project (retained blobs only). */
export function authoritativeBytes(projectDir: string): number {
  const dir = join(projectDir, 'sources', 'sha256');
  let total = 0;
  try {
    if (!lstatSync(dir).isDirectory()) return 0;
  } catch {
    return 0;
  }
  for (const name of readdirSync(dir)) {
    if (!DIGEST_RE.test(name)) continue;
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // ignore
    }
  }
  return total;
}

/** Default device-free-space probe (newer Node exposes statfsSync). */
function defaultFreeSpace(p: string): number {
  try {
    const st = statfsSync(p);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export { defaultFreeSpace };

/**
 * `publishBlob(projectId, { digest, byteLength, source })` (workspace.md §11):
 * exactly the §5.1 `W` procedure with `target = sources/sha256/<digest>`.
 * Write-once: an existing path whose content matches is idempotent
 * (`alreadyPresent: true`); a mismatch is `blob_corrupt` and **no overwrite**.
 * Publication changes no authoritative state and needs no mutation lock.
 */
export function publishBlob(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  request: BlobPublishRequest,
): BlobPublishResult {
  if (typeof request !== 'object' || request === null) {
    return { ok: false, error: pathRejected('', 'blob request must be an object') };
  }
  const { digest, byteLength, source } = request;
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    return { ok: false, error: blobCorrupt(String(digest), 'sources/sha256/') };
  }
  let bytes: Uint8Array;
  if (source !== null && typeof source === 'object' && (source as BlobSource).kind === 'stage') {
    const res = resolveStage(core, ctx, (source as { stageId: string }).stageId);
    if (!res.ok) return { ok: false, error: res.error };
    bytes = res.stage.bytes;
  } else if (source !== null && typeof source === 'object' && (source as BlobSource).kind === 'bytes') {
    bytes = (source as { bytes: Uint8Array }).bytes;
    if (!(bytes instanceof Uint8Array)) {
      return { ok: false, error: pathRejected('', 'blob source bytes must be a Uint8Array') };
    }
  } else {
    return { ok: false, error: pathRejected('', 'blob source must be { stageId } or { bytes }') };
  }
  if (bytes.length > MAX_SOURCE_BYTES) {
    return { ok: false, error: stageLimitError('stage_bytes', bytes.length, MAX_SOURCE_BYTES) };
  }
  const actual = sha256Hex(bytes);
  // A caller-supplied digest/byteLength is never authoritative (§13.2 rule 1).
  if (actual !== digest || bytes.length !== byteLength) {
    return { ok: false, error: blobCorrupt(digest, `sources/sha256/${digest}`, actual) };
  }
  const dirRes = sourcesDir(ctx.dir);
  if (!dirRes.ok) return { ok: false, error: dirRes.error };
  const dir = dirRes.dir;
  const target = join(dir, digest);
  let existing = false;
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ok: false, error: pathRejected(target, 'the blob path is not a real file') };
    }
    existing = true;
  } catch {
    existing = false;
  }
  if (existing) {
    const r = readBlobBytes(target);
    if (!r.ok) {
      if (r.code === 'symlink') return { ok: false, error: pathRejected(target, 'the blob path is a symlink') };
      if (r.code === 'ENOENT') return { ok: false, error: contentPublishFailed('write') };
      return { ok: false, error: blobCorrupt(digest, target) };
    }
    const h = sha256Hex(r.bytes);
    if (h === digest) return { ok: true, digest, byteLength: bytes.length, published: false, alreadyPresent: true };
    return { ok: false, error: blobCorrupt(digest, target, h) };
  }
  // Quota pre-flight: project quota and device free space (§13.3.2 step 3).
  const used = authoritativeBytes(ctx.dir);
  if (used + bytes.length > core.content.maxSourceBytesPerProject) {
    return {
      ok: false,
      error: contentQuotaExceeded('project_quota', used, core.content.maxSourceBytesPerProject, bytes.length),
    };
  }
  const free = core.content.freeSpaceBytes();
  if (free - bytes.length < core.content.deviceSpaceReserveBytes) {
    return {
      ok: false,
      error: contentQuotaExceeded('device_space', free, core.content.deviceSpaceReserveBytes, bytes.length),
    };
  }
  const wr = writeAtomic({
    dir,
    target,
    bytes,
    // The target must stay absent: an appearance races in as `external` and
    // is classified below (never silently overwritten — §13.2 rule 2).
    allowedPreHashes: null,
    previousHash: null,
    ops: core.ops,
  });
  if (wr.ok) return { ok: true, digest, byteLength: bytes.length, published: true, alreadyPresent: false };
  if (wr.external) {
    const h = sha256Hex(wr.external.bytes);
    if (h === digest) return { ok: true, digest, byteLength: bytes.length, published: false, alreadyPresent: true };
    return { ok: false, error: blobCorrupt(digest, target, h) };
  }
  if (wr.failed) {
    return { ok: false, error: contentPublishFailed('write', wr.failed.onDiskState, wr.failed.errno) };
  }
  // unreadable: the bytes are unknown — fail closed with the write reason.
  return { ok: false, error: contentPublishFailed('write') };
}

// ---- verified reads (workspace.md §13.5) ------------------------------------

export interface BlobReadRequest {
  assetId: string;
  version: number;
}

export interface BlobReadResultOk {
  ok: true;
  assetId: string;
  version: number;
  digest: string;
  byteLength: number;
  verified: true;
  bytes: Uint8Array;
}
export type BlobReadResult = BlobReadResultOk | { ok: false; error: CommandError };

/**
 * The catalog-version fact shape both `ContentCatalog` and `ContentCatalogV3`
 * satisfy (`project-model` §18.4/§23.3.7). Structural so the reader stays
 * kind-agnostic (`readBlob` is unchanged and kind-agnostic, workspace.md
 * §16.6 item 3).
 */
interface CatalogVersionLike {
  readonly version: number;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly sourcePath?: string;
  readonly importRecipe: ModelImportRecipe;
}
interface CatalogAssetLike {
  readonly assetId: string;
  readonly kind: string;
  readonly versions: readonly CatalogVersionLike[];
}

/**
 * `preparedMediaFacts(ctx, assetId, version)` — resolve the typed
 * {@link PreparedMediaFacts} of one catalog version from the last
 * acknowledged catalog. Pure read; the same resolution `readBlob` uses, so
 * a media consumer never re-derives the tuple from the raw catalog. Missing
 * asset/version are the accepted `asset_not_found`/`asset_version_not_found`.
 */
export function preparedMediaFacts(
  ctx: ContentContext,
  assetId: unknown,
  version: unknown,
): { ok: true; facts: PreparedMediaFacts } | { ok: false; error: CommandError } {
  const catalog = ctx.content as unknown as { assets?: readonly CatalogAssetLike[] } | null;
  if (catalog === null || catalog.assets === undefined) {
    return { ok: false, error: { code: 'asset_not_found', cls: 'validation', assetId: String(assetId), message: `asset '${String(assetId)}' does not exist in the catalog`, hint: 'query the catalog (queryAssets) for current IDs' } };
  }
  const record = catalog.assets.find((a) => a.assetId === assetId);
  if (record === undefined) {
    return { ok: false, error: { code: 'asset_not_found', cls: 'validation', assetId: String(assetId), message: `asset '${String(assetId)}' does not exist in the catalog`, hint: 'query the catalog (queryAssets) for current IDs' } };
  }
  if (!Number.isInteger(version)) {
    return { ok: false, error: { code: 'asset_version_not_found', cls: 'validation', assetId: record.assetId, assetVersion: Number(version), message: 'version must be an integer', hint: 'query the catalog for the current versions' } };
  }
  const v = record.versions.find((x) => x.version === version);
  if (v === undefined) {
    return { ok: false, error: { code: 'asset_version_not_found', cls: 'validation', assetId: record.assetId, assetVersion: version as number, message: `version ${String(version)} does not exist for asset '${record.assetId}'`, hint: 'query the catalog for the current versions' } };
  }
  return {
    ok: true,
    facts: {
      assetId: record.assetId,
      kind: record.kind === 'audio' ? 'audio' : 'model',
      version: v.version,
      sourceDigest: v.sourceDigest,
      sourceByteLength: v.sourceByteLength,
      ...(v.sourcePath !== undefined ? { sourcePath: v.sourcePath } : {}),
      importRecipe: v.importRecipe,
    },
  };
}

function findVersion(
  ctx: ContentContext,
  assetId: unknown,
  version: unknown,
): { ok: true; digest: string; byteLength: number; version: number; sourcePath?: string } | { ok: false; error: CommandError } {
  const found = preparedMediaFacts(ctx, assetId, version);
  if (!found.ok) return found;
  return {
    ok: true,
    digest: found.facts.sourceDigest,
    byteLength: found.facts.sourceByteLength,
    version: found.facts.version,
    ...(found.facts.sourcePath !== undefined ? { sourcePath: found.facts.sourcePath } : {}),
  };
}

/**
 * `readBlob(projectId, { assetId, version })` — the only public byte read.
 * Resolves the version's `sourceDigest` from the last acknowledged catalog,
 * checks the artifact-path rules, opens with `O_NOFOLLOW`, verifies the
 * digest before returning, and returns bytes plus `{ digest, byteLength }`.
 */
export function readBlob(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  request: BlobReadRequest,
): BlobReadResult {
  const found = findVersion(ctx, request?.assetId, request?.version);
  if (!found.ok) return found;
  if (found.sourcePath !== undefined) {
    const ref = readReferencedSource(ctx, found.sourcePath, found.digest, found.byteLength, request.assetId, found.version);
    if (!ref.ok) return ref;
    return {
      ok: true,
      assetId: request.assetId,
      version: found.version,
      digest: found.digest,
      byteLength: ref.bytes.length,
      verified: true,
      bytes: ref.bytes,
    };
  }
  const dirRes = verifyArtifactDir(ctx.dir, ['sources', 'sha256'], false);
  if (!dirRes.ok) {
    // A missing sources dir means the blob is missing; a symlink/escape is
    // path_rejected. Distinguish by re-checking the project-relative shape.
    try {
      lstatSync(join(ctx.dir, 'sources'));
      return { ok: false, error: dirRes.error };
    } catch {
      return { ok: false, error: blobMissing(found.digest, `sources/sha256/${found.digest}`, request.assetId, found.version) };
    }
  }
  const path = join(dirRes.dir, found.digest);
  const r = readBlobBytes(path);
  if (!r.ok) {
    if (r.code === 'symlink') return { ok: false, error: pathRejected(path, 'the blob path is a symlink (never followed)') };
    if (r.code === 'ENOENT') return { ok: false, error: blobMissing(found.digest, `sources/sha256/${found.digest}`, request.assetId, found.version) };
    return { ok: false, error: blobCorrupt(found.digest, path, undefined, request.assetId, found.version) };
  }
  const h = sha256Hex(r.bytes);
  if (h !== found.digest || r.bytes.length !== found.byteLength) {
    return { ok: false, error: blobCorrupt(found.digest, path, h, request.assetId, found.version) };
  }
  return {
    ok: true,
    assetId: request.assetId,
    version: found.version,
    digest: found.digest,
    byteLength: r.bytes.length,
    verified: true,
    bytes: r.bytes,
  };
}

export interface SourceBlobReadRequest {
  /** The immutable blob name = its SHA-256 (64 lowercase hex). */
  digest: string;
}

export type SourceBlobReadResult =
  | { ok: true; digest: string; byteLength: number; bytes: Uint8Array; verified: true }
  | { ok: false; error: CommandError };

/**
 * `readSourceBlob` — a digest-addressed verified read of one immutable
 * `sources/sha256/<digest>` blob (packet 35; the behavior-container delivery
 * read). Same path rules, `O_NOFOLLOW` open and digest-verification discipline
 * as `readBlob` (workspace.md §13.5); a non-64-hex value is `path_rejected`
 * before any storage call. The blob bytes are never substituted or degraded:
 * mismatch ⇒ `blob_corrupt`, missing ⇒ `blob_missing`.
 *
 * Contract-change request C35-1 (docs/handoffs/35.md): the accepted §3 public
 * surface names only `readBlob(assetId, version)`; play/export delivery needs
 * the digest-addressed read for behavior source containers, which are not
 * catalog assets.
 */
export function readSourceBlob(
  core: { ops: WriteOps },
  ctx: ContentContext,
  request: SourceBlobReadRequest,
): SourceBlobReadResult {
  void core;
  const digest = request?.digest;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, error: pathRejected(String(digest), 'a source-blob digest must be 64 lowercase hex') };
  }
  const dirRes = verifyArtifactDir(ctx.dir, ['sources', 'sha256'], false);
  if (!dirRes.ok) {
    try {
      lstatSync(join(ctx.dir, 'sources'));
      return { ok: false, error: dirRes.error };
    } catch {
      return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`) };
    }
  }
  const path = join(dirRes.dir, digest);
  const r = readBlobBytes(path);
  if (!r.ok) {
    if (r.code === 'symlink') return { ok: false, error: pathRejected(path, 'the blob path is a symlink (never followed)') };
    if (r.code === 'ENOENT') return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`) };
    return { ok: false, error: blobCorrupt(digest, path) };
  }
  const h = sha256Hex(r.bytes);
  if (h !== digest) return { ok: false, error: blobCorrupt(digest, path, h) };
  return { ok: true, digest, byteLength: r.bytes.length, bytes: r.bytes, verified: true };
}

// ---- files referenced in place in the game folder (phase 10, option B) -------

/**
 * Resolve a project-relative `sourcePath` to a real file inside the game
 * folder, with the same containment rule as `resolveContained`: the realpath
 * must stay inside the realpath of the game folder (a symlink pointing out is
 * refused). The project's own files (`<folder>/<projectDir>/`) and `.git/`
 * are not asset sources. Errors carry only the relative path.
 */
export function resolveProjectFile(
  ctx: ContentContext,
  sourcePath: unknown,
  want: 'file' | 'dir' = 'file',
): { ok: true; real: string; size: number } | { ok: false; error: CommandError; missing?: true } {
  const shown = typeof sourcePath === 'string' ? sourcePath.slice(0, 512) : String(sourcePath);
  const folder = ctx.gameFolder ?? null;
  if (folder === null) {
    return { ok: false, error: pathRejected(shown, 'this project is not in a game folder; only folder projects reference files in place') };
  }
  const root = want === 'dir' && sourcePath === '';
  if (!root && !isValidSourcePath(sourcePath)) {
    return { ok: false, error: pathRejected(shown, 'the path must be relative to the game folder, with forward slashes and no "..", "." or empty parts') };
  }
  const segs = root ? [] : (sourcePath as string).split('/');
  if (segs.includes('.git')) return { ok: false, error: pathRejected(shown, '.git/ is not an asset folder') };
  if (segs.length > 0 && join(folder, segs[0]!) === ctx.dir) {
    return { ok: false, error: pathRejected(shown, `${segs[0]!}/ holds the project's own files, not asset sources`) };
  }
  let realRoot: string;
  let realProject: string;
  try {
    realRoot = realpathSync(folder);
    realProject = realpathSync(ctx.dir);
  } catch {
    return { ok: false, error: pathRejected(shown, 'the game folder is unavailable') };
  }
  let real: string;
  try {
    real = realpathSync(join(folder, ...segs));
  } catch {
    return { ok: false, error: pathRejected(shown, `${shown} does not exist in the game folder`), missing: true };
  }
  const within = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (!within(realRoot, real)) {
    return { ok: false, error: pathRejected(shown, `${shown} resolves outside the game folder (symlinks may not leave it)`) };
  }
  if (!root && within(realProject, real)) {
    return { ok: false, error: pathRejected(shown, `${shown} resolves into the project's own files`) };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, error: pathRejected(shown, `${shown} does not exist in the game folder`), missing: true };
  }
  if (want === 'file' ? !st.isFile() : !st.isDirectory()) {
    return { ok: false, error: pathRejected(shown, `${shown} is not a ${want === 'file' ? 'regular file' : 'folder'}`) };
  }
  return { ok: true, real, size: st.size };
}

/** Read one contained game-folder file (size-bounded, the final component never followed). */
function readProjectFileBytes(
  ctx: ContentContext,
  sourcePath: string,
): { ok: true; bytes: Uint8Array; real: string } | { ok: false; error: CommandError; missing?: true } {
  const res = resolveProjectFile(ctx, sourcePath);
  if (!res.ok) return res;
  if (res.size > MAX_SOURCE_BYTES) return { ok: false, error: stageLimitError('stage_bytes', res.size, MAX_SOURCE_BYTES) };
  const r = readBlobBytes(res.real);
  if (!r.ok) {
    if (r.code === 'ENOENT') return { ok: false, error: pathRejected(sourcePath, `${sourcePath} does not exist in the game folder`), missing: true };
    return { ok: false, error: pathRejected(sourcePath, `${sourcePath} could not be read`) };
  }
  return { ok: true, bytes: r.bytes, real: res.real };
}

/**
 * The verified read of a version referenced in place: the file must exist
 * inside the game folder and hash to the recorded digest. Missing ⇒
 * `asset_source_missing`, other bytes ⇒ `asset_source_changed`; other bytes are
 * never returned.
 */
function readReferencedSource(
  ctx: ContentContext,
  sourcePath: string,
  digest: string,
  byteLength: number,
  assetId?: string,
  version?: number,
): { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError } {
  const r = readProjectFileBytes(ctx, sourcePath);
  if (!r.ok) return { ok: false, error: r.missing === true ? assetSourceMissing(digest, sourcePath, assetId, version) : r.error };
  const h = sha256Hex(r.bytes);
  rememberDigest(r.real, h);
  if (h !== digest || r.bytes.length !== byteLength) {
    return { ok: false, error: assetSourceChanged(digest, sourcePath, h, assetId, version) };
  }
  return { ok: true, bytes: r.bytes };
}

/**
 * Digests of game-folder files keyed by (realpath, size, mtime, ctime, inode):
 * the integrity report runs on open, on focus and on demand, and must not
 * re-hash an unchanged 30 MB model every time. Reads that serve bytes always
 * hash what they read; only the status report uses this cache.
 */
const digestCache = new Map<string, { stamp: string; digest: string }>();
const DIGEST_CACHE_MAX = 1024;

function fileStamp(real: string): string | null {
  try {
    const st = statSync(real);
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  } catch {
    return null;
  }
}

function rememberDigest(real: string, digest: string): void {
  const stamp = fileStamp(real);
  if (stamp === null) return;
  digestCache.delete(real);
  digestCache.set(real, { stamp, digest });
  while (digestCache.size > DIGEST_CACHE_MAX) digestCache.delete(digestCache.keys().next().value as string);
}

function referencedStatus(ctx: ContentContext, sourcePath: string, digest: string, byteLength: number): ContentIntegrityEntry['status'] {
  const res = resolveProjectFile(ctx, sourcePath);
  if (!res.ok) return res.missing === true ? 'missing' : 'unreadable';
  if (res.size !== byteLength) return 'changed';
  const cached = digestCache.get(res.real);
  if (cached !== undefined && cached.stamp === fileStamp(res.real)) return cached.digest === digest ? 'ok' : 'changed';
  const r = readProjectFileBytes(ctx, sourcePath);
  if (!r.ok) return r.missing === true ? 'missing' : 'unreadable';
  const h = sha256Hex(r.bytes);
  rememberDigest(r.real, h);
  return h === digest ? 'ok' : 'changed';
}

/** One entry of a game-folder listing (importable files and subfolders only). */
export interface ProjectFileEntry {
  name: string;
  /** Relative to the game folder, forward slashes. */
  path: string;
  kind: 'dir' | 'model' | 'audio';
  byteLength?: number;
}

export const MAX_PROJECT_FILE_ENTRIES = 500;
const IMPORTABLE: Readonly<Record<string, 'model' | 'audio'>> = { '.glb': 'model', '.wav': 'audio' };

export type ProjectFileListResult =
  | { ok: true; dir: string; entries: ProjectFileEntry[]; truncated: boolean }
  | { ok: false; error: CommandError };

/**
 * `listProjectFiles(dir)`: one folder of the game folder, for the "import from
 * project folder" picker. Lists subfolders and `.glb`/`.wav` files; hidden
 * entries, `.git` and the project's own folder are left out, and a symlink
 * is listed only when it stays inside the game folder.
 */
export function listProjectFiles(ctx: ContentContext, dir: unknown): ProjectFileListResult {
  const rel = dir === undefined || dir === '' ? '' : dir;
  const res = resolveProjectFile(ctx, rel, 'dir');
  if (!res.ok) return { ok: false, error: res.error };
  const prefix = rel === '' ? '' : `${rel as string}/`;
  let names: string[];
  try {
    names = readdirSync(res.real).sort();
  } catch {
    return { ok: false, error: pathRejected(String(rel), `${String(rel) || 'the game folder'} could not be listed`) };
  }
  const entries: ProjectFileEntry[] = [];
  let truncated = false;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = `${prefix}${name}`;
    if (!isValidSourcePath(path)) continue;
    const dot = name.lastIndexOf('.');
    const kind = dot > 0 ? IMPORTABLE[name.slice(dot).toLowerCase()] : undefined;
    let st;
    try {
      st = statSync(join(res.real, name));
    } catch {
      continue;
    }
    if (!st.isDirectory() && (kind === undefined || !st.isFile())) continue;
    const inside = resolveProjectFile(ctx, path, st.isDirectory() ? 'dir' : 'file');
    if (!inside.ok) continue;
    if (entries.length >= MAX_PROJECT_FILE_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push(st.isDirectory() ? { name, path, kind: 'dir' } : { name, path, kind: kind!, byteLength: st.size });
  }
  entries.sort((a, b) => (a.kind === 'dir') === (b.kind === 'dir') ? (a.name < b.name ? -1 : 1) : a.kind === 'dir' ? -1 : 1);
  return { ok: true, dir: String(rel), entries, truncated };
}

export type InspectProjectFileResult =
  | { ok: true; sourcePath: string; proposal: ImportedProposal }
  | { ok: false; error: CommandError };

/**
 * `inspectProjectFile(path)`: the "import from project folder" preparation.
 * Reads the contained file, runs the same injected inspector as a staged
 * upload and returns the proposal plus the `sourcePath` the `publishAsset`
 * command records. Nothing is copied or written: the bytes stay in the game
 * folder, and the command re-verifies them at commit.
 */
export function inspectProjectFile(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  sourcePath: unknown,
  options: InspectStageOptions = {},
): InspectProjectFileResult {
  const inspector = core.content.assetInspector;
  if (inspector === undefined) {
    return { ok: false, error: derivedCacheUnavailable('', '.thirdlight/derived/') };
  }
  const read = readProjectFileBytes(ctx, sourcePath as string);
  if (!read.ok) return read;
  const path = sourcePath as string;
  if (read.bytes.length === 0) return { ok: false, error: pathRejected(path, `${path} is empty`) };
  rememberDigest(read.real, sha256Hex(read.bytes));
  const makeProposalId = options.proposalId ?? defaultProposalId;
  const expiresAt = new Date(core.content.now() + STAGE_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const job: ImportJobPort = {
    now: () => core.content.now(),
    isCancelled: options.isCancelled ?? (() => false),
    proposalId: () => makeProposalId(),
    stageId: () => 'project-file',
    expiresAt: () => expiresAt,
    timeoutMs: core.content.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS,
    suggestedDisplayName: options.displayName ?? basename(path).replace(/\.[^.]+$/, ''),
  };
  const proposal = inspector(read.bytes, job, {
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.animation !== undefined ? { animation: options.animation } : {}),
  });
  if (proposal.status === 'rejected') {
    return { ok: false, error: importRejected(proposal.sourceDigest, proposal.diagnostics, proposal.diagnosticCount) };
  }
  return { ok: true, sourcePath: path, proposal };
}

// ---- integrity (workspace.md §13.5) -----------------------------------------

export interface ContentIntegrityEntry {
  assetId: string;
  version: number;
  sourceDigest: string;
  /** True when this version is the record's `currentVersion` (the version the
   * scene closure resolves); a superseded version is `referenced: false`. */
  referenced: boolean;
  /** The file in the game folder, for a version referenced in place. */
  sourcePath?: string;
  /**
   * `changed`: a file referenced in place no longer has the recorded bytes
   * (the version cannot be read until the file is restored).
   */
  status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'changed';
}

export interface ContentIntegritySummary {
  total: number;
  ok: number;
  missing: number;
  corrupt: number;
  unreadable: number;
  changed: number;
  /** Authoritative files under sources/sha256/ named by no catalog version. */
  orphanBlobs: number;
}

export type ContentIntegrityResult =
  | { ok: true; entries: ContentIntegrityEntry[]; summary: ContentIntegritySummary }
  | { ok: false; error: CommandError };

/** `inspectStage(projectId, stageId)` (workspace.md §11/§13.3.1; project-model
 * §18.7/§18.8): reads the staged bytes through the workspace's own path rules,
 * runs the injected bounded inspector with a caller-owned job identity, and
 * returns the immutable non-authoritative proposal. A rejected proposal is
 * `import_rejected` (with the ordered diagnostics); no authoritative state is
 * read or written. */
export interface InspectStageResultOk {
  ok: true;
  proposal: ImportedProposal;
}
export type InspectStageResult = InspectStageResultOk | { ok: false; error: CommandError };

export interface InspectStageOptions {
  /** Caller cancellation (a disconnected client / expired job). */
  isCancelled?: () => boolean;
  /** Caller display name for `suggestedDisplayName`. */
  displayName?: string;
  /** Test seam: deterministic proposal identity. */
  proposalId?: () => string;
  /** Packet 48: the declared kind of the staged bytes (default `model`). */
  kind?: 'model' | 'audio';
  /** Packet 48: the requested animated GLB profile (presentation.md §41.3.3). */
  animation?: AnimationProfileRequest;
}

/** `p-` + 32 lowercase hex (project-model §18.8 `proposalId`). */
function defaultProposalId(): string {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return `p-${s}`;
}

/** `resolveStage` + the injected inspector (workspace.md §11 `inspectStage`). */
export function inspectStage(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  stageId: unknown,
  options: InspectStageOptions = {},
): InspectStageResult {
  const inspector = core.content.assetInspector;
  if (inspector === undefined) {
    return { ok: false, error: derivedCacheUnavailable('', '.thirdlight/derived/') };
  }
  const res = resolveStage(core, ctx, stageId);
  if (!res.ok) return { ok: false, error: res.error };
  const stage = res.stage;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(stage.dir).mtimeMs;
  } catch {
    return { ok: false, error: stageNotFound(stage.stageId) };
  }
  const expiresAt = new Date(mtimeMs + STAGE_TTL_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const makeProposalId = options.proposalId ?? defaultProposalId;
  const job: ImportJobPort = {
    now: () => core.content.now(),
    isCancelled: options.isCancelled ?? (() => false),
    proposalId: () => makeProposalId(),
    stageId: () => stage.stageId,
    expiresAt: () => expiresAt,
    timeoutMs: core.content.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS,
    ...(options.displayName !== undefined ? { suggestedDisplayName: options.displayName } : {}),
  };
  const proposal = inspector(stage.bytes, job, {
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.animation !== undefined ? { animation: options.animation } : {}),
  });
  if (proposal.status === 'rejected') {
    return {
      ok: false,
      error: importRejected(proposal.sourceDigest, proposal.diagnostics, proposal.diagnosticCount),
    };
  }
  return { ok: true, proposal };
}

/** `contentIntegrity(projectId)` — for every catalog record version. */
export function contentIntegrity(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
): ContentIntegrityResult {
  const entries: ContentIntegrityEntry[] = [];
  const known = new Set<string>();
  const catalog = ctx.content;
  if (catalog !== null) {
    for (const record of catalog.assets) {
      for (const v of record.versions as readonly CatalogVersionLike[]) {
        known.add(v.sourceDigest);
        entries.push({
          assetId: record.assetId,
          version: v.version,
          sourceDigest: v.sourceDigest,
          referenced: v.version === record.currentVersion,
          ...(v.sourcePath !== undefined ? { sourcePath: v.sourcePath } : {}),
          status:
            v.sourcePath !== undefined
              ? referencedStatus(ctx, v.sourcePath, v.sourceDigest, v.sourceByteLength)
              : blobStatus(ctx, v.sourceDigest, v.sourceByteLength),
        });
      }
    }
  }
  // Orphan blobs (retained, harmless, reported only — §13.7).
  let orphanBlobs = 0;
  const dir = join(ctx.dir, 'sources', 'sha256');
  try {
    if (lstatSync(dir).isDirectory()) {
      for (const name of readdirSync(dir)) {
        if (DIGEST_RE.test(name) && !known.has(name)) orphanBlobs += 1;
      }
    }
  } catch {
    // absent → 0 orphans
  }
  const summary: ContentIntegritySummary = {
    total: entries.length,
    ok: entries.filter((e) => e.status === 'ok').length,
    missing: entries.filter((e) => e.status === 'missing').length,
    corrupt: entries.filter((e) => e.status === 'corrupt').length,
    unreadable: entries.filter((e) => e.status === 'unreadable').length,
    changed: entries.filter((e) => e.status === 'changed').length,
    orphanBlobs,
  };
  return { ok: true, entries, summary };
}

function blobStatus(ctx: ContentContext, digest: string, byteLength: number): ContentIntegrityEntry['status'] {
  const path = join(ctx.dir, 'sources', 'sha256', digest);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink() || !st.isFile()) return 'corrupt';
  const r = readBlobBytes(path);
  if (!r.ok) return r.code === 'ENOENT' ? 'missing' : 'unreadable';
  const h = sha256Hex(r.bytes);
  if (h !== digest || r.bytes.length !== byteLength) return 'corrupt';
  return 'ok';
}

// ---- commit-time verification (workspace.md §13.3.2 step 4) -----------------

/**
 * Verify that the referenced authoritative blob exists and matches its
 * digest (fail closed with `blob_missing` / `blob_corrupt`; the command then
 * makes no state change). Used by the workspace's v2 command pipeline before
 * the envelope write.
 */
export function verifyReferencedBlob(
  ctx: ContentContext,
  digest: string,
  byteLength: number,
  sourcePath?: string,
): { ok: true } | { ok: false; error: CommandError } {
  if (sourcePath !== undefined) {
    const ref = readReferencedSource(ctx, sourcePath, digest, byteLength);
    return ref.ok ? { ok: true } : ref;
  }
  const dirRes = verifyArtifactDir(ctx.dir, ['sources', 'sha256'], false);
  if (!dirRes.ok) {
    try {
      lstatSync(join(ctx.dir, 'sources'));
      return { ok: false, error: dirRes.error };
    } catch {
      return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`) };
    }
  }
  const path = join(dirRes.dir, digest);
  const r = readBlobBytes(path);
  if (!r.ok) {
    if (r.code === 'symlink') return { ok: false, error: pathRejected(path, 'the blob path is a symlink (never followed)') };
    if (r.code === 'ENOENT') return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`) };
    return { ok: false, error: blobCorrupt(digest, path) };
  }
  const h = sha256Hex(r.bytes);
  if (h !== digest || r.bytes.length !== byteLength) return { ok: false, error: blobCorrupt(digest, path, h) };
  return { ok: true };
}

// ---- captured content view (project-model §19) ------------------------------

export type CaptureViewResult = { ok: true; view: CapturedContent } | { ok: false; error: CommandError };

/**
 * `captureContentView(projectId)` — the pure captured immutable content view
 * (`captureContent`, project-model §19/§16.6 item 4). A `storageVersion` 1
 * project has no content block: the operation is unavailable for it
 * (`version_combination_unsupported`), which the contract's failure list
 * expresses as `project_unavailable`. A v3 project uses the same view
 * (`contentVersion` stays 1); the capture resolves `modelAnimation` bindings
 * and `content.game` cues (CC-44-6 precedence: an explicit binding version
 * wins over the asset's `currentVersion`, first binding wins on a tie).
 */
export function captureContentView(ctx: ContentContext): CaptureViewResult {
  if (ctx.storageVersion === 1 || ctx.content === null || ctx.scene === null) {
    return {
      ok: false,
      error: {
        code: 'project_unavailable',
        cls: 'unavailable',
        reason: 'version_combination_unsupported',
        message: 'the captured content view requires the v2 envelope combination (storageVersion 2 with a content block)',
        hint: 'migrate the M1 project with migrateProjectCopy to obtain an M2 project',
      },
    };
  }
  const res = captureContent(ctx.scene, ctx.content, { projectId: ctx.projectId, revision: ctx.revision });
  if (!res.ok) {
    const e: Record<string, unknown> = {
      code: 'content_invalid',
      cls: 'unavailable',
      details: res.errors.slice(0, 10),
      detailCount: res.errors.length,
      message: 'the captured content view could not be derived',
      hint: 'the envelope would not have loaded with a dangling reference; repair the content block by hand',
    };
    return { ok: false, error: e as unknown as CommandError };
  }
  return { ok: true, view: res.normalized };
}

// ---- M3 captured envelope read (workspace.md §16, packet 58) -----------------

/**
 * The captured v3 envelope read (packet 58, delivery.md §2.6 "one capture, one
 * read"): the single acknowledged envelope state's v3 `scene` + `content`
 * halves, for the M3 shared closure builder. A pure read — no lock, no
 * mutation, served from the last acknowledged in-memory state (never a
 * partial state). The caller (the exporter's closure builder) derives the v2
 * manifest from these; the workspace does NOT duplicate the derivation
 * (delivery.md §1: the workspace owns the single acknowledged read, the
 * project-model owns the pure manifest v2 derivation).
 *
 * A `storageVersion` 1/2 project has no v3 envelope
 * (`version_combination_unsupported`). This is the "workspace captured-view
 * seam" the packet-58 may-edit names (delivery.md §1/§2.6); it is purely
 * additive (the v1 `captureContentView` view is unchanged).
 */
export interface CapturedV3Read {
  projectId: string;
  revision: number;
  /** The captured v3 scene document (the acknowledged state's scene half). */
  scene: unknown;
  /** The captured v3 content block (the acknowledged state's content half). */
  content: unknown;
}

export type CapturedV3ReadResult = { ok: true; read: CapturedV3Read } | { ok: false; error: CommandError };

export function readCapturedV3(ctx: ContentContext): CapturedV3ReadResult {
  if (ctx.storageVersion !== 3 || ctx.content === null || ctx.scene === null) {
    return {
      ok: false,
      error: {
        code: 'project_unavailable',
        cls: 'unavailable',
        reason: 'version_combination_unsupported',
        message: 'the captured v3 read requires a storageVersion 3 envelope',
        hint: 'migrate the project with migrateProjectCopyV3 to obtain a v3 project',
      },
    };
  }
  return {
    ok: true,
    read: {
      projectId: ctx.projectId,
      revision: ctx.revision,
      scene: ctx.scene,
      content: ctx.content,
    },
  };
}

// ---- derived caches (workspace.md §13.6) ------------------------------------

/** `.thirdlight/derived/<sourceDigest>/<recipeDigest>/` (path only). */
export function derivedCachePath(thirdlightDir: string, sourceDigest: string, recipeDigest: string): string {
  return join(thirdlightDir, 'derived', sourceDigest, recipeDigest);
}

export type DerivedReadResult = { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError };

/**
 * Read `import.json` from a derived cache. A missing/corrupt cache is
 * `derived_cache_unavailable` — a non-fatal warning: the project, scene and
 * catalog are unaffected and derived content is never read to determine
 * project state.
 */
export function readDerivedImport(
  thirdlightDir: string,
  sourceDigest: string,
  recipeDigest: string,
): DerivedReadResult {
  const path = join(derivedCachePath(thirdlightDir, sourceDigest, recipeDigest), 'import.json');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    return { ok: false, error: derivedCacheUnavailable(sourceDigest, path) };
  }
  try {
    JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: derivedCacheUnavailable(sourceDigest, path) };
  }
  return { ok: true, bytes };
}

/**
 * Write `import.json` into a derived cache (a content worker's regenerable
 * output). Non-authoritative: no lock, no envelope write, no revision change.
 */
export function writeDerivedImport(
  core: { ops: WriteOps },
  ctx: ContentContext,
  sourceDigest: string,
  recipeDigest: string,
  importJson: Uint8Array,
): { ok: true; path: string } | { ok: false; error: CommandError } {
  const dirRes = verifyArtifactDir(ctx.dir, ['.thirdlight', 'derived', sourceDigest, recipeDigest], true);
  if (!dirRes.ok) return { ok: false, error: dirRes.error };
  const target = join(dirRes.dir, 'import.json');
  const wr = writeAtomic({ dir: dirRes.dir, target, bytes: importJson, allowedPreHashes: [], previousHash: null, ops: core.ops });
  if (!wr.ok) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  return { ok: true, path: target };
}

/** Re-export the model's content validator so callers can build an empty
 * catalog without reaching into another package (used by migration). */export function emptyContent(): ContentCatalog {
  const res = validateContent({ assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] } });
  if (!res.ok) throw new Error('the canonical empty content block failed model validation');
  return res.normalized;
}

// ---- prepared behavior sources (packet 33; derived cache) ---------------------

const PREPARED_DIGEST_RE = /^[0-9a-f]{64}$/;
const PREPARED_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A bounded in-memory prepared-index scan (derived caches are non-authoritative). */
export const MAX_PREPARED_SCAN = 256;

/** `prepared.json` bytes (canonical 2-space JSON + newline). */
export function preparedRecordBytes(prepared: PreparedBehaviorSource): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(prepared, null, 2)}\n`);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Shape-validate one persisted prepared record. Derived data: an invalid or
 * corrupt entry is skipped, never repaired and never authoritative
 * (workspace.md §13.6).
 */
export function parsePreparedRecord(value: unknown): PreparedBehaviorSource | null {
  if (!isPlainRecord(value)) return null;
  const isDigest = (v: unknown): v is string => typeof v === 'string' && PREPARED_DIGEST_RE.test(v);
  const isInt = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (typeof value['behaviorId'] !== 'string' || !PREPARED_ID_RE.test(value['behaviorId'])) return null;
  if (!isDigest(value['sourceDigest'])) return null;
  if (!isInt(value['sourceByteLength'], 1, 262_144)) return null;
  if (value['entryPath'] !== 'src/index.ts') return null;
  if (!isInt(value['fileCount'], 1, 16)) return null;
  if (!isDigest(value['manifestDigest']) || !isDigest(value['outputDigest'])) return null;
  if (!isInt(value['outputByteLength'], 1, 131_072)) return null;
  if (!Array.isArray(value['requiredModules']) || value['requiredModules'].some((m) => typeof m !== 'string')) return null;
  if (!Array.isArray(value['ownedTransforms']) || value['ownedTransforms'].some((m) => typeof m !== 'string')) return null;
  const decl = value['declaration'];
  if (!isPlainRecord(decl) || !Array.isArray(decl['properties'])) return null;
  if (!isDigest(value['declarationDigest']) || !isDigest(value['recipeDigest'])) return null;
  const compiler = value['compiler'];
  if (!isPlainRecord(compiler) || typeof compiler['id'] !== 'string' || typeof compiler['esbuild'] !== 'string') return null;
  return value as unknown as PreparedBehaviorSource;
}

/** Read one prepared record for `sourceDigest` (first valid derived entry). */
export function readPreparedSource(thirdlightDir: string, sourceDigest: string): PreparedBehaviorSource | null {
  if (!PREPARED_DIGEST_RE.test(sourceDigest)) return null;
  const base = join(thirdlightDir, 'derived', sourceDigest);
  let recipes: string[];
  try {
    if (!lstatSync(base).isDirectory()) return null;
    recipes = readdirSync(base);
  } catch {
    return null;
  }
  for (const recipe of recipes) {
    try {
      const bytes = new Uint8Array(readFileSync(join(base, recipe, 'prepared.json')));
      const parsed = parsePreparedRecord(JSON.parse(new TextDecoder().decode(bytes)));
      if (parsed !== null && parsed.sourceDigest === sourceDigest) return parsed;
    } catch {
      // skip missing/corrupt cache entries
    }
  }
  return null;
}

/** The bounded prepared-source index for a project (derived caches). */
export function loadPreparedSources(thirdlightDir: string): Map<string, PreparedBehaviorSource> {
  const out = new Map<string, PreparedBehaviorSource>();
  const base = join(thirdlightDir, 'derived');
  let digests: string[];
  try {
    if (!lstatSync(base).isDirectory()) return out;
    digests = readdirSync(base);
  } catch {
    return out;
  }
  for (const digest of digests) {
    if (out.size >= MAX_PREPARED_SCAN) break;
    if (!PREPARED_DIGEST_RE.test(digest)) continue;
    const rec = readPreparedSource(thirdlightDir, digest);
    if (rec !== null) out.set(digest, rec);
  }
  return out;
}

/**
 * Write the prepared record into the derived cache (non-authoritative: no
 * lock, no envelope write, no revision change; workspace.md §13.6).
 */
export function writeDerivedPrepared(
  core: { ops: WriteOps },
  ctx: ContentContext,
  sourceDigest: string,
  recipeDigest: string,
  prepared: PreparedBehaviorSource,
): { ok: true; path: string } | { ok: false; error: CommandError } {
  const dirRes = verifyArtifactDir(ctx.dir, ['.thirdlight', 'derived', sourceDigest, recipeDigest], true);
  if (!dirRes.ok) return { ok: false, error: dirRes.error };
  const target = join(dirRes.dir, 'prepared.json');
  const wr = writeAtomic({
    dir: dirRes.dir,
    target,
    bytes: preparedRecordBytes(prepared),
    allowedPreHashes: null,
    previousHash: null,
    ops: core.ops,
  });
  if (!wr.ok && !wr.external) {
    return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  }
  return { ok: true, path: target };
}
