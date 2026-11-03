/**
 * The thin slice's test world: a hilly area (the bench's hilly generator,
 * a square centred on the origin) with the wall-beam-banister scene on a
 * pad levelled into it at a chunk corner, written as a project's voxel
 * world (region files + manifest). Engine-owned test data, deterministic:
 * the same options always give the same files.
 */
import { join } from 'node:path';
import { chunkGrid, chunkOfKey, createDenseChunk, createWorldStore, VOXEL_ROLE, voxel, type PaletteStore } from '@thirdlight/voxel';
import { VOXEL_WORLDS_FOLDER, writeVoxelWorld } from '@thirdlight/workspace';
import { loadArea } from './regions';
import { placeWallBeamBanister, putVoxel, WALL_BEAM_BANISTER_HALF } from './scenes';
import { TEST_WORLD_ID } from './stream-node';
import { MAT } from './world-kit';
import { townWorld } from './town';
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

/** The same world moved by whole chunks on x and z (`chunks`: chunks to add to each chunk coordinate). */
export function shiftSliceWorld(w: SliceWorld, chunks: { readonly x: number; readonly z: number }): SliceWorld {
  const store = createWorldStore(grid);
  const cells = createDenseChunk(grid);
  const at = { cx: 0, cy: 0, cz: 0 };
  for (const key of w.store.chunkKeys()) {
    chunkOfKey(grid, key, at);
    if (w.store.exportChunk(at.cx, at.cy, at.cz, cells)) store.importChunk(at.cx + chunks.x, at.cy, at.cz + chunks.z, cells);
  }
  return { store, scene: [w.scene[0] + chunks.x * grid.edge, w.scene[1], w.scene[2] + chunks.z * grid.edge] };
}

/**
 * Writes the slice world into a project folder (`voxels/<name>/`); refuses a folder that already holds one.
 * `shiftChunks` moves it by whole chunks on x and z (a world far from the origin).
 */
export function writeSliceWorld(projectDir: string, name = SLICE_WORLD_NAME, footprint = SLICE_FOOTPRINT, shiftChunks?: { readonly x: number; readonly z: number }): SliceWorld & { dir: string; files: number } {
  const built = buildSliceWorld(footprint);
  const w = shiftChunks === undefined ? built : shiftSliceWorld(built, shiftChunks);
  const dir = join(projectDir, VOXEL_WORLDS_FOLDER, name);
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { files } = writeVoxelWorld(dir, { worldId: hex, edge: 32, layout: 'stacked', footprint: 512 }, w.store);
  return { ...w, dir, files };
}

/** The town test world's footprint here (cells a side: 256 m, the bench's town). */
export const TOWN_FOOTPRINT = 512;

/**
 * Writes the bench's dense town (houses with walls, floors, roofs, beams,
 * banisters and fences on flat ground at y 0, 0 … 512 cells on x and z)
 * as a project's voxel world, for measuring edits among buildings in the
 * page; the scene is the town's middle.
 */
export function writeTownWorld(projectDir: string, name = 'town'): SliceWorld & { dir: string; files: number } {
  const store = createWorldStore(grid);
  const world = townWorld({ footprint: TOWN_FOOTPRINT });
  loadArea(world.grids[0]!, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
  const dir = join(projectDir, VOXEL_WORLDS_FOLDER, name);
  const hex = [...TEST_WORLD_ID].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { files } = writeVoxelWorld(dir, { worldId: hex, edge: 32, layout: 'stacked', footprint: 512 }, store);
  return { store, scene: [TOWN_FOOTPRINT / 2, 0, TOWN_FOOTPRINT / 2], dir, files };
}
