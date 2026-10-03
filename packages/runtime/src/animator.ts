/**
 * The animator state machine (one per entity with an `animator`).
 *
 * Pure and deterministic: the runtime steps it with the fixed simulation
 * step, so a replay gives the same poses and the same clip events. The
 * renderer only reads the resulting pose (which clips, at which time, with
 * which weight).
 *
 * - Parameters: float/int/bool values; triggers stay set until a transition
 *   that tests them fires (then they reset).
 * - Each step: Any-State transitions first, then the current state's, in
 *   list order; a transition fires when all its conditions hold and its exit
 *   time (normalized, if any) is reached. While crossfading, only a
 *   transition of the source state with `interruption: "source"` may cut in.
 * - Time is normalized per state (1 = one clip length; a blend tree uses the
 *   blend-weighted length), so blended clips stay in step.
 * - Homogeneous speed: when every clip of a blend tree carries the ground
 *   speed it was authored for, the tree reads its parameter as a ground speed
 *   and scales time so the blended clips cover the ground at the parameter's
 *   speed (each clip's speed × the rate it plays at, weighted) everywhere in the
 *   range, below the first and past the last threshold too (Unity's "adjust
 *   time scale: homogeneous speed"). Where the blended speed is 0 (a standing
 *   clip alone) the tree plays as authored.
 * - Start time: each layer's entry state starts at the machine's start
 *   (normalized), and `play` may name the time the new state starts at.
 * - Clip events fire when a playing clip (weight > 0) passes their time.
 *
 * Override layers. Each layer is its own state machine over the
 * shared parameters (the base layer is the controller's own states). In a
 * step every layer picks its transition first and then they all fire, so a
 * trigger tested by two layers is seen by both before it resets. The pose
 * lists each layer's clips with its mask and weight (weight × its weight
 * parameter, clamped to 0–1); an `empty` state plays no clip, and a layer
 * at weight 0 fires no clip events. A controller without layers steps and
 * poses exactly as before.
 */

export type AnimatorValue = number | boolean;

export interface AnimatorClipLike {
  readonly assetId: string;
  readonly clip: string;
  readonly duration: number;
}

type MotionLike =
  | { readonly kind: 'clip'; readonly clip: AnimatorClipLike }
  | { readonly kind: 'blend1d'; readonly parameter: string; readonly children: readonly { readonly threshold: number; readonly clip: AnimatorClipLike; readonly speed?: number }[] }
  | { readonly kind: 'empty' };

interface StateLike {
  readonly id: string;
  readonly name: string;
  readonly motion: MotionLike;
  readonly speed: number;
  readonly speedParameter?: string;
  readonly loop: boolean;
}

interface TransitionLike {
  readonly from: string;
  readonly to: string;
  readonly conditions: readonly { readonly parameter: string; readonly op: string; readonly value?: number }[];
  readonly duration: number;
  readonly exitTime?: number;
  readonly interruption?: 'none' | 'source';
}

interface GraphLike {
  readonly states: readonly StateLike[];
  readonly transitions: readonly TransitionLike[];
  readonly entry: string;
}

/** An override layer. */
export interface AnimatorLayerLike extends GraphLike {
  readonly name: string;
  readonly mask: readonly string[];
  readonly weight: number;
  readonly weightParameter?: string;
}

export interface AnimatorControllerLike extends GraphLike {
  readonly controllerId: string;
  readonly parameters: readonly { readonly name: string; readonly type: 'float' | 'int' | 'bool' | 'trigger'; readonly default?: AnimatorValue }[];
  readonly events: readonly { readonly assetId: string; readonly clip: string; readonly time: number; readonly name: string }[];
  /** Override layers over the base layer. */
  readonly layers?: readonly AnimatorLayerLike[];
  /** Morph targets whose weight follows a float parameter (clamped to 0–1). */
  readonly morphs?: readonly { readonly target: string; readonly parameter: string }[];
}

export interface AnimatorPoseClip {
  readonly assetId: string;
  readonly clip: string;
  /** Seconds into the clip. */
  readonly time: number;
  readonly weight: number;
}

/** One override layer's part of the pose. */
export interface AnimatorPoseLayer {
  readonly name: string;
  /** The bones it drives (empty = every bone). */
  readonly mask: readonly string[];
  /** Its weight now (0–1). */
  readonly weight: number;
  /** Its current state's name. */
  readonly state: string;
  readonly clips: readonly AnimatorPoseClip[];
}

export interface AnimatorPose {
  /** The current state's name (the target's once a crossfade is over). */
  readonly state: string;
  readonly clips: readonly AnimatorPoseClip[];
  /** The override layers (only when the controller has them). */
  readonly layers?: readonly AnimatorPoseLayer[];
  /**
   * Morph target weights (0–1) by target name — the controller's
   * parameter-bound targets and the ones scripts set (only when there are some).
   */
  readonly morphs?: Readonly<Record<string, number>>;
}

/**
 * The playback speed range of one animator (a multiplier on
 * every layer's clip time and crossfade). 0 holds the pose (a freeze frame);
 * 10× is far past any fast-forward a game shows. Negative speeds are not
 * offered: crossfades and exit times only run forwards.
 */
export const ANIMATOR_SPEED_LIMITS = Object.freeze({ min: 0, max: 10 });
/** How many morph targets scripts may set on one animator (a face rig's worth). */
export const MAX_SCRIPT_MORPHS = 64;

export interface AnimatorEventFired {
  readonly name: string;
  readonly clip: string;
}

interface Playing {
  state: StateLike;
  /** Normalized time (1 = one length of the state's motion). */
  nt: number;
}

/** The parameter store a layer reads (the machine's). */
interface Params {
  num(name: string): number;
  value(name: string): AnimatorValue | undefined;
  reset(name: string): void;
}

/** One layer's state machine (the base layer or an override layer). */
class LayerGraph {
  private readonly states = new Map<string, StateLike>();
  private current: Playing;
  private next: { to: Playing; elapsed: number; duration: number; transition: TransitionLike } | null = null;

  constructor(
    private readonly graph: GraphLike,
    private readonly params: Params,
    private readonly events: AnimatorControllerLike['events'],
    start: number,
  ) {
    for (const s of graph.states) this.states.set(s.id, s);
    const entry = this.states.get(graph.entry) ?? graph.states[0]!;
    this.current = { state: entry, nt: start };
  }

  stateName(): string {
    return this.current.state.name;
  }

  private holds(t: TransitionLike, from: Playing): boolean {
    if (t.exitTime !== undefined && from.nt < t.exitTime) return false;
    const p = this.params;
    for (const c of t.conditions) {
      const v = p.value(c.parameter);
      switch (c.op) {
        case 'greater':
          if (!(p.num(c.parameter) > (c.value ?? 0))) return false;
          break;
        case 'less':
          if (!(p.num(c.parameter) < (c.value ?? 0))) return false;
          break;
        case 'equals':
          if (p.num(c.parameter) !== (c.value ?? 0)) return false;
          break;
        case 'notEquals':
          if (p.num(c.parameter) === (c.value ?? 0)) return false;
          break;
        case 'true':
        case 'trigger':
          if (v !== true) return false;
          break;
        case 'false':
          if (v !== false) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  fire(t: TransitionLike, startAt = 0): void {
    for (const c of t.conditions) if (c.op === 'trigger') this.params.reset(c.parameter);
    const to = this.states.get(t.to);
    if (to === undefined) return;
    const target: Playing = { state: to, nt: startAt };
    if (t.duration <= 0) {
      this.current = target;
      this.next = null;
    } else {
      // Interrupting a crossfade: its target becomes the source.
      if (this.next !== null) this.current = this.next.to;
      this.next = { to: target, elapsed: 0, duration: t.duration, transition: t };
    }
  }

  /**
   * Go to the state named `name` (by name, then id) over `fade`
   * seconds (0: at once), starting it at normalized time `time` — a
   * transition made on the spot. False: no such state.
   */
  play(name: string, fade: number, time = 0): boolean {
    let to: StateLike | undefined;
    for (const st of this.states.values()) if (st.name === name) to = to ?? st;
    to = to ?? this.states.get(name);
    if (to === undefined) return false;
    this.fire({ from: this.current.state.id, to: to.id, conditions: [], duration: fade > 0 && Number.isFinite(fade) ? fade : 0 }, time);
    return true;
  }

  pickTransition(): TransitionLike | null {
    const from = this.current;
    const list = this.graph.transitions;
    if (this.next !== null) {
      if (this.next.transition.interruption !== 'source') return null;
      for (const t of list) if (t.from === from.state.id && t !== this.next.transition && this.holds(t, from)) return t;
      return null;
    }
    for (const t of list) if (t.from === '*' && t.to !== from.state.id && this.holds(t, from)) return t;
    for (const t of list) if (t.from === from.state.id && this.holds(t, from)) return t;
    return null;
  }

  /** Blend weights of a state's clips (one clip: weight 1; empty: none), with each blend clip's ground speed. */
  private weights(state: StateLike): { clip: AnimatorClipLike; weight: number; speed?: number | undefined }[] {
    const m = state.motion;
    if (m.kind === 'clip') return [{ clip: m.clip, weight: 1 }];
    if (m.kind !== 'blend1d') return [];
    const x = this.params.num(m.parameter);
    const kids = m.children;
    if (x <= kids[0]!.threshold) return [{ clip: kids[0]!.clip, weight: 1, speed: kids[0]!.speed }];
    const last = kids[kids.length - 1]!;
    if (x >= last.threshold) return [{ clip: last.clip, weight: 1, speed: last.speed }];
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i]!;
      const b = kids[i + 1]!;
      if (x >= a.threshold && x <= b.threshold) {
        const f = (x - a.threshold) / (b.threshold - a.threshold);
        return [
          { clip: a.clip, weight: 1 - f, speed: a.speed },
          { clip: b.clip, weight: f, speed: b.speed },
        ].filter((w) => w.weight > 0);
      }
    }
    return [{ clip: last.clip, weight: 1, speed: last.speed }];
  }

  private length(state: StateLike): number {
    // An empty state runs on one-second lengths (its exit times are seconds).
    if (state.motion.kind === 'empty') return 1;
    const ws = this.weights(state);
    let len = 0;
    for (const w of ws) len += w.clip.duration * w.weight;
    return Math.max(1e-4, len);
  }

  private rate(state: StateLike): number {
    return state.speed * (state.speedParameter !== undefined ? this.params.num(state.speedParameter) : 1) * this.groundScale(state);
  }

  /**
   * A blend tree's homogeneous-speed time scale (1 without speeds). Clip i
   * plays `rate × dᵢ / L` of its seconds a second (L = Σ wᵢ·dᵢ, the
   * blend-weighted length) and covers sᵢ metres a second of its own time, so
   * the blend covers rate × Σ wᵢ·sᵢ·dᵢ / L; the scale makes that the
   * parameter.
   */
  private groundScale(state: StateLike): number {
    const m = state.motion;
    if (m.kind !== 'blend1d' || m.children.some((k) => k.speed === undefined)) return 1;
    let ground = 0;
    let length = 0;
    for (const w of this.weights(state)) {
      ground += w.weight * (w.speed ?? 0) * w.clip.duration;
      length += w.weight * w.clip.duration;
    }
    if (!(ground > 1e-9)) return 1;
    return (Math.max(0, this.params.num(m.parameter)) * length) / ground;
  }

  private clipTime(p: Playing, clip: AnimatorClipLike): number {
    const nt = p.state.loop ? p.nt - Math.floor(p.nt) : Math.min(1, Math.max(0, p.nt));
    return nt * clip.duration;
  }

  /** Advance by `dt` (after this step's transition fired); collects clip events when `withEvents`. */
  advance(dt: number, events: AnimatorEventFired[], withEvents: boolean): void {
    const go = (p: Playing): void => {
      const before = p.nt;
      p.nt += (dt * this.rate(p.state)) / this.length(p.state);
      if (!p.state.loop) p.nt = Math.min(p.nt, Math.max(1, before));
      if (withEvents && this.events.length > 0) this.collectEvents(p, before, events);
    };
    go(this.current);
    if (this.next !== null) {
      go(this.next.to);
      this.next.elapsed += dt;
      if (this.next.elapsed >= this.next.duration) {
        this.current = this.next.to;
        this.next = null;
      }
    }
  }

  private collectEvents(p: Playing, before: number, out: AnimatorEventFired[]): void {
    if (p.nt <= before) return;
    for (const w of this.weights(p.state)) {
      for (const e of this.events) {
        if (e.assetId !== w.clip.assetId || e.clip !== w.clip.clip) continue;
        const at = e.time / Math.max(1e-4, w.clip.duration);
        // Passes of the event point between `before` (exclusive) and `nt` (inclusive).
        const first = Math.floor(before - at) + 1;
        const lastPass = Math.floor(p.nt - at);
        for (let k = first; k <= lastPass; k++) {
          if (!p.state.loop && k > 0) break;
          if (k < 0) continue;
          out.push({ name: e.name, clip: e.clip });
        }
      }
    }
  }

  pose(): { state: string; clips: AnimatorPoseClip[] } {
    const clips: AnimatorPoseClip[] = [];
    const f = this.next === null ? 0 : Math.min(1, this.next.elapsed / this.next.duration);
    const add = (p: Playing, stateWeight: number): void => {
      if (stateWeight <= 0) return;
      for (const w of this.weights(p.state)) clips.push({ assetId: w.clip.assetId, clip: w.clip.clip, time: this.clipTime(p, w.clip), weight: w.weight * stateWeight });
    };
    add(this.current, 1 - f);
    if (this.next !== null) add(this.next.to, f);
    return { state: (f >= 1 && this.next !== null ? this.next.to : this.current).state.name, clips };
  }
}

export class AnimatorMachine {
  private readonly params = new Map<string, AnimatorValue>();
  private readonly types = new Map<string, 'float' | 'int' | 'bool' | 'trigger'>();
  /** The base layer, then the override layers. */
  private readonly graphs: LayerGraph[];
  private readonly layers: readonly AnimatorLayerLike[];
  /** The per-instance playback speed (1 = as authored). */
  private speedMul = 1;
  private readonly morphBindings: readonly { readonly target: string; readonly parameter: string }[];
  private readonly scriptMorphs = new Map<string, number>();

  /** `start`: the normalized time every layer's entry state starts at (0: its beginning). */
  constructor(controller: AnimatorControllerLike, overrides: Readonly<Record<string, AnimatorValue>> = {}, start = 0) {
    for (const p of controller.parameters) {
      this.types.set(p.name, p.type);
      this.params.set(p.name, p.type === 'trigger' ? false : (p.default ?? (p.type === 'bool' ? false : 0)));
    }
    for (const [k, v] of Object.entries(overrides)) if (this.types.has(k)) this.set(k, v);
    const store: Params = {
      num: (name) => this.num(name),
      value: (name) => this.params.get(name),
      reset: (name) => void this.params.set(name, false),
    };
    this.layers = controller.layers ?? [];
    const at = Number.isFinite(start) && start > 0 ? start : 0;
    this.graphs = [controller, ...this.layers].map((g) => new LayerGraph(g, store, controller.events, at));
    this.morphBindings = controller.morphs ?? [];
  }

  /**
   * Set the playback speed multiplier (every layer's clip time and
   * crossfades; transitions still test every step). False for a value outside
   * {@link ANIMATOR_SPEED_LIMITS} or not a finite number.
   */
  setSpeed(value: number): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < ANIMATOR_SPEED_LIMITS.min || value > ANIMATOR_SPEED_LIMITS.max) return false;
    this.speedMul = value;
    return true;
  }

  /** The playback speed multiplier. */
  speed(): number {
    return this.speedMul;
  }

  /**
   * Set a morph target's weight by its name (clamped to 0–1). It
   * overrides a parameter binding of the same target. False for a bad name or
   * value, or past {@link MAX_SCRIPT_MORPHS} names.
   */
  setMorph(name: string, weight: number): boolean {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128 || typeof weight !== 'number' || !Number.isFinite(weight)) return false;
    if (!this.scriptMorphs.has(name) && this.scriptMorphs.size >= MAX_SCRIPT_MORPHS) return false;
    this.scriptMorphs.set(name, Math.min(1, Math.max(0, weight)));
    return true;
  }

  /** A morph target's weight now (a script's value, else its parameter binding's; 0 when neither). */
  morph(name: string): number {
    const own = this.scriptMorphs.get(name);
    if (own !== undefined) return own;
    const b = this.morphBindings.find((m) => m.target === name);
    return b !== undefined ? this.clamp01(this.num(b.parameter)) : 0;
  }

  private clamp01(v: number): number {
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }

  has(name: string): boolean {
    return this.types.has(name);
  }

  /** Set a parameter (an unknown name or a wrong type is ignored; numbers are clamped to finite). */
  set(name: string, value: AnimatorValue): boolean {
    const type = this.types.get(name);
    if (type === undefined) return false;
    if (type === 'bool' || type === 'trigger') {
      if (typeof value !== 'boolean') return false;
      this.params.set(name, value);
      return true;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    this.params.set(name, type === 'int' ? Math.trunc(value) : value);
    return true;
  }

  trigger(name: string): boolean {
    if (this.types.get(name) !== 'trigger') return false;
    this.params.set(name, true);
    return true;
  }

  get(name: string): AnimatorValue | undefined {
    return this.params.get(name);
  }

  /**
   * Go to a state of layer `layer` (0: the base layer) by name, crossfading
   * over `fade` seconds, the new state starting at normalized time `time`
   * (0–1 of its length; timeline animator keys, scripts). False for an
   * unknown state or layer, or a time that is not a finite number ≥ 0.
   */
  play(state: string, fade = 0, layer = 0, time = 0): boolean {
    const g = this.graphs[layer];
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return false;
    return g !== undefined && typeof state === 'string' && g.play(state, fade, time);
  }

  /**
   * The current state's name (the crossfade target once it is over): of the
   * base layer, or of layer `layer` (1 = the first override layer; an
   * unknown layer reads the base layer).
   */
  stateName(layer = 0): string {
    return (this.graphs[layer] ?? this.graphs[0]!).stateName();
  }

  /** How many layers (the base layer counts). */
  layerCount(): number {
    return this.graphs.length;
  }

  private num(name: string): number {
    const v = this.params.get(name);
    return typeof v === 'number' ? v : v === true ? 1 : 0;
  }

  /** An override layer's weight now (its weight × its weight parameter, clamped to 0–1). */
  private layerWeight(l: AnimatorLayerLike): number {
    const w = l.weight * (l.weightParameter !== undefined ? this.num(l.weightParameter) : 1);
    return Math.min(1, Math.max(0, Number.isFinite(w) ? w : 0));
  }

  /** Advance one step of `dt` seconds; returns the clip events passed in it. */
  step(dt: number): AnimatorEventFired[] {
    // Every layer picks first, then they fire (a trigger reaches every layer that tests it).
    const picks = this.graphs.map((g) => g.pickTransition());
    picks.forEach((t, i) => {
      if (t !== null) this.graphs[i]!.fire(t);
    });
    const events: AnimatorEventFired[] = [];
    // The playback speed scales the time every layer advances by (×1 keeps dt exact).
    const d = this.speedMul === 1 ? dt : dt * this.speedMul;
    this.graphs.forEach((g, i) => g.advance(d, events, i === 0 || this.layerWeight(this.layers[i - 1]!) > 0));
    return events;
  }

  pose(): AnimatorPose {
    const base = this.graphs[0]!.pose();
    const morphs = this.morphWeights();
    if (this.layers.length === 0) return morphs === null ? base : { ...base, morphs };
    return {
      ...base,
      layers: this.layers.map((l, i) => {
        const p = this.graphs[i + 1]!.pose();
        return { name: l.name, mask: l.mask, weight: this.layerWeight(l), state: p.state, clips: p.clips };
      }),
      ...(morphs !== null ? { morphs } : {}),
    };
  }

  /** The morph weights (bindings, then script values over them), or null when there are none. */
  private morphWeights(): Record<string, number> | null {
    if (this.morphBindings.length === 0 && this.scriptMorphs.size === 0) return null;
    const out: Record<string, number> = {};
    for (const b of this.morphBindings) out[b.target] = this.clamp01(this.num(b.parameter));
    for (const [k, v] of this.scriptMorphs) out[k] = v;
    return out;
  }
}
