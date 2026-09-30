/**
 * A KTX2 file's mip levels by byte range, for texture streaming.
 *
 * KTX2 stores its levels from the smallest to the largest after the
 * metadata (header, level index, data format descriptor, key/value data and
 * the supercompression global data), and its level index gives each level's
 * offset and length. So a file can be cut into parts: a head (the metadata
 * and every small level, the "mip tail") and one part per larger level,
 * largest last. Concatenated in order the parts are the file again.
 *
 * The page never hands a partial file to the transcoder: it builds a
 * complete, smaller KTX2 from the head's metadata and the levels it has
 * (`buildKtx2Subset`), the same texture at a lower resolution, or one level
 * alone. Basis Universal's ETC1S (BasisLZ) keeps one image descriptor per
 * level in its global data; those are cut to the levels kept, the codebooks
 * stay whole. UASTC (Zstandard or none) needs nothing but the level bytes.
 *
 * Pure: bytes in, bytes out, no I/O.
 */

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const HEADER_BYTES = 80;
const LEVEL_ENTRY_BYTES = 24;
/** BasisLZ global data: its fixed header, then one 20-byte image descriptor per image. */
const BASISLZ_HEADER_BYTES = 20;
const BASISLZ_IMAGE_DESC_BYTES = 20;
/** Supercompression schemes (KTX2 spec, table 2). */
export const KTX2_SUPERCOMPRESSION_BASISLZ = 1;
/** More levels than a 2^31-texel edge has is a malformed file. */
const MAX_LEVELS = 32;

export interface Ktx2Range {
  readonly offset: number;
  readonly length: number;
}

export interface Ktx2Level extends Ktx2Range {
  readonly uncompressedLength: number;
}

export interface Ktx2Layout {
  readonly vkFormat: number;
  readonly typeSize: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly layers: number;
  readonly faces: number;
  readonly supercompression: number;
  readonly dfd: Ktx2Range;
  readonly kvd: Ktx2Range;
  readonly sgd: Ktx2Range;
  /** Level 0 (the largest) first, as the level index lists them. */
  readonly levels: readonly Ktx2Level[];
  /** Where the metadata ends (the first byte a level may use). */
  readonly metadataEnd: number;
}

export type Ktx2LayoutResult = { ok: true; layout: Ktx2Layout } | { ok: false; message: string };

/** How many bytes `readKtx2Layout` needs before it can read the level index (the header's level count decides). */
export function ktx2IndexBytes(header: Uint8Array): number | null {
  if (header.length < HEADER_BYTES || !isKtx2Bytes(header)) return null;
  const levels = Math.max(1, new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(40, true));
  return levels > MAX_LEVELS ? null : HEADER_BYTES + levels * LEVEL_ENTRY_BYTES;
}

export function isKtx2Bytes(bytes: Uint8Array): boolean {
  if (bytes.length < IDENTIFIER.length) return false;
  for (let i = 0; i < IDENTIFIER.length; i++) if (bytes[i] !== IDENTIFIER[i]) return false;
  return true;
}

const u64 = (v: DataView, at: number): number => {
  const lo = v.getUint32(at, true);
  const hi = v.getUint32(at + 4, true);
  // Offsets past 2^53 are not a file a page can hold.
  return hi >= 0x200000 ? Number.NaN : hi * 0x100000000 + lo;
};

/**
 * The header and level index of a KTX2 file. `bytes` holds at least the
 * header and level index (the whole file, or its head); `fileLength` is the
 * whole file's length when known, and every range is checked against it.
 */
export function readKtx2Layout(bytes: Uint8Array, fileLength: number = bytes.length): Ktx2LayoutResult {
  if (!isKtx2Bytes(bytes)) return { ok: false, message: 'not a KTX2 file' };
  if (bytes.length < HEADER_BYTES) return { ok: false, message: 'the KTX2 header is cut short' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levelCount = Math.max(1, v.getUint32(40, true));
  if (levelCount > MAX_LEVELS) return { ok: false, message: `the KTX2 file names ${levelCount} levels` };
  const indexEnd = HEADER_BYTES + levelCount * LEVEL_ENTRY_BYTES;
  if (bytes.length < indexEnd) return { ok: false, message: 'the KTX2 level index is cut short' };
  const width = v.getUint32(20, true);
  const height = v.getUint32(24, true);
  if (width === 0) return { ok: false, message: 'the KTX2 file has no width' };
  const inFile = (r: Ktx2Range): boolean => Number.isFinite(r.offset) && Number.isFinite(r.length) && r.offset >= 0 && r.length >= 0 && r.offset + r.length <= fileLength;
  const dfd = { offset: v.getUint32(48, true), length: v.getUint32(52, true) };
  const kvd = { offset: v.getUint32(56, true), length: v.getUint32(60, true) };
  const sgd = { offset: u64(v, 64), length: u64(v, 72) };
  for (const [name, r] of [['format descriptor', dfd], ['key/value data', kvd], ['global data', sgd]] as const) {
    if (r.length > 0 && !inFile(r)) return { ok: false, message: `the KTX2 ${name} lies outside the file` };
  }
  const levels: Ktx2Level[] = [];
  for (let i = 0; i < levelCount; i++) {
    const at = HEADER_BYTES + i * LEVEL_ENTRY_BYTES;
    const level = { offset: u64(v, at), length: u64(v, at + 8), uncompressedLength: u64(v, at + 16) };
    if (!inFile(level) || level.length === 0) return { ok: false, message: `KTX2 level ${i} lies outside the file` };
    levels.push(level);
  }
  let metadataEnd = indexEnd;
  for (const r of [dfd, kvd, sgd]) if (r.length > 0) metadataEnd = Math.max(metadataEnd, r.offset + r.length);
  for (const [i, l] of levels.entries()) if (l.offset < metadataEnd) return { ok: false, message: `KTX2 level ${i} overlaps the metadata` };
  return {
    ok: true,
    layout: {
      vkFormat: v.getUint32(12, true),
      typeSize: v.getUint32(16, true),
      width,
      height,
      depth: v.getUint32(28, true),
      layers: v.getUint32(32, true),
      faces: Math.max(1, v.getUint32(36, true)),
      supercompression: v.getUint32(44, true),
      dfd,
      kvd,
      sgd,
      levels,
      metadataEnd,
    },
  };
}

/** A level's size in texels (the longer edge is what the mip tail is measured by). */
export function ktx2LevelSize(layout: Pick<Ktx2Layout, 'width' | 'height'>, level: number): { width: number; height: number } {
  return { width: Math.max(1, layout.width >>> level), height: Math.max(1, (layout.height || 1) >>> level) };
}

/** One part of a streamed KTX2: a byte range of the file and the levels whose data lie in it. */
export interface Ktx2Part extends Ktx2Range {
  /** Level numbers (0 = largest) whose data are in this part. */
  readonly levels: readonly number[];
}

/**
 * Cut a file into its streaming parts: the head (metadata and every level
 * whose longer edge is at most `tailEdge` texels, at least the smallest
 * level) and then one part per larger level, from the next-smaller to level
 * 0. Parts are contiguous and cover the whole file. Null when the file is
 * not laid out smallest-first (the order the spec asks for), when it has a
 * single level, or when every level is in the tail: nothing to stream.
 */
export function planKtx2Parts(layout: Ktx2Layout, fileLength: number, tailEdge: number): Ktx2Part[] | null {
  const n = layout.levels.length;
  if (n < 2 || layout.faces !== 1 || layout.depth > 1) return null;
  let firstTail = n - 1;
  while (firstTail > 0) {
    const s = ktx2LevelSize(layout, firstTail - 1);
    if (Math.max(s.width, s.height) > tailEdge) break;
    firstTail -= 1;
  }
  if (firstTail === 0) return null;
  // Smallest first: every level starts after the next-smaller one ends.
  for (let i = 0; i < n - 1; i++) {
    const larger = layout.levels[i]!;
    const smaller = layout.levels[i + 1]!;
    if (larger.offset < smaller.offset + smaller.length) return null;
  }
  const parts: Ktx2Part[] = [];
  const headEnd = layout.levels[firstTail - 1]!.offset;
  const tailLevels: number[] = [];
  for (let i = firstTail; i < n; i++) tailLevels.push(i);
  parts.push({ offset: 0, length: headEnd, levels: tailLevels });
  for (let i = firstTail - 1; i >= 0; i--) {
    const start = layout.levels[i]!.offset;
    const end = i === 0 ? fileLength : layout.levels[i - 1]!.offset;
    parts.push({ offset: start, length: end - start, levels: [i] });
  }
  return parts;
}

/**
 * A complete KTX2 file holding only levels `first`..`last` of `layout`
 * (level `first` becomes its level 0). `read(range)` gives the bytes of a
 * range of the original file (metadata or a level's data); every range asked
 * for is one the caller holds. The metadata is copied, with BasisLZ's image
 * descriptors cut to the levels kept.
 */
export function buildKtx2Subset(layout: Ktx2Layout, first: number, last: number, read: (range: Ktx2Range) => Uint8Array): Uint8Array {
  if (!(first >= 0 && last >= first && last < layout.levels.length)) throw new RangeError(`levels ${first}..${last} of ${layout.levels.length}`);
  const count = last - first + 1;
  const dfd = layout.dfd.length > 0 ? read(layout.dfd) : new Uint8Array(0);
  const kvd = layout.kvd.length > 0 ? read(layout.kvd) : new Uint8Array(0);
  let sgd = layout.sgd.length > 0 ? read(layout.sgd) : new Uint8Array(0);
  if (layout.supercompression === KTX2_SUPERCOMPRESSION_BASISLZ && sgd.length > 0) sgd = cutBasisLzImages(layout, sgd, first, count);
  const align = (n: number, a: number): number => Math.ceil(n / a) * a;
  // Level data aligned as the spec asks: 1 when supercompressed, else lcm(texel block bytes, 4).
  const levelAlign = layout.supercompression !== 0 ? 1 : Math.max(4, align(Math.max(1, layout.typeSize), 4), 16);
  const indexEnd = HEADER_BYTES + count * LEVEL_ENTRY_BYTES;
  const dfdAt = dfd.length > 0 ? align(indexEnd, 4) : 0;
  let at = dfd.length > 0 ? dfdAt + dfd.length : indexEnd;
  const kvdAt = kvd.length > 0 ? align(at, 4) : 0;
  if (kvd.length > 0) at = kvdAt + kvd.length;
  const sgdAt = sgd.length > 0 ? align(at, 8) : 0;
  if (sgd.length > 0) at = sgdAt + sgd.length;
  const levelData: Uint8Array[] = [];
  const levelAt: number[] = new Array<number>(count);
  // Smallest first, as in the original.
  for (let i = last; i >= first; i--) {
    const bytes = read(layout.levels[i]!);
    at = align(at, levelAlign);
    levelAt[i - first] = at;
    levelData[i - first] = bytes;
    at += bytes.length;
  }
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  out.set(IDENTIFIER, 0);
  const size = ktx2LevelSize(layout, first);
  v.setUint32(12, layout.vkFormat, true);
  v.setUint32(16, layout.typeSize, true);
  v.setUint32(20, size.width, true);
  v.setUint32(24, layout.height === 0 ? 0 : size.height, true);
  v.setUint32(28, layout.depth, true);
  v.setUint32(32, layout.layers, true);
  v.setUint32(36, layout.faces, true);
  v.setUint32(40, count, true);
  v.setUint32(44, layout.supercompression, true);
  v.setUint32(48, dfdAt, true);
  v.setUint32(52, dfd.length, true);
  v.setUint32(56, kvdAt, true);
  v.setUint32(60, kvd.length, true);
  v.setUint32(64, sgdAt, true);
  v.setUint32(72, sgd.length, true);
  for (let j = 0; j < count; j++) {
    const e = HEADER_BYTES + j * LEVEL_ENTRY_BYTES;
    v.setUint32(e, levelAt[j]!, true);
    v.setUint32(e + 8, levelData[j]!.length, true);
    v.setUint32(e + 16, layout.levels[first + j]!.uncompressedLength, true);
  }
  if (dfd.length > 0) out.set(dfd, dfdAt);
  if (kvd.length > 0) out.set(kvd, kvdAt);
  if (sgd.length > 0) out.set(sgd, sgdAt);
  for (let j = 0; j < count; j++) out.set(levelData[j]!, levelAt[j]!);
  return out;
}

/** BasisLZ global data with only the image descriptors of levels `first`..`first + count - 1`. */
function cutBasisLzImages(layout: Ktx2Layout, sgd: Uint8Array, first: number, count: number): Uint8Array {
  const perLevel = Math.max(1, layout.layers) * layout.faces;
  const total = layout.levels.length * perLevel;
  const descEnd = BASISLZ_HEADER_BYTES + total * BASISLZ_IMAGE_DESC_BYTES;
  if (sgd.length < descEnd) throw new RangeError('the BasisLZ global data is shorter than its image descriptors');
  const keptStart = BASISLZ_HEADER_BYTES + first * perLevel * BASISLZ_IMAGE_DESC_BYTES;
  const keptLength = count * perLevel * BASISLZ_IMAGE_DESC_BYTES;
  const out = new Uint8Array(sgd.length - (total - count * perLevel) * BASISLZ_IMAGE_DESC_BYTES);
  out.set(sgd.subarray(0, BASISLZ_HEADER_BYTES), 0);
  out.set(sgd.subarray(keptStart, keptStart + keptLength), BASISLZ_HEADER_BYTES);
  out.set(sgd.subarray(descEnd), BASISLZ_HEADER_BYTES + keptLength);
  return out;
}
