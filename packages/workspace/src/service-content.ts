/**
 * The workspace service's content storage operations: staging, inspection,
 * blob publication and verified reads, the game-folder asset files and their
 * sidecars, the held bytes and the import cache. Each resolves the project
 * (the on-demand open) and runs one content-store / asset-files operation on
 * its session; none of them changes authoritative state (only commands do).
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, sep } from 'node:path';

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
  importedArtifactFile,
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
import { assetRecordOf } from './catalog-lookup';
import { isWithin } from './registry';
import { WatchedAssets, type WatchedAssetsStats } from './watched-assets';

/** The session as the content-store operations need it. */
/**
 * How long the file check's walk over the assets holds the event loop before
 * it lets other requests in (about one frame of an editor at 60 Hz).
 */
export const FILE_CHECK_SLICE_MS = 16;

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
    ...(s.watchedAssets ? { watched: s.watchedAssets } : {}),
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

/**
 * The folder watch of an open project, made by its first file check (null:
 * watching is off). The game folder is watched, and the import cache when it
 * is outside it; the project's own journals, record cache and blob store are
 * not (only the backend writes them).
 */
export function watchedOf(core: Core, s: ProjectSession): WatchedAssets | null {
  if (s.watchedAssets !== undefined) return s.watchedAssets;
  const config = core.content.fileWatch;
  if (config === false) return (s.watchedAssets = null);
  const root = realDir(assetRoot({ gameFolder: s.gameFolder ?? null, dir: s.dir }));
  const dir = realDir(s.dir);
  const cache = join(dir, ...IMPORT_CACHE_SEGMENTS);
  try {
    mkdirSync(cache, { recursive: true });
  } catch {
    // A read-only project: nothing is imported into it either.
  }
  const skipped = new Set([realDir(s.thirdlightDir), join(dir, 'cache', 'records'), join(dir, 'sources')]);
  const watched = new WatchedAssets({
    roots: isWithin(root, cache) ? [root] : [root, realDir(cache)],
    skip: (d) => skipped.has(d) || basename(d) === '.git',
    ...(config?.maxEventsPerTurn !== undefined ? { maxEventsPerTurn: config.maxEventsPerTurn } : {}),
  });
  // An earlier session of the project (closed or opened again) gives its watch up.
  core.watches ??= new Map();
  core.watches.get(s.projectId)?.watched.close();
  core.watches.set(s.projectId, { session: s, watched });
  s.watchedAssets = watched;
  return watched;
}

/** Stop watching one project's folders, or every project's (the service closing). */
export function closeWatches(core: Core, projectId?: string): void {
  for (const [id, w] of core.watches ?? []) {
    if (projectId !== undefined && id !== projectId) continue;
    w.watched.close();
    w.session.watchedAssets = undefined;
    core.watches!.delete(id);
  }
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
  | {
      ok: true;
      entries: AssetFileEntry[];
      sidecarProblems: string[];
      /** What was looked at: every asset's file, or only the ones the folder watch saw change (and why not, when all). */
      checked: { scope: 'all' | 'changed'; visited: number; reason?: string };
    }
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
   * The walk behind `assetFiles`: every asset's file against the catalog, one
   * record at a time, then the sidecars written where they are missing or no
   * longer say what the catalog does. A moved file shows as `missing`
   * (`findMovedAssets` finds it by its sidecar), a changed one as `changed`
   * (the backend imports it again). `only`: just these assets (what the
   * folder watch saw change); a walk over all of them makes the watch's index
   * again.
   */
  function assetFilesWalk(s: ProjectSession, only?: ReadonlySet<string>): { records: readonly RecordLike[]; visit: (r: RecordLike) => void; finish: (reason?: string) => AssetFilesResult } {
    const ctx = contentCtx(s);
    const content = s.content as ContentCatalogV4 | null;
    const all = (content?.assets ?? []) as unknown as RecordLike[];
    const records = only === undefined ? all : [...only].map((id) => assetRecordOf(all, id)).filter((r): r is RecordLike => r !== undefined);
    let animatedIds: Set<string> | null = null;
    const animated = (assetId: string): boolean => {
      if (animatedIds === null) {
        animatedIds = new Set<string>();
        for (const sc of s.v4?.scenes.values() ?? []) {
          for (const e of sc.entities) {
            const anim = (e.components as { modelAnimation?: { assetId?: unknown } }).modelAnimation;
            if (anim !== undefined && typeof anim.assetId === 'string') animatedIds.add(anim.assetId);
          }
        }
      }
      return animatedIds.has(assetId);
    };
    const entries: AssetFileEntry[] = [];
    const sidecarProblems: string[] = [];
    const lost: RecordLike[] = [];
    const root = assetRoot(ctx);
    const stamps = stampsOfSession(s);
    const watched = s.watchedAssets ?? null;
    const realRoot = watched !== null ? realDir(root) : root;
    const realProject = watched !== null ? realDir(s.dir) : s.dir;
    if (only === undefined) watched?.beginFull();
    const seen = new Set<string>();
    const visit = (r: RecordLike): void => {
      const v = currentVersionOf(r);
      if (v === undefined) return;
      const file = fileOfRecord(r);
      const facts = fileFactsOfVersion(v);
      let status: AssetFileEntry['status'] = 'stored';
      let found: string | null = null;
      let real: string | null = null;
      let size = 0;
      if (file !== null) {
        const res = resolveProjectFile(ctx, file);
        if (!res.ok) status = res.missing === true ? 'missing' : 'unreadable';
        else {
          real = res.real;
          size = res.size;
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
      if (animated(r.assetId)) entry.animated = true;
      entries.push(entry);
      watched?.noteVisit(
        r.assetId,
        file,
        found !== null ? { digest: found, size } : null,
        {
          logical: file === null ? null : join(realRoot, ...file.split('/')),
          real,
          imported: v.convertedFrom !== undefined ? importedArtifactFile(realProject, importKeyOfConverted(v.convertedFrom), v.sourceDigest) : null,
        },
      );
      // The file is there but its sidecar (the record's file) is not: it is written again.
      if (file !== null && status !== 'missing' && status !== 'unreadable' && !existsSync(join(root, ...sidecarPath(file).split('/')))) lost.push(r);
    };
    const finish = (reason?: string): AssetFilesResult => {
      sidecarProblems.push(...restoreSidecars(core, s, lost));
      if (only === undefined) {
        // Game-folder files no asset uses any more drop out of the stamps; the project's own stores (blobs, import cache) stay.
        const dirReal = realDir(s.dir);
        const own = [join(dirReal, 'cache') + sep, join(dirReal, 'sources') + sep];
        stamps.retainOnly(seen, (p) => !own.some((o) => p.startsWith(o)));
        watched?.endFull(all);
      }
      stamps.save();
      return { ok: true, entries, sidecarProblems, checked: { scope: only === undefined ? 'all' : 'changed', visited: entries.length, ...(reason !== undefined ? { reason } : {}) } };
    };
    return { records, visit, finish };
  }

  /** Every asset's file against the catalog, in one go (see `assetFilesWalk`). */
  function assetFiles(projectId: string): AssetFilesResult {
    return run(projectId, (s): AssetFilesResult => {
      const walk = assetFilesWalk(s);
      for (const r of walk.records) walk.visit(r);
      return walk.finish();
    }) as AssetFilesResult;
  }

  /**
   * The same walk, giving the event loop back every `FILE_CHECK_SLICE_MS`: a
   * check that hashes a freshly copied game folder takes seconds, and a Play
   * or a command asked for meanwhile is answered between slices instead of
   * after it (a Play joins the check that is running). The project closing
   * or reopening between slices ends the walk with that error.
   *
   * `changedOnly` (the check before Play): only the assets whose files the
   * folder watch saw change since the last full walk, when it can be relied
   * on; otherwise every asset (that walk makes the watch reliable again).
   */
  async function assetFilesYielding(projectId: string, options: { changedOnly?: boolean } = {}): Promise<AssetFilesResult> {
    const session = (): ProjectSession | { ok: false; error: CommandError } => withOpenSession<ProjectSession | { ok: false; error: CommandError }>(projectId, (s) => s, (error) => ({ ok: false, error }));
    const s = session();
    if ('ok' in s) return s as AssetFilesResult;
    const watched = watchedOf(core, s);
    // A full walk counts for the watch only if the watch was running before it started.
    if (watched !== null && !watched.watch.active) await watched.watch.ready;
    // Events already queued by the kernel (a file saved just before this) are read before the watch is asked.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The project opened again meanwhile: start over with its new session.
    const again = session();
    if (again !== s) return 'ok' in again ? (again as AssetFilesResult) : assetFilesYielding(projectId, options);
    let only: ReadonlySet<string> | undefined;
    let reason: string | undefined;
    if (options.changedOnly === true) {
      const list = ((s.content as ContentCatalogV4 | null)?.assets ?? []) as unknown as RecordLike[];
      const pending = watched?.pending(list, (r) => {
        const rec = r as RecordLike;
        const v = currentVersionOf(rec);
        return v === undefined ? null : { assetId: rec.assetId, file: fileOfRecord(rec), digest: fileFactsOfVersion(v).digest };
      }) ?? { all: true as const, reason: 'watching is off' };
      if (pending.all) reason = pending.reason;
      else only = pending.assetIds;
    }
    const walk = assetFilesWalk(s, only);
    let sliceStart = performance.now();
    for (const r of walk.records) {
      if (performance.now() - sliceStart >= FILE_CHECK_SLICE_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const now = session();
        if (now !== s) return ('ok' in now ? now : { ok: false, error: projectUnavailable('workspace_closed', null, []) }) as AssetFilesResult;
        sliceStart = performance.now();
      }
      walk.visit(r);
    }
    return deepFreeze(walk.finish(reason));
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
    fileStampStats: (projectId: string): { files: number; hashes: number; watch: WatchedAssetsStats | null } | null =>
      withOpenSession(projectId, (s) => ({ files: stampsOfSession(s).size, hashes: stampsOfSession(s).hashes, watch: s.watchedAssets?.stats() ?? null }), () => null),
    /** The single acknowledged project read (scenes + content). */
    readCapturedV3: (projectId: string): CapturedV3ReadResult => run(projectId, (s) => readCapturedV3(contentCtx(s))),
    assetFiles,
    assetFilesYielding,
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
