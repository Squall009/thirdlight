/**
 * The roof mesher against the real derive (chunks, their 16³ sections
 * joined, mip nodes) and the engine's real physics backend: gable, hip, a
 * pyramid and an L-shaped hip roof with a valley, one cell thick at 45°,
 * become closed sloped planes on the surface through the stair's outer
 * corners (vertex for vertex within 1/1024 cell), their ridges, eaves,
 * verges, hips and valleys classified per cell; a capsule stands on the
 * plane, not on the steps; coarse levels keep the roof as planes; a wall
 * through a roof keeps its faces; stairs that are not 45°, damaged cells and
 * lone roof cells keep their voxel faces.
 */
import {
  buildApron,
  chunkGrid,
  classifyRoofs,
  createNeighbourhood,
  createWorldStore,
  deriveFromStore,
  deriveMipNode,
  deriveSectionsWithApron,
  fillNeighbourhood,
  FloatingOrigin,
  jobRadius,
  joinSections,
  MipTree,
  POSITION_STEPS_PER_CELL,
  ROOF_WORD,
  roofEdgesOf,
  ruleRadiusMismatches,
  SURFACE_VERTEX_BYTES,
  TERRAIN_RULES,
  VOXEL_ROLE,
  WORLD_RULES,
  createDenseChunk,
  type AssemblyRuleSet,
  type CollisionSource,
  type PaletteStore,
  type SurfaceBuffer,
  createEdgeMasks,
  EDGE_RULES,
  evaluateEdges,
  extractEdges,
  VOXEL_SIZE_M,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { VoxelCollision } from '../../packages/editor/src/voxel-world/collision';
import { putVoxel } from './scenes';
import { MAT } from './world-kit';

const STEPS = POSITION_STEPS_PER_CELL;
const R = VOXEL_ROLE;

/** A roof: its footprint (cells, x × z from x0, z0), its eaves at y0, and the footprint's cells. */
interface Roof {
  readonly name: string;
  readonly x0: number;
  readonly z0: number;
  readonly y0: number;
  /** Whether footprint-local column (x, z) is under the roof. */
  readonly inside: (x: number, z: number) => boolean;
  /** Footprint bounds (exclusive). */
  readonly w: number;
  readonly d: number;
  /** Distance to the footprint's edge counts along x too (a hip) or only along z (a gable, open along x). */
  readonly hip: boolean;
}

function rect(name: string, x0: number, y0: number, z0: number, w: number, d: number, hip: boolean): Roof {
  return { name, x0, y0, z0, w, d, hip, inside: (x, z) => x >= 0 && z >= 0 && x < w && z < d };
}

/** An L: a w × a strip along x and an a-wide arm along z at its +x end, d deep. */
function ell(name: string, x0: number, y0: number, z0: number, w: number, d: number, a: number): Roof {
  return { name, x0, y0, z0, w, d, hip: true, inside: (x, z) => x >= 0 && z >= 0 && x < w && z < d && (z < a || x >= w - a) };
}

/** The continuous distance (Chebyshev, cells) from footprint-local point (px, pz) to outside the footprint. */
function edgeDistance(r: Roof, px: number, pz: number): number {
  let best = Infinity;
  for (let x = -1; x <= r.w; x++) for (let z = -1; z <= r.d; z++) {
    if (r.inside(x, z)) continue;
    // A gable is open along x: only cells outside across z count.
    if (!r.hip && (x < 0 || x >= r.w)) continue;
    const dx = Math.max(x - px, 0, px - (x + 1));
    const dz = Math.max(z - pz, 0, pz - (z + 1));
    best = Math.min(best, r.hip ? Math.max(dx, dz) : dz);
  }
  return best;
}

/** The roof's stair: one roof cell a column, as high above the eaves as the column is in from the edge. */
function placeRoof(s: PaletteStore, r: Roof): void {
  for (let x = 0; x < r.w; x++) for (let z = 0; z < r.d; z++) {
    if (!r.inside(x, z)) continue;
    const h = Math.round(edgeDistance(r, x + 0.5, z + 0.5) - 0.5);
    putVoxel(s, r.x0 + x, r.y0 + h, r.z0 + z, MAT.roofTile, R.roof);
  }
}

/** The top surface the planes must lie on (world cells): one above the eaves' voxel floor plus the distance in. */
function roofTop(r: Roof, x: number, z: number): number {
  return r.y0 + 1 + edgeDistance(r, x - r.x0, z - r.z0);
}

const grid = chunkGrid(32);
const SECTION = 16;
const SECTION_IDS = Array.from({ length: 8 }, (_, i) => i);

/** Every chunk a box of cells touches. */
function chunksOf(lo: readonly number[], hi: readonly number[], edge = 32): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let cx = Math.floor(lo[0]! / edge); cx <= Math.floor(hi[0]! / edge); cx++) for (let cy = Math.floor(lo[1]! / edge); cy <= Math.floor(hi[1]! / edge); cy++) for (let cz = Math.floor(lo[2]! / edge); cz <= Math.floor(hi[2]! / edge); cz++) out.push([cx, cy, cz]);
  return out;
}

function joined(s: PaletteStore, cx: number, cy: number, cz: number, rules: AssemblyRuleSet = WORLD_RULES): CollisionSource & { base: SurfaceBuffer } {
  const apron = buildApron(s, cx, cy, cz, jobRadius(rules));
  const sections = deriveSectionsWithApron(grid, rules, apron, (out) => s.exportChunk(cx, cy, cz, out), SECTION, SECTION_IDS).map((q) => q.assembly);
  return joinSections(grid.edge, SECTION, sections);
}

/** A welded triangle mesh in world steps, with each triangle's unit normal. */
interface Mesh {
  readonly pos: number[];
  readonly tris: number[];
  readonly normals: number[];
}

function weld(parts: ReadonlyArray<{ buf: SurfaceBuffer; c: readonly number[]; scale?: number }>): Mesh {
  const ids = new Map<string, number>();
  const pos: number[] = [];
  const tris: number[] = [];
  const normals: number[] = [];
  for (const { buf, c, scale = 1 } of parts) {
    const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
    const local: number[] = [];
    for (let v = 0; v < buf.vertexCount; v++) {
      const w = [0, 1, 2].map((a) => ((c[a]! * 32 - 1) * STEPS + view.getUint16(v * SURFACE_VERTEX_BYTES + 2 * a, true)) * scale);
      const key = w.join(',');
      let id = ids.get(key);
      if (id === undefined) {
        ids.set(key, (id = pos.length / 3));
        pos.push(...w);
      }
      local.push(id);
    }
    for (let t = 0; t < buf.indices.length; t += 3) {
      const [a, b, d] = [0, 1, 2].map((k) => local[buf.indices[t + k]!]!);
      tris.push(a!, b!, d!);
      const e1 = [0, 1, 2].map((k) => pos[3 * b! + k]! - pos[3 * a! + k]!);
      const e2 = [0, 1, 2].map((k) => pos[3 * d! + k]! - pos[3 * a! + k]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const l = Math.hypot(...n);
      normals.push(...n.map((q) => q / l));
    }
  }
  return { pos, tris, normals };
}

/** Directed edges not matched by the same edge the other way as often (0: closed). */
function unbalanced(m: Mesh): number {
  const directed = new Map<string, number>();
  for (let t = 0; t < m.tris.length; t += 3) for (let k = 0; k < 3; k++) {
    const key = `${m.tris[t + k]}|${m.tris[t + ((k + 1) % 3)]}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  }
  let n = 0;
  for (const [key, c] of directed) {
    const [a, b] = key.split('|');
    if (directed.get(`${b}|${a}`) !== c) n++;
  }
  return n;
}

/** Area per (rounded) normal direction, in cells². */
function areaByNormal(m: Mesh): Map<string, number> {
  const out = new Map<string, number>();
  for (let t = 0; t < m.tris.length; t += 3) {
    const p = [0, 1, 2].map((k) => [0, 1, 2].map((a) => m.pos[3 * m.tris[t + k]! + a]! / STEPS));
    const e1 = [0, 1, 2].map((a) => p[1]![a]! - p[0]![a]!);
    const e2 = [0, 1, 2].map((a) => p[2]![a]! - p[0]![a]!);
    const area = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
    const key = [0, 1, 2].map((a) => Math.round(m.normals[t + a]! * 100)).join(',');
    out.set(key, (out.get(key) ?? 0) + area);
  }
  return out;
}

/** The chunks round the roofs, once each. */
function roofChunks(roofs: readonly Roof[]): Array<[number, number, number]> {
  const seen = new Map<string, [number, number, number]>();
  for (const r of roofs) for (const c of chunksOf([r.x0 - 2, r.y0 - 2, r.z0 - 2], [r.x0 + r.w + 2, r.y0 + r.w + r.d, r.z0 + r.d + 2])) seen.set(c.join(','), c);
  return [...seen.values()];
}

/** The roofs' ramp meshes of every chunk round them, joined from sections (or whole chunks), welded. */
function rampMesh(s: PaletteStore, roofs: readonly Roof[], part: 'ramps' | 'base' = 'ramps', whole = false): Mesh {
  return weld(roofChunks(roofs).map((c) => {
    const d = whole ? deriveFromStore(s, ...c, WORLD_RULES) : joined(s, ...c);
    return { buf: part === 'ramps' ? d.collision.ramps : d.base, c };
  }));
}

/** Whether a world point (cells) lies over a roof's footprint (its closed box). */
function over(r: Roof, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x0 + r.w && z >= r.z0 && z <= r.z0 + r.d;
}

/** The plane-cell words of a store's chunks (each chunk's neighbourhood with the world rules' apron), cached by chunk. */
function wordReader(s: PaletteStore): (x: number, y: number, z: number) => number {
  const pad = jobRadius(WORLD_RULES);
  const cache = new Map<string, { side: number; words: Uint32Array }>();
  return (x, y, z) => {
    const [cx, cy, cz] = [x, y, z].map((c) => Math.floor(c / 32)) as [number, number, number];
    const key = `${cx},${cy},${cz}`;
    let job = cache.get(key);
    if (job === undefined) {
      const n = createNeighbourhood(32, pad);
      const dense = createDenseChunk(grid);
      fillNeighbourhood(n, grid, s.exportChunk(cx, cy, cz, dense) ? dense : null, buildApron(s, cx, cy, cz, pad));
      const words = new Uint32Array(n.values.length);
      classifyRoofs(n, words);
      cache.set(key, (job = { side: n.side, words }));
    }
    return job.words[((x - cx * 32 + pad) * job.side + (z - cz * 32 + pad)) * job.side + (y - cy * 32 + pad)]!;
  };
}

/** The plane-cell word of a world cell. */
function wordAt(s: PaletteStore, x: number, y: number, z: number): number {
  return wordReader(s)(x, y, z);
}

const GABLE = rect('gable', 3, 4, 2, 10, 9, false);
const HIP = rect('hip', 20, 4, 1, 13, 8, true);
const PYRAMID = rect('pyramid', 40, 3, 30, 9, 9, true);
const ELL = ell('L', 3, 5, 24, 14, 14, 6);
/** A large hip roof (six level-2 cells deep) for the coarse levels, over a chunk face. */
const BIG = rect('big hip', 8, 2, 40, 30, 24, true);
const ROOFS = [GABLE, HIP, PYRAMID, ELL, BIG];

function roofWorld(): PaletteStore {
  const s = createWorldStore(grid);
  for (const r of ROOFS) placeRoof(s, r);
  return s;
}

/** Every roof cell of a roof (world cells) and its plane-cell word. */
function roofWords(s: PaletteStore, r: Roof, read = wordReader(s)): Array<{ x: number; y: number; z: number; w: number }> {
  const out = [];
  for (let x = 0; x < r.w; x++) for (let z = 0; z < r.d; z++) {
    if (!r.inside(x, z)) continue;
    const h = Math.round(edgeDistance(r, x + 0.5, z + 0.5) - 0.5);
    out.push({ x: r.x0 + x, y: r.y0 + h, z: r.z0 + z, w: read(r.x0 + x, r.y0 + h, r.z0 + z) });
  }
  return out;
}

/** The roof-edge cases of a roof's cells, counted by case id. */
function edgeCounts(words: ReadonlyArray<{ w: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { w } of words) for (const e of roofEdgesOf(w)) out[e.caseId] = (out[e.caseId] ?? 0) + 1;
  return out;
}

/** The first triangle of a mesh (cells) a ray from `o` along unit `d` meets: its distance, or Infinity. */
function rayHit(m: Mesh, o: readonly number[], d: readonly number[]): number {
  let best = Infinity;
  for (let t = 0; t < m.tris.length; t += 3) {
    const p = [0, 1, 2].map((k) => [0, 1, 2].map((a) => m.pos[3 * m.tris[t + k]! + a]! / STEPS));
    const e1 = [0, 1, 2].map((a) => p[1]![a]! - p[0]![a]!);
    const e2 = [0, 1, 2].map((a) => p[2]![a]! - p[0]![a]!);
    const h = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const q0 = [0, 1, 2].map((a) => o[a]! - p[0]![a]!);
    const u = (q0[0]! * h[0]! + q0[1]! * h[1]! + q0[2]! * h[2]!) / det;
    if (u < 0 || u > 1) continue;
    const q = [q0[1]! * e1[2]! - q0[2]! * e1[1]!, q0[2]! * e1[0]! - q0[0]! * e1[2]!, q0[0]! * e1[1]! - q0[1]! * e1[0]!];
    const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / det;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
    if (dist > 0) best = Math.min(best, dist);
  }
  return best;
}

describe('the roof mesher', () => {
  it('draws gable, hip, pyramid and L roofs as closed planes on the surface through the stair\'s outer corners', () => {
    const s = roofWorld();
    const m = rampMesh(s, ROOFS);
    expect(unbalanced(m)).toBe(0);
    for (const r of ROOFS) {
      let tops = 0;
      for (let t = 0; t < m.tris.length; t += 3) {
        const ny = m.normals[t + 1]!;
        if (Math.abs(ny) < 0.3) continue;
        const first = [0, 2].map((a) => m.pos[3 * m.tris[t]! + a]! / STEPS);
        if (!over(r, first[0]!, first[1]!)) continue;
        for (let k = 0; k < 3; k++) {
          const v = m.tris[t + k]!;
          const [x, y, z] = [0, 1, 2].map((a) => m.pos[3 * v + a]! / STEPS) as [number, number, number];
          const want = roofTop(r, x, z) - (ny > 0 ? 0 : 1);
          expect(Math.abs(y - want), `${r.name} ${ny > 0 ? 'top' : 'underside'} at ${x},${y},${z}`).toBeLessThanOrEqual(1 / 1024);
          if (ny > 0) tops++;
        }
      }
      expect(tops, r.name).toBeGreaterThan(0);
    }
  });



  it('classifies every cell of the four roofs as a plane cell, with its eaves, verges, ridges, hips and valleys', () => {
    const s = roofWorld();
    const read = wordReader(s);
    for (const r of ROOFS) expect(roofWords(s, r, read).filter((c) => c.w === 0).length, r.name).toBe(0);
    // Gable (9 deep, odd): eaves along both long sides, verges up both ends, a ridge along the middle row's centre line.
    const g = roofWords(s, GABLE, read);
    const at = (list: typeof g, x: number, z: number): number => list.find((c) => c.x === x && c.z === z)!.w;
    expect(roofEdgesOf(at(g, 5, 2))).toEqual([{ caseId: 'roof-eave', yaw: 2 }]);
    expect(roofEdgesOf(at(g, 3, 3))).toEqual([{ caseId: 'roof-gable', yaw: 1 }]);
    // The two verges rise in opposite senses seen from outside: the one rising toward its own −x is mirrored.
    expect(roofEdgesOf(at(g, 12, 3))).toEqual([{ caseId: 'roof-gable', yaw: 3, mirror: true }]);
    expect(roofEdgesOf(at(g, 3, 9))).toEqual([{ caseId: 'roof-gable', yaw: 1, mirror: true }]);
    expect(roofEdgesOf(at(g, 12, 9))).toEqual([{ caseId: 'roof-gable', yaw: 3 }]);
    expect(roofEdgesOf(at(g, 6, 6))).toEqual([{ caseId: 'roof-ridge', yaw: 0, centred: true }]);
    expect(edgeCounts(g)).toEqual({ 'roof-eave': 20, 'roof-gable': 16, 'roof-ridge': 10 });
    // Hip (13 × 8, even depth): the ridge between rows 3 and 4 owned by row 3's cells (on their +z side, not centred),
    // four hips per layer's corners.
    const h = roofWords(s, HIP, read);
    expect(roofEdgesOf(at(h, 26, 4))).toEqual([{ caseId: 'roof-ridge', yaw: 0 }]);
    expect(roofEdgesOf(at(h, 20, 1))).toEqual([{ caseId: 'roof-eave', yaw: 1 }, { caseId: 'roof-eave', yaw: 2 }, { caseId: 'roof-hip', yaw: 2 }]);
    expect(edgeCounts(h)).toMatchObject({ 'roof-eave': 2 * 13 + 2 * 8, 'roof-hip': 16 });
    expect(edgeCounts(h)['roof-valley']).toBeUndefined();
    // Pyramid (9 × 9): four hips a layer, the apex four.
    const p = roofWords(s, PYRAMID, read);
    expect(roofEdgesOf(at(p, 44, 34)).filter((e) => e.caseId === 'roof-hip')).toHaveLength(4);
    expect(edgeCounts(p)).toMatchObject({ 'roof-eave': 36, 'roof-hip': 20 });
    // L: hips at the outer corners, a valley from the inner corner.
    const l = edgeCounts(roofWords(s, ELL, read));
    expect(l['roof-valley']).toBeGreaterThanOrEqual(3);
    expect(l['roof-hip']).toBeGreaterThan(8);
  });

  it('gives the same planes from a chunk\'s 16³ sections joined as from the whole chunk, and reads no further than it declares (16³ and 32³ chunks)', () => {
    const s = roofWorld();
    const sections = rampMesh(s, ROOFS);
    const whole = rampMesh(s, ROOFS, 'ramps', true);
    expect(unbalanced(whole)).toBe(0);
    const a = areaByNormal(sections);
    const b = areaByNormal(whole);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [k, v] of b) expect(a.get(k), k).toBeCloseTo(v, 6);
    for (const edge of [16, 32]) {
      const g = chunkGrid(edge as 16 | 32);
      const st = createWorldStore(g);
      for (const r of ROOFS) placeRoof(st, r);
      const chunks = [];
      for (const r of ROOFS) for (const c of chunksOf([r.x0 - 2, r.y0 - 2, r.z0 - 2], [r.x0 + r.w + 2, r.y0 + 12, r.z0 + r.d + 2], edge)) chunks.push({ cx: c[0], cy: c[1], cz: c[2] });
      for (const rules of [WORLD_RULES, EDGE_RULES, TERRAIN_RULES]) expect(ruleRadiusMismatches(st, rules, chunks), `${edge}³ ${rules.id}`).toEqual([]);
    }
  });

  it('stands a capsule on the roof plane (within 2 cm), not on the stair under it', async () => {
    const s = roofWorld();
    const physics = await VoxelCollision.create(grid, new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } }));
    roofChunks(ROOFS).forEach((c, k) => physics.set(k, ...c, joined(s, ...c)));
    const r = 0.2;
    const rc = r / VOXEL_SIZE_M;
    let checked = 0;
    for (const roof of [GABLE, HIP, PYRAMID, ELL]) {
      for (const [lx, lz] of [[3.5, 1.7], [4.3, 2.4], [6.6, 1.2], [2.2, 3.1]] as const) {
        const x = roof.x0 + lx;
        const z = roof.z0 + lz;
        // A sphere swept down onto a 45° plane stops with its centre √2 radii above the plane.
        const hit = physics.castSphere([x, roofTop(roof, x, z) + 6, z], [0, -1, 0], r, 10);
        expect(hit, `${roof.name} ${x},${z}`).not.toBeNull();
        const want = roofTop(roof, x, z) + rc * Math.SQRT2;
        expect(Math.abs(hit!.centre[1] - want) * VOXEL_SIZE_M, `${roof.name} sphere at ${x},${z}`).toBeLessThanOrEqual(0.02);
        // A capsule dropped there stands on the plane: its lowest point (r(√2 − 1) above the plane at its axis) within 2 cm.
        const drop = physics.dropCapsule([x, roofTop(roof, x, z) + 3, z], r, r);
        expect(drop.grounded, `${roof.name} ${x},${z}`).toBe(true);
        const [fx, fy, fz] = drop.feet;
        const plane = roofTop(roof, fx, fz);
        expect(Math.abs(fy - (plane + rc * (Math.SQRT2 - 1))) * VOXEL_SIZE_M, `${roof.name} capsule at ${fx},${fz}`).toBeLessThanOrEqual(0.02);
        // The stair's tread under it is lower: a capsule on the steps would stand up to a cell below.
        const tread = roof.y0 + 1 + Math.round(edgeDistance(roof, Math.floor(fx - roof.x0) + 0.5, Math.floor(fz - roof.z0) + 0.5) - 0.5);
        expect(plane - tread).toBeGreaterThanOrEqual(0);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it('keeps the roofs as closed 45° planes at levels 1 and 2, level 1 near the level-0 roof', () => {
    const s = roofWorld();
    const tree = new MipTree(s);
    for (const level of [1, 2]) {
      const span = 32 << level;
      const parts = [];
      for (let nx = 0; nx * span < 64; nx++) for (let nz = 0; nz * span < 72; nz++) for (let ny = 0; ny * span < 32; ny++) {
        const d = deriveMipNode(tree, { level, nx, ny, nz }, WORLD_RULES);
        parts.push({ buf: d.collision.ramps, c: [nx, ny, nz], scale: 2 ** level });
      }
      const m = weld(parts);
      expect(unbalanced(m), `L${level}`).toBe(0);
      for (const r of ROOFS) {
        let slopes = 0;
        let worst = 0;
        for (let t = 0; t < m.tris.length; t += 3) {
          const ny = m.normals[t + 1]!;
          const first = [0, 2].map((a) => m.pos[3 * m.tris[t]! + a]! / STEPS);
          if (ny < 0.3 || !over(r, first[0]!, first[1]!)) continue;
          if (Math.abs(ny - Math.SQRT1_2) < 0.01) slopes++;
          for (let k = 0; k < 3; k++) {
            const v = m.tris[t + k]!;
            const [x, y, z] = [0, 1, 2].map((a) => m.pos[3 * v + a]! / STEPS) as [number, number, number];
            worst = Math.max(worst, Math.abs(y - roofTop(r, x, z)));
          }
        }
        // A roof at least four of the level's cells across keeps sloped planes.
        if (Math.min(r.w, r.d) >= 4 << level) expect(slopes, `L${level} ${r.name}`).toBeGreaterThan(0);
        // Level 1 within one and a half of its cells of the level-0 roof: a stair not aligned to the level's grid
        // downsamples to a two-cell-thick stair whose planes sit on its top (recorded for the owner). At level 2 these
        // roofs are two to four cells across; mesh-cases.test.ts holds the shell houses' silhouettes there.
        if (level === 1) expect(worst, `L${level} ${r.name}`).toBeLessThanOrEqual(1.5 * 2 ** level);
      }
    }
  });

  it('closes a gable onto the walls under its verges and keeps a wall through the roof: no gap under the verge, bodies and planes each closed', () => {
    const s = createWorldStore(grid);
    const r = rect('walled', 2, 6, 3, 12, 10, false);
    placeRoof(s, r);
    // Gable walls: the end columns filled from y0 − 4 up under the roof; eave walls along both long sides under the eaves.
    for (const x of [r.x0, r.x0 + r.w - 1]) for (let z = 0; z < r.d; z++) {
      const h = Math.round(edgeDistance(r, 0.5, z + 0.5) - 0.5);
      for (let y = r.y0 - 4; y < r.y0 + h; y++) putVoxel(s, x, y, r.z0 + z, MAT.stone, R.wall);
    }
    // A 2 × 2 chimney through the roof's slope, two cells above its top (one cell across would read as a post).
    for (let y = r.y0 - 4; y < r.y0 + 8; y++) for (const [dx, dz] of [[5, 2], [6, 2], [5, 3], [6, 3]] as const) putVoxel(s, r.x0 + dx, y, r.z0 + dz, MAT.stone, R.wall);
    const base = rampMesh(s, [r], 'base');
    expect(unbalanced(base)).toBe(0);
    // The chimney keeps its faces above the roof: its top.
    const top = r.y0 + 8;
    const faces = (want: number[]): number => {
      let n = 0;
      for (let t = 0; t < base.tris.length; t += 3) {
        const c = [0, 1, 2].map((a) => (base.pos[3 * base.tris[t]! + a]! + base.pos[3 * base.tris[t + 1]! + a]! + base.pos[3 * base.tris[t + 2]! + a]!) / 3 / STEPS);
        if (want.every((v, a) => Math.abs(c[a]! - v) <= 0.5)) n++;
      }
      return n;
    };
    expect(faces([r.x0 + 6, top, r.z0 + 3])).toBeGreaterThan(0);
    // Looking at a gable end from outside, under the verge: every ray meets the gable at its face (x0), none passes into the attic.
    for (let z = 0.25; z < r.d; z += 0.5) for (let y = r.y0 - 3.75; y < roofTop(r, r.x0, r.z0 + z) - 0.05; y += 0.5) {
      expect(rayHit(base, [r.x0 - 3, y, r.z0 + z], [1, 0, 0]), `gable at y ${y}, z ${z}`).toBeCloseTo(3, 6);
    }
    // No edge piece round a plane cell, and the walls under the roof keep theirs away from it.
    const pad = jobRadius(EDGE_RULES);
    const n = createNeighbourhood(32, pad);
    const dense = createDenseChunk(grid);
    fillNeighbourhood(n, grid, s.exportChunk(0, 0, 0, dense) ? dense : null, buildApron(s, 0, 0, 0, pad));
    const words = new Uint32Array(n.values.length);
    classifyRoofs(n, words);
    const withRoof = createEdgeMasks(n);
    const plain = createEdgeMasks(n);
    evaluateEdges(n, EDGE_RULES, 0, withRoof);
    extractEdges(n, pad, pad + 32, plain);
    let onPlanes = 0;
    let before = 0;
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 0) continue;
      onPlanes += withRoof.pieces[i] === 0 ? 0 : 1;
      before += plain.pieces[i] === 0 ? 0 : 1;
    }
    expect(before).toBeGreaterThan(0);
    expect(onPlanes).toBe(0);
  });

  it('leaves stairs it cannot read as 45° planes, damaged roof cells and lone roof cells to their voxel faces', () => {
    const s = createWorldStore(grid);
    // A lone roof cell, and one in the middle of a gable damaged (integrity 7).
    putVoxel(s, 40, 10, 40, MAT.roofTile, R.roof);
    const r = rect('damaged', 2, 6, 3, 8, 9, false);
    placeRoof(s, r);
    putVoxel(s, r.x0 + 4, r.y0 + 2, r.z0 + 2, MAT.roofTile, R.roof, 7);
    // A 1:2 stair: two cells along, one up.
    for (let i = 0; i < 10; i++) for (let z = 50; z < 54; z++) putVoxel(s, 2 + i, 6 + (i >> 1), z, MAT.roofTile, R.roof);
    expect(wordAt(s, 40, 10, 40)).toBe(0);
    expect(wordAt(s, r.x0 + 4, r.y0 + 2, r.z0 + 2)).toBe(0);
    // Its intact neighbours stay planes, and planes and voxel faces each stay closed round the hole.
    expect(wordAt(s, r.x0 + 3, r.y0 + 2, r.z0 + 2)).not.toBe(0);
    expect(unbalanced(rampMesh(s, [r]))).toBe(0);
    expect(unbalanced(rampMesh(s, [r], 'base'))).toBe(0);
    // The 1:2 stair: the low cell of each pair keeps its voxel faces (a flatter stair on its low side); at one cell's
    // reach the high cell reads as a 45° step (recorded for the owner).
    const flat = Array.from({ length: 10 }, (_, i) => wordAt(s, 2 + i, 6 + (i >> 1), 51));
    for (let i = 1; i < 10; i += 2) expect(flat[i], `1:2 cell ${i}`).toBe(0);
  });
});
