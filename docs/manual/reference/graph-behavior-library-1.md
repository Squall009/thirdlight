# Graph: Shared script function (part 1, from Shared script function)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Shared script function node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-behavior-library"></a>
## Shared script function

- Graph kind: `behavior-library`
- Stored in: standalone graphs (`content.graphs`)
- Node budget: 256
- Cycles: refused
- Wildcard port type: `any`
- Callable from other graphs: `fn.input` nodes are its inputs, `fn.output` nodes its outputs

Port types:

| Type | Label |
|---|---|
| `exec` | exec |
| `number` | number |
| `boolean` | boolean |
| `string` | text |
| `vector` | vector |
| `list` | list |
| `map` | map |
| `any` | any (no such variable) |

Implicit conversions:

- number → text
- boolean → text ("true"/"false")
- boolean → number (0 or 1)
- number → vector (all components)
- vector → text ("x, y, z")

<a id="graph-behavior-library--flow"></a>
## Flow

- [Branch](graph-behavior-1.md#node-behavior--flow-branch) (`flow.branch`, as in `behavior`): Continues on "true" or "false".
- [Sequence](graph-behavior-1.md#node-behavior--flow-sequence) (`flow.sequence`, as in `behavior`): Runs its outputs one after the other, top to bottom.
- [For](graph-behavior-1.md#node-behavior--flow-for) (`flow.for`, as in `behavior`): Runs "body" once per whole number from first to last (both included), then "completed". Bounded: a script may run 10000 loop iterations per step; more is a script error naming the loop.
- [For each](graph-behavior-1.md#node-behavior--flow-foreach) (`flow.foreach`, as in `behavior`): Runs "body" once per item of a list (in order), then "completed". Bounded like For (10000 iterations per step).
- [While](graph-behavior-1.md#node-behavior--flow-while) (`flow.while`, as in `behavior`): Runs "body" while the condition (read again before each round) is true, then "completed". Bounded like For (10000 iterations per step).
- [Gate](graph-behavior-1.md#node-behavior--flow-gate) (`flow.gate`, as in `behavior`): Passes the flow from "enter" to "exit" only while open; "open", "close" and "toggle" change it (per object; a new run starts it again).
- [Do once](graph-behavior-1.md#node-behavior--flow-doonce) (`flow.doonce`, as in `behavior`): Passes the flow the first time only (per object and run) until "reset".
- [Switch](graph-behavior-1.md#node-behavior--flow-switch) (`flow.switch`, as in `behavior`): Continues on the first case equal to the value (text, or a whole number), else on "default". The cases are a comma-separated list — one output per case (at most 32); empty cases never match.
- [Select](graph-behavior-1.md#node-behavior--flow-select) (`flow.select`, as in `behavior`): a when the condition is true, else b.

<a id="graph-behavior-library--variables"></a>
## Variables

- [Number variable](graph-behavior-function-1.md#node-behavior-function--var-number) (`var.number`, as in `behavior-function`): Declares a number variable. Local to one call of the function (it starts at its default each call).
- [Boolean variable](graph-behavior-function-1.md#node-behavior-function--var-boolean) (`var.boolean`, as in `behavior-function`): Declares a boolean variable. Local to one call of the function (it starts at its default each call).
- [Text variable](graph-behavior-function-1.md#node-behavior-function--var-string) (`var.string`, as in `behavior-function`): Declares a text variable. Local to one call of the function (it starts at its default each call).
- [Vector variable](graph-behavior-function-1.md#node-behavior-function--var-vector) (`var.vector`, as in `behavior-function`): Declares a vector variable. Local to one call of the function (it starts at its default each call).
- [Entity variable](graph-behavior-function-1.md#node-behavior-function--var-entity) (`var.entity`, as in `behavior-function`): Declares a entity variable (an entity id; as a property, picked in the Inspector). Local to one call of the function (it starts at its default each call).
- [Choice variable](graph-behavior-function-1.md#node-behavior-function--var-enum) (`var.enum`, as in `behavior-function`): Declares a choice variable (one of the listed choices). Local to one call of the function (it starts at its default each call).
- [List variable](graph-behavior-function-1.md#node-behavior-function--var-list) (`var.list`, as in `behavior-function`): Declares a list variable. Local to one call of the function (it starts at its default each call).
- [Map variable](graph-behavior-function-1.md#node-behavior-function--var-map) (`var.map`, as in `behavior-function`): Declares a map variable. Local to one call of the function (it starts at its default each call).
- [Get variable](graph-behavior-1.md#node-behavior--var-get) (`var.get`, as in `behavior`): Reads a variable (its output takes the variable's type).
- [Set variable](graph-behavior-1.md#node-behavior--var-set) (`var.set`, as in `behavior`): Writes a variable. Unwired, it writes "Value": a number, true/false, text, or "x, y, z" for the variable's type (empty = its type's zero; lists and maps become empty).

<a id="graph-behavior-library--functions"></a>
## Functions

- [Function start](graph-behavior-function-1.md#node-behavior-function--fn-entry) (`fn.entry`, as in `behavior-function`): Where a call of the function starts its flow.
- [Input](graph-behavior-function-1.md#node-behavior-function--fn-input) (`fn.input`, as in `behavior-function`): One of the function's inputs (a port of every call, top to bottom).
- [Output](graph-behavior-function-1.md#node-behavior-function--fn-output) (`fn.output`, as in `behavior-function`): One of the function's outputs (a port of every call): the value wired into it when the flow has finished.
- [Call shared function](graph-behavior-1.md#node-behavior--fn-library) (`fn.library`, as in `behavior`): Runs a shared function (a function graph of the project's library, usable from every script).

<a id="graph-behavior-library--constants"></a>
## Constants

- [Number](graph-behavior-1.md#node-behavior--const-number) (`const.number`, as in `behavior`): A fixed number.
- [Boolean](graph-behavior-1.md#node-behavior--const-boolean) (`const.boolean`, as in `behavior`): A fixed boolean.
- [Text](graph-behavior-1.md#node-behavior--const-text) (`const.text`, as in `behavior`): A fixed text.
- [Vector](graph-behavior-1.md#node-behavior--const-vector) (`const.vector`, as in `behavior`): A fixed vector.

<a id="graph-behavior-library--maths"></a>
## Maths

- [Add](graph-behavior-1.md#node-behavior--math-add) (`math.add`, as in `behavior`): a + b
- [Subtract](graph-behavior-1.md#node-behavior--math-subtract) (`math.subtract`, as in `behavior`): a − b
- [Multiply](graph-behavior-1.md#node-behavior--math-multiply) (`math.multiply`, as in `behavior`): a × b
- [Divide](graph-behavior-1.md#node-behavior--math-divide) (`math.divide`, as in `behavior`): a ÷ b (0 when b is 0, so values stay finite)
- [Modulo](graph-behavior-1.md#node-behavior--math-modulo) (`math.modulo`, as in `behavior`): The remainder of a ÷ b, with the sign of b (0 when b is 0).
- [Power](graph-behavior-1.md#node-behavior--math-power) (`math.power`, as in `behavior`): a to the power b (0 when the result is not a finite number).
- [Min](graph-behavior-1.md#node-behavior--math-min) (`math.min`, as in `behavior`): The smaller of a and b.
- [Max](graph-behavior-1.md#node-behavior--math-max) (`math.max`, as in `behavior`): The larger of a and b.
- [Absolute](graph-behavior-1.md#node-behavior--math-abs) (`math.abs`, as in `behavior`): |value|
- [Negate](graph-behavior-1.md#node-behavior--math-negate) (`math.negate`, as in `behavior`): −value
- [Floor](graph-behavior-1.md#node-behavior--math-floor) (`math.floor`, as in `behavior`): The whole number at or below value.
- [Ceiling](graph-behavior-1.md#node-behavior--math-ceil) (`math.ceil`, as in `behavior`): The whole number at or above value.
- [Round](graph-behavior-1.md#node-behavior--math-round) (`math.round`, as in `behavior`): The nearest whole number (halves away from zero).
- [Sign](graph-behavior-1.md#node-behavior--math-sign) (`math.sign`, as in `behavior`): −1, 0 or 1.
- [Square root](graph-behavior-1.md#node-behavior--math-sqrt) (`math.sqrt`, as in `behavior`): √value (0 below 0).
- [Clamp](graph-behavior-1.md#node-behavior--math-clamp) (`math.clamp`, as in `behavior`): value kept between min and max.
- [Lerp](graph-behavior-1.md#node-behavior--math-lerp) (`math.lerp`, as in `behavior`): a + (b − a) × t.
- [Sine](graph-behavior-1.md#node-behavior--math-sin) (`math.sin`, as in `behavior`): sin of an angle in degrees.
- [Cosine](graph-behavior-1.md#node-behavior--math-cos) (`math.cos`, as in `behavior`): cos of an angle in degrees.
- [Angle of](graph-behavior-1.md#node-behavior--math-atan2) (`math.atan2`, as in `behavior`): The angle (degrees) of the direction (x, y), from +x towards +y.
- [Compare](graph-behavior-1.md#node-behavior--math-compare) (`math.compare`, as in `behavior`): Compares two numbers.

<a id="graph-behavior-library--logic"></a>
## Logic

- [And](graph-behavior-1.md#node-behavior--logic-and) (`logic.and`, as in `behavior`): true when a and b are true
- [Or](graph-behavior-1.md#node-behavior--logic-or) (`logic.or`, as in `behavior`): true when a or b is true
- [Xor](graph-behavior-1.md#node-behavior--logic-xor) (`logic.xor`, as in `behavior`): true when exactly one of a and b is true
- [Not](graph-behavior-1.md#node-behavior--logic-not) (`logic.not`, as in `behavior`): true when the value is false

<a id="graph-behavior-library--text"></a>
## Text

- [Join text](graph-behavior-1.md#node-behavior--text-join) (`text.join`, as in `behavior`): a followed by b.
- [Text equals](graph-behavior-1.md#node-behavior--text-equal) (`text.equal`, as in `behavior`): true when a and b are the same text.
- [Text contains](graph-behavior-1.md#node-behavior--text-contains) (`text.contains`, as in `behavior`): true when the text contains the part.
- [Text length](graph-behavior-1.md#node-behavior--text-length) (`text.length`, as in `behavior`): The number of characters.
- [Text to number](graph-behavior-1.md#node-behavior--text-number) (`text.number`, as in `behavior`): The number a text spells (0 when it is not a number).

<a id="graph-behavior-library--vectors"></a>
## Vectors

- [Make vector](graph-behavior-1.md#node-behavior--vec-make) (`vec.make`, as in `behavior`): (x, y, z).
- [Break vector](graph-behavior-1.md#node-behavior--vec-break) (`vec.break`, as in `behavior`): The x, y and z of a vector.
- [Add vectors](graph-behavior-1.md#node-behavior--vec-add) (`vec.add`, as in `behavior`): a + b
- [Subtract vectors](graph-behavior-1.md#node-behavior--vec-subtract) (`vec.subtract`, as in `behavior`): a − b
- [Scale vector](graph-behavior-1.md#node-behavior--vec-scale) (`vec.scale`, as in `behavior`): vector × factor
- [Vector length](graph-behavior-1.md#node-behavior--vec-length) (`vec.length`, as in `behavior`): The length of a vector.
- [Distance](graph-behavior-1.md#node-behavior--vec-distance) (`vec.distance`, as in `behavior`): The distance between two points.
- [Normalize](graph-behavior-1.md#node-behavior--vec-normalize) (`vec.normalize`, as in `behavior`): The vector with length 1 (0, 0, 0 stays 0, 0, 0).
- [Dot product](graph-behavior-1.md#node-behavior--vec-dot) (`vec.dot`, as in `behavior`): a · b
- [Cross product](graph-behavior-1.md#node-behavior--vec-cross) (`vec.cross`, as in `behavior`): a × b
- [Lerp vectors](graph-behavior-1.md#node-behavior--vec-lerp) (`vec.lerp`, as in `behavior`): a + (b − a) × t

<a id="graph-behavior-library--lists"></a>
## Lists

- [Make list](graph-behavior-1.md#node-behavior--list-make) (`list.make`, as in `behavior`): A list of the first "count" items (unwired items are their type's zero). Lists keep at most 1024 items. List nodes never change a list: they give a new one (store it with Set variable).
- [List length](graph-behavior-1.md#node-behavior--list-length) (`list.length`, as in `behavior`): The number of items.
- [Get item](graph-behavior-1.md#node-behavior--list-get) (`list.get`, as in `behavior`): The item at an index (0 is the first; found is false outside the list).
- [Set item](graph-behavior-1.md#node-behavior--list-set) (`list.set`, as in `behavior`): The list with the item at an index replaced (unchanged outside the list).
- [Add item](graph-behavior-1.md#node-behavior--list-add) (`list.add`, as in `behavior`): The list with an item added at the end (at most 1024 items: more is a script error).
- [Remove item](graph-behavior-1.md#node-behavior--list-remove) (`list.remove`, as in `behavior`): The list without the item at an index.
- [List contains](graph-behavior-1.md#node-behavior--list-contains) (`list.contains`, as in `behavior`): true when an item equals the value.
- [Index of](graph-behavior-2.md#node-behavior--list-index-of) (`list.indexOf`, as in `behavior`): The index of the first item equal to the value (−1 when none).

<a id="graph-behavior-library--maps"></a>
## Maps

- [Empty map](graph-behavior-2.md#node-behavior--map-make) (`map.make`, as in `behavior`): A map with no entries (text keys to values; at most 256 entries). Map nodes never change a map: they give a new one.
- [Set entry](graph-behavior-2.md#node-behavior--map-set) (`map.set`, as in `behavior`): The map with the key set to the value (at most 256 entries: more is a script error).
- [Get entry](graph-behavior-2.md#node-behavior--map-get) (`map.get`, as in `behavior`): The key's value (found is false when the map has no such key).
- [Has key](graph-behavior-2.md#node-behavior--map-has) (`map.has`, as in `behavior`): true when the map has the key.
- [Remove entry](graph-behavior-2.md#node-behavior--map-remove) (`map.remove`, as in `behavior`): The map without the key.
- [Map size](graph-behavior-2.md#node-behavior--map-size) (`map.size`, as in `behavior`): The number of entries.
- [Map keys](graph-behavior-2.md#node-behavior--map-keys) (`map.keys`, as in `behavior`): The keys (in the order they were first set) as a list of texts.

<a id="graph-behavior-library--random"></a>
## Random

- [Random number](graph-behavior-2.md#node-behavior--random-number) (`random.number`, as in `behavior`): A number from min up to (not including) max. Deterministic: each object draws from its own sequence, which starts again with every run (a replay repeats it). Every read draws the next number.
- [Random integer](graph-behavior-2.md#node-behavior--random-integer) (`random.integer`, as in `behavior`): A whole number from min to max (both included), from the object's deterministic sequence.
- [Random chance](graph-behavior-2.md#node-behavior--random-chance) (`random.chance`, as in `behavior`): true with the given probability (0–1), from the object's deterministic sequence.
- [Seeded random (stream)](graph-behavior-2.md#node-behavior--api-random-stream-next) (`api.random.stream.next`, as in `behavior`): A number in [0, 1) (a multiple of 2^-32).
- [Seeded random range (stream)](graph-behavior-2.md#node-behavior--api-random-stream-range) (`api.random.stream.range`, as in `behavior`): A number in [min, max).
- [Seeded random integer (stream)](graph-behavior-2.md#node-behavior--api-random-stream-int) (`api.random.stream.int`, as in `behavior`): A whole number from `min` to `max`, both included (the bounds are rounded inward).
- [Seeded chance (stream)](graph-behavior-2.md#node-behavior--api-random-stream-chance) (`api.random.stream.chance`, as in `behavior`): True with probability `p` (0: never, 1: always).
- [Seeded random](graph-behavior-2.md#node-behavior--api-random-next) (`api.random.next`, as in `behavior`): A number in [0, 1) (a multiple of 2^-32).
- [Seeded random range](graph-behavior-2.md#node-behavior--api-random-range) (`api.random.range`, as in `behavior`): A number in [min, max).
- [Seeded random integer](graph-behavior-2.md#node-behavior--api-random-int) (`api.random.int`, as in `behavior`): A whole number from `min` to `max`, both included (the bounds are rounded inward).
- [Seeded chance](graph-behavior-2.md#node-behavior--api-random-chance) (`api.random.chance`, as in `behavior`): True with probability `p` (0: never, 1: always).

<a id="graph-behavior-library--debug"></a>
## Debug

- [Log](graph-behavior-2.md#node-behavior--debug-log) (`debug.log`, as in `behavior`): Writes a line to the play log.

<a id="graph-behavior-library--script"></a>
## Script

- [Script id](graph-behavior-2.md#node-behavior--api-behavior-id) (`api.behaviorId`, as in `behavior`): The behavior's id.
- [This object](graph-behavior-2.md#node-behavior--api-entity-id) (`api.entityId`, as in `behavior`): The entity carrying this script instance.
- [Step index](graph-behavior-2.md#node-behavior--api-step-index) (`api.stepIndex`, as in `behavior`): The fixed step counter of the run.
- [Phase](graph-behavior-2.md#node-behavior--api-phase) (`api.phase`, as in `behavior`): The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms).
- [Properties](graph-behavior-2.md#node-behavior--api-properties) (`api.properties`, as in `behavior`): The instance's property values (declaration defaults with the object's overrides).
- [Spawn prefab](graph-behavior-2.md#node-behavior--api-spawn) (`api.spawn`, as in `behavior`): Copy a project prefab into the running game; returns the new root id (or null at an engine limit).
- [Destroy spawned](graph-behavior-2.md#node-behavior--api-destroy) (`api.destroy`, as in `behavior`): Remove a spawned entity at the next step boundary. An empty entity means this object.

<a id="graph-behavior-library--action"></a>
## Action

- [Action step index](graph-behavior-2.md#node-behavior--api-action-step-index) (`api.action.stepIndex`, as in `behavior`): Integer, `0 ≤ v ≤ 2^53−1` — the executed fixed-step index.
- [Action actions](graph-behavior-2.md#node-behavior--api-action-actions) (`api.action.actions`, as in `behavior`): Optional: every named input action this step — `v` its value (a button 0/1, an axis −1..1 after its processors), `x`/`y` for a 2D axis, `p` the button phase. Absent: no action has a value (all neutral).
- [Action pointer](graph-behavior-2.md#node-behavior--api-action-pointer) (`api.action.pointer`, as in `behavior`): Optional: the pointer (mouse, pen, touch) this step. Absent: no new sample — the runtime keeps the last position, buttons and over/locked state (no movement, no edges).

<a id="graph-behavior-library--intents"></a>
## Intents

- [Intents step index](graph-behavior-2.md#node-behavior--api-intents-step-index) (`api.intents.stepIndex`, as in `behavior`): 
- [Intents move](graph-behavior-2.md#node-behavior--api-intents-move) (`api.intents.move`, as in `behavior`): The committed `control_move` (quantized) or `null`.
- [Intents jump](graph-behavior-2.md#node-behavior--api-intents-jump) (`api.intents.jump`, as in `behavior`): The committed `control_jump` or `null`.
- [Intents move writer](graph-behavior-2.md#node-behavior--api-intents-move-writer) (`api.intents.moveWriter`, as in `behavior`): The module ID that committed `move`, or `null`.
- [Intents jump writer](graph-behavior-2.md#node-behavior--api-intents-jump-writer) (`api.intents.jumpWriter`, as in `behavior`): 
- [Intents transform writes](graph-behavior-2.md#node-behavior--api-intents-transform-writes) (`api.intents.transformWrites`, as in `behavior`): Committed transform writes, in commit order.
- [Intents move y](graph-behavior-2.md#node-behavior--api-intents-move-y) (`api.intents.moveY`, as in `behavior`): The committed `control_move`'s second axis (0 when it had none), or null.
- [Intents character move](graph-behavior-2.md#node-behavior--api-intents-character-move) (`api.intents.characterMove`, as in `behavior`): The committed `character_move` (a world direction on the ground), or null.
- [Intents character place](graph-behavior-2.md#node-behavior--api-intents-character-place) (`api.intents.characterPlace`, as in `behavior`): The committed `character_place` point, or null.
- [Intents character enabled](graph-behavior-2.md#node-behavior--api-intents-character-enabled) (`api.intents.characterEnabled`, as in `behavior`): The committed `character_enable` value, or null.
- [Intents impulse](graph-behavior-2.md#node-behavior--api-intents-impulse) (`api.intents.impulse`, as in `behavior`): The velocity (m/s) scripts' `ctx.character.impulse` calls add at this controller phase (summed; absent: none).
- [Intents character yaw](graph-behavior-2.md#node-behavior--api-intents-character-yaw) (`api.intents.characterYaw`, as in `behavior`): The yaw (radians about +Y, 0 facing +Z) a placement this step faces (a spawn's yaw; absent: as it was).
- [Intents controllers](graph-behavior-2.md#node-behavior--api-intents-controllers) (`api.intents.controllers`, as in `behavior`): The further player controllers' channels this step, by their object's id (present only when an intent, an impulse or a placement named one; the fields above are the first controller's). Read them with `controllerIntents`.
- [Control move](graph-behavior-2.md#node-behavior--api-emit-control-move) (`api.emit.control_move`, as in `behavior`): `−1 ≤ value ≤ 1`, quantized at commit. Runs only in the intent phase.
- [Control jump](graph-behavior-2.md#node-behavior--api-emit-control-jump) (`api.emit.control_jump`, as in `behavior`): One `JumpPhase` value. Runs only in the intent phase.
- [Move object](graph-behavior-2.md#node-behavior--api-emit-transform) (`api.emit.transform`, as in `behavior`): A position write on ONE owned entity axis set. It may also set the rotation, as a `quaternion` or a `facing` direction (fields in the order kind, entityId, position, quaternion, facing, up). Runs only in the transform phase. An empty entity means this object.
- [Pose object](graph-behavior-2.md#node-behavior--api-emit-pose) (`api.emit.pose`, as in `behavior`): An owned entity's rotation (degrees: yaw about +Y, pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual (colliders keep their shape). Fields in the order kind, entityId, rotation, scale; at least one of rotation and scale. The rotation may instead be a `quaternion` or a `facing` direction (order kind,  Runs only in the transform phase. An empty entity means this object.
- [Respawn player](graph-behavior-2.md#node-behavior--api-emit-respawn) (`api.emit.respawn`, as in `behavior`): Kill the player (intent phase; ignored unless the run is playing). Runs only in the intent phase.
- [Walk character](graph-behavior-2.md#node-behavior--api-emit-character-move) (`api.emit.character_move`, as in `behavior`): 3D projects: walk the player character this step along a world direction on the ground (x, z; a length above 1 counts as 1 — its length scales the walk speed), replacing the move input; `run` uses the run speed. Intent phase. Runs only in the intent phase.
- [Place character](graph-behavior-2.md#node-behavior--api-emit-character-place) (`api.emit.character_place`, as in `behavior`): Teleport the player character (its origin) to a point, stopping its motion; it falls from there. Intent phase; it takes effect before the controller runs in the same step. On the 2D plane too (z is ignored there), with the placement of scene arrivals and respawns (from rest: velocity and jump reset). Runs only in the intent phase.
- [Enable character](graph-behavior-2.md#node-behavior--api-emit-character-enable) (`api.emit.character_enable`, as in `behavior`): 3D projects: switch the character controller off (the character stays where it is: no input, no gravity — a cutscene or a dialogue) or back on. Lasts until changed. Intent phase. Runs only in the intent phase.

<a id="graph-behavior-library--settings"></a>
## Settings

- [Settings gravity y](graph-behavior-2.md#node-behavior--api-settings-gravity-y) (`api.settings.gravity_y`, as in `behavior`): 
- [Settings run speed](graph-behavior-2.md#node-behavior--api-settings-run-speed) (`api.settings.run_speed`, as in `behavior`): 
- [Settings jump velocity](graph-behavior-2.md#node-behavior--api-settings-jump-velocity) (`api.settings.jump_velocity`, as in `behavior`): 
- [Settings max fall speed](graph-behavior-2.md#node-behavior--api-settings-max-fall-speed) (`api.settings.max_fall_speed`, as in `behavior`): 
- [Settings max slope climb deg](graph-behavior-2.md#node-behavior--api-settings-max-slope-climb-deg) (`api.settings.max_slope_climb_deg`, as in `behavior`): 
- [Settings min slope slide deg](graph-behavior-2.md#node-behavior--api-settings-min-slope-slide-deg) (`api.settings.min_slope_slide_deg`, as in `behavior`): 
- [Settings fixed step hz](graph-behavior-2.md#node-behavior--api-settings-fixed-step-hz) (`api.settings.fixed_step_hz`, as in `behavior`): Engine settings, present only when the project sets them (absent: the engine default).
- [Settings audio voices](graph-behavior-2.md#node-behavior--api-settings-audio-voices) (`api.settings.audio_voices`, as in `behavior`): 
- [Settings music fade s](graph-behavior-2.md#node-behavior--api-settings-music-fade-s) (`api.settings.music_fade_s`, as in `behavior`): 
- [Settings animation crossfade s](graph-behavior-2.md#node-behavior--api-settings-animation-crossfade-s) (`api.settings.animation_crossfade_s`, as in `behavior`): 
- [Settings render backend](graph-behavior-2.md#node-behavior--api-settings-render-backend) (`api.settings.render_backend`, as in `behavior`): The renderer backend (0 WebGL legacy, 1 auto, 2 WebGPU, 3 WebGL 2; absent: 0).
- [Settings sim thread](graph-behavior-2.md#node-behavior--api-settings-sim-thread) (`api.settings.sim_thread`, as in `behavior`): Where the simulation runs in Play and the export (1 a worker, 2 the page's main thread; absent: 1).
- [Settings texture budget mb](graph-behavior-2.md#node-behavior--api-settings-texture-budget-mb) (`api.settings.texture_budget_mb`, as in `behavior`): The texture budget of Play and the export in MiB (absent: `TEXTURE_BUDGET_DEFAULT_MB`).
- [Settings frame rate cap](graph-behavior-2.md#node-behavior--api-settings-frame-rate-cap) (`api.settings.frame_rate_cap`, as in `behavior`): The most frames per second Play and the export draw (30, 60, 120; absent or 0: none, the display's rate).
- [Settings ambient occlusion](graph-behavior-2.md#node-behavior--api-settings-ambient-occlusion) (`api.settings.ambient_occlusion`, as in `behavior`): The kind of ambient occlusion where a look turns it on (0 off, 1 SSAO, 2 GTAO; absent: SSAO).
- [Settings render scale](graph-behavior-2.md#node-behavior--api-settings-render-scale) (`api.settings.render_scale`, as in `behavior`): The share of the screen's resolution Play and the export draw at (0.5–1; absent: 1).
- [Settings dynamic resolution](graph-behavior-2.md#node-behavior--api-settings-dynamic-resolution) (`api.settings.dynamic_resolution`, as in `behavior`): Whether the render scale drops while the GPU runs over budget (0 off, 1 on; absent: off).
- [Settings streaming budget mb](graph-behavior-2.md#node-behavior--api-settings-streaming-budget-mb) (`api.settings.streaming_budget_mb`, as in `behavior`): The memory streamed terrain tiles and block chunks may take in Play and the export, MiB (absent: `STREAMING_BUDGET_DEFAULT_MB`).
- [Settings architecture ship meshes](graph-behavior-2.md#node-behavior--api-settings-architecture-ship-meshes) (`api.settings.architecture_ship_meshes`, as in `behavior`): Exports ship generated architecture's meshes too (0 no, 1 yes; absent: no, generated at load).

<a id="graph-behavior-library--physics"></a>
## Physics

- [Character result](graph-behavior-2.md#node-behavior--api-physics-character-result) (`api.physics.characterResult`, as in `behavior`): A player controller's result of the last completed step (`entityId`, absent: the first player controller), or `undefined` before the first step. An empty entity means this object.
- [Raycast](graph-behavior-2.md#node-behavior--api-physics-raycast) (`api.physics.raycast`, as in `behavior`): A ray against the level's colliders (bounded per step; null when nothing is hit).
- [Overlap box](graph-behavior-2.md#node-behavior--api-physics-overlap-box) (`api.physics.overlapBox`, as in `behavior`): The entities whose colliders overlap a box (center, half extents) — counted with the rays.
- [Overlap circle](graph-behavior-2.md#node-behavior--api-physics-overlap-circle) (`api.physics.overlapCircle`, as in `behavior`): The entities whose colliders overlap a circle — counted with the rays.
- [Character state](graph-behavior-2.md#node-behavior--api-physics-character-state) (`api.physics.characterState`, as in `behavior`): 3D projects: a player character's state after the last completed step (`entityId`, absent: the first player controller) — position, velocity, grounding, contacts, whether its controller is on and whether it is climbing a ledge — or undefined (a 2D plane, before the first step, or not a player controller). An empty entity means this object.
- [Raycast 3D](graph-behavior-2.md#node-behavior--api-physics-raycast3d) (`api.physics.raycast3d`, as in `behavior`): 3D projects: the nearest collider a ray from `origin` along `direction` hits within `maxDistance` metres (default 100), or null — its object, the point, the surface normal and the distance. Counted with the other queries (at most 64 a step).
- [Overlap sphere](graph-behavior-2.md#node-behavior--api-physics-overlap-sphere) (`api.physics.overlapSphere`, as in `behavior`): 3D projects: the objects whose colliders overlap a sphere (sorted ids, at most 64).
- [Overlap box 3D](graph-behavior-2.md#node-behavior--api-physics-overlap-box3d) (`api.physics.overlapBox3d`, as in `behavior`): 3D projects: the objects whose colliders overlap a box — centre, half extents [x, y, z] and an optional rotation quaternion [x, y, z, w].
- [Overlap capsule](graph-behavior-2.md#node-behavior--api-physics-overlap-capsule) (`api.physics.overlapCapsule`, as in `behavior`): 3D projects: the objects whose colliders overlap an upright capsule (total height, end caps included), optionally turned by a quaternion [x, y, z, w].
- [Pick at screen point](graph-behavior-2.md#node-behavior--api-physics-pick-at) (`api.physics.pickAt`, as in `behavior`): 3D projects: what is under a screen point (x, y 0–1 from the top left): the ray from the active camera (`ctx.camera.screenToRay`) cast into the colliders, within `maxDistance` (default 1000 m).
- [Pick at pointer](graph-behavior-2.md#node-behavior--api-physics-pick-at-pointer) (`api.physics.pickAtPointer`, as in `behavior`): 3D projects: what is under the pointer this step (null while the pointer is outside the view or never moved); with a locked cursor, what is at the view's centre.

<a id="graph-behavior-library--tags"></a>
## Tags

- [Tag mask](graph-behavior-2.md#node-behavior--api-tags-mask) (`api.tags.mask`, as in `behavior`): The mask of the named tags (names ignore case). Throws on an unknown name.
- [Tags of](graph-behavior-2.md#node-behavior--api-tags-of) (`api.tags.of`, as in `behavior`): The entity's effective tag mask (0 for an unknown entity). An empty entity means this object.
- [Has tags](graph-behavior-2.md#node-behavior--api-tags-has) (`api.tags.has`, as in `behavior`): Whether the entity carries any (default) or all of the mask's bits. An empty entity means this object.
- [Find by tags](graph-behavior-2.md#node-behavior--api-tags-query) (`api.tags.query`, as in `behavior`): The entities carrying any (default) or all of the mask's bits, in scene order.

<a id="graph-behavior-library--world"></a>
## World

- [Transform of](graph-behavior-2.md#node-behavior--api-world-transform) (`api.world.transform`, as in `behavior`): The entity's transform this step so far, local to its parent (as the Inspector shows it; a root object's is its world transform), or `undefined` when it is not loaded. `{space: 'world'}` reads the world transform instead (as `worldTransform`). An empty entity means this object.
- [World transform of](graph-behavior-3.md#node-behavior--api-world-world-transform) (`api.world.worldTransform`, as in `behavior`): The entity's world transform this step so far: its transform composed up its parents, where it is drawn. Under a parent scaled unevenly and turned, the scale is the length of each world axis. `undefined` when it is not loaded. An empty entity means this object.
- [Find object by name](graph-behavior-3.md#node-behavior--api-world-find) (`api.world.find`, as in `behavior`): The first loaded entity whose name is exactly `name` (case-sensitive), or `undefined`. Entities are searched in load order: the start scene in document order, then later scenes and spawned copies as they arrived.
- [Find objects by name](graph-behavior-3.md#node-behavior--api-world-find-all) (`api.world.findAll`, as in `behavior`): Every loaded entity whose name is exactly `name` (case-sensitive), in load order (spawned copies included).
- [Find objects with component](graph-behavior-3.md#node-behavior--api-world-with-component) (`api.world.withComponent`, as in `behavior`): Every loaded entity carrying a component of this kind (as stored on the entity, e.g. `'collider'`, `'light'`, `'behavior'`), in load order (spawned copies included).

<a id="graph-behavior-library--scenes"></a>
## Scenes

- [Load scene](graph-behavior-3.md#node-behavior--api-scenes-load) (`api.scenes.load`, as in `behavior`): Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op.
- [Unload scene](graph-behavior-3.md#node-behavior--api-scenes-unload) (`api.scenes.unload`, as in `behavior`): Request an unload at the next step boundary. Unloaded ⇒ no-op.
- [Reload scene](graph-behavior-3.md#node-behavior--api-scenes-reload) (`api.scenes.reload`, as in `behavior`): Request a reload at the next step boundary: the scene's objects return as authored (where it was loaded), the copies its objects spawned go, its scripts start over (as at a run restart), its sounds stop. Kept objects, `ctx.save`, the counters and the other scenes stay as they are. An unloaded scene loads; a loading one ⇒ no-op. Refused for a scene holding a player that is not kept loaded.
- [Scene status](graph-behavior-3.md#node-behavior--api-scenes-status) (`api.scenes.status`, as in `behavior`): Where a scene is in its load cycle.
- [Loaded scenes](graph-behavior-3.md#node-behavior--api-scenes-loaded) (`api.scenes.loaded`, as in `behavior`): The loaded scene ids, in load order.
- [Loading scenes](graph-behavior-3.md#node-behavior--api-scenes-loading) (`api.scenes.loading`, as in `behavior`): The scenes being loaded (asked for, not yet in), in request order.
- [Scene transition](graph-behavior-3.md#node-behavior--api-scenes-transition) (`api.scenes.transition`, as in `behavior`): The scene transition in progress (its scene, `out` while the view fades out, `loading` while the scene loads), or null.
- [Active scene](graph-behavior-3.md#node-behavior--api-scenes-active) (`api.scenes.active`, as in `behavior`): The active scene: its sky, fog, post-processing and wind are the look (the first start scene at first; a transition that unloads it makes its scene active).
- [Set active scene](graph-behavior-3.md#node-behavior--api-scenes-set-active) (`api.scenes.setActive`, as in `behavior`): Make a loaded scene the active one: its look blends in over `blend` seconds (0: at once). Applies with the step.

<a id="graph-behavior-library--input"></a>
## Input

- [Input value](graph-behavior-3.md#node-behavior--api-input-value) (`api.input.value`, as in `behavior`): A button 0/1, a 1D axis −1..1, a 2D axis's length; 0 for an unknown name.
- [Input vector](graph-behavior-3.md#node-behavior--api-input-vector) (`api.input.vector`, as in `behavior`): A 2D axis as [x, y] ([value, 0] for others).
- [Input pressed](graph-behavior-3.md#node-behavior--api-input-pressed) (`api.input.pressed`, as in `behavior`): Pressed in this step.
- [Input released](graph-behavior-3.md#node-behavior--api-input-released) (`api.input.released`, as in `behavior`): Released in this step.
- [Input held](graph-behavior-3.md#node-behavior--api-input-held) (`api.input.held`, as in `behavior`): Down this step (pressed or held).
- [Pointer](graph-behavior-3.md#node-behavior--api-input-pointer) (`api.input.pointer`, as in `behavior`): The pointer this step — where it is in the view (x, y 0–1 from the top left), how far it moved since the last step, the wheel, whether it is over the view (and entered or left it this step), whether the cursor is locked and whether it is over a UI element (`overUi`: a click there went to the UI); null before the pointer is first seen.
- [Pointer pressed](graph-behavior-3.md#node-behavior--api-input-pointer-pressed) (`api.input.pointerPressed`, as in `behavior`): A pointer button (default left) went down this step — a click.
- [Pointer released](graph-behavior-3.md#node-behavior--api-input-pointer-released) (`api.input.pointerReleased`, as in `behavior`): A pointer button (default left) went up this step.
- [Pointer held](graph-behavior-3.md#node-behavior--api-input-pointer-held) (`api.input.pointerHeld`, as in `behavior`): A pointer button (default left) is down this step.
- [Any button pressed](graph-behavior-3.md#node-behavior--api-input-any-pressed) (`api.input.anyPressed`, as in `behavior`): Any key, mouse or pad button that went down this step, bound to an action or not — its device (keyboard, mouse, gamepad) and code (a key's code such as `KeyK` or `Space`, `left`/`right`/`middle`, `button0`…), or null. A key or pad button before a mouse button when several went down.
- [Set cursor](graph-behavior-3.md#node-behavior--api-input-set-cursor) (`api.input.setCursor`, as in `behavior`): Ask for a free or a locked cursor (locked: hidden and held in the view — its movement still counts); 'auto' goes back to the active input map's setting. Takes effect after the step (the player may have to click the view once before the browser locks it).
- [Using gamepad](graph-behavior-3.md#node-behavior--api-input-using-gamepad) (`api.input.usingGamepad`, as in `behavior`): The player used a gamepad last (else the keyboard or mouse).
- [Action glyph label](graph-behavior-3.md#node-behavior--api-input-glyph-label) (`api.input.glyphLabel`, as in `behavior`): An action's glyph label for the device used last ('' when it has no binding there) — e.g. "Space", "A", "Cross".
- [Action glyph icon](graph-behavior-3.md#node-behavior--api-input-glyph-icon) (`api.input.glyphIcon`, as in `behavior`): An action's glyph icon id for the device used last ('' when it has no binding there) — e.g. key, pad-south, mouse-left.
- [Rebinding](graph-behavior-3.md#node-behavior--api-input-rebinding) (`api.input.rebinding`, as in `behavior`): The rebind listening for input now (action, binding index, part), or null.
- [Cancel rebind](graph-behavior-3.md#node-behavior--api-input-cancel-rebind) (`api.input.cancelRebind`, as in `behavior`): Stop listening for a rebind.
- [Reset bindings](graph-behavior-3.md#node-behavior--api-input-reset-bindings) (`api.input.resetBindings`, as in `behavior`): Reset one action's bindings (or all, without a name) to the project's defaults.
- [Use binding profile](graph-behavior-3.md#node-behavior--api-input-use-binding-profile) (`api.input.useBindingProfile`, as in `behavior`): Use another player profile's saved bindings (a name of 1–32 letters, digits, _ or -; 'default' first).
- [Binding profile](graph-behavior-3.md#node-behavior--api-input-binding-profile) (`api.input.bindingProfile`, as in `behavior`): The player profile whose bindings are in effect.

<a id="graph-behavior-library--animator"></a>
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
