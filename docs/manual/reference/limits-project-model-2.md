# Limits and defaults: project-model (part 2, from `model-lod.ts`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/project-model` defines, by source file. Values are the running build's.

<a id="limits-project-model--model-lod"></a>
## `model-lod.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-instance-density-end-default"></a>`INSTANCE_DENSITY_END_DEFAULT` | `0.005` |  |
| <a id="limit-instance-density-min-default"></a>`INSTANCE_DENSITY_MIN_DEFAULT` | `1` | The share kept where copies are smallest when a set does not set it: all (no thinning). |
| <a id="limit-instance-density-min-new"></a>`INSTANCE_DENSITY_MIN_NEW` | `0.25` | The share new instance sets are made with (the scatter dialog writes it into the component). |
| <a id="limit-instance-density-start-default"></a>`INSTANCE_DENSITY_START_DEFAULT` | `0.02` | Instance-set density falloff: full density down to 2 % of the screen height, a quarter of the copies at 0.5 % and smaller. A 0.5 m grass tuft starts thinning at ~27 m and reaches a quarter at ~107 m; a 6 m tree at ~320 m — so near and mid ground look the same and only what is a few pixels across thins. A set that does not set `densityMin` draws every copy (sets made before thinning existed keep their look); new sets are made with {@link INSTANCE_DENSITY_MIN_NEW} written out. |
| <a id="limit-lod-bias-default"></a>`LOD_BIAS_DEFAULT` | `1` | The project's LOD bias: 1 = the models' own switch points. |
| <a id="limit-lod-bias-max"></a>`LOD_BIAS_MAX` | `4` |  |
| <a id="limit-lod-bias-min"></a>`LOD_BIAS_MIN` | `0.25` |  |
| <a id="limit-lod-cull-size-default"></a>`LOD_CULL_SIZE_DEFAULT` | `0` | No culling: a model is drawn however small it is (the default). |
| <a id="limit-lod-hysteresis-default"></a>`LOD_HYSTERESIS_DEFAULT` | `0.1` | The project's LOD hysteresis: a tenth. A model standing still at a switch point does not flicker with the camera's sway, and a level shown one step coarser for 10 % of the switch distance is not noticed. |
| <a id="limit-lod-hysteresis-max"></a>`LOD_HYSTERESIS_MAX` | `0.5` |  |
| <a id="limit-lod-screen-sizes-default"></a>`LOD_SCREEN_SIZES_DEFAULT` | `[0.08,0.03,0.012,0.005]` | The screen sizes where levels 1, 2, 3, 4 take over (8 %, 3 %, 1.2 %, 0.5 % of the screen height); a model with more levels switches its later ones at the last. They were the engine-wide switch points before models had their own. |
| <a id="limit-lod-screen-sizes-max"></a>`LOD_SCREEN_SIZES_MAX` | `8` | Most switch points a model's settings may list (levels beyond use the last). |
| <a id="limit-mesh-lod-ratios-default"></a>`MESH_LOD_RATIOS_DEFAULT` | `[0.5,0.25,0.125]` | The triangle shares of the levels 1, 2, 3 the "generate LODs" import setting makes for a model without authored levels: each half the one before, as the default screen sizes roughly halve from level to level. |

<a id="limits-project-model--model-rig"></a>
## `model-rig.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-model-rig-limits"></a>`MODEL_RIG_LIMITS` | `{"nodes":4096,"clips":64,"keyNumbers":262144}` | Engine limits of a rig as data. Nodes and clips match the importer's caps (4,096 nodes, 64 clips). Key numbers (times + values of every channel) bound what one model adds to a play/export manifest: 262,144 numbers is about 3 MB of JSON — a character with 60 bones × 12 clips × 3 channels of 30 keys fits with room; clips past the limit are left out and the rig is marked `truncated` (a socket on it then warns once in the play log). The budget is per model (its animation-only files included), never shared across the project, so a game's hundredth character is read like its first. |

<a id="limits-project-model--modes"></a>
## `modes.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-mode-defaults"></a>`MODE_DEFAULTS` | `{"ungrouped":"tick","pause":true,"timeScale":1,"physics":"run","fadeTime":0.5}` | Defaults, with their genre-neutral reasons. |
| <a id="limit-mode-limits"></a>`MODE_LIMITS` | `{"modes":16,"inputMaps":8,"ui":16,"groups":32,"behaviorGroups":32,"nameLength":64,"timeScaleMin":0.1,"timeScaleMax":4,"blendTimeMax":30,"fadeTimeMin":0.05,"fadeTimeMax":10}` | Engine limits (documented; they protect the runtime and keep a whole list inside one 64 KiB command). |

<a id="limits-project-model--paint-brush"></a>
## `paint-brush.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-paint-brush-limits"></a>`PAINT_BRUSH_LIMITS` | `{"radiusMin":0.25,"radiusMax":64,"strengthMax":1}` | The brush's size (in the target's units, e.g. cells) and strength (the blend per dab at the centre, 0–1). |

<a id="limits-project-model--png-decode"></a>
## `png-decode.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-png-decode-max-pixels"></a>`PNG_DECODE_MAX_PIXELS` | `1048576` | At most this many pixels (a 1024 × 1024 map): an engine limit. |

<a id="limits-project-model--probe-grids"></a>
## `probe-grids.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-default-probe-bounces"></a>`DEFAULT_PROBE_BOUNCES` | `2` | Default extra bounce passes of a probe bake. |
| <a id="limit-default-probe-spacing"></a>`DEFAULT_PROBE_SPACING` | `2` | Default horizontal distance between probes (meters). |
| <a id="limit-max-probe-bounces"></a>`MAX_PROBE_BOUNCES` | `8` |  |
| <a id="limit-probe-spacing-max"></a>`PROBE_SPACING_MAX` | `32` |  |
| <a id="limit-probe-spacing-min"></a>`PROBE_SPACING_MIN` | `0.25` | The spacings a bake or a volume may ask for (meters). |

<a id="limits-project-model--quality-levels"></a>
## `quality-levels.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-default-quality-levels"></a>`DEFAULT_QUALITY_LEVELS` | `[{"id":"low","name":"Low","post":{"bloom":{"enabled":false},"ssao":{"enabled":false},"dof":{"enabled":false},"antialias":"none"},"msaa":0},{"id":"medium","name":"Medium","post":{"ssao":{"enabled":false},"dof":{"enabled":false}}},{"id":"high","name":"High"}]` | The engine's levels, for a project that lists none: low draws no bloom, ambient occlusion, depth of field or anti-aliasing (no MSAA either); medium drops ambient occlusion and depth of field; high draws the look as authored. |
| <a id="limit-pixel-ratio-cap-max"></a>`PIXEL_RATIO_CAP_MAX` | `2` |  |
| <a id="limit-pixel-ratio-cap-min"></a>`PIXEL_RATIO_CAP_MIN` | `1` | The range of a level's pixel-ratio cap. Below 1 the render scale is the knob (it upscales with FSR 1); above 2 a HiDPI display draws four times the pixels of a 1080p one for a difference few players see. |

<a id="limits-project-model--render-settings"></a>
## `render-settings.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-ambient-occlusion-default"></a>`AMBIENT_OCCLUSION_DEFAULT` | `"gtao"` | The kind a project that does not set `ambient_occlusion` draws: GTAO, the only kind before the setting existed, so an existing game keeps its look. |
| <a id="limit-render-scale-default"></a>`RENDER_SCALE_DEFAULT` | `1` |  |
| <a id="limit-render-scale-max"></a>`RENDER_SCALE_MAX` | `1` |  |
| <a id="limit-render-scale-min"></a>`RENDER_SCALE_MIN` | `0.5` | The render scale's range. Below half the resolution FSR 1 can no longer rebuild edges (AMD's lowest preset, "performance", is 0.5); 1 is the screen's own resolution (the render pixel ratio's cap still applies). |
| <a id="limit-render-settings-default"></a>`RENDER_SETTINGS_DEFAULT` | `{"ambientOcclusion":"gtao","renderScale":1,"dynamicResolution":false}` |  |

<a id="limits-project-model--save-schema"></a>
## `save-schema.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-save-limits"></a>`SAVE_LIMITS` | `{"slots":99,"documentBytes":1048576,"thumbnailBytes":65536,"thumbnailSide":512,"settingsFields":64,"settingsText":256,"migrations":256,"version":1000000,"metaText":128,"metaBytes":4096,"metaKeyChars":32}` | Engine limits of project saves (documented in docs/manual/features/saves.md). |
| <a id="limit-save-thumbnail-default"></a>`SAVE_THUMBNAIL_DEFAULT` | `{"width":256,"height":144,"format":"jpeg","quality":0.8}` | Defaults (genre-neutral): a 16:9 picture small enough for a slot list, JPEG (every browser encodes it). |
| <a id="limit-script-save-limits"></a>`SCRIPT_SAVE_LIMITS` | `{"keys":64,"valueChars":4096}` | A script's `ctx.save` store (and a play's injected variables, which fill it): keys, and a value's JSON characters. |

<a id="limits-project-model--scatter"></a>
## `scatter.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-scatter-bake-max-candidates"></a>`SCATTER_BAKE_MAX_CANDIDATES` | `33554432` | Candidates one command may look at (a per-request bound like the brushes' dabs: a bake of a large area at a high density is split by area or belongs in ground cover, which is never stored). |
| <a id="limit-scatter-chunk-meters-default"></a>`SCATTER_CHUNK_METERS_DEFAULT` | `2048` | The chunk size (m) a scatter rule's copies are drawn in when it sets none: few draws, culled inside each (view-cull). |
| <a id="limit-scatter-cover-distance-default"></a>`SCATTER_COVER_DISTANCE_DEFAULT` | `40` | How far (m) ground cover reaches from the camera when its rule says nothing. |
| <a id="limit-scatter-limits"></a>`SCATTER_LIMITS` | `{"idLength":32,"density":{"min":0.0001,"max":100},"spacingMax":100,"scale":{"min":0.01,"max":100},"sinkMax":100,"regionName":64,"coverDistance":{"min":1,"max":1000},"shadowDistance":{"min":1,"max":10000},"blobShadow":{"min":0.05,"max":100},"impostorSize":{"min":0.0001,"max":1}}` | Bounds of a rule's values (dimensions of a value, not counts). |

<a id="limits-project-model--scene-v3"></a>
## `scene-v3.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-directional-shadow-defaults"></a>`DIRECTIONAL_SHADOW_DEFAULTS` | `{"mapSize":1024,"bias":-0.0005,"normalBias":0.02,"extent":24}` |  |
| <a id="limit-directional-shadow-limits"></a>`DIRECTIONAL_SHADOW_LIMITS` | `{"mapSizes":[512,1024,2048,4096],"bias":{"min":-0.01,"max":0.01},"normalBias":{"min":0,"max":1},"extent":{"min":1,"max":64}}` | The directional light's shadow settings (data; absent = the defaults, three-adapter `DIRECTIONAL_SHADOW_DEFAULTS` holds the same values): - map size 1024²: over the default 48 m square a texel is 4.7 cm, a crisp shadow for a person-size object in a side, top-down or third-person view, at a quarter of the memory of 2048²; WebGL 2 guarantees 2048, WebGPU 8192 (4096 is the cap: the largest map worth its memory on common GPUs). - bias -0.0005: half a thousandth of the shadow depth range removes acne on surfaces facing the light without lifting the shadow off its caster. - normal bias 0.02 m: about half a texel at the defaults — removes the stripes on surfaces at a grazing angle (curved models, instance sets). - extent 24 m (half the side of the square that follows the camera in a v4 game): the previous engine constant, room for a screen of any common genre; a v3 game's level bounds decide its square instead. |
| <a id="limit-max-emissive-intensity"></a>`MAX_EMISSIVE_INTENSITY` | `4` |  |
| <a id="limit-max-entities-v4"></a>`MAX_ENTITIES_V4` | `16384` | The v4 per-scene entity cap: a scene is one load unit (a big world is several scenes loaded together; instance sets hold dense detail). |
| <a id="limit-max-intensity"></a>`MAX_INTENSITY` | `8` |  |

<a id="limits-project-model--script-libraries"></a>
## `script-libraries.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-script-library-limits"></a>`SCRIPT_LIBRARY_LIMITS` | `{"files":16,"fileBytes":65536,"containerBytes":262144,"nameChars":64}` | Bounds. A library has a behavior source's bounds (16 files, 64 KiB per file, 256 KiB per container — the compiler's limits). A project has as many libraries as it needs: each is its own file and its own module. |

<a id="limits-project-model--shell"></a>
## `shell.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-shell-limits"></a>`SHELL_LIMITS` | `{"hud":8}` | Engine limits: HUD documents shown together (drawn at once over the game). The scene list is as long as the game. |

<a id="limits-project-model--sockets"></a>
## `sockets.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-socket-attach-limits"></a>`SOCKET_ATTACH_LIMITS` | `{"nodeName":128,"offset":10000,"scaleMin":0.001,"scaleMax":1000}` | Engine limits: node names as a GLB stores them (at most 128 characters); offsets within 10 km of the node (a socket is on or near its model); a scale 0.001–1000 per axis (a positive scale — the pose stays a rotation and scale, never a mirror or a collapse). |

<a id="limits-project-model--spline"></a>
## `spline.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-spline-falloff-default"></a>`SPLINE_FALLOFF_DEFAULT` | `4` | Metres past the half width over which a carve, flatten or paint fades out. |
| <a id="limit-spline-limits"></a>`SPLINE_LIMITS` | `{"minPoints":2,"maxPoints":4096,"coordinate":100000,"widthMax":1000,"rollMax":89,"distanceMax":1000,"profilePoints":64,"pieces":16}` | The bounds of one spline's values (per request: the 64 KiB command bounds a spline's points first). |
| <a id="limit-spline-mesh-step-default"></a>`SPLINE_MESH_STEP_DEFAULT` | `1` | Metres between the cross-sections of a spline's mesh (its finest level). |
| <a id="limit-spline-scatter-margin-default"></a>`SPLINE_SCATTER_MARGIN_DEFAULT` | `1` | Metres past the half width kept clear of scatter. |
| <a id="limit-spline-surface-offset-default"></a>`SPLINE_SURFACE_OFFSET_DEFAULT` | `0.05` | Metres a surface mesh sits above its points (above ground the spline flattened to them). |
| <a id="limit-spline-water-flow-default"></a>`SPLINE_WATER_FLOW_DEFAULT` | `1` | A river's flow along the spline (m/s) and how far its foam reaches in from each bank (m). |
| <a id="limit-spline-water-foam-default"></a>`SPLINE_WATER_FOAM_DEFAULT` | `1.5` |  |
| <a id="limit-spline-width-default"></a>`SPLINE_WIDTH_DEFAULT` | `4` | A point without a width of its own, and a spline without `width`, is this wide (m): a lane and its verges. |

<a id="limits-project-model--surface-rules"></a>
## `surface-rules.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-surface-rule-limits"></a>`SURFACE_RULE_LIMITS` | `{"value":100000,"cavityRadiusMax":64,"noiseScaleMin":0.01,"noiseScaleMax":100000}` | Bounds of the values a rule holds (dimensions of a value, not counts). |

<a id="limits-project-model--terrain-blocks"></a>
## `terrain-blocks.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-terrain-blocks-blend-default"></a>`TERRAIN_BLOCKS_BLEND_DEFAULT` | `8` | Metres over which the ground outside a footprint fades from the border's height and paint to its own, when absent. |
| <a id="limit-terrain-blocks-blend-limits"></a>`TERRAIN_BLOCKS_BLEND_LIMITS` | `{"min":0,"max":256}` |  |

<a id="limits-project-model--terrain-edit"></a>
## `terrain-edit.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-terrain-brush-limits"></a>`TERRAIN_BRUSH_LIMITS` | `{"dabs":1024,"radiusMax":2048,"heightStrengthMax":1000,"noiseScaleMax":10000,"samples":16777216}` | Per-request bounds of one stroke (they protect a single request, like the block edit bounds; nothing here caps a terrain): dabs, the brush, and the samples all its dabs may cover together. |

<a id="limits-project-model--terrain-erosion"></a>
## `terrain-erosion.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-erosion-limits"></a>`EROSION_LIMITS` | `{"droplets":[0,8],"erosion":[0,1],"deposition":[0,1],"capacity":[0,64],"evaporation":[0,0.5],"inertia":[0,0.95],"lifetime":[1,256],"radius":[1,8],"iterations":[1,1000],"talus":[1,89],"amount":[0,1]}` | Each setting's range ([min, max]; `open` mins exclude the bound). |
| <a id="limit-erosion-max-samples"></a>`EROSION_MAX_SAMPLES` | `4198401` | A per-request bound on the samples one run erodes (2,049² — eight 257-sample tiles a side): not a terrain size. |
| <a id="limit-hydraulic-defaults"></a>`HYDRAULIC_DEFAULTS` | `{"droplets":0.5,"erosion":0.3,"deposition":0.3,"capacity":4,"evaporation":0.01,"inertia":0.05,"lifetime":30,"radius":3}` |  |
| <a id="limit-thermal-defaults"></a>`THERMAL_DEFAULTS` | `{"iterations":40,"talus":35,"amount":0.5}` |  |

<a id="limits-project-model--terrain-import"></a>
## `terrain-import.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-heightmap-max-samples"></a>`HEIGHTMAP_MAX_SAMPLES` | `67125249` | The most samples one heightmap import reads (8,193²): a per-request bound on memory, not a terrain size. |

<a id="limits-project-model--terrain-layers"></a>
## `terrain-layers.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-terrain-stamp-falloff-default"></a>`TERRAIN_STAMP_FALLOFF_DEFAULT` | `0.15` | The stamp's edge fade when absent. |
| <a id="limit-terrain-stamp-size-limits"></a>`TERRAIN_STAMP_SIZE_LIMITS` | `{"min":0.5,"max":100000}` | Metres a stamp's side may span. |

<a id="limits-project-model--terrain-sizes"></a>
## `terrain-sizes.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-terrain-layer-max"></a>`TERRAIN_LAYER_MAX` | `255` | The most material layers a terrain can index (one byte per index). |

<a id="limits-project-model--terrain"></a>
## `terrain.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-terrain-height-limit"></a>`TERRAIN_HEIGHT_LIMIT` | `100000` | The farthest a height range reaches (metres either way). |
| <a id="limit-terrain-lod-distance-limits"></a>`TERRAIN_LOD_DISTANCE_LIMITS` | `{"min":1,"max":100000}` | Metres a terrain's finest level reaches from the camera (each coarser level twice as far): the renderer's level-of-detail distance. Absent: the nearest the renderer allows for the tile size, which is also the floor a smaller value is raised to (its levels must stay within one of their neighbours' to meet without cracks). |
| <a id="limit-terrain-macro-distance-limits"></a>`TERRAIN_MACRO_DISTANCE_LIMITS` | `{"min":1,"max":100000}` | Metres from the camera past which the terrain draws each tile's macro texture (its look baked from above, albedo and normal) instead of its layer stack: two texture reads instead of the material's. |
| <a id="limit-terrain-spacing-limits"></a>`TERRAIN_SPACING_LIMITS` | `{"min":0.05,"max":64}` | Metres between samples. |
| <a id="limit-terrain-tile-coord-max"></a>`TERRAIN_TILE_COORD_MAX` | `4096` | The tile coordinates a terrain may use (either way): a dimension of the grid, not a count — 4,096 tiles of 1,025 samples at 64 m reach far past any view distance. |
| <a id="limit-terrain-tile-samples-default"></a>`TERRAIN_TILE_SAMPLES_DEFAULT` | `257` | A new terrain's tile size: 256 m tiles at 1 m spacing. |

<a id="limits-project-model--texture-streaming"></a>
## `texture-streaming.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-texture-budget-default-mb"></a>`TEXTURE_BUDGET_DEFAULT_MB` | `512` | The texture budget a project gets unless its settings name one (MiB). Unity's default streaming budget is 512 MB; a mid-range laptop (an integrated GPU sharing 8–16 GiB with the system, as the Iris Xe this engine is measured on) holds that beside the browser, the page and the game's geometry with room to spare. |
| <a id="limit-texture-budget-max-mb"></a>`TEXTURE_BUDGET_MAX_MB` | `65536` | The largest: more than any browser GPU process holds. |
| <a id="limit-texture-budget-min-mb"></a>`TEXTURE_BUDGET_MIN_MB` | `1` | The smallest budget a project may set (a test of the budget, a tiny page); the tails always stay. |
| <a id="limit-texture-streaming-default-above-px"></a>`TEXTURE_STREAMING_DEFAULT_ABOVE_PX` | `1024` | Streaming is on by default above this longer edge: a 1024² texture's whole chain is 1.3 MiB as BC7 (0.7 as BC1), too little to be worth the requests. |

<a id="limits-project-model--timelines"></a>
## `timelines.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-timeline-limits"></a>`TIMELINE_LIMITS` | `{"tracks":32,"keys":256,"slots":16,"markers":64,"duration":600,"bytes":49152,"nameChars":128,"playing":8,"params":16}` | Engine limits of timelines (documented in docs/manual/features/timelines.md). |

<a id="limits-project-model--trim-sheet"></a>
## `trim-sheet.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-trim-density-max"></a>`TRIM_DENSITY_MAX` | `65536` |  |
| <a id="limit-trim-density-min"></a>`TRIM_DENSITY_MIN` | `1` | Texel density bounds (pixels per metre). |
| <a id="limit-trim-padding-max"></a>`TRIM_PADDING_MAX` | `256` | The most padding a row may declare (pixels). |
| <a id="limit-trim-sheet-defaults"></a>`TRIM_SHEET_DEFAULTS` | `{"size":[1024,1024],"texelDensity":256,"padding":8}` | A new sheet's values: 1024², 256 px/m (a 4 m wide strip), 8 px of padding (the Texture Designer's gutter). |
| <a id="limit-trim-sheet-size-max"></a>`TRIM_SHEET_SIZE_MAX` | `4096` | The largest sheet side (pixels): a sheet's textures are textures, so their import limit is the sheet's (a larger table would validate and then name pixels no texture of it can have). |

<a id="limits-project-model--types-v3"></a>
## `types-v3.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-instances"></a>`MAX_INSTANCES` | `65536` | Most copies in one instance set. |
| <a id="limit-max-tags"></a>`MAX_TAGS` | `32` | At most this many tags per project: one per bit of the 32-bit tag mask queries filter by. |
| <a id="limit-scene-limits-v3"></a>`SCENE_LIMITS_V3` | `{"playerSpawns":16,"lightsDirectional":1,"lightsAmbient":1,"entities":1024,"audioVersions":8,"animationProfileBytes":4096}` | The v3/v4 scene limit values (contract material: fixtures reference them). |

<a id="limits-project-model--ui-documents"></a>
## `ui-documents.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-ui-limits"></a>`UI_LIMITS` | `{"documentBytes":49152,"widgets":512,"depth":16,"children":128,"styles":64,"tweens":32,"icons":64,"textChars":1024,"nameChars":64,"bindPathChars":128,"listItems":256,"layer":100,"px":16384,"degrees":3600}` |  |

<a id="limits-project-model--validate"></a>
## `validate.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-entity-depth"></a>`MAX_ENTITY_DEPTH` | `32` | The deepest an entity may sit in a scene's hierarchy (the root is depth 1). |
| <a id="limit-max-len"></a>`MAX_LEN` | `1000000` |  |
| <a id="limit-max-revision"></a>`MAX_REVISION` | `9007199254740991` |  |
| <a id="limit-name-max"></a>`NAME_MAX` | `128` |  |
| <a id="limit-name-min"></a>`NAME_MIN` | `1` |  |

<a id="limits-project-model--world-streaming"></a>
## `world-streaming.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-streaming-budget-default-mb"></a>`STREAMING_BUDGET_DEFAULT_MB` | `768` | The memory streamed world cells may take on the page (MiB): decoded terrain tiles and their texture layers, block chunks' meshes. The default holds the render rings of an 8 km landscape of 512 m tiles and a 1 km block area many times over beside the texture budget on a laptop sharing 8–16 GiB with its integrated GPU; a ring that holds more is reported. |
| <a id="limit-streaming-budget-max-mb"></a>`STREAMING_BUDGET_MAX_MB` | `65536` |  |
| <a id="limit-streaming-budget-min-mb"></a>`STREAMING_BUDGET_MIN_MB` | `1` |  |
| <a id="limit-streaming-radius-limits"></a>`STREAMING_RADIUS_LIMITS` | `{"min":1,"max":100000}` | A ring's radius and a hysteresis (metres). |
