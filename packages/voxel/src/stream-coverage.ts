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
}

/**
 * The ground under a point (cells), walking down at most `reach` cells (the
 * load ring's height: ground deeper below is never loaded, moving or not):
 * `known` (every chunk down to the first holding anything is resident and
 * derived), `missing` (one on the way is not), or `out` (nothing solid
 * within reach, or the world's floor).
 */
export function groundAt(grid: ChunkGrid, x: number, y: number, z: number, reach: number, q: GroundQuery): 'known' | 'missing' | 'out' {
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
    if (!q.isResident(cx, cy, cz) || !q.chunkReady(cx, cy, cz)) return 'missing';
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
}

/** Counts one update into `c`: the ground under the focus (missing, or out of reach) and under its lead point (missing). */
export function countGround(c: GroundCoverage, grid: ChunkGrid, focus: { x: number; y: number; z: number }, lead: { x: number; y: number; z: number }, reach: number, q: GroundQuery): void {
  c.updates++;
  const under = groundAt(grid, focus.x, focus.y, focus.z, reach, q);
  if (under === 'missing') c.groundMissing++;
  else if (under === 'out') c.outOfReach++;
  if (lead !== focus && groundAt(grid, lead.x, lead.y, lead.z, reach, q) === 'missing') c.aheadMissing++;
}
