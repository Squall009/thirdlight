/**
 * The voxel light volume's layout and its arithmetic, pure of three.js and
 * of the GPU (voxel-light-volume.ts keeps it on the GPU; the WGSL update and
 * the surfaces' read follow these steps, and the tests check them here).
 *
 * - **Cells.** Light is kept in the open cells (0.5 m) that touch a solid
 *   one across a face, as six values a cell: the light arriving at a surface
 *   facing +X, −X, +Y, −Y, +Z, −Z there (an ambient cube). The walk's
 *   `light` stop decides what is solid, so a cell is open exactly where the
 *   update's rays pass. Storing on the open side keeps each side of a 0.5 m
 *   wall apart: a reader blends only open cells on its own side.
 * - **Bricks.** Cells are kept in bricks of 4³ (2 m, the walk's own bricks):
 *   a brick is resident when it holds an open cell and it or a brick sharing
 *   a face with it holds a solid cell, within a window of bricks round the
 *   camera ({@link VOLUME_WINDOW_BRICKS}). A brick takes a slot of the pool:
 *   `VOLUME_BRICK_TEXELS` words, a cell's six faces side by side.
 * - **Words.** A face is one u32: RGB with a shared exponent (9 bits each,
 *   5 of exponent, as the RGB9E5 format), the exponent never 0 for a cell
 *   that holds light, so a word of 0 is "no light here" (a solid cell, one
 *   not lit yet) and black is not.
 * - **The window.** A brick's place in the window's index is its world brick
 *   coordinate modulo the window on each axis (wrapped): a move writes only
 *   the bricks that enter and leave.
 */
import type { ScalarOps } from '@thirdlight/shared';
import { OCCUPANCY, type WalkBlockView, type WalkSource } from '@thirdlight/voxel';

/** `material.userData[VOLUME_READ_KEY]`: the material's draws read the light volume where it holds light (the voxel surfaces). */
export const VOLUME_READ_KEY = 'tlVoxelLightVolume';

/** Cells a brick spans along each axis, and its log2. */
export const VOLUME_BRICK_CELLS = 4;
export const VOLUME_BRICK_SHIFT = 2;
/** Cells a brick holds. */
export const VOLUME_BRICK_VOLUME = VOLUME_BRICK_CELLS ** 3;
/** Faces a cell holds (+X, −X, +Y, −Y, +Z, −Z). */
export const VOLUME_FACES = 6;
/** Words (pool texels) a brick takes. */
export const VOLUME_BRICK_TEXELS = VOLUME_BRICK_VOLUME * VOLUME_FACES;
/** Bricks a pool row holds, and the pool's and the colours' row widths (texels). */
export const VOLUME_BRICKS_PER_ROW = 16;
export const VOLUME_POOL_WIDTH = VOLUME_BRICKS_PER_ROW * VOLUME_BRICK_TEXELS;
export const VOLUME_ALBEDO_WIDTH = VOLUME_BRICKS_PER_ROW * VOLUME_BRICK_VOLUME;
/**
 * The window of bricks round the camera (x, y, z): 96 × 48 × 96 m, so the cells reach past the low tier's detail ring
 * (about 45 m) round the eye, and 24 m above and below it.
 */
export const VOLUME_WINDOW_BRICKS: readonly [number, number, number] = [48, 24, 48];
/** Cells a level-0 walk block spans (32: a storage chunk). */
const BLOCK_CELLS = 32;
const BLOCK_BRICKS = BLOCK_CELLS / VOLUME_BRICK_CELLS;

/** A cell's place in its brick (0 … 63): x, then y, then z. */
export function volumeCellIndex(lx: number, ly: number, lz: number): number {
  return lx + VOLUME_BRICK_CELLS * (ly + VOLUME_BRICK_CELLS * lz);
}

/** The pool texel of face `face` of cell `cell` (0 … 63) of the brick in `slot`. */
export function volumePoolTexel(slot: number, cell: number, face: number): [number, number] {
  const i = slot * VOLUME_BRICK_TEXELS + cell * VOLUME_FACES + face;
  return [i % VOLUME_POOL_WIDTH, Math.floor(i / VOLUME_POOL_WIDTH)];
}

/** A world brick's place in the window's index (each axis modulo the window), as the index texture's texel. */
export function volumeIndexTexel(bx: number, by: number, bz: number, dims: readonly number[] = VOLUME_WINDOW_BRICKS): [number, number] {
  const m = (v: number, n: number): number => ((v % n) + n) % n;
  return [m(bx, dims[0]!) + dims[0]! * m(bz, dims[2]!), m(by, dims[1]!)];
}

/** A world brick's key (bricks within ±8192 across, ±2048 up). */
export function volumeBrickKey(bx: number, by: number, bz: number): number {
  return ((bx + 8192) * 4096 + (by + 2048)) * 16384 + (bz + 8192);
}

/** The face (0 … 5) whose surface faces along axis `axis` (0 x, 1 y, 2 z) toward `sign`. */
export function volumeFace(axis: number, sign: number): number {
  return axis * 2 + (sign < 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Words: RGB with a shared exponent

const MANTISSA_BITS = 9;
const EXP_BIAS = 15;
const MAX_EXP = 31;

/**
 * A face's word for light `rgb` (≥ 0; the CPU twin of the WGSL `volume_encode`): RGB9E5 with the exponent at least 1,
 * so a cell that holds light (even none) is never the word 0.
 */
export function volumeEncode(r: number, g: number, b: number): number {
  const top = 65408;
  const cr = Math.min(Math.max(r, 0), top);
  const cg = Math.min(Math.max(g, 0), top);
  const cb = Math.min(Math.max(b, 0), top);
  const m = Math.max(cr, cg, cb);
  let e = Math.max(-EXP_BIAS - 1, Math.floor(Math.log2(Math.max(m, 1e-30)))) + 1 + EXP_BIAS;
  e = Math.min(Math.max(e, 1), MAX_EXP);
  let scale = 2 ** (e - EXP_BIAS - MANTISSA_BITS);
  if (Math.floor(m / scale + 0.5) === 1 << MANTISSA_BITS && e < MAX_EXP) {
    e += 1;
    scale *= 2;
  }
  const q = (v: number): number => Math.min((1 << MANTISSA_BITS) - 1, Math.floor(v / scale + 0.5));
  return (q(cr) | (q(cg) << 9) | (q(cb) << 18) | (e << 27)) >>> 0;
}

/** A face's light from its word (0: none held; the CPU twin of the surfaces' decode). */
export function volumeDecode(w: number): [number, number, number] {
  const e = w >>> 27;
  const scale = 2 ** (e - EXP_BIAS - MANTISSA_BITS);
  return [(w & 511) * scale, ((w >>> 9) & 511) * scale, ((w >>> 18) & 511) * scale];
}

/** The WGSL of the words' encode and decode (the update pass reads its neighbours' light and writes its own). */
export function volumeWordsWgsl(): string {
  return /* wgsl */ `
fn volume_encode(c: vec3<f32>) -> u32 {
  let v = clamp(c, vec3<f32>(0.0), vec3<f32>(65408.0));
  let m = max(v.x, max(v.y, v.z));
  var e = clamp(i32(floor(log2(max(m, 1e-30)))) + 1 + ${EXP_BIAS}, 1, ${MAX_EXP});
  var scale = exp2(f32(e - ${EXP_BIAS + MANTISSA_BITS}));
  if (u32(floor(m / scale + 0.5)) == ${1 << MANTISSA_BITS}u && e < ${MAX_EXP}) { e = e + 1; scale = scale * 2.0; }
  let q = min(vec3<u32>(floor(v / scale + 0.5)), vec3<u32>(${(1 << MANTISSA_BITS) - 1}u));
  return q.x | (q.y << 9u) | (q.z << 18u) | (u32(e) << 27u);
}

fn volume_decode(w: u32) -> vec3<f32> {
  let scale = exp2(f32(i32(w >> 27u) - ${EXP_BIAS + MANTISSA_BITS}));
  return vec3<f32>(f32(w & 511u), f32((w >> 9u) & 511u), f32((w >> 18u) & 511u)) * scale;
}
`;
}

/** The exponent's bias and the mantissa bits (the surfaces' decode in TSL takes them from here). */
export const VOLUME_WORD = Object.freeze({ mantissaBits: MANTISSA_BITS, expBias: EXP_BIAS });

// ---------------------------------------------------------------------------------------------------------------
// The ambient cube

/**
 * The light on a surface facing `n` (unit) from a cell's six faces (one channel): each axis's face on the normal's
 * side, weighted by the normal's square along it. One definition for the CPU and the surfaces' read.
 */
export function ambientCubeSteps<F, B>(o: ScalarOps<F, B>, nx: F, ny: F, nz: F, faces: readonly [F, F, F, F, F, F]): F {
  const zero = o.n(0);
  const x = o.select(o.lt(nx, zero), faces[1], faces[0]);
  const y = o.select(o.lt(ny, zero), faces[3], faces[2]);
  const z = o.select(o.lt(nz, zero), faces[5], faces[4]);
  return o.add(o.add(o.mul(o.mul(nx, nx), x), o.mul(o.mul(ny, ny), y)), o.mul(o.mul(nz, nz), z));
}

/** Half a cell off a surface along its normal, where a reader looks for its open cell (metres, of a 0.5 m cell). */
export const VOLUME_READ_OFFSET_CELLS = 0.5;

/**
 * The light a surface at `p` (metres) facing `n` (unit) reads, the CPU reference of the surfaces' read: the eight
 * cells round the point half a cell off it along `n`, weighted trilinearly, only those holding light counted
 * (`faces(x, y, z)`: the six faces' light of a cell, null where none is held), divided by the weight they had.
 * Returns the light and the weight (0: none of the eight holds light; the reader keeps its flat term).
 */
export function volumeReadAt(p: readonly number[], n: readonly number[], cellM: number, faces: (x: number, y: number, z: number) => readonly (readonly number[])[] | null, o: ScalarOps<number, boolean>): { light: [number, number, number]; weight: number } {
  const g = [0, 1, 2].map((a) => (p[a]! + n[a]! * VOLUME_READ_OFFSET_CELLS * cellM) / cellM - 0.5);
  const i0 = g.map(Math.floor);
  const f = g.map((v, a) => v - i0[a]!);
  const sum: [number, number, number] = [0, 0, 0];
  let wsum = 0;
  for (let k = 0; k < 8; k++) {
    const c = [0, 1, 2].map((a) => i0[a]! + ((k >> a) & 1));
    const w = [0, 1, 2].reduce((acc, a) => acc * (((k >> a) & 1) === 1 ? f[a]! : 1 - f[a]!), 1);
    if (w <= 0) continue;
    const fc = faces(c[0]!, c[1]!, c[2]!);
    if (fc === null) continue;
    for (let ch = 0; ch < 3; ch++) sum[ch as 0 | 1 | 2] += w * ambientCubeSteps(o, n[0]!, n[1]!, n[2]!, [fc[0]![ch]!, fc[1]![ch]!, fc[2]![ch]!, fc[3]![ch]!, fc[4]![ch]!, fc[5]![ch]!]);
    wsum += w;
  }
  return { light: wsum > 0 ? [sum[0] / wsum, sum[1] / wsum, sum[2] / wsum] : [0, 0, 0], weight: wsum };
}

// ---------------------------------------------------------------------------------------------------------------
// Which cells and bricks hold light

/** Whether a level-0 cell stops light, by the walk's blocks (null where no block is known: the walk passes as air). */
export function volumeSolidAt(src: WalkSource, x: number, y: number, z: number): boolean {
  const v = src.block(0, x >> 5, y >> 5, z >> 5, 'light');
  if (v === null) return false;
  return v.flag === OCCUPANCY.solid || (v.flag === OCCUPANCY.mixed && v.cell(((x & 31) * BLOCK_CELLS + (z & 31)) * BLOCK_CELLS + (y & 31)));
}

/** Whether a level-0 cell holds light: open, with a solid cell across one of its faces (the update's rule, cell by cell). */
export function volumeCellHolds(src: WalkSource, x: number, y: number, z: number): boolean {
  if (volumeSolidAt(src, x, y, z)) return false;
  return volumeSolidAt(src, x + 1, y, z) || volumeSolidAt(src, x - 1, y, z) || volumeSolidAt(src, x, y + 1, z) || volumeSolidAt(src, x, y - 1, z) || volumeSolidAt(src, x, y, z + 1) || volumeSolidAt(src, x, y, z - 1);
}

/** A level-0 block's bricks as the volume reads them: which hold a solid cell and which are solid through. */
export interface VolumeBlockBricks {
  /** A bit a brick (index `(x · 8 + z) · 8 + y`): it holds a cell that stops light. */
  readonly some: Uint32Array;
  /** A bit a brick: every cell of it stops light. */
  readonly all: Uint32Array;
}

const BRICK_WORDS = BLOCK_BRICKS ** 3 / 32;

/** The brick index inside a block of local brick (x, y, z) (the walk's order). */
function blockBrickIndex(x: number, y: number, z: number): number {
  return (x * BLOCK_BRICKS + z) * BLOCK_BRICKS + y;
}

/** A block's brick bits from its view (light stop). */
export function volumeBlockBricks(view: WalkBlockView): VolumeBlockBricks {
  const some = new Uint32Array(BRICK_WORDS);
  const all = new Uint32Array(BRICK_WORDS);
  if (view.flag === OCCUPANCY.empty) return { some, all };
  if (view.flag === OCCUPANCY.solid) {
    some.fill(0xffffffff);
    all.fill(0xffffffff);
    return { some, all };
  }
  for (let i = 0; i < BLOCK_BRICKS ** 3; i++) {
    if (view.brick(i) === OCCUPANCY.empty) continue;
    some[i >>> 5]! |= 1 << (i & 31);
    const bx = Math.floor(i / (BLOCK_BRICKS * BLOCK_BRICKS));
    const bz = Math.floor(i / BLOCK_BRICKS) % BLOCK_BRICKS;
    const by = i % BLOCK_BRICKS;
    let full = true;
    for (let x = 0; x < 4 && full; x++) for (let z = 0; z < 4 && full; z++) for (let y = 0; y < 4 && full; y++) full = view.cell(((bx * 4 + x) * BLOCK_CELLS + bz * 4 + z) * BLOCK_CELLS + by * 4 + y);
    if (full) all[i >>> 5]! |= 1 << (i & 31);
  }
  return { some, all };
}

/** Reads a world brick's bits from the blocks known (null block: unknown, read as open air). */
export type VolumeBlockLookup = (bx: number, by: number, bz: number) => VolumeBlockBricks | null;

function brickBit(blocks: VolumeBlockLookup, x: number, y: number, z: number, which: 'some' | 'all'): boolean {
  const b = blocks(x >> 3, y >> 3, z >> 3);
  if (b === null) return false;
  const i = blockBrickIndex(x & 7, y & 7, z & 7);
  return ((b[which][i >>> 5]! >>> (i & 31)) & 1) === 1;
}

/**
 * Whether a world brick (bricks of 4 cells) is kept: it holds an open cell, and it or a brick across one of its faces
 * holds a solid one. Every cell that holds light lies in a kept brick (its solid neighbour is in its own brick or in
 * one across a face); a kept brick may hold none (its cells' rule is the update's).
 */
export function volumeBrickKept(blocks: VolumeBlockLookup, bx: number, by: number, bz: number): boolean {
  if (brickBit(blocks, bx, by, bz, 'all')) return false;
  if (brickBit(blocks, bx, by, bz, 'some')) return true;
  return brickBit(blocks, bx + 1, by, bz, 'some') || brickBit(blocks, bx - 1, by, bz, 'some') || brickBit(blocks, bx, by + 1, bz, 'some') || brickBit(blocks, bx, by - 1, bz, 'some') || brickBit(blocks, bx, by, bz + 1, 'some') || brickBit(blocks, bx, by, bz - 1, 'some');
}

/** The bricks of a block whose light-stopping cells differ between two pages' views (an edit's or an arrival's bricks). */
export function volumeChangedBricks(before: WalkBlockView | null, after: WalkBlockView | null): number[] {
  const out: number[] = [];
  const stop = (v: WalkBlockView | null, i: number): boolean => v !== null && (v.flag === OCCUPANCY.solid || (v.flag === OCCUPANCY.mixed && v.cell(i)));
  for (let bi = 0; bi < BLOCK_BRICKS ** 3; bi++) {
    const bx = Math.floor(bi / (BLOCK_BRICKS * BLOCK_BRICKS));
    const bz = Math.floor(bi / BLOCK_BRICKS) % BLOCK_BRICKS;
    const by = bi % BLOCK_BRICKS;
    const quick = (v: WalkBlockView | null): number => (v === null ? -1 : v.flag !== OCCUPANCY.mixed ? v.flag : v.brick(bi));
    // Both empty there (or both solid through): nothing differs inside the brick.
    const qa = quick(before);
    const qb = quick(after);
    if (qa === qb && qa !== OCCUPANCY.mixed) continue;
    let differs = false;
    for (let x = 0; x < 4 && !differs; x++) for (let z = 0; z < 4 && !differs; z++) for (let y = 0; y < 4 && !differs; y++) {
      const i = ((bx * 4 + x) * BLOCK_CELLS + bz * 4 + z) * BLOCK_CELLS + by * 4 + y;
      differs = stop(before, i) !== stop(after, i);
    }
    if (differs) out.push(bi);
  }
  return out;
}

/** A block brick index's local brick (x, y, z). */
export function volumeBlockBrick(bi: number): [number, number, number] {
  return [Math.floor(bi / (BLOCK_BRICKS * BLOCK_BRICKS)), bi % BLOCK_BRICKS, Math.floor(bi / BLOCK_BRICKS) % BLOCK_BRICKS];
}

/** Bricks a level-0 block spans along each axis. */
export const VOLUME_BLOCK_BRICKS = BLOCK_BRICKS;

/** Bricks round a changed brick whose light starts again from nothing (farther ones within the reach keep half). */
export const VOLUME_MARK_NEAR_BRICKS = 2;

/**
 * A kept brick's updates after a change to the bricks lo … hi (inclusive, world bricks) that rays of `reachBricks`
 * can reach: from nothing within {@link VOLUME_MARK_NEAR_BRICKS} of them, at most half of `settle` within the reach,
 * null (untouched) past it. The distance is the largest of the axes' gaps (a ray's reach along any axis).
 */
export function volumeMarkedUpdates(b: readonly number[], lo: readonly number[], hi: readonly number[], updates: number, reachBricks: number, settle: number): number | null {
  const gap = (a: number): number => (b[a]! < lo[a]! ? lo[a]! - b[a]! : b[a]! > hi[a]! ? b[a]! - hi[a]! : 0);
  const d = Math.max(gap(0), gap(1), gap(2));
  if (d > reachBricks) return null;
  return d <= VOLUME_MARK_NEAR_BRICKS ? 0 : Math.min(updates, settle >> 1);
}
