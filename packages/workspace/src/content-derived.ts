/**
 * Derived caches: converted imports and prepared behavior sources under
 * `.thirdlight/derived/`. They are regenerable and never authoritative: a
 * write here changes no revision, no envelope and no catalog.
 */

import { DIGEST_RE, ID_RE, isDigest } from '@thirdlight/project-model';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BEHAVIOR_ENTRY_PATH,
  MAX_BEHAVIOR_FILES,
  MAX_BEHAVIOR_OUTPUT_BYTES,
  MAX_BEHAVIOR_SOURCE_BYTES,
} from '@thirdlight/project-model';
import type { PreparedBehaviorSource } from '@thirdlight/behavior-build';
import { contentPublishFailed, derivedCacheUnavailable } from './errors';
import type { CommandError } from '@thirdlight/commands';
import { writeAtomic, type WriteOps } from './write';
import { isPlainObject } from '@thirdlight/shared';
import { type ContentContext, verifyArtifactDir } from './content-store';

// ---- derived caches ------------------------------------

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

// ---- prepared behavior sources (derived cache) ---------------------

const PREPARED_ID_RE = ID_RE;
/** A bounded in-memory prepared-index scan (derived caches are non-authoritative). */
export const MAX_PREPARED_SCAN = 256;

/** `prepared.json` bytes (canonical 2-space JSON + newline). */
export function preparedRecordBytes(prepared: PreparedBehaviorSource): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(prepared, null, 2)}\n`);
}

/**
 * Shape-validate one persisted prepared record. Derived data: an invalid or
 * corrupt entry is skipped, never repaired and never authoritative.
 */
export function parsePreparedRecord(value: unknown): PreparedBehaviorSource | null {
  if (!isPlainObject(value)) return null;
  const isInt = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (typeof value['behaviorId'] !== 'string' || !PREPARED_ID_RE.test(value['behaviorId'])) return null;
  if (!isDigest(value['sourceDigest'])) return null;
  if (!isInt(value['sourceByteLength'], 1, MAX_BEHAVIOR_SOURCE_BYTES)) return null;
  if (value['entryPath'] !== BEHAVIOR_ENTRY_PATH) return null;
  if (!isInt(value['fileCount'], 1, MAX_BEHAVIOR_FILES)) return null;
  if (!isDigest(value['manifestDigest']) || !isDigest(value['outputDigest'])) return null;
  if (!isInt(value['outputByteLength'], 1, MAX_BEHAVIOR_OUTPUT_BYTES)) return null;
  if (!Array.isArray(value['requiredModules']) || value['requiredModules'].some((m) => typeof m !== 'string')) return null;
  if (!Array.isArray(value['ownedTransforms']) || value['ownedTransforms'].some((m) => typeof m !== 'string')) return null;
  const decl = value['declaration'];
  if (!isPlainObject(decl) || !Array.isArray(decl['properties'])) return null;
  if (!isDigest(value['declarationDigest']) || !isDigest(value['recipeDigest'])) return null;
  const compiler = value['compiler'];
  if (!isPlainObject(compiler) || typeof compiler['id'] !== 'string' || typeof compiler['esbuild'] !== 'string') return null;
  return value as unknown as PreparedBehaviorSource;
}

/** Read one prepared record for `sourceDigest` (first valid derived entry). */
export function readPreparedSource(thirdlightDir: string, sourceDigest: string): PreparedBehaviorSource | null {
  if (!DIGEST_RE.test(sourceDigest)) return null;
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
    if (!DIGEST_RE.test(digest)) continue;
    const rec = readPreparedSource(thirdlightDir, digest);
    if (rec !== null) out.set(digest, rec);
  }
  return out;
}

/**
 * Write the prepared record into the derived cache (non-authoritative: no
 * lock, no envelope write, no revision change).
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
