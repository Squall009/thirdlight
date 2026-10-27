/**
 * The backend: HTTP API, WebSocket sessions and static origins.
 *
 * One process, two listeners:
 * - the authoring origin `O_A`: the HTTP API (`/api/v1/…`), the WS channel
 *   (`/api/v1/ws`), and the editor static bundle;
 * - the preview origin `O_P`: the static preview page only — a small HTML
 *   template injecting the checked message-bridge config + the
 *   static bundle. No API endpoints, no WS, no credentials.
 *
 * All persistent changes delegate to the workspace service (the sole
 * command executor). The transport never mutates
 * files independently.
 *
 * Exported as `@thirdlight/backend/services` (the stable surface the MCP
 * adapter imports); the default subpath is the executable
 * bootstrap (the owner-deployment entry point).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseStrictJsonBytes, sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import { openWorkspaceService, readMarker, type CommandError, type WorkspaceService } from '@thirdlight/workspace';
import { mergeTimeouts, parseBackendConfig, type BackendConfig } from './config';
import { createAssetInspector, createBehaviorCompilerPort, type ContentRoutes } from './content';
import type { TextureSlotAssembler } from './texture-slots';
import { createContentServices } from './content-services';
import { makeFullState } from './full-state';
import { loadMeshSimplifier, type MeshSimplifier } from '@thirdlight/asset-pipeline';
import { makeMissingFilesRoute } from './missing-files';
import { createProblemLog, createProjectChecks } from './problems';
import { createWsChannel } from './ws-channel';
import { makeApiRouter } from './api-router';
import { makeLibraryRoutes } from './library-routes';
import { makeProjectRoutes } from './project-routes';
import { createExternalEdits } from './external-edits';
import { makeDecalAtlasRoutes } from './decal-atlas';
import { createErosionRunner } from './erosion-runner';

/** The script type check's worker beside the bundle (null from source: checks run in process). */
const TYPE_CHECK_WORKER: URL | null = (() => {
  const url = new URL('./type-check-worker.mjs', import.meta.url);
  return url.protocol === 'file:' && existsSync(decodeURIComponent(url.pathname)) ? url : null;
})();
/** The terrain erosion worker script beside the bundle (null from source: erosion runs in process). */
const EROSION_WORKER: URL | null = (() => {
  const url = new URL('./erosion-worker.mjs', import.meta.url);
  return url.protocol === 'file:' && existsSync(decodeURIComponent(url.pathname)) ? url : null;
})();
import { createAuth } from './auth';
import { badOriginError, bearerToken, parseQuery, readBody, sendError, sendJson, workspaceError } from './http';
import { PlayContentStore } from './play-content';
import { SessionRegistry, type SessionRecord } from './sessions';
import { PlayManager, type PlayRecord } from './play';
import { makeSessionRoutes } from './session-routes';
import { createHeadlessEditors } from './headless';
import { makePreviewRoutes } from './preview-routes';
import { createPlayBuildCache } from './play-build';
import { makeStaticRoutes } from './static-routes';
import { makeAdminRoutes } from './admin-routes';
import { makeBehaviorSourceRoutes } from './behavior-source-routes';
import { loadManual, makeDocsRoute, manualSummary } from './docs';
import { makePlayRoutes } from './play-routes';
import { makeLightingBakeRoute } from './lighting-bake-route';
import { makeEngineInfo } from './engine';
import { makeHeightAlphaRoute } from './height-alpha';

import { MAX_DIAGNOSTICS, MAX_HTTP_BODY, SESSION_LIST_MAX, STARTUP_LOG_RING, utf8Len, type OriginDoc } from './util';
export { MAX_DIAGNOSTICS, MAX_HTTP_BODY, SESSION_LIST_MAX, STARTUP_LOG_RING };
import { createModelBrickImports, type ModelBrickImports } from './model-bricks';

export interface SessionView {
  sessionId: string;
  projectId: string;
  connId: string;
  connected: boolean;
  lastActivityAt: number;
  playSessionId?: string;
  /** The editor's current selection. */
  selection: string[];
}

export interface Backend {
  readonly config: BackendConfig;
  /** Resolves once both listeners are bound; rejects on listen failure. */
  ready: Promise<Backend>;
  /** The bound ports (valid after `ready`). */
  readonly portAuthoring: number;
  readonly portPreview: number;
  close(): Promise<void>;
  /** Test observability (not part of the production surface). */
  readonly _test: {
    sessions: SessionRegistry;
    plays: PlayManager;
    startupLog: Array<{ ts: number; message: string }>;
    service: WorkspaceService;
    contentRoutes: ContentRoutes;
    playContent: PlayContentStore;
    textureSlots: TextureSlotAssembler;
    decalPages: { readonly stats: { composed: number; cached: number; arrays: number } };
    modelBricks: ModelBrickImports;
  };
}

export type { Problem } from './problems';

export function createBackend(
  rawConfig: unknown,
): { ok: true; backend: Backend } | { ok: false; error: { message: string; missing: string[] } } {
  const parsed = parseBackendConfig(rawConfig);
  if (!parsed.ok) {
    return { ok: false, error: { message: parsed.error.message, missing: [parsed.error.path ?? ''] } };
  }
  const config = parsed.config;
  const timeouts = mergeTimeouts(config.timeouts);
  const nowMs = (): number => Date.now();

  // Startup static checks (missing bundle ⇒ structured
  // startup error, recorded in the bounded log).
  const missing: string[] = [];
  if (!existsSync(config.editorStaticDir) || !statSync(config.editorStaticDir).isDirectory()) missing.push('editorStaticDir');
  else if (!existsSync(join(config.editorStaticDir, 'index.html')) || !statSync(join(config.editorStaticDir, 'index.html')).isFile()) {
    missing.push('editorStaticDir/index.html');
  }
  if (!existsSync(config.previewStaticDir) || !statSync(config.previewStaticDir).isDirectory()) missing.push('previewStaticDir');
  const startupLog: Array<{ ts: number; message: string }> = [];
  const logStartup = (message: string): void => {
    startupLog.push({ ts: nowMs(), message });
    while (startupLog.length > STARTUP_LOG_RING) startupLog.shift();
  };
  if (missing.length > 0) {
    logStartup(`startup_invalid: static bundle check failed (${missing.join(', ')}); run the editor build (npm run build) first`);
    return { ok: false, error: { message: 'static bundle check failed — run the editor build (npm run build) first', missing } };
  }
  mkdirSync(config.dataRoot, { recursive: true });
  if (config.exportRoot !== undefined) mkdirSync(config.exportRoot, { recursive: true });

  // One compiler instance for both the injected workspace path and
  // the play build's deterministic behavior-output recompilation.
  const behaviorCompiler = createBehaviorCompilerPort(nowMs, TYPE_CHECK_WORKER);
  const assetInspector = createAssetInspector();
  // The mesh simplifier (its WebAssembly module) is in before the backend serves: what a spline makes gets the same
  // levels of detail from the first command on.
  const meshSimplifier: { current: MeshSimplifier | null } = { current: null };
  const simplifierLoaded = loadMeshSimplifier().then(
    (s) => void (meshSimplifier.current = s),
    (e: unknown) => logStartup(`mesh simplifier unavailable (${e instanceof Error ? e.message : String(e)}): spline meshes get their finest level only`),
  );
  const service: WorkspaceService = openWorkspaceService({
    root: config.dataRoot,
    backendId: config.backendId,
    processMarker: config.processMarker,
    // The backend constructs the pure `asset-pipeline` inspector
    // and injects it into the workspace. The
    // workspace owns the staged-byte read; the transport never touches a file.
    assetInspector,
    // The backend constructs the pinned behavior-source compiler
    // (`behavior-build`) and injects it — the workspace's preparation layer
    // drives it; the compiler never reads a path or executes project source.
    behaviorCompiler,
    meshSimplifier,
    // The folder watch that lets file checks look only at changed files.
    ...(config.fileWatch !== undefined ? { fileWatch: config.fileWatch } : {}),
  });
  const sessions = new SessionRegistry();

  logStartup(
    `starting: dataRoot=${config.dataRoot} authoring=${config.authoringOrigin} preview=${config.previewOrigin}`,
  );

  // The immutable play-content artifact store.
  const playContent = new PlayContentStore({ now: nowMs, ttlMs: timeouts.playContentTtlSeconds * 1000, graceMs: timeouts.playContentGraceSeconds * 1000 });

  const plays = new PlayManager({
    sendToOwner: (ownerSessionId, payload) => channel.sendToOwner(ownerSessionId, payload),
    logPlay: (ownerSessionId, ref, code) => {
      const s = sessions.sessionForSessionId(ownerSessionId);
      if (s) sessions.record(s, 'play', ref, undefined, nowMs(), code);
    },
    ttlMs: () => timeouts.inactivityTtlSeconds * 1000,
    relayTimeoutMs: () => timeouts.relayTimeoutSeconds * 1000,
    stopAckTimeoutMs: () => timeouts.stopAckTimeoutSeconds * 1000,
    presentTimeoutMs: () => timeouts.presentTimeoutSeconds * 1000,
    inputRelayTimeoutMs: () => 10_000,
    onTerminal: (playSessionId) => playContent.markTerminal(playSessionId),
    // Play content lasts as long as its play (a long play-test still loads scenes).
    onRenewed: (playSessionId, expiresAt) => playContent.renew(playSessionId, expiresAt),
    // A play that ended before it was presented is a project problem saying why
    // (a Stop is the user's own choice; a preview failure is recorded where it is reported).
    onEnded: (rec) => {
      // A play.started held for a detached owner is dropped with its play (it carries the snapshot).
      const owner = sessions.sessionForSessionId(rec.ownerSessionId);
      if (owner?.pendingPlayStarted?.playSessionId === rec.playSessionId) owner.pendingPlayStarted = null;
      if (rec.presented || rec.reason === 'request' || rec.reason === 'preview_failed') return;
      const ended = plays.describeEnd(rec);
      if (ended !== null) recordProblem(rec.projectId, 'play', `play_${rec.reason ?? 'ended'}`, `${rec.playSessionId}: ${ended.message}`);
    },
    nowMs,
  });

  /** The relay ack timeout (the game control relay shares it). */
  const relayTimeoutMs = (): number => timeouts.relayTimeoutSeconds * 1000;

  // MCP play without the owner's browser (a headless editor).
  const ownerToken = config.tokens.find((t) => t.scope === 'admin')?.token ?? '';
  const headless = createHeadlessEditors({
    // Off unless configured (the process entry turns it on; tests and embeddings do not).
    config: config.headless ?? { enabled: false, idleMs: 300_000 },
    dataRoot: config.dataRoot,
    editorUrl: (projectId) => `${config.authoringOrigin}/?project=${encodeURIComponent(projectId)}&headless=1#token=${ownerToken}`,
    connected: (projectId) => sessions.sessionForProject(projectId)?.connected === true,
    playing: (projectId) => plays.activeFor(projectId) !== undefined,
    log: logStartup,
    now: nowMs,
  });

  const authoringServer = createServer();
  const previewServer = createServer();
  let closed = false;

  const auth = createAuth(config);
  const { tokenScope, requireAuth, originRejected, trustedRequest } = auth;

  // The content side: imports, the game folder's file check, texture slots and decal pages, packs, the content transport.
  const { textureEncoder, decalPages, heightChecks, textureSlots, textures, assetFiles, packs, folderImport, contentRoutes } = createContentServices({
    config,
    service,
    assetInspector,
    nowMs,
    logStartup,
    recordProblem: (projectId, source, code, message) => recordProblem(projectId, source, code, message),
    requireAuth,
    onApplied: (...args) => notifyMutationApplied(...args),
    // A full check is when a Play build is made ahead (the Play routes are made below).
    onChecked: (projectId) => {
      missingFiles.refresh(projectId);
      warmPlay?.(projectId);
    },
  });
  let warmPlay: ((projectId: string) => void) | undefined;

  const sessionView = (s: SessionRecord): SessionView => {
    const v: SessionView = {
      sessionId: s.sessionId,
      projectId: s.projectId,
      connId: s.connId,
      connected: s.connected,
      lastActivityAt: s.lastActivityAt,
      selection: [...s.selection],
    };
    if (s.playSessionId !== null) v.playSessionId = s.playSessionId;
    return v;
  };

  const ownerSession = (rec: PlayRecord): SessionRecord | undefined => sessions.sessionForSessionId(rec.ownerSessionId);

  /**
   * The owner of the play: a connected owner session (else undefined —
   * the caller returns `session_unavailable`).
   */
  const connectedOwner = (rec: PlayRecord): SessionRecord | undefined => {
    const s = ownerSession(rec);
    if (!s || !s.connected || !s.socket) return undefined;
    return s;
  };

  /** `session_unavailable` with a hint. */
  const unavailableError = (playSessionId: string | undefined, hint: string): SessionError =>
    sessionError('session_unavailable', 'unavailable', hint, {
      ...(playSessionId !== undefined ? { playSessionId } : {}),
      hint,
    });

  // ---------- project problems log (editor Problems tab + MCP) and the checks that fill it ----------
  const problemLog = createProblemLog({ nowMs, sendToProject: (projectId, frame) => channel.sendToProject(projectId, frame) });
  const recordProblem = problemLog.record;
  const checks = createProjectChecks({ service, recordProblem, withdrawProblem: problemLog.withdraw, logStartup, closed: () => closed, textureEncoder, heightChecks, assetFiles });
  const { missingFiles } = checks;
  const missingFilesRoute = makeMissingFilesRoute({ missingFiles, requireAuth, sendJson, sendError });
  const heightAlphaRoute = makeHeightAlphaRoute({ problems: checks.heightProblems, requireAuth, sendJson, sendError });
  // The editor's decal atlas: the pages the build plans, composed on request (decal-atlas.ts).
  const decalAtlasRoute = makeDecalAtlasRoutes({ service, port: textureSlots, requireAuth, sendJson, sendError });
  const fullState = makeFullState({ service, checks });

  // ---------- The engine this process runs ----------
  const engineInfo = makeEngineInfo({ engineRoot: config.engineRoot, distDir: dirname(config.editorStaticDir), startedAtMs: Date.now() - process.uptime() * 1000 });
  // The manual of the build this process runs: read once now (dist/docs/ the build copied; else the checkout's docs/).
  const manual = loadManual([join(dirname(config.editorStaticDir), 'docs'), ...(config.engineRoot !== undefined ? [join(config.engineRoot, 'docs')] : [])]);
  const docsRoute = makeDocsRoute({ manual, authorized: (req) => tokenScope(bearerToken(req), req) !== null, sendJson });

  // Imported models get their distance-field bricks made right after the import (the lighting tracer's shape of them).
  const modelBricks = createModelBrickImports({ service, log: logStartup });

  const notifyMutationApplied = (
    projectId: string,
    requestId: string,
    revision: number,
    origin: OriginDoc | null,
    change: unknown,
    sceneId?: string,
  ): void => {
    checks.changed(projectId, change);
    modelBricks.changed(projectId, change);
    channel.sendMutationApplied(projectId, requestId, revision, origin, change, sceneId);
  };

  // ---------- the editor's WebSocket channel ----------
  const channel = createWsChannel({ timeouts, nowMs, sessions, plays: () => plays, originRejected, logStartup, recordProblem, attachRevision: (projectId) => fullState(projectId), lightingBakeAck: (sessionId, ack) => lightingBake.resolveAck(sessionId, ack) });
  authoringServer.on('upgrade', channel.handleUpgrade);
  // External edits: while an editor is connected, its project's files are compared with what this backend wrote.
  const external = createExternalEdits({ service, sessions, recordProblem, sendToProject: channel.sendToProject, requireAuth });

  // ---------- routes ----------
  // The prebuilt play scripts (bundle, worker, physics), read once per build, at digest-keyed URLs.
  const playBuild = createPlayBuildCache(config.previewStaticDir);
  const { playStartRoute, playStopRoute, playSnapshotRoute, relayRoute, inputRelayRoute, gameControlRoute, gameObserveRoute, warmPlay: warmPlayBuild } = makePlayRoutes({ config, nowMs, logStartup, behaviorCompiler, service, sessions, playContent, plays, relayTimeoutMs, sendJson, sendError, bearerToken, tokenScope, badOriginError, requireAuth, readBody, fullState, workspaceError, connectedOwner, unavailableError, recordProblem, headless, playBuild, ensureImported: assetFiles.ensureImported, textureSlots });
  warmPlay = warmPlayBuild;
  const lightingBake = makeLightingBakeRoute({
    sessions,
    headless,
    sendToOwner: (sessionId, payload) => channel.sendToOwner(sessionId, payload),
    requireAuth,
    readBody,
    sendJson,
    sendError,
    hasScene: (projectId, sceneId) => {
      const captured = service.readCapturedV3(projectId);
      return captured.ok && ((captured.read.content as { scenes?: readonly { sceneId?: string }[] } | undefined)?.scenes ?? []).some((s) => s.sceneId === sceneId);
    },
    logStartup,
  });

  const { behaviorSourceRoute } = makeBehaviorSourceRoutes({ service, sessions, behaviorCompiler, sendJson, sendError, requireAuth, readBody, workspaceError, recordProblem, notifyMutationApplied });
  const { adminCreateProject, adminRegisterProject, adminUnregisterProject, adminProjectOp, adminExportRoute } = makeAdminRoutes({ config, behaviorCompiler, service, sendJson, sendError, requireAuth, readBody, workspaceError, recordProblem, ensureImported: assetFiles.ensureImported, textureSlots, packs });

  const { serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml, isolationHeaders } = makeStaticRoutes({ config, sendJson });

  // A Play file that no longer has its digest has the project's files checked again (one check waiting at a time).
  const recheckQueued = new Set<string>();
  const onFileChanged = (projectId: string): void => {
    if (recheckQueued.has(projectId)) return;
    recheckQueued.add(projectId);
    void assetFiles.check(projectId).finally(() => recheckQueued.delete(projectId));
  };
  const { serveEditorPage, dispatchPreview } = makePreviewRoutes({ config, logStartup, playContent, sendJson, parseQuery, serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml, isolationHeaders, playBuild, openFile: (projectId, file) => service.openBlobFile(projectId, file), onFileChanged });

  const { establishSession, listSessions, sessionLog, commandRoute } = makeSessionRoutes({ timeouts, nowMs, service, sessions, sendJson, sendError, bearerToken, tokenScope, requireAuth, readBody, fullState, workspaceError, sessionView, recordProblem, notifyMutationApplied, headless, folderImport, textures, erosion: createErosionRunner(EROSION_WORKER), onOwnerLost: (sessionId: string, detail?: string) => plays.onOwnerDisconnected(sessionId, detail) });
  const library = makeLibraryRoutes({ service, requireAuth });
  const project = makeProjectRoutes({ config, service, sessions, problems: problemLog, checks, packs, requireAuth, authorized: auth.authorized, engine: async () => ({ ...engineInfo(), manual: await manualSummary(manual) }) });

  const dispatch = makeApiRouter({
    originRejected,
    logStartup,
    content: {
      heightAlpha: heightAlphaRoute,
      decalAtlas: decalAtlasRoute,
      behaviorSource: behaviorSourceRoute,
      behaviorSourceRead: library.behaviorSourceRead,
      libraryStage: library.libraryStageRoute,
      libraryCheck: library.libraryCheckRoute,
      table: (req, res, method, parts, query) => contentRoutes.handle(req, res, method, parts, query),
      materials: project.materialsRoute,
    },
    sessions: { establish: establishSession, list: listSessions, log: sessionLog, command: commandRoute },
    catalog: { engine: project.engineRoute, docs: docsRoute, projects: project.listProjectsRoute, resolve: project.resolveRoute, templates: project.templatesRoute, packs: project.packsRoute },
    project: {
      historyGroup: project.historyGroupRoute,
      addPack: project.addPackRoute,
      kitCheck: project.kitCheckRoute,
      exports: project.exportsRoute,
      problems: project.problemsRoute,
      missingFiles: missingFilesRoute,
      externalResolve: external.resolveRoute,
    },
    lighting: { bake: lightingBake.start, bakeJob: async (req, res, projectId, jobId) => lightingBake.read(req, res, projectId, jobId) },
    play: { start: playStartRoute, stop: playStopRoute, snapshot: playSnapshotRoute, relay: relayRoute, input: inputRelayRoute, control: gameControlRoute, observe: gameObserveRoute },
    admin: { createProject: adminCreateProject, registerProject: adminRegisterProject, unregisterProject: adminUnregisterProject, projectOp: adminProjectOp, exportProject: adminExportRoute },
    // Everything else is the editor's static bundle. The page gets its (non-secret) config injected here;
    // access tokens are never part of any served page. Cross-origin isolated when configured (Play may then
    // share memory with its worker).
    staticBundle: (req, res, path) => {
      isolationHeaders(res);
      if (path === '/' || path === '/index.html') serveEditorPage(res, trustedRequest(req));
      else serveStatic(res, config.editorStaticDir, path);
    },
  });
  authoringServer.on('request', (req, res) => {
    void dispatch(req, res);
  });
  previewServer.on('request', (req, res) => {
    dispatchPreview(req, res);
  });

  const backend: Backend = {
    config,
    ready: new Promise<Backend>((resolveP, rejectP) => {
      const fail = (err: Error): void => {
        rejectP(err);
      };
      authoringServer.once('error', fail);
      previewServer.once('error', fail);
      void simplifierLoaded.then(() =>
        authoringServer.listen(bindPort(config.authoringBind), bindHost(config.authoringBind), () => {
          previewServer.listen(bindPort(config.previewBind), bindHost(config.previewBind), () => {
            authoringServer.off('error', fail);
            previewServer.off('error', fail);
            logStartup('listening: both origins bound');
            resolveP(backend);
          });
        }),
      );
    }),
    get portAuthoring(): number {
      return (authoringServer.address() as { port: number } | null)?.port ?? 0;
    },
    get portPreview(): number {
      return (previewServer.address() as { port: number } | null)?.port ?? 0;
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        if (closed) {
          resolveClose();
          return;
        }
        closed = true;
        checks.dispose();
        modelBricks.dispose();
        void headless.dispose();
        channel.stopSweep();
        external.dispose();
        plays.dispose();
        lightingBake.dispose();
        contentRoutes.dispose();
        playContent.dispose();
        channel.close(() => {
          authoringServer.close(() => {
            previewServer.close(() => {
              service.close();
              resolveClose();
            });
          });
        });
      }),
    _test: { sessions, plays, startupLog, service, contentRoutes, playContent, textureSlots, decalPages, modelBricks },
  };

  return { ok: true, backend };
}

/** `host:port` → the host to bind (tests bind port 0; the port part of the
 * configured bind is the deployment's). */
function bindHost(bind: string): string {
  const idx = bind.lastIndexOf(':');
  return idx === -1 ? bind : bind.slice(0, idx);
}

/** The configured port (port 0 ⇒ ephemeral — test behavior). */
function bindPort(bind: string): number {
  const idx = bind.lastIndexOf(':');
  return idx === -1 ? 0 : Number(bind.slice(idx + 1));
}

