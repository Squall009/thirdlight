/**
 * Error construction — commands.md §5.2/§5.4.
 *
 * `ERROR_CODES` is the stable M1 command-layer code set (the §5.4 table,
 * normative for M1). Result-scene validation failures carry the
 * project-model's codes (project-model.md §12.6) at the top level and in
 * `details`; those come from `@thirdlight/project-model`'s `ERROR_CODES`.
 *
 * Key order in emitted error objects (the scenario fixtures pin it):
 * `code`, `cls`, code-specific fields (§5.4 table order),
 * `detailDocument`/`details`/`detailCount`/`detailsTruncated`
 * (result-scene failures), `message`, `hint`.
 */

import type { ModelError } from '@thirdlight/project-model';

import type { CommandError, ErrorClass } from './types';

export type { CommandError };

/** The stable M1 command-layer error codes (commands.md §5.4, normative). */
export const ERROR_CODES = [
  'invalid_request',
  'field_missing',
  'field_unexpected',
  'field_type',
  'field_value',
  'project_not_found',
  'project_unavailable',
  'workspace_closed',
  'revision_conflict',
  'request_id_reused',
  'revision_exhausted',
  'entity_not_found',
  'reference_missing',
  'camera_count_invalid',
  'limits_exceeded',
  'id_exhaustion',
  'no_change',
  'external_change_unresolved',
  'history_empty',
  'history_invalid',
  'write_failed',
] as const;

export type CommandErrorCode = (typeof ERROR_CODES)[number];

/** 2^53 − 1 — the maximum M1 revision (commands.md §3, project-model §6). */
export const MAX_REVISION = Number.MAX_SAFE_INTEGER;

/** project-model §5.1 ID syntax (reused for `projectId`, commands.md §3). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** commands.md §3: `req-` + 32 hex chars (128 random bits, client CSPRNG). */
const REQUEST_ID_RE = /^req-[0-9a-f]{32}$/;

export { ID_RE, REQUEST_ID_RE };

// ---- bounded `found` (same convention as project-model §12.5) ------------------

function jsonSafe(v: unknown, depth: number): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean' || t === 'number') return true;
  if (t === 'undefined' || t === 'function' || t === 'symbol') return false;
  if (depth > 4) return false;
  if (Array.isArray(v)) {
    return v.length <= 64 && v.every((x) => jsonSafe(x, depth + 1));
  }
  const keys = Object.keys(v as object);
  return (
    keys.length <= 64 &&
    keys.every((k) => jsonSafe((v as Record<string, unknown>)[k], depth + 1))
  );
}

/**
 * O1 (2026-09-18 repair, packet 07): the traversal bound of the `found`
 * mapper. A value used as `found` may be ANY in-process value (the public
 * entry points are total — commands.md §3: validation is total, never
 * throws), so the recursion over nested values must be bounded by
 * construction. A JSON-parsed 12,000-level nested array used as `found`
 * must yield a structured error, not a RangeError:
 *
 *   - depth <= 64 (root = depth 0; children of a depth-64 value are not
 *     processed — they degrade to the marker);
 *   - <= 4096 visited nodes per mapping (each processed value consumes one
 *     node of the budget).
 *
 * Overflow-impossibility (any value shape, not just arrays): boundedFound
 * recurses at most 66 levels deep (depths 0..65), and each array level adds
 * at most one extra frame (the `map` callback), so the call chain is
 * <= ~137 frames plus the object branch's jsonSafe depth (<= 5, its own
 * depth cap of 4). Node's default stack holds orders of magnitude more
 * frames; with the depth cap, overflow is impossible by construction.
 */
const BOUNDED_FOUND_MAX_DEPTH = 64;
const BOUNDED_FOUND_MAX_NODES = 4096;

/** The `found` marker emitted where the traversal bound is hit. */
const BOUNDED_FOUND_MARKER =
  '[truncated: exceeds bounded diagnostic traversal (depth <= 64, nodes <= 4096)]';

interface FoundBudget {
  nodes: number;
  hit: boolean;
}

/**
 * Bound a `found` value ("present when it exists and is bounded"): long
 * strings truncated, long arrays summarized, non-JSON-safe objects omitted,
 * and the whole traversal bounded (O1). Where the bound is hit ANYWHERE in
 * the value the whole `found` degrades to the marker — a complete,
 * JSON-safe string (the same "degrade to a summary" convention as the
 * long-string / long-array cases above); the error's `path` (built by the
 * caller from complete request segments) is unaffected and stays a
 * complete, valid JSON Pointer. Same convention as the project-model's
 * `boundedFound` (validate.ts).
 */
function boundedFound(v: unknown): unknown {
  const budget: FoundBudget = { nodes: 0, hit: false };
  const out = mapFound(v, 0, budget);
  return budget.hit ? BOUNDED_FOUND_MARKER : out;
}

function mapFound(v: unknown, depth: number, budget: FoundBudget): unknown {
  if (depth > BOUNDED_FOUND_MAX_DEPTH || budget.nodes >= BOUNDED_FOUND_MAX_NODES) {
    budget.hit = true;
    return BOUNDED_FOUND_MARKER;
  }
  budget.nodes += 1;
  if (typeof v === 'string') {
    return v.length <= 256
      ? v
      : `${v.slice(0, 256)}… (truncated, ${v.length} chars total)`;
  }
  if (Array.isArray(v)) {
    return v.length <= 16
      ? v.map((x) => mapFound(x, depth + 1, budget))
      : `[${v.length} elements]`;
  }
  if (v !== null && typeof v === 'object') {
    return jsonSafe(v, 0) ? v : undefined;
  }
  return v;
}

function withFound(e: CommandError, found: unknown): CommandError {
  const b = boundedFound(found);
  if (b === undefined) return e;
  return { ...e, found: b };
}

// ---- constructors (canonical key order) ----------------------------------------

/** Envelope-level schema failure (§5.4: `invalid_request`). */
export function invalidRequest(
  path: string,
  found: unknown,
  expected: string,
  message: string,
  hint?: string,
): CommandError {
  // Canonical key order (fixture-pinned): code, cls, path, found?,
  // expected, message, hint?.
  const parts: Record<string, unknown> = {
    code: 'invalid_request',
    cls: 'validation',
    path,
  };
  const b = boundedFound(found);
  if (b !== undefined) parts['found'] = b;
  parts['expected'] = expected;
  parts['message'] = message;
  if (hint !== undefined) parts['hint'] = hint;
  return parts as unknown as CommandError;
}

/** `args` schema failure — missing required field. */
export function fieldMissing(path: string, field: string): CommandError {
  return {
    code: 'field_missing',
    cls: 'validation',
    path,
    message: `required field '${field}' is missing`,
    expected: 'present',
  };
}

/** `args` schema failure — unknown field (strict; nothing is dropped). */
export function fieldUnexpected(
  path: string,
  key: string,
  known: string,
  message?: string,
): CommandError {
  return withFound(
    {
      code: 'field_unexpected',
      cls: 'validation',
      path,
      message:
        message ??
        'unknown field is not permitted (strict M1 schema drops nothing)',
      expected: `known fields: ${known}`,
    },
    key,
  );
}

/** `args` schema failure — wrong JSON type. */
export function fieldType(
  path: string,
  found: unknown,
  expected: string,
): CommandError {
  return withFound(
    {
      code: 'field_type',
      cls: 'validation',
      path,
      message: `value must be of type ${expected}`,
      expected,
    },
    found,
  );
}

/** `args` schema failure — right type, wrong value. */
export function fieldValue(
  path: string,
  found: unknown,
  expected: string,
  message: string,
  hint?: string,
): CommandError {
  const e = withFound(
    {
      code: 'field_value',
      cls: 'validation',
      path,
      message,
      expected,
    },
    found,
  );
  if (hint !== undefined) e.hint = hint;
  return e;
}

/** §5.2/§8.3: the entity does not exist in the current scene. */
export function entityNotFound(entityId: string): CommandError {
  return {
    code: 'entity_not_found',
    cls: 'validation',
    entityId,
    message: `entity '${entityId}' does not exist in the current scene`,
    hint: 'query the scene (queryEntities) for current IDs, then re-issue with a fresh requestId',
  };
}

/** §5.4/§8.1: createEntity.parentId does not resolve. */
export function referenceMissing(found: unknown): CommandError {
  return withFound(
    {
      code: 'reference_missing',
      cls: 'validation',
      message: 'parentId does not resolve to an existing entity',
      expected: 'existing entity ID or null',
    },
    found,
  );
}

/** §5.4/§8.3: the deletion subtree contains the scene's only camera. */
export function cameraCountInvalid(cameraId: string): CommandError {
  return {
    code: 'camera_count_invalid',
    cls: 'validation',
    cameraId,
    message: 'deleting this entity would remove the scene\u2019s only camera',
    hint: 'an M1 scene must always contain exactly one camera (project-model \u00a710.3)',
  };
}

/** §5.4/§8.1: creation would exceed an M1 limit. */
export function limitsExceeded(
  limit: 'entities' | 'depth',
  current: number,
  max: number,
): CommandError {
  return {
    code: 'limits_exceeded',
    cls: 'validation',
    limit,
    current,
    max,
    message: `creation would exceed the M1 ${limit} limit (${current} > ${max})`,
  };
}

/** §5.4/§8.1: no free `<kind>-NNNN` ID. */
export function idExhaustion(kind: string): CommandError {
  return {
    code: 'id_exhaustion',
    cls: 'internal',
    kind,
    message: `no free ${kind}-NNNN ID is available`,
  };
}

/** §5.4/§4: expectedRevision ≠ currentRevision. */
export function revisionConflict(
  expectedRevision: number,
  currentRevision: number,
): CommandError {
  return {
    code: 'revision_conflict',
    cls: 'conflict',
    expectedRevision,
    currentRevision,
    message: 'expected revision does not match the current project revision',
    hint: 're-read the project (queryProject) and re-issue the command with a fresh requestId and the current revision',
  };
}

/** §5.4: current revision is 2^53−1; no mutation can be applied. */
export function revisionExhausted(currentRevision: number): CommandError {
  return {
    code: 'revision_exhausted',
    cls: 'internal',
    currentRevision,
    message: 'the project revision has reached 2^53-1; no mutation can be applied',
  };
}

/** §5.4/§6.5: the mutation would leave the scene byte-identical. */
export function noChange(): CommandError {
  return {
    code: 'no_change',
    cls: 'validation',
    message: 'request would not change the scene',
    hint: 'the scene already matches the requested values; nothing was recorded',
  };
}

/** §5.4/§8.4: undo/redo with an empty stack. */
export function historyEmpty(which: 'undo' | 'redo'): CommandError {
  return {
    code: 'history_empty',
    cls: 'unavailable',
    which,
    message:
      which === 'undo'
        ? 'the undo stack is empty'
        : 'the redo stack is empty',
    hint: 'history is in-memory per open session; it is empty after a restart or reset boundary and once fully undone (commands.md \u00a79.2)',
  };
}

/** §5.4/§9.4: a stored inverse/forward failed re-validation (defensive). */
export function historyInvalid(requestId: string): CommandError {
  return {
    code: 'history_invalid',
    cls: 'internal',
    requestId,
    message:
      'a stored history inverse/forward failed re-validation; state and history are unchanged',
    hint: 'do not retry blindly; continue with fresh edits or restart the backend (commands.md \u00a79.4)',
  };
}

/**
 * §5.2: validation failure of the RESULTING scene. Top-level `code` is the
 * first detail's code (document order); `details` is capped at 32.
 */
export function resultSceneError(errors: readonly ModelError[]): CommandError {
  const first = errors[0];
  const e: CommandError = {
    code: first !== undefined ? first.code : 'field_value',
    cls: 'validation',
    detailDocument: 'result-scene',
    details: errors.slice(0, 32),
    detailCount: errors.length,
    message: 'resulting scene failed validation; state unchanged',
    hint: 'fix the request arguments and re-issue with a new requestId',
  };
  if (errors.length > 32) e.detailsTruncated = true;
  return e;
}

// ---- small shared predicates -----------------------------------------------------

/** §4/§9.1 name rule (project-model): 1–128 chars, no control characters. */
export function isValidName(s: string): boolean {
  if (s.length < 1 || s.length > 128) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/** Plain-object check (no null, no arrays, no class instances). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The JSON type descriptor used for `found` on non-object roots. */
export function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}