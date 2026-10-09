# Limits and defaults: project-model (part 1, from `animator.ts`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/project-model` defines, by source file. Values are the running build's.

<a id="limits-project-model--animator"></a>
## `animator.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-look-at-limits"></a>`LOOK_AT_LIMITS` | `{"yawMax":180,"pitchMax":90,"turnSpeedMin":1,"turnSpeedMax":7200,"turnSpeedDefault":360,"pointMax":1000000}` | Look-at bounds: per-bone turn limits (degrees each way) and the turn speed (degrees a second). |
| <a id="limit-max-animator-layers"></a>`MAX_ANIMATOR_LAYERS` | `3` | Override layers besides the base layer. |
| <a id="limit-max-blend-ground-speed"></a>`MAX_BLEND_GROUND_SPEED` | `1000` | A blend clip's ground speed bound (m/s): well past any running or driving clip. |
| <a id="limit-max-layer-mask"></a>`MAX_LAYER_MASK` | `128` | Bone names in one layer mask (the import cap on joints per skin). |

<a id="limits-project-model--arch-plan-kinds"></a>
## `arch-plan-kinds.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-floor-plan-count-max"></a>`FLOOR_PLAN_COUNT_MAX` | `64` | The most rooms of one type on a storey and the most copies of one prop in a room (a request cannot ask for unbounded work). |

<a id="limits-project-model--architecture"></a>
## `architecture.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-architecture-ao-defaults"></a>`ARCHITECTURE_AO_DEFAULTS` | `{"strength":0.6,"radius":0.5}` | Vertex AO: how dark a right-angled inside corner gets (0–1) and how far (m) the darkening reaches. |
| <a id="limit-architecture-chunk-default"></a>`ARCHITECTURE_CHUNK_DEFAULT` | `16` | Metres a chunk side covers: what one worker job makes and one draw per material shows. |
| <a id="limit-architecture-door-sill-max"></a>`ARCHITECTURE_DOOR_SILL_MAX` | `0.05` | An opening of a building's ground storey whose sill is at most this high over the floor (metres) is a door, linked to the interior when that is a scene of its own. |
| <a id="limit-architecture-limits"></a>`ARCHITECTURE_LIMITS` | `{"coordinate":100000,"distanceMax":1000,"stepMin":0.05,"cellMin":0.1,"chunkMin":4,"chunkMax":1024,"profilePoints":256,"storeys":1000,"pieceElements":16,"bulgeMax":2.4}` | Bounds of one component's values: coordinates and sizes, so a request cannot ask for unbounded geometry. |
| <a id="limit-architecture-lod-distance-default"></a>`ARCHITECTURE_LOD_DISTANCE_DEFAULT` | `40` | Metres from the camera past which the far level (no detail elements, no chamfers) is drawn. |
| <a id="limit-architecture-roof-overhang-default"></a>`ARCHITECTURE_ROOF_OVERHANG_DEFAULT` | `0.3` | Metres a building's eaves reach past its walls when its roof names no overhang. |
| <a id="limit-architecture-roof-slot-default"></a>`ARCHITECTURE_ROOF_SLOT_DEFAULT` | `"upper_wall"` | The trim slot a roof wears when it names none (the starter row layout has no roof row; a sheet with one names it). |
| <a id="limit-architecture-step-default"></a>`ARCHITECTURE_STEP_DEFAULT` | `0.5` | Metres between samples on arcs and curves. |

<a id="limits-project-model--behavior-graph-nodes"></a>
## `behavior-graph-nodes.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-behavior-graph-limits"></a>`BEHAVIOR_GRAPH_LIMITS` | `{"nodes":256,"functions":32,"loopIterationsPerStep":10000,"listItems":1024,"mapEntries":256,"switchCases":32}` |  |
| <a id="limit-data-type-default"></a>`DATA_TYPE_DEFAULT` | `{"number":0,"boolean":false,"string":"","vector":[0,0,0]}` | The default value of each data type (an unwired collection is empty). |

<a id="limits-project-model--block-connect"></a>
## `block-connect.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-block-connect-with-max"></a>`BLOCK_CONNECT_WITH_MAX` | `32` | The most other block types one type connects with. |

<a id="limits-project-model--block-grid"></a>
## `block-grid.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-block-edit-max-cells"></a>`BLOCK_EDIT_MAX_CELLS` | `1048576` | Most cells one command may visit (a box volume, a flood, an array). |
| <a id="limit-block-edit-max-edits"></a>`BLOCK_EDIT_MAX_EDITS` | `256` | Most edits in one command. |
| <a id="limit-surface-edit-max-columns"></a>`SURFACE_EDIT_MAX_COLUMNS` | `4096` | Most columns one `surface` edit sets (one command stays well under the 64 KiB request cap). |

<a id="limits-project-model--block-layers"></a>
## `block-layers.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-block-corner-max"></a>`BLOCK_CORNER_MAX` | `4` | The highest corner of a sloped cell, in cell heights. A column's top cell is the row under its lowest corner, so a column whose corners differ by up to three rows is always one smooth surface (its cell reaches up to three rows into the cells above it, which stay empty); steeper columns keep a wall. Three rows covers 56° on half-height cells and 71° on cubes. |
| <a id="limit-block-footprint-max"></a>`BLOCK_FOOTPRINT_MAX` | `64` | Largest footprint side in cells (a building lot, not a district). |
| <a id="limit-block-layer-default"></a>`BLOCK_LAYER_DEFAULT` | `{"cellSize":[1,1,1],"bounds":{"min":[0,0,0],"max":[64,16,64]}}` | Engine default for a new layer: 1 m cubes (a common kit module; the E8 target's cell height is data — a half-metre step is `cellSize [1, 0.5, 1]`) over 64 × 16 × 64 cells (the interactive-editing target of E8). |
| <a id="limit-block-limits"></a>`BLOCK_LIMITS` | `{"variants":8,"footprint":8,"customBoxes":8,"cellFields":32,"enumValues":32,"stringLength":64,"stampCells":16384,"stampSize":64,"layersPerScene":16,"layerWidth":1024,"layerHeight":256,"coordinateXZ":4096,"coordinateY":1024,"chunkPalette":4096,"regions":256,"regionBoxes":1024,"cellSizeMin":0.05,"cellSizeMax":64}` | Engine limits (they protect the runtime and keep requests under the 64 KiB command cap): block types of 8 variants, 32 metadata fields, stamps of at most 16,384 cells, 16 layers per scene, a layer up to 1,024 × 256 × 1,024 cells, coordinates within ±4,096 horizontally and ±1,024 vertically, 256 regions of 1,024 boxes. A project has as many block types and stamps as it needs (each is edited alone; cells name a type by id through a per-chunk palette), and a layer as many cells as its bounds hold: what bounds a layer is memory (diagnostics show each layer's), never a cell count. |
| <a id="limit-block-max-slope-range"></a>`BLOCK_MAX_SLOPE_RANGE` | `{"min":1,"max":89}` | The steepest and flattest `maxSlope` a layer may set (degrees). |

<a id="limits-project-model--block-mesh"></a>
## `block-mesh.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-collision-piece-limits"></a>`COLLISION_PIECE_LIMITS` | `{"vertices":1024,"triangles":2048}` | A collision piece is one mesh collider, so it keeps the mesh collider's limits. |

<a id="limits-project-model--block-sculpt"></a>
## `block-sculpt.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-sculpt-limits"></a>`SCULPT_LIMITS` | `{"radiusMin":0.5,"radiusMax":32,"strengthMax":16}` | The largest brush radius (cells) and strength (cells per dab for raise and lower). |

<a id="limits-project-model--block-walk"></a>
## `block-walk.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-walk-query-max-nodes"></a>`WALK_QUERY_MAX_NODES` | `65536` | The most places one path or reach query visits (an engine bound protecting a step's budget). |

<a id="limits-project-model--block-wall-paint"></a>
## `block-wall-paint.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-wall-paint-max-steps"></a>`WALL_PAINT_MAX_STEPS` | `16` | Most points per cell side across or per row in height (a large cell's points are further apart). |

<a id="limits-project-model--blocks"></a>
## `blocks.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-block-defaults"></a>`BLOCK_DEFAULTS` | `{"maxPush":60}` | The gameplay blocks' tuning when a component carries none. A mover shoves a character out of its way at up to 60 m/s (0.5 m per step at 120 Hz — a safety limit, not a feel). |
| <a id="limit-block-tuning-limits"></a>`BLOCK_TUNING_LIMITS` | `{"maxPush":{"min":1,"max":1000}}` | The ranges of the blocks' tuning fields. |
| <a id="limit-max-transition-fade"></a>`MAX_TRANSITION_FADE` | `5` | The longest transition fade (seconds, each way). |
| <a id="limit-max-transition-unloads"></a>`MAX_TRANSITION_UNLOADS` | `16` | At most this many scenes a transition unloads (the exit zone's limit). |
| <a id="limit-primitive-defaults"></a>`PRIMITIVE_DEFAULTS` | `{"collectibleAmount":1,"collectibleSize":[1,1,1],"patrolSize":[1,1,1],"patrolDirection":[1,0,0],"wallProbe":0.05,"ledgeProbe":0.4}` | The primitives' values when a component leaves them out, with genre-neutral reasons: a collectible adds 1 (one of something) over a 1 m area (about a hand's reach around an object a person picks up); a patroller is a 1 m body (a person-sized walker's width) that looks 0.05 m ahead for a wall and 0.4 m down for floor from 0.1 m above its underside (a drop deeper than 0.3 m, knee height, is a ledge) — the same probes the engine used before; it starts walking along +X (the 2D plane's "ahead"). |
| <a id="limit-primitive-limits"></a>`PRIMITIVE_LIMITS` | `{"amount":{"min":-1000000,"max":1000000},"respawn":{"min":0,"max":3600},"size":{"min":0.05,"max":500},"radius":{"min":0.025,"max":250},"speed":{"min":0,"max":50},"wait":{"min":0,"max":60},"wallProbe":{"min":0,"max":5},"ledgeProbe":{"min":0.1,"max":20},"damage":{"min":0,"max":1000}}` | The primitives' value ranges. |
| <a id="limit-switch-default-action"></a>`SWITCH_DEFAULT_ACTION` | `"interact"` | The input action an `interact` switch reads when it names none. |

<a id="limits-project-model--cameras"></a>
## `cameras.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-camera-path-limits"></a>`CAMERA_PATH_LIMITS` | `{"minPoints":2,"maxPoints":64,"coordinate":1000000}` |  |
| <a id="limit-camera-region-defaults"></a>`CAMERA_REGION_DEFAULTS` | `{"priority":0,"blendTime":0.5}` | Blend 0.5 s: the camera blend's own default (a region change reads as a camera move). |
| <a id="limit-camera-region-limits"></a>`CAMERA_REGION_LIMITS` | `{"size":{"min":0.05,"max":100000}}` | A region spans 5 cm (a doorway's sliver) to 100 km (a whole world). |
| <a id="limit-default-view-id"></a>`DEFAULT_VIEW_ID` | `"main"` | The view a game draws through. Every API that reads or sets the view takes a view key; there is one view today (`DEFAULT_VIEW_ID`), so a second one (a split screen, a networked player's) is a new key, not a new API. |
| <a id="limit-default-view-pose"></a>`DEFAULT_VIEW_POSE` | `{"position":[0,1.6,6],"rotation":[0,0,0,1]}` | Where the view looks from while no virtual camera is live (Play warns): 1.6 m up (eye height) and 6 m back along +Z, level and looking down −Z at the origin, where a new project's first objects land — something is on screen instead of a black frame, and nothing about it is game-specific. |
| <a id="limit-view-lens-defaults"></a>`VIEW_LENS_DEFAULTS` | `{"fovY":60,"near":0.1,"far":100}` | The project's default lens (the `camera_fov_deg`, `camera_near_m` and `camera_far_m` settings; a virtual camera without its own lens uses them): 60° vertical (the common game default, three.js's too) and 0.1–100 m, from arm's length to a large level — what the scene camera entity defaulted to before the engine owned the view, so an upgraded project draws the same. |
| <a id="limit-virtual-camera-defaults"></a>`VIRTUAL_CAMERA_DEFAULTS` | `{"priority":0,"enabled":true,"targetOffset":[0,0,0],"distance":5,"minDistance":0.5,"maxDistance":100,"yaw":0,"pitch":20,"pitchMin":-30,"pitchMax":80,"rotateSpeed":120,"zoomSpeed":10,"yawStep":90,"turnTime":0.25,"collision":true,"collisionRadius":0.2,"damping":0,"progress":0,"railSpeed":0,"railMode":"once","blend":"eased","blendTime":0.5,"letterbox":0,"shakeAmplitude":0,"shakeFrequency":8,"shakeRotation":0,"lookAheadMax":[3,3,3],"lookAheadSmoothing":0.2}` | The engine defaults (every one genre-neutral): - priority 0: every camera equal until a project ranks them (the one activated last wins a tie); - distance 5 m: a few body lengths from a person-size target — the whole figure and some ground around it at a 60° lens; - pitch 20° with limits −30°…80°: slightly above (the ground ahead shows), never flipping over the top or far under the floor; - minDistance 0.5 m / maxDistance 100 m: the closest a pulled-in or zoomed camera comes (just outside a head) and the farthest it zooms (a small field in view); - rotateSpeed 120°/s: a third of a turn per second at full stick; - zoomSpeed 10 m/s: across the default range in a few seconds; - yawStep 90°: a quarter turn — the four sides of anything built on a grid; - turnTime 0.25 s: a snapped turn reads as a move, not a cut, and is done before the next press; - collisionRadius 0.2 m: a head's width of clearance from walls; - damping 0 s: rigid (the camera sits exactly where its rig says); - blend eased over 0.5 s: reads as a camera move without holding up play; - shakeFrequency 8 Hz: a handheld/impact tremor, not a vibration; - lookAheadMax 3 m per axis: about a storey or a few strides — the ground below a fall or the way ahead shows, the target never leaves the view; - lookAheadSmoothing 0.2 s: a take-off or a landing eases the look-ahead in and out instead of snapping the view. |
| <a id="limit-virtual-camera-limits"></a>`VIRTUAL_CAMERA_LIMITS` | `{"priority":{"min":-1000,"max":1000},"offset":{"min":-1000,"max":1000},"distance":{"min":0.1,"max":10000},"minDistance":{"min":0,"max":10000},"maxDistance":{"min":0.1,"max":10000},"yaw":{"min":-360,"max":360},"pitch":{"min":-89,"max":90},"rotateSpeed":{"min":0,"max":1440},"zoomSpeed":{"min":0,"max":1000},"yawStep":{"min":1,"max":180},"turnTime":{"min":0,"max":10},"collisionRadius":{"min":0,"max":5},"damping":{"min":0,"max":10},"point":{"min":-1000000,"max":1000000},"progress":{"min":0,"max":1},"railSpeed":{"min":-1000,"max":1000},"fovY":{"min":1,"max":179},"near":{"min":0.001,"max":100000},"far":{"min":0.01,"max":10000000},"blendTime":{"min":0,"max":30},"letterbox":{"min":0,"max":0.5},"shakeAmplitude":{"min":0,"max":10},"shakeFrequency":{"min":0.1,"max":60},"shakeRotation":{"min":0,"max":45},"deadZone":{"min":0,"max":1000},"bounds":{"min":-1000000,"max":1000000},"lookAhead":{"min":0,"max":10},"lookAheadMax":{"min":0,"max":1000},"lookAheadSmoothing":{"min":0,"max":10}}` | The ranges of the numeric fields (engine limits that keep the maths sane). |

<a id="limits-project-model--collider-shapes"></a>
## `collider-shapes.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-collider-3-d-limits"></a>`COLLIDER_3D_LIMITS` | `{"convexPoints":64,"meshVertices":1024,"meshTriangles":2048,"pointsTotal":1048576,"heightfieldCells":1024}` | The limits of the 3D collider shapes. A hull of 64 points and a mesh of 1,024 vertices / 2,048 triangles are far beyond a collision proxy (a `_COL` node is a handful of boxes' worth of triangles) and keep one collider inside a command request (64 KiB); a scene holds at most 1,048,576 hull/mesh points in all (a thousand full meshes: Rapier builds them in about 2 s at load and steps them in under 1 ms, measured). Every coordinate lies within the 64 m collider extent, like a polygon's. A compound has no shape count of its own: its hulls' and meshes' points count toward that scene budget, and the command request bounds one edit. A heightfield (made by the engine from a terrain tile, never authored) has at most `heightfieldCells` cells a side: the largest tile's. |
| <a id="limit-max-collider-extent"></a>`MAX_COLLIDER_EXTENT` | `64` |  |
| <a id="limit-max-polygon-vertices"></a>`MAX_POLYGON_VERTICES` | `8` | The points of one 2D polygon collider. A scene has no collider count of its own: every entity may carry one (the scene's entity cap bounds them); 16,384 static colliders cost Rapier about 3 ms a step (measured). |
| <a id="limit-min-polygon-area"></a>`MIN_POLYGON_AREA` | `0.000001` |  |

<a id="limits-project-model--components"></a>
## `components.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-capsule-limits"></a>`CAPSULE_LIMITS` | `{"minRadius":0.05,"maxRadius":5,"minHeight":0.1,"maxHeight":20,"maxOffset":5}` | The capsule ranges (m) — far beyond any character, small enough to keep the solver sane. |
| <a id="limit-character-3-d-limits"></a>`CHARACTER_3D_LIMITS` | `{"walkSpeed":{"min":0,"max":50},"runSpeed":{"min":0,"max":50},"airControl":{"min":0,"max":1},"gravityScale":{"min":0,"max":10},"jumpSpeed":{"min":0,"max":50},"slopeLimit":{"min":1,"max":89},"stepHeight":{"min":0,"max":1},"ledgeHeight":{"min":0.1,"max":5},"ledgeClimbTime":{"min":0.05,"max":5},"turnSpeed":{"min":0,"max":36000}}` | The 3D settings' ranges (a step-up below 0.01 m is off; a turn speed of 0 turns at once). |
| <a id="limit-controller-action-defaults"></a>`CONTROLLER_ACTION_DEFAULTS` | `{"moveAction":"move","jumpAction":"jump","runAction":"run"}` |  |
| <a id="limit-controller-movement-limits"></a>`CONTROLLER_MOVEMENT_LIMITS` | `{"climbSpeed":{"min":0.1,"max":50},"wallSlideSpeed":{"min":0,"max":50},"wallJumpAway":{"min":0,"max":50},"wallJumpUp":{"min":0,"max":50},"wallJumpLock":{"min":0,"max":5}}` | The climb and wall fields' ranges (m/s). |
| <a id="limit-controller-tuning-limits"></a>`CONTROLLER_TUNING_LIMITS` | `{"acceleration":{"min":0.1,"max":1000},"deceleration":{"min":0.1,"max":1000},"coyoteTime":{"min":0,"max":1},"jumpBuffer":{"min":0,"max":1},"jumpRelease":{"min":0,"max":1},"groundSnap":{"min":0,"max":1},"skin":{"min":0.001,"max":0.1},"autostepHeight":{"min":0.01,"max":2}}` | The tuning ranges — wide enough for any character, narrow enough to keep the solver and the step counters sane. |
| <a id="limit-default-character-3-d"></a>`DEFAULT_CHARACTER_3D` | `{"walkSpeed":2,"airControl":0.5,"gravityScale":1,"jump":true,"stepHeight":0.3,"ledgeClimb":false,"ledgeHeight":1.2,"ledgeClimbTime":0.6,"turnSpeed":720,"faceMovement":true,"moveFrame":"view"}` | The 3D character's settings when a controller carries none (read only in a 3D project, physics_dimension 3; a 2D plane ignores them). Genre-neutral reasons: a 2 m/s walk is a brisk human walk (people walk at 1.2–1.5 m/s; a game walks a little faster so a map never drags); half the ground acceleration in the air steers a jump without mid-air U-turns; gravity is the project's (scale 1); most characters can hop, so jumping is on (turn it off for a game that only walks); a 0.3 m step-up climbs a stair riser (0.15–0.2 m) or a kerb without a jump, well below knee height; a ledge climb is off (not every game climbs) and, when on, pulls up onto ledges up to 1.2 m (chest height of the default 1.8 m capsule) in 0.6 s; 720°/s turns a half circle in a quarter second (responsive, never a snap) and the character faces where it moves; the move input is read relative to the live camera's heading (pushing up walks away from the camera, as most third-person controllers do; `world` reads it along the world axes). Run speed, jump speed and the slope limit are absent: the project's `run_speed`, `jump_velocity` and `max_slope_climb_deg` settings apply. |
| <a id="limit-default-collision-layer"></a>`DEFAULT_COLLISION_LAYER` | `"default"` | Collision layers. A 3D project names up to `MAX_COLLISION_LAYERS` layers in `content.collisionLayers`; together with the implicit "default" layer (every collider without `layers`) they are the 16 membership bits of the physics engine's collision groups. A collider lists the layers it is in; a script query's filter names the layers it sees. The names are identifiers (letters, digits, _; 1–32 characters). |
| <a id="limit-default-controller-capsule"></a>`DEFAULT_CONTROLLER_CAPSULE` | `{"radius":0.3,"height":1.8,"offset":[0,0]}` | The default character capsule when a controller carries none — 0.3 m radius and 1.8 m total height (an adult human standing: about 0.6 m across the shoulders, 1.8 m tall), centred on the entity. Every project made before the capsule became data plays with exactly this shape. |
| <a id="limit-default-controller-movement"></a>`DEFAULT_CONTROLLER_MOVEMENT` | `{"climbSpeed":2,"wallSlide":false,"wallSlideSpeed":2,"wallJump":false}` | Climbing and walls (both dimensions). Climbing needs no switch: a character climbs only inside a `climbVolume` (a scene without one plays as before). Wall slide and wall jump are off by default (not every game clings to walls). Genre-neutral reasons: a 2 m/s climb is the default 3D walk (half the default run: a ladder or a net is slower than running on the ground); a 2 m/s wall slide is a controlled slip, a fifteenth of the default 30 m/s fall cap; a wall jump leaves at the run speed and the jump speed (absent: the character's own, so it matches its normal jump). |
| <a id="limit-default-controller-tuning"></a>`DEFAULT_CONTROLLER_TUNING` | `{"acceleration":40,"deceleration":60,"coyoteTime":0.05,"jumpBuffer":0.06666666666666667,"jumpRelease":0.5,"groundSnap":0.1,"skin":0.01,"autostep":false,"autostepHeight":0.25}` | The character's movement tuning when a controller carries none — exactly the values every project played with before they became data (so recorded replays stay valid). Generic reasons: 40 / 60 m/s² reach a 4 m/s run in 0.1 s and stop in under 0.07 s (responsive but not instant, any walking character); 0.05 s coyote time and a 1/15 s (8 steps at 120 Hz) jump buffer are the usual few-frame forgiveness windows; releasing jump early keeps half the upward speed (variable jump height); a 0.1 m ground snap holds a walker on gentle slopes and small bumps; the 0.01 m skin is the physics gap that keeps the character from resting exactly on surfaces; autostep is off (a side-view character climbs by jumping) and climbs 0.25 m (above a 0.18 m stair step) when on. |
| <a id="limit-max-collision-layers"></a>`MAX_COLLISION_LAYERS` | `15` | Named layers besides `default`: Rapier's collision groups are 16 bits. |
| <a id="limit-max-entities-v2"></a>`MAX_ENTITIES_V2` | `1024` |  |

<a id="limits-project-model--content-limits"></a>
## `content-limits.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-address-max-length"></a>`ADDRESS_MAX_LENGTH` | `128` | An address (the one name a script loads an asset or resource by): the label characters, longer, so a path-like name (`voice/intro/line-01`) fits. Unique across the project's assets and resources. |
| <a id="limit-asset-label-max-length"></a>`ASSET_LABEL_MAX_LENGTH` | `64` | An asset label (the name a script may load a group of assets by): a letter or digit, then letters, digits, `_`, `-`, `.` or `/`, at most this many characters. No spaces, so a search can say `l:voice`. |
| <a id="limit-asset-query-page-default"></a>`ASSET_QUERY_PAGE_DEFAULT` | `50` |  |
| <a id="limit-asset-query-page-max"></a>`ASSET_QUERY_PAGE_MAX` | `128` | A page of the asset catalog (the asset queries' largest and default page). |
| <a id="limit-audio-max-late-ms-default"></a>`AUDIO_MAX_LATE_MS_DEFAULT` | `500` | How late a sound played before its file is ready may still start (ms) when its caller does not say: half a second after its moment a hit or a bark still reads as that moment's; later it is dropped. |
| <a id="limit-audio-max-late-ms-limit"></a>`AUDIO_MAX_LATE_MS_LIMIT` | `60000` | The largest lateness bound a caller may set (ms): a minute, longer than any wait for one file. |
| <a id="limit-audio-voice-cap"></a>`AUDIO_VOICE_CAP` | `32` | The engine cap on concurrent sound voices (the `audio_voices` setting's maximum): mixing cost per voice, as common engines' real-voice defaults. |
| <a id="limit-audio-voices-default"></a>`AUDIO_VOICES_DEFAULT` | `8` | The `audio_voices` default: enough for overlapping effects in any scene. |
| <a id="limit-declaration-string-length-default"></a>`DECLARATION_STRING_LENGTH_DEFAULT` | `256` | A declared `string` property's length (code points) when it sets no `maxLength`, and the largest `maxLength` it may set. |
| <a id="limit-default-asset-folder"></a>`DEFAULT_ASSET_FOLDER` | `"assets"` | The folder of the game folder uploads land in when the user names none. |
| <a id="limit-index-page-default"></a>`INDEX_PAGE_DEFAULT` | `256` |  |
| <a id="limit-index-page-max"></a>`INDEX_PAGE_MAX` | `1024` | A page of the project index (`queryIndex`): its largest (also the most ids one page asks for) and its default size. |
| <a id="limit-max-asset-versions"></a>`MAX_ASSET_VERSIONS` | `32` | The content catalog's limits: the sizes of one file, one record and one model. A leaf module (no imports), so every model module can use them without an import cycle; `content.ts` re-exports them. Nothing here bounds how many assets or resources a project holds: a game has as many as it needs, each stored as its own file, so only a file's size and the runtime's memory are bounded (a guard test fails if a count of assets or resources comes back as a `MAX_*` here). |
| <a id="limit-max-audio-versions"></a>`MAX_AUDIO_VERSIONS` | `8` | Versions of one audio record (its file's size is bounded by `MAX_SOURCE_BYTES`, as every imported file's). |
| <a id="limit-max-behavior-diagnostics"></a>`MAX_BEHAVIOR_DIAGNOSTICS` | `32` | The most compile diagnostics a failed compile reports (the compiler, the workspace and the editor all cut there). |
| <a id="limit-max-behavior-file-bytes"></a>`MAX_BEHAVIOR_FILE_BYTES` | `65536` | The largest file in a script's source container (bytes). |
| <a id="limit-max-behavior-files"></a>`MAX_BEHAVIOR_FILES` | `16` |  |
| <a id="limit-max-behavior-output-bytes"></a>`MAX_BEHAVIOR_OUTPUT_BYTES` | `131072` |  |
| <a id="limit-max-behavior-source-bytes"></a>`MAX_BEHAVIOR_SOURCE_BYTES` | `262144` |  |
| <a id="limit-max-content-file-bytes"></a>`MAX_CONTENT_FILE_BYTES` | `1048576` | The largest content file, in canonical bytes: one resource record (a material, dialogue, UI document, …, each its own file) or the project-wide settings `content.json` holds. It bounds what one parse and one change carry; the number of files is not bounded. |
| <a id="limit-max-converted-source-bytes"></a>`MAX_CONVERTED_SOURCE_BYTES` | `134217728` | The largest original accepted for conversion (an FBX), in bytes. |
| <a id="limit-max-declaration-bytes"></a>`MAX_DECLARATION_BYTES` | `32768` | A behavior declaration's canonical bytes (2-space JSON and a newline). This alone bounds how many properties a behavior declares: a count cap would only be a guess at what one game needs. |
| <a id="limit-max-declaration-string-length"></a>`MAX_DECLARATION_STRING_LENGTH` | `1024` |  |
| <a id="limit-max-enum-values"></a>`MAX_ENUM_VALUES` | `32` |  |
| <a id="limit-max-folder-depth"></a>`MAX_FOLDER_DEPTH` | `32` | The deepest folder of the game folder the editor reads resources and asset files from. |
| <a id="limit-max-font-family-name"></a>`MAX_FONT_FAMILY_NAME` | `64` | The longest family name a font version records (characters). |
| <a id="limit-max-font-versions"></a>`MAX_FONT_VERSIONS` | `8` | Versions of one font asset record (TTF, OTF, WOFF2, WOFF). |
| <a id="limit-max-open-stages"></a>`MAX_OPEN_STAGES` | `8` | Open import stages per project, and their staged bytes together. |
| <a id="limit-max-owned-transforms"></a>`MAX_OWNED_TRANSFORMS` | `16` | The most entities a script may own the transforms of (`ownedTransforms`). |
| <a id="limit-max-prefab-bytes"></a>`MAX_PREFAB_BYTES` | `1048576` |  |
| <a id="limit-max-prefab-depth"></a>`MAX_PREFAB_DEPTH` | `16` |  |
| <a id="limit-max-prefab-entities"></a>`MAX_PREFAB_ENTITIES` | `1024` | One prefab: its entities (a building or a vehicle of many parts) and its depth. A prefab is one content file, so its bytes have the content file cap. |
| <a id="limit-max-prefab-overrides"></a>`MAX_PREFAB_OVERRIDES` | `64` | The most overrides one prefab instantiation request carries (commands and the editor's planner check it). |
| <a id="limit-max-source-bytes"></a>`MAX_SOURCE_BYTES` | `33554432` | The largest imported file (bytes): a model, an image, a font, an audio file of any length. It is the upload stage's bound too; the number of files is not bounded. |
| <a id="limit-max-source-path-length"></a>`MAX_SOURCE_PATH_LENGTH` | `512` | The longest accepted `sourcePath` (UTF-16 code units). |
| <a id="limit-max-staged-bytes-per-project"></a>`MAX_STAGED_BYTES_PER_PROJECT` | `134217728` |  |
| <a id="limit-max-texture-edge"></a>`MAX_TEXTURE_EDGE` | `4096` | The largest texture edge (pixels): every GPU the engine targets samples it; texture streaming revisits it. |
| <a id="limit-max-texture-layers"></a>`MAX_TEXTURE_LAYERS` | `256` | The layers of a texture array (WebGL 2 and WebGPU both guarantee 256). |
| <a id="limit-max-texture-versions"></a>`MAX_TEXTURE_VERSIONS` | `8` | Versions of one texture asset record (PNG/JPEG/WebP/KTX2). |
| <a id="limit-max-total-decoded-bytes"></a>`MAX_TOTAL_DECODED_BYTES` | `536870912` | The total decoded bytes of one model (`decodedGeometryBytes + decodedImageBytes`). |
| <a id="limit-model-json-chunk-bytes-max"></a>`MODEL_JSON_CHUNK_BYTES_MAX` | `8388608` | The largest JSON chunk of an imported GLB (bytes). |

<a id="limits-project-model--content-settings"></a>
## `content-settings.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-default-fixed-step-hz"></a>`DEFAULT_FIXED_STEP_HZ` | `120` | The simulation's step rate when a project sets none (`fixed_step_hz`), and the rates it may choose. 120 Hz: two steps per 60 Hz display frame (smooth on common displays, cheap for any 2D scene); 60 halves the cost, 240 halves the step for fast motion. The runtime, the physics ports, the game page, the worker and the exporter all read these. |

<a id="limits-project-model--content"></a>
## `content.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-engine-timing-defaults"></a>`ENGINE_TIMING_DEFAULTS` | `{"dropThroughTime":0.125,"settleTime":0.1}` | Engine timing every project played with before it became data (recorded replays stay valid). Generic reasons: falling through a one-way platform ignores it for 0.125 s (enough to clear a thin platform at any normal fall speed); the world settles for 0.1 s before the first frame so resting bodies start at rest. |

<a id="limits-project-model--dialogue"></a>
## `dialogue.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-dialogue-defaults"></a>`DIALOGUE_DEFAULTS` | `{"textSpeed":40,"autoAdvance":false,"autoDelay":0.5,"duck":0.4,"backlog":50,"blipEvery":2,"blipVolume":0.6,"expression":"neutral","voiceMaxLateMs":1000}` | Engine defaults, each with a genre-neutral reason: - textSpeed 40 chars/s: comfortably faster than speech (~15 chars/s), so the text leads a voice and a silent line reads without waiting. - autoDelay 0.5 s: a beat after the voice ends before the next line. - duck 0.4: a voice stays clear over music and effects without silencing them. - backlog 50 lines: a scene's worth of history in a small view model. - blipEvery 2, blipVolume 0.6: a blip per syllable-ish, under the music. |
| <a id="limit-dialogue-limits"></a>`DIALOGUE_LIMITS` | `{"nodes":1024,"portraits":32,"textChars":1024,"optionChars":256,"exprChars":512,"variables":256,"variableText":256,"bindings":16,"seen":8192,"backlog":100,"hopsPerStep":256,"frameInputs":8,"nameChars":64,"signalValueChars":256}` |  |

<a id="limits-project-model--effect-graph-kinds"></a>
## `effect-graph-kinds.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-effect-graph-limits"></a>`EFFECT_GRAPH_LIMITS` | `{"nodes":256}` | Engine limits of one system graph (not tuning values). |
| <a id="limit-effect-light-limit"></a>`EFFECT_LIGHT_LIMIT` | `16` | Point lights every playing effect shares: the renderer adds them all, dark, when a game with light-emitting effects starts (a light added mid-play would recompile every lit material), and each costs shading time on every lit surface. Also the most a single Lights block may ask for. |

<a id="limits-project-model--effects"></a>
## `effects.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-effect-defaults"></a>`EFFECT_DEFAULTS` | `{"duration":2,"loop":true,"seed":1,"bounds":{"center":[0,1,0],"size":[4,4,4]},"maxParticles":1000,"space":"local"}` | A new effect's settings (engine defaults): a 2 s looping cycle — short enough to see the loop while authoring, any effect sets its own; seed 1; bounds a 4 m cube centred 1 m above the origin (a person-sized effect standing on its origin). |
| <a id="limit-effect-limits"></a>`EFFECT_LIMITS` | `{"systems":16,"parameters":32,"maxParticles":1048576,"duration":3600,"seed":4294967295,"extent":10000}` | Engine limits (not tuning values). |

<a id="limits-project-model--entity-ids"></a>
## `entity-ids.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-entity-id-max"></a>`ENTITY_ID_MAX` | `9007199254740991` | The largest number an assigned id takes. Past 999,999 the number simply has more digits. |

<a id="limits-project-model--environment-presets"></a>
## `environment-presets.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-environment-preset-limits"></a>`ENVIRONMENT_PRESET_LIMITS` | `{"lights":32,"intensity":1000,"lightmapIntensity":8}` | Engine limits of environment presets (documented in deployment.md). |

<a id="limits-project-model--event-cues"></a>
## `event-cues.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-event-cue-limits"></a>`EVENT_CUE_LIMITS` | `{"name":64}` | Engine limits: the name length (a signal name's). The table has as many rows as the game needs. |

<a id="limits-project-model--frame-rate-cap"></a>
## `frame-rate-cap.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-frame-rate-cap-choices"></a>`FRAME_RATE_CAP_CHOICES` | `["30","60","120","none"]` | What a settings field bound to the cap may choose: each cap as text, and 'none' (no cap). |

<a id="limits-project-model--graph"></a>
## `graph.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-graph-curve-limits"></a>`GRAPH_CURVE_LIMITS` | `{"minKeys":2,"maxKeys":16,"minStops":1,"maxStops":8}` | The bounds of the `curve` and `gradient` field types. |
| <a id="limit-graph-limits"></a>`GRAPH_LIMITS` | `{"nodes":4096,"edgesPerNode":4,"groups":256,"comments":256,"reroutesPerEdge":16,"titleLength":64,"commentLength":2000,"coordinate":1000000,"size":100000,"ops":512}` | Engine limits that protect the editor and the backend (not tuning values). |

<a id="limits-project-model--input"></a>
## `input.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-default-input"></a>`DEFAULT_INPUT` | `{"actions":[{"name":"move","type":"axis1d","map":"gameplay","bindings":[{"kind":"keys1d","negative":"KeyA","positive":"KeyD"},{"kind":"keys1d","negative":"ArrowLeft","positive":"ArrowRight"},{"kind":"gamepadButtons1d","negative":14,"positive":15},{"kind":"gamepadAxis","axis":0}]},{"name":"jump","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"Space"},{"kind":"gamepadButton","button":0}]},{"name":"attack","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"KeyJ"},{"kind":"gamepadButton","button":2}]},{"name":"interact","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"KeyE"},{"kind":"gamepadButton","button":3}]},{"name":"pause","type":"button","map":"ui","bindings":[{"kind":"key","code":"Escape"},{"kind":"gamepadButton","button":9}]},{"name":"submit","type":"button","map":"ui","bindings":[{"kind":"key","code":"Enter"},{"kind":"gamepadButton","button":0}]},{"name":"cancel","type":"button","map":"ui","bindings":[{"kind":"key","code":"Backspace"},{"kind":"gamepadButton","button":1}]},{"name":"navigate","type":"axis2d","map":"ui","bindings":[{"kind":"keys2d","up":"ArrowUp","down":"ArrowDown","left":"ArrowLeft","right":"ArrowRight"},{"kind":"keys2d","up":"KeyW","down":"KeyS","left":"KeyA","right":"KeyD"},{"kind":"gamepadStick","x":0,"y":1}]}]}` | Today's controls, plus the actions menus and gameplay blocks use. |
| <a id="limit-default-input-3-d"></a>`DEFAULT_INPUT_3D` | `{"actions":[{"name":"move","type":"axis2d","map":"gameplay","bindings":[{"kind":"keys2d","up":"KeyW","down":"KeyS","left":"KeyA","right":"KeyD"},{"kind":"keys2d","up":"ArrowUp","down":"ArrowDown","left":"ArrowLeft","right":"ArrowRight"},{"kind":"gamepadStick","x":0,"y":1}]},{"name":"run","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"ShiftLeft"},{"kind":"key","code":"ShiftRight"},{"kind":"gamepadButton","button":10}]},{"name":"jump","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"Space"},{"kind":"gamepadButton","button":0}]},{"name":"attack","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"KeyJ"},{"kind":"gamepadButton","button":2}]},{"name":"interact","type":"button","map":"gameplay","bindings":[{"kind":"key","code":"KeyE"},{"kind":"gamepadButton","button":3}]},{"name":"pause","type":"button","map":"ui","bindings":[{"kind":"key","code":"Escape"},{"kind":"gamepadButton","button":9}]},{"name":"submit","type":"button","map":"ui","bindings":[{"kind":"key","code":"Enter"},{"kind":"gamepadButton","button":0}]},{"name":"cancel","type":"button","map":"ui","bindings":[{"kind":"key","code":"Backspace"},{"kind":"gamepadButton","button":1}]},{"name":"navigate","type":"axis2d","map":"ui","bindings":[{"kind":"keys2d","up":"ArrowUp","down":"ArrowDown","left":"ArrowLeft","right":"ArrowRight"},{"kind":"keys2d","up":"KeyW","down":"KeyS","left":"KeyA","right":"KeyD"},{"kind":"gamepadStick","x":0,"y":1}]}]}` | The default actions of a 3D project (physics_dimension 3) without its own input — the 2D defaults with `move` as a 2D axis (W/A/S/D, the arrow keys and the left stick: forward, back and sideways) and a `run` button (Shift, the left-stick press — the usual sprint controls), which the 3D character controller reads. |
| <a id="limit-input-hold-max"></a>`INPUT_HOLD_MAX` | `10` |  |
| <a id="limit-input-hold-min"></a>`INPUT_HOLD_MIN` | `0.05` | A binding's hold modifier — the binding counts only after it has been held this long (seconds): a hold instead of a tap. 0.05 s is about three frames at 60 Hz (shorter is indistinguishable from a tap); 10 s bounds a deliberate long hold. |
| <a id="limit-max-input-actions"></a>`MAX_INPUT_ACTIONS` | `64` | 64: a game with many abilities or hotbar slots names more actions; the frame bound follows. |
| <a id="limit-max-input-bindings"></a>`MAX_INPUT_BINDINGS` | `8` |  |
| <a id="limit-max-input-glyphs"></a>`MAX_INPUT_GLYPHS` | `128` |  |
| <a id="limit-max-input-maps"></a>`MAX_INPUT_MAPS` | `8` | At most this many project maps besides gameplay and ui (an engine limit). |

<a id="limits-project-model--instance-brush"></a>
## `instance-brush.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-instance-brush-defaults"></a>`INSTANCE_BRUSH_DEFAULTS` | `{"radius":2,"density":1,"spacing":0.5,"scale":[0.8,1.2],"yaw":360,"align":0,"seed":1}` | A new brush's settings (the editor's starting point). |
| <a id="limit-instance-brush-limits"></a>`INSTANCE_BRUSH_LIMITS` | `{"dabs":256,"samples":1536,"radius":{"min":0.05,"max":50},"density":{"min":0.001,"max":100},"spacing":{"min":0,"max":50},"scale":{"min":0.01,"max":100},"yaw":{"min":0,"max":360},"align":{"min":0,"max":1},"extent":100000}` | What one stroke may carry. `dabs` and `samples` keep a stroke (with its surface, three numbers per candidate) inside one command request; the rest are the fields' sane ranges. |

<a id="limits-project-model--light-layers"></a>
## `light-layers.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-light-layer-name"></a>`MAX_LIGHT_LAYER_NAME` | `32` | Longest layer name. |

<a id="limits-project-model--lighting"></a>
## `lighting.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-baked-lights"></a>`MAX_BAKED_LIGHTS` | `64` |  |
| <a id="limit-max-lightmap-atlases"></a>`MAX_LIGHTMAP_ATLASES` | `16` | One scene bake's atlases, entries and baked lights: the bake format's own bounds (scalable lighting reworks the bake). |
| <a id="limit-max-lightmap-entries"></a>`MAX_LIGHTMAP_ENTRIES` | `4096` |  |

<a id="limits-project-model--local-lights"></a>
## `local-lights.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-instances-local-lights-default"></a>`INSTANCES_LOCAL_LIGHTS_DEFAULT` | `"pixel"` | The mode of an instance set that sets none (and whose material sets none). Per pixel: measured on this engine's village class with lamps over its scatter, per vertex was no cheaper (scatter far from the camera has about as many vertices as pixels); a set of large, coarse or close foliage opts in. |
| <a id="limit-max-local-lights"></a>`MAX_LOCAL_LIGHTS` | `16` | Most point + spot lights per scene: the forward-lighting cost per drawn light (a quality level may draw fewer). |

<a id="limits-project-model--manifest"></a>
## `manifest.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-manifest-content-file-max-bytes"></a>`MANIFEST_CONTENT_FILE_MAX_BYTES` | `33554432` | The most bytes one content file of a Play build or an export may hold; the play content store takes it as its single-artifact cap. |
| <a id="limit-runtime-content-manifest-max-bytes"></a>`RUNTIME_CONTENT_MANIFEST_MAX_BYTES` | `33554432` | The manifest document cap: the manifest is one file like the content files it lists, so it has their per-file cap. Asset rows, rigs and prefabs are still inline and grow with the game; a fixed cap below a file's would bound how many assets a game ships. |

<a id="limits-project-model--material-graph-kinds"></a>
## `material-graph-kinds.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-material-data-max"></a>`MATERIAL_DATA_MAX` | `64` | The largest data parameter, cells per side (engine limit): 64 × 64 RGBA8 is 16 KiB per object — enough for a per-cell overlay of a large board or map region, small enough to send whole on every change. |

<a id="limits-project-model--materials"></a>
## `materials.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-default-wind"></a>`DEFAULT_WIND` | `{"direction":[1,0],"strength":0.5,"gust":0.4,"gustFrequency":0.3,"turbulence":0.3}` | The wind when a project sets none — a light breeze along +X (0.5 with 0.4 gusts every ~3 s, a little turbulence): foliage moves a little in any scene; 0 strength stills it. |
| <a id="limit-height-fog-defaults"></a>`HEIGHT_FOG_DEFAULTS` | `{"density":0.02,"color":"#c8d2dc","height":0,"falloff":0.05,"start":0,"inscatterExponent":8}` | What an absent height fog field means (the renderer and the preset blend read these); a new height fog starts at `density` and `color`. |
| <a id="limit-height-fog-limits"></a>`HEIGHT_FOG_LIMITS` | `{"density":1,"height":10000,"falloff":10,"start":10000,"inscatterExponentMin":1,"inscatterExponentMax":64}` | The height fog's ranges (the validator and the descriptor share them). |
| <a id="limit-material-extra-layers-max"></a>`MATERIAL_EXTRA_LAYERS_MAX` | `252` | Layers past a vec4's four a per-layer setting holds values for: every layer a terrain sample can name. |
| <a id="limit-max-fog-volumes"></a>`MAX_FOG_VOLUMES` | `16` | Fog volumes per scene: the fog shader reads them from a fixed-size uniform array. |
| <a id="limit-max-material-instance-depth"></a>`MAX_MATERIAL_INSTANCE_DEPTH` | `8` | The longest chain of instances (an instance of an instance of … a material), resolved at build and in the renderer per material. |
| <a id="limit-max-material-parameters"></a>`MAX_MATERIAL_PARAMETERS` | `64` | Most exposed parameters of one material. |
| <a id="limit-max-material-slots"></a>`MAX_MATERIAL_SLOTS` | `32` | Most material slots one object or asset maps. |
| <a id="limit-sky-rotation-max"></a>`SKY_ROTATION_MAX` | `360` | The largest turn a sky's `rotation` takes either way (degrees; one full turn). |

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
