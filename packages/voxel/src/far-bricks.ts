/**
 * Far nodes as distance-field bricks: a far-tree node (far-tree.ts) as a
 * sparse signed distance field of its cells, the far field's second
 * stand-in (beside the meshes of far-mesh.ts), ray marched where it is
 * drawn.
 *
 * - **Format.** The distance-brick format (distance-brick-format.ts): a
 *   node's 32³ cells are 4³ bricks of 8³ cells; a brick the surface passes
 *   through stores its 9³ corner samples as bytes over ±
 *   {@link DISTANCE_BRICK_BAND_VOXELS} of the node's cells, the others say
 *   outside or inside in one word. Only a brick whose samples change sign
 *   is stored (a brick within the band but not crossed by the surface has
 *   nothing to draw).
 * - **Field.** A cell is solid where its density (its fill level) is at
 *   least half. Every cell centre takes its Euclidean distance to the
 *   nearest cell of the other kind, less half a cell (so the surface lies
 *   on the faces between solid and air), and a cell next to the other kind
 *   takes ½ − its density instead, so a terrain cell's fill level moves the
 *   surface within it. A corner sample is the mean of its eight cells. The
 *   node's 26 neighbours at its level give the distances near its faces, so
 *   two neighbours drawn at one level meet exactly.
 * - **Material.** Each sample carries the material and wetness word (as a
 *   far vertex does, `material | wetness << 12`) of the cell the surface
 *   there shows: the topmost of its eight cells with air above (a thin top
 *   included), else the topmost solid one, else the nearest within two
 *   cells. The draw colours a hit from the
 *   material table, so a record's look reaches the far field with no
 *   brick rebuilt.
 * - **Skirts.** Neighbours drawn at different levels do not meet exactly,
 *   so a brick on its node's box face is marched {@link FAR_BRICK_LIP_CELLS}
 *   past that face, where the field is the face's own plus
 *   {@link FAR_BRICK_SKIRT_SLOPE} × the distance out: a steep skirt hanging
 *   {@link FAR_SKIRT_CELLS} cells into the ground, which shows only where
 *   the neighbour's surface lies lower (the gap a mesh skirt fills).
 *
 * {@link marchFarBrick} is the draw's march on the CPU, step for step (the
 * shader in three-adapter `voxel-far-bricks.ts` is its port).
 */
import type { ChunkGrid } from './coords';
import { BRICK_HIT_VOXELS, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample, sampleOfDistance } from './distance-brick-format';
import { FAR_SKIRT_CELLS, withFarNeighbourhood, type FarMeshInput } from './far-mesh';
import type { PaletteStore } from './palette-store';
import { fillLevel, MATERIAL_AIR, MATERIAL_BITS, SHAPE_FULL, VOXEL_ROLE, type VoxelRecord } from './record';

/** How steeply a brick's skirt falls past its node's face (distance into the field a cell out). */
export const FAR_BRICK_SKIRT_SLOPE = 4;

/** How far past its node's box face a brick on it is marched (cells): its skirt reaches {@link FAR_SKIRT_CELLS} deep there. */
export const FAR_BRICK_LIP_CELLS = FAR_SKIRT_CELLS / FAR_BRICK_SKIRT_SLOPE;

/** Steps a ray takes through one brick at most (a ray still short of the surface then leaves it to the bricks behind). */
export const FAR_BRICK_STEPS = 32;

/** Cells an air sample's material is looked for round it when none of its eight cells is solid. */
const LOOK_REACH_CELLS = 2;

/** Rows of cells (from a corner's lower four) a sample's look takes a top from, in order: its own two, then one above and one below. */
const TOP_ROWS = [1, 0, 2, -1] as const;

/** Cells read round the node: the band, and one more for the cells next to the band's edge. */
const APRON_CELLS = DISTANCE_BRICK_BAND_VOXELS + 1;

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
 * How a far node's bricks are made from cells:
 * - `occupancy`: each node cell's distance to the other kind from its
 *   centre, a corner sample the mean of its eight cells (smooth slopes, but
 *   a feature a cell or two across is averaged away);
 * - `faces`: the exact signed distance at each corner to the faces of the
 *   solid cells (their union of cubes), read from cells `scale` times finer
 *   than the node's (its descendants that many levels down), so the surface
 *   sits where the finer cells put it and one-cell features keep a body.
 *   Each sample's look is the material the most top cells round it show
 *   (thin tops included; other surface cells only where no top is in
 *   reach), so a sample's colour is its neighbourhood's.
 */
export interface FarBrickBuild {
  readonly field: 'occupancy' | 'faces';
  /** Source cells a node cell an axis: 1, 2 or 4 (the node's own cells, its children's, its grandchildren's). */
  readonly scale: number;
  /** Whether the job also bakes each sample's ambient occlusion ({@link FarBricks.occlusion}), for a draw that shades from baked samples. */
  readonly occlusion?: boolean;
}

/** The far bricks as first built: the node's own cells, occupancy distances. */
export const FAR_BRICK_BUILD_OCCUPANCY: FarBrickBuild = Object.freeze({ field: 'occupancy', scale: 1 });

/** The brick builds by name (a page's or a level's switch): occupancy, faces from the node's cells, faces from its children's. */
export const FAR_BRICK_BUILDS: Readonly<Record<string, FarBrickBuild>> = Object.freeze({
  occupancy: FAR_BRICK_BUILD_OCCUPANCY,
  faces: Object.freeze({ field: 'faces', scale: 1 }),
  faces2: Object.freeze({ field: 'faces', scale: 2 }),
} as const);

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

const emptyBricks = (side: number): FarBricks => ({ side, bricks: new Int32Array(side ** 3).fill(DISTANCE_BRICK_OUTSIDE), samples: new Uint8Array(0), looks: new Uint16Array(0), blocks: new Uint8Array(0), bounds: new Uint8Array(0) });

/**
 * A far node's bricks from `store` (a scratch store: the job's 27 entries
 * are put in, and taken out again before it returns).
 */
export function brickFarNode(store: PaletteStore, input: Pick<FarMeshInput, 'cells' | 'level' | 'node'>, decompress: (b: Uint8Array) => Uint8Array): FarBricks {
  const side = store.grid.edge / DISTANCE_BRICK_CELLS;
  return withFarNeighbourhood(store, input, decompress, () => farBricksOf(store.grid, store, input.node), () => emptyBricks(side));
}

/** The bricks of the node at `node` in `store` (its neighbours read where they are). */
export function farBricksOf(g: ChunkGrid, store: PaletteStore, node: readonly [number, number, number]): FarBricks {
  const e = g.edge;
  if (e % DISTANCE_BRICK_CELLS !== 0) throw new RangeError(`far bricks: a chunk edge of ${e} cells is not whole bricks`);
  const side = e / DISTANCE_BRICK_CELLS;
  const A = APRON_CELLS;
  const n = e + 2 * A;
  const n2 = n * n;
  const total = n2 * n;
  const density = new Float32Array(total);
  const word = new Uint16Array(total);
  const solid = new Uint8Array(total);
  const base = [node[0] * e - A, node[1] * e - A, node[2] * e - A];
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  let any = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    store.voxelAt(base[0]! + x, base[1]! + y, base[2]! + z, v);
    if (v.material === MATERIAL_AIR || v.role === VOXEL_ROLE.liquid) continue;
    const i = (z * n + y) * n + x;
    const d = fillLevel(v.role, v.shape) / SHAPE_FULL;
    density[i] = d;
    word[i] = v.material | (v.wetness << MATERIAL_BITS);
    if (d >= 0.5) {
      solid[i] = 1;
      any++;
    }
  }
  if (any === 0) return emptyBricks(side);
  if (any === total) return { ...emptyBricks(side), bricks: new Int32Array(side ** 3).fill(DISTANCE_BRICK_INSIDE) };
  // Squared distances (cells) from each cell to the nearest cell of the other kind.
  const toSolid = squaredDistances(solid, n, 1);
  const toAir = squaredDistances(solid, n, 0);
  const centre = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const d2 = solid[i] === 1 ? toAir[i]! : toSolid[i]!;
    const d = Math.sqrt(d2);
    centre[i] = d2 === 1 ? 0.5 - density[i]! : solid[i] === 1 ? -(d - 0.5) : d - 0.5;
  }
  const band = DISTANCE_BRICK_BAND_VOXELS;
  const S = DISTANCE_BRICK_SIDE;
  const bricks = new Int32Array(side ** 3);
  const samples: Uint8Array[] = [];
  const looks: Uint16Array[] = [];
  const blocks: number[] = [];
  const block = new Uint8Array(DISTANCE_BRICK_SAMPLES);
  const values = new Float32Array(DISTANCE_BRICK_SAMPLES);
  for (let bz = 0; bz < side; bz++) for (let by = 0; by < side; by++) for (let bx = 0; bx < side; bx++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let sz = 0; sz < S; sz++) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      // The corner at node cell (k), between padded cells k − 1 + A and k + A on each axis.
      const cx = bx * DISTANCE_BRICK_CELLS + sx + A - 1;
      const cy = by * DISTANCE_BRICK_CELLS + sy + A - 1;
      const cz = bz * DISTANCE_BRICK_CELLS + sz + A - 1;
      const i = (cz * n + cy) * n + cx;
      const m = (centre[i]! + centre[i + 1]! + centre[i + n]! + centre[i + n + 1]! + centre[i + n2]! + centre[i + n2 + 1]! + centre[i + n2 + n]! + centre[i + n2 + n + 1]!) / 8;
      values[(sz * S + sy) * S + sx] = m;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    const b = (bz * side + by) * side + bx;
    // A surface on the brick's face (samples of 0 there) is drawn by the brick on its outside.
    if (lo > 0) {
      bricks[b] = DISTANCE_BRICK_OUTSIDE;
      continue;
    }
    if (hi <= 0) {
      bricks[b] = DISTANCE_BRICK_INSIDE;
      continue;
    }
    for (let k = 0; k < DISTANCE_BRICK_SAMPLES; k++) block[k] = sampleOfDistance(values[k]!, band);
    const look = new Uint16Array(DISTANCE_BRICK_SAMPLES);
    let last = 0;
    for (let sz = 0; sz < S; sz++) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const w = sampleLook(solid, density, word, n, bx * DISTANCE_BRICK_CELLS + sx + A - 1, by * DISTANCE_BRICK_CELLS + sy + A - 1, bz * DISTANCE_BRICK_CELLS + sz + A - 1);
      if (w >= 0) last = w;
      look[(sz * S + sy) * S + sx] = w >= 0 ? w : last;
    }
    bricks[b] = samples.length;
    samples.push(block.slice());
    looks.push(look);
    const faces = (bx === 0 ? 1 : 0) | (bx === side - 1 ? 2 : 0) | (by === 0 ? 4 : 0) | (by === side - 1 ? 8 : 0) | (bz === 0 ? 16 : 0) | (bz === side - 1 ? 32 : 0);
    blocks.push(bx, by, bz, faces);
  }
  const out = new Uint8Array(samples.length * DISTANCE_BRICK_SAMPLES);
  const outLooks = new Uint16Array(samples.length * DISTANCE_BRICK_SAMPLES);
  samples.forEach((s, i) => out.set(s, i * DISTANCE_BRICK_SAMPLES));
  looks.forEach((s, i) => outLooks.set(s, i * DISTANCE_BRICK_SAMPLES));
  const bounds = new Uint8Array((blocks.length / FAR_BRICK_BLOCK_BYTES) * FAR_BRICK_BOUNDS_BYTES);
  for (let i = 0; i < bounds.length; i += FAR_BRICK_BOUNDS_BYTES) bounds.set([0, 0, 0, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_CELLS], i);
  return { side, bricks, samples: out, looks: outLooks, blocks: Uint8Array.from(blocks), bounds };
}

/**
 * The look of the corner whose eight cells start at padded (x, y, z): the topmost of them with air above (however
 * thin: a top cell under half full is not solid, yet it is what the ground shows), else such a top a cell above or
 * below them (a sample a cell off the surface still colours the hit by its weight), else the topmost solid, else the
 * nearest solid within reach (−1: none). Tops first so a step's riser, which shows the subsoil, does not colour the
 * slope it is part of.
 */
function sampleLook(solid: Uint8Array, density: Float32Array, word: Uint16Array, n: number, x: number, y: number, z: number): number {
  for (const dy of TOP_ROWS) for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
    const i = ((z + dz) * n + y + dy) * n + x + dx;
    if (density[i]! > 0 && density[i + n] === 0) return word[i]!;
  }
  for (let dy = 1; dy >= 0; dy--) for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
    const i = ((z + dz) * n + y + dy) * n + x + dx;
    if (solid[i] === 1) return word[i]!;
  }
  let best = -1;
  let bestD = Infinity;
  const r = LOOK_REACH_CELLS;
  for (let dz = -r; dz <= r + 1; dz++) for (let dy = -r; dy <= r + 1; dy++) for (let dx = -r; dx <= r + 1; dx++) {
    const px = x + dx, py = y + dy, pz = z + dz;
    if (px < 0 || py < 0 || pz < 0 || px >= n || py >= n || pz >= n) continue;
    const i = (pz * n + py) * n + px;
    if (solid[i] !== 1) continue;
    const d = (dx - 0.5) ** 2 + (dy - 0.5) ** 2 + (dz - 0.5) ** 2;
    if (d < bestD) {
      bestD = d;
      best = word[i]!;
    }
  }
  return best;
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

/** A brick's marched box (brick cells): its own, grown by {@link FAR_BRICK_LIP_CELLS} on the node faces it lies on. */
export function farBrickBox(faces: number): { lo: [number, number, number]; hi: [number, number, number] } {
  const L = FAR_BRICK_LIP_CELLS;
  return {
    lo: [faces & 1 ? -L : 0, faces & 4 ? -L : 0, faces & 16 ? -L : 0],
    hi: [DISTANCE_BRICK_CELLS + (faces & 2 ? L : 0), DISTANCE_BRICK_CELLS + (faces & 8 ? L : 0), DISTANCE_BRICK_CELLS + (faces & 32 ? L : 0)],
  };
}

/** A ray's march through one brick: where it hits (cells along the unit direction from the origin) and the steps taken; null: it leaves the box (or runs out of steps) first. */
export function marchFarBrick(samples: Uint8Array, block: number, faces: number, o: readonly number[], d: readonly number[]): { t: number; steps: number } | null {
  const { lo, hi } = farBrickBox(faces);
  return marchBrickBox(samples, block, lo, hi, o, d);
}

/** {@link marchFarBrick} over a box of the brick's cells (`lo`–`hi`, the draw's marched box) from where the ray enters it. */
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
