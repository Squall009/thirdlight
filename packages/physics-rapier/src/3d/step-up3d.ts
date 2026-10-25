/**
 * Stepping a 3D character up a step, the two ways the port does it: its own
 * probe of whether it can stand on what it walks into (and how high that
 * is), which lifts it onto the step at once, and the 2D controller's rule
 * built on the same probe, which rides it up over the step's edge.
 */
import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsInitConfig3D, PhysicsVec3 } from '@thirdlight/runtime';

import { GROUND_NORMAL_TOLERANCE } from '../constants';

/** What stepping reads of a character: its capsule, its own Rapier controller, its tuning, radius and centre offset. */
export interface StepBody {
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  readonly tuning: PhysicsInitConfig3D['controller'];
  readonly shape: { readonly radius: number; readonly offset: PhysicsVec3 };
}

/**
 * The step-up sweeps of a world: `at` places a character's centre at its
 * origin plus offset, `filter` is the sweeps' collider filter now (it changes
 * with the characters a world holds), `walkableFloorUnder` whether the floor
 * straight under a point is walkable.
 */
export function createStepUp<B extends StepBody>(deps: {
  at: (b: B, p: PhysicsVec3) => PhysicsVec3;
  filter: () => ((c: RAPIER.Collider) => boolean) | undefined;
  walkableFloorUnder: (b: B, p: PhysicsVec3) => boolean;
}): { stepProbe: (b: B, from: PhysicsVec3, dx: number, dz: number) => number | null; rideStep: (b: B, before: PhysicsVec3, commanded: PhysicsVec3, first: PhysicsVec3) => PhysicsVec3 | null } {
  const { at, filter, walkableFloorUnder } = deps;
  /**
   * Whether the character at `from`, pushing along the unit
   * horizontal direction (dx, dz), can step up — three sweeps without the
   * snap: up by the step height (plus two skins), across by its radius (plus
   * two skins, so its centre would be over what is there), down onto it. The
   * rise when it lands grounded on walkable ground higher than it stands and
   * at most the step height (plus a skin) up, else null (a taller block or a
   * wall keeps the across sweep blocked; a ceiling stops the lift). The
   * capsule is back at `from` afterwards.
   */
  const stepProbe = (b: B, from: PhysicsVec3, dx: number, dz: number): number | null => {
    const { controller, collider: characterCollider } = b;
    const skin = b.tuning.offsetSkin;
    const stepLift = b.tuning.autostep ? (b.tuning.autostepHeight ?? 0.25) : 0;
    const lift = stepLift + 2 * skin;
    const reach = b.shape.radius + 2 * skin;
    controller.disableSnapToGround();
    try {
      characterCollider.setTranslation(at(b, from));
      controller.computeColliderMovement(characterCollider, { x: 0, y: lift, z: 0 }, undefined, undefined, filter());
      const up = controller.computedMovement().y;
      if (!(up > 1e-3)) return null;
      const p1 = { x: from.x, y: from.y + up, z: from.z };
      characterCollider.setTranslation(at(b, p1));
      controller.computeColliderMovement(characterCollider, { x: dx * reach, y: 0, z: dz * reach }, undefined, undefined, filter());
      const across = controller.computedMovement();
      if (Math.hypot(across.x, across.z) < reach * 0.9) return null;
      const p2 = { x: p1.x + across.x, y: p1.y + across.y, z: p1.z + across.z };
      characterCollider.setTranslation(at(b, p2));
      controller.computeColliderMovement(characterCollider, { x: 0, y: -(up + skin), z: 0 }, undefined, undefined, filter());
      const drop = controller.computedMovement();
      if (!controller.computedGrounded()) return null;
      const p3 = { x: p2.x + drop.x, y: p2.y + drop.y, z: p2.z + drop.z };
      const rise = p3.y - from.y;
      if (!(rise > 1e-3) || rise > stepLift + skin + 1e-6) return null;
      return walkableFloorUnder(b, p3) ? rise : null;
    } finally {
      characterCollider.setTranslation(at(b, from));
      controller.enableSnapToGround(b.tuning.groundSnap);
    }
  };
  /**
   * The 2D controller's autostep (`autostepRide`), Rapier's stair rule with
   * the port's probe: a grounded character whose sweep met a wall-like
   * contact with some of its move left over, where it could stand on the
   * step, is lifted from where the sweep stopped to touch the step's top,
   * moved on by up to its radius, and the rest of the move (the lift taken
   * back down included) is swept from there — which drops it back onto the
   * edge, so a capsule rides up over a riser across several steps, losing
   * speed, as in the 2D port. `first`: the sweep's movement. The result for
   * the whole move, or null (no step there). The capsule is back at `before`
   * afterwards.
   */
  const rideStep = (b: B, before: PhysicsVec3, commanded: PhysicsVec3, first: PhysicsVec3): PhysicsVec3 | null => {
    const { controller, collider: characterCollider } = b;
    const climbCos = Math.cos(b.tuning.maxSlopeClimbRad);
    let wallHit = false;
    for (let i = 0; i < controller.numComputedCollisions(); i += 1) {
      const n = controller.computedCollision(i)?.normal1;
      const len = n !== undefined ? Math.hypot(n.x, n.y, n.z) : 0;
      // (A wall's normal carries an f32 rounding of up to about 1e-5 below level (measured); a ceiling's points well down.)
      if (n !== undefined && len > 0 && n.y / len > -1e-3 && n.y / len < climbCos - GROUND_NORMAL_TOLERANCE) wallHit = true;
    }
    if (!wallHit) return null;
    const across = Math.hypot(commanded.x, commanded.z);
    const dx = commanded.x / across;
    const dz = commanded.z / across;
    // Rapier steps where the sweep met the wall, before any snap to the ground: the sweep again without
    // it, unless the sweep moved it exactly as asked up and down (no snap moved it, as on flat ground).
    let swept = first;
    if (Math.abs(first.y - commanded.y) > 1e-9) {
      controller.disableSnapToGround();
      controller.computeColliderMovement(characterCollider, commanded, undefined, undefined, filter());
      controller.enableSnapToGround(b.tuning.groundSnap);
      const m = controller.computedMovement();
      swept = { x: m.x, y: m.y, z: m.z };
    }
    const rest = across - Math.max(0, swept.x * dx + swept.z * dz);
    if (!(rest > 1e-6)) return null;
    const skin = b.tuning.offsetSkin;
    const hitAt = { x: before.x + swept.x, y: before.y + swept.y, z: before.z + swept.z };
    const rise = stepProbe(b, hitAt, dx, dz);
    if (rise === null) return null;
    // The probe's rise keeps the skin under it; Rapier's lift ends touching the top.
    const lift = Math.max(0, rise - skin);
    const nudge = Math.min(rest, b.shape.radius + skin);
    const remaining = { x: dx * (rest - nudge), y: -lift, z: dz * (rest - nudge) };
    const total = (): PhysicsVec3 => {
      const on = controller.computedMovement();
      return { x: swept.x + dx * nudge + on.x, y: swept.y + lift + on.y, z: swept.z + dz * nudge + on.z };
    };
    try {
      characterCollider.setTranslation(at(b, { x: hitAt.x + dx * nudge, y: hitAt.y + lift, z: hitAt.z + dz * nudge }));
      // Rapier snaps a move to the ground only when the whole move does not rise: a ride up the edge is not pulled back down.
      controller.disableSnapToGround();
      controller.computeColliderMovement(characterCollider, remaining, undefined, undefined, filter());
      controller.enableSnapToGround(b.tuning.groundSnap);
      const unsnapped = total();
      if (unsnapped.y > 1e-5) return unsnapped;
      controller.computeColliderMovement(characterCollider, remaining, undefined, undefined, filter());
      return total();
    } finally {
      controller.enableSnapToGround(b.tuning.groundSnap);
      characterCollider.setTranslation(at(b, before));
    }
  };
  return { stepProbe, rideStep };
}
