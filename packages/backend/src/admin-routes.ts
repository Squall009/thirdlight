import { type IncomingMessage, type ServerResponse } from 'node:http';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_BOOTSTRAP, EXPORT_ENGINE_DIR, exportProject, type ClosureTextureSlots, type ExportFs } from '@thirdlight/exporter';
import { loadTemplate, resolveTemplateModules, type TemplateSource } from './templates';
import { loadPackDir, type PackInstaller } from './packs';
import { engineIdentity } from './engine';
import { installSkill } from './skill-install.mjs';
import { parseAdminNoArgsBody, parseAdminCreateProjectRequest, parseStrictJsonBytes, sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import { DEFAULT_PROJECT_SUBDIR, MARKER_FILE, type CommandError, type WorkspaceService } from '@thirdlight/workspace';
import { type BackendConfig } from './config';
import { createBehaviorCompilerPort } from './content';
import { nodeGzip } from './gzip-port';

import type { Problem } from './backend';
import type { createExternalEdits } from './external-edits';

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
  /** Make the import cache whole before the export reads what the catalog records. */
  readonly ensureImported?: (projectId: string) => Promise<unknown>;
  /** The texture arrays of per-layer texture slots (the export ships them assembled). */
  readonly textureSlots?: ClosureTextureSlots;
  /** Adds engine packs and a template's setup to a new project. */
  readonly packs?: PackInstaller;
  /** Accept or discard a pending external edit (the one path, shared with the project route). */
  readonly resolveExternal: ReturnType<typeof createExternalEdits>['resolve'];
}

/** A game folder's entries before a project was made in it ('absent': there was no folder; 'unknown': it could not be read). */
type FolderBefore = ReadonlySet<string> | 'absent' | 'unknown';

export function makeAdminRoutes(ctx: AdminRoutesContext) {
  const { config, behaviorCompiler, service, sendJson, sendError, requireAuth, readBody, workspaceError, recordProblem, ensureImported, textureSlots, packs, resolveExternal } = ctx;

  /**
   * A project just made from a template gets the template's packs, then its
   * setup's commands (ordinary commands, as the editor sends), and starts
   * with no undo history: the template is where it begins, not a step to
   * undo. Null, or why it stopped (the caller takes the project back).
   */
  const setUpFromTemplate = async (projectId: string, templateId: string, source: TemplateSource): Promise<string | null> => {
    if (source.packs.length === 0 && source.setupDir === undefined) return null;
    if (packs === undefined) return 'packs are not available on this backend';
    const origin = { kind: 'admin' as const, clientId: `template-${templateId}` };
    for (const id of source.packs) {
      const r = await packs.add(projectId, id, origin);
      if (!r.ok) return r.message;
    }
    if (source.setupDir !== undefined) {
      const loaded = loadPackDir(source.setupDir, templateId);
      if (!loaded.ok) return loaded.message;
      const r = await packs.install(projectId, loaded.pack, loaded.files, origin);
      if (!r.ok) return r.message;
    }
    service.forgetHistory(projectId);
    return null;
  };

  /**
   * Take back a project whose template setup stopped, so a retry with the
   * same id starts clean: an in-tree project's folder is deleted (all of it
   * was made just now). A folder project is unregistered and loses what
   * creation made — its marker, its `thirdlight/` folder and the entries
   * that were not in the game folder before — never what the user had there
   * (files written into a folder the user already had stay). Null, or why
   * it could not be taken back.
   */
  const takeBack = async (projectId: string, folder: FolderBefore | null): Promise<string | null> => {
    // Commands answer before their files are written: those writes land first, then nothing of the project is left to land.
    await service.flushed();
    if (folder === null) {
      const released = service.releaseWorkspace(projectId);
      if (!released.ok) return released.error.message ?? released.error.code;
      try {
        rmSync(join(config.dataRoot, 'projects', projectId), { recursive: true, force: true });
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return null;
    }
    const gone = service.unregisterProject(projectId);
    if (!gone.ok) return gone.error.message ?? gone.error.code;
    try {
      if (folder === 'absent') rmSync(gone.folder, { recursive: true, force: true });
      else {
        for (const name of [MARKER_FILE, DEFAULT_PROJECT_SUBDIR]) rmSync(join(gone.folder, name), { recursive: true, force: true });
        if (folder !== 'unknown') for (const name of readdirSync(gone.folder)) if (!folder.has(name)) rmSync(join(gone.folder, name), { recursive: true, force: true });
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return null;
  };

  /** The answer to a template setup that stopped: the project is taken back (or, failing that, said to be left). */
  const setupFailed = async (res: ServerResponse, projectId: string, failed: string, folder: FolderBefore | null): Promise<void> => {
    const stuck = await takeBack(projectId, folder);
    const message =
      stuck === null
        ? `the template's setup stopped at ${failed}; the project was not made (try again once that is fixed)`
        : `the template's setup stopped at ${failed}, and the half-made project could not be taken back (${stuck}): delete project "${projectId}" before trying again`;
    sendError(res, sessionError('invalid_request', 'internal', message), 500);
  };

  /** Install the skill into a new folder project; a failure leaves the project created and says why. */
  const skillOutcome = (engineRoot: string, folder: string): { action: string; stamp: string | null } | { error: string } => {
    try {
      const r = installSkill(engineRoot, folder);
      return { action: r.action, stamp: r.stamp };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

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
    const { projectId, name, template, folder } = parsedReq.request;
    let result: ReturnType<typeof service.createProjectFrom> | undefined;
    let source: TemplateSource | undefined;
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
      source = loaded.source;
    }
    const setUp = async (): Promise<string | null> => (result !== undefined && result.ok && result.created && source !== undefined && template !== undefined ? await setUpFromTemplate(projectId, template, source) : null);
    if (folder !== undefined) {
      // In the game's own folder: marker + thirdlight/ subfolder, registered, pinned to this engine.
      const engine = config.engineRoot !== undefined ? engineIdentity(config.engineRoot) : null;
      // What the folder held before, so taking a failed setup back removes only what creation made.
      let before: FolderBefore;
      try {
        before = existsSync(folder) ? new Set(readdirSync(folder)) : 'absent';
      } catch {
        before = 'unknown';
      }
      result = service.createProjectInFolder(folder, projectId, name, { ...(engine !== null ? { engine } : {}), ...(source !== undefined ? { source } : {}) });
      const failed = await setUp();
      if (failed !== null) {
        await setupFailed(res, projectId, failed, before);
        return;
      }
      if (result.ok && config.engineRoot !== undefined) {
        // A game folder gets the engine's agent skill, so an AI tool started there learns how to work with this engine.
        sendJson(res, result.created ? 201 : 200, { ...result, skill: skillOutcome(config.engineRoot, folder) });
        return;
      }
    } else if (source !== undefined) {
      result = service.createProjectFrom(projectId, name, source);
      const failed = await setUp();
      if (failed !== null) {
        await setupFailed(res, projectId, failed, null);
        return;
      }
    } else {
      result = service.createProject(projectId, name);
    }
    if (result.ok) {
      sendJson(res, result.created ? 201 : 200, result);
      return;
    }
    sendError(res, workspaceError(result.error), statusFor(result.error.cls));
  };

  /** POST /api/v1/admin/projects/register { folder } — open an existing project folder. */
  const adminRegisterProject = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    const folder = (strict.value as { folder?: unknown } | null)?.folder;
    const extra = Object.keys((strict.value ?? {}) as object).filter((k) => k !== 'folder');
    if (typeof folder !== 'string' || extra.length > 0) {
      sendError(res, sessionError('invalid_request', 'validation', 'body must be exactly { folder: "<absolute server path>" }', { path: extra.length > 0 ? `/${extra[0]}` : '/folder' }));
      return;
    }
    const result = service.registerProject(folder);
    if (!result.ok) {
      sendError(res, workspaceError(result.error), statusFor(result.error.cls));
      return;
    }
    sendJson(res, result.created ? 201 : 200, result);
  };

  /** POST /api/v1/admin/projects/:projectId/unregister — forget a folder project (files untouched). */
  const adminUnregisterProject = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, true);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const result = service.unregisterProject(projectId);
    if (!result.ok) {
      sendError(res, workspaceError(result.error), statusFor(result.error.cls));
      return;
    }
    sendJson(res, 200, { ok: true, projectId, folder: result.folder });
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
        result = resolveExternal(projectId, 'accept');
        break;
      case 'discard-external':
        result = resolveExternal(projectId, 'discard');
        break;
    }
    if (result.ok) {
      sendJson(res, 200, result);
      return;
    }
    sendError(res, workspaceError(result.error), statusFor(result.error.cls));
  };


  // ---------- export ----------

  /**
   * The export IO facade (dependency injection — the exporter
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
    openWrite: (p) => {
      const fd = openSync(p, 'w');
      let open = true;
      return {
        write: (data) => {
          for (let at = 0; at < data.length; ) at += writeSync(fd, data, at, data.length - at);
        },
        close: () => {
          if (open) closeSync(fd);
          open = false;
        },
      };
    },
    rename: (from, to) => renameSync(from, to),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    mkdtemp: (prefix) => mkdtempSync(prefix),
    read: (p) => readFileSync(p),
  };

  /**
   * POST /api/v1/admin/projects/:projectId/export —
   * exportProject via the INJECTED workspace service (the same service the
   * authoring routes use — the exporter never opens a second authority).
   * Admin scope only; never a browser command, not an MCP tool.
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
    // The engine an export bundles is the one `npm run build` froze beside Play's bundles, never the
    // working tree: sources being edited under packages/ must not reach a user's export.
    const bootstrap = join(engineRoot, EXPORT_ENGINE_DIR, EXPORT_BOOTSTRAP);
    if (!existsSync(bootstrap)) {
      sendError(res, sessionError('invalid_request', 'unavailable', `export is not available: the engine build has no ${EXPORT_ENGINE_DIR} (run npm run build)`));
      return;
    }
    await ensureImported?.(projectId);
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
      // The frozen export bundle entry + the SAME behavior compiler instance the play build uses.
      m3BootstrapEntry: bootstrap,
      compiler: behaviorCompiler,
      ...(textureSlots !== undefined ? { textureSlots } : {}),
      // Block-layer cells ship as gzip-compressed chunk data.
      gzip: nodeGzip,
      threePackageJson: join(engineRoot, 'node_modules/three/package.json'),
      typescriptPackageJson: join(engineRoot, 'node_modules/typescript/package.json'),
      lockfile: join(engineRoot, 'package-lock.json'),
    });
    if (result.ok) {
      for (const w of result.warnings ?? []) recordProblem(projectId, 'export', w.code, `Export: ${w.message}`);
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


  return { adminCreateProject, adminRegisterProject, adminUnregisterProject, adminProjectOp, adminExportRoute };
}
