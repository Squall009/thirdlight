/**
 * The script API types (part one): messages, engine events, timers, spawning,
 * saves, debug commands, audio and effects.
 */

import type { DebugCommandArg } from './actions';

/** One message a script sent (`ctx.messages`). */
export interface BehaviorMessage {
  readonly name: string;
  /** The payload (a number, text or true/false), or null when none was sent. */
  readonly value: number | string | boolean | null;
  /** The entity whose script sent it. */
  readonly from: string;
  /** The step it was sent in (scripts see it in the next step). */
  readonly stepIndex: number;
}

/**
 * `ctx.messages` — named messages between scripts with an
 * optional value, to every script or to the scripts of one entity. Like
 * signals, a message sent in a step is seen in the next step (in send order);
 * at most `MAX_MESSAGES_PER_STEP` (256) are sent per step and a new run
 * clears them.
 */
export interface BehaviorMessages {
  /**
   * Send a message (name: 1–64 letters, digits or _ . : -) with an optional
   * value (a number, text of at most 256 characters or true/false) to every
   * script, or only to the scripts on entity `target`. `false` when it is
   * refused (a bad name or value, or the step's limit).
   * @graphNode Send message
   * @graphLabel name message
   * @graphLabel target to entity (empty: every script)
   */
  send(name: string, value?: number | string | boolean, target?: string): boolean;
  /**
   * The messages of that name sent in the previous step to every script or to this entity, in send order.
   * @graphPure
   * @graphNode Messages received
   * @graphLabel name message
   */
  received(name: string): readonly BehaviorMessage[];
}

/** The runtime side of `ctx.messages` (the behavior host fills in sender and receiver). */
export interface BehaviorMessageControl {
  send(from: string, name: unknown, value: unknown, target: unknown): boolean;
  received(to: string, name: unknown): readonly BehaviorMessage[];
  /** Every message sent in the previous step to every script or to `to`, in send order (`onMessage`). */
  all?(to: string): readonly BehaviorMessage[];
}

/**
 * One `ctx.events` entry for a trigger a script owns — the player
 * entered (`enter`) or left (`exit`) it in `stepIndex` (scripts see it in the
 * next step, like signals). A script owns the triggers on its own entity, on
 * the entity's descendants, and those named by its entityRef properties.
 */
export interface TriggerEventRecord {
  readonly type: 'enter' | 'exit';
  /** The trigger's entity id. */
  readonly trigger: string;
  readonly stepIndex: number;
}

/** A change of an object's health (seen in the step after it happened). */
export interface HealthEventRecord {
  readonly type: 'damaged' | 'healed' | 'died';
  /** The object whose health changed. */
  readonly entity: string;
  /** damaged/healed: how much it changed (died: 0). */
  readonly amount: number;
  /** Its health after the change. */
  readonly current: number;
  /** What caused it (an object id, or any text a script passed; '' when none). */
  readonly source: string;
  readonly stepIndex: number;
}

/** A hitbox began or stopped touching another hitbox or the character. */
export interface ContactEventRecord {
  readonly type: 'contact' | 'separate';
  /** This side (a hitbox's object, or the character). */
  readonly entity: string;
  /** The other side. */
  readonly other: string;
  /** Unit vector from this side toward the other at the contact ([0, 0, 0] on separate). */
  readonly normal: readonly [number, number, number];
  readonly stepIndex: number;
}

/** A patroller turned around (at a wall, a ledge, the end of its waypoints, or by a script). */
export interface PatrolEventRecord {
  readonly type: 'turned';
  readonly entity: string;
  readonly reason: 'wall' | 'ledge' | 'end' | 'script';
  /** The direction it walks in now (a unit vector). */
  readonly direction: readonly [number, number, number];
  readonly stepIndex: number;
}

/** A collectible was collected (by the character) or came back. */
export interface CollectEventRecord {
  readonly type: 'collected' | 'restored';
  readonly entity: string;
  readonly counter: string;
  /** collected: what it added (restored: 0). */
  readonly amount: number;
  /** collected: the object that collected it ('' on restored). */
  readonly by: string;
  readonly stepIndex: number;
}

export type PrimitiveEventRecord = HealthEventRecord | ContactEventRecord | PatrolEventRecord | CollectEventRecord;

/**
 * `ctx.timers` — named timers of one script instance, counted in
 * fixed steps (deterministic: `seconds × fixedStepHz` rounded, at least one
 * step). At most `MAX_TIMERS_PER_INSTANCE` (64) run per instance; a new run
 * (a restart) clears them.
 */
export interface BehaviorTimers {
  /**
   * Fire once, `seconds` from this step. Returns `false` (and changes
   * nothing) when a one-shot timer of that name and length is already
   * running — a script may call it every step; a different length restarts it.
   * @graphNode Start timer
   * @graphLabel name timer
   * @graphDefault seconds 1
   */
  after(name: string, seconds: number): boolean;
  /**
   * Fire every `seconds`, the first time `seconds` from this step. Returns
   * `false` (and changes nothing) when a repeating timer of that name and
   * period is already running.
   * @graphNode Start repeating timer
   * @graphLabel name timer
   * @graphDefault seconds 1
   */
  every(name: string, seconds: number): boolean;
  /**
   * True in the step the timer fires (in every phase of that step).
   * @graphPure
   * @graphNode Timer fired
   * @graphLabel name timer
   */
  fired(name: string): boolean;
  /**
   * Stop a timer; `false` when none of that name was running.
   * @graphNode Cancel timer
   * @graphLabel name timer
   */
  cancel(name: string): boolean;
}

/**
 * `ctx.spawn` / `ctx.destroy` in scripts. A spawn is requested
 * during a step and appears at the next step boundary (deterministic: in
 * request order); the id is returned at once. A new run removes every
 * spawned entity; saves never keep them.
 */
export interface BehaviorSpawnControl {
  /**
   * Copy the project prefab `prefabId` into the running game with its root at
   * `options.position` (`[x, y]` keeps the root's authored z, or `[x, y, z]`),
   * optional `rotation` (quaternion `[x, y, z, w]`) and `scale` (number or
   * `[x, y, z]`). Returns the new root id (`spawn-<n>`), or `null` when an
   * engine limit refuses it (`MAX_SPAWNS_PER_STEP` a step, `MAX_LIVE_SPAWNED` alive).
   * An unknown prefab or bad options throw.
   */
  spawn(prefabId: string, options: { position: readonly number[]; rotation?: readonly number[]; scale?: number | readonly number[] }): string | null;
  /**
   * Remove a spawned entity and its children at the next step boundary.
   * `false` when it is already gone (or queued). An authored entity throws:
   * hide it with `ctx.game.setVisible` instead.
   */
  destroy(entityId: string): boolean;
}

/** `ctx.save` — values a script keeps in the player's save (≤ 64 keys, ≤ 4 KB each as JSON). */
export interface BehaviorSave {
  /**
   * The value kept under `key` (undefined when there is none).
   * @graphPure
   * @graphNode Saved value
   */
  get(key: string): unknown;
  /**
   * Keep a value under `key`; `false` when it does not fit (a bad key, 64 keys, 4 KB).
   * @graphNode Save value
   */
  set(key: string, value: unknown): boolean;
  /**
   * Forget the value under `key`.
   * @graphNode Remove saved value
   */
  remove(key: string): void;
  /**
   * The keys of the kept values.
   * @graphPure
   * @graphNode Saved keys
   */
  keys(): string[];
}

/** The type of a debug command argument. */
export type DebugCommandArgType = 'number' | 'string' | 'boolean';

/** One declared argument of a debug command. */
export interface DebugCommandArgSpec {
  /** The argument's name (a letter or _, then letters, digits, _ . : -). */
  readonly name: string;
  readonly type: DebugCommandArgType;
  /** May be left out of a call (a call without it has no such key). */
  readonly optional?: boolean;
}

/** How a script declares a debug command (`ctx.debug.command(name, options)`). */
export interface DebugCommandOptions {
  /** One line the console and tools show (at most 120 characters). */
  readonly description?: string;
  /** The arguments in order (at most 8; the console also takes them by position). */
  readonly args?: readonly DebugCommandArgSpec[];
}

/** A registered debug command, as the console and tools list it. */
export interface DebugCommandSpec {
  readonly name: string;
  readonly description: string;
  readonly args: readonly DebugCommandArgSpec[];
}

/** The arguments of one debug command call. */
export type DebugCommandArgs = Readonly<Record<string, DebugCommandArg>>;

/**
 * The registered debug commands and the calls the game ran (the
 * newest last, at most 16): what a playtest needs to reproduce a run (each
 * call is an input-frame entry at its step).
 */
export interface DebugCommandState {
  /** The engine's own (`signal`) first, then those scripts declared. */
  readonly registered: readonly DebugCommandSpec[];
  readonly applied: readonly { readonly stepIndex: number; readonly name: string; readonly args: DebugCommandArgs }[];
  /** Bumped whenever `registered` or `applied` changes. */
  readonly revision: number;
}

/**
 * `ctx.debug` — project debug commands (a test or debug tool, the
 * in-game console and `tl_game_control` run them). A command runs inside the
 * simulation step as part of the step's input, so a recording replays it.
 */
export interface BehaviorDebug {
  /**
   * Declare the debug command `name` (the first declaration fixes its
   * arguments; calling it again every step is how a script listens) and get
   * the calls made to it in this step — in the `intent` phase; the other
   * phases see none. With `handler`, it also runs once per call, right here.
   * Every script instance that declares the command receives each call.
   * Engine limits: 32 commands per game; a second declaration with other
   * arguments throws.
   * @graphNode skip a debug command is declared in code (typed arguments, an optional handler)
   */
  command(name: string, options?: DebugCommandOptions, handler?: (args: DebugCommandArgs) => void): readonly DebugCommandArgs[];
}

/** A script sound's end (`ctx.audio.events()`), seen in the step after it happened. */
export interface AudioFinishedEvent {
  readonly kind: 'finished';
  readonly handle: number;
  readonly assetId: string;
  /** `ended`: it played to its end; `stopped`: a script stopped it (after its fade). */
  readonly reason: 'ended' | 'stopped';
}

/** Options of `ctx.audio.play`. */
export interface AudioPlayOptions {
  /** 0–1 (1). */
  volume?: number;
  /** Loop until stopped (false). */
  loop?: boolean;
  /** Playback rate, 0.25–4 (1: as recorded; 2: an octave up and twice as fast). */
  pitch?: number;
  /** The bus (sfx). */
  bus?: 'sfx' | 'music' | 'voice' | 'ui';
  /** Seconds to fade in from silence (0). */
  fadeIn?: number;
  /** Positional: follow this entity (`position` is then an offset from it). */
  entityId?: string;
  /** Positional: world position in metres (or the offset from `entityId`). */
  position?: readonly number[];
  /** Positional: linear, inverse or exponential (linear). */
  distanceModel?: 'linear' | 'inverse' | 'exponential';
  /** Positional: full volume within this distance, m (2). */
  refDistance?: number;
  /** Positional: silent (linear) or no more fading (others) beyond this distance, m (30). */
  maxDistance?: number;
  /** Positional: how fast it fades (1). */
  rolloff?: number;
  /**
   * How late it may still start, in ms (500): a sound whose file is not
   * ready when it is played starts when it is, unless that is later than
   * this; then it is dropped (the audio observation says which happened).
   * 0: now or never. The simulation's timing never waits for it.
   */
  maxLateMs?: number;
}

/** Options of `ctx.audio.stinger`. */
export interface AudioStingerOptions {
  /** 0–1 (1). */
  volume?: number;
  /** The music's level under it, 0–1 (0.3). */
  duck?: number;
  /** Seconds to duck and to come back (0.25). */
  fade?: number;
  /** How late it may still start, in ms (500; see `AudioPlayOptions.maxLateMs`). */
  maxLateMs?: number;
}

/** A script's view of the music (`ctx.audio.musicState()`). */
export interface AudioMusicState {
  /** Who picks the track: the scripts (after `music`), or the host (`flow`: the engine has no level flow, so nothing plays then). */
  readonly owner: 'script' | 'flow';
  /** The scripts' track (null: silence, or the host owns it). */
  readonly track: string | null;
  /** The music duck now (1 = not ducked). */
  readonly duck: number;
}

/**
 * `ctx.audio`. Playback handles, music control and
 * positional sound — what scripts ask for is simulation state (handles,
 * volumes, fades, finished events replay identically); the page's audio
 * engine plays it.
 */
export interface BehaviorAudio {
  /**
   * Play an audio asset of any length (volume 0–1). Returns its handle (0 when refused: a bad id, more than 32 plays in one step or 64 sounds alive). Options: `loop`, `pitch` (playback rate 0.25–4), `bus` (sfx, music, voice, ui), `fadeIn` seconds; positional with `entityId` (it follows the entity) and/or `position` (world metres, or the offset from the entity), fading by `distanceModel` (linear, inverse, exponential), `refDistance` (2 m), `maxDistance` (30 m) and `rolloff` (1); `maxLateMs` (500): a sound whose file is not ready yet starts when it is, or is dropped once it would start later than this.
   * @graphNode Play sound
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   * @graphDefault volume 1
   */
  play(assetId: string, options?: AudioPlayOptions): number;
  /**
   * Stop a sound, fading out over `fadeSeconds` (0: now). Its finished event (reason "stopped") arrives in the step after the fade ends.
   * @graphNode Stop sound
   * @graphDefault fadeSeconds 0
   */
  stop(handle: number, fadeSeconds?: number): void;
  /**
   * Fade a sound's volume to `to` (0–1) over `seconds` (linear, whole steps).
   * @graphNode Fade sound
   * @graphDefault to 0
   * @graphDefault seconds 1
   */
  fade(handle: number, to: number, seconds: number): void;
  /**
   * Set a sound's volume (0–1) now.
   * @graphNode Set sound volume
   * @graphDefault volume 1
   */
  setVolume(handle: number, volume: number): void;
  /**
   * Set a sound's pitch — its playback rate, 0.25–4 (1: as recorded; it plays faster or slower too).
   * @graphNode Set sound pitch
   * @graphDefault pitch 1
   */
  setPitch(handle: number, pitch: number): void;
  /**
   * Loop a sound or let it end at the end of its clip.
   * @graphNode Set sound loop
   */
  setLoop(handle: number, loop: boolean): void;
  /**
   * Whether a sound is still playing (its finished event has not happened).
   * @graphNode Sound playing
   * @graphPure
   */
  playing(handle: number): boolean;
  /**
   * A sound's volume now (its fade included; 0 when it is not playing).
   * @graphNode Sound volume
   * @graphPure
   */
  volumeOf(handle: number): number;
  /**
   * True in the step after a sound finished (it ended or was stopped).
   * @graphNode Sound finished
   * @graphPure
   */
  finished(handle: number): boolean;
  /**
   * The sounds that finished in the previous step (handle, asset, reason "ended" or "stopped").
   * @graphNode skip a list of records; the Sound finished node checks one handle
   */
  events(): readonly AudioFinishedEvent[];
  /**
   * Play an audio asset as the music track (looped), crossfading over `fadeSeconds` (1); null fades to silence. The scripts then own the music until `releaseMusic`.
   * @graphNode Set music
   * @graphLabel assetId track
   * @graphAsset assetId audio
   * @graphDefault fadeSeconds 1
   */
  music(assetId: string | null, fadeSeconds?: number): void;
  /**
   * Give the music back to the host (silence: the engine has no level-flow music), crossfading over `fadeSeconds` (1).
   * @graphNode Release music
   * @graphDefault fadeSeconds 1
   */
  releaseMusic(fadeSeconds?: number): void;
  /**
   * Play a stinger (a short musical phrase) once over the music: the track ducks to `duck` (0.3) while it plays and comes back after it, both over `fade` seconds (0.25). Returns its handle.
   * @graphNode Play stinger
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   */
  stinger(assetId: string, options?: AudioStingerOptions): number;
  /**
   * Duck the music to `level` (0–1; 0.3) over `seconds` (0.25) until `unduck`. The deepest duck alive wins (a stinger's, dialogue voice's).
   * @graphNode Duck music
   * @graphDefault level 0.3
   * @graphDefault seconds 0.25
   */
  duck(level: number, seconds?: number): void;
  /**
   * End the script's music duck over `seconds` (0.25).
   * @graphNode Unduck music
   * @graphDefault seconds 0.25
   */
  unduck(seconds?: number): void;
  /**
   * Who picks the music (the scripts or the host), the scripts' track and the duck now.
   * @graphNode Music state
   * @graphPure
   */
  musicState(): AudioMusicState;
  /**
   * Mix a bus (sfx, music, voice, ui) to `volume` (0–1) over `seconds` (0), on top of the player's volume setting.
   * @graphNode Set bus volume
   * @graphDefault volume 1
   * @graphDefault seconds 0
   */
  setBusVolume(bus: 'sfx' | 'music' | 'voice' | 'ui', volume: number, seconds?: number): void;
  /**
   * The scripts' mix of a bus now (1 unless set).
   * @graphNode Bus volume
   * @graphPure
   */
  busVolume(bus: 'sfx' | 'music' | 'voice' | 'ui'): number;
}

/**
 * One request to the renderer's effect player (`ctx.effects`,
 * the `effect` component's signals, gameplay hooks). Presentation only:
 * requests are recorded in step order and taken by the adapter; nothing in
 * the simulation reads them back (replays do not depend on effects).
 */
export interface EffectRequest {
  readonly op: 'play' | 'stop';
  /** play: the project effect; stop by entity: '' . */
  readonly effectId: string;
  /** play: the new play's handle (> 0); stop: the handle stopped (0 = every play on `entityId`). */
  readonly handle: number;
  /** The entity it plays on (it follows the entity), or null (at `position` in world space). */
  readonly entityId: string | null;
  /** World position (no entity), or the offset from the entity (metres). */
  readonly position: readonly [number, number, number];
  /** Overrides of the effect's public parameters (null = none). */
  readonly params: Readonly<Record<string, number | readonly number[] | string>> | null;
  /** What asked: a script, or the entity's `effect` component (its signal). The character controller's gameplay hooks were deleted. */
  readonly source: 'script' | 'component';
  /** The step it was asked in (1-based like the step being simulated). */
  readonly stepIndex: number;
}

/** `ctx.effects` — play visual effects (presentation only, never part of the simulation). */
export interface BehaviorEffects {
  /**
   * Play a project effect (particles) once: on `entityId` (it follows the object; `position` is then an offset from it) or, without one, at `position` in world metres. `params` override its public parameters. Returns a handle for `stop`, or 0 when refused (a bad id, more than 32 plays in one step).
   * @graphNode Play effect
   * @graphLabel effectId effect
   */
  play(effectId: string, options?: { position?: readonly number[]; entityId?: string; params?: Readonly<Record<string, number | readonly number[] | string>> }): number;
  /**
   * Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lifetimes.
   * @graphNode Stop effect
   */
  stop(target: number | string): void;
}