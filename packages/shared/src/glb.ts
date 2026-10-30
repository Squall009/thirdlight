/**
 * The GLB 2.0 container: a 12-byte header, then a JSON chunk and an optional
 * BIN chunk. Reading and framing live here once; checking a file against the
 * import profile (chunk order, strict JSON, sizes) is the importer's and the
 * export scan's job, which report their own diagnostics.
 */

/** 'glTF', the header magic (little-endian). */
export const GLB_MAGIC = 0x46546c67;
/** 'JSON', the JSON chunk type. */
export const GLB_CHUNK_JSON = 0x4e4f534a;
/** 'BIN\0', the binary chunk type. */
export const GLB_CHUNK_BIN = 0x004e4942;

/** A GLB's parsed JSON and its first BIN chunk (a view into the file). */
export interface GlbParts {
  readonly json: Record<string, unknown>;
  readonly bin: Uint8Array | null;
}

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

/**
 * The JSON (which must be an object) and the first BIN chunk of a GLB 2.0
 * file, or why it cannot be read. Chunks past the declared length are
 * ignored; unknown chunk types are skipped.
 */
export function readGlb(glb: Uint8Array): GlbParts | string {
  if (glb.byteLength < 20) return 'the file is shorter than a GLB header';
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) return 'not a GLB (version 2)';
  const total = Math.min(view.getUint32(8, true), glb.byteLength);
  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > total) return 'a GLB chunk runs past the end of the file';
    if (type === GLB_CHUNK_JSON && json === null) {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(glb.subarray(start, start + length)));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'the GLB JSON is not an object';
        json = parsed as Record<string, unknown>;
      } catch {
        return 'the GLB JSON cannot be read';
      }
    } else if (type === GLB_CHUNK_BIN && bin === null) bin = glb.subarray(start, start + length);
    offset = start + length + pad4(length);
  }
  if (json === null) return 'the GLB has no JSON chunk';
  return { json, bin };
}

/**
 * A GLB file from JSON text and an optional BIN chunk. The JSON chunk is
 * padded with spaces and the BIN chunk with zeros to four bytes, as the
 * container requires; `bin: null` writes no BIN chunk.
 */
export function glbBytes(jsonText: string, bin: Uint8Array | null = null): Uint8Array {
  const text = new TextEncoder().encode(jsonText);
  const jsonLength = text.length + pad4(text.length);
  const binLength = bin === null ? 0 : bin.length + pad4(bin.length);
  const total = 12 + 8 + jsonLength + (bin === null ? 0 : 8 + binLength);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin !== null) {
    const at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, GLB_CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}
