/**
 * The M1 backend — sessions.md §4–§13 (packet 09).
 *
 * One process, two listeners (sessions.md §2):
 * - the authoring origin `O_A`: the HTTP API (`/api/v1/…`), the WS channel
 *   (`/api/v1/ws`), and the editor static bundle;
 * - the preview origin `O_P`: the static preview page only — a small HTML
 *   template injecting the checked message-bridge config (§13.2) + the
 *   static bundle. No API endpoints, no WS, no credentials.
 *
 * All persistent changes delegate to the workspace service (the sole
 * command executor — dependencies.md §4.3). The transport never mutates
 * files independently.
 *
 * Exported as `@thirdlight/backend/services` (the stable surface the MCP
 * adapter, packet 11, imports); the default subpath is the executable
 * bootstrap (the owner-deployment entry point).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { listTemplates } from './templates';
import { isExportDirOf, listExports, zipDirectory } from './exports';
import { makeAttached, makeErrorEvent, makePong, parseStrictJsonBytes, parseInboundEvent, encodeBinaryFreeStateFrame, sessionError, statusFor, WS_OUT_FRAME_MAX, WS_SCREENSHOT_ACK_MAX, enforceDefaultFrameBound, validateGameControlResult, validateGameObservation, type SessionError } from '@thirdlight/protocol';
import { openWorkspaceService, readMarker, type CommandError, type WorkspaceService } from '@thirdlight/workspace';
import { mergeTimeouts, parseBackendConfig, type BackendConfig } from './config';
import { publishBehaviorSource } from './behavior';
import { ContentRoutes, createAssetInspector, createBehaviorCompilerPort } from './content';
import { createFbxConverter } from './fbx';
import { isTrustedRequest, parseCidrList } from './trusted';
import { PlayContentStore } from './play-content';
import { SessionRegistry, type SessionRecord } from './sessions';
import { PlayManager, type PlayRecord } from './play';
import { makeSessionRoutes } from './session-routes';
import { makePreviewRoutes } from './preview-routes';
import { makeStaticRoutes } from './static-routes';
import { makeAdminRoutes } from './admin-routes';
import { makePlayRoutes } from './play-routes';
import { comparePin, engineIdentity } from './engine';

import { MAX_DIAGNOSTICS, MAX_HTTP_BODY, MAX_SCREENSHOT, SESSION_LIST_MAX, STARTUP_LOG_RING, utf8Len, type OriginDoc } from './util';
export { MAX_DIAGNOSTICS, MAX_HTTP_BODY, MAX_SCREENSHOT, SESSION_LIST_MAX, STARTUP_LOG_RING };

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
  };
}

/** One recorded problem: bounded, log-safe (no secrets, no host paths). */
export interface Problem {
  seq: number;
  at: string;
  source: 'command' | 'import' | 'compile' | 'play' | 'export' | 'workspace';
  code: string;
  message: string;
}

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

  // Startup static checks (sessions.md §13.7: missing bundle ⇒ structured
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
    logStartup(`startup_invalid: static bundle check failed (${missing.join(', ')}); run the editor build (decision 0004) first`);
    return { ok: false, error: { message: 'static bundle check failed — run the editor build (decision 0004) first', missing } };
  }
  mkdirSync(config.dataRoot, { recursive: true });
  if (config.exportRoot !== undefined) mkdirSync(config.exportRoot, { recursive: true });

  // Packet 35: one compiler instance for both the injected workspace path and
  // the play build's deterministic behavior-output recompilation.
  const behaviorCompiler = createBehaviorCompilerPort(nowMs);
  const service: WorkspaceService = openWorkspaceService({
    root: config.dataRoot,
    backendId: config.backendId,
    processMarker: config.processMarker,
    // Packet 25: the backend constructs the pure `asset-pipeline` inspector
    // and injects it into the workspace (dependencies.md §4.1). The
    // workspace owns the staged-byte read; the transport never touches a file.
    assetInspector: createAssetInspector(),
    // Packet 33: the backend constructs the pinned behavior-source compiler
    // (`behavior-build`) and injects it — the workspace's preparation layer
    // drives it; the compiler never reads a path or executes project source.
    behaviorCompiler,
    // Phase 12 (c): projects are one file per scene (storage v4); a v3
    // project is upgraded when it is opened.
    storageV4: true,
  });
  const sessions = new SessionRegistry();
  const tokenScopes = new Map<string, string>();
  for (const t of config.tokens) tokenScopes.set(t.token, t.scope);

  logStartup(
    `starting: dataRoot=${config.dataRoot} authoring=${config.authoringOrigin} preview=${config.previewOrigin}`,
  );

  // Packet 35: the immutable play-content artifact store (sessions.md §17).
  const playContent = new PlayContentStore({ now: nowMs });

  const plays = new PlayManager({
    sendToOwner: (ownerSessionId, payload) => {
      const s = sessions.sessionForSessionId(ownerSessionId);
      if (!s || !s.connected || !s.socket) return false;
      if (utf8Len(payload) > WS_OUT_FRAME_MAX) {
        logStartup(`outbound frame exceeds the 1 MiB bound (play=${ownerSessionId}); dropped (internal)`);
        return false;
      }
      try {
        s.socket.send(payload);
        return true;
      } catch {
        return false;
      }
    },
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
    nowMs,
  });

  /** The §11.5 relay ack timeout (the §20 control relay shares it). */
  const relayTimeoutMs = (): number => timeouts.relayTimeoutSeconds * 1000;

  const wss = new WebSocketServer({ noServer: true });  const authoringServer = createServer();
  const previewServer = createServer();
  let closed = false;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  // ---------- helpers ----------

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.setHeader('content-type', 'application/json');
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

  const sendError = (res: ServerResponse, error: SessionError, statusOverride?: number): void => {
    // §11.2 normative mapping, with the contract's explicit exceptions:
    // unauthorized ⇒ 401 (§4.1), bad_origin / session_required ⇒ 403
    // (§4.2/§6.1).
    let status = statusFor(error.cls);
    if (error.code === 'unauthorized') status = 401;
    if (error.code === 'bad_origin' || error.code === 'session_required') status = 403;
    if (statusOverride !== undefined) status = statusOverride;
    sendJson(res, status, { ok: false, error });
  };

  const bearerToken = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return null;
    const m = h.match(/^Bearer\s+(\S+)$/);
    return m?.[1] ?? null;
  };

  // A request from a trusted network (config.trustedNetworks, through a
  // listed proxy's X-Forwarded-For) is the owner without a token. The Origin
  // allowlist still applies to it.
  const trustedNetworks = parseCidrList(config.trustedNetworks);
  const trustedProxies = parseCidrList(config.trustedProxies);
  const trustedRequest = (req: IncomingMessage): boolean =>
    isTrustedRequest(req as unknown as Parameters<typeof isTrustedRequest>[0], trustedNetworks, trustedProxies);
  const tokenScope = (token: string | null, req?: IncomingMessage): string | null => {
    const scope = token === null ? null : (tokenScopes.get(token) ?? null);
    if (scope !== null) return scope;
    return req !== undefined && trustedRequest(req) ? 'admin' : null;
  };

  /** §4.2: absent `Origin` header ⇒ not checked; present ⇒ exact match. */
  const originRejected = (req: IncomingMessage): string | null => {
    const o = req.headers.origin;
    if (typeof o !== 'string') return null;
    return config.authoringOrigins.includes(o) ? null : o;
  };

  const badOriginError = (found: string): SessionError =>
    sessionError('bad_origin', 'validation', 'Origin is not in the authoring allowlist', { found: found.slice(0, 256) });

  /**
   * Auth for a project-scoped route: an `authoring:<projectId>` token for
   * this project, or an `admin` token (adminOnly: `admin` only).
   */
  const requireAuth = (req: IncomingMessage, projectId: string, adminOnly: boolean): SessionError | null => {
    const scope = tokenScope(bearerToken(req), req);
    if (scope === null) return sessionError('unauthorized', 'validation', 'a valid bearer token is required');
    if (adminOnly) {
      return scope === 'admin' ? null : sessionError('unauthorized', 'validation', 'this route requires an admin token');
    }
    if (scope === 'admin') return null;
    if (scope === `authoring:${projectId}`) return null;
    return sessionError('unauthorized', 'validation', 'the token scope does not cover this project');
  };

  // Packet 25 content transport (bounded uploads, jobs, content queries and
  // the authenticated asset-byte read). It delegates every write/read to the
  // injected workspace service and performs no filesystem work itself.
  const contentRoutes = new ContentRoutes({
    service,
    now: nowMs,
    sendJson,
    sendError,
    requireAuth,
    log: logStartup,
    onJobFailed: (projectId, kind, code, message) => recordProblem(projectId, 'import', code, `Import ${kind} failed: ${message}`),
    fbx: createFbxConverter({ blender: config.blenderPath ?? 'blender', workRoot: join(config.dataRoot, '.convert') }),
  });


  const readBody = (req: IncomingMessage): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: SessionError }> =>
    new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk: Uint8Array) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_HTTP_BODY) {
          done = true;
          resolve({ ok: false, error: sessionError('invalid_request', 'validation', 'request body exceeds the 1 MiB bound') });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        const bytes = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
        resolve({ ok: true, bytes });
      });
      req.on('error', () => {
        if (!done) {
          done = true;
          resolve({ ok: false, error: sessionError('invalid_request', 'validation', 'request body read failed') });
        }
      });
    });

  const parseQuery = (qs: string): Map<string, string> => {
    const out = new Map<string, string>();
    if (qs.length === 0) return out;
    for (const pair of qs.split('&')) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      try {
        out.set(decodeURIComponent(k), decodeURIComponent(v));
      } catch {
        // un-decodable pair: dropped
      }
    }
    return out;
  };

  /**
   * The full current project state (manifest + full scene + history +
   * workspace), composed from the workspace's public query API (the
   * transport never reads files directly).
   */
  /**
   * The bounded content projection for the full-state payload (packet 25):
   * summary pages only (never definitions, declarations, versions or bytes),
   * composed from the workspace's public query surface. Returns undefined for
   * a project whose queries fail (the scene full state is still served).
   */
  const contentProjection = (projectId: string): Record<string, unknown> | undefined => {
    const assets = service.query({ op: 'queryAssets', projectId, args: { limit: 128, offset: 0 } });
    const prefabs = service.query({ op: 'queryPrefabs', projectId, args: { limit: 128, offset: 0 } });
    const behaviors = service.query({ op: 'queryBehaviors', projectId, args: { limit: 128, offset: 0 } });
    if (!assets.ok || !prefabs.ok || !behaviors.ok) return undefined;
    const a = assets as unknown as { assets: unknown };
    const p = prefabs as unknown as { prefabs: unknown };
    const b = behaviors as unknown as { behaviors: unknown };
    return {
      assets: a.assets,
      prefabs: p.prefabs,
      behaviors: b.behaviors,
    };
  };

  const fullState = (projectId: string):
    | {
        ok: true;
        revision: number;
        manifest: Record<string, unknown>;
        scene: Record<string, unknown>;
        history: Record<string, unknown>;
        workspace: Record<string, unknown>;
        content?: Record<string, unknown>;
      }
    | { ok: false; error: SessionError; status: number } => {
    const q = service.query({ op: 'queryProject', projectId });
    if (!q.ok) {
      return { ok: false, error: workspaceError(q.error), status: statusFor(q.error.cls) };
    }
    if (!('manifest' in q)) {
      // queryProject always yields the project shape; this is a defensive
      // guard so the code below narrows to `QueryProjectResult`.
      return { ok: false, status: 500, error: sessionError('invalid_request', 'internal', 'unexpected query shape') };
    }
    const e = service.query({ op: 'queryEntities', projectId, args: { limit: 1024, offset: 0 } });
    if (!e.ok) {
      return { ok: false, error: workspaceError(e.error), status: statusFor(e.error.cls) };
    }
    if (!('entities' in e)) {
      return { ok: false, status: 500, error: sessionError('invalid_request', 'internal', 'unexpected query shape') };
    }
    if (e.total > 1024) {
      return {
        ok: false,
        status: 503,
        error: sessionError('project_unavailable', 'unavailable', 'scene exceeds the 1024-entity session bound (M1)'),
      };
    }
    const scene: Record<string, unknown> = {
      // C35-5 / sessions.md §19.x: the SCENE document's `schemaVersion`
      // (1/2/3) — never the manifest's (always 1).
      schemaVersion: q.scene.schemaVersion,
      sceneId: q.scene.sceneId,
      revision: q.revision,
      entities: [...e.entities],
    };
    const content = contentProjection(projectId);
    return {
      ok: true,
      revision: q.revision,
      manifest: q.manifest as unknown as Record<string, unknown>,
      scene,
      history: q.history as unknown as Record<string, unknown>,
      workspace: q.workspace as unknown as Record<string, unknown>,
      ...(content !== undefined ? { content } : {}),
    };
  };

  /** Surface a workspace/command error through the session layer unchanged
   * (sessions.md §11.3: "Workspace codes … surface through these operations
   * unchanged"). */
  const workspaceError = (e: CommandError): SessionError =>
    sessionError(e.code as SessionError['code'], e.cls as SessionError['cls'], e.message, {
      ...(e.hint !== undefined ? { hint: e.hint } : {}),
      ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      ...(e.holder !== undefined ? { holder: e.holder } : {}),
    });

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

  /** `session_unavailable` with the §10.4 hint. */
  const unavailableError = (playSessionId: string | undefined, hint: string): SessionError =>
    sessionError('session_unavailable', 'unavailable', hint, {
      ...(playSessionId !== undefined ? { playSessionId } : {}),
      hint,
    });

  /**
   * Deliver `mutation.applied` to the project's registered session (§6.2:
   * every applied mutation, of any origin). No-op when absent/disconnected.
   */
  // ---------- project problems log (editor Problems tab + MCP) ----------
  const PROBLEMS_PER_PROJECT = 200;
  const problems = new Map<string, Problem[]>();
  let problemSeq = 0;
  const recordProblem = (projectId: string, source: Problem['source'], code: string, message: string): void => {
    problemSeq += 1;
    const entry: Problem = { seq: problemSeq, at: new Date(nowMs()).toISOString(), source, code, message: message.slice(0, 256) };
    const list = problems.get(projectId) ?? [];
    list.push(entry);
    if (list.length > PROBLEMS_PER_PROJECT) list.splice(0, list.length - PROBLEMS_PER_PROJECT);
    problems.set(projectId, list);
    const s = sessions.sessionForProject(projectId);
    if (s && s.connected && s.socket) {
      try {
        s.socket.send(JSON.stringify({ type: 'problems.added', problem: entry }));
      } catch {
        // the Problems query returns it anyway
      }
    }
  };

  const notifyMutationApplied = (
    projectId: string,
    requestId: string,
    revision: number,
    origin: OriginDoc | null,
    change: unknown,
  ): void => {
    const s = sessions.sessionForProject(projectId);
    if (!s || !s.connected || !s.socket) return;
    // §11.6/§17.6: a full-state/change frame never carries GLB or source bytes.
    const payload = encodeBinaryFreeStateFrame({ type: 'mutation.applied', requestId, revision, origin, change }, WS_OUT_FRAME_MAX);
    if (payload === null) {
      logStartup('mutation.applied frame contained binary data or exceeded the 1 MiB bound; dropped (internal)');
      return;
    }
    try {
      s.socket.send(payload);
    } catch {
      // best-effort: the authoritative result went to the caller over HTTP
    }
  };

  // ---------- WS handling ----------

  const attachSocket = (ws: WebSocket, session: SessionRecord): void => {
    const state = fullState(session.projectId);
    if (!state.ok) {
      ws.close(1011, 'backend_error');
      sessions.record(session, 'error', session.sessionId, undefined, nowMs(), 'attach_failed');
      return;
    }
    sessions.bindSocket(session, ws);
    ws.send(makeAttached(session.connId, state.revision));
    // One-shot `play.started` delivery (sessions.md §7.1).
    if (session.pendingPlayStarted !== null) {
      const held = session.pendingPlayStarted;
      session.pendingPlayStarted = null;
      const rec = plays.get(held.playSessionId);
      if (rec !== undefined && (rec.state === 'active' || rec.state === 'presented')) {
        ws.send(held.payload);
        sessions.record(session, 'play', held.playSessionId, rec.revision, nowMs(), 'started_delivered');
      }
    }
    ws.on('message', (data: Uint8Array) => {
      sessions.touch(session, nowMs());
      handleMessage(ws, session, data);
    });
    let detached = false;
    const onDetach = (): void => {
      if (detached) return;
      const s = sessions.sessionForSessionId(session.sessionId);
      // Only the connection currently bound to the session detaches it —
      // a re-attach race may leave a stale socket closing after the new
      // one bound (§5.1).
      if (!s || s.socket !== ws) return;
      detached = true;
      const replaced = sessions.isReplaced(ws);
      sessions.detachSocket(session, nowMs());
      // A replaced socket (closed by a re-attach) is not an owner loss —
      // the owner is binding a fresh connection.
      if (!replaced) plays.onOwnerDisconnected(session.sessionId);
    };
    ws.on('close', onDetach);
    ws.on('error', onDetach);
  };

  /** Count a protocol error; close 1008 at the 10/60 s bound (§5.2). */
  const countProtocolError = (ws: WebSocket, session: SessionRecord): void => {
    const count = sessions.noteProtocolError(session, nowMs(), timeouts.protocolErrorWindowSeconds * 1000);
    if (count >= timeouts.protocolErrorLimit) {
      ws.close(1008, 'protocol_error');
    }
  };

  const handleMessage = (ws: WebSocket, session: SessionRecord, data: Uint8Array): void => {
    // Frame bounds (§5.2/§11.5): hard cap 1.5 MiB (the screenshot.ack
    // bound); the 64 KiB default applies to everything else.
    if (data.length > WS_SCREENSHOT_ACK_MAX) {
      ws.close(1009, 'frame_too_big');
      return;
    }
    const parsed = parseStrictJsonBytes(data);
    if (!parsed.ok) {
      sessions.record(session, 'error', 'protocol_error', undefined, nowMs(), parsed.error.message.slice(0, 128));
      countProtocolError(ws, session);
      ws.send(makeErrorEvent('protocol_error', parsed.error.message));
      return;
    }
    if (!enforceDefaultFrameBound(data.length, parsed.value)) {
      ws.close(1009, 'frame_too_big');
      return;
    }
    // Re-validate as a catalog event (the strict shape check; unknown
    // types are a distinct, survivable outcome — §7).
    const verdict = parseInboundEvent(parsed.value);
    if (!verdict.ok) {
      if (verdict.kind === 'unknown_event') {
        sessions.record(session, 'error', verdict.type, undefined, nowMs(), 'unknown_event');
        countProtocolError(ws, session);
        ws.send(makeErrorEvent('unknown_event', verdict.type));
        return;
      }
      sessions.record(session, 'error', 'protocol_error', undefined, nowMs(), verdict.error.message.slice(0, 128));
      countProtocolError(ws, session);
      ws.send(makeErrorEvent('protocol_error', verdict.error.message));
      return;
    }
    const inbound = verdict.event;
    switch (inbound.type) {
      case 'ping':
        ws.send(makePong());
        return;
      case 'selection.changed':
        session.selection = [...inbound.entityIds];
        return;
      case 'play.preview.ready':
      case 'play.preview.failed':
      case 'play.stopped.ack': {
        const rec = plays.get(inbound.playSessionId);
        if (rec === undefined || rec.ownerSessionId !== session.sessionId) {
          sessions.record(session, 'error', inbound.playSessionId, undefined, nowMs(), 'event for unknown play');
          return;
        }
        if (inbound.type === 'play.preview.ready') {
          plays.markPresented(rec.playSessionId);
          sessions.record(session, 'play', rec.playSessionId, rec.revision, nowMs(), 'presented');
          return;
        }
        if (inbound.type === 'play.preview.failed') {
          recordProblem(session.projectId, 'play', inbound.code, `Play failed: ${inbound.message ?? inbound.code}`);
          plays.previewFailed(rec.playSessionId, inbound.code);
          return;
        }
        plays.onStoppedAck(rec.playSessionId);
        return;
      }
      case 'screenshot.ack':
      case 'play.diagnostics.ack': {
        const kind = inbound.type === 'screenshot.ack' ? 'screenshot' : 'diagnostics';
        // The ack carries the relayId; the relay map is authoritative for
        // routing (§12 step 6).
        const target = plays.findRelay(inbound.relayId);
        if (target === undefined || target.ownerSessionId !== session.sessionId) {
          sessions.record(session, kind, inbound.relayId, undefined, nowMs(), 'unknown_relay');
          return;
        }
        plays.resolveRelay(target.playSessionId, inbound.relayId, inbound);
        sessions.record(session, kind, inbound.relayId, target.revision, nowMs(), inbound.ok ? 'ok' : 'failed');
        return;
      }
      case 'input.result': {
        const target = plays.findRelayByInput(inbound.requestId);
        if (target === undefined || target.ownerSessionId !== session.sessionId) {
          sessions.record(session, 'play', inbound.requestId, undefined, nowMs(), 'unknown_input_relay');
          return;
        }
        plays.resolveInputRelay(target.playSessionId, inbound.requestId, inbound);
        sessions.record(session, 'play', inbound.requestId, target.revision, nowMs(), inbound.ok ? 'input_ok' : 'input_failed');
        return;
      }
      case 'game.control.ack':
      case 'game.observe.ack': {
        // §20.1: the editor relays the preview's EXACT result (never fabricates).
        // The relay map is authoritative for routing by relayId; an
        // unknown/wrong-session ack is dropped and counted (it never resolves a
        // pending relay owned by another session).
        const target = plays.findGameRelay(inbound.relayId);
        if (target === undefined || target.ownerSessionId !== session.sessionId) {
          sessions.record(session, 'play', inbound.relayId, undefined, nowMs(), inbound.type === 'game.control.ack' ? 'unknown_game_relay' : 'unknown_game_observe_relay');
          return;
        }
        const validate =
          inbound.type === 'game.control.ack'
            ? (r: unknown): boolean => validateGameControlResult(r).ok
            : (r: unknown): boolean => validateGameObservation(r).ok;
        plays.resolveGameRelay(target.playSessionId, inbound.relayId, inbound, validate);
        sessions.record(session, 'play', inbound.relayId, target.revision, nowMs(), inbound.ok ? 'game_ok' : 'game_failed');
        return;
      }
      default:
        return;
    }
  };

  // The upgrade path (sessions.md §4.3): the token is verified at upgrade;
  // any failure ⇒ close 1008 with the reason code.
  authoringServer.on('upgrade', (req: IncomingMessage, socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer) => {
    const sock = socket;
    const qIdx = (req.url ?? '').indexOf('?');
    const p = qIdx === -1 ? (req.url ?? '') : (req.url ?? '').slice(0, qIdx);
    const query = qIdx === -1 ? '' : (req.url ?? '').slice(qIdx + 1);
    if (p !== '/api/v1/ws') {
      const body = JSON.stringify({ ok: false, error: sessionError('invalid_request', 'validation', 'unknown route') });
      sock.write(`HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${utf8Len(body)}\r\nconnection: close\r\n\r\n${body}`);
      sock.destroy();
      return;
    }
    // Upgrade first, then verify and close 1008 with the reason code on
    // failure (the contract's failure shape — §4.3 step 2).
    const closeAfter = (reason: string): void => {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(1008, reason));
    };
    const found = originRejected(req);
    if (found !== null) {
      logStartup(`ws upgrade rejected: bad_origin`);
      closeAfter('bad_origin');
      return;
    }
    const q = parseQuery(query);
    const sessionId = q.get('sessionId');
    const wsToken = q.get('wsToken');
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof wsToken !== 'string' || wsToken.length === 0) {
      closeAfter('ws_token_invalid');
      return;
    }
    const outcome = sessions.consumeWsToken(wsToken, sessionId, nowMs());
    if (!outcome.ok) {
      logStartup(`ws upgrade rejected: ${outcome.code}`);
      closeAfter(outcome.code);
      return;
    }
    const session = outcome.session;
    const oldSocket = session.socket;
    if (oldSocket !== null) {
      // Re-attach: the old connection, if still open, is closed and
      // logged (1000, reason `detached`) — §5.1. Mark it replaced so its
      // onDetach does NOT treat this as an owner loss (the owner is
      // re-attaching, not gone).
      sessions.markReplaced(oldSocket);
      try {
        oldSocket.close(1000, 'detached');
      } catch {
        // already gone
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSocket(ws, session);
    });
  });

  // ---------- routes ----------

  /**
   * `POST /api/v1/projects/:projectId/content/behaviors/source` — the additive
   * behavior-source preparation+publication route (packet 35; contract-change
   * request C35-4: sessions.md §19.1 lists no behavior-build route, so the
   * packet-34 editor path could only surface `behavior_publication_unavailable`).
   *
   * It runs the EXISTING packet-33 facade: stage read → trust gate → injected
   * compile → immutable blob, then the ordinary `publishBehavior{mode:'source'}`
   * command through `workspace.runCommand` (the sole executor). No second
   * commit path, no code evaluation.
   */
  const behaviorSourceRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
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
      if (!['stageId', 'bytesBase64', 'behaviorId', 'displayName', 'declaration', 'expectedRevision', 'requestId'].includes(key)) {
        sendError(res, sessionError('field_unexpected', 'validation', `unknown field "${key}"`, { path: `/${key}` }));
        return;
      }
    }
    const behaviorId = value.behaviorId;
    const displayName = value.displayName;
    const declaration = value.declaration;
    const expectedRevision = value.expectedRevision;
    const requestId = value.requestId;
    const stageId = value.stageId;
    if (typeof behaviorId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(behaviorId)) {
      sendError(res, sessionError('field_value', 'validation', 'behaviorId must use the project-model ID syntax', { path: '/behaviorId' }));
      return;
    }
    if (typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 128) {
      sendError(res, sessionError('field_value', 'validation', 'displayName must be a 1–128 character string', { path: '/displayName' }));
      return;
    }
    if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
      sendError(res, sessionError('field_type', 'validation', 'declaration must be a property-declaration object', { path: '/declaration' }));
      return;
    }
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      sendError(res, sessionError('field_value', 'validation', 'expectedRevision must be an integer ≥ 0', { path: '/expectedRevision' }));
      return;
    }
    if (typeof requestId !== 'string' || !/^req-[0-9a-f]{32}$/.test(requestId)) {
      sendError(res, sessionError('field_value', 'validation', 'requestId must be req- + 32 hex', { path: '/requestId' }));
      return;
    }
    const session = sessions.sessionForProject(projectId);
    const outcome = await publishBehaviorSource(service, {
      projectId,
      ...(typeof stageId === 'string' ? { stageId } : {}),
      behaviorId,
      displayName,
      declaration: declaration as never,
      expectedRevision,
      requestId,
      origin: session !== undefined ? { kind: 'browser', clientId: session.sessionId } : { kind: 'admin', clientId: 'operator' },
    });
    if (outcome.ok) {
      sendJson(res, 200, {
        ok: true,
        behaviorId,
        sourceDigest: outcome.prepared.sourceDigest,
        outputDigest: outcome.prepared.outputDigest,
        revision: outcome.result.revision,
        requestId,
      });
      return;
    }
    if (outcome.kind === 'compile') {
      recordProblem(projectId, 'compile', outcome.failure.code, `Script ${behaviorId} failed to compile: ${outcome.failure.reason}`);
      sendJson(res, 400, {
        ok: false,
        error: {
          code: outcome.failure.code,
          cls: 'validation',
          message: outcome.failure.reason.slice(0, 256),
          diagnostics: outcome.failure.diagnostics.slice(0, 32),
        },
      });
      return;
    }
    sendJson(res, statusFor(outcome.error.cls), { ok: false, error: outcome.error });
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
        // Packet 35: the additive behavior-source preparation route (before the
        // content route table so it is never shadowed).
        if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'content' && parts[5] === 'behaviors' && parts[6] === 'source') {
          if (method === 'POST') {
            await behaviorSourceRoute(req, res, parts[3]!);
            return;
          }
          sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'POST' }), 405);
          return;
        }
        // Packet 25 content routes (before the M1-length dispatch table).
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
        // GET /api/v1/templates — the project templates/samples on this engine
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
          const list = problems.get(projectId) ?? [];
          sendJson(res, 200, { ok: true, projectId, total: list.length, problems: list.slice(-50) });
          return;
        }
        // POST /api/v1/projects/:projectId/external/(accept|discard)
        if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'external' && (parts[5] === 'accept' || parts[5] === 'discard')) {
          if (method === 'POST') {
            await externalResolveRoute(req, res, parts[3]!, parts[5]);
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
          // Packet 48: the §20 bounded game control/observation relay.
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
    if (p === '/' || p === '/index.html') {
      serveEditorPage(res, trustedRequest(req));
      return;
    }
    serveStatic(res, config.editorStaticDir, p);
  };

  const sendToProject = (projectId: string, frame: Record<string, unknown>): void => {
    const s = sessions.sessionForProject(projectId);
    if (!s || !s.connected || !s.socket) return;
    try {
      s.socket.send(JSON.stringify(frame));
    } catch {
      // best effort: the next full state carries the same facts
    }
  };
  const externalTimer = setInterval(() => {
    for (const s of sessions.all()) {
      if (!s.connected) continue;
      const r = service.checkExternal(s.projectId);
      if (!r.ok || !r.pending) {
        externalAnnounced.delete(s.projectId);
        continue;
      }
      if (externalAnnounced.has(s.projectId)) continue;
      externalAnnounced.add(s.projectId);
      const q = service.query({ op: 'queryProject', projectId: s.projectId }) as { ok: boolean; workspace?: unknown };
      const valid = (q.workspace as { pendingChange?: { externalValid?: boolean | null } } | undefined)?.pendingChange?.externalValid;
      recordProblem(
        s.projectId,
        'workspace',
        'external_change',
        valid === false ? 'The scene file was changed on disk and is invalid; editing is paused.' : 'The scene file was changed on disk; editing is paused.',
      );
      sendToProject(s.projectId, { type: 'workspace.externalChange', workspace: q.ok ? q.workspace : null });
    }
  }, 1500);

  /** POST /api/v1/projects/:projectId/external/(accept|discard) — resolve an external edit. */
  const externalResolveRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, action: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const result = action === 'accept' ? service.acceptExternalState(projectId) : service.discardExternalState(projectId);
    if (!result.ok) {
      sendError(res, workspaceError(result.error), statusFor(result.error.cls));
      return;
    }
    externalAnnounced.delete(projectId);
    sendToProject(projectId, { type: 'workspace.resync' });
    sendJson(res, 200, result);
  };

  // The §11.5 silent-drop sweeper (60 s ⇒ close 1000 `heartbeat_timeout`).
  const sweepIntervalMs = Math.max(250, (timeouts.silentDropSeconds * 1000) / 4);
  sweepTimer = setInterval(() => {
    const now = nowMs();
    for (const s of sessions.all()) {
      if (s.connected && s.socket !== null && now - s.lastActivityAt > timeouts.silentDropSeconds * 1000) {
        try {
          s.socket.close(1000, 'heartbeat_timeout');
        } catch {
          // already gone
        }
      }
    }
  }, sweepIntervalMs);

  const { playStartRoute, playStopRoute, relayRoute, inputRelayRoute, gameControlRoute, gameObserveRoute } = makePlayRoutes({ config, nowMs, logStartup, behaviorCompiler, service, sessions, playContent, plays, relayTimeoutMs, sendJson, sendError, bearerToken, tokenScope, badOriginError, requireAuth, readBody, fullState, workspaceError, connectedOwner, unavailableError, recordProblem });

  const pinWarned = new Set<string>();
  const { adminCreateProject, adminRegisterProject, adminUnregisterProject, adminProjectOp, adminExportRoute } = makeAdminRoutes({ config, behaviorCompiler, service, sendJson, sendError, requireAuth, readBody, workspaceError, recordProblem });

  const { serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml } = makeStaticRoutes({ config, sendJson });

  const { serveEditorPage, dispatchPreview } = makePreviewRoutes({ config, logStartup, playContent, sendJson, parseQuery, serveStatic, previewCsp, locatorBaseHeaders, previewTemplate, previewShellHtml });

  authoringServer.on('request', (req, res) => {
    void dispatch(req, res);
  });
  previewServer.on('request', (req, res) => {
    dispatchPreview(req, res);
  });

  // External edits: while an editor is connected, compare its project's
  // envelope on disk with what this backend wrote. A change pauses writes and
  // is announced once; the editor resolves it (accept / discard).
  const externalAnnounced = new Set<string>();


  const { establishSession, listSessions, sessionLog, commandRoute } = makeSessionRoutes({ timeouts, nowMs, service, sessions, sendJson, sendError, bearerToken, tokenScope, requireAuth, readBody, fullState, workspaceError, sessionView, recordProblem, notifyMutationApplied });

  const backend: Backend = {
    config,
    ready: new Promise<Backend>((resolveP, rejectP) => {
      const fail = (err: Error): void => {
        rejectP(err);
      };
      authoringServer.once('error', fail);
      previewServer.once('error', fail);
      authoringServer.listen(bindPort(config.authoringBind), bindHost(config.authoringBind), () => {
        previewServer.listen(bindPort(config.previewBind), bindHost(config.previewBind), () => {
          authoringServer.off('error', fail);
          previewServer.off('error', fail);
          logStartup('listening: both origins bound');
          resolveP(backend);
        });
      });
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
        if (sweepTimer !== undefined) clearInterval(sweepTimer);
        clearInterval(externalTimer);
        plays.dispose();
        contentRoutes.dispose();
        playContent.dispose();
        for (const s of sessions.all()) {
          if (s.connected && s.socket !== null) {
            try {
              s.socket.close(1001, 'server_closing');
            } catch {
              // already gone
            }
          }
        }
        wss.close(() => {
          authoringServer.close(() => {
            previewServer.close(() => {
              service.close();
              resolveClose();
            });
          });
        });
      }),
    _test: { sessions, plays, startupLog, service, contentRoutes, playContent },
  };

  return { ok: true, backend };
}

/** `host:port` → the host to bind (tests bind port 0; the port part of the
 * configured bind is the deployment's). */
function bindHost(bind: string): string {
  const idx = bind.lastIndexOf(':');
  return idx === -1 ? bind : bind.slice(0, idx);
}

/** The configured port (port 0 ⇒ ephemeral — test behavior, sessions.md §13.7). */
function bindPort(bind: string): number {
  const idx = bind.lastIndexOf(':');
  return idx === -1 ? 0 : Number(bind.slice(idx + 1));
}

