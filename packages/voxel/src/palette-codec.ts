/**
 * The palette chunk codec: one chunk's bytes at rest (before the general
 * compressor). DRAFT layout under measurement, version 1:
 *
 *   0  'V' 'C'        magic
 *   2  version        1; any other version is refused
 *   3  flags          bits 0–3 planes held (material, category, shape,
 *                     orientation); bit 4 chunk edge 32 (else 16); bits 5–6
 *                     body: 0 uniform, 1 bit-packed ids, 2 column runs;
 *                     bit 7 per-plane palettes (else one record palette)
 *   4  CRC-32         of every byte after the header (little-endian)
 *   8  body
 *
 * Uniform body: the one voxel's held fields (material u16, category u8,
 * shape u8, orientation u8). Palette body: each palette (the record palette,
 * or material, category, orientation in turn, a dropped plane left out),
 * then the density bytes of the surface voxels in cell order. A palette is
 * its entry count − 1 (u16), each held field of every entry as its own
 * plane (u16 or u8 per entry), the density flags as a bitset (when the
 * shape plane is held), then the cells' entry ids: bit-packed at the
 * palette's width (cell i at bit i × width, least significant first), or
 * column runs as three planes (runs per column − 1, run lengths − 1, entry
 * ids: u8 when the palette has at most 256 entries, else u16).
 *
 * Every field is written as its own plane so the general compressor sees runs of
 * like values. Bytes are canonical: entries are numbered in order of first
 * appearance, no entry is unused or repeated, and a stored density never
 * equals the implied one, so one chunk content has one byte string (the
 * decoder refuses any other) and region files can be deterministic.
 */
import { crc32 } from '@thirdlight/shared';
import { MAX_PALETTE, packedWidth, type LayoutKind } from './cell-layout';
import type { ChunkGrid } from './coords';
import { recordValue, valueCategory, valueMaterial, valueOrientation, type ChunkImage, type PaletteKind } from './palette-image';
import type { PlaneImage } from './palette-plane';
import { PLANE_BIT } from './record';
import { impliedShape } from './surface-density';

const MAGIC0 = 0x56;
const MAGIC1 = 0x43;
/** The codec version this build writes and reads. */
export const PALETTE_CODEC_VERSION = 1;
const HEADER = 8;
const EDGE32 = 1 << 4;
const BODY_SHIFT = 5;
const PER_PLANE = 1 << 7;

const BODY: Readonly<Record<'uniform' | LayoutKind, number>> = Object.freeze({ uniform: 0, packed: 1, runs: 2 });

/** What a chunk's bytes hold, as read from its header. */
export interface PaletteCodecHeader {
  planes: number;
  edge: 16 | 32;
  body: 'uniform' | LayoutKind;
  kind: PaletteKind;
}

/** A field of a palette entry: its plane, byte width and the bit it starts at in the entry value. */
interface Field {
  bit: number;
  bytes: 1 | 2;
  shift: number;
}

const MATERIAL: Field = { bit: PLANE_BIT.material, bytes: 2, shift: 0 };
/** A record value holds material in bits 0–15, category in 16–23 and orientation in 24–31 ({@link recordValue}). */
const RECORD_FIELDS: readonly Field[] = [MATERIAL, { bit: PLANE_BIT.category, bytes: 1, shift: 16 }, { bit: PLANE_BIT.orientation, bytes: 1, shift: 24 }];
const PLANE_FIELDS: readonly (readonly Field[])[] = [[MATERIAL], [{ bit: PLANE_BIT.category, bytes: 1, shift: 0 }], [{ bit: PLANE_BIT.orientation, bytes: 1, shift: 0 }]];

function fieldOf(f: Field, v: number): number {
  return (v >>> f.shift) & (f.bytes === 2 ? 0xffff : 0xff);
}

class Writer {
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

class Reader {
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

/** Scratch output per chunk edge, sized for the worst case. */
const outScratch = new Map<number, Uint8Array>();

function scratchOut(grid: ChunkGrid): Uint8Array {
  let b = outScratch.get(grid.edge);
  if (b === undefined) {
    const n = grid.cellsPerChunk;
    // Header, three palettes of up to n entries (4 bytes of fields and a flag bit each, ids as runs: 3 bytes a cell and a byte a column), densities.
    b = new Uint8Array(HEADER + 3 * (2 + n * 7 + Math.ceil(n / 8) + grid.edge * grid.edge) + n);
    outScratch.set(grid.edge, b);
  }
  return b;
}

/** Whether an image is one voxel (one palette entry everywhere, no surface voxel). */
function imageIsUniform(img: ChunkImage): boolean {
  if (img.densCount > 0) return false;
  return img.kind === 'record' ? img.planes[0].count === 1 : img.planes.every((p) => p.count === 1);
}

/** The single voxel of a uniform image as (material, category, orientation). */
function uniformVoxel(img: ChunkImage): [number, number, number] {
  if (img.kind === 'record') {
    const v = img.planes[0].values[0]!;
    return [valueMaterial(v), valueCategory(v), valueOrientation(v)];
  }
  return [img.planes[0].values[0]!, img.planes[1].values[0]!, img.planes[2].values[0]!];
}

/**
 * The bytes of a canonical image (as {@link recordImageFromCells} or
 * {@link planesImageFromCells} build it) holding the planes in `planes`.
 * Throws without the material plane: a palette encoding keys on it.
 */
export function encodePaletteImage(img: ChunkImage, planes: number, layout: LayoutKind): Uint8Array {
  if ((planes & PLANE_BIT.material) === 0) throw new RangeError('a palette chunk encoding needs the material plane');
  const grid = img.grid;
  const w = new Writer(scratchOut(grid));
  w.at = HEADER;
  const uniform = imageIsUniform(img);
  if (uniform) {
    const [m, c, o] = uniformVoxel(img);
    w.u16(m);
    if (planes & PLANE_BIT.category) w.u8(c);
    if (planes & PLANE_BIT.shape) w.u8(impliedShape(m));
    if (planes & PLANE_BIT.orientation) w.u8(o);
  } else if (img.kind === 'record') {
    writePalette(w, grid, img.planes[0], RECORD_FIELDS.filter((f) => planes & f.bit), (planes & PLANE_BIT.shape) !== 0, layout);
  } else {
    img.planes.forEach((p, k) => {
      const fields = PLANE_FIELDS[k]!.filter((f) => planes & f.bit);
      if (fields.length > 0) writePalette(w, grid, p, fields, k === 0 && (planes & PLANE_BIT.shape) !== 0, layout);
    });
  }
  if (!uniform && planes & PLANE_BIT.shape) for (let k = 0; k < img.densCount; k++) w.u8(img.densValues[k]!);
  const out = w.buf.slice(0, w.at);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = PALETTE_CODEC_VERSION;
  out[3] = planes | (grid.edge === 32 ? EDGE32 : 0) | (BODY[uniform ? 'uniform' : layout] << BODY_SHIFT) | (img.kind === 'planes' && !uniform ? PER_PLANE : 0);
  const crc = crc32(out.subarray(HEADER));
  out[4] = crc & 0xff;
  out[5] = (crc >>> 8) & 0xff;
  out[6] = (crc >>> 16) & 0xff;
  out[7] = crc >>> 24;
  return out;
}

function writePalette(w: Writer, grid: ChunkGrid, p: PlaneImage, fields: readonly Field[], withFlags: boolean, layout: LayoutKind): void {
  const count = p.count;
  w.u16(count - 1);
  for (const f of fields) {
    for (let e = 0; e < count; e++) {
      const v = fieldOf(f, p.values[e]!);
      if (f.bytes === 2) w.u16(v);
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
  const n = grid.cellsPerChunk;
  const ids = p.ids;
  if (layout === 'packed') {
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
    return;
  }
  // Runs: three planes (counts, lengths, ids), each written in one pass over the columns.
  const e = grid.edge;
  for (let c = 0; c < n; c += e) {
    let runs = 1;
    for (let y = 1; y < e; y++) if (ids[c + y] !== ids[c + y - 1]) runs++;
    w.u8(runs - 1);
  }
  for (let c = 0; c < n; c += e) {
    let start = 0;
    for (let y = 1; y <= e; y++) {
      if (y === e || ids[c + y] !== ids[c + y - 1]) {
        w.u8(y - start - 1);
        start = y;
      }
    }
  }
  const wide = count > 256;
  for (let c = 0; c < n; c += e) {
    for (let y = 0; y < e; y++) {
      if (y === 0 || ids[c + y] !== ids[c + y - 1]) (wide ? w.u16(ids[c + y]!) : w.u8(ids[c + y]!));
    }
  }
}

/** Reads and checks a chunk's header (magic, version, flags, checksum) against the grid it is decoded into. */
export function readPaletteHeader(grid: ChunkGrid, bytes: Uint8Array): PaletteCodecHeader {
  if (bytes.length < HEADER) throw new RangeError('palette chunk bytes: shorter than the header');
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) throw new RangeError('palette chunk bytes: bad magic');
  if (bytes[2] !== PALETTE_CODEC_VERSION) throw new RangeError(`palette chunk bytes: unknown version ${bytes[2]}`);
  const flags = bytes[3]!;
  const planes = flags & 15;
  const edge = flags & EDGE32 ? 32 : 16;
  const bodyCode = (flags >>> BODY_SHIFT) & 3;
  if ((planes & PLANE_BIT.material) === 0) throw new RangeError('palette chunk bytes: no material plane');
  if (bodyCode === 3) throw new RangeError('palette chunk bytes: unknown body');
  if (edge !== grid.edge) throw new RangeError(`palette chunk bytes: a ${edge}³ chunk, decoding into ${grid.edge}³`);
  const body = bodyCode === 0 ? 'uniform' : bodyCode === 1 ? 'packed' : 'runs';
  if (body === 'uniform' && flags & PER_PLANE) throw new RangeError('palette chunk bytes: uniform body with per-plane flag');
  const crc = (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0;
  if (crc32(bytes.subarray(HEADER)) !== crc) throw new RangeError('palette chunk bytes: checksum mismatch');
  return { planes, edge, body, kind: flags & PER_PLANE ? 'planes' : 'record' };
}

/**
 * Decodes a chunk's bytes into `img` (of the bytes' palette kind; a dropped
 * plane reads 0, a dropped shape plane reads as implied). Refuses bytes
 * that are short, long, damaged, of another version or chunk edge, or not
 * canonical.
 */
export function decodePaletteImage(bytes: Uint8Array, img: ChunkImage): PaletteCodecHeader {
  const grid = img.grid;
  const h = readPaletteHeader(grid, bytes);
  const r = new Reader(bytes, HEADER);
  const n = grid.cellsPerChunk;
  const withShape = (h.planes & PLANE_BIT.shape) !== 0;
  img.densCount = 0;
  if (h.body === 'uniform') {
    const m = r.u16();
    const c = h.planes & PLANE_BIT.category ? r.u8() : 0;
    const s = withShape ? r.u8() : impliedShape(m);
    const o = h.planes & PLANE_BIT.orientation ? r.u8() : 0;
    if (s !== impliedShape(m)) throw new RangeError('palette chunk bytes: uniform voxel with a stored density');
    img.kind = 'record';
    single(img.planes[0], recordValue(m, c, o), n);
  } else if (h.kind === 'record') {
    img.kind = 'record';
    readPalette(r, grid, img.planes[0], RECORD_FIELDS, h.planes, withShape, h.body);
  } else {
    img.kind = 'planes';
    const body = h.body;
    img.planes.forEach((p, k) => {
      const fields = PLANE_FIELDS[k]!;
      if (fields.some((f) => h.planes & f.bit)) readPalette(r, grid, p, fields, h.planes, k === 0 && withShape, body);
      else single(p, 0, n);
    });
  }
  if (h.body !== 'uniform' && withShape) {
    const flagged = img.planes[0];
    let dc = 0;
    for (let i = 0; i < n; i++) {
      const e = flagged.ids[i]!;
      if (!flagged.flags[e]) continue;
      const s = r.u8();
      const m = img.kind === 'record' ? valueMaterial(flagged.values[e]!) : flagged.values[e]!;
      if (s === impliedShape(m)) throw new RangeError('palette chunk bytes: stored density equals the implied one');
      img.densCells[dc] = i;
      img.densValues[dc] = s;
      dc++;
    }
    img.densCount = dc;
  }
  if (r.at !== bytes.length) throw new RangeError(`palette chunk bytes: ${bytes.length - r.at} bytes past the end of the body`);
  return h;
}

function single(p: PlaneImage, value: number, n: number): void {
  p.count = 1;
  p.values[0] = value;
  p.flags[0] = 0;
  p.counts[0] = n;
  p.ids.fill(0, 0, n);
}

function readPalette(r: Reader, grid: ChunkGrid, p: PlaneImage, fields: readonly Field[], planes: number, withFlags: boolean, body: LayoutKind): void {
  const n = grid.cellsPerChunk;
  const count = r.u16() + 1;
  if (count > n || count > MAX_PALETTE) throw new RangeError(`palette chunk bytes: ${count} palette entries for ${n} cells`);
  p.count = count;
  p.values.fill(0, 0, count);
  for (const f of fields) {
    if (!(planes & f.bit)) continue;
    for (let e = 0; e < count; e++) p.values[e] = (p.values[e]! | ((f.bytes === 2 ? r.u16() : r.u8()) << f.shift)) >>> 0;
  }
  for (let e = 0; e < count; e++) p.flags[e] = 0;
  if (withFlags) {
    for (let e = 0; e < count; e += 8) {
      const b = r.u8();
      for (let j = 0; j < 8 && e + j < count; j++) p.flags[e + j] = (b >>> j) & 1;
      if (b >>> Math.min(8, count - e) !== 0) throw new RangeError('palette chunk bytes: flag bits past the palette');
    }
  }
  const ids = p.ids;
  if (body === 'packed') {
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
  } else {
    const e = grid.edge;
    const cols = e * e;
    const countsAt = r.at;
    r.need(cols);
    let runs = 0;
    for (let c = 0; c < cols; c++) runs += bytes(r, countsAt + c) + 1;
    r.at += cols;
    const lengthsAt = r.at;
    r.need(runs);
    r.at += runs;
    const wide = count > 256;
    let k = 0;
    for (let c = 0; c < cols; c++) {
      const nr = bytes(r, countsAt + c) + 1;
      let y = 0;
      let prev = -1;
      for (let j = 0; j < nr; j++, k++) {
        const len = bytes(r, lengthsAt + k) + 1;
        if (y + len > e) throw new RangeError('palette chunk bytes: runs longer than a column');
        const id = wide ? r.u16() : r.u8();
        if (id === prev) throw new RangeError('palette chunk bytes: two runs of one entry in a row');
        ids.fill(id, c * e + y, c * e + y + len);
        prev = id;
        y += len;
      }
      if (y !== e) throw new RangeError('palette chunk bytes: runs shorter than a column');
    }
  }
  checkCanonical(p, n, fields.length > 1);
}

function bytes(r: Reader, at: number): number {
  return r.buf[at]!;
}

/** Entries numbered by first appearance, each used, none repeated; fills the entry counts. */
function checkCanonical(p: PlaneImage, n: number, record: boolean): void {
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
