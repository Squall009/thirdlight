/**
 * Content storage: layout, immutable blob publication, staging
 * (`content-stage.ts`), reads/integrity, derived caches
 * (`content-derived.ts`), the disk-space check and `captureContent`.
 *
 * Ownership: this module owns every project-relative
 * content path, immutable blob publication, staging, the disk-space check, the
 * integrity report, derived-cache paths and the captured content view. It
 * never accepts a caller-supplied path or digest as authoritative, and it
 * never holds the project mutation lock (the synchronous service call is the
 * lock scope for the command pipeline only; preparation and blob publication
 * run outside it).
 *
 * Derived caches are regenerable and never authoritative: a write to
 * `.thirdlight/derived/**` changes no revision, no envelope and no catalog.
 */
import { DIGEST_RE, importKindOf, isDigest, withScenePlane } from '@thirdlight/project-model';

import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  type SceneV4,
  type ContentCatalogV4,
  isValidSourcePath,
  MAX_OPEN_STAGES,
  MAX_SOURCE_BYTES,
  MAX_STAGED_BYTES_PER_PROJECT,
  MAX_CONVERTED_SOURCE_BYTES,
} from '@thirdlight/project-model';
import type { ImportRecipe as ModelImportRecipe } from '@thirdlight/project-model';
import type {
  AnimationProfileRequest,
  AudioImportProposal,
  ImageImportProposal,
  FontImportProposal,
  ImportJobPort,
  ImportProposal,
} from '@thirdlight/asset-pipeline';
import type { BehaviorCompiler } from '@thirdlight/behavior-build';

import { sha256HexNative } from './digest';
import {
  assetSourceChanged,
  assetSourceMissing,
  blobCorrupt,
  blobMissing,
  contentPublishFailed,
  contentQuotaExceeded,
  derivedCacheUnavailable,
  importedMissing,
  importRejected,
  pathRejected,
  stageNotFound,
} from './errors';
import type { CommandError } from '@thirdlight/commands';
import { writeAtomic, type WriteOps } from './write';
import { FileStamps } from './file-stamps';
import { assetRecordOf } from './catalog-lookup';
import { assetRoot, hasImported, importKeyOfConverted, isProjectOwnTop, PROJECT_OWN_ENTRIES, readImported, type ConvertedLike } from './asset-files';
import { resolveStage, stageLimitError } from './content-stage';
export { cleanupStages, discardStage, markStagePublished, resolveStage, stageContent } from './content-stage';
export type {
  ResolveStageResult, ResolvedStage, StageDiscardResult, StageRequest, StageResult, StageResultOk,
} from './content-stage';
export {
  MAX_PREPARED_SCAN, derivedCachePath, loadPreparedSources, parsePreparedRecord, preparedRecordBytes,
  readDerivedImport, readPreparedSource, writeDerivedImport, writeDerivedPrepared,
} from './content-derived';
export type { DerivedReadResult } from './content-derived';

// ---- bounds --------------------------------------------

/** The staged source / authoritative source blob bound, open stages and staged bytes per project (the model's). */
export { MAX_OPEN_STAGES, MAX_SOURCE_BYTES, MAX_STAGED_BYTES_PER_PROJECT };
/** Stage TTL: 3 600 s. */
export const STAGE_TTL_SECONDS = 3_600;
/** Device free space required before a blob write: blobBytes + 64 MiB. */
export const DEFAULT_DEVICE_SPACE_RESERVE_BYTES = 67_108_864;
/** Abandoned-stage retention: 24 h by directory mtime (non-authoritative). */
export const ABANDONED_STAGE_RETENTION_SECONDS = 86_400;
/** The bounded inspection job budget. */
export const INSPECT_TIMEOUT_MS = 30_000;

/** The content-storage configuration (a subspace of the service core). */
export interface ContentConfig {
  deviceSpaceReserveBytes: number;
  /** The free bytes of the disk a path is on (the data root's when no path is given). */
  freeSpaceBytes: (path?: string) => number;
  now: () => number;
  /**
   * The injected GLB inspector (`backend` constructs
   * the `asset-pipeline` inspector and injects it; `workspace` holds only
   * its type). Absent ⇒ `inspectStage` is structurally unavailable
   * (`derived_cache_unavailable`) rather than faked.
   */
  assetInspector?: StageInspector;
  /** The bounded inspection budget (default `INSPECT_TIMEOUT_MS`). */
  inspectTimeoutMs?: number;
  /**
   * The injected behavior-source compiler (`backend` constructs the
   * `behavior-build` compiler and injects it). The
   * workspace holds only its type and calls `compile` from the preparation
   * layer — no hidden global service, no source evaluation by the workspace.
   */
  behaviorCompiler?: BehaviorCompiler;
  /** The injected mesh simplifier (see `WorkspaceConfig.meshSimplifier`). */
  meshSimplifier?: { current: import('@thirdlight/asset-pipeline').MeshSimplifier | null };
  /** The folder watch of open projects (false: off; see `WorkspaceConfig.fileWatch`). */
  fileWatch?: false | { maxEventsPerTurn?: number };
}

/**
 * One typed inspection request: the staged bytes' declared `kind`
 * and, for a role-aware GLB publication, the requested animation roles. The
 * workspace only forwards this to the injected inspector — it never inspects
 * bytes itself and makes no role or profile decision.
 */
export interface InspectorRequest {
  readonly kind?: 'model' | 'audio' | 'texture' | 'font';
  /** Request the animated-model profile. */
  readonly animation?: AnimationProfileRequest;
}

/** An accepted import proposal (a model GLB, an audio file, a texture image or a font). */
export type ImportedProposal = ImportProposal | AudioImportProposal | ImageImportProposal | FontImportProposal;

/**
 * The injected inspector surface (asset-pipeline's `inspectGlb`/`inspectAudio`
 * bound with the pinned profile/recipe/toolchain by the backend). The workspace
 * supplies the job port so the importer never reads a clock or a PRNG itself
 * (import must be deterministic), and forwards the caller's typed `request`
 * (an optional third parameter, so two-parameter inspectors stay valid).
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
  /** Always 4 (storage v4). */
  storageVersion: 4;
  revision: number;
  /** The first start scene (null only for a project still being created). */
  scene: SceneV4 | null;
  content: ContentCatalogV4 | null;
  /** Every scene of the project (the capture covers them all). */
  scenes?: readonly SceneV4[];
  /**
   * The game folder of a folder project (the folder holding `thirdlight.json`);
   * `null` for a project in the data root. Asset versions with a `sourcePath`
   * are files inside it.
   */
  gameFolder?: string | null;
  /** What the project's files hashed to, by their stamps (the session's; absent: remembered for this call only). */
  stamps?: FileStamps;
  /** The asset files a folder watch saw unchanged since they were last checked (absent: every file is checked). */
  watched?: import('./watched-assets').WatchedAssets;
}

/**
 * The workspace-side typed **prepared-media facts** of one catalog asset
 * version: the
 * resolved `(version, sourceDigest, sourceByteLength, importRecipe)` tuple
 * the captured view pins, plus the `kind` discriminator so a caller never
 * has to guess whether a version is a model or an audio byte string. Every
 * field is derived from the last acknowledged catalog — this is a typed read
 * of authoritative state, not a new persisted shape (no contract field is
 * invented). Used by the workspace's own content readers and available to
 * the inspector wiring.
 */
export interface PreparedMediaFacts {
  readonly assetId: string;
  readonly kind: 'model' | 'audio' | 'texture' | 'font';
  readonly version: number;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  /** Set when the bytes are a file in the game folder (relative to it). */
  readonly sourcePath?: string;
  readonly importRecipe: ModelImportRecipe;
}

// ---- artifact path rules ----------------------------------------------------

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
 * Remove leftover blob-publication temps (`sources/sha256/.<digest>.tmp-*`).
 * Only the owner writes them (the previous
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

// ---- immutable blob publication ------------------------

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

export function readBlobBytes(path: string): { ok: true; bytes: Uint8Array } | { ok: false; code: 'ENOENT' | 'other' | 'symlink' } {
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

/**
 * Default device-free-space probe: `statfs` of the path, or of its nearest
 * existing folder when the path is not made yet (a new upload folder).
 */
function defaultFreeSpace(p: string): number {
  for (let at = p; ; ) {
    try {
      const st = statfsSync(at);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      const up = dirname(at);
      if (up === at) return Number.MAX_SAFE_INTEGER;
      at = up;
    }
  }
}

export { defaultFreeSpace };

/**
 * `publishBlob(projectId, { digest, byteLength, source })`:
 * exactly the `writeAtomic` procedure with `target = sources/sha256/<digest>`.
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
  if (!isDigest(digest)) {
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
  const actual = sha256HexNative(bytes);
  // A caller-supplied digest/byteLength is never authoritative.
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
    const h = sha256HexNative(r.bytes);
    if (h === digest) return { ok: true, digest, byteLength: bytes.length, published: false, alreadyPresent: true };
    return { ok: false, error: blobCorrupt(digest, target, h) };
  }
  // Only the disk bounds a project's files: refuse when it is short.
  const free = core.content.freeSpaceBytes(dir);
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
    // is classified below (never silently overwritten).
    allowedPreHashes: null,
    previousHash: null,
    ops: core.ops,
  });
  if (wr.ok) return { ok: true, digest, byteLength: bytes.length, published: true, alreadyPresent: false };
  if (wr.external) {
    const h = sha256HexNative(wr.external.bytes);
    if (h === digest) return { ok: true, digest, byteLength: bytes.length, published: false, alreadyPresent: true };
    return { ok: false, error: blobCorrupt(digest, target, h) };
  }
  if (wr.failed) {
    return { ok: false, error: contentPublishFailed('write', wr.failed.onDiskState, wr.failed.errno) };
  }
  // unreadable: the bytes are unknown — fail closed with the write reason.
  return { ok: false, error: contentPublishFailed('write') };
}

// ---- verified reads ------------------------------------

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
 * satisfy. Structural so the reader (`readBlob`) stays kind-agnostic.
 */
interface CatalogVersionLike {
  readonly version: number;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly sourcePath?: string;
  readonly convertedFrom?: ConvertedLike;
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
  const record = assetRecordOf(catalog.assets, assetId);
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
      kind: record.kind === 'audio' ? 'audio' : record.kind === 'texture' ? 'texture' : record.kind === 'font' ? 'font' : 'model',
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
): { ok: true; digest: string; byteLength: number; version: number; sourcePath?: string; convertedFrom?: ConvertedLike } | { ok: false; error: CommandError } {
  const found = preparedMediaFacts(ctx, assetId, version);
  if (!found.ok) return found;
  const record = assetRecordOf((ctx.content as unknown as { assets: readonly CatalogAssetLike[] }).assets, assetId);
  const convertedFrom = record?.versions.find((v) => v.version === found.facts.version)?.convertedFrom;
  return {
    ok: true,
    digest: found.facts.sourceDigest,
    byteLength: found.facts.sourceByteLength,
    version: found.facts.version,
    ...(found.facts.sourcePath !== undefined ? { sourcePath: found.facts.sourcePath } : {}),
    ...(convertedFrom !== undefined ? { convertedFrom } : {}),
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
  // A converted version's bytes are what the importer made from its file, in the import cache.
  if (found.convertedFrom !== undefined) {
    const bytes = readImported(ctx, importKeyOfConverted(found.convertedFrom), found.digest);
    if (bytes !== null) {
      return { ok: true, assetId: request.assetId, version: found.version, digest: found.digest, byteLength: bytes.length, verified: true, bytes };
    }
    // A project from before the import cache kept them in the blob store.
    const legacy = join(ctx.dir, 'sources', 'sha256', found.digest);
    const r = readBlobBytes(legacy);
    if (r.ok && sha256HexNative(r.bytes) === found.digest) {
      return { ok: true, assetId: request.assetId, version: found.version, digest: found.digest, byteLength: r.bytes.length, verified: true, bytes: r.bytes };
    }
    return { ok: false, error: importedMissing(found.digest, found.convertedFrom.sourcePath ?? found.convertedFrom.sourceDigest, request.assetId, found.version) };
  }
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
  const h = sha256HexNative(r.bytes);
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
 * `sources/sha256/<digest>` blob (the behavior-container delivery read). Same path rules, `O_NOFOLLOW` open and digest-verification discipline
 * as `readBlob`; a non-64-hex value is `path_rejected`
 * before any storage call. The blob bytes are never substituted or degraded:
 * mismatch ⇒ `blob_corrupt`, missing ⇒ `blob_missing`.
 *
 * `readBlob(assetId, version)` reads catalog assets only; play/export delivery
 * needs the digest-addressed read for behavior source containers, which are
 * not catalog assets.
 */
export function readSourceBlob(
  core: { ops: WriteOps },
  ctx: ContentContext,
  request: SourceBlobReadRequest,
): SourceBlobReadResult {
  void core;
  const digest = request?.digest;
  if (!isDigest(digest)) {
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
  const h = sha256HexNative(r.bytes);
  if (h !== digest) return { ok: false, error: blobCorrupt(digest, path, h) };
  return { ok: true, digest, byteLength: r.bytes.length, bytes: r.bytes, verified: true };
}

// ---- files referenced in place in the game folder (option B) -------

/**
 * Resolve a project-relative `sourcePath` to a real file inside the game
 * folder, with the same containment rule as `resolveContained`: the realpath
 * must stay inside the realpath of the game folder (a symlink pointing out is
 * refused). The project's own files (`<folder>/<projectDir>/`, or in a
 * data-root project, which is its own game folder, `project.json`,
 * `content.json`, `scenes/`, …) and `.git/` are not asset sources. Errors
 * carry only the relative path.
 */
export function resolveProjectFile(
  ctx: ContentContext,
  sourcePath: unknown,
  want: 'file' | 'dir' = 'file',
): { ok: true; real: string; size: number } | { ok: false; error: CommandError; missing?: true } {
  const shown = typeof sourcePath === 'string' ? sourcePath.slice(0, 512) : String(sourcePath);
  const folder = assetRoot(ctx);
  const dataRoot = ctx.gameFolder == null;
  const root = want === 'dir' && sourcePath === '';
  if (!root && !isValidSourcePath(sourcePath)) {
    return { ok: false, error: pathRejected(shown, 'the path must be relative to the game folder, with forward slashes and no "..", "." or empty parts') };
  }
  const segs = root ? [] : (sourcePath as string).split('/');
  if (segs.some((seg) => seg.toLowerCase() === '.git')) return { ok: false, error: pathRejected(shown, '.git/ is not an asset folder') };
  if (segs.length > 0 && isProjectOwnTop(ctx, segs[0]!)) {
    return { ok: false, error: pathRejected(shown, `${segs[0]!} holds the project's own files, not asset sources`) };
  }
  let realRoot: string;
  let realProject: string;
  try {
    ({ realRoot, realProject } = realRootsOf(ctx, folder));
  } catch {
    return { ok: false, error: pathRejected(shown, 'the game folder is unavailable') };
  }
  let real: string;
  try {
    real = realpathSync.native(join(folder, ...segs));
  } catch {
    return { ok: false, error: pathRejected(shown, `${shown} does not exist in the game folder`), missing: true };
  }
  const within = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (!within(realRoot, real)) {
    return { ok: false, error: pathRejected(shown, `${shown} resolves outside the game folder (symlinks may not leave it)`) };
  }
  if (!root && (dataRoot ? PROJECT_OWN_ENTRIES.has((real.slice(realRoot.length + 1).split(sep)[0] ?? '').toLowerCase()) : within(realProject.toLowerCase(), real.toLowerCase()))) {
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

/**
 * The real paths of the game folder and the project folder, resolved once per
 * context: a pass over thousands of files (the file check, a build) resolves
 * each file, not its roots, again.
 */
const realRoots = new WeakMap<ContentContext, { folder: string; realRoot: string; realProject: string }>();
function realRootsOf(ctx: ContentContext, folder: string): { realRoot: string; realProject: string } {
  const known = realRoots.get(ctx);
  if (known !== undefined && known.folder === folder) return known;
  const made = { folder, realRoot: realpathSync.native(folder), realProject: realpathSync.native(ctx.dir) };
  realRoots.set(ctx, made);
  return made;
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
  const h = sha256HexNative(r.bytes);
  rememberRead(ctx, r.real, r.bytes.length, h);
  if (h !== digest || r.bytes.length !== byteLength) {
    return { ok: false, error: assetSourceChanged(digest, sourcePath, h, assetId, version) };
  }
  return { ok: true, bytes: r.bytes };
}

/** The project's file stamps (a context without a session gets memory-only ones). */
function stampsOf(ctx: ContentContext): FileStamps {
  if (ctx.stamps !== undefined) return ctx.stamps;
  return (unsessionedStamps ??= new FileStamps(null));
}
let unsessionedStamps: FileStamps | undefined;

/** What a whole read of a file hashed to, kept under the file's stamp when the read saw all of it. */
function rememberRead(ctx: ContentContext, real: string, length: number, digest: string): void {
  const stamp = FileStamps.stat(real);
  if (stamp !== null && stamp.size === length) stampsOf(ctx).remember(real, stamp, digest);
}

/** The digest of a file's current bytes (remembered by its stamp), or null when it cannot be read. */
export function fileDigest(ctx: ContentContext, real: string): string | null {
  return stampsOf(ctx).digestOf(real)?.digest ?? null;
}

function referencedStatus(ctx: ContentContext, sourcePath: string, digest: string, byteLength: number): ContentIntegrityEntry['status'] {
  const res = resolveProjectFile(ctx, sourcePath);
  if (!res.ok) return res.missing === true ? 'missing' : 'unreadable';
  if (res.size !== byteLength) return 'changed';
  const found = stampsOf(ctx).digestOf(res.real);
  if (found === null) return 'unreadable';
  return found.digest === digest ? 'ok' : 'changed';
}

/** One entry of a game-folder listing (importable files and subfolders only). */
export interface ProjectFileEntry {
  name: string;
  /** Relative to the game folder, forward slashes. */
  path: string;
  kind: 'dir' | 'model' | 'audio' | 'texture' | 'font';
  byteLength?: number;
}

/** Entries one folder listing returns (a page of the game folder; the index pages the whole project). */
export const MAX_PROJECT_FILE_ENTRIES = 500;

export type ProjectFileListResult =
  | { ok: true; dir: string; entries: ProjectFileEntry[]; truncated: boolean }
  | { ok: false; error: CommandError };

/**
 * `listProjectFiles(dir)`: one folder of the game folder, for the "import from
 * project folder" picker. Lists subfolders and `.glb`/`.fbx`/`.wav` files; hidden
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
    const kind = importKindOf(name) ?? undefined;
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

export type ConversionSourceResult =
  | { ok: true; sourcePath: string; real: string; digest: string; byteLength: number }
  | { ok: false; error: CommandError };

/**
 * The input of an FBX conversion: a contained game-folder file (up to
 * MAX_CONVERTED_SOURCE_BYTES), its real path — which only the backend's
 * converter sees, never a client — and the digest of the bytes it has now.
 */
export function conversionSource(ctx: ContentContext, sourcePath: unknown): ConversionSourceResult {
  const res = resolveProjectFile(ctx, sourcePath);
  if (!res.ok) return { ok: false, error: res.error };
  const path = sourcePath as string;
  if (res.size > MAX_CONVERTED_SOURCE_BYTES) return { ok: false, error: stageLimitError('stage_bytes', res.size, MAX_CONVERTED_SOURCE_BYTES) };
  const r = readBlobBytes(res.real);
  if (!r.ok) return { ok: false, error: pathRejected(path, `${path} could not be read`) };
  const digest = sha256HexNative(r.bytes);
  rememberRead(ctx, res.real, r.bytes.length, digest);
  return { ok: true, sourcePath: path, real: res.real, digest, byteLength: r.bytes.length };
}

/** A converted version's original (FBX): the game-folder file, else its stored blob. */
export interface ConvertedOriginal {
  sourceDigest: string;
  sourceByteLength: number;
  sourcePath?: string;
}

/** Commit-time check of a converted version's original: present with the recorded bytes. */
export function verifyConvertedOriginal(ctx: ContentContext, original: ConvertedOriginal): { ok: true } | { ok: false; error: CommandError } {
  if (original.sourcePath === undefined) return verifyReferencedBlob(ctx, original.sourceDigest, original.sourceByteLength);
  const r = readProjectFileBytes(ctx, original.sourcePath);
  if (!r.ok) return { ok: false, error: r.missing === true ? assetSourceMissing(original.sourceDigest, original.sourcePath) : r.error };
  const h = sha256HexNative(r.bytes);
  if (h !== original.sourceDigest || r.bytes.length !== original.sourceByteLength) {
    return { ok: false, error: assetSourceChanged(original.sourceDigest, original.sourcePath, h) };
  }
  return { ok: true };
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
  rememberRead(ctx, read.real, read.bytes.length, sha256HexNative(read.bytes));
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

// ---- integrity -----------------------------------------

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
   * A converted version's original (FBX): where it is and whether it still
   * has the recorded bytes. The version itself stays readable (its GLB is
   * stored); a changed original only means a re-import would differ.
   */
  convertedFrom?: { format: string; sourcePath?: string; status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'changed' };
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
  | { ok: true; entries: ContentIntegrityEntry[]; summary: ContentIntegritySummary; page?: { offset: number; limit: number; total: number } }
  | { ok: false; error: CommandError };

/** A page of the integrity report (`problems`: only the entries that are not `ok`; `total` counts what the filter keeps). */
export interface IntegrityPage {
  limit?: number;
  offset?: number;
  problems?: boolean;
}

/** `inspectStage(projectId, stageId)`: reads the staged bytes through the workspace's own path rules,
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
  /** The declared kind of the staged bytes (default `model`). */
  kind?: 'model' | 'audio' | 'texture' | 'font';
  /** The requested animated GLB profile. */
  animation?: AnimationProfileRequest;
}

/** `p-` + 32 lowercase hex (the import `proposalId`). */
function defaultProposalId(): string {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return `p-${s}`;
}

/** `resolveStage` + the injected inspector (`inspectStage`). */
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
  page?: IntegrityPage,
): ContentIntegrityResult {
  const entries: ContentIntegrityEntry[] = [];
  const known = new Set<string>();
  const catalog = ctx.content;
  if (catalog !== null) {
    for (const record of catalog.assets) {
      for (const v of record.versions as readonly CatalogVersionLike[]) {
        known.add(v.sourceDigest);
        const conv = (v as { convertedFrom?: { format: string; sourceDigest: string; sourceByteLength: number; sourcePath?: string; converter: { name: string; version: string }; encoding?: string } }).convertedFrom;
        if (conv !== undefined && conv.sourcePath === undefined) known.add(conv.sourceDigest);
        entries.push({
          assetId: record.assetId,
          version: v.version,
          sourceDigest: v.sourceDigest,
          referenced: v.version === record.currentVersion,
          ...(v.sourcePath !== undefined ? { sourcePath: v.sourcePath } : {}),
          ...(conv !== undefined
            ? {
                convertedFrom: {
                  format: conv.format,
                  ...(conv.sourcePath !== undefined ? { sourcePath: conv.sourcePath } : {}),
                  status:
                    conv.sourcePath !== undefined
                      ? referencedStatus(ctx, conv.sourcePath, conv.sourceDigest, conv.sourceByteLength)
                      : blobStatus(ctx, conv.sourceDigest, conv.sourceByteLength),
                },
              }
            : {}),
          status:
            v.sourcePath !== undefined
              ? referencedStatus(ctx, v.sourcePath, v.sourceDigest, v.sourceByteLength)
              : conv !== undefined
                ? importedStatus(ctx, conv as ConvertedLike, v.sourceDigest, v.sourceByteLength)
                : blobStatus(ctx, v.sourceDigest, v.sourceByteLength),
        });
      }
    }
  }
  // Orphan blobs (retained, harmless, reported only).
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
  ctx.stamps?.save();
  if (page === undefined) return { ok: true, entries, summary };
  const kept = page.problems === true ? entries.filter((e) => e.status !== 'ok' || (e.convertedFrom !== undefined && e.convertedFrom.status !== 'ok')) : entries;
  const offset = page.offset ?? 0;
  const limit = page.limit ?? kept.length;
  return { ok: true, entries: kept.slice(offset, offset + limit), summary, page: { offset, limit, total: kept.length } };
}

/** A converted version's bytes: in the import cache (checked by size; reads verify), else in the blob store of a project from before it. */
function importedStatus(ctx: ContentContext, conv: ConvertedLike, digest: string, byteLength: number): ContentIntegrityEntry['status'] {
  if (hasImported(ctx, importKeyOfConverted(conv), digest, byteLength)) return 'ok';
  const legacy = blobStatus(ctx, digest, byteLength);
  return legacy === 'ok' ? 'ok' : 'missing';
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
  const found = stampsOf(ctx).digestOf(path);
  if (found === null) return 'unreadable';
  if (found.digest !== digest || found.stamp.size !== byteLength) return 'corrupt';
  return 'ok';
}

// ---- commit-time verification -----------------

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
  const h = sha256HexNative(r.bytes);
  if (h !== digest || r.bytes.length !== byteLength) return { ok: false, error: blobCorrupt(digest, path, h) };
  return { ok: true };
}

/**
 * Commit-time check of a converted version: what the importer made from its
 * file (the recorded digest) is in the import cache, or, in a project from
 * before the cache, in the blob store.
 */
export function verifyImported(ctx: ContentContext, conv: ConvertedLike, digest: string): { ok: true } | { ok: false; error: CommandError } {
  if (readImported(ctx, importKeyOfConverted(conv), digest) !== null) return { ok: true };
  const r = readBlobBytes(join(ctx.dir, 'sources', 'sha256', digest));
  if (r.ok && sha256HexNative(r.bytes) === digest) return { ok: true };
  return { ok: false, error: blobMissing(digest, `cache/imported/${conv.sourceDigest}/`) };
}

// ---- captured project read ---------------------

/**
 * The captured project read ("one capture, one read"): the single acknowledged state's scenes + content, for the shared
 * closure builder. A pure read — no lock, no mutation, served from the last
 * acknowledged in-memory state (never a partial state). The caller (the
 * exporter's closure builder) derives the runtime-content manifest from
 * these; the workspace does NOT duplicate the derivation.
 */
export interface CapturedV3Read {
  projectId: string;
  revision: number;
  /** The start scenes merged into one runtime scene (schemaVersion 4). */
  scene: unknown;
  /** The content block. */
  content: unknown;
  /** Every scene (index order). */
  scenes?: readonly unknown[];
  startScenes?: readonly string[];
  /** What assembling the linked prefab copies could not do as stored (absent: nothing). */
  prefabProblems?: readonly import('./prefab-view').ScenePrefabProblem[];
}

export type CapturedV3ReadResult = { ok: true; read: CapturedV3Read } | { ok: false; error: CommandError };

export function readCapturedV3(ctx: ContentContext): CapturedV3ReadResult {
  // The start scenes merged (what the game starts with) and every scene
  // (loaded at start or on demand).
  if (ctx.content !== null && ctx.scenes !== undefined) {
    const content = ctx.content as ContentCatalogV4;
    const byId = new Map(ctx.scenes.map((sc) => [sc.sceneId, sc]));
    // Each scene's bodies on its default plane (the merged scene has none of its own).
    const entities = content.startScenes.flatMap((id) => {
      const sc = byId.get(id);
      return sc === undefined ? [] : withScenePlane(sc.entities, sc.defaultPlane);
    });
    // The start scenes' block-layer cells travel with them.
    const blocks = content.startScenes.flatMap((id) => byId.get(id)?.blocks ?? []);
    const ordered = content.scenes.map((e) => byId.get(e.sceneId)).filter((x): x is SceneV4 => x !== undefined);
    return {
      ok: true,
      read: {
        projectId: ctx.projectId,
        revision: ctx.revision,
        scene: { schemaVersion: 4, sceneId: content.startScenes[0] ?? '', revision: ctx.revision, entities, ...(blocks.length > 0 ? { blocks } : {}) },
        content,
        scenes: ordered.map((sc) => ({ ...sc, revision: ctx.revision })),
        startScenes: [...content.startScenes],
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'project_unavailable',
      cls: 'unavailable',
      reason: 'envelope_invalid',
      message: 'the project has no loaded scenes to capture',
    },
  };
}

