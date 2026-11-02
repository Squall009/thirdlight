import { crc32, mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import {
  ChunkIndex,
  ColumnRuns,
  DenseReferenceStore,
  PackedIndices,
  PaletteStore,
  VOXEL_CATEGORY,
  VOXEL_PLANES,
  chunkGrid,
  chunkKey,
  createDenseChunk,
  isSurfaceVoxel,
  localIndex,
  readPaletteHeader,
  sameDenseChunk,
  sameVoxel,
  storeChunkCoords,
  voxel,
  type ChunkEdge,
  type ChunkGrid,
  type DenseChunk,
  type PaletteStoreOptions,
  type VoxelRecord,
  type VoxelStoreCandidate,
} from './index';

const VARIANTS: readonly PaletteStoreOptions[] = [
  { name: 'palette', palette: 'record', layout: 'packed', atRest: 'packed' },
  { name: 'palette-runs', palette: 'record', layout: 'runs', atRest: 'runs' },
  { name: 'palette-rest-runs', palette: 'record', layout: 'packed', atRest: 'runs' },
  { name: 'palette-planes', palette: 'planes', layout: 'packed', atRest: 'packed' },
  { name: 'bricks', palette: 'record', layout: 'bricks', atRest: 'bricks' },
  { name: 'bricks-rest-packed', palette: 'record', layout: 'bricks', atRest: 'packed' },
];

const rock = voxel(1, VOXEL_CATEGORY.terrain, 255, 0);
const soil = voxel(2, VOXEL_CATEGORY.terrain, 255, 0);
const water = voxel(5, VOXEL_CATEGORY.liquid, 255, 0);

/**
 * A chunk with what the format must keep: layered ground whose top cell is
 * partly full, liquid with a partly full top cell over it, a one-cell post
 * and rail (thin features) and an oriented stair, in a column-varying
 * pattern so palettes, runs and densities all show up.
 */
function fillMixed(grid: ChunkGrid, out: DenseChunk, seed: number): void {
  const e = grid.edge;
  const rand = mulberry32(seed);
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const surface = 3 + ((x * 7 + z * 3 + seed) % (e - 8)) + rand();
    const liquid = surface + 2.4;
    for (let y = 0; y < e; y++) {
      const i = localIndex(grid, x, y, z);
      let v: VoxelRecord = voxel();
      if (y + 1 <= surface) v = y < surface - 3 ? rock : soil;
      else if (y < surface) v = voxel(3, VOXEL_CATEGORY.terrain, Math.max(1, Math.round((surface - y) * 255)), 0);
      else if (y + 1 <= liquid && (x + z) % 5 === 0) v = water;
      else if (y < liquid && (x + z) % 5 === 0) v = voxel(5, VOXEL_CATEGORY.liquid, Math.max(1, Math.round((liquid - y) * 255)), 0);
      else if (x === 2 && z % 2 === 0 && y < e - 2) v = voxel(11, VOXEL_CATEGORY.construction, 255, 0);
      else if (x === 2 && y === e - 2) v = voxel(11, VOXEL_CATEGORY.construction, 255, 1);
      else if (x === e - 3 && y === x - z && z > 0) v = voxel(14, VOXEL_CATEGORY.construction, 255, (z & 3) + 4);
      out.material[i] = v.material;
      out.category[i] = v.category;
      out.shape[i] = v.shape;
      out.orientation[i] = v.orientation;
    }
  }
}

function fillWith(out: DenseChunk, v: VoxelRecord): void {
  out.material.fill(v.material);
  out.category.fill(v.category);
  out.shape.fill(v.shape);
  out.orientation.fill(v.orientation);
}

/** Every cell of the chunk box [c0, c1) of both stores reads the same. */
function expectSameCells(a: VoxelStoreCandidate, b: VoxelStoreCandidate, c0: number, c1: number): void {
  const g = a.grid;
  const va = voxel();
  const vb = voxel();
  let bad = 0;
  for (let x = c0 << g.shift; x < c1 << g.shift; x++) for (let z = c0 << g.shift; z < c1 << g.shift; z++) for (let y = c0 << g.shift; y < c1 << g.shift; y++) {
    if (!sameVoxel(a.voxelAt(x, y, z, va), b.voxelAt(x, y, z, vb))) bad++;
  }
  expect(bad).toBe(0);
}

describe.each(VARIANTS)('the palette store ($name)', (opts) => {
  it.each([16, 32] as ChunkEdge[])('reads, exports and round-trips through bytes exactly what the dense oracle holds (%i³)', (edge) => {
    const grid = chunkGrid(edge);
    const oracle = new DenseReferenceStore(grid);
    const store = new PaletteStore(grid, opts);
    const cells = createDenseChunk(grid);
    const chunks: Array<[number, number, number, (c: DenseChunk) => void]> = [
      [0, 0, 0, (c) => fillMixed(grid, c, 1)],
      [-1, 0, 0, (c) => fillMixed(grid, c, 2)],
      [0, -1, 0, (c) => fillWith(c, rock)],
      [0, 1, 0, (c) => fillWith(c, voxel())],
      [0, 0, -1, (c) => fillWith(c, voxel(9, VOXEL_CATEGORY.roof, 255, 200))],
    ];
    for (const [cx, cy, cz, fill] of chunks) {
      fill(cells);
      oracle.importChunk(cx, cy, cz, cells);
      store.importChunk(cx, cy, cz, cells);
    }
    expectSameCells(store, oracle, -1, 2);
    const back = createDenseChunk(grid);
    const fresh = new PaletteStore(grid, opts);
    for (const { cx, cy, cz } of storeChunkCoords(oracle)) {
      expect(oracle.exportChunk(cx, cy, cz, cells)).toBe(true);
      expect(store.exportChunk(cx, cy, cz, back)).toBe(true);
      expect(sameDenseChunk(back, cells)).toBe(true);
      const bytes = store.encodeChunk(cx, cy, cz)!;
      fresh.decodeChunk(cx, cy, cz, bytes);
      expect(fresh.exportChunk(cx, cy, cz, back)).toBe(true);
      expect(sameDenseChunk(back, cells)).toBe(true);
      // Canonical: decoding and encoding again gives the same bytes.
      expect(fresh.encodeChunk(cx, cy, cz)).toEqual(bytes);
    }
    // The all-air chunk is absent; the uniform ones cost a few bytes.
    expect([...store.chunkKeys()].sort()).toEqual([...oracle.chunkKeys()].sort());
    expect(store.encodeChunk(0, 1, 0)).toBeNull();
    expect(store.encodeChunk(0, -1, 0)).toHaveLength(13);
    expect(store.memoryBytes()).toBeLessThan(oracle.memoryBytes() / 2);
  });

  it('matches the oracle after single edits and strokes, and encodes the same bytes whatever the edit history', () => {
    const grid = chunkGrid(16);
    const oracle = new DenseReferenceStore(grid);
    const store = new PaletteStore(grid, opts);
    const cells = createDenseChunk(grid);
    fillMixed(grid, cells, 5);
    oracle.importChunk(0, 0, 0, cells);
    store.importChunk(0, 0, 0, cells);
    fillWith(cells, rock);
    oracle.importChunk(0, -1, 0, cells);
    store.importChunk(0, -1, 0, cells);
    const rand = mulberry32(11);
    const records = [rock, soil, water, voxel(), voxel(3, VOXEL_CATEGORY.terrain, 77, 0), voxel(5, VOXEL_CATEGORY.liquid, 30, 0), voxel(14, VOXEL_CATEGORY.construction, 255, 6)];
    for (let k = 0; k < 3000; k++) {
      const x = Math.floor(rand() * 40) - 12;
      const y = Math.floor(rand() * 40) - 20;
      const z = Math.floor(rand() * 40) - 12;
      const v = records[Math.floor(rand() * records.length)]!;
      oracle.setVoxel(x, y, z, v);
      store.setVoxel(x, y, z, v);
    }
    for (const [i, center] of ([[0, 0, 0], [15, 15, 15], [-3, -14, 8], [8, 2, 8]] as const).entries()) {
      const v = i % 2 === 0 ? voxel() : rock;
      expect(store.applyStroke({ kind: 'sphere', center, radius: 5, voxel: v })).toBe(oracle.applyStroke({ kind: 'sphere', center, radius: 5, voxel: v }));
    }
    store.applyStroke({ kind: 'box', min: [-16, -16, -16], max: [31, -1, 31], voxel: rock });
    oracle.applyStroke({ kind: 'box', min: [-16, -16, -16], max: [31, -1, 31], voxel: rock });
    expectSameCells(store, oracle, -2, 3);
    // A store that only imported the oracle's chunks encodes them to the same bytes as the edited store.
    const imported = new PaletteStore(grid, opts);
    for (const { cx, cy, cz } of storeChunkCoords(oracle)) {
      oracle.exportChunk(cx, cy, cz, cells);
      imported.importChunk(cx, cy, cz, cells);
      expect(store.encodeChunk(cx, cy, cz)).toEqual(imported.encodeChunk(cx, cy, cz));
    }
    // The filled box below y = 0 collapsed back to single numbers.
    for (const cy of [-1]) for (const cx of [-1, 0, 1]) {
      expect(store.encodeChunk(cx, cy, 0)).toHaveLength(13);
    }
  });
});

describe('palette growth, shrink and collapse', () => {
  it('widens the palette as values arrive, narrows it as they leave, and collapses to a number or to nothing', () => {
    const grid = chunkGrid(32);
    const store = new PaletteStore(grid, VARIANTS[0]!);
    store.setVoxel(0, 0, 0, rock);
    const one = store.memoryBytes();
    const sizes: number[] = [];
    for (let m = 2; m <= 40; m++) {
      store.setVoxel(m, 0, 0, voxel(m, VOXEL_CATEGORY.construction, 255, 0));
      sizes.push(store.memoryBytes());
    }
    // 2 bits per cell for up to 4 entries (air, rock, 2 more), 4 for up to 16, 8 past that.
    expect(sizes[1]).toBeLessThan(sizes[3]!);
    expect(sizes[13]).toBeLessThan(sizes[15]!);
    expect(sizes[38]! - sizes[13]!).toBeGreaterThanOrEqual(32 ** 3 / 2);
    for (let m = 2; m <= 40; m++) store.setVoxel(m, 0, 0, voxel());
    // Narrowed from 8 bits to 2 (not to 1: a palette narrows only once it fills a quarter of the narrower width, so
    // toggling one value back and forth does not repack the chunk every time).
    expect(store.memoryBytes()).toBe((32 ** 3 * 2) / 8 + 4 * 8);
    expect(store.memoryBytes()).toBeGreaterThan(one);
    store.setVoxel(0, 0, 0, voxel());
    expect(store.memoryBytes()).toBe(0);
    expect([...store.chunkKeys()]).toEqual([]);
    store.applyStroke({ kind: 'box', min: [0, 0, 0], max: [31, 31, 31], voxel: soil });
    expect(store.memoryBytes()).toBe(8);
    expect([...store.chunkKeys()]).toEqual([chunkKey(grid, 0, 0, 0)]);
  });

  it('keeps density only on surface voxels', () => {
    expect(isSurfaceVoxel(0, 0)).toBe(false);
    expect(isSurfaceVoxel(3, 255)).toBe(false);
    expect(isSurfaceVoxel(3, 254)).toBe(true);
    expect(isSurfaceVoxel(5, 1)).toBe(true);
    expect(isSurfaceVoxel(3, 0)).toBe(true);
    const grid = chunkGrid(16);
    for (const opts of VARIANTS) {
      const store = new PaletteStore(grid, opts);
      store.applyStroke({ kind: 'box', min: [0, 0, 0], max: [15, 7, 15], voxel: rock });
      const solid = store.encodeChunk(0, 0, 0);
      store.setVoxel(4, 8, 4, voxel(5, VOXEL_CATEGORY.liquid, 128, 0));
      store.setVoxel(5, 8, 4, voxel(5, VOXEL_CATEGORY.liquid, 64, 0));
      store.setVoxel(6, 8, 4, water);
      const out = voxel();
      expect(store.voxelAt(4, 8, 4, out).shape).toBe(128);
      expect(store.voxelAt(5, 8, 4, out).shape).toBe(64);
      expect(store.voxelAt(6, 8, 4, out).shape).toBe(255);
      // Liquid's own palette entries, one flagged (two surface voxels share it) and one not.
      store.setVoxel(4, 8, 4, water);
      store.setVoxel(5, 8, 4, water);
      expect(store.voxelAt(5, 8, 4, out).shape).toBe(255);
      store.setVoxel(6, 8, 4, voxel());
      store.setVoxel(4, 8, 4, voxel());
      store.setVoxel(5, 8, 4, voxel());
      expect(store.encodeChunk(0, 0, 0)).toEqual(solid);
      store.applyStroke({ kind: 'box', min: [0, 0, 0], max: [15, 7, 15], voxel: voxel() });
      expect(store.memoryBytes()).toBe(0);
    }
  });

  it('measures a dropped plane: a store without the category plane reads it as 0', () => {
    const grid = chunkGrid(16);
    const store = new PaletteStore(grid, { ...VARIANTS[0]!, name: 'no-cat', planes: VOXEL_PLANES.filter((p) => p !== 'category') });
    store.setVoxel(1, 2, 3, voxel(14, VOXEL_CATEGORY.construction, 200, 3));
    expect(store.voxelAt(1, 2, 3, voxel())).toEqual(voxel(14, 0, 200, 3));
    expect(store.planes).not.toContain('category');
  });
});

describe('the palette codec refuses what it did not write', () => {
  const grid = chunkGrid(16);
  const store = new PaletteStore(grid, VARIANTS[0]!);
  const cells = createDenseChunk(grid);
  fillMixed(grid, cells, 3);
  store.importChunk(0, 0, 0, cells);
  const good = store.encodeChunk(0, 0, 0)!;
  const withCrc = (b: Uint8Array): Uint8Array => {
    const c = crc32(b.subarray(8));
    b.set([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24], 4);
    return b;
  };
  const decode = (b: Uint8Array): void => new PaletteStore(grid, VARIANTS[0]!).decodeChunk(0, 0, 0, b);

  it('decodes its own bytes', () => {
    expect(readPaletteHeader(grid, good)).toEqual({ planes: 15, edge: 16, body: 'packed', kind: 'record' });
    expect(() => decode(good)).not.toThrow();
  });

  it('refuses short, damaged, unknown or non-canonical bytes', () => {
    expect(() => decode(good.subarray(0, 5))).toThrow(/shorter than the header/);
    expect(() => decode(good.subarray(0, good.length - 1))).toThrow(/checksum/);
    expect(() => decode(withCrc(good.slice(0, good.length - 1)))).toThrow(/truncated/);
    const flipped = good.slice();
    flipped[good.length - 3]! ^= 0x10;
    expect(() => decode(flipped)).toThrow(/checksum/);
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expect(() => decode(withCrc(longer))).toThrow(/past the end/);
    const version = good.slice();
    version[2] = 2;
    expect(() => decode(version)).toThrow(/unknown version 2/);
    const magic = good.slice();
    magic[0] = 0;
    expect(() => decode(magic)).toThrow(/magic/);
    const edge = good.slice();
    edge[3]! |= 1 << 4;
    expect(() => decode(edge)).toThrow(/32³ chunk/);
    expect(() => new PaletteStore(chunkGrid(32), VARIANTS[0]!).decodeChunk(0, 0, 0, good)).toThrow(/16³ chunk, decoding into 32³/);
    // A two-entry chunk with every id bit flipped (checksum fixed): the same content numbered the other way round.
    const twoEntry = new PaletteStore(grid, VARIANTS[0]!);
    fillWith(cells, rock);
    cells.material[0] = 2;
    twoEntry.importChunk(0, 0, 0, cells);
    const bytes = twoEntry.encodeChunk(0, 0, 0)!;
    // Header 8, count 2, materials 4, categories 2, orientations 2, flags 1, then 512 bytes of 1-bit ids.
    expect(bytes.length).toBe(8 + 2 + 4 + 2 + 2 + 1 + 512);
    const swapped = bytes.slice();
    for (let k = 19; k < swapped.length; k++) swapped[k]! ^= 0xff;
    expect(() => decode(withCrc(swapped))).toThrow(/first appearance/);
  });
});

describe('cell layouts and the chunk index', () => {
  it('packed and run layouts read back every write', () => {
    const grid = chunkGrid(16);
    const n = grid.cellsPerChunk;
    const rand = mulberry32(4);
    for (const width of [1, 2, 4, 8, 16]) {
      const ids = new Uint16Array(n);
      const max = 2 ** width;
      for (let i = 0; i < n; i++) ids[i] = (i >> 3) % 3 === 0 ? 0 : Math.floor(rand() * max);
      const packed = PackedIndices.from(ids, max);
      const runs = ColumnRuns.from(grid, ids);
      expect(packed.width).toBe(width);
      for (let k = 0; k < 4000; k++) {
        const i = Math.floor(rand() * n);
        const e = Math.floor(rand() * max);
        ids[i] = e;
        packed.set(i, e);
        runs.set(i, e);
      }
      const a = new Uint16Array(n);
      const b = new Uint16Array(n);
      packed.unpack(a);
      runs.unpack(b);
      expect(a).toEqual(ids);
      expect(b).toEqual(ids);
      for (let i = 0; i < n; i += 7) {
        expect(packed.get(i)).toBe(ids[i]);
        expect(runs.get(i)).toBe(ids[i]);
      }
    }
  });

  it('the chunk index holds what a Map would, through inserts and deletes', () => {
    const grid = chunkGrid(16);
    const index = new ChunkIndex<number>(grid);
    const map = new Map<number, number>();
    const rand = mulberry32(9);
    for (let k = 0; k < 20000; k++) {
      const cx = Math.floor(rand() * 40) - 20;
      const cy = Math.floor(rand() * 10) - 5;
      const cz = Math.floor(rand() * 40) - 2048;
      const key = chunkKey(grid, cx, cy, cz);
      if (rand() < 0.4) {
        expect(index.delete(cx, cy, cz)).toBe(map.delete(key));
      } else {
        index.set(cx, cy, cz, k);
        map.set(key, k);
      }
    }
    expect(index.size).toBe(map.size);
    expect(new Map(index.entries())).toEqual(map);
    expect(index.get(grid.chunkMinXZ - 1, 0, 0)).toBeUndefined();
  });
});
