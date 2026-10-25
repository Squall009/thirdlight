# Content documents (effects to saveSchema)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

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
| `scriptLibraries` | list of JSON: `ScriptLibrary` ([ScriptLibrary](types-p-t.md#type-script-library)) | `[]` |  | **Script libraries.** The project's libraries (each its own file). |

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
| `blockTypes[].oneWay` | bool | `false` |  | **One-way.** The player jumps up through it and lands on top (a floating ledge); it drops through with down + jump. Block layers do not apply it yet: their blocks collide solid. |
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
| `kits[].pieces` | JSON: `Record<string, KitPiece[]>` ([KitPiece](types-d-p.md#type-kit-piece)) |  |  | **Pieces.** Piece slots: {slot: [{assetId, piece?, weight?}, …]} (1-8 weighted pieces a slot). Standard slots: door, window, wall-override, corner, stairs, railing, roof-edge. |

<a id="content-uiDocuments"></a>
## uiDocuments — UI documents

HUDs, menus and screens drawn by the game over the view (widget trees bound to script values).

- In every project: no
- Written by: [`setUiDocument`](ops-detail.md#op-setUiDocument), [`deleteUiDocument`](ops-detail.md#op-deleteUiDocument)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `uiDocuments` | list of JSON: `UiDocument` ([UiDocument](types-u-w.md#type-ui-document)) | `[]` |  | **UI documents.** The project's documents (each its own file). |

<a id="content-modes"></a>
## modes — Game modes

Named states of the running game: the input maps, camera, UI documents and ticking behavior groups of each, switched in one transition without a scene load (explore and tactical, on foot and driving, build and play…). The first mode is the one a run starts in.

- In every project: no
- Written by: [`setModes`](ops-detail.md#op-setModes)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `modes` | list of objects, ≤ 16 items | `[]` |  | **Game modes.** Up to 16 modes; the first is the start mode. |
| `modes[].modeId` | string, id, 1–64 chars |  |  | **Id.** Scripts (ctx.modes.switch) and UI mode actions name it. (required; format id) |
| `modes[].name` | string, 1–64 chars |  |  | **Name.** Shown in the editor and the Play toolbar. (required) |
| `modes[].inputMaps` | list of inputMap id, ≤ 8 items, distinct |  |  | **Input maps.** The input maps active in the mode (absent: every map). Actions of other maps read as released. |
| `modes[].camera` | object id (with `virtualCamera`), any scene |  |  | **Camera.** A virtual camera that is live while the mode is, over the priorities (absent: the priority rule). |
| `modes[].ui` | list of uiDocument id, ≤ 16 items, distinct |  |  | **UI documents.** Shown while the mode is active, hidden when it ends. |
| `modes[].groups` | list of behaviorGroup id, ≤ 32 items, distinct |  |  | **Ticking groups.** The behavior groups whose scripts run (absent: every group). The other groups pause. |
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
| `behaviorGroups` | list of string, identifier, 1–32 chars, ≤ 32 items, distinct | `[]` |  | **Behavior groups.** Up to 32 names. |

<a id="content-shell"></a>
## shell — Game shell

The menus around the game and its HUD, drawn with the project's UI documents: a title before play, pause, settings, controls (rebinding) and the save and load screens (project saves), the HUD shown while playing, and the game's scenes in order.

- In every project: no
- Written by: [`setShell`](ops-detail.md#op-setShell)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `screens` | object |  |  | **Screens.** The UI document drawn for each shell screen. Its buttons use the engine actions: resume, continue, back, open a screen, save or load a slot, set a setting, rebind, next scene (deprecated), load, unload or reload a scene. |
| `screens.title` | uiDocument id |  |  | **Title.** Shown before play (the game waits behind it); absent: the game starts at once. |
| `screens.pause` | uiDocument id |  |  | **Pause.** Shown while paused (absent: the engine's pause panel, with Resume only). |
| `screens.settings` | uiDocument id |  |  | **Settings.** Opened by the settings or open action (volumes, quality). |
| `screens.controls` | uiDocument id |  |  | **Controls.** The rebinding screen (rebind actions; $flow.input lists the actions and their keys). |
| `screens.save` | uiDocument id |  |  | **Save.** Save slots (project saves; $flow.saves lists them). |
| `screens.load` | uiDocument id |  |  | **Load.** Load slots (project saves). |
| `simulate` | object |  |  | **While shown.** What runs under each screen: the engine pause (no steps), or the scripts outside behavior groups (physics and grouped scripts held) — a title or menu its scripts animate. |
| `simulate.title` | enum: `pause`, `scripts` | `"pause"` |  | **Title.** What runs while the title screen shows. (choices: `pause` = Pause, `scripts` = Scripts run) |
| `simulate.pause` | enum: `pause`, `scripts` | `"pause"` |  | **Pause.** What runs while the pause screen shows. (choices: `pause` = Pause, `scripts` = Scripts run) |
| `simulate.settings` | enum: `pause`, `scripts` | `"pause"` |  | **Settings.** What runs while the settings screen shows. (choices: `pause` = Pause, `scripts` = Scripts run) |
| `simulate.controls` | enum: `pause`, `scripts` | `"pause"` |  | **Controls.** What runs while the controls screen shows. (choices: `pause` = Pause, `scripts` = Scripts run) |
| `simulate.save` | enum: `pause`, `scripts` | `"pause"` |  | **Save.** What runs while the save screen shows. (choices: `pause` = Pause, `scripts` = Scripts run) |
| `simulate.load` | enum: `pause`, `scripts` | `"pause"` |  | **Load.** What runs while the load screen shows. (choices: `pause` = Pause, `scripts` = Scripts run) |
| `hud` | list of uiDocument id, ≤ 8 items, distinct |  |  | **HUD.** UI documents shown while the game plays (hidden behind the menus); bind to $flow.counters, $flow.health, $flow.prompts or script values. Up to 8. |
| `scenes` | list of objects |  |  | **Scene list.** The game's scenes in order, each with the spawn a kept player arrives at when it loads. Next scene (deprecated) moves along it. |
| `scenes[].scene` | scene id |  |  | **Scene.** A scene of the project. (required) |
| `scenes[].spawn` | object id (with `playerSpawn`), any scene |  |  | **Spawn.** The player spawn the character starts at (in that scene; absent: it stays where it is). |
| `scenes[].fade` | number |  | 0 – 5, step 0.05 | **Fade.** Seconds the view fades out before a move to this scene and back in after it (absent or 0: no fade; the previous scene stays in view until this one is drawn). |
| `scenes[].fadeColor` | color |  |  | **Fade colour.** The colour the view fades to (absent: black). |
| `pause` | bool | `true` |  | **Pause allowed.** The pause input opens the pause screen. |
| `status` | bool | `false` |  | **Status line.** A small debug line: the shell screen, the listed scene and the input prompts. |

<a id="content-eventCues"></a>
## eventCues — Event sounds

Sounds the game plays when a signal is sent or an event happens (a trigger entered, something collected, damaged, touched…), by name.

- In every project: no
- Written by: [`setEventCues`](ops-detail.md#op-setEventCues)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `eventCues` | list of objects | `[]` |  | **Event sounds.** One row per signal or event that plays a sound. |
| `eventCues[].on` | enum: `signal`, `event` | `"signal"` |  | **On.** A signal (by its name) or an event scripts see in ctx.events (by its type: enter, exit, collected, damaged, died, contact…, or an animator clip event's name). (required) |
| `eventCues[].name` | string, 1–64 chars | `"trigger"` |  | **Name.** The signal's name, or the event's type or name. (required) |
| `eventCues[].entity` | object id, any scene |  |  | **Object.** Only this object's events (absent: any object's). (applies when `on` is `event`) |
| `eventCues[].assetId` | asset id (audio) |  |  | **Sound.** The audio asset played. (required) |
| `eventCues[].volume` | number | `1` | 0 – 1, step 0.05 | **Volume.** How loud (0–1). |
| `eventCues[].bus` | enum: `sfx`, `music`, `voice`, `ui` | `"sfx"` |  | **Bus.** The mixer bus it plays on. |
| `eventCues[].maxLateMs` | int | `500` | 0 – 60000, step 1, ms | **Late by at most.** When its file is not loaded yet, it still starts this long after the event; later it is dropped. |

<a id="content-uiThemes"></a>
## uiThemes — UI themes

Named styles and icons UI documents share.

- In every project: no
- Written by: [`setUiTheme`](ops-detail.md#op-setUiTheme), [`deleteUiTheme`](ops-detail.md#op-deleteUiTheme)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `uiThemes` | list of JSON: `UiTheme` ([UiTheme](types-u-w.md#type-ui-theme)) | `[]` |  | **UI themes.** The project's themes (each its own file). |

<a id="content-dialogues"></a>
## dialogues — Dialogues

Conversations: node graphs of lines (speaker, expression, text, voice clip), choices, conditions and effects, signals and jumps.

- In every project: no
- Written by: [`setDialogue`](ops-detail.md#op-setDialogue), [`deleteDialogue`](ops-detail.md#op-deleteDialogue), [`graphEdit`](ops-detail.md#op-graphEdit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `dialogues` | list of JSON: `DialogueDocument` ([DialogueDocument](types-d-p.md#type-dialogue-document)) | `[]` |  | **Dialogues.** The project's conversations (each its own file). |

<a id="content-speakers"></a>
## speakers — Speakers

Who speaks in conversations: name, name-plate colour, portraits per expression, voice profile, text blip.

- In every project: no
- Written by: [`setSpeaker`](ops-detail.md#op-setSpeaker), [`deleteSpeaker`](ops-detail.md#op-deleteSpeaker)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `speakers` | list of JSON: `DialogueSpeaker` ([DialogueSpeaker](types-d-p.md#type-dialogue-speaker)) | `[]` |  | **Speakers.** The project's speakers. |

<a id="content-dialogueSettings"></a>
## dialogueSettings — Dialogue settings

Text speed, auto-advance and its delay, the music/SFX duck under a voice, the backlog length, the dialogue UI document and theme.

- In every project: no
- Written by: [`setDialogueSettings`](ops-detail.md#op-setDialogueSettings)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `value` | JSON: `DialogueSettings` ([DialogueSettings](types-d-p.md#type-dialogue-settings)) |  |  | **Dialogue settings.** { textSpeed? (chars/s, 0 instant), autoAdvance?, autoDelay? (s), duck? (0–1), backlog? (1–100), document? (uiDocumentId), theme? (uiThemeId), voiceMaxLateMs? (ms a voice whose file is not loaded may still start late; 1000) }. (written by a tool) |

<a id="content-timelines"></a>
## timelines — Timelines

Sequences of camera cuts, moves, animation, sound, dialogue, effects, signals and fades on a time ruler, played by scripts or signals.

- In every project: no
- Written by: [`setTimeline`](ops-detail.md#op-setTimeline), [`deleteTimeline`](ops-detail.md#op-deleteTimeline)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `timelines` | list of JSON: `TimelineAsset` ([TimelineAsset](types-p-t.md#type-timeline-asset)) | `[]` |  | **Timelines.** The project's timelines (each its own file). |

<a id="content-graphs"></a>
## graphs — Graphs

Standalone node graphs, edited in the graph editor.

- In every project: no
- Written by: [`setGraph`](ops-detail.md#op-setGraph), [`deleteGraph`](ops-detail.md#op-deleteGraph), [`graphEdit`](ops-detail.md#op-graphEdit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `graphs` | list of JSON: `GraphDocument` ([GraphDocument](types-d-p.md#type-graph-document)) | `[]` |  | **Graphs.** The project's graphs (each its own file). |

<a id="content-tags"></a>
## tags — Tags

Named tag bits objects carry.

- In every project: no
- Written by: [`setTags`](ops-detail.md#op-setTags)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `tags` | list of objects, ≤ 32 items | `[]` |  | **Tags.** Up to 32 tags. |
| `tags[].bit` | int |  | 0 – 31, step 1 | **Bit.** The bit (0–31). (required) |
| `tags[].name` | string, identifier, 1–32 chars |  |  | **Name.** A letter, then letters, digits, _ or - (unique ignoring case). (required; format identifier) |

<a id="content-loadable"></a>
## loadable — Loadable resources

The resources (prefabs, materials, dialogue, …) a script may load by address or label; Play and export ship them even when no scene uses them.

- In every project: no
- Written by: [`setLabels`](ops-detail.md#op-setLabels), [`setAddress`](ops-detail.md#op-setAddress)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `loadable` | list of objects | `[]` |  | **Loadable resources.** One entry per resource with an address or labels. |
| `loadable[].kind` | enum: `prefab`, `behavior`, `material`, `animator`, `graph`, `effect`, `library`, `ui`, `uitheme`, `dialogue`, `timeline`, `envpreset` | `"prefab"` |  | **Kind.** The resource kind. (required) |
| `loadable[].id` | string, id, 1–64 chars |  |  | **Id.** The resource id. (required; format id) |
| `loadable[].address` | string, 1–128 chars |  |  | **Address.** The one name a script loads it by (unique in the project). |
| `loadable[].labels` | list of string, 1–64 chars, ≥ 1 items, distinct |  |  | **Labels.** Names a script loads it by, with everything else carrying them (ascending). |

<a id="content-collisionLayers"></a>
## collisionLayers — Collision layers

Named collision layers colliders are in and script queries filter by (3D; "default" is implicit).

- In every project: no
- Written by: [`setCollisionLayers`](ops-detail.md#op-setCollisionLayers)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `collisionLayers` | list of string, identifier, 1–32 chars, ≤ 15 items, distinct | `[]` |  | **Collision layers.** Up to 15 names ("default" is implicit). |

<a id="content-lightLayers"></a>
## lightLayers — Light layers

Names of the light layers by number (editor labels: objects, lights and scripts use the layer masks).

- In every project: no
- Written by: [`setLightLayers`](ops-detail.md#op-setLightLayers)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `lightLayers` | list of string, ≤ 32 chars, ≤ 8 items | `[]` |  | **Light layers.** Up to 8 names, the first naming layer 1 ("" leaves one unnamed). |

<a id="content-saveSchema"></a>
## saveSchema — Project saves

The project save document (its version and migrations), the slot count, the engine state every save includes, the slot picture and the settings document the game writes.

- In every project: no
- Written by: [`setSaveSchema`](ops-detail.md#op-setSaveSchema)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `version` | int |  | 1 – 1000000, step 1 | **Version.** The save document's schema version (older saves are migrated on load). (required) |
| `slots` | int |  | 1 – 99, step 1 | **Slots.** Numbered save slots (engine limit 99). (required) |
| `migrations` | list of objects, ≤ 256 items |  |  | **Migrations.** For each older version, the script function (ctx.saves.migration) that upgrades a document by one version. |
| `migrations[]` | object |  |  | **Migration.** One upgrade step. (rules: one migration per version; from < version) |
| `migrations[].from` | int |  | ≥ 1, step 1 | **From version.** The version it upgrades from (to from + 1; below the schema version). (required) |
| `migrations[].name` | string, 1–64 chars |  |  | **Function.** The name a script registers with ctx.saves.migration. (required) |
| `sections` | list of enum: `grid`, `materials`, `spawned`, `storage`, `environment`, `dialogue`, `components`, `world`, ≤ 8 items |  |  | **Included state.** Engine state every save includes: block cells, material values, spawned objects, script storage, the environment blend, dialogue variables and seen lines, objects' health, collectibles, patrols and hitboxes, and where the play stands (world: the loaded scenes and the player's place, which a load moves the game to). |
| `legacyWorld` | bool | `true` |  | **Always save the world.** Without world in the sections, false keeps no world in a save (the game restores scenes and its player itself); absent or true keeps the deprecated always-on world. |
| `thumbnail` | object |  |  | **Slot picture.** The size and format of a slot's picture of the view (absent: 256 × 144 JPEG). |
| `thumbnail.width` | int |  | 16 – 512, step 1 | **Width.** Pixels. (required) |
| `thumbnail.height` | int |  | 16 – 512, step 1 | **Height.** Pixels. (required) |
| `thumbnail.format` | enum: `jpeg`, `webp` |  |  | **Format.** JPEG or WebP. (required) |
| `thumbnail.quality` | number |  | 0.1 – 1, step 0.05 | **Quality.** Encoder quality. |
| `settings` | list of JSON: `SettingsField` ([SettingsField](types-p-t.md#type-settings-field)), ≤ 64 items |  |  | **Settings document.** Up to 64 fields the game's settings screen writes (ctx.saves.setSetting): { key, type: bool\|number\|string\|enum, default, label?, min?, max?, values?, engine?: music\|sfx\|ui\|quality\|frameRateCap }. |
