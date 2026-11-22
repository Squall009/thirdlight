/**
 * A building's plan: its definition laid out on the cells of its grid, once,
 * so a chunk of voxels is a few table reads a cell.
 *
 * The polygons are rasterised (a cell is inside a polygon when its middle
 * is) and joined: the building is their union, so wings that touch or
 * overlap make one building with no wall between them, and a ring of
 * polygons leaves a courtyard. Its walls are the union's cells with an
 * outside cell among their eight neighbours on the plan: one cell thick
 * along every edge, with the inner corner of an L, T or courtyard filled so
 * the wall is closed face to face (a wall joined only at a cell's edge would
 * let light and walkers through the corner).
 */
import type { CellBox } from '../stroke';
import type { StructureDefinition } from './definition';

/** No roof over this column. */
export const NO_ROOF = -0x7fffffff;

export interface BuildingPlan {
  readonly def: StructureDefinition;
  /** The plan's cells: x in [x0, x0 + w), z in [z0, z0 + d) (the union's box widened by the overhang). */
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly d: number;
  /** Rows a storey; the first row over the top storey (where a flat roof lies). */
  readonly storeyHeight: number;
  readonly top: number;
  readonly foundationDepth: number;
  /** Per column (index (x − x0) · d + (z − z0)): inside the building, a wall. */
  readonly inside: Uint8Array;
  readonly wall: Uint8Array;
  /** Per polygon, in footprint order: its own cells. */
  readonly polygons: readonly Uint8Array[];
  /** Per column: the roof's row ({@link NO_ROOF}: none), and a wall column's highest wall row. */
  readonly roofY: Int32Array;
  readonly wallTop: Int32Array;
  /** Per column outside the walls: lower roof rows of other polygons' eaves and verges under the highest. */
  readonly eaves: ReadonlyMap<number, readonly number[]>;
  /** Per column: opening rows as inclusive [y0, y1] pairs; stair step rows; floor rows left open over a stair. */
  readonly openings: ReadonlyMap<number, readonly number[]>;
  readonly steps: ReadonlyMap<number, readonly number[]>;
  readonly holes: ReadonlyMap<number, readonly number[]>;
  /** Every cell the building writes (inclusive). */
  readonly box: CellBox;
}

/** The plan's columns and the union, before roofs and features. */
export interface PlanGrid {
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly d: number;
  readonly inside: Uint8Array;
  readonly wall: Uint8Array;
  readonly polygons: Uint8Array[];
}

/** Twice the signed area of a polygon over (x, z): positive when its points run with the inside on their left. */
export function signedArea2(points: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let k = 0; k < points.length; k++) {
    const p = points[k]!;
    const q = points[(k + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/** Marks a polygon's cells (middles inside, even-odd across its edges along z) into `mask`. */
function rasterise(points: readonly (readonly [number, number])[], g: { x0: number; z0: number; w: number; d: number }, mask: Uint8Array): void {
  const n = points.length;
  const xs: number[] = [];
  for (let iz = 0; iz < g.d; iz++) {
    const zc = g.z0 + iz + 0.5;
    xs.length = 0;
    for (let k = 0; k < n; k++) {
      const a = points[k]!;
      const b = points[(k + 1) % n]!;
      if (a[0] === b[0] && Math.min(a[1], b[1]) < zc && zc < Math.max(a[1], b[1])) xs.push(a[0]);
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = xs[k]!; x < xs[k + 1]!; x++) mask[(x - g.x0) * g.d + iz] = 1;
  }
}

/** The plan's grid: each polygon's cells, their union and its walls, over the union's box widened by `margin`. */
export function planGrid(def: StructureDefinition, margin: number): PlanGrid {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of def.footprint) for (const [x, z] of p.points) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  // One cell more than the margin all round, so a wall's outside neighbour is always on the plan.
  const g = { x0: minX - margin - 1, z0: minZ - margin - 1, w: maxX - minX + 2 * margin + 2, d: maxZ - minZ + 2 * margin + 2 };
  const n = g.w * g.d;
  const inside = new Uint8Array(n);
  const polygons = def.footprint.map((p) => {
    const m = new Uint8Array(n);
    rasterise(p.points, g, m);
    for (let i = 0; i < n; i++) inside[i]! |= m[i]!;
    return m;
  });
  const wall = new Uint8Array(n);
  for (let ix = 0; ix < g.w; ix++) for (let iz = 0; iz < g.d; iz++) {
    const i = ix * g.d + iz;
    if (inside[i] === 0) continue;
    let edge = false;
    for (let ox = -1; ox <= 1 && !edge; ox++) for (let oz = -1; oz <= 1 && !edge; oz++) {
      const jx = ix + ox;
      const jz = iz + oz;
      edge = jx < 0 || jz < 0 || jx >= g.w || jz >= g.d || inside[jx * g.d + jz] === 0;
    }
    if (edge) wall[i] = 1;
  }
  return { ...g, inside, wall, polygons };
}
