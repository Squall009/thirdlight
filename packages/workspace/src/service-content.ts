/**
 * The workspace service's content storage operations: staging, inspection,
 * blob publication and verified reads, the game-folder asset files and their
 * sidecars, the held bytes and the import cache. Each resolves the project
 * (the on-demand open) and runs one content-store / asset-files operation on
 * its session; none of them changes authoritative state (only commands do).
 */
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { CommandError } from '@thirdlight/commands';
import type { ContentCatalogV4 } from '@thirdlight/project-model';

import { isValidSourcePath } from '@thirdlight/project-model';

import {
  DEFAULT_ASSET_FOLDER,
  fileStem,
  gameFileExists,
  takenPaths,
  writeGameFile,
  assetRoot,
  checkAssetFolder,
  currentVersionOf,
  fileFactsOfVersion,
  fileOfRecord,
  findSidecars,
  hasImported,
  holdBytes,
  importKeyOfConverted,
  readHeader,
  sidecarPath,
  writeHeader,
  writeImported,
  headerKey,
  IMPORT_CACHE_SEGMENTS,
  type ImportHeader,
  type ImportKey,
  type RecordLike,
} from './asset-files';
import {
  contentIntegrity,
  conversionSource,
  discardStage,
  inspectProjectFile,
  inspectStage,
  listProjectFiles,
  publishBlob,
  readBlob,
  readCapturedV3,
  readSourceBlob,
  resolveProjectFile,
  resolveStage,
  stageContent,
  fileDigest,
  type BlobPublishRequest,
  type BlobPublishResult,
  type BlobReadRequest,
  type BlobReadResult,
  type CapturedV3ReadResult,
  type ContentContext,
  type ContentIntegrityResult,
  type IntegrityPage,
  type ConversionSourceResult,
  type InspectProjectFileResult,
  type InspectStageOptions,
  type InspectStageResult,
  type ProjectFileListResult,
  type SourceBlobReadRequest,
  type SourceBlobReadResult,
  type StageDiscardResult,
  type StageRequest,
  type StageResult,
} from './content-store';
import { contentPublishFailed, pathRejected, projectNotFound, projectUnavailable } from './errors';
import { locateMipParts, type MipPartFile } from './mip-parts';
import { scanAssetFolder, writeUploadedFile, type FolderImportScan, type PreparedImportFile } from './folder-import';
import { deepFreeze } from './isolate';
import { ensureSession, type Core, type ProjectSession } from './session';
import { restoreSidecars } from './session-v4';
import { checkResourceFiles } from './resource-check';
import { locateBlob, locateSourceBlob, openBlobFile, type BlobFile, type LocateBlobResult, type OpenBlobResult } from './blob-files';
import { FileStamps, FILE_STAMPS_NAME } from './file-stamps';

/** The session as the content-store operations need it. */
export function contentCtx(s: ProjectSession): ContentContext {
  return {
    projectId: s.projectId,
    dir: s.dir,
    thirdlightDir: s.thirdlightDir,
    storageVersion: s.storageVersion,
    revision: s.revision,
    scene: s.scene,
    content: s.content,
    gameFolder: s.gameFolder ?? null,
    stamps: stampsOfSession(s),
    ...(s.v4 ? { scenes: [...s.v4.scenes.values()] } : {}),
  };
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The session's file stamps, read from the import cache the first time they are asked for. */
export function stampsOfSession(s: ProjectSession): FileStamps {
  return (s.fileStamps ??= new FileStamps(join(s.dir, ...IMPORT_CACHE_SEGMENTS, FILE_STAMPS_NAME)));
}

/** One asset's file as the check of the game folder sees it (the current version). */
export interface AssetFileEntry {
  assetId: string;
  kind: string;
  displayName: string;
  version: number;
  /** The file in the game folder (a converted asset's original); null: bytes stored before files (an upgrade that could not write them). */
  file: string | null;
  /** The file's state against the recorded bytes. */
  status: 'ok' | 'missing' | 'changed' | 'unreadable' | 'stored';
  /** The recorded digest of the file. */
  digest: string;
  /** The digest of the bytes on disk, when they changed. */
  foundDigest?: string;
  /** A converted asset: its conversion and whether the import cache holds the result. */
  converted?: { format: string; encoding?: string; converter: { name: string; version: string }; imported: 'ok' | 'missing' };
  /** A packed texture (its file is the packed KTX2; its sources are other assets). */
  packed?: true;
  /** A model a legacy `modelAnimation` binding names (a re-import needs its role mapping). */
  animated?: true;
}

export type AssetFilesResult =
  | { ok: true; entries: AssetFileEntry[]; sidecarProblems: string[] }
  | { ok: false; error: CommandError };

export function contentOps(core: Core) {
  /** Resolve the project for a content operation (the on-demand open). */
  function withOpenSession<T>(projectId: string, fn: (s: ProjectSession) => T, missing: (e: CommandError) => T): T {
    const o = ensureSession(core, projectId, 'command');
    if (o.kind === 'not-found') return missing(projectNotFound(projectId));
    if (o.kind === 'unavailable') return missing(projectUnavailable(o.reason, o.holder, o.errors ?? []));
    if (o.kind === 'released') return missing(projectUnavailable('workspace_closed', null, []));
    const s = o.session;
    if (s.mode !== 'open') {
      return missing(projectUnavailable(s.blocked?.reason ?? 'envelope_invalid', null, s.blocked?.errors ?? []));
    }
    return fn(s);
  }
  const run = <T>(projectId: string, fn: (s: ProjectSession) => T): T | { ok: false; error: CommandError } =>
    deepFreeze(withOpenSession<T | { ok: false; error: CommandError }>(projectId, fn, (error) => ({ ok: false, error })));

  /**
   * Every asset's file against the catalog, and the sidecars written where
   * they are missing or no longer say what the catalog does. A moved file
   * shows as `missing` (`findMovedAssets` finds it by its sidecar), a changed
   * one as `changed` (the backend imports it again).
   */
  function assetFiles(projectId: string): AssetFilesResult {
    return run(projectId, (s): AssetFilesResult => {
      const ctx = contentCtx(s);
      const content = s.content as ContentCatalogV4 | null;
      const records = (content?.assets ?? []) as unknown as RecordLike[];
      const animatedIds = new Set<string>();
      for (const sc of s.v4?.scenes.values() ?? []) {
        for (const e of sc.entities) {
          const anim = (e.components as { modelAnimation?: { assetId?: unknown } }).modelAnimation;
          if (anim !== undefined && typeof anim.assetId === 'string') animatedIds.add(anim.assetId);
        }
      }
      const entries: AssetFileEntry[] = [];
      const sidecarProblems: string[] = [];
      const lost: RecordLike[] = [];
      const root = assetRoot(ctx);
      const stamps = stampsOfSession(s);
      const seen = new Set<string>();
      for (const r of records) {
        const v = currentVersionOf(r);
        if (v === undefined) continue;
        const file = fileOfRecord(r);
        const facts = fileFactsOfVersion(v);
        let status: AssetFileEntry['status'] = 'stored';
        let found: string | null = null;
        if (file !== null) {
          const res = resolveProjectFile(ctx, file);
          if (!res.ok) status = res.missing === true ? 'missing' : 'unreadable';
          else {
            seen.add(res.real);
            found = fileDigest(ctx, res.real);
            status = found === null ? 'unreadable' : found === facts.digest && res.size === facts.byteLength ? 'ok' : 'changed';
          }
        }
        const entry: AssetFileEntry = { assetId: r.assetId, kind: r.kind ?? 'model', displayName: r.displayName ?? r.assetId, version: v.version, file, status, digest: facts.digest };
        if (status === 'changed' && found !== null) entry.foundDigest = found;
        if (v.convertedFrom !== undefined) {
          const c = v.convertedFrom;
          entry.converted = {
            format: c.format,
            ...(c.encoding !== undefined ? { encoding: c.encoding } : {}),
            converter: { name: c.converter.name, version: c.converter.version },
            imported: hasImported(ctx, importKeyOfConverted(c), v.sourceDigest, v.sourceByteLength) ? 'ok' : 'missing',
          };
        }
        if (v.packedFrom !== undefined) entry.packed = true;
        if (animatedIds.has(r.assetId)) entry.animated = true;
        entries.push(entry);
        // The file is there but its sidecar (the record's file) is not: it is written again.
        if (file !== null && status !== 'missing' && status !== 'unreadable' && !existsSync(join(root, ...sidecarPath(file).split('/')))) lost.push(r);
      }
      sidecarProblems.push(...restoreSidecars(core, s, lost));
      // Game-folder files no asset uses any more drop out of the stamps; the project's own stores (blobs, import cache) stay.
      const dirReal = realDir(s.dir);
      const own = [join(dirReal, 'cache') + sep, join(dirReal, 'sources') + sep];
      stamps.retainOnly(seen, (p) => !own.some((o) => p.startsWith(o)));
      stamps.save();
      return { ok: true, entries, sidecarProblems };
    }) as AssetFilesResult;
  }

  /** The game-folder file of each asset id found by its sidecar (only files that are there). */
  function findMovedAssets(projectId: string, assetIds: readonly string[]): { ok: true; found: Record<string, string> } | { ok: false; error: CommandError } {
    return run(projectId, (s) => ({ ok: true as const, found: Object.fromEntries(findSidecars(contentCtx(s), new Set(assetIds))) }));
  }

  /** Hold uploaded bytes until the `publishAsset` that files them into the game folder. */
  function holdAssetBytes(projectId: string, bytes: Uint8Array): { ok: true; digest: string; byteLength: number } | { ok: false; error: CommandError } {
    return run(projectId, (s) => {
      const r = holdBytes(core, contentCtx(s), bytes);
      return r.ok ? { ok: true as const, digest: r.digest, byteLength: bytes.length } : r;
    });
  }

  /** Put what an importer made from a file into the import cache. */
  function writeImportedArtifact(projectId: string, key: ImportKey, bytes: Uint8Array): { ok: true; digest: string } | { ok: false; error: CommandError } {
    return run(projectId, (s) => writeImported(core, contentCtx(s), key, bytes));
  }

  /** The cached inspection of a file's bytes (null: not cached). */
  function readImportHeader(projectId: string, sourceDigest: string, kind: string, toolchain: string): ImportHeader | null {
    return withOpenSession(projectId, (s) => readHeader(contentCtx(s), headerKey(sourceDigest, kind, toolchain)), () => null);
  }

  function writeImportHeader(projectId: string, header: ImportHeader, toolchain: string): void {
    withOpenSession(projectId, (s) => writeHeader(core, contentCtx(s), headerKey(header.sourceDigest, header.kind, toolchain), header), () => undefined);
  }

  /**
   * Write a set of files into a new folder of the game folder,
   * `assets/<stem>/` (then `<stem>-2`, …), keeping their relative paths:
   * an asset tool's export arriving as a zip lands there and its model is
   * then imported where it is.
   */
  function writeAssetFolder(projectId: string, stem: string, files: readonly { path: string; bytes: Uint8Array }[]): { ok: true; folder: string } | { ok: false; error: CommandError } {
    return run(projectId, (s): { ok: true; folder: string } | { ok: false; error: CommandError } => {
      const ctx = contentCtx(s);
      for (const f of files) if (!isValidSourcePath(f.path)) return { ok: false, error: pathRejected(f.path, 'a file of the folder must have a relative path') };
      const taken = takenPaths(s.content as ContentCatalogV4 | null);
      const base = fileStem(stem, 'import');
      let folder = '';
      for (let n = 1; ; n += 1) {
        folder = `${DEFAULT_ASSET_FOLDER}/${n === 1 ? base : `${base}-${n}`}`;
        const lower = `${folder.toLowerCase()}/`;
        if ([...taken].some((t) => t.startsWith(lower))) continue;
        if (!resolveProjectFile(ctx, folder, 'dir').ok && !gameFileExists(ctx, folder)) break;
      }
      for (const f of files) {
        const w = writeGameFile(core, ctx, `${folder}/${f.path}`, f.bytes);
        if (!w.ok) return w;
      }
      return { ok: true, folder };
    });
  }

  /** Every file of a folder, recursively: new importable files, files already imported, unsupported ones. */
  function scanFolder(projectId: string, folder: string): { ok: true; scan: FolderImportScan } | { ok: false; error: CommandError } {
    return run(projectId, (s) => scanAssetFolder(contentCtx(s), folder));
  }

  /** Keep a folder's inspected files for its `importAssets` (the latest preparation of a folder wins). */
  function prepareAssetImport(projectId: string, folder: string, files: readonly PreparedImportFile[]): { ok: true } | { ok: false; error: CommandError } {
    return withOpenSession<{ ok: true } | { ok: false; error: CommandError }>(
      projectId,
      (s) => {
        s.preparedImports ??= new Map();
        s.preparedImports.set(folder, [...files]);
        return { ok: true };
      },
      (error) => ({ ok: false, error }),
    );
  }

  /** The upgrade notes of the project's open, once. */
  function takeUpgradeNotes(projectId: string): string[] {
    return withOpenSession(
      projectId,
      (s) => {
        const notes = s.upgradeNotes ?? [];
        s.upgradeNotes = [];
        return notes;
      },
      () => [],
    );
  }

  /** What the open put back of lost sidecars, or could not (each once, with its code). */
  function takeOpenProblems(projectId: string): { code: string; message: string }[] {
    return withOpenSession(
      projectId,
      (s) => {
        const out = s.openProblems ?? [];
        s.openProblems = [];
        return out;
      },
      () => [],
    );
  }

  /** The project's import cache folder (thumbnails are kept there too); null when the project cannot be opened. */
  function importCacheDir(projectId: string): string | null {
    return withOpenSession(projectId, (s) => join(s.dir, 'cache', 'imported'), () => null);
  }

  return {
    stageContent: (projectId: string, request: StageRequest): StageResult => run(projectId, (s) => stageContent(core, contentCtx(s), request)),
    discardStage: (projectId: string, stageId: string): StageDiscardResult => run(projectId, (s) => discardStage(core, contentCtx(s), stageId)),
    /** The injected bounded inspector over the staged bytes; never mutates authoring state. */
    inspectStage: (projectId: string, stageId: string, options?: InspectStageOptions): InspectStageResult => run(projectId, (s) => inspectStage(core, contentCtx(s), stageId, options ?? {})),
    /** One folder of the game folder (importable files and subfolders). */
    listProjectFiles: (projectId: string, dir: string): ProjectFileListResult => run(projectId, (s) => listProjectFiles(contentCtx(s), dir)),
    /** Inspect a file in the game folder where it is; the returned `sourcePath` goes into `publishAsset`. */
    inspectProjectFile: (projectId: string, sourcePath: string, options?: InspectStageOptions): InspectProjectFileResult =>
      run(projectId, (s) => inspectProjectFile(core, contentCtx(s), sourcePath, options ?? {})),
    /** The input file of a conversion (backend-internal: carries a host path). */
    conversionSource: (projectId: string, sourcePath: string): ConversionSourceResult => run(projectId, (s) => conversionSource(contentCtx(s), sourcePath)),
    /** The bytes of one open stage (an uploaded file to convert). */
    readStage: (projectId: string, stageId: string): { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError } =>
      withOpenSession<{ ok: true; bytes: Uint8Array } | { ok: false; error: CommandError }>(
        projectId,
        (s) => {
          const r = resolveStage(core, contentCtx(s), stageId);
          return r.ok ? { ok: true, bytes: r.stage.bytes } : { ok: false, error: r.error };
        },
        (error) => ({ ok: false, error }),
      ),
    /** Immutable blob publication (no lock). */
    publishBlob: (projectId: string, request: BlobPublishRequest): BlobPublishResult => run(projectId, (s) => publishBlob(core, contentCtx(s), request)),
    /** The only public verified byte read of an asset version. */
    readBlob: (projectId: string, request: BlobReadRequest): BlobReadResult => run(projectId, (s) => readBlob(core, contentCtx(s), request)),
    /** A digest-addressed verified read of one blob (behavior source containers, instance buffers). */
    readSourceBlob: (projectId: string, request: SourceBlobReadRequest): SourceBlobReadResult => run(projectId, (s) => readSourceBlob(core, contentCtx(s), request)),
    contentIntegrity: (projectId: string, page?: IntegrityPage): ContentIntegrityResult => run(projectId, (s) => contentIntegrity(core, contentCtx(s), page)),
    locateBlobs: (projectId: string, requests: readonly BlobReadRequest[]): { ok: true; results: LocateBlobResult[] } | { ok: false; error: CommandError } =>
      withOpenSession<{ ok: true; results: LocateBlobResult[] } | { ok: false; error: CommandError }>(
        projectId,
        (s) => {
          const ctx = contentCtx(s);
          const results = requests.map((r) => locateBlob(ctx, r));
          stampsOfSession(s).save();
          return { ok: true, results };
        },
        (error) => ({ ok: false, error }),
      ),
    /** A located texture's streaming parts (cut into the import cache the first time; `parts: null`: it ships whole). */
    locateMipParts: (projectId: string, whole: BlobFile): { ok: true; parts: MipPartFile[] | null } | { ok: false; error: CommandError } =>
      withOpenSession<{ ok: true; parts: MipPartFile[] | null } | { ok: false; error: CommandError }>(
        projectId,
        (s) => {
          const r = locateMipParts(core, contentCtx(s), whole);
          stampsOfSession(s).save();
          return r.ok ? r : { ok: false, error: contentPublishFailed('write') };
        },
        (error) => ({ ok: false, error }),
      ),
    locateSourceBlob: (projectId: string, digest: string): { ok: true; file: BlobFile } | { ok: false; error: CommandError } =>
      withOpenSession<{ ok: true; file: BlobFile } | { ok: false; error: CommandError }>(projectId, (s) => locateSourceBlob(contentCtx(s), digest), (error) => ({ ok: false, error })),
    openBlobFile: (projectId: string, file: BlobFile): OpenBlobResult =>
      withOpenSession<OpenBlobResult>(projectId, (s) => openBlobFile(contentCtx(s), file), (error) => ({ ok: false, error, changed: false })),
    fileStampStats: (projectId: string): { files: number; hashes: number } | null =>
      withOpenSession(projectId, (s) => ({ files: stampsOfSession(s).size, hashes: stampsOfSession(s).hashes }), () => null),
    /** The single acknowledged project read (scenes + content). */
    readCapturedV3: (projectId: string): CapturedV3ReadResult => run(projectId, (s) => readCapturedV3(contentCtx(s))),
    assetFiles,
    findMovedAssets,
    holdAssetBytes,
    writeImportedArtifact,
    readImportHeader,
    writeImportHeader,
    importCacheDir,
    writeAssetFolder,
    scanAssetFolder: scanFolder,
    prepareAssetImport,
    takeUpgradeNotes,
    takeOpenProblems,
    writeUploadedFile: (projectId: string, path: string, bytes: Uint8Array) => run(projectId, (s) => writeUploadedFile(core, contentCtx(s), path, bytes)),
    checkAssetFolder: (projectId: string, folder: string) => run(projectId, (s) => checkAssetFolder(contentCtx(s), folder)),
    checkResourceFiles: (projectId: string) => run(projectId, (s) => ({ ok: true as const, ...checkResourceFiles(core, s) })),
  };
}
