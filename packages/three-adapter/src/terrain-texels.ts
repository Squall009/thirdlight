/**
 * A terrain tile as the texels its three texture-array layers hold (RGBA8,
 * one texel per sample; formats both renderers sample everywhere):
 *
 * - heights and normals: the 16-bit height step as two bytes (high in R, low
 *   in G; the vertex shader puts them back together and filters by hand, so
 *   no precision is lost to an 8-bit or half-float format), and the normal's
 *   x and z (B, A; y follows). Normals come from the heights by central
 *   differences, across a tile's edge from its neighbour's samples, so both
 *   tiles hold the same normal on their shared edge and the light shows no
 *   seam there. A tile is packed whole without its neighbours (off the main
 *   thread) and its border samples again once they are known
 *   (`packHeightNormalBorder`, a few thousand samples).
 * - layer weights: four channels, a material layer in channel `layer % 4`
 *   (R, G, B; A's weight is the rest), the baked weights and the hand paint
 *   mixed by the paint's amount as the surface queries mix them; and in A
 *   whether the cell whose corner the sample is (its +x, +z cell) is a hole.
 * - layer indices: per channel, the material layer it holds there (the
 *   material samples its texture arrays at these). A channel no layer uses
 *   at a sample takes a neighbouring sample's layer, so the weight filtered
 *   in from that neighbour shows its layer, not another.
 *
 * Any number of layers draws (a byte names one: 256): what is lost is two
 * layers in the same channel at the same sample (the stronger shows and
 * takes the other's share) or next to each other (they meet at a hard edge
 * half way between the samples) — layers numbered apart by four seldom meet.
 *
 * Pure.
 */
import { TERRAIN_HEIGHT_STEPS, TERRAIN_PAINT_BYTES, TERRAIN_SAMPLE_LAYERS, TERRAIN_WEIGHT_BYTES, type TerrainTile } from '@thirdlight/runtime';

/** Weight channels a texel carries (a layer goes in channel `layer % 4`). */
export const TERRAIN_LAYER_CHANNELS = 4;

/** Bytes per texel of every layer texture. */
export const TERRAIN_TEXEL_BYTES = 4;

/** A tile's neighbour by tile offset ((−1, 0), (1, 0), (0, −1), (0, 1)); undefined where none is loaded. */
export type TileNeighbour = (dx: number, dz: number) => TerrainTile | undefined;

const NONE: TileNeighbour = () => undefined;

/** Write sample (x, z)'s height and normal texel. */
function writeHeightNormal(out: Uint8Array, tile: TerrainTile, x: number, z: number, left: Uint16Array | undefined, right: Uint16Array | undefined, below: Uint16Array | undefined, above: Uint16Array | undefined, metresPerStep: number, spacing: number): void {
  const s = tile.samples;
  const n = s - 1;
  const h = tile.heights;
  const i = z * s + x;
  const v = h[i]!;
  // x − 1 and x + 1 (across the edge: the neighbour's sample one in from its shared edge).
  let x0: number;
  let x1: number;
  let dx = 2;
  if (x > 0) x0 = h[i - 1]!;
  else if (left !== undefined) x0 = left[z * s + n - 1]!;
  else {
    x0 = v;
    dx = 1;
  }
  if (x < n) x1 = h[i + 1]!;
  else if (right !== undefined) x1 = right[z * s + 1]!;
  else {
    x1 = v;
    dx -= 1;
  }
  let z0: number;
  let z1: number;
  let dz = 2;
  if (z > 0) z0 = h[i - s]!;
  else if (below !== undefined) z0 = below[(n - 1) * s + x]!;
  else {
    z0 = v;
    dz = 1;
  }
  if (z < n) z1 = h[i + s]!;
  else if (above !== undefined) z1 = above[s + x]!;
  else {
    z1 = v;
    dz -= 1;
  }
  const gx = dx > 0 ? ((x1 - x0) * metresPerStep) / (dx * spacing) : 0;
  const gz = dz > 0 ? ((z1 - z0) * metresPerStep) / (dz * spacing) : 0;
  const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
  const o = i * TERRAIN_TEXEL_BYTES;
  out[o] = v >> 8;
  out[o + 1] = v & 0xff;
  out[o + 2] = Math.round((-gx * inv * 0.5 + 0.5) * 255);
  out[o + 3] = Math.round((-gz * inv * 0.5 + 0.5) * 255);
}

/**
 * Write a tile's heights and normals into `out` (samples² texels).
 * `metresPerStep` is the height of one stored step; `spacing` the metres
 * between samples. A side with no neighbour takes a one-sided difference.
 */
export function packHeightNormal(out: Uint8Array, tile: TerrainTile, neighbour: TileNeighbour, metresPerStep: number, spacing: number): void {
  const s = tile.samples;
  const [l, r, b, a] = [neighbour(-1, 0)?.heights, neighbour(1, 0)?.heights, neighbour(0, -1)?.heights, neighbour(0, 1)?.heights];
  for (let z = 0; z < s; z++) for (let x = 0; x < s; x++) writeHeightNormal(out, tile, x, z, l, r, b, a, metresPerStep, spacing);
}

/** Write only a tile's border samples (its edges' normals read the neighbours known now). */
export function packHeightNormalBorder(out: Uint8Array, tile: TerrainTile, neighbour: TileNeighbour, metresPerStep: number, spacing: number): void {
  const s = tile.samples;
  const n = s - 1;
  const [l, r, b, a] = [neighbour(-1, 0)?.heights, neighbour(1, 0)?.heights, neighbour(0, -1)?.heights, neighbour(0, 1)?.heights];
  for (let k = 0; k < s; k++) {
    writeHeightNormal(out, tile, k, 0, l, r, b, a, metresPerStep, spacing);
    writeHeightNormal(out, tile, k, n, l, r, b, a, metresPerStep, spacing);
    writeHeightNormal(out, tile, 0, k, l, r, b, a, metresPerStep, spacing);
    writeHeightNormal(out, tile, n, k, l, r, b, a, metresPerStep, spacing);
  }
}

/** A tile's heights and normals packed alone (no neighbours: their border is written again once they come). */
export function packHeightNormalAlone(out: Uint8Array, tile: TerrainTile, metresPerStep: number, spacing: number): void {
  packHeightNormal(out, tile, NONE, metresPerStep, spacing);
}

/** No layer in a channel at a sample (an index byte names one of 256 layers: this marks none while packing). */
const EMPTY = -1;

/**
 * Write a tile's layer weights and hole flags into `weightsOut` and its
 * layer indices into `indicesOut` (samples² texels each).
 */
export function packLayers(weightsOut: Uint8Array, indicesOut: Uint8Array, tile: TerrainTile): void {
  const s = tile.samples;
  const n = s - 1;
  const count = s * s;
  const { weights, paint, holes } = tile;
  const K = TERRAIN_SAMPLE_LAYERS;
  const C = TERRAIN_LAYER_CHANNELS;
  // Per sample and channel: the strongest layer's index (EMPTY: none) and its weight.
  const idx = new Int16Array(count * C).fill(EMPTY);
  const w = [0, 0, 0, 0];
  const take = (i: number, layer: number, weight: number): void => {
    const c = layer % C;
    const o = i * C + c;
    if (idx[o] === layer) w[c]! += weight;
    else if (weight > w[c]!) {
      // The stronger layer keeps the channel and takes the weaker one's share.
      w[c] = weight + w[c]!;
      idx[o] = layer;
    } else w[c]! += weight;
  };
  for (let i = 0, o = 0; i < count; i++, o += TERRAIN_TEXEL_BYTES) {
    w[0] = w[1] = w[2] = w[3] = 0;
    let keep = 1;
    let paintTake = 0;
    if (paint !== null) {
      const a = paint[i * TERRAIN_PAINT_BYTES + 2 * K]!;
      keep = (255 - a) / 255;
      paintTake = a / 255;
    }
    if (weights === null) {
      if (keep > 0) take(i, 0, 255 * keep);
    } else if (keep > 0) {
      const b = i * TERRAIN_WEIGHT_BYTES;
      for (let k = 0; k < K; k++) {
        const v = weights[b + K + k]!;
        if (v !== 0) take(i, weights[b + k]!, v * keep);
      }
    }
    if (paintTake > 0) {
      const b = i * TERRAIN_PAINT_BYTES;
      for (let k = 0; k < K; k++) {
        const v = paint![b + K + k]!;
        if (v !== 0) take(i, paint![b + k]!, v * paintTake);
      }
    }
    const sum = w[0]! + w[1]! + w[2]! + w[3]!;
    if (sum <= 0) {
      // Nothing weighs here: layer 0 shows.
      weightsOut[o] = 255;
      weightsOut[o + 1] = 0;
      weightsOut[o + 2] = 0;
      idx[i * C] = 0;
    } else {
      const f = 255 / sum;
      weightsOut[o] = (w[0]! * f + 0.5) | 0;
      weightsOut[o + 1] = (w[1]! * f + 0.5) | 0;
      weightsOut[o + 2] = (w[2]! * f + 0.5) | 0;
    }
    weightsOut[o + 3] = 0;
  }
  // Indices: an empty channel takes its layer from a neighbouring sample (the weight filtered in from it shows that layer), else the channel's own number.
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const i = z * s + x;
      for (let c = 0; c < C; c++) {
        let l = idx[i * C + c]!;
        if (l === EMPTY) {
          if (x > 0 && idx[(i - 1) * C + c]! !== EMPTY) l = idx[(i - 1) * C + c]!;
          else if (x < n && idx[(i + 1) * C + c]! !== EMPTY) l = idx[(i + 1) * C + c]!;
          else if (z > 0 && idx[(i - s) * C + c]! !== EMPTY) l = idx[(i - s) * C + c]!;
          else if (z < n && idx[(i + s) * C + c]! !== EMPTY) l = idx[(i + s) * C + c]!;
          else l = c;
        }
        indicesOut[i * TERRAIN_TEXEL_BYTES + c] = l;
      }
    }
  }
  // Holes: the cell whose min corner the sample is (the last row and column own none).
  if (holes !== null) {
    for (let cz = 0, c = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++, c++) if ((holes[c >> 3]! & (1 << (c & 7))) !== 0) weightsOut[(cz * s + cx) * TERRAIN_TEXEL_BYTES + 3] = 255;
    }
  }
}

/** A flat, unpainted, whole tile's texels at step `step` (filled, not computed per sample: a flat tile may be a million samples). */
export function packFlat(heightsOut: Uint8Array, weightsOut: Uint8Array, indicesOut: Uint8Array, step: number): void {
  // Little-endian words: bytes R, G, B, A from the low byte up.
  const word = (r: number, g: number, b: number, a: number): number => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
  new Uint32Array(heightsOut.buffer, heightsOut.byteOffset, heightsOut.byteLength >> 2).fill(word(step >> 8, step & 0xff, 128, 128));
  new Uint32Array(weightsOut.buffer, weightsOut.byteOffset, weightsOut.byteLength >> 2).fill(word(255, 0, 0, 0));
  new Uint32Array(indicesOut.buffer, indicesOut.byteOffset, indicesOut.byteLength >> 2).fill(word(0, 1, 2, 3));
}

/** Metres of one stored height step for a height range. */
export function metresPerStep(range: readonly number[]): number {
  return (range[1]! - range[0]!) / TERRAIN_HEIGHT_STEPS;
}
