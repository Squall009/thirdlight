/**
 * Phase 23.17 (E7): the sequencer — timelines played in the simulation step.
 *
 * A timeline (project-model `TimelineAsset`) is played by a script
 * (`ctx.timeline.play(id, bindings)`), by a signal (`playOnSignal`) or when a
 * run starts (`playOnStart`). Each play binds the timeline's slots to
 * entities (the slots' defaults, overridden by the call), so one timeline
 * serves any actors.
 *
 * Determinism: time counts in fixed steps (a key at `t` seconds is at step
 * `round(t · hz)`), the system runs once at the end of every step (after the
 * script phases, before the camera brain), a wait-for-input key advances on
 * the step's input frame and everything it does goes through the same
 * simulation channels scripts use (the camera brain, transforms, animators,
 * the audio intent log, effect requests, signals, material parameters), so
 * page, worker and replays agree. No script ever waits: scripts read the
 * timeline's events (`started`, `ended`, `marker`) one step later, exactly
 * like signals.
 *
 * Per step, for each playing timeline (play order):
 *   1. requests from scripts: stop, skip, seek (then no advance this step),
 *      pause/resume;
 *   2. a new play fires the keys at step 0; a playing one advances one step
 *      and fires the discrete keys it crossed (camera cuts, animator
 *      set/trigger/play, audio, dialogue, effects, activation, signals,
 *      environment presets); a wait key stops it until its action is pressed
 *      (or its timeout); a dialogue key with `wait` stops it until the
 *      dialogue ends;
 *   3. the continuous tracks are applied at the current time (transforms,
 *      material parameters, fade, letterbox, rail progress);
 *   4. at the end: the end state stays, cameras are released (or kept),
 *      fade/letterbox cleared (or held), the music released when asked.
 *
 * Skip applies each track's end state at once (see `skipInstance`); stop
 * ends without end states. Pure logic over a host interface: no three.js.
 */
import type { TimelineAsset, TimelineEasing, TimelineKey, TimelineTrack } from '@thirdlight/project-model';

import type { ActionFrame } from './actions';
import { slerp } from './camera-rig';

// ---------------------------------------------------------------------------
// Pure evaluation (shared with the editor's scrub preview)
// ---------------------------------------------------------------------------

/** The eased fraction for a segment arriving at a key with `easing`. */
export function timelineEase(easing: TimelineEasing | undefined, t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  switch (easing) {
    case 'step':
      return x >= 1 ? 1 : 0;
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return x * (2 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
    default:
      return x;
  }
}

type Numeric = number | readonly number[];

function lerpNumeric(a: Numeric, b: Numeric, w: number): number | number[] {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * w;
  const aa = a as readonly number[];
  const bb = b as readonly number[];
  return aa.map((v, i) => v + ((bb[i] ?? v) - v) * w);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(c: readonly number[]): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A curve's value at `time` over the keys that carry the channel (`pick`
 * returns undefined for a key without it): undefined before the first such
 * key; the last value after the last one; between two keys the later key's
 * easing. Keys are in time order (the canonical form).
 */
export function curveAt<V>(keys: readonly TimelineKey[], time: number, pick: (k: TimelineKey) => V | undefined, lerp: (a: V, b: V, w: number) => V): V | undefined {
  let prev: TimelineKey | null = null;
  let prevV: V | undefined;
  for (const k of keys) {
    const v = pick(k);
    if (v === undefined) continue;
    if (k.time > time) {
      if (prev === null || prevV === undefined) return undefined;
      const span = k.time - prev.time;
      const w = span > 0 ? timelineEase(k.easing, (time - prev.time) / span) : 1;
      return lerp(prevV, v, w);
    }
    prev = k;
    prevV = v;
  }
  return prevV;
}

export interface TimelineTransformPose {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

/** A transform track at `time` (each channel from its first key on). */
export function transformTrackAt(track: TimelineTrack, time: number): TimelineTransformPose {
  const out: TimelineTransformPose = {};
  const lerp3 = (a: [number, number, number], b: [number, number, number], w: number): [number, number, number] => lerpNumeric(a, b, w) as [number, number, number];
  const p = curveAt(track.keys, time, (k) => k.position, lerp3);
  if (p !== undefined) out.position = [p[0], p[1], p[2]];
  const r = curveAt(track.keys, time, (k) => k.rotation, (a, b, w) => slerp(a, b, w, [0, 0, 0, 1]) as [number, number, number, number]);
  if (r !== undefined) out.rotation = [r[0], r[1], r[2], r[3]];
  const s = curveAt(track.keys, time, (k) => k.scale, lerp3);
  if (s !== undefined) out.scale = [s[0], s[1], s[2]];
  return out;
}

/** A fade / letterbox / material value at `time` (undefined before the first key). */
export function valueTrackAt(track: TimelineTrack, time: number): number | number[] | string | undefined {
  return curveAt<number | number[] | string>(
    track.keys,
    time,
    (k) => (typeof k.value === 'boolean' ? undefined : (k.value as number | number[] | string | undefined)),
    (a, b, w) => {
      if (typeof a === 'string' && typeof b === 'string') return rgbToHex(lerpNumeric(hexToRgb(a), hexToRgb(b), w) as number[]);
      if (typeof a === 'string' || typeof b === 'string') return w >= 1 ? b : a;
      return lerpNumeric(a, b, w);
    },
  );
}

/** A fade track's colour at `time` (the colour of the key in effect; absent: black). */
export function fadeColorAt(track: TimelineTrack, time: number): string {
  let color = '#000000';
  for (const k of track.keys) {
    if (k.time > time) break;
    if (k.color !== undefined) color = k.color;
  }
  return color;
}

/** The camera key in effect at `time` (its index; -1 before the first). */
export function cameraKeyAt(track: TimelineTrack, time: number): number {
  let at = -1;
  for (let i = 0; i < track.keys.length; i += 1) {
    if (track.keys[i]!.time > time) break;
    at = i;
  }
  return at;
}

/** A camera key's rail progress at `time` (null: it sets none). */
export function cameraProgressAt(track: TimelineTrack, index: number, time: number, duration: number): number | null {
  const k = track.keys[index];
  if (k === undefined || k.progress === undefined) return null;
  const end = track.keys[index + 1]?.time ?? duration;
  const span = end - k.time;
  const w = span > 0 ? timelineEase(k.easing ?? 'linear', (time - k.time) / span) : 1;
  return k.progress[0] + (k.progress[1] - k.progress[0]) * w;
}

/** The slot → entity bindings of a play: the slots' defaults, then the call's. */
export function timelineBindings(tl: TimelineAsset, overrides?: Readonly<Record<string, unknown>> | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of tl.slots ?? []) if (s.entity !== undefined) out.set(s.name, s.entity);
  if (overrides !== undefined && overrides !== null && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) if ((tl.slots ?? []).some((s) => s.name === k) && typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)) out.set(k, v);
  }
  return out;
}

/** What the editor's scrub preview shows at `time` (the continuous tracks, bound by the slots' defaults). */
export interface TimelinePreview {
  readonly transforms: ReadonlyMap<string, TimelineTransformPose>;
  /** The live camera (entity) and its rail progress, or null. */
  readonly camera: { readonly entityId: string; readonly progress: number | null } | null;
  readonly fade: { readonly color: string; readonly value: number } | null;
  readonly letterbox: number | null;
  /** Discrete keys at or before `time` per track (the editor marks them). */
  readonly markers: readonly string[];
}

export function evaluateTimelineAt(tl: TimelineAsset, time: number, bindings: ReadonlyMap<string, string> = timelineBindings(tl)): TimelinePreview {
  const transforms = new Map<string, TimelineTransformPose>();
  let camera: { entityId: string; progress: number | null } | null = null;
  let fade: { color: string; value: number } | null = null;
  let letterbox: number | null = null;
  const markers: string[] = [];
  for (const m of tl.markers ?? []) if (m.time <= time) markers.push(m.name);
  for (const t of tl.tracks) {
    if (t.muted === true) continue;
    if (t.type === 'transform' && t.target !== undefined) {
      const id = bindings.get(t.target);
      if (id === undefined) continue;
      const pose = transformTrackAt(t, time);
      if (pose.position !== undefined || pose.rotation !== undefined || pose.scale !== undefined) transforms.set(id, { ...transforms.get(id), ...pose });
    } else if (t.type === 'camera') {
      const i = cameraKeyAt(t, time);
      const k = t.keys[i];
      if (k !== undefined && k.release !== true && k.camera !== undefined) {
        const id = bindings.get(k.camera);
        if (id !== undefined) camera = { entityId: id, progress: cameraProgressAt(t, i, time, tl.duration) };
      } else if (k !== undefined) camera = null;
    } else if (t.type === 'fade') {
      const v = valueTrackAt(t, time);
      if (typeof v === 'number') fade = { color: fadeColorAt(t, time), value: v };
    } else if (t.type === 'letterbox') {
      const v = valueTrackAt(t, time);
      if (typeof v === 'number') letterbox = v;
    }
  }
  return { transforms, camera, fade, letterbox, markers };
}

// ---------------------------------------------------------------------------
// The runtime system
// ---------------------------------------------------------------------------

/** What the system drives (the runtime's channels; the dialogue / environment ports are optional). */
export interface TimelineHost {
  /** An entity's local transform, written in place (false: not loaded). */
  writeTransform(id: string, pose: TimelineTransformPose): boolean;
  /** The camera brain: the forced live camera (null: none) with a blend; rail progress; keep one enabled. */
  cameraOverride(id: string | null, blend: { blend: 'cut' | 'linear' | 'eased'; time: number } | null): void;
  cameraProgress(id: string, progress: number): void;
  cameraActivate(id: string): void;
  animator(id: string): { set(name: string, value: number | boolean): boolean; trigger(name: string): boolean; play(state: string, fade: number, layer: number): boolean } | null;
  audio: {
    music(assetId: string | null, fade: number): void;
    releaseMusic(fade: number): void;
    stinger(assetId: string, volume: number | undefined): number;
    play(assetId: string, options: { volume?: number; loop?: boolean; entityId?: string }): number;
    stop(handle: number, fade: number): void;
    playing(handle: number): boolean;
  };
  effects: { play(effectId: string, options: { position?: readonly number[]; entityId?: string; params?: Readonly<Record<string, number | readonly number[] | string>> }): number; stop(handle: number): void };
  setVisible(id: string, visible: boolean): void;
  emitSignal(name: string): void;
  signaled(name: string): boolean;
  setMaterial(id: string, param: string, value: number | readonly number[] | string, materialId?: string): boolean;
  /** Phase 23.16's dialogue runner (absent until it exists): run a dialogue node, poll it, stop it. */
  dialogue?: TimelineDialoguePort;
  /** Phase 23.10: switch the game mode (the path of `ctx.modes.switch`; false: no such mode). */
  switchMode?(modeId: string, transition: { blend?: 'cut' | 'linear' | 'eased'; blendTime?: number }): boolean;
  /** Phase 23.18's environment presets (absent until they exist). */
  environment?: TimelineEnvironmentPort;
  warn(message: string): void;
}

/** The small interface the dialogue track needs (phase 23.16 wires the runtime's dialogue system to it). */
export interface TimelineDialoguePort {
  start(dialogueId: string, node: string | undefined, bindings: ReadonlyMap<string, string>): number;
  running(handle: number): boolean;
  stop(handle: number): void;
}

/** The small interface the environment track needs (phase 23.18 wires the presets to it). */
export interface TimelineEnvironmentPort {
  apply(presetId: string, blendSeconds: number): boolean;
}

export type TimelinePlayState = 'playing' | 'paused' | 'waiting' | 'ended';

/** One timeline event, seen by scripts in the step after it happened. */
export interface TimelineEvent {
  readonly kind: 'started' | 'ended' | 'marker';
  readonly handle: number;
  readonly timeline: string;
  /** marker: its name. */
  readonly name: string;
  /** ended: finished, skipped or stopped. */
  readonly reason: '' | 'finished' | 'skipped' | 'stopped';
  readonly stepIndex: number;
}

/** What the host draws and observers read (one object while nothing changed). */
export interface TimelineView {
  /** The full-screen fade (colour, opacity 0–1) and the letterbox bars (each a fraction of the height). */
  readonly screen: { readonly fade: string; readonly opacity: number; readonly letterbox: number };
  readonly playing: readonly { readonly handle: number; readonly timeline: string; readonly time: number; readonly state: TimelinePlayState; readonly wait: string }[];
  readonly events: readonly TimelineEvent[];
}

interface Instance {
  readonly handle: number;
  readonly tl: TimelineAsset;
  readonly bindings: Map<string, string>;
  readonly durationSteps: number;
  /** Steps played (the timeline's time is step / hz). */
  step: number;
  status: 'new' | 'playing' | 'paused' | 'waiting';
  /** waiting: for an action (name), a dialogue (handle) — and the steps waited, the timeout in steps. */
  waitAction: string | null;
  waitDialogue: number;
  waited: number;
  waitTimeout: number;
  request: { stop?: true; skip?: true; seek?: number; pause?: boolean };
  /** Sounds / effects / dialogues it started (stopped on skip or stop); timed stops. */
  sounds: number[];
  effects: number[];
  dialogues: number[];
  timed: { at: number; kind: 'sound' | 'effect'; handle: number }[];
  /** The camera it wants live (entity id, null: none) and the key's blend. */
  camera: string | null;
  cameraBlend: { blend: 'cut' | 'linear' | 'eased'; time: number } | null;
  /** Last applied material values (per track), so unchanged values are not rewritten. */
  applied: Map<string, string>;
  /** fade / letterbox this play shows (null: none yet). */
  fade: { color: string; value: number } | null;
  letterbox: number | null;
}

const NO_EVENTS: readonly TimelineEvent[] = Object.freeze([]);

/** Engine limit: timelines playing at once (project-model TIMELINE_LIMITS.playing). */
export const TIMELINE_MAX_PLAYING = 8;

export class TimelineSystem {
  private readonly byId = new Map<string, TimelineAsset>();
  private instances: Instance[] = [];
  private handleSerial = 0;
  private readonly ended: number[] = [];
  private visible: readonly TimelineEvent[] = NO_EVENTS;
  private building: TimelineEvent[] = [];
  private startArmed = true;
  /** The camera the timelines force (entity), as last told to the brain. */
  private forced: string | null = null;
  /** Fade / letterbox kept after a timeline ended with `hold`. */
  private heldFade: { color: string; value: number } | null = null;
  private heldLetterbox = 0;
  private used = false;
  private version = 0;
  private viewCache: { version: number; view: TimelineView } | null = null;
  private stepIndex = 0;
  private readonly warned = new Set<string>();

  constructor(
    timelines: readonly TimelineAsset[],
    private readonly hz: number,
    private readonly host: TimelineHost,
  ) {
    for (const t of timelines) this.byId.set(t.timelineId, t);
  }

  /** Any timeline in the project (the runtime steps the system only then). */
  get active(): boolean {
    return this.byId.size > 0;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  private toSteps(seconds: number): number {
    return Math.round(seconds * this.hz);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.host.warn(message);
  }

  private touch(): void {
    this.used = true;
    this.version += 1;
  }

  // ---- the script surface ------------------------------------------------------

  /** Start a timeline (its slots bound to `bindings` over their defaults); its handle, 0 when refused. */
  play(timelineId: unknown, bindings?: unknown): number {
    const tl = typeof timelineId === 'string' ? this.byId.get(timelineId) : undefined;
    if (tl === undefined) {
      this.warnOnce(`missing:${String(timelineId)}`, `timeline "${String(timelineId).slice(0, 64)}" is not in the project`);
      return 0;
    }
    if (this.instances.length >= TIMELINE_MAX_PLAYING) {
      this.warnOnce('limit', `at most ${TIMELINE_MAX_PLAYING} timelines play at once; "${tl.timelineId}" was not started`);
      return 0;
    }
    const handle = ++this.handleSerial;
    this.instances.push({
      handle,
      tl,
      bindings: timelineBindings(tl, typeof bindings === 'object' ? (bindings as Record<string, unknown> | null) : null),
      durationSteps: Math.max(1, this.toSteps(tl.duration)),
      step: 0,
      status: 'new',
      waitAction: null,
      waitDialogue: 0,
      waited: 0,
      waitTimeout: 0,
      request: {},
      sounds: [],
      effects: [],
      dialogues: [],
      timed: [],
      camera: null,
      cameraBlend: null,
      applied: new Map(),
      fade: null,
      letterbox: null,
    });
    this.touch();
    return handle;
  }

  private find(handle: unknown): Instance | undefined {
    return typeof handle === 'number' ? this.instances.find((i) => i.handle === handle) : undefined;
  }

  pause(handle: unknown): boolean {
    const i = this.find(handle);
    if (i === undefined) return false;
    i.request.pause = true;
    this.touch();
    return true;
  }
  resume(handle: unknown): boolean {
    const i = this.find(handle);
    if (i === undefined) return false;
    i.request.pause = false;
    this.touch();
    return true;
  }
  stop(handle: unknown): boolean {
    const i = this.find(handle);
    if (i === undefined) return false;
    i.request.stop = true;
    this.touch();
    return true;
  }
  skip(handle: unknown): boolean {
    const i = this.find(handle);
    if (i === undefined) return false;
    i.request.skip = true;
    this.touch();
    return true;
  }
  seek(handle: unknown, seconds: unknown): boolean {
    const i = this.find(handle);
    if (i === undefined || typeof seconds !== 'number' || !Number.isFinite(seconds)) return false;
    i.request.seek = Math.max(0, Math.min(i.tl.duration, seconds));
    this.touch();
    return true;
  }
  state(handle: unknown): TimelinePlayState | null {
    const i = this.find(handle);
    if (i !== undefined) return i.status === 'new' ? 'playing' : i.status;
    return typeof handle === 'number' && this.ended.includes(handle) ? 'ended' : null;
  }
  time(handle: unknown): number {
    const i = this.find(handle);
    return i === undefined ? 0 : i.step / this.hz;
  }
  isPlaying(timelineId: unknown): boolean {
    return this.instances.some((i) => i.tl.timelineId === timelineId);
  }
  events(): readonly TimelineEvent[] {
    return this.visible;
  }

  // ---- the step ------------------------------------------------------------------

  /** A new run: nothing plays, overlays cleared, play-on-start armed again (the brain resets its cameras itself). */
  reset(): void {
    this.instances = [];
    this.visible = NO_EVENTS;
    this.building = [];
    this.startArmed = true;
    this.forced = null;
    this.heldFade = null;
    this.heldLetterbox = 0;
    this.version += 1;
  }

  /** One fixed step (`stepIndex`: the step just executed; `action`: its input frame, null in a plain step). */
  step(stepIndex: number, action: ActionFrame | null): void {
    this.stepIndex = stepIndex;
    const hadEvents = this.visible.length > 0;
    this.building = [];
    // Auto plays: a run's start, then signals seen this step.
    if (this.startArmed) {
      this.startArmed = false;
      for (const tl of this.byId.values()) if (tl.playOnStart === true) this.play(tl.timelineId);
    }
    for (const tl of this.byId.values()) {
      if (tl.playOnSignal !== undefined && this.host.signaled(tl.playOnSignal) && !this.isPlaying(tl.timelineId)) this.play(tl.timelineId);
    }
    if (this.instances.length === 0 && !hadEvents && this.forced === null) {
      this.visible = NO_EVENTS;
      return;
    }
    const keep: Instance[] = [];
    for (const inst of [...this.instances]) {
      if (this.runInstance(inst, action)) keep.push(inst);
    }
    this.instances = keep;
    this.applyCamera();
    this.visible = this.building.length > 0 ? Object.freeze(this.building) : NO_EVENTS;
    if (this.instances.length > 0 || this.building.length > 0 || hadEvents) this.version += 1;
  }

  /** One instance's step; false when it ended. */
  private runInstance(inst: Instance, action: ActionFrame | null): boolean {
    const req = inst.request;
    inst.request = {};
    if (req.stop === true) {
      this.finishInstance(inst, 'stopped');
      return false;
    }
    const skipPressed = inst.tl.skipAction !== undefined && action?.actions?.[inst.tl.skipAction]?.p === 'pressed' && inst.status !== 'new';
    if (req.skip === true || skipPressed) {
      this.skipInstance(inst);
      return false;
    }
    if (req.pause === true && inst.status !== 'new') inst.status = 'paused';
    else if (req.pause === false && inst.status === 'paused') inst.status = inst.waitAction !== null || inst.waitDialogue > 0 ? 'waiting' : 'playing';
    if (req.seek !== undefined) {
      inst.step = Math.min(inst.durationSteps, this.toSteps(req.seek));
      if (inst.status === 'waiting') inst.status = 'playing';
      inst.waitAction = null;
      inst.waitDialogue = 0;
      if (inst.status === 'new') {
        inst.status = 'playing';
        this.event('started', inst, '', '');
      }
      this.applyContinuous(inst, true);
      return true;
    }
    if (inst.status === 'new') {
      inst.status = 'playing';
      this.event('started', inst, '', '');
      this.advanceTo(inst, -1, 0);
    } else if (inst.status === 'waiting') {
      inst.waited += 1;
      let done = false;
      if (inst.waitAction !== null && action?.actions?.[inst.waitAction]?.p === 'pressed') done = true;
      if (inst.waitDialogue > 0 && this.host.dialogue !== undefined && !this.host.dialogue.running(inst.waitDialogue)) done = true;
      if (inst.waitTimeout > 0 && inst.waited >= inst.waitTimeout) done = true;
      if (done) {
        inst.status = 'playing';
        inst.waitAction = null;
        inst.waitDialogue = 0;
        this.advanceTo(inst, inst.step, inst.step + 1);
      }
    } else if (inst.status === 'playing') {
      this.advanceTo(inst, inst.step, inst.step + 1);
    }
    this.runTimed(inst);
    this.applyContinuous(inst, false);
    if (inst.status === 'playing' && inst.step >= inst.durationSteps) {
      this.finishInstance(inst, 'finished');
      return false;
    }
    return true;
  }

  /** Move from step `from` (exclusive) to `to`, firing the discrete keys crossed; a wait stops earlier. */
  private advanceTo(inst: Instance, from: number, to: number): void {
    const target = Math.min(to, inst.durationSteps);
    // The earliest blocking key in (from, target]: a wait, or a dialogue that waits.
    let stopAt = target;
    for (const t of inst.tl.tracks) {
      if (t.muted === true || (t.type !== 'wait' && t.type !== 'dialogue')) continue;
      for (const k of t.keys) {
        const s = this.toSteps(k.time);
        if (s > from && s <= stopAt && (t.type === 'wait' || k.wait !== false)) stopAt = s;
      }
    }
    inst.step = Math.max(0, stopAt);
    this.fireRange(inst, from, stopAt, false);
    this.markers(inst, from, stopAt);
  }

  /** The keys with from < step ≤ to, in (step, track, key) order. */
  private keysIn(inst: Instance, from: number, to: number): { t: TimelineTrack; k: TimelineKey; s: number; ti: number; ki: number }[] {
    const out: { t: TimelineTrack; k: TimelineKey; s: number; ti: number; ki: number }[] = [];
    inst.tl.tracks.forEach((t, ti) => {
      if (t.muted === true) return;
      t.keys.forEach((k, ki) => {
        const s = this.toSteps(k.time);
        if (s > from && s <= to) out.push({ t, k, s, ti, ki });
      });
    });
    return out.sort((a, b) => a.s - b.s || a.ti - b.ti || a.ki - b.ki);
  }

  private markers(inst: Instance, from: number, to: number): void {
    for (const m of inst.tl.markers ?? []) {
      const s = this.toSteps(m.time);
      if (s > from && s <= to) this.event('marker', inst, m.name, '');
    }
  }

  private bound(inst: Instance, slot: string | undefined, what: string): string | null {
    if (slot === undefined) return null;
    const id = inst.bindings.get(slot);
    if (id === undefined) this.warnOnce(`slot:${inst.tl.timelineId}:${slot}`, `timeline "${inst.tl.timelineId}": slot "${slot}" (${what}) is not bound`);
    return id ?? null;
  }

  /** Fire discrete keys; `skipping`: the end-state rules instead (see `skipInstance`). */
  private fireRange(inst: Instance, from: number, to: number, skipping: boolean): void {
    for (const { t, k, s } of this.keysIn(inst, from, to)) {
      switch (t.type) {
        case 'animator': {
          const id = this.bound(inst, t.target, 'animator');
          const a = id === null ? null : this.host.animator(id);
          if (a === null) {
            if (id !== null) this.warnOnce(`anim:${id}`, `timeline "${inst.tl.timelineId}": "${id}" has no animator`);
            break;
          }
          if (k.kind === 'set' && k.value !== undefined) a.set(k.name ?? '', k.value as number | boolean);
          else if (k.kind === 'trigger' && !skipping) a.trigger(k.name ?? '');
          else if (k.kind === 'play') a.play(k.name ?? '', skipping ? 0 : (k.fade ?? 0), k.layer ?? 0);
          break;
        }
        case 'audio': {
          if (k.kind === 'music') this.host.audio.music(k.asset ?? null, k.fade ?? 1);
          else if (k.kind === 'release') this.host.audio.releaseMusic(k.fade ?? 1);
          else if (skipping) break;
          else if (k.kind === 'stinger' && k.asset !== undefined) {
            const h = this.host.audio.stinger(k.asset, k.volume);
            if (h > 0) inst.sounds.push(h);
          } else if (k.kind === 'sfx' && k.asset !== undefined) {
            const at = this.bound(inst, k.at, 'sound position');
            const h = this.host.audio.play(k.asset, { ...(k.volume !== undefined ? { volume: k.volume } : {}), ...(k.loop === true ? { loop: true } : {}), ...(at !== null ? { entityId: at } : {}) });
            if (h > 0) {
              inst.sounds.push(h);
              if (k.duration !== undefined) inst.timed.push({ at: s + Math.max(1, this.toSteps(k.duration)), kind: 'sound', handle: h });
            }
          }
          break;
        }
        case 'dialogue': {
          if (skipping) break;
          const port = this.host.dialogue;
          if (port === undefined) {
            this.warnOnce('dialogue', `timeline "${inst.tl.timelineId}": dialogue keys need the dialogue system (not in this engine build); skipped`);
            break;
          }
          const h = port.start(k.dialogue ?? '', k.node, inst.bindings);
          if (h > 0) {
            inst.dialogues.push(h);
            if (k.wait !== false && s === inst.step) {
              inst.status = 'waiting';
              inst.waitDialogue = h;
              inst.waited = 0;
              inst.waitTimeout = 0;
            }
          }
          break;
        }
        case 'effect': {
          if (skipping) break;
          const at = this.bound(inst, k.at, 'effect position');
          const h = this.host.effects.play(k.effect ?? '', { ...(k.position !== undefined ? { position: k.position } : {}), ...(at !== null ? { entityId: at } : {}), ...(k.params !== undefined ? { params: k.params } : {}) });
          if (h > 0) {
            inst.effects.push(h);
            if (k.duration !== undefined) inst.timed.push({ at: s + Math.max(1, this.toSteps(k.duration)), kind: 'effect', handle: h });
          }
          break;
        }
        case 'activation': {
          const id = this.bound(inst, t.target, 'activation');
          if (id !== null && k.active !== undefined) this.host.setVisible(id, k.active);
          break;
        }
        case 'signal':
          if (k.name !== undefined && (!skipping || k.onSkip !== 'drop')) this.host.emitSignal(k.name);
          break;
        case 'wait':
          if (!skipping && s === inst.step) {
            inst.status = 'waiting';
            inst.waitAction = k.action ?? null;
            inst.waitDialogue = 0;
            inst.waited = 0;
            inst.waitTimeout = k.timeout !== undefined ? Math.max(1, this.toSteps(k.timeout)) : 0;
          }
          break;
        case 'mode': {
          // Skip applies the remaining mode keys in order: the last one's switch is the one that happens.
          const ok = this.host.switchMode?.(k.mode ?? '', skipping ? { blend: 'cut' } : { ...(k.blend !== undefined ? { blend: k.blend } : {}), ...(k.blendTime !== undefined ? { blendTime: k.blendTime } : {}) }) ?? false;
          if (!ok) this.warnOnce(`mode:${k.mode}`, `timeline "${inst.tl.timelineId}": no game mode "${k.mode ?? ''}"`);
          break;
        }
        case 'environment': {
          const port = this.host.environment;
          if (port === undefined) {
            this.warnOnce('environment', `timeline "${inst.tl.timelineId}": environment keys need environment presets (not in this engine build); skipped`);
            break;
          }
          port.apply(k.preset ?? '', skipping ? 0 : (k.blendTime ?? 0));
          break;
        }
        default:
          break; // continuous tracks (camera, transform, fade, letterbox, material) are applied from the time
      }
    }
  }

  /** Timed stops (an sfx or effect clip's end). */
  private runTimed(inst: Instance): void {
    if (inst.timed.length === 0) return;
    const due = inst.timed.filter((x) => x.at <= inst.step);
    if (due.length === 0) return;
    inst.timed = inst.timed.filter((x) => x.at > inst.step);
    for (const d of due) {
      if (d.kind === 'sound') this.host.audio.stop(d.handle, 0);
      else this.host.effects.stop(d.handle);
    }
  }

  /** The continuous tracks at the instance's time (`jump`: a seek or skip — the camera cuts). */
  private applyContinuous(inst: Instance, jump: boolean): void {
    const time = inst.step / this.hz;
    inst.fade = null;
    inst.letterbox = null;
    for (const t of inst.tl.tracks) {
      if (t.muted === true) continue;
      switch (t.type) {
        case 'transform': {
          const id = this.bound(inst, t.target, 'transform');
          if (id === null) break;
          const pose = transformTrackAt(t, time);
          if ((pose.position !== undefined || pose.rotation !== undefined || pose.scale !== undefined) && !this.host.writeTransform(id, pose)) this.warnOnce(`xf:${id}`, `timeline "${inst.tl.timelineId}": "${id}" is not loaded`);
          break;
        }
        case 'camera': {
          const i = cameraKeyAt(t, time);
          const k = t.keys[i];
          if (k === undefined) break;
          const id = k.release === true ? null : this.bound(inst, k.camera, 'camera');
          if (id !== inst.camera) {
            inst.camera = id;
            inst.cameraBlend = jump ? { blend: 'cut', time: 0 } : { blend: k.blend ?? 'cut', time: k.blendTime ?? 0 };
            // A release key hands the view back with its own blend.
            if (id === null) this.releaseBlend = inst.cameraBlend;
          }
          const p = cameraProgressAt(t, i, time, inst.tl.duration);
          if (id !== null && p !== null) this.host.cameraProgress(id, p);
          break;
        }
        case 'material': {
          const id = this.bound(inst, t.target, 'material');
          const v = valueTrackAt(t, time);
          if (id === null || v === undefined || t.param === undefined) break;
          const text = JSON.stringify(v);
          if (inst.applied.get(t.trackId) === text) break;
          inst.applied.set(t.trackId, text);
          if (!this.host.setMaterial(id, t.param, v, t.material)) this.warnOnce(`mat:${id}:${t.param}`, `timeline "${inst.tl.timelineId}": "${id}" has no public material parameter "${t.param}" of that type`);
          break;
        }
        case 'fade': {
          const v = valueTrackAt(t, time);
          if (typeof v === 'number') inst.fade = { color: fadeColorAt(t, time), value: v };
          break;
        }
        case 'letterbox': {
          const v = valueTrackAt(t, time);
          if (typeof v === 'number') inst.letterbox = v;
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Skip: each track's end state at once, then the end.
   * - camera: the last key's camera (cut), its rail progress at the end;
   * - transform, material, fade, letterbox: their values at the end;
   * - animator: remaining `set` keys applied in order, `play` keys without a
   *   crossfade, `trigger` keys dropped (a trigger is a moment, not a state);
   * - audio: remaining music / release keys applied in order (the music owner
   *   and track end as if played); stingers and sfx not played; the sounds
   *   the timeline started stop (0.1 s fade);
   * - dialogue: not run; the running one stops. effect: not started; the
   *   ones it started stop;
   * - activation: remaining keys applied in order (the last wins);
   * - signal: remaining keys fire now unless `onSkip: "drop"`;
   * - wait: passed; environment: the last preset without a blend;
   * - markers after the skip point are not reported.
   */
  private skipInstance(inst: Instance): void {
    if (inst.status === 'new') this.event('started', inst, '', '');
    const from = inst.status === 'new' ? -1 : inst.step;
    this.fireRange(inst, from, inst.durationSteps, true);
    for (const h of inst.sounds) if (this.host.audio.playing(h)) this.host.audio.stop(h, 0.1);
    for (const h of inst.effects) this.host.effects.stop(h);
    for (const h of inst.dialogues) this.host.dialogue?.stop(h);
    inst.sounds = [];
    inst.effects = [];
    inst.dialogues = [];
    inst.timed = [];
    inst.step = inst.durationSteps;
    this.applyContinuous(inst, true);
    this.release(inst, true);
    this.event('ended', inst, '', 'skipped');
    this.noteEnded(inst.handle);
  }

  /** The end (finished) or a stop (no end states: the sounds, effects and dialogue it started stop). */
  private finishInstance(inst: Instance, reason: 'finished' | 'stopped'): void {
    if (reason === 'stopped') {
      if (inst.status === 'new') this.event('started', inst, '', '');
      for (const h of inst.sounds) if (this.host.audio.playing(h)) this.host.audio.stop(h, 0.1);
      for (const h of inst.effects) this.host.effects.stop(h);
      for (const h of inst.dialogues) this.host.dialogue?.stop(h);
      inst.fade = null;
      inst.letterbox = null;
    } else {
      // A finished play's timed stops still happen (its clips end with it).
      for (const d of inst.timed) {
        if (d.kind === 'sound') this.host.audio.stop(d.handle, 0);
        else this.host.effects.stop(d.handle);
      }
    }
    this.release(inst, false, reason === 'stopped');
    this.event('ended', inst, '', reason);
    this.noteEnded(inst.handle);
  }

  /** What stays after the end: kept cameras, held overlays, the music handed back. */
  private release(inst: Instance, skipped: boolean, stopped = false): void {
    for (const t of inst.tl.tracks) {
      if (t.muted === true) continue;
      if (t.type === 'camera') {
        // The camera leaves with the track's end blend (a skip cuts); `keep` leaves the last camera enabled and most recent.
        if (t.end === 'keep' && inst.camera !== null && !stopped) this.host.cameraActivate(inst.camera);
        inst.cameraBlend = skipped || stopped ? { blend: 'cut', time: 0 } : { blend: t.endBlend ?? 'cut', time: t.endBlendTime ?? 0 };
        this.releaseBlend = inst.cameraBlend;
      } else if ((t.type === 'fade' || t.type === 'letterbox') && t.hold === true && !stopped) {
        if (t.type === 'fade' && inst.fade !== null) this.heldFade = inst.fade;
        if (t.type === 'letterbox' && inst.letterbox !== null) this.heldLetterbox = inst.letterbox;
      } else if (t.type === 'audio' && t.releaseMusic === true) {
        const last = [...t.keys].reverse().find((k) => k.kind === 'music');
        this.host.audio.releaseMusic(last?.fade ?? 1);
      }
    }
    inst.camera = null;
  }

  private releaseBlend: { blend: 'cut' | 'linear' | 'eased'; time: number } | null = null;

  /** The camera the latest play with a live camera wants; told to the brain when it changes. */
  private applyCamera(): void {
    let want: Instance | null = null;
    for (const i of this.instances) if (i.camera !== null) want = i;
    const id = want?.camera ?? null;
    if (id !== this.forced) {
      const blend = want !== null ? want.cameraBlend : this.releaseBlend;
      this.forced = id;
      this.host.cameraOverride(id, blend);
    }
    this.releaseBlend = null;
  }

  private noteEnded(handle: number): void {
    this.ended.push(handle);
    if (this.ended.length > 64) this.ended.splice(0, this.ended.length - 64);
  }

  private event(kind: TimelineEvent['kind'], inst: Instance, name: string, reason: TimelineEvent['reason']): void {
    this.building.push(Object.freeze({ kind, handle: inst.handle, timeline: inst.tl.timelineId, name, reason, stepIndex: this.stepIndex }));
  }

  // ---- views ----------------------------------------------------------------------

  /** The screen overlay: the latest play showing a fade / letterbox, else the held values. */
  private screen(): { fade: string; opacity: number; letterbox: number } {
    let fade = this.heldFade;
    let letterbox = this.heldLetterbox;
    for (const i of this.instances) {
      if (i.fade !== null) fade = i.fade;
      if (i.letterbox !== null) letterbox = i.letterbox;
    }
    return { fade: fade?.color ?? '#000000', opacity: fade?.value ?? 0, letterbox };
  }

  /** The view for the host and observers (null until a timeline was ever played). */
  view(): TimelineView | null {
    if (!this.used) return null;
    if (this.viewCache !== null && this.viewCache.version === this.version) return this.viewCache.view;
    const view: TimelineView = Object.freeze({
      screen: Object.freeze(this.screen()),
      playing: Object.freeze(
        this.instances.map((i) =>
          Object.freeze({ handle: i.handle, timeline: i.tl.timelineId, time: i.step / this.hz, state: i.status === 'new' ? ('playing' as const) : i.status, wait: i.waitAction ?? (i.waitDialogue > 0 ? 'dialogue' : '') }),
        ),
      ),
      events: this.visible,
    });
    this.viewCache = { version: this.version, view };
    return view;
  }

  /** The state in the step digest (null until a timeline was ever played, so every other digest is unchanged). */
  digestState(): string | null {
    if (!this.used) return null;
    return JSON.stringify({
      i: this.instances.map((i) => [i.handle, i.tl.timelineId, i.step, i.status, i.waited, i.camera, [...i.bindings]]),
      s: this.screen(),
      f: this.forced,
      e: this.visible.map((e) => [e.kind, e.handle, e.name, e.reason]),
    });
  }
}
