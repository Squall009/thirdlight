/**
 * The 3D port's script queries (real rapier3d-compat WASM) —
 * collision layers as interaction groups (a collider without layers is in
 * "default"), the accept predicate, the hit point, filtered overlaps, and a
 * world without a character (the capsule takes no part in queries or
 * contacts; its step moves nothing).
 */
import { describe, expect, it } from 'vitest';

import type { PhysicsInitConfig3D, PhysicsPort3D, PhysicsVec3, StaticColliderSpec3D } from '@thirdlight/runtime';

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

describe('sphere casts on sloped heightfields', () => {
  // Bumpy ground of 30 × 30 cells of 0.5 m (a mesh of it within the port's vertex limit): every cell bends across
  // its diagonal, slopes up to ~1:1.
  const N = 30;
  const CELL = 0.5;
  const heights = new Float32Array((N + 1) * (N + 1));
  for (let i = 0; i <= N; i++) for (let k = 0; k <= N; k++) heights[i * (N + 1) + k] = (2 + 1.5 * Math.sin(i * 0.9) + 1.2 * Math.cos(k * 1.3) + ((i * 7 + k * 3) % 5) * 0.2) * CELL;
  /**
   * The same ground as a mesh, each cell split as the heightfield splits it, (+x, min z) to (min x, +z), or the
   * other way (`main`: (min x, min z) to (+x, +z), as a field turned a quarter about +y splits it).
   */
  const mesh = (main: boolean, ys: Float32Array = heights): StaticColliderSpec3D['shape'] => {
    const vertices: number[] = [];
    const indices: number[] = [];
    const n = N + 1;
    for (let i = 0; i <= N; i++) for (let k = 0; k <= N; k++) vertices.push(i * CELL, ys[i * n + k]!, k * CELL);
    for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) {
      const a = i * n + k;
      if (main) indices.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
      else indices.push(a, a + 1, a + n, a + n, a + 1, a + n + 1);
    }
    return { type: 'mesh', vertices, indices, oriented: true };
  };
  const ground = (shape: StaticColliderSpec3D['shape'], rotation = IDENTITY, position = { x: -8, y: 0, z: -8 }): StaticColliderSpec3D => ({ entityId: 'ground', shape, position, rotation });

  it('land where they land on the same triangles as a mesh, turned or not; a graze under 5 mm aside', async () => {
    const field = { type: 'heightfield' as const, cellsX: N, cellsZ: N, cellX: CELL, cellZ: CELL, heights };
    // A quarter turn about +y: the field's own x runs along the world's −z, placed so it covers the same square.
    const QUARTER = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const turned = new Float32Array(heights.length);
    for (let u = 0; u <= N; u++) for (let v = 0; v <= N; v++) turned[u * (N + 1) + v] = heights[v * (N + 1) + (N - u)]!;
    const worlds = await Promise.all([
      ground(field),
      ground(mesh(false)),
      ground({ ...field, heights: turned }, QUARTER, { x: -8, y: 0, z: -8 + N * CELL }),
      ground(mesh(true)),
    ].map((g) => portOf(config({ noCharacter: true, statics: [g], layers: [] }))));
    const [hf, tmA, hfTurned, tmMain] = worlds as [PhysicsPort3D, PhysicsPort3D, PhysicsPort3D, PhysicsPort3D];
    let seed = 7;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let casts = 0;
    let grazes = 0;
    let worst = 0;
    for (let t = 0; t < 600; t++) {
      const r = [0.05, 0.15, 0.3, 0.5][t % 4]!;
      const from = { x: (rnd() - 0.5) * 11, y: 5, z: (rnd() - 0.5) * 11 };
      const d = { x: (rnd() - 0.5) * 2, y: -(0.1 + rnd()), z: (rnd() - 0.5) * 2 };
      for (const [p, tm] of [[hf, tmA], [hfTurned, tmMain]] as const) {
        const want = tm.castSphere!(from, d, r, 30);
        if (want === null) continue;
        casts++;
        const got = p.castSphere!(from, d, r, 30);
        const off = got === null ? Infinity : Math.abs(got.distance - want.distance);
        if (off > 0.01) {
          // The mesh's touch is a graze when a ball 5 mm thinner passes it and lands where the field's cast does.
          const thinner = tm.castSphere!(from, d, r - 0.005, 30);
          expect(got, `${JSON.stringify(from)} ${JSON.stringify(d)} r ${r}`).not.toBeNull();
          expect(Math.abs(thinner!.distance - got!.distance), `${JSON.stringify(from)} ${JSON.stringify(d)} r ${r}`).toBeLessThan(0.01);
          grazes++;
          continue;
        }
        worst = Math.max(worst, off);
      }
    }
    expect(casts).toBeGreaterThan(800);
    expect(grazes).toBeLessThan(casts * 0.05);
    expect(worst).toBeLessThan(0.01);
    for (const p of worlds) p.dispose();
  });

  it('a character walking and falling over them goes where it goes on the same triangles as a mesh', async () => {
    // The bumps at 0.3 of their height (slopes it walks up). At full height a walk square into a slope too steep to
    // climb slid off to opposite sides on the two shapes (a millimetre decides the side), which is not a late sweep.
    const gentle = Float32Array.from(heights, (h) => h * 0.3);
    const field = { type: 'heightfield' as const, cellsX: N, cellsZ: N, cellX: CELL, cellZ: CELL, heights: gentle };
    let worst = 0;
    let steps = 0;
    for (const [dx, dz] of [[1, 0], [0, 1], [-0.6, 0.8], [0.7, -0.7], [-1, -0.2]] as const) {
      const start = { x: -dx * 4, y: 3, z: -dz * 4 };
      const ports = await Promise.all([ground(field), ground(mesh(false, gentle))].map((g) => portOf(config({ statics: [g], layers: [], character: { position: start, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0.9, z: 0 } } }))));
      const vy = [0, 0];
      const last = ports.map((p) => p.step());
      // 6 m/s across the bumps for 1.5 s at 120 Hz, falling under gravity whenever not grounded (it starts in the air).
      for (let i = 0; i < 180; i++) {
        ports.forEach((p, j) => {
          vy[j] = last[j]!.grounded ? -0.5 : Math.max(-30, vy[j]! - 19.62 / 120);
          p.stageCharacterMove({ x: (dx * 6) / 120, y: vy[j]! / 120, z: (dz * 6) / 120 });
          last[j] = p.step();
        });
        const [a, b] = last as unknown as [{ position: PhysicsVec3 }, { position: PhysicsVec3 }];
        // A late sweep would put the two centimetres to metres apart at once; the shapes' own contacts at triangle
        // edges differ by a few millimetres a step up a slope (measured ≤ 1.1 cm in one step, 1.04 cm over the walk).
        const e = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
        worst = Math.max(worst, e);
        steps++;
      }
      for (const p of ports) p.dispose();
    }
    expect(steps).toBe(900);
    expect(worst).toBeLessThan(0.02);
  });
});
