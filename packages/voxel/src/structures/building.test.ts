/**
 * The building generator against the real store: its definition's checks,
 * wings joined in voxel space (L, T, a courtyard ring), every roof shape on
 * a rectangle and an L, buildings closed to the outside, and the same
 * voxels whatever the chunk edge or the order.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid, type ChunkGrid } from '../coords';
import { createDenseChunk } from '../dense-chunk';
import { createWorldStore } from '../palette-store';
import { valueOf, VOXEL_ROLE, type VoxelRecord } from '../record';
import type { VoxelStoreCandidate } from '../store';
import { anchoredDefinition, BUILDING_GENERATOR, buildingPlan, canonicalStructureDefinition } from './building';
import { boxChunks } from './generator';
import { StructureDefinitionError, type StructureDefinition } from './definition';

const R = VOXEL_ROLE;
const G32 = chunkGrid(32);
const MAT = { wall: 10, floor: 14, roof: 13, foundation: 6, stair: 14 };

type Pt = [number, number];
const rect = (id: string, x0: number, z0: number, x1: number, z1: number): { id: string; points: Pt[] } => ({ id, points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });

function def(over: Record<string, unknown> = {}): StructureDefinition {
  return canonicalStructureDefinition({ footprint: [rect('main', 0, 0, 16, 12)], storeys: 2, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'gable', overhang: 1, axis: 'x' }, materials: MAT, openings: [], stairs: [], generator: 1, ...over });
}

function generate(d: StructureDefinition, grid: ChunkGrid = G32): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  const out = createDenseChunk(grid);
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(d))) if (BUILDING_GENERATOR.chunk(d, grid, c.cx, c.cy, c.cz, out)) s.importChunk(c.cx, c.cy, c.cz, out);
  return s;
}

const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
const at = (s: VoxelStoreCandidate, x: number, y: number, z: number): VoxelRecord => ({ ...s.voxelAt(x, y, z, v) });
const roleAt = (s: VoxelStoreCandidate, x: number, y: number, z: number): number => (at(s, x, y, z).material === 0 ? -1 : at(s, x, y, z).role);

/** Cells of the rectangles' union (the test's own reading of the plan, not the generator's). */
function unionOf(rects: readonly [number, number, number, number][]): (x: number, z: number) => boolean {
  return (x, z) => rects.some(([x0, z0, x1, z1]) => x >= x0 && x < x1 && z >= z0 && z < z1);
}

/** Air cells reached from outside the building's box through open cells (air and openings), 6-connected. */
function reachedFromOutside(s: VoxelStoreCandidate, d: StructureDefinition): (x: number, y: number, z: number) => boolean {
  const b = BUILDING_GENERATOR.box(d);
  const lo = [b.minX - 1, b.minY - 1, b.minZ - 1];
  const hi = [b.maxX + 1, b.maxY + 1, b.maxZ + 1];
  const nx = hi[0]! - lo[0]! + 1;
  const ny = hi[1]! - lo[1]! + 1;
  const nz = hi[2]! - lo[2]! + 1;
  const seen = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number): number => ((x - lo[0]!) * nz + (z - lo[2]!)) * ny + (y - lo[1]!);
  const open = (x: number, y: number, z: number): boolean => {
    const r = roleAt(s, x, y, z);
    return r === -1 || r === R.opening;
  };
  const stack: number[] = [lo[0]!, lo[1]!, lo[2]!];
  seen[idx(lo[0]!, lo[1]!, lo[2]!)] = 1;
  while (stack.length > 0) {
    const z = stack.pop()!;
    const y = stack.pop()!;
    const x = stack.pop()!;
    for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const a = x + ox;
      const c = y + oy;
      const e = z + oz;
      if (a < lo[0]! || c < lo[1]! || e < lo[2]! || a > hi[0]! || c > hi[1]! || e > hi[2]!) continue;
      const i = idx(a, c, e);
      if (seen[i] || !open(a, c, e)) continue;
      seen[i] = 1;
      stack.push(a, c, e);
    }
  }
  return (x, y, z) => seen[idx(x, y, z)] === 1;
}

const SHAPES = ['flat', 'gable', 'hip'] as const;

describe('the structure definition', () => {
  const bad = (over: Record<string, unknown>, path: string, message: RegExp): void => {
    let err: unknown;
    try {
      def(over);
    } catch (e) {
      err = e;
    }
    expect(err, JSON.stringify(over)).toBeInstanceOf(StructureDefinitionError);
    expect((err as StructureDefinitionError).path).toBe(path);
    expect((err as Error).message).toMatch(message);
  };

  it('is rebuilt field by field: unknown fields refused, an opening\'s prop kept only when given, equal input equal output', () => {
    const a = def({ openings: [{ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0 }] });
    expect(a.openings[0]).toEqual({ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0 });
    expect(def({ openings: [{ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0, prop: 'oak-door' }] }).openings[0]!.prop).toBe('oak-door');
    expect(JSON.stringify(def())).toBe(JSON.stringify(def()));
    bad({ colour: 'red' }, '/colour', /unknown field/);
    bad({ roof: { shape: 'gable', overhang: 1, axis: 'x', pitch: 2 } }, '/roof/pitch', /unknown field/);
  });

  it('refuses outlines that are not rectilinear, simple polygons, with the point to change', () => {
    bad({ footprint: [{ id: 'a', points: [[0, 0], [8, 0], [8, 8]] }] }, '/footprint/0/points', /at least 4 corners/);
    bad({ footprint: [{ id: 'a', points: [[0, 0], [8, 0], [10, 8], [0, 8]] }] }, '/footprint/0/points/2', /diagonal: walls run along x or z/);
    bad({ footprint: [{ id: 'a', points: [[0, 0], [4, 0], [8, 0], [8, 8], [0, 8]] }] }, '/footprint/0/points/1', /straight run/);
    bad({ footprint: [{ id: 'a', points: [[0, 0], [8, 0], [8, 0], [8, 8], [0, 8]] }] }, '/footprint/0/points/2', /repeats point 1/);
    // A figure of eight: two squares meeting at a corner, drawn as one outline.
    bad({ footprint: [{ id: 'a', points: [[0, 0], [4, 0], [4, 8], [8, 8], [8, 4], [0, 4]] }] }, '/footprint/0/points', /cross or touch/);
    bad({ footprint: [{ id: 'a', points: [[0, 0], [8.5, 0], [8.5, 8], [0, 8]] }] }, '/footprint/0/points/1/0', /whole number/);
    bad({ footprint: [] }, '/footprint', /at least one polygon/);
    bad({ footprint: [rect('a', 0, 0, 8, 8), rect('a', 8, 0, 16, 8)] }, '/footprint/1/id', /two polygons are named "a"/);
  });

  it('refuses openings off an outside wall, past their edge or storey, or over each other', () => {
    const op = (o: Record<string, unknown>): Record<string, unknown> => ({ openings: [{ id: 'w', polygon: 'main', edge: 0, storey: 0, at: 2, width: 2, height: 2, sill: 1, ...o }] });
    bad(op({ polygon: 'wing' }), '/openings/0/polygon', /polygon "wing", which the footprint does not have/);
    bad(op({ edge: 4 }), '/openings/0/edge', /edges 0 to 3/);
    bad(op({ storey: 2 }), '/openings/0/storey', /storeys 0 to 1/);
    bad(op({ at: 15 }), '/openings/0/width', /past its edge's end/);
    bad(op({ sill: 3, height: 3 }), '/openings/0/height', /more than the 5 rows/);
    bad({ openings: [{ id: 'a', polygon: 'main', edge: 0, storey: 0, at: 2, width: 3, height: 2, sill: 1 }, { id: 'b', polygon: 'main', edge: 0, storey: 0, at: 4, width: 2, height: 2, sill: 2 }] }, '/openings/1', /overlaps opening "a"/);
    // Edge 1 of the second square (x = 16, z 0…12) is the first square's... no: the wing joins along main's edge 1.
    const wing = { footprint: [rect('main', 0, 0, 16, 12), rect('wing', 16, 0, 24, 12)] };
    bad({ ...wing, openings: [{ id: 'd', polygon: 'main', edge: 1, storey: 0, at: 4, width: 2, height: 4, sill: 0 }] }, '/openings/0', /inside the building at cell \(15, 4\)/);
    // The same edge where it is outside (a shorter wing) is fine.
    expect(() => def({ footprint: [rect('main', 0, 0, 16, 12), rect('wing', 16, 0, 24, 4)], openings: [{ id: 'd', polygon: 'main', edge: 1, storey: 0, at: 6, width: 2, height: 4, sill: 0 }] })).not.toThrow();
  });

  it('refuses stairs outside their polygon, in a wall, from the top storey or over each other', () => {
    const st = (s: Record<string, unknown>): Record<string, unknown> => ({ stairs: [{ id: 's', polygon: 'main', from: 0, at: [1, 2], facing: '+z', ...s }] });
    expect(() => def(st({}))).not.toThrow();
    bad(st({ from: 1 }), '/stairs/0/from', /needs a storey above it/);
    bad(st({ at: [0, 2] }), '/stairs/0', /step 1 at cell \(0, 2\) is in a wall/);
    bad(st({ at: [1, 8] }), '/stairs/0', /step 4 at cell \(1, 11\) is in a wall/);
    bad(st({ at: [1, -3] }), '/stairs/0', /outside polygon "main"/);
    bad(st({ polygon: 'x' }), '/stairs/0/polygon', /which the footprint does not have/);
    bad({ stairs: [{ id: 'a', polygon: 'main', from: 0, at: [1, 2], facing: '+z' }, { id: 'b', polygon: 'main', from: 0, at: [2, 2], facing: '+z' }] }, '/stairs/1', /overlaps stair "a"/);
    bad({ stairs: [{ id: 'a', polygon: 'main', from: 0, at: [2, 1], facing: '+x' }, { id: 'b', polygon: 'main', from: 0, at: [3, 6], facing: '-z' }] }, '/stairs', /landing .* lies over another stair/);
  });

  it('refuses unknown generator versions, materials and roof shapes', () => {
    bad({ generator: 2 }, '/generator', /open it with a newer engine/);
    bad({ materials: { ...MAT, roof: 0 } }, '/materials/roof', /material id/);
    bad({ roof: { shape: 'mansard', overhang: 1, axis: 'x' } }, '/roof/shape', /flat, gable, hip/);
    bad({ storeyHeight: 1 }, '/storeyHeight', /from 2/);
  });
});

describe('the building generator', () => {
  it('joins wings in voxel space: L, T and a courtyard ring have walls exactly on the union\'s outline, junction cells in, none inside', () => {
    const cases: [string, [number, number, number, number][]][] = [
      ['L', [[0, 0, 20, 10], [0, 10, 10, 24]]],
      ['T', [[0, 0, 24, 10], [8, 10, 16, 20]]],
      ['overlapping', [[0, 0, 20, 12], [6, 4, 30, 18]]],
      ['ring', [[0, 0, 20, 4], [0, 16, 20, 20], [0, 4, 4, 16], [16, 4, 20, 16]]],
    ];
    for (const [name, rects] of cases) {
      const d = def({ footprint: rects.map(([a, b, c, e], k) => rect(`p${k}`, a, b, c, e)), roof: { shape: 'hip', overhang: 1, axis: 'x' } });
      const s = generate(d);
      const inU = unionOf(rects);
      let walls = 0;
      for (let x = -2; x < 32; x++) for (let z = -2; z < 26; z++) {
        let edge = false;
        for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) edge ||= !inU(x + ox, z + oz);
        const want = inU(x, z) && edge ? R.wall : -1;
        for (const y of [2, 7]) expect(roleAt(s, x, y, z), `${name} (${x}, ${y}, ${z})`).toBe(want);
        if (want === R.wall) walls++;
        // The ground floor's slab under the whole union, foundation down two rows, nothing under the eaves.
        for (const y of [0, -1, -2]) expect(roleAt(s, x, y, z), `${name} foundation (${x}, ${y}, ${z})`).toBe(inU(x, z) ? R.foundation : -1);
        expect(roleAt(s, x, -3, z)).toBe(-1);
      }
      expect(walls, name).toBeGreaterThan(40);
    }
    // The L's inner corner cell, whose only outside neighbour is diagonal, is wall: the corner is closed face to face.
    const l = generate(def({ footprint: [rect('a', 0, 0, 20, 10), rect('b', 0, 10, 10, 24)] }));
    expect([roleAt(l, 9, 3, 9), roleAt(l, 10, 3, 9), roleAt(l, 9, 3, 10)]).toEqual([R.wall, R.wall, R.wall]);
    // Where the wings meet there is no wall: the rooms run through.
    for (let x = 1; x < 9; x++) for (const z of [9, 10]) expect(roleAt(l, x, 3, z)).toBe(-1);
    // The courtyard is open to the sky past the overhang.
    const ring = generate(def({ footprint: [rect('a', 0, 0, 20, 4), rect('b', 0, 16, 20, 20), rect('c', 0, 4, 4, 16), rect('d', 16, 4, 20, 16)], roof: { shape: 'hip', overhang: 1, axis: 'x' } }));
    for (let y = -3; y < 30; y++) expect(roleAt(ring, 10, y, 10), `courtyard ${y}`).toBe(-1);
  });

  it('roofs a rectangle flat, gable and hip at 45° with the overhang, the walls meeting them', () => {
    const w = 16;
    const d0 = 12;
    const top = 12;
    for (const shape of SHAPES) for (const axis of ['x', 'z'] as const) {
      const s = generate(def({ roof: { shape, overhang: 1, axis } }));
      for (let x = -1; x <= w; x++) for (let z = -1; z <= d0; z++) {
        const ax = Math.min(x + 1, w - x);
        const az = Math.min(z + 1, d0 - z);
        const rise = shape === 'flat' ? 0 : shape === 'hip' ? Math.min(ax, az) : axis === 'x' ? az : ax;
        const roofs: number[] = [];
        for (let y = top; y < top + 12; y++) if (roleAt(s, x, y, z) === R.roof) roofs.push(y);
        expect(roofs, `${shape} ${axis} (${x}, ${z})`).toEqual([top + rise]);
      }
      expect(roleAt(s, -2, top, 4)).toBe(-1);
      // A gable's end walls rise to the row under the roof; its eave walls stop a cell out and down from the eave.
      if (shape === 'gable') {
        const endX = axis === 'x';
        const [ex, ez] = endX ? [0, 6] : [8, 0];
        const r = top + (endX ? Math.min(ez + 1, d0 - ez) : Math.min(ex + 1, w - ex));
        expect(roleAt(s, ex, r - 1, ez)).toBe(R.wall);
        const [sx, sz] = endX ? [8, 0] : [0, 6];
        expect(roleAt(s, sx, top - 1, sz)).toBe(R.wall);
        expect(roleAt(s, sx, top, sz)).toBe(-1);
      }
    }
  });

  it('roofs an L, a T and a ring as one surface (the highest of each polygon\'s roof), and closes every room against the outside', () => {
    const plans: [string, [number, number, number, number][]][] = [
      ['rect', [[0, 0, 16, 12]]],
      ['L', [[0, 0, 20, 10], [0, 10, 10, 24]]],
      ['T', [[0, 0, 24, 10], [8, 10, 16, 20]]],
      ['ring', [[0, 0, 20, 4], [0, 16, 20, 20], [0, 4, 4, 16], [16, 4, 20, 16]]],
    ];
    for (const [name, rects] of plans) for (const shape of SHAPES) for (const overhang of [0, 1, 2]) {
      const d = def({ footprint: rects.map(([a, b, c, e], k) => rect(`p${k}`, a, b, c, e)), roof: { shape, overhang, axis: 'x' } });
      const s = generate(d);
      const plan = buildingPlan(d);
      const what = `${name} ${shape} overhang ${overhang}`;
      const inU = unionOf(rects);
      // A roof over every column of the union, and neighbouring columns over the rooms at most a row apart (one 45° surface).
      for (let x = plan.box.minX; x <= plan.box.maxX; x++) for (let z = plan.box.minZ; z <= plan.box.maxZ; z++) {
        const ry = plan.roofY[(x - plan.x0) * plan.d + (z - plan.z0)]!;
        if (inU(x, z)) expect(ry, `${what} (${x}, ${z})`).toBeGreaterThanOrEqual(12);
        for (const [ox, oz] of [[1, 0], [0, 1]] as const) {
          const n = plan.roofY[(x + ox - plan.x0) * plan.d + (z + oz - plan.z0)] ?? ry;
          // Over the rooms; past the walls a verge may end above another wing's eave.
          if (inU(x, z) && inU(x + ox, z + oz)) expect(Math.abs(n - ry), `${what} step at (${x}, ${z})`).toBeLessThanOrEqual(1);
        }
      }
      // Closed: no room or attic cell is reached from outside (there are no openings).
      const out = reachedFromOutside(s, d);
      let rooms = 0;
      for (let x = plan.box.minX; x <= plan.box.maxX; x++) for (let z = plan.box.minZ; z <= plan.box.maxZ; z++) {
        const col = (x - plan.x0) * plan.d + (z - plan.z0);
        if (!inU(x, z) || plan.wall[col]) continue;
        for (let y = 1; y < plan.roofY[col]!; y++) {
          if (roleAt(s, x, y, z) !== -1) continue;
          rooms++;
          if (out(x, y, z)) expect.fail(`${what}: room or attic cell (${x}, ${y}, ${z}) is reached from outside`);
        }
      }
      expect(rooms, what).toBeGreaterThan(500);
    }
  });

  it('writes floors with a hole over each stair, steps of one row a cell, openings in their wall, and opens a room to the outside only through them', () => {
    const d = def({
      stairs: [{ id: 's', polygon: 'main', from: 0, at: [1, 2], facing: '+z' }],
      openings: [
        { id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0 },
        { id: 'win', polygon: 'main', edge: 1, storey: 1, at: 3, width: 2, height: 2, sill: 1 },
      ],
    });
    const s = generate(d);
    for (let k = 0; k < 5; k++) for (const x of [1, 2]) {
      expect(roleAt(s, x, 1 + k, 2 + k), `step ${k}`).toBe(R.stair);
      expect(roleAt(s, x, 6, 2 + k), `hole ${k}`).toBe(-1);
    }
    // The landing is floor; the floor elsewhere is whole.
    expect([roleAt(s, 1, 6, 7), roleAt(s, 2, 6, 7), roleAt(s, 3, 6, 4), roleAt(s, 8, 6, 8)]).toEqual([R.floor, R.floor, R.floor, R.floor]);
    expect(at(s, 1, 3, 4).material).toBe(MAT.stair);
    // The door: x 6, 7 of the z = 0 wall, rows 1…4; the window on edge 1 (x = 15, z 3, 4), storey 1, rows 8, 9.
    for (const x of [6, 7]) for (let y = 1; y <= 5; y++) expect(roleAt(s, x, y, 0), `door ${x} ${y}`).toBe(y <= 4 ? R.opening : R.wall);
    for (const z of [3, 4]) for (const y of [7, 8, 9, 10]) expect(roleAt(s, 15, y, z), `window ${z} ${y}`).toBe(y === 8 || y === 9 ? R.opening : R.wall);
    expect(at(s, 6, 2, 0).material).toBe(MAT.wall);
    const out = reachedFromOutside(s, d);
    expect(out(6, 2, 1)).toBe(true);
    expect(out(8, 8, 6)).toBe(true);
    // Without the openings, the same rooms are closed.
    const shut = def({ stairs: d.stairs });
    expect(reachedFromOutside(generate(shut), shut)(6, 2, 1)).toBe(false);
  });

  it('is a pure function of its definition: the same bytes twice, at chunk edges 16 and 32, in any chunk order', () => {
    const d = def({ footprint: [rect('a', -5, -3, 30, 9), rect('b', 18, 9, 30, 40)], storeys: 3, roof: { shape: 'hip', overhang: 2, axis: 'z' }, stairs: [{ id: 's', polygon: 'b', from: 1, at: [20, 12], facing: '+z' }] });
    const a = generate(d);
    const b = generate(d);
    const c = generate(d, chunkGrid(16));
    const box = BUILDING_GENERATOR.box(d);
    const reversed = createWorldStore(G32);
    const out = createDenseChunk(G32);
    for (const k of boxChunks(G32, box).reverse()) if (BUILDING_GENERATOR.chunk(d, G32, k.cx, k.cy, k.cz, out)) reversed.importChunk(k.cx, k.cy, k.cz, out);
    for (const k of boxChunks(G32, box)) expect(b.encodeChunk(k.cx, k.cy, k.cz)).toEqual(a.encodeChunk(k.cx, k.cy, k.cz));
    let cells = 0;
    for (let x = box.minX - 1; x <= box.maxX + 1; x++) for (let y = box.minY - 1; y <= box.maxY + 1; y++) for (let z = box.minZ - 1; z <= box.maxZ + 1; z++) {
      const want = valueOf(a.voxelAt(x, y, z, v));
      if (want !== 0) cells++;
      expect(valueOf(c.voxelAt(x, y, z, v))).toBe(want);
      expect(valueOf(reversed.voxelAt(x, y, z, v))).toBe(want);
    }
    expect(cells).toBeGreaterThan(5000);
    // Nothing outside its box.
    for (const k of a.chunkKeys()) expect(k).toBeGreaterThanOrEqual(0);
  });

  it('anchors a new structure at the minimum corner of all it writes, and never moves a regenerated one', () => {
    const d = def({ footprint: [rect('main', 40, 30, 56, 42)], stairs: [{ id: 's', polygon: 'main', from: 0, at: [41, 32], facing: '+z' }], roof: { shape: 'gable', overhang: 2, axis: 'x' } });
    const a = anchoredDefinition(d);
    expect(a.footprint[0]!.points[0]).toEqual([2, 2]);
    expect(a.stairs[0]!.at).toEqual([3, 4]);
    const box = BUILDING_GENERATOR.box(a);
    expect([box.minX, box.minY, box.minZ]).toEqual([0, -2, 0]);
    // The overhang changed afterwards: the walls stay on their cells (the eaves reach below 0).
    const wider = def({ ...a, roof: { shape: 'gable', overhang: 3, axis: 'x' } });
    expect(BUILDING_GENERATOR.box(wider).minX).toBe(-1);
    expect(buildingPlan(wider).x0 + 0).toBeLessThan(0);
  });
});
