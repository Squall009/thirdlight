/**
 * Which of the surface cache's light is stale, and what to re-light this
 * frame. Light is computed only where something changed: a unit of the cache
 * (a resident tile, a terrain ring patch) is stale when it came in, when its
 * texels moved, or when a change marked it (`surface-changes.ts` turns edits,
 * lights and the sun into marks). Each frame `plan` hands out stale texels
 * nearest the eye first, as many as the frame's budget holds, and a unit
 * waiting long is moved forward (its distance halves every `RELIGHT_AGING_FRAMES`
 * frames), so a far one is never starved by near ones marked again and again.
 *
 * The budget is GPU time, not texels: the work's measured cost (timestamps,
 * `report`) sets how many texels the next frames take. When nothing is
 * stale the scene is settled and a frame costs nothing.
 *
 * Pure (no three.js, no device).
 */

/** Texels a frame takes before any cost is measured (a 32k dispatch kept the Iris Xe within budget in the door room). */
export const RELIGHT_START_TEXELS = 32768;
/**
 * Texels a frame takes at least, however slow the GPU is now: a smaller
 * dispatch costs about as much on an integrated GPU (one ray's latency, not
 * the count, bounds it: 1 k and 8 k texels of sun rays each took about 2 ms
 * on the Iris Xe at its floor clock), so fewer would only slow the light.
 * The pass still holds a frame's rays to its budget (`MIN_PASS_RAYS` at
 * least) and hands back the texels it did not light.
 */
export const RELIGHT_MIN_TEXELS = 8192;
/** Texels a frame takes at most (one dispatch's rays stay within the tracer's buffers). */
export const RELIGHT_MAX_TEXELS = 262144;
/** Frames over which a waiting unit's distance halves when the stale units are ordered. */
export const RELIGHT_AGING_FRAMES = 30;
/** How much a new cost measurement moves the cost estimate (an exponential average). */
const COST_WEIGHT = 0.25;

/** A unit of the cache whose light is computed together: a resident tile, a terrain ring patch. */
export interface RelightUnit {
  readonly key: string;
  /** World box. */
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** Texels it holds. */
  readonly texels: number;
  /** A flat unit's plane (normal and offset, n · p = d on it): a light behind it cannot reach it. */
  readonly plane?: readonly number[];
  /** The light layers its surface is in (a bit mask; absent: every layer): a light lights it when its mask shares one. */
  readonly layers?: number;
}

/** Texels `from` (inclusive) to `to` (exclusive) of a unit, in its own texel order. */
export interface RelightSlice {
  readonly unit: RelightUnit;
  readonly from: number;
  readonly to: number;
}

export interface RelightDiagnostics {
  /** Live updates run (a budget and a pass to run them; the low tier and WebGL 2 draw saved light). */
  readonly live: boolean;
  readonly settled: boolean;
  /** Stale units ("pages") and the texels they hold still to light. */
  readonly stalePages: number;
  readonly staleTexels: number;
  readonly units: number;
  /** The frame budget and the last measured GPU time of the work (ms; null: none measured). */
  readonly budgetMs: number;
  readonly msUsed: number | null;
  /** Texels a frame takes now, and the measured cost per 1,000 texels (ms; null: none measured). */
  readonly texelsPerFrame: number;
  readonly msPerKiloTexel: number | null;
  /** The last change's time and frames until settled (null: none settled yet). */
  readonly lastSettleMs: number | null;
  readonly lastSettleFrames: number | null;
  /** Totals since the start. */
  readonly relitTexels: number;
  readonly marks: number;
}

interface UnitState {
  unit: RelightUnit;
  stale: boolean;
  /** The frame it was last marked stale. */
  since: number;
  /** Texels already handed out since it became stale. */
  cursor: number;
}

function boxDistance(min: readonly number[], max: readonly number[], p: readonly number[]): number {
  let s = 0;
  for (let a = 0; a < 3; a += 1) {
    const d = Math.max(min[a]! - p[a]!, 0, p[a]! - max[a]!);
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Whether a flat unit's plane has the point behind it (a small margin keeps a light on the plane). */
function facesAway(u: RelightUnit, c: readonly number[]): boolean {
  const p = u.plane;
  return p !== undefined && p[0]! * c[0]! + p[1]! * c[1]! + p[2]! * c[2]! - p[3]! < -1e-3;
}

function boxesTouch(aMin: readonly number[], aMax: readonly number[], bMin: readonly number[], bMax: readonly number[]): boolean {
  for (let k = 0; k < 3; k += 1) if (aMin[k]! > bMax[k]! || aMax[k]! < bMin[k]!) return false;
  return true;
}

/** Called with a marked box (null: everything): probes listen (they keep their own stale state). */
export type StaleListener = (min: readonly number[] | null, max: readonly number[] | null) => void;

export class SurfaceRelight {
  private readonly units = new Map<string, UnitState>();
  private readonly listeners: StaleListener[] = [];
  private staleCount = 0;
  private frame = 0;
  private texelsPerFrame = RELIGHT_START_TEXELS;
  private msPerTexel: number | null = null;
  private msUsed: number | null = null;
  private settling: { ms: number; frame: number } | null = null;
  private lastSettle: { ms: number; frames: number } | null = null;
  private relit = 0;
  private marks = 0;

  /** `budgetMs`: GPU time a frame may spend (0: no live updates). */
  constructor(private budgetMs: number, private live = budgetMs > 0) {}

  /** The quality level's budget (0: no live updates), and whether a pass runs the work. */
  setBudget(ms: number, live = ms > 0): void {
    if (ms === this.budgetMs && live === this.live) return;
    this.budgetMs = ms;
    this.live = live && ms > 0;
    if (this.msPerTexel !== null) this.texelsPerFrame = this.countFor(this.msPerTexel);
  }

  /** A unit came in or its texels moved (packed again): it is stale. */
  add(unit: RelightUnit): void {
    const had = this.units.get(unit.key);
    if (had?.stale === true) this.staleCount -= 1;
    this.units.set(unit.key, { unit, stale: false, since: this.frame, cursor: 0 });
    this.stale(this.units.get(unit.key)!);
  }

  /** A unit was let go. */
  remove(key: string): void {
    const s = this.units.get(key);
    if (s === undefined) return;
    if (s.stale) this.staleCount -= 1;
    this.units.delete(key);
  }

  has(key: string): boolean {
    return this.units.has(key);
  }

  private stale(s: UnitState): void {
    if (!s.stale) {
      s.stale = true;
      this.staleCount += 1;
      if (this.settling === null) this.settling = { ms: -1, frame: this.frame };
    }
    // Marked again: its light is computed again from its first texel, and it waits from now (a unit marked
    // every frame does not age past the ones waiting behind it).
    s.since = this.frame;
    s.cursor = 0;
  }

  /** Every unit touching the box is stale; listeners hear of it. Returns the units marked. */
  markBox(min: readonly number[], max: readonly number[]): number {
    this.marks += 1;
    let n = 0;
    for (const s of this.units.values()) {
      if (!boxesTouch(s.unit.min, s.unit.max, min, max)) continue;
      this.stale(s);
      n += 1;
    }
    for (const l of this.listeners) l(min, max);
    return n;
  }

  /**
   * Every unit within `r` of a light at `c` is stale, but for flat units the
   * light is behind (it cannot reach them) and units `keep` leaves out (the
   * light's rooms do not reach them); listeners hear of its box. Returns the
   * units marked.
   */
  markSphere(c: readonly number[], r: number, keep?: (unit: RelightUnit) => boolean): number {
    this.marks += 1;
    let n = 0;
    for (const s of this.units.values()) {
      if (boxDistance(s.unit.min, s.unit.max, c) > r || facesAway(s.unit, c)) continue;
      if (keep !== undefined && !keep(s.unit)) continue;
      this.stale(s);
      n += 1;
    }
    const min = c.map((v) => v - r);
    const max = c.map((v) => v + r);
    for (const l of this.listeners) l(min, max);
    return n;
  }

  /** Units a light at `c` reaching `r` lights (for the checks). */
  unitsNear(c: readonly number[], r: number): string[] {
    const out: string[] = [];
    for (const s of this.units.values()) if (boxDistance(s.unit.min, s.unit.max, c) <= r && !facesAway(s.unit, c)) out.push(s.unit.key);
    return out;
  }

  /** Every unit is stale (the sun moved). */
  markAll(): void {
    this.marks += 1;
    for (const s of this.units.values()) this.stale(s);
    for (const l of this.listeners) l(null, null);
  }

  /**
   * Planned work a pass did not run (its frame's rays outgrew the budget):
   * those texels wait again, from where they were, and stay first in line.
   */
  giveBack(slices: readonly RelightSlice[]): void {
    for (const sl of slices) {
      const s = this.units.get(sl.unit.key);
      if (s === undefined || s.unit !== sl.unit) continue;
      if (!s.stale) {
        // Taken whole this frame (its cursor went back to 0): it resumes where the pass stopped.
        s.stale = true;
        s.cursor = sl.from;
        this.staleCount += 1;
        this.settling ??= { ms: -1, frame: this.frame };
      } else s.cursor = Math.min(s.cursor, sl.from);
      this.relit -= sl.to - sl.from;
    }
  }

  /** One unit is stale. */
  markUnit(key: string): void {
    const s = this.units.get(key);
    if (s === undefined) return;
    this.marks += 1;
    this.stale(s);
  }

  /** Listen to marks (the probes' stale state). */
  onStale(listener: StaleListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Whether `key` waits for light. */
  isStale(key: string): boolean {
    return this.units.get(key)?.stale === true;
  }

  /** Stale unit keys, in the order `plan` would take them from `eye`. */
  order(eye: readonly number[]): string[] {
    return this.ordered(eye).map((s) => s.unit.key);
  }

  private ordered(eye: readonly number[]): UnitState[] {
    const list: { s: UnitState; k: number }[] = [];
    for (const s of this.units.values()) {
      if (!s.stale) continue;
      const age = this.frame - s.since;
      list.push({ s, k: boxDistance(s.unit.min, s.unit.max, eye) / 2 ** (age / RELIGHT_AGING_FRAMES) });
    }
    list.sort((a, b) => a.k - b.k || (a.s.unit.key < b.s.unit.key ? -1 : 1));
    return list.map((e) => e.s);
  }

  /**
   * This frame's work: stale texels nearest `eye` first, up to the frame's
   * texel count. `now` (ms) times how long a change takes to settle. Empty
   * when settled or not live.
   */
  plan(eye: readonly number[], now: number): RelightSlice[] {
    this.frame += 1;
    if (this.settling !== null && this.settling.ms < 0) this.settling.ms = now;
    if (this.staleCount === 0) {
      this.settled(now);
      return [];
    }
    if (!this.live) return [];
    const out: RelightSlice[] = [];
    let left = this.texelsPerFrame;
    for (const s of this.ordered(eye)) {
      if (left <= 0) break;
      const take = Math.min(left, s.unit.texels - s.cursor);
      if (take > 0) out.push({ unit: s.unit, from: s.cursor, to: s.cursor + take });
      s.cursor += take;
      left -= take;
      this.relit += take;
      if (s.cursor >= s.unit.texels) {
        s.stale = false;
        s.cursor = 0;
        this.staleCount -= 1;
      }
    }
    if (this.staleCount === 0) this.settled(now);
    return out;
  }

  private settled(now: number): void {
    if (this.settling === null) return;
    const start = this.settling.ms < 0 ? now : this.settling.ms;
    this.lastSettle = { ms: now - start, frames: this.frame - this.settling.frame };
    this.settling = null;
  }

  private countFor(msPerTexel: number): number {
    const n = Math.floor(this.budgetMs / Math.max(msPerTexel, 1e-9) / 256) * 256;
    return Math.min(RELIGHT_MAX_TEXELS, Math.max(RELIGHT_MIN_TEXELS, n));
  }

  /** The GPU time (ms) a frame's work of `texels` took: the next frames' count follows the budget. */
  report(ms: number, texels: number): void {
    if (!(texels > 0) || !(ms >= 0)) return;
    this.msUsed = ms;
    const per = ms / texels;
    this.msPerTexel = this.msPerTexel === null ? per : this.msPerTexel + (per - this.msPerTexel) * COST_WEIGHT;
    this.texelsPerFrame = this.countFor(this.msPerTexel);
  }

  get isSettled(): boolean {
    return this.staleCount === 0;
  }

  /** Units touching a box (for the checks and the probes). */
  unitsIn(min: readonly number[], max: readonly number[]): string[] {
    const out: string[] = [];
    for (const s of this.units.values()) if (boxesTouch(s.unit.min, s.unit.max, min, max)) out.push(s.unit.key);
    return out;
  }

  /** The units' common world box (null: none). */
  bounds(): { min: number[]; max: number[] } | null {
    if (this.units.size === 0) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const s of this.units.values()) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, s.unit.min[k]!);
        max[k] = Math.max(max[k]!, s.unit.max[k]!);
      }
    }
    return { min, max };
  }

  diagnostics(): RelightDiagnostics {
    let staleTexels = 0;
    for (const s of this.units.values()) if (s.stale) staleTexels += s.unit.texels - s.cursor;
    return {
      live: this.live,
      settled: this.staleCount === 0,
      stalePages: this.staleCount,
      staleTexels,
      units: this.units.size,
      budgetMs: this.budgetMs,
      msUsed: this.msUsed,
      texelsPerFrame: this.texelsPerFrame,
      msPerKiloTexel: this.msPerTexel === null ? null : this.msPerTexel * 1000,
      lastSettleMs: this.lastSettle?.ms ?? null,
      lastSettleFrames: this.lastSettle?.frames ?? null,
      relitTexels: this.relit,
      marks: this.marks,
    };
  }
}
