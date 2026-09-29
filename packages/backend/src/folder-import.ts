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
import { assetNameOfFile, type PreparedImportFile, type WorkspaceService } from '@thirdlight/workspace';

import type { AssetFileCheck } from './asset-files';
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
}

export interface FolderImportDeps {
  service: WorkspaceService;
  assetFiles: AssetFileCheck;
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
    const scanned = service.scanAssetFolder(projectId, folder);
    if (!scanned.ok) return { ok: false, code: scanned.error.code, message: scanned.error.message ?? scanned.error.code, path: '/args/folder' };
    const scan = scanned.scan;
    const report: FolderImportReport = { folder, prepared: 0, skipped: scan.known, unsupported: scan.unsupported, rejected: [] };
    const files: PreparedImportFile[] = [];
    const importedAt = utcSecond(deps.now());
    for (const f of scan.files) {
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

  return { prepare };
}

export type FolderImport = ReturnType<typeof createFolderImport>;
