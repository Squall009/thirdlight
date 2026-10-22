/**
 * The authoring origin's request router: the Origin allowlist, the
 * `/api/v1/…` route table (each route's handler is in its subsystem's module),
 * the route error answer, and the editor's static bundle for everything else.
 * The order of the table matters: specific content routes come before the
 * content route table so they are never shadowed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionError } from '@thirdlight/protocol';

import { badOriginError, methodNotAllowed, parseQuery, sendError, sendJson } from './http';

type Query = Map<string, string>;
type Route<A extends unknown[]> = (req: IncomingMessage, res: ServerResponse, ...args: A) => void | Promise<void>;

/** The handlers the table routes to, by subsystem. */
export interface ApiRoutes {
  readonly originRejected: (req: IncomingMessage) => string | null;
  readonly logStartup: (message: string) => void;
  readonly content: {
    readonly heightAlpha: Route<[projectId: string, query: Query]>;
    readonly decalAtlas: Route<[parts: string[], query: Query]>;
    readonly behaviorSource: Route<[projectId: string]>;
    readonly behaviorSourceRead: Route<[projectId: string, behaviorId: string]>;
    readonly libraryStage: Route<[projectId: string]>;
    readonly libraryCheck: Route<[projectId: string]>;
    /** The content route table; false when no route matched. */
    readonly table: (req: IncomingMessage, res: ServerResponse, method: string, parts: string[], query: Query) => Promise<boolean>;
    readonly materials: Route<[projectId: string, query: Query]>;
  };
  readonly sessions: {
    readonly establish: Route<[]>;
    readonly list: Route<[query: Query]>;
    readonly log: Route<[sessionId: string, query: Query]>;
    readonly command: Route<[projectId: string]>;
  };
  readonly catalog: {
    readonly engine: Route<[]>;
    readonly docs: Route<[query: Query]>;
    readonly projects: Route<[]>;
    readonly resolve: Route<[query: Query]>;
    readonly templates: Route<[]>;
    readonly packs: Route<[]>;
  };
  readonly project: {
    readonly historyGroup: Route<[projectId: string]>;
    readonly addPack: Route<[projectId: string, packId: string]>;
    readonly kitCheck: Route<[projectId: string, kitId: string, query: Query]>;
    readonly exports: Route<[projectId: string, parts: string[]]>;
    readonly problems: Route<[projectId: string]>;
    readonly missingFiles: Route<[projectId: string, query: Query]>;
    readonly externalResolve: Route<[projectId: string, action: string]>;
  };
  readonly play: {
    readonly start: Route<[projectId: string]>;
    readonly stop: Route<[projectId: string, playSessionId: string]>;
    readonly snapshot: Route<[projectId: string, playSessionId: string]>;
    readonly relay: Route<[projectId: string, playSessionId: string, kind: 'screenshot' | 'diagnostics']>;
    readonly input: Route<[projectId: string, playSessionId: string]>;
    readonly control: Route<[projectId: string, playSessionId: string]>;
    readonly observe: Route<[projectId: string, playSessionId: string]>;
  };
  readonly admin: {
    readonly createProject: Route<[]>;
    readonly registerProject: Route<[]>;
    readonly unregisterProject: Route<[projectId: string]>;
    readonly projectOp: Route<[op: 'release' | 'takeover' | 'accept-external' | 'discard-external', projectId: string]>;
    readonly exportProject: Route<[projectId: string]>;
  };
  /** Everything outside the API: the editor's static bundle. */
  readonly staticBundle: (req: IncomingMessage, res: ServerResponse, path: string) => void;
}

export function makeApiRouter(r: ApiRoutes) {
  /** The `/api/v1/…` table; false when no route matched (the caller answers unknown route). */
  const route = async (req: IncomingMessage, res: ServerResponse, method: string, parts: string[], query: Query): Promise<boolean> => {
    const { content, sessions, catalog, project, play, admin } = r;
    const projectContent = parts[2] === 'projects' && parts[4] === 'content';
    /** A route of one method: the handler, or a 405 naming the method. */
    const only = async (expected: string, run: () => void | Promise<void>): Promise<true> => {
      if (method === expected) await run();
      else methodNotAllowed(res, expected);
      return true;
    };
    // GET /api/v1/projects/:projectId/content/textures/height-alpha?ids= — which textures carry a height in A (the layer palette's badge)
    if (parts.length === 7 && projectContent && parts[5] === 'textures' && parts[6] === 'height-alpha') {
      await content.heightAlpha(req, res, parts[3]!, query);
      return true;
    }
    // /api/v1/projects/:projectId/content/decal-pages[/arrays/:id] — the decal atlas's pages, composed on request
    if (parts.length >= 6 && projectContent && parts[5] === 'decal-pages') {
      await content.decalAtlas(req, res, parts, query);
      return true;
    }
    // The additive behavior-source preparation route (before the
    // content route table so it is never shadowed).
    if (parts.length === 7 && projectContent && parts[5] === 'behaviors' && parts[6] === 'source') {
      return only('POST', () => content.behaviorSource(req, res, parts[3]!));
    }
    if (parts.length === 8 && projectContent && parts[5] === 'behaviors' && parts[7] === 'source') {
      return only('GET', () => content.behaviorSourceRead(req, res, parts[3]!, decodeURIComponent(parts[6]!)));
    }
    // Staged library edits (several patches; committed by commitScriptLibraryStage).
    if (parts.length === 7 && projectContent && parts[5] === 'libraries' && parts[6] === 'stage') {
      return only('POST', () => content.libraryStage(req, res, parts[3]!));
    }
    // The script library check (compile only; nothing is written).
    if (parts.length === 7 && projectContent && parts[5] === 'libraries' && parts[6] === 'check') {
      return only('POST', () => content.libraryCheck(req, res, parts[3]!));
    }
    // Content routes (before the fixed-length dispatch table).
    if (projectContent && (await content.table(req, res, method, parts, query))) return true;
    // POST/GET /api/v1/sessions
    if (parts.length === 3 && parts[2] === 'sessions') {
      if (method === 'POST') await sessions.establish(req, res);
      else if (method === 'GET') await sessions.list(req, res, query);
      else methodNotAllowed(res, 'POST or GET');
      return true;
    }
    // GET /api/v1/sessions/:sessionId/log
    if (parts.length === 5 && parts[2] === 'sessions' && parts[4] === 'log') {
      return only('GET', () => sessions.log(req, res, parts[3]!, query));
    }
    // GET /api/v1/engine — the engine this backend runs (commit, build, start, whether dist/ is newer)
    if (parts.length === 3 && parts[2] === 'engine') {
      await catalog.engine(req, res);
      return true;
    }
    // GET /api/v1/docs — the manual and the generated reference of this build (topic, section or search)
    if (parts.length === 3 && parts[2] === 'docs') {
      await catalog.docs(req, res, query);
      return true;
    }
    // GET /api/v1/projects/:projectId/content/materials — the materials and their graph problems (paged)
    if (parts.length === 6 && projectContent && parts[5] === 'materials') {
      await content.materials(req, res, parts[3]!, query);
      return true;
    }
    // GET /api/v1/projects — every project directory in the data root
    if (parts.length === 3 && parts[2] === 'projects') {
      await catalog.projects(req, res);
      return true;
    }
    // GET /api/v1/projects/resolve?path=<absolute server path> — which folder project a path belongs to
    if (parts.length === 4 && parts[2] === 'projects' && parts[3] === 'resolve') {
      await catalog.resolve(req, res, query);
      return true;
    }
    // POST /api/v1/admin/projects/register { folder }
    if (parts.length === 5 && parts[2] === 'admin' && parts[3] === 'projects' && parts[4] === 'register') {
      return only('POST', () => admin.registerProject(req, res));
    }
    // GET /api/v1/templates — the project templates on this engine
    if (parts.length === 3 && parts[2] === 'templates') {
      await catalog.templates(req, res);
      return true;
    }
    // GET /api/v1/packs — the content packs this engine ships
    if (parts.length === 3 && parts[2] === 'packs') {
      await catalog.packs(req, res);
      return true;
    }
    // POST /api/v1/projects/:projectId/history/group {requestIds, origin} — one user action's commands as one undo step
    if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'history' && parts[5] === 'group') {
      await project.historyGroup(req, res, parts[3]!);
      return true;
    }
    // POST /api/v1/projects/:projectId/packs/:packId {origin?} — add an engine pack's items to the project
    if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'packs') {
      await project.addPack(req, res, parts[3]!, parts[5]!);
      return true;
    }
    // GET /api/v1/projects/:projectId/kits/:kitId/check[?image=1] — a kit against the trim sheet spec
    if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'kits' && parts[6] === 'check') {
      await project.kitCheck(req, res, parts[3]!, parts[5]!, query);
      return true;
    }
    // GET /api/v1/projects/:projectId/exports[/:dir/zip] — this project's export directories, one as a stored zip
    if ((parts.length === 5 || parts.length === 7) && parts[2] === 'projects' && parts[4] === 'exports') {
      await project.exports(req, res, parts[3]!, parts);
      return true;
    }
    // GET /api/v1/projects/:projectId/problems — the bounded problems log (newest last)
    if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'problems') {
      await project.problems(req, res, parts[3]!);
      return true;
    }
    // GET /api/v1/projects/:projectId/problems/missing-files?offset=&limit= — one page of the missing asset files
    if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'problems' && parts[5] === 'missing-files') {
      await project.missingFiles(req, res, parts[3]!, query);
      return true;
    }
    // POST /api/v1/projects/:projectId/external/(accept|discard)
    if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'external' && (parts[5] === 'accept' || parts[5] === 'discard')) {
      return only('POST', () => project.externalResolve(req, res, parts[3]!, parts[5]!));
    }
    // POST /api/v1/projects/:projectId/commands
    if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'commands') {
      return only('POST', () => sessions.command(req, res, parts[3]!));
    }
    // POST /api/v1/projects/:projectId/play
    if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'play') {
      return only('POST', () => play.start(req, res, parts[3]!));
    }
    // POST /api/v1/projects/:projectId/play/:playSessionId/stop|screenshot|diagnostics|input|control|observe
    // GET …/play/:playSessionId/snapshot — a snapshot too large for one WS frame.
    if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'play') {
      const projectId = parts[3]!;
      const psid = parts[5]!;
      const action = parts[6]!;
      if (action === 'snapshot') return only('GET', () => play.snapshot(req, res, projectId, psid));
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (action === 'stop') await play.stop(req, res, projectId, psid);
      else if (action === 'screenshot' || action === 'diagnostics') await play.relay(req, res, projectId, psid, action);
      else if (action === 'input') await play.input(req, res, projectId, psid);
      // The bounded game control/observation relay.
      else if (action === 'control') await play.control(req, res, projectId, psid);
      else if (action === 'observe') await play.observe(req, res, projectId, psid);
      else sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
      return true;
    }
    // POST /api/v1/admin/projects
    if (parts.length === 4 && parts[2] === 'admin' && parts[3] === 'projects') {
      return only('POST', () => admin.createProject(req, res));
    }
    // POST /api/v1/admin/projects/:projectId/<op>
    if (parts.length === 6 && parts[2] === 'admin' && parts[3] === 'projects') {
      const op = parts[5]!;
      const projectId = parts[4]!;
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (op === 'unregister') await admin.unregisterProject(req, res, projectId);
      else if (op === 'release' || op === 'takeover' || op === 'accept-external' || op === 'discard-external') await admin.projectOp(req, res, op, projectId);
      else if (op === 'export') await admin.exportProject(req, res, projectId);
      else sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
      return true;
    }
    return false;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '';
    const qIdx = url.indexOf('?');
    const p = qIdx === -1 ? url : url.slice(0, qIdx);
    const query = parseQuery(qIdx === -1 ? '' : url.slice(qIdx + 1));
    const method = req.method ?? 'GET';

    const found = r.originRejected(req);
    if (found !== null) {
      sendError(res, badOriginError(found), 403);
      return;
    }

    const parts = p.split('/').filter((x) => x.length > 0);
    if (parts[0] === 'api' && parts[1] === 'v1') {
      try {
        if (!(await route(req, res, method, parts, query))) sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
      } catch (err) {
        r.logStartup(`route error: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { ok: false, error: sessionError('invalid_request', 'internal', 'internal error') });
      }
      return;
    }
    r.staticBundle(req, res, p);
  };
}
