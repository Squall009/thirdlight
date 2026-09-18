/**
 * Play session state machine + relay timeouts — sessions.md §10–§12.
 *
 * States (normative, §10.2):
 *   active → presented → stopping → stopped
 *   active → (play.preview.failed) → stopping (reason "preview_failed")
 *   active → (present timeout 15 s) → stopping (reason "preview_timeout")
 *   active/presented → (inactivity TTL 30 min) → stop path (reason "expired")
 *   any → (owner session lost) → stop path (reason "session_lost")
 *
 * Play revisions are frozen: the record's `revision`/`snapshotId` never
 * change after start (§10.2). The stop path is how `preview_failed`,
 * `preview_timeout`, `expired`, and `session_lost` terminations are
 * delivered (§10.3); if the owner WS is detached at that moment the play
 * is marked `stopped` (unconfirmed) directly — there is no relay path
 * through a dead editor.
 *
 * Interpretations (recorded in docs/handoffs/09.md):
 * - `expiresAt` (the §11.5 inactivity TTL) is computed from `createdAt`
 *   and reset by activity (presented, relay acks, stop ack).
 * - A `*.ack` with `ok: true` but a missing/invalid payload is treated as
 *   a relay failure (`relay_failed`), not a timeout.
 * - The `play.stop.request` payload carries only `"request"` or
 *   `"expired"` (§11.5); other terminations ride on `"request"` when the
 *   owner WS is alive.
 */
import type { RuntimeSnapshotDoc } from '@thirdlight/protocol';

/**
 * The `screenshot.ack` / `play.diagnostics.ack` payload shapes (sessions.md
 * §7.2). Kept local (structural) so this module stays within the backend's
 * edge table; the protocol's strict parser is the authoritative validator.
 */
export interface ScreenshotAckDoc {
  type: 'screenshot.ack';
  relayId: string;
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: { code: string; message?: string };
}
export interface DiagnosticsAckDoc {
  type: 'play.diagnostics.ack';
  relayId: string;
  ok: boolean;
  diagnostics?: unknown;
  error?: { code: string; message?: string };
}
export type AckDoc = ScreenshotAckDoc | DiagnosticsAckDoc;

export type PlayState = 'active' | 'presented' | 'stopping' | 'stopped';
export type PlayStopReason = 'request' | 'preview_failed' | 'preview_timeout' | 'expired' | 'session_lost';

export type RelayOutcome =
  | { ok: true; kind: 'screenshot'; dataUrl: string; width: number; height: number }
  | { ok: true; kind: 'diagnostics'; diagnostics: unknown }
  | {
      ok: false;
      kind: 'screenshot' | 'diagnostics';
      code: 'screenshot_timeout' | 'diagnostics_timeout' | 'relay_failed';
      cause?: string;
    };

export interface PendingRelay {
  kind: 'screenshot' | 'diagnostics';
  resolve: (r: RelayOutcome) => void;
  timer: number;
}

export interface PlayRecord {
  playSessionId: string;
  projectId: string;
  ownerSessionId: string;
  revision: number;
  snapshotId: string;
  snapshot: RuntimeSnapshotDoc;
  demo: boolean;
  state: PlayState;
  reason?: PlayStopReason;
  stopUnconfirmed?: boolean;
  /** ms. */
  createdAt: number;
  /** ms — last activity (inactivity-TTL reset). */
  lastActivityAt: number;
  /** ms. */
  expiresAt: number;
  presentTimer?: number;
  ttlTimer?: number;
  stopAckTimer?: number;
  relays: Map<string, PendingRelay>;
}

export interface PlayHooks {
  /** Deliver a JSON payload to the owner session's WS (false if unreachable). */
  sendToOwner(ownerSessionId: string, payload: string): boolean;
  /** Best-effort `play`-kind log entry for the owner session. */
  logPlay(ownerSessionId: string, ref: string, code?: string): void;
  ttlMs: () => number;
  relayTimeoutMs: () => number;
  stopAckTimeoutMs: () => number;
  presentTimeoutMs: () => number;
  nowMs: () => number;
}

const DATA_URL_PREFIX = 'data:image/png;base64,';

export class PlayManager {
  private plays = new Map<string, PlayRecord>();
  private byProject = new Map<string, string>(); // projectId → active/presented playSessionId

  constructor(private readonly hooks: PlayHooks) {}

  /**
   * Create the record in state `active` (preconditions checked by the
   * caller) and start the present-timeout timer.
   */
  add(
    playSessionId: string,
    projectId: string,
    ownerSessionId: string,
    snapshot: RuntimeSnapshotDoc,
    demo: boolean,
    nowMs: number,
  ): PlayRecord {
    const rec: PlayRecord = {
      playSessionId,
      projectId,
      ownerSessionId,
      revision: snapshot.revision,
      snapshotId: snapshot.snapshotId,
      snapshot,
      demo,
      state: 'active',
      createdAt: nowMs,
      lastActivityAt: nowMs,
      expiresAt: nowMs + this.hooks.ttlMs(),
      relays: new Map(),
    };
    this.plays.set(playSessionId, rec);
    this.byProject.set(projectId, playSessionId);
    rec.presentTimer = setTimeout(() => this.presentTimeoutFired(rec), this.hooks.presentTimeoutMs());
    return rec;
  }

  get(playSessionId: string): PlayRecord | undefined {
    return this.plays.get(playSessionId);
  }

  /**
   * The play owning a pending relay (by relayId) — the relay maps are
   * authoritative for ack routing (§12 step 6: the ack carries the
   * relayId).
   */
  findRelay(relayId: string): PlayRecord | undefined {
    for (const rec of this.plays.values()) {
      if (rec.relays.has(relayId)) return rec;
    }
    return undefined;
  }

  /** The active/presented play for a project (if any). */
  activeFor(projectId: string): PlayRecord | undefined {
    const id = this.byProject.get(projectId);
    if (id === undefined) return undefined;
    const rec = this.plays.get(id);
    if (rec === undefined || rec.state === 'stopped' || rec.state === 'stopping') return undefined;
    return rec;
  }

  /** §10.2: the editor sent `play.preview.ready`. */
  markPresented(playSessionId: string): void {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined || rec.state !== 'active') return;
    rec.state = 'presented';
    if (rec.presentTimer !== undefined) {
      clearTimeout(rec.presentTimer);
      rec.presentTimer = undefined;
    }
    this.touch(rec);
  }

  /** §10.3: a runtime failure reported by the preview path. */
  previewFailed(playSessionId: string, code?: string): void {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined || rec.state === 'stopped' || rec.state === 'stopping') return;
    this.hooks.logPlay(rec.ownerSessionId, rec.playSessionId, code ?? 'preview_failed');
    this.stop(rec, 'preview_failed');
  }

  /** An activity reset (presented / relay ack): re-arm the inactivity TTL. */
  touch(rec: PlayRecord): void {
    const nowMs = this.hooks.nowMs();
    rec.lastActivityAt = nowMs;
    rec.expiresAt = nowMs + this.hooks.ttlMs();
    if (rec.ttlTimer !== undefined) clearTimeout(rec.ttlTimer);
    rec.ttlTimer = setTimeout(() => this.ttlFired(rec), this.hooks.ttlMs());
  }

  /**
   * The stop sequence (§10.3). Only valid from `active`/`presented`
   * (a second stop ⇒ `play_not_found`, handled by the caller). If the
   * owner WS is unreachable the play is marked `stopped` (unconfirmed)
   * directly.
   */
  stop(rec: PlayRecord, reason: PlayStopReason): void {
    if (rec.state !== 'active' && rec.state !== 'presented') return;
    rec.state = 'stopping';
    rec.reason = reason;
    if (rec.presentTimer !== undefined) {
      clearTimeout(rec.presentTimer);
      rec.presentTimer = undefined;
    }
    if (rec.ttlTimer !== undefined) {
      clearTimeout(rec.ttlTimer);
      rec.ttlTimer = undefined;
    }
    const delivered =
      reason !== 'session_lost' &&
      this.hooks.sendToOwner(
        rec.ownerSessionId,
        JSON.stringify({
          type: 'play.stop.request',
          playSessionId: rec.playSessionId,
          reason: reason === 'expired' ? 'expired' : 'request',
        }),
      );
    if (delivered) {
      rec.stopAckTimer = setTimeout(() => this.finishStop(rec, true), this.hooks.stopAckTimeoutMs());
    } else {
      this.finishStop(rec, true);
    }
  }

  /** `play.stopped.ack` from the editor. */
  onStoppedAck(playSessionId: string): void {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined || rec.state !== 'stopping') return;
    if (rec.stopAckTimer !== undefined) {
      clearTimeout(rec.stopAckTimer);
      rec.stopAckTimer = undefined;
    }
    this.finishStop(rec, false);
  }

  /**
   * Relay a screenshot/diagnostics request to the owner and await the ack
   * (the §11.5 10 s timeout ⇒ `*_timeout`).
   */
  relay(
    playSessionId: string,
    kind: 'screenshot' | 'diagnostics',
    relayId: string,
    payload: string,
  ): Promise<RelayOutcome> {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined || (rec.state !== 'active' && rec.state !== 'presented')) {
      return Promise.resolve({
        ok: false,
        kind,
        code: kind === 'screenshot' ? 'screenshot_timeout' : 'diagnostics_timeout',
      });
    }
    this.touch(rec);
    return new Promise((resolve) => {
      let timer: number = 0;
      const entry: PendingRelay = {
        kind,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        timer: 0,
      };
      entry.timer = setTimeout(() => {
        rec.relays.delete(relayId);
        entry.resolve({
          ok: false,
          kind,
          code: kind === 'screenshot' ? 'screenshot_timeout' : 'diagnostics_timeout',
        });
      }, this.hooks.relayTimeoutMs());
      rec.relays.set(relayId, entry);
      if (!this.hooks.sendToOwner(rec.ownerSessionId, payload)) {
        // Owner unreachable: fail fast as a timeout (no ack can arrive).
        clearTimeout(entry.timer);
        rec.relays.delete(relayId);
        entry.resolve({
          ok: false,
          kind,
          code: kind === 'screenshot' ? 'screenshot_timeout' : 'diagnostics_timeout',
        });
      }
    });
  }

  /** Resolve a pending relay from an ack frame (false: unknown relayId). */
  resolveRelay(playSessionId: string, relayId: string, ack: AckDoc): boolean {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined) return false;
    const pending = rec.relays.get(relayId);
    if (pending === undefined) return false;
    rec.relays.delete(relayId);
    clearTimeout(pending.timer);
    const kind = pending.kind;
    if (ack.ok === true) {
      if (kind === 'screenshot') {
        const a = ack as ScreenshotAckDoc;
        const dataUrl = a.dataUrl;
        const width = a.width;
        const height = a.height;
        if (
          typeof dataUrl === 'string' && dataUrl.startsWith(DATA_URL_PREFIX) &&
          typeof width === 'number' && width >= 1 &&
          typeof height === 'number' && height >= 1
        ) {
          pending.resolve({ ok: true, kind: 'screenshot', dataUrl, width, height });
        } else {
          pending.resolve({
            ok: false,
            kind: 'screenshot',
            code: 'relay_failed',
            cause: 'ack carried ok without a valid dataUrl/dimensions',
          });
        }
        return true;
      }
      const a = ack as DiagnosticsAckDoc;
      if (a.diagnostics !== undefined && typeof a.diagnostics === 'object' && a.diagnostics !== null && !Array.isArray(a.diagnostics)) {
        pending.resolve({ ok: true, kind: 'diagnostics', diagnostics: a.diagnostics });
        return true;
      }
      pending.resolve({
        ok: false,
        kind: 'diagnostics',
        code: 'relay_failed',
        cause: 'ack carried ok without a diagnostics object',
      });
      return true;
    }
    const cause =
      ack.error !== undefined && typeof ack.error === 'object' && ack.error !== null
        ? typeof (ack.error as { code?: unknown }).code === 'string'
          ? ((ack.error as { code: string }).code)
          : undefined
        : undefined;
    pending.resolve({ ok: false, kind, code: 'relay_failed', cause });
    return true;
  }

  /**
   * The owner's WS dropped: terminate its live play via `session_lost`
   * (the termination is direct and unconfirmed — no relay path).
   */
  onOwnerDisconnected(ownerSessionId: string): void {
    for (const rec of this.plays.values()) {
      if (rec.ownerSessionId !== ownerSessionId) continue;
      if (rec.state === 'active' || rec.state === 'presented') {
        this.hooks.logPlay(rec.ownerSessionId, rec.playSessionId, 'session_lost');
        this.stop(rec, 'session_lost');
      }
    }
  }

  /** The project no longer has this play as its active/presented one. */
  releaseProjectOwnership(rec: PlayRecord): void {
    if (this.byProject.get(rec.projectId) === rec.playSessionId) {
      this.byProject.delete(rec.projectId);
    }
  }

  /** Drop all timers (backend shutdown). */
  dispose(): void {
    for (const rec of this.plays.values()) {
      if (rec.presentTimer !== undefined) clearTimeout(rec.presentTimer);
      if (rec.ttlTimer !== undefined) clearTimeout(rec.ttlTimer);
      if (rec.stopAckTimer !== undefined) clearTimeout(rec.stopAckTimer);
      for (const p of rec.relays.values()) clearTimeout(p.timer);
      rec.relays.clear();
    }
  }

  private presentTimeoutFired(rec: PlayRecord): void {
    rec.presentTimer = undefined;
    if (rec.state !== 'active') return;
    this.hooks.logPlay(rec.ownerSessionId, rec.playSessionId, 'preview_timeout');
    this.stop(rec, 'preview_timeout');
  }

  private ttlFired(rec: PlayRecord): void {
    rec.ttlTimer = undefined;
    if (rec.state === 'stopping' || rec.state === 'stopped') return;
    this.hooks.logPlay(rec.ownerSessionId, rec.playSessionId, 'expired');
    this.stop(rec, 'expired');
  }

  private finishStop(rec: PlayRecord, unconfirmed: boolean): void {
    if (rec.state === 'stopped') return;
    if (rec.stopAckTimer !== undefined) {
      clearTimeout(rec.stopAckTimer);
      rec.stopAckTimer = undefined;
    }
    rec.state = 'stopped';
    rec.stopUnconfirmed = unconfirmed;
    // Fail any pending relays: the play is ending.
    for (const p of rec.relays.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, kind: p.kind, code: 'relay_failed', cause: 'play stopped' });
    }
    rec.relays.clear();
    const obj: Record<string, unknown> = {
      type: 'play.stopped',
      playSessionId: rec.playSessionId,
      reason: rec.reason,
    };
    if (unconfirmed) obj.stopUnconfirmed = true;
    this.hooks.sendToOwner(rec.ownerSessionId, JSON.stringify(obj));
    this.hooks.logPlay(rec.ownerSessionId, rec.playSessionId, rec.reason);
    this.releaseProjectOwnership(rec);
  }
}