/**
 * The `ctx` members scripts reach the gameplay parts through: signals,
 * messages, health, patrols, hitboxes, collectibles, the climb volume and
 * look overrides (over the gameplay blocks), `ctx.save`, sockets, timelines
 * and the game modes.
 *
 * Each control checks its arguments (a bad one reads as "no" or nothing, never
 * a throw) and forwards to the part that owns the state; none keeps state of
 * its own beyond `ctx.save`'s store.
 */
import { MAX_SIGNAL_NAME, type GameplayBlocks } from './blocks';
import type { ModeEventRecord, ModeState } from './modes';
import type { EntityLook } from './primitives';
import { SAVE_MAX_KEYS, SAVE_MAX_VALUE_CHARS } from './save-sections';
import type { SocketSystem } from './sockets';
import type { TimelineSystem } from './timeline';
import type { BehaviorMessage, BehaviorModes, BehaviorModeTransition, BehaviorSockets, BehaviorTimeline, ClimbQuery, SimulationPhase } from './types';

/** A script message name (the timer-name syntax). */
const MESSAGE_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A `ctx.save` key. */
const SAVE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The controls over the gameplay blocks (`blocks()`: null in a game without them). */
export function blockControls(blocks: () => GameplayBlocks | null, stepIndex: () => number) {
  const signals = Object.freeze({
    emit: (name: string): void => {
      if (typeof name === 'string' && name.length > 0 && name.length <= MAX_SIGNAL_NAME) blocks()?.emit(name);
    },
    on: (name: string): boolean => blocks()?.signaled(String(name)) ?? false,
  });
  /** Script messages (`ctx.messages`; the behavior host passes sender and receiver). */
  const messages = Object.freeze({
    send: (from: string, name: unknown, value: unknown, target: unknown): boolean => {
      if (typeof name !== 'string' || !MESSAGE_NAME_RE.test(name)) return false;
      let v: number | string | boolean | null;
      if (value === undefined || value === null) v = null;
      else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return false;
        v = value;
      } else if (typeof value === 'string') {
        if (value.length > 256) return false;
        v = value;
      } else if (typeof value === 'boolean') v = value;
      else return false;
      let to: string | null = null;
      if (target !== undefined && target !== null && target !== '') {
        if (typeof target !== 'string' || target.length > 128) return false;
        to = target;
      }
      return blocks()?.sendMessage({ name, value: v, from, stepIndex: stepIndex() }, to) ?? false;
    },
    received: (to: string, name: unknown): readonly BehaviorMessage[] => (typeof name === 'string' ? (blocks()?.messagesFor(to, name) ?? []) : []),
    all: (to: string): readonly BehaviorMessage[] => blocks()?.messagesTo(to) ?? [],
  });
  /** Any object's health (`ctx.health`; changes apply at once, events are seen next step). */
  const health = Object.freeze({
    get: (entityId: string): { current: number; max: number } | null => (typeof entityId === 'string' ? (blocks()?.primitives.healthOf(entityId) ?? null) : null),
    damage: (entityId: string, amount: number, source?: string): boolean =>
      typeof entityId === 'string' && typeof amount === 'number' && (source === undefined || (typeof source === 'string' && source.length <= 128)) ? (blocks()?.primitives.damage(entityId, amount, source ?? '') ?? false) : false,
    heal: (entityId: string, amount: number): boolean => (typeof entityId === 'string' && typeof amount === 'number' ? (blocks()?.primitives.heal(entityId, amount) ?? false) : false),
    events: () => blocks()?.primitives.healthEvents() ?? [],
  });
  /** Patrollers (`ctx.patrol`). */
  const patrol = Object.freeze({
    get: (entityId: string) => (typeof entityId === 'string' ? (blocks()?.primitives.patrolOf(entityId) ?? null) : null),
    setActive: (entityId: string, active: boolean): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.setPatrolActive(entityId, active === true) ?? false) : false),
    turn: (entityId: string): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.turnPatrol(entityId) ?? false) : false),
  });
  /** Hitboxes (`ctx.hitbox`). */
  const hitbox = Object.freeze({
    setActive: (entityId: string, active: boolean): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.setHitboxActive(entityId, active === true) ?? false) : false),
    touching: (entityId: string): readonly string[] => (typeof entityId === 'string' ? (blocks()?.primitives.touching(entityId) ?? []) : []),
  });
  /** Collectibles (`ctx.collectible`). */
  const collectible = Object.freeze({
    collected: (entityId: string): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.isCollected(entityId) ?? false) : false),
    restore: (entityId: string): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.restore(entityId) ?? false) : false),
  });
  /** The climb volume a player controller's capsule centre is in (read by the character controllers in the controller phase). */
  const climb: ClimbQuery = Object.freeze({ volume: (entityId?: string) => blocks()?.climbVolume(entityId) ?? null });
  /** Per-object look overrides (`ctx.look`; the renderer applies them). */
  const look = Object.freeze({
    set: (entityId: string, value: unknown): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.setLook(entityId, value) ?? false) : false),
    clear: (entityId: string): boolean => (typeof entityId === 'string' ? (blocks()?.primitives.clearLook(entityId) ?? false) : false),
    get: (entityId: string): EntityLook | null => (typeof entityId === 'string' ? (blocks()?.primitives.lookOf(entityId) ?? null) : null),
  });
  return { signals, messages, health, patrol, hitbox, collectible, climb, look };
}

/** `ctx.save` over the scripts' saved values (JSON values, kept across restarts). */
export function saveStoreControl(store: Map<string, unknown>) {
  return Object.freeze({
    get: (key: string): unknown => (store.has(String(key)) ? structuredClone(store.get(String(key))) : undefined),
    set: (key: string, value: unknown): boolean => {
      if (typeof key !== 'string' || !SAVE_KEY_RE.test(key)) return false;
      if (!store.has(key) && store.size >= SAVE_MAX_KEYS) return false;
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        return false;
      }
      if (text === undefined || text.length > SAVE_MAX_VALUE_CHARS) return false;
      store.set(key, JSON.parse(text) as unknown);
      return true;
    },
    remove: (key: string): void => {
      store.delete(String(key));
    },
    keys: (): string[] => [...store.keys()].sort(),
  });
}

/** `ctx.sockets`. */
export function socketControlOf(sockets: SocketSystem): BehaviorSockets {
  const vec = (v: unknown): readonly number[] | undefined => (Array.isArray(v) ? (v as number[]) : undefined);
  return Object.freeze({
    attach: (entityId: string, targetId?: string, node?: string, position?: readonly number[], rotation?: readonly number[], scale?: readonly number[]): boolean =>
      sockets.attach(String(entityId), targetId === undefined || targetId === null ? undefined : String(targetId), node === undefined || node === null ? undefined : String(node), vec(position), vec(rotation), vec(scale)),
    detach: (entityId: string, keepWorld?: boolean): boolean => sockets.detach(String(entityId), keepWorld !== false),
    attachedTo: (entityId: string) => {
      const a = sockets.attachedTo(String(entityId));
      return a === null ? null : Object.freeze({ target: a.target, nodeName: a.node });
    },
    nodePose: (targetId: string, node: string) => {
      const p: number[] = [0, 0, 0];
      const r: number[] = [0, 0, 0, 1];
      if (!sockets.nodeWorld(String(targetId), String(node), p, r)) return null;
      return Object.freeze({ position: Object.freeze([p[0]!, p[1]!, p[2]!] as const), rotation: Object.freeze([r[0]!, r[1]!, r[2]!, r[3]!] as const) });
    },
  });
}

/** `ctx.timeline` (arguments checked by the system; requests apply at the end of the step). */
export function timelineControlOf(t: TimelineSystem): BehaviorTimeline {
  return Object.freeze({
    play: (timelineId: string, bindings?: Readonly<Record<string, string>>): number => t.play(timelineId, bindings),
    pause: (handle: number): boolean => t.pause(handle),
    resume: (handle: number): boolean => t.resume(handle),
    stop: (handle: number): boolean => t.stop(handle),
    skip: (handle: number): boolean => t.skip(handle),
    seek: (handle: number, seconds: number): boolean => t.seek(handle, seconds),
    state: (handle: number) => t.state(handle),
    time: (handle: number): number => t.time(handle),
    isPlaying: (timelineId: string): boolean => t.isPlaying(timelineId),
    events: () => t.events(),
    ended: (handle: number): boolean => t.events().some((e) => e.kind === 'ended' && e.handle === handle),
    marker: (name: string, handle?: number): boolean => t.events().some((e) => e.kind === 'marker' && e.name === name && (handle === undefined || handle === 0 || e.handle === handle)),
  });
}

/** `ctx.modes` for one phase (the enter/exit events are read in the intent phase only, once per step). */
export function modeControlOf(modes: ModeState, phase: SimulationPhase, stepIndex: () => number): BehaviorModes {
  const none: readonly ModeEventRecord[] = Object.freeze([]);
  const events = (): readonly ModeEventRecord[] => (phase === 'intent' ? modes.events(stepIndex() + 1) : none);
  return Object.freeze({
    current: (): string => modes.current ?? '',
    previous: (): string => modes.previous ?? '',
    is: (modeId: string): boolean => modes.current !== null && modes.current === modeId,
    switch: (modeId: string, transition?: BehaviorModeTransition): boolean => modes.request(modeId, transition),
    events,
    entered: (modeId?: string): boolean => events().some((e) => e.kind === 'enter' && (modeId === undefined || modeId === '' || e.mode === modeId)),
    exited: (modeId?: string): boolean => events().some((e) => e.kind === 'exit' && (modeId === undefined || modeId === '' || e.mode === modeId)),
    time: (): number => modes.secondsIn(stepIndex() + 1),
  });
}
