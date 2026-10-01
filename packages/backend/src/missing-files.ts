/**
 * The project's missing asset files, as Problems shows them: listed when the
 * project is first read (the open) and again after each file check and each
 * change to the asset records, each with its path, its asset and what uses
 * it. The Problems log gets one line whenever the list changes (how many,
 * the first few), so a moved file is reported at once, not discovered by a
 * Play refusing it.
 *
 * The list itself is read in pages (`page`); a project with thousands of
 * missing files never answers with all of them at once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MissingAssetFile } from '@thirdlight/project-model';
import { CONTENT_ASSETS_LIMIT_DEFAULT, CONTENT_ASSETS_LIMIT_MAX, sessionError, type SessionError } from '@thirdlight/protocol';
import type { WorkspaceService } from '@thirdlight/workspace';

export interface MissingFilesDeps {
  readonly service: WorkspaceService;
  readonly recordProblem: (projectId: string, code: string, message: string) => void;
  readonly logStartup: (message: string) => void;
  readonly closed: () => boolean;
}

export interface MissingFilesPage {
  readonly total: number;
  readonly offset: number;
  readonly files: readonly MissingAssetFile[];
}

/** How a use reads in a Problems line. */
function userLabel(u: MissingAssetFile['usedBy'][number]): string {
  return u.kind === 'project' ? u.id : `${u.kind} ${u.id}`;
}

/** The Problems line for a new list (the count and the first files with their uses). */
export function missingFilesLine(files: readonly MissingAssetFile[]): string {
  const first = files.slice(0, 3).map((f) => `${f.path} (${f.assetId}${f.usedBy.length > 0 ? `, used by ${f.usedBy.slice(0, 2).map(userLabel).join(', ')}${f.usedBy.length > 2 ? ', …' : ''}` : ''})`);
  return `${files.length} asset file${files.length === 1 ? ' is' : 's are'} missing from the game folder: ${first.join('; ')}${files.length > 3 ? '; …' : ''}`;
}

export function createMissingFiles(deps: MissingFilesDeps) {
  const lists = new Map<string, readonly MissingAssetFile[]>();
  const keys = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Read the list again; a changed list goes to the Problems log. Null: the project cannot be read. */
  const refresh = (projectId: string): readonly MissingAssetFile[] | null => {
    if (deps.closed()) return null;
    const t = timers.get(projectId);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(projectId);
    }
    const r = deps.service.missingAssetFiles(projectId);
    if (!r.ok) return null;
    const key = r.files.map((f) => `${f.assetId}\u0000${f.path}`).join('\n');
    const before = keys.get(projectId);
    lists.set(projectId, r.files);
    keys.set(projectId, key);
    if (key !== (before ?? '')) {
      if (r.files.length > 0) deps.recordProblem(projectId, 'asset_files_missing', missingFilesLine(r.files));
      else deps.recordProblem(projectId, 'asset_files_found', 'No asset files are missing from the game folder any more.');
    }
    return r.files;
  };

  return {
    refresh,
    /** One page of the list (the last read; read now when it never was). */
    page: (projectId: string, offset: number, limit: number): MissingFilesPage | null => {
      const files = lists.get(projectId) ?? refresh(projectId);
      if (files === null) return null;
      return { total: files.length, offset, files: files.slice(offset, offset + limit) };
    },
    /** The first page (the problems query's). */
    firstPage: (projectId: string): MissingFilesPage | null => {
      const files = lists.get(projectId) ?? refresh(projectId);
      return files === null ? null : { total: files.length, offset: 0, files: files.slice(0, CONTENT_ASSETS_LIMIT_DEFAULT) };
    },
    /** After a change to the asset records (a move followed, an asset removed): read again soon, coalesced. */
    schedule: (projectId: string): void => {
      if (deps.closed() || timers.has(projectId) || !lists.has(projectId)) return;
      const t = setTimeout(() => {
        timers.delete(projectId);
        try {
          refresh(projectId);
        } catch (e) {
          deps.logStartup(`missing-file check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 25);
      (t as { unref?: () => void }).unref?.();
      timers.set(projectId, t);
    },
  };
}

export type MissingFiles = ReturnType<typeof createMissingFiles>;

/**
 * `GET /api/v1/projects/:projectId/problems/missing-files?offset=&limit=` —
 * one page of the missing asset files (the asset list's page bounds).
 */
export function makeMissingFilesRoute(o: {
  readonly missingFiles: MissingFiles;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
}) {
  return (req: IncomingMessage, res: ServerResponse, projectId: string, query: ReadonlyMap<string, string>): void => {
    if ((req.method ?? 'GET') !== 'GET') return o.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
    const auth = o.requireAuth(req, projectId, false);
    if (auth !== null) return o.sendError(res, auth);
    const num = (key: string, fallback: number, max: number): number | null => {
      const raw = query.get(key);
      if (raw === undefined) return fallback;
      const n = Number(raw);
      return /^\d+$/.test(raw) && n <= max ? n : null;
    };
    const offset = num('offset', 0, Number.MAX_SAFE_INTEGER);
    const limit = num('limit', CONTENT_ASSETS_LIMIT_DEFAULT, CONTENT_ASSETS_LIMIT_MAX);
    if (offset === null || limit === null || limit < 1) return o.sendError(res, sessionError('invalid_request', 'validation', `offset must be an integer >= 0 and limit 1-${CONTENT_ASSETS_LIMIT_MAX}`, { path: '/query' }));
    const page = o.missingFiles.page(projectId, offset, limit);
    if (page === null) return o.sendError(res, sessionError('project_not_found', 'not_found', 'the project cannot be read', { projectId }), 404);
    o.sendJson(res, 200, { ok: true, projectId, ...page });
  };
}
