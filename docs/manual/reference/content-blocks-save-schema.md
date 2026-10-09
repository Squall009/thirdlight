# Content documents (saveSchema to lighting)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

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
| `settings` | list of JSON: `SettingsField` ([SettingsField](types-p-w.md#type-settings-field)), ≤ 64 items |  |  | **Settings document.** Up to 64 fields the game's settings screen writes (ctx.saves.setSetting): { key, type: bool\|number\|string\|enum, default, label?, min?, max?, values?, engine?: music\|sfx\|ui\|quality\|frameRateCap }. |

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

<a id="content-behaviors"></a>
## behaviors — Behaviors

Published scripts and their declared properties.

- In every project: yes
- Written by: [`publishBehavior`](ops-detail.md#op-publishBehavior), [`deleteBehavior`](ops-detail.md#op-deleteBehavior)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `behaviors` | list of objects |  |  | **Behaviors.** The project's scripts (each its own file). (required) |
| `behaviors[].behaviorId` | string, id, 1–64 chars |  |  | **Id.** The stable behavior id. (required; written by a tool; format id) |
| `behaviors[].displayName` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers. (required; format name) |
| `behaviors[].declaration` | object |  |  | **Declaration.** The properties objects set. (required) |
| `behaviors[].declaration.properties` | list of objects |  |  | **Properties.** The declared properties (none or more; the declaration is at most 32768 bytes). (required) |
| `behaviors[].declaration.properties[]` | object |  |  | **Property.** A property the script declares (shown per object). (rules: min ≤ max; the default fits the type and its limits.) |
| `behaviors[].declaration.properties[].key` | string, identifier, 1–64 chars |  |  | **Key.** The property key the script reads (a lowercase letter, then lowercase letters, digits or _). (required; format identifier) |
| `behaviors[].declaration.properties[].label` | string, 1–64 chars |  |  | **Label.** Shown in the Inspector. (required) |
| `behaviors[].declaration.properties[].type` | enum: `number`, `boolean`, `string`, `enum`, `vec3`, `entityRef`, `assetRef` | `"number"` |  | **Type.** The value type. (required; choices: `number` = Number, `boolean` = Boolean, `string` = String, `enum` = Enum, `vec3` = Vector, `entityRef` = Object, `assetRef` = Asset) |
| `behaviors[].declaration.properties[].default` | JSON (typed by propertyType) |  |  | **Default.** The value when an object sets none (of the declared type). (required) |
| `behaviors[].declaration.properties[].min` | number |  | -1000000000000 – 1000000000000 | **Min.** Smallest number. (applies when `type` is `number`) |
| `behaviors[].declaration.properties[].max` | number |  | -1000000000000 – 1000000000000 | **Max.** Largest number. (applies when `type` is `number`) |
| `behaviors[].declaration.properties[].step` | number |  | > 0, ≤ 1000000 | **Step.** Increment of the number field. (applies when `type` is `number`) |
| `behaviors[].declaration.properties[].maxLength` | int | `256` | 1 – 1024, step 1 | **Max length.** Longest string (default 256). (applies when `type` is `string`) |
| `behaviors[].declaration.properties[].values` | list of string, 1–64 chars, 1–32 items, distinct |  |  | **Values.** 1–32 choices. (required; applies when `type` is `enum`) |
| `behaviors[].declaration.properties[].bounds` | object |  |  | **Bounds.** Per-axis limits of a vector. (applies when `type` is `vec3`; rules: min ≤ max per axis) |
| `behaviors[].declaration.properties[].bounds.min` | vec3 [x, y, z] |  | -1000000 – 1000000 | **Min.** Smallest per axis. (required) |
| `behaviors[].declaration.properties[].bounds.max` | vec3 [x, y, z] |  | -1000000 – 1000000 | **Max.** Largest per axis. (required) |
| `behaviors[].declaration.properties[].visibility` | enum: `public`, `private` | `"public"` |  | **Visibility.** Public: shown in the Inspector of every object with this script and set per object. Private: not shown, not settable; the script reads the default. |
| `behaviors[].declaration.properties[].group` | string, 1–64 chars |  |  | **Group.** The Inspector section the property is listed in. |
| `behaviors[].declaration.properties[].header` | string, 1–64 chars |  |  | **Header.** A heading shown above the property in the Inspector. |
| `behaviors[].declaration.properties[].tooltip` | string, 1–256 chars |  |  | **Tooltip.** The help shown when hovering the property. |
| `behaviors[].source` | JSON |  |  | **Source.** The compiled source record (written by the behavior build; none: declaration only). (required; may be null; written by a tool) |
| `behaviors[].publishedRevision` | int |  | ≥ 0, step 1 | **Published at.** The project revision it was published at. (required; written by a tool) |

<a id="content-behaviorTrust"></a>
## behaviorTrust — Script trust

Which script sources the owner acknowledged.

- In every project: yes
- Written by: [`acknowledgeBehaviorTrust`](ops-detail.md#op-acknowledgeBehaviorTrust), [`revokeBehaviorTrust`](ops-detail.md#op-revokeBehaviorTrust)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `entries` | list of JSON |  |  | **Entries.** Acknowledged source digests. (required; written by a tool) |

<a id="content-lighting"></a>
## lighting — Baked lighting

Each scene's lightmap bake (written by the baker).

- In every project: no
- Written by: [`setLighting`](ops-detail.md#op-setLighting)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `lighting` | map scene id → JSON: `LightingBake` ([LightingBake](types-d-p.md#type-lighting-bake)) |  |  | **Baked lighting.** Scene → its bake. (written by a tool) |
