/**
 * The case pass on real stores: the wall / beam / banister neighbours read
 * as the draft catalogue's cases, a turned and mirrored copy of a scene
 * gives the same cases placed by the matching transform, the cached
 * extraction equals the slow window path on random worlds, and the cost of
 * extracting a 16³ section of the town (Node, this thread).
 */
import {
  applyFold,
  buildApron,
  CASE_ROLES,
  caseFoldOf,
  caseIndexOf,
  CaseCatalogue,
  caseWindowAt,
  chunkGrid,
  CLASS_MASK,
  composeFolds,
  createDenseChunk,
  createNeighbourhood,
  createWorldStore,
  cropNeighbourhood,
  DRAFT_CASE_CATALOGUE,
  EDGE_CASE_CATALOGUE,
  evaluateAssembly,
  fillNeighbourhood,
  FOLD_TRANSFORMS,
  jobRadius,
  NO_CASE,
  PLACEHOLDER_RULES,
  ASSEMBLY_CLASS,
  RUN_X,
  RUN_Z,
  SampleRing,
  valueRole,
  VOXEL_ROLE,
  type Neighbourhood,
  type PaletteStore,
  type VoxelRecord,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { loadArea } from './regions';
import { dabDetailRoles, placeWallBeamBanister, putVoxel, randomAssemblyWorld, randomTerrainWorld } from './scenes';
import { townWorld } from './town';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const PAD = jobRadius(PLACEHOLDER_RULES);
const C = VOXEL_ROLE;

/** A chunk's neighbourhood (the job's pad) from a store. */
function chunkNeighbourhood(store: PaletteStore, cx: number, cy: number, cz: number, n = createNeighbourhood(E, PAD)): Neighbourhood {
  const dense = createDenseChunk(grid);
  const has = store.exportChunk(cx, cy, cz, dense);
  fillNeighbourhood(n, grid, has ? dense : null, buildApron(store, cx, cy, cz, PAD));
  return n;
}

/** The cases of one chunk's cells (packed, by padded index) and the neighbourhood they came from. */
function chunkCases(cat: CaseCatalogue, store: PaletteStore, cx: number, cy: number, cz: number): { n: Neighbourhood; cases: Uint16Array } {
  const n = chunkNeighbourhood(store, cx, cy, cz);
  const cases = new Uint16Array(n.values.length);
  cat.extract(n, PAD, PAD + E, cases);
  return { n, cases };
}

/** Case id and transform of world cell (x, y, z); null for a cell with no case. */
function caseAt(cat: CaseCatalogue, store: PaletteStore, x: number, y: number, z: number, memo?: Map<string, ReturnType<typeof chunkCases>>): { id: string; fold: number } | null {
  const sh = grid.shift;
  const key = `${x >> sh},${y >> sh},${z >> sh}`;
  let got = memo?.get(key);
  if (got === undefined) {
    got = chunkCases(cat, store, x >> sh, y >> sh, z >> sh);
    memo?.set(key, got);
  }
  const { n, cases } = got;
  const s = n.side;
  const p = cases[(((x & grid.mask) + PAD) * s + ((z & grid.mask) + PAD)) * s + ((y & grid.mask) + PAD)]!;
  return p === NO_CASE ? null : { id: cat.cases[caseIndexOf(p)]!.id, fold: caseFoldOf(p) };
}

/** The placeholder class byte of a world cell. */
function placeholderAt(store: PaletteStore, x: number, y: number, z: number): number {
  const sh = grid.shift;
  const n = chunkNeighbourhood(store, x >> sh, y >> sh, z >> sh);
  const out = new Uint8Array(n.values.length);
  evaluateAssembly(n, PLACEHOLDER_RULES, out);
  const s = n.side;
  return out[(((x & grid.mask) + PAD) * s + ((z & grid.mask) + PAD)) * s + ((y & grid.mask) + PAD)]!;
}

/** Every non-air cell of a store in a box, as [x, y, z, value-record]. */
function cellsIn(store: PaletteStore, lo: number, hi: number): Array<[number, number, number, VoxelRecord]> {
  const out: Array<[number, number, number, VoxelRecord]> = [];
  for (let x = lo; x < hi; x++) for (let y = lo; y < hi; y++) for (let z = lo; z < hi; z++) {
    const v = store.voxelAt(x, y, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    if (v.material !== 0) out.push([x, y, z, { ...v }]);
  }
  return out;
}

describe('the draft catalogue on the wall / beam / banister neighbours', () => {
  const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);

  it('reads the wall, beam, rail and posts as their cases, the beam and rail running along x, as the placeholder rules read them', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    // The scene's wall is one cell thick: open in front and behind (wall-thin, catalogue v3).
    expect(caseAt(cat, s, 0, 4, 0)?.id).toBe('wall-thin');
    expect(caseAt(cat, s, 0, 7, 0)?.id).toBe('wall-top');
    expect(caseAt(cat, s, -6, 3, 0)?.id).toBe('wall-end');
    expect(caseAt(cat, s, 0, 2, 0)?.id).toBe('wall-thin');
    const beam = caseAt(cat, s, 0, 5, -1)!;
    expect(beam.id).toBe('beam');
    // Its run (+x in the case) stays along x in the world; the wall behind it (−z in the case) is at +z.
    expect(Math.abs(applyFold(beam.fold, [1, 0, 0])[0])).toBe(1);
    expect(applyFold(beam.fold, [0, 0, -1])).toEqual([0, 0, 1]);
    const rail = caseAt(cat, s, 1, 2, 7)!;
    expect(rail.id).toBe('banister-rail');
    expect(Math.abs(applyFold(rail.fold, [1, 0, 0])[0])).toBe(1);
    expect(caseAt(cat, s, 0, 2, 7)?.id).toBe('banister-rail');
    expect(caseAt(cat, s, 0, 1, 7)?.id).toBe('banister-post');
    expect(caseAt(cat, s, 0, 0, 4)?.id).toBe('wall-top');
    expect(caseAt(cat, s, 0, 0, 5)?.id).toBe('wall-plain');
    expect(caseAt(cat, s, 0, -1, 0)).toBeNull();
    expect(caseAt(cat, s, 0, 9, 0)).toBeNull();
    // Every cell the placeholder rules read as a beam, rail or post is the matching case here, and no other cell is.
    const feature = (k: number): string | null => {
      const c = k & CLASS_MASK;
      if (c === ASSEMBLY_CLASS.beam) return 'beam';
      if (c !== ASSEMBLY_CLASS.rail) return null;
      return (k & RUN_X) !== 0 && (k & RUN_Z) !== 0 ? 'banister-post' : 'banister-rail';
    };
    let features = 0;
    for (const [x, y, z, v] of cellsIn(s, -12, 12)) {
      if (v.role !== C.wall) continue;
      const want = feature(placeholderAt(s, x, y, z));
      const got = caseAt(cat, s, x, y, z)!.id;
      const mine = got === 'beam' || got.startsWith('banister') ? got : null;
      expect(mine, `(${x}, ${y}, ${z})`).toBe(want);
      if (want !== null) features++;
    }
    expect(features).toBe(12 + 8 + 4);
  });

  it('turns a banister into a wall when it grows, and a beam into a wall stub when its wall goes', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    for (let x = -4; x < 4; x++) putVoxel(s, x, 3, 7, MAT.timber, C.wall);
    expect(caseAt(cat, s, 1, 2, 7)?.id).toBe('wall-thin');
    expect(caseAt(cat, s, 0, 1, 7)?.id).not.toMatch(/^banister/);
    expect(caseAt(cat, s, 1, 3, 7)?.id).toBe('wall-top');
    for (let y = 0; y < 8; y++) for (const x of [-1, 0, 1]) putVoxel(s, x, y, 0, 0, C.air);
    expect(caseAt(cat, s, 0, 5, -1)?.id).not.toBe('beam');
    expect(caseAt(cat, s, 3, 5, -1)?.id).toBe('beam');
  });

  it('gives a turned and mirrored copy of the scene the same cases, placed by the transform turned with it', () => {
    const base = createWorldStore(grid);
    placeWallBeamBanister(base);
    const cells = cellsIn(base, -13, 13);
    const baseMemo = new Map<string, ReturnType<typeof chunkCases>>();
    for (let A = 1; A < FOLD_TRANSFORMS; A++) {
      const turned = createWorldStore(grid);
      for (const [x, y, z, v] of cells) {
        const [tx, ty, tz] = applyFold(A, [x, y, z]);
        turned.setVoxel(tx, ty, tz, v);
      }
      let compared = 0;
      const memo = new Map<string, ReturnType<typeof chunkCases>>();
      for (const [x, y, z, v] of cells) {
        if (!CASE_ROLES.includes(v.role)) continue;
        const a = caseAt(cat, base, x, y, z, baseMemo)!;
        const [tx, ty, tz] = applyFold(A, [x, y, z]);
        const b = caseAt(cat, turned, tx, ty, tz, memo)!;
        expect(b.id, `transform ${A}, (${x}, ${y}, ${z})`).toBe(a.id);
        // The rule's pattern placed by b's transform fits the turned world as a's fits the original: the same placement up to the case's own symmetry.
        const run = (f: number): string => applyFold(f, [1, 0, 0]).map(Math.abs).join(',') + '|' + applyFold(f, [0, 0, 1]).join(',');
        if (a.id === 'beam' || a.id === 'banister-rail') expect(run(b.fold)).toBe(run(composeFolds(A, a.fold)));
        compared++;
      }
      expect(compared).toBe(152);
    }
  });
});

describe('extraction on random worlds', () => {
  const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);

  it('gives every detail-bearing cell a case of its role, the same as the window path, and no other cell one', () => {
    const seen = new Map<string, number>();
    for (const [name, build] of [
      ['assembly', (s: PaletteStore, seed: number) => randomAssemblyWorld(s, seed, 24)],
      ['terrain', (s: PaletteStore, seed: number) => randomTerrainWorld(s, seed, 24)],
    ] as const) {
      for (const seed of [1, 2, 3]) {
        const s = createWorldStore(grid);
        build(s, seed);
        // Roles the generators do not write (floor, roof as slopes, foundation, stair, pillar, opening): dab some in.
        dabDetailRoles(s, seed);
        for (let cx = -1; cx < 1; cx++) for (let cy = -1; cy < 1; cy++) for (let cz = -1; cz < 1; cz++) {
          const { n, cases } = chunkCases(cat, s, cx, cy, cz);
          const side = n.side;
          for (let x = PAD; x < PAD + E; x++) for (let z = PAD; z < PAD + E; z++) for (let y = PAD; y < PAD + E; y++) {
            const i = (x * side + z) * side + y;
            const role = valueRole(n.values[i]!);
            const carries = CASE_ROLES.includes(role) && (role === C.opening || n.shapes[i]! >= 128);
            if (!carries) {
              expect(cases[i], `${name} ${seed}`).toBe(NO_CASE);
              continue;
            }
            const m = cat.matchWindow(role, caseWindowAt(n, i));
            expect(cases[i]).toBe((m.caseIndex << 3) | m.fold);
            expect(cat.cases[m.caseIndex]!.roles).toContain(role);
            const id = m.caseId ?? '(none)';
            seen.set(id, (seen.get(id) ?? 0) + 1);
          }
        }
      }
    }
    console.log(`cases on random worlds: ${[...seen].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ')}`);
    expect(seen.size).toBeGreaterThan(20);
  }, 60_000);
});

describe('the edge catalogue on random worlds', () => {
  const cat = new CaseCatalogue(EDGE_CASE_CATALOGUE);

  it('gives the same window case as the window path (its face-cell shortcut never drops a match), beams and banisters only', () => {
    const seen = new Map<string, number>();
    for (const seed of [1, 2, 3]) {
      const s = createWorldStore(grid);
      randomAssemblyWorld(s, seed, 24);
      placeWallBeamBanister(s, 0, 2, 0);
      dabDetailRoles(s, seed);
      for (let cx = -1; cx < 1; cx++) for (let cy = -1; cy < 1; cy++) for (let cz = -1; cz < 1; cz++) {
        const { n, cases } = chunkCases(cat, s, cx, cy, cz);
        const side = n.side;
        for (let x = PAD; x < PAD + E; x++) for (let z = PAD; z < PAD + E; z++) for (let y = PAD; y < PAD + E; y++) {
          const i = (x * side + z) * side + y;
          const role = valueRole(n.values[i]!);
          if (!CASE_ROLES.includes(role) || (role !== C.opening && n.shapes[i]! < 128)) continue;
          const m = cat.matchWindow(role, caseWindowAt(n, i));
          expect(cases[i], `seed ${seed}`).toBe(m.caseIndex < 0 ? NO_CASE : (m.caseIndex << 3) | m.fold);
          const id = m.caseId ?? '(none)';
          seen.set(id, (seen.get(id) ?? 0) + 1);
        }
      }
    }
    expect([...seen.keys()].sort()).toEqual(['(none)', 'banister-post', 'banister-rail', 'beam']);
  }, 60_000);
});

describe('extraction cost', () => {
  it('measures µs a 16³ section on the town, keys seen and cases', () => {
    const town = createWorldStore(grid);
    const tw = townWorld({ footprint: 128 });
    loadArea(tw.grids[0]!, town, 0, 0, 128, 128);
    const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);
    const SE = 16;
    const sub = createNeighbourhood(SE, PAD);
    const out = new Uint16Array(sub.values.length);
    const full = createNeighbourhood(E, PAD);
    const sections: Neighbourhood[] = [];
    const cy0 = -1;
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) for (let cy = cy0; cy < 2; cy++) {
      chunkNeighbourhood(town, cx, cy, cz, full);
      for (let sx = 0; sx < 2; sx++) for (let sy = 0; sy < 2; sy++) for (let sz = 0; sz < 2; sz++) {
        const n = createNeighbourhood(SE, PAD);
        cropNeighbourhood(full, sx * SE, sy * SE, sz * SE, n);
        sections.push(n);
      }
    }
    const keys = new Set<string>();
    const cases = new Map<string, number>();
    const built = new SampleRing();
    const all = new SampleRing();
    let cells = 0;
    const pass = (record: boolean): void => {
      for (const n of sections) {
        sub.values.set(n.values);
        sub.shapes.set(n.shapes);
        const t0 = performance.now();
        const count = cat.extract(sub, PAD, PAD + SE, out);
        const us = (performance.now() - t0) * 1000;
        if (!record) continue;
        all.add(us);
        if (count === 0) continue;
        built.add(us);
        cells += count;
        const s = sub.side;
        for (let x = PAD; x < PAD + SE; x++) for (let z = PAD; z < PAD + SE; z++) for (let y = PAD; y < PAD + SE; y++) {
          const i = (x * s + z) * s + y;
          if (out[i] === NO_CASE) continue;
          const m = cat.matchWindow(valueRole(sub.values[i]!), caseWindowAt(sub, i));
          keys.add(m.key);
          const id = m.caseId ?? '(none)';
          cases.set(id, (cases.get(id) ?? 0) + 1);
        }
      }
    };
    // A cold pass (empty window cache, JIT warming), then the measured pass.
    const c0 = performance.now();
    pass(false);
    const coldMs = performance.now() - c0;
    pass(true);
    const q = (r: SampleRing, p: number): number => Math.round(r.quantile(p));
    console.log(`case extraction, town 16³ sections: ${all.count} sections, ${built.count} with detail cells (${cells} cells, ${keys.size} keys seen); µs p50/p95 all ${q(all, 0.5)}/${q(all, 0.95)}, with cells ${q(built, 0.5)}/${q(built, 0.95)}; cold pass ${coldMs.toFixed(0)} ms; cases: ${[...cases].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(', ')}`);
    expect(built.count).toBeGreaterThan(20);
    expect(keys.size).toBeGreaterThan(10);
  }, 60_000);
});
