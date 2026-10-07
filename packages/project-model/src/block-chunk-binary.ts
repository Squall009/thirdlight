/**
 * Block chunks as compact binary — the form a project may store its chunk
 * files in and the form an export ships a layer's cells in.
 *
 * Pretty-printed JSON of a large layer is mostly punctuation, and parsing it
 * is the slowest part of loading one. Here every number is a zig-zag varint
 * (columns hold small run lengths, heights and palette indices, mostly one
 * byte each), the cell values every chunk's palette names are written once
 * per blob as JSON text (a layer repeats the same few cells in every chunk),
 * and paint is its raw lattice bytes. The result is then compressed by the
 * caller (zstd in the editor's files, gzip in an export, which the browser
 * decodes natively); the header says which, so a reader takes any of them.
 *
 * Decoding gives back the same `BlockChunk` values (key for key, the paint's
 * base64 text included), so a JSON chunk and its binary form are the same
 * cells. A malformed blob throws a short message; the decoded chunks are then
 * checked by the layer's usual validation like any others.
 *
 * Pure: no compression here (node:zlib on the backend, the page's
 * DecompressionStream in a game).
 */
import type { BlockCell, BlockChunk } from './block-layers';
import type { BlockEdge } from './block-edges';
import { decodeBase64, encodeBase64 } from './png-decode';

/** The first bytes of a binary chunk blob ("TLBK"). */
export const BLOCK_CHUNK_MAGIC = Object.freeze([0x54, 0x4c, 0x42, 0x4b]);
/**
 * The payload layout this module writes (the payload's first number): 2
 * adds each chunk's edge pieces after its columns. A payload without edge
 * pieces is written as 1, byte for byte what it was before edges existed, so
 * existing files and builds keep their digests; both are read.
 */
export const BLOCK_CHUNK_BINARY_VERSION = 2;
const LAYOUT_WITHOUT_EDGES = 1;
/** The header layout (its fifth byte). */
export const BLOCK_CHUNK_CONTAINER_VERSION = 1;
/** How a blob's payload is compressed (the header's byte). */
export const BLOCK_CHUNK_COMPRESSION = Object.freeze({ none: 0, zstd: 1, gzip: 2 } as const);
export type BlockChunkCompression = keyof typeof BLOCK_CHUNK_COMPRESSION;
/**
 * The key a build's scene document puts on a layer entry in place of its
 * `chunks`: the digest of the layer's chunk data (a `manifest.buffers` row).
 */
export const BLOCK_CHUNK_DATA_KEY = 'chunkData';
/** Magic, version, compression, a reserved byte and the payload's uncompressed length (u32 LE). */
export const BLOCK_CHUNK_HEADER_BYTES = 12;

/** A paint stored as its lattice bytes / as its text (a base64 form `encodeBase64` would not write back the same). */
const PAINT_NONE = 0;
const PAINT_BYTES_FORM = 1;
const PAINT_TEXT_FORM = 2;

class Writer {
  private buf = new Uint8Array(4096);
  length = 0;
  private room(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  uint(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`block chunk binary: ${v} is not a stored count`);
    this.room(5);
    while (v >= 0x80) {
      this.buf[this.length++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.length++] = v;
  }
  int(v: number): void {
    // Zig-zag: small magnitudes of either sign stay one byte.
    if (!Number.isSafeInteger(v) || v < -0x7fffffff || v > 0x7fffffff) throw new Error(`block chunk binary: ${v} is not a stored integer`);
    this.uint(v < 0 ? -2 * v - 1 : 2 * v);
  }
  bytes(b: Uint8Array): void {
    this.uint(b.length);
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

class Reader {
  at = 0;
  constructor(private readonly b: Uint8Array) {}
  get left(): number {
    return this.b.length - this.at;
  }
  uint(): number {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      if (this.at >= this.b.length) throw new Error('block chunk binary: the data ends early');
      const c = this.b[this.at++]!;
      v += (c & 0x7f) * scale;
      if (c < 0x80) return v;
      scale *= 128;
    }
    throw new Error('block chunk binary: a number is too long');
  }
  int(): number {
    const u = this.uint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }
  count(perItem: number): number {
    const n = this.uint();
    if (n * perItem > this.left) throw new Error('block chunk binary: a count runs past the data');
    return n;
  }
  bytes(): Uint8Array {
    const n = this.count(1);
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The chunks' payload (uncompressed; `wrapBlockChunkData` adds the header). */
export function encodeBlockChunks(chunks: readonly BlockChunk[]): Uint8Array {
  const cellIndex = new Map<string, number>();
  const cells: string[] = [];
  const paletteOf = (palette: readonly BlockCell[]): number[] =>
    palette.map((c) => {
      const s = JSON.stringify(c);
      let i = cellIndex.get(s);
      if (i === undefined) {
        i = cells.length;
        cellIndex.set(s, i);
        cells.push(s);
      }
      return i;
    });
  const palettes = chunks.map((c) => paletteOf(c.palette));
  // Edge values go in the same table (they are JSON objects like cells).
  const edgePalettes = chunks.map((c) => (c.edges !== undefined && c.edges.length > 0 ? paletteOf((c.edgePalette ?? []) as unknown as BlockCell[]) : null));
  const layout = edgePalettes.some((p) => p !== null) ? BLOCK_CHUNK_BINARY_VERSION : LAYOUT_WITHOUT_EDGES;
  const w = new Writer();
  w.uint(layout);
  w.uint(cells.length);
  for (const s of cells) w.bytes(utf8.encode(s));
  w.uint(chunks.length);
  chunks.forEach((c, k) => {
    w.int(c.cx);
    w.int(c.cz);
    const p = palettes[k]!;
    w.uint(p.length);
    for (const i of p) w.uint(i);
    if (c.paint === undefined) w.uint(PAINT_NONE);
    else {
      const raw = decodeBase64(c.paint);
      if (raw !== null && encodeBase64(raw) === c.paint) {
        w.uint(PAINT_BYTES_FORM);
        w.bytes(raw);
      } else {
        w.uint(PAINT_TEXT_FORM);
        w.bytes(utf8.encode(c.paint));
      }
    }
    w.uint(c.columns.length);
    for (const col of c.columns) {
      w.uint(col.length);
      for (const v of col) w.int(v);
    }
    if (layout === LAYOUT_WITHOUT_EDGES) return;
    const ep = edgePalettes[k];
    if (ep === null || ep === undefined) {
      w.uint(0);
      return;
    }
    w.uint(ep.length);
    for (const i of ep) w.uint(i);
    w.uint(c.edges!.length);
    for (const r of c.edges!) for (const v of r) w.int(v);
  });
  return w.done();
}

/** The chunks a payload holds (throws on a malformed one). */
export function decodeBlockChunks(payload: Uint8Array): BlockChunk[] {
  const r = new Reader(payload);
  const version = r.uint();
  if (version !== BLOCK_CHUNK_BINARY_VERSION && version !== LAYOUT_WITHOUT_EDGES) throw new Error(`block chunk binary: layout ${version} is newer than this engine reads (${BLOCK_CHUNK_BINARY_VERSION})`);
  const cellCount = r.count(1);
  const cells: BlockCell[] = [];
  for (let i = 0; i < cellCount; i++) {
    let v: unknown;
    try {
      v = JSON.parse(fromUtf8.decode(r.bytes()));
    } catch {
      throw new Error(`block chunk binary: cell value ${i} is not JSON text`);
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`block chunk binary: cell value ${i} is not an object`);
    cells.push(v as BlockCell);
  }
  const n = r.count(3);
  const out: BlockChunk[] = [];
  for (let k = 0; k < n; k++) {
    const cx = r.int();
    const cz = r.int();
    const pn = r.count(1);
    const palette: BlockCell[] = [];
    for (let i = 0; i < pn; i++) {
      const at = r.uint();
      const cell = cells[at];
      if (cell === undefined) throw new Error(`block chunk binary: chunk ${cx},${cz} names cell value ${at} of ${cellCount}`);
      // Each chunk gets its own objects, as a parsed JSON chunk has.
      palette.push(structuredCloneCell(cell));
    }
    const paintForm = r.uint();
    let paint: string | undefined;
    if (paintForm === PAINT_BYTES_FORM) paint = encodeBase64(r.bytes());
    else if (paintForm === PAINT_TEXT_FORM) paint = fromUtf8.decode(r.bytes());
    else if (paintForm !== PAINT_NONE) throw new Error(`block chunk binary: chunk ${cx},${cz} has an unknown paint form ${paintForm}`);
    const cn = r.count(1);
    const columns: number[][] = new Array(cn);
    for (let i = 0; i < cn; i++) {
      const len = r.count(1);
      const col: number[] = new Array(len);
      for (let j = 0; j < len; j++) col[j] = r.int();
      columns[i] = col;
    }
    let edges: { edgePalette: BlockEdge[]; edges: number[][] } | null = null;
    if (version !== LAYOUT_WITHOUT_EDGES) {
      const en = r.count(1);
      if (en > 0) {
        const edgePalette: BlockEdge[] = [];
        for (let i = 0; i < en; i++) {
          const at = r.uint();
          const e = cells[at];
          if (e === undefined) throw new Error(`block chunk binary: chunk ${cx},${cz} names edge value ${at} of ${cellCount}`);
          edgePalette.push({ ...(e as unknown as BlockEdge) });
        }
        const rn = r.count(5);
        const rows: number[][] = new Array(rn);
        for (let i = 0; i < rn; i++) rows[i] = [r.int(), r.int(), r.int(), r.int(), r.int()];
        edges = { edgePalette, edges: rows };
      }
    }
    // Key order as a JSON chunk file has it.
    out.push({ cx, cz, palette, columns, ...(edges ?? {}), ...(paint !== undefined ? { paint } : {}) });
  }
  if (r.left !== 0) throw new Error('block chunk binary: bytes after the last chunk');
  return out;
}

function structuredCloneCell(c: BlockCell): BlockCell {
  const out: BlockCell = { ...c };
  if (c.corners !== undefined) out.corners = [...c.corners];
  if (c.meta !== undefined) out.meta = { ...c.meta };
  return out;
}

/** A blob: the header (magic, version, compression, payload length) and the (compressed) payload. */
export function wrapBlockChunkData(compression: BlockChunkCompression, rawLength: number, stored: Uint8Array): Uint8Array {
  const out = new Uint8Array(BLOCK_CHUNK_HEADER_BYTES + stored.length);
  out.set(BLOCK_CHUNK_MAGIC, 0);
  out[4] = BLOCK_CHUNK_CONTAINER_VERSION;
  out[5] = BLOCK_CHUNK_COMPRESSION[compression];
  new DataView(out.buffer).setUint32(8, rawLength, true);
  out.set(stored, BLOCK_CHUNK_HEADER_BYTES);
  return out;
}

/** A blob's header and its stored payload (throws when it is not one). */
export function readBlockChunkData(blob: Uint8Array): { compression: BlockChunkCompression; rawLength: number; stored: Uint8Array } {
  if (blob.length < BLOCK_CHUNK_HEADER_BYTES || BLOCK_CHUNK_MAGIC.some((b, i) => blob[i] !== b)) throw new Error('not a binary block chunk file');
  if (blob[4] !== BLOCK_CHUNK_CONTAINER_VERSION) throw new Error(`block chunk binary: header version ${blob[4]} is not one this engine reads (${BLOCK_CHUNK_CONTAINER_VERSION})`);
  const compression = (Object.keys(BLOCK_CHUNK_COMPRESSION) as BlockChunkCompression[]).find((k) => BLOCK_CHUNK_COMPRESSION[k] === blob[5]);
  if (compression === undefined) throw new Error(`block chunk binary: unknown compression ${blob[5]}`);
  const rawLength = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(8, true);
  return { compression, rawLength, stored: blob.subarray(BLOCK_CHUNK_HEADER_BYTES) };
}
