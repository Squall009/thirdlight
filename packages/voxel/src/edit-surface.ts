/**
 * The strokes that read more than the cell they write: a flood to a level,
 * and the brush modes that move what is there (`smooth`, `flatten`).
 *
 * Each is computed whole from the voxels as they are before the stroke
 * (every read comes before the first write), with exactly rounded
 * arithmetic, and handed back as cell writes: so the result does not depend
 * on the order cells or chunks are visited in, and the same command on the
 * same voxels gives the same voxels everywhere.
 *
 * - **Flood** is the level fill (water/level-fill.ts), the function a water
 *   body regenerates with, given the stroke's value. Its reach bounds it in
 *   every direction a fill runs: between column centres from the seed's
 *   column, and in rows under the cell it starts from, so the cells it can
 *   touch are known from the command alone.
 * - **Smooth and flatten move the ground's surface a column at a time.** A
 *   column's surface is the first ground cell under the open cells from the
 *   top of the stroke's rows; its height is that cell's row plus its fill.
 *   The stroke moves the height toward a target (the mean of the nine
 *   columns round it, or the plane) by the brush's weight over the column,
 *   inside the stroke's rows, and rewrites the fill of the cells between
 *   the old height and the new: raised cells take the surface cell's
 *   material and role, lowered ones empty. Only ground and open cells are
 *   written. A column whose first cell under the open ones is built (a
 *   floor, a wall, an opening) is left whole, and pulls no neighbour.
 * - **Smooth with a gas** relaxes that gas's density a cell at a time
 *   toward the mean of the cell and its six neighbours (air counting none;
 *   anything else, another gas included, counting as the cell itself), in
 *   air and that gas only.
 */
import { VOXEL_SIZE_M, WORLD_CELL_MAX_XZ, WORLD_CELL_MAX_Y, WORLD_CELL_MIN_XZ, WORLD_CELL_MIN_Y } from './coords';
import type { BrushEdit, FloodEdit } from './edit-command';
import { MATERIAL_ID_MAX, recordValue, SHAPE_FULL, valueMaterial, valueRole, valueShape, valueWetness } from './record';
import { isFillRole, isMediumRole } from './role-traits';
import type { CellBox } from './stroke';
import type { CellWrites } from './water/body';
import { fillStartRow, fillTopRow, levelFill, Triples, type LevelFillResult, type LevelFillSpec } from './water/level-fill';

/** A cell's record value as a stroke reads it, or the level fill's `FILL_OUTSIDE` past the world's edge. */
export type ReadCell = (x: number, y: number, z: number) => number;

/** Cells past a smoothing brush's own that it reads (the columns, or the cells, beside the ones it moves). */
export const SMOOTH_READ_MARGIN_CELLS = 1;

/** A flood's fill: the command's fields as the level fill takes them (a fade in cells; the reach also as a floor under the start row). */
export function floodSpec(cmd: FloodEdit): LevelFillSpec {
  const base: LevelFillSpec = {
    seed: cmd.seed,
    level: cmd.level,
    material: cmd.value.material,
    reach: cmd.reach,
    role: cmd.value.role,
    ...(cmd.fade !== undefined ? { fade: cmd.fade / VOXEL_SIZE_M } : {}),
  };
  const start = fillStartRow(base);
  return start === null ? base : { ...base, floor: start - Math.ceil(cmd.reach) };
}

/**
 * The cells a flood can read or write, inside the world (null: it starts
 * nowhere in the world): the reach's square and a ring of one cell round it
 * (where the fill meets its bound), from a row under its floor to the
 * highest row it fills.
 */
export function floodBox(spec: LevelFillSpec): CellBox | null {
  const start = fillStartRow(spec);
  if (start === null || spec.floor === undefined) return null;
  const r = Math.ceil(spec.reach) + 1;
  const box: CellBox = {
    minX: Math.max(WORLD_CELL_MIN_XZ, spec.seed[0] - r),
    maxX: Math.min(WORLD_CELL_MAX_XZ, spec.seed[0] + r),
    minZ: Math.max(WORLD_CELL_MIN_XZ, spec.seed[2] - r),
    maxZ: Math.min(WORLD_CELL_MAX_XZ, spec.seed[2] + r),
    minY: Math.max(WORLD_CELL_MIN_Y, spec.floor - 1),
    maxY: Math.min(WORLD_CELL_MAX_Y, fillTopRow(spec)),
  };
  return box.minY > box.maxY || start < box.minY || start > box.maxY ? null : box;
}

/** A flood's fill of the voxels `read` gives (a cell past the world's edge reads as outside: a breach). */
export function floodFill(spec: LevelFillSpec, read: ReadCell): LevelFillResult {
  return levelFill(spec, { value: read });
}

/** Collects a stroke's writes. */
class Writes {
  private readonly t = new Triples();
  private v = new Uint32Array(256);
  add(x: number, y: number, z: number, value: number): void {
    const i = this.t.count;
    if (i === this.v.length) {
      const b = new Uint32Array(this.v.length * 2);
      b.set(this.v);
      this.v = b;
    }
    this.v[i] = value;
    this.t.push(x, y, z);
  }
  done(): CellWrites {
    return { cells: this.t.a.slice(0, this.t.n), values: this.v.slice(0, this.t.count) };
  }
}

/** Visits every cell a brush covers with its coverage (0 … 1, above 0). */
export type EachCovered = (visit: (x: number, y: number, z: number, cover: number) => void) => void;

/** A brush's weight on a cell or a column it covers `cover` of: the coverage at a soft rim, else all or nothing at half. */
function weightOf(cmd: BrushEdit, cover: number): number {
  if (cmd.smooth) return cover >= 1 ? 1 : cover;
  return cover >= 0.5 ? 1 : 0;
}

/** The fill a cell of row `y` holds under a surface at height `h` (cells). */
function fillUnder(h: number, y: number): number {
  const f = h - y;
  if (f >= 1) return SHAPE_FULL;
  if (f <= 0) return 0;
  return Math.round(f * SHAPE_FULL);
}

const open = (v: number): boolean => v === 0 || (v > 0 && isMediumRole(valueRole(v)));
const ground = (v: number): boolean => v > 0 && isFillRole(valueRole(v));

/** A column as a surface stroke reads it: its ground's height and surface cell; no ground in the stroke's rows (`row` −1: it counts as their bottom); or built (null). */
interface Column {
  readonly h: number;
  readonly row: number;
  readonly value: number;
}

/**
 * The writes of a `smooth` of the ground or a `flatten` (see the module's
 * comment). `box` is the brush's own cells: the rows a surface is looked
 * for and moved in.
 */
export function surfaceWrites(cmd: BrushEdit, box: CellBox, each: EachCovered, read: ReadCell): CellWrites {
  const spanZ = box.maxZ - box.minZ + 1 + 2 * SMOOTH_READ_MARGIN_CELLS;
  const keyOf = (x: number, z: number): number => (x - box.minX + SMOOTH_READ_MARGIN_CELLS) * spanZ + (z - box.minZ + SMOOTH_READ_MARGIN_CELLS);
  // A column's weight is the most the brush covers of any of its cells.
  const weights = new Map<number, number>();
  const at = new Map<number, readonly [number, number]>();
  each((x, _y, z, cover) => {
    const w = weightOf(cmd, cover);
    if (w <= 0) return;
    const k = keyOf(x, z);
    const had = weights.get(k);
    if (had === undefined) at.set(k, [x, z]);
    if (had === undefined || w > had) weights.set(k, w);
  });
  const columns = new Map<number, Column | null>();
  const column = (x: number, z: number): Column | null => {
    const k = keyOf(x, z);
    let c = columns.get(k);
    if (c !== undefined) return c;
    c = { h: box.minY, row: -1, value: 0 };
    for (let y = box.maxY; y >= box.minY; y--) {
      const v = read(x, y, z);
      if (open(v)) continue;
      c = ground(v) ? { h: y + valueShape(v) / SHAPE_FULL, row: y, value: v } : null;
      break;
    }
    columns.set(k, c);
    return c;
  };
  const out = new Writes();
  const top = box.maxY + 1;
  // Columns in the order of their keys (x, then z), whatever order the brush's chunks gave them in.
  for (const k of [...weights.keys()].sort((a, b) => a - b)) {
    const [x, z] = at.get(k)!;
    const c = column(x, z);
    if (c === null || c.row < 0) continue;
    let target: number;
    if (cmd.mode === 'flatten') target = cmd.height!;
    else {
      let sum = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) sum += (column(x + dx, z + dz) ?? c).h;
      target = sum / 9;
    }
    const moved = c.h + weights.get(k)! * (target - c.h);
    const h = moved < box.minY ? box.minY : moved > top ? top : moved;
    if (h > c.h) {
      for (let y = Math.floor(c.h); y < h && y <= box.maxY; y++) {
        const v = read(x, y, z);
        const fill = fillUnder(h, y);
        if (ground(v)) {
          if (valueShape(v) < fill) out.add(x, y, z, recordValue(valueMaterial(v), valueRole(v), fill, valueWetness(v)));
        } else if (open(v) && fill > 0) out.add(x, y, z, recordValue(valueMaterial(c.value), valueRole(c.value), fill, valueWetness(c.value)));
      }
    } else if (h < c.h) {
      for (let y = c.row; y >= Math.floor(h) && y >= box.minY; y--) {
        const v = read(x, y, z);
        if (!ground(v)) continue;
        const fill = fillUnder(h, y);
        if (valueShape(v) > fill) out.add(x, y, z, fill === 0 ? 0 : recordValue(valueMaterial(v), valueRole(v), fill, valueWetness(v)));
      }
    }
  }
  return out.done();
}

const SIDES: readonly (readonly [number, number, number])[] = [
  [0, -1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
];

/** The writes of a `smooth` of the gas the brush's voxel names (see the module's comment). */
export function gasSmoothWrites(cmd: BrushEdit, each: EachCovered, read: ReadCell): CellWrites {
  const material = cmd.voxel!.material;
  const role = cmd.voxel!.role!;
  const own = (v: number): boolean => v > 0 && valueRole(v) === role && (v & MATERIAL_ID_MAX) === material;
  const out = new Writes();
  each((x, y, z, cover) => {
    const w = weightOf(cmd, cover);
    if (w <= 0) return;
    const v = read(x, y, z);
    if (v !== 0 && !own(v)) return;
    const d = v === 0 ? 0 : valueShape(v);
    let sum = d;
    for (const [dx, dy, dz] of SIDES) {
      const n = read(x + dx, y + dy, z + dz);
      sum += n === 0 ? 0 : own(n) ? valueShape(n) : d;
    }
    const next = Math.round(d + w * (sum / 7 - d));
    if (next !== d) out.add(x, y, z, next === 0 ? 0 : recordValue(material, role, next, 0));
  });
  return out.done();
}
