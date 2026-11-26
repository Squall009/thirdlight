# Content documents (animators to behaviorGroups)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

<a id="content-animators"></a>
## animators — Animator controllers

State machines for model animation.

- In every project: no
- Written by: [`setAnimator`](ops-detail.md#op-setAnimator), [`deleteAnimator`](ops-detail.md#op-deleteAnimator)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `animators` | list of objects | `[]` |  | **Animator controllers.** The project's controllers (each its own file). |
| `animators[]` | object |  |  | **Animator controller.** A state machine for model animation. (rules: Parameter names and state ids are unique; references name parameters and states of this controller.) |
| `animators[].controllerId` | string, id, 1–64 chars |  |  | **Id.** The stable controller id. (required; format id) |
| `animators[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers. (required; format name) |
| `animators[].parameters` | list of objects, ≤ 32 items | `[]` |  | **Parameters.** Up to 32 parameters (speed and grounded are set for the player automatically). (required) |
| `animators[].parameters[].name` | string, identifier, 1–64 chars |  |  | **Name.** A letter or _, then letters, digits or _. (required; format identifier) |
| `animators[].parameters[].type` | enum: `float`, `int`, `bool`, `trigger` | `"float"` |  | **Type.** Float, int, bool or trigger. (required) |
| `animators[].parameters[].default` | number | `0` | -1000000 – 1000000, step 0.1 | **Default.** The starting value. (applies when `type` is `float`) |
| `animators[].parameters[].default` | int | `0` | -1000000 – 1000000, step 1 | **Default.** The starting value. (applies when `type` is `int`) |
| `animators[].parameters[].default` | bool | `false` |  | **Default.** The starting value. (applies when `type` is `bool`) |
| `animators[].states` | list of objects, 1–64 items |  |  | **States.** 1–64 states. (required) |
| `animators[].states[].id` | string, id, 1–64 chars |  |  | **Id.** The stable state id (unique across layers). (required; format id) |
| `animators[].states[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the graph. (required; format name) |
| `animators[].states[].motion` | object |  |  | **Motion.** A clip or a blend tree. (required) |
| `animators[].states[].motion.kind` | enum: `clip`, `blend1d` | `"clip"` |  | **Motion.** What plays. (required; choices: `clip` = Clip, `blend1d` = Blend tree (1D)) |
| `animators[].states[].motion.clip` | object |  |  | **Clip.** A named clip of a model asset. (required; applies when `kind` is `clip`) |
| `animators[].states[].motion.clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].states[].motion.clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].states[].motion.clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].states[].motion.parameter` | animatorParameter id (float, int) |  |  | **Parameter.** The float or int parameter the tree blends by. (required; applies when `kind` is `blend1d`) |
| `animators[].states[].motion.children` | list of objects, 2–16 items |  |  | **Clips.** 2–16 clips by threshold (increasing). (required; applies when `kind` is `blend1d`) |
| `animators[].states[].motion.children[].threshold` | number |  | -1000000 – 1000000, step 0.1 | **Threshold.** The parameter value where this clip plays fully. (required) |
| `animators[].states[].motion.children[].clip` | object |  |  | **Clip.** A named clip of a model asset. (required) |
| `animators[].states[].motion.children[].clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].states[].motion.children[].clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].states[].motion.children[].clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].states[].motion.children[].speed` | number |  | 0 – 1000, step 0.1, m/s | **Ground speed.** The ground speed the clip was authored for. Set on every clip, the tree reads its parameter as a ground speed and scales time so the blended speed matches it (feet stay planted between the thresholds). |
| `animators[].states[].motion.children[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the blend tree graph draws the clip (editor only). |
| `animators[].states[].speed` | number | `1` | 0 – 10, step 0.05, × | **Speed.** Playback speed (× the speed parameter when set). (required) |
| `animators[].states[].speedParameter` | animatorParameter id (float) |  |  | **Speed parameter.** A float parameter the speed is multiplied by. |
| `animators[].states[].loop` | bool | `true` |  | **Loop.** Loops (else holds the last frame). (required) |
| `animators[].states[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the editor draws the state. |
| `animators[].transitions` | list of objects, ≤ 256 items | `[]` |  | **Transitions.** Up to 256 transitions. (required) |
| `animators[].transitions[]` | object |  |  | **Transition.** From a state (or any state) to a state, on conditions or at an exit time. (rules: A transition needs a condition or an exit time.) |
| `animators[].transitions[].from` | animatorState id or `*` |  |  | **From.** A state of this layer, or * (any state). (required) |
| `animators[].transitions[].to` | animatorState id |  |  | **To.** A state of this layer. (required) |
| `animators[].transitions[].conditions` | list of objects, ≤ 8 items | `[]` |  | **Conditions.** Up to 8; all must hold. (required) |
| `animators[].transitions[].conditions[].parameter` | animatorParameter id |  |  | **Parameter.** The parameter tested. (required) |
| `animators[].transitions[].conditions[].op` | enum: `greater`, `less`, `equals`, `notEquals`, `true`, `false`, `trigger` | `"greater"` |  | **Test.** Numbers: greater/less/equals/not equals; bools: true/false; triggers: trigger. (required; choices: `greater` = Greater, `less` = Less, `equals` = Equals, `notEquals` = Not equals, `true` = True, `false` = False, `trigger` = Trigger) |
| `animators[].transitions[].conditions[].value` | number | `0` | -1000000 – 1000000, step 0.1 | **Value.** Compared with. (required; applies when `op` is `greater` or `less` or `equals` or `notEquals`) |
| `animators[].transitions[].duration` | number | `0.2` | 0 – 10, step 0.05, s | **Crossfade.** Blend time. (required) |
| `animators[].transitions[].exitTime` | number |  | 0 – 100, step 0.05 | **Exit time.** Only after this normalized time of the source state (absent: any time). |
| `animators[].transitions[].interruption` | enum: `none`, `source` | `"none"` |  | **Interruption.** None, or a newer transition from the current state may cut in. |
| `animators[].entry` | animatorState id |  |  | **Entry state.** The state the base layer starts in. (required) |
| `animators[].events` | list of objects, ≤ 64 items | `[]` |  | **Events.** Up to 64 named events at clip times (scripts hear them). (required) |
| `animators[].events[].assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].events[].clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].events[].time` | number | `0` | 0 – 600, step 0.01, s | **Time.** Seconds into the clip. (required) |
| `animators[].events[].name` | string, identifier, 1–64 chars |  |  | **Name.** A letter or _, then letters, digits or _. (required; format identifier) |
| `animators[].morphs` | list of objects, ≤ 32 items |  |  | **Morph targets.** Up to 32 morph targets (blend shapes) whose weight follows a float parameter (clamped to 0–1); scripts may set others. |
| `animators[].morphs[].target` | string, name, 1–128 chars |  |  | **Target.** The morph target's name in the model. (required; format name) |
| `animators[].morphs[].parameter` | animatorParameter id (float) |  |  | **Parameter.** The float parameter whose value (0–1) is the weight. (required) |
| `animators[].layers` | list of objects, 1–3 items |  |  | **Layers.** 1–3 override layers over the base layer (absent: the base layer only). |
| `animators[].layers[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the editor. (required; format name) |
| `animators[].layers[].mask` | list of string, boneName, 1–128 chars, ≤ 128 items, distinct | `[]` |  | **Bones.** The bones this layer drives (up to 128; empty: every bone). (required) |
| `animators[].layers[].weight` | number | `1` | 0 – 1, step 0.05 | **Weight.** How much the layer replaces the ones under it. (required) |
| `animators[].layers[].weightParameter` | animatorParameter id (float) |  |  | **Weight parameter.** A float parameter (0–1) the weight is multiplied by. |
| `animators[].layers[].states` | list of objects, 1–64 items |  |  | **States.** 1–64 states. (required) |
| `animators[].layers[].states[].id` | string, id, 1–64 chars |  |  | **Id.** The stable state id (unique across layers). (required; format id) |
| `animators[].layers[].states[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the graph. (required; format name) |
| `animators[].layers[].states[].motion` | object |  |  | **Motion.** A clip, a blend tree, or nothing (the layers under it show through). (required) |
| `animators[].layers[].states[].motion.kind` | enum: `clip`, `blend1d`, `empty` | `"clip"` |  | **Motion.** What plays. (required; choices: `clip` = Clip, `blend1d` = Blend tree (1D), `empty` = Empty) |
| `animators[].layers[].states[].motion.clip` | object |  |  | **Clip.** A named clip of a model asset. (required; applies when `kind` is `clip`) |
| `animators[].layers[].states[].motion.clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].layers[].states[].motion.clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].layers[].states[].motion.clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].layers[].states[].motion.parameter` | animatorParameter id (float, int) |  |  | **Parameter.** The float or int parameter the tree blends by. (required; applies when `kind` is `blend1d`) |
| `animators[].layers[].states[].motion.children` | list of objects, 2–16 items |  |  | **Clips.** 2–16 clips by threshold (increasing). (required; applies when `kind` is `blend1d`) |
| `animators[].layers[].states[].motion.children[].threshold` | number |  | -1000000 – 1000000, step 0.1 | **Threshold.** The parameter value where this clip plays fully. (required) |
| `animators[].layers[].states[].motion.children[].clip` | object |  |  | **Clip.** A named clip of a model asset. (required) |
| `animators[].layers[].states[].motion.children[].clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].layers[].states[].motion.children[].clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].layers[].states[].motion.children[].clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].layers[].states[].motion.children[].speed` | number |  | 0 – 1000, step 0.1, m/s | **Ground speed.** The ground speed the clip was authored for. Set on every clip, the tree reads its parameter as a ground speed and scales time so the blended speed matches it (feet stay planted between the thresholds). |
| `animators[].layers[].states[].motion.children[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the blend tree graph draws the clip (editor only). |
| `animators[].layers[].states[].speed` | number | `1` | 0 – 10, step 0.05, × | **Speed.** Playback speed (× the speed parameter when set). (required) |
| `animators[].layers[].states[].speedParameter` | animatorParameter id (float) |  |  | **Speed parameter.** A float parameter the speed is multiplied by. |
| `animators[].layers[].states[].loop` | bool | `true` |  | **Loop.** Loops (else holds the last frame). (required) |
| `animators[].layers[].states[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the editor draws the state. |
| `animators[].layers[].transitions` | list of objects, ≤ 256 items | `[]` |  | **Transitions.** Up to 256 transitions. (required) |
| `animators[].layers[].transitions[]` | object |  |  | **Transition.** From a state (or any state) to a state, on conditions or at an exit time. (rules: A transition needs a condition or an exit time.) |
| `animators[].layers[].transitions[].from` | animatorState id or `*` |  |  | **From.** A state of this layer, or * (any state). (required) |
| `animators[].layers[].transitions[].to` | animatorState id |  |  | **To.** A state of this layer. (required) |
| `animators[].layers[].transitions[].conditions` | list of objects, ≤ 8 items | `[]` |  | **Conditions.** Up to 8; all must hold. (required) |
| `animators[].layers[].transitions[].conditions[].parameter` | animatorParameter id |  |  | **Parameter.** The parameter tested. (required) |
| `animators[].layers[].transitions[].conditions[].op` | enum: `greater`, `less`, `equals`, `notEquals`, `true`, `false`, `trigger` | `"greater"` |  | **Test.** Numbers: greater/less/equals/not equals; bools: true/false; triggers: trigger. (required; choices: `greater` = Greater, `less` = Less, `equals` = Equals, `notEquals` = Not equals, `true` = True, `false` = False, `trigger` = Trigger) |
| `animators[].layers[].transitions[].conditions[].value` | number | `0` | -1000000 – 1000000, step 0.1 | **Value.** Compared with. (required; applies when `op` is `greater` or `less` or `equals` or `notEquals`) |
| `animators[].layers[].transitions[].duration` | number | `0.2` | 0 – 10, step 0.05, s | **Crossfade.** Blend time. (required) |
| `animators[].layers[].transitions[].exitTime` | number |  | 0 – 100, step 0.05 | **Exit time.** Only after this normalized time of the source state (absent: any time). |
| `animators[].layers[].transitions[].interruption` | enum: `none`, `source` | `"none"` |  | **Interruption.** None, or a newer transition from the current state may cut in. |
| `animators[].layers[].entry` | animatorState id |  |  | **Entry state.** The state the layer starts in. (required) |

<a id="content-effects"></a>
## effects — Effects

Visual effects: particle systems authored as node graphs.

- In every project: no
- Written by: [`setEffect`](ops-detail.md#op-setEffect), [`deleteEffect`](ops-detail.md#op-deleteEffect), [`renameEffect`](ops-detail.md#op-renameEffect), [`graphEdit`](ops-detail.md#op-graphEdit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `effects` | list of objects | `[]` |  | **Effects.** The project's effects (each its own file). |
| `effects[].effectId` | string, id, 1–64 chars |  |  | **Id.** The stable effect id. (required; written by a tool; format id) |
| `effects[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers and the Effects list. (required; format name) |
| `effects[].duration` | number | `2` | 0.01 – 3600, step 0.1, s | **Duration.** One cycle of the effect (bursts and the effect time refer to it). (required) |
| `effects[].loop` | bool | `true` |  | **Loop.** Restart the cycle at its end (off: spawning stops and the effect ends when its particles are gone). (required) |
| `effects[].seed` | int | `1` | 0 – 4294967295, step 1 | **Seed.** The random seed: the same seed gives the same particles. (required) |
| `effects[].bounds` | object |  |  | **Bounds.** The culling box around the origin: the effect is skipped when this box is off screen. (required) |
| `effects[].bounds.center` | vec3 [x, y, z] | `[0,1,0]` | -10000 – 10000, step 0.1, m | **Centre.** The box centre relative to the origin. (required) |
| `effects[].bounds.size` | vec3 [x, y, z] | `[4,4,4]` | > 0, ≤ 10000, step 0.1, m | **Size.** The box size. (required) |
| `effects[].parameters` | list of objects, ≤ 32 items |  |  | **Exposed parameters.** Up to 32 parameters the systems read (Parameter nodes); objects may override the public ones. |
| `effects[].parameters[].key` | string, identifier, 1–32 chars |  |  | **Key.** The name Parameter nodes and overrides use. (required; format identifier) |
| `effects[].parameters[].type` | enum: `float`, `vec3`, `color` | `"float"` |  | **Type.** The value type. (required) |
| `effects[].parameters[].default` | JSON (typed by effectParameter) |  |  | **Default.** The effect's own value (a number, 3 numbers or "#rrggbb"). (required) |
| `effects[].parameters[].min` | number |  |  | **Min.** The lowest value, within ±1e6 (numbers and vectors). (applies when `type` is `float` or `vec3`) |
| `effects[].parameters[].max` | number |  |  | **Max.** The highest value, within ±1e6 and at least min (numbers and vectors). (applies when `type` is `float` or `vec3`) |
| `effects[].parameters[].visibility` | enum: `public`, `private` | `"public"` |  | **Visibility.** Public: objects may override it. Private: the effect's value only. (stored only when not the default) |
| `effects[].parameters[].label` | string, 1–64 chars |  |  | **Label.** Shown instead of the key. |
| `effects[].parameters[].group` | string, 1–64 chars |  |  | **Group.** A foldable group in the Inspector. |
| `effects[].parameters[].tooltip` | string, 1–256 chars |  |  | **Tooltip.** Help text. |
| `effects[].systems` | list of objects, ≤ 16 items | `[]` |  | **Systems.** Up to 16 particle systems, in evaluation order. (required) |
| `effects[].systems[].systemId` | string, id, 1–64 chars |  |  | **Id.** The stable system id (unique in the effect). (required; written by a tool; format id) |
| `effects[].systems[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the Effect tab. (required; format name) |
| `effects[].systems[].maxParticles` | int | `1000` | 1 – 1048576, step 1 | **Max particles.** The most living particles (executors may cap lower; the CPU fallback does). (required) |
| `effects[].systems[].space` | enum: `local`, `world` | `"local"` |  | **Simulation space.** Local: particles move with the object. World: they stay where they were born. (required) |
| `effects[].systems[].graph` | JSON |  |  | **Graph.** The system graph (graph kind "effect": Spawn, Initialize, Update and Output chains), edited in the Effect tab with graph edits. (required; written by a tool) |

<a id="content-scriptLibraries"></a>
## scriptLibraries — Script libraries

Shared TypeScript and JSON modules every script can import as @lib/<id>.

- In every project: no
- Written by: [`setScriptLibrary`](ops-detail.md#op-setScriptLibrary), [`deleteScriptLibrary`](ops-detail.md#op-deleteScriptLibrary)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `scriptLibraries` | list of JSON: `ScriptLibrary` ([ScriptLibrary](types-m-s.md#type-script-library)) | `[]` |  | **Script libraries.** The project's libraries (each its own file). |

<a id="content-blockTypes"></a>
## blockTypes — Block types

The blocks block layers are built from: their looks, collision shape, footprint, rotations and default cell metadata.

- In every project: no
- Written by: [`setBlockType`](ops-detail.md#op-setBlockType), [`deleteBlockType`](ops-detail.md#op-deleteBlockType)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `blockTypes` | list of objects | `[]` |  | **Block types.** The project's block types. |
| `blockTypes[].blockId` | string, id, 1–64 chars |  |  | **Id.** The stable block id cells name. (required; format id) |
| `blockTypes[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the block palette. (required; format name) |
| `blockTypes[].variants` | list of objects, 1–8 items |  |  | **Looks.** 1–8 weighted looks (a cell without a variant picks one by weight, stably by position). (required) |
| `blockTypes[].variants[]` | object |  |  | **Look.** One look: a model, a prefab or a colour. (rules: A look is one of a model, a prefab or a colour.) |
| `blockTypes[].variants[].model` | object |  |  | **Model.** A model asset, or one named part of it. |
| `blockTypes[].variants[].model.assetId` | asset id (model) |  |  | **Model.** The model asset. (required) |
| `blockTypes[].variants[].model.piece` | string, 1–128 chars |  |  | **Piece.** One node of the model (its name); absent: the whole model. |
| `blockTypes[].variants[].prefab` | prefab id |  |  | **Prefab.** A prefab shown in the cell (spawned as real objects when the block is live). |
| `blockTypes[].variants[].color` | color |  |  | **Colour.** A coloured stand-in of the block's shape. |
| `blockTypes[].variants[].weight` | number |  | > 0, ≤ 1000 | **Weight.** How often this look is picked against the others (absent: 1). |
| `blockTypes[].variants[].uv` | enum: `model`, `world` |  |  | **Texture mapping.** This look's own texture mapping (absent: the block type's). (choices: `model` = Model, `world` = World (metres)) |
| `blockTypes[].uv` | enum: `model`, `world` | `"model"` |  | **Texture mapping.** Where the looks' texture coordinates come from. Model: the model's own (a coloured stand-in, or a model part without any, is mapped to the world). World: from the block's place in the layer, in metres, one flat projection per face (tops from above, walls from the side, slopes past 45° as walls), so a texture runs on across cells without a seam; a material's tiling sets how many metres one repeat covers. A look may set its own. (choices: `model` = Model, `world` = World (metres)) |
| `blockTypes[].shape` | enum: `full`, `half`, `ramp`, `stairs`, `custom`, `none` |  |  | **Collision shape.** The collision shape (and the coloured stand-in's shape): full, half, ramp, stairs (rising toward +Z), custom boxes or none. (required) |
| `blockTypes[].boxes` | list of list of number, 6 items, 1–8 items |  |  | **Custom boxes.** 1–8 boxes in footprint units (0–1). (required; applies when `shape` is `custom`) |
| `blockTypes[].boxes[]` | list of number, 6 items |  |  | **Box.** [x0, y0, z0, x1, y1, z1] in footprint units (0–1), max above min on every axis. |
| `blockTypes[].solid` | bool |  |  | **Solid.** Fills its cell and hides the faces of neighbours touching it (absent: a full shape is solid). |
| `blockTypes[].footprint` | vec3 [x, y, z] | `[1,1,1]` | 1 – 8, step 1 | **Footprint.** Cells along x, y and z (a 2 × 1 × 2 well); the cells it covers stay empty. |
| `blockTypes[].rotations` | list of int (one of 0, 90, 180, 270), 1–4 items, distinct |  |  | **Rotations.** The allowed rotations in degrees (absent: all). |
| `blockTypes[].metadata` | map identifier → JSON (typed by cellField) |  |  | **Default metadata.** Cell metadata every cell of this block starts with (field → value). |
| `blockTypes[].materials` | map materialSlot → material id, 1–32 entries |  |  | **Materials.** Material slot → project material: a model look's source material name, or "*" for every slot (a coloured stand-in has one: "*" gives it a material, e.g. a painted terrain material). |
| `blockTypes[].live` | bool |  |  | **Live.** In the running game each cell showing a prefab look spawns that prefab as real objects (scripts, movers, lights, children), placed, removed and saved with the cell; the root's model stays merged with the blocks. |
| `blockTypes[].oneWay` | bool | `false` |  | **One-way.** The player jumps up through it and lands on top (a floating ledge); it drops through with down + jump. |
| `blockTypes[].placement` | enum: `cell`, `edge` | `"cell"` |  | **Placement.** Cell: the block fills cells. Edge: it stands on the edge between two cells (a wall, door, window, fence), drawn along the edge and facing across it; its shape is a thin slab (full, half), boxes or none. |
| `blockTypes[].blocking` | bool | `true` |  | **Blocks passage.** An edge piece blocks moving across its edge (grid movement and pathfinding read it); an open one (a door) never does. (applies when `placement` is `edge`) |
| `blockTypes[].connect` | object |  |  | **Connections.** The look follows the neighbours: paint the block and each cell (or edge) shows the straight, corner, T-join, cross, end, base or cap piece its neighbours call for, turned to fit. A piece not set keeps the ordinary look; a cell that names a variant keeps it. |
| `blockTypes[].connect.with` | list of string, id, 1–64 chars, ≤ 32 items, distinct | `[]` |  | **Connects with.** Other block types (of the same placement) that count as connected; the block itself always does. |
| `blockTypes[].connect.pieces` | object | `{}` |  | **Pieces.** The look of each piece (unturned neighbours in its own frame). (required) |
| `blockTypes[].connect.pieces.single` | object |  |  | **Single.** No neighbour. |
| `blockTypes[].connect.pieces.single.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.single.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.end` | object |  |  | **End.** One neighbour (+Z unturned); an edge piece: joined at +X only. |
| `blockTypes[].connect.pieces.end.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.end.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.straight` | object |  |  | **Straight.** Two opposite (−Z, +Z); an edge piece: both ends joined. |
| `blockTypes[].connect.pieces.straight.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.straight.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.corner` | object |  |  | **Corner.** Two at a right angle (+X, +Z); an edge piece: a turn at +X. |
| `blockTypes[].connect.pieces.corner.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.corner.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.t` | object |  |  | **T-join.** Three (−X, +X, +Z). Cells only. |
| `blockTypes[].connect.pieces.t.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.t.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.cross` | object |  |  | **Cross.** All four. Cells only. |
| `blockTypes[].connect.pieces.cross.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.cross.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.base` | object |  |  | **Base.** One above, none below. |
| `blockTypes[].connect.pieces.base.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.base.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].connect.pieces.cap` | object |  |  | **Cap.** One below, none above. |
| `blockTypes[].connect.pieces.cap.variant` | int | `0` | 0 – 7, step 1 | **Look.** Variant index. (required) |
| `blockTypes[].connect.pieces.cap.rot` | int (one of 0, 90, 180, 270) | `0` | step 1 | **Extra turn.** Degrees (edges: 0, 180). (stored only when not the default) |
| `blockTypes[].kits` | map id → object, ≥ 1 entries |  |  | **Themes.** What the block shows under each theme (a burnt, ruined or winter set): a layer, or a region of it, that shows the theme draws this block type instead, without changing the cells. The target keeps the layout: the same placement and footprint. A theme is every block's entry under one name (stored as kits). |
| `blockTypes[].kits{}.block` | string, id, 1–64 chars |  |  | **Block.** The block type drawn instead (the same placement and footprint). (required; format id) |
| `blockTypes[].kits{}.variant` | int |  | 0 – 7, step 1 | **Look.** The target's look (absent: the cell's own when the target has it, else one picked by the target's weights; a connected target keeps resolving its pieces). |
| `blockTypes[].kits{}.variants` | list of int, ≤ 8 items |  |  | **Look per look.** Per look of this block (in order): the target's look shown. Wins over Look. |

<a id="content-cellFields"></a>
## cellFields — Cell fields

The project's cell metadata schema (walkable, slippery, move cost, terrain…): what every block-layer cell can carry.

- In every project: no
- Written by: [`setCellFields`](ops-detail.md#op-setCellFields)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `cellFields` | list of objects, ≤ 32 items | `[]` |  | **Cell fields.** Up to 32 fields. |
| `cellFields[].key` | string, identifier, 1–32 chars |  |  | **Key.** The field name scripts read (an identifier). (required; format identifier) |
| `cellFields[].type` | enum: `bool`, `enum`, `int`, `float`, `string` |  |  | **Type.** Boolean, choice, whole number, number or text. (required) |
| `cellFields[].default` | JSON |  |  | **Default.** The value a cell has when neither its block nor the cell sets one (absent: false / the first choice / 0 / ""). |
| `cellFields[].values` | list of string, 1–64 chars, 1–32 items, distinct |  |  | **Choices.** The choices (1–32). (required; applies when `type` is `enum`) |
| `cellFields[].min` | number |  |  | **Min.** The smallest value. (applies when `type` is `int` or `float`) |
| `cellFields[].max` | number |  |  | **Max.** The largest value. (applies when `type` is `int` or `float`) |
| `cellFields[].color` | color |  |  | **Overlay colour.** The colour the editor paints this field with. |
| `cellFields[].label` | string, 1–64 chars |  |  | **Label.** Shown in the editor. |

<a id="content-blockStamps"></a>
## blockStamps — Block stamps

Saved patterns of cells (a cottage footprint, a bridge span) placed on block layers.

- In every project: no
- Written by: [`setBlockStamp`](ops-detail.md#op-setBlockStamp), [`deleteBlockStamp`](ops-detail.md#op-deleteBlockStamp)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `blockStamps` | list of objects | `[]` |  | **Block stamps.** The project's stamps. |
| `blockStamps[].stampId` | string, id, 1–64 chars |  |  | **Id.** The stable stamp id. (required; format id) |
| `blockStamps[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the stamp list. (required; format name) |
| `blockStamps[].size` | vec3 [x, y, z] |  | 1 – 64, step 1 | **Size.** The pattern's extent in cells. (required) |
| `blockStamps[].palette` | JSON |  |  | **Palette.** The cell values the runs name. (required; written by a tool) |
| `blockStamps[].columns` | JSON |  |  | **Cells.** Run-length columns [x, z, y, n, p, …] (at most 16384 cells). (required; written by a tool) |
| `blockStamps[].edgePalette` | JSON |  |  | **Edge pieces.** The edge values the edge rows name. (written by a tool) |
| `blockStamps[].edges` | JSON |  |  | **Edges.** Edge rows [x, z, y, axis, p] (the outline included). (written by a tool) |

<a id="content-kits"></a>
## kits — Kits

What a level style is built from, as one item: a trim sheet material, the architecture presets using it, block types and named piece slots (door, window, wall override, corner, stairs, railing, roof edge, or names of your own). A kit names its parts; they stay ordinary items. Editor-side: a build does not ship kits.

- In every project: no
- Written by: [`setKit`](ops-detail.md#op-setKit), [`deleteKit`](ops-detail.md#op-deleteKit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `kits` | list of objects | `[]` |  | **Kits.** The project's kits (each its own file). |
| `kits[].kitId` | string, id, 1–64 chars |  |  | **Id.** The stable kit id. (required; format id) |
| `kits[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the project window. (required; format name) |
| `kits[].description` | string, multiline, ≤ 1024 chars |  |  | **Description.** What the kit is for. (format multiline) |
| `kits[].thumbnail` | string, id, 1–64 chars |  |  | **Picture.** A texture asset shown as the kit's picture. (format id) |
| `kits[].trimMaterial` | material id |  |  | **Trim sheet.** The trim sheet material its presets and block faces read. |
| `kits[].presets` | list of string, id, 1–64 chars, distinct |  |  | **Presets.** Architecture preset graphs (styles for rooms, buildings and runs). |
| `kits[].blockTypes` | list of string, id, 1–64 chars, distinct |  |  | **Block types.** Block types the block editor's palette offers. |
| `kits[].pieces` | JSON: `Record<string, KitPiece[]>` ([KitPiece](types-c-m.md#type-kit-piece)) |  |  | **Pieces.** Piece slots: {slot: [{assetId, piece?, weight?}, …]} (1-8 weighted pieces a slot). Standard slots: door, window, wall-override, corner, stairs, railing, roof-edge. |

<a id="content-voxelKits"></a>
## voxelKits — Voxel kits

The detail pieces a material type (wood, stone, …) draws a voxel world's edges, corners, roof edges and damage with, as slots: every case is a slot, filled with one or more weighted meshes each with a cube rotation (drawn in the near ring only), or left empty (plain voxel edges). One texture set a kit, a jitter for every piece, and the game's own data. Shipped whole with the build; the engine never reads the game data.

- In every project: no
- Written by: [`setVoxelKit`](ops-detail.md#op-setVoxelKit), [`deleteVoxelKit`](ops-detail.md#op-deleteVoxelKit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `voxelKits` | list of objects | `[]` |  | **Voxel kits.** The project's voxel kits (each its own file). |
| `voxelKits[].kitFormat` | int | `1` | 1 – 1, step 1 | **Format.** The kit record's format (1); a newer one is refused. (required; written by a tool) |
| `voxelKits[].voxelKitId` | string, id, 1–64 chars |  |  | **Id.** The stable voxel kit id. (required; format id) |
| `voxelKits[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the project window. (required; format name) |
| `voxelKits[].version` | int | `1` | ≥ 1, step 1 | **Version.** The kit's own revision (a positive integer its author moves). (required) |
| `voxelKits[].materialType` | string, id, 1–64 chars |  |  | **Material type.** The material type the kit dresses (wood, stone, …): every material of the type shares its pieces. (required; format id) |
| `voxelKits[].materials` | list of int, distinct |  |  | **Materials.** Test binding: the voxel material ids (1-4095) the kit applies to, until materials name their kit. |
| `voxelKits[].slots` | JSON: `Record<string, VoxelKitSlot>` ([VoxelKitSlot](types-s-w.md#type-voxel-kit-slot)) |  |  | **Slots.** {caseId: {meshes: [{mesh, rotation?, weight?, mirror?}, …], gameData?}}: a slot a case of the case catalogue, every one optional (left out: nothing drawn); a mesh is {assetId, digest (the GLB's SHA-256), node?}; rotation one of the 24 cube rotations 0-23 (absent 0); weight in (0, 1000], absent 1; mirror true draws it mirrored across its case's run (a handed piece's other hand). Which mesh a piece draws follows the project's voxel detail seed. (required) |
| `voxelKits[].jitter` | number | `1` | 0 – 4, step 0.05 | **Jitter.** How far every piece moves into the solid and twists, as a share of the engine's stagger (1: 1/64-1/32 cell in, up to 2°; 0: on the lattice; at most 4). |
| `voxelKits[].trimLayout` | string, id, 1–64 chars |  |  | **Trim layout.** The trim layout the pieces' UVs follow (absent: the kit uses no trim sheet, or its own sheet layout). (format id) |
| `voxelKits[].sheetLayout` | JSON: `VoxelKitSheetLayout` ([VoxelKitSheetLayout](types-s-w.md#type-voxel-kit-sheet-layout)) |  |  | **Sheet layout.** The kit's own sheet instead of a named trim layout: {size (16-16384 px a side), pxPerMetre, regions: [{id, kind: field\|strip\|profiled\|cap, metres, y: [top, end), x?: [left, end) (caps only)}]}; its strips get world-anchored U and the kit check reads its regions. Voxel faces keep the 4 × 4 m tiling textures. |
| `voxelKits[].wallTopFill` | bool | `false` |  | **Wall-top fill.** A roof kit's: its roofs close their slab down onto the walls under them, cutting the wall tops to the roof's underside. Off: the walls keep their stepped tops under the parallel underside. |
| `voxelKits[].gameData` | JSON |  |  | **Game data.** The game's own data for the kit (break, sound, physics defaults …): JSON nested at most 32 deep, shipped as it is, never read by the engine. |

<a id="content-materialProfiles"></a>
## materialProfiles — Physical profiles

Shared physics (and the game's defaults as game data) materials name instead of repeating them. The engine has Earth, Glass, Lava, Metal, Stone, Water, Wood; a project profile with one of their ids overrides the fields it sets.

- In every project: no
- Written by: [`setMaterialProfile`](ops-detail.md#op-setMaterialProfile), [`deleteMaterialProfile`](ops-detail.md#op-deleteMaterialProfile)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `materialProfiles` | list of objects | `[]` |  | **Physical profiles.** The project's profiles. |
| `materialProfiles[].profileId` | string, id, 1–64 chars |  |  | **Id.** The stable profile id (an engine profile's id overrides it). (required; format id) |
| `materialProfiles[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers. (required; format name) |
| `materialProfiles[].density` | number |  | > 0, ≤ 30000, step 10, kg/m³ | **Density.** Mass density. |
| `materialProfiles[].friction` | number |  | 0 – 4, step 0.05 | **Friction.** Friction coefficient (0: ice-smooth). |
| `materialProfiles[].restitution` | number |  | 0 – 1, step 0.05 | **Restitution.** Bounciness (0: none, 1: perfectly elastic). |
| `materialProfiles[].flowRate` | number |  | 0 – 100, step 0.05 | **Flow rate.** How fast a liquid spreads, relative to water (1); solids leave it out. |
| `materialProfiles[].gameData` | JSON |  |  | **Game data.** The game's defaults for every material of the profile (footstep sound, break tags …): JSON nested at most 32 deep, never read by the engine; a material's own keys override them. |

<a id="content-uiDocuments"></a>
## uiDocuments — UI documents

HUDs, menus and screens drawn by the game over the view (widget trees bound to script values).

- In every project: no
- Written by: [`setUiDocument`](ops-detail.md#op-setUiDocument), [`deleteUiDocument`](ops-detail.md#op-deleteUiDocument)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `uiDocuments` | list of JSON: `UiDocument` ([UiDocument](types-s-w.md#type-ui-document)) | `[]` |  | **UI documents.** The project's documents (each its own file). |

<a id="content-modes"></a>
## modes — Game modes

Named states of the running game: the input maps, camera, UI documents and ticking behavior groups of each, switched in one transition without a scene load (explore and tactical, on foot and driving, build and play…). The first mode is the one a run starts in.

- In every project: no
- Written by: [`setModes`](ops-detail.md#op-setModes)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `modes` | list of objects | `[]` |  | **Game modes.** The first is the start mode. |
| `modes[].modeId` | string, id, 1–64 chars |  |  | **Id.** Scripts (ctx.modes.switch) and UI mode actions name it. (required; format id) |
| `modes[].name` | string, 1–64 chars |  |  | **Name.** Shown in the editor and the Play toolbar. (required) |
| `modes[].inputMaps` | list of inputMap id, distinct |  |  | **Input maps.** The input maps active in the mode (absent: every map). Actions of other maps read as released. |
| `modes[].camera` | object id (with `virtualCamera`), any scene |  |  | **Camera.** A virtual camera that is live while the mode is, over the priorities (absent: the priority rule). |
| `modes[].ui` | list of uiDocument id, distinct |  |  | **UI documents.** Shown while the mode is active, hidden when it ends. |
| `modes[].groups` | list of behaviorGroup id, distinct |  |  | **Ticking groups.** The behavior groups whose scripts run (absent: every group). The other groups pause. |
| `modes[].ungrouped` | enum: `tick`, `pause` | `"tick"` |  | **Ungrouped behaviors.** Behaviors of objects without a behavior group. |
| `modes[].pause` | bool | `true` |  | **Pause allowed.** The engine pause (the pause key, a pause button) may be used in this mode. |
| `modes[].pauseScreen` | uiDocument id |  |  | **Pause screen.** A UI document drawn while the game is paused in this mode (absent: the engine's pause panel). |
| `modes[].timeScale` | number | `1` | 0.1 – 4, step 0.05 | **Time scale.** Simulation speed: fewer or more fixed steps per second (each step unchanged). |
| `modes[].physics` | enum: `run`, `hold` | `"run"` |  | **Physics.** Physics, the character, movers and triggers step (run) or stand still (hold). |
| `modes[].enter` | object |  |  | **Transition in.** How entering this mode looks (a script's switch may pass its own). |
| `modes[].enter.blend` | enum: `cut`, `linear`, `eased` |  |  | **Camera blend.** How the view moves to the mode's camera (absent: the camera's own blend). |
| `modes[].enter.blendTime` | number |  | 0 – 30, step 0.05, s | **Blend time.** Seconds of the camera blend (absent: the camera's own). |
| `modes[].enter.fade` | uiDocument id |  |  | **Fade document.** A UI document shown from the switch for the fade time — its show and hide tweens are the fade. |
| `modes[].enter.fadeTime` | number | `0.5` | 0.05 – 10, step 0.05, s | **Fade time.** Seconds the fade document stays. |

<a id="content-behaviorGroups"></a>
## behaviorGroups — Behavior groups

Names an object's behavior can belong to (its Behavior group component); a game mode lists the groups that tick while it is active.

- In every project: no
- Written by: [`setBehaviorGroups`](ops-detail.md#op-setBehaviorGroups)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `behaviorGroups` | list of string, identifier, 1–32 chars, distinct | `[]` |  | **Behavior groups.** The group names. |
