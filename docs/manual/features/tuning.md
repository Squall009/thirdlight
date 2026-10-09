# Tuning values, limits and defaults

The values every limit and default has in this build are listed, generated from the engine's source, in [the limits reference](../reference/limits.md#limits-index); what they mean for a game is in [the limits guide](../guides/limits.md).

## Tuning values

Every gameplay value a designer tunes is data with an engine default; a
project that sets none plays exactly as one made before the value existed (recorded replays stay
valid). The values are in the component descriptor registry, so the generic
Inspector lists them in groups with units and tooltips; MCP sets them with
the same commands (`setComponent`, `setGameConfig`, `setSettings`; `null`
puts an optional value back to its default).

- **Player (`controller`)** — *Movement*: acceleration 40 m/s²,
  deceleration 60 m/s². *Jump*: coyote time 0.05 s, jump buffer 1/15 s
  (0.067), jump release 0.5 (the share of the upward speed kept when jump is
  released early; 1 = fixed jump height). *Collision*: ground snap 0.1 m,
  skin 0.01 m, autostep off (on: climbs steps up to its height, default
  0.25 m, without jumping). The steepest walkable slope, run speed, jump
  speed and gravity stay project settings (`max_slope_climb_deg` …).
- **Patrol** — for edge walkers the wall probe (0.05 m ahead) and ledge
  probe (0.4 m down from 0.1 m above its underside).
- **Mover** — max push 60 m/s: how hard it shoves a player out of its way
  (0.5 m per step at 120 Hz; a safety limit). The gap it keeps is the
  player's skin plus 1 mm.
- **Collectible without a size** — a 1 m area centred on the object.
- **Engine timing** — drop-through time 0.125 s (down + jump on a one-way
  platform), settle time 0.1 s (the world settles before the first frame).
- **Project settings (engine)** — fixed step 60 / 120 / 240 Hz (default
  120; times in seconds keep their length, a replay is recorded at one
  rate), sound voices 8 (at most 32), music fade 1 s, animation blend 0.2 s
  (the idle/run/airborne model animation; animator transitions have their
  own durations). These are stored only when set.

### Engine limits (constants)

These protect the runtime and are not tuning values. A project has **no count
limit on its assets or resources** (models, textures, audio, fonts,
prefabs, scripts, scenes, materials, animators, timelines, UI documents and
themes, dialogues and speakers, effects, graphs, script libraries,
environment presets, event sounds, block types and stamps): each is its own
file, and only one file's size and the runtime's memory are bounded
(`tests/count-caps.test.ts` and `tests/e2e/count-caps.e2e.ts` guard it). Each
limit below is a per-file size, a per-object size or a runtime budget, with
its reason (the same line is next to its constant in the code):

| Limit | Value | Why |
|---|---|---|
| Content file | 1 MiB of canonical JSON per file: each resource record (material, dialogue, UI document, …, environment preset, prefab) and `content.json`'s project-wide settings | What one parse and one change carry; the number of files is not bounded |
| Asset file | 32 MiB per imported file (128 MiB for an FBX to convert); fonts 4 MiB, images 16 MiB; audio of any length within the 32 MiB | One read and one inspection in the backend's memory |
| Disk | An import or upload is refused only when the disk the game folder is on would keep less than 64 MiB free; the message gives the free space | No project quota |
| Runtime content manifest | `manifest.json` of a Play build or an export (version 5): the build's identity, settings, start scenes and the catalog's location, about 2 KB at any project size. The catalog's files (`content/sha256/<digest>`: its root, each block — prefabs, materials, UI documents, dialogue, behaviors, … — in parts of about 1 MiB, the entry shards, each scene's dependency file) are 32 MiB each, the content file cap | One file of the build |
| Play build in memory | 32 MiB per file the build generates (the manifest's content files, scene files, compiled scripts); no cap on the whole build. The project's files (assets, instance buffers) are not held: Play serves them from disk at their digest URLs, verified while sent | One file the backend holds; what the page reads of the project is read from disk per request |
| Fixed-step catch-up per frame | 100 ms of game time (12 steps at 120 Hz, 24 at 240 Hz; the rest are dropped) | A slow frame must not make the next one slower; a time, so a fast step rate keeps real-time speed at 30 fps |
| Script physics queries | 1,024 per step, 2D and 3D together (1,024 rays cost Rapier about 1.6 ms with 16,384 colliders) | Runtime budget against a runaway loop |
| Game-view events kept | 32 | A display ring |
| Sound voices | 32 at most (the `audio_voices` setting's range; default 8) | Mixing cost; as Unity's real-voice default |
| Audio plays | 64 script sound handles alive; 32 plays per step; a sound whose file is not ready starts late up to its `maxLateMs` (default 500 ms, a dialogue voice 1,000 ms, at most 60 s) or is dropped | Runtime budget per step; decoded audio has no count: each file is held by what plays or preloads it and freed after |
| Script asset handles | 64 answers per input frame (the rest ride the next frames, never refused); keys up to 256 characters | What one input frame carries; handles themselves are not counted |
| Timelines playing | 8 at once | Runtime budget per step |
| Spawns | 64 per step (a spawn costs about 0.1 ms with 16,384 alive); 16,384 alive (one scene's entity capacity) | Runtime budget per step; spawned copies live like a scene's entities |
| Timers | 64 per script instance | Named timers of one script, saved with it; a script needing more keeps a list |
| Script intents (move, jump, transform, pose, respawn) | 40 per script instance per step (a transform and a pose on each of its 16 owned entities and its control intents); per step at most 64 or 40 × the running script instances, whichever is larger | Defense in depth against a runaway script |
| Script entity writes (`ctx.world.entity(id).set`) | 65,536 per step (four for every entity of a full scene) | Runtime budget against a runaway loop |
| Colliders | none of their own: every entity may carry one (16,384 static colliders step in about 3 ms in Rapier, measured); 3D hull and mesh points 1,048,576 per scene (a thousand full meshes build in about 2 s at load) | The load cost of mesh colliders |
| Scenes / entities | As many scenes as the game needs; 16,384 entities per scene (a big world is several scenes loaded together) | A scene is one load unit and one file |
| Prefabs | 1,024 entities and 16 levels per prefab; 1 MiB (the content file cap) | One definition is one file and one command's copy |
| Collision layers / tags | 15 named layers (+ `default`) / 32 tags | Rapier's 16-bit collision groups / a 32-bit tag mask |
| Local lights | 16 point and spot lights per scene, 16 drawn across loaded scenes (`MAX_LOCAL_LIGHTS`; a quality level's `localLights` may draw fewer); plus 16 effect-light slots (`EFFECT_LIGHT_LIMIT`) | Forward-lighting cost: every drawn light is evaluated on every lit object (per vertex where an object or light says so, see [Local lights per pixel or per vertex](lighting.md#local-lights-per-pixel-or-per-vertex)); no clustered lighting yet |
| Light layers | 8 (`LIGHT_LAYER_COUNT`) | Masks are small integers kept per object and per light; the names are labels in Project Settings |
| Fog volumes | 16 per scene | A fixed-size uniform array in the shader |
| Lightmaps | 16 atlases and 4,096 entries per scene bake, 64 baked lights | The bake's own format |
| Probe grids | Tiles of at most 64 intervals a side (`PROBE_TILE_INTERVALS`; any number of tiles), at most 8 bounces; the tiles nearest the camera are resident within 128 MB of GPU memory (`PROBE_RESIDENT_BYTES`; the textures may take 1.25× for gaps, `PROBE_ATLAS_SLACK`), the rest are not loaded (flat ambient light there; `beyondBudget` in diagnostics and a `probe_budget` problem); one 3D texture of at most 2,048 texels a side (`PROBE_PACK_MAX_EDGE`) holds the resident tiles | A world of any size streams its probes like its scenes; 128 MB holds about 1 km² of 2 m probes 16 m high; 2,048 is WebGPU's default 3D texture limit, above the budget's need. A pixel finds its tile through a grid index in constant time however many tiles are resident |
| Texture arrays | 256 layers | What WebGL 2 and WebGPU both guarantee |
| Texture edge | 4,096 px | Kept after streaming: the KTX2 encoder makes at most about 3,500² (12 Mpix), WebGL 2 promises only 2,048 and many devices stop at 4,096, and a streamed texture close to the camera still needs its full-size level |
| Texture budget | 512 MiB by default (`texture_budget_mb`, 1–65,536) | A runtime budget: streamed textures' mips fit it, the least needed dropped first; the mip tails and textures that do not stream are counted, never dropped |
| KTX2 encoding | 12 Mpix per source (across a packed array's layers) | A known limit of the pinned encoder (Basis Universal 2.5), kept; a larger texture is imported as PNG/JPEG or encoded outside the editor |
| Joined KTX2 array (UASTC layers packed as stored) | 256 MiB in the largest mip level, all layers (64 layers of 2048², 16 of 4096²) | The join holds that level twice while it compresses it |
| Material instances | 8 parents deep | A chain resolved at build; deeper chains are an authoring smell |
| Graphs | 4,096 nodes per graph (the kind may set fewer; 256 for a script or effect system graph, which compile into one bounded module) | The editor and the compiled output of one document |
| UI documents / timelines | 512 widgets and 48 KiB per document; 256 keys per track and 48 KiB per timeline | Each is saved in one 64 KiB command |
| Dialogue | 1,024 nodes per conversation; 256 dialogue variables; 8,192 seen lines | One conversation is one document; the variables and the seen set are saved with the game |
| Model rigs | 262,144 key numbers per model (clips past it are left out) | What one model adds to the catalog; per model, never per project |
| Folder listing | 500 entries per `tl_content_query target="projectFiles"` listing | A page of one folder; the project window and `queryIndex` page through any number of files |
| Command request | 64 KiB per request (a folder import names the folder, not its files; `setLabels` about 1,500 items per request) | One request's parse; larger edits are staged or name a folder |
| Upload stages | 8 open and 128 MiB staged per project at once | Uploads in flight in the backend; each is committed or expires |
| Scripts | 256 KiB of source, 16 files of 64 KiB each, 128 KiB compiled output per script; no count of scripts (a game runs as many as it has) | One compile and one module |
| Model import | 2,000,000 vertices, 4,000,000 triangles, 256 animations (16,384 channels), 64 images, 512 MiB decoded (geometry and images) per model | What one model's inspection and the page's decode hold |
| Instance sets | 65,536 copies per set | One buffer file and one draw set |
| Instance brush | 256 dabs and 1,536 places per stroke (`INSTANCE_BRUSH_LIMITS`); no count of strokes or painted copies beyond a set's | One stroke with its surface is one 64 KiB command; a longer drag is the next stroke |
| Block edits | 1,048,576 cells per edit | One command's work; a layer is stored in chunks |
| Block layers | 1,024 × 256 × 1,024 cells of bounds per layer, 16 layers with cells per scene; no count of cells in a layer or a scene | A layer's memory (`runtime.blockMemory` in Play diagnostics), not a cell count, bounds it |
| Terrain | Tiles of 17–1,025 samples a side (2^n + 1), coordinates within ±4,096 tiles, 256 material layers (one byte an index; each sample blends its strongest four; a material's per-layer settings hold values for all of them, `extraLayers` ≤ 252 past the vec4's four); no count of tiles or material rules | A tile is one blob and one decode; what the tiles take decoded is shown (`queryTerrain` `memoryBytes`), not capped |
| Terrain edit | 1,024 dabs, 2,048 m radius, dabs covering at most 16,777,216 samples together (`TERRAIN_BRUSH_LIMITS`); a heightmap import of at most 8,193² samples (`HEIGHTMAP_MAX_SAMPLES`; a RAW file also within the 32 MiB upload) | One command's work in the backend's memory; a longer drag is the next stroke |
| Block extras | 256 edits per `editBlocks` command (`BLOCK_EDIT_MAX_EDITS`); a connected type names at most 32 other types it joins (`BLOCK_CONNECT_WITH_MAX`); a `ctx.grid.path`/`reachable` query visits at most 65,536 places (`WALK_QUERY_MAX_NODES`); wall paint points 0.5 m apart, at most 16 per cell side or row (`WALL_PAINT_MAX_STEPS`); a cut-away fades over 0–10 s; a kit swap or restyle holds the old meshes at most 5 s (`RESTYLE_HOLD_MAX_MS`) | Per command, per query and per cell; nothing counts a layer's cells, edges, regions or rules |
| Terrain drawing | 256 tiles per texture page (`TERRAIN_PAGE_LAYERS`; more tiles take more pages); texel uploads 2 ms and 4 MiB of a frame (`TERRAIN_UPLOAD_BUDGET_MS`/`_BYTES`, at least one layer texture), macro bakes 2 ms of a frame (`TERRAIN_MACRO_BUDGET_MS`); sample spacing 0.05–64 m; a `queryTerrain` reads at most 1,024 points or 16,384 scatter copies; an erosion run covers at most 2,049² samples (`EROSION_MAX_SAMPLES`) | What WebGL 2 and WebGPU both guarantee per array; per-frame work kept inside a 60 Hz frame; per request, never per terrain |
| Scatter | A bake considers at most 33,554,432 candidates per command (`SCATTER_BAKE_MAX_CANDIDATES`; split a large bake by area or make it ground cover); draw groups of 2,048 m (`SCATTER_GROUP_METRES`), sets made 4,096 copies a draw at a time (`SCATTER_SET_CHUNK_COPIES`) within 4 ms of a frame; ground cover in 32 m squares (`COVER_CELL_METRES`), 2 squares at once within 2 ms of a frame; `ctx.scatter.near` answers at most 1,024 copies; impostor atlases of 8 × 8 frames of 128 px; the foliage near ring the editor writes is 40 m (`FOLIAGE_NEAR_METRES`) | Per command, per frame and per answer; no count of rules or copies per terrain or layer |
| Splines | 2–4,096 points, width up to 1,000 m, 64 profile points and 16 kit pieces per spline (`SPLINE_LIMITS`); meshes made in 64 m pieces (`SPLINE_MESH_PIECE_METRES`), each with its own levels | One component; a piece is one draw and one collider build; no count of splines |
| World streaming | Ring radii 1–100,000 m, hysteresis 0–10,000 m; the project's `streaming_budget_mb` 1–65,536 MiB (default 768); a frame's streamed arrivals (chunk meshes swapped in, scatter sets made) share 4 ms (`STREAM_ARRIVAL_MS`); the simulation builds one 257² tile's (or two chunks') colliders a step and spawns 16 live-block objects a step (`STREAM_COLLIDER_SAMPLES_PER_STEP`, `STREAM_LIVE_SPAWNS_PER_STEP`) | A runtime budget (rings are never cut; overflow is a `world_streaming_over_budget` problem); per-frame and per-step work kept inside a frame |
| Generated architecture | Chunks of 4–1,024 m (default 16 m, `ARCHITECTURE_CHUNK_DEFAULT`); a chunk heavier than `ARCHITECTURE_PART_WEIGHT_MAX` (32) is made in parts; 2 generator workers (`ARCHITECTURE_WORKERS_MAX`); 64 MiB of made chunks kept in memory (`ARCHITECTURE_CACHE_BYTES`), an export's on-disk cache 8,192 chunks; profiles of 256 points, 1,000 storeys, 16 elements per repeated piece, coordinates within ±100,000 m (`ARCHITECTURE_LIMITS`); interiors read ahead within 50 m of their door; room programs and furnishing sets 256 nodes per graph, at most 64 rooms of a type per storey and 64 copies of a prop per room (`FLOOR_PLAN_COUNT_MAX`) | Per job, per request and per graph (a request cannot ask for unbounded geometry); the caches bound memory, not the project; no count of outlines, buildings or presets |
| Trim sheets | Sheets up to 4,096 px a side (`MAX_TEXTURE_EDGE`, a texture's import limit: a larger table or layout is refused where it is declared), 1–65,536 px a metre, padding up to 256 px | A sheet's textures are textures: their limit is the sheet's |
| Height fog | Density ≤ 1, height and start ≤ 10,000 m, falloff ≤ 10, glow exponent 1–64 (`HEIGHT_FOG_LIMITS`) | A value's range in the look, not a count |
| Level-building settings | Project: `block_chunk_storage` 0/1 (JSON text or binary chunk files; absent 0, new projects 1), `streaming_budget_mb` (768 MiB), `architecture_ship_meshes` 0/1 (absent 0: architecture generated at load); quality level `shadowedLights` 0–16 (absent: every light casts its shadow); terrain `macroDistance` and `lodDistance`, layer `biplanarDistance` (60 m), scatter `coverDistance`, `shadowDistance`, `windDistance`, `densityMin`, `impostorSize` | Absent keeps the earlier look and behaviour; each is described where its feature is |
| WebSocket message to the editor | 1 MiB (a larger Play snapshot is fetched over HTTP; a larger change makes the editor re-read the project; anything else over it is dropped and listed under Problems) | One frame |

### Engine defaults

Every default is sized for any project, not for a sample: sizes are set
against the default 1.8 m character and its 1.25 m jump, and each default has
its reason next to it in the code (`project-model/src/descriptors.ts` and the
constants it names). The GameObject menu's camera (Cameras → Camera, a
fixed shot) and lights are the same values as "+ Add component" and a new
project's starter camera and lights (a white key light at 1.2 with shadows
and a cool fill at 0.6; the starter camera is that shot at the lowest
priority, kept loaded, with the project's 60° lens).
A gradient sky is grey below the horizon; an instance scatter starts as a
20 × 20 m square. Games keep their own values in their own data. HUD prompts
(`$flow.prompts`) name the game's actual bindings (the player's rebinding
included), with pad button names while a pad is in use. Scene validation
refuses negative directional/ambient light intensities and surface
roughness/metalness/glow (the range is `0 ≤ v`). Other fixed values: the
camera's "no move" threshold 1e-9 m and a 16:9 aspect until the host reports
the viewport, the model animation's run threshold 0.05 m/s, the shadow-follow
extent 24 m and a stick dead zone of 0.2 (per action: `deadZone`). New
objects get `<kind>-N` ids with at least six digits (`box-000001`), unique
across the project and without a bound (older four-digit ids load and stay).
