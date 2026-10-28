/**
 * The packed light lists: two data textures every renderer reads with
 * `texelFetch` only (no filtering, no samplers per light), written from a
 * `ClusterBuild` (`cluster-build.ts`) each frame.
 *
 * - **Light texture**, RGBA32F, {@link CLUSTER_TEXTURE_WIDTH} texels wide,
 *   {@link CLUSTER_LIGHT_TEXELS} texels a light, in the lists' order (best
 *   rank first; a list's index is the light's record):
 *   - t0: view position xyz, reach;
 *   - t1: linear colour × intensity rgb, kind field + 8 × round(decay × 256)
 *     (kind: the two low bits, {@link CLUSTER_TWO_SIDED} above them);
 *   - t2: a spot's view axis or an area light's half width `u` (view) xyz,
 *     light-layer mask (bits as a float, exact below 2^24);
 *   - t3: a spot's cos outer, cos inner, cookie tile, or an area light's half
 *     height `v` (view; `u × v` along its facing) xyz; the shadow record's
 *     first texel (-1: none).
 *   Positions and axes are written in view space: the CPU rewrites the
 *   records every frame anyway, and the shader saves a matrix a light.
 * - **Cluster texture**, R32UI, as wide: one header texel per cell first
 *   (cell index = tile x + tiles x × (tile y + tiles y × slice)), then the
 *   index lists, one light index a texel. A header is the list's offset
 *   past the headers (22 bits) and its count (10 bits); a count of
 *   {@link CLUSTER_LONG_LIST} says the list is long and its first texel holds
 *   the real count (the list follows it). No cell has a cap.
 * - **Memory budget, not a count.** Both textures grow by doubling rows on
 *   demand and never shrink until `reset` (a scene change). The lists'
 *   ceiling is {@link CLUSTER_INDEX_MIB}; the build leaves the lowest-ranked
 *   lights out of the cells past it (`ClusterBuild.overflow`).
 *
 * `decodeCluster*` are the shader's decode as plain code (the vitest suite
 * round-trips the textures through them; the light loop follows them line
 * for line).
 */
import { CLUSTER_SPOT, clusterIndex, clusterSliceOf, type ClusterBuild, type ClusterGrid, type ClusterLights } from './cluster-build';

/** Texels a row, both textures. */
export const CLUSTER_TEXTURE_WIDTH = 1024;
/** RGBA32F texels a light record. */
export const CLUSTER_LIGHT_TEXELS = 4;
/** The index lists' ceiling (MiB of the R32UI cluster texture). */
export const CLUSTER_INDEX_MIB = 16;
/** Texels the headers and lists may use: the ceiling in 4-byte texels (2^22, which the header's 22-bit offset spans). */
export const CLUSTER_INDEX_TEXELS = (CLUSTER_INDEX_MIB * 1024 * 1024) / 4;
/** A header's count bits, and the count that marks a long list (its real count in the list's first texel). */
export const CLUSTER_COUNT_BITS = 10;
const COUNT_BITS = CLUSTER_COUNT_BITS;
export const CLUSTER_LONG_LIST = (1 << COUNT_BITS) - 1;
const COUNT_MASK = CLUSTER_LONG_LIST;
/** Decay is stored in 1/256 steps above the kind field's three bits. */
const DECAY_STEPS = 256;
const KIND_BITS = 8;

/** What `pack` wrote this frame. */
export interface ClusterPackResult {
  /** Rows of each texture (a change: the whole texture is uploaded). */
  lightRows: number;
  clusterRows: number;
  lightGrew: boolean;
  clusterGrew: boolean;
  /** Texels written (the upload range when the texture did not grow). */
  lightTexels: number;
  clusterTexels: number;
  /** Bytes this frame's upload sends: a grown texture whole, otherwise the written ranges. */
  uploadBytes: number;
}

/** The two textures' data, kept between frames. */
export class ClusterTextures {
  lightData = new Float32Array(CLUSTER_TEXTURE_WIDTH * 4);
  clusterData = new Uint32Array(CLUSTER_TEXTURE_WIDTH);
  lightRows = 1;
  clusterRows = 1;

  /** Drop the grown textures (a new scene). */
  reset(): void {
    this.lightData = new Float32Array(CLUSTER_TEXTURE_WIDTH * 4);
    this.clusterData = new Uint32Array(CLUSTER_TEXTURE_WIDTH);
    this.lightRows = 1;
    this.clusterRows = 1;
  }

  /** Write `build`'s records, headers and lists. */
  pack(build: ClusterBuild, lights: ClusterLights): ClusterPackResult {
    const lightTexels = build.packed * CLUSTER_LIGHT_TEXELS;
    const lightGrew = this.growLights(lightTexels);
    this.writeRecords(build, lights);
    const clusters = build.grid.clusters;
    const counts = build.counts;
    // Prefix sum: offsets past the headers, a long list's count texel first.
    let listTexels = 0;
    for (let c = 0; c < clusters; c += 1) listTexels += counts[c]! + (counts[c]! >= CLUSTER_LONG_LIST ? 1 : 0);
    const clusterTexels = clusters + listTexels;
    if (clusterTexels > CLUSTER_INDEX_TEXELS) throw new Error(`cluster lists: ${clusterTexels} texels past the ${CLUSTER_INDEX_MIB} MiB ceiling (the build's budget was not the pack's)`);
    const clusterGrew = this.growClusters(clusterTexels);
    const data = this.clusterData;
    // Headers: each cell's offset and count (a long list's count in its first texel).
    let at = 0;
    for (let c = 0; c < clusters; c += 1) {
      const n = counts[c]!;
      if (n >= CLUSTER_LONG_LIST) {
        data[c] = ((at << COUNT_BITS) | CLUSTER_LONG_LIST) >>> 0;
        data[clusters + at] = n;
        at += 1;
      } else {
        data[c] = ((at << COUNT_BITS) | n) >>> 0;
      }
      at += n;
    }
    // Write pass: entries in slot order, so each list is best rank first.
    const cursor = this.cursorFor(clusters);
    for (let c = 0; c < clusters; c += 1) cursor[c] = (data[c]! >>> COUNT_BITS) + ((data[c]! & COUNT_MASK) === CLUSTER_LONG_LIST ? 1 : 0);
    let e = 0;
    for (let s = 0; s < build.packed; s += 1) {
      const end = build.entryEnd[s]!;
      for (; e < end; e += 1) {
        const c = build.entryCluster[e]!;
        data[clusters + cursor[c]!] = s;
        cursor[c] = cursor[c]! + 1;
      }
    }
    const uploadBytes = (lightGrew ? this.lightData.byteLength : lightTexels * 16) + (clusterGrew ? this.clusterData.byteLength : clusterTexels * 4);
    return { lightRows: this.lightRows, clusterRows: this.clusterRows, lightGrew, clusterGrew, lightTexels, clusterTexels, uploadBytes };
  }

  private cursor = new Uint32Array(0);

  private cursorFor(n: number): Uint32Array {
    if (this.cursor.length < n) this.cursor = new Uint32Array(n);
    return this.cursor;
  }

  private writeRecords(build: ClusterBuild, lights: ClusterLights): void {
    const V = build.view;
    const out = this.lightData;
    for (let s = 0; s < build.packed; s += 1) {
      const i = build.order[s]!;
      const o = s * CLUSTER_LIGHT_TEXELS * 4;
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
      out[o + 11] = lights.mask[i]!;
      if (spot) {
        out[o + 12] = lights.cone[i * 2]!;
        out[o + 13] = lights.cone[i * 2 + 1]!;
        out[o + 14] = lights.cookie[i]!;
      } else {
        rotateInto(V, lights.v, i, out, o + 12);
      }
      out[o + 15] = lights.shadow[i]!;
    }
  }

  private growLights(texels: number): boolean {
    const rows = grownRows(this.lightRows, texels);
    if (rows === this.lightRows) return false;
    const next = new Float32Array(rows * CLUSTER_TEXTURE_WIDTH * 4);
    next.set(this.lightData);
    this.lightData = next;
    this.lightRows = rows;
    return true;
  }

  private growClusters(texels: number): boolean {
    const rows = grownRows(this.clusterRows, texels);
    if (rows === this.clusterRows) return false;
    const next = new Uint32Array(rows * CLUSTER_TEXTURE_WIDTH);
    next.set(this.clusterData);
    this.clusterData = next;
    this.clusterRows = rows;
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

/** A cell's list of light records, read from the cluster texture's data as the shader does. */
export function decodeClusterList(clusterData: Uint32Array, clusters: number, cell: number): number[] {
  const h = clusterData[cell]!;
  let at = clusters + (h >>> COUNT_BITS);
  let n = h & COUNT_MASK;
  if (n === CLUSTER_LONG_LIST) {
    n = clusterData[at]!;
    at += 1;
  }
  const out: number[] = [];
  for (let k = 0; k < n; k += 1) out.push(clusterData[at + k]!);
  return out;
}

/** A light record read back from the light texture's data as the shader does. */
export interface DecodedClusterLight {
  position: [number, number, number];
  reach: number;
  color: [number, number, number];
  kind: number;
  twoSided: boolean;
  decay: number;
  mask: number;
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

export function decodeClusterLight(lightData: Float32Array, index: number): DecodedClusterLight {
  const o = index * CLUSTER_LIGHT_TEXELS * 4;
  const t = (k: number): number => lightData[o + k]!;
  const field = Math.trunc(t(7));
  const kind = field & 3;
  const base: DecodedClusterLight = {
    position: [t(0), t(1), t(2)],
    reach: t(3),
    color: [t(4), t(5), t(6)],
    kind,
    twoSided: (field & 4) !== 0,
    decay: Math.floor(field / KIND_BITS) / DECAY_STEPS,
    mask: Math.trunc(t(11)),
    shadow: Math.trunc(t(15)),
  };
  if (kind === CLUSTER_SPOT) return { ...base, axis: [t(8), t(9), t(10)], cosOuter: t(12), cosInner: t(13), cookie: Math.trunc(t(14)) };
  if (kind >= 2) return { ...base, u: [t(8), t(9), t(10)], v: [t(12), t(13), t(14)] };
  return base;
}
