/**
 * The run digest for tools (tl_game_observe) — the digest of
 * the world now, and the digest right after the last input exercise's last
 * step, taken by a step observer in the simulation's own realm (the page's
 * runtime or the worker's), so it is the state after exactly that step
 * whatever the frame timing. An exercise that restarts the game first makes
 * a run and its replay comparable: the same input from the run's first step
 * gives the same digest at the same run step.
 *
 * An exercise with `hold` holds the simulation right after its
 * last step (the debugger's hold, set by the same observer), so the next
 * exercise starts at exactly the following step: a tool (the play-test
 * runner, a project's driver script) can observe, decide and go on in
 * lockstep, whatever the wall-clock time between its calls. The next
 * exercise lets it go; so does the debugger's resume.
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
  /** The game holds right after it (the exercise asked for `hold`) and still does. */
  readonly held?: boolean;
}

export interface RunDigests {
  readonly now: RunDigestNow;
  readonly input: InputRunDigest | null;
}

export class RunProbe {
  private pending: { from: number; to: number; restarted: boolean; hold: boolean } | null = null;
  private last: InputRunDigest | null = null;
  /** This probe holds the simulation (after an exercise with `hold`). */
  private holding = false;

  constructor(private readonly rt: Runtime) {
    rt.setStepObserver?.((stepIndex) => {
      const p = this.pending;
      if (p === null || stepIndex <= p.to) return;
      this.pending = null;
      this.last = { ...runDigest(this.rt), fromStep: p.from, toStep: p.to, restarted: p.restarted };
      if (p.hold) {
        // Hold right here (the runtime stops the frame's remaining steps).
        this.rt.setDebugHold?.(true);
        this.holding = true;
      }
    });
  }

  /** An exercise finished sampling its last step (`to`): the digest is taken right after that step runs (and, with `hold`, the game holds there). */
  exerciseDone(from: number, to: number, restarted: boolean, hold = false): void {
    if (from < 0) return;
    this.pending = { from, to, restarted, hold };
  }

  /** A new exercise begins: let go of this probe's hold (the next step is its first). */
  release(): void {
    if (!this.holding) return;
    this.holding = false;
    if (this.rt.debugHeld === true) this.rt.setDebugHold?.(false);
  }

  /** Whether the game still holds after the last exercise (the debugger's resume lets it go too). */
  get held(): boolean {
    if (this.holding && this.rt.debugHeld !== true) this.holding = false;
    return this.holding;
  }

  read(): RunDigests {
    const input = this.last === null ? null : this.held ? { ...this.last, held: true } : this.last;
    return { now: runDigest(this.rt), input };
  }

  dispose(): void {
    this.rt.setStepObserver?.(null);
  }
}

/** The simulation's run and step (a cheap read: no digest). */
export interface RunNow {
  readonly run: number;
  /** The step count the run began at (0, or the boundary of its restart). */
  readonly startStep: number;
  readonly stepIndex: number;
}

/** `RunNow` of a runtime (null before it can say). */
export function runNowOf(rt: Runtime): RunNow | null {
  const d = rt.getDiagnostics();
  const start = rt.runStart?.();
  if (!d.ok || start === undefined) return null;
  return { run: start.run ?? 0, startStep: start.step, stepIndex: d.diagnostics.stepIndex };
}
