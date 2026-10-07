/**
 * Folder import on the backend: before an `importAssets` command runs, every
 * new supported file of its folder is inspected where it is (converted first
 * when it is an FBX, or a PNG/JPEG the request encodes to KTX2), and the
 * facts are handed to the workspace, which gives each file its id at the
 * command. The command itself is the only write of project state; the files
 * stay where the user put them.
 *
 * What the import skipped (files already imported), what no importer takes
 * and what an importer refused is reported next to the command's result,
 * never a reason to refuse the rest.
 */
import { MESH_LOD_RATIOS_DEFAULT } from '@thirdlight/project-model/limits';
import { assetNameOfFile, type PreparedImportFile, type WorkspaceService } from '@thirdlight/workspace';

import type { AssetFileCheck } from './asset-files';
import { EXTRACT_TEXTURES_ON_NEW_IMPORT, type TextureExtraction, type TextureExtractionReport } from './model-textures';
import type { Ktx2Mode } from './texture-encode';

/** What a folder import did besides the assets it added. */
export interface FolderImportReport {
  folder: string;
  /** Files prepared for the command (the command's change lists the assets). */
  prepared: number;
  /** Files the catalog already imports (not imported again). */
  skipped: { path: string; assetId: string }[];
  /** Files no importer takes. */
  unsupported: { path: string; reason: string }[];
  /** Supported files an importer refused (why). */
  rejected: { path: string; code: string; message: string }[];
  /** Models converted at import: each model's file, what became of its images, and its generated levels (the "generate LODs" setting). */
  extracted?: { path: string; images: TextureExtractionReport['images']; lods?: TextureExtractionReport['lods'] }[];
}

export interface FolderImportDeps {
  service: WorkspaceService;
  assetFiles: AssetFileCheck;
  /** New models' images become texture assets ("extract textures": the request's `extractTextures`, else the default for new imports). */
  textures?: TextureExtraction;
  now: () => number;
}

function utcSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createFolderImport(deps: FolderImportDeps) {
  const { service } = deps;

  /** Inspect a folder's new files and hand them to the workspace for the coming `importAssets`. */
  async function prepare(projectId: string, args: unknown): Promise<{ ok: true; report: FolderImportReport } | { ok: false; code: string; message: string; path?: string }> {
    const a = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const folder = a['folder'];
    // Malformed args are the command's to refuse (field errors with their paths).
    if (typeof folder !== 'string') return { ok: true, report: { folder: '', prepared: 0, skipped: [], unsupported: [], rejected: [] } };
    const ktx2 = a['ktx2'] === 'color' || a['ktx2'] === 'normal' || a['ktx2'] === 'data' ? (a['ktx2'] as Ktx2Mode) : undefined;
    const extract = typeof a['extractTextures'] === 'boolean' ? a['extractTextures'] : EXTRACT_TEXTURES_ON_NEW_IMPORT;
    // Generated levels only when asked: a new model is drawn as authored by default.
    const lods = a['generateLods'] === true ? MESH_LOD_RATIOS_DEFAULT : null;
    const scanned = service.scanAssetFolder(projectId, folder);
    if (!scanned.ok) return { ok: false, code: scanned.error.code, message: scanned.error.message ?? scanned.error.code, path: '/args/folder' };
    const scan = scanned.scan;
    const report: FolderImportReport = { folder, prepared: 0, skipped: scan.known, unsupported: scan.unsupported, rejected: [] };
    const files: PreparedImportFile[] = [];
    const importedAt = utcSecond(deps.now());
    // Texture files a model's extraction already prepared are not prepared again as the folder's own.
    const preparedPaths = new Set<string>();
    for (const f of scan.files) {
      if (preparedPaths.has(f.path.toLowerCase())) continue;
      if ((extract || lods !== null) && f.kind === 'model' && /\.glb$/i.test(f.path) && deps.textures !== undefined) {
        const done = await extractModel(projectId, f, deps.textures, { extract, lods }, importedAt, files, preparedPaths, report);
        if (done) continue;
      }
      const r = await deps.assetFiles.importFile(projectId, f.path, f.kind, ktx2 !== undefined ? { ktx2 } : {});
      if ('code' in r) {
        report.rejected.push({ path: f.path, code: r.code, message: r.message });
        continue;
      }
      files.push({
        path: f.path,
        idHint: f.sidecar?.id ?? null,
        labels: f.sidecar?.labels ?? [],
        item: { kind: r.kind, displayName: assetNameOfFile(f.path), importedAt, ...(r.args as Omit<PreparedImportFile['item'], 'kind' | 'displayName' | 'importedAt'>) },
      });
    }
    const kept = service.prepareAssetImport(projectId, folder, files);
    if (!kept.ok) return { ok: false, code: kept.error.code, message: kept.error.message ?? kept.error.code };
    report.prepared = files.length;
    return { ok: true, report };
  }

  /**
   * A new model file converted: its images extracted (its texture files,
   * written into `<model>_textures/` inside the folder, and the model itself
   * go into the same `importAssets`; the model names its textures by file,
   * and the command gives them their ids) and/or its levels generated. False:
   * nothing was converted (the file is imported as it is).
   */
  async function extractModel(
    projectId: string,
    f: { path: string; sidecar: { id: string; labels: string[] } | null },
    textures: TextureExtraction,
    settings: { extract: boolean; lods: readonly number[] | null },
    importedAt: string,
    files: PreparedImportFile[],
    preparedPaths: Set<string>,
    report: FolderImportReport,
  ): Promise<boolean> {
    const src = service.conversionSource(projectId, f.path);
    if (!src.ok) return false;
    const glb = textures.readModelFile(projectId, f.path, src.digest);
    if (glb === null) return false;
    const slash = f.path.lastIndexOf('/');
    const planned = await textures.plan(projectId, { glb, original: { sourceDigest: src.digest, sourceByteLength: src.byteLength, sourcePath: f.path }, folder: f.path.slice(0, Math.max(0, slash)), stem: f.path.slice(slash + 1).replace(/\.[^.]+$/, ''), ...settings });
    if (!planned.ok || planned.plan.model === null) return false;
    const p = planned.plan;
    for (const t of p.files) {
      // A texture file this or another model of the import already prepared is that one.
      if (preparedPaths.has(t.path.toLowerCase())) continue;
      preparedPaths.add(t.path.toLowerCase());
      files.push(t);
    }
    const m = p.model!;
    files.push({
      path: f.path,
      idHint: f.sidecar?.id ?? null,
      labels: f.sidecar?.labels ?? [],
      item: { kind: 'model', displayName: assetNameOfFile(f.path), importedAt, convertedFrom: m.convertedFrom, sourceDigest: m.sourceDigest, sourceByteLength: m.sourceByteLength, importRecipe: m.importRecipe, metrics: m.metrics, ...(settings.extract ? { extractTextures: true } : {}) } as PreparedImportFile['item'],
      texturePaths: p.imagePaths,
    });
    (report.extracted ??= []).push({ path: f.path, images: p.report.images, ...(p.report.lods !== undefined ? { lods: p.report.lods } : {}) });
    return true;
  }

  return { prepare };
}

export type FolderImport = ReturnType<typeof createFolderImport>;
