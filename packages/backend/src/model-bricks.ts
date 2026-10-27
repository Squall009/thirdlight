/**
 * A model's distance-field bricks are made when it is imported: after a
 * change that adds or re-imports model files, each new file's bricks are
 * made and kept in the project's import cache (`ensureModelBricks`), one
 * file at a time off the command's path, so Play and the export find them
 * ready. A failure is only a log line: the build makes them itself, or
 * says why in Problems.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ensureModelBricks } from '@thirdlight/exporter';
import { parseAssetByteParams, sessionError, type SessionError } from '@thirdlight/protocol';
import type { CommandError, WorkspaceService } from '@thirdlight/workspace';

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

export interface ModelBricksRouteDeps {
  readonly service: WorkspaceService;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly toSession: (e: CommandError) => SessionError;
}

/**
 * `GET …/content/assets/:assetId/versions/:version/bricks`: a model
 * version's distance-field file (bricks and surfels), from the import cache,
 * made there first when missing (an import before bricks existed). The
 * editor's Scene view reads it for its static placements, so its live light
 * and its bakes hold the model as Play's and the export's do. 204: the
 * model has nothing to make a field of (no render triangles).
 */
export async function modelBricksRoute(d: ModelBricksRouteDeps, req: IncomingMessage, res: ServerResponse, projectIdRaw: string, rawAssetId: string, rawVersion: string): Promise<void> {
  const auth = d.requireAuth(req, projectIdRaw, false);
  if (auth !== null) return d.sendError(res, auth);
  const parsed = parseAssetByteParams(projectIdRaw, rawAssetId, rawVersion);
  if (!parsed.ok) return d.sendError(res, parsed.error);
  const { projectId, assetId, version } = parsed.params;
  const located = d.service.locateBlobs(projectId, [{ assetId, version }]);
  if (!located.ok) return d.sendError(res, d.toSession(located.error));
  const hit = located.results[0];
  if (hit === undefined || !hit.ok) return d.sendError(res, hit === undefined ? sessionError('asset_not_found', 'not_found', `no asset "${assetId}" version ${version}`) : d.toSession(hit.error));
  const made = ensureModelBricks(d.service, projectId, hit.file.digest, () => {
    const r = d.service.readBlob(projectId, { assetId, version });
    return r.ok ? r.bytes : null;
  });
  if (!made.ok) return d.sendError(res, sessionError('conversion_failed', 'validation', `the distance-field bricks of ${assetId}: ${made.message}`.slice(0, 256)));
  if (made.file === null) {
    res.statusCode = 204;
    res.end();
    return;
  }
  const opened = d.service.openBlobFile(projectId, made.file);
  if (!opened.ok) return d.sendError(res, sessionError('asset_source_changed', 'conflict', 'the bricks file changed while it was read; ask again'));
  const parts: Uint8Array[] = [];
  try {
    for await (const c of opened.blob.chunks()) parts.push(c);
  } catch {
    return d.sendError(res, sessionError('asset_source_changed', 'conflict', 'the bricks file changed while it was read; ask again'));
  }
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', String(made.file.byteLength));
  res.setHeader('x-thirdlight-digest', made.file.digest);
  // A version's file never changes, but the bricks made of it change with the engine's bricks format: asked again each load.
  res.setHeader('cache-control', 'private, no-cache');
  res.statusCode = 200;
  res.end(Buffer.concat(parts));
}
