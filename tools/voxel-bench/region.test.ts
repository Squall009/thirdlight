import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  damagedRegionChunks,
  openRegion,
  parseRegionFileName,
  readRegionChunks,
  readRegionHeader,
  regionChunkCodecBytes,
  RegionChunkError,
  RegionFileError,
  RegionIndex,
  REGION_ENTRY_BYTES,
  REGION_HEADER_BYTES,
  sameDenseChunk,
  valueMaterial,
  voxel,
  VOXEL_ROLE,
  writeRegion,
  type ChunkCoord,
  type PaletteStore,
  type RegionEntry,
  type RegionTile,
  type RegionExpect,
} from '@thirdlight/voxel';
import { crc32 } from '@thirdlight/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSource, HttpSource, importRead, loadArea, pickStore, RegionSet, startRangeServer, storeEntry, zstdDecompress } from './regions';
import { townWorld, verticalWorld } from './worlds';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const WORLD = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
/** What a reader of the town's one column file expects it to hold. */
const COLUMN0 = { expect: { worldId: WORLD, gridId: 0, layout: 'column' as const, grid, footprint: 512 as const, rx: 0, ry: 0, rz: 0 } };
/** What a reader expects of a file of grid `gridId` and `layout`, from its name. */
const expectOf = (name: string, layout: 'column' | 'stacked', gridId = 0): { expect: RegionExpect } => ({ expect: { worldId: WORLD, gridId, layout, grid, footprint: 512, ...parseRegionFileName(layout, name)! } });
const town = townWorld({ footprint: 200 });

/** The town's world grid in one store, and a set of 256 m column region files over it. */
function townStore(): PaletteStore {
  const store = pickStore(grid);
  loadArea(town.grids[0]!, store, 0, 0, 512, 512);
  return store;
}

function onlyFile(set: RegionSet): Uint8Array {
  const files = set.allFiles();
  expect(files.size).toBe(1);
  return [...files.values()][0]!;
}

/** Every chunk of `a` read back equal from `b`, and `b` holds no other chunk. */
function expectSameStores(a: PaletteStore, b: PaletteStore): void {
  const x = createDenseChunk(grid);
  const y = createDenseChunk(grid);
  const keys = [...a.chunkKeys()].sort((p, q) => p - q);
  expect([...b.chunkKeys()].sort((p, q) => p - q)).toEqual(keys);
  const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  for (const k of keys) {
    chunkOfKey(grid, k, c);
    a.exportChunk(c.cx, c.cy, c.cz, x);
    b.exportChunk(c.cx, c.cy, c.cz, y);
    expect(sameDenseChunk(x, y)).toBe(true);
  }
}

/** Fixes the header CRC after a deliberate header change, so the change itself is what the reader sees. */
function resealHeader(bytes: Uint8Array): void {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(60, crc32(bytes.subarray(0, 60)), true);
}

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-region-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('region files', () => {
  it('round-trips a world tile through a file on disk, uniform chunks inline in the table', async () => {
    const store = townStore();
    const bytes = onlyFile(new RegionSet(store, 'column', 512, WORLD));
    const index = RegionIndex.parse(bytes, COLUMN0);
    const h = index.header;
    expect([h.rx, h.ry, h.rz, h.gridId, h.side, h.layout, h.compressor]).toEqual([0, 0, 0, 0, 16, 'column', 'zstd']);
    expect([...h.worldId]).toEqual([...WORLD]);
    expect(index.fileBytes).toBe(bytes.length);
    // Deep ground is one voxel everywhere: those chunks are table entries with no stored bytes.
    const uniform = Array.from({ length: index.size }, (_, i) => i).filter((i) => index.isUniform(i));
    expect(uniform.length).toBeGreaterThan(0);
    expect(uniform.every((i) => index.storedBytes(i) === 0)).toBe(true);
    expect(bytes.length).toBe(REGION_HEADER_BYTES + index.size * REGION_ENTRY_BYTES + h.dataBytes);
    const path = join(dir, 'r.0.0.vxr');
    writeFileSync(path, bytes);
    const src = await FileSource.open(path);
    const back = pickStore(grid);
    const all: ChunkCoord[] = [];
    for (let i = 0; i < index.size; i++) all.push(index.coordOf(i));
    // Ask for absent chunks too: they read as air.
    all.push({ cx: 0, cy: 40, cz: 0 });
    const opened = await openRegion(src, COLUMN0);
    const reads = await readRegionChunks(src, opened, all);
    await src.close();
    expect(reads.at(-1)!.kind).toBe('air');
    for (const r of reads) importRead(back, r);
    expectSameStores(store, back);
    const deep = reads.find((r) => r.kind === 'uniform');
    expect(deep !== undefined && deep.kind === 'uniform' && valueMaterial(deep.value) === MAT.rock).toBe(true);
  });

  it('writes byte-identical files for equal content, whatever the edit order or entry order', () => {
    const a = townStore();
    const b = townStore();
    const dig = (x: number, z: number) => ({ kind: 'sphere' as const, center: [x, 0, z] as const, radius: 6, voxel: voxel() });
    const wall = (x: number) => ({ kind: 'box' as const, min: [x, 1, 30] as const, max: [x + 1, 8, 60] as const, voxel: voxel(MAT.stone, VOXEL_ROLE.wall) });
    const base = onlyFile(new RegionSet(townStore(), 'column', 512, WORLD));
    const sa = new RegionSet(a, 'column', 512, WORLD);
    const sb = new RegionSet(b, 'column', 512, WORLD);
    // The same edits in another order; a and b also take a detour (paint a cell, then put it back).
    for (const s of [dig(20, 20), wall(100), dig(150, 90), wall(160)]) sa.apply(s);
    sb.apply({ kind: 'box', min: [3, 3, 3], max: [3, 3, 3], voxel: voxel(MAT.brick, VOXEL_ROLE.wall) });
    for (const s of [wall(160), dig(150, 90), wall(100), dig(20, 20)]) sb.apply(s);
    sb.apply({ kind: 'box', min: [3, 3, 3], max: [3, 3, 3], voxel: voxel() });
    const fa = onlyFile(sa);
    const fb = onlyFile(sb);
    expect(Buffer.compare(fa, fb)).toBe(0);
    expect(Buffer.compare(fa, base)).not.toBe(0);
    // Rewriting unchanged content gives the same bytes; so do entries handed over in any order.
    expect(Buffer.compare(onlyFile(sa), fa)).toBe(0);
    const index = RegionIndex.parse(fa, COLUMN0);
    const entries: RegionEntry[] = [];
    for (let i = 0; i < index.size; i++) entries.push(storeEntry(a, index.coordOf(i))!);
    const tile: RegionTile = { worldId: WORLD, gridId: 0, layout: 'column', grid, footprint: 512, rx: 0, ry: 0, rz: 0, compressor: 'zstd' };
    expect(Buffer.compare(writeRegion(tile, entries.reverse()), fa)).toBe(0);
    // Two entries for one chunk, or an air entry, are refused.
    expect(() => writeRegion(tile, [entries[0]!, entries[0]!])).toThrow(/twice/);
    expect(() => writeRegion(tile, [{ cx: 0, cy: 0, cz: 0, uniform: 0 }])).toThrow(/air/);
  });

  it('reads a 3×3 neighbourhood by coalesced range requests from disk and over HTTP', async () => {
    const store = townStore();
    const bytes = onlyFile(new RegionSet(store, 'column', 512, WORLD));
    writeFileSync(join(dir, 'r.0.0.vxr'), bytes);
    const index = RegionIndex.parse(bytes, COLUMN0);
    const near: ChunkCoord[] = [];
    for (let cx = 1; cx <= 3; cx++) for (let cz = 1; cz <= 3; cz++) for (let cy = -1; cy <= 0; cy++) near.push({ cx, cy, cz });
    const whole = near.map((c) => {
      const i = index.find(c.cx, c.cy, c.cz);
      return i < 0 ? ({ kind: 'air' } as const) : index.read(i, bytes);
    });
    const stored = near.filter((c) => {
      const i = index.find(c.cx, c.cy, c.cz);
      return i >= 0 && !index.isUniform(i);
    }).length;
    expect(stored).toBeGreaterThan(3);
    // Apart: one range per stored chunk; joined across small gaps: one range per x column of the neighbourhood at most.
    const found = near.map((c) => index.find(c.cx, c.cy, c.cz)).filter((i) => i >= 0);
    expect(index.ranges(found, -1).length).toBe(stored);
    expect(index.ranges(found, 64 * 1024).length).toBeLessThanOrEqual(3);
    const { server, port } = await startRangeServer(dir);
    try {
      const file = await FileSource.open(join(dir, 'r.0.0.vxr'));
      const http = new HttpSource(`http://127.0.0.1:${port}/r.0.0.vxr`);
      for (const src of [file, http]) {
        const opened = await openRegion(src, COLUMN0);
        expect(src.requests).toBe(1);
        const reads = await readRegionChunks(src, opened, near, 64 * 1024);
        expect(src.requests).toBeLessThanOrEqual(4);
        reads.forEach((r, k) => {
          const w = whole[k]!;
          expect(r.kind).toBe(w.kind);
          if (r.kind === 'stored' && w.kind === 'stored') expect(Buffer.compare(r.bytes, w.bytes)).toBe(0);
        });
      }
      await file.close();
    } finally {
      server.close();
    }
  });

  it('refuses a damaged header or table, an unknown version and a wrong length; reports a damaged chunk and reads the rest', () => {
    const bytes = onlyFile(new RegionSet(townStore(), 'column', 512, WORLD));
    const flip = (at: number): Uint8Array => {
      const b = bytes.slice();
      b[at]! ^= 0x10;
      return b;
    };
    expect(() => RegionIndex.parse(flip(33), COLUMN0)).toThrow(/header checksum/);
    expect(() => RegionIndex.parse(flip(REGION_HEADER_BYTES + 5), COLUMN0)).toThrow(/table checksum/);
    expect(() => RegionIndex.parse(flip(1), COLUMN0)).toThrow(/magic/);
    const v3 = bytes.slice();
    v3[4] = 3;
    resealHeader(v3);
    expect(() => readRegionHeader(v3)).toThrow(RegionFileError);
    expect(() => readRegionHeader(v3)).toThrow(/version 3 is newer than this build reads/);
    const reserved = bytes.slice();
    reserved[57] = 1;
    resealHeader(reserved);
    expect(() => readRegionHeader(reserved)).toThrow(/reserved/);
    expect(() => damagedRegionChunks(bytes.subarray(0, bytes.length - 1), COLUMN0)).toThrow(/bytes, its table says/);
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => damagedRegionChunks(longer, COLUMN0)).toThrow(/bytes, its table says/);
    expect(damagedRegionChunks(bytes, COLUMN0)).toEqual([]);

    const index = RegionIndex.parse(bytes, COLUMN0);
    const victim = Array.from({ length: index.size }, (_, i) => i).find((i) => !index.isUniform(i))!;
    const hurt = flip(index.offsetOf(victim) + 3);
    const damaged = damagedRegionChunks(hurt, COLUMN0);
    expect(damaged).toHaveLength(1);
    const c = index.coordOf(victim);
    expect([damaged[0]!.cx, damaged[0]!.cy, damaged[0]!.cz]).toEqual([c.cx, c.cy, c.cz]);
    const r = index.read(victim, hurt);
    expect(r.kind).toBe('damaged');
    expect(() => regionChunkCodecBytes(grid, r, zstdDecompress)).toThrow(RegionChunkError);
    // Its neighbours still read.
    const other = victim + 1 < index.size ? victim + 1 : victim - 1;
    expect(index.read(other, hurt).kind).not.toBe('damaged');
    // A range that came back short reports the chunk damaged too.
    expect(index.read(victim, bytes.subarray(0, index.offsetOf(victim) + 2)).kind).toBe('damaged');
  });

  it('splits a 2 km tall column into stacked cubes that hold the same chunks', () => {
    const tall = verticalWorld({ footprint: 64 });
    const store = pickStore(grid);
    loadArea(tall.grids[0]!, store, 0, 0, 64, 64);
    const column = onlyFile(new RegionSet(store, 'column', 512, WORLD));
    const stacks = new RegionSet(store, 'stacked', 512, WORLD).allFiles();
    // 4,000 cells of height in 256 m cubes: 8 stacks; air above the peak and below the base allocates nothing.
    expect(stacks.size).toBe(8);
    const ci = RegionIndex.parse(column, COLUMN0);
    let entries = 0;
    for (const [name, b] of stacks) {
      const s = RegionIndex.parse(b, expectOf(name, 'stacked'));
      expect(name).toBe(`r.0.${s.header.ry}.0.vxr`);
      expect(s.header.layout).toBe('stacked');
      entries += s.size;
      for (let i = 0; i < s.size; i++) {
        const c = s.coordOf(i);
        const j = ci.find(c.cx, c.cy, c.cz);
        expect(j).toBeGreaterThanOrEqual(0);
        const a = s.read(i, b);
        const w = ci.read(j, column);
        expect(a.kind).toBe(w.kind);
      }
    }
    expect(entries).toBe(ci.size);
    const tile: RegionTile = { worldId: WORLD, gridId: 0, layout: 'stacked', grid, footprint: 512, rx: 0, ry: 1, rz: 0, compressor: 'zstd' };
    expect(() => writeRegion(tile, [{ cx: 0, cy: 0, cz: 0, uniform: 1 }])).toThrow(/outside stack 1/);
  });

  it('holds a structure grid in its own container: its grid id, its own local tiles, read back equal', async () => {
    const house = townWorld().grids[1];
    expect(house).toBeDefined();
    const store = pickStore(grid);
    const b = house!.bounds;
    loadArea(house!, store, b.min[0], b.min[2], b.max[0], b.max[2]);
    const files = new RegionSet(store, 'column', 512, WORLD, 7).allFiles();
    expect(files.size).toBeGreaterThan(0);
    const back = pickStore(grid);
    for (const [name, bytes] of files) {
      const path = join(dir, `grid7-${name}`);
      writeFileSync(path, bytes);
      const src = await FileSource.open(path);
      const index = await openRegion(src, expectOf(name, 'column', 7));
      expect(index.header.gridId).toBe(7);
      const all: ChunkCoord[] = [];
      for (let i = 0; i < index.size; i++) all.push(index.coordOf(i));
      for (const r of await readRegionChunks(src, index, all)) importRead(back, r);
      await src.close();
    }
    expectSameStores(store, back);
  });
});
