# Phase 30 — Level building: blocks completed, terrain, and the handoff

Goal: a game builds its whole level in the engine. Block layers carry the
detailed area the player moves through (exteriors, dungeons, interiors) with
live blocks, edge pieces and auto-connecting kits. Around it, a separate,
fast, chunked terrain reaches the horizon, so a level feels large at little
cost. One rule system paints materials and places detail on both, baked
offline so the runtime only reads results. Splines cut roads, paths and
rivers into the ground. Rooms, buildings, pipes, rails and fences are drawn
as outlines and generated from parameters with one trim-sheet material, so a
level is restyled by swapping a sheet and a preset. All of it holds 60 fps at
1080p on an integrated GPU.

Read `docs/roadmap.md` (principles 1, 1b and 7) first. Phase 30 starts after
phase 29 (scalable lighting): it uses 29's probes, cached shadows, LOD
settings, density falloff and static batching. Requests: Skyforge Tactics
E81, E82, and the leftovers of E8, E37, E39, E40, E54 and E61
(`~/projects/skyforge-tactics/docs/engine-gaps.md`; mapping in §7), and the
owner. The engine never reads the game repo; the ids only trace a request
back. Nothing here is fitted to one game: the block-area size, cell size and
view distance are each game's own data.

## 1. Owner decisions (2026-10-02 / 2026-10-03)

- **Foliage gets its own rules and best practice** (owner, 2026-10-05). Instanced foliage casts no shadow by default (phase 28c). Wind makes foliage dynamic for shadow casting, so terrain scatter needs a foliage policy that keeps it cheap, for example:
  - no shadows past a short distance;
  - contact or blob shadows instead of map shadows;
  - wind only in the near rings;
  - density falloff (29.6).
  
  Write the policy into this phase's design, measure it, and document it as best practice for games.

- **Terrain is its own component, used closely with blocks.** Block layers
  stay the tool for authored structure. Terrain is a heightfield for
  landscape. A typical scene puts a block area where the player moves on top
  of terrain that reaches the horizon.
- **Rules and scatter apply to both.** Material rules and detail placement
  read surface samples, not "terrain" or "blocks", so the same rules paint and
  dress block layers and terrain.
- **Rules are baked offline.** Rules are evaluated in a worker or a compute
  pass when the inputs change, into weight maps and instance sets. The runtime
  never evaluates a rule per frame.
- **No triplanar by default.** It triples texture reads. Steep ground uses
  cliff layers and scattered rock meshes; biplanar is an opt-in per layer.
- **Splines are a must:** roads, paths, rivers, and the other modern tools
  (edit layers, stamps, erosion).
- **Floating origin is out of this phase.** None of the planned games is
  large enough to need it.
- **Performance comes first in every item, with soft targets** (roadmap
  principle 7): each item is measured on this host's Iris Xe at 1080p and
  records its numbers; a missed target becomes a follow-up note, never a
  reason to throw away an item.
- **Target:** 60 fps at 1080p on an integrated GPU (as phase 29).
- **Generated architecture** (owner, 2026-10-06; Part D). Fast, passable
  art for a solo developer: draw outlines, the engine generates the
  architecture, props are placed by hand.
  - **One trim sheet, not a texture array.** One 2D sheet (albedo, normal,
    ORM: 3 samples) tiling in both directions; each row is generated as its
    own repeated strip of geometry. This costs a fraction of an array's
    memory, gives the vertex density that vertex-painted grime and wetness
    need, and lets rows have unequal heights.
  - **No lightmaps.** Probes, vertex-colour AO from the generator, rooms as
    light layers and portals, no shadows by default.
  - **Parameters are exported, geometry is generated at load.** It must be
    fast enough that the player never waits on it (§5).
  - **Style graphs like Substance Designer:** operators with exposed
    sliders, presets that derive from presets, sliders driven by painted
    world masks.
  - **Buildings:** one definition generates the exterior and its interior,
    with door links between them.

## 2. Where things stand (checked at `62999a04`, 2026-10-03)

- **Block layers** (`project-model/src/block-layers.ts`, `block-grid.ts`,
  `block-mesh.ts`; editor `viewport/block-editor.ts`, `session/block-brush.ts`):
  16 × 16-column chunks in XZ, run-length columns with a per-chunk palette,
  one JSON file per chunk; types with shapes, ≤ 8 weighted variants (model,
  prefab look or colour), footprints ≤ 8 cells, rotations, materials,
  metadata; corner heights on single-cell `full` tops (0–4 cells, 1/64
  steps); 14 edit kinds through one `editBlocks` command; per-chunk merged
  meshes with hidden-face removal, chunk LOD from the models' own levels,
  per-chunk lightmaps; per-chunk trimesh colliders.
- **Block limits that are sample-sized caps:** `layerCells` 262,144 and
  `sceneCells` 1,048,576 (`block-layers.ts:201-222`); Skyforge measured one
  layer at about 200 × 200 m of hills (E37).
- **Block undo** stores the layer's whole `BlockLayerData` before and after
  (`commands/src/types.ts:567`), so its cost grows with the layer, not the
  edit. Exports write scenes as pretty-printed JSON with blocks inline
  (`exporter/src/content-closure.ts:815-823`); Skyforge's content.json is 6 MB
  for one village.
- **A prefab variant** contributes only its model's geometry to the merged
  mesh; there are no live entities per cell, no edge pieces, and variants are
  random by weight only (E81).
- **Paint** is one 17 × 17 lattice per chunk (`block-paint.ts`), sampled at
  every vertex, walls included: walls show their column's top paint, with no
  wall default and no paint of their own (E40).
- **No terrain, no heightfield collider** (Rapier is `0.20.0`; the JS API has
  `ColliderDesc.heightfield(nrows, ncols, heights, scale)` with no hole
  flags; `0.21.0` is out), **no mesh simplifier** (`asset-pipeline/src/meshopt.ts`
  only decodes), **no rule placement** (scatter is a uniform rectangle or the
  instance brush), **no splines**, **no world streaming** (phase 26 streams
  assets, textures and whole scenes, not world cells).
- **What exists to build on:** texture arrays, `heightBlend`, `triplanar`,
  `noise`, `worldUV`, `cameraDistance` nodes; KTX2 with mip streaming
  (`three-adapter/src/texture-streaming.ts`); the instance brush's
  deterministic hashed cells (`project-model/src/instance-brush.ts`); the
  sculpt falloff (`block-sculpt.ts`); attribute-instanced chunks with
  per-chunk LOD (`three-adapter/src/instancing.ts`); the refcounted resource
  manager; batched static collider add/remove (`runtime/src/grid.ts:446-480`);
  scene fog (linear/exp2, no height) and fog volumes with `heightFalloff`
  (`descriptor-components.ts:687`); GPU compute (effects).
- **After 28b:** square cells, world-aligned block UVs in metres, per-layer
  material settings, KTX2-built arrays, bulk meshing in a worker.
- **After 29:** probe grids over static bounds, cached static shadows over a
  fixed extent, light layers, LOD bias and hysteresis, instance density
  falloff, static batching.

## 3. How other engines do it (from their documentation; 30.0 re-reads the current pages before design)

| Topic | Unity | Unreal | Godot 4 | Thirdlight after phase 30 |
|---|---|---|---|---|
| Terrain data | Terrain: heightmap + splat (alpha) maps per terrain tile, terrain layers, holes [1] | Landscape: components and sections, heightmap and weight maps, edit layers, holes [2] | None built in; the Terrain3D addon uses clipmaps over region textures [3] | Heightfield tiles (R16 heights, weight maps, holes) stored as binary blobs |
| Terrain LOD | Quadtree patches with pixel-error LOD | Per-component LOD with morphing | Clipmap (Terrain3D) | CDLOD: quadtree, one shared grid mesh, vertex morphing [4] |
| Materials | Terrain layers, up to 4 per pass | Landscape layer blend, runtime virtual texturing | Terrain3D: texture arrays, auto-shading by slope | Texture arrays, height blend, rule-baked weights, macro texture far away |
| Detail | Trees and detail meshes painted, density settings | Procedural foliage spawners; grass by layer | MultiMesh | Rule-baked instance sets plus GPU ground cover by distance |
| Splines | Splines package; terrain tools via add-ons | Landscape splines deform and paint, place meshes | Path3D, CSG | One spline component: carve, paint, clear, mesh |
| Streaming | Manual (tiles as scenes) | World Partition cells | Manual | Tile rings around the camera |
| Generated architecture | ProBuilder shapes; theme-swappable layouts only as add-ons (Dungeon Architect) | BSP brushes (now a blockout tool), modeling tools, PCG graphs | CSG nodes (prototyping) | Path × profile sweeps and fills from style presets on one trim sheet, generated at load |

[1] https://docs.unity3d.com/Manual/script-Terrain.html
[2] https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-outdoor-terrain-in-unreal-engine
[3] https://github.com/TokisanGames/Terrain3D
[4] F. Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps" (2010), https://github.com/fstrugar/CDLOD

## 4. Items

Four parts in order: **A** completes block layers (the handoff depends on
them), **B** builds terrain, **C** joins the two, **D** generates architecture
from outlines. Within each part the order
is data and commands → runtime and adapter → editor → export → tests. A file
over 2,000 lines is split before it grows. Format changes take one schema
version with an upgrade on open. Every item records its numbers against the
soft targets (§5) in its progress row. Every editor change has a Playwright
test against a real backend; drawing changes check pixels on both renderers.

### Part A — blocks completed

| Item | What |
|---|---|
| 30.0 | This plan and its rows in `docs/STATUS.md` and `docs/roadmap.md`. The three.js release check (a patch is taken here after reading its notes; a minor is its own item). Rapier `0.21` release notes read for heightfield changes (holes, flags) before 30.11 picks a collision shape. Re-read §3's sources. |
| 30.1 | **Measure first.** Two neutral perf classes in `tools/perf`, 1080p uncapped, GPU pass timings, p50/p95/p99, both renderers, on the Iris Xe (and the owner's Ryzen APU laptop recorded): (a) **block area**: a ~100 × 100 m block layer with props, foliage instances and a few local lights; (b) **landscape**: the same block area on terrain reaching a few kilometres, with scatter and fog (filled in once 30.11 lands). The before numbers for (a) go in §6. The soft targets of §5 are checked against these classes. |
| 30.2 | **Groundwork.**<br>• **Binary chunk data:** block chunks (and later terrain tiles) are stored and exported as compact binary (typed arrays, zstd), not pretty-printed JSON; the editor still reads and diffs them through `queryBlocks`.<br>• **Undo per chunk:** the `editBlocks` inverse stores only the chunks it changed.<br>• **No cell caps:** `layerCells` and `sceneCells` go (no per-project count caps). What bounds a layer is memory: a block-memory figure in diagnostics and the streaming budget of 30.16. Per-command bounds (`BLOCK_EDIT_MAX_CELLS`, the 64 KiB command cap) stay; they protect a single request.<br>• **Mesh simplifier:** the asset pipeline gains meshoptimizer's simplifier (pinned), so generated meshes (spline meshes, HLOD, impostor proxies) and models without authored levels can get LODs. |
| 30.3 | **Live blocks** (E81.1). A block type can spawn its prefab as a real entity per cell (scripts, movers, doors, triggers, lights, animators, sounds). The layer places, removes and pools these entities with the cell, saves their state with the cell (the save diff of E8), and hands their static parts to the chunk mesh so they still merge. Spawned entities get runtime ids and are not written into the scene file, so a layer's live blocks never use up the scene's id space (E37). Runtime `ctx.grid` set/clear of such a cell spawns or despawns the entity in the same step. |
| 30.4 | **Edge pieces** (E81.2). A block type can be `placement: 'edge'`: it sits on the edge between two cells (walls, doors, windows, fences, railings), stored per cell edge in the chunk. Each edge piece declares whether it blocks passage; an open/closed state (a live door) can change it at run time. `ctx.grid` reads an edge's piece and blocked state, so grid movement and pathfinding respect walls. Editor: an edge brush that snaps to the nearest cell edge; line and rectangle draw edges along their outline. |
| 30.5 | **Auto-connect** (E81.3, E8 autotiling). A block type (cell or edge) can carry connection rules: which neighbours count as connected, and which variant (straight, corner, T, cross, end, cap, base) and rotation each neighbour mask picks. Painting "wall" resolves to the right pieces; a neighbour change re-resolves only the affected cells. Resolution is a pure function of the cell and its neighbours, so meshing stays deterministic and replays hold. |
| 30.6 | **Side-face paint and wetness** (E81.5, E40 leftovers). Paint gets wall points of its own (0.5 m points on exposed wall faces, stored with the chunk), so walls carry dirt, moss and soot up their faces and blend two wall materials across block borders. Unpainted walls show slot 1, tops slot 0. The top edge's paint wraps over the lip onto the wall's top row and fades one row down. Wetness gains normal flattening and pooling by height, plus a scene-wide wetness parameter for rain (E17's environment). Paint survives height edits, as now. |
| 30.7 | **Interiors** (E81.4). Regions or height planes can be marked as cut-away: roofs and upper floors above the camera's target, or around a room the player is in, are hidden (with a fade) when the camera or player is inside or below them. A cut-away affects drawing only (collision and queries unchanged). Interior lighting per room uses phase 29's probes and light layers. |
| 30.8 | **Kit swaps** (E81.6). A block layer, or a region of it, can swap its kit: a map from block types (or looks) to other types, applied without changing the layout, in the editor and at run time (on top of 28.7's runtime material swap). A dungeon and its burnt or ruined state share one layout. |
| 30.9 | **Block extras** (E8 should-haves; each dropped if 30.1 shows no need): Problems-panel checks (floating blocks, regions with no cells, walkable cells not reachable from a named region); per-vertex block ambient occlusion as a cheap alternative to baking; generic grid-graph helpers (neighbours with a height-step limit, an A* over cells and edges that respects edge pieces). |

### Part B — terrain

| Item | What |
|---|---|
| 30.10 | **Terrain data and editing.**<br>• A `terrain` component: a grid of tiles of 2ⁿ+1 samples, a sample spacing in metres, a height range. Each tile stores R16 heights, layer weight maps (top-4 layer index + weight per texel, so the number of layers isn't capped by channels), a hole mask, and a separate painted-override map so rules can be re-baked without losing hand paint. Tiles are content-addressed binary blobs (like instance buffers); undo points back at the old tile digests.<br>• One `editTerrain` command: sculpt (raise, lower, smooth, flatten, ramp, noise), paint, holes, using the existing brush cores and falloff, deterministic dabs, one undo per stroke.<br>• 16-bit PNG and RAW heightmap import; a converter from a block layer whose surface is corner heights to terrain tiles.<br>• Editor: a Terrain tool set beside the Blocks tools, stroke previews on the GPU, the 28b-style local preview then one commit. |
| 30.11 | **Rendering and collision.**<br>• **CDLOD:** a quadtree over the tiles, one shared grid mesh drawn instanced per LOD level, heights read in the vertex shader from a height texture array, morphing between levels so there are no seams or pops; normals from the heights (baked per tile for far levels). A sculpt re-uploads a texture region; nothing is re-meshed on the CPU.<br>• Draw calls about one per LOD level per material; frustum culling per node.<br>• **Collision:** a Rapier heightfield per tile in the collision ring (30.16), added and removed through the batched static collider path. Tiles with holes use trimesh patches unless 30.0 finds heightfield hole support in Rapier. Terrain collision is optional per terrain (scenery-only terrain needs none). |
| 30.12 | **One rule system for blocks and terrain.**<br>• A surface model both sources provide: height, normal and slope, curvature or cavity, current layer weights, and for blocks the block type, top or wall, and cell metadata.<br>• **Material rules** per layer: height range, slope range, cavity, noise mask, "where layer X is below a value", top or wall, each with a smooth falloff; evaluated offline into terrain weight maps and block paint, with painted overrides kept on top.<br>• **No triplanar by default:** steep layers use world-XZ or side projection; biplanar (2 samples) is an opt-in per layer, near tiles only, with its cost shown on the material.<br>• **Macro texture:** past a set distance, terrain samples one pre-baked albedo and normal per tile instead of the layer stack. |
| 30.13 | **Rule scatter on both.**<br>• **Stored** (trees, rocks, anything with collision or identity): rules (layer weight, slope, height, noise, Poisson spacing, exclusion by region or spline) bake instance sets per tile or chunk, deterministic from a seed; the existing brush edits the result. Copies become addressable (an index scripts can use) and can carry per-copy colliders from the model's `_COL` (28.10's compounds) (E37 part 3).<br>• **Runtime ground cover** (grass, pebbles, small flowers): generated per nearby tile by a compute pass from the same rules, never stored, density falling off by distance (29.6), no colliders; a WebGL 2 path generates on the CPU in a worker.<br>• **Far trees:** octahedral impostors baked at import beyond a set distance, and optional merged HLOD per tile for distant rings (30.2's simplifier). |
| 30.14 | **Splines.** One generic `spline` component (points, tangents, per-point width and roll), editable with Scene handles, readable by scripts (later reused for camera rails and movers). A spline can:<br>• carve or flatten terrain along its width with a falloff (block layers are authored and never changed by a spline; a spline entering a block area stops carving at its border);<br>• paint a material layer along it;<br>• clear scatter in a band;<br>• generate a mesh along it from a profile or repeated kit pieces (road surfaces, fences, walls), with LODs and colliders;<br>• for rivers, a water surface with a flow map along the spline and a foam mask from its banks (two-phase flow, E61), plus a **scene-depth material input** for soft shorelines (E54; brought forward from the decals phase, which reuses it). |
| 30.15 | **Edit layers, stamps and erosion.** A terrain's heights are a stack of layers combined offline into the final heights: hand sculpt (base), stamps (heightmap brushes with rotation and scale), splines (30.14), erosion (hydraulic and thermal, run in a worker or compute pass on demand). Moving a spline recomputes its layer without destroying sculpting. The runtime only ever sees the combined heights. |
| 30.16 | **Streaming.** Terrain tiles and block-layer chunks load and unload in rings around the camera (render, collision and scatter rings at their own radii, with hysteresis), through phase 26's resource manager and under a memory budget (a project setting like `texture_budget_mb`, default from 30.1's measurement). Decoding and scatter generation run off the main thread; a tile appears at a coarse level first. No floating origin. |

### Part C — the handoff

| Item | What |
|---|---|
| 30.17 | **Blocks on terrain** (E82.1–E82.4).<br>• The terrain's edge follows the block layer's border corner heights; under the block footprint the terrain is flattened to the layer or cut away (hole mask), so there is no step, crack, z-fighting or hidden geometry.<br>• One material across the seam: both sides use the same material layers, world UVs in metres (28b) and paint that blends across the border.<br>• One lighting across the seam: phase 29's probes cover the block area; far terrain gets sparser probes and baked per-tile horizon and AO terms; cached shadows cover the near area.<br>• Terrain can be scenery only: simple collision or none, no grid; gameplay queries stay on the block layer. |
| 30.18 | **One surface query** (E39, E40 should-haves). `ctx.surface` (and a backend query for tools) returns height, normal, slope and material layer weights at a world XZ point, from whichever block layer or terrain is there, for footsteps, effects and placement tools. `ctx.grid` keeps its cell queries. |
| 30.19 | **Height and distance fog** (E82.6). Exponential height fog (density, height falloff, colour, start distance, optional sun inscatter) as part of the scene look, blended like the other environment settings, so fog hides LOD steps and the horizon. Replaces the need for a separate vista ring: the far distance is terrain at its coarsest level under fog. |
### Part D — generated architecture

Builds on edge pieces (30.4), interiors (30.7), kit swaps (30.8), rules
(30.12), spline meshes (30.14) and streaming (30.16), and on phase 29's light
layers, probes and cached shadows. Engine/game split: the engine provides
operators, the generator and neutral starter presets. Room programs,
furnishing sets and what happens when a door is used are each game's data
and behaviour.

| Item | What |
|---|---|
| 30.20 | **Trim sheets and row layouts.**<br>• A trim-sheet material: one 2D sheet (albedo, normal, ORM; 3 samples) and a row table in pixels. Rows are equal height by default and may differ (thin trims beside large panels).<br>• A row layout names semantic slots (floor, lower wall, upper wall, baseboard, crown, frame, column, bevel, emissive, …). Any sheet that conforms to a layout swaps in for another.<br>• Import checks row padding. The generator insets UVs by half a texel at band edges, so mips and anisotropy don't bleed between rows (floors at grazing angles).<br>• Vertex colours carry AO and the grime/wetness blend weights; side-face paint (30.6) is stored in world space and sampled onto generated vertices, so it survives regeneration. |
| 30.21 | **The generator.**<br>• Operators: path (polyline, arcs, splines from 30.14; open or closed), offset, sweep a 2D profile along a path, repeat along a path (kit pieces or instances), fill (flat, coffered, barrel and groin vaults; flat, gable, hip and mansard roofs), cut an opening, chamfer, vertex AO.<br>• Mitred joints for mouldings at corners, T-junctions and frames.<br>• Writes flat typed arrays (no per-piece scene objects, no per-vertex allocation), stamps profiles precomputed once per style, one worker job per chunk, chunks near the spawn first through 30.16.<br>• Deterministic across browsers: its own trig for arcs and vaults; generated objects get stable ids (building/room id + seed + slot) so saves and replays hold.<br>• Content stores only parameters; meshes are cached by a hash of the parameters plus the generator version (the editor's cache and IndexedDB in the export). A per-project export option ships the generated meshes instead, from the same generator.<br>• Box colliders per wall segment, not trimeshes. Far LOD drops mouldings and bevels and keeps wall bodies.<br>• Any segment, corner or opening can be overridden by a kit model UV'd against the row layout. |
| 30.22 | **Style graphs and presets.**<br>• A style is a graph of 30.21's operators with exposed parameters (ceiling height, moulding depth, column spacing, vault rise, wall jitter, decay, …).<br>• A preset is a style plus values. Presets derive from other presets and override some values, like prefab variants; a change to the base reaches every preset derived from it.<br>• Parameters can be driven by world masks painted or baked by 30.12's rules, so one slider varies across the level.<br>• Neutral starter presets ship with the engine.<br>• Editor: sliders in the preset's Inspector first, regenerating only the affected rooms while dragging. The graph editor reuses the editor's graph UI and comes after the sliders. |
| 30.23 | **Rooms and paths.**<br>• A draw tool on a block layer: rectangle, polygon and arc segments, snapping to cells.<br>• A room is a closed path plus a style: wall thickness, inside and outside styles, a shared wall owned by one room with a style per side, storeys, floor slabs, stairs and holes in floors.<br>• Openings (doors, windows, arches) cut the row strips, add a frame sweep, and register as 30.4 edge pieces with a blocked state for `ctx.grid` and pathfinding.<br>• Open paths with their own styles make pipes, rails, banisters and fences with the same tool.<br>• One generated mesh per chunk per material. Glass and emissive surfaces are a second material. Hand-placed props are untouched by regeneration. |
| 30.24 | **Rooms drive culling and lighting.**<br>• Rooms and their openings form a portal graph: meshes and lights in rooms that can't be seen are skipped (ahead of phase 33's general occlusion).<br>• Room membership is a light layer (29's light layers), so an unshadowed light stops at its room's walls.<br>• Each room gets its own probe volume (29's probes) so walls don't leak light.<br>• The cut-away regions of 30.7 come from rooms.<br>• Shadow rules: no shadow by default; a per-view budget of shadowed lights ranked by screen size and distance, with distance fade; spot preferred over point for shadows; cached static plus dynamic casters (29). Written down as best practice for games, like the foliage policy. |
| 30.25 | **Buildings.**<br>• A building is a footprint path, storeys, a facade style and a roof fill.<br>• One definition generates the exterior and the interior, so windows, doors and storey heights match on both sides.<br>• The interior is in place (30.7's cut-away, for top-down and tactics games) or its own scene, chosen per building.<br>• Door links pair an exterior door with an interior spawn and travel with `loadScene`/`unloadScene` and the kept player (phase 28). The interaction is the game's.<br>• An interior scene is generated when its door is used, under the game's transition. |
| 30.26 | **Floor plans and furnishing.**<br>• Room programs (game data) split a footprint into rooms, with a door graph and stairs.<br>• Furnishing rules place prop sets by room type: against walls or facing the room, clear of doorways, keeping a walkable path, one light per room inside the light budget; seeded per building.<br>• Hand edits are an override layer on top of the generated plan: lock a building and edit it, or detach it completely; regeneration never overwrites hand edits.<br>• Layouts and furnishing are judged by eye (owner look) before the item is called done. |
| 30.27 | **Acceptance.** 30.1's classes after the phase, split in §6; each item's contribution shown by switching it off. The limits and settings in `docs/deployment.md` (the manual moves them in phase 31). Each request's acceptance as a test at its boundary. A generated-village class: buildings with interiors, generation timed against §5, the sheet and preset swapped, both renderers. |

**Done when:**
- A block area with live doors, edge walls and auto-connected kits stands on
  terrain that reaches a few kilometres, with rule-painted materials,
  rule-placed trees and ground cover on both, a spline road and a river, and
  fog at the horizon, in Play and the export, on both renderers.
- The seam between blocks and terrain shows no step, crack or change in
  material or lighting (pixels; owner look pending).
- Rooms, a building with a linked interior, pipes and a fence drawn as
  outlines are generated at load from parameters. Swapping the trim sheet and
  preset restyles them without touching the outlines or the props, in Play
  and the export, on both renderers (look: owner look pending).
- 30.1's classes are measured after the phase on the Iris Xe and recorded
  against §5's targets, with the split saying where any miss comes from.
- `tools/gate.sh full` is green.

## 5. Soft performance targets

Measured at 1920 × 1080 uncapped on this host's Iris Xe in 30.1's classes,
WebGPU, WebGL 2 recorded. They guide design; a miss is recorded with its
cause and a follow-up, never a reason to throw an item away (owner,
2026-10-03).

| Measure | Target |
|---|---|
| Whole frame (landscape class) | p95 ≤ 16.7 ms GPU and CPU |
| Terrain GPU time | ≤ 2.0 ms |
| Scatter and ground cover GPU time | ≤ 3.0 ms |
| Terrain and scatter draw calls | ≤ 60 |
| Main-thread work for terrain, scatter and streaming | ≤ 2 ms per frame |
| Frames over 16.7 ms while streaming, re-meshing or re-baking | none in a 60 s flight |
| Far landscape cost | about the vista ring it replaces |
| Architecture generation | ≤ 5 ms per chunk on a worker; the spawn's chunks ready ≤ 100 ms after load |
| An interior generated at a door | ≤ 100 ms (hidden by the game's transition) |
| A room regenerated while a slider is dragged | ≤ 16 ms |
| Generated architecture draw calls | one per chunk per material |

## 6. Progress and measurements

| Item | Status |
|---|---|
| 30.0 | done 2026-10-03 (plan only; the release checks run when the phase starts) |
| 30.1 | done 2026-10-07: `node tools/perf/run.mjs level [--classes area,landscape]` (tools/perf/level.ts, level-run.ts; vitest tests/perf/level.test.ts). **area**: 100 × 100 m block layer (corner-height hills, 10 walled rooms), 300 static props, 40 foliage sets (6,000 copies, no shadow, density falloff), 6 point lights, shadowed sun, exp2 fog, SSAO/bloom/SMAA. **landscape**: the area plus placeholder far part (a 6 km ground plane and 64 instance sets, 32,000 tree/rock copies in 4 rings to 3 km, 256 m chunks, far plane 4 km) until 30.10/30.11: the plan grows a terrain part then, drops the plane and keeps the rings. Iris Xe, 1080p, uncapped, before numbers (p50/p95/p99 ms, draws, main thread ms/frame, WebGPU pass GPU ms): area WebGPU 6.5/9.4/23.5, 259 draws, main 6.6, GPU 10.3 (scene 4.2, SSAO 1.4, SMAA 1.1); area WebGL 2 2.5/6.5/192.7 (p99 = the known WebGL 2 uncapped GPU-process stalls), 260 draws, main 6.6. Landscape WebGPU 7.1/10.3/15.1, 474 draws, main 7.3, GPU 11.7 (scene 5.2); WebGL 2 4.9/7.9/57.2, 475 draws, main 7.4. Whole-frame p95 within 16.7 ms on both; the far placeholder adds 0.6 ms p50 / 1.4 ms GPU / 215 draws on WebGPU (2.4 ms p50 on WebGL 2). Not measurable yet: terrain GPU time and draws, ground cover, streaming hitches (no terrain, scatter rules or world streaming); WebGL 2 gives no pass timings; the owner's Ryzen APU laptop is not recorded (not on this host). |
| 30.2 | part A done 2026-10-07 (undo per chunk, no cell caps, simplifier; binary chunk data is part B). **Undo** (`TL_PERF=1 npx vitest run tests/perf/block-layers.test.ts`, 512 × 512 layer, 262,144 cells in 1,024 chunks, one-cell edit, before → after): undo step 19.9 → 12.4 KB retained (the rest is the two JSON chunks themselves; part B's binary chunks shrink it), edit 223 → 77 ms, undo 175 → 21 ms, redo 181 → 21 ms (the no-change check compares chunks instead of serializing the scene twice; the edit's rest is decoding and validating the whole layer, O(layer)). **No cell caps**: two 1,048,576-cell layers fill, edit, undo, save and reopen through the workspace; `runtime.blockMemory` in Play diagnostics: 4 B a cell + ~270 B a column measured on V8 (1,024² columns ≈ 280 MB; area, not depth, costs). **Simplifier** (meshoptimizer 1.1.1): levels at 50/25/12.5 % of a 3,968 / 65,024 / 261,120-triangle mesh in 3 / 35 / 139 ms; import setting `generateLods` (off unless asked). Unverified: generated levels switching in a real browser (only the file and import are tested). Part B done 2026-10-07 (binary chunk data): chunk files `.bin` (varints, zstd) or `.json` by `block_chunk_storage`, both read; Play/export ship one gzip blob per layer. Skyforge copy: 13 chunk files 94.6 → 13.5 KB (convert 65 ms), exported scene files 1.42 → 0.97 MB (cells 11 KB); 512² / 1,024² test layers (1.8 M / 7.3 M cells): 43 / 174 MB pretty JSON → 73 / 140 KB gzip, parse 47 / 232 → 17 / 38 ms (gunzip + decode, Node). Undo step: 3.1 KB of binary chunks (the same chunks are 6.7 KB as JSON text, ~10× that as heap objects); undo/redo 23 ms. Both games' copies open, Play and export (WebGPU and WebGL 2) unchanged; they need no change. |
| 30.3 | done 2026-10-07: block type `live` (Blocks panel form); each cell showing a prefab look spawns the prefab with cell-derived ids (`<layer>-<x>_<y>_<z>[-i]`, never in the scene file), root = the cell's static part (its model stays merged in the chunk; a model-less root is a logic-only cell), objects follow the cell (layer load/unload, `ctx.grid.set`/`clear` at the end of that step, save load, scene reload, restart); `ctx.grid.entity`/`cellOf`; `runtime.blockMemory.liveObjects`. Measured (`TL_PERF=1 npx vitest run tests/perf/live-blocks.test.ts`, 500 doors = scripted root + box-collider leaf, page composition with Rapier): spawn 120 µs/door (60 ms when the layer loads: a hitch, see §7), step +0.3–0.6 ms (0.6–1.2 µs/door), one door spawned + one removed per step +0.5 ms over the same writes without live blocks (2.0 → 2.5 ms; the 2.0 is the chunk collider rebuild), heap 16 KB/door. `node tools/perf/run.mjs level --classes area --live 500` vs `--live 0` (Iris Xe, 1080p): WebGPU p50/p95 6.4/9.4 vs 6.6/9.3 ms, main thread 6.42 vs 6.59 ms/frame, GPU 10.1 vs 10.4 ms, draws 261 vs 259 (the 500 leaves are one instanced batch + its shadow), first frame 1.95 vs 1.75 s; WebGL 2 p50/p95 2.7/5.9 vs 2.7/7.0, main 6.47 vs 6.67. Within §5. Unverified: the owner's laptop; worker-thread time is from the Node run, not the browser profile. |
| 30.4 | done 2026-10-07: block types with `placement: 'edge'` stand on cell edges (stored per chunk: `edgePalette` + `edges` rows, JSON and binary layout 2, round-trip tested; no edges = the old bytes); `blocking`, `open` (no passage, no collider); merged into the chunk mesh (page = worker, byte-tested) and the chunk's trimesh collider; `ctx.grid.edge/blocked/setEdge/clearEdge/setEdgeOpen/edgeEntity`, edges in saves; live edge pieces (doors); `editBlocks` `edges` edit; editor Paint/Erase/Line/Rectangle on edges (block-editor e2e), wall + live gate pixels in Play and the export on WebGPU and WebGL 2 (block-layers e2e). Measured: meshing 12.4 → 17.0 ms a chunk with 356 edges (~13 µs an edge, Node), collider 3.1 → 7.4 ms a chunk, collider count unchanged (one trimesh per chunk; 10.0k → 48.4k triangles), 28 B an edge. `level --classes area` cell walls vs `--edge-walls` (2,747 edges): WebGPU p50/p95 6.5/9.1 vs 6.6/8.9 ms, GPU 10.44 vs 10.47 ms, main 6.58 vs 6.63 ms, draws 259 vs 267, 271k vs 293k tris; WebGL 2 2.6/6.6 vs 2.6/5.4, main 6.61 vs 6.66. Within §5. Unverified: the owner's laptop; edges on sloped ground (they stand at the row's bottom). |
| 30.5 | done 2026-10-07: block type `connect` (`with`, `pieces` single/end/straight/corner/t/cross/base/cap → variant + extra turn; edges: single/end/straight/corner/base/cap) resolved at mesh time from the neighbours (`block-connect.ts`): mesher (page = workers, byte-tested), collider, surface queries, live blocks (a `ctx.grid` write respawns changed live neighbours in the same step), `ctx.grid.get/edge` report the shown variant/rot and `piece`; an edge written at a chunk border re-meshes the chunk across. Copy/move/rotate/mirror/stamp/paste carry edges (stamp `edgePalette`/`edges`, `array` edit edges). Editor: Connections in the block type form (block-editor e2e: a line draws straight + end pieces, erasing a cell makes two more ends); Play and the export show straight/corner/T pieces on WebGPU and WebGL 2 (block-layers e2e). Measured (`TL_PERF=1 npx vitest run tests/perf/block-layers.test.ts -t auto-connect`, 40 × 40, 1,533 wall cells + 463 fence edges, 9 chunks): resolution 0.85 µs a cell, 0.79 µs an edge; meshing 7.53 → 7.91 ms a chunk vs the same walls unconnected; a border edit re-meshes 2 chunks (cells as before). `level --classes area` (no connected blocks) unchanged: WebGPU 6.5/9.4 ms, GPU 10.37 ms, main 6.57 ms, 259 draws; WebGL 2 2.6/8.0 ms, main 6.73 ms, 260 draws. Unverified: the owner's laptop; real kit models (only stand-ins and arm-shaped test looks). |
| 30.6 | done 2026-10-07: `blockLayer.wallPaint` (opt-in; absent = the old bytes and look): wall points ~0.5 m apart stored per chunk (`wallPaint`, JSON and binary layout 3, round-trip tested), unpainted walls layer 2, the lip wraps the top's paint one point down, wall faces cut at the points; `paint` `target: walls\|both` + `y`; editor Paint texture **On** Tops/Walls/Both; scene/preset `wetness` + Scene wetness node + Environment slider; template pooling by height and normal flattening (12 reads still). Paint colours now made with the meshing (workers = page, byte-tested). Measured (`TL_PERF=1 … block-layers -t "wall paint"`, 64 × 64 sloped terrain, smoothed 2 × 2 tops, 20-row walls on every 16th line, 12k painted points = 108 KB): meshing 30.0 → 34.4 ms/chunk, paint colours 0.3 → 5.6 ms/chunk (workers), vertices 142k → 190k, triangles 93k → 162k. `level --classes area` (no wall paint) unchanged vs 30.5: WebGPU 6.5/9.3 ms, GPU 10.33 ms, main 6.57 ms, 259 draws, 271k tris; WebGL 2 2.6/6.8, main 6.79. `--wall-paint`: WebGPU 6.6/9.6 ms, GPU 10.47 ms (scene 4.15 → 4.25), main 6.58 ms, 259 draws, 316k tris; WebGL 2 2.5/6.6, main 6.68. `blocks` before/after: Scene view type change p95 17.5/17.5 ms, export grid writes p95 6.3 → 6.7 ms (WebGPU), WebGL 2 load worst 457 → 402 ms (its known stalls). Within §5. Pixels: wall green with red lip, blue moss up the face, wet ground darker — Scene view, WebGPU and WebGL 2 (terrain-paint e2e); Play/export of wall paint unverified by pixels (same adapter path). |
| 30.7 | done 2026-10-07: `blockLayer.cutaway` {`regions: [{region, when?}]`, `planes: [row]`, `fade`} (`block-cutaway.ts`; Inspector, Blocks panel **Cut** + Scene-view **Preview** per region, MCP docs): a region hides while the subject is under it (`when`: inside another region), a plane hides its rows and up while the subject is below; subject = the live camera's target (`CameraViewInfo.target`, page side, per drawn frame) or `ctx.grid.setCutawaySubject/setCutawayPoint`; `ctx.grid.setCutaway(layer, zone, true\|false\|null)` forces (mirrored worker → page). Drawing: a zone's triangles are their own meshes (index split on the page, shared vertex buffers; faces between zone and rest kept by the mesher, page = worker); cut = off the view's camera layer, still in the shadow cameras' (layer 31); fade = a child copy with one dithered `maskNode` variant per material (per-object uniform), precompiled at load. Measured `level --classes area --roofs` vs `--cutaway` (10 roofs, half held cut, half swapped every 2 s): WebGPU p50/p95 6.5/9.3 → 6.6/9.7 ms, GPU 10.32 → 10.33 ms, main 6.54 → 6.62 ms, draws 259 → 259 (scene pass 237 → 255 at the sample); WebGL 2 p50/p95 2.6/6.9 → 2.8/6.7, main 6.73 → 6.67, draws 260 → 277; shadow draws 1/frame max in both (the static map never redrawn by cuts or fades). Within §5. Pixels: Play, export WebGPU and WebGL 2 (roof drawn before, dithered while fading, gone after; the other roof stays — block-layers e2e); Scene view preview (block-editor e2e). Unverified: the owner's laptop; the first-fade precompile on a slow device. |
| 30.8 | done 2026-10-07: block type `kits` {name: {block, variant?, variants?}} (same placement and footprint, checked) and layer `kits` [{kit, region?}] (Blocks panel Kit on the layer bar and per region, type form Kits, Inspector, MCP); resolved where a look is needed through a read-only view of the grid (`block-kit-view.ts`: meshing page = workers, byte-tested; collision; connected pieces; live blocks; surface queries), cells/saves/undo unchanged; `ctx.grid.setKit/kit`, `kitBlock` in `get`/`edge`, kits in the grid diff; a kit or block-type change is a restyle: every chunk re-meshes in the workers (old meshes drawn until the new arrive), the cached static shadow held and drawn once (Play e2e: static draws 1 → 2 across a dig + kit swap); Problems warn on cut-aways/kits naming missing regions or kits, and the Blocks panel's region rename/delete takes them along (30.7's gap). Measured `level --classes area --kit-swap` (whole 100 × 100 m layer swapped every 2 s, 49 chunks): swap 300–394 ms WebGPU / 339–415 ms WebGL 2 (two workers), page's own work ≤ 3.8 ms a frame; frames over 16.7 ms during swaps 3/408 = 0.7 % WebGPU, 9/368 = 2.4 % WebGL 2 vs the class without swaps 1.3 % / 2.4 % (§5 "none" is missed by the class's background, not the swap); whole run WebGPU p50/p95 6.6/9.8 ms, GPU 10.43, main 6.59, 259 draws; WebGL 2 2.8/7.3, main 6.34. Without kits (`level --classes area`): WebGPU 6.5/9.5 ms, GPU 10.31, main 6.58, 259 draws; WebGL 2 2.6/6.8, main 6.62 (unchanged vs 30.7). Pixels: Scene view (block-editor e2e), Play, export WebGPU and WebGL 2 (block-layers e2e). Unverified: the owner's laptop; real kit models. |
| 30.9 | done 2026-10-07 (Part A done): all three extras kept (§7). **Walk graph** (`block-walk.ts`, `ctx.grid.walkNeighbours/path/reachable`, layer `walk` {from, maxStep, maxDrop, headroom, field, diagonal}; options costField, avoid): A* and reach respect step/drop/headroom, walls and closed doors, kits; unit-tested (doors, steps, ramps, stairs, headroom, diagonals, footprints, avoid, cost field). Measured on the area class layer (`TL_PERF=1 npx vitest run tests/perf/block-walk.test.ts`, Node): corner to corner 191 places, 8,172 visited, cold 37–83 ms, warm (graph kept until a write) 18–25 ms; into a room through its door 0.02 ms; reach 20 m (746 places) 1.6 ms; walkNeighbours 3.7–4.3 µs. **Problems** (backend, after edits settle; `block_floating`, `block_region_empty`, `block_unreachable`): whole-layer checks 131–149 ms (10,000 places), off the frame; block-editor e2e. **Corner shading** (`vertexAO`, opt-in): +2.8 ms/chunk meshing with cell walls, +5.0 with edge walls (21.7–23.2 ms/chunk without; workers), 4 B a vertex; `level --classes area` without it unchanged (WebGPU 6.6/9.6 ms, GPU 10.35 ms, main 6.57 ms, 259 draws; WebGL 2 2.6/6.8, main 6.62); `--vertex-ao`: WebGPU 6.6/9.7, GPU 10.34, main 6.6, 259 draws, 30 pipelines (29); WebGL 2 2.6/6.8, main 6.63. Pixels: Scene view crease with the sun off 46–52 % darker on WebGPU and WebGL 2, open ground unchanged (terrain-paint e2e). Unverified: the look (in the sunlit area class the difference is under 0.1 % of pixels; it shows where indirect light dominates — interiors, shade); the owner's laptop. |
| 30.10 | part A done 2026-10-07 (data, `editTerrain`, heightmap import, block converter; the Terrain tool set is part B, after 30.11): `terrain` component {tileSamples 17–1,025 (2ⁿ+1), spacing, heightRange, tiles [{x, z, data?}]} (`terrain.ts`), tiles as content-addressed gzip blobs `TLTR` (`terrain-tile.ts`; heights as 16-bit steps stored as differences from a plane, baked weights and hand paint as top-4 index + weight per sample, hole bit per cell; the header names size and maps), `editTerrain` raise/lower/smooth/flatten/noise/ramp/paint/holes/import/fromBlocks (`terrain-edit.ts`, `terrain-import.ts`, commands `terrain-ops.ts`, host `workspace/terrain-edits.ts`; one setComponent change, undo = old digests; result `terrain {tiles, added, changed, clamped?}`), `queryTerrain` / MCP `target="terrain"` (memoryBytes), export/Play ship tiles in `manifest.buffers`, page loader `game-host/terrain-tiles.ts` → `TerrainField` (heights, normals, slope, holes, layers). Measured (`TL_PERF=1 npx vitest run tests/perf/terrain.test.ts`, Node): a dab on a 513² tile at 1 m: sculpt 0.10–0.18 / 0.90–1.00 / 3.6–3.8 ms at 8 / 32 / 64 m radius, paint 0.5 / 5.5 / 23 ms, holes ≤ 0.08 ms; a 32-dab stroke the backend's way 36 ms (decode 4.8, plan 7.3, encode + gzip + digest 23.6). Blob of a 513² tile of rolling hills 210 KB (526 KB raw heights; 2.9 MB decoded with paint), painted with four layers 262 KB. 4k import: 4,097² PNG16 (19.4 MB file) → 64 tiles in 1.94 s (decode 0.42, lay 0.14, encode + gzip 1.38), 4,096² RAW 1.52 s; 13.4 MB stored. No frame-time numbers: nothing is drawn yet (30.11). Unverified: anything in a browser (no drawing; the page loader is tested in Node with its DecompressionStream). Part B done 2026-10-07 (the Terrain tool set): the terrain's Inspector shows Raise/Lower/Smooth/Flatten/Noise/Ramp/Paint (layer picker)/Holes, radius, strength, falloff, noise size/seed, invert (Ctrl), Import heightmap… dialog, From block layer → Convert; GameObject → Terrain (`TerrainPanel.tsx`, `useTerrainTools.ts`, `viewport/terrain-editor.ts`, `session/terrain-brush.ts`); cursor ring draped on `TerrainField.raycast`. Strokes preview on the GPU in the drawn texture arrays (`three-adapter/terrain-brush-gpu.ts`, `terrain-preview.ts`, `TerrainView.preview*`: a pass + rectangle copy per tile per dab, no CPU re-pack, nothing sent per dab), one `editTerrain` on release; changed tiles' data replace the preview, others re-upload from their CPU copy. Measured (terrain-cdlod e2e, Iris Xe, both renderers): 64 m raise on a 1,025² tile, 10–11 dabs over 5 s: preview main thread 0.24–0.27 ms mean / ≤ 0.5 ms max a frame, rAF max 16.8 ms, no frame over 25 ms; commit round trip 134–156 ms, stored tile replacing the preview 143–167 ms after release; small strokes (65² tiles) commit 18–20 ms, settle 11–103 ms. Preview read back against the stored tiles: raise, noise, smooth, ramp, paint, holes 0 difference on both renderers; the 64 m stroke ≤ 1 step at 0–1 of ~20,000 samples; pixels preview vs stored identical (mean diff 0) while the preview moved them 17.7 levels. Unverified: the look of a long paint stroke over painted ground (approximate preview), erase previews, owner's laptop. |
| 30.11 | part A done 2026-10-07 (rendering; collision is part B): CDLOD (`three-adapter/terrain-quadtree.ts` selection, `terrain-texels.ts` tile texels, `terrain-material.ts` vertex/pixel nodes, `terrain-view.ts` pages, uploads, draws; adapter wiring only): a quadtree per tile over one shared 16² grid drawn instanced, heights (16-bit, filtered by hand) and normals from RGBA8 texture arrays of up to 256 tiles a page, vertex morph between levels, frustum culling per node (view draws the nodes in view, shadow cameras all), one draw per page; the layered material via `materials {"*": id}` (graph compiled for the terrain's surface: world UVs in metres, glTF tangents, weights as COLOR_0, holes as mask), light layers, AO, cached static shadow (redrawn once per upload); `lodDistance` + quality `lodBias`; `?terrain=off`. Landscape class v2 (12 × 12 tiles of 257 at 2 m, layered KTX2 material, 24 painted discs; was a 6 km plane), Iris Xe 1080p before → after: WebGPU p50/p95 7.2/9.4 → 8.0/8.4 ms, GPU 12.79 → 12.74 ms, main 7.26 → 8.03 ms, 474 → 474 draws; WebGL 2 5.1/8.0 → 5.0/8.7, main 7.39 → 8.37, 475 → 475 draws. Terrain alone (`terrain=off` switch): GPU +0.89 ms (scene pass 5.27 → 6.21; §5 ≤ 2.0), +1 draw (§5 ≤ 60 with scatter), +75k triangles, main thread +0.51 ms WebGPU / +0.93 ms WebGL 2 (§5 ≤ 2); page side (`TL_PERF=1 … tests/perf/terrain.test.ts -t page-side`, Node): selection over the class's 144 tiles 0.054 ms median / 0.075 ms p95 a frame while flying (only when the view or tiles change), a 257² tile's texels 2.2 ms (heights + normals) + 2.1 ms (layers), bounds 0.1 ms, uploads ≥ 1 tile and ≤ 3 ms a frame (a 1,025² tile is ~35 ms on one frame: a worker is the follow-up). Pixels: Scene view, Play and the export on WebGPU and WebGL 2 (terrain-cdlod e2e: layers, a painted disc, a hole cut with the page open, no crack between levels or 64 tiles' seams — the same check fails with the morph switched off). Unverified: the look of far levels (per-vertex normals), the owner's laptop. Part B done 2026-10-07 (collision and part A's gaps): Rapier heightfield per tile in the sim (`runtime/terrain-collision.ts`, batched with the block chunks' colliders in `RuntimeGrid.flushCollision`; a holed tile in 16-cell patches: whole ones merged into heightfields, cut ones meshes of their whole cells; `collision: false` per terrain; ring hook for 30.16, all tiles now); one decoded copy per tile on the page (`three-adapter/terrain-tile-store.ts`) shared by drawing, picking (`TerrainField.raycast`) and the sim (same objects on the page, heights + holes copied to its worker by `addTerrainTiles`), start scenes' tiles read before step 0, a loaded scene's before it reaches the sim; decode + pack on a worker of the view worker script (`terrain-pack-worker.ts`), uploads a layer texture at a time within 2 ms / 4 MiB a frame; any number of layers (per-sample layer indices, channel `layer % 4`; 15 texture reads a pixel, was 14); run-time material swaps reach terrain. Measured: collider build (Node, `TL_PERF=1 … terrain-collision.test.ts`) 257² 1.9 ms shapes + 5–8 ms port, 1,025² 3.0 + 8.9 ms, 1,025² holed (65 colliders) 4.3 + 19 ms; a step with them 0.01–0.07 ms; in Play's sim worker 65 tiles (64 × 65² + one 1,025²) built in 43–66 ms at start. 1,025² tile on the worker: decode 17–39 ms, pack 82–110 ms; page upload peak 1.7–2.9 ms a frame, ≤ 4.2 MB (§5 main ≤ 2 ms: over by up to ~1 ms on the frames a 1,025² tile's 4.2 MB layer is copied); a sculpted 1,025² tile re-uploaded with the Scene view open: rAF max 16.8 ms on both renderers (no frame missed at 60 Hz; before, ~35 ms of packing on one frame). `level --classes landscape` before → after: WebGPU p50/p95 8.0/9.1 → 8.0/9.7 ms, GPU 12.86 → 12.82 ms (scene 6.23 → 6.27), main 8.04 → 8.04 ms, 474 → 475 draws; WebGL 2 5.4/9.1 → 5.1/8.9 ms, main 8.06 → 8.6 ms (run-to-run spread; part A measured 8.37), 475 → 475 draws. Pixels and play: terrain-cdlod e2e (both renderers): a fifth layer's disc drawn in the Scene view, Play and the export; a 3D player stands on the terrain at its height and falls through the hole in Play. Unverified: a material swap on terrain (wired, no test), the sim's step cost in the landscape class (no player there). |
| 30.12–30.27 | — |

(30.1's before numbers and 30.20's after numbers.)

## 7. Decision log

- 2026-10-03: planned with the owner. Terrain takes phase 30; documentation
  moves to 31, decals to 32, occlusion culling to 33. Immediate block and
  texture fixes are phase 28b (`docs/plan-phase-28b.md`).
- 2026-10-03: terrain is a heightfield component, not more block cells.
  Corner heights on cells suit level building but not landscapes: cell caps,
  4-cell slopes, JSON chunks, whole-layer undo and CPU meshing per chunk don't
  scale to kilometres. A block layer made only of corner heights can be
  converted (30.10).
- 2026-10-03: CDLOD over geometry clipmaps. Clipmaps draw more simply, but
  CDLOD's quadtree maps directly onto streamed tiles and needs no CPU meshing.
- 2026-10-03: rules are baked, not evaluated in the shader. Per-pixel rules
  cost ALU every frame and are hard to override by hand; baked weights cost
  one texture read and keep painted overrides.
- 2026-10-03: floating origin, virtual texturing and Cycles bakes for
  terrain are left for later; none is needed by a planned game.
- 2026-10-06: Part D (generated architecture) added with the owner.
  - One 2D trim sheet with per-row geometry rather than a texture array. The
    sample count is the same (an array layer is one lookup); the sheet wins on
    memory, vertex density for paint, unequal rows and off-the-shelf sheets.
  - No lightmaps: block layers' per-chunk lightmaps (§2) are for the owner to
    keep or drop.
  - Two primitives (sweep a profile along a path, repeat along a path) plus
    fills, not one special case per shape.
  - Interior floor plans and furnishing are the riskiest part and are judged
    by eye.
  - With Part D the phase has 28 items. 30.0's re-check may split Part D
    into its own phase if the gate budget or size calls for it (owner
    decides).
- 2026-10-07: phase start release check: three.js 0.186.1 is still the latest (no update). Rapier: pinned 0.20.0, 0.21.0 is out;
  upgraded only if a terrain item needs it (heightfield holes for 30.11), as its own item after reading its release notes.
- 2026-10-07 (30.1): the landscape class is built now with a placeholder far part (a flat 6 km ground plane and
  rings of large instanced copies under fog), so the harness and the far cost exist before terrain; when 30.10/30.11
  land, the class swaps the plane for a terrain and keeps the rings, and bumps `LEVEL_VERSION`. Default chosen,
  owner to confirm: the area and the landscape share camera and environment, so the landscape minus the area is the
  far part's cost (the run logs it as a row).
- 2026-10-07 (30.2 part A): no block cell caps; the per-layer bound left is its bounds (1,024 × 256 × 1,024 cells), a
  dimension rather than a count, kept with the 16 layers per scene. A layer's memory is shown, not capped: the streaming
  budget of 30.16 is what will bound it. Default chosen, owner to confirm.
- 2026-10-07 (30.2 part A): generated LODs are made at import into the stored GLB (`<name>_LOD0…3` beside each mesh
  node, the authored-level naming), not at load: the runtime only reads results. The setting is off unless an import asks
  (`generateLods: true`); a re-import keeps a model's levels through its version's `convertedFrom.lods`, so no new
  record field. Levels at 50/25/12.5 % of the triangles, each allowed 1/2/4 % of the mesh's size of error; a level that
  cannot drop below 80 % of the one before ends the chain. Skinned, animated, morphing, parented and compressed nodes and FBX
  conversions get none. The converter record keeps the name `texture-extract` (a GLB conversion; renaming it would be a
  schema change). Default chosen, owner to confirm.
- 2026-10-07 (30.2 part B): which files are binary. Default chosen, owner to confirm: the setting
  `block_chunk_storage` (Project files) picks the form the editor writes; absent or 0 = JSON text, so every existing
  project keeps its files until it opts in; new projects are made with 1 (binary, NEW_PROJECT_SETTINGS). Changing it
  rewrites every chunk file in the same save (that is the "convert"; undo converts back). The reader takes both forms
  forever: the scene file names its chunks' form (`blockChunkFormat: "binary"`, absent: JSON), so a mixed project (a
  merge, an older engine) opens as it is and a scene written again moves to the project's form. No schemaVersion
  bump: only additive optional keys (scene file `blockChunkFormat`, `paint` in a JSON chunk file, `chunkData` in a
  build's scene files; `manifest.buffers` rows are reused, the manifest is unchanged). Git: binary chunk files diff
  only as "changed"; projects that review level edits in diffs keep 0, and `queryBlocks` reads either.
- 2026-10-07 (30.2 part B): a build ships gzip, not zstd. The page decodes gzip with the browser's
  DecompressionStream; three's zstd decoder (the KTX2 path's) fetches its WebAssembly from a `data:` URL, which the
  Play page's content policy (`connect-src 'self' blob:`) refuses, and keeps its grown heap for the page's life.
  Project files (read only by the backend) use zstd. Undo steps hold their chunks in the binary form (uncompressed).
- 2026-10-07 (30.2 part B): defect found and fixed: JSON chunk files never stored a chunk's `paint`
  (since 25.21), so painted terrain lost its paint on reopen; both forms keep it now.
- 2026-10-07 (30.2 part B): copies of Sprout and Skyforge (read-only copies, deleted after) open, Play (Skyforge's
  scene-main loaded through the Play relay, both layers in `runtime.blockMemory`) and export on WebGPU and WebGL 2;
  Skyforge's chunk files stay JSON until it sets the setting. Neither game needs a change.
- 2026-10-07 (30.3): live blocks. Default chosen, owner to confirm:
  - Additive optional `live` on a block type (stored only when true); no schema bump. A live type needs a prefab
    look; its prefab's root is the cell's static part (placed at the footprint's bottom centre, turned with the
    cell, unit scale, its model merged in the chunk, refused if it carries a mover, patrol, gravity, animator, model
    animation or socket attachment); a model-less root is allowed on a live type only (draws nothing in the chunk).
  - Ids are the cell's (deterministic, so replays, saves and scripts name the same objects; no serials to save);
    a layer id longer than 41 characters is hashed into the prefix to stay within the id syntax. An id another
    object already holds spawns nothing and logs `spawn_refused`.
  - The objects go through the spawned-copy path (so they reach the page like `ctx.spawn` copies), but are not
    `ctx.destroy`-able, not in the `spawned` save section and not counted against the spawned-object limit.
    "Pooling" is: objects only for cells that need them, a cell rewritten with the same prefab and rotation keeps
    its objects, a write that changes neither prefab nor rotation (metadata) touches none, and the objects are not
    copied a second time when they enter the game; there is no pool of detached objects (a reused object would
    carry its script's state into another cell).
  - Timing: the objects follow the cells at each step boundary and at the end of each step (a write is seen by
    scripts from the next step, as `ctx.spawn` copies are), and at once when a save's grid section is restored
    (before its components section names them).
  - Saves: a live block's lasting state belongs in its cell's metadata (the grid section); fields written with
    `ctx.entity(id).set` travel in the components section by id, accepted for ids a restored cell is about to spawn.
  - A new run and a scene reload respawn fresh objects (scripts start over).
  - Follow-ups: spawning costs ~120 µs a door, so a layer with thousands of live cells hitches when it loads
    (500 = 60 ms) and a script writing many live cells in one step pays it per cell; spreading spawns over steps
    belongs with world streaming (30.16). The Scene view shows only the root's model, not the live children.
  - The registry-size guard in descriptors.test.ts moved from 269,000 to 270,000 bytes for the `live` field.
- 2026-10-07 (30.4): edge pieces. Default chosen, owner to confirm:
  - Additive optional fields, no schema bump: block type `placement` (stored only as `edge`) and `blocking` (stored only
    when false); chunk `edgePalette` + `edges` (`[lx, lz, y, axis, p]`); edge value `{block, rot?: 180, variant?, open?}`.
    The binary chunk payload writes layout 2 (edges after each chunk's columns) only when a chunk has edges; without
    edges it writes layout 1 byte for byte, so existing files and builds keep their digests. Neither game needs a change.
  - An edge is stored once, by the cell on its + side (axis 0: the cell's −x side, 1: its −z side); edges reach one past
    the cells along their axis (the outer border carries walls). One row high: a tall wall is a stack. Edge pieces turn
    end for end only (0 / 180), have no footprint or `solid`, hide no faces and are never hidden.
  - Look frame: origin at the edge's bottom centre, +X along it, +Z facing across. Collision `full`/`half` is a slab an
    eighth of a cell thick (`BLOCK_EDGE_THICKNESS`), `custom` boxes in a cell-sized frame centred on the edge.
  - Blocked = the type blocks (default) and the piece is not open; a collider = a shape other than `none` and not open
    (a non-blocking railing still collides). An open door keeps its look: animating a leaf is the game's (a live
    piece's child), the engine only switches passage and collider.
  - Live edge ids `<layer>-<x>_<y>_<z>x|z`; the id room for the axis letter moves the layer-id hashing threshold from
    41 to 40 characters (a 41-character layer id now hashes; live blocks shipped earlier today).
  - Not in this item: copy/move/mirror/stamp/paste carry cells only; edges on sloped tops stand at the row bottom; the
    A* over edges is 30.9's.
- 2026-10-07 (30.5): auto-connect. Default chosen, owner to confirm:
  - Resolution is derived at mesh time, not stored at edit time: a pure function of the cell and its six neighbours
    (an edge: the edges meeting its two ends, above and below), run wherever a look is needed (mesher on the page and
    in the workers, which already hold the whole grid, so no protocol change and byte-identical output; collider;
    surface queries; live blocks; `ctx.grid` reads). Stored results would rewrite neighbour cells on every edit
    (larger undo steps, `changes()` and save diffs carrying writes nobody made), go stale when a type's rules change,
    and need a re-resolve pass per layer; derived costs 0.8 µs a cell when meshing (+5 % a chunk measured).
  - Additive optional `connect` on a block type; no schema bump; neither game needs a change. A cell or edge that
    names a variant is pinned (never resolved): the editor's "Random look" paints unpinned cells.
  - Cells resolve from their four horizontal neighbours (no diagonals): Wang/blob transitions (cliff lips, grass ↔
    path, E8's "edge-set" autotiling) need 47 looks under 8 variants and belong with the paint rules (30.12).
  - Edge pieces have no t/cross (those are where several edges meet); an end/corner piece faces the way its joined end
    decides (an edge turns end for end only, so a one-sided end piece cannot keep its facing).
  - `base`/`cap` win over the horizontal piece and keep its turn (one coping look for every horizontal shape; 8
    variants cannot hold every combination).
  - A connected type fills one cell (no larger footprint); cells and edges connect only within their placement.
  - An edge piece written at a chunk border marks the neighbouring chunks' meshes when its block id changes (not when
    it opens or closes): a door at a border re-meshes one chunk as before.
  - Copy/move/mirror/stamp/paste carry edge pieces (the 30.4 gap): edges on and inside the box go with the cells,
    turned and mirrored with them (a piece whose type allows one rotation keeps it); stamps gain optional
    `edgePalette`/`edges`, the `array` edit the same keys.
  - The descriptor registry guard moved from 270,000 to 275,000 bytes (the eight pieces repeat their look and turn).
- 2026-10-07 (30.6): side-face paint and wetness. Default chosen, owner to confirm:
  - Wall paint is opt-in per layer (`blockLayer.wallPaint`, stored only when true; no schema bump): absent keeps the
    old look and bytes (walls show their column's top paint, meshes and colours byte for byte as before). On:
    unpainted walls show layer 2, tops layer 1, the lip wraps the top's paint onto the wall's top row of points and
    fades one point down. New projects and templates do not turn it on (a block layer is not always painted terrain).
  - Points: per cell side `round(cell width / 0.5 m)` steps across (ends included, shared ends written alike),
    `round(row height / 0.5 m)` per row up (1–16 each, so points sit on cell corners), named by owner column + side
    (+X, −X, +Z, −Z) + index across + height index from row 0; stored sparsely per chunk as `wallPaint` (9-byte sorted
    records, base64 in JSON chunks, raw bytes in binary layout 3 — written only when a chunk has wall paint, so older
    files keep their bytes). Unpainted points are not stored; erasing gives the weight back to layer 2.
  - A dab paints exposed points only (a block in the column at that row and no flat solid block across, or an edge
    piece on that side), by 3D distance in metres; tops keep their 2D lattice dab (`target` tops|walls|both, `y`).
    Painting walls on a layer without wall paint is accepted by the command (stored, drawn once it is on); the editor
    refuses it with a message.
  - Meshing: wall faces of world-mapped looks (stand-ins, world-UV models) are cut at the point lines (a face's two
    triangles cut as one quad); model looks with their own UVs are not cut (their own vertices carry the paint). Paint
    colours are made with the meshing, so the workers make them (page = worker, byte-tested). A vertex facing sideways
    reads the nearest plane's points of the column its first triangle belongs to; edge pieces read the edge's plane.
    Known approximation: the lip of non-sloped partial shapes (half, ramp, stairs) is their top at the cell middle.
  - Wetness: scene `wetness` (0–1) on the scene look and presets (blended linearly, absent 0), a Scene wetness graph
    node, an Environment window slider; the template adds it to the painted wetness, pools by the blended height
    (`wetPooling` 0.5) and flattens the normal maps (`wetFlatten` 0.7) — no extra texture read (still 12). Layered
    materials made before keep their graphs. Darkening and wet roughness stay fixed (0.55, 0.1).
  - The adapter's environment look (scene look, blends, wind, wetness) moved into `environment-look.ts` (adapter.ts
    1,908 → 1,848 lines) before it grew.
- 2026-10-07 (30.7): interiors (cut-aways). Default chosen, owner to confirm:
  - Data on the layer component (`cutaway`, additive optional, no schema bump; neither game needs a change): it
    names the layer's existing named regions (scene data) and rows, so cut-aways are drawn with the Region tool. A
    renamed or deleted region leaves the name in `cutaway` (it then cuts nothing) — the rename is not carried over.
  - "Inside or below" reads as: a region cuts while the subject is *under* it (its columns, below its lowest row), so
    marking the roof and the upper floors works for every storey (the floor the subject stands on stays); "inside a
    room" is the optional `when` region. Planes cut across the whole layer.
  - Subject: the live virtual camera's target object's position (page side, from the drawn frame's interpolated
    transforms); a camera without a target cuts nothing (a first-person camera inside a house keeps its ceiling). The
    editor has no subject: only its preview forces zones. Scripts name an object or point, or force zones; this state
    is not saved (presentation; set again after a load) and a new run clears it.
  - Shadows and lighting (§1 lighting rules: cached static + dynamic shadows, probes from static objects): cut geometry
    keeps casting. A cut mesh only leaves the view's camera layer (31) for one the shadow cameras also see, keeps its
    material and place, so the cached static map is never redrawn for a cut or a fade (measured: 1 shadow draw a
    frame throughout), and a room under a cut roof keeps the dark its probes baked. A sunlit interior would need the
    roof out of the static map (a redraw per toggle) and re-baked probes: not done.
  - Fade: a dithered copy (screen-space interleaved-gradient discard, `maskNode`, one per-object uniform), one variant
    per source material made once and compiled while the level loads (each new variant waits fully faded in the
    scene for the next precompile); no transparency sorting, no per-frame materials. Default 0.25 s.
  - Triangles are sorted on the page after meshing (the worker protocol is unchanged): by the centre nudged a quarter
    cell against the face normal, with columns reaching 0.2 cell past a region's sides so edge pieces on its outline
    go with it. The mesher keeps the faces between a zone's cells and the rest (a wall's top under a roof).
    Known approximations: a model look spanning a zone boundary is split by triangle; a sloped top reaching above its
    row may sort into the row above.
  - Not in this item: rooms as light layers and portals (30.24 makes cut-away regions from rooms); a Problems check
    for cut-aways naming missing regions. A lightmap or probe bake started while an editor preview hides a zone is
    untested (turn the preview off first).
  - The descriptor registry guard moved from 275,000 to 278,000 bytes (the cut-away fields).
- 2026-10-07 (30.8): kit swaps. Default chosen, owner to confirm:
  - A kit is a name block types swap by (`blockType.kits`), not a content list of its own: no new command, file or undo
    kind, project-wide (every layer shows the same kit names), and a swap is edited with the type it belongs to. Additive
    optional fields (`kits` on block types and layers, `kits` in the grid diff, `kitBlock` on `ctx.grid` reads); no schema
    bump; neither game needs a change.
  - Resolved, never stored, like auto-connect: a read-only view of the grid (`BlockKitView`) whose swapped values are
    interned in the grid's palette, read by the mesher (page and workers), collider, connected pieces, live blocks and
    surface queries. A layer without a swapping kit is the grid itself (no cost, same bytes).
  - A swap keeps the layout: same placement and footprint (refused otherwise); the cell keeps rotation, metadata and corner
    heights where the target can slope. Its look: the swap's `variants[own]`, else `variant`, else the cell's pinned look
    when the target has it, else the target's weights (so a connected target resolves its own pieces; a pinned look turns
    connection off, as anywhere).
  - Layer and regions: one kit for the layer and one per region; a region's wins where it swaps (a later region over an
    earlier where they overlap); edge pieces on a region's outline go with it. Scripts' `setKit` replaces the entry for the
    layer or region (null: none there, the authored one included); a new run goes back to the authored kits.
  - `ctx.grid.get(…).block` stays the stored block (gameplay that names blocks keeps working under any kit); the swap is
    `kitBlock`, and rot/variant/piece are the shown look's; an edge's `blocked` and the colliders are the swap's (a burnt
    door that falls apart lets the player through). Colliders are rebuilt only when a swap changes a shape.
  - A restyle (kit or block-type change) swaps chunks in as they arrive (a swap shows over ~20 frames, not at once: waiting
    for all 49 and building them in one frame would be the hitch); the cached static shadow is held meanwhile (the old
    chunks' shadow stays in the static map, the new chunks are drawn by the dynamic map) and drawn once at the end.
  - Region rename/delete: the editor's Blocks panel follows up its region edit with a setComponent (two undo steps; one
    atomic step would need editBlocks to change the component and its change data, in commands/types.ts at 1,991 lines);
    other paths (MCP) get a Problems warning (`block_names_missing`) instead.
  - The descriptor registry guard moved from 278,000 to 280,000 bytes (kits on block types and layers).
  - The adapter's cut-away following moved into `block-cutaway-follow.ts` (adapter.ts 1,893 → 1,863 lines) before it grew.
- 2026-10-07 (30.9): block extras. Each kept; default chosen, owner to confirm:
  - **Kept, all three.** 30.1's area class gives no "need" number for any of them (none is a frame cost); they are kept
    because each is cheap and generic: the walk graph is the one shape both a game's movement and the editor's
    reachability check need (a tactics game's move range is `reachable`); the Problems checks cost nothing per frame;
    corner shading costs no GPU time (measured) and darkens creases that 29's probes (a probe every metre or more) and a
    quality level without SSAO leave flat. In the sunlit area class it is barely visible (direct light dominates and
    SSAO is on); it shows where indirect light is all there is. It is opt-in (`vertexAO` absent: no attribute, the old
    bytes).
  - **Walk graph** (project-model `block-walk.ts`, one module for scripts and the check): a place is a block top with
    free headroom on a walkable slope, named by the cell whose top it is (a walker's own cell names the top under it); a
    step goes to the four neighbouring columns (eight with `diagonal`, only where both ways round the corner walk) when
    the tops differ by at most the step up or drop down *where they meet* (the middle of the shared side: a ramp's low end
    meets the floor at 0, a stair's front at half a row), both columns are free to the higher top plus the headroom, and
    no blocking edge piece stands on the shared side in the rows passed through. Cost: metres (height included) × a
    cost field the query names (≤ 0: impassable); `avoid` lists occupied cells. Defaults: half a cell height up and down,
    one cell height of headroom, the layer's `maxSlope` (else the project's); the layer's `walk` sets its own. How units
    move, who occupies a cell and turn order stay the game's.
  - A query expands at most 65,536 places (`WALK_QUERY_MAX_NODES`, a per-call bound like the per-step write limit). The
    graph is kept between queries until the layer is written (a cell, an edge, a door) or its kits change; a kept graph
    that has read 65,536 columns is dropped. A path across the whole area visits most of it (the four-way grid's ties:
    every place in the bounding box is as cheap), 18–25 ms warm: a game paths on an order, not every step. Follow-up
    when a game needs long paths often: a coarse graph over chunks (hierarchical search) or a search spread over steps.
  - **Problems** run on the backend 250 ms after the last block-relevant change (block edits, types, fields, components,
    objects), kept per layer by what they read, and log a line when a layer's result appears or changes (the log is
    append-only: a fixed problem stops being logged, its old line stays). Floating: blocks and edge pieces not joined to
    the layer's lowest row holding blocks (a layer built above another is grounded on its own bottom; edge pieces join
    the blocks beside, under and over them, so a roof on edge walls stands). A region with no cells: no box inside the
    layer's bounds (the format already refuses empty boxes). Unreachable: places to stand that the walk from
    `walk.from` (a region's tops, or the cells above them) cannot reach; wall tops and roofs are places too, so a game
    marks walkable cells with `walk.field`. A walk region the layer does not have is the Play check's
    `block_names_missing`, and the Blocks panel's region rename/delete takes `walk.from` along.
  - **Corner shading**: per vertex, four samples half a cell out along the normal, in the plane across it, tested for
    "under a block's top" (full cells, half blocks, ramps, sloped tops — a planar slope never shades itself, a wall
    standing in a hill does), full edge pieces counting half; three of four closed is full strength. Made with the
    meshing (workers = page, byte-tested) as a float per vertex; the renderer's lights node multiplies three's
    `ambientOcclusion` (indirect light only) by it on any lit build whose geometry has the attribute — no material
    variants, so lightmapped copies, cut-away fades and swapped materials keep it (a layer with a lightmap bake has
    occlusion in the bake and should leave this off). Float32, not one byte: WebGPU's single-byte vertex format is an
    optional feature the engine does not assume, and three pads a byte pair to four anyway. Larger blocks' footprints
    and model looks' own shapes do not occlude (cells only).
  - Additive optional fields, no schema bump (`walk`, `vertexAO` on `blockLayer`); neither game needs a change. The
    descriptor registry guard moved from 280,000 to 282,000 bytes.
- 2026-10-07 (30.10 part A): terrain data. Default chosen, owner to confirm:
  - A new component type `terrain` (additive; no schema bump; neither game needs a change). Tiles are listed in the
    component (`tiles: [{x, z, data?}]`, sorted by z then x) and their data are blobs in the source store (like instance
    buffers): the scene file stays small, an edit is a `setComponent` whose undo names the old digests. A tile without
    `data` is flat at the step nearest 0 m, unpainted and whole (a terrain is made by naming tiles; a tile edited back to
    that is stored without data). The component keeps the whole tile list per undo step (~90 B a tile: 1,024 tiles ≈
    92 KB a step); a per-tile patch change like `block-patch.ts` is the follow-up if terrains grow to thousands of tiles.
  - Placed by the object's position only (rotation and scale not applied), as block layers are: tiles stay axis-aligned
    squares for the quadtree and heightfield colliders. Tile coordinates within ±4,096 (a dimension, not a count).
  - Heights: 16-bit steps of `heightRange` (metres above the object). Changing the range stretches the stored heights;
    `tileSamples` is fixed once a tile holds data (a tile blob of another size is refused at commit). Heights between
    samples are bilinear in `TerrainField` (30.11 may switch to its triangle split if collision needs it).
  - Layers: per sample the four strongest layers' indices and weights (one byte each: 256 layers, the format's dimension,
    no channel cap). Hand paint is a separate map with an amount per sample (0: the baked weights, 255: all paint); the
    shown layers are the two mixed by the amount (`terrainLayersAt`). Paint `erase` lowers the amount (back to the
    rules), not one layer. The paint brush core (`paintPoint`) moves the weights.
  - Blob: the block chunks' 12-byte header moved to `binary-container.ts` (magic, version, compression, two bytes the kind
    uses, raw length) and is shared; a tile's two bytes are its size and maps, so the commit check and memory figures read
    no payload. Heights are stored as differences from a plane through the samples before (left + above − above-left),
    low bytes then high bytes; maps as planes; a map holding only its default is not written, so equal tiles are equal
    bytes. Stored gzip (not zstd) in the project too, so a build ships the very blob (one digest from edit to export) and
    the page inflates it natively (the zstd reasons of 30.2 part B).
  - Brushes: one dab reads the heights as they were before it and writes 16-bit steps; edge samples are written in every
    tile holding them; the falloffs are the paint brush's (`brushFalloff`); noise is value noise from an integer hash.
    Per-request bounds only (`TERRAIN_BRUSH_LIMITS`: 1,024 dabs, 2,048 m radius, 16,777,216 samples covered by a stroke;
    `HEIGHTMAP_MAX_SAMPLES` 8,193²); nothing caps tiles. Points are world metres.
  - Import: one pixel per sample from tile `at`, rows going +z; tiles it reaches are made, new tiles past the image take
    its nearest edge (no cliff), existing tiles keep their samples past the image. A 4,097² RAW (33.6 MB) is over the
    32 MiB upload: 4,096² is the largest square RAW; a PNG16 of 4,097² fits (19 MB here).
  - Converter (`fromBlocks`): samples take the bilinear lattice-vertex heights (the mean of the column corners at each
    vertex), cells over empty columns become holes, new tiles' cells off the layer are holes; paint layers 0–3 become hand
    paint (amount 255), wetness is dropped (terrain has no wetness channel yet). The block layer is not changed.
  - Memory: a terrain has no tile cap; `queryTerrain` reports `memoryBytes` (what the tiles take decoded) and
    `storedBytes`; the runtime's diagnostics figure comes with 30.11, when Play holds tiles (`TerrainField.memory()`).
  - The registry guard moved from 282,000 to 284,000 bytes (the terrain descriptor and the five exclusions naming it).
    `commands/types.ts` (1,991 lines) gave its op-name unions to `mutation-ops.ts` before it grew.
  - Notes for 30.11: the data API is `TerrainField` (project-model `terrain-field.ts`, re-exported by runtime):
    `heightAt`, `sample` (normal, slope, layers), `holeAt`, `tile(x, z)` (`TerrainTile`: `heights` Uint16 row-major,
    `weights`/`paint` interleaved 8/9 bytes per sample, `holes` bits per cell), `tileBounds`, `memory`; the page loader is
    `loadTerrainField(component, origin, read, only?)` / `terrainTileOf(blob)` (game-host `terrain-tiles.ts`, `read` = the
    `manifest.buffers` resolver; `only` limits it to a ring of tiles). In the editor a tile's bytes come from
    `GET content/buffers/<digest>` (the instance-set route) and `terrainTileOf`. A sculpt changes only the tiles in the
    result's `terrain.tiles` (upload those texture regions). Holes are per cell (between samples). The Terrain tool set
    (30.10 part B) can run the same cores (`sculptTerrain`, `rampTerrain`, `paintTerrain`, `holeTerrain` on
    `TerrainSamples`) for its local preview; paint dabs cost 5–23 ms at 32–64 m radius on the CPU (a GPU preview avoids it).
- 2026-10-07 (30.11 part A): terrain rendering. Default chosen, owner to confirm:
  - CDLOD as planned: every tile is a quadtree root (no nodes across tiles, so a node's samples are one texture
    layer), nodes of `16 · 2^L` cells drawn as one shared 16² grid (`TERRAIN_GRID_QUADS`); a level reaches twice the
    one before; the finest reaches `lodDistance` (component, optional) ÷ the LOD bias, never less than 4.5 leaf nodes
    (`TERRAIN_LOD_MIN_LEAVES`; with the morph starting at 70 % of a level's ring, neighbours stay within one level and
    a node next to a finer one has not begun to morph — the vitest checks both on rolling ground). A child its parent's
    split leaves outside the finer range is drawn at the finer level fully morphed (no quarter meshes). A tile's root is
    drawn however far (the coarsest level does not morph): the horizon is one node per tile, under fog. Absent
    `lodDistance` = the least (no earlier look to keep: terrain was not drawn before).
  - Textures: two RGBA8 texture arrays per page of ≤ 256 tiles (`TERRAIN_PAGE_LAYERS`, both renderers' guaranteed
    layer count): heights as two bytes + normal xz, and layer weights 0–2 (3 is the rest) + a hole bit per cell. RGBA8
    because both renderers sample it everywhere (R16/float textures are optional or unfilterable); the vertex shader
    filters heights by hand at full 16-bit precision. A page grows by doubling (new textures, a new compile); a
    sculpt re-uploads the changed tiles' layers (and neighbours' normals on shared edges), nothing is meshed on the
    CPU. Normals are baked per sample on the CPU from the heights across tile edges (seamless light) and read per
    vertex at every level; a coarser per-tile far normal comes with the macro texture (30.12).
  - Material: the terrain wears its `materials` component's `"*"` (the component now allows a terrain; additive, no
    schema bump): a graph material is compiled for the terrain's surface (`GraphSurface`: UV0/UV1 = metres in the
    terrain's frame less whole `WORLD_UV_PERIOD_METRES`, COLOR_0 = the layer weights, the mask = holes, the position =
    CDLOD) — the layered template works unchanged, 12 texture reads plus one weight read. Layers are drawn 0–3 only
    (the template's four); a tile's layers past the fourth are left out and the four take their share — more layers
    need an index-reading material (30.12). Without a graph material the terrain shows its four layers as plain
    colours. Material swaps at run time do not reach terrain yet.
  - Shadows: the terrain is a static caster (its position node is marked steady: it moves vertices only from data
    whose owner redraws the static map); the morph reads the view's camera in every pass, so shadow and view shapes
    match. Other shadow cameras draw every selected node (no per-pass culling yet).
  - The editor's `resolveBuffer` now reads raw bytes (it parsed every buffer as floats, which refused a tile blob of
    an odd length). `gunzip` and `terrainTileOf` moved to the runtime (the adapter and the page both decode tiles).
  - Notes for part B (collision): tiles are decoded on the page by `terrainTileOf` (runtime) and by
    `loadTerrainField` (game-host) for `TerrainField`; the adapter's tile data is per terrain in `terrain-view.ts`
    (not shared with collision yet — part B should keep one decoded copy, e.g. the page's `TerrainField` handing tiles
    to both, and report `TerrainField.memory()` in diagnostics). Heights between samples: the renderer is bilinear
    (as `TerrainField`); a heightfield collider is two triangles per cell, so near a sharp ridge the two differ by
    the cell's bilinear bow — pick the triangle split in `TerrainField` if part B needs the exact surface. The Rapier
    0.20 heightfield has no holes: tiles with holes need trimesh patches (or 0.21). Picking in the editor is off for
    terrain meshes (their grid is flat on the CPU): part B's raycast should read `TerrainField`.
- 2026-10-07 (30.11 part B): terrain collision and part A's gaps. Default chosen, owner to confirm:
  - Rapier stays at 0.20: 0.21.0's types (read from its package; the changelog on the repo stops at 0.19) add only
    `HeightFieldFlags.FIX_INTERNAL_EDGES`, no holes. A holed tile is cut into 16 × 16-cell patches
    (`TERRAIN_COLLIDER_PATCH_CELLS`: a cut patch's mesh, 17² vertices and ≤ 512 triangles, is within the port's mesh
    limits): whole patches merged greedily into rectangles, each one heightfield; cut patches a mesh of their whole
    cells; all-hole patches nothing (a 1,025² tile with a hole: 65 colliders, not 4,096). Physics e2e and the game
    copies did not need rerunning (no Rapier change).
  - One surface: Rapier's heightfield splits a cell from its (+x, min z) to its (min x, +z) corner (probed), which is
    also the renderer's grid diagonal; `TerrainField.heightAt` now uses that split instead of bilinear, so queries,
    colliders and the finest level agree exactly (rays down hit the field within 2 mm, Node); the bilinear surface
    differed by up to |h00 + h11 − h10 − h01| / 4. Coarser levels stay a visual approximation.
  - A new port shape `heightfield {cellsX, cellsZ, cellX, cellZ, heights}` (heights in Rapier's column order, so
    nothing is turned on the way; a static collider only; at most `COLLIDER_3D_LIMITS.heightfieldCells` = 1,024
    cells a side, the largest tile's). Colliders are `<terrain>#terrain:<x>,<z>:<piece>`; rays name the terrain.
  - `collision` on the terrain component (additive, optional, absent = on, stored only when off; no schema bump,
    neither game needs a change: no game has terrain yet). The collision ring is a hook in `TerrainColliders`
    (every tile now); 30.16 passes its ring.
  - Where tiles live: one decoded copy per tile on the page (`TerrainTileStore`, by digest), shared by the renderer,
    picking and — on the page — the simulation's colliders (the same arrays); a simulation in its worker gets a copy
    of only heights and holes (no shared memory without cross-origin isolation, which an export on any static host
    lacks). The page reads a start scene's tiles before the game starts and a loaded scene's before the simulation
    gets it, so the ground is there on its first step; a tile whose data has not arrived has no collider (no
    fall-back plane). Sim-side figures are the runtime's `terrainMemory`; the page's are the renderer's `cpuBytes`.
  - Decode and packing run on a worker of the view worker script (`mesh-worker.js` runs the block mesher and the
    terrain packer side by side; the export ships it with block layers or terrain). The worker packs a tile alone;
    the page writes its border normals once neighbours are known (4 × samples, cheap) and re-uploads a neighbour's
    heights layer when its border changed. Uploads: a layer texture at a time, within 2 ms and 4 MiB a frame (at
    least one): a 1,025² tile goes up over three frames. A tile whose digest is no longer drawn by any terrain is let
    go from the store.
  - Any number of layers: weights in channel `layer % 4` (a second layer of the same channel at a sample is merged
    into the stronger), a third texture array with the layer each channel holds per sample (an empty channel takes
    a neighbouring sample's, so filtered weight shows the right layer), and `GraphSurface.arrayLayer` maps the
    graph's array layer (slot 0–3) to that per pixel: the layered template is unchanged and every existing terrain
    material draws all layers. Per-layer settings follow the slot (layer L takes slot L % 4's); two layers of one
    slot at neighbouring samples meet at a hard edge half way. Reads per pixel 15 (template 12, weights, indices,
    hole; was 14); GPU +0.04 ms on the landscape class's scene pass. Per-layer settings for any layer (a settings
    texture) belong with the rule system (30.12).
  - Run-time material swaps reach terrain (its pages are dressed again).
  - Notes for later items: `ctx` surface queries (30.18) can read the runtime's tile data or ask the colliders;
    the runtime keeps only heights and holes (no layers) in its worker. 30.16 streams through `TerrainTileStore`
    (`decoded`/`packed`/`release`) and `TerrainColliders`' ring; the sim builds a 257² tile in ~7–9 ms, so the
    ring should add a few tiles a step at most. The landscape class has no player: a step's cost with its 144
    tiles' colliders is not measured in the browser.
- 2026-10-07 (30.10 part B): the Terrain tool set. Default chosen, owner to confirm:
  - Where: the tools are the `terrain` component's Inspector extension (as a block layer's Blocks tools), armed by
    "Edit terrain" while the Scene view is in front; GameObject → Terrain makes 2 × 2 tiles of 257 at 1 m, heights
    −128…384 m, centred on the origin. One brush state for every tool (strength in metres for raise/lower/noise, a
    0–1 blend for the rest); Ctrl inverts (lower, erase paint, fill holes); flatten levels to the press point's height;
    a ramp is a press-drag-release between its ends; a stroke holds at most the command's dabs at its radius (992 at
    64 m on a 1 m grid). Layer picker: eight swatches (default colours) + any number 0–255 (no material layer names
    yet).
  - Preview "in place": each dab draws, per tile it reaches, one full-screen pass into a scratch target (pow2 of
    the rectangle) reading the page textures as they were, then copies the rectangle into the tile's layer
    (`copyTextureToTexture`; all passes before any copy, so every tile reads the pre-dab state); the page's CPU copies
    keep the stored tile, so a cancel/refusal re-uploads from them. Heights use the cores' arithmetic (integer step +
    rounded delta, the cores' falloffs, value-noise hash — `TERRAIN_NOISE_HASH` now exported by project-model, ramp)
    and normals are recomputed as the packer does; paint moves the drawn weights toward the layer's channel and names
    it (exact on ground painted with one layer; an erase previews toward layer 0, what ground without rules bakes —
    revisit with 30.12's rules); holes exact. Cross-tile reads only within a texture page (≤ 256 tiles). The passes
    are built when a tool/terrain is chosen (drawn once into a 1-texel target: WebGL 2 links at first draw), which
    took the first dab from 15–28 ms to < 1 ms. The preview does not move the quadtree's height bounds (culling/LOD
    may lag until the commit) nor the CPU field (the cursor and dabs aim at the stored ground, as the block tools do).
  - Settling: the release passes the result's `terrain.tiles`; those keep the preview until their new data arrive
    and upload (a neighbour's border re-upload skips a previewed tile), the rest re-upload at once; 15 s without data
    restores them. Fixed on the way: an undo arriving before the edit's tile read finished let that stale read land
    (`setTerrain` now drops the read when the wanted digest is the drawn one).
  - Measure hooks: `data-terrain-stroke` (dabs, preview ms/frame, commit and settle ms), `?terrainCheck=1` reads the
    preview back and compares it with the stored tiles once settled (test-only cost).
  - The fast gate's village perf check misses on WebGL 2 (p50 4.9 vs 4.84 ms) with or without this change (HEAD
    9bd926bd measured with it stashed): D191.
- 2026-10-03: Skyforge's requests mapped (the engine never reads the game
  repo; the ids only trace them back):

| Request | Where |
|---|---|
| E79, E80, E40 normal check and per-layer settings, D52 | 28b |
| E81.1 live blocks | 30.3 |
| E81.2 edge pieces | 30.4 |
| E81.3 auto-connect, E8 autotiling | 30.5 |
| E81.4 interiors | 30.7 (lighting from 29) |
| E81.5 side-face paint, E40 wall default, lip wrap, wetness | 30.6 |
| E81.6 kit swaps | 30.8 |
| E8 should-haves (Problems checks, block AO, grid graph) | 30.9 |
| E37 cell caps, block streaming, addressable instances | 30.2, 30.16, 30.13 |
| E39 surface queries, E40 weights at a point | 30.18 |
| E40 auto-paint rules | 30.12 |
| E61 river flow and foam, E54 scene depth | 30.14 |
| E82.1–E82.4 heights, material, lighting, gameplay bounds | 30.17 |
| E82.5 foliage across both | 30.13 |
| E82.6 LOD and fog | 30.11, 30.19 |
| E82.7 static batching, E82.8 probes | 29.10, 29.5 |
