/**
 * The 3D port's script queries (real rapier3d-compat WASM) —
 * collision layers as interaction groups (a collider without layers is in
 * "default"), the accept predicate, the hit point, filtered overlaps, and a
 * world without a character (the capsule takes no part in queries or
 * contacts; its step moves nothing).
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { colliderGroups, createPhysicsPort3D, layerBitsOf, queryGroups } from './port3d';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const box = (entityId: string, z: number, layers?: string[]): StaticColliderSpec3D => ({
  entityId,
  shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 },
  position: { x: 0, y: 0, z },
  rotation: IDENTITY,
  ...(layers !== undefined ? { layers } : {}),
});
// Three boxes on the −Z axis (nearest first from a ray starting at z = 10 looking down −Z).
const STATICS = [box('near-default', 4), box('mid-units', 0, ['units']), box('far-both', -4, ['units', 'props'])];
const config = (extra: Partial<PhysicsInitConfig3D> = {}): PhysicsInitConfig3D => ({
  dimension: 3,
  character: { position: { x: 20, y: 0, z: 0 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
  statics: STATICS,
  solver: { hz: 120, gravityY: -19.62 },
  controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  layers: ['units', 'props'],
  ...extra,
});

async function portOf(cfg: PhysicsInitConfig3D): Promise<PhysicsPort3D> {
  const made = await createPhysicsPort3D(cfg);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

const FROM = { x: 0, y: 0, z: 10 };
const DOWN_Z = { x: 0, y: 0, z: -1 };

describe('3D script queries on the Rapier port', () => {
  it('the groups: members of their layers, filtering nothing; a query filters to the named layers', () => {
    const bits = layerBitsOf(['units', 'props']);
    expect(colliderGroups(bits, undefined)).toBe(((1 << 16) | 0xffff) >>> 0);
    expect(colliderGroups(bits, ['units', 'props'])).toBe(((6 << 16) | 0xffff) >>> 0);
    expect(queryGroups(bits, ['props', 'unknown'])).toBe(((0xffff << 16) | 4) >>> 0);
    expect(queryGroups(bits, ['unknown'])).toBe((0xffff << 16) >>> 0);
  });

  it('a ray hits the nearest collider, with its point; layers and the accept test filter it', async () => {
    const port = await portOf(config());
    const all = port.raycast!(FROM, DOWN_Z, 100);
    expect(all).toMatchObject({ entityId: 'near-default', distance: expect.closeTo(5.5, 5), normal: { x: 0, y: 0, z: expect.closeTo(1, 5) } });
    expect(all!.point!.z).toBeCloseTo(4.5, 5);
    expect(port.raycast!(FROM, DOWN_Z, 100, { layers: ['units'] })?.entityId).toBe('mid-units');
    expect(port.raycast!(FROM, DOWN_Z, 100, { layers: ['props'] })?.entityId).toBe('far-both');
    expect(port.raycast!(FROM, DOWN_Z, 100, { layers: ['default'] })?.entityId).toBe('near-default');
    expect(port.raycast!(FROM, DOWN_Z, 100, { layers: ['nothing'] })).toBeNull();
    expect(port.raycast!(FROM, DOWN_Z, 100, { accept: (id) => id !== 'near-default' && id !== 'mid-units' })?.entityId).toBe('far-both');
    expect(port.raycast!(FROM, DOWN_Z, 5, { layers: ['units'] })).toBeNull(); // out of reach
    port.dispose();
  });

  it('overlaps filter the same way (sorted ids)', async () => {
    const port = await portOf(config());
    const big = { type: 'box' as const, hx: 1, hy: 1, hz: 10 };
    expect(port.overlap!(big, { x: 0, y: 0, z: 0 })).toEqual(['far-both', 'mid-units', 'near-default']);
    expect(port.overlap!(big, { x: 0, y: 0, z: 0 }, undefined, { layers: ['units'] })).toEqual(['far-both', 'mid-units']);
    expect(port.overlap!({ type: 'sphere', radius: 20 }, { x: 0, y: 0, z: 0 }, undefined, { accept: (id) => id.startsWith('near') })).toEqual(['near-default']);
    port.dispose();
  });

  it('layers do not change contacts: the character still lands on a collider in a named layer', async () => {
    const floor: StaticColliderSpec3D = { entityId: 'floor', shape: { type: 'box', hx: 5, hy: 0.5, hz: 5 }, position: { x: 0, y: -0.5, z: 0 }, rotation: IDENTITY, layers: ['props'] };
    const port = await portOf(config({ statics: [floor], character: { position: { x: 0, y: 2, z: 0 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } } }));
    let v = 0;
    let last = port.step();
    for (let i = 0; i < 240; i += 1) {
      v = last.grounded ? 0 : Math.max(-30, v - 19.62 / 120);
      port.stageCharacterMove({ x: 0, y: v / 120, z: 0 });
      last = port.step();
    }
    expect(last.grounded).toBe(true);
    expect(last.position.y).toBeCloseTo(0.9, 1);
    port.dispose();
  });

  it('a world without a character: queries never see the placeholder capsule; its step moves nothing', async () => {
    // The placeholder sits right on the ray's path.
    const port = await portOf(config({ noCharacter: true, character: { position: { x: 0, y: 0, z: 8 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } } }));
    expect(port.raycast!(FROM, DOWN_Z, 100)?.entityId).toBe('near-default');
    port.stageCharacterMove({ x: 1, y: -1, z: 0 });
    const r = port.step();
    expect(r.applied).toEqual({ x: 0, y: 0, z: 0 });
    expect(r.requested).toEqual({ x: 0, y: 0, z: 0 });
    expect(r.grounded).toBe(false);
    port.dispose();
  });

  it('refuses a bad layer list', async () => {
    const made = await createPhysicsPort3D(config({ layers: ['default'] }));
    expect(made.ok).toBe(false);
  });
});
