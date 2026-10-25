/**
 * A body's plane lock: the `plane` field of the collider and controller
 * components. A locked body cannot move along the plane's normal and only
 * turns about it, which is how a side-scrolling stretch runs on the one 3D
 * physics backend. The normal is a world axis (X or Z): a plane at any other
 * angle needs a joint frame and is not offered.
 *
 * Absent or null: the body is free in all six degrees of freedom.
 */
import type { ModelErrorV2 } from './errors';
import { fieldMissing, fieldType, fieldValue, isPlainObject, MAX_LEN, pointerSegment, unexpectedField } from './validate';

/** The world axes a plane's normal may lie along (Y is "up", so a plane through it would be a floor). */
export const PLANE_AXES = ['x', 'z'] as const;
export type PlaneAxis = (typeof PLANE_AXES)[number];

/** A plane: its normal's world axis and where it lies along that axis (m). */
export interface PlaneLock {
  axis: PlaneAxis;
  origin: number;
}

const isAxis = (v: unknown): v is PlaneAxis => (PLANE_AXES as readonly unknown[]).includes(v);

/** Whether `v` is a plane lock (`{ axis: 'x' | 'z', origin }`, origin finite within the length bound). */
export function isPlaneLock(v: unknown): v is PlaneLock {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && isAxis(v['axis']) && typeof v['origin'] === 'number' && Number.isFinite(v['origin']) && Math.abs(v['origin']) <= MAX_LEN;
}

/** The `plane` field's errors (absent and null are "free"). */
export function validatePlaneLock(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined || v === null) return;
  if (!isPlainObject(v)) {
    errors.push(fieldType(path, v, "object { axis: 'x' | 'z', origin } or null"));
    return;
  }
  for (const k of Object.keys(v)) if (k !== 'axis' && k !== 'origin') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'axis, origin'));
  if (v['axis'] === undefined) errors.push(fieldMissing(`${path}/axis`, 'axis'));
  else if (!isAxis(v['axis'])) errors.push(fieldValue(`${path}/axis`, v['axis'], PLANE_AXES.join(' | '), "a plane's normal is the world X or Z axis"));
  const o = v['origin'];
  if (o === undefined) errors.push(fieldMissing(`${path}/origin`, 'origin'));
  else if (typeof o !== 'number' || !Number.isFinite(o) || Math.abs(o) > MAX_LEN) errors.push(fieldValue(`${path}/origin`, o, `a number within ±${MAX_LEN} (m)`, "a plane's origin is where it lies along its axis, in metres"));
}

/** A component's plane (null: free, also for a value that is not a plane). */
export function planeLockOf(component: unknown): PlaneLock | null {
  const v = isPlainObject(component) ? component['plane'] : undefined;
  return isPlaneLock(v) ? { axis: v.axis, origin: v.origin === 0 ? 0 : v.origin } : null;
}

/**
 * A plane's 2D coordinates in the world: x runs along the plane's right
 * (+X on a Z plane, −Z on an X plane: right of a camera on the normal's
 * positive side looking back), y is up, and the point lies on the plane.
 * The one mapping between a plane's 2D values and 3D.
 */
export function planePoint(plane: PlaneLock, x: number, y: number): [number, number, number] {
  return plane.axis === 'z' ? [x, y, plane.origin] : [plane.origin, y, x === 0 ? 0 : -x];
}

/** A 2D direction (or offset) on a plane in the world (no part along the normal). */
export function planeVector(plane: PlaneLock, x: number, y: number): [number, number, number] {
  return plane.axis === 'z' ? [x, y, 0] : [0, y, x === 0 ? 0 : -x];
}

/** A world vector's 2D parts on a plane (its part along the normal dropped). */
export function planeCoords(plane: PlaneLock, v: readonly [number, number, number] | readonly number[]): [number, number] {
  const z = v[2] ?? 0;
  return plane.axis === 'z' ? [v[0] ?? 0, v[1] ?? 0] : [z === 0 ? 0 : -z, v[1] ?? 0];
}
