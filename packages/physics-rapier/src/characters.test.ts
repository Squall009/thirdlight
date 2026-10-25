/**
 * Several player characters in one world (local co-op), on the port (real
 * Rapier WASM). Each character sweeps its own staged move in the same step
 * and keeps its own grounding; characters never block each other (one walks
 * through the other) nor any query; placement, clearance and drop-through
 * name the character; a world with one character steps exactly as before.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult3D, PhysicsInitConfig3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './index';

const HZ = 120;
const DT = 1 / HZ;
const G = -19.62;
const RAD = (deg: number): number => (deg * Math.PI) / 180;
const CONTROLLER = { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false };

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const capsule3 = (x: number, y: number, z: number): PhysicsInitConfig3D['character'] => ({ position: { x, y, z }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } });

async function port3(extra: PhysicsInitConfig3D['characters']) {
  const made = await createPhysicsPort3D({
    dimension: 3,
    character: capsule3(-2, 2, 0),
    ...(extra !== undefined ? { characters: extra } : {}),
    statics: [{ entityId: 'floor', shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 }, position: { x: 0, y: -0.5, z: 0 }, rotation: IDENTITY }],
    solver: { hz: HZ, gravityY: G },
    controller: CONTROLLER,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

describe('several characters on the 3D port', () => {
  it('each sweeps its own move; they pass through each other; placement names the character', async () => {
    const p = await port3([{ ...capsule3(2, 2, 0), id: 'p2' }]);
    const vy: Record<string, number> = {};
    const last: Record<string, CharacterMoveResult3D> = {};
    const run = (moves: Record<string, [number, number]>, steps: number): void => {
      for (let i = 0; i < steps; i += 1) {
        for (const [id, [vx, vz]] of Object.entries(moves)) {
          vy[id] = last[id]?.grounded === true ? 0 : Math.max(-30, (vy[id] ?? 0) + G * DT);
          p.stageCharacterMove({ x: vx * DT, y: vy[id]! * DT, z: vz * DT }, id === '' ? undefined : id);
        }
        last[''] = p.step();
        last['p2'] = p.lastResultOf!('p2')!;
      }
    };
    run({ '': [0, 0], p2: [0, 0] }, 120);
    expect(last['']!.grounded && last['p2']!.grounded).toBe(true);
    // The first walks along +x through the second; the second walks along +z.
    run({ '': [2, 0], p2: [0, 1] }, 240);
    expect(last['']!.position.x).toBeCloseTo(2, 0);
    expect(last['p2']!.position.z).toBeCloseTo(2, 0);
    expect(last['p2']!.position.x).toBeCloseTo(2, 1);
    expect(p.raycast!({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 20)).toBeNull();
    expect(p.placeCharacter!({ x: 5, y: 2, z: 5 }, 'p2').ok).toBe(true);
    run({ '': [0, 0], p2: [0, 0] }, 120);
    expect(last['p2']!.position.x).toBeCloseTo(5, 5);
    expect(last['p2']!.groundEntityId).toBe('floor');
  });
});
