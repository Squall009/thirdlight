/**
 * The KTX2 container, read and written without touching the texels: the
 * header, the level index, the data format descriptor and the key/value data.
 *
 * Packing joins UASTC textures into a texture array here. UASTC blocks are
 * self-contained (no per-file codebook, unlike ETC1S's BasisLZ global data),
 * so the layers of an array are the sources' level data side by side: each
 * level's Zstandard payload is decompressed, the layers are concatenated in
 * order and the result is compressed again. No texel is decoded or encoded,
 * so the array samples exactly as the separate textures did.
 */
import { createHash } from 'node:crypto';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 80;
const LEVEL_ENTRY_BYTES = 24;
/** `supercompressionScheme`: none, BasisLZ (ETC1S), Zstandard. */
const SUPERCOMPRESSION_NONE = 0;
const SUPERCOMPRESSION_ZSTD = 2;
/** The DFD's colour model of UASTC LDR 4×4 (KHR_DF_MODEL_UASTC). */
const DF_MODEL_UASTC = 166;
/** UASTC's DFD channel ids: opaque RGB, RGBA (the blocks hold alpha either way; an opaque one reads 255). */
const UASTC_CHANNEL_RGB = 0;
const UASTC_CHANNEL_RGBA = 3;
/** The DFD's flag of premultiplied alpha (KHR_DF_FLAG_ALPHA_PREMULTIPLIED). */
const DF_FLAG_ALPHA_PREMULTIPLIED = 1;
/** The DFD's transfer function: linear, sRGB. */
export const KTX2_TRANSFER_LINEAR = 1;
export const KTX2_TRANSFER_SRGB = 2;
/**
 * The Zstandard level of a joined array: Basis Universal's own default for
 * UASTC supercompression, so a joined array is about the size the encoder
 * would have written.
 */
export const KTX2_ZSTD_LEVEL = 6;
/**
 * The most decompressed bytes a joined array's largest mip level may hold
 * (all layers; UASTC is one byte per texel): the join holds that level twice
 * while it compresses it. 256 MiB is 64 layers of 2048² or 16 of 4096².
 */
export const KTX2_JOIN_LEVEL_BYTES_MAX = 256 * 1024 * 1024;

export interface Ktx2Container {
  width: number;
  height: number;
  depth: number;
  /** 0: one 2D image; 2 or more: a texture array. */
  layerCount: number;
  faceCount: number;
  supercompression: number;
  /** The header's level count was 0: one level stored, the loader makes the mips. */
  mipsAtLoad: boolean;
  /** Basic DFD block fields. */
  colorModel: number;
  colorPrimaries: number;
  transfer: number;
  /** The DFD's flags (bit 0: alpha premultiplied). */
  dfdFlags: number;
  /** The first sample's channel id (UASTC: RGB, RGBA, RRR, …). */
  channelId: number;
  dfd: Uint8Array;
  kvd: Uint8Array;
  /** Each mip level as stored (level 0 first) and its size once decompressed. */
  levels: { stored: Uint8Array; uncompressedByteLength: number }[];
}

/** The container's parts; null when it is not a well-formed KTX2 (offsets inside the file). */
export function readKtx2(bytes: Uint8Array): Ktx2Container | null {
  if (bytes.length < HEADER_BYTES || KTX2_ID.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number): number => dv.getUint32(o, true);
  const u64 = (o: number): number => {
    const v = dv.getBigUint64(o, true);
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
  };
  const inside = (off: number, len: number): boolean => off >= 0 && len >= 0 && off + len <= bytes.length;
  const levelCount = Math.max(1, u32(40));
  const mipsAtLoad = u32(40) === 0;
  if (!inside(HEADER_BYTES, levelCount * LEVEL_ENTRY_BYTES)) return null;
  const dfdOffset = u32(48);
  const dfdLength = u32(52);
  const kvdOffset = u32(56);
  const kvdLength = u32(60);
  if (dfdLength < 28 || !inside(dfdOffset, dfdLength) || !inside(kvdOffset, kvdLength)) return null;
  const levels: Ktx2Container['levels'] = [];
  for (let i = 0; i < levelCount; i++) {
    const e = HEADER_BYTES + i * LEVEL_ENTRY_BYTES;
    const off = u64(e);
    const len = u64(e + 8);
    if (!inside(off, len)) return null;
    levels.push({ stored: bytes.subarray(off, off + len), uncompressedByteLength: u64(e + 16) });
  }
  return {
    width: u32(20),
    height: u32(24),
    depth: u32(28),
    layerCount: u32(32),
    faceCount: u32(36),
    supercompression: u32(44),
    mipsAtLoad,
    colorModel: bytes[dfdOffset + 12]!,
    colorPrimaries: bytes[dfdOffset + 13]!,
    transfer: bytes[dfdOffset + 14]!,
    dfdFlags: bytes[dfdOffset + 15]!,
    channelId: bytes[dfdOffset + 31]! & 0x0f,
    dfd: bytes.subarray(dfdOffset, dfdOffset + dfdLength),
    kvd: bytes.subarray(kvdOffset, kvdOffset + kvdLength),
    levels,
  };
}

/**
 * The key/value data's entries (key → value bytes, a string value's
 * terminating NUL included as stored). A malformed entry ends the list.
 */
export function ktx2KeyValues(kvd: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(kvd.buffer, kvd.byteOffset, kvd.byteLength);
  let at = 0;
  while (at + 4 <= kvd.length) {
    const len = dv.getUint32(at, true);
    const start = at + 4;
    if (len === 0 || start + len > kvd.length) break;
    const entry = kvd.subarray(start, start + len);
    const nul = entry.indexOf(0);
    if (nul <= 0) break;
    out.set(Buffer.from(entry.subarray(0, nul)).toString('utf8'), entry.subarray(nul + 1));
    at = start + len + ((4 - (len % 4)) % 4);
  }
  return out;
}

/** The bytes one UASTC mip level holds once decompressed: 16 per 4×4 block, for every layer, face and slice. */
function uastcLevelBytes(c: Ktx2Container, level: number): number {
  const blocks = Math.ceil(Math.max(1, c.width >> level) / 4) * Math.ceil(Math.max(1, c.height >> level) / 4);
  return blocks * 16 * Math.max(1, c.layerCount) * Math.max(1, c.faceCount) * Math.max(1, c.depth >> level);
}

/**
 * One mip level's data, decompressed (every layer, face and slice of it, in
 * order). Only UASTC levels are decompressed: their size follows from the
 * image's, so a level declaring another size is refused before any byte is
 * inflated, and the inflation is bounded by that size (a corrupt upload
 * cannot expand past what its image could hold).
 */
export function ktx2LevelData(c: Ktx2Container, level: number): Uint8Array {
  const l = c.levels[level];
  if (l === undefined) throw new Error(`no mip level ${level}`);
  if (c.supercompression === SUPERCOMPRESSION_NONE) return l.stored;
  if (c.supercompression !== SUPERCOMPRESSION_ZSTD) throw new Error(`supercompression ${c.supercompression} is not Zstandard`);
  if (c.colorModel !== DF_MODEL_UASTC) throw new Error('only UASTC levels are decompressed here');
  const expected = uastcLevelBytes(c, level);
  if (l.uncompressedByteLength !== expected) throw new Error(`mip level ${level} declares ${l.uncompressedByteLength} bytes, not the ${expected} of its size`);
  return new Uint8Array(zstdDecompressSync(l.stored, { maxOutputLength: expected }));
}

/** A digest of every decoded mip level (sha-256 per level, in level order): equal for the same texels. */
export function ktx2LevelDigests(c: Ktx2Container): string[] {
  return c.levels.map((_, i) => createHash('sha256').update(ktx2LevelData(c, i)).digest('hex'));
}

/** A container's `KTXorientation` value ("" when it has none: the format's default, "rd"). */
function orientationOf(c: Ktx2Container): string {
  const v = ktx2KeyValues(c.kvd).get('KTXorientation');
  return v === undefined ? '' : Buffer.from(v).toString('utf8').replace(/\0+$/, '');
}

/**
 * Join single-image UASTC textures into one array (one source: a plain 2D
 * texture), the texels unchanged. Every source must be UASTC LDR, one 2D
 * image (no array, no cube, no depth), stored plain or with Zstandard, and
 * all must share size, mip count (a count of 0, mips made at load, too),
 * colour primaries, `transfer`, the premultiplied-alpha flag and the
 * `KTXorientation` value: the array takes one DFD and one key/value block,
 * so a layer differing in any of them would be read as another image.
 * Opaque and alpha sources mix (the array's DFD says RGBA). The reason names
 * the first source that cannot join.
 */
export function joinUastcLayers(sources: readonly Uint8Array[], transfer: number): { ok: true; ktx2: Uint8Array } | { ok: false; reason: string } {
  if (sources.length < 1) return { ok: false, reason: 'no sources' };
  const parsed: Ktx2Container[] = [];
  for (let i = 0; i < sources.length; i++) {
    const c = readKtx2(sources[i]!);
    const which = `layer ${i + 1}`;
    if (c === null) return { ok: false, reason: `${which} is not a readable KTX2` };
    if (c.colorModel !== DF_MODEL_UASTC) return { ok: false, reason: `${which} is not UASTC` };
    if (c.supercompression !== SUPERCOMPRESSION_NONE && c.supercompression !== SUPERCOMPRESSION_ZSTD) return { ok: false, reason: `${which} uses another supercompression` };
    if (c.layerCount > 1 || c.faceCount !== 1 || c.depth > 1) return { ok: false, reason: `${which} is not a single 2D image` };
    if (c.channelId !== UASTC_CHANNEL_RGB && c.channelId !== UASTC_CHANNEL_RGBA) return { ok: false, reason: `${which} stores other channels than RGB(A)` };
    if (c.transfer !== transfer) return { ok: false, reason: `${which} is ${c.transfer === KTX2_TRANSFER_SRGB ? 'sRGB' : 'linear'}, the encoding wants ${transfer === KTX2_TRANSFER_SRGB ? 'sRGB' : 'linear'}` };
    const first = parsed[0];
    if (first !== undefined) {
      if (c.width !== first.width || c.height !== first.height) return { ok: false, reason: `${which} is ${c.width}×${c.height}, layer 1 ${first.width}×${first.height}` };
      if (c.levels.length !== first.levels.length) return { ok: false, reason: `${which} has ${c.levels.length} mip levels, layer 1 ${first.levels.length}` };
      if (c.mipsAtLoad !== first.mipsAtLoad) return { ok: false, reason: `${which} ${c.mipsAtLoad ? 'leaves its mips to the loader' : 'stores its mips'}, layer 1 does not` };
      if (c.colorPrimaries !== first.colorPrimaries) return { ok: false, reason: `${which} has other colour primaries than layer 1` };
      if ((c.dfdFlags & DF_FLAG_ALPHA_PREMULTIPLIED) !== (first.dfdFlags & DF_FLAG_ALPHA_PREMULTIPLIED)) return { ok: false, reason: `${which}'s alpha is ${c.dfdFlags & DF_FLAG_ALPHA_PREMULTIPLIED ? '' : 'not '}premultiplied, layer 1's is${first.dfdFlags & DF_FLAG_ALPHA_PREMULTIPLIED ? '' : ' not'}` };
      if (orientationOf(c) !== orientationOf(first)) return { ok: false, reason: `${which}'s orientation (KTXorientation "${orientationOf(c)}") is not layer 1's ("${orientationOf(first)}")` };
    }
    parsed.push(c);
  }
  const level0 = Math.ceil(parsed[0]!.width / 4) * Math.ceil(parsed[0]!.height / 4) * 16 * parsed.length;
  if (level0 > KTX2_JOIN_LEVEL_BYTES_MAX) return { ok: false, reason: `the array's largest mip level would hold ${level0} bytes, more than the ${KTX2_JOIN_LEVEL_BYTES_MAX} a join takes` };
  // The DFD of an alpha source when there is one (an opaque block still decodes alpha 255), else the first's.
  const head = parsed.find((c) => c.channelId === UASTC_CHANNEL_RGBA) ?? parsed[0]!;
  const levels: { data: Uint8Array; uncompressed: number }[] = [];
  try {
    for (let l = 0; l < head.levels.length; l++) {
      const parts = parsed.map((c) => ktx2LevelData(c, l));
      // A UASTC level is 16 bytes per 4×4 block; anything else is not the image its header claims.
      const expected = Math.max(1, Math.ceil(Math.max(1, head.width >> l) / 4)) * Math.max(1, Math.ceil(Math.max(1, head.height >> l) / 4)) * 16;
      const bad = parts.findIndex((p) => p.length !== expected);
      if (bad >= 0) return { ok: false, reason: `layer ${bad + 1}'s mip level ${l} holds ${parts[bad]!.length} bytes, not the ${expected} of its size` };
      const raw = Buffer.concat(parts);
      levels.push({ data: new Uint8Array(zstdCompressSync(raw, { params: { [zlibConstants.ZSTD_c_compressionLevel]: KTX2_ZSTD_LEVEL } })), uncompressed: raw.length });
    }
  } catch (e) {
    return { ok: false, reason: `a level could not be decompressed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, ktx2: writeKtx2({ ...head, layerCount: sources.length > 1 ? sources.length : 0, supercompression: SUPERCOMPRESSION_ZSTD }, levels) };
}

/**
 * Write a KTX2: header, level index, DFD, key/value data, then the levels
 * from the smallest to the largest (the order the format stores them in;
 * no padding between supercompressed levels, no global data).
 */
export function writeKtx2(c: Pick<Ktx2Container, 'width' | 'height' | 'depth' | 'layerCount' | 'faceCount' | 'supercompression' | 'mipsAtLoad' | 'dfd' | 'kvd'>, levels: readonly { data: Uint8Array; uncompressed: number }[]): Uint8Array {
  const indexEnd = HEADER_BYTES + levels.length * LEVEL_ENTRY_BYTES;
  const dfdOffset = indexEnd;
  const kvdOffset = dfdOffset + c.dfd.length;
  let at = kvdOffset + c.kvd.length;
  const offsets: number[] = new Array<number>(levels.length);
  for (let l = levels.length - 1; l >= 0; l--) {
    offsets[l] = at;
    at += levels[l]!.data.length;
  }
  const out = new Uint8Array(at);
  const dv = new DataView(out.buffer);
  out.set(KTX2_ID, 0);
  // vkFormat 0 (a Basis Universal payload), typeSize 1.
  dv.setUint32(12, 0, true);
  dv.setUint32(16, 1, true);
  dv.setUint32(20, c.width, true);
  dv.setUint32(24, c.height, true);
  dv.setUint32(28, c.depth, true);
  dv.setUint32(32, c.layerCount, true);
  dv.setUint32(36, c.faceCount, true);
  dv.setUint32(40, c.mipsAtLoad ? 0 : levels.length, true);
  dv.setUint32(44, c.supercompression, true);
  dv.setUint32(48, dfdOffset, true);
  dv.setUint32(52, c.dfd.length, true);
  dv.setUint32(56, c.kvd.length > 0 ? kvdOffset : 0, true);
  dv.setUint32(60, c.kvd.length, true);
  dv.setBigUint64(64, 0n, true);
  dv.setBigUint64(72, 0n, true);
  for (let l = 0; l < levels.length; l++) {
    const e = HEADER_BYTES + l * LEVEL_ENTRY_BYTES;
    dv.setBigUint64(e, BigInt(offsets[l]!), true);
    dv.setBigUint64(e + 8, BigInt(levels[l]!.data.length), true);
    dv.setBigUint64(e + 16, BigInt(levels[l]!.uncompressed), true);
    out.set(levels[l]!.data, offsets[l]!);
  }
  out.set(c.dfd, dfdOffset);
  out.set(c.kvd, kvdOffset);
  return out;
}
