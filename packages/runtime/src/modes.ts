/**
 * Phase 23.10: game modes in the simulation.
 *
 * The project's modes (`content.modes`, the snapshot's `modes`) are
 * simulation state: which mode is current, since which step, the switch a
 * script asked for, the transition overlay's remaining time. A switch
 * happens in one step and changes, together: the virtual camera that is live
 * (the camera brain's mode override, with the transition's blend), the UI
 * documents shown (the old mode's are hidden, the new one's shown, an
 * optional fade document for its fade time), the input maps whose actions
 * modules and scripts read (the others read as released), the behavior
 * groups that tick, the time scale and whether physics steps. Nothing is
 * loaded or unloaded.
 *
 * When: a script's `ctx.modes.switch` (any phase of step N) applies at the
 * boundary of step N+1; a UI button's mode action rides on the input frame
 * and applies when that frame is sampled, before the step's scripts. Either
 * way the enter/exit events are the scripts' in the step the switch applied
 * (`ctx.modes.events()`, intent phase) — poll-shaped like `ctx.ui.events`,
 * so no callback ever runs outside a step. A new run (start, replay,
 * restart) begins in the start mode again: the first mode, or the one a
 * Play start option named.
 *
 * Pure state + the effects it is given; no three.js, no DOM.
 */
import type { GameMode, RuntimeModes } from '@thirdlight/project-model';
import type { ActionFrame, ActionValue } from './actions';

/** One enter/exit event of a switch (`ctx.modes.events()`). */
export interface ModeEventRecord {
  readonly kind: 'enter' | 'exit';
  /** The mode entered or left. */
  readonly mode: string;
  /** The mode on the other side of the switch ('' when there was none: a run start). */
  readonly other: string;
}

/** A switch's look (a mode's `enter`, or what a script passes). */
export interface ModeTransitionSpec {
  readonly blend?: 'cut' | 'linear' | 'eased';
  readonly blendTime?: number;
  readonly fade?: string;
  readonly fadeTime?: number;
}

/** What the host and observers see of the modes. */
export interface ModeView {
  /** The current mode ('' only while the project has no modes). */
  readonly current: string;
  readonly name: string;
  readonly previous: string;
  /** The step the current mode was entered in (its `ctx.stepIndex`). */
  readonly since: number;
  /** A switch waiting for the next step boundary (a script asked for it), or ''. */
  readonly pending: string;
  /** The engine pause may be used. */
  readonly pause: boolean;
  /** The UI document drawn while paused (absent: the engine's pause panel). */
  readonly pauseScreen?: string;
  /** The active input maps (null: every map). */
  readonly inputMaps: readonly string[] | null;
  readonly timeScale: number;
  readonly physics: 'run' | 'hold';
  /** Every mode id, in order (the first is the start mode). */
  readonly modes: readonly string[];
}

/** What a switch does outside the mode state (the runtime wires these). */
export interface ModeEffects {
  showUi(doc: string): void;
  hideUi(doc: string): void;
  isShown(doc: string): boolean;
  /** The live camera override (null: the priority rule) and the blend into it. */
  setCamera(cameraId: string | null, blend: { blend?: string; time?: number } | undefined): void;
  warn(message: string): void;
}

const NO_EVENTS: readonly ModeEventRecord[] = Object.freeze([]);
const NEUTRAL_BUTTON: ActionValue = Object.freeze({ v: 0, p: 'none' });
const NEUTRAL_AXIS2: ActionValue = Object.freeze({ v: 0, x: 0, y: 0, p: 'none' });

export class ModeState {
  private readonly byId = new Map<string, GameMode>();
  private readonly order: readonly string[];
  private readonly actionMaps: Readonly<Record<string, string>>;
  private readonly hz: number;
  private startId: string | null = null;
  private currentId: string | null = null;
  private previousId: string | null = null;
  private sinceStep = 0;
  private pendingSwitch: { id: string; transition: ModeTransitionSpec | undefined } | null = null;
  private stepEvents: readonly ModeEventRecord[] = NO_EVENTS;
  /** The step ordinal `stepEvents` belong to. */
  private eventsStep = -1;
  /** The fade document shown by the last switch and the step ordinal it leaves at. */
  private overlay: { doc: string; until: number } | null = null;
  private viewCache: ModeView | null = null;
  /** Per mode: the action names to neutralize (null: none) and whether gameplay is off. */
  private readonly masks = new Map<string, { names: ReadonlySet<string>; gameplayOff: boolean } | null>();

  constructor(
    rows: RuntimeModes | undefined,
    hz: number,
    private readonly effects: ModeEffects,
  ) {
    this.hz = hz;
    for (const m of rows?.modes ?? []) this.byId.set(m.modeId, m);
    this.order = Object.freeze((rows?.modes ?? []).map((m) => m.modeId));
    this.actionMaps = rows?.actionMaps ?? {};
    for (const m of rows?.modes ?? []) {
      if (m.inputMaps === undefined) {
        this.masks.set(m.modeId, null);
        continue;
      }
      const active = new Set(m.inputMaps);
      const names = new Set<string>();
      for (const [name, map] of Object.entries(this.actionMaps)) if (!active.has(map)) names.add(name);
      this.masks.set(m.modeId, { names, gameplayOff: !active.has('gameplay') });
    }
  }

  /** The project has modes (without them nothing here runs, and nothing enters the digest). */
  get active(): boolean {
    return this.order.length > 0;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * The mode runs start in (a Play start option; absent: the first mode).
   * Returns false for a mode the project does not have (the first mode is kept).
   */
  setStartMode(id: string | undefined): boolean {
    if (id === undefined) {
      this.startId = this.order[0] ?? null;
      return true;
    }
    if (!this.byId.has(id)) {
      this.startId = this.order[0] ?? null;
      return false;
    }
    this.startId = id;
    return true;
  }

  get startMode(): string | null {
    return this.startId;
  }

  /**
   * A new run begins in the start mode (at construction and after a reset):
   * its documents shown, its camera live, the enter event in step `ordinal`.
   * The UI stack was emptied by the run reset; nothing of the old mode stays.
   */
  beginRun(ordinal: number): void {
    if (!this.active) return;
    if (this.startId === null) this.startId = this.order[0]!;
    this.pendingSwitch = null;
    this.overlay = null;
    this.currentId = null;
    this.previousId = null;
    this.stepEvents = NO_EVENTS;
    this.eventsStep = -1;
    this.enter(this.startId, undefined, ordinal, true);
  }

  /** The start of a step: last step's events end; a pending switch or an ending fade applies now. */
  beginStep(ordinal: number): void {
    if (!this.active) return;
    if (this.eventsStep !== ordinal && this.stepEvents.length > 0) {
      this.stepEvents = NO_EVENTS;
      this.eventsStep = -1;
    }
    if (this.overlay !== null && ordinal >= this.overlay.until) {
      const doc = this.overlay.doc;
      this.overlay = null;
      if (!this.modeShows(this.currentId, doc)) this.effects.hideUi(doc);
      this.touched();
    }
    if (this.pendingSwitch !== null) {
      const p = this.pendingSwitch;
      this.pendingSwitch = null;
      this.enter(p.id, p.transition, ordinal, false);
    }
  }

  /** A script asks for a switch (applied at the next step boundary; the last request of a step wins). */
  request(id: unknown, transition?: unknown): boolean {
    if (!this.active || typeof id !== 'string' || !this.byId.has(id)) return false;
    const t = transitionOf(transition);
    if (t === null) return false;
    this.pendingSwitch = { id, transition: t };
    this.touched();
    return true;
  }

  /** A sampled frame's mode events (a UI button's mode action): switch now, before the step's scripts. */
  deliver(events: readonly { readonly kind: string; readonly value?: unknown }[] | undefined, ordinal: number): void {
    if (!this.active || events === undefined) return;
    for (const e of events) {
      if (e.kind !== 'mode') continue;
      const id = e.value;
      if (typeof id !== 'string' || !this.byId.has(id)) {
        this.effects.warn(`a UI mode action named "${String(id).slice(0, 64)}", which is not a game mode`);
        continue;
      }
      this.enter(id, undefined, ordinal, false);
    }
  }

  /** The switch itself (one step: camera, documents, maps, groups, time scale, physics). */
  private enter(id: string, transition: ModeTransitionSpec | undefined, ordinal: number, runStart: boolean): void {
    const next = this.byId.get(id);
    if (next === undefined) return;
    const from = this.currentId;
    if (from === id && !runStart) return; // already there: nothing changes
    const prev = from === null ? undefined : this.byId.get(from);
    const t = transition ?? next.enter;
    // Documents: the old mode's that the new one does not show leave; the new one's come.
    const nextDocs = new Set(next.ui ?? []);
    for (const doc of prev?.ui ?? []) if (!nextDocs.has(doc)) this.effects.hideUi(doc);
    for (const doc of next.ui ?? []) if (!this.effects.isShown(doc)) this.effects.showUi(doc);
    // The camera: the new mode's (or back to the priority rule), with the transition's blend.
    const blend = t !== undefined && (t.blend !== undefined || t.blendTime !== undefined) ? { ...(t.blend !== undefined ? { blend: t.blend } : {}), ...(t.blendTime !== undefined ? { time: t.blendTime } : {}) } : undefined;
    if (!runStart || next.camera !== undefined) this.effects.setCamera(next.camera ?? null, runStart ? { blend: 'cut' } : blend);
    // The fade document (its show/hide tweens are the fade), for its time from now.
    if (this.overlay !== null && !nextDocs.has(this.overlay.doc)) this.effects.hideUi(this.overlay.doc);
    this.overlay = null;
    if (!runStart && t?.fade !== undefined) {
      const steps = Math.max(1, Math.round((t.fadeTime ?? 0.5) * this.hz));
      this.effects.showUi(t.fade);
      this.overlay = { doc: t.fade, until: ordinal + steps };
    }
    this.previousId = from;
    this.currentId = id;
    // The step index scripts saw in that step (ctx.stepIndex: completed steps before it).
    this.sinceStep = ordinal - 1;
    const events: ModeEventRecord[] = this.eventsStep === ordinal ? [...this.stepEvents] : [];
    if (from !== null) events.push(Object.freeze({ kind: 'exit' as const, mode: from, other: id }));
    events.push(Object.freeze({ kind: 'enter' as const, mode: id, other: from ?? '' }));
    this.stepEvents = Object.freeze(events);
    this.eventsStep = ordinal;
    this.touched();
  }

  private modeShows(id: string | null, doc: string): boolean {
    return id !== null && (this.byId.get(id)?.ui ?? []).includes(doc);
  }

  private touched(): void {
    this.viewCache = null;
  }

  // ---- what the rest of the step reads ------------------------------------------

  get current(): string | null {
    return this.currentId;
  }

  get previous(): string | null {
    return this.previousId;
  }

  /** The events of step `ordinal` (the step a switch applied in). */
  events(ordinal: number): readonly ModeEventRecord[] {
    return this.eventsStep === ordinal ? this.stepEvents : NO_EVENTS;
  }

  /** Seconds in the current mode at step `ordinal` (0 in the step it was entered). */
  secondsIn(ordinal: number): number {
    return this.currentId === null ? 0 : Math.max(0, ordinal - 1 - this.sinceStep) / this.hz;
  }

  /** A behavior of this group (undefined: ungrouped) runs in the current mode. */
  ticks(group: string | undefined): boolean {
    const m = this.currentId === null ? undefined : this.byId.get(this.currentId);
    if (m === undefined) return true;
    if (group === undefined) return m.ungrouped !== 'pause';
    return m.groups === undefined || m.groups.includes(group);
  }

  /** Every group and ungrouped behavior ticks in the current mode (the fast path). */
  get ticksAll(): boolean {
    const m = this.currentId === null ? undefined : this.byId.get(this.currentId);
    return m === undefined || (m.groups === undefined && m.ungrouped !== 'pause');
  }

  /** The frame modules and scripts read: actions of inactive maps read as released (the recorded frame is untouched). */
  mask(frame: ActionFrame): ActionFrame {
    const mask = this.currentId === null ? null : (this.masks.get(this.currentId) ?? null);
    if (mask === null) return frame;
    let actions = frame.actions;
    if (actions !== undefined && mask.names.size > 0) {
      let copy: Record<string, ActionValue> | null = null;
      for (const name in actions) {
        if (!mask.names.has(name)) continue;
        const a = actions[name]!;
        if (a.v === 0 && a.p === 'none' && (a.x === undefined || a.x === 0) && (a.y === undefined || a.y === 0)) continue;
        if (copy === null) copy = { ...actions };
        copy[name] = a.x !== undefined || a.y !== undefined ? NEUTRAL_AXIS2 : NEUTRAL_BUTTON;
      }
      if (copy !== null) actions = Object.freeze(copy);
    }
    const moveOff = mask.gameplayOff && (frame.moveX !== 0 || (frame.moveY ?? 0) !== 0 || frame.jump !== 'none');
    if (actions === frame.actions && !moveOff) return frame;
    const out: ActionFrame = { ...frame, ...(actions !== undefined ? { actions } : {}) };
    if (moveOff) {
      out.moveX = 0;
      if (out.moveY !== undefined) out.moveY = 0;
      out.jump = 'none';
    }
    return out;
  }

  /** The simulation speed of the current mode. */
  timeScale(): number {
    const m = this.currentId === null ? undefined : this.byId.get(this.currentId);
    return m?.timeScale ?? 1;
  }

  /** Physics, the controller, movers and triggers stand still in the current mode. */
  get physicsHeld(): boolean {
    const m = this.currentId === null ? undefined : this.byId.get(this.currentId);
    return m?.physics === 'hold';
  }

  get pauseAllowed(): boolean {
    const m = this.currentId === null ? undefined : this.byId.get(this.currentId);
    return m === undefined || m.pause !== false;
  }

  /** The mode state as digest text (only called while the project has modes). */
  digestText(): string {
    return `${this.currentId ?? ''}|${this.previousId ?? ''}|${this.sinceStep}|${this.pendingSwitch?.id ?? ''}|${this.overlay === null ? '' : `${this.overlay.doc}@${this.overlay.until}`}`;
  }

  view(): ModeView {
    if (this.viewCache !== null) return this.viewCache;
    const m = this.currentId === null ? undefined : this.byId.get(this.currentId);
    const v: ModeView = Object.freeze({
      current: this.currentId ?? '',
      name: m?.name ?? '',
      previous: this.previousId ?? '',
      since: this.sinceStep,
      pending: this.pendingSwitch?.id ?? '',
      pause: m === undefined || m.pause !== false,
      ...(m?.pauseScreen !== undefined ? { pauseScreen: m.pauseScreen } : {}),
      inputMaps: m?.inputMaps === undefined ? null : Object.freeze([...m.inputMaps]),
      timeScale: m?.timeScale ?? 1,
      physics: m?.physics ?? 'run',
      modes: this.order,
    });
    this.viewCache = v;
    return v;
  }
}

/** A script's transition argument (undefined: the mode's own; null: not a transition). */
function transitionOf(v: unknown): ModeTransitionSpec | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: { blend?: 'cut' | 'linear' | 'eased'; blendTime?: number; fade?: string; fadeTime?: number } = {};
  if (o['blend'] !== undefined) {
    if (o['blend'] !== 'cut' && o['blend'] !== 'linear' && o['blend'] !== 'eased') return null;
    out.blend = o['blend'];
  }
  if (o['blendTime'] !== undefined) {
    const n = o['blendTime'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 30) return null;
    out.blendTime = n;
  }
  if (o['fade'] !== undefined && o['fade'] !== '') {
    if (typeof o['fade'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(o['fade'])) return null;
    out.fade = o['fade'];
  }
  if (o['fadeTime'] !== undefined) {
    const n = o['fadeTime'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0.05 || n > 10) return null;
    out.fadeTime = n;
  }
  return Object.freeze(out);
}
