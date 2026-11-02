/**
 * The palette chunk codec: one chunk's bytes at rest (before the general
 * compressor). DRAFT layout, version 1:
 *
 *   0  'V' 'C'        magic
 *   2  version        1
 *   3  flags          bits 0–3 planes held (material, category, shape,
 *                     orientation); bit 4 chunk edge 32 (else 16); bits 5–6
 *                     body: 0 uniform, 1 bit-packed ids (2 and 3 are
 *                     measurement bodies, see palette-codec-measure.ts);
 *                     bit 7 per-plane palettes (measurement only)
 *   4  CRC-32         of every byte after the header (little-endian)
 *   8  body
 *
 * World data holds every plane in one record palette, so its flags are
 * 0x0F/0x1F (uniform) or 0x2F/0x3F (packed) at edge 16/32. This module
 * reads and writes only that; the measurement options (column runs, bricks
 * at rest, per-plane palettes, dropped planes) share the header but are
 * refused here, and only the bench entry decodes them.
 *
 * Uniform body: material u24, category u8, shape u8 (the implied one),
 * orientation u8. Packed body: entry count − 1 (u16), every entry's
 * material (u24 each), category (u8 each), orientation (u8 each), the
 * density flags as a bitset, the cells' entry ids bit-packed at the
 * palette's width (cell i at bit i × width, least significant first), then
 * the density bytes of the flagged cells in cell order.
 *
 * Every field is written as its own plane so the general compressor sees
 * runs of like values. Bytes are canonical, and the decoder refuses any
 * other byte string: entries numbered in order of first appearance, none
 * unused or repeated, a stored density never equal to the implied one, a
 * chunk of one entry without densities is a uniform body, air is one value
 * (every field 0, never flagged), and every field holds an assigned value.
 * So one chunk content has one byte string, and region files can be
 * deterministic.
 *
 * Versions only move forward through registered upgrade steps
 * ({@link CHUNK_CODEC_UPGRADES}): bytes of an older version are lifted to
 * this version before they are read, bytes of a newer one are refused.
 */
import { crc32 } from '@thirdlight/shared';
import type { ChunkGrid } from './coords';
import { liftVersion, type UpgradeStep } from './format-upgrade';
import { CATEGORY_SHIFT, ORIENTATION_SHIFT, recordValue, valueCategory, valueMaterial, valueOrientation, type ChunkImage, type PaletteKind } from './palette-image';
import type { PlaneImage } from './palette-plane';
import { MAX_PALETTE, packedWidth } from './packed-width';
import { ALL_PLANES, MATERIAL_AIR, MATERIAL_ID_MAX, ORIENTATION_COUNT, PLANE_BIT, VOXEL_CATEGORY_COUNT } from './record';
import { impliedShape } from './surface-density';
import type { LayoutKind } from './cell-layout';

export const MAGIC0 = 0x56;
export const MAGIC1 = 0x43;
/** The codec version this build writes and reads. */
export const PALETTE_CODEC_VERSION = 1;
export const HEADER = 8;
export const EDGE32 = 1 << 4;
export const BODY_SHIFT = 5;
export const PER_PLANE = 1 << 7;

/**
 * Upgrade steps of the chunk codec, keyed by the version they lift from;
 * only ever added to. A step takes a whole chunk's bytes of its version and
 * returns the same content's bytes of the next version (header and CRC
 * included). Version 1 is the first, so there are none yet.
 */
export const CHUNK_CODEC_UPGRADES: readonly UpgradeStep<Uint8Array>[] = Object.freeze([]);

export const BODY: Readonly<Record<'uniform' | LayoutKind, number>> = Object.freeze({ uniform: 0, packed: 1, runs: 2, bricks: 3 });
export const BODY_NAMES: readonly ('uniform' | LayoutKind)[] = ['uniform', 'packed', 'runs', 'bricks'];

/** What a chunk's bytes hold, as read from its header. */
export interface PaletteCodecHeader {
  planes: number;
  edge: 16 | 32;
  body: 'uniform' | LayoutKind;
  kind: PaletteKind;
}

/**
 * A field of a palette entry: its plane, byte width at rest, the bit it
 * starts at in the entry value and the largest value it may hold (a larger
 * one is refused on read, before it could spill into another field).
 */
export interface Field {
  bit: number;
  bytes: 1 | 3;
  shift: number;
  max: number;
}

export const MATERIAL: Field = { bit: PLANE_BIT.material, bytes: 3, shift: 0, max: MATERIAL_ID_MAX };
export const CATEGORY_FIELD: Field = { bit: PLANE_BIT.category, bytes: 1, shift: CATEGORY_SHIFT, max: VOXEL_CATEGORY_COUNT - 1 };
export const ORIENTATION_FIELD: Field = { bit: PLANE_BIT.orientation, bytes: 1, shift: ORIENTATION_SHIFT, max: ORIENTATION_COUNT - 1 };
/** A record value holds material, category and orientation ({@link recordValue}). */
export const RECORD_FIELDS: readonly Field[] = [MATERIAL, CATEGORY_FIELD, ORIENTATION_FIELD];

function fieldOf(f: Field, v: number): number {
  return f === MATERIAL ? valueMaterial(v) : f === CATEGORY_FIELD ? valueCategory(v) : f === ORIENTATION_FIELD ? valueOrientation(v) : v >>> f.shift;
}

export class Writer {
  at = 0;
  constructor(readonly buf: Uint8Array) {}
  u8(v: number): void {
    this.buf[this.at++] = v;
  }
  u16(v: number): void {
    this.buf[this.at++] = v & 0xff;
    this.buf[this.at++] = v >>> 8;
  }
  u24(v: number): void {
    this.buf[this.at++] = v & 0xff;
    this.buf[this.at++] = (v >>> 8) & 0xff;
    this.buf[this.at++] = v >>> 16;
  }
}

export class Reader {
  at: number;
  constructor(
    readonly buf: Uint8Array,
    start: number,
  ) {
    this.at = start;
  }
  need(n: number): void {
    if (this.at + n > this.buf.length) throw new RangeError('palette chunk bytes: truncated');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.at++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.buf[this.at]! | (this.buf[this.at + 1]! << 8);
    this.at += 2;
    return v;
  }
  u24(): number {
    this.need(3);
    const v = this.buf[this.at]! | (this.buf[this.at + 1]! << 8) | (this.buf[this.at + 2]! << 16);
    this.at += 3;
    return v;
  }
}

/** Scratch output per chunk edge, sized for the worst case of any body. */
const outScratch = new Map<number, Uint8Array>();

export function scratchOut(grid: ChunkGrid): Uint8Array {
  let b = outScratch.get(grid.edge);
  if (b === undefined) {
    const n = grid.cellsPerChunk;
    // Header, three palettes of up to n entries (5 bytes of fields and a flag bit each, ids as runs: 3 bytes a cell and a byte a column), densities.
    b = new Uint8Array(HEADER + 3 * (2 + n * 8 + Math.ceil(n / 8) + grid.edge * grid.edge) + n);
    outScratch.set(grid.edge, b);
  }
  return b;
}

/** Writes the header (magic, version, flags, CRC of the body) and returns the bytes. */
export function finishChunkBytes(w: Writer, flags: number): Uint8Array {
  const out = w.buf.slice(0, w.at);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = PALETTE_CODEC_VERSION;
  out[3] = flags;
  const crc = crc32(out.subarray(HEADER));
  out[4] = crc & 0xff;
  out[5] = (crc >>> 8) & 0xff;
  out[6] = (crc >>> 16) & 0xff;
  out[7] = crc >>> 24;
  return out;
}

/** The flags byte of an encoding. */
export function chunkFlags(grid: ChunkGrid, planes: number, body: 'uniform' | LayoutKind, perPlane: boolean): number {
  return planes | (grid.edge === 32 ? EDGE32 : 0) | (BODY[body] << BODY_SHIFT) | (perPlane ? PER_PLANE : 0);
}

/** Writes a palette's entry count, its held fields (each its own plane) and, when asked, the density flags. */
export function writePaletteHead(w: Writer, p: PlaneImage, fields: readonly Field[], withFlags: boolean): void {
  const count = p.count;
  w.u16(count - 1);
  for (const f of fields) {
    for (let e = 0; e < count; e++) {
      const v = fieldOf(f, p.values[e]!);
      if (f.bytes === 3) w.u24(v);
      else w.u8(v);
    }
  }
  if (withFlags) {
    for (let e = 0; e < count; e += 8) {
      let b = 0;
      for (let j = 0; j < 8 && e + j < count; j++) b |= p.flags[e + j]! << j;
      w.u8(b);
    }
  }
}

/** The cells' entry ids bit-packed at the palette's width. */
export function writePackedIds(w: Writer, grid: ChunkGrid, ids: Uint16Array, count: number): void {
  const n = grid.cellsPerChunk;
  const width = packedWidth(count);
  if (width === 0) return;
  if (width >= 8) {
    for (let i = 0; i < n; i++) (width === 8 ? w.u8(ids[i]!) : w.u16(ids[i]!));
    return;
  }
  const per = 8 / width;
  for (let i = 0; i < n; i += per) {
    let b = 0;
    for (let j = 0; j < per; j++) b |= ids[i + j]! << (j * width);
    w.u8(b);
  }
}

/** Reads what {@link writePaletteHead} wrote; fields not in `planes` read 0. */
export function readPaletteHead(r: Reader, grid: ChunkGrid, p: PlaneImage, fields: readonly Field[], planes: number, withFlags: boolean): void {
  const n = grid.cellsPerChunk;
  const count = r.u16() + 1;
  if (count > n || count > MAX_PALETTE) throw new RangeError(`palette chunk bytes: ${count} palette entries for ${n} cells`);
  p.count = count;
  p.values.fill(0, 0, count);
  for (const f of fields) {
    if (!(planes & f.bit)) continue;
    for (let e = 0; e < count; e++) {
      const v = f.bytes === 3 ? r.u24() : r.u8();
      if (v > f.max) checkFields(f.bit === PLANE_BIT.material ? v : 0, f.bit === PLANE_BIT.category ? v : 0, f.bit === PLANE_BIT.orientation ? v : 0);
      p.values[e] = (p.values[e]! | (v << f.shift)) >>> 0;
    }
  }
  for (let e = 0; e < count; e++) p.flags[e] = 0;
  if (withFlags) {
    for (let e = 0; e < count; e += 8) {
      const b = r.u8();
      for (let j = 0; j < 8 && e + j < count; j++) p.flags[e + j] = (b >>> j) & 1;
      if (b >>> Math.min(8, count - e) !== 0) throw new RangeError('palette chunk bytes: flag bits past the palette');
    }
  }
}

/** Reads what {@link writePackedIds} wrote. */
export function readPackedIds(r: Reader, grid: ChunkGrid, ids: Uint16Array, count: number): void {
  const n = grid.cellsPerChunk;
  const width = packedWidth(count);
  if (width === 0) ids.fill(0, 0, n);
  else if (width >= 8) for (let i = 0; i < n; i++) ids[i] = width === 8 ? r.u8() : r.u16();
  else {
    const per = 8 / width;
    const m = (1 << width) - 1;
    for (let i = 0; i < n; i += per) {
      const b = r.u8();
      for (let j = 0; j < per; j++) ids[i + j] = (b >>> (j * width)) & m;
    }
  }
}

/** Reads the density bytes of the flagged cells into `img` (the flags live on `flagged`'s entries). */
export function readDensities(r: Reader, img: ChunkImage, flagged: PlaneImage, materialOf: (v: number) => number): void {
  const n = img.grid.cellsPerChunk;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    const e = flagged.ids[i]!;
    if (!flagged.flags[e]) continue;
    const s = r.u8();
    if (s === impliedShape(materialOf(flagged.values[e]!))) throw new RangeError('palette chunk bytes: stored density equals the implied one');
    img.densCells[dc] = i;
    img.densValues[dc] = s;
    dc++;
  }
  img.densCount = dc;
}

/** Entries numbered by first appearance, each used, none repeated; fills the entry counts. */
export function checkCanonical(p: PlaneImage, n: number, record: boolean): void {
  p.counts.fill(0, 0, p.count);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const e = p.ids[i]!;
    if (e >= p.count) throw new RangeError(`palette chunk bytes: entry ${e} past a palette of ${p.count}`);
    if (e === next) next++;
    else if (e > next) throw new RangeError('palette chunk bytes: entries not in order of first appearance');
    p.counts[e]!++;
  }
  if (next !== p.count) throw new RangeError('palette chunk bytes: unused palette entries');
  const seen = new Set<number>();
  for (let e = 0; e < p.count; e++) {
    const key = p.values[e]! + (p.flags[e] ? 4294967296 : 0);
    if (seen.has(key)) throw new RangeError(`palette chunk bytes: repeated ${record ? 'record' : 'plane'} palette entry`);
    seen.add(key);
  }
}

/** Throws unless material, category and orientation fit their widths and assigned values (before they are packed). */
export function checkFields(m: number, c: number, o: number): void {
  if (m > MATERIAL_ID_MAX) throw new RangeError(`palette chunk bytes: material ${m} past its largest value ${MATERIAL_ID_MAX}`);
  if (c >= VOXEL_CATEGORY_COUNT) throw new RangeError(`palette chunk bytes: unassigned category ${c}`);
  if (o >= ORIENTATION_COUNT) throw new RangeError(`palette chunk bytes: orientation ${o} is not one of the ${ORIENTATION_COUNT} rotations`);
}

/**
 * Throws unless a record value is one the format can hold: air is one value
 * (every field 0, no density), and category and orientation hold assigned
 * values only.
 */
export function checkRecordValue(v: number, flagged: boolean): void {
  if (valueMaterial(v) === MATERIAL_AIR) {
    if (v !== 0 || flagged) throw new RangeError('palette chunk bytes: air with a category, orientation or density');
    return;
  }
  if (valueCategory(v) >= VOXEL_CATEGORY_COUNT) throw new RangeError(`palette chunk bytes: unassigned category ${valueCategory(v)}`);
  if (valueOrientation(v) >= ORIENTATION_COUNT) throw new RangeError(`palette chunk bytes: orientation ${valueOrientation(v)} is not one of the ${ORIENTATION_COUNT} rotations`);
}

/**
 * Lifts a chunk's bytes of an older codec version to this version through
 * `upgrades` (the bytes themselves when they are of this version). Refuses
 * bytes that are not a chunk, of a newer version, or of a version no
 * registered step lifts.
 */
export function liftChunkBytes(bytes: Uint8Array, upgrades: readonly UpgradeStep<Uint8Array>[] = CHUNK_CODEC_UPGRADES): Uint8Array {
  if (bytes.length < HEADER) throw new RangeError('palette chunk bytes: shorter than the header');
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) throw new RangeError('palette chunk bytes: bad magic');
  return liftVersion('palette chunk bytes', bytes[2]!, PALETTE_CODEC_VERSION, upgrades, bytes, (b) => b[2]!);
}

/**
 * Reads a chunk's header (magic, version, flags, checksum) of this codec
 * version, any body, checked against the grid it is decoded into.
 */
export function readAnyPaletteHeader(grid: ChunkGrid, bytes: Uint8Array): PaletteCodecHeader {
  if (bytes.length < HEADER) throw new RangeError('palette chunk bytes: shorter than the header');
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) throw new RangeError('palette chunk bytes: bad magic');
  if (bytes[2] !== PALETTE_CODEC_VERSION) throw new RangeError(`palette chunk bytes: version ${bytes[2]}, this build reads ${PALETTE_CODEC_VERSION}`);
  const flags = bytes[3]!;
  const planes = flags & 15;
  const edge = flags & EDGE32 ? 32 : 16;
  const body = BODY_NAMES[(flags >>> BODY_SHIFT) & 3]!;
  if ((planes & PLANE_BIT.material) === 0) throw new RangeError('palette chunk bytes: no material plane');
  if (edge !== grid.edge) throw new RangeError(`palette chunk bytes: a ${edge}³ chunk, decoding into ${grid.edge}³`);
  if (body === 'uniform' && flags & PER_PLANE) throw new RangeError('palette chunk bytes: uniform body with per-plane flag');
  const crc = (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0;
  if (crc32(bytes.subarray(HEADER)) !== crc) throw new RangeError('palette chunk bytes: checksum mismatch');
  return { planes, edge, body, kind: flags & PER_PLANE ? 'planes' : 'record' };
}

/** Throws unless a header is world data's: every plane, one record palette, a uniform or packed body. */
function checkWorldHeader(h: PaletteCodecHeader): void {
  if (h.planes !== ALL_PLANES || h.kind !== 'record' || (h.body !== 'uniform' && h.body !== 'packed')) {
    throw new RangeError(`palette chunk bytes: a measurement encoding (${h.kind} palette, ${h.body} body, planes ${h.planes}), not world data`);
  }
}

/**
 * Reads and checks a world chunk's header (lifting older versions first):
 * every plane, one record palette, a uniform or packed body, the grid's
 * chunk edge, a sound checksum.
 */
export function readPaletteHeader(grid: ChunkGrid, bytes: Uint8Array, upgrades: readonly UpgradeStep<Uint8Array>[] = CHUNK_CODEC_UPGRADES): PaletteCodecHeader {
  const h = readAnyPaletteHeader(grid, liftChunkBytes(bytes, upgrades));
  checkWorldHeader(h);
  return h;
}

/** Whether an image is one voxel (one palette entry everywhere, no surface voxel). */
export function imageIsUniform(img: ChunkImage): boolean {
  if (img.densCount > 0) return false;
  return img.kind === 'record' ? img.planes[0].count === 1 : img.planes.every((p) => p.count === 1);
}

/**
 * The world bytes of a canonical record image (as {@link recordImageFromCells}
 * builds it with every plane): a uniform body when it is one voxel, else
 * the packed body.
 */
export function encodePaletteImage(img: ChunkImage): Uint8Array {
  if (img.kind !== 'record') throw new RangeError('world chunk bytes hold one record palette');
  const grid = img.grid;
  const w = new Writer(scratchOut(grid));
  w.at = HEADER;
  const p = img.planes[0];
  if (imageIsUniform(img)) {
    const v = p.values[0]!;
    const m = valueMaterial(v);
    w.u24(m);
    w.u8(valueCategory(v));
    w.u8(impliedShape(m));
    w.u8(valueOrientation(v));
    return finishChunkBytes(w, chunkFlags(grid, ALL_PLANES, 'uniform', false));
  }
  writePaletteHead(w, p, RECORD_FIELDS, true);
  writePackedIds(w, grid, p.ids, p.count);
  for (let k = 0; k < img.densCount; k++) w.u8(img.densValues[k]!);
  return finishChunkBytes(w, chunkFlags(grid, ALL_PLANES, 'packed', false));
}

/**
 * Decodes a world chunk's bytes into `img` (a record image; older versions
 * lifted first). Refuses bytes that are short, long, damaged, of a newer or
 * unliftable version or another chunk edge, a measurement encoding, or not
 * canonical.
 */
export function decodePaletteImage(bytes: Uint8Array, img: ChunkImage, upgrades: readonly UpgradeStep<Uint8Array>[] = CHUNK_CODEC_UPGRADES): PaletteCodecHeader {
  const grid = img.grid;
  const lifted = liftChunkBytes(bytes, upgrades);
  const h = readAnyPaletteHeader(grid, lifted);
  checkWorldHeader(h);
  const r = new Reader(lifted, HEADER);
  const n = grid.cellsPerChunk;
  const p = img.planes[0];
  img.kind = 'record';
  img.densCount = 0;
  if (h.body === 'uniform') {
    const m = r.u24();
    const c = r.u8();
    const s = r.u8();
    const o = r.u8();
    if (s !== impliedShape(m)) throw new RangeError('palette chunk bytes: uniform voxel with a stored density');
    checkFields(m, c, o);
    const v = recordValue(m, c, o);
    checkRecordValue(v, false);
    singleEntry(p, v, n);
  } else {
    readPaletteHead(r, grid, p, RECORD_FIELDS, ALL_PLANES, true);
    readPackedIds(r, grid, p.ids, p.count);
    checkCanonical(p, n, true);
    for (let e = 0; e < p.count; e++) checkRecordValue(p.values[e]!, p.flags[e] === 1);
    if (p.count === 1 && p.flags[0] === 0) throw new RangeError('palette chunk bytes: a packed body of one voxel (a uniform body)');
    readDensities(r, img, p, valueMaterial);
  }
  if (r.at !== lifted.length) throw new RangeError(`palette chunk bytes: ${lifted.length - r.at} bytes past the end of the body`);
  return h;
}

/** A palette of one entry that every cell uses. */
export function singleEntry(p: PlaneImage, value: number, n: number): void {
  p.count = 1;
  p.values[0] = value;
  p.flags[0] = 0;
  p.counts[0] = n;
  p.ids.fill(0, 0, n);
}
