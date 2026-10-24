/**
 * A template's assets become files in the new project's game folder: a
 * template keeps its asset versions as stored bytes (by digest), a project
 * keeps each asset as a file with its `.tlasset` sidecar.
 *
 * For each asset its current version is written out as a file: a stored
 * version to `assets/<name>.<ext>`, a file already referenced in place stays
 * where it is, a converted version (an FBX converted to GLB, a PNG/JPEG
 * encoded to KTX2) writes its original as the file and puts what the
 * importer made into the import cache, a packed texture writes its KTX2. The
 * record keeps only that version (and a version a legacy `modelAnimation`
 * binding still names). An asset whose bytes cannot be written is listed as
 * not moved (the creation refuses it).
 *
 * Idempotent: an interrupted creation finds its files at the chosen paths
 * with the right bytes and reuses them.
 */
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
  type RecordLike,
  type VersionLike,
} from './asset-files';
import type { ContentConfig, ContentContext } from './content-store';
import { sha256Hex } from './digest';
import type { WriteOps } from './write';

/** The report of an open's upgrade, written next to `project.json`. */
export const UPGRADE_REPORT_FILE = 'upgrade-report.json';

export interface AssetUpgradeReport {
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
}

type Core = { ops: WriteOps; content: ContentConfig };

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

/** `readStored` reads a stored version's bytes by digest (the template's). */
export function upgradeAssetsToFiles(core: Core, ctx: ContentContext, content: ContentCatalogV4, scenes: Iterable<SceneV4>, readStored: (digest: string) => Uint8Array | null): AssetUpgradeResult {
  const report: AssetUpgradeReport = { files: [], olderVersions: [], notMoved: [] };
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
  // The sidecars (each holding its record) are written with the project files that follow.
  return { content: next, report };
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
