/**
 * The case pass on real stores: the edge catalogue (no window rules) gives
 * no cell a window case; with a test catalogue of directional rules and a
 * fallback for every role, a turned and mirrored copy of a scene gives the
 * same cases, the cached extraction equals the slow window path on random
 * worlds, and the cost of extracting a 16³ section of the town (Node, this
 * thread).
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
  createDenseChunk,
  createNeighbourhood,
  createWorldStore,
  cropNeighbourhood,
  EDGE_CASE_CATALOGUE,
  fillNeighbourhood,
  FOLD_TRANSFORMS,
  jobRadius,
  NO_CASE,
  PLACEHOLDER_RULES,
  SampleRing,
  valueRole,
  VOXEL_ROLE,
  CELL,
  type CaseCatalogueDef,
  type CaseRule,
  type Neighbourhood,
  type PaletteStore,
  type VoxelRecord,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { loadArea } from './regions';
import { dabDetailRoles, placeWallBeamBanister, randomAssemblyWorld, randomTerrainWorld } from './scenes';
import { townWorld } from './town';

const grid = chunkGrid(32);
const E = grid.edge;
const PAD = jobRadius(PLACEHOLDER_RULES);
const C = VOXEL_ROLE;

/**
 * The edge catalogue with a fallback for every detail role and two
 * directional rules, so the extraction's fallback path (no face-cell
 * shortcut) is compared with the window path on real worlds. Test data.
 */
const FALLBACK_TEST_CATALOGUE: CaseCatalogueDef = Object.freeze({
  ...EDGE_CASE_CATALOGUE,
  id: 'fallback-test',
  cases: [...EDGE_CASE_CATALOGUE.cases, ...['plain', 'front', 'top-front'].map((id) => ({ id, roles: CASE_ROLES, base: 'keep' as const, shape: 'box' as const, note: '' }))],
  rules: [...EDGE_CASE_CATALOGUE.rules, { case: 'top-front', priority: 50, cells: [[0, 1, 0, CELL.open], [0, 0, 1, CELL.open]] } as CaseRule, { case: 'front', priority: 1, cells: [[0, 0, 1, CELL.open]] } as CaseRule],
  fallback: Object.fromEntries(CASE_ROLES.map((r) => [r, 'plain'])),
});

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

/** Every non-air cell of a store in a box, as [x, y, z, value-record]. */
function cellsIn(store: PaletteStore, lo: number, hi: number): Array<[number, number, number, VoxelRecord]> {
  const out: Array<[number, number, number, VoxelRecord]> = [];
  for (let x = lo; x < hi; x++) for (let y = lo; y < hi; y++) for (let z = lo; z < hi; z++) {
    const v = store.voxelAt(x, y, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    if (v.material !== 0) out.push([x, y, z, { ...v }]);
  }
  return out;
}

describe('the edge catalogue on the wall / beam / banister neighbours', () => {
  const cat = new CaseCatalogue(EDGE_CASE_CATALOGUE);

  it('gives no cell a window case: beams and banisters are plain voxels, edges the edge pass\'s', () => {
    const s = createWorldStore(grid);
    placeWallBeamBanister(s);
    let walls = 0;
    for (const [x, y, z, v] of cellsIn(s, -12, 12)) {
      if (v.role !== C.wall) continue;
      expect(caseAt(cat, s, x, y, z), `(${x}, ${y}, ${z})`).toBeNull();
      walls++;
    }
    expect(walls).toBeGreaterThan(100);
  });
});

describe('a directional test catalogue on the wall / beam / banister neighbours', () => {
  const cat = new CaseCatalogue(FALLBACK_TEST_CATALOGUE);

  it('gives a turned and mirrored copy of the scene the same cases', () => {
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
        const a = caseAt(cat, base, x, y, z, baseMemo);
        const [tx, ty, tz] = applyFold(A, [x, y, z]);
        const b = caseAt(cat, turned, tx, ty, tz, memo);
        expect(b?.id, `transform ${A}, (${x}, ${y}, ${z})`).toBe(a?.id);
        compared++;
      }
      expect(compared).toBe(152);
    }
  });
});

describe('extraction with a fallback on random worlds', () => {
  const cat = new CaseCatalogue(FALLBACK_TEST_CATALOGUE);

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
    expect([...seen.keys()].sort()).toEqual(['front', 'plain', 'top-front']);
  }, 60_000);
});

describe('the edge catalogue on random worlds', () => {
  const cat = new CaseCatalogue(EDGE_CASE_CATALOGUE);

  it('gives the same window case as the window path: none, the catalogue has no window rules', () => {
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
    expect([...seen.keys()].sort()).toEqual(['(none)']);
  }, 60_000);
});

describe('extraction cost', () => {
  it('measures µs a 16³ section on the town, keys seen and cases', () => {
    const town = createWorldStore(grid);
    const tw = townWorld({ footprint: 128 });
    loadArea(tw.grids[0]!, town, 0, 0, 128, 128);
    // A catalogue with rules (the edge catalogue has none): the extraction's cost with a cache and real matches.
    const cat = new CaseCatalogue(FALLBACK_TEST_CATALOGUE);
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
