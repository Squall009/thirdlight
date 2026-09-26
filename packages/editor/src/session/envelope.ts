/**
 * Command envelope + ack-loss retry discipline (sessions.md §6.1/§8.4;
 * commands.md §4/§7.2; packet 10).
 *
 * The browser issues a mutation with a client-generated `requestId`. If the
 * ack is LOST (timeout / network drop), the browser retries with the SAME
 * `requestId` — the backend then either replays the recorded result
 * (`duplicated: true`) or executes it fresh; either way the envelope revision
 * advances EXACTLY ONCE (commands.md §7.2). The browser adopts the
 * authoritative `revision` the backend returns (it never advances its own
 * counter independently).
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

import { REQUEST_ID_RE } from '@thirdlight/protocol';

/** The origin of a command (sessions.md §3). */
export interface Origin {
  kind: 'browser' | 'mcp';
  clientId: string;
}

/** A full command envelope (commands.md §4). */
export interface CommandEnvelope {
  op: string;
  projectId: string;
  requestId: string;
  expectedRevision: number;
  args?: unknown;
  origin: Origin;
}

/**
 * The backend's mutation response (commands.md §5/§6.4) — the fields the
 * browser needs to advance its projection and decide retries.
 */
export type MutationResponse =
  | { ok: true; revision: number; duplicated: boolean; change: unknown }
  | {
      ok: false;
      code: string;
      message?: string;
      currentRevision?: number;
      /** `limits_exceeded` detail: the declared bound that was exceeded. */
      limit?: string;
      current?: number;
      max?: number;
      /** Phase 23.7: `behavior_trust_unacknowledged` — the digest to acknowledge. */
      sourceDigest?: string;
      /** Phase 23.7: a script library change a dependent script does not compile against. */
      behaviorId?: string;
      diagnostics?: import('./behavior-publication').CompileDiagnosticView[];
    };

/** A transport-level outcome for a command the browser sent. */
export type CommandOutcome =
  | { status: 'response'; response: MutationResponse }
  | { status: 'lost' }; // no response at all (timeout / drop)

/** A client-generated `requestId` (`req-` + 32 lowercase hex). */
export function makeRequestId(rng: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 32; i++) {
    hex += Math.floor(rng() * 16).toString(16);
  }
  return `req-${hex}`;
}

export function isValidRequestId(id: string): boolean {
  return REQUEST_ID_RE.test(id);
}

/** Build a command envelope (commands.md §4). */
export function makeEnvelope(
  op: string,
  projectId: string,
  requestId: string,
  expectedRevision: number,
  args: unknown,
  origin: Origin,
): CommandEnvelope {
  return { op, projectId, requestId, expectedRevision, args, origin };
}

/** The establish request body (sessions.md §5.1). */
export interface EstablishBody {
  projectId: string;
  sessionId: string;
  clientInfo: { kind: 'browser'; label?: string };
}

export function makeEstablishBody(projectId: string, sessionId: string, label = 'editor'): EstablishBody {
  return { projectId, sessionId, clientInfo: { kind: 'browser', label } };
}

/** The browser adopts the authoritative backend revision (never self-advances). */
export function adoptRevision(current: number, response: MutationResponse): number {
  if (response.ok && response.revision !== undefined) {
    return Math.max(current, response.revision);
  }
  return current;
}

/** Whether a response is a duplicate replay (same requestId already applied). */
export function isDuplicateResponse(response: MutationResponse): boolean {
  return response.ok === true && response.duplicated === true;
}

export interface RetryDecision {
  /** Whether the browser should re-issue the command. */
  retry: boolean;
  /** The requestId to use on the (re-)issue — ALWAYS the original one. */
  requestId: string;
  /** Why (for the UI / logs). */
  reason: string;
}

/**
 * Decide what to do after a command outcome (sessions.md §8.4). The same
 * `requestId` is ALWAYS reused on retry (idempotency). A `lost` ack retries at
 * most once; a `revision_conflict` is NOT auto-retried here (the gesture
 * handles the bounded auto-rebase); any other error is surfaced.
 */
export function decideRetry(originalRequestId: string, outcome: CommandOutcome, alreadyRetried: boolean): RetryDecision {
  if (outcome.status === 'response') {
    const r = outcome.response;
    if (r.ok) {
      return { retry: false, requestId: originalRequestId, reason: r.duplicated ? 'duplicate replay accepted' : 'applied' };
    }
    if (r.code === 'revision_conflict') {
      // Handled by the gesture (bounded auto-rebase), not a blind retry.
      return { retry: false, requestId: originalRequestId, reason: 'revision_conflict — gesture auto-rebase path' };
    }
    return { retry: false, requestId: originalRequestId, reason: `surfaced error ${r.code}` };
  }
  // lost ack
  if (alreadyRetried) {
    return { retry: false, requestId: originalRequestId, reason: 'lost ack — single retry already used; surfacing' };
  }
  return { retry: true, requestId: originalRequestId, reason: 'lost ack — retrying with the same requestId (idempotent)' };
}