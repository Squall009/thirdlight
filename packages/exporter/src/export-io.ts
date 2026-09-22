/**
 * Packet 36 — the shared export output-target resolution and atomic
 * publication (export.md §3 "Output location"/"Replacement semantics",
 * §4 step 3/step 6). Extracted so the M1 and M2 pipelines share exactly one
 * implementation of the source/derived separation check and the
 * temp-directory + atomic-replacement discipline.
 *
 * Pure injected-IO: no Node builtins (the `ExportFs` facade is injected).
 */
import { clip, type ExportError, type ExportErrorCode, type ExportErrorClass } from './errors';
import type { ExportFs } from './export-types';

export interface ExportTargetContext {
  projectId: string;
  fs: ExportFs;
  exportRoot: string;
  repoRoot: string;
  authoringRoot: string;
}

export interface ExportTarget {
  /** The resolved `<exportRoot>/<projectId>@r<revision>`. */
  target: string;
  /** The resolved `<exportRoot>` (the temp-directory parent). */
  exportRootReal: string;
  dirName: string;
}

function failError(code: ExportErrorCode, cls: ExportErrorClass, message: string, detail?: ExportError['detail']): ExportError {
  return { code, cls, message: clip(message), ...(detail !== undefined ? { detail } : {}) };
}

/**
 * Step 3 — the output target is under `<exportRoot>` and outside the engine
 * repository tree and every project's authoring tree (source/derived
 * separation).
 */
export function resolveExportTarget(ctx: ExportTargetContext, revision: number): ExportTarget | { error: ExportError } {
  if (!ctx.fs.isDirectory(ctx.exportRoot)) {
    return { error: failError('export_output_path_invalid', 'validation', 'the configured exportRoot is not a directory') };
  }
  const dirName = `${ctx.projectId}@r${revision}`;
  if (!/^[A-Za-z0-9_-]+@r\d+$/.test(dirName)) {
    return { error: failError('export_output_path_invalid', 'validation', 'the output directory name is not <projectId>@r<revision>') };
  }
  let exportRootReal: string;
  let repoReal: string;
  let authoringReal: string;
  try {
    exportRootReal = ctx.fs.realpath(ctx.exportRoot);
    repoReal = ctx.fs.realpath(ctx.repoRoot);
    authoringReal = ctx.fs.realpath(ctx.authoringRoot);
  } catch (e) {
    return {
      error: failError('export_output_path_invalid', 'validation', `cannot resolve the export paths: ${e instanceof Error ? e.message : String(e)}`),
    };
  }
  const target = ctx.fs.join(exportRootReal, dirName);
  if (target.startsWith(repoReal + '/') || target === repoReal) {
    return { error: failError('export_output_path_invalid', 'validation', 'the export target sits inside the engine repository tree') };
  }
  if (target.startsWith(authoringReal + '/') || target === authoringReal) {
    return { error: failError('export_output_path_invalid', 'validation', 'the export target sits inside a project authoring tree') };
  }
  return { target, exportRootReal, dirName };
}

export interface TreeFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Step 6 — write the files into a fresh temp directory under `<exportRoot>`
 * and atomically replace the target tree. A failed write removes the temp
 * directory and restores the previous tree; a failed export therefore leaves
 * the previous output byte-untouched (export.md §3/§4).
 */
export type PublishTreeResult = { ok: true; files: Record<string, number> } | { ok: false; error: ExportError };

export function publishTree(fs: ExportFs, exportRootReal: string, dirName: string, files: readonly TreeFile[]): PublishTreeResult {
  let tempDir = '';
  try {
    tempDir = fs.mkdtemp(fs.join(exportRootReal, '.export-tmp-'));
  } catch (e) {
    return { ok: false, error: failError('export_output_not_writable', 'unavailable', `cannot create the temp export dir: ${e instanceof Error ? e.message : String(e)}`) };
  }
  try {
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.name.split('/');
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join('/');
        if (!dirs.has(dir)) {
          fs.mkdir(fs.join(tempDir, dir));
          dirs.add(dir);
        }
      }
      fs.write(fs.join(tempDir, f.name), f.bytes);
    }
    const target = fs.join(exportRootReal, dirName);
    // Atomic replacement: back up the previous tree, rename the temp tree
    // into place, remove the backup. A failure restores the previous tree.
    const backup = fs.join(exportRootReal, `.${dirName}.replacing`);
    if (fs.exists(backup)) fs.rm(backup);
    let backedUp = false;
    if (fs.exists(target)) {
      fs.rename(target, backup);
      backedUp = true;
    }
    try {
      fs.rename(tempDir, target);
    } catch (e) {
      if (backedUp) {
        try {
          fs.rename(backup, target);
        } catch {
          // The previous tree cannot be restored — report the failure; the
          // operator must re-export.
        }
      }
      throw e;
    }
    if (backedUp) fs.rm(backup);
  } catch (e) {
    try {
      if (tempDir !== '' && fs.exists(tempDir)) fs.rm(tempDir);
    } catch {
      // temp cleanup best-effort
    }
    return { ok: false, error: failError('export_output_not_writable', 'unavailable', `the export output writes failed: ${e instanceof Error ? e.message : String(e)}`) };
  }
  const sizes: Record<string, number> = {};
  for (const f of files) sizes[f.name] = f.bytes.length;
  return { ok: true, files: sizes };
}
