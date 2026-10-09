# Graph: Visual script (part 1, from Visual script)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-behavior"></a>
## Visual script

- Graph kind: `behavior`
- Stored in: the `behavior` documents that own it
- Node budget: 256
- Cycles: refused
- Wildcard port type: `any`

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

<a id="graph-behavior--events"></a>
## Events

- On start (`event.start`): Runs once when a run starts (a new game, a replay) — in its phase, before the other events of that step.
- On step (`event.step`): Runs every fixed simulation step in its phase (intent: decide; transform: move owned objects).
- On signal (`event.signal`): Runs in the step after the named signal was emitted (by a switch, a trigger or a script).
- On trigger (`event.trigger`): Runs once per enter (or exit) of the player into a trigger this script owns — on its object, below it, or named by one of its entity variables — in the step after it happened.
- On overlap (`event.overlap`): Every step, asks which colliders overlap a box or circle around this object (offset from it; the size is the box half extents or, in x, the circle radius) and runs per entity that starts overlapping, stops overlapping, or overlaps. Counted with the raycasts (32 per step).
- On raycast (`event.raycast`): Every step, casts a ray from this object (plus the offset) along the direction and runs when it hits (each step), starts hitting an entity, or stops hitting it. Counted with the raycasts (32 per step).
- On input (`event.input`): Runs in the step a named input action is pressed, released, or held (the game's input actions).
- On animator event (`event.animator`): Runs once per clip event an animator passed in the previous step (filtered by name and entity when set).
- On timer (`event.timer`): Runs in the step one of this script's named timers fires (start it with Start timer).
- On message (`event.message`): Runs once per message of this name sent (Send message) in the previous step to every script or to this object, with its value and sender.
- On enable (`event.enable`): Runs when this object comes into the game switched on (a run's first step, its scene loading, a spawned copy) and each time it is switched on again — before the step's other events.
- On disable (`event.disable`): Runs when this object is switched off (itself or an object above it) or leaves the game.
- On destroy (`event.destroy`): Runs when this object has left the game (destroyed, or its scene unloaded), after On disable. The object is already gone; a restart does not run it.
- On contact (`event.contact`): Runs once per contact (or separation) of a hitbox this script owns — on its object, below it, or named by one of its entity variables — with another hitbox or the character, in the step after it happened.
- On UI event (`event.ui`): Runs once per UI event of this step (a button's event, a submitted input, a document shown or hidden), filtered by event name when set.

<a id="node-behavior--event-start"></a>
### On start (`event.start`)

Runs once when a run starts (a new game, a replay) — in its phase, before the other events of that step.

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-step"></a>
### On step (`event.step`)

Runs every fixed simulation step in its phase (intent: decide; transform: move owned objects).

Outputs:

- `then` "" (exec): one wire
- `step` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-signal"></a>
### On signal (`event.signal`)

Runs in the step after the named signal was emitted (by a switch, a trigger or a script).

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `signal` | Signal | string | `""` | ≤ 64 chars |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-trigger"></a>
### On trigger (`event.trigger`)

Runs once per enter (or exit) of the player into a trigger this script owns — on its object, below it, or named by one of its entity variables — in the step after it happened.

Outputs:

- `then` "" (exec): one wire
- `trigger` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `when` | When | enum | `"enter"` | `enter`, `exit` |
| `trigger` | Only trigger (empty: any) | string | `""` | ≤ 64 chars |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-overlap"></a>
### On overlap (`event.overlap`)

Every step, asks which colliders overlap a box or circle around this object (offset from it; the size is the box half extents or, in x, the circle radius) and runs per entity that starts overlapping, stops overlapping, or overlaps. Counted with the raycasts (32 per step).

Outputs:

- `then` "" (exec): one wire
- `entity` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `shape` | Shape | enum | `"box"` | `box`, `circle` |
| `when` | When | enum | `"enter"` | `enter`, `exit`, `each` |
| `offset` | Offset | vector | `[0,0,0]` | -1000000 – 1000000; 3 components |
| `size` | Size | vector | `[0.5,0.5,0]` | 0 – 1000000; 3 components |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-raycast"></a>
### On raycast (`event.raycast`)

Every step, casts a ray from this object (plus the offset) along the direction and runs when it hits (each step), starts hitting an entity, or stops hitting it. Counted with the raycasts (32 per step).

Outputs:

- `then` "" (exec): one wire
- `entity` (string)
- `distance` (number)
- `normal` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `when` | When | enum | `"enter"` | `enter`, `exit`, `each` |
| `offset` | Offset | vector | `[0,0,0]` | -1000000 – 1000000; 3 components |
| `direction` | Direction | vector | `[1,0,0]` | -1000000 – 1000000; 3 components |
| `distance` | Distance | number | `10` | 0 – 1000000 |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-input"></a>
### On input (`event.input`)

Runs in the step a named input action is pressed, released, or held (the game's input actions).

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `action` | Action | string | `""` | ≤ 64 chars |
| `when` | When | enum | `"pressed"` | `pressed`, `released`, `held` |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-animator"></a>
### On animator event (`event.animator`)

Runs once per clip event an animator passed in the previous step (filtered by name and entity when set).

Outputs:

- `then` "" (exec): one wire
- `entity` (string)
- `name` (string)
- `clip` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `event` | Only event (empty: any) | string | `""` | ≤ 64 chars |
| `entity` | Only entity (empty: any) | string | `""` | ≤ 64 chars |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-timer"></a>
### On timer (`event.timer`)

Runs in the step one of this script's named timers fires (start it with Start timer).

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `timer` | Timer | string | `""` | ≤ 64 chars |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-message"></a>
### On message (`event.message`)

Runs once per message of this name sent (Send message) in the previous step to every script or to this object, with its value and sender.

Outputs:

- `then` "" (exec): one wire
- `value` (number): type from field `type`
- `from` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `message` | Message | string | `""` | ≤ 64 chars |
| `type` | Value type | enum | `"number"` | `number`, `boolean`, `string` |
| `phase` | Phase | enum | `"intent"` | `intent`, `transform` |

<a id="node-behavior--event-enable"></a>
### On enable (`event.enable`)

Runs when this object comes into the game switched on (a run's first step, its scene loading, a spawned copy) and each time it is switched on again — before the step's other events.

Outputs:

- `then` "" (exec): one wire

<a id="node-behavior--event-disable"></a>
### On disable (`event.disable`)

Runs when this object is switched off (itself or an object above it) or leaves the game.

Outputs:

- `then` "" (exec): one wire

<a id="node-behavior--event-destroy"></a>
### On destroy (`event.destroy`)

Runs when this object has left the game (destroyed, or its scene unloaded), after On disable. The object is already gone; a restart does not run it.

Outputs:

- `then` "" (exec): one wire

<a id="node-behavior--event-contact"></a>
### On contact (`event.contact`)

Runs once per contact (or separation) of a hitbox this script owns — on its object, below it, or named by one of its entity variables — with another hitbox or the character, in the step after it happened.

Outputs:

- `then` "" (exec): one wire
- `entity` (string)
- `other` (string)
- `normal` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `when` | When | enum | `"contact"` | `contact`, `separate` |
| `entity` | Only hitbox (empty: any) | string | `""` | ≤ 64 chars |

<a id="node-behavior--event-ui"></a>
### On UI event (`event.ui`)

Runs once per UI event of this step (a button's event, a submitted input, a document shown or hidden), filtered by event name when set.

Outputs:

- `then` "" (exec): one wire
- `kind` (string)
- `doc` "document" (string)
- `widget` (string)
- `name` (string)
- `value` (number): type from field `type`
- `index` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Only event (empty: any) | string | `""` | ≤ 64 chars |
| `type` | Value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="graph-behavior--flow"></a>
## Flow

- Branch (`flow.branch`): Continues on "true" or "false".
- Sequence (`flow.sequence`): Runs its outputs one after the other, top to bottom.
- For (`flow.for`): Runs "body" once per whole number from first to last (both included), then "completed". Bounded: a script may run 10000 loop iterations per step; more is a script error naming the loop.
- For each (`flow.foreach`): Runs "body" once per item of a list (in order), then "completed". Bounded like For (10000 iterations per step).
- While (`flow.while`): Runs "body" while the condition (read again before each round) is true, then "completed". Bounded like For (10000 iterations per step).
- Gate (`flow.gate`): Passes the flow from "enter" to "exit" only while open; "open", "close" and "toggle" change it (per object; a new run starts it again).
- Do once (`flow.doonce`): Passes the flow the first time only (per object and run) until "reset".
- Delay (`flow.delay`): Continues after the given time, counted in fixed steps (a timer of this script). While waiting, a new arrival is ignored. Values of the nodes before it are kept for the rest of the flow.
- Switch (`flow.switch`): Continues on the first case equal to the value (text, or a whole number), else on "default". The cases are a comma-separated list — one output per case (at most 32); empty cases never match.
- Select (`flow.select`): a when the condition is true, else b.

<a id="node-behavior--flow-branch"></a>
### Branch (`flow.branch`)

Continues on "true" or "false".

Inputs:

- `in` "" (exec): takes several wires
- `condition` (boolean)

Outputs:

- `true` (exec): one wire
- `false` (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `condition` | condition | boolean | `false` |  |

<a id="node-behavior--flow-sequence"></a>
### Sequence (`flow.sequence`)

Runs its outputs one after the other, top to bottom.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then1` "then 1" (exec): one wire
- `then2` "then 2" (exec): one wire
- `then3` "then 3" (exec): one wire
- `then4` "then 4" (exec): one wire

<a id="node-behavior--flow-for"></a>
### For (`flow.for`)

Runs "body" once per whole number from first to last (both included), then "completed". Bounded: a script may run 10000 loop iterations per step; more is a script error naming the loop.

Inputs:

- `in` "" (exec): takes several wires
- `first` (number)
- `last` (number)

Outputs:

- `body` (exec): one wire
- `index` (number)
- `completed` (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `first` | first | number | `0` | -1000000000 – 1000000000 |
| `last` | last | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--flow-foreach"></a>
### For each (`flow.foreach`)

Runs "body" once per item of a list (in order), then "completed". Bounded like For (10000 iterations per step).

Inputs:

- `in` "" (exec): takes several wires
- `list` (list)

Outputs:

- `body` (exec): one wire
- `item` (number): type from field `of`
- `index` (number)
- `completed` (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--flow-while"></a>
### While (`flow.while`)

Runs "body" while the condition (read again before each round) is true, then "completed". Bounded like For (10000 iterations per step).

Inputs:

- `in` "" (exec): takes several wires
- `condition` (boolean)

Outputs:

- `body` (exec): one wire
- `completed` (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `condition` | condition | boolean | `false` |  |

<a id="node-behavior--flow-gate"></a>
### Gate (`flow.gate`)

Passes the flow from "enter" to "exit" only while open; "open", "close" and "toggle" change it (per object; a new run starts it again).

Inputs:

- `in` "enter" (exec): takes several wires
- `open` (exec): takes several wires
- `close` (exec): takes several wires
- `toggle` (exec): takes several wires

Outputs:

- `then` "exit" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `open` | Starts open | boolean | `true` |  |

<a id="node-behavior--flow-doonce"></a>
### Do once (`flow.doonce`)

Passes the flow the first time only (per object and run) until "reset".

Inputs:

- `in` "" (exec): takes several wires
- `reset` (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

<a id="node-behavior--flow-delay"></a>
### Delay (`flow.delay`)

Continues after the given time, counted in fixed steps (a timer of this script). While waiting, a new arrival is ignored. Values of the nodes before it are kept for the rest of the flow.

Inputs:

- `in` "" (exec): takes several wires
- `seconds` (number)

Outputs:

- `then` "completed" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `seconds` | seconds | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--flow-switch"></a>
### Switch (`flow.switch`)

Continues on the first case equal to the value (text, or a whole number), else on "default". The cases are a comma-separated list — one output per case (at most 32); empty cases never match.

Inputs:

- `in` "" (exec): takes several wires
- `value` (string): type from field `on`

Outputs:

- `case` (exec): one wire, repeated by field `cases` (up to 32)
- `default` (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `on` | Compare | enum | `"text"` | `text`, `int` |
| `cases` | Cases (comma separated) | string | `"1, 2, 3"` | ≤ 1024 chars |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--flow-select"></a>
### Select (`flow.select`)

a when the condition is true, else b.

Inputs:

- `condition` (boolean)
- `a` (number): type from field `type`
- `b` (number): type from field `type`

Outputs:

- `value` (number): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `condition` | condition | boolean | `false` |  |
| `type` | Type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="graph-behavior--variables"></a>
## Variables

- Number variable (`var.number`): Declares a number variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.
- Boolean variable (`var.boolean`): Declares a boolean variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.
- Text variable (`var.string`): Declares a text variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.
- Vector variable (`var.vector`): Declares a vector variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.
- Entity variable (`var.entity`): Declares a entity variable (an entity id; as a property, picked in the Inspector). Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.
- Choice variable (`var.enum`): Declares a choice variable (one of the listed choices). Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.
- List variable (`var.list`): Declares a list variable. Private: one per object, kept between steps (never a property); local: one per event run.
- Map variable (`var.map`): Declares a map variable. Private: one per object, kept between steps (never a property); local: one per event run.
- Get variable (`var.get`): Reads a variable (its output takes the variable's type).
- Set variable (`var.set`): Writes a variable. Unwired, it writes "Value": a number, true/false, text, or "x, y, z" for the variable's type (empty = its type's zero; lists and maps become empty).

<a id="node-behavior--var-number"></a>
### Number variable (`var.number`)

Declares a number variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `default` | Default | number | `0` | -1000000000 – 1000000000 |
| `visibility` | Visibility | enum | `"public"` | `public`, `private`, `local` |
| `label` | Label | string | `""` | ≤ 64 chars |
| `group` | Group | string | `""` | ≤ 64 chars |
| `tooltip` | Tooltip | string | `""` | ≤ 256 chars |

<a id="node-behavior--var-boolean"></a>
### Boolean variable (`var.boolean`)

Declares a boolean variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `default` | Default | boolean | `false` |  |
| `visibility` | Visibility | enum | `"public"` | `public`, `private`, `local` |
| `label` | Label | string | `""` | ≤ 64 chars |
| `group` | Group | string | `""` | ≤ 64 chars |
| `tooltip` | Tooltip | string | `""` | ≤ 256 chars |

<a id="node-behavior--var-string"></a>
### Text variable (`var.string`)

Declares a text variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `default` | Default | string | `""` | ≤ 256 chars |
| `visibility` | Visibility | enum | `"public"` | `public`, `private`, `local` |
| `label` | Label | string | `""` | ≤ 64 chars |
| `group` | Group | string | `""` | ≤ 64 chars |
| `tooltip` | Tooltip | string | `""` | ≤ 256 chars |

<a id="node-behavior--var-vector"></a>
### Vector variable (`var.vector`)

Declares a vector variable. Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `default` | Default | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `visibility` | Visibility | enum | `"public"` | `public`, `private`, `local` |
| `label` | Label | string | `""` | ≤ 64 chars |
| `group` | Group | string | `""` | ≤ 64 chars |
| `tooltip` | Tooltip | string | `""` | ≤ 256 chars |

<a id="node-behavior--var-entity"></a>
### Entity variable (`var.entity`)

Declares a entity variable (an entity id; as a property, picked in the Inspector). Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `default` | Default | string | `""` | ≤ 256 chars |
| `visibility` | Visibility | enum | `"public"` | `public`, `private`, `local` |
| `label` | Label | string | `""` | ≤ 64 chars |
| `group` | Group | string | `""` | ≤ 64 chars |
| `tooltip` | Tooltip | string | `""` | ≤ 256 chars |

<a id="node-behavior--var-enum"></a>
### Choice variable (`var.enum`)

Declares a choice variable (one of the listed choices). Public: a property shown and set per object in the Inspector; private: one per object, starting at the default; local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `options` | Choices (comma separated) | string | `""` | ≤ 1024 chars |
| `default` | Default | string | `""` | ≤ 256 chars |
| `visibility` | Visibility | enum | `"public"` | `public`, `private`, `local` |
| `label` | Label | string | `""` | ≤ 64 chars |
| `group` | Group | string | `""` | ≤ 64 chars |
| `tooltip` | Tooltip | string | `""` | ≤ 256 chars |

<a id="node-behavior--var-list"></a>
### List variable (`var.list`)

Declares a list variable. Private: one per object, kept between steps (never a property); local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `visibility` | Visibility | enum | `"private"` | `private`, `local` |

<a id="node-behavior--var-map"></a>
### Map variable (`var.map`)

Declares a map variable. Private: one per object, kept between steps (never a property); local: one per event run.

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 64 chars |
| `visibility` | Visibility | enum | `"private"` | `private`, `local` |

<a id="node-behavior--var-get"></a>
### Get variable (`var.get`)

Reads a variable (its output takes the variable's type).

Outputs:

- `value` (any): type from field `variable`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `variable` | Variable | string | `""` | ≤ 64 chars |

<a id="node-behavior--var-set"></a>
### Set variable (`var.set`)

Writes a variable. Unwired, it writes "Value": a number, true/false, text, or "x, y, z" for the variable's type (empty = its type's zero; lists and maps become empty).

Inputs:

- `in` "" (exec): takes several wires
- `value` (any): type from field `variable`

Outputs:

- `then` "" (exec): one wire
- `value` (any): type from field `variable`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `variable` | Variable | string | `""` | ≤ 64 chars |
| `value` | Value | string | `""` | ≤ 256 chars |

<a id="graph-behavior--functions"></a>
## Functions

- Call function (`fn.call`): Runs one of this script's functions: its inputs are the function's Input nodes, its outputs the function's Output nodes (read when the function's flow has finished).
- Call shared function (`fn.library`): Runs a shared function (a function graph of the project's library, usable from every script).

<a id="node-behavior--fn-call"></a>
### Call function (`fn.call`)

Runs one of this script's functions: its inputs are the function's Input nodes, its outputs the function's Output nodes (read when the function's flow has finished).

(its ports are the interface of the `behavior-function` graph named by `function`)

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `function` | Function | string | `""` | ≤ 64 chars |

<a id="node-behavior--fn-library"></a>
### Call shared function (`fn.library`)

Runs a shared function (a function graph of the project's library, usable from every script).

(its ports are the interface of the `behavior-library` graph named by `function`)

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `function` | Shared function | string | `""` | ≤ 64 chars |

<a id="graph-behavior--constants"></a>
## Constants

- Number (`const.number`): A fixed number.
- Boolean (`const.boolean`): A fixed boolean.
- Text (`const.text`): A fixed text.
- Vector (`const.vector`): A fixed vector.

<a id="node-behavior--const-number"></a>
### Number (`const.number`)

A fixed number.

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--const-boolean"></a>
### Boolean (`const.boolean`)

A fixed boolean.

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | boolean | `false` |  |

<a id="node-behavior--const-text"></a>
### Text (`const.text`)

A fixed text.

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | string | `""` | ≤ 256 chars |

<a id="node-behavior--const-vector"></a>
### Vector (`const.vector`)

A fixed vector.

Outputs:

- `value` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="graph-behavior--maths"></a>
## Maths

- Add (`math.add`): a + b
- Subtract (`math.subtract`): a − b
- Multiply (`math.multiply`): a × b
- Divide (`math.divide`): a ÷ b (0 when b is 0, so values stay finite)
- Modulo (`math.modulo`): The remainder of a ÷ b, with the sign of b (0 when b is 0).
- Power (`math.power`): a to the power b (0 when the result is not a finite number).
- Min (`math.min`): The smaller of a and b.
- Max (`math.max`): The larger of a and b.
- Absolute (`math.abs`): |value|
- Negate (`math.negate`): −value
- Floor (`math.floor`): The whole number at or below value.
- Ceiling (`math.ceil`): The whole number at or above value.
- Round (`math.round`): The nearest whole number (halves away from zero).
- Sign (`math.sign`): −1, 0 or 1.
- Square root (`math.sqrt`): √value (0 below 0).
- Clamp (`math.clamp`): value kept between min and max.
- Lerp (`math.lerp`): a + (b − a) × t.
- Sine (`math.sin`): sin of an angle in degrees.
- Cosine (`math.cos`): cos of an angle in degrees.
- Angle of (`math.atan2`): The angle (degrees) of the direction (x, y), from +x towards +y.
- Compare (`math.compare`): Compares two numbers.

<a id="node-behavior--math-add"></a>
### Add (`math.add`)

a + b

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-subtract"></a>
### Subtract (`math.subtract`)

a − b

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-multiply"></a>
### Multiply (`math.multiply`)

a × b

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-divide"></a>
### Divide (`math.divide`)

a ÷ b (0 when b is 0, so values stay finite)

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-modulo"></a>
### Modulo (`math.modulo`)

The remainder of a ÷ b, with the sign of b (0 when b is 0).

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-power"></a>
### Power (`math.power`)

a to the power b (0 when the result is not a finite number).

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-min"></a>
### Min (`math.min`)

The smaller of a and b.

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-max"></a>
### Max (`math.max`)

The larger of a and b.

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-abs"></a>
### Absolute (`math.abs`)

|value|

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-negate"></a>
### Negate (`math.negate`)

−value

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-floor"></a>
### Floor (`math.floor`)

The whole number at or below value.

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-ceil"></a>
### Ceiling (`math.ceil`)

The whole number at or above value.

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-round"></a>
### Round (`math.round`)

The nearest whole number (halves away from zero).

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-sign"></a>
### Sign (`math.sign`)

−1, 0 or 1.

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-sqrt"></a>
### Square root (`math.sqrt`)

√value (0 below 0).

Inputs:

- `value` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-clamp"></a>
### Clamp (`math.clamp`)

value kept between min and max.

Inputs:

- `value` (number)
- `min` (number)
- `max` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |
| `min` | min | number | `0` | -1000000000 – 1000000000 |
| `max` | max | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--math-lerp"></a>
### Lerp (`math.lerp`)

a + (b − a) × t.

Inputs:

- `a` (number)
- `b` (number)
- `t` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |
| `t` | t | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-sin"></a>
### Sine (`math.sin`)

sin of an angle in degrees.

Inputs:

- `degrees` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `degrees` | degrees | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-cos"></a>
### Cosine (`math.cos`)

cos of an angle in degrees.

Inputs:

- `degrees` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `degrees` | degrees | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-atan2"></a>
### Angle of (`math.atan2`)

The angle (degrees) of the direction (x, y), from +x towards +y.

Inputs:

- `y` (number)
- `x` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `x` | x | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--math-compare"></a>
### Compare (`math.compare`)

Compares two numbers.

Inputs:

- `a` (number)
- `b` (number)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | number | `0` | -1000000000 – 1000000000 |
| `b` | b | number | `0` | -1000000000 – 1000000000 |
| `op` | Test | enum | `"=="` | `==`, `!=`, `<`, `<=`, `>`, `>=` |

<a id="graph-behavior--logic"></a>
## Logic

- And (`logic.and`): true when a and b are true
- Or (`logic.or`): true when a or b is true
- Xor (`logic.xor`): true when exactly one of a and b is true
- Not (`logic.not`): true when the value is false

<a id="node-behavior--logic-and"></a>
### And (`logic.and`)

true when a and b are true

Inputs:

- `a` (boolean)
- `b` (boolean)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | boolean | `false` |  |
| `b` | b | boolean | `false` |  |

<a id="node-behavior--logic-or"></a>
### Or (`logic.or`)

true when a or b is true

Inputs:

- `a` (boolean)
- `b` (boolean)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | boolean | `false` |  |
| `b` | b | boolean | `false` |  |

<a id="node-behavior--logic-xor"></a>
### Xor (`logic.xor`)

true when exactly one of a and b is true

Inputs:

- `a` (boolean)
- `b` (boolean)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | boolean | `false` |  |
| `b` | b | boolean | `false` |  |

<a id="node-behavior--logic-not"></a>
### Not (`logic.not`)

true when the value is false

Inputs:

- `value` (boolean)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | boolean | `false` |  |

<a id="graph-behavior--text"></a>
## Text

- Join text (`text.join`): a followed by b.
- Text equals (`text.equal`): true when a and b are the same text.
- Text contains (`text.contains`): true when the text contains the part.
- Text length (`text.length`): The number of characters.
- Text to number (`text.number`): The number a text spells (0 when it is not a number).

<a id="node-behavior--text-join"></a>
### Join text (`text.join`)

a followed by b.

Inputs:

- `a` (string)
- `b` (string)

Outputs:

- `result` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | string | `""` | ≤ 256 chars |
| `b` | b | string | `""` | ≤ 256 chars |

<a id="node-behavior--text-equal"></a>
### Text equals (`text.equal`)

true when a and b are the same text.

Inputs:

- `a` (string)
- `b` (string)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | string | `""` | ≤ 256 chars |
| `b` | b | string | `""` | ≤ 256 chars |

<a id="node-behavior--text-contains"></a>
### Text contains (`text.contains`)

true when the text contains the part.

Inputs:

- `text` (string)
- `part` (string)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `text` | text | string | `""` | ≤ 256 chars |
| `part` | part | string | `""` | ≤ 256 chars |

<a id="node-behavior--text-length"></a>
### Text length (`text.length`)

The number of characters.

Inputs:

- `text` (string)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `text` | text | string | `""` | ≤ 256 chars |

<a id="node-behavior--text-number"></a>
### Text to number (`text.number`)

The number a text spells (0 when it is not a number).

Inputs:

- `text` (string)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `text` | text | string | `""` | ≤ 256 chars |

<a id="graph-behavior--vectors"></a>
## Vectors

- Make vector (`vec.make`): (x, y, z).
- Break vector (`vec.break`): The x, y and z of a vector.
- Add vectors (`vec.add`): a + b
- Subtract vectors (`vec.subtract`): a − b
- Scale vector (`vec.scale`): vector × factor
- Vector length (`vec.length`): The length of a vector.
- Distance (`vec.distance`): The distance between two points.
- Normalize (`vec.normalize`): The vector with length 1 (0, 0, 0 stays 0, 0, 0).
- Dot product (`vec.dot`): a · b
- Cross product (`vec.cross`): a × b
- Lerp vectors (`vec.lerp`): a + (b − a) × t

<a id="node-behavior--vec-make"></a>
### Make vector (`vec.make`)

(x, y, z).

Inputs:

- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `vector` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--vec-break"></a>
### Break vector (`vec.break`)

The x, y and z of a vector.

Inputs:

- `vector` (vector)

Outputs:

- `x` (number)
- `y` (number)
- `z` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `vector` | vector | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-add"></a>
### Add vectors (`vec.add`)

a + b

Inputs:

- `a` (vector)
- `b` (vector)

Outputs:

- `result` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `b` | b | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-subtract"></a>
### Subtract vectors (`vec.subtract`)

a − b

Inputs:

- `a` (vector)
- `b` (vector)

Outputs:

- `result` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `b` | b | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-scale"></a>
### Scale vector (`vec.scale`)

vector × factor

Inputs:

- `vector` (vector)
- `factor` (number)

Outputs:

- `result` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `vector` | vector | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `factor` | factor | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--vec-length"></a>
### Vector length (`vec.length`)

The length of a vector.

Inputs:

- `vector` (vector)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `vector` | vector | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-distance"></a>
### Distance (`vec.distance`)

The distance between two points.

Inputs:

- `a` (vector)
- `b` (vector)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `b` | b | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-normalize"></a>
### Normalize (`vec.normalize`)

The vector with length 1 (0, 0, 0 stays 0, 0, 0).

Inputs:

- `vector` (vector)

Outputs:

- `result` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `vector` | vector | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-dot"></a>
### Dot product (`vec.dot`)

a · b

Inputs:

- `a` (vector)
- `b` (vector)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `b` | b | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-cross"></a>
### Cross product (`vec.cross`)

a × b

Inputs:

- `a` (vector)
- `b` (vector)

Outputs:

- `result` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `b` | b | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--vec-lerp"></a>
### Lerp vectors (`vec.lerp`)

a + (b − a) × t

Inputs:

- `a` (vector)
- `b` (vector)
- `t` (number)

Outputs:

- `result` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `b` | b | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `t` | t | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--lists"></a>
## Lists

- Make list (`list.make`): A list of the first "count" items (unwired items are their type's zero). Lists keep at most 1024 items. List nodes never change a list: they give a new one (store it with Set variable).
- List length (`list.length`): The number of items.
- Get item (`list.get`): The item at an index (0 is the first; found is false outside the list).
- Set item (`list.set`): The list with the item at an index replaced (unchanged outside the list).
- Add item (`list.add`): The list with an item added at the end (at most 1024 items: more is a script error).
- Remove item (`list.remove`): The list without the item at an index.
- List contains (`list.contains`): true when an item equals the value.
- Index of (`list.indexOf`): The index of the first item equal to the value (−1 when none).

<a id="node-behavior--list-make"></a>
### Make list (`list.make`)

A list of the first "count" items (unwired items are their type's zero). Lists keep at most 1024 items. List nodes never change a list: they give a new one (store it with Set variable).

Inputs:

- `item1` "item 1" (number): type from field `of`
- `item2` "item 2" (number): type from field `of`
- `item3` "item 3" (number): type from field `of`
- `item4` "item 4" (number): type from field `of`

Outputs:

- `list` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
| `count` | Count | number | `0` | 0 – 4 |

<a id="node-behavior--list-length"></a>
### List length (`list.length`)

The number of items.

Inputs:

- `list` (list)

Outputs:

- `result` (number)

<a id="node-behavior--list-get"></a>
### Get item (`list.get`)

The item at an index (0 is the first; found is false outside the list).

Inputs:

- `list` (list)
- `index` (number)

Outputs:

- `item` (number): type from field `of`
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `index` | index | number | `0` | -1000000000 – 1000000000 |
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--list-set"></a>
### Set item (`list.set`)

The list with the item at an index replaced (unchanged outside the list).

Inputs:

- `list` (list)
- `index` (number)
- `item` (number): type from field `of`

Outputs:

- `list` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `index` | index | number | `0` | -1000000000 – 1000000000 |
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--list-add"></a>
### Add item (`list.add`)

The list with an item added at the end (at most 1024 items: more is a script error).

Inputs:

- `list` (list)
- `item` (number): type from field `of`

Outputs:

- `list` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--list-remove"></a>
### Remove item (`list.remove`)

The list without the item at an index.

Inputs:

- `list` (list)
- `index` (number)

Outputs:

- `list` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `index` | index | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--list-contains"></a>
### List contains (`list.contains`)

true when an item equals the value.

Inputs:

- `list` (list)
- `item` (number): type from field `of`

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
