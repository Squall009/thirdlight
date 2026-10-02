/**
 * The script API types (part two): cameras, UI, environment, dialogue, game
 * modes, lifecycle, timelines, sockets, signals, game state, the generic
 * primitives, animators and tag queries.
 */

import { type HealthEventRecord } from './types-behavior';

/** A blend a script names for the camera change it makes (absent: the camera's own). */
export interface CameraBlendOptions {
  /** `cut`, `linear` or `eased`. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds (0–30). */
  time?: number;
}

/** A virtual camera's live rig values (`ctx.camera.get`). */
export interface BehaviorCameraState {
  readonly rig: 'follow' | 'orbitPoint' | 'topDown' | 'fixed' | 'rail';
  readonly enabled: boolean;
  readonly priority: number;
  /** It is the live camera. */
  readonly live: boolean;
  /** The target entity ('' for none). */
  readonly target: string;
  readonly distance: number;
  /** Degrees (a snapped rig: the step it turns to). */
  readonly yaw: number;
  readonly pitch: number;
  /** A rail camera's place along its path (0–1). */
  readonly progress: number;
  readonly railSpeed: number;
  readonly fovY: number;
  readonly letterbox: number;
}

/** One UI event of this step (from the input frame). */
export interface BehaviorUiEvent {
  /** click (a button's event action), submit (an input), focus (the focus moved to `widget`), custom, show, hide, toggle; mode (a mode action: `value` is the mode), restart (the engine's restart), scene (the game shell's move along its scene list: `value` is the entry). */
  readonly kind: 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene';
  /** The UI document it happened in. */
  readonly doc: string;
  /** The widget ('' for none). */
  readonly widget: string;
  /** The event name ('' for focus, show, hide). */
  readonly name: string;
  /** The value the action carried (or the submitted text). */
  readonly value?: number | string | boolean | null;
  /** The list item it came from. */
  readonly index?: number;
}

/**
 * `ctx.ui` — the project UI. Scripts publish view-model values
 * that UI documents bind to (`{ "bind": "hud.hp" }`, `{hud.hp}` in a text),
 * show and hide documents, and read the UI events of the step (clicks,
 * submits, focus changes: part of the input frame, so replays hold). The
 * game host draws the documents; the view model and the shown documents are
 * simulation state.
 */
/** How a change to an environment preset happens (`ctx.environment.set`). */
export interface EnvironmentChangeOptions {
  /** Seconds the blend takes (0–600; 0 or absent: at once). */
  blend?: number;
  /** How the blend progresses. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  /** Per-field changes over the preset: { sky?, fog?, post?, lights?, lightmap? }, each merged over the preset's (a light list adds entries). */
  override?: { readonly [part: string]: unknown };
}

/**
 * `ctx.environment` — switch or blend the look (sky, fog,
 * light colours and intensities, exposure and grading) between the project's
 * environment presets at run time. `''` names the base look (the project
 * environment with the level's look). The blend is simulation state: it
 * replays, runs alike in the simulation worker and can be saved.
 */
export interface BehaviorEnvironment {
  /**
   * Switch to a preset ('' = the base look), blending over `blend` seconds from the look now (an interrupted blend continues from where it is). False when there is no such preset or an option is refused.
   * @graphNode Set environment
   * @graphLabel presetId preset
   * @graphLabel blend blend (seconds)
   */
  set(presetId: string, options?: EnvironmentChangeOptions): boolean;
  /**
   * Hold a mix of two presets: t = 0 shows a, 1 shows b (a timeline or a script drives t; '' = the base look). Stops a running blend.
   * @graphNode Blend environments
   * @graphDefault t 0.5
   */
  blend(a: string, b: string, t: number): boolean;
  /**
   * The preset the last change went to ('' = the base look), how far its blend is (0–1) and whether one is running.
   * @graphPure
   * @graphNode Environment state
   */
  state(): { target: string; progress: number; blending: boolean };
  /**
   * How much of a preset is in the look now (0–1; '' = the base look).
   * @graphPure
   * @graphNode Environment weight
   * @graphLabel presetId preset
   */
  weight(presetId: string): number;
  /**
   * The project's environment preset ids.
   * @graphPure
   * @graphNode Environment presets
   */
  presets(): readonly string[];
}

export interface BehaviorUi {
  /**
   * Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
   * @graphNode Set UI value
   */
  set(path: string, value: unknown): boolean;
  /**
   * The published value at a path (null when there is none).
   * @graphPure
   * @graphNode UI value
   */
  get(path: string): unknown;
  /**
   * Remove a path from the view model (`false` when it was not there).
   * @graphNode Clear UI value
   */
  clear(path: string): boolean;
  /**
   * Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
   * @graphNode Show UI
   * @graphLabel docId document
   */
  show(docId: string, options?: { layer?: number; modal?: boolean }): boolean;
  /**
   * Hide a shown UI document (`false` when it was not shown).
   * @graphNode Hide UI
   * @graphLabel docId document
   */
  hide(docId: string): boolean;
  /**
   * The document is shown.
   * @graphPure
   * @graphNode UI shown
   * @graphLabel docId document
   */
  isShown(docId: string): boolean;
  /**
   * Play a tween of a document (on a widget, or the whole document). Presentation only.
   * @graphNode Play UI tween
   * @graphLabel docId document
   */
  play(docId: string, tween: string, widgetId?: string): boolean;
  /**
   * Move the keyboard/gamepad focus to a widget of a shown document.
   * @graphNode Focus UI widget
   * @graphLabel docId document
   * @graphLabel widgetId widget
   */
  focus(docId: string, widgetId: string): boolean;
  /**
   * The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
   * @graphPure
   * @graphNode UI events
   */
  events(): readonly BehaviorUiEvent[];
  /**
   * The first UI event of this step with this name (a button's or an input's event), or null.
   * @graphPure
   * @graphNode UI event
   */
  event(name: string): BehaviorUiEvent | null;
}

/** A value of a dialogue variable or binding. */
export type DialogueVariableValue = number | string | boolean | null;

/** One dialogue event (seen by scripts in the step after it happened). */
export interface BehaviorDialogueEvent {
  /** start, lineStart, lineEnd, choice (options shown), chosen, signal, end. */
  readonly kind: 'start' | 'lineStart' | 'lineEnd' | 'choice' | 'chosen' | 'signal' | 'end';
  /** The conversation (the number `start` returned). */
  readonly conversation: number;
  readonly dialogueId: string;
  /** The node (a line, a choice, a signal; '' for start/end). */
  readonly nodeId: string;
  /** lineStart: the speaker id ('' for narration). */
  readonly speaker: string;
  /** lineStart: the line as shown (rich text); chosen: the option's text. */
  readonly text: string;
  /** signal: its name; end: why (end, stopped, loop). */
  readonly name: string;
  /** signal: its value. */
  readonly value: string;
  /** chosen: the option's index among those shown; else -1. */
  readonly index: number;
}

/** The conversation now. */
export interface BehaviorDialogueState {
  readonly conversation: number;
  readonly dialogueId: string;
  readonly nodeId: string;
  /** line, choice, signal (waiting for resume), wait. */
  readonly kind: 'line' | 'choice' | 'signal' | 'wait';
  readonly speaker: string;
  /** The line as shown (rich text; '' when not on a line). */
  readonly text: string;
  /** Visible characters of the line so far, and in all. */
  readonly revealed: number;
  readonly total: number;
  /** The options shown, in order (a choice), as their texts. */
  readonly options: readonly string[];
}

/** One line (or a chosen option) in the backlog. */
export interface BehaviorDialogueHistoryEntry {
  readonly dialogueId: string;
  readonly nodeId: string;
  readonly speaker: string;
  /** The speaker's display name ('' for narration or a chosen option). */
  readonly name: string;
  readonly text: string;
  /** A line, or the option the player picked. */
  readonly choice: boolean;
}

/**
 * `ctx.dialogue` — conversations (dialogue graphs of the
 * project). A script starts one; the engine runs it in the simulation (the
 * typewriter reveal, voice clips on the voice bus with music and effects
 * ducked, auto-advance, skip-if-seen, choices, conditions and effects on the
 * dialogue variables) and shows it in the dialogue UI document. Player input
 * (advance, choose, skip, auto, backlog) arrives as input-frame entries, so
 * replays hold. Calls take effect at the end of the step; events are seen in
 * the next step.
 */
export interface BehaviorDialogue {
  /**
   * Start a conversation (at its Start, a named entry, or any node); bindings are values its lines and conditions read as $name. Returns the conversation number, or 0 (unknown dialogue, entry or node, or one is running).
   * @graphNode Start dialogue
   * @graphLabel dialogueId dialogue
   */
  start(dialogueId: string, options?: { entry?: string; node?: string; bindings?: Readonly<Record<string, DialogueVariableValue>> }): number;
  /**
   * End the running conversation.
   * @graphNode Stop dialogue
   */
  stop(): boolean;
  /**
   * A conversation is running (this one, when given).
   * @graphPure
   * @graphNode Dialogue running
   */
  isRunning(conversation?: number): boolean;
  /**
   * The conversation now (null when none).
   * @graphPure
   * @graphNode Dialogue state
   */
  current(): BehaviorDialogueState | null;
  /**
   * Advance: reveal the rest of the line, or go on after it.
   * @graphNode Advance dialogue
   */
  advance(): boolean;
  /**
   * Pick an option of the choice shown (0 = the first shown).
   * @graphNode Choose option
   */
  choose(index: number): boolean;
  /**
   * Continue after a Signal node that waits.
   * @graphNode Resume dialogue
   */
  resume(): boolean;
  /**
   * Skip lines already seen (until an unseen line or a choice).
   * @graphNode Set dialogue skip
   */
  setSkip(on: boolean): void;
  /**
   * The player's auto-advance (null: the project's setting).
   * @graphNode Set dialogue auto
   */
  setAuto(on: boolean | null): void;
  /**
   * The player's text speed in characters per second (0: whole lines at once; null: the project's setting).
   * @graphNode Set text speed
   */
  setTextSpeed(charsPerSecond: number | null): void;
  /**
   * The dialogue events of the previous step (line starts and ends, choices, picks, signals, starts and ends), in order.
   * @graphPure
   * @graphNode Dialogue events
   */
  events(): readonly BehaviorDialogueEvent[];
  /**
   * The first dialogue event of the previous step of this kind (and signal name), or null.
   * @graphPure
   * @graphNode Dialogue event
   */
  event(kind: 'start' | 'lineStart' | 'lineEnd' | 'choice' | 'chosen' | 'signal' | 'end', name?: string): BehaviorDialogueEvent | null;
  /**
   * A dialogue variable (null when unset).
   * @graphPure
   * @graphNode Dialogue variable
   */
  get(name: string): DialogueVariableValue;
  /**
   * Set a dialogue variable (conditions and effects read and write them); false for a bad name or value.
   * @graphNode Set dialogue variable
   */
  set(name: string, value: DialogueVariableValue): boolean;
  /**
   * Every dialogue variable.
   * @graphNode skip a map of values; use Dialogue variable
   */
  variables(): Readonly<Record<string, DialogueVariableValue>>;
  /**
   * The line (or option) was seen: "dialogueId/nodeId".
   * @graphPure
   * @graphNode Line seen
   */
  seen(key: string): boolean;
  /**
   * The backlog: the lines shown and options picked, oldest first.
   * @graphNode skip a list of records; UI documents bind dialogue.backlog
   */
  history(): readonly BehaviorDialogueHistoryEntry[];
}

/** One enter or exit of a game mode switch (`ctx.modes.events()`). */
export interface BehaviorModeEvent {
  /** enter (the mode became current) or exit (it ended). */
  readonly kind: 'enter' | 'exit';
  /** The mode entered or left. */
  readonly mode: string;
  /** The mode on the other side of the switch ('' at a run start). */
  readonly other: string;
}

/** How a switch looks (absent fields: the target mode's own transition, then the camera's blend). */
export interface BehaviorModeTransition {
  /** The camera blend into the mode's camera: cut, linear or eased. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds of the camera blend (0–30). */
  blendTime?: number;
  /** A UI document shown from the switch for `fadeTime` seconds (its show/hide tweens make the fade). */
  fade?: string;
  /** Seconds the fade document stays (0.05–10; default 0.5). */
  fadeTime?: number;
}

/**
 * `ctx.modes` — the project's game modes. A mode decides the
 * active input maps, the live camera, the UI documents shown and the behavior
 * groups that tick; a switch changes them together in one step, without a
 * scene load. `switch` applies at the next step boundary; the enter/exit
 * events are read in the step the switch applied (intent phase), like UI
 * events. A game without modes answers '' / false.
 */
export interface BehaviorModes {
  /**
   * The current game mode ('' when the project has none).
   * @graphPure
   * @graphNode Current mode
   */
  current(): string;
  /**
   * The mode before the current one ('' at the start of a run).
   * @graphPure
   * @graphNode Previous mode
   */
  previous(): string;
  /**
   * The current mode is this one.
   * @graphPure
   * @graphNode Mode is
   * @graphLabel modeId mode
   */
  is(modeId: string): boolean;
  /**
   * Switch to a game mode at the next step (its input maps, camera, UI documents and ticking groups together; no scene load). `false` for a mode the project does not have or a bad transition.
   * @graphNode Switch mode
   * @graphLabel modeId mode
   */
  switch(modeId: string, transition?: BehaviorModeTransition): boolean;
  /**
   * This step's enter and exit events (the step a switch applied in), in order.
   * @graphPure
   * @graphNode Mode events
   */
  events(): readonly BehaviorModeEvent[];
  /**
   * A mode was entered this step (this one, or any when empty).
   * @graphPure
   * @graphNode Mode entered
   * @graphLabel modeId mode
   */
  entered(modeId?: string): boolean;
  /**
   * A mode ended this step (this one, or any when empty).
   * @graphPure
   * @graphNode Mode exited
   * @graphLabel modeId mode
   */
  exited(modeId?: string): boolean;
  /**
   * Seconds since the current mode was entered.
   * @graphPure
   * @graphNode Time in mode
   */
  time(): number;
}

/**
 * `ctx.lifecycle` — the engine's run lifecycle: respawn the
 * character at a player spawn and restart the run. Winning, losing and what a
 * death means are the game's own rules (scripts); this is only the mechanism. It
 * works on the 2D plane too (the character controller session that owned it is gone).
 */
export interface BehaviorLifecycle {
  /**
   * Move the character (the controller's object) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). In 3D applied after this step's intent phase (a later phase: the next step); on the 2D plane at the next step boundary. `false` without a character or for an unknown spawn.
   * @graphNode Respawn player
   * @graphLabel spawnId spawn
   */
  respawn(spawnId?: string): boolean;
  /**
   * Make a player spawn (an object with the Player spawn component) the one respawn uses.
   * @graphNode Set spawn point
   * @graphLabel spawnId spawn
   */
  setSpawn(spawnId: string): boolean;
  /**
   * The active player spawn ('' when there is none: respawn then uses where the player started).
   * @graphPure
   * @graphNode Spawn point
   */
  spawnPoint(): string;
  /**
   * Restart the run at the next step: scenes, objects, scripts, cameras, UI and the start mode as at the start.
   * @graphNode Restart run
   */
  restart(): boolean;
}

/** One timeline event (seen in the step after it happened). */
export interface BehaviorTimelineEvent {
  /** started, ended or marker (a marker of the timeline was reached). */
  readonly kind: 'started' | 'ended' | 'marker';
  readonly handle: number;
  /** The timeline's id. */
  readonly timeline: string;
  /** marker: its name ('' otherwise). */
  readonly name: string;
  /** ended: finished, skipped or stopped ('' otherwise). */
  readonly reason: '' | 'finished' | 'skipped' | 'stopped';
  readonly stepIndex: number;
}

/**
 * `ctx.timeline` — play project timelines (sequences of camera
 * cuts, moves, animation, sound, dialogue, effects, signals, fades) as an
 * engine system in the simulation step. Calls take effect at the end of the
 * step; events (started, ended, marker) are seen in the next step, so a
 * script never waits: it reacts to the events or to the timeline's signals.
 */
export interface BehaviorTimeline {
  /**
   * Play a timeline, binding its slots to objects (`{ slot: entityId }`; unbound slots use the timeline's defaults). Returns its handle (0 when refused: no such timeline, or 8 already playing).
   * @graphNode Play timeline
   * @graphLabel timelineId timeline
   */
  play(timelineId: string, bindings?: Readonly<Record<string, string>>): number;
  /**
   * Pause a playing timeline (it holds its current state).
   * @graphNode Pause timeline
   */
  pause(handle: number): boolean;
  /**
   * Resume a paused timeline.
   * @graphNode Resume timeline
   */
  resume(handle: number): boolean;
  /**
   * Stop a timeline where it is (no end states: the sounds and effects it started stop, the cameras go back).
   * @graphNode Stop timeline
   */
  stop(handle: number): boolean;
  /**
   * Skip to the end: every track's end state at once (cameras, transforms, music, activation; remaining signals fire unless a key says drop).
   * @graphNode Skip timeline
   */
  skip(handle: number): boolean;
  /**
   * Jump to a time (seconds): the moves, fades and cameras there; keys in between do not fire.
   * @graphNode Seek timeline
   * @graphDefault seconds 0
   */
  seek(handle: number, seconds: number): boolean;
  /**
   * A play's state: playing, paused, waiting (for input or a dialogue), ended (recently), or null.
   * @graphPure
   * @graphNode Timeline state
   */
  state(handle: number): 'playing' | 'paused' | 'waiting' | 'ended' | null;
  /**
   * A play's time in seconds (counted in fixed steps).
   * @graphPure
   * @graphNode Timeline time
   */
  time(handle: number): number;
  /**
   * Whether any play of this timeline is running.
   * @graphPure
   * @graphNode Timeline playing
   * @graphLabel timelineId timeline
   */
  isPlaying(timelineId: string): boolean;
  /**
   * The timeline events of the previous step (started, ended, marker), in order.
   * @graphNode skip a list of records; the Timeline ended and Timeline marker nodes check one
   */
  events(): readonly BehaviorTimelineEvent[];
  /**
   * True in the step after a play ended (finished, skipped or stopped).
   * @graphPure
   * @graphNode Timeline ended
   */
  ended(handle: number): boolean;
  /**
   * True in the step after a marker with this name was reached (of the play `handle`, or of any play when 0).
   * @graphPure
   * @graphNode Timeline marker
   * @graphDefault handle 0
   */
  marker(name: string, handle?: number): boolean;
}

/**
 * `ctx.camera` — the virtual cameras (the `virtualCamera`
 * component): which is live, their rig values, shake and screen↔world
 * projection. Changes take effect at the end of the step (the camera brain
 * resolves the live camera after every script has run); reads and the
 * projection use the camera as resolved at the end of the previous step.
 * The projection uses normalized screen coordinates — x 0 (left) to 1
 * (right), y 0 (top) to 1 (bottom) — and the viewport aspect the host
 * reports.
 */
export interface BehaviorCamera {
  /**
   * Enable a virtual camera and bring it in front of the cameras of its priority (it goes live unless a higher priority is enabled). `false` when there is no such camera.
   * @graphNode Activate camera
   * @graphLabel cameraId camera
   */
  activate(cameraId: string, options?: CameraBlendOptions): boolean;
  /**
   * Disable a virtual camera (the view blends to the next one, or back to the scene camera).
   * @graphNode Deactivate camera
   * @graphLabel cameraId camera
   */
  deactivate(cameraId: string, options?: CameraBlendOptions): boolean;
  /**
   * Set a camera's priority (−1000–1000; the enabled camera with the highest is live).
   * @graphNode Set camera priority
   * @graphLabel cameraId camera
   */
  setPriority(cameraId: string, priority: number): boolean;
  /**
   * Point a camera at another target entity ('' for none).
   * @graphNode Set camera target
   * @graphLabel cameraId camera
   * @graphLabel entityId target
   */
  setTarget(cameraId: string, entityId: string): boolean;
  /**
   * Set a camera's rig values (each optional): distance, yaw, pitch (kept within its pitch limits), progress and railSpeed of a rail camera, field of view, letterbox, the orbit point, the target offset.
   * @graphNode Set camera rig
   * @graphLabel cameraId camera
   */
  set(
    cameraId: string,
    params: {
      distance?: number;
      yaw?: number;
      pitch?: number;
      progress?: number;
      railSpeed?: number;
      fovY?: number;
      letterbox?: number;
      point?: readonly number[];
      targetOffset?: readonly number[];
    },
  ): boolean;
  /**
   * Turn a camera by whole steps (an orbit-a-point camera: its turn step; positive turns left).
   * @graphNode Turn camera
   * @graphLabel cameraId camera
   * @graphDefault steps 1
   */
  turn(cameraId: string, steps: number): boolean;
  /**
   * Shake the view: up to `amplitude` metres (and `rotation` degrees), `frequency` times a second (default 8), fading out over `seconds`. Seeded: the same run shakes the same way (`seed` picks another pattern).
   * @graphNode Shake camera
   * @graphDefault amplitude 0.2
   * @graphDefault seconds 0.5
   * @graphDefault frequency 8
   * @graphDefault rotation 0
   * @graphDefault seed 0
   */
  shake(amplitude: number, seconds: number, frequency?: number, rotation?: number, seed?: number): void;
  /**
   * The live virtual camera, or null while the scene camera shows its own view.
   * @graphPure
   * @graphNode Live camera
   */
  live(): string | null;
  /**
   * A blend between two cameras is in progress.
   * @graphPure
   * @graphNode Camera blending
   */
  blending(): boolean;
  /**
   * A virtual camera's live rig values, or null when there is no such camera.
   * @graphPure
   * @graphNode Camera state
   * @graphLabel cameraId camera
   */
  get(cameraId: string): BehaviorCameraState | null;
  /**
   * Where a world point appears on screen (x, y 0–1 from the top left), how far in front of the camera it is, and whether it is in view.
   * @graphPure
   * @graphNode World to screen
   */
  worldToScreen(position: readonly number[]): { x: number; y: number; depth: number; onScreen: boolean };
  /**
   * The ray from the camera through a screen point (x, y 0–1 from the top left): its origin and unit direction.
   * @graphPure
   * @graphNode Screen to ray
   * @graphDefault x 0.5
   * @graphDefault y 0.5
   */
  screenToRay(x: number, y: number): { origin: readonly [number, number, number]; direction: readonly [number, number, number] };
}

/**
 * `ctx.sockets` — objects riding on named nodes (bones or any
 * node) of other objects' models. The simulation places an attached object
 * at the end of every step, after the animators, so it follows the target's
 * animation in Play, the worker and the export alike.
 */
export interface BehaviorSockets {
  /**
   * Attach an object to a node of the target's model, with an optional offset in the node's space (position [x, y, z], rotation quaternion [x, y, z, w], scale [x, y, z]). Without a target the object's own Socket component is used. False (and a warning in the play log) when refused: an unknown object, target or node, a loop, or a physics body or the scene camera.
   * @graphNode Attach to socket
   * @graphLabel entityId object
   * @graphLabel targetId target
   * @graphLabel node node
   */
  attach(entityId: string, targetId?: string, node?: string, position?: readonly number[], rotation?: readonly number[], scale?: readonly number[]): boolean;
  /**
   * Detach an object from its socket: it stays where the node left it (keepWorld, the default) or snaps back to its transform from before the attach. False when it was not attached.
   * @graphNode Detach from socket
   * @graphLabel entityId object
   * @graphDefault keepWorld true
   */
  detach(entityId: string, keepWorld?: boolean): boolean;
  /**
   * The socket an object rides on (the target object and the node's name), or null.
   * @graphPure
   * @graphNode Socket of
   * @graphLabel entityId object
   */
  attachedTo(entityId: string): { readonly target: string; readonly nodeName: string } | null;
  /**
   * A node's world position and rotation now (the target's model posed by its animator), or null when the target, its model or the node is missing — e.g. where a muzzle or a hand is.
   * @graphPure
   * @graphNode Node pose
   * @graphLabel targetId target
   * @graphLabel node node
   */
  nodePose(targetId: string, node: string): { readonly position: readonly [number, number, number]; readonly rotation: readonly [number, number, number, number] } | null;
}

/** `ctx.signals`. */
export interface BehaviorSignals {
  /**
   * Send a named signal; switches, doors and scripts see it in the next step.
   * @graphNode Emit signal
   * @graphLabel name signal
   */
  emit(name: string): void;
  /**
   * Emitted in the previous step (by a switch, a trigger or a script).
   * @graphPure
   * @graphNode Signal received
   * @graphLabel name signal
   */
  on(name: string): boolean;
}

/** `ctx.game`. */
export interface BehaviorGameState {
  /**
   * The current value of one of the run's counters (0 when it was never added to).
   * @graphPure
   * @graphNode Counter value
   * @graphLabel name counter
   */
  counter(name: string): number;
  /**
   * Add to one of the run's named counters; HUD documents read them (`$flow.counters.<name>`).
   * A name is a letter or _, then up to 31 letters, digits or _ (what a save keeps): any other
   * name is refused (false, one Problems line) and no counter changes.
   * @graphNode Add to counter
   * @graphLabel name counter
   * @graphDefault amount 1
   */
  add(name: string, amount: number): boolean;
  /**
   * The character's health (the controller's object), or null when it has none.
   * @graphPure
   * @graphNode Player health
   */
  health(): { current: number; max: number } | null;
  /**
   * Show or hide an entity (and its children) until the next run; it still collides and triggers.
   * @graphNode Set visible
   * @graphDefault visible true
   */
  setVisible(entityId: string, visible: boolean): void;
}

/**
 * `ctx.health` — the health of any object with a Health
 * component. Changes apply at once (a later `get` in the same step sees them);
 * each is an event (`damaged`, `healed`, and `died` when it reaches 0) that
 * scripts owning the object read in the next step's `ctx.events` (all of them:
 * `events()`). What reaching 0 means is the game's rule: the engine only
 * reports it.
 */
export interface BehaviorHealth {
  /**
   * The object's health now, or null when it has no Health component.
   * @graphPure
   * @graphNode Health of
   * @graphLabel entityId object
   */
  get(entityId: string): { current: number; max: number } | null;
  /**
   * Take `amount` (> 0) from the object's health, not below 0 (a `damaged` event, and `died` when it reaches 0). `source` names what did it (an object id or any text). False without health, when it is already at 0, or for a bad amount.
   * @graphNode Damage
   * @graphLabel entityId object
   * @graphDefault amount 1
   */
  damage(entityId: string, amount: number, source?: string): boolean;
  /**
   * Give `amount` (> 0) back, not above its maximum (a `healed` event). False without health, at its maximum, or for a bad amount.
   * @graphNode Heal
   * @graphLabel entityId object
   * @graphDefault amount 1
   */
  heal(entityId: string, amount: number): boolean;
  /**
   * Every object's health events of the previous step (damaged, healed, died), in the order they happened.
   * @graphPure
   * @graphNode Health events
   */
  events(): readonly HealthEventRecord[];
}

/** `ctx.patrol` — objects with a Patrol component. */
export interface BehaviorPatrol {
  /**
   * The way a patroller walks now (a unit vector) and whether it walks at all; null for an object without a patrol.
   * @graphPure
   * @graphNode Patrol state
   * @graphLabel entityId object
   */
  get(entityId: string): { direction: readonly [number, number, number]; active: boolean } | null;
  /**
   * Stop a patroller where it is, or let it walk on. False for an object without a patrol.
   * @graphNode Set patrol active
   * @graphLabel entityId object
   * @graphDefault active true
   */
  setActive(entityId: string, active: boolean): boolean;
  /**
   * Turn a patroller around now (a `turned` event). False for an object without a patrol, or a waypoint loop (it only goes forward).
   * @graphNode Turn patroller
   * @graphLabel entityId object
   */
  turn(entityId: string): boolean;
}

/** `ctx.hitbox` — objects with a Hitbox component. */
export interface BehaviorHitbox {
  /**
   * Switch a hitbox off (it touches nothing: its contacts end) or on again. False for an object without a hitbox.
   * @graphNode Set hitbox active
   * @graphLabel entityId object
   * @graphDefault active true
   */
  setActive(entityId: string, active: boolean): boolean;
  /**
   * The objects a hitbox (or the character) touches now, sorted by id.
   * @graphPure
   * @graphNode Touching
   * @graphLabel entityId object
   */
  touching(entityId: string): readonly string[];
}

/** `ctx.collectible` — objects with a Collectible component. */
export interface BehaviorCollectible {
  /**
   * Whether a collectible has been collected (and not come back yet).
   * @graphPure
   * @graphNode Is collected
   * @graphLabel entityId object
   */
  collected(entityId: string): boolean;
  /**
   * Bring a collected collectible back now (shown, collectable again; a `restored` event). False when it is not collected.
   * @graphNode Restore collectible
   * @graphLabel entityId object
   */
  restore(entityId: string): boolean;
}

/** `ctx.character` — the character (the object with the Character controller). */
export interface BehaviorCharacter {
  /**
   * Add `velocity` [x, y, z] (m/s, each at most 100 either way) to the character's velocity at its next move — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without a character or for a bad vector.
   * @graphNode Character impulse
   * @graphLabel velocity velocity
   */
  impulse(velocity: readonly [number, number, number]): boolean;
}

/**
 * A look override (`ctx.look.set`): an emissive glow and a tint
 * multiplied into the object's own colour, on every mesh under the object.
 */
export interface BehaviorLookValue {
  /** The glow colour ('#rrggbb'). */
  emissive?: string;
  /** How strongly it glows (0–4; absent with a glow colour: 1). */
  emissiveIntensity?: number;
  /** A colour ('#rrggbb') multiplied into the object's own colour. */
  tint?: string;
}

/** `ctx.look` — per-object look overrides the renderer applies (both renderers). */
export interface BehaviorLook {
  /**
   * Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value.
   * @graphNode Set look
   * @graphLabel entityId object
   */
  set(entityId: string, look: BehaviorLookValue): boolean;
  /**
   * Give an object its own look back. False when it had no override.
   * @graphNode Clear look
   * @graphLabel entityId object
   */
  clear(entityId: string): boolean;
  /**
   * The object's look override now, or null when it has none.
   * @graphPure
   * @graphNode Look of
   * @graphLabel entityId object
   */
  get(entityId: string): BehaviorLookValue | null;
}

/** One entity's animator, as a script sees it. */
export interface BehaviorAnimatorHandle {
  /**
   * Set a float/int/bool parameter; false for an unknown name or a wrong type.
   * @graphNode Set animator parameter
   * @graphLabel name parameter
   */
  set(name: string, value: number | boolean): boolean;
  /**
   * Set a trigger (it resets when a transition uses it).
   * @graphNode Set animator trigger
   * @graphLabel name trigger
   */
  trigger(name: string): boolean;
  /**
   * A parameter's value (undefined for an unknown name).
   * @graphPure
   * @graphNode Animator parameter
   * @graphLabel name parameter
   */
  get(name: string): number | boolean | undefined;
  /**
   * The current state's name (of the base layer, or of override layer `layer` — 1 is the first).
   * @graphPure
   * @graphNode Animator state
   */
  state(layer?: number): string;
  /**
   * Set this animator's playback speed (× every clip and crossfade; 1 as authored, 0.5 half speed, 0 holds the pose; 0–10). False for a value outside 0–10.
   * @graphNode Set animation speed
   * @graphDefault speed 1
   */
  setSpeed(speed: number): boolean;
  /**
   * This animator's playback speed.
   * @graphPure
   * @graphNode Animation speed
   */
  speed(): number;
  /**
   * Set a morph target's weight (0–1) by its name in the model (over the controller's parameter binding of that target, if any).
   * @graphNode Set morph weight
   * @graphLabel name morph target
   */
  setMorph(name: string, weight: number): boolean;
  /**
   * A morph target's weight now (0 when nothing sets it).
   * @graphPure
   * @graphNode Morph weight
   * @graphLabel name morph target
   */
  morph(name: string): number;
}

export interface BehaviorAnimatorControl {
  /** The entity's animator, or null when it has none (or is not loaded). */
  of(entityId: string): BehaviorAnimatorHandle | null;
}

/** A clip event an animator passed. */
export interface AnimatorEventRecord {
  readonly entityId: string;
  readonly name: string;
  readonly clip: string;
  /** The step in which the clip passed the event. */
  readonly stepIndex: number;
}

/**
 * What a behavior script can ask about tags (`ctx.tags`, in
 * `instantiate` and every `step`). Built once when the scene loads from the
 * effective masks (own mask OR every folder above's); calls never allocate
 * per frame beyond the first query of a given mask.
 */
export interface BehaviorTagQuery {
  /**
   * The mask of the named tags (names ignore case). Throws on an unknown name.
   * @graphPure
   * @graphNode Tag mask
   * @graphLabel names tags (comma separated)
   */
  mask(...names: string[]): number;
  /**
   * The entity's effective tag mask (0 for an unknown entity).
   * @graphPure
   * @graphNode Tags of
   */
  of(entityId: string): number;
  /**
   * Whether the entity carries any (default) or all of the mask's bits.
   * @graphPure
   * @graphNode Has tags
   */
  has(entityId: string, mask: number, match?: 'any' | 'all'): boolean;
  /**
   * The entities carrying any (default) or all of the mask's bits, in scene order.
   * @graphPure
   * @graphNode Find by tags
   */
  query(mask: number, match?: 'any' | 'all'): readonly string[];
}