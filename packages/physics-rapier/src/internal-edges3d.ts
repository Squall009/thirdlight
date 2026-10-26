/**
 * Internal edges on the 3D port. Rapier grounds a character on any contact
 * within its ground prediction whose normal points up, collider by collider.
 * Where static colliders share a face (boxes stacked into a wall, tiles in a
 * row, two pieces of a block layer's chunk mesh) a collider's edge on that
 * shared face is not on the surface of their union, yet its contact normal
 * tilts up: a character sliding down a stacked wall is grounded at every
 * seam and hangs there. (Seams inside one triangle mesh are its own
 * internal-edge fix's; this is the rule between colliders.)
 *
 * A contact is internal when its point on collider A lies inside another
 * solid static collider B, or on B's surface with the contact normal outside
 * B's normal cone there (the point pushed out along the normal projects back
 * onto B somewhere else): the union's real surface near that point is B's,
 * and B's own contact speaks for it. Grounding is refused only when an
 * internal contact is found and no real one is, so a level without shared
 * faces moves exactly as before.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsVec3 } from '@thirdlight/runtime';

import { INTERNAL_EDGE_CONE_EPS, INTERNAL_EDGE_PREDICTION_SLACK, INTERNAL_EDGE_PROBE, INTERNAL_EDGE_TOUCH_EPS, GROUND_UP_EPS } from './constants';

/** What the rule reads of a world: its colliders, which the character's sweep sees, and which are solid statics (not one-way, not moving). */
export interface InternalEdgeWorld {
  readonly world: RAPIER.World;
  /** Seen by the character's sweep (not a character, not a one-way collider passed now). */
  sees(c: RAPIER.Collider): boolean;
  solidStatic(c: RAPIER.Collider): boolean;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The ground-like contacts (normal up, within the skin, the snap and a
 * slack) of a standing capsule centred at `centre`: 1 when one is real, −1
 * when all are internal (and there is one), 0 when there is none.
 * `realOrNone`: false when the caller only asks whether all are internal, so
 * 0 may stand for 1. An internal contact needs two solid statics near, and
 * with fewer the contacts are not read at all (the per-step check of a
 * character on one floor collider).
 */
export function groundContacts3D(w: InternalEdgeWorld, capsule: RAPIER.Capsule, centre: PhysicsVec3, tuning: { offsetSkin: number; groundSnap: number }, realOrNone = true): -1 | 0 | 1 {
  const prediction = tuning.offsetSkin + tuning.groundSnap + INTERNAL_EDGE_PREDICTION_SLACK;
  const near: RAPIER.Collider[] = [];
  const reach = capsule.radius + prediction + 0.01;
  let solids = 0;
  w.world.collidersWithAabbIntersectingAabb(centre, { x: reach, y: capsule.halfHeight + reach, z: reach }, (c) => {
    if (w.sees(c)) {
      near.push(c);
      if (!realOrNone && w.solidStatic(c)) solids += 1;
    }
    return true;
  });
  if (!realOrNone && solids < 2) return 0;
  let internal = false;
  for (const a of near) {
    const k = a.contactShape(capsule, centre, IDENTITY, prediction);
    if (k === null || k.distance > prediction) continue;
    const n = k.normal1;
    const len = Math.hypot(n.x, n.y, n.z);
    if (!(len > 0) || !(n.y / len > GROUND_UP_EPS)) continue;
    const u = { x: n.x / len, y: n.y / len, z: n.z / len };
    if (w.solidStatic(a) && isInternalPoint(w, near, a, k.point1, u)) internal = true;
    else return 1;
  }
  return internal ? -1 : 0;
}

/** Whether the contact point `p` on `a` with normal `n` is inside the union of the solid statics near it (see the module). */
function isInternalPoint(w: InternalEdgeWorld, near: readonly RAPIER.Collider[], a: RAPIER.Collider, p: PhysicsVec3, n: PhysicsVec3): boolean {
  const tol = Math.max(INTERNAL_EDGE_TOUCH_EPS, 4e-7 * Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)));
  for (const b of near) {
    if (b === a || !w.solidStatic(b)) continue;
    const touch = b.projectPoint(p, false);
    if (touch === null) continue;
    const off = Math.hypot(touch.point.x - p.x, touch.point.y - p.y, touch.point.z - p.z);
    // Buried inside B: overlapping colliders.
    if (touch.isInside && off > tol) return true;
    if (off > tol) continue;
    // On B's surface: is n in B's normal cone at p?
    const q = { x: p.x + n.x * INTERNAL_EDGE_PROBE, y: p.y + n.y * INTERNAL_EDGE_PROBE, z: p.z + n.z * INTERNAL_EDGE_PROBE };
    const back = b.projectPoint(q, true);
    if (back === null) continue;
    if (back.isInside) return true;
    if (Math.hypot(back.point.x - p.x, back.point.y - p.y, back.point.z - p.z) > INTERNAL_EDGE_CONE_EPS) return true;
  }
  return false;
}
