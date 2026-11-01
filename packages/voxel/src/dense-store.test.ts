import { describe, expect, it } from 'vitest';
import {
  AIR,
  DenseReferenceStore,
  VOXEL_CATEGORY,
  WORLD_CELL_MAX_XZ,
  WORLD_CELL_MAX_Y,
  WORLD_CELL_MIN_XZ,
  WORLD_CELL_MIN_Y,
  chunkGrid,
  createDenseChunk,
  denseChunkBytes,
  localIndex,
  sameDenseChunk,
  storeChunkCoords,
  strokeCovers,
  voxel,
  type VoxelRecord,
  type VoxelStroke,
} from './index';

const rock = voxel(7, VOXEL_CATEGORY.terrain, 255, 0);
const beam = voxel(300, VOXEL_CATEGORY.construction, 255, 3);
const water = voxel(5, VOXEL_CATEGORY.liquid, 120, 0);

describe('the dense reference store', () => {
  it('reads what it wrote at the world extremes and across chunk borders, air elsewhere', () => {
    const store = new DenseReferenceStore(chunkGrid(32));
    const cells: Array<[number, number, number, VoxelRecord]> = [
      [WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y, WORLD_CELL_MIN_XZ, rock],
      [WORLD_CELL_MAX_XZ, WORLD_CELL_MAX_Y, WORLD_CELL_MAX_XZ, beam],
      [-1, -1, -1, water],
      [0, 0, 0, beam],
      [19_999, 3_999, -10_000, rock],
    ];
    for (const [x, y, z, v] of cells) store.setVoxel(x, y, z, v);
    const out = voxel();
    for (const [x, y, z, v] of cells) expect(store.voxelAt(x, y, z, out)).toEqual(v);
    expect(store.voxelAt(-1, 0, -1, out)).toEqual(AIR);
    expect(store.voxelAt(WORLD_CELL_MAX_XZ + 1, 0, 0, out)).toEqual(AIR);
    expect(() => store.setVoxel(0, WORLD_CELL_MAX_Y + 1, 0, rock)).toThrow(RangeError);
    expect(storeChunkCoords(store)).toHaveLength(5);
    expect(store.memoryBytes()).toBe(5 * denseChunkBytes(chunkGrid(32)));
  });

  it('writes exactly the cells a stroke covers, across chunk borders', () => {
    for (const edge of [16, 32] as const) {
      const store = new DenseReferenceStore(chunkGrid(edge));
      const strokes: VoxelStroke[] = [
        { kind: 'box', min: [-5, -3, 10], max: [4, 2, 20], voxel: rock },
        { kind: 'sphere', center: [0, 0, 16], radius: 4, voxel: AIR },
        { kind: 'sphere', center: [-16, 15, -1], radius: 2.5, voxel: beam },
      ];
      const expected = new Map<string, VoxelRecord>();
      for (const s of strokes) {
        const n = store.applyStroke(s);
        let covered = 0;
        for (let x = -30; x <= 30; x++) for (let y = -30; y <= 30; y++) for (let z = -30; z <= 30; z++) {
          if (strokeCovers(s, x, y, z)) {
            covered++;
            expected.set(`${x},${y},${z}`, s.voxel);
          }
        }
        expect(n).toBe(covered);
      }
      const out = voxel();
      for (let x = -30; x <= 30; x++) for (let y = -30; y <= 30; y++) for (let z = -30; z <= 30; z++) {
        expect(store.voxelAt(x, y, z, out)).toEqual(expected.get(`${x},${y},${z}`) ?? AIR);
      }
    }
  });

  it('round-trips chunks through its encoding, with planes left out decoding as zero', () => {
    const grid = chunkGrid(16);
    const store = new DenseReferenceStore(grid);
    const cells = createDenseChunk(grid);
    for (let i = 0; i < grid.cellsPerChunk; i++) {
      cells.material[i] = (i * 2654435761) % 65536;
      cells.category[i] = i % 5;
      cells.shape[i] = (i * 7) % 256;
      cells.orientation[i] = i % 24;
    }
    store.importChunk(-3, 250, 7, cells);
    const bytes = store.encodeChunk(-3, 250, 7);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(1 + grid.cellsPerChunk * 5);
    const other = new DenseReferenceStore(grid);
    other.decodeChunk(-3, 250, 7, bytes!);
    const back = createDenseChunk(grid);
    expect(other.exportChunk(-3, 250, 7, back)).toBe(true);
    expect(sameDenseChunk(back, cells)).toBe(true);

    const noOrientation = store.encodeChunk(-3, 250, 7, ['material', 'category', 'shape'])!;
    expect(noOrientation.length).toBe(1 + grid.cellsPerChunk * 4);
    other.decodeChunk(-3, 250, 7, noOrientation);
    other.exportChunk(-3, 250, 7, back);
    expect(back.orientation.every((o) => o === 0)).toBe(true);
    expect(back.material[localIndex(grid, 1, 2, 3)]).toBe(cells.material[localIndex(grid, 1, 2, 3)]);
    expect(() => other.decodeChunk(0, 0, 0, bytes!.subarray(0, 100))).toThrow(RangeError);
  });

  it('stores an all-air chunk as absent and forgets dropped chunks', () => {
    const grid = chunkGrid(32);
    const store = new DenseReferenceStore(grid);
    store.importChunk(0, 0, 0, createDenseChunk(grid));
    expect([...store.chunkKeys()]).toEqual([]);
    expect(store.encodeChunk(0, 0, 0)).toBeNull();
    store.setVoxel(1, 2, 3, rock);
    store.dropChunk(0, 0, 0);
    expect(store.voxelAt(1, 2, 3, voxel())).toEqual(AIR);
    expect(store.exportChunk(0, 0, 0, createDenseChunk(grid))).toBe(false);
  });
});
