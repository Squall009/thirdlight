/**
 * Plane locks on the Rapier 3D port (real rapier3d-compat WASM): a static
 * collider made on its plane and snapped onto one mid-run; a mover posed on
 * its plane whatever pose it is given; a character locked, freed and locked
 * again mid-run (snapped, its moves kept to the plane while it walks and
 * jumps, all six degrees of freedom back when freed); a stack of dynamic
 * boxes locked to a plane staying in it; two runs bit for bit equal.
 */
import { describe, expect, it } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';

import type { PhysicsInitConfig3D, PhysicsPlane, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './index';
import { holdOnPlane, lockBody, twistAbout } from './plane3d';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const Z0: PhysicsPlane = { axis: 'z', origin: 0 };
const box = (entityId: string, at: [number, number, number], half: [number, number, number], extra: Partial<StaticColliderSpec3D> = {}): StaticColliderSpec3D => ({
  entityId,
  shape: { type: 'box', hx: half[0], hy: half[1], hz: half[2] },
  position: { x: at[0], y: at[1], z: at[2] },
  rotation: IDENTITY,
  ...extra,
});
const config = (statics: StaticColliderSpec3D[], start: [number, number, number], plane?: PhysicsPlane): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: start[0], y: start[1], z: start[2] }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 }, ...(plane !== undefined ? { plane } : {}) },
  statics,
  solver: { hz: HZ, gravityY: G },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
});

async function portOf(cfg: PhysicsInitConfig3D): Promise<PhysicsPort3D> {
  const made = await createPhysicsPort3D(cfg);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

/** A character driven the way the runtime drives it: gravity, a jump when asked, a walk along (dx, dz) m/s. */
function driver(port: PhysicsPort3D) {
  let vy = 0;
  let grounded = false;
  return (dx: number, dz: number, jump = false) => {
    vy = grounded ? (jump ? 7 : 0) : Math.max(-30, vy + G / HZ);
    port.stageCharacterMove({ x: dx / HZ, y: vy / HZ, z: dz / HZ });
    const r = port.step();
    grounded = r.grounded && vy <= 0;
    return r;
  };
}

describe('plane locks on the 3D port', () => {
  it('a static collider is made on its plane, and a free one snaps onto a plane mid-run', async () => {
    const port = await portOf({ ...config([box('wall', [0, 1, 3], [0.5, 1, 0.5], { plane: Z0 }), box('post', [4, 1, 2.5], [0.5, 1, 0.5])], [0, 0, 0]), noCharacter: true });
    // The wall stands on z = 0 (its authored z of 3 is not where it is).
    expect(port.raycast!({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, 10)?.distance).toBeCloseTo(4.5, 5);
    expect(port.raycast!({ x: 4, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, 10)?.distance).toBeCloseTo(2, 5);
    expect(port.setBodyPlane!('post', { axis: 'z', origin: -1 })).toBe(true);
    expect(port.raycast!({ x: 4, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, 10)?.distance).toBeCloseTo(5.5, 5);
    // Freed, it stays where it is; an unknown object is no body.
    expect(port.setBodyPlane!('post', null)).toBe(true);
    expect(port.raycast!({ x: 4, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, 10)?.distance).toBeCloseTo(5.5, 5);
    expect(port.setBodyPlane!('nothing', Z0)).toBe(false);
    expect(() => port.setBodyPlane!('post', { axis: 'y', origin: 0 } as never)).toThrow(/axis/);
    port.dispose();
  });

  it('a mover locked to a plane is posed on it, turned only about the normal', async () => {
    const port = await portOf({ ...config([box('lift', [0, 1, 0], [1, 0.25, 1], { kinematic: true, plane: { axis: 'x', origin: 2 } })], [0, 0, 0]), noCharacter: true });
    // Posed off the plane and tilted about Z: it goes to x = 2, untilted.
    const tilt = { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) };
    port.setKinematicPoses!([{ entityId: 'lift', position: { x: -3, y: 1, z: 0 }, rotation: tilt }]);
    port.step();
    port.step();
    expect(port.overlap!({ type: 'sphere', radius: 0.1 }, { x: 2, y: 1, z: 0 })).toEqual(['lift']);
    expect(port.overlap!({ type: 'sphere', radius: 0.1 }, { x: -3, y: 1, z: 0 })).toEqual([]);
    // Flat: a ray straight down at its far edge hits its top at y = 1.25.
    expect(port.raycast!({ x: 2.9, y: 3, z: 0 }, { x: 0, y: -1, z: 0 }, 10)?.distance).toBeCloseTo(1.75, 4);
    expect(twistAbout(tilt, { axis: 'x', origin: 0 })).toEqual(IDENTITY);
    expect(twistAbout(tilt, Z0).z).toBeCloseTo(Math.sin(Math.PI / 8), 12);
    port.dispose();
  });

  it('a character locked, freed and locked again mid-run: snapped, kept to the plane walking and jumping, free in between', async () => {
    const run = async () => {
      const port = await portOf(config([box('floor', [0, -0.5, 0], [20, 0.5, 20])], [0, 1, 0.75]));
      const drive = driver(port);
      const z: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < 60; i += 1) z.push(drive(1, 2).position.z);
      const before = z[z.length - 1]!;
      expect(before).toBeGreaterThan(1.5);
      // Lock: snapped onto z = 0.25 at once, then walking diagonally stays on it, and so does a jump.
      expect(port.setCharacterPlane!({ axis: 'z', origin: 0.25 }).z).toBe(0.25);
      let apex = -Infinity;
      for (let i = 0; i < 120; i += 1) {
        const r = drive(3, 2, i === 10);
        expect(r.position.z).toBe(0.25);
        expect(r.applied.z).toBe(0);
        apex = Math.max(apex, r.position.y);
        ys.push(r.position.y);
      }
      expect(apex).toBeGreaterThan(1.9);
      // Free: it moves along z again.
      port.setCharacterPlane!(null);
      for (let i = 0; i < 30; i += 1) z.push(drive(0, 2).position.z);
      expect(z[z.length - 1]!).toBeGreaterThan(0.6);
      // Locked again, about X this time: x is held, z still moves.
      const at = port.setCharacterPlane!({ axis: 'x', origin: -2 });
      expect(at.x).toBe(-2);
      for (let i = 0; i < 30; i += 1) {
        const r = drive(4, 2);
        expect(r.position.x).toBe(-2);
        z.push(r.position.z);
      }
      expect(z[z.length - 1]!).toBeGreaterThan(z[z.length - 31]! + 0.4);
      port.dispose();
      return [...z, ...ys];
    };
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
  });

  it('a stack of dynamic boxes locked to a plane stays in it (Rapier locks plus the position correction)', async () => {
    await portOf(config([], [0, 0, 0]));
    const world = new RAPIER.World({ x: 0, y: G, z: 0 });
    world.timestep = 1 / HZ;
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setTranslation(0, -0.5, 0));
    const plane: PhysicsPlane = { axis: 'z', origin: 0.5 };
    const boxes: RAPIER.RigidBody[] = [];
    for (let i = 0; i < 6; i += 1) {
      // Each starts off the plane, slightly turned about every axis and drifting along z.
      const q = { x: 0.05 * i, y: 0.03, z: 0.02 * i, w: 1 };
      const n = Math.hypot(q.x, q.y, q.z, q.w);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.05 * i, 0.5 + i * 1.02, 0.3 * i - 0.6).setRotation({ x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }).setLinvel(0.2, 0, 1.5).setAngvel({ x: 2, y: 1, z: 0.5 }));
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
      lockBody(body, plane);
      boxes.push(body);
    }
    // Locking snapped each onto the plane, turned only about z, without velocity along z.
    for (const b of boxes) {
      expect(b.translation().z).toBe(0.5);
      expect(b.rotation().x).toBe(0);
      expect(b.rotation().y).toBe(0);
      expect(b.linvel().z).toBe(0);
      expect(b.angvel().x).toBe(0);
    }
    for (let s = 0; s < 600; s += 1) {
      world.step();
      for (const b of boxes) holdOnPlane(b, plane);
    }
    for (const b of boxes) {
      expect(b.translation().z).toBe(0.5);
      expect(Math.abs(b.rotation().x)).toBeLessThan(1e-6);
      expect(Math.abs(b.rotation().y)).toBeLessThan(1e-6);
    }
    // The stack came to rest standing (the top box well above the floor).
    expect(Math.max(...boxes.map((b) => b.translation().y))).toBeGreaterThan(2);
    // Freed, the top box moves along z again when pushed (friction slows it on the box below).
    const top = boxes[boxes.length - 1]!;
    lockBody(top, null);
    top.setLinvel({ x: 0, y: 0, z: 3 }, true);
    for (let s = 0; s < 30; s += 1) world.step();
    expect(top.translation().z).toBeGreaterThan(0.55);
    world.free();
  });
});
