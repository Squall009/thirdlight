/**
 * The GPU headroom meter's arithmetic (the `headroom` bench, headroom-cli.ts):
 * frame windows read at a frame-rate cap (the display's 60 Hz, or a quality
 * level's own, low's 30) and the search for the load at which the frames
 * start to miss.
 *
 * Why it works without timestamps: at the cap a GPU with room sleeps part of
 * every frame and its clock drops, so its timestamps read more ms for the same
 * work. A load that makes frames miss keeps it busy: the load at the edge says
 * how much room the frame had (in load units). GPU ms per pass past the edge
 * are the page's own measurement (game-host gpu-measure.ts), which the bench
 * reads.
 */

/** The display's refresh rate the bench runs at (this host's panel; Chrome's vsync). */
export const DISPLAY_HZ = 60;

/**
 * A frame-rate cap's numbers: its budget (ms a frame) and the interval over
 * which a frame missed it (its budget and half a display refresh: at a 60
 * cap 25 ms, one and a half vsyncs; at a 30 cap 41.7 ms, a frame that took
 * three vsyncs instead of two).
 */
export interface FrameCap {
  readonly fps: number;
  readonly budgetMs: number;
  readonly missMs: number;
}

export function frameCap(fps: number, displayHz = DISPLAY_HZ): FrameCap {
  const budgetMs = 1000 / fps;
  return { fps, budgetMs, missMs: budgetMs + 500 / displayHz };
}

/** The display's own cap (60 Hz). */
export const CAP_60 = frameCap(DISPLAY_HZ);

/** A frame longer than this missed the 60 Hz cap (one and a half vsyncs). */
export const MISS_MS = CAP_60.missMs;

/** A window misses when more than this share of its frames missed. */
export const MISS_SHARE = 0.02;

/** A frame this long is a stall, not a missed vsync (the high tier's long frames). */
export const STALL_MS = 100;

/** The 60 Hz cap's frame budget. */
export const CAP_MS = CAP_60.budgetMs;

export interface FrameWindow {
  readonly frames: number;
  readonly missed: number;
  readonly stalls: number;
  readonly meanMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** A window from its frame intervals (ms), its misses against `cap`. */
export function frameWindow(intervals: readonly number[], cap: FrameCap = CAP_60): FrameWindow {
  const s = [...intervals].sort((a, b) => a - b);
  const q = (p: number): number => (s.length === 0 ? 0 : round2(s[Math.min(s.length - 1, Math.floor(p * s.length))]!));
  const sum = s.reduce((a, b) => a + b, 0);
  return { frames: s.length, missed: s.filter((d) => d > cap.missMs).length, stalls: s.filter((d) => d > STALL_MS).length, meanMs: s.length === 0 ? 0 : round2(sum / s.length), p50: q(0.5), p95: q(0.95), max: q(1) };
}

/**
 * Whether a window missed the cap: more than {@link MISS_SHARE} of its frames
 * over the cap's miss interval, or a mean interval over the budget by more than 3 %
 * (a browser that presents a busy GPU's frames as they come, not on whole
 * vsyncs, shows 20 ms frames, none of them over 25 ms).
 */
export function misses(w: FrameWindow, cap: FrameCap = CAP_60): boolean {
  return w.frames === 0 || w.missed / w.frames > MISS_SHARE || w.meanMs > cap.budgetMs * 1.03;
}

export interface LimitProbe {
  readonly n: number;
  readonly window: FrameWindow;
  readonly missed: boolean;
}

export interface LimitResult {
  /** The largest load that held the cap (-1: even no load missed). */
  readonly held: number;
  /** The smallest load that missed (null: none up to the maximum). */
  readonly missedAt: number | null;
  readonly probes: readonly LimitProbe[];
}

/**
 * The load at which the frames start to miss: no load first, then doubling
 * from `start` until a window misses, then halving the gap until it is within
 * `precision` of the load held (at least 1). Few rounds: about
 * log2(limit) + log2(1 / precision) windows.
 */
export async function searchLimit(probe: (n: number) => Promise<FrameWindow>, o: { readonly max: number; readonly start?: number; readonly precision?: number; readonly cap?: FrameCap }): Promise<LimitResult> {
  const probes: LimitProbe[] = [];
  const run = async (n: number): Promise<boolean> => {
    const window = await probe(n);
    const missed = misses(window, o.cap);
    probes.push({ n, window, missed });
    return missed;
  };
  if (await run(0)) return { held: -1, missedAt: 0, probes };
  let held = 0;
  let missedAt: number | null = null;
  for (let n = Math.max(1, Math.floor(o.start ?? 1)); ; n = Math.min(o.max, n * 2)) {
    if (await run(n)) {
      missedAt = n;
      break;
    }
    held = n;
    if (n >= o.max) return { held, missedAt: null, probes };
  }
  const precision = o.precision ?? 0.1;
  while (missedAt - held > Math.max(1, Math.round(held * precision))) {
    const mid = Math.floor((held + missedAt) / 2);
    if (await run(mid)) missedAt = mid;
    else held = mid;
  }
  return { held, missedAt, probes };
}

/** Spread of repeated values: [min, max] and max − min. */
export function spread(values: readonly number[]): { readonly min: number; readonly max: number; readonly range: number } | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  return { min: round2(min), max: round2(max), range: round2(max - min) };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The share the far field's drawn nodes and bricks may move while it counts as settled ({@link FarSettle}). */
export const FAR_SETTLE_SHARE = 0.02;

/**
 * The fill's end: the far field drawn within {@link FAR_SETTLE_SHARE} of the same nodes and bricks for `holdMs`. Not
 * exactly the same: with visibility feedback a turning camera keeps changing a few nodes (what comes into view
 * refines, what left it for a while coarsens), so an exact match never comes.
 */
export class FarSettle {
  private ref: { nodes: number; bricks: number } | null = null;
  /** When the drawn field came within the share of what it is now. */
  since = 0;

  constructor(private readonly holdMs = 5000) {}

  /** A reading at `now` (ms); true once settled. */
  step(far: { readonly nodes: number; readonly bricks: number } | null | undefined, now: number): boolean {
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= FAR_SETTLE_SHARE * Math.max(a, b);
    if (far == null || far.nodes === 0 || this.ref === null || !near(far.nodes, this.ref.nodes) || !near(far.bricks, this.ref.bricks)) {
      this.ref = far == null ? null : { nodes: far.nodes, bricks: far.bricks };
      this.since = now;
      return false;
    }
    return now - this.since > this.holdMs;
  }
}
