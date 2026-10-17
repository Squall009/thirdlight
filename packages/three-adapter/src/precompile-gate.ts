/**
 * Pipelines precompiled ahead of a present: no frame builds programs while it
 * is drawn. Before the first present, after a scene attached, after a change
 * of the shading (a light switched on or off) and with a new renderer, the
 * scene is compiled as the frame would draw it (`compileAsync`); frames are
 * skipped meanwhile, so the last picture stays.
 *
 * A compile that runs too long (PRECOMPILE_WAIT_MS) or stops moving
 * (PRECOMPILE_STALL_MS: a device that never answers, a pipeline that failed)
 * is given up on: the frame draws and builds what is left itself.
 *
 * Kept out of `adapter.ts`: the adapter asks for one when something changed
 * the programs, asks every frame whether it holds the present, and reports
 * the settled ones with the next drawn frame.
 */
import { PRECOMPILE_STALL_MS, PRECOMPILE_WAIT_MS } from './adapter-types';
import type { Precompile } from './environment-nodes';

/** Why a precompile is wanted: the first present, or a scene (or the shading) that changed since. */
export type PrecompileReason = 'start' | 'scene';

export interface PrecompileStats {
  runs: number;
  failed: number;
  gaveUp: number;
  lastMs: number;
}

export class PrecompileGate {
  /** Wanted before the next present: the first one, and after a scene attached (or a new renderer). */
  private wanted: PrecompileReason | null = 'start';
  /** The precompile running (frames are skipped until it settles, stops moving, or the wait passed). */
  private run: { readonly startedAt: number; readonly reason: PrecompileReason; readonly job: Precompile } | null = null;
  /** The last precompile that settled, reported with the next drawn frame. */
  private settled: { readonly startedAt: number; readonly ms: number } | null = null;
  /** Since when the first present waits for the start scenes' content. */
  private startHeldSince: number | null = null;
  private readonly counts: PrecompileStats = { runs: 0, failed: 0, gaveUp: 0, lastMs: 0 };

  /** @param disposed whether the adapter is gone (a compile settling after that counts nothing). */
  constructor(private readonly disposed: () => boolean) {}

  /** Something changed the programs: compile before the next present (the first present's wait stays the first's). */
  want(): void {
    this.wanted ??= 'scene';
  }

  /** A new renderer (a lost device): what ran is let go and its first present waits as the first one did. */
  restart(): void {
    this.run?.job.release();
    this.run = null;
    this.wanted = 'start';
  }

  /** Nothing wanted and nothing running. */
  idle(): boolean {
    return this.wanted === null && this.run === null;
  }

  /** A precompile runs now (frames that are not captures are skipped). */
  active(): boolean {
    return this.run !== null;
  }

  /** The running compile, whose `aside` a capture draws through (null: none). */
  job(): Precompile | null {
    return this.run?.job ?? null;
  }

  /** A precompile runs and is still waited for at `now` (one past its wait or stalled is given up here). */
  running(now: number): boolean {
    if (this.run === null) return false;
    if (now - this.run.startedAt < PRECOMPILE_WAIT_MS && now - this.run.job.lastProgressAt() < PRECOMPILE_STALL_MS) return true;
    this.run.job.release();
    this.run = null;
    this.counts.gaveUp += 1;
    return false;
  }

  /**
   * Whether this frame waits for a precompile, starting one when it is wanted.
   * `startHeld`: the first present still waits for the start scenes' content (at most PRECOMPILE_WAIT_MS);
   * `compile`: the scene as the frame would draw it, compiled (null: no camera yet, nothing to compile).
   */
  holds(startHeld: () => boolean, compile: (() => Precompile) | null): boolean {
    const now = performance.now();
    if (this.running(now)) return true;
    if (this.wanted === null || compile === null) return false;
    if (this.wanted === 'start' && startHeld()) {
      this.startHeldSince ??= now;
      if (now - this.startHeldSince < PRECOMPILE_WAIT_MS) return true;
    }
    const reason = this.wanted;
    this.wanted = null;
    let job: Precompile;
    try {
      job = compile();
    } catch {
      this.counts.failed += 1;
      return false;
    }
    const run = { startedAt: now, reason, job };
    this.run = run;
    const settle = (failed: boolean): void => {
      if (this.run !== run) return;
      this.run = null;
      if (this.disposed()) return;
      const ms = performance.now() - run.startedAt;
      this.counts.runs += 1;
      if (failed) this.counts.failed += 1;
      this.counts.lastMs = Math.round(ms);
      this.settled = { startedAt: run.startedAt, ms };
    };
    job.done.then(
      () => settle(false),
      () => settle(true),
    );
    return true;
  }

  /** The precompile that settled since the last drawn frame (once; null: none). */
  takeSettled(): { readonly startedAt: number; readonly ms: number } | null {
    const s = this.settled;
    this.settled = null;
    return s;
  }

  /** The counts for diagnostics (null before any precompile ran). */
  diagnostics(): (PrecompileStats & { running: boolean }) | null {
    const c = this.counts;
    if (this.run === null && c.runs + c.failed + c.gaveUp === 0) return null;
    return { ...c, running: this.run !== null };
  }
}
