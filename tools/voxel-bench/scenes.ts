/**
 * Small hand-placed test scenes shared by the derive tests and the slice
 * world: engine-owned test data, written cell by cell.
 */
import { mulberry32 } from '@thirdlight/shared';
import { type PaletteStore, SHAPE_FULL, VOXEL_ROLE } from '@thirdlight/voxel';
import { MAT } from './world-kit';

const C = VOXEL_ROLE;

/** Writes one voxel (air when the material is 0). */
export function putVoxel(store: PaletteStore, x: number, y: number, z: number, material: number, role: number, shape = SHAPE_FULL, wetness = 0): void {
  store.setVoxel(x, y, z, { material, role, shape: material === 0 ? 0 : shape, wetness });
}

/** Flat full ground below y = top over [x0, x1) × [z0, z1). */
export function flatGround(store: PaletteStore, x0: number, x1: number, z0: number, z1: number, depth = 3, top = 0): void {
  for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) for (let y = top - depth; y < top; y++) putVoxel(store, x, y, z, MAT.grass, C.terrain);
}

/** Half extent (cells) of the wall-beam-banister scene's ground pad around its origin. */
export const WALL_BEAM_BANISTER_HALF = 12;

/**
 * Around (ox, oy, oz), on a pad of ground 3 cells deep below oy: a wall
 * along x at z = oz (8 tall) with a beam one cell out at z = oz − 1,
 * y = oy + 5, and a floor slab at z oz+4…oz+7 with a banister along its
 * far edge (posts at y = oy + 1 on even x, a rail at y = oy + 2). Centred
 * on a chunk corner, it crosses chunk boundaries in x and z.
 */
export function placeWallBeamBanister(s: PaletteStore, ox = 0, oy = 0, oz = 0): void {
  const h = WALL_BEAM_BANISTER_HALF;
  flatGround(s, ox - h, ox + h, oz - h, oz + h, 3, oy);
  for (let x = -6; x < 6; x++) for (let y = 0; y < 8; y++) putVoxel(s, ox + x, oy + y, oz, MAT.stone, C.wall);
  for (let x = -6; x < 6; x++) putVoxel(s, ox + x, oy + 5, oz - 1, MAT.timber, C.wall);
  for (let x = -4; x < 4; x++) for (let z = 4; z < 8; z++) putVoxel(s, ox + x, oy, oz + z, MAT.plank, C.wall);
  for (let x = -4; x < 4; x++) {
    if ((x & 1) === 0) putVoxel(s, ox + x, oy + 1, oz + 7, MAT.timber, C.wall);
    putVoxel(s, ox + x, oy + 2, oz + 7, MAT.timber, C.wall);
  }
}

/**
 * A random arrangement in the cube [−half, half)³ for checking assembly
 * rules: ground below y = 0 with pits, then walls, slabs, thin rails and
 * posts, roofs and liquid pools of random sizes, then single cells dug and
 * set, so every case the rules tell apart (beams, rails, posts, walls,
 * open cells) meets every other across chunk faces. Same seed, same cells.
 */
export function randomAssemblyWorld(s: PaletteStore, seed: number, half: number): void {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const box = (x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, m: number, c: number): void => {
    for (let x = x0; x < x0 + sx; x++) for (let z = z0; z < z0 + sz; z++) for (let y = y0; y < y0 + sy; y++) {
      if (x >= -half && x < half && y >= -half && y < half && z >= -half && z < half) putVoxel(s, x, y, z, m, c);
    }
  };
  box(-half, -half, -half, 2 * half, half, 2 * half, MAT.grass, C.terrain);
  const kinds = [
    () => box(int(-half, half), int(-4, 4), int(-half, half), int(1, 12), int(3, 10), 1, MAT.stone, C.wall),
    () => box(int(-half, half), int(-4, 4), int(-half, half), 1, int(3, 10), int(1, 12), MAT.stone, C.wall),
    () => box(int(-half, half), int(0, 8), int(-half, half), int(2, 10), 1, int(2, 10), MAT.plank, C.wall),
    () => box(int(-half, half), int(0, 6), int(-half, half), int(2, 12), 1, 1, MAT.plank, C.wall),
    () => box(int(-half, half), int(0, 6), int(-half, half), 1, 1, int(2, 12), MAT.plank, C.wall),
    () => box(int(-half, half), int(0, 4), int(-half, half), 1, int(1, 3), 1, MAT.plank, C.wall),
    () => box(int(-half, half), int(6, 12), int(-half, half), int(2, 8), 1, int(2, 8), MAT.plaster, C.roof),
    () => box(int(-half, half), int(-3, 0), int(-half, half), int(2, 6), int(1, 2), int(2, 6), MAT.water, C.liquid),
    () => box(int(-half, half), int(-6, -1), int(-half, half), int(1, 5), int(1, 5), int(1, 5), 0, C.air),
  ];
  for (let k = 0; k < 6 * half; k++) kinds[int(0, kinds.length - 1)]!();
  for (let k = 0; k < 20 * half; k++) {
    const air = rnd() < 0.5;
    putVoxel(s, int(-half, half - 1), int(-4, 10), int(-half, half - 1), air ? 0 : MAT.stone, air ? C.air : C.wall);
  }
}

/**
 * Dabs 400 single cells of the detail roles the random worlds do not write
 * (floor, roof, foundation, stair, pillar, opening) into the cube
 * [−24, 24) × [−4, 16) × [−24, 24), in two materials, so the case pass
 * meets every role there. Same seed, same cells.
 */
export function dabDetailRoles(s: PaletteStore, seed: number): void {
  let k = seed * 7919;
  const roles = [C.floor, C.roof, C.foundation, C.stair, C.pillar, C.opening];
  for (let j = 0; j < 400; j++) {
    k = (k * 1103515245 + 12345) >>> 0;
    putVoxel(s, (k % 48) - 24, ((k >> 8) % 20) - 4, ((k >> 16) % 48) - 24, MAT.stone + (j & 1), roles[j % roles.length]!);
  }
}

/**
 * Random terrain in the cube [−half, half)³ for checking the terrain rules:
 * ground on 4 × 4-cell blocks of random heights (cliffs, terrace risers and
 * flat treads between them), each block tilted at a random gentle to steep
 * slope with its top cells partly filled, then ledges, one-cell walls and
 * spikes of ground, caves dug into it, and walls and pools on it, so every
 * ground feature meets every other across chunk faces. Same seed, same cells.
 */
export function randomTerrainWorld(s: PaletteStore, seed: number, half: number): void {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const inside = (x: number, y: number, z: number): boolean => x >= -half && x < half && y >= -half && y < half && z >= -half && z < half;
  const blocks = Math.ceil((2 * half) / 4);
  const heights: number[] = [];
  const tilts: Array<[number, number]> = [];
  for (let k = 0; k < blocks * blocks; k++) {
    heights.push(int(-6, 6));
    const steep = rnd() < 0.3;
    tilts.push([(rnd() - 0.5) * (steep ? 2.4 : 0.4), (rnd() - 0.5) * (steep ? 2.4 : 0.4)]);
  }
  for (let x = -half; x < half; x++) for (let z = -half; z < half; z++) {
    const b = Math.floor((x + half) / 4) * blocks + Math.floor((z + half) / 4);
    const [tx, tz] = tilts[b]!;
    const h = heights[b]! + tx * (((x + half) % 4) - 1.5) + tz * (((z + half) % 4) - 1.5);
    for (let y = -half; y < Math.min(half, Math.ceil(h)); y++) {
      const f = Math.min(1, h - y);
      putVoxel(s, x, y, z, MAT.grass, C.terrain, Math.max(1, Math.round(f * SHAPE_FULL)));
    }
  }
  const box = (x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, m: number, c: number): void => {
    for (let x = x0; x < x0 + sx; x++) for (let z = z0; z < z0 + sz; z++) for (let y = y0; y < y0 + sy; y++) if (inside(x, y, z)) putVoxel(s, x, y, z, m, c);
  };
  const kinds = [
    () => box(int(-half, half), int(0, 10), int(-half, half), int(3, 12), int(1, 4), int(3, 12), MAT.soil, C.terrain),
    () => box(int(-half, half), int(-4, 4), int(-half, half), 1, int(3, 10), int(2, 12), MAT.rock, C.terrain),
    () => box(int(-half, half), int(-4, 4), int(-half, half), int(2, 12), int(3, 10), 1, MAT.rock, C.terrain),
    () => box(int(-half, half), int(-4, 6), int(-half, half), 1, int(2, 8), 1, MAT.rock, C.terrain),
    () => box(int(-half, half), int(-10, -2), int(-half, half), int(3, 10), int(2, 5), int(3, 10), 0, C.air),
    () => box(int(-half, half), int(-2, 6), int(-half, half), int(1, 8), int(2, 6), 1, MAT.stone, C.wall),
    () => box(int(-half, half), int(-3, 2), int(-half, half), int(2, 6), 1, int(2, 6), MAT.water, C.liquid),
  ];
  for (let k = 0; k < 2 * half; k++) kinds[int(0, kinds.length - 1)]!();
  for (let k = 0; k < 10 * half; k++) {
    const air = rnd() < 0.5;
    putVoxel(s, int(-half, half - 1), int(-8, 8), int(-half, half - 1), air ? 0 : MAT.soil, air ? C.air : C.terrain, air ? 0 : int(1, SHAPE_FULL));
  }
}
