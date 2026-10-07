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
| 30.3–30.27 | — |

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
