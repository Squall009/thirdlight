/**
 * Distance-field bricks: what the lighting tracer knows of an imported
 * static model's shape. Blocks, terrain and generated architecture are
 * traced exactly from their own data; a model's triangles are not, so the
 * model gets a signed distance field, sparse, made once per model file
 * (cached with the asset and shipped in the export, never at load).
 *
 * - One set per top-level piece of the model (a model shown whole places
 *   all of them), in the model's root space.
 * - Samples on a grid of `voxel` metres: at least 32 and at most 128 along
 *   the model's longest side, else 10 cm (`distanceBrickVoxel`).
 * - Bricks of 8 × 8 × 8 cells hold their 9 × 9 × 9 corner samples (a
 *   brick's samples never need a neighbour's), quantized to a byte over
 *   ±`band` (two voxels). Only bricks the surface passes through store
 *   samples; the others say "outside" or "inside" in one word.
 * - The sign comes from the angle-weighted pseudo-normal of the nearest
 *   feature (face, edge or vertex), which holds on closed meshes; samples
 *   further than the band from every triangle are inside when the outside
 *   (flooded in from the field's border) cannot reach them, so a mesh with
 *   holes reads as a shell, never as solid.
 *
 * Pure and deterministic. This module is the format (what a game reads);
 * `distance-bricks-build.ts` makes the fields at import.
 */

/** Cells per brick side. */
export const DISTANCE_BRICK_CELLS = 8;
/** Samples per brick side (its corners included). */
export const DISTANCE_BRICK_SIDE = DISTANCE_BRICK_CELLS + 1;
/** Samples per brick. */
export const DISTANCE_BRICK_SAMPLES = DISTANCE_BRICK_SIDE ** 3;
/** A brick the surface does not pass through, outside the model. */
export const DISTANCE_BRICK_OUTSIDE = -1;
/** A brick wholly inside the model. */
export const DISTANCE_BRICK_INSIDE = -2;
/** The format's version (raised when a blob made before would read differently). */
export const DISTANCE_BRICKS_VERSION = 1;
/** Band of the stored distances, in voxels: a sample farther than this from the surface stores the band. */
export const DISTANCE_BRICK_BAND_VOXELS = 2;

/** One piece's field. */
export interface DistanceBrickSet {
  /** The top-level piece it is of (`''`: the model has one). */
  piece: string;
  /** The field's first sample, in the model's root space. */
  min: [number, number, number];
  voxel: number;
  /** Distances are stored over ±band (metres). */
  band: number;
  /** Bricks per axis. */
  dims: [number, number, number];
  /** Per brick (x fastest, then y, then z): its sample block, or OUTSIDE / INSIDE. */
  bricks: Int32Array;
  /** Sample blocks of `DISTANCE_BRICK_SAMPLES` bytes (x fastest, then y, then z): 0 is −band, 255 is +band. */
  samples: Uint8Array;
}

export interface DistanceBricks {
  sets: DistanceBrickSet[];
}

/** Sample spacing for a model whose longest side is `longest` metres. */
export function distanceBrickVoxel(longest: number): number {
  return Math.min(longest / 32, Math.max(longest / 128, 0.1));
}

/** A stored byte as a distance (metres). */
export function distanceOfSample(q: number, band: number): number {
  return ((q / 255) * 2 - 1) * band;
}

const MAGIC = 0x46444c54; // "TLDF"

/** Whether bytes start as a distance-brick blob (its magic; what an export's buffer check reads). */
export function isDistanceBricksBlob(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === MAGIC;
}

/** The bricks as one blob (little-endian): magic, version, set count, then each set. */
export function encodeDistanceBricks(b: DistanceBricks): Uint8Array {
  const enc = new TextEncoder();
  const names = b.sets.map((s) => enc.encode(s.piece));
  let size = 12;
  b.sets.forEach((s, i) => {
    size += 4 + Math.ceil(names[i]!.length / 4) * 4 + 4 * 9 + s.bricks.length * 4 + Math.ceil(s.samples.length / 4) * 4;
  });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const u32 = (v: number): void => {
    dv.setUint32(o, v >>> 0, true);
    o += 4;
  };
  const f32 = (v: number): void => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  u32(MAGIC);
  u32(DISTANCE_BRICKS_VERSION);
  u32(b.sets.length);
  b.sets.forEach((s, i) => {
    u32(names[i]!.length);
    out.set(names[i]!, o);
    o += Math.ceil(names[i]!.length / 4) * 4;
    for (const v of s.min) f32(v);
    f32(s.voxel);
    f32(s.band);
    for (const v of s.dims) u32(v);
    u32(s.samples.length / DISTANCE_BRICK_SAMPLES);
    for (const v of s.bricks) {
      dv.setInt32(o, v, true);
      o += 4;
    }
    out.set(s.samples, o);
    o += Math.ceil(s.samples.length / 4) * 4;
  });
  return out;
}

/** A blob back to bricks (null: not a distance-brick blob of this version, or cut short). */
export function decodeDistanceBricks(bytes: Uint8Array): DistanceBricks | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): boolean => o + n <= bytes.byteLength;
  const u32 = (): number => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = (): number => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  if (!need(12) || u32() !== MAGIC || u32() !== DISTANCE_BRICKS_VERSION) return null;
  const n = u32();
  const sets: DistanceBrickSet[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < n; i += 1) {
    if (!need(4)) return null;
    const len = u32();
    if (!need(Math.ceil(len / 4) * 4 + 36)) return null;
    const piece = dec.decode(bytes.subarray(o, o + len));
    o += Math.ceil(len / 4) * 4;
    const min: [number, number, number] = [f32(), f32(), f32()];
    const voxel = f32();
    const band = f32();
    const dims: [number, number, number] = [u32(), u32(), u32()];
    const filled = u32();
    const count = dims[0] * dims[1] * dims[2];
    if (!need(count * 4 + Math.ceil((filled * DISTANCE_BRICK_SAMPLES) / 4) * 4)) return null;
    const bricks = new Int32Array(count);
    for (let k = 0; k < count; k += 1) {
      bricks[k] = dv.getInt32(o, true);
      o += 4;
    }
    const samples = bytes.slice(o, o + filled * DISTANCE_BRICK_SAMPLES);
    o += Math.ceil((filled * DISTANCE_BRICK_SAMPLES) / 4) * 4;
    sets.push({ piece, min, voxel, band, dims, bricks, samples });
  }
  return { sets };
}
