/**
 * Roads, paths and rivers along a spline, written into the world grid
 * (world-writer.ts): a pure function of the spline's sampled course and the
 * ground under it, a chunk at a time.
 *
 * The course is a line through samples (world metres: x, y, z and the width
 * there), each column of cells measured to its nearest segment, so a bend
 * keeps its full width and an open end stops square at its last point. In a
 * column within half the width of the course:
 * - **a road or a path**: its surface at the course's height (the top cell
 *   filled to it, the 16 fill levels), one cell of the surface material, the
 *   bed's depth of bed material under it, and `clear` metres of air above;
 * - **a river**: liquid from the course's height down its depth (the top
 *   cell to its share), a cell of bed material under it, `clear` of air
 *   above. Where a river runs inside the reach of a water body it meets
 *   (`bodies`), its cells under the body's level are written as the body's
 *   liquid at that level, so the two join and the body takes them as its
 *   own.
 * Past the half width, within the shoulder's width, the ground is brought to
 * the course by the shoulder's slope: ground above the line rising from the
 * edge is cut away and open cells under the line falling from it are filled
 * (with the ground's material where the fill meets it), so a road on a bank
 * or in a cutting meets the ground it crosses. A shoulder reaches no
 * further than its width times its slope up or down; ground past that is
 * left as it is. Over the roadway the same cut reaches as high, and the
 * same fill runs under the bed.
 *
 * Nothing it writes is reported in metres: callers give the samples in
 * world metres and read cells.
 */
import { CellDelta } from '../cell-delta';
import { cellInWorld, WORLD_CELL_MAX_XZ, WORLD_CELL_MAX_Y, WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y, VOXEL_SIZE_M, type ChunkCoord, type ChunkGrid } from '../coords';
import { recordValue, SHAPE_FULL, valueMaterial, valueRole, valueShape, valueWetness, VOXEL_ROLE } from '../record';
import { isMediumRole } from '../role-traits';
import type { CellBox } from '../stroke';
import { fillShapeAt, liquidValue } from '../water/level-fill';
import type { GeneratedDefinition } from './generator';
import type { GroundReader, WorldWriter } from './world-writer';

/** What a spline writes. */
export const SPLINE_VOXEL_KINDS = ['road', 'path', 'river'] as const;
export type SplineVoxelKind = (typeof SPLINE_VOXEL_KINDS)[number];

/** A water body a river meets: its level and reach in metres, its seed's column in metres, its liquid. */
export interface SplineBodyMeet {
  readonly level: number;
  readonly material: number;
  readonly seed: readonly [number, number];
  readonly reach: number;
}

/** The writer's definition: the spline's `voxels` section resolved, its course sampled (see the module's comment). */
export interface SplineVoxelDefinition extends GeneratedDefinition {
  readonly kind: SplineVoxelKind;
  /** The surface's (road, path) or the liquid's (river) voxel material. */
  readonly material: number;
  /** Under a road: its depth (metres); under a river: its material, one cell. Null: none. */
  readonly bed: { readonly material: number; readonly depth: number } | null;
  /** A river's depth (metres). */
  readonly depth: number;
  readonly shoulder: { readonly width: number; readonly slope: number } | null;
  /** Metres of air above the course (0: none). */
  readonly clear: number;
  /** x, y, z, width per sample (world metres), along the course. */
  readonly samples: readonly number[];
  readonly closed: boolean;
  /** The water bodies whose reach the course meets (rivers only). */
  readonly bodies: readonly SplineBodyMeet[];
}

/** The spline writer's version: moves whenever what it writes changes. */
export const SPLINE_WRITER_VERSION = 1;

/** Metres of the buckets segments are indexed by. */
const BUCKET_M = 16;

interface Course {
  /** Segments: ax, az, bx, bz, ay, by, and the half widths at a and b. */
  readonly seg: Float64Array;
  /** An open course's ends: the first point and the way the course leaves it, the last point and the way it arrives (null: closed). */
  readonly cap: readonly number[] | null;
  readonly buckets: Map<number, number[]>;
  /** Half width plus shoulder: how far from the line a column is touched (metres). */
  readonly reach: number;
  readonly box: CellBox | null;
  /** Per bucket, the lowest and highest course height of its segments (metres). */
  readonly heights: Map<number, [number, number]>;
}

const courses = new WeakMap<SplineVoxelDefinition, Course>();

const bucketKey = (bx: number, bz: number): number => (bx + 32768) * 65536 + (bz + 32768);

function courseOf(def: SplineVoxelDefinition): Course {
  const hit = courses.get(def);
  if (hit !== undefined) return hit;
  const p = def.samples;
  const n = Math.floor(p.length / 4);
  const segs = def.closed && n >= 3 ? n : n - 1;
  const seg = new Float64Array(Math.max(0, segs) * 8);
  const sh = def.shoulder?.width ?? 0;
  let maxHalf = 0;
  for (let i = 0; i < n; i++) maxHalf = Math.max(maxHalf, p[i * 4 + 3]! / 2);
  const reach = maxHalf + sh;
  const buckets = new Map<number, number[]>();
  const heights = new Map<number, [number, number]>();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < segs; k++) {
    const a = k * 4;
    const b = ((k + 1) % n) * 4;
    seg.set([p[a]!, p[a + 2]!, p[b]!, p[b + 2]!, p[a + 1]!, p[b + 1]!, p[a + 3]! / 2, p[b + 3]! / 2], k * 8);
    const r = Math.max(p[a + 3]!, p[b + 3]!) / 2 + sh;
    const x0 = Math.min(p[a]!, p[b]!) - r;
    const x1 = Math.max(p[a]!, p[b]!) + r;
    const z0 = Math.min(p[a + 2]!, p[b + 2]!) - r;
    const z1 = Math.max(p[a + 2]!, p[b + 2]!) + r;
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minZ = Math.min(minZ, z0);
    maxZ = Math.max(maxZ, z1);
    minY = Math.min(minY, p[a + 1]!, p[b + 1]!);
    maxY = Math.max(maxY, p[a + 1]!, p[b + 1]!);
    for (let bx = Math.floor(x0 / BUCKET_M); bx <= Math.floor(x1 / BUCKET_M); bx++) {
      for (let bz = Math.floor(z0 / BUCKET_M); bz <= Math.floor(z1 / BUCKET_M); bz++) {
        const key = bucketKey(bx, bz);
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [k]);
        else list.push(k);
        const lo = Math.min(p[a + 1]!, p[b + 1]!);
        const hi = Math.max(p[a + 1]!, p[b + 1]!);
        const h = heights.get(key);
        if (h === undefined) heights.set(key, [lo, hi]);
        else {
          h[0] = Math.min(h[0], lo);
          h[1] = Math.max(h[1], hi);
        }
      }
    }
  }
  let box: CellBox | null = null;
  const c = VOXEL_SIZE_M;
  const { up: reachUp, down: reachDown } = vertical(def);
  if (segs > 0) {
    box = {
      minX: Math.max(WORLD_CELL_MIN_XZ, Math.floor(minX / c)),
      maxX: Math.min(WORLD_CELL_MAX_XZ, Math.floor(maxX / c)),
      minZ: Math.max(WORLD_CELL_MIN_XZ, Math.floor(minZ / c)),
      maxZ: Math.min(WORLD_CELL_MAX_XZ, Math.floor(maxZ / c)),
      minY: Math.max(WORLD_CELL_MIN_Y, Math.floor((minY - reachDown) / c) - 1),
      maxY: Math.min(WORLD_CELL_MAX_Y, Math.ceil((maxY + reachUp) / c) + 1),
    };
    if (box.minX > box.maxX || box.minZ > box.maxZ || box.minY > box.maxY) box = null;
  }
  let cap: number[] | null = null;
  if (!(def.closed && n >= 3) && n >= 2) {
    // The directions at the ends from the first and last samples far enough apart to give one.
    const dir = (from: number, step: number): [number, number] => {
      for (let j = from + step; j >= 0 && j < n; j += step) {
        const dx = (p[j * 4]! - p[from * 4]!) * step;
        const dz = (p[j * 4 + 2]! - p[from * 4 + 2]!) * step;
        if (Math.hypot(dx, dz) > 1e-6) return [dx, dz];
      }
      return [0, 0];
    };
    const [sdx, sdz] = dir(0, 1);
    const [edx, edz] = dir(n - 1, -1);
    cap = [p[0]!, p[2]!, sdx, sdz, p[(n - 1) * 4]!, p[(n - 1) * 4 + 2]!, edx, edz];
  }
  const out: Course = { seg, cap, buckets, reach, box, heights };
  courses.set(def, out);
  return out;
}

/** How far above and below the course it writes or reads (metres). */
function vertical(def: SplineVoxelDefinition): { up: number; down: number } {
  return { up: Math.max(def.clear, shoulderRise(def)), down: (def.kind === 'river' ? def.depth : 0) + (def.bed?.depth ?? 0) + VOXEL_SIZE_M * 2 + shoulderRise(def) };
}

/** The chunks of the world grid the course can write or read: each bucket it crosses, over the heights there. */
function courseChunks(def: SplineVoxelDefinition, grid: ChunkGrid): ChunkCoord[] {
  const course = courseOf(def);
  if (course.box === null) return [];
  const c = VOXEL_SIZE_M;
  const s = grid.shift;
  const { up, down } = vertical(def);
  const out = new Map<string, ChunkCoord>();
  for (const [key, [lo, hi]] of course.heights) {
    const bx = Math.floor(key / 65536) - 32768;
    const bz = (key % 65536) - 32768;
    const x0 = Math.max(course.box.minX, Math.floor((bx * BUCKET_M) / c));
    const x1 = Math.min(course.box.maxX, Math.floor(((bx + 1) * BUCKET_M) / c) - 1);
    const z0 = Math.max(course.box.minZ, Math.floor((bz * BUCKET_M) / c));
    const z1 = Math.min(course.box.maxZ, Math.floor(((bz + 1) * BUCKET_M) / c) - 1);
    const y0 = Math.max(course.box.minY, Math.floor((lo - down) / c) - 1);
    const y1 = Math.min(course.box.maxY, Math.ceil((hi + up) / c) + 1);
    if (x0 > x1 || z0 > z1 || y0 > y1) continue;
    for (let cx = x0 >> s; cx <= x1 >> s; cx++) for (let cz = z0 >> s; cz <= z1 >> s; cz++) for (let cy = y0 >> s; cy <= y1 >> s; cy++) out.set(`${cx},${cy},${cz}`, { cx, cy, cz });
  }
  return [...out.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz || a.cy - b.cy);
}

/** How far a shoulder reaches up or down from the course (metres). */
const shoulderRise = (def: SplineVoxelDefinition): number => (def.shoulder === null ? 0 : def.shoulder.width * def.shoulder.slope);

/** A column's place against the course: metres from its line, its height and half width there. */
interface Near {
  d: number;
  y: number;
  half: number;
}

/** The nearest place on the course to (x, z) within its reach (false: none). */
function nearest(c: Course, x: number, z: number, out: Near): boolean {
  const list = c.buckets.get(bucketKey(Math.floor(x / BUCKET_M), Math.floor(z / BUCKET_M)));
  if (list === undefined) return false;
  const e = c.cap;
  // An open course ends square at its first and last points.
  if (e !== null && ((x - e[0]!) * e[2]! + (z - e[1]!) * e[3]! < 0 || (x - e[4]!) * e[6]! + (z - e[5]!) * e[7]! > 0)) return false;
  let best = Infinity;
  const s = c.seg;
  for (const k of list) {
    const o = k * 8;
    const ax = s[o]!;
    const az = s[o + 1]!;
    const dx = s[o + 2]! - ax;
    const dz = s[o + 3]! - az;
    const len2 = dx * dx + dz * dz;
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const px = ax + dx * u - x;
    const pz = az + dz * u - z;
    const d = Math.hypot(px, pz);
    const half = s[o + 6]! + (s[o + 7]! - s[o + 6]!) * u;
    // The nearest by distance past the edge, so a narrow segment beside a wide one does not take a column the wide one covers.
    const past = d - half;
    if (past >= best) continue;
    best = past;
    out.d = d;
    out.half = half;
    out.y = s[o + 4]! + (s[o + 5]! - s[o + 4]!) * u;
  }
  return Number.isFinite(best);
}

/** Ground the shoulders cut and fill against: not air and not liquid. */
const solid = (v: number): boolean => v !== 0 && !isMediumRole(valueRole(v));

/** One column's writes, rows ascending (cells; 0 is air). */
class Column {
  readonly rows: number[] = [];
  readonly values: number[] = [];
  put(row: number, v: number): void {
    const i = this.rows.indexOf(row);
    if (i >= 0) this.values[i] = v;
    else {
      this.rows.push(row);
      this.values.push(v);
    }
  }
  clear(): void {
    this.rows.length = 0;
    this.values.length = 0;
  }
}

function writeColumn(def: SplineVoxelDefinition, near: Near, x: number, z: number, ground: GroundReader, col: Column): void {
  const c = VOXEL_SIZE_M;
  const top = near.y / c;
  const inside = near.d <= near.half;
  const sh = def.shoulder;
  const rise = shoulderRise(def) / c;
  const row = (y: number): number => Math.floor(y);
  // The highest row the course's height reaches into.
  let topRow = Math.ceil(top) - 1;
  if (fillShapeAt(top, topRow) === 0) topRow--;
  const fillFrom = (from: number, lowest: number, line: number): void => {
    // Open cells under `line` from row `from` down to the ground (or `lowest`): filled with what they meet.
    let meet = -1;
    let r = from;
    for (; r >= lowest; r--) {
      if (solid(ground.value(x, r, z))) {
        meet = ground.value(x, r, z);
        break;
      }
    }
    const material = meet >= 0 ? valueMaterial(meet) : (def.bed?.material ?? def.material);
    const role = meet >= 0 ? valueRole(meet) : VOXEL_ROLE.terrain;
    for (let k = r + 1; k <= from; k++) {
      const shape = fillShapeAt(line, k);
      if (shape === 0) continue;
      const g = ground.value(x, k, z);
      if (solid(g) && valueShape(g) >= shape) continue;
      col.put(k, recordValue(material, role, shape, 0));
    }
  };
  if (inside) {
    let bottom: number;
    if (def.kind === 'river') {
      const floor = row(top - def.depth / c);
      for (let r = floor; r <= topRow; r++) col.put(r, liquidValue(def.material, fillShapeAt(top, r)));
      for (const b of def.bodies) {
        const dx = x * c + c / 2 - b.seed[0];
        const dz = z * c + c / 2 - b.seed[1];
        if (dx * dx + dz * dz > b.reach * b.reach) continue;
        const level = b.level / c;
        for (let r = floor; r <= topRow; r++) {
          const shape = fillShapeAt(level, r);
          if (shape > 0) col.put(r, liquidValue(b.material, shape));
        }
      }
      bottom = floor;
      if (def.bed !== null) col.put(--bottom, recordValue(def.bed.material, VOXEL_ROLE.terrain, SHAPE_FULL, 0));
    } else {
      const surfaceBottom = row(top - 1);
      for (let r = surfaceBottom; r <= topRow; r++) col.put(r, recordValue(def.material, VOXEL_ROLE.terrain, fillShapeAt(top, r), 0));
      bottom = surfaceBottom;
      const bedRows = def.bed === null ? 0 : Math.round(def.bed.depth / c);
      for (let k = 0; k < bedRows; k++) col.put(--bottom, recordValue(def.bed!.material, VOXEL_ROLE.terrain, SHAPE_FULL, 0));
    }
    // Air above the course: `clear`, or as high as the shoulders cut where they do.
    const up = Math.max(def.clear / c, rise);
    for (let r = topRow + 1; r <= Math.ceil(top + up) - 1; r++) if (ground.value(x, r, z) !== 0) col.put(r, 0);
    if (sh !== null && rise > 0) fillFrom(bottom - 1, Math.floor(top - rise), bottom);
    return;
  }
  if (sh === null) return;
  const e = (near.d - near.half) / c;
  const cut = top + e * sh.slope;
  const bank = top - e * sh.slope;
  const up = Math.max(def.clear / c, rise);
  // Cut: ground above the line rising from the edge, as high as the shoulder reaches.
  for (let r = Math.floor(cut); r <= Math.ceil(top + up) - 1; r++) {
    const g = ground.value(x, r, z);
    if (!solid(g)) continue;
    const shape = fillShapeAt(cut, r);
    if (shape === 0) col.put(r, 0);
    else if (shape < valueShape(g)) col.put(r, recordValue(valueMaterial(g), valueRole(g), shape, valueWetness(g)));
  }
  // Fill: open cells under the line falling from the edge, down to the ground or as low as the shoulder reaches.
  if (bank > top - rise) fillFrom(Math.ceil(bank) - 1, Math.floor(top - rise), bank);
}

function chunkWrites(def: SplineVoxelDefinition, grid: ChunkGrid, cx: number, cy: number, cz: number, ground: GroundReader, out: CellDelta): void {
  const course = courseOf(def);
  const b = course.box;
  if (b === null) return;
  const s = grid.shift;
  const x0 = cx << s;
  const y0 = cy << s;
  const z0 = cz << s;
  const e = grid.edge;
  if (x0 > b.maxX || x0 + e - 1 < b.minX || z0 > b.maxZ || z0 + e - 1 < b.minZ || y0 > b.maxY || y0 + e - 1 < b.minY) return;
  const near: Near = { d: 0, y: 0, half: 0 };
  const col = new Column();
  const c = VOXEL_SIZE_M;
  for (let lx = 0; lx < e; lx++) {
    for (let lz = 0; lz < e; lz++) {
      const x = x0 + lx;
      const z = z0 + lz;
      if (!nearest(course, (x + 0.5) * c, (z + 0.5) * c, near) || near.d > near.half + (def.shoulder?.width ?? 0)) continue;
      col.clear();
      writeColumn(def, near, x, z, ground, col);
      if (col.rows.length === 0) continue;
      const order = col.rows.map((r, i) => i).sort((p, q) => col.rows[p]! - col.rows[q]!);
      for (const i of order) {
        const y = col.rows[i]!;
        if (y < y0 || y >= y0 + e || !cellInWorld(x, y, z)) continue;
        out.push((((lx << s) | lz) << s) | (y - y0), col.values[i]!);
      }
    }
  }
}

/** The spline writer (world-writer.ts's contract). */
export const SPLINE_WRITER: WorldWriter<SplineVoxelDefinition> = {
  kind: 'spline',
  version: SPLINE_WRITER_VERSION,
  box: (def) => courseOf(def).box,
  chunks: courseChunks,
  chunk: chunkWrites,
};
