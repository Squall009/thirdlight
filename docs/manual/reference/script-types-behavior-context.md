# Script API types (from `BehaviorContext`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-behavior-context"></a>
## `BehaviorContext`

```ts
/** What a behavior's `step(state, ctx)` receives each fixed step (once per phase it runs in). */
export interface BehaviorContext {
  /**
   * The behavior's id.
   * @graphNode Script id
   */
  readonly behaviorId: string;
  /**
   * The entity carrying this script instance.
   * @graphNode This object
   */
  readonly entityId: string;
  /** The fixed step counter of the run. */
  readonly stepIndex: number;
  /** The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms). */
  readonly phase: SimulationPhase;
  /** The instance's property values (declaration defaults with the object's overrides). */
  readonly properties: BehaviorProperties;
  /** The step's sampled input frame (the same for every phase of the step). */
  readonly action: ActionFrame;
  /** The intents committed so far in this step. */
  readonly intents: IntentSet;
  /** The game's gameplay settings. */
  readonly settings: Readonly<GameplaySettings>;
  /** Physics queries for this step. */
  readonly physics: PhysicsStepClient;
  /** Find entities by tag. */
  readonly tags: BehaviorTagQuery;
  /** Read-only positions of the loaded entities. */
  readonly world: BehaviorWorldView;
  /** Load and switch scenes (projects with a scene catalog). */
  readonly scenes?: BehaviorSceneControl;
  /** The step's input actions by name. */
  readonly input: BehaviorInputView;
  /** An entity's animator (`ctx.animator(id)?.set('speed', 1)`), or null when it has none. */
  readonly animator?: (entityId: string) => BehaviorAnimatorHandle | null;
  /**
   * Last step's clip events, the enter/exit events of the triggers this instance owns, and
   * the health, collect, patrol and contact events of the objects it owns (its own, those below it, and
   * those its object properties name).
   * @graphNode skip the event nodes (On trigger, On animator event) read them one by one
   */
  readonly events?: readonly (AnimatorEventRecord | TriggerEventRecord | PrimitiveEventRecord)[];
  /** Named timers of this instance, counted in fixed steps. */
  readonly timers: BehaviorTimers;
  /**
   * Seeded random numbers of this instance (replay-safe; the project's
   * `random_seed` setting with this script and object), with named sub-streams.
   */
  readonly random: BehaviorRandom;
  /** Signals (seen one step after they are emitted). */
  readonly signals?: BehaviorSignals;
  /** Messages to other scripts, with a value (seen one step after they are sent). */
  readonly messages?: BehaviorMessages;
  /** The run's counters, the player's health and object visibility. */
  readonly game?: BehaviorGameState;
  /** Any object's health — read, damage and heal it; its events arrive in `ctx.events`. */
  readonly health?: BehaviorHealth;
  /** Patrollers — which way they walk, stop them, turn them around. */
  readonly patrol?: BehaviorPatrol;
  /** Hitboxes — switch them off and on, what they touch. */
  readonly hitbox?: BehaviorHitbox;
  /** Collectibles — collected or not, bring one back. */
  readonly collectible?: BehaviorCollectible;
  /** The character — give it an impulse. */
  readonly character?: BehaviorCharacter;
  /** Per-object look overrides — a glow or a tint, set and cleared. */
  readonly look?: BehaviorLook;
  /** Play sounds (presentation only, never part of the simulation). */
  readonly audio?: BehaviorAudio;
  /** Play visual effects (presentation only, never part of the simulation). */
  readonly effects?: BehaviorEffects;
  /** Values kept in the player's save. */
  readonly save?: BehaviorSave;
  /** Project debug commands (run by tools and the in-game console, recorded with the input). */
  readonly debug?: BehaviorDebug;
  /**
   * The block layers of the loaded scenes — read and write cells and their
   * metadata, pick a cell with a ray, neighbours, named regions, change events, a diff for saves.
   */
  readonly grid?: BehaviorGrid;
  /**
   * The trees, rocks and other copies the terrains' and block layers' scatter
   * rules placed — find them by place, read them by address, hide, show or
   * remove one (a ray that hits one names it: `PhysicsHit.scatter`).
   */
  readonly scatter?: BehaviorScatter;
  /** The splines of the loaded scenes — a place and cross-section along one, its length, the nearest place on it. */
  readonly splines?: BehaviorSplines;
  /** The ground at a point from whichever block layer or terrain is there — height, normal, slope, material layer weights (footsteps, effects, placing things). */
  readonly surface?: BehaviorSurface;
  /**
   * Copy a project prefab into the running game; returns the new root id (or null at an engine limit).
   * @graphNode Spawn prefab
   * @graphLabel prefabId prefab
   */
  readonly spawn?: (
    prefabId: string,
    options: {
      /** Where the copy's root goes: [x, y] (keeping the root's authored z) or [x, y, z]. */
      position: readonly number[];
      /**
       * The root's rotation as a quaternion [x, y, z, w].
       * @graphType list
       */
      rotation?: readonly number[];
      /** The root's scale: one number or [x, y, z]. */
      scale?: number | readonly number[];
      /** This copy's own values for the script on the prefab's root (property key → value), over the prefab's. */
      properties?: Readonly<Record<string, unknown>>;
    },
  ) => string | null;
  /**
   * Remove a spawned entity at the next step boundary.
   * @graphNode Destroy spawned
   */
  readonly destroy?: (entityId: string) => boolean;
  /**
   * Commit one intent (a transform/pose of an owned entity, or a gameplay intent).
   * Returns false when the runtime refuses it (a bad shape or value, the wrong
   * phase, an entity this script does not own, a second write of the same
   * channel in the step, the per-step limit): nothing is committed and the
   * refusal is logged once; the run goes on.
   */
  emit(intent: BehaviorIntent): boolean;
  /**
   * Write to the play log (`'info' | 'warn' | 'error'`).
   * @graphNode skip the Log node (debug.log) writes any value as text
   */
  log(level: BehaviorLogLevel, message: string): void;
  /** The virtual cameras — activate, priorities, rig values, shake, screen↔world. */
  readonly camera?: BehaviorCamera;
  /** Objects riding on named nodes of other objects' models — attach, detach, node poses. */
  readonly sockets?: BehaviorSockets;
  /**
   * Graph-material parameters per object — set a value (number, vector, colour,
   * texture) or write the cells of a data parameter on one object; others wearing the material keep theirs.
   */
  readonly materials?: BehaviorMaterials;
  /**
   * The project's save document and numbered slots (save, load, delete, the slot list
   * with title/chapter/location/play time/picture) and the project settings document.
   */
  readonly saves?: BehaviorSaves;
  /**
   * Load assets by id, address or label and release them: a handle's state says when they are ready
   * (the game never waits for a load); release every handle you load.
   */
  readonly assets?: BehaviorAssets;
  /** The project UI — publish view-model values, show and hide UI documents, read the step's UI events. */
  readonly ui?: BehaviorUi;
  /**
   * How the game runs on this device (read-only): fps, frame, CPU and GPU times (average and worst over the
   * last window; GPU null where not measured), draw calls, triangles, resident texture bytes against the budget,
   * geometry bytes, objects, the quality level. Measured by the page, not simulation state.
   */
  readonly stats?: BehaviorStats;
  /**
   * The frame-rate cap: the most frames per second the page draws (30, 60, 120 or none) — read it and set it.
   * Presentation: game time keeps its fixed step.
   */
  readonly display?: BehaviorDisplay;
  /**
   * Conversations — start a dialogue, advance, choose, skip seen lines, auto-advance,
   * dialogue variables, the backlog and the events of lines, choices and signals.
   */
  readonly dialogue?: BehaviorDialogue;
  /** The game modes — the current mode, switching (input maps, camera, UI, ticking groups together), enter/exit events. */
  readonly modes?: BehaviorModes;
  /** The run lifecycle — respawn the character at a spawn, restart the run. */
  readonly lifecycle?: BehaviorLifecycle;
  /** Timelines — play, pause, skip, seek and stop project timelines; their events and markers. */
  readonly timeline?: BehaviorTimeline;
  /** The environment presets — switch or blend sky, fog, lights, exposure and grading at run time. */
  readonly environment?: BehaviorEnvironment;
  /**
   * One loaded object by id (an object property's value, a spawned copy's id, `ctx.entityId`) —
   * read any component (`get`: the step-start state of its script-readable fields) and write the fields
   * marked writable (`set`: applied at the end of the step). Null for no id or an object that is not loaded.
   * @graphLabel entityId object
   */
  readonly entity?: (entityId: string | null) => BehaviorEntityHandle | null;
  /** The game shell's scene list — move to the next entry (the shell's nextScene action). */
  readonly shell?: BehaviorShell;
}
```

<a id="script-type-behavior-spec"></a>
## `BehaviorSpec`

```ts
/**
 * A behavior module's `export default`: `step` and/or any of the callbacks;
 * every one must be synchronous and return nothing. State is
 * per entity (from `instantiate`).
 *
 * Callbacks run inside the step's intent phase, before the instance's `step`,
 * in a fixed order: `onEnable`/`onDisable`, then `onTriggerEnter`/`onTriggerExit`,
 * `onContact`, `onMessage`, `onUiEvent`, `onAnimatorEvent` (each in the
 * order the events happened); the scripts of objects that left the game get
 * `onDisable` and `onDestroy` first. They report the same events `ctx.events`,
 * `ctx.messages` and `ctx.ui` list (those lists stay), so a replay runs them alike.
 */
export interface BehaviorSpec<State = unknown, Prepared = unknown> {
  prepare?(cfg: BehaviorPrepareConfig): Prepared;
  instantiate?(prepared: Prepared, inst: BehaviorInstanceInfo): State;
  /** Every fixed step, once per phase the behavior runs in (optional when the script has callbacks). */
  step?(state: State, ctx: BehaviorContext): void;
  dispose?(prepared: Prepared, state: State): void;
  /**
   * The object is in the game and switched on — its first step (a run's start, a scene load,
   * a spawned copy) and each time it is switched on again (`set('object', { active: true })`).
   */
  onEnable?(state: State, ctx: BehaviorContext): void;
  /** The object was switched off (itself or an object above it), or it is leaving the game. */
  onDisable?(state: State, ctx: BehaviorContext): void;
  /**
   * The object left the game (destroyed, or its scene unloaded) — in the step it left, after
   * `onDisable`; the object is already gone (`ctx.entity(ctx.entityId)` is null). Not called when a run restarts.
   */
  onDestroy?(state: State, ctx: BehaviorContext): void;
  /** The player entered a trigger this script owns (on its object, below it, or named by one of its object properties) in the last step. */
  onTriggerEnter?(state: State, event: TriggerEventRecord, ctx: BehaviorContext): void;
  /** The player left a trigger this script owns in the last step. */
  onTriggerExit?(state: State, event: TriggerEventRecord, ctx: BehaviorContext): void;
  /** A hitbox this script owns began (`type: 'contact'`) or stopped (`'separate'`) touching something in the last step. */
  onContact?(state: State, event: ContactEventRecord, ctx: BehaviorContext): void;
  /** A message sent in the last step to every script or to this object (`ctx.messages.send`). */
  onMessage?(state: State, message: BehaviorMessage, ctx: BehaviorContext): void;
  /** A UI event of this step (a button, a submitted input, a document shown or hidden). */
  onUiEvent?(state: State, event: UiEventRecord, ctx: BehaviorContext): void;
  /** A clip event an animator this script owns passed in the last step. */
  onAnimatorEvent?(state: State, event: AnimatorEventRecord, ctx: BehaviorContext): void;
  /**
   * What a debugger may read of an instance's state (Play's
   * visual-script debugger: the trace of the step, wire values, variables).
   * Never called during a step; its result is read-only. Optional.
   */
  debug?(state: State): unknown;
}
```

<a id="script-type-behavior-prepare-config"></a>
## `BehaviorPrepareConfig`

```ts
/** What `prepare(cfg)` receives (once per run, before any instance). */
export interface BehaviorPrepareConfig {
  readonly behaviorId: string;
  readonly sourceDigest: string;
  readonly declaration: PropertyDeclaration;
  readonly enginePins: readonly BehaviorEnginePin[];
}
```

<a id="script-type-behavior-instance-info"></a>
## `BehaviorInstanceInfo`

```ts
/** What `instantiate(prepared, inst)` receives (once per entity carrying the behavior). */
export interface BehaviorInstanceInfo {
  readonly entityId: string;
  readonly properties: BehaviorProperties;
  readonly tags: BehaviorTagQuery;
}
```

<a id="script-type-simulation-phase"></a>
## `SimulationPhase`

```ts
/**
 * The canonical simulation phase order.
 */
export type SimulationPhase = 'intent' | 'controller' | 'transform';
```

<a id="script-type-behavior-properties"></a>
## `BehaviorProperties`

```ts
/** The declared-property value map fed to one behavior instance. */
export type BehaviorProperties = Readonly<Record<string, PropertyValue>>;
```

<a id="script-type-action-frame"></a>
## `ActionFrame`

```ts
/** One self-describing action frame (version 2). */
export interface ActionFrame {
  /** Integer, `0 ≤ v ≤ 2^53−1` — the executed fixed-step index. */
  stepIndex: number;
  /**
   * Optional: every named input action this step — `v` its value
   * (a button 0/1, an axis −1..1 after its processors), `x`/`y` for a 2D
   * axis, `p` the button phase. Absent: no action has a value (all neutral).
   */
  actions?: Readonly<Record<string, ActionValue>>;
  /**
   * Optional: the pointer (mouse, pen, touch) this step. Absent:
   * no new sample — the runtime keeps the last position, buttons and
   * over/locked state (no movement, no edges).
   */
  pointer?: PointerSample;
  /**
   * Optional: the first key or pad button that went down since the
   * last sample, bound to an action or not (a mouse button is the pointer's
   * `pressed`). Absent: none.
   * @graphNode skip a script reads it with ctx.input.anyPressed
   */
  press?: InputPress;
  /**
   * Optional: the debug commands run in this step (a tool, the
   * in-game console) — part of the input so a recording replays them exactly.
   * Absent: none.
   * @graphNode skip a script receives its debug commands with ctx.debug.command
   */
  commands?: readonly DebugCommandCall[];
  /**
   * Optional: storage's answers this step (the slot list, save and
   * delete outcomes, a loaded save document) — part of the input so a
   * recording replays them and the worker applies them at the same step.
   * Absent: none.
   * @graphNode skip a script reads them through ctx.saves
   */
  saves?: readonly SaveEvent[];
  /**
   * Optional: the host's input status for scripts — the device
   * used last, the player's bindings with their glyphs (each only when it
   * changed) and the outcome of binding requests. Part of the input so a
   * replay shows scripts what they saw live. Absent: nothing changed.
   * @graphNode skip scripts read it with ctx.input.device, bindings and glyph
   */
  input?: InputStatusEntry;
  /**
   * Optional: the UI events of this step (a click, a submit, a
   * focus change, a custom event, a document shown or hidden by a button) —
   * part of the input so a recording replays them exactly. Absent: none.
   * @graphNode skip a script reads its UI events with ctx.ui.events / ctx.ui.event
   */
  ui?: readonly UiEventRecord[];
  /**
   * Optional: the dialogue inputs of this step (advance, choose,
   * skip, auto, backlog — from the dialogue UI's buttons) — part of the input
   * so a recording replays them exactly. Absent: none.
   * @graphNode skip scripts drive conversations with ctx.dialogue
   */
  dialogue?: readonly DialogueInputRecord[];
  /**
   * Optional: the host's answers to the scripts' asset loads this
   * step (ready with the ids loaded, or failed) — part of the input so a
   * recording replays them at the step they arrived, however long a load
   * took. Absent: none.
   * @graphNode skip a script reads its handles with ctx.assets.state
   */
  assets?: readonly AssetHandleAnswer[];
}
```

<a id="script-type-intent-set"></a>
## `IntentSet`

```ts
/** The runtime's per-step intent set. */
export interface IntentSet {
  readonly stepIndex: number;
  /** The committed `control_move` (quantized) or `null`. */
  readonly move: number | null;
  /** The committed `control_jump` or `null`. */
  readonly jump: JumpPhase | null;
  /** The module ID that committed `move`, or `null`. */
  readonly moveWriter: string | null;
  readonly jumpWriter: string | null;
  /** Committed transform writes, in commit order. */
  readonly transformWrites: readonly IntentTransformWrite[];
  /** The committed `control_move`'s second axis (0 when it had none), or null. */
  readonly moveY?: number | null;
  /** The committed `character_move` (a world direction on the ground), or null. */
  readonly characterMove?: { readonly x: number; readonly z: number; readonly run: boolean } | null;
  /** The committed `character_place` point, or null. */
  readonly characterPlace?: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** The committed `character_enable` value, or null. */
  readonly characterEnabled?: boolean | null;
  /** The velocity (m/s) scripts' `ctx.character.impulse` calls add at this controller phase (summed; absent: none). */
  readonly impulse?: { readonly x: number; readonly y: number; readonly z: number };
  /** The yaw (radians about +Y, 0 facing +Z) a placement this step faces (a spawn's yaw; absent: as it was). */
  readonly characterYaw?: number;
  /**
   * The further player controllers' channels this step, by their object's id
   * (present only when an intent, an impulse or a placement named one; the
   * fields above are the first controller's). Read them with `controllerIntents`.
   */
  readonly controllers?: Readonly<Record<string, ControllerIntents>>;
}
```

<a id="script-type-gameplay-settings"></a>
## `GameplaySettings`

```ts
/** The six-key gameplay settings registry value. */
export interface GameplaySettings {
  gravity_y: number;
  run_speed: number;
  jump_velocity: number;
  max_fall_speed: number;
  max_slope_climb_deg: number;
  min_slope_slide_deg: number;
  /** Engine settings, present only when the project sets them (absent: the engine default). */
  fixed_step_hz?: number;
  audio_voices?: number;
  music_fade_s?: number;
  animation_crossfade_s?: number;
  /** The renderer backend (0 WebGL legacy, 1 auto, 2 WebGPU, 3 WebGL 2; absent: 0). */
  render_backend?: number;
  /** Where the simulation runs in Play and the export (1 a worker, 2 the page's main thread; absent: 1). */
  sim_thread?: number;
  /** The texture budget of Play and the export in MiB (absent: `TEXTURE_BUDGET_DEFAULT_MB`). */
  texture_budget_mb?: number;
  /** The most frames per second Play and the export draw (30, 60, 120; absent or 0: none, the display's rate). */
  frame_rate_cap?: number;
  /** The kind of ambient occlusion where a look turns it on (0 off, 1 SSAO, 2 GTAO; absent: SSAO). */
  ambient_occlusion?: number;
  /** The share of the screen's resolution Play and the export draw at (0.5–1; absent: 1). */
  render_scale?: number;
  /** Whether the render scale drops while the GPU runs over budget (0 off, 1 on; absent: off). */
  dynamic_resolution?: number;
  /** The memory streamed terrain tiles and block chunks may take in Play and the export, MiB (absent: `STREAMING_BUDGET_DEFAULT_MB`). */
  streaming_budget_mb?: number;
  /** Exports ship generated architecture's meshes too (0 no, 1 yes; absent: no, generated at load). */
  architecture_ship_meshes?: number;
}
```

<a id="script-type-physics-step-client"></a>
## `PhysicsStepClient`

```ts
/** The restricted view handed to modules in `StepContext`. */
export interface PhysicsStepClient {
  /**
   * Controller phase only; a second stage for one entity is `duplicate_move`.
   * @graphNode skip scripts never run in the controller phase
   */
  stageCharacterMove(entityId: string, delta: Vec2): void;
  /**
   * A player controller's result of the last completed step (`entityId`, absent: the first player controller), or `undefined` before the first step.
   * @graphPure
   * @graphNode Character result
   * @graphLabel entityId player
   */
  characterResult(entityId?: string): CharacterMoveResult | undefined;
  /**
   * A ray against the level's colliders (bounded per step; null when nothing is hit).
   * @graphNode Raycast
   * @graphDefault direction [1, 0, 0]
   * @graphDefault maxDistance 10
   */
  raycast?(origin: Vec2, direction: Vec2, maxDistance: number): RaycastHit | null;
  /**
   * The entities whose colliders overlap a box (center, half extents) — counted with the rays.
   * @graphNode Overlap box
   * @graphDefault half [0.5, 0.5, 0]
   */
  overlapBox?(center: Vec2, half: Vec2): string[];
  /**
   * The entities whose colliders overlap a circle — counted with the rays.
   * @graphNode Overlap circle
   * @graphDefault radius 0.5
   */
  overlapCircle?(center: Vec2, radius: number): string[];
  /**
   * 3D projects: a player character's state after the last
   * completed step (`entityId`, absent: the first player controller) —
   * position, velocity, grounding, contacts, whether its controller is on
   * and whether it is climbing a ledge — or undefined (a 2D plane, before the
   * first step, or not a player controller).
   * @graphPure
   * @graphNode Character state
   * @graphLabel entityId player
   */
  characterState?(entityId?: string): CharacterState3D | undefined;
  /**
   * 3D projects: the nearest collider a ray from `origin` along `direction` hits within `maxDistance` metres (default 100), or null — its object, the point, the surface normal and the distance. Counted with the other queries (at most 64 a step).
   * @graphNode Raycast 3D
   * @graphDefault direction [0, -1, 0]
   * @graphDefault maxDistance 100
   */
  raycast3d?(origin: readonly number[], direction: readonly number[], maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * 3D projects: the objects whose colliders overlap a sphere (sorted ids, at most 64).
   * @graphNode Overlap sphere
   * @graphDefault radius 0.5
   */
  overlapSphere?(center: readonly number[], radius: number, filter?: PhysicsQueryFilter): string[];
  /**
   * 3D projects: the objects whose colliders overlap a box — centre, half extents [x, y, z] and an optional rotation quaternion [x, y, z, w].
   * @graphNode Overlap box 3D
   * @graphDefault half [0.5, 0.5, 0.5]
   */
  overlapBox3d?(center: readonly number[], half: readonly number[], rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * 3D projects: the objects whose colliders overlap an upright capsule (total height, end caps included), optionally turned by a quaternion [x, y, z, w].
   * @graphNode Overlap capsule
   * @graphDefault radius 0.3
   * @graphDefault height 1.8
   */
  overlapCapsule?(center: readonly number[], radius: number, height: number, rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * 3D projects: what is under a screen point (x, y 0–1 from the top left): the ray from the active camera (`ctx.camera.screenToRay`) cast into the colliders, within `maxDistance` (default 1000 m).
   * @graphNode Pick at screen point
   * @graphDefault x 0.5
   * @graphDefault y 0.5
   * @graphDefault maxDistance 1000
   */
  pickAt?(x: number, y: number, maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * 3D projects: what is under the pointer this step (null while the pointer is outside the view or never moved); with a locked cursor, what is at the view's centre.
   * @graphNode Pick at pointer
   * @graphDefault maxDistance 1000
   */
  pickAtPointer?(maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
}
```

<a id="script-type-behavior-tag-query"></a>
## `BehaviorTagQuery`

```ts
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
```

<a id="script-type-behavior-world-view"></a>
## `BehaviorWorldView`

```ts
/** A read-only view of entity transforms (`ctx.world`). */
export interface BehaviorWorldView {
  /**
   * The entity's transform this step so far, local to its parent (as the Inspector shows it; a root object's is its world transform), or `undefined` when it is not loaded.
   * `{space: 'world'}` reads the world transform instead (as `worldTransform`).
   * @graphPure
   * @graphNode Transform of
   */
  transform(entityId: string, options?: WorldTransformOptions): Readonly<{ position: readonly [number, number, number]; rotation: readonly [number, number, number, number]; scale: readonly [number, number, number] }> | undefined;
  /**
   * The entity's world transform this step so far: its transform composed up its parents, where it is drawn. Under a parent scaled unevenly and turned, the scale is the length of each world axis. `undefined` when it is not loaded.
   * @graphPure
   * @graphNode World transform of
   */
  worldTransform(entityId: string): Readonly<{ position: readonly [number, number, number]; rotation: readonly [number, number, number, number]; scale: readonly [number, number, number] }> | undefined;
  /**
   * The first loaded entity whose name is exactly `name` (case-sensitive), or `undefined`.
   * Entities are searched in load order: the start scene in document order, then later scenes and spawned copies as they arrived.
   * @graphPure
   * @graphNode Find object by name
   */
  find(name: string): string | undefined;
  /**
   * Every loaded entity whose name is exactly `name` (case-sensitive), in load order (spawned copies included).
   * @graphPure
   * @graphNode Find objects by name
   */
  findAll(name: string): readonly string[];
  /**
   * Every loaded entity carrying a component of this kind (as stored on the entity, e.g. `'collider'`, `'light'`, `'behavior'`), in load order (spawned copies included).
   * @graphPure
   * @graphNode Find objects with component
   */
  withComponent(kind: string): readonly string[];
}
```

<a id="script-type-behavior-scene-control"></a>
## `BehaviorSceneControl`

```ts
/** The scene API a behavior script reaches as `ctx.scenes`. */
export interface BehaviorSceneControl {
  /**
   * Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op.
   * @graphNode Load scene
   */
  load(sceneId: string, options?: SceneLoadOptions): void;
  /**
   * Request an unload at the next step boundary. Unloaded ⇒ no-op.
   * @graphNode Unload scene
   */
  unload(sceneId: string): void;
  /**
   * Request a reload at the next step boundary: the scene's objects return as authored (where it was loaded), the
   * copies its objects spawned go, its scripts start over (as at a run restart), its sounds stop. Kept objects,
   * `ctx.save`, the counters and the other scenes stay as they are. An unloaded scene loads; a loading one ⇒ no-op.
   * Refused for a scene holding a player that is not kept loaded.
   * @graphNode Reload scene
   */
  reload(sceneId: string): void;
  /**
   * Where a scene is in its load cycle.
   * @graphPure
   * @graphNode Scene status
   */
  status(sceneId: string): SceneStatus;
  /**
   * The loaded scene ids, in load order.
   * @graphPure
   * @graphNode Loaded scenes
   */
  loaded(): readonly string[];
  /**
   * The scenes being loaded (asked for, not yet in), in request order.
   * @graphPure
   * @graphNode Loading scenes
   */
  loading(): readonly string[];
  /**
   * The scene transition in progress (its scene, `out` while the view fades out, `loading` while the scene loads), or null.
   * @graphPure
   * @graphNode Scene transition
   */
  transition(): SceneTransitionView | null;
  /**
   * The active scene: its sky, fog, post-processing and wind are the look (the first start scene at first; a transition that unloads it makes its scene active).
   * @graphPure
   * @graphNode Active scene
   */
  active(): string | null;
  /**
   * Make a loaded scene the active one: its look blends in over `blend` seconds (0: at once). Applies with the step.
   * @graphNode Set active scene
   */
  setActive(sceneId: string, options?: SceneActivateOptions): void;
}
```

<a id="script-type-behavior-input-view"></a>
## `BehaviorInputView`

```ts
/**
 * `ctx.input` — the step's input actions by name. Without named
 * actions in the frame, `move` and `jump` still answer from the frame.
 */
export interface BehaviorInputView {
  /**
   * A button 0/1, a 1D axis −1..1, a 2D axis's length; 0 for an unknown name.
   * @graphPure
   * @graphNode Input value
   * @graphLabel name action
   */
  value(name: string): number;
  /**
   * A 2D axis as [x, y] ([value, 0] for others).
   * @graphPure
   * @graphNode Input vector
   * @graphLabel name action
   */
  vector(name: string): [number, number];
  /**
   * Pressed in this step.
   * @graphPure
   * @graphNode Input pressed
   * @graphLabel name action
   */
  pressed(name: string): boolean;
  /**
   * Released in this step.
   * @graphPure
   * @graphNode Input released
   * @graphLabel name action
   */
  released(name: string): boolean;
  /**
   * Down this step (pressed or held).
   * @graphPure
   * @graphNode Input held
   * @graphLabel name action
   */
  held(name: string): boolean;
  /**
   * The pointer this step — where it is in the view (x, y 0–1 from the top left), how far it moved since the last step, the wheel, whether it is over the view (and entered or left it this step), whether the cursor is locked and whether it is over a UI element (`overUi`: a click there went to the UI); null before the pointer is first seen.
   * @graphPure
   * @graphNode Pointer
   */
  pointer(): BehaviorPointer | null;
  /**
   * A pointer button (default left) went down this step — a click.
   * @graphPure
   * @graphNode Pointer pressed
   */
  pointerPressed(button?: 'left' | 'right' | 'middle'): boolean;
  /**
   * A pointer button (default left) went up this step.
   * @graphPure
   * @graphNode Pointer released
   */
  pointerReleased(button?: 'left' | 'right' | 'middle'): boolean;
  /**
   * A pointer button (default left) is down this step.
   * @graphPure
   * @graphNode Pointer held
   */
  pointerHeld(button?: 'left' | 'right' | 'middle'): boolean;
  /**
   * Any key, mouse or pad button that went down this step, bound to an action or not — its device (keyboard, mouse, gamepad) and code (a key's code such as `KeyK` or `Space`, `left`/`right`/`middle`, `button0`…), or null. A key or pad button before a mouse button when several went down.
   * @graphPure
   * @graphNode Any button pressed
   */
  anyPressed(): InputPress | null;
  /**
   * Ask for a free or a locked cursor (locked: hidden and held in the view — its movement still counts); 'auto' goes back to the active input map's setting. Takes effect after the step (the player may have to click the view once before the browser locks it).
   * @graphNode Set cursor
   */
  setCursor(mode: 'free' | 'locked' | 'auto'): void;
  /**
   * The device the player used last — `keyboardMouse` or `gamepad` (then with the pad's id and its family: xbox, playstation, switch or generic).
   * @graphNode skip use Using gamepad (the id and family are for glyph choices a script makes)
   */
  device(): InputDeviceStatus;
  /**
   * The player used a gamepad last (else the keyboard or mouse).
   * @graphPure
   * @graphNode Using gamepad
   */
  usingGamepad(): boolean;
  /**
   * Every project action with the player's current bindings — per binding its device (keyboard, mouse, gamepad), kind, label and icon (and a composite's parts). A binding's position is the index `rebind` takes.
   * @graphNode skip a list of records; a graph reads Action glyph label / icon
   */
  bindings(): readonly InputActionStatus[];
  /**
   * What to show for an action on a device (default: the device used last) — its first binding from that device as a label, an icon id of the engine's glyph set and the project's own image; null when it has none.
   * @graphNode skip an object with parts; a graph reads Action glyph label / icon
   */
  glyph(action: string, device?: InputDeviceKind): InputGlyph | null;
  /**
   * An action's glyph label for the device used last ('' when it has no binding there) — e.g. "Space", "A", "Cross".
   * @graphPure
   * @graphNode Action glyph label
   */
  glyphLabel(action: string): string;
  /**
   * An action's glyph icon id for the device used last ('' when it has no binding there) — e.g. key, pad-south, mouse-left.
   * @graphPure
   * @graphNode Action glyph icon
   */
  glyphIcon(action: string): string;
  /**
   * What became of binding requests this step (started, rebound, cancelled, timeout, refused, reset, profile).
   * @graphNode skip a list of records; a graph reads Rebinding
   */
  rebindEvents(): readonly InputRebindEvent[];
  /**
   * The rebind listening for input now (action, binding index, part), or null.
   * @graphPure
   * @graphNode Rebinding
   */
  rebinding(): InputRebindTarget | null;
  /**
   * Listen for the next key, button or axis and bind it to an action (a binding index and part, the device, the conflict policy swap/refuse/allow, the cancel key and a timeout in seconds). The host listens after the step; the outcome arrives in `rebindEvents()`.
   * @graphNode skip its options would all be set by a node (part, device); scripts call it
   */
  rebind(action: string, options?: InputRebindOptions): void;
  /**
   * Stop listening for a rebind.
   * @graphNode Cancel rebind
   */
  cancelRebind(): void;
  /**
   * Reset one action's bindings (or all, without a name) to the project's defaults.
   * @graphNode Reset bindings
   */
  resetBindings(action?: string): void;
  /**
   * Use another player profile's saved bindings (a name of 1–32 letters, digits, _ or -; 'default' first).
   * @graphNode Use binding profile
   */
  useBindingProfile(profile: string): void;
  /**
   * The player profile whose bindings are in effect.
   * @graphPure
   * @graphNode Binding profile
   */
  bindingProfile(): string;
}
```

<a id="script-type-behavior-animator-handle"></a>
## `BehaviorAnimatorHandle`

```ts
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
   * Go to a state by name over `fade` seconds (0: at once), on layer `layer` (0: the base layer, 1 the first override layer), the state starting at normalized time `time` (0–1 of its length; 0: its beginning). False for an unknown state or layer, or a time below 0.
   * @graphNode Play animator state
   * @graphLabel state state
   */
  play(state: string, fade?: number, layer?: number, time?: number): boolean;
  /**
   * The object the look-at constraint turns the head toward (its origin), or null for nothing (the head turns back at its turn speed). False when the animator has no look-at.
   * @graphNode Set look target
   * @graphLabel targetId target
   */
  setLookTarget(targetId: string | null): boolean;
  /**
   * A world point [x, y, z] the look-at constraint turns the head toward (in place of a target object). False when the animator has no look-at or the point is not three finite numbers.
   * @graphNode Set look point
   */
  setLookPoint(point: readonly [number, number, number]): boolean;
  /**
   * The look-at constraint's weight (0–1; 0: the clip pose alone — the head turns back at its turn speed). False when the animator has no look-at or the weight is outside 0–1.
   * @graphNode Set look weight
   * @graphDefault weight 1
   */
  setLookWeight(weight: number): boolean;
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
```

<a id="script-type-animator-event-record"></a>
## `AnimatorEventRecord`

```ts
/** A clip event an animator passed. */
export interface AnimatorEventRecord {
  readonly entityId: string;
  readonly name: string;
  readonly clip: string;
  /** The step in which the clip passed the event. */
  readonly stepIndex: number;
}
```

<a id="script-type-trigger-event-record"></a>
## `TriggerEventRecord`

```ts
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
  /** The player character that entered or left (a player controller's object; one event each, as a collect event's `by`). */
  readonly by: string;
  readonly stepIndex: number;
}
```

<a id="script-type-primitive-event-record"></a>
## `PrimitiveEventRecord`

```ts
export type PrimitiveEventRecord = HealthEventRecord | ContactEventRecord | PatrolEventRecord | CollectEventRecord;
```

<a id="script-type-behavior-timers"></a>
## `BehaviorTimers`

```ts
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
```

<a id="script-type-behavior-random"></a>
## `BehaviorRandom`

```ts
/**
 * `ctx.random` — the instance's main seeded stream, plus named sub-streams.
 */
export interface BehaviorRandom extends BehaviorRandomStream {
  /**
   * An independent named stream of this object (the same name gives the same stream):
   * draws from one never shift the numbers of another, so adding a draw for loot does
   * not change the numbers used for movement. Names: 1–64 characters of letters, digits,
   * `_ . : -`; at most 64 streams per object.
   * @graphLabel name stream
   */
  stream(name: string): BehaviorRandomStream;
}
```

<a id="script-type-behavior-signals"></a>
## `BehaviorSignals`

```ts
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
```

<a id="script-type-behavior-messages"></a>
## `BehaviorMessages`

```ts
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
```

<a id="script-type-behavior-game-state"></a>
## `BehaviorGameState`

```ts
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
   * A player character's health (a controller's object: `entityId`, absent: the first player controller), or null when it has none.
   * @graphPure
   * @graphNode Player health
   * @graphLabel entityId player
   */
  health(entityId?: string): { current: number; max: number } | null;
  /**
   * Show or hide an entity (and its children) until the next run; it still collides and triggers.
   * @graphNode Set visible
   * @graphDefault visible true
   */
  setVisible(entityId: string, visible: boolean): void;
}
```

<a id="script-type-behavior-health"></a>
## `BehaviorHealth`

```ts
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
```
