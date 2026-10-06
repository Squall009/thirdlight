/**
 * Dynamic resolution: the render scale lowered while the GPU takes longer
 * than a frame's budget, raised again when it has room. Pure (no three.js):
 * the adapter feeds it each drawn frame and draws the next one at the scale
 * it answers.
 *
 * What it reads: the GPU's time per frame (timestamp queries, `gpu-timing.ts`)
 * where the renderer measures it — the only load a lower resolution relieves.
 * Without GPU timing (WebGL 2 without the disjoint timer extension) it reads
 * the time between frames, and only counts a slow frame as the GPU's when
 * the page's own work was well inside the budget (a frame slow on the CPU
 * gets nothing from fewer pixels).
 *
 * Never thrash (Unity's and Unreal's dynamic resolution have the same three
 * guards): decisions are made on windows of frames, not single frames; a
 * step down needs two slow windows in a row, a step up a longer run of fast
 * ones *predicted* to stay inside the budget at the higher scale (GPU time
 * grows with the pixels, the scale squared); and an up step undone by a down
 * step soon after doubles the wait before the next up step.
 */

/** The decision window: long enough to average a resolve's frames, short enough to react within half a second. */
export const DRS_WINDOW_MS = 250;
/** Scales are multiples of this (a target resize per step, never per frame). */
export const DRS_STEP = 0.05;
/** A window is over budget past this share of it (the rest is headroom for spikes). */
export const DRS_OVER = 0.9;
/** A step down aims at this share of the budget. */
export const DRS_DOWN_TARGET = 0.8;
/** A step up is taken only when the load at the higher scale is predicted under this share of the budget. */
export const DRS_UP_TARGET = 0.7;
/** Slow windows in a row before a step down. */
export const DRS_DOWN_WINDOWS = 2;
/** Fast windows in a row before a step up (doubled after an up step that did not hold, up to `DRS_UP_WINDOWS_MAX`). */
export const DRS_UP_WINDOWS = 6;
export const DRS_UP_WINDOWS_MAX = 48;
/** An up step followed by a down step within this time did not hold. */
export const DRS_HOLD_MS = 4000;
/** After this long without a down step the up wait is back to `DRS_UP_WINDOWS`. */
export const DRS_SETTLE_MS = 20000;
/** The largest single up step (a big jump from a short sample could overshoot). */
export const DRS_MAX_UP = 0.25;
/** Without GPU timing: a frame interval past this share of the budget is a missed frame. */
export const DRS_FRAME_SLOW = 1.2;
/** Without GPU timing: the page's work under this share of the budget leaves the slow frame to the GPU. */
export const DRS_CPU_SHARE = 0.6;
/** Without GPU timing: the fixed step (there is no load to aim at). */
export const DRS_FRAME_STEP = 0.1;

export interface DynamicResolutionFrame {
  /** performance.now() of the frame. */
  readonly now: number;
  /** GPU ms per frame resolved since the last call (null: none resolved). */
  readonly gpuMs: number | null;
  /** Whether the renderer measures GPU time at all (else the frame interval stands in). */
  readonly measuresGpu: boolean;
  /** Time since the last drawn frame (null: the first). */
  readonly intervalMs: number | null;
  /** The page's own work for the frame (ms). */
  readonly cpuMs: number;
  /** The frame's budget (ms): the frame-rate cap's, else 60 fps. */
  readonly budgetMs: number;
}

export interface DynamicResolutionState {
  readonly scale: number;
  readonly source: 'gpu' | 'frame' | null;
  /** The last window's load (GPU ms, or frame ms without GPU timing). */
  readonly loadMs: number | null;
  readonly stepsDown: number;
  readonly stepsUp: number;
  /** Windows of fast frames the next up step waits for. */
  readonly upWait: number;
  /** A forced load is being added (`stress`; a diagnostic). */
  readonly stressed: boolean;
}

const quantize = (s: number): number => Number((Math.round(s / DRS_STEP) * DRS_STEP).toFixed(4));
const floorStep = (s: number): number => Number((Math.floor(s / DRS_STEP + 1e-6) * DRS_STEP).toFixed(4));

export class DynamicResolution {
  private scale: number;
  private min: number;
  private max: number;
  private windowStart: number | null = null;
  private gpuSum = 0;
  private gpuN = 0;
  private intervalSum = 0;
  private intervalN = 0;
  private cpuSum = 0;
  private cpuN = 0;
  private measuresGpu = false;
  private slow = 0;
  private fast = 0;
  private upWait = DRS_UP_WINDOWS;
  private lastUpAt = -Infinity;
  private lastDownAt = -Infinity;
  private stepsDown = 0;
  private stepsUp = 0;
  private loadMs: number | null = null;
  private source: 'gpu' | 'frame' | null = null;
  private stressUntil = -Infinity;
  private stressFrom = Infinity;
  private stressPending = 0;
  private lastNow = 0;

  constructor(min: number, max: number) {
    this.min = min;
    this.max = Math.max(min, max);
    this.scale = this.max;
  }

  /** The range (the project's or player's render scale is the most): the scale is kept inside it. */
  setRange(min: number, max: number): void {
    this.min = min;
    this.max = Math.max(min, max);
    this.scale = Math.min(this.max, Math.max(this.min, this.scale));
  }

  /** Start again at the most (a new range from a setting, dynamic resolution turned on). */
  reset(): void {
    this.scale = this.max;
    this.windowStart = null;
    this.slow = 0;
    this.fast = 0;
    this.upWait = DRS_UP_WINDOWS;
    this.clearWindow();
  }

  /**
   * A diagnostic: for `ms` from the next frame on, every frame counts as two
   * budgets slower than it was — a forced overload (`?slowFrames=`), so a test
   * sees the scale step down and, after it, back up.
   */
  stress(ms: number): void {
    this.stressPending = ms;
  }

  current(): number {
    return this.scale;
  }

  state(): DynamicResolutionState {
    return { scale: this.scale, source: this.source, loadMs: this.loadMs, stepsDown: this.stepsDown, stepsUp: this.stepsUp, upWait: this.upWait, stressed: this.lastNow >= this.stressFrom && this.lastNow < this.stressUntil };
  }

  /** One drawn frame; the scale to draw the next one at. */
  frame(f: DynamicResolutionFrame): number {
    this.lastNow = f.now;
    if (this.stressPending > 0) {
      this.stressFrom = f.now;
      this.stressUntil = f.now + this.stressPending;
      this.stressPending = 0;
    }
    if (this.windowStart === null) this.windowStart = f.now;
    const stress = f.now >= this.stressFrom && f.now < this.stressUntil ? f.budgetMs * 2 : 0;
    this.measuresGpu = f.measuresGpu;
    if (f.gpuMs !== null) {
      this.gpuSum += f.gpuMs + stress;
      this.gpuN += 1;
    }
    if (f.intervalMs !== null) {
      this.intervalSum += f.intervalMs + stress;
      this.intervalN += 1;
    }
    this.cpuSum += f.cpuMs;
    this.cpuN += 1;
    if (f.now - this.windowStart < DRS_WINDOW_MS) return this.scale;
    this.decide(f.now, f.budgetMs);
    this.windowStart = f.now;
    this.clearWindow();
    return this.scale;
  }

  private clearWindow(): void {
    this.gpuSum = 0;
    this.gpuN = 0;
    this.intervalSum = 0;
    this.intervalN = 0;
    this.cpuSum = 0;
    this.cpuN = 0;
  }

  private decide(now: number, budget: number): void {
    if (now - this.lastDownAt > DRS_SETTLE_MS) this.upWait = DRS_UP_WINDOWS;
    if (this.measuresGpu) {
      // A window without a resolved GPU time (resolves lag a few frames) decides nothing.
      if (this.gpuN === 0) return;
      const load = this.gpuSum / this.gpuN;
      this.source = 'gpu';
      this.loadMs = load;
      if (load > budget * DRS_OVER) {
        this.fast = 0;
        if (++this.slow < DRS_DOWN_WINDOWS) return;
        // GPU time follows the pixels: the scale that brings the load to the target, at least one step down.
        const aim = floorStep(this.scale * Math.sqrt((budget * DRS_DOWN_TARGET) / load));
        this.down(now, Math.min(aim, this.scale - DRS_STEP));
        return;
      }
      this.slow = 0;
      if (this.scale >= this.max) return;
      const up = Math.min(this.max, this.scale + DRS_MAX_UP, floorStep(this.scale * Math.sqrt((budget * DRS_UP_TARGET) / load)));
      if (up <= this.scale + 1e-6) {
        this.fast = 0;
        return;
      }
      if (++this.fast < this.upWait) return;
      this.up(now, up);
      return;
    }
    if (this.intervalN === 0) return;
    const interval = this.intervalSum / this.intervalN;
    const cpu = this.cpuSum / Math.max(1, this.cpuN);
    this.source = 'frame';
    this.loadMs = interval;
    if (interval > budget * DRS_FRAME_SLOW && cpu < budget * DRS_CPU_SHARE) {
      this.fast = 0;
      if (++this.slow < DRS_DOWN_WINDOWS) return;
      this.down(now, this.scale - DRS_FRAME_STEP);
      return;
    }
    this.slow = 0;
    if (this.scale >= this.max || interval > budget * DRS_FRAME_SLOW) {
      this.fast = 0;
      return;
    }
    // No load to aim at: a fixed step, after twice the wait (a step that does not hold costs a visible change).
    if (++this.fast < this.upWait * 2) return;
    this.up(now, this.scale + DRS_FRAME_STEP);
  }

  private down(now: number, to: number): void {
    const next = Math.max(this.min, quantize(to));
    this.slow = 0;
    this.fast = 0;
    if (next >= this.scale) return;
    if (now - this.lastUpAt < DRS_HOLD_MS) this.upWait = Math.min(DRS_UP_WINDOWS_MAX, this.upWait * 2);
    this.scale = next;
    this.lastDownAt = now;
    this.stepsDown += 1;
  }

  private up(now: number, to: number): void {
    const next = Math.min(this.max, quantize(to));
    this.fast = 0;
    if (next <= this.scale) return;
    this.scale = next;
    this.lastUpAt = now;
    this.stepsUp += 1;
  }
}

/** The page flag that forces slow frames for this many seconds after the first one (`?slowFrames=3`; a diagnostic of dynamic resolution). */
export const SLOW_FRAMES_URL_PARAM = 'slowFrames';

/** The forced overload a page's query string asks for (ms; 0: none). */
export function slowFramesFromUrl(search: string): number {
  const v = Number(new URLSearchParams(search).get(SLOW_FRAMES_URL_PARAM));
  return Number.isFinite(v) && v > 0 ? Math.min(600, v) * 1000 : 0;
}
