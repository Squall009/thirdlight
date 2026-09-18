/**
 * The atomic authoring-state envelope — workspace.md §4.
 *
 * - §4.2/§4.4: canonical envelope construction (fixed key order: envelope
 *   `storageVersion, type, projectId, scene, retry`; scene/entities per
 *   project-model §12.2; `retry`: `retention, records`; record:
 *   `requestId, digest, appliedRevision, result`; result objects in
 *   commands.md §5.1 key order; UTF-8, LF, 2-space indent, one trailing
 *   newline, no BOM).
 * - §4.3: the load validation pipeline (normative order, first failure
 *   wins): strict parse → root object → `storageVersion` → `type` →
 *   `projectId` → `validateScene` → retry block → (manifest handled by the
 *   caller: §4.3 step 8 reads a separate file).
 *
 * The envelope is the ONLY mutable authoring file; the workspace decodes it
 * and passes only the embedded scene to the scene validator (workspace.md
 * §4.2, project-model §3).
 */

import type { Scene } from '@thirdlight/project-model';
import type { LoadDetail, UnavailableReason } from './errors';
import { parseDocumentBytes, validateScene } from '@thirdlight/project-model';
import type { MutationSuccess } from '@thirdlight/commands';

import { isPlainObject, isSafeInt } from './errors';

/** The envelope's storageVersion known to M1 (workspace.md §4.2). */
export const ENVELOPE_STORAGE_VERSION = 1;
/** The constant recorded in every retry block (workspace.md §4.2). */
export const RETRY_RETENTION = 128;
/** The envelope discriminator (workspace.md §4.2). */
export const ENVELOPE_TYPE = 'authoring-state';

/** project-model §5.1 ID syntax (project/scene/entity IDs). */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** commands.md §3: `req-` + 32 lowercase hex chars. */
const REQUEST_ID_RE = /^req-[0-9a-f]{32}$/;
/** commands.md §7.1: 64 lowercase hex chars. */
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** One durable retry record (commands.md §7.1; workspace.md §4.2). */
export interface RetryRecord {
  requestId: string;
  digest: string;
  appliedRevision: number;
  /** The full §5.1 success payload as originally acked, `duplicated: false`. */
  result: MutationSuccess;
}

/** §4.3 pipeline outcome for one envelope byte blob. */
export type EnvelopeLoad =
  | { ok: true; scene: Scene; records: RetryRecord[] }
  | {
      ok: false;
      reason: UnavailableReason;
      errors: readonly LoadDetail[];
      count: number;
    };

/**
 * Build the canonical envelope bytes (workspace.md §4.4).
 *
 * `scene` must be a canonical (model-normalized) scene value; `records` in
 * strictly ascending `appliedRevision` order (≤ 128). The `result` objects
 * must already be in the commands.md §5.1 key order (the pure layer builds
 * them that way; JSON.stringify preserves insertion order).
 */
export function buildEnvelopeBytes(
  projectId: string,
  scene: Scene,
  records: readonly RetryRecord[],
): Uint8Array {
  const doc = {
    storageVersion: ENVELOPE_STORAGE_VERSION,
    type: ENVELOPE_TYPE,
    projectId,
    scene,
    retry: {
      retention: RETRY_RETENTION,
      records,
    },
  };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}

/**
 * Run the §4.3 load validation pipeline over raw envelope bytes (steps 1–7;
 * step 8, the manifest + cross-document checks, needs the separate manifest
 * file and runs in the session loader).
 */
export function validateEnvelope(bytes: Uint8Array, dirName: string): EnvelopeLoad {
  // 1. Strict parse (project-model §12.3 pass 1).
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.error.code, errors: [parsed.error], count: 1 };
  }
  // 2. Root is an object.
  const root = parsed.value;
  if (!isPlainObject(root)) {
    return fail('envelope_invalid', [
      {
        code: 'field_type',
        path: '',
        message: 'envelope root must be a JSON object',
        expected: 'object',
      },
    ]);
  }
  // 3. storageVersion present and known (M1 knows [1]); unknown stops deeper checks.
  const sv = root['storageVersion'];
  if (!isSafeInt(sv) || sv !== ENVELOPE_STORAGE_VERSION) {
    return fail('storage_version_unsupported', [
      {
        code: 'storage_version_unsupported',
        path: '/storageVersion',
        message: 'envelope storageVersion is not known to M1',
        found: bounded(sv),
        expected: '1 (known versions: [1])',
        knownVersions: [ENVELOPE_STORAGE_VERSION],
      },
    ]);
  }
  // 4. type discriminator (no auto-detection or fallback to a bare scene).
  if (root['type'] !== ENVELOPE_TYPE) {
    return fail('envelope_invalid', [
      {
        code: 'field_value',
        path: '/type',
        message: 'envelope type must be "authoring-state"',
        found: bounded(root['type']),
        expected: '"authoring-state"',
      },
    ]);
  }
  // 5. projectId equals the directory name.
  const pid = root['projectId'];
  if (typeof pid !== 'string' || !ID_RE.test(pid) || pid !== dirName) {
    return fail('envelope_project_mismatch', [
      {
        code: 'envelope_project_mismatch',
        path: '/projectId',
        message: 'envelope projectId must equal the project directory name',
        found: bounded(pid),
        expected: dirName,
      },
    ]);
  }
  // Strictness (workspace.md §4.2): unknown fields at the envelope level.
  for (const k of Object.keys(root)) {
    if (!['storageVersion', 'type', 'projectId', 'scene', 'retry'].includes(k)) {
      return fail('envelope_invalid', [
        {
          code: 'field_unexpected',
          path: `/${k}`,
          message: 'unknown field is not permitted in the envelope (strict M1 schema drops nothing)',
          found: k,
          expected: 'known fields: storageVersion, type, projectId, scene, retry',
        },
      ]);
    }
  }
  // 6. Embedded scene → validateScene (the workspace never passes the
  //    envelope itself to the scene validator).
  const sceneRes = validateScene(root['scene']);
  if (!sceneRes.ok) {
    return {
      ok: false,
      reason: 'scene_invalid',
      errors: sceneRes.errors.slice(0, 10),
      count: sceneRes.errors.length,
    };
  }
  const scene = sceneRes.normalized;
  // 7. Retry block (validated against the envelope's projectId: record
  //    result payloads must belong to THIS project — R13).
  const retryRes = validateRetryBlock(root['retry'], scene, pid);
  if (!retryRes.ok) {
    return { ok: false, reason: 'retry_records_invalid', errors: [retryRes.error], count: 1 };
  }
  return { ok: true, scene, records: retryRes.records };
}

function fail(
  reason: Extract<EnvelopeLoad, { ok: false }>['reason'],
  errors: readonly LoadDetail[],
): EnvelopeLoad {
  return { ok: false, reason, errors, count: errors.length };
}

/** Bound a `found` value (same convention as the model layer). */
function bounded(v: unknown): unknown {
  if (typeof v === 'string') return v.length <= 256 ? v : `${v.slice(0, 256)}…`;
  if (Array.isArray(v)) return v.length <= 16 ? v : `[${v.length} elements]`;
  if (v !== null && typeof v === 'object') return v;
  return v;
}

// ---- retry block (workspace.md §4.2/§4.3 step 7) ---------------------------

/**
 * Validate the retry block: `retention === 128`; `records` an array of
 * well-formed records (fields, types, digest shape, result shape per
 * commands.md §5.1); `appliedRevision` strictly ascending and ≤
 * `scene.revision`; `requestId` values unique; ≤ 128 records (over the
 * retention bound ⇒ malformed — the project is blocked, never "repaired").
 * Every discriminator is validated as a PRIMITIVE before any coercion
 * (R12: a JSON object such as `{"toString":0}` used to make `String()`
 * throw a TypeError and abort the whole load).
 */
function validateRetryBlock(
  retry: unknown,
  scene: Scene,
  projectId: string,
): { ok: true; records: RetryRecord[] } | { ok: false; error: LoadDetail } {
  if (!isPlainObject(retry)) {
    return bad('retry block must be an object', undefined, 'object', '/retry');
  }
  for (const k of Object.keys(retry)) {
    if (k !== 'retention' && k !== 'records') {
      return bad('unknown field in retry block', k, 'known fields: retention, records', `/retry/${k}`);
    }
  }
  const retention = retry['retention'];
  if (!isSafeInt(retention) || retention !== RETRY_RETENTION) {
    return bad(
      'retry retention must be 128',
      retention,
      String(RETRY_RETENTION),
      '/retry/retention',
    );
  }
  const records = retry['records'];
  if (!Array.isArray(records)) {
    return bad('retry records must be an array', undefined, 'array', '/retry/records');
  }
  if (records.length > RETRY_RETENTION) {
    return bad(
      `retry block holds ${records.length} records, over the retention bound of ${RETRY_RETENTION}`,
      records.length,
      `<= ${RETRY_RETENTION}`,
      '/retry/records',
    );
  }
  const seen = new Set<string>();
  let prev = -1;
  const out: RetryRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const at = `/retry/records/${i}`;
    if (!isPlainObject(r)) {
      return bad('retry record must be an object', undefined, 'object', at);
    }
    const keys = Object.keys(r);
    for (const k of keys) {
      if (!['requestId', 'digest', 'appliedRevision', 'result'].includes(k)) {
        return bad('unknown field in retry record', k, 'known fields: requestId, digest, appliedRevision, result', `${at}/${k}`);
      }
    }
    const rid = r['requestId'];
    if (typeof rid !== 'string' || !REQUEST_ID_RE.test(rid)) {
      return bad('record requestId must be req- plus 32 lowercase hex chars', rid, 'req-[0-9a-f]{32}', `${at}/requestId`);
    }
    if (seen.has(rid)) {
      return bad('duplicate requestId in retry records', rid, 'unique requestId', `${at}/requestId`);
    }
    seen.add(rid);
    const digest = r['digest'];
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
      return bad('record digest must be 64 lowercase hex chars (SHA-256)', undefined, '[0-9a-f]{64}', `${at}/digest`);
    }
    const applied = r['appliedRevision'];
    if (!isSafeInt(applied) || applied < 0) {
      return bad('record appliedRevision must be a non-negative safe integer', applied, 'integer >= 0', `${at}/appliedRevision`);
    }
    if (applied > scene.revision) {
      return bad(
        `record appliedRevision ${applied} exceeds the scene revision ${scene.revision}`,
        applied,
        `<= ${scene.revision}`,
        `${at}/appliedRevision`,
      );
    }
    if (applied <= prev) {
      return bad(
        `record appliedRevision ${applied} is not strictly ascending (previous: ${prev})`,
        applied,
        `> ${prev}`,
        `${at}/appliedRevision`,
      );
    }
    prev = applied;
    const resultErr = validateRecordResult(r['result'], rid, applied, projectId);
    if (resultErr !== null) {
      return { ok: false, error: resultErr };
    }
    out.push({
      requestId: rid,
      digest,
      appliedRevision: applied,
      result: r['result'] as MutationSuccess,
    });
  }
  return { ok: true, records: out };
}

function bad(message: string, found: unknown, expected: string, path: string): { ok: false; error: LoadDetail } {
  const e: LoadDetail = {
    code: 'retry_records_invalid',
    path,
    message,
    expected,
  };
  if (found !== undefined) e['found'] = found;
  return { ok: false, error: e };
}

// ---- record result shape (commands.md §5.1) --------------------------------

const MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'];

/**
 * Strict shape check of a recorded §5.1 success payload (fields and types
 * per commands.md §5.1; unknown fields rejected — envelope strictness).
 * Returns a LoadDetail describing the first problem, or null when well-formed.
 */
function validateRecordResult(
  result: unknown,
  recordRequestId: string,
  recordAppliedRevision: number,
  envelopeProjectId: string,
): LoadDetail | null {
  if (!isPlainObject(result)) return rerr('record result must be an object', undefined, '/result');
  const keys = Object.keys(result);
  const base = ['ok', 'op', 'projectId', 'requestId', 'revision', 'duplicated', 'change', 'history'];
  // R12: the op discriminator must be a primitive string BEFORE any
  // coercion — a JSON object such as `{"toString":0}` is corrupt shape,
  // not a valid op.
  const opRaw = result['op'];
  if (typeof opRaw !== 'string' || !MUTATION_OPS.includes(opRaw)) {
    return rerr('recorded result op is not one of the five M1 mutation ops', opRaw, '/result/op');
  }
  const op = opRaw;
  let allowed: string[];
  if (op === 'createEntity') allowed = [...base, 'createdId'];
  else if (op === 'undo' || op === 'redo') allowed = [...base, 'appliedOf', 'originOfApplied'];
  else allowed = base;
  for (const k of keys) {
    if (!allowed.includes(k)) {
      return rerr('unknown field in recorded result', k, `${k}`, `/result/${k}`);
    }
  }
  for (const k of base) {
    if (!(k in result)) return rerr(`recorded result is missing required field '${k}'`, undefined, k, `/result/${k}`);
  }
  if (result['ok'] !== true) return rerr('recorded result ok must be true', result['ok'], '/result/ok');
  if (typeof result['projectId'] !== 'string' || !ID_RE.test(result['projectId'])) {
    return rerr('recorded result projectId must use the project-model ID syntax', result['projectId'], '/result/projectId');
  }
  // R13: enclosing-project consistency — the recorded result must belong
  // to the project this envelope belongs to (a record replayed into another
  // project is malformed, not foreign input to trust).
  if (result['projectId'] !== envelopeProjectId) {
    return rerr(
      'record result projectId must equal the envelope projectId (enclosing-project consistency)',
      result['projectId'],
      '/result/projectId',
    );
  }
  if (typeof result['requestId'] !== 'string' || !REQUEST_ID_RE.test(result['requestId'])) {
    return rerr('recorded result requestId must be req- plus 32 hex chars', result['requestId'], '/result/requestId');
  }
  if (result['requestId'] !== recordRequestId) {
    return rerr('record result requestId does not match the enclosing record', result['requestId'], '/result/requestId');
  }
  if (!isSafeInt(result['revision']) || (result['revision'] as number) < 0) {
    return rerr('recorded result revision must be a non-negative safe integer', result['revision'], '/result/revision');
  }
  if ((result['revision'] as number) !== recordAppliedRevision) {
    return rerr(
      'record result revision must equal the record appliedRevision (commands.md §7.1)',
      result['revision'],
      `/result/revision`,
    );
  }
  if (result['duplicated'] !== false) {
    return rerr('recorded result duplicated must be false (the originally acked payload)', result['duplicated'], '/result/duplicated');
  }
  const changeErr = validateChangeShape(result['change'], op);
  if (changeErr !== null) return changeErr;
  if (op === 'createEntity') {
    if (typeof result['createdId'] !== 'string' || result['createdId'] !== (result['change'] as { id: string })['id']) {
      return rerr('createdId must equal the change id (createEntity only)', result['createdId'], '/result/createdId');
    }
  }
  if (op === 'undo' || op === 'redo') {
    if (typeof result['appliedOf'] !== 'string' || !REQUEST_ID_RE.test(result['appliedOf'])) {
      return rerr('appliedOf must be the original command requestId (undo/redo only)', result['appliedOf'], '/result/appliedOf');
    }
    const oo = result['originOfApplied'];
    if (oo !== null) {
      if (!isPlainObject(oo)) {
        return rerr('originOfApplied must be an origin object or null', oo, '/result/originOfApplied');
      }
      const okeys = Object.keys(oo);
      for (const k of okeys) {
        if (k !== 'kind' && k !== 'clientId') return rerr('unknown field in originOfApplied', k, k, `/result/originOfApplied/${k}`);
      }
      // R12: the kind discriminator must be a primitive string before
      // coercion.
      if (typeof oo['kind'] !== 'string' || !['browser', 'mcp', 'admin'].includes(oo['kind'])) {
        return rerr('originOfApplied kind must be browser|mcp|admin', oo['kind'], '/result/originOfApplied/kind');
      }
      if (typeof oo['clientId'] !== 'string') {
        return rerr('originOfApplied clientId must be a string', undefined, '/result/originOfApplied/clientId');
      }
    }
  }
  const h = result['history'];
  if (!isPlainObject(h)) return rerr('recorded result history must be an object', undefined, '/result/history');
  const hkeys = Object.keys(h);
  for (const k of hkeys) {
    if (k !== 'undoDepth' && k !== 'redoDepth') return rerr('unknown field in recorded history', k, k, `/result/history/${k}`);
  }
  if (!isSafeInt(h['undoDepth']) || (h['undoDepth'] as number) < 0) {
    return rerr('history.undoDepth must be a non-negative safe integer', h['undoDepth'], '/result/history/undoDepth');
  }
  if (!isSafeInt(h['redoDepth']) || (h['redoDepth'] as number) < 0) {
    return rerr('history.redoDepth must be a non-negative safe integer', h['redoDepth'], '/result/history/redoDepth');
  }
  return null;
}

function rerr(
  message: string,
  found: unknown,
  expectedOrPath: string,
  path?: string,
): LoadDetail {
  // Two call conventions: rerr(message, found, path) and
  // rerr(message, found, expected, path).
  const e: LoadDetail = { code: 'retry_records_invalid', path: path ?? expectedOrPath, message };
  if (path !== undefined) e['expected'] = expectedOrPath;
  if (found !== undefined) e['found'] = found;
  return e;
}

/** Strict shape check of `change` (§5.3) per the enclosing op. */
function validateChangeShape(change: unknown, op: string): LoadDetail | null {
  if (!isPlainObject(change)) return rerr('recorded change must be an object', undefined, '/result/change');
  const t = change['type'];
  // R12: the change-type discriminator must be a primitive string BEFORE
  // any coercion (a JSON object such as `{"toString":0}` is corrupt shape).
  if (typeof t !== 'string' || !['createEntity', 'setTransform', 'deleteEntity', 'restoreSubtree'].includes(t)) {
    return rerr('recorded change type is not a known change type', t, '/result/change/type');
  }
  // op ↔ change.type correspondence (commands.md §5.3/§8.4).
  if (op === 'createEntity' && t !== 'createEntity') {
    return rerr('createEntity result must carry a createEntity change', t, '/result/change/type');
  }
  if (op === 'setTransform' && t !== 'setTransform') {
    return rerr('setTransform result must carry a setTransform change', t, '/result/change/type');
  }
  if (op === 'deleteEntity' && t !== 'deleteEntity') {
    return rerr('deleteEntity result must carry a deleteEntity change', t, '/result/change/type');
  }
  switch (t) {
    case 'createEntity': {
      if (!sameKeys(change, ['type', 'id', 'entity'])) return rerr('createEntity change keys must be type,id,entity', undefined, '/result/change');
      if (typeof change['id'] !== 'string') return rerr('createEntity change id must be a string', undefined, '/result/change/id');
      const ent = change['entity'];
      // R13: the recorded entity must be the COMPLETE entity value per the
      // model authority (strict schema) — not just an id.
      if (!isPlainObject(ent)) {
        return rerr('createEntity change entity must be the full entity value', undefined, '/result/change/entity');
      }
      const entErr = validateHistoricalEntities([ent], '/result/change/entity');
      if (entErr !== null) return entErr;
      if (ent['id'] !== change['id']) return rerr('createEntity change entity id must equal change id', ent['id'], '/result/change/entity/id');
      return null;
    }
    case 'setTransform': {
      if (!sameKeys(change, ['type', 'id', 'previous', 'next', 'changedFields'])) {
        return rerr('setTransform change keys must be type,id,previous,next,changedFields', undefined, '/result/change');
      }
      if (typeof change['id'] !== 'string' || !ID_RE.test(change['id'])) {
        return rerr('setTransform change id must use the project-model ID syntax', change['id'], '/result/change/id');
      }
      const prevErr = fullTransformError(change['previous'], '/result/change/previous');
      if (prevErr !== null) return prevErr;
      const nextErr = fullTransformError(change['next'], '/result/change/next');
      if (nextErr !== null) return nextErr;
      const cf = change['changedFields'];
      if (!Array.isArray(cf) || cf.length === 0 || cf.length > 3) {
        return rerr('changedFields must list 1–3 replaced fields', cf, '/result/change/changedFields');
      }
      const allowed = new Set(['position', 'rotation', 'scale']);
      const seen = new Set<string>();
      for (const f of cf) {
        if (typeof f !== 'string' || !allowed.has(f) || seen.has(f)) {
          return rerr('changedFields must be distinct entries of position|rotation|scale', f, '/result/change/changedFields');
        }
        seen.add(f);
      }
      return null;
    }
    case 'deleteEntity': {
      if (!sameKeys(change, ['type', 'rootId', 'deletedIds'])) {
        return rerr('deleteEntity change keys must be type,rootId,deletedIds', undefined, '/result/change');
      }
      if (typeof change['rootId'] !== 'string' || !ID_RE.test(change['rootId'])) {
        return rerr('deleteEntity change rootId must use the project-model ID syntax', change['rootId'], '/result/change/rootId');
      }
      const ids = change['deletedIds'];
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string' && ID_RE.test(x))) {
        return rerr('deletedIds must be non-empty project-model entity ids (pre-deletion array order)', undefined, '/result/change/deletedIds');
      }
      return null;
    }
    case 'restoreSubtree': {
      if (!sameKeys(change, ['type', 'rootId', 'entities'])) {
        return rerr('restoreSubtree change keys must be type,rootId,entities', undefined, '/result/change');
      }
      if (typeof change['rootId'] !== 'string' || !ID_RE.test(change['rootId'])) {
        return rerr('restoreSubtree change rootId must use the project-model ID syntax', change['rootId'], '/result/change/rootId');
      }
      const ents = change['entities'];
      if (!Array.isArray(ents) || ents.length === 0) {
        return rerr('restoreSubtree change entities must be a non-empty array (the restored subtree)', undefined, '/result/change/entities');
      }
      // R13: every restored entity is a COMPLETE entity value per the model
      // authority (historical entities need not exist in the current scene).
      const setErr = validateHistoricalEntities(ents, '/result/change/entities');
      if (setErr !== null) return setErr;
      return null;
    }
    default:
      return null;
  }
}

/**
 * R13 (2026-09-18 review): strict validation of historical entity payload(s)
 * using the MODEL AUTHORITY (`validateScene` — project-model §9/§10: known
 * entity fields only, `components` present with validated component shapes,
 * cross-entity reference/cycle/order rules). Historical entities need NOT
 * exist in the current scene (they may have been deleted or undone since the
 * record was written), so reference-existence is validated against a
 * synthetic scene instead: a synthetic camera (the scene must carry exactly
 * one) plus one minimal placeholder parent per referenced-but-missing parent
 * id. A placeholder is itself a model-valid entity (transform-only). The
 * payload is rejected on ANY model error; nothing is rewritten — a load
 * failure blocks the project per workspace.md §7.5.
 */
const ZERO_TRANSFORM = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function validateHistoricalEntities(
  ents: readonly unknown[],
  base: string,
): LoadDetail | null {
  // Ids already present in the payload: a parent that is part of the payload
  // is present; every other referenced parent id gets a placeholder.
  const present = new Set<string>();
  for (const e of ents) {
    if (isPlainObject(e) && typeof e['id'] === 'string') present.add(e['id']);
  }
  const placeholders: Record<string, unknown>[] = [];
  for (const e of ents) {
    if (!isPlainObject(e)) continue; // the model check below reports the shape.
    const pid = e['parentId'];
    if (typeof pid === 'string' && !present.has(pid) && !placeholders.some((p) => p['id'] === pid)) {
      placeholders.push({ id: pid, components: { transform: ZERO_TRANSFORM } });
    }
  }
  const used = new Set(present);
  for (const p of placeholders) used.add(String(p['id']));
  let camId = 'histcam';
  while (used.has(camId)) camId = `${camId}x`;
  const res = validateScene({
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision: 0,
    entities: [
      { id: camId, components: { transform: ZERO_TRANSFORM, camera: {} } },
      ...placeholders,
      ...ents,
    ],
  });
  if (res.ok) return null;
  const first = res.errors[0];
  if (first === undefined) return null; // unreachable: a failure carries ≥ 1 error
  return {
    code: 'retry_records_invalid',
    path: base,
    message: `historical entity payload is not a complete project-model entity: ${first.message}`,
    expected: 'a complete entity value (project-model §9/§10: id, optional name, optional parentId, components)',
  };
}

/** Sorted comma-joined key list (unknown/missing fields both fail shape). */
/** Exact key-set equality (order-independent): the recorded change objects
 * pin their exact field set (canonical order in the fixture bytes). */
function sameKeys(v: Record<string, unknown>, want: readonly string[]): boolean {
  const keys = Object.keys(v);
  if (keys.length !== want.length) return false;
  const set = new Set(want);
  return keys.every((k) => set.has(k));
}

/** Full-transform shape (all three fields, right-length number arrays). */
function fullTransformError(v: unknown, path: string): LoadDetail | null {
  if (!isPlainObject(v)) return rerr('transform must be an object', undefined, path);
  const want: Record<string, number> = { position: 3, rotation: 4, scale: 3 };
  for (const k of Object.keys(v)) {
    if (!(k in want)) return rerr(`unknown field in transform: ${k}`, k, `${path}/${k}`);
  }
  for (const [k, n] of Object.entries(want)) {
    const a = v[k];
    if (!Array.isArray(a) || a.length !== n || !a.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return rerr(`transform.${k} must be ${n} finite numbers`, a, `${path}/${k}`);
    }
  }
  return null;
}