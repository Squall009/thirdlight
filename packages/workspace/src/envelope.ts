/**
 * The single-file authoring-state envelope of a storage v3 project
 * (`scenes/main.json`, workspace.md §4/§16) and the retry-record rules every
 * storage v4 file shares.
 *
 * - A v3 envelope is only READ now: the automatic v3 → v4 upgrade on open
 *   loads it (§4.3/§16.4 pipeline, first failure wins: strict parse → root
 *   object → `storageVersion` → `type` → `projectId` → the six-key set → the
 *   §16.2 combination check → the v3 content block and scene → the retry
 *   block; the manifest cross-checks need the separate manifest file and run
 *   in the session loader).
 * - Storage versions 1 and 2 (the M1/M2 envelopes) were removed in phase
 *   9.3: such an envelope is refused with `storage_version_unsupported`.
 * - `validateRetryBlock` / the record-result shape check (§4.2) are shared
 *   with the v4 files (`store-v4.ts`).
 */

import type { ContentCatalogV3, SceneV3 } from '@thirdlight/project-model';
import type { LoadDetail, UnavailableReason } from './errors';
import {
  parseDocumentBytes,
  validateContentV3,
  validateSceneV3,
  validateSceneV4,
} from '@thirdlight/project-model';
import type { MutationSuccess } from '@thirdlight/commands';

import { isPlainObject, isSafeInt, pointerSegment } from './errors';

/** The constant recorded in every retry block (workspace.md §4.2). */
export const RETRY_RETENTION = 128;
/**
 * Phase 14.8: the retry-record format a storage-v4 file is written with.
 * Version 1 (no `recordVersion` key in the retry block — every v4 file
 * written before phase 14) stores the commands.md §5.1 payload; version 2
 * also stores the acknowledged `sceneId` (the scene the command edited;
 * absent for a scene-index change), so an identical retry replays the live
 * acknowledgement. Both are read; only version 2 is written. A v3 envelope's
 * retry block never carries the key.
 */
export const RETRY_RECORD_VERSION = 2;
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
  /**
   * The full §5.1 success payload as originally acked, `duplicated: false`;
   * in a record-version-2 block also the acked `sceneId` (phase 14.8).
   */
  result: MutationSuccess;
}

/** §4.3/§16.4 pipeline outcome for one v3 envelope byte blob. */
export type EnvelopeLoad =
  | {
      ok: true;
      storageVersion: 3;
      scene: SceneV3;
      content: ContentCatalogV3;
      records: RetryRecord[];
    }
  | {
      ok: false;
      reason: UnavailableReason;
      errors: readonly LoadDetail[];
      count: number;
    };

/**
 * Run the §4.3/§16.4 load validation pipeline over raw v3 envelope bytes
 * (step 8, the manifest + cross-document checks, needs the separate manifest
 * file and runs in the session loader). A storage v1/v2 envelope is refused
 * with `storage_version_unsupported` (removed in phase 9.3).
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
  // 3. storageVersion 3 (the only single-file envelope still read); any
  //    other value stops deeper checks.
  const sv = root['storageVersion'];
  if (sv === 1 || sv === 2) {
    return fail('storage_version_unsupported', [
      {
        code: 'storage_version_unsupported',
        path: '/storageVersion',
        message: `this project is stored as storage version ${sv} (the ${sv === 1 ? 'M1' : 'M2'} single-scene format), which this version no longer opens (removed in phase 9.3)`,
        found: sv,
        expected: '3 (upgraded to 4 on open) or a storage v4 project',
        hint: 'convert it with an earlier Thirdlight version (migrateProjectCopy / migrateProjectCopyV3 to storage v3), then open it here',
        knownVersions: [3, 4],
      },
    ]);
  }
  if (sv !== 3) {
    return fail('storage_version_unsupported', [
      {
        code: 'storage_version_unsupported',
        path: '/storageVersion',
        message: 'envelope storageVersion is not known (storage v3 envelopes are read and upgraded; v4 projects have no single envelope)',
        found: bounded(sv),
        expected: '3',
        knownVersions: [3, 4],
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
  return validateV3Envelope(root, pid);
}

/**
 * The `storageVersion` 3 branch (workspace.md §16.3/§16.4). Normative order:
 * the six-key envelope set ⇒ `envelope_invalid`; the §16.2 combination check
 * (`scene.schemaVersion` must be 3) **before** any scene/content field
 * validation ⇒ a single `version_combination_unsupported`; then the six-key
 * `content` block (`validateContentV3` — it enforces the canonical
 * `content_bytes` ≤ 1 048 576 and `game_bytes` ≤ 16 384 budgets) and the v3
 * scene (`validateSceneV3`), both evaluated and both error sets reported when
 * both fail; finally the retry block. The cross-block `validateProjectV3`
 * (game/cue/animation references) runs in the session loader, which holds the
 * manifest.
 */
function validateV3Envelope(root: Record<string, unknown>, pid: string): EnvelopeLoad {
  // §16.3 — the top-level six-key set.
  const WANT = ['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry'] as const;
  for (const k of WANT) {
    if (!(k in root)) {
      return fail('envelope_invalid', [
        {
          code: 'field_missing',
          path: `/${k}`,
          message: `required envelope field '${k}' is missing`,
          expected: 'present',
        },
      ]);
    }
  }
  for (const k of Object.keys(root)) {
    if (!(WANT as readonly string[]).includes(k)) {
      return fail('envelope_invalid', [
        {
          code: 'field_unexpected',
          path: `/${pointerSegment(k)}`,
          message: 'unknown field is not permitted in the envelope (strict schema drops nothing)',
          found: k,
          expected: `known fields: ${WANT.join(', ')}`,
        },
      ]);
    }
  }
  // §16.2 — the version-combination check BEFORE any scene/content field
  // validation: a v3 envelope must carry a schemaVersion 3 scene.
  const sceneRaw = root['scene'];
  const sceneSchema = isPlainObject(sceneRaw) ? sceneRaw['schemaVersion'] : undefined;
  if (sceneSchema !== 3) {
    return fail('version_combination_unsupported', [
      {
        code: 'version_combination_unsupported',
        path: '/scene/schemaVersion',
        message: 'a storageVersion 3 envelope requires scene schemaVersion 3 (the only passable v3 combination)',
        found: bounded(sceneSchema),
        expected: '3',
      },
    ]);
  }
  // §16.3 content key set — exactly the six v3 keys; a missing or unknown
  // key is `envelope_invalid` (the envelope's own key-set rule, matching the
  // model's v3 envelope branch).
  const contentRaw = root['content'];
  if (!isPlainObject(contentRaw)) {
    return fail('envelope_invalid', [
      {
        code: 'field_type',
        path: '/content',
        message: 'the content block must be an object',
        found: bounded(contentRaw),
        expected: 'object',
      },
    ]);
  }
  const WANT_CONTENT = ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game'] as const;
  for (const k of WANT_CONTENT) {
    if (!(k in contentRaw)) {
      return fail('envelope_invalid', [
        {
          code: 'field_missing',
          path: `/content/${k}`,
          message: `required v3 content key '${k}' is missing`,
          expected: 'present',
        },
      ]);
    }
  }
  for (const k of Object.keys(contentRaw)) {
    // Phase 12 (b): `tags` (the tag registry) is the one optional content key.
    if (!(WANT_CONTENT as readonly string[]).includes(k) && k !== 'tags') {
      return fail('envelope_invalid', [
        {
          code: 'field_unexpected',
          path: `/content/${pointerSegment(k)}`,
          message: 'unknown v3 content key is not permitted (the six-key set is exact)',
          found: k,
          expected: `known keys: ${WANT_CONTENT.join(', ')}`,
        },
      ]);
    }
  }
  // §16.4 step 4 — content (six-key v3 block, incl. both byte budgets) and
  // scene; both are evaluated and both error sets are reported when both
  // fail.
  const sceneRes = validateSceneV3(sceneRaw);
  const contentRes = validateContentV3(contentRaw);
  if (!sceneRes.ok || !contentRes.ok) {
    const errors: LoadDetail[] = [];
    let count = 0;
    if (!sceneRes.ok) {
      errors.push(...(sceneRes.errors.slice(0, 10) as readonly LoadDetail[]));
      count += sceneRes.errors.length;
    }
    if (!contentRes.ok) {
      errors.push(...(contentRes.errors.slice(0, 10) as readonly LoadDetail[]));
      count += contentRes.errors.length;
    }
    return {
      ok: false,
      reason: !sceneRes.ok ? 'scene_invalid' : 'content_invalid',
      errors,
      count,
    };
  }
  // §16.4 step 6 — retry block (v3 records may carry the M1/M2/v3 op set).
  const scene = sceneRes.normalized as SceneV3;
  const retryRes = validateRetryBlock(root['retry'], scene.revision, pid, 3);
  if (!retryRes.ok) {
    return { ok: false, reason: 'retry_records_invalid', errors: [retryRes.error], count: 1 };
  }
  return {
    ok: true,
    storageVersion: 3,
    scene,
    content: contentRes.normalized as ContentCatalogV3,
    records: retryRes.records,
  };
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
export function validateRetryBlock(
  retry: unknown,
  sceneRevision: number,
  projectId: string,
  storageVersion: 3 | 4,
): { ok: true; records: RetryRecord[] } | { ok: false; error: LoadDetail } {
  if (!isPlainObject(retry)) {
    return bad('retry block must be an object', undefined, 'object', '/retry');
  }
  // Phase 14.8: a v4 block names its record format (absent = version 1).
  const blockKeys = storageVersion === 4 ? ['recordVersion', 'retention', 'records'] : ['retention', 'records'];
  for (const k of Object.keys(retry)) {
    if (!blockKeys.includes(k)) {
      return bad('unknown field in retry block', k, `known fields: ${blockKeys.join(', ')}`, `/retry/${pointerSegment(k)}`);
    }
  }
  let recordVersion = 1;
  if ('recordVersion' in retry) {
    const rv = retry['recordVersion'];
    if (!isSafeInt(rv) || rv !== RETRY_RECORD_VERSION) {
      return bad(`retry recordVersion must be ${RETRY_RECORD_VERSION} (version 1 omits the key)`, rv, String(RETRY_RECORD_VERSION), '/retry/recordVersion');
    }
    recordVersion = rv;
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
        return bad('unknown field in retry record', k, 'known fields: requestId, digest, appliedRevision, result', `${at}/${pointerSegment(k)}`);
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
    if (applied > sceneRevision) {
      return bad(
        `record appliedRevision ${applied} exceeds the scene revision ${sceneRevision}`,
        applied,
        `<= ${sceneRevision}`,
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
    const resultErr = validateRecordResult(r['result'], rid, applied, projectId, storageVersion, recordVersion);
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

const M1_MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'];
/** The packet-21/22 content/prefab operation set (commands.md §8.5–§8.12). */
const M2_RESULT_OPS = [
  'publishAsset',
  'publishBehavior',
  'setBehaviorProperties',
  'setComponent',
  'setSettings',
  'acknowledgeBehaviorTrust',
  'createPrefab',
  'instantiatePrefab',
];

/** The packet-45 v3 operation set (commands.md §8.13–§8.14). */
const V3_RESULT_OPS = ['applySurfacePreset', 'setGameConfig', 'updateEntity', 'moveEntities', 'setTags', 'setAssetOptions', 'pasteEntities', 'setMaterial', 'deleteMaterial', 'setEnvironment', 'setLighting', 'setAnimator', 'deleteAnimator', 'setInput', 'setFlow', 'createScene', 'renameScene', 'deleteScene', 'setStartScenes', 'setGraph', 'deleteGraph', 'graphEdit'];
/** Phase 12 (c): the ops only a v4 project records (the scene index). */
const V4_RESULT_OPS = ['createScene', 'renameScene', 'deleteScene', 'setStartScenes'];

/** The mutation ops a record of a `storageVersion` 3 envelope / 4 file can carry. */
export function mutationOpsForStorageVersion(storageVersion: 3 | 4): readonly string[] {
  return storageVersion === 3
    ? [...M1_MUTATION_OPS, ...M2_RESULT_OPS, ...V3_RESULT_OPS]
    : [...M1_MUTATION_OPS, ...M2_RESULT_OPS, ...V3_RESULT_OPS, ...V4_RESULT_OPS];
}

/**
 * Strict shape check of a recorded §5.1 success payload (fields and types
 * per commands.md §5.1; unknown fields rejected — envelope strictness).
 * Returns a LoadDetail describing the first problem, or null when well-formed.
 *
 * `storageVersion` selects the accepted op set (a v4 file additionally
 * records the scene-index ops) and the scene rules the historical entity
 * payloads are checked against; the content-op payloads are checked
 * structurally (workspace.md §4.2 record well-formedness).
 */
function validateRecordResult(
  result: unknown,
  recordRequestId: string,
  recordAppliedRevision: number,
  envelopeProjectId: string,
  storageVersion: 3 | 4,
  recordVersion: number,
): LoadDetail | null {
  if (!isPlainObject(result)) return rerr('record result must be an object', undefined, '/result');
  const keys = Object.keys(result);
  const base = ['ok', 'op', 'projectId', 'requestId', 'revision', 'duplicated', 'change', 'history'];
  const acceptedOps = mutationOpsForStorageVersion(storageVersion);
  // R12: the op discriminator must be a primitive string BEFORE any
  // coercion — a JSON object such as `{"toString":0}` is corrupt shape,
  // not a valid op.
  const opRaw = result['op'];
  if (typeof opRaw !== 'string' || !acceptedOps.includes(opRaw)) {
    return rerr('recorded result op is not a known M1/M2/v3 mutation op', opRaw, '/result/op');
  }
  const op = opRaw;
  let allowed: string[];
  if (op === 'createEntity' || op === 'pasteEntities') allowed = [...base, 'createdId'];
  else if (op === 'undo' || op === 'redo') allowed = [...base, 'appliedOf', 'originOfApplied'];
  else allowed = base;
  // Record version 2 (phase 14.8) also stores the acked scene id.
  if (recordVersion >= 2) allowed = [...allowed, 'sceneId'];
  for (const k of keys) {
    if (!allowed.includes(k)) {
      return rerr('unknown field in recorded result', k, `${k}`, `/result/${pointerSegment(k)}`);
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
  const changeErr = validateChangeShape(result['change'], op, storageVersion);
  if (changeErr !== null) return changeErr;
  if ('sceneId' in result) {
    if (typeof result['sceneId'] !== 'string' || !ID_RE.test(result['sceneId'])) {
      return rerr('recorded result sceneId must use the project-model ID syntax', result['sceneId'], '/result/sceneId');
    }
    // A scene-index change names no scene (the live acknowledgement omits it).
    if ((result['change'] as { type?: unknown })['type'] === 'setSceneIndex') {
      return rerr('recorded result of a scene-index change carries no sceneId', result['sceneId'], '/result/sceneId');
    }
  }
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
        if (k !== 'kind' && k !== 'clientId') return rerr('unknown field in originOfApplied', k, k, `/result/originOfApplied/${pointerSegment(k)}`);
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
    if (k !== 'undoDepth' && k !== 'redoDepth') return rerr('unknown field in recorded history', k, k, `/result/history/${pointerSegment(k)}`);
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

/**
 * Structural change validation of a record result (commands.md §5.3): the
 * change type, its op correspondence, exact key sets and primitive
 * discriminators; historical entity payloads are checked against the scene
 * rules (`validateHistoricalEntities`). Historical content records
 * (assets/behaviors/prefabs) are not re-validated here: the live content
 * block is validated separately.
 */
function validateChangeShape(change: unknown, op: string, storageVersion: 3 | 4): LoadDetail | null {
  if (!isPlainObject(change)) return rerr('recorded change must be an object', undefined, '/result/change');
  const t = change['type'];
  if (typeof t !== 'string' || !V2_CHANGE_TYPES.includes(t)) {
    return rerr('recorded change type is not a known change type', t, '/result/change/type');
  }
  // op ↔ change.type correspondence; undo/redo carry any inverse change type
  // (commands.md §5.3/§8.4).
  if (op !== 'undo' && op !== 'redo') {
    const expected = M2_CHANGE_TYPE_BY_OP[op];
    if (expected !== undefined && expected !== t) {
      return rerr(`recorded change type does not match the recorded op '${op}'`, t, '/result/change/type');
    }
    if (expected === undefined) {
      // M1 ops keep their exact correspondence (createEntity/setTransform/
      // deleteEntity); any other op/type pair is corrupt shape.
      const m1Expected: Record<string, string> = {
        createEntity: 'createEntity',
        setTransform: 'setTransform',
        deleteEntity: 'deleteEntity',
      };
      if (m1Expected[op] !== t) {
        return rerr(`recorded change type does not match the recorded op '${op}'`, t, '/result/change/type');
      }
    }
  }
  const keys = Object.keys(change);
  const required = V2_CHANGE_KEYS[t];
  if (required !== undefined) {
    for (const k of required) {
      if (!(k in change)) {
        return rerr(`recorded ${t} change is missing required field '${k}'`, undefined, `/result/change/${k}`);
      }
    }
    const optional = V2_CHANGE_OPTIONAL_KEYS[t] ?? [];
    for (const k of keys) {
      if (!required.includes(k) && !optional.includes(k)) return rerr(`unknown field in recorded ${t} change`, k, `/result/change/${pointerSegment(k)}`);
    }
  }
  if (t === 'createEntity') {
    // R13: the recorded entity must be the COMPLETE entity value.
    const ent = change['entity'];
    if (!isPlainObject(ent)) {
      return rerr('createEntity change entity must be the full entity value', undefined, '/result/change/entity');
    }
    const children = change['children'];
    if (children !== undefined && (!Array.isArray(children) || children.length === 0)) {
      return rerr('createEntity change children must be a non-empty array of entities', undefined, '/result/change/children');
    }
    const entErr = validateHistoricalEntities([ent, ...((children as unknown[] | undefined) ?? [])], '/result/change/entity', storageVersion);
    if (entErr !== null) return entErr;
    if (ent['id'] !== change['id']) return rerr('createEntity change entity id must equal change id', ent['id'], '/result/change/entity/id');
  }
  if (t === 'pasteEntities') {
    const ents = change['entities'];
    if (!Array.isArray(ents) || ents.length === 0) return rerr('pasteEntities change entities must be a non-empty array', undefined, '/result/change/entities');
    const entErr = validateHistoricalEntities(ents, '/result/change/entities', storageVersion);
    if (entErr !== null) return entErr;
  }
  return null;
}

/** All change types a record may carry. */
const V2_CHANGE_TYPES: readonly string[] = [
  'createEntity',
  'setTransform',
  'deleteEntity',
  'restoreSubtree',
  'publishAsset',
  'publishBehavior',
  'setBehaviorProperties',
  'setComponent',
  'setSettings',
  'acknowledgeBehaviorTrust',
  'createPrefab',
  'removePrefab',
  'instantiatePrefab',
  'applySurfacePreset',
  'setGameConfig',
  'updateEntity',
  'moveEntities',
  'setTags',
  'setSceneIndex',
  'setAssetOptions',
  'pasteEntities',
  'setMaterials',
  'setEnvironment',
  'setLighting',
  'setAnimators',
  'setInput',
  'setFlow',
  'graphEdit',
  'setGraph',
];

/** Required field names per change type (structural well-formedness). */
const V2_CHANGE_KEYS: Record<string, readonly string[]> = {
  createEntity: ['type', 'id', 'entity'],
  setTransform: ['type', 'id', 'previous', 'next', 'changedFields'],
  deleteEntity: ['type', 'rootId', 'deletedIds'],
  restoreSubtree: ['type', 'rootId', 'entities'],
  publishAsset: ['type', 'mode', 'assetId', 'previous', 'next'],
  publishBehavior: ['type', 'behaviorId', 'previous', 'next'],
  setBehaviorProperties: ['type', 'id', 'previous', 'next', 'changedKeys'],
  setComponent: ['type', 'id', 'component', 'previous', 'next', 'changedFields'],
  setSettings: ['type', 'previous', 'next', 'changedKeys'],
  acknowledgeBehaviorTrust: ['type', 'sourceDigest', 'previous', 'next'],
  createPrefab: ['type', 'prefabId', 'definition'],
  removePrefab: ['type', 'prefabId'],
  instantiatePrefab: ['type', 'prefabId', 'rootId', 'entries', 'mapping'],
  applySurfacePreset: ['type', 'id', 'preset', 'previous', 'next', 'changedFields'],
  setGameConfig: ['type', 'previous', 'next', 'changedFields'],
  updateEntity: ['type', 'id', 'previous', 'next', 'changedFields', 'order'],
  moveEntities: ['type', 'parentId', 'beforeId', 'entities', 'order'],
  setTags: ['type', 'previous', 'next'],
  setSceneIndex: ['type', 'previous', 'next'],
  setAssetOptions: ['type', 'assetId', 'previous', 'next'],
  pasteEntities: ['type', 'entities'],
  setMaterials: ['type', 'previous', 'next'],
  setEnvironment: ['type', 'previous', 'next'],
  setLighting: ['type', 'sceneId', 'previous', 'next'],
  setAnimators: ['type', 'previous', 'next'],
  setInput: ['type', 'previous', 'next'],
  setFlow: ['type', 'previous', 'next'],
  graphEdit: ['type', 'owner', 'ops'],
  setGraph: ['type', 'graphId', 'previous', 'next'],
};

/** Optional field names per change type (phase 12: a world-keeping reparent's transform). */
const V2_CHANGE_OPTIONAL_KEYS: Record<string, readonly string[]> = {
  updateEntity: ['transform'],
  // A folder created with its children in one transaction (a multi-piece model drop).
  createEntity: ['children'],
};

/** Forward-op → change-type correspondence for the M2 ops. */
const M2_CHANGE_TYPE_BY_OP: Record<string, string> = {
  publishAsset: 'publishAsset',
  publishBehavior: 'publishBehavior',
  setBehaviorProperties: 'setBehaviorProperties',
  setComponent: 'setComponent',
  setSettings: 'setSettings',
  acknowledgeBehaviorTrust: 'acknowledgeBehaviorTrust',
  createPrefab: 'createPrefab',
  instantiatePrefab: 'instantiatePrefab',
  applySurfacePreset: 'applySurfacePreset',
  setGameConfig: 'setGameConfig',
  updateEntity: 'updateEntity',
  moveEntities: 'moveEntities',
  setTags: 'setTags',
  setAssetOptions: 'setAssetOptions',
  pasteEntities: 'pasteEntities',
  setMaterial: 'setMaterials',
  deleteMaterial: 'setMaterials',
  setEnvironment: 'setEnvironment',
  setLighting: 'setLighting',
  setAnimator: 'setAnimators',
  deleteAnimator: 'setAnimators',
  setInput: 'setInput',
  setFlow: 'setFlow',
  createScene: 'setSceneIndex',
  renameScene: 'setSceneIndex',
  deleteScene: 'setSceneIndex',
  setStartScenes: 'setSceneIndex',
  setGraph: 'setGraph',
  deleteGraph: 'setGraph',
  graphEdit: 'graphEdit',
};

/**
 * R13 (2026-09-18 review): strict validation of historical entity payload(s)
 * using the MODEL AUTHORITY (`validateSceneV3`/`validateSceneV4` — known
 * entity fields only, `components` present with validated component shapes,
 * cross-entity reference/cycle/order rules). Historical entities need NOT
 * exist in the current scene (they may have been deleted or undone since the
 * record was written), so reference-existence is validated against a
 * synthetic scene instead: a synthetic camera plus one placeholder folder per
 * referenced-but-missing parent id (and a placeholder spawn per referenced
 * spawn). The payload is rejected on ANY model error; nothing is rewritten —
 * a load failure blocks the project per workspace.md §7.5.
 */
const ZERO_TRANSFORM = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

function validateHistoricalEntities(
  ents: readonly unknown[],
  base: string,
  storageVersion: 3 | 4,
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
      // A v3 placeholder is a folder: it can hold folders and objects alike,
      // and filing into a folder keeps the zone/spawn/physics root rules.
      placeholders.push({ id: pid, components: { folder: {} } });
    }
  }
  // A zone's spawn (a checkpoint's safe spawn, an exit's spawn) need not be in
  // the payload either: a placeholder spawn stands in for it.
  for (const e of ents) {
    if (!isPlainObject(e) || !isPlainObject(e['components'])) continue;
    const zone = (e['components'] as Record<string, unknown>)['gameZone'];
    if (!isPlainObject(zone)) continue;
    for (const ref of [zone['safeSpawnId'], zone['spawnId']]) {
      if (typeof ref === 'string' && !present.has(ref) && !placeholders.some((p) => p['id'] === ref)) {
        placeholders.push({ id: ref, components: { transform: ZERO_TRANSFORM, playerSpawn: {} } });
      }
    }
  }
  const used = new Set(present);
  for (const p of placeholders) used.add(String(p['id']));
  let camId = 'histcam';
  while (used.has(camId)) camId = `${camId}x`;
  const validate = storageVersion === 4 ? validateSceneV4 : validateSceneV3;
  const res = validate({
    schemaVersion: storageVersion,
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
