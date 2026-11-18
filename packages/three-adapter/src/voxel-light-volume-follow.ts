/**
 * A light that keeps moving (a day's sun, a sky blending between looks), as the light volume follows it
 * (voxel-light-volume.ts): every step would otherwise restart what it reaches, so a sun that never stops kept every
 * kept brick stale and every brick a few rays from nothing, and the picture shimmered as bricks restarted in turn.
 *
 * Followed instead: a step the light takes is not a restart. Every kept brick keeps its light and is refreshed in
 * turn, its new estimate blended in by at least 1 / `window` (an exponential mean over about its last `window`
 * updates: the light lags the sun by a known number of updates and its noise stays bounded), the bricks nearest the
 * eye and in front of it more often ({@link followPeriod}), within the update's live share after the stale bricks.
 * Once the light has stopped moving for a while ({@link VolumeFollow.frame}), each brick's history is cut to that
 * window's weight so the refining goes on converging from there (the old places of the sun fade out), and the volume
 * counts as refined only when that is done. A jump (a look switched at once, or blended in a second or two: faster
 * than a day moves) still restarts what it reaches: the caller tells the two apart by their rate
 * ({@link volumeLightStep}, {@link volumeSkyStep}).
 */
import { VOLUME_HISTORY_SHARE, VOLUME_WINDOW_BRICKS, volumeCellM } from './voxel-light-volume-layout';
import { brickGap, type RefineBrick } from './voxel-light-volume-refine';

/** A brick as the follow reads and writes it: its updates and the frame of its last one. */
export interface FollowBrick extends RefineBrick {
  updates: number;
  /** The frame of its last update (−∞: none). */
  seen: number;
}

/**
 * Level-0 bricks (2 m) from the eye at which a brick is refreshed half as often as one at the eye (one twice as far, a
 * third as often): the light round the player follows closely, far walls catch up over a few sweeps.
 */
const FOLLOW_HALF_GAP = 8;
/** A brick behind the camera is refreshed this many times less often. */
const FOLLOW_BEHIND = 2;
/** Frames' worth of bricks ordered at a time (the order is made again when they are taken). */
const FOLLOW_LOOKAHEAD = 4;
/** Buckets of the order's priority (a brick's age over its period, in quarters). */
const FOLLOW_BUCKETS = 256;

const BRICK_M = volumeCellM(0) * 4;

/** How many frames apart a brick at level-0 brick gap `gap` from the eye is refreshed, against one at the eye. */
export function followPeriod(gap: number, behind: boolean): number {
  return (1 + gap / FOLLOW_HALF_GAP) * (behind ? FOLLOW_BEHIND : 1);
}

/** The weight a following brick's new estimate is blended in by: its history's, but at least 1 / `window`. */
export function followWeight(base: number, window: number): number {
  return Math.max(base, 1 / Math.max(1, window));
}

/** The updates a brick's history is cut to once the light stops moving (its blend weight is then 1 / `window`). */
export function followCutUpdates(window: number): number {
  return VOLUME_HISTORY_SHARE * Math.max(0, window - 1);
}

/**
 * The fastest a sun the volume follows turns (degrees a second): a day of a minute (6° a second) is followed; a look
 * blended in a second or two, or switched at once, turns it faster and restarts what it reaches.
 */
export const FOLLOW_SUN_DEG_PER_S = 10;
/**
 * The largest share of its light a followed sun or sky changes by in a second: a sunset's light falls over minutes,
 * a day's sky near the horizon moves by a quarter in a second at a 2-minute day; a look blended in a second or switched
 * at once changes faster.
 */
export const FOLLOW_CHANGE_PER_S = 0.5;
/** The shortest time a change is taken over (s): two looks within a frame are not a slow change. */
const FOLLOW_MIN_S = 1 / 120;
/**
 * The window (s) a sun's change is taken over (longer when the frame it came in was: a hitch, a screenshot): its
 * direction and light now against a quarter of a second ago, so a day moved in simulation steps reads its own rate
 * however short the page's frames, and a look switched at once after standing still reads as fast as it is.
 */
const FOLLOW_MAX_S = 0.25;

/**
 * The window (s) a sky's change is taken over: the sky is looked at twice a second and projected only when it changed,
 * so a day's slow change arrives in steps seconds apart (a few hundredths each); a look switched at once changes it by
 * a quarter or more within this.
 */
const FOLLOW_SKY_MAX_S = 1;

/**
 * What a light was over the last moments, as looked at each frame: its values kept as they changed, so its value a
 * window ago is known (the change over a window, not over the last frame: a light moved by a simulation step shows a
 * whole step in one short page frame, and a light standing still for a minute then switched changes over one frame).
 */
class LightPast {
  private readonly t: number[] = [];
  private readonly v: number[][] = [];
  private lastLook = -Infinity;

  /** The light's values at `now` (kept if they changed; null: as they were). */
  look(now: number, values: ArrayLike<number> | null): void {
    this.lastLook = now;
    if (values === null) return;
    const last = this.v[this.v.length - 1];
    if (last !== undefined && last.every((x, i) => x === values[i])) return;
    this.t.push(now);
    this.v.push(Array.from(values));
  }

  /**
   * The window a change seen at `now` is taken over: `window`, or longer when the last look was longer ago (a frame
   * of a second at a hitch), and the values then (the oldest kept when none is that old). Call before {@link look}.
   */
  before(now: number, window: number): { seconds: number; values: readonly number[] | null } {
    const seconds = Math.max(window, now - this.lastLook);
    const at = now - seconds;
    // Forget what is older than the one in force a window ago.
    let k = this.t.length - 1;
    while (k > 0 && this.t[k]! > at) k--;
    if (k > 0) {
      this.t.splice(0, k);
      this.v.splice(0, k);
    }
    return { seconds, values: this.v[0] ?? null };
  }
}

/**
 * Whether a change of the sun over `seconds` is a step the volume follows (true) or a jump it restarts for: lit before
 * and after, turning no faster than {@link FOLLOW_SUN_DEG_PER_S}, its light changing no faster than
 * {@link FOLLOW_CHANGE_PER_S}. `was` and `now`: direction (unit) and the light's sum.
 */
export function volumeLightStep(was: { dir: readonly number[]; lit: number }, now: { dir: readonly number[]; lit: number }, seconds: number): boolean {
  if (!(was.lit > 0) || !(now.lit > 0)) return false;
  const s = Math.max(seconds, FOLLOW_MIN_S);
  const dot = was.dir[0]! * now.dir[0]! + was.dir[1]! * now.dir[1]! + was.dir[2]! * now.dir[2]!;
  if ((Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI > FOLLOW_SUN_DEG_PER_S * s) return false;
  return Math.abs(now.lit - was.lit) <= FOLLOW_CHANGE_PER_S * s * Math.max(was.lit, now.lit);
}

/** The share of what the sky holds a change moved (summed over its terms). */
function skyChange(was: ArrayLike<number>, now: ArrayLike<number>): number {
  let d = 0;
  let m = 0;
  for (let i = 0; i < now.length; i++) {
    d += Math.abs(now[i]! - was[i]!);
    m += Math.max(Math.abs(now[i]!), Math.abs(was[i]!));
  }
  return m > 0 ? d / m : 0;
}

/** Whether a change of the sky's coefficients over `seconds` is a step it follows: no faster than {@link FOLLOW_CHANGE_PER_S} of what it holds (summed over its terms). */
export function volumeSkyStep(was: ArrayLike<number>, now: ArrayLike<number>, seconds: number): boolean {
  const any = Array.from(now).some((v, i) => v !== 0 || was[i] !== 0);
  return any && skyChange(was, now) <= FOLLOW_CHANGE_PER_S * Math.max(seconds, FOLLOW_MIN_S);
}

/** The followed light's bookkeeping: whether it is moving, which bricks are refreshed next, and when it stopped. */
export class VolumeFollow<B extends FollowBrick> {
  private changedAt = -Infinity;
  private active = false;
  private queue: B[] = [];
  private at = 0;

  constructor(private readonly continueFrames: number) {}

  /** The light took a step at `frame` (followed, not restarted). */
  change(frame: number): void {
    this.changedAt = frame;
    this.active = true;
  }

  /** The light is moving (a step within the last `continueFrames`), or stopped but not yet handed to the refining. */
  get following(): boolean {
    return this.active;
  }

  /** A brick last updated before the light's last step (its light is the old one's, blended toward the new). */
  behind(b: B): boolean {
    return this.active && b.seen <= this.changedAt;
  }

  /**
   * Each frame: true once, when the light has stopped moving for `continueFrames` (the caller cuts every brick's
   * history to the window then, so the refining goes on from there).
   */
  frame(frame: number): boolean {
    if (!this.active || frame - this.changedAt <= this.continueFrames) return false;
    this.active = false;
    this.queue = [];
    this.at = 0;
    return true;
  }

  /**
   * Up to `count` bricks refreshed this frame into `list`: of `bricks`, those `may` allows (with a slot, not stale, not
   * listed already), longest waiting first against their period ({@link followPeriod}: near the eye and in front of it
   * shorter), so each is refreshed in turn and the near ones more often.
   */
  take(bricks: () => Iterable<B>, may: (b: B) => boolean, eye: readonly number[], forward: readonly number[], frame: number, count: number, list: B[]): void {
    if (!this.active || count <= 0) return;
    let left = count;
    const taken = new Set<B>();
    for (let pass = 0; pass < 2 && left > 0; pass++) {
      while (this.at < this.queue.length && left > 0) {
        const b = this.queue[this.at++]!;
        if (!may(b) || taken.has(b) || b.seen >= frame) continue;
        taken.add(b);
        list.push(b);
        left--;
      }
      if (left === 0) return;
      this.queue = this.order(bricks(), may, eye, forward, frame, FOLLOW_LOOKAHEAD * count);
      this.at = 0;
      if (this.queue.length === 0) return;
    }
  }

  /** Up to `want` bricks by their wait over their period, longest first. */
  private order(bricks: Iterable<B>, may: (b: B) => boolean, eye: readonly number[], fw: readonly number[], frame: number, want: number): B[] {
    const e = eye.map((v) => Math.floor(v / BRICK_M));
    const buckets: B[][] = [];
    const reach = Math.max(...VOLUME_WINDOW_BRICKS);
    for (const b of bricks) {
      if (!may(b)) continue;
      const n = 1 << b.level;
      const g = Math.min(reach, brickGap(b, e));
      const behind = ((b.bx + 0.5) * n - e[0]! - 0.5) * fw[0]! + ((b.by + 0.5) * n - e[1]! - 0.5) * fw[1]! + ((b.bz + 0.5) * n - e[2]! - 0.5) * fw[2]! < -n;
      const age = Number.isFinite(b.seen) ? frame - b.seen : 1e6;
      const key = FOLLOW_BUCKETS - 1 - Math.min(FOLLOW_BUCKETS - 1, Math.floor((4 * age) / followPeriod(g, behind)));
      (buckets[key] ??= []).push(b);
    }
    const out: B[] = [];
    for (const bucket of buckets) {
      if (bucket === undefined) continue;
      for (const b of bucket) {
        out.push(b);
        if (out.length >= want) return out;
      }
    }
    return out;
  }
}

/** What the sun or the sky did since it was last looked at: nothing, a step the volume follows, or a jump it restarts for. */
export type VolumeLightChange = 'none' | 'step' | 'jump';

/** The sun and the sky as the volume last marked for them, against which each frame's are told a step or a jump. */
export class VolumeSunSkyWatch {
  private skyVersion = -1;
  private readonly skyPast = new LightPast();
  private readonly sunPast = new LightPast();
  /** Changes told apart so far, and the last jump's kind, size and the seconds it was taken over (diagnostics). */
  readonly counts = { steps: 0, jumps: 0, last: null as null | { what: 'sky' | 'sun'; deg: number; light: number; seconds: number } };
  /** The sun's direction (unit) and its light's sum as last marked for. */
  private readonly sunWas = [0, 0, 0, 0];

  /** The sky's coefficients at `version`, at `now` (s): a step when they moved no faster than a followed sky over the last {@link FOLLOW_SKY_MAX_S}. */
  sky(version: number, coefficients: Float32Array, now: number): VolumeLightChange {
    const was = this.skyPast.before(now, FOLLOW_SKY_MAX_S);
    this.skyPast.look(now, version === this.skyVersion ? null : coefficients);
    if (version === this.skyVersion) return 'none';
    this.skyVersion = version;
    // The first sky the volume sees is no step of a moving one.
    const step = was.values !== null && volumeSkyStep(was.values, coefficients, was.seconds);
    if (!step) this.counts.last = { what: 'sky', deg: 0, light: was.values === null ? 1 : skyChange(was.values, coefficients), seconds: was.seconds };
    return this.told(step);
  }

  /**
   * The sun's direction (unit; null: none) and light: a change once it turned by a hundredth of a degree or its light
   * changed by a hundredth since last marked for (compared in 64 bits; the pass's copy is 32), a step when it moved no
   * faster than a followed sun over the last {@link FOLLOW_MAX_S} ({@link volumeLightStep}), at `now` (s); an unlit
   * sun's direction is not looked at.
   */
  sun(dir: readonly number[] | null, lit: number, now: number): VolumeLightChange {
    const was = this.sunPast.before(now, FOLLOW_MAX_S);
    const d = dir ?? [0, 0, 0];
    this.sunPast.look(now, [d[0]!, d[1]!, d[2]!, lit]);
    const w = this.sunWas;
    const turned = lit > 0 && dir !== null && dir[0]! * w[0]! + dir[1]! * w[1]! + dir[2]! * w[2]! < Math.cos((0.01 * Math.PI) / 180);
    if (!turned && !(Math.abs(lit - w[3]!) > 0.01 * Math.max(w[3]!, 1e-3))) return 'none';
    const then = was.values ?? [0, 0, 0, 0];
    const step = dir !== null && volumeLightStep({ dir: then, lit: then[3]! }, { dir, lit }, was.seconds);
    if (!step) this.counts.last = { what: 'sun', deg: (Math.acos(Math.min(1, Math.max(-1, d[0]! * then[0]! + d[1]! * then[1]! + d[2]! * then[2]!))) * 180) / Math.PI, light: Math.abs(lit - then[3]!) / Math.max(lit, then[3]!, 1e-6), seconds: was.seconds };
    if (dir !== null && lit > 0) {
      w[0] = dir[0]!;
      w[1] = dir[1]!;
      w[2] = dir[2]!;
    }
    w[3] = lit;
    return this.told(step);
  }

  private told(step: boolean): VolumeLightChange {
    if (step) this.counts.steps++;
    else this.counts.jumps++;
    return step ? 'step' : 'jump';
  }
}
