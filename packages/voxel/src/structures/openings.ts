/**
 * Where an opening stands in its structure's grid, the standard sizes the
 * editor offers, and the rule a prop (a door leaf, a pane, a shutter) fits
 * an opening by.
 *
 * An opening is the wall cells along a polygon's edge, one row of the wall
 * thick, from `sill` rows over its storey's floor for `height` rows (the
 * building generator writes them as `opening` cells). Its frame is what a
 * prop standing in it is placed by: the middle of its width and of the
 * wall's thickness, at its bottom (the sill), turned so that a prop's own
 * +x runs along the wall and its +z faces out of the building.
 */
import { VOXEL_SIZE_M } from '../coords';
import type { StructureDefinition, StructureOpening } from './definition';
import { signedArea2 } from './building-plan';

/** An opening's cells in its grid: the wall columns it takes, its rows, and which way is out. */
export interface OpeningCells {
  /** The wall cells' columns (x, z), from the edge's start. */
  readonly columns: readonly (readonly [number, number])[];
  /** The cell just outside each column (x, z), the same order. */
  readonly outside: readonly (readonly [number, number])[];
  /** Its rows, inclusive. */
  readonly y0: number;
  readonly y1: number;
  /** The box of its cells, inclusive (grid cells). */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** The wall runs along x or z. */
  readonly along: 'x' | 'z';
  /** Out of the building, a unit step on x or z. */
  readonly out: readonly [number, number];
}

/** An opening's cells by its polygon's edge (null: its polygon or edge does not exist). The plan's checks are the generator's. */
export function openingCells(def: StructureDefinition, o: StructureOpening): OpeningCells | null {
  const poly = def.footprint.find((p) => p.id === o.polygon);
  if (poly === undefined || o.edge >= poly.points.length) return null;
  const pts = poly.points;
  const a = pts[o.edge]!;
  const b = pts[(o.edge + 1) % pts.length]!;
  const alongX = a[1] === b[1];
  const step = alongX ? Math.sign(b[0] - a[0]) : Math.sign(b[1] - a[1]);
  // The inside lies on the edge's left when the polygon's points run anticlockwise over (x, z).
  const left = signedArea2(pts) > 0 ? 1 : -1;
  const inward = alongX ? left * step : -left * step;
  const across = alongX ? a[1] : a[0];
  const inCell = inward > 0 ? across : across - 1;
  const outCell = inward > 0 ? across - 1 : across;
  const columns: [number, number][] = [];
  const outside: [number, number][] = [];
  for (let j = o.at; j < o.at + o.width; j++) {
    const at = step > 0 ? (alongX ? a[0] : a[1]) + j : (alongX ? a[0] : a[1]) - 1 - j;
    columns.push(alongX ? [at, inCell] : [inCell, at]);
    outside.push(alongX ? [at, outCell] : [outCell, at]);
  }
  const y0 = o.storey * def.storeyHeight + 1 + o.sill;
  const y1 = y0 + o.height - 1;
  const xs = columns.map((c) => c[0]);
  const zs = columns.map((c) => c[1]);
  const out: [number, number] = alongX ? [0, -inward] : [-inward, 0];
  return { columns, outside, y0, y1, min: [Math.min(...xs), y0, Math.min(...zs)], max: [Math.max(...xs), y1, Math.max(...zs)], along: alongX ? 'x' : 'z', out };
}

/** Where a prop stands in an opening, in its structure's own frame (metres from the grid's cell 0 corner). */
export interface OpeningFrame {
  /** The middle of its width and of the wall's thickness, at its bottom. */
  readonly position: readonly [number, number, number];
  /** The turn about +y that takes a prop's +x along the wall and its +z out of the building (radians). */
  readonly yawRad: number;
  /** Its size in metres: along the wall, up, through the wall (one cell). */
  readonly size: readonly [number, number, number];
}

/** An opening's frame (null: its polygon or edge does not exist). */
export function openingFrame(def: StructureDefinition, o: StructureOpening): OpeningFrame | null {
  const c = openingCells(def, o);
  if (c === null) return null;
  const m = VOXEL_SIZE_M;
  const position: [number, number, number] = [((c.min[0] + c.max[0] + 1) / 2) * m, c.y0 * m, ((c.min[2] + c.max[2] + 1) / 2) * m];
  return { position, yawRad: Math.atan2(c.out[0], c.out[1]), size: [o.width * m, o.height * m, m] };
}

/** A standard opening size: what it is, its width and height and its sill, in cells. */
export interface OpeningSize {
  readonly kind: 'door' | 'window';
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly sill: number;
}

/**
 * The sizes the structure mode offers, in 0.5 m cells: doors of 1 × 2 m (a single door), 1.5 × 2 m (a wide one) and
 * 2 × 2.5 m (a double door or a gate under a 3 m storey's 2.5 m of room), and windows of 1 × 1 m, 1 × 1.5 m and
 * 2 × 1 m with a 1 m sill (the height of a table, so a window starts over furniture). Each fits a storey of the
 * default height (6 cells: 5 rows between floors). Other sizes are set in cells.
 */
export const OPENING_SIZES: readonly OpeningSize[] = Object.freeze([
  { kind: 'door', label: 'Door 1 × 2 m', width: 2, height: 4, sill: 0 },
  { kind: 'door', label: 'Door 1.5 × 2 m', width: 3, height: 4, sill: 0 },
  { kind: 'door', label: 'Door 2 × 2.5 m', width: 4, height: 5, sill: 0 },
  { kind: 'window', label: 'Window 1 × 1 m', width: 2, height: 2, sill: 2 },
  { kind: 'window', label: 'Window 1 × 1.5 m', width: 2, height: 3, sill: 2 },
  { kind: 'window', label: 'Window 2 × 1 m', width: 4, height: 2, sill: 2 },
].map((s) => Object.freeze(s)) as OpeningSize[]);

/**
 * How much a prop's bounds may pass its opening by and still fit (metres, each axis): a model's bounds are measured
 * from its vertices, and a leaf made to the opening's size comes out a few millimetres over it.
 */
export const OPENING_PROP_FIT_TOLERANCE_M = 0.05;

/**
 * Whether a prop of `size` (its bounds in its own frame, metres: x along the wall, y up, z through it) fits an
 * opening: no wider and no taller than the opening, no deeper than one cell (the wall's thickness), each within
 * {@link OPENING_PROP_FIT_TOLERANCE_M}. A prop that fits stands inside the opening's cells.
 */
export function propFitsOpening(size: readonly [number, number, number], o: Pick<StructureOpening, 'width' | 'height'>): boolean {
  const t = OPENING_PROP_FIT_TOLERANCE_M;
  return size[0] <= o.width * VOXEL_SIZE_M + t && size[1] <= o.height * VOXEL_SIZE_M + t && size[2] <= VOXEL_SIZE_M + t;
}

/** A turn about +y as a quaternion [x, y, z, w]. */
export function yawQuaternion(yawRad: number): [number, number, number, number] {
  return [0, Math.sin(yawRad / 2), 0, Math.cos(yawRad / 2)];
}

/**
 * A prop's local transform (in its structure's frame) when it moves with its opening from frame `from` to frame
 * `to`: it keeps where it stood relative to the opening's frame (so a leaf centred in its opening stays centred, a
 * leaf a designer nudged keeps its nudge).
 */
export function followOpening(
  t: { readonly position: readonly number[]; readonly rotation: readonly number[] },
  from: OpeningFrame,
  to: OpeningFrame,
): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const d = to.yawRad - from.yawRad;
  const c = Math.cos(d);
  const s = Math.sin(d);
  const px = t.position[0]! - from.position[0];
  const pz = t.position[2]! - from.position[2];
  // R(d) about +y: x' = c x + s z, z' = −s x + c z.
  const position: [number, number, number] = [to.position[0] + c * px + s * pz, to.position[1] + (t.position[1]! - from.position[1]), to.position[2] - s * px + c * pz];
  const q = yawQuaternion(d);
  const [x, y, z, w] = [t.rotation[0]!, t.rotation[1]!, t.rotation[2]!, t.rotation[3]!];
  // q ⊗ r (the turn applied after the prop's own).
  const rotation: [number, number, number, number] = [q[3] * x + q[1] * z, q[3] * y + q[1] * w, q[3] * z - q[1] * x, q[3] * w - q[1] * y];
  return { position, rotation };
}
