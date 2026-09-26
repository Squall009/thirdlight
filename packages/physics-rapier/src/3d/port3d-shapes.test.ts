/**
 * Phase 23.1: the Rapier 3D port's collider shapes (sphere, capsule, convex
 * hull, static triangle mesh), kinematic bodies posed each step (a mover),
 * overlap queries (box, sphere, turned capsule) and the character's
 * clearance/placement — real rapier3d-compat WASM.
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D, validateColliderShape3D, type RapierPhysicsPort3D } from './index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const config = (statics: StaticColliderSpec3D[], start: [number, number, number] = [0, 3, 0]): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: start[0], y: start[1], z: start[2] }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
  statics,
  solver: { hz: HZ, gravityY: G },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
});
const spec = (entityId: string, shape: unknown, at: [number, number, number], extra: Partial<StaticColliderSpec3D> = {}): StaticColliderSpec3D => ({
  entityId,
  shape,
  position: { x: at[0], y: at[1], z: at[2] },
  rotation: IDENTITY,
  ...extra,
});
/** A floor quad at y = 0 as a triangle mesh (two triangles). */
const quad = (half: number) => ({ type: 'mesh', vertices: [-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half], indices: [0, 2, 1, 0, 3, 2] });

/** Stage the fall the runtime stages (gravity, capped at 30 m/s, zeroed on landing). */
function fall(port: PhysicsPort3D, steps: number): ReturnType<PhysicsPort3D['step']> {
  let v = 0;
  let grounded = false;
  let last!: ReturnType<PhysicsPort3D['step']>;
  for (let i = 0; i < steps; i += 1) {
    v = grounded ? 0 : Math.max(-30, v + G / HZ);
    port.stageCharacterMove({ x: 0, y: v / HZ, z: 0 });
    last = port.step();
    grounded = last.grounded;
    if (grounded) v = 0;
  }
  return last;
}

async function portOf(cfg: PhysicsInitConfig3D): Promise<RapierPhysicsPort3D> {
  const made = await createPhysicsPort3D(cfg);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

describe('the Rapier 3D port: phase 23.1 shapes and queries', () => {
  it('rests on a sphere, a capsule, a convex hull and a triangle mesh (feet on each top)', async () => {
    const cases: { name: string; shape: unknown; at: [number, number, number] }[] = [
      { name: 'sphere', shape: { type: 'sphere', radius: 1 }, at: [0, -1, 0] },
      { name: 'capsule', shape: { type: 'capsule', radius: 0.5, halfHeight: 0.5 }, at: [0, -1, 0] },
      { name: 'convex', shape: { type: 'convex', points: [-2, -1, -2, 2, -1, -2, 2, -1, 2, -2, -1, 2, -2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2] }, at: [0, 0, 0] },
      { name: 'mesh', shape: quad(3), at: [0, 0, 0] },
    ];
    for (const c of cases) {
      const port = await portOf(config([spec(c.name, c.shape, c.at)]));
      const last = fall(port, 300);
      expect(last.grounded, c.name).toBe(true);
      expect(last.groundEntityId, c.name).toBe(c.name);
      // Every top is at y = 0: the capsule centre rests 0.9 m up plus the skin.
      expect(last.position.y, c.name).toBeGreaterThan(0.9 - 1e-3);
      expect(last.position.y, c.name).toBeLessThan(0.9 + 0.02);
      port.dispose();
    }
  });

  it('a fast fall onto a triangle mesh stops at the mesh (the sweep never tunnels through it)', async () => {
    const port = await portOf(config([spec('floor', quad(1), [0, 0, 0])], [0.5, 0.95, 0.5]));
    port.stageCharacterMove({ x: 0, y: -3, z: 0 });
    const r = port.step();
    expect(r.position.y).toBeGreaterThan(0.89);
    port.dispose();
  });

  it('validates the new shapes (capsule half height, hull and mesh sizes, mesh indices); a kinematic mesh and a flat hull are refused', async () => {
    expect(validateColliderShape3D({ type: 'sphere', radius: 0 }).ok).toBe(false);
    expect(validateColliderShape3D({ type: 'capsule', radius: 0.5, halfHeight: -1 }).ok).toBe(false);
    expect(validateColliderShape3D({ type: 'capsule', radius: 0.5, halfHeight: 0 }).ok).toBe(true);
    expect(validateColliderShape3D({ type: 'convex', points: [0, 0, 0, 1, 0, 0, 0, 1, 0] }).ok).toBe(false);
    expect(validateColliderShape3D({ type: 'mesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 3] }).ok).toBe(false);
    expect(validateColliderShape3D({ type: 'mesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 1] }).ok).toBe(false);
    expect(validateColliderShape3D({ type: 'sphere', radius: 1, hz: 1 }).ok).toBe(false);
    const kinematicMesh = await createPhysicsPort3D(config([spec('m', quad(1), [0, 0, 0], { kinematic: true })]));
    expect(kinematicMesh).toMatchObject({ ok: false, error: { reason: 'invalid_shape' } });
    const port = await portOf(config([]));
    expect(() => port.addStaticColliders([spec('ok', { type: 'sphere', radius: 0.5 }, [0, 0, 0]), spec('flat', { type: 'convex', points: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] }, [0, 0, 0])])).toThrow();
    // A refused batch adds nothing (the sphere before the flat hull is taken back too).
    expect(port.raycast({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 }, 5)).toBeNull();
    port.dispose();
  });

  it('a kinematic body posed each step moves after the sweep; the character standing on it rises with its carry; a fixed body ignores poses', async () => {
    const lift = spec('lift', { type: 'box', hx: 1, hy: 0.1, hz: 1 }, [0, -0.1, 0], { kinematic: true });
    const wall = spec('wall', { type: 'box', hx: 0.1, hy: 1, hz: 1 }, [5, 1, 0]);
    const port = await portOf(config([lift, wall], [0, 1, 0]));
    fall(port, 120);
    for (let i = 1; i <= 50; i += 1) {
      port.setKinematicPoses([
        { entityId: 'lift', position: { x: 0, y: -0.1 + 0.01 * i, z: 0 }, rotation: IDENTITY },
        { entityId: 'wall', position: { x: 9, y: 9, z: 9 }, rotation: IDENTITY },
      ]);
      // The runtime adds the platform's motion to the character's move (its carry).
      port.stageCharacterMove({ x: 0, y: 0.01, z: 0 });
      port.step();
    }
    const top = port.raycast({ x: 0.5, y: 3, z: 0.5 }, { x: 0, y: -1, z: 0 }, 10);
    expect(top?.entityId).toBe('lift');
    expect(3 - top!.distance).toBeCloseTo(0.5, 3); // centre −0.1 + 0.5, half height 0.1
    expect(port.raycast({ x: 4, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 5)?.entityId).toBe('wall');
    port.stageCharacterMove({ x: 0, y: 0, z: 0 });
    const r = port.step();
    expect(r.grounded).toBe(true);
    expect(r.groundEntityId).toBe('lift');
    expect(r.position.y).toBeGreaterThan(0.5 + 0.9 - 1e-3);
    expect(r.position.y).toBeLessThan(0.5 + 0.9 + 0.02);
    expect(() => port.setKinematicPoses([{ entityId: 'lift', position: { x: 0, y: Number.NaN, z: 0 }, rotation: IDENTITY }])).toThrow();
    port.dispose();
  });

  it('overlap queries find colliders in a box, a sphere and a turned capsule (sorted, the character excluded)', async () => {
    const port = await portOf(config([spec('a', { type: 'sphere', radius: 0.5 }, [0, 0, 0]), spec('b', { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, [3, 0, 0]), spec('c', { type: 'capsule', radius: 0.2, halfHeight: 1 }, [0, 0, 3])], [0, 10, 0]));
    expect(port.overlap({ type: 'box', hx: 5, hy: 1, hz: 0.5 }, { x: 1, y: 0, z: 0 })).toEqual(['a', 'b']);
    expect(port.overlap({ type: 'sphere', radius: 0.6 }, { x: 0, y: 0, z: 0 })).toEqual(['a']);
    // A capsule lying along Z (turned 90° about X) reaches from the sphere to the standing capsule.
    const q = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    expect(port.overlap({ type: 'capsule', radius: 0.1, halfHeight: 1.5 }, { x: 0, y: 0, z: 1.5 }, q)).toEqual(['a', 'c']);
    expect(port.overlap({ type: 'capsule', radius: 0.1, halfHeight: 1.5 }, { x: 0, y: 0, z: 1.5 })).toEqual([]);
    expect(port.overlap({ type: 'sphere', radius: 1 }, { x: 0, y: 10, z: 0 })).toEqual([]);
    expect(port.overlap({ type: 'sphere', radius: -1 }, { x: 0, y: 0, z: 0 })).toEqual([]);
    port.dispose();
  });

  it('clearance: blocked inside a collider, supported above one, no support over nothing; place moves the character', async () => {
    const port = await portOf(config([spec('floor', { type: 'box', hx: 2, hy: 0.5, hz: 2 }, [0, -0.5, 0])], [0, 5, 0]));
    expect(port.characterClearance({ x: 0, y: 0.5, z: 0 })).toMatchObject({ ok: false, reason: 'blocked' });
    expect(port.characterClearance({ x: 0, y: 1, z: 0 })).toMatchObject({ ok: true, supportNormal: { y: 1 } });
    expect(port.characterClearance({ x: 5, y: 1, z: 5 })).toMatchObject({ ok: false, reason: 'no_support' });
    expect(port.placeCharacter({ x: 1, y: 1, z: -1 })).toMatchObject({ ok: true });
    port.stageCharacterMove({ x: 0, y: -0.05, z: 0 });
    const r = port.step();
    expect(r.position.x).toBe(1);
    expect(r.position.z).toBe(-1);
    expect(r.position.y).toBeLessThan(1);
    port.dispose();
  });
});
