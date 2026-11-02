/**
 * Region files: one tile of one voxel grid on disk. DRAFT layout under
 * measurement, version 1 (all numbers little-endian):
 *
 *   0  'T' 'L' 'V' 'R'  magic
 *   4  u8   version (1; any other version is refused)
 *   5  u8   layout: 0 a full-height column, 1 a stacked cube of `side` chunks
 *   6  u8   chunk edge in cells
 *   7  u8   chunk codec version (palette-codec.ts)
 *   8  u8   compressor of stored chunks: 0 none, 1 zstd
 *   9  u8   side: chunks along each side of the region
 *  10  u16  reserved, zero
 *  12  16 B world id: with the grid id and the chunk coordinates, the
 *           world-scoped key of every chunk in the file
 *  28  u32  grid id: 0 the world grid, else a structure's own grid
 *  32  i32  rx, 36 i32 ry (0 in a column), 40 i32 rz: the region's index
 *  44  u32  entry count
 *  48  u32  data bytes (the stored chunks, back to back)
 *  52  u32  CRC-32 of the table
 *  56  u32  reserved, zero
 *  60  u32  CRC-32 of bytes 0–59
 *  64  table: one 12-byte entry per present chunk, then the data
 *
 * Entry: u16 column (bits 0–13: lx × side + lz; bit 14 stored without the
 * compressor; bit 15 uniform), i16 chunk y (the grid's chunk index), then
 * two u32: a uniform chunk's record value and 0, or a stored chunk's byte
 * length and the CRC-32 of its stored bytes. A chunk's offset is the sum of
 * the lengths before it, so it is never stored twice.
 *
 * Why it is shaped this way:
 * - All-air chunks are absent and a uniform chunk is its 12-byte entry, not a
 *   compressed frame (a 13-byte uniform chunk grows to 22 inside its own zstd
 *   frame), so tall empty sky and deep solid ground cost almost nothing.
 * - Entries sort by column then height and the data follows the table in the
 *   same order: one table read finds any chunk, a column is one byte range,
 *   and neighbouring columns sit close enough to coalesce range requests.
 * - Bytes are canonical: entries in that order, no duplicate, no air entry,
 *   no gap, no trailing byte, zero reserved fields, and a chunk is stored raw
 *   only when the compressor does not make it smaller. With canonical chunk
 *   bytes (palette-codec.ts) the same content gives the same file, whatever
 *   edits led to it; nothing in it is a time.
 * - Damage is found where it is: the header and the table carry their own
 *   CRCs (a damaged one refuses the file), every stored chunk carries one in
 *   its entry, so one damaged chunk is reported as damaged, never read as air.
 * - The transform of a structure's grid is not here: moving a structure
 *   changes its record, not its voxels, so its region files stay unchanged.
 */
import { crc32 } from '@thirdlight/shared';
import { chunkGrid, chunkInWorld, chunksPerRegionSide, type ChunkCoord, type ChunkGrid, type RegionFootprint } from './coords';
import { scratchImage, uniformImage } from './palette-chunk';
import { encodePaletteImage, PALETTE_CODEC_VERSION, readPaletteHeader } from './palette-codec';
import { recordValue } from './palette-image';
import { ALL_PLANES } from './record';

/** The region file version this build writes and reads. */
export const REGION_FORMAT_VERSION = 1;
/** Bytes of the fixed header. */
export const REGION_HEADER_BYTES = 64;
/** Bytes of one chunk table entry. */
export const REGION_ENTRY_BYTES = 12;
/** Bytes of a world id. */
export const WORLD_ID_BYTES = 16;
/** The grid id of the world grid (structures' own grids are 1 and up). */
export const WORLD_GRID_ID = 0;

const MAGIC = [0x54, 0x4c, 0x56, 0x52] as const;
const UNIFORM_BIT = 0x8000;
const RAW_BIT = 0x4000;
const COLUMN_MASK = 0x3fff;

/** How a region spans height: the grid's full height, or a cube of `side` chunks stacked with others. */
export type RegionLayout = 'column' | 'stacked';
const LAYOUTS: readonly RegionLayout[] = ['column', 'stacked'];

/** What stored chunks are compressed with. */
export type RegionCompressor = 'none' | 'zstd';
const COMPRESSORS: readonly RegionCompressor[] = ['none', 'zstd'];

/** Which tile of which grid of which world a region file holds. */
export interface RegionTile {
  readonly worldId: Uint8Array;
  readonly gridId: number;
  readonly layout: RegionLayout;
  readonly grid: ChunkGrid;
  readonly footprint: RegionFootprint;
  readonly rx: number;
  /** The stack index in the stacked layout; 0 in a column. */
  readonly ry: number;
  readonly rz: number;
  readonly compressor: RegionCompressor;
}

/** A region file's header as read. */
export interface RegionHeader extends RegionTile {
  readonly version: number;
  readonly side: number;
  readonly entryCount: number;
  readonly dataBytes: number;
}

/** A chunk to write: one voxel everywhere (its record value), or its stored bytes. */
export type RegionEntry =
  | { readonly cx: number; readonly cy: number; readonly cz: number; readonly uniform: number }
  | { readonly cx: number; readonly cy: number; readonly cz: number; readonly stored: Uint8Array; readonly raw: boolean };

/** A file the reader refuses as a whole (bad magic, unknown version, damaged header or table, wrong length). */
export class RegionFileError extends Error {
  override readonly name = 'RegionFileError';
}

/** A damaged chunk: reported with where it is, so the caller repairs or regenerates it instead of reading air. */
export class RegionChunkError extends Error {
  override readonly name = 'RegionChunkError';
  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
    reason: string,
  ) {
    super(`chunk (${cx}, ${cy}, ${cz}): ${reason}`);
  }
}

/** One chunk as read from a region file. */
export type RegionChunkRead =
  | { readonly cx: number; readonly cy: number; readonly cz: number; readonly kind: 'air' }
  | { readonly cx: number; readonly cy: number; readonly cz: number; readonly kind: 'uniform'; readonly value: number }
  | { readonly cx: number; readonly cy: number; readonly cz: number; readonly kind: 'stored'; readonly bytes: Uint8Array; readonly raw: boolean }
  | { readonly cx: number; readonly cy: number; readonly cz: number; readonly kind: 'damaged'; readonly reason: string };

/** Chunks along each side of a region of this tile. */
function sideOf(tile: Pick<RegionTile, 'grid' | 'footprint'>): number {
  return chunksPerRegionSide(tile.grid, tile.footprint);
}

/** Throws unless the chunk lies in the tile's region (and its stack, when stacked). */
function columnOf(tile: RegionTile, side: number, cx: number, cy: number, cz: number): number {
  const lx = cx - tile.rx * side;
  const lz = cz - tile.rz * side;
  const ly = cy - tile.ry * side;
  if (!chunkInWorld(tile.grid, cx, cy, cz)) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside the world`);
  if (lx < 0 || lx >= side || lz < 0 || lz >= side) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside region (${tile.rx}, ${tile.rz})`);
  if (tile.layout === 'stacked' && (ly < 0 || ly >= side)) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside stack ${tile.ry}`);
  return lx * side + lz;
}

function checkTile(tile: RegionTile): number {
  if (tile.worldId.length !== WORLD_ID_BYTES) throw new RangeError(`a world id is ${WORLD_ID_BYTES} bytes, got ${tile.worldId.length}`);
  if (!Number.isInteger(tile.gridId) || tile.gridId < 0 || tile.gridId > 0xffffffff) throw new RangeError(`grid id ${tile.gridId} is not a u32`);
  if (tile.layout === 'column' && tile.ry !== 0) throw new RangeError('a column region has ry 0');
  for (const v of [tile.rx, tile.ry, tile.rz]) if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new RangeError(`region index ${v} is not an i32`);
  const side = sideOf(tile);
  if (side * side > COLUMN_MASK + 1) throw new RangeError(`${side} chunks a side do not fit the column field`);
  return side;
}

/**
 * The bytes of a region file holding `entries` (in any order). Entries are
 * sorted into the canonical order; a duplicate chunk, an air entry (uniform
 * value 0), an empty stored chunk or a chunk outside the tile is refused.
 */
export function writeRegion(tile: RegionTile, entries: Iterable<RegionEntry>): Uint8Array {
  const side = checkTile(tile);
  const list = [...entries].map((e) => ({ e, col: columnOf(tile, side, e.cx, e.cy, e.cz) }));
  list.sort((a, b) => a.col - b.col || a.e.cy - b.e.cy);
  let dataBytes = 0;
  for (let k = 0; k < list.length; k++) {
    const { e, col } = list[k]!;
    if (k > 0 && list[k - 1]!.col === col && list[k - 1]!.e.cy === e.cy) throw new RangeError(`chunk (${e.cx}, ${e.cy}, ${e.cz}) given twice`);
    if ('uniform' in e) {
      if (!Number.isInteger(e.uniform) || e.uniform <= 0 || e.uniform > 0xffffffff) throw new RangeError(`chunk (${e.cx}, ${e.cy}, ${e.cz}): uniform value ${e.uniform} (air chunks are left out)`);
    } else {
      if (e.stored.length === 0) throw new RangeError(`chunk (${e.cx}, ${e.cy}, ${e.cz}): no stored bytes`);
      if (!e.raw && tile.compressor === 'none') throw new RangeError('a compressed chunk in a region without a compressor');
      dataBytes += e.stored.length;
    }
  }
  if (dataBytes > 0xffffffff) throw new RangeError('region data past 4 GB');
  const tableBytes = list.length * REGION_ENTRY_BYTES;
  const out = new Uint8Array(REGION_HEADER_BYTES + tableBytes + dataBytes);
  const view = new DataView(out.buffer);
  let t = REGION_HEADER_BYTES;
  let d = REGION_HEADER_BYTES + tableBytes;
  for (const { e, col } of list) {
    if ('uniform' in e) {
      view.setUint16(t, col | UNIFORM_BIT, true);
      view.setInt16(t + 2, e.cy, true);
      view.setUint32(t + 4, e.uniform, true);
      view.setUint32(t + 8, 0, true);
    } else {
      view.setUint16(t, col | (e.raw ? RAW_BIT : 0), true);
      view.setInt16(t + 2, e.cy, true);
      view.setUint32(t + 4, e.stored.length, true);
      view.setUint32(t + 8, crc32(e.stored), true);
      out.set(e.stored, d);
      d += e.stored.length;
    }
    t += REGION_ENTRY_BYTES;
  }
  MAGIC.forEach((b, i) => (out[i] = b));
  out[4] = REGION_FORMAT_VERSION;
  out[5] = LAYOUTS.indexOf(tile.layout);
  out[6] = tile.grid.edge;
  out[7] = PALETTE_CODEC_VERSION;
  out[8] = COMPRESSORS.indexOf(tile.compressor);
  out[9] = side;
  out.set(tile.worldId, 12);
  view.setUint32(28, tile.gridId, true);
  view.setInt32(32, tile.rx, true);
  view.setInt32(36, tile.ry, true);
  view.setInt32(40, tile.rz, true);
  view.setUint32(44, list.length, true);
  view.setUint32(48, dataBytes, true);
  view.setUint32(52, crc32(out.subarray(REGION_HEADER_BYTES, REGION_HEADER_BYTES + tableBytes)), true);
  view.setUint32(60, crc32(out.subarray(0, 60)), true);
  return out;
}

/**
 * A chunk's entry from its palette codec bytes: a uniform chunk becomes its
 * record value; any other is compressed, and kept raw when compressing does
 * not make it smaller (a pure function of the bytes, so files stay canonical).
 */
export function packRegionChunk(grid: ChunkGrid, cx: number, cy: number, cz: number, codecBytes: Uint8Array, compressor: RegionCompressor, compress: (b: Uint8Array) => Uint8Array): RegionEntry {
  const h = readPaletteHeader(grid, codecBytes);
  if (h.body === 'uniform') {
    if (h.planes !== ALL_PLANES) throw new RangeError('a region chunk holds every plane');
    const view = new DataView(codecBytes.buffer, codecBytes.byteOffset, codecBytes.byteLength);
    const value = recordValue(view.getUint16(8, true), codecBytes[10]!, codecBytes[12]!);
    if (value === 0) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is air: leave it out`);
    return { cx, cy, cz, uniform: value };
  }
  if (compressor === 'none') return { cx, cy, cz, stored: codecBytes, raw: true };
  const packed = compress(codecBytes);
  return packed.length < codecBytes.length ? { cx, cy, cz, stored: packed, raw: false } : { cx, cy, cz, stored: codecBytes, raw: true };
}

/** Reads and checks a region file's 64-byte header. */
export function readRegionHeader(bytes: Uint8Array): RegionHeader & { readonly tableCrc: number } {
  if (bytes.length < REGION_HEADER_BYTES) throw new RegionFileError('region file: shorter than its header');
  if (!MAGIC.every((b, i) => bytes[i] === b)) throw new RegionFileError('region file: bad magic');
  if (bytes[4] !== REGION_FORMAT_VERSION) throw new RegionFileError(`region file: unknown version ${bytes[4]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, REGION_HEADER_BYTES);
  if (crc32(bytes.subarray(0, 60)) !== view.getUint32(60, true)) throw new RegionFileError('region file: header checksum mismatch');
  const layout = LAYOUTS[bytes[5]!];
  const compressor = COMPRESSORS[bytes[8]!];
  if (layout === undefined) throw new RegionFileError(`region file: unknown layout ${bytes[5]}`);
  if (compressor === undefined) throw new RegionFileError(`region file: unknown compressor ${bytes[8]}`);
  if (bytes[7] !== PALETTE_CODEC_VERSION) throw new RegionFileError(`region file: unknown chunk codec version ${bytes[7]}`);
  if (view.getUint16(10, true) !== 0 || view.getUint32(56, true) !== 0) throw new RegionFileError('region file: reserved bytes set');
  const edge = bytes[6];
  if (edge !== 16 && edge !== 32) throw new RegionFileError(`region file: chunk edge ${edge}`);
  const side = bytes[9]!;
  const footprint = side * edge;
  if (footprint !== 512 && footprint !== 1024) throw new RegionFileError(`region file: footprint of ${footprint} cells`);
  const ry = view.getInt32(36, true);
  if (layout === 'column' && ry !== 0) throw new RegionFileError('region file: a column with a stack index');
  return {
    version: REGION_FORMAT_VERSION,
    layout,
    grid: chunkGrid(edge),
    footprint,
    side,
    compressor,
    worldId: bytes.slice(12, 28),
    gridId: view.getUint32(28, true),
    rx: view.getInt32(32, true),
    ry,
    rz: view.getInt32(40, true),
    entryCount: view.getUint32(44, true),
    dataBytes: view.getUint32(48, true),
    tableCrc: view.getUint32(52, true),
  };
}

/** A byte range of a region file to fetch, covering the stored bytes of one or more table entries. */
export interface RegionRange {
  readonly start: number;
  readonly end: number;
  readonly entries: readonly number[];
}

/**
 * A region file's header and chunk table, parsed and checked: finds chunks,
 * gives their byte ranges (coalesced for range requests) and checks their
 * bytes. Holds no chunk data.
 */
export class RegionIndex {
  readonly header: RegionHeader;
  private readonly cols: Uint16Array;
  private readonly cys: Int16Array;
  private readonly flags: Uint8Array;
  private readonly a: Uint32Array;
  private readonly b: Uint32Array;
  /** Byte offset in the file of each entry's stored bytes (uniform entries: the next one's). */
  private readonly offsets: Float64Array;

  private constructor(header: RegionHeader, table: Uint8Array) {
    this.header = header;
    const n = header.entryCount;
    this.cols = new Uint16Array(n);
    this.cys = new Int16Array(n);
    this.flags = new Uint8Array(n);
    this.a = new Uint32Array(n);
    this.b = new Uint32Array(n);
    this.offsets = new Float64Array(n + 1);
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const side = header.side;
    let at = REGION_HEADER_BYTES + n * REGION_ENTRY_BYTES;
    for (let i = 0; i < n; i++) {
      const o = i * REGION_ENTRY_BYTES;
      const word = view.getUint16(o, true);
      const col = word & COLUMN_MASK;
      const cy = view.getInt16(o + 2, true);
      const a = view.getUint32(o + 4, true);
      const b = view.getUint32(o + 8, true);
      const uniform = (word & UNIFORM_BIT) !== 0;
      const raw = (word & RAW_BIT) !== 0;
      if (col >= side * side) throw new RegionFileError(`region file: entry ${i} names column ${col} of ${side * side}`);
      if (i > 0 && (col < this.cols[i - 1]! || (col === this.cols[i - 1]! && cy <= this.cys[i - 1]!))) throw new RegionFileError(`region file: entry ${i} out of order or repeated`);
      const ly = cy - header.ry * side;
      if (header.layout === 'stacked' && (ly < 0 || ly >= side)) throw new RegionFileError(`region file: entry ${i} outside its stack`);
      if (uniform && (raw || a === 0 || b !== 0)) throw new RegionFileError(`region file: entry ${i} is not a valid uniform chunk`);
      if (!uniform && a === 0) throw new RegionFileError(`region file: entry ${i} stores no bytes`);
      if (!uniform && !raw && header.compressor === 'none') throw new RegionFileError(`region file: entry ${i} compressed without a compressor`);
      this.cols[i] = col;
      this.cys[i] = cy;
      this.flags[i] = (uniform ? 1 : 0) | (raw ? 2 : 0);
      this.a[i] = a;
      this.b[i] = b;
      this.offsets[i] = at;
      if (!uniform) at += a;
    }
    this.offsets[n] = at;
    if (at - REGION_HEADER_BYTES - n * REGION_ENTRY_BYTES !== header.dataBytes) throw new RegionFileError('region file: chunk lengths do not add up to the data bytes');
  }

  /** Bytes from the start of the file that hold the header and the table. */
  static tableEnd(header: RegionHeader): number {
    return REGION_HEADER_BYTES + header.entryCount * REGION_ENTRY_BYTES;
  }

  /** Parses the header and table from the start of a file (`bytes` holds at least both). */
  static parse(bytes: Uint8Array): RegionIndex {
    const h = readRegionHeader(bytes);
    const end = RegionIndex.tableEnd(h);
    if (bytes.length < end) throw new RegionFileError('region file: table truncated');
    const table = bytes.subarray(REGION_HEADER_BYTES, end);
    if (crc32(table) !== h.tableCrc) throw new RegionFileError('region file: table checksum mismatch');
    return new RegionIndex(h, table);
  }

  /** The whole file's length in bytes (a file of any other length is refused). */
  get fileBytes(): number {
    return this.offsets[this.header.entryCount]!;
  }

  get size(): number {
    return this.header.entryCount;
  }

  /** The table index of a chunk, or −1 when it is absent (air). */
  find(cx: number, cy: number, cz: number): number {
    const h = this.header;
    const lx = cx - h.rx * h.side;
    const lz = cz - h.rz * h.side;
    if (lx < 0 || lx >= h.side || lz < 0 || lz >= h.side) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside region (${h.rx}, ${h.rz})`);
    const col = lx * h.side + lz;
    let lo = 0;
    let hi = h.entryCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.cols[mid]! - col || this.cys[mid]! - cy;
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** The chunk coordinates of entry `i`. */
  coordOf(i: number, out: ChunkCoord = { cx: 0, cy: 0, cz: 0 }): ChunkCoord {
    const h = this.header;
    const col = this.cols[i]!;
    out.cx = h.rx * h.side + Math.floor(col / h.side);
    out.cz = h.rz * h.side + (col % h.side);
    out.cy = this.cys[i]!;
    return out;
  }

  isUniform(i: number): boolean {
    return (this.flags[i]! & 1) !== 0;
  }

  /** Stored bytes of entry `i` (0 for a uniform chunk). */
  storedBytes(i: number): number {
    return this.isUniform(i) ? 0 : this.a[i]!;
  }

  /** Where entry `i`'s stored bytes start in the file. */
  offsetOf(i: number): number {
    return this.offsets[i]!;
  }

  /**
   * The byte ranges holding the given entries' stored bytes, joined when the
   * gap between two is at most `maxGap` bytes (fewer requests for a few
   * wasted bytes). Uniform entries need no bytes and are left out.
   */
  ranges(entries: readonly number[], maxGap: number): RegionRange[] {
    const stored = [...new Set(entries)].filter((i) => !this.isUniform(i)).sort((x, y) => x - y);
    const out: { start: number; end: number; entries: number[] }[] = [];
    for (const i of stored) {
      const start = this.offsets[i]!;
      const end = start + this.a[i]!;
      const last = out[out.length - 1];
      if (last !== undefined && start - last.end <= maxGap) {
        last.end = end;
        last.entries.push(i);
      } else out.push({ start, end, entries: [i] });
    }
    return out;
  }

  /**
   * Entry `i` read from `bytes`, which hold the file from offset `at`
   * (the whole file: `at` = 0). A stored chunk whose bytes fail its checksum
   * or fall outside `bytes` is reported damaged.
   */
  read(i: number, bytes: Uint8Array, at = 0): RegionChunkRead {
    const { cx, cy, cz } = this.coordOf(i);
    if (this.isUniform(i)) return { cx, cy, cz, kind: 'uniform', value: this.a[i]! };
    const start = this.offsets[i]! - at;
    const end = start + this.a[i]!;
    if (start < 0 || end > bytes.length) return { cx, cy, cz, kind: 'damaged', reason: 'stored bytes missing (file or range too short)' };
    const stored = bytes.subarray(start, end);
    if (crc32(stored) !== this.b[i]) return { cx, cy, cz, kind: 'damaged', reason: 'stored bytes checksum mismatch' };
    return { cx, cy, cz, kind: 'stored', bytes: stored, raw: (this.flags[i]! & 2) !== 0 };
  }
}

/**
 * The palette codec bytes of a chunk read from a region file, decompressed
 * and their header checked. A damaged chunk, or one whose bytes do not
 * decompress or decode as a chunk of `grid`, throws {@link RegionChunkError};
 * an air read returns null.
 */
export function regionChunkCodecBytes(grid: ChunkGrid, read: RegionChunkRead, decompress: (b: Uint8Array) => Uint8Array): Uint8Array | null {
  const { cx, cy, cz } = read;
  switch (read.kind) {
    case 'air':
      return null;
    case 'damaged':
      throw new RegionChunkError(cx, cy, cz, read.reason);
    case 'uniform': {
      const img = scratchImage(grid);
      uniformImage(img, read.value);
      return encodePaletteImage(img, ALL_PLANES, 'packed');
    }
    case 'stored': {
      let bytes: Uint8Array;
      try {
        bytes = read.raw ? read.bytes : decompress(read.bytes);
        readPaletteHeader(grid, bytes);
      } catch (e) {
        throw new RegionChunkError(cx, cy, cz, e instanceof Error ? e.message : String(e));
      }
      return bytes;
    }
  }
}

/** Where a region file reads its bytes from: a file on disk, an HTTP server with range requests, memory. */
export interface RegionByteSource {
  /** Up to `length` bytes from `offset` (fewer only at the end of the file). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Bytes the opening read asks for: the header and, for most files, the whole table in one request. */
export const REGION_OPEN_PREFETCH = 32 * 1024;

/** Reads a region file's header and table: one request when they fit `prefetch` bytes, else two. */
export async function openRegion(source: RegionByteSource, prefetch = REGION_OPEN_PREFETCH): Promise<RegionIndex> {
  const first = await source.read(0, Math.max(REGION_HEADER_BYTES, prefetch));
  const h = readRegionHeader(first);
  const end = RegionIndex.tableEnd(h);
  if (first.length >= end) return RegionIndex.parse(first);
  const rest = await source.read(first.length, end - first.length);
  const all = new Uint8Array(end);
  all.set(first);
  all.set(rest, first.length);
  return RegionIndex.parse(all);
}

/**
 * Reads the given chunks: absent ones as air, uniform ones from the table,
 * stored ones through coalesced range requests (gaps up to `maxGap` bytes
 * are read and discarded). Every requested chunk gets one result in the
 * order asked; a damaged chunk is reported, never skipped.
 */
export async function readRegionChunks(source: RegionByteSource, index: RegionIndex, chunks: readonly ChunkCoord[], maxGap = 4096): Promise<RegionChunkRead[]> {
  const found = chunks.map((c) => index.find(c.cx, c.cy, c.cz));
  const ranges = index.ranges(
    found.filter((i) => i >= 0),
    maxGap,
  );
  const got = await Promise.all(ranges.map((r) => source.read(r.start, r.end - r.start)));
  const where = new Map<number, { bytes: Uint8Array; at: number }>();
  ranges.forEach((r, k) => {
    for (const i of r.entries) where.set(i, { bytes: got[k]!, at: r.start });
  });
  return chunks.map((c, k) => {
    const i = found[k]!;
    if (i < 0) return { cx: c.cx, cy: c.cy, cz: c.cz, kind: 'air' };
    const w = where.get(i);
    return w === undefined ? index.read(i, new Uint8Array(0)) : index.read(i, w.bytes, w.at);
  });
}

/** Every damaged chunk of a whole file (the header and table must be sound: else it throws {@link RegionFileError}). */
export function damagedRegionChunks(bytes: Uint8Array): RegionChunkError[] {
  const index = RegionIndex.parse(bytes);
  if (bytes.length !== index.fileBytes) throw new RegionFileError(`region file: ${bytes.length} bytes, its table says ${index.fileBytes}`);
  const out: RegionChunkError[] = [];
  for (let i = 0; i < index.size; i++) {
    const r = index.read(i, bytes);
    if (r.kind === 'damaged') out.push(new RegionChunkError(r.cx, r.cy, r.cz, r.reason));
  }
  return out;
}

/**
 * The file name of a region inside its grid's folder: `r.<x>.<z>.vxr` for a
 * column, `r.<x>.<y>.<z>.vxr` for a stack. A world keeps its world grid in
 * one folder and each structure grid in a folder named by its grid id.
 */
export function regionFileName(layout: RegionLayout, rx: number, ry: number, rz: number): string {
  return layout === 'column' ? `r.${rx}.${rz}.vxr` : `r.${rx}.${ry}.${rz}.vxr`;
}
