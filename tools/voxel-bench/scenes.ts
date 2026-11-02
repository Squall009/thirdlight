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
