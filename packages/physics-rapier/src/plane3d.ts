/**
 * Plane locks on the 3D backend: a body locked to an axis-aligned plane
 * cannot move along the plane's normal and only turns about it.
 *
 * Rapier's per-body locked translations and rotations keep a dynamic body's
 * solver from moving it off the plane; the plane's depth is still held by a
 * position correction after each step, because a lock only removes the
 * axis from the solver: a body that was moved onto the plane by hand, or a
 * contact solved in f32, would otherwise keep what it drifted. Fixed and
 * kinematic bodies ignore the locks (nothing solves them), so their poses
 * are put on the plane instead (`planePose`), and a character's moves are
 * kept to it by its sweep.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import { planeTwist } from '@thirdlight/project-model/plane-lock';
import type { PhysicsPlane, PhysicsQuat, PhysicsVec3 } from '@thirdlight/runtime';

/** Whether `v` is a plane the port takes (an axis-aligned normal, a finite origin). */
export function isPlane(v: unknown): v is PhysicsPlane {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as { axis?: unknown; origin?: unknown };
  return (p.axis === 'x' || p.axis === 'z') && typeof p.origin === 'number' && Number.isFinite(p.origin);
}

/** A point on the plane: its coordinate along the normal set to the plane's. */
export function onPlane(p: PhysicsVec3, plane: PhysicsPlane): PhysicsVec3 {
  return plane.axis === 'x' ? { x: plane.origin, y: p.y, z: p.z } : { x: p.x, y: p.y, z: plane.origin };
}

/** A vector without its part along the plane's normal (a move or a velocity kept to the plane). */
export function inPlane(v: PhysicsVec3, plane: PhysicsPlane): PhysicsVec3 {
  return plane.axis === 'x' ? { x: 0, y: v.y, z: v.z } : { x: v.x, y: v.y, z: 0 };
}

/** A rotation reduced to its turn about the plane's normal (the project model's `planeTwist`). */
export function twistAbout(q: PhysicsQuat, plane: PhysicsPlane): PhysicsQuat {
  return planeTwist(q, plane.axis);
}

/** A pose on the plane: its position snapped, its rotation reduced to the turn about the normal. */
export function planePose(position: PhysicsVec3, rotation: PhysicsQuat, plane: PhysicsPlane): { position: PhysicsVec3; rotation: PhysicsQuat } {
  return { position: onPlane(position, plane), rotation: twistAbout(rotation, plane) };
}

/**
 * Lock a body to a plane (null: free it in all six degrees of freedom).
 * Locking snaps it onto the plane, turns it only about the normal, and keeps
 * of its velocity only what lies in the plane and its spin about the normal.
 */
export function lockBody(body: RAPIER.RigidBody, plane: PhysicsPlane | null): void {
  if (plane === null) {
    body.setEnabledTranslations(true, true, true, true);
    body.setEnabledRotations(true, true, true, true);
    return;
  }
  const x = plane.axis === 'x';
  body.setEnabledTranslations(!x, true, x, true);
  body.setEnabledRotations(x, false, !x, true);
  const t = body.translation();
  const r = body.rotation();
  const pose = planePose({ x: t.x, y: t.y, z: t.z }, { x: r.x, y: r.y, z: r.z, w: r.w }, plane);
  body.setTranslation(pose.position, true);
  body.setRotation(pose.rotation, true);
  if (body.isDynamic()) {
    const v = body.linvel();
    body.setLinvel(inPlane({ x: v.x, y: v.y, z: v.z }, plane), true);
    const w = body.angvel();
    body.setAngvel(x ? { x: w.x, y: 0, z: 0 } : { x: 0, y: 0, z: w.z }, true);
  }
}

/**
 * The position correction after a step: a locked dynamic body back on its
 * plane, its velocity along the normal gone. Bodies already on it are left
 * untouched (no wake-up, no change in their f32 state).
 */
export function holdOnPlane(body: RAPIER.RigidBody, plane: PhysicsPlane): void {
  const t = body.translation();
  const off = plane.axis === 'x' ? t.x : t.z;
  if (off !== Math.fround(plane.origin)) body.setTranslation(onPlane({ x: t.x, y: t.y, z: t.z }, plane), false);
  const v = body.linvel();
  if ((plane.axis === 'x' ? v.x : v.z) !== 0) body.setLinvel(inPlane({ x: v.x, y: v.y, z: v.z }, plane), false);
}
