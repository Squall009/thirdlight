/**
 * The environment blend state — simulation state, so
 * page, worker, replays and saves agree.
 *
 * The state is a weight per key (`''` = the base look, a preset id, or a
 * script's patched preset `<preset>~<n>`); the weights sum to 1. A change
 * (`set`) starts a transition from the weights now to the target over whole
 * steps (eased); an interrupted blend starts from where it is. `blend(a, b,
 * t)` holds a mix directly (a timeline or a script drives t). The renderer
 * turns weights into values (`environment-blend.ts`); the simulation never
 * needs the values.
 *
 * Inert until a script changes the environment: nothing enters the digest,
 * the frame state or the renderer before that.
 */
import { validateEnvironmentPatch, type EnvironmentLookParts, type ModelErrorV2 } from '@thirdlight/project-model';

import { ENVIRONMENT_EASINGS, easeEnvironment, type EnvironmentBlendView, type EnvironmentEasing, type EnvironmentOverride } from './environment-blend';
import type { BehaviorEnvironment, EnvironmentChangeOptions } from './types';

/** The longest blend in seconds (an engine limit: ten minutes covers a slow day cycle's segment). */
export const MAX_ENVIRONMENT_BLEND_SECONDS = 600;
/** Patched presets alive at once (each change with an override adds one until its weight is gone). */
const MAX_OVERRIDES = 16;

interface Transition {
  from: Map<string, number>;
  to: Map<string, number>;
  elapsed: number;
  total: number;
  easing: EnvironmentEasing;
}

/** What a save's `environment` section holds. */
export interface EnvironmentSaveState {
  weights: [string, number][];
  target: string | null;
  transition: { from: [string, number][]; to: [string, number][]; elapsed: number; total: number; easing: EnvironmentEasing } | null;
  overrides: [string, EnvironmentOverride][];
  serial: number;
}

const sortedEntries = (m: ReadonlyMap<string, number>): [string, number][] => [...m.entries()].filter(([, w]) => w > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export class EnvironmentDirector {
  private readonly presetIds: ReadonlySet<string>;
  private curr = new Map<string, number>([['', 1]]);
  private prev = new Map<string, number>([['', 1]]);
  private transition: Transition | null = null;
  private target: string | null = null;
  private overrides = new Map<string, EnvironmentOverride>();
  private serial = 0;
  private used = false;
  private viewCache: { alpha: number; view: EnvironmentBlendView } | null = null;
  readonly api: BehaviorEnvironment;

  constructor(
    private readonly hz: number,
    presetIds: readonly string[],
    private readonly warn: (message: string) => void,
  ) {
    this.presetIds = new Set(presetIds);
    this.api = this.buildApi();
  }

  /** A script changed the environment this run (until then nothing is reported). */
  get active(): boolean {
    return this.used;
  }

  /** A new run: the base look, nothing used. */
  reset(): void {
    this.curr = new Map([['', 1]]);
    this.prev = new Map([['', 1]]);
    this.transition = null;
    this.target = null;
    this.overrides.clear();
    this.serial = 0;
    this.used = false;
    this.viewCache = null;
  }

  /** One fixed step: advance the transition (called at the end of every step). */
  step(): void {
    if (!this.used) return;
    this.prev = this.curr;
    // The view interpolates prev → curr: a new step is a new view even at the same alpha.
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
    this.prune();
    this.viewCache = null;
  }

  /** The weights interpolated between the last two steps (alpha 0–1), or null while unused. */
  view(alpha: number): EnvironmentBlendView | null {
    if (!this.used) return null;
    const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
    if (this.viewCache !== null && this.viewCache.alpha === a) return this.viewCache.view;
    const keys = new Set([...this.prev.keys(), ...this.curr.keys()]);
    const mixed = new Map<string, number>();
    for (const k of keys) mixed.set(k, (this.prev.get(k) ?? 0) * (1 - a) + (this.curr.get(k) ?? 0) * a);
    const overrides: Record<string, EnvironmentOverride> = {};
    for (const k of keys) {
      const o = this.overrides.get(k);
      if (o !== undefined) overrides[k] = o;
    }
    const view: EnvironmentBlendView = Object.freeze({ weights: Object.freeze(sortedEntries(mixed).map((e) => Object.freeze(e) as readonly [string, number])), overrides: Object.freeze(overrides), target: this.target, progress: this.progress() });
    this.viewCache = { alpha: a, view };
    return view;
  }

  /** The committed state as digest text (null while unused). */
  digestText(): string | null {
    if (!this.used) return null;
    const t = this.transition;
    return JSON.stringify([sortedEntries(this.curr), this.target, t === null ? null : [sortedEntries(t.from), sortedEntries(t.to), t.elapsed, t.total, t.easing], [...this.overrides.keys()].sort()]);
  }

  saveState(): EnvironmentSaveState | undefined {
    if (!this.used) return undefined;
    const t = this.transition;
    return {
      weights: sortedEntries(this.curr),
      target: this.target,
      transition: t === null ? null : { from: sortedEntries(t.from), to: sortedEntries(t.to), elapsed: t.elapsed, total: t.total, easing: t.easing },
      overrides: [...this.overrides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, o]) => [k, JSON.parse(JSON.stringify(o)) as EnvironmentOverride]),
      serial: this.serial,
    };
  }

  /** A save section's problem (null: it can be restored). */
  checkState(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const v = value as Partial<EnvironmentSaveState>;
    const weightsOk = (list: unknown): boolean => Array.isArray(list) && list.length <= 64 && list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1);
    if (typeof v !== 'object' || !weightsOk(v.weights)) return 'the environment section holds weights [[key, 0–1], …]';
    if (v.target !== null && typeof v.target !== 'string') return 'the environment target is a preset id or null';
    if (!Number.isInteger(v.serial) || (v.serial as number) < 0) return 'the environment serial is a whole number';
    const t = v.transition;
    if (t !== null && (typeof t !== 'object' || t === undefined || !weightsOk(t.from) || !weightsOk(t.to) || !Number.isInteger(t.elapsed) || !Number.isInteger(t.total) || t.elapsed < 0 || t.total < t.elapsed || !(ENVIRONMENT_EASINGS as readonly string[]).includes(t.easing))) return 'the environment transition is { from, to, elapsed, total, easing }';
    if (!Array.isArray(v.overrides) || v.overrides.length > MAX_OVERRIDES) return `the environment overrides are at most ${MAX_OVERRIDES} [key, { preset, patch }] rows`;
    for (const row of v.overrides) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'object' || row[1] === null) return 'an environment override row is [key, { preset, patch }]';
      const errs: ModelErrorV2[] = [];
      validateEnvironmentPatch((row[1] as EnvironmentOverride).patch, '/patch', errs);
      if (errs.length > 0) return `environment override "${row[0].slice(0, 64)}": ${errs[0]!.message}`;
    }
    return null;
  }

  /** Restore a checked save section (absent: the base look). */
  restoreState(value: EnvironmentSaveState | undefined | null): void {
    this.reset();
    if (value === undefined || value === null) return;
    this.used = true;
    this.curr = new Map(value.weights);
    if (this.curr.size === 0) this.curr.set('', 1);
    this.prev = new Map(this.curr);
    this.target = value.target;
    this.serial = value.serial;
    for (const [k, o] of value.overrides) this.overrides.set(k, o);
    const t = value.transition;
    this.transition = t === null ? null : { from: new Map(t.from), to: new Map(t.to), elapsed: t.elapsed, total: t.total, easing: t.easing };
  }

  private progress(): number {
    const t = this.transition;
    return t === null ? 1 : t.total === 0 ? 1 : t.elapsed / t.total;
  }

  /** Forget patched presets no weight or transition refers to. */
  private prune(): void {
    if (this.overrides.size === 0) return;
    const t = this.transition;
    for (const k of [...this.overrides.keys()]) if (!this.curr.has(k) && !(t?.from.has(k) ?? false) && !(t?.to.has(k) ?? false)) this.overrides.delete(k);
  }

  /** The preset a key stands for ('' = the base look; a patched preset's key → its preset). */
  private presetOf(key: string): string {
    const o = this.overrides.get(key);
    return o !== undefined ? (o.preset ?? '') : key;
  }

  private known(id: string): boolean {
    return id === '' || this.presetIds.has(id);
  }

  private change(presetId: unknown, options: unknown): boolean {
    if (typeof presetId !== 'string' || !this.known(presetId)) {
      this.warn(`ctx.environment.set: no environment preset "${String(presetId).slice(0, 64)}"`);
      return false;
    }
    const o = (typeof options === 'object' && options !== null ? options : {}) as EnvironmentChangeOptions;
    const seconds = o.blend ?? 0;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_ENVIRONMENT_BLEND_SECONDS) {
      this.warn(`ctx.environment.set: blend is 0–${MAX_ENVIRONMENT_BLEND_SECONDS} seconds`);
      return false;
    }
    const easing = o.easing ?? 'linear';
    if (!(ENVIRONMENT_EASINGS as readonly string[]).includes(easing)) {
      this.warn(`ctx.environment.set: easing is one of ${ENVIRONMENT_EASINGS.join(', ')}`);
      return false;
    }
    let key = presetId;
    if (o.override !== undefined) {
      const errs: ModelErrorV2[] = [];
      validateEnvironmentPatch(o.override, '/override', errs);
      if (errs.length > 0) {
        this.warn(`ctx.environment.set: ${errs[0]!.path} ${errs[0]!.message}`);
        return false;
      }
      if (this.overrides.size >= MAX_OVERRIDES) {
        this.warn(`ctx.environment.set: at most ${MAX_OVERRIDES} overridden looks may blend at once`);
        return false;
      }
      this.serial += 1;
      key = `${presetId}~${this.serial}`;
      this.overrides.set(key, Object.freeze({ preset: presetId === '' ? null : presetId, patch: JSON.parse(JSON.stringify(o.override)) as EnvironmentLookParts }));
    }
    this.used = true;
    this.target = presetId === '' ? null : presetId;
    // Whole steps (rounded): the blend ends on a step boundary in every runner.
    const total = Math.round(seconds * this.hz);
    this.transition = { from: new Map(this.curr), to: new Map([[key, 1]]), elapsed: 0, total, easing };
    this.viewCache = null;
    return true;
  }

  private hold(a: unknown, b: unknown, t: unknown): boolean {
    if (typeof a !== 'string' || typeof b !== 'string' || !this.known(a) || !this.known(b)) {
      this.warn(`ctx.environment.blend: no environment preset "${String(typeof a === 'string' && !this.known(a) ? a : b).slice(0, 64)}"`);
      return false;
    }
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      this.warn('ctx.environment.blend: t is a number 0–1');
      return false;
    }
    const x = Math.max(0, Math.min(1, t));
    const to = new Map<string, number>();
    to.set(a, 1 - x);
    to.set(b, (to.get(b) ?? 0) + x);
    for (const [k, w] of to) if (!(w > 0)) to.delete(k);
    if (to.size === 0) to.set(b, 1);
    this.used = true;
    this.target = b === '' ? null : b;
    this.transition = { from: to, to, elapsed: 0, total: 0, easing: 'linear' };
    this.viewCache = null;
    return true;
  }

  private buildApi(): BehaviorEnvironment {
    const presets = Object.freeze([...this.presetIds].sort());
    return Object.freeze({
      set: (presetId: string, options?: EnvironmentChangeOptions): boolean => this.change(presetId, options),
      blend: (a: string, b: string, t: number): boolean => this.hold(a, b, t),
      state: () => ({ target: this.target ?? '', progress: this.progress(), blending: this.transition !== null && this.transition.total > 0 }),
      weight: (presetId: string): number => {
        let w = 0;
        for (const [k, v] of this.curr) if (this.presetOf(k) === presetId) w += v;
        return w;
      },
      presets: (): readonly string[] => presets,
    }) as BehaviorEnvironment;
  }
}
