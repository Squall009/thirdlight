/**
 * The global wind scripts change at run time (`ctx.environment.setWind`):
 * simulation state, so page, worker, replays and saves agree.
 *
 * Like the environment's presets, the state is a weight per key: `''` is
 * the active scene's own wind, `w<n>` a script's wind (a patch laid over the
 * scene's). A change starts a transition from the weights now to the new key
 * over whole steps (eased); an interrupted one starts from where it is. Each
 * change adds to the last one's patch, so `setWind({ strength })` then
 * `setWind({ direction })` keeps both; `setWind(null)` goes back to the
 * scene's wind. The renderer turns the weights into one wind
 * ({@link blendWinds}); the simulation never needs the values.
 *
 * Inert until a script changes the wind: nothing enters the digest, the
 * frame state or the renderer before that.
 */
import { DEFAULT_WIND, validateWind, WIND_DEFAULTS, type ModelErrorV2, type WindConfig } from '@thirdlight/project-model';

import { ENVIRONMENT_EASINGS, easeEnvironment, type EnvironmentEasing } from './environment-blend';

/** A script's wind: any of the wind's fields, laid over the scene's. */
export type WindPatch = Partial<WindConfig>;

/**
 * The least share a wind keeps when a change starts a new blend: lighter
 * ones are let go (the rest scaled up to make the whole, a change of the
 * wind far below what shows). Scripts may change the wind as often as they
 * like; the winds alive at once are bounded by this share, not by a count.
 */
const WIND_SHARE_MIN = 1e-4;
/** The most winds a share list (a save's included) can hold with every share at least {@link WIND_SHARE_MIN}, the scene's and the target's added. */
const WIND_SHARES_MAX = Math.ceil(1 / WIND_SHARE_MIN) + 2;

/** What the renderer reads: each wind's share now ([patch, weight]; a null patch is the scene's own wind). */
export type WindBlendView = readonly (readonly [WindPatch | null, number])[];

interface Transition {
  from: Map<string, number>;
  to: Map<string, number>;
  elapsed: number;
  total: number;
  easing: EnvironmentEasing;
}

/** What a save's environment section holds of the wind. */
export interface WindSaveState {
  weights: [string, number][];
  transition: { from: [string, number][]; to: [string, number][]; elapsed: number; total: number; easing: EnvironmentEasing } | null;
  patches: [string, WindPatch][];
  /** The key the last change went to. */
  target: string;
  serial: number;
}

/** Options of `setWind`: the blend's seconds and easing. */
export interface WindChangeOptions {
  blend?: number;
  easing?: EnvironmentEasing;
}

const sorted = (m: ReadonlyMap<string, number>): [string, number][] => [...m.entries()].filter(([, w]) => w > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** A blend's shares less those under {@link WIND_SHARE_MIN}, the rest scaled to the same whole. */
function keptShares(shares: ReadonlyMap<string, number>): Map<string, number> {
  let total = 0;
  let kept = 0;
  for (const w of shares.values()) {
    total += w;
    if (w >= WIND_SHARE_MIN) kept += w;
  }
  const out = new Map<string, number>();
  if (!(kept > 0)) return new Map(shares);
  for (const [k, w] of shares) if (w >= WIND_SHARE_MIN) out.set(k, (w * total) / kept);
  return out;
}

/** A patch checked as a wind: its fields over the defaults must make a valid wind. */
export function windPatchError(patch: unknown): string | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return 'the wind is an object { direction?, strength?, gust?, gustFrequency?, turbulence?, noise?, speed?, scale?, octave? }';
  const errs: ModelErrorV2[] = [];
  validateWind({ ...DEFAULT_WIND, ...(patch as object) }, '', errs);
  return errs.length > 0 ? `${errs[0]!.path.replace(/^\//, '') || 'wind'}: ${errs[0]!.message}` : null;
}

export class WindBlend {
  private curr = new Map<string, number>([['', 1]]);
  private prev = new Map<string, number>([['', 1]]);
  private transition: Transition | null = null;
  private patches = new Map<string, WindPatch>();
  private target = '';
  private serial = 0;
  private used = false;
  private viewCache: { alpha: number; view: WindBlendView } | null = null;

  constructor(
    private readonly hz: number,
    private readonly maxSeconds: number,
    private readonly warn: (message: string) => void,
  ) {}

  /** A script changed the wind this run. */
  get active(): boolean {
    return this.used;
  }

  reset(): void {
    this.curr = new Map([['', 1]]);
    this.prev = new Map([['', 1]]);
    this.transition = null;
    this.patches.clear();
    this.target = '';
    this.serial = 0;
    this.used = false;
    this.viewCache = null;
  }

  /** `ctx.environment.setWind`: blend to a wind (null: the scene's own) over `blend` seconds. */
  change(wind: unknown, options: unknown): boolean {
    const o = (typeof options === 'object' && options !== null ? options : {}) as WindChangeOptions;
    const seconds = o.blend ?? 0;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > this.maxSeconds) {
      this.warn(`ctx.environment.setWind: blend is 0–${this.maxSeconds} seconds`);
      return false;
    }
    const easing = o.easing ?? 'linear';
    if (!(ENVIRONMENT_EASINGS as readonly string[]).includes(easing)) {
      this.warn(`ctx.environment.setWind: easing is one of ${ENVIRONMENT_EASINGS.join(', ')}`);
      return false;
    }
    let key = '';
    if (wind !== null && wind !== undefined) {
      const merged = { ...(this.patches.get(this.target) ?? {}), ...(wind as WindPatch) };
      const problem = windPatchError(merged);
      if (problem !== null) {
        this.warn(`ctx.environment.setWind: ${problem}`);
        return false;
      }
      this.serial += 1;
      key = `w${this.serial}`;
      this.patches.set(key, Object.freeze(JSON.parse(JSON.stringify(merged)) as WindPatch));
    }
    this.used = true;
    this.target = key;
    this.transition = { from: keptShares(this.curr), to: new Map([[key, 1]]), elapsed: 0, total: Math.round(seconds * this.hz), easing };
    this.viewCache = null;
    return true;
  }

  /** One fixed step. */
  step(): void {
    if (!this.used) return;
    this.prev = this.curr;
    this.viewCache = null;
    const t = this.transition;
    if (t === null) return;
    t.elapsed = Math.min(t.total, t.elapsed + 1);
    const e = t.total === 0 ? 1 : easeEnvironment(t.easing, t.elapsed / t.total);
    const next = new Map<string, number>();
    for (const [k, w] of t.from) next.set(k, w * (1 - e));
    for (const [k, w] of t.to) next.set(k, (next.get(k) ?? 0) + w * e);
    for (const [k, w] of next) if (!(w > 0)) next.delete(k);
    this.curr = next;
    if (t.elapsed >= t.total) this.transition = null;
    // Script winds no weight or transition refers to are forgotten.
    for (const k of [...this.patches.keys()]) if (!this.curr.has(k) && !(this.transition?.from.has(k) ?? false) && k !== this.target) this.patches.delete(k);
  }

  /** Each wind's share interpolated between the last two steps (null while unused). */
  view(alpha: number): WindBlendView | null {
    if (!this.used) return null;
    if (this.viewCache !== null && this.viewCache.alpha === alpha) return this.viewCache.view;
    const keys = [...new Set([...this.prev.keys(), ...this.curr.keys()])].sort();
    const view: WindBlendView = Object.freeze(
      keys
        .map((k) => Object.freeze([k === '' ? null : (this.patches.get(k) ?? null), (this.prev.get(k) ?? 0) * (1 - alpha) + (this.curr.get(k) ?? 0) * alpha] as const))
        .filter(([, w]) => w > 0),
    );
    this.viewCache = { alpha, view };
    return view;
  }

  /** How far the last change's blend is (0–1; 1 when none runs). */
  progress(): number {
    const t = this.transition;
    return t === null || t.total === 0 ? 1 : t.elapsed / t.total;
  }

  /** The committed state (null while unused). */
  digestValue(): unknown {
    if (!this.used) return null;
    const t = this.transition;
    return [sorted(this.curr), this.target, t === null ? null : [sorted(t.from), sorted(t.to), t.elapsed, t.total, t.easing], [...this.patches.keys()].sort()];
  }

  saveState(): WindSaveState | undefined {
    if (!this.used) return undefined;
    const t = this.transition;
    return {
      weights: sorted(this.curr),
      transition: t === null ? null : { from: sorted(t.from), to: sorted(t.to), elapsed: t.elapsed, total: t.total, easing: t.easing },
      patches: [...this.patches.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, p]) => [k, JSON.parse(JSON.stringify(p)) as WindPatch]),
      target: this.target,
      serial: this.serial,
    };
  }

  /** A save section's problem (null: it can be restored). */
  checkState(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const v = value as Partial<WindSaveState>;
    const weightsOk = (list: unknown): boolean => Array.isArray(list) && list.length <= WIND_SHARES_MAX && list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1);
    if (typeof v !== 'object' || !weightsOk(v.weights)) return 'the wind section holds weights [[key, 0–1], …]';
    if (typeof v.target !== 'string' || !Number.isInteger(v.serial) || (v.serial as number) < 0) return 'the wind section holds a target key and a serial';
    const t = v.transition;
    if (t !== null && (typeof t !== 'object' || t === undefined || !weightsOk(t.from) || !weightsOk(t.to) || !Number.isInteger(t.elapsed) || !Number.isInteger(t.total) || t.elapsed < 0 || t.total < t.elapsed || !(ENVIRONMENT_EASINGS as readonly string[]).includes(t.easing))) return 'the wind transition is { from, to, elapsed, total, easing }';
    if (!Array.isArray(v.patches) || v.patches.length > WIND_SHARES_MAX) return `the wind section holds at most ${WIND_SHARES_MAX} [key, wind] rows`;
    for (const row of v.patches) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') return 'a wind row is [key, wind]';
      const problem = windPatchError(row[1]);
      if (problem !== null) return `wind "${row[0].slice(0, 64)}": ${problem}`;
    }
    return null;
  }

  /** Restore a checked save section (absent: the scene's wind). */
  restoreState(value: WindSaveState | undefined | null): void {
    this.reset();
    if (value === undefined || value === null) return;
    this.used = true;
    this.curr = new Map(value.weights);
    if (this.curr.size === 0) this.curr.set('', 1);
    this.prev = new Map(this.curr);
    this.target = value.target;
    this.serial = value.serial;
    for (const [k, p] of value.patches) this.patches.set(k, Object.freeze(p));
    const t = value.transition;
    this.transition = t === null ? null : { from: new Map(t.from), to: new Map(t.to), elapsed: t.elapsed, total: t.total, easing: t.easing };
  }
}

/**
 * One wind from a blend's shares over the scene's wind `base`: numbers
 * linearly, the direction as a vector (then made unit), the pattern texture
 * the heaviest share's. Each share's pattern speed is its own or its gust
 * frequency × size, so a blend of an old-style wind moves smoothly.
 */
export function blendWinds(base: WindConfig, view: WindBlendView): WindConfig {
  let total = 0;
  let heaviest: { w: number; noise: string | undefined } = { w: -1, noise: base.noise };
  const sum = { dx: 0, dz: 0, strength: 0, gust: 0, gustFrequency: 0, turbulence: 0, speed: 0, scale: 0, octaveScale: 0, octaveSpeed: 0 };
  for (const [patch, w] of view) {
    if (!(w > 0)) continue;
    const r: WindConfig = { ...base, ...(patch ?? {}) };
    const len = Math.hypot(r.direction[0], r.direction[1]) || 1;
    const scale = r.scale ?? WIND_DEFAULTS.scale;
    const octave = r.octave ?? WIND_DEFAULTS.octave;
    total += w;
    sum.dx += (r.direction[0] / len) * w;
    sum.dz += (r.direction[1] / len) * w;
    sum.strength += r.strength * w;
    sum.gust += r.gust * w;
    sum.gustFrequency += r.gustFrequency * w;
    sum.turbulence += r.turbulence * w;
    sum.speed += (r.speed ?? r.gustFrequency * scale) * w;
    sum.scale += scale * w;
    sum.octaveScale += octave.scale * w;
    sum.octaveSpeed += octave.speed * w;
    if (w > heaviest.w) heaviest = { w, noise: r.noise };
  }
  if (!(total > 0)) return base;
  const len = Math.hypot(sum.dx, sum.dz);
  const div = (v: number): number => v / total;
  return {
    direction: len > 1e-6 ? [sum.dx / len, sum.dz / len] : [base.direction[0], base.direction[1]],
    strength: div(sum.strength),
    gust: div(sum.gust),
    gustFrequency: div(sum.gustFrequency),
    turbulence: div(sum.turbulence),
    ...(heaviest.noise !== undefined ? { noise: heaviest.noise } : {}),
    speed: div(sum.speed),
    scale: div(sum.scale),
    octave: { scale: div(sum.octaveScale), speed: div(sum.octaveSpeed) },
  };
}
