/**
 * Phase 25.16: the run digest for tools (tl_game_observe) — the digest of
 * the world now, and the digest right after the last input exercise's last
 * step, taken by a step observer in the simulation's own realm (the page's
 * runtime or the worker's), so it is the state after exactly that step
 * whatever the frame timing. An exercise that restarts the game first makes
 * a run and its replay comparable: the same input from the run's first step
 * gives the same digest at the same run step.
 */
import type { Runtime } from '@thirdlight/runtime';
import { runDigest } from './step-digest';

export interface RunDigestNow {
  readonly stepIndex: number;
  readonly runStep: number;
  readonly digest: string;
}

export interface InputRunDigest extends RunDigestNow {
  /** The exercise's applied steps. */
  readonly fromStep: number;
  readonly toStep: number;
  /** It restarted the game first (its frames began at the run's first step). */
  readonly restarted: boolean;
}

export interface RunDigests {
  readonly now: RunDigestNow;
  readonly input: InputRunDigest | null;
}

export class RunProbe {
  private pending: { from: number; to: number; restarted: boolean } | null = null;
  private last: InputRunDigest | null = null;

  constructor(private readonly rt: Runtime) {
    rt.setStepObserver?.((stepIndex) => {
      const p = this.pending;
      if (p === null || stepIndex <= p.to) return;
      this.pending = null;
      this.last = { ...runDigest(this.rt), fromStep: p.from, toStep: p.to, restarted: p.restarted };
    });
  }

  /** An exercise finished sampling its last step (`to`): the digest is taken right after that step runs. */
  exerciseDone(from: number, to: number, restarted: boolean): void {
    if (from < 0) return;
    this.pending = { from, to, restarted };
  }

  read(): RunDigests {
    return { now: runDigest(this.rt), input: this.last };
  }

  dispose(): void {
    this.rt.setStepObserver?.(null);
  }
}
