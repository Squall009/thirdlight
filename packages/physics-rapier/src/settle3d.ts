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
 * slopes and stairs. A character in the air pushing into a wall at its skin
 * is swept again from just past it (`offWallSweep`).
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsVec3 } from '@thirdlight/runtime';

import { REST_SETTLE_TOLERANCE, SKIN_LIFT_MARGIN } from './constants';

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

/**
 * How far up a capsule centred at `centre` moves to stand `SKIN_LIFT_MARGIN`
 * past its skin over the ground right under it (0: it stands farther off, or
 * nothing is under it). Rapier's sweep stops a character standing at or inside
 * its skin, within rounding, at every cast: its time of impact is 0 even
 * moving along the floor.
 */
export function skinLift(w: SettleWorld, capsule: RAPIER.Capsule, centre: PhysicsVec3, skin: number): number {
  return skinClear(w, capsule, centre, skin, DOWN);
}

/**
 * How far a capsule centred at `centre` moves against `toward` (a unit
 * direction) to stand `SKIN_LIFT_MARGIN` past its skin from what lies that way
 * (0: it stands farther off, or nothing is there). The same stop as
 * `skinLift`'s, against a wall: a falling character pushing into a wall at its
 * skin was held in the air (every cast's time of impact 0).
 */
export function skinClear(w: SettleWorld, capsule: RAPIER.Capsule, centre: PhysicsVec3, skin: number, toward: PhysicsVec3): number {
  const clear = skin + SKIN_LIFT_MARGIN;
  const hit = w.world.castShape(centre, IDENTITY, toward, capsule, 0, clear, false, undefined, undefined, undefined, undefined, w.sees);
  return hit === null ? 0 : Math.max(0, clear - hit.time_of_impact);
}

/**
 * A character in the air pushing into a wall at or inside its skin can have
 * every cast of Rapier's sweep stop at once, its fall or rise too (measured
 * beside a mover's side: held in the air for good, or a jump cut to a third,
 * 20 iterations). When the sweep (`swept`, from `before`) fell short of the
 * move's vertical part, the move without its part into the wall (which the
 * wall stops anyway) is swept again from just past the skin: the new
 * movement from `before` when it gets further up or down, else null. The
 * collider is back at `before` either way. `place` turns a centre into the
 * collider's translation; `wall` is the wall contact's outward normal.
 */
export function offWallSweep(w: SettleWorld, controller: RAPIER.KinematicCharacterController, collider: RAPIER.Collider, capsule: RAPIER.Capsule, before: PhysicsVec3, place: (centre: PhysicsVec3) => PhysicsVec3, commanded: PhysicsVec3, swept: PhysicsVec3, wall: PhysicsVec3, skin: number, filter: ((c: RAPIER.Collider) => boolean) | undefined): PhysicsVec3 | null {
  if (!(Math.abs(commanded.y) > 1e-9 && Math.abs(swept.y) < Math.abs(commanded.y) - 1e-7)) return null;
  const h = Math.hypot(wall.x, wall.z);
  const away = { x: wall.x / h, y: 0, z: wall.z / h };
  const into = Math.min(0, commanded.x * away.x + commanded.z * away.z);
  const along = { x: commanded.x - away.x * into, y: commanded.y, z: commanded.z - away.z * into };
  const back = skinClear(w, capsule, place(before), skin, { x: -away.x, y: 0, z: -away.z });
  const m = sweepFrom(controller, collider, place({ x: before.x + away.x * back, y: before.y, z: before.z + away.z * back }), place(before), along, filter, null);
  return Math.abs(m.y) > Math.abs(swept.y) ? { x: away.x * back + m.x, y: m.y, z: away.z * back + m.z } : null;
}

/**
 * The controller's sweep of `move` with the collider placed at `from` (a
 * translation), put back at `back` after; with `snap` (the snap distance)
 * without the ground snap for this sweep (a lifted character the snap would
 * pull back down).
 */
export function sweepFrom(controller: RAPIER.KinematicCharacterController, collider: RAPIER.Collider, from: PhysicsVec3, back: PhysicsVec3, move: PhysicsVec3, filter: ((c: RAPIER.Collider) => boolean) | undefined, snap: number | null): PhysicsVec3 {
  collider.setTranslation(from);
  if (snap !== null) controller.disableSnapToGround();
  controller.computeColliderMovement(collider, move, undefined, undefined, filter);
  if (snap !== null) controller.enableSnapToGround(snap);
  const m = controller.computedMovement();
  collider.setTranslation(back);
  return { x: m.x, y: m.y, z: m.z };
}
