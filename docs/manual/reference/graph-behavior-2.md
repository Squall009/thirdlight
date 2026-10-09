# Graph: Visual script (part 2, from Index of (`list.indexOf`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="node-behavior--list-index-of"></a>
### Index of (`list.indexOf`)

The index of the first item equal to the value (−1 when none).

Inputs:

- `list` (list)
- `item` (number): type from field `of`

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="graph-behavior--maps"></a>
## Maps

- Empty map (`map.make`): A map with no entries (text keys to values; at most 256 entries). Map nodes never change a map: they give a new one.
- Set entry (`map.set`): The map with the key set to the value (at most 256 entries: more is a script error).
- Get entry (`map.get`): The key's value (found is false when the map has no such key).
- Has key (`map.has`): true when the map has the key.
- Remove entry (`map.remove`): The map without the key.
- Map size (`map.size`): The number of entries.
- Map keys (`map.keys`): The keys (in the order they were first set) as a list of texts.

<a id="node-behavior--map-make"></a>
### Empty map (`map.make`)

A map with no entries (text keys to values; at most 256 entries). Map nodes never change a map: they give a new one.

Outputs:

- `map` (map)

<a id="node-behavior--map-set"></a>
### Set entry (`map.set`)

The map with the key set to the value (at most 256 entries: more is a script error).

Inputs:

- `map` (map)
- `key` (string)
- `value` (number): type from field `of`

Outputs:

- `map` (map)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--map-get"></a>
### Get entry (`map.get`)

The key's value (found is false when the map has no such key).

Inputs:

- `map` (map)
- `key` (string)

Outputs:

- `value` (number): type from field `of`
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `of` | Items | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--map-has"></a>
### Has key (`map.has`)

true when the map has the key.

Inputs:

- `map` (map)
- `key` (string)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |

<a id="node-behavior--map-remove"></a>
### Remove entry (`map.remove`)

The map without the key.

Inputs:

- `map` (map)
- `key` (string)

Outputs:

- `map` (map)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |

<a id="node-behavior--map-size"></a>
### Map size (`map.size`)

The number of entries.

Inputs:

- `map` (map)

Outputs:

- `result` (number)

<a id="node-behavior--map-keys"></a>
### Map keys (`map.keys`)

The keys (in the order they were first set) as a list of texts.

Inputs:

- `map` (map)

Outputs:

- `list` "keys" (list)

<a id="graph-behavior--random"></a>
## Random

- Random number (`random.number`): A number from min up to (not including) max. Deterministic: each object draws from its own sequence, which starts again with every run (a replay repeats it). Every read draws the next number.
- Random integer (`random.integer`): A whole number from min to max (both included), from the object's deterministic sequence.
- Random chance (`random.chance`): true with the given probability (0–1), from the object's deterministic sequence.
- Seeded random (stream) (`api.random.stream.next`): A number in [0, 1) (a multiple of 2^-32).
- Seeded random range (stream) (`api.random.stream.range`): A number in [min, max).
- Seeded random integer (stream) (`api.random.stream.int`): A whole number from `min` to `max`, both included (the bounds are rounded inward).
- Seeded chance (stream) (`api.random.stream.chance`): True with probability `p` (0: never, 1: always).
- Seeded random (`api.random.next`): A number in [0, 1) (a multiple of 2^-32).
- Seeded random range (`api.random.range`): A number in [min, max).
- Seeded random integer (`api.random.int`): A whole number from `min` to `max`, both included (the bounds are rounded inward).
- Seeded chance (`api.random.chance`): True with probability `p` (0: never, 1: always).

<a id="node-behavior--random-number"></a>
### Random number (`random.number`)

A number from min up to (not including) max. Deterministic: each object draws from its own sequence, which starts again with every run (a replay repeats it). Every read draws the next number.

Inputs:

- `min` (number)
- `max` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | min | number | `0` | -1000000000 – 1000000000 |
| `max` | max | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--random-integer"></a>
### Random integer (`random.integer`)

A whole number from min to max (both included), from the object's deterministic sequence.

Inputs:

- `min` (number)
- `max` (number)

Outputs:

- `result` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | min | number | `1` | -1000000000 – 1000000000 |
| `max` | max | number | `6` | -1000000000 – 1000000000 |

<a id="node-behavior--random-chance"></a>
### Random chance (`random.chance`)

true with the given probability (0–1), from the object's deterministic sequence.

Inputs:

- `probability` (number)

Outputs:

- `result` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `probability` | probability | number | `0.5` | -1000000000 – 1000000000 |

<a id="node-behavior--api-random-stream-next"></a>
### Seeded random (stream) (`api.random.stream.next`)

A number in [0, 1) (a multiple of 2^-32).

Inputs:

- `in` "" (exec): takes several wires
- `name` "stream" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | stream | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-random-stream-range"></a>
### Seeded random range (stream) (`api.random.stream.range`)

A number in [min, max).

Inputs:

- `in` "" (exec): takes several wires
- `name` "stream" (string)
- `min` (number)
- `max` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | stream | string | `""` | ≤ 256 chars |
| `min` | min | number | `0` | -1000000000 – 1000000000 |
| `max` | max | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-random-stream-int"></a>
### Seeded random integer (stream) (`api.random.stream.int`)

A whole number from `min` to `max`, both included (the bounds are rounded inward).

Inputs:

- `in` "" (exec): takes several wires
- `name` "stream" (string)
- `min` (number)
- `max` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | stream | string | `""` | ≤ 256 chars |
| `min` | min | number | `0` | -1000000000 – 1000000000 |
| `max` | max | number | `6` | -1000000000 – 1000000000 |

<a id="node-behavior--api-random-stream-chance"></a>
### Seeded chance (stream) (`api.random.stream.chance`)

True with probability `p` (0: never, 1: always).

Inputs:

- `in` "" (exec): takes several wires
- `name` "stream" (string)
- `p` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | stream | string | `""` | ≤ 256 chars |
| `p` | p | number | `0.5` | -1000000000 – 1000000000 |

<a id="node-behavior--api-random-next"></a>
### Seeded random (`api.random.next`)

A number in [0, 1) (a multiple of 2^-32).

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (number)

<a id="node-behavior--api-random-range"></a>
### Seeded random range (`api.random.range`)

A number in [min, max).

Inputs:

- `in` "" (exec): takes several wires
- `min` (number)
- `max` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | min | number | `0` | -1000000000 – 1000000000 |
| `max` | max | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-random-int"></a>
### Seeded random integer (`api.random.int`)

A whole number from `min` to `max`, both included (the bounds are rounded inward).

Inputs:

- `in` "" (exec): takes several wires
- `min` (number)
- `max` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | min | number | `0` | -1000000000 – 1000000000 |
| `max` | max | number | `6` | -1000000000 – 1000000000 |

<a id="node-behavior--api-random-chance"></a>
### Seeded chance (`api.random.chance`)

True with probability `p` (0: never, 1: always).

Inputs:

- `in` "" (exec): takes several wires
- `p` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `p` | p | number | `0.5` | -1000000000 – 1000000000 |

<a id="graph-behavior--debug"></a>
## Debug

- Log (`debug.log`): Writes a line to the play log.

<a id="node-behavior--debug-log"></a>
### Log (`debug.log`)

Writes a line to the play log.

Inputs:

- `in` "" (exec): takes several wires
- `message` (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `message` | message | string | `""` | ≤ 256 chars |
| `level` | Level | enum | `"info"` | `info`, `warn`, `error` |

<a id="graph-behavior--script"></a>
## Script

- Script id (`api.behaviorId`): The behavior's id.
- This object (`api.entityId`): The entity carrying this script instance.
- Step index (`api.stepIndex`): The fixed step counter of the run.
- Phase (`api.phase`): The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms).
- Properties (`api.properties`): The instance's property values (declaration defaults with the object's overrides).
- Spawn prefab (`api.spawn`): Copy a project prefab into the running game; returns the new root id (or null at an engine limit).
- Destroy spawned (`api.destroy`): Remove a spawned entity at the next step boundary. An empty entity means this object.

<a id="node-behavior--api-behavior-id"></a>
### Script id (`api.behaviorId`)

The behavior's id.

Outputs:

- `value` (string)

<a id="node-behavior--api-entity-id"></a>
### This object (`api.entityId`)

The entity carrying this script instance.

Outputs:

- `value` (string)

<a id="node-behavior--api-step-index"></a>
### Step index (`api.stepIndex`)

The fixed step counter of the run.

Outputs:

- `value` (number)

<a id="node-behavior--api-phase"></a>
### Phase (`api.phase`)

The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms).

Outputs:

- `value` (string)

<a id="node-behavior--api-properties"></a>
### Properties (`api.properties`)

The instance's property values (declaration defaults with the object's overrides).

Outputs:

- `value` (map)

<a id="node-behavior--api-spawn"></a>
### Spawn prefab (`api.spawn`)

Copy a project prefab into the running game; returns the new root id (or null at an engine limit).

Inputs:

- `in` "" (exec): takes several wires
- `prefabId` "prefab" (string)
- `position` (vector)
- `rotation` (list)
- `scale` (vector)
- `properties` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `prefabId` | prefab | string | `""` | ≤ 256 chars |
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-destroy"></a>
### Destroy spawned (`api.destroy`)

Remove a spawned entity at the next step boundary. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="graph-behavior--action"></a>
## Action

- Action step index (`api.action.stepIndex`): Integer, `0 ≤ v ≤ 2^53−1` — the executed fixed-step index.
- Action actions (`api.action.actions`): Optional: every named input action this step — `v` its value (a button 0/1, an axis −1..1 after its processors), `x`/`y` for a 2D axis, `p` the button phase. Absent: no action has a value (all neutral).
- Action pointer (`api.action.pointer`): Optional: the pointer (mouse, pen, touch) this step. Absent: no new sample — the runtime keeps the last position, buttons and over/locked state (no movement, no edges).

<a id="node-behavior--api-action-step-index"></a>
### Action step index (`api.action.stepIndex`)

Integer, `0 ≤ v ≤ 2^53−1` — the executed fixed-step index.

Outputs:

- `value` (number)

<a id="node-behavior--api-action-actions"></a>
### Action actions (`api.action.actions`)

Optional: every named input action this step — `v` its value (a button 0/1, an axis −1..1 after its processors), `x`/`y` for a 2D axis, `p` the button phase. Absent: no action has a value (all neutral).

Outputs:

- `value` (map)
- `found` (boolean)

<a id="node-behavior--api-action-pointer"></a>
### Action pointer (`api.action.pointer`)

Optional: the pointer (mouse, pen, touch) this step. Absent: no new sample — the runtime keeps the last position, buttons and over/locked state (no movement, no edges).

Outputs:

- `x` (number)
- `y` (number)
- `dx` (number)
- `dy` (number)
- `wheel` (number)
- `buttons` (number)
- `pressed` (number)
- `released` (number)
- `over` (boolean)
- `locked` (boolean)
- `overUi` "over ui" (boolean)
- `found` (boolean)

<a id="graph-behavior--intents"></a>
## Intents

- Intents step index (`api.intents.stepIndex`): 
- Intents move (`api.intents.move`): The committed `control_move` (quantized) or `null`.
- Intents jump (`api.intents.jump`): The committed `control_jump` or `null`.
- Intents move writer (`api.intents.moveWriter`): The module ID that committed `move`, or `null`.
- Intents jump writer (`api.intents.jumpWriter`): 
- Intents transform writes (`api.intents.transformWrites`): Committed transform writes, in commit order.
- Intents move y (`api.intents.moveY`): The committed `control_move`'s second axis (0 when it had none), or null.
- Intents character move (`api.intents.characterMove`): The committed `character_move` (a world direction on the ground), or null.
- Intents character place (`api.intents.characterPlace`): The committed `character_place` point, or null.
- Intents character enabled (`api.intents.characterEnabled`): The committed `character_enable` value, or null.
- Intents impulse (`api.intents.impulse`): The velocity (m/s) scripts' `ctx.character.impulse` calls add at this controller phase (summed; absent: none).
- Intents character yaw (`api.intents.characterYaw`): The yaw (radians about +Y, 0 facing +Z) a placement this step faces (a spawn's yaw; absent: as it was).
- Intents controllers (`api.intents.controllers`): The further player controllers' channels this step, by their object's id (present only when an intent, an impulse or a placement named one; the fields above are the first controller's). Read them with `controllerIntents`.
- Control move (`api.emit.control_move`): `−1 ≤ value ≤ 1`, quantized at commit. Runs only in the intent phase.
- Control jump (`api.emit.control_jump`): One `JumpPhase` value. Runs only in the intent phase.
- Move object (`api.emit.transform`): A position write on ONE owned entity axis set. It may also set the rotation, as a `quaternion` or a `facing` direction (fields in the order kind, entityId, position, quaternion, facing, up). Runs only in the transform phase. An empty entity means this object.
- Pose object (`api.emit.pose`): An owned entity's rotation (degrees: yaw about +Y, pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual (colliders keep their shape). Fields in the order kind, entityId, rotation, scale; at least one of rotation and scale. The rotation may instead be a `quaternion` or a `facing` direction (order kind,  Runs only in the transform phase. An empty entity means this object.
- Respawn player (`api.emit.respawn`): Kill the player (intent phase; ignored unless the run is playing). Runs only in the intent phase.
- Walk character (`api.emit.character_move`): 3D projects: walk the player character this step along a world direction on the ground (x, z; a length above 1 counts as 1 — its length scales the walk speed), replacing the move input; `run` uses the run speed. Intent phase. Runs only in the intent phase.
- Place character (`api.emit.character_place`): Teleport the player character (its origin) to a point, stopping its motion; it falls from there. Intent phase; it takes effect before the controller runs in the same step. On the 2D plane too (z is ignored there), with the placement of scene arrivals and respawns (from rest: velocity and jump reset). Runs only in the intent phase.
- Enable character (`api.emit.character_enable`): 3D projects: switch the character controller off (the character stays where it is: no input, no gravity — a cutscene or a dialogue) or back on. Lasts until changed. Intent phase. Runs only in the intent phase.

<a id="node-behavior--api-intents-step-index"></a>
### Intents step index (`api.intents.stepIndex`)



Outputs:

- `value` (number)

<a id="node-behavior--api-intents-move"></a>
### Intents move (`api.intents.move`)

The committed `control_move` (quantized) or `null`.

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-intents-jump"></a>
### Intents jump (`api.intents.jump`)

The committed `control_jump` or `null`.

Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-intents-move-writer"></a>
### Intents move writer (`api.intents.moveWriter`)

The module ID that committed `move`, or `null`.

Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-intents-jump-writer"></a>
### Intents jump writer (`api.intents.jumpWriter`)



Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-intents-transform-writes"></a>
### Intents transform writes (`api.intents.transformWrites`)

Committed transform writes, in commit order.

Outputs:

- `value` (list)

<a id="node-behavior--api-intents-move-y"></a>
### Intents move y (`api.intents.moveY`)

The committed `control_move`'s second axis (0 when it had none), or null.

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-intents-character-move"></a>
### Intents character move (`api.intents.characterMove`)

The committed `character_move` (a world direction on the ground), or null.

Outputs:

- `x` (number)
- `z` (number)
- `run` (boolean)
- `found` (boolean)

<a id="node-behavior--api-intents-character-place"></a>
### Intents character place (`api.intents.characterPlace`)

The committed `character_place` point, or null.

Outputs:

- `x` (number)
- `y` (number)
- `z` (number)
- `found` (boolean)

<a id="node-behavior--api-intents-character-enabled"></a>
### Intents character enabled (`api.intents.characterEnabled`)

The committed `character_enable` value, or null.

Outputs:

- `value` (boolean)
- `found` (boolean)

<a id="node-behavior--api-intents-impulse"></a>
### Intents impulse (`api.intents.impulse`)

The velocity (m/s) scripts' `ctx.character.impulse` calls add at this controller phase (summed; absent: none).

Outputs:

- `x` (number)
- `y` (number)
- `z` (number)
- `found` (boolean)

<a id="node-behavior--api-intents-character-yaw"></a>
### Intents character yaw (`api.intents.characterYaw`)

The yaw (radians about +Y, 0 facing +Z) a placement this step faces (a spawn's yaw; absent: as it was).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-intents-controllers"></a>
### Intents controllers (`api.intents.controllers`)

The further player controllers' channels this step, by their object's id (present only when an intent, an impulse or a placement named one; the fields above are the first controller's). Read them with `controllerIntents`.

Outputs:

- `value` (map)
- `found` (boolean)

<a id="node-behavior--api-emit-control-move"></a>
### Control move (`api.emit.control_move`)

`−1 ≤ value ≤ 1`, quantized at commit. Runs only in the intent phase.

Inputs:

- `in` "" (exec): takes several wires
- `value` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-emit-control-jump"></a>
### Control jump (`api.emit.control_jump`)

One `JumpPhase` value. Runs only in the intent phase.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | value | enum | `"none"` | `none`, `pressed`, `held`, `released` |

<a id="node-behavior--api-emit-transform"></a>
### Move object (`api.emit.transform`)

A position write on ONE owned entity axis set. It may also set the rotation, as a `quaternion` or a `facing` direction (fields in the order kind, entityId, position, quaternion, facing, up). Runs only in the transform phase. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `position` (vector)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `position_axes` | position axes | enum | `"x y z"` | `x y z`, `x y`, `x z`, `y z`, `x`, `y`, `z` |

<a id="node-behavior--api-emit-pose"></a>
### Pose object (`api.emit.pose`)

An owned entity's rotation (degrees: yaw about +Y, pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual (colliders keep their shape). Fields in the order kind, entityId, rotation, scale; at least one of rotation and scale. The rotation may instead be a `quaternion` or a `facing` direction (order kind,  Runs only in the transform phase. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `rotation` (vector)
- `scale` (vector)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `rotation` | rotation | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `rotation_axes` | rotation axes | enum | `"yaw pitch roll"` | `yaw pitch roll`, `yaw pitch`, `yaw roll`, `pitch roll`, `yaw`, `pitch`, `roll`, `none` |

<a id="node-behavior--api-emit-respawn"></a>
### Respawn player (`api.emit.respawn`)

Kill the player (intent phase; ignored unless the run is playing). Runs only in the intent phase.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

<a id="node-behavior--api-emit-character-move"></a>
### Walk character (`api.emit.character_move`)

3D projects: walk the player character this step along a world direction on the ground (x, z; a length above 1 counts as 1 — its length scales the walk speed), replacing the move input; `run` uses the run speed. Intent phase. Runs only in the intent phase.

Inputs:

- `in` "" (exec): takes several wires
- `x` (number)
- `z` (number)
- `run` (boolean)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `run` | run | boolean | `false` |  |

<a id="node-behavior--api-emit-character-place"></a>
### Place character (`api.emit.character_place`)

Teleport the player character (its origin) to a point, stopping its motion; it falls from there. Intent phase; it takes effect before the controller runs in the same step. On the 2D plane too (z is ignored there), with the placement of scene arrivals and respawns (from rest: velocity and jump reset). Runs only in the intent phase.

Inputs:

- `in` "" (exec): takes several wires
- `position` (vector)
- `facing` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-emit-character-enable"></a>
### Enable character (`api.emit.character_enable`)

3D projects: switch the character controller off (the character stays where it is: no input, no gravity — a cutscene or a dialogue) or back on. Lasts until changed. Intent phase. Runs only in the intent phase.

Inputs:

- `in` "" (exec): takes several wires
- `enabled` (boolean)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `enabled` | enabled | boolean | `false` |  |

<a id="graph-behavior--settings"></a>
## Settings

- Settings gravity y (`api.settings.gravity_y`): 
- Settings run speed (`api.settings.run_speed`): 
- Settings jump velocity (`api.settings.jump_velocity`): 
- Settings max fall speed (`api.settings.max_fall_speed`): 
- Settings max slope climb deg (`api.settings.max_slope_climb_deg`): 
- Settings min slope slide deg (`api.settings.min_slope_slide_deg`): 
- Settings fixed step hz (`api.settings.fixed_step_hz`): Engine settings, present only when the project sets them (absent: the engine default).
- Settings audio voices (`api.settings.audio_voices`): 
- Settings music fade s (`api.settings.music_fade_s`): 
- Settings animation crossfade s (`api.settings.animation_crossfade_s`): 
- Settings render backend (`api.settings.render_backend`): The renderer backend (0 WebGL legacy, 1 auto, 2 WebGPU, 3 WebGL 2; absent: 0).
- Settings sim thread (`api.settings.sim_thread`): Where the simulation runs in Play and the export (1 a worker, 2 the page's main thread; absent: 1).
- Settings texture budget mb (`api.settings.texture_budget_mb`): The texture budget of Play and the export in MiB (absent: `TEXTURE_BUDGET_DEFAULT_MB`).
- Settings frame rate cap (`api.settings.frame_rate_cap`): The most frames per second Play and the export draw (30, 60, 120; absent or 0: none, the display's rate).
- Settings ambient occlusion (`api.settings.ambient_occlusion`): The kind of ambient occlusion where a look turns it on (0 off, 1 SSAO, 2 GTAO; absent: SSAO).
- Settings render scale (`api.settings.render_scale`): The share of the screen's resolution Play and the export draw at (0.5–1; absent: 1).
- Settings dynamic resolution (`api.settings.dynamic_resolution`): Whether the render scale drops while the GPU runs over budget (0 off, 1 on; absent: off).
- Settings streaming budget mb (`api.settings.streaming_budget_mb`): The memory streamed terrain tiles and block chunks may take in Play and the export, MiB (absent: `STREAMING_BUDGET_DEFAULT_MB`).
- Settings architecture ship meshes (`api.settings.architecture_ship_meshes`): Exports ship generated architecture's meshes too (0 no, 1 yes; absent: no, generated at load).

<a id="node-behavior--api-settings-gravity-y"></a>
### Settings gravity y (`api.settings.gravity_y`)



Outputs:

- `value` (number)

<a id="node-behavior--api-settings-run-speed"></a>
### Settings run speed (`api.settings.run_speed`)



Outputs:

- `value` (number)

<a id="node-behavior--api-settings-jump-velocity"></a>
### Settings jump velocity (`api.settings.jump_velocity`)



Outputs:

- `value` (number)

<a id="node-behavior--api-settings-max-fall-speed"></a>
### Settings max fall speed (`api.settings.max_fall_speed`)



Outputs:

- `value` (number)

<a id="node-behavior--api-settings-max-slope-climb-deg"></a>
### Settings max slope climb deg (`api.settings.max_slope_climb_deg`)



Outputs:

- `value` (number)

<a id="node-behavior--api-settings-min-slope-slide-deg"></a>
### Settings min slope slide deg (`api.settings.min_slope_slide_deg`)



Outputs:

- `value` (number)

<a id="node-behavior--api-settings-fixed-step-hz"></a>
### Settings fixed step hz (`api.settings.fixed_step_hz`)

Engine settings, present only when the project sets them (absent: the engine default).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-audio-voices"></a>
### Settings audio voices (`api.settings.audio_voices`)



Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-music-fade-s"></a>
### Settings music fade s (`api.settings.music_fade_s`)



Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-animation-crossfade-s"></a>
### Settings animation crossfade s (`api.settings.animation_crossfade_s`)



Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-render-backend"></a>
### Settings render backend (`api.settings.render_backend`)

The renderer backend (0 WebGL legacy, 1 auto, 2 WebGPU, 3 WebGL 2; absent: 0).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-sim-thread"></a>
### Settings sim thread (`api.settings.sim_thread`)

Where the simulation runs in Play and the export (1 a worker, 2 the page's main thread; absent: 1).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-texture-budget-mb"></a>
### Settings texture budget mb (`api.settings.texture_budget_mb`)

The texture budget of Play and the export in MiB (absent: `TEXTURE_BUDGET_DEFAULT_MB`).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-frame-rate-cap"></a>
### Settings frame rate cap (`api.settings.frame_rate_cap`)

The most frames per second Play and the export draw (30, 60, 120; absent or 0: none, the display's rate).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-ambient-occlusion"></a>
### Settings ambient occlusion (`api.settings.ambient_occlusion`)

The kind of ambient occlusion where a look turns it on (0 off, 1 SSAO, 2 GTAO; absent: SSAO).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-render-scale"></a>
### Settings render scale (`api.settings.render_scale`)

The share of the screen's resolution Play and the export draw at (0.5–1; absent: 1).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-dynamic-resolution"></a>
### Settings dynamic resolution (`api.settings.dynamic_resolution`)

Whether the render scale drops while the GPU runs over budget (0 off, 1 on; absent: off).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-streaming-budget-mb"></a>
### Settings streaming budget mb (`api.settings.streaming_budget_mb`)

The memory streamed terrain tiles and block chunks may take in Play and the export, MiB (absent: `STREAMING_BUDGET_DEFAULT_MB`).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-settings-architecture-ship-meshes"></a>
### Settings architecture ship meshes (`api.settings.architecture_ship_meshes`)

Exports ship generated architecture's meshes too (0 no, 1 yes; absent: no, generated at load).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="graph-behavior--physics"></a>
## Physics

- Character result (`api.physics.characterResult`): A player controller's result of the last completed step (`entityId`, absent: the first player controller), or `undefined` before the first step. An empty entity means this object.
- Raycast (`api.physics.raycast`): A ray against the level's colliders (bounded per step; null when nothing is hit).
- Overlap box (`api.physics.overlapBox`): The entities whose colliders overlap a box (center, half extents) — counted with the rays.
- Overlap circle (`api.physics.overlapCircle`): The entities whose colliders overlap a circle — counted with the rays.
- Character state (`api.physics.characterState`): 3D projects: a player character's state after the last completed step (`entityId`, absent: the first player controller) — position, velocity, grounding, contacts, whether its controller is on and whether it is climbing a ledge — or undefined (a 2D plane, before the first step, or not a player controller). An empty entity means this object.
- Raycast 3D (`api.physics.raycast3d`): 3D projects: the nearest collider a ray from `origin` along `direction` hits within `maxDistance` metres (default 100), or null — its object, the point, the surface normal and the distance. Counted with the other queries (at most 64 a step).
- Overlap sphere (`api.physics.overlapSphere`): 3D projects: the objects whose colliders overlap a sphere (sorted ids, at most 64).
- Overlap box 3D (`api.physics.overlapBox3d`): 3D projects: the objects whose colliders overlap a box — centre, half extents [x, y, z] and an optional rotation quaternion [x, y, z, w].
- Overlap capsule (`api.physics.overlapCapsule`): 3D projects: the objects whose colliders overlap an upright capsule (total height, end caps included), optionally turned by a quaternion [x, y, z, w].
- Pick at screen point (`api.physics.pickAt`): 3D projects: what is under a screen point (x, y 0–1 from the top left): the ray from the active camera (`ctx.camera.screenToRay`) cast into the colliders, within `maxDistance` (default 1000 m).
- Pick at pointer (`api.physics.pickAtPointer`): 3D projects: what is under the pointer this step (null while the pointer is outside the view or never moved); with a locked cursor, what is at the view's centre.

<a id="node-behavior--api-physics-character-result"></a>
### Character result (`api.physics.characterResult`)

A player controller's result of the last completed step (`entityId`, absent: the first player controller), or `undefined` before the first step. An empty entity means this object.

Inputs:

- `entityId` "player" (string)

Outputs:

- `requested` (vector)
- `applied` (vector)
- `position` (vector)
- `grounded` (boolean)
- `supportNormal` "support normal" (vector)
- `contacts_ground` "contacts ground" (boolean)
- `contacts_wall` "contacts wall" (boolean)
- `contacts_head` "contacts head" (boolean)
- `contacts_steepSlope` "contacts steep slope" (boolean)
- `snapped` (boolean)
- `groundEntityId` "ground entity" (string)
- `kinematicSlack` "kinematic slack" (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-physics-raycast"></a>
### Raycast (`api.physics.raycast`)

A ray against the level's colliders (bounded per step; null when nothing is hit).

Inputs:

- `in` "" (exec): takes several wires
- `origin` (vector)
- `direction` (vector)
- `maxDistance` "max distance" (number)

Outputs:

- `then` "" (exec): one wire
- `entityId` "entity" (string)
- `distance` (number)
- `normal` (vector)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `origin` | origin | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `direction` | direction | vector | `[1,0,0]` | -1000000000 – 1000000000; 3 components |
| `maxDistance` | max distance | number | `10` | -1000000000 – 1000000000 |

<a id="node-behavior--api-physics-overlap-box"></a>
### Overlap box (`api.physics.overlapBox`)

The entities whose colliders overlap a box (center, half extents) — counted with the rays.

Inputs:

- `in` "" (exec): takes several wires
- `center` (vector)
- `half` (vector)

Outputs:

- `then` "" (exec): one wire
- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | center | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `half` | half | vector | `[0.5,0.5,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-physics-overlap-circle"></a>
### Overlap circle (`api.physics.overlapCircle`)

The entities whose colliders overlap a circle — counted with the rays.

Inputs:

- `in` "" (exec): takes several wires
- `center` (vector)
- `radius` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | center | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `radius` | radius | number | `0.5` | -1000000000 – 1000000000 |

<a id="node-behavior--api-physics-character-state"></a>
### Character state (`api.physics.characterState`)

3D projects: a player character's state after the last completed step (`entityId`, absent: the first player controller) — position, velocity, grounding, contacts, whether its controller is on and whether it is climbing a ledge — or undefined (a 2D plane, before the first step, or not a player controller). An empty entity means this object.

Inputs:

- `entityId` "player" (string)

Outputs:

- `position_x` "position x" (number)
- `position_y` "position y" (number)
- `position_z` "position z" (number)
- `velocity_x` "velocity x" (number)
- `velocity_y` "velocity y" (number)
- `velocity_z` "velocity z" (number)
- `grounded` (boolean)
- `contacts_ground` "contacts ground" (boolean)
- `contacts_wall` "contacts wall" (boolean)
- `contacts_head` "contacts head" (boolean)
- `contacts_steepSlope` "contacts steep slope" (boolean)
- `supportNormal_x` "support normal x" (number)
- `supportNormal_y` "support normal y" (number)
- `supportNormal_z` "support normal z" (number)
- `groundEntityId` "ground entity" (string)
- `enabled` (boolean)
- `climbing` (boolean)
- `facing` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-physics-raycast3d"></a>
### Raycast 3D (`api.physics.raycast3d`)

3D projects: the nearest collider a ray from `origin` along `direction` hits within `maxDistance` metres (default 100), or null — its object, the point, the surface normal and the distance. Counted with the other queries (at most 64 a step).

Inputs:

- `in` "" (exec): takes several wires
- `origin` (vector)
- `direction` (vector)
- `maxDistance` "max distance" (number)
- `tags` (list)
- `layers` (list)
- `exclude` (list)

Outputs:

- `then` "" (exec): one wire
- `entityId` "entity" (string)
- `point` (vector)
- `normal` (vector)
- `distance` (number)
- `cell` (vector)
- `scatter` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `origin` | origin | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `direction` | direction | vector | `[0,-1,0]` | -1000000000 – 1000000000; 3 components |
| `maxDistance` | max distance | number | `100` | -1000000000 – 1000000000 |

<a id="node-behavior--api-physics-overlap-sphere"></a>
### Overlap sphere (`api.physics.overlapSphere`)

3D projects: the objects whose colliders overlap a sphere (sorted ids, at most 64).

Inputs:

- `in` "" (exec): takes several wires
- `center` (vector)
- `radius` (number)
- `tags` (list)
- `layers` (list)
- `exclude` (list)

Outputs:

- `then` "" (exec): one wire
- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | center | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `radius` | radius | number | `0.5` | -1000000000 – 1000000000 |

<a id="node-behavior--api-physics-overlap-box3d"></a>
### Overlap box 3D (`api.physics.overlapBox3d`)

3D projects: the objects whose colliders overlap a box — centre, half extents [x, y, z] and an optional rotation quaternion [x, y, z, w].

Inputs:

- `in` "" (exec): takes several wires
- `center` (vector)
- `half` (vector)
- `rotation` (vector)
- `tags` (list)
- `layers` (list)
- `exclude` (list)

Outputs:

- `then` "" (exec): one wire
- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | center | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `half` | half | vector | `[0.5,0.5,0.5]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-physics-overlap-capsule"></a>
### Overlap capsule (`api.physics.overlapCapsule`)

3D projects: the objects whose colliders overlap an upright capsule (total height, end caps included), optionally turned by a quaternion [x, y, z, w].

Inputs:

- `in` "" (exec): takes several wires
- `center` (vector)
- `radius` (number)
- `height` (number)
- `rotation` (vector)
- `tags` (list)
- `layers` (list)
- `exclude` (list)

Outputs:

- `then` "" (exec): one wire
- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | center | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `radius` | radius | number | `0.3` | -1000000000 – 1000000000 |
| `height` | height | number | `1.8` | -1000000000 – 1000000000 |

<a id="node-behavior--api-physics-pick-at"></a>
### Pick at screen point (`api.physics.pickAt`)

3D projects: what is under a screen point (x, y 0–1 from the top left): the ray from the active camera (`ctx.camera.screenToRay`) cast into the colliders, within `maxDistance` (default 1000 m).

Inputs:

- `in` "" (exec): takes several wires
- `x` (number)
- `y` (number)
- `maxDistance` "max distance" (number)
- `tags` (list)
- `layers` (list)
- `exclude` (list)

Outputs:

- `then` "" (exec): one wire
- `entityId` "entity" (string)
- `point` (vector)
- `normal` (vector)
- `distance` (number)
- `cell` (vector)
- `scatter` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `x` | x | number | `0.5` | -1000000000 – 1000000000 |
| `y` | y | number | `0.5` | -1000000000 – 1000000000 |
| `maxDistance` | max distance | number | `1000` | -1000000000 – 1000000000 |

<a id="node-behavior--api-physics-pick-at-pointer"></a>
### Pick at pointer (`api.physics.pickAtPointer`)

3D projects: what is under the pointer this step (null while the pointer is outside the view or never moved); with a locked cursor, what is at the view's centre.

Inputs:

- `in` "" (exec): takes several wires
- `maxDistance` "max distance" (number)
- `tags` (list)
- `layers` (list)
- `exclude` (list)

Outputs:

- `then` "" (exec): one wire
- `entityId` "entity" (string)
- `point` (vector)
- `normal` (vector)
- `distance` (number)
- `cell` (vector)
- `scatter` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `maxDistance` | max distance | number | `1000` | -1000000000 – 1000000000 |

<a id="graph-behavior--tags"></a>
## Tags

- Tag mask (`api.tags.mask`): The mask of the named tags (names ignore case). Throws on an unknown name.
- Tags of (`api.tags.of`): The entity's effective tag mask (0 for an unknown entity). An empty entity means this object.
- Has tags (`api.tags.has`): Whether the entity carries any (default) or all of the mask's bits. An empty entity means this object.
- Find by tags (`api.tags.query`): The entities carrying any (default) or all of the mask's bits, in scene order.

<a id="node-behavior--api-tags-mask"></a>
### Tag mask (`api.tags.mask`)

The mask of the named tags (names ignore case). Throws on an unknown name.

Inputs:

- `names` "tags (comma separated)" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `names` | tags (comma separated) | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-tags-of"></a>
### Tags of (`api.tags.of`)

The entity's effective tag mask (0 for an unknown entity). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-tags-has"></a>
### Has tags (`api.tags.has`)

Whether the entity carries any (default) or all of the mask's bits. An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `mask` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `mask` | mask | number | `0` | -1000000000 – 1000000000 |
| `match` | match | enum | `"any"` | `any`, `all` |

<a id="node-behavior--api-tags-query"></a>
### Find by tags (`api.tags.query`)

The entities carrying any (default) or all of the mask's bits, in scene order.

Inputs:

- `mask` (number)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `mask` | mask | number | `0` | -1000000000 – 1000000000 |
| `match` | match | enum | `"any"` | `any`, `all` |

<a id="graph-behavior--world"></a>
## World

- Transform of (`api.world.transform`): The entity's transform this step so far, local to its parent (as the Inspector shows it; a root object's is its world transform), or `undefined` when it is not loaded. `{space: 'world'}` reads the world transform instead (as `worldTransform`). An empty entity means this object.
- World transform of (`api.world.worldTransform`): The entity's world transform this step so far: its transform composed up its parents, where it is drawn. Under a parent scaled unevenly and turned, the scale is the length of each world axis. `undefined` when it is not loaded. An empty entity means this object.
- Find object by name (`api.world.find`): The first loaded entity whose name is exactly `name` (case-sensitive), or `undefined`. Entities are searched in load order: the start scene in document order, then later scenes and spawned copies as they arrived.
- Find objects by name (`api.world.findAll`): Every loaded entity whose name is exactly `name` (case-sensitive), in load order (spawned copies included).
- Find objects with component (`api.world.withComponent`): Every loaded entity carrying a component of this kind (as stored on the entity, e.g. `'collider'`, `'light'`, `'behavior'`), in load order (spawned copies included).

<a id="node-behavior--api-world-transform"></a>
### Transform of (`api.world.transform`)

The entity's transform this step so far, local to its parent (as the Inspector shows it; a root object's is its world transform), or `undefined` when it is not loaded. `{space: 'world'}` reads the world transform instead (as `worldTransform`). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)

Outputs:

- `position` (vector)
- `rotation` (list)
- `scale` (vector)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `space` | space | enum | `"local"` | `local`, `world` |
