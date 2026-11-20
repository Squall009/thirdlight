/**
 * The walk graph on the generated town (the world rules' derive in this process, 16³ sections, a box of 6 × 3 × 6
 * chunks, 96 m): from a house's room to the street the path goes through its door; from its ground floor to its
 * upper floor up its stairs; the two levels' cost against one A* over every cell; a wall over the door makes the
 * street unreachable from inside (the house's windows are 1 m high: no way out), dug again it is found. The houses
 * are found from the generator's own lots, not from the graph.
 */
import { describe, expect, it } from 'vitest';
import { STOREY, HOUSE_AT_X, HOUSE_AT_Z, LOT, lotOf, TOWN_SEED } from './town';
import { walkWorld, WALK_GRID } from './walk-world';
import { townWorld } from './worlds';
import { voxel, VOXEL_ROLE, WalkGraph, WalkQueries, type WalkGraphView, type WalkPathAnswer, type WalkQueryOptions } from '@thirdlight/voxel';

type P3 = readonly [number, number, number];

/** The box's chunks are the world's moved by 8 (world cell = box cell + 256). */
const SHIFT = 256;

function ask(g: WalkGraph, from: P3, to: P3, options: WalkQueryOptions = {}): WalkPathAnswer {
  const q = new WalkQueries(g);
  let out: WalkPathAnswer | null = null;
  q.path(from, to, options, (a) => (out = a));
  while (out === null) q.serve(Infinity);
  return out;
}

const cellsOf = (a: WalkPathAnswer): P3[] => {
  const out: P3[] = [];
  for (let k = 0; k < a.cells.length; k += 3) out.push([a.cells[k]!, a.cells[k + 1]!, a.cells[k + 2]!]);
  return out;
};

describe('walk graph on the town', () => {
  const world = townWorld({ footprint: 512 });
  const w = walkWorld(world, [-3, -1, -3], [2, 1, 2], [8, 0, 8]);
  const view: WalkGraphView = { grid: WALK_GRID, sections: { edge: 16, shift: 4, mask: 15 } as never, derivedOf: (sx, sy, sz) => w.view().derivedOf(sx, sy, sz) };
  const g = new WalkGraph(view, 0.5);
  for (let cx = -3; cx <= 2; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = -3; cz <= 2; cz++) g.touch(cx, cy, cz);
  g.update();
  // A house of two storeys or more in the world grid, whole inside the box (box x and z −96 … 95: lots 4 … 7).
  let house: { i: number; j: number; w: number; d: number } | null = null;
  for (let i = 4; i <= 6 && house === null; i++) for (let j = 4; j <= 6 && house === null; j++) {
    const lot = lotOf(i, j, TOWN_SEED);
    if (lot.house !== null && lot.yaw === 0 && lot.house.storeys >= 2) house = { i, j, w: lot.house.w, d: lot.house.d };
  }
  const h = house!;
  /** A house-local cell in box cells. */
  const at = (x: number, y: number, z: number): P3 => [h.i * LOT + HOUSE_AT_X + x - SHIFT, y, h.j * LOT + HOUSE_AT_Z + z - SHIFT];
  const mid = h.w >> 1;
  const room = at(mid, 1, 4);
  const street = at(mid, 0, -6);

  it('walks from a room to the street through its door, and up its stairs to the floor above', () => {
    console.log(`[walk graph town] house lot ${h.i},${h.j} (${h.w / 2} × ${h.d / 2} m), ${JSON.stringify(g.stats())}, ${(g.bytes / 1e6).toFixed(2)} MB`);
    const out = ask(g, room, street, { flatFirst: 0 });
    expect(out.status).toBe('found');
    expect(out.hierarchy).toBe(true);
    const door = cellsOf(out).filter(([x, , z]) => z === at(0, 0, 0)[2] && (x === at(mid - 1, 0, 0)[0] || x === at(mid, 0, 0)[0]));
    expect(door.length).toBeGreaterThan(0);
    expect(door.every(([, y]) => y === 1)).toBe(true);
    const flat = ask(g, room, street, { hierarchy: false });
    expect(flat.status).toBe('found');
    expect(out.cost).toBeGreaterThanOrEqual(flat.cost - 1e-9);
    expect(out.cost).toBeLessThanOrEqual(flat.cost * 1.08);
    // The floor above (storey 1's floor is at y 6, so it is stood on at 7), far from the stairs (x 1 … 2, z 2 … 6).
    const upper = at(h.w - 3, STOREY + 1, h.d - 3);
    const up = ask(g, room, upper, { flatFirst: 0 });
    expect(up.status).toBe('found');
    const stairs = cellsOf(up).filter(([x, y, z]) => y > 1 && y < STOREY + 1 && x >= at(1, 0, 0)[0] && x <= at(2, 0, 0)[0] && z >= at(0, 0, 2)[2] && z <= at(0, 0, 6)[2]);
    expect(stairs.length).toBe(STOREY - 1);
    console.log(`[walk graph town] room → street ${out.cost.toFixed(2)} m (one A* ${flat.cost.toFixed(2)}), ${JSON.stringify(out.run)} / ${JSON.stringify(flat.run)}; room → upper floor ${up.cost.toFixed(2)} m ${JSON.stringify(up.run)}`);
  });

  it('answers unreachable once the door is walled up, found again once it is dug', () => {
    const doorCells = [at(mid - 1, 1, 0), at(mid, 1, 0)];
    const wall = voxel(5, VOXEL_ROLE.wall, 15);
    const opening = voxel(5, VOXEL_ROLE.opening, 0);
    const chunks = new Set<string>();
    const set = (v: typeof wall): void => {
      for (const [x, , z] of doorCells) for (let y = 1; y <= 4; y++) {
        w.store.setVoxel(x, y, z, v);
        chunks.add([x >> 5, y >> 5, z >> 5].join(','));
      }
      for (const k of chunks) {
        const [cx, cy, cz] = k.split(',').map(Number) as [number, number, number];
        w.rederive(cx, cy, cz);
        g.touch(cx, cy, cz);
      }
      g.update();
    };
    const before = g.stats().built;
    set(wall);
    expect(g.stats().built - before).toBe(chunks.size);
    expect(ask(g, room, street).status).toBe('unreachable');
    set(opening);
    expect(ask(g, room, street).status).toBe('found');
  });
});
