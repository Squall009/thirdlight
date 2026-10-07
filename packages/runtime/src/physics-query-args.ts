/**
 * The arguments of the scripts' physics queries (`ctx.physics` rays,
 * overlaps and picks, 2D and 3D) checked and normalized, and the query
 * budget. A bad argument is a script error naming what it should be.
 */
import type { PhysicsQuat } from './ports';

/**
 * At most this many physics queries (rays, overlaps, picks; 2D and 3D) a
 * step, for every script together: a runtime budget. A game's agents each
 * test line of sight and probe around them every step; 1,024 rays cost
 * Rapier about 1.6 ms in a scene of 16,384 colliders (measured). Beyond it a
 * query finds nothing (warned once in 3D).
 */
export const PHYSICS_QUERY_LIMIT = 1024;

/** A query's [x, y, z] (a script error when it is not three finite numbers). */
export function queryVec3(v: unknown, what: string): [number, number, number] {
  if (!Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${what} is [x, y, z] (finite numbers)`);
  return [v[0] as number, v[1] as number, v[2] as number];
}

/** A query's optional rotation quaternion [x, y, z, w] (normalized; absent: none). */
export function queryQuat(v: unknown, what: string): PhysicsQuat | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${what} is a quaternion [x, y, z, w]`);
  const len = Math.hypot(v[0] as number, v[1] as number, v[2] as number, v[3] as number);
  if (!(len > 1e-9)) throw new Error(`${what} is a quaternion [x, y, z, w] of non-zero length`);
  return { x: (v[0] as number) / len, y: (v[1] as number) / len, z: (v[2] as number) / len, w: (v[3] as number) / len };
}

export function queryPositive(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${what} is a positive number (m)`);
  return v;
}

/**
 * The entity a physics collider belongs to — a block layer's
 * chunk collider (`<layer>#blocks:<chunk>:<piece>`) is its layer, a
 * terrain's tile collider (`<terrain>#terrain:<tile>:<piece>`) its terrain.
 */
export function colliderEntityOf(colliderId: string): string {
  const i = colliderId.indexOf('#blocks:');
  if (i > 0) return colliderId.slice(0, i);
  const t = colliderId.indexOf('#terrain:');
  return t > 0 ? colliderId.slice(0, t) : colliderId;
}

/** A query's reach (absent: `fallback`; at most 10 km). */
export function queryDistance(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${what} maxDistance is a positive number (m)`);
  return Math.min(v, 10_000);
}
