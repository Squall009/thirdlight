/**
 * The base surface's checks: the faces the built cells expose, as the
 * naive producer drew them (a quad a face, the "before"), against what the
 * derive draws now (coplanar faces merged), welded across sections and
 * chunks by exact position:
 * - coverage: every exposed face is covered by exactly one triangle facing
 *   its way, and nothing else is (equal area);
 * - no T-junction: no vertex lies inside another triangle's edge, so a
 *   merged edge never leaves a crack against its neighbour's vertices;
 * - open edges: an edge used once (a boundary) lies where the naive faces'
 *   boundary lies, cell for cell, and a closed body stays closed.
 */
import {
  ASSEMBLY_CLASS,
  buildApron,
  CLASS_MASK,
  chunkGrid,
  deriveFromStore,
  deriveSectionsWithApron,
  joinSections,
  jobRadius,
  POSITION_STEPS_PER_CELL,
  SURFACE_ISO,
  SURFACE_VERTEX_BYTES,
  TERRAIN_RULES,
  type PaletteStore,
  type SurfaceBuffer,
} from '@thirdlight/voxel';
import { terrainJob } from './mesher-candidates';

const grid = chunkGrid(32);
const E = grid.edge;
const STEPS = POSITION_STEPS_PER_CELL;

/** A chunk's base surface: the whole-chunk derive (`sectionEdge` 32) or its sections joined (the streamer's draw). */
export function chunkBase(store: PaletteStore, cx: number, cy: number, cz: number, sectionEdge: number): SurfaceBuffer {
  if (sectionEdge === E) return deriveFromStore(store, cx, cy, cz, TERRAIN_RULES).base;
  const n = E / sectionEdge;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, TERRAIN_RULES, buildApron(store, cx, cy, cz, jobRadius(TERRAIN_RULES)), (out) => store.exportChunk(cx, cy, cz, out), sectionEdge, ids);
  return joinSections(E, sectionEdge, results.map((r) => r.assembly)).base;
}

/** The exposed faces of a chunk's built cells (the naive producer's quads): world cell and direction (0 −x, 1 +x, 2 −y, 3 +y, 4 −z, 5 +z). */
export function exposedFaces(store: PaletteStore, cx: number, cy: number, cz: number): Array<[number, number, number, number]> {
  const { n, classes } = terrainJob(store, cx, cy, cz);
  const p = n.pad;
  const s = n.side;
  const stride = [s * s, 1, s];
  const out: Array<[number, number, number, number]> = [];
  for (let x = 0; x < E; x++) for (let y = 0; y < E; y++) for (let z = 0; z < E; z++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    if ((classes[i]! & CLASS_MASK) !== ASSEMBLY_CLASS.wall) continue;
    for (let d = 0; d < 6; d++) {
      const j = i + (d & 1 ? 1 : -1) * stride[d >> 1]!;
      const k = classes[j]! & CLASS_MASK;
      if (k === ASSEMBLY_CLASS.wall || (k === ASSEMBLY_CLASS.ground && n.shapes[j]! >= SURFACE_ISO)) continue;
      out.push([cx * E + x, cy * E + y, cz * E + z, d]);
    }
  }
  return out;
}

/** A welded mesh: positions in world steps, triangles of welded ids, each triangle's direction (from its normal). */
export interface BaseMesh {
  readonly positions: number[];
  readonly triangles: number[];
  readonly dirs: number[];
}

/** Chunks' base surfaces welded by world position (in steps). */
export function weldBase(parts: ReadonlyArray<{ buf: SurfaceBuffer; cx: number; cy: number; cz: number }>): BaseMesh {
  const ids = new Map<string, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  const dirs: number[] = [];
  for (const { buf, cx, cy, cz } of parts) {
    const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
    const local: number[] = [];
    for (let v = 0; v < buf.vertexCount; v++) {
      const o = v * SURFACE_VERTEX_BYTES;
      const w = [cx, cy, cz].map((c, a) => (c * E - 1) * STEPS + view.getUint16(o + 2 * a, true));
      const key = w.join(',');
      let id = ids.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        ids.set(key, id);
        positions.push(...w);
      }
      local.push(id);
    }
    for (let t = 0; t < buf.indices.length; t += 3) {
      const o = buf.indices[t]! * SURFACE_VERTEX_BYTES + 8;
      const nv = [view.getInt8(o), view.getInt8(o + 1), view.getInt8(o + 2)];
      const axis = nv.findIndex((c) => c !== 0);
      dirs.push(2 * axis + (nv[axis]! > 0 ? 1 : 0));
      triangles.push(local[buf.indices[t]!]!, local[buf.indices[t + 1]!]!, local[buf.indices[t + 2]!]!);
    }
  }
  return { positions, triangles, dirs };
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** Vertices lying strictly inside a triangle edge (positions are multiples of half a cell). */
export function tJunctions(m: BaseMesh): number {
  const at = new Set<string>();
  for (let v = 0; v < m.positions.length; v += 3) at.add(`${m.positions[v]},${m.positions[v + 1]},${m.positions[v + 2]}`);
  const H = STEPS / 2;
  const seen = new Set<string>();
  let count = 0;
  for (let t = 0; t < m.triangles.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = m.triangles[t + k]!;
    const b = m.triangles[t + ((k + 1) % 3)]!;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = [0, 1, 2].map((c) => (m.positions[3 * b + c]! - m.positions[3 * a + c]!) / H);
    const g = d.reduce((x, y) => gcd(x, y), 0);
    for (let j = 1; j < g; j++) {
      const p = [0, 1, 2].map((c) => m.positions[3 * a + c]! + (d[c]! / g) * j * H);
      if (at.has(p.join(','))) count++;
    }
  }
  return count;
}

/** Directed edges without a reverse twin, or used more than once: zero on a closed, consistently wound body. */
export function unmatchedEdges(m: BaseMesh): number {
  const directed = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3) for (let k = 0; k < 3; k++) {
    const key = `${m.triangles[t + k]}|${m.triangles[t + ((k + 1) % 3)]}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  }
  let n = 0;
  for (const [key, c] of directed) {
    const [a, b] = key.split('|');
    if (c !== 1 || directed.get(`${b}|${a}`) !== 1) n++;
  }
  return n;
}

/** Unit lattice segments that one triangle edge only runs along (world cells): the mesh's boundary, cell by cell. */
export function openSegments(m: BaseMesh): Set<string> {
  const count = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = m.triangles[t + k]!;
    const b = m.triangles[t + ((k + 1) % 3)]!;
    const pa = [0, 1, 2].map((c) => m.positions[3 * a + c]! / STEPS);
    const pb = [0, 1, 2].map((c) => m.positions[3 * b + c]! / STEPS);
    const diff = [0, 1, 2].filter((c) => pa[c] !== pb[c]);
    if (diff.length !== 1 || !pa.every(Number.isInteger) || !pb.every(Number.isInteger)) continue;
    const c = diff[0]!;
    for (let s = Math.min(pa[c]!, pb[c]!); s < Math.max(pa[c]!, pb[c]!); s++) {
      const q = [...pa];
      q[c] = s;
      const key = `${q.join(',')}+${c}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [k, n] of count) if (n === 1) out.add(k);
  return out;
}

/** The naive faces' boundary (a quad a face): unit segments that one face's edge only runs along. */
export function naiveOpenSegments(faces: ReadonlyArray<readonly [number, number, number, number]>): Set<string> {
  const count = new Map<string, number>();
  for (const [x, y, z, d] of faces) {
    const axis = d >> 1;
    const plane = [x, y, z];
    plane[axis]! += d & 1;
    for (let c = 0; c < 3; c++) {
      if (c === axis) continue;
      // The face's two edges along c, at the other in-plane axis o and o + 1.
      const o = 3 - axis - c;
      for (const off of [0, 1]) {
        const q = [...plane];
        q[o]! += off;
        const key = `${q.join(',')}+${c}`;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
  }
  const out = new Set<string>();
  for (const [k, n] of count) if (n === 1) out.add(k);
  return out;
}

/** Whether point (pu, pv) is in the triangle (inclusive), 2D. */
function inTriangle(pu: number, pv: number, t: readonly number[]): boolean {
  const s1 = (t[2]! - t[0]!) * (pv - t[1]!) - (t[3]! - t[1]!) * (pu - t[0]!);
  const s2 = (t[4]! - t[2]!) * (pv - t[3]!) - (t[5]! - t[3]!) * (pu - t[2]!);
  const s3 = (t[0]! - t[4]!) * (pv - t[5]!) - (t[1]! - t[5]!) * (pu - t[4]!);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/**
 * Coverage of the faces by the mesh: per face, how many triangles facing its
 * way cover a point inside it (off every lattice line), and the triangles'
 * area against the faces' (cells²).
 */
export function coverage(m: BaseMesh, faces: ReadonlyArray<readonly [number, number, number, number]>): { uncovered: number; doubled: number; area: number; faces: number } {
  // Triangles bucketed by plane (direction, coordinate) and unit cell of the plane they touch.
  const buckets = new Map<string, number[][]>();
  let area = 0;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const d = m.dirs[t / 3]!;
    const axis = d >> 1;
    const [u, v] = [0, 1, 2].filter((c) => c !== axis) as [number, number];
    const pts = [0, 1, 2].map((k) => m.triangles[t + k]!);
    const plane = m.positions[3 * pts[0]! + axis]! / STEPS;
    const tri = pts.flatMap((p) => [m.positions[3 * p + u]! / STEPS, m.positions[3 * p + v]! / STEPS]);
    area += Math.abs((tri[2]! - tri[0]!) * (tri[5]! - tri[1]!) - (tri[4]! - tri[0]!) * (tri[3]! - tri[1]!)) / 2;
    const [u0, u1] = [Math.floor(Math.min(tri[0]!, tri[2]!, tri[4]!)), Math.ceil(Math.max(tri[0]!, tri[2]!, tri[4]!))];
    const [v0, v1] = [Math.floor(Math.min(tri[1]!, tri[3]!, tri[5]!)), Math.ceil(Math.max(tri[1]!, tri[3]!, tri[5]!))];
    for (let a = u0; a < u1; a++) for (let b = v0; b < v1; b++) {
      const key = `${d}:${plane}:${a},${b}`;
      let list = buckets.get(key);
      if (list === undefined) buckets.set(key, (list = []));
      list.push(tri);
    }
  }
  let uncovered = 0;
  let doubled = 0;
  for (const [x, y, z, d] of faces) {
    const axis = d >> 1;
    const [u, v] = [0, 1, 2].filter((c) => c !== axis) as [number, number];
    const cell = [x, y, z];
    const plane = cell[axis]! + (d & 1);
    // A point off every line through two lattice points of the job (irrational offsets).
    const pu = cell[u]! + 0.31830988;
    const pv = cell[v]! + 0.57721566;
    const hits = (buckets.get(`${d}:${plane}:${cell[u]},${cell[v]}`) ?? []).filter((tri) => inTriangle(pu, pv, tri)).length;
    if (hits === 0) uncovered++;
    if (hits > 1) doubled++;
  }
  return { uncovered, doubled, area, faces: faces.length };
}
