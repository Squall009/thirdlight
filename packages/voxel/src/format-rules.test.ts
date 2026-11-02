/**
 * The rules every voxel byte format reader enforces: one content is one
 * byte string (non-canonical bytes refused), world data has one encoding
 * (measurement encodings refused), stored values are assigned values,
 * readers check the tile they were handed, and versions only move forward
 * through registered upgrade steps. Bytes are crafted by hand here, with
 * their checksums fixed, so the refusal is the rule's and not the CRC's.
 */
import { crc32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  canonicalEditCommand,
  CHUNK_CODEC_UPGRADES,
  createWorldStore,
  EditCommandError,
  checkVoxel,
  chunkGrid,
  createChunkImage,
  createDenseChunk,
  decodeMeasuredImage,
  decodePaletteImage,
  encodeMeasuredImage,
  encodePaletteImage,
  localIndex,
  openRegion,
  ORIENTATION_COUNT,
  orientationMatrix,
  PaletteStore,
  planesImageFromCells,
  readPaletteHeader,
  readRegionChunks,
  recordImageFromCells,
  recordValue,
  MATERIAL_ID_MAX,
  exportOrAir,
  sameDenseChunk,
  RegionChunkSource,
  RegionFileError,
  RegionIndex,
  REGION_ENTRY_BYTES,
  REGION_HEADER_BYTES,
  REGION_UPGRADES,
  regionFileName,
  VOXEL_CATEGORY,
  VOXEL_CATEGORY_COUNT,
  voxel,
  writeRegion,
  type DenseChunk,
  type RegionByteSource,
  type RegionTile,
  type RegionUpgradeStep,
  type UpgradeStep,
} from './index';

const grid = chunkGrid(32);
const n = grid.cellsPerChunk;

function withCrc(b: Uint8Array): Uint8Array {
  const c = crc32(b.subarray(8));
  b.set([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24], 4);
  return b;
}

/** A small chunk: rock below y 8, a partly full soil cell on top of column (0, 0), a stair voxel turned 5. */
function sampleCells(): DenseChunk {
  const c = createDenseChunk(grid);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 8; y++) {
    const i = localIndex(grid, x, y, z);
    c.material[i] = 1;
    c.category[i] = VOXEL_CATEGORY.terrain;
    c.shape[i] = 255;
  }
  const top = localIndex(grid, 0, 8, 0);
  c.material[top] = 2;
  c.category[top] = VOXEL_CATEGORY.terrain;
  c.shape[top] = 90;
  const stair = localIndex(grid, 4, 9, 4);
  c.material[stair] = 3;
  c.category[stair] = VOXEL_CATEGORY.construction;
  c.shape[stair] = 255;
  c.orientation[stair] = 5;
  return c;
}

function worldBytes(cells: DenseChunk): Uint8Array {
  const img = createChunkImage(grid);
  recordImageFromCells(cells, 15, img);
  return encodePaletteImage(img);
}

const decode = (b: Uint8Array): void => void decodePaletteImage(b, createChunkImage(grid));

/** Bytes of a packed record body: header, count − 1, materials (u24), categories, orientations, flag bits, then ids. */
function packedBytes(entries: ReadonlyArray<{ m: number; c: number; o: number; flag?: boolean }>, ids: (i: number) => number, densities: readonly number[] = []): Uint8Array {
  const count = entries.length;
  const width = count <= 1 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : 4;
  const body: number[] = [(count - 1) & 0xff, (count - 1) >> 8];
  for (const e of entries) body.push(e.m & 0xff, (e.m >> 8) & 0xff, e.m >> 16);
  for (const e of entries) body.push(e.c);
  for (const e of entries) body.push(e.o);
  for (let k = 0; k < count; k += 8) {
    let b = 0;
    for (let j = 0; j < 8 && k + j < count; j++) if (entries[k + j]!.flag) b |= 1 << j;
    body.push(b);
  }
  if (width > 0) {
    const per = 8 / width;
    for (let i = 0; i < n; i += per) {
      let b = 0;
      for (let j = 0; j < per; j++) b |= ids(i + j) << (j * width);
      body.push(b);
    }
  }
  body.push(...densities);
  const out = new Uint8Array(8 + body.length);
  out.set([0x56, 0x43, 1, 0x3f]);
  out.set(body, 8);
  return withCrc(out);
}

describe('chunk codec: canonical input only', () => {
  it('decodes what it writes, and the crafted equivalent of it', () => {
    const good = worldBytes(sampleCells());
    expect(() => decode(good)).not.toThrow();
    // Two entries, rock in the lower 8 cells of every column: the hand-built bytes equal the encoder's.
    const cells = createDenseChunk(grid);
    for (let i = 0; i < n; i++) if (i % 32 < 8) [cells.material[i], cells.category[i], cells.shape[i]] = [1, 1, 255];
    const crafted = packedBytes([{ m: 0, c: 0, o: 0 }, { m: 1, c: 1, o: 0 }], (i) => (i % 32 < 8 ? 1 : 0));
    // Ids are numbered by first appearance: cell 0 is rock, so rock is entry 0.
    const swapped = packedBytes([{ m: 1, c: 1, o: 0 }, { m: 0, c: 0, o: 0 }], (i) => (i % 32 < 8 ? 0 : 1));
    expect(worldBytes(cells)).toEqual(swapped);
    expect(() => decode(swapped)).not.toThrow();
    expect(() => decode(crafted)).toThrow(/first appearance/);
  });

  it('refuses a packed body of one voxel without densities (that content is a uniform body)', () => {
    expect(() => decode(packedBytes([{ m: 7, c: 1, o: 0 }], () => 0))).toThrow(/a packed body of one voxel/);
    // One entry whose every cell carries a density is a real chunk (a whole chunk of partly full cells).
    expect(() => decode(packedBytes([{ m: 7, c: 1, o: 0, flag: true }], () => 0, new Array<number>(n).fill(100)))).not.toThrow();
  });

  it('refuses air that is not the one air value', () => {
    const rockBelow = (i: number): number => (i % 32 < 8 ? 0 : 1);
    expect(() => decode(packedBytes([{ m: 1, c: 1, o: 0 }, { m: 0, c: 2, o: 0 }], rockBelow))).toThrow(/air with a category, orientation or density/);
    expect(() => decode(packedBytes([{ m: 1, c: 1, o: 0 }, { m: 0, c: 0, o: 3 }], rockBelow))).toThrow(/air with/);
    const flaggedAir = packedBytes([{ m: 1, c: 1, o: 0 }, { m: 0, c: 0, o: 0, flag: true }], rockBelow, new Array<number>(n - n / 4).fill(9));
    expect(() => decode(flaggedAir)).toThrow(/air with/);
    // Uniform body: material 0 with a category.
    const uniformAir = withCrc(Uint8Array.from([0x56, 0x43, 1, 0x1f, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0]));
    expect(() => decode(uniformAir)).toThrow(/air with/);
    expect(() => decode(withCrc(Uint8Array.from([0x56, 0x43, 1, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))).not.toThrow();
  });

  it('refuses unassigned categories and orientations, in bytes and at every writer', () => {
    const rockBelow = (i: number): number => (i % 32 < 8 ? 0 : 1);
    expect(() => decode(packedBytes([{ m: 1, c: VOXEL_CATEGORY_COUNT, o: 0 }, { m: 0, c: 0, o: 0 }], rockBelow))).toThrow(/unassigned category 5/);
    expect(() => decode(packedBytes([{ m: 1, c: 1, o: ORIENTATION_COUNT }, { m: 0, c: 0, o: 0 }], rockBelow))).toThrow(/orientation 24 is not one of the 24 rotations/);
    expect(() => decode(packedBytes([{ m: 1, c: 4, o: 23 }, { m: 0, c: 0, o: 0 }], rockBelow))).not.toThrow();
    expect(() => checkVoxel(voxel(1, 5, 255, 0))).toThrow(RangeError);
    expect(() => checkVoxel(voxel(1, 1, 255, 24))).toThrow(RangeError);
    expect(() => checkVoxel(voxel(1, 4, 255, 23))).not.toThrow();
  });

  it('holds material ids past 16 bits up to 2²³ − 1 in every form, and refuses wider ones', () => {
    expect(MATERIAL_ID_MAX).toBe(8_388_607);
    const cells = sampleCells();
    const big = [70_000, MATERIAL_ID_MAX, 65_536];
    cells.material[localIndex(grid, 4, 9, 4)] = big[0]!;
    for (let x = 0; x < 32; x++) cells.material[localIndex(grid, x, 0, 5)] = big[1]!;
    cells.material[localIndex(grid, 0, 8, 0)] = big[2]!;
    // Codec bytes, a store, a uniform chunk and the region table: the same ids back.
    const bytes = worldBytes(cells);
    const store = createWorldStore(grid);
    store.decodeChunk(0, 0, 0, bytes);
    expect(sameDenseChunk(exportOrAir(store, 0, 0, 0, createDenseChunk(grid)), cells)).toBe(true);
    expect(store.encodeChunk(0, 0, 0)).toEqual(bytes);
    const solid = createDenseChunk(grid);
    solid.material.fill(MATERIAL_ID_MAX);
    solid.category.fill(VOXEL_CATEGORY.roof);
    solid.shape.fill(255);
    solid.orientation.fill(23);
    const u = worldBytes(solid);
    expect(u).toHaveLength(14);
    store.decodeChunk(1, 0, 0, u);
    expect(store.voxelAt(40, 3, 3, voxel())).toEqual(voxel(MATERIAL_ID_MAX, VOXEL_CATEGORY.roof, 255, 23));
    const region = writeRegion({ worldId: Uint8Array.from({ length: 16 }), gridId: 0, layout: 'stacked', grid, footprint: 512, rx: 0, ry: 0, rz: 0, compressor: 'none' }, [{ cx: 1, cy: 0, cz: 0, uniform: recordValue(MATERIAL_ID_MAX, VOXEL_CATEGORY.roof, 23) }]);
    const read = RegionIndex.parse(region).read(0, region);
    expect(read.kind === 'uniform' && read.value).toBe(recordValue(MATERIAL_ID_MAX, VOXEL_CATEGORY.roof, 23));
    // One past the width: refused by the writers and in bytes.
    expect(() => checkVoxel(voxel(MATERIAL_ID_MAX + 1, 1, 255, 0))).toThrow(RangeError);
    expect(() => canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells: [0, 0, 0], voxel: { material: MATERIAL_ID_MAX + 1, category: 1, orientation: 0, shape: 255 } })).toThrow(EditCommandError);
    const rockBelow = (i: number): number => (i % 32 < 8 ? 0 : 1);
    expect(() => decode(packedBytes([{ m: MATERIAL_ID_MAX + 1, c: 1, o: 0 }, { m: 0, c: 0, o: 0 }], rockBelow))).toThrow(/material 8388608 past its largest value 8388607/);
    expect(() => decode(withCrc(Uint8Array.from([0x56, 0x43, 1, 0x1f, 0, 0, 0, 0, 0, 0, 0x80, 1, 255, 0])))).toThrow(/material 8388608 past/);
  });

  it('names 24 distinct axis rotations, 0 the identity', () => {
    const seen = new Set<string>();
    for (let k = 0; k < ORIENTATION_COUNT; k++) {
      const m = orientationMatrix(k);
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      expect(det).toBe(1);
      for (let r = 0; r < 3; r++) expect(Math.abs(m[r * 3]!) + Math.abs(m[r * 3 + 1]!) + Math.abs(m[r * 3 + 2]!)).toBe(1);
      seen.add(m.join());
    }
    expect(seen.size).toBe(24);
    expect(orientationMatrix(0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // 4..7 carry +y to −y; 8..11 to +x (the second column is where +y lands).
    expect([orientationMatrix(5)[1], orientationMatrix(5)[4], orientationMatrix(5)[7]]).toEqual([0, -1, 0]);
    expect([orientationMatrix(9)[1], orientationMatrix(9)[4], orientationMatrix(9)[7]]).toEqual([1, 0, 0]);
    expect(() => orientationMatrix(24)).toThrow(RangeError);
  });
});

describe('chunk codec: world data has one encoding', () => {
  const cells = sampleCells();
  const measured = (planes: number, layout: 'packed' | 'runs' | 'bricks', kind: 'record' | 'planes' = 'record'): Uint8Array => {
    const img = createChunkImage(grid);
    if (kind === 'record') recordImageFromCells(cells, planes, img);
    else planesImageFromCells(cells, planes, img);
    return encodeMeasuredImage(img, planes, layout);
  };

  it('the bench entry writes world bytes byte for byte as the world codec does', () => {
    expect(measured(15, 'packed')).toEqual(worldBytes(cells));
  });

  it.each([
    ['column runs', () => measured(15, 'runs')],
    ['bricks at rest', () => measured(15, 'bricks')],
    ['per-plane palettes', () => measured(15, 'packed', 'planes')],
    ['a dropped orientation plane', () => measured(7, 'packed')],
    ['a dropped category plane', () => measured(13, 'packed')],
  ])('refuses %s in world readers; only the bench entry decodes them', (_name, make) => {
    const b = make();
    expect(() => decode(b)).toThrow(/a measurement encoding/);
    expect(() => readPaletteHeader(grid, b)).toThrow(/a measurement encoding/);
    expect(() => decodeMeasuredImage(b, createChunkImage(grid))).not.toThrow();
    // The world store refuses them too; a measurement store reads them.
    expect(() => new PaletteStore(grid, { name: 'w', palette: 'record', layout: 'bricks', atRest: 'packed' }).decodeChunk(0, 0, 0, b)).toThrow(/a measurement encoding/);
  });
});

describe('chunk codec: versions move forward through registered steps only', () => {
  /**
   * A test-only "version 0" of the codec (never a real format): version 1's
   * bytes with the category and orientation planes of a packed body swapped.
   * The step lifts it to version 1, as a real step would lift version 1 to 2.
   */
  const toV0 = (v1: Uint8Array): Uint8Array => {
    const b = v1.slice();
    const count = (b[8]! | (b[9]! << 8)) + 1;
    const cat = 10 + 3 * count;
    b.set(v1.subarray(cat + count, cat + 2 * count), cat);
    b.set(v1.subarray(cat, cat + count), cat + count);
    b[2] = 0;
    return withCrc(b);
  };
  const step: UpgradeStep<Uint8Array> = {
    from: 0,
    lift: (v0) => {
      const b = v0.slice();
      const count = (b[8]! | (b[9]! << 8)) + 1;
      const cat = 10 + 3 * count;
      b.set(v0.subarray(cat + count, cat + 2 * count), cat);
      b.set(v0.subarray(cat, cat + count), cat + count);
      b[2] = 1;
      return withCrc(b);
    },
  };

  it('has no steps at version 1, and the registry is frozen', () => {
    expect(CHUNK_CODEC_UPGRADES).toEqual([]);
    expect(Object.isFrozen(CHUNK_CODEC_UPGRADES)).toBe(true);
    expect(REGION_UPGRADES).toEqual([]);
    expect(Object.isFrozen(REGION_UPGRADES)).toBe(true);
  });

  it('reads an older version through its step, refuses it without one, and refuses a newer one', () => {
    const v1 = worldBytes(sampleCells());
    const v0 = toV0(v1);
    expect(v0).not.toEqual(v1);
    const a = createChunkImage(grid);
    const b = createChunkImage(grid);
    decodePaletteImage(v1, a);
    decodePaletteImage(v0, b, [step]);
    expect(b.planes[0].values.subarray(0, b.planes[0].count)).toEqual(a.planes[0].values.subarray(0, a.planes[0].count));
    expect(b.planes[0].ids).toEqual(a.planes[0].ids);
    expect(b.densValues.subarray(0, b.densCount)).toEqual(a.densValues.subarray(0, a.densCount));
    expect(() => decode(v0)).toThrow(/version 0 has no upgrade step/);
    const v2 = v1.slice();
    v2[2] = 2;
    expect(() => decodePaletteImage(withCrc(v2), createChunkImage(grid), [step])).toThrow(/version 2 is newer than this build reads/);
    const wrong: UpgradeStep<Uint8Array> = { from: 0, lift: (x) => x };
    expect(() => decodePaletteImage(v0, createChunkImage(grid), [wrong])).toThrow(/the upgrade step from version 0 gave version 0/);
  });
});

/** A region file in memory as a byte source that counts its reads. */
function memorySource(bytes: Uint8Array): RegionByteSource & { reads: number } {
  const s = {
    reads: 0,
    read: async (offset: number, length: number): Promise<Uint8Array> => {
      s.reads++;
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
  };
  return s;
}

const WORLD = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

function sampleRegion(over: Partial<RegionTile> = {}): { tile: RegionTile; bytes: Uint8Array } {
  const tile: RegionTile = { worldId: WORLD, gridId: 0, layout: 'stacked', grid, footprint: 512, rx: 1, ry: 0, rz: -1, compressor: 'none', ...over };
  const stored = worldBytes(sampleCells());
  const bytes = writeRegion(tile, [
    { cx: 16, cy: 0, cz: -16, uniform: recordValue(1, VOXEL_CATEGORY.terrain, 0) },
    { cx: 17, cy: 2, cz: -15, stored, raw: true },
    { cx: 20, cy: 3, cz: -9, stored, raw: true },
  ]);
  return { tile, bytes };
}

describe('region file: a reader checks the tile it expects', () => {
  const { tile, bytes } = sampleRegion();
  const expect0 = { worldId: WORLD, gridId: 0, layout: 'stacked' as const, grid, footprint: 512 as const, rx: 1, ry: 0, rz: -1 };

  it('opens the file it expects', async () => {
    expect(RegionIndex.parse(bytes, { expect: expect0 }).size).toBe(3);
    expect((await openRegion(memorySource(bytes), { expect: expect0 })).size).toBe(3);
  });

  it.each([
    ['world id', { worldId: Uint8Array.from(WORLD, (b) => b ^ 0x80) }, /world id 0102.*, expected 8182/],
    ['grid id', { gridId: 3 }, /grid id 0, expected 3/],
    ['layout', { layout: 'column' as const, ry: 0 }, /layout stacked, expected column/],
    ['chunk edge', { grid: chunkGrid(16) }, /chunk edge 32, expected 16/],
    ['footprint', { footprint: 1024 as const }, /footprint 512, expected 1024/],
    ['region', { rz: 0 }, /region 1,0,-1, expected 1,0,0/],
  ])('refuses another %s', async (_what, change, message) => {
    const e = { ...expect0, ...change };
    expect(() => RegionIndex.parse(bytes, { expect: e })).toThrow(RegionFileError);
    expect(() => RegionIndex.parse(bytes, { expect: e })).toThrow(message);
    await expect(openRegion(memorySource(bytes), { expect: e })).rejects.toThrow(message);
  });

  it('a chunk source reports a file of another world as damaged, never as its voxels', async () => {
    const name = regionFileName('stacked', tile.rx, tile.ry, tile.rz);
    const other = sampleRegion({ worldId: Uint8Array.from(WORLD, (b) => b ^ 1) }).bytes;
    const source = (file: Uint8Array): RegionChunkSource =>
      new RegionChunkSource({ worldId: WORLD, gridId: 0, grid, layout: 'stacked', footprint: 512, maxOpen: 4, open: (n2) => (n2 === name ? memorySource(file) : null) });
    const ok = await source(bytes).read([{ cx: 17, cy: 2, cz: -15 }, { cx: 16, cy: 0, cz: -16 }]);
    expect(ok.map((r) => r.kind)).toEqual(['stored', 'uniform']);
    const bad = await source(other).read([{ cx: 17, cy: 2, cz: -15 }, { cx: 16, cy: 0, cz: -16 }, { cx: 0, cy: 0, cz: 0 }]);
    expect(bad.map((r) => r.kind)).toEqual(['damaged', 'damaged', 'air']);
    expect(bad[0]!.kind === 'damaged' && bad[0]!.reason).toMatch(/region r\.1\.0\.-1\.vxr: region file: world id .*, expected/);
  });
});

describe('region file: versions move forward through registered steps only', () => {
  /**
   * A test-only "version 0" of the region file (never a real format): its
   * table entries are 16 bytes, four zero bytes after each 12-byte entry.
   * The step lifts header and table to version 1; the stored chunks stay
   * where they are, and range reads still find them.
   */
  const V0_ENTRY = 16;
  const toV0 = (v1: Uint8Array): Uint8Array => {
    const count = new DataView(v1.buffer, v1.byteOffset).getUint32(44, true);
    const tableEnd = REGION_HEADER_BYTES + count * REGION_ENTRY_BYTES;
    const out = new Uint8Array(v1.length + count * (V0_ENTRY - REGION_ENTRY_BYTES));
    out.set(v1.subarray(0, REGION_HEADER_BYTES));
    for (let i = 0; i < count; i++) out.set(v1.subarray(REGION_HEADER_BYTES + i * REGION_ENTRY_BYTES, REGION_HEADER_BYTES + (i + 1) * REGION_ENTRY_BYTES), REGION_HEADER_BYTES + i * V0_ENTRY);
    out.set(v1.subarray(tableEnd), REGION_HEADER_BYTES + count * V0_ENTRY);
    out[4] = 0;
    const view = new DataView(out.buffer);
    view.setUint32(52, crc32(out.subarray(REGION_HEADER_BYTES, REGION_HEADER_BYTES + count * V0_ENTRY)), true);
    view.setUint32(60, crc32(out.subarray(0, 60)), true);
    return out;
  };
  const step: RegionUpgradeStep = {
    from: 0,
    indexEnd: (head) => REGION_HEADER_BYTES + new DataView(head.buffer, head.byteOffset).getUint32(44, true) * V0_ENTRY,
    lift: (v0) => {
      const count = new DataView(v0.buffer, v0.byteOffset).getUint32(44, true);
      const out = new Uint8Array(REGION_HEADER_BYTES + count * REGION_ENTRY_BYTES);
      out.set(v0.subarray(0, REGION_HEADER_BYTES));
      for (let i = 0; i < count; i++) out.set(v0.subarray(REGION_HEADER_BYTES + i * V0_ENTRY, REGION_HEADER_BYTES + i * V0_ENTRY + REGION_ENTRY_BYTES), REGION_HEADER_BYTES + i * REGION_ENTRY_BYTES);
      out[4] = 1;
      const view = new DataView(out.buffer);
      view.setUint32(52, crc32(out.subarray(REGION_HEADER_BYTES)), true);
      view.setUint32(60, crc32(out.subarray(0, 60)), true);
      return out;
    },
  };
  const chunks = [{ cx: 17, cy: 2, cz: -15 }, { cx: 16, cy: 0, cz: -16 }, { cx: 20, cy: 3, cz: -9 }, { cx: 18, cy: 1, cz: -10 }];

  it('reads an older file by range through its step, the same chunks as the current file', async () => {
    const { bytes } = sampleRegion();
    const v0 = toV0(bytes);
    const now = await readRegionChunks(memorySource(bytes), await openRegion(memorySource(bytes)), chunks);
    const src = memorySource(v0);
    const index = await openRegion(src, { upgrades: [step] });
    expect(index.dataStart).toBe(REGION_HEADER_BYTES + 3 * V0_ENTRY);
    expect(index.fileBytes).toBe(v0.length);
    const old = await readRegionChunks(src, index, chunks);
    expect(old).toEqual(now);
    expect(RegionIndex.parse(v0, { upgrades: [step] }).size).toBe(3);
  });

  it('refuses an older file without a step and a newer file', async () => {
    const { bytes } = sampleRegion();
    await expect(openRegion(memorySource(toV0(bytes)))).rejects.toThrow(/version 0 has no upgrade step/);
    const v2 = bytes.slice();
    v2[4] = 2;
    new DataView(v2.buffer).setUint32(60, crc32(v2.subarray(0, 60)), true);
    await expect(openRegion(memorySource(v2), { upgrades: [step] })).rejects.toThrow(/version 2 is newer than this build reads/);
    const codec2 = bytes.slice();
    codec2[7] = 2;
    new DataView(codec2.buffer).setUint32(60, crc32(codec2.subarray(0, 60)), true);
    expect(() => RegionIndex.parse(codec2)).toThrow(/chunk codec version 2/);
  });
});

describe('edit commands: one stroke, one payload', () => {
  const v = { material: 3, category: VOXEL_CATEGORY.construction, orientation: 0, shape: 255 };
  const cells = [5, 1, 2, 4, 9, 9, 5, 1, 2, 4, 2, 9, -3, 0, 0, 4, 9, 9, 4, 2, 3];
  const sorted = [-3, 0, 0, 4, 2, 3, 4, 2, 9, 4, 9, 9, 5, 1, 2];

  it('sorts set and dig cells by x, then z, then y, each once', () => {
    const set = canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells, voxel: v });
    expect(set.kind === 'set' && set.cells).toEqual(sorted);
    const dig = canonicalEditCommand({ v: 1, grid: 0, kind: 'dig', cells });
    expect(dig.kind === 'dig' && dig.cells).toEqual(sorted);
    // Any order or repeats of the same cells give the same payload, byte for byte.
    const shuffled = [4, 2, 3, 5, 1, 2, -3, 0, 0, 4, 9, 9, 4, 2, 9, 4, 2, 9];
    expect(JSON.stringify(canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells: shuffled, voxel: v }))).toBe(JSON.stringify(set));
    // And the same cells change: applied to two fresh stores, equal content and equal undo records.
    const a = createWorldStore(grid);
    const b = createWorldStore(grid);
    const ra = applyEdit({ store: () => a }, set);
    const rb = applyEdit({ store: () => b }, canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells, voxel: v }));
    expect(ra.cells).toBe(5);
    expect(rb.cells).toBe(5);
    expect(a.encodeChunk(0, 0, 0)).toEqual(b.encodeChunk(0, 0, 0));
    expect(a.encodeChunk(-1, 0, 0)).toEqual(b.encodeChunk(-1, 0, 0));
  });

  it('refuses an unassigned category or orientation in the voxel a stroke writes', () => {
    expect(() => canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells: [0, 0, 0], voxel: { ...v, category: VOXEL_CATEGORY_COUNT } })).toThrow(EditCommandError);
    expect(() => canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells: [0, 0, 0], voxel: { ...v, orientation: ORIENTATION_COUNT } })).toThrow(EditCommandError);
    expect(() => canonicalEditCommand({ v: 1, grid: 0, kind: 'fill', min: [0, 0, 0], max: [1, 1, 1], mode: 'place', voxel: { material: 3, category: 9, orientation: 0 } })).toThrow(/category/);
    expect(() => canonicalEditCommand({ v: 1, grid: 0, kind: 'set', cells: [0, 0, 0], voxel: { ...v, category: 4, orientation: 23 } })).not.toThrow();
  });
});
