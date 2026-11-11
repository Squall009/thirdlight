/**
 * Whether the world is kept under a moving focus: the ground below a point
 * is known when every chunk from the point's chunk down to the first one
 * holding anything is resident and derived (its collision and draw are made
 * from those results). A chunk not resident, or resident but not derived
 * yet, on the way down is a gap: a character there would fall through and a
 * camera sees no near ground. Counted every streamer update for the focus
 * and for its lead point (where it will be about a second later), so a run
 * at speed can tell how often the world under it was missing.
 */
import { chunkInWorld, type ChunkGrid } from './coords';

/** What the check reads of a streamer. */
export interface GroundQuery {
  isResident(cx: number, cy: number, cz: number): boolean;
  chunkReady(cx: number, cy: number, cz: number): boolean;
  /** Whether a resident chunk holds no cells at all (all air). */
  isAir(cx: number, cy: number, cz: number): boolean;
  /** Why a chunk on the way down is a gap (absent: not told; the bench reads where the time goes). */
  gap?(cx: number, cy: number, cz: number): GroundGap;
}

/**
 * Why the ground under the focus is missing, at the first gap on the way
 * down: not asked for yet (`unread`), being read (`reading`), read and
 * waiting for or in a worker's decode (`decoding`), resident with a section
 * waiting for a neighbour chunk (`blocked`), or with its derive queued or
 * running (`deriving`).
 */
export type GroundGap = 'unread' | 'reading' | 'decoding' | 'blocked' | 'deriving';

/**
 * The ground under a point (cells), walking down at most `reach` cells (the
 * load ring's height: ground deeper below is never loaded, moving or not):
 * `known` (every chunk down to the first holding anything is resident and
 * derived), `missing` (one on the way is not), or `out` (nothing solid
 * within reach, or the world's floor).
 */
export function groundAt(grid: ChunkGrid, x: number, y: number, z: number, reach: number, q: GroundQuery): 'known' | 'missing' | 'out' {
  const r = groundWalk(grid, x, y, z, reach, q);
  return typeof r === 'string' ? r : 'missing';
}

/** {@link groundAt}, with the gap's chunk in place of `missing`. */
function groundWalk(grid: ChunkGrid, x: number, y: number, z: number, reach: number, q: GroundQuery): 'known' | 'out' | readonly [number, number, number] {
  const cx = Math.floor(x) >> grid.shift;
  const cz = Math.floor(z) >> grid.shift;
  const top = Math.floor(y) >> grid.shift;
  const bottom = Math.floor(y - reach) >> grid.shift;
  for (let cy = top; cy >= bottom; cy--) {
    if (!chunkInWorld(grid, cx, cy, cz)) {
      // Above the world's top the walk goes on down; under its floor there is nothing to stand on.
      if (cy < grid.chunkMinY) return 'out';
      continue;
    }
    if (!q.isResident(cx, cy, cz) || !q.chunkReady(cx, cy, cz)) return [cx, cy, cz];
    if (!q.isAir(cx, cy, cz)) return 'known';
  }
  return 'out';
}

/**
 * Updates counted, those where the ground under the focus or under its lead point was missing, and those where
 * the focus had no ground within the ring's height under it (high over a valley: not the streamer's to load).
 */
export interface GroundCoverage {
  updates: number;
  groundMissing: number;
  aheadMissing: number;
  outOfReach: number;
  /** Updates with the ground under the focus missing, by the first gap's reason (when the query tells it). */
  why: Record<GroundGap, number>;
}

/** A coverage count at zero. */
export function emptyCoverage(): GroundCoverage {
  return { updates: 0, groundMissing: 0, aheadMissing: 0, outOfReach: 0, why: { unread: 0, reading: 0, decoding: 0, blocked: 0, deriving: 0 } };
}

/** A copy of a count (the metrics hand out snapshots). */
export function copyCoverage(c: GroundCoverage): GroundCoverage {
  return { ...c, why: { ...c.why } };
}

/** Counts one update into `c`: the ground under the focus (missing, or out of reach) and under its lead point (missing). */
export function countGround(c: GroundCoverage, grid: ChunkGrid, focus: { x: number; y: number; z: number }, lead: { x: number; y: number; z: number }, reach: number, q: GroundQuery): void {
  c.updates++;
  const under = groundWalk(grid, focus.x, focus.y, focus.z, reach, q);
  if (under === 'out') c.outOfReach++;
  else if (under !== 'known') {
    c.groundMissing++;
    if (q.gap !== undefined) c.why[q.gap(under[0], under[1], under[2])]++;
  }
  if (lead !== focus && groundAt(grid, lead.x, lead.y, lead.z, reach, q) === 'missing') c.aheadMissing++;
}
