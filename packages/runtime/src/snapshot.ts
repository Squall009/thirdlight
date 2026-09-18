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
import { validateScene, type ModelError, type Scene } from '@thirdlight/project-model';
import type { RuntimeError } from './errors';
import type { RuntimeSnapshot } from './types';

/** project-model §5.1 ID syntax (all IDs). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** runtime.md §2: `0 ≤ revision ≤ 2^53−1`. */
const MAX_REVISION = 2 ** 53 - 1;

const WRAPPER_FIELDS = new Set(['snapshotId', 'projectId', 'revision', 'scene']);

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
 */
export function validateRuntimeSnapshot(
  input: unknown,
): { scene: Scene; snapshotId: string; projectId: string; revision: number } | { error: RuntimeError } {
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

  // Re-validate the scene (project-model §12.1): the producer is not
  // trusted. Validation failures ⇒ snapshot_invalid carrying the
  // project-model error objects (≤ 10 reported, total count given).
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
  const scene = sceneResult.normalized;
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
  return { scene, snapshotId, projectId, revision };
}

function clipSceneMessage(errors: readonly ModelError[]): string {
  const first = errors[0];
  const firstPart = first ? `; first: ${first.code} at ${first.path}` : '';
  const msg = `scene validation failed: ${errors.length} error(s)${firstPart}`;
  return msg.length > 256 ? `${msg.slice(0, 255)}…` : msg;
}