# Graph: Script function (part 2, from Animator)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Script function node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-behavior-function--animator"></a>
## Animator

- [Set animator parameter](graph-behavior-3.md#node-behavior--api-animator-set) (`api.animator.set`, as in `behavior`): Set a float/int/bool parameter; false for an unknown name or a wrong type. An empty entity means this object.
- [Set animator trigger](graph-behavior-3.md#node-behavior--api-animator-trigger) (`api.animator.trigger`, as in `behavior`): Set a trigger (it resets when a transition uses it). An empty entity means this object.
- [Animator parameter](graph-behavior-3.md#node-behavior--api-animator-get) (`api.animator.get`, as in `behavior`): A parameter's value (undefined for an unknown name). An empty entity means this object.
- [Animator state](graph-behavior-3.md#node-behavior--api-animator-state) (`api.animator.state`, as in `behavior`): The current state's name (of the base layer, or of override layer `layer` — 1 is the first). An empty entity means this object.
- [Play animator state](graph-behavior-3.md#node-behavior--api-animator-play) (`api.animator.play`, as in `behavior`): Go to a state by name over `fade` seconds (0: at once), on layer `layer` (0: the base layer, 1 the first override layer), the state starting at normalized time `time` (0–1 of its length; 0: its beginning). False for an unknown state or layer, or a time below 0. An empty entity means this object.
- [Set look target](graph-behavior-3.md#node-behavior--api-animator-set-look-target) (`api.animator.setLookTarget`, as in `behavior`): The object the look-at constraint turns the head toward (its origin), or null for nothing (the head turns back at its turn speed). False when the animator has no look-at. An empty entity means this object.
- [Set look point](graph-behavior-3.md#node-behavior--api-animator-set-look-point) (`api.animator.setLookPoint`, as in `behavior`): A world point [x, y, z] the look-at constraint turns the head toward (in place of a target object). False when the animator has no look-at or the point is not three finite numbers. An empty entity means this object.
- [Set look weight](graph-behavior-3.md#node-behavior--api-animator-set-look-weight) (`api.animator.setLookWeight`, as in `behavior`): The look-at constraint's weight (0–1; 0: the clip pose alone — the head turns back at its turn speed). False when the animator has no look-at or the weight is outside 0–1. An empty entity means this object.
- [Set animation speed](graph-behavior-3.md#node-behavior--api-animator-set-speed) (`api.animator.setSpeed`, as in `behavior`): Set this animator's playback speed (× every clip and crossfade; 1 as authored, 0.5 half speed, 0 holds the pose; 0–10). False for a value outside 0–10. An empty entity means this object.
- [Animation speed](graph-behavior-3.md#node-behavior--api-animator-speed) (`api.animator.speed`, as in `behavior`): This animator's playback speed. An empty entity means this object.
- [Set morph weight](graph-behavior-3.md#node-behavior--api-animator-set-morph) (`api.animator.setMorph`, as in `behavior`): Set a morph target's weight (0–1) by its name in the model (over the controller's parameter binding of that target, if any). An empty entity means this object.
- [Morph weight](graph-behavior-3.md#node-behavior--api-animator-morph) (`api.animator.morph`, as in `behavior`): A morph target's weight now (0 when nothing sets it). An empty entity means this object.

<a id="graph-behavior-function--timers"></a>
## Timers

- [Start timer](graph-behavior-3.md#node-behavior--api-timers-after) (`api.timers.after`, as in `behavior`): Fire once, `seconds` from this step. Returns `false` (and changes nothing) when a one-shot timer of that name and length is already running — a script may call it every step; a different length restarts it.
- [Start repeating timer](graph-behavior-3.md#node-behavior--api-timers-every) (`api.timers.every`, as in `behavior`): Fire every `seconds`, the first time `seconds` from this step. Returns `false` (and changes nothing) when a repeating timer of that name and period is already running.
- [Timer fired](graph-behavior-3.md#node-behavior--api-timers-fired) (`api.timers.fired`, as in `behavior`): True in the step the timer fires (in every phase of that step).
- [Cancel timer](graph-behavior-3.md#node-behavior--api-timers-cancel) (`api.timers.cancel`, as in `behavior`): Stop a timer; `false` when none of that name was running.

<a id="graph-behavior-function--signals"></a>
## Signals

- [Emit signal](graph-behavior-3.md#node-behavior--api-signals-emit) (`api.signals.emit`, as in `behavior`): Send a named signal; switches, doors and scripts see it in the next step.
- [Signal received](graph-behavior-3.md#node-behavior--api-signals-on) (`api.signals.on`, as in `behavior`): Emitted in the previous step (by a switch, a trigger or a script).

<a id="graph-behavior-function--messages"></a>
## Messages

- [Send message](graph-behavior-3.md#node-behavior--api-messages-send) (`api.messages.send`, as in `behavior`): Send a message (name: 1–64 letters, digits or _ . : -) with an optional value (a number, text of at most 256 characters or true/false) to every script, or only to the scripts on entity `target`. `false` when it is refused (a bad name or value, or the step's limit).
- [Messages received](graph-behavior-3.md#node-behavior--api-messages-received) (`api.messages.received`, as in `behavior`): The messages of that name sent in the previous step to every script or to this entity, in send order.

<a id="graph-behavior-function--game"></a>
## Game

- [Counter value](graph-behavior-3.md#node-behavior--api-game-counter) (`api.game.counter`, as in `behavior`): The current value of one of the run's counters (0 when it was never added to).
- [Add to counter](graph-behavior-3.md#node-behavior--api-game-add) (`api.game.add`, as in `behavior`): Add to one of the run's named counters; HUD documents read them (`$flow.counters.<name>`). A name is a letter or _, then up to 31 letters, digits or _ (what a save keeps): any other name is refused (false, one Problems line) and no counter changes.
- [Player health](graph-behavior-3.md#node-behavior--api-game-health) (`api.game.health`, as in `behavior`): A player character's health (a controller's object: `entityId`, absent: the first player controller), or null when it has none. An empty entity means this object.
- [Set visible](graph-behavior-3.md#node-behavior--api-game-set-visible) (`api.game.setVisible`, as in `behavior`): Show or hide an entity (and its children) until the next run; it still collides and triggers. An empty entity means this object.

<a id="graph-behavior-function--health"></a>
## Health

- [Health of](graph-behavior-3.md#node-behavior--api-health-get) (`api.health.get`, as in `behavior`): The object's health now, or null when it has no Health component. An empty entity means this object.
- [Damage](graph-behavior-3.md#node-behavior--api-health-damage) (`api.health.damage`, as in `behavior`): Take `amount` (> 0) from the object's health, not below 0 (a `damaged` event, and `died` when it reaches 0). `source` names what did it (an object id or any text). False without health, when it is already at 0, or for a bad amount. An empty entity means this object.
- [Heal](graph-behavior-3.md#node-behavior--api-health-heal) (`api.health.heal`, as in `behavior`): Give `amount` (> 0) back, not above its maximum (a `healed` event). False without health, at its maximum, or for a bad amount. An empty entity means this object.
- [Health events](graph-behavior-3.md#node-behavior--api-health-events) (`api.health.events`, as in `behavior`): Every object's health events of the previous step (damaged, healed, died), in the order they happened.

<a id="graph-behavior-function--patrol"></a>
## Patrol

- [Patrol state](graph-behavior-3.md#node-behavior--api-patrol-get) (`api.patrol.get`, as in `behavior`): The way a patroller walks now (a unit vector) and whether it walks at all; null for an object without a patrol. An empty entity means this object.
- [Set patrol active](graph-behavior-3.md#node-behavior--api-patrol-set-active) (`api.patrol.setActive`, as in `behavior`): Stop a patroller where it is, or let it walk on. False for an object without a patrol. An empty entity means this object.
- [Turn patroller](graph-behavior-3.md#node-behavior--api-patrol-turn) (`api.patrol.turn`, as in `behavior`): Turn a patroller around now (a `turned` event). False for an object without a patrol, or a waypoint loop (it only goes forward). An empty entity means this object.

<a id="graph-behavior-function--hitbox"></a>
## Hitbox

- [Set hitbox active](graph-behavior-3.md#node-behavior--api-hitbox-set-active) (`api.hitbox.setActive`, as in `behavior`): Switch a hitbox off (it touches nothing: its contacts end) or on again. False for an object without a hitbox. An empty entity means this object.
- [Touching](graph-behavior-3.md#node-behavior--api-hitbox-touching) (`api.hitbox.touching`, as in `behavior`): The objects a hitbox (or the character) touches now, sorted by id. An empty entity means this object.

<a id="graph-behavior-function--collectible"></a>
## Collectible

- [Is collected](graph-behavior-3.md#node-behavior--api-collectible-collected) (`api.collectible.collected`, as in `behavior`): Whether a collectible has been collected (and not come back yet). An empty entity means this object.
- [Restore collectible](graph-behavior-3.md#node-behavior--api-collectible-restore) (`api.collectible.restore`, as in `behavior`): Bring a collected collectible back now (shown, collectable again; a `restored` event). False when it is not collected. An empty entity means this object.

<a id="graph-behavior-function--character"></a>
## Character

- [Character impulse](graph-behavior-3.md#node-behavior--api-character-impulse) (`api.character.impulse`, as in `behavior`): Add `velocity` [x, y, z] (m/s, each at most 100 either way) to a player character's velocity at its next move (`entityId`, absent: the first player controller) — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without that character or for a  An empty entity means this object.

<a id="graph-behavior-function--look"></a>
## Look

- [Set look](graph-behavior-3.md#node-behavior--api-look-set) (`api.look.set`, as in `behavior`): Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value. An empty entity means this object.
- [Clear look](graph-behavior-3.md#node-behavior--api-look-clear) (`api.look.clear`, as in `behavior`): Give an object its own look back. False when it had no override. An empty entity means this object.
- [Look of](graph-behavior-3.md#node-behavior--api-look-get) (`api.look.get`, as in `behavior`): The object's look override now, or null when it has none. An empty entity means this object.

<a id="graph-behavior-function--audio"></a>
## Audio

- [Play sound](graph-behavior-4.md#node-behavior--api-audio-play) (`api.audio.play`, as in `behavior`): Play an audio asset of any length (volume 0–1). Returns its handle (0 when refused: a bad id, more than 32 plays in one step or 64 sounds alive). The sound belongs to the script's object: it stops (fading out over `fadeOut` seconds, 0) when the object leaves the game — its scene unloads or reloads; `owner: 'scene'` ties it to the object's scene instead, `owner: 'none'` to nothing. Options: `loop`, An empty entity means this object.
- [Stop sound](graph-behavior-4.md#node-behavior--api-audio-stop) (`api.audio.stop`, as in `behavior`): Stop a sound, fading out over `fadeSeconds` (0: now). Its finished event (reason "stopped") arrives in the step after the fade ends.
- [Fade sound](graph-behavior-4.md#node-behavior--api-audio-fade) (`api.audio.fade`, as in `behavior`): Fade a sound's volume to `to` (0–1) over `seconds` (linear, whole steps).
- [Set sound volume](graph-behavior-4.md#node-behavior--api-audio-set-volume) (`api.audio.setVolume`, as in `behavior`): Set a sound's volume (0–1) now.
- [Set sound pitch](graph-behavior-4.md#node-behavior--api-audio-set-pitch) (`api.audio.setPitch`, as in `behavior`): Set a sound's pitch — its playback rate, 0.25–4 (1: as recorded; it plays faster or slower too).
- [Set sound loop](graph-behavior-4.md#node-behavior--api-audio-set-loop) (`api.audio.setLoop`, as in `behavior`): Loop a sound or let it end at the end of its clip.
- [Sound playing](graph-behavior-4.md#node-behavior--api-audio-playing) (`api.audio.playing`, as in `behavior`): Whether a sound is still playing (its finished event has not happened).
- [Sound volume](graph-behavior-4.md#node-behavior--api-audio-volume-of) (`api.audio.volumeOf`, as in `behavior`): A sound's volume now (its fade included; 0 when it is not playing).
- [Sound finished](graph-behavior-4.md#node-behavior--api-audio-finished) (`api.audio.finished`, as in `behavior`): True in the step after a sound finished (it ended or was stopped).
- [Set music](graph-behavior-4.md#node-behavior--api-audio-music) (`api.audio.music`, as in `behavior`): Play an audio asset as the music track (looped), crossfading over `fadeSeconds` (1); null fades to silence. The scripts then own the music until `releaseMusic`. The track belongs to the script's object (`options.owner`: `scene`, `none`): when that goes, the music is released over the same fade.
- [Release music](graph-behavior-4.md#node-behavior--api-audio-release-music) (`api.audio.releaseMusic`, as in `behavior`): Give the music back to the host (silence: the engine has no level-flow music), crossfading over `fadeSeconds` (1).
- [Play stinger](graph-behavior-4.md#node-behavior--api-audio-stinger) (`api.audio.stinger`, as in `behavior`): Play a stinger (a short musical phrase) once over the music: the track ducks to `duck` (0.3) while it plays and comes back after it, both over `fade` seconds (0.25). Returns its handle.
- [Duck music](graph-behavior-4.md#node-behavior--api-audio-duck) (`api.audio.duck`, as in `behavior`): Duck the music to `level` (0–1; 0.3) over `seconds` (0.25) until `unduck`. The deepest duck alive wins (a stinger's, dialogue voice's).
- [Unduck music](graph-behavior-4.md#node-behavior--api-audio-unduck) (`api.audio.unduck`, as in `behavior`): End the script's music duck over `seconds` (0.25).
- [Music state](graph-behavior-4.md#node-behavior--api-audio-music-state) (`api.audio.musicState`, as in `behavior`): Who picks the music (the scripts or the host), the scripts' track and the duck now.
- [Set bus volume](graph-behavior-4.md#node-behavior--api-audio-set-bus-volume) (`api.audio.setBusVolume`, as in `behavior`): Mix a bus (sfx, music, voice, ui) to `volume` (0–1) over `seconds` (0), on top of the player's volume setting.
- [Bus volume](graph-behavior-4.md#node-behavior--api-audio-bus-volume) (`api.audio.busVolume`, as in `behavior`): The scripts' mix of a bus now (1 unless set).
- [Stop all sounds](graph-behavior-4.md#node-behavior--api-audio-stop-all) (`api.audio.stopAll`, as in `behavior`): Stop every sound on `bus` (sfx, music, voice, ui; every bus when absent) over `fadeSeconds` (0), whoever started it; on the music bus (or every bus) the scripts' music track is released too. Returns how many sounds it stopped.

<a id="graph-behavior-function--effects"></a>
## Effects

- [Play effect](graph-behavior-4.md#node-behavior--api-effects-play) (`api.effects.play`, as in `behavior`): Play a project effect (particles) once: on `entityId` (it follows the object; `position` is then an offset from it) or, without one, at `position` in world metres. `params` override its public parameters. Returns a handle for `stop`, or 0 when refused (a bad id, more than 32 plays in one step). An empty entity means this object.
- [Stop effect](graph-behavior-4.md#node-behavior--api-effects-stop) (`api.effects.stop`, as in `behavior`): Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lifetimes.

<a id="graph-behavior-function--save"></a>
## Save

- [Saved value](graph-behavior-4.md#node-behavior--api-save-get) (`api.save.get`, as in `behavior`): The value kept under `key` (undefined when there is none).
- [Save value](graph-behavior-4.md#node-behavior--api-save-set) (`api.save.set`, as in `behavior`): Keep a value under `key`; `false` when it does not fit (a bad key, 64 keys, 4 KB).
- [Remove saved value](graph-behavior-4.md#node-behavior--api-save-remove) (`api.save.remove`, as in `behavior`): Forget the value under `key`.
- [Saved keys](graph-behavior-4.md#node-behavior--api-save-keys) (`api.save.keys`, as in `behavior`): The keys of the kept values.

<a id="graph-behavior-function--grid"></a>
## Grid

- [Block layers](graph-behavior-4.md#node-behavior--api-grid-layers) (`api.grid.layers`, as in `behavior`): The block layers of the loaded scenes (their entity ids, in load order).
- [Get cell](graph-behavior-4.md#node-behavior--api-grid-get) (`api.grid.get`, as in `behavior`): The cell at [x, y, z] of a layer, or null when it is empty (or no such layer).
- [Set cell](graph-behavior-4.md#node-behavior--api-grid-set) (`api.grid.set`, as in `behavior`): Write a cell: a block and/or metadata overrides. False when refused.
- [Clear cell](graph-behavior-4.md#node-behavior--api-grid-clear) (`api.grid.clear`, as in `behavior`): Empty a cell (its block and metadata). False when refused or already empty.
- [Column top](graph-behavior-4.md#node-behavior--api-grid-column-top) (`api.grid.columnTop`, as in `behavior`): The highest cell of a column holding a block (its y), or null.
- [Surface below](graph-behavior-4.md#node-behavior--api-grid-surface) (`api.grid.surface`, as in `behavior`): The ground straight down from a world position: the top of the layer's blocks at or below it (sloped tops, ramps and half blocks included; inside the blocks: the top of the blocks there), with its height, normal, slope and whether it is walkable; null when the column holds no block.
- [Column surface](graph-behavior-4.md#node-behavior--api-grid-column-surface) (`api.grid.columnSurface`, as in `behavior`): The top surface of a column at its centre (cell x, z): the highest block's top, its height, normal, slope and whether it is walkable; null when the column holds no block.
- [World to cell](graph-behavior-4.md#node-behavior--api-grid-world-to-cell) (`api.grid.worldToCell`, as in `behavior`): The cell holding a world position (it may lie outside the layer's bounds), or null for no such layer.
- [Cell to world](graph-behavior-4.md#node-behavior--api-grid-cell-to-world) (`api.grid.cellToWorld`, as in `behavior`): The world position of a cell's centre, or null for no such layer.
- [Cell metadata](graph-behavior-4.md#node-behavior--api-grid-meta) (`api.grid.meta`, as in `behavior`): One effective metadata value of a cell (defaults included), or null for an unknown field or layer.
- [Set cell metadata](graph-behavior-4.md#node-behavior--api-grid-set-meta) (`api.grid.setMeta`, as in `behavior`): Set one metadata value of a cell (null removes the override; an empty cell becomes a metadata-only cell). False when refused.
- [Pick cell](graph-behavior-4.md#node-behavior--api-grid-pick) (`api.grid.pick`, as in `behavior`): The first block cell a ray enters (every layer, or one), with the face it entered through; null when none within maxDistance (default 100 m).
- [Neighbour cells](graph-behavior-4.md#node-behavior--api-grid-neighbours) (`api.grid.neighbours`, as in `behavior`): The cells next to [x, y, z] inside the layer's bounds: the 6 face neighbours, or all 26 with diagonal.
- [Walk neighbours](graph-behavior-4.md#node-behavior--api-grid-walk-neighbours) (`api.grid.walkNeighbours`, as in `behavior`): The places one step away from the place a cell names (the top it is, or the top a walker in that cell stands on): to the four neighbouring columns (eight with diagonal), within the step, drop and headroom limits, not across a wall or closed door; each with its cost (metres, times any cost field).
- [Walk path](graph-behavior-4.md#node-behavior--api-grid-path) (`api.grid.path`, as in `behavior`): The cheapest walk between the places two cells name ([x, y, z] each), start and end included, each with the cost so far; null when there is none (or the search passes 65,536 places: `pathOutcome` tells which).
- [Walk path outcome](graph-behavior-4.md#node-behavior--api-grid-path-outcome) (`api.grid.pathOutcome`, as in `behavior`): Why the last `path` call answered as it did: "found"; "none" (no walk joins the two places); "limit" (the search passed 65,536 places first: a path may still exist, e.g. ask for a nearer cell); "invalid" (a layer, cell or option that does not fit, or no place at a cell). Null before the first call.
- [Walk reach](graph-behavior-4.md#node-behavior--api-grid-reachable) (`api.grid.reachable`, as in `behavior`): The places reachable from the place a cell names within a cost (metres, times any cost field), cheapest first, the start included (at most 65,536).
- [Regions](graph-behavior-4.md#node-behavior--api-grid-regions) (`api.grid.regions`, as in `behavior`): The region ids of a layer (each room drawn on it is one too: its outline's id, and "-s1", "-s2"… for its upper storeys).
- [Region cells](graph-behavior-4.md#node-behavior--api-grid-region) (`api.grid.region`, as in `behavior`): The cells of a named region (at most 65,536), or null when the layer has no such region.
- [In region](graph-behavior-4.md#node-behavior--api-grid-in-region) (`api.grid.inRegion`, as in `behavior`): Whether a cell lies in a named region.
- [Set cut-away](graph-behavior-4.md#node-behavior--api-grid-set-cutaway) (`api.grid.setCutaway`, as in `behavior`): Force a cut-away zone of a layer hidden (true) or shown (false) whatever the subject does, or give it back to the subject (null). A zone is a region the layer's cutaway lists, or "#<row>" for one of its height planes. Drawing only (it fades like any cut-away). False when refused (an unknown layer or zone).
- [Set cut-away subject](graph-behavior-4.md#node-behavior--api-grid-set-cutaway-subject) (`api.grid.setCutawaySubject`, as in `behavior`): The object whose position decides the layers' cut-aways (what is cut while it stands under or inside it), or null for the camera's target (the default). False when the id is not a string.
- [Set cut-away point](graph-behavior-4.md#node-behavior--api-grid-set-cutaway-point) (`api.grid.setCutawayPoint`, as in `behavior`): A world point [x, y, z] that decides the layers' cut-aways in place of an object. False when it is not three finite numbers.
- [Set kit](graph-behavior-4.md#node-behavior--api-grid-set-kit) (`api.grid.setKit`, as in `behavior`): Show a kit over a layer (no region) or one of its regions: its block types are drawn, collide and spawn as each type's swap under the kit, without changing the cells (a dungeon burnt in place). Null shows no kit there (the authored one included); the layer re-meshes in the background, the old look drawn until the new is ready. False when refused (an unknown layer, kit or region). Saved with the gr
- [Kit](graph-behavior-4.md#node-behavior--api-grid-kit) (`api.grid.kit`, as in `behavior`): The kit a layer (no region) or one of its regions shows now (null: none).
- [Set architecture preset](graph-behavior-4.md#node-behavior--api-grid-set-architecture-preset) (`api.grid.setArchitecturePreset`, as in `behavior`): Restyle generated architecture: every outline styled by preset `from` is made by preset `to` instead (its style, values and trim sheet), in every loaded and later loaded scene, without touching the outlines; null puts `from` back. The page makes the changed chunks in the background, the old ones drawn until the new are in, and the colliders follow. False when refused (not preset ids, `to` not a pr
- [Architecture preset](graph-behavior-4.md#node-behavior--api-grid-architecture-preset) (`api.grid.architecturePreset`, as in `behavior`): The preset shown in place of `from` now (null: `from` itself).
- [Door link near](graph-behavior-4.md#node-behavior--api-grid-door-link) (`api.grid.doorLink`, as in `behavior`): The linked door nearest a world point within `reach` metres (absent: 2) on the ground, or null.
- [Get edge](graph-behavior-4.md#node-behavior--api-grid-edge) (`api.grid.edge`, as in `behavior`): The edge piece on a side of a cell (a wall, door or fence between it and its neighbour), or null when none stands there.
- [Edge blocked](graph-behavior-4.md#node-behavior--api-grid-blocked) (`api.grid.blocked`, as in `behavior`): Whether an edge piece blocks moving from a cell across one of its sides (a wall or a closed door does; an open door, a non-blocking piece or no piece does not). Where no piece stands, a room's wall drawn on the layer blocks (its doorways and windows do not).
- [Set edge](graph-behavior-4.md#node-behavior--api-grid-set-edge) (`api.grid.setEdge`, as in `behavior`): Put an edge piece on a side of a cell. False when refused (not an edge block type, outside the bounds, a rotation other than 0 or 180).
- [Clear edge](graph-behavior-4.md#node-behavior--api-grid-clear-edge) (`api.grid.clearEdge`, as in `behavior`): Remove the edge piece on a side of a cell. False when refused or none stands there.
- [Open edge](graph-behavior-4.md#node-behavior--api-grid-set-edge-open) (`api.grid.setEdgeOpen`, as in `behavior`): Open or close the edge piece on a side of a cell (a door): open, it blocks no passage and has no collider. False when none stands there or it already is.
- [Edge object](graph-behavior-5.md#node-behavior--api-grid-edge-entity) (`api.grid.edgeEntity`, as in `behavior`): The id of the object a live edge piece spawns (its prefab's root), or null when the edge shows no live piece.
- [Cell object](graph-behavior-5.md#node-behavior--api-grid-entity) (`api.grid.entity`, as in `behavior`): The id of the object a live block's cell spawns (its prefab's root; a cell a larger block covers names the block's), or null when the cell shows no live block. The id is the cell's from the write on; the object is in the game from the end of the step that wrote the cell.
- [Object cell](graph-behavior-5.md#node-behavior--api-grid-cell-of) (`api.grid.cellOf`, as in `behavior`): The cell a live block's object belongs to (its root or any of its children; the block's anchor cell; for a live edge piece the cell whose side it stands on, with that side), or null for any other object. An empty entity means this object.

<a id="graph-behavior-function--scatter"></a>
## Scatter

- [Scatter copies near](graph-behavior-5.md#node-behavior--api-scatter-near) (`api.scatter.near`, as in `behavior`): The copies standing within `radius` metres of a world position (measured across the ground, x and z), nearest first: of one rule or object only, hidden ones too (`hidden: true`), at most `limit` (default 64, at most 1,024).
- [Scatter copy](graph-behavior-5.md#node-behavior--api-scatter-get) (`api.scatter.get`, as in `behavior`): The copy at an address (hidden ones too), or null when there is none or it was removed.
- [Hide scatter copy](graph-behavior-5.md#node-behavior--api-scatter-hide) (`api.scatter.hide`, as in `behavior`): Hide a copy: it is not drawn and does not collide until shown again. False when there is no such copy or it is hidden already.
- [Show scatter copy](graph-behavior-5.md#node-behavior--api-scatter-show) (`api.scatter.show`, as in `behavior`): Show a hidden copy again. False when it is not hidden.
- [Remove scatter copy](graph-behavior-5.md#node-behavior--api-scatter-remove) (`api.scatter.remove`, as in `behavior`): Remove a copy for the rest of the run (not drawn, no collider). False when there is no such copy (or it is gone already).

<a id="graph-behavior-function--splines"></a>
## Splines

- [Spline length](graph-behavior-5.md#node-behavior--api-splines-length) (`api.splines.length`, as in `behavior`): Metres along an object's spline (null when the object carries none or is not loaded). An empty entity means this object.
- [Spline point at](graph-behavior-5.md#node-behavior--api-splines-at) (`api.splines.at`, as in `behavior`): The place and cross-section `distance` metres along an object's spline (clamped to its ends; a closed one wraps), or null without one. An empty entity means this object.
- [Nearest on spline](graph-behavior-5.md#node-behavior--api-splines-nearest) (`api.splines.nearest`, as in `behavior`): The nearest place on an object's spline to a world position (`level`: measured across the ground, x and z only), or null without one. An empty entity means this object.

<a id="graph-behavior-function--surface"></a>
## Surface

- [Surface at](graph-behavior-5.md#node-behavior--api-surface-at) (`api.surface.at`, as in `behavior`): The ground at or below a world position (a point inside blocks gives their top), or null where no block layer or loaded terrain tile has ground (a hole, off the level).
- [Top surface](graph-behavior-5.md#node-behavior--api-surface-top) (`api.surface.top`, as in `behavior`): The highest ground at world x, z, or null where there is none.

<a id="graph-behavior-function--camera"></a>
## Camera

- [Activate camera](graph-behavior-5.md#node-behavior--api-camera-activate) (`api.camera.activate`, as in `behavior`): Enable a virtual camera and bring it in front of the cameras of its priority (it goes live unless a higher priority is enabled). `false` when there is no such camera.
- [Deactivate camera](graph-behavior-5.md#node-behavior--api-camera-deactivate) (`api.camera.deactivate`, as in `behavior`): Disable a virtual camera (the view blends to the next one, or to the default pose when none is left).
- [Set camera priority](graph-behavior-5.md#node-behavior--api-camera-set-priority) (`api.camera.setPriority`, as in `behavior`): Set a camera's priority (−1000–1000; the enabled camera with the highest is live).
- [Set camera target](graph-behavior-5.md#node-behavior--api-camera-set-target) (`api.camera.setTarget`, as in `behavior`): Point a camera at another target entity ('' for none). An empty entity means this object.
- [Set camera rig](graph-behavior-5.md#node-behavior--api-camera-set) (`api.camera.set`, as in `behavior`): Set a camera's rig values (each optional): distance, yaw, pitch (kept within its pitch limits), progress and railSpeed of a rail camera, field of view, letterbox, the orbit point, the target offset.
- [Turn camera](graph-behavior-5.md#node-behavior--api-camera-turn) (`api.camera.turn`, as in `behavior`): Turn a camera by whole steps (an orbit-a-point camera: its turn step; positive turns left).
- [Shake camera](graph-behavior-5.md#node-behavior--api-camera-shake) (`api.camera.shake`, as in `behavior`): Shake the view: up to `amplitude` metres (and `rotation` degrees), `frequency` times a second (default 8), fading out over `seconds`. Seeded: the same run shakes the same way (`seed` picks another pattern).
- [Live camera](graph-behavior-5.md#node-behavior--api-camera-live) (`api.camera.live`, as in `behavior`): The live virtual camera, or null while none is (the view holds the default pose).
- [Camera blending](graph-behavior-5.md#node-behavior--api-camera-blending) (`api.camera.blending`, as in `behavior`): A blend between two cameras is in progress.
- [Camera state](graph-behavior-5.md#node-behavior--api-camera-get) (`api.camera.get`, as in `behavior`): A virtual camera's live rig values, or null when there is no such camera.
- [World to screen](graph-behavior-5.md#node-behavior--api-camera-world-to-screen) (`api.camera.worldToScreen`, as in `behavior`): Where a world point appears on screen (x, y 0–1 from the top left), how far in front of the camera it is, and whether it is in view.
- [Screen to ray](graph-behavior-5.md#node-behavior--api-camera-screen-to-ray) (`api.camera.screenToRay`, as in `behavior`): The ray from the camera through a screen point (x, y 0–1 from the top left): its origin and unit direction.

<a id="graph-behavior-function--sockets"></a>
## Sockets

- [Attach to socket](graph-behavior-5.md#node-behavior--api-sockets-attach) (`api.sockets.attach`, as in `behavior`): Attach an object to a node of the target's model, with an optional offset in the node's space (position [x, y, z], rotation quaternion [x, y, z, w], scale [x, y, z]). Without a target the object's own Socket component is used. False (and a warning in the play log) when refused: an unknown object, target or node, a loop, or a physics body. An empty entity means this object.
- [Detach from socket](graph-behavior-5.md#node-behavior--api-sockets-detach) (`api.sockets.detach`, as in `behavior`): Detach an object from its socket: it stays where the node left it (keepWorld, the default) or snaps back to its transform from before the attach. False when it was not attached. An empty entity means this object.
- [Socket of](graph-behavior-5.md#node-behavior--api-sockets-attached-to) (`api.sockets.attachedTo`, as in `behavior`): The socket an object rides on (the target object and the node's name), or null. An empty entity means this object.
- [Node pose](graph-behavior-5.md#node-behavior--api-sockets-node-pose) (`api.sockets.nodePose`, as in `behavior`): A node's world position and rotation now (the target's model posed by its animator), or null when the target, its model or the node is missing — e.g. where a muzzle or a hand is.

<a id="graph-behavior-function--materials"></a>
## Materials

- [Set material parameter](graph-behavior-5.md#node-behavior--api-materials-set) (`api.materials.set`, as in `behavior`): Set a parameter on one object: a number (float), 2–4 numbers (vec2–4), "#rrggbb" (colour) or a texture asset id of the game ("" for none). Other objects wearing the material keep their values. False when refused. An empty entity means this object.
- [Material parameter](graph-behavior-5.md#node-behavior--api-materials-get) (`api.materials.get`, as in `behavior`): A parameter's value on an object now: what a script set, else the object's authored override, else the material's default (null: no such parameter, or a data parameter). An empty entity means this object.
- [Reset material parameter](graph-behavior-5.md#node-behavior--api-materials-reset) (`api.materials.reset`, as in `behavior`): Put a parameter (or, without one, every parameter scripts set) of an object back to its authored value; a data parameter back to its starting cells. An empty entity means this object.
- [Write material data](graph-behavior-5.md#node-behavior--api-materials-set-data) (`api.materials.setData`, as in `behavior`): Write a rectangle of cells of a data parameter: x, y, width, height in cells (cell [0, 0] sits at UV (0, 0)); bytes = RGBA 0–255 per cell, row by row from y (width × height × 4 numbers). False when refused (outside the grid, wrong length). An empty entity means this object.
- [Material data cell](graph-behavior-5.md#node-behavior--api-materials-get-data) (`api.materials.getData`, as in `behavior`): One cell of a data parameter on an object as [r, g, b, a] (0–255), or null (no such parameter or cell). An empty entity means this object.

<a id="graph-behavior-function--saves"></a>
## Saves

- [Save version](graph-behavior-5.md#node-behavior--api-saves-version) (`api.saves.version`, as in `behavior`): The save document's schema version (0: the project declares no save schema).
- [Save slot count](graph-behavior-5.md#node-behavior--api-saves-slot-count) (`api.saves.slotCount`, as in `behavior`): How many slots the game offers.
- [Write save document](graph-behavior-5.md#node-behavior--api-saves-write) (`api.saves.write`, as in `behavior`): Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.
- [Save document](graph-behavior-5.md#node-behavior--api-saves-read) (`api.saves.read`, as in `behavior`): The project's save document (a copy; null before one is written or loaded).
- [Save to slot](graph-behavior-5.md#node-behavior--api-saves-save) (`api.saves.save`, as in `behavior`): Save to a slot at the end of this step (the document and the engine sections of the schema); the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (names → texts; the record at most 4 KiB as JSON). False for a slot the game does not have or a meta that does not fit.
- [Load slot](graph-behavior-5.md#node-behavior--api-saves-load) (`api.saves.load`, as in `behavior`): Load a slot: when storage answers, the document is migrated and restored at the end of that step (the outcome in `results()`).
- [Delete slot](graph-behavior-5.md#node-behavior--api-saves-delete) (`api.saves.delete`, as in `behavior`): Delete a slot (the outcome in `results()`).
- [Save slots](graph-behavior-5.md#node-behavior--api-saves-slots) (`api.saves.slots`, as in `behavior`): The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).
- [Save slots ready](graph-behavior-5.md#node-behavior--api-saves-ready) (`api.saves.ready`, as in `behavior`): Whether the slot list has arrived from storage (it is empty before).
- [Save results](graph-behavior-5.md#node-behavior--api-saves-results) (`api.saves.results`, as in `behavior`): The outcomes that arrived this step (saves, loads and deletes).
- [Save storage](graph-behavior-5.md#node-behavior--api-saves-storage) (`api.saves.storage`, as in `behavior`): The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.
- [Play time](graph-behavior-5.md#node-behavior--api-saves-play-seconds) (`api.saves.playSeconds`, as in `behavior`): Play time in seconds (restored with a loaded save).
- [Setting](graph-behavior-5.md#node-behavior--api-saves-setting) (`api.saves.setting`, as in `behavior`): A value of the project settings document (its default until the player changes it).
- [Settings document](graph-behavior-5.md#node-behavior--api-saves-settings) (`api.saves.settings`, as in `behavior`): The whole project settings document (a copy).
- [Set setting](graph-behavior-5.md#node-behavior--api-saves-set-setting) (`api.saves.setSetting`, as in `behavior`): Change a value of the project settings document (kept in the player's browser; an engine setting it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.

<a id="graph-behavior-function--assets"></a>
## Assets

- [Load assets](graph-behavior-5.md#node-behavior--api-assets-load) (`api.assets.load`, as in `behavior`): Start loading the asset or resource with this id or address, or every one with this label. Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading' until the assets are ready, a later step.
- [Release assets](graph-behavior-5.md#node-behavior--api-assets-release) (`api.assets.release`, as in `behavior`): Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
- [Assets state](graph-behavior-5.md#node-behavior--api-assets-state) (`api.assets.state`, as in `behavior`): A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
- [Assets ready](graph-behavior-5.md#node-behavior--api-assets-ready) (`api.assets.ready`, as in `behavior`): True once a handle's assets are loaded.
- [Assets error](graph-behavior-5.md#node-behavior--api-assets-error) (`api.assets.error`, as in `behavior`): Why a failed handle failed ('' otherwise).

<a id="graph-behavior-function--ui"></a>
## UI

- [Set UI value](graph-behavior-5.md#node-behavior--api-ui-set) (`api.ui.set`, as in `behavior`): Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
- [UI value](graph-behavior-5.md#node-behavior--api-ui-get) (`api.ui.get`, as in `behavior`): The published value at a path (null when there is none).
- [Clear UI value](graph-behavior-5.md#node-behavior--api-ui-clear) (`api.ui.clear`, as in `behavior`): Remove a path from the view model (`false` when it was not there).
- [Show UI](graph-behavior-5.md#node-behavior--api-ui-show) (`api.ui.show`, as in `behavior`): Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
- [Hide UI](graph-behavior-5.md#node-behavior--api-ui-hide) (`api.ui.hide`, as in `behavior`): Hide a shown UI document (`false` when it was not shown).
- [UI shown](graph-behavior-5.md#node-behavior--api-ui-is-shown) (`api.ui.isShown`, as in `behavior`): The document is shown.
- [Play UI tween](graph-behavior-5.md#node-behavior--api-ui-play) (`api.ui.play`, as in `behavior`): Play a tween of a document (on a widget, or the whole document). Presentation only.
- [Focus UI widget](graph-behavior-5.md#node-behavior--api-ui-focus) (`api.ui.focus`, as in `behavior`): Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.
- [UI view](graph-behavior-5.md#node-behavior--api-ui-view) (`api.ui.view`, as in `behavior`): The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.
- [UI events](graph-behavior-5.md#node-behavior--api-ui-events) (`api.ui.events`, as in `behavior`): The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
- [UI event](graph-behavior-5.md#node-behavior--api-ui-event) (`api.ui.event`, as in `behavior`): The first UI event of this step with this name (a button's or an input's event), or null.
