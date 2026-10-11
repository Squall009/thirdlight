/**
 * Vertex paint on generated meshes, kept in path space.
 *
 * Generated architecture and spline meshes are made again whenever their
 * parameters change, so paint cannot be stored per vertex. It is stored per
 * path instead: a grid per side ({@link PATH_PAINT_SIDES}) of points
 * {@link PATH_PAINT_CELL} m apart, along the path × up a wall face (left
 * and right of travel) or across a face looking up or down (`top`: a
 * road's surface, a wall's top, a floor by its outline). A vertex finds its
 * place by the nearest point of the path on the ground and its normal (the
 * same way `trim-paint.ts` reads a block layer's wall paint), whenever the
 * mesh is made: a wall cut by a new door, raised a storey or restyled keeps
 * its paint where it was painted.
 *
 * A face more than {@link PATH_PAINT_REACH} m to the side of its path takes
 * no paint from it (a room's far wall is another outline's). Where two paths'
 * paint reach one vertex, each channel takes the larger.
 *
 * Positions are in the object's frame (architecture and splines are placed
 * by the object's position alone).
 *
 * Pure.
 */
import { pathDistanceNear, pathPointAt, samplePath } from './arch-path';
import type { ArchitectureComponent, ArchitecturePath } from './architecture';
import { brushFalloff, paintPoint } from './paint-brush';
import { SplineCurve, newSplineFrame } from './spline-curve';
import type { SplineComponent } from './spline';
import { PATH_PAINT_CELL, VERTEX_PAINT_BYTES, VERTEX_PAINT_LAYOUT, VERTEX_PAINT_LIMITS, type PathPaintSide } from './vertex-paint';
import type { PaintVec3, VertexPaintBrush } from './vertex-paint-stroke';

/** Metres to the side of a path (across a wall face's left or right) its paint reaches. */
export const PATH_PAINT_REACH = 2;
/** A vertex whose normal's up part is at least this is on a `top` face (looking up or down). */
export const PATH_PAINT_TOP_NORMAL = 0.7;

/** Where a point lies against a path. */
export interface PathPlace {
  /** Metres along the path. */
  s: number;
  /** Metres to the right of travel (negative: left). */
  across: number;
  /** Metres above the path. */
  up: number;
  /** The level right of travel there (x, z). */
  rx: number;
  rz: number;
}

/** A path as paint reads it. */
export interface PathFrame {
  readonly length: number;
  readonly closed: boolean;
  locate(x: number, y: number, z: number, out: PathPlace): PathPlace;
}

export const newPathPlace = (): PathPlace => ({ s: 0, across: 0, up: 0, rx: 1, rz: 0 });

/** An architecture path (outline, building or element) as a frame. */
export function architecturePathFrame(p: ArchitecturePath): PathFrame {
  const samples = samplePath(p);
  const at = [0, 0, 0];
  const tan = [0, 0, 1];
  return {
    length: samples.length,
    closed: samples.closed,
    locate(x, y, z, out) {
      const s = pathDistanceNear(samples, x, z);
      pathPointAt(samples, s, at, tan);
      // Right of travel, level: (-tz, 0, tx), as the generator's offset operator.
      const l = Math.hypot(tan[0]!, tan[2]!) || 1;
      out.rx = -tan[2]! / l;
      out.rz = tan[0]! / l;
      out.s = s;
      out.across = (x - at[0]!) * out.rx + (z - at[2]!) * out.rz;
      out.up = y - at[1]!;
      return out;
    },
  };
}

/** A spline's curve (at the object's origin) as a frame. */
export function splinePathFrame(c: SplineComponent): PathFrame {
  const curve = SplineCurve.of(c, [0, 0, 0]);
  const f = newSplineFrame();
  return {
    length: curve.length,
    closed: curve.closed,
    locate(x, y, z, out) {
      const near = curve.nearest(x, y, z, true);
      curve.frameAt(near.distance, f);
      const l = Math.hypot(f.rx, f.rz) || 1;
      out.rx = f.rx / l;
      out.rz = f.rz / l;
      out.s = near.distance;
      out.across = (x - f.x) * out.rx + (z - f.z) * out.rz;
      out.up = y - f.y;
      return out;
    },
  };
}

/** The path a key names on an object (its architecture's outline, building or element, or its spline), or null. */
export function pathOfKey(components: { architecture?: Pick<ArchitectureComponent, 'outlines' | 'buildings' | 'elements'>; spline?: SplineComponent }, key: string): ArchitecturePath | SplineComponent | null {
  if (key === 'spline') return components.spline ?? null;
  const a = components.architecture;
  if (a === undefined) return null;
  const colon = key.indexOf(':');
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  const found = kind === 'outline' ? a.outlines?.find((o) => o.id === id) : kind === 'building' ? a.buildings?.find((b) => b.id === id) : kind === 'element' ? a.elements.find((e) => e.id === id) : undefined;
  return found?.path ?? null;
}

/** The frame of the path a key names (null: the object has no such path). */
export function pathPaintFrame(components: { architecture?: Pick<ArchitectureComponent, 'outlines' | 'buildings' | 'elements'>; spline?: SplineComponent }, key: string): PathFrame | null {
  const p = pathOfKey(components, key);
  if (p === null) return null;
  return key === 'spline' ? splinePathFrame(p as SplineComponent) : architecturePathFrame(p as ArchitecturePath);
}

/** One side's grid: its first point and size in cells, 4 bytes a point (rows up/across of points along). */
export interface PathGrid {
  origin: [number, number];
  size: [number, number];
  values: Uint8Array;
}

/** The side a vertex with normal (nx, ny, nz) belongs to, at a place whose right of travel is (rx, rz). */
export function pathSideOf(nx: number, ny: number, nz: number, place: Pick<PathPlace, 'rx' | 'rz'>): PathPaintSide {
  if (Math.abs(ny) >= PATH_PAINT_TOP_NORMAL) return 'top';
  return nx * place.rx + nz * place.rz >= 0 ? 'right' : 'left';
}

/** The grid coordinate (metres) of a place on a side: up a wall face, across a top face; null when the side does not reach it. */
function sideCoordinate(place: PathPlace, side: PathPaintSide): number | null {
  if (side === 'top') return place.across;
  return Math.abs(place.across) <= PATH_PAINT_REACH ? place.up : null;
}

/** A grid grown to hold the cells [i0..i1] × [j0..j1] (the same grid when it holds them). */
function grown(g: PathGrid | null, i0: number, i1: number, j0: number, j1: number): PathGrid {
  if (g !== null && i0 >= g.origin[0] && j0 >= g.origin[1] && i1 < g.origin[0] + g.size[0] && j1 < g.origin[1] + g.size[1]) return g;
  const a0 = g === null ? i0 : Math.min(i0, g.origin[0]);
  const b0 = g === null ? j0 : Math.min(j0, g.origin[1]);
  const a1 = g === null ? i1 : Math.max(i1, g.origin[0] + g.size[0] - 1);
  const b1 = g === null ? j1 : Math.max(j1, g.origin[1] + g.size[1] - 1);
  const cols = a1 - a0 + 1;
  const rows = b1 - b0 + 1;
  const values = new Uint8Array(cols * rows * VERTEX_PAINT_BYTES);
  if (g !== null) {
    for (let r = 0; r < g.size[1]; r++) {
      const from = r * g.size[0] * VERTEX_PAINT_BYTES;
      const to = ((g.origin[1] + r - b0) * cols + (g.origin[0] - a0)) * VERTEX_PAINT_BYTES;
      values.set(g.values.subarray(from, from + g.size[0] * VERTEX_PAINT_BYTES), to);
    }
  }
  return { origin: [a0, b0], size: [cols, rows], values };
}

/**
 * Paint one side of a path with dabs (points in the object's frame). Returns
 * the grid (grown where the dabs reach past it) and how many bytes changed;
 * dabs beyond the side's reach paint nothing.
 */
export function paintPathDabs(grid: PathGrid | null, frame: PathFrame, side: PathPaintSide, dabs: readonly PaintVec3[], brush: VertexPaintBrush): { grid: PathGrid | null; changed: number } {
  const cell = PATH_PAINT_CELL;
  const r = brush.radius;
  const falloff = brush.falloff ?? 'smooth';
  const place = newPathPlace();
  const L = VERTEX_PAINT_LIMITS;
  const lastCell = Math.ceil(frame.length / cell);
  let g = grid;
  let changed = 0;
  for (const d of dabs) {
    frame.locate(d[0], d[1], d[2], place);
    const t = sideCoordinate(place, side);
    if (t === null) continue;
    // A closed path's start and end are one place: a dab near either paints both ends' points.
    const along = frame.closed && frame.length > 0 ? [place.s, place.s - frame.length, place.s + frame.length] : [place.s];
    for (const s of along) {
      const i0 = Math.max(Math.ceil((s - r) / cell), 0, -L.along);
      const i1 = Math.min(Math.floor((s + r) / cell), lastCell, L.along);
      const j0 = Math.max(Math.ceil((t - r) / cell), -L.across);
      const j1 = Math.min(Math.floor((t + r) / cell), L.across);
      if (i0 > i1 || j0 > j1) continue;
      g = grown(g, i0, i1, j0, j1);
      const cols = g.size[0];
      for (let j = j0; j <= j1; j++) {
        const dt = j * cell - t;
        for (let i = i0; i <= i1; i++) {
          const ds = i * cell - s;
          const d2 = ds * ds + dt * dt;
          if (d2 > r * r) continue;
          const at = ((j - g.origin[1]) * cols + (i - g.origin[0])) * VERTEX_PAINT_BYTES;
          if (paintPoint(g.values, at, VERTEX_PAINT_LAYOUT, brush, brush.strength * brushFalloff(d2, r, falloff))) changed++;
        }
      }
    }
  }
  return { grid: g, changed };
}

/** The 4 bytes at (s, t) metres, bilinear between grid points (0 outside the grid). */
function sampleGrid(g: PathGrid, s: number, t: number, out: Float64Array): void {
  const fi = s / PATH_PAINT_CELL - g.origin[0];
  const fj = t / PATH_PAINT_CELL - g.origin[1];
  out.fill(0);
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  if (i0 < -1 || j0 < -1 || i0 >= g.size[0] || j0 >= g.size[1]) return;
  const u = fi - i0;
  const v = fj - j0;
  for (const [di, dj, w] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]] as const) {
    const i = i0 + di;
    const j = j0 + dj;
    if (w === 0 || i < 0 || j < 0 || i >= g.size[0] || j >= g.size[1]) continue;
    const at = (j * g.size[0] + i) * VERTEX_PAINT_BYTES;
    for (let k = 0; k < VERTEX_PAINT_BYTES; k++) out[k] = out[k]! + g.values[at + k]! * w;
  }
}

/** One path's paint as a mesh reads it. */
export interface PathPaintSource {
  frame: PathFrame;
  grids: Partial<Record<PathPaintSide, PathGrid>>;
}

/**
 * The paint of generated vertices (`positions`, `normals`: xyz; `offset`:
 * where the positions' origin is in the object's frame, e.g. a spline mesh
 * piece's centre) into `out` (4 bytes a vertex): each vertex reads the grid
 * of its side of every path, each channel the largest. Vertices no grid
 * reaches are left as they are (0 in a new stream).
 */
export function samplePathPaint(sources: readonly PathPaintSource[], positions: ArrayLike<number>, normals: ArrayLike<number>, out: Uint8Array, offset: readonly number[] = [0, 0, 0]): void {
  const count = Math.min(Math.floor(positions.length / 3), Math.floor(out.length / VERTEX_PAINT_BYTES));
  const place = newPathPlace();
  const value = new Float64Array(VERTEX_PAINT_BYTES);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]! + offset[0]!, y = positions[i * 3 + 1]! + offset[1]!, z = positions[i * 3 + 2]! + offset[2]!;
    for (const src of sources) {
      src.frame.locate(x, y, z, place);
      const side = pathSideOf(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!, place);
      const g = src.grids[side];
      if (g === undefined) continue;
      const t = sideCoordinate(place, side);
      if (t === null) continue;
      sampleGrid(g, place.s, t, value);
      for (let k = 0; k < VERTEX_PAINT_BYTES; k++) {
        const b = Math.round(value[k]!);
        if (b > out[i * VERTEX_PAINT_BYTES + k]!) out[i * VERTEX_PAINT_BYTES + k] = Math.min(255, b);
      }
    }
  }
}
