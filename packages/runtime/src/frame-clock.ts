/**
 * The runtime's frame clock: how many fixed steps a frame at wall time `t`
 * owes, the bounded catch-up after a stall, and the interpolation alpha the
 * renderer draws with.
 *
 * The clock is anchored at a frame (wall seconds, simTime); every later frame
 * owes the steps between the anchor's simTime and the anchor's simTime plus
 * the wall time since, scaled by the game mode's time scale. Anything that
 * stops the steps (a pause, the debugger, a dropped catch-up, a scale change)
 * re-anchors it, so game time resumes from where it stopped instead of
 * jumping. The step loop itself stays in the runtime (it runs modules,
 * observers and breakpoints); this module is only the arithmetic and its
 * counters.
 */

/**
 * Game time one frame may catch up before the rest is dropped: a slow frame
 * must not make the next one slower. A time, not a step count, so a game
 * with a fast fixed step (240 Hz) still keeps real-time speed at 30 fps
 * instead of falling into slow motion.
 */
export const MAX_CATCHUP_SECONDS = 0.1;

/**
 * Floating-point guard for the floor-based step count. When the
 * wall-derived `elapsed` is a mathematical multiple of `dt`,
 * `(targetSim − simTime) / dt` can round to e.g. 11.999999999999998;
 * double-precision rounding at realistic elapsed values is ~1e-13 in step
 * units, so a 1e-9 guard corrects exact-multiple cases without ever
 * running a step early (at most ~1e-9 of a step ≈ 8e-12 s). Determinism
 * is preserved: the same floating-point inputs yield the same count
 *  — the guard is a fixed part of the computation.
 */
const STEP_COUNT_EPS = 1e-9;

/**
 * The wall time a free-running preview (an animation, a particle or timeline
 * preview: no fixed steps) advances by in one frame, from two animation-frame
 * times in milliseconds: never negative, and a stall (a hidden tab, a
 * breakpoint) moves it on by no more than a catch-up's worth, not a jump.
 */
export function previewFrameSeconds(nowMs: number, lastMs: number): number {
  return Math.min(MAX_CATCHUP_SECONDS, Math.max(0, (nowMs - lastMs) / 1000));
}

/** The steps one frame may catch up at steps of `dt` seconds (at least one). */
export function catchUpSteps(dt: number): number {
  return Math.max(1, Math.floor(MAX_CATCHUP_SECONDS / dt + STEP_COUNT_EPS));
}

interface WallAnchor {
  /** Wall seconds of the anchor frame. */
  wall: number;
  /** simTime at the anchor frame. */
  simTime: number;
}

/** The steps one frame owes. */
export interface DueSteps {
  /** The simTime the wall clock asks for. */
  readonly targetSim: number;
  /** Every step the clock asks for. */
  readonly rawN: number;
  /** The steps this frame runs (at most `MAX_CATCHUP_SECONDS` of them). */
  readonly n: number;
}

/**
 * An interpolation alpha held to 0 ≤ alpha < 1 (the invariant every reader
 * relies on). Here the v ≥ 1 edge is defensive; a presenter that moves the
 * alpha on by its own clock (the worker's mirror) reaches it whenever the
 * next step is late, and stops just short of the last step.
 */
export function clampAlpha(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v >= 1) return 1 - 1e-9;
  return v;
}

export class FrameClock {
  private anchor: WallAnchor | null = null;
  /** The mode's time scale the clock was anchored with (a change re-anchors it). */
  scale = 1;
  /** The last frame's interpolation alpha. */
  alpha = 0;
  /** Frame updates, including zero-step frames. */
  frameCount = 0;
  droppedSteps = 0;
  droppedInputSteps = 0;
  clockWarningCount = 0;

  get anchored(): boolean {
    return this.anchor !== null;
  }

  /** Anchor the clock at this frame: game time resumes from `simTime` (no catch-up for the time before). */
  anchorAt(t: number, simTime: number): void {
    this.anchor = { wall: t, simTime };
    this.alpha = 0;
  }

  /** Forget the anchor (the next frame anchors again). */
  clear(): void {
    this.anchor = null;
  }

  /**
   * Wall seconds since the anchor, or null when the clock went backwards
   * (zero steps and one clock warning, no error; the anchor stays).
   */
  sinceAnchor(t: number): number | null {
    const elapsed = t - this.anchor!.wall;
    if (elapsed < 0) {
      this.clockWarningCount += 1;
      this.alpha = 0;
      return null;
    }
    return elapsed;
  }

  /** The steps owed `elapsed` wall seconds after the anchor, at `simTime` with steps of `dt`. */
  due(elapsed: number, simTime: number, dt: number): DueSteps {
    const targetSim = this.anchor!.simTime + elapsed * this.scale;
    const rawN = Math.floor((targetSim - simTime) / dt + STEP_COUNT_EPS);
    return { targetSim, rawN, n: Math.min(rawN, catchUpSteps(dt)) };
  }

  /**
   * The frame ran its steps: past the catch-up bound the remainder is dropped
   * and the clock re-anchored (no unbounded burst after a stall; alpha 0),
   * else the alpha is where the wall clock falls between the last two steps.
   * `inputSteps`: the dropped steps also count as dropped input steps.
   */
  settle(t: number, simTime: number, dt: number, due: DueSteps, inputSteps: boolean): void {
    const dropped = due.rawN - due.n;
    if (dropped > 0) {
      // The resync makes targetSim == simTime for the display, so alpha = 0.
      this.droppedSteps += dropped;
      if (inputSteps) this.droppedInputSteps += dropped;
      this.anchorAt(t, simTime);
    } else {
      this.alpha = clampAlpha((due.targetSim - simTime) / dt);
    }
  }

  /** A switch changed the time scale: the clock is re-anchored here (no jump). */
  rescale(t: number, simTime: number, scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.anchorAt(t, simTime);
  }
}
