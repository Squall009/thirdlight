/**
 * Compound colliders: one body per object with a collider per placed shape,
 * each at its position and turn in the body's frame, every collider the
 * object's — the character rests on a shape where it is (not at the body's
 * origin), a ray stops at each part, removal frees them all. Real Rapier
 * WASM, 3D and the 2D plane.
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './3d/index';
import { createPhysicsPort } from './index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const Q45Z = { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) };

const config3 = (statics: StaticColliderSpec3D[], start: [number, number, number]): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: start[0], y: start[1], z: start[2] }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
  statics,
  solver: { hz: HZ, gravityY: G },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
});

/** Two 1 m-thick slabs of one object: one 3 m up at x = 4, one at the origin turned 45° about Z. */
const twoSlabs = {
  type: 'compound',
  parts: [
    { shape: { type: 'box', hx: 1, hy: 0.5, hz: 1 }, position: { x: 4, y: 3, z: 0 }, rotation: IDENTITY },
    { shape: { type: 'box', hx: 1, hy: 0.5, hz: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: Q45Z },
  ],
};

describe('compound colliders', () => {
  it('3D: the character lands on the raised part where it is, a ray stops at each part, all go with the object', async () => {
    const made = await createPhysicsPort3D(config3([{ entityId: 'stall', shape: twoSlabs, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY }], [4, 6, 0]));
    if (!made.ok) throw new Error(made.error.message);
    const port = made.port;
    let v = 0;
    let last = port.step();
    for (let i = 0; i < 360; i += 1) {
      v = last.grounded ? 0 : Math.max(-30, v + G / HZ);
      port.stageCharacterMove({ x: 0, y: v / HZ, z: 0 });
      last = port.step();
    }
    expect(last.grounded).toBe(true);
    expect(last.groundEntityId).toBe('stall');
    // Feet on the raised slab's top (3.5 m), not at the body's origin: the capsule's centre is 0.9 m above them.
    expect(last.position.y).toBeGreaterThan(3.5 + 0.9 - 0.05);
    expect(last.position.y).toBeLessThan(3.5 + 0.9 + 0.05);
    // A ray down at x = 4 meets the raised part's top; one at x = 0 meets the turned part (a 45° slab is higher than 0.5 at its centre).
    expect(port.raycast({ x: 4, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)).toMatchObject({ entityId: 'stall' });
    expect(port.raycast({ x: 4, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)!.distance).toBeCloseTo(6.5, 3);
    const turned = port.raycast({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)!;
    expect(turned.entityId).toBe('stall');
    expect(10 - turned.distance).toBeCloseTo(0.5 * Math.SQRT2, 3);
    // Between the parts nothing.
    expect(port.raycast({ x: 2.4, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)).toBeNull();
    const before = port.diagnostics().worldColliderCount;
    port.removeStaticColliders(['stall']);
    expect(port.diagnostics().worldColliderCount).toBe(before - 2);
    expect(port.raycast({ x: 4, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)).toBeNull();
    port.dispose();
  });

  it('3D: a compound may not hold a mesh on a moving body', async () => {
    const made = await createPhysicsPort3D(config3([], [0, 5, 0]));
    if (!made.ok) throw new Error(made.error.message);
    const mesh = { type: 'mesh', vertices: [-1, 0, -1, 1, 0, -1, 1, 0, 1], indices: [0, 2, 1] };
    expect(() => made.port.addStaticColliders([{ entityId: 'm', shape: { type: 'compound', parts: [{ shape: mesh, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY }] }, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY, kinematic: true }])).toThrow(/mesh collider is static/);
    made.port.dispose();
  });

  it('the 2D plane: the character lands on an offset part of a turned body', async () => {
    const made = await createPhysicsPort({
      character: { x: 0, y: 5 },
      statics: [{
        entityId: 'ledge',
        // The body turned 90° about Z: the part 2 m along its X is 2 m up in the world.
        shape: { type: 'compound', parts: [{ shape: { type: 'box', hx: 1, hy: 0.25 }, x: 2, y: 0, angle: -Math.PI / 2 }] },
        position: { x: 0, y: 0 },
        rotationZ: Math.PI / 2,
      }],
      solver: { hz: HZ, gravityY: G },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    });
    if (!made.ok) throw new Error(made.error.message);
    let grounded = false;
    let y = 0;
    for (let i = 0; i < 360; i += 1) {
      made.port.stageCharacterMove({ x: 0, y: -0.05 });
      const r = made.port.step();
      grounded = r.grounded;
      y = r.position.y;
    }
    expect(grounded).toBe(true);
    // Feet on the part's top (2.25 m; the default capsule's centre is 0.9 m above them).
    expect(y).toBeGreaterThan(2.25 + 0.9 - 0.05);
    expect(y).toBeLessThan(2.25 + 0.9 + 0.05);
    made.port.dispose();
  });
});
