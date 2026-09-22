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

import type { LimitName, ModelError, ModelErrorV2, ModelErrorV3 } from '@thirdlight/project-model';

import type { CommandError, ErrorClass } from './types';

export type { CommandError };

/**
 * The stable command-layer error codes (commands.md §5.4, normative). The M1
 * rows are unchanged; packet 16/21 additions (prefab, behavior, property,
 * settings, reference and content-package rows) are appended in the contract's
 * table order so the set stays a single source of truth for consumers.
 */
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
  // packet 16/21 additions (commands.md §5.4 M2 rows):
  'prefab_not_found',
  'prefab_id_duplicate',
  'prefab_camera_capture_forbidden',
  'prefab_nested_forbidden',
  'prefab_external_reference_forbidden',
  'prefab_local_unknown',
  'prefab_reference_missing',
  'prefab_component_forbidden',
  'behavior_not_found',
  'behavior_id_duplicate',
  'behavior_reference_missing',
  'behavior_publication_unavailable',
  'property_unknown',
  'property_type',
  'property_value',
  'property_declaration_incompatible',
  'setting_unknown',
  'reference_in_use',
  'asset_not_found',
  'asset_id_duplicate',
  'asset_reference_missing',
  'behavior_trust_unacknowledged',
  'behavior_declaration_mismatch',
  'digest_invalid',
  'component_missing',
  'id_invalid',
  'external_change_unresolved',
  'history_empty',
  'history_invalid',
  'write_failed',
  // v3 game/presentation rows (commands.md §5.4, packet 45):
  'game_reference_missing',
  'game_reference_in_use',
  'zone_transform_unsupported',
  'spawn_transform_unsupported',
  'zone_checkpoint_count_invalid',
  'zone_goal_missing',
  'asset_kind_mismatch',
  'game_config_invalid',
  'animation_role_out_of_range',
  'animation_role_duplicate',
  'animation_role_mismatch',
  'animation_role_ambiguous',
  'animation_skin_unsupported',
  'animation_root_motion',
] as const;

export type CommandErrorCode = (typeof ERROR_CODES)[number];

/** 2^53 − 1 — the maximum M1 revision (commands.md §3, project-model §6). */
export const MAX_REVISION = Number.MAX_SAFE_INTEGER;

/** §3.1: the canonical request byte cap (65 536). */
export const MAX_REQUEST_BYTES = 65_536;

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

/**
 * Attach a bounded `found` value to an error object (the same convention the
 * `field_*` constructors use). Exported for constructors that live in other
 * modules (property/reference checks) so the bounded traversal has one owner.
 */
export function withBoundedFound(e: CommandError, found: unknown): CommandError {
  return withFound(e, found);
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
  limit: LimitName,
  current: number,
  max: number,
  message?: string,
): CommandError {
  return {
    code: 'limits_exceeded',
    cls: 'validation',
    limit,
    current,
    max,
    message:
      message ??
      (limit === 'entities' || limit === 'depth'
        ? `creation would exceed the M1 ${limit} limit (${current} > ${max})`
        : `the ${limit} limit is exceeded (${current} > ${max})`),
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

/**
 * §6.5 extension (packet 16): an M2 content/property mutation whose resulting
 * scene **and** content canonical bytes are identical to the current state.
 * (The M1 constructor above keeps its fixture-pinned wording for M1 states.)
 */
export function noChangeContent(): CommandError {
  return {
    code: 'no_change',
    cls: 'validation',
    message: 'the resulting scene and content are byte-identical to the current state',
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
 * §5.2: validation failure of the RESULTING scene/content. Top-level `code` is
 * the first detail's code (document order); `details` is capped at 32.
 */
export function resultSceneError(
  errors: readonly ModelErrorV3[],
): CommandError {
  const first = errors[0];
  const e: CommandError = {
    code: first !== undefined ? first.code : 'field_value',
    cls: 'validation',
    detailDocument: 'result-scene',
    details: errors.slice(0, 32) as unknown as readonly ModelError[],
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
// ---- content/property error constructors (commands.md §5.4, packet 16 shapes) ----

/** §5.4/§8.9: an undeclared property key (never silently dropped). */
export function propertyUnknown(behaviorId: string | undefined, key: string): CommandError {
  // Key order (fixture-pinned): code, cls, behaviorId?, key, message.
  const e: CommandError = {
    code: 'property_unknown',
    cls: 'validation',
    ...(behaviorId !== undefined ? { behaviorId } : {}),
    key,
    message: 'the behavior declaration does not declare this property key',
  };
  return e;
}

/** §5.4/§20.5: a value does not match its declared property type. */
export function propertyType(key: string, found: unknown, expected: string): CommandError {
  return withFound(
    {
      code: 'property_type',
      cls: 'validation',
      key,
      expected,
      message: `the declared property type is ${expected}`,
    },
    found,
  );
}

/** §5.4/§20.5: a value violates its declared range/length/enum/bounds. */
export function propertyValue(
  key: string,
  found: unknown,
  expected: string,
  message: string,
): CommandError {
  return withFound(
    {
      code: 'property_value',
      cls: 'validation',
      key,
      expected,
      message,
    },
    found,
  );
}

/** §5.4/§8.7.3: an override names a key the resolved declaration lacks. */
export function propertyOverrideUnknown(
  behaviorId: string | undefined,
  key: string,
): CommandError {
  return {
    code: 'property_unknown',
    cls: 'validation',
    ...(behaviorId !== undefined ? { behaviorId } : {}),
    key,
    message: 'the behavior declaration for this component does not declare this property key',
    hint: 'declare the key or drop the override; unknown overrides are never silently dropped',
  };
}

/** §5.4/§20.5: a value does not match its declared property type; the carried
 * `expected` may be a richer constraint description while `message` names the
 * declared type (the packet-16 override fixtures pin this split). */
export function propertyTypeDetail(
  key: string,
  found: unknown,
  typeName: string,
  expected: string,
): CommandError {
  return withFound(
    {
      code: 'property_type',
      cls: 'validation',
      key,
      expected,
      message: `the declared property type is ${typeName}`,
    },
    found,
  );
}

// ---- prefab error constructors (commands.md §5.4/§8.6–§8.7, packet 22) --------

/** §5.4/§8.7: an operation names a `prefabId` the catalog lacks. */
export function prefabNotFound(prefabId: string): CommandError {
  return {
    code: 'prefab_not_found',
    cls: 'validation',
    prefabId,
    message: 'no prefab definition with this id exists in content.prefabs',
  };
}

/** §5.4/§8.6: `createPrefab` names an existing definition. */
export function prefabIdDuplicate(prefabId: string): CommandError {
  return {
    code: 'prefab_id_duplicate',
    cls: 'validation',
    prefabId,
    message: 'a prefab definition with this id already exists',
  };
}

/** §5.4/§8.6.3: the captured subtree contains a camera component. */
export function prefabCameraCaptureForbidden(
  sourceEntityId: string,
  cameraId: string,
): CommandError {
  return {
    code: 'prefab_camera_capture_forbidden',
    cls: 'validation',
    sourceEntityId,
    cameraId,
    message:
      'the selected subtree contains the scene camera; a prefab definition may not contain a camera component',
  };
}

/** §5.4/§8.6.3: the captured subtree contains a prefab instance. */
export function prefabNestedForbidden(
  sourceEntityId: string,
  prefabInstanceIds: readonly string[],
): CommandError {
  return {
    code: 'prefab_nested_forbidden',
    cls: 'validation',
    sourceEntityId,
    prefabInstanceIds,
    message:
      'the selected subtree contains a prefab instance (components.prefab); M2 definitions cannot contain prefab instances',
  };
}

/** §5.4/§8.6.3: a definition `entityRef` value names an entity outside the subtree. */
export function prefabExternalReferenceForbidden(
  sourceEntityId: string,
  localId: string,
  key: string,
  entityId: string,
): CommandError {
  return {
    code: 'prefab_external_reference_forbidden',
    cls: 'validation',
    sourceEntityId,
    localId,
    key,
    entityId,
    message: 'a definition may only contain references that are internal to its own subtree',
  };
}

/** §5.4/§8.7: an override names a `localId` the definition does not contain. */
export function prefabLocalUnknown(prefabId: string, localId: string): CommandError {
  return {
    code: 'prefab_local_unknown',
    cls: 'validation',
    prefabId,
    localId,
    message: 'the definition contains no entity with this localId',
  };
}

/** §5.4/§20.2: a definition entity carries `camera` or `prefab`. */
export function prefabComponentForbidden(
  prefabId: string,
  localId: string,
  component: string,
): CommandError {
  return {
    code: 'prefab_component_forbidden',
    cls: 'validation',
    prefabId,
    localId,
    component,
    message: `a prefab definition entity must not carry '${component}'`,
  };
}

/** §5.4/§20.4: a `components.prefab` value does not resolve. */
export function prefabReferenceMissing(prefabId: string, localId: string): CommandError {
  return {
    code: 'prefab_reference_missing',
    cls: 'validation',
    prefabId,
    localId,
    message: 'prefab provenance does not resolve to a definition/localId',
  };
}

/** §5.4/§8.9: an `assetRef` value names no catalog record. */
export function assetReferenceMissing(assetId: string): CommandError {
  return {
    code: 'asset_reference_missing',
    cls: 'validation',
    assetId,
    message: 'asset reference does not resolve in content.assets',
  };
}

/** §5.4/§8.8: `publishAsset` reimport names an unknown asset. */
export function assetNotFound(assetId: string): CommandError {
  return {
    code: 'asset_not_found',
    cls: 'validation',
    assetId,
    message: 'no asset record with this id exists in content.assets',
  };
}

/** §5.4/§8.5: `publishAsset` create names an existing asset. */
export function assetIdDuplicate(assetId: string): CommandError {
  return {
    code: 'asset_id_duplicate',
    cls: 'validation',
    assetId,
    message: 'an asset record with this id already exists',
  };
}

/** §5.4/§8.8–§8.9: an operation names a behavior the content block lacks. */
export function behaviorNotFound(behaviorId: string, message?: string): CommandError {
  return {
    code: 'behavior_not_found',
    cls: 'validation',
    behaviorId,
    message: message ?? 'no behavior record with this id exists in content.behaviors',
  };
}

/** §5.4/§8.8: `declaration-create` names an existing behavior. */
export function behaviorIdDuplicate(behaviorId: string): CommandError {
  return {
    code: 'behavior_id_duplicate',
    cls: 'validation',
    behaviorId,
    message: 'a behavior record with this id already exists',
  };
}

/** §5.4/§8.8.2/§22.6: behavior source publication is unavailable in M2. */
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
        ? 'public behavior source publication requires the packet-33 digest-bound compiled preparation record; no unchecked write path exists in M2'
        : 'no prepared artifact exists for the supplied sourceDigest',
  };
}

/** §5.4/§8.8.3: a declaration update would invalidate stored values. */
export function propertyDeclarationIncompatible(
  behaviorId: string,
  reason: string,
  uses: readonly { entityId: string; key: string }[],
): CommandError {
  return {
    code: 'property_declaration_incompatible',
    cls: 'validation',
    behaviorId,
    reason,
    uses,
    message:
      'the new declaration is incompatible with existing behavior components; nothing was written',
  };
}

/** §5.4/§8.11: a settings key the fixed registry does not declare. */
export function settingUnknown(key: string): CommandError {
  return {
    code: 'setting_unknown',
    cls: 'validation',
    key,
    message: 'the settings key registry (packet 17) does not declare this key',
    hint: 'packet 17 pins the M2 settings keys; until then every key is unknown',
  };
}

/** §5.4/§8.10: the target entity does not carry the addressed component. */
export function componentMissing(entityId: string, component: string): CommandError {
  return {
    code: 'component_missing',
    cls: 'validation',
    entityId,
    component,
    message: `entity '${entityId}' does not carry a '${component}' component`,
  };
}

/** §5.4/§8.3 step 2b: subtree deletion would dangle an entity reference. */
export function referenceInUse(
  entityIds: readonly string[],
  referencingEntityIds: readonly string[],
): CommandError {
  return {
    code: 'reference_in_use',
    cls: 'validation',
    entityIds,
    referencingEntityIds,
    message: 'an entity outside the deleted subtree references an entity inside it',
    hint: 'clear the referencing property values first, or delete the referencing entity too',
  };
}

/** §5.4/§12.6: an ID does not use the project-model ID syntax. */
export function idInvalid(path: string, found: unknown, expected: string): CommandError {
  return withFound(
    {
      code: 'id_invalid',
      cls: 'validation',
      path,
      expected,
      message: 'identifier does not use the project-model ID syntax',
    },
    found,
  );
}

/** §5.4/§18.9.3: a digest is not 64 lowercase hex. */
export function digestInvalid(path: string, found: unknown): CommandError {
  return withFound(
    {
      code: 'digest_invalid',
      cls: 'validation',
      path,
      expected: '64 lowercase hex characters',
      message: 'digest must be 64 lowercase hex characters',
    },
    found,
  );
}

/** §5.4/§22.5: a digest has no `content.behaviorTrust` acknowledgment. */
export function behaviorTrustUnacknowledged(sourceDigest: string): CommandError {
  return {
    code: 'behavior_trust_unacknowledged',
    cls: 'validation',
    sourceDigest,
    message: 'the exact sourceDigest has no content.behaviorTrust acknowledgment',
    hint: 'acknowledge the digest (acknowledgeBehaviorTrust) before publishing its source',
  };
}

/**
 * §5.4/§22.4.1: the prepared artifact for the supplied digest is inconsistent
 * with the declaration the command would write (`reason` `digest` /
 * `manifest` / `declaration` / `pins`). Nothing is written.
 */
export function behaviorDeclarationMismatch(behaviorId: string, reason: string): CommandError {
  return {
    code: 'behavior_declaration_mismatch',
    cls: 'validation',
    behaviorId,
    reason,
    message: 'the prepared behavior source does not match the declaration being published; nothing was written',
  };
}

// ---- v3 game/presentation constructors (commands.md §5.4, packet 45) -----------

/**
 * §5.4/§23.9: a `content.game` reference or required role does not resolve.
 * `reason` is `player`/`camera`/`camera_follow`/`spawn`/`safe_spawn`/`cue`.
 */
export function gameReferenceMissing(
  path: string,
  reason: string,
  message: string,
  expected: string,
): CommandError {
  const e: CommandError = {
    code: 'game_reference_missing',
    cls: 'validation',
    path,
    reason,
    message,
    expected,
  };
  return e;
}

/**
 * §5.4/§23.6: a deletion or component removal would dangle a game/checkpoint
 * reference. `entityIds` is the removal closure; `references` are the
 * envelope-document JSON Pointers that would dangle, ascending.
 */
export function gameReferenceInUse(
  entityIds: readonly string[],
  references: readonly string[],
): CommandError {
  return {
    code: 'game_reference_in_use',
    cls: 'validation',
    entityIds: [...entityIds],
    references: [...references],
    message: 'a deletion or component removal would dangle a game-configuration reference',
    hint: 'clear the referencing game/checkpoint value first, or remove the whole game configuration',
  };
}

/** §5.4/§23.3.1: `content.game` is non-null and the scene has no goal zone. */
export function zoneGoalMissing(): CommandError {
  return {
    code: 'zone_goal_missing',
    cls: 'validation',
    message: 'content.game is non-null but the scene has no goal zone',
    expected: 'at least one gameZone with role "goal"',
  };
}

/** §5.4/§23.9: more than one checkpoint zone exists (single error). */
export function zoneCheckpointCountInvalid(zoneIds: readonly string[]): CommandError {
  return {
    code: 'zone_checkpoint_count_invalid',
    cls: 'validation',
    zoneIds: [...zoneIds],
    message: 'more than one checkpoint zone exists; at most one is allowed',
    expected: '0 or 1 gameZone with role "checkpoint"',
  };
}

/** §5.4/§23.9: a reference/reimport kind disagrees with the record. */
export function assetKindMismatch(
  assetId: string,
  expected: string,
  found: unknown,
): CommandError {
  return withFound(
    {
      code: 'asset_kind_mismatch',
      cls: 'validation',
      assetId,
      expected,
      message: 'the asset record kind disagrees with the requested/referenced kind',
    },
    found,
  );
}

/** §5.4/§23.9: a `modelAnimation` binding's clip index exceeds the version. */
export function animationRoleOutOfRange(
  path: string,
  role: string,
  clipIndex: number,
  clips: number,
): CommandError {
  return {
    code: 'animation_role_out_of_range',
    cls: 'validation',
    path,
    role,
    clipIndex,
    clips,
    message: `clipIndex ${clipIndex} is not less than the version's clip count (${clips})`,
    expected: `integer in [0, ${Math.max(0, clips - 1)}]`,
  };
}

/** §5.4/§41.3.2 stage 4: two roles of one binding share a `clipIndex`. */
export function animationRoleDuplicate(
  path: string,
  clipIndex: number,
  roles: readonly string[],
): CommandError {
  return {
    code: 'animation_role_duplicate',
    cls: 'validation',
    path,
    clipIndex,
    roles: [...roles],
    message: 'two animation roles share one clipIndex; each role needs its own clip',
    expected: 'distinct clipIndex values for idle, run and airborne',
  };
}
