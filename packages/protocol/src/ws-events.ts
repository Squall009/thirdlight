/**
 * WS event catalog — sessions.md §7 (normative, exhaustive for M1).
 *
 * Server → client (§7.1): builders emit strict JSON strings with the exact
 * field sets. Client → server (§7.2): strict validators (unknown `type` ⇒
 * `unknown_event`; malformed/shape failure ⇒ `protocol_error` — both
 * counted by the connection's protocol-error tolerance, §5.2).
 *
 * Every event carries `type`; unknown fields are rejected.
 * Pure: no I/O.
 */
import type { ChangeData, Origin } from '@thirdlight/commands';
import {
  isPlaySessionId,
  isRelayId,
  isRequestId,
} from './ids';
import {
  checkField,
  checkShape,
  isStringNoControl,
} from './strict';
import { validateGameControlResult, validateGameObservation } from './m3';
import type { SessionError } from './errors';

// ---- catalog constants (the exhaustive allowlists, sessions.md §7) -----------

/** §7.1: the complete server → client event type set. */
export const SERVER_EVENT_TYPES = [
  'attached',
  'pong',
  'mutation.applied',
  'play.started',
  'play.stop.request',
  'play.stopped',
  'screenshot.request',
  'play.diagnostics.request',
  'input.request',
  // sessions.md §7.1/§20.1 (packet 42 promoted; packet 48 implements): the M3
  // game control/observation relays forwarded to the owner editor.
  'game.control.request',
  'game.observe.request',
  'error',
] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

/** §7.2: the complete client → server event type set. */
export const CLIENT_EVENT_TYPES = [
  'ping',
  'play.preview.ready',
  'play.preview.failed',
  'play.stopped.ack',
  'screenshot.ack',
  'play.diagnostics.ack',
  'input.result',
  // sessions.md §7.2/§20.1 (packet 42 promoted; packet 48 implements).
  'game.control.ack',
  'game.observe.ack',
  // The editor's current selection (so tools can inspect "what is selected").
  'selection.changed',
] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

/** The §7.1 `play.stopped` reason set. */
export const PLAY_STOP_REASONS = [
  'request',
  'preview_failed',
  'preview_timeout',
  'expired',
  'session_lost',
] as const;
export type PlayStopReason = (typeof PLAY_STOP_REASONS)[number];
export const PLAY_STOP_REQUEST_REASONS = ['request', 'expired'] as const;
export type PlayStopRequestReason = (typeof PLAY_STOP_REQUEST_REASONS)[number];

/**
 * The runtime snapshot document (runtime.md §2) — structural type, kept
 * local so the protocol stays within its edge table (dependencies.md §4.1:
 * project-model + commands only; the runtime is NOT an allowed edge).
 */
export interface RuntimeSnapshotDoc {
  snapshotId: string;
  projectId: string;
  revision: number;
  scene: {
    schemaVersion: number;
    sceneId: string;
    revision: number;
    entities: ReadonlyArray<Record<string, unknown>>;
  };
  /** v3: the project's game block (null = scene mode). */
  game?: unknown;
}

// ---- server → client builders (§7.1) ------------------------------------------

function emit(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

export function makeAttached(connId: string, revision: number): string {
  return emit({ type: 'attached', connId, revision });
}

export function makePong(): string {
  return emit({ type: 'pong' });
}

export function makeMutationApplied(payload: {
  requestId: string;
  revision: number;
  origin: Origin | null;
  change: ChangeData;
}): string {
  return emit({
    type: 'mutation.applied',
    requestId: payload.requestId,
    revision: payload.revision,
    origin: payload.origin,
    change: payload.change,
  });
}

export function makePlayStarted(payload: {
  playSessionId: string;
  startedBy: Origin | null;
  snapshot: RuntimeSnapshotDoc;
  /** The play-content locator, so an editor can present a play another client started. */
  playContent?: { contentId: string; buildId: string; path: string };
}): string {
  return emit({
    type: 'play.started',
    playSessionId: payload.playSessionId,
    startedBy: payload.startedBy,
    snapshot: payload.snapshot,
    ...(payload.playContent !== undefined ? { playContent: payload.playContent } : {}),
  });
}

export function makePlayStopRequest(playSessionId: string, reason: PlayStopRequestReason): string {
  return emit({ type: 'play.stop.request', playSessionId, reason });
}

export function makePlayStopped(payload: {
  playSessionId: string;
  reason: PlayStopReason;
  stopUnconfirmed?: true;
}): string {
  const obj: Record<string, unknown> = {
    type: 'play.stopped',
    playSessionId: payload.playSessionId,
    reason: payload.reason,
  };
  if (payload.stopUnconfirmed === true) obj.stopUnconfirmed = true;
  return emit(obj);
}

export function makeScreenshotRequest(relayId: string, maxWidth?: number): string {
  const obj: Record<string, unknown> = { type: 'screenshot.request', relayId };
  if (maxWidth !== undefined) obj.maxWidth = maxWidth;
  return emit(obj);
}

export function makeDiagnosticsRequest(relayId: string): string {
  return emit({ type: 'play.diagnostics.request', relayId });
}

/**
 * The bounded input-exercise relay request (sessions.md §18.1; the WS event
 * name is a packet-35 contract-change request — §7's catalog predates §18).
 * Step-indexed semantic frames only: never DOM events, never `eval`.
 */
export function makeInputRelayRequest(
  requestId: string,
  frames: readonly { readonly stepOffset: number; readonly moveX: number; readonly jump: string }[],
): string {
  return emit({
    type: 'input.request',
    requestId,
    frames: frames.map((f) => ({ stepOffset: f.stepOffset, moveX: f.moveX, jump: f.jump })),
  });
}

/**
 * §20.1 control request forwarded to the owner editor (packet-42 §7.1 row;
 * this catalog's M1 set predates §20). Never carries bytes or a capability.
 */
export function makeGameControlRequest(relayId: string, command: string, expectedRunId?: string, sceneId?: string): string {
  const obj: Record<string, unknown> = { type: 'game.control.request', relayId, command };
  if (expectedRunId !== undefined) obj.expectedRunId = expectedRunId;
  if (sceneId !== undefined) obj.sceneId = sceneId;
  return emit(obj);
}

/** §20.1 observation request forwarded to the owner editor. */
export function makeGameObserveRequest(relayId: string, timeoutMs: number): string {
  return emit({ type: 'game.observe.request', relayId, timeoutMs });
}

export function makeErrorEvent(
  code: 'unknown_event' | 'protocol_error',
  frameHint?: string,
): string {
  const obj: Record<string, unknown> = { type: 'error', code };
  if (frameHint !== undefined) obj.frameHint = frameHint.slice(0, 64);
  return emit(obj);
}

// ---- client → server validation (§7.2) ----------------------------------------

export type InboundEvent =
  | { type: 'ping' }
  | { type: 'selection.changed'; entityIds: readonly string[] }
  | { type: 'play.preview.ready'; playSessionId: string }
  | { type: 'play.preview.failed'; playSessionId: string; code: string; message?: string }
  | { type: 'play.stopped.ack'; playSessionId: string }
  | {
      type: 'screenshot.ack';
      relayId: string;
      ok: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: { code: string; message?: string };
    }
  | {
      type: 'play.diagnostics.ack';
      relayId: string;
      ok: boolean;
      diagnostics?: unknown;
      error?: { code: string; message?: string };
    }
  | {
      type: 'input.result';
      requestId: string;
      ok: boolean;
      appliedFromStep?: number;
      appliedToStep?: number;
      error?: { code: string; message?: string };
    }
  | {
      type: 'game.control.ack';
      relayId: string;
      ok: boolean;
      result?: unknown;
      error?: { code: string; message?: string };
    }
  | {
      type: 'game.observe.ack';
      relayId: string;
      ok: boolean;
      result?: unknown;
      error?: { code: string; message?: string };
    };

/**
 * Validate one strict client → server event (sessions.md §7.2).
 * - unknown `type` ⇒ `{ ok: false, kind: 'unknown_event', type }`
 *   (the connection SURVIVES — the robustness rule, §7);
 * - malformed shape / unknown field ⇒ `{ ok: false, kind: 'protocol_error' }`.
 */
export function parseInboundEvent(value: unknown):
  | { ok: true; event: InboundEvent }
  | { ok: false; kind: 'unknown_event'; type: string }
  | { ok: false; kind: 'protocol_error'; error: SessionError } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      kind: 'protocol_error',
      error: {
        code: 'protocol_error',
        cls: 'validation',
        message: 'WS frame must be a strict JSON object event',
        path: '',
      },
    };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    return {
      ok: false,
      kind: 'protocol_error',
      error: {
        code: 'protocol_error',
        cls: 'validation',
        message: 'event.type is required (string)',
        path: '/type',
      },
    };
  }
  const type = obj.type;
  if (!(CLIENT_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, kind: 'unknown_event', type };
  }
  switch (type) {
    case 'ping': {
      const s = checkShape(obj, '', new Map([['type', '"ping"']]), ['type']);
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      return { ok: true, event: { type: 'ping' } };
    }
    case 'selection.changed': {
      const s = checkShape(obj, '', new Map([['type', '"selection.changed"'], ['entityIds', 'array of ≤ 64 entity IDs']]), ['type', 'entityIds']);
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const ids = s.value.entityIds;
      if (!Array.isArray(ids) || ids.length > 64 || !ids.every((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) {
        return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'entityIds must be ≤ 64 entity IDs', path: '/entityIds' } };
      }
      return { ok: true, event: { type: 'selection.changed', entityIds: ids as string[] } };
    }
    case 'play.preview.ready':
    case 'play.stopped.ack': {
      const s = checkShape(obj, '', new Map([['type', `"${type}"`], ['playSessionId', 'play- + 32 hex']]), ['type', 'playSessionId']);
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const id = checkField(s.value, 'playSessionId', '', 'play- + 32 hex', (v) =>
        isPlaySessionId(v) ? null : { problem: 'playSessionId must be play- + 32 hex', kind: 'value' },
      );
      if (!id.ok) return { ok: false, kind: 'protocol_error', error: id.error };
      return {
        ok: true,
        event: { type: type as 'play.preview.ready' | 'play.stopped.ack', playSessionId: id.value as string },
      };
    }
    case 'play.preview.failed': {
      const s = checkShape(
        obj,
        '',
        new Map([
          ['type', '"play.preview.failed"'],
          ['playSessionId', 'play- + 32 hex'],
          ['code', 'string (the failure code)'],
          ['message', 'string ≤ 256 (optional)'],
        ]),
        ['type', 'playSessionId', 'code'],
      );
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const id = checkField(s.value, 'playSessionId', '', 'play- + 32 hex', (v) =>
        isPlaySessionId(v) ? null : { problem: 'playSessionId must be play- + 32 hex', kind: 'value' },
      );
      if (!id.ok) return { ok: false, kind: 'protocol_error', error: id.error };
      const code = checkField(s.value, 'code', '', 'non-empty string', (v) =>
        typeof v === 'string' && v.length >= 1 && v.length <= 256
          ? null
          : { problem: 'code must be a non-empty string ≤ 256', kind: 'type' },
      );
      if (!code.ok) return { ok: false, kind: 'protocol_error', error: code.error };
      let message: string | undefined;
      if (s.value.message !== undefined) {
        const m = checkField(s.value, 'message', '', 'string ≤ 256', (v) =>
          typeof v === 'string' && v.length <= 256
            ? null
            : { problem: 'message must be a string ≤ 256 chars', kind: 'type' },
        );
        if (!m.ok) return { ok: false, kind: 'protocol_error', error: m.error };
        message = m.value as string;
      }
      return {
        ok: true,
        event: { type: 'play.preview.failed', playSessionId: id.value as string, code: code.value as string, message },
      };
    }
    case 'screenshot.ack': {
      const s = checkShape(
        obj,
        '',
        new Map([
          ['type', '"screenshot.ack"'],
          ['relayId', 'relay- + 32 hex'],
          ['ok', 'boolean'],
          ['dataUrl', 'data: URL (base64 PNG, ≤ 1 MiB decoded) — when ok'],
          ['width', 'integer ≥ 1 — when ok'],
          ['height', 'integer ≥ 1 — when ok'],
          ['error', '{ code, message? } — when not ok'],
        ]),
        ['type', 'relayId', 'ok'],
      );
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const rid = checkField(s.value, 'relayId', '', 'relay- + 32 hex', (v) =>
        isRelayId(v) ? null : { problem: 'relayId must be relay- + 32 hex', kind: 'value' },
      );
      if (!rid.ok) return { ok: false, kind: 'protocol_error', error: rid.error };
      const ok = checkField(s.value, 'ok', '', 'boolean', (v) =>
        typeof v === 'boolean' ? null : { problem: 'ok must be a boolean', kind: 'type' },
      );
      if (!ok.ok) return { ok: false, kind: 'protocol_error', error: ok.error };
      const event: InboundEvent = {
        type: 'screenshot.ack',
        relayId: rid.value as string,
        ok: ok.value as boolean,
      };
      const err = checkAckFields(s.value, event);
      if (!err.ok) return { ok: false, kind: 'protocol_error', error: err.error };
      // Carry the capture payload through (the backend does the semantic
      // validation — data: URL prefix, dimensions — sessions.md §7.2/§12).
      if (event.ok) {
        const v = s.value as Record<string, unknown>;
        const ev = event as { dataUrl?: string; width?: number; height?: number };
        if (v.dataUrl !== undefined) {
          if (typeof v.dataUrl !== 'string' || v.dataUrl.length < 1) {
            return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'dataUrl must be a non-empty string', path: '/dataUrl' } };
          }
          ev.dataUrl = v.dataUrl;
        }
        if (v.width !== undefined && !isPosInt(v.width)) {
          return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'width must be an integer >= 1', path: '/width' } };
        }
        if (v.height !== undefined && !isPosInt(v.height)) {
          return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'height must be an integer >= 1', path: '/height' } };
        }
        if (typeof v.width === 'number') ev.width = v.width;
        if (typeof v.height === 'number') ev.height = v.height;
      }
      return { ok: true, event };
    }
    case 'play.diagnostics.ack': {
      const s = checkShape(
        obj,
        '',
        new Map([
          ['type', '"play.diagnostics.ack"'],
          ['relayId', 'relay- + 32 hex'],
          ['ok', 'boolean'],
          ['diagnostics', 'object ≤ 16 KiB JSON — when ok'],
          ['error', '{ code, message? } — when not ok'],
        ]),
        ['type', 'relayId', 'ok'],
      );
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const rid = checkField(s.value, 'relayId', '', 'relay- + 32 hex', (v) =>
        isRelayId(v) ? null : { problem: 'relayId must be relay- + 32 hex', kind: 'value' },
      );
      if (!rid.ok) return { ok: false, kind: 'protocol_error', error: rid.error };
      const okf = checkField(s.value, 'ok', '', 'boolean', (v) =>
        typeof v === 'boolean' ? null : { problem: 'ok must be a boolean', kind: 'type' },
      );
      if (!okf.ok) return { ok: false, kind: 'protocol_error', error: okf.error };
      const event: InboundEvent = {
        type: 'play.diagnostics.ack',
        relayId: rid.value as string,
        ok: okf.value as boolean,
      };
      if (s.value.diagnostics !== undefined) {
        if (typeof s.value.diagnostics !== 'object' || s.value.diagnostics === null || Array.isArray(s.value.diagnostics)) {
          return {
            ok: false,
            kind: 'protocol_error',
            error: {
              code: 'protocol_error',
              cls: 'validation',
              message: 'diagnostics must be a JSON object (≤ 16 KiB)',
              path: '/diagnostics',
            },
          };
        }
        if (JSON.stringify(s.value.diagnostics).length > 16384) {
          return {
            ok: false,
            kind: 'protocol_error',
            error: {
              code: 'protocol_error',
              cls: 'validation',
              message: 'diagnostics exceeds the 16 KiB bound',
              path: '/diagnostics',
            },
          };
        }
        event.diagnostics = s.value.diagnostics;
      }
      const err = checkAckFields(s.value, event);
      if (!err.ok) return { ok: false, kind: 'protocol_error', error: err.error };
      return { ok: true, event };
    }
    case 'input.result': {
      const s = checkShape(
        obj,
        '',
        new Map([
          ['type', '"input.result"'],
          ['requestId', 'req- + 32 hex'],
          ['ok', 'boolean'],
          ['appliedFromStep', 'integer ≥ 0 — when ok'],
          ['appliedToStep', 'integer ≥ appliedFromStep — when ok'],
          ['error', '{ code, message? } — when not ok'],
        ]),
        ['type', 'requestId', 'ok'],
      );
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const rid = checkField(s.value, 'requestId', '', 'req- + 32 hex', (v) =>
        isRequestId(v) ? null : { problem: 'requestId must be req- + 32 hex', kind: 'value' },
      );
      if (!rid.ok) return { ok: false, kind: 'protocol_error', error: rid.error };
      const okf = checkField(s.value, 'ok', '', 'boolean', (v) =>
        typeof v === 'boolean' ? null : { problem: 'ok must be a boolean', kind: 'type' },
      );
      if (!okf.ok) return { ok: false, kind: 'protocol_error', error: okf.error };
      const event: InboundEvent = { type: 'input.result', requestId: rid.value as string, ok: okf.value as boolean };
      const from = s.value.appliedFromStep;
      const to = s.value.appliedToStep;
      if (event.ok) {
        if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
          return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'appliedFromStep must be an integer ≥ 0 when ok', path: '/appliedFromStep' } };
        }
        if (typeof to !== 'number' || !Number.isInteger(to) || to < from) {
          return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'appliedToStep must be an integer ≥ appliedFromStep when ok', path: '/appliedToStep' } };
        }
        event.appliedFromStep = from;
        event.appliedToStep = to;
        if (s.value.error !== undefined) {
          return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'error must be absent when ok is true', path: '/error' } };
        }
      } else if (s.value.error === undefined) {
        return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'error is required when ok is false', path: '/error' } };
      }
      const err = checkAckFields(s.value, event);
      if (!err.ok) return { ok: false, kind: 'protocol_error', error: err.error };
      return { ok: true, event };
    }
    case 'game.control.ack':
    case 'game.observe.ack': {
      const isControl = type === 'game.control.ack';
      const s = checkShape(
        obj,
        '',
        new Map([
          ['type', `"${type}"`],
          ['relayId', 'relay- + 32 hex'],
          ['ok', 'boolean'],
          ['result', isControl ? 'the §20 control result (≤ 4 KiB) — when ok' : 'the §20 observation document (≤ 16 KiB) — when ok'],
          ['error', '{ code, message? } — when not ok'],
        ]),
        ['type', 'relayId', 'ok'],
      );
      if (!s.ok) return { ok: false, kind: 'protocol_error', error: s.error };
      const rid = checkField(s.value, 'relayId', '', 'relay- + 32 hex', (v) =>
        isRelayId(v) ? null : { problem: 'relayId must be relay- + 32 hex', kind: 'value' },
      );
      if (!rid.ok) return { ok: false, kind: 'protocol_error', error: rid.error };
      const okf = checkField(s.value, 'ok', '', 'boolean', (v) =>
        typeof v === 'boolean' ? null : { problem: 'ok must be a boolean', kind: 'type' },
      );
      if (!okf.ok) return { ok: false, kind: 'protocol_error', error: okf.error };
      const event: InboundEvent = isControl
        ? { type: 'game.control.ack', relayId: rid.value as string, ok: okf.value as boolean }
        : { type: 'game.observe.ack', relayId: rid.value as string, ok: okf.value as boolean };
      if (event.ok) {
        // The editor relays the preview's exact result (never fabricates,
        // §7.2): the §20 shapes are validated here so a malformed result is a
        // bounded protocol_error, not a silent success.
        const verdict = isControl ? validateGameControlResult(s.value.result) : validateGameObservation(s.value.result);
        if (!verdict.ok) return { ok: false, kind: 'protocol_error', error: verdict.error };
        event.result = s.value.result;
      }
      const err = checkAckFields(s.value, event);
      if (!err.ok) return { ok: false, kind: 'protocol_error', error: err.error };
      return { ok: true, event };
    }
    default:
      return { ok: false, kind: 'protocol_error', error: { code: 'protocol_error', cls: 'validation', message: 'unreachable' } };
  }
}

/** Shared ok/error payload rules for the relay acks (§7.2). */
function isPosInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function checkAckFields(
  obj: Record<string, unknown>,
  event: { ok: boolean; error?: { code: string; message?: string } },
): { ok: true } | { ok: false; error: SessionError } {
  if (event.ok) {
    if (obj.error !== undefined) {
      return {
        ok: false,
        error: {
          code: 'protocol_error',
          cls: 'validation',
          message: 'error must be absent when ok is true',
          path: '/error',
        },
      };
    }
  } else if (obj.error === undefined) {
    return {
      ok: false,
      error: {
        code: 'protocol_error',
        cls: 'validation',
        message: 'error is required when ok is false',
        path: '/error',
      },
    };
  } else {
    const e = obj.error as Record<string, unknown>;
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      return { ok: false, error: { code: 'protocol_error', cls: 'validation', message: 'error must be an object', path: '/error' } };
    }
    for (const k of Object.keys(e)) {
      if (k !== 'code' && k !== 'message') {
        return {
          ok: false,
          error: {
            code: 'protocol_error',
            cls: 'validation',
            message: `unknown error field "${k}"`,
            path: `/error/${k}`,
          },
        };
      }
    }
    if (typeof e.code !== 'string' || e.code.length < 1 || e.code.length > 128) {
      return { ok: false, error: { code: 'protocol_error', cls: 'validation', message: 'error.code must be a non-empty string ≤ 128', path: '/error/code' } };
    }
    if (e.message !== undefined && (typeof e.message !== 'string' || e.message.length > 256)) {
      return { ok: false, error: { code: 'protocol_error', cls: 'validation', message: 'error.message must be a string ≤ 256', path: '/error/message' } };
    }
    event.error = { code: e.code, ...(e.message !== undefined ? { message: e.message as string } : {}) };
  }
  return { ok: true };
}

/**
 * §5.2 frame bounds: incoming ≤ 64 KiB, EXCEPT `screenshot.ack` ≤ 1.5 MiB.
 * The check runs on the raw frame before validation: over the 64 KiB bound
 * only a `screenshot.ack`-shaped frame may proceed; anything else is
 * `frame_too_big` (close 1009).
 */
export const WS_IN_FRAME_MAX = 64 * 1024;
export const WS_SCREENSHOT_ACK_MAX = 1.5 * 1024 * 1024;
export const WS_OUT_FRAME_MAX = 1024 * 1024;

export function inboundFrameAllowed(frameLength: number): boolean {
  return frameLength <= WS_SCREENSHOT_ACK_MAX;
}

/**
 * Enforce the 64 KiB default bound for non-`screenshot.ack` frames.
 * `frame` is the strict-parsed value; a frame over the bound whose type is
 * not `screenshot.ack` ⇒ false (close 1009 `frame_too_big`).
 */
export function enforceDefaultFrameBound(frameLength: number, parsed: unknown): boolean {
  if (frameLength <= WS_IN_FRAME_MAX) return true;
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).type === 'screenshot.ack'
  );
}