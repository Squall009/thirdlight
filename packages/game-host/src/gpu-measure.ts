/**
 * The page's GPU time per pass category (near, far, shadows, lighting, post,
 * effects), measured on demand at the display's cap without timestamps.
 *
 * At a frame-rate cap a GPU's timestamps follow its clock governor (the clock
 * drops when a frame leaves the GPU idle, so the same work reads more ms on a
 * light frame). So the frame is first loaded past its cap with ballast (a
 * fixed full-screen load, three-adapter gpu-headroom.ts) until the GPU, busy
 * and at its busy clock, sets the frame interval; then a category's passes are
 * hidden for a window (three-adapter gpu-pass-hides.ts) and the interval it
 * saves is its time.
 *
 * Frames are timed by when the GPU finished them (WebGPU's
 * `onSubmittedWorkDone` after each frame), not by when the page submitted
 * them: past the cap the page submits in bursts (a few frames at once, then a
 * long wait), so a window's mean from submission times moves by a burst's
 * length divided by the window's frames — several ms — while the GPU finishes
 * the same frames evenly.
 *
 * The windows are interleaved: every hidden window sits between two windows
 * with everything shown, and its reading is the mean of those two less its own,
 * so a clock or temperature drifting over the run moves both sides alike. The
 * whole sequence is repeated (category order rotated each time), and a
 * category is reported as the median of its readings with their spread (the
 * interquartile range). A control reading that hides nothing gives the
 * routine's own noise: a category whose median is not above its spread and
 * that noise is reported "below resolution", never as a number (and never as
 * a negative one).
 */
import { frameBudgetMs, GPU_PASS_BUDGET, GPU_PASS_CATEGORIES, type FrameBudget, type GpuPassCategory } from '@thirdlight/runtime';
import type { SpanCategory } from '@thirdlight/shared';

/** What of a page's renderer a measurement drives (three-adapter gpu-measure-target.ts makes it; this module stays free of three). */
export interface GpuMeasureTarget {
  /** Why the page cannot measure (null: it can). */
  unavailable(): string | null;
  /** The passes registered and present now, by category. */
  present(): Partial<Record<GpuPassCategory, readonly string[]>>;
  /** Exactly these categories hidden (every other shown). */
  hide(categories: readonly GpuPassCategory[]): void;
  /** Ballast copies a frame (0: none). */
  ballast(n: number): void;
  readonly ballastMax: number;
  /** The intervals (ms) between the frames the GPU finished over the next `seconds`. */
  record(seconds: number): Promise<number[]>;
  /** The render scale held at its own and dynamic resolution off while on (it would draw smaller under the load). */
  hold(on: boolean): void;
}

export interface GpuMeasureOptions {
  /** Seconds a window (default 1.5). */
  readonly windowS?: number;
  /** Seconds after each change before a window (default 0.4). */
  readonly settleS?: number;
  /** Times the interleaved sequence runs (default 5). */
  readonly repeats?: number;
  /** Only these categories (default every one with a pass present): a later pass's own reading in less time. */
  readonly only?: readonly GpuPassCategory[];
}

/** One category's reading. */
export interface GpuCategoryReading {
  readonly category: GpuPassCategory;
  /** The passes hidden for it. */
  readonly passes: readonly string[];
  /** Its readings (ms the frame saved with it hidden), one per repeat. */
  readonly samples: readonly number[];
  readonly medianMs: number;
  /** The readings' interquartile range (ms). */
  readonly spreadMs: number;
  /** The median is not above its spread or the routine's noise: no number is given. */
  readonly belowResolution: boolean;
  /** The reading (null: below resolution). */
  readonly ms: number | null;
  /** Some window with it hidden left the GPU no longer past the cap: the reading is at least this. */
  readonly lowerBound: boolean;
}

/** The measured categories held against one GPU budget row. */
export interface GpuBudgetReading {
  readonly budget: SpanCategory;
  readonly budgetMs: number;
  readonly categories: readonly GpuPassCategory[];
  /** The readings above resolution summed (null: none was). */
  readonly ms: number | null;
}

export interface GpuMeasurement {
  /** When it finished (wall ms) and how long it took. */
  readonly at: number;
  readonly seconds: number;
  /** The interval the frames are capped at (ms) and the ballast past it. */
  readonly intervalMs: number;
  readonly ballast: { readonly n: number; readonly msPerUnit: number | null; readonly frameMs: number };
  /** The frame's GPU ms without the ballast, at the busy clock (the line through the ballast's points; null: one point only). */
  readonly frameMs: number | null;
  /** The control: nothing hidden, read as a category is. */
  readonly noise: { readonly samples: readonly number[]; readonly medianMs: number; readonly spreadMs: number };
  /** The smallest reading the run can tell from none (ms): the control's spread or its offset, whichever is larger. */
  readonly resolutionMs: number;
  readonly categories: readonly GpuCategoryReading[];
  /** Categories no pass is registered for or present in on this page. */
  readonly absent: readonly GpuPassCategory[];
  readonly budget: { readonly tier: FrameBudget['tier']; readonly rows: readonly GpuBudgetReading[] };
  readonly options: Required<GpuMeasureOptions>;
  /** Every window in order: what it measured, its frames, mean and quantiles of the frame intervals (ms). */
  readonly windows: readonly GpuWindowTrace[];
}

export interface GpuWindowTrace {
  readonly doing: string;
  readonly frames: number;
  readonly meanMs: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

export type GpuMeasureState =
  | { readonly state: 'idle' }
  | { readonly state: 'unavailable'; readonly reason: string }
  | { readonly state: 'running'; readonly startedAt: number; readonly step: number; readonly steps: number; readonly doing: string; readonly last: GpuMeasurement | null }
  | { readonly state: 'done'; readonly result: GpuMeasurement }
  | { readonly state: 'failed'; readonly error: string; readonly last: GpuMeasurement | null };

const DEFAULTS: Required<GpuMeasureOptions> = { windowS: 1.5, settleS: 0.4, repeats: 5, only: GPU_PASS_CATEGORIES };
/** A window's mean over the cap by this share is past it (the GPU sets the interval). */
const PAST_CAP = 1.15;
/** A frame this long is a stall (a program built), not the GPU's time. */
const STALL_MS = 100;
/** Windows a program build is waited out for after a pass is first hidden or shown. */
const WARM_TRIES = 8;
const BALLAST_START = 32;

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The q-quantile of sorted values, linear between ranks. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Median and interquartile range of readings. */
export function readingStats(samples: readonly number[]): { medianMs: number; spreadMs: number } {
  const s = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { medianMs: round2(quantile(s, 0.5)), spreadMs: round2(quantile(s, 0.75) - quantile(s, 0.25)) };
}

/** The routine's resolution from its control readings (nothing hidden): their spread or their offset from zero. */
export function resolutionOf(noise: readonly number[]): number {
  const n = readingStats(noise);
  return round2(Math.max(n.spreadMs, Math.abs(n.medianMs)));
}

/** A category's reading from its samples, against the routine's resolution. */
export function categoryReading(category: GpuPassCategory, passes: readonly string[], samples: readonly number[], resolutionMs: number, lowerBound = false): GpuCategoryReading {
  const { medianMs, spreadMs } = readingStats(samples);
  const belowResolution = !(medianMs > spreadMs && medianMs > resolutionMs);
  return { category, passes, samples: samples.map(round2), medianMs, spreadMs, belowResolution, ms: belowResolution ? null : medianMs, lowerBound };
}

/** The GPU budget rows with the readings above resolution held against them. */
export function budgetReadings(budget: FrameBudget, readings: readonly GpuCategoryReading[]): GpuBudgetReading[] {
  return Object.keys(budget.gpu).map((b) => {
    const budgetCat = b as SpanCategory;
    const cats = GPU_PASS_CATEGORIES.filter((c) => GPU_PASS_BUDGET[c] === budgetCat);
    const read = readings.filter((r) => cats.includes(r.category) && r.ms !== null);
    return { budget: budgetCat, budgetMs: round2(frameBudgetMs(budget, 'gpu', budgetCat)), categories: cats, ms: read.length === 0 ? null : round2(read.reduce((n, r) => n + r.ms!, 0)) };
  });
}

/** Frame times closer than this arrived together (one delivery of several finished frames), not one frame apart. */
const BURST_MS = 8;

/**
 * The mean frame interval of a window (ms; NaN without enough frames).
 * Past the cap the GPU's completions reach the page in bursts (two frames'
 * a fraction of a millisecond apart, then a gap of two frames), each burst
 * when its last frame finished. A window's own span would count a whole burst
 * more or less depending on where it starts and ends (at 15 frames a window,
 * a mean four milliseconds off either way); so the span is taken from the
 * first burst to the last, over the frames that finished after the first.
 */
export function windowMean(intervals: readonly number[]): number {
  if (intervals.length < 4) return Number.NaN;
  let t = 0;
  let firstAt = 0;
  let lastAt = 0;
  let frames = 0;
  let inLast = 1;
  let bursts = 1;
  for (const d of intervals) {
    t += d;
    if (d < BURST_MS) {
      inLast += 1;
      continue;
    }
    // A new burst: the frames of the one before it finished since the first burst.
    if (bursts > 1) frames += inLast;
    else firstAt = t - d;
    bursts += 1;
    lastAt = t;
    inLast = 1;
  }
  frames += inLast;
  // `firstAt` is the first burst's delivery (its last frame); every frame after it, the last burst's included.
  return bursts < 3 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : (lastAt - firstAt) / frames;
}
const meanOf = windowMean;

/** The least-squares line through (ballast, ms) points (null with fewer than two distinct loads). */
function line(points: readonly { n: number; ms: number }[]): { slope: number; intercept: number } | null {
  if (new Set(points.map((p) => p.n)).size < 2) return null;
  const mx = points.reduce((a, p) => a + p.n, 0) / points.length;
  const my = points.reduce((a, p) => a + p.ms, 0) / points.length;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.n - mx) * (p.ms - my);
    sxx += (p.n - mx) ** 2;
  }
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx };
}

/** The number of windows (each a step of progress) a run takes for `k` categories. */
export function measureSteps(k: number, repeats: number): number {
  return k * 2 + 6 + repeats * (2 * (k + 1) + 1);
}

/**
 * One measurement on `target` (frames capped at `intervalMs`; budget rows from
 * `budget`). Everything hidden or loaded is given back when it ends, failed or
 * not. `progress` hears each window; `cancelled` is asked between windows.
 */
export async function measureGpu(target: GpuMeasureTarget, intervalMs: number, budget: FrameBudget, options: GpuMeasureOptions = {}, progress: (step: number, steps: number, doing: string) => void = () => undefined, cancelled: () => boolean = () => false): Promise<GpuMeasurement> {
  const o: Required<GpuMeasureOptions> = { ...DEFAULTS, ...options };
  const t0 = Date.now();
  const present = target.present();
  const cats = GPU_PASS_CATEGORIES.filter((c) => (present[c]?.length ?? 0) > 0 && o.only.includes(c));
  const steps = measureSteps(cats.length, o.repeats);
  let step = 0;
  const wait = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));
  const trace: GpuWindowTrace[] = [];
  const window = async (doing: string, seconds = o.windowS): Promise<number[]> => {
    if (cancelled()) throw new Error('cancelled');
    step = Math.min(steps, step + 1);
    progress(step, steps, doing);
    await wait(o.settleS);
    const iv = await target.record(seconds);
    const sorted = [...iv].sort((a, b) => a - b);
    trace.push({ doing, frames: iv.length, meanMs: round2(windowMean(iv)), p50: round2(quantile(sorted, 0.5)), p90: round2(quantile(sorted, 0.9)), max: round2(sorted.at(-1) ?? 0) });
    return iv;
  };
  target.hold(true);
  try {
    // Programs built for every hidden state before anything is timed (a light that stops casting builds again).
    for (const c of cats) {
      for (const hidden of [[c], []] as GpuPassCategory[][]) {
        target.hide(hidden);
        for (let i = 0; i < WARM_TRIES; i++) if ((await window(`warming ${c}`, 1)).every((d) => d < STALL_MS)) break;
      }
    }
    // The load past the cap: doubled until the frame is well past it, then a line through the points past it.
    const aimMs = Math.max(1.5 * intervalMs, intervalMs + 20);
    const points: { n: number; ms: number }[] = [];
    let n = BALLAST_START;
    for (;;) {
      target.ballast(n);
      const frames = await window(`loading ${n}`, 1);
      // No frame times at all (a page that draws nothing, or completions that never arrive): nothing can be read.
      if (n === BALLAST_START && frames.length < 4) throw new Error(`no GPU frame times arrived (${frames.length} in a second)`);
      const ms = meanOf(frames);
      if (ms > PAST_CAP * intervalMs) points.push({ n, ms });
      if (ms >= aimMs || n >= target.ballastMax) break;
      n = Math.min(target.ballastMax, n * 2);
    }
    for (const m of [Math.round(n * 0.75), Math.round(n * 0.6)]) {
      target.ballast(m);
      const ms = meanOf(await window(`loading ${m}`, 1));
      if (ms > PAST_CAP * intervalMs) points.push({ n: m, ms });
    }
    const fit = line(points);
    const at = fit !== null && fit.slope > 0 ? Math.max(1, Math.min(target.ballastMax, Math.round((aimMs - fit.intercept) / fit.slope))) : n;
    target.ballast(at);
    // The interleaved sequence: shown, hidden, shown, … ; the control ('none') hides nothing.
    const order: (GpuPassCategory | 'none')[] = [...cats, 'none'];
    const samples = new Map<GpuPassCategory | 'none', number[]>(order.map((c) => [c, []]));
    const lowered = new Set<GpuPassCategory>();
    const baseMeans: number[] = [];
    for (let r = 0; r < o.repeats; r++) {
      const turn = order.map((_, i) => order[(i + r) % order.length]!);
      target.hide([]);
      let before = meanOf(await window('everything shown'));
      baseMeans.push(before);
      for (const c of turn) {
        target.hide(c === 'none' ? [] : [c]);
        const hidden = meanOf(await window(c === 'none' ? 'control' : `${c} hidden`));
        target.hide([]);
        const after = meanOf(await window('everything shown'));
        baseMeans.push(after);
        const reading = (before + after) / 2 - hidden;
        if (Number.isFinite(reading)) samples.get(c)!.push(reading);
        if (c !== 'none' && !(hidden > PAST_CAP * intervalMs)) lowered.add(c);
        before = after;
      }
    }
    const noise = samples.get('none')!;
    const resolutionMs = resolutionOf(noise);
    const categories = cats.map((c) => categoryReading(c, present[c] ?? [], samples.get(c)!, resolutionMs, lowered.has(c)));
    const base = baseMeans.filter(Number.isFinite);
    return {
      at: Date.now(),
      seconds: round2((Date.now() - t0) / 1000),
      intervalMs: round2(intervalMs),
      ballast: { n: at, msPerUnit: fit === null ? null : Math.round(fit.slope * 1e4) / 1e4, frameMs: round2(base.length === 0 ? Number.NaN : base.reduce((a, b) => a + b, 0) / base.length) },
      frameMs: fit === null ? null : round2(fit.intercept),
      noise: { samples: noise.map(round2), ...readingStats(noise) },
      resolutionMs,
      categories,
      absent: GPU_PASS_CATEGORIES.filter((c) => o.only.includes(c) && !cats.includes(c)),
      budget: { tier: budget.tier, rows: budgetReadings(budget, categories) },
      options: o,
      windows: trace,
    };
  } finally {
    try {
      target.hide([]);
    } finally {
      target.ballast(0);
      target.hold(false);
    }
  }
}

/** One measurement at a time on a page, its progress and its last result, for every caller (the Profiler tab, the overlay, MCP, the bench). */
export class GpuMeasureRun {
  private now: GpuMeasureState = { state: 'idle' };
  private last: GpuMeasurement | null = null;
  private stop = false;

  constructor(private readonly source: () => { target: GpuMeasureTarget | null; intervalMs: number; budget: FrameBudget }) {}

  /** Starts one unless one runs (the state now either way). */
  start(options: GpuMeasureOptions = {}): GpuMeasureState {
    if (this.now.state === 'running') return this.now;
    const { target, intervalMs, budget } = this.source();
    const why = target === null ? 'no renderer on this page' : target.unavailable();
    if (target === null || why !== null) {
      this.now = { state: 'unavailable', reason: why ?? 'no renderer on this page' };
      return this.now;
    }
    this.stop = false;
    const startedAt = Date.now();
    const k = GPU_PASS_CATEGORIES.filter((c) => (target.present()[c]?.length ?? 0) > 0 && (options.only ?? GPU_PASS_CATEGORIES).includes(c)).length;
    this.now = { state: 'running', startedAt, step: 0, steps: measureSteps(k, options.repeats ?? DEFAULTS.repeats), doing: 'starting', last: this.last };
    void measureGpu(target, intervalMs, budget, options, (step, steps, doing) => {
      this.now = { state: 'running', startedAt, step, steps, doing, last: this.last };
    }, () => this.stop).then(
      (result) => {
        this.last = result;
        this.now = { state: 'done', result };
      },
      (e: unknown) => {
        this.now = { state: 'failed', error: e instanceof Error ? e.message : String(e), last: this.last };
      },
    );
    return this.now;
  }

  /** A running measurement stops at its next window (everything is given back). */
  cancel(): void {
    this.stop = true;
  }

  state(): GpuMeasureState {
    return this.now;
  }
}
