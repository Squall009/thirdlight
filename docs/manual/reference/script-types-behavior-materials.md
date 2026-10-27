# Script API types (from `BehaviorMaterials`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-behavior-materials"></a>
## `BehaviorMaterials`

```ts
/**
 * `ctx.materials` — graph-material parameters per object while the game runs.
 * `param` is a parameter key of the object's graph materials (public ones
 * only); `materialId` limits a call to one of its materials. Writes are
 * refused (`false`) for an object that wears no graph material with that
 * parameter, a value that does not fit the parameter (type, range, a texture
 * outside the game), or at the engine limit of 4,096 writes per step.
 */
export interface BehaviorMaterials {
  /**
   * Set a parameter on one object: a number (float), 2–4 numbers (vec2–4), "#rrggbb" (colour) or a texture asset id of the game ("" for none). Other objects wearing the material keep their values. False when refused.
   * @graphNode Set material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  set(entityId: string, param: string, value: unknown, materialId?: string): boolean;
  /**
   * A parameter's value on an object now: what a script set, else the object's authored override, else the material's default (null: no such parameter, or a data parameter).
   * @graphPure
   * @graphNode Material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  get(entityId: string, param: string, materialId?: string): unknown;
  /**
   * Put a parameter (or, without one, every parameter scripts set) of an object back to its authored value; a data parameter back to its starting cells.
   * @graphNode Reset material parameter
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  reset(entityId: string, param?: string, materialId?: string): boolean;
  /**
   * Write a rectangle of cells of a data parameter: x, y, width, height in cells (cell [0, 0] sits at UV (0, 0)); bytes = RGBA 0–255 per cell, row by row from y (width × height × 4 numbers). False when refused (outside the grid, wrong length).
   * @graphNode Write material data
   * @graphLabel param parameter
   * @graphLabel materialId material
   * @graphDefault w 1
   * @graphDefault h 1
   * @graphType bytes list
   */
  setData(entityId: string, param: string, x: number, y: number, w: number, h: number, bytes: readonly number[], materialId?: string): boolean;
  /**
   * One cell of a data parameter on an object as [r, g, b, a] (0–255), or null (no such parameter or cell).
   * @graphPure
   * @graphNode Material data cell
   * @graphLabel param parameter
   * @graphLabel materialId material
   */
  getData(entityId: string, param: string, x: number, y: number, materialId?: string): number[] | null;
}
```

<a id="script-type-behavior-saves"></a>
## `BehaviorSaves`

```ts
/**
 * `ctx.saves` — the project's save document and its slots, and the project
 * settings document. Requires a save schema in the project (Project → Saves);
 * without one every call answers false / empty.
 */
export interface BehaviorSaves {
  /**
   * The save document's schema version (0: the project declares no save schema).
   * @graphPure
   * @graphNode Save version
   */
  readonly version: number;
  /**
   * How many slots the game offers.
   * @graphPure
   * @graphNode Save slot count
   */
  readonly slotCount: number;
  /**
   * Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.
   * @graphNode Write save document
   */
  write(doc: unknown): boolean;
  /**
   * The project's save document (a copy; null before one is written or loaded).
   * @graphPure
   * @graphNode Save document
   */
  read(): unknown;
  /**
   * Save to a slot at the end of this step (the document and the engine sections of the schema);
   * the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (names → texts; the record at most 4 KiB as JSON).
   * False for a slot the game does not have or a meta that does not fit.
   * @graphNode Save to slot
   */
  save(slot: number, meta?: SaveMeta): boolean;
  /**
   * Load a slot: when storage answers, the document is migrated and restored at the end of that step
   * (the outcome in `results()`).
   * @graphNode Load slot
   */
  load(slot: number): boolean;
  /**
   * Delete a slot (the outcome in `results()`).
   * @graphNode Delete slot
   */
  delete(slot: number): boolean;
  /**
   * The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).
   * @graphPure
   * @graphNode Save slots
   */
  slots(): readonly SaveSlotInfo[];
  /**
   * Whether the slot list has arrived from storage (it is empty before).
   * @graphPure
   * @graphNode Save slots ready
   */
  ready(): boolean;
  /**
   * The outcomes that arrived this step (saves, loads and deletes).
   * @graphPure
   * @graphNode Save results
   */
  results(): readonly SaveResult[];
  /**
   * The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for
   * at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.
   * @graphPure
   * @graphNode Save storage
   */
  storage(): SaveStorageInfo;
  /**
   * Play time in seconds (restored with a loaded save).
   * @graphPure
   * @graphNode Play time
   */
  playSeconds(): number;
  /**
   * Register the migration a save schema names: `migrate(doc, fromVersion)` returns the document one
   * version later. Call it every step (or once at the start); the last registration counts.
   * @graphNode skip a migration is a function (code)
   */
  migration(name: string, migrate: (doc: unknown, fromVersion: number) => unknown): boolean;
  /**
   * A value of the project settings document (its default until the player changes it).
   * @graphPure
   * @graphNode Setting
   */
  setting(key: string): boolean | number | string | null;
  /**
   * The whole project settings document (a copy).
   * @graphPure
   * @graphNode Settings document
   */
  settings(): Record<string, boolean | number | string>;
  /**
   * Change a value of the project settings document (kept in the player's browser; an engine setting
   * it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.
   * @graphNode Set setting
   */
  setSetting(key: string, value: boolean | number | string): boolean;
}
```

<a id="script-type-behavior-assets"></a>
## `BehaviorAssets`

```ts
/**
 * `ctx.assets` — load assets by id, address or label and let them go.
 * A load answers at once with a handle; the assets arrive while the game
 * plays (the simulation never waits) and the handle's state says when they
 * are ready. Release every handle you load: what it holds stays in memory
 * until then.
 */
export interface BehaviorAssets {
  /**
   * Start loading the asset or resource with this id or address, or every one with this label.
   * Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading'
   * until the assets are ready, a later step.
   * @graphNode Load assets
   * @graphLabel key id, address or label
   */
  load(key: string): number;
  /**
   * Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
   * @graphNode Release assets
   */
  release(handle: number): boolean;
  /**
   * A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
   * @graphPure
   * @graphNode Assets state
   */
  state(handle: number): AssetHandleState | null;
  /**
   * True once a handle's assets are loaded.
   * @graphPure
   * @graphNode Assets ready
   */
  ready(handle: number): boolean;
  /**
   * The ids a ready handle loaded (the assets and resources its key named, in id order); empty otherwise.
   * @graphNode skip a list of ids; read a known id with Assets ready
   */
  ids(handle: number): readonly string[];
  /**
   * Why a failed handle failed ('' otherwise).
   * @graphPure
   * @graphNode Assets error
   */
  error(handle: number): string;
}
```

<a id="script-type-behavior-ui"></a>
## `BehaviorUi`

```ts
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
   * Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.
   * @graphNode Focus UI widget
   * @graphLabel docId document
   * @graphLabel widgetId widget
   * @graphLabel index list item
   */
  focus(docId: string, widgetId: string, index?: number): boolean;
  /**
   * The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.
   * @graphPure
   * @graphNode UI view
   */
  view(): BehaviorUiView;
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
```

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
  /** Occlusion culling in the last frame (the project's occlusion_culling setting, its quality level's). */
  readonly occlusion: BehaviorStatsOcclusion;
  /** The lighting drawn: its tier, live or saved, settled (reported again as soon as it changes). */
  readonly lighting: BehaviorStatsLighting;
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

<a id="script-type-behavior-lighting"></a>
## `BehaviorLighting`

```ts
/**
 * `ctx.lighting`: the lighting the page draws on this device — the quality
 * level's lighting tier and whether the light has settled after a load or a
 * change (a lamp switched, a block dug, time of day). Presentation, as
 * `ctx.stats`: measured by the page, not in the digest or a save.
 */
export interface BehaviorLighting {
  /**
   * The lighting tier: 'low' (saved light only, always on WebGL 2), 'medium' or 'high' (live).
   * @graphNode Lighting tier
   */
  readonly tier: 'low' | 'medium' | 'high';
  /**
   * The static surfaces' light is computed live on this device.
   * @graphNode Lighting live
   */
  readonly live: boolean;
  /**
   * The lighting has caught up (live: nothing left to light again; saved: the saved light read).
   * @graphNode Lighting settled
   */
  readonly settled: boolean;
  /**
   * True in the first step after the lighting settled (the event: a loading screen may lift then); false in every other step.
   * @graphNode Lighting just settled
   */
  readonly justSettled: boolean;
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
 * death means are the game's own rules (scripts); this is only the mechanism.
 */
export interface BehaviorLifecycle {
  /**
   * Move a player character (a controller's object: `entityId`, absent: the first player controller) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). Applied after this step's intent phase (a later phase: the next step). `false` without that character or for an unknown spawn.
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
  /**
   * Change the scene's global wind: any of its fields (direction [x, z], strength, gust, gustFrequency, turbulence, speed m/s, scale m, noise texture), added to the last change's, blending over `blend` seconds; null goes back to the scene's own wind. Wind zones keep laying their values over it. False when a value or an option is refused.
   * @graphNode Set wind
   * @graphLabel blend blend (seconds)
   */
  setWind(wind: WindChange | null, options?: { blend?: number; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }): boolean;
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
 * `ctx.shell` — the game shell's scene list (`content.shell`) from scripts. Deprecated: a game changes levels with
 * `ctx.scenes.load` / `unload` and picks the look with `ctx.scenes.setActive`; every call writes one Problems line
 * per Play.
 */
export interface BehaviorShell {
  /**
   * Deprecated (one Problems line per Play): moves to the next entry of the shell's scene list at the next step
   * boundary, as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene,
   * the entry's scene loads, the character arrives at its spawn). False when the list has no next entry; a second
   * call in the same step asks for the same move.
   * @deprecated Use `ctx.scenes.load(next, {unload: [current]})` and `ctx.scenes.setActive(next)`.
   * @graphNode Next scene (deprecated)
   */
  nextScene(): boolean;
  /**
   * Deprecated (one Problems line per Play): the scene list entry the run is at (-1: none); only the list's own
   * moves change it.
   * @deprecated Keep the game's own level order; `ctx.scenes.loaded()` and `ctx.scenes.active()` say where it is.
   * @graphPure
   * @graphNode Scene list entry (deprecated)
   */
  sceneIndex(): number;
  /**
   * Deprecated (one Problems line per Play): how many entries the shell's scene list has (0: none).
   * @deprecated Keep the game's own level order.
   * @graphPure
   * @graphNode Scene list length (deprecated)
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
  readonly inputHeld?: boolean;
}
```

<a id="script-type-vec2"></a>
## `Vec2`

```ts
export interface Vec2 {
  x: number;
  y: number;
}
```

<a id="script-type-character-move-result3-d"></a>
## `CharacterMoveResult3D`

```ts
/** The port's per-step character result. */
export interface CharacterMoveResult3D {
  requested: PhysicsVec3;
  applied: PhysicsVec3;
  position: PhysicsVec3;
  grounded: boolean;
  supportNormal: PhysicsVec3;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  groundEntityId?: string | null;
  /** How far a moving (kinematic) body moved into the character this step; the correction may exceed the request by this much. */
  kinematicSlack?: number;
}
```

<a id="script-type-physics-plane"></a>
## `PhysicsPlane`

```ts
/**
 * The plane a body is locked to: its normal's world axis (X or Z) and where
 * it lies along that axis (m). The project model's `plane` field.
 */
export type PhysicsPlane = PlaneLock;
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

<a id="script-type-raycast-hit"></a>
## `RaycastHit`

```ts
/** A ray hit on the caller's plane (`raycast` with {x, y}): the object, the distance and the surface normal in the plane. */
export interface RaycastHit {
  entityId: string;
  distance: number;
  normal: Vec2;
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
