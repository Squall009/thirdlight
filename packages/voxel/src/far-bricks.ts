/**
 * Far nodes as distance-field bricks: a far-tree node (far-tree.ts) as a
 * sparse signed distance field of its surface, the far field drawn by ray
 * marching (the far meshes of far-mesh.ts are its fallback). The field is
 * built from the faces of the node's finer cells (far-bricks-faces.ts);
 * this module holds the format, the field the draw marches and its march
 * on the CPU.
 *
 * - **Format.** The distance-brick format (distance-brick-format.ts): a
 *   node's 32³ cells are 4³ bricks of 8³ cells; a brick the surface passes
 *   through stores its 9³ corner samples as bytes over ±
 *   {@link DISTANCE_BRICK_BAND_VOXELS} of the node's cells, the others say
 *   outside or inside in one word. Only a brick whose samples change sign
 *   is stored (a brick within the band but not crossed by the surface has
 *   nothing to draw).
 * - **Material.** Each sample carries a material and wetness word (as a
 *   far vertex does, `material | wetness << 12`), and with the far field's
 *   build its baked occlusion (far-bricks-shade.ts).
 * - **Skirts.** Neighbours drawn at different levels do not meet exactly,
 *   so a brick on its node's box face is marched {@link FAR_BRICK_LIP_CELLS}
 *   past that face, where the field is the face's own plus
 *   {@link FAR_BRICK_SKIRT_SLOPE} × the distance out: a steep skirt hanging
 *   {@link FAR_SKIRT_CELLS} cells into the ground, which shows only where
 *   the neighbour's surface lies lower (the gap a mesh skirt fills).
 *
 * {@link marchBrickBox} is one brick's march on the CPU, step for step (the
 * node march, far-bricks-node.ts, walks a node's bricks with it; the shader
 * in three-adapter `voxel-far-bricks.ts` is their port).
 */
import { BRICK_HIT_VOXELS, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import { FAR_SKIRT_CELLS } from './far-mesh';

/** How steeply a brick's skirt falls past its node's face (distance into the field a cell out). */
export const FAR_BRICK_SKIRT_SLOPE = 4;

/** How far past its node's box face a brick on it is marched (cells): its skirt reaches {@link FAR_SKIRT_CELLS} deep there. */
export const FAR_BRICK_LIP_CELLS = FAR_SKIRT_CELLS / FAR_BRICK_SKIRT_SLOPE;

/** Steps a ray takes through one brick at most (a ray still short of the surface then leaves it to the bricks behind). */
export const FAR_BRICK_STEPS = 32;

/** A far node's bricks. */
export interface FarBricks {
  /** Bricks a side of the node (its edge over {@link DISTANCE_BRICK_CELLS}). */
  readonly side: number;
  /** Per brick of the node (x fastest, then y, then z): its sample block, or `DISTANCE_BRICK_OUTSIDE` / `DISTANCE_BRICK_INSIDE`. */
  readonly bricks: Int32Array;
  /** Sample blocks of `DISTANCE_BRICK_SAMPLES` bytes (x fastest, then y, then z): 0 is −band, 255 is +band, in the node's cells. */
  readonly samples: Uint8Array;
  /** Each sample's material and wetness word (as {@link samples}). */
  readonly looks: Uint16Array;
  /** Per sample block: its brick within the node (x, y, z, one byte each) and the node box faces it lies on (bits −x +x −y +y −z +z). */
  readonly blocks: Uint8Array;
  /**
   * Per sample block: the cells of the brick the surface can be in (low x, y, z, then high x, y, z, brick cells
   * 0–8), so the draw's box and its march start there instead of at the brick's own box.
   */
  readonly bounds: Uint8Array;
  /** Per sample (as {@link samples}): its ambient occlusion, 0 shut … 255 open, made by a build asking for it ({@link FarBrickBuild.occlusion}). */
  readonly occlusion?: Uint8Array;
}

/** Bytes a block's entry in {@link FarBricks.bounds} takes. */
export const FAR_BRICK_BOUNDS_BYTES = 6;

/**
 * How a far node's bricks are made: the exact signed distance at each corner to the faces of the solid cells (their
 * union of cubes), read from cells `scale` times finer than the node's (its descendants that many levels down; the
 * node's own where it has none kept), each sample's look the material most top cells round it show
 * (far-bricks-faces.ts).
 */
export interface FarBrickBuild {
  /** Source cells a node cell an axis: 1, 2 or 4 (the node's own cells, its children's, its grandchildren's). */
  readonly scale: number;
  /** Whether the job also bakes each sample's ambient occlusion ({@link FarBricks.occlusion}), for a draw that shades from baked samples. */
  readonly occlusion?: boolean;
}

/**
 * The far field's brick build: faces from the node's children (cells twice finer: the mip's detail kept; the
 * grandchildren gained little more at seven times the build), each sample's occlusion baked in the job so the draw
 * shades with one read.
 */
export const FAR_BRICK_BUILD: FarBrickBuild = Object.freeze({ scale: 2, occlusion: true });

/** Bytes a block's entry in {@link FarBricks.blocks} takes. */
export const FAR_BRICK_BLOCK_BYTES = 4;

/** Sample blocks a far node's bricks hold. */
export function farBrickCount(b: FarBricks): number {
  return b.samples.length / DISTANCE_BRICK_SAMPLES;
}

/** Bytes a far node's bricks hold. */
export function farBricksBytes(b: FarBricks): number {
  return b.bricks.byteLength + b.samples.byteLength + b.looks.byteLength + b.blocks.byteLength + b.bounds.byteLength + (b.occlusion?.byteLength ?? 0);
}

/** The buffers a far node's bricks can hand over. */
export function farBricksTransfer(b: FarBricks, out: ArrayBuffer[] = []): ArrayBuffer[] {
  for (const a of [b.bricks, b.samples, b.looks, b.blocks, b.bounds, ...(b.occlusion !== undefined ? [b.occlusion] : [])]) if (a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer);
  return out;
}

/**
 * Squared Euclidean distances (cells) from every cell of an n³ grid to the
 * nearest cell whose mask is `kind` (Felzenszwalb and Huttenlocher's
 * separable transform, an axis at a time); none on the grid: a large value.
 * With `every` > 1 the result holds only where x and y are `from` plus a
 * multiple of `every` (any z): the y and z passes then run only along those
 * lines, which is all a caller reading a coarser lattice needs.
 */
export function squaredDistances(mask: Uint8Array, n: number, kind: 0 | 1, every = 1, from = 0): Float32Array {
  const INF = 1e12;
  const d = new Float32Array(n * n * n);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] === kind ? 0 : INF;
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const zz = new Float64Array(n + 1);
  const line = (s: number, stride: number): void => {
    for (let q = 0; q < n; q++) f[q] = d[s + q * stride]!;
    lowerEnvelope(f, n, out, v, zz, INF);
    for (let q = 0; q < n; q++) d[s + q * stride] = out[q]!;
  };
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) line((z * n + y) * n, 1); // x: rows of (y, z)
  for (let z = 0; z < n; z++) for (let x = from; x < n; x += every) line(z * n * n + x, n); // y: (x, z)
  for (let y = from; y < n; y += every) for (let x = from; x < n; x += every) line(y * n + x, n * n); // z: (x, y)
  return d;
}

function lowerEnvelope(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array, INF: number): void {
  let k = 0;
  let first = -1;
  for (let q = 0; q < n; q++) if (f[q]! < INF) {
    first = q;
    break;
  }
  if (first < 0) {
    out.fill(INF);
    return;
  }
  v[0] = first;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = first + 1; q < n; q++) {
    if (f[q]! >= INF) continue;
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    out[q] = (q - v[k]!) ** 2 + f[v[k]!]!;
  }
}

/** The trilinear distance (cells) at a point of a sample block (brick cells 0–8 an axis), as the GPU's filtered read. */
export function farBrickSample(samples: Uint8Array, block: number, p: readonly number[]): number {
  const S = DISTANCE_BRICK_SIDE;
  const o = block * DISTANCE_BRICK_SAMPLES;
  const q = [0, 1, 2].map((a) => Math.min(DISTANCE_BRICK_CELLS, Math.max(0, p[a]!)));
  const i = q.map((c) => Math.min(DISTANCE_BRICK_CELLS - 1, Math.floor(c)));
  const f = q.map((c, a) => c - i[a]!);
  let sum = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
    sum += w * samples[o + ((i[2]! + dz) * S + i[1]! + dy) * S + i[0]! + dx]!;
  }
  return distanceOfSample(sum, DISTANCE_BRICK_BAND_VOXELS);
}

/** The field the draw marches at a point of a brick (cells): the block's distance, and past the brick's box its skirt's. */
export function farBrickField(samples: Uint8Array, block: number, p: readonly number[]): number {
  const q = [0, 1, 2].map((a) => Math.min(DISTANCE_BRICK_CELLS, Math.max(0, p[a]!)));
  const out = Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  return farBrickSample(samples, block, q) + FAR_BRICK_SKIRT_SLOPE * out;
}

/** One brick's march over a box of its cells (`lo`–`hi`, the draw's marched box) from where the ray enters it: where it hits (cells along the unit direction from the origin) and the steps taken; null: it leaves the box (or runs out of steps) first. */
export function marchBrickBox(samples: Uint8Array, block: number, lo: readonly number[], hi: readonly number[], o: readonly number[], d: readonly number[]): { t: number; steps: number } | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / (Math.abs(d[a]!) < 1e-8 ? (d[a]! < 0 ? -1e-8 : 1e-8) : d[a]!);
    const ta = (lo[a]! - o[a]!) * inv;
    const tb = (hi[a]! - o[a]!) * inv;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (!(t0 <= t1)) return null;
  let t = t0;
  for (let steps = 1; steps <= FAR_BRICK_STEPS; steps++) {
    const p = [o[0]! + d[0]! * t, o[1]! + d[1]! * t, o[2]! + d[2]! * t];
    const f = farBrickField(samples, block, p);
    if (f < BRICK_HIT_VOXELS) return { t, steps };
    if (t >= t1) return null;
    // The skirt's field grows faster than the distance: its steps are shortened to match.
    const inside = p.every((c) => c >= 0 && c <= DISTANCE_BRICK_CELLS);
    t = Math.min(t1, t + Math.max(inside ? f : f / (1 + FAR_BRICK_SKIRT_SLOPE), BRICK_MIN_STEP_VOXELS));
  }
  return null;
}
