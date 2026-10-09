# Script API

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The API a script (a behavior) is written against: `import type { BehaviorContext } from '@thirdlight/runtime'`. Generated from the runtime's types; the script editor completes and checks the same declarations.

<a id="script-spec"></a>
## What a script exports

A script's default export is a `BehaviorSpec`: its callbacks receive the object's state and the context `ctx`.

| Member | Kind | Type | Its type | Summary |
|---|---|---|---|---|
| `prepare?` | method | `(cfg: BehaviorPrepareConfig): Prepared` |  |  |
| `instantiate?` | method | `(prepared: Prepared, inst: BehaviorInstanceInfo): State` |  |  |
| `step?` | method | `(state: State, ctx: BehaviorContext): void` |  | Every fixed step, once per phase the behavior runs in (optional when the script has callbacks). |
| `dispose?` | method | `(prepared: Prepared, state: State): void` |  |  |
| `onEnable?` | method | `(state: State, ctx: BehaviorContext): void` |  | The object is in the game and switched on — its first step (a run's start, a scene load, a spawned copy) and each time it is switched on again (`set('object', { active: true })`). |
| `onDisable?` | method | `(state: State, ctx: BehaviorContext): void` |  | The object was switched off (itself or an object above it), or it is leaving the game. |
| `onDestroy?` | method | `(state: State, ctx: BehaviorContext): void` |  | The object left the game (destroyed, or its scene unloaded) — in the step it left, after `onDisable`; the object is already gone (`ctx.entity(ctx.entityId)` is null). |
| `onTriggerEnter?` | method | `(state: State, event: TriggerEventRecord, ctx: BehaviorContext): void` |  | The player entered a trigger this script owns (on its object, below it, or named by one of its object properties) in the last step. |
| `onTriggerExit?` | method | `(state: State, event: TriggerEventRecord, ctx: BehaviorContext): void` |  | The player left a trigger this script owns in the last step. |
| `onContact?` | method | `(state: State, event: ContactEventRecord, ctx: BehaviorContext): void` |  | A hitbox this script owns began (`type: 'contact'`) or stopped (`'separate'`) touching something in the last step. |
| `onMessage?` | method | `(state: State, message: BehaviorMessage, ctx: BehaviorContext): void` |  | A message sent in the last step to every script or to this object (`ctx.messages.send`). |
| `onUiEvent?` | method | `(state: State, event: UiEventRecord, ctx: BehaviorContext): void` |  | A UI event of this step (a button, a submitted input, a document shown or hidden). |
| `onAnimatorEvent?` | method | `(state: State, event: AnimatorEventRecord, ctx: BehaviorContext): void` |  | A clip event an animator this script owns passed in the last step. |
| `debug?` | method | `(state: State): unknown` |  | What a debugger may read of an instance's state (Play's visual-script debugger: the trace of the step, wire values, variables). |

<a id="ctx"></a>
## The context (`ctx`)

What `step(state, ctx)` and the other callbacks receive. A member's own page section has its full declaration.

| Member | Kind | Type | Its type | Summary |
|---|---|---|---|---|
| `ctx.behaviorId` | property | `string` |  | The behavior's id. |
| `ctx.entityId` | property | `string` |  | The entity carrying this script instance. |
| `ctx.stepIndex` | property | `number` |  | The fixed step counter of the run. |
| `ctx.phase` | property | `SimulationPhase` |  | The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms). |
| `ctx.properties` | property | `Readonly<Record<string, PropertyValue>>` |  | The instance's property values (declaration defaults with the object's overrides). |
| `ctx.action` | property | `ActionFrame` | [`ActionFrame`](script-types-behavior-context.md#script-type-action-frame) | The step's sampled input frame (the same for every phase of the step). |
| `ctx.intents` | property | `IntentSet` | [`IntentSet`](script-types-behavior-context.md#script-type-intent-set) | The intents committed so far in this step. |
| `ctx.settings` | property | `Readonly<GameplaySettings>` | `Readonly<GameplaySettings>` | The game's gameplay settings. |
| `ctx.physics` | property | `PhysicsStepClient` | [`PhysicsStepClient`](script-types-behavior-context.md#script-type-physics-step-client) | Physics queries for this step. |
| `ctx.tags` | property | `BehaviorTagQuery` | [`BehaviorTagQuery`](script-types-behavior-context.md#script-type-behavior-tag-query) | Find entities by tag. |
| `ctx.world` | property | `BehaviorWorldView` | [`BehaviorWorldView`](script-types-behavior-context.md#script-type-behavior-world-view) | Read-only positions of the loaded entities. |
| `ctx.scenes?` | property | `BehaviorSceneControl \| undefined` | [`BehaviorSceneControl`](script-types-behavior-context.md#script-type-behavior-scene-control) | Load and switch scenes (projects with a scene catalog). |
| `ctx.input` | property | `BehaviorInputView` | [`BehaviorInputView`](script-types-behavior-context.md#script-type-behavior-input-view) | The step's input actions by name. |
| `ctx.animator?` | method | `(entityId: string): BehaviorAnimatorHandle \| null` | [`BehaviorAnimatorHandle`](script-types-behavior-context.md#script-type-behavior-animator-handle) | An entity's animator (`ctx.animator(id)?.set('speed', 1)`), or null when it has none. |
| `ctx.events?` | property | `readonly (AnimatorEventRecord \| TriggerEventRecord \| PrimitiveEventRecord)[] \| undefined` |  | Last step's clip events, the enter/exit events of the triggers this instance owns, and the health, collect, patrol and contact events of the objects it owns (its own, those below it, and those its object properties name). |
| `ctx.timers` | property | `BehaviorTimers` | [`BehaviorTimers`](script-types-behavior-context.md#script-type-behavior-timers) | Named timers of this instance, counted in fixed steps. |
| `ctx.random` | property | `BehaviorRandom` | [`BehaviorRandom`](script-types-behavior-context.md#script-type-behavior-random) | Seeded random numbers of this instance (replay-safe; the project's `random_seed` setting with this script and object), with named sub-streams. |
| `ctx.signals?` | property | `BehaviorSignals \| undefined` | [`BehaviorSignals`](script-types-behavior-context.md#script-type-behavior-signals) | Signals (seen one step after they are emitted). |
| `ctx.messages?` | property | `BehaviorMessages \| undefined` | [`BehaviorMessages`](script-types-behavior-context.md#script-type-behavior-messages) | Messages to other scripts, with a value (seen one step after they are sent). |
| `ctx.game?` | property | `BehaviorGameState \| undefined` | [`BehaviorGameState`](script-types-behavior-context.md#script-type-behavior-game-state) | The run's counters, the player's health and object visibility. |
| `ctx.health?` | property | `BehaviorHealth \| undefined` | [`BehaviorHealth`](script-types-behavior-context.md#script-type-behavior-health) | Any object's health — read, damage and heal it; its events arrive in `ctx.events`. |
| `ctx.patrol?` | property | `BehaviorPatrol \| undefined` | [`BehaviorPatrol`](script-types-behavior-patrol.md#script-type-behavior-patrol) | Patrollers — which way they walk, stop them, turn them around. |
| `ctx.hitbox?` | property | `BehaviorHitbox \| undefined` | [`BehaviorHitbox`](script-types-behavior-patrol.md#script-type-behavior-hitbox) | Hitboxes — switch them off and on, what they touch. |
| `ctx.collectible?` | property | `BehaviorCollectible \| undefined` | [`BehaviorCollectible`](script-types-behavior-patrol.md#script-type-behavior-collectible) | Collectibles — collected or not, bring one back. |
| `ctx.character?` | property | `BehaviorCharacter \| undefined` | [`BehaviorCharacter`](script-types-behavior-patrol.md#script-type-behavior-character) | The character — give it an impulse. |
| `ctx.look?` | property | `BehaviorLook \| undefined` | [`BehaviorLook`](script-types-behavior-patrol.md#script-type-behavior-look) | Per-object look overrides — a glow or a tint, set and cleared. |
| `ctx.audio?` | property | `BehaviorAudio \| undefined` | [`BehaviorAudio`](script-types-behavior-patrol.md#script-type-behavior-audio) | Play sounds (presentation only, never part of the simulation). |
| `ctx.effects?` | property | `BehaviorEffects \| undefined` | [`BehaviorEffects`](script-types-behavior-patrol.md#script-type-behavior-effects) | Play visual effects (presentation only, never part of the simulation). |
| `ctx.save?` | property | `BehaviorSave \| undefined` | [`BehaviorSave`](script-types-behavior-patrol.md#script-type-behavior-save) | Values kept in the player's save. |
| `ctx.debug?` | property | `BehaviorDebug \| undefined` | [`BehaviorDebug`](script-types-behavior-patrol.md#script-type-behavior-debug) | Project debug commands (run by tools and the in-game console, recorded with the input). |
| `ctx.grid?` | property | `BehaviorGrid \| undefined` | [`BehaviorGrid`](script-types-behavior-patrol.md#script-type-behavior-grid) | The block layers of the loaded scenes — read and write cells and their metadata, pick a cell with a ray, neighbours, named regions, change events, a diff for saves. |
| `ctx.scatter?` | property | `BehaviorScatter \| undefined` | [`BehaviorScatter`](script-types-behavior-patrol.md#script-type-behavior-scatter) | The trees, rocks and other copies the terrains' and block layers' scatter rules placed — find them by place, read them by address, hide, show or remove one (a ray that hits one names it: `PhysicsHit.scatter`). |
| `ctx.splines?` | property | `BehaviorSplines \| undefined` | [`BehaviorSplines`](script-types-behavior-patrol.md#script-type-behavior-splines) | The splines of the loaded scenes — a place and cross-section along one, its length, the nearest place on it. |
| `ctx.surface?` | property | `BehaviorSurface \| undefined` | [`BehaviorSurface`](script-types-behavior-patrol.md#script-type-behavior-surface) | The ground at a point from whichever block layer or terrain is there — height, normal, slope, material layer weights (footsteps, effects, placing things). |
| `ctx.spawn?` | method | `(prefabId: string, options: { position: readonly number[]; rotation?: readonly number[] \| undefined; scale?: number \| readonly number[] \| undefined; properties?: Readonly<Record<string, unknown>> \| undefined; }): string \| null` |  | Copy a project prefab into the running game; returns the new root id (or null at an engine limit). |
| `ctx.destroy?` | method | `(entityId: string): boolean` |  | Remove a spawned entity at the next step boundary. |
| `ctx.emit` | method | `(intent: BehaviorIntent): boolean` |  | Commit one intent (a transform/pose of an owned entity, or a gameplay intent). |
| `ctx.log` | method | `(level: BehaviorLogLevel, message: string): void` |  | Write to the play log (`'info' \| 'warn' \| 'error'`). |
| `ctx.camera?` | property | `BehaviorCamera \| undefined` | [`BehaviorCamera`](script-types-behavior-patrol.md#script-type-behavior-camera) | The virtual cameras — activate, priorities, rig values, shake, screen↔world. |
| `ctx.sockets?` | property | `BehaviorSockets \| undefined` | [`BehaviorSockets`](script-types-behavior-patrol.md#script-type-behavior-sockets) | Objects riding on named nodes of other objects' models — attach, detach, node poses. |
| `ctx.materials?` | property | `BehaviorMaterials \| undefined` | [`BehaviorMaterials`](script-types-behavior-patrol.md#script-type-behavior-materials) | Graph-material parameters per object — set a value (number, vector, colour, texture) or write the cells of a data parameter on one object; others wearing the material keep theirs. |
| `ctx.saves?` | property | `BehaviorSaves \| undefined` | [`BehaviorSaves`](script-types-behavior-patrol.md#script-type-behavior-saves) | The project's save document and numbered slots (save, load, delete, the slot list with title/chapter/location/play time/picture) and the project settings document. |
| `ctx.assets?` | property | `BehaviorAssets \| undefined` | [`BehaviorAssets`](script-types-behavior-patrol.md#script-type-behavior-assets) | Load assets by id, address or label and release them: a handle's state says when they are ready (the game never waits for a load); release every handle you load. |
| `ctx.ui?` | property | `BehaviorUi \| undefined` | [`BehaviorUi`](script-types-behavior-patrol.md#script-type-behavior-ui) | The project UI — publish view-model values, show and hide UI documents, read the step's UI events. |
| `ctx.stats?` | property | `BehaviorStats \| undefined` | [`BehaviorStats`](script-types-behavior-stats.md#script-type-behavior-stats) | How the game runs on this device (read-only): fps, frame, CPU and GPU times (average and worst over the last window; GPU null where not measured), draw calls, triangles, resident texture bytes against the budget, geometry bytes, objects, the quality level. |
| `ctx.display?` | property | `BehaviorDisplay \| undefined` | [`BehaviorDisplay`](script-types-behavior-stats.md#script-type-behavior-display) | The frame-rate cap: the most frames per second the page draws (30, 60, 120 or none) — read it and set it. |
| `ctx.dialogue?` | property | `BehaviorDialogue \| undefined` | [`BehaviorDialogue`](script-types-behavior-stats.md#script-type-behavior-dialogue) | Conversations — start a dialogue, advance, choose, skip seen lines, auto-advance, dialogue variables, the backlog and the events of lines, choices and signals. |
| `ctx.modes?` | property | `BehaviorModes \| undefined` | [`BehaviorModes`](script-types-behavior-stats.md#script-type-behavior-modes) | The game modes — the current mode, switching (input maps, camera, UI, ticking groups together), enter/exit events. |
| `ctx.lifecycle?` | property | `BehaviorLifecycle \| undefined` | [`BehaviorLifecycle`](script-types-behavior-stats.md#script-type-behavior-lifecycle) | The run lifecycle — respawn the character at a spawn, restart the run. |
| `ctx.timeline?` | property | `BehaviorTimeline \| undefined` | [`BehaviorTimeline`](script-types-behavior-stats.md#script-type-behavior-timeline) | Timelines — play, pause, skip, seek and stop project timelines; their events and markers. |
| `ctx.environment?` | property | `BehaviorEnvironment \| undefined` | [`BehaviorEnvironment`](script-types-behavior-stats.md#script-type-behavior-environment) | The environment presets — switch or blend sky, fog, lights, exposure and grading at run time. |
| `ctx.entity?` | method | `(entityId: string \| null): BehaviorEntityHandle \| null` | [`BehaviorEntityHandle`](script-types-behavior-stats.md#script-type-behavior-entity-handle) | One loaded object by id (an object property's value, a spawned copy's id, `ctx.entityId`) — read any component (`get`: the step-start state of its script-readable fields) and write the fields marked writable (`set`: applied at the end of the step). |
| `ctx.shell?` | property | `BehaviorShell \| undefined` | [`BehaviorShell`](script-types-behavior-stats.md#script-type-behavior-shell) | The game shell's scene list — move to the next entry (the shell's nextScene action). |

<a id="ctx-docs"></a>
## Context members in full

<a id="ctx-behavior-id"></a>**`ctx.behaviorId`** — The behavior's id.

<a id="ctx-entity-id"></a>**`ctx.entityId`** — The entity carrying this script instance.

<a id="ctx-step-index"></a>**`ctx.stepIndex`** — The fixed step counter of the run.

<a id="ctx-phase"></a>**`ctx.phase`** — The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms).

<a id="ctx-properties"></a>**`ctx.properties`** — The instance's property values (declaration defaults with the object's overrides).

<a id="ctx-action"></a>**`ctx.action`** — The step's sampled input frame (the same for every phase of the step).

<a id="ctx-intents"></a>**`ctx.intents`** — The intents committed so far in this step.

<a id="ctx-settings"></a>**`ctx.settings`** — The game's gameplay settings.

<a id="ctx-physics"></a>**`ctx.physics`** — Physics queries for this step.

<a id="ctx-tags"></a>**`ctx.tags`** — Find entities by tag.

<a id="ctx-world"></a>**`ctx.world`** — Read-only positions of the loaded entities.

<a id="ctx-scenes"></a>**`ctx.scenes`** — Load and switch scenes (projects with a scene catalog).

<a id="ctx-input"></a>**`ctx.input`** — The step's input actions by name.

<a id="ctx-animator"></a>**`ctx.animator`** — An entity's animator (`ctx.animator(id)?.set('speed', 1)`), or null when it has none.

<a id="ctx-events"></a>**`ctx.events`** — Last step's clip events, the enter/exit events of the triggers this instance owns, and
the health, collect, patrol and contact events of the objects it owns (its own, those below it, and
those its object properties name).

<a id="ctx-timers"></a>**`ctx.timers`** — Named timers of this instance, counted in fixed steps.

<a id="ctx-random"></a>**`ctx.random`** — Seeded random numbers of this instance (replay-safe; the project's
`random_seed` setting with this script and object), with named sub-streams.

<a id="ctx-signals"></a>**`ctx.signals`** — Signals (seen one step after they are emitted).

<a id="ctx-messages"></a>**`ctx.messages`** — Messages to other scripts, with a value (seen one step after they are sent).

<a id="ctx-game"></a>**`ctx.game`** — The run's counters, the player's health and object visibility.

<a id="ctx-health"></a>**`ctx.health`** — Any object's health — read, damage and heal it; its events arrive in `ctx.events`.

<a id="ctx-patrol"></a>**`ctx.patrol`** — Patrollers — which way they walk, stop them, turn them around.

<a id="ctx-hitbox"></a>**`ctx.hitbox`** — Hitboxes — switch them off and on, what they touch.

<a id="ctx-collectible"></a>**`ctx.collectible`** — Collectibles — collected or not, bring one back.

<a id="ctx-character"></a>**`ctx.character`** — The character — give it an impulse.

<a id="ctx-look"></a>**`ctx.look`** — Per-object look overrides — a glow or a tint, set and cleared.

<a id="ctx-audio"></a>**`ctx.audio`** — Play sounds (presentation only, never part of the simulation).

<a id="ctx-effects"></a>**`ctx.effects`** — Play visual effects (presentation only, never part of the simulation).

<a id="ctx-save"></a>**`ctx.save`** — Values kept in the player's save.

<a id="ctx-debug"></a>**`ctx.debug`** — Project debug commands (run by tools and the in-game console, recorded with the input).

<a id="ctx-grid"></a>**`ctx.grid`** — The block layers of the loaded scenes — read and write cells and their
metadata, pick a cell with a ray, neighbours, named regions, change events, a diff for saves.

<a id="ctx-scatter"></a>**`ctx.scatter`** — The trees, rocks and other copies the terrains' and block layers' scatter
rules placed — find them by place, read them by address, hide, show or
remove one (a ray that hits one names it: `PhysicsHit.scatter`).

<a id="ctx-splines"></a>**`ctx.splines`** — The splines of the loaded scenes — a place and cross-section along one, its length, the nearest place on it.

<a id="ctx-surface"></a>**`ctx.surface`** — The ground at a point from whichever block layer or terrain is there — height, normal, slope, material layer weights (footsteps, effects, placing things).

<a id="ctx-spawn"></a>**`ctx.spawn`** — Copy a project prefab into the running game; returns the new root id (or null at an engine limit).

<a id="ctx-destroy"></a>**`ctx.destroy`** — Remove a spawned entity at the next step boundary.

<a id="ctx-emit"></a>**`ctx.emit`** — Commit one intent (a transform/pose of an owned entity, or a gameplay intent).
Returns false when the runtime refuses it (a bad shape or value, the wrong
phase, an entity this script does not own, a second write of the same
channel in the step, the per-step limit): nothing is committed and the
refusal is logged once; the run goes on.

<a id="ctx-log"></a>**`ctx.log`** — Write to the play log (`'info' | 'warn' | 'error'`).

<a id="ctx-camera"></a>**`ctx.camera`** — The virtual cameras — activate, priorities, rig values, shake, screen↔world.

<a id="ctx-sockets"></a>**`ctx.sockets`** — Objects riding on named nodes of other objects' models — attach, detach, node poses.

<a id="ctx-materials"></a>**`ctx.materials`** — Graph-material parameters per object — set a value (number, vector, colour,
texture) or write the cells of a data parameter on one object; others wearing the material keep theirs.

<a id="ctx-saves"></a>**`ctx.saves`** — The project's save document and numbered slots (save, load, delete, the slot list
with title/chapter/location/play time/picture) and the project settings document.

<a id="ctx-assets"></a>**`ctx.assets`** — Load assets by id, address or label and release them: a handle's state says when they are ready
(the game never waits for a load); release every handle you load.

<a id="ctx-ui"></a>**`ctx.ui`** — The project UI — publish view-model values, show and hide UI documents, read the step's UI events.

<a id="ctx-stats"></a>**`ctx.stats`** — How the game runs on this device (read-only): fps, frame, CPU and GPU times (average and worst over the
last window; GPU null where not measured), draw calls, triangles, resident texture bytes against the budget,
geometry bytes, objects, the quality level. Measured by the page, not simulation state.

<a id="ctx-display"></a>**`ctx.display`** — The frame-rate cap: the most frames per second the page draws (30, 60, 120 or none) — read it and set it.
Presentation: game time keeps its fixed step.

<a id="ctx-dialogue"></a>**`ctx.dialogue`** — Conversations — start a dialogue, advance, choose, skip seen lines, auto-advance,
dialogue variables, the backlog and the events of lines, choices and signals.

<a id="ctx-modes"></a>**`ctx.modes`** — The game modes — the current mode, switching (input maps, camera, UI, ticking groups together), enter/exit events.

<a id="ctx-lifecycle"></a>**`ctx.lifecycle`** — The run lifecycle — respawn the character at a spawn, restart the run.

<a id="ctx-timeline"></a>**`ctx.timeline`** — Timelines — play, pause, skip, seek and stop project timelines; their events and markers.

<a id="ctx-environment"></a>**`ctx.environment`** — The environment presets — switch or blend sky, fog, lights, exposure and grading at run time.

<a id="ctx-entity"></a>**`ctx.entity`** — One loaded object by id (an object property's value, a spawned copy's id, `ctx.entityId`) —
read any component (`get`: the step-start state of its script-readable fields) and write the fields
marked writable (`set`: applied at the end of the step). Null for no id or an object that is not loaded.

<a id="ctx-shell"></a>**`ctx.shell`** — The game shell's scene list — move to the next entry (the shell's nextScene action).

<a id="script-behavior-prepare-config"></a>
## `BehaviorPrepareConfig`

| Member | Kind | Type | Its type | Summary |
|---|---|---|---|---|
| `behaviorId` | property | `string` |  |  |
| `sourceDigest` | property | `string` |  |  |
| `declaration` | property | `PropertyDeclaration` | [`PropertyDeclaration`](script-types-behavior-stats.md#script-type-property-declaration) |  |
| `enginePins` | property | `readonly BehaviorEnginePin[]` |  |  |

<a id="script-behavior-instance-info"></a>
## `BehaviorInstanceInfo`

| Member | Kind | Type | Its type | Summary |
|---|---|---|---|---|
| `entityId` | property | `string` |  |  |
| `properties` | property | `Readonly<Record<string, PropertyValue>>` |  |  |
| `tags` | property | `BehaviorTagQuery` | [`BehaviorTagQuery`](script-types-behavior-context.md#script-type-behavior-tag-query) |  |
