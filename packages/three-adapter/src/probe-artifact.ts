/**
 * A probe tile's baked data as a file and as a 3D texture.
 *
 * The file is a 16-bit RGBA PNG whose samples are half-float bit patterns
 * (lossless, so the probes read back exactly as baked; an 8-bit image cannot
 * hold the range of sunlit and dark probes): per probe `PROBE_TEXELS` texels,
 * `PROBE_ARTIFACT_ROW_PROBES` probes a row, probes in the order x, then y,
 * then z. A probe's 28 values are its nine L2 spherical-harmonic RGB
 * coefficients (coefficient-major) and its validity.
 *
 * The 3D texture is three.js's `LightProbeGrid` atlas: RGBA half floats,
 * nx × ny × 7 (nz + 2) — seven sub-volumes along z, each with a padding slice
 * at both ends (a copy of its edge slice, so trilinear filtering never reads
 * across sub-volumes); texel t of a probe goes to sub-volume t. A grid built
 * from it draws through three's `LightProbeGridNode`.
 *
 * Pure apart from `CompressionStream` (encoding, in the editor's bake).
 */
import * as THREE from 'three';
import { LightProbeGrid } from 'three/examples/jsm/lighting/LightProbeGrid.js';
import { decodePngRgba, MAX_TEXTURE_EDGE, PROBE_ARTIFACT_ROW_PROBES, PROBE_ATLAS_PADDING, PROBE_TEXELS, probeArtifactSize, probeCount, type ProbeGridBox } from '@thirdlight/runtime';

/** Values per probe in the file: 27 SH values and the validity. */
const VALUES = PROBE_TEXELS * 4;

/** The file's samples (half floats) from per-probe SH (27 floats each) and validity. */
export function packProbeTexels(sh: Float32Array, validity: Float32Array): { width: number; height: number; samples: Uint16Array } {
  const probes = validity.length;
  const { width, height } = probeArtifactSize(probes);
  const samples = new Uint16Array(width * height * 4);
  for (let p = 0; p < probes; p++) {
    const base = (Math.floor(p / PROBE_ARTIFACT_ROW_PROBES) * width + (p % PROBE_ARTIFACT_ROW_PROBES) * PROBE_TEXELS) * 4;
    for (let v = 0; v < 27; v++) samples[base + v] = THREE.DataUtils.toHalfFloat(sh[p * 27 + v]!);
    samples[base + 27] = THREE.DataUtils.toHalfFloat(validity[p]!);
  }
  return { width, height, samples };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr.set([16, 6, 0, 0, 0], 8);
  const chunks: [string, Uint8Array][] = [
    ['IHDR', ihdr],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  const out = new Uint8Array(8 + chunks.reduce((n, [, b]) => n + 12 + b.length, 0));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  let at = 8;
  for (const [type, body] of chunks) {
    view.setUint32(at, body.length);
    const typed = new Uint8Array(4 + body.length);
    for (let i = 0; i < 4; i++) typed[i] = type.charCodeAt(i);
    typed.set(body, 4);
    out.set(typed, at + 4);
    view.setUint32(at + 8 + body.length, crc32(typed));
    at += 12 + body.length;
  }
  return out;
}

/** A tile's 3D texture data (three's atlas layout) from the file's samples. */
export function atlasFromSamples(samples: Uint16Array, resolution: readonly number[]): Uint16Array {
  const [nx, ny, nz] = resolution as [number, number, number];
  const probes = nx * ny * nz;
  const width = probeArtifactSize(probes).width;
  const padded = nz + 2 * PROBE_ATLAS_PADDING;
  const atlas = new Uint16Array(nx * ny * 7 * padded * 4);
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

/** A tile's 3D texture data from its file, and each probe's validity. */
export function decodeProbeArtifact(bytes: Uint8Array, grid: Pick<ProbeGridBox, 'resolution'>): { ok: true; atlas: Uint16Array; validity: Float32Array } | { ok: false; message: string } {
  const decoded = decodePngRgba(bytes, { keep16: true, maxPixels: MAX_TEXTURE_EDGE * MAX_TEXTURE_EDGE });
  if (!decoded.ok) return decoded;
  const src = decoded.png.rgba16;
  const probes = probeCount(grid);
  const size = probeArtifactSize(probes);
  if (src === undefined || decoded.png.width !== size.width || decoded.png.height !== size.height) return { ok: false, message: `the probe file is not a ${size.width} × ${size.height} 16-bit RGBA image` };
  const validity = new Float32Array(probes);
  for (let p = 0; p < probes; p++) {
    const base = (Math.floor(p / PROBE_ARTIFACT_ROW_PROBES) * size.width + (p % PROBE_ARTIFACT_ROW_PROBES) * PROBE_TEXELS) * 4;
    validity[p] = THREE.DataUtils.fromHalfFloat(src[base + VALUES - 1]!);
  }
  return { ok: true, atlas: atlasFromSamples(src, grid.resolution), validity };
}

/** three's atlas as a texture (linear filtering between probes). */
export function probeAtlasTexture(atlas: Uint16Array, resolution: readonly number[]): THREE.Data3DTexture {
  const [nx, ny, nz] = resolution as [number, number, number];
  const tex = new THREE.Data3DTexture(atlas, nx, ny, 7 * (nz + 2 * PROBE_ATLAS_PADDING));
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A three `LightProbeGrid` over a tile with this atlas. As a light in a
 * scene it adds the probes' irradiance to every lit node material (the bake's
 * bounce passes use it so); `falloff` limits it to its own box, so tiles
 * side by side do not add up. The caller owns (and disposes) the texture.
 */
export function probeGridLight(grid: ProbeGridBox, texture: THREE.Data3DTexture): LightProbeGrid {
  const [w, h, d] = [grid.max[0] - grid.min[0], grid.max[1] - grid.min[1], grid.max[2] - grid.min[2]];
  const light = new LightProbeGrid(w, h, d, grid.resolution[0], grid.resolution[1], grid.resolution[2]);
  light.position.set((grid.min[0] + grid.max[0]) / 2, (grid.min[1] + grid.max[1]) / 2, (grid.min[2] + grid.max[2]) / 2);
  light.texture = texture;
  light.falloff = 1e-3;
  light.updateBoundingBox();
  return light;
}
