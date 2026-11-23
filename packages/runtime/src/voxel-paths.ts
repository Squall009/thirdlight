/**
 * `ctx.voxels.findPath` and `reach` as scripts see them: their points and
 * options in metres turned into the walk graph's cells, and the graph's
 * answers (walk-graph-queries.ts) turned back into metres.
 *
 * A waypoint is the middle of a standing cell at its floor (the cell's
 * bottom face: on terrain the drawn ground may lie up to half a cell off).
 * A straight run of steps is one segment: only the points where the way
 * turns are kept. Corners are not pulled tight: a straight line between two
 * corners could pass closer to a wall than the walk's cells keep, which the
 * graph does not check. A way through a structure grid gives its cells'
 * floor middles where the grid stands (turned with it), the same rule.
 */
import { VOXEL_SIZE_M, WALK_CLEARANCE_MAX, type LinkedPathAnswer, type WalkPathAnswer, type WalkQueryOptions, type WalkReachAnswer } from '@thirdlight/voxel';

import { cellBoxMetres, type VoxelPathAnswer, type VoxelReachAnswer, type VoxelWalkOptions } from './voxel-api';

const finite3 = (v: unknown): v is readonly [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** A point's cell (null: not three finite numbers). */
export function walkCellAt(p: unknown): [number, number, number] | null {
  if (!finite3(p)) return null;
  const s = VOXEL_SIZE_M;
  return [Math.floor(p[0] / s), Math.floor(p[1] / s), Math.floor(p[2] / s)];
}

/** A script's walk options as the graph's (cells; null: malformed). */
export function walkOptionsOf(o: VoxelWalkOptions | undefined): WalkQueryOptions | null {
  if (o === undefined) return {};
  if (typeof o !== 'object' || o === null) return null;
  const s = VOXEL_SIZE_M;
  const out: { height?: number; maxDrop?: number; maxNodes?: number; doors?: 'open-only' | 'shut-too' } = {};
  if (o.height !== undefined) {
    if (typeof o.height !== 'number' || !(o.height > 0) || o.height > WALK_CLEARANCE_MAX * s) return null;
    out.height = Math.ceil(o.height / s - 1e-9);
  }
  if (o.maxDrop !== undefined) {
    if (typeof o.maxDrop !== 'number' || !(o.maxDrop >= 0) || !Number.isFinite(o.maxDrop)) return null;
    out.maxDrop = Math.floor(o.maxDrop / s + 1e-9);
  }
  if (o.maxNodes !== undefined) {
    if (typeof o.maxNodes !== 'number' || !Number.isInteger(o.maxNodes) || o.maxNodes < 1) return null;
    out.maxNodes = o.maxNodes;
  }
  if (o.doors !== undefined) {
    if (o.doors !== 'open-only' && o.doors !== 'shut-too') return null;
    out.doors = o.doors;
  }
  if ((out.height ?? 4) + (out.maxDrop ?? 0) > WALK_CLEARANCE_MAX) return null;
  return out;
}

/** A cell's floor middle (world metres). */
const floorOf = (cells: Int32Array, k: number): readonly [number, number, number] => {
  const s = VOXEL_SIZE_M;
  return Object.freeze([(cells[k]! + 0.5) * s, cells[k + 1]! * s, (cells[k + 2]! + 0.5) * s] as [number, number, number]);
};

/** The waypoints of a walk's cells: the first, every one where the step changes, the last. */
export function walkPoints(cells: Int32Array): readonly (readonly [number, number, number])[] {
  const n = cells.length / 3;
  const out: (readonly [number, number, number])[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && i < n - 1) {
      const a = (i - 1) * 3;
      const b = i * 3;
      const c = (i + 1) * 3;
      if (cells[b]! - cells[a]! === cells[c]! - cells[b]! && cells[b + 1]! - cells[a + 1]! === cells[c + 1]! - cells[b + 1]! && cells[b + 2]! - cells[a + 2]! === cells[c + 2]! - cells[b + 2]!) continue;
    }
    out.push(floorOf(cells, i * 3));
  }
  return Object.freeze(out);
}

/** A walk graph's path answer as a script reads it. */
export function voxelPathAnswer(path: number, world: string, a: WalkPathAnswer): VoxelPathAnswer {
  return Object.freeze({
    path,
    world,
    status: a.status,
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    points: walkPoints(a.cells),
    length: a.cost,
    searched: a.run.coarse + a.run.cells + a.run.inner,
    steps: a.run.slices,
    ms: a.run.ms,
  });
}

/** The waypoints of a way across graphs (floor middles in world metres): the first, every one where the step changes (a link's step is one), the last. */
export function linkedWalkPoints(p: Float64Array, grids: Int32Array): readonly (readonly [number, number, number])[] {
  const n = grids.length;
  const out: (readonly [number, number, number])[] = [];
  const same = (a: number, b: number, c: number): boolean => {
    for (let k = 0; k < 3; k++) if (Math.abs(p[b * 3 + k]! - p[a * 3 + k]! - (p[c * 3 + k]! - p[b * 3 + k]!)) > 1e-6) return false;
    return grids[a] === grids[b] && grids[b] === grids[c];
  };
  for (let i = 0; i < n; i++) {
    if (i > 0 && i < n - 1 && same(i - 1, i, i + 1)) continue;
    out.push(Object.freeze([p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!] as [number, number, number]));
  }
  return Object.freeze(out);
}

/** A path across a world's graph and its structure grids' as a script reads it. */
export function voxelLinkedPathAnswer(path: number, world: string, a: LinkedPathAnswer): VoxelPathAnswer {
  return Object.freeze({
    path,
    world,
    status: a.status,
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    points: linkedWalkPoints(a.points, a.grids),
    length: a.cost,
    searched: a.run.coarse + a.run.cells + a.run.inner,
    steps: a.run.slices,
    ms: a.run.ms,
  });
}

/** A walk graph's reach answer as a script reads it. */
export function voxelReachAnswer(reach: number, world: string, a: WalkReachAnswer): VoxelReachAnswer {
  const s = VOXEL_SIZE_M;
  let points: (readonly [number, number, number])[] | null = null;
  if (a.cells !== null) {
    points = [];
    for (let k = 0; k < a.cells.length; k += 3) points.push(floorOf(a.cells, k));
  }
  return Object.freeze({
    reach,
    world,
    status: a.status,
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    count: a.count,
    area: a.count * s * s,
    bounds: a.min === null || a.max === null ? null : cellBoxMetres(a.min, a.max),
    points: points === null ? null : Object.freeze(points),
    searched: a.run.cells,
    steps: a.run.slices,
    ms: a.run.ms,
  });
}

/** An answer with nothing walked: a malformed question, no world to ask, or a world not open yet (no reason: nothing is known). */
export function noPathAnswer(path: number, world: string, status: 'unreachable' | 'unknown', reason?: 'invalid' | 'no_world'): VoxelPathAnswer {
  return Object.freeze({ path, world, status, ...(reason !== undefined ? { reason } : {}), points: Object.freeze([]), length: 0, searched: 0, steps: 0, ms: 0 });
}

export function noReachAnswer(reach: number, world: string, status: 'unreachable' | 'unknown', reason?: 'invalid' | 'no_world'): VoxelReachAnswer {
  return Object.freeze({ reach, world, status, ...(reason !== undefined ? { reason } : {}), count: 0, area: 0, bounds: null, points: null, searched: 0, steps: 0, ms: 0 });
}
