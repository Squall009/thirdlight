/**
 * A terrain tile as the texels its two texture-array layers hold (RGBA8, one
 * texel per sample; formats both renderers sample everywhere):
 *
 * - heights and normals: the 16-bit height step as two bytes (high in R, low
 *   in G; the vertex shader puts them back together and filters by hand, so
 *   no precision is lost to an 8-bit or half-float format), and the normal's
 *   x and z (B, A; y follows). Normals come from the heights by central
 *   differences, across a tile's edge from its neighbour's samples, so both
 *   tiles hold the same normal on their shared edge and the light shows no
 *   seam there.
 * - layers: the weights of material layers 0–2 (R, G, B; layer 3 has the
 *   rest), the baked weights and the hand paint mixed by the paint's amount
 *   as the surface queries mix them; and in A whether the cell whose corner
 *   the sample is (its +x, +z cell) is a hole. The layered material has
 *   four layers: a tile's layers past the fourth are left out and the four
 *   shown take their share.
 *
 * Pure.
 */
import { TERRAIN_HEIGHT_STEPS, TERRAIN_PAINT_BYTES, TERRAIN_SAMPLE_LAYERS, TERRAIN_WEIGHT_BYTES, type TerrainTile } from '@thirdlight/runtime';

/** The material layers the renderer draws (the layered material's four). */
export const TERRAIN_DRAWN_LAYERS = 4;

/** Bytes per texel of either layer. */
export const TERRAIN_TEXEL_BYTES = 4;

/** A tile's neighbour by tile offset ((−1, 0), (1, 0), (0, −1), (0, 1)); undefined where none is loaded. */
export type TileNeighbour = (dx: number, dz: number) => TerrainTile | undefined;

/**
 * Write a tile's heights and normals into `out` (samples² texels).
 * `metresPerStep` is the height of one stored step; `spacing` the metres
 * between samples. A side with no neighbour takes a one-sided difference.
 */
export function packHeightNormal(out: Uint8Array, tile: TerrainTile, neighbour: TileNeighbour, metresPerStep: number, spacing: number): void {
  const s = tile.samples;
  const n = s - 1;
  const h = tile.heights;
  const left = neighbour(-1, 0)?.heights;
  const right = neighbour(1, 0)?.heights;
  const below = neighbour(0, -1)?.heights;
  const above = neighbour(0, 1)?.heights;
  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
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
  }
}

/** Write a tile's drawn layer weights and hole flags into `out` (samples² texels). */
export function packLayers(out: Uint8Array, tile: TerrainTile): void {
  const s = tile.samples;
  const n = s - 1;
  const count = s * s;
  const { weights, paint, holes } = tile;
  const K = TERRAIN_SAMPLE_LAYERS;
  for (let i = 0, o = 0; i < count; i++, o += TERRAIN_TEXEL_BYTES) {
    let w0 = 0;
    let w1 = 0;
    let w2 = 0;
    let w3 = 0;
    if (weights === null) w0 = 255;
    else {
      const b = i * TERRAIN_WEIGHT_BYTES;
      for (let k = 0; k < K; k++) {
        const w = weights[b + K + k]!;
        if (w === 0) continue;
        const l = weights[b + k]!;
        if (l === 0) w0 += w;
        else if (l === 1) w1 += w;
        else if (l === 2) w2 += w;
        else if (l === 3) w3 += w;
      }
    }
    if (paint !== null) {
      const b = i * TERRAIN_PAINT_BYTES;
      const a = paint[b + 2 * K]!;
      if (a > 0) {
        const keep = (255 - a) / 255;
        const take = a / 255;
        w0 *= keep;
        w1 *= keep;
        w2 *= keep;
        w3 *= keep;
        for (let k = 0; k < K; k++) {
          const w = paint[b + K + k]! * take;
          if (w === 0) continue;
          const l = paint[b + k]!;
          if (l === 0) w0 += w;
          else if (l === 1) w1 += w;
          else if (l === 2) w2 += w;
          else if (l === 3) w3 += w;
        }
      }
    }
    const sum = w0 + w1 + w2 + w3;
    if (sum <= 0) {
      // Only layers past the drawn ones here: the first drawn layer shows.
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 0;
    } else {
      const f = 255 / sum;
      out[o] = (w0 * f + 0.5) | 0;
      out[o + 1] = (w1 * f + 0.5) | 0;
      out[o + 2] = (w2 * f + 0.5) | 0;
    }
    out[o + 3] = 0;
  }
  // Holes: the cell whose min corner the sample is (the last row and column own none).
  if (holes !== null) {
    for (let cz = 0, c = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++, c++) if ((holes[c >> 3]! & (1 << (c & 7))) !== 0) out[(cz * s + cx) * TERRAIN_TEXEL_BYTES + 3] = 255;
    }
  }
}

/** Metres of one stored height step for a height range. */
export function metresPerStep(range: readonly number[]): number {
  return (range[1]! - range[0]!) / TERRAIN_HEIGHT_STEPS;
}
