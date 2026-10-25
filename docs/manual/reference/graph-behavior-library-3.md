# Graph: Shared script function (part 3, from Saves)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Shared script function node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-behavior-library--saves"></a>
## Saves

- [Save version](graph-behavior-6.md#node-behavior--api-saves-version) (`api.saves.version`, as in `behavior`): The save document's schema version (0: the project declares no save schema).
- [Save slot count](graph-behavior-6.md#node-behavior--api-saves-slot-count) (`api.saves.slotCount`, as in `behavior`): How many slots the game offers.
- [Write save document](graph-behavior-6.md#node-behavior--api-saves-write) (`api.saves.write`, as in `behavior`): Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.
- [Save document](graph-behavior-6.md#node-behavior--api-saves-read) (`api.saves.read`, as in `behavior`): The project's save document (a copy; null before one is written or loaded).
- [Save to slot](graph-behavior-6.md#node-behavior--api-saves-save) (`api.saves.save`, as in `behavior`): Save to a slot at the end of this step (the document and the engine sections of the schema); the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (names → texts; the record at most 4 KiB as JSON). False for a slot the game does not have or a meta that does not fit.
- [Load slot](graph-behavior-6.md#node-behavior--api-saves-load) (`api.saves.load`, as in `behavior`): Load a slot: when storage answers, the document is migrated and restored at the end of that step (the outcome in `results()`).
- [Delete slot](graph-behavior-6.md#node-behavior--api-saves-delete) (`api.saves.delete`, as in `behavior`): Delete a slot (the outcome in `results()`).
- [Save slots](graph-behavior-6.md#node-behavior--api-saves-slots) (`api.saves.slots`, as in `behavior`): The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).
- [Save slots ready](graph-behavior-6.md#node-behavior--api-saves-ready) (`api.saves.ready`, as in `behavior`): Whether the slot list has arrived from storage (it is empty before).
- [Save results](graph-behavior-6.md#node-behavior--api-saves-results) (`api.saves.results`, as in `behavior`): The outcomes that arrived this step (saves, loads and deletes).
- [Save storage](graph-behavior-6.md#node-behavior--api-saves-storage) (`api.saves.storage`, as in `behavior`): The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.
- [Play time](graph-behavior-6.md#node-behavior--api-saves-play-seconds) (`api.saves.playSeconds`, as in `behavior`): Play time in seconds (restored with a loaded save).
- [Setting](graph-behavior-6.md#node-behavior--api-saves-setting) (`api.saves.setting`, as in `behavior`): A value of the project settings document (its default until the player changes it).
- [Settings document](graph-behavior-6.md#node-behavior--api-saves-settings) (`api.saves.settings`, as in `behavior`): The whole project settings document (a copy).
- [Set setting](graph-behavior-6.md#node-behavior--api-saves-set-setting) (`api.saves.setSetting`, as in `behavior`): Change a value of the project settings document (kept in the player's browser; an engine setting it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.

<a id="graph-behavior-library--assets"></a>
## Assets

- [Load assets](graph-behavior-6.md#node-behavior--api-assets-load) (`api.assets.load`, as in `behavior`): Start loading the asset or resource with this id or address, or every one with this label. Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading' until the assets are ready, a later step.
- [Release assets](graph-behavior-6.md#node-behavior--api-assets-release) (`api.assets.release`, as in `behavior`): Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
- [Assets state](graph-behavior-6.md#node-behavior--api-assets-state) (`api.assets.state`, as in `behavior`): A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
- [Assets ready](graph-behavior-6.md#node-behavior--api-assets-ready) (`api.assets.ready`, as in `behavior`): True once a handle's assets are loaded.
- [Assets error](graph-behavior-6.md#node-behavior--api-assets-error) (`api.assets.error`, as in `behavior`): Why a failed handle failed ('' otherwise).

<a id="graph-behavior-library--ui"></a>
## UI

- [Set UI value](graph-behavior-6.md#node-behavior--api-ui-set) (`api.ui.set`, as in `behavior`): Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
- [UI value](graph-behavior-6.md#node-behavior--api-ui-get) (`api.ui.get`, as in `behavior`): The published value at a path (null when there is none).
- [Clear UI value](graph-behavior-6.md#node-behavior--api-ui-clear) (`api.ui.clear`, as in `behavior`): Remove a path from the view model (`false` when it was not there).
- [Show UI](graph-behavior-6.md#node-behavior--api-ui-show) (`api.ui.show`, as in `behavior`): Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
- [Hide UI](graph-behavior-6.md#node-behavior--api-ui-hide) (`api.ui.hide`, as in `behavior`): Hide a shown UI document (`false` when it was not shown).
- [UI shown](graph-behavior-6.md#node-behavior--api-ui-is-shown) (`api.ui.isShown`, as in `behavior`): The document is shown.
- [Play UI tween](graph-behavior-6.md#node-behavior--api-ui-play) (`api.ui.play`, as in `behavior`): Play a tween of a document (on a widget, or the whole document). Presentation only.
- [Focus UI widget](graph-behavior-6.md#node-behavior--api-ui-focus) (`api.ui.focus`, as in `behavior`): Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.
- [UI view](graph-behavior-6.md#node-behavior--api-ui-view) (`api.ui.view`, as in `behavior`): The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.
- [UI events](graph-behavior-6.md#node-behavior--api-ui-events) (`api.ui.events`, as in `behavior`): The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
- [UI event](graph-behavior-6.md#node-behavior--api-ui-event) (`api.ui.event`, as in `behavior`): The first UI event of this step with this name (a button's or an input's event), or null.

<a id="graph-behavior-library--stats"></a>
## Stats

- [Stats fps](graph-behavior-6.md#node-behavior--api-stats-fps) (`api.stats.fps`, as in `behavior`): Frames drawn per second over the window.
- [Stats frame ms](graph-behavior-6.md#node-behavior--api-stats-frame-ms) (`api.stats.frameMs`, as in `behavior`): The time from one frame to the next (ms).
- [Stats cpu ms](graph-behavior-6.md#node-behavior--api-stats-cpu-ms) (`api.stats.cpuMs`, as in `behavior`): The page thread's work per frame (ms): the simulation's steps when it runs on the page, the frame's host work and the draw calls' submission.
- [Stats gpu ms](graph-behavior-6.md#node-behavior--api-stats-gpu-ms) (`api.stats.gpuMs`, as in `behavior`): The GPU's time per frame (ms) from timestamp queries; null where the browser or GPU has none (not measured).
- [Stats draw calls](graph-behavior-6.md#node-behavior--api-stats-draw-calls) (`api.stats.drawCalls`, as in `behavior`): Draw calls of the last frame.
- [Stats triangles](graph-behavior-6.md#node-behavior--api-stats-triangles) (`api.stats.triangles`, as in `behavior`): Triangles of the last frame.
- [Stats texture bytes](graph-behavior-6.md#node-behavior--api-stats-texture-bytes) (`api.stats.textureBytes`, as in `behavior`): Texture bytes resident on the GPU (streamed and fixed, images inside models included).
- [Stats texture budget bytes](graph-behavior-6.md#node-behavior--api-stats-texture-budget-bytes) (`api.stats.textureBudgetBytes`, as in `behavior`): The texture budget (bytes; the setting texture_budget_mb).
- [Stats geometry bytes](graph-behavior-6.md#node-behavior--api-stats-geometry-bytes) (`api.stats.geometryBytes`, as in `behavior`): Geometry bytes of the loaded models.
- [Stats entities](graph-behavior-6.md#node-behavior--api-stats-entities) (`api.stats.entities`, as in `behavior`): Objects in the simulation.
- [Stats quality](graph-behavior-6.md#node-behavior--api-stats-quality) (`api.stats.quality`, as in `behavior`): The quality level drawn: its id ("low", "medium", "high", or one of the project's own levels).
- [Stats frame rate cap](graph-behavior-6.md#node-behavior--api-stats-frame-rate-cap) (`api.stats.frameRateCap`, as in `behavior`): The frame-rate cap the page draws under (30, 60 or 120 fps), or null for none (the display's rate).
- [Stats occlusion](graph-behavior-6.md#node-behavior--api-stats-occlusion) (`api.stats.occlusion`, as in `behavior`): Occlusion culling in the last frame (the project's occlusion_culling setting, its quality level's).
- [Stats window ms](graph-behavior-6.md#node-behavior--api-stats-window-ms) (`api.stats.windowMs`, as in `behavior`): The window the times are measured over (ms).

<a id="graph-behavior-library--display"></a>
## Display

- [Frame-rate cap](graph-behavior-6.md#node-behavior--api-display-frame-rate-cap) (`api.display.frameRateCap`, as in `behavior`): The cap in frames per second (30, 60 or 120), or null for none (the display's rate).
- [Set frame-rate cap](graph-behavior-6.md#node-behavior--api-display-set-frame-rate-cap) (`api.display.setFrameRateCap`, as in `behavior`): Cap the frame rate at 30, 60 or 120 fps, or null (or 0) for none (the display's rate); false for any other value (nothing changes).

<a id="graph-behavior-library--dialogue"></a>
## Dialogue

- [Start dialogue](graph-behavior-6.md#node-behavior--api-dialogue-start) (`api.dialogue.start`, as in `behavior`): Start a conversation (at its Start, a named entry, or any node); bindings are values its lines and conditions read as $name. Returns the conversation number, or 0 (unknown dialogue, entry or node, or one is running).
- [Stop dialogue](graph-behavior-6.md#node-behavior--api-dialogue-stop) (`api.dialogue.stop`, as in `behavior`): End the running conversation.
- [Dialogue running](graph-behavior-6.md#node-behavior--api-dialogue-is-running) (`api.dialogue.isRunning`, as in `behavior`): A conversation is running (this one, when given).
- [Dialogue state](graph-behavior-6.md#node-behavior--api-dialogue-current) (`api.dialogue.current`, as in `behavior`): The conversation now (null when none).
- [Advance dialogue](graph-behavior-6.md#node-behavior--api-dialogue-advance) (`api.dialogue.advance`, as in `behavior`): Advance: reveal the rest of the line, or go on after it.
- [Choose option](graph-behavior-6.md#node-behavior--api-dialogue-choose) (`api.dialogue.choose`, as in `behavior`): Pick an option of the choice shown (0 = the first shown).
- [Resume dialogue](graph-behavior-6.md#node-behavior--api-dialogue-resume) (`api.dialogue.resume`, as in `behavior`): Continue after a Signal node that waits.
- [Set dialogue skip](graph-behavior-6.md#node-behavior--api-dialogue-set-skip) (`api.dialogue.setSkip`, as in `behavior`): Skip lines already seen (until an unseen line or a choice).
- [Set dialogue auto](graph-behavior-6.md#node-behavior--api-dialogue-set-auto) (`api.dialogue.setAuto`, as in `behavior`): The player's auto-advance (null: the project's setting).
- [Set text speed](graph-behavior-6.md#node-behavior--api-dialogue-set-text-speed) (`api.dialogue.setTextSpeed`, as in `behavior`): The player's text speed in characters per second (0: whole lines at once; null: the project's setting).
- [Dialogue events](graph-behavior-6.md#node-behavior--api-dialogue-events) (`api.dialogue.events`, as in `behavior`): The dialogue events of the previous step (line starts and ends, choices, picks, signals, starts and ends), in order.
- [Dialogue event](graph-behavior-6.md#node-behavior--api-dialogue-event) (`api.dialogue.event`, as in `behavior`): The first dialogue event of the previous step of this kind (and signal name), or null.
- [Dialogue variable](graph-behavior-6.md#node-behavior--api-dialogue-get) (`api.dialogue.get`, as in `behavior`): A dialogue variable (null when unset).
- [Set dialogue variable](graph-behavior-6.md#node-behavior--api-dialogue-set) (`api.dialogue.set`, as in `behavior`): Set a dialogue variable (conditions and effects read and write them); false for a bad name or value.
- [Line seen](graph-behavior-6.md#node-behavior--api-dialogue-seen) (`api.dialogue.seen`, as in `behavior`): The line (or option) was seen: "dialogueId/nodeId".

<a id="graph-behavior-library--modes"></a>
## Modes

- [Current mode](graph-behavior-6.md#node-behavior--api-modes-current) (`api.modes.current`, as in `behavior`): The current game mode ('' when the project has none).
- [Previous mode](graph-behavior-6.md#node-behavior--api-modes-previous) (`api.modes.previous`, as in `behavior`): The mode before the current one ('' at the start of a run).
- [Mode is](graph-behavior-6.md#node-behavior--api-modes-is) (`api.modes.is`, as in `behavior`): The current mode is this one.
- [Switch mode](graph-behavior-6.md#node-behavior--api-modes-switch) (`api.modes.switch`, as in `behavior`): Switch to a game mode at the next step (its input maps, camera, UI documents and ticking groups together; no scene load). `false` for a mode the project does not have or a bad transition.
- [Mode events](graph-behavior-6.md#node-behavior--api-modes-events) (`api.modes.events`, as in `behavior`): This step's enter and exit events (the step a switch applied in), in order.
- [Mode entered](graph-behavior-6.md#node-behavior--api-modes-entered) (`api.modes.entered`, as in `behavior`): A mode was entered this step (this one, or any when empty).
- [Mode exited](graph-behavior-6.md#node-behavior--api-modes-exited) (`api.modes.exited`, as in `behavior`): A mode ended this step (this one, or any when empty).
- [Time in mode](graph-behavior-6.md#node-behavior--api-modes-time) (`api.modes.time`, as in `behavior`): Seconds since the current mode was entered.

<a id="graph-behavior-library--lifecycle"></a>
## Lifecycle

- [Respawn player](graph-behavior-6.md#node-behavior--api-lifecycle-respawn) (`api.lifecycle.respawn`, as in `behavior`): Move a player character (a controller's object: `entityId`, absent: the first player controller) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). Applied after this step's intent phase (a later phase: the next step). `false` without that character or for an unknown spawn. An empty entity means this object.
- [Set spawn point](graph-behavior-6.md#node-behavior--api-lifecycle-set-spawn) (`api.lifecycle.setSpawn`, as in `behavior`): Make a player spawn (an object with the Player spawn component) the one respawn uses.
- [Spawn point](graph-behavior-6.md#node-behavior--api-lifecycle-spawn-point) (`api.lifecycle.spawnPoint`, as in `behavior`): The active player spawn ('' when there is none: respawn then uses where the player started).
- [Restart run (deprecated)](graph-behavior-6.md#node-behavior--api-lifecycle-restart) (`api.lifecycle.restart`, as in `behavior`): Deprecated: the engine does not know what a run restart is. Restarts the run at the next step (scenes, objects, scripts, cameras, UI and the start mode as at the start) and writes one Problems line per Play; reload scenes with `ctx.scenes.reload` and reset what the game keeps itself.

<a id="graph-behavior-library--timeline"></a>
## Timeline

- [Play timeline](graph-behavior-6.md#node-behavior--api-timeline-play) (`api.timeline.play`, as in `behavior`): Play a timeline, binding its slots to objects (`{ slot: entityId }`; unbound slots use the timeline's defaults). Returns its handle (0 when refused: no such timeline, or 8 already playing).
- [Pause timeline](graph-behavior-6.md#node-behavior--api-timeline-pause) (`api.timeline.pause`, as in `behavior`): Pause a playing timeline (it holds its current state).
- [Resume timeline](graph-behavior-6.md#node-behavior--api-timeline-resume) (`api.timeline.resume`, as in `behavior`): Resume a paused timeline.
- [Stop timeline](graph-behavior-6.md#node-behavior--api-timeline-stop) (`api.timeline.stop`, as in `behavior`): Stop a timeline where it is (no end states: the sounds and effects it started stop, the cameras go back).
- [Skip timeline](graph-behavior-6.md#node-behavior--api-timeline-skip) (`api.timeline.skip`, as in `behavior`): Skip to the end: every track's end state at once (cameras, transforms, music, activation; remaining signals fire unless a key says drop).
- [Seek timeline](graph-behavior-6.md#node-behavior--api-timeline-seek) (`api.timeline.seek`, as in `behavior`): Jump to a time (seconds): the moves, fades and cameras there; keys in between do not fire.
- [Timeline state](graph-behavior-6.md#node-behavior--api-timeline-state) (`api.timeline.state`, as in `behavior`): A play's state: playing, paused, waiting (for input or a dialogue), ended (recently), or null.
- [Timeline time](graph-behavior-6.md#node-behavior--api-timeline-time) (`api.timeline.time`, as in `behavior`): A play's time in seconds (counted in fixed steps).
- [Timeline playing](graph-behavior-6.md#node-behavior--api-timeline-is-playing) (`api.timeline.isPlaying`, as in `behavior`): Whether any play of this timeline is running.
- [Timeline ended](graph-behavior-6.md#node-behavior--api-timeline-ended) (`api.timeline.ended`, as in `behavior`): True in the step after a play ended (finished, skipped or stopped).
- [Timeline marker](graph-behavior-6.md#node-behavior--api-timeline-marker) (`api.timeline.marker`, as in `behavior`): True in the step after a marker with this name was reached (of the play `handle`, or of any play when 0).

<a id="graph-behavior-library--environment"></a>
## Environment

- [Set environment](graph-behavior-6.md#node-behavior--api-environment-set) (`api.environment.set`, as in `behavior`): Switch to a preset ('' = the base look), blending over `blend` seconds from the look now (an interrupted blend continues from where it is). False when there is no such preset or an option is refused.
- [Blend environments](graph-behavior-6.md#node-behavior--api-environment-blend) (`api.environment.blend`, as in `behavior`): Hold a mix of two presets: t = 0 shows a, 1 shows b (a timeline or a script drives t; '' = the base look). Stops a running blend.
- [Environment state](graph-behavior-6.md#node-behavior--api-environment-state) (`api.environment.state`, as in `behavior`): The preset the last change went to ('' = the base look), how far its blend is (0–1) and whether one is running.
- [Environment weight](graph-behavior-7.md#node-behavior--api-environment-weight) (`api.environment.weight`, as in `behavior`): How much of a preset is in the look now (0–1; '' = the base look).
- [Environment presets](graph-behavior-7.md#node-behavior--api-environment-presets) (`api.environment.presets`, as in `behavior`): The project's environment preset ids.
- [Set wind](graph-behavior-7.md#node-behavior--api-environment-set-wind) (`api.environment.setWind`, as in `behavior`): Change the scene's global wind: any of its fields (direction [x, z], strength, gust, gustFrequency, turbulence, speed m/s, scale m, noise texture), added to the last change's, blending over `blend` seconds; null goes back to the scene's own wind. Wind zones keep laying their values over it. False when a value or an option is refused.

<a id="graph-behavior-library--entity"></a>
## Entity

- [Get component](graph-behavior-7.md#node-behavior--api-entity-get) (`api.entity.get`, as in `behavior`): A read-only snapshot of a component's script-readable fields as they stood at the start of the step (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the object has no such component (`'materialParams'`: when it wears no graph material with public parameters). A component scripts cannot read throws. An empty entity means this object.
- [Set component](graph-behavior-7.md#node-behavior--api-entity-set) (`api.entity.set`, as in `behavior`): Write fields of a component, applied at the end of the step (in script order; a later write of the same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`, transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: An empty entity means this object.

<a id="graph-behavior-library--shell"></a>
## Shell

- [Next scene (deprecated)](graph-behavior-7.md#node-behavior--api-shell-next-scene) (`api.shell.nextScene`, as in `behavior`): Deprecated (one Problems line per Play): moves to the next entry of the shell's scene list at the next step boundary, as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the entry's scene loads, the character arrives at its spawn). False when the list has no next entry; a second call in the same step asks for the same move.
- [Scene list entry (deprecated)](graph-behavior-7.md#node-behavior--api-shell-scene-index) (`api.shell.sceneIndex`, as in `behavior`): Deprecated (one Problems line per Play): the scene list entry the run is at (-1: none); only the list's own moves change it.
- [Scene list length (deprecated)](graph-behavior-7.md#node-behavior--api-shell-scene-count) (`api.shell.sceneCount`, as in `behavior`): Deprecated (one Problems line per Play): how many entries the shell's scene list has (0: none).
