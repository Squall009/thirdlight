/**
 * A model's distance-field bricks are made when it is imported: after a
 * change that adds or re-imports model files, each new file's bricks are
 * made and kept in the project's import cache (`ensureModelBricks`), one
 * file at a time off the command's path, so Play and the export find them
 * ready. A failure is only a log line: the build makes them itself, or
 * says why in Problems.
 */
import { ensureModelBricks } from '@thirdlight/exporter';
import type { WorkspaceService } from '@thirdlight/workspace';

type RecordLike = { assetId?: unknown; kind?: unknown; currentVersion?: unknown; versions?: readonly { version?: unknown; sourceDigest?: unknown }[] };

/** The model files a change added or re-imported (asset, version, file digest). */
export function importedModelFiles(change: unknown): { assetId: string; version: number; sourceDigest: string }[] {
  if (typeof change !== 'object' || change === null) return [];
  const c = change as { type?: unknown; next?: unknown; added?: unknown };
  const records = (c.type === 'publishAsset' ? [c.next] : c.type === 'importAssets' && Array.isArray(c.added) ? c.added : []) as RecordLike[];
  const out: { assetId: string; version: number; sourceDigest: string }[] = [];
  for (const r of records) {
    if (typeof r !== 'object' || r === null || r.kind !== 'model' || typeof r.assetId !== 'string') continue;
    const v = r.versions?.find((x) => x.version === r.currentVersion);
    if (typeof v?.version === 'number' && typeof v.sourceDigest === 'string') out.push({ assetId: r.assetId, version: v.version, sourceDigest: v.sourceDigest });
  }
  return out;
}

export interface ModelBrickImports {
  changed(projectId: string, change: unknown): void;
  /** Resolves when every file asked for so far is done (tests). */
  idle(): Promise<void>;
  dispose(): void;
}

export function createModelBrickImports(deps: { service: WorkspaceService; log?: (line: string) => void }): ModelBrickImports {
  const queue: { projectId: string; assetId: string; version: number; sourceDigest: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiters: (() => void)[] = [];
  let disposed = false;
  const next = (): void => {
    timer = null;
    const job = queue.shift();
    if (job === undefined || disposed) {
      for (const w of waiters.splice(0)) w();
      return;
    }
    try {
      const made = ensureModelBricks(deps.service, job.projectId, job.sourceDigest, () => {
        const r = deps.service.readBlob(job.projectId, { assetId: job.assetId, version: job.version });
        return r.ok ? r.bytes : null;
      });
      if (!made.ok) deps.log?.(`model bricks: ${job.assetId}: ${made.message}`);
    } catch (e) {
      deps.log?.(`model bricks: ${job.assetId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // One file per turn of the event loop: a folder of models never holds up the commands behind it.
    timer = setTimeout(next, 0);
  };
  return {
    changed(projectId, change) {
      const files = importedModelFiles(change);
      if (files.length === 0 || disposed) return;
      for (const f of files) queue.push({ projectId, ...f });
      timer ??= setTimeout(next, 0);
    },
    idle() {
      return timer === null && queue.length === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.length = 0;
      for (const w of waiters.splice(0)) w();
      waiters = [];
    },
  };
}
