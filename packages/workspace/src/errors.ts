/**
 * Workspace error model: the workspace code table on top of the commands
 * code set.
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
 * commands-layer client policy (validation = wrong preconditions/args;
 * unavailable = operator-gated state; not_found = missing project).
 */

import { ERROR_CODES as COMMAND_ERROR_CODES } from '@thirdlight/commands';
import type { CommandError } from '@thirdlight/commands';
import type { ErrorCode, LimitName, ModelError } from '@thirdlight/project-model';

/** The workspace code table (stable). The content-storage codes follow in
 * contract table order. */
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
  // content storage:
  'content_invalid',
  'version_combination_unsupported',
  'stage_not_found',
  'stage_expired',
  'stage_limits_exceeded',
  'path_rejected',
  'import_rejected',
  'asset_id_duplicate',
  'asset_not_found',
  'asset_version_not_found',
  'blob_missing',
  'blob_corrupt',
  'content_quota_exceeded',
  'content_publish_failed',
  'derived_cache_unavailable',
  'migration_source_invalid',
  'migration_destination_exists',
  'migration_marker_conflict',
  'migration_resume_required',
  'migration_version_unsupported',
  // Asset versions referenced in place in a game folder.
  'asset_source_missing',
  'asset_source_changed',
] as const;

/**
 * Every code this service can surface: the commands code set (21) plus
 * the workspace table. `workspace_closed` appears in both tables —
 * the union has no duplicates.
 */
const commandCodes: readonly string[] = COMMAND_ERROR_CODES;
const workspaceCodes: readonly string[] = WORKSPACE_ERROR_CODES;
export const ERROR_CODES: readonly string[] = [
  ...commandCodes,
  ...workspaceCodes.filter((c) => !commandCodes.includes(c)),
];

/** The `holder` object of ownership errors. */
export interface Holder {
  backendId: string;
  pid: number;
  openedAt: string;
  lockEpoch: number;
  state: 'owned' | 'released';
}

/**
 * `project_unavailable.reason` values this service raises: every
 * load-failure code (the model error codes plus the
 * envelope-level codes) and the availability/ownership codes. `manifest_invalid`
 * is the load-failure code for a manifest that exists on disk
 * but fails strict parse / `validateManifest` (the code table lists it and
 * permits it as a `project_unavailable.reason` —
 * "a project that exists on disk but cannot load is exactly what
 * project_unavailable reports" — block semantics).
 */
export type UnavailableReason =
  | ErrorCode
  | 'storage_version_unsupported'
  | 'envelope_project_mismatch'
  | 'scene_invalid'
  | 'retry_records_invalid'
  | 'envelope_invalid'
  | 'manifest_invalid'
  | 'ownership_conflict'
  | 'claim_inconsistent'
  | 'stale_ownership'
  | 'workspace_closed'
  | 'external_change_unresolved'
  | 'external_change_unreadable'
  | 'content_invalid'
  | 'version_combination_unsupported';

/** Reason-specific recovery advice (workspace.md semantics). */
function reasonHint(reason: UnavailableReason): string {
  switch (reason) {
    case 'ownership_conflict':
      // Pinned by fixtures/commands/scenarios/09 (messages.json step 1).
      return 'another live backend owns this project; stop it or wait for an operator takeover';
    case 'claim_inconsistent':
      // The stuck state: the claim file is
      // unresolvable — operator file operation, no backend command).
      return 'the claim file at the target epoch cannot be reclaimed: confirm the holder is dead, remove the orphan claim file, and re-issue the open (operator file operation — no backend command, workspace.md §6.3/§11)';
    case 'stale_ownership':
      // Not pinned by the corpus: the automatic reclaim serves scenario 09's step 2 (no stale error).
      return 'the previous owner is gone but the automatic reclaim failed; run takeoverWorkspace';
    case 'workspace_closed':
      return 'the project is released for external maintenance; finish the external edit — the next open re-claims it (workspace.md §9)';
    case 'external_change_unresolved':
      return 'an operator must resolve the pending external change (acceptExternalState or discardExternalState)';
    case 'storage_version_unsupported':
      // Storage v1/v2 projects are no longer opened; the bytes are left untouched.
      return 'the project files use a storage version this version does not open (storage v1/v2, removed in phase 9.3, or a newer one); the files are left untouched — convert a v1/v2 project to storage v3 with an earlier Thirdlight version (migrateProjectCopy / migrateProjectCopyV3), then open it here (v3 is upgraded to v4 on open)';
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
  limit?: LimitName;
  knownVersions?: readonly number[];
  /** The invalid document, when the detail describes a rejected document. */
  document?: unknown;
};

/** `project_not_found` (cls not_found). */
export function projectNotFound(projectId: string): CommandError {
  return {
    code: 'project_not_found',
    cls: 'not_found',
    projectId,
    message: `no project '${projectId}' with a loadable manifest exists at the data root`,
    hint: 'create the project (createProject) or check the project id',
  };
}

/** `project_unavailable` (cls unavailable). */
export function projectUnavailable(
  reason: UnavailableReason,
  holder: Holder | null,
  details: readonly LoadDetail[],
): CommandError {
  // Key order (fixture-pinned for ownership reasons): code, cls, reason,
  // holder?, details?, detailCount?, message, hint. For
  // ownership_conflict the `holder` field is ALWAYS present — the holder
  // object when a parseable owned record exists, strict `null` when it
  // does not.
  const e: Record<string, unknown> = {
    code: 'project_unavailable',
    cls: 'unavailable',
    reason,
  };
  if (holder !== null || reason === 'ownership_conflict') e['holder'] = holder;
  if (details.length > 0) {
    e['details'] = details.slice(0, 10);
    e['detailCount'] = details.length;
  }
  e['message'] = `project cannot be used right now: ${reason}`;
  e['hint'] = reasonHint(reason);
  return e as unknown as CommandError;
}

/** `workspace_closed` (cls unavailable) — mutations only. */
export function workspaceClosed(): CommandError {
  return {
    code: 'workspace_closed',
    cls: 'unavailable',
    message: 'the project was released for external maintenance',
    hint: 'finish the external edit; the next open re-claims the project and clears the boundary (workspace.md §9)',
  };
}

/** `request_id_reused` (payload pinned by scenario 02). */
export function requestIdReused(currentRevision: number): CommandError {
  return {
    code: 'request_id_reused',
    cls: 'conflict',
    currentRevision,
    message: 'requestId was already used with different content',
    hint: 're-read the project (queryProject) and re-issue the command with a fresh requestId and the current revision',
  };
}

/** `external_change_unresolved` (payload pinned by scenario 08).
 * `pendingChange.snapshotState` is the snapshot-step outcome of the
 * detection that set the pending change — "ok" (the recovery snapshot is
 * durable; the scenario-08 pinning) or "snapshot_failed" (the bytes were
 * read and validated but no snapshot is durable, `paused-snapshot-failed`). Every call site passes a pending change
 * established over READABLE bytes (the `external_change_unreadable` code
 * covers the read failure), so the narrower state type holds. The
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

/** `external_change_unreadable` (the read-step payload).
 * Carries `projectId`, `snapshotState: "unreadable"`, and `pendingChange`
 * with `externalHash: null` (the bytes were never read — nothing was
 * snapshotted). Mirrors the `externalChangeUnresolved` wrapper/pendingChange
 * shape with the workspace additions (`snapshotState` is not on the commands
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

/** `external_change_evidence_missing` (the snapshot-step payload). The pending change is readable (the real `pendingChange` info is
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

/** `write_failed` (cls internal). */
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

/** Operator-result error: `no_pending_change`. */
export function noPendingChange(): CommandError {
  return {
    code: 'no_pending_change',
    cls: 'validation',
    message: 'there is no pending external change on this project to resolve',
    hint: 'external changes are detected at the next envelope write; no resolution is needed now',
  };
}

/** Operator-result error: `external_change_invalid`. */
export function externalChangeInvalid(): CommandError {
  return {
    code: 'external_change_invalid',
    cls: 'validation',
    message: 'the pending external change failed validation; accepting invalid data is refused',
    hint: 'repair the external bytes by hand (they are retained in the recovery snapshot) or discard them (discardExternalState keeps the last known good state)',
  };
}

/** Operator-result error: `project_exists_invalid`. */
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

/** Operator-result error: `ownership_conflict`.
 * Carries `holder` — the identity object of the parseable owned record —
 * or strict `null` when no parseable owned record exists (e.g. the unreadable-record refusal,
 * the claim file existing with foreign/absent content at the target
 * epoch, incl. the self-reclaim refusal). The field is always present. */
export function ownershipConflict(holder: Holder | null): CommandError {
  const e: Record<string, unknown> = {
    code: 'ownership_conflict',
    cls: 'unavailable',
  };
  e['holder'] = holder; // strict null when absent
  e['message'] =
    holder === null
      ? 'the ownership record is unreadable; another writer may hold the project — no takeover was performed'
      : 'another live backend owns this project; no automatic takeover is performed';
  e['hint'] = 'stop the other backend, or wait until its record becomes stale, then re-issue';
  return e as unknown as CommandError;
}

/** Operator-result error: `claim_inconsistent`.
 * The claim file exists at the target epoch but cannot be reclaimed:
 * its content is unparseable/unreadable, or its holder's pid is not
 * proven dead under the liveness rules (the orphan-recovery rule — the
 * only liveness-referenced path). `cls: "unavailable"`;
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

/** Operator-result error: `stale_ownership`. */
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

/** `entity_not_found` for queries (cls validation). */
export function entityNotFound(entityId: string): CommandError {
  return {
    code: 'entity_not_found',
    cls: 'validation',
    entityId,
    message: `entity '${entityId}' does not exist in the current scene`,
    hint: 'query the scene (queryEntities) for current IDs',
  };
}

// ---- bounded, JSON-safe diagnostic conversion ------
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

/**
 * RFC 6901 escaping of one JSON Pointer reference token (Error `path` values are
 * "a JSON Pointer into the request"/envelope; RFC 6901 is the JSON Pointer
 * standard). `~` → `~0` FIRST, then `/` → `~1`. Every DYNAMIC key
 * interpolated into a `path` goes through this helper; static segment
 * names and numeric indices never need escaping.
 */
export function pointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
// ---- content-storage errors -----------------

/** A `limits_exceeded`-style staging bound. */
export type StageLimit =
  | 'stage_bytes'
  | 'frame_bytes'
  | 'open_stages'
  | 'staged_bytes_per_project';

/** `stage_limits_exceeded`. */
export function stageLimitsExceeded(
  limit: StageLimit,
  current: number,
  max: number,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'stage_limits_exceeded',
    cls: 'validation',
    limit,
    current,
    max,
    message: `a staging bound is exceeded: ${limit} ${current} > ${max}`,
    hint: 'reduce the staged bytes, discard an open stage, or raise the configured bound',
  };
  return e as unknown as CommandError;
}

/** `stage_not_found`. */
export function stageNotFound(stageId: string): CommandError {
  return {
    code: 'stage_not_found',
    cls: 'not_found',
    message: `the staging directory for '${stageId}' does not exist`,
    hint: 're-stage the bytes (stageContent) — staging is non-authoritative input',
  };
}

/** `stage_expired` (the 3 600 s stage TTL). */
export function stageExpired(stageId: string, ageSeconds: number, ttlSeconds: number): CommandError {
  return {
    code: 'stage_expired',
    cls: 'unavailable',
    message: `the stage '${stageId}' is ${ageSeconds}s old, past the ${ttlSeconds}s stage TTL`,
    hint: 're-stage the bytes and re-issue; an identical recorded command replays without the stage',
  };
}

/** `path_rejected`: a symlinked artifact
 * directory, a path escaping the project root, or a non-directory artifact
 * component. The backend never follows, repairs or deletes it. */
export function pathRejected(path: string, message: string): CommandError {
  return {
    code: 'path_rejected',
    cls: 'validation',
    path,
    message,
    hint: 'fix the artifact path by hand; the backend never follows or repairs symlinked paths',
  };
}

/** `blob_missing`. */
export function blobMissing(
  digest: string,
  path: string,
  assetId?: string,
  version?: number,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'blob_missing',
    cls: 'not_found',
  };
  if (assetId !== undefined) e['assetId'] = assetId;
  if (version !== undefined) e['assetVersion'] = version;
  e['sourceDigest'] = digest;
  e['path'] = path;
  e['message'] = `authoritative blob ${digest} does not exist at ${path}`;
  e['hint'] =
    'restore the authoritative bytes from a backup, or re-import the version as a new version (M2 never fabricates bytes)';
  return e as unknown as CommandError;
}

/** `blob_corrupt`: the bytes do not match the
 * content-addressed name. The bytes are retained byte-for-byte. */
export function blobCorrupt(
  digest: string,
  path: string,
  found?: string,
  assetId?: string,
  version?: number,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'blob_corrupt',
    cls: 'validation',
  };
  if (assetId !== undefined) e['assetId'] = assetId;
  if (version !== undefined) e['assetVersion'] = version;
  e['sourceDigest'] = digest;
  e['path'] = path;
  if (found !== undefined) e['found'] = found;
  e['message'] = `blob content at ${path} does not match its digest ${digest}`;
  e['hint'] =
    'the bytes are retained byte-for-byte and never auto-repaired; restore the correct bytes from a backup or re-import the version';
  return e as unknown as CommandError;
}

/**
 * `asset_source_missing`: a version referenced in place names a file that is
 * not in the game folder any more. `path` is relative to the game folder.
 */
export function assetSourceMissing(digest: string, path: string, assetId?: string, version?: number): CommandError {
  const e: Record<string, unknown> = { code: 'asset_source_missing', cls: 'not_found' };
  if (assetId !== undefined) e['assetId'] = assetId;
  if (version !== undefined) e['assetVersion'] = version;
  e['sourceDigest'] = digest;
  e['path'] = path;
  e['message'] = `${assetId !== undefined ? `asset ${assetId}${version !== undefined ? ` v${version}` : ''}: ` : ''}the file ${path} is missing from the game folder`;
  e['hint'] = 'put the file back (for example from git); a file moved together with its .tlasset sidecar is found again by "check files"';
  return e as unknown as CommandError;
}

/**
 * `blob_missing` for what an importer made from a file (a GLB converted from
 * an FBX, a KTX2 encoded from a PNG): the import cache does not hold it.
 * The cache is rebuilt from the file by "check files" (and before Play and
 * export); nothing is served in its place.
 */
export function importedMissing(digest: string, path: string, assetId: string, version: number): CommandError {
  return {
    code: 'blob_missing',
    cls: 'not_found',
    assetId,
    assetVersion: version,
    sourceDigest: digest,
    path,
    message: `asset ${assetId} v${version}: the imported data made from ${path} is not in the import cache`,
    hint: 'run "check files" (or start Play or an export): the import cache is rebuilt from the file',
  } as unknown as CommandError;
}

/**
 * `asset_source_changed`: a version referenced in place names a file whose
 * bytes are no longer the ones recorded. The file is never served instead.
 */
export function assetSourceChanged(
  digest: string,
  path: string,
  found: string,
  assetId?: string,
  version?: number,
): CommandError {
  const e: Record<string, unknown> = { code: 'asset_source_changed', cls: 'conflict' };
  if (assetId !== undefined) e['assetId'] = assetId;
  if (version !== undefined) e['assetVersion'] = version;
  e['sourceDigest'] = digest;
  e['path'] = path;
  e['found'] = found;
  e['message'] = `${assetId !== undefined ? `asset ${assetId}${version !== undefined ? ` v${version}` : ''}: ` : ''}${path} has changed since it was imported (sha256 ${digest.slice(0, 12)}… recorded, ${found.slice(0, 12)}… on disk)`;
  e['hint'] = 'run "check files": a changed file is imported again (the file is the asset)';
  return e as unknown as CommandError;
}

/** A byte count for a person: `1.5 GiB`, `320 MiB`, `12 KiB`. */
function byteSize(n: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${n} bytes` : `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** `content_quota_exceeded`: the disk the file goes to is short; nothing is
 * written. A project has no byte quota of its own: only the disk bounds it. */
export function contentQuotaExceeded(
  kind: 'device_space',
  free: number,
  reserve: number,
  needed: number,
): CommandError {
  return {
    code: 'content_quota_exceeded',
    cls: 'validation',
    kind,
    current: free,
    max: reserve,
    needed,
    message: `the disk has ${byteSize(free)} free; writing ${byteSize(needed)} would leave less than the ${byteSize(reserve)} kept free`,
    hint: 'free space on the disk the game folder is on, then import again',
  } as CommandError;
}

/** `content_publish_failed`: a non-envelope
 * publication phase failed; the envelope is unchanged. */
export function contentPublishFailed(
  reason: 'write' | 'timeout' | 'busy',
  onDiskState?: 'previous' | 'new-undurable',
  errno?: string,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'content_publish_failed',
    cls: 'unavailable',
    reason,
  };
  if (onDiskState !== undefined) e['onDiskState'] = onDiskState;
  if (errno !== undefined) e['errno'] = errno;
  e['message'] = `a content publication phase failed (${reason})`;
  e['hint'] =
    'retry the same request; blob publication is idempotent (an existing content-addressed blob is verified, never overwritten)';
  return e as unknown as CommandError;
}

/** `derived_cache_unavailable`: a derived cache is
 * missing/corrupt and could not be regenerated. Never fatal to the project. */
export function derivedCacheUnavailable(sourceDigest: string, path: string): CommandError {
  return {
    code: 'derived_cache_unavailable',
    cls: 'unavailable',
    sourceDigest,
    path,
    message: `the derived cache at ${path} is missing or corrupt and could not be regenerated`,
    hint: 'derived caches are regenerable from the authoritative blob with no network access; the project state is unaffected',
  };
}

/**
 * `behavior_publication_unavailable`: the
 * behavior-source publication path is not available for this request —
 * `preparer_unavailable` (no compiler registered) or `preparation_missing`
 * (no prepared artifact for the supplied digest).
 */
export function behaviorPublicationUnavailable(
  behaviorId: string,
  mode: string,
  reason: 'preparer_unavailable' | 'preparation_missing',
): CommandError {
  return {
    code: 'behavior_publication_unavailable',
    cls: 'unavailable',
    behaviorId,
    mode,
    reason,
    message:
      reason === 'preparer_unavailable'
        ? 'no behavior-source preparer (compiler) is registered for this workspace'
        : 'no prepared artifact exists for the supplied sourceDigest',
    hint: 'stage the canonical source container, prepare it, then publish the prepared digest',
  };
}

/** `behavior_trust_unacknowledged`. */
export function behaviorTrustUnacknowledged(sourceDigest: string): CommandError {
  return {
    code: 'behavior_trust_unacknowledged',
    cls: 'validation',
    sourceDigest,
    message: 'the exact sourceDigest has no content.behaviorTrust acknowledgment',
    hint: 'acknowledge the digest (acknowledgeBehaviorTrust) before preparing or publishing its source',
  };
}

/** `import_rejected`: the import profile rejected the staged bytes; carries the ordered `asset_*`
 * diagnostics (≤ 10) plus the true count. */
export function importRejected(
  sourceDigest: string,
  diagnostics: readonly unknown[],
  diagnosticCount: number,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'import_rejected',
    cls: 'validation',
    sourceDigest,
    diagnostics: diagnostics.slice(0, 10),
    diagnosticCount,
    message: `the import profile rejected the staged bytes (${diagnosticCount} diagnostic(s))`,
    hint: 'fix the source or re-export it with the supported glTF 2.0 GLB profile',
  };
  return e as unknown as CommandError;
}

/** `content_invalid`: the envelope's
 * `content` block fails validation; carries ≤ 10 model errors + the true count. */
export function contentInvalid(
  details: readonly LoadDetail[],
  count: number,
): CommandError {
  const e: Record<string, unknown> = {
    code: 'content_invalid',
    cls: 'unavailable',
  };
  if (details.length > 0) {
    e['details'] = details.slice(0, 10);
    e['detailCount'] = count;
  }
  e['message'] = 'the envelope content block fails validation';
  e['hint'] =
    'the bytes are retained untouched; repair the content block by hand or restore it from a backup, then re-open';
  return e as unknown as CommandError;
}
