/**
 * Image container facts for the import profile (project-model.md §18.7.2
 * step 11 and §18.6 `decodedImageBytes`).
 *
 * The profile never trusts the glTF `mimeType`, a file extension or a caller
 * declaration: the actual magic bytes decide. It also never decodes pixel
 * data (no decoder exists in M2 and none may be added here) — it reads the
 * container header's declared dimensions to compute the decoded pixel budget,
 * which is exactly the bounded resource the cap exists to protect. A header
 * that declares oversized dimensions is therefore rejected even when the
 * payload is small; this is deliberately *not* a full image validation.
 */

export type ImportImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/ktx2';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** `RIFF <size> WEBP` (EXT_texture_webp sources). */
function hasWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

/** `«KTX 20»\r\n\x1A\n` (KHR_texture_basisu sources). */
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasKtx2Signature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  for (let i = 0; i < 12; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  return true;
}

/** Detect the container by its actual magic bytes (`null` = none of them). */
export function detectImageMime(bytes: Uint8Array): ImportImageMime | null {
  if (hasPngSignature(bytes)) return 'image/png';
  if (hasJpegSignature(bytes)) return 'image/jpeg';
  if (hasWebpSignature(bytes)) return 'image/webp';
  if (hasKtx2Signature(bytes)) return 'image/ktx2';
  return null;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function u32be(bytes: Uint8Array, off: number): number {
  return (
    (((bytes[off] as number) << 24) |
      ((bytes[off + 1] as number) << 16) |
      ((bytes[off + 2] as number) << 8) |
      (bytes[off + 3] as number)) >>>
    0
  );
}

function u16be(bytes: Uint8Array, off: number): number {
  return (((bytes[off] as number) << 8) | (bytes[off + 1] as number)) & 0xffff;
}

/** PNG `IHDR` dims; `null` when the header is absent or malformed. */
export function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasPngSignature(bytes)) return null;
  // 8 signature + 4 length + 4 type + 13 data: IHDR must be the first chunk.
  if (bytes.length < 24) return null;
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** JPEG frame-header dims; `null` when no frame header is found. */
export function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasJpegSignature(bytes)) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    let marker = bytes[i + 1] as number;
    i += 2;
    while (marker === 0xff) {
      marker = bytes[i] as number;
      i += 1;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS: no frame header
    if (i + 2 > bytes.length) return null;
    const length = u16be(bytes, i);
    if (length < 2 || i + length > bytes.length) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = u16be(bytes, i + 3);
      const width = u16be(bytes, i + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    i += length;
  }
  return null;
}

function u24le(bytes: Uint8Array, off: number): number {
  return (bytes[off] as number) | ((bytes[off + 1] as number) << 8) | ((bytes[off + 2] as number) << 16);
}

/**
 * WebP canvas dims from the first chunk: `VP8 ` (lossy key frame: 14-bit
 * width/height after the 0x9d012a start code), `VP8L` (lossless: 0x2f then
 * 14-bit width-1/height-1) or `VP8X` (extended: 24-bit canvas width-1 and
 * height-1). `null` when the header is absent or malformed.
 */
export function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasWebpSignature(bytes) || bytes.length < 30) return null;
  const fourcc = String.fromCharCode(bytes[12] as number, bytes[13] as number, bytes[14] as number, bytes[15] as number);
  let width = 0;
  let height = 0;
  if (fourcc === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    width = ((bytes[26] as number) | ((bytes[27] as number) << 8)) & 0x3fff;
    height = ((bytes[28] as number) | ((bytes[29] as number) << 8)) & 0x3fff;
  } else if (fourcc === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21] as number;
    const b1 = bytes[22] as number;
    const b2 = bytes[23] as number;
    const b3 = bytes[24] as number;
    width = 1 + (((b1 & 0x3f) << 8) | b0);
    height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
  } else if (fourcc === 'VP8X') {
    width = 1 + u24le(bytes, 24);
    height = 1 + u24le(bytes, 27);
  } else {
    return null;
  }
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function u32le(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off] as number) | ((bytes[off + 1] as number) << 8) | ((bytes[off + 2] as number) << 16) | ((bytes[off + 3] as number) << 24)) >>> 0
  );
}

/**
 * KTX2 dims for a Basis Universal texture (KHR_texture_basisu): a 2D image
 * (no depth, one face, not an array) with `vkFormat` 0 (the payload is
 * Basis: ETC1S under BasisLZ supercompression 1, or UASTC with none/Zstandard
 * 0/2) and at most 32 mip levels. `null` for anything else.
 */
export function ktx2Dimensions(bytes: Uint8Array): ImageDimensions | null {
  if (!hasKtx2Signature(bytes) || bytes.length < 80) return null;
  const vkFormat = u32le(bytes, 12);
  const width = u32le(bytes, 20);
  const height = u32le(bytes, 24);
  const depth = u32le(bytes, 28);
  const layers = u32le(bytes, 32);
  const faces = u32le(bytes, 36);
  const levels = u32le(bytes, 40);
  const supercompression = u32le(bytes, 44);
  if (vkFormat !== 0 || depth !== 0 || layers !== 0 || faces !== 1) return null;
  if (supercompression !== 0 && supercompression !== 1 && supercompression !== 2) return null;
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  if (levels > 32) return null; // 0 = one level, mips generated at load
  return { width, height };
}

/** Declared dimensions for an accepted container; `null` when unreadable. */
export function imageDimensions(bytes: Uint8Array, mime: ImportImageMime): ImageDimensions | null {
  if (mime === 'image/png') return pngDimensions(bytes);
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  if (mime === 'image/ktx2') return ktx2Dimensions(bytes);
  return webpDimensions(bytes);
}

/**
 * Decoded pixel bytes for one image (4 bytes per pixel). Saturates at
 * `Number.MAX_SAFE_INTEGER` so a hostile header cannot produce a non-finite
 * or precision-lossy count (the cap check then rejects it).
 */
export function decodedImageBytes(dims: ImageDimensions): number {
  const pixels = dims.width * dims.height;
  const bytes = pixels * 4;
  return Number.isSafeInteger(bytes) ? bytes : Number.MAX_SAFE_INTEGER;
}
