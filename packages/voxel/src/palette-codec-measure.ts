/**
 * The measurement encodings of the palette chunk codec: what the storage
 * benchmarks compared world data against, kept so they can be measured
 * again. They share the world codec's header (palette-codec.ts) but world
 * readers refuse them; only this entry reads them.
 *
 * - Column runs (body 2): three planes, runs per column − 1 (u8), run
 *   lengths − 1 (u8), the runs' entry ids (u8 when the palette has at most
 *   256 entries, else u16).
 * - Sparse 4³ bricks at rest (body 3, brick-layout.ts): a bitset of the
 *   mixed bricks, the uniform bricks' ids bit-packed in brick order (padding
 *   bits zero), then each mixed brick's 64 cells bit-packed in brick order
 *   (a mixed brick of one id is refused).
 * - Per-plane palettes (flag bit 7): material, role, shape and wetness
 *   each their own palette, in that order.
 * - Dropped fields: a field left out of the mask is not written; it reads
 *   0.
 *
 * World bytes (every plane, record palette, uniform or packed) are read
 * and written here too, byte for byte as the world codec does.
 */
import { BRICK_CELLS, brickOrder, bricksPerChunk, brickUniform } from './brick-layout';
import type { LayoutKind } from './cell-layout';
import type { ChunkGrid } from './coords';
import {
  checkCanonical,
  checkField,
  chunkFlags,
  finishChunkBytes,
  HEADER,
  MATERIAL,
  readAnyPaletteHeader,
  readPackedIds,
  readPaletteHead,
  Reader,
  RECORD_FIELDS,
  ROLE_FIELD,
  scratchOut,
  SHAPE_FIELD,
  singleEntry,
  writePackedIds,
  writePaletteHead,
  WETNESS_FIELD,
  Writer,
  type Field,
  type PaletteCodecHeader,
} from './palette-codec';
import { imageIsUniform, uniformImageValue, type ChunkImage } from './palette-image';
import type { PlaneImage } from './palette-plane';
import { packedWidth } from './packed-width';
import { PLANE_BIT, recordValue } from './record';

/** A per-plane palette's one field: the value is the field itself. */
const planeField = (f: Field): Field => ({ ...f, shift: 0, of: (v) => v });
const PLANE_FIELDS: readonly Field[] = [MATERIAL, planeField(ROLE_FIELD), planeField(SHAPE_FIELD), planeField(WETNESS_FIELD)];

/**
 * The bytes of a canonical image (as {@link recordImageFromCells} or
 * {@link planesImageFromCells} build it) holding the planes in `planes`,
 * with the ids at rest in `layout`. Throws without the material plane: a
 * palette encoding keys on it.
 */
export function encodeMeasuredImage(img: ChunkImage, planes: number, layout: LayoutKind): Uint8Array {
  if ((planes & PLANE_BIT.material) === 0) throw new RangeError('a palette chunk encoding needs the material plane');
  const grid = img.grid;
  const w = new Writer(scratchOut(grid));
  w.at = HEADER;
  const uniform = imageIsUniform(img);
  if (uniform) {
    const v = uniformImageValue(img);
    for (const f of RECORD_FIELDS) if (planes & f.bit) (f.bytes === 2 ? w.u16(f.of(v)) : w.u8(f.of(v)));
  } else if (img.kind === 'record') {
    writePalette(w, grid, img.planes[0], RECORD_FIELDS.filter((f) => planes & f.bit), layout);
  } else {
    img.planes.forEach((p, k) => {
      const f = PLANE_FIELDS[k]!;
      if (planes & f.bit) writePalette(w, grid, p, [f], layout);
    });
  }
  return finishChunkBytes(w, chunkFlags(grid, planes, uniform ? 'uniform' : layout, img.kind === 'planes' && !uniform));
}

function writePalette(w: Writer, grid: ChunkGrid, p: PlaneImage, fields: readonly Field[], layout: LayoutKind): void {
  writePaletteHead(w, p, fields);
  if (layout === 'bricks') writeBricks(w, grid, p.ids, packedWidth(p.count));
  else if (layout === 'packed') writePackedIds(w, grid, p.ids, p.count);
  else writeRuns(w, grid, p.ids, p.count);
}

/** Runs: three planes (counts, lengths, ids), each written in one pass over the columns. */
function writeRuns(w: Writer, grid: ChunkGrid, ids: Uint16Array, count: number): void {
  const n = grid.cellsPerChunk;
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

/** Ids at `width` bits (1–16) into the writer, least significant first; a last partial byte is padded with zeros. */
class BitWriter {
  private acc = 0;
  private bits = 0;
  constructor(
    private readonly w: Writer,
    private readonly width: number,
  ) {}
  put(v: number): void {
    if (this.width >= 8) {
      if (this.width === 8) this.w.u8(v);
      else this.w.u16(v);
      return;
    }
    this.acc |= v << this.bits;
    this.bits += this.width;
    if (this.bits === 8) this.flush();
  }
  flush(): void {
    if (this.bits === 0) return;
    this.w.u8(this.acc);
    this.acc = 0;
    this.bits = 0;
  }
}

function writeBricks(w: Writer, grid: ChunkGrid, ids: Uint16Array, width: number): void {
  if (width === 0) return;
  const order = brickOrder(grid);
  const nb = bricksPerChunk(grid);
  const mixedAt = w.at;
  for (let b = 0; b < nb; b += 8) w.u8(0);
  const uniformIds = new BitWriter(w, width);
  for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) {
    if (brickUniform(ids, order, k)) uniformIds.put(ids[order[k]!]!);
    else w.buf[mixedAt + (b >>> 3)]! |= 1 << (b & 7);
  }
  uniformIds.flush();
  const cells = new BitWriter(w, width);
  for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) {
    if (!((w.buf[mixedAt + (b >>> 3)]! >>> (b & 7)) & 1)) continue;
    for (let j = 0; j < BRICK_CELLS; j++) cells.put(ids[order[k + j]!]!);
  }
}

/** Ids at `width` bits from the reader (the {@link BitWriter} layout); refuses non-zero padding. */
class BitReader {
  private acc = 0;
  private bits = 0;
  constructor(
    private readonly r: Reader,
    private readonly width: number,
  ) {}
  get(): number {
    if (this.width >= 8) return this.width === 8 ? this.r.u8() : this.r.u16();
    if (this.bits === 0) {
      this.acc = this.r.u8();
      this.bits = 8;
    }
    const v = this.acc & ((1 << this.width) - 1);
    this.acc >>>= this.width;
    this.bits -= this.width;
    return v;
  }
  end(): void {
    if (this.acc !== 0) throw new RangeError('palette chunk bytes: padding bits set');
    this.bits = 0;
  }
}

function readBricks(r: Reader, grid: ChunkGrid, ids: Uint16Array, width: number): void {
  const n = grid.cellsPerChunk;
  if (width === 0) {
    ids.fill(0, 0, n);
    return;
  }
  const order = brickOrder(grid);
  const nb = bricksPerChunk(grid);
  const maskAt = r.at;
  r.need(nb >>> 3);
  r.at += nb >>> 3;
  const mixed = (b: number): boolean => ((r.buf[maskAt + (b >>> 3)]! >>> (b & 7)) & 1) === 1;
  const uniformIds = new BitReader(r, width);
  for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) {
    if (mixed(b)) continue;
    const v = uniformIds.get();
    for (let j = 0; j < BRICK_CELLS; j++) ids[order[k + j]!] = v;
  }
  uniformIds.end();
  const cells = new BitReader(r, width);
  for (let b = 0, k = 0; b < nb; b++, k += BRICK_CELLS) {
    if (!mixed(b)) continue;
    for (let j = 0; j < BRICK_CELLS; j++) ids[order[k + j]!] = cells.get();
    if (brickUniform(ids, order, k)) throw new RangeError('palette chunk bytes: a mixed brick of one entry');
  }
}

function readRuns(r: Reader, grid: ChunkGrid, ids: Uint16Array, count: number): void {
  const e = grid.edge;
  const cols = e * e;
  const countsAt = r.at;
  r.need(cols);
  let runs = 0;
  for (let c = 0; c < cols; c++) runs += r.buf[countsAt + c]! + 1;
  r.at += cols;
  const lengthsAt = r.at;
  r.need(runs);
  r.at += runs;
  const wide = count > 256;
  let k = 0;
  for (let c = 0; c < cols; c++) {
    const nr = r.buf[countsAt + c]! + 1;
    let y = 0;
    let prev = -1;
    for (let j = 0; j < nr; j++, k++) {
      const len = r.buf[lengthsAt + k]! + 1;
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

function readPalette(r: Reader, grid: ChunkGrid, p: PlaneImage, fields: readonly Field[], planes: number, body: LayoutKind): void {
  readPaletteHead(r, grid, p, fields, planes);
  if (body === 'bricks') readBricks(r, grid, p.ids, packedWidth(p.count));
  else if (body === 'packed') readPackedIds(r, grid, p.ids, p.count);
  else readRuns(r, grid, p.ids, p.count);
  checkCanonical(p, grid.cellsPerChunk, fields.length > 1);
}

/** Reads and checks the header of any encoding (world or measurement) of this codec version. */
export function readMeasuredHeader(grid: ChunkGrid, bytes: Uint8Array): PaletteCodecHeader {
  return readAnyPaletteHeader(grid, bytes);
}

/**
 * Decodes the bytes of any encoding into `img` (of the bytes' palette
 * kind; a dropped field reads 0).
 * Refuses bytes that are short, long, damaged, of another version or chunk
 * edge, or not canonical.
 */
export function decodeMeasuredImage(bytes: Uint8Array, img: ChunkImage): PaletteCodecHeader {
  const grid = img.grid;
  const h = readAnyPaletteHeader(grid, bytes);
  const r = new Reader(bytes, HEADER);
  const n = grid.cellsPerChunk;
  if (h.body === 'uniform') {
    const f = RECORD_FIELDS.map((field) => {
      if (!(h.planes & field.bit)) return 0;
      const v = field.bytes === 2 ? r.u16() : r.u8();
      checkField(field, v);
      return v;
    });
    img.kind = 'record';
    singleEntry(img.planes[0], f[0] === 0 ? 0 : recordValue(f[0]!, f[1]!, f[2]!, f[3]!), n);
  } else if (h.kind === 'record') {
    img.kind = 'record';
    readPalette(r, grid, img.planes[0], RECORD_FIELDS, h.planes, h.body);
  } else {
    img.kind = 'planes';
    const body = h.body;
    img.planes.forEach((p, k) => {
      const f = PLANE_FIELDS[k]!;
      if (h.planes & f.bit) readPalette(r, grid, p, [f], h.planes, body);
      else singleEntry(p, 0, n);
    });
  }
  if (r.at !== bytes.length) throw new RangeError(`palette chunk bytes: ${bytes.length - r.at} bytes past the end of the body`);
  return h;
}
