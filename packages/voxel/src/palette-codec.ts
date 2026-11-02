/**
 * The palette chunk codec: one chunk's bytes at rest (before the general
 * compressor). DRAFT layout, version 2:
 *
 *   0  'V' 'C'        magic
 *   2  version        2
 *   3  flags          bits 0–3 fields held (material, role, shape,
 *                     wetness); bit 4 chunk edge 32 (else 16); bits 5–6
 *                     body: 0 uniform, 1 bit-packed ids (2 and 3 are
 *                     measurement bodies, see palette-codec-measure.ts);
 *                     bit 7 per-plane palettes (measurement only)
 *   4  CRC-32         of every byte after the header (little-endian)
 *   8  body
 *
 * World data holds every field in one record palette, so its flags are
 * 0x0F/0x1F (uniform) or 0x2F/0x3F (packed) at edge 16/32. This module
 * reads and writes only that; the measurement options (column runs, bricks
 * at rest, per-plane palettes, dropped fields) share the header but are
 * refused here, and only the bench entry decodes them.
 *
 * Uniform body: material u16, role u8, shape u8, wetness u8. Packed body:
 * entry count − 1 (u16), every entry's material (u16 each), role (u8
 * each), shape (u8 each), wetness (u8 each), then the cells' entry ids
 * bit-packed at the palette's width (cell i at bit i × width, least
 * significant first). A palette entry is a whole voxel value (record.ts),
 * shape included, so there is no separate density data.
 *
 * Every field is written as its own plane so the general compressor sees
 * runs of like values. Bytes are canonical, and the decoder refuses any
 * other byte string: entries numbered in order of first appearance, none
 * unused or repeated, a chunk of one entry is a uniform body, air is one
 * value (every field 0), and every field holds an assigned value. So one
 * chunk content has one byte string, and region files can be
 * deterministic.
 *
 * Versions only move forward through registered upgrade steps
 * ({@link CHUNK_CODEC_UPGRADES}): bytes of an older version are lifted to
 * this version before they are read, bytes of a newer one are refused.
 * Version 1 (the draft 23/4/5 record with shape bytes beside it) was never
 * approved and has no step: its bytes are refused.
 */
import { crc32 } from '@thirdlight/shared';
import type { ChunkGrid } from './coords';
import { liftVersion, type UpgradeStep } from './format-upgrade';
import { imageIsUniform, type ChunkImage, type PaletteKind } from './palette-image';
import type { PlaneImage } from './palette-plane';
import { MAX_PALETTE, packedWidth } from './packed-width';
import {
  ALL_PLANES,
  checkRecordValue,
  MATERIAL_ID_MAX,
  PLANE_BIT,
  recordValue,
  ROLE_SHIFT,
  SHAPE_FULL,
  SHAPE_SHIFT,
  valueMaterial,
  valueRole,
  valueShape,
  valueWetness,
  VOXEL_ROLE_COUNT,
  WETNESS_MAX,
  WETNESS_SHIFT,
} from './record';
import type { LayoutKind } from './cell-layout';

export const MAGIC0 = 0x56;
export const MAGIC1 = 0x43;
/** The codec version this build writes and reads. */
export const PALETTE_CODEC_VERSION = 2;
export const HEADER = 8;
export const EDGE32 = 1 << 4;
export const BODY_SHIFT = 5;
export const PER_PLANE = 1 << 7;

/**
 * Upgrade steps of the chunk codec, keyed by the version they lift from;
 * only ever added to. A step takes a whole chunk's bytes of its version and
 * returns the same content's bytes of the next version (header and CRC
 * included). Version 2 has none: the draft version 1 is not lifted.
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
  bytes: 1 | 2;
  shift: number;
  max: number;
  /** The field of a whole value. */
  of(v: number): number;
}

export const MATERIAL: Field = { bit: PLANE_BIT.material, bytes: 2, shift: 0, max: MATERIAL_ID_MAX, of: valueMaterial };
export const ROLE_FIELD: Field = { bit: PLANE_BIT.role, bytes: 1, shift: ROLE_SHIFT, max: VOXEL_ROLE_COUNT - 1, of: valueRole };
export const SHAPE_FIELD: Field = { bit: PLANE_BIT.shape, bytes: 1, shift: SHAPE_SHIFT, max: SHAPE_FULL, of: valueShape };
export const WETNESS_FIELD: Field = { bit: PLANE_BIT.wetness, bytes: 1, shift: WETNESS_SHIFT, max: WETNESS_MAX, of: valueWetness };
/** A record value's fields, in the order they are written ({@link recordValue}). */
export const RECORD_FIELDS: readonly Field[] = [MATERIAL, ROLE_FIELD, SHAPE_FIELD, WETNESS_FIELD];

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
}

/** Scratch output per chunk edge, sized for the worst case of any body. */
const outScratch = new Map<number, Uint8Array>();

export function scratchOut(grid: ChunkGrid): Uint8Array {
  let b = outScratch.get(grid.edge);
  if (b === undefined) {
    const n = grid.cellsPerChunk;
    // Header, four palettes of up to n entries (5 bytes of fields each, ids as runs: 3 bytes a cell and a byte a column).
    b = new Uint8Array(HEADER + 4 * (2 + n * 8 + grid.edge * grid.edge));
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

/** Writes a palette's entry count and its held fields (each its own plane). */
export function writePaletteHead(w: Writer, p: PlaneImage, fields: readonly Field[]): void {
  const count = p.count;
  w.u16(count - 1);
  for (const f of fields) {
    for (let e = 0; e < count; e++) {
      const v = f.of(p.values[e]!);
      if (f.bytes === 2) w.u16(v);
      else w.u8(v);
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
export function readPaletteHead(r: Reader, grid: ChunkGrid, p: PlaneImage, fields: readonly Field[], planes: number): void {
  const n = grid.cellsPerChunk;
  const count = r.u16() + 1;
  if (count > n || count > MAX_PALETTE) throw new RangeError(`palette chunk bytes: ${count} palette entries for ${n} cells`);
  p.count = count;
  p.values.fill(0, 0, count);
  for (const f of fields) {
    if (!(planes & f.bit)) continue;
    for (let e = 0; e < count; e++) {
      const v = f.bytes === 2 ? r.u16() : r.u8();
      checkField(f, v);
      p.values[e] = (p.values[e]! | (v << f.shift)) >>> 0;
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
    const key = p.values[e]!;
    if (seen.has(key)) throw new RangeError(`palette chunk bytes: repeated ${record ? 'record' : 'plane'} palette entry`);
    seen.add(key);
  }
}

/** Throws unless a field's value fits its width and is assigned (before it is packed into a value). */
export function checkField(f: Field, v: number): void {
  if (v <= f.max) return;
  const name = f === MATERIAL ? 'material' : f === ROLE_FIELD ? 'role' : f === SHAPE_FIELD ? 'shape' : 'wetness';
  throw new RangeError(`palette chunk bytes: ${f === ROLE_FIELD ? 'unassigned ' : ''}${name} ${v} past its largest value ${f.max}`);
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
    w.u16(valueMaterial(v));
    w.u8(valueRole(v));
    w.u8(valueShape(v));
    w.u8(valueWetness(v));
    return finishChunkBytes(w, chunkFlags(grid, ALL_PLANES, 'uniform', false));
  }
  writePaletteHead(w, p, RECORD_FIELDS);
  writePackedIds(w, grid, p.ids, p.count);
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
  if (h.body === 'uniform') {
    const f = RECORD_FIELDS.map((field) => {
      const v = field.bytes === 2 ? r.u16() : r.u8();
      checkField(field, v);
      return v;
    });
    const v = recordValue(f[0]!, f[1]!, f[2]!, f[3]!);
    checkRecordValue(v, 'palette chunk bytes');
    singleEntry(p, v, n);
  } else {
    readPaletteHead(r, grid, p, RECORD_FIELDS, ALL_PLANES);
    readPackedIds(r, grid, p.ids, p.count);
    checkCanonical(p, n, true);
    for (let e = 0; e < p.count; e++) checkRecordValue(p.values[e]!, 'palette chunk bytes');
    if (p.count === 1) throw new RangeError('palette chunk bytes: a packed body of one voxel (a uniform body)');
  }
  if (r.at !== lifted.length) throw new RangeError(`palette chunk bytes: ${lifted.length - r.at} bytes past the end of the body`);
  return h;
}

/** A palette of one entry that every cell uses. */
export function singleEntry(p: PlaneImage, value: number, n: number): void {
  p.count = 1;
  p.values[0] = value;
  p.counts[0] = n;
  p.ids.fill(0, 0, n);
}
