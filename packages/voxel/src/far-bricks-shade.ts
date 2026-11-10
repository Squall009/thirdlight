/**
 * Far bricks' shading baked per sample: the colour a sample's look word
 * gives (from a palette of far colours by word) and the ambient occlusion
 * the field gives there, so the draw reads both with one filtered read of
 * a colour texture instead of eight look words, eight table and eight
 * array reads and two more field reads a pixel.
 *
 * Why it may move off the pixel: the fine shading blends the eight samples
 * round a hit by the hit's trilinear weights, which is what a filtered read
 * of per-sample colours does; its occlusion is a smooth function of the
 * field, so its value at the samples, filtered the same way, stays within a
 * few percent of its value at the hit (`far-bricks-shade.test.ts`).
 *
 * {@link farBrickFineShade} is the fine shading on the CPU as the draw had
 * it, kept to measure the bake against.
 */
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import { FAR_BRICK_SKIRT_SLOPE, farBrickCount, type FarBricks } from './far-bricks';

/** The gradient (cells a cell) below which a hit's normal is not the field's (samples clamped to the band). */
export const FAR_BRICK_GRADIENT_MIN = 0.05;

/**
 * Half the span (cells) of the central differences a hit's normal is taken over. A cell either side, not half a
 * cell: the field between samples is their trilinear blend, whose slope changes from cell to cell where the surface
 * is not a plane, and a gentle slope's normal then swung by a few degrees a cell, which the low sun and the grazing
 * view turn into fine light and dark lines along the slope; over two cells it varies about half as much (and costs
 * the same six reads).
 */
export const FAR_BRICK_NORMAL_SPAN_CELLS = 1;

/** How dark a fully occluded hit gets under the fine shading's ambient occlusion (its colour times this). */
export const FAR_BRICK_AO_FLOOR = 0.5;

/** Bytes a baked sample takes: linear red, green, blue and the occlusion (0 shut … 255 open). */
export const FAR_BRICK_BAKED_BYTES = 4;

/** Far colours by look word (material | wetness << 12): linear RGBA bytes, the alpha unused. */
export type FarPalette = Uint8Array;

/** Look words a far palette holds (every material and wetness the word can carry). */
export const FAR_PALETTE_WORDS = 1 << 16;

const C = DISTANCE_BRICK_CELLS;
const S = DISTANCE_BRICK_SIDE;

/** The block's distance (cells) at a point inside it (cells 0–8 an axis, clamped), trilinear as the GPU's filtered read. */
function sampleAt(samples: Uint8Array, o: number, x: number, y: number, z: number): number {
  x = Math.min(C, Math.max(0, x));
  y = Math.min(C, Math.max(0, y));
  z = Math.min(C, Math.max(0, z));
  const ix = Math.min(C - 1, Math.floor(x)), iy = Math.min(C - 1, Math.floor(y)), iz = Math.min(C - 1, Math.floor(z));
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const i = o + (iz * S + iy) * S + ix;
  const a = samples[i]! + (samples[i + 1]! - samples[i]!) * fx;
  const b = samples[i + S]! + (samples[i + S + 1]! - samples[i + S]!) * fx;
  const c = samples[i + S * S]! + (samples[i + S * S + 1]! - samples[i + S * S]!) * fx;
  const d = samples[i + S * S + S]! + (samples[i + S * S + S + 1]! - samples[i + S * S + S]!) * fx;
  const ab = a + (b - a) * fy;
  const cd = c + (d - c) * fy;
  return distanceOfSample(ab + (cd - ab) * fz, DISTANCE_BRICK_BAND_VOXELS);
}

/** The draw's field at a point (cells): the block's distance, and past the brick its skirt's. */
function fieldAt(samples: Uint8Array, o: number, x: number, y: number, z: number): number {
  const qx = Math.min(C, Math.max(0, x)), qy = Math.min(C, Math.max(0, y)), qz = Math.min(C, Math.max(0, z));
  return sampleAt(samples, o, qx, qy, qz) + FAR_BRICK_SKIRT_SLOPE * Math.hypot(x - qx, y - qy, z - qz);
}

/** The samples' gradient at a point, read inside the brick only (as the draw's normal), into `out`. */
export function farBrickGradient(samples: Uint8Array, block: number, p: readonly number[], out: number[] = [0, 0, 0]): number[] {
  const o = block * DISTANCE_BRICK_SAMPLES;
  for (let axis = 0; axis < 3; axis++) {
    const a = [p[0]!, p[1]!, p[2]!];
    const b = [p[0]!, p[1]!, p[2]!];
    a[axis] = Math.min(C, Math.max(0, a[axis]! + FAR_BRICK_NORMAL_SPAN_CELLS));
    b[axis] = Math.min(C, Math.max(0, b[axis]! - FAR_BRICK_NORMAL_SPAN_CELLS));
    for (const q of [a, b]) for (let k = 0; k < 3; k++) q[k] = Math.min(C, Math.max(0, q[k]!));
    const len = Math.max(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!), 1e-3);
    out[axis] = (sampleAt(samples, o, a[0]!, a[1]!, a[2]!) - sampleAt(samples, o, b[0]!, b[1]!, b[2]!)) / len;
  }
  return out;
}

/** The fine shading's occlusion at a point of a block (0 shut … 1 open): the field one and two cells out along the normal; `up` where there is no gradient. */
export function farBrickOcclusionAt(samples: Uint8Array, block: number, p: readonly number[], g: number[] = [0, 0, 0]): number {
  farBrickGradient(samples, block, p, g);
  const len = Math.hypot(g[0]!, g[1]!, g[2]!);
  const n = len > FAR_BRICK_GRADIENT_MIN ? [g[0]! / len, g[1]! / len, g[2]! / len] : [0, 1, 0];
  const o = block * DISTANCE_BRICK_SAMPLES;
  const a1 = Math.min(1, Math.max(0, fieldAt(samples, o, p[0]! + n[0]!, p[1]! + n[1]!, p[2]! + n[2]!)));
  const a2 = Math.min(1, Math.max(0, fieldAt(samples, o, p[0]! + 2 * n[0]!, p[1]! + 2 * n[1]!, p[2]! + 2 * n[2]!) / 2));
  return (a1 + a2) / 2;
}

/** Every sample's occlusion of a node's bricks, a byte a sample (as {@link FarBricks.samples}): the bake's share made in the job. */
export function farBrickOcclusion(b: FarBricks): Uint8Array {
  const n = farBrickCount(b);
  const out = new Uint8Array(n * DISTANCE_BRICK_SAMPLES);
  const g = [0, 0, 0];
  const p = [0, 0, 0];
  for (let k = 0; k < n; k++) for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    p[0] = x;
    p[1] = y;
    p[2] = z;
    out[k * DISTANCE_BRICK_SAMPLES + (z * S + y) * S + x] = Math.round(farBrickOcclusionAt(b.samples, k, p, g) * 255);
  }
  return out;
}

/**
 * A block's baked samples (`DISTANCE_BRICK_SAMPLES` × {@link FAR_BRICK_BAKED_BYTES}, sample order) into `out`: each
 * sample's far colour by its look word from `palette`, and its occlusion (the job's bake; open where it has none).
 */
export function bakeFarBrick(b: FarBricks, block: number, palette: FarPalette, out: Uint8Array): Uint8Array {
  const o = block * DISTANCE_BRICK_SAMPLES;
  const ao = b.occlusion;
  for (let i = 0; i < DISTANCE_BRICK_SAMPLES; i++) {
    const w = b.looks[o + i]! * 4;
    const t = i * FAR_BRICK_BAKED_BYTES;
    out[t] = palette[w]!;
    out[t + 1] = palette[w + 1]!;
    out[t + 2] = palette[w + 2]!;
    out[t + 3] = ao === undefined ? 255 : ao[o + i]!;
  }
  return out;
}

/** A baked block read at a point (cells 0–8 an axis) as the draw's filtered read does: linear colour (0–1) and occlusion. */
export function farBakedAt(baked: Uint8Array, p: readonly number[]): { colour: [number, number, number]; occlusion: number } {
  const q = [0, 1, 2].map((a) => Math.min(C, Math.max(0, p[a]!)));
  const i = q.map((c) => Math.min(C - 1, Math.floor(c)));
  const f = q.map((c, a) => c - i[a]!);
  const sum = [0, 0, 0, 0];
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
    const t = (((i[2]! + dz) * S + i[1]! + dy) * S + i[0]! + dx) * FAR_BRICK_BAKED_BYTES;
    for (let c = 0; c < 4; c++) sum[c]! += (w * baked[t + c]!) / 255;
  }
  return { colour: [sum[0]!, sum[1]!, sum[2]!], occlusion: sum[3]! };
}

/**
 * The fine shading's colour at a point of a block as the draw made it per pixel: the eight samples round it,
 * each its look word's far colour (`colourOf`, linear 0–1), blended by the point's trilinear weights, times the
 * occlusion at the point.
 */
export function farBrickFineShade(b: FarBricks, block: number, p: readonly number[], colourOf: (word: number) => readonly [number, number, number]): [number, number, number] {
  const o = block * DISTANCE_BRICK_SAMPLES;
  const q = [0, 1, 2].map((a) => Math.min(C, Math.max(0, p[a]!)));
  const i = q.map((c) => Math.min(C - 1, Math.floor(c)));
  const f = q.map((c, a) => c - i[a]!);
  const sum = [0, 0, 0];
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const w = (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!);
    const c = colourOf(b.looks[o + ((i[2]! + dz) * S + i[1]! + dy) * S + i[0]! + dx]!);
    for (let k = 0; k < 3; k++) sum[k]! += w * c[k]!;
  }
  const ao = FAR_BRICK_AO_FLOOR + (1 - FAR_BRICK_AO_FLOOR) * farBrickOcclusionAt(b.samples, block, p);
  return [sum[0]! * ao, sum[1]! * ao, sum[2]! * ao];
}
