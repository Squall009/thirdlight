# Components: Rendering (part 2)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Rendering components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-spline"></a>
## spline — Spline

A curve through points, each with its own width and roll: roads, paths and rivers carved and painted into terrain, meshes and models along it, and a path scripts read (ctx.splines).

- Category: Rendering
- Added: from "+ Add component", starting as `{"points":[{"at":[0,0,0]},{"at":[20,0,0]},{"at":[40,0,0]}]}`
- On prefab objects: no
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
| `decalLayers` | int | `255` | 0 – 255, step 1 | **Decal layers.** The decal layers projected decals mark it in: a decal marks it when their layers share one (none: no projected decal marks it). Absent: every layer. (stored only when not the default; scripts read) |
| `data` | string, sha256, 64 chars |  |  | **Made.** SHA-256 of the mesh and pieces made from it (written by the host). (written by a tool; scripts read; format sha256) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Spline | spline | points → `points` | local |  |

GameObject menu: Level → Spline (3D), Level → Road (3D), Level → River (3D)

<a id="component-architecture"></a>
## architecture — Architecture

Walls, mouldings, floors, vaults, roofs and repeated pieces generated at load from parameters: profiles swept along paths, things repeated along paths, and fills, on one trim sheet (Materials slot "architecture").

- Category: Rendering
- Added: from "+ Add component", starting as `{"profiles":{"wall":{"points":[[0.1,0],[0.1,3],[-0.1,3],[-0.1,0]],"slots":["lower_wall","bevel","upper_wall"]}},"elements":[{"id":"wall","kind":"sweep","path":{"points":[[0,0,0],[6,0,0]]},"profile":"wall"}]}`
- On prefab objects: no
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
| `baked` | string, sha256, 64 chars |  |  | **Shipped meshes.** SHA-256 of the generated meshes an export shipped (written by the export). (written by a tool; scripts read; format sha256) |
