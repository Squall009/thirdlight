/**
 * The thin slice's test world: a hilly area (the bench's hilly generator,
 * a square centred on the origin) with the wall-beam-banister scene on a
 * pad levelled into it at a chunk corner, written as a project's voxel
 * world (region files + manifest). Engine-owned test data, deterministic:
 * the same options always give the same files.
 */
import { join } from 'node:path';
import { chunkGrid, createWorldStore, VOXEL_ROLE, voxel, type PaletteStore } from '@thirdlight/voxel';
import { VOXEL_WORLDS_FOLDER, writeVoxelWorld } from '@thirdlight/workspace';
import { loadArea } from './regions';
import { placeWallBeamBanister, putVoxel, WALL_BEAM_BANISTER_HALF } from './scenes';
import { TEST_WORLD_ID } from './stream-node';
import { MAT } from './world-kit';
import { hillyWorld } from './worlds';

/** The world's folder name in the project. */
export const SLICE_WORLD_NAME = 'slice';
/** Cells a side (512 m). */
export const SLICE_FOOTPRINT = 1024;
/** Cells kept clear above the pad (the scene is 8 tall; hills around it may rise higher). */
const PAD_CLEAR = 24;
/** The hilly world's lake level (cells): the pad stays above it. */
const LAKE_TOP = 26;

export interface SliceWorld {
  readonly store: PaletteStore;
  /** The scene's origin (cells): the chunk corner the wall, beam and banister stand around. */
  readonly scene: readonly [number, number, number];
}

const grid = chunkGrid(32);

function surfaceAt(store: PaletteStore, x: number, z: number): number {
  const v = voxel();
  for (let y = 300; y > -128; y--) {
    store.voxelAt(x, y, z, v);
    if (v.material !== 0 && v.role === VOXEL_ROLE.terrain) return y + 1;
  }
  return -128;
}

/** Builds the world in memory: the hilly square, then the scene at the flattest chunk corner near the middle that is above the lakes. */
export function buildSliceWorld(footprint = SLICE_FOOTPRINT): SliceWorld {
  const store = createWorldStore(grid);
  const world = hillyWorld({ footprint });
  loadArea(world.grids[0]!, store, -footprint / 2, -footprint / 2, footprint / 2, footprint / 2);
  const h = WALL_BEAM_BANISTER_HALF;
  let best: { x: number; z: number; y: number; spread: number } | null = null;
  for (let x = -256; x <= 256; x += 32) {
    for (let z = -256; z <= 256; z += 32) {
      const ys = [surfaceAt(store, x - h, z - h), surfaceAt(store, x + h, z - h), surfaceAt(store, x - h, z + h), surfaceAt(store, x + h, z + h), surfaceAt(store, x, z)];
      const lo = Math.min(...ys);
      if (lo < LAKE_TOP) continue;
      const spread = Math.max(...ys) - lo + (Math.abs(x) + Math.abs(z)) / 64;
      if (best === null || spread < best.spread) best = { x, z, y: Math.round(ys.reduce((a, b) => a + b, 0) / ys.length), spread };
    }
  }
  if (best === null) throw new Error('no chunk corner above the lakes');
  // Level the pad: air above it, full ground under it down to the hill below.
  for (let x = best.x - h; x < best.x + h; x++) {
    for (let z = best.z - h; z < best.z + h; z++) {
      for (let y = best.y; y < best.y + PAD_CLEAR; y++) putVoxel(store, x, y, z, 0, 0);
      for (let y = surfaceAt(store, x, z); y < best.y; y++) putVoxel(store, x, y, z, MAT.soil, VOXEL_ROLE.terrain);
    }
  }
  placeWallBeamBanister(store, best.x, best.y, best.z);
  return { store, scene: [best.x, best.y, best.z] };
}

/** Writes the slice world into a project folder (`voxels/<name>/`); refuses a folder that already holds one. */
export function writeSliceWorld(projectDir: string, name = SLICE_WORLD_NAME, footprint = SLICE_FOOTPRINT): SliceWorld & { dir: string; files: number } {
  const w = buildSliceWorld(footprint);
  const dir = join(projectDir, VOXEL_WORLDS_FOLDER, name);
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { files } = writeVoxelWorld(dir, { worldId: hex, edge: 32, layout: 'stacked', footprint: 512 }, w.store);
  return { ...w, dir, files };
}
