/**
 * M3 v3 authoring wire + the §20 game control/observation relay (packet 48).
 *
 * `protocol` is the **sole home of the shapes** for the M3 game-control and
 * observation relay (sessions.md §20: "protocol is the sole home of the
 * shapes (packet 48 implements the validators …)"), and this module adds the
 * versioned **v3 authoring** wire validators the browser/MCP/HTTP path needs:
 *
 * - the six-key v3 authoring envelope shape + the six-key v3 `content` block
 *   (workspace.md §16.3, project-model.md §23.3) — **structural only**; the
 *   authoritative deep validation stays in `@thirdlight/project-model` and the
 *   command pipeline (this layer never re-implements it);
 * - the v3 command ops/args surface marker (commands.md §2/§3.1.9/§3.1.10);
 * - the full-state / `mutation.applied` / query payloads, asserted
 *   **binary-free** (sessions.md §11.6/§17.6: no GLB/WAV bytes, no base64);
 * - the §20 control request/result and observation document, strict and
 *   bounded, plus the run-identity tuple shape.
 *
 * Pure: no I/O, no Node built-ins, types-only edges to `commands`/`project-model`
 * (dependencies.md §4.1).
 */
import type {
  ApplySurfacePresetArgs,
  ChangeData,
  ContentCounts,
  GameConfigQueryResult,
  ModelAnimationRolesValue,
  SetGameConfigArgs,
} from '@thirdlight/commands';
/** The v3 mutation ops (commands.md §2; packet 45) — the `commands` package
 *  exports the ops in its type module but not from its public entry, so the
 *  wire layer restates exactly the two accepted names. */
export type V3MutationOp =
  | 'applySurfacePreset'
  | 'setGameConfig'
  | 'updateEntity'
  | 'moveEntities'
  | 'setTags'
  | 'setAssetOptions'
  | 'pasteEntities'
  | 'setMaterial'
  | 'deleteMaterial'
  | 'setEnvironment'
  | 'setLighting'
  | 'setAnimator'
  | 'deleteAnimator'
  | 'setInput'
  | 'setFlow'
  | 'createScene'
  | 'renameScene'
  | 'deleteScene'
  | 'setStartScenes'
  | 'setGraph'
  | 'deleteGraph'
  | 'graphEdit';
import type { AuthoringEnvelopeV3, ContentCatalogV3, GameConfig, SceneV3 } from '@thirdlight/project-model';
import { containsBinaryValue } from './content';
import { sessionError, type SessionError } from './errors';
import { isPlaySessionId, isProjectId, isRelayId } from './ids';
import {
  checkField,
  checkOptionalObject,
  checkShape,
  isPlainObject,
  isStringNoControl,
  type FieldErrorResult,
} from './strict';

// ---- versions, op sets and key order (workspace.md §16.3, commands.md §2) ----

/** The v3 storage version (workspace.md §16.3). */
export const V3_STORAGE_VERSION = 3 as const;
/** The v3 scene document `schemaVersion` (project-model.md §23.1). */
export const V3_SCHEMA_VERSION = 3 as const;

/** The exact six-key v3 envelope key set, in canonical order. */
export const V3_ENVELOPE_KEYS = [
  'storageVersion',
  'type',
  'projectId',
  'scene',
  'content',
  'retry',
] as const;

/** The exact six-key v3 `content` block, in canonical order (workspace.md §16.3). */
export const V3_CONTENT_KEYS = [
  'assets',
  'prefabs',
  'behaviors',
  'settings',
  'behaviorTrust',
  'game',
] as const;

/** The v3 scene document key set, in canonical order. */
export const V3_SCENE_KEYS = ['schemaVersion', 'sceneId', 'revision', 'entities'] as const;

/** The v3 mutation ops (commands.md §2; packet 45). */
export const V3_MUTATION_OPS: readonly V3MutationOp[] = ['applySurfacePreset', 'setGameConfig', 'updateEntity', 'moveEntities', 'setTags', 'setAssetOptions', 'pasteEntities', 'setMaterial', 'deleteMaterial', 'setEnvironment', 'setLighting', 'setAnimator', 'deleteAnimator', 'setInput', 'setFlow', 'createScene', 'renameScene', 'deleteScene', 'setStartScenes', 'setGraph', 'deleteGraph', 'graphEdit'];
/** The v3 query op (commands.md §4; packet 45). */
export const V3_QUERY_OPS: readonly string[] = ['queryGameConfig'];

/** The change-record types a v3 `mutation.applied` frame may carry. */
export const CHANGE_TYPES = [
  'createEntity',
  'setTransform',
  'deleteEntity',
  'publishAsset',
  'publishBehavior',
  'setBehaviorProperties',
  'setComponent',
  'setSettings',
  'acknowledgeBehaviorTrust',
  'createPrefab',
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
] as const;

// ---- structural helpers -------------------------------------------------------

function fieldError(
  code: 'field_missing' | 'field_unexpected' | 'field_type' | 'field_value' | 'limits_exceeded',
  path: string,
  message: string,
  extra?: Record<string, unknown>,
): FieldErrorResult {
  return { ok: false, error: sessionError(code, 'validation', message, { path, ...(extra ?? {}) }) };
}

/** Exact key-set check (every key required, no unknown key), order-independent. */
function exactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): FieldErrorResult {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      return fieldError('field_unexpected', `${path}/${key}`, `unknown field "${key}"`, {
        found: key,
        expected: `known fields: ${keys.join(', ')}`,
      });
    }
  }
  for (const key of keys) {
    if (!(key in obj)) {
      return fieldError('field_missing', `${path}/${key}`, `required field "${key}" is missing`, {
        expected: key,
      });
    }
  }
  return { ok: true, value: obj };
}

/**
 * Assert a wire payload carries no binary (typed array / ArrayBuffer) at any
 * depth. The state/change frames never carry GLB/WAV bytes or base64 media
 * (sessions.md §11.6/§17.6). Base64 *strings* are a policy matter (the
 * screenshot ack is the one deliberate exception); this check is about typed
 * binary only.
 */
function assertBinaryFree(value: unknown, path: string): FieldErrorResult {
  if (containsBinaryValue(value)) {
    return fieldError('field_type', path, 'state/change frames must not carry binary values');
  }
  return { ok: true, value: value as Record<string, unknown> };
}

// ---- the v3 authoring envelope / content block --------------------------------

/**
 * Structural check of the six-key v3 authoring envelope (workspace.md §16.3).
 * Envelope-level rules only: the key set, `storageVersion`/`type`, the
 * project-id syntax, `scene.schemaVersion` and the six-key `content` block.
 * Field-level/deep validity is the accepted `project-model`/workspace load
 * pipeline's (this validator never re-implements it).
 */
export function validateV3EnvelopeShape(value: unknown, path = ''): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, 'the v3 envelope must be a JSON object', { expected: 'object' });
  }
  const keys = exactKeys(value, V3_ENVELOPE_KEYS, path);
  if (!keys.ok) return keys;
  if (value.storageVersion !== V3_STORAGE_VERSION) {
    return fieldError('field_value', `${path}/storageVersion`, 'storageVersion must be 3 for the v3 envelope', {      found: value.storageVersion,
      expected: String(V3_STORAGE_VERSION),
    });
  }
  if (value.type !== 'authoring-state') {
    return fieldError('field_value', `${path}/type`, 'type must be "authoring-state"', { found: value.type });
  }
  if (!isProjectId(value.projectId)) {
    return fieldError('field_value', `${path}/projectId`, 'projectId must match the project-model ID syntax');
  }
  const scene = validateV3SceneShape(value.scene, `${path}/scene`);
  if (!scene.ok) return scene;
  const content = validateV3ContentBlock(value.content, `${path}/content`);
  if (!content.ok) return content;
  return assertBinaryFree(value, path);
}

/** Structural check of the v3 scene document (project-model.md §23.1). */
export function validateV3SceneShape(value: unknown, path = '/scene'): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, 'the v3 scene must be a JSON object', { expected: 'object' });
  }
  const keys = exactKeys(value, V3_SCENE_KEYS, path);
  if (!keys.ok) return keys;
  if (value.schemaVersion !== V3_SCHEMA_VERSION) {
    return fieldError('field_value', `${path}/schemaVersion`, 'a v3 envelope carries scene.schemaVersion 3', {
      found: value.schemaVersion,
      expected: String(V3_SCHEMA_VERSION),
    });
  }
  if (typeof value.sceneId !== 'string' || value.sceneId.length === 0) {
    return fieldError('field_type', `${path}/sceneId`, 'sceneId must be a non-empty string');
  }
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    return fieldError('field_value', `${path}/revision`, 'revision must be a non-negative integer');
  }
  if (!Array.isArray(value.entities)) {
    return fieldError('field_type', `${path}/entities`, 'entities must be an array');
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * Structural check of the six-key v3 `content` block (workspace.md §16.3):
 * exactly the six keys, `game` present (null or an object), the remaining five
 * of their block types. Deep content validity is `project-model`'s.
 */
export function validateV3ContentBlock(value: unknown, path = '/content'): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, 'the v3 content block must be a JSON object', { expected: 'object' });
  }
  // Phase 12 (b): `tags` (the tag registry) is optional.
  const { tags, ...required } = value;
  const keys = exactKeys(required, V3_CONTENT_KEYS, path);
  if (!keys.ok) return keys;
  if (tags !== undefined && !Array.isArray(tags)) {
    return fieldError('field_type', `${path}/tags`, 'tags must be an array of { bit, name }');
  }
  if (!Array.isArray(value.assets)) {
    return fieldError('field_type', `${path}/assets`, 'assets must be an array');
  }
  if (!Array.isArray(value.prefabs)) {
    return fieldError('field_type', `${path}/prefabs`, 'prefabs must be an array');
  }
  if (!Array.isArray(value.behaviors)) {
    return fieldError('field_type', `${path}/behaviors`, 'behaviors must be an array');
  }
  if (!isPlainObject(value.settings)) {
    return fieldError('field_type', `${path}/settings`, 'settings must be an object');
  }
  if (!isPlainObject(value.behaviorTrust) || !Array.isArray((value.behaviorTrust as Record<string, unknown>).entries)) {
    return fieldError('field_type', `${path}/behaviorTrust`, 'behaviorTrust must be `{ entries: [] }`');
  }
  if (value.game !== null && !isPlainObject(value.game)) {
    return fieldError('field_type', `${path}/game`, 'content.game must be null or an object (GameConfig)', {
      found: typeof value.game,
    });
  }
  return assertBinaryFree(value, path);
}

// ---- the v3 command arg markers ----------------------------------------------

/**
 * The structural v3 arg markers. The authoritative args validation is the
 * command pipeline's (`commands.md` §3.1.9/§3.1.10/§A3–§A6): this only types
 * the shapes the wire layer may forward and asserts they are objects, so a
 * `field_type` failure never reaches the mutation engine as a scene write.
 */
export function validateV3MutationArgs(op: V3MutationOp, value: unknown, path = '/args'): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, `${op} args must be an object`, { expected: 'object' });
  }
  if (containsBinaryValue(value)) {
    return fieldError('field_type', path, 'command args must not carry binary values');
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** The two v3 args types, re-exported (types-only edge, dependencies.md §4.1). */
export type { ApplySurfacePresetArgs, SetGameConfigArgs, ModelAnimationRolesValue };

// ---- full-state / projection / change / query frames --------------------------

/** The §5.1 full-state payload key set. */
const FULL_STATE_KEYS = [
  'ok',
  'sessionId',
  'connId',
  'wsToken',
  'revision',
  'manifest',
  'scene',
  'history',
  'workspace',
  'content',
] as const;

/**
 * Validate a full-state/projection payload (sessions.md §5.1/§8): the initial
 * session projection and the resync payload. For a v3 project the scene is a
 * v3 scene and `content` (present for a v2/v3 envelope) carries the six-key v3
 * block. Always asserted **binary-free** (sessions.md §11.6).
 */
export function validateFullStateFrame(value: unknown, path = ''): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, 'the full-state payload must be a JSON object');
  }
  const keys = checkShape(value, path, new Map(FULL_STATE_KEYS.map((k) => [k, k])), ['revision', 'manifest', 'scene', 'history', 'workspace']);
  if (!keys.ok) return keys;
  const free = assertBinaryFree(value, path);
  if (!free.ok) return free;
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    return fieldError('field_value', `${path}/revision`, 'revision must be a non-negative integer');
  }
  if (!isPlainObject(value.scene)) {
    return fieldError('field_type', `${path}/scene`, 'scene must be the normalized scene projection object');
  }
  if (value.content !== undefined) {
    // §19.4: the full-state `content` is the bounded content PROJECTION
    // (summary pages), never the six-key envelope content block. For a v3
    // project it may additionally carry `game` (null or an object).
    if (!isPlainObject(value.content)) {
      return fieldError('field_type', `${path}/content`, 'content must be the bounded content projection object');
    }
    for (const key of Object.keys(value.content)) {
      if (!(CONTENT_PROJECTION_KEYS as readonly string[]).includes(key)) {
        return fieldError('field_unexpected', `${path}/content/${key}`, `unknown content projection field "${key}"`, {
          found: key,
          expected: `known fields: ${CONTENT_PROJECTION_KEYS.join(', ')}`,
        });
      }
    }
    if (value.content.game !== undefined && value.content.game !== null && !isPlainObject(value.content.game)) {
      return fieldError('field_type', `${path}/content/game`, 'content.game must be null or a GameConfig object');
    }
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** §19.4's bounded content projection keys (+ the v3 `game` summary). */
export const CONTENT_PROJECTION_KEYS = ['assets', 'prefabs', 'behaviors', 'behaviorTrust', 'game'] as const;

/**
 * Validate a `mutation.applied` projection frame (sessions.md §6.2/§7.1):
 * `{ requestId, revision, origin, change, sceneId? }`, binary-free, with a known change
 * type. The change payload itself is the command layer's (`commands.md` §5.3).
 */
export function validateChangeFrame(value: unknown, path = ''): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, 'mutation.applied must be a JSON object');
  }
  const keys = checkShape(
    value,
    path,
    new Map([
      ['type', '"mutation.applied"'],
      ['requestId', 'req- + 32 hex'],
      ['revision', 'integer ≥ 0'],
      ['origin', 'the command origin or null'],
      ['change', 'commands.md §5.3 change data'],
      // Phase 12 (c): the scene a v4 edit touched.
      ['sceneId', 'the edited scene (v4)'],
    ]),
    ['type', 'requestId', 'revision', 'change'],
  );
  if (!keys.ok) return keys;
  const free = assertBinaryFree(value, path);
  if (!free.ok) return free;
  if (value.type !== 'mutation.applied') {
    return fieldError('field_value', `${path}/type`, 'type must be "mutation.applied"');
  }
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    return fieldError('field_value', `${path}/revision`, 'revision must be a non-negative integer');
  }
  if (!isPlainObject(value.change)) {
    return fieldError('field_type', `${path}/change`, 'change must be an object');
  }
  const changeType = value.change.type;
  if (typeof changeType !== 'string' || !(CHANGE_TYPES as readonly string[]).includes(changeType)) {
    return fieldError('field_value', `${path}/change/type`, 'change.type must be a known change type', {
      found: String(changeType).slice(0, 64),
      expected: `one of: ${CHANGE_TYPES.join(', ')}`,
    });
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** The v3 query result shapes (`queryGameConfig`, v3 `queryProject` counts). */
export function validateQueryResultV3(op: string, value: unknown, path = ''): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', path, `${op} result must be a JSON object`);
  }
  const free = assertBinaryFree(value, path);
  if (!free.ok) return free;
  if (value.ok !== true) {
    // Failure results are the §5.2 shape; nothing further is asserted here.
    return { ok: true, value: value as Record<string, unknown> };
  }
  if (op === 'queryGameConfig') {
    if (value.game !== null && !isPlainObject(value.game)) {
      return fieldError('field_type', `${path}/game`, 'queryGameConfig.game must be null or a GameConfig object', {
        found: typeof value.game,
      });
    }
    return { ok: true, value: value as Record<string, unknown> };
  }
  if (op === 'queryProject') {
    const counts = value.contentCounts;
    if (counts !== undefined && !isPlainObject(counts)) {
      return fieldError('field_type', `${path}/contentCounts`, 'contentCounts must be an object');
    }
    return { ok: true, value: value as Record<string, unknown> };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Re-export the change-result type (types-only edge). */
export type { ChangeData, ContentCounts, GameConfigQueryResult, AuthoringEnvelopeV3, ContentCatalogV3, SceneV3, GameConfig };

// ---- §20 game control and observation relay -----------------------------------

/**
 * The §20.1 control commands (closed set). Phase 12 (c) adds `loadScene` /
 * `unloadScene` (with `sceneId`), the same request a script's `ctx.scenes` makes.
 * Phase 19.2 adds the visual-script debugger's `debugPause` / `debugResume` / `debugStep` (Play only).
 */
export const GAME_CONTROL_COMMANDS = ['start', 'replay', 'mute', 'unmute', 'loadScene', 'unloadScene', 'clearSave', 'debugPause', 'debugResume', 'debugStep'] as const;
export type GameControlCommand = (typeof GAME_CONTROL_COMMANDS)[number];

/** §20.1 bounds: request bodies ≤ 4 KiB; control result ≤ 4 KiB; observation ≤ 16 KiB. */
export const GAME_CONTROL_BODY_MAX_BYTES = 4_096;
export const GAME_OBSERVE_BODY_MAX_BYTES = 4_096;
export const GAME_CONTROL_RESULT_MAX_BYTES = 4_096;
export const GAME_OBSERVATION_MAX_BYTES = 16_384;
/** §20.1 observe timeout: 250–15 000 ms, default 5 000. */
export const GAME_OBSERVE_TIMEOUT_MIN_MS = 250;
export const GAME_OBSERVE_TIMEOUT_MAX_MS = 15_000;
export const GAME_OBSERVE_TIMEOUT_DEFAULT_MS = 5_000;
/** The retained event bound (gameplay.md §6 `MAX_GAME_EVENTS`). */
export const GAME_OBSERVATION_EVENT_MAX = 32;

/** The closed §20 run-state set (gameplay.md §2). */
export const GAME_RUN_STATES = ['awaitingStart', 'playing', 'respawning', 'won'] as const;
export type GameRunState = (typeof GAME_RUN_STATES)[number];

/** The closed sound-status set (§20.1/delivery.md §5.2). */
export const GAME_SOUND_STATUSES = ['muted', 'blocked', 'ready', 'unavailable'] as const;
/** The closed audio-gesture set (§20.1). */
export const GAME_GESTURES = ['local', 'none'] as const;
/** The closed input-mode set (§18.1.2/§20.1). */
export const GAME_INPUT_MODES = ['physical', 'test'] as const;
/** The closed §20.2 failure set. */
export const GAME_RELAY_ERROR_CODES = [
  'field_value',
  'field_unexpected',
  'game_command_invalid',
  'game_run_stale',
  'play_not_found',
  'play_locator_expired',
  'bad_origin',
  'game_relay_rejected',
  'session_unavailable',
  'game_relay_timeout',
  'input_relay_conflict',
  'limits_exceeded',
] as const;

/** The closed §20 game-event kind set (gameplay.md §6). */
export const GAME_EVENT_KINDS = [
  'runStarted',
  'died',
  'respawned',
  'checkpointActivated',
  'goalReached',
  'replayed',
] as const;

/** `${snapshotId}#${replayEpoch}` (delivery.md §5.3). */
export const RUN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}@r[0-9]+#[0-9]+$/;
export function isRunId(v: unknown): v is string {
  return typeof v === 'string' && RUN_ID_RE.test(v);
}

export interface GameControlRequest {
  command: GameControlCommand;
  expectedRunId?: string;
  /** Phase 12 (c): loadScene / unloadScene only. */
  sceneId?: string;
}

const GAME_CONTROL_REQUEST_FIELDS = new Map([
  ['command', `one of: ${GAME_CONTROL_COMMANDS.join(', ')}`],
  ['expectedRunId', '<snapshotId>#<replayEpoch> (optional optimistic guard)'],
  ['sceneId', 'the scene (loadScene / unloadScene)'],
]);
const SCENE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Parse the §20 control request body `{ command, expectedRunId? }` strictly
 * (unknown fields ⇒ `field_unexpected`; anything else ⇒ `field_value`).
 */
export function parseGameControlRequest(value: unknown): { ok: true; request: GameControlRequest } | { ok: false; error: SessionError } {
  const shape = checkShape(value ?? {}, '', GAME_CONTROL_REQUEST_FIELDS, ['command']);
  if (!shape.ok) return { ok: false, error: shape.error };
  const cmd = checkField(shape.value, 'command', '', `one of ${GAME_CONTROL_COMMANDS.join('|')}`, (v) =>
    typeof v === 'string' && (GAME_CONTROL_COMMANDS as readonly string[]).includes(v)
      ? null
      : { problem: `command must be one of ${GAME_CONTROL_COMMANDS.join(', ')}`, kind: 'value' },
  );
  if (!cmd.ok) return { ok: false, error: cmd.error };
  const sceneCommand = cmd.value === 'loadScene' || cmd.value === 'unloadScene';
  let sceneId: string | undefined;
  if (sceneCommand || shape.value.sceneId !== undefined) {
    const sid = checkField(shape.value, 'sceneId', '', 'a scene id (loadScene / unloadScene only)', (v) =>
      !sceneCommand ? { problem: 'sceneId goes with loadScene / unloadScene only', kind: 'value' } : typeof v === 'string' && SCENE_ID_RE.test(v) ? null : { problem: 'sceneId must be a scene id', kind: 'value' },
    );
    if (!sid.ok) return { ok: false, error: sid.error };
    sceneId = sid.value as string;
  }
  let expectedRunId: string | undefined;
  if (shape.value.expectedRunId !== undefined) {
    const rid = checkField(shape.value, 'expectedRunId', '', '<snapshotId>#<replayEpoch>', (v) =>
      isRunId(v) ? null : { problem: 'expectedRunId must be <snapshotId>#<replayEpoch>', kind: 'value' },
    );
    if (!rid.ok) return { ok: false, error: rid.error };
    expectedRunId = rid.value as string;
  }
  return {
    ok: true,
    request: {
      command: cmd.value as GameControlCommand,
      ...(expectedRunId !== undefined ? { expectedRunId } : {}),
      ...(sceneId !== undefined ? { sceneId } : {}),
    },
  };
}

export interface GameObserveRequest {
  timeoutMs: number;
  /** Phase 15.4: also read the property values of this entity's running scripts (`behaviors`). */
  entityId?: string;
}

/**
 * Parse the §20 observation request body `{ timeoutMs?, entityId? }`
 * (250–15 000, default 5 000; phase 15.4: `entityId` adds the entity's
 * script property values, public and private, read-only).
 */
export function parseGameObserveRequest(value: unknown): { ok: true; request: GameObserveRequest } | { ok: false; error: SessionError } {
  const shape = checkShape(value ?? {}, '', new Map([['timeoutMs', `integer ${GAME_OBSERVE_TIMEOUT_MIN_MS}–${GAME_OBSERVE_TIMEOUT_MAX_MS}`], ['entityId', 'an entity id (optional)']]), []);
  if (!shape.ok) return { ok: false, error: shape.error };
  let entityId: string | undefined;
  if (shape.value.entityId !== undefined) {
    const e = checkField(shape.value, 'entityId', '', 'an entity id', (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? null : { problem: 'entityId must be an entity id', kind: 'value' }));
    if (!e.ok) return { ok: false, error: e.error };
    entityId = e.value as string;
  }
  const withEntity = (r: GameObserveRequest): GameObserveRequest => (entityId !== undefined ? { ...r, entityId } : r);
  if (shape.value.timeoutMs === undefined) return { ok: true, request: withEntity({ timeoutMs: GAME_OBSERVE_TIMEOUT_DEFAULT_MS }) };
  const t = checkField(shape.value, 'timeoutMs', '', `integer ${GAME_OBSERVE_TIMEOUT_MIN_MS}–${GAME_OBSERVE_TIMEOUT_MAX_MS}`, (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) return { problem: 'timeoutMs must be an integer', kind: 'type' };
    if (v < GAME_OBSERVE_TIMEOUT_MIN_MS || v > GAME_OBSERVE_TIMEOUT_MAX_MS) {
      return { problem: `timeoutMs must be in [${GAME_OBSERVE_TIMEOUT_MIN_MS}, ${GAME_OBSERVE_TIMEOUT_MAX_MS}]`, kind: 'value' };
    }
    return null;
  });
  if (!t.ok) return { ok: false, error: t.error };
  return { ok: true, request: withEntity({ timeoutMs: t.value as number }) };
}

function utf8Bytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null;
    return new TextEncoder().encode(text).length;
  } catch {
    return null;
  }
}

/**
 * Validate one §20 control result (≤ 4 KiB, binary-free). The identity tuple
 * fields are required: `(playSessionId, snapshotId, buildId, runId, command,
 * state, acceptedAtStep, inputMode)`.
 */
export function validateGameControlResult(value: unknown): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', '', 'the control result must be a JSON object');
  }
  const free = assertBinaryFree(value, '');
  if (!free.ok) return free;
  if (value.ok !== true) {
    return fieldError('field_value', '/ok', 'a success control result carries ok: true');
  }
  if (!isPlaySessionId(value.playSessionId)) {
    return fieldError('field_value', '/playSessionId', 'playSessionId must be play- + 32 hex');
  }
  for (const key of ['snapshotId', 'buildId', 'runId'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') {
      return fieldError('field_type', `/${key}`, `${key} must be a non-empty string`);
    }
  }
  if (!isRunId(value.runId)) {
    return fieldError('field_value', '/runId', 'runId must be <snapshotId>#<replayEpoch>');
  }
  if (typeof value.command !== 'string' || !(GAME_CONTROL_COMMANDS as readonly string[]).includes(value.command)) {
    return fieldError('field_value', '/command', `command must be one of ${GAME_CONTROL_COMMANDS.join(', ')}`);
  }
  if (typeof value.state !== 'string' || !(GAME_RUN_STATES as readonly string[]).includes(value.state)) {
    return fieldError('field_value', '/state', 'state must be an accepted run state');
  }
  if (typeof value.acceptedAtStep !== 'number' || !Number.isInteger(value.acceptedAtStep) || value.acceptedAtStep < 0) {
    return fieldError('field_value', '/acceptedAtStep', 'acceptedAtStep must be a non-negative integer');
  }
  if (value.inputMode !== 'physical' && value.inputMode !== 'test') {
    return fieldError('field_value', '/inputMode', 'inputMode must be "physical" or "test"');
  }
  const n = utf8Bytes(value);
  if (n === null || n > GAME_CONTROL_RESULT_MAX_BYTES) {
    return fieldError('limits_exceeded', '', `the control result exceeds the ${GAME_CONTROL_RESULT_MAX_BYTES}-byte bound`, {
      limit: 'result_bytes',
      max: GAME_CONTROL_RESULT_MAX_BYTES,
    });
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * Validate one §20 observation document (≤ 16 KiB, ≤ 32 events, binary-free).
 * The values come from the committed read-only `GameView` (gameplay.md §6);
 * this validator asserts the wire shape and bounds only.
 */
export function validateGameObservation(value: unknown): FieldErrorResult {
  if (!isPlainObject(value)) {
    return fieldError('field_type', '', 'the observation must be a JSON object');
  }
  const free = assertBinaryFree(value, '');
  if (!free.ok) return free;
  if (value.ok !== true) {
    return fieldError('field_value', '/ok', 'a success observation carries ok: true');
  }
  if (!isPlaySessionId(value.playSessionId)) {
    return fieldError('field_value', '/playSessionId', 'playSessionId must be play- + 32 hex');
  }
  for (const key of ['snapshotId', 'buildId', 'runId', 'observedAt'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') {
      return fieldError('field_type', `/${key}`, `${key} must be a non-empty string`);
    }
  }
  if (!isRunId(value.runId)) {
    return fieldError('field_value', '/runId', 'runId must be <snapshotId>#<replayEpoch>');
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    return fieldError('field_value', '/revision', 'revision must be a non-negative integer');
  }
  if (!Number.isInteger(value.stepIndex) || (value.stepIndex as number) < 0) {
    return fieldError('field_value', '/stepIndex', 'stepIndex must be a non-negative integer');
  }
  if (typeof value.simTime !== 'number' || !Number.isFinite(value.simTime) || value.simTime < 0) {
    return fieldError('field_value', '/simTime', 'simTime must be a finite number ≥ 0');
  }
  if (typeof value.state !== 'string' || !(GAME_RUN_STATES as readonly string[]).includes(value.state)) {
    return fieldError('field_value', '/state', 'state must be an accepted run state');
  }
  if (value.checkpointId !== null && typeof value.checkpointId !== 'string') {
    return fieldError('field_type', '/checkpointId', 'checkpointId must be a string or null');
  }
  for (const key of ['checkpointActive', 'goalReached', 'failed'] as const) {
    if (typeof value[key] !== 'boolean') {
      return fieldError('field_type', `/${key}`, `${key} must be a boolean`);
    }
  }
  for (const key of ['deathCount', 'eventCount', 'eventDropped'] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0) {
      return fieldError('field_value', `/${key}`, `${key} must be a non-negative integer`);
    }
  }
  if (value.inputMode !== 'physical' && value.inputMode !== 'test') {
    return fieldError('field_value', '/inputMode', 'inputMode must be "physical" or "test"');
  }
  if (!isPlainObject(value.sound)) {
    return fieldError('field_type', '/sound', 'sound must be a status object');
  }
  const sound = value.sound as Record<string, unknown>;
  if (typeof sound.status !== 'string' || !(GAME_SOUND_STATUSES as readonly string[]).includes(sound.status)) {
    return fieldError('field_value', '/sound/status', 'sound.status must be one of muted, blocked, ready, unavailable');
  }
  if (typeof sound.unlocked !== 'boolean') {
    return fieldError('field_type', '/sound/unlocked', 'sound.unlocked must be a boolean');
  }
  if (typeof sound.muted !== 'boolean') {
    return fieldError('field_type', '/sound/muted', 'sound.muted must be a boolean');
  }
  if (!Number.isInteger(sound.voices) || (sound.voices as number) < 0) {
    return fieldError('field_value', '/sound/voices', 'sound.voices must be a non-negative integer');
  }
  if (typeof sound.gesture !== 'string' || !(GAME_GESTURES as readonly string[]).includes(sound.gesture)) {
    return fieldError('field_value', '/sound/gesture', 'sound.gesture must be one of local, none');
  }
  if (!Array.isArray(value.events)) {
    return fieldError('field_type', '/events', 'events must be an array');
  }
  if (value.events.length > GAME_OBSERVATION_EVENT_MAX) {
    return fieldError('limits_exceeded', '/events', `events must retain at most ${GAME_OBSERVATION_EVENT_MAX} entries`, {
      limit: 'events',
      max: GAME_OBSERVATION_EVENT_MAX,
    });
  }
  for (let i = 0; i < value.events.length; i += 1) {
    const ev = value.events[i];
    if (!isPlainObject(ev)) return fieldError('field_type', `/events/${i}`, 'each event must be an object');
    if (typeof ev.id !== 'string' || ev.id.length === 0) {
      return fieldError('field_type', `/events/${i}/id`, 'event.id must be a non-empty string');
    }
    if (typeof ev.kind !== 'string' || !(GAME_EVENT_KINDS as readonly string[]).includes(ev.kind)) {
      return fieldError('field_value', `/events/${i}/kind`, 'event.kind must be an accepted game-event kind');
    }
    if (!Number.isInteger(ev.stepIndex) || (ev.stepIndex as number) < 0) {
      return fieldError('field_value', `/events/${i}/stepIndex`, 'event.stepIndex must be a non-negative integer');
    }
    if (typeof ev.boundary !== 'boolean') {
      return fieldError('field_type', `/events/${i}/boundary`, 'event.boundary must be a boolean');
    }
    if (!Number.isInteger(ev.deathCount) || (ev.deathCount as number) < 0) {
      return fieldError('field_value', `/events/${i}/deathCount`, 'event.deathCount must be a non-negative integer');
    }
  }
  // Phase 9.7: optional animator states (entity id → state name).
  if (value.animators !== undefined) {
    if (!isPlainObject(value.animators) || Object.keys(value.animators).length > 64 || !Object.values(value.animators).every((x) => typeof x === 'string')) {
      return fieldError('field_type', '/animators', 'animators maps entity ids to state names (at most 64)');
    }
  }
  // Phase 15.4: the optional script-property block of the requested entity.
  if (value.behaviors !== undefined) {
    const b = value.behaviors;
    if (!isPlainObject(b) || typeof b['entityId'] !== 'string' || !Array.isArray(b['scripts']) || b['scripts'].length > 8) {
      return fieldError('field_type', '/behaviors', 'behaviors is { entityId, scripts: [{ behaviorId, properties: [{ key, label, type, visibility, value }] }] } (at most 8 scripts)');
    }
  }
  // Phase 9.10: the optional game-flow block.
  if (value.flow !== undefined && (!isPlainObject(value.flow) || typeof value.flow['screen'] !== 'string' || typeof value.flow['levelIndex'] !== 'number')) {
    return fieldError('field_type', '/flow', 'flow is { screen, levelIndex, levelId, lives, totals, music, volumes, quality, save?, score? }');
  }
  const n = utf8Bytes(value);
  if (n === null || n > GAME_OBSERVATION_MAX_BYTES) {
    return fieldError('limits_exceeded', '', `the observation exceeds the ${GAME_OBSERVATION_MAX_BYTES}-byte bound`, {
      limit: 'result_bytes',
      max: GAME_OBSERVATION_MAX_BYTES,
    });
  }
  return { ok: true, value: value as Record<string, unknown> };
}

// ---- the additive stage-inspect request (packet 48) ---------------------------

/** `idle`/`run`/`airborne` — the exact §41.3.1 role keys. */
export const ANIMATION_ROLE_KEYS = ['idle', 'run', 'airborne'] as const;

/** One §41.3.1 role binding (structurally identical to the pipeline's input). */
export interface AnimationRoleBindingValue {
  clipIndex: number;
  clipName: string;
}
/** The exact three-key §41.3.1 role map. */
export interface AnimationRolesValue {
  idle: AnimationRoleBindingValue;
  run: AnimationRoleBindingValue;
  airborne: AnimationRoleBindingValue;
}

export interface StageInspectRequest {
  kind?: 'model' | 'audio' | 'texture' | 'music';
  animation?: { entityId?: string; roles: AnimationRolesValue };
}

const INSPECT_REQUEST_FIELDS = new Map([
  ['kind', '"model" | "audio" | "texture" | "music" (default "model")'],
  ['animation', '{ entityId?, roles: { idle, run, airborne } } — the §41.3.3 animated profile'],
]);
const ANIMATION_FIELDS = new Map([
  ['entityId', 'string (optional; the referencing entity)'],
  ['roles', 'exactly idle/run/airborne, each { clipIndex, clipName }'],
]);

/**
 * Parse the additive `POST /content/stages/:id/inspect` body (packet 48):
 * `{ kind?, animation? }`. An absent/empty body is the accepted M2 model
 * inspection. `animation` requests the role-aware GLB profile
 * (presentation.md §41.3.3), which is how a real animated reimport reaches
 * stages 5–7 before the ordinary `publishAsset` command commits it.
 */
export function parseStageInspectRequest(
  value: unknown,
): { ok: true; request: StageInspectRequest } | { ok: false; error: SessionError } {
  const shape = checkShape(value ?? {}, '', INSPECT_REQUEST_FIELDS, []);
  if (!shape.ok) return { ok: false, error: shape.error };
  let kind: StageInspectRequest['kind'];
  if (shape.value.kind !== undefined) {
    if (shape.value.kind !== 'model' && shape.value.kind !== 'audio' && shape.value.kind !== 'texture' && shape.value.kind !== 'music') {
      return { ok: false, error: sessionError('field_value', 'validation', 'kind must be "model", "audio", "texture" or "music"', { path: '/kind', found: String(shape.value.kind).slice(0, 64), expected: '"model" | "audio" | "texture" | "music"' }) };
    }
    kind = shape.value.kind;
  }
  let animation: StageInspectRequest['animation'];
  if (shape.value.animation !== undefined) {
    const anim = checkOptionalObject(shape.value, 'animation', '', ANIMATION_FIELDS, ['roles']);
    if (!anim.ok) return { ok: false, error: anim.error };
    const roles = anim.value.roles;
    if (!isPlainObject(roles)) {
      return { ok: false, error: sessionError('field_type', 'validation', 'animation.roles must be an object', { path: '/animation/roles', found: typeof roles }) };
    }
    for (const key of Object.keys(roles)) {
      if (!(ANIMATION_ROLE_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: sessionError('field_unexpected', 'validation', `unknown animation role "${key}"`, { path: `/animation/roles/${key}`, expected: ANIMATION_ROLE_KEYS.join(', ') }) };
      }
    }
    for (const role of ANIMATION_ROLE_KEYS) {
      const binding = roles[role];
      if (!isPlainObject(binding)) {
        return { ok: false, error: sessionError('field_missing', 'validation', `animation role "${role}" is required`, { path: `/animation/roles/${role}`, expected: '{ clipIndex, clipName }' }) };
      }
      if (!Number.isInteger(binding.clipIndex) || (binding.clipIndex as number) < 0) {
        return { ok: false, error: sessionError('field_value', 'validation', `animation.roles.${role}.clipIndex must be a non-negative integer`, { path: `/animation/roles/${role}/clipIndex` }) };
      }
      if (typeof binding.clipName !== 'string' || binding.clipName.length < 1 || binding.clipName.length > 128 || /[\u0000-\u001f\u007f]/.test(binding.clipName)) {
        return { ok: false, error: sessionError('field_value', 'validation', `animation.roles.${role}.clipName must be 1–128 chars without control characters`, { path: `/animation/roles/${role}/clipName` }) };
      }
    }
    if (anim.value.entityId !== undefined && (!isStringNoControl(anim.value.entityId) || anim.value.entityId.length === 0)) {
      return { ok: false, error: sessionError('field_type', 'validation', 'animation.entityId must be a non-empty string', { path: '/animation/entityId' }) };
    }
    animation = {
      ...(anim.value.entityId !== undefined ? { entityId: anim.value.entityId as string } : {}),
      roles: roles as unknown as AnimationRolesValue,
    };
  }
  return {
    ok: true,
    request: {
      ...(kind !== undefined ? { kind } : {}),
      ...(animation !== undefined ? { animation } : {}),
    },
  };
}

// ---- phase 10: assets referenced in place in a game folder -------------------

/**
 * The project-model `isValidSourcePath` rule, restated here because protocol
 * imports project-model types only: relative, forward slashes, 1–512 chars,
 * no empty/`.`/`..` segment, no backslash, colon or control character.
 */
function isValidSourcePath(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 1 || s.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\:]/.test(s)) return false;
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * `GET /content/project-files?dir=<path>`: one folder of the game folder. `dir`
 * is absent/empty for the game folder itself, else a path relative to it.
 */
export function parseProjectFilesQuery(
  params: ReadonlyMap<string, string>,
): { ok: true; dir: string } | { ok: false; error: SessionError } {
  for (const key of params.keys()) {
    if (key !== 'dir') {
      return { ok: false, error: sessionError('field_unexpected', 'validation', `unknown query parameter "${key.slice(0, 64)}"`, { path: `?${key.slice(0, 64)}`, expected: 'dir' }) };
    }
  }
  const dir = params.get('dir') ?? '';
  if (dir !== '' && !isValidSourcePath(dir)) {
    return { ok: false, error: sessionError('path_rejected', 'validation', 'dir must be a folder relative to the game folder (forward slashes, no "..")', { path: '/dir', found: params.get('dir')?.slice(0, 256) }) };
  }
  return { ok: true, dir };
}

export interface ProjectFileInspectRequest extends StageInspectRequest {
  /** The file, relative to the game folder. */
  path: string;
  displayName?: string;
}

/**
 * `POST /content/project-files/inspect` body: `{ path, displayName?, kind?,
 * animation? }` — the stage inspect body plus the file to inspect in place.
 */
export function parseProjectFileInspectRequest(
  value: unknown,
): { ok: true; request: ProjectFileInspectRequest } | { ok: false; error: SessionError } {
  if (!isPlainObject(value)) {
    return { ok: false, error: sessionError('field_type', 'validation', 'the body must be an object', { path: '', found: typeof value }) };
  }
  const { path, displayName, ...rest } = value;
  if (path === undefined) return { ok: false, error: sessionError('field_missing', 'validation', 'path is required', { path: '/path', expected: 'a file relative to the game folder' }) };
  if (!isValidSourcePath(path)) {
    return { ok: false, error: sessionError('path_rejected', 'validation', 'path must be a file relative to the game folder (forward slashes, no "..")', { path: '/path', found: String(path).slice(0, 256) }) };
  }
  if (displayName !== undefined && (!isStringNoControl(displayName) || displayName.length < 1 || displayName.length > 128)) {
    return { ok: false, error: sessionError('field_value', 'validation', 'displayName must be 1–128 characters without control characters', { path: '/displayName' }) };
  }
  const inspect = parseStageInspectRequest(rest);
  if (!inspect.ok) return inspect;
  return { ok: true, request: { ...inspect.request, path, ...(displayName !== undefined ? { displayName: displayName as string } : {}) } };
}

/** The relay id shape used by the §20 WS forwarding rows. */
export function isGameRelayId(v: unknown): v is string {
  return isRelayId(v);
}

// ---- the v2→v3 operator copy route body (workspace.md §16.5/§16.8) -------------

/** The safe, bounded error a relay surfaces when nothing can cross. */
export function gameRelayError(code: (typeof GAME_RELAY_ERROR_CODES)[number], message: string, extra?: Record<string, unknown>): SessionError {
  const cls =
    code === 'game_run_stale' || code === 'input_relay_conflict'
      ? 'conflict'
      : code === 'play_not_found'
        ? 'not_found'
        : code === 'game_relay_timeout' || code === 'session_unavailable' || code === 'play_locator_expired' || code === 'game_relay_rejected'
          ? 'unavailable'
          : 'validation';
  return sessionError(code, cls, message, extra);
}

/** True for a string that is a plausible (non-path, bounded) identifier. */
export function isSafeIdentifier(v: unknown): v is string {
  return isStringNoControl(v) && v.length >= 1 && v.length <= 128 && !v.includes('/') && !v.includes('\\');
}

/** Local re-export so consumers do not need a second import. */
export { checkOptionalObject };
