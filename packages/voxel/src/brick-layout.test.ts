import { crc32, mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import {
  BRICK_CELLS,
  BrickLayout,
  PaletteStore,
  VOXEL_CATEGORY,
  brickOrder,
  bricksPerChunk,
  chunkGrid,
  createDenseChunk,
  localIndex,
  readMeasuredHeader,
  readPaletteHeader,
  sameDenseChunk,
  voxel,
  type ChunkEdge,
  type PaletteStoreOptions,
} from './index';

const BRICKS: PaletteStoreOptions = { name: 'bricks', palette: 'record', layout: 'bricks', atRest: 'bricks' };

/** Ids of a ground-like chunk: entry 0 above a wavy surface, 1 below it, 2 in a few scattered cells. */
function groundIds(edge: ChunkEdge, seed: number): Uint16Array {
  const grid = chunkGrid(edge);
  const ids = new Uint16Array(grid.cellsPerChunk);
  const rand = mulberry32(seed);
  for (let x = 0; x < edge; x++) for (let z = 0; z < edge; z++) {
    const top = (edge >> 1) + ((x * 3 + z) % 5);
    for (let y = 0; y < edge; y++) ids[localIndex(grid, x, y, z)] = y < top ? (rand() < 0.02 ? 2 : 1) : 0;
  }
  return ids;
}

describe('the brick layout', () => {
  it.each([16, 32] as ChunkEdge[])('visits every cell once in brick order (%i³)', (edge) => {
    const grid = chunkGrid(edge);
    const order = brickOrder(grid);
    expect(new Set(order).size).toBe(grid.cellsPerChunk);
    expect(order.length).toBe(bricksPerChunk(grid) * BRICK_CELLS);
  });

  it.each([16, 32] as ChunkEdge[])('reads back every write at every width, and stores only mixed bricks (%i³)', (edge) => {
    const grid = chunkGrid(edge);
    const n = grid.cellsPerChunk;
    const rand = mulberry32(5);
    for (const width of [1, 2, 4, 8, 16]) {
      const max = 2 ** width;
      const ids = groundIds(edge, width).map((v) => v % max);
      const l = BrickLayout.from(grid, ids, max);
      expect(l.width).toBe(width);
      const mixed = l.mixedBricks;
      expect(mixed).toBeGreaterThan(0);
      expect(mixed).toBeLessThan(bricksPerChunk(grid));
      for (let k = 0; k < 3000; k++) {
        const i = Math.floor(rand() * n);
        const e = Math.floor(rand() * max);
        ids[i] = e;
        l.set(i, e);
      }
      const back = new Uint16Array(n);
      l.unpack(back);
      expect(back).toEqual(ids);
      for (let i = 0; i < n; i += 5) expect(l.get(i)).toBe(ids[i]);
    }
  });

  it('collapses a brick back to one id when an edit makes it uniform, and reuses its slot', () => {
    const grid = chunkGrid(32);
    const ids = new Uint16Array(grid.cellsPerChunk);
    const l = BrickLayout.from(grid, ids, 4);
    expect(l.mixedBricks).toBe(0);
    const bytes0 = l.bytes();
    l.set(localIndex(grid, 1, 1, 1), 3);
    expect(l.mixedBricks).toBe(1);
    const bytes1 = l.bytes();
    expect(bytes1).toBeGreaterThan(bytes0);
    l.set(localIndex(grid, 1, 1, 1), 0);
    expect(l.mixedBricks).toBe(0);
    // Another brick splits into the freed slot: no new pool memory.
    l.set(localIndex(grid, 20, 9, 30), 2);
    expect(l.mixedBricks).toBe(1);
    expect(l.bytes()).toBe(bytes1);
    // Filling a whole brick with a new id leaves it uniform (one id, no stored cells).
    const order = brickOrder(grid);
    for (let j = 0; j < BRICK_CELLS; j++) l.set(order[5 * BRICK_CELLS + j]!, 1);
    expect(l.get(order[5 * BRICK_CELLS]!)).toBe(1);
    expect(l.mixedBricks).toBe(1);
  });
});

describe('the brick body of the palette codec', () => {
  const grid = chunkGrid(16);
  const cells = createDenseChunk(grid);
  const rock = voxel(1, VOXEL_CATEGORY.terrain, 255, 0);
  // Rock below y = 6 with one soil cell and a partly full top layer: some uniform and some mixed bricks.
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
    const i = localIndex(grid, x, y, z);
    const v = y < 6 ? (x === 3 && y === 2 && z === 9 ? voxel(2, VOXEL_CATEGORY.terrain, 255, 0) : rock) : y === 6 ? voxel(1, VOXEL_CATEGORY.terrain, 100, 0) : voxel();
    cells.material[i] = v.material;
    cells.category[i] = v.category;
    cells.shape[i] = v.shape;
    cells.orientation[i] = v.orientation;
  }
  const store = new PaletteStore(grid, BRICKS);
  store.importChunk(0, 0, 0, cells);
  const good = store.encodeChunk(0, 0, 0)!;
  const decode = (b: Uint8Array): void => new PaletteStore(grid, BRICKS).decodeChunk(0, 0, 0, b);
  const withCrc = (b: Uint8Array): Uint8Array => {
    const c = crc32(b.subarray(8));
    b.set([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24], 4);
    return b;
  };

  it('round-trips, smaller than the bit-packed body for ground', () => {
    expect(readMeasuredHeader(grid, good).body).toBe('bricks');
    expect(() => readPaletteHeader(grid, good)).toThrow(/a measurement encoding/);
    const back = createDenseChunk(grid);
    const fresh = new PaletteStore(grid, BRICKS);
    fresh.decodeChunk(0, 0, 0, good);
    expect(fresh.exportChunk(0, 0, 0, back)).toBe(true);
    expect(sameDenseChunk(back, cells)).toBe(true);
    const packed = new PaletteStore(grid, { ...BRICKS, atRest: 'packed' });
    packed.importChunk(0, 0, 0, cells);
    expect(good.length).toBeLessThan(packed.encodeChunk(0, 0, 0)!.length);
  });

  it('refuses damaged and non-canonical brick bodies', () => {
    const flipped = good.slice();
    flipped[good.length - 5]! ^= 1;
    expect(() => decode(flipped)).toThrow(/checksum/);
    // Palette: count − 1 (u16), per entry material u24, category u8, orientation u8, then the flag bits; the mask follows.
    const count = good[8]! + (good[9]! << 8) + 1;
    expect(count).toBe(4);
    const maskAt = 8 + 2 + count * 5 + Math.ceil(count / 8);
    // Marking a uniform brick as mixed shifts every following id: whatever is read is then not canonical or not the length.
    const mixedMore = good.slice();
    const b = [...Array(8).keys()].find((k) => mixedMore[maskAt + k] !== 0xff)!;
    const free = [...Array(8).keys()].find((j) => ((mixedMore[maskAt + b]! >>> j) & 1) === 0)!;
    mixedMore[maskAt + b]! |= 1 << free;
    expect(() => decode(withCrc(mixedMore))).toThrow(/palette chunk bytes/);
    // A mixed brick whose 64 cells are one id is refused: overwrite the first mixed brick's cells (width 2) with id 1 everywhere.
    const forged = good.slice();
    const mixedBricks = [...Array(64).keys()].filter((k) => (forged[maskAt + (k >>> 3)]! >>> (k & 7)) & 1);
    const uniformCount = 64 - mixedBricks.length;
    const cellsAt = maskAt + 8 + Math.ceil((uniformCount * 2) / 8);
    forged.fill(0x55, cellsAt, cellsAt + 16);
    expect(() => decode(withCrc(forged))).toThrow(/mixed brick of one entry/);
  });
});
