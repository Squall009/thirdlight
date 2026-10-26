/**
 * Where a unit's texels are in the world: the point and normal each texel's
 * light is computed at (the inverse of the cache's addressing). A unit's
 * texels are counted as the scheduler hands them out (`RelightSlice`): a
 * tile's charts in order, each its rectangle on the atlas row by row (an
 * area chart's border texels sit at its nearest interior texel), a ring
 * patch's texels row by row along +z.
 *
 * A texel with no place on a surface (a surfel rectangle's spare texels, a
 * UV1 model's chart, a terrain hole) gets a zero normal: the lighting pass
 * leaves it.
 *
 * Pure (no three.js).
 */
import type { TerrainField } from '@thirdlight/runtime';

import { SURFACE_CHART_BORDER, SURFACE_CHART_METRES, areaTexels, surfelLevelFor, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { FACE_PLANE_AXES } from './surface-cache-blocks';
import type { ArchTile, BlockTile, ModelTile } from './surface-cache-scene';
import type { RingPatch } from './surface-cache-terrain';
import { invertAffine } from './tracer-words';

/** Floats per texel point: position xyz, normal xyz. */
export const TEXEL_POINT_FLOATS = 6;

/** Texels per side of a chart's unit: a chart is lit and marked in squares of this many texels (6.4 m at 10 cm). */
export const CHART_UNIT_TEXELS = 64;

/** A part of an area chart's rectangle on the atlas (texels, from its place's corner, its border included). */
export interface ChartRect {
  readonly chart: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A resident tile with its packing at its level; `rect`: only that part of one chart (a chart's unit), its texels row by row. */
export interface TileTexels {
  readonly tile: BlockTile | ArchTile | ModelTile;
  readonly level: number;
  readonly packing: TilePacking;
  readonly charts: readonly SurfaceChart[];
  readonly rect?: ChartRect;
}

/** A terrain ring patch with its terrain. */
export interface PatchTexels {
  readonly patch: RingPatch;
  readonly texel: number;
  readonly field: TerrainField;
}

/** A point of chart `c` of a tile at (u, v) metres: position and normal. */
type ChartPoint = (c: number, u: number, v: number, out: Float32Array, at: number) => void;

function blockPoint(t: BlockTile): ChartPoint {
  const made = t.made!;
  const s = t.grid.cellSize;
  return (c, u, v, out, at) => {
    const face = made.frames[c * 4]!;
    const axis = face >> 1;
    const [pu, pv] = FACE_PLANE_AXES[axis]!;
    const p = [0, 0, 0];
    // The face of the slice's cells: their far side when it faces +axis.
    p[axis] = (made.frames[c * 4 + 1]! + (face & 1 ? 0 : 1)) * s[axis]!;
    p[pu] = made.frames[c * 4 + 2]! * s[pu]! + u;
    p[pv] = made.frames[c * 4 + 3]! * s[pv]! + v;
    for (let k = 0; k < 3; k += 1) {
      out[at + k] = t.origin[k]! + p[k]!;
      out[at + 3 + k] = k === axis ? (face & 1 ? -1 : 1) : 0;
    }
  };
}

function archPoint(t: ArchTile): ChartPoint {
  const comps = t.made.components;
  return (c, u, v, out, at) => {
    const comp = comps.find((k) => c >= k.first && c < k.first + k.nu * k.nv)!;
    const l = c - comp.first;
    const pu = comp.u0 + (l % comp.nu) * SURFACE_CHART_METRES + u;
    const pv = comp.v0 + Math.floor(l / comp.nu) * SURFACE_CHART_METRES + v;
    const a = comp.uAxis;
    const b = comp.vAxis;
    for (let k = 0; k < 3; k += 1) out[at + k] = comp.origin[k]! + a[k]! * pu + b[k]! * pv;
    out[at + 3] = a[1]! * b[2]! - a[2]! * b[1]!;
    out[at + 4] = a[2]! * b[0]! - a[0]! * b[2]!;
    out[at + 5] = a[0]! * b[1]! - a[1]! * b[0]!;
  };
}

/** Points of texels [from, to) of a resident tile into `out` from float `at`. */
export function tileTexelPoints(src: TileTexels, from: number, to: number, out: Float32Array, at: number): void {
  const { tile, level, packing, charts } = src;
  const area = tile.kind === 'blocks' ? blockPoint(tile) : tile.kind === 'arch' ? archPoint(tile) : null;
  const rect = src.rect;
  if (rect !== undefined) {
    const chart = charts[rect.chart]!;
    if (area === null || chart.kind !== 'area') {
      out.fill(0, at, at + (to - from) * TEXEL_POINT_FLOATS);
      return;
    }
    const iw = areaTexels(chart.w, level);
    const ih = areaTexels(chart.h, level);
    for (let i = from, o = at; i < to; i += 1, o += TEXEL_POINT_FLOATS) {
      const tx = Math.min(iw - 1, Math.max(0, rect.x + (i % rect.w) - SURFACE_CHART_BORDER));
      const ty = Math.min(ih - 1, Math.max(0, rect.y + Math.floor(i / rect.w) - SURFACE_CHART_BORDER));
      area(rect.chart, ((tx + 0.5) / iw) * chart.w, ((ty + 0.5) / ih) * chart.h, out, o);
    }
    return;
  }
  let first = 0;
  let o = at;
  for (let c = 0; c < charts.length && first < to; c += 1) {
    const place = packing.places[c]!;
    const n = place.w * place.h;
    if (first + n <= from) {
      first += n;
      continue;
    }
    const chart = charts[c]!;
    const a = Math.max(from, first) - first;
    const b = Math.min(to, first + n) - first;
    for (let i = a; i < b; i += 1, o += TEXEL_POINT_FLOATS) {
      const x = i % place.w;
      const y = Math.floor(i / place.w);
      out.fill(0, o, o + TEXEL_POINT_FLOATS);
      if (chart.kind === 'area') {
        if (area === null) continue;
        const iw = areaTexels(chart.w, level);
        const ih = areaTexels(chart.h, level);
        const tx = Math.min(iw - 1, Math.max(0, x - SURFACE_CHART_BORDER));
        const ty = Math.min(ih - 1, Math.max(0, y - SURFACE_CHART_BORDER));
        area(c, ((tx + 0.5) / iw) * chart.w, ((ty + 0.5) / ih) * chart.h, out, o);
      } else if (tile.kind === 'model') {
        const s = tile.set.surfels;
        const index = y * place.w + x;
        if (s === null || index >= (chart.levels[surfelLevelFor(chart, level)] ?? 0)) continue;
        modelPoint(tile, index, out, o);
      }
    }
    first += n;
  }
}

/** A chart's unit: its part of the chart, its world box and its plane (normal and offset: n · p = d on it). */
export interface ChartUnitShape {
  readonly rect: ChartRect;
  readonly min: number[];
  readonly max: number[];
  readonly plane: [number, number, number, number];
}

/**
 * An area chart of a block or architecture tile cut into units of at most
 * `CHART_UNIT_TEXELS` a side (empty: a model's chart, whose surfels are lit
 * as one unit with their tile).
 */
export function chartUnits(tile: BlockTile | ArchTile | ModelTile, c: number, chart: SurfaceChart, place: { readonly w: number; readonly h: number }, level: number): ChartUnitShape[] {
  if (chart.kind !== 'area' || tile.kind === 'model') return [];
  const at = tile.kind === 'blocks' ? blockPoint(tile) : archPoint(tile);
  const p = new Float32Array(TEXEL_POINT_FLOATS);
  const iw = areaTexels(chart.w, level);
  const ih = areaTexels(chart.h, level);
  const out: ChartUnitShape[] = [];
  const S = CHART_UNIT_TEXELS;
  for (let y = 0; y < place.h; y += S) {
    for (let x = 0; x < place.w; x += S) {
      const w = Math.min(S, place.w - x);
      const h = Math.min(S, place.h - y);
      // Its interior span in metres (border texels sit on the edge).
      const u0 = (Math.max(0, x - SURFACE_CHART_BORDER) / iw) * chart.w;
      const u1 = (Math.min(iw, x + w - SURFACE_CHART_BORDER) / iw) * chart.w;
      const v0 = (Math.max(0, y - SURFACE_CHART_BORDER) / ih) * chart.h;
      const v1 = (Math.min(ih, y + h - SURFACE_CHART_BORDER) / ih) * chart.h;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]] as const) {
        at(c, u, v, p, 0);
        for (let k = 0; k < 3; k += 1) {
          min[k] = Math.min(min[k]!, p[k]!);
          max[k] = Math.max(max[k]!, p[k]!);
        }
      }
      const n = [p[3]!, p[4]!, p[5]!];
      out.push({ rect: { chart: c, x, y, w, h }, min, max, plane: [n[0]!, n[1]!, n[2]!, n[0]! * p[0]! + n[1]! * p[1]! + n[2]! * p[2]!] });
    }
  }
  return out;
}

const toWorlds = new WeakMap<object, number[]>();

function modelPoint(tile: ModelTile, i: number, out: Float32Array, o: number): void {
  let m = toWorlds.get(tile);
  if (m === undefined) toWorlds.set(tile, (m = invertAffine(tile.worldToLocal)));
  const s = tile.set.surfels!;
  const p = [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!];
  const n = [s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!];
  // Normals through the inverse transpose: the world → local map's columns.
  const w = tile.worldToLocal;
  let len = 0;
  for (let r = 0; r < 3; r += 1) {
    out[o + r] = m[r * 4]! * p[0]! + m[r * 4 + 1]! * p[1]! + m[r * 4 + 2]! * p[2]! + m[r * 4 + 3]!;
    const v = w[r]! * n[0]! + w[4 + r]! * n[1]! + w[8 + r]! * n[2]!;
    out[o + 3 + r] = v;
    len += v * v;
  }
  len = Math.sqrt(len) || 1;
  for (let r = 0; r < 3; r += 1) out[o + 3 + r] = out[o + 3 + r]! / len;
}

/** Points of texels [from, to) of a ring patch: on the ground, with its normal (holes and ground off the terrain get none). */
export function patchTexelPoints(src: PatchTexels, from: number, to: number, out: Float32Array, at: number): void {
  const { patch, texel, field } = src;
  const e = Math.max(field.spacing * 0.5, texel * 0.5);
  let o = at;
  for (let i = from; i < to; i += 1, o += TEXEL_POINT_FLOATS) {
    const x = (patch.ix + (i % patch.w) + 0.5) * texel;
    const z = (patch.iz + Math.floor(i / patch.w) + 0.5) * texel;
    out.fill(0, o, o + TEXEL_POINT_FLOATS);
    const y = field.heightAt(x, z);
    if (y === null) continue;
    const hx0 = field.heightAt(x - e, z) ?? y;
    const hx1 = field.heightAt(x + e, z) ?? y;
    const hz0 = field.heightAt(x, z - e) ?? y;
    const hz1 = field.heightAt(x, z + e) ?? y;
    const n = [(hx0 - hx1) / (2 * e), 1, (hz0 - hz1) / (2 * e)];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 3] = n[0]! / l;
    out[o + 4] = n[1]! / l;
    out[o + 5] = n[2]! / l;
  }
}
