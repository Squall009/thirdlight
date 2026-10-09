/**
 * One terrain tile's data and its binary blob.
 *
 * In memory a tile is typed arrays over its `samples × samples` grid, row by
 * row (z), sample by sample (x):
 * - `heights`: 16-bit steps of the terrain's height range;
 * - `weights`: the material layers the rules baked, per sample the four
 *   strongest layers' indices then their weights (summing to 255), so the
 *   number of layers is not tied to texture channels (absent: all layer 0);
 * - `holes`: one bit per cell between samples (absent: none);
 * - `paint`: hand paint over the baked layers, kept apart so rules can be
 *   baked again without losing it — the same four indices and weights plus an
 *   amount (0: the baked weights, 255: all hand paint) (absent: none).
 *
 * The blob (`TLTR`, the shared header of `binary-container.ts`) carries the
 * tile's size and which maps it has in the header's two own bytes, so a tile
 * can be checked without inflating it. The payload stores each map as planes
 * (all first indices, then all second, …) and the heights as differences
 * from a plane through the samples before them, which is what makes a smooth
 * landscape compress to a small fraction of its size. A map that holds only its default is not
 * written, and every map is kept in one canonical form, so equal tiles are
 * equal bytes and share one digest.
 *
 * Pure: no compression here (node:zlib on the backend, the page's
 * DecompressionStream in a game).
 */
import { BINARY_HEADER_BYTES, hasBinaryMagic, readBinaryBlob, wrapBinaryBlob, type BinaryCompression } from './binary-container';
import { TERRAIN_TILE_SAMPLES } from './terrain';
import { TERRAIN_LAYER_MAX } from './terrain-sizes';

/** The first bytes of a tile blob ("TLTR"). */
export const TERRAIN_TILE_MAGIC = Object.freeze([0x54, 0x4c, 0x54, 0x52]);
/** The payload layout this engine writes and reads. */
export const TERRAIN_TILE_LAYOUT = 1;
/** Bytes per sample of the baked weights: four layer indices, four weights. */
export const TERRAIN_WEIGHT_BYTES = 8;
/** Bytes per sample of the hand paint: four layer indices, four weights, the amount. */
export const TERRAIN_PAINT_BYTES = 9;
/** The layers one sample blends (the strongest four). */
export const TERRAIN_SAMPLE_LAYERS = 4;
export { TERRAIN_LAYER_MAX };

const FLAG_WEIGHTS = 1;
const FLAG_HOLES = 2;
const FLAG_PAINT = 4;
const PAYLOAD_HEAD = 4;

export interface TerrainTile {
  readonly samples: number;
  heights: Uint16Array;
  weights: Uint8Array | null;
  holes: Uint8Array | null;
  paint: Uint8Array | null;
}

/** A flat, unpainted, whole tile at `step`. */
export function flatTerrainTile(samples: number, step: number): TerrainTile {
  return { samples, heights: new Uint16Array(samples * samples).fill(step), weights: null, holes: null, paint: null };
}

/** A copy that shares nothing with `t`. */
export function cloneTerrainTile(t: TerrainTile): TerrainTile {
  return { samples: t.samples, heights: t.heights.slice(), weights: t.weights?.slice() ?? null, holes: t.holes?.slice() ?? null, paint: t.paint?.slice() ?? null };
}

/** Bytes of the hole bitmask of a tile. */
export const terrainHoleBytes = (samples: number): number => Math.ceil(((samples - 1) * (samples - 1)) / 8);

/** A tile payload's length from its size and the maps it carries (its flags): the encoder writes it, the decoder and the blob's header are held to it. */
function tilePayloadBytes(s: number, flags: number): number {
  const n = s * s;
  return PAYLOAD_HEAD + n * 2 + (flags & FLAG_WEIGHTS ? n * TERRAIN_WEIGHT_BYTES : 0) + (flags & FLAG_HOLES ? terrainHoleBytes(s) : 0) + (flags & FLAG_PAINT ? n * TERRAIN_PAINT_BYTES : 0);
}

/** What a decoded tile holds in memory (bytes). */
export function terrainTileBytes(t: Pick<TerrainTile, 'samples' | 'weights' | 'holes' | 'paint'>): number {
  const n = t.samples * t.samples;
  return n * 2 + (t.weights !== null ? n * TERRAIN_WEIGHT_BYTES : 0) + (t.holes !== null ? terrainHoleBytes(t.samples) : 0) + (t.paint !== null ? n * TERRAIN_PAINT_BYTES : 0);
}

/** Whether a cell (column cx, row cz of the tile's cells) is a hole. */
export function terrainHoleAt(t: TerrainTile, cx: number, cz: number): boolean {
  if (t.holes === null) return false;
  const i = cz * (t.samples - 1) + cx;
  return (t.holes[i >> 3]! & (1 << (i & 7))) !== 0;
}

/** Set or clear a cell's hole bit (the mask is made on the first hole). Returns whether it changed. */
export function setTerrainHole(t: TerrainTile, cx: number, cz: number, hole: boolean): boolean {
  if (terrainHoleAt(t, cx, cz) === hole) return false;
  t.holes ??= new Uint8Array(terrainHoleBytes(t.samples));
  const i = cz * (t.samples - 1) + cx;
  t.holes[i >> 3] = hole ? t.holes[i >> 3]! | (1 << (i & 7)) : t.holes[i >> 3]! & ~(1 << (i & 7));
  return true;
}

/**
 * A sample's layers in canonical form: the non-zero weights strongest first
 * (equal ones by lower layer), at most four (what a fifth held goes to the
 * strongest), the rest index 0 weight 0. Written at `out[o …]` (indices, then
 * weights). The weights must sum to 255.
 */
export function writeSampleLayers(out: Uint8Array, o: number, layers: readonly number[], weights: readonly number[]): void {
  const order = layers.map((l, i) => i).filter((i) => weights[i]! > 0);
  order.sort((a, b) => weights[b]! - weights[a]! || layers[a]! - layers[b]!);
  let extra = 0;
  for (let k = TERRAIN_SAMPLE_LAYERS; k < order.length; k++) extra += weights[order[k]!]!;
  for (let k = 0; k < TERRAIN_SAMPLE_LAYERS; k++) {
    const i = order[k];
    out[o + k] = i !== undefined ? layers[i]! : 0;
    out[o + TERRAIN_SAMPLE_LAYERS + k] = i !== undefined ? weights[i]! + (k === 0 ? extra : 0) : 0;
  }
}

/** The baked layers of a sample: indices and weights (all layer 0 when the tile has no weights). */
export function terrainBakedLayers(t: TerrainTile, i: number): { layers: number[]; weights: number[] } {
  if (t.weights === null) return { layers: [0], weights: [255] };
  const o = i * TERRAIN_WEIGHT_BYTES;
  const layers: number[] = [];
  const weights: number[] = [];
  for (let k = 0; k < TERRAIN_SAMPLE_LAYERS; k++) {
    const w = t.weights[o + TERRAIN_SAMPLE_LAYERS + k]!;
    if (w === 0) continue;
    layers.push(t.weights[o + k]!);
    weights.push(w);
  }
  return { layers, weights };
}

/**
 * The layers a sample shows: the baked weights and the hand paint mixed by
 * the paint's amount, the strongest four, summing to 255. What the renderer
 * and surface queries read.
 */
export function terrainLayersAt(t: TerrainTile, i: number): { layers: number[]; weights: number[] } {
  const baked = terrainBakedLayers(t, i);
  const a = t.paint !== null ? t.paint[i * TERRAIN_PAINT_BYTES + 2 * TERRAIN_SAMPLE_LAYERS]! : 0;
  if (a === 0) return baked;
  const mix = new Map<number, number>();
  baked.layers.forEach((l, k) => mix.set(l, (mix.get(l) ?? 0) + (baked.weights[k]! * (255 - a)) / 255));
  const o = i * TERRAIN_PAINT_BYTES;
  for (let k = 0; k < TERRAIN_SAMPLE_LAYERS; k++) {
    const w = t.paint![o + TERRAIN_SAMPLE_LAYERS + k]!;
    if (w > 0) mix.set(t.paint![o + k]!, (mix.get(t.paint![o + k]!) ?? 0) + (w * a) / 255);
  }
  const entries = [...mix.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, TERRAIN_SAMPLE_LAYERS);
  const total = entries.reduce((s, e) => s + e[1], 0);
  const weights = entries.map((e) => Math.round((e[1] * 255) / total));
  // Rounding's remainder goes to the strongest, so the four still sum to 255.
  weights[0]! += 255 - weights.reduce((s, w) => s + w, 0);
  const keep = weights.map((w, k) => k).filter((k) => weights[k]! > 0);
  return { layers: keep.map((k) => entries[k]![0]), weights: keep.map((k) => weights[k]!) };
}

const isDefaultWeights = (w: Uint8Array): boolean => {
  for (let o = 0; o < w.length; o += TERRAIN_WEIGHT_BYTES) {
    if (w[o + TERRAIN_SAMPLE_LAYERS] !== 255 || w[o] !== 0) return false;
  }
  return true;
};
const isUnpainted = (p: Uint8Array): boolean => {
  for (let o = 2 * TERRAIN_SAMPLE_LAYERS; o < p.length; o += TERRAIN_PAINT_BYTES) if (p[o] !== 0) return false;
  return true;
};
const isWhole = (h: Uint8Array): boolean => h.every((b) => b === 0);

/** What a height is predicted as from the samples written before it (the stored value is the difference). */
function predictHeight(h: Uint16Array, s: number, i: number): number {
  const x = i % s;
  if (i < s) return x > 0 ? h[i - 1]! : 0;
  if (x === 0) return h[i - s]!;
  return h[i - 1]! + h[i - s]! - h[i - s - 1]!;
}

/** The tile's payload (uncompressed; `wrapTerrainTile` adds the header). */
export function encodeTerrainTile(t: TerrainTile): { payload: Uint8Array; flags: number } {
  const s = t.samples;
  const n = s * s;
  const weights = t.weights !== null && !isDefaultWeights(t.weights) ? t.weights : null;
  const holes = t.holes !== null && !isWhole(t.holes) ? t.holes : null;
  const paint = t.paint !== null && !isUnpainted(t.paint) ? t.paint : null;
  const flags = (weights !== null ? FLAG_WEIGHTS : 0) | (holes !== null ? FLAG_HOLES : 0) | (paint !== null ? FLAG_PAINT : 0);
  const size = tilePayloadBytes(s, flags);
  const out = new Uint8Array(size);
  out[0] = TERRAIN_TILE_LAYOUT;
  out[1] = Math.log2(s - 1);
  out[2] = flags;
  let o = PAYLOAD_HEAD;
  // Each height as its difference from a plane through its neighbours (left + above − above-left; edges: the one
  // neighbour), low bytes then high bytes: smooth ground leaves small differences, mostly one byte of zeros.
  const h = t.heights;
  const hi = o + n;
  for (let i = 0; i < n; i++) {
    const d = (h[i]! - predictHeight(h, s, i)) & 0xffff;
    out[o + i] = d & 0xff;
    out[hi + i] = d >> 8;
  }
  o += 2 * n;
  const planes = (src: Uint8Array, stride: number): void => {
    for (let k = 0; k < stride; k++) for (let i = 0; i < n; i++) out[o++] = src[i * stride + k]!;
  };
  if (weights !== null) planes(weights, TERRAIN_WEIGHT_BYTES);
  if (holes !== null) {
    out.set(holes, o);
    o += holes.length;
  }
  if (paint !== null) planes(paint, TERRAIN_PAINT_BYTES);
  return { payload: out, flags };
}

/** A tile back from its payload (throws a short message when malformed). */
export function decodeTerrainTile(payload: Uint8Array): TerrainTile {
  if (payload.length < PAYLOAD_HEAD) throw new Error('terrain tile binary: the data ends early');
  if (payload[0] !== TERRAIN_TILE_LAYOUT) throw new Error(`terrain tile binary: layout ${payload[0]} is not one this engine reads (${TERRAIN_TILE_LAYOUT})`);
  const s = 2 ** payload[1]! + 1;
  if (!TERRAIN_TILE_SAMPLES.includes(s)) throw new Error(`terrain tile binary: ${s} samples is not a tile size`);
  const flags = payload[2]!;
  if ((flags & ~(FLAG_WEIGHTS | FLAG_HOLES | FLAG_PAINT)) !== 0) throw new Error(`terrain tile binary: unknown maps ${flags}`);
  const n = s * s;
  const size = tilePayloadBytes(s, flags);
  if (payload.length !== size) throw new Error(`terrain tile binary: ${payload.length} bytes, the maps it names take ${size}`);
  let o = PAYLOAD_HEAD;
  const heights = new Uint16Array(n);
  for (let i = 0; i < n; i++) heights[i] = (predictHeight(heights, s, i) + (payload[o + i]! | (payload[o + n + i]! << 8))) & 0xffff;
  o += 2 * n;
  const planes = (stride: number): Uint8Array => {
    const out = new Uint8Array(n * stride);
    for (let k = 0; k < stride; k++) for (let i = 0; i < n; i++) out[i * stride + k] = payload[o++]!;
    return out;
  };
  const weights = flags & FLAG_WEIGHTS ? planes(TERRAIN_WEIGHT_BYTES) : null;
  let holes: Uint8Array | null = null;
  if (flags & FLAG_HOLES) {
    holes = payload.slice(o, o + terrainHoleBytes(s));
    o += holes.length;
  }
  const paint = flags & FLAG_PAINT ? planes(TERRAIN_PAINT_BYTES) : null;
  return { samples: s, heights, weights, holes, paint };
}

/** A tile blob: the header (with the tile's size and maps) and the (compressed) payload. */
export function wrapTerrainTile(compression: BinaryCompression, encoded: { payload: Uint8Array; flags: number }, stored: Uint8Array): Uint8Array {
  return wrapBinaryBlob(TERRAIN_TILE_MAGIC, compression, encoded.payload.length, stored, [encoded.payload[1]!, encoded.flags]);
}

/** A tile blob's header: compression, payload length, the tile's size and maps, and the stored payload (throws when it is not one). */
export function readTerrainTileBlob(blob: Uint8Array): { compression: BinaryCompression; rawLength: number; samples: number; flags: number; stored: Uint8Array } {
  const r = readBinaryBlob(blob, TERRAIN_TILE_MAGIC, 'terrain tile');
  const samples = 2 ** r.extra[0] + 1;
  if (!TERRAIN_TILE_SAMPLES.includes(samples)) throw new Error(`terrain tile binary: ${samples} samples is not a tile size`);
  // The stated length is what a reader allocates before inflating: held to the size the header's tile size and maps take.
  if ((r.extra[1] & ~(FLAG_WEIGHTS | FLAG_HOLES | FLAG_PAINT)) !== 0) throw new Error(`terrain tile binary: unknown maps ${r.extra[1]}`);
  const size = tilePayloadBytes(samples, r.extra[1]);
  if (r.rawLength !== size) throw new Error(`terrain tile binary: its header states ${r.rawLength} bytes, a tile of ${samples} samples with its maps takes ${size}`);
  return { compression: r.compression, rawLength: r.rawLength, samples, flags: r.extra[1], stored: r.stored };
}

/** Whether bytes are a terrain tile blob. */
export function isTerrainTileBlob(blob: Uint8Array): boolean {
  return hasBinaryMagic(blob, TERRAIN_TILE_MAGIC);
}

/** What a tile blob decodes to in memory, from its header alone. */
export function terrainTileBlobBytes(blob: Uint8Array): number {
  const h = readTerrainTileBlob(blob);
  return terrainTileBytes({ samples: h.samples, weights: h.flags & FLAG_WEIGHTS ? new Uint8Array(0) : null, holes: h.flags & FLAG_HOLES ? new Uint8Array(0) : null, paint: h.flags & FLAG_PAINT ? new Uint8Array(0) : null });
}

/** The header's size (a blob is at least this long). */
export const TERRAIN_TILE_HEADER_BYTES = BINARY_HEADER_BYTES;
