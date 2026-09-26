/**
 * Phase 23.0: the Rapier 3D port (real rapier3d-compat WASM). A capsule
 * dropped over a box falls (the test stages the fall the runtime stages:
 * gravity along −Y) and rests on the box's top; on a box rotated about X it
 * rests on the tilted top, higher on the raised side; a ray hits the nearest
 * box with its normal; the config and shapes are validated before any WASM
 * work; results are identical over two runs; dispose frees the world.
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D, physicsMemoryBytes3D, validateColliderShape3D } from './index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const box = (entityId: string, at: [number, number, number], half: [number, number, number], rotation = IDENTITY): StaticColliderSpec3D => ({
  entityId,
  shape: { type: 'box', hx: half[0], hy: half[1], hz: half[2] },
  position: { x: at[0], y: at[1], z: at[2] },
  rotation,
});
const config = (statics: StaticColliderSpec3D[], start: [number, number, number] = [0, 3, 0]): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: start[0], y: start[1], z: start[2] }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
  statics,
  solver: { hz: HZ, gravityY: G },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
});

/** Stage the fall the runtime stages (gravity, capped at 30 m/s, zeroed on landing) for `steps` steps. */
function fall(port: PhysicsPort3D, steps: number): { y: number[]; last: ReturnType<PhysicsPort3D['step']> } {
  let v = 0;
  let grounded = false;
  const y: number[] = [];
  let last!: ReturnType<PhysicsPort3D['step']>;
  for (let i = 0; i < steps; i += 1) {
    v = grounded ? 0 : Math.max(-30, v + G / HZ);
    port.stageCharacterMove({ x: 0, y: v / HZ, z: 0 });
    last = port.step();
    grounded = last.grounded;
    if (grounded) v = 0;
    y.push(last.position.y);
  }
  return { y, last };
}

async function portOf(cfg: PhysicsInitConfig3D): Promise<PhysicsPort3D> {
  const made = await createPhysicsPort3D(cfg);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

describe('the Rapier 3D port', () => {
  it('a capsule falls onto a box and rests on its top (feet at the top plus the skin)', async () => {
    const port = await portOf(config([box('floor', [0, -0.5, 0], [5, 0.5, 5])]));
    expect(port.dimension).toBe(3);
    expect(port.implementation).toBe('rapier3d-compat@0.20.0');
    const { y, last } = fall(port, 240);
    expect(y[10]!).toBeLessThan(3); // it fell
    expect(last.grounded).toBe(true);
    expect(last.supportNormal.y).toBeCloseTo(1, 6);
    expect(last.groundEntityId).toBe('floor');
    // The capsule centre rests 0.9 m (half its 1.8 m height) above the top (y = 0), plus the controller's skin.
    expect(last.position.y).toBeGreaterThan(0.9 - 1e-3);
    expect(last.position.y).toBeLessThan(0.9 + 0.02);
    // At rest: the last second moves less than a millimetre, x and z untouched.
    expect(Math.abs(y[239]! - y[119]!)).toBeLessThan(1e-3);
    expect(last.position.x).toBe(0);
    expect(last.position.z).toBe(0);
    expect(physicsMemoryBytes3D()).toBeGreaterThan(0);
    port.dispose();
    expect(port.diagnostics?.()).toMatchObject({ live: false });
    expect(() => port.step()).toThrow(/disposed/);
  });

  it('rests on a box rotated about X: the tilted top holds it higher on the raised side', async () => {
    const a = (10 * Math.PI) / 180;
    // Rotated +10° about X: the top rises toward −Z.
    const tilted = box('ramp', [0, -0.5, 0], [5, 0.5, 5], { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) });
    const high = await portOf(config([tilted], [0, 3, -2]));
    const low = await portOf(config([tilted], [0, 3, 2]));
    const h = fall(high, 240).last;
    const l = fall(low, 240).last;
    expect(h.grounded && l.grounded).toBe(true);
    expect(h.position.y - l.position.y).toBeGreaterThan(0.5); // 4 m apart on a 10° slope: ≈ 0.7 m
    expect(h.supportNormal.y).toBeCloseTo(Math.cos(a), 2);
    // Turned +10° about X the top's normal is (0, cos 10°, sin 10°): it faces up and toward +Z, the raised side is −Z.
    expect(h.supportNormal.z).toBeCloseTo(Math.sin(a), 2);
    high.dispose();
    low.dispose();
  });

  it('raycasts hit the nearest box with its normal (the character excluded)', async () => {
    const port = await portOf(config([box('near', [0, 0, -3], [1, 1, 0.5]), box('far', [0, 0, -8], [1, 1, 0.5])], [0, 5, 0]));
    const hit = port.raycast!({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -2 }, 50);
    expect(hit).toMatchObject({ entityId: 'near' });
    expect(hit!.distance).toBeCloseTo(2.5, 5);
    expect(hit!.normal.z).toBeCloseTo(1, 5);
    expect(port.raycast!({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 50)).toBeNull();
    // Scene loads add and remove colliders.
    port.addStaticColliders!([box('added', [0, 0, 2], [1, 1, 0.5])]);
    expect(port.raycast!({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 50)).toMatchObject({ entityId: 'added' });
    port.removeStaticColliders!(['added']);
    expect(port.raycast!({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 50)).toBeNull();
    port.dispose();
  });

  it('is deterministic: two runs give the same positions bit for bit', async () => {
    const cfg = config([box('floor', [0, -0.5, 0], [5, 0.5, 5]), box('step', [0.2, 0.2, 0.1], [0.3, 0.2, 0.3], { x: 0.1, y: 0.2, z: 0.05, w: Math.sqrt(1 - 0.01 - 0.04 - 0.0025) })]);
    const a = await portOf(cfg);
    const b = await portOf(cfg);
    const ya = fall(a, 200).y;
    const yb = fall(b, 200).y;
    expect(ya).toEqual(yb);
    a.dispose();
    b.dispose();
  });

  it('refuses a bad config or shape before any world work', async () => {
    expect(validateColliderShape3D({ type: 'box', hx: 1, hy: 1 }).ok).toBe(false); // no depth
    expect(validateColliderShape3D({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] }).ok).toBe(false);
    expect(validateColliderShape3D({ type: 'box', hx: 1, hy: 1, hz: 1 }).ok).toBe(true);
    const noDepth = await createPhysicsPort3D(config([{ ...box('floor', [0, 0, 0], [1, 1, 1]), shape: { type: 'box', hx: 1, hy: 1 } }]));
    expect(noDepth).toMatchObject({ ok: false, error: { code: 'physics_init_failed', reason: 'invalid_shape' } });
    const badRotation = await createPhysicsPort3D(config([box('floor', [0, 0, 0], [1, 1, 1], { x: 0, y: 0, z: 0, w: 2 })]));
    expect(badRotation).toMatchObject({ ok: false, error: { reason: 'invalid_transform' } });
    const twoD = await createPhysicsPort3D({ ...config([]), dimension: 2 } as never);
    expect(twoD).toMatchObject({ ok: false, error: { reason: 'invalid_config' } });
    const ctl = new AbortController();
    ctl.abort();
    expect(await createPhysicsPort3D(config([]), ctl.signal)).toMatchObject({ ok: false, error: { code: 'physics_init_cancelled' } });
  });
});
