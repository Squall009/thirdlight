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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve as pathResolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { exportProject, type ExportFs } from '@thirdlight/exporter';
import {
  isProjectId,
  makeAttached,
  makeDiagnosticsRequest,
  makeErrorEvent,
  makePong,
  makePlayStarted,
  makeScreenshotRequest,
  parseAdminNoArgsBody,
  parseAdminCreateProjectRequest,
  parseCommandEnvelope,
  parseEstablishRequest,
  parsePlayStartRequest,
  parseScreenshotRequest,
  parseStrictJsonBytes,
  parseInboundEvent,
  sessionError,
  statusFor,
  WS_OUT_FRAME_MAX,
  WS_SCREENSHOT_ACK_MAX,
  enforceDefaultFrameBound,
  isMutationOp,
  type RuntimeSnapshotDoc,
  type SessionError,
} from '@thirdlight/protocol';
import { openWorkspaceService, type CommandError, type QueryResult, type WorkspaceService } from '@thirdlight/workspace';
import { mergeTimeouts, parseBackendConfig, type BackendConfig } from './config';
import { SessionRegistry, type SessionRecord } from './sessions';
import { PlayManager, type PlayRecord, type RelayOutcome } from './play';

// ---- ID / token allocation (sessions.md §3: hex, CSPRNG) ----------------------

/** Lowercase hex of a byte string (Uint8Array has no `toString('hex')`). */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}
function hex(n: number): string {
  return toHex(randomBytes(n));
}
const newConnId = (): string => `conn-${hex(16)}`;
const newPlaySessionId = (): string => `play-${hex(16)}`;
const newWsToken = (): string => hex(32);
const newRelayId = (): string => `relay-${hex(16)}`;

/** The commands.md §3 origin (structural local type — the backend's edge
 * table has no commands edge; the envelope is pipeline-validated). */
interface OriginDoc {
  kind: 'browser' | 'mcp' | 'admin';
  clientId: string;
}

// ---- bounds (sessions.md §11.5) ------------------------------------------------

/** §11.5: HTTP body bound (in). */
export const MAX_HTTP_BODY = 1024 * 1024;
/** §11.5: diagnostics relay payload bound. */
export const MAX_DIAGNOSTICS = 16 * 1024;
/** §11.5: screenshot image bound (the dataUrl length, in bytes). */
export const MAX_SCREENSHOT = 1024 * 1024;

const TEXT_ENCODER = new TextEncoder();
/** UTF-8 byte length of a string (no `Buffer` dependency). */
function utf8Len(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}
/** §11.4: the session listing bound. */
export const SESSION_LIST_MAX = 20;
/** The bounded startup log ring. */
export const STARTUP_LOG_RING = 256;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

export interface SessionView {
  sessionId: string;
  projectId: string;
  connId: string;
  connected: boolean;
  lastActivityAt: number;
  playSessionId?: string;
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
  };
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

  const service: WorkspaceService = openWorkspaceService({
    root: config.dataRoot,
    backendId: config.backendId,
    processMarker: config.processMarker,
  });
  const sessions = new SessionRegistry();
  const tokenScopes = new Map<string, string>();
  for (const t of config.tokens) tokenScopes.set(t.token, t.scope);

  logStartup(
    `starting: dataRoot=${config.dataRoot} authoring=${config.authoringOrigin} preview=${config.previewOrigin}`,
  );

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
    nowMs,
  });

  const wss = new WebSocketServer({ noServer: true });
  const authoringServer = createServer();
  const previewServer = createServer();
  let closed = false;
  let sweepTimer: number | undefined;

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

  const tokenScope = (token: string | null): string | null =>
    token === null ? null : (tokenScopes.get(token) ?? null);

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
    const scope = tokenScope(bearerToken(req));
    if (scope === null) return sessionError('unauthorized', 'validation', 'a valid bearer token is required');
    if (adminOnly) {
      return scope === 'admin' ? null : sessionError('unauthorized', 'validation', 'this route requires an admin token');
    }
    if (scope === 'admin') return null;
    if (scope === `authoring:${projectId}`) return null;
    return sessionError('unauthorized', 'validation', 'the token scope does not cover this project');
  };

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
  const fullState = (projectId: string):
    | {
        ok: true;
        revision: number;
        manifest: Record<string, unknown>;
        scene: Record<string, unknown>;
        history: Record<string, unknown>;
        workspace: Record<string, unknown>;
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
      schemaVersion: q.manifest.schemaVersion,
      sceneId: q.scene.sceneId,
      revision: q.revision,
      entities: [...e.entities],
    };
    return {
      ok: true,
      revision: q.revision,
      manifest: q.manifest as unknown as Record<string, unknown>,
      scene,
      history: q.history as unknown as Record<string, unknown>,
      workspace: q.workspace as unknown as Record<string, unknown>,
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
  const notifyMutationApplied = (
    projectId: string,
    requestId: string,
    revision: number,
    origin: OriginDoc | null,
    change: unknown,
  ): void => {
    const s = sessions.sessionForProject(projectId);
    if (!s || !s.connected || !s.socket) return;
    const payload = JSON.stringify({ type: 'mutation.applied', requestId, revision, origin, change });
    if (utf8Len(payload) > WS_OUT_FRAME_MAX) {
      logStartup('mutation.applied frame exceeds the 1 MiB bound; dropped (internal)');
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
      default:
        return;
    }
  };

  // The upgrade path (sessions.md §4.3): the token is verified at upgrade;
  // any failure ⇒ close 1008 with the reason code.
  authoringServer.on('upgrade', (req: IncomingMessage, socket: unknown, head: Uint8Array) => {
    const sock = socket as { write(d: string): void; destroy(): void };
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

  const establishSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const scope = tokenScope(bearerToken(req));
    if (scope === null || !scope.startsWith('authoring:')) {
      sendError(res, sessionError('unauthorized', 'validation', 'establishing a session requires an authoring:<projectId> token'));
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
    const parsedReq = parseEstablishRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error);
      return;
    }
    const { projectId, sessionId, clientInfo } = parsedReq.request;
    if (scope !== `authoring:${projectId}`) {
      sendError(res, sessionError('unauthorized', 'validation', 'the token scope does not cover this project'));
      return;
    }
    // The project must be loadable (§5.1 outcomes).
    const probe = service.query({ op: 'queryProject', projectId }) as QueryResult;
    if (!probe.ok) {
      sendError(res, workspaceError(probe.error), statusFor(probe.error.cls));
      return;
    }
    const est = sessions.establish(projectId, sessionId, clientInfo, newConnId(), nowMs());
    if (est.result === 'conflict') {
      sendError(
        res,
        sessionError('session_conflict', 'conflict', 'an active authoring session already exists for this project', {
          activeSessionId: est.activeSessionId,
          lastActivityAt: est.lastActivityAt,
        }),
        409,
      );
      return;
    }
    const wsToken = newWsToken();
    sessions.allocateWsToken(wsToken, est.session, timeouts.wsTokenTtlSeconds * 1000, nowMs());
    const state = fullState(projectId);
    if (!state.ok) {
      sendError(res, state.error, state.status);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      sessionId: est.session.sessionId,
      connId: est.session.connId,
      wsToken,
      revision: state.revision,
      manifest: state.manifest,
      scene: state.scene,
      history: state.history,
      workspace: state.workspace,
    });
  };

  const listSessions = async (req: IncomingMessage, res: ServerResponse, query: Map<string, string>): Promise<void> => {
    const scope = tokenScope(bearerToken(req));
    if (scope === null) {
      sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
      return;
    }
    const filterProject = query.get('projectId') ?? (scope.startsWith('authoring:') ? scope.slice('authoring:'.length) : undefined);
    const visible = sessions
      .all()
      .filter((s) => (filterProject === undefined ? s.projectId === scope.slice('authoring:'.length) : s.projectId === filterProject))
      .slice(0, SESSION_LIST_MAX);
    sendJson(res, 200, { ok: true, sessions: visible.map(sessionView) });
  };

  const sessionLog = async (req: IncomingMessage, res: ServerResponse, sessionId: string, query: Map<string, string>): Promise<void> => {
    const s = sessions.sessionForSessionId(sessionId);
    if (s === undefined) {
      sendError(res, sessionError('session_not_found', 'not_found', 'no session with this id', { sessionId }), 404);
      return;
    }
    const authError = requireAuth(req, s.projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const limitRaw = query.get('limit');
    const limit = limitRaw === undefined ? 32 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
      sendError(res, sessionError('field_value', 'validation', 'limit must be an integer 1–128'));
      return;
    }
    const entries = sessions.logEntries(s, limit);
    sendJson(res, 200, { ok: true, sessionId: s.sessionId, total: entries.total, entries: entries.entries });
  };

  const commandRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
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
    // §6.1: strict parse of the bytes first, then the commands.md pipeline.
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const envelope = parseCommandEnvelope(strict.value);
    if (!envelope.ok) {
      sendError(res, envelope.error);
      return;
    }
    const env = strict.value as Record<string, unknown>;
    const envOrigin =
      typeof env.origin === 'object' && env.origin !== null && !Array.isArray(env.origin)
        ? (env.origin as OriginDoc)
        : null;
    // §6.1 caller binding: a browser-origin command must come from the
    // project's registered authoring session.
    if (envOrigin?.kind === 'browser' && sessions.sessionForProject(projectId) === undefined) {
      sendError(res, sessionError('session_required', 'validation', 'a browser-origin command requires a registered authoring session for the project'), 403);
      return;
    }
    const session = sessions.sessionForProject(projectId);
    if (session) sessions.touch(session, nowMs());
    // §6.1: mutation envelopes go through the commands.md pipeline; query
    // envelopes are served by the workspace query path (never a mutation,
    // no revision advance, no mutation.applied, no history).
    const isMut = isMutationOp(envelope.op);
    if (isMut) {
      const result = service.runCommand(env);
      if (result.ok) {
        if (result.duplicated === false) {
          notifyMutationApplied(projectId, result.requestId, result.revision, envOrigin, result.change);
          if (session) sessions.record(session, 'command', result.requestId, result.revision, nowMs());
        }
        sendJson(res, 200, result);
        return;
      }
      // §6.1: the response is exactly the commands.md result — pass the
      // raw commands.md error through (it carries `currentRevision` etc.;
      // a SessionError re-wrap would drop those fields).
      sendJson(res, statusFor(result.error.cls), { ok: false, error: result.error });
      return;
    }
    // Query envelope: served by the workspace query path (read-only).
    const qres = service.query(env);
    if (qres.ok) {
      sendJson(res, 200, qres);
      return;
    }
    sendJson(res, statusFor(qres.error.cls), { ok: false, error: qres.error });
  };

  const playStartRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const scope = tokenScope(bearerToken(req));
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
    const parsedReq = parsePlayStartRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error);
      return;
    }
    // Preconditions (§10.1), in order.
    const probe = service.query({ op: 'queryProject', projectId }) as QueryResult;
    if (!probe.ok) {
      sendError(res, workspaceError(probe.error), statusFor(probe.error.cls));
      return;
    }
    const session = sessions.sessionForProject(projectId);
    if (session === undefined) {
      sendError(res, unavailableError(undefined, 'connect the editor browser: no registered authoring session for this project'), 503);
      return;
    }
    const active = plays.activeFor(projectId);
    if (active !== undefined) {
      sendError(
        res,
        sessionError('play_already_active', 'conflict', 'a play session is already active for this project', {
          activePlaySessionId: active.playSessionId,
        }),
        409,
      );
      return;
    }
    // Build the runtime snapshot at the CURRENT revision (the play's
    // revision is frozen from here — §10.2).
    const state = fullState(projectId);
    if (!state.ok) {
      sendError(res, state.error, state.status);
      return;
    }
    const snapshotId = `${projectId}@r${state.revision}`;
    const snapshot: RuntimeSnapshotDoc = {
      snapshotId,
      projectId,
      revision: state.revision,
      scene: {
        schemaVersion: state.scene.schemaVersion as number,
        sceneId: state.scene.sceneId as string,
        revision: state.revision,
        entities: state.scene.entities as ReadonlyArray<Record<string, unknown>>,
      },
    };
    const playSessionId = newPlaySessionId();
    const now = nowMs();
    const rec = plays.add(playSessionId, projectId, session.sessionId, snapshot, parsedReq.request.demo, now);
    session.playSessionId = playSessionId;
    // `startedBy` = the origin of the caller that started the play
    // (interpretation recorded in handoff 09: derived from the token
    // scope; packet 11's MCP path passes its own origin via the /services
    // surface).
    const startedBy: OriginDoc | null =
      scope === 'admin' ? { kind: 'admin', clientId: 'operator' } : { kind: 'browser', clientId: session.sessionId };
    const payload = makePlayStarted({ playSessionId, startedBy, snapshot });
    let delivered = false;
    if (session.connected && session.socket) {
      try {
        if (utf8Len(payload) <= WS_OUT_FRAME_MAX) {
          session.socket.send(payload);
          delivered = true;
        } else {
          logStartup('play.started frame exceeds the 1 MiB bound; held (internal)');
        }
      } catch {
        delivered = false;
      }
    }
    if (!delivered) {
      // Held for one-shot delivery on the owner's (re)attach (§7.1).
      session.pendingPlayStarted = { playSessionId, payload };
    }
    sessions.record(session, 'play', playSessionId, rec.revision, now, 'started');
    sendJson(res, 200, {
      ok: true,
      playSessionId,
      playBase: `${config.previewOrigin}/`,
      snapshotId,
      revision: rec.revision,
      demo: rec.demo,
      expiresAt: new Date(rec.expiresAt).toISOString(),
    });
  };

  const playStopRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, playSessionId: string): Promise<void> => {
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
    const noArgs = parseAdminNoArgsBody(strict.value);
    if (!noArgs.ok) {
      sendError(res, noArgs.error);
      return;
    }
    const rec = plays.get(playSessionId);
    if (rec === undefined || rec.projectId !== projectId || (rec.state !== 'active' && rec.state !== 'presented')) {
      sendError(res, sessionError('play_not_found', 'not_found', 'no active play session with this id', { playSessionId }), 404);
      return;
    }
    const owner = connectedOwner(rec);
    if (owner === undefined) {
      sendError(res, unavailableError(rec.playSessionId, 'the editor browser must be connected to stop this play'), 503);
      return;
    }
    sessions.record(owner, 'play', rec.playSessionId, rec.revision, nowMs(), 'stop_requested');
    plays.stop(rec, 'request');
    sendJson(res, 200, { ok: true, playSessionId });
  };

  const relayRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    playSessionId: string,
    kind: 'screenshot' | 'diagnostics',
  ): Promise<void> => {
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
    let maxWidth: number | undefined;
    if (kind === 'screenshot') {
      const parsedReq = parseScreenshotRequest(strict.value);
      if (!parsedReq.ok) {
        sendError(res, parsedReq.error);
        return;
      }
      maxWidth = parsedReq.request.maxWidth;
    } else {
      const noArgs = parseAdminNoArgsBody(strict.value);
      if (!noArgs.ok) {
        sendError(res, noArgs.error);
        return;
      }
    }
    // Preconditions (§12 step 2), in order: exists → presented → owner WS
    // connected.
    const rec = plays.get(playSessionId);
    if (rec === undefined || rec.projectId !== projectId || (rec.state !== 'active' && rec.state !== 'presented')) {
      sendError(res, sessionError('play_not_found', 'not_found', 'no active play session with this id', { playSessionId }), 404);
      return;
    }
    if (rec.state !== 'presented') {
      sendError(res, unavailableError(rec.playSessionId, 'the preview is not ready: the play is not yet presented'), 503);
      return;
    }
    const owner = connectedOwner(rec);
    if (owner === undefined) {
      sendError(res, unavailableError(rec.playSessionId, 'the editor browser must be connected for this live action'), 503);
      return;
    }
    const relayId = newRelayId();
    const payload =
      kind === 'screenshot' ? makeScreenshotRequest(relayId, maxWidth) : makeDiagnosticsRequest(relayId);
    const outcome: RelayOutcome = await plays.relay(rec.playSessionId, kind, relayId, payload);
    sessions.record(owner, kind, relayId, rec.revision, nowMs(), outcome.ok ? 'ok' : (outcome.ok ? undefined : outcome.code));
    if (outcome.ok && outcome.kind === 'screenshot') {
      if (outcome.dataUrl.length > MAX_SCREENSHOT) {
        sendError(res, sessionError('relay_failed', 'unavailable', 'screenshot dataUrl exceeds the 1 MiB bound', { cause: 'dataUrl_too_large' }), 503);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        playSessionId,
        snapshotId: rec.snapshotId,
        revision: rec.revision,
        width: outcome.width,
        height: outcome.height,
        dataUrl: outcome.dataUrl,
      });
      return;
    }
    if (outcome.ok && outcome.kind === 'diagnostics') {
      if (utf8Len(JSON.stringify(outcome.diagnostics)) > MAX_DIAGNOSTICS) {
        sendError(res, sessionError('relay_failed', 'unavailable', 'diagnostics exceed the 16 KiB bound', { cause: 'diagnostics_too_large' }), 503);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        playSessionId,
        snapshotId: rec.snapshotId,
        revision: rec.revision,
        diagnostics: outcome.diagnostics,
      });
      return;
    }
    const code =
      outcome.code === 'screenshot_timeout' || outcome.code === 'diagnostics_timeout'
        ? outcome.code
        : 'relay_failed';
    sendError(
      res,
      sessionError(code, 'unavailable', `${kind} relay ${outcome.code === 'relay_failed' ? 'failed' : 'timed out'}`, {
        relayId,
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      }),
      503,
    );
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
    const result = service.createProject(parsedReq.request.projectId, parsedReq.request.name);
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
      authoringRoot: config.dataRoot,
      authoringOrigin: config.authoringOrigin,
      previewOrigin: config.previewOrigin,
      tokenValues: config.tokens.map((t) => t.token),
      bootstrapEntry: join(engineRoot, 'packages/exporter/src/export-bootstrap.ts'),
      threePackageJson: join(engineRoot, 'node_modules/three/package.json'),
      typescriptPackageJson: join(engineRoot, 'node_modules/typescript/package.json'),
      lockfile: join(engineRoot, 'package-lock.json'),
    });
    if (result.ok) {
      sendJson(res, 200, result);
      return;
    }
    const e = result.error;
    const errorBody: Record<string, unknown> = { code: e.code, cls: e.cls, message: e.message };
    if (e.detail !== undefined) {
      for (const [k, v] of Object.entries(e.detail)) errorBody[k] = v;
    }
    sendJson(res, statusFor(e.cls), { ok: false, error: errorBody });
  };

  // ---------- static ----------

  const serveStatic = (res: ServerResponse, dir: string, urlPath: string): void => {
    let p: string;
    try {
      p = decodeURIComponent(urlPath);
    } catch {
      sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'bad path encoding') });
      return;
    }
    if (p.includes('\0')) {
      sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'bad path') });
      return;
    }
    const rel = p === '/' ? 'index.html' : normalize(p).replace(/^\/+/, '');
    const full = pathResolve(dir, rel);
    if (full !== pathResolve(dir) && !full.startsWith(pathResolve(dir) + '/')) {
      sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'path traversal rejected') });
      return;
    }
    try {
      if (!existsSync(full) || !statSync(full).isFile()) {
        sendJson(res, 404, { ok: false, error: sessionError('invalid_request', 'validation', 'no such file') });
        return;
      }
      const real = realpathSync(full);
      const realDir = realpathSync(dir);
      if (real !== realDir && !real.startsWith(realDir + '/')) {
        sendJson(res, 400, { ok: false, error: sessionError('invalid_request', 'validation', 'path escape rejected') });
        return;
      }
      const bytes = readFileSync(full);
      res.setHeader('content-type', MIME[extname(full)] ?? 'application/octet-stream');
      res.setHeader('content-length', String(bytes.length));
      res.end(bytes);
    } catch {
      sendJson(res, 500, { ok: false, error: sessionError('invalid_request', 'internal', 'static read failed') });
    }
  };

  const previewTemplate = (): string => {
    const origin = config.authoringOrigin.replace(/"/g, '\\"');
    return (
      '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>Thirdlight Play Preview</title>\n  </head>\n  <body>\n' +
      `    <script>window.__thirdlightPreview = { v: 1, authoringOrigin: "${origin}" };</script>\n` +
      '    <script src="./preview.js"></script>\n  </body>\n</html>\n'
    );
  };

  // ---------- request dispatch ----------

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const qIdx = req.url?.indexOf('?') ?? -1;
    const p = qIdx === -1 ? (req.url ?? '') : req.url.slice(0, qIdx);
    const query = parseQuery(qIdx === -1 ? '' : req.url!.slice(qIdx + 1));
    const method = req.method ?? 'GET';

    const found = originRejected(req);
    if (found !== null) {
      sendError(res, badOriginError(found), 403);
      return;
    }

    const parts = p.split('/').filter((x) => x.length > 0);

    try {
      if (parts[0] === 'api' && parts[1] === 'v1') {
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
        // POST /api/v1/projects/:projectId/play/:playSessionId/stop|screenshot|diagnostics
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

    // Fallback: static editor bundle.
    serveStatic(res, config.editorStaticDir, p);
  };

  const dispatchPreview = (req: IncomingMessage, res: ServerResponse): void => {
    const qIdx = req.url?.indexOf('?') ?? -1;
    const p = qIdx === -1 ? (req.url ?? '') : req.url.slice(0, qIdx);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: sessionError('invalid_request', 'validation', 'method not allowed', { expected: 'GET' }) });
      return;
    }
    if (p === '/' || p === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(previewTemplate());
      return;
    }
    serveStatic(res, config.previewStaticDir, p);
  };

  authoringServer.on('request', (req, res) => {
    void dispatch(req, res);
  });
  previewServer.on('request', (req, res) => {
    dispatchPreview(req, res);
  });

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
        plays.dispose();
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
              service.dispose();
              resolveClose();
            });
          });
        });
      }),
    _test: { sessions, plays, startupLog, service },
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

/** Build the preview template (exposed for packet 10 tests). */
export function previewTemplateFor(authoringOrigin: string): string {
  const origin = authoringOrigin.replace(/"/g, '\\"');
  return (
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8" />\n    <title>Thirdlight Play Preview</title>\n  </head>\n  <body>\n' +
    `    <script>window.__thirdlightPreview = { v: 1, authoringOrigin: "${origin}" };</script>\n` +
    '    <script src="./preview.js"></script>\n  </body>\n</html>\n'
  );
}

// ---- test fixtures / disposable workspaces (integration tests) -----------------

/**
 * A disposable backend test environment: temp data root + static dirs with
 * the minimal index.html bundles. `teardown` removes the root and closes
 * the backend.
 */
/** Temp base dir without `node:os` (not in backend's allowed edges): TMPDIR or /tmp. */
const tempBase = (): string => process.env.TMPDIR ?? '/tmp';

export async function createTestBackend(
  config: Record<string, unknown> & { timeouts?: Record<string, number> },
): Promise<{ backend: Backend; root: string; teardown: () => Promise<void> }> {
  const root = join(tempBase(), `tl-backend-${process.pid}-${hex(6)}`);
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  const dataRoot = join(root, 'data');
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(editorDir, 'index.html'), '<!doctype html><html><body>editor</body></html>\n');
  writeFileSync(join(previewDir, 'preview.js'), '// preview bundle stub (tests)\n');
  const merged: Record<string, unknown> = {
    ...config,
    dataRoot,
    editorStaticDir: editorDir,
    previewStaticDir: previewDir,
    authoringBind: config.authoringBind ?? '127.0.0.1:0',
    previewBind: config.previewBind ?? '127.0.0.1:0',
  };
  const created = createBackend(merged);
  if (!created.ok) throw new Error(`createBackend failed: ${created.error.message}`);
  const backend = created.backend;
  await backend.ready;
  return {
    backend,
    root,
    teardown: async () => {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}