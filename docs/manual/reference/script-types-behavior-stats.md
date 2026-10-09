# Script API types (from `BehaviorStats`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-behavior-stats"></a>
## `BehaviorStats`

```ts
/**
 * `ctx.stats` (and `$flow.stats` in UI documents): how the game runs on this
 * device, measured by the page over its last stats window. Presentation, not
 * simulation state: not in the digest or a save; a replay on another device
 * reads that device's. All zero until the first window ends.
 */
export interface BehaviorStats {
  /** Frames drawn per second over the window. */
  readonly fps: number;
  /** The time from one frame to the next (ms). */
  readonly frameMs: BehaviorStatsTime;
  /** The page thread's work per frame (ms): the simulation's steps when it runs on the page, the frame's host work and the draw calls' submission. */
  readonly cpuMs: BehaviorStatsTime;
  /** The GPU's time per frame (ms) from timestamp queries; null where the browser or GPU has none (not measured). */
  readonly gpuMs: BehaviorStatsTime | null;
  /** Draw calls of the last frame. */
  readonly drawCalls: number;
  /** Triangles of the last frame. */
  readonly triangles: number;
  /** Texture bytes resident on the GPU (streamed and fixed, images inside models included). */
  readonly textureBytes: number;
  /** The texture budget (bytes; the setting texture_budget_mb). */
  readonly textureBudgetBytes: number;
  /** Geometry bytes of the loaded models. */
  readonly geometryBytes: number;
  /** Objects in the simulation. */
  readonly entities: number;
  /** The quality level drawn: its id ("low", "medium", "high", or one of the project's own levels). */
  readonly quality: string;
  /** The frame-rate cap the page draws under (30, 60 or 120 fps), or null for none (the display's rate). */
  readonly frameRateCap: number | null;
  /** The window the times are measured over (ms). */
  readonly windowMs: number;
}
```

<a id="script-type-behavior-display"></a>
## `BehaviorDisplay`

```ts
/**
 * `ctx.display`: the frame-rate cap — the most frames per second the page
 * draws, so a game that needs no more than 30 or 60 does not drain a phone's
 * battery at the display's 120 Hz. Game time is unaffected (the simulation
 * keeps its fixed step). Presentation, not simulation state: not in the
 * digest or a save; a game keeps a player's choice in its settings document
 * (a settings field bound to `frameRateCap`). Starts at the project's
 * `frame_rate_cap` setting.
 */
export interface BehaviorDisplay {
  /**
   * The cap in frames per second (30, 60 or 120), or null for none (the display's rate).
   * @graphNode Frame-rate cap
   */
  readonly frameRateCap: number | null;
  /**
   * Cap the frame rate at 30, 60 or 120 fps, or null (or 0) for none (the display's rate); false for any other value (nothing changes).
   * @graphNode Set frame-rate cap
   */
  setFrameRateCap(fps: number | null): boolean;
}
```

<a id="script-type-behavior-dialogue"></a>
## `BehaviorDialogue`

```ts
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
```

<a id="script-type-behavior-modes"></a>
## `BehaviorModes`

```ts
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
```

<a id="script-type-behavior-lifecycle"></a>
## `BehaviorLifecycle`

```ts
/**
 * `ctx.lifecycle` — the engine's run lifecycle: respawn the
 * character at a player spawn and restart the run. Winning, losing and what a
 * death means are the game's own rules (scripts); this is only the mechanism. It
 * works on the 2D plane too (the character controller session that owned it is gone).
 */
export interface BehaviorLifecycle {
  /**
   * Move a player character (a controller's object: `entityId`, absent: the first player controller) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). In 3D applied after this step's intent phase (a later phase: the next step); on the 2D plane at the next step boundary. `false` without that character or for an unknown spawn.
   * @graphNode Respawn player
   * @graphLabel spawnId spawn
   * @graphLabel entityId player
   */
  respawn(spawnId?: string, entityId?: string): boolean;
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
   * Deprecated: the engine does not know what a run restart is. Restarts the run at the next step (scenes,
   * objects, scripts, cameras, UI and the start mode as at the start) and writes one Problems line per Play;
   * reload scenes with `ctx.scenes.reload` and reset what the game keeps itself.
   * @deprecated Use `ctx.scenes.reload(sceneId)`.
   * @graphNode Restart run (deprecated)
   */
  restart(): boolean;
}
```

<a id="script-type-behavior-timeline"></a>
## `BehaviorTimeline`

```ts
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
```

<a id="script-type-behavior-environment"></a>
## `BehaviorEnvironment`

```ts
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
```

<a id="script-type-behavior-entity-handle"></a>
## `BehaviorEntityHandle`

```ts
/**
 * `ctx.entity(ref)` — one loaded object, by id (an `entityRef`
 * property's value, a spawned copy's id, `ctx.entityId`…).
 */
export interface BehaviorEntityHandle {
  /**
   * A read-only snapshot of a component's script-readable fields as they stood at the start of the step
   * (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the
   * object has no such component (`'materialParams'`: when it wears no graph material with public parameters).
   * A component scripts cannot read throws.
   * @graphPure
   * @graphNode Get component
   */
  get(component: string): Readonly<Record<string, unknown>> | null;
  /**
   * Write fields of a component, applied at the end of the step (in script order; a later write of the
   * same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`,
   * transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light
   * `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: value } }),
   * `materials` ({ slot: materialId | null } on a model, box or instance set: shown once the material has loaded).
   * Any other field is refused: the result names it (nothing of a refused patch is written).
   * @graphNode Set component
   */
  set(component: string, patch: Readonly<Record<string, unknown>>): EntityWriteResult;
}
```

<a id="script-type-behavior-shell"></a>
## `BehaviorShell`

```ts
/**
 * `ctx.shell` — the game shell's scene list (`content.shell`) from scripts.
 */
export interface BehaviorShell {
  /**
   * Move to the next entry of the shell's scene list at the next step boundary — the same move as the
   * shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the
   * entry's scene loads, the character arrives at its spawn). False when the list has no next entry.
   * Calling it again in the same step asks for the same move.
   * @graphNode Next scene
   */
  nextScene(): boolean;
  /**
   * The scene list entry the run is at (-1: none).
   * @graphPure
   * @graphNode Scene list entry
   */
  sceneIndex(): number;
  /**
   * How many entries the shell's scene list has (0: the project has none).
   * @graphPure
   * @graphNode Scene list length
   */
  sceneCount(): number;
}
```

<a id="script-type-contact-event-record"></a>
## `ContactEventRecord`

```ts
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
```

<a id="script-type-behavior-message"></a>
## `BehaviorMessage`

```ts
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
```

<a id="script-type-ui-event-record"></a>
## `UiEventRecord`

```ts
/** One UI event carried by an input frame (and read by scripts). */
export interface UiEventRecord {
  readonly kind: UiEventKind;
  /** The document it happened in (show/hide/toggle: the document shown or hidden). */
  readonly doc: string;
  /** The widget it happened on ('' for none). */
  readonly widget: string;
  /** The event name (a button's event action, an input's submit action; '' for focus/show/hide). */
  readonly name: string;
  /** Its value (a button action's value, the submitted text). */
  readonly value?: number | string | boolean | null;
  /** The list item it happened in (the item's index), when it came from a list template. */
  readonly index?: number;
}
```

<a id="script-type-property-declaration"></a>
## `PropertyDeclaration`

```ts
export interface PropertyDeclaration {
  properties: DeclaredProperty[];
}
```

<a id="script-type-behavior-engine-pin"></a>
## `BehaviorEnginePin`

```ts
/** One compiled engine pin the manifest carries (read-only here). */
export interface BehaviorEnginePin {
  id: string;
  version: string;
  apiVersion: number;
}
```

<a id="script-type-property-value"></a>
## `PropertyValue`

```ts
/** Seven-type property value vocabulary. */
export type PropertyValue =
  | number
  | boolean
  | string
  | [number, number, number]
  | null;
```

<a id="script-type-action-value"></a>
## `ActionValue`

```ts
/** One input action's value in a step. */
export interface ActionValue {
  readonly v: number;
  readonly x?: number;
  readonly y?: number;
  readonly p: JumpPhase;
  /**
   * 1 when the value is an amount per sample (pointer movement,
   * wheel) rather than a level: a further step of the same sample sees 0,
   * and two samples merged before a step add up.
   */
  readonly i?: 1;
}
```

<a id="script-type-pointer-sample"></a>
## `PointerSample`

```ts
/**
 * One pointer sample. Positions are fractions of the game view
 * (x 0 left → 1 right, y 0 top → 1 bottom — the camera's screen
 * coordinates), quantized to 1e-4; with a locked cursor the position is the
 * view's centre and only the movement counts. Buttons are bits: 1 left,
 * 2 right, 4 middle.
 */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  /** Movement since the last sample, as fractions of the view's width / height (y down); absent 0. */
  readonly dx?: number;
  readonly dy?: number;
  /** Wheel notches since the last sample (positive towards the user); absent 0. */
  readonly wheel?: number;
  /** Buttons held now (bits); absent 0. */
  readonly buttons?: number;
  /** Buttons that went down / up since the last sample (a click between two samples sets both); absent 0. The runtime also derives them from `buttons`. */
  readonly pressed?: number;
  readonly released?: number;
  /** The pointer is over the game view; absent true. */
  readonly over?: boolean;
  /** The cursor is locked (hidden, held in the view); absent false. */
  readonly locked?: boolean;
  /**
   * The pointer is over a UI element that takes it (a project UI
   * document's button, input or modal backdrop, the engine pause panel) — a
   * press there went to the UI, not the game; absent false.
   */
  readonly overUi?: boolean;
}
```

<a id="script-type-input-press"></a>
## `InputPress`

```ts
/**
 * A button that went down (`ctx.input.anyPressed()`): its device and code —
 * a key's `KeyboardEvent.code` (`KeyK`, `Space`), a mouse button (`left`,
 * `right`, `middle`) or a standard-layout pad button (`button0` … `button31`).
 */
export interface InputPress {
  readonly device: 'keyboard' | 'mouse' | 'gamepad';
  readonly code: string;
}
```

<a id="script-type-debug-command-call"></a>
## `DebugCommandCall`

```ts
/** One debug command call carried by an input frame. */
export interface DebugCommandCall {
  /** The command a script registered (`ctx.debug.command(name, …)`). */
  readonly name: string;
  /** Its arguments by name: numbers, text (≤ 256 characters) or true/false. */
  readonly args: Readonly<Record<string, DebugCommandArg>>;
}
```

<a id="script-type-save-event"></a>
## `SaveEvent`

```ts
/**
 * One storage entry of an input frame (the host's answer to a request, or the
 * slot list): part of the input, so a recording replays it.
 */
export type SaveEvent =
  | { readonly kind: 'slots'; readonly slots: readonly SaveSlotInfo[] }
  | { readonly kind: 'saved'; readonly slot: number; readonly ok: boolean; readonly reason?: string; readonly code?: SaveStorageCode }
  | { readonly kind: 'deleted'; readonly slot: number; readonly ok: boolean; readonly reason?: string; readonly code?: SaveStorageCode }
  | { readonly kind: 'loaded'; readonly slot: number; readonly ok: boolean; readonly reason?: string; readonly save?: ProjectSaveFile; readonly code?: SaveStorageCode }
  /** The settings document was not kept (it still applies for this session). */
  | { readonly kind: 'settings'; readonly ok: false; readonly reason: string; readonly code: SaveStorageCode }
  | ({ readonly kind: 'storage' } & SaveStorageInfo);
```

<a id="script-type-input-status-entry"></a>
## `InputStatusEntry`

```ts
/** The frame entry (every field optional; sent when it changed). */
export interface InputStatusEntry {
  readonly device?: InputDeviceStatus;
  readonly actions?: readonly InputActionStatus[];
  readonly events?: readonly InputRebindEvent[];
  /** The player profile whose bindings are in effect. */
  readonly profile?: string;
}
```

<a id="script-type-dialogue-input-record"></a>
## `DialogueInputRecord`

```ts
/** One dialogue input carried by an input frame (from the dialogue UI's buttons, a tool, a test). */
export interface DialogueInputRecord {
  readonly kind: DialogueInputKind;
  /** choose: the option's index among those shown. */
  readonly index?: number;
}
```

<a id="script-type-asset-handle-answer"></a>
## `AssetHandleAnswer`

```ts
/** The host's answer to one load: part of the input, so a recording replays it. */
export interface AssetHandleAnswer {
  readonly handle: number;
  readonly ok: boolean;
  /** The ids of the assets and resources the key named (ok only). */
  readonly assets?: readonly string[];
  /** Why the load failed (not ok only). */
  readonly message?: string;
}
```

<a id="script-type-jump-phase"></a>
## `JumpPhase`

```ts
/** The four jump phases. */
export type JumpPhase = 'none' | 'pressed' | 'held' | 'released';
```

<a id="script-type-intent-transform-write"></a>
## `IntentTransformWrite`

```ts
/** One committed transform write in commit order. */
export interface IntentTransformWrite {
  moduleId: string;
  entityId: string;
  position: { x?: number; y?: number; z?: number };
}
```

<a id="script-type-controller-intents"></a>
## `ControllerIntents`

```ts
/** One player controller's channels of a step (the `IntentSet` fields a controller reads). */
export interface ControllerIntents {
  readonly move: number | null;
  readonly jump: JumpPhase | null;
  readonly moveY?: number | null;
  readonly characterMove?: { readonly x: number; readonly z: number; readonly run: boolean } | null;
  readonly characterPlace?: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly characterEnabled?: boolean | null;
  readonly impulse?: { readonly x: number; readonly y: number; readonly z: number };
  readonly characterYaw?: number;
}
```

<a id="script-type-vec2"></a>
## `Vec2`

```ts
/**
 * The injected physics port. The concrete adapter (`physics-rapier`)
 * implements this surface; the runtime core never imports it. The runtime owns the instance
 * and hands modules only the restricted `PhysicsStepClient`.
 *
 * These are pure types plus the runtime's strict result validation: no
 * concrete physics library, no Node built-ins, no I/O.
 */
export interface Vec2 {
  x: number;
  y: number;
}
```

<a id="script-type-character-move-result"></a>
## `CharacterMoveResult`

```ts
/** The port's per-step character result. */
export interface CharacterMoveResult {
  requested: Vec2;
  applied: Vec2;
  position: Vec2;
  grounded: boolean;
  supportNormal: Vec2;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  /** The collider entity the character stands on (grounded), when the port knows it. */
  groundEntityId?: string | null;
  /** How far a moving (kinematic) body moved into the character this step; the correction may exceed the request by this much. */
  kinematicSlack?: number;
}
```

<a id="script-type-raycast-hit"></a>
## `RaycastHit`

```ts
/** A ray hit (`raycast`). */
export interface RaycastHit {
  entityId: string;
  distance: number;
  normal: Vec2;
}
```

<a id="script-type-character-state3-d"></a>
## `CharacterState3D`

```ts
/** The 3D player character's state (`ctx.physics.characterState`). */
export interface CharacterState3D {
  /** Its origin (m). */
  readonly position: PhysicsVec3;
  /** How fast it moved in the last step (m/s; its actual motion, collisions included). */
  readonly velocity: PhysicsVec3;
  /** Standing on something. */
  readonly grounded: boolean;
  /** What it touched: ground, a wall, its head, a slope too steep to walk. */
  readonly contacts: { readonly ground: boolean; readonly wall: boolean; readonly head: boolean; readonly steepSlope: boolean };
  /** The normal of what it stands on (up when in the air). */
  readonly supportNormal: PhysicsVec3;
  /** The object it stands on, or null. */
  readonly groundEntityId: string | null;
  /** Its controller is on (a script may switch it off). */
  readonly enabled: boolean;
  /** Climbing onto a ledge (input is ignored until it is up). */
  readonly climbing: boolean;
  /** The way it faces, in degrees about the up axis (0: +Z). */
  readonly facing: number;
}
```

<a id="script-type-physics-query-filter"></a>
## `PhysicsQueryFilter`

```ts
/** Which objects a 3D query sees (every part optional; absent: all colliders). */
export interface PhysicsQueryFilter {
  /** Only objects carrying at least one of these tags. */
  tags?: readonly string[];
  /** Only colliders in at least one of these collision layers ("default": colliders that list no layers). */
  layers?: readonly string[];
  /** Objects to skip (their ids). */
  exclude?: readonly string[];
}
```

<a id="script-type-physics-hit"></a>
## `PhysicsHit`

```ts
/** A 3D ray or pick hit. */
export interface PhysicsHit {
  /** The object whose collider was hit. */
  entityId: string;
  /** Where the ray hit [x, y, z]. */
  point: [number, number, number];
  /** The surface normal there [x, y, z] (unit). */
  normal: [number, number, number];
  /** Metres from the ray's origin. */
  distance: number;
  /**
   * A block layer's cell when the ray hit one (then `entityId` is the layer):
   * [x, y, z] in `ctx.grid` coordinates — the cell just inside the surface.
   */
  cell?: [number, number, number];
  /** A scatter copy's address when the ray hit one (then `entityId` is the terrain or layer it stands on; `ctx.scatter` takes it). */
  scatter?: string;
}
```

<a id="script-type-world-transform-options"></a>
## `WorldTransformOptions`

```ts
/** `ctx.world.transform` options: the space the transform is read in (default `local`, to the parent). */
export interface WorldTransformOptions {
  space?: 'local' | 'world';
}
```

<a id="script-type-scene-load-options"></a>
## `SceneLoadOptions`

```ts
/**
 * Options of one scene load. `at` offsets the scene's root
 * entities (world units). Loads are keyed by scene id today; the batch shape
 * leaves room for keyed, repeated (instanced) loads of one scene later.
 */
export interface SceneLoadOptions {
  at?: readonly [number, number, number];
  /**
   * Scenes unloaded when this one is in (a transition). They
   * stay drawn until the loaded scene replaces them in the same step, so the
   * view never shows an empty world.
   */
  unload?: readonly string[];
  /** Seconds the view fades out before the swap and back in after it (0–5; absent: 0, no fade). */
  fade?: number;
  /** The fade's colour ("#rrggbb"; absent: black). */
  fadeColor?: string;
}
```

<a id="script-type-scene-status"></a>
## `SceneStatus`

```ts
/** Where a scene is in its load cycle. */
export type SceneStatus = 'unloaded' | 'loading' | 'loaded';
```

<a id="script-type-scene-transition-view"></a>
## `SceneTransitionView`

```ts
/**
 * A scene transition in progress (a trigger's scene
 * transition, a move along the shell's scene list, a load with `unload` or
 * `fade`): the scene it waits for, and where it is — `out` while the view
 * fades out, `loading` while the scene is read and prepared.
 */
export interface SceneTransitionView {
  readonly scene: string;
  readonly phase: 'out' | 'loading';
  /** How far the view has faded out (0–1; 1 for a transition without a fade). */
  readonly fade: number;
  /** The fade's length (seconds; 0: none) and colour. */
  readonly seconds: number;
  readonly color: string;
  /** The scenes it unloads once its scene is in. */
  readonly unload: readonly string[];
}
```

<a id="script-type-scene-activate-options"></a>
## `SceneActivateOptions`

```ts
/** `ctx.scenes.setActive` options: the look's blend (seconds, 0–600) and its easing. */
export interface SceneActivateOptions {
  blend?: number;
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
}
```

<a id="script-type-behavior-pointer"></a>
## `BehaviorPointer`

```ts
/** The pointer as a script reads it (`ctx.input.pointer()`). */
export interface BehaviorPointer {
  /** 0 (left) – 1 (right) of the view; the centre while the cursor is locked. */
  readonly x: number;
  /** 0 (top) – 1 (bottom) of the view. */
  readonly y: number;
  /** Movement since the last step as fractions of the view's width / height (y down). */
  readonly dx: number;
  readonly dy: number;
  /** Wheel notches since the last step (positive towards the user). */
  readonly wheel: number;
  /** Over the game view. */
  readonly over: boolean;
  /** It came over the view / left it this step. */
  readonly entered: boolean;
  readonly left: boolean;
  /** The cursor is locked (hidden, held in the view). */
  readonly locked: boolean;
  /**
   * Over a UI element that takes the pointer (a project UI
   * button, input or modal backdrop, the engine pause panel) — a click there
   * went to the UI, so a game ignores world clicks while it is true.
   */
  readonly overUi: boolean;
}
```

<a id="script-type-input-device-status"></a>
## `InputDeviceStatus`

```ts
/** The device the player used last (a key, the mouse, or a gamepad button or stick). */
export interface InputDeviceStatus {
  readonly kind: InputDeviceKind;
  /** The gamepad's id as the browser reports it (clipped to 64 characters); absent for the keyboard and mouse. */
  readonly id?: string;
  /** The gamepad family (absent for the keyboard and mouse). */
  readonly family?: GamepadFamily;
}
```

<a id="script-type-input-action-status"></a>
## `InputActionStatus`

```ts
/** One project action with the player's current bindings. */
export interface InputActionStatus {
  readonly name: string;
  readonly type: 'button' | 'axis1d' | 'axis2d';
  /** gameplay, ui or one of the project's own input maps. */
  readonly map: string;
  readonly bindings: readonly InputBindingStatus[];
  /** The player changed this action's bindings (they differ from the project's). */
  readonly changed?: boolean;
}
```

<a id="script-type-input-device-kind"></a>
## `InputDeviceKind`

```ts
/** The device the player used last: keyboard and mouse are one device. */
export type InputDeviceKind = 'keyboardMouse' | 'gamepad';
```

<a id="script-type-input-glyph"></a>
## `InputGlyph`

```ts
/**
 * What to show for a binding: a label a player reads ("Space", "A", "Cross",
 * "Left button"), an icon id of the engine's generic glyph set (`key`,
 * `pad-south`, `mouse-left`, …) and the project's own image when it has one.
 * A composite binding (two or four keys) also lists its parts.
 */
export interface InputGlyph {
  readonly label: string;
  readonly icon: string;
  readonly image?: string;
  readonly parts?: readonly InputGlyphPart[];
}
```

<a id="script-type-input-rebind-event"></a>
## `InputRebindEvent`

```ts
/**
 * What became of a binding request: a rebind `started` (listening),
 * `rebound`, `cancelled` (the cancel key), `timeout`, `refused` (it does not
 * fit the action, or it conflicts under the refuse policy — `conflicts` says
 * with what), `reset`, or the player `profile` changed.
 */
export interface InputRebindEvent {
  readonly type: 'started' | 'rebound' | 'cancelled' | 'timeout' | 'refused' | 'reset' | 'profile';
  readonly action?: string;
  readonly index?: number;
  readonly part?: InputBindingPart;
  /** The new binding's label (rebound). */
  readonly label?: string;
  readonly reason?: string;
  readonly conflicts?: readonly InputBindingConflict[];
  /** The bindings of these actions moved to make room (swap policy). */
  readonly swapped?: readonly string[];
  readonly profile?: string;
}
```

<a id="script-type-input-rebind-target"></a>
## `InputRebindTarget`

```ts
/** A rebind's target: an action, which of its bindings and (composites) which part. */
export interface InputRebindTarget {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
}
```

<a id="script-type-input-rebind-options"></a>
## `InputRebindOptions`

```ts
/** Options of a listen-for-input rebind (`ctx.input.rebind`). */
export interface InputRebindOptions {
  /** Which of the action's bindings (its index in `bindings()`); absent: the first one of the device. */
  readonly index?: number;
  /** A composite binding's part (negative/positive, up/down/left/right). */
  readonly part?: InputBindingPart;
  /** The device to listen to (absent: the device used last). Keyboard and mouse listen together. */
  readonly device?: InputDeviceKind;
  /** When the input is already used in the same map: swap (default), refuse or allow. */
  readonly policy?: RebindConflictPolicy;
  /** The key that cancels listening (a KeyboardEvent.code; default Escape). */
  readonly cancelKey?: string;
  /** Seconds to listen before giving up (default 10; 1–60). */
  readonly timeout?: number;
}
```

<a id="script-type-health-event-record"></a>
## `HealthEventRecord`

```ts
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
```

<a id="script-type-patrol-event-record"></a>
## `PatrolEventRecord`

```ts
/** A patroller turned around (at a wall, a ledge, the end of its waypoints, or by a script). */
export interface PatrolEventRecord {
  readonly type: 'turned';
  readonly entity: string;
  readonly reason: 'wall' | 'ledge' | 'end' | 'script';
  /** The direction it walks in now (a unit vector). */
  readonly direction: readonly [number, number, number];
  readonly stepIndex: number;
}
```

<a id="script-type-collect-event-record"></a>
## `CollectEventRecord`

```ts
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
```

<a id="script-type-behavior-random-stream"></a>
## `BehaviorRandomStream`

```ts
/**
 * One seeded random number stream (`ctx.random`, `ctx.random.stream(name)`).
 * Replay-safe: the numbers come from the project's `random_seed` setting mixed with the
 * script id, the object's id and the stream name, and advance only when drawn — a replay,
 * the simulation worker and the page all draw the same numbers. Each new run starts over.
 */
export interface BehaviorRandomStream {
  /**
   * A number in [0, 1) (a multiple of 2^-32).
   * @graphNode Seeded random
   */
  next(): number;
  /**
   * A number in [min, max).
   * @graphNode Seeded random range
   * @graphDefault max 1
   */
  range(min: number, max: number): number;
  /**
   * A whole number from `min` to `max`, both included (the bounds are rounded inward).
   * @graphNode Seeded random integer
   * @graphDefault max 6
   */
  int(min: number, max: number): number;
  /**
   * True with probability `p` (0: never, 1: always).
   * @graphNode Seeded chance
   * @graphDefault p 0.5
   */
  chance(p: number): boolean;
  /**
   * One item of `list` chosen evenly, or `undefined` when it is empty.
   * @graphNode skip a list's random item is Seeded random integer with the list's Get item
   */
  pick<T>(list: readonly T[]): T | undefined;
}
```

<a id="script-type-behavior-look-value"></a>
## `BehaviorLookValue`

```ts
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
```

<a id="script-type-audio-play-options"></a>
## `AudioPlayOptions`

```ts
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
  /**
   * What the sound belongs to (`object`): it stops when the script's object
   * leaves the game (its scene unloads or reloads, a spawned copy is
   * destroyed); `scene`: when the object's scene unloads or reloads (a
   * spawned copy's: with the copy); `none`: it plays until stopped.
   */
  owner?: 'object' | 'scene' | 'none';
  /** Seconds it fades out over when its owner stops it (0). */
  fadeOut?: number;
}
```

<a id="script-type-audio-finished-event"></a>
## `AudioFinishedEvent`

```ts
/** A script sound's end (`ctx.audio.events()`), seen in the step after it happened. */
export interface AudioFinishedEvent {
  readonly kind: 'finished';
  readonly handle: number;
  readonly assetId: string;
  /** `ended`: it played to its end; `stopped`: a script stopped it (after its fade). */
  readonly reason: 'ended' | 'stopped';
}
```

<a id="script-type-audio-music-options"></a>
## `AudioMusicOptions`

```ts
/** Options of `ctx.audio.music`. */
export interface AudioMusicOptions {
  /** What the track belongs to (`object`; see `AudioPlayOptions.owner`): when it goes, the music is released over the track's fade. */
  owner?: 'object' | 'scene' | 'none';
}
```

<a id="script-type-audio-stinger-options"></a>
## `AudioStingerOptions`

```ts
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
  /** What it belongs to (`object`; see `AudioPlayOptions.owner`). */
  owner?: 'object' | 'scene' | 'none';
  /** Seconds it fades out over when its owner stops it (0). */
  fadeOut?: number;
}
```

<a id="script-type-audio-music-state"></a>
## `AudioMusicState`

```ts
/** A script's view of the music (`ctx.audio.musicState()`). */
export interface AudioMusicState {
  /** Who picks the track: the scripts (after `music`), or the host (`flow`: the engine has no level flow, so nothing plays then). */
  readonly owner: 'script' | 'flow';
  /** The scripts' track (null: silence, or the host owns it). */
  readonly track: string | null;
  /** The music duck now (1 = not ducked). */
  readonly duck: number;
}
```

<a id="script-type-debug-command-options"></a>
## `DebugCommandOptions`

```ts
/** How a script declares a debug command (`ctx.debug.command(name, options)`). */
export interface DebugCommandOptions {
  /** One line the console and tools show (at most 120 characters). */
  readonly description?: string;
  /** The arguments in order (at most 8; the console also takes them by position). */
  readonly args?: readonly DebugCommandArgSpec[];
}
```

<a id="script-type-debug-command-args"></a>
## `DebugCommandArgs`

```ts
/** The arguments of one debug command call. */
export type DebugCommandArgs = Readonly<Record<string, DebugCommandArg>>;
```

<a id="script-type-grid-cell"></a>
## `GridCell`

```ts
/** A cell as scripts read it: its block (null: a metadata-only cell), rotation, variant and effective metadata. */
export interface GridCell {
  readonly block: string | null;
  /** Degrees about +Y the block is shown at: 0, 90, 180 or 270 (a connected block: the turn its neighbours resolve). */
  readonly rot: number;
  /** The variant shown (an unset variant resolved from the weights and the position, or a connected block's piece). */
  readonly variant: number;
  /** A connected block's piece (single, end, straight, corner, t, cross, base, cap); absent: not connected or no rule for it. */
  readonly piece?: string;
  /** The block a kit draws in its place (`setKit`; rot, variant and piece are that block's); absent: no kit swaps it. `block` stays the cell's own. */
  readonly kitBlock?: string;
  /** The effective metadata (schema defaults, then the block's defaults, then the cell's own values). */
  readonly meta: Readonly<Record<string, number | string | boolean>>;
  /** For a cell covered by a larger block's footprint: that block's anchor cell (absent otherwise). */
  readonly anchor?: GridVec3;
  /**
   * A sloped top: the heights of its corners (−x−z, +x−z, +x+z, −x+z) in cell heights above its bottom, 0-4 (absent: a flat full top, all 1).
   * @graphType list
   */
  readonly corners?: readonly number[];
}
```

<a id="script-type-grid-cell-input"></a>
## `GridCellInput`

```ts
/** What `ctx.grid.set` writes: a block (with rotation and variant) and/or metadata overrides. */
export interface GridCellInput {
  /** A block type id (absent: a metadata-only cell). */
  block?: string;
  /** Degrees about +Y: 0, 90, 180 or 270. */
  rot?: number;
  /** A variant index (absent: picked from the weights by position). */
  variant?: number;
  /**
   * A sloped top (a single-cell full block): the heights of its corners −x−z, +x−z, +x+z, −x+z in cell heights above its bottom, 0-4 in steps of 1/64 (absent: flat).
   * @graphType list
   */
  corners?: readonly number[];
  /**
   * Metadata overrides (field key → value).
   * @graphType map
   */
  meta?: Record<string, number | string | boolean>;
}
```

<a id="script-type-grid-surface"></a>
## `GridSurface`

```ts
/** The ground of a layer at a point (`ctx.grid.surface`, `columnSurface`). */
export interface GridSurface {
  readonly layer: string;
  /** The cell whose top it is. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The world height of the surface there (metres). */
  readonly height: number;
  /** The surface point in world space. */
  readonly point: GridVec3;
  /** The surface's unit normal. */
  readonly normal: GridVec3;
  /** Degrees from level. */
  readonly slope: number;
  /** Whether the slope is at most the layer's maxSlope (absent: the project's steepest walkable slope). */
  readonly walkable: boolean;
}
```
