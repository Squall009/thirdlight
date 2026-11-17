/**
 * How many bricks the light volume's update takes a frame: as many as its
 * share of the GPU frame (the live light's, `gpuPassBudgetMs`) holds at the
 * measured cost of a brick, read from the update's own timestamps.
 *
 * A reading may hold a wait for work before the pass (its first stamp
 * written while the GPU still drew the last frame; seen every other frame):
 * one past half again the least of the last few is left out of the estimate,
 * so stalled stamps cannot cut the update down. A cost that really rose (more
 * lamps in reach) reads high every time: a high reading after a high one is
 * taken.
 */
import { RAY_COST_WEIGHT } from './tracer-gpu';

/** Readings kept to find a stalled one by. */
const SEEN = 16;
/** A reading past this many times the least of the last ones held a wait before the pass. */
const STALLED = 1.5;

export class VolumePacing {
  /** The running estimate of a brick's ms (null: nothing read yet). */
  msPerBrick: number | null = null;
  private readonly seen: number[] = [];
  /** The last reading was high (past {@link STALLED} × the least) and left out. */
  private high = false;

  /** `start`: bricks a frame before the first reading. */
  constructor(private readonly start: number) {}

  /** A dispatch of `bricks` read at `ms` (its wide stamps). */
  read(bricks: number, ms: number): void {
    if (!(ms > 0) || bricks <= 0) return;
    const raw = ms / bricks;
    this.seen.push(raw);
    if (this.seen.length > SEEN) this.seen.shift();
    const high = raw > STALLED * Math.min(...this.seen);
    const skip = high && !this.high;
    this.high = high;
    if (skip) return;
    this.msPerBrick = this.msPerBrick === null ? raw : this.msPerBrick + (raw - this.msPerBrick) * RAY_COST_WEIGHT;
  }

  /** Bricks a frame for `budgetMs` of GPU time (one at least once a cost is known). */
  bricks(budgetMs: number): number {
    if (this.msPerBrick === null) return this.start;
    return Math.max(1, Math.floor(budgetMs / this.msPerBrick));
  }
}
