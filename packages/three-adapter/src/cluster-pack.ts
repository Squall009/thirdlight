/**
 * The packed light lists: ONE data texture every renderer reads with
 * `texelFetch` / `textureLoad` only (no filtering, no sampler), written from
 * a `ClusterBuild` (`cluster-build.ts`) each frame. One texture, not one for
 * the records and one for the lists, because a WebGPU fragment stage may
 * bind only 16 textures on the low tier's GPUs: the lists cost one of them.
 *
 * RGBA32UI, {@link CLUSTER_TEXTURE_WIDTH} texels wide; its words (4 a texel,
 * x y z w) hold, in order:
 * - **Light records**, {@link CLUSTER_LIGHT_TEXELS} texels a light, floats
 *   stored as their bits (the shader bit-casts them back), in the lists'
 *   order (best rank first; a list's index is the light's record):
 *   - t0: view position xyz, reach;
 *   - t1: linear colour × intensity rgb, kind field +
 *     {@link CLUSTER_KIND_STEP} × round(decay × {@link CLUSTER_DECAY_STEPS})
 *     (kind: the two low bits, {@link CLUSTER_TWO_SIDED} or
 *     {@link CLUSTER_UNBOUNDED} above them, then {@link CLUSTER_UNCACHED});
 *   - t2: a spot's view axis or an area light's half width `u` (view) xyz,
 *     the layer word: the light-layer mask in the low
 *     {@link CLUSTER_ROOM_SHIFT} bits and the room key it lights alone + 1
 *     above them (0: every room), as a float (exact below 2^24);
 *   - t3: a spot's cos outer, cos inner, cookie tile, or an area light's half
 *     height `v` (view; `u × v` along its facing) xyz; the shadow record's
 *     first texel (-1: none).
 *   Positions and axes are written in view space: the CPU rewrites the
 *   records every frame anyway, and the shader saves a matrix a light.
 * - **Shadow records** (`ClusterShadows`), right after the light records
 *   (a light record names its record's first texel):
 *   - a spot's, {@link CLUSTER_SHADOW_TEXELS} texels: t0–t3 the rows of the
 *     matrix from view space to the atlas (x, y: the atlas's texture
 *     coordinates, from the top left, inside the light's tile; z: the depth
 *     its tile stores; all over w), t4 the tile (left, top, side: shares of
 *     the atlas) and the shadow's strength (0 for a cookie's projection
 *     alone), t5 the shadow camera's near and far (a logarithmic depth
 *     buffer's depth), the depth bias and the normal offset per metre of
 *     distance from the light;
 *   - a light seen through faces (a point or area light,
 *     `shadow-cube.ts`), {@link CLUSTER_CUBE_SHADOW_TEXELS} texels: t0–t2
 *     the rows of the matrix from view space to the light's frame, t3 near,
 *     far, depth bias, normal offset per metre, t4 the stored depth's terms
 *     (`a + b / d` at depth `d` along a face's axis), the strength and a
 *     face tile's side (a share of the atlas), t5–t7 the six faces' tiles'
 *     left and top, two a texel (left −1: no tile, unshadowed there).
 * - **Cell headers**, from the word right after the shadow records
 *   ({@link ClusterTextures.listWord}): one word per cell (cell index = tile
 *   x + tiles x × (tile y + tiles y × slice)), then the index lists, one
 *   light index a word. A header is the list's offset past the headers
 *   (22 bits) and its count (10 bits); a count of {@link CLUSTER_LONG_LIST}
 *   says the list is long and its first word holds the real count (the list
 *   follows it). No cell has a cap.
 * - **Memory budget, not a count.** The texture grows by doubling rows on
 *   demand and never shrinks until `reset` (a scene change). The headers and
 *   lists' ceiling is {@link CLUSTER_INDEX_MIB}; the build leaves the
 *   lowest-ranked lights out of the cells past it (`ClusterBuild.overflow`).
 *
 * `decodeCluster*` are the shader's decode as plain code (the vitest suite
 * round-trips the texture through them; the light loop follows them line
 * for line).
 */
import { LIGHT_LAYER_COUNT } from '@thirdlight/runtime';

import { CLUSTER_COUNT_BITS, CLUSTER_LONG_LIST, CLUSTER_SPOT, CLUSTER_TWO_SIDED, CLUSTER_UNBOUNDED, CLUSTER_UNCACHED, clusterIndex, clusterSliceOf, type ClusterBuild, type ClusterGrid, type ClusterLights } from './cluster-build';

/** The layer word's room key starts above the light-layer bits. */
export const CLUSTER_ROOM_SHIFT = LIGHT_LAYER_COUNT;

/** Texels a row. */
export const CLUSTER_TEXTURE_WIDTH = 1024;
/** 32-bit words a texel (RGBA32UI). */
export const CLUSTER_TEXEL_WORDS = 4;
/** Texels a light record. */
export const CLUSTER_LIGHT_TEXELS = 4;
/** Texels a spot's shadow record. */
export const CLUSTER_SHADOW_TEXELS = 6;
/** Texels the shadow record of a light seen through faces (a point or area light). */
export const CLUSTER_CUBE_SHADOW_TEXELS = 8;
/** The headers and lists' ceiling (MiB of 32-bit words). */
export const CLUSTER_INDEX_MIB = 16;
/** Words the headers and lists may use: the ceiling in 4-byte words (2^22, which the header's 22-bit offset spans). */
export const CLUSTER_INDEX_WORDS = (CLUSTER_INDEX_MIB * 1024 * 1024) / 4;
export { CLUSTER_COUNT_BITS, CLUSTER_LONG_LIST };
const COUNT_BITS = CLUSTER_COUNT_BITS;
const COUNT_MASK = CLUSTER_LONG_LIST;
/** Decay is stored in 1/256 steps above the kind field's four bits. */
export const CLUSTER_DECAY_STEPS = 256;
export const CLUSTER_KIND_STEP = 16;
const DECAY_STEPS = CLUSTER_DECAY_STEPS;
const KIND_BITS = CLUSTER_KIND_STEP;
const RECORD_WORDS = CLUSTER_LIGHT_TEXELS * CLUSTER_TEXEL_WORDS;

/** What `pack` wrote this frame. */
export interface ClusterPackResult {
  /** Rows of the texture (a change: the whole texture is uploaded). */
  rows: number;
  grew: boolean;
  /** Texels written, records and lists (the upload range when the texture did not grow). */
  texels: number;
  /** The first header's word (the records end there). */
  listWord: number;
  /** Words of headers and lists. */
  listWords: number;
  /** Bytes this frame's upload sends: a grown texture whole, otherwise the written range. */
  uploadBytes: number;
}

/** One shadow record as the caller hands it in (world space; the pack turns the matrix into the view's). */
export interface ClusterShadowValue {
  /** World → atlas (column-major, three's `Matrix4.elements`): x, y the atlas's texture coordinates inside the tile, z the stored depth, over w. */
  readonly matrix: ArrayLike<number>;
  /** The tile: left, top and side as shares of the atlas. */
  readonly rect: readonly [number, number, number];
  readonly intensity: number;
  readonly near: number;
  readonly far: number;
  readonly bias: number;
  /** Metres the receiving point moves along its normal per metre from the light. */
  readonly normalBias: number;
}

/** The shadow record of a light seen through faces (world space; the pack turns the matrix into the view's). */
export interface ClusterCubeShadowValue {
  /** World → the light's frame (column-major; its first three rows are used). */
  readonly matrix: ArrayLike<number>;
  readonly near: number;
  readonly far: number;
  readonly bias: number;
  readonly normalBias: number;
  /** The stored depth at `d` along a face's axis: `depth[0] + depth[1] / d`. */
  readonly depth: readonly [number, number];
  readonly intensity: number;
  /** A face tile's side (a share of the atlas). */
  readonly size: number;
  /** Each face's tile's left and top (shares of the atlas; null: no tile). */
  readonly faces: readonly (readonly [number, number] | null)[];
}

/** The frame's shadow records; a light's `shadow` in `ClusterLights` is its record's first texel here. */
export class ClusterShadows {
  /** Texels written. */
  texels = 0;
  data = new Float32Array(CLUSTER_SHADOW_TEXELS * 16);
  /** Each record's first texel and its matrix's rows (4: a spot's, 3: a light seen through faces). */
  private starts: number[] = [];
  private rows: number[] = [];

  get count(): number {
    return this.starts.length;
  }

  clear(): void {
    this.texels = 0;
    this.starts.length = 0;
    this.rows.length = 0;
  }

  /** Append a spot's record; its first texel. */
  add(v: ClusterShadowValue): number {
    const o = this.open(CLUSTER_SHADOW_TEXELS, 4);
    this.rowsOf(v.matrix, o, 4);
    this.data.set([v.rect[0], v.rect[1], v.rect[2], v.intensity, v.near, v.far, v.bias, v.normalBias], o + 16);
    return o / 4;
  }

  /** Append the record of a light seen through faces; its first texel. */
  addCube(v: ClusterCubeShadowValue): number {
    const o = this.open(CLUSTER_CUBE_SHADOW_TEXELS, 3);
    this.rowsOf(v.matrix, o, 3);
    this.data.set([v.near, v.far, v.bias, v.normalBias, v.depth[0], v.depth[1], v.intensity, v.size], o + 12);
    for (let f = 0; f < 6; f += 1) {
      const c = v.faces[f] ?? null;
      this.data[o + 20 + 2 * f] = c === null ? -1 : c[0];
      this.data[o + 21 + 2 * f] = c === null ? -1 : c[1];
    }
    return o / 4;
  }

  /** Each record's first texel and matrix rows, for the pack. */
  forEach(fn: (texel: number, rows: number) => void): void {
    for (let i = 0; i < this.starts.length; i += 1) fn(this.starts[i]!, this.rows[i]!);
  }

  /** Room for a record of `texels` (its first float). */
  private open(texels: number, rows: number): number {
    const o = this.texels * 4;
    if (o + texels * 4 > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, o + texels * 4));
      next.set(this.data);
      this.data = next;
    }
    this.starts.push(this.texels);
    this.rows.push(rows);
    this.texels += texels;
    return o;
  }

  /** The first `rows` rows of the column-major matrix `m` at float `o`. */
  private rowsOf(m: ArrayLike<number>, o: number, rows: number): void {
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < 4; c += 1) this.data[o + r * 4 + c] = m[c * 4 + r]!;
  }
}

const NO_SHADOWS = new ClusterShadows();

/** The texture's data, kept between frames: its words, and the same memory as floats (the records). */
export class ClusterTextures {
  data = new Uint32Array(CLUSTER_TEXTURE_WIDTH * CLUSTER_TEXEL_WORDS);
  floats = new Float32Array(this.data.buffer);
  rows = 1;
  /** The first header's word (past the records) as the last pack wrote it. */
  listWord = 0;

  /** Drop the grown texture (a new scene). */
  reset(): void {
    this.data = new Uint32Array(CLUSTER_TEXTURE_WIDTH * CLUSTER_TEXEL_WORDS);
    this.floats = new Float32Array(this.data.buffer);
    this.rows = 1;
    this.listWord = 0;
  }

  /** Write `build`'s records, `shadows`' records (the first texels `lights.shadow` names), headers and lists. */
  pack(build: ClusterBuild, lights: ClusterLights, shadows: ClusterShadows = NO_SHADOWS): ClusterPackResult {
    const clusters = build.grid.clusters;
    const counts = build.counts;
    // A long list's count word comes before its list.
    const listWords = clusters + build.entries + build.longLists;
    if (listWords > CLUSTER_INDEX_WORDS) throw new Error(`cluster lists: ${listWords} words past the ${CLUSTER_INDEX_MIB} MiB ceiling (the build's budget was not the pack's)`);
    const shadowTexel = build.packed * CLUSTER_LIGHT_TEXELS;
    const base = build.packed * RECORD_WORDS + shadows.texels * CLUSTER_TEXEL_WORDS;
    const texels = Math.ceil((base + listWords) / CLUSTER_TEXEL_WORDS);
    const grew = this.grow(texels);
    this.listWord = base;
    this.writeRecords(build, lights, shadowTexel);
    this.writeShadows(build.view, shadows, build.packed * RECORD_WORDS);
    const data = this.data;
    // Headers (each cell's offset and count) and where each list's next index goes, in one pass.
    const cursor = this.cursorFor(clusters);
    const lists = base + clusters;
    let at = 0;
    for (let c = 0; c < clusters; c += 1) {
      const n = counts[c]!;
      if (n >= CLUSTER_LONG_LIST) {
        data[base + c] = ((at << COUNT_BITS) | CLUSTER_LONG_LIST) >>> 0;
        data[lists + at] = n;
        at += 1;
      } else {
        data[base + c] = ((at << COUNT_BITS) | n) >>> 0;
      }
      cursor[c] = lists + at;
      at += n;
    }
    // Write pass: entries in slot order, so each list is best rank first.
    let e = 0;
    for (let s = 0; s < build.packed; s += 1) {
      const end = build.entryEnd[s]!;
      for (; e < end; e += 1) {
        const c = build.entryCluster[e]!;
        data[cursor[c]!] = s;
        cursor[c] = cursor[c]! + 1;
      }
    }
    const uploadBytes = grew ? data.byteLength : texels * CLUSTER_TEXEL_WORDS * 4;
    return { rows: this.rows, grew, texels, listWord: base, listWords, uploadBytes };
  }

  private cursor = new Uint32Array(0);

  private cursorFor(n: number): Uint32Array {
    if (this.cursor.length < n) this.cursor = new Uint32Array(n);
    return this.cursor;
  }

  /** The shadow records at word `at`: each matrix taken from world to `V`'s view space (times the view's inverse). */
  private writeShadows(V: ArrayLike<number>, shadows: ClusterShadows, at: number): void {
    if (shadows.texels === 0) return;
    // The camera's world matrix: V is rigid (rotation and translation), so its inverse is its transpose and −Rᵀt.
    const W = this.inverse;
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) W[c * 4 + r] = V[r * 4 + c]!;
      W[r * 4 + 3] = 0;
    }
    for (let r = 0; r < 3; r += 1) W[12 + r] = -(W[r]! * V[12]! + W[4 + r]! * V[13]! + W[8 + r]! * V[14]!);
    W[15] = 1;
    const src = shadows.data;
    const out = this.floats;
    // Everything as written, then each record's matrix rows taken to view space.
    out.set(src.subarray(0, shadows.texels * CLUSTER_TEXEL_WORDS), at);
    shadows.forEach((texel, rows) => {
      const o = texel * CLUSTER_TEXEL_WORDS;
      const d = at + o;
      // Row r of (M × W): the row of M times W's columns.
      for (let r = 0; r < rows; r += 1) {
        const m0 = src[o + r * 4]!;
        const m1 = src[o + r * 4 + 1]!;
        const m2 = src[o + r * 4 + 2]!;
        const m3 = src[o + r * 4 + 3]!;
        for (let c = 0; c < 4; c += 1) out[d + r * 4 + c] = m0 * W[c * 4]! + m1 * W[c * 4 + 1]! + m2 * W[c * 4 + 2]! + m3 * W[c * 4 + 3]!;
      }
    });
  }

  private readonly inverse = new Float64Array(16);

  private writeRecords(build: ClusterBuild, lights: ClusterLights, shadowTexel: number): void {
    const V = build.view;
    const out = this.floats;
    for (let s = 0; s < build.packed; s += 1) {
      const i = build.order[s]!;
      const o = s * RECORD_WORDS;
      const wx = lights.position[i * 3]!;
      const wy = lights.position[i * 3 + 1]!;
      const wz = lights.position[i * 3 + 2]!;
      out[o] = V[0]! * wx + V[4]! * wy + V[8]! * wz + V[12]!;
      out[o + 1] = V[1]! * wx + V[5]! * wy + V[9]! * wz + V[13]!;
      out[o + 2] = V[2]! * wx + V[6]! * wy + V[10]! * wz + V[14]!;
      out[o + 3] = lights.reach[i]!;
      out[o + 4] = lights.color[i * 3]!;
      out[o + 5] = lights.color[i * 3 + 1]!;
      out[o + 6] = lights.color[i * 3 + 2]!;
      const kind = lights.kind[i]!;
      out[o + 7] = kind + KIND_BITS * Math.max(0, Math.round(lights.decay[i]! * DECAY_STEPS));
      const spot = (kind & 3) === CLUSTER_SPOT;
      rotateInto(V, spot ? lights.direction : lights.u, i, out, o + 8);
      out[o + 11] = lights.mask[i]! + (lights.room[i]! + 1) * (1 << CLUSTER_ROOM_SHIFT);
      if (spot) {
        out[o + 12] = lights.cone[i * 2]!;
        out[o + 13] = lights.cone[i * 2 + 1]!;
        out[o + 14] = lights.cookie[i]!;
      } else {
        rotateInto(V, lights.v, i, out, o + 12);
      }
      const shadow = lights.shadow[i]!;
      out[o + 15] = shadow < 0 ? -1 : shadowTexel + shadow;
    }
  }

  private grow(texels: number): boolean {
    const rows = grownRows(this.rows, texels);
    if (rows === this.rows) return false;
    const next = new Uint32Array(rows * CLUSTER_TEXTURE_WIDTH * CLUSTER_TEXEL_WORDS);
    next.set(this.data);
    this.data = next;
    this.floats = new Float32Array(next.buffer);
    this.rows = rows;
    return true;
  }
}

/** Rows doubled from `rows` until `texels` fit. */
function grownRows(rows: number, texels: number): number {
  let r = rows;
  while (r * CLUSTER_TEXTURE_WIDTH < texels) r *= 2;
  return r;
}

function rotateInto(V: ArrayLike<number>, src: Float32Array, i: number, out: Float32Array, at: number): void {
  const sx = src[i * 3]!;
  const sy = src[i * 3 + 1]!;
  const sz = src[i * 3 + 2]!;
  out[at] = V[0]! * sx + V[4]! * sy + V[8]! * sz;
  out[at + 1] = V[1]! * sx + V[5]! * sy + V[9]! * sz;
  out[at + 2] = V[2]! * sx + V[6]! * sy + V[10]! * sz;
}

/**
 * The cell a pixel reads: its place on the screen as a share of the render
 * size (0–1, y up) and its view depth; -1 past the last slice.
 */
export function decodeClusterCell(grid: ClusterGrid, screenX: number, screenY: number, depth: number): number {
  const slice = clusterSliceOf(grid, depth);
  if (slice < 0) return -1;
  const tx = Math.min(grid.tilesX - 1, Math.max(0, Math.floor(screenX * grid.tilesX)));
  const ty = Math.min(grid.tilesY - 1, Math.max(0, Math.floor(screenY * grid.tilesY)));
  return clusterIndex(grid, tx, ty, slice);
}

/** A cell's list of light records, read from the texture's words as the shader does (`listWord`: the first header's word). */
export function decodeClusterList(data: Uint32Array, listWord: number, clusters: number, cell: number): number[] {
  const h = data[listWord + cell]!;
  let at = listWord + clusters + (h >>> COUNT_BITS);
  let n = h & COUNT_MASK;
  if (n === CLUSTER_LONG_LIST) {
    n = data[at]!;
    at += 1;
  }
  const out: number[] = [];
  for (let k = 0; k < n; k += 1) out.push(data[at + k]!);
  return out;
}

/** A light record read back from the texture's words (bit-cast to floats) as the shader does. */
export interface DecodedClusterLight {
  position: [number, number, number];
  reach: number;
  color: [number, number, number];
  kind: number;
  twoSided: boolean;
  decay: number;
  /** Point or spot: no range (no window toward the reach). */
  unbounded: boolean;
  /** The surface cache does not hold its light. */
  uncached: boolean;
  mask: number;
  /** The room it lights alone (-1: every room). */
  room: number;
  shadow: number;
  /** Spot: axis, cos outer, cos inner, cookie. */
  axis?: [number, number, number];
  cosOuter?: number;
  cosInner?: number;
  cookie?: number;
  /** Area: half sides. */
  u?: [number, number, number];
  v?: [number, number, number];
}

/** A spot's shadow record read back as the shader does (`texel`: its first texel, the light record's `shadow`). */
export function decodeClusterShadow(data: Uint32Array, texel: number): { rows: number[][]; rect: [number, number, number]; intensity: number; near: number; far: number; bias: number; normalBias: number } {
  const floats = new Float32Array(data.buffer, data.byteOffset, data.length);
  const o = texel * CLUSTER_TEXEL_WORDS;
  const t = (k: number): number => floats[o + k]!;
  return { rows: [0, 1, 2, 3].map((r) => [t(r * 4), t(r * 4 + 1), t(r * 4 + 2), t(r * 4 + 3)]), rect: [t(16), t(17), t(18)], intensity: t(19), near: t(20), far: t(21), bias: t(22), normalBias: t(23) };
}

export function decodeClusterLight(data: Uint32Array, index: number): DecodedClusterLight {
  const floats = new Float32Array(data.buffer, data.byteOffset, data.length);
  const o = index * RECORD_WORDS;
  const t = (k: number): number => floats[o + k]!;
  const field = Math.trunc(t(7));
  const kind = field & 3;
  const base: DecodedClusterLight = {
    position: [t(0), t(1), t(2)],
    reach: t(3),
    color: [t(4), t(5), t(6)],
    kind,
    twoSided: kind >= 2 && (field & CLUSTER_TWO_SIDED) !== 0,
    unbounded: kind < 2 && (field & CLUSTER_UNBOUNDED) !== 0,
    uncached: (field & CLUSTER_UNCACHED) !== 0,
    decay: Math.floor(field / KIND_BITS) / DECAY_STEPS,
    mask: Math.trunc(t(11)) % (1 << CLUSTER_ROOM_SHIFT),
    room: Math.floor(Math.trunc(t(11)) / (1 << CLUSTER_ROOM_SHIFT)) - 1,
    shadow: Math.trunc(t(15)),
  };
  if (kind === CLUSTER_SPOT) return { ...base, axis: [t(8), t(9), t(10)], cosOuter: t(12), cosInner: t(13), cookie: Math.trunc(t(14)) };
  if (kind >= 2) return { ...base, u: [t(8), t(9), t(10)], v: [t(12), t(13), t(14)] };
  return base;
}

/** The shadow record of a light seen through faces, read back as the shader does. */
export function decodeClusterCubeShadow(data: Uint32Array, texel: number): { rows: number[][]; near: number; far: number; bias: number; normalBias: number; depth: [number, number]; intensity: number; size: number; faces: ([number, number] | null)[] } {
  const floats = new Float32Array(data.buffer, data.byteOffset, data.length);
  const o = texel * CLUSTER_TEXEL_WORDS;
  const t = (k: number): number => floats[o + k]!;
  const faces = [0, 1, 2, 3, 4, 5].map((f): [number, number] | null => (t(20 + 2 * f) < 0 ? null : [t(20 + 2 * f), t(21 + 2 * f)]));
  return { rows: [0, 1, 2].map((r) => [t(r * 4), t(r * 4 + 1), t(r * 4 + 2), t(r * 4 + 3)]), near: t(12), far: t(13), bias: t(14), normalBias: t(15), depth: [t(16), t(17)], intensity: t(18), size: t(19), faces };
}
