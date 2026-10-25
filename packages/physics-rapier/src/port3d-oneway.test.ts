/**
 * One-way colliders and cylinders on the Rapier 3D port (real
 * rapier3d-compat WASM): a character jumps up through a one-way platform and
 * lands on it, walks through its side, drops through it on request, in free
 * 3D and locked to a plane; a one-way collider turned on its side holds only
 * from the side its up faces; dynamic bodies in the contact pipeline pass up
 * through a one-way platform and come to rest on it; spawn clearance never
 * counts a one-way collider in the way, and counts it as support only under
 * a capsule on its top; a cylinder stands along
 * its local Y and a turned one lies along the plane's normal.
 */
import { describe, expect, it } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';

import type { PhysicsInitConfig3D, PhysicsPlane, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './index';
import { markOneWay, OneWayContacts, type OneWayCollider } from './oneway3d';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const Z0: PhysicsPlane = { axis: 'z', origin: 0 };
/** A capsule origin's height standing on a top at y = t (half of 1.8 m plus the skin). */
const standOn = (t: number): number => t + 0.91;
const box = (entityId: string, at: [number, number, number], half: [number, number, number], extra: Partial<StaticColliderSpec3D> = {}): StaticColliderSpec3D => ({
  entityId,
  shape: { type: 'box', hx: half[0], hy: half[1], hz: half[2] },
  position: { x: at[0], y: at[1], z: at[2] },
  rotation: IDENTITY,
  ...extra,
});
const config = (statics: StaticColliderSpec3D[], start: [number, number, number], plane?: PhysicsPlane): PhysicsInitConfig3D => ({
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
    vy = grounded ? (jump ? 9 : 0) : Math.max(-30, vy + G / HZ);
    port.stageCharacterMove({ x: dx / HZ, y: vy / HZ, z: dz / HZ });
    const r = port.step();
    grounded = r.grounded && vy <= 0;
    return r;
  };
}

/** A floor (top y = 0) and a one-way shelf 2 m up (top y = 2.1), optionally locked to a plane. */
const level = (plane?: PhysicsPlane): StaticColliderSpec3D[] => [
  box('floor', [0, -0.5, 0], [20, 0.5, 20]),
  box('shelf', [0, 2, 0], [2, 0.1, 2], { oneWay: true, ...(plane !== undefined ? { plane } : {}) }),
];

describe('one-way colliders for a character on the 3D port', () => {
  for (const plane of [undefined, Z0]) {
    it(`${plane === undefined ? 'free 3D' : 'on a plane'}: jumps up through the shelf, lands on it, drops through on request`, async () => {
      const port = await portOf(config(level(plane), [0, standOn(0), 0], plane));
      const drive = driver(port);
      for (let i = 0; i < 10; i++) drive(0, 0);
      // From below: the head passes the shelf (no head contact), the feet land on its top.
      let head = false;
      let r = drive(0, 0, true);
      for (let i = 0; i < 120; i++) {
        r = drive(0, 0);
        head ||= r.contacts.head;
      }
      expect(head).toBe(false);
      expect(r.grounded).toBe(true);
      expect(r.groundEntityId).toBe('shelf');
      expect(r.position.y).toBeCloseTo(standOn(2.1), 2);
      // Standing still it stays on the shelf.
      for (let i = 0; i < 60; i++) r = drive(0, 0);
      expect(r.position.y).toBeCloseTo(standOn(2.1), 2);
      // Drop through: back on the floor.
      port.dropThrough!(15);
      for (let i = 0; i < 120; i++) r = drive(0, 0);
      expect(r.groundEntityId).toBe('floor');
      expect(r.position.y).toBeCloseTo(standOn(0), 2);
      port.dispose();
    });
  }

  it('walks through the side of a one-way shelf at head height, and is held by its top from above', async () => {
    const port = await portOf(config([box('floor', [0, -0.5, 0], [20, 0.5, 20]), box('ledge', [3, 1.2, 0], [1, 0.1, 2], { oneWay: true }), box('wall', [8, 1.2, 0], [1, 0.1, 2])], [0, standOn(0), 0]));
    const drive = driver(port);
    let r = drive(0, 0);
    // The one-way ledge at chest height is walked through; a solid one stops the walk.
    for (let i = 0; i < 240; i++) r = drive(4, 0);
    expect(r.position.x).toBeGreaterThan(6);
    expect(r.position.x).toBeLessThan(7);
    expect(r.contacts.wall).toBe(true);
    port.dispose();
  });

  it('a one-way collider turned on its side holds only from the side its up faces', async () => {
    // Up is +X: a gate passed walking +x, a wall walking back.
    const side = { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 };
    const port = await portOf(config([box('floor', [0, -0.5, 0], [20, 0.5, 20]), box('gate', [2, 1, 0], [1.5, 0.1, 2], { oneWay: true, rotation: side })], [0, standOn(0), 0]));
    const drive = driver(port);
    let r = drive(0, 0);
    for (let i = 0; i < 180; i++) r = drive(3, 0);
    expect(r.position.x).toBeGreaterThan(4);
    for (let i = 0; i < 240; i++) r = drive(-3, 0);
    // Held by the gate's face at x = 2.1 (the capsule's radius and skin off it).
    expect(r.position.x).toBeCloseTo(2.1 + 0.3 + 0.01, 1);
    port.dispose();
  });

  it('spawn clearance: a one-way shelf never blocks a capsule and supports only one on its top (the clearance probe\'s one-way rule)', async () => {
    const solid = await portOf(config([box('floor', [0, -0.5, 0], [20, 0.5, 20]), box('shelf', [0, 2, 0], [2, 0.1, 2])], [5, standOn(0), 0]));
    const port = await portOf(config(level(), [5, standOn(0), 0]));
    // A capsule cutting through the shelf (0.6 to 2.4 m against its 1.9 to 2.1): a solid shelf blocks it,
    // a one-way one does not, and the floor below supports it.
    expect(solid.characterClearance!({ x: 0, y: 1.5, z: 0 })).toMatchObject({ ok: false, reason: 'blocked' });
    expect(port.characterClearance!({ x: 0, y: 1.5, z: 0 })).toMatchObject({ ok: true, supportNormal: { x: 0, y: 1, z: 0 } });
    expect(port.characterClearance!({ x: 0, y: standOn(2.1), z: 0 })).toMatchObject({ ok: true, supportNormal: { x: 0, y: 1, z: 0 } });
    solid.dispose();
    port.dispose();
    // A one-way floor with nothing under it: it supports a capsule on its top only.
    const alone = await portOf(config([box('shelf', [0, 2, 0], [2, 0.1, 2], { oneWay: true })], [0, standOn(2.1), 0]));
    expect(alone.characterClearance!({ x: 0, y: standOn(2.1), z: 0 })).toMatchObject({ ok: true });
    expect(alone.characterClearance!({ x: 0, y: standOn(2.1) - 0.3, z: 0 })).toMatchObject({ ok: false, reason: 'no_support' });
    alone.dispose();
  });

  it('one-way colliders come and go with their scene; a drop through is capped', async () => {
    const port = await portOf(config([box('floor', [0, -0.5, 0], [20, 0.5, 20])], [0, standOn(2.1) + 0.05, 0]));
    port.addStaticColliders!([box('shelf', [0, 2, 0], [2, 0.1, 2], { oneWay: true })]);
    const drive = driver(port);
    let r = drive(0, 0);
    for (let i = 0; i < 30; i++) r = drive(0, 0);
    expect(r.groundEntityId).toBe('shelf');
    port.removeStaticColliders!(['shelf']);
    for (let i = 0; i < 90; i++) r = drive(0, 0);
    expect(r.groundEntityId).toBe('floor');
    expect(() => port.addStaticColliders!([box('bad', [0, 0, 0], [1, 1, 1], { oneWay: 'yes' as never })])).toThrow(/oneWay/);
    port.dispose();
  });
});

describe('one-way colliders in the contact pipeline (dynamic bodies)', () => {
  it('a ball thrown up through a one-way shelf comes to rest on it; one dropped beside it lands on the floor', async () => {
    await portOf(config([], [0, 0, 0]));
    const world = new RAPIER.World({ x: 0, y: G, z: 0 });
    world.timestep = 1 / HZ;
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setTranslation(0, -0.5, 0));
    const shelfBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 2, 0));
    const shelf = world.createCollider(markOneWay(RAPIER.ColliderDesc.cuboid(2, 0.1, 2)), shelfBody);
    const platforms: OneWayCollider[] = [{ handle: shelf.handle, body: shelfBody, localTop: 0.1, reach: Math.hypot(2, 0.1, 2) }];
    const thrown = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.25, 0).setLinvel(0, 10, 0));
    world.createCollider(RAPIER.ColliderDesc.ball(0.25), thrown);
    const beside = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(4, 3, 0));
    world.createCollider(RAPIER.ColliderDesc.ball(0.25), beside);
    const hooks = new OneWayContacts();
    const events = new RAPIER.EventQueue(true);
    let peak = 0;
    for (let s = 0; s < 480; s++) {
      hooks.prepare(platforms, [thrown, beside], 1 / HZ);
      world.step(events, hooks);
      peak = Math.max(peak, thrown.translation().y);
    }
    expect(peak).toBeGreaterThan(2.6);
    expect(thrown.translation().y).toBeCloseTo(2.1 + 0.25, 1);
    expect(beside.translation().y).toBeCloseTo(0.25, 1);
    // Without the filter the same throw bounces off the shelf's underside.
    const world2 = new RAPIER.World({ x: 0, y: G, z: 0 });
    world2.timestep = 1 / HZ;
    world2.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setTranslation(0, -0.5, 0));
    world2.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.1, 2).setTranslation(0, 2, 0));
    const blocked = world2.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.25, 0).setLinvel(0, 10, 0));
    world2.createCollider(RAPIER.ColliderDesc.ball(0.25), blocked);
    let peak2 = 0;
    for (let s = 0; s < 480; s++) {
      world2.step();
      peak2 = Math.max(peak2, blocked.translation().y);
    }
    expect(peak2).toBeLessThan(1.7);
    events.free();
    world.free();
    world2.free();
  });
});

describe('cylinders on the 3D port', () => {
  it('stands along its local Y; turned a quarter about X it lies along Z (a flat circle on a Z plane), and a character lands on its top', async () => {
    const lying = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    const port = await portOf(config([
      box('floor', [0, -0.5, 0], [20, 0.5, 20]),
      { entityId: 'post', shape: { type: 'cylinder', radius: 0.5, halfHeight: 1 }, position: { x: 6, y: 1, z: 0 }, rotation: IDENTITY },
      { entityId: 'log', shape: { type: 'compound', parts: [{ shape: { type: 'cylinder', radius: 1, halfHeight: 0.5 }, position: { x: 0, y: 0, z: 0 }, rotation: lying }] }, position: { x: 0, y: 1, z: 0 }, rotation: IDENTITY },
    ], [0, 4, 0], Z0));
    // The post: 2 m tall, 0.5 m round.
    expect(port.raycast!({ x: 6, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10)?.distance).toBeCloseTo(3, 4);
    expect(port.raycast!({ x: 9, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 10)?.distance).toBeCloseTo(2.5, 4);
    // The log: a disc of radius 1 in X/Y, 1 m deep along Z.
    expect(port.raycast!({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: -1 }, 10)?.distance).toBeCloseTo(4.5, 4);
    expect(port.raycast!({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10)?.distance).toBeCloseTo(3, 4);
    expect(port.raycast!({ x: 0.6, y: 5, z: 0.6 }, { x: 0, y: -1, z: 0 }, 10)?.entityId).toBe('floor');
    const drive = driver(port);
    let r = drive(0, 0);
    for (let i = 0; i < 120; i++) r = drive(0, 0);
    expect(r.groundEntityId).toBe('log');
    expect(r.position.y).toBeCloseTo(standOn(2), 2);
    port.dispose();
  });
});
