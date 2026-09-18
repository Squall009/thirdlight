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
  'claim_inconsistent',
  'stale_ownership',
  'workspace_closed',
  'external_change_invalid',
  'external_change_unreadable',
  'external_change_evidence_missing',
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
  | 'claim_inconsistent'
  | 'stale_ownership'
  | 'workspace_closed'
  | 'external_change_unresolved'
  | 'external_change_unreadable';

/** Reason-specific recovery advice (workspace.md semantics). */
function reasonHint(reason: UnavailableReason): string {
  switch (reason) {
    case 'ownership_conflict':
      // Pinned by fixtures/commands/scenarios/09 (messages.json step 1).
      return 'another live backend owns this project; stop it or wait for an operator takeover';
    case 'claim_inconsistent':
      // workspace.md §11 hint (the §6.3 stuck state: the claim file is
      // unresolvable — operator file operation, no backend command).
      return 'the claim file at the target epoch cannot be reclaimed: confirm the holder is dead, remove the orphan claim file, and re-issue the open (operator file operation — no backend command, workspace.md §6.3/§11)';
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

/** `external_change_unresolved` (commands.md §5.4; payload pinned by scenario 08).
 * `pendingChange.snapshotState` is the §7.2 step-2 outcome of the
 * detection that set the pending change — "ok" (the recovery snapshot is
 * durable; the scenario-08 pinning) or "snapshot_failed" (the bytes were
 * read and validated but no snapshot is durable, workspace.md §7.2 step 2
 * / §11 `paused-snapshot-failed`). Every call site passes a pending change
 * established over READABLE bytes (the `external_change_unreadable` code
 * covers the step-1 failure), so the narrower state type holds. The
 * `externalHash`/`externalValid`/`externalErrorCount` fields are nullable
 * because the pending state carries them as nulls in the `snapshot_failed`
 * producer's payloads; every call site today passes the readable (non-null)
 * shape, and the emitted object is identical for non-null values. */
export function externalChangeUnresolved(pending: {
  snapshotState: 'ok' | 'snapshot_failed';
  externalHash: string | null;
  externalValid: boolean | null;
  externalErrorCount: number | null;
}): CommandError {
  return {
    code: 'external_change_unresolved',
    cls: 'unavailable',
    pendingChange: {
      snapshotState: pending.snapshotState,
      externalHash: pending.externalHash,
      externalValid: pending.externalValid,
      externalErrorCount: pending.externalErrorCount,
    },
    message: 'an unexpected external modification is pending resolution; writes are paused',
    hint: 'an operator must resolve the pending change (acceptExternalState or discardExternalState); dedup replays and queries remain available',
  };
}

/** `external_change_unreadable` (workspace.md §11; the §7.2 step-1 payload).
 * Carries `projectId`, `snapshotState: "unreadable"`, and `pendingChange`
 * with `externalHash: null` (the bytes were never read — nothing was
 * snapshotted). Mirrors the `externalChangeUnresolved` wrapper/pendingChange
 * shape with the §11 additions (`snapshotState` is not on the commands
 * `CommandError` interface — the record-and-cast convention the other
 * workspace-level constructors use). */
export function externalChangeUnreadable(projectId: string): CommandError {
  const e: Record<string, unknown> = {
    code: 'external_change_unreadable',
    cls: 'unavailable',
    projectId,
    snapshotState: 'unreadable',
    pendingChange: {
      externalHash: null,
      externalValid: null,
      externalErrorCount: null,
    },
  };
  e['message'] =
    'the scene file could not be read (a non-ENOENT read error); the on-disk bytes are unknown and no snapshot was taken; writes are paused';
  e['hint'] =
    'make the scene file readable and re-issue the command, or re-issue the resolution (acceptExternalState / discardExternalState) once the bytes are readable';
  return e as unknown as CommandError;
}

/** `external_change_evidence_missing` (workspace.md §11; the §7.2 step-2
 * payload). The pending change is readable (the real `pendingChange` info is
 * carried) but not durably snapshotted: `paused-snapshot-failed`; accept/
 * discard are refused until the snapshot is durable. Carries `projectId` and
 * `snapshotState: "snapshot_failed"`. */
export function externalChangeEvidenceMissing(
  projectId: string,
  pending: {
    externalHash: string | null;
    externalValid: boolean | null;
    externalErrorCount: number | null;
  },
): CommandError {
  const e: Record<string, unknown> = {
    code: 'external_change_evidence_missing',
    cls: 'unavailable',
    projectId,
    snapshotState: 'snapshot_failed',
    pendingChange: {
      externalHash: pending.externalHash,
      externalValid: pending.externalValid,
      externalErrorCount: pending.externalErrorCount,
    },
  };
  e['message'] =
    'the pending external change has no durable recovery snapshot; the resolution is refused until the snapshot is durable';
  e['hint'] =
    're-issue the resolution once the recovery snapshot is durable (the pending state and the pause persist)';
  return e as unknown as CommandError;
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

/** Operator-result error: `ownership_conflict` (workspace.md §6.2/§11).
 * Carries `holder` — the identity object of the parseable owned record —
 * or omits it when no parseable owned record exists (§11: `holder` is
 * `null` in that case, e.g. the claim file exists with foreign/absent
 * content at the target epoch, incl. the self-reclaim refusal). */
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

/** Operator-result error: `claim_inconsistent` (workspace.md §6.3/§11).
 * The claim file exists at the target epoch but cannot be reclaimed:
 * its content is unparseable/unreadable, or its holder's pid is not
 * proven dead under the §6.2 liveness rules (the §6.3 orphan-recovery
 * rule — the only liveness-referenced path). `cls: "unavailable"`;
 * carries `projectId`, the claim file path, the holder content if
 * parseable, and the liveness outcome; nothing is claimed. The operator
 * confirms the holder is dead, removes the orphan claim file, and
 * re-issues the open (an operator file operation — no backend
 * command). */
export function claimInconsistent(
  projectId: string,
  claimFile: string,
  holderContent: { backendId: string; pid: number; openedAt: string } | null,
  livenessOutcome: 'dead' | 'live' | 'unknown' | null,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'claim_inconsistent',
    cls: 'unavailable',
    projectId,
    claimFile,
  };
  if (holderContent !== null) e['holderContent'] = holderContent;
  if (livenessOutcome !== null) e['livenessOutcome'] = livenessOutcome;
  e['message'] =
    holderContent === null
      ? 'the claim file exists at the target epoch but its content is unparseable or unreadable — it cannot be reclaimed; nothing was claimed'
      : `the claim file's holder (${holderContent.backendId}, pid ${holderContent.pid}) is not proven dead (liveness: ${livenessOutcome}) — it cannot be reclaimed; nothing was claimed`;
  e['hint'] =
    'confirm the holder is dead, remove the orphan claim file, and re-issue the open (operator file operation — no backend command, workspace.md §6.3/§11)';
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
  if (found !== undefined) e['found'] = diagnosticFound(found);
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
    found: diagnosticFound(key),
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
  if (found !== undefined) e['found'] = diagnosticFound(found);
  return e as unknown as CommandError;
}

export function fieldValueType(
  path: string,
  found: unknown,
  expected: string,
  message: string,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'field_value',
    cls: 'validation',
    path,
  };
  if (found !== undefined) e['found'] = diagnosticFound(found);
  e['message'] = message;
  e['expected'] = expected;
  return e as unknown as CommandError;
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

// ---- bounded, JSON-safe diagnostic conversion (2026-09-18 review, R17) ------
//
// Public-input validation failures echo the offending value in `found`.
// The public API accepts arbitrary in-process values (BigInt, functions,
// self-referencing objects, class instances); echoing one raw makes the
// result unserializable (`JSON.stringify` throws on BigInt and on cycles),
// so the validator would manufacture the very protocol error it reports.
// Every `found` payload constructed in this module goes through the
// conversion below, which is always JSON-serializable and always bounded:
//   - depth limit: 8 container levels (deeper ⇒ marker string);
//   - node cap: 64 total nodes (containers + leaves; exhausted ⇒ marker);
//   - strings (values AND object keys): 200 chars, longer ⇒ truncated
//     with a total-length marker; at most 64 keys per object (the rest ⇒
//     a summary key);
//   - cycles: an identity seen-set ⇒ marker string;
//   - unsupported primitives (BigInt / Function / Symbol / undefined) and
//     exotic objects (Date / Map / Set / typed arrays / class instances)
//     ⇒ their type name as a string, never the raw value;
//   - non-finite numbers (NaN / ±Infinity) ⇒ their string form.
// Serialized-size bound: 64 nodes × ≤ ~240 chars + 64 keys × ≤ ~210 chars
// ≈ 30 KB for any caller input.

const DIAG_DEPTH_LIMIT = 8;
const DIAG_NODE_LIMIT = 64;
const DIAG_STRING_LIMIT = 200;
const DIAG_KEY_LIMIT = 64;

function truncateDiagnostic(s: string): string {
  return s.length <= DIAG_STRING_LIMIT
    ? s
    : `${s.slice(0, DIAG_STRING_LIMIT)}… (truncated, ${s.length} chars total)`;
}

function diagnosticValue(
  v: unknown,
  seen: Set<object>,
  budget: { nodes: number },
  depth: number,
): unknown {
  if (v === null) return null;
  if (typeof v === 'string') return truncateDiagnostic(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN';
  }
  if (typeof v === 'bigint') return 'BigInt';
  if (typeof v === 'function') return 'Function';
  if (typeof v === 'symbol') return 'Symbol';
  if (typeof v === 'undefined') return 'undefined';
  // Objects from here on.
  if (seen.has(v)) return '[circular]';
  if (depth > DIAG_DEPTH_LIMIT) return '[depth limit]';
  if (budget.nodes <= 0) return '[truncated]';
  if (Array.isArray(v)) {
    budget.nodes -= 1;
    seen.add(v);
    const out: unknown[] = [];
    for (const item of v) out.push(diagnosticValue(item, seen, budget, depth + 1));
    return out;
  }
  const tag = Object.prototype.toString.call(v); // '[object X]'
  if (tag === '[object Date]') return 'Date';
  if (tag !== '[object Object]') return tag.slice(8, -1); // Map/Set/typed arrays/instances
  if (!isPlainObject(v)) return 'Object';
  budget.nodes -= 1;
  seen.add(v);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v);
  const kept = Math.min(keys.length, DIAG_KEY_LIMIT);
  for (let i = 0; i < kept; i += 1) {
    const k = keys[i]!;
    out[truncateDiagnostic(k)] = diagnosticValue(v[k], seen, budget, depth + 1);
  }
  if (keys.length > DIAG_KEY_LIMIT) {
    out[`[+${keys.length - DIAG_KEY_LIMIT} more keys]`] = null;
  }
  return out;
}

/** The bounded, JSON-safe `found` payload (see the block above). */
function diagnosticFound(v: unknown): unknown {
  return diagnosticValue(v, new Set<object>(), { nodes: DIAG_NODE_LIMIT }, 0);
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