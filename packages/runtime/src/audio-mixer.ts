/**
 * The simulation's audio intent log (`ctx.audio`).
 *
 * Scripts never touch sound. What they ask for is simulation state here —
 * the handle a play gets, each voice's volume/fade, pitch, loop flag and
 * place in its clip, the music the scripts hold, the music duck and the
 * scripts' bus mix — and every change becomes one `AudioCommand` in step
 * order that the page's audio engine executes (Web Audio). So a replay, a
 * second run and the simulation worker allocate the same handles and emit
 * the same command stream, and a script's `finished` event arrives on the
 * same step everywhere; what is actually heard is the host's business.
 *
 * Time: fades count whole steps (`round(seconds · hz)`, linear); a clip
 * advances `pitch / hz` seconds per step and a non-looping one finishes when
 * it reaches the clip's length (the asset's recorded duration, from the
 * snapshot). A clip whose duration is unknown only finishes when stopped.
 * The finished events a step produces are seen by scripts in the next step.
 *
 * Music priority: a script that sets a track (`music`) owns the music until
 * it calls `releaseMusic` (or the run restarts); meanwhile the game flow's
 * level/title music waits and comes back on release. The music duck is the
 * deepest of every duck request alive — the script's `duck`, each playing
 * stinger's, and dialogue voice — and comes back up when the
 * deepest one ends.
 */
import type { AudioFinishedEvent, AudioMusicState, AudioPlayOptions, AudioStingerOptions } from './types';

export type { AudioFinishedEvent, AudioMusicState, AudioPlayOptions, AudioStingerOptions };

/** The mixer buses a sound plays on (the player's settings screen sets each; scripts mix on top). */
export type AudioBusName = 'sfx' | 'music' | 'voice' | 'ui';
export const AUDIO_BUS_NAMES: readonly AudioBusName[] = Object.freeze(['sfx', 'music', 'voice', 'ui']);

/** The distance models a positional sound (a script's, an audio source's) fades by (the Web Audio PannerNode's). */
export type AudioDistanceModel = 'linear' | 'inverse' | 'exponential';

/** How a positional sound fades with distance. */
export interface AudioSpatial {
  readonly distanceModel: AudioDistanceModel;
  /** Full volume within this distance (m). */
  readonly refDistance: number;
  /** Linear model: silent beyond it; the others stop fading beyond it (m). */
  readonly maxDistance: number;
  /** How fast it fades (1 = the model's natural rate). */
  readonly rolloff: number;
}

/**
 * Defaults of a script's positional sound: linear from full volume within
 * 2 m (about arm's reach around a character) to silence at 30 m (well beyond
 * a room, within a courtyard), rolloff 1. Genre-neutral: a sound heard from
 * across a small space, silent across a large one.
 */
export const AUDIO_SPATIAL_DEFAULTS: AudioSpatial = Object.freeze({ distanceModel: 'linear', refDistance: 2, maxDistance: 30, rolloff: 1 });

/** Limits: live handles, plays per step, the command queue nobody takes (oldest dropped). */
export const AUDIO_MAX_HANDLES = 64;
export const AUDIO_MAX_PLAYS_PER_STEP = 32;
export const AUDIO_MAX_QUEUED_COMMANDS = 256;
export const AUDIO_PITCH_MIN = 0.25;
export const AUDIO_PITCH_MAX = 4;
export const AUDIO_FADE_MAX_SECONDS = 60;
/** A stinger's music duck (0.3: the track stays audible under it) and its duck/restore time (0.25 s). */
export const STINGER_DEFAULTS = Object.freeze({ duck: 0.3, fade: 0.25 });

/**
 * One command of the intent log (the host's audio engine executes them in
 * order). `stepIndex` is the step it was made in. A `play` keeps the phase
 * 9.10 request's fields (`assetId`, `volume`, `stepIndex`).
 */
export type AudioCommand =
  | {
      readonly op: 'play';
      readonly stepIndex: number;
      readonly handle: number;
      readonly assetId: string;
      readonly bus: AudioBusName;
      /** The volume it reaches (after `fadeIn`). */
      readonly volume: number;
      readonly loop: boolean;
      /** Playback rate (pitch): 1 = as recorded. */
      readonly pitch: number;
      readonly fadeIn: number;
      /** A stinger: plays on the music bus beside the ducked track. */
      readonly stinger?: true;
      /** Positional: it follows this entity (position is then an offset from it) ... */
      readonly entityId?: string;
      /** ... or plays at this world position. */
      readonly position?: readonly [number, number, number];
      readonly spatial?: AudioSpatial;
    }
  | { readonly op: 'stop'; readonly stepIndex: number; readonly handle: number; readonly fade: number }
  | { readonly op: 'fade'; readonly stepIndex: number; readonly handle: number; readonly to: number; readonly seconds: number }
  | { readonly op: 'set'; readonly stepIndex: number; readonly handle: number; readonly volume?: number; readonly pitch?: number; readonly loop?: boolean }
  /** Music: a track the scripts hold (null: silence), or `release` (back to the game flow's music). */
  | { readonly op: 'music'; readonly stepIndex: number; readonly assetId: string | null; readonly fade: number; readonly release?: true }
  /** The music duck: the track's level (1 = not ducked), reached over `seconds`. `bus: 'sfx'` ducks the SFX bus instead (dialogue voice). */
  | { readonly op: 'duck'; readonly stepIndex: number; readonly level: number; readonly seconds: number; readonly bus?: 'sfx' }
  /** A script's mix on one bus (on top of the player's volume), reached over `seconds`. */
  | { readonly op: 'bus'; readonly stepIndex: number; readonly bus: AudioBusName; readonly volume: number; readonly seconds: number }
  /** A new run: every script voice stops, the music goes back to the flow, the duck and the mix to 1. */
  | { readonly op: 'reset'; readonly stepIndex: number };

interface Ramp {
  from: number;
  to: number;
  steps: number;
  elapsed: number;
}

interface VoiceState {
  readonly handle: number;
  readonly assetId: string;
  readonly bus: AudioBusName;
  loop: boolean;
  pitch: number;
  /** Seconds into the clip (wraps while looping). */
  pos: number;
  /** The clip's length (s), Infinity when unknown. */
  readonly duration: number;
  volume: Ramp;
  /** Stop when the volume ramp ends (a stop with a fade), or at this step's end (no fade). */
  stopping: boolean;
  /** A stinger's duck level (null: not a stinger). */
  readonly duck: number | null;
  readonly duckFade: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : v === undefined ? fallback : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const rampValue = (r: Ramp): number => (r.steps <= 0 || r.elapsed >= r.steps ? r.to : r.from + (r.to - r.from) * (r.elapsed / r.steps));
const ASSET_RE = /^.{1,128}$/s;

/** The gain a positional sound gets at `distance` (the Web Audio PannerNode formulas). */
export function distanceGain(s: AudioSpatial, distance: number): number {
  const ref = Math.max(1e-6, s.refDistance);
  const d = Math.max(0, distance);
  if (s.distanceModel === 'linear') {
    const max = Math.max(ref, s.maxDistance);
    if (max <= ref) return d <= ref ? 1 : 0;
    const dc = clamp(d, ref, max);
    return clamp(1 - clamp(s.rolloff, 0, 1) * ((dc - ref) / (max - ref)), 0, 1);
  }
  const dc = Math.max(d, ref);
  if (s.distanceModel === 'inverse') return ref / (ref + Math.max(0, s.rolloff) * (dc - ref));
  return Math.pow(dc / ref, -Math.max(0, s.rolloff));
}

/**
 * Where a source sits for a listener at `lp` with orientation `lq` (a
 * camera: looks down −Z, +X to its right): the stereo pan (−1 left … +1
 * right, the sine of the azimuth — the equal-power panner's input) and the
 * distance.
 */
export function listenerRelative(lp: readonly number[], lq: readonly number[], sp: readonly number[]): { pan: number; distance: number; local: [number, number, number] } {
  const dx = sp[0]! - lp[0]!;
  const dy = sp[1]! - lp[1]!;
  const dz = sp[2]! - lp[2]!;
  // Rotate by the conjugate of lq (world → listener space).
  const qx = -lq[0]!;
  const qy = -lq[1]!;
  const qz = -lq[2]!;
  const qw = lq[3]!;
  const tx = 2 * (qy * dz - qz * dy);
  const ty = 2 * (qz * dx - qx * dz);
  const tz = 2 * (qx * dy - qy * dx);
  const x = dx + qw * tx + (qy * tz - qz * ty);
  const y = dy + qw * ty + (qz * tx - qx * tz);
  const z = dz + qw * tz + (qx * ty - qy * tx);
  const distance = Math.hypot(x, y, z);
  const pan = distance < 1e-9 ? 0 : clamp(x / distance, -1, 1);
  return { pan, distance, local: [x, y, z] };
}

/** Resolve a positional play's spatial options (null: not positional). */
export function spatialOf(options: AudioPlayOptions | undefined): AudioSpatial | null {
  if (options === undefined || (options.entityId === undefined && options.position === undefined)) return null;
  const model = options.distanceModel === 'inverse' || options.distanceModel === 'exponential' ? options.distanceModel : 'linear';
  const ref = clamp(num(options.refDistance, AUDIO_SPATIAL_DEFAULTS.refDistance), 0.01, 10000);
  const max = clamp(num(options.maxDistance, AUDIO_SPATIAL_DEFAULTS.maxDistance), ref, 10000);
  return Object.freeze({ distanceModel: model, refDistance: ref, maxDistance: max, rolloff: clamp(num(options.rolloff, 1), 0, 100) });
}

export class AudioMixer {
  private readonly voices = new Map<number, VoiceState>();
  private nextHandle = 0;
  private queue: AudioCommand[] = [];
  private visible: readonly AudioFinishedEvent[] = Object.freeze([]);
  private playsStep = -1;
  private playsThisStep = 0;
  /** undefined: the flow owns the music; else the scripts' track (null = silence). */
  private musicTrack: string | null | undefined = undefined;
  /** Duck requests by source (`script`, `stinger:<handle>`, `voice`), each a level 0–1 and its fade. */
  private readonly ducks = new Map<string, { level: number; fade: number }>();
  private duckLevel = 1;
  /** The SFX duck (dialogue voice ducks effects too), like the music's. */
  private readonly sfxDucks = new Map<string, { level: number; fade: number }>();
  private sfxDuckLevel = 1;
  private readonly busMix = new Map<AudioBusName, Ramp>();
  /** Something scripts did (the digest and observation include the mixer only then). */
  private used = false;

  constructor(
    private readonly hz: number,
    private readonly durations: Readonly<Record<string, number>>,
    private readonly stepOf: () => number,
  ) {}

  // ---- script calls ---------------------------------------------------------

  play(assetId: unknown, options?: AudioPlayOptions, stinger?: { duck: number; fade: number }): number {
    if (typeof assetId !== 'string' || !ASSET_RE.test(assetId) || assetId.length === 0) return 0;
    const step = this.stepOf();
    if (this.playsStep !== step) {
      this.playsStep = step;
      this.playsThisStep = 0;
    }
    if (this.playsThisStep >= AUDIO_MAX_PLAYS_PER_STEP || this.voices.size >= AUDIO_MAX_HANDLES) return 0;
    this.playsThisStep += 1;
    this.used = true;
    const o = (typeof options === 'object' && options !== null ? options : {}) as AudioPlayOptions;
    const volume = clamp(num(o.volume, 1), 0, 1);
    const pitch = clamp(num(o.pitch, 1), AUDIO_PITCH_MIN, AUDIO_PITCH_MAX);
    const fadeIn = clamp(num(o.fadeIn, 0), 0, AUDIO_FADE_MAX_SECONDS);
    const loop = stinger === undefined && o.loop === true;
    const bus: AudioBusName = stinger !== undefined ? 'music' : o.bus === 'music' || o.bus === 'voice' || o.bus === 'ui' ? o.bus : 'sfx';
    const handle = ++this.nextHandle;
    const ms = this.durations[assetId];
    const duration = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms / 1000 : Infinity;
    const steps = this.steps(fadeIn);
    this.voices.set(handle, {
      handle,
      assetId,
      bus,
      loop,
      pitch,
      pos: 0,
      duration,
      volume: { from: steps > 0 ? 0 : volume, to: volume, steps, elapsed: 0 },
      stopping: false,
      duck: stinger !== undefined ? stinger.duck : null,
      duckFade: stinger !== undefined ? stinger.fade : 0,
    });
    const spatial = stinger === undefined ? spatialOf(o) : null;
    let position: [number, number, number] | undefined;
    if (spatial !== null && Array.isArray(o.position)) position = [num(o.position[0], 0), num(o.position[1], 0), num(o.position[2], 0)];
    else if (spatial !== null) position = [0, 0, 0];
    const entityId = spatial !== null && typeof o.entityId === 'string' && o.entityId.length > 0 && o.entityId.length <= 128 ? o.entityId : undefined;
    this.push({
      op: 'play',
      stepIndex: step,
      handle,
      assetId,
      bus,
      volume,
      loop,
      pitch,
      fadeIn: steps / this.hz,
      ...(stinger !== undefined ? { stinger: true as const } : {}),
      ...(entityId !== undefined ? { entityId } : {}),
      ...(position !== undefined ? { position: Object.freeze(position) as readonly [number, number, number] } : {}),
      ...(spatial !== null ? { spatial } : {}),
    });
    if (stinger !== undefined) this.setDuck(`stinger:${handle}`, stinger.duck, stinger.fade);
    return handle;
  }

  stinger(assetId: unknown, options?: AudioStingerOptions): number {
    const o = (typeof options === 'object' && options !== null ? options : {}) as AudioStingerOptions;
    const duck = clamp(num(o.duck, STINGER_DEFAULTS.duck), 0, 1);
    const fade = this.steps(clamp(num(o.fade, STINGER_DEFAULTS.fade), 0, AUDIO_FADE_MAX_SECONDS)) / this.hz;
    return this.play(assetId, { volume: num(o.volume, 1) }, { duck, fade });
  }

  stop(handle: unknown, fadeSeconds?: unknown): void {
    const v = this.voice(handle);
    if (v === null || v.stopping) return;
    const steps = this.steps(clamp(num(fadeSeconds, 0), 0, AUDIO_FADE_MAX_SECONDS));
    v.stopping = true;
    v.volume = { from: rampValue(v.volume), to: 0, steps, elapsed: 0 };
    this.push({ op: 'stop', stepIndex: this.stepOf(), handle: v.handle, fade: steps / this.hz });
  }

  fade(handle: unknown, to: unknown, seconds: unknown): void {
    const v = this.voice(handle);
    if (v === null || v.stopping) return;
    const target = clamp(num(to, 0), 0, 1);
    const steps = this.steps(clamp(num(seconds, 0), 0, AUDIO_FADE_MAX_SECONDS));
    v.volume = { from: rampValue(v.volume), to: target, steps, elapsed: 0 };
    this.push({ op: 'fade', stepIndex: this.stepOf(), handle: v.handle, to: target, seconds: steps / this.hz });
  }

  setVolume(handle: unknown, volume: unknown): void {
    const v = this.voice(handle);
    if (v === null || v.stopping) return;
    const to = clamp(num(volume, 1), 0, 1);
    v.volume = { from: to, to, steps: 0, elapsed: 0 };
    this.push({ op: 'set', stepIndex: this.stepOf(), handle: v.handle, volume: to });
  }

  setPitch(handle: unknown, pitch: unknown): void {
    const v = this.voice(handle);
    if (v === null) return;
    const p = clamp(num(pitch, 1), AUDIO_PITCH_MIN, AUDIO_PITCH_MAX);
    if (p === v.pitch) return;
    v.pitch = p;
    this.push({ op: 'set', stepIndex: this.stepOf(), handle: v.handle, pitch: p });
  }

  setLoop(handle: unknown, loop: unknown): void {
    const v = this.voice(handle);
    if (v === null || v.duck !== null) return;
    const l = loop === true;
    if (l === v.loop) return;
    v.loop = l;
    this.push({ op: 'set', stepIndex: this.stepOf(), handle: v.handle, loop: l });
  }

  playing(handle: unknown): boolean {
    return this.voice(handle) !== null;
  }

  volumeOf(handle: unknown): number {
    const v = this.voice(handle);
    return v === null ? 0 : rampValue(v.volume);
  }

  pitchOf(handle: unknown): number {
    const v = this.voice(handle);
    return v === null ? 0 : v.pitch;
  }

  finished(handle: unknown): boolean {
    const h = Number(handle);
    return this.visible.some((e) => e.handle === h);
  }

  events(): readonly AudioFinishedEvent[] {
    return this.visible;
  }

  music(assetId: unknown, fadeSeconds?: unknown): void {
    const id = assetId === null ? null : typeof assetId === 'string' && assetId.length > 0 && assetId.length <= 128 ? assetId : undefined;
    if (id === undefined) return;
    this.used = true;
    this.musicTrack = id;
    this.push({ op: 'music', stepIndex: this.stepOf(), assetId: id, fade: this.steps(clamp(num(fadeSeconds, 1), 0, AUDIO_FADE_MAX_SECONDS)) / this.hz });
  }

  releaseMusic(fadeSeconds?: unknown): void {
    if (this.musicTrack === undefined) return;
    this.musicTrack = undefined;
    this.push({ op: 'music', stepIndex: this.stepOf(), assetId: null, fade: this.steps(clamp(num(fadeSeconds, 1), 0, AUDIO_FADE_MAX_SECONDS)) / this.hz, release: true });
  }

  duck(level: unknown, seconds?: unknown): void {
    this.used = true;
    this.setDuck('script', clamp(num(level, 0.3), 0, 1), this.steps(clamp(num(seconds, 0.25), 0, AUDIO_FADE_MAX_SECONDS)) / this.hz);
  }

  unduck(seconds?: unknown): void {
    this.setDuck('script', 1, this.steps(clamp(num(seconds, 0.25), 0, AUDIO_FADE_MAX_SECONDS)) / this.hz);
  }

  /**
   * A duck request by `source` (level 1 removes it). The duck is the deepest
   * request alive; when it changes, one `duck` command moves the music there
   * over the fade of the request that caused the change.
   */
  setDuck(source: string, level: number, fade: number, bus: 'music' | 'sfx' = 'music'): void {
    const ducks = bus === 'sfx' ? this.sfxDucks : this.ducks;
    if (level >= 1) ducks.delete(source);
    else {
      ducks.set(source, { level, fade });
      this.used = true;
    }
    let deepest = 1;
    for (const d of ducks.values()) deepest = Math.min(deepest, d.level);
    if (deepest === (bus === 'sfx' ? this.sfxDuckLevel : this.duckLevel)) return;
    if (bus === 'sfx') this.sfxDuckLevel = deepest;
    else this.duckLevel = deepest;
    this.push({ op: 'duck', stepIndex: this.stepOf(), level: deepest, seconds: fade, ...(bus === 'sfx' ? { bus: 'sfx' as const } : {}) });
  }

  /** The SFX duck now (1 = not ducked). */
  sfxDuck(): number {
    return this.sfxDuckLevel;
  }

  setBusVolume(bus: unknown, volume: unknown, seconds?: unknown): void {
    if (bus !== 'sfx' && bus !== 'music' && bus !== 'voice' && bus !== 'ui') return;
    this.used = true;
    const to = clamp(num(volume, 1), 0, 1);
    const steps = this.steps(clamp(num(seconds, 0), 0, AUDIO_FADE_MAX_SECONDS));
    const cur = this.busVolume(bus);
    this.busMix.set(bus, { from: cur, to, steps, elapsed: 0 });
    this.push({ op: 'bus', stepIndex: this.stepOf(), bus, volume: to, seconds: steps / this.hz });
  }

  busVolume(bus: unknown): number {
    const r = this.busMix.get(bus as AudioBusName);
    return r === undefined ? 1 : rampValue(r);
  }

  musicState(): AudioMusicState {
    return Object.freeze({ owner: this.musicTrack === undefined ? 'flow' : 'script', track: this.musicTrack ?? null, duck: this.duckLevel });
  }

  // ---- the runtime's calls -------------------------------------------------

  /**
   * The end of a fixed step: fades advance one step, clips `pitch / hz`
   * seconds; voices that finish produce the events the next step sees.
   */
  endStep(): void {
    let out: AudioFinishedEvent[] | null = null;
    for (const v of this.voices.values()) {
      if (v.volume.elapsed < v.volume.steps) v.volume.elapsed += 1;
      v.pos += v.pitch / this.hz;
      let reason: 'ended' | 'stopped' | null = null;
      if (v.stopping && v.volume.elapsed >= v.volume.steps) reason = 'stopped';
      // (1e-9 s: the sum of per-step increments must not miss an exact end by a rounding error.)
      else if (v.pos >= v.duration - 1e-9) {
        if (v.loop) v.pos = Math.max(0, v.pos - v.duration);
        else reason = 'ended';
      }
      if (reason === null) continue;
      this.voices.delete(v.handle);
      (out ??= []).push(Object.freeze({ kind: 'finished', handle: v.handle, assetId: v.assetId, reason }));
      if (v.duck !== null) this.setDuck(`stinger:${v.handle}`, 1, v.duckFade);
    }
    for (const r of this.busMix.values()) if (r.elapsed < r.steps) r.elapsed += 1;
    this.visible = out === null ? (this.visible.length === 0 ? this.visible : Object.freeze([])) : Object.freeze(out);
  }

  /** A new run: script voices stop (no events), the music goes back to the flow, the duck and mix to 1. */
  reset(): void {
    if (!this.used && this.voices.size === 0) return;
    this.voices.clear();
    this.visible = Object.freeze([]);
    this.musicTrack = undefined;
    this.ducks.clear();
    this.duckLevel = 1;
    this.sfxDucks.clear();
    this.sfxDuckLevel = 1;
    this.busMix.clear();
    this.push({ op: 'reset', stepIndex: this.stepOf() });
  }

  take(): AudioCommand[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** The deterministic state (digests, parity), or null while scripts never used audio. */
  state(): Record<string, unknown> | null {
    if (!this.used && this.voices.size === 0) return null;
    return {
      next: this.nextHandle,
      voices: [...this.voices.values()].map((v) => [v.handle, v.assetId, v.bus, v.loop, v.pitch, v.pos, rampValue(v.volume), v.stopping]),
      music: this.musicTrack === undefined ? '<flow>' : this.musicTrack,
      duck: this.duckLevel,
      // Only while effects are ducked (the digests of every earlier project stay as they were).
      ...(this.sfxDuckLevel !== 1 ? { sfxDuck: this.sfxDuckLevel } : {}),
      buses: [...this.busMix.entries()].map(([b, r]) => [b, rampValue(r)]),
    };
  }

  // ---- internals ------------------------------------------------------------

  private voice(handle: unknown): VoiceState | null {
    const h = typeof handle === 'number' ? handle : Number(handle);
    return Number.isInteger(h) && h > 0 ? (this.voices.get(h) ?? null) : null;
  }

  private steps(seconds: number): number {
    return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds * this.hz));
  }

  private push(c: AudioCommand): void {
    this.queue.push(Object.freeze(c));
    // Nobody takes them (a headless run): keep only the newest.
    if (this.queue.length > AUDIO_MAX_QUEUED_COMMANDS) this.queue.splice(0, this.queue.length - AUDIO_MAX_QUEUED_COMMANDS);
  }
}
