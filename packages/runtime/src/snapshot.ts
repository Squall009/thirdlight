/**
 * Runtime snapshot validation — runtime.md §2 (normative).
 *
 * The runtime re-validates on receipt: the producer is not trusted (the
 * session layer and the exporter both construct snapshots). Strict shape
 * (unknown fields at the wrapper level ⇒ `snapshot_invalid`
 * `reason: "shape"` with the path), ID/revision rules, and a full
 * `validateScene` re-check (project-model §12.1) — failures carry ≤ 10
 * project-model error objects + the total count.
 */
import { resolveSceneHierarchy, validateScene, validateSceneV2, validateSceneV3, validateGameConfig, validateTagRegistry, type TagDefinition, type ModelError, type ModelErrorV2, type ModelErrorV3, type Scene, type SceneV2, type SceneV3, type GameConfig } from '@thirdlight/project-model';
import type { RuntimeError } from './errors';
import type { RuntimeScene, RuntimeSnapshot } from './types';

/** project-model §5.1 ID syntax (all IDs). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** runtime.md §2: `0 ≤ revision ≤ 2^53−1`. */
const MAX_REVISION = 2 ** 53 - 1;

const WRAPPER_FIELDS = new Set(['snapshotId', 'projectId', 'revision', 'scene', 'game', 'tags']);

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
      sceneVersion: 1 | 2 | 3;
      snapshotId: string;
      projectId: string;
      revision: number;
      game: GameConfig | null;
      tags: readonly TagDefinition[];
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
  // trusted. `schemaVersion` 1 uses `validateScene` (the accepted M1 entry
  // point), 2 uses `validateSceneV2`, 3 uses `validateSceneV3`. Validation
  // failures ⇒ snapshot_invalid carrying the project-model error objects
  // (≤ 10 reported, total count given).
  const rawScene = snap.scene as { schemaVersion?: unknown };
  const rawVersion: unknown = rawScene.schemaVersion;
  const sceneVersion: 1 | 2 | 3 = rawVersion === 3 ? 3 : rawVersion === 2 ? 2 : 1;
  // M3 (runtime.md §2): the `game` wrapper field is v3-only and required on
  // v3 snapshots; an absent-on-v3 or present-on-v1/v2 `game` is a strict-shape
  // violation. The value check (block rules) runs once the scene is known to
  // be v3, so v1/v2 scenes never see a `game`-carrying error path.
  const gamePresent = 'game' in snap;
  if (sceneVersion === 3 && !gamePresent) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/game',
        message: 'snapshot field "game" is required for a schemaVersion 3 snapshot (null is legal)',
      },
    };
  }
  if (sceneVersion !== 3 && gamePresent) {
    return {
      error: {
        code: 'snapshot_invalid',
        reason: 'shape',
        path: '/game',
        message: 'snapshot field "game" is v3-only (absent for schemaVersion 1/2 snapshots)',
      },
    };
  }
  const rawGame: GameConfig | null = snap.game === undefined ? null : (snap.game as GameConfig | null);
  let scene: RuntimeScene;
  if (sceneVersion === 3) {
    const sceneResult = validateSceneV3(snap.scene);
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
    scene = resolveSceneHierarchy(sceneResult.normalized);
    // The §23.4 game-block rules (project-model; references inside the block
    // are resolved by the cross-block check, never here). `null` is legal —
    // an M3-enabled module set rejects it at instantiate (`game_config`).
    if (rawGame !== null) {
      const gameErrors: ModelErrorV2[] = [];
      validateGameConfig(rawGame, '/game', gameErrors);
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
  } else if (sceneVersion === 2) {
    const sceneResult = validateSceneV2(snap.scene);
    if (!sceneResult.ok) {
      const errors: readonly ModelErrorV2[] = sceneResult.errors;
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
    scene = sceneResult.normalized;
  } else {
    const sceneResult = validateScene(snap.scene);
    if (!sceneResult.ok) {
      const errors: readonly ModelError[] = sceneResult.errors;
      return {
        error: {
          code: 'snapshot_invalid',
          reason: 'scene_validation',
          message: clipSceneMessage(errors),
          errors: errors.slice(0, 10), // runtime.md §2: ≤ 10 reported, total count given
          errorTotal: errors.length,
        },
      };
    }
    scene = sceneResult.normalized;
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
    if (sceneVersion !== 3) {
      return { error: { code: 'snapshot_invalid', reason: 'shape', path: '/tags', message: 'snapshot field "tags" is v3-only' } };
    }
    const tagErrors: ModelErrorV2[] = [];
    validateTagRegistry(snap.tags, '/tags', tagErrors);
    if (tagErrors.length > 0) {
      return { error: { code: 'snapshot_invalid', reason: 'scene_validation', message: clipSceneMessage(tagErrors), errors: tagErrors.slice(0, 10), errorTotal: tagErrors.length } };
    }
    tags = snap.tags as TagDefinition[];
  }
  return { scene, sceneVersion, snapshotId, projectId, revision, game: rawGame, tags };
}

function clipSceneMessage(errors: readonly (ModelError | ModelErrorV2 | ModelErrorV3)[]): string {
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
  if (scene === null || typeof scene !== 'object' || scene.schemaVersion !== 3 || !Array.isArray(scene.entities)) return snapshot;
  return { ...snapshot, scene: resolveSceneHierarchy(scene as unknown as SceneV3) };
}
