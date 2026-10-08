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
| 30.12 | part A done 2026-10-07 (material rules on terrain and blocks; per-layer settings for every layer; biplanar and the macro texture are part B): `surface-rules.ts` (rules: layer, strength, face top/wall, height/slope/cavity/noise/weight ranges with fades, block types and cell metadata for blocks; one `SurfaceRuleSet` evaluates a surface point), terrain bake `terrain-rules.ts` into the tiles' baked weights (`editTerrain` `bake {rules}`; a sculpt/ramp/import/conversion bakes again over the samples whose surroundings it moved, the same bytes as a whole bake), block layers `blockLayer.rules` evaluated per vertex when chunks are meshed (page = workers, byte-tested); hand paint stays over both; editor **Material rules…** (terrain tools) and **Rules…** (Blocks panel), layer table **Add layer** (`extraLayers` on vec4 per-layer settings: each terrain slot reads its layer's own value from a uniform array, 0 extra texture reads, still 15). Measured: bake (Node, 4 rules incl. cavity r 4 m and noise) 257² tile 54 ms, 1,025² 447 ms (0.4–0.8 µs a sample), a 16 m raise re-baked in 7–16 ms; the landscape class's 144 tiles 7.3 s (one `bake` command, backend); block chunks (64 × 64 sloped rooms, 16 chunks) paint 0.34 → 16.6 ms a chunk with rules (meshing ~31 ms; workers). Scene view while a 128 × 128 layer's rules change (`blocks`, 192 chunk meshes): worst 18.4/18.2 ms, p95 17.5/17.7 ms, none over 33 ms (WebGPU/WebGL 2; a type change: 18.4/17.8). `level --classes landscape` before → after → `--rules` (rules baked + `extraLayers` on every setting): WebGPU p50/p95 8.0/8.9 → 8.1/10.2 → 8.1/9.1 ms, GPU 12.81 → 13.03 → 13.00 ms (scene 6.24 → 6.28 → 6.35), main 8.06 → 8.23 → 8.18 ms, 475/475/474 draws; WebGL 2 5.2/9.0 → 5.1/9.0 → 5.2/9.0, main 8.25 → 8.14 → 8.19 (run-to-run spread ~0.2 ms). Pixels: terrain-cdlod e2e (rules from the editor; Scene view WebGL 2, Play and export WebGPU and WebGL 2: a steep ramp and block walls/steep top magenta, the hand-painted disc on the ramp blue through two bakes, flat tops red). Unverified: per-layer values past the fourth by pixels (stored and drawn without error on both renderers; their look not compared), the owner's laptop. Part B done 2026-10-07 (projection, no triplanar): node `projectedSample` (top at the UV / by slope: the world plane the ground faces most, one read / biplanar: top and side blended, two reads within `near` m, a branch), the layered template's `layerProjection` per layer (private; `extraLayers` like the others) and `biplanarDistance` (60 m); a projection that can only be top compiles to the plain read; the layer table's projection select and its read cost ("12; 3 more for a biplanar layer where both planes show within 60 m"). Measured (host loaded during these runs: post passes ~25 % slower than earlier today, so read the differences): landscape scene pass with every terrain layer top/by slope/biplanar 6.47/6.60/7.01 ms (+0.13/+0.54); the template at the top against part A, alternating builds 4 runs each: scene median 6.42 vs 6.37 ms, GPU 15.66 vs 15.72 ms (equal within the spread). Pixels: terrain-cdlod e2e (WebGL 2 Scene view: layer 3's checker crosses 2 times along the steep ramp at the top, 7 by slope and biplanar; Play and export draw the biplanar layer on both renderers); seen in screenshots (stretched stripes → square checks). Unverified: side-projected normal maps' lighting (test maps are flat), WebGPU Scene-view pixels of the projections, the owner's laptop. Part C done 2026-10-07 (macro texture): `terrain.macroDistance` (optional; absent: the layers everywhere); per tile a top-down bake of the page's own material (albedo, and the shading normal in world space; ≤ 128 texels a side) on the GPU into per-page macro arrays (`terrain-macro.ts`: the tile's finest nodes, orthographic, copied into the tile's layer; programs compiled ahead with `compileAsync`), re-baked when a tile's texels change or its material's nodes do, ≤ 2 ms of the page a frame; nodes wholly past the distance whose tile is baked go to a second instanced mesh per page (`splitFarNodes`, in view first) with a 2-read material, same vertex stage (no cracks). Measured: `level --classes landscape --macro 400` against without, alternating (Iris Xe, WebGPU): scene pass 6.30/6.39 → 5.90/5.90 ms, GPU 15.50/15.49 → 14.79/14.80 ms (host loaded: post passes slower than this morning), +1 draw, main 9.8–10.0 → 9.6 ms; WebGL 2 p50 5.0–5.3 → 5.1–5.2 ms; bakes' main-thread time 0.9 ms a tile (terrain-cdlod e2e, 65² tiles, both renderers: 58.6 ms / 64 bakes, 91.2 / 100). Pixels: terrain-cdlod e2e, Play (diagnostics: 64 tiles baked, 142 far nodes, stable through the frame taken) and export, WebGPU and WebGL 2: layers, discs, ramp and hole, no crack; seen in screenshots (the far ground matching the near). Unverified: the bakes' GPU time, the switch's pop at the distance (no fade), far shimmer without mipmaps, the owner's laptop. |
| 30.13 | done 2026-10-07 except per-copy colliders/the script address API and far-tree impostors/HLOD (follow-up, below): scatter rules `terrain.scatter` / `blockLayer.scatter` (`project-model/scatter.ts`: model, density, spacing, scale/yaw/align/sink/seed, the material rules' conditions via shared `ruleConditionsAt`, layer shares, `exclude` regions; deterministic jittered grid, hash-priority spacing, so a rectangle baked again equals a whole bake, vitest) baked per terrain tile into a scatter blob of its own (`tiles[].scatter`, `terrain-scatter.ts`) and per block chunk (`scatter`, chunk binary layout 4, `block-scatter.ts`), by `editTerrain` (bake {scatter}; sculpt/paint/holes/import bake again over the changed samples grown by the reach) and `editBlocks` (every edit bakes its chunks ± reach; `bakeScatter`); hand edits (`editTerrain` kind `scatter`, `editBlocks` `scatter`: the rule's candidate cells added/erased) survive every bake; every copy keeps an address (rule + cell), `queryTerrain {scatter: {box}}`. Drawing: `scatter-view.ts` one instance set per rule and 2,048 m group (chunk 2,048 m, per-copy LOD, culled per copy in the draw; a rule a step), ground cover (`cover: true`, `coverDistance`) made in 32 m squares round the camera on the view worker (`cover-worker.ts`, the same rule code and surfaces) and drawn thinning to nothing at its reach (`cover-view.ts`); `?scatter=off`. Foliage policy: castShadow off by default, `shadowDistance` (near copies cast from shadow-only squares into the moving map), `blobShadow` discs within 60 m, foliage `windDistance` (vertices past it skip the wind's work), density falloff; documented in deployment.md (Foliage best practice). Editor: Scatter rules… (terrain tools, Blocks panel), Scatter brush tools; terrain-cdlod e2e drives both dialogs, the brush (erase + undo), checks positions (only on the green disc and under 30°, none over the terrace's sloped cell) and pixels (posts and near-camera tufts in Play and the export, WebGPU and WebGL 2). Measured (`level --classes landscape`, v3: 3 terrain rules → ~37k stored copies over 6 km, shrubs on the block layer, grass + flowers as cover; Iris Xe 1080p) against `?scatter=off`: WebGPU GPU 12.53 → 15.21 ms (+2.68; §5 ≤ 3.0), scene pass 6.34 → 8.91, draws 260 → 308 (+48; with the terrain's 2: 50, §5 ≤ 60), main thread 8.07 → 9.61 ms (+1.54; WebGL 2 8.57 → 10.38, +1.81; §5 ≤ 2 ms for terrain + scatter + streaming: with the terrain's 0.5–0.9 ms, over by up to ~0.7 ms), p50/p95 8.0/9.1 → 9.5/10.9 (WebGL 2 2.7/9.2 → 8.0/9.9). Foliage policy off (`--foliage off`: every copy casts into the static map, no thinning, wind everywhere) vs on: 641k vs 542k triangles, moving shadow pass 0.38 vs 0.26 ms a frame, static shadow redraw 1.69 vs 0.81 ms, GPU 15.25 vs 15.21 ms (this still camera hides the static map's cost; on draws +17: blobs and near squares), draws 291 vs 308. Bake: the class's 144 tiles 0.9 s (one command); Node: a 512 m tile 7 ms (30 ms at 16× density), a 16 m raise's rectangle 0.6–5 ms; page: a 2,048 m group's sets 3–7 ms a rule at the class's density, 10–30 ms at 16× (over a frame: a dense forest needs smaller groups — follow-up), a 32 m cover square at 2/m² 4 ms on the worker + 0.7–1.1 ms on the page. Unverified: frames during a re-bake in a browser flight (§5 none over 16.7 ms; Node build times above suggest dense content misses), the policy's win with a moving camera, the look (owner), the owner's laptop. |
| 30.13b | done 2026-10-08: **sets off the main thread**: a set's arithmetic (chunks, every copy's matrix per mesh, bounds, per-copy LOD inputs) is `instance-prepare.ts` (no three.js; equals three's compose/multiply/`Sphere.union` bit for bit, vitest), run on a scatter worker of the view worker script (`scatter-worker.ts`); the page makes the draws within 4 ms a frame and keeps the old set until the new one replaces it. Node, a 2,048 m group at 16× density (48,864 copies, 3 rules): page alone 4.4 + 1.7 + 13.6 ms → worker 2.9 + 1.7 + 9.1 ms, page 1.4 + 0.5 + 3.5 ms. Moving-camera costs cut (found by the new flight): near-shadow squares looked up round the eye instead of all of a group's (was 30 % of the flight's main thread), per-copy culls and LOD picks by 64-copy blocks in Morton order (a block wholly in/out of view or barely moved toward keeps its result), depth order by 256 buckets past 512 copies, the drawn buffer uploaded only as far as written (update ranges) and a set that casts nothing writes no copies the view leaves out. **Flight** (`level --flight`: a script flies the camera round a 400 m loop in 60 s, 6 m over the ground, and hides the nearest copy every 0.5 s, shows it 1 s later, removes one every 2 s; 60 Hz vsync, missed refreshes counted): before (d5492a51) 1 / 2 missed (WebGPU / WebGL 2), main thread 12.0 / 12.0 ms a frame; after 0 / 0 missed, 5.9 / 5.6 ms (§5: none over 16.7 ms ✓); 70 sets made on the way (removals: what a re-bake does) in ≤ 7.2 ms of the page (mean 1.1 / 1.4) after ≤ 12.7 ms on the worker; uncapped p50 12.7 / 12.4 → 7.6 / 4.7 ms. Still camera (`level --classes landscape` against `?scatter=off`): WebGPU main thread +1.54 ms (9.59 vs 8.05; WebGL 2 +1.36), of which the page's JavaScript (three and the adapter) +0.46 ms and the rest the 47 more draws' GPU calls and waits on this GPU-bound frame; GPU +2.64 ms (§5 ≤ 3). §5's main thread ≤ 2 ms for terrain + scatter + streaming: the JavaScript is well inside it; counted with the draws' calls and waits, scatter's +1.5 ms and the terrain's 0.5–0.9 ms are over by up to 0.4 ms on this GPU-bound still frame (moving, the page has room: 5.6–5.9 ms of a 16.7 ms frame). Merging ground cover's squares into one set a rule (−20 draws) measured worse (+0.1–0.3 ms main thread, the frame being GPU-bound) and was not kept. **Per-copy colliders and addresses** (E37 part 3): `RuntimeScatter` (runtime `scatter-copies.ts`, held by the grid) knows every stored copy (block chunks' from their data, terrain tiles' scatter blobs read and decoded by the page, `PageScatterBlobs`), builds a static collider per copy of a `collide` rule from its model's `_COL` parts (the build's model collider table now holds the scatter rules' models too), its id the copy's address `<object>#scatter:<rule>:<ix>,<iz>`, in the grid's collision batches and behind a ring callback (every tile now; 30.16's streaming ring); `ctx.scatter.near/get/hide/show/remove/changed` (graph nodes too), a ray hit names the copy (`PhysicsHit.scatter`), the renderer follows hidden copies in place (shrunk to nothing) and removed ones by making the group's set again (vitest; e2e below). **Far trees**: octahedral impostors (`impostor.ts`): the model's most detailed meshes in their own materials drawn once per page from 8 × 8 hemi-octahedral directions into a 1024² albedo + normal atlas (MRT, both renderers; 9–25 ms of the main thread once per model, 11.2 MB of GPU memory with mips), drawn as the copies' farthest level below the rule's `impostorSize` (a screen size; absent: none) with three frames blended. Landscape with `--impostors 0.03`: 542k → 452k triangles, GPU 15.17 → 14.59 ms, draws the same; per-tile HLOD was not built: its copies keep at least their coarsest level's triangles (≈ 103k for the 6.4k far copies here against 13k as impostors) and add a draw per tile ring, so impostors are the cheaper. e2e (terrain-cdlod, both renderers): the dialog writes `collide` and `impostorSize`; a band of hand-put posts stops the walking player (from z −5.00 it stops at −4.08, the band at −3.71 to −1.43; 41 copy colliders); a script hides every copy by address (69, the renderer 69) (simulation and renderer counts agree, the posts' pixels leave the frame) and shows them; a second Play draws the terrain's posts as impostors (baked, the copies at its level): post pixels 789 → 834 (WebGL 2 780 → 825), mean colour (133, 80, 34) → (136, 83, 37). Unverified: the impostors' and the flight's look (owner), the owner's laptop, impostors on real tree models (the class's are lathes of a few dozen triangles). |
| 30.14 | done 2026-10-08: one `spline` component (`project-model/spline.ts`, `spline-curve.ts`: points with optional tangent, width, roll; Hermite with Catmull-Rom tangents; 0.5 m distance table) with `terrain` (flatten/carve/raise/none, falloff, depth, offset, paint, order), `scatter` (bands), `mesh` (surface profile or water), `pieces` (kit models every n m, `_COL` colliders) and the host-written `data`; GameObject → Level → Spline/Road/River; Scene handles (point, height, width, tangent, insert; Alt+click deletes; one command and undo step each); `ctx.splines.length/at/nearest` (graph nodes too). Terrain: hand-made form kept beside the drawn tile (`tiles[].base`, not exported), splines combined per sample over it, only the boxes round changed segments re-baked (box = whole, vitest); scatter bands clear stored scatter and ground cover; paint over the rules. Meshes made by the backend: 64 m pieces, meshoptimizer levels (end rows locked, foam weighted), one blob; colliders from the same triangles; River template (two-phase flow, bank foam, new Scene depth node: soft shores) both renderers. Measured (Node, 1 km road over 2 km of 512 m tiles, 4 material + 3 scatter rules): added 128 ms plan + 157 ms encode (5 tiles), a point moved 5 m 51 + 31 ms, removed 31 + 80 ms; meshes: road 1,018 m made + simplified + encoded 10.9 ms, 16 pieces, 2,048/1,024/512/256 triangles per level, 111 KB; river 32.3 ms, 16,384/8,188/4,089/2,042, 763 KB. Landscape class (road 1 km + river 0.9 km added) against `?splines=off`: WebGPU draws 311 → 338 (+27: a draw per 64 m piece in view), main thread 11.76 → 12.13 ms, GPU 17.99 → 17.74 ms (no measurable change; both runs' GPU is up on 30.13b's 15.2 ms with the host, as D192), WebGL 2 draws 311 → 341, main thread 10.83 → 11.49 ms; command round trip in the class 200–380 ms. Scripted spline edits in the Scene view: WebGPU ~10 frames over 16.7 ms per edit (worst 79–103 ms; windows without edits: none) — §5 missed in the editor, cause profiled (node builds, scatter sets made again, ground cover), D193; WebGL 2 no worse than without edits. Pixels (terrain-cdlod e2e, both renderers): road flattened, painted and clear of scatter, river water mesh with posts along it, in the Scene view, Play and the export; handle drag + undo; Play spline colliders. Unverified: the look of roads and rivers (owner), soft shores by eye, the owner's laptop; follow-up: merge far pieces into fewer draws. |
| 30.14b | done 2026-10-08 (D193): **re-bakes without hitches.** Found with marks for every node build and pipeline three makes (`node-builds.ts`, read per window by `level --spline-edit/--sculpt-edit`, `--edit-profile`): an edit released and realized its terrain and spline again, and the terrain's release dropped its scatter (all 27 sets of 9 groups made again, ground cover dropped) and re-dressed it with the same material (a new graph material, its node programs built again); the scatter now goes only with the terrain (3 sets made per edit: the changed tiles' groups), the same materials stay on, a released spline keeps drawing until the next frame's update, ground cover is made again only under the scatter bands that moved and keeps its old copies until the new ones are built, and three's released node builds, pipelines and programs are kept 10 s (`RELEASED_BUILD_KEEP_MS`) for the objects made in their place (vitest). Landscape, editor Scene view, 6 edits each (4 s windows): road point moved, WebGPU before 9–11 frames over 16.7 ms per edit (worst 80–115 ms; 7 node builds, 80–100 ms) → after 2 frames in all 6 windows (worst 17.3, 22.0 ms; 0 builds); sculpt under a tree (2 m, r 12 m) before 9–12 per edit (worst 79–119 ms) → after 4 in all 6 (worst 17–27 ms); windows without edits 0 (worst 13–16 ms). WebGL 2: builds 7 (90–100 ms) + pipelines (up to 176 ms) → 0; its edit windows (11–20 over) match its own windows without edits (12–26, uncapped stalls). Flight (`level --flight`, vsync) kept: 0 / 0 missed refreshes, main thread 6.2 / 5.8 ms. §5 "none over 16.7 ms while re-baking": nearly (2–4 frames of 17–27 ms in 6 edits); those frames' main thread is the usual scene draw (28 render objects made, 1.4 ms), the rest GPU (uploads, the static shadow map drawn again whole). |
| 30.15 | done 2026-10-08: `terrain.layers` (stamps, erosion, the splines' place; `enabled`, `strength`; absent = one base layer, no conversion) combined over `tiles[].base` by `TerrainLayerStack` (`terrain-layers.ts`); layer changes follow like splines (only the boxes they reach; rules and scatter re-baked there; rect = whole, vitest); `editTerrain erode` (hydraulic + thermal, `terrain-erosion.ts`, deterministic) on the backend's worker thread, stored per tile as a difference; export/Play ship only `data` (integration test). Editor: Layers… list (switch, strength, ▲▼, delete), Stamp tool (heightmap asset picker, height, turn, mode, edge fade), Erode tool (terrain-cdlod e2e). Node: combine a 1,025² tile through 4 stamps 21 ms, an erosion layer 4.6 ms (257²: 10 / 0.3 ms); erode a whole 1,025² tile 0.9 s hydraulic / 1.5 s thermal / 2.3 s both (worker); stack per 1,025² tile 0.83 MB hand-made + 0.66 MB per erosion layer stored (2.1 MB each read, editor only). Landscape Scene view, 6 edits each (4 s windows, `level --stamp-edit/--erode-edit/--sculpt-edit`): WebGPU stamp 1 frame over 16.7 ms in all 6 (33.7 ms), erode 2 (18.2, 29.0 ms), sculpt 1 (24.7 ms), without edits 0; 0 node builds/pipelines; round trips stamp 184–317 ms, erode (64 m) 236–421 ms; WebGL 2 edit windows 13–22 over vs 14–29 without edits (its uncapped stalls). e2e (both renderers): stamp + erode via the tools 25 / 168 ms, Scene-view pictures with erosion on/off differ 7.2 / 5.0, stamp on/off 11.3 / 9.5 (mean abs, WebGPU / WebGL 2), flanks magenta from the rules after the stamp. Unverified: the look of the channels (owner), the owner's laptop; painted per-layer masks not built (§7). |
| 30.16 | done 2026-10-08: **world streaming**. `streaming {render, collision?, scatter?, live?, hysteresis?}` on terrain and block layers (`project-model/world-streaming.ts`; absent: everything loaded, as before) and the project setting `streaming_budget_mb` (768 MiB). **Page** (`three-adapter/world-stream.ts`): each view asks which of an object's cells to hold round the drawn eye when it moved a quarter of the ring's hysteresis — the ring (asked that much further), then what the hysteresis keeps while the budget has room (rings never cut; their overflow is a problem, `world_streaming_over_budget`) — and holds and lets them go through the resource manager (kinds `terrain-tile`, `block-chunk`, `scatter-group`: freed at its settle after the frame, kept when taken back first). Terrain: only the render ring's tiles (and the collision ring's) are read, decoded and packed on the worker and take a texture layer (pages sized to the ring); the ring reaches at least where tiles draw only their coarsest level; past it an **overview** a build ships (`terrain-overview.ts`, `TLTO`: every tile at 17² samples, named by `terrain.overview`; Play's snapshot gets it too) is drawn wherever a full tile is not — a tile appears from the overview first and replaces it the frame it is up, and goes only once the overview draws its place (the same vertices there: no crack, nothing jumps); a tile let go drops its decoded copy and the simulation's. Block chunks are meshed in the workers only in the ring; scatter groups' blobs read and sets made only in the scatter ring. **Simulation** (`runtime/world-stream.ts`): collision and live rings round the committed camera, its target and every player character, looked at again at a step boundary when one moved 4 m and reaching 4 m further (a walking character's next tile is built before it arrives), admitted nearest first within a step's budget (one 257² tile or two chunks of collider work; an object's first look whole), leaving at once past the hysteresis; terrain, scatter-copy and chunk colliders and live blocks (16 spawns a step) follow; deterministic (vitest: two runs alike). Export: tiles were already blobs of their own; block cells stay one blob per layer (§7); the overview is new. The editor keeps everything loaded (§7). Measured (Iris Xe 1080p, vsync), `level --classes world --flight-plain` (new class: the landscape at 8 × 8 km, a square kilometre of block fields, all streamed; 60 s at 63 m/s): **1 / 1 missed 60 Hz refreshes** (WebGPU / WebGL 2; §5 none: a 42,000-copy scatter group entering the ring made on the page in one frame, D195), main thread 8.6 ms a frame of which streaming's own work averages 0.08 ms (deciding 0.05 ms mean, ≤ 0.7; tile uploads ≤ 2 ms a frame, chunk meshes swapped in ≤ 4.6 ms a frame), 81 tiles and 1,070 chunks streamed in; **resident 40 MiB (peak 64) of the 768 MiB budget** (31 of 256 tiles: all of them would be ~330 MB decoded + ~200 MB of texture layers); with the flight's copy removals (`--flight`) 14 / 21 missed (dense groups made again: D195). Still world: WebGPU p50/p95 10.5/11.1 ms, GPU 15.5 ms, main 10.6 ms, 379 draws; WebGL 2 4.3/16.5 ms. Landscape unchanged: still WebGPU 11.7/12.3 ms, GPU 17.2 ms (host as D192), main 11.8 ms, 341 draws (30.14: 338–341, 12.1 ms); flight 0 / 0 missed, main 6.1 / 5.7 ms (30.14b: 6.2 / 5.8). Tests: vitest (rings, overview, simulation admissions/hysteresis/edits/live/terrain/determinism, page residency/budget/resource manager, block, scatter and terrain views), integration (the export ships the overview, read back as the page reads it), terrain-cdlod e2e on both renderers: 28–32 of 64 tiles resident and the overview drawing the rest, the frame checks (layers, discs, posts, tufts, the hole, no crack) pass in the streamed Play and the export, a player walks across a tile border with a 1 m collision ring and never sinks (y 3.010 throughout), flying 400 m off lets every tile and chunk go (diagnostics), two returns give the same picture (mean difference 0.005–0.008). Unverified: how the overview/full swap at the ring looks (owner), the owner's laptop, characters far from the camera (their tiles' data may wait), live-block streaming in a browser (vitest only). |
| 30.16b | done 2026-10-08 (D195, D196): **streamed scatter without missed frames.** Profiled with `level --classes world --flight[-plain] --vsync --missed-marks`: each removal re-gathered and re-made its dense group (42k copies: 5–13 ms of the page in one frame, a miss at the removal and one at the make), and an arriving group was one chunk (the 2,048 m default chunk) made, then culled for the first time, in one frame. Now: copies hidden **or removed** are shrunk in place (only their matrices written and uploaded; a removed one is left out when its group is next made for another reason, a change during a make is written into the new set); a group's set is split by count (`SCATTER_SET_CHUNK_COPIES` 4,096), made a draw at a time (`beginInstanceSet` steps) and culled for the view where it will stand before it is shown (`prime`: first cull's spheres and level picks off the swap frame), old set drawn until then; block-chunk swaps and scatter making share one 4 ms a frame (`STREAM_ARRIVAL_MS`, world-stream.ts); a hidden copy's states looked up by number, not key string. **World** (Iris Xe 1080p vsync, missed 60 Hz refreshes WebGPU / WebGL 2): plain flight 1 / 1 → 1 / 1–8 (two runs; 0 / 3 and 0 / 7 before priming); with removals 20 / 23 (before, this host today; 30.16: 14 / 21) → 1–4 / 5–6; sets made: 52 (was 94), page ≤ 5–7 ms a frame over ≤ 18 frames (was ≤ 13 ms in one); no remaining miss is a scatter set's but one 3,953-copy set on WebGL 2 — they follow block chunks arriving and the static shadow map drawn again whole, and the river's far level's first node build (D197). §5 "none over 16.7 ms": missed on the world flight for those, met for scatter. **Landscape** flight 0 / 0 (kept), main thread 6.1 / 5.7 ms; still draws 341 → 343, world 379 → 381 (a dense group's chunks). Tests: vitest (a set made over frames with the old one drawn until whole, a step makes at least one draw, a primed set's first cull has nothing to do and draws what a fresh cull draws, removal in place then left out, arrivals' shared time); `scatter-view.test.ts` compares draws by identity and waits for the worker's answers instead of 5 ms, the scatter tests run on a still clock (D196). Unverified: the owner's laptop. |
| 30.17 | done 2026-10-08: a `blocks` edit layer on the terrain (`terrain-blocks.ts`, `TerrainLayerStack`; {blockLayers?, mode cut\|flatten, blend (8 m), paint?}): the border takes the block layer's ground (top of each column's lowest run, lowest of the tops sharing an edge), the ground round it fades back over the blend (smoothstep), `cut` holes the footprint a cell in (the ring 2 cm under the tops), `flatten` keeps it 2 cm under; the blocks' paint carries across; scatter and ground cover keep off; `terrain.uvOrigin` written by the host so textures line up; block edits re-bake round the changed columns in the same command (`blockSeamRebakeRects`; rect = whole, vitest); the far ground's macro bake no longer cuts holes (it left a dark rim); editor Layers… **Add blocks layer**, mode, blend, paint; MCP docs. **Lighting**: the probe bake's automatic tiles grow past a block area by the terrain's widest blend (the blended ground reads the area's probes); the far ground's macro bakes also measure each texel's horizon over the tile and its page neighbours (8 directions + the sun's, ≤ 256 m, loops in the shader): its sky share as the far material's AO, the sun behind it as a shadow term (`receivedShadowNode`); neighbours re-baked on a change, all far tiles when the sun turns 2°; `?terrainHorizon=off`. Measured: terrain-cdlod e2e Play and export, WebGPU and WebGL 2 — no sky round the plaza, colour across the border 0.6 m each side mean 1.9–4.6 / worst 3.6–10.8 (0–255; 18 allowed), on the border against the two sides ≤ 4.6; export far band 1.3–1.9 darker with the horizon light, near band equal (0.01); first far-tile bake frame 23–44 ms (23–27 without the measure; unrolled it was 88–163 ms); a player crosses the 8 m plaza both ways, never more than 2 cm below the ground; re-bake (`tests/perf/terrain-blocks.test.ts`, Node, 257² tiles at 1 m, landscape rules + scatter, 100 × 100 m area): layer added 480 ms, a border column raised 162 ms (one tile), a 2 m border repaint 140 ms, an inside edit moving no ground 113 ms, all in the backend; the e2e grew 2.5 → 2.9 min (the horizon comparison loads each export twice); landscape still WebGPU p50/p95 11.7/12.2 ms (before 11.7/12.3), GPU 17.4 ms, main 11.8 ms, 340 draws, WebGL 2 4.0/13.7 ms; flight 0 / 0 missed, main 6.0 / 5.8 ms (6.1 / 5.7); with `level --blocks-seam` (the area met, cut): WebGPU 11.6/12.4 ms, GPU 17.1 ms, 330 draws, WebGL 2 3.9/10.9 ms. Seen on this host: far hills' horizon shadows and the plaza's seam (probe scenes, both renderers). Unverified: the owner's eye at a game's distances, the owner's laptop; the terrain is not in probe bakes (D198). |
| 30.18 | done 2026-10-08: one surface query (`project-model/surface-query.ts` `surfaceAt`): the highest ground at or below a point from block layers (`surfaceBelow`, the colliders' shape) and terrains (`TerrainField`), a block layer winning a tie and terrain within 1 cm above it (`SURFACE_TIE_METRES`); height, point, normal, slope, layers + weights strongest first (block paint over the layer's rules as the mesh shows it, `chunkMeshPaint` for one vertex; terrain's nearest sample), block paint's wetness, cell and block. `ctx.surface.at([x, y, z])` / `top(x, z)` (graph nodes Surface at, Top surface; `runtime/surface.ts`), backend `querySurface {points, sceneId?}` (MCP `tl_content_query target="surface"`). The sim now holds the tiles' layer weights and hand paint (§7): heights at once, layers after them within 4 MiB a page turn. Measured (`TL_PERF=1 npx vitest run tests/perf/surface-query.test.ts`, Node): a query 1.7 µs median on terrain, 10.7 µs on a 100 × 100 block area with 4 rules incl. a cavity; the first after a tile arrived 0.11 ms (field made again); hand-over clone per tile heights+holes / +weights / +paint: 257² 0.015 / 0.22 / 0.44 ms, 1,025² 0.73 / 4.3 / 3.8 ms (now split: ≤ 4 MiB a turn); sim memory +8 B a sample (+9 painted): 257² +0.53 MB. Tests: vitest (surfaceAt cases, the sim across a seam incl. scenery terrain, late layers, script writes, drops), integration (`querySurface` on the blocks-on-terrain case), terrain-cdlod e2e (a script reads `ctx.surface` across the plaza's two seams in Play's worker: tops and blue paint on it, terrain heights and the blue carried across outside, equal to `querySurface`). Unverified: footsteps in a game. |
| 30.19 | done 2026-10-08: `heightFog` {density, color, height?, falloff?, start?, inscatterColor?, inscatterExponent?} in a scene's look and in presets (`HEIGHT_FOG_DEFAULTS`/`_LIMITS`, validator, descriptor; additive, absent = the old look), blended like the look (numbers and colours over the contributors, a look without it thins it, the glow fades). Drawn (`three-adapter/height-fog.ts`): the scene's fog node on every fogged material — the integral of density·e^(−falloff·(y − height)) along the ray past `start`, the classic linear/exp2 in the same node when both are on — and a dome just inside the far plane over the sky, so the edge of view and the sky meet in its colour; uniforms only (render group), a new node only when the classic mode or the glow switches. Environment window **Height fog** (on, colour, density, falloff, base height, start, sun glow, glow size); MCP docs; `level --height-fog`. Measured (landscape, 1080p, Iris Xe, alternating 2 × 2 runs): WebGPU GPU 17.20/17.04 → 18.02/18.13 ms (scene pass 8.66/8.69 → 9.16/9.10: +0.45 ms; the rest within the post passes' spread), +1 draw, frame p50 11.7/11.5 → 12.1/12.2 ms; WebGL 2 p50 3.9 → 4.0–4.1 ms, main 11.2/10.8 → 11.6/11.7 ms. Pixels: env-parity harness (no backend) on WebGL 2 and WebGPU — far pillars' feet more fogged than near boxes (+31) and than their tops (+18), the horizon the fog's red (+206 over plain), the high sky clearer, nearer than `start` unchanged (0), WebGPU = WebGL 2 (mean 0.00); environment e2e: the window's fields stored, the Scene view's horizon red, Play and the export on both backends equal (top red through the fog volume, within 0.1). Unverified: the sun glow's tint by pixels (compiled and drawn; the harness sun is behind its camera), the look over a real landscape's far edge (owner), the owner's laptop. |
| 30.20 | done 2026-10-08: shader type `trim` with a row table `trim` {size, texelDensity, padding, rows [{slot, top, bottom, texelDensity?, tileV?}]} (`project-model/trim-sheet.ts`, subpath `trim-sheet`; equal rows aligned by default, unequal allowed, starter layout of 9 slots, layout conformance, Texture Designer `layout.json` import); strip UVs (`writeTrimStripUvs`: u metres × row density, v half-texel inset) and the exact safe mip level per row (vitest against a brute-force box-mip + bilinear simulation); material (`three-adapter/trim-material.ts`): 3 reads, footprint capped by grad, centroid uv, COLOR_0 occlusion/grime/wetness blended without reads; wall paint sampled onto generated vertices (`trim-paint.ts`, `wallPaintAt` shared with the mesher, bytes unchanged); Inspector trim table + Create menu + backend padding check (`POST content/textures/trim-check`, worker decode). Pixels (layered-material e2e, WebGPU and WebGL 2): strips of each row from 4 to 30 m show their row's colour unchanged; the standard material on the same strips bleeds far away. Cost (`run.mjs trim`, ~85 % of 1080p): WebGPU scene pass 2.76 vs 2.51 ms standard (+0.25 ms, +10 %), WebGL 2 4.33 vs 4.18 ms/frame. |
| 30.21 | done 2026-10-08: the generator (`project-model/arch-*.ts`, component `architecture`: parameters only, additive). Operators: path (polyline, rational-Bézier arcs via `bulges`, the spline curve), offset, chamfer, sweep (mitred, strips one row tall, stacked; openings with reveals and swept frames; kit overrides), repeat (stamped generated pieces or kit copies, seeded jitter, stable ids), fill (flat/coffered/barrel/groin/gable/hip/mansard; vaults/roofs need a rectangle), vertex AO into COLOR_0 (bytes); own trig (no `Math.sin/hypot/**`, vitest-checked), one vertex set per chunk per material with near + far index lists (far drops detail, frames, coffers). Page: `ArchitectureView` + generator workers on the view worker script (2), keys = SHA-256 over version, sheets, profiles and the elements reaching the chunk (element hash 64-bit), memory cache 64 MiB, IndexedDB store in exports (`thirdlight-architecture`, raced with generation), old-until-new, cold-worker page fallback for the chunks round the eye; sim builds box/mesh/kit colliders from the same parameters; `architecture_ship_meshes` ships a `TLAR` blob (`baked`). Measured: Node warm, 64-room test village (240k tris): 32 m chunks 9 draws, 5.0 ms median / 7.2 ms worst per chunk (§5 ≤ 5: median met, dense chunks over); 16 m chunks 36 draws, 1.4 / 2.9 ms; keying the whole village 3.7 ms on the page; one room changed (keys + its chunks) 10 ms (16 m: 5.5 ms; §5 ≤ 16 ✓); blob 16.8 MB. Browser (layered-material e2e, Iris Xe, WebGPU and WebGL 2, Play and export): chunk 1.5–11 ms on a cold worker/page, spawn's chunks drawn 42–74 ms after load (§5 ≤ 100 ✓; 32–67 ms of it is the wait for the first frame); one draw per chunk per material (vitest). Pixels: a swept moulding (wall face, bevels, band) and a row of stamped columns on the trim material show their rows' colours in Play and the export on both renderers, export = Play. Unverified: the look (owner), editor slider drag (sliders are 30.22), other browsers' byte equality (only V8 tested; the arithmetic is IEEE-exact by construction), the owner's laptop. |
| 30.22–30.27 | — |

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
- 2026-10-07 (30.12 part A): material rules and per-layer settings for every layer. Default chosen, owner to confirm:
  - One rule list format for both (`surface-rules.ts`), stored on each component (`terrain.rules`, `blockLayer.rules`;
    additive optional fields, no schema bump, neither game needs a change): a rule names a layer, a strength and
    conditions — height (world m), slope (degrees), cavity (m: how far the ground `radius` around lies above the point),
    a 3D value-noise mask in world space, the share another layer has so far, top or wall (the box mapping's side),
    and on block layers block types and cell metadata — each a range with a smoothstep fade past its ends. Rules apply
    in order as a layer stack (each takes its share of every layer so far); where none applies, layer 0. World
    positions, so one list paints a block area and the terrain round it alike and noise carries across the seam. Not
    one shared asset: copying the list is the way for now (a shared rule set is a later option if games ask).
  - Terrain: baked in the backend's `editTerrain` (a process apart from any frame; the command path is synchronous,
    so a worker thread there is the follow-up if whole-terrain bakes grow past seconds — the landscape's 144 tiles
    take 7.3 s): `bake {rules}` sets and bakes every tile; edits that move the ground bake again over the changed
    samples grown by the rules' reach (slope 1 sample, cavity its radius), proven byte-equal to a whole bake. The
    renderer only reads the baked weights (top four layers a sample), hand paint (its own map with an amount) stays
    over them. A `setComponent` of rules alone stores them without baking (documented; the editor and MCP use
    `bake`). Slope from central differences on the samples; cavity the mean of the four samples `radius` away less
    the sample. The erase preview of the paint tool still previews toward layer 0 (the stored tile corrects it on
    commit); previewing toward the baked layers needs the baked map on the GPU (not uploaded today).
  - Block layers: evaluated per vertex when a chunk is meshed (page and workers, byte-tested; the chunk mesh is the
    "weight map"): slope and face from the vertex normal (walls and steep corner tops by their own slope), cell from
    the vertex's first triangle, cavity from the layer's tops `radius` around (tops only). The paint keeps its format:
    a top's layer-0 share and a wall point's layer-1 share (their unpainted defaults) are the rules'; painting another
    layer by hand covers the rules, erasing gives them back. Painting the base layer itself by hand therefore also
    shows the rules there (terrain has an amount map and no such limit): a per-chunk amount map is the follow-up if
    owners want to force the base layer by hand. Block layers carry four layers (rules naming 4+ are refused there).
    A rules change or moving the layer is a restyle (chunks re-meshed in the workers, the static shadow held once).
  - Per-layer settings for every layer: a vec4 per-layer parameter may carry `extraLayers` (values for layers 4, 5, …;
    at most 252, every layer a sample can name); a terrain surface reads each slot's own layer value from a uniform
    array (vec4-packed, 4 per element; no texture read: still 15 a pixel); absent or past the list, layer L keeps
    component L % 4 (the earlier look). Block layers draw layers 0–3, whose settings were already their own. The
    Material editor's layer table gains Add layer / Remove layer columns.
  - Measure hooks: `level --rules` (rules on the landscape's terrain and the area's layer, `extraLayers` on every
    setting), the `blocks` class's Scene-view "material rules change" window; `TL_PERF=1` bake rows in
    tests/perf/terrain.test.ts and block-layers.test.ts.
  - Notes for part B (biplanar, macro texture) and 30.13: rules read `SurfacePoint`; scatter rules can reuse
    `SurfaceRuleSet` and the bake rectangle (`terrainBakeRect`) to place copies only where the ground moved.
- 2026-10-07 (30.12 part B): projection per layer, no triplanar. Default chosen, owner to confirm:
  - A graph node `projectedSample` (catalogue + compiler) rather than template-only code, so any graph (trim sheets,
    block materials) can use it: mode 0 reads at its UV (unchanged look), 1 on the world plane the surface faces
    most (top or the dominant side wall plane: one read, a seam where a slope turns past 45° — the price of not
    blending), 2 biplanar = the top and the side plane blended by `sharpness` (4), the second read inside a branch
    taken only within `near` metres and where its share is over 1 %. Not IQ's max/median-axis biplanar: top + the
    dominant side covers ground (the y axis is never the smallest on terrain) with simpler code. Reads with explicit
    derivatives of the unwrapped world position (a per-pixel plane switch or the world-UV period wrap keeps its mip).
    Side-projected normal maps are turned into the mesh's tangent frame (map +x along the plane's u, +y world up).
  - The template's `layerProjection` is private: the compile reads its values (and the `extraLayers` drawn in each
    slot on terrain), so a layer that can only be "top" compiles to the plain read — the default template costs what
    it did (measured equal). Objects cannot override the projection (instances can). Templates made before keep
    their sampleTexture nodes and look; make a new one to get projections.
  - "Near tiles only" is per pixel (distance to the camera), not per CDLOD level: no second draw or compile per page.
  - Block layers' box mapping is unchanged (mode 0 reads its UVs); by slope / biplanar on blocks project from world
    position like terrain.
  - The macro texture is part C (not started here).
  - The fast gate's village perf check missed on WebGPU from 18:30 on (p50 6.7–7.2 ms against 6.16; the plain three.js
    page unchanged at 6.3–6.5 ms) with the host's load average at 3–6 from outside the project; the commit before
    30.12 (ed1b037b, built in a worktree) measured 6.9 ms in the same hour, part A alone 7.1 ms, so host drift, not
    this item (part A's gate at 17:53 measured 5.7 ms). WebGL 2 stayed within its limit. Parts B and C committed with
    the rest of their fast gate green and the perf check red on that drift: D192.
- 2026-10-07 (30.12 part C): the macro texture. Default chosen, owner to confirm:
  - Opt-in per terrain (`macroDistance`, additive optional, no schema bump; GameObject → Terrain does not set it).
    Baked on the page's GPU from the material the terrain draws with (whatever graph: no separate "macro material"
    to keep in sync), so it follows texture arrivals, material swaps and edits; never stored or exported (it is a
    cache of the look, made at load in a game too: ~0.9 ms of main thread a tile, within 2 ms a frame).
  - 128 texels at most a tile side, albedo + world normal (two RGBA8 arrays per page, no mipmaps, no ORM: rough
    0.9, not metal). A hard switch per node at the distance (both draws share the vertex stage, so no crack; the
    look can pop where the macro differs — fog hides it in a landscape). A dithered band is the follow-up if the
    owner sees the switch.
  - The bake mesh sets its own matrix (a scene update would otherwise reset its world matrix: the cause of the first
    black bakes), and a material counts as changed when its nodes change (graph materials compile again in place).
  - The descriptor registry guard moved from 284,000 to 286,000 bytes (rules and macro distance).
- 2026-10-08 (30.21): the generator. Default chosen, owner to confirm:
  - Additive component `architecture` {elements, profiles?, overrides?, chunkSize?, seed?, ao?, lodDistance?, castShadow?,
    receiveShadow?, baked?}; no schema bump, neither game needs a change. Placed like a spline (position only). Elements
    and profiles are JSON fields in the Inspector until 30.22's sliders.
  - Faces look right of a profile segment's direction; across is right of the path's travel. A profile segment taller
    than its row stacks strips (each spans the row once); smooth runs of one slot are one strip (vault arcs).
  - Far level = the same vertices with an index list leaving out detail elements, opening frames and coffer beams (no
    simplifier: strips are already quads and simplifying would break the row UVs; chamfers stay in both levels).
  - Vertex AO is analytic (inside corners of profiles and paths, wall foot, fill edges), not ray-traced: cheap and exact
    to repeat. COLOR_0 is RGBA bytes (normalized).
  - Vaults and roofs need a rectangular path; other footprints are reported, not guessed (straight skeleton: 30.25).
  - Ownership by chunk: sweep cells by their middle, fills by outline centre, copies/openings by their place; a chunk's
    key hashes only the elements whose bounds reach it. Default chunk 32 m (fewer draws on the iGPU) — dense chunks miss
    §5's 5 ms (7 ms); `chunkSize` 16 meets it at 4× the draws. Follow-up: split dense chunks' jobs or merge small chunks' draws.
  - Colliders are made by the simulation itself from the parameters (nothing crosses from the page): boxes per wall
    segment, meshes for floors (roofs/vaults when `collide`), stamped-piece boxes, kit `_COL`.
  - Exports generate at load by default; `architecture_ship_meshes` 1 ships a blob too. The IndexedDB store is raced with
    generation (a cold IndexedDB open took ~120 ms). `MAX_SETTINGS_KEYS` raised 32 → 64 (the registry reached 33 keys).
  - Notes for 30.22: sliders regenerate through `architectureChunkKeys` (only changed chunks; keys 3.7 ms for 320
    elements); `ArchitectureView.set` re-keys and keeps old meshes until new ones arrive; marks `tl:arch:chunk` /
    `tl:arch:ready` time it. Presets can expand into `profiles` + `elements`; `trimSheetOfMaterial`/`architectureSheets`
    resolve rows. Wall paint onto generated vertices (`trimColoursFromWallPaint`) is not yet applied (rooms on block
    layers, 30.23); tests use `tests/arch-test-style.ts`.
- 2026-10-08 (30.20): trim sheets and row layouts. Default chosen, owner to confirm:
  - A new shader type `trim` (closed set, like kit/water), not a graph template: the row table is data the
    generator reads on the CPU, and the footprint cap needs gradient sampling no graph node has. The table lives
    on the material (`trim`, required there, refused elsewhere; an instance draws with its root's table — a sheet
    laid out differently is its own material). Additive: no schema bump; existing materials keep their bytes.
  - Row layout = the slots a generator asks for; a sheet conforms when it has them all (`trimLayoutMissing`).
    Engine starter layout: floor, lower_wall, upper_wall, baseboard, crown, frame, column, bevel, emissive. Slot
    names use the id syntax so Texture Designer layer names import as they are.
  - Bleeding: padding repeats the row's edge (tile-v rows: continue the wrap); v is inset half a texel; the
    material shortens the screen derivatives so the GPU never picks a level past the sheet's safe mip level
    (exact per row for box-filtered mips, neighbours' padding excluded). Distant trims alias rather than bleed.
    Found while testing: with MSAA a far strip covering part of a pixel was shaded at the pixel centre outside it
    and read other rows whatever the mip — the uv is interpolated at the centroid (both backends). Equal rows
    align their bands to the padding's power of two (1024², 9 rows, 8 px: safe to level 4).
  - Vertex colour channels R occlusion, G grime, B wetness (A free); absent = clean, dry, open. Grime: mix to
    `grimeColor`, crevices (ORM occlusion) first, roughness toward 0.95; wetness as the layered template
    (×0.55 albedo, roughness → 0.1, `WET_ALBEDO_SCALE`/`WET_ROUGHNESS` now defined once in materials.ts and read by
    both), plus `wetFlatten`. Emissive rows go on a second material (30.23), so no emissive map (3 reads).
  - Wall paint onto generated vertices: `trimColoursFromWallPaint` reads a block layer's wall points at each vertex
    (`wallPaintAt`, now shared with the block mesher) — grime from paint layer 3 (index 2: unpainted walls are
    layer 2, tops layer 1), wetness from the paint's wetness. Tops/floors of generated meshes are left to 30.21
    (the tops' paint lattice, `chunkPaintColors`).
  - Import check: structural errors refuse the table; padding/mip/size warnings are listed; the pixel check is a
    button (backend route, decode on the encoder worker, KTX2 via its lossless original else transcoded with a
    tolerance of 24 instead of 8) rather than a check on every import (a texture does not know it is a sheet).
  - Notes for 30.21: get rows with `trimRowOf(sheet, slot)`, write UVs with `writeTrimStripUvs` (flat arrays; t 0 =
    the row's top edge), heights with square texels from `trimRowMetres`; colours with `writeTrimVertexColour` /
    `trimColoursFromWallPaint` (layer-local positions). A strip should span its row exactly once across (stack
    strips for taller walls; `tileV` rows may stack seamlessly). The material needs COLOR_0 for AO; meshes need no
    tangents (derived frame works). `tests/e2e/trim-strips.ts` writes a strips GLB with the same helpers.
- 2026-10-08 (30.19): height and distance fog. Default chosen, owner to confirm:
  - A `heightFog` part beside `fog`, not a third fog mode: a look may want both (a short classic haze and a valley
    fog), presets blend each on its own, and an existing look's bytes are untouched. Both draw in one fog node.
  - The sky gets the height fog through a dome at 95 % of the camera's far plane (real geometry, so standard, reversed
    and logarithmic depth all test it alike; fogging the sky materials themselves would have meant three sky paths).
    The horizon therefore takes the fog's colour where the ground ends: the far plane is where a level ends.
  - The sun for the glow: the key light's direction, else a physical sky's sun; no sun, no glow.
  - Not per quality level: the cost is a few exponentials a pixel (+0.45 ms of the landscape's scene pass); a level
    switch for it can follow if a game needs one. The frame's +0.4–0.6 ms on the main thread tracks the added GPU
    time of uncapped frames (not split further).
- 2026-10-08 (30.18): one surface query. Default chosen, owner to confirm:
  - Which ground answers: the highest at or below the point over every block layer and terrain (a point inside blocks
    climbs to their top; `top(x, z)` asks from above everything); a block layer wins a tie and terrain up to 1 cm over a
    block top (terrain heights are 16-bit steps, and 30.17's flatten keeps the ground 2 cm under the tops). Not
    `TerrainBlockSeam.covered`: the simulation has the block cells themselves, and this also answers bridges and block
    layers no terrain meets.
  - Weights reach the simulation with the tiles: the page now hands the worker each tile's layer weights and hand
    paint beside its heights and holes (answering from the page a frame behind was the other way: an asynchronous
    answer a script cannot use in the step it asks, and one that differs between runs). Cost: 8 B a sample for
    weights (a 257² tile 0.53 MB, 4× its heights), 9 more where hand-painted; Play's diagnostics show it
    (`terrainMemory.layerBytes`). Copying a 1,025² tile's layers is ~4 ms of the page, so heights and holes go at once
    (colliders as before) and the layers follow within 4 MiB a page turn (`TERRAIN_LAYER_HANDOVER_BYTES`); until they
    arrive a tile answers layer 0 (a frame or two). A simulation on the page shares the arrays (no copy).
  - What else is in the answer: block paint's wetness and the cell and block type (metadata stays `ctx.grid`'s: one
    call away); terrain has no wetness channel (0). The scene's wetness (`environment`) is not added: it is the
    look's, not the ground's.
  - Backend: `querySurface` reads the stored cells (kits as authored) and only the tiles under the points; without a
    `sceneId` every scene's block layers and terrains together, as a game loads them into one world.
- 2026-10-08 (30.17 part B): far-terrain lighting. Default chosen, owner to confirm:
  - The row's "far terrain gets sparser probes and baked per-tile horizon and AO terms" (and the 2026-10-03 note: far tiles
    need sparser probes and baked horizon terms, not 29.5's 2 m grid): built as the horizon terms only. Probes over open
    ground mostly see sky; what varies there is how much sky the ground sees and whether the sun clears its horizon, which
    the far ground's macro bakes now measure per texel (sky share in the albedo's alpha → AO on ambient/probe light; sun
    visibility in the normal's alpha → `receivedShadowNode`) at no draw cost. Sparse terrain probe grids are not built:
    the terrain is not part of a probe bake yet (no CPU form of its surface and look, D198), so far probes would see
    sky through it. Near the block area the probe bake's automatic tiles grow by the widest blend (+ a spacing; down by
    the blend), so the seam's two sides read the same probes.
  - The horizon is measured on the GPU at bake time (the heights are already there; a neighbour on another page or not
    loaded: the march holds the tile's edge), out to 256 m or a tile, 8 directions × 10 reads plus the sun's, as shader
    loops: unrolled, the bake's programs took 88–163 ms to build on first use (a new hitch), as loops 23–44 ms, about
    what the bake cost before (23–27 ms). A tile's neighbours bake again when it changes; a sun turned 2° re-bakes every
    far tile over frames (a day cycle re-bakes continually within the 2 ms budget). Only the far ground (past
    `macroDistance`) gets the terms: the near ground has the shadow maps and probes. Shadows off: no horizon shadow.
- 2026-10-08 (30.17 part A): blocks on terrain — heights, holes, material, scatter, collision. Default chosen, owner to confirm:
  - An edit layer, not automatic (additive, no schema bump; neither game needs a change: no game has terrain yet):
    `terrain.layers` kind `blocks` {blockLayers? (absent: every block layer), mode? cut|flatten (absent cut), blend? m
    (absent 8, 0-256), paint? (stored only when false)} in `TerrainLayerStack` (`terrain-blocks.ts`), so it re-bakes like
    splines and stamps (rect = whole, vitest) and the hand-made ground stays beside. A terrain without one is as before.
  - The ground a block layer gives the terrain is the top of each column's lowest run of blocks (layered ground meets at its
    top, a cliff at its top; a wall stacked of cells on the ground raises its column — walls on a border belong to edge
    pieces); on shared edges and corners the lowest top counts (the terrain never above a block's top edge, where a crack
    would open). Outside, smoothstep over the blend from the nearest border point's ground (level at the border).
  - `cut` holes the cells the footprint covers a cell in from its border: the first try (holes up to the border) let a few
    sky pixels through at the corners in Play (the hole is cut per pixel; at the border the side faces facing away leave
    nothing behind) — the kept ring lies 2 cm under the tops (`TERRAIN_BLOCKS_SINK`, at least a height step). 10 cm made a
    lit line along the border (the ground's normal at the border sample reads the sample inside); 2 cm keeps it within a
    degree. Where depth precision gives way far off, the ground under the tops wears their paint and normal.
  - Paint: the blocks' weights at the nearest border point (their chunk paint over their rules, `chunkMeshPaint`) mixed in
    by the same fade, as up to four ordered layer amounts after the splines' paint; terrain hand paint stays over it.
  - Texture coordinates: `terrain.uvOrigin` (additive): the terrain counts its UVs from the first met block layer's origin,
    written by the host's follow-up whenever it differs (a terrain without blocks layers keeps its own place: the old
    look). The far ground's macro bake no longer cuts holes (they darkened the filtered texels round every hole: a dark rim
    round the block area seen in Play).
  - Re-bakes on block edits: `blockSeamRebakeRects` compares the met block layers' chunks column by column (a chunk whose
    paint changed: whole), grown by 9 cells (a larger block's reach and its shared corner) and the blend; a block layer
    moved, re-gridded, given other rules or top subdivision: its chunks' box before and after. Block types changed in the
    content are not followed (the next edit there re-bakes). Kits are not read (the cells' own types are the ground).
  - Scatter: stored terrain scatter and ground cover keep off the footprint (`covered`); the export keeps the terrain's
    blocks layers (settings only) so the page's cover worker knows; the cover view hands the met block layers to its worker
    (rules or not) and remakes the terrain's squares round a block edit.
  - With `cut` and a streamed block layer, past its render ring the block area is not drawn and its holes show what is
    behind (documented; `flatten` is the stand-in for that case).
- 2026-10-08 (30.16b): streamed scatter without missed frames (D195). Default chosen, owner to confirm:
  - A removed scatter copy stays in its set shrunk to nothing until the group is made again for another reason
    (a re-bake, streamed in again), as a hidden one does: a removal costs one copy's upload instead of re-making a
    group of tens of thousands. The cost is the empty slot's vertex work (none drawn: its triangles are degenerate)
    and its 64 B per draw until then.
  - A group's set is split into chunks of at most `SCATTER_SET_CHUNK_COPIES` (4,096) copies: dense groups get a few
    more draws (world still +2, landscape +2), sparse ones stay one chunk. Smaller chunks (2,048) would make each
    frame's slice smaller and add draws; the 4 ms slice already holds a draw of 4,096 copies.
  - Streamed arrivals (block chunk meshes swapped in, scatter sets made) share 4 ms a frame (`STREAM_ARRIVAL_MS`)
    instead of 4 ms each; each still makes one piece a frame, so a busy flight streams a little later rather than
    missing a refresh. Terrain tile uploads keep their own 2 ms.
- 2026-10-08 (30.16): world streaming. Default chosen, owner to confirm:
  - Rings per terrain and block layer (`streaming`), not one project setting: tile and chunk sizes differ per
    object; absent keeps everything loaded (existing projects unchanged). The Inspector starts a new `streaming`
    at 1,500 m (terrain) / 256 m (block layer). Collision and live rings follow the camera's place, its target and
    every player character (not every body: an NPC far from the camera on streamed ground may find no collider —
    a script API naming more sources is a follow-up).
  - The budget `streaming_budget_mb`, default 768 MiB: the world class's rings hold 40–64 MiB, so ten times that
    beside the 512 MiB texture budget on a 16 GiB integrated-GPU laptop. It lets go of what the hysteresis keeps,
    farthest first; it never cuts a ring (that would leave holes in the world): an overflow is reported once.
  - The terrain's overview is made by builds (the export and Play: one blob per streamed terrain, ~2–3 KB a tile
    gzip) from the stored tiles, never stored by the editor, so it always matches. The render ring is raised to
    where the coarsest level starts so a full tile and the overview meet on the same vertices; the shading there
    differs a little (normals and layer weights from 17² samples) — owner to judge by eye.
  - The editor keeps every tile and chunk loaded: brushes, previews, picking and rule bakes read every tile, and
    the Scene view is where the whole level is seen. A terrain too large for that is a follow-up.
  - Block cells do not stream: the simulation keeps every cell (`ctx.grid` reads, walks and saves answer the same
    everywhere only over the whole layer; 4 B a cell), so the export keeps one cell blob per layer (140 KB gzip for
    a 1,024² layer); what streams is drawing (chunk meshes, in the workers), colliders and live objects. A live
    object leaving its ring goes (its lasting state is in its cell's metadata, as 30.3 says).
  - Scatter streams by its 2,048 m groups (a group's blobs read, its sets made); the simulation keeps every scatter
    blob, so `ctx.scatter.near` answers the same anywhere; only the copies' colliders follow the collision ring.
  - Determinism: which tiles and chunks collide, and when, comes from the committed state at step boundaries; a
    tile's data still arrive from the page asynchronously (as before streaming): the page reads the render ring
    round the camera, which covers the collision ring near it. Per step: one 257² tile or two chunks of collider
    work, 16 live spawns; an object's first look takes its whole rings (a game starts on solid ground: the page
    reads the tiles in the collision ring of the start's cameras and characters before step 0).
  - Terrain tile changes are reported to the cached static shadow by place (it is drawn again only if its map
    reaches them; any change drew it again before).
  - Measured misses: one per renderer in the world class's plain flight (a dense scatter group made in one frame,
    D195); not fixed here. `scatter-view.test.ts` has a flaky deep comparison (D196, not this item's).
- 2026-10-08 (30.15): edit layers, stamps and erosion. Default chosen, owner to confirm:
  - Additive, no schema bump (neither game needs a change): `terrain.layers` (absent: one base layer with the splines on
    top, the bytes as stored) lists `stamps`, `erosion` and at most one `splines` layer in the order they apply over the
    hand-made ground (`tiles[].base`, 30.14's); `enabled` (stored only when false) and `strength` 0–1 per layer.
    `terrain-layers.ts` (`TerrainLayerStack`) is the combine `terrain-splines.ts` was the first input of; the splines are
    one layer of it. Disabled layers still keep their tiles' hand-made forms (switching one on again loses nothing).
  - Masks: the row names none; a layer's reach is its own (a stamp's square, an erode's rectangle, a spline's band) and
    `strength` weighs all of it. Painted per-layer masks are a follow-up if the owner wants them.
  - Stamps read a texture asset's first channel (a 16- or 8-bit PNG; a KTX2's original PNG), a square `size` m a side
    turned `rotation`° about +y, `add` / `max` / `min`, edge fade (default 0.15 of the side). Placed by
    `setComponent terrain {layers}` (the editor's Stamp tool, MCP alike): the spline follow-up (`spline-follows.ts`) now
    also follows a terrain's layer changes and combines again only the boxes a change reaches
    (`terrainLayerChangeRects`: the stamps from the first one that differs, an erosion layer's changed tiles, all a
    switched, weighed or moved layer reaches) — rect re-bake = whole re-bake (vitest). A texture changed after a stamp
    was placed reaches the ground at the next combine there (not followed: an asset reimport does not re-bake terrain).
  - Erosion is a stored result, not re-run on every combine: `editTerrain erode {rect, hydraulic?, thermal?, seed?,
    layerId?}` erodes the ground below its layer (rect + 16-sample margin), keeps the difference inside the rect per
    tile (16-bit steps, gzip blob "TLTE", never shipped), faded in over an 8-sample border; running it again replaces
    the rect (it reads the ground below, not itself: the same input gives the same result inside the border). Sculpting
    below keeps the channels on the new ground. Hydraulic = the particle method (Beyer 2015) in sample units, thermal =
    8-neighbour talus slides (Jacobi passes); seeded mulberry32, so the backend's worker and in-process runs agree to the
    bit (vitest). A per-request bound of 2,049² samples a run (not a terrain size).
  - Off the backend's event loop: the backend's command route erodes the command's grid on a worker thread
    (`erosion-worker.mjs`, beside the bundle) before the command runs; the command takes it when its input still has
    the same digest, else erodes in process (tests from source). Not a GPU compute pass: the backend owns the edit (MCP
    has no page), and the result must be bit-equal wherever it runs.
  - The export and Play drop `layers` with `tiles[].base` (the combined `data` ships alone; erosion blobs never reach
    a build — integration test).
- 2026-10-08 (30.14b): re-bakes without hitches (D193). Default chosen, owner to confirm:
  - An object realized again (every edit realizes the edited objects again) keeps what it draws until the next frame:
    a terrain's scatter and ground cover go only when the terrain goes, a spline's mesh when it is not set again before
    the frame's update, and a terrain set again with the same materials keeps them (the library's redefinitions still
    reach it). The cost was dropping and remaking everything, not the arithmetic.
  - three r186 forgets a node build, pipeline and program the moment its last user goes; the adapter keeps them
    `RELEASED_BUILD_KEEP_MS` (10 s) longer (private API of the pinned version, guarded, like `installProgramRelease`), so
    a set, square or mesh made again in place reuses them; one not used again goes as three would have released it.
    Holding them longer costs only memory for programs that were in use seconds before.
  - Ground cover made again keeps its old copies drawn until the new ones are built (no blink), and a spline change
    remakes only the squares under the old and new scatter bands of the splines that changed.
  - Node builds and pipelines are marked (`tl:node-build`, `tl:pipeline`) in every page, as the scatter's sets are, so
    the perf harness shows what still builds; `--sculpt-edit`, `--edits-only` and `--edit-profile` join `--spline-edit`.
  - Not done (follow-up if the owner sees it): the static shadow map is drawn again whole after a re-bake, and a re-made
    set's instance buffer is uploaded in one frame; together likely the 2–4 remaining frames of 17–27 ms in 6 edits.
- 2026-10-08 (30.14): splines. Default chosen, owner to confirm:
  - One `spline` component (additive, no schema bump; neither game needs a change): points `{at, tangent?, width?, roll?}`
    as offsets from the object's position (no rotation or scale, as a terrain), Hermite segments with Catmull-Rom
    tangents where a point has none, width and roll linear between points; `terrain`, `scatter`, `mesh`, `pieces` and the
    host-written `data` optional. The curve (`spline-curve.ts`) is plain arithmetic and evaluated from a distance table
    (0.5 m), so `ctx.splines`, the handles, the terrain and the meshes read the same curve; camera rails and movers can
    move onto it later (`cameraPath` and mover waypoints are left as they are).
  - Terrain shaping is the first input of the edit-layer stack 30.15 builds: a tile a spline reaches keeps its
    hand-made form beside the drawn one (`tiles[].base`, never shipped); every hand edit goes to it and the splines are
    applied again over it (`terrain-splines.ts`: per sample, from the hand-made height only, so a box re-baked equals
    everything re-baked — tested). 30.15 adds stamps and erosion as further inputs of the same combine.
  - A spline change and the terrains it shapes (and its mesh) are one command and one undo step: the host plans the
    follow-ups after the command (`spline-follows.ts`, it reads and writes blobs) and the history entry keeps each
    component's value before and after (`follows`, as props' footprints keep their chunks); undo and redo replay them,
    never re-plan. Re-baked: boxes about 64 m long along the curve before and after, and only the segments a moved point
    changed (each segment's pieces depend on its own points, so the rest re-bakes to the same bytes).
  - Spline paint goes over the rules and under hand paint; a terrain without rules starts from its hand-made weights.
    Scatter bands clear stored terrain scatter and terrain ground cover; block layers are never changed by splines (their
    cells stop the carve; their own scatter is theirs).
  - Meshes are made by the backend and stored (`data`: one uncompressed blob of 64 m pieces with simplifier levels,
    the pieces' end rows locked so they meet at every level; water's foam weighs in the simplification so its points
    across survive), not generated at load: the simplifier is the backend's (WebAssembly, loaded before the backend
    serves) and the sim needs the same triangles for colliders. Levels switch where their error is under a pixel at
    the reference view. Pieces along a spline are instance sets with their model's `_COL` colliders.
  - Water carries flow in UV1 and bank foam in COLOR_0; the River template does two-phase flow with noise ripples (no
    texture needed) and reads the new Scene depth node (three's viewport depth copy: checked in a plain three page on
    both renderers with and without MSAA). A logarithmic depth buffer is not handled by the node.
  - The descriptor registry guard moved from 286,000 to 296,000 bytes (the spline's descriptor, about 8.7 KB).
- 2026-10-08 (30.13b): scatter sets off the main thread, per-copy colliders and addresses, impostors. Default chosen, owner to confirm:
  - Sets are prepared on a worker of the view worker script and made on the page within the frame's budget; groups stay 2,048 m (smaller
    groups would add draws, the cost was the arithmetic). The old set is drawn until its replacement is made.
  - A copy's address is `<object>#scatter:<rule>:<ix>,<iz>` (rule and candidate cell, as stored) and is also its collider's id, so a ray hit
    names it. `hide` is reversible (not drawn, no collider), `remove` lasts the run; a new run brings every copy back. Not in the engine's save:
    a game keeps `changed()` in its own save and puts it back (game flow is game-owned). Scripts cannot add copies (stored copies are the
    editor's; a game spawns objects for that).
  - Collision ring: every tile and chunk for now, behind the same callback terrain collision uses (30.16 narrows both).
  - Far trees as octahedral impostors, baked on the page once per model when a rule first asks (`impostorSize`, a screen size like the density
    falloff's; absent: none), not at import: the look follows the project's materials (graph and foliage materials included), which the
    import has no renderer for; the bake is synchronous before a frame's draw (a one-time 9–25 ms). The impostor's normal is its meshes'
    surface normal (normal maps are below a far copy's pixels). Per-tile HLOD not built: it measured (estimated by triangles) dearer.
  - The flight measurement counts missed refreshes at the display's rate (vsync): uncapped, a GPU-bound page runs ahead and then waits, so
    its intervals alternate between short and long whatever it costs.
- 2026-10-07 (30.13): rule scatter on both, ground cover, the foliage policy. Default chosen, owner to confirm:
  - One rule format for terrain and block layers (`scatter`, additive optional fields; no schema bump; neither game needs
    a change). Stored copies live beside the data they stand on: a terrain tile's in a blob of its own named by
    `tiles[].scatter` (a scatter stroke re-uploads no tile texels; undo = old digests), a block chunk's in the chunk
    (`scatter`, base64; chunk binary layout 4 written only when a chunk has scatter, so older files keep their bytes).
    Not separate instance-set objects: hundreds of objects would spend the id space E37 is about.
  - Hand edits are the rule's candidate cells added or erased (as hand paint over rules), so they survive every bake
    and follow the ground; copies placed one by one stay instance sets of their own. A copy's address is its rule and
    candidate cell. A block layer's rules change in two undo steps (`setComponent`, then `editBlocks bakeScatter`):
    `editBlocks` changes chunks, not the component (commands/types.ts is at its size limit).
  - Ground cover on a worker for both renderers, not a WebGPU compute pass: the rules are one JS definition (a TSL copy
    would be a second code path to keep equal), squares are made only when they come into reach (4 ms a 32 m square),
    and §5 holds. A compute path is the follow-up if a denser cover misses.
  - Draws: one set per rule per 2,048 m group with 2,048 m chunks and per-copy LOD (per-copy culling inside the draw
    keeps GPU work to what is seen); 256 m chunks drew 470 extra draws, 2,048 m 22.
  - Foliage policy as engine defaults: no shadow unless `castShadow`; `shadowDistance` casts from shadow-only squares
    (the cut-away layer the shadow cameras see) into the moving map; `blobShadow`; foliage `windDistance` (absent/0:
    everywhere, the earlier look; the wind reads the view's eye in every pass so shadows match); `FOLIAGE_NEAR_METRES`
    (40) is what the editor writes.
  - Not done here (follow-up 30.13b): per-copy colliders from the model's `_COL` and a script API naming copies by
    address (E37 part 3); far trees as octahedral impostors / per-tile HLOD (the far copies thin by density and LOD
    instead); smaller groups or an off-thread build for dense forests (a 2,048 m group of 16k copies builds in up to
    30 ms); exclusion by spline (30.14).
- 2026-10-07: D192 rechecked against the plain three.js page. The class/plain WebGPU p50 ratio went from 0.86–0.92 (29.7 to
  part A's 17:53 gate) to 1.03–1.14 (from 19:03), but ed1b037b and HEAD b6664e94 built side by side and interleaved measure
  the same (class 6.4–7.5 against 6.3–7.2 ms, plain 6.3–6.5) with byte-for-byte the same frame work (draws, tris, pipeline
  sets, buffer writes). The ratio itself swung 0.92 → 1.24 within an hour on 10-06 with no code change, so it is not a
  drift control here; nothing in 30.12 runs per frame or compiles into the village's materials. Host drift, baseline kept.
- 2026-10-07: D191 closed as host drift. WebGL 2 village p50, idle host, 3 runs each: HEAD 37719af2 4.9/4.8/4.8, fc210485
  4.8/5.0/4.9, 6f38f3fb (phase 29 end) 4.9/4.7/4.7 ms; interleaved HEAD 4.7/4.6/4.6 against 6f38f3fb 4.5/4.6/4.6. Phase 30 adds
  nothing measurable to the village (WebGPU 5.5–5.8 ms, means ~6.0 ms as at the baseline). Baseline kept at 4.4 ms.
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
