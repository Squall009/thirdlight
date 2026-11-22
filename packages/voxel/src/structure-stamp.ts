/**
 * A structure grid stamped into its world grid's derived channels: where a
 * turned (or aligned) grid stands, each world cell takes what the grid's
 * cells under it say, so the world's light walk, sun heights and open
 * regions see the structure without stepping its grid.
 *
 * The stamp is derived and never stored: it is made from the grid's
 * resident voxel records and its place, and made again when either changes
 * (prop-channel.ts holds it beside the props, one coverage byte a world
 * cell joined into the light stop, and one class a world cell for the
 * regions). What is drawn and collided with stays the grid's own, exact.
 *
 * - **A grid cell's class** comes from its record alone ({@link stampClassOfValue}):
 *   it stops light where it is a construction cell whose integrity covers
 *   half or more, or ground filled to half; it is an opening where its role
 *   is `opening`; else it is open. The derive's thin forms (a beam, a rail,
 *   a post: open there) read their neighbours, which a cell's record does
 *   not have, so a stamp counts them as stopping.
 * - **Sampling.** Each world cell in the grid's turned box is sampled at
 *   {@link PROP_SAMPLES_PER_AXIS}³ points as a prop is; each point falls in
 *   one grid cell. Yaw is about the vertical, so a column's sixteen points
 *   meet the same grid columns at every height and are turned once.
 * - **The rule** ({@link StructureStampRule}) says how the samples make the
 *   world cell. A wall one cell thick turned 30° or 45° covers a staircase of
 *   world cells, some of them by less than half; a 6-connected ray slips
 *   between two cells that touch only by an edge, so the share rule props
 *   use leaks there and the conservative rules close it. The roles rule also
 *   keeps any world cell an opening's samples reach open, so a door or a
 *   window survives the conservative fill.
 */
import type { GridFrame } from './grid-place';
import { LIGHT_STOP_COVERAGE } from './occupancy-walk';
import { PROP_SAMPLES_PER_AXIS, type PropLocalCoverage } from './prop-coverage';
import { damagedIntegrity, DENSITY_FULL, isConstructionRole, MATERIAL_AIR, valueDensity, valueMaterial, valueRole, VOXEL_ROLE } from './record';
import { integrityCoverage } from './damage-stages';

/** A grid cell's or a stamped world cell's class: open, stopping light (a body for the regions), or an opening (a portal). */
export const STAMP_CLASS = Object.freeze({ open: 0, stop: 1, opening: 2 });

/**
 * How a world cell is made from the samples of a grid's cells in it.
 * - `share`: as a prop: its coverage is the share of samples in stopping cells, so it stops at half.
 * - `quarter`: it stops from {@link STAMP_QUARTER_SAMPLES} of its samples on.
 * - `any`: one sample in a stopping cell fills it.
 * - `roles`: one sample in a stopping cell fills it unless a sample falls in an opening: then it is an opening.
 * - `majority`: one sample in a stopping cell fills it unless as many of its samples fall in an opening: then it is one.
 */
export const STRUCTURE_STAMP_RULES = Object.freeze(['share', 'quarter', 'any', 'roles', 'majority'] as const);
export type StructureStampRule = (typeof STRUCTURE_STAMP_RULES)[number];

/** Samples a world cell holds. */
const SAMPLES = PROP_SAMPLES_PER_AXIS ** 3;

/** Samples in stopping cells from which the `quarter` rule fills a world cell: a quarter of them. */
export const STAMP_QUARTER_SAMPLES = SAMPLES / 4;

/** The class of a grid cell from its record value ({@link STAMP_CLASS}). */
export function stampClassOfValue(v: number): number {
  const role = valueRole(v);
  if (role === VOXEL_ROLE.opening) return STAMP_CLASS.opening;
  if (valueMaterial(v) === MATERIAL_AIR) return STAMP_CLASS.open;
  if (isConstructionRole(role)) {
    const integrity = damagedIntegrity(v);
    return integrity === 0 || integrityCoverage(integrity) >= LIGHT_STOP_COVERAGE ? STAMP_CLASS.stop : STAMP_CLASS.open;
  }
  if (role === VOXEL_ROLE.terrain) return valueDensity(v) * 2 >= DENSITY_FULL ? STAMP_CLASS.stop : STAMP_CLASS.open;
  return STAMP_CLASS.open;
}

/** A grid's cells as a stamp reads them: a box of its cells (its frame) and one class a cell, index `(x · size[2] + z) · size[1] + y`. */
export interface GridStampCells {
  readonly lo: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly classes: Uint8Array;
}

/** A grid's cells in the box `lo` (size `size`), each cell's {@link STAMP_CLASS} read through `classAt`. */
export function gridStampCells(lo: readonly [number, number, number], size: readonly [number, number, number], classAt: (x: number, y: number, z: number) => number): GridStampCells {
  const classes = new Uint8Array(Math.max(0, size[0] * size[1] * size[2]));
  let i = 0;
  for (let x = 0; x < size[0]; x++) for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++, i++) classes[i] = classAt(lo[0] + x, lo[1] + y, lo[2] + z);
  return { lo, size, classes };
}

/** A stamp of a grid in world cells: a prop's local coverage (light) and one {@link STAMP_CLASS} a cell of the same box (regions). */
export interface StructureStampLocal extends PropLocalCoverage {
  readonly classes: Uint8Array;
}

/** The world box (metres) a grid's cell box covers where it stands. */
export function gridStampBounds(cells: Pick<GridStampCells, 'lo' | 'size'>, frame: GridFrame, cellM: number): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const gx = (cells.lo[0] + (k & 1 ? cells.size[0] : 0)) * cellM;
    const gy = (cells.lo[1] + (k & 2 ? cells.size[1] : 0)) * cellM;
    const gz = (cells.lo[2] + (k & 4 ? cells.size[2] : 0)) * cellM;
    const w = frame.toWorld(gx, gy, gz);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, w[a]!);
      max[a] = Math.max(max[a]!, w[a]!);
    }
  }
  return { min, max };
}

/** A world cell's light byte and class from its samples in stopping cells and in openings. */
function cellOf(rule: StructureStampRule, stop: number, opening: number): [number, number] {
  switch (rule) {
    case 'share': {
      const cover = Math.round((stop * 255) / SAMPLES);
      return cover >= LIGHT_STOP_COVERAGE ? [cover, STAMP_CLASS.stop] : [cover, opening > 0 ? STAMP_CLASS.opening : STAMP_CLASS.open];
    }
    case 'quarter':
      return stop >= STAMP_QUARTER_SAMPLES ? [255, STAMP_CLASS.stop] : [0, opening > 0 ? STAMP_CLASS.opening : STAMP_CLASS.open];
    case 'any':
      return stop > 0 ? [255, STAMP_CLASS.stop] : [0, opening > 0 ? STAMP_CLASS.opening : STAMP_CLASS.open];
    case 'roles':
      return opening > 0 ? [0, STAMP_CLASS.opening] : stop > 0 ? [255, STAMP_CLASS.stop] : [0, STAMP_CLASS.open];
    case 'majority':
      return opening > 0 && opening >= stop ? [0, STAMP_CLASS.opening] : stop > 0 ? [255, STAMP_CLASS.stop] : [0, STAMP_CLASS.open];
  }
}

/**
 * A grid stamped into world cells where it stands (`frame`), by `rule`: the world cells of its turned box (as
 * {@link propCellBox} makes a prop's), each sampled at {@link PROP_SAMPLES_PER_AXIS}³ points.
 */
export function stampGrid(cells: GridStampCells, frame: GridFrame, rule: StructureStampRule, cellM: number): StructureStampLocal {
  const b = gridStampBounds(cells, frame, cellM);
  const lo = [0, 1, 2].map((a) => Math.floor(b.min[a]! / cellM)) as [number, number, number];
  const size = [0, 1, 2].map((a) => Math.max(0, Math.ceil(b.max[a]! / cellM) - lo[a]!)) as [number, number, number];
  const n = size[0] * size[1] * size[2];
  const bytes = new Uint8Array(n);
  const classes = new Uint8Array(n);
  const P = PROP_SAMPLES_PER_AXIS;
  const [gx0, gy0, gz0] = cells.lo;
  const [sx, sy, sz] = cells.size;
  // The grid row index of each of a column's P² points (-1: outside the grid's box), and of each of a cell's P heights.
  const cols = new Int32Array(P * P);
  const ys = new Int32Array(size[1] * P);
  for (let y = 0; y < size[1]; y++) {
    for (let j = 0; j < P; j++) {
      const wy = (lo[1] + y + (j + 0.5) / P) * cellM;
      const gy = Math.floor((wy - frame.position[1]) / cellM) - gy0;
      ys[y * P + j] = gy >= 0 && gy < sy ? gy : -1;
    }
  }
  let covered = 0;
  for (let x = 0; x < size[0]; x++) for (let z = 0; z < size[2]; z++) {
    let any = false;
    for (let i = 0; i < P; i++) for (let k = 0; k < P; k++) {
      const q = frame.toGrid((lo[0] + x + (i + 0.5) / P) * cellM, frame.position[1], (lo[2] + z + (k + 0.5) / P) * cellM);
      const gx = Math.floor(q[0] / cellM) - gx0;
      const gz = Math.floor(q[2] / cellM) - gz0;
      const inside = gx >= 0 && gx < sx && gz >= 0 && gz < sz;
      cols[i * P + k] = inside ? (gx * sz + gz) * sy : -1;
      any ||= inside;
    }
    if (!any) continue;
    for (let y = 0; y < size[1]; y++) {
      let stop = 0;
      let opening = 0;
      for (let c = 0; c < P * P; c++) {
        const row = cols[c]!;
        if (row < 0) continue;
        for (let j = 0; j < P; j++) {
          const gy = ys[y * P + j]!;
          if (gy < 0) continue;
          const k = cells.classes[row + gy]!;
          if (k === STAMP_CLASS.stop) stop++;
          else if (k === STAMP_CLASS.opening) opening++;
        }
      }
      if (stop === 0 && opening === 0) continue;
      const [cover, cls] = cellOf(rule, stop, opening);
      const idx = (x * size[2] + z) * size[1] + y;
      bytes[idx] = cover;
      classes[idx] = cls;
      if (cover !== 0 || cls !== STAMP_CLASS.open) covered++;
    }
  }
  return { lo, size, bytes, classes, cells: covered };
}
