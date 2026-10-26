/**
 * A character at rest settles onto its skin. Rapier's controller reports a
 * falling character grounded once the floor is within its prediction, which
 * a fall step can end anywhere inside, and a grounded character standing
 * still is held where it is (measured: 0.9375 m for a capsule whose rest is
 * 0.93 m, skin 0.03; up to 3 cm with skin 0.05). A placed character rests at
 * the skin exactly; so does one that lands, from the step after its landing
 * (the side-view rule: its landing step ends where the fall did), whatever
 * the fall speed's phase. A moving character is kept on the ground by
 * Rapier's own snap; pulling it to the skin every step would fight that on
 * slopes and stairs.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsVec3 } from '@thirdlight/runtime';

import { REST_SETTLE_TOLERANCE } from './constants';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const DOWN = { x: 0, y: -1, z: 0 };

/** What the settle reads of a world: its colliders, which the character's sweep sees, and which are fixed. */
export interface SettleWorld {
  readonly world: RAPIER.World;
  sees(c: RAPIER.Collider): boolean;
  /** Fixed ground (on a mover, the carry places the character instead). */
  fixed(c: RAPIER.Collider): boolean;
}

/**
 * How far down a grounded capsule centred at `centre` moves to rest at its
 * skin over fixed ground (0: it rests there, or the ground under it is not
 * fixed, or is beyond `reach`).
 */
export function settleDrop(w: SettleWorld, capsule: RAPIER.Capsule, centre: PhysicsVec3, skin: number, reach: number): number {
  const hit = w.world.castShape(centre, IDENTITY, DOWN, capsule, skin, reach, false, undefined, undefined, undefined, undefined, w.sees);
  if (hit === null || !w.fixed(hit.collider)) return 0;
  return hit.time_of_impact > REST_SETTLE_TOLERANCE ? hit.time_of_impact : 0;
}
