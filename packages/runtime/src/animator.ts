/**
 * Phase 9.7: the animator state machine (one per entity with an `animator`).
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
 * - Clip events fire when a playing clip (weight > 0) passes their time.
 */

export type AnimatorValue = number | boolean;

export interface AnimatorClipLike {
  readonly assetId: string;
  readonly clip: string;
  readonly duration: number;
}

export interface AnimatorControllerLike {
  readonly controllerId: string;
  readonly parameters: readonly { readonly name: string; readonly type: 'float' | 'int' | 'bool' | 'trigger'; readonly default?: AnimatorValue }[];
  readonly states: readonly {
    readonly id: string;
    readonly name: string;
    readonly motion:
      | { readonly kind: 'clip'; readonly clip: AnimatorClipLike }
      | { readonly kind: 'blend1d'; readonly parameter: string; readonly children: readonly { readonly threshold: number; readonly clip: AnimatorClipLike }[] };
    readonly speed: number;
    readonly speedParameter?: string;
    readonly loop: boolean;
  }[];
  readonly transitions: readonly {
    readonly from: string;
    readonly to: string;
    readonly conditions: readonly { readonly parameter: string; readonly op: string; readonly value?: number }[];
    readonly duration: number;
    readonly exitTime?: number;
    readonly interruption?: 'none' | 'source';
  }[];
  readonly entry: string;
  readonly events: readonly { readonly assetId: string; readonly clip: string; readonly time: number; readonly name: string }[];
}

export interface AnimatorPoseClip {
  readonly assetId: string;
  readonly clip: string;
  /** Seconds into the clip. */
  readonly time: number;
  readonly weight: number;
}

export interface AnimatorPose {
  /** The current state's name (the target's once a crossfade is over). */
  readonly state: string;
  readonly clips: readonly AnimatorPoseClip[];
}

export interface AnimatorEventFired {
  readonly name: string;
  readonly clip: string;
}

type State = AnimatorControllerLike['states'][number];
type Transition = AnimatorControllerLike['transitions'][number];

interface Playing {
  state: State;
  /** Normalized time (1 = one length of the state's motion). */
  nt: number;
}

export class AnimatorMachine {
  private readonly params = new Map<string, AnimatorValue>();
  private readonly types = new Map<string, 'float' | 'int' | 'bool' | 'trigger'>();
  private readonly states = new Map<string, State>();
  private current: Playing;
  private next: { to: Playing; elapsed: number; duration: number; transition: Transition } | null = null;

  constructor(
    private readonly controller: AnimatorControllerLike,
    overrides: Readonly<Record<string, AnimatorValue>> = {},
  ) {
    for (const p of controller.parameters) {
      this.types.set(p.name, p.type);
      this.params.set(p.name, p.type === 'trigger' ? false : (p.default ?? (p.type === 'bool' ? false : 0)));
    }
    for (const [k, v] of Object.entries(overrides)) if (this.types.has(k)) this.set(k, v);
    for (const s of controller.states) this.states.set(s.id, s);
    const entry = this.states.get(controller.entry) ?? controller.states[0]!;
    this.current = { state: entry, nt: 0 };
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

  /** The current state's name (the crossfade target once it is over). */
  stateName(): string {
    return this.current.state.name;
  }

  private num(name: string): number {
    const v = this.params.get(name);
    return typeof v === 'number' ? v : v === true ? 1 : 0;
  }

  private holds(t: Transition, from: Playing): boolean {
    if (t.exitTime !== undefined && from.nt < t.exitTime) return false;
    for (const c of t.conditions) {
      const v = this.params.get(c.parameter);
      switch (c.op) {
        case 'greater':
          if (!(this.num(c.parameter) > (c.value ?? 0))) return false;
          break;
        case 'less':
          if (!(this.num(c.parameter) < (c.value ?? 0))) return false;
          break;
        case 'equals':
          if (this.num(c.parameter) !== (c.value ?? 0)) return false;
          break;
        case 'notEquals':
          if (this.num(c.parameter) === (c.value ?? 0)) return false;
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

  private fire(t: Transition): void {
    for (const c of t.conditions) if (c.op === 'trigger') this.params.set(c.parameter, false);
    const to = this.states.get(t.to);
    if (to === undefined) return;
    const target: Playing = { state: to, nt: 0 };
    if (t.duration <= 0) {
      this.current = target;
      this.next = null;
    } else {
      // Interrupting a crossfade: its target becomes the source.
      if (this.next !== null) this.current = this.next.to;
      this.next = { to: target, elapsed: 0, duration: t.duration, transition: t };
    }
  }

  private pickTransition(): Transition | null {
    const from = this.current;
    if (this.next !== null) {
      if (this.next.transition.interruption !== 'source') return null;
      for (const t of this.controller.transitions) if (t.from === from.state.id && t !== this.next.transition && this.holds(t, from)) return t;
      return null;
    }
    for (const t of this.controller.transitions) if (t.from === '*' && t.to !== from.state.id && this.holds(t, from)) return t;
    for (const t of this.controller.transitions) if (t.from === from.state.id && this.holds(t, from)) return t;
    return null;
  }

  /** Blend weights of a state's clips (one clip: weight 1). */
  private weights(state: State): { clip: AnimatorClipLike; weight: number }[] {
    const m = state.motion;
    if (m.kind === 'clip') return [{ clip: m.clip, weight: 1 }];
    const x = this.num(m.parameter);
    const kids = m.children;
    if (x <= kids[0]!.threshold) return [{ clip: kids[0]!.clip, weight: 1 }];
    const last = kids[kids.length - 1]!;
    if (x >= last.threshold) return [{ clip: last.clip, weight: 1 }];
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i]!;
      const b = kids[i + 1]!;
      if (x >= a.threshold && x <= b.threshold) {
        const f = (x - a.threshold) / (b.threshold - a.threshold);
        return [
          { clip: a.clip, weight: 1 - f },
          { clip: b.clip, weight: f },
        ].filter((w) => w.weight > 0);
      }
    }
    return [{ clip: last.clip, weight: 1 }];
  }

  private length(state: State): number {
    const ws = this.weights(state);
    let len = 0;
    for (const w of ws) len += w.clip.duration * w.weight;
    return Math.max(1e-4, len);
  }

  private rate(state: State): number {
    return state.speed * (state.speedParameter !== undefined ? this.num(state.speedParameter) : 1);
  }

  private clipTime(p: Playing, clip: AnimatorClipLike): number {
    const nt = p.state.loop ? p.nt - Math.floor(p.nt) : Math.min(1, Math.max(0, p.nt));
    return nt * clip.duration;
  }

  /** Advance one step of `dt` seconds; returns the clip events passed in it. */
  step(dt: number): AnimatorEventFired[] {
    const t = this.pickTransition();
    if (t !== null) this.fire(t);
    const events: AnimatorEventFired[] = [];
    const advance = (p: Playing): void => {
      const before = p.nt;
      p.nt += (dt * this.rate(p.state)) / this.length(p.state);
      if (!p.state.loop) p.nt = Math.min(p.nt, Math.max(1, before));
      if (this.controller.events.length > 0) this.collectEvents(p, before, events);
    };
    advance(this.current);
    if (this.next !== null) {
      advance(this.next.to);
      this.next.elapsed += dt;
      if (this.next.elapsed >= this.next.duration) {
        this.current = this.next.to;
        this.next = null;
      }
    }
    return events;
  }

  private collectEvents(p: Playing, before: number, out: AnimatorEventFired[]): void {
    if (p.nt <= before) return;
    for (const w of this.weights(p.state)) {
      for (const e of this.controller.events) {
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

  pose(): AnimatorPose {
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
