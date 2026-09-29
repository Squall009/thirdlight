/**
 * The open's upgrade of a `project.json` schemaVersion 4 project to 5: the
 * asset versions stored in `sources/sha256/` become files in the game folder.
 *
 * For each asset its current version is written out as a file with its
 * `.tlasset` sidecar: a stored version to `assets/<name>.<ext>`, a file
 * already referenced in place stays where it is, a converted version (an FBX
 * converted to GLB, a PNG/JPEG encoded to KTX2) writes its original as the
 * file and puts what the importer made into the import cache, a packed
 * texture writes its KTX2. The record keeps only that version (and a version
 * a legacy `modelAnimation` binding still names). Older versions stay in
 * `sources/sha256/` untouched and are listed in `upgrade-report.json` in the
 * project folder, so nothing is lost. An asset whose bytes cannot be written
 * keeps its stored version (it stays readable from the blob store) and is
 * listed as not moved.
 *
 * Idempotent: an interrupted upgrade (the files written, `project.json` still
 * 4) finds its files at the chosen paths with the right bytes and reuses them.
 */
import { join } from 'node:path';

import type { ContentCatalogV4, SceneV4 } from '@thirdlight/project-model';

import {
  allocateAssetPath,
  currentVersionOf,
  DEFAULT_ASSET_FOLDER,
  extensionFor,
  fileFactsOfVersion,
  fileOfVersion,
  fileStem,
  importKeyOfConverted,
  readGameFile,
  takenPaths,
  writeGameFile,
  writeImported,
  writeSidecar,
  type RecordLike,
  type VersionLike,
} from './asset-files';
import { readBlobBytes, type ContentConfig, type ContentContext } from './content-store';
import { sha256Hex } from './digest';
import { writeAtomic, type WriteOps } from './write';

/** The report of the upgrade, written next to `project.json`. */
export const UPGRADE_REPORT_FILE = 'upgrade-report.json';

export interface AssetUpgradeReport {
  from: 4;
  to: 5;
  at: string;
  /** Each asset's file (written from the blob store, or already in place). */
  files: { assetId: string; file: string; written: boolean }[];
  /** Versions the records no longer keep; their bytes stay where they were. */
  olderVersions: { assetId: string; version: number; sourceDigest: string; stored?: string; file?: string }[];
  /** Assets whose current version stays stored (why). */
  notMoved: { assetId: string; reason: string }[];
}

export interface AssetUpgradeResult {
  content: ContentCatalogV4;
  report: AssetUpgradeReport;
  notes: string[];
}

type Core = { ops: WriteOps; content: ContentConfig };

function blob(ctx: ContentContext, digest: string): Uint8Array | null {
  const r = readBlobBytes(join(ctx.dir, 'sources', 'sha256', digest));
  return r.ok && sha256Hex(r.bytes) === digest ? r.bytes : null;
}

/** Versions a legacy `modelAnimation` binding names, by asset id. */
function boundVersions(scenes: Iterable<SceneV4>, content: ContentCatalogV4): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const add = (components: Record<string, unknown>): void => {
    const anim = components['modelAnimation'] as { assetId?: unknown; version?: unknown } | undefined;
    if (anim === undefined || typeof anim.assetId !== 'string' || typeof anim.version !== 'number') return;
    const set = out.get(anim.assetId) ?? new Set<number>();
    set.add(anim.version);
    out.set(anim.assetId, set);
  };
  for (const sc of scenes) for (const e of sc.entities) add(e.components as Record<string, unknown>);
  for (const p of content.prefabs) for (const e of p.entities as unknown as { components: Record<string, unknown> }[]) add(e.components);
  return out;
}

/**
 * `readStored` reads a stored version's bytes by digest (the project's blob
 * store by default; a template's bytes when a project is made from one);
 * `report: false` writes no report (a new project has nothing to report).
 */
export interface AssetUpgradeOptions {
  readStored?: (digest: string) => Uint8Array | null;
  report?: boolean;
}

export function upgradeAssetsToFiles(core: Core, ctx: ContentContext, content: ContentCatalogV4, scenes: Iterable<SceneV4>, options: AssetUpgradeOptions = {}): AssetUpgradeResult {
  const readStored = options.readStored ?? ((digest: string) => blob(ctx, digest));
  const report: AssetUpgradeReport = { from: 4, to: 5, at: new Date(core.content.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'), files: [], olderVersions: [], notMoved: [] };
  const taken = takenPaths(content);
  const bound = boundVersions(scenes, content);
  const records = content.assets as unknown as RecordLike[];
  const upgraded: RecordLike[] = [];
  for (const record of records) {
    const current = currentVersionOf(record);
    if (current === undefined) {
      upgraded.push(record);
      continue;
    }
    const placed = placeVersion(core, ctx, record, current, taken, report, readStored);
    const keep = bound.get(record.assetId) ?? new Set<number>();
    const versions: VersionLike[] = [];
    for (const v of record.versions) {
      if (v.version === current.version) {
        versions.push(placed);
        continue;
      }
      if (keep.has(v.version)) {
        versions.push(v);
        continue;
      }
      const file = fileOfVersion(v);
      report.olderVersions.push({
        assetId: record.assetId,
        version: v.version,
        sourceDigest: v.sourceDigest,
        ...(file !== null ? { file } : { stored: `sources/sha256/${v.sourceDigest}` }),
      });
    }
    upgraded.push({ ...record, versions });
  }
  const next = { ...content, assets: upgraded as unknown as ContentCatalogV4['assets'] };
  // Sidecars once every record has its file (a packed texture's names its sources' files).
  const stayed = new Set(report.notMoved.map((n) => n.assetId));
  for (const record of upgraded) {
    if (stayed.has(record.assetId)) continue;
    const problem = writeSidecar(core, ctx, record, next);
    if (problem !== null) report.notMoved.push({ assetId: record.assetId, reason: `its sidecar could not be written: ${problem}` });
  }
  if (options.report !== false) writeAtomic({ dir: ctx.dir, target: join(ctx.dir, UPGRADE_REPORT_FILE), bytes: new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`), allowedPreHashes: [], previousHash: null, ops: core.ops });
  const written = report.files.filter((f) => f.written).length;
  const notes = [
    `project schemaVersion 4 → 5: every asset is a file in the game folder with a .tlasset sidecar (${written} written from sources/sha256, ${report.files.length - written} already in place; ${UPGRADE_REPORT_FILE} in the project folder lists them)`,
    ...(report.olderVersions.length > 0 ? [`${report.olderVersions.length} older asset versions are no longer listed; their bytes stay in sources/sha256 (see ${UPGRADE_REPORT_FILE})`] : []),
    ...report.notMoved.map((n) => `asset ${n.assetId} stays stored: ${n.reason}`),
  ];
  return { content: next, report, notes };
}

/** The current version with its file in the game folder (written from the blob store when needed). */
function placeVersion(core: Core, ctx: ContentContext, record: RecordLike, v: VersionLike, taken: Set<string>, report: AssetUpgradeReport, readStored: (digest: string) => Uint8Array | null): VersionLike {
  const kind = record.kind ?? 'model';
  const conv = v.convertedFrom;
  if (conv !== undefined) {
    // What the importer made goes to the import cache (it can be made again from the original).
    const made = readStored(v.sourceDigest);
    if (made !== null) writeImported(core, ctx, importKeyOfConverted(conv), made);
  }
  const existing = fileOfVersion(v);
  if (existing !== null) {
    report.files.push({ assetId: record.assetId, file: existing, written: false });
    return v;
  }
  const facts = fileFactsOfVersion(v);
  const bytes = readStored(facts.digest);
  if (bytes === null) {
    report.notMoved.push({ assetId: record.assetId, reason: `its bytes (sources/sha256/${facts.digest}) are missing or damaged` });
    return v;
  }
  const ext = extensionFor(kind, v.metrics, conv?.format);
  const stem = fileStem(record.displayName ?? record.assetId, record.assetId);
  // An interrupted upgrade left this asset's file: reuse it.
  let rel: string | null = null;
  for (let n = 1; n < 64; n += 1) {
    const candidate = `${DEFAULT_ASSET_FOLDER}/${n === 1 ? stem : `${stem}-${n}`}.${ext}`;
    if (taken.has(candidate.toLowerCase())) continue;
    const there = readGameFile(ctx, candidate);
    if (there === null) break;
    if (sha256Hex(there) === facts.digest) {
      rel = candidate;
      break;
    }
  }
  let written = false;
  if (rel === null) {
    rel = allocateAssetPath(ctx, taken, DEFAULT_ASSET_FOLDER, stem, ext);
    const w = writeGameFile(core, ctx, rel, bytes);
    if (!w.ok) {
      report.notMoved.push({ assetId: record.assetId, reason: `${rel} could not be written (${w.error.message})` });
      return v;
    }
    written = true;
  }
  taken.add(rel.toLowerCase());
  report.files.push({ assetId: record.assetId, file: rel, written });
  return conv !== undefined ? { ...v, convertedFrom: { ...conv, sourcePath: rel } } : { ...v, sourcePath: rel };
}
