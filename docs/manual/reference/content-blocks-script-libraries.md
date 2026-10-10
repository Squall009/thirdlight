# Content documents (scriptLibraries to prefabs)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

<a id="content-scriptLibraries"></a>
## scriptLibraries — Script libraries

Shared TypeScript and JSON modules every script can import as @lib/<id>.

- In every project: no
- Written by: [`setScriptLibrary`](ops-detail.md#op-setScriptLibrary), [`deleteScriptLibrary`](ops-detail.md#op-deleteScriptLibrary)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `scriptLibraries` | list of JSON: `ScriptLibrary` ([ScriptLibrary](types-p-u.md#type-script-library)) | `[]` |  | **Script libraries.** The project's libraries (each its own file). |

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
| `blockTypes[].variants` | JSON: `BlockVariant[]` ([BlockVariant](types-a-d.md#type-block-variant)) |  |  | **Looks.** 1–8 weighted looks: {model: {assetId, piece?}} \| {prefab} \| {color: "#rrggbb"}, each with an optional weight (a cell without a variant picks one by weight, stably by position) and an optional uv ("model" \| "world") of its own. (required) |
| `blockTypes[].uv` | enum: `model`, `world` | `"model"` |  | **Texture mapping.** Where the looks' texture coordinates come from. Model: the model's own (a coloured stand-in, or a model part without any, is mapped to the world). World: from the block's place in the layer, in metres, one flat projection per face (tops from above, walls from the side, slopes past 45° as walls), so a texture runs on across cells without a seam; a material's tiling sets how many metres one repeat covers. A look may set its own. (choices: `model` = Model, `world` = World (metres)) |
| `blockTypes[].shape` | enum: `full`, `half`, `ramp`, `stairs`, `custom`, `none` |  |  | **Collision shape.** The collision shape (and the coloured stand-in's shape): full, half, ramp, stairs (rising toward +Z), custom boxes or none. (required) |
| `blockTypes[].boxes` | JSON |  |  | **Custom boxes.** 1–8 boxes [x0, y0, z0, x1, y1, z1] in footprint units (0–1). (required; applies when `shape` is `custom`) |
| `blockTypes[].solid` | bool |  |  | **Solid.** Fills its cell and hides the faces of neighbours touching it (absent: a full shape is solid). |
| `blockTypes[].footprint` | vec3 [x, y, z] | `[1,1,1]` | 1 – 8, step 1 | **Footprint.** Cells along x, y and z (a 2 × 1 × 2 well); the cells it covers stay empty. |
| `blockTypes[].rotations` | JSON |  |  | **Rotations.** The allowed rotations in degrees: a set of 0, 90, 180, 270 (absent: all). |
| `blockTypes[].metadata` | JSON |  |  | **Default metadata.** Cell metadata every cell of this block starts with (field key → value). |
| `blockTypes[].materials` | map materialSlot → material id, 1–32 entries |  |  | **Materials.** Material slot → project material: a model look's source material name, or "*" for every slot (a coloured stand-in has one: "*" gives it a material, e.g. a painted terrain material). |
| `blockTypes[].live` | bool |  |  | **Live.** In the running game each cell showing a prefab look spawns that prefab as real objects (scripts, movers, lights, children), placed, removed and saved with the cell; the root's model stays merged with the blocks. |
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
| `blockTypes[].kits` | map id → object, ≥ 1 entries |  |  | **Kits.** What the block shows under each kit (a burnt, ruined or winter set): a layer, or a region of it, that shows the kit draws this block type instead, without changing the cells. The target keeps the layout: the same placement and footprint. A kit is every block's entry under one name. |
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

<a id="content-uiDocuments"></a>
## uiDocuments — UI documents

HUDs, menus and screens drawn by the game over the view (widget trees bound to script values).

- In every project: no
- Written by: [`setUiDocument`](ops-detail.md#op-setUiDocument), [`deleteUiDocument`](ops-detail.md#op-deleteUiDocument)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `uiDocuments` | list of JSON: `UiDocument` ([UiDocument](types-p-u.md#type-ui-document)) | `[]` |  | **UI documents.** The project's documents (each its own file). |

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

The menus around the game and its HUD, drawn with the project's UI documents: a title before play, pause, settings, controls (rebinding) and the save and load screens (project saves), the HUD shown while playing, and the game's scenes in order for New game and Next scene.

- In every project: no
- Written by: [`setShell`](ops-detail.md#op-setShell)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `screens` | object |  |  | **Screens.** The UI document drawn for each shell screen. Its buttons use the engine actions: resume, continue, back, open a screen, save or load a slot, set a setting, rebind, next scene, load, unload or reload a scene. |
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
| `scenes` | list of objects |  |  | **Scene list.** The game's scenes in order, each with the spawn it starts at: Next scene moves on to the next. |
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
| `uiThemes` | list of JSON: `UiTheme` ([UiTheme](types-p-u.md#type-ui-theme)) | `[]` |  | **UI themes.** The project's themes (each its own file). |

<a id="content-dialogues"></a>
## dialogues — Dialogues

Conversations: node graphs of lines (speaker, expression, text, voice clip), choices, conditions and effects, signals and jumps.

- In every project: no
- Written by: [`setDialogue`](ops-detail.md#op-setDialogue), [`deleteDialogue`](ops-detail.md#op-deleteDialogue), [`graphEdit`](ops-detail.md#op-graphEdit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `dialogues` | list of JSON: `DialogueDocument` ([DialogueDocument](types-a-d.md#type-dialogue-document)) | `[]` |  | **Dialogues.** The project's conversations (each its own file). |

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
| `timelines` | list of JSON: `TimelineAsset` ([TimelineAsset](types-p-u.md#type-timeline-asset)) | `[]` |  | **Timelines.** The project's timelines (each its own file). |

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
| `settings` | list of JSON: `SettingsField` ([SettingsField](types-p-u.md#type-settings-field)), ≤ 64 items |  |  | **Settings document.** Up to 64 fields the game's settings screen writes (ctx.saves.setSetting): { key, type: bool\|number\|string\|enum, default, label?, min?, max?, values?, engine?: music\|sfx\|ui\|quality\|frameRateCap }. |

<a id="content-settings"></a>
## settings — Gameplay settings

Gravity, run speed, jump, slopes, and the engine settings (step rate, sound voices, music fade, animation blend).

- In every project: yes
- Written by: [`setSettings`](ops-detail.md#op-setSettings)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `gravity_y` | number | `-19.62` | -100 – -1, step 0.1, m/s² | **Gravity.** gravity_y (m/s^2). |
| `run_speed` | number | `4` | > 0, ≤ 50, step 0.1, m/s | **Run speed.** run_speed (m/s). |
| `jump_velocity` | number | `7` | 0 – 50, step 0.1, m/s | **Jump velocity.** jump_velocity (m/s). |
| `max_fall_speed` | number | `-30` | ≥ -100, < 0, step 0.1, m/s | **Max fall speed.** max_fall_speed (m/s). |
| `max_slope_climb_deg` | number | `45` | 0 – 89.9, step 0.1, deg | **Max slope climb.** max_slope_climb_deg (degrees). |
| `min_slope_slide_deg` | number | `30` | 0 – 89.9, step 0.1, deg | **Min slope slide.** min_slope_slide_deg (degrees). |
| `fixed_step_hz` | int (one of 60, 120, 240) | `120` | step 1, Hz | **Fixed step.** Simulation steps per second (60, 120 or 240). Timings in seconds keep their length; replays are recorded at one rate. |
| `audio_voices` | int | `8` | 1 – 32, step 1, voices | **Sound voices.** How many sound effects play at once (a new one is dropped while all are busy; at most 32). |
| `music_fade_s` | number | `1` | 0 – 10, step 0.1, s | **Music fade.** Seconds a music change crossfades (0: cut). |
| `animation_crossfade_s` | number | `0.2` | 0 – 2, step 0.1, s | **Animation blend.** Seconds a model blends between its idle, run and airborne animations (animator transitions set their own). |
| `render_backend` | int (one of 1 = Auto (WebGPU, else WebGL 2), 2 = WebGPU, 3 = WebGL 2) | `1` | step 1 | **Renderer.** Which backend draws the game and the Scene view: WebGPU where the browser has it (else WebGL 2), WebGPU, or WebGL 2. WebGPU needs https or localhost. A page URL flag ?renderer=auto\|webgpu\|webgl2 overrides it. |
| `physics_dimension` | int (one of 2 = 2D plane, 3 = 3D) | `2` | step 1 | **Physics.** The simulation's dimension: a 2D plane (movement and collision in X and Y, colliders rotate about Z) or full 3D (colliders with depth and any rotation). A 3D project needs every box collider to have a depth. |
| `sim_thread` | int (one of 1 = Worker (off the main thread), 2 = Main thread) | `1` | step 1 | **Simulation thread.** Where the game simulation (physics, gameplay, scripts) runs in Play and the export: a worker (the page thread only draws and reads input) or the page's main thread. Results are identical. A page URL flag ?threads=off\|on overrides it. |
| `debug_console` | int (one of 0 = Off, 1 = On) | `0` | step 1 | **Debug console in export.** Whether an exported game has the debug console (the ` key: the project's debug commands). Play always has it. Leave it off for a release build. |
| `random_seed` | int | `0` | 0 – 4294967295, step 1 | **Random seed.** The seed of the scripts' random numbers (ctx.random) and of animators' random start times: the same seed gives the same numbers in every run, replay and export; change it to get a different, still repeatable, sequence (0 to 4294967295). |
| `depth_buffer` | int (one of 1 = Standard, 2 = Logarithmic (far vistas), 3 = Reversed Z (far vistas)) | `1` | step 1 | **Depth precision.** How depth is stored: standard, logarithmic or reversed Z. The last two keep close objects sharp while scenery kilometres away still draws in the right order (pair with a large camera far plane). Reversed Z needs WebGPU or a WebGL 2 browser with EXT_clip_control (else standard). |
| `instance_chunk_m` | number | `32` | 1 – 4096, step 0.1, m | **Instance chunk size.** Instance sets are drawn in square chunks of about this size (m), each hidden when out of view. Smaller: finer culling, more draw calls. A set can set its own. |
| `audio_spatial` | int (one of 0 = Automatic (2D: by distance to the player, 3D: panned), 1 = By distance to the player (X), 2 = Panned (listener on the camera)) | `0` | step 1 | **Audio sources.** How audio sources are heard: by their X distance to the player (the 2D default, no panning) or through a panner with the listener on the active camera (the 3D default: left/right panning and each source's distance model). Script sounds with a position are always panned. |
| `texture_budget_mb` | int | `512` | 1 – 65536, step 1, MiB | **Texture budget.** GPU memory (MiB) for textures in Play and the export. Streamed textures (large KTX2 textures; per texture in its import settings) load the detail their size on screen needs inside it; when it is full, the least-needed detail is dropped first. |
| `camera_fov_deg` | number | `60` | 1 – 179, step 0.1, deg | **Field of view.** The vertical field of view of every camera that does not set its own (and of the view while no camera is live). |
| `camera_near_m` | number | `0.1` | 0.001 – 100000, step 0.1, m | **Near plane.** Nothing closer than this is drawn, for every camera that does not set its own near plane. |
| `camera_far_m` | number | `100` | 0.01 – 10000000, step 0.1, m | **Far plane.** Nothing farther than this is drawn, for every camera that does not set its own far plane (beyond the near plane). |
| `import_extract_textures` | int (one of 0 = New models, 1 = Every model (older imports too)) | `0` | step 1 | **Extract model textures.** Which models have the images inside their files taken out into compressed (KTX2) texture assets they share: new imports only, or every model — older imports are then extracted where their GLB file is, and Problems lists any model still holding images. |
| `block_chunk_storage` | int (one of 0 = JSON text, 1 = Binary) | `0` | step 1 | **Block chunk files.** Block-layer cells as JSON text (a diff shows each column) or compressed binary (smaller, faster). A change rewrites every chunk file; both open. |
| `stats_overlay` | int (one of 0 = Off, 1 = Shown (F3 hides it), 2 = Hidden until F3) | `0` | step 1 | **Stats overlay.** A small box over the game with fps, frame, CPU and GPU times (average and worst), draw calls, triangles, texture memory against the budget, geometry, objects and the quality level, in Play and the export. F3 shows and hides it when on. Scripts read the same numbers in ctx.stats, UI documents in $flow.stats. |
| `frame_rate_cap` | int (one of 0 = None (the display's rate), 30 = 30 fps, 60 = 60 fps, 120 = 120 fps) | `0` | step 1 | **Frame-rate cap.** The most frames per second Play and the export draw (none: the display's rate). Game time is unaffected: the simulation keeps its fixed step. A player's settings field bound to frameRateCap, the UI action setSetting frameRateCap and scripts (ctx.display.setFrameRateCap) change it while the game runs; a page URL flag ?frameRateCap=30\|60\|120\|none overrides it. |
| `lod_bias` | number | `1` | 0.25 – 4, step 0.1, × | **LOD bias.** Scales where every model switches to its coarser levels and stops being drawn: 2 keeps each level twice as far, 0.5 switches at half the distance (cheaper). Each model sets its own switch points in its import settings. |
| `lod_hysteresis` | number | `0.1` | 0 – 0.5, step 0.1 | **LOD hysteresis.** A model switches back to its finer level only this share of the switch distance closer than where it switched, so one standing at a switch point does not flicker. |
| `ambient_occlusion` | int (one of 0 = Off, 1 = SSAO (fast, half resolution), 2 = GTAO (quality)) | `2` | step 1 | **Ambient occlusion.** The kind of ambient occlusion drawn where a scene's look turns it on (Post → Ambient occlusion). It darkens only the indirect light (ambient, sky and probe light, and per-vertex local light) in creases and corners, never the sun or per-pixel lamps. SSAO is the fast one new projects start with; GTAO is darker and more exact, at about twice the cost, and what a project draws when it does not set this. A player's settings field bound to ambientOcclusion overrides it. |
| `render_scale` | number | `1` | 0.5 – 1, step 0.1, × | **Render scale.** The share of the screen's resolution Play and the export draw the 3D view at (0.5–1), upscaled to the screen with AMD FSR 1 (edge-adaptive upscaling and sharpening). 0.75 draws about half the pixels. The Scene view always draws at full resolution. A player's settings field bound to renderScale overrides it. |
| `dynamic_resolution` | int (one of 0 = Off, 1 = On) | `0` | step 1 | **Dynamic resolution.** Lowers the render scale (down to 0.5) while the GPU takes longer than a frame (the frame-rate cap, else 60 fps) and raises it again, up to the render scale, when it has room. It changes slowly and waits longer after a change that did not hold, so it does not flicker. A player's settings field bound to dynamicResolution overrides it. |
| `streaming_budget_mb` | int | `768` | 1 – 65536, step 1, MiB | **Streaming budget.** Memory (MiB) the streamed terrain tiles and block chunks (those with Streaming rings) may take in Play and the export: tiles and chunks kept past their rings are let go first when it is full. Rings that alone need more are reported as a problem, never cut. |
| `architecture_ship_meshes` | int (one of 0 = Generate at load, 1 = Ship generated meshes) | `0` | step 1 | **Generated architecture.** Exports ship generated architecture as its parameters and the game generates the meshes when a scene loads (small, fast on a worker), or also ship the meshes the same generator made (larger download, nothing to generate). |

<a id="content-scenes"></a>
## scenes — Scenes

The project's scenes.

- In every project: yes
- Written by: [`createScene`](ops-detail.md#op-createScene), [`renameScene`](ops-detail.md#op-renameScene), [`deleteScene`](ops-detail.md#op-deleteScene)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `scenes` | list of objects, ≥ 1 items |  |  | **Scenes.** At least one scene. (required) |
| `scenes[].sceneId` | string, id, 1–64 chars |  |  | **Id.** The stable scene id. (required; written by a tool; format id) |
| `scenes[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the scene list. (required; format name) |

<a id="content-startScenes"></a>
## startScenes — Start scenes

The scenes loaded when the game starts (without a flow).

- In every project: yes
- Written by: [`setStartScenes`](ops-detail.md#op-setStartScenes)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `startScenes` | list of scene id, ≥ 1 items, distinct |  |  | **Start scenes.** At least one scene. (required) |

<a id="content-assets"></a>
## assets — Assets

Imported models, audio, textures and fonts (their versions are written by the importer).

- In every project: yes
- Written by: [`publishAsset`](ops-detail.md#op-publishAsset), [`setAssetOptions`](ops-detail.md#op-setAssetOptions), [`deleteAsset`](ops-detail.md#op-deleteAsset), [`importAssets`](ops-detail.md#op-importAssets), [`setLabels`](ops-detail.md#op-setLabels), [`setAddress`](ops-detail.md#op-setAddress)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `assets` | list of objects |  |  | **Assets.** The asset catalog. (required) |
| `assets[].assetId` | string, id, 1–64 chars |  |  | **Id.** The stable asset id. (required; written by a tool; format id) |
| `assets[].kind` | enum: `model`, `audio`, `texture`, `font` |  |  | **Kind.** Model, audio, texture or font. (required; written by a tool) |
| `assets[].displayName` | string, name, 1–128 chars |  |  | **Name.** Shown in the asset browser. (required; written by a tool; format name) |
| `assets[].currentVersion` | int |  | ≥ 1, step 1 | **Version.** The current version (the last). (required; written by a tool) |
| `assets[].versions` | list of JSON, ≥ 1 items |  |  | **Versions.** Every imported version (append-only, written by the importer). (required; written by a tool) |
| `assets[].vertexColors` | enum: `data`, `tint` | `"data"` |  | **Vertex colours.** Data: COLOR_0 feeds shaders (wind weights). Tint: multiplies the colour. (applies when `kind` is `model`; stored only when not the default) |
| `assets[].materials` | map materialSlot → material id, 1–32 entries |  |  | **Default materials.** Material slot → project material, for every placement. (applies when `kind` is `model`) |
| `assets[].extractTextures` | bool | `false` |  | **Extract textures.** Import setting: the file's images become texture assets the model draws with (they count and stream like any texture). Set when the model is imported or re-imported. (applies when `kind` is `model`; stored only when not the default; written by a tool) |
| `assets[].textures` | map key → asset id (texture), 1–64 entries |  |  | **Extracted textures.** The file's image index → the texture asset it was extracted into (written by the importer). (applies when `kind` is `model`) |
| `assets[].clipsFor` | asset id (model) |  |  | **Clips for.** An animation-only file: its clips play on this model's rig. (applies when `kind` is `model`) |
| `assets[].labels` | list of string, 1–64 chars, ≥ 1 items, distinct |  |  | **Labels.** Names a script may load the asset by, with every other asset carrying them (ascending; set with setLabels). (written by a tool) |
| `assets[].address` | string, 1–128 chars |  |  | **Address.** The one name a script may load the asset by (unique in the project; set with setAddress). (written by a tool) |

<a id="content-prefabs"></a>
## prefabs — Prefabs

Captured object groups placed as independent copies.

- In every project: yes
- Written by: [`createPrefab`](ops-detail.md#op-createPrefab), [`instantiatePrefab`](ops-detail.md#op-instantiatePrefab), [`deletePrefab`](ops-detail.md#op-deletePrefab)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `prefabs` | list of objects |  |  | **Prefabs.** The project's prefabs (each its own file). (required) |
| `prefabs[].prefabId` | string, id, 1–64 chars |  |  | **Id.** The stable prefab id. (required; written by a tool; format id) |
| `prefabs[].displayName` | string, name, 1–128 chars |  |  | **Name.** Shown in the prefab list. (required; written by a tool; format name) |
| `prefabs[].createdRevision` | int |  | ≥ 0, step 1 | **Created at.** The project revision it was captured at. (required; written by a tool) |
| `prefabs[].entityCount` | int |  | 1 – 1024, step 1 | **Objects.** How many objects it holds (derived). (required; written by a tool) |
| `prefabs[].depth` | int |  | ≥ 1, step 1 | **Depth.** Hierarchy depth (derived). (required; written by a tool) |
| `prefabs[].entities` | list of objects, 1–1024 items |  |  | **Objects.** 1–1024 objects, parents first. (required; written by a tool) |
| `prefabs[].entities[].localId` | string, id, 1–64 chars |  |  | **Local id.** The id inside the prefab. (required; written by a tool; format id) |
| `prefabs[].entities[].name` | string, name, 1–128 chars |  |  | **Name.** The object name. (written by a tool; format name) |
| `prefabs[].entities[].parentLocalId` | string, id, 1–64 chars |  |  | **Parent.** The parent inside the prefab (none: a root). (may be null; written by a tool; format id) |
| `prefabs[].entities[].components` | components (23 kinds) |  |  | **Components.** The prefab component vocabulary. (required; written by a tool; allowed: `transform`, `model`, `box`, `behavior`, `collider`, `surface`, `materials`, `animator`, `mover`, `trigger`, `switch`, `audioSource`, `faceMovement`, `materialParams`, `effect`, `blockFootprint`, `behaviorGroup`, `health`, `collectible`, `patrol`, `hitbox`, `climbVolume`, `gravity`) |
