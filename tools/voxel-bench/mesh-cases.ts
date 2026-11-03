/**
 * The terrain mesher's golden harness: meshes the hard-case world
 * (features.ts) chunk by chunk with a mesher, welds the chunks' ground
 * surfaces by their exact positions, and measures each case against its
 * analytic solid:
 * - watertight: every edge of the welded mesh is used by exactly two
 *   triangles, once in each direction (closed and consistently wound);
 * - error: distance from the analytic surface at every vertex and triangle
 *   centroid inside the case's measuring box (its pad less a margin, so the
 *   joins between pads and the world's sides do not count), max and mean,
 *   in metres;
 * - features kept: every probe ray first meets the mesh where it first
 *   meets the analytic solid (within half a cell), or misses both;
 * - triangles: those whose centroid lies in the measuring box.
 * The world's floor (its base, under every case) is in no measuring box.
 *
 * A candidate mesher is a function of the store and a chunk; the reference
 * is the derive's ground surface. Goldens bound later meshers per case.
 */
import { deriveFromStore, PLACEHOLDER_RULES, POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, chunkGrid, type PaletteStore, type SurfaceBuffer } from '@thirdlight/voxel';
import { caseIndexAt, FEATURE_BASE, FEATURE_PAD, FEATURE_TOP, FEATURE_WIDTH, featureCases, type FeatureCase, type FeatureProbe, type Sdf } from './features';

/** A chunk's ground surface from the store (positions chunk-local, as the derive writes them). */
export type ChunkMesher = (store: PaletteStore, cx: number, cy: number, cz: number) => SurfaceBuffer;

/** The reference: the derive's naive surface nets. */
export const referenceMesher: ChunkMesher = (store, cx, cy, cz) => deriveFromStore(store, cx, cy, cz, PLACEHOLDER_RULES).ground;

/** A welded mesh in world cells. */
export interface WorldMesh {
  /** x, y, z per vertex (cells). */
  readonly positions: Float64Array;
  /** Three welded vertex ids a triangle, counter-clockwise seen from outside. */
  readonly triangles: Uint32Array;
}

export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  /** Distance along the ray to the first hit (cells), null: none. */
  readonly expected: number | null;
  readonly got: number | null;
}

export interface CaseResult {
  readonly name: string;
  /** Triangles whose centroid is in the measuring box. */
  readonly triangles: number;
  /** Edges in the pad not shared by exactly two triangles wound opposite ways. */
  readonly openEdges: number;
  /** Triangles in the pad with two welded corners the same. */
  readonly degenerate: number;
  readonly maxErrorM: number;
  /** Where the largest error is (cells). */
  readonly worstAt: readonly [number, number, number];
  readonly meanErrorM: number;
  /** Vertices and centroids measured. */
  readonly samples: number;
  readonly probes: readonly ProbeResult[];
  /** Names of the probes that failed. */
  readonly lost: readonly string[];
}

/** One case's bounds for a mesher: errors at most these, closed, and no probe lost beyond `lost`. */
export interface CaseGolden {
  readonly triangles: number;
  readonly maxErrorM: number;
  readonly meanErrorM: number;
  readonly lost: readonly string[];
}

const M_PER_CELL = 0.5;
/** Cells kept clear of a pad's sides when measuring error. */
export const MEASURE_MARGIN = 6;
/** How far (cells) a probe's hit may lie from the analytic hit. */
export const PROBE_TOLERANCE = 0.5;

const grid = chunkGrid(32);

/**
 * Meshes every chunk that can own an edge of the world's surface (each
 * edge belongs to the chunk of its lower sample, so one chunk below each
 * axis's first) and welds the vertices by their quantized world position.
 */
export function meshFeatures(store: PaletteStore, mesher: ChunkMesher): WorldMesh {
  const e = grid.edge;
  const steps = POSITION_STEPS_PER_CELL;
  const ids = new Map<string, number>();
  const pos: number[] = [];
  const tris: number[] = [];
  const range = (lo: number, hi: number): [number, number] => [(lo >> grid.shift) - 1, (hi - 1) >> grid.shift];
  const [x0, x1] = range(0, FEATURE_WIDTH);
  const [y0, y1] = range(FEATURE_BASE, FEATURE_TOP);
  const [z0, z1] = range(0, FEATURE_PAD);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) {
    const buf = mesher(store, cx, cy, cz);
    if (buf.indices.length === 0) continue;
    const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
    const local = new Uint32Array(buf.vertexCount);
    for (let v = 0; v < buf.vertexCount; v++) {
      const o = v * SURFACE_VERTEX_BYTES;
      // World position in whole steps: equal bit for bit where two chunks compute the same vertex.
      const wx = (cx * e - 1) * steps + view.getUint16(o, true);
      const wy = (cy * e - 1) * steps + view.getUint16(o + 2, true);
      const wz = (cz * e - 1) * steps + view.getUint16(o + 4, true);
      const key = `${wx},${wy},${wz}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        ids.set(key, id);
        pos.push(wx / steps, wy / steps, wz / steps);
      }
      local[v] = id;
    }
    for (const i of buf.indices) tris.push(local[i]!);
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris) };
}

/** Distance along the ray to its first hit on the triangles listed (cells), or null. */
function rayHit(mesh: WorldMesh, list: readonly number[], p: FeatureProbe): number | null {
  const P = mesh.positions;
  const T = mesh.triangles;
  const [ox, oy, oz] = p.from;
  const [dx, dy, dz] = p.dir;
  let best: number | null = null;
  for (const t of list) {
    const a = 3 * T[3 * t]!;
    const b = 3 * T[3 * t + 1]!;
    const c = 3 * T[3 * t + 2]!;
    const e1x = P[b]! - P[a]!, e1y = P[b + 1]! - P[a + 1]!, e1z = P[b + 2]! - P[a + 2]!;
    const e2x = P[c]! - P[a]!, e2y = P[c + 1]! - P[a + 1]!, e2z = P[c + 2]! - P[a + 2]!;
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = ox - P[a]!, sy = oy - P[a + 1]!, sz = oz - P[a + 2]!;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (d >= 0 && d <= p.length && (best === null || d < best)) best = d;
  }
  return best;
}

/** Distance along the ray to where it first enters the analytic solid (cells), or null. */
export function analyticHit(sdf: Sdf, p: FeatureProbe): number | null {
  const at = (d: number): number => sdf(p.from[0] + p.dir[0] * d, p.from[1] + p.dir[1] * d, p.from[2] + p.dir[2] * d);
  const step = 0.05;
  if (at(0) > 0) return 0;
  for (let d = step; d <= p.length + 1e-9; d += step) {
    if (at(d) <= 0) continue;
    let lo = d - step;
    let hi = d;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid) > 0) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return null;
}

/** Measures every case of the hard-case world on a welded mesh. */
export function measureCases(mesh: WorldMesh, cases: readonly FeatureCase[] = featureCases()): CaseResult[] {
  const P = mesh.positions;
  const T = mesh.triangles;
  const nTri = T.length / 3;
  const perCase = cases.map(() => [] as number[]);
  const degenerate = cases.map(() => 0);
  // Directed edge counts over the non-degenerate triangles.
  const nv = P.length / 3;
  const directed = new Map<number, number>();
  for (let t = 0; t < nTri; t++) {
    const a = T[3 * t]!;
    const b = T[3 * t + 1]!;
    const c = T[3 * t + 2]!;
    const k = caseIndexAt((P[3 * a]! + P[3 * b]! + P[3 * c]!) / 3);
    if (a === b || b === c || c === a) {
      degenerate[k]!++;
      continue;
    }
    perCase[k]!.push(t);
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) directed.set(p * nv + q, (directed.get(p * nv + q) ?? 0) + 1);
  }
  const open = cases.map(() => 0);
  for (const [key, n] of directed) {
    const p = Math.floor(key / nv);
    const q = key % nv;
    const back = directed.get(q * nv + p) ?? 0;
    // Each unordered edge is looked at once: from its lower id, or from the only direction present.
    if (back > 0 && q < p) continue;
    if (n === 1 && back === 1) continue;
    open[caseIndexAt((P[3 * p]! + P[3 * q]!) / 2)]!++;
  }
  return cases.map((c, k) => {
    const lo = c.x0 + MEASURE_MARGIN;
    const hi = c.x0 + FEATURE_PAD - MEASURE_MARGIN;
    // The world's floor is not part of any case.
    const inBox = (x: number, y: number, z: number): boolean => x >= lo && x <= hi && z >= MEASURE_MARGIN && z <= FEATURE_PAD - MEASURE_MARGIN && y > FEATURE_BASE + 1;
    let max = 0;
    let worst: [number, number, number] = [0, 0, 0];
    let sum = 0;
    let n = 0;
    const sample = (x: number, y: number, z: number): void => {
      if (!inBox(x, y, z)) return;
      const d = Math.abs(c.sdf(x, y, z));
      if (d > max) {
        max = d;
        worst = [x, y, z];
      }
      sum += d;
      n++;
    };
    const seen = new Set<number>();
    let triangles = 0;
    for (const t of perCase[k]!) {
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < 3; j++) {
        const v = T[3 * t + j]!;
        cx += P[3 * v]! / 3;
        cy += P[3 * v + 1]! / 3;
        cz += P[3 * v + 2]! / 3;
        if (seen.has(v)) continue;
        seen.add(v);
        sample(P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!);
      }
      if (inBox(cx, cy, cz)) triangles++;
      sample(cx, cy, cz);
    }
    const probes = c.probes.map((p): ProbeResult => {
      const expected = analyticHit(c.sdf, p);
      const got = rayHit(mesh, perCase[k]!, p);
      const ok = expected === null ? got === null : got !== null && Math.abs(got - expected) <= PROBE_TOLERANCE;
      return { name: p.name, ok, expected, got };
    });
    return {
      name: c.name,
      triangles,
      openEdges: open[k]!,
      degenerate: degenerate[k]!,
      maxErrorM: max * M_PER_CELL,
      worstAt: worst,
      meanErrorM: n === 0 ? 0 : (sum / n) * M_PER_CELL,
      samples: n,
      probes,
      lost: probes.filter((p) => !p.ok).map((p) => p.name),
    };
  });
}

/** Why a case misses its golden (empty: within it). `slackM` widens the error bounds. */
export function goldenFailures(r: CaseResult, g: CaseGolden, slackM = 0): string[] {
  const out: string[] = [];
  if (r.openEdges > 0) out.push(`${r.name}: ${r.openEdges} open edges`);
  if (r.maxErrorM > g.maxErrorM + slackM) out.push(`${r.name}: max error ${r.maxErrorM.toFixed(4)} m > ${g.maxErrorM} m`);
  if (r.meanErrorM > g.meanErrorM + slackM) out.push(`${r.name}: mean error ${r.meanErrorM.toFixed(4)} m > ${g.meanErrorM} m`);
  for (const name of r.lost) if (!g.lost.includes(name)) out.push(`${r.name}: lost ${name}`);
  return out;
}
