/**
 * Small hand-placed test scenes shared by the derive tests and the slice
 * world: engine-owned test data, written cell by cell.
 */
import { VOXEL_CATEGORY, type PaletteStore } from '@thirdlight/voxel';
import { MAT } from './world-kit';

const C = VOXEL_CATEGORY;

/** Writes one voxel (air when the material is 0). */
export function putVoxel(store: PaletteStore, x: number, y: number, z: number, material: number, category: number, shape = 255, orientation = 0): void {
  store.setVoxel(x, y, z, { material, category, shape: material === 0 ? 0 : shape, orientation });
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
  for (let x = -6; x < 6; x++) for (let y = 0; y < 8; y++) putVoxel(s, ox + x, oy + y, oz, MAT.stone, C.construction);
  for (let x = -6; x < 6; x++) putVoxel(s, ox + x, oy + 5, oz - 1, MAT.timber, C.construction);
  for (let x = -4; x < 4; x++) for (let z = 4; z < 8; z++) putVoxel(s, ox + x, oy, oz + z, MAT.plank, C.construction);
  for (let x = -4; x < 4; x++) {
    if ((x & 1) === 0) putVoxel(s, ox + x, oy + 1, oz + 7, MAT.timber, C.construction);
    putVoxel(s, ox + x, oy + 2, oz + 7, MAT.timber, C.construction);
  }
}
