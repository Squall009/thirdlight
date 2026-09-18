/**
 * Authoring session registry + bookkeeping — sessions.md §5.1/§5.3/§11.1.
 *
 * One active authoring session per project (normative, M1). Sessions
 * outlive connections: a re-attach (same sessionId) rebinds the session to
 * a fresh connection; the old connection, if still open, is closed by the
 * caller (1000, reason `detached`). The per-session log is a bounded ring
 * of the last 128 entries (§11.1).
 *
 * `wsToken`s are single-use, TTL-bound, and bound to the
 * `(sessionId, connId)` pair (§4.3).
 */
import type { WebSocket } from 'ws';

/** §11.1: the session log ring bound. */
export const SESSION_LOG_RING = 128;

export type LogKind =
  | 'registered'
  | 'detached'
  | 'command'
  | 'play'
  | 'screenshot'
  | 'diagnostics'
  | 'error';

/** One bounded session-log entry (§11.1: no secrets, no absolute paths). */
export interface LogEntry {
  /** UTC seconds. */
  ts: number;
  kind: LogKind;
  /** The relevant requestId / playSessionId / relayId. */
  ref: string;
  revision?: number;
  code?: string;
}

export interface ClientInfo {
  kind: 'browser';
  label?: string;
}

export interface SessionRecord {
  sessionId: string;
  projectId: string;
  /** The connId bound to the CURRENT (or last) connection. */
  connId: string;
  connected: boolean;
  socket: WebSocket | null;
  /** ms. */
  createdAt: number;
  /** ms — any request/event. */
  lastActivityAt: number;
  clientInfo?: ClientInfo;
  /** §7.1 one-shot delivery: a held `play.started` payload. */
  pendingPlayStarted: { playSessionId: string; payload: string } | null;
  /** The session's active/presented play (if any). */
  playSessionId: string | null;
  log: LogEntry[];
  /** ms timestamps of recent protocol errors (the 10/60 s window). */
  protocolErrorTimes: number[];
}

export interface WsToken {
  sessionId: string;
  connId: string;
  /** ms expiry. */
  expiresAt: number;
  used: boolean;
}

export type EstablishOutcome =
  | { result: 'created' | 'reattached'; session: SessionRecord }
  | { result: 'conflict'; activeSessionId: string; lastActivityAt: number };

export type TokenOutcome =
  | { ok: true; session: SessionRecord }
  | { ok: false; code: 'ws_token_invalid' | 'ws_token_replayed' | 'session_not_found' };

export class SessionRegistry {
  private byProject = new Map<string, SessionRecord>();
  private bySessionId = new Map<string, SessionRecord>();
  private tokens = new Map<string, WsToken>();
  /** Sockets the server closed because a re-attach replaced them. Their
   *  `onDetach` must NOT treat this as an owner loss (the owner is
   *  re-attaching, not gone) — sessions.md §5.1. */
  private replaced = new Set<WebSocket>();

  /**
   * Establish or re-attach (sessions.md §5.1). The one-active-session rule:
   * same sessionId ⇒ re-attach; a different sessionId while one is active
   * ⇒ conflict.
   */
  establish(
    projectId: string,
    sessionId: string,
    clientInfo: ClientInfo | undefined,
    connId: string,
    nowMs: number,
  ): EstablishOutcome {
    const existing = this.byProject.get(projectId);
    if (existing && existing.sessionId !== sessionId) {
      return { result: 'conflict', activeSessionId: existing.sessionId, lastActivityAt: existing.lastActivityAt };
    }
    if (existing) {
      // Re-attach: the session binds to the new connection; the caller
      // closes the old socket (1000 'detached') and logs it. The old
      // socket reference MUST survive until the new upgrade replaces it
      // (see the upgrade handler), so we do NOT null `socket` or force
      // `connected` false here (a still-open old socket is still the
      // live connection until the new one attaches).
      existing.connId = connId;
      existing.lastActivityAt = nowMs;
      if (clientInfo !== undefined) existing.clientInfo = clientInfo;
      this.record(existing, 'registered', existing.sessionId, undefined, nowMs);
      return { result: 'reattached', session: existing };
    }
    const session: SessionRecord = {
      sessionId,
      projectId,
      connId,
      connected: false,
      socket: null,
      createdAt: nowMs,
      lastActivityAt: nowMs,
      clientInfo,
      pendingPlayStarted: null,
      playSessionId: null,
      log: [],
      protocolErrorTimes: [],
    };
    this.byProject.set(projectId, session);
    this.bySessionId.set(sessionId, session);
    this.record(session, 'registered', sessionId, undefined, nowMs);
    return { result: 'created', session };
  }

  /** Allocate a single-use wsToken bound to (sessionId, connId) (§4.3). */
  allocateWsToken(token: string, session: SessionRecord, ttlMs: number, nowMs: number): void {
    this.tokens.set(token, { sessionId: session.sessionId, connId: session.connId, expiresAt: nowMs + ttlMs, used: false });
  }

  /**
   * Verify + consume a wsToken (§4.3): valid, unused, unexpired, bound to
   * the session identified by the query `sessionId`.
   */
  consumeWsToken(token: string, querySessionId: string, nowMs: number): TokenOutcome {
    const rec = this.tokens.get(token);
    if (!rec || rec.expiresAt < nowMs) {
      return { ok: false, code: 'ws_token_invalid' };
    }
    if (rec.used) {
      return { ok: false, code: 'ws_token_replayed' };
    }
    const session = this.bySessionId.get(rec.sessionId);
    if (!session || session.sessionId !== querySessionId) {
      return { ok: false, code: 'session_not_found' };
    }
    rec.used = true;
    session.connId = rec.connId;
    session.lastActivityAt = nowMs;
    return { ok: true, session };
  }

  bindSocket(session: SessionRecord, socket: WebSocket): void {
    session.socket = socket;
    session.connected = true;
    session.lastActivityAt = Date.now();
  }

  /** Mark a socket as replaced-by-re-attach (the server closed it). */
  markReplaced(socket: WebSocket): void {
    this.replaced.add(socket);
  }

  /** True if `socket` was closed because a re-attach replaced it. */
  isReplaced(socket: WebSocket): boolean {
    return this.replaced.has(socket);
  }

  detachSocket(session: SessionRecord, nowMs: number): void {
    session.connected = false;
    session.socket = null;
    this.record(session, 'detached', session.connId, undefined, nowMs);
  }

  touch(session: SessionRecord, nowMs: number): void {
    session.lastActivityAt = nowMs;
  }

  /** §11.1 bounded ring (last 128). */
  record(session: SessionRecord, kind: LogKind, ref: string, revision: number | undefined, nowMs: number, code?: string): void {
    const entry: LogEntry = { ts: Math.floor(nowMs / 1000), kind, ref };
    if (revision !== undefined) entry.revision = revision;
    if (code !== undefined) entry.code = code;
    session.log.push(entry);
    while (session.log.length > SESSION_LOG_RING) session.log.shift();
  }

  /** §11.4 log query: the last `limit` entries + the true total. */
  logEntries(session: SessionRecord, limit: number): { total: number; entries: LogEntry[] } {
    const total = session.log.length;
    return { total, entries: session.log.slice(-limit) };
  }

  /**
   * Count a protocol error and return the count inside the rolling window
   * (§5.2: ≥ 10 within 60 s ⇒ close 1008 `protocol_error`).
   */
  noteProtocolError(session: SessionRecord, nowMs: number, windowMs: number): number {
    session.protocolErrorTimes.push(nowMs);
    const cutoff = nowMs - windowMs;
    while (session.protocolErrorTimes.length > 0 && session.protocolErrorTimes[0]! < cutoff) {
      session.protocolErrorTimes.shift();
    }
    return session.protocolErrorTimes.length;
  }

  sessionForProject(projectId: string): SessionRecord | undefined {
    return this.byProject.get(projectId);
  }

  sessionForSessionId(sessionId: string): SessionRecord | undefined {
    return this.bySessionId.get(sessionId);
  }

  all(): SessionRecord[] {
    return [...this.byProject.values()];
  }
}