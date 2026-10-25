/**
 * The 3D character's penetration counter counts real depenetration only: a
 * step that begins with the capsule inside a collider. Standing and walking
 * on the floor (one step of gravity swept into it every step, as the runtime
 * commands) counts nothing; the deepest overlap names its collider — real
 * rapier3d-compat WASM.
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D, type RapierPhysicsPort3D } from './index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const config = (statics: StaticColliderSpec3D[], start: [number, number, number]): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: start[0], y: start[1], z: start[2] }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
  statics,
  solver: { hz: HZ, gravityY: G },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
});
const box = (entityId: string, half: [number, number, number], at: [number, number, number]): StaticColliderSpec3D => ({
  entityId,
  shape: { type: 'box', hx: half[0], hy: half[1], hz: half[2] },
  position: { x: at[0], y: at[1], z: at[2] },
  rotation: IDENTITY,
});

async function portOf(cfg: PhysicsInitConfig3D): Promise<RapierPhysicsPort3D> {
  const made = await createPhysicsPort3D(cfg);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

/** The runtime's staging: one step of gravity even while grounded (the floor stops it), and a walk across. */
function walk(port: PhysicsPort3D, steps: number, across: number): void {
  let v = 0;
  for (let i = 0; i < steps; i += 1) {
    v = Math.max(-30, v + G / HZ);
    port.stageCharacterMove({ x: across / HZ, y: v / HZ, z: 0 });
    const r = port.step();
    if (r.grounded) v = 0;
  }
}

describe('the 3D character\'s penetration counter', () => {
  it('stays at zero while the character stands and walks on the floor', async () => {
    const port = await portOf(config([box('floor', [20, 0.5, 20], [0, -0.5, 0])], [0, 0.95, 0]));
    walk(port, 120, 0);
    walk(port, 240, 3);
    const d = port.diagnostics();
    expect(d.steps).toBe(360);
    expect(d.penetrationCorrectedCount).toBe(0);
    expect(d.deepestOverlap).toBeUndefined();
    port.dispose();
  });

  it('counts a step begun inside a collider and names the deepest overlap', async () => {
    const port = await portOf(config([box('floor', [20, 0.5, 20], [0, -0.5, 0]), box('crate', [0.5, 0.5, 0.5], [3, 0.5, 0])], [0, 0.95, 0]));
    walk(port, 30, 0);
    // Put the character half into the crate (as a script's place or a spawn would).
    port.placeCharacter({ x: 2.6, y: 0.95, z: 0 });
    walk(port, 30, 0);
    const d = port.diagnostics();
    expect(d.penetrationCorrectedCount).toBeGreaterThan(0);
    expect(d.deepestOverlap?.entityId).toBe('crate');
    expect(d.deepestOverlap!.depth).toBeGreaterThan(0.1);
    expect(d.deepestOverlap!.step).toBe(30);
    port.dispose();
  });
});
