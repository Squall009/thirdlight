/**
 * Frame pacing: which animation frames the page draws under the game's
 * frame-rate cap (`ctx.display`, the `frame_rate_cap` setting).
 *
 * The browser calls the page once per display refresh; under a cap the page
 * skips the callbacks that come early. The drawn frames keep to a fixed grid
 * of the cap's interval, so the average is the cap exactly on any display
 * faster than it: a 144 Hz display at 60 alternates two and three refreshes
 * per drawn frame instead of drifting to 72. A callback counts as on time
 * when it is less than half a refresh early (the refresh closest to the
 * grid), so the vsync jitter of a 60 Hz display at a 30 cap never moves a
 * draw to the neighbouring refresh.
 *
 * A cap at (or within 10 % above) the display's own rate draws every
 * callback: a 60 Hz display at a 60 cap, whose real rate is 59.9 or 60.05 Hz,
 * would otherwise slip a refresh every few seconds against the exact grid.
 *
 * Game time is not paced: the simulation steps by the clock whenever a frame
 * runs, and a skipped frame's steps run in the next drawn one.
 */
import { frameRateCapOf, type FrameRateCap } from '@thirdlight/project-model';

import type { BehaviorDisplay } from './types-behavior-world';

/** A callback at most this share of the cap's interval early draws (and at most half a refresh early). */
const EARLY_SHARE = 0.25;
/**
 * A cap at least this share of the display's rate draws every frame: the two
 * differ by clock drift and by the noise of the measured rate, not by intent.
 */
const DISPLAY_MATCH = 0.9;
/** Refresh intervals the display's rate is the median of (a dropped frame or a hitch does not move it). */
const DISPLAY_SAMPLES = 15;
/** Callbacks the display's rate needs before pacing starts (every frame draws until then: a few at the start). */
const DISPLAY_MIN_SAMPLES = 5;

/** How the animation frames were paced (Play diagnostics). */
export interface FramePacingStats {
  /** The game's cap (frames per second; null: none, the display's rate). */
  readonly frameRateCap: FrameRateCap | null;
  /** A cap the page pins whatever the game sets (`?frameRateCap=`; absent: none pinned). */
  readonly pinned?: FrameRateCap | 'none';
  /** Animation frames drawn and skipped (early for the cap) since the start. */
  readonly drawnFrames: number;
  readonly skippedFrames: number;
  /** The display's refresh interval (ms; the median of the last callbacks; 0: not known yet). */
  readonly displayMs: number;
}

export class FramePacer {
  /** The game's cap (null: none). */
  private cap: FrameRateCap | null;
  /** A cap the page pins for pacing whatever the game sets (undefined: the game's applies). */
  private pin: FrameRateCap | null | undefined = undefined;
  private drawn = 0;
  private skipped = 0;
  /** The grid time (ms) the next drawn frame is due at (NaN: anchor at the next frame). */
  private next = Number.NaN;
  private last = Number.NaN;
  private readonly deltas = new Float64Array(DISPLAY_SAMPLES);
  private readonly sorted = new Float64Array(DISPLAY_SAMPLES);
  private deltaCount = 0;
  private deltaAt = 0;
  private displayMs = 0;

  constructor(cap: FrameRateCap | null = null) {
    this.cap = cap;
  }

  /** The game's cap (null: none). */
  get frameRateCap(): FrameRateCap | null {
    return this.cap;
  }

  /** Set the game's cap (30, 60, 120, or null/0/'none' for none); false for another value (nothing changes). */
  setCap(fps: unknown): boolean {
    const cap = frameRateCapOf(fps);
    if (cap === undefined) return false;
    this.cap = cap;
    return true;
  }

  /** Pin pacing to a cap whatever the game sets (null: uncapped), or unpin it (undefined); false for another value. */
  pinCap(fps: unknown): boolean {
    if (fps === undefined) {
      this.pin = undefined;
      return true;
    }
    const cap = frameRateCapOf(fps);
    if (cap === undefined) return false;
    this.pin = cap;
    return true;
  }

  /** The cap the frames are paced by now (a pinned one, else the game's). */
  get pacingCap(): FrameRateCap | null {
    return this.effective();
  }

  /** The cap pacing follows now. */
  private effective(): FrameRateCap | null {
    return this.pin !== undefined ? this.pin : this.cap;
  }

  /** The display's refresh interval (ms) from the callbacks so far (0: not known yet). */
  private sampleDisplay(t: number): void {
    const dt = t - this.last;
    this.last = t;
    if (!(dt > 0)) return;
    this.deltas[this.deltaAt] = dt;
    this.deltaAt = (this.deltaAt + 1) % DISPLAY_SAMPLES;
    if (this.deltaCount < DISPLAY_SAMPLES) this.deltaCount += 1;
    const n = this.deltaCount;
    const s = this.sorted.subarray(0, n);
    s.set(this.deltas.subarray(0, n));
    s.sort();
    this.displayMs = s[n >> 1]!;
  }

  /** The animation frame at `t` (ms): true to draw it, false to skip it (early for the cap). */
  frame(t: number): boolean {
    this.sampleDisplay(t);
    const cap = this.effective();
    const interval = cap === null ? 0 : 1000 / cap;
    if (cap === null || this.deltaCount < DISPLAY_MIN_SAMPLES || interval <= this.displayMs / DISPLAY_MATCH) {
      // Uncapped, the display's rate not known yet, or the display no faster than the cap: every frame draws
      // (the grid starts again when that changes).
      this.next = Number.NaN;
      this.drawn += 1;
      return true;
    }
    if (!Number.isFinite(this.next) || t >= this.next + interval) {
      // The first capped frame, or a whole interval late (a hitch): the grid starts here.
      this.next = t + interval;
      this.drawn += 1;
      return true;
    }
    if (t < this.next - this.earlyMs(interval)) {
      this.skipped += 1;
      return false;
    }
    this.next += interval;
    this.drawn += 1;
    return true;
  }

  /**
   * Whether the animation frame after the one at `t` (ms) is expected to
   * draw: a worker's tick sent then is answered in time for that draw, so
   * the input it samples reaches the screen a refresh later, not a cap's
   * interval later.
   */
  drawsNext(t: number): boolean {
    const cap = this.effective();
    if (cap === null || !Number.isFinite(this.next)) return true;
    return t + this.displayMs >= this.next - this.earlyMs(1000 / cap);
  }

  /** How early a frame may come and still draw: half a refresh (the closest refresh to the grid), at most a quarter interval. */
  private earlyMs(interval: number): number {
    return Math.min(interval * EARLY_SHARE, this.displayMs / 2);
  }

  stats(): FramePacingStats {
    return {
      frameRateCap: this.cap,
      ...(this.pin !== undefined ? { pinned: this.pin ?? 'none' } : {}),
      drawnFrames: this.drawn,
      skippedFrames: this.skipped,
      displayMs: Math.round(this.displayMs * 1000) / 1000,
    };
  }
}

/**
 * A page URL flag that pins the frame-rate cap whatever the game sets
 * (`?frameRateCap=none|30|60|120`; Play passes the editor's on): measurements
 * run uncapped (none) on any game, and a cap can be tried without editing the
 * project.
 */
export const FRAME_RATE_CAP_URL_PARAM = 'frameRateCap';

/** The cap a page URL's search pins (null: none, uncapped; undefined: absent or not a cap). */
export function frameRateCapFromUrl(search: string): FrameRateCap | null | undefined {
  const m = new RegExp(`[?&]${FRAME_RATE_CAP_URL_PARAM}=([a-z0-9]{1,8})(?:[&#]|$)`).exec(search);
  return m === null ? undefined : frameRateCapOf(m[1]);
}

/** `ctx.display` over a pacer: scripts read and set the game's cap (presentation; never in the digest). */
export function displayControlOf(pacer: FramePacer): BehaviorDisplay {
  return Object.freeze({
    get frameRateCap(): number | null {
      return pacer.frameRateCap;
    },
    setFrameRateCap: (fps: number | null): boolean => pacer.setCap(fps),
  });
}

/**
 * Debugging and tests: an editor page URL flag that slows Play's simulation
 * worker by this many milliseconds per frame (`?simDelayMs=40`), to see the
 * page keep drawing at the display's rate while the simulation lags. Only
 * editor Play reads it (an exported game's address is the player's).
 */
export const SIM_DELAY_URL_PARAM = 'simDelayMs';

/** The worker delay the page URL asks for (ms; 0 when absent or not understood). */
export function simDelayFromUrl(search: string): number {
  const m = new RegExp(`[?&]${SIM_DELAY_URL_PARAM}=([0-9]{1,4})(?:[&#]|$)`).exec(search);
  return m === null ? 0 : Math.min(1000, Number(m[1]));
}
