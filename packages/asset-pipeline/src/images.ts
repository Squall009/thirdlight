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

export type ImportImageMime = 'image/png' | 'image/jpeg';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Detect the container by its actual magic bytes (`null` = neither). */
export function detectImageMime(bytes: Uint8Array): ImportImageMime | null {
  if (hasPngSignature(bytes)) return 'image/png';
  if (hasJpegSignature(bytes)) return 'image/jpeg';
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

/** Declared dimensions for either accepted container; `null` when unreadable. */
export function imageDimensions(bytes: Uint8Array, mime: ImportImageMime): ImageDimensions | null {
  return mime === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
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
