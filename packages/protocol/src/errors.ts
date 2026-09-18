/**
 * Session-layer error model — sessions.md §11.2/§11.3 (normative).
 *
 * Error shape: `{ code, cls, message (≤ 256 chars, log-safe, no secrets),
 * hint?, …code-specific fields }`. HTTP status mapping (normative, §11.2):
 * validation→400, conflict→409, not_found→404, unavailable→500→503,
 * internal→500; success→200. WS close codes per §4.3/§5.2.
 *
 * Pure: no I/O.
 */

/** The stable session-layer error codes (sessions.md §11.3, normative). */
export const ERROR_CODES = [
  'unauthorized',
  'bad_origin',
  'invalid_request',
  'field_missing',
  'field_unexpected',
  'field_type',
  'field_value',
  'session_conflict',
  'session_not_found',
  'session_required',
  'ws_token_invalid',
  'ws_token_replayed',
  'unknown_event',
  'protocol_error',
  'project_not_found',
  'project_unavailable',
  'play_already_active',
  'play_not_found',
  'session_unavailable',
  'screenshot_timeout',
  'diagnostics_timeout',
  'relay_failed',
] as const;

export type SessionErrorCode = (typeof ERROR_CODES)[number];

export type ErrorClass =
  | 'validation'
  | 'conflict'
  | 'unavailable'
  | 'not_found'
  | 'internal';

/** One structured session-layer error object. */
export interface SessionError {
  code: SessionErrorCode;
  cls: ErrorClass;
  /** ≤ 256 chars, log-safe, no secrets/paths. */
  message: string;
  hint?: string;
  /** `bad_origin`: the Origin value (clipped ≤ 256). */
  found?: string;
  /** strict-shape failures: JSON Pointer into the payload. */
  path?: string;
  /** strict-shape failures. */
  expected?: string;
  /** `unknown_event`: the offending type (clipped ≤ 64). */
  type?: string;
  /** `session_conflict` (§5.1). */
  activeSessionId?: string;
  lastActivityAt?: number;
  /** `session_not_found` (§11.3). */
  sessionId?: string;
  /** `play_already_active` (§10.1). */
  activePlaySessionId?: string;
  /** `project_not_found` (§11.3). */
  projectId?: string;
  /** `project_unavailable` (§11.3 — a permitted reason, workspace.md §11). */
  reason?: string;
  holder?: unknown;
  details?: unknown;
  /** `session_unavailable` (§11.3). */
  playSessionId?: string;
  /** `screenshot_timeout` / `diagnostics_timeout` (§11.3). */
  relayId?: string;
  /** `relay_failed` (§11.3): the preview/bridge cause. The §11.3 table
   *  lists the carried field as `code?`; the top-level `code` is fixed to
   *  `relay_failed` by the same row + §7.2, so the cause travels under
   *  `cause` (interpretation recorded in docs/handoffs/09.md). */
  cause?: string;
}

export const MESSAGE_LIMIT = 256;

export function clipMessage(message: string): string {
  if (message.length <= MESSAGE_LIMIT) return message;
  return `${message.slice(0, MESSAGE_LIMIT - 1)}…`;
}

/** Build a structured session-layer error (message always clipped). */
export function sessionError(
  code: SessionErrorCode,
  cls: ErrorClass,
  message: string,
  extra?: Partial<SessionError>,
): SessionError {
  return { code, cls, message: clipMessage(message), ...extra };
}

/**
 * §11.2 HTTP status mapping (normative): validation→400, conflict→409,
 * not_found→404, unavailable→503, internal→500.
 */
export function statusFor(cls: ErrorClass): number {
  switch (cls) {
    case 'validation':
      return 400;
    case 'conflict':
      return 409;
    case 'not_found':
      return 404;
    case 'unavailable':
      return 503;
    case 'internal':
      return 500;
  }
}

/**
 * The §4.3/§5.2 WS close mapping for the upgrade-time failure codes.
 * (Runtime protocol closes: 1009 frame_too_big, 1008 protocol_error,
 * 1000 heartbeat_timeout — see ws-events.ts.)
 */
export const WS_CLOSE_UNAUTHORIZED = 1008;
export const WS_CLOSE_PROTOCOL = 1008;
export const WS_CLOSE_FRAME_TOO_BIG = 1009;
export const WS_CLOSE_NORMAL = 1000;