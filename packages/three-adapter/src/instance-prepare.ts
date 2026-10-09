/**
 * The arithmetic of building an instance set (`instancing.ts`), apart from
 * the three.js objects it ends in, so it can run on a worker: the copies
 * split into chunks, each chunk's centre, every copy's matrix per mesh of
 * the model (its place times the mesh's offset in the model), the bounds of
 * each chunk draw, and what the per-copy levels of detail read (each copy's
 * origin, size and thinning rank).
 *
 * A large set (a landscape's scatter group: tens of thousands of copies)
 * costs tens of milliseconds here; the page then only makes the draws from
 * the arrays. The page runs the same function when no worker can.
 *
 * Pure: plain arrays, no three.js (the worker bundle stays small). The
 * matrix maths is three's (`Matrix4.compose`, `multiplyMatrices`,
 * `Sphere.union`), so a set made here equals one made on the page.
 */
import { INSTANCE_FLOATS } from '@thirdlight/runtime';

/**
 * Copies per chunk the grid aims at (a chunk is one draw per mesh: large
 * enough to keep draws few and its matrices above three's uniform-buffer
 * limit, small enough to cull locally).
 */
export const INSTANCE_CHUNK_COPIES = 2048;
/** Most chunks per set (bounds the draws of a very large set; 64 chunks × a few meshes stays well under any draw budget). */
export const INSTANCE_MAX_CHUNKS = 64;
/**
 * Most chunks per set when it is also chunked by spatial extent.
 * Chunks out of view are culled, so more of them cost draws only where they
 * are seen; 256 cells keep a set seen whole (from above) at a few hundred
 * draws per mesh. A set larger than 256 cells of its chunk size gets larger
 * cells.
 */
export const INSTANCE_MAX_SPATIAL_CHUNKS = 256;

/** The meshes of a set's model as the arithmetic reads them. */
export interface PrepareParts {
  /** Each mesh's offset in the model (16 floats each, column-major). */
  readonly locals: Float64Array;
  /** Each mesh's geometry bounding sphere (centre xyz, radius). */
  readonly spheres: Float64Array;
}

export interface PrepareOptions {
  /** No chunk wider than this (m; absent: by count only). */
  readonly chunkSize?: number;
  /** Copies per chunk the count grid aims at (absent: {@link INSTANCE_CHUNK_COPIES}). */
  readonly copiesPerChunk?: number;
  /** Make what per-copy levels and thinning read (origins, sizes, ranks). */
  readonly perCopy: boolean;
}

/** What the per-copy levels read of a chunk: its farthest copy from the centre, its copies' sizes, its blocks' spheres ({@link pickBlocks}). */
export interface PreparedPickStats {
  readonly reach: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly meanScale: number;
  readonly blocks: Float32Array;
}

/**
 * Copies per block the per-copy levels are picked in: a block whose
 * distance barely changed keeps its picks, so a moving eye repicks the
 * copies near it every frame and the far ones now and then.
 */
export const PICK_BLOCK = 64;

/** Each block of {@link PICK_BLOCK} copies' sphere (centre xyz, radius) around their origins (xyz each). */
export function pickBlocks(origins: ArrayLike<number>, count: number): Float32Array {
  const out = new Float32Array(Math.ceil(count / PICK_BLOCK) * 4);
  for (let b = 0; b * PICK_BLOCK < count; b += 1) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const end = Math.min(count, (b + 1) * PICK_BLOCK);
    for (let i = b * PICK_BLOCK; i < end; i += 1) {
      const x = origins[i * 3]!, y = origins[i * 3 + 1]!, z = origins[i * 3 + 2]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r = 0;
    for (let i = b * PICK_BLOCK; i < end; i += 1) r = Math.max(r, Math.hypot(origins[i * 3]! - cx, origins[i * 3 + 1]! - cy, origins[i * 3 + 2]! - cz));
    out.set([cx, cy, cz, r], b * 4);
  }
  return out;
}

/** A 16-bit coordinate's bits spread to the even bits of 32 (Morton order). */
function spread(v: number): number {
  let x = v & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x >>> 0;
}

/**
 * A chunk's copies in Morton order across its two widest axes, so the blocks
 * of consecutive slots the draws cull and the levels pick by are compact.
 */
function spatialOrder(copies: Uint32Array, positions: Float32Array): void {
  if (copies.length <= PICK_BLOCK) return;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of copies) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const ext = [0, 1, 2].map((a) => Math.max(1e-6, max[a]! - min[a]!));
  const [a0, a1] = [0, 1, 2].sort((p, q) => ext[q]! - ext[p]!) as [number, number, number];
  // Code × 2²¹ + place in the list (copies per chunk stay far below 2²¹): one numeric sort, ties in list order.
  const keys = new Float64Array(copies.length);
  copies.forEach((i, j) => {
    const u = Math.min(65535, Math.floor(((positions[i * 3 + a0]! - min[a0]!) / ext[a0]!) * 65536));
    const v = Math.min(65535, Math.floor(((positions[i * 3 + a1]! - min[a1]!) / ext[a1]!) * 65536));
    keys[j] = ((spread(u) | (spread(v) << 1)) >>> 0) * 2097152 + j;
  });
  keys.sort();
  const before = copies.slice();
  keys.forEach((k, j) => {
    copies[j] = before[k % 2097152]!;
  });
}

export interface PreparedChunk {
  /** The set's copies in this chunk (their indices), in slot order. */
  readonly copies: Uint32Array;
  /** The chunk's centre (the mean of its copies' positions); the matrices are relative to it. */
  readonly center: Float64Array;
  /** Per mesh of the model, every copy's matrix (16 floats each, slot order). */
  readonly matrices: Float32Array[];
  /** Per mesh, the sphere around all its copies (centre xyz, radius; radius < 0: empty). */
  readonly bounds: Float64Array;
  /** With `perCopy`: each copy's origin from the centre (xyz), its largest scale and its thinning rank. */
  readonly origins: Float32Array | null;
  readonly scales: Float32Array | null;
  readonly ranks: Float32Array | null;
  readonly stats: PreparedPickStats | null;
}

export interface PreparedInstanceSet {
  readonly count: number;
  /** Each copy's chunk. */
  readonly chunkOf: Int32Array;
  readonly chunks: PreparedChunk[];
}

/**
 * The chunk grid for copy positions: cells along the two widest axes. Pure (unit-tested).
 * By count (about `target` copies per chunk, at most `maxChunks`) and,
 * with `chunkSize` (m), also by extent: no cell is wider than
 * `chunkSize` along either axis (at most {@link INSTANCE_MAX_SPATIAL_CHUNKS}
 * cells; past that the cells grow). The finer of the two grids wins per axis.
 */
export function chunkCopies(positions: Float32Array | readonly number[], count: number, target = INSTANCE_CHUNK_COPIES, maxChunks = INSTANCE_MAX_CHUNKS, chunkSize?: number): Int32Array {
  const out = new Int32Array(count);
  if (count === 0) return out;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const chunks = Math.max(1, Math.min(maxChunks, Math.ceil(count / target)));
  const ext = [0, 1, 2].map((a) => Math.max(1e-6, max[a]! - min[a]!));
  const axes = [0, 1, 2].sort((p, q) => ext[q]! - ext[p]!);
  const a0 = axes[0]!;
  const a1 = axes[1]!;
  let n0 = chunks === 1 ? 1 : Math.max(1, Math.min(chunks, Math.round(Math.sqrt((chunks * ext[a0]!) / ext[a1]!))));
  let n1 = chunks === 1 ? 1 : Math.max(1, Math.floor(chunks / n0));
  if (chunkSize !== undefined && Number.isFinite(chunkSize) && chunkSize > 0) {
    // No cell wider than chunkSize (the cells grow when the set would need more than the cap).
    let size = chunkSize;
    const cells = (s: number): [number, number] => [Math.max(1, Math.ceil(ext[a0]! / s - 1e-9)), Math.max(1, Math.ceil(ext[a1]! / s - 1e-9))];
    let [s0, s1] = cells(size);
    while (s0 * s1 > INSTANCE_MAX_SPATIAL_CHUNKS) {
      size *= Math.sqrt((s0 * s1) / INSTANCE_MAX_SPATIAL_CHUNKS) * 1.001;
      [s0, s1] = cells(size);
    }
    n0 = Math.max(n0, s0);
    n1 = Math.max(n1, s1);
    while (n0 * n1 > INSTANCE_MAX_SPATIAL_CHUNKS) {
      if (n0 >= n1) n0 -= 1;
      else n1 -= 1;
    }
  }
  if (n0 * n1 === 1) return out;
  for (let i = 0; i < count; i += 1) {
    const c0 = Math.min(n0 - 1, Math.floor(((positions[i * 3 + a0]! - min[a0]!) / ext[a0]!) * n0));
    const c1 = Math.min(n1 - 1, Math.floor(((positions[i * 3 + a1]! - min[a1]!) / ext[a1]!) * n1));
    out[i] = c0 * n1 + c1;
  }
  // Only the cells that hold copies become chunks: number them densely.
  const dense = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const c = out[i]!;
    let d = dense.get(c);
    if (d === undefined) {
      d = dense.size;
      dense.set(c, d);
    }
    out[i] = d;
  }
  return out;
}

/** A copy's place in the thinning order: a hash of its index, so neighbours thin evenly and the order never changes. */
export function copyRank(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The sphere around `n` instances of a geometry whose own sphere is
 * `source` (centre xyz, radius) at the matrices in `matrices` (16 floats
 * each), grown one instance at a time as three's `Sphere.union` grows it.
 * Written into `out` (centre xyz, radius; radius < 0: empty).
 */
export function instanceSphereBounds(matrices: ArrayLike<number>, n: number, source: ArrayLike<number>, out: Float64Array | number[], at = 0): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let r = -1;
  const sx = source[0]!;
  const sy = source[1]!;
  const sz = source[2]!;
  const sr = source[3]!;
  const expand = (px: number, py: number, pz: number): void => {
    if (r < 0) {
      cx = px;
      cy = py;
      cz = pz;
      r = 0;
      return;
    }
    const vx = px - cx;
    const vy = py - cy;
    const vz = pz - cz;
    const lengthSq = vx * vx + vy * vy + vz * vz;
    if (lengthSq > r * r) {
      const length = Math.sqrt(lengthSq);
      const delta = (length - r) * 0.5;
      cx += vx * (delta / length);
      cy += vy * (delta / length);
      cz += vz * (delta / length);
      r += delta;
    }
  };
  for (let i = 0; i < n; i += 1) {
    const o = i * 16;
    const e = matrices;
    // The source sphere at the instance's matrix (three's Sphere.applyMatrix4).
    const w = 1 / (e[o + 3]! * sx + e[o + 7]! * sy + e[o + 11]! * sz + e[o + 15]!);
    const px = (e[o]! * sx + e[o + 4]! * sy + e[o + 8]! * sz + e[o + 12]!) * w;
    const py = (e[o + 1]! * sx + e[o + 5]! * sy + e[o + 9]! * sz + e[o + 13]!) * w;
    const pz = (e[o + 2]! * sx + e[o + 6]! * sy + e[o + 10]! * sz + e[o + 14]!) * w;
    const scaleXSq = e[o]! * e[o]! + e[o + 1]! * e[o + 1]! + e[o + 2]! * e[o + 2]!;
    const scaleYSq = e[o + 4]! * e[o + 4]! + e[o + 5]! * e[o + 5]! + e[o + 6]! * e[o + 6]!;
    const scaleZSq = e[o + 8]! * e[o + 8]! + e[o + 9]! * e[o + 9]! + e[o + 10]! * e[o + 10]!;
    const pr = sr * Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));
    if (pr < 0) continue;
    if (r < 0) {
      cx = px;
      cy = py;
      cz = pz;
      r = pr;
      continue;
    }
    if (cx === px && cy === py && cz === pz) {
      r = Math.max(r, pr);
      continue;
    }
    // The two points of the instance's sphere along the line from the bounds' centre.
    let dx = px - cx;
    let dy = py - cy;
    let dz = pz - cz;
    // setLength: normalize (by the length, or 1), then scale.
    const inv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
    dx = dx * inv * pr;
    dy = dy * inv * pr;
    dz = dz * inv * pr;
    expand(px + dx, py + dy, pz + dz);
    expand(px - dx, py - dy, pz - dz);
  }
  out[at] = cx;
  out[at + 1] = cy;
  out[at + 2] = cz;
  out[at + 3] = r;
}

/** A copy's placement (`composeCopy`) times a mesh's offset `local` (at `localAt`) into `out` at `outAt`: three's multiplyMatrices. */
function writeCopyMatrix(place: Float64Array, local: ArrayLike<number>, localAt: number, out: Float32Array, outAt: number): void {
  const b = local;
  const l = localAt;
  const a11 = place[0]!, a12 = place[4]!, a13 = place[8]!, a14 = place[12]!;
  const a21 = place[1]!, a22 = place[5]!, a23 = place[9]!, a24 = place[13]!;
  const a31 = place[2]!, a32 = place[6]!, a33 = place[10]!, a34 = place[14]!;
  const a41 = place[3]!, a42 = place[7]!, a43 = place[11]!, a44 = place[15]!;
  const b11 = b[l]!, b12 = b[l + 4]!, b13 = b[l + 8]!, b14 = b[l + 12]!;
  const b21 = b[l + 1]!, b22 = b[l + 5]!, b23 = b[l + 9]!, b24 = b[l + 13]!;
  const b31 = b[l + 2]!, b32 = b[l + 6]!, b33 = b[l + 10]!, b34 = b[l + 14]!;
  const b41 = b[l + 3]!, b42 = b[l + 7]!, b43 = b[l + 11]!, b44 = b[l + 15]!;
  const o = outAt;
  out[o] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  out[o + 4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  out[o + 8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  out[o + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
  out[o + 1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  out[o + 5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  out[o + 9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  out[o + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
  out[o + 2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  out[o + 6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  out[o + 10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  out[o + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
  out[o + 3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  out[o + 7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  out[o + 11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  out[o + 15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

/**
 * A copy's placement relative to its chunk's centre (three's
 * `Matrix4.compose` of the translation less the centre, the normalized
 * quaternion and the scale) into `place`.
 */
export function composeCopy(t: ArrayLike<number>, offset: number, center: ArrayLike<number>, place: Float64Array): void {
  let x = t[offset + 3]!;
  let y = t[offset + 4]!;
  let z = t[offset + 5]!;
  let w = t[offset + 6]!;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len === 0) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else {
    const k = 1 / len;
    x *= k;
    y *= k;
    z *= k;
    w *= k;
  }
  const sx = t[offset + 7]!;
  const sy = t[offset + 8]!;
  const sz = t[offset + 9]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  place[0] = (1 - (yy + zz)) * sx;
  place[1] = (xy + wz) * sx;
  place[2] = (xz - wy) * sx;
  place[3] = 0;
  place[4] = (xy - wz) * sy;
  place[5] = (1 - (xx + zz)) * sy;
  place[6] = (yz + wx) * sy;
  place[7] = 0;
  place[8] = (xz + wy) * sz;
  place[9] = (yz - wx) * sz;
  place[10] = (1 - (xx + yy)) * sz;
  place[11] = 0;
  place[12] = t[offset]! - center[0]!;
  place[13] = t[offset + 1]! - center[1]!;
  place[14] = t[offset + 2]! - center[2]!;
  place[15] = 1;
}

/** Write copy `copy`'s matrix for every mesh into the chunk's matrix arrays at `slot`. */
export function writeCopyMatrices(floats: ArrayLike<number>, copy: number, center: ArrayLike<number>, parts: PrepareParts, matrices: readonly Float32Array[], slot: number, place = new Float64Array(16)): void {
  composeCopy(floats, copy * INSTANCE_FLOATS, center, place);
  for (let k = 0; k < matrices.length; k += 1) writeCopyMatrix(place, parts.locals, k * 16, matrices[k]!, slot * 16);
}

/** Make the arithmetic of a set of `count` copies of `floats` for a model of `parts` (see the module's header). */
export function prepareInstanceSet(floats: Float32Array, count: number, parts: PrepareParts, options: PrepareOptions): PreparedInstanceSet {
  const n = Math.max(0, Math.min(count, Math.floor(floats.length / INSTANCE_FLOATS)));
  const meshes = Math.floor(parts.locals.length / 16);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const o = i * INSTANCE_FLOATS;
    positions[i * 3] = floats[o]!;
    positions[i * 3 + 1] = floats[o + 1]!;
    positions[i * 3 + 2] = floats[o + 2]!;
  }
  const chunkOf = chunkCopies(positions, n, options.copiesPerChunk ?? INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, options.chunkSize);
  let chunkCount = 0;
  for (let i = 0; i < n; i += 1) if (chunkOf[i]! + 1 > chunkCount) chunkCount = chunkOf[i]! + 1;
  const sizes = new Int32Array(chunkCount);
  for (let i = 0; i < n; i += 1) sizes[chunkOf[i]!] = sizes[chunkOf[i]!]! + 1;
  const lists = Array.from(sizes, (k) => new Uint32Array(k));
  const filled = new Int32Array(chunkCount);
  for (let i = 0; i < n; i += 1) {
    const c = chunkOf[i]!;
    lists[c]![filled[c]!] = i;
    filled[c] = filled[c]! + 1;
  }
  const place = new Float64Array(16);
  const chunks: PreparedChunk[] = [];
  for (const copies of lists) {
    spatialOrder(copies, positions);
    const k = copies.length;
    // The mean position (three's Vector3 add, then divideScalar: a multiply by the inverse).
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let j = 0; j < k; j += 1) {
      const i = copies[j]!;
      sx += positions[i * 3]!;
      sy += positions[i * 3 + 1]!;
      sz += positions[i * 3 + 2]!;
    }
    const inv = k > 0 ? 1 / k : 0;
    const center = Float64Array.of(sx * inv, sy * inv, sz * inv);
    const matrices = Array.from({ length: meshes }, () => new Float32Array(k * 16));
    for (let j = 0; j < k; j += 1) writeCopyMatrices(floats, copies[j]!, center, parts, matrices, j, place);
    const bounds = new Float64Array(meshes * 4);
    for (let m = 0; m < meshes; m += 1) instanceSphereBounds(matrices[m]!, k, parts.spheres.subarray(m * 4, m * 4 + 4), bounds, m * 4);
    let origins: Float32Array | null = null;
    let scales: Float32Array | null = null;
    let ranks: Float32Array | null = null;
    let stats: PreparedPickStats | null = null;
    if (options.perCopy) {
      origins = new Float32Array(k * 3);
      scales = new Float32Array(k);
      ranks = new Float32Array(k);
      let reach = 0;
      let lo = Number.POSITIVE_INFINITY;
      let hi = 0;
      let sum = 0;
      for (let j = 0; j < k; j += 1) {
        const copy = copies[j]!;
        const o = copy * INSTANCE_FLOATS;
        origins[j * 3] = floats[o]! - center[0]!;
        origins[j * 3 + 1] = floats[o + 1]! - center[1]!;
        origins[j * 3 + 2] = floats[o + 2]! - center[2]!;
        const s = Math.max(Math.abs(floats[o + 7]!), Math.abs(floats[o + 8]!), Math.abs(floats[o + 9]!));
        scales[j] = s;
        ranks[j] = copyRank(copy);
        // What the picker reads back: the origins and sizes as stored (float32).
        reach = Math.max(reach, Math.hypot(origins[j * 3]!, origins[j * 3 + 1]!, origins[j * 3 + 2]!));
        lo = Math.min(lo, scales[j]!);
        hi = Math.max(hi, scales[j]!);
        sum += scales[j]!;
      }
      stats = { reach, minScale: Number.isFinite(lo) ? lo : 1, maxScale: hi, meanScale: k > 0 ? sum / k : 1, blocks: pickBlocks(origins, k) };
    }
    chunks.push({ copies, center, matrices, bounds, origins, scales, ranks, stats });
  }
  return { count: n, chunkOf, chunks };
}

/** The buffers of a prepared set (handed over from a worker, not copied). */
export function preparedBuffers(p: PreparedInstanceSet): ArrayBuffer[] {
  const out: ArrayBuffer[] = [p.chunkOf.buffer as ArrayBuffer];
  for (const c of p.chunks) {
    out.push(c.copies.buffer as ArrayBuffer, c.center.buffer as ArrayBuffer, c.bounds.buffer as ArrayBuffer);
    for (const m of c.matrices) out.push(m.buffer as ArrayBuffer);
    for (const a of [c.origins, c.scales, c.ranks, c.stats?.blocks ?? null]) if (a !== null) out.push(a.buffer as ArrayBuffer);
  }
  return out;
}
