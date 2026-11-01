import { describe, expect, it } from 'vitest';
import {
  CHUNK_EDGES,
  VOXEL_SIZE_M,
  WORLD_CELL_MAX_XZ,
  WORLD_CELL_MAX_Y,
  WORLD_CELL_MIN_XZ,
  WORLD_CELL_MIN_Y,
  cellInWorld,
  chunkGrid,
  chunkKey,
  chunkKeyOrNone,
  chunkOf,
  chunkOfKey,
  chunkOrigin,
  chunksPerRegionSide,
  localIndex,
  localOf,
  regionKey,
  regionOfCell,
  regionOfChunk,
  regionOfKey,
} from './index';

describe('world bounds', () => {
  it('hold a 10 km world centred or cornered on the origin, and 2 km of height anywhere around y = 0', () => {
    const tenKm = 10_000 / VOXEL_SIZE_M;
    expect(WORLD_CELL_MIN_XZ).toBeLessThanOrEqual(-tenKm / 2);
    expect(WORLD_CELL_MAX_XZ).toBeGreaterThanOrEqual(tenKm);
    const twoKm = 2_000 / VOXEL_SIZE_M;
    expect(WORLD_CELL_MIN_Y).toBeLessThanOrEqual(-twoKm);
    expect(WORLD_CELL_MAX_Y).toBeGreaterThanOrEqual(twoKm);
    expect(cellInWorld(WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y, WORLD_CELL_MAX_XZ)).toBe(true);
    expect(cellInWorld(WORLD_CELL_MAX_XZ + 1, 0, 0)).toBe(false);
    expect(cellInWorld(0, WORLD_CELL_MIN_Y - 1, 0)).toBe(false);
    expect(cellInWorld(0.5, 0, 0)).toBe(false);
  });
});

describe.each(CHUNK_EDGES)('chunk math with %i-cell chunks', (edge) => {
  const grid = chunkGrid(edge);

  it('splits negative and positive cells into chunk and local parts that rebuild the cell', () => {
    for (const cell of [WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y, -edge - 1, -edge, -1, 0, 1, edge - 1, edge, WORLD_CELL_MAX_Y, WORLD_CELL_MAX_XZ, 20_000, -10_000]) {
      const c = chunkOf(grid, cell);
      const l = localOf(grid, cell);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThan(edge);
      expect(chunkOrigin(grid, c) + l).toBe(cell);
    }
    expect(chunkOf(grid, -1)).toBe(-1);
    expect(localOf(grid, -1)).toBe(edge - 1);
  });

  it('round-trips keys at every corner of the world, and keys are unique and below 2^35', () => {
    const xs = [chunkOf(grid, WORLD_CELL_MIN_XZ), -1, 0, chunkOf(grid, 20_000), chunkOf(grid, WORLD_CELL_MAX_XZ)];
    const ys = [chunkOf(grid, WORLD_CELL_MIN_Y), chunkOf(grid, -4000), -1, 0, chunkOf(grid, 4000), chunkOf(grid, WORLD_CELL_MAX_Y)];
    const seen = new Set<number>();
    for (const cx of xs) for (const cz of xs) for (const cy of ys) {
      const key = chunkKey(grid, cx, cy, cz);
      expect(Number.isSafeInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThan(2 ** 35);
      expect(chunkKeyOrNone(grid, cx, cy, cz)).toBe(key);
      expect(chunkOfKey(grid, key)).toEqual({ cx, cy, cz });
      seen.add(key);
    }
    expect(seen.size).toBe(xs.length * xs.length * ys.length);
  });

  it('orders keys x, then z, then y: one column is consecutive', () => {
    const k = chunkKey(grid, 3, -2, -7);
    expect(chunkKey(grid, 3, -1, -7)).toBe(k + 1);
    expect(chunkKey(grid, 3, -2, -6)).toBe(k + grid.chunkSpanY);
  });

  it('refuses chunks outside the world (the per-cell path answers −1)', () => {
    const top = chunkOf(grid, WORLD_CELL_MAX_Y) + 1;
    expect(() => chunkKey(grid, 0, top, 0)).toThrow(RangeError);
    expect(() => chunkKey(grid, chunkOf(grid, WORLD_CELL_MIN_XZ) - 1, 0, 0)).toThrow(RangeError);
    expect(() => chunkKey(grid, 0.5, 0, 0)).toThrow(RangeError);
    expect(chunkKeyOrNone(grid, 0, top, 0)).toBe(-1);
    expect(() => chunkOfKey(grid, -1)).toThrow(RangeError);
  });

  it('gives every cell of a chunk its own index, with y running fastest', () => {
    const seen = new Uint8Array(grid.cellsPerChunk);
    for (let x = 0; x < edge; x++) for (let z = 0; z < edge; z++) for (let y = 0; y < edge; y++) seen[localIndex(grid, x, y, z)]! += 1;
    expect(seen.every((n) => n === 1)).toBe(true);
    expect(localIndex(grid, 0, 1, 0)).toBe(1);
    expect(localIndex(grid, 0, 0, 1)).toBe(edge);
  });

  it('places chunks in 256 m and 512 m regions, negative ones too', () => {
    for (const footprint of [512, 1024] as const) {
      const side = chunksPerRegionSide(grid, footprint);
      expect(side * edge).toBe(footprint);
      for (const cell of [WORLD_CELL_MIN_XZ, -footprint - 1, -1, 0, footprint, 19_999, WORLD_CELL_MAX_XZ]) {
        expect(regionOfChunk(grid, footprint, chunkOf(grid, cell))).toBe(regionOfCell(footprint, cell));
      }
      expect(regionOfCell(footprint, -1)).toBe(-1);
      const lo = regionOfCell(footprint, WORLD_CELL_MIN_XZ);
      const hi = regionOfCell(footprint, WORLD_CELL_MAX_XZ);
      for (const [rx, rz] of [[lo, lo], [lo, hi], [-1, 0], [hi, hi]] as const) {
        expect(regionOfKey(footprint, regionKey(footprint, rx, rz))).toEqual({ rx, rz });
      }
      expect(() => regionKey(footprint, hi + 1, 0)).toThrow(RangeError);
    }
  });
});
