/**
 * Distance-field bricks: what the lighting tracer knows of an imported
 * static model's shape. Blocks, terrain and generated architecture are
 * traced exactly from their own data; a model's triangles are not, so the
 * model gets a signed distance field, sparse, made once per model file
 * (cached with the asset and shipped in the export, never at load).
 *
 * - One set per top-level piece of the model (a model shown whole places
 *   all of them), in the model's root space.
 * - Samples on a grid of `voxel` metres: at least 32 and at most 128 along
 *   the model's longest side, else 10 cm (`distanceBrickVoxel`).
 * - Bricks of 8 × 8 × 8 cells hold their 9 × 9 × 9 corner samples (a
 *   brick's samples never need a neighbour's), quantized to a byte over
 *   ±`band` (two voxels). Only bricks the surface passes through store
 *   samples; the others say "outside" or "inside" in one word.
 * - The sign comes from the angle-weighted pseudo-normal of the nearest
 *   feature (face, edge or vertex), which holds on closed meshes; samples
 *   further than the band from every triangle are inside when the outside
 *   (flooded in from the field's border) cannot reach them, so a mesh with
 *   holes reads as a shell, never as solid.
 *
 * Pure and deterministic.
 */
import type { ModelGeometry } from './model-collision';
import { modelRenderPrimitives } from './model-collision';

/** Cells per brick side. */
export const DISTANCE_BRICK_CELLS = 8;
/** Samples per brick side (its corners included). */
export const DISTANCE_BRICK_SIDE = DISTANCE_BRICK_CELLS + 1;
/** Samples per brick. */
export const DISTANCE_BRICK_SAMPLES = DISTANCE_BRICK_SIDE ** 3;
/** A brick the surface does not pass through, outside the model. */
export const DISTANCE_BRICK_OUTSIDE = -1;
/** A brick wholly inside the model. */
export const DISTANCE_BRICK_INSIDE = -2;
/** The format's version (raised when a blob made before would read differently). */
export const DISTANCE_BRICKS_VERSION = 1;
/** Band of the stored distances, in voxels: a sample farther than this from the surface stores the band. */
export const DISTANCE_BRICK_BAND_VOXELS = 2;

/** One piece's field. */
export interface DistanceBrickSet {
  /** The top-level piece it is of (`''`: the model has one). */
  piece: string;
  /** The field's first sample, in the model's root space. */
  min: [number, number, number];
  voxel: number;
  /** Distances are stored over ±band (metres). */
  band: number;
  /** Bricks per axis. */
  dims: [number, number, number];
  /** Per brick (x fastest, then y, then z): its sample block, or OUTSIDE / INSIDE. */
  bricks: Int32Array;
  /** Sample blocks of `DISTANCE_BRICK_SAMPLES` bytes (x fastest, then y, then z): 0 is −band, 255 is +band. */
  samples: Uint8Array;
}

export interface DistanceBricks {
  sets: DistanceBrickSet[];
}

/** Sample spacing for a model whose longest side is `longest` metres. */
export function distanceBrickVoxel(longest: number): number {
  return Math.min(longest / 32, Math.max(longest / 128, 0.1));
}

/** A stored byte as a distance (metres). */
export function distanceOfSample(q: number, band: number): number {
  return ((q / 255) * 2 - 1) * band;
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const addTo = (a: V3, b: V3, s = 1): void => {
  a[0] += b[0] * s;
  a[1] += b[1] * s;
  a[2] += b[2] * s;
};
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/**
 * The nearest point of triangle abc to p and the feature it lies on
 * (0 face, 1–3 vertex a/b/c, 4–6 edge ab/bc/ca), after Ericson's
 * "Real-Time Collision Detection" 5.1.5.
 */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): { q: V3; feature: number } {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { q: a, feature: 1 };
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { q: b, feature: 2 };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { q: [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v], feature: 4 };
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { q: c, feature: 3 };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { q: [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w], feature: 6 };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { q: [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w], feature: 5 };
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return { q: [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w], feature: 0 };
}

/** One piece's triangles, welded (a glTF splits vertices at seams; the pseudo-normals need them joined). */
interface Mesh {
  pos: V3[];
  tris: [number, number, number][];
}

function weld(positions: readonly (readonly number[])[], triangles: readonly (readonly number[])[], into: Mesh, ids: Map<string, number>): void {
  const remap = positions.map((p) => {
    const key = `${Math.round(p[0]! * 1e5)},${Math.round(p[1]! * 1e5)},${Math.round(p[2]! * 1e5)}`;
    let i = ids.get(key);
    if (i === undefined) {
      i = into.pos.length;
      into.pos.push([p[0]!, p[1]!, p[2]!]);
      ids.set(key, i);
    }
    return i;
  });
  for (const t of triangles) {
    const tri: [number, number, number] = [remap[t[0]!]!, remap[t[1]!]!, remap[t[2]!]!];
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) into.tris.push(tri);
  }
}

/** A set's field from one piece's triangles (null: no triangles, or no extent). */
export function buildDistanceBrickSet(piece: string, mesh: { positions: readonly (readonly number[])[]; triangles: readonly (readonly number[])[] }[]): DistanceBrickSet | null {
  const m: Mesh = { pos: [], tris: [] };
  const ids = new Map<string, number>();
  for (const part of mesh) weld(part.positions, part.triangles, m, ids);
  if (m.tris.length === 0) return null;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const t of m.tris) {
    for (const i of t) {
      for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k]!, m.pos[i]![k]!);
        hi[k] = Math.max(hi[k]!, m.pos[i]![k]!);
      }
    }
  }
  const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(longest > 0)) return null;
  const voxel = distanceBrickVoxel(longest);
  const band = DISTANCE_BRICK_BAND_VOXELS * voxel;
  // A margin past the band all round: the border samples are outside and far, so the flood starts there.
  const pad = band + voxel;
  const min: V3 = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
  const dims: V3 = [0, 1, 2].map((k) => Math.ceil((hi[k]! + pad - min[k]!) / voxel / DISTANCE_BRICK_CELLS)) as V3;
  const S: V3 = [dims[0] * DISTANCE_BRICK_CELLS + 1, dims[1] * DISTANCE_BRICK_CELLS + 1, dims[2] * DISTANCE_BRICK_CELLS + 1];
  const count = S[0] * S[1] * S[2];
  const dist = new Float32Array(count).fill(Infinity);
  // Pseudo-normals: faces (unit), vertices (angle-weighted), edges (sum of their faces).
  const faceN = m.tris.map(([a, b, c]) => unit(cross(sub(m.pos[b]!, m.pos[a]!), sub(m.pos[c]!, m.pos[a]!))));
  const vertN: V3[] = m.pos.map(() => [0, 0, 0]);
  const edgeN = new Map<string, V3>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  m.tris.forEach((t, f) => {
    for (let k = 0; k < 3; k += 1) {
      const a = m.pos[t[k]!]!;
      const e1 = unit(sub(m.pos[t[(k + 1) % 3]!]!, a));
      const e2 = unit(sub(m.pos[t[(k + 2) % 3]!]!, a));
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
      addTo(vertN[t[k]!]!, faceN[f]!, angle);
      const ek = edgeKey(t[k]!, t[(k + 1) % 3]!);
      const e = edgeN.get(ek) ?? [0, 0, 0];
      addTo(e, faceN[f]!);
      edgeN.set(ek, e);
    }
  });
  // Each triangle updates the samples within the band of it (a narrow band: work grows with the surface, not the volume).
  m.tris.forEach((t, f) => {
    const [a, b, c] = [m.pos[t[0]]!, m.pos[t[1]]!, m.pos[t[2]]!];
    const from = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(a[k]!, b[k]!, c[k]!) - band - min[k]!) / voxel)));
    const to = [0, 1, 2].map((k) => Math.min(S[k]! - 1, Math.ceil((Math.max(a[k]!, b[k]!, c[k]!) + band - min[k]!) / voxel)));
    for (let z = from[2]!; z <= to[2]!; z += 1) {
      for (let y = from[1]!; y <= to[1]!; y += 1) {
        for (let x = from[0]!; x <= to[0]!; x += 1) {
          const p: V3 = [min[0] + x * voxel, min[1] + y * voxel, min[2] + z * voxel];
          const { q, feature } = closestOnTriangle(p, a, b, c);
          const v = sub(p, q);
          const d = Math.hypot(v[0], v[1], v[2]);
          const i = (z * S[1] + y) * S[0] + x;
          if (d >= Math.abs(dist[i]!)) continue;
          const n = feature === 0 ? faceN[f]! : feature <= 3 ? vertN[t[feature - 1]!]! : edgeN.get(edgeKey(t[feature - 4]!, t[(feature - 3) % 3]!))!;
          dist[i] = dot(v, n) < 0 ? -d : d;
        }
      }
    }
  });
  // Far samples: outside if the border reaches them through far samples, else inside.
  const outside = new Uint8Array(count);
  const stack: number[] = [];
  const far = (i: number): boolean => !(Math.abs(dist[i]!) <= band);
  for (let z = 0; z < S[2]; z += 1) {
    for (let y = 0; y < S[1]; y += 1) {
      for (let x = 0; x < S[0]; x += 1) {
        if (x !== 0 && y !== 0 && z !== 0 && x !== S[0] - 1 && y !== S[1] - 1 && z !== S[2] - 1) continue;
        const i = (z * S[1] + y) * S[0] + x;
        if (far(i) && dist[i]! >= 0) {
          outside[i] = 1;
          stack.push(i);
        }
      }
    }
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % S[0];
    const y = Math.floor(i / S[0]) % S[1];
    const z = Math.floor(i / (S[0] * S[1]));
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= S[0] || ny >= S[1] || nz >= S[2]) continue;
      const j = (nz * S[1] + ny) * S[0] + nx;
      if (outside[j] === 0 && far(j) && dist[j]! >= 0) {
        outside[j] = 1;
        stack.push(j);
      }
    }
  }
  const brickCount = dims[0] * dims[1] * dims[2];
  const bricks = new Int32Array(brickCount);
  const blocks: Uint8Array[] = [];
  const q = (i: number): number => {
    const d = Number.isFinite(dist[i]!) ? dist[i]! : outside[i] === 1 ? band : -band;
    return Math.round((Math.max(-1, Math.min(1, d / band)) * 0.5 + 0.5) * 255);
  };
  for (let bz = 0; bz < dims[2]; bz += 1) {
    for (let by = 0; by < dims[1]; by += 1) {
      for (let bx = 0; bx < dims[0]; bx += 1) {
        const block = new Uint8Array(DISTANCE_BRICK_SAMPLES);
        let lowest = 255;
        let highest = 0;
        for (let z = 0; z < DISTANCE_BRICK_SIDE; z += 1) {
          for (let y = 0; y < DISTANCE_BRICK_SIDE; y += 1) {
            for (let x = 0; x < DISTANCE_BRICK_SIDE; x += 1) {
              const i = ((bz * DISTANCE_BRICK_CELLS + z) * S[1] + by * DISTANCE_BRICK_CELLS + y) * S[0] + bx * DISTANCE_BRICK_CELLS + x;
              const v = q(i);
              block[(z * DISTANCE_BRICK_SIDE + y) * DISTANCE_BRICK_SIDE + x] = v;
              lowest = Math.min(lowest, v);
              highest = Math.max(highest, v);
            }
          }
        }
        const b = (bz * dims[1] + by) * dims[0] + bx;
        if (lowest === 255) bricks[b] = DISTANCE_BRICK_OUTSIDE;
        else if (highest === 0) bricks[b] = DISTANCE_BRICK_INSIDE;
        else {
          bricks[b] = blocks.length;
          blocks.push(block);
        }
      }
    }
  }
  const samples = new Uint8Array(blocks.length * DISTANCE_BRICK_SAMPLES);
  blocks.forEach((b, i) => samples.set(b, i * DISTANCE_BRICK_SAMPLES));
  return { piece, min, voxel, band, dims, bricks, samples };
}

/** A model's fields: one set per top-level piece of its render geometry (level 0, no collision or occluder helpers). */
export function buildDistanceBricks(g: ModelGeometry): DistanceBricks {
  const byPiece = new Map<string, { positions: readonly (readonly number[])[]; triangles: readonly (readonly number[])[] }[]>();
  for (const p of modelRenderPrimitives(g, null)) {
    if (p.triangles.length === 0) continue;
    const list = byPiece.get(p.piece) ?? [];
    list.push({ positions: p.positions, triangles: p.triangles });
    byPiece.set(p.piece, list);
  }
  const single = byPiece.size === 1;
  const sets: DistanceBrickSet[] = [];
  for (const piece of [...byPiece.keys()].sort()) {
    const s = buildDistanceBrickSet(single ? '' : piece, byPiece.get(piece)!);
    if (s !== null) sets.push(s);
  }
  return { sets };
}

const MAGIC = 0x46444c54; // "TLDF"

/** The bricks as one blob (little-endian): magic, version, set count, then each set. */
export function encodeDistanceBricks(b: DistanceBricks): Uint8Array {
  const enc = new TextEncoder();
  const names = b.sets.map((s) => enc.encode(s.piece));
  let size = 12;
  b.sets.forEach((s, i) => {
    size += 4 + Math.ceil(names[i]!.length / 4) * 4 + 4 * 9 + s.bricks.length * 4 + Math.ceil(s.samples.length / 4) * 4;
  });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const u32 = (v: number): void => {
    dv.setUint32(o, v >>> 0, true);
    o += 4;
  };
  const f32 = (v: number): void => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  u32(MAGIC);
  u32(DISTANCE_BRICKS_VERSION);
  u32(b.sets.length);
  b.sets.forEach((s, i) => {
    u32(names[i]!.length);
    out.set(names[i]!, o);
    o += Math.ceil(names[i]!.length / 4) * 4;
    for (const v of s.min) f32(v);
    f32(s.voxel);
    f32(s.band);
    for (const v of s.dims) u32(v);
    u32(s.samples.length / DISTANCE_BRICK_SAMPLES);
    for (const v of s.bricks) {
      dv.setInt32(o, v, true);
      o += 4;
    }
    out.set(s.samples, o);
    o += Math.ceil(s.samples.length / 4) * 4;
  });
  return out;
}

/** A blob back to bricks (null: not a distance-brick blob of this version, or cut short). */
export function decodeDistanceBricks(bytes: Uint8Array): DistanceBricks | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): boolean => o + n <= bytes.byteLength;
  const u32 = (): number => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = (): number => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  if (!need(12) || u32() !== MAGIC || u32() !== DISTANCE_BRICKS_VERSION) return null;
  const n = u32();
  const sets: DistanceBrickSet[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < n; i += 1) {
    if (!need(4)) return null;
    const len = u32();
    if (!need(Math.ceil(len / 4) * 4 + 36)) return null;
    const piece = dec.decode(bytes.subarray(o, o + len));
    o += Math.ceil(len / 4) * 4;
    const min: [number, number, number] = [f32(), f32(), f32()];
    const voxel = f32();
    const band = f32();
    const dims: [number, number, number] = [u32(), u32(), u32()];
    const filled = u32();
    const count = dims[0] * dims[1] * dims[2];
    if (!need(count * 4 + Math.ceil((filled * DISTANCE_BRICK_SAMPLES) / 4) * 4)) return null;
    const bricks = new Int32Array(count);
    for (let k = 0; k < count; k += 1) {
      bricks[k] = dv.getInt32(o, true);
      o += 4;
    }
    const samples = bytes.slice(o, o + filled * DISTANCE_BRICK_SAMPLES);
    o += Math.ceil((filled * DISTANCE_BRICK_SAMPLES) / 4) * 4;
    sets.push({ piece, min, voxel, band, dims, bricks, samples });
  }
  return { sets };
}
