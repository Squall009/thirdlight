/**
 * A probe tile's baked data as a file and as a 3D texture.
 *
 * The file is a 16-bit RGBA PNG whose samples are half-float bit patterns
 * (lossless, so the probes read back exactly as baked; an 8-bit image cannot
 * hold the range of sunlit and dark probes): per probe `PROBE_TEXELS` texels,
 * `PROBE_ARTIFACT_ROW_PROBES` probes a row, probes in the order x, then y,
 * then z. A probe's first 28 values are its nine L2 spherical-harmonic RGB
 * coefficients (coefficient-major) and its validity; the next two texels
 * hold its walls (see project-model probe-grids.ts). A file of an older
 * layout (seven texels a probe, before the walls) is refused: bake again.
 *
 * The 3D texture is three.js's `LightProbeGrid` atlas with one more
 * sub-volume: RGBA half floats, nx × ny × PROBE_TEXELS (nz + 2) — a
 * sub-volume per probe texel along z, each with a padding slice at both ends
 * (a copy of its edge slice, so trilinear filtering never reads across
 * sub-volumes); texel t of a probe goes to sub-volume t. The probe lighting
 * (probe-lighting.ts) samples it.
 *
 * Pure apart from `CompressionStream` (encoding, in the editor's bake).
 */
import { isPng, pngBytes } from '@thirdlight/shared';
import * as THREE from 'three';
import { decodePngRgba, MAX_TEXTURE_EDGE, PROBE_ARTIFACT_ROW_PROBES, PROBE_ATLAS_PADDING, PROBE_SH_TEXELS, PROBE_TEXELS, probeArtifactSize, probeCount, type ProbeGridBox } from '@thirdlight/project-model';

/** The value index of a probe's validity (the last of its light's texels). */
const VALIDITY = PROBE_SH_TEXELS * 4 - 1;

/**
 * The file's samples (half floats) from per-probe SH (27 floats each),
 * validity and walls (6 floats each: per axis the cut flag and the cut's
 * share of the edge; absent: no walls).
 */
export function packProbeTexels(sh: Float32Array, validity: Float32Array, walls?: Float32Array): { width: number; height: number; samples: Uint16Array } {
  const probes = validity.length;
  const { width, height } = probeArtifactSize(probes);
  const samples = new Uint16Array(width * height * 4);
  for (let p = 0; p < probes; p++) {
    const base = (Math.floor(p / PROBE_ARTIFACT_ROW_PROBES) * width + (p % PROBE_ARTIFACT_ROW_PROBES) * PROBE_TEXELS) * 4;
    for (let v = 0; v < 27; v++) samples[base + v] = THREE.DataUtils.toHalfFloat(sh[p * 27 + v]!);
    samples[base + VALIDITY] = THREE.DataUtils.toHalfFloat(validity[p]!);
    if (walls === undefined) continue;
    // (cut x, cut x × where, cut y, cut y × where), (cut z, cut z × where, 0, 0).
    for (let a = 0; a < 3; a++) {
      const cut = walls[p * 6 + a * 2]!;
      samples[base + PROBE_SH_TEXELS * 4 + a * 2] = THREE.DataUtils.toHalfFloat(cut);
      samples[base + PROBE_SH_TEXELS * 4 + a * 2 + 1] = THREE.DataUtils.toHalfFloat(cut * walls[p * 6 + a * 2 + 1]!);
    }
  }
  return { width, height, samples };
}

async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A 16-bit RGBA PNG of these samples (big-endian, as PNG stores them; no row filter). */
export async function encodePng16(width: number, height: number, samples: Uint16Array): Promise<Uint8Array> {
  const stride = width * 8 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let i = 0; i < width * 4; i++) {
      const v = samples[y * width * 4 + i]!;
      raw[row + 1 + i * 2] = v >>> 8;
      raw[row + 2 + i * 2] = v & 0xff;
    }
  }
  const idat = await zlib(raw);
  return pngBytes({ width, height, bitDepth: 16, colorType: 6, idat });
}

/** A tile's 3D texture data (three's atlas layout, a sub-volume per probe texel) from the file's samples. */
export function atlasFromSamples(samples: Uint16Array, resolution: readonly number[]): Uint16Array {
  const [nx, ny, nz] = resolution as [number, number, number];
  const probes = nx * ny * nz;
  const width = probeArtifactSize(probes).width;
  const padded = nz + 2 * PROBE_ATLAS_PADDING;
  const atlas = new Uint16Array(nx * ny * PROBE_TEXELS * padded * 4);
  const put = (slice: number, ix: number, iy: number, from: number): void => {
    const o = ((slice * ny + iy) * nx + ix) * 4;
    atlas[o] = samples[from]!;
    atlas[o + 1] = samples[from + 1]!;
    atlas[o + 2] = samples[from + 2]!;
    atlas[o + 3] = samples[from + 3]!;
  };
  for (let p = 0; p < probes; p++) {
    const ix = p % nx;
    const iy = Math.floor(p / nx) % ny;
    const iz = Math.floor(p / (nx * ny));
    const base = (Math.floor(p / PROBE_ARTIFACT_ROW_PROBES) * width + (p % PROBE_ARTIFACT_ROW_PROBES) * PROBE_TEXELS) * 4;
    for (let t = 0; t < PROBE_TEXELS; t++) {
      const from = base + t * 4;
      const first = t * padded;
      put(first + PROBE_ATLAS_PADDING + iz, ix, iy, from);
      if (iz === 0) put(first, ix, iy, from);
      if (iz === nz - 1) put(first + PROBE_ATLAS_PADDING + nz, ix, iy, from);
    }
  }
  return atlas;
}

/** Each probe's validity from the file's samples. */
function validityOf(samples: Uint16Array, width: number, probes: number): Float32Array {
  const validity = new Float32Array(probes);
  for (let p = 0; p < probes; p++) {
    const base = (Math.floor(p / PROBE_ARTIFACT_ROW_PROBES) * width + (p % PROBE_ARTIFACT_ROW_PROBES) * PROBE_TEXELS) * 4;
    validity[p] = THREE.DataUtils.fromHalfFloat(samples[base + VALIDITY]!);
  }
  return validity;
}

const wrongSize = (size: { width: number; height: number }): { ok: false; message: string } => ({ ok: false, message: `the probe file is not a ${size.width} × ${size.height} 16-bit RGBA image (an older layout: bake the probes again)` });

/** A tile's 3D texture data from its file, and each probe's validity. */
export function decodeProbeArtifact(bytes: Uint8Array, grid: Pick<ProbeGridBox, 'resolution'>): { ok: true; atlas: Uint16Array; validity: Float32Array } | { ok: false; message: string } {
  const decoded = decodePngRgba(bytes, { keep16: true, maxPixels: MAX_TEXTURE_EDGE * MAX_TEXTURE_EDGE });
  if (!decoded.ok) return decoded;
  const src = decoded.png.rgba16;
  const probes = probeCount(grid);
  const size = probeArtifactSize(probes);
  if (src === undefined || decoded.png.width !== size.width || decoded.png.height !== size.height) return wrongSize(size);
  return { ok: true, atlas: atlasFromSamples(src, grid.resolution), validity: validityOf(src, size.width, probes) };
}

/** The 16-bit RGBA PNG's header and its compressed image data, or null for any other PNG (the general decoder reads those). */
function probePngParts(bytes: Uint8Array): { width: number; height: number; idat: Uint8Array } | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let header: { width: number; height: number } | null = null;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (type === 'IHDR') {
      // 16 bits, RGBA, no interlace.
      if (length < 13 || body[8] !== 16 || body[9] !== 6 || body[12] !== 0) return null;
      header = { width: view.getUint32(at + 8), height: view.getUint32(at + 12) };
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (header === null || parts.length === 0) return null;
  const idat = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) {
    idat.set(b, o);
    o += b.length;
  }
  return { ...header, idat };
}

/** Inflate a zlib stream natively (off the main thread's JavaScript), refusing more than `max` bytes. */
async function inflateNative(z: Uint8Array, max: number): Promise<Uint8Array | null> {
  const reader = new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const out = new Uint8Array(max);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) {
      await reader.cancel();
      return null;
    }
    out.set(value, n);
    n += value.length;
  }
  return n === max ? out : null;
}

/** Undo the PNG row filters of 16-bit RGBA rows (8 bytes a pixel) into big-endian samples. */
function unfilterRgba16(raw: Uint8Array, width: number, height: number): Uint16Array | null {
  const stride = width * 8;
  const samples = new Uint16Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const f = raw[at]!;
    if (f > 4) return null;
    for (let i = 0; i < stride; i++) {
      const x = raw[at + 1 + i]!;
      const a = i >= 8 ? cur[i - 8]! : 0;
      const b = prev[i]!;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else {
        const c = i >= 8 ? prev[i - 8]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    const row = y * width * 4;
    for (let i = 0; i < width * 4; i++) samples[row + i] = (cur[i * 2]! << 8) | cur[i * 2 + 1]!;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return samples;
}

/**
 * A tile's file as its samples (the file's layout: `PROBE_TEXELS` texels a
 * probe) and each probe's validity. The engine's own files (16-bit RGBA, no
 * interlace) inflate natively and asynchronously where the platform has
 * `DecompressionStream` — a streamed tile's arrival then costs the main
 * thread only the row filters, not the inflate; any other PNG goes through
 * the general decoder.
 */
export async function decodeProbeSamples(bytes: Uint8Array, grid: Pick<ProbeGridBox, 'resolution'>): Promise<{ ok: true; samples: Uint16Array; validity: Float32Array } | { ok: false; message: string }> {
  const probes = probeCount(grid);
  const size = probeArtifactSize(probes);
  const parts = typeof DecompressionStream === 'function' ? probePngParts(bytes) : null;
  if (parts !== null) {
    if (parts.width !== size.width || parts.height !== size.height) return wrongSize(size);
    const raw = await inflateNative(parts.idat, (size.width * 8 + 1) * size.height).catch(() => null);
    const samples = raw === null ? null : unfilterRgba16(raw, size.width, size.height);
    if (samples === null) return { ok: false, message: 'the probe file does not inflate to its image' };
    return { ok: true, samples, validity: validityOf(samples, size.width, probes) };
  }
  const decoded = decodePngRgba(bytes, { keep16: true, maxPixels: MAX_TEXTURE_EDGE * MAX_TEXTURE_EDGE });
  if (!decoded.ok) return decoded;
  const src = decoded.png.rgba16;
  if (src === undefined || decoded.png.width !== size.width || decoded.png.height !== size.height) return wrongSize(size);
  return { ok: true, samples: src, validity: validityOf(src, size.width, probes) };
}

/**
 * Any 16-bit RGBA PNG's size and samples (the engine's own inflate natively
 * where the platform can, as probe files do; others through the general
 * decoder): what a saved lighting file is read with.
 */
export async function decodePng16(bytes: Uint8Array): Promise<{ ok: true; width: number; height: number; samples: Uint16Array } | { ok: false; message: string }> {
  const parts = typeof DecompressionStream === 'function' ? probePngParts(bytes) : null;
  if (parts !== null) {
    if (parts.width * parts.height > MAX_TEXTURE_EDGE * MAX_TEXTURE_EDGE) return { ok: false, message: 'the image is larger than a texture may be' };
    const raw = await inflateNative(parts.idat, (parts.width * 8 + 1) * parts.height).catch(() => null);
    const samples = raw === null ? null : unfilterRgba16(raw, parts.width, parts.height);
    if (samples === null) return { ok: false, message: 'the file does not inflate to its image' };
    return { ok: true, width: parts.width, height: parts.height, samples };
  }
  const decoded = decodePngRgba(bytes, { keep16: true, maxPixels: MAX_TEXTURE_EDGE * MAX_TEXTURE_EDGE });
  if (!decoded.ok) return decoded;
  const src = decoded.png.rgba16;
  if (src === undefined) return { ok: false, message: 'the file is not a 16-bit RGBA image' };
  return { ok: true, width: decoded.png.width, height: decoded.png.height, samples: src };
}
