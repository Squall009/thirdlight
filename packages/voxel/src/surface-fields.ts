/**
 * Fields derived from voxels: what a surface of the world is to a rule, a
 * game or a shader (how high, how steep, of what, under what), computed from
 * the voxels alone and never stored. This is the shared foundation "fields
 * derived from voxels": vegetation rules, water, fog, far placement and
 * `ctx.voxels` read these definitions and no other.
 *
 * One arithmetic, typed arrays in and out, no world state: a worker, the
 * thread a world runs on and a test run the same function on the same cells
 * and get the same bytes, at any level of the chunk tree (a cell of 0.5 m,
 * or 2 m on the far nodes: sizes in cells scale with the level, sizes in
 * metres do not).
 *
 * **Input** ({@link SurfaceCells}): a box of record values, with what stands
 * in those cells without being in them (a structure's stamp) as `built`.
 *
 * **A surface** is a cell drawn as a body (by the role traits table, with a
 * fill) whose cell above is not closed (not a body, not built): open ground,
 * a cave's floor, each storey's floor, a roof. A column has as many as it
 * has; {@link surfaceTable} lists them.
 *
 * **The fields of a surface** ({@link SurfacePoint}), at its column (x, z)
 * and row:
 * - `height` (m): the row plus the cell's fill (a block: whole), as the
 *   coarse floor and the smoothing strokes read ground.
 * - `slope` (degrees, 0 flat … 90): the angle of the height's gradient by
 *   central differences over the four columns beside it (one-sided where a
 *   side is left out). A neighbour's height is its surface nearest in row,
 *   within {@link SURFACE_SLOPE_ROWS}. A side is left out where a block
 *   stands beside the surface (a construction cell within
 *   {@link SURFACE_WALL_M} over it: the slope is the ground's, not of what
 *   is built on it), where the column holds no surface that near, and past
 *   the box's edge.
 * - `material`, `role`, `wetness`: the surface cell's own (a blend toward a
 *   neighbour's material is the shader's, not a field).
 * - `sky` (0 or 1): 1 when no closed cell stands over the surface in its
 *   column, as far up as the box reaches. A yes or no: how much sky light
 *   arrives is the light volume's to say.
 * - `waterTop` (m), `waterDepth` (m), `waterMaterial`: the liquid standing
 *   on the surface, the run of liquid cells from the cell over it up: its
 *   top (the last cell's row plus its level) and the top less the height.
 *   NaN, 0 and 0 with none.
 * - `gasBottom`, `gasTop` (m), `gasDensity` (0 … 1), `gasMaterial`: the
 *   lowest bank of gas in the open space over the surface (over its liquid):
 *   the run of cells of one gas material, its lowest cell's floor, its
 *   highest cell's top and the mean of its cells' densities as a share of
 *   the material's full density. NaN, NaN, 0 and 0 with none.
 * - `materialEdge` (m, capped at {@link SURFACE_DISTANCE_CAP_M}): the
 *   distance between column centres to the nearest column whose surface on
 *   this sheet is of another material. The cap also says "none within it".
 * - `construction` (m, capped the same): the distance to the nearest column
 *   holding a construction cell on this sheet (a block role, or a built
 *   cell); 0 on a surface that is itself a block.
 *
 * **The sheet** a distance is measured on: from a surface at `row`, a column
 * `d` columns away (the larger of its two offsets) is read within
 * {@link SURFACE_SHEET_RISE} · `d` rows of `row`: its surface nearest in
 * row there for the material; any construction cell there, or up to
 * {@link SURFACE_WALL_M} higher (what stands on the sheet). So a cave's
 * floor does not read the meadow over it nor a storey the one below, and
 * ground that climbs steeper than that leaves the sheet. It is a cone, not
 * a walk along the ground: a storey reads the ground outside from as many
 * columns away as it lies rows under it.
 *
 * **Two forms, one kernel.** {@link surfaceFieldsOf} answers one surface;
 * {@link surfaceFields} (the block form) is that function at the highest
 * surface of each column of a footprint, as arrays a column;
 * {@link surfacePoint} (the per-point form) finds the surface under a point
 * and reads only the cells the kernel reads for it.
 *
 * **What a field needs round it**: the slope the four columns beside; the
 * two distances every column within {@link surfaceDistanceCells} (16 cells
 * of 0.5 m, 4 of 2 m): the block form's footprint is given that ring
 * ({@link SURFACE_PAD_CELLS} at level 0), and a column the box does not
 * hold is read as nothing there.
 *
 * **What feeds them** ({@link SURFACE_FIELDS_FED_BY}): any change of a
 * cell, a medium's too (the water and gas fields read them). Nothing keeps
 * the fields, so nothing is derived again for them: a consumer that holds a
 * result made from a chunk column drops it when a change's parts are among
 * these, in the column or one beside it.
 */
import { VOXEL_SIZE_M } from './coords';
import { DERIVED_PART, fillLevel, SHAPE_FULL, valueMaterial, valueRole, valueShape, valueWetness } from './record';
import { BODY_ROLE, roleLookup } from './role-traits';

/** How far the two distance fields are searched, and their value where nothing lies within it (metres). */
export const SURFACE_DISTANCE_CAP_M = 8;

/** The distance fields' reach in level-0 cells: the ring of columns a footprint needs round it. */
export const SURFACE_PAD_CELLS = SURFACE_DISTANCE_CAP_M / VOXEL_SIZE_M;

/** Rows a sheet may rise or fall a column of distance (a slope of 45°). */
export const SURFACE_SHEET_RISE = 1;

/** A construction cell this far or less over a surface, in the column beside it, is a wall standing there (metres). */
export const SURFACE_WALL_M = 2;

/**
 * Rows up and down within which the surface of the column beside a surface
 * is the same ground for its slope (a step of 8 m a column at level 0);
 * past it that side is left out, as a wall is.
 */
export const SURFACE_SLOPE_ROWS = 16;

/** Cells a point may lie over its surface (open cells that hold no medium), or inside the body under it. */
export const SURFACE_SNAP_CELLS = 4;

/** A reader's answer for a cell it does not know (a chunk not loaded). */
export const SURFACE_UNKNOWN = -1;

/** The row of a column with no surface. */
export const SURFACE_NO_ROW = -0x80000000;

/** The derived parts of a change that make surface fields made before it stale: every one a field reads. */
export const SURFACE_FIELDS_FED_BY = DERIVED_PART.mesh | DERIVED_PART.shader | DERIVED_PART.liquid | DERIVED_PART.gas;

/** Whether a change feeding `parts` (an edit's answer) changes surface fields. */
export function surfaceFieldsFed(parts: number): boolean {
  return (parts & SURFACE_FIELDS_FED_BY) !== 0;
}

/** The distance fields' reach in cells of `cellM` metres. */
export function surfaceDistanceCells(cellM: number): number {
  return Math.ceil(SURFACE_DISTANCE_CAP_M / cellM);
}

/** Rows over a surface in which a block beside it is a wall, in cells of `cellM` metres (at least one). */
export function surfaceWallRows(cellM: number): number {
  return Math.max(1, Math.round(SURFACE_WALL_M / cellM));
}

/** A box of cells the fields are read from. Index `(x · sz + z) · sy + y`, as a chunk's cells. */
export interface SurfaceCells {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** The box's lowest cell, in cells of its level. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** A cell's edge in metres (0.5 at level 0, 2 on the far nodes). */
  readonly cellM: number;
  /** Record values. */
  readonly values: Uint32Array;
  /**
   * 1 where something stands in a cell that is not in these voxels (a
   * structure's stamp that stops): the cell is closed (no surface under it,
   * no sky through it) and counts as construction; it is never a surface
   * itself (its own grid answers for it).
   */
  readonly built?: Uint8Array | null;
}

/** A box's surfaces and construction cells by column, and what the distance search skips by. */
export interface SurfaceTable {
  readonly cells: SurfaceCells;
  /** Column `c`'s surface rows (box rows, ascending) are `rows[start[c] … start[c + 1])`. */
  readonly start: Uint32Array;
  readonly rows: Int32Array;
  /** Column `c`'s runs of construction cells are the pairs (first row, last row) `runs[2 · runStart[c] … 2 · runStart[c + 1])`. */
  readonly runStart: Uint32Array;
  readonly runs: Int32Array;
  /** Made at the first distance asked: per column, the squared distance (cells) to the nearest column that may hold another material's surface, and to the nearest holding construction; each at most the true one. */
  bounds: { readonly reach: number; readonly edge: Uint16Array; readonly built: Uint16Array } | null;
}

/** One surface's fields. */
export interface SurfacePoint {
  /** The surface cell's row, in cells of its level (not the box's). */
  row: number;
  height: number;
  slope: number;
  material: number;
  role: number;
  wetness: number;
  sky: number;
  waterTop: number;
  waterDepth: number;
  waterMaterial: number;
  gasBottom: number;
  gasTop: number;
  gasDensity: number;
  gasMaterial: number;
  /** NaN when the distances were not asked for. */
  materialEdge: number;
  construction: number;
}

/** A point's fields, to be written into. */
export function surfacePointOut(): SurfacePoint {
  return { row: SURFACE_NO_ROW, height: Number.NaN, slope: 0, material: 0, role: 0, wetness: 0, sky: 0, waterTop: Number.NaN, waterDepth: 0, waterMaterial: 0, gasBottom: Number.NaN, gasTop: Number.NaN, gasDensity: 0, gasMaterial: 0, materialEdge: Number.NaN, construction: Number.NaN };
}

const LIQUID = roleLookup((t) => t.medium === 'liquid');
const GAS = roleLookup((t) => t.medium === 'gas');
const MEDIUM = roleLookup((t) => t.medium !== 'none');
const BLOCK = roleLookup((t) => t.shape === 'integrity');

/** Whether a value is drawn as a body: what a surface is the top of. */
function isBody(v: number): boolean {
  return valueMaterial(v) !== 0 && BODY_ROLE[valueRole(v)] === 1 && valueShape(v) !== 0;
}

class Grow {
  a = new Int32Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/** A box's surfaces and construction runs, a column at a time. */
export function surfaceTable(cells: SurfaceCells): SurfaceTable {
  const { sx, sy, sz, values } = cells;
  if (values.length !== sx * sy * sz) throw new RangeError(`surface cells: ${values.length} values for a box of ${sx} × ${sy} × ${sz}`);
  const built = cells.built ?? null;
  if (built !== null && built.length !== values.length) throw new RangeError('surface cells: built cells of another box');
  const cols = sx * sz;
  const start = new Uint32Array(cols + 1);
  const runStart = new Uint32Array(cols + 1);
  const rows = new Grow();
  const runs = new Grow();
  for (let c = 0; c < cols; c++) {
    const base = c * sy;
    let below = false;
    let run = -1;
    for (let y = 0; y < sy; y++) {
      const v = values[base + y]!;
      const body = v !== 0 && isBody(v);
      const stamp = built !== null && built[base + y] === 1;
      if (below && !body && !stamp) rows.push(y - 1);
      below = body;
      const block = stamp || (body && BLOCK[valueRole(v)] === 1);
      if (block && run < 0) run = y;
      else if (!block && run >= 0) {
        runs.push(run);
        runs.push(y - 1);
        run = -1;
      }
      // Runs of one value are the rule (rock, air), and nothing changes inside one: on to its last cell.
      if (built === null) while (y + 1 < sy && values[base + y + 1] === v) y++;
    }
    if (below) rows.push(sy - 1);
    if (run >= 0) {
      runs.push(run);
      runs.push(sy - 1);
    }
    start[c + 1] = rows.n;
    runStart[c + 1] = runs.n >> 1;
  }
  return { cells, start, rows: rows.a.slice(0, rows.n), runStart, runs: runs.a.slice(0, runs.n), bounds: null };
}

/** A column's highest surface (box row), or {@link SURFACE_NO_ROW}. */
export function surfaceTop(t: SurfaceTable, x: number, z: number): number {
  const c = x * t.cells.sz + z;
  const e = t.start[c + 1]!;
  return e === t.start[c]! ? SURFACE_NO_ROW : t.rows[e - 1]!;
}

/** A column's surface rows (box rows, ascending): what a consumer asks {@link surfaceFieldsOf} of, each storey in turn. */
export function surfaceRows(t: SurfaceTable, x: number, z: number): Int32Array {
  const c = x * t.cells.sz + z;
  return t.rows.subarray(t.start[c]!, t.start[c + 1]!);
}

/** A column's surface nearest in row to `row` within `band` rows (the lower of two as near), or {@link SURFACE_NO_ROW}. */
function nearestSurface(t: SurfaceTable, c: number, row: number, band: number): number {
  let best = SURFACE_NO_ROW;
  let bestD = band + 1;
  for (let i = t.start[c]!, e = t.start[c + 1]!; i < e; i++) {
    const r = t.rows[i]!;
    const d = r < row ? row - r : r - row;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Whether a column holds a construction cell in rows `lo … hi`. */
function builtInRows(t: SurfaceTable, c: number, lo: number, hi: number): boolean {
  for (let i = t.runStart[c]! * 2, e = t.runStart[c + 1]! * 2; i < e; i += 2) if (t.runs[i]! <= hi && t.runs[i + 1]! >= lo) return true;
  return false;
}

/** The height (metres) of the surface at box row `row` of column `c`. */
function heightOf(t: SurfaceTable, c: number, row: number): number {
  const s = t.cells;
  const v = s.values[c * s.sy + row]!;
  return (s.oy + row + fillLevel(valueRole(v), valueShape(v)) / SHAPE_FULL) * s.cellM;
}

/** The height of the ground beside a surface, a column over (NaN: that side is left out). */
function sideHeight(t: SurfaceTable, x: number, z: number, row: number, wall: number): number {
  const s = t.cells;
  if (x < 0 || z < 0 || x >= s.sx || z >= s.sz) return Number.NaN;
  const c = x * s.sz + z;
  if (builtInRows(t, c, row + 1, row + wall)) return Number.NaN;
  const r = nearestSurface(t, c, row, SURFACE_SLOPE_ROWS);
  return r === SURFACE_NO_ROW ? Number.NaN : heightOf(t, c, r);
}

/** A slope along one axis from the heights either side (NaN: none there). */
function gradient(h: number, lo: number, hi: number, cellM: number): number {
  const a = !Number.isNaN(lo);
  const b = !Number.isNaN(hi);
  if (a && b) return (hi - lo) / (2 * cellM);
  if (b) return (hi - h) / cellM;
  if (a) return (h - lo) / cellM;
  return 0;
}

/**
 * Per column, the squared distance in cells (capped past `reach`) to the
 * nearest column `mark` holds for: along z first, then the least of the
 * squares along x.
 */
function nearestMarked(mark: Uint8Array, sx: number, sz: number, reach: number): Uint16Array {
  const far = reach + 1;
  const along = new Uint8Array(sx * sz);
  for (let x = 0; x < sx; x++) {
    const b = x * sz;
    let d = far;
    for (let z = 0; z < sz; z++) {
      d = mark[b + z] === 1 ? 0 : Math.min(far, d + 1);
      along[b + z] = d;
    }
    d = far;
    for (let z = sz - 1; z >= 0; z--) {
      d = mark[b + z] === 1 ? 0 : Math.min(far, d + 1);
      if (d < along[b + z]!) along[b + z] = d;
    }
  }
  const out = new Uint16Array(sx * sz);
  const cap = far * far;
  for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
    let best = cap;
    const x0 = Math.max(0, x - reach);
    const x1 = Math.min(sx - 1, x + reach);
    for (let u = x0; u <= x1; u++) {
      const a = along[u * sz + z]!;
      if (a === far) continue;
      const d2 = (u - x) * (u - x) + a * a;
      if (d2 < best) best = d2;
    }
    out[x * sz + z] = best;
  }
  return out;
}

const MIXED = 0xffff;

/**
 * What lets the distance search skip rings: a column can hold another
 * material's surface only at or past the nearest column whose surfaces are
 * not all of one material or differ from a column's beside it (the nearest
 * column of another material has, toward the asker, a neighbour that is
 * not), and construction only at or past the nearest column holding any.
 */
function distanceBounds(t: SurfaceTable, reach: number): NonNullable<SurfaceTable['bounds']> {
  if (t.bounds !== null && t.bounds.reach === reach) return t.bounds;
  const s = t.cells;
  const { sx, sy, sz } = s;
  const cols = sx * sz;
  // A column's one surface material, 0 with no surface, MIXED with more than one.
  const kind = new Uint16Array(cols);
  for (let c = 0; c < cols; c++) {
    let k = 0;
    for (let i = t.start[c]!, e = t.start[c + 1]!; i < e; i++) {
      const m = valueMaterial(s.values[c * sy + t.rows[i]!]!);
      k = k === 0 || k === m ? m : MIXED;
    }
    kind[c] = k;
  }
  const edge = new Uint8Array(cols);
  const built = new Uint8Array(cols);
  for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) {
    const c = x * sz + z;
    const k = kind[c]!;
    if (k === MIXED || (x > 0 && kind[c - sz] !== k) || (x < sx - 1 && kind[c + sz] !== k) || (z > 0 && kind[c - 1] !== k) || (z < sz - 1 && kind[c + 1] !== k)) edge[c] = 1;
    if (t.runStart[c + 1]! > t.runStart[c]!) built[c] = 1;
  }
  t.bounds = { reach, edge: nearestMarked(edge, sx, sz, reach), built: nearestMarked(built, sx, sz, reach) };
  return t.bounds;
}

/** The first ring (columns `d` away by their larger offset) that can hold a column at squared distance `d2`. */
function firstRing(d2: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(d2 / 2) - 1e-9));
}

/**
 * The fields of the surface at box row `row` of column (x, z) of a table's
 * box, into `out`. `distances`: also the two distance fields (the search of
 * the columns round it; NaN without).
 */
export function surfaceFieldsOf(t: SurfaceTable, x: number, z: number, row: number, distances: boolean, out: SurfacePoint): SurfacePoint {
  const s = t.cells;
  const { sx, sy, sz, values, cellM } = s;
  const built = s.built ?? null;
  const c = x * sz + z;
  const base = c * sy;
  const v = values[base + row]!;
  const material = valueMaterial(v);
  const h = heightOf(t, c, row);
  out.row = s.oy + row;
  out.height = h;
  out.material = material;
  out.role = valueRole(v);
  out.wetness = valueWetness(v);

  const wall = surfaceWallRows(cellM);
  const gx = gradient(h, sideHeight(t, x - 1, z, row, wall), sideHeight(t, x + 1, z, row, wall), cellM);
  const gz = gradient(h, sideHeight(t, x, z - 1, row, wall), sideHeight(t, x, z + 1, row, wall), cellM);
  out.slope = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;

  // The liquid standing on the surface.
  let y = row + 1;
  let top = -1;
  for (; y < sy; y++) {
    const w = values[base + y]!;
    if (w === 0 || LIQUID[valueRole(w)] !== 1 || (built !== null && built[base + y] === 1)) break;
    top = y;
  }
  if (top < 0) {
    out.waterTop = Number.NaN;
    out.waterDepth = 0;
    out.waterMaterial = 0;
  } else {
    const w = values[base + top]!;
    out.waterTop = (s.oy + top + fillLevel(valueRole(w), valueShape(w)) / SHAPE_FULL) * cellM;
    out.waterDepth = Math.max(0, out.waterTop - h);
    out.waterMaterial = valueMaterial(values[base + row + 1]!);
  }
  // The lowest bank of gas in the open space over it, and whether anything closes that space.
  out.gasBottom = Number.NaN;
  out.gasTop = Number.NaN;
  out.gasDensity = 0;
  out.gasMaterial = 0;
  out.sky = 1;
  for (; y < sy; y++) {
    const w = values[base + y]!;
    if (w === 0 && built === null) continue;
    if ((built !== null && built[base + y] === 1) || (w !== 0 && isBody(w))) {
      out.sky = 0;
      break;
    }
    if (out.gasMaterial !== 0 || w === 0 || GAS[valueRole(w)] !== 1) continue;
    const m = valueMaterial(w);
    let sum = 0;
    let n = 0;
    let g = y;
    for (; g < sy; g++) {
      const u = values[base + g]!;
      if (u === 0 || GAS[valueRole(u)] !== 1 || valueMaterial(u) !== m || (built !== null && built[base + g] === 1)) break;
      sum += valueShape(u);
      n++;
    }
    out.gasMaterial = m;
    out.gasBottom = (s.oy + y) * cellM;
    out.gasTop = (s.oy + g) * cellM;
    out.gasDensity = sum / (n * SHAPE_FULL);
    y = g - 1;
  }

  if (!distances) {
    out.materialEdge = Number.NaN;
    out.construction = Number.NaN;
    return out;
  }
  const reach = surfaceDistanceCells(cellM);
  const cap2 = reach * reach;
  const far = cap2 + 1;
  const b = distanceBounds(t, reach);
  let edge2 = far;
  let built2 = BLOCK[out.role] === 1 ? 0 : far;
  // Where a search can first find anything; past the reach, nowhere.
  const edgeFrom = b.edge[c]! > cap2 ? reach + 1 : firstRing(b.edge[c]!);
  const builtFrom = built2 === 0 || b.built[c]! > cap2 ? reach + 1 : firstRing(b.built[c]!);
  for (let d = Math.min(edgeFrom, builtFrom); d <= reach; d++) {
    // A ring's nearest column is d away: nothing nearer than what is found is left.
    const wantEdge = d >= edgeFrom && edge2 > d * d;
    const wantBuilt = d >= builtFrom && built2 > d * d;
    if (!wantEdge && !wantBuilt) {
      if ((edgeFrom > reach || edge2 <= d * d) && (builtFrom > reach || built2 <= d * d)) break;
      continue;
    }
    const band = SURFACE_SHEET_RISE * d;
    for (let dx = -d; dx <= d; dx++) {
      const u = x + dx;
      if (u < 0 || u >= sx) continue;
      const onSide = dx === -d || dx === d;
      for (let dz = -d; dz <= d; dz += onSide ? 1 : 2 * d) {
        const w = z + dz;
        if (w < 0 || w >= sz) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > cap2) continue;
        const k = u * sz + w;
        if (wantBuilt && d2 < built2 && builtInRows(t, k, row - band, row + band + wall)) built2 = d2;
        if (wantEdge && d2 < edge2) {
          const r = nearestSurface(t, k, row, band);
          if (r !== SURFACE_NO_ROW && valueMaterial(values[k * sy + r]!) !== material) edge2 = d2;
        }
      }
    }
  }
  out.materialEdge = edge2 > cap2 ? SURFACE_DISTANCE_CAP_M : Math.sqrt(edge2) * cellM;
  out.construction = built2 > cap2 ? SURFACE_DISTANCE_CAP_M : Math.sqrt(built2) * cellM;
  return out;
}

/** The block form's result: one value a column of the footprint, index `x · d + z` (x and z from the footprint's corner). */
export interface SurfaceFieldColumns {
  /** The footprint's corner and size, in cells of its level, and a cell's edge in metres. */
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly cellM: number;
  /** The surface cell's row in cells of its level ({@link SURFACE_NO_ROW}: the column holds no surface; every other field is then as {@link surfacePointOut} gives it, the distances at their cap). */
  readonly row: Int32Array;
  readonly height: Float32Array;
  readonly slope: Float32Array;
  readonly material: Uint16Array;
  readonly role: Uint8Array;
  readonly wetness: Uint8Array;
  readonly sky: Uint8Array;
  readonly waterTop: Float32Array;
  readonly waterDepth: Float32Array;
  readonly waterMaterial: Uint16Array;
  readonly gasBottom: Float32Array;
  readonly gasTop: Float32Array;
  readonly gasDensity: Float32Array;
  readonly gasMaterial: Uint16Array;
  readonly materialEdge: Float32Array;
  readonly construction: Float32Array;
}

/** The names of a block result's arrays, in the order they are compared and moved. */
export const SURFACE_FIELD_NAMES = Object.freeze(['row', 'height', 'slope', 'material', 'role', 'wetness', 'sky', 'waterTop', 'waterDepth', 'waterMaterial', 'gasBottom', 'gasTop', 'gasDensity', 'gasMaterial', 'materialEdge', 'construction'] as const);

/** A field's name. */
export type SurfaceFieldName = (typeof SURFACE_FIELD_NAMES)[number];

/** A block result's buffers, for a worker's reply. */
export function surfaceFieldsTransfer(f: SurfaceFieldColumns, out: ArrayBuffer[] = []): ArrayBuffer[] {
  for (const n of SURFACE_FIELD_NAMES) out.push(f[n].buffer as ArrayBuffer);
  return out;
}

/** The footprint a block form answers: columns of the box, from (x, z) (box columns), w × d of them. */
export interface SurfaceFootprint {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
}

/**
 * The block form: the fields of the highest surface of each column of a
 * footprint of a box (the whole box when none is named; the distances are
 * whole only where the box reaches {@link surfaceDistanceCells} past the
 * footprint).
 */
export function surfaceFields(cells: SurfaceCells, footprint?: SurfaceFootprint, table: SurfaceTable = surfaceTable(cells)): SurfaceFieldColumns {
  const f = footprint ?? { x: 0, z: 0, w: cells.sx, d: cells.sz };
  if (![f.x, f.z, f.w, f.d].every(Number.isInteger) || f.x < 0 || f.z < 0 || f.w < 1 || f.d < 1 || f.x + f.w > cells.sx || f.z + f.d > cells.sz) throw new RangeError('surface fields: a footprint outside its box');
  const n = f.w * f.d;
  const o: SurfaceFieldColumns = {
    x: cells.ox + f.x,
    z: cells.oz + f.z,
    w: f.w,
    d: f.d,
    cellM: cells.cellM,
    row: new Int32Array(n),
    height: new Float32Array(n),
    slope: new Float32Array(n),
    material: new Uint16Array(n),
    role: new Uint8Array(n),
    wetness: new Uint8Array(n),
    sky: new Uint8Array(n),
    waterTop: new Float32Array(n),
    waterDepth: new Float32Array(n),
    waterMaterial: new Uint16Array(n),
    gasBottom: new Float32Array(n),
    gasTop: new Float32Array(n),
    gasDensity: new Float32Array(n),
    gasMaterial: new Uint16Array(n),
    materialEdge: new Float32Array(n),
    construction: new Float32Array(n),
  };
  const p = surfacePointOut();
  const none = surfacePointOut();
  none.materialEdge = SURFACE_DISTANCE_CAP_M;
  none.construction = SURFACE_DISTANCE_CAP_M;
  for (let i = 0; i < f.w; i++) for (let k = 0; k < f.d; k++) {
    const row = surfaceTop(table, f.x + i, f.z + k);
    const q = row === SURFACE_NO_ROW ? none : surfaceFieldsOf(table, f.x + i, f.z + k, row, true, p);
    const j = i * f.d + k;
    for (const name of SURFACE_FIELD_NAMES) o[name][j] = q[name];
  }
  return o;
}

/** What the per-point form reads a world through. */
export interface SurfaceSource {
  /** A cell's edge in metres. */
  readonly cellM: number;
  /** A cell's record value, or {@link SURFACE_UNKNOWN} where it is not known (not loaded). */
  value(x: number, y: number, z: number): number;
  /** Whether something stands in a cell that is not in these voxels ({@link SurfaceCells.built}). */
  built?(x: number, y: number, z: number): boolean;
  /** The highest row of column (x, z) that can hold anything (the top of what is loaded over it): nothing is read above. */
  top(x: number, z: number): number;
}

/**
 * The surface under a point's cell (x, y, z), as a row: the cell itself or
 * the body's top over it when the point is inside a body (at most
 * {@link SURFACE_SNAP_CELLS} up), else the first body under it (at most as
 * many open cells down; cells holding a medium are passed and not counted,
 * so a point in water reads its bed). {@link SURFACE_NO_ROW}: none there
 * (or a built cell: another grid's to answer); null: a cell needed is not
 * known.
 */
export function surfaceRowUnder(src: SurfaceSource, x: number, y: number, z: number): number | null {
  const at = (r: number): number => (src.built?.(x, r, z) === true ? -2 : src.value(x, r, z));
  let v = at(y);
  if (v === SURFACE_UNKNOWN) return null;
  if (v === -2) return SURFACE_NO_ROW;
  if (v !== 0 && isBody(v)) {
    for (let r = y, n = 0; n <= SURFACE_SNAP_CELLS; r++, n++) {
      const up = at(r + 1);
      if (up === SURFACE_UNKNOWN) return null;
      if (up === -2) return SURFACE_NO_ROW;
      if (up === 0 || !isBody(up)) return r;
    }
    return SURFACE_NO_ROW;
  }
  let open = MEDIUM[valueRole(v)] === 1 && v !== 0 ? 0 : 1;
  for (let r = y - 1; open <= SURFACE_SNAP_CELLS; r--) {
    v = at(r);
    if (v === SURFACE_UNKNOWN) return null;
    if (v === -2) return SURFACE_NO_ROW;
    if (v !== 0 && isBody(v)) return r;
    if (v === 0 || MEDIUM[valueRole(v)] !== 1) open++;
  }
  return SURFACE_NO_ROW;
}

/**
 * The cells the kernel reads for the surface at `row` of column (x, z), as a
 * box round it: its own column up to the source's top, the four columns
 * beside it, and with `distances` every column within the reach, each in
 * the rows its distance lets the sheet lie in. Cells it never reads are
 * left as air. Null where a cell needed is not known.
 */
export function gatherSurfaceCells(src: SurfaceSource, x: number, z: number, row: number, distances: boolean): SurfaceCells | null {
  const cellM = src.cellM;
  const reach = distances ? surfaceDistanceCells(cellM) : 1;
  const wall = surfaceWallRows(cellM);
  const side = 2 * reach + 1;
  const top = Math.max(row + 1, src.top(x, z));
  // Beside the surface the slope reads a wall's rows and the nearest surface, looked for this far up and down.
  const near = Math.max(SURFACE_SLOPE_ROWS, SURFACE_SHEET_RISE + wall);
  const lo = row - Math.max(near, SURFACE_SHEET_RISE * reach);
  const hi = Math.max(top, row + Math.max(near, SURFACE_SHEET_RISE * reach + wall) + 1);
  const sy = hi - lo + 1;
  const values = new Uint32Array(side * side * sy);
  let built: Uint8Array | null = null;
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
    const d = Math.max(Math.abs(dx), Math.abs(dz));
    // Without the distances only the four columns beside the surface are read.
    if (!distances && dx !== 0 && dz !== 0) continue;
    const band = d <= 1 ? near : SURFACE_SHEET_RISE * d;
    const y0 = row - band;
    // A surface is known by the cell over it (one row more); what stands on the sheet is read a wall's height over it.
    const y1 = d === 0 ? hi : row + band + (d <= 1 ? 1 : Math.max(1, wall));
    const base = ((dx + reach) * side + (dz + reach)) * sy - lo;
    for (let y = d === 0 ? row : y0; y <= y1; y++) {
      const v = src.value(x + dx, y, z + dz);
      if (v === SURFACE_UNKNOWN) return null;
      values[base + y] = v;
      if (src.built?.(x + dx, y, z + dz) === true) (built ??= new Uint8Array(values.length))[base + y] = 1;
    }
  }
  return { sx: side, sy, sz: side, ox: x - reach, oy: lo, oz: z - reach, cellM, values, built };
}

/**
 * The per-point form: the fields of the surface under the cell (x, y, z)
 * of a world read through `src` ({@link surfaceRowUnder}), into `out`.
 * False: no surface there; null: a cell needed is not known.
 */
export function surfacePoint(src: SurfaceSource, x: number, y: number, z: number, distances: boolean, out: SurfacePoint): boolean | null {
  const row = surfaceRowUnder(src, x, y, z);
  if (row === null) return null;
  if (row === SURFACE_NO_ROW) return false;
  const cells = gatherSurfaceCells(src, x, z, row, distances);
  if (cells === null) return null;
  const reach = (cells.sx - 1) / 2;
  surfaceFieldsOf(surfaceTable(cells), reach, reach, row - cells.oy, distances, out);
  return true;
}

/** A box of cells as the per-point form's source (what a test, or a consumer holding a block, asks a point of). */
export function surfaceCellsSource(cells: SurfaceCells): SurfaceSource {
  const { sx, sy, sz, ox, oy, oz, values } = cells;
  const built = cells.built ?? null;
  const index = (x: number, y: number, z: number): number => {
    const lx = x - ox;
    const ly = y - oy;
    const lz = z - oz;
    return lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz ? -1 : (lx * sz + lz) * sy + ly;
  };
  return {
    cellM: cells.cellM,
    value: (x, y, z) => {
      const i = index(x, y, z);
      return i < 0 ? 0 : values[i]!;
    },
    ...(built === null ? {} : { built: (x: number, y: number, z: number) => {
      const i = index(x, y, z);
      return i >= 0 && built[i] === 1;
    } }),
    top: () => oy + sy - 1,
  };
}
