/**
 * Editor session transport (sessions.md §4/§5/§6/§8/§10; packet 10).
 *
 * The browser's connection to the backend: establish the authoring session,
 * upgrade the WS channel, issue commands (delegated to the backend — the
 * browser NEVER mutates files), observe `mutation.applied`, and drive the
 * isolated play preview. The browser state is a PROJECTION of the backend
 * (the `Projection`), hydrated from full state and advanced from
 * `mutation.applied`; on any gap/conflict the client re-syncs (full re-attach +
 * `queryEntities`) and explains the failure rather than silently losing an
 * edit. The browser never writes to browser storage as the authoritative
 * project database.
 *
 * Browser-only: uses `fetch` + `WebSocket` + `location` (the DOM). The pure
 * decision logic lives in `projection.ts` / `gesture.ts` / `envelope.ts`
 * (unit-tested in Node); this module is the thin transport that drives them.
 */

import type { CommandError, ChangeData } from '@thirdlight/commands';
import {
  makeEnvelope,
  makeEstablishBody,
  makeRequestId,
  type CommandOutcome,
  type MutationResponse,
  type Origin,
} from './envelope';
import { Projection, type FullState } from './projection';
import { Gesture, type Transform } from './gesture';

export interface ClientConfig {
  projectId: string;
  /** The authoring origin (also the API base; the editor is same-origin). */
  authoringOrigin: string;
  /** The separate preview origin (the play iframe base, no trailing slash). */
  previewOrigin: string;
  /** The project-scoped authoring bearer token. */
  authoringToken: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type SaveStatus = 'idle' | 'pending' | 'saved' | 'error';

export interface ClientUiState {
  connection: ConnectionStatus;
  save: SaveStatus;
  /** The structured error, when the last operation failed (explained, not silent). */
  error: { code: string; message: string } | null;
  /** A revision_conflict to surface in the UI (with currentRevision). */
  conflict: { currentRevision: number; expectedRevision: number; message: string } | null;
  revision: number;
}

/** A play-start result (sessions.md §10.1). */
export interface PlayStartResult {
  playSessionId: string;
  /** The preview iframe base (the backend's preview origin). */
  playBase: string;
  snapshotId: string;
  revision: number;
  expiresAt: number;
}

export interface ClientCallbacks {
  onState: (s: ClientUiState) => void;
  onSceneChanged: () => void;
  onPlayStarted: (r: PlayStartResult & { snapshot: unknown }) => void;
  onPlayStopped: (reason: string) => void;
}

/** A session-scoped `sessionId` (`sess-` + 32 hex), client-generated. */
function makeSessionId(rng: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(rng() * 16).toString(16);
  return `sess-${hex}`;
}

export class SessionClient {
  readonly projection = new Projection();
  private readonly cfg: ClientConfig;
  private readonly cb: ClientCallbacks;
  private readonly sessionId: string;
  private ws: WebSocket | null = null;
  private connId: string | null = null;
  private connection: ConnectionStatus = 'idle';
  private save: SaveStatus = 'idle';
  private error: { code: string; message: string } | null = null;
  private conflict: { currentRevision: number; expectedRevision: number; message: string } | null = null;
  private disposed = false;
  /** Active play (the retained `play.started` snapshot + preview bridge). */
  private activePlay: (PlayStartResult & { snapshot: unknown }) | null = null;
  private reconnectTimer: number | null = null;

  constructor(cfg: ClientConfig, cb: ClientCallbacks, sessionId?: string) {
    this.cfg = cfg;
    this.cb = cb;
    this.sessionId = sessionId ?? makeSessionId();
  }

  get connectionStatus(): ConnectionStatus {
    return this.connection;
  }

  private emit(): void {
    this.cb.onState({
      connection: this.connection,
      save: this.save,
      error: this.error,
      conflict: this.conflict,
      revision: this.projection.revision,
    });
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.authoringToken}`,
        origin: this.cfg.authoringOrigin,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) throw { status: res.status, body: json };
    return json as T;
  }

  /** Establish the authoring session + upgrade the WS (§5.1/§4.3). */
  async connect(): Promise<void> {
    if (this.disposed) return;
    this.connection = this.connection === 'reconnecting' ? 'reconnecting' : 'connecting';
    this.emit();
    try {
      const est = await this.api<{ ok: true; sessionId: string; connId: string; wsToken: string; revision: number; entities?: unknown[] }>(
        '/sessions',
        makeEstablishBody(this.cfg.projectId, this.sessionId),
      );
      this.connId = est.connId;
      await this.fullResync();
      await this.upgradeWs(est.wsToken);
      this.connection = 'connected';
      this.error = null;
      this.emit();
    } catch (e) {
      this.connection = 'disconnected';
      this.error = this.describeError(e);
      this.emit();
      this.scheduleReconnect();
    }
  }

  /** The WS upgrade (§4.3): single-use wsToken. */
  private upgradeWs(wsToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.cfg.authoringOrigin.replace(/^http/, 'ws')}/api/v1/ws?sessionId=${this.sessionId}&wsToken=${wsToken}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws upgrade failed'));
      ws.onclose = (ev) => {
        this.ws = null;
        if (this.disposed) return;
        // Reconnect: re-establish (re-attach) + resync + re-upgrade.
        if (ev.code === 1000 || ev.reason === 'detached') {
          // a deliberate detach (re-attach elsewhere) — don't auto-reconnect a
          // stale socket over a live one.
          this.connection = 'disconnected';
          this.emit();
          return;
        }
        this.connection = 'reconnecting';
        this.emit();
        this.scheduleReconnect();
      };
      ws.onmessage = (ev) => this.onWsMessage(ev.data as string);
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }

  /** A full-state resync (queryEntities is the authoritative scene source). */
  async fullResync(): Promise<void> {
    const q = await this.api<{ ok: true; revision: number; entities: unknown[]; total: number }>(
      `/projects/${this.cfg.projectId}/commands`,
      { op: 'queryEntities', projectId: this.cfg.projectId, args: { limit: 1024, offset: 0 } },
    );
    if (q.ok) {
      this.projection.hydrate({ revision: q.revision, entities: q.entities as FullState['entities'] });
    }
  }

  /** Handle one WS message (sessions.md §7). */
  private onWsMessage(raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.type) {
      case 'attached':
        this.connection = 'connected';
        this.emit();
        break;
      case 'mutation.applied':
        this.applyMutationApplied(m as unknown as Parameters<Projection['applyMutationApplied']>[0]);
        break;
      case 'play.started':
        this.handlePlayStarted(m as unknown as { playSessionId: string; snapshot: unknown });
        break;
      case 'play.stopped':
        this.handlePlayStopped((m as { reason?: string }).reason ?? 'request');
        break;
      case 'error':
        this.error = { code: String(m.code ?? 'error'), message: String(m.message ?? '') };
        this.emit();
        break;
      default:
        break;
    }
  }

  private applyMutationApplied(ev: { requestId: string; revision: number; change: unknown }): void {
    const res = this.projection.applyMutationApplied({
      requestId: ev.requestId,
      revision: ev.revision,
      change: ev.change as ChangeData,
    });
    if (res.gap) {
      // The gap rule: we missed events — resync from the backend (authoritative).
      void this.fullResync().then(() => this.cb.onSceneChanged());
      return;
    }
    if (res.applied) {
      this.save = 'saved';
      this.cb.onSceneChanged();
      this.emit();
    }
  }

  private handlePlayStarted(m: { playSessionId: string; snapshot: unknown }): void {
    // The retained `play.started` (§7.1 one-shot delivery). The editor stores
    // it and, on the preview iframe load, hands it across the bridge.
    const base = this.activePlay ?? ({} as PlayStartResult);
    this.activePlay = {
      playSessionId: m.playSessionId,
      playBase: base.playBase ?? this.cfg.previewOrigin,
      snapshotId: base.snapshotId ?? '',
      revision: base.revision ?? 0,
      expiresAt: base.expiresAt ?? 0,
      snapshot: m.snapshot,
    };
    this.cb.onPlayStarted(this.activePlay);
  }

  private handlePlayStopped(reason: string): void {
    this.activePlay = null;
    this.cb.onPlayStopped(reason);
  }

  /**
   * Issue a mutation command (delegated to the backend; the browser never
   * mutates files). Retries a LOST ack with the same requestId (idempotent);
   * a revision_conflict is surfaced (and handed to the gesture for the bounded
   * auto-rebase). Returns the authoritative revision on success.
   */
  async command(
    op: string,
    args: unknown,
    expectedRevision: number,
    requestId?: string,
    origin: Origin = { kind: 'browser', clientId: this.sessionId },
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    const rid = requestId ?? makeRequestId();
    const env = makeEnvelope(op, this.cfg.projectId, rid, expectedRevision, args, origin);
    this.save = 'pending';
    this.emit();
    let outcome = await this.postCommand(env);
    // A lost ack retries ONCE with the same requestId (idempotent; the backend
    // either replays `duplicated:true` or executes fresh — the revision
    // advances exactly once, commands.md §7.2).
    if (outcome.status === 'lost') {
      this.save = 'pending';
      this.emit();
      outcome = await this.postCommand(env);
    }
    return this.finishCommand(outcome, expectedRevision);
  }

  private finishCommand(
    outcome: CommandOutcome,
    expectedRevision: number,
  ): { ok: true; revision: number } | { ok: false; response: MutationResponse } {
    if (outcome.status === 'response') {
      const r = outcome.response;
      if (r.ok) {
        // The projection advances via the `mutation.applied` WS event (deduped
        // by requestId); the HTTP ack only drives the save status.
        this.save = 'saved';
        this.error = null;
        this.conflict = null;
        this.emit();
        return { ok: true, revision: r.revision };
      }
      if (r.code === 'revision_conflict') {
        const current = r.currentRevision ?? -1;
        this.conflict = {
          currentRevision: current,
          expectedRevision,
          message: `revision conflict — the scene changed since this edit began (the backend is now at revision ${current})`,
        };
        this.save = 'error';
        this.emit();
        return { ok: false, response: r };
      }
      this.error = { code: r.code, message: r.message ?? r.code };
      this.save = 'error';
      this.emit();
      return { ok: false, response: r };
    }
    this.error = { code: 'network', message: 'the command response was lost after the single retry' };
    this.save = 'error';
    this.emit();
    return { ok: false, response: { ok: false, code: 'network', message: this.error.message } };
  }

  private async postCommand(env: ReturnType<typeof makeEnvelope>): Promise<CommandOutcome> {
    try {
      const r = await this.api<MutationResponse>(`/projects/${this.cfg.projectId}/commands`, env);
      return { status: 'response', response: r };
    } catch (e) {
      const err = e as { status?: number; body?: unknown };
      if (err.body && typeof err.body === 'object' && 'error' in (err.body as Record<string, unknown>)) {
        const body = err.body as { error: CommandError };
        const code = body.error.code;
        if (code === 'revision_conflict') {
          return {
            status: 'response',
            response: { ok: false, code: 'revision_conflict', currentRevision: (body.error as { currentRevision?: number }).currentRevision ?? 0 },
          };
        }
        return { status: 'response', response: { ok: false, code, message: body.error.message } };
      }
      // A network-level failure (no response) = a lost ack.
      return { status: 'lost' };
    }
  }

  /** Start an isolated play (sessions.md §10.1). */
  async playStart(demo = false): Promise<PlayStartResult> {
    const r = await this.api<PlayStartResult>('/projects/' + this.cfg.projectId + '/play', { options: { demo } });
    this.activePlay = { ...r, snapshot: null };
    return r;
  }

  /** Stop the active play (sessions.md §10.3). */
  async playStop(playSessionId: string): Promise<void> {
    await this.api(`/projects/${this.cfg.projectId}/play/${playSessionId}/stop`, {});
    this.activePlay = null;
  }

  getActivePlay(): (PlayStartResult & { snapshot: unknown }) | null {
    return this.activePlay;
  }

  /** The entity's current transform (for a gesture's conflict rebase). */
  entityTransform(entityId: string): Transform | null {
    const e = this.projection.getEntity(entityId);
    if (!e) return null;
    return { position: e.position, rotation: e.rotation, scale: e.scale };
  }

  describeError(e: unknown): { code: string; message: string } {
    const err = e as { status?: number; body?: unknown };
    const body = err.body as { error?: { code?: string; message?: string } } | null;
    if (body?.error?.code) return { code: body.error.code, message: body.error.message ?? body.error.code };
    return { code: 'network', message: 'the backend was unreachable' };
  }

  /** Release the connection + any active play (idempotent). */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'editor closed');
      this.ws = null;
    }
    this.connection = 'disconnected';
    this.emit();
  }
}