/**
 * Seams and tight spaces on the Rapier 3D port (real WASM). Where colliders
 * or a mesh's triangles meet on one flat face (stacked boxes, a block
 * layer's per-cell wall and floor triangles, two chunk pieces side by side),
 * the edge between them is not a corner of the surface: a character sliding
 * down such a wall is never grounded on it and falls to the floor, and one
 * walking across such a floor keeps its speed and height. A small capsule
 * walks under a ceiling a default one is stopped by. An init aborted while
 * it runs returns cancelled, and a later init works.
 */
import { describe, expect, it } from 'vitest';

import type { CharacterMoveResult3D, PhysicsInitConfig3D, PhysicsPort3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
type V3 = [number, number, number];

const box = (entityId: string, min: V3, max: V3): StaticColliderSpec3D => ({
  entityId,
  shape: { type: 'box', hx: (max[0] - min[0]) / 2, hy: (max[1] - min[1]) / 2, hz: (max[2] - min[2]) / 2 },
  position: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
  rotation: IDENTITY,
});

/**
 * A box of cells as a block layer's chunk mesh makes it: only its outer
 * faces, each cut into one quad (two triangles) per cell, wound outward.
 */
function cellsMesh(entityId: string, min: V3, max: V3, cell: V3): StaticColliderSpec3D {
  const vertices: number[] = [];
  const indices: number[] = [];
  const n = [0, 1, 2].map((a) => Math.round((max[a]! - min[a]!) / cell[a]!));
  for (let a = 0; a < 3; a++) {
    const [b, c] = [(a + 1) % 3, (a + 2) % 3] as [number, number];
    for (const side of [0, 1]) {
      for (let i = 0; i < n[b]!; i++) {
        for (let j = 0; j < n[c]!; j++) {
          const corner = (di: number, dj: number): number => {
            const p: V3 = [0, 0, 0];
            p[a] = side === 0 ? min[a]! : max[a]!;
            p[b] = min[b]! + (i + di) * cell[b]!;
            p[c] = min[c]! + (j + dj) * cell[c]!;
            vertices.push(...p);
            return vertices.length / 3 - 1;
          };
          const q = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
          // (b, c, a) is right-handed: counter-clockwise in (b, c) faces +a.
          if (side === 1) indices.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
          else indices.push(q[0]!, q[2]!, q[1]!, q[0]!, q[3]!, q[2]!);
        }
      }
    }
  }
  return { entityId, shape: { type: 'mesh', vertices, indices }, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY };
}

async function portOf(statics: StaticColliderSpec3D[], start: V3, capsule: { radius: number; halfHeight: number } = { radius: 0.3, halfHeight: 0.6 }): Promise<PhysicsPort3D> {
  const config: PhysicsInitConfig3D = {
    character: { position: { x: start[0], y: start[1], z: start[2] }, ...capsule, offset: { x: 0, y: 0, z: 0 } },
    statics,
    solver: { hz: HZ, gravityY: G },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  };
  const made = await createPhysicsPort3D(config);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

/** Walk at `vx` m/s along x for `steps` steps, the fall staged while not grounded (the runtime's rule); each step's result. */
function walk(port: PhysicsPort3D, vx: number, steps: number): CharacterMoveResult3D[] {
  let v = 0;
  let grounded = false;
  const out: CharacterMoveResult3D[] = [];
  for (let i = 0; i < steps; i++) {
    v = grounded ? 0 : Math.max(-30, v + G / HZ);
    port.stageCharacterMove({ x: vx / HZ, y: v / HZ, z: 0 });
    const r = port.step();
    grounded = r.grounded;
    out.push(r);
  }
  return out;
}

/** Feet of the default capsule resting on y = 0: radius + half height + skin. */
const REST = 0.91;
const FLOOR = box('floor', [-10, -1, -3], [10, 0, 3]);

describe('internal edges: a seam on a flat face is not a corner', () => {
  const walls: [string, StaticColliderSpec3D[]][] = [
    ['stacked boxes', Array.from({ length: 7 }, (_, i) => box(`row-${i}`, [2, i * 0.5, -1], [4, (i + 1) * 0.5, 1]))],
    ['a block layer\'s cell mesh', [cellsMesh('cells', [2, 0, -1], [4, 3.5, 1], [1, 0.5, 1])]],
  ];
  for (const [name, wall] of walls) {
    it(`sliding down a wall of ${name} while pressing into it, the character is never grounded on it and lands on the floor`, async () => {
      const port = await portOf([FLOOR, ...wall], [1.6, 3, 0]);
      const steps = walk(port, 4, 240);
      port.dispose();
      const held = steps.filter((r) => r.grounded && r.position.y > REST + 0.05);
      expect(held.map((r) => r.position.y)).toEqual([]);
      for (const r of steps) expect(r.position.x).toBeLessThan(2 - 0.3 + 1e-3);
      expect(steps.at(-1)!.grounded).toBe(true);
      expect(steps.at(-1)!.position.y).toBeCloseTo(REST, 2);
    });
  }

  const floors: [string, StaticColliderSpec3D[]][] = [
    ['abutting boxes', Array.from({ length: 12 }, (_, i) => box(`tile-${i}`, [i - 2, -1, -2], [i - 1, 0, 2]))],
    ['two cell-mesh pieces meeting at a chunk seam', [cellsMesh('piece-0', [-2, -1, -2], [4, 0, 2], [1, 0.5, 1]), cellsMesh('piece-1', [4, -1, -2], [10, 0, 2], [1, 0.5, 1])]],
  ];
  for (const [name, floor] of floors) {
    it(`walking across a floor of ${name}, the character keeps its speed and height`, async () => {
      const port = await portOf(floor, [-1, REST, 0]);
      const steps = walk(port, 6, 120);
      port.dispose();
      let x = steps[0]!.position.x;
      for (const r of steps.slice(1)) {
        expect(r.grounded).toBe(true);
        // Within the controller's own sub-millimetre jitter on flat ground: no bump, no catch.
        expect(Math.abs(r.position.y - REST)).toBeLessThan(1e-3);
        expect(Math.abs(r.position.x - x - 6 / HZ)).toBeLessThan(1e-3);
        x = r.position.x;
      }
      expect(steps.at(-1)!.position.x).toBeGreaterThan(4.5);
    });
  }
});

describe('a small capsule under a low ceiling', () => {
  // A ceiling from x 2 to 6 whose underside is 0.85 m above the floor.
  const statics = [FLOOR, box('ceiling', [2, 0.85, -2], [6, 1.5, 2])];

  it('a 0.7 m capsule walks under it; the default 1.8 m one stops at its edge', async () => {
    const small = { radius: 0.2, halfHeight: 0.15 };
    const port = await portOf(statics, [0, 0.36, 0], small);
    const under = walk(port, 3, 300);
    port.dispose();
    expect(under.at(-1)!.position.x).toBeGreaterThan(6.5);
    for (const r of under) expect(r.position.y).toBeCloseTo(0.36, 2);
    expect(under.some((r) => r.position.x > 3 && r.position.x < 5 && r.grounded)).toBe(true);
    const tall = await portOf(statics, [0, REST, 0]);
    const blocked = walk(tall, 3, 240);
    tall.dispose();
    expect(blocked.at(-1)!.position.x).toBeLessThan(2 - 0.3 + 1e-3);
    expect(blocked.at(-1)!.position.x).toBeGreaterThan(1.6);
  });
});

describe('an aborted init', () => {
  it('aborted while it runs: cancelled, nothing returned; a later init works and steps', async () => {
    const config: PhysicsInitConfig3D = {
      character: { position: { x: 0, y: REST, z: 0 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
      statics: [FLOOR],
      solver: { hz: HZ, gravityY: G },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    };
    const ctl = new AbortController();
    const pending = createPhysicsPort3D(config, ctl.signal);
    ctl.abort();
    const r = await pending;
    expect(r).toMatchObject({ ok: false, error: { code: 'physics_init_cancelled' } });
    expect('port' in r).toBe(false);
    const port = await portOf([FLOOR], [0, REST, 0]);
    const steps = walk(port, 3, 12);
    port.dispose();
    expect(steps.at(-1)!.position.x).toBeCloseTo((3 * 12) / HZ, 4);
    expect(steps.at(-1)!.grounded).toBe(true);
  });
});
