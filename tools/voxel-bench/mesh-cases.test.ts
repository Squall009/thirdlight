/**
 * The golden harness on the real store and derive: the hard-case world
 * holds the solids its cases describe, the reference surface nets meet the
 * recorded goldens, and meshes broken on purpose (a hole torn, vertices
 * moved, a feature removed, a hole covered) fail them.
 */
import { voxel } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { FEATURE_GROUND, featureCases, featuresStore } from './features';
import { REFERENCE_GOLDENS } from './mesh-goldens';
import { goldenFailures, meshFeatures, measureCases, referenceMesher, type WorldMesh } from './mesh-cases';

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
