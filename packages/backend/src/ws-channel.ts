/**
 * The editor's WebSocket channel: the upgrade (a one-time ws token bound to a
 * session), the attach (the project's revision, a held `play.started`), the
 * inbound events (pings, the selection, the preview's and relays' answers),
 * the outbound frames (applied changes, problems, external edits) and the
 * silent-drop sweep.
 */
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  encodeBinaryFreeStateFrame,
  enforceDefaultFrameBound,
  makeAttached,
  makeErrorEvent,
  makePong,
  parseInboundEvent,
  parseStrictJsonBytes,
  PLAY_PROBLEM_KINDS_MAX,
  sessionError,
  toWireChange,
  validateGameControlResult,
  validateGameObservation,
  WS_OUT_FRAME_MAX,
  WS_SCREENSHOT_ACK_MAX,
} from '@thirdlight/protocol';

import type { BackendTimeouts } from './config';
import { parseQuery } from './http';
import type { PlayManager } from './play';
import type { RecordProblem } from './problems';
import type { SessionRecord, SessionRegistry } from './sessions';
import { utf8Len, type OriginDoc } from './util';

/** How long a closing backend waits for a client to answer its close frame before it drops the socket. */
export const WS_CLOSE_GRACE_MS = 2000;

export interface WsChannelDeps {
  readonly timeouts: BackendTimeouts;
  readonly nowMs: () => number;
  readonly sessions: SessionRegistry;
  readonly plays: () => PlayManager;
  readonly originRejected: (req: IncomingMessage) => string | null;
  readonly logStartup: (message: string) => void;
  readonly recordProblem: RecordProblem;
  /** The project's revision for the attach (not ok: the attach fails). */
  readonly attachRevision: (projectId: string) => { ok: true; revision: number } | { ok: false };
  /** An editor's answer to a lighting bake it was asked for (false: none such). */
  readonly lightingBakeAck?: (sessionId: string, ack: { relayId: string; ok: boolean; message?: string; error?: { code: string; message?: string } }) => boolean;
}

export function createWsChannel(deps: WsChannelDeps) {
  const { timeouts, nowMs, sessions, logStartup, recordProblem } = deps;
  const wss = new WebSocketServer({ noServer: true });

  const attachSocket = (ws: WebSocket, session: SessionRecord): void => {
    const state = deps.attachRevision(session.projectId);
    if (!state.ok) {
      ws.close(1011, 'backend_error');
      sessions.record(session, 'error', session.sessionId, undefined, nowMs(), 'attach_failed');
      return;
    }
    const plays = deps.plays();
    sessions.bindSocket(session, ws);
    ws.send(makeAttached(session.connId, state.revision));
    // One-shot `play.started` delivery.
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
      // one bound.
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

  /** Count a protocol error; close 1008 at the 10/60 s bound. */
  const countProtocolError = (ws: WebSocket, session: SessionRecord): void => {
    const count = sessions.noteProtocolError(session, nowMs(), timeouts.protocolErrorWindowSeconds * 1000);
    if (count >= timeouts.protocolErrorLimit) {
      ws.close(1008, 'protocol_error');
    }
  };

  const handleMessage = (ws: WebSocket, session: SessionRecord, data: Uint8Array): void => {
    // Frame bounds: hard cap 1.5 MiB (the screenshot.ack
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
    // types are a distinct, survivable outcome).
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
    const plays = deps.plays();
    switch (inbound.type) {
      case 'ping':
        ws.send(makePong());
        return;
      case 'selection.changed':
        session.selection = [...inbound.entityIds];
        return;
      case 'play.preview.ready':
      case 'play.preview.progress':
      case 'play.preview.failed':
      case 'play.stopped.ack': {
        const rec = plays.get(inbound.playSessionId);
        if (rec === undefined || rec.ownerSessionId !== session.sessionId) {
          sessions.record(session, 'error', inbound.playSessionId, undefined, nowMs(), 'event for unknown play');
          return;
        }
        // The preview is still starting and moving: the present timeout counts from now.
        if (inbound.type === 'play.preview.progress') {
          plays.progressed(rec.playSessionId);
          return;
        }
        if (inbound.type === 'play.preview.ready') {
          plays.markPresented(rec.playSessionId);
          sessions.record(session, 'play', rec.playSessionId, rec.revision, nowMs(), 'presented');
          return;
        }
        if (inbound.type === 'play.preview.failed') {
          recordProblem(session.projectId, 'play', inbound.code, `Play failed: ${inbound.message ?? inbound.code}`);
          plays.previewFailed(rec.playSessionId, inbound.code, inbound.message);
          return;
        }
        plays.onStoppedAck(rec.playSessionId);
        return;
      }
      case 'play.problem': {
        const rec = plays.get(inbound.playSessionId);
        if (rec === undefined || rec.ownerSessionId !== session.sessionId) {
          sessions.record(session, 'error', inbound.playSessionId, undefined, nowMs(), 'problem for unknown play');
          return;
        }
        // One line per kind and play; a page reporting new kinds without end is bounded.
        const kinds = (rec.problemKinds ??= new Set());
        if (kinds.has(inbound.code) || kinds.size >= PLAY_PROBLEM_KINDS_MAX) return;
        kinds.add(inbound.code);
        recordProblem(session.projectId, 'play', inbound.code, inbound.message);
        return;
      }
      case 'screenshot.ack':
      case 'play.diagnostics.ack': {
        const kind = inbound.type === 'screenshot.ack' ? 'screenshot' : 'diagnostics';
        // The ack carries the relayId; the relay map is authoritative for
        // routing.
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
        // The editor relays the preview's EXACT result (never fabricates).
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
      case 'lighting.bake.ack': {
        const known = deps.lightingBakeAck?.(session.sessionId, inbound) ?? false;
        sessions.record(session, 'play', inbound.relayId, undefined, nowMs(), known ? (inbound.ok ? 'lighting_baked' : 'lighting_bake_failed') : 'unknown_lighting_bake');
        return;
      }
      default:
        return;
    }
  };

  // The upgrade path: the token is verified at upgrade;
  // any failure ⇒ close 1008 with the reason code.
  const handleUpgrade = (req: IncomingMessage, socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer): void => {
    const qIdx = (req.url ?? '').indexOf('?');
    const p = qIdx === -1 ? (req.url ?? '') : (req.url ?? '').slice(0, qIdx);
    const query = qIdx === -1 ? '' : (req.url ?? '').slice(qIdx + 1);
    if (p !== '/api/v1/ws') {
      const body = JSON.stringify({ ok: false, error: sessionError('invalid_request', 'validation', 'unknown route') });
      socket.write(`HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${utf8Len(body)}\r\nconnection: close\r\n\r\n${body}`);
      socket.destroy();
      return;
    }
    // Upgrade first, then verify and close 1008 with the reason code on
    // failure (the contract's failure shape).
    const closeAfter = (reason: string): void => {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(1008, reason));
    };
    const found = deps.originRejected(req);
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
      // logged (1000, reason `detached`). Mark it replaced so its
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
  };

  /** A frame to the project's connected editor (best effort: the next full state carries the same facts). */
  const sendToProject = (projectId: string, frame: Record<string, unknown>): void => {
    const s = sessions.sessionForProject(projectId);
    if (!s || !s.connected || !s.socket) return;
    try {
      s.socket.send(JSON.stringify(frame));
    } catch {
      // best effort
    }
  };

  /** A play's message to its owner session; false when it cannot go (no owner, too large, send failed). */
  const sendToOwner = (ownerSessionId: string, payload: string): boolean => {
    const s = sessions.sessionForSessionId(ownerSessionId);
    if (!s || !s.connected || !s.socket) return false;
    if (utf8Len(payload) > WS_OUT_FRAME_MAX) {
      // Never silent — the owner's project shows a problem (the relay then fails or times out visibly).
      logStartup(`outbound frame exceeds the 1 MiB bound (play=${ownerSessionId}); dropped`);
      recordProblem(s.projectId, 'play', 'ws_frame_too_large', `A ${utf8Len(payload)}-byte message to the editor exceeds the 1 MiB WebSocket frame bound and was not sent.`);
      return false;
    }
    try {
      s.socket.send(payload);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Deliver `mutation.applied` to the project's registered session (every
   * applied mutation, of any origin). No-op when absent/disconnected.
   */
  const sendMutationApplied = (projectId: string, requestId: string, revision: number, origin: OriginDoc | null, change: unknown, sceneId?: string): void => {
    const s = sessions.sessionForProject(projectId);
    if (!s || !s.connected || !s.socket) return;
    // A full-state/change frame never carries GLB or source bytes.
    // `sceneId` names the scene a v4 edit touched.
    // The change without its previous side, keyed lists as deltas (protocol wire-change.ts).
    const payload = encodeBinaryFreeStateFrame({ type: 'mutation.applied', requestId, revision, origin, change: toWireChange(change as Parameters<typeof toWireChange>[0]), ...(sceneId !== undefined ? { sceneId } : {}) }, WS_OUT_FRAME_MAX);
    if (payload === null) {
      // An oversized change record is not dropped silently: the
      // editor is told to re-read the project over HTTP (the authoritative
      // full state), and the project shows why.
      logStartup('mutation.applied frame contained binary data or exceeded the 1 MiB bound; sent workspace.resync');
      recordProblem(projectId, 'workspace', 'ws_frame_too_large', `The change at revision ${revision} is larger than one WebSocket message (1 MiB); the editor re-read the project instead.`);
      try {
        s.socket.send(JSON.stringify({ type: 'workspace.resync' }));
      } catch {
        // best-effort: the next change's revision gap resyncs the editor
      }
      return;
    }
    try {
      s.socket.send(payload);
    } catch {
      // best-effort: the authoritative result went to the caller over HTTP
    }
  };

  // The silent-drop sweeper (60 s ⇒ close 1000 `heartbeat_timeout`).
  const sweepIntervalMs = Math.max(250, (timeouts.silentDropSeconds * 1000) / 4);
  const sweepTimer = setInterval(() => {
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

  return {
    handleUpgrade,
    sendToProject,
    sendToOwner,
    sendMutationApplied,
    /** Stop the sweep. */
    stopSweep(): void {
      clearInterval(sweepTimer);
    },
    /**
     * Close every editor connection (1001) and the WS server; `done` once it is closed. A client that does not
     * answer the close frame within {@link WS_CLOSE_GRACE_MS} (a page busy on a loaded host) is dropped: the
     * HTTP server's close waits for every socket, and the process gives its whole close only 10 s.
     */
    close(done: () => void): void {
      for (const s of sessions.all()) {
        if (s.connected && s.socket !== null) {
          try {
            s.socket.close(1001, 'server_closing');
          } catch {
            // already gone
          }
        }
      }
      const grace = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, WS_CLOSE_GRACE_MS);
      grace.unref();
      wss.close(done);
    },
  };
}

export type WsChannel = ReturnType<typeof createWsChannel>;
