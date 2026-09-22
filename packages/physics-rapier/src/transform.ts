/**
 * Physics-transform validation — project-model §21.2 for the facts the port
 * input can carry.
 *
 * The accepted contract refuses an unsupported authored transform as a
 * **validation error, never by silently flattening geometry**: a parented
 * collider (the solver re-syncs it toward its body and the parentless
 * `computeColliderMovement` loop breaks), a non-unit scale, an off-Z rotation,
 * and any non-identity rotation on the `controller` entity (`upright`) are
 * errors.
 *
 * project-model enforces these rules over the whole document. This module is
 * the adapter's second gate: when the host supplies the authored transform
 * facts (`parentId`/`scale`/`rotation` on `RapierStaticColliderSpec`) they are
 * checked here too, and the adapter additionally refuses any non-finite
 * position/rotation it could only mis-represent. An absent optional field
 * means "already validated upstream"; it is never guessed.
 */
import { OFF_AXIS_TOLERANCE, UNIT_SCALE } from './constants';
import type {
  PhysicsTransformReason,
  RapierStaticColliderSpec,
} from './types';

export type TransformValidation =
  | { ok: true }
  | { ok: false; reason: PhysicsTransformReason | 'invalid_transform'; detail: string };

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isIdentityQuaternion(q: readonly [number, number, number, number]): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && Math.abs(q[3]) === 1;
}

/** Validate one static collider's authored transform (physics.md §4). */
export function validateStaticTransform(
  spec: RapierStaticColliderSpec,
  label: string,
): TransformValidation {
  if (!finite(spec.position?.x) || !finite(spec.position?.y)) {
    return {
      ok: false,
      reason: 'invalid_transform',
      detail: `${label}: position must be finite { x, y }`,
    };
  }
  if (!finite(spec.rotationZ)) {
    return {
      ok: false,
      reason: 'invalid_transform',
      detail: `${label}: rotationZ must be a finite number of radians about Z`,
    };
  }
  if (spec.parentId !== undefined && spec.parentId !== null) {
    return {
      ok: false,
      reason: 'parented',
      detail:
        `${label}: a physics-bearing entity must be a root — a parented collider is ` +
        're-synced toward its body by the solver and breaks the parentless character loop',
    };
  }
  if (spec.scale !== undefined) {
    const s = spec.scale;
    if (
      s.length !== 3 ||
      s[0] !== UNIT_SCALE[0] ||
      s[1] !== UNIT_SCALE[1] ||
      s[2] !== UNIT_SCALE[2]
    ) {
      return {
        ok: false,
        reason: 'scale',
        detail:
          `${label}: physics geometry is authored in meters in the collider shape; ` +
          `scale must be exactly [1, 1, 1] (found [${s.join(', ')}]) — flattening it is forbidden`,
      };
    }
  }
  if (spec.rotation !== undefined) {
    const q = spec.rotation;
    if (q.length !== 4 || !q.every((v) => finite(v))) {
      return { ok: false, reason: 'invalid_transform', detail: `${label}: rotation must be four finite numbers` };
    }
    if (Math.abs(q[0]) > OFF_AXIS_TOLERANCE || Math.abs(q[1]) > OFF_AXIS_TOLERANCE) {
      return {
        ok: false,
        reason: 'rotation',
        detail: `${label}: rotation must be about Z only (|x|, |y| <= ${OFF_AXIS_TOLERANCE})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Validate the controller entity's authored transform: root, unit scale,
 * identity rotation (physics.md §4 rule 3: the capsule is never tilted).
 */
export function validateControllerTransform(authored: {
  x: number;
  y: number;
  parentId?: string | null;
  scale?: readonly [number, number, number];
  rotation?: readonly [number, number, number, number];
}): TransformValidation {
  if (!finite(authored.x) || !finite(authored.y)) {
    return {
      ok: false,
      reason: 'invalid_transform',
      detail: 'controller: character position must be finite { x, y }',
    };
  }
  if (authored.parentId !== undefined && authored.parentId !== null) {
    return {
      ok: false,
      reason: 'parented',
      detail: 'controller: the character must be a root (parentless collider pattern)',
    };
  }
  if (authored.scale !== undefined) {
    const s = authored.scale;
    if (s.length !== 3 || s[0] !== 1 || s[1] !== 1 || s[2] !== 1) {
      return { ok: false, reason: 'scale', detail: 'controller: the capsule is never scaled; scale must be [1, 1, 1]' };
    }
  }
  if (authored.rotation !== undefined) {
    const q = authored.rotation;
    if (!isIdentityQuaternion(q)) {
      return {
        ok: false,
        reason: 'upright',
        detail: 'controller: any non-identity authored rotation is a tilted capsule (upright rule)',
      };
    }
  }
  return { ok: true };
}
