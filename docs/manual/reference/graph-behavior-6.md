# Graph: Visual script (part 6, from Save storage (`api.saves.storage`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="node-behavior--api-saves-storage"></a>
### Save storage (`api.saves.storage`)

The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.

Outputs:

- `persisted` (boolean)
- `usage` (number)
- `quota` (number)

<a id="node-behavior--api-saves-play-seconds"></a>
### Play time (`api.saves.playSeconds`)

Play time in seconds (restored with a loaded save).

Outputs:

- `value` (number)

<a id="node-behavior--api-saves-setting"></a>
### Setting (`api.saves.setting`)

A value of the project settings document (its default until the player changes it).

Inputs:

- `key` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="node-behavior--api-saves-settings"></a>
### Settings document (`api.saves.settings`)

The whole project settings document (a copy).

Outputs:

- `value` (map)

<a id="node-behavior--api-saves-set-setting"></a>
### Set setting (`api.saves.setSetting`)

Change a value of the project settings document (kept in the player's browser; an engine setting it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.

Inputs:

- `in` "" (exec): takes several wires
- `key` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="graph-behavior--assets"></a>
## Assets

- Load assets (`api.assets.load`): Start loading the asset or resource with this id or address, or every one with this label. Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading' until the assets are ready, a later step.
- Release assets (`api.assets.release`): Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
- Assets state (`api.assets.state`): A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
- Assets ready (`api.assets.ready`): True once a handle's assets are loaded.
- Assets error (`api.assets.error`): Why a failed handle failed ('' otherwise).

<a id="node-behavior--api-assets-load"></a>
### Load assets (`api.assets.load`)

Start loading the asset or resource with this id or address, or every one with this label. Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading' until the assets are ready, a later step.

Inputs:

- `in` "" (exec): takes several wires
- `key` "id, address or label" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | id, address or label | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-assets-release"></a>
### Release assets (`api.assets.release`)

Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-assets-state"></a>
### Assets state (`api.assets.state`)

A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.

Inputs:

- `handle` (number)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-assets-ready"></a>
### Assets ready (`api.assets.ready`)

True once a handle's assets are loaded.

Inputs:

- `handle` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-assets-error"></a>
### Assets error (`api.assets.error`)

Why a failed handle failed ('' otherwise).

Inputs:

- `handle` (number)

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--ui"></a>
## UI

- Set UI value (`api.ui.set`): Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
- UI value (`api.ui.get`): The published value at a path (null when there is none).
- Clear UI value (`api.ui.clear`): Remove a path from the view model (`false` when it was not there).
- Show UI (`api.ui.show`): Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
- Hide UI (`api.ui.hide`): Hide a shown UI document (`false` when it was not shown).
- UI shown (`api.ui.isShown`): The document is shown.
- Play UI tween (`api.ui.play`): Play a tween of a document (on a widget, or the whole document). Presentation only.
- Focus UI widget (`api.ui.focus`): Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.
- UI view (`api.ui.view`): The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.
- UI events (`api.ui.events`): The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
- UI event (`api.ui.event`): The first UI event of this step with this name (a button's or an input's event), or null.

<a id="node-behavior--api-ui-set"></a>
### Set UI value (`api.ui.set`)

Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.

Inputs:

- `in` "" (exec): takes several wires
- `path` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `path` | path | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-get"></a>
### UI value (`api.ui.get`)

The published value at a path (null when there is none).

Inputs:

- `path` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `path` | path | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--api-ui-clear"></a>
### Clear UI value (`api.ui.clear`)

Remove a path from the view model (`false` when it was not there).

Inputs:

- `in` "" (exec): takes several wires
- `path` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `path` | path | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-show"></a>
### Show UI (`api.ui.show`)

Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)
- `layer` (number)
- `modal` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |
| `modal` | modal | boolean | `false` |  |

<a id="node-behavior--api-ui-hide"></a>
### Hide UI (`api.ui.hide`)

Hide a shown UI document (`false` when it was not shown).

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-is-shown"></a>
### UI shown (`api.ui.isShown`)

The document is shown.

Inputs:

- `docId` "document" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-play"></a>
### Play UI tween (`api.ui.play`)

Play a tween of a document (on a widget, or the whole document). Presentation only.

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)
- `tween` (string)
- `widgetId` "widget" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |
| `tween` | tween | string | `""` | ≤ 256 chars |
| `widgetId` | widget | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-focus"></a>
### Focus UI widget (`api.ui.focus`)

Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)
- `widgetId` "widget" (string)
- `index` "list item" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |
| `widgetId` | widget | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-view"></a>
### UI view (`api.ui.view`)

The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.

Outputs:

- `width` (number)
- `height` (number)
- `aspect` (number)
- `pixelRatio` "pixel ratio" (number)

<a id="node-behavior--api-ui-events"></a>
### UI events (`api.ui.events`)

The UI events of this step (clicks, submits, focus changes, shows and hides), in order.

Outputs:

- `value` (list)

<a id="node-behavior--api-ui-event"></a>
### UI event (`api.ui.event`)

The first UI event of this step with this name (a button's or an input's event), or null.

Inputs:

- `name` (string)

Outputs:

- `kind` (string)
- `doc` (string)
- `widget` (string)
- `name` (string)
- `value` (number): type from field `value_type`
- `index` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="graph-behavior--stats"></a>
## Stats

- Stats fps (`api.stats.fps`): Frames drawn per second over the window.
- Stats frame ms (`api.stats.frameMs`): The time from one frame to the next (ms).
- Stats cpu ms (`api.stats.cpuMs`): The page thread's work per frame (ms): the simulation's steps when it runs on the page, the frame's host work and the draw calls' submission.
- Stats gpu ms (`api.stats.gpuMs`): The GPU's time per frame (ms) from timestamp queries; null where the browser or GPU has none (not measured).
- Stats draw calls (`api.stats.drawCalls`): Draw calls of the last frame.
- Stats triangles (`api.stats.triangles`): Triangles of the last frame.
- Stats texture bytes (`api.stats.textureBytes`): Texture bytes resident on the GPU (streamed and fixed, images inside models included).
- Stats texture budget bytes (`api.stats.textureBudgetBytes`): The texture budget (bytes; the setting texture_budget_mb).
- Stats geometry bytes (`api.stats.geometryBytes`): Geometry bytes of the loaded models.
- Stats entities (`api.stats.entities`): Objects in the simulation.
- Stats quality (`api.stats.quality`): The quality level drawn: its id ("low", "medium", "high", or one of the project's own levels).
- Stats frame rate cap (`api.stats.frameRateCap`): The frame-rate cap the page draws under (30, 60 or 120 fps), or null for none (the display's rate).
- Stats occlusion (`api.stats.occlusion`): Occlusion culling in the last frame (the project's occlusion_culling setting, its quality level's).
- Stats window ms (`api.stats.windowMs`): The window the times are measured over (ms).

<a id="node-behavior--api-stats-fps"></a>
### Stats fps (`api.stats.fps`)

Frames drawn per second over the window.

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-frame-ms"></a>
### Stats frame ms (`api.stats.frameMs`)

The time from one frame to the next (ms).

Outputs:

- `avg` (number)
- `worst` (number)

<a id="node-behavior--api-stats-cpu-ms"></a>
### Stats cpu ms (`api.stats.cpuMs`)

The page thread's work per frame (ms): the simulation's steps when it runs on the page, the frame's host work and the draw calls' submission.

Outputs:

- `avg` (number)
- `worst` (number)

<a id="node-behavior--api-stats-gpu-ms"></a>
### Stats gpu ms (`api.stats.gpuMs`)

The GPU's time per frame (ms) from timestamp queries; null where the browser or GPU has none (not measured).

Outputs:

- `avg` (number)
- `worst` (number)
- `found` (boolean)

<a id="node-behavior--api-stats-draw-calls"></a>
### Stats draw calls (`api.stats.drawCalls`)

Draw calls of the last frame.

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-triangles"></a>
### Stats triangles (`api.stats.triangles`)

Triangles of the last frame.

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-texture-bytes"></a>
### Stats texture bytes (`api.stats.textureBytes`)

Texture bytes resident on the GPU (streamed and fixed, images inside models included).

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-texture-budget-bytes"></a>
### Stats texture budget bytes (`api.stats.textureBudgetBytes`)

The texture budget (bytes; the setting texture_budget_mb).

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-geometry-bytes"></a>
### Stats geometry bytes (`api.stats.geometryBytes`)

Geometry bytes of the loaded models.

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-entities"></a>
### Stats entities (`api.stats.entities`)

Objects in the simulation.

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-quality"></a>
### Stats quality (`api.stats.quality`)

The quality level drawn: its id ("low", "medium", "high", or one of the project's own levels).

Outputs:

- `value` (string)

<a id="node-behavior--api-stats-frame-rate-cap"></a>
### Stats frame rate cap (`api.stats.frameRateCap`)

The frame-rate cap the page draws under (30, 60 or 120 fps), or null for none (the display's rate).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-stats-occlusion"></a>
### Stats occlusion (`api.stats.occlusion`)

Occlusion culling in the last frame (the project's occlusion_culling setting, its quality level's).

Outputs:

- `path` (string)
- `tested` (number)
- `culled` (number)

<a id="node-behavior--api-stats-window-ms"></a>
### Stats window ms (`api.stats.windowMs`)

The window the times are measured over (ms).

Outputs:

- `value` (number)

<a id="graph-behavior--display"></a>
## Display

- Frame-rate cap (`api.display.frameRateCap`): The cap in frames per second (30, 60 or 120), or null for none (the display's rate).
- Set frame-rate cap (`api.display.setFrameRateCap`): Cap the frame rate at 30, 60 or 120 fps, or null (or 0) for none (the display's rate); false for any other value (nothing changes).

<a id="node-behavior--api-display-frame-rate-cap"></a>
### Frame-rate cap (`api.display.frameRateCap`)

The cap in frames per second (30, 60 or 120), or null for none (the display's rate).

Outputs:

- `value` (number)
- `found` (boolean)

<a id="node-behavior--api-display-set-frame-rate-cap"></a>
### Set frame-rate cap (`api.display.setFrameRateCap`)

Cap the frame rate at 30, 60 or 120 fps, or null (or 0) for none (the display's rate); false for any other value (nothing changes).

Inputs:

- `in` "" (exec): takes several wires
- `fps` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `fps` | fps | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--dialogue"></a>
## Dialogue

- Start dialogue (`api.dialogue.start`): Start a conversation (at its Start, a named entry, or any node); bindings are values its lines and conditions read as $name. Returns the conversation number, or 0 (unknown dialogue, entry or node, or one is running).
- Stop dialogue (`api.dialogue.stop`): End the running conversation.
- Dialogue running (`api.dialogue.isRunning`): A conversation is running (this one, when given).
- Dialogue state (`api.dialogue.current`): The conversation now (null when none).
- Advance dialogue (`api.dialogue.advance`): Advance: reveal the rest of the line, or go on after it.
- Choose option (`api.dialogue.choose`): Pick an option of the choice shown (0 = the first shown).
- Resume dialogue (`api.dialogue.resume`): Continue after a Signal node that waits.
- Set dialogue skip (`api.dialogue.setSkip`): Skip lines already seen (until an unseen line or a choice).
- Set dialogue auto (`api.dialogue.setAuto`): The player's auto-advance (null: the project's setting).
- Set text speed (`api.dialogue.setTextSpeed`): The player's text speed in characters per second (0: whole lines at once; null: the project's setting).
- Dialogue events (`api.dialogue.events`): The dialogue events of the previous step (line starts and ends, choices, picks, signals, starts and ends), in order.
- Dialogue event (`api.dialogue.event`): The first dialogue event of the previous step of this kind (and signal name), or null.
- Dialogue variable (`api.dialogue.get`): A dialogue variable (null when unset).
- Set dialogue variable (`api.dialogue.set`): Set a dialogue variable (conditions and effects read and write them); false for a bad name or value.
- Line seen (`api.dialogue.seen`): The line (or option) was seen: "dialogueId/nodeId".

<a id="node-behavior--api-dialogue-start"></a>
### Start dialogue (`api.dialogue.start`)

Start a conversation (at its Start, a named entry, or any node); bindings are values its lines and conditions read as $name. Returns the conversation number, or 0 (unknown dialogue, entry or node, or one is running).

Inputs:

- `in` "" (exec): takes several wires
- `dialogueId` "dialogue" (string)
- `entry` (string)
- `node` (string)
- `bindings` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `dialogueId` | dialogue | string | `""` | ≤ 256 chars |
| `entry` | entry | string | `""` | ≤ 256 chars |
| `node` | node | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-dialogue-stop"></a>
### Stop dialogue (`api.dialogue.stop`)

End the running conversation.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

<a id="node-behavior--api-dialogue-is-running"></a>
### Dialogue running (`api.dialogue.isRunning`)

A conversation is running (this one, when given).

Inputs:

- `conversation` (number)

Outputs:

- `value` (boolean)

<a id="node-behavior--api-dialogue-current"></a>
### Dialogue state (`api.dialogue.current`)

The conversation now (null when none).

Outputs:

- `conversation` (number)
- `dialogueId` "dialogue" (string)
- `nodeId` "node" (string)
- `kind` (string)
- `speaker` (string)
- `text` (string)
- `revealed` (number)
- `total` (number)
- `options` (list)
- `found` (boolean)

<a id="node-behavior--api-dialogue-advance"></a>
### Advance dialogue (`api.dialogue.advance`)

Advance: reveal the rest of the line, or go on after it.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

<a id="node-behavior--api-dialogue-choose"></a>
### Choose option (`api.dialogue.choose`)

Pick an option of the choice shown (0 = the first shown).

Inputs:

- `in` "" (exec): takes several wires
- `index` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `index` | index | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-dialogue-resume"></a>
### Resume dialogue (`api.dialogue.resume`)

Continue after a Signal node that waits.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

<a id="node-behavior--api-dialogue-set-skip"></a>
### Set dialogue skip (`api.dialogue.setSkip`)

Skip lines already seen (until an unseen line or a choice).

Inputs:

- `in` "" (exec): takes several wires
- `on` (boolean)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `on` | on | boolean | `false` |  |

<a id="node-behavior--api-dialogue-set-auto"></a>
### Set dialogue auto (`api.dialogue.setAuto`)

The player's auto-advance (null: the project's setting).

Inputs:

- `in` "" (exec): takes several wires
- `on` (boolean)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `on` | on | boolean | `false` |  |

<a id="node-behavior--api-dialogue-set-text-speed"></a>
### Set text speed (`api.dialogue.setTextSpeed`)

The player's text speed in characters per second (0: whole lines at once; null: the project's setting).

Inputs:

- `in` "" (exec): takes several wires
- `charsPerSecond` "chars per second" (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `charsPerSecond` | chars per second | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-dialogue-events"></a>
### Dialogue events (`api.dialogue.events`)

The dialogue events of the previous step (line starts and ends, choices, picks, signals, starts and ends), in order.

Outputs:

- `value` (list)

<a id="node-behavior--api-dialogue-event"></a>
### Dialogue event (`api.dialogue.event`)

The first dialogue event of the previous step of this kind (and signal name), or null.

Inputs:

- `name` (string)

Outputs:

- `kind` (string)
- `conversation` (number)
- `dialogueId` "dialogue" (string)
- `nodeId` "node" (string)
- `speaker` (string)
- `text` (string)
- `name` (string)
- `value` (string)
- `index` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `kind` | kind | enum | `"start"` | `start`, `lineStart`, `lineEnd`, `choice`, `chosen`, `signal`, `end` |
| `name` | name | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-dialogue-get"></a>
### Dialogue variable (`api.dialogue.get`)

A dialogue variable (null when unset).

Inputs:

- `name` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="node-behavior--api-dialogue-set"></a>
### Set dialogue variable (`api.dialogue.set`)

Set a dialogue variable (conditions and effects read and write them); false for a bad name or value.

Inputs:

- `in` "" (exec): takes several wires
- `name` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-dialogue-seen"></a>
### Line seen (`api.dialogue.seen`)

The line (or option) was seen: "dialogueId/nodeId".

Inputs:

- `key` (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |

<a id="graph-behavior--modes"></a>
## Modes

- Current mode (`api.modes.current`): The current game mode ('' when the project has none).
- Previous mode (`api.modes.previous`): The mode before the current one ('' at the start of a run).
- Mode is (`api.modes.is`): The current mode is this one.
- Switch mode (`api.modes.switch`): Switch to a game mode at the next step (its input maps, camera, UI documents and ticking groups together; no scene load). `false` for a mode the project does not have or a bad transition.
- Mode events (`api.modes.events`): This step's enter and exit events (the step a switch applied in), in order.
- Mode entered (`api.modes.entered`): A mode was entered this step (this one, or any when empty).
- Mode exited (`api.modes.exited`): A mode ended this step (this one, or any when empty).
- Time in mode (`api.modes.time`): Seconds since the current mode was entered.

<a id="node-behavior--api-modes-current"></a>
### Current mode (`api.modes.current`)

The current game mode ('' when the project has none).

Outputs:

- `value` (string)

<a id="node-behavior--api-modes-previous"></a>
### Previous mode (`api.modes.previous`)

The mode before the current one ('' at the start of a run).

Outputs:

- `value` (string)

<a id="node-behavior--api-modes-is"></a>
### Mode is (`api.modes.is`)

The current mode is this one.

Inputs:

- `modeId` "mode" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `modeId` | mode | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-modes-switch"></a>
### Switch mode (`api.modes.switch`)

Switch to a game mode at the next step (its input maps, camera, UI documents and ticking groups together; no scene load). `false` for a mode the project does not have or a bad transition.

Inputs:

- `in` "" (exec): takes several wires
- `modeId` "mode" (string)
- `blendTime` "blend time" (number)
- `fade` (string)
- `fadeTime` "fade time" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `modeId` | mode | string | `""` | ≤ 256 chars |
| `blend` | blend | enum | `"cut"` | `cut`, `linear`, `eased` |
| `fade` | fade | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-modes-events"></a>
### Mode events (`api.modes.events`)

This step's enter and exit events (the step a switch applied in), in order.

Outputs:

- `value` (list)

<a id="node-behavior--api-modes-entered"></a>
### Mode entered (`api.modes.entered`)

A mode was entered this step (this one, or any when empty).

Inputs:

- `modeId` "mode" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `modeId` | mode | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-modes-exited"></a>
### Mode exited (`api.modes.exited`)

A mode ended this step (this one, or any when empty).

Inputs:

- `modeId` "mode" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `modeId` | mode | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-modes-time"></a>
### Time in mode (`api.modes.time`)

Seconds since the current mode was entered.

Outputs:

- `value` (number)

<a id="graph-behavior--lifecycle"></a>
## Lifecycle

- Respawn player (`api.lifecycle.respawn`): Move a player character (a controller's object: `entityId`, absent: the first player controller) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). In 3D applied after this step's intent phase (a later phase: the next step); on the 2D plane at the next step boundary. `false` without that character or for an unknown spawn. An empty entity means this object.
- Set spawn point (`api.lifecycle.setSpawn`): Make a player spawn (an object with the Player spawn component) the one respawn uses.
- Spawn point (`api.lifecycle.spawnPoint`): The active player spawn ('' when there is none: respawn then uses where the player started).
- Restart run (deprecated) (`api.lifecycle.restart`): Deprecated: the engine does not know what a run restart is. Restarts the run at the next step (scenes, objects, scripts, cameras, UI and the start mode as at the start) and writes one Problems line per Play; reload scenes with `ctx.scenes.reload` and reset what the game keeps itself.

<a id="node-behavior--api-lifecycle-respawn"></a>
### Respawn player (`api.lifecycle.respawn`)

Move a player character (a controller's object: `entityId`, absent: the first player controller) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). In 3D applied after this step's intent phase (a later phase: the next step); on the 2D plane at the next step boundary. `false` without that character or for an unknown spawn. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `spawnId` "spawn" (string)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `spawnId` | spawn | string | `""` | ≤ 256 chars |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-lifecycle-set-spawn"></a>
### Set spawn point (`api.lifecycle.setSpawn`)

Make a player spawn (an object with the Player spawn component) the one respawn uses.

Inputs:

- `in` "" (exec): takes several wires
- `spawnId` "spawn" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `spawnId` | spawn | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-lifecycle-spawn-point"></a>
### Spawn point (`api.lifecycle.spawnPoint`)

The active player spawn ('' when there is none: respawn then uses where the player started).

Outputs:

- `value` (string)

<a id="node-behavior--api-lifecycle-restart"></a>
### Restart run (deprecated) (`api.lifecycle.restart`)

Deprecated: the engine does not know what a run restart is. Restarts the run at the next step (scenes, objects, scripts, cameras, UI and the start mode as at the start) and writes one Problems line per Play; reload scenes with `ctx.scenes.reload` and reset what the game keeps itself.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

<a id="graph-behavior--timeline"></a>
## Timeline

- Play timeline (`api.timeline.play`): Play a timeline, binding its slots to objects (`{ slot: entityId }`; unbound slots use the timeline's defaults). Returns its handle (0 when refused: no such timeline, or 8 already playing).
- Pause timeline (`api.timeline.pause`): Pause a playing timeline (it holds its current state).
- Resume timeline (`api.timeline.resume`): Resume a paused timeline.
- Stop timeline (`api.timeline.stop`): Stop a timeline where it is (no end states: the sounds and effects it started stop, the cameras go back).
- Skip timeline (`api.timeline.skip`): Skip to the end: every track's end state at once (cameras, transforms, music, activation; remaining signals fire unless a key says drop).
- Seek timeline (`api.timeline.seek`): Jump to a time (seconds): the moves, fades and cameras there; keys in between do not fire.
- Timeline state (`api.timeline.state`): A play's state: playing, paused, waiting (for input or a dialogue), ended (recently), or null.
- Timeline time (`api.timeline.time`): A play's time in seconds (counted in fixed steps).
- Timeline playing (`api.timeline.isPlaying`): Whether any play of this timeline is running.
- Timeline ended (`api.timeline.ended`): True in the step after a play ended (finished, skipped or stopped).
- Timeline marker (`api.timeline.marker`): True in the step after a marker with this name was reached (of the play `handle`, or of any play when 0).

<a id="node-behavior--api-timeline-play"></a>
### Play timeline (`api.timeline.play`)

Play a timeline, binding its slots to objects (`{ slot: entityId }`; unbound slots use the timeline's defaults). Returns its handle (0 when refused: no such timeline, or 8 already playing).

Inputs:

- `in` "" (exec): takes several wires
- `timelineId` "timeline" (string)
- `bindings` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `timelineId` | timeline | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-timeline-pause"></a>
### Pause timeline (`api.timeline.pause`)

Pause a playing timeline (it holds its current state).

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-resume"></a>
### Resume timeline (`api.timeline.resume`)

Resume a paused timeline.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-stop"></a>
### Stop timeline (`api.timeline.stop`)

Stop a timeline where it is (no end states: the sounds and effects it started stop, the cameras go back).

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-skip"></a>
### Skip timeline (`api.timeline.skip`)

Skip to the end: every track's end state at once (cameras, transforms, music, activation; remaining signals fire unless a key says drop).

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-seek"></a>
### Seek timeline (`api.timeline.seek`)

Jump to a time (seconds): the moves, fades and cameras there; keys in between do not fire.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |
| `seconds` | seconds | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-state"></a>
### Timeline state (`api.timeline.state`)

A play's state: playing, paused, waiting (for input or a dialogue), ended (recently), or null.

Inputs:

- `handle` (number)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-time"></a>
### Timeline time (`api.timeline.time`)

A play's time in seconds (counted in fixed steps).

Inputs:

- `handle` (number)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-is-playing"></a>
### Timeline playing (`api.timeline.isPlaying`)

Whether any play of this timeline is running.

Inputs:

- `timelineId` "timeline" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `timelineId` | timeline | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-timeline-ended"></a>
### Timeline ended (`api.timeline.ended`)

True in the step after a play ended (finished, skipped or stopped).

Inputs:

- `handle` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timeline-marker"></a>
### Timeline marker (`api.timeline.marker`)

True in the step after a marker with this name was reached (of the play `handle`, or of any play when 0).

Inputs:

- `name` (string)
- `handle` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--environment"></a>
## Environment

- Set environment (`api.environment.set`): Switch to a preset ('' = the base look), blending over `blend` seconds from the look now (an interrupted blend continues from where it is). False when there is no such preset or an option is refused.
- Blend environments (`api.environment.blend`): Hold a mix of two presets: t = 0 shows a, 1 shows b (a timeline or a script drives t; '' = the base look). Stops a running blend.
- Environment state (`api.environment.state`): The preset the last change went to ('' = the base look), how far its blend is (0–1) and whether one is running.
- Environment weight (`api.environment.weight`): How much of a preset is in the look now (0–1; '' = the base look).
- Environment presets (`api.environment.presets`): The project's environment preset ids.

<a id="node-behavior--api-environment-set"></a>
### Set environment (`api.environment.set`)

Switch to a preset ('' = the base look), blending over `blend` seconds from the look now (an interrupted blend continues from where it is). False when there is no such preset or an option is refused.

Inputs:

- `in` "" (exec): takes several wires
- `presetId` "preset" (string)
- `blend` "blend (seconds)" (number)
- `override` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `presetId` | preset | string | `""` | ≤ 256 chars |
| `easing` | easing | enum | `"linear"` | `linear`, `easeIn`, `easeOut`, `easeInOut` |

<a id="node-behavior--api-environment-blend"></a>
### Blend environments (`api.environment.blend`)

Hold a mix of two presets: t = 0 shows a, 1 shows b (a timeline or a script drives t; '' = the base look). Stops a running blend.

Inputs:

- `in` "" (exec): takes several wires
- `a` (string)
- `b` (string)
- `t` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `a` | a | string | `""` | ≤ 256 chars |
| `b` | b | string | `""` | ≤ 256 chars |
| `t` | t | number | `0.5` | -1000000000 – 1000000000 |

<a id="node-behavior--api-environment-state"></a>
### Environment state (`api.environment.state`)

The preset the last change went to ('' = the base look), how far its blend is (0–1) and whether one is running.

Outputs:

- `target` (string)
- `progress` (number)
- `blending` (boolean)

<a id="node-behavior--api-environment-weight"></a>
### Environment weight (`api.environment.weight`)

How much of a preset is in the look now (0–1; '' = the base look).

Inputs:

- `presetId` "preset" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `presetId` | preset | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-environment-presets"></a>
### Environment presets (`api.environment.presets`)

The project's environment preset ids.

Outputs:

- `value` (list)

<a id="graph-behavior--entity"></a>
## Entity

- Get component (`api.entity.get`): A read-only snapshot of a component's script-readable fields as they stood at the start of the step (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the object has no such component (`'materialParams'`: when it wears no graph material with public parameters). A component scripts cannot read throws. An empty entity means this object.
- Set component (`api.entity.set`): Write fields of a component, applied at the end of the step (in script order; a later write of the same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`, transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: An empty entity means this object.

<a id="node-behavior--api-entity-get"></a>
### Get component (`api.entity.get`)

A read-only snapshot of a component's script-readable fields as they stood at the start of the step (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the object has no such component (`'materialParams'`: when it wears no graph material with public parameters). A component scripts cannot read throws. An empty entity means this object.

Inputs:

- `entityId` "object" (string)
- `component` (string)

Outputs:

- `value` (map)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `component` | component | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-entity-set"></a>
### Set component (`api.entity.set`)

Write fields of a component, applied at the end of the step (in script order; a later write of the same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`, transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `component` (string)
- `patch` (map)

Outputs:

- `then` "" (exec): one wire
- `ok` (boolean)
- `field` (string)
- `code` (string)
- `message` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `component` | component | string | `""` | ≤ 256 chars |

<a id="graph-behavior--shell"></a>
## Shell

- Next scene (deprecated) (`api.shell.nextScene`): Deprecated (one Problems line per Play): moves to the next entry of the shell's scene list at the next step boundary, as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the entry's scene loads, the character arrives at its spawn). False when the list has no next entry; a second call in the same step asks for the same move.
- Scene list entry (deprecated) (`api.shell.sceneIndex`): Deprecated (one Problems line per Play): the scene list entry the run is at (-1: none); only the list's own moves change it.
- Scene list length (deprecated) (`api.shell.sceneCount`): Deprecated (one Problems line per Play): how many entries the shell's scene list has (0: none).

<a id="node-behavior--api-shell-next-scene"></a>
### Next scene (deprecated) (`api.shell.nextScene`)

Deprecated (one Problems line per Play): moves to the next entry of the shell's scene list at the next step boundary, as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the entry's scene loads, the character arrives at its spawn). False when the list has no next entry; a second call in the same step asks for the same move.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

<a id="node-behavior--api-shell-scene-index"></a>
### Scene list entry (deprecated) (`api.shell.sceneIndex`)

Deprecated (one Problems line per Play): the scene list entry the run is at (-1: none); only the list's own moves change it.

Outputs:

- `value` (number)

<a id="node-behavior--api-shell-scene-count"></a>
### Scene list length (deprecated) (`api.shell.sceneCount`)

Deprecated (one Problems line per Play): how many entries the shell's scene list has (0: none).

Outputs:

- `value` (number)
