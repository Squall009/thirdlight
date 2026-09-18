/**
 * Workspace error model — workspace.md §11 (workspace code table) on top of
 * the commands.md §5.4 code set.
 *
 * The commands package constructs the pure-layer codes (its own
 * constructors); this module constructs the codes only the workspace
 * service can raise (resolution/availability, ownership, external-change,
 * creation) plus the shared `request_id_reused` / `external_change_unresolved`
 * / `write_failed` codes that the pipeline steps outside `applyMutation`
 * produce. Key order in emitted error objects follows the commands-layer
 * convention the scenario fixtures pin: `code`, `cls`, then the code-
 * specific fields, then `details`/`detailCount`, then `message`, `hint`.
 *
 * `cls` for the workspace-only operator codes (`no_pending_change`,
 * `external_change_invalid`, `project_exists_invalid`, `ownership_conflict`,
 * `stale_ownership`) is not pinned by the contracts: it follows the
 * commands.md §5.5 client policy (validation = wrong preconditions/args;
 * unavailable = operator-gated state; not_found = missing project).
 */

import { ERROR_CODES as COMMAND_ERROR_CODES } from '@thirdlight/commands';
import type { CommandError } from '@thirdlight/commands';
import type { ErrorCode, ModelError } from '@thirdlight/project-model';

/** The workspace.md §11 workspace code table (stable). */
export const WORKSPACE_ERROR_CODES = [
  'envelope_invalid',
  'storage_version_unsupported',
  'envelope_project_mismatch',
  'scene_invalid',
  'retry_records_invalid',
  'manifest_invalid',
  'ownership_conflict',
  'stale_ownership',
  'workspace_closed',
  'external_change_invalid',
  'no_pending_change',
  'project_exists_invalid',
] as const;

/**
 * Every code this service can surface: the commands.md §5.4 set (21) plus
 * the workspace.md §11 table. `workspace_closed` appears in both tables —
 * the union has no duplicates.
 */
const commandCodes: readonly string[] = COMMAND_ERROR_CODES;
const workspaceCodes: readonly string[] = WORKSPACE_ERROR_CODES;
export const ERROR_CODES: readonly string[] = [
  ...commandCodes,
  ...workspaceCodes.filter((c) => !commandCodes.includes(c)),
];

/** The `holder` object of ownership errors (workspace.md §11). */
export interface Holder {
  backendId: string;
  pid: number;
  openedAt: string;
  lockEpoch: number;
  state: 'owned' | 'released';
}

/**
 * `project_unavailable.reason` values this service raises: every
 * load-failure code (workspace.md §4.3 — the model error codes plus the
 * envelope-level codes) and the availability/ownership codes.
 */
export type UnavailableReason =
  | ErrorCode
  | 'storage_version_unsupported'
  | 'envelope_project_mismatch'
  | 'scene_invalid'
  | 'retry_records_invalid'
  | 'envelope_invalid'
  | 'ownership_conflict'
  | 'stale_ownership'
  | 'workspace_closed'
  | 'external_change_unresolved';

/** Reason-specific recovery advice (workspace.md semantics). */
function reasonHint(reason: UnavailableReason): string {
  switch (reason) {
    case 'ownership_conflict':
      // Pinned by fixtures/commands/scenarios/09 (messages.json step 1).
      return 'another live backend owns this project; stop it or wait for an operator takeover';
    case 'stale_ownership':
      // Pinned by fixtures/commands/scenarios/09 (messages.json step 2).
      return 'run takeoverWorkspace to take over the stale ownership record (explicit operator action; never automatic)';
    case 'workspace_closed':
      return 'the project is released for external maintenance; finish the external edit — the next open re-claims it (workspace.md §9)';
    case 'external_change_unresolved':
      return 'an operator must resolve the pending external change (acceptExternalState or discardExternalState)';
    default:
      return 'the authoring state on disk is invalid or unreadable; the bytes are retained untouched — repair the file by hand (a recovery snapshot or backup, if available) and re-open';
  }
}

/**
 * A load/validation detail. Structurally a model error, but the `code` is
 * not constrained to the model code set: the workspace raises its own
 * reason codes (e.g. `envelope_invalid` for a missing scene file) in
 * fabricated details alongside real model errors.
 */
export type LoadDetail = {
  code: string;
  path: string;
  message: string;
  expected?: string;
  found?: unknown;
  hint?: string;
  limit?: 'entities' | 'depth';
  knownVersions?: readonly number[];
  /** The invalid document, when the detail describes a rejected document. */
  document?: unknown;
};

/** `project_not_found` (commands.md §5.4: cls not_found). */
export function projectNotFound(projectId: string): CommandError {
  return {
    code: 'project_not_found',
    cls: 'not_found',
    projectId,
    message: `no project '${projectId}' with a loadable manifest exists at the data root`,
    hint: 'create the project (createProject) or check the project id',
  };
}

/** `project_unavailable` (commands.md §5.4: cls unavailable). */
export function projectUnavailable(
  reason: UnavailableReason,
  holder: Holder | null,
  details: readonly LoadDetail[],
): CommandError {
  // Key order (fixture-pinned for ownership reasons): code, cls, reason,
  // holder?, details?, detailCount?, message, hint.
  const e: Record<string, unknown> = {
    code: 'project_unavailable',
    cls: 'unavailable',
    reason,
  };
  if (holder !== null) e['holder'] = holder;
  if (details.length > 0) {
    e['details'] = details.slice(0, 10);
    e['detailCount'] = details.length;
  }
  e['message'] = `project cannot be used right now: ${reason}`;
  e['hint'] = reasonHint(reason);
  return e as unknown as CommandError;
}

/** `workspace_closed` (commands.md §5.4: cls unavailable) — mutations only. */
export function workspaceClosed(): CommandError {
  return {
    code: 'workspace_closed',
    cls: 'unavailable',
    message: 'the project was released for external maintenance',
    hint: 'finish the external edit; the next open re-claims the project and clears the boundary (workspace.md §9)',
  };
}

/** `request_id_reused` (commands.md §5.4/§6.2; payload pinned by scenario 02). */
export function requestIdReused(currentRevision: number): CommandError {
  return {
    code: 'request_id_reused',
    cls: 'conflict',
    currentRevision,
    message: 'requestId was already used with different content',
    hint: 're-read the project (queryProject) and re-issue the command with a fresh requestId and the current revision',
  };
}

/** `external_change_unresolved` (commands.md §5.4; payload pinned by scenario 08). */
export function externalChangeUnresolved(pending: {
  externalHash: string;
  externalValid: boolean;
  externalErrorCount: number;
}): CommandError {
  return {
    code: 'external_change_unresolved',
    cls: 'unavailable',
    pendingChange: {
      externalHash: pending.externalHash,
      externalValid: pending.externalValid,
      externalErrorCount: pending.externalErrorCount,
    },
    message: 'an unexpected external modification is pending resolution; writes are paused',
    hint: 'an operator must resolve the pending change (acceptExternalState or discardExternalState); dedup replays and queries remain available',
  };
}

/** `write_failed` (commands.md §5.4/§7.3: cls internal). */
export function writeFailed(
  onDiskState: 'previous' | 'new-undurable',
  errno: string | undefined,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'write_failed',
    cls: 'internal',
    onDiskState,
  };
  if (errno !== undefined) e['errno'] = errno;
  if (onDiskState === 'previous') {
    e['message'] = 'the durable write failed and the on-disk state is the previous (unchanged) state';
    e['hint'] = 'safe to retry the same request with the same requestId — no record exists, so it re-executes fresh (commands.md §7.3)';
  } else {
    e['message'] = 'the durable write completed its rename but the directory flush failed; durability is unproven';
    e['hint'] = 'the running state is self-consistent (with its record); a crash may lose the unflushed rename, and the gap is always observable, never silent (commands.md §7.3)';
  }
  return e as unknown as CommandError;
}

/** Operator-result error: `no_pending_change` (workspace.md §7.3/§11). */
export function noPendingChange(): CommandError {
  return {
    code: 'no_pending_change',
    cls: 'validation',
    message: 'there is no pending external change on this project to resolve',
    hint: 'external changes are detected at the next envelope write; no resolution is needed now',
  };
}

/** Operator-result error: `external_change_invalid` (workspace.md §7.2/§11). */
export function externalChangeInvalid(): CommandError {
  return {
    code: 'external_change_invalid',
    cls: 'validation',
    message: 'the pending external change failed validation; accepting invalid data is refused',
    hint: 'repair the external bytes by hand (they are retained in the recovery snapshot) or discard them (discardExternalState keeps the last known good state)',
  };
}

/** Operator-result error: `project_exists_invalid` (workspace.md §8.1/§11). */
export function projectExistsInvalid(
  details: readonly LoadDetail[],
): CommandError {
  const e: Record<string, unknown> = {
    code: 'project_exists_invalid',
    cls: 'unavailable',
    message: 'the project directory exists but the project is not loadable',
  };
  if (details.length > 0) {
    e['details'] = details.slice(0, 10);
    e['detailCount'] = details.length;
  }
  e['hint'] = 'repair the project files by hand, or remove the directory and create the project again';
  return e as unknown as CommandError;
}

/** Operator-result error: `ownership_conflict` (workspace.md §6.2/§11). */
export function ownershipConflict(holder: Holder | null): CommandError {
  const e: Record<string, unknown> = {
    code: 'ownership_conflict',
    cls: 'unavailable',
  };
  if (holder !== null) e['holder'] = holder;
  e['message'] =
    holder === null
      ? 'the ownership record is unreadable; another writer may hold the project — no takeover was performed'
      : 'another live backend owns this project; no automatic takeover is performed';
  e['hint'] = 'stop the other backend, or wait until its record becomes stale, then re-issue';
  return e as unknown as CommandError;
}

/** Operator-result error: `stale_ownership` (workspace.md §6.2/§6.4/§11). */
export function staleOwnership(holder: Holder | null): CommandError {
  const e: Record<string, unknown> = {
    code: 'stale_ownership',
    cls: 'unavailable',
  };
  if (holder !== null) e['holder'] = holder;
  e['message'] = 'the owning backend process is dead; explicit takeover is required';
  e['hint'] = 'run takeoverWorkspace(projectId) — automatic takeover is never performed (workspace.md §6.4)';
  return e as unknown as CommandError;
}

/** Envelope-level `invalid_request` (request-level schema failure). */
export function invalidRequest(
  path: string,
  found: unknown,
  expected: string,
  message: string,
  hint?: string,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'invalid_request',
    cls: 'validation',
    path,
  };
  if (found !== undefined) e['found'] = found;
  e['expected'] = expected;
  e['message'] = message;
  if (hint !== undefined) e['hint'] = hint;
  return e as unknown as CommandError;
}

/** `args`-level `field_*` failures for query/operator argument validation. */
export function fieldMissing(path: string, field: string): CommandError {
  return {
    code: 'field_missing',
    cls: 'validation',
    path,
    message: `required field '${field}' is missing`,
    expected: 'present',
  };
}

export function fieldUnexpected(path: string, key: string, known: string): CommandError {
  return {
    code: 'field_unexpected',
    cls: 'validation',
    path,
    found: key,
    message: 'unknown field is not permitted (strict M1 schema drops nothing)',
    expected: `known fields: ${known}`,
  };
}

export function fieldTypeError(path: string, found: unknown, expected: string): CommandError {
  const e: Record<string, unknown> = {
    code: 'field_type',
    cls: 'validation',
    path,
    message: `value must be of type ${expected}`,
    expected,
  };
  if (found !== undefined) e['found'] = found;
  return e as unknown as CommandError;
}

export function fieldValueType(
  path: string,
  found: unknown,
  expected: string,
  message: string,
): CommandError {
  return {
    code: 'field_value',
    cls: 'validation',
    path,
    found,
    message,
    expected,
  };
}

/** `entity_not_found` for queries (commands.md §5.4: cls validation). */
export function entityNotFound(entityId: string): CommandError {
  return {
    code: 'entity_not_found',
    cls: 'validation',
    entityId,
    message: `entity '${entityId}' does not exist in the current scene`,
    hint: 'query the scene (queryEntities) for current IDs',
  };
}

/** Plain-object check (same convention as the commands layer). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The safe-integer check used for revision/depth/limit values. */
export function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
}