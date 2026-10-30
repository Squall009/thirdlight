/**
 * The project and engine routes of the authoring API that are not commands,
 * sessions, Play or content: the project list and folder resolve, the
 * engine, templates and packs, a project's materials, history grouping, pack
 * installs, kit checks, exports and the problems log.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseStrictJsonBytes, sessionError, type SessionError } from '@thirdlight/protocol';
import { readMarker, type WorkspaceService } from '@thirdlight/workspace';

import type { BackendConfig } from './config';
import { comparePin, engineIdentity } from './engine';
import { isExportDirOf, listExports, zipDirectory } from './exports';
import { methodNotAllowed, readBody, sendError, sendJson } from './http';
import { listPacks, type createPackInstaller } from './packs';
import type { ProblemLog, ProjectChecks } from './problems';
import type { SessionRegistry } from './sessions';
import { listTemplates } from './templates';

type Query = Map<string, string>;

export interface ProjectRoutesDeps {
  readonly config: BackendConfig;
  readonly service: WorkspaceService;
  readonly sessions: SessionRegistry;
  readonly problems: ProblemLog;
  readonly checks: ProjectChecks;
  readonly packs: ReturnType<typeof createPackInstaller>;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  /** Whether the request carries any valid credential. */
  readonly authorized: (req: IncomingMessage) => boolean;
  /** The engine this process runs, with its manual's summary. */
  readonly engine: () => Promise<Record<string, unknown>>;
}

export function makeProjectRoutes(deps: ProjectRoutesDeps) {
  const { config, service, sessions, checks, requireAuth } = deps;
  const recordProblem = deps.problems.record;
  const pinWarned = new Set<string>();

  /** A GET any valid credential may call: false when it was answered (wrong method, no credential). */
  const openGet = (req: IncomingMessage, res: ServerResponse): boolean => {
    if ((req.method ?? 'GET') !== 'GET') {
      methodNotAllowed(res, 'GET');
      return false;
    }
    if (!deps.authorized(req)) {
      sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
      return false;
    }
    return true;
  };

  /** A project route of one method: false when it was answered (wrong method, not authorized). */
  const projectCall = (req: IncomingMessage, res: ServerResponse, projectId: string, method: 'GET' | 'POST'): boolean => {
    if ((req.method ?? 'GET') !== method) {
      methodNotAllowed(res, method);
      return false;
    }
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return false;
    }
    return true;
  };

  /** GET /api/v1/engine — the engine this backend runs (commit, build, start, whether dist/ is newer). */
  const engineRoute = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!openGet(req, res)) return;
    sendJson(res, 200, { ok: true, engine: await deps.engine() });
  };

  /** Whether the request's credential is the owner's (admin): it sees every project and server folder. */
  const isOwner = (req: IncomingMessage): boolean => requireAuth(req, '', true) === null;

  /**
   * GET /api/v1/projects — every project directory in the data root. A
   * project-scoped token sees its own project only, the way the session list
   * filters: the list names server folders, which only the owner may see.
   */
  const listProjectsRoute = (req: IncomingMessage, res: ServerResponse): void => {
    if (!openGet(req, res)) return;
    const owner = isOwner(req);
    const scan = service.scan();
    const engine = config.engineRoot !== undefined ? engineIdentity(config.engineRoot) : null;
    const projects = scan.entries
      .filter((e) => e.kind === 'project' && (owner || requireAuth(req, e.projectId, false) === null))
      .map((e) => {
        const session = sessions.sessionForProject(e.projectId);
        // Folder projects carry an engine pin in thirdlight.json; say when it differs.
        let pin: { matches: boolean; differences: string[] } | undefined;
        if (e.folder !== undefined && e.loadable === true) {
          const mk = readMarker(e.folder);
          if (mk.ok) {
            pin = comparePin(mk.marker.engine, engine);
            if (!pin.matches && !pinWarned.has(e.projectId)) {
              pinWarned.add(e.projectId);
              recordProblem(e.projectId, 'workspace', 'engine_pin_mismatch', `This project was pinned to a different engine: ${pin.differences.join('; ')}. Re-pin it once you have checked it (tools/project.mjs check --repin).`);
            }
          }
        }
        return {
          projectId: e.projectId,
          name: e.name ?? e.projectId,
          createdAt: e.createdAt ?? null,
          loadable: e.loadable === true,
          ...(e.code !== undefined ? { code: e.code } : {}),
          ...(e.folder !== undefined ? { folder: e.folder } : {}),
          ...(e.loadable !== true && e.note !== undefined ? { note: e.note } : {}),
          ...(pin !== undefined && !pin.matches ? { enginePin: pin } : {}),
          connected: session !== undefined && session.connected,
        };
      });
    sendJson(res, 200, { ok: true, projects, total: owner ? scan.total : projects.length, truncated: owner && scan.truncated });
  };

  /**
   * GET /api/v1/projects/resolve?path=<absolute server path> — which folder
   * project a path belongs to. A project-scoped token (an MCP harness started
   * in its game folder) learns only that a path is in its own project:
   * anything else is refused without the reason, so the token cannot probe
   * the server's folders.
   */
  const resolveRoute = (req: IncomingMessage, res: ServerResponse, query: Query): void => {
    if (!openGet(req, res)) return;
    const r = service.resolveFolder(query.get('path'));
    if (!isOwner(req) && !(r.ok && requireAuth(req, r.projectId, false) === null)) {
      sendError(res, sessionError('unauthorized', 'validation', 'this token covers one project only, and the path is not in it; resolve other folders with the owner token'));
      return;
    }
    if (r.ok) {
      sendJson(res, 200, { ok: true, projectId: r.projectId, folder: r.folder });
      return;
    }
    sendJson(res, 404, {
      ok: false,
      error: {
        ...sessionError('project_not_found', 'not_found', r.message.slice(0, 256)),
        reason: r.reason,
        ...(r.folder !== undefined ? { folder: r.folder } : {}),
        ...(r.markerProjectId !== undefined ? { markerProjectId: r.markerProjectId } : {}),
      },
    });
  };

  /** GET /api/v1/templates — the project templates on this engine. */
  const templatesRoute = (req: IncomingMessage, res: ServerResponse): void => {
    if (!openGet(req, res)) return;
    sendJson(res, 200, { ok: true, templates: config.engineRoot === undefined ? [] : listTemplates(config.engineRoot) });
  };

  /** GET /api/v1/packs — the content packs this engine ships. */
  const packsRoute = (req: IncomingMessage, res: ServerResponse): void => {
    if (!openGet(req, res)) return;
    sendJson(res, 200, { ok: true, packs: config.engineRoot === undefined ? [] : listPacks(config.engineRoot) });
  };

  /** GET /api/v1/projects/:projectId/content/materials — the materials and their graph problems (paged). */
  const materialsRoute = (req: IncomingMessage, res: ServerResponse, projectId: string, query: Query): void => {
    if (!projectCall(req, res, projectId, 'GET')) return;
    const rows = checks.materialRows(projectId);
    if (rows === null) {
      sendError(res, sessionError('project_not_found', 'not_found', `project ${projectId} cannot be read`), 404);
      return;
    }
    const limit = Math.min(128, Math.max(1, Number.parseInt(query.get('limit') ?? '50', 10) || 50));
    const offset = Math.max(0, Number.parseInt(query.get('offset') ?? '0', 10) || 0);
    const only = query.get('materialId') ?? null;
    const withProblems = query.get('problems') === '1';
    const picked = rows.filter((r) => (only === null || only === '' || r.materialId === only) && (!withProblems || r.problems.length > 0));
    sendJson(res, 200, { ok: true, projectId, total: picked.length, withProblems: rows.filter((r) => r.problems.length > 0).length, materials: picked.slice(offset, offset + limit) });
  };

  /**
   * POST /api/v1/projects/:projectId/history/group {requestIds, origin} — commands one user action ran made one
   * undo step. Only the caller's own: every entry must carry the origin the caller sends (as it sent it on those
   * commands), so a client cannot fold an agent's or another tab's commands into its step. Not a mutation (no
   * revision, no change event): it only changes how far one undo goes.
   */
  const historyGroupRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    if (!projectCall(req, res, projectId, 'POST')) return;
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    const ids = strict.ok ? (strict.value as { requestIds?: unknown } | null)?.requestIds : undefined;
    if (!Array.isArray(ids) || ids.length < 2 || !ids.every((x) => typeof x === 'string')) {
      sendError(res, sessionError('invalid_request', 'validation', 'requestIds is a list of at least 2 request ids', { path: '/requestIds' }));
      return;
    }
    const origin = strict.ok ? (strict.value as { origin?: { kind?: unknown; clientId?: unknown } } | null)?.origin : undefined;
    if (origin === undefined || origin === null || typeof origin !== 'object' || !['browser', 'mcp', 'admin'].includes(origin.kind as string) || typeof origin.clientId !== 'string' || origin.clientId.length === 0 || origin.clientId.length > 128) {
      sendError(res, sessionError('invalid_request', 'validation', 'origin is the {kind, clientId} the commands were sent with', { path: '/origin' }));
      return;
    }
    // Refused (409) when they are not the last entries applied (someone else's command ran between them), or
    // (403) when one of them is not the caller's.
    const grouped = service.groupRequests(projectId, ids as string[], { kind: origin.kind as 'browser' | 'mcp' | 'admin', clientId: origin.clientId });
    if (grouped === 'grouped') sendJson(res, 200, { ok: true, grouped: ids.length });
    else if (grouped === 'not_own') sendJson(res, 403, { ok: false, error: { code: 'not_own_commands', cls: 'validation', message: 'only the commands the caller sent can be grouped' } });
    else sendJson(res, 409, { ok: false, error: { code: 'not_grouped', cls: 'conflict', message: 'the commands are not the last entries of the history' } });
  };

  /** POST /api/v1/projects/:projectId/packs/:packId {origin?} — add an engine pack's items to the project. */
  const addPackRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, packId: string): Promise<void> => {
    if (!projectCall(req, res, projectId, 'POST')) return;
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    const o = strict.ok ? (strict.value as { origin?: { kind?: unknown; clientId?: unknown } } | null)?.origin : undefined;
    const origin = o !== undefined && (o.kind === 'browser' || o.kind === 'mcp') && typeof o.clientId === 'string' ? { kind: o.kind as 'browser' | 'mcp', clientId: o.clientId } : { kind: 'admin' as const, clientId: 'pack' };
    const r = await deps.packs.add(projectId, packId, origin);
    if (r.ok) sendJson(res, 200, r);
    else sendJson(res, r.status, { ok: false, error: { code: r.code, cls: r.status === 409 ? 'conflict' : 'validation', message: r.message }, ...(r.added !== undefined ? { added: r.added } : {}) });
  };

  /** GET /api/v1/projects/:projectId/kits/:kitId/check[?image=1] — a kit against the trim sheet spec. */
  const kitCheckRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, kitId: string, query: Query): Promise<void> => {
    if (!projectCall(req, res, projectId, 'GET')) return;
    const r = await checks.kitChecker.check(projectId, decodeURIComponent(kitId), { image: query.get('image') === '1' });
    if (r.ok) sendJson(res, 200, r);
    else sendJson(res, 404, { ok: false, error: { code: r.code, cls: 'validation', message: r.message } });
  };

  /**
   * GET /api/v1/projects/:projectId/exports — this project's export directories;
   * GET /api/v1/projects/:projectId/exports/:dir/zip — one export as a stored zip.
   */
  const exportsRoute = (req: IncomingMessage, res: ServerResponse, projectId: string, parts: readonly string[]): void => {
    if (!projectCall(req, res, projectId, 'GET')) return;
    if (config.exportRoot === undefined) {
      sendError(res, sessionError('invalid_request', 'unavailable', 'export is not configured on this backend (missing exportRoot)'), 503);
      return;
    }
    if (parts.length === 5) {
      sendJson(res, 200, { ok: true, projectId, exports: listExports(config.exportRoot, projectId) });
      return;
    }
    let dir = parts[5]!;
    try {
      dir = decodeURIComponent(dir);
    } catch {
      // keep the raw segment; the format check below refuses it
    }
    if (parts[6] !== 'zip' || !isExportDirOf(projectId, dir)) {
      sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
      return;
    }
    let zip: Uint8Array;
    try {
      zip = zipDirectory(join(config.exportRoot, dir));
    } catch {
      sendError(res, sessionError('invalid_request', 'not_found', 'no such export'), 404);
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${dir.replace('@', '-')}.zip"`);
    res.setHeader('content-length', String(zip.length));
    res.setHeader('cache-control', 'no-store');
    res.end(zip);
  };

  /** GET /api/v1/projects/:projectId/problems — the bounded problems log (newest last). */
  const problemsRoute = (req: IncomingMessage, res: ServerResponse, projectId: string): void => {
    if (!projectCall(req, res, projectId, 'GET')) return;
    // The graph materials with problems now (checked at the project's load and after each change).
    const rows = checks.materialRows(projectId);
    checks.loaded(projectId);
    // The missing asset files (the first page; the missing-files route pages them).
    const missing = checks.missingFiles.firstPage(projectId);
    const list = deps.problems.list(projectId);
    sendJson(res, 200, { ok: true, projectId, total: list.length, problems: list.slice(-50), ...(rows !== null ? { materialProblems: rows.filter((r) => r.problems.length > 0).slice(0, 64) } : {}), ...(missing !== null ? { missingFiles: missing } : {}) });
  };

  return { engineRoute, listProjectsRoute, resolveRoute, templatesRoute, packsRoute, materialsRoute, historyGroupRoute, addPackRoute, kitCheckRoute, exportsRoute, problemsRoute };
}
