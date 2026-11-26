# Components: Rendering (part 2)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Rendering components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-spline"></a>
## spline — Spline

A curve through points, each with its own width and roll: roads, paths and rivers carved and painted into terrain or written as voxels, meshes and models along it, and a path scripts read (ctx.splines).

- Category: Rendering
- Added: from "+ Add component", starting as `{"points":[{"at":[0,0,0]},{"at":[20,0,0]},{"at":[40,0,0]}]}`
- On prefab objects: yes
- Cannot share an object with [`blockLayer`](components-rendering-1.md#component-blockLayer): a spline is its own object beside the level geometry it shapes
- Cannot share an object with [`terrain`](components-rendering-1.md#component-terrain): a spline is its own object beside the level geometry it shapes
- Cannot share an object with [`architecture`](#component-architecture): a spline is its own object beside the level geometry it shapes
- Icon: river as River, road as Road, else spline (its tooltip counts points)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `points` | list of objects, 2–4096 items | `[{"at":[0,0,0]},{"at":[20,0,0]},{"at":[40,0,0]}]` |  | **Points.** 2-4096 points the curve passes through, in order. (required; Scene handle: spline; scripts read) |
| `points[].at` | vec3 [x, y, z] |  | -100000 – 100000, step 0.1, m | **At.** Metres from the object. (required) |
| `points[].tangent` | vec3 [x, y, z] |  | -100000 – 100000, step 0.1, m | **Tangent.** Direction and pull here (empty: smooth). |
| `points[].width` | number |  | 0 – 1000, step 0.1, m | **Width.** Metres across here (empty: the spline's width). |
| `points[].roll` | number |  | -89 – 89, step 1, deg | **Roll.** Degrees the cross-section turns here, right side up. |
| `closed` | bool | `false` |  | **Closed.** The curve runs back from the last point to the first (3 points or more). (stored only when not the default; scripts read) |
| `width` | number | `4` | 0 – 1000, step 0.1, m | **Width.** Metres across where a point names none. (scripts read) |
| `terrain` | object |  |  | **Terrain.** Shape and paint the terrains it crosses (never a block layer: it stops at its cells). (scripts read) |
| `terrain.shape` | enum: `flatten`, `carve`, `raise`, `none` | `"flatten"` |  | **Shape.** Flatten the ground to it, only lower, only raise, or only paint. (choices: `flatten` = Flatten, `carve` = Carve, `raise` = Raise, `none` = Paint only) |
| `terrain.falloff` | number | `4` | 0 – 1000, step 0.5, m | **Falloff.** Metres past the half width the change fades over. |
| `terrain.depth` | number | `0` | 0 – 1000, step 0.1, m | **Depth.** Metres the centre is cut below the points, shallowing to the edges (a channel). |
| `terrain.offset` | number | `0` | 0 – 1000, step 0.05, m | **Offset.** Metres the whole width lies below the points (a road's bed). |
| `terrain.paint` | object |  |  | **Paint.** A layer painted along it, over the rules, under hand paint. |
| `terrain.paint.layer` | int | `1` | 0 – 255, step 1 | **Layer.** The material layer painted. (required) |
| `terrain.paint.strength` | number | `1` | 0.01 – 1, step 0.05 | **Strength.** How much of the layer at the centre (0-1]. |
| `terrain.paint.width` | number |  | 0 – 1000, step 0.1, m | **Width.** Metres painted fully (empty: the width). |
| `terrain.paint.falloff` | number |  | 0 – 1000, step 0.5, m | **Falloff.** Metres it fades over (empty: the terrain falloff). |
| `terrain.order` | int | `0` | -1000000 – 1000000, step 1 | **Order.** Where splines cross, the higher order wins. |
| `scatter` | object |  |  | **Keep clear of scatter.** No scatter rule places a copy within the band. (scripts read) |
| `scatter.margin` | number | `1` | 0 – 1000, step 0.5, m | **Margin.** Metres past the half width kept clear. |
| `scatter.rules` | list of string, 1–32 chars |  |  | **Rules.** Only these scatter rules (empty: all). |
| `mesh` | object |  |  | **Mesh.** A mesh along it with levels of detail: a profile swept along, or a river's water. It wears Materials slot "spline" (or "*"). (scripts read) |
| `mesh.kind` | enum: `surface`, `water` | `"surface"` |  | **Kind.** A swept profile, or water with flow and foam. |
| `mesh.profile` | list of vec2 [across, up], 2–64 items |  |  | **Profile.** The cross-section, left to right: 64 points at most (empty: flat). |
| `mesh.offset` | number |  | -1000 – 1000, step 0.01, m | **Offset.** Metres above the points (empty: 0.05 for a surface, 0 for water). |
| `mesh.tiling` | number |  | 0.01 – 1000, step 0.5, m | **Tiling.** Metres along one texture repeat covers (empty: the width). |
| `mesh.step` | number | `1` | 0.05 – 100, step 0.05, m | **Step.** Metres between cross-sections. |
| `mesh.collision` | bool |  |  | **Collision.** Colliders from the mesh (empty: a surface yes, water no). |
| `mesh.castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light. |
| `mesh.receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the shadows falling on it. |
| `mesh.flow` | number | `1` | 0 – 100, step 0.1, m/s | **Flow.** Water: its speed along the curve. (applies when `kind` is `water`) |
| `mesh.foam` | number | `1.5` | 0 – 1000, step 0.1, m | **Foam.** Water: metres the foam reaches in from the banks. (applies when `kind` is `water`) |
| `pieces` | list of objects, ≤ 16 items |  |  | **Pieces.** Models repeated along it (fences, posts, walls), at most 16 kinds. (scripts read) |
| `pieces[].asset` | object |  |  | **Asset.** The model repeated. (required) |
| `pieces[].asset.assetId` | asset id (model) |  |  | **Model.** The model file. (required) |
| `pieces[].asset.piece` | string, name, 1–128 chars |  |  | **Piece.** A named piece of the file (empty: all of it). (format name) |
| `pieces[].spacing` | number | `2` | 0.05 – 1000, step 0.1, m | **Spacing.** Metres between pieces along the curve. (required) |
| `pieces[].start` | number | `0` | 0 – 100000, step 0.1, m | **Start.** Metres to the first piece. |
| `pieces[].offset` | vec2 [across, up] |  | -1000 – 1000, step 0.05, m | **Offset.** [across, up] metres from the curve. |
| `pieces[].yaw` | number | `0` | -360 – 360, step 1, deg | **Turn.** Degrees each piece turns about up. |
| `pieces[].upright` | bool | `true` |  | **Upright.** Upright (off: they lean with slope and roll). |
| `pieces[].collide` | bool | `true` |  | **Collides.** Pieces carry their model's _COL colliders. |
| `pieces[].castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light. |
| `voxels` | object |  |  | **Voxels.** Voxels it writes into its scene's voxel world: a road or path (surface, bed, shoulders, air above) or a river (liquid down its depth over its bed). The ground it replaced comes back when it moves or goes; one undo step with the edit. Exports ship the voxels, never this section. |
| `voxels.kind` | enum: `road`, `path`, `river` | `"road"` |  | **Kind.** A road or a path at the curve's height, or a river whose surface is the curve. (required) |
| `voxels.material` | int | `1` | 1 – 4095, step 1 | **Material.** The surface's voxel material, or a river's liquid (its id, 1-4095). (required) |
| `voxels.bed` | object |  |  | **Bed.** What lies under a road (its depth), or a river's bed material and its depth. |
| `voxels.bed.material` | int | `1` | 1 – 4095, step 1 | **Material.** The bed's voxel material (1-4095). (required) |
| `voxels.bed.depth` | number | `1` | > 0, ≤ 1000, step 0.5, m | **Depth.** Metres: under a road's surface; a river's depth (empty bed: 1 m). (required) |
| `voxels.shoulder` | object |  |  | **Shoulders.** How the sides meet the ground: cut down or filled up to a slope. |
| `voxels.shoulder.width` | number | `2` | > 0, ≤ 1000, step 0.5, m | **Width.** Metres past the edge the ground is shaped. (required) |
| `voxels.shoulder.slope` | number | `1` | > 0, ≤ 100, step 0.1 | **Slope.** Metres up or down a metre across (1: 45°). (required) |
| `voxels.clear` | number |  | 0 – 1000, step 0.5, m | **Clear.** Metres of air cleared above it (a road through a hill). |
| `decalLayers` | int | `255` | 0 – 255, step 1 | **Decal layers.** The decal layers projected decals mark it in: a decal marks it when their layers share one (none: no projected decal marks it). Absent: every layer. (stored only when not the default; scripts read) |
| `data` | string, sha256, 64 chars |  |  | **Made.** SHA-256 of the mesh and pieces made from it (written by the host). (written by a tool; scripts read; format sha256) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Spline | spline | points → `points` | local |  |

GameObject menu: Level → Spline, Level → Road, Level → River

<a id="component-architecture"></a>
## architecture — Architecture

Walls, mouldings, floors, vaults, roofs and repeated pieces generated at load from parameters: profiles swept along paths, things repeated along paths, and fills, on one trim sheet (Materials slot "architecture").

- Category: Rendering
- Added: from "+ Add component", starting as `{"profiles":{"wall":{"points":[[0.1,0],[0.1,3],[-0.1,3],[-0.1,0]],"slots":["lower_wall","bevel","upper_wall"]}},"elements":[{"id":"wall","kind":"sweep","path":{"points":[[0,0,0],[6,0,0]]},"profile":"wall"}]}`
- On prefab objects: yes
- Cannot share an object with [`blockLayer`](components-rendering-1.md#component-blockLayer): generated architecture is its own object beside the level geometry
- Cannot share an object with [`terrain`](components-rendering-1.md#component-terrain): generated architecture is its own object beside the level geometry
- Cannot share an object with [`spline`](#component-spline): generated architecture is its own object beside the level geometry
- Icon: building

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `elements` | JSON: `ArchitectureElement[]` ([ArchitectureElement](types-a-c.md#type-architecture-element)) |  |  | **Elements.** Sweeps {id, kind: "sweep", path, profile, openings?}, repeats {id, kind: "repeat", path, spacing, piece} and fills {id, kind: "fill", path, shape, slot}. (required; scripts read) |
| `profiles` | JSON: `Record<string, ArchitectureProfile>` ([ArchitectureProfile](types-a-c.md#type-architecture-profile)) |  |  | **Profiles.** Named cross-sections {points: [[across, up], …], slots: [row per segment], closed?, smooth?, chamfer?}. (scripts read) |
| `overrides` | JSON: `ArchitectureOverride[]` ([ArchitectureOverride](types-a-c.md#type-architecture-override)) |  |  | **Overrides.** Kit models in place of a segment or a corner: [{element, segment \| corner, model: {assetId}}]. (scripts read) |
| `outlines` | JSON: `ArchitectureOutline[]` ([ArchitectureOutline](types-a-c.md#type-architecture-outline)) |  |  | **Outlines.** Rooms (closed) and runs (open) styled by presets: [{id, path, preset, openings?, outside?, storeys?, storeyHeight?, holes?, stairs?, repeatModel?, roomType?, furnishing?, layoutSeed?, pins?}] (the preset's style graph makes their elements; a room with a roomType is furnished by its furnishing set, else the object's, else its block layer's; the block editor's Rooms & buildings draws them). (scripts read) |
| `buildings` | JSON: `ArchitectureBuilding[]` ([ArchitectureBuilding](types-a-c.md#type-architecture-building)) |  |  | **Buildings.** Rooms with a roof: [{id, path, preset, outside?, storeys?, openings?, roof?: {shape, rise?, overhang?, slot?}, interior?: {scene, offset?}}] (the block editor's Rooms & buildings draws them). (scripts read) |
| `masks` | JSON: `Record<string, ArchitectureMask>` ([ArchitectureMask](types-a-c.md#type-architecture-mask)) |  |  | **Masks.** Painted masks presets read: {name: {points: [[x, z, radius, weight], …]}}. (scripts read) |
| `chunkSize` | number | `16` | 4 – 1024, step 1, m | **Chunk size.** Metres a generated chunk covers (one draw per material each). (scripts read) |
| `seed` | int | `0` | 0 – 4294967295, step 1 | **Seed.** Seeds the variation of repeated copies. (scripts read) |
| `ao` | object |  |  | **Baked AO.** Vertex ambient occlusion in inside corners and where walls meet the ground. (scripts read) |
| `ao.strength` | number | `0.6` | 0 – 1, step 0.05 | **Strength.** How dark a right-angled inside corner gets (0: none). |
| `ao.radius` | number | `0.5` | 0.01 – 10, step 0.05, m | **Radius.** Metres the darkening reaches. |
| `lodDistance` | number | `40` | 0 – 100000, step 1, m | **Far level from.** Metres from the camera where detail (mouldings, frames, chamfers) is left out. (scripts read) |
| `castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light. (scripts read) |
| `receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the shadows falling on it. (scripts read) |
| `seeThrough` | bool | `true` |  | **See-through.** Thins to a dither between the camera and a subject (Rendering → See-through). Off: always solid. (stored only when not the default; scripts read) |
| `layer` | string, ≤ 128 chars |  |  | **Block layer.** The block layer object the rooms are drawn on: their walls block its grid walks, rooms are its regions, its wall paint shows on them. (scripts read) |
| `decalLayers` | int | `255` | 0 – 255, step 1 | **Decal layers.** The decal layers projected decals mark it in: a decal marks it when their layers share one (none: no projected decal marks it). Absent: every layer. (stored only when not the default; scripts read) |
| `furnishing` | string, id, 1–64 chars |  |  | **Furnishing set.** The furnishing set (a furnishing-set graph, or an engine starter such as starter-furnishing) that furnishes its rooms drawn on their own that name none; absent: the block layer's. A room is furnished by its room type. (scripts read; format id) |
| `kitId` | kit id |  |  | **Kit.** The kit its rooms and buildings are styled from: the editor offers its presets and pieces. Editor-side: outlines name their presets and openings their models themselves. (scripts read) |
| `scatter` | JSON: `ScatterRule[]` ([ScatterRule](types-m-s.md#type-scatter-rule)) |  |  | **Ground cover.** Cover rules ({cover: true, …}, the scatter rule format) on its floors (flat fills facing up), made near the camera (the Ground cover panel). (written by a tool; scripts read) |
| `baked` | string, sha256, 64 chars |  |  | **Shipped meshes.** SHA-256 of the generated meshes an export shipped (written by the export). (written by a tool; scripts read; format sha256) |

<a id="component-voxelWorld"></a>
## voxelWorld — Voxel world

Streams one of the project's voxel worlds (voxels/<world>/) round the camera while this scene is loaded.

- Category: Rendering
- Added: from "+ Add component", starting as `{"world":"world"}`
- On prefab objects: no
- Rule: The world is the project's folder voxels/<world>/; it streams while the scene holding this object is loaded.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `world` | string, id, 1–64 chars | `"world"` |  | **World.** The world's name: its folder voxels/<world>/ in the project (lower-case letters, digits, - and _). (required; scripts read; format id) |
| `ring` | object |  |  | **Load ring.** Where chunks load round the focus and how far past it they stay (the hysteresis). (scripts read) |
| `ring.loadRadius` | number | `192` | 1 – 100000, step 1, m | **Load radius.** Metres across the ground within which chunks load. |
| `ring.unloadRadius` | number |  | 1 – 100000, step 1, m | **Unload radius.** Metres across the ground past which loaded chunks go (below the load radius: taken as it; empty: the load radius + 32 m). |
| `ring.loadHeight` | number | `96` | 1 – 100000, step 1, m | **Load height.** Metres above and below within which chunks load. |
| `ring.unloadHeight` | number |  | 1 – 100000, step 1, m | **Unload height.** Metres above and below past which loaded chunks go (below the load height: taken as it; empty: the load height + 32 m). |
| `collision` | object |  |  | **Collision ring.** Where loaded chunks have colliders round a focus (never past the load ring). (scripts read) |
| `collision.radius` | number | `48` | 1 – 100000, step 1, m | **Radius.** Metres across the ground. |
| `collision.height` | number | `24` | 1 – 100000, step 1, m | **Height.** Metres above and below. |
| `levels` | object |  |  | **Detail levels.** Where the world is drawn coarser, from full detail near the camera and characters to 2 m voxels far out (level 0 always covers the collision ring). (scripts read) |
| `levels.level0` | number | `64` | 1 – 100000, step 1, m | **Full detail.** Metres across the ground within which the world is drawn at full detail (0.5 m voxels) with its kit pieces; at least the collision radius + 8 m. |
| `levels.level1` | number | `128` | 1 – 100000, step 1, m | **Level 1.** Metres across the ground within which 1 m voxels are drawn; past it, 2 m voxels to the load ring (below full detail: taken as it). |
| `levels.relief` | number | `16` | 0 – 100000, step 1, m | **Relief.** Metres from the focus within which surfaces are drawn with relief: meshed finer and moved by their materials' heights, fading out toward it (0: none; past full detail: taken as it). How fine is the quality level's voxel relief; no tier draws any unless its level sets one. |
| `quality` | map key → object |  |  | **Per quality level.** The distances at a quality level, by the level's id: a scale of the distances above (absent: the level's voxel ring scale), or distances of its own (each one replaces the scaled one). (scripts read) |
| `quality{}.scale` | number |  | 0.25 – 4, step 0.05, × | **Scale.** Every distance above times this at the level. |
| `quality{}.ring` | object |  |  | **Load ring.** Where chunks load round the focus and how far past it they stay (the hysteresis). |
| `quality{}.ring.loadRadius` | number |  | 1 – 100000, step 1, m | **Load radius.** Metres across the ground within which chunks load. |
| `quality{}.ring.unloadRadius` | number |  | 1 – 100000, step 1, m | **Unload radius.** Metres across the ground past which loaded chunks go (below the load radius: taken as it; empty: the load radius + 32 m). |
| `quality{}.ring.loadHeight` | number |  | 1 – 100000, step 1, m | **Load height.** Metres above and below within which chunks load. |
| `quality{}.ring.unloadHeight` | number |  | 1 – 100000, step 1, m | **Unload height.** Metres above and below past which loaded chunks go (below the load height: taken as it; empty: the load height + 32 m). |
| `quality{}.collision` | object |  |  | **Collision ring.** Where loaded chunks have colliders round a focus (never past the load ring). |
| `quality{}.collision.radius` | number |  | 1 – 100000, step 1, m | **Radius.** Metres across the ground. |
| `quality{}.collision.height` | number |  | 1 – 100000, step 1, m | **Height.** Metres above and below. |
| `quality{}.levels` | object |  |  | **Detail levels.** Where the world is drawn coarser, from full detail near the camera and characters to 2 m voxels far out (level 0 always covers the collision ring). |
| `quality{}.levels.level0` | number |  | 1 – 100000, step 1, m | **Full detail.** Metres across the ground within which the world is drawn at full detail (0.5 m voxels) with its kit pieces; at least the collision radius + 8 m. |
| `quality{}.levels.level1` | number |  | 1 – 100000, step 1, m | **Level 1.** Metres across the ground within which 1 m voxels are drawn; past it, 2 m voxels to the load ring (below full detail: taken as it). |
| `quality{}.levels.relief` | number |  | 0 – 100000, step 1, m | **Relief.** Metres from the focus within which surfaces are drawn with relief: meshed finer and moved by their materials' heights, fading out toward it (0: none; past full detail: taken as it). How fine is the quality level's voxel relief; no tier draws any unless its level sets one. |
| `sectionEdge` | int (one of 8, 16, 32) | `16` | step 1 | **Section edge.** Voxels along the edge of the sections a chunk is rebuilt in after an edit: smaller rebuilds less per edit, larger draws fewer pieces. (scripts read) |
| `savedFields` | list of enum: `material`, `role`, `shape`, `wetness`, distinct | `["material","role","shape"]` |  | **Saved fields.** The fields of the game's changes to the world that a game save keeps; the rest are dropped on quit (wetness, by default, which weather sets again). (scripts read) |
| `decalLayers` | int | `255` | 0 – 255, step 1 | **Decal layers.** The decal layers projected decals mark it in: a decal marks it when their layers share one (none: no projected decal marks it). Absent: every layer. (stored only when not the default; scripts read) |
| `blendMetres` | number | `0.25` | 0 – 0.5, step 0.05, m | **Material blend.** Metres over which neighbouring voxel materials blend where neither sets its own blend (0: hard cell lines; the smaller wins where two meet). Changes live, no remesh. (scripts read) |
| `bakeLevel` | number (one of 2, 1, 0.5) | `2` | m | **Brick bake.** How fine the world's far bricks are baked into its cache: 2 m (the cache's own levels), 1 m or 0.5 m (baked too: more disk and a longer bake). Baked to 0.5 m round the camera, the world draws baked bricks past the detail ring; otherwise it keeps its level-1/2 mesh rings there unless Fine build is compute. A world two scenes name is baked to the finer. (scripts read) |
| `fineBuild` | enum: `off`, `compute` | `"off"` |  | **Fine build.** Whether the 0.5 m and 1 m bricks past the detail ring that the bake does not hold are built while playing: off (the mesh rings draw there) or compute (built on the GPU, WebGPU only; WebGL 2 keeps the mesh rings). With a 1 m bake, compute builds only the 0.5 m band. (scripts read) |

<a id="component-voxelStructure"></a>
## voxelStructure — Voxel structure

A building that writes its own grid of a voxel world: change a field and the backend writes its voxels again (one undo with the change), keeping your hand edits where they still fit. Move and turn it as any object; it never tilts.

- Category: Rendering
- Added: never by hand: a structure is made with its definition (createEntity or setComponent with the building, or the structure mode); the backend gives it its grid and writes its voxels
- On prefab objects: no
- Rule: A root object (or in a folder) in the scene holding its world's voxelWorld object; its transform is its grid's place: a position and a turn about the vertical axis only, at unit scale.
- Rule: Its voxels are written by the backend from the definition; hand edits on its grid are kept as overrides; exports ship the voxels, never the definition.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `world` | string, id, 1–64 chars |  |  | **World.** The voxel world it is built in (a voxelWorld object of this scene names it). (required; written by a tool; format id) |
| `grid` | int |  | 1 – 4294967295, step 1 | **Grid.** Its own grid of the world (given by the backend when the structure is made; its files are voxels/<world>/grid-<id>/). (required; written by a tool) |
| `footprint` | JSON: `FootprintPolygon[]` ([FootprintPolygon](types-c-m.md#type-footprint-polygon)) |  |  | **Footprint.** Polygons [{id, points: [[x, z], …]}] with right-angled corners in cells; a second polygon makes an L, a T or a wing. (required) |
| `storeys` | int | `1` | ≥ 1, step 1 | **Storeys.** Floors stacked on the ground floor. (required) |
| `storeyHeight` | int | `6` | ≥ 2, step 1 | **Storey height.** Cells a storey, its floor slab included (6 = 3 m: a 2.5 m room under a floor). (required) |
| `foundationDepth` | int | `2` | ≥ 0, step 1 | **Foundation depth.** Cells of foundation below the ground floor (the building leaves the ground alone: dig or fill the site). (required) |
| `roof` | object |  |  | **Roof.** Its shape, the cells it reaches past the walls and a gable's ridge direction. (required) |
| `roof.shape` | enum: `flat`, `gable`, `hip` | `"gable"` |  | **Shape.** Flat, gable (ridge along the axis) or hip (sloping on every side). (required) |
| `roof.overhang` | int | `1` | ≥ 0, step 1 | **Overhang.** Cells past the walls on every side. (required) |
| `roof.axis` | enum: `x`, `z` | `"x"` |  | **Ridge axis.** The direction a gable's ridge runs (kept for every shape). (required) |
| `materials` | object |  |  | **Materials.** One voxel material a part (a swap rewrites material ids only; painted cells keep their paint). (required) |
| `materials.wall` | int |  | 1 – 4095, step 1 | **Walls.** The voxel material (its id, 1-4095) of the walls and openings; a material's kit draws it. (required) |
| `materials.floor` | int |  | 1 – 4095, step 1 | **Floors.** The voxel material (its id, 1-4095) of the upper floors; a material's kit draws it. (required) |
| `materials.roof` | int |  | 1 – 4095, step 1 | **Roof.** The voxel material (its id, 1-4095) of the roof; a material's kit draws it. (required) |
| `materials.foundation` | int |  | 1 – 4095, step 1 | **Foundation.** The voxel material (its id, 1-4095) of the foundation and ground floor slab; a material's kit draws it. (required) |
| `materials.stair` | int |  | 1 – 4095, step 1 | **Stairs.** The voxel material (its id, 1-4095) of the stairs; a material's kit draws it. (required) |
| `openings` | JSON: `StructureOpening[]` ([StructureOpening](types-s-v.md#type-structure-opening)) |  |  | **Openings.** Doors and windows [{id, polygon, edge, storey, at, width, height, sill, prop?}] on an outside wall, in cells. (required) |
| `stairs` | JSON: `StructureStair[]` ([StructureStair](types-s-v.md#type-structure-stair)) |  |  | **Stairs.** Flights [{id, polygon, from, at: [x, z], facing}] from a storey to the next, two cells wide. (required) |
| `generator` | int |  | ≥ 1, step 1 | **Generator.** The building generator version that last wrote its voxels; a newer engine regenerates every structure in one undoable step (Regenerate structures). (required; written by a tool) |

<a id="component-waterBody"></a>
## waterBody — Water body

A lake or pond whose water the editor writes as liquid voxels: from the object (the seed, inside the basin) through the open cells under the level, bounded by the ground and the reach. Dig or build inside its reach and the shore follows in the same undo step; a leak is flagged, never spilled.

- Category: Rendering
- Added: by a tool: Add component → Water body in the Inspector (the scene’s voxel world, the object’s height as the level, the project’s first liquid material), or createEntity / setComponent with the whole value
- On prefab objects: no
- Rule: A root object in the scene holding its world’s voxelWorld object; its position is the seed, a point inside the basin.
- Rule: The backend writes its liquid voxels when it is made, changed, moved or deleted, and again after a ground edit or a structure written inside its reach (ground, then buildings, then water); exports ship the voxels, never the definition.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `world` | string, id, 1–64 chars |  |  | **World.** The voxel world it fills (a voxelWorld object of this scene names it). (required; written by a tool; format id) |
| `level` | number |  | step 0.5, m | **Level.** The water surface’s height in the scene (metres); the cells under it fill, the top ones partly. (required; Scene handle: height) |
| `material` | int |  | 1 – 4095, step 1 | **Liquid.** The liquid's voxel material (its id, 1-4095). (required) |
| `reach` | number | `256` | > 0, step 1, m | **Reach.** How far from the seed the water may spread (metres, across the ground). Water that would pass it is a leak: flagged, nothing written. |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Level | height | height → `level` | local |  |

<a id="component-voxelPortal"></a>
## voxelPortal — Portal

Open or shut state of a prop standing in an opening of a voxel structure (a door, a pane, a shutter). Shut, it closes its opening exactly for what it stops, whatever the prop's thickness; the opening's voxels never change. A script flips Open; how a door swings is the game's.

- Category: Rendering
- Added: from "+ Add component", starting as `{"open":false,"stops":{"light":true,"sight":true,"walk":true}}`
- On prefab objects: yes
- Rule: Joined to the opening it stands in by its place: a child of the structure object, inside the opening's cells.
- Rule: Open or shut is state, never voxels; a prop with a portal is not stamped into the light by its shape (its opening does the stopping).

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `open` | bool | `false` |  | **Open.** Open: the opening passes light, sight and walkers. Shut: it stops what Stops names. (required; scripts read and write) |
| `stops` | object |  |  | **Stops while shut.** What the shut prop closes its opening to. A pane of glass stops walkers only. (required; scripts read) |
| `stops.light` | bool | `true` |  | **Light.** The opening's cells stop the light's rays whole while shut (off: light passes, as through glass). (required) |
| `stops.sight` | bool | `true` |  | **Sight.** Rooms and their portals read the opening as closed while shut (off: it is seen through). (required) |
| `stops.walk` | bool | `true` |  | **Walkers.** Paths through the opening are marked as through a shut door, which a path query takes only when asked. (required) |
