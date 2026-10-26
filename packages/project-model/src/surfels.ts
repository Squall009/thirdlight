/**
 * Surfels: where the surface cache keeps the light of an imported static
 * model. Blocks, terrain and generated architecture are addressed from their
 * own data; a model's light lives in its UV1 when it has one (the lightmap
 * UVs) and otherwise on surfels, small discs spread over its surface at
 * import (no unwrap needed). Every static model gets surfels: a traced ray
 * hits a model's distance field, not its triangles, and the nearest surfel
 * says which cache texel (its own, or its UV1 point) holds the light there.
 *
 * - Spread at the model's distance-field voxel (`distanceBrickVoxel`): the
 *   cache never needs a model's light finer than the field it is traced by.
 * - One surfel per occupied cell of a grid at that spacing and per facing
 *   (the normal's major axis and sign), so both sides of a wall thinner than
 *   a cell keep their own light.
 * - Nested levels: level k keeps one level-(k − 1) surfel per cell of a grid
 *   twice as coarse, so each level is a prefix of the list (coarsest first)
 *   and a cache page held at a coarser resolution takes the first
 *   `levels[k]` surfels.
 *
 * Pure and deterministic (the same model file gives the same surfels).
 */

type V3 = [number, number, number];

/** One piece's surfels, in the model's root space. */
export interface SurfelSet {
  /** Level 0's grid spacing (metres). */
  spacing: number;
  /** The piece's surface area (m²): what a UV1 page is sized by. */
  area: number;
  /** Surfels at each level (`levels[0]` is all of them; each level a prefix of the list). */
  levels: number[];
  /** xyz per surfel, coarsest level first. */
  positions: Float32Array;
  /** The unit normal per surfel (xyz). */
  normals: Float32Array;
  /** UV1 (u, v) per surfel when every triangle of the piece has UV1, else null. */
  uv1: Float32Array | null;
}

/** A piece's triangles as read from the model (`ModelGeometryPrimitive`'s parts). */
export interface SurfelSource {
  positions: readonly (readonly number[])[];
  triangles: readonly (readonly number[])[];
  /** TEXCOORD_1 pairs per vertex (null or absent: none). */
  uv1?: readonly number[] | null;
}

/** Candidates per spacing along and across a triangle. */
const CANDIDATES_PER_SPACING = 2;

/** The facing class of a normal: its major axis × 2, + 1 when it points along −axis. */
export function surfelFacing(n: readonly number[]): number {
  const a = Math.abs(n[0]!) >= Math.abs(n[1]!) && Math.abs(n[0]!) >= Math.abs(n[2]!) ? 0 : Math.abs(n[1]!) >= Math.abs(n[2]!) ? 1 : 2;
  return a * 2 + (n[a]! < 0 ? 1 : 0);
}

/** A grid cell and facing as one key (exact for cells within ±32,768 of the origin; farther ones wrap, which only costs a lookup a neighbour's surfel). */
export function surfelCellKey(p: readonly number[], cell: number, facing: number): number {
  const q = (v: number): number => (((Math.floor(v / cell) + 32768) % 65536) + 65536) % 65536;
  return ((q(p[0]!) * 65536 + q(p[1]!)) * 65536 + q(p[2]!)) * 8 + facing;
}

/**
 * The upper bound on the distance from any point of the surface to the
 * nearest surfel of level `k` with the same facing (metres): a candidate
 * lies within half a spacing, and each level's surfel within its cell.
 */
export function surfelCoverage(spacing: number, k: number): number {
  return spacing / CANDIDATES_PER_SPACING + Math.sqrt(3) * spacing * (2 ** (k + 1) - 1);
}

/** Candidate points over one triangle: rows parallel to its longest edge, at most `h` apart along and across. */
function candidates(a: V3, b: V3, c: V3, h: number, out: (p: V3, w: [number, number, number]) => void): void {
  const e = [[a, b, c], [b, c, a], [c, a, b]] as const;
  const len = (p: V3, q: V3): number => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  let best = 0;
  for (let i = 1; i < 3; i += 1) if (len(e[i]![0], e[i]![1]) > len(e[best]![0], e[best]![1])) best = i;
  const [p, q, r] = e[best]!;
  const base = len(p, q);
  const ab: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const ac: V3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const height = Math.hypot(cr[0]!, cr[1]!, cr[2]!) / Math.max(base, 1e-12);
  const rows = Math.max(1, Math.ceil(height / h));
  for (let k = 0; k < rows; k += 1) {
    const t = (k + 0.5) / rows;
    const n = Math.max(1, Math.ceil((base * (1 - t)) / h));
    for (let i = 0; i < n; i += 1) {
      const s = ((i + 0.5) / n) * (1 - t);
      // Weights of p, q, r.
      const w: [number, number, number] = [1 - s - t, s, t];
      const pt: V3 = [p[0] * w[0] + q[0] * w[1] + r[0] * w[2], p[1] * w[0] + q[1] * w[1] + r[1] * w[2], p[2] * w[0] + q[2] * w[1] + r[2] * w[2]];
      // Back to the weights of a, b, c.
      const wa: [number, number, number] = [0, 0, 0];
      wa[best] = w[0];
      wa[(best + 1) % 3] = w[1];
      wa[(best + 2) % 3] = w[2];
      out(pt, wa);
    }
  }
}

interface Candidate {
  p: V3;
  n: V3;
  uv: [number, number];
  facing: number;
}

/** The candidate nearest each occupied cell's centre (ties: the first), per facing, in the order cells are first met. */
function thin(list: readonly Candidate[], cell: number): Candidate[] {
  const best = new Map<number, { c: Candidate; d: number }>();
  for (const c of list) {
    const key = surfelCellKey(c.p, cell, c.facing);
    const centre = c.p.map((v) => (Math.floor(v / cell) + 0.5) * cell);
    const d = (c.p[0] - centre[0]!) ** 2 + (c.p[1] - centre[1]!) ** 2 + (c.p[2] - centre[2]!) ** 2;
    const was = best.get(key);
    if (was === undefined || d < was.d) best.set(key, { c, d });
  }
  return [...best.values()].map((v) => v.c);
}

/** A piece's surfels at `spacing` (null: no triangle with area). */
export function buildSurfelSet(parts: readonly SurfelSource[], spacing: number): SurfelSet | null {
  const all: Candidate[] = [];
  let area = 0;
  let uv1 = true;
  const h = spacing / CANDIDATES_PER_SPACING;
  for (const part of parts) {
    const uv = part.uv1 ?? null;
    if (uv === null) uv1 = false;
    for (const t of part.triangles) {
      const [a, b, c] = [0, 1, 2].map((k) => part.positions[t[k]!]!.slice(0, 3) as V3) as [V3, V3, V3];
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(cr[0], cr[1], cr[2]);
      if (!(l > 1e-12)) continue;
      area += l / 2;
      const n: V3 = [cr[0] / l, cr[1] / l, cr[2] / l];
      const facing = surfelFacing(n);
      const tuv = (k: number): [number, number] => (uv === null ? [0, 0] : [uv[t[k]! * 2] ?? 0, uv[t[k]! * 2 + 1] ?? 0]);
      const [ua, ub, uc] = [tuv(0), tuv(1), tuv(2)];
      candidates(a, b, c, h, (p, w) => all.push({ p, n, facing, uv: [ua[0] * w[0] + ub[0] * w[1] + uc[0] * w[2], ua[1] * w[0] + ub[1] * w[1] + uc[1] * w[2]] }));
    }
  }
  if (all.length === 0) return null;
  // Nested levels: each from the one below, on a grid twice as coarse, until a cell spans the piece (a few surfels per facing are left).
  let extent = 0;
  for (let k = 0; k < 3; k += 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of all) {
      lo = Math.min(lo, c.p[k]!);
      hi = Math.max(hi, c.p[k]!);
    }
    extent = Math.max(extent, hi - lo);
  }
  const byLevel: Candidate[][] = [thin(all, spacing)];
  for (let cell = spacing * 2; cell <= 2 * extent; cell *= 2) {
    const below = byLevel[byLevel.length - 1]!;
    const next = thin(below, cell);
    if (next.length === below.length) break;
    byLevel.push(next);
  }
  // Coarsest first: each surfel's place is the coarsest level that keeps it.
  const order: Candidate[] = [];
  const placed = new Set<Candidate>();
  for (let k = byLevel.length - 1; k >= 0; k -= 1) for (const c of byLevel[k]!) if (!placed.has(c)) {
    placed.add(c);
    order.push(c);
  }
  const levels = byLevel.map((l) => l.length);
  const positions = new Float32Array(order.length * 3);
  const normals = new Float32Array(order.length * 3);
  const uvs = uv1 ? new Float32Array(order.length * 2) : null;
  order.forEach((c, i) => {
    positions.set(c.p, i * 3);
    normals.set(c.n, i * 3);
    uvs?.set(c.uv, i * 2);
  });
  return { spacing, area, levels, positions, normals, uv1: uvs };
}

/** Bytes a set takes in the blob (`encodeSurfelSet`). */
export function surfelSetBytes(s: SurfelSet): number {
  const n = s.levels[0] ?? 0;
  return 4 * (10 + s.levels.length) + n * 8 + (s.uv1 !== null ? n * 4 : 0);
}

/**
 * Writes a set at `o` (little-endian): spacing, area, level count, the
 * levels, has-UV1, the bounds (min, extent), then per surfel its position quantized to 16 bits over
 * the set's bounds, its normal octahedral in two bytes, and
 * UV1 in two 16-bit fractions. Returns the end.
 */
export function encodeSurfelSet(s: SurfelSet, dv: DataView, at: number): number {
  let o = at;
  const n = s.levels[0] ?? 0;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) {
    lo[k] = Math.min(lo[k]!, s.positions[i * 3 + k]!);
    hi[k] = Math.max(hi[k]!, s.positions[i * 3 + k]!);
  }
  if (n === 0) {
    lo.fill(0);
    hi.fill(0);
  }
  const f32 = (v: number): void => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  const u32 = (v: number): void => {
    dv.setUint32(o, v >>> 0, true);
    o += 4;
  };
  f32(s.spacing);
  f32(s.area);
  u32(s.levels.length);
  for (const v of s.levels) u32(v);
  u32(s.uv1 !== null ? 1 : 0);
  // Bounds as min and extent.
  for (const v of lo) f32(v);
  for (let k = 0; k < 3; k += 1) f32(hi[k]! - lo[k]!);
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const ext = hi[k]! - lo[k]!;
      dv.setUint16(o, ext > 0 ? Math.round(((s.positions[i * 3 + k]! - lo[k]!) / ext) * 65535) : 0, true);
      o += 2;
    }
    const [ox, oy] = octEncode(s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!);
    dv.setInt8(o, ox);
    dv.setInt8(o + 1, oy);
    o += 2;
  }
  if (s.uv1 !== null) {
    for (let i = 0; i < n * 2; i += 1) {
      dv.setUint16(o, Math.round(Math.min(1, Math.max(0, s.uv1[i]!)) * 65535), true);
      o += 2;
    }
  }
  return o;
}

/** Reads a set written by `encodeSurfelSet` (null: cut short). */
export function decodeSurfelSet(dv: DataView, at: number): { set: SurfelSet; end: number } | null {
  let o = at;
  const need = (k: number): boolean => o + k <= dv.byteLength;
  if (!need(12)) return null;
  const spacing = dv.getFloat32(o, true);
  const area = dv.getFloat32(o + 4, true);
  const count = dv.getUint32(o + 8, true);
  o += 12;
  if (count > 64 || !need(count * 4 + 4 + 24)) return null;
  const levels: number[] = [];
  for (let i = 0; i < count; i += 1) levels.push(dv.getUint32(o + i * 4, true));
  o += count * 4;
  const hasUv = dv.getUint32(o, true) === 1;
  o += 4;
  const lo = [0, 1, 2].map((k) => dv.getFloat32(o + k * 4, true));
  const ext = [0, 1, 2].map((k) => dv.getFloat32(o + 12 + k * 4, true));
  o += 24;
  const n = levels[0] ?? 0;
  if (!need(n * 8 + (hasUv ? n * 4 : 0))) return null;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < 3; k += 1) positions[i * 3 + k] = lo[k]! + (dv.getUint16(o + k * 2, true) / 65535) * ext[k]!;
    const nn = octDecode(dv.getInt8(o + 6), dv.getInt8(o + 7));
    normals.set(nn, i * 3);
    o += 8;
  }
  let uv1: Float32Array | null = null;
  if (hasUv) {
    uv1 = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i += 1) {
      uv1[i] = dv.getUint16(o, true) / 65535;
      o += 2;
    }
  }
  return { set: { spacing, area, levels, positions, normals, uv1 }, end: Math.ceil(o / 4) * 4 };
}

function octEncode(x: number, y: number, z: number): [number, number] {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / s;
  let v = y / s;
  if (z < 0) [u, v] = [(1 - Math.abs(v)) * (u >= 0 ? 1 : -1), (1 - Math.abs(u)) * (v >= 0 ? 1 : -1)];
  return [Math.round(u * 127), Math.round(v * 127)];
}

function octDecode(qx: number, qy: number): V3 {
  let x = qx / 127;
  let y = qy / 127;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
