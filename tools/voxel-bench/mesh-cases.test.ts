/**
 * The golden harness on the real store and derive: the hard-case world
 * holds the solids its cases describe, the reference surface nets meet the
 * recorded goldens, and meshes broken on purpose (a hole torn, vertices
 * moved, a feature removed, a hole covered) fail them.
 */
import { chunkGrid, createWorldStore, deriveFromStore, groundHeightfield, POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, TERRAIN_RULES, voxel, type SurfaceBuffer } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { FEATURE_GROUND, featureCases, featuresStore } from './features';
import { REFERENCE_GOLDENS } from './mesh-goldens';
import { goldenFailures, meshFeatures, measureCases, referenceMesher, terrainMesher, type CaseResult, type WorldMesh } from './mesh-cases';
import { chunkMesherOf, MESHER_CANDIDATES, mesherCandidate } from './mesher-candidates';
import { loadArea } from './regions';
import { hillyWorld } from './worlds';

const G = FEATURE_GROUND;
const cases = featureCases();
const store = featuresStore();
const reference = meshFeatures(store, referenceMesher);
const x0 = (name: string): number => cases.find((c) => c.name === name)!.x0;

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
  const terrain = (): CaseResult[] => (cached ??= measureCases(meshFeatures(store, terrainMesher), cases));

  it('is the derive\'s ground under the terrain rules: the bench pick (lattice+dc), its other vertices kept off the lattice', () => {
    const pick = chunkMesherOf(mesherCandidate('lattice+dc'));
    const steps = POSITION_STEPS_PER_CELL;
    let compared = 0;
    let nudged = 0;
    for (let cx = 0; cx < 28; cx += 3) for (const cy of [-1, 0, 1]) for (const cz of [0, 1]) {
      const derived = deriveFromStore(store, cx, cy, cz, TERRAIN_RULES).ground;
      const bench = pick(store, cx, cy, cz);
      const at = `${cx},${cy},${cz}`;
      expect(derived.indices.length, at).toBe(bench.indices.length);
      // Same triangles; a non-lattice vertex on its cube's centre line (where only lattice vertices sit) moves one step along x.
      const a = new DataView(derived.vertices.buffer, derived.vertices.byteOffset, derived.vertices.byteLength);
      const b = new DataView(bench.vertices.buffer, bench.vertices.byteOffset, bench.vertices.byteLength);
      for (let t = 0; t < derived.indices.length; t++) {
        const p = [0, 1, 2].map((k) => a.getUint16(derived.indices[t]! * SURFACE_VERTEX_BYTES + 2 * k, true));
        const q = [0, 1, 2].map((k) => b.getUint16(bench.indices[t]! * SURFACE_VERTEX_BYTES + 2 * k, true));
        if (p.every((v, k) => v === q[k])) continue;
        expect([p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!, q[0]! % steps, q[2]! % steps], `${at} corner ${t}`).toEqual([1, 0, 0, 0, 0]);
        nudged++;
      }
      compared += derived.indices.length / 3;
    }
    expect(compared).toBeGreaterThan(20000);
    expect(nudged).toBeGreaterThan(0);
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
