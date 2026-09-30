/**
 * Lost sidecars. An asset's `.tlasset` holds its record, so one deleted while
 * the project is closed (by hand, by a merge) would take the asset out of the
 * project and leave whatever uses it pointing at nothing. The open puts it
 * back instead, as Unity makes a lost `.meta` again:
 *
 * 1. from the record cache (`cache/records/<id>.tlasset`, a copy of every
 *    sidecar this machine wrote): the same id, settings and labels, next to
 *    the file the record names, when that file is there and has no sidecar;
 * 2. else, for an id something still uses, from a file named for it
 *    (`<name>.<ext>` whose name made id-safe is the id, the rule imports name
 *    assets by) that has no sidecar: a new import with default settings.
 *
 * What was put back, and what could not be, goes to the Problems log.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createdAssetRecord, validatePublishAssetArgs } from '@thirdlight/commands';
import type { CommandAssetRecord } from '@thirdlight/commands';

import { assetRoot, fileOfRecord, sidecarBytes, sidecarOf, sidecarPath, writeGameFile, type RecordLike } from './asset-files';
import { inspectProjectFile, type ContentContext } from './content-store';
import type { LoadDetail } from './errors';
import { assetNameOfFile, idStemOf, walkAssetFiles } from './folder-import';
import { cachedSidecar, mirrorSidecar, RECORD_CACHE_SEGMENTS } from './store-v4';
import { SIDECAR_SUFFIX } from './resource-files';
import type { Core } from './session';

/** One Problems row about a lost sidecar. */
export interface RecoveryProblem {
  code: 'asset_sidecar_restored' | 'asset_sidecar_rebuilt' | 'asset_sidecar_lost' | 'resource_file_invalid';
  message: string;
}

/** The ids a failed load names as used but not found (the model's missing-reference errors). */
export function missingReferenceIds(errors: readonly LoadDetail[]): string[] {
  const out = new Set<string>();
  for (const e of errors) {
    const found = (e as { found?: unknown }).found;
    if (/reference_missing$/.test(e.code) && typeof found === 'string') out.add(found);
  }
  return [...out];
}

function utcSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Sidecars copied into the record cache per turn of the event loop when the open fills it. */
const FILL_BATCH = 256;

/**
 * Put back, from the record cache, each cached asset not among `loaded`
 * whose file is there without a sidecar; and fill the cache for the loaded
 * assets it does not hold yet (a project opened before the cache existed:
 * in the background, a batch per turn, so the open does not wait on it).
 */
export function restoreFromRecordCache(core: Core, ctx: ContentContext, loaded: readonly RecordLike[], sidecarOfRecord: (file: string) => Uint8Array | undefined): RecoveryProblem[] {
  const root = assetRoot(ctx);
  const problems: RecoveryProblem[] = [];
  let cached: string[];
  try {
    cached = readdirSync(join(ctx.dir, ...RECORD_CACHE_SEGMENTS)).filter((n) => n.endsWith(SIDECAR_SUFFIX)).map((n) => n.slice(0, -SIDECAR_SUFFIX.length));
  } catch {
    cached = [];
  }
  const have = new Set(cached);
  const ids = new Set<string>();
  const fill: Uint8Array[] = [];
  for (const r of loaded) {
    ids.add(r.assetId);
    const file = fileOfRecord(r);
    if (have.has(r.assetId) || file === null) continue;
    const bytes = sidecarOfRecord(file);
    if (bytes !== undefined) fill.push(bytes);
  }
  const step = (from: number): void => {
    for (const bytes of fill.slice(from, from + FILL_BATCH)) mirrorSidecar(core.ops, ctx.dir, bytes);
    if (from + FILL_BATCH < fill.length) setTimeout(() => step(from + FILL_BATCH), 0).unref();
  };
  if (fill.length > 0) setTimeout(() => step(0), 0).unref();
  for (const id of cached) {
    if (ids.has(id)) continue;
    const c = cachedSidecar(core.ops, ctx.dir, id);
    const file = c === null ? null : fileOfRecord(c.record as unknown as RecordLike);
    if (c === null || file === null) continue;
    const abs = join(root, ...file.split('/'));
    if (!existsSync(abs) || existsSync(`${abs}${SIDECAR_SUFFIX}`)) continue;
    const w = writeGameFile(core, ctx, sidecarPath(file), c.bytes);
    problems.push(
      w.ok
        ? { code: 'asset_sidecar_restored', message: `${sidecarPath(file)} was missing; asset "${id}" was put back from the record cache (id, import settings and labels as they were)` }
        : { code: 'asset_sidecar_lost', message: `${sidecarPath(file)} is missing and could not be written back: ${w.error.message ?? w.error.code}` },
    );
  }
  return problems;
}

/**
 * For each id something uses but no sidecar holds: a file named for it with
 * no sidecar is imported again with default settings under that id (its
 * sidecar written). Returns what was done and what could not be.
 */
export function rebuildFromFiles(core: Core, ctx: ContentContext, missing: readonly string[], revision: number): { rebuilt: string[]; problems: RecoveryProblem[] } {
  const problems: RecoveryProblem[] = [];
  const rebuilt: string[] = [];
  if (missing.length === 0) return { rebuilt, problems };
  const orphans = walkAssetFiles({ ...ctx, content: null }, '').files.filter((f) => f.sidecar === null);
  for (const id of missing) {
    const file = orphans.find((f) => idStemOf(assetNameOfFile(f.path)) === id);
    if (file === undefined) continue;
    if (/\.fbx$/i.test(file.path)) {
      problems.push({ code: 'asset_sidecar_lost', message: `asset "${id}" lost its sidecar; ${file.path} is an FBX, which is converted when imported: import it again from the Assets tab with id "${id}"` });
      continue;
    }
    let kind: string = file.kind;
    let r = inspectProjectFile(core, ctx, file.path, { kind: file.kind });
    if (!r.ok && file.kind === 'audio') {
      kind = 'music';
      r = inspectProjectFile(core, ctx, file.path, { kind: 'music' });
    }
    if (!r.ok) {
      problems.push({ code: 'asset_sidecar_lost', message: `asset "${id}" lost its sidecar and ${file.path} could not be imported again: ${r.error.message ?? r.error.code}` });
      continue;
    }
    const p = r.proposal as unknown as { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown };
    const args = validatePublishAssetArgs({
      mode: 'create',
      assetId: id,
      kind,
      displayName: assetNameOfFile(file.path),
      sourceDigest: p.sourceDigest,
      sourceByteLength: p.sourceByteLength,
      importRecipe: p.importRecipe,
      metrics: p.metrics,
      sourcePath: file.path,
      importedAt: utcSecond(core.content.now()),
    });
    if (!args.ok) {
      problems.push({ code: 'asset_sidecar_lost', message: `asset "${id}" lost its sidecar and ${file.path} could not be imported again: ${args.error.message ?? args.error.code}` });
      continue;
    }
    const record: CommandAssetRecord = createdAssetRecord(args.args, revision);
    const w = writeGameFile(core, ctx, sidecarPath(file.path), sidecarBytes(sidecarOf(record as unknown as RecordLike)));
    if (!w.ok) {
      problems.push({ code: 'asset_sidecar_lost', message: `asset "${id}" lost its sidecar and ${sidecarPath(file.path)} could not be written: ${w.error.message ?? w.error.code}` });
      continue;
    }
    rebuilt.push(id);
    problems.push({ code: 'asset_sidecar_rebuilt', message: `asset "${id}" lost its sidecar; ${file.path} was imported again with default settings under the same id (its labels and import settings, if it had any, are gone)` });
  }
  return { rebuilt, problems };
}
