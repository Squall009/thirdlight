/**
 * Content staging: bounded staged uploads under the project's staging root
 * (count, byte and age bounds; published stages evicted first), their
 * resolution and discard. A stage is never authoritative; publication reads
 * it through `resolveStage`.
 */

import { ID_RE } from '@thirdlight/project-model';
import { lstatSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_OPEN_STAGES, MAX_SOURCE_BYTES, MAX_STAGED_BYTES_PER_PROJECT } from '@thirdlight/project-model';
import { sha256HexNative } from './digest';
import {
  contentPublishFailed,
  pathRejected,
  stageExpired,
  stageLimitsExceeded,
  stageNotFound,
  type StageLimit,
} from './errors';
import type { CommandError } from '@thirdlight/commands';
import { writeAtomic, type WriteOps } from './write';
import {
  ABANDONED_STAGE_RETENTION_SECONDS,
  type ContentConfig,
  type ContentContext,
  STAGE_TTL_SECONDS,
  stagingRoot,
  verifyArtifactDir,
} from './content-store';

// ---- staging --------------------------------------------

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

export function stageLimitError(limit: StageLimit, current: number, max: number): CommandError {
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

/**
 * Remove the stage directories past the stage TTL (measured as `resolveStage`
 * measures it: the directory's mtime), except `keep`. Non-authoritative
 * cleanup only; best effort.
 */
function removeExpiredStages(root: string, keep: string, nowMs: number): void {
  for (const name of listStageDirs(root)) {
    if (name === keep) continue;
    const p = join(root, name);
    try {
      const st = lstatSync(p);
      if (st.isDirectory() && Math.floor((nowMs - st.mtimeMs) / 1000) > STAGE_TTL_SECONDS) rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** The marker a stage gets once a publication made from it is committed. */
const STAGE_PUBLISHED_MARKER = 'published';

function stageIsPublished(root: string, name: string): boolean {
  try {
    return lstatSync(join(root, name, STAGE_PUBLISHED_MARKER)).isFile();
  } catch {
    return false;
  }
}

/**
 * Make room for a new stage by removing published stages, oldest first,
 * while the open-stage count or the staged bytes would pass their limits.
 * A published stage's bytes already live in the project's immutable blobs;
 * it is kept only so a retry of the same publication (a lost answer) finds
 * it again, so it gives way to a new upload rather than refusing it.
 */
function evictPublishedStages(root: string, keep: string, incomingBytes: number): void {
  const published = listStageDirs(root)
    .filter((n) => n !== keep && stageIsPublished(root, n))
    .map((n) => {
      try {
        return { name: n, mtimeMs: lstatSync(join(root, n)).mtimeMs };
      } catch {
        return { name: n, mtimeMs: 0 };
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const stage of published) {
    const existing = listStageDirs(root);
    const alreadyStaged = (() => {
      try {
        return statSync(join(root, keep, 'source.bin')).size;
      } catch {
        return 0;
      }
    })();
    const countFull = !existing.includes(keep) && existing.length >= MAX_OPEN_STAGES;
    const bytesFull = stagedBytes(root) - alreadyStaged + incomingBytes > MAX_STAGED_BYTES_PER_PROJECT;
    if (!countFull && !bytesFull) return;
    try {
      rmSync(join(root, stage.name), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * `markStagePublished(projectId, stageId)`: a publication made from this
 * stage is committed, so the stage no longer holds an open-stage slot (see
 * `evictPublishedStages`). Non-authoritative; an unknown stage is a no-op.
 */
export function markStagePublished(
  core: { ops: WriteOps; content: ContentConfig },
  ctx: ContentContext,
  stageId: unknown,
): StageDiscardResult {
  if (typeof stageId !== 'string' || !ID_RE.test(stageId)) return { ok: false, error: stageNotFound(String(stageId)) };
  const dirRes = verifyArtifactDir(ctx.dir, ['.thirdlight', 'staging', stageId], false);
  if (!dirRes.ok) return { ok: true, discarded: false };
  const wr = writeAtomic({ dir: dirRes.dir, target: join(dirRes.dir, STAGE_PUBLISHED_MARKER), bytes: new Uint8Array(0), allowedPreHashes: [], previousHash: null, ops: core.ops });
  if (wr.failed || wr.unreadable || wr.external) return { ok: false, error: contentPublishFailed('write', wr.failed?.onDiskState, wr.failed?.errno) };
  return { ok: true, discarded: false };
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
 * authoritative path. Runs on a successful open.
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

/** `stageContent(projectId, { stageId, bytes, displayName? })`. */
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
  // A stage past its TTL can never be used again (`resolveStage`
  // refuses it as `stage_expired`), so it no longer counts as open: remove
  // the expired ones (another stage than this one) before counting. Before,
  // a publication (which keeps its stage) or an abandoned upload held one of
  // the eight open-stage slots for the 24 h abandoned-stage retention, and a
  // few sessions' uploads locked the project out of staging for a day.
  removeExpiredStages(root, stageId, core.content.now());
  evictPublishedStages(root, stageId, bytes.length);
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
    // Staging is a supported edit path: no pre-write
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
  const digest = sha256HexNative(bytes);
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
  return { ok: true, stage: { stageId, dir, bytes, digest: sha256HexNative(bytes) } };
}

/** `discardStage(projectId, stageId)`. */
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
