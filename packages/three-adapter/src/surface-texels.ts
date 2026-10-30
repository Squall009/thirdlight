/**
 * Where a unit's texels are in the world: the point and normal each texel's
 * light is computed at (the inverse of the cache's addressing). A unit's
 * texels are counted as the scheduler hands them out (`RelightSlice`): a
 * tile's charts in order, each its rectangle on the atlas row by row (an
 * area chart's border texels sit at its nearest interior texel), a ring
 * patch's texels row by row along +z.
 *
 * A texel with no place on a surface (a surfel rectangle's spare texels, a
 * UV1 square's texels off the unwrap, a terrain hole) gets a zero normal:
 * the lighting pass leaves it.
 *
 * Pure (no three.js).
 */
import type { TerrainField } from '@thirdlight/project-model';

import { SURFACE_CHART_BORDER, SURFACE_CHART_METRES, areaTexels, surfelLevelFor, type AtlasBlock, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { RESOLVE_PAGE, RESOLVE_RING } from './surface-resolve';
import { FACE_PLANE_AXES } from './surface-cache-blocks';
import type { ArchTile, BlockTile, ModelTile } from './surface-cache-scene';
import { TERRAIN_RING_TEXELS, type RingPatch } from './surface-cache-terrain';
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

/** A resident tile with its packing at its level and its atlas blocks; `rect`: only that part of one chart (a chart's unit), its texels row by row. */
export interface TileTexels {
  readonly tile: BlockTile | ArchTile | ModelTile;
  readonly level: number;
  readonly packing: TilePacking;
  readonly charts: readonly SurfaceChart[];
  readonly blocks: readonly AtlasBlock[];
  readonly rect?: ChartRect;
}

/** A terrain ring patch with its terrain, and the terrain's index among the cache's ring terrains. */
export interface PatchTexels {
  readonly patch: RingPatch;
  readonly texel: number;
  readonly field: TerrainField;
  readonly terrain: number;
}

/**
 * Where texels [from, to) of a resident tile are on the atlas, two words
 * each from word `at`: `RESOLVE_PAGE << 30 | page`, then `x | y << 16` (the
 * resolve pass's encoding, `surface-resolve.ts`).
 */
export function tileTexelAddresses(src: TileTexels, from: number, to: number, out: Uint32Array, at: number): void {
  const { packing, blocks } = src;
  const put = (place: number, x: number, y: number, o: number): void => {
    const pl = packing.places[place]!;
    const b = blocks[pl.block]!;
    out[o] = ((RESOLVE_PAGE << 30) | b.page) >>> 0;
    out[o + 1] = (b.x + pl.x + x) | ((b.y + pl.y + y) << 16);
  };
  const rect = src.rect;
  if (rect !== undefined) {
    for (let i = from, o = at; i < to; i += 1, o += 2) put(rect.chart, rect.x + (i % rect.w), rect.y + Math.floor(i / rect.w), o);
    return;
  }
  let first = 0;
  let o = at;
  for (let c = 0; c < packing.places.length && first < to; c += 1) {
    const place = packing.places[c]!;
    const n = place.w * place.h;
    const a = Math.max(from, first) - first;
    const b = Math.min(to, first + n) - first;
    for (let i = a; i < b; i += 1, o += 2) put(c, i % place.w, Math.floor(i / place.w), o);
    first += n;
  }
}

/** Where texels [from, to) of a ring patch are in its terrain's rings (`RESOLVE_RING << 30 | terrain << 3 | ring`, then `x | y << 16`, wrapped as the rings wrap). */
export function patchTexelAddresses(src: PatchTexels, from: number, to: number, out: Uint32Array, at: number): void {
  const { patch } = src;
  const R = TERRAIN_RING_TEXELS;
  for (let i = from, o = at; i < to; i += 1, o += 2) {
    out[o] = ((RESOLVE_RING << 30) | (src.terrain << 3) | patch.ring) >>> 0;
    const x = (((patch.ix + (i % patch.w)) % R) + R) % R;
    const y = (((patch.iz + Math.floor(i / patch.w)) % R) + R) % R;
    out[o + 1] = x | (y << 16);
  }
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

/** A set's surfels on a grid over UV1 (each cell's surfels), kept with the set. */
const uvGrids = new WeakMap<object, { side: number; cells: number[][] }>();

function uvGridOf(s: NonNullable<ModelTile['set']['surfels']>): { side: number; cells: number[][] } {
  let g = uvGrids.get(s);
  if (g !== undefined) return g;
  const n = s.levels[0] ?? 0;
  const side = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cells: number[][] = Array.from({ length: side * side }, () => []);
  const at = (v: number): number => Math.min(side - 1, Math.max(0, Math.floor(v * side)));
  for (let i = 0; i < n; i += 1) cells[at(s.uv1![i * 2 + 1]!) * side + at(s.uv1![i * 2]!)]!.push(i);
  g = { side, cells };
  uvGrids.set(s, g);
  return g;
}

/**
 * A UV1 model's square: a texel's point is the surfel nearest its UV1 (the
 * model's surface as its surfels sample it); a texel farther than a couple
 * of texels or surfel spacings from every surfel's UV1 lies off the unwrap
 * and gets none.
 */
function modelUv1Point(t: ModelTile, iw: number): ChartPoint {
  const s = t.set.surfels!;
  const grid = uvGridOf(s);
  const reach = Math.max(2 / iw, (3 * s.spacing) / Math.sqrt(Math.max(s.area, 1e-9)));
  const chart = t.chart as { w: number; h: number };
  return (_c, u, v, out, at) => {
    const uu = u / chart.w;
    const vv = v / chart.h;
    const r = Math.ceil(reach * grid.side);
    const cx = Math.floor(uu * grid.side);
    const cy = Math.floor(vv * grid.side);
    let best = -1;
    let bestD = reach * reach;
    for (let y = Math.max(0, cy - r); y <= Math.min(grid.side - 1, cy + r); y += 1) {
      for (let x = Math.max(0, cx - r); x <= Math.min(grid.side - 1, cx + r); x += 1) {
        for (const i of grid.cells[y * grid.side + x]!) {
          const d = (s.uv1![i * 2]! - uu) ** 2 + (s.uv1![i * 2 + 1]! - vv) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best < 0) out.fill(0, at, at + TEXEL_POINT_FLOATS);
    else modelPoint(t, best, out, at);
  };
}

/** Points of texels [from, to) of a resident tile into `out` from float `at`. */
export function tileTexelPoints(src: TileTexels, from: number, to: number, out: Float32Array, at: number): void {
  const { tile, level, packing, charts } = src;
  const uv1 = tile.kind === 'model' && tile.chart?.kind === 'area' && tile.set.surfels?.uv1 != null ? modelUv1Point(tile, areaTexels(tile.chart.w, level)) : null;
  const area = tile.kind === 'blocks' ? blockPoint(tile) : tile.kind === 'arch' ? archPoint(tile) : uv1;
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

/**
 * How far (voxels of the model's distance field) a surfel's point is lifted
 * off the mesh along its normal: the field's zero level is trilinear over
 * byte-quantized samples, so within about a voxel of the mesh a ray may
 * start inside it and shadow its own surface.
 */
export const SURFEL_LIFT_VOXELS = 1;

const toWorlds = new WeakMap<object, number[]>();

function modelPoint(tile: ModelTile, i: number, out: Float32Array, o: number): void {
  let m = toWorlds.get(tile);
  if (m === undefined) toWorlds.set(tile, (m = invertAffine(tile.worldToLocal)));
  const s = tile.set.surfels!;
  const n = [s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!];
  // Off the mesh to where the model's distance field reads outside: its zero level is only as exact as its voxels.
  const lift = SURFEL_LIFT_VOXELS * tile.set.voxel;
  const p = [s.positions[i * 3]! + n[0]! * lift, s.positions[i * 3 + 1]! + n[1]! * lift, s.positions[i * 3 + 2]! + n[2]! * lift];
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
