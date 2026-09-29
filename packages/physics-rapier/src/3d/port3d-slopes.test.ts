/**
 * A collider's own slope limit (a block layer's maxSlope) on the Rapier 3D
 * port (real WASM): a character whose own limit is 45° walks up a 25° and a
 * 38° triangle-mesh ramp; with the ramp's collider limited to 30° it still
 * walks up the 25° ramp but stops at the foot of the 38° one; the same walk
 * without a limit is unchanged by the feature (the same positions step by
 * step as a collider list without the field).
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** A floor for x < 0 and a ramp rising at `deg` from x = 0 to x = 6, 4 m wide (z −2..2). */
function ramp(deg: number, maxSlope?: number): StaticColliderSpec3D {
  const h = 6 * Math.tan((deg * Math.PI) / 180);
  const vertices = [-6, 0, -2, 0, 0, -2, 0, 0, 2, -6, 0, 2, 6, h, -2, 6, h, 2];
  const indices = [0, 2, 1, 0, 3, 2, 1, 5, 4, 1, 2, 5];
  return { entityId: 'ground', shape: { type: 'mesh', vertices, indices }, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY, ...(maxSlope !== undefined ? { maxSlope: (maxSlope * Math.PI) / 180 } : {}) };
}

const config = (statics: StaticColliderSpec3D[]): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: -3, y: 0.95, z: 0 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
  statics,
  solver: { hz: HZ, gravityY: G },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
});

/** Walk toward +x at 3 m/s under gravity for `steps` steps; the positions. */
async function walk(statics: StaticColliderSpec3D[], steps: number): Promise<{ x: number; y: number }[]> {
  const made = await createPhysicsPort3D(config(statics));
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const port: PhysicsPort3D = made.port;
  let v = 0;
  let grounded = false;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < steps; i += 1) {
    v = grounded ? 0 : Math.max(-30, v + G / HZ);
    port.stageCharacterMove({ x: 3 / HZ, y: v / HZ, z: 0 });
    const r = port.step();
    grounded = r.grounded;
    out.push({ x: r.position.x, y: r.position.y });
  }
  port.dispose();
  return out;
}

describe('a collider slope limit (block layer maxSlope)', () => {
  it('45° character: climbs 25° and 38°; with the ramp limited to 30° it climbs 25° but not 38°', async () => {
    const steps = 4 * HZ;
    const gentle = await walk([ramp(25)], steps);
    const steep = await walk([ramp(38)], steps);
    const gentleLimited = await walk([ramp(25, 30)], steps);
    const steepLimited = await walk([ramp(38, 30)], steps);
    // 4 s at 3 m/s from x = −3: well up both ramps without a limit.
    expect(gentle.at(-1)!.x).toBeGreaterThan(3);
    expect(steep.at(-1)!.x).toBeGreaterThan(2);
    expect(steep.at(-1)!.y).toBeGreaterThan(2);
    expect(gentleLimited.at(-1)!.x).toBeGreaterThan(3);
    // Limited to 30°, the 38° ramp is a wall: the character stays at its foot.
    expect(steepLimited.at(-1)!.x).toBeLessThan(0.3);
    expect(steepLimited.at(-1)!.y).toBeLessThan(1.3);
    // The limit changes nothing where it is not stricter (25° ramp, 30° limit: the same walk).
    expect(gentleLimited).toEqual(gentle);
  });

  it('a limit looser than the character\'s own changes nothing (the character\'s 45° still applies)', async () => {
    const steps = 3 * HZ;
    expect(await walk([ramp(38, 60)], steps)).toEqual(await walk([ramp(38)], steps));
    const tooSteep = await walk([ramp(50, 60)], steps);
    expect(tooSteep.at(-1)!.x).toBeLessThan(0.3);
  });

  it('refuses a limit outside (0, 90°)', async () => {
    const made = await createPhysicsPort3D(config([{ ...ramp(20), maxSlope: Math.PI / 2 }]));
    expect(made.ok).toBe(false);
  });
});
