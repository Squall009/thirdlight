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
import { OCCUPANCY, VOXEL_SIZE_M, type WalkBlockView, type WalkSource } from '@thirdlight/voxel';

/**
 * `material.userData[VOLUME_READ_KEY] = false`: the material's draws do not read the light volume. Every other lit draw
 * on a page the volume lights reads it (voxel surfaces, kit pieces, props, moving objects): one light for all.
 */
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

/**
 * Levels of the volume: 0 the 0.5 m cells beside surfaces; 1, 2 and 3 coarser cells of 1, 2 and 4 m (a level's cell
 * is 2^level level-0 cells a side, as the voxel mips) for open air, where a reader finds no 0.5 m cell holding light.
 */
export const VOLUME_LEVELS = 4;
/**
 * Each level's window of bricks (4³ of its cells) round the camera: level 0 as {@link VOLUME_WINDOW_BRICKS}; the coarse
 * levels a clipmap of 12 × 6 × 12 bricks, each reaching twice as far as the last (1 m cells over 48 × 24 × 48 m, 2 m
 * over 96 × 48 × 96 m, 4 m over 192 × 96 × 192 m).
 */
export const VOLUME_LEVEL_WINDOWS: readonly (readonly [number, number, number])[] = [VOLUME_WINDOW_BRICKS, [12, 6, 12], [12, 6, 12], [12, 6, 12]];
/** The index texture's row width (a level-0 window row of bricks across, by its depth): every level's rows fit in it. */
export const VOLUME_INDEX_WIDTH = VOLUME_WINDOW_BRICKS[0] * VOLUME_WINDOW_BRICKS[2];
/** The index texture's first row of each level (the levels' windows stacked by rows), and its rows. */
export const VOLUME_INDEX_ROW_BASE: readonly number[] = VOLUME_LEVEL_WINDOWS.map((_, l) => VOLUME_LEVEL_WINDOWS.slice(0, l).reduce((s, d) => s + d[1], 0));
export const VOLUME_INDEX_ROWS = VOLUME_LEVEL_WINDOWS.reduce((s, d) => s + d[1], 0);

/** Metres a cell of `level` spans. */
export function volumeCellM(level: number): number {
  return VOXEL_SIZE_M * 2 ** level;
}

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

/** A brick of `level`'s place in the index texture (its level's window, wrapped, in that level's rows). */
export function volumeLevelIndexTexel(level: number, bx: number, by: number, bz: number): [number, number] {
  const [x, y] = volumeIndexTexel(bx, by, bz, VOLUME_LEVEL_WINDOWS[level]!);
  return [x, VOLUME_INDEX_ROW_BASE[level]! + y];
}

/** A world brick's key (bricks of its level within ±8192 across, ±2048 up). */
export function volumeBrickKey(bx: number, by: number, bz: number, level = 0): number {
  return ((bx + 8192) * 4096 + (by + 2048)) * 16384 + (bz + 8192) + level * 2 ** 40;
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

// ---------------------------------------------------------------------------------------------------------------
// How an update writes a face

/**
 * Updates a brick is refined to while nothing changes (each update 4 rays a face): past its first settle the update
 * keeps taking settled bricks, nearest the eye first, until each has had this many, then stops again. A tier setting
 * once the volume is tuned.
 */
export const VOLUME_HISTORY_UPDATES = 64;

/**
 * A face's light is the mean of about the last 1 / this of its brick's updates (an estimate is blended in by
 * 1 / (⌈updates / this⌉ + 1)): the estimates made while the bounces a brick reads were still building fade out, where a
 * mean of every estimate kept them (a closed white box held 0.62 of its light after 8 updates and 0.79 after 64 with
 * the plain mean, 0.74 and 0.98 with this; vitest `voxel-light-volume-reference.test.ts`).
 */
export const VOLUME_HISTORY_SHARE = 4;

/**
 * The weight a face's same-face neighbours each take against its own light in the update's write, at its brick's
 * second update; it falls as 1 / (updates + 1), so the filter fades out as the face's own mean holds more rays (at 0.5
 * four neighbours hold half of the second write, a third of the fourth, a ninth of the eighth). A brick's first update
 * after a start takes none: its neighbours may still hold a light that went (they start a frame or two later).
 */
export const VOLUME_FILTER_SHARE = 0.5;

/** The weight a brick's new estimate is blended in by after `updates` updates (1: it replaces what was there). */
export function volumeBlendWeight(updates: number): number {
  return 1 / (Math.ceil(updates / VOLUME_HISTORY_SHARE) + 1);
}

/** The weight each same-face neighbour takes in a face's write after `updates` updates of its brick (none at the first). */
export function volumeFilterShare(updates: number): number {
  return updates === 0 ? 0 : VOLUME_FILTER_SHARE / (updates + 1);
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

/** A level's read weight at which it takes all of what is left (a smooth step from 0 up to it). */
export const VOLUME_FULL_WEIGHT = 0.25;
/** What is left below this share is not read from coarser levels (the surfaces' read skips them). */
export const VOLUME_LEFT_MIN = 1e-3;

/** A level's share of what is left from its read's weight: a smooth step from 0 to {@link VOLUME_FULL_WEIGHT}. */
export function volumeWeightShare(w: number): number {
  const t = Math.min(Math.max(w / VOLUME_FULL_WEIGHT, 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Which levels a point reads, and the light (the CPU reference of the surfaces' read): level 0 first, then each coarser
 * level for what the finer ones left: a level's read (`volumeReadAt` with its cell size) takes its weight's share
 * ({@link volumeWeightShare}) of what is left, so a point beside a surface reads its 0.5 m cells, a point in open air
 * (a character's head over a field, the middle of a room) the first coarse level holding light round it, and a point
 * no level holds keeps its flat term (weight 0). `faces(level, x, y, z)`: a cell of that level's six faces, or null.
 */
export function volumeReadLevels(p: readonly number[], n: readonly number[], faces: (level: number, x: number, y: number, z: number) => readonly (readonly number[])[] | null, o: ScalarOps<number, boolean>): { light: [number, number, number]; weight: number; shares: number[] } {
  let left = 1;
  const acc = [0, 0, 0];
  const shares: number[] = [];
  for (let level = 0; level < VOLUME_LEVELS; level++) {
    if (left <= VOLUME_LEFT_MIN) {
      shares.push(0);
      continue;
    }
    const r = volumeReadAt(p, n, volumeCellM(level), (x, y, z) => faces(level, x, y, z), o);
    const a = volumeWeightShare(r.weight);
    for (let k = 0; k < 3; k++) acc[k]! += left * a * r.light[k]!;
    shares.push(left * a);
    left *= 1 - a;
  }
  const weight = 1 - left;
  const d = Math.max(weight, 1e-4);
  return { light: [acc[0]! / d, acc[1]! / d, acc[2]! / d], weight, shares };
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

/**
 * Whether a cell of a coarse `level` (≥ 1) stops light, as the voxel mips decide: some level-0 cell inside it does (by
 * the walk's level-0 blocks: a cell's bits at 1 m, the walk's 2 m bricks' bits at 2 and 4 m). Where no level-0 block is
 * known it is open, as the level-0 cells are. Level 0: the cell itself. The update's WGSL `volume_coarse_solid`.
 */
export function volumeCoarseSolid(src: WalkSource, level: number, x: number, y: number, z: number): boolean {
  if (level === 0) return volumeSolidAt(src, x, y, z);
  const n = 1 << level;
  const f = [x * n, y * n, z * n];
  const v = src.block(0, f[0]! >> 5, f[1]! >> 5, f[2]! >> 5, 'light');
  if (v === null || v.flag === OCCUPANCY.empty) return false;
  if (v.flag === OCCUPANCY.solid) return true;
  const l = f.map((c) => c & 31);
  if (n >= VOLUME_BRICK_CELLS) {
    const m = n / VOLUME_BRICK_CELLS;
    const b = l.map((c) => c / VOLUME_BRICK_CELLS);
    for (let i = 0; i < m; i++) for (let k = 0; k < m; k++) for (let j = 0; j < m; j++) if (v.brick(blockBrickIndex(b[0]! + i, b[1]! + j, b[2]! + k)) !== OCCUPANCY.empty) return true;
    return false;
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) if (v.cell(((l[0]! + i) * BLOCK_CELLS + l[2]! + k) * BLOCK_CELLS + l[1]! + j)) return true;
  return false;
}

/** Whether a cell of `level` holds light: level 0 by {@link volumeCellHolds}; a coarse cell wherever it is open (open air too). */
export function volumeLevelCellHolds(src: WalkSource, level: number, x: number, y: number, z: number): boolean {
  return level === 0 ? volumeCellHolds(src, x, y, z) : !volumeCoarseSolid(src, level, x, y, z);
}

/**
 * Whether a brick of `level` is kept: level 0 by {@link volumeBrickKept}; a coarse brick, made of 2^level level-0 bricks a
 * side, by the same rule over them (not every one of them solid through, and some light-stopping cell in it or in a
 * coarse brick across one of its faces), so a coarse level is kept near what is solid and not in the open sky.
 */
export function volumeLevelBrickKept(blocks: VolumeBlockLookup, level: number, bx: number, by: number, bz: number): boolean {
  if (level === 0) return volumeBrickKept(blocks, bx, by, bz);
  const n = 1 << level;
  const some = (cx: number, cy: number, cz: number): boolean => {
    if (n === BLOCK_BRICKS) return blocks(cx, cy, cz)?.some.some((w) => w !== 0) ?? false;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) if (brickBit(blocks, cx * n + i, cy * n + j, cz * n + k, 'some')) return true;
    return false;
  };
  // No open cell in it: at 2 m and up a cell is one level-0 brick or more, so some light-stopping cell in each of its
  // cells (exact); at 1 m by its level-0 bricks solid through (a brick partly solid may still close every 1 m cell).
  const per = n / 4 > 1 ? n / 4 : 1;
  const all = (cx: number, cy: number, cz: number): boolean => {
    const which = level === 1 ? 'all' : 'some';
    for (let i = 0; i < n; i += per) for (let j = 0; j < n; j += per) for (let k = 0; k < n; k += per) {
      let closed = false;
      for (let a = 0; a < per && !closed; a++) for (let b = 0; b < per && !closed; b++) for (let c = 0; c < per && !closed; c++) closed = brickBit(blocks, cx * n + i + a, cy * n + j + b, cz * n + k + c, which);
      if (!closed) return false;
    }
    return true;
  };
  if (all(bx, by, bz)) return false;
  return some(bx, by, bz) || some(bx + 1, by, bz) || some(bx - 1, by, bz) || some(bx, by + 1, bz) || some(bx, by - 1, bz) || some(bx, by, bz + 1) || some(bx, by, bz - 1);
}

/**
 * The bricks of a block whose light-stopping cells differ between two pages' views (an edit's or an arrival's bricks).
 * A page marks a brick only when a cell of it stops light (walk-pages.ts packs the brick bits from the cells), so a
 * marked brick against nothing (a block not held, an empty one, an unmarked brick) differs without reading its cells.
 */
export function volumeChangedBricks(before: WalkBlockView | null, after: WalkBlockView | null): number[] {
  const out: number[] = [];
  const stop = (v: WalkBlockView | null, i: number): boolean => v !== null && (v.flag === OCCUPANCY.solid || (v.flag === OCCUPANCY.mixed && v.cell(i)));
  for (let bi = 0; bi < BLOCK_BRICKS ** 3; bi++) {
    const bx = Math.floor(bi / (BLOCK_BRICKS * BLOCK_BRICKS));
    const bz = Math.floor(bi / BLOCK_BRICKS) % BLOCK_BRICKS;
    const by = bi % BLOCK_BRICKS;
    const quick = (v: WalkBlockView | null): number => (v === null ? -1 : v.flag !== OCCUPANCY.mixed ? v.flag : v.brick(bi));
    // Both empty there (or both solid through), or nothing stops light on either side (a block not held, or an empty
    // brick: a block taken out over open air): nothing differs inside the brick.
    const qa = quick(before);
    const qb = quick(after);
    if (qa === qb && qa !== OCCUPANCY.mixed) continue;
    if (qa <= OCCUPANCY.empty && qb <= OCCUPANCY.empty) continue;
    if ((qa <= OCCUPANCY.empty && qb === OCCUPANCY.mixed) || (qb <= OCCUPANCY.empty && qa === OCCUPANCY.mixed)) {
      out.push(bi);
      continue;
    }
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

/** Bricks from brick `b` to the box lo … hi (inclusive): the largest of the axes' gaps, 0 inside. */
export function volumeBoxGap(b: readonly number[], lo: readonly number[], hi: readonly number[]): number {
  let d = 0;
  for (let a = 0; a < 3; a++) {
    const g = b[a]! < lo[a]! ? lo[a]! - b[a]! : b[a]! > hi[a]! ? b[a]! - hi[a]! : 0;
    if (g > d) d = g;
  }
  return d;
}

/**
 * A kept brick's updates after a change to the bricks lo … hi (inclusive, world bricks) that rays of `reachBricks`
 * can reach: from nothing within {@link VOLUME_MARK_NEAR_BRICKS} of them, at most half of `settle` within the reach,
 * null (untouched) past it. The distance is the largest of the axes' gaps (a ray's reach along any axis).
 */
export function volumeMarkedUpdates(b: readonly number[], lo: readonly number[], hi: readonly number[], updates: number, reachBricks: number, settle: number, nearBricks = VOLUME_MARK_NEAR_BRICKS): number | null {
  const d = volumeBoxGap(b, lo, hi);
  if (d > reachBricks) return null;
  return d <= nearBricks ? 0 : Math.min(updates, settle >> 1);
}

/** A kept brick as marking reads and writes it. */
export interface VolumeMarkable {
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly level: number;
  updates: number;
}

/**
 * The bricks a ray from which can reach any of the level-0 boxes lo … hi (inclusive, world bricks) marked stale:
 * {@link volumeMarkedUpdates} for each box in turn, in one pass. A brick takes what its nearest box gives (from
 * nothing beats half, half beats untouched: the order of the boxes changes nothing), and is listed where the first
 * box that reaches it would have listed it. `reach`: each level's reach in its own bricks; a coarse brick is measured
 * in its own bricks (the boxes scaled to its level; near: the next brick). Returns the bricks marked, in that order.
 */
export function volumeMarkBoxes<B extends VolumeMarkable>(bricks: Iterable<B>, list: ReadonlyArray<readonly [readonly number[], readonly number[]]>, reach: readonly number[], settle: number): B[] {
  const at = [0, 0, 0];
  // Each level's boxes in its own bricks, flat (lo x y z, hi x y z): a brick is held against every box.
  const levels = reach.map((r, l) => {
    const flat = new Int32Array(list.length * 6);
    list.forEach(([lo, hi], i) => {
      for (let a = 0; a < 3; a++) {
        flat[i * 6 + a] = Math.floor(lo[a]! / (1 << l));
        flat[i * 6 + 3 + a] = Math.floor(hi[a]! / (1 << l));
      }
    });
    return { reach: r, near: l === 0 ? VOLUME_MARK_NEAR_BRICKS : 1, flat };
  });
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const marked: Array<readonly [number, B]> = [];
  for (const b of bricks) {
    const { flat, reach: r, near } = levels[b.level]!;
    const x = b.bx;
    const y = b.by;
    const z = b.bz;
    let first = -1;
    let nearest = -1;
    let best = Infinity;
    for (let o = 0; o < flat.length; o += 6) {
      const gx = x < flat[o]! ? flat[o]! - x : x > flat[o + 3]! ? x - flat[o + 3]! : 0;
      if (gx > r) continue;
      const gy = y < flat[o + 1]! ? flat[o + 1]! - y : y > flat[o + 4]! ? y - flat[o + 4]! : 0;
      if (gy > r) continue;
      const gz = z < flat[o + 2]! ? flat[o + 2]! - z : z > flat[o + 5]! ? z - flat[o + 5]! : 0;
      if (gz > r) continue;
      const d = Math.max(gx, gy, gz);
      if (first < 0) first = o / 6;
      if (d < best) {
        best = d;
        nearest = o;
        // Near: from nothing whatever comes after, and the first box is found.
        if (d <= near) break;
      }
    }
    if (first < 0) continue;
    at[0] = x;
    at[1] = y;
    at[2] = z;
    for (let a = 0; a < 3; a++) {
      lo[a] = flat[nearest + a]!;
      hi[a] = flat[nearest + 3 + a]!;
    }
    const u = volumeMarkedUpdates(at, lo, hi, b.updates, r, settle, b.level === 0 ? undefined : 1);
    if (u === null) continue;
    b.updates = u;
    marked.push([first, b]);
  }
  // A stable sort: within a box's bricks, the order they were walked in.
  marked.sort((p, q) => p[0] - q[0]);
  return marked.map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------------------------------
// The lamps a brick lists

/**
 * f32 words a lamp takes in the volume's lamp table, as five vec4s: place and reach; colour × intensity and decay; a
 * spot's axis or an area light's facing, and its kind field (the clustered lights' record: kind in the low two bits,
 * its flags above); an area light's first half side and a spot's cos of its outer half-angle; its second half side and
 * the cos of the inner one. One description of a lamp with the clustered lights (`ClusterLights`): the update lights a
 * spot within its cone and an area light by its shape from these words.
 */
export const VOLUME_LAMP_FLOATS = 20;
/** vec4s a lamp takes. */
export const VOLUME_LAMP_VEC4S = VOLUME_LAMP_FLOATS / 4;

/**
 * Lamps a brick's list holds at most (a level-0 brick's, or a coarse one's: a hit whose level-0 brick holds no slot,
 * past the level-0 window, is lit by the finest coarse brick holding it that has one). A brick reached by more keeps those that give it the most light
 * ({@link volumeLampStrength}); the rest are counted (bricks over, lamps dropped), never dropped silently. Sized by
 * measurement on the town with many lamps (the phase plan's results); a tier setting when the volume is tuned.
 */
export const VOLUME_LAMP_LIST_ENTRIES = 16;
/** u32 words a slot's list takes: the lamps listed, the lamps that reach the brick (listed or not), the entries. */
export const VOLUME_LAMP_LIST_WORDS = VOLUME_LAMP_LIST_ENTRIES + 2;
/** Metres a level-0 brick spans. */
export const VOLUME_BRICK_M = VOLUME_BRICK_CELLS * VOXEL_SIZE_M;

/** The squared distance from `p` to brick (bx, by, bz) of `level`'s box (0 inside it). */
export function volumeLampBrickGap2(px: number, py: number, pz: number, bx: number, by: number, bz: number, level = 0): number {
  const m = VOLUME_BRICK_M * 2 ** level;
  const g = (v: number, b: number): number => {
    const lo = b * m;
    const hi = lo + m;
    return v < lo ? lo - v : v > hi ? v - hi : 0;
  };
  const x = g(px, bx);
  const y = g(py, by);
  const z = g(pz, bz);
  return x * x + y * y + z * z;
}

/** Whether lamp `i` of a lamp table reaches brick (bx, by, bz) of `level`: its reach sphere meets the brick's box (strictly). */
export function volumeLampReaches(lamps: ArrayLike<number>, i: number, bx: number, by: number, bz: number, level = 0): boolean {
  const o = i * VOLUME_LAMP_FLOATS;
  const r = lamps[o + 3]!;
  return volumeLampBrickGap2(lamps[o]!, lamps[o + 1]!, lamps[o + 2]!, bx, by, bz, level) < r * r;
}

/**
 * How much light lamp `i` gives brick (bx, by, bz), the rule an overflowing list keeps lamps by: its brightest channel
 * times its falloff (the update's: 1 / d^decay, floored at 0.01, smoothed to 0 at the reach) at the brick's nearest
 * point to it (d at least 0.1 m: a lamp inside the brick counts as one 0.1 m off). The update's WGSL `lamp_strength`.
 */
export function volumeLampStrength(lamps: ArrayLike<number>, i: number, bx: number, by: number, bz: number, level = 0): number {
  const o = i * VOLUME_LAMP_FLOATS;
  const r = lamps[o + 3]!;
  const d = Math.sqrt(volumeLampBrickGap2(lamps[o]!, lamps[o + 1]!, lamps[o + 2]!, bx, by, bz, level));
  const t = d / r;
  const w = Math.min(Math.max(1 - t * t * t * t, 0), 1);
  return (Math.max(lamps[o + 4]!, lamps[o + 5]!, lamps[o + 6]!) * w * w) / Math.max(Math.max(d, 0.1) ** lamps[o + 7]!, 0.01);
}

/** A brick's lamp list: the lamps listed (table indices, ascending) and how many reach it (listed or not). */
export interface VolumeBrickLamps {
  readonly listed: number[];
  readonly total: number;
}

/**
 * The lamps brick (bx, by, bz) of `level` lists, the CPU reference of the list build (`VOLUME_LAMP_LIST_WGSL`): every lamp
 * of the table (`count` lamps) whose reach meets the brick's box; past `entries` of them, the `entries` strongest
 * ({@link volumeLampStrength}; equal strengths: the lower index), listed by index.
 */
export function volumeBrickLamps(lamps: ArrayLike<number>, count: number, bx: number, by: number, bz: number, entries = VOLUME_LAMP_LIST_ENTRIES, level = 0): VolumeBrickLamps {
  const hit: number[] = [];
  for (let i = 0; i < count; i++) if (volumeLampReaches(lamps, i, bx, by, bz, level)) hit.push(i);
  if (hit.length <= entries) return { listed: hit, total: hit.length };
  const ranked = hit.map((i) => [i, volumeLampStrength(lamps, i, bx, by, bz, level)] as const);
  ranked.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return { listed: ranked.slice(0, entries).map((s) => s[0]).sort((a, b) => a - b), total: hit.length };
}

/** The level-0 bricks a lamp's reach sphere can meet (inclusive, a box of them; those in it are tested one by one). */
export function volumeLampBrickBox(lamps: ArrayLike<number>, i: number): [number[], number[]] {
  const o = i * VOLUME_LAMP_FLOATS;
  const r = lamps[o + 3]!;
  return [[0, 1, 2].map((a) => Math.floor((lamps[o + a]! - r) / VOLUME_BRICK_M)), [0, 1, 2].map((a) => Math.floor((lamps[o + a]! + r) / VOLUME_BRICK_M))];
}

/**
 * The brick whose lamp list lights a ray's hit, the CPU reference of the update's WGSL `lamp_list_at`: of the open
 * level-0 cell (x, y, z) in front of the hit, the level-0 brick holding it when it lies in that level's window and has a
 * list (`listed(level, bx, by, bz)`: kept, with a slot), else the finest coarse level's brick holding it that does;
 * null when none does (the hit loops over the whole lamp table). `origins`: each level's window corner brick.
 */
export function volumeLampListBrick(x: number, y: number, z: number, origins: readonly (readonly number[])[], listed: (level: number, bx: number, by: number, bz: number) => boolean): [number, number, number, number] | null {
  for (let level = 0; level < VOLUME_LEVELS; level++) {
    const sh = VOLUME_BRICK_SHIFT + level;
    const b = [x >> sh, y >> sh, z >> sh];
    const o = origins[level]!;
    const d = VOLUME_LEVEL_WINDOWS[level]!;
    if (b.some((v, a) => v < o[a]! || v >= o[a]! + d[a]!)) continue;
    if (listed(level, b[0]!, b[1]!, b[2]!)) return [level, b[0]!, b[1]!, b[2]!];
  }
  return null;
}
