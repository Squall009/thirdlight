# Phase 46e — Lighting, regions and the walk graph

Status: **46e: planned 2026-11-14, not started** on branch `phase-45` (worktree `~/projects/thirdlight-p45`, base
32faf2c0; main frozen at d4053cab). Planned from `docs/roadmap.md` (order of 2026-11-12), plan 45's 46e scope and
§5c, requirements R40, R45, R97–R104 and R110 (`docs/architecture/voxel-format-requirements.md`),
`docs/architecture/voxel-engine.md` §6 (foundations 2 and 7) and the 46f close (`docs/plan-phase-46f.md` §10: the
owner let the five defaults stand, 2026-11-14). It runs in two parts with an owner stop between them: **46e-a**
ends at the lighting storage choice; **46e-b** builds the choice out.

## 1. Scope

- **In, 46e-a:** GPU time per pass in the profiler (D655); one occupancy walk over voxels (CPU and GPU, one
  definition); open-region labelling with chunk connectivity and sky visibility; direct light and shadows on voxel
  worlds in Play; both lighting stores on voxels (phase 42's surface cache ported, the voxel light volume
  prototyped) and their A/B on one scene (R110), alone and as near cache + far volume; an acceptance page and a
  stop.
- **In, 46e-b (detailed after the owner's choice):** the chosen storage built out per tier, with edits, props and
  moving objects; rooms for light, cut-away and audio size; connectivity culling only if it measures better than
  the depth pyramid; the walk graph on a generic A* core with `ctx.voxels` path queries.
- **Out, with the phase that takes it:** structures on their own grids and their stitched walk graphs (47a, R40);
  door and window portal state as props (47a, R45's leaf and glass); far-cache channels, far water and fog (49);
  lit fog (51); retiring phase 42's cache, tracer scene kinds, room culling and `ctx.grid` (48, with the old
  systems they read); the world edit mode (47b); relief, detail-piece LODs, the mesh far field; anything inside
  block layers, heightfield terrain or generated architecture; WebGL 2 beyond its smoke test.
- **Carried defects in scope:** D655 (46e.1), D607 (far shade lit at the camera, 46e.4), D448 (prop coverage
  stamping, 46e-b), D654 (travel readings, a bounded trace in 46e.0). **Carried, not in scope unless touched:**
  D652, D656–D658, D646, D282, D601, D604, D594, D620, D621, D634, D644.

## 2. Owner requirements (quoted; REQUIREMENTS, never silently dropped)

- R110: "Lighting storage decided by the 46e A/B (phase-42 surface cache vs voxel light volume) with performance
  first; the owner leans to removing lightmaps, surfel caches and their texture reads even at a quality cost."
- R104 (proposal the A/B judges): "Voxel light volume (air-side, 6 directional values, coarse 1/2/4 m levels, saved
  settled bake per tile for low tier/WebGL 2) vs phase-42 cache."
- R97: "Chunk connectivity: per chunk, which of its six faces join through air." R98: "Sky visibility = highest
  solid voxel per column." R99: "Rays step 6-connected (no diagonal slip)."
- R101: "Rooms and portals come from roles (floor/wall/roof enclose, door/window are portals)."
- R100: "Walk graph samples the same surfaces, hierarchical per chunk; an edit rebuilds one chunk's piece."
- 2026-11-12: "Voxels are the single source of truth"; "name the foundation first".
- 2026-11-10: WebGPU first; the low tier at 720p upscaled, capped at 30 Hz on the Iris Xe; measure at the cap.
- 2026-11-11: budgets come from the hardware target; hobby pace; gates by affected area.
- 2026-11-12: no steering mid-phase; a new idea waits in the decisions register for the phase boundary.

## 3. What exists (survey of 2026-11-14)

- A voxel surface is a standard lit material: sun, ambient, the sky's environment and the clustered local lights
  reach it. It casts and receives **no shadow in Play**, has no occlusion from the voxels, and reads no bounce
  light. Far bricks carry baked occlusion in their colour and are lit at the camera's position (D607).
- Phase 42–43's stack (surface cache, tracer, live and baked probes, rooms) reads block layers, heightfield
  terrain, generated architecture and model bricks. **None of it has a voxel input**; most of its scene kinds
  retire in 48. Clustered lights, the shadow atlas and the cached sun map are generic.
- Derived per chunk today, in workers, never stored: occupancy (flag, 4³ brick bits, cell bits), light coverage
  (bits plus a partial list), nav (blocking bits, standable cells with clearance). **Nothing reads light or nav at
  run time** except `ctx.voxels.coverageAt`. The GPU holds "material is not air" per cell for resident chunks
  (`VoxelShaderGrids`), and distance bricks for the far field.
- **No ray walk over level-0 voxel chunks, no flood fill over voxel cells, no path query on voxels.** The only A*
  is `block-walk.ts` over block layers (retiring).
- Worlds with interiors: the town (houses with rooms, stairs, openings), alone and at the centre of the 8 km
  world; the caves and vertical worlds.

## 4. Budgets and how each item is judged

From `FRAME_BUDGET_BY_TIER` and `MEMORY_BUDGET_BY_TIER` (46f): at the low tier's 30 Hz frame the GPU's `lighting`
share is 20 % (6.7 ms) and the page's 6 % (2.0 ms); end-of-46f room on the 8 km town orbit is 21.8–22.0 ms.
Every lighting item reports, on the low tier at the cap and alone: GPU ms per pass (46e.1's reading), page and
simulation ms a frame from the profiler, memory against its table entry, the time for an edit to show in the
light, and pictures at five fixed cameras (street at noon, a room with a window, a cave, night with lamps, the far
view). Medium and high: pass shares only, "unverified on target hardware". A miss is recorded with its cause and
does not block; a tier that cannot afford a feature gets it switched off or cheaper, by a tier setting.

## 5. Where things live (reuse first; never copy)

| Thing | Home | Reuse |
|---|---|---|
| GPU time per pass | `three-adapter` (`gpu-headroom.ts`), `game-host` (`voxel-meter.ts`, `page-profile.ts`), editor Profiler tab | the headroom meter's hide-a-pass method (`tools/voxel-bench/headroom.ts`), moved where the page can call it |
| Occupancy walk | `@thirdlight/voxel` (CPU), `three-adapter` (the same steps in WGSL over the shader grids and distance bricks) | `ScalarOps` (shared), `ChunkTreeFlags`, `far-bricks-node.ts` march, the derived occupancy and light coverage |
| Region labelling, connectivity, sky columns | `@thirdlight/voxel` derive workers; stitched in the streamer | the derive contract, `WorkerPool`, `job-queue` |
| Region and ray queries for games | `runtime` (`ctx.voxels`) | `voxel-world-host.ts` |
| Voxel shadows | `three-adapter` (`voxel-chunk-view.ts`) | `cached-shadow.ts`, `shadow-atlas.ts`, `?voxelShadows=static`'s path |
| Surface cache on voxels | `three-adapter` (a voxel tile source and a voxel tracer scene kind) | `surface-cache.ts`, `surface-cache-scene.ts`, `surface-light-pass.ts`, `surface-probes.ts`, `tracer-scene.ts`; `surface-cache-blocks.ts` and `-terrain.ts` are the charting patterns (retiring code, read not touched) |
| Light volume prototype | `three-adapter` | `camera-window.ts` and the region-texture helper (46f), the walk, clustered lights |
| A* core, walk graph | `@thirdlight/shared` (the core), `@thirdlight/voxel` (the graph) | the derived nav cells; `block-walk.ts` is the pattern and is left to retire |
| Time slices and budgets | `shared` `frame-arbiter.ts`, `project-model` tables | no new constant |

## 6. Items

### 46e-a

| Item | Builds |
|---|---|
| 46e.0 | The three.js check; the baseline (§4's numbers and five pictures as they are today, on the town inside the 8 km world); a bounded trace of D654 with the profiler's spike capture. |
| 46e.1 | **GPU time per pass in the profiler (D655).** The meter's hide-a-pass measurement callable from the page: an on-demand "Measure GPU" in the Profiler tab, the overlay and `tl_diagnostics`, filling the GPU budget rows per category (near, far, shadows, lighting, post, effects); the bench reads the same routine. |
| 46e.2 | **One occupancy walk.** A 6-connected walk (R99) over level-0 cells, skipping empty space by the chunk tree's flags and continuing into far bricks; one definition for the CPU and the GPU; partial cells by light coverage; `ctx.voxels.raycast`; the editor's voxel picking through it. Measured: rays a millisecond on both. |
| 46e.3 | **Open regions.** Connected non-solid cells labelled per chunk in the derive workers and stitched across chunk faces as chunks arrive: face connectivity (R97), sky columns (R98), regions with an enclosed flag, volume and portals from the opening role (R101); rebuilt for one chunk on an edit; `ctx.voxels.regionAt`; a tint overlay to see them. A derived output: an add-only note in the format spec (§8, owner). |
| 46e.4 | **Direct light.** Voxel surfaces and kit pieces cast and receive sun shadows in Play through the cached static map plus the dynamic map, and local-light shadows through the atlas; an edit refreshes what it touched; the far shade lit at the hit (D607); a far sun shadow by a short march through distance bricks, kept only on the tiers that afford it. |
| 46e.5 | **The surface cache on voxels.** Phase 42's cache fed by voxel surfaces: a voxel tile source (charts over the mesher's faces by their main axis, as block chunk columns and terrain rings are charted today), the tracer walking voxel occupancy as a scene kind (46e.2's walk), direct light and live probes over it, edits marking tiles stale. A candidate, built only as far as a fair measurement needs. |
| 46e.6 | **The voxel light volume.** R104's volume on the same town: air-side cells beside surfaces with six directional values, the 1/2/4 m levels for open air, sky and sun by the walk, one bounce, local lights; read by voxel surfaces, kit pieces and moving objects. A candidate, to the same depth. |
| 46e.7 | **The lighting storage A/B (R110), same scene, same cameras.** Three arrangements on the town inside the 8 km world: the cache alone, the volume alone, and the cache near with the volume beyond a distance (the owner's hybrid, the hand-over distance a setting); §4's table and pictures for each, on the low tier at the cap, with medium and high as shares. |
| 46e.8 | Close of 46e-a: the gate, the independent review, fixes, results, an acceptance page (pictures of the three side by side, at most five questions, the lead's recommendation by "performance first"), STATUS. **Stop for the owner.** |

### 46e-b (outline; made final after the owner's choice)

| Item | Builds |
|---|---|
| 46e.9 | The chosen storage built out: tiers and budgets, updates after edits, props through the coverage channel (D448), moving objects and particles reading the same light, the old path it replaces switched off for voxel worlds. |
| 46e.10 | Rooms from regions: light kept indoors, cut-away and see-through "enclosed air", a room size for audio. |
| 46e.11 | Connectivity culling measured against the depth pyramid on the town's interiors and the caves; built only if it wins. |
| 46e.12 | The walk graph (R100) on a generic A* core; `ctx.voxels` path and reach queries; the path-finding span in the profiler. |
| 46e.13 | Close: gate, review, acceptance page, STATUS, the design page. A saved light bake for the low tier is a format proposal (O19) and a hard stop if the measurements ask for it. |

## 7. Progress

| Item | Status |
|---|---|
| 46e.0 | not started |
| 46e.1 | not started |
| 46e.2 | not started |
| 46e.3 | not started |
| 46e.4 | not started |
| 46e.5 | not started |
| 46e.6 | not started |
| 46e.7 | not started |
| 46e.8 | not started |

## 8. Format and spec steps (owner stops)

- **Region labels, face connectivity and sky columns** are new derived outputs (worker-built, never stored).
  **Approved by the owner 2026-11-14** for this phase: "Yes I approve of the spec change for the proposed testing
  of lighting voxels in this phase." 46e.3 writes the add-only entry in `voxel-format-spec.md` §3.7 (and the
  format register) with that note, in the commit that lands the outputs. The approval covers these three derived
  outputs only; anything else in an approved spec is still a stop.
- **Light coverage on the GPU** (if the shader grids' "material is not air" is not enough for the walk): a GPU-side
  texture built from the derived coverage; no stored format.
- **A saved light bake** (R104's "saved settled bake per tile", O19) is stored data: not built in 46e-a; a
  proposal and a hard stop in 46e-b if wanted.
- No change to the voxel value, the region files, the far cache, the render, role or kit specs is planned.

## 9. Decision log

- 2026-11-14 (OWNER): the A/B runs **both stores on voxels, on the same scene**: "we had at one point wondered if
  we would run both on voxels with surfels up close and voxels cache further away depending on the look and
  performance. I think we need to port this to voxels in order to do a fair comparison." The plan's first
  default (the cache measured on the old scenes) is withdrawn; 46e.5 ports the cache, 46e.6 builds the volume,
  46e.7 measures each alone and the hybrid. The loser's code is removed or left behind a switch by the owner's
  choice at the stop, not before.
- 2026-11-14 (plan, default chosen, owner to confirm): 46e stops after the A/B (46e.8); the owner agreed to the stop (2026-11-14); the walk graph and
  culling wait in 46e-b though they do not depend on the choice, so the stop comes early.
- 2026-11-14 (plan): the generic A* core is new in `shared`; `block-walk.ts` keeps its own until it retires in 48
  (retiring code is not touched).
- 2026-11-14 (plan): 46f's defaults stand (owner): the arbiter stays a table, D652 waits for the performance
  phase, job kinds wait for 48, voxel redo stays as built (the spec sentence waits for the owner's note).

## 10. Open questions for the owner (asked with the plan)

1. The two parts with a stop at the lighting choice. **Owner 2026-11-14: yes.**
2. The A/B on different scenes. **Owner 2026-11-14: no; both on voxels, same scene, and the hybrid (§9).**
3. The add-only spec entry for the derived region outputs (§8). **Owner 2026-11-14: approved** ("Yes I approve of
   the spec change for the proposed testing of lighting voxels in this phase").
