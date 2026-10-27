/**
 * The content side of the backend: imports (FBX conversion, KTX2 encoding,
 * extracted model textures, folder imports), the game folder's file check,
 * texture slot arrays and decal pages, engine packs, and the content
 * transport (bounded uploads, jobs, content queries, the authenticated
 * asset-byte read). Every write and read goes through the workspace service;
 * the transport does no filesystem work itself.
 */
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { SessionError } from '@thirdlight/protocol';
import type { WorkspaceService } from '@thirdlight/workspace';

import { createAssetFileCheck, reimportProblemLines } from './asset-files';
import type { BackendConfig } from './config';
import { ContentRoutes, type createAssetInspector } from './content';
import { createDecalPageAssembler } from './decal-page-assembly';
import { createFbxConverter } from './fbx';
import { createFolderImport } from './folder-import';
import { createHeightAlphaChecks } from './height-alpha';
import { sendError, sendJson } from './http';
import { createTextureExtraction } from './model-textures';
import { createPackInstaller } from './packs';
import type { RecordProblem } from './problems';
import { createInlineTextureEncoder, createWorkerTextureEncoder } from './texture-encode';
import { createTextureSlotAssembler, type TextureSlotAssembler } from './texture-slots';
import { createThumbnailCache } from './thumbnails';
import type { OriginDoc } from './util';

/** The KTX2 encoder's worker script, when this runs as the built bundle. */
const KTX2_WORKER: URL | null = (() => {
  const url = new URL('./ktx2-worker.mjs', import.meta.url);
  return url.protocol === 'file:' && existsSync(decodeURIComponent(url.pathname)) ? url : null;
})();

export interface ContentServicesDeps {
  readonly config: BackendConfig;
  readonly service: WorkspaceService;
  readonly assetInspector: ReturnType<typeof createAssetInspector>;
  readonly nowMs: () => number;
  readonly logStartup: (message: string) => void;
  readonly recordProblem: RecordProblem;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  /** A command the content side ran was applied (the file check's, a pack's). */
  readonly onApplied: (projectId: string, requestId: string, revision: number, origin: OriginDoc | null, change: unknown, sceneId?: string) => void;
  /** A full file check of the project finished. */
  readonly onChecked: (projectId: string) => void;
}

export function createContentServices(deps: ContentServicesDeps) {
  const { config, service, assetInspector, nowMs, recordProblem } = deps;
  const fbx = createFbxConverter({ blender: config.blenderPath ?? 'blender', workRoot: join(config.dataRoot, '.convert') });
  // KTX2 encoding on import — a worker thread next to the deployment bundle
  // (dist/backend/ktx2-worker.mjs), in this thread when run from source (tests).
  const textureEncoder = KTX2_WORKER !== null ? createWorkerTextureEncoder(KTX2_WORKER) : createInlineTextureEncoder();
  // Per-layer texture slots' arrays (Play, the export and the editor's views), cached in the import cache.
  // Decal pages ride on the same port: the builds that assemble slot arrays make the pages too.
  const decalPages = createDecalPageAssembler({ service, encoder: textureEncoder, now: nowMs });
  // Height in alpha: the albedos layered surfaces blend by height are checked, and an array gives a layer without one a brightness height.
  const heightChecks = createHeightAlphaChecks({ service, encoder: textureEncoder });
  const textureSlots: TextureSlotAssembler = { ...createTextureSlotAssembler({ service, encoder: textureEncoder, now: nowMs, heights: heightChecks, refused: (projectId, code, message) => recordProblem(projectId, 'import', code, message) }), decalPages: decalPages.assemble };
  // A model's "extract textures" import setting: its images become texture assets.
  const textures = createTextureExtraction({ service, inspector: assetInspector, textureEncoder, now: nowMs });
  // The game folder is the truth for assets: moved and changed files, the import cache.
  const assetFiles = createAssetFileCheck({
    service,
    inspector: assetInspector,
    fbx,
    textureEncoder,
    textures,
    now: nowMs,
    onApplied: (projectId, r) => deps.onApplied(projectId, r.requestId, r.revision, { kind: 'admin', clientId: 'file-check' }, r.change, (r as { sceneId?: string }).sceneId),
    onChecked: deps.onChecked,
    onReimported: (projectId, reimported) => {
      for (const line of reimportProblemLines(reimported)) recordProblem(projectId, 'import', 'asset_reimported', line);
    },
  });
  // Engine content packs (the Basic Kit) added to a project as ordinary items, one command at a time.
  const packs = createPackInstaller({ service, inspector: assetInspector, engineRoot: config.engineRoot, now: nowMs, onApplied: (projectId, r, origin) => deps.onApplied(projectId, r.requestId, r.revision, origin, r.change, (r as { sceneId?: string }).sceneId) });
  // A folder's files are inspected before its importAssets command.
  const folderImport = createFolderImport({ service, assetFiles, textures, now: nowMs });
  const contentRoutes = new ContentRoutes({
    service,
    now: nowMs,
    sendJson,
    sendError,
    requireAuth: deps.requireAuth,
    log: deps.logStartup,
    onJobFailed: (projectId, kind, code, message) => recordProblem(projectId, 'import', code, `Import ${kind} failed: ${message}`),
    fbx,
    textureEncoder,
    textureSlots,
    assetFiles,
    thumbnails: createThumbnailCache((projectId) => service.importCacheDir(projectId)),
  });
  return { textureEncoder, decalPages, heightChecks, textureSlots, textures, assetFiles, packs, folderImport, contentRoutes };
}
