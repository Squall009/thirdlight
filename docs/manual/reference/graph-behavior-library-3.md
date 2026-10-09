# Graph: Shared script function (part 3, from Dialogue)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Shared script function node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

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

- [Respawn player](graph-behavior-6.md#node-behavior--api-lifecycle-respawn) (`api.lifecycle.respawn`, as in `behavior`): Move a player character (a controller's object: `entityId`, absent: the first player controller) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). In 3D applied after this step's intent phase (a later phase: the next step); on the 2D plane at the next step boundary. `false` without that character or for an unknown spawn. An empty entity means this object.
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
- [Environment weight](graph-behavior-6.md#node-behavior--api-environment-weight) (`api.environment.weight`, as in `behavior`): How much of a preset is in the look now (0–1; '' = the base look).
- [Environment presets](graph-behavior-6.md#node-behavior--api-environment-presets) (`api.environment.presets`, as in `behavior`): The project's environment preset ids.

<a id="graph-behavior-library--entity"></a>
## Entity

- [Get component](graph-behavior-6.md#node-behavior--api-entity-get) (`api.entity.get`, as in `behavior`): A read-only snapshot of a component's script-readable fields as they stood at the start of the step (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the object has no such component (`'materialParams'`: when it wears no graph material with public parameters). A component scripts cannot read throws. An empty entity means this object.
- [Set component](graph-behavior-6.md#node-behavior--api-entity-set) (`api.entity.set`, as in `behavior`): Write fields of a component, applied at the end of the step (in script order; a later write of the same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`, transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: An empty entity means this object.

<a id="graph-behavior-library--shell"></a>
## Shell

- [Next scene](graph-behavior-6.md#node-behavior--api-shell-next-scene) (`api.shell.nextScene`, as in `behavior`): Move to the next entry of the shell's scene list at the next step boundary — the same move as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the entry's scene loads, the character arrives at its spawn). False when the list has no next entry. Calling it again in the same step asks for the same move.
- [Scene list entry](graph-behavior-6.md#node-behavior--api-shell-scene-index) (`api.shell.sceneIndex`, as in `behavior`): The scene list entry the run is at (-1: none).
- [Scene list length](graph-behavior-6.md#node-behavior--api-shell-scene-count) (`api.shell.sceneCount`, as in `behavior`): How many entries the shell's scene list has (0: the project has none).
