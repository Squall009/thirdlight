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
 * The active scene: with several scenes loaded, the active scene's look is
 * the base look (`''`) the presets lay over. The first start scene is active;
 * `activate` makes another active, its look blending in from the one before
 * over whole steps (a scene transition's fade, a script's `blend`), so the
 * blend is simulation state too.
 *
 * Inert until a script changes the environment or the active scene changes:
 * nothing enters the digest, the frame state or the renderer before that.
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

/** The active scene and the look blending in from the scene active before it. */
interface SceneLookState {
  active: string | null;
  /** The scene whose look fades out (null: none, the active scene's look alone). */
  from: string | null;
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
  /** The active scene and its look's blend (absent: the first start scene, at once). */
  scene?: SceneLookState;
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
  /** The active scene (the first start scene until another is made active). */
  private scene: SceneLookState;
  /** The incoming scene look's share at the last two steps (1: none blending). */
  private scenePrev = 1;
  private sceneCurr = 1;
  /** The active scene is not the start one, or was changed this run (it is then reported and in the digest). */
  private sceneChanged = false;
  readonly api: BehaviorEnvironment;

  constructor(
    private readonly hz: number,
    presetIds: readonly string[],
    private readonly warn: (message: string) => void,
    /** The first start scene (null: a game without a scene catalog). */
    private readonly startScene: string | null = null,
  ) {
    this.presetIds = new Set(presetIds);
    this.scene = { active: startScene, from: null, elapsed: 0, total: 0, easing: 'linear' };
    this.api = this.buildApi();
  }

  /** A script changed the environment this run (until then nothing is reported). */
  get active(): boolean {
    return this.used;
  }

  /** The active scene (null: no scene catalog, or none loaded yet). */
  activeScene(): string | null {
    return this.scene.active;
  }

  /**
   * Make a scene the active one: its look becomes the base look, blending in
   * from the look now over `seconds` (whole steps) with `easing`. The same
   * scene again changes nothing.
   */
  activate(sceneId: string, seconds = 0, easing: EnvironmentEasing = 'linear'): void {
    if (sceneId === this.scene.active) return;
    const total = Math.round(Math.max(0, Math.min(MAX_ENVIRONMENT_BLEND_SECONDS, seconds)) * this.hz);
    // An interrupted fade starts over from the scene that was coming in (its look is the base now).
    this.scene = { active: sceneId, from: total > 0 ? this.scene.active : null, elapsed: 0, total, easing };
    this.sceneCurr = total > 0 ? 0 : 1;
    this.scenePrev = this.sceneCurr;
    this.sceneChanged = true;
    this.viewCache = null;
  }

  /** A new run: the base look of the first start scene, nothing used. */
  reset(): void {
    this.curr = new Map([['', 1]]);
    this.prev = new Map([['', 1]]);
    this.transition = null;
    this.target = null;
    this.overrides.clear();
    this.serial = 0;
    this.used = false;
    this.viewCache = null;
    this.scene = { active: this.startScene, from: null, elapsed: 0, total: 0, easing: 'linear' };
    this.scenePrev = 1;
    this.sceneCurr = 1;
    this.sceneChanged = false;
  }

  /** One fixed step: advance the transition and the scene look's blend (called at the end of every step). */
  step(): void {
    this.stepScene();
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

  private stepScene(): void {
    if (!this.sceneChanged) return;
    this.scenePrev = this.sceneCurr;
    this.viewCache = null;
    const sc = this.scene;
    if (sc.from === null) {
      this.sceneCurr = 1;
      return;
    }
    // The step after the one that showed the full share ends the fade (the view interpolates up to it).
    if (sc.elapsed >= sc.total) {
      this.scene = { ...sc, from: null, elapsed: 0, total: 0 };
      this.sceneCurr = 1;
      return;
    }
    sc.elapsed += 1;
    this.sceneCurr = easeEnvironment(sc.easing, sc.elapsed / sc.total);
  }

  /** The weights interpolated between the last two steps (alpha 0–1), or null while unused and the start scene is active. */
  view(alpha: number): EnvironmentBlendView | null {
    if (!this.used && !this.sceneChanged) return null;
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
    // The scene look's share interpolates like the weights; a finished fade still shows its last step's share until the next step.
    const sceneWeight = this.scenePrev * (1 - a) + this.sceneCurr * a;
    const from = this.scene.from;
    const scene = this.sceneChanged ? { scene: Object.freeze({ active: this.scene.active, from, weight: from === null ? 1 : sceneWeight }) } : {};
    const view: EnvironmentBlendView = Object.freeze({ weights: Object.freeze(sortedEntries(mixed).map((e) => Object.freeze(e) as readonly [string, number])), overrides: Object.freeze(overrides), target: this.target, progress: this.progress(), ...scene });
    this.viewCache = { alpha: a, view };
    return view;
  }

  /** The committed state as digest text (null while unused and the start scene is active). */
  digestText(): string | null {
    if (!this.used && !this.sceneChanged) return null;
    const t = this.transition;
    const presets = this.used ? [sortedEntries(this.curr), this.target, t === null ? null : [sortedEntries(t.from), sortedEntries(t.to), t.elapsed, t.total, t.easing], [...this.overrides.keys()].sort()] : null;
    // The active scene only once it changed, so a game that never changes it keeps its digests.
    if (!this.sceneChanged) return JSON.stringify(presets);
    const sc = this.scene;
    return JSON.stringify([presets, [sc.active, sc.from, sc.elapsed, sc.total, sc.easing]]);
  }

  saveState(): EnvironmentSaveState | undefined {
    if (!this.used && !this.sceneChanged) return undefined;
    const t = this.transition;
    return {
      weights: sortedEntries(this.curr),
      target: this.target,
      transition: t === null ? null : { from: sortedEntries(t.from), to: sortedEntries(t.to), elapsed: t.elapsed, total: t.total, easing: t.easing },
      overrides: [...this.overrides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, o]) => [k, JSON.parse(JSON.stringify(o)) as EnvironmentOverride]),
      serial: this.serial,
      ...(this.sceneChanged ? { scene: { ...this.scene } } : {}),
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
    const sc = v.scene;
    if (sc !== undefined && (typeof sc !== 'object' || sc === null || !(sc.active === null || typeof sc.active === 'string') || !(sc.from === null || typeof sc.from === 'string') || !Number.isInteger(sc.elapsed) || !Number.isInteger(sc.total) || sc.elapsed < 0 || sc.total < sc.elapsed || !(ENVIRONMENT_EASINGS as readonly string[]).includes(sc.easing))) {
      return 'the environment scene is { active, from, elapsed, total, easing }';
    }
    for (const row of v.overrides) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'object' || row[1] === null) return 'an environment override row is [key, { preset, patch }]';
      const errs: ModelErrorV2[] = [];
      validateEnvironmentPatch((row[1] as EnvironmentOverride).patch, '/patch', errs);
      if (errs.length > 0) return `environment override "${row[0].slice(0, 64)}": ${errs[0]!.message}`;
    }
    return null;
  }

  /**
   * Restore a checked save section (absent: the base look). The active scene
   * comes back only when `loaded` says it is loaded (the scenes a save was
   * made in need not be; the look then stays the one now).
   */
  restoreState(value: EnvironmentSaveState | undefined | null, loaded: (sceneId: string) => boolean = () => true): void {
    const keep = { scene: this.scene, prev: this.scenePrev, curr: this.sceneCurr, changed: this.sceneChanged };
    this.reset();
    const sc = value?.scene;
    // A save made with the start scene active says nothing of it: the start scene again, when it is loaded.
    if (sc === undefined && this.startScene !== null && !loaded(this.startScene)) {
      this.scene = keep.scene;
      this.scenePrev = keep.prev;
      this.sceneCurr = keep.curr;
      this.sceneChanged = keep.changed;
    }
    if (value === undefined || value === null) return;
    if (sc !== undefined && (sc.active === null || loaded(sc.active))) {
      this.scene = { ...sc, from: sc.from !== null && loaded(sc.from) ? sc.from : null };
      this.sceneCurr = this.scene.from === null ? 1 : easeEnvironment(sc.easing, sc.total === 0 ? 1 : sc.elapsed / sc.total);
      this.scenePrev = this.sceneCurr;
      this.sceneChanged = true;
    }
    // A section from a game that only changed its scene holds the base weights; the presets stay unused.
    if (value.weights.length === 1 && value.weights[0]![0] === '' && value.transition === null && value.overrides.length === 0 && value.target === null && value.serial === 0) return;
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
