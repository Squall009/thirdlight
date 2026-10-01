/**
 * The surface of a block layer: the corner heights of sloped cells, the
 * height, normal and slope of any block's top at a point, and the ground
 * under a point (walking down a column). The mesher warps a sloped cell's
 * look with the same corner maths, the collision triangles come from that
 * mesh, and `ctx.grid`'s surface queries and the editor's height brushes read
 * this module, so all of them agree on where the ground is.
 *
 * A sloped cell's top is two planar triangles split along one of its
 * diagonals (`splitsMainDiagonal`), in the layer's axes whatever the block's
 * rotation. Pure and deterministic.
 */
import { blockTypeSlopes, rotatedFootprint, type BlockCell, type BlockType } from './block-layers';

/** Corner heights of a cell's top: −x−z, +x−z, +x+z, −x+z, fractions of the cell height. */
export type CellCorners = readonly [number, number, number, number];

/** A flat full top. */
export const FLAT_CORNERS: CellCorners = Object.freeze([1, 1, 1, 1]) as CellCorners;

/** Turn a point about +Y counter-clockwise seen from above (x' = x cos + z sin, z' = −x sin + z cos — three.js's rotation.y). */
export function rotateXZ(x: number, z: number, rot: number): [number, number] {
  switch (rot) {
    case 90:
      return [z, -x];
    case 180:
      return [-x, -z];
    case 270:
      return [-z, x];
    default:
      return [x, z];
  }
}

/** The corners of a cell (null: a flat full top). */
export function cellCorners(cell: Pick<BlockCell, 'corners'> | null | undefined): CellCorners | null {
  const c = cell?.corners;
  return c === undefined || c.every((x) => x === 1) ? null : c;
}

/**
 * Which diagonal splits a sloped top into its two triangles: the one whose
 * ends differ least in height (the usual terrain rule: it keeps ridges and
 * valleys where the corners put them), the higher one on a tie. The choice
 * depends only on the corner heights, so a turned or mirrored copy of a slope
 * is the same surface turned or mirrored; a tie on both leaves a flat quad.
 * `true`: −x−z → +x+z; `false`: +x−z → −x+z.
 */
export function splitsMainDiagonal(c: CellCorners): boolean {
  const a = Math.abs(c[0] - c[2]);
  const b = Math.abs(c[1] - c[3]);
  return a !== b ? a < b : c[0] + c[2] >= c[1] + c[3];
}

/** The signed side of (u, v) relative to the split diagonal (0 on it). */
export function diagonalSide(c: CellCorners, u: number, v: number): number {
  return splitsMainDiagonal(c) ? u - v : u + v - 1;
}

/** The height of a sloped top at (u, v) of the cell (u along +x, v along +z, both 0–1), a fraction of the cell height. */
export function cornerHeightAt(c: CellCorners, u: number, v: number): number {
  const [gu, gv] = cornerGradientAt(c, u, v);
  // Each half is a plane through a corner it holds: −x−z for the first two, +x+z for the last.
  if (splitsMainDiagonal(c)) return c[0] + gu * u + gv * v;
  return u + v <= 1 ? c[0] + gu * u + gv * v : c[2] + gu * (u - 1) + gv * (v - 1);
}

/** How the height of a sloped top changes along u and v in the half holding (u, v) (fractions of the cell height per cell). */
export function cornerGradientAt(c: CellCorners, u: number, v: number): [number, number] {
  if (splitsMainDiagonal(c)) return u >= v ? [c[1] - c[0], c[2] - c[1]] : [c[2] - c[3], c[3] - c[0]];
  return u + v <= 1 ? [c[1] - c[0], c[3] - c[0]] : [c[2] - c[3], c[2] - c[1]];
}

/** The bilinear blend of a top's corners at (u, v): the height a subdivided top gives its inner lattice points. */
function bilinear(c: CellCorners, u: number, v: number): number {
  return c[0] * (1 - u) * (1 - v) + c[1] * u * (1 - v) + c[2] * u * v + c[3] * (1 - u) * v;
}

/** The sub-square of a top cut n × n that holds (u, v): its column, row and its own corners (lattice heights blended from the cell's). */
export function topSubSquare(c: CellCorners, n: number, u: number, v: number): { i: number; j: number; corners: CellCorners } {
  const i = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
  return { i, j, corners: [bilinear(c, i / n, j / n), bilinear(c, (i + 1) / n, j / n), bilinear(c, (i + 1) / n, (j + 1) / n), bilinear(c, i / n, (j + 1) / n)] };
}

/**
 * The height of a top cut n × n at (u, v) (a fraction of the cell height):
 * the lattice points' heights blended bilinearly from the corners, each
 * sub-square split along its own diagonal by the same rule as a whole top.
 * n = 1 is `cornerHeightAt`. This is the drawn surface only; collision and
 * surface queries keep the corners' two triangles.
 */
export function subdividedHeightAt(c: CellCorners, n: number, u: number, v: number): number {
  if (n <= 1) return cornerHeightAt(c, u, v);
  const s = topSubSquare(c, n, u, v);
  return cornerHeightAt(s.corners, u * n - s.i, v * n - s.j);
}

/** How the height of a top cut n × n changes along u and v at (u, v) (fractions of the cell height per cell); n = 1 is `cornerGradientAt`. */
export function subdividedGradientAt(c: CellCorners, n: number, u: number, v: number): [number, number] {
  if (n <= 1) return cornerGradientAt(c, u, v);
  const s = topSubSquare(c, n, u, v);
  const [gu, gv] = cornerGradientAt(s.corners, u * n - s.i, v * n - s.j);
  return [gu * n, gv * n];
}

/** A block's top at a point: its height above the block's base and how it rises along x and z (metres per metre, layer axes). */
export interface BlockTopSample {
  height: number;
  gx: number;
  gz: number;
}

/**
 * The top of one block at a point given relative to the block's origin (the
 * bottom centre of its turned footprint, layer axes, metres); null when the
 * block has no surface there (shape `none`, a custom shape with no box over
 * the point). `cellSize` is the layer's.
 */
export function blockTopAt(t: BlockType, cell: BlockCell, cellSize: readonly number[], px: number, pz: number): BlockTopSample | null {
  if (t.shape === 'none') return null;
  const f = rotatedFootprint(t, 0);
  const w = f[0] * cellSize[0]!;
  const H = f[1] * cellSize[1]!;
  const d = f[2] * cellSize[2]!;
  const corners = blockTypeSlopes(t) ? cellCorners(cell) : null;
  if (corners !== null) {
    // Corners are in the layer's axes (a single cell: its x and z sizes are the cell's).
    const u = Math.min(1, Math.max(0, px / cellSize[0]! + 0.5));
    const v = Math.min(1, Math.max(0, pz / cellSize[2]! + 0.5));
    const [gu, gv] = cornerGradientAt(corners, u, v);
    return { height: cornerHeightAt(corners, u, v) * H, gx: (gu * H) / cellSize[0]!, gz: (gv * H) / cellSize[2]! };
  }
  const rot = cell.rot ?? 0;
  const [lx, lz] = rotateXZ(px, pz, (360 - rot) % 360);
  const u = Math.min(1, Math.max(0, lx / w + 0.5));
  const v = Math.min(1, Math.max(0, lz / d + 0.5));
  switch (t.shape) {
    case 'half':
      return { height: H / 2, gx: 0, gz: 0 };
    case 'ramp': {
      // Rises toward +Z at rotation 0.
      const [gx, gz] = rotateXZ(0, H / d, rot);
      return { height: H * v, gx, gz };
    }
    case 'stairs':
      return { height: v < 0.5 ? H / 2 : H, gx: 0, gz: 0 };
    case 'custom': {
      let top = -1;
      for (const b of t.boxes ?? [[0, 0, 0, 1, 1, 1]]) if (u >= b[0]! && u <= b[3]! && v >= b[2]! && v <= b[5]!) top = Math.max(top, b[4]!);
      return top < 0 ? null : { height: top * H, gx: 0, gz: 0 };
    }
    default:
      return { height: H, gx: 0, gz: 0 };
  }
}

/** What the surface walk reads of a layer. */
export interface SurfaceGrid {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly cellSize: readonly number[];
  get(x: number, y: number, z: number): BlockCell | null;
}

/** The ground at a point: the cell whose top it is, the height (layer-local metres), the unit normal and the slope in degrees. */
export interface SurfaceHit {
  cell: [number, number, number];
  height: number;
  normal: [number, number, number];
  slope: number;
}

/**
 * The top of the blocks at or below a layer-local point, straight down (a
 * point inside the blocks gives the top of the blocks around it); null when
 * the column holds no block with a surface there. `anchorOf` names the anchor
 * of a cell covered by a larger block's footprint (none: such cells read as
 * empty).
 */
export function surfaceBelow(g: SurfaceGrid, types: ReadonlyMap<string, BlockType>, lx: number, ly: number, lz: number, anchorOf?: (x: number, y: number, z: number) => [number, number, number] | null): SurfaceHit | null {
  const cs = g.cellSize;
  const x = Math.floor(lx / cs[0]!);
  const z = Math.floor(lz / cs[2]!);
  if (!(x >= g.min[0]! && x < g.max[0]! && z >= g.min[2]! && z < g.max[2]!)) return null;
  if (!Number.isFinite(ly)) return null;
  const start = Math.min(g.max[1]! - 1, Math.floor(ly / cs[1]!));
  /** The block at a cell with its top at the point: its rows and its sample. */
  const blockAt = (y: number): { anchor: [number, number, number]; top: number; sample: BlockTopSample } | null => {
    let cell = g.get(x, y, z);
    let anchor: [number, number, number] = [x, y, z];
    if (cell?.block === undefined) {
      const a = anchorOf?.(x, y, z) ?? null;
      if (a === null) return null;
      cell = g.get(a[0], a[1], a[2]);
      anchor = a;
      if (cell?.block === undefined) return null;
    }
    const t = types.get(cell.block!);
    if (t === undefined) return null;
    const f = rotatedFootprint(t, cell.rot);
    const ox = (anchor[0] + f[0] / 2) * cs[0]!;
    const oz = (anchor[2] + f[2] / 2) * cs[2]!;
    const sample = blockTopAt(t, cell, cs, lx - ox, lz - oz);
    return sample === null ? null : { anchor, top: anchor[1] + f[1] - 1, sample };
  };
  for (let y = start; y >= g.min[1]!; y--) {
    let hit = blockAt(y);
    if (hit === null) continue;
    // Inside the blocks: climb to the top of the blocks stacked over the point.
    if (y === start && hit.anchor[1] * cs[1]! + hit.sample.height > ly) {
      for (let up = hit.top + 1; up < g.max[1]!; ) {
        const above = blockAt(up);
        if (above === null) break;
        hit = above;
        up = above.top + 1;
      }
    }
    const { gx, gz } = hit.sample;
    const len = Math.hypot(gx, 1, gz);
    const normal: [number, number, number] = [-gx / len || 0, 1 / len, -gz / len || 0];
    return { cell: [hit.anchor[0], hit.anchor[1], hit.anchor[2]], height: hit.anchor[1] * cs[1]! + hit.sample.height, normal, slope: (Math.acos(Math.min(1, normal[1])) * 180) / Math.PI };
  }
  return null;
}
