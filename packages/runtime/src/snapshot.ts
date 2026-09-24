/**
 * Runtime snapshot validation — runtime.md §2 (normative).
 *
 * The runtime re-validates on receipt: the producer is not trusted (the
 * session layer and the exporter both construct snapshots). Strict shape
 * (unknown fields at the wrapper level ⇒ `snapshot_invalid`
 * `reason: "shape"` with the path), ID/revision rules, and a full
 * `validateSceneV3`/`validateMergedSceneV4` re-check (project-model §23) — failures carry ≤ 10
 * project-model error objects + the total count.
 */
import { resolveSceneHierarchy, validateMergedSceneV4, validateSceneV3, validateGameConfig, validateTagRegistry, validateAnimators, validatePrefabDefinitions, type AnimatorController, type PrefabDefinition, type TagDefinition, type ModelErrorV2, type ModelErrorV3, type SceneV3, type GameConfig } from '@thirdlight/project-model';
import type { RuntimeError } from './errors';
import type { ModelBounds, RuntimeSceneRow, RuntimeScene, RuntimeSnapshot } from './types';

/** project-model §5.1 ID syntax (all IDs). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** runtime.md §2: `0 ≤ revision ≤ 2^53−1`. */
const MAX_REVISION = 2 ** 53 - 1;

const WRAPPER_FIELDS = new Set(['snapshotId', 'projectId', 'revision', 'scene', 'game', 'tags', 'scenes', 'animators', 'prefabs', 'modelBounds']);
/** Phase 15.3: at most this many model bounds rows (one per model asset; the asset catalog's size). */
const MAX_MODEL_BOUNDS = 4096;
const SCENE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // the model's id syntax (ID_RE_V2)
const MAX_SNAPSHOT_SCENES = 64;

/**
 * Recursively freeze (idempotent). runtime.md §2: on successful
 * `instantiateRuntime`, the runtime deep-freezes the snapshot and never
 * writes to it.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const rec = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(rec)) {
    deepFreeze(rec[key]);
  }
  return value;
}

/**
 * Validate the runtime snapshot (runtime.md §2). Returns the normalized
 * scene on success. Never throws.
 *
 * M3 (runtime.md §2 `game` row): the `game` wrapper field is present iff
 * `scene.schemaVersion === 3` — required on a v3 snapshot (it may be `null`),
 * refused on v1/v2 (`reason: "shape"`). A non-null `game` value must pass the
 * project-model §23.4 block rules (`validateGameConfig`); a violation is
 * `snapshot_invalid` (`reason: "scene_validation"`) carrying the
 * project-model error objects.
 */
export function validateRuntimeSnapshot(
  input: unknown,
):
  | {
      scene: RuntimeScene;
      sceneVersion: 3 | 4;
      snapshotId: string;
      projectId: string;
      revision: number;
      game: GameConfig | null;
      tags: readonly TagDefinition[];
      scenes: readonly RuntimeSceneRow[] | null;
      animators: readonly AnimatorController[];
      prefabs: readonly PrefabDefinition[];
      modelBounds: Readonly<Record<string, ModelBounds>>;
    }
  | { error: RuntimeError } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '',
        message: 'runtime snapshot must be a JSON object',
      },
    };
  }
  const snap = input as Record<string, unknown>;

  // Strict wrapper shape: unknown fields at the wrapper level ⇒ shape error.
  for (const key of Object.keys(snap)) {
    if (!WRAPPER_FIELDS.has(key)) {
      return {
        error: {
          code: 'snapshot_invalid',
          reason: 'shape',
          path: `/${key}`,
          message: `unknown snapshot field "${key}" (strict shape)`,
        },
      };
    }
  }
  for (const key of ['snapshotId', 'projectId', 'revision', 'scene']) {
    if (!(key in snap)) {
      return {
        error: {
          code: 'snapshot_invalid',
          reason: 'shape',
          path: `/${key}`,
          message: `snapshot field "${key}" is missing`,
        },
      };
    }
  }
  const { snapshotId, projectId, revision } = snap as Pick<RuntimeSnapshot, 'snapshotId' | 'projectId' | 'revision'>;
  if (typeof snapshotId !== 'string') {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/snapshotId',
        message: 'snapshotId must be a string',
      },
    };
  }
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/projectId',
        message: 'projectId must match the project-model ID syntax (§5.1)',
      },
    };
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/revision',
        message: 'revision must be an integer in [0, 2^53-1]',
      },
    };
  }
  if (typeof snap.scene !== 'object' || snap.scene === null || Array.isArray(snap.scene)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/scene',
        message: 'scene must be a complete scene document',
      },
    };
  }

  // Re-validate the scene (project-model §12.1/§13/§23): the producer is not
  // trusted. Only schemaVersion 3 (`validateSceneV3`) and 4 (the merged start
  // scenes, `validateMergedSceneV4`) are playable; the v1/v2 scene schemas
  // were removed (phase 9.3). Validation failures ⇒ snapshot_invalid carrying
  // the project-model error objects (≤ 10 reported, total count given).
  const rawScene = snap.scene as { schemaVersion?: unknown };
  const rawVersion: unknown = rawScene.schemaVersion;
  if (rawVersion !== 3 && rawVersion !== 4) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/scene/schemaVersion',
        message: 'the snapshot scene must be schemaVersion 3 or 4',
      },
    };
  }
  const sceneVersion: 3 | 4 = rawVersion;
  // M3 (runtime.md §2): the `game` wrapper field is required (null is legal).
  if (!('game' in snap)) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/game',
        message: 'snapshot field "game" is required for a schemaVersion 3 snapshot (null is legal)',
      },
    };
  }
  const rawGame: GameConfig | null = snap.game === undefined ? null : (snap.game as GameConfig | null);
  // v4: the start scenes merged into one runtime scene (no per-scene limits).
  const sceneResult = sceneVersion === 4 ? validateMergedSceneV4(snap.scene) : validateSceneV3(snap.scene);
  if (!sceneResult.ok) {
    const errors: readonly ModelErrorV3[] = sceneResult.errors;
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'scene_validation',
        message: clipSceneMessage(errors),
        errors: errors.slice(0, 10),
        errorTotal: errors.length,
      },
    };
  }
  // Phase 12: the game never sees folders or inactive entities (resolved
  // once here, at scene load).
  const scene: RuntimeScene = resolveSceneHierarchy(sceneResult.normalized);
  // The §23.4 game-block rules (project-model; references inside the block
  // are resolved by the cross-block check, never here). `null` is legal —
  // an M3-enabled module set rejects it at instantiate (`game_config`).
  if (rawGame !== null) {
    const gameErrors: ModelErrorV2[] = [];
    validateGameConfig(rawGame, '/game', gameErrors, sceneVersion === 4 ? 2 : 1);
    if (gameErrors.length > 0) {
      return {
        error: {
          code: 'snapshot_invalid',
          reason: 'scene_validation',
          message: clipSceneMessage(gameErrors),
          errors: gameErrors.slice(0, 10),
          errorTotal: gameErrors.length,
        },
      };
    }
  }
  if (scene.revision !== revision) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'revision_mismatch',
        message: `snapshot revision ${revision} != scene.revision ${scene.revision}`,
      },
    };
  }
  const expectedId = `${projectId}@r${revision}`;
  if (snapshotId !== expectedId) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'id_mismatch',
        message: `snapshotId "${snapshotId}" != "<projectId>@r<revision>" ("${expectedId}")`,
      },
    };
  }
  // Phase 12 (b): the optional v3 tag registry.
  let tags: readonly TagDefinition[] = [];
  if (snap.tags !== undefined) {
    const tagErrors: ModelErrorV2[] = [];
    validateTagRegistry(snap.tags, '/tags', tagErrors);
    if (tagErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(tagErrors), errors: tagErrors.slice(0, 10), errorTotal: tagErrors.length } };
    }
    tags = snap.tags as TagDefinition[];
  }
  // Phase 9.7: the optional v4 animator controllers.
  let animators: readonly AnimatorController[] = [];
  if (snap.animators !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/animators', message: 'snapshot field "animators" is v4-only' } };
    const animatorErrors: ModelErrorV2[] = [];
    validateAnimators(snap.animators, '/animators', animatorErrors);
    if (animatorErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(animatorErrors), errors: animatorErrors.slice(0, 10), errorTotal: animatorErrors.length } };
    }
    animators = snap.animators as AnimatorController[];
  }
  // Phase 14.1: the optional v4 prefab definitions (`ctx.spawn`).
  let prefabs: readonly PrefabDefinition[] = [];
  if (snap.prefabs !== undefined) {
    if (sceneVersion !== 4) return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/prefabs', message: 'snapshot field "prefabs" is v4-only' } };
    const prefabErrors: ModelErrorV2[] = [];
    validatePrefabDefinitions(snap.prefabs, '/prefabs', prefabErrors, 4);
    if (prefabErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(prefabErrors), errors: prefabErrors.slice(0, 10), errorTotal: prefabErrors.length } };
    }
    prefabs = snap.prefabs as PrefabDefinition[];
  }
  // Phase 15.3: the optional v4 model bounds (assetId -> the model's recorded bounds).
  let modelBounds: Readonly<Record<string, ModelBounds>> = {};
  if (snap.modelBounds !== undefined) {
    const bad = (message: string): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path: '/modelBounds', message } });
    if (sceneVersion !== 4) return bad('snapshot field "modelBounds" is v4-only');
    const mb = snap.modelBounds as unknown;
    if (typeof mb !== 'object' || mb === null || Array.isArray(mb) || Object.keys(mb).length > MAX_MODEL_BOUNDS) return bad(`modelBounds must be an object of at most ${MAX_MODEL_BOUNDS} rows`);
    const vec = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    for (const [k, v] of Object.entries(mb as Record<string, unknown>)) {
      const b = v as { min?: unknown; max?: unknown } | null;
      if (typeof b !== 'object' || b === null || !vec(b.min) || !vec(b.max)) return bad(`modelBounds["${k}"] must be { min: [x, y, z], max: [x, y, z] }`);
    }
    modelBounds = mb as Record<string, ModelBounds>;
  }
  // Phase 12 (c): the optional v4 scene catalog.
  let scenes: readonly RuntimeSceneRow[] | null = null;
  if (snap.scenes !== undefined) {
    const bad = (message: string, path = '/scenes'): { error: RuntimeError } => ({ error: { code: 'snapshot_invalid', reason: 'shape', path, message } });
    if (sceneVersion !== 4) return bad('snapshot field "scenes" is v4-only');
    if (!Array.isArray(snap.scenes) || snap.scenes.length < 1 || snap.scenes.length > MAX_SNAPSHOT_SCENES) {
      return bad(`snapshot field "scenes" must be an array of 1..${MAX_SNAPSHOT_SCENES} scene rows`);
    }
    const seen = new Set<string>();
    const members = new Set<string>();
    let starts = 0;
    for (let i = 0; i < snap.scenes.length; i += 1) {
      const row = snap.scenes[i] as Record<string, unknown>;
      const path = `/scenes/${i}`;
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return bad('a scene row must be an object', path);
      for (const k of Object.keys(row)) if (k !== 'sceneId' && k !== 'start' && k !== 'entityIds') return bad(`unknown scene row field "${k}"`, path);
      if (typeof row['sceneId'] !== 'string' || !SCENE_ID_RE.test(row['sceneId'])) return bad('sceneId must be a scene id', `${path}/sceneId`);
      if (seen.has(row['sceneId'])) return bad(`duplicate scene "${row['sceneId']}"`, `${path}/sceneId`);
      seen.add(row['sceneId']);
      if (typeof row['start'] !== 'boolean') return bad('start must be a boolean', `${path}/start`);
      if (row['start']) starts += 1;
      if (row['entityIds'] !== undefined) {
        if (!row['start']) return bad('only a start scene lists entityIds', `${path}/entityIds`);
        if (!Array.isArray(row['entityIds']) || !row['entityIds'].every((x) => typeof x === 'string')) return bad('entityIds must be an array of entity ids', `${path}/entityIds`);
        for (const id of row['entityIds'] as string[]) {
          if (members.has(id)) return bad(`entity "${id}" is listed in two scenes`, `${path}/entityIds`);
          members.add(id);
        }
      }
    }
    if (starts === 0) return bad('at least one scene must be a start scene');
    scenes = snap.scenes as RuntimeSceneRow[];
  }
  return { scene, sceneVersion, snapshotId, projectId, revision, game: rawGame, tags, scenes, animators, prefabs, modelBounds };
}

function clipSceneMessage(errors: readonly (ModelErrorV2 | ModelErrorV3)[]): string {
  const first = errors[0];
  const firstPart = first ? `; first: ${first.code} at ${first.path}` : '';
  const msg = `scene validation failed: ${errors.length} error(s)${firstPart}`;
  return msg.length > 256 ? `${msg.slice(0, 255)}…` : msg;
}
/**
 * Phase 12: the snapshot as the game loads it — for a v3 scene, folders and
 * inactive entities removed and effective flags applied
 * (`resolveSceneHierarchy`). Hosts call this once, right after the snapshot
 * arrives, so the renderer, physics and runtime all see the same entities.
 * Other scene versions are returned unchanged. Idempotent.
 */
export function resolveSnapshotHierarchy<T extends { scene: unknown }>(snapshot: T): T {
  const scene = snapshot.scene as { schemaVersion?: unknown; entities?: unknown };
  if (scene === null || typeof scene !== 'object' || (scene.schemaVersion !== 3 && scene.schemaVersion !== 4) || !Array.isArray(scene.entities)) return snapshot;
  return { ...snapshot, scene: resolveSceneHierarchy(scene as unknown as SceneV3) };
}
