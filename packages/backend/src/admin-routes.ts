import { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportProject, type ExportFs } from '@thirdlight/exporter';
import { loadTemplate, resolveTemplateModules } from './templates';
import { parseAdminNoArgsBody, parseAdminCreateProjectRequest, parseStrictJsonBytes, sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import { type CommandError, type WorkspaceService } from '@thirdlight/workspace';
import { type BackendConfig } from './config';
import { createBehaviorCompilerPort } from './content';

import type { Problem } from './backend';

export interface AdminRoutesContext {
  readonly config: BackendConfig;
  readonly behaviorCompiler: ReturnType<typeof createBehaviorCompilerPort>;
  readonly service: WorkspaceService;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly readBody: (req: IncomingMessage) => Promise<{ ok: true; bytes: Uint8Array; } | { ok: false; error: SessionError; }>;
  readonly workspaceError: (e: CommandError) => SessionError;
  readonly recordProblem: (projectId: string, source: Problem["source"], code: string, message: string) => void;
}

export function makeAdminRoutes(ctx: AdminRoutesContext) {
  const { config, behaviorCompiler, service, sendJson, sendError, requireAuth, readBody, workspaceError, recordProblem } = ctx;

  const adminCreateProject = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const authError = requireAuth(req, '', true);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const parsedReq = parseAdminCreateProjectRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error);
      return;
    }
    const { projectId, name, template } = parsedReq.request;
    let result;
    if (template !== undefined) {
      if (config.engineRoot === undefined) {
        sendError(res, sessionError('invalid_request', 'unavailable', 'templates need the engine root (THIRDLIGHT_ENGINE_ROOT)'), 503);
        return;
      }
      const loaded = loadTemplate(config.engineRoot, template);
      if (!loaded.ok) {
        sendError(res, sessionError('invalid_request', 'not_found', loaded.message, { path: '/template' }), 404);
        return;
      }
      // The template's declared dependencies must resolve on this engine.
      const modules = resolveTemplateModules(loaded.source);
      if (!modules.ok) {
        sendError(res, sessionError('module_unresolved', 'validation', modules.message, { path: '/template' }), 400);
        return;
      }
      result = service.createProjectFrom(projectId, name, loaded.source);
    } else {
      result = service.createProject(projectId, name);
    }
    if (result.ok) {
      sendJson(res, result.created ? 201 : 200, result);
      return;
    }
    sendError(res, workspaceError(result.error), statusFor(result.error.cls));
  };

  const adminProjectOp = async (
    req: IncomingMessage,
    res: ServerResponse,
    op: 'release' | 'takeover' | 'accept-external' | 'discard-external',
    projectId: string,
  ): Promise<void> => {
    const authError = requireAuth(req, projectId, true);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const noArgs = parseAdminNoArgsBody(strict.value);
    if (!noArgs.ok) {
      sendError(res, noArgs.error);
      return;
    }
    let result;
    switch (op) {
      case 'release':
        result = service.releaseWorkspace(projectId);
        break;
      case 'takeover':
        result = service.takeoverWorkspace(projectId);
        break;
      case 'accept-external':
        result = service.acceptExternalState(projectId);
        break;
      case 'discard-external':
        result = service.discardExternalState(projectId);
        break;
    }
    if (result.ok) {
      sendJson(res, 200, result);
      return;
    }
    sendError(res, workspaceError(result.error), statusFor(result.error.cls));
  };


  // ---------- export (sessions.md §6.3; export.md §2/§4) ----------

  /**
   * The export IO facade (export.md §2 dependency injection — the exporter
   * package's own edge set has no Node builtins; the backend, which is
   * allowed `node:fs`/`node:path`, supplies the facade).
   */
  const exportFs: ExportFs = {
    join: (...parts) => join(...parts),
    realpath: (p) => realpathSync(p),
    isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
    exists: (p) => existsSync(p),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    write: (p, data) => writeFileSync(p, data),
    rename: (from, to) => renameSync(from, to),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    mkdtemp: (prefix) => mkdtempSync(prefix),
    read: (p) => readFileSync(p),
  };

  /**
   * POST /api/v1/admin/projects/:projectId/export (sessions.md §6.3) —
   * exportProject via the INJECTED workspace service (the same service the
   * authoring routes use — the exporter never opens a second authority).
   * Admin scope only; never a browser command, not an MCP tool (M1).
   */
  const adminExportRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, true);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const noArgs = parseAdminNoArgsBody(strict.value);
    if (!noArgs.ok) {
      sendError(res, noArgs.error);
      return;
    }
    if (config.exportRoot === undefined) {
      sendError(res, sessionError('invalid_request', 'unavailable', 'export is not configured on this backend (missing exportRoot)'));
      return;
    }
    if (config.engineRoot === undefined) {
      sendError(res, sessionError('invalid_request', 'unavailable', 'export is not configured on this backend (missing engineRoot — the engine installation root)'));
      return;
    }
    const engineRoot = config.engineRoot;
    const result = await exportProject({
      projectId,
      service,
      fs: exportFs,
      exportRoot: config.exportRoot,
      repoRoot: engineRoot,
      // The authoring tree is the projects directory; exports may live elsewhere under the data root.
      authoringRoot: join(config.dataRoot, 'projects'),
      authoringOrigin: config.authoringOrigin,
      previewOrigin: config.previewOrigin,
      tokenValues: config.tokens.map((t) => t.token),
      // The export bundle entry + the SAME behavior compiler instance the play build uses.
      m3BootstrapEntry: join(engineRoot, 'packages/exporter/src/export-bootstrap-m3.ts'),
      compiler: behaviorCompiler,
      threePackageJson: join(engineRoot, 'node_modules/three/package.json'),
      typescriptPackageJson: join(engineRoot, 'node_modules/typescript/package.json'),
      lockfile: join(engineRoot, 'package-lock.json'),
    });
    if (result.ok) {
      sendJson(res, 200, result);
      return;
    }
    const e = result.error;
    recordProblem(projectId, 'export', e.code, `Export failed: ${e.message}`);
    const errorBody: Record<string, unknown> = { code: e.code, cls: e.cls, message: e.message };
    if (e.detail !== undefined) {
      for (const [k, v] of Object.entries(e.detail)) errorBody[k] = v;
    }
    sendJson(res, statusFor(e.cls), { ok: false, error: errorBody });
  };

  // ---------- static ----------


  return { adminCreateProject, adminProjectOp, adminExportRoute };
}
