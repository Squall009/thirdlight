/**
 * The surface cache's addressing of voxel worlds: charts over a level-0
 * chunk's drawn surface (the terrain mesher's ground and the merged
 * construction faces, which the page draws as one mesh), made on the page
 * from the mesh its draw batch brought. Nothing is derived in the workers or
 * stored for them.
 *
 * Each triangle is charted by its main axis: its face (axis × 2, + 1 when it
 * faces −axis: the tracer's naming) and the 0.5 m cell columns along that
 * axis its projection covers, each with the surface's height there (cells
 * along the axis) and its normal. A column may hold several surfaces facing
 * one way (a floor over the ground, a cave's floor under the hillside): its
 * heights more than a cell apart are separate layers. Charts are greedy
 * rectangles of columns of one face whose neighbouring layers continue each
 * other (heights within `VOXEL_CHART_STEP` cells, normals within
 * `VOXEL_CHART_TURN`): a flat wall or floor is one chart, as a block layer's
 * coplanar faces are; a terrain slope is a projected chart whose texels
 * follow its height (one per axis and slab); a roof's eave over the street
 * is cut from the street's chart.
 *
 * A texel's light is computed on the chart's surface (heights and normals
 * blended between the column centres). A pixel or a traced hit finds its
 * texel by its cell and face, as a block face is found: each column's layer
 * is keyed by the cells along the axis its surface spans and the cell behind
 * them (the occupancy's solid cell under a surface lying in a partly filled
 * cell, which a walk stops in). A face key counts from the chunk's corner
 * less `VOXEL_KEY_MARGIN` cells, so the cells a chunk's surface reaches past
 * its own box are keyed too.
 *
 * Pure (no three.js).
 */
import { VOXEL_SIZE_M, type WalkSource } from '@thirdlight/voxel';

import { SURFACE_CHART_METRES, packTile, type SurfaceChart } from './surface-cache-atlas';
import { FACE_PLANE_AXES } from './surface-cache-blocks';
import type { SurfaceTile } from './surface-cache';
import { BLOCK_INSET } from './surface-cache-lookup';

/** How far (cells along the axis) two neighbouring columns' surfaces may lie apart and still be one chart: a 45° slope steps one cell a column, half again for a mesher's rounding. */
export const VOXEL_CHART_STEP = 1.5;
/** The least cosine between two neighbouring columns' normals in one chart (a crease sharper than about 45° cuts it). */
export const VOXEL_CHART_TURN = 0.7;
/** Cells a chunk's face keys reach past its box on every side. */
export const VOXEL_KEY_MARGIN = 2;
/** Floats a chart cell holds: its height (cells along the face's axis, absolute) and normal. */
export const VOXEL_SAMPLE_FLOATS = 4;
/** Bit of a keyed face's offset: the key is the cell behind its surface (a walk's hit there; a drawn pixel never lies in it). */
export const VOXEL_KEY_BEHIND = 0x8000;
/** Words of a chart's frame: face, first column along u and v (absolute cells), columns along u and v, first sample. */
export const VOXEL_FRAME_WORDS = 6;

/** The most columns a chart spans a side: a page's chart (`SURFACE_CHART_METRES`), and a byte of the lookup's offsets. */
const CHART_CELLS_MAX = Math.min(255, Math.floor(SURFACE_CHART_METRES / VOXEL_SIZE_M + 1e-6));
/** Columns' bucket coordinates count from this many cells before the chunk's corner. */
const BUCKET_BIAS = 64;

/** One level-0 chunk's charts, and which chart each keyed face lies in. */
export interface VoxelChunkCharts {
  readonly charts: readonly SurfaceChart[];
  /** `VOXEL_FRAME_WORDS` a chart. */
  readonly frames: Int32Array;
  /** `VOXEL_SAMPLE_FLOATS` a chart cell, each chart's row by row along u. */
  readonly samples: Float32Array;
  /** Chart cells (surface columns charted). */
  readonly cells: number;
  /** Sorted face keys (`voxelFaceKey`). */
  readonly keys: Uint32Array;
  /** Per key: its chart. */
  readonly chartOf: Uint32Array;
  /** Per key: its column within its chart (i | j << 8). */
  readonly offsets: Uint16Array;
  /** The chunk's corner cell and edge (cells). */
  readonly cell0: readonly [number, number, number];
  readonly edge: number;
}

/** A face's key within its chunk (−1: the cell lies past the chunk's margin). */
export function voxelFaceKey(cell0: readonly number[], edge: number, x: number, y: number, z: number, face: number): number {
  const s = edge + 2 * VOXEL_KEY_MARGIN;
  const lx = x - cell0[0]! + VOXEL_KEY_MARGIN;
  const ly = y - cell0[1]! + VOXEL_KEY_MARGIN;
  const lz = z - cell0[2]! + VOXEL_KEY_MARGIN;
  if (lx < 0 || ly < 0 || lz < 0 || lx >= s || ly >= s || lz >= s) return -1;
  return ((ly * s + lz) * s + lx) * 6 + face;
}

interface Layer {
  z: number;
  lo: number;
  hi: number;
  readonly n: [number, number, number];
  count: number;
  taken: boolean;
}

/** Buckets a chunk's samples can fall in: six faces × 256² columns. */
const BUCKETS = 6 * 256 * 256;
/** Per bucket, a count and then a start (reused by every charting; only the buckets used are cleared). */
const bucketCount = new Int32Array(BUCKETS + 1);

/** A chunk's samples as growable columns of numbers. */
class Samples {
  key = new Int32Array(1024);
  z = new Float32Array(1024);
  dh = new Float32Array(1024);
  tri = new Int32Array(1024);
  n = 0;
  push(key: number, z: number, dh: number, tri: number): void {
    if (this.n === this.key.length) {
      const grow = <T extends Int32Array | Float32Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.key = grow(this.key);
      this.z = grow(this.z);
      this.dh = grow(this.dh);
      this.tri = grow(this.tri);
    }
    this.key[this.n] = key;
    this.z[this.n] = z;
    this.dh[this.n] = dh;
    this.tri[this.n] = tri;
    this.n += 1;
  }
  /** The samples' indices ordered by bucket (a counting sort over the buckets used). */
  byBucket(): Int32Array {
    const out = new Int32Array(this.n);
    const used: number[] = [];
    for (let i = 0; i < this.n; i += 1) if (bucketCount[this.key[i]!]!++ === 0) used.push(this.key[i]!);
    used.sort((a, b) => a - b);
    let at = 0;
    for (const k of used) {
      const c = bucketCount[k]!;
      bucketCount[k] = at;
      at += c;
    }
    for (let i = 0; i < this.n; i += 1) out[bucketCount[this.key[i]!]!++] = i;
    for (const k of used) bucketCount[k] = 0;
    return out;
  }
}

/** Whether square [x0, x0 + 1] × [y0, y0 + 1] meets triangle (ax, ay), (bx, by), (cx, cy) (separating axes: the square's two, the triangle's three edges). */
function squareMeetsTriangle(x0: number, y0: number, t: readonly number[]): boolean {
  const e = 1e-6;
  if (Math.max(t[0]!, t[2]!, t[4]!) < x0 - e || Math.min(t[0]!, t[2]!, t[4]!) > x0 + 1 + e) return false;
  if (Math.max(t[1]!, t[3]!, t[5]!) < y0 - e || Math.min(t[1]!, t[3]!, t[5]!) > y0 + 1 + e) return false;
  for (let k = 0; k < 3; k += 1) {
    const ax = t[k * 2]!, ay = t[k * 2 + 1]!;
    const bx = t[((k + 1) % 3) * 2]!, by = t[((k + 1) % 3) * 2 + 1]!;
    const cx = t[((k + 2) % 3) * 2]!, cy = t[((k + 2) % 3) * 2 + 1]!;
    let mx = -(by - ay);
    let my = bx - ax;
    // Outward: away from the third corner.
    if (mx * (cx - ax) + my * (cy - ay) > 0) {
      mx = -mx;
      my = -my;
    }
    // The square's corner farthest against the edge's outward normal.
    const least = mx * ((mx >= 0 ? x0 : x0 + 1) - ax) + my * ((my >= 0 ? y0 : y0 + 1) - ay);
    if (least > e * Math.hypot(mx, my)) return false;
  }
  return true;
}

/** The barycentric weights of the point of triangle `t` (2D) nearest (px, py), into `out`. */
function nearestWeights(px: number, py: number, t: readonly number[], out: [number, number, number]): void {
  const ax = t[0]!, ay = t[1]!, bx = t[2]!, by = t[3]!, cx = t[4]!, cy = t[5]!;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) > 1e-12) {
    const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
    const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
    const wc = 1 - wa - wb;
    if (wa >= 0 && wb >= 0 && wc >= 0) {
      out[0] = wa;
      out[1] = wb;
      out[2] = wc;
      return;
    }
  }
  // Outside: the nearest point of the nearest edge.
  let bestD = Infinity;
  for (let k = 0; k < 3; k += 1) {
    const i = k;
    const j = (k + 1) % 3;
    const x1 = t[i * 2]!, y1 = t[i * 2 + 1]!, x2 = t[j * 2]!, y2 = t[j * 2 + 1]!;
    const lx = x2 - x1, ly = y2 - y1;
    const l2 = lx * lx + ly * ly;
    const s = l2 > 0 ? Math.min(1, Math.max(0, ((px - x1) * lx + (py - y1) * ly) / l2)) : 0;
    const qx = x1 + lx * s, qy = y1 + ly * s;
    const dd = (qx - px) ** 2 + (qy - py) ** 2;
    if (dd < bestD) {
      bestD = dd;
      out[0] = out[1] = out[2] = 0;
      out[i] = 1 - s;
      out[j] = s;
    }
  }
}

/** Whether layer `b` continues layer `a` (one chart may hold both). */
function continues(a: Layer, b: Layer): boolean {
  return Math.abs(a.z - b.z) <= VOXEL_CHART_STEP && a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2] >= VOXEL_CHART_TURN;
}

/** Whether a level-0 cell is drawn as a body, by a walk's blocks (null: no block of level 0 knows it). */
export function walkSolidAt(src: WalkSource): (x: number, y: number, z: number) => boolean | null {
  const shift = src.blockShift(0);
  const e = 1 << shift;
  return (x, y, z) => {
    const b = src.block(0, x >> shift, y >> shift, z >> shift, 'solid');
    if (b === null) return null;
    return b.cell(((x & (e - 1)) * e + (z & (e - 1))) * e + (y & (e - 1)));
  };
}

/**
 * The charts of a level-0 chunk's drawn surface: `positions` (metres from
 * the chunk's corner cell `cell0`, three floats a vertex) and `indices`
 * (triangles), `edge` cells a side. With `solidAt` (whether a cell is drawn
 * as a body; null: not known), a surface whose cell half a cell in front of
 * it is solid is hidden (the ground under a building's floor) and charted
 * nowhere.
 */
export function voxelChunkCharts(positions: ArrayLike<number>, indices: ArrayLike<number>, cell0: readonly [number, number, number], edge: number, solidAt?: (x: number, y: number, z: number) => boolean | null): VoxelChunkCharts {
  const steps = voxelChunkChartsSteps(positions, indices, cell0, edge, solidAt);
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
  }
}

/** Triangles, columns and chart seeds a step of {@link voxelChunkChartsSteps} takes before it yields. */
const CHART_STEP_ITEMS = 256;

/** {@link voxelChunkCharts} in steps (a few hundred triangles, columns or charts each), for charting over frames. */
export function* voxelChunkChartsSteps(positions: ArrayLike<number>, indices: ArrayLike<number>, cell0: readonly [number, number, number], edge: number, solidAt?: (x: number, y: number, z: number) => boolean | null): Generator<void, VoxelChunkCharts> {
  // Samples (a triangle over a column): their bucket (face and column, from BUCKET_BIAS before the corner), height, spread and triangle.
  const S = new Samples();
  const normals: number[] = [];
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as [number, number, number][];
  const tri = [0, 0, 0, 0, 0, 0];
  const w = [0, 0, 0] as [number, number, number];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    if ((t / 3) % CHART_STEP_ITEMS === CHART_STEP_ITEMS - 1) yield;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t + k]! * 3;
      for (let a = 0; a < 3; a += 1) P[k]![a] = cell0[a]! + positions[v + a]! / VOXEL_SIZE_M;
    }
    const ux = P[1]![0] - P[0]![0], uy = P[1]![1] - P[0]![1], uz = P[1]![2] - P[0]![2];
    const vx = P[2]![0] - P[0]![0], vy = P[2]![1] - P[0]![1], vz = P[2]![2] - P[0]![2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const na = axis === 0 ? nx : axis === 1 ? ny : nz;
    const face = axis * 2 + (na < 0 ? 1 : 0);
    const pu = axis === 0 ? 2 : 0;
    const pv = axis === 1 ? 2 : 1;
    for (let k = 0; k < 3; k += 1) {
      tri[k * 2] = P[k]![pu]!;
      tri[k * 2 + 1] = P[k]![pv]!;
    }
    // How far the surface climbs along the axis over half a column.
    const dh = (0.5 * (ax + ay + az - Math.abs(na))) / Math.abs(na);
    const tn = normals.length / 3;
    normals.push(nx, ny, nz);
    const u0 = Math.floor(Math.min(tri[0]!, tri[2]!, tri[4]!));
    const u1 = Math.max(u0, Math.ceil(Math.max(tri[0]!, tri[2]!, tri[4]!)) - 1);
    const v0 = Math.floor(Math.min(tri[1]!, tri[3]!, tri[5]!));
    const v1 = Math.max(v0, Math.ceil(Math.max(tri[1]!, tri[3]!, tri[5]!)) - 1);
    // A triangle inside one column meets it: no test.
    const one = u0 === u1 && v0 === v1;
    for (let iv = v0; iv <= v1; iv += 1) {
      for (let iu = u0; iu <= u1; iu += 1) {
        if (!one && !squareMeetsTriangle(iu, iv, tri)) continue;
        nearestWeights(iu + 0.5, iv + 0.5, tri, w);
        const z = w[0] * P[0]![axis]! + w[1] * P[1]![axis]! + w[2] * P[2]![axis]!;
        const lu = iu - cell0[pu]! + BUCKET_BIAS;
        const lv = iv - cell0[pv]! + BUCKET_BIAS;
        if (lu < 0 || lv < 0 || lu >= 256 || lv >= 256) continue;
        S.push((face * 256 + lu) * 256 + lv, z, dh, tn);
      }
    }
  }
  // Each column's layers: samples a cell or less apart are one surface (samples whose cell in front is a body: hidden).
  const columns = new Map<number, Layer[]>();
  const order = S.byBucket();
  const front = [0, 0, 0];
  let buckets = 0;
  for (let a = 0; a < order.length; ) {
    if (++buckets % CHART_STEP_ITEMS === 0) yield;
    const key = S.key[order[a]!]!;
    let b = a + 1;
    while (b < order.length && S.key[order[b]!] === key) b += 1;
    // By height within the column (a few samples: insertion).
    for (let i = a + 1; i < b; i += 1) {
      const x = order[i]!;
      let j = i - 1;
      while (j >= a && S.z[order[j]!]! > S.z[x]!) {
        order[j + 1] = order[j]!;
        j -= 1;
      }
      order[j + 1] = x;
    }
    const face = Math.floor(key / 65536);
    const axis = face >> 1;
    const pu = axis === 0 ? 2 : 0;
    const pv = axis === 1 ? 2 : 1;
    front[pu] = ((key >> 8) & 255) - BUCKET_BIAS + cell0[pu]!;
    front[pv] = (key & 255) - BUCKET_BIAS + cell0[pv]!;
    const layers: Layer[] = [];
    let cur: Layer | null = null;
    for (let i = a; i < b; i += 1) {
      const k = order[i]!;
      const z = S.z[k]!;
      const lo = z - S.dh[k]!;
      const hi = z + S.dh[k]!;
      const tn = S.tri[k]! * 3;
      front[axis] = Math.floor(z + (face & 1 ? -0.5 : 0.5));
      if (solidAt?.(front[0]!, front[1]!, front[2]!) === true) continue;
      if (cur !== null && lo <= cur.hi + 1) {
        cur.z += z;
        cur.count += 1;
        cur.lo = Math.min(cur.lo, lo);
        cur.hi = Math.max(cur.hi, hi);
        for (let q = 0; q < 3; q += 1) cur.n[q]! += normals[tn + q]!;
        continue;
      }
      cur = { z, lo, hi, n: [normals[tn]!, normals[tn + 1]!, normals[tn + 2]!], count: 1, taken: false };
      layers.push(cur);
    }
    a = b;
    if (layers.length === 0) continue;
    for (const l of layers) {
      l.z /= l.count;
      const nl = Math.hypot(l.n[0], l.n[1], l.n[2]) || 1;
      for (let q = 0; q < 3; q += 1) l.n[q]! /= nl;
    }
    columns.set(key, layers);
  }
  // Greedy rectangles per face: rows along u, then as many whole rows along v as continue.
  const charts: SurfaceChart[] = [];
  const frames: number[] = [];
  const samples: number[] = [];
  const keyed = new Map<number, number>();
  const seeds = [...columns.keys()].sort((a, b) => Math.floor(a / 65536) - Math.floor(b / 65536) || (a & 255) - (b & 255) || ((a >> 8) & 255) - ((b >> 8) & 255));
  const pick = (face: number, lu: number, lv: number, ref: Layer, left: Layer | null): Layer | null => {
    if (lu >= 256 || lv >= 256) return null;
    const layers = columns.get((face * 256 + lu) * 256 + lv);
    if (layers === undefined) return null;
    let best: Layer | null = null;
    for (const l of layers) {
      if (l.taken || !continues(ref, l) || (left !== null && !continues(left, l))) continue;
      if (best === null || Math.abs(l.z - ref.z) < Math.abs(best.z - ref.z)) best = l;
    }
    return best;
  };
  let seeded = 0;
  for (const key of seeds) {
    if (++seeded % CHART_STEP_ITEMS === 0) yield;
    const face = Math.floor(key / 65536);
    const lu0 = (key >> 8) & 255;
    const lv0 = key & 255;
    for (const seed of columns.get(key)!) {
      if (seed.taken) continue;
      seed.taken = true;
      const rows: Layer[][] = [[seed]];
      for (let w = 1; w < CHART_CELLS_MAX; w += 1) {
        const next = pick(face, lu0 + w, lv0, rows[0]![w - 1]!, null);
        if (next === null) break;
        next.taken = true;
        rows[0]!.push(next);
      }
      const wc = rows[0]!.length;
      for (let h = 1; h < CHART_CELLS_MAX; h += 1) {
        const row: Layer[] = [];
        for (let i = 0; i < wc; i += 1) {
          const l = pick(face, lu0 + i, lv0 + h, rows[h - 1]![i]!, i > 0 ? row[i - 1]! : null);
          if (l === null) break;
          // Held while the row is tried, so one layer is never picked twice in it.
          l.taken = true;
          row.push(l);
        }
        if (row.length < wc) {
          for (const l of row) l.taken = false;
          break;
        }
        rows.push(row);
      }
      const hc = rows.length;
      const axis = face >> 1;
      const [pu, pv] = FACE_PLANE_AXES[axis]!;
      const chart = charts.length;
      charts.push({ kind: 'area', w: wc * VOXEL_SIZE_M, h: hc * VOXEL_SIZE_M });
      const u0 = lu0 - BUCKET_BIAS + cell0[pu]!;
      const v0 = lv0 - BUCKET_BIAS + cell0[pv]!;
      frames.push(face, u0, v0, wc, hc, samples.length / VOXEL_SAMPLE_FLOATS);
      const solidUp = (face & 1) === 0;
      for (let j = 0; j < hc; j += 1) {
        for (let i = 0; i < wc; i += 1) {
          const l = rows[j]![i]!;
          samples.push(l.z, l.n[0], l.n[1], l.n[2]);
          // The cells its surface spans along the axis, and the one behind them.
          const from = solidUp ? Math.floor(l.lo - BLOCK_INSET) - 1 : Math.floor(l.lo + BLOCK_INSET);
          const to = solidUp ? Math.floor(l.hi - BLOCK_INSET) : Math.floor(l.hi + BLOCK_INSET) + 1;
          const cell = [0, 0, 0];
          cell[pu] = u0 + i;
          cell[pv] = v0 + j;
          for (let k = from; k <= to; k += 1) {
            cell[axis] = k;
            const fk = voxelFaceKey(cell0, edge, cell[0]!, cell[1]!, cell[2]!, face);
            const behind = k === (solidUp ? from : to) ? VOXEL_KEY_BEHIND : 0;
            if (fk >= 0 && !keyed.has(fk)) keyed.set(fk, chart * 65536 + (i | (j << 8) | behind));
          }
        }
      }
    }
  }
  const entries = [...keyed].sort((a, b) => a[0] - b[0]);
  const keys = new Uint32Array(entries.length);
  const chartOf = new Uint32Array(entries.length);
  const offsets = new Uint16Array(entries.length);
  entries.forEach(([k, v], i) => {
    keys[i] = k;
    chartOf[i] = Math.floor(v / 65536);
    offsets[i] = v & 0xffff;
  });
  return { charts, frames: Int32Array.from(frames), samples: Float32Array.from(samples), cells: samples.length / VOXEL_SAMPLE_FLOATS, keys, chartOf, offsets, cell0: [cell0[0], cell0[1], cell0[2]], edge };
}

/** The keyed entry of a face (−1: none). */
function entryOf(made: VoxelChunkCharts, key: number): number {
  let lo = 0;
  let hi = made.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = made.keys[mid]!;
    if (k === key) return mid;
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The chart and place (metres along its u and v) of a point on face `face`
 * of level-0 cell `cell`: `fu`, `fv` its fractions across the cell along the
 * face's plane axes (null: no surface of this chunk is keyed there).
 */
export function locateVoxelFace(made: VoxelChunkCharts, cell: readonly number[], face: number, fu: number, fv: number): { chart: number; u: number; v: number } | null {
  const key = voxelFaceKey(made.cell0, made.edge, cell[0]!, cell[1]!, cell[2]!, face);
  if (key < 0) return null;
  const e = entryOf(made, key);
  if (e < 0) return null;
  const o = made.offsets[e]!;
  return { chart: made.chartOf[e]!, u: ((o & 255) + fu) * VOXEL_SIZE_M, v: (((o >> 8) & 0x7f) + fv) * VOXEL_SIZE_M };
}

/**
 * Where a traced hit's light is, over the chunks' charts (`chartsAt`: the
 * charts of the chunk holding a cell, null: none): the hit's own face of its
 * cell first, then the cell's other faces (a ray may enter a smooth slope's
 * cells by a side its triangles do not face), each in the cell's chunk and
 * the chunks beside it along that face's axis (a key may be a neighbour's);
 * the nearest charted point to the hit within `VOXEL_HIT_REACH` metres.
 */
export function locateVoxelHit(chartsAt: (x: number, y: number, z: number) => VoxelChunkCharts | null, p: readonly number[], cell: readonly number[], face: number): { made: VoxelChunkCharts; chart: number; u: number; v: number } | null {
  const out = new Float32Array(6);
  let best: { made: VoxelChunkCharts; chart: number; u: number; v: number } | null = null;
  let bestD = VOXEL_HIT_REACH;
  for (let k = 0; k < 6; k += 1) {
    const f = k === 0 ? face : k <= face ? k - 1 : k;
    const axis = f >> 1;
    const [pu, pv] = FACE_PLANE_AXES[axis]!;
    const q = [p[0]! / VOXEL_SIZE_M, p[1]! / VOXEL_SIZE_M, p[2]! / VOXEL_SIZE_M];
    const fu = Math.min(1, Math.max(0, q[pu]! - cell[pu]!));
    const fv = Math.min(1, Math.max(0, q[pv]! - cell[pv]!));
    for (const step of [0, -1, 1]) {
      const c = [cell[0]!, cell[1]!, cell[2]!];
      // The chunk beside, along the face's axis: a cell is keyed by the chunk whose surface spans it.
      c[axis]! += step * 2 * VOXEL_KEY_MARGIN;
      const made = chartsAt(c[0]!, c[1]!, c[2]!);
      if (made === null || (step !== 0 && made === chartsAt(cell[0]!, cell[1]!, cell[2]!))) continue;
      const at = locateVoxelFace(made, cell, f, fu, fv);
      if (at === null) continue;
      voxelChartPoint(made, at.chart, at.u, at.v, out, 0);
      const d = Math.hypot(out[0]! - p[0]!, out[1]! - p[1]!, out[2]! - p[2]!);
      if (d < bestD) {
        bestD = d;
        best = { made, ...at };
      }
    }
    // The hit's own face, found near: no other face is asked.
    if (k === 0 && best !== null) return best;
  }
  return best;
}

/** A voxel hit's (`TRACE_VOXELS`) level-0 cell and its point on the face it entered by (metres). */
export function voxelHitCell(hit: { readonly face: number; readonly a0: number; readonly a1: number }): { cell: [number, number, number]; point: [number, number, number] } {
  const cell: [number, number, number] = [(hit.a0 & 0xffff) - 32768, (hit.a1 & 0xffff) - 32768, (hit.a0 >>> 16) - 32768];
  const axis = Math.min(2, hit.face >> 1);
  const [pu, pv] = FACE_PLANE_AXES[axis]!;
  const q = [cell[0], cell[1], cell[2]];
  // The face it came in by: the cell's +axis side for a face looking +axis.
  q[axis]! += hit.face & 1 ? 0 : 1;
  q[pu]! += ((hit.a1 >>> 16) & 255) / 255;
  q[pv]! += (hit.a1 >>> 24) / 255;
  return { cell, point: [q[0]! * VOXEL_SIZE_M, q[1]! * VOXEL_SIZE_M, q[2]! * VOXEL_SIZE_M] };
}

/** A voxel hit's address words (`TRACE_VOXELS`): its level-0 cell, and its place across the face (0–1 along the face's u and v). */
export function voxelHitWords(cell: readonly number[], fu: number, fv: number): { a0: number; a1: number } {
  const q = (f: number): number => Math.round(Math.min(1, Math.max(0, f)) * 255);
  return { a0: (((cell[0]! + 32768) & 0xffff) | (((cell[2]! + 32768) & 0xffff) << 16)) >>> 0, a1: (((cell[1]! + 32768) & 0xffff) | (q(fu) << 16) | (q(fv) << 24)) >>> 0 };
}

/** How far (m) from a traced hit its light may be read: a cell and a half (a smooth surface lies within a cell of the walk's face). */
export const VOXEL_HIT_REACH = 1.5 * VOXEL_SIZE_M;

/** A pixel's or a hit's cell and fractions for world point `p` (metres) on face `face` (the point taken a little behind the face). */
export function voxelCellOf(p: readonly number[], face: number): { cell: [number, number, number]; fu: number; fv: number } {
  const axis = face >> 1;
  const sgn = face & 1 ? -1 : 1;
  const q = [p[0]! / VOXEL_SIZE_M, p[1]! / VOXEL_SIZE_M, p[2]! / VOXEL_SIZE_M];
  q[axis]! -= sgn * BLOCK_INSET;
  const cell: [number, number, number] = [Math.floor(q[0]!), Math.floor(q[1]!), Math.floor(q[2]!)];
  const [pu, pv] = FACE_PLANE_AXES[axis]!;
  return { cell, fu: q[pu]! - cell[pu]!, fv: q[pv]! - cell[pv]! };
}

/** A chart's frame: face, first columns, columns and first sample. */
export function voxelChartFrame(made: VoxelChunkCharts, c: number): { face: number; u0: number; v0: number; wc: number; hc: number; first: number } {
  const f = made.frames;
  const at = c * VOXEL_FRAME_WORDS;
  return { face: f[at]!, u0: f[at + 1]!, v0: f[at + 2]!, wc: f[at + 3]!, hc: f[at + 4]!, first: f[at + 5]! };
}

/**
 * The point (metres) and normal of chart `c` at (u, v) metres along it, into
 * `out` from `at`: the columns' heights and normals blended bilinearly
 * between their centres (held to the chart's columns at its edges).
 */
export function voxelChartPoint(made: VoxelChunkCharts, c: number, u: number, v: number, out: Float32Array, at: number): void {
  const f = made.frames;
  const fa = c * VOXEL_FRAME_WORDS;
  const face = f[fa]!;
  const wc = f[fa + 3]!;
  const hc = f[fa + 4]!;
  const first = f[fa + 5]!;
  const axis = face >> 1;
  const pu = axis === 0 ? 2 : 0;
  const pv = axis === 1 ? 2 : 1;
  const cu = Math.min(wc - 1, Math.max(0, u / VOXEL_SIZE_M - 0.5));
  const cv = Math.min(hc - 1, Math.max(0, v / VOXEL_SIZE_M - 0.5));
  const i0 = Math.floor(cu);
  const j0 = Math.floor(cv);
  const di = i0 + 1 < wc ? 1 : 0;
  const dj = j0 + 1 < hc ? wc : 0;
  const tu = cu - i0;
  const tv = cv - j0;
  const s = made.samples;
  const F = VOXEL_SAMPLE_FLOATS;
  const o00 = (first + j0 * wc + i0) * F;
  const o10 = o00 + di * F;
  const o01 = o00 + dj * F;
  const o11 = o01 + di * F;
  const w00 = (1 - tu) * (1 - tv);
  const w10 = tu * (1 - tv);
  const w01 = (1 - tu) * tv;
  const w11 = tu * tv;
  const h = w00 * s[o00]! + w10 * s[o10]! + w01 * s[o01]! + w11 * s[o11]!;
  const nx = w00 * s[o00 + 1]! + w10 * s[o10 + 1]! + w01 * s[o01 + 1]! + w11 * s[o11 + 1]!;
  const ny = w00 * s[o00 + 2]! + w10 * s[o10 + 2]! + w01 * s[o01 + 2]! + w11 * s[o11 + 2]!;
  const nz = w00 * s[o00 + 3]! + w10 * s[o10 + 3]! + w01 * s[o01 + 3]! + w11 * s[o11 + 3]!;
  const nl = Math.hypot(nx, ny, nz) || 1;
  out[at + axis] = h * VOXEL_SIZE_M;
  out[at + pu] = f[fa + 1]! * VOXEL_SIZE_M + u;
  out[at + pv] = f[fa + 2]! * VOXEL_SIZE_M + v;
  out[at + 3] = nx / nl;
  out[at + 4] = ny / nl;
  out[at + 5] = nz / nl;
}

/**
 * The world box of chart `c`'s columns [i0, i1) × [j0, j1) (their surface
 * points, grown by a cell along the axis for the blend between them), and
 * its plane when every column lies on one (normal and offset; null: curved).
 */
export function voxelChartBox(made: VoxelChunkCharts, c: number, i0: number, i1: number, j0: number, j1: number): { min: number[]; max: number[]; plane: [number, number, number, number] | null } {
  const { face, u0, v0, wc, first } = voxelChartFrame(made, c);
  const axis = face >> 1;
  const [pu, pv] = FACE_PLANE_AXES[axis]!;
  const s = made.samples;
  const F = VOXEL_SAMPLE_FLOATS;
  let lo = Infinity;
  let hi = -Infinity;
  let flat = true;
  const o0 = (first + j0 * wc + i0) * F;
  for (let j = j0; j < j1; j += 1) {
    for (let i = i0; i < i1; i += 1) {
      const o = (first + j * wc + i) * F;
      lo = Math.min(lo, s[o]!);
      hi = Math.max(hi, s[o]!);
      if (s[o] !== s[o0] || s[o + 1] !== s[o0 + 1] || s[o + 2] !== s[o0 + 2] || s[o + 3] !== s[o0 + 3]) flat = false;
    }
  }
  // A plane only for an axis-aligned one (a construction face): its columns' heights equal, their normals the axis.
  if (Math.abs(s[o0 + 1 + axis]!) < 0.9999) flat = false;
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  min[axis] = (lo - (flat ? 0 : 1)) * VOXEL_SIZE_M;
  max[axis] = (hi + (flat ? 0 : 1)) * VOXEL_SIZE_M;
  min[pu] = (u0 + i0) * VOXEL_SIZE_M;
  max[pu] = (u0 + i1) * VOXEL_SIZE_M;
  min[pv] = (v0 + j0) * VOXEL_SIZE_M;
  max[pv] = (v0 + j1) * VOXEL_SIZE_M;
  if (!flat) return { min, max, plane: null };
  const sgn = face & 1 ? -1 : 1;
  const n: [number, number, number] = [0, 0, 0];
  n[axis] = sgn;
  return { min, max, plane: [n[0], n[1], n[2], sgn * s[o0]! * VOXEL_SIZE_M] };
}

/** The bytes of pages a chunk's charts take at each of the cache's levels (index: level). */
export function voxelChartBytes(made: VoxelChunkCharts, levels: number): number[] {
  return Array.from({ length: levels }, (_, l) => (made.charts.length === 0 ? 0 : packTile(made.charts, l).bytes));
}

/** A level-0 voxel chunk as a cache tile: its box (a cell past it on every side), its mesh's version, and its charts made when first asked. */
export interface VoxelTile extends SurfaceTile {
  readonly kind: 'voxels';
  readonly cell0: readonly [number, number, number];
  readonly edge: number;
  made: VoxelChunkCharts | null;
}

/** The mesh a voxel tile is charted from: positions (metres from its chunk's corner) and triangles. */
export interface VoxelTileMesh {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/** A level-0 chunk's tile (`key`: the world and chunk; `version`: its mesh's). */
export function voxelChunkTile(key: string, version: number, cell0: readonly [number, number, number], edge: number, mesh: () => VoxelTileMesh | null, solidAt?: (x: number, y: number, z: number) => boolean | null): VoxelTile {
  const m = VOXEL_SIZE_M;
  return {
    kind: 'voxels',
    key,
    version,
    cell0,
    edge,
    min: [(cell0[0] - 1) * m, (cell0[1] - 1) * m, (cell0[2] - 1) * m],
    max: [(cell0[0] + edge + 1) * m, (cell0[1] + edge + 1) * m, (cell0[2] + edge + 1) * m],
    made: null,
    charts() {
      if (this.made === null) {
        const g = mesh();
        this.made = g === null ? voxelChunkCharts([], [], cell0, edge) : voxelChunkCharts(g.positions, g.indices, cell0, edge, solidAt);
      }
      return this.made.charts;
    },
  };
}
