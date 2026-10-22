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
import { listTemplates } from './templates';
import { listPacks } from './packs';
import { isExportDirOf, listExports, zipDirectory } from './exports';
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
import { comparePin, engineIdentity, makeEngineInfo } from './engine';
import { makeHeightAlphaRoute } from './height-alpha';

import { MAX_DIAGNOSTICS, MAX_HTTP_BODY, SESSION_LIST_MAX, STARTUP_LOG_RING, utf8Len, type OriginDoc } from './util';
export { MAX_DIAGNOSTICS, MAX_HTTP_BODY, SESSION_LIST_MAX, STARTUP_LOG_RING };

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
  const checks = createProjectChecks({ service, recordProblem, logStartup, closed: () => closed, textureEncoder, heightChecks, assetFiles });
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

  const notifyMutationApplied = (
    projectId: string,
    requestId: string,
    revision: number,
    origin: OriginDoc | null,
    change: unknown,
    sceneId?: string,
  ): void => {
    checks.changed(projectId, change);
    channel.sendMutationApplied(projectId, requestId, revision, origin, change, sceneId);
  };

  // ---------- the editor's WebSocket channel ----------
  const channel = createWsChannel({ timeouts, nowMs, sessions, plays: () => plays, originRejected, logStartup, recordProblem, attachRevision: (projectId) => fullState(projectId) });
  authoringServer.on('upgrade', channel.handleUpgrade);
  // External edits: while an editor is connected, its project's files are compared with what this backend wrote.
  const external = createExternalEdits({ service, sessions, recordProblem, sendToProject: channel.sendToProject, requireAuth });

  // ---------- routes ----------

  /**
   * `POST …/content/libraries/check {libraryId, files}` — compile
   * one script library draft on its own (the script editor's idle check and
   * Compile): its files replace the stored library of that id (or add one)
   * and the other libraries are the project's. Nothing is written and no code
   * runs. Answers the compiler's diagnostics (each with the library and file
   * it names), the draft's digest, the libraries it reaches and the published
   * scripts that import it (they are recompiled when it is saved).
   */
  const libraryCheckRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
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
    const value = strict.value as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key !== 'libraryId' && key !== 'files') {
        sendError(res, sessionError('field_unexpected', 'validation', `a library check takes libraryId and files only ("${key}")`, { path: `/${key}` }));
        return;
      }
    }
    const libraryId = value.libraryId;
    if (typeof libraryId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(libraryId)) {
      sendError(res, sessionError('field_value', 'validation', 'libraryId must use the id syntax', { path: '/libraryId' }));
      return;
    }
    const files = value.files;
    if (!Array.isArray(files) || files.some((f) => typeof f !== 'object' || f === null || typeof (f as { path?: unknown }).path !== 'string' || typeof (f as { text?: unknown }).text !== 'string')) {
      sendError(res, sessionError('field_value', 'validation', 'files must be a list of { path, text }', { path: '/files' }));
      return;
    }
    const r = await service.checkScriptLibraryDraft(projectId, { libraryId, files: (files as { path: string; text: string }[]).map((f) => ({ path: f.path, text: f.text })) });
    if (!r.ok) {
      sendError(res, workspaceError(r.error));
      return;
    }
    sendJson(res, 200, r);
  };

  /**
   * `POST …/content/libraries/stage` — staged library edits.
   * `{stageId?, libraryId, name?, files?}` adds one patch (`setScriptLibrary`'s
   * shape, each under the request cap; a file's text may come in pieces,
   * `{path, text, append: true}`) to a stage (a new one without
   * stageId) and answers the stage (its libraries, their digests, the patch
   * count); `{stageId, discard: true}` drops one. Nothing authoritative
   * changes: `commitScriptLibraryStage {stageId}` commits the stage as one
   * change (one revision, one undo, the dependents compiled once).
   */
  const libraryStageRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
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
    const value = strict.value as Record<string, unknown>;
    const stageId = value['stageId'];
    if (stageId !== undefined && (typeof stageId !== 'string' || !/^lstage-[0-9]{1,12}$/.test(stageId))) {
      sendError(res, sessionError('field_value', 'validation', 'stageId must be a stage id this route answered (lstage-<n>)', { path: '/stageId' }));
      return;
    }
    if (value['discard'] !== undefined) {
      if (value['discard'] !== true || typeof stageId !== 'string' || Object.keys(value).length !== 2) {
        sendError(res, sessionError('field_value', 'validation', 'discard a stage with exactly { stageId, discard: true }', { path: '/discard' }));
        return;
      }
      const d = service.discardScriptLibraryStage(projectId, stageId);
      if (!d.ok) {
        sendError(res, workspaceError(d.error));
        return;
      }
      sendJson(res, 200, { ok: true, stageId, discarded: true });
      return;
    }
    for (const key of Object.keys(value)) {
      if (!['stageId', 'libraryId', 'name', 'files'].includes(key)) {
        sendError(res, sessionError('field_unexpected', 'validation', `a library stage patch takes stageId, libraryId, name and files ("${key}")`, { path: `/${key}` }));
        return;
      }
    }
    const libraryId = value['libraryId'];
    if (typeof libraryId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(libraryId)) {
      sendError(res, sessionError('field_value', 'validation', 'libraryId must use the id syntax', { path: '/libraryId' }));
      return;
    }
    const name = value['name'];
    if (name !== undefined && typeof name !== 'string') {
      sendError(res, sessionError('field_value', 'validation', 'name must be a string', { path: '/name' }));
      return;
    }
    const files = value['files'];
    if (name === undefined && files === undefined) {
      sendError(res, sessionError('field_missing', 'validation', 'a patch names files (or a name)', { path: '/files' }));
      return;
    }
    const fileOk = (f: unknown): boolean => {
      if (typeof f !== 'object' || f === null || Array.isArray(f)) return false;
      const o = f as { path?: unknown; text?: unknown; append?: unknown };
      if (typeof o.path !== 'string' || Object.keys(o).some((k) => k !== 'path' && k !== 'text' && k !== 'append')) return false;
      if (o.append !== undefined) return o.append === true && typeof o.text === 'string';
      return typeof o.text === 'string' || o.text === null;
    };
    if (files !== undefined && (!Array.isArray(files) || files.length > 32 || !files.every(fileOk))) {
      sendError(res, sessionError('field_value', 'validation', 'files must be a list of up to 32 { path, text: string | null, append?: true } (append adds a piece to the staged file)', { path: '/files' }));
      return;
    }
    const patch = {
      libraryId,
      ...(typeof name === 'string' ? { name } : {}),
      ...(files !== undefined ? { files: (files as { path: string; text: string | null; append?: true }[]).map((f) => ({ path: f.path, text: f.text, ...(f.append === true ? { append: true } : {}) })) } : {}),
    };
    const r = service.stageScriptLibraryPatch(projectId, { ...(typeof stageId === 'string' ? { stageId } : {}), patch: patch as never });
    if (!r.ok) {
      sendError(res, workspaceError(r.error));
      return;
    }
    sendJson(res, 200, { ok: true, ...r.stage });
  };

  /**
   * `GET …/content/behaviors/:behaviorId/source` — the published
   * source-graph container of one behavior (the script editor loads it). The
   * digest comes from the behavior record; the bytes are the verified
   * immutable blob (`readSourceBlob`).
   */
  const behaviorSourceRead = (req: IncomingMessage, res: ServerResponse, projectId: string, behaviorId: string): void => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(behaviorId)) {
      sendError(res, sessionError('field_value', 'validation', 'behaviorId must use the project-model ID syntax', { path: '/behaviorId' }));
      return;
    }
    // includeDeclaration: the stored record (with its source facts, never bytes).
    const found = service.query({ op: 'queryBehaviors', projectId, args: { behaviorId, includeDeclaration: true, limit: 1, offset: 0 } }) as unknown as { ok: boolean; error?: CommandError; behaviors?: { behaviorId: string; source?: { sourceDigest: string } | null }[] };
    if (!found.ok && found.error?.code !== 'behavior_not_found') {
      sendError(res, workspaceError(found.error as CommandError));
      return;
    }
    const record = found.behaviors?.find((b) => b.behaviorId === behaviorId);
    if (record === undefined) {
      sendError(res, sessionError('field_value', 'not_found', `no behavior "${behaviorId}"`, { path: '/behaviorId' }), 404);
      return;
    }
    if (record.source === null || record.source === undefined) {
      sendJson(res, 200, { ok: true, behaviorId, source: null });
      return;
    }
    const read = service.readSourceBlob(projectId, { digest: record.source.sourceDigest });
    if (!read.ok) {
      sendError(res, workspaceError(read.error));
      return;
    }
    sendJson(res, 200, { ok: true, behaviorId, sourceDigest: read.digest, source: new TextDecoder().decode(read.bytes) });
  };

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '';
    const qIdx = url.indexOf('?');
    const p = qIdx === -1 ? url : url.slice(0, qIdx);
    const query = parseQuery(qIdx === -1 ? '' : url.slice(qIdx + 1));
    const method = req.method ?? 'GET';

    const found = originRejected(req);
    if (found !== null) {
      sendError(res, badOriginError(found), 403);
      return;
    }

    const parts = p.split('/').filter((x) => x.length > 0);

    try {
      if (parts[0] === 'api' && parts[1] === 'v1') {
        // GET /api/v1/projects/:projectId/content/textures/height-alpha?ids= — which textures carry a height in A (the layer palette's badge)
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'textures' && parts[6] === 'height-alpha') {
          await heightAlphaRoute(req, res, parts[3]!, query);
          return;
        }
        // /api/v1/projects/:projectId/content/decal-pages[/arrays/:id] — the decal atlas's pages, composed on request
        if (parts.length >= 6 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'decal-pages') {
          await decalAtlasRoute(req, res, parts, query);
          return;
        }
        // The additive behavior-source preparation route (before the
        // content route table so it is never shadowed).
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'behaviors' && parts[6] === 'source') {
          if (method === 'POST') {
            await behaviorSourceRoute(req, res, parts[3]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        if (parts.length === 8 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'behaviors' && parts[7] === 'source') {
          if (method === 'GET') {
            behaviorSourceRead(req, res, parts[3]!, decodeURIComponent(parts[6]!));
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
          return;
        }
        // Staged library edits (several patches; committed by commitScriptLibraryStage).
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'libraries' && parts[6] === 'stage') {
          if (method === 'POST') {
            await libraryStageRoute(req, res, parts[3]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // The script library check (compile only; nothing is written).
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'libraries' && parts[6] === 'check') {
          if (method === 'POST') {
            await libraryCheckRoute(req, res, parts[3]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // Content routes (before the fixed-length dispatch table).
        if (parts[2] === 'projects' && parts[4] === 'content') {
          const handled = await contentRoutes.handle(req, res, method, parts, query);
          if (handled) return;
        }
        // POST/GET /api/v1/sessions
        if (parts.length === 3 && parts[2] === 'sessions') {
          if (method === 'POST') {
            await establishSession(req, res);
            return;
          }
          if (method === 'GET') {
            await listSessions(req, res, query);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST or GET' }), 405);
          return;
        }
        // GET /api/v1/sessions/:sessionId/log
        if (parts.length === 5 && parts[2] === 'sessions' && parts[4] === 'log') {
          if (method === 'GET') {
            await sessionLog(req, res, parts[3]!, query);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
          return;
        }
        // GET /api/v1/engine — the engine this backend runs (commit, build, start, whether dist/ is newer)
        if (parts.length === 3 && parts[2] === 'engine') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          if (tokenScope(bearerToken(req), req) === null) {
            sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
            return;
          }
          sendJson(res, 200, { ok: true, engine: { ...engineInfo(), manual: await manualSummary(manual) } });
          return;
        }
        // GET /api/v1/docs — the manual and the generated reference of this build (topic, section or search)
        if (parts.length === 3 && parts[2] === 'docs') {
          await docsRoute(req, res, query);
          return;
        }
        // GET /api/v1/projects/:projectId/content/materials — the materials and their graph problems (paged)
        if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'materials') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          const projectId = parts[3]!;
          const authError = requireAuth(req, projectId, false);
          if (authError !== null) {
            sendError(res, authError);
            return;
          }
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
          return;
        }
        // GET /api/v1/projects — every project directory in the data root
        if (parts.length === 3 && parts[2] === 'projects') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          if (tokenScope(bearerToken(req), req) === null) {
            sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
            return;
          }
          const scan = service.scan();
          const engine = config.engineRoot !== undefined ? engineIdentity(config.engineRoot) : null;
          const projects = scan.entries
            .filter((e) => e.kind === 'project')
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
          sendJson(res, 200, { ok: true, projects, total: scan.total, truncated: scan.truncated });
          return;
        }
        // GET /api/v1/projects/resolve?path=<absolute server path> — which folder project a path belongs to
        if (parts.length === 4 && parts[2] === 'projects' && parts[3] === 'resolve') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          if (tokenScope(bearerToken(req), req) === null) {
            sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
            return;
          }
          const r = service.resolveFolder(query.get('path'));
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
          return;
        }
        // POST /api/v1/admin/projects/register { folder }
        if (parts.length === 5 && parts[2] === 'admin' && parts[3] === 'projects' && parts[4] === 'register') {
          if (method === 'POST') {
            await adminRegisterProject(req, res);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // GET /api/v1/templates — the project templates on this engine
        if (parts.length === 3 && parts[2] === 'templates') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          if (tokenScope(bearerToken(req), req) === null) {
            sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
            return;
          }
          sendJson(res, 200, { ok: true, templates: config.engineRoot === undefined ? [] : listTemplates(config.engineRoot) });
          return;
        }
        // GET /api/v1/packs — the content packs this engine ships
        if (parts.length === 3 && parts[2] === 'packs') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          if (tokenScope(bearerToken(req), req) === null) {
            sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
            return;
          }
          sendJson(res, 200, { ok: true, packs: config.engineRoot === undefined ? [] : listPacks(config.engineRoot) });
          return;
        }
        // POST /api/v1/projects/:projectId/history/group {requestIds, origin} — commands one user action ran made one
        // undo step. Only the caller's own: every entry must carry the origin the caller sends (as it sent it on those
        // commands), so a client cannot fold an agent's or another tab's commands into its step. Not a mutation (no
        // revision, no change event): it only changes how far one undo goes.
        if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'history' && parts[5] === 'group') {
          if (method !== 'POST') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
            return;
          }
          const projectId = parts[3]!;
          const authError = requireAuth(req, projectId, false);
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
          return;
        }
        // POST /api/v1/projects/:projectId/packs/:packId {origin?} — add an engine pack's items to the project
        if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'packs') {
          if (method !== 'POST') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
            return;
          }
          const projectId = parts[3]!;
          const authError = requireAuth(req, projectId, false);
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
          const o = strict.ok ? (strict.value as { origin?: { kind?: unknown; clientId?: unknown } } | null)?.origin : undefined;
          const origin = o !== undefined && (o.kind === 'browser' || o.kind === 'mcp') && typeof o.clientId === 'string' ? { kind: o.kind as 'browser' | 'mcp', clientId: o.clientId } : { kind: 'admin' as const, clientId: 'pack' };
          const r = packs.add(projectId, parts[5]!, origin);
          if (r.ok) sendJson(res, 200, r);
          else sendJson(res, r.status, { ok: false, error: { code: r.code, cls: r.status === 409 ? 'conflict' : 'validation', message: r.message }, ...(r.added !== undefined ? { added: r.added } : {}) });
          return;
        }
        // GET /api/v1/projects/:projectId/kits/:kitId/check[?image=1] — a kit against the trim sheet spec
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'kits' && parts[6] === 'check') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          const projectId = parts[3]!;
          const authError = requireAuth(req, projectId, false);
          if (authError !== null) {
            sendError(res, authError);
            return;
          }
          const r = await checks.kitChecker.check(projectId, decodeURIComponent(parts[5]!), { image: query.get('image') === '1' });
          if (r.ok) sendJson(res, 200, r);
          else sendJson(res, 404, { ok: false, error: { code: r.code, cls: 'validation', message: r.message } });
          return;
        }
        // GET /api/v1/projects/:projectId/exports — this project's export directories
        // GET /api/v1/projects/:projectId/exports/:dir/zip — one export as a stored zip
        if ((parts.length === 5 || parts.length === 7) && parts[2] === 'projects' && parts[4] === 'exports') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          const projectId = parts[3]!;
          const authError = requireAuth(req, projectId, false);
          if (authError !== null) {
            sendError(res, authError);
            return;
          }
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
          return;
        }
        // GET /api/v1/projects/:projectId/problems — the bounded problems log (newest last)
        if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'problems') {
          if (method !== 'GET') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          const projectId = parts[3]!;
          const authError = requireAuth(req, projectId, false);
          if (authError !== null) {
            sendError(res, authError);
            return;
          }
          // The graph materials with problems now (checked at the project's load and after each change).
          const rows = checks.materialRows(projectId);
          checks.loaded(projectId);
          // The missing asset files (the first page; the missing-files route pages them).
          const missing = missingFiles.firstPage(projectId);
          const list = problemLog.list(projectId);
          sendJson(res, 200, { ok: true, projectId, total: list.length, problems: list.slice(-50), ...(rows !== null ? { materialProblems: rows.filter((r) => r.problems.length > 0).slice(0, 64) } : {}), ...(missing !== null ? { missingFiles: missing } : {}) });
          return;
        }
        // GET /api/v1/projects/:projectId/problems/missing-files?offset=&limit= — one page of the missing asset files
        if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'problems' && parts[5] === 'missing-files') {
          missingFilesRoute(req, res, parts[3]!, query);
          return;
        }
        // POST /api/v1/projects/:projectId/external/(accept|discard)
        if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'external' && (parts[5] === 'accept' || parts[5] === 'discard')) {
          if (method === 'POST') {
            await external.resolveRoute(req, res, parts[3]!, parts[5]);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // POST /api/v1/projects/:projectId/commands
        if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'commands') {
          if (method === 'POST') {
            await commandRoute(req, res, parts[3]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // POST /api/v1/projects/:projectId/play
        if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'play') {
          if (method === 'POST') {
            await playStartRoute(req, res, parts[3]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // POST /api/v1/projects/:projectId/play/:playSessionId/stop|screenshot|diagnostics|input
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'play') {
          const projectId = parts[3]!;
          const psid = parts[5]!;
          const action = parts[6]!;
          // GET …/play/:playSessionId/snapshot — a snapshot too large for one WS frame.
          if (action === 'snapshot') {
            if (method === 'GET') {
              playSnapshotRoute(req, res, projectId, psid);
              return;
            }
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }), 405);
            return;
          }
          if (method !== 'POST') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
            return;
          }
          if (action === 'stop') {
            await playStopRoute(req, res, projectId, psid);
            return;
          }
          if (action === 'screenshot' || action === 'diagnostics') {
            await relayRoute(req, res, projectId, psid, action);
            return;
          }
          if (action === 'input') {
            await inputRelayRoute(req, res, projectId, psid);
            return;
          }
          // The bounded game control/observation relay.
          if (action === 'control') {
            await gameControlRoute(req, res, projectId, psid);
            return;
          }
          if (action === 'observe') {
            await gameObserveRoute(req, res, projectId, psid);
            return;
          }
          sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
          return;
        }
        // POST /api/v1/admin/projects
        if (parts.length === 4 && parts[2] === 'admin' && parts[3] === 'projects') {
          if (method === 'POST') {
            await adminCreateProject(req, res);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // POST /api/v1/admin/projects/:projectId/<op>
        if (parts.length === 6 && parts[2] === 'admin' && parts[3] === 'projects') {
          const op = parts[5]!;
          if (method !== 'POST') {
            sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
            return;
          }
          if (op === 'unregister') {
            await adminUnregisterProject(req, res, parts[4]!);
            return;
          }
          if (op === 'release' || op === 'takeover' || op === 'accept-external' || op === 'discard-external') {
            await adminProjectOp(req, res, op, parts[4]!);
            return;
          }
          if (op === 'export') {
            await adminExportRoute(req, res, parts[4]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
          return;
        }
        sendError(res, sessionError('invalid_request', 'not_found', 'unknown route'));
        return;
      }
    } catch (err) {
      logStartup(`route error: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, error: sessionError('invalid_request', 'internal', 'internal error') });
      return;
    }

    // Fallback: static editor bundle. The page gets its (non-secret) config
    // injected here; access tokens are never part of any served page.
    // Cross-origin isolated when configured (Play may then share memory with its worker).
    isolationHeaders(res);
    if (p === '/' || p === '/index.html') {
      serveEditorPage(res, trustedRequest(req));
      return;
    }
    serveStatic(res, config.editorStaticDir, p);
  };

  // The prebuilt play scripts (bundle, worker, physics), read once per build, at digest-keyed URLs.
  const playBuild = createPlayBuildCache(config.previewStaticDir);
  const { playStartRoute, playStopRoute, playSnapshotRoute, relayRoute, inputRelayRoute, gameControlRoute, gameObserveRoute, warmPlay: warmPlayBuild } = makePlayRoutes({ config, nowMs, logStartup, behaviorCompiler, service, sessions, playContent, plays, relayTimeoutMs, sendJson, sendError, bearerToken, tokenScope, badOriginError, requireAuth, readBody, fullState, workspaceError, connectedOwner, unavailableError, recordProblem, headless, playBuild, ensureImported: assetFiles.ensureImported, textureSlots });
  warmPlay = warmPlayBuild;

  const pinWarned = new Set<string>();
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

  authoringServer.on('request', (req, res) => {
    void dispatch(req, res);
  });
  previewServer.on('request', (req, res) => {
    dispatchPreview(req, res);
  });

  const { establishSession, listSessions, sessionLog, commandRoute } = makeSessionRoutes({ timeouts, nowMs, service, sessions, sendJson, sendError, bearerToken, tokenScope, requireAuth, readBody, fullState, workspaceError, sessionView, recordProblem, notifyMutationApplied, headless, folderImport, textures, erosion: createErosionRunner(EROSION_WORKER), onOwnerLost: (sessionId: string, detail?: string) => plays.onOwnerDisconnected(sessionId, detail) });

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
        void headless.dispose();
        channel.stopSweep();
        external.dispose();
        plays.dispose();
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
    _test: { sessions, plays, startupLog, service, contentRoutes, playContent, textureSlots, decalPages },
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

