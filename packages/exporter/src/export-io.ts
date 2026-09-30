/**
 * The shared export output-target resolution and atomic
 * publication (export.md "Output location"/"Replacement semantics", steps 3
 * and 6): the one implementation of the source/derived separation check and
 * the temp-directory + atomic-replacement discipline.
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

/**
 * Step 6 — the output is written into a fresh temp directory under
 * `<exportRoot>` as it is produced (files are copied in one at a time, never
 * held together), then the target tree is replaced atomically. A failed
 * export removes the temp directory; the previous output stays byte-untouched.
 */
export interface ExportStaging {
  /** Write one whole file. */
  write(name: string, bytes: Uint8Array): void;
  /** Write one file from its chunks as they arrive; a throwing source fails the export (the caller aborts). */
  writeChunks(name: string, chunks: AsyncIterable<Uint8Array>, onChunk?: (chunk: Uint8Array) => void): Promise<number>;
  /** Every file written so far and its size. */
  readonly files: Readonly<Record<string, number>>;
  /** Replace `<exportRoot>/<dirName>` with the written tree (the previous one is restored on failure). */
  publish(dirName: string): { ok: true } | { ok: false; error: ExportError };
  /** Remove the temp directory (a failed export). */
  abort(): void;
}

export function openStaging(fs: ExportFs, exportRootReal: string): { ok: true; staging: ExportStaging } | { ok: false; error: ExportError } {
  let tempDir: string;
  try {
    tempDir = fs.mkdtemp(fs.join(exportRootReal, '.export-tmp-'));
  } catch (e) {
    return { ok: false, error: failError('export_output_not_writable', 'unavailable', `cannot create the temp export dir: ${e instanceof Error ? e.message : String(e)}`) };
  }
  const dirs = new Set<string>();
  const files: Record<string, number> = {};
  const pathOf = (name: string): string => {
    const parts = name.split('/');
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join('/');
      if (!dirs.has(dir)) {
        fs.mkdir(fs.join(tempDir, dir));
        dirs.add(dir);
      }
    }
    return fs.join(tempDir, name);
  };
  let done = false;
  const abort = (): void => {
    if (done) return;
    done = true;
    try {
      if (fs.exists(tempDir)) fs.rm(tempDir);
    } catch {
      // temp cleanup best-effort
    }
  };
  return {
    ok: true,
    staging: {
      files,
      write(name, bytes) {
        fs.write(pathOf(name), bytes);
        files[name] = bytes.length;
      },
      async writeChunks(name, chunks, onChunk) {
        const out = fs.openWrite(pathOf(name));
        let n = 0;
        try {
          for await (const chunk of chunks) {
            out.write(chunk);
            onChunk?.(chunk);
            n += chunk.length;
          }
        } finally {
          out.close();
        }
        files[name] = n;
        return n;
      },
      publish(dirName) {
        try {
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
                // The previous tree cannot be restored — report the failure; the operator must re-export.
              }
            }
            throw e;
          }
          done = true;
          if (backedUp) fs.rm(backup);
          return { ok: true };
        } catch (e) {
          abort();
          return { ok: false, error: failError('export_output_not_writable', 'unavailable', `the export output writes failed: ${e instanceof Error ? e.message : String(e)}`) };
        }
      },
      abort,
    },
  };
}
