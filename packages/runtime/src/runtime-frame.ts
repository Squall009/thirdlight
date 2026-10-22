/**
 * The frame update: how many fixed steps a frame owes (the frame clock's
 * bounded catch-up, scaled by the game mode's time scale), the settle
 * pre-roll on the first frame of a phased module set, and the holds that run
 * no steps — the game's pause and the debugger's hold, with its single steps,
 * breakpoints (`stepWatcher`) and step observers.
 *
 * Holding changes nothing the simulation computes: the same steps run with
 * the same inputs, only later; the clock resumes from where it was released.
 */
import { FrameClock } from './frame-clock';
import type { RuntimeSim } from './runtime-sim';

/** The step loop a frame drives. */
export interface FrameHost {
  /** One fixed step (false after a fail-stop: the frame stops there). */
  step(): boolean;
  /** One settle pre-roll step on a neutral frame (false after a fail-stop). */
  prerollStep(): boolean;
  /** The step boundary a paused game still applies (scene loads and unloads); false after a fail-stop. */
  pausedBoundary(): boolean;
  /** The game mode's time scale (null without modes). */
  timeScale(): number | null;
  /** The frame is done (`onFrame`). */
  frameDone(): void;
}

export class FrameDriver {
  /** The frame clock: the steps a frame owes, the bounded catch-up and the interpolation alpha. */
  readonly clock = new FrameClock();
  /** Paused — frames render and call onFrame, no steps run. */
  paused = false;
  /**
   * Play debugging: held at a step boundary — like `paused`
   * but owned by the debugger, never by the game (the flow's pause does not
   * release it), and nothing at all happens at the boundary until a step is
   * allowed (`debugSteps`) or the hold is released.
   */
  debugHold = false;
  /** Steps the debugger allowed while held (each runs, then the hold stays). */
  debugSteps = 0;
  /** Called after every executed step with the completed step index; true holds there (a breakpoint). */
  stepWatcher: ((stepIndex: number) => boolean) | null = null;
  /** Told after every executed step (tools: the run digest after an input exercise); never holds. */
  stepObserver: ((stepIndex: number) => void) | null = null;
  /** The settle pre-roll is initialization: cancellable before the first frame. */
  private prerollDone = false;
  needsPreroll = false;
  /** The pre-roll's steps once it ran (`settleSteps` in the diagnostics). */
  settleSteps = 0;

  constructor(
    private readonly sim: RuntimeSim,
    private readonly host: FrameHost,
    private readonly phased: boolean,
    private readonly settleStepCount: number,
  ) {}

  /** Started: a phased module set settles on the first frame (unless it already has). */
  started(): void {
    if (this.phased && !this.prerollDone) this.needsPreroll = true;
  }

  setDebugHold(hold: boolean): void {
    this.debugHold = hold === true;
    if (!this.debugHold) this.debugSteps = 0;
  }

  /** While held, run exactly one more step on the next frame (then stay held). */
  debugStep(): void {
    if (this.debugHold) this.debugSteps += 1;
  }

  /** Sim seconds the drawn state advances per wall second from the last frame on (0 while paused, held, stopped or failed). */
  interpolationRate(): number {
    return this.sim.stateName === 'running' && !this.paused && !this.debugHold && this.clock.anchored ? this.clock.scale : 0;
  }

  /** One frame update + onFrame (frame ordering: step → onFrame). */
  run(t: number): void {
    const clock = this.clock;
    const sim = this.sim;
    const host = this.host;
    clock.frameCount += 1; // frame updates, including zero-step frames
    if (this.needsPreroll) {
      // Settle pre-roll: exactly `settleTime` of steps (default
      // SETTLE_PREROLL_STEPS) with neutral frames, no input sampling, no wall
      // time; the anchor is installed at this frame's simTime afterwards.
      this.needsPreroll = false;
      this.prerollDone = true;
      this.settleSteps = this.settleStepCount;
      for (let i = 0; i < this.settleStepCount; i += 1) {
        if (!host.prerollStep()) return; // failed
      }
      clock.anchorAt(t, sim.simTime);
      host.frameDone();
      return;
    }
    if (!clock.anchored) {
      // First frame after start: initialize the anchor at that frame
      //  — time before start is never simulated (zero steps).
      clock.anchorAt(t, sim.simTime);
      host.frameDone();
      return;
    }
    const elapsed = clock.sinceAnchor(t);
    if (elapsed === null) {
      host.frameDone();
      return;
    }
    if (this.debugHold) {
      // Held by the debugger — no steps (and nothing applied at the
      // boundary) except the single steps it allowed; the clock resumes from here.
      if (this.debugSteps > 0) {
        this.debugSteps -= 1;
        if (!host.step()) return;
        this.stepObserver?.(sim.stepIndex);
      }
      clock.anchorAt(t, sim.simTime);
      host.frameDone();
      return;
    }
    if (this.paused) {
      // No steps while paused; the clock resumes from here.
      // Scene loads/unloads still apply (a paused game's menu may
      // show another scene — the title background); this is the same step
      // boundary the next step would apply them at, so runs replay alike.
      if (!host.pausedBoundary()) return;
      clock.anchorAt(t, sim.simTime);
      host.frameDone();
      return;
    }
    // The game mode's time scale — fewer or more fixed steps per wall second, each
    // step unchanged (1 without modes: exactly the arithmetic before).
    const due = clock.due(elapsed, sim.simTime, sim.dt);
    let held = false;
    for (let i = 0; i < due.n; i += 1) {
      // A fail-stop (or a plain step's 3D physics fail-stop): no further frame/onFrame.
      if (!host.step()) return;
      this.stepObserver?.(sim.stepIndex);
      // An observer that held the simulation (an input exercise with `hold`) stops the frame's steps right there.
      if (this.debugHold) {
        this.debugSteps = 0;
        held = true;
        break;
      }
      // A breakpoint holds right after the step it hit.
      if (this.stepWatcher !== null && this.stepWatcher(sim.stepIndex)) {
        this.debugHold = true;
        this.debugSteps = 0;
        held = true;
        break;
      }
    }
    if (held) clock.anchorAt(t, sim.simTime);
    else clock.settle(t, sim.simTime, sim.dt, due, this.phased);
    const scale = host.timeScale();
    if (scale !== null) clock.rescale(t, sim.simTime, scale);
    host.frameDone();
  }
}
