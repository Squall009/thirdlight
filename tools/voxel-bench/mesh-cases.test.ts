/**
 * The golden harness on the real store and derive: the hard-case world
 * holds the solids its cases describe, the reference surface nets meet the
 * recorded goldens, and meshes broken on purpose (a hole torn, vertices
 * moved, a feature removed, a hole covered) fail them.
 */
import { chunkGrid, CREASE_SPLIT_DEG, createWorldStore, deriveFromStore, deriveMipNode, groundHeightfield, GROUND_HEIGHTFIELD_TOLERANCE_M, mipCellMetres, MipTree, POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, TERRAIN_RULES, voxel, VOXEL_ROLE, type SurfaceBuffer } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { chunkBase, coverage, exposedFaces, naiveOpenSegments, openSegments, tJunctions, unmatchedEdges, weldBase, type BaseMesh } from './base-cases';
import { FEATURE_GROUND, featureCases, featuresStore } from './features';
import { REFERENCE_GOLDENS, TERRAIN_NORMAL_GOLDENS } from './mesh-goldens';
import { creaseAngles, goldenFailures, meshFeatures, meshFeaturesAtLevel, measureCases, measureNormals, referenceMesher, terrainMesher, type CaseResult, type NormalResult, type WorldMesh } from './mesh-cases';
import { featureSpecs, measurePatch, type SeamResult } from './lod-seams';
import { chunkMesherOf, MESHER_CANDIDATES, mesherCandidate } from './mesher-candidates';
import { loadArea } from './regions';
import { compareSilhouettes, raysOut, SHELL_HOUSES, SHELL_VIEWS, shellMesh, shellStore, silhouette, unbalancedEdges } from './shell-cases';
import { townWorld } from './town';
import { MAT } from './world-kit';
import { hillyWorld } from './worlds';

const G = FEATURE_GROUND;
const cases = featureCases();
const store = featuresStore();
const reference = meshFeatures(store, referenceMesher);
const x0 = (name: string): number => cases.find((c) => c.name === name)!.x0;
let terrainWelded: WorldMesh | null = null;
/** The derive's ground over the row, welded (built once, on first use). */
const terrainMesh = (): WorldMesh => (terrainWelded ??= meshFeatures(store, terrainMesher));

/** Every failure of every case against the reference goldens. */
function failures(mesh: WorldMesh): string[] {
  return measureCases(mesh, cases).flatMap((r) => goldenFailures(r, REFERENCE_GOLDENS[r.name]!));
}

/** The mesh without the triangles `drop` picks (by centroid, cells). */
function without(mesh: WorldMesh, drop: (x: number, y: number, z: number) => boolean): WorldMesh {
  const P = mesh.positions;
  const T = mesh.triangles;
  const keep: number[] = [];
  for (let t = 0; t < T.length; t += 3) {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < 3; j++) {
      x += P[3 * T[t + j]!]! / 3;
      y += P[3 * T[t + j]! + 1]! / 3;
      z += P[3 * T[t + j]! + 2]! / 3;
    }
    if (!drop(x, y, z)) keep.push(T[t]!, T[t + 1]!, T[t + 2]!);
  }
  return { positions: P, triangles: Uint32Array.from(keep) };
}

/** Whether a cell is ground at least half full. */
function solid(x: number, y: number, z: number): boolean {
  const v = store.voxelAt(x, y, z, voxel());
  return v.material !== 0 && v.shape >= 8;
}

describe('the hard-case world', () => {
  it('has every case the terrain mesher must keep, each with probes and a golden', () => {
    expect(cases.map((c) => c.name)).toEqual(['slope-1:20', 'slope-1:5', 'bank-1:1', 'cliff-20m', 'terraces-1', 'terraces-2', 'overhang', 'arch', 'cave', 'wall-1', 'spike-1', 'pit-1', 'hole-1', 'bumps']);
    for (const c of cases) expect(c.probes.length, c.name).toBeGreaterThan(0);
    expect(Object.keys(REFERENCE_GOLDENS).sort()).toEqual(cases.map((c) => c.name).sort());
  });

  it('holds the one-cell features and hollows its cases describe', () => {
    const wall = x0('wall-1') + 32;
    for (let z = 16; z < 48; z++) {
      expect(solid(wall, 12, z), `wall z ${z}`).toBe(true);
      expect(solid(wall - 1, 12, z) || solid(wall + 1, 12, z), `beside the wall z ${z}`).toBe(false);
    }
    const spike = x0('spike-1') + 32;
    expect([9, 12, 17].map((y) => solid(spike, y, 32))).toEqual([true, true, true]);
    expect(solid(spike, 18, 32) || solid(spike + 1, 12, 32)).toBe(false);
    const pit = x0('pit-1') + 32;
    expect([5, 6, 7].map((y) => solid(pit, y, 32))).toEqual([false, false, false]);
    expect(solid(pit, 4, 32) && solid(pit + 1, 7, 32)).toBe(true);
    const hole = x0('hole-1');
    expect(solid(hole + 31, 14, 32) || solid(hole + 32, 14, 32)).toBe(false);
    expect(solid(hole + 31, 14, 31) && solid(hole + 32, 15, 32)).toBe(true);
    const cave = x0('cave');
    // Mouth, hollow, roof and back wall.
    expect(solid(cave + 12, 13, 32) || solid(cave + 30, 13, 32)).toBe(false);
    expect(solid(cave + 30, Math.floor(G + 10), 32) && solid(cave + 46, 13, 32)).toBe(true);
    const arch = x0('arch') + 32;
    expect(solid(arch, Math.floor(G + 3), 32)).toBe(false);
    expect(solid(arch, Math.floor(G + 10), 32)).toBe(true);
    const ledge = x0('overhang');
    expect(solid(ledge + 28, Math.floor(G + 5), 32)).toBe(false);
    expect(solid(ledge + 28, Math.floor(G + 13), 32)).toBe(true);
  });
});

describe('the golden harness', () => {
  it('the reference surface nets meet the recorded goldens ("before"), closed and keeping every feature', () => {
    for (const r of measureCases(reference, cases)) {
      const g = REFERENCE_GOLDENS[r.name]!;
      expect(goldenFailures(r, g), r.name).toEqual([]);
      expect(r.openEdges, r.name).toBe(0);
      expect(r.degenerate, r.name).toBe(0);
      expect(r.lost, r.name).toEqual([]);
      expect(r.triangles, r.name).toBe(g.triangles);
      expect(r.maxErrorM, r.name).toBeCloseTo(g.maxErrorM, 5);
      expect(r.meanErrorM, r.name).toBeCloseTo(g.meanErrorM, 5);
    }
  });

  it('fails a mesh with a hole torn in it (not watertight)', () => {
    const s = x0('slope-1:20');
    const torn = without(reference, (x, _y, z) => x > s + 30 && x < s + 32 && z > 30 && z < 32);
    expect(failures(torn)).toEqual([expect.stringMatching(/^slope-1:20: \d+ open edges$/)]);
  });

  it('fails a mesh whose vertices moved off the surface (error)', () => {
    const s = x0('slope-1:5');
    const P = Float64Array.from(reference.positions);
    for (let v = 0; v < P.length; v += 3) if (P[v]! > s + 20 && P[v]! < s + 40 && P[v + 2]! > 20 && P[v + 2]! < 40) P[v + 1]! += 0.3;
    const f = failures({ positions: P, triangles: reference.triangles });
    expect(f).toContainEqual(expect.stringMatching(/^slope-1:5: max error /));
    expect(f.every((m) => m.startsWith('slope-1:5: '))).toBe(true);
  });

  it('fails a mesh that lost the one-cell wall or the spike (features kept)', () => {
    const w = x0('wall-1');
    const noWall = without(reference, (x, y) => x > w + 31 && x < w + 34 && y > G + 1.5);
    const f = failures(noWall);
    expect(f).toContainEqual('wall-1: lost wall z 16.5');
    expect(f).toContainEqual('wall-1: lost wall top');
    const s = x0('spike-1');
    const noSpike = without(reference, (x, y, z) => x > s + 31 && x < s + 34 && z > 31 && z < 34 && y > G + 1.5);
    expect(failures(noSpike)).toContainEqual('spike-1: lost spike top');
  });

  it('fails a closed mesh whose one-cell hole is covered (the probe sees what watertightness cannot)', () => {
    const h = x0('hole-1') + 30.9;
    const P = Float64Array.from([...reference.positions, h, 13.8, 31.8, h, 15.2, 31.8, h, 15.2, 33.2, h, 13.8, 33.2]);
    const a = reference.positions.length / 3;
    // A two-sided patch (the back split on the other diagonal): every edge is used once each way, so the mesh stays closed.
    const cover = [a, a + 1, a + 2, a, a + 2, a + 3, a + 1, a, a + 3, a + 1, a + 3, a + 2];
    const f = failures({ positions: P, triangles: Uint32Array.from([...reference.triangles, ...cover]) });
    expect(f).toContainEqual('hole-1: lost through the hole');
    expect(f.filter((m) => m.includes('open edges'))).toEqual([]);
  });
});

describe('the terrain mesher', () => {
  let cached: CaseResult[] | null = null;
  const terrain = (): CaseResult[] => (cached ??= measureCases(terrainMesh(), cases));

  it('is the derive\'s ground under the terrain rules: the bench pick (lattice+dc), its other vertices kept off the lattice, a straight step\'s edge on its column top', () => {
    const pick = chunkMesherOf(mesherCandidate('lattice+dc'));
    const steps = POSITION_STEPS_PER_CELL;
    let compared = 0;
    let nudged = 0;
    let stepped = 0;
    for (let cx = 0; cx < 28; cx += 3) for (const cy of [-1, 0, 1]) for (const cz of [0, 1]) {
      const derived = deriveFromStore(store, cx, cy, cz, TERRAIN_RULES).ground;
      const bench = pick(store, cx, cy, cz);
      const at = `${cx},${cy},${cz}`;
      expect(derived.indices.length, at).toBe(bench.indices.length);
      // Same triangles; a non-lattice vertex on its cube's centre line (where only lattice vertices sit) moves one step
      // along x; a crease vertex of a straight step moves onto the lattice (the derive's step placement), within its cube.
      const a = new DataView(derived.vertices.buffer, derived.vertices.byteOffset, derived.vertices.byteLength);
      const b = new DataView(bench.vertices.buffer, bench.vertices.byteOffset, bench.vertices.byteLength);
      for (let t = 0; t < derived.indices.length; t++) {
        const p = [0, 1, 2].map((k) => a.getUint16(derived.indices[t]! * SURFACE_VERTEX_BYTES + 2 * k, true));
        const q = [0, 1, 2].map((k) => b.getUint16(bench.indices[t]! * SURFACE_VERTEX_BYTES + 2 * k, true));
        if (p.every((v, k) => v === q[k])) continue;
        if (p[0]! % steps === 0 && p[2]! % steps === 0 && p.every((v, k) => Math.abs(v - q[k]!) < steps)) {
          stepped++;
          continue;
        }
        expect([p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!, q[0]! % steps, q[2]! % steps], `${at} corner ${t}`).toEqual([1, 0, 0, 0, 0]);
        nudged++;
      }
      compared += derived.indices.length / 3;
    }
    expect(compared).toBeGreaterThan(20000);
    expect(nudged).toBeGreaterThan(0);
    expect(stepped).toBeGreaterThan(0);
  });

  it('marching cubes (bench) and the terrain mesher close every hard case and keep every feature', { timeout: 30_000 }, () => {
    expect(MESHER_CANDIDATES.map((m) => m.name)).toEqual(['reference', 'lattice', 'dc', 'lattice+dc', 'mc', 'terrain']);
    for (const [name, results] of [['mc', measureCases(meshFeatures(store, chunkMesherOf(mesherCandidate('mc'))), cases)], ['terrain', terrain()]] as const) {
      for (const r of results) {
        expect(r.openEdges, `${name} ${r.name}`).toBe(0);
        expect(r.degenerate, `${name} ${r.name}`).toBe(0);
        expect(r.lost, `${name} ${r.name}`).toEqual([]);
      }
    }
  });

  it('meets the goldens within 3 cm and is far closer on slopes', { timeout: 30_000 }, () => {
    const results = terrain();
    // The slack covers one place: the concave rim of a bump, where a lattice vertex lies on a ramp across a cell.
    expect(results.flatMap((r) => goldenFailures(r, REFERENCE_GOLDENS[r.name]!, 0.03))).toEqual([]);
    expect(results.flatMap((r) => goldenFailures(r, REFERENCE_GOLDENS[r.name]!))).toEqual([expect.stringMatching(/^bumps: max error /)]);
    for (const name of ['slope-1:20', 'slope-1:5']) {
      const r = results.find((c) => c.name === name)!;
      expect(r.meanErrorM, name).toBeLessThan(REFERENCE_GOLDENS[name]!.meanErrorM / 2);
      expect(r.triangles, name).toBeLessThan(REFERENCE_GOLDENS[name]!.triangles);
    }
  });

  it('puts a straight step\'s edge on the true edge: every terrace lip and the cliff top within the fill rounding (1/30 cell), the one-cell terraces within 3 cm everywhere', { timeout: 30_000 }, () => {
    const mesh = terrainMesh();
    const P = mesh.positions;
    // Welded positions on the z = 32 line (a lattice row through every riser).
    const row: Array<[number, number]> = [];
    for (let v = 0; v < P.length / 3; v++) if (P[3 * v + 2] === 32) row.push([P[3 * v]!, P[3 * v + 1]!]);
    const edges: Array<[string, number, number]> = [
      ...Array.from({ length: 9 }, (_, k) => ['terraces-1', x0('terraces-1') + 8 + 6 * k, G + k + 1] as [string, number, number]),
      ...Array.from({ length: 7 }, (_, k) => ['terraces-2', x0('terraces-2') + 8 + 8 * k, G + 2 * k + 2] as [string, number, number]),
      ['cliff-20m', x0('cliff-20m') + 28, G + 40],
    ];
    for (const [name, ex, ey] of edges) {
      const off = Math.min(...row.map(([px, py]) => Math.hypot(px - ex, py - ey)));
      // The 4-bit fill holds a top to 1/30 cell (0.3 is stored as 5/15); the lattice puts the face on the cell boundary.
      expect(off, `${name} edge at ${ex - x0(name)}, ${ey}`).toBeLessThanOrEqual(1 / 30 + 1 / POSITION_STEPS_PER_CELL);
    }
    expect(terrain().find((r) => r.name === 'terraces-1')!.maxErrorM).toBeLessThanOrEqual(0.03);
  });

  it('makes hilly ground chunks heightfields where the reference makes none', () => {
    const grid = chunkGrid(32);
    const hilly = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 512 }).grids[0]!, hilly, 0, 0, 160, 160);
    const count = (mesh: (s: typeof hilly, cx: number, cy: number, cz: number) => SurfaceBuffer): number => {
      let n = 0;
      for (let cx = 1; cx < 4; cx++) for (let cz = 1; cz < 4; cz++) for (let cy = -4; cy < 8; cy++) {
        const buf = mesh(hilly, cx, cy, cz);
        if (buf.indices.length > 0 && typeof groundHeightfield(buf, grid.edge) !== 'string') n++;
      }
      return n;
    };
    expect(count(referenceMesher)).toBe(0);
    expect(count(terrainMesher)).toBeGreaterThan(0);
  });
});

/**
 * What each mip level is expected to lose of the hard cases (probe names;
 * every other probe kept). A level's cell is 2^L cells: a feature at least
 * that size stays, a thinner one may leave the level or thin out, and a
 * probe that passes within half a level cell of another face can no longer
 * tell the two apart.
 */
const LEVEL_LOST: Readonly<Record<number, Readonly<Record<string, readonly string[] | 'all'>>>> = {
  // A one-cell wall is half a level-1 cell: it stays, drawn thin round its column's middle, so rays at its ends and on
  // its top's side miss it; the one-cell spike (a quarter) and pit (three quarters ground) leave the level.
  1: { 'wall-1': ['wall z 16.5', 'wall z 47.5', 'wall top'], 'spike-1': ['spike top', 'spike side'], 'pit-1': ['pit bottom'] },
  // Level 2 (4-cell cells): the one-cell wall and spike, the pit and the 2-cell slab with the hole leave the level; the
  // cliff's foot probe runs half a cell from its face.
  2: { 'cliff-20m': ['cliff foot'], 'wall-1': 'all', 'spike-1': ['spike top', 'spike side'], 'pit-1': ['pit bottom'], 'hole-1': ['above the hole', 'beside the hole'] },
};

describe('mip levels through the same mesher', () => {
  const levels = new Map<number, CaseResult[]>();
  const atLevel = (level: number): CaseResult[] => {
    let r = levels.get(level);
    if (r === undefined) levels.set(level, (r = measureCases(meshFeaturesAtLevel(store, level), cases, 0.5 * (1 << level))));
    return r;
  };

  it('keeps the hard cases watertight at levels 1 and 2, every surface within the level\'s cell of the true one, each level about a quarter of the triangles of the one below', { timeout: 60_000 }, () => {
    let below = measureCases(terrainMesh(), cases);
    for (const level of [1, 2]) {
      const results = atLevel(level);
      const cellM = mipCellMetres(level);
      for (const r of results) {
        const at = `L${level} ${r.name}`;
        expect(r.openEdges, at).toBe(0);
        expect(r.degenerate, at).toBe(0);
        expect(r.maxErrorM, at).toBeLessThanOrEqual(cellM);
        // Measured 0.22–0.25 (ground two triangles a column at every level, a quarter of the columns).
        expect(r.triangles, at).toBeLessThanOrEqual(0.3 * below.find((b) => b.name === r.name)!.triangles);
      }
      below = results;
    }
  });

  it('keeps every feature at least the level\'s cell in size; the thinner ones leave exactly as expected', { timeout: 60_000 }, () => {
    for (const level of [1, 2]) {
      for (const r of atLevel(level)) {
        const want = LEVEL_LOST[level]![r.name] ?? [];
        expect(r.lost, `L${level} ${r.name}`).toEqual(want === 'all' ? r.probes.map((p) => p.name) : want);
      }
    }
  });

  it('keeps ground on the column lattice at every level: hilly nodes collide as heightfields at levels 1 and 2', { timeout: 60_000 }, () => {
    const grid = chunkGrid(32);
    const hilly = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 512 }).grids[0]!, hilly, -128, -128, 384, 384);
    const tree = new MipTree(hilly);
    for (const level of [1, 2]) {
      const span = grid.edge << level;
      let ground = 0;
      let fields = 0;
      for (let nx = 0; nx < 256 / span; nx++) for (let nz = 0; nz < 256 / span; nz++) for (let ny = (-4 >> level) - 1; ny <= 8 >> level; ny++) {
        const d = deriveMipNode(tree, { level, nx, ny, nz }, TERRAIN_RULES);
        if (d.ground.indices.length === 0) continue;
        ground++;
        const hf = groundHeightfield(d.ground, grid.edge, GROUND_HEIGHTFIELD_TOLERANCE_M, mipCellMetres(level));
        if (typeof hf === 'string') continue;
        fields++;
        // Heights in metres of the level's cells: the field spans the node's footprint at the level's scale.
        expect(hf.cellsX, `L${level}`).toBeGreaterThanOrEqual(grid.edge - 2);
      }
      expect(ground, `L${level}`).toBeGreaterThan(0);
      expect(fields, `L${level}`).toBeGreaterThan(0);
    }
  });
});

describe('one-cell shells at coarse levels (built bodies thickened, never opened)', () => {
  it('keeps a house of one-cell walls, floor and roof (gable, hip and flat, at odd and even cells) watertight and closed at levels 1 and 2, its silhouette kept and grown by at most the level\'s cell', { timeout: 60_000 }, () => {
    const s = shellStore();
    const m0 = shellMesh(s, 0);
    const l0 = SHELL_HOUSES.map((h) => SHELL_VIEWS.map((axis) => silhouette(h, m0.points, m0.mesh, axis, 1)));
    for (const h of SHELL_HOUSES) expect(raysOut(h, m0.points, m0.mesh), `L0 ${h.name}`).toBe(0);
    for (const level of [1, 2]) {
      const { mesh, points } = shellMesh(s, level);
      const cell = 1 << level;
      expect(mesh.triangles.length, `L${level}`).toBeGreaterThan(0);
      expect(unbalancedEdges(mesh), `L${level}`).toBe(0);
      SHELL_HOUSES.forEach((h, i) => {
        const at = `L${level} ${h.name}`;
        // Before: the roof left level 1 (rays out of 96: 7–19) and the whole house level 2 (96).
        expect(raysOut(h, points, mesh), at).toBe(0);
        SHELL_VIEWS.forEach((axis, j) => {
          const c = compareSilhouettes(h, axis, l0[i]![j]!, silhouette(h, points, mesh, axis, 2 * cell), cell);
          // A rim one level-0 cell wide (an eave's overhang) may leave; before, level 1 kept 0.56–0.86 of a gable, level 2 nothing.
          expect(c.kept, `${at} view ${axis}`).toBeGreaterThanOrEqual(SHELL_SILHOUETTE_KEPT);
          expect(c.outside, `${at} view ${axis}`).toBe(0);
        });
      });
    }
  });

  it('leaves lines of cells (posts, rails, a fence) out of coarse levels: only sheets and masses are thickened', () => {
    const s = shellStore([]);
    const wall = { material: MAT.timber, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 };
    // A fence in air: posts two cells tall every fourth cell under a rail along x; a rail along z; a lone post.
    for (let x = 4; x < 40; x++) {
      s.setVoxel(x, 9, 9, wall);
      if (x % 4 === 1) s.setVoxel(x, 8, 9, wall);
    }
    for (let z = 20; z < 40; z++) s.setVoxel(9, 12, z, wall);
    for (let y = 4; y < 14; y++) s.setVoxel(30, y, 30, wall);
    const tree = new MipTree(s);
    for (const level of [1, 2]) for (let nx = 0; nx < 2; nx++) for (let nz = 0; nz < 2; nz++) expect(tree.node({ level, nx, ny: 0, nz }), `L${level} ${nx},${nz}`).toBeNull();
  });
});

/**
 * The smallest angle (degrees) the shading normals must turn by across a/**
 * The smallest angle (degrees) the shading normals must turn by across a
 * crease the rules call sharp: the placed geometry's own corner (a 90° cliff
 * edge placed ~64°, a one-cell terrace lip ~40°), well above the
 * {@link CREASE_SPLIT_DEG} a curved face may turn without splitting.
 */
const CREASE_KEPT_DEG = 35;

/** The worst normal error a gentle plane slope may show (the 4-bit fill's rounding banded 1:5 up to 7° before). */
const SLOPE_NORMAL_MAX_DEG = 2;

/**
 * The share of level 0's silhouette (from above and two sides) a coarse
 * level keeps: all but a rim one level-0 cell wide on a side (measured
 * 0.917–1.0; before, level 1 kept 0.56 of a gable's side and level 2 none).
 */
const SHELL_SILHOUETTE_KEPT = 0.9;

describe('the terrain mesher\'s normals', () => {
  let normals: NormalResult[] | null = null;
  const terrain = (): NormalResult[] => (normals ??= measureNormals(terrainMesh(), cases));
  const at = (name: string): NormalResult => terrain().find((r) => r.name === name)!;

  it('are within their goldens in every case (angle to the analytic normal, p50 / p95 / max)', { timeout: 30_000 }, () => {
    for (const r of terrain()) {
      const g = TERRAIN_NORMAL_GOLDENS[r.name]!;
      expect(r.corners, r.name).toBeGreaterThan(1000);
      expect(r.p50Deg, `${r.name} p50`).toBeLessThanOrEqual(g.p50Deg);
      expect(r.p95Deg, `${r.name} p95`).toBeLessThanOrEqual(g.p95Deg);
      expect(r.maxDeg, `${r.name} max`).toBeLessThanOrEqual(g.maxDeg);
    }
  });

  it('show no stair banding on 1:20 and 1:5 slopes: every corner within 2° where the reference nets turn up to 7°', { timeout: 30_000 }, () => {
    const before = measureNormals(reference, cases);
    for (const name of ['slope-1:20', 'slope-1:5']) {
      expect(at(name).maxDeg, name).toBeLessThanOrEqual(SLOPE_NORMAL_MAX_DEG);
      expect(before.find((r) => r.name === name)!.maxDeg, `${name} before`).toBeGreaterThan(SLOPE_NORMAL_MAX_DEG);
    }
  });

  it('keep creases sharp: cliff top, terrace lips, ledge front and wall foot turn by at least the named angle; the reference blurs them', { timeout: 30_000 }, () => {
    const x = (name: string): number => x0(name);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
    const lines: Array<[string, (px: number, py: number, pz: number) => boolean]> = [
      ['cliff-20m', (px, py) => near(px, x('cliff-20m') + 28) && near(py, G + 40)],
      ['terraces-1', (px, py) => Array.from({ length: 9 }, (_, k) => k).some((k) => near(px, x('terraces-1') + 8 + 6 * k) && near(py, G + k + 1))],
      ['terraces-2', (px, py) => Array.from({ length: 7 }, (_, k) => k).some((k) => near(px, x('terraces-2') + 8 + 8 * k) && near(py, G + 2 * k + 2))],
      ['overhang', (px, py) => near(px, x('overhang') + 22) && (near(py, G + 16) || near(py, G + 11))],
      ['wall-1', (px, py, pz) => (near(px, x('wall-1') + 32) || near(px, x('wall-1') + 33)) && near(py, G) && pz > 17 && pz < 47],
    ];
    for (const [name, line] of lines) {
      const c = cases.find((k) => k.name === name)!;
      const angles = creaseAngles(terrainMesh(), c, line);
      expect(angles.length, name).toBeGreaterThan(40);
      expect(Math.min(...angles), name).toBeGreaterThanOrEqual(CREASE_KEPT_DEG);
      expect(Math.max(...creaseAngles(reference, c, line)), `${name} before`).toBe(0);
    }
    // The cave's mouth: most of the opening's rim (its rounded tunnel corners stay smooth).
    const cave = cases.find((k) => k.name === 'cave')!;
    const mouth = creaseAngles(terrainMesh(), cave, (px, py, pz) => near(px, cave.x0 + 12) && py > G && py < G + 9 && pz > 25 && pz < 39).sort((a, b) => a - b);
    expect(mouth[Math.floor(mouth.length / 2)]!).toBeGreaterThanOrEqual(CREASE_KEPT_DEG);
  });

  it('split no vertex on gentle ground: slopes and the bank keep one normal a position (across chunk faces too); bumps split only at their rims', { timeout: 30_000 }, () => {
    expect(CREASE_SPLIT_DEG).toBeLessThan(CREASE_KEPT_DEG);
    for (const name of ['slope-1:20', 'slope-1:5', 'bank-1:1']) {
      expect(at(name).splitVertices, name).toBe(0);
      expect(at(name).vertices, name).toBeGreaterThan(2000);
    }
    const bumps = cases.find((k) => k.name === 'bumps')!;
    const rims = [[16, 16, 6, 3], [40, 20, 8, 5], [24, 44, 4, 2], [47, 45, 10, 2.5], [33, 33, 3, 1.5]].map(([u, w, r, h]) => [bumps.x0 + u!, w!, Math.sqrt(r! * r! - (r! - h!) * (r! - h!))] as const);
    const offRim = creaseAngles(terrainMesh(), bumps, (px, py, pz) => !rims.some(([u, w, rr]) => Math.abs(Math.hypot(px - u, pz - w) - rr) < 1.5 && py < G + 1.5));
    expect(offRim.length).toBeGreaterThan(2000);
    expect(offRim.filter((a) => a > 0)).toEqual([]);
    expect(at('bumps').splitVertices).toBeGreaterThan(0);
  });
});

describe('the base surface (built cells: coplanar faces merged)', () => {
  /** Chunks (x0…x1, y0…y1, z0…z1) of a store meshed (whole chunks or joined sections) and welded, with the faces they expose. */
  const meshBase = (s: ReturnType<typeof createWorldStore>, r: readonly number[], sectionEdge: number): { mesh: BaseMesh; faces: Array<[number, number, number, number]> } => {
    const parts = [];
    const faces: Array<[number, number, number, number]> = [];
    for (let cx = r[0]!; cx <= r[1]!; cx++) for (let cy = r[2]!; cy <= r[3]!; cy++) for (let cz = r[4]!; cz <= r[5]!; cz++) {
      parts.push({ buf: chunkBase(s, cx, cy, cz, sectionEdge), cx, cy, cz });
      faces.push(...exposedFaces(s, cx, cy, cz));
    }
    return { mesh: weldBase(parts), faces };
  };

  it('keeps a closed body closed: a two-cell-thick shell with a window, across chunk and section faces, every edge two triangles wound opposite ways, no T-junction', () => {
    const s = createWorldStore(chunkGrid(32));
    const wall = { material: MAT.stone, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 };
    const inside = (x: number, y: number, z: number, a: readonly number[], b: readonly number[]): boolean => x >= a[0]! && x < b[0]! && y >= a[1]! && y < b[1]! && z >= a[2]! && z < b[2]!;
    // Floating in air (no ground under it), from y 26 to 40 over the chunk face at 32, x over the section face at 16.
    for (let x = 10; x < 24; x++) for (let y = 26; y < 40; y++) for (let z = 12; z < 24; z++) {
      if (inside(x, y, z, [12, 28, 14], [22, 38, 22])) continue;
      if (inside(x, y, z, [16, 31, 12], [18, 33, 14])) continue;
      s.setVoxel(x, y, z, wall);
    }
    for (const edge of [32, 16, 8]) {
      const { mesh, faces } = meshBase(s, [0, 0, 0, 1, 0, 0], edge);
      expect(faces.length).toBeGreaterThan(1500);
      expect(unmatchedEdges(mesh), `${edge}³`).toBe(0);
      expect(tJunctions(mesh), `${edge}³`).toBe(0);
      expect(coverage(mesh, faces), `${edge}³`).toEqual({ uncovered: 0, doubled: 0, area: faces.length, faces: faces.length });
      // Two triangles a face before; merges stop at section faces, so smaller sections merge less.
      expect(mesh.triangles.length / 3, `${edge}³`).toBeLessThan(edge === 8 ? faces.length : faces.length / 2);
    }
  });

  it('meshes the town\'s houses (walls with windows and doors, floors, stairs, roofs, beams, banisters) to the same faces with fewer triangles: no T-junction, the same open edges, cell for cell', () => {
    const s = createWorldStore(chunkGrid(32));
    loadArea(townWorld({ footprint: 128 }).grids[0]!, s, 0, 0, 128, 128);
    const { mesh, faces } = meshBase(s, [0, 3, -1, 1, 0, 3], 16);
    expect(faces.length).toBeGreaterThan(20000);
    expect(tJunctions(mesh)).toBe(0);
    expect(coverage(mesh, faces)).toEqual({ uncovered: 0, doubled: 0, area: faces.length, faces: faces.length });
    expect(openSegments(mesh)).toEqual(naiveOpenSegments(faces));
    // Two triangles a face before; at least a third fewer now, merges stopping at every section face.
    expect(mesh.triangles.length / 3).toBeLessThan((2 * faces.length * 2) / 3);
  });

  it('fails a merge that leaves T-junctions or a gap', () => {
    const s = createWorldStore(chunkGrid(32));
    loadArea(townWorld({ footprint: 128 }).grids[0]!, s, 0, 0, 64, 64);
    const { mesh, faces } = meshBase(s, [0, 1, 0, 0, 0, 1], 16);
    // A neighbour's long edge over the vertices of the triangles beside it: drop a vertex shared along a straight edge.
    const P = mesh.positions;
    const T = [...mesh.triangles];
    // A +x triangle whose loss uncovers a face (one of a quad split along a face's centre may leave it read as covered).
    const tornWithout = (t: number): BaseMesh => ({ positions: P, triangles: T.filter((_, i) => Math.floor(i / 3) !== t), dirs: mesh.dirs.filter((_, i) => i !== t) });
    const t0 = mesh.dirs.findIndex((d, t) => d === 1 && coverage(tornWithout(t), faces).uncovered > 0);
    expect(t0).toBeGreaterThanOrEqual(0);
    const torn = tornWithout(t0);
    expect(coverage(torn, faces).uncovered).toBeGreaterThan(0);
    expect(openSegments(torn)).not.toEqual(naiveOpenSegments(faces));
    // Two unit faces in a row drawn as one quad whose long edge passes a neighbour's vertex.
    const quad: BaseMesh = { positions: [0, 0, 0, 2, 0, 0, 2, 0, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2].map((v) => v * POSITION_STEPS_PER_CELL), triangles: [0, 3, 2, 0, 2, 1, 3, 5, 4, 3, 4, 2], dirs: [3, 3, 3, 3] };
    expect(tJunctions(quad)).toBe(0);
    // The far side split at (1, 0, 1), a point inside the near quad's edge (0, 0, 1)–(2, 0, 1).
    const tj: BaseMesh = { positions: [...quad.positions, POSITION_STEPS_PER_CELL, 0, POSITION_STEPS_PER_CELL], triangles: [0, 3, 2, 0, 2, 1, 3, 5, 4, 3, 4, 6, 6, 4, 2], dirs: [3, 3, 3, 3, 3] };
    expect(tJunctions(tj)).toBeGreaterThan(0);
  });
});

describe('seams between levels (two-level patches cut through the hard cases)', () => {
  // Every fourth ray of the bench's grid (`run.mjs seams` runs them all).
  const patches = [...featureSpecs(0, ['cliff-20m', 'cave', 'wall-1'], 4), ...featureSpecs(1, ['cliff-20m', 'cave'], 4)];

  it('no ray crosses either level alone, every patch leaks without a seam, and the coarser side\'s strip closes them, its vertices moved less than a coarse cell', { timeout: 60_000 }, () => {
    for (const spec of patches) {
      const r = measurePatch(spec, ['none', 'transition', 'skirts']);
      const at = `${spec.name} ${r.levels}`;
      const by = (c: string): SeamResult => r.results.find((x) => x.candidate === c)!;
      // The harness's own noise: rays the truth calls outside → inside that a one-level patch lets through.
      expect(r.truthRays, at).toBeGreaterThan(1000);
      expect(r.controlMisses, at).toEqual([0, 0]);
      expect(by('none').crackRays, at).toBeGreaterThan(0);
      expect(by('transition').crackRays, at).toBe(0);
      // A coarse boundary vertex lies within its own cube, the finer boundary within half a fine cell of the plane:
      // measured 0.34–0.55 of a coarse cell here (the caves world reaches 5 m where the levels' tunnels differ).
      expect(by('transition').maxMoveM, at).toBeLessThan(mipCellMetres(spec.fine + 1));
      // A strip of the boundary's length against a flap under both sides' boundaries.
      expect(by('transition').addedTriangles, at).toBeLessThan(by('skirts').addedTriangles);
    }
  });
});
