# Components: Rendering

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Rendering components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-model"></a>
## model — Model

Shows an imported 3D model (a whole file or one named piece of it).

- Category: Rendering
- Added: from "+ Add component" after picking `asset/assetId` (the rest starts as `{"asset":{}}`)
- On prefab objects: yes
- Cannot share an object with [`terrain`](#component-terrain): a terrain is its own level geometry
- Cannot share an object with [`blockLayer`](#component-blockLayer): a block layer is its own level geometry
- Cannot share an object with [`box`](#component-box): an object shows one model or box
- Cannot share an object with [`instances`](#component-instances): an instance set places its own model many times

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `asset` | object |  |  | **Asset.** The model asset. (required; scripts read) |
| `asset.assetId` | asset id (model) |  |  | **Model.** The imported model file. (required) |
| `piece` | string, name, 1–128 chars |  |  | **Piece.** One named piece of a multi-piece file (absent: the whole file). (scripts read; format name) |
| `castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops). (stored only when not the default; scripts read) |
| `receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the realtime shadows falling on it. (stored only when not the default; scripts read) |
| `lightLayers` | int (light layer mask) | `255` | 1 – 255, step 1 | **Light layers.** The light layers it is in: only lights whose light mask shares one of them light it, and it casts shadows only for lights whose shadow caster mask shares one. (stored only when not the default; scripts read) |
| `localLights` | enum: `pixel`, `vertex`, `none` |  |  | **Local lights.** Point, spot and effect lights per pixel, per vertex (diffuse only, cheap) or none (—: as its material says, else per pixel). (scripts read; choices: `pixel` = Per pixel, `vertex` = Per vertex, `none` = None) |

<a id="component-box"></a>
## box — Box

A simple coloured box (blocking out a level, placeholders).

- Category: Rendering
- Added: from "+ Add component", starting as `{"size":[1,1,1],"material":{"color":"#b0b0b0"}}`
- On prefab objects: yes
- Cannot share an object with [`terrain`](#component-terrain): a terrain is its own level geometry
- Cannot share an object with [`blockLayer`](#component-blockLayer): a block layer is its own level geometry
- Cannot share an object with [`model`](#component-model): an object shows one model or box
- Cannot share an object with [`instances`](#component-instances): an instance set places its own model many times

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `size` | vec3 [w, h, d] | `[1,1,1]` | > 0, ≤ 1000000, step 0.1, m | **Size.** Width, height and depth in metres. (Scene handle: box3; scripts read) |
| `material` | object | `{"color":"#b0b0b0"}` |  | **Material.** The box colour (a project material overrides it). (scripts read) |
| `material.color` | color | `"#b0b0b0"` |  | **Colour.** The box colour. |
| `castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops). (stored only when not the default; scripts read) |
| `receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the realtime shadows falling on it. (stored only when not the default; scripts read) |
| `lightLayers` | int (light layer mask) | `255` | 1 – 255, step 1 | **Light layers.** The light layers it is in: only lights whose light mask shares one of them light it, and it casts shadows only for lights whose shadow caster mask shares one. (stored only when not the default; scripts read) |
| `localLights` | enum: `pixel`, `vertex`, `none` |  |  | **Local lights.** Point, spot and effect lights per pixel, per vertex (diffuse only, cheap) or none (—: as its material says, else per pixel). (scripts read; choices: `pixel` = Per pixel, `vertex` = Per vertex, `none` = None) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box3 | size → `size` | local (follows transform) |  |

<a id="component-materials"></a>
## materials — Materials

Which project material each of the object's materials uses ("*": all of them).

- Category: Rendering
- Added: from "+ Add component" after picking `*` (the rest starts as `{}`)
- On prefab objects: yes
- Needs one of [`model`](#component-model), [`box`](#component-box), [`instances`](#component-instances), [`terrain`](#component-terrain), [`spline`](#component-spline), [`architecture`](#component-architecture) on the same object: materials dress a model, a box, an instance set, a terrain (its layered material: "*"), a spline's mesh ("spline") or generated architecture (its trim material: "architecture")

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `materials` | map materialSlot → material id, 1–32 entries |  |  | **Materials.** Material slot → project material. (scripts read and write) |

<a id="component-materialParams"></a>
## materialParams — Material parameters

This object's values for the public parameters of its graph materials (the materials keep their own values elsewhere).

- Category: Rendering
- Added: by a tool: the Materials section of the Inspector (override a public parameter)
- On prefab objects: yes
- Needs one of [`model`](#component-model), [`box`](#component-box), [`instances`](#component-instances), [`terrain`](#component-terrain), [`spline`](#component-spline), [`architecture`](#component-architecture) on the same object: material parameters belong to the materials of a model, a box, an instance set, a terrain, a spline or generated architecture

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `materialParams` | map material id → map identifier → JSON (typed by materialParameter), 1–64 entries, 1–32 entries |  |  | **Material parameters.** Graph material → its overridden parameters. (scripts read and write) |
| `materialParams{}` | map identifier → JSON (typed by materialParameter), 1–64 entries |  |  | **Parameters.** Parameter → value (only public parameters). |

<a id="component-effect"></a>
## effect — Effect

Plays a visual effect (particles) from this object. Visual only: it never changes the game simulation.

- Category: Rendering
- Added: from "+ Add component" after picking `effectId` (the rest starts as `{}`)
- On prefab objects: yes

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `effectId` | effect id |  |  | **Effect.** The project effect. (required; scripts read) |
| `playOnStart` | bool | `true` |  | **Play on start.** Starts when the scene starts (off: a trigger or script plays it). (stored only when not the default; scripts read) |
| `params` | map identifier → JSON (typed by effectParameter), ≤ 32 entries |  |  | **Parameters.** Values for the effect's public parameters (absent: the effect's defaults). (scripts read) |
| `signal` | signal name |  |  | **Play on signal.** Starts (or restarts) the effect when this signal is sent (a switch, trigger or script). (scripts read) |
| `stopSignal` | signal name |  |  | **Stop on signal.** Stops spawning when this signal is sent; living particles finish. (scripts read) |

<a id="component-surface"></a>
## surface — Surface

Simple look overrides for a box or model: colour, roughness, metalness and glow.

- Category: Rendering
- Added: from "+ Add component", starting as `{"color":"#b0b0b0","roughness":0.9,"metalness":0,"emissive":"#000000","emissiveIntensity":0}`
- On prefab objects: yes
- Needs one of [`box`](#component-box), [`model`](#component-model) on the same object: a surface colours a box or a model

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `color` | color | `"#b0b0b0"` |  | **Colour.** Base colour. (scripts read) |
| `roughness` | number | `0.9` | 0 – 1, step 0.05 | **Roughness.** 0: mirror-like, 1: matte. (scripts read) |
| `metalness` | number | `0` | 0 – 1, step 0.05 | **Metalness.** 0: plastic/wood/stone, 1: metal. (scripts read) |
| `emissive` | color | `"#000000"` |  | **Glow colour.** Light it gives off. (scripts read) |
| `emissiveIntensity` | number | `0` | 0 – 4, step 0.1 | **Glow strength.** How strongly it glows. (scripts read) |

<a id="component-instances"></a>
## instances — Instance set

One model placed many times (grass, rocks, trees), stored as a binary transform buffer.

- Category: Rendering
- Added: by a tool: instance brush or instance import
- On prefab objects: no
- Cannot share an object with [`terrain`](#component-terrain): a terrain is its own level geometry
- Cannot share an object with [`box`](#component-box): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`model`](#component-model): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`collider`](components-physics.md#component-collider): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`controller`](components-physics.md#component-controller): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`modelAnimation`](components-animation.md#component-modelAnimation): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`playerSpawn`](components-gameplay.md#component-playerSpawn): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`light`](components-lighting.md#component-light): an instance set is one model placed many times, with nothing of its own
- Cannot share an object with [`blockLayer`](#component-blockLayer): a block layer is its own level geometry

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `asset` | object |  |  | **Asset.** The model placed. (required) |
| `asset.assetId` | asset id (model) |  |  | **Model.** The model file. (required) |
| `asset.piece` | string, name, 1–128 chars |  |  | **Piece.** One named piece of a multi-piece file (absent: the whole file). (format name) |
| `buffer` | string, sha256, 64 chars |  |  | **Buffer.** The SHA-256 of the copies' transforms (written by the brush and import tools). (required; written by a tool; format sha256) |
| `count` | int |  | 1 – 65536, step 1 | **Copies.** How many copies the buffer holds. (required; written by a tool) |
| `castShadow` | bool | `false` |  | **Casts shadows.** Blocks the directional light: casts a realtime shadow (off unless set: foliage and scatter rarely need one). (stored only when not the default) |
| `receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the realtime shadows falling on it. (stored only when not the default) |
| `lightLayers` | int (light layer mask) | `255` | 1 – 255, step 1 | **Light layers.** The light layers it is in: only lights whose light mask shares one of them light it, and it casts shadows only for lights whose shadow caster mask shares one. (stored only when not the default) |
| `localLights` | enum: `pixel`, `vertex`, `none` |  |  | **Local lights.** Point, spot and effect lights per pixel, per vertex (diffuse only, cheap) or none (—: as the material says, else per pixel). (choices: `pixel` = Per pixel, `vertex` = Per vertex, `none` = None) |
| `chunkSize` | number |  | 1 – 4096, step 1, m | **Chunk size.** The copies are drawn in chunks about this wide, each hidden when out of view (absent: the project's Instance chunk size). Each chunk draws one level of detail for its copies unless "Level per copy" is on. |
| `lodPerCopy` | bool | `false` |  | **Level per copy.** Each copy picks its own level of detail by its own distance and size, instead of the level its chunk picks at its centre: truer where a chunk spans a switch point, at one more draw per level in each such chunk. (stored only when not the default) |
| `densityStart` | number |  | 0.0001 – 1, step 0.001 | **Thinning starts at.** Copies start thinning out where they cover less than this share of the screen height (absent: 0.02). |
| `densityEnd` | number |  | 0.0001 – 1, step 0.001 | **Thinnest at.** Below this share of the screen height only the "Thinnest density" share of copies is drawn (absent: 0.005). |
| `densityMin` | number |  | 0 – 1, step 0.05 | **Thinnest density.** The share of copies drawn where they are smallest (1 or absent: no thinning; new sets from the scatter dialog start at 0.25). |

<a id="component-fogVolume"></a>
## fogVolume — Fog volume

A box of fog (mist in a valley, smoke in a room).

- Category: Rendering
- Added: from "+ Add component", starting as `{"size":[6,3,4],"density":0.25,"color":"#dfe7ef","falloff":0.5}`
- On prefab objects: no
- Icon: fog
- Rule: At most 16 fog volumes per scene.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `size` | vec3 [w, h, d] | `[6,3,4]` | > 0, ≤ 1000, step 0.5, m | **Size.** Width, height and depth. (required; Scene handle: box3; scripts read) |
| `density` | number | `0.25` | 0 – 1, step 0.01 | **Density.** How thick the fog is. (required; scripts read) |
| `color` | color | `"#dfe7ef"` |  | **Colour.** The fog colour. (required; scripts read) |
| `falloff` | number | `0.5` | 0 – 1, step 0.05 | **Soft edges.** 0: a hard box, 1: fades from the centre. (scripts read) |
| `heightFalloff` | number | `0` | 0 – 10, step 0.05, 1/m | **Height falloff.** How fast the fog thins with height above the bottom (0: even). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box3 | size → `size` | local |  |

GameObject menu: Light → Fog volume

<a id="component-probeVolume"></a>
## probeVolume — Probe volume

A box the probe bake fills with light probes (Lighting window → Bake probes). Without any, the bake covers the static objects.

- Category: Rendering
- Added: from "+ Add component", starting as `{"size":[16,6,16]}`
- On prefab objects: no
- Icon: fog

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `size` | vec3 [w, h, d] | `[16,6,16]` | > 0, ≤ 100000, step 1, m | **Size.** Width, height and depth (axis-aligned in the world). (required; Scene handle: box3; scripts read) |
| `spacing` | number | `2` | 0.25 – 32, step 0.25, m | **Spacing.** Meters between probes horizontally (half that vertically near the bottom). Absent: the bake's spacing. (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box3 | size → `size` | local |  |

GameObject menu: Light → Probe volume

<a id="component-blockLayer"></a>
## blockLayer — Block layer

A grid of blocks for building levels (terrain, buildings, a tactics map); its cells are painted and edited with block commands.

- Category: Rendering
- Added: from "+ Add component", starting as `{"cellSize":[1,1,1],"bounds":{"min":[0,0,0],"max":[64,16,64]}}`
- On prefab objects: no
- Cannot share an object with [`model`](#component-model): a block layer is its own level geometry
- Cannot share an object with [`box`](#component-box): a block layer is its own level geometry
- Cannot share an object with [`collider`](components-physics.md#component-collider): a block layer is its own level geometry
- Cannot share an object with [`controller`](components-physics.md#component-controller): a block layer is its own level geometry
- Cannot share an object with [`instances`](#component-instances): a block layer is its own level geometry
- Cannot share an object with [`terrain`](#component-terrain): a block layer is its own level geometry
- Cannot share an object with [`spline`](#component-spline): a block layer is its own level geometry
- Cannot share an object with [`architecture`](#component-architecture): a block layer is its own level geometry
- Rule: A block layer is a root object (a folder may hold it) at identity rotation and unit scale; at most 16 layers with cells per scene.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `cellSize` | vec3 [x, y, z] | `[1,1,1]` | 0.05 – 64, step 0.05, m | **Cell size.** Metres per cell along x, y and z (a half-metre step: [1, 0.5, 1]). Cells are square from above: x and z are one value, only the height y differs. (required) |
| `bounds` | JSON |  |  | **Bounds.** The cells the layer may hold: {min: [x, y, z], max: [x, y, z]} (max exclusive; at most 1024 × 256 × 1024 cells, within ±4096 / ±1024). (required) |
| `metadataOnly` | bool | `false` |  | **Metadata only.** Cells carry data only (deploy zones, no-walk areas, trigger ids): no blocks, nothing drawn. |
| `collision` | bool | `true` |  | **Collision.** The blocks' collision shapes are colliders (3D projects). |
| `castShadow` | bool | `true` |  | **Cast shadows.** The blocks cast the directional light's shadow. |
| `receiveShadow` | bool | `true` |  | **Receive shadows.** Shadows fall on the blocks. |
| `maxSlope` | number |  | 1 – 89, step 1, deg | **Max slope.** The steepest part of the layer's surface that counts as ground: characters do not walk up steeper slopes whatever their own limit, and surface queries call steeper ground not walkable (absent: each character's own limit; queries use the project's max_slope_climb_deg). |
| `smoothAngle` | number | `0` | 0 – 180, step 1, deg | **Smoothing angle.** The crease angle of the layer's tops: where tops meet at the same height at less than this angle (across cells and chunk edges) they are shaded smooth; sharper edges, cliffs and walls stay hard. 0: flat-shaded tops. The collision shape does not change. |
| `topSubdivision` | int (one of 1 = 1 × 1, 2 = 2 × 2) | `1` |  | **Top subdivision.** How finely sloped tops are drawn: 1 × 1 is the corners' two flat triangles; 2 × 2 cuts each top in four with the inner heights blended from the corners, so hills read as rolling ground. The collision shape stays the corners' two triangles. |
| `wallPaint` | bool | `false` |  | **Wall paint.** Walls have paint of their own (Paint mode, Walls): an unpainted wall shows material layer 2, the top's paint wraps over the lip and fades one row down, and wall faces get vertices about every 0.5 m so the paint shows. Off: walls show the paint of the top above them. |
| `lightLayers` | int (light layer mask) | `255` | 1 – 255, step 1 | **Light layers.** The light layers its blocks are in: only lights whose light mask shares one of them light the blocks, and the blocks cast shadows only for lights whose shadow caster mask shares one. (stored only when not the default) |
| `cutaway` | object |  |  | **Cut-away.** What is hidden from the view while the camera's target (or a subject a script names) is under or inside it: roofs and upper floors over the player, the walls round the room it is in, the floors above a dungeon level. Drawing only: collision, queries and shadows stay. |
| `cutaway.regions` | list of objects, ≤ 256 items |  |  | **Regions.** Regions of the layer whose cells are hidden while the subject stands under them (within their columns, below their lowest row), or, with When, while it is inside another region. |
| `cutaway.regions[].region` | string, 1–64 chars |  |  | **Region.** The region whose cells are hidden. (required) |
| `cutaway.regions[].when` | string, 1–64 chars |  |  | **When inside.** Hide it while the subject is inside this region instead (a room round the player); empty: while the subject is under it. |
| `cutaway.planes` | list of int, ≤ 256 items, distinct |  |  | **Height planes.** Rows: every cell from the row up is hidden while the subject is below it (the floors above a level). |
| `cutaway.fade` | number | `0.25` | 0 – 10, step 0.05, s | **Fade.** Seconds a cut-away takes to fade out or back in (0: at once). |
| `kits` | list of objects, ≤ 257 items |  |  | **Kits.** The kits it shows: its block types drawn as each type's swap under the kit (the Kits of the block type), without changing the cells — a dungeon and its burnt state share one layout. One kit for the whole layer and one per region at most; a region's wins where it swaps a block. Scripts change them with ctx.grid.setKit. |
| `kits[].kit` | string, id, 1–64 chars |  |  | **Kit.** A kit name the block types swap by. (required; format id) |
| `kits[].region` | string, 1–64 chars |  |  | **Region.** The region it covers (empty: the whole layer). |
| `walk` | object |  |  | **Walk.** How the layer is walked by ctx.grid's walk queries (walkNeighbours, path, reachable) unless a query sets its own, and the region the Problems check walks from: places to stand there that cannot be walked to are listed. |
| `walk.from` | string, identifier, 1–64 chars |  |  | **From region.** The region the Problems check walks from (empty: no check). (format identifier) |
| `walk.maxStep` | number |  | 0 – 64, step 0.05, m | **Step up.** How far a step may rise where two tops meet (absent: half a cell height). |
| `walk.maxDrop` | number |  | 0 – 64, step 0.05, m | **Step down.** How far a step may drop (absent: half a cell height). |
| `walk.headroom` | number |  | 0 – 64, step 0.05, m | **Headroom.** The free height a place to stand needs above it, and under which no wall or closed door may stand across a step (absent: one cell height). |
| `walk.field` | string, identifier, 1–32 chars |  |  | **Walkable field.** A yes/no cell field: only tops whose cell has it on are walked (empty: every top). (format identifier) |
| `walk.diagonal` | bool | `false` |  | **Diagonal.** Steps across cell corners too, where both ways round the corner walk. |
| `rules` | JSON: `SurfaceRule[]` ([SurfaceRule](types-p-w.md#type-surface-rule)) |  |  | **Material rules.** Layers 0-3 by slope, height, cavity, noise, top or wall, block type and cell metadata, painted at every vertex when chunks are meshed: [{layer, strength?, face?, height?, slope?, cavity?, noise?, weight?, blocks?, meta?}] (the Blocks tools' Rules). Hand paint stays over them. |
| `scatter` | JSON: `ScatterRule[]` ([ScatterRule](types-p-w.md#type-scatter-rule)) |  |  | **Scatter rules.** Models placed on the tops by rules, their copies baked per chunk by the layer's edits: [{id, asset, density, spacing?, scale?, yaw?, align?, sink?, seed?, height?, slope?, cavity?, noise?, layers?, blocks?, meta?, exclude?, castShadow?, chunkSize?, density falloff, lodPerCopy?, impostorSize?, collide?}] (the Blocks tools' Scatter). The scatter brush's hand edits stay over them. |
| `vertexAO` | number | `0` | 0 – 1, step 0.05 | **Corner shading.** How dark the blocks' corners and creases get from per-vertex ambient occlusion: where neighbouring blocks close a corner in, that much of its indirect light is taken away. 0: none. Cheap (worked out when a chunk is meshed); a layer with baked lightmaps has its shading in the bake. |
| `streaming` | object |  |  | **Streaming.** Rings around the camera (in Play and the export) within which its chunks are loaded, measured across the ground; past them they are let go, within the project's streaming budget (streaming_budget_mb). Empty: everything loaded. |
| `streaming.render` | number | `256` | 1 – 100000, step 1, m | **Render ring.** Metres within which chunks are drawn. (required) |
| `streaming.collision` | number |  | 1 – 100000, step 1, m | **Collision ring.** Metres around the camera, its target and every character within which chunks have colliders (empty: the render ring). |
| `streaming.scatter` | number |  | 1 – 100000, step 1, m | **Scatter ring.** Metres within which stored scatter is drawn (empty: the render ring). |
| `streaming.live` | number |  | 1 – 100000, step 1, m | **Live ring.** Metres around the camera, its target and every character within which live blocks' objects are in the game (empty: the collision ring). |
| `streaming.hysteresis` | number |  | 0 – 10000, step 1, m | **Hysteresis.** Metres something loaded may be past its ring before it is let go (empty: a tenth of each ring). |

<a id="component-terrain"></a>
## terrain — Terrain

A heightfield of square tiles for landscape reaching the horizon, sculpted, painted and cut with the terrain commands (editTerrain).

- Category: Rendering
- Added: by a tool: terrain commands (editTerrain)
- On prefab objects: no
- Cannot share an object with [`model`](#component-model): a terrain is its own level geometry
- Cannot share an object with [`box`](#component-box): a terrain is its own level geometry
- Cannot share an object with [`collider`](components-physics.md#component-collider): a terrain is its own level geometry
- Cannot share an object with [`controller`](components-physics.md#component-controller): a terrain is its own level geometry
- Cannot share an object with [`instances`](#component-instances): a terrain is its own level geometry
- Cannot share an object with [`blockLayer`](#component-blockLayer): a terrain is its own level geometry
- Cannot share an object with [`spline`](#component-spline): a terrain is its own level geometry
- Cannot share an object with [`architecture`](#component-architecture): a terrain is its own level geometry

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `tileSamples` | int (one of 17, 33, 65, 129, 257, 513, 1025) | `257` | 17 – 1025, step 1 | **Tile samples.** Samples along a tile side: 17, 33, 65, 129, 257, 513, 1025 (2^n + 1; neighbouring tiles share their edge samples). Fixed once tiles hold data. (required) |
| `spacing` | number | `1` | 0.05 – 64, step 0.05, m | **Spacing.** Metres between samples. (required) |
| `heightRange` | vec2 [low, high] | `[-128,384]` | -100000 – 100000, step 1, ascending, m | **Height range.** The lowest and highest height a sample can hold, metres above the object (16-bit steps between them: a narrower range is finer). (required) |
| `tiles` | JSON: `TerrainTileRef[]` ([TerrainTileRef](types-p-w.md#type-terrain-tile-ref)) |  |  | **Tiles.** The tiles: [{x, z, data?, scatter?, base?}], data the SHA-256 of the tile's heights, layers, holes and paint (absent: flat at 0 m), scatter of its scatter rules' copies, base of the tile as made by hand before splines shaped it (written by the terrain commands). (required; written by a tool) |
| `lodDistance` | number |  | 1 – 100000, step 1, m | **Detail distance.** Metres the finest level of detail reaches from the camera; each coarser level reaches twice as far (a quality level's LOD bias divides it). Empty: the nearest the tile size allows, also the least it takes. |
| `collision` | bool | `true` |  | **Collision.** The tiles are heightfield colliders in a 3D project; off for scenery the player never reaches. |
| `macroDistance` | number |  | 1 – 100000, step 10, m | **Macro distance.** Metres past which each tile is drawn from its macro texture — its look baked from above (albedo and normal, a few metres a texel) — instead of its material's layers: two texture reads instead of a dozen for the far ground. Empty: the layers everywhere. |
| `rules` | JSON: `SurfaceRule[]` ([SurfaceRule](types-p-w.md#type-surface-rule)) |  |  | **Material rules.** Layers by slope, height, cavity and noise, baked into the tiles: [{layer, strength?, face?, height?, slope?, cavity?, noise?, weight?}] (set and baked by Material rules in the terrain tools, or editTerrain bake; hand paint stays over them). (written by a tool) |
| `scatter` | JSON: `ScatterRule[]` ([ScatterRule](types-p-w.md#type-scatter-rule)) |  |  | **Scatter rules.** Models placed by rules, their copies baked per tile: [{id, asset, density, spacing?, scale?, yaw?, align?, sink?, seed?, height?, slope?, cavity?, noise?, layers?, exclude?, castShadow?, chunkSize?, density falloff, lodPerCopy?, impostorSize?, collide?}] (set and baked by Scatter rules in the terrain tools, or editTerrain bake; the scatter brush's hand edits stay over them). (written by a tool) |
| `layers` | JSON: `TerrainLayer[]` ([TerrainLayer](types-p-w.md#type-terrain-layer)) |  |  | **Edit layers.** Layers over the hand-made ground, applied in order and combined into the tiles: [{id, kind: stamps\|erosion\|splines\|blocks, name?, enabled?, strength?, stamps?: [{asset, at, size, rotation?, height, mode?, y?, falloff?}], tiles?, settings?, blockLayers?, mode?: cut\|flatten, blend?, paint?}] (the Layers list in the terrain tools; erosion is run by editTerrain erode; a blocks layer makes the ground meet block layers: their border followed over blend metres, cut away or flattened under them, their paint carried across; absent: one base layer with the splines on top). (written by a tool) |
| `streaming` | object |  |  | **Streaming.** Rings around the camera (in Play and the export) within which its tiles are loaded, measured across the ground; past them they are let go, within the project's streaming budget (streaming_budget_mb). Empty: everything loaded. |
| `streaming.render` | number | `1500` | 1 – 100000, step 1, m | **Render ring.** Metres within which tiles are drawn at full detail (never less than where they reach their coarsest level); past it they are drawn from the overview a build ships. (required) |
| `streaming.collision` | number |  | 1 – 100000, step 1, m | **Collision ring.** Metres around the camera, its target and every character within which tiles have colliders (empty: the render ring). |
| `streaming.scatter` | number |  | 1 – 100000, step 1, m | **Scatter ring.** Metres within which stored scatter is drawn (empty: the render ring). |
| `streaming.hysteresis` | number |  | 0 – 10000, step 1, m | **Hysteresis.** Metres something loaded may be past its ring before it is let go (empty: a tenth of each ring). |
| `uvOrigin` | vec2 [x, z] |  | -10000000 – 10000000, step 1, m | **Texture origin.** The world x, z its material's texture coordinates count from (empty: the object's position). A terrain with a blocks layer takes the block layer's origin, so textures line up across the border. |
| `overview` | JSON |  |  | **Overview.** The SHA-256 of every tile at its coarsest level, which a streamed terrain draws past its render ring (written by a build, never in the editor). (written by a tool) |

<a id="component-spline"></a>
## spline — Spline

A curve through points, each with its own width and roll: roads, paths and rivers carved and painted into terrain, meshes and models along it, and a path scripts read (ctx.splines).

- Category: Rendering
- Added: from "+ Add component", starting as `{"points":[{"at":[0,0,0]},{"at":[20,0,0]},{"at":[40,0,0]}]}`
- On prefab objects: no
- Cannot share an object with [`blockLayer`](#component-blockLayer): a spline is its own object beside the level geometry it shapes
- Cannot share an object with [`terrain`](#component-terrain): a spline is its own object beside the level geometry it shapes
- Cannot share an object with [`architecture`](#component-architecture): a spline is its own object beside the level geometry it shapes

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
| `mesh.profile` | JSON |  |  | **Profile.** The cross-section, left to right: [[across, up], …], across in half widths (-1 to 1), up in metres; 2-64 points (empty: flat). |
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
- Cannot share an object with [`blockLayer`](#component-blockLayer): generated architecture is its own object beside the level geometry
- Cannot share an object with [`terrain`](#component-terrain): generated architecture is its own object beside the level geometry
- Cannot share an object with [`spline`](#component-spline): generated architecture is its own object beside the level geometry

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `elements` | JSON: `ArchitectureElement[]` ([ArchitectureElement](types-a-d.md#type-architecture-element)) |  |  | **Elements.** Sweeps {id, kind: "sweep", path, profile, openings?}, repeats {id, kind: "repeat", path, spacing, piece} and fills {id, kind: "fill", path, shape, slot}. (required; scripts read) |
| `profiles` | JSON: `Record<string, ArchitectureProfile>` ([ArchitectureProfile](types-a-d.md#type-architecture-profile)) |  |  | **Profiles.** Named cross-sections {points: [[across, up], …], slots: [row per segment], closed?, smooth?, chamfer?}. (scripts read) |
| `overrides` | JSON: `ArchitectureOverride[]` ([ArchitectureOverride](types-a-d.md#type-architecture-override)) |  |  | **Overrides.** Kit models in place of a segment or a corner: [{element, segment \| corner, model: {assetId}}]. (scripts read) |
| `outlines` | JSON: `ArchitectureOutline[]` ([ArchitectureOutline](types-a-d.md#type-architecture-outline)) |  |  | **Outlines.** Rooms (closed) and runs (open) styled by presets: [{id, path, preset, openings?, outside?, storeys?, storeyHeight?, holes?, stairs?}] (the preset's style graph makes their elements; a block layer's Rooms tool draws them). (scripts read) |
| `buildings` | JSON: `ArchitectureBuilding[]` ([ArchitectureBuilding](types-a-d.md#type-architecture-building)) |  |  | **Buildings.** Rooms with a roof: [{id, path, preset, outside?, storeys?, openings?, roof?: {shape, rise?, overhang?, slot?}, interior?: {scene, offset?}}] (the Rooms tool draws them). (scripts read) |
| `masks` | JSON: `Record<string, ArchitectureMask>` ([ArchitectureMask](types-a-d.md#type-architecture-mask)) |  |  | **Masks.** Painted masks presets read: {name: {points: [[x, z, radius, weight], …]}}. (scripts read) |
| `chunkSize` | number | `16` | 4 – 1024, step 1, m | **Chunk size.** Metres a generated chunk covers (one draw per material each). (scripts read) |
| `seed` | int | `0` | 0 – 4294967295, step 1 | **Seed.** Seeds the variation of repeated copies. (scripts read) |
| `ao` | object |  |  | **Baked AO.** Vertex ambient occlusion in inside corners and where walls meet the ground. (scripts read) |
| `ao.strength` | number | `0.6` | 0 – 1, step 0.05 | **Strength.** How dark a right-angled inside corner gets (0: none). |
| `ao.radius` | number | `0.5` | 0.01 – 10, step 0.05, m | **Radius.** Metres the darkening reaches. |
| `lodDistance` | number | `40` | 0 – 100000, step 1, m | **Far level from.** Metres from the camera where detail (mouldings, frames, chamfers) is left out. (scripts read) |
| `castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light. (scripts read) |
| `receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the shadows falling on it. (scripts read) |
| `layer` | string, ≤ 128 chars |  |  | **Block layer.** The block layer object the rooms are drawn on: their walls block its grid walks, rooms are its regions, its wall paint shows on them. (scripts read) |
| `baked` | string, sha256, 64 chars |  |  | **Shipped meshes.** SHA-256 of the generated meshes an export shipped (written by the export). (written by a tool; scripts read; format sha256) |
