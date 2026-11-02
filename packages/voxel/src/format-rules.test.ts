/**
 * The rules every voxel byte format reader enforces: one content is one
 * byte string (non-canonical bytes refused), world data has one encoding
 * (measurement encodings refused), stored values are assigned values,
 * readers check the tile they were handed, and versions only move forward
 * through registered upgrade steps. Bytes are crafted by hand here, with
 * their checksums fixed, so the refusal is the rule's and not the CRC's.
 */
import { bytesToHex, crc32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  applySaveChunk,
  baseChunkHash,
  baseContentHash,
  canonicalEditCommand,
  CellDelta,
  changedMaskBytes,
  decodeOverrides,
  decodeUndoRecord,
  encodeOverrides,
  encodeUndoRecord,
  OVERRIDE_UPGRADES,
  readSave,
  RECORD_VALUE_FORM,
  saveContentOf,
  SAVE_UPGRADES,
  writeSave,
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
  type StructureOverrides,
  type UpgradeStep,
} from './index';

const grid = chunkGrid(32);
const n = grid.cellsPerChunk;
/** The base hash of {@link sampleCells}: frozen with the base form (the save format's base hash definition). */
const GOLDEN_BASE_HASH = '6c69b56ed64ea563b3efdd11bc3720df';

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
    const wide: RegionTile = { worldId: Uint8Array.from({ length: 16 }), gridId: 0, layout: 'stacked', grid, footprint: 512, rx: 0, ry: 0, rz: 0, compressor: 'none' };
    const region = writeRegion(wide, [{ cx: 1, cy: 0, cz: 0, uniform: recordValue(MATERIAL_ID_MAX, VOXEL_CATEGORY.roof, 23) }]);
    const read = RegionIndex.parse(region, { expect: wide }).read(0, region);
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

  it('gives one base hash per content, whatever codec version holds it, and the base form is frozen', () => {
    const v1 = worldBytes(sampleCells());
    const h1 = baseChunkHash(grid, v1);
    // Frozen: this content's base hash, written down when the base form was defined. A codec change that
    // moves it changes every save's base hashes: keep a version 1 writer for the base form instead.
    expect(bytesToHex(h1)).toBe(GOLDEN_BASE_HASH);
    expect(bytesToHex(baseChunkHash(grid, null))).toBe('e3b0c44298fc1c149afbf4c8996fb924');
    // The same content in another codec version's bytes (the test-only version 0) hashes the same.
    const v0 = toV0(v1);
    expect(v0).not.toEqual(v1);
    expect(baseChunkHash(grid, v0, [step])).toEqual(h1);
    // A test-only newer layout (version 2: the category and orientation planes swapped, never a real format):
    // decoded by its own reader into the content, it hashes as its version 1 bytes do.
    const v2 = toV0(v1);
    v2[2] = 2;
    withCrc(v2);
    const readV2 = (b: Uint8Array): ReturnType<typeof createChunkImage> => {
      const back = b.slice();
      back[2] = 0;
      const img = createChunkImage(grid);
      decodePaletteImage(withCrc(back), img, [step]);
      return img;
    };
    expect(baseContentHash(readV2(v2))).toEqual(h1);
    expect(baseContentHash(null)).toEqual(baseChunkHash(grid, null));
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
    const { tile, bytes } = sampleRegion();
    const v0 = toV0(bytes);
    const now = await readRegionChunks(memorySource(bytes), await openRegion(memorySource(bytes), { expect: tile }), chunks);
    const src = memorySource(v0);
    const index = await openRegion(src, { expect: tile, upgrades: [step] });
    expect(index.dataStart).toBe(REGION_HEADER_BYTES + 3 * V0_ENTRY);
    expect(index.fileBytes).toBe(v0.length);
    const old = await readRegionChunks(src, index, chunks);
    expect(old).toEqual(now);
    expect(RegionIndex.parse(v0, { expect: tile, upgrades: [step] }).size).toBe(3);
  });

  it('refuses an older file without a step and a newer file', async () => {
    const { tile, bytes } = sampleRegion();
    await expect(openRegion(memorySource(toV0(bytes)), { expect: tile })).rejects.toThrow(/version 0 has no upgrade step/);
    const v2 = bytes.slice();
    v2[4] = 2;
    new DataView(v2.buffer).setUint32(60, crc32(v2.subarray(0, 60)), true);
    await expect(openRegion(memorySource(v2), { expect: tile, upgrades: [step] })).rejects.toThrow(/version 2 is newer than this build reads/);
    const codec2 = bytes.slice();
    codec2[7] = 2;
    new DataView(codec2.buffer).setUint32(60, crc32(codec2.subarray(0, 60)), true);
    expect(() => RegionIndex.parse(codec2, { expect: tile })).toThrow(/chunk codec version 2/);
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

/** A save of one chunk in memory, written and read back (no compressor). */
function saveRoundTrip(base: DenseChunk, now: DenseChunk): ReturnType<typeof readSave> {
  const content = saveContentOf(grid, base, now)!;
  const worldId = Uint8Array.from({ length: 16 }, (_, i) => i);
  const bytes = writeSave({ worldId, grid, chunks: [{ grid: 0, cx: 0, cy: 0, cz: 0, base: baseChunkHash(grid, worldBytes(base)), content }] }, 'none', (b) => b);
  return readSave(bytes, grid, worldId, (b) => b);
}

describe('saves: the cells the player changed land on a changed base', () => {
  const rockTo = (top: number): DenseChunk => {
    const c = createDenseChunk(grid);
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < top; y++) {
      const i = localIndex(grid, x, y, z);
      [c.material[i], c.category[i], c.shape[i]] = [1, VOXEL_CATEGORY.terrain, 255];
    }
    return c;
  };

  it('a whole-chunk entry carries the changed cells: on a new base only those are the player\'s', () => {
    // The base is rock up to y 16; the player digs all of it (the chunk is air now, a whole-chunk entry).
    const base = rockTo(16);
    const save = saveRoundTrip(base, createDenseChunk(grid));
    const entry = save.chunks[0]!;
    expect(entry.content.kind).toBe('air');
    expect(entry.content.kind !== 'delta' && entry.content.mask.length).toBe(changedMaskBytes(grid));
    // The re-export puts a wall above the old ground, in cells the player never changed.
    const reexport = rockTo(16);
    for (let y = 16; y < 24; y++) [reexport.material[localIndex(grid, 5, y, 5)], reexport.category[localIndex(grid, 5, y, 5)], reexport.shape[localIndex(grid, 5, y, 5)]] = [2, VOXEL_CATEGORY.construction, 255];
    const onSame = createWorldStore(grid);
    onSame.importChunk(0, 0, 0, base);
    applySaveChunk(onSame, entry, true);
    expect([...onSame.chunkKeys()]).toEqual([]);
    const onNew = createWorldStore(grid);
    onNew.importChunk(0, 0, 0, reexport);
    applySaveChunk(onNew, entry, false);
    const v = voxel();
    expect(onNew.voxelAt(5, 20, 5, v).material).toBe(2);
    expect(onNew.voxelAt(5, 3, 5, v).material).toBe(0);
    expect(onNew.voxelAt(9, 15, 9, v).material).toBe(0);
  });

  it('refuses a whole-chunk entry without changed cells, a uniform value the format does not hold, and air with a shape in a delta', () => {
    const base = rockTo(16);
    const now = rockTo(16);
    for (let i = 0; i < n; i++) [now.material[i], now.category[i], now.shape[i]] = [3, VOXEL_CATEGORY.construction, 255];
    const content = saveContentOf(grid, base, now)!;
    expect(content.kind).toBe('uniform');
    const worldId = Uint8Array.from({ length: 16 }, (_, i) => i);
    const write = (c: typeof content): Uint8Array => writeSave({ worldId, grid, chunks: [{ grid: 0, cx: 0, cy: 0, cz: 0, base: new Uint8Array(16), content: c }] }, 'none', (b) => b);
    const read = (b: Uint8Array): unknown => readSave(b, grid, worldId, (x) => x);
    expect(() => read(write(content))).not.toThrow();
    if (content.kind !== 'uniform') throw new Error('unreachable');
    expect(() => read(write({ ...content, mask: new Uint8Array(changedMaskBytes(grid)) }))).toThrow(/names no changed cell/);
    expect(() => read(write({ ...content, value: recordValue(3, VOXEL_CATEGORY_COUNT, 0) }))).toThrow(/save uniform entry: unassigned category 5/);
    expect(() => read(write({ ...content, value: recordValue(3, 1, ORIENTATION_COUNT) }))).toThrow(/orientation 24/);
    const airShape = new CellDelta();
    airShape.push(7, 0, 9);
    expect(() => CellDelta.decode(grid, airShape.encode())).toThrow(/cell 7 is air with shape 9/);
    const airCategory = new CellDelta();
    airCategory.push(7, recordValue(0, 1, 0), 0);
    expect(() => CellDelta.decode(grid, airCategory.encode())).toThrow(/cell delta: air with a category/);
  });
});

describe('record value form: every form holding raw values names it', () => {
  const worldId = Uint8Array.from({ length: 16 }, (_, i) => i);

  it('is 1 today, written by region files, saves, undo records and overrides; a newer one is refused', () => {
    expect(RECORD_VALUE_FORM).toBe(1);
    const { tile, bytes } = sampleRegion();
    expect(bytes[10]).toBe(RECORD_VALUE_FORM);
    const region2 = bytes.slice();
    region2[10] = 2;
    new DataView(region2.buffer).setUint32(60, crc32(region2.subarray(0, 60)), true);
    expect(() => RegionIndex.parse(region2, { expect: tile })).toThrow(/region file: record value form 2 \(this build reads 1 to 1\)/);

    const save = writeSave({ worldId, grid, chunks: [] }, 'none', (b) => b);
    expect(save[8]).toBe(RECORD_VALUE_FORM);
    const save2 = save.slice();
    save2[8] = 2;
    new DataView(save2.buffer).setUint32(40, crc32(save2.subarray(0, 40)), true);
    expect(() => readSave(save2, grid, worldId, (b) => b)).toThrow(/save: record value form 2/);

    const delta = new CellDelta();
    delta.push(3, recordValue(1, 1, 0), 255);
    const undo = encodeUndoRecord(grid, [{ grid: 0, cx: 0, cy: 0, cz: 0, before: { kind: 'delta', delta } }]);
    expect(undo[7]).toBe(RECORD_VALUE_FORM);
    const undo2 = undo.slice();
    undo2[7] = 2;
    new DataView(undo2.buffer).setUint32(undo2.length - 4, crc32(undo2.subarray(0, undo2.length - 4)), true);
    expect(() => decodeUndoRecord(grid, undo2)).toThrow(/undo record: record value form 2/);

    const o: StructureOverrides = { grid, gridId: 4, chunks: new Map([[0, { cx: 0, cy: 0, cz: 0, base: delta, value: delta }]]) };
    const ob = encodeOverrides(o);
    expect(ob[6]).toBe(RECORD_VALUE_FORM);
    const ob2 = ob.slice();
    ob2[6] = 2;
    new DataView(ob2.buffer).setUint32(ob2.length - 4, crc32(ob2.subarray(0, ob2.length - 4)), true);
    expect(() => decodeOverrides(grid, ob2)).toThrow(/structure overrides: record value form 2/);
  });

  it('region tables and overrides refuse values the format does not hold', () => {
    const { tile } = sampleRegion();
    const bad = writeRegion(tile, [{ cx: 16, cy: 0, cz: -16, uniform: recordValue(1, VOXEL_CATEGORY_COUNT, 0) }]);
    expect(() => RegionIndex.parse(bad, { expect: tile })).toThrow(RegionFileError);
    expect(() => RegionIndex.parse(bad, { expect: tile })).toThrow(/region file: entry 0: unassigned category 5/);
    const delta = new CellDelta();
    delta.push(3, recordValue(1, 1, ORIENTATION_COUNT), 255);
    const ok = new CellDelta();
    ok.push(3, recordValue(1, 1, 0), 255);
    expect(() => decodeOverrides(grid, encodeOverrides({ grid, gridId: 4, chunks: new Map([[0, { cx: 0, cy: 0, cz: 0, base: ok, value: delta }]]) }))).toThrow(/structure overrides: orientation 24/);
  });
});

describe('structure overrides: versions move forward through registered steps only', () => {
  it('has no steps at version 1, lifts an older version through appended steps and refuses a newer one', () => {
    expect(OVERRIDE_UPGRADES).toEqual([]);
    expect(Object.isFrozen(OVERRIDE_UPGRADES)).toBe(true);
    expect(SAVE_UPGRADES).toEqual([]);
    const a = new CellDelta();
    a.push(3, recordValue(1, 1, 0), 255);
    const b = new CellDelta();
    b.push(3, 0, 0);
    const bytes = encodeOverrides({ grid, gridId: 4, chunks: new Map([[0, { cx: 0, cy: 0, cz: 0, base: a, value: b }]]) });
    // A test-only step to a version 2 (never a real format): it renumbers the structure's grid.
    const step = (o: StructureOverrides): StructureOverrides => ({ ...o, gridId: o.gridId + 100 });
    expect(decodeOverrides(grid, bytes).gridId).toBe(4);
    expect(decodeOverrides(grid, bytes, [step]).gridId).toBe(104);
    const v2 = bytes.slice();
    v2[4] = 2;
    new DataView(v2.buffer).setUint32(v2.length - 4, crc32(v2.subarray(0, v2.length - 4)), true);
    expect(() => decodeOverrides(grid, v2)).toThrow(/unknown version 2 \(this build reads 1 to 1\)/);
    expect(decodeOverrides(grid, v2, [step]).gridId).toBe(4);
  });
});
