/**
 * The GPU headroom meter's arithmetic (the `headroom` bench, headroom-cli.ts):
 * frame windows read at a frame-rate cap (the display's 60 Hz, or a quality
 * level's own, low's 30), the search for the load at which
 * the frames start to miss, and the line through the frame intervals once the
 * GPU is the bottleneck.
 *
 * Why it works without timestamps: at the cap a GPU with room sleeps part of
 * every frame and its clock drops, so its timestamps read more ms for the same
 * work. A load that makes frames miss keeps it busy: the load at the edge says
 * how much room the frame had (in load units), and past the edge the mean
 * frame interval is the GPU's own time per frame (at its busy clock), so two
 * loads past the edge give the unit's ms (the slope) and the frame's GPU ms
 * without the load (the intercept). A pass's ms is then the interval it saves
 * when hidden, past the edge, or the slope of its own extra copies.
 *
 * What it cannot give: the cost of a pass that does not show at the busy
 * clock (anything under one load step), and anything while the page's main
 * thread, not the GPU, sets the interval (copies report their CPU ms so a
 * reader can tell). Numbers carry the spread of their windows.
 */

/** The display's refresh rate the bench runs at (this host's panel; Chrome's vsync). */
export const DISPLAY_HZ = 60;

/**
 * A frame-rate cap's numbers: its budget (ms a frame), the interval over
 * which a frame missed it (its budget and half a display refresh: at a 60
 * cap 25 ms, one and a half vsyncs; at a 30 cap 41.7 ms, a frame that took
 * three vsyncs instead of two), and the mean interval the bench loads the
 * frame to past the edge (1.8 budgets, so a pass of several ms hidden still
 * leaves the frame past it).
 */
export interface FrameCap {
  readonly fps: number;
  readonly budgetMs: number;
  readonly missMs: number;
  readonly deepMs: number;
}

export function frameCap(fps: number, displayHz = DISPLAY_HZ): FrameCap {
  const budgetMs = 1000 / fps;
  return { fps, budgetMs, missMs: budgetMs + 500 / displayHz, deepMs: 1.8 * budgetMs };
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

export interface LineFit {
  /** ms a load unit adds to the frame interval. */
  readonly slope: number;
  /** The interval at no load, extrapolated (the frame's GPU ms at the busy clock). */
  readonly intercept: number;
  /** The largest distance of a point from the line (ms): how straight the points lie. */
  readonly worstResidual: number;
  readonly points: number;
}

/**
 * The least-squares line through (load, mean interval) points taken past the
 * edge. Null with fewer than two distinct loads.
 */
export function fitLine(points: readonly { readonly n: number; readonly ms: number }[]): LineFit | null {
  const k = points.length;
  if (k < 2 || new Set(points.map((p) => p.n)).size < 2) return null;
  const mx = points.reduce((a, p) => a + p.n, 0) / k;
  const my = points.reduce((a, p) => a + p.ms, 0) / k;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.n - mx) * (p.ms - my);
    sxx += (p.n - mx) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const worstResidual = Math.max(...points.map((p) => Math.abs(p.ms - (intercept + slope * p.n))));
  return { slope: round3(slope), intercept: round2(intercept), worstResidual: round2(worstResidual), points: k };
}

/** Whether a window is well past the edge, where the GPU sets the interval: a mean a quarter over the budget. */
export function saturated(w: FrameWindow, cap: FrameCap = CAP_60): boolean {
  return w.frames > 0 && w.meanMs > cap.budgetMs * 1.25;
}

export interface PassRow {
  readonly pass: string;
  /** How the share was read: the pass hidden, or one extra copy of it drawn. */
  readonly by: 'hidden' | 'copy';
  /** The pass in ballast copies: how much the interval moved, past the edge, over a ballast copy's slope. */
  readonly units: number;
  /** The same in ms (the interval moved past the edge, where the GPU sets it). */
  readonly ms: number;
  /** How many times the pass could be drawn before the frame misses (1 + room / pass); null with no room. */
  readonly headroomX: number | null;
  /** The window with the pass hidden was no longer past the edge: the ms is at least this (headroom × at most). */
  readonly lowerBound: boolean;
}

/**
 * A pass's share from two windows past the edge at the same ballast: the
 * frame as it is (`baseMs`) and with the pass hidden (its interval falls) or
 * copied once more (it rises). `slope`: a ballast copy's ms past the edge;
 * `roomUnits`: the ballast the frame held at the cap. A window that is no
 * longer well past the edge gives only a lower bound.
 */
export function passShare(pass: string, by: 'hidden' | 'copy', baseMs: number, withWindow: FrameWindow, slope: number, roomUnits: number, cap: FrameCap = CAP_60): PassRow {
  const ms = round2(by === 'hidden' ? baseMs - withWindow.meanMs : withWindow.meanMs - baseMs);
  const units = slope > 0 ? round2(ms / slope) : Number.NaN;
  return { pass, by, units, ms, headroomX: roomUnits > 0 && units > 0 ? round2(1 + roomUnits / units) : null, lowerBound: !saturated(withWindow, cap) };
}

/**
 * The frame's GPU ms two ways: from the edge (the budget less the room the
 * ballast found, at its slope) and from the line past it (its intercept).
 * They agree when the interval past the edge is the GPU's own time: then the
 * ms are given; when they do not, only ballast units are.
 */
export function frameGpu(line: LineFit, held: number, missedAt: number | null, cap: FrameCap = CAP_60): { readonly fromEdge: readonly [number, number] | null; readonly fromLine: number; readonly agree: boolean } {
  if (held < 0) return { fromEdge: null, fromLine: line.intercept, agree: false };
  const lo = round2(cap.budgetMs - (missedAt ?? held) * line.slope);
  const hi = round2(cap.budgetMs - held * line.slope);
  const tolerance = Math.max(1, 0.1 * hi);
  return { fromEdge: [lo, hi], fromLine: line.intercept, agree: line.intercept >= lo - tolerance && line.intercept <= hi + tolerance };
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

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
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
