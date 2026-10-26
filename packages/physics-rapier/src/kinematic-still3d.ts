/**
 * Movers at rest for a character's sweep. Rapier's controller takes a
 * touched kinematic body's velocity into its sweep ("kinematic friction").
 * In 3D that fights the runtime's own carry: a character riding a mover
 * sideways (its move equal to the mover's) sticks in the mover's offset
 * margin and stalls (measured: 20 iterations, no motion, about one step in
 * three on a sliding lift). The runtime moves the character with what it
 * stands on (the carry), so that body is at rest for the sweep — made
 * velocity-based with zero velocity and turned back right after; its next
 * pose is set as always and the world step derives its velocity from it. So
 * is a mover rising or sinking past the character (a rising one's drag would
 * lift the character up the wall). A mover sliding across into the character
 * keeps its velocity: with it at rest, Rapier's sweep of the runtime's push
 * out of its way stopped at the ground contact after about 1 % (measured on
 * a standing character: the mover passed through it), where its drag moves
 * the character on ahead of it. Each stilled body gets its velocity back
 * after the sweep, so the next character's sweep sees the mover move as this
 * one did.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsVec3 } from '@thirdlight/runtime';

/** A body at rest for the current sweep, with the velocities it gets back after it. */
export interface StilledBody {
  body: RAPIER.RigidBody;
  linvel: PhysicsVec3;
  angvel: PhysicsVec3;
}

/**
 * Put to rest the movers of `colliders` that rise or sink, and the one
 * sliding across that the character stands on (`standsOn`, asked at most
 * once: what the carry moves it with), listing them in `out` (cleared first).
 */
export function stillMovers(colliders: Iterable<{ kinematic: boolean; body: RAPIER.RigidBody }>, standsOn: () => RAPIER.RigidBody | null, out: StilledBody[]): void {
  out.length = 0;
  let under: RAPIER.RigidBody | null | undefined;
  for (const info of colliders) {
    if (!info.kinematic) continue;
    const body = info.body;
    if (body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) continue;
    const v = body.linvel();
    if (Math.hypot(v.x, v.z) > Math.abs(v.y)) {
      under ??= standsOn();
      if (under !== body) continue;
    }
    const w = body.angvel();
    out.push({ body, linvel: { x: v.x, y: v.y, z: v.z }, angvel: { x: w.x, y: w.y, z: w.z } });
    body.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }
}

/** Give the stilled movers their velocities back. */
export function restoreMovers(stilled: readonly StilledBody[]): void {
  for (const s of stilled) {
    s.body.setLinvel(s.linvel, false);
    s.body.setAngvel(s.angvel, false);
    s.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
  }
}
