/**
 * A ball swept through the world, with heightfields met a cell at a time.
 *
 * Rapier's shape cast against a heightfield (rapier3d-compat 0.20.0) walks
 * the field's cells from where the shape's box enters it and can stop too
 * early: a ball that crosses more than about two cells of a sloped field
 * before it touches lands late, or passes through, in 5–17 % of casts
 * (measured against the same triangles as a mesh and a brute-force sweep;
 * up to metres on steep ground). A cast straight down the field's axis, and
 * every cast that crosses at most one cell across it, is exact. Level
 * ground hides it: every cell has the height the first one has.
 *
 * So the ball is cast once against everything but heightfields, and against
 * the heightfields near its path in casts of at most one of their cells
 * across them, up to the first hit; stretches of the path no field's box
 * meets are skipped, so the cost follows the ground passed, not the length. Filters (groups, the excluded collider,
 * the predicate) are Rapier's own on every cast.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsVec3 } from '@thirdlight/runtime';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** The first collider a ball meets along a ray, and how far its centre moved. */
export interface BallHit {
  readonly collider: RAPIER.Collider;
  readonly distance: number;
}

function isField(c: RAPIER.Collider): boolean {
  return c.shapeType() === RAPIER.ShapeType.HeightField;
}

/** How far along `u` (a unit direction, world) the ball moves while crossing one of the field's cells, in its own frame. */
function cellStride(c: RAPIER.Collider, u: PhysicsVec3): number {
  const scale = c.heightfieldScale();
  const cols = c.heightfieldNCols();
  const rows = c.heightfieldNRows();
  if (scale === null || !(cols > 0) || !(rows > 0)) return Infinity;
  const cell = Math.min(scale.x / cols, scale.z / rows);
  // The direction in the field's frame: rotate by the conjugate of its rotation.
  const q = c.rotation();
  const tx = 2 * (-q.y * u.z + q.z * u.y);
  const ty = 2 * (-q.z * u.x + q.x * u.z);
  const tz = 2 * (-q.x * u.y + q.y * u.x);
  const lx = u.x + q.w * tx + (-q.y * tz + q.z * ty);
  const lz = u.z + q.w * tz + (-q.x * ty + q.y * tx);
  const across = Math.hypot(lx, lz);
  return across > 1e-9 ? cell / across : Infinity;
}

/**
 * Sweeps a ball of `radius` from `origin` along `u` (a unit direction) up to
 * `maxDistance`: the first collider it moves into (what it starts in does
 * not stop it), with the same filters as `world.castShape`.
 */
export function castBall(world: RAPIER.World, origin: PhysicsVec3, u: PhysicsVec3, radius: number, maxDistance: number, groups: number | undefined, exclude: RAPIER.Collider | undefined, predicate: ((c: RAPIER.Collider) => boolean) | undefined): BallHit | null {
  const ball = new RAPIER.Ball(radius);
  const keep = (c: RAPIER.Collider): boolean => predicate === undefined || predicate(c);
  const rest = world.castShape(origin, IDENTITY, u, ball, 0, maxDistance, false, undefined, groups, exclude, undefined, (c) => !isField(c) && keep(c));
  let best: BallHit | null = rest === null ? null : { collider: rest.collider, distance: rest.time_of_impact };
  const limit = best?.distance ?? maxDistance;
  const hit = castFields(world, origin, u, ball, radius, 0, limit, groups, exclude, keep);
  return hit !== null && hit.distance < limit ? hit : best;
}

/** A stretch of the cast at most this many cells of the finest field it meets is stepped; a longer one is halved. */
const LEAF_CELLS = 8;

/**
 * The first heightfield hit on the stretch [t0, t1) of the cast, met a cell
 * at a time. Only stretches whose swept box meets a field (the broad phase's
 * boxes, which hold the field's heights) are stepped, halving the cast until
 * a stretch is a few cells of the fields it meets, nearer half first; so a
 * long cast costs about the cells it passes near ground, not its length.
 */
function castFields(world: RAPIER.World, origin: PhysicsVec3, u: PhysicsVec3, ball: RAPIER.Ball, radius: number, t0: number, t1: number, groups: number | undefined, exclude: RAPIER.Collider | undefined, keep: (c: RAPIER.Collider) => boolean): BallHit | null {
  const len = t1 - t0;
  const mid = t0 + len * 0.5;
  const half = { x: Math.abs(u.x) * len * 0.5 + radius, y: Math.abs(u.y) * len * 0.5 + radius, z: Math.abs(u.z) * len * 0.5 + radius };
  const centre = { x: origin.x + u.x * mid, y: origin.y + u.y * mid, z: origin.z + u.z * mid };
  let stride = Infinity;
  let fields = 0;
  world.collidersWithAabbIntersectingAabb(centre, half, (c) => {
    if (isField(c) && c !== exclude && keep(c)) {
      fields++;
      stride = Math.min(stride, cellStride(c, u));
    }
    return true;
  });
  if (fields === 0) return null;
  if (len > LEAF_CELLS * stride) return castFields(world, origin, u, ball, radius, t0, mid, groups, exclude, keep) ?? castFields(world, origin, u, ball, radius, mid, t1, groups, exclude, keep);
  stride = Math.min(stride, len);
  for (let t = t0; t < t1; t += stride) {
    const at = { x: origin.x + u.x * t, y: origin.y + u.y * t, z: origin.z + u.z * t };
    const hit = world.castShape(at, IDENTITY, u, ball, 0, Math.min(stride, t1 - t), false, undefined, groups, exclude, undefined, (c) => isField(c) && keep(c));
    if (hit !== null) return { collider: hit.collider, distance: t + hit.time_of_impact };
  }
  return null;
}
