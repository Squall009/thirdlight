/**
 * Travel at speed measured the owner's way (the coverage bench, coverage-cli.ts): no long hitch in flight, and once
 * the camera stops, how soon the ground under it is solid, full detail stands round it and nothing is pending; a
 * body over the ground never falls through it. This module is the arithmetic over what a run recorded: frame
 * intervals, samples of counts after the stop, the probe body's samples, the page's long animation frames. It reads
 * no clock: every time comes in the samples.
 */
import { frameWindow, type FrameCap } from './headroom';

/** The frames of a flight against the owner's measures: the longest, those over {@link HITCH_MS}, missed a minute. */
export interface FlightFrames {
  readonly frames: number;
  readonly longestMs: number;
  readonly over100: number;
  readonly missed: number;
  readonly missedPerMin: number;
  readonly p95: number;
}

/** A frame this long is a hitch the player feels (the owner's measure in flight). */
export const HITCH_MS = 100;

export function flightFrames(intervals: readonly number[], cap: FrameCap, seconds: number): FlightFrames {
  const w = frameWindow(intervals, cap);
  return { frames: w.frames, longestMs: w.max, over100: intervals.filter((d) => d > HITCH_MS).length, missed: w.missed, missedPerMin: seconds > 0 ? Math.round((w.missed / (seconds / 60)) * 10) / 10 : 0, p95: w.p95 };
}

/** A reading of counts at `t` (seconds), e.g. the near field's chunks by level, its pieces, the far field's nodes and bricks. */
export interface CountSample {
  readonly t: number;
  readonly v: readonly number[];
}

/** How far a count may move while it counts as still: `share` of its value or `abs`, whichever is larger. */
export interface Stillness {
  readonly share: number;
  readonly abs: number;
}

export const STILL_EXACT: Stillness = Object.freeze({ share: 0, abs: 0 });

/**
 * Seconds after `t0` until the counts stop changing: the first sample from which every later sample stays within
 * `still` of the record's last values. Null when they had not held so for `holdS` by the record's end (still
 * moving, or the record too short to tell). What it cannot tell: work that changes nothing counted (a rebuild
 * that draws the same number of chunks).
 */
export function settleAfter(samples: readonly CountSample[], t0: number, still: Stillness | readonly Stillness[], holdS: number): number | null {
  const after = samples.filter((s) => s.t >= t0);
  if (after.length === 0) return null;
  const last = after[after.length - 1]!.v;
  const within = (v: readonly number[]): boolean =>
    v.every((x, i) => {
      const s = Array.isArray(still) ? (still as readonly Stillness[])[i] ?? STILL_EXACT : (still as Stillness);
      return Math.abs(x - last[i]!) <= Math.max(s.abs, s.share * Math.max(Math.abs(x), Math.abs(last[i]!)));
    });
  let from = after.length - 1;
  while (from > 0 && within(after[from - 1]!.v)) from--;
  const at = after[from]!.t;
  if (after[after.length - 1]!.t - at < holdS) return null;
  return round2(at - t0);
}

/** Seconds after `t0` until the first sample for which `holds` is true (null: never in the record). */
export function firstAfter<S extends { readonly t: number }>(samples: readonly S[], t0: number, holds: (s: S) => boolean): number | null {
  for (const s of samples) if (s.t >= t0 && holds(s)) return round2(s.t - t0);
  return null;
}

/**
 * A reading of the probe body: the player character the flight behaviour drops onto the ground under the line
 * every few seconds of flight and once at the stop (flight-camera.ts), as the simulation reported it.
 */
export interface BodySample {
  readonly t: number;
  /** Which drop it is in (1 on; 0: none yet). */
  readonly drop: number;
  /** The ground under the drop point as the far cache's 2 m cells give it (metres). */
  readonly groundY: number;
  /** The body's origin height (metres), and whether it stood on something / was suspended (no collision loaded under it). */
  readonly y: number;
  readonly grounded: boolean;
  readonly suspended: boolean;
  /** It stood on a voxel world's coarse floor (the far cache's 2 m ground), not on fine collision. */
  readonly onFloor?: boolean;
  /** Where it is (metres), and what is round it: {@link BodySurroundings}. */
  readonly at?: BodySurroundings;
}

/**
 * Where a probe body is and what collides round it at a reading: its x, z (metres); the first collider straight
 * under it (`below`) and the first met coming down from high over it to its height (`above`), each a height (metres)
 * and a kind ({@link PROBE_HIT_KIND}: 0 none, 1 fine voxel collision, 2 the coarse floor, 3 anything else).
 */
export interface BodySurroundings {
  readonly x: number;
  readonly z: number;
  readonly belowY: number;
  readonly belowKind: number;
  readonly aboveY: number;
  readonly aboveKind: number;
}

/** How far under the ground the probe's origin must be, falling, to have fallen through (metres): past the 2 m cells' error and the capsule's half height. */
export const FALL_THROUGH_M = 6;

export interface DropOutcomes {
  readonly drops: number;
  /** It stood on something (not suspended) at some reading. */
  readonly landed: number;
  /** Suspended at every reading: no collision came under it within the drop. */
  readonly suspendedOnly: number;
  /** Not suspended, not standing, and {@link FALL_THROUGH_M} under the ground: through the ground. */
  readonly fellThrough: number;
  /** At its last reading: still suspended, standing on the coarse floor, standing on fine collision (the rest were falling or in the air). */
  readonly end: { readonly suspended: number; readonly onFloor: number; readonly onFine: number };
  /**
   * Each fall-through reading's drop, time and heights, and where the body stood later in the same drop (null: it never
   * stood again: through the world, not onto lower ground the 2 m cells did not show, such as a cliff's foot or the fine
   * ground under a higher coarse floor).
   */
  readonly events: ReadonlyArray<FallEvent>;
  /** Of {@link fellThrough}, those that never stood again within their drop. */
  readonly neverStood: number;
  /** The drops whose last reading was still suspended, and that reading (where the body waited, and what was round it). */
  readonly endSuspended: readonly number[];
  readonly suspendedEnds: ReadonlyArray<{ readonly drop: number; readonly t: number; readonly y: number; readonly groundY: number; readonly at?: BodySurroundings }>;
}

export interface FallEvent {
  readonly drop: number;
  readonly t: number;
  readonly y: number;
  readonly groundY: number;
  readonly stoodAt: number | null;
  readonly endY: number;
  readonly endT: number;
  /** What was round the body at the drop's first reading, at the fall-through reading and at its last (when the probe recorded it). */
  readonly first?: BodySurroundings;
  readonly through?: BodySurroundings;
  readonly last?: BodySurroundings;
  /** The body's readings in the drop every quarter second: t, y, standing, suspended, and what was round it. */
  readonly trace?: ReadonlyArray<{ readonly t: number; readonly y: number; readonly g: number; readonly s: number; readonly at?: BodySurroundings }>;
}

/**
 * The drops' outcomes from the body's readings. A fall-through is a reading in which the body is neither suspended
 * nor standing and its origin is {@link FALL_THROUGH_M} under the drop point's ground: collision counted as loaded
 * under it (else it would be suspended) but not holding it. A body that landed and then fell through (a collider
 * swapped from under it) counts as both landed and fallen through.
 */
export function dropOutcomes(samples: readonly BodySample[], depthM = FALL_THROUGH_M): DropOutcomes {
  const byDrop = new Map<number, BodySample[]>();
  for (const s of samples) if (s.drop > 0) (byDrop.get(s.drop) ?? byDrop.set(s.drop, []).get(s.drop)!).push(s);
  let landed = 0, suspendedOnly = 0;
  const end = { suspended: 0, onFloor: 0, onFine: 0 };
  const endSuspended: number[] = [];
  const suspendedEnds: Array<{ drop: number; t: number; y: number; groundY: number; at?: BodySurroundings }> = [];
  const events: FallEvent[] = [];
  for (const [drop, list] of byDrop) {
    const last = list.at(-1)!;
    if (last.suspended) {
      end.suspended++;
      endSuspended.push(drop);
      suspendedEnds.push({ drop, t: round2(last.t), y: round2(last.y), groundY: round2(last.groundY), ...(last.at !== undefined ? { at: last.at } : {}) });
    }
    else if (last.grounded && last.onFloor === true) end.onFloor++;
    else if (last.grounded) end.onFine++;
    if (list.some((s) => s.grounded && !s.suspended)) landed++;
    if (list.every((s) => s.suspended)) suspendedOnly++;
    const through = list.find((s) => !s.suspended && !s.grounded && s.y < s.groundY - depthM);
    if (through === undefined) continue;
    const stood = list.find((s) => s.t > through.t && s.grounded && !s.suspended);
    // Its last reading in the drop: how far it went (a slide down a cliff ends a few metres lower; through the world, far).
    const t0 = list[0]!.t;
    const trace = list.filter((s, i) => i === 0 || i === list.length - 1 || Math.floor((s.t - t0) * 4) !== Math.floor((list[i - 1]!.t - t0) * 4));
    events.push({
      drop,
      t: round2(through.t),
      y: round2(through.y),
      groundY: round2(through.groundY),
      stoodAt: stood === undefined ? null : round2(stood.y),
      endY: round2(last.y),
      endT: round2(last.t),
      ...(list[0]!.at !== undefined ? { first: list[0]!.at } : {}),
      ...(through.at !== undefined ? { through: through.at } : {}),
      ...(last.at !== undefined ? { last: last.at } : {}),
      trace: trace.map((s) => ({ t: round2(s.t - t0), y: round2(s.y), g: s.grounded ? 1 : 0, s: s.suspended ? 1 : 0, ...(s.at !== undefined ? { at: s.at } : {}) })),
    });
  }
  return { drops: byDrop.size, landed, suspendedOnly, fellThrough: events.length, end, events, neverStood: events.filter((e) => e.stoodAt === null).length, endSuspended, suspendedEnds };
}

/** A fall-through event judged against the true ground at the body's own place: {@link judgeFall}. */
export interface FallVerdict {
  readonly drop: number;
  /**
   * `through`: at some reading the body was {@link FALL_THROUGH_M} under the true ground at its own x, z, or it
   * ended its drop falling with no collider at all under it (out of the world); `lower`: never so, it went down to ground lower than the drop point's 2 m cells show (a cliff's foot, a
   * slide off an edge), standing there or still falling towards it; `unknown`: the probe recorded no place.
   */
  readonly verdict: 'through' | 'lower' | 'unknown';
  /** The true ground at the body's place at its fall-through and last readings (null: air down to the world's floor). */
  readonly fineAtThrough: number | null;
  readonly fineAtLast: number | null;
  /** How far the body moved sideways from its first reading to its last (metres). */
  readonly sideM: number | null;
  /** A collider over the body at its own x, z at the last reading (it is under a surface), and what it was. */
  readonly underSurface: boolean;
  readonly aboveKind: number | null;
}

/**
 * Judges a fall-through by the true ground at the body's own x, z at each reading (`fineAt(x, z, fromY)`: the top of
 * the highest solid cell at or under `fromY`, looked for from the drop's first height), not the drop point's 2 m cell:
 * a body that went off an edge or down to ground the 2 m cells do not show is never under the ground where it is.
 */
export function judgeFall(e: FallEvent, fineAt: (x: number, z: number, fromY: number) => number | null, depthM = FALL_THROUGH_M): FallVerdict {
  const fromY = (e.trace?.[0]?.y ?? e.y) + 3;
  const readings = (e.trace ?? []).filter((r) => r.at !== undefined && r.g === 0 && r.s === 0);
  const under = readings.some((r) => {
    const f = fineAt(r.at!.x, r.at!.z, fromY);
    return f !== null && r.y < f - depthM;
  });
  const lastReading = e.trace?.at(-1);
  const intoNothing = lastReading?.at !== undefined && lastReading.g === 0 && lastReading.s === 0 && lastReading.at.belowKind === 0;
  const fineAtThrough = e.through === undefined ? null : fineAt(e.through.x, e.through.z, fromY);
  const fineAtLast = e.last === undefined ? null : fineAt(e.last.x, e.last.z, fromY);
  const sideM = e.first === undefined || e.last === undefined ? null : round2(Math.hypot(e.last.x - e.first.x, e.last.z - e.first.z));
  const underSurface = e.last !== undefined && e.last.aboveKind !== 0 && e.last.aboveY > e.endY + 1;
  return {
    drop: e.drop,
    verdict: e.trace === undefined || e.trace.every((r) => r.at === undefined) ? 'unknown' : under || intoNothing ? 'through' : 'lower',
    fineAtThrough: fineAtThrough === null ? null : round2(fineAtThrough),
    fineAtLast: fineAtLast === null ? null : round2(fineAtLast),
    sideM,
    underSurface,
    aboveKind: e.last?.aboveKind ?? null,
  };
}

/**
 * The share of a picture's bottom rows that is near black (the dark slivers at the bottom edge of low's fast
 * frames): `pixel(x, y)` RGB 0–255, the bottom `rows` rows, luminance under `lumMax`.
 */
export function bottomDarkShare(width: number, height: number, pixel: (x: number, y: number) => readonly number[], rows: number, lumMax = 24): number {
  let dark = 0, n = 0;
  for (let y = Math.max(0, height - rows); y < height; y++) for (let x = 0; x < width; x++) {
    const p = pixel(x, y);
    if (0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]! < lumMax) dark++;
    n++;
  }
  return n === 0 ? 0 : dark / n;
}

/** A long animation frame the page reported (the browser's Long Animation Frames timing, page clock ms). */
export interface LongFrame {
  readonly t: number;
  readonly ms: number;
  /** ms from the frame's render step to its end (rAF callbacks, style, layout, paint), and the frame's blocking ms. */
  readonly renderMs: number;
  readonly blockingMs: number;
  /** The scripts that ran in it, longest first: what invoked them (`Worker.onmessage`, `FrameRequestCallback`, …) and their ms. */
  readonly scripts: ReadonlyArray<{ readonly invoker: string; readonly fn: string; readonly ms: number }>;
}

/** The page's frame at `t` (page clock ms) and the voxel draws' counts then (batches applied, chunks, far bricks, …). */
export interface FrameSample {
  readonly t: number;
  readonly counts: Readonly<Record<string, number>>;
}

/** The share of a long frame its longest script must take to be named its cause. */
export const SPIKE_SCRIPT_SHARE = 0.3;

/**
 * What took most of a long frame: the longest script's invoker when it took {@link SPIKE_SCRIPT_SHARE} of the frame
 * or more, `render` when the render step took most of it with no such script (the browser's own drawing work),
 * `other` when neither shows (garbage collection between tasks, a wait on another process). A gap between frames
 * with no long frame on the page's thread at all is `off-thread` (the GPU or compositor process).
 */
export function spikeCause(f: LongFrame | null): string {
  if (f === null) return 'off-thread';
  const top = f.scripts[0];
  if (top !== undefined && top.ms >= SPIKE_SCRIPT_SHARE * f.ms) return `${top.invoker}${top.fn !== '' ? ` ${top.fn}` : ''}`;
  return f.renderMs > 0.5 * f.ms ? 'render' : 'other';
}

export interface LongGap {
  readonly t: number;
  readonly ms: number;
  /** The longest long frame overlapping the gap (null: none on the page's thread). */
  readonly frame: LongFrame | null;
  /** How the draws' counts moved across the gap. */
  readonly delta: Readonly<Record<string, number>>;
}

/** The gaps between the page's frames longer than `overMs`, each with the long frame overlapping it and what the draws changed across it. */
export function longGaps(samples: readonly FrameSample[], frames: readonly LongFrame[], overMs = HITCH_MS): LongGap[] {
  const out: LongGap[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    if (b.t - a.t <= overMs) continue;
    let best: LongFrame | null = null;
    for (const f of frames) {
      const overlap = Math.min(b.t, f.t + f.ms) - Math.max(a.t, f.t);
      if (overlap > 0 && (best === null || f.ms > best.ms)) best = f;
    }
    const delta: Record<string, number> = {};
    for (const k of Object.keys(b.counts)) {
      const d = b.counts[k]! - (a.counts[k] ?? 0);
      if (d !== 0) delta[k] = d;
    }
    out.push({ t: a.t, ms: round2(b.t - a.t), frame: best, delta });
  }
  return out;
}

/** Long gaps grouped by {@link spikeCause}: how many, their ms summed, and the mean of each draw change over them. */
export function spikeCauses(gaps: readonly LongGap[]): Array<{ cause: string; gaps: number; ms: number; meanDelta: Record<string, number> }> {
  const groups = new Map<string, LongGap[]>();
  for (const g of gaps) {
    const cause = spikeCause(g.frame);
    (groups.get(cause) ?? groups.set(cause, []).get(cause)!).push(g);
  }
  return [...groups]
    .map(([cause, list]) => {
      const meanDelta: Record<string, number> = {};
      for (const g of list) for (const [k, v] of Object.entries(g.delta)) meanDelta[k] = (meanDelta[k] ?? 0) + v / list.length;
      for (const k of Object.keys(meanDelta)) meanDelta[k] = round2(meanDelta[k]!);
      return { cause, gaps: list.length, ms: Math.round(list.reduce((n, g) => n + g.ms, 0)), meanDelta };
    })
    .sort((a, b) => b.ms - a.ms);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
