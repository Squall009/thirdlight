/**
 * Heights brought into a terrain from outside: a 16-bit heightmap (PNG or
 * RAW, the forms landscape tools export) and a block layer whose surface is
 * corner heights (a landscape first built with blocks, moved to the terrain
 * that scales to kilometres).
 *
 * A heightmap's pixel (column, row) is the sample (x, z) from the tile it is
 * placed at: one pixel per sample, rows going +z, so an image seen from above
 * with +x to the right lies as it looks. Its 0 and 65535 stand for the two
 * ends of a height range (absent: the terrain's own, so the steps copy
 * straight across).
 *
 * Pure and deterministic.
 */
import { BlockGrid } from './block-grid';
import type { BlockLayerComponent, BlockLayerData, BlockType } from './block-layers';
import { PAINT_CHANNELS, chunksOfVertex, paintOffset } from './block-paint';
import { columnHeights } from './block-sculpt';
import { decodePngRgba } from './png-decode';
import { TERRAIN_HEIGHT_STEPS, terrainStepOf } from './terrain';
import type { TerrainSamples } from './terrain-edit';
import { setTerrainHole, writeSampleLayers, TERRAIN_PAINT_BYTES, TERRAIN_SAMPLE_LAYERS } from './terrain-tile';

export type HeightmapFormat = 'png16' | 'raw16';
export const HEIGHTMAP_FORMATS: readonly HeightmapFormat[] = ['png16', 'raw16'];
/** The most samples one heightmap import reads (8,193²): a per-request bound on memory, not a terrain size. */
export const HEIGHTMAP_MAX_SAMPLES = 8193 * 8193;

export interface Heightmap {
  width: number;
  height: number;
  /** Row by row, 0–65535. */
  samples: Uint16Array;
}

export interface HeightmapOptions {
  format: HeightmapFormat;
  /** raw16: samples per row and rows (absent: a square from the byte count). */
  width?: number;
  height?: number;
  /** raw16: the byte order (absent: little-endian, what World Machine, Gaea and Unity write). */
  byteOrder?: 'little' | 'big';
  /** A faster inflate for PNG (node:zlib on the backend). */
  inflate?: (data: Uint8Array, maxOut: number) => Uint8Array;
}

/** A heightmap file's samples, or why it cannot be read. */
export function decodeHeightmap(bytes: Uint8Array, o: HeightmapOptions): { ok: true; map: Heightmap } | { ok: false; message: string } {
  if (o.format === 'png16') {
    const r = decodePngRgba(bytes, { maxPixels: HEIGHTMAP_MAX_SAMPLES, channel16: true, ...(o.inflate !== undefined ? { inflate: o.inflate } : {}) });
    if (!r.ok) return r;
    return { ok: true, map: { width: r.png.width, height: r.png.height, samples: r.png.channel16! } };
  }
  if (bytes.length % 2 !== 0) return { ok: false, message: `a 16-bit RAW heightmap has two bytes a sample (${bytes.length} bytes)` };
  const count = bytes.length / 2;
  let w = o.width;
  let h = o.height;
  if (w === undefined && h === undefined) {
    const side = Math.round(Math.sqrt(count));
    if (side * side !== count) return { ok: false, message: `${count} samples is not a square: give width and height` };
    w = side;
    h = side;
  } else if (w === undefined) w = count / h!;
  else if (h === undefined) h = count / w;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w! < 2 || h! < 2 || w! * h! !== count) return { ok: false, message: `${count} samples do not make ${o.width ?? '?'} × ${o.height ?? '?'}` };
  if (count > HEIGHTMAP_MAX_SAMPLES) return { ok: false, message: `the heightmap has more than ${HEIGHTMAP_MAX_SAMPLES} samples` };
  const samples = new Uint16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = o.byteOrder !== 'big';
  for (let i = 0; i < count; i++) samples[i] = view.getUint16(i * 2, little);
  return { ok: true, map: { width: w!, height: h!, samples } };
}

/**
 * Lay a heightmap onto the terrain from tile `at`: the tiles it reaches are
 * made where missing (their samples past the image take its nearest edge, so
 * a new tile has no cliff, or the ground already there where they share an
 * edge with a tile that was: nothing outside the image's footprint changes)
 * and their samples under the image take its heights. `range` is what 0 and 65535 stand for (metres above the terrain's
 * object). Returns the tiles it added and the samples it set.
 */
export function importHeightmap(s: TerrainSamples, map: Heightmap, at: readonly [number, number], range: readonly [number, number]): { added: number; samples: number } {
  const n = s.n;
  const same = range[0] === s.range[0] && range[1] === s.range[1];
  const lut = new Uint16Array(TERRAIN_HEIGHT_STEPS + 1);
  for (let v = 0; v <= TERRAIN_HEIGHT_STEPS; v++) lut[v] = same ? v : terrainStepOf(s.range, range[0] + (v / TERRAIN_HEIGHT_STEPS) * (range[1] - range[0]));
  const tilesX = Math.max(1, Math.ceil((map.width - 1) / n));
  const tilesZ = Math.max(1, Math.ceil((map.height - 1) / n));
  let added = 0;
  let set = 0;
  /** The tiles this import made: a sample past the image they share with any other tile keeps that tile's height. */
  const made = new Set<object>();
  for (let tz = at[1]; tz < at[1] + tilesZ; tz++)
    for (let tx = at[0]; tx < at[0] + tilesX; tx++) {
      const fresh = s.tile(tx, tz) === undefined;
      const t = fresh ? s.addTile(tx, tz) : s.writable(tx, tz)!;
      if (fresh) {
        added += 1;
        made.add(t);
      }
      for (let lz = 0; lz <= n; lz++) {
        const row0 = (tz - at[1]) * n + lz;
        if (row0 >= map.height && !fresh) continue;
        const row = Math.min(row0, map.height - 1);
        for (let lx = 0; lx <= n; lx++) {
          const col0 = (tx - at[0]) * n + lx;
          if (col0 >= map.width && !fresh) continue;
          const col = Math.min(col0, map.width - 1);
          if ((row0 !== row || col0 !== col) && (lx === 0 || lz === 0 || lx === n || lz === n)) {
            // Past the image on an edge a tile from before shares: that ground stays, this tile meets it.
            const kept = s.holders(tx * n + lx, tz * n + lz, false).find((h) => !made.has(h.tile));
            if (kept !== undefined) {
              t.heights[lz * (n + 1) + lx] = kept.tile.heights[kept.i]!;
              continue;
            }
          }
          const step = lut[map.samples[row * map.width + col]!]!;
          // Edge samples are shared with the neighbouring tiles: written in each, so no crack opens.
          if (lx === 0 || lz === 0 || lx === n || lz === n) s.setStep(tx * n + lx, tz * n + lz, step);
          else t.heights[lz * (n + 1) + lx] = step;
          set += 1;
        }
      }
    }
  return { added, samples: set };
}

/** A block layer as the converter reads it. */
export interface BlockLayerSource {
  component: BlockLayerComponent;
  data: BlockLayerData | null;
  types: ReadonlyMap<string, BlockType>;
  /** The layer object's world position (the min corner of cell [0, 0, 0]). */
  origin: readonly number[];
}

/**
 * Turn a block layer's surface into terrain: every sample over the layer
 * takes the height of the layer's top there (the corner heights of the
 * columns around it, bilinear between lattice vertices), cells over empty
 * columns become holes, and painted layers carry their paint as hand paint
 * (block paint layers 0–3 → terrain layers 0–3; wetness is not carried). The
 * tiles the layer reaches are made where missing (their cells off the layer
 * are holes). `origin` is the terrain object's world position. Heights
 * outside the terrain's range are clamped (counted).
 */
export function blockLayerToTerrain(s: TerrainSamples, layer: BlockLayerSource, origin: readonly number[]): { added: number; samples: number; holes: number; clamped: number } {
  const g = BlockGrid.from(layer.component, layer.data);
  const [cw, ch] = g.cellSize;
  const [mx, , mz] = g.min;
  const [Mx, , Mz] = g.max;
  const vx0 = mx;
  const vz0 = mz;
  const vw = Mx - mx + 1;
  const vh = Mz - mz + 1;
  // Each lattice vertex's height (rows): the mean of the corners the columns around it hold there (NaN: no column).
  const sum = new Float64Array(vw * vh);
  const cnt = new Uint8Array(vw * vh);
  const solid = new Uint8Array((Mx - mx) * (Mz - mz));
  for (let z = mz; z < Mz; z++)
    for (let x = mx; x < Mx; x++) {
      const c = columnHeights(g, layer.types, x, z);
      if (c === null) continue;
      solid[(z - mz) * (Mx - mx) + (x - mx)] = 1;
      const corners: [number, number, number][] = [[x, z, c[0]], [x + 1, z, c[1]], [x + 1, z + 1, c[2]], [x, z + 1, c[3]]];
      for (const [vx, vz, v] of corners) {
        const i = (vz - vz0) * vw + (vx - vx0);
        sum[i]! += v;
        cnt[i]! += 1;
      }
    }
  const vertex = (vx: number, vz: number): number => {
    if (vx < vx0 || vz < vz0 || vx >= vx0 + vw || vz >= vz0 + vh) return NaN;
    const i = (vz - vz0) * vw + (vx - vx0);
    return cnt[i] === 0 ? NaN : sum[i]! / cnt[i]!;
  };
  const sp = s.spacing;
  const n = s.n;
  // Layer cell coordinates of a terrain-local point.
  const toLayerX = (lx: number): number => (origin[0]! + lx - layer.origin[0]!) / cw;
  const toLayerZ = (lz: number): number => (origin[2]! + lz - layer.origin[2]!) / cw;
  const heightAt = (u: number, v: number): number => {
    const ix = Math.floor(u);
    const iz = Math.floor(v);
    const fx = u - ix;
    const fz = v - iz;
    let acc = 0;
    let wsum = 0;
    for (const [dx, dz, w] of [[0, 0, (1 - fx) * (1 - fz)], [1, 0, fx * (1 - fz)], [0, 1, (1 - fx) * fz], [1, 1, fx * fz]] as const) {
      const h = vertex(ix + dx, iz + dz);
      if (Number.isNaN(h) || w === 0) continue;
      acc += h * w;
      wsum += w;
    }
    return wsum === 0 ? NaN : acc / wsum;
  };
  // The tiles the layer's footprint reaches.
  const wx0 = layer.origin[0]! + mx * cw - origin[0]!;
  const wx1 = layer.origin[0]! + Mx * cw - origin[0]!;
  const wz0 = layer.origin[2]! + mz * cw - origin[2]!;
  const wz1 = layer.origin[2]! + Mz * cw - origin[2]!;
  const size = n * sp;
  const tx0 = Math.floor(wx0 / size);
  const tx1 = Math.ceil(wx1 / size) - 1;
  const tz0 = Math.floor(wz0 / size);
  const tz1 = Math.ceil(wz1 / size) - 1;
  const paintOf = (u: number, v: number): Uint8Array | null => {
    const vx = Math.round(u);
    const vz = Math.round(v);
    for (const [cx, cz] of chunksOfVertex(vx, vz)) {
      const p = g.chunkPaint(cx, cz);
      const o = p !== null ? paintOffset(cx, cz, vx, vz) : null;
      if (p !== null && o !== null) return p.subarray(o, o + PAINT_CHANNELS);
    }
    return null;
  };
  let added = 0;
  let samples = 0;
  let holes = 0;
  let clamped = 0;
  for (let tz = tz0; tz <= tz1; tz++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const fresh = s.tile(tx, tz) === undefined;
      const t = fresh ? s.addTile(tx, tz) : s.writable(tx, tz)!;
      if (fresh) added += 1;
      for (let lz = 0; lz <= n; lz++)
        for (let lx = 0; lx <= n; lx++) {
          const gx = tx * n + lx;
          const gz = tz * n + lz;
          const u = toLayerX(gx * sp);
          const v = toLayerZ(gz * sp);
          const rows = heightAt(u, v);
          if (Number.isNaN(rows)) continue;
          const h = layer.origin[1]! + rows * ch - origin[1]!;
          if (h < s.range[0]! || h > s.range[1]!) clamped += 1;
          s.setStep(gx, gz, s.stepOf(h));
          samples += 1;
          const p = paintOf(u, v);
          if (p !== null) {
            const bytes = new Uint8Array(TERRAIN_PAINT_BYTES);
            writeSampleLayers(bytes, 0, [0, 1, 2, 3], Array.from(p.subarray(0, TERRAIN_SAMPLE_LAYERS)));
            bytes[2 * TERRAIN_SAMPLE_LAYERS] = 255;
            for (const held of s.holders(gx, gz, true)) {
              held.tile.paint ??= new Uint8Array(TERRAIN_PAINT_BYTES * held.tile.heights.length);
              held.tile.paint.set(bytes, held.i * TERRAIN_PAINT_BYTES);
            }
          }
        }
      // Cells over no column (or off the layer) are holes.
      for (let lz = 0; lz < n; lz++)
        for (let lx = 0; lx < n; lx++) {
          const u = Math.floor(toLayerX((tx * n + lx + 0.5) * sp));
          const v = Math.floor(toLayerZ((tz * n + lz + 0.5) * sp));
          const inside = u >= mx && u < Mx && v >= mz && v < Mz && solid[(v - mz) * (Mx - mx) + (u - mx)] === 1;
          if (!inside && (fresh || (u >= mx && u < Mx && v >= mz && v < Mz))) {
            if (setTerrainHole(t, lx, lz, true)) holes += 1;
          } else if (inside) setTerrainHole(t, lx, lz, false);
        }
    }
  return { added, samples, holes, clamped };
}
