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
/** §7.2/§20.1 `game.control.ack` (the preview's exact control result relayed back). */
export interface GameControlAckDoc {
  type: 'game.control.ack';
  relayId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message?: string };
}
/** §7.2/§20.1 `game.observe.ack` (the preview's exact observation relayed back). */
export interface GameObserveAckDoc {
  type: 'game.observe.ack';
  relayId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message?: string };
}
export type AckDoc = ScreenshotAckDoc | DiagnosticsAckDoc | GameControlAckDoc | GameObserveAckDoc;

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

/** One bounded input-exercise relay frame (sessions.md §18.1.1). */export interface InputRelayFrame {
  stepOffset: number;
  moveX: number;
  jump: string;
}

export type InputRelayOutcome =
  | { ok: true; appliedFromStep: number; appliedToStep: number }
  | { ok: false; code: 'input_relay_timeout' | 'input_relay_conflict' | 'relay_failed'; cause?: string };

export interface PendingInputRelay {
  requestId: string;
  resolve: (r: InputRelayOutcome) => void;
  timer: number;
}

export interface PendingRelay {
  kind: 'screenshot' | 'diagnostics';
  resolve: (r: RelayOutcome) => void;
  timer: number;
}

/** The §20 closed failure set a game relay may return (never a fabricated value). */
export type GameRelayCode =
  | 'game_relay_timeout'
  | 'game_relay_rejected'
  | 'session_unavailable'
  | 'play_locator_expired'
  | 'game_command_invalid'
  | 'game_run_stale'
  | 'input_relay_conflict'
  | 'limits_exceeded';

export type GameRelayOutcome =
  | { ok: true; kind: 'control' | 'observe'; result: unknown }
  | { ok: false; kind: 'control' | 'observe'; code: GameRelayCode; cause?: string; runId?: string };

/** A pending §20 control/observation relay (it carries no bytes and no capability). */
export interface PendingGameRelay {
  kind: 'control' | 'observe';
  resolve: (r: GameRelayOutcome) => void;
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
  /** The immutable runtime-content manifest `buildId` (sessions.md §10.5). */
  buildId: string;
  /**
   * The last-known run identity `${snapshotId}#${replayEpoch}` (delivery.md
   * §5.3). It starts at `${snapshotId}#0` and only ever advances from an
   * accepted control/observation result, so a stale `expectedRunId` is
   * detectable backend-side without a second channel (sessions.md §20.3).
   */
  gameRunId: string;
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
  /** At most one bounded input-exercise relay at a time (§18.1). */
  inputRelay?: PendingInputRelay;
  /** At most one pending §20 control/observation relay at a time. */
  gameRelay?: PendingGameRelay;
  /** The relayId of the pending game relay (ack routing idempotence). */
  gameRelayId?: string;
}

/** Map a preview-reported failure code into the closed §20 set. */
function mapGameRelayCause(code: string | undefined): GameRelayCode {
  switch (code) {
    case 'game_command_invalid':
    case 'game_run_stale':
    case 'play_locator_expired':
    case 'input_relay_conflict':
    case 'limits_exceeded':
    case 'session_unavailable':
    case 'game_relay_timeout':
    case 'game_relay_rejected':
      return code;
    default:
      return 'game_relay_rejected';
  }
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
  inputRelayTimeoutMs: () => number;
  /** A play became terminal (drives the locator grace window, §17.3). */
  onTerminal?: (playSessionId: string) => void;
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
    buildId: string,
    nowMs: number,
  ): PlayRecord {
    const rec: PlayRecord = {
      playSessionId,
      projectId,
      ownerSessionId,
      revision: snapshot.revision,
      snapshotId: snapshot.snapshotId,
      snapshot: snapshot,
      demo,
      buildId,
      gameRunId: `${snapshot.snapshotId}#0`,
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

  /** The play owning a pending input relay (by requestId). */
  findRelayByInput(requestId: string): PlayRecord | undefined {
    for (const rec of this.plays.values()) {
      if (rec.inputRelay?.requestId === requestId) return rec;
    }
    return undefined;
  }

  /** The play owning a pending §20 game relay (by relayId). */
  findGameRelay(relayId: string): PlayRecord | undefined {
    for (const rec of this.plays.values()) {
      if (rec.gameRelay !== undefined && rec.gameRelayId === relayId) return rec;
    }
    return undefined;
  }

  /**
   * Relay one §20 control or observation request to the owner editor and await
   * the preview's exact ack (never a fabricated value). At most one game relay
   * is pending per play; the caller's bounded `timeoutMs` drives the deadline.
   */
  relayGame(
    playSessionId: string,
    kind: 'control' | 'observe',
    relayId: string,
    payload: string,
    timeoutMs: number,
  ): Promise<GameRelayOutcome> {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined || (rec.state !== 'active' && rec.state !== 'presented')) {
      return Promise.resolve({ ok: false, kind, code: 'session_unavailable', cause: 'play not active' });
    }
    if (rec.gameRelay !== undefined) {
      return Promise.resolve({ ok: false, kind, code: 'input_relay_conflict', cause: 'a game relay is already pending' });
    }
    this.touch(rec);
    rec.gameRelayId = relayId;
    return new Promise((resolve) => {
      const entry: PendingGameRelay = { kind, resolve: () => undefined, timer: 0 };
      entry.resolve = (r: GameRelayOutcome) => {
        clearTimeout(entry.timer);
        if (rec.gameRelay === entry) rec.gameRelay = undefined;
        resolve(r);
      };
      entry.timer = setTimeout(() => entry.resolve({ ok: false, kind, code: 'game_relay_timeout' }), timeoutMs);
      rec.gameRelay = entry;
      if (!this.hooks.sendToOwner(rec.ownerSessionId, payload)) {
        entry.resolve({ ok: false, kind, code: 'session_unavailable', cause: 'owner unreachable' });
      }
    });
  }

  /**
   * Resolve a pending §20 game relay from the owner editor's relayed ack
   * (`game.control.ack`/`game.observe.ack`). Returns false for an unknown/stale
   * relayId (the ack is dropped and the caller counts it).
   */
  resolveGameRelay(
    playSessionId: string,
    relayId: string,
    ack: GameControlAckDoc | GameObserveAckDoc,
    validate: (result: unknown) => boolean,
  ): boolean {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined) return false;
    const pending = rec.gameRelay;
    if (pending === undefined || rec.gameRelayId !== relayId) return false;
    if (ack.ok === true && validate(ack.result)) {
      const result = ack.result as { runId?: unknown };
      if (typeof result.runId === 'string') this.advanceRunId(rec, result.runId);
      pending.resolve({ ok: true, kind: pending.kind, result: ack.result });
      return true;
    }
    // A malformed/!ok ack never becomes a success: the preview's own code is
    // mapped through when it is in the closed §20 set, else `game_relay_rejected`.
    const code = ack.ok === true ? 'game_relay_rejected' : mapGameRelayCause(ack.error?.code);
    pending.resolve({
      ok: false,
      kind: pending.kind,
      code,
      ...(ack.ok === true
        ? { cause: 'the relayed result failed the §20 shape check' }
        : { cause: ack.error?.code ?? 'preview reported failure' }),
      ...(code === 'game_run_stale' ? { runId: rec.gameRunId } : {}),
    });
    return true;
  }

  /**
   * Advance the last-known run identity only forward (a strictly greater
   * `replayEpoch`), so a stale publication can never un-advance it.
   */
  private advanceRunId(rec: PlayRecord, runId: string): void {
    const epochOf = (id: string): number => {
      const i = id.lastIndexOf('#');
      if (i < 0) return -1;
      const n = Number(id.slice(i + 1));
      return Number.isInteger(n) && n >= 0 ? n : -1;
    };
    if (epochOf(runId) > epochOf(rec.gameRunId)) rec.gameRunId = runId;
  }

  /**
   * Relay a bounded input-exercise sequence to the owner editor (§18.1). At
   * most one relay is active per play; a second one is `input_relay_conflict`.
   */
  relayInput(playSessionId: string, requestId: string, payload: string): Promise<InputRelayOutcome> {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined || (rec.state !== 'active' && rec.state !== 'presented')) {
      return Promise.resolve({ ok: false, code: 'relay_failed', cause: 'play not active' });
    }
    if (rec.inputRelay !== undefined) {
      return Promise.resolve({ ok: false, code: 'input_relay_conflict', cause: 'a relay is already active' });
    }
    this.touch(rec);
    return new Promise((resolve) => {
      const entry: PendingInputRelay = { requestId, resolve: () => undefined, timer: 0 };
      entry.resolve = (r: InputRelayOutcome) => {
        clearTimeout(entry.timer);
        if (rec.inputRelay === entry) rec.inputRelay = undefined;
        resolve(r);
      };
      entry.timer = setTimeout(() => {
        entry.resolve({ ok: false, code: 'input_relay_timeout' });
      }, this.hooks.inputRelayTimeoutMs());
      rec.inputRelay = entry;
      if (!this.hooks.sendToOwner(rec.ownerSessionId, payload)) {
        entry.resolve({ ok: false, code: 'relay_failed', cause: 'owner unreachable' });
      }
    });
  }

  /** Resolve the pending input relay from an `input.result` ack. */
  resolveInputRelay(
    playSessionId: string,
    requestId: string,
    result: { ok: boolean; appliedFromStep?: number; appliedToStep?: number; error?: { code: string; message?: string } },
  ): boolean {
    const rec = this.plays.get(playSessionId);
    if (rec === undefined) return false;
    const pending = rec.inputRelay;
    if (pending === undefined || pending.requestId !== requestId) return false;
    if (result.ok && typeof result.appliedFromStep === 'number' && typeof result.appliedToStep === 'number') {
      pending.resolve({ ok: true, appliedFromStep: result.appliedFromStep, appliedToStep: result.appliedToStep });
    } else {
      pending.resolve({ ok: false, code: 'relay_failed', cause: result.error?.code ?? 'preview reported failure' });
    }
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
      if (rec.inputRelay !== undefined) clearTimeout(rec.inputRelay.timer);
      rec.inputRelay = undefined;
      if (rec.gameRelay !== undefined) clearTimeout(rec.gameRelay.timer);
      rec.gameRelay = undefined;
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
    if (rec.inputRelay !== undefined) {
      rec.inputRelay.resolve({ ok: false, code: 'relay_failed', cause: 'play stopped' });
      rec.inputRelay = undefined;
    }
    if (rec.gameRelay !== undefined) {
      rec.gameRelay.resolve({ ok: false, kind: rec.gameRelay.kind, code: 'session_unavailable', cause: 'play stopped' });
      rec.gameRelay = undefined;
    }
    const obj: Record<string, unknown> = {
      type: 'play.stopped',
      playSessionId: rec.playSessionId,
      reason: rec.reason,
    };
    if (unconfirmed) obj.stopUnconfirmed = true;
    this.hooks.sendToOwner(rec.ownerSessionId, JSON.stringify(obj));
    this.hooks.logPlay(rec.ownerSessionId, rec.playSessionId, rec.reason);
    this.hooks.onTerminal?.(rec.playSessionId);
    this.releaseProjectOwnership(rec);
  }
}