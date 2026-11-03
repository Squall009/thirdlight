/**
 * The golden harness on the real store and derive: the hard-case world
 * holds the solids its cases describe, the reference surface nets meet the
 * recorded goldens, and meshes broken on purpose (a hole torn, vertices
 * moved, a feature removed, a hole covered) fail them.
 */
import { chunkGrid, CREASE_SPLIT_DEG, createWorldStore, deriveFromStore, groundHeightfield, POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, TERRAIN_RULES, voxel, VOXEL_ROLE, type SurfaceBuffer } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { chunkBase, coverage, exposedFaces, naiveOpenSegments, openSegments, tJunctions, unmatchedEdges, weldBase, type BaseMesh } from './base-cases';
import { FEATURE_GROUND, featureCases, featuresStore } from './features';
import { REFERENCE_GOLDENS, TERRAIN_NORMAL_GOLDENS } from './mesh-goldens';
import { creaseAngles, goldenFailures, meshFeatures, measureCases, measureNormals, referenceMesher, terrainMesher, type CaseResult, type NormalResult, type WorldMesh } from './mesh-cases';
import { chunkMesherOf, MESHER_CANDIDATES, mesherCandidate } from './mesher-candidates';
import { loadArea } from './regions';
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
 * The smallest angle (degrees) the shading normals must turn by across a
 * crease the rules call sharp: the placed geometry's own corner (a 90° cliff
 * edge placed ~64°, a one-cell terrace lip ~40°), well above the
 * {@link CREASE_SPLIT_DEG} a curved face may turn without splitting.
 */
const CREASE_KEPT_DEG = 35;

/** The worst normal error a gentle plane slope may show (the 4-bit fill's rounding banded 1:5 up to 7° before). */
const SLOPE_NORMAL_MAX_DEG = 2;

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
    const t0 = T.findIndex((_, i) => i % 3 === 0 && mesh.dirs[i / 3] === 1);
    const torn: BaseMesh = { positions: P, triangles: T.filter((_, i) => Math.floor(i / 3) !== t0 / 3), dirs: mesh.dirs.filter((_, i) => i !== t0 / 3) };
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
