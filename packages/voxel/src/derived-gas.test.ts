/**
 * The gas part on made cases: which faces a bank shows (against open space only),
 * the two densities each carries, how they merge, the runs up its columns,
 * and that sections and chunks meet without an inner face or a gap.
 */
import { describe, expect, it } from 'vitest';
import { buildApron } from './apron';
import { deriveFromStore, deriveSectionFromStore, deriveSectionPartsWithApron, partsApronRadius, sectionLocalOrigin } from './derive-assembly';
import { gasOfNeighbourhood, gasQuad, gasRun, gasRunAt, joinGas, GAS_REACH_CELLS, type GasPart } from './derived-gas';
import { MEDIUM_FACE } from './derived-medium';
import { chunkGrid, sectionGrid } from './coords';
import { createWorldStore, type PaletteStore } from './palette-store';
import { DERIVED_PART, VOXEL_ROLE } from './record';
import { WORLD_RULES } from './rule-registry';
import { createNeighbourhood } from './assembly';

const grid = chunkGrid(32);
const E = grid.edge;
const C = VOXEL_ROLE;
const ROCK = 2;
const WATER = 6;
const MIST = 31;
const SMOKE = 32;
const F = MEDIUM_FACE;

function box(s: PaletteStore, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: number, role: number, shape = 15): void {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) s.setVoxel(x, y, z, { material, role, shape, wetness: 0 });
}
const ground = (s: PaletteStore, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => box(s, x0, x1, y0, y1, z0, z1, ROCK, C.terrain);
const gas = (s: PaletteStore, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, density = 15, material = MIST): void => box(s, x0, x1, y0, y1, z0, z1, material, C.gas, density);
const gasAt = (s: PaletteStore, cx = 0, cy = 0, cz = 0): GasPart | null | undefined => deriveFromStore(s, cx, cy, cz, WORLD_RULES).gas;

/** Whether two byte arrays hold the same bytes. */
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Per face, the quads and their area in cells², and every quad. */
function facesOf(g: GasPart | null | undefined): { count: number; byFace: Record<number, { quads: number; area: number }>; quads: ReturnType<typeof gasQuad>[] } {
  const byFace: Record<number, { quads: number; area: number }> = {};
  const quads: ReturnType<typeof gasQuad>[] = [];
  for (let k = 0; k < (g?.count ?? 0); k++) {
    const q = gasQuad(g!, k);
    quads.push(q);
    const d = [q.max[0] - q.min[0], q.max[1] - q.min[1], q.max[2] - q.min[2]].filter((v) => v !== 0);
    const f = (byFace[q.face] ??= { quads: 0, area: 0 });
    f.quads++;
    f.area += d[0]! * d[1]!;
  }
  return { count: g?.count ?? 0, byFace, quads };
}

describe('the gas part: faces against open space, merged into quads', () => {
  it('draws a box of gas in the air as its six faces, one quad each, in whole cells, each with the box\'s density and the density behind it', () => {
    const s = createWorldStore(grid);
    gas(s, 4, 7, 5, 6, 8, 12, 9);
    const f = facesOf(gasAt(s));
    expect(f.count).toBe(6);
    expect(f.quads.find((q) => q.face === F.py)).toEqual({ face: F.py, material: MIST, density: 9, behind: 9, min: [4, 7, 8], max: [8, 7, 13] });
    expect(f.quads.find((q) => q.face === F.ny)).toEqual({ face: F.ny, material: MIST, density: 9, behind: 9, min: [4, 5, 8], max: [8, 5, 13] });
    expect(f.quads.find((q) => q.face === F.px)).toEqual({ face: F.px, material: MIST, density: 9, behind: 9, min: [8, 5, 8], max: [8, 7, 13] });
    expect(f.quads.find((q) => q.face === F.nz)).toEqual({ face: F.nz, material: MIST, density: 9, behind: 9, min: [4, 5, 8], max: [8, 7, 8] });
    expect(Object.values(f.byFace).reduce((n, b) => n + b.area, 0)).toBe(2 * (4 * 5 + 4 * 2 + 5 * 2));
  });

  it('gives a sheet one cell thick nothing behind its faces', () => {
    const s = createWorldStore(grid);
    gas(s, 4, 9, 5, 5, 4, 9);
    const f = facesOf(gasAt(s));
    expect(f.quads.find((q) => q.face === F.py)!.behind).toBe(0);
    expect(f.quads.find((q) => q.face === F.ny)!.behind).toBe(0);
    // A side face looks along the sheet: the cell behind it is gas.
    expect(f.quads.find((q) => q.face === F.px)!.behind).toBe(15);
  });

  it('makes no face against the ground a bank lies on, a wall beside it, or ground filled to the surface; a face against ground filled below it', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 15, 0, 3, 0, 15);
    box(s, 10, 10, 4, 8, 4, 9, 3, C.wall);
    gas(s, 4, 9, 4, 5, 4, 9);
    const f = facesOf(gasAt(s));
    expect(f.byFace[F.ny]).toBeUndefined();
    expect(f.byFace[F.px]).toBeUndefined();
    expect(f.byFace[F.py]).toEqual({ quads: 1, area: 36 });
    for (const face of [F.nx, F.pz, F.nz]) expect(f.byFace[face], `face ${face}`).toEqual({ quads: 1, area: 12 });
    // A ground cell beside it: filled to the surface it closes the face, filled below it (open space) it does not.
    s.setVoxel(3, 4, 4, { material: ROCK, role: C.terrain, shape: 15, wetness: 0 });
    expect(facesOf(gasAt(s)).byFace[F.nx]!.area).toBe(11);
    s.setVoxel(3, 4, 4, { material: ROCK, role: C.terrain, shape: 3, wetness: 0 });
    expect(facesOf(gasAt(s)).byFace[F.nx]!.area).toBe(12);
  });

  it('reads water as the air it stands in: fog lying on water has the faces it has over a dry hollow, and the water\'s own faces are what they are without the fog', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 15, 0, 3, 0, 15);
    for (let x = 4; x <= 9; x++) for (let z = 4; z <= 9; z++) for (let y = 2; y <= 3; y++) s.setVoxel(x, y, z, { material: WATER, role: C.liquid, shape: 15, wetness: 0 });
    const dry = deriveFromStore(s, 0, 0, 0, WORLD_RULES).liquid!;
    gas(s, 4, 9, 4, 5, 4, 9);
    const d = deriveFromStore(s, 0, 0, 0, WORLD_RULES);
    expect(same(d.liquid!.quads, dry.quads)).toBe(true);
    // The pool drained (a change only between liquid and air, which feeds the liquid part alone): the same gas part.
    for (let x = 4; x <= 9; x++) for (let z = 4; z <= 9; z++) for (let y = 2; y <= 3; y++) s.setVoxel(x, y, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    const drained = deriveFromStore(s, 0, 0, 0, WORLD_RULES).gas!;
    expect(same(d.gas!.quads, drained.quads)).toBe(true);
    expect(same(d.gas!.runs, drained.runs)).toBe(true);
    const f = facesOf(d.gas);
    expect(f.count).toBe(6);
    expect(f.byFace[F.ny]).toEqual({ quads: 1, area: 36 });
  });

  it('makes no face between two densities or two gases side by side, and splits the faces they share with the air by density and material', () => {
    const s = createWorldStore(grid);
    gas(s, 4, 6, 5, 6, 4, 9, 15);
    gas(s, 7, 9, 5, 6, 4, 9, 6);
    gas(s, 10, 12, 5, 6, 4, 9, 6, SMOKE);
    const f = facesOf(gasAt(s));
    // No face inside the bank: x faces only at its two ends.
    expect(f.quads.filter((q) => q.face === F.px).map((q) => q.min[0])).toEqual([13]);
    expect(f.quads.filter((q) => q.face === F.nx).map((q) => q.min[0])).toEqual([4]);
    const tops = f.quads.filter((q) => q.face === F.py).sort((a, b) => a.min[0] - b.min[0]);
    expect(tops.map((q) => [q.min[0], q.max[0], q.material, q.density, q.behind])).toEqual([[4, 7, MIST, 15, 15], [7, 10, MIST, 6, 6], [10, 13, SMOKE, 6, 6]]);
    // The thin fog's end face has the other gas behind it: its density, whatever its material.
    expect(f.quads.find((q) => q.face === F.nx)).toMatchObject({ density: 15, behind: 15 });
  });

  it('carries a fill\'s soft top as each face\'s own density and the one under it', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 15, 0, 3, 0, 15);
    // Densities up a column as a flood with a 1 m fade writes them: 15, 11, 4.
    gas(s, 4, 9, 4, 4, 4, 9, 15);
    gas(s, 4, 9, 5, 5, 4, 9, 11);
    gas(s, 4, 9, 6, 6, 4, 9, 4);
    const f = facesOf(gasAt(s));
    expect(f.quads.filter((q) => q.face === F.py)).toEqual([{ face: F.py, material: MIST, density: 4, behind: 11, min: [4, 7, 4], max: [10, 7, 10] }]);
    // A side shows a quad a density: the rows do not merge across the gradient.
    const side = f.quads.filter((q) => q.face === F.px).sort((a, b) => a.min[1] - b.min[1]);
    expect(side.map((q) => [q.min[1], q.max[1], q.density, q.behind])).toEqual([[4, 5, 15, 15], [5, 6, 11, 11], [6, 7, 4, 4]]);
  });

  it('holds a density of none as air, and builds nothing where there is no gas', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 15, 0, 3, 0, 15);
    expect(deriveFromStore(s, 0, 0, 0, WORLD_RULES).gas).toBeUndefined();
    gas(s, 4, 5, 4, 4, 4, 5, 0);
    expect(deriveFromStore(s, 0, 0, 0, WORLD_RULES).gas).toBeUndefined();
    gas(s, 6, 6, 4, 4, 4, 5, 3);
    const f = facesOf(gasAt(s));
    expect(f.byFace[F.nx]).toEqual({ quads: 1, area: 2 });
  });

  it('refuses a neighbourhood too shallow to read the neighbours', () => {
    expect(() => gasOfNeighbourhood(createNeighbourhood(16, GAS_REACH_CELLS - 1))).toThrow(/pad/);
  });
});

describe('the gas part\'s runs: where the gas is, face or no face', () => {
  it('lists each column\'s gas as runs of one material with their densities summed', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 15, 0, 3, 0, 15);
    gas(s, 4, 5, 4, 4, 4, 4, 15);
    gas(s, 4, 5, 5, 5, 4, 4, 11);
    gas(s, 4, 5, 6, 6, 4, 4, 4);
    gas(s, 4, 4, 7, 8, 4, 4, 7, SMOKE);
    gas(s, 4, 4, 12, 12, 4, 4, 2);
    const g = gasAt(s)!;
    const runs = Array.from({ length: g.runCount }, (_, k) => gasRun(g, k));
    expect(runs).toEqual([
      { x: 4, z: 4, y0: 4, y1: 7, material: MIST, sum: 30 },
      { x: 4, z: 4, y0: 7, y1: 9, material: SMOKE, sum: 14 },
      { x: 4, z: 4, y0: 12, y1: 13, material: MIST, sum: 2 },
      { x: 5, z: 4, y0: 4, y1: 7, material: MIST, sum: 30 },
    ]);
    expect(gasRunAt(g, 4, 6, 4)).toEqual(runs[0]);
    expect(gasRunAt(g, 4, 7, 4)).toEqual(runs[1]);
    expect(gasRunAt(g, 4, 9, 4)).toBeNull();
    expect(gasRunAt(g, 6, 4, 4)).toBeNull();
    expect(gasRunAt(null, 4, 4, 4)).toBeNull();
  });

  it('keeps the runs of gas closed in on every side, which shows no face', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 15, 0, 9, 0, 15);
    gas(s, 5, 6, 4, 5, 5, 6);
    const g = gasAt(s)!;
    expect(g.count).toBe(0);
    expect(g.runCount).toBe(4);
    expect(gasRunAt(g, 5, 5, 6)).toMatchObject({ y0: 4, y1: 6, sum: 30 });
  });
});

describe('the gas part across sections and chunks', () => {
  it('makes no face where gas meets gas across a chunk border: each chunk draws its half and its own outer end', () => {
    const s = createWorldStore(grid);
    ground(s, 24, 39, 0, 0, 0, 9);
    gas(s, 28, 35, 1, 2, 2, 5);
    const a = facesOf(gasAt(s, 0, 0, 0));
    const b = facesOf(gasAt(s, 1, 0, 0));
    expect(a.byFace[F.py]).toEqual({ quads: 1, area: 16 });
    expect(b.byFace[F.py]).toEqual({ quads: 1, area: 16 });
    expect(a.byFace[F.px]).toBeUndefined();
    expect(b.byFace[F.nx]).toBeUndefined();
    expect(a.byFace[F.nx]).toEqual({ quads: 1, area: 8 });
    expect(b.byFace[F.px]).toEqual({ quads: 1, area: 8 });
    // The two tops meet on the border: no gap, no overlap.
    expect(a.quads.find((q) => q.face === F.py)!.max[0]).toBe(E);
    expect(b.quads.find((q) => q.face === F.py)!.min[0]).toBe(0);
  });

  it('joins a chunk\'s 16³ sections into the faces the whole chunk draws and the same gas cells, a run split where it crosses a section', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 31, 0, 5, 0, 31);
    // A bank across all eight sections with a soft top, a hole in it, and a second gas beside it.
    gas(s, 3, 28, 6, 17, 3, 28, 15);
    gas(s, 3, 28, 18, 18, 3, 28, 8);
    box(s, 14, 17, 6, 18, 14, 17, 0, 0, 0);
    gas(s, 29, 31, 6, 9, 3, 10, 5, SMOKE);
    const whole = gasAt(s)!;
    const sections = sectionGrid(16);
    const parts: Array<GasPart | null | undefined> = [];
    for (let id = 0; id < 8; id++) {
      const [ox, oy, oz] = sectionLocalOrigin(E, 16, id);
      parts[id] = deriveSectionFromStore(s, sections, ox / 16, oy / 16, oz / 16, WORLD_RULES).gas;
    }
    const joined = joinGas(parts, (id) => sectionLocalOrigin(E, 16, id))!;
    const a = facesOf(whole);
    const b = facesOf(joined);
    expect(Object.keys(b.byFace)).toEqual(Object.keys(a.byFace));
    for (const face of Object.keys(a.byFace)) expect(b.byFace[Number(face)]!.area, `face ${face}`).toBe(a.byFace[Number(face)]!.area);
    // No quad lies on a section's inner border (x = 16) facing its neighbour's gas: every x face is at the bank's ends
    // (3, and 29 where the second gas does not stand), the hole's (14, 18) or the second gas's end at the chunk's (32).
    expect([...new Set(b.quads.filter((q) => q.face === F.px || q.face === F.nx).map((q) => q.min[0]))].sort((p, q) => p - q)).toEqual([3, 14, 18, 29, 32]);
    expect(b.quads.some((q) => (q.face === F.py || q.face === F.ny) && q.min[1] === 16)).toBe(false);
    // The same cells hold gas, by column: the joined runs' rows and density sums add up to the whole chunk's.
    const cells = (g: GasPart): Map<string, number> => {
      const m = new Map<string, number>();
      for (let k = 0; k < g.runCount; k++) {
        const r = gasRun(g, k);
        const key = `${r.x},${r.z},${r.material}`;
        m.set(key, (m.get(key) ?? 0) + (r.y1 - r.y0) * 1000 + r.sum);
      }
      return m;
    };
    expect(cells(joined)).toEqual(cells(whole));
    expect(gasRunAt(whole, 5, 10, 5)).toMatchObject({ y0: 6, y1: 19, sum: 12 * 15 + 8 });
    expect(gasRunAt(joined, 5, 10, 5)).toMatchObject({ y0: 6, y1: 16 });
    expect(gasRunAt(joined, 5, 16, 5)).toMatchObject({ y0: 16, y1: 19 });
    expect(joinGas([null, undefined], () => [0, 0, 0])).toBeNull();
  });

  it('derives the gas part alone from a one-cell apron, byte for byte the full derive\'s', () => {
    const s = createWorldStore(grid);
    ground(s, 0, 40, 0, 5, 0, 31);
    gas(s, 20, 36, 6, 9, 3, 28, 12);
    expect(partsApronRadius(DERIVED_PART.gas)).toBe(GAS_REACH_CELLS);
    const ids = [0, 1, 2, 3, 4, 5, 6, 7];
    const alone = deriveSectionPartsWithApron(grid, buildApron(s, 0, 0, 0, GAS_REACH_CELLS), (out) => s.exportChunk(0, 0, 0, out), 16, ids, DERIVED_PART.gas);
    const sections = sectionGrid(16);
    let compared = 0;
    for (const r of alone) {
      expect(r.assembly).toBeNull();
      expect(r.shader).toBeNull();
      expect(r.liquid).toBeUndefined();
      const [ox, oy, oz] = sectionLocalOrigin(E, 16, r.id);
      const full = deriveSectionFromStore(s, sections, ox / 16, oy / 16, oz / 16, WORLD_RULES).gas ?? null;
      expect(r.gas === null, `section ${r.id}`).toBe(full === null);
      if (full === null) continue;
      expect(same(r.gas!.quads, full.quads)).toBe(true);
      expect(same(r.gas!.runs, full.runs)).toBe(true);
      compared++;
    }
    expect(compared).toBe(2);
  });
});
