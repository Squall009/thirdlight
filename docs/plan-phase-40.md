# Phase 40 — Ground cover at scale, and wind

Status: planned 2026-10-21.

Goal: dense ground cover (grass, and any other small mesh) is a standard tool
of the engine. It scales to large scenes and works on any surface, indoors and
out, not just as an outdoor special case. Wind is one engine system, set per
scene with local zones. The phase proves both with one target scene. Read
`docs/roadmap.md` (principles 1, 1b and 7) first.

## 1. Owner decisions (2026-10-21)

- **The target.**
  - A 1 × 1 km terrain with blended, textured layers, covered with
    geometry-grass fields that look like dense, tall, wind-moved blade grass
    over rolling hills. The owner's reference was a screenshot of a field in
    Zelda: Tears of the Kingdom.
  - It must **hold 60 fps at 1080p** on this host's Iris Xe, on both
    renderers: frame p95 ≤ 16.7 ms and no missed frames, **measured at the
    display's 60 Hz cap, never uncapped**. Uncapped runs throttle and give
    inconsistent frame rates.
- **Generic through and through.** The engine adds no art-style features:
  - no colour sheen;
  - no grass-like terrain shading;
  - no stylised tip gradients built into the engine.
  
  What makes it look good comes from content: the grass model, its material
  and the existing foliage shader with physically sensible values. For
  example, an accurate roughness on a blade already catches more light as it
  bends. Nothing hard-codes a look a future game would have to undo.
- **Ground cover is standard and scales.** It is not only for outdoor games.
  The current cover system works per copy on the CPU (the landscape class
  already spends about 11 ms of main thread, D212) and ends at
  `coverDistance`. It is replaced by a GPU-driven path.
- **Grass receives shadows but casts none.** Contact darkening at the roots
  comes from the existing SSAO pass, not from shadow casting.
- **Wind is one system.**
  - A global wind per scene, plus wind zones placed in the scene that
    override it locally and blend at their edges.
  - Wind is a world-space, top-down scrolling noise texture that the foliage
    shader samples to bend vertices. Changing the wind means changing its
    texture, scroll speed and direction, UV scale and strength.
- **The subject list bends foliage away.** This is the same per-view subject
  list as phase 39's see-through (players, units).
- **Stretch:**
  - ground-cover roots can take the colour of the surface under them, so the
    blades blend into the terrain;
  - it is an opt-in material setting, off by default, and kept only if it
    stays inside the budget.
- **One placement pipeline** (owner, 2026-10-21, after the maintainability
  review). Today ground placement is three systems: stored scatter (baked
  copies), cover (run-time CPU copies) and the instance brush (hand-placed
  sets). They become one pipeline:
  - rules and brush strokes produce placements;
  - placements go to one GPU instance renderer.
  
  The GPU cover path is that renderer, not a fourth system.
- **The grass model and its LODs** are made in Blender (the art-factory
  pipeline). It is a game-ready asset: triangle budget met, LODs, no hidden
  geometry, compressed textures if any. Its triangles, LODs, texture sizes and
  file size are reported.

## 2. Design

### Ground cover

**One GPU-driven path for every cover rule.**

- The existing scatter rule data (`cover: true`, density, layer weights,
  scale and tilt ranges, models) stays the authoring model. Only the runtime
  path changes.
- **Placement on the GPU.**
  - The surface is split into patches (cells) in rings around each view.
  - Each patch draws its cover instances in one instanced draw per mesh LOD.
  - An instance's position, rotation, scale and density test are computed in
    the vertex shader from its instance index, a per-patch seed and the
    surface data.
  - No per-instance data lives on the CPU, and nothing per frame grows with
    the number of instances.
  - This is the same on WebGL 2 (no compute) and on WebGPU.
- **Surfaces.**
  - **Terrain:** read the heightfield and layer-weight textures the terrain
    already has on the GPU. This is fully procedural, with nothing stored, so
    it scales to any terrain size.
  - **Other surfaces** (block-layer tops, meshes, architecture floors —
    interiors included): the backend bakes a compact per-chunk point set (a
    quantised position, a normal and a weight) at the rule's maximum density.
    The GPU thins it by distance. The bake runs when the surface changes,
    never per frame.
- **Distance.**
  - Density thins continuously with distance (a per-instance random
    threshold, so there is no popping).
  - Mesh LODs switch by distance per patch ring.
  - Cover ends at the rule's distance, with no hard cap of its own (the
    current 1000 m `coverDistance` cap is revisited).
- **Culling.** Patches are frustum-culled on the CPU; there are a few hundred,
  not millions. Occlusion culling (phase 33) applies to patches where it is
  on.
- **Shadows.** A cover rule's `castShadows` defaults to false. Cover always
  receives shadows. Contact darkening comes from SSAO.

### One placement pipeline

- **Sources** produce placements:
  - **procedural rules:** the GPU evaluates them per patch (cover on
    terrain);
  - **baked rules:** points stored per tile or chunk (today's stored scatter:
    trees and rocks, with colliders and `ctx.scatter` addresses);
  - **hand-placed sets:** the instance brush.
- **One renderer** draws every source: GPU patches and instance buffers, one
  LOD and density-thinning scheme, one culling path, impostors for the far
  range.
- **Per-copy CPU work** stays only where a copy needs an identity:
  colliders and script addresses (`ctx.scatter`) for nearby copies. It is
  never needed for drawing.
- **What disappears:**
  - `cover-view.ts` / `cover-worker.ts`, merged into the renderer;
  - the separate scatter and brush draw paths (`scatter-view.ts`, the
    brush's instance sets);
  - the per-copy LOD pick on the main thread (D183, D212).
- **Rules and brush data keep their formats.** An upgrade on load is needed
  only if a field moves.

### Wind

- **One wind field.** The scene's environment has a global wind:
  - a noise texture asset;
  - direction and scroll speed;
  - UV scale (metres per tile);
  - strength;
  - a second octave (scale and speed ratio) so the pattern doesn't visibly
    repeat.
- **Wind zones.** A `windZone` component on an object:
  - a box or sphere shape;
  - overrides any of the global values;
  - a blend distance at its edge;
  - a priority.
- **How the zones reach the shaders.** They are combined into a small
  camera-centred wind map, a low-resolution texture covering the view's
  surroundings. It is updated only when zones or the camera's area change.
  Shaders sample it together with the noise. There is no per-zone uniform
  array, so there is no cap on zones.
- **Who reads the wind.** The foliage shader samples the wind for every
  foliage mesh: cover, scatter trees, placed models. Its bend scales with the
  vertex's bend weight (COLOR_0 R, as today) and the instance's height, so
  tall grass bends further than short grass. The current fixed sway of about
  0.1 m becomes a fallback for meshes with no weights.
- **Scripts:**
  - `ctx.environment.setWind({…}, {blend})` changes the global wind at
    runtime;
  - zones are ordinary objects (move, enable, disable).

### Clouds (owner, 2026-10-22)

- The physical sky's clouds move with the scene's **global wind**: drift
  direction and speed come from it, so changing the wind changes the sky
  too. Today they are three.js's sky clouds, held still.
- The physical sky gets **cloud coverage** and **density** settings (0 =
  clear), plus a time offset so the start looks the same in replays.
- **Global only:** wind zones don't move clouds, since a zone is local
  ground wind.
- **Cost:** no extra pass; it's the sky shader's existing cloud term with
  moving inputs. Measured in 40.8 with the rest.
- Generic as everything else: no stylised cloud look. Coverage, density,
  colour and wind are settings; a game's look comes from its values.

### Bending away from subjects

The foliage shader pushes vertices away from each subject in the per-view
subject list (phase 39's array), within a radius and by a strength set on the
cover rule and the subject. It recovers over time through the same per-view
uniforms. There is no simulation and no per-instance state.

### The grass asset

Made in Blender through the art-factory pipeline (`blender-pipeline`):
- 2–3 clump variants of about 10–15 blades each;
- LOD0 about 40–80 triangles, LOD1 about 20, LOD2 about 6;
- wind weights in COLOR_0;
- no hidden geometry and no `_COL`, since cover doesn't collide;
- colour from a small texture or vertex colour.

The material uses the foliage shader with physically sensible roughness and
translucency. The asset ships as a template asset, not as engine art.

## 3. Items

**E2E budget (D253):** no new e2e file and no net added e2e time. Shader and
placement maths get vitest checks against CPU references. The editor surface
is one step in the terrain or scatter e2e.

| Item | What |
|---|---|
| 40.0 | **Release checks.** **Measure first:** a new perf class `meadow`: a 1 km² terrain with 4 blended layers and grass cover at the target density (on the current CPU cover path, as the baseline), plus a near/mid density sweep on the GPU. Run at the 60 Hz cap on both renderers. Record frame p95, GPU ms per pass, main thread, draws and triangles. This sets the density and LOD budgets the later items must meet. |
| 40.1 | **The grass asset** in Blender (the clump variants and LODs above), imported through the job export. Its report: triangles per LOD, texture sizes, file size. Looked at in the editor. |
| 40.2 | **GPU cover on terrain:** patch rings per view, procedural placement from the heightfield and layer weights, density thinning, per-ring LODs, frustum culling of patches, no shadow casting. The old CPU cover path is removed once this covers its cases; there are not two paths. |
| 40.3 | **GPU cover on other surfaces:** baked point sets per chunk for block layers, meshes and architecture, thinned on the GPU through the same renderer. An interior case (moss and debris on a block-built floor) is a test scene. |
| 40.3b | **One placement pipeline:** stored scatter and the instance brush draw through the same GPU renderer as cover. The old scatter and brush draw paths and the main-thread per-copy LOD pick are removed. Colliders and `ctx.scatter` addresses remain for nearby copies. The landscape and village classes must not regress (both renderers, at the cap), and the landscape class's main thread must fall (D212). |
| 40.4 | **Wind:** the global wind in the scene environment, `windZone` with blend and priority, the camera-centred wind map, the foliage shader reading it (bend by weight and height), `ctx.environment.setWind`, and the editor (environment panel, zone gizmo). Scatter trees and placed foliage models move with the same wind. |
| 40.4b | **Clouds:** the physical sky's clouds drift with the global wind; coverage and density settings on the sky (Environment window, presets, `setEnvironment`, `ctx.environment`); deterministic start; both renderers. |
| 40.5 | **Bending away from subjects** in the foliage shader from the per-view subject list, with radius and strength per rule and per subject. |
| 40.6 | **Editor:** cover rules on the GPU path in the terrain and block editors (density and layer weights painted as today), a live preview in the Scene view, wind zones placeable and shown, and a Scene view "wind preview" toggle. One step in an existing e2e. |
| 40.7 | **Stretch: roots take the surface colour** (opt-in material setting, off by default): each instance reads the surface colour at its root and blends the blade base toward it. Kept only if it stays in budget. |
| 40.8 | **Performance to target** on `meadow` at the 60 Hz cap, both renderers, 1080p, Iris Xe: frame p95 ≤ 16.7 ms and no missed frames. Main thread for cover ≤ 0.5 ms. Draws for cover ≤ 64. Every other perf class must not regress. |
| 40.9 | **The manual:** ground cover (rules, surfaces, density, distance, shadows), wind (global, zones, script), bending, the grass asset as an example, and the art-direction note (look comes from content). |
| 40.10 | **Acceptance.** In a real browser on both renderers at 1920×1080, at the cap: the 1 km² meadow with a player walking and running through grass, wind changing through a zone, the view from a hill to the far edge, and an interior with cover. Screenshots and a short capture to `~/.cache/thirdlight-phase40/acceptance`. Owner look pending; the owner judges the look. Full gate, then the phase review. |
| 40.11 | **Review fixes.** |

**Done when:**
- The meadow holds the 60 Hz cap at 1080p on both renderers.
- Cover works on terrain and on other surfaces through one GPU path.
- Stored scatter, cover and the instance brush share one placement pipeline
  and one renderer.
- Wind is one system with a global value and blending zones.
- Grass bends away from subjects.
- No art-style feature is built into the engine.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| 40.0 | Done 2026-10-24: three.js 0.186.1 still latest (`@types/three` 0.186.0); Rapier 0.21.0 out, pinned 0.20.0 stays (minor; phase 41). New perf class `node tools/perf/run.mjs meadow` (`tools/perf/meadow.ts`, `meadow-run.ts`, probe `bare/grass.js`; vitest `tests/perf/meadow.test.ts`): 1 km² terrain, 4 blended layers, stand-in clump 60/21/6 tris, cover 8 /m² to 60 m on the CPU path. At the 60 Hz cap, 1080p, Iris Xe: CPU cover holds (p95 16.7–16.8 ms, 0 missed, both renderers): 17,250 copies in view, 431k tris, 67 draws (45 scene), main thread 2.64 / 2.22 ms (ground alone 2.12 / 1.38), WebGPU GPU 8.3 ms (scene pass 3.99 vs 2.38 without grass). At 150 m reach it still holds on an idle host (966k tris, 153 draws, 131 scene; main 3.08 / 2.68 ms; under load average ~20 WebGPU missed 219). GPU sweep (one draw per ring): holds to ~2.1–2.9M tris in view; first misses at near 32 /m² on WebGL 2 (2.69M tris, 29 missed) and near 8 + mid 8 /m² to 150 m (4.8M, both). Proposed: near 8 /m² LOD0 to 30 m + mid 2 /m² LOD1 to 80 m (1.22M tris in view, 5 draws). Regression record at the cap (idle): landscape p95 16.7, 0 missed, 343 draws, 547k tris, main 4.2 / 4.29 ms, WebGPU GPU 9.9 ms; village 16.8, 0 missed, 222 draws, main 4.65 / 4.33 ms, GPU 7.8 ms (`~/.cache/thirdlight-phase40/baseline.md`). Fast gate green (19 min); D311 watch. |
| 40.1 | Done 2026-10-24 (look: owner): the grass in Blender (`templates/starter-3d/tools/grass.py`, bpipe, bp.foliage strips): GLB `meadow-grass`, pieces `grass_a` tall 0.85 m / `grass_b` 0.65 m / `grass_c` 0.5 m with dry blades, 14/12/11 blades; triangles LOD0/1/2 70/21/6, 60/21/6, 55/21/6 (vertices 98/35/18, 84/35/18, 77/35/18); COLOR_0 R height share (linear, the shader squares it), G phase per blade, B flutter, A 0.9; no `_COL`, nothing hidden; 26,424 B (266 tris, 418 verts). Colour: 64×256 KTX2 ETC1S sRGB, 9 mips, 3,700 B; material `meadow-grass` foliage, roughness 0.6, subsurface 0.35, wind to `FOLIAGE_NEAR_METRES`. Ships in the 3D starter's setup pack, placed nowhere (vitest `templates.test.ts`); job export inspected and published on a real backend (`ok`, no diagnostics or warnings, problems []), looked at in the editor (`acceptance/40.1-editor-*.jpg`). Meadow `--grass template` vs stand-in, CPU cover, build of 56f45f29, at the cap, load 1.5–4.8 on 10 cores, 2 interleaved rounds: both hold (p95 16.7–16.8 ms, 0 missed, both renderers); template 1,144k tris / 38 draws (16 scene) vs 767k / 28 (6), main 2.08–2.32 / 1.77–2.02 ms vs 1.92–2.25 / 1.38–1.60, WebGPU GPU 10.5–10.7 vs 10.4–11.5 ms. No e2e file touched. |
| 40.2 A | Done 2026-10-24: terrain cover placed on the GPU (`cover-gpu.ts`, maths `cover-placement.ts`, `TerrainView.coverSurface`): rings round the eye cut at the model's level switches and from the fade (√2 apart), patches of ~512 candidates inside one tile, one instanced draw per ring × mesh × page; the vertex stage places, turns, sizes and thins each candidate from a hash of its cell and the page's height/normal/hole/layer texels; patches frustum-culled on the CPU, the list texture written only when it changes; casts no shadow unless `castShadow`. Rules reading spacing/cavity/exclude/blobShadow, terrains with blocks layers or a spline band, block layers, and `?cover=cpu` stay on the CPU path (part B). Vitest `cover-placement.test.ts` (6: ground/slope/layers vs `terrainScatterSurface`, determinism per patch, density ±10 % per annulus, patch lists, WGSL build). Meadow at the cap, 3 interleaved rounds (load 1.3–3.5): GPU path p95 16.7/16.8 ms, 0 missed both renderers, 6 scene draws (5 cover) vs 45, cover main thread +0.17–0.25 ms over ground vs +0.4–0.5 (CPU path), WebGPU scene pass +3.4 ms over ground vs +1.7 (977k candidate tris vs 431k kept: per-vertex placement and thinned candidates; 40.8). Looked at: same look as the CPU path on both renderers. Fast gate green (10 min; terrain-cdlod e2e 4.2 m, its cover check reads GPU candidates; the file's terrain has spline bands, so its cover stays on the CPU path). |
| 40.2 B | Done 2026-10-24: every terrain's cover on the GPU, none made on the CPU: spline scatter bands, a blocks layer's cut, `exclude` regions and `cavity` reach the vertex stage as a mask per rule and tile (2 texels a sample, ≤ 512², one R8 array texture per terrain, made on the cover worker with the stored scatter's surface tests when a tile's patches are first listed, made again on edits with the old one drawn meanwhile; draws read masks only once their terrain has one); `spacing` by a grid no finer than it plus a 3 × 3 priority test. No blob shadows under cover; `coverDistance` bound 1 km → 10 km (CPU squares, still block layers' and `?cover=cpu`, stop at 1 km). Vitest `cover-placement.test.ts` +3 (masks against the band/region/cavity tests, no copy on a road as the CPU path, spacing: no pair closer, 1.13× the bake's density) and the WGSL build with spacing. terrain-cdlod e2e now requires GPU cover (4 masks, 0 CPU copies; tuft pixels pass), 3.2 m (part A 4.2 m), level-acceptance 27 s. At the cap (load 0.2–3.2): meadow p95 16.7/16.8 ms, 0 missed both renderers, cover main thread +0.07–0.13 / +0.26–0.32 ms over ground, 6 scene draws; landscape p95 16.7–16.8, 0 missed, 336 draws (343 with CPU cover), main 3.99–4.15 / 3.93–4.12 ms (CPU cover same hour 4.13 / 3.94), WebGPU GPU 9.75–10.2 ms. A band or region kept clear: unverified by eye (e2e counts and vitest only; the landscape's view shows no cover). |
| 40.3 | Done 2026-10-24: block layers' cover drawn from point sets through the same GPU renderer (rings, model levels, thinning, culling; one draw per ring and mesh): the cover worker bakes a rule's points per chunk (`bakeCoverPoints`, project-model `cover-points.ts`: the stored scatter's grid and conditions at full density, every floor of a column, spacing exact; 16 B a point, sorted by threshold) when the view's reach meets the chunk and again round an edit; `cover-points-gpu.ts` holds them in a float texture per rule, a ring lists the blocks of 256 holding its prefix. CPU squares, `coverMake` and `?cover=cpu` removed. Meshes and architecture carry no rules yet (D312). Vitest: `cover-points.test.ts` (5: equal to the stored bake on one floor, spacing too; every floor under a roof; sorted prefix; normals; a repeated ground ends the column), `cover-view.test.ts` (3: reach/edit/let-go through CoverView, thinning per annulus vs `coverShare` ±10 % with every kept point listed, WGSL build). Interior: block-layers e2e's floor under the pink roof grows moss and debris (66 points, 2 sets; looked at in the Play shot, WebGPU; WebGL 2 by eye unverified), 16.2 s (before 15–21 s); terrain-cdlod 3.1 m (3.2 m). At the cap (load 0.6–2): meadow p95 16.7/16.7, 0 missed, 6 scene draws, cover main +0.11/+0.29 ms over ground; landscape p95 16.7/16.7, none ≥ 25 ms, 330 draws (336 in 40.2 B), main 4.31/3.94 ms, WebGPU GPU 9.73 ms (block cover's candidates now count: 767k tris); village p95 16.7/16.8, 222/224 draws, main 4.67/4.35 ms (baseline 4.65/4.33). Fast gate green (10 min). |
| 40.3b | Done 2026-10-25: stored scatter and instance sets draw through the GPU copies renderer (`copies-gpu.ts` on cover's placement hook: a copy texture, per-frame lists of blocks of ≤ 64 copies with a header holding each draw's constants, one draw per mesh and level, a copy's level per copy or per block (`lodPerCopy`), thinning by rank, near shadows as shadow-only draws at the detailed level, impostors and vertex paint through the copy's columns, picking and diagnostics on the page when asked); `scatter-view.ts` → `stored-scatter.ts` (blocks prepared on the worker, a set made in one go); the main-thread per-copy pick and thinning are gone (the CPU sets left, architecture and spline pieces, pick per chunk). Vitest `copies-gpu.test.ts` (6), `stored-scatter.test.ts` (6, rewritten), `instancing.test.ts` (rewritten). Same-hour A/B at the cap vs ae580337 (load 1–2): landscape p95 16.7/16.7, 0 missed both; scene draws 306 → 310, main thread 4.10 → 4.14 ms WebGPU, 3.79 → 4.19 ms WebGL 2 (earlier rounds 4.15 → 4.27; noise ±0.5), GPU 9.5 → 10.4 ms (more vertex work: dropped candidates), D212 not met; village (fast gate at the cap) CPU 4.99/4.51 ms vs baseline 5.64/4.90. E2e: instance-brush 37.1 → 36.4 s, instances 3.7/4.5/5.0 s as before, terrain-cdlod 3.1 → 3.2 m, block-layers 16.2 → 16.0 s. D183 fixed, D313 opened. |
| 40.3 B | Done 2026-10-25 (05e49277, D312): cover on meshes through the same point sets and GPU draws: `model.scatter` (the model's upward faces, its most detailed level, read once the object has stood still 10 frames: `cover-models.ts`) and `architecture.scatter` (its flat fills facing up: storeys and interiors, `architectureFloorTriangles`), cover rules only, additive on 8; the worker bakes 16 m squares from a triangle surface (`mesh-scatter.ts`: highest upward face, the floors under it, face normals and slope, cavity); Inspector Ground cover panel (scatter cards, cover only). Vitest `mesh-scatter.test.ts` (4: floor under a shelf, no underside or wall; ramp slope; generated floor with stairwell and storey, ceiling none; cover-only validation), `cover-view.test.ts` +1 (a model settling, architecture floors, let go). E2e block-layers: a house's floor (12 m², behind the camera) gets moss in the Inspector, Play draws 3 sets, 89 points (block 66 + house ~23), 16.0 → 16.6 s; house cover by eye unverified. Fast gate green (9 min): village at the cap p95 16.8/16.7, 0 missed, main 5.12/4.69 ms (baseline 5.64/4.90). |
| 40.4 | Done 2026-10-25 (48d032cb, b9631ff6): one wind field. The scene's wind gains a top-down gust pattern (`noise` texture, else the engine's tiling value noise made in code; `scale` m, `speed` m/s, `octave`), `windZone` (box/sphere footprint, any of direction/strength/gust/turbulence/speed/scale, `blend` inside the edge, `priority`) baked with the global wind into a camera-centred 64 × 4 m half-float map (filled only on a zone/wind/32 m-square change; no zone cap; vitest vs `windAt`), read with the pattern by the foliage shader (now `foliage-nodes.ts`; bend = strength × COLOR_0 R² × height above the copy's root) on cover, copies, instances and placed models, and by the graph Wind node; `ctx.environment.setWind({…}, {blend, easing})` as simulation state (digest, saves, worker view; vitest `wind-blend.test.ts`); Environment window fields, the zone's Inspector (descriptor) and its Scene-view gizmo. At the cap (load 0.5–2.6): meadow (template grass) p95 16.7/16.7 ms, 0 missed both renderers, main 2.07/1.95 ms; with `--wind 3 --wind-zone` (a calm zone in view) 16.8/16.8, 0 missed, main 2.10/1.81 ms, WebGPU GPU 11.8 ms (scene 6.3); village 16.7/16.8, 0 missed, 224/226 draws (unchanged), CPU 4.99/4.57 ms (baseline 5.64/4.90). E2e materials 9.7 → 13.4 s (the panel's gust size + a calm zone from the menu stills the foliage), environment 10.3 s. Fast gate green (rerun of the e2e step). Looked at: the meadow in wind on both renderers (`acceptance/40.4-meadow-wind-*.jpg`, a still; motion seen only as pixel change); the zone gizmo and a zone's blend in motion unverified by eye. |
| 40.4b | Done 2026-10-25 (0e665e28): the physical sky is the engine's copy of three's TSL sky (`physical-sky.ts`, a row in the three upgrade checklist) with the cloud term moved by one drift uniform per renderer instead of three's render clock: travel = global wind direction × its gust `speed` (m/s, on a layer `CLOUD_LAYER_HEIGHT_M` 1 km up) × (`cloudTime` + presentation clock), re-anchored on a wind or start change so clouds never jump (`cloud-drift.ts`); zones ignored. Sky fields `cloudCoverage`, `cloudDensity` (0–1, default 0.4), `cloudTime` (0–86,400 s) in the model, validation, descriptors, blends (presets, `ctx.environment`), the IBL re-bake inputs and the Environment window. Vitest: drift (steady = v × (start + t) whatever the frames, no jump on change), the renderer's per-frame drift, one WGSL for any wind/coverage (no new program), HTTP `sky-clouds.test.ts` (set, refused, kept, preset, Play). E2e environment 10.3 → 12.2 s (rerun alone; the cover slider reaches the stored look). At the cap, meadow (template grass, `--wind 3`), load 1.5–4.2: colour sky unchanged (`driftClouds` returns early; perf classes use colour skies); physical sky clear p95 16.8/16.7, 0 missed, WebGPU GPU 15.2 ms (scene 9.1); `--clouds 0.6` 16.8/16.8, 7–10 / 8 missed, GPU 15.8 (scene 9.7: clouds ≈ +0.55 ms, the physical sky's lighting the rest, for 40.8). Village 16.7/16.7, 0 missed, CPU 5.13/4.81 ms (baseline 5.64/4.90). Looked at: clouds on both renderers (`acceptance/40.4b-clouds-*.jpg`); drift in motion unverified by eye (tests only). Fast gate green (e2e rerun, village run alone). |
| 40.5 | Done 2026-10-25 (d0407a17, D314): foliage gives way to the view's subjects (see-through's list: named ?? camera target, nearest 4, followed by its own `FoliageBendView` so it works with see-through off): `foliage-bend.ts` pushes a vertex away from a head→tail segment per subject (tail eases to the body over `recovery`, so a path closes behind a walker), (1−q²)² falloff to `radius`, × strength × ease × rule `bendAway` × COLOR_0 R² × height, held under 0.95 of the height with a length-keeping drop; 8 render-group vec4 uniforms + a live count (no program per subject; a uniform array's values never reached the draws, object-group uniforms refresh only with their draw). New `foliageBend` component (radius/strength/recovery), rule `bendAway` (cover through the placement, stored scatter through the copies header). Fixed on the way: a cover/copies draw's copy root never reached the foliage stage (TSL hands each Fn a fresh builder proxy; keyed by drawn object now), so wind and bend measured height from the terrain's origin. Vitest `foliage-bend.test.ts` (9: falloff, strength/rule/weight, lean held, path share, recovery/ease/jump, see-through off, WGSL same program, copy root + `bendAway` in a cover draw). Meadow (template grass) at the cap, load 1.3–2.3, both renderers: plain p95 16.7/16.7, 0 missed, main 2.37/2.40 ms, WebGPU GPU 10.8 ms; walker p95 16.7/16.7, 0 missed, main 2.34/1.98, GPU 11.0; still subject bend on/off p95 16.8/16.7 vs 16.7/16.7, 0 missed, GPU 10.98 vs 11.21 ms (noise). Looked at: forced radius 40 parts the meadow round the box (`acceptance/40.5-forced-radius40-webgpu.jpg`); at the defaults from eye height 7 m away the parting is subtle (`40.5-still-bend-on/off-*.jpg`, `40.5-walking-webgpu.jpg`); the recovering trail in motion unverified by eye. No e2e file touched; fast gate green (11 min; materials + terrain-cdlod 4.4 m together; `scan-bounded-log.test.ts` failed once, passed alone; village at the cap CPU 4.98/4.64 ms). |
| 40.6 | Done 2026-10-25 (753ce84c): Scene-view **wind** toolbar switch (off by default): the library's wind clock (`windTime`, `setWindHeld`) holds foliage and the wind field at the held pose while water and graph time run on, and held foliage no longer keeps the view drawing (vitest +1). Rule cards gain *Gives way* (`bendAway`) for cover and stored rules. Verified, nothing new needed: cover rules edit through the same cards (terrain Bake, block editor and Inspector *Ground cover* Apply) and the Scene view draws GPU cover as Play does; wind zone in GameObject → Light; its gizmo; `foliageBend` via Add component (descriptor); `model`/`architecture` `scatter` lists. E2e: terrain-cdlod's Scene view near the disc grows the baked tufts (white pixels round it 82 before the bake, more than 97 after), 3.2 → 3.2 m; materials turns the wind preview on (motion) and off (still with the scene's wind back), 13.4 → 12.3 s. Looked at: `acceptance/40.6-scene-cover-terrain.jpg` (tufts and posts on the disc in the Scene view, WebGPU), `40.6-wind-zone-gizmo.jpg` (zone box edges, *wind: on*). Unverified by eye: block-editor cover in its Scene view, the swaying itself (pixel change only), WebGL 2 Scene view. Fast gate green (11 min, village at the cap CPU 4.99/4.74 ms). |
| 40.8 A | In progress. Acceptance meadow = `--grass template --wind 3 --walker --clouds 0.6` (physical sky), at the cap; perf runs now log the GPU clock (`gpuClock`: at a capped rate the governor slows the GPU, so pass ms × clock ÷ max = ms at full clock ranks configs). Before (load 1–2): p95 16.7/16.8, 0 missed both, WebGPU GPU 14.7 ms at full clock (scene 10.0; ground alone 6.3), clock pinned at max on both renderers; split by switching parts off: image-based lighting 2.9 ms (radiance 1.45, irradiance 1.2), sky dome 0.65, grass receiving shadows 0.9. (1) A cover candidate the distance thins leaves its vertex stage before any texel read, and the subjects' push skips vertices that cannot lean: GPU 14.70 → 14.44–14.53 ms full clock, 0 missed both; fixed on the way: placement read inside a branch made three re-read the raw vertex in the wind's branch (vitest guards it). Fast gate green (11 min; terrain-cdlod + materials 4.4 m, as before). |

## 5. Decision log

- 2026-10-21: Planned from the owner's goal and choices: generic only (no
  sheen, no grass-like terrain shading), a world-space scrolling noise wind
  with a global value and local zones, no shadow casting with SSAO for
  contact, bending from the subject list, root colour as a stretch, and the
  frame rate measured at the cap.
- 2026-10-22: The owner added clouds that drift with the global wind, with
  coverage and density settings (40.4b).
- 2026-10-24 (40.0): Budgets for 40.2/40.8 from the meadow sweep, default
  chosen, owner to confirm: cover grass on terrain at 8 clumps/m² (about 100
  blades/m²) with LOD0 (≤ 80 tris) to 30 m, then 2 clumps/m² with LOD1 (≤ 20
  tris) to 80 m, nothing past (the terrain's layer colour); about 1.2M cover
  triangles in view, half the lightest load that missed the cap (2.7M), as the
  probe has no post stack and no game; patches 8 m near, 16 m mid; one draw
  per ring and mesh level. A far ring (LOD2, 1 /m² to 300 m) held the cap at
  2.1M tris but is past that margin: 40.8 may add it if the measured frame
  allows. The target density "dense, tall grass" is read as 8 clumps/m² of
  0.5–0.8 m blades.
- 2026-10-24 (40.0): The sweep is judged by frames at the cap only (no
  missed refresh beyond one per window, p95 within 0.3 ms of 16.7). GPU
  timestamps at a capped rate follow the Iris Xe's clock, which drops when it
  idles (the same config read 3.4–5.2 ms in two runs), so they do not rank
  configs.
- 2026-10-21: The owner added one placement pipeline (stored scatter, cover
  and the instance brush through one renderer), after the maintainability
  review counted three placement systems.
- 2026-10-24 (40.1): The grass ships in the 3D starter's setup pack as
  content (model, KTX2 colour texture, foliage material), placed nowhere,
  so a new project looks and costs the same until a cover rule uses it;
  the meadow class takes it with `--grass template`. Default chosen, owner
  to confirm. Its colour is a separate texture asset bound by the material
  (as the Basic Kit does), not embedded in the GLB; the GLB's own colour is
  the texture's mean green so it reads alone. COLOR_0 R is written linear in
  height because the foliage shader squares it (`bp.foliage` writes it
  squared, so the script overrides it). Re-running the whole
  `build-template.mts` today also rewrites the ground material to the
  engine's current layered material; only the grass lines were taken.
  With three pieces the meadow draws 1.5× the triangles of the stand-in
  (not traced; likely its wider clumps keep LOD0 further out) and 10 more
  draws;
  it still holds the cap on the CPU path.
- 2026-10-24 (40.2 A): Default chosen, owner to confirm: GPU cover keeps
  every copy to 60 % of the reach and fades them over the rest, as the CPU
  path did; a rule's `densityStart` (screen size) opts into thinning by the
  square of distance from where the model covers it. Rings are cut at the
  model's level switches (one level per ring) and from the fade, √2 apart.
- 2026-10-24 (40.2 A): The `coverDistance` cap (1000 m) stays until part B
  removes the CPU path, which cannot bear a larger reach; the GPU path has
  no cap of its own (its patches grow with the ring, at most 48 across).
- 2026-10-24 (40.2 A): Part A draws on the GPU only what it reads exactly
  (height, slope, noise, layer shares, holes); rules with spacing, cavity,
  regions or blob shadows, and terrains whose block layers or spline bands
  keep cover off, stay on the CPU path for part B to move.
- 2026-10-24 (40.2 B): Default chosen, owner to confirm: a cover rule's
  `spacing` on the GPU is approximated: its grid is no finer than the
  spacing and a candidate gives way to a neighbour of the 3 × 3 cells round
  it that stands within the spacing, would be kept, and has the higher
  priority hash (the stored scatter's rule), the neighbour judged on the
  candidate's own conditions. No two copies of a ring stand closer than the
  spacing; the density is within 15 % of the bake's.
- 2026-10-24 (40.2 B): Default chosen, owner to confirm: `blobShadow` is not
  drawn under terrain cover (SSAO gives the contact, as the owner chose for
  grass); stored scatter keeps its blob shadows.
- 2026-10-24 (40.2 B): Default chosen, owner to confirm: `coverDistance` may
  reach 10 km (the bound `shadowDistance` has); the rule's distance ends
  cover. The CPU squares, which grow with the square of the reach, stop at
  1 km; they serve block layers until 40.3 and the `?cover=cpu` comparison,
  which goes with them.
- 2026-10-24 (40.2 B): Masks are 2 texels per terrain sample (≤ 512 a
  tile side, a byte each: 256 KiB a tile for 257-sample tiles), held per
  rule and tile while the tile's patches are listed (let go 300 frames
  after), asked only where a rule reads one (cavity, regions) or a band or
  blocks layer lies; a tile is drawn once its mask arrived.
- 2026-10-24 (40.3): Default chosen, owner to confirm: a block layer's
  point sets are baked on the cover worker, not the backend: the page
  already holds the chunks and the worker the stored scatter's surface code,
  cover is never stored, and a set is baked when the view's reach first
  meets its chunk and again when its ground changes (never per frame); sets
  the view left are let go after 300 frames.
- 2026-10-24 (40.3): Default chosen, owner to confirm: a point is 16 bytes
  that are the GPU's texture as they are (no conversion on the page): its
  place across the chunk (12 bits a side, 1/4,096 of the chunk), its height
  (a float), its threshold, turn and size (a byte each) and an octahedral
  normal (8 + 8 bits). The plan's "weight" is the threshold (a hash of the
  candidate cell, so an edit keeps every other point's); turn and size are
  stored because the GPU no longer knows the candidate's cell to hash.
  Points are sorted by threshold, so a ring lists only the prefix it can
  keep, in blocks of 256.
- 2026-10-24 (40.3): Default chosen, owner to confirm: block-layer cover
  grows on every floor of a column with open space over it (a floor under a
  roof or a storey's ceiling: interiors), through the scatter surface's new
  `under`; the stored scatter still reads only the highest ground. Spacing
  is kept exactly (3D, any floor), as the stored bake keeps it.
- 2026-10-24 (40.3): Meshes and architecture floors carry no scatter rules
  in the format today (rules live on terrains and block layers only), so
  they have no cover yet; the point-set path takes any surface that answers
  `at`/`under`, and giving them rules is a format and editor change (D312;
  done in 40.3 B).
- 2026-10-24 (40.3): The CPU cover path is gone (cover-view's squares, the
  worker's `coverMake`, `?cover=cpu`, the meadow class's `--cover cpu`):
  `renderer.cover` in the diagnostics is now `{ sources, tilesSent, gpu }`.
- 2026-10-25 (40.3b): Default chosen, owner to confirm: stored scatter and
  instance sets draw through `copies-gpu.ts` on cover's placement hook (one
  vertex stage for every set: its constants in a header of each draw's list
  texture, so the sets of a scene share programs as the CPU sets did). A
  copy is 48 bytes of float texture (place, thinning rank, turn, scale,
  paint slot); blocks of up to 64 copies (a k-d split inside the set's
  chunks, so `chunkSize` and `instance_chunk_m` keep their meaning: how
  finely a set is culled) are listed per frame per draw, the view's first,
  then off-screen candidates (shadow maps, or a view that moved since it was
  culled), then, for the detailed level, every block (the cached static
  map). `lodPerCopy` keeps its meaning and defaults: per copy on the GPU
  (scatter: on) at no extra draw, more vertex work where a block spans a
  switch; off (instance sets) each block picks one level at its centre with
  the project's hysteresis, as a CPU chunk did. Per copy, levels switch
  exactly at their distance (no hysteresis).
- 2026-10-25 (40.3b): Default chosen, owner to confirm: a rule's
  `shadowDistance` casts from shadow-only draws of the same set listing the
  blocks within reach of the eye, at the model's most detailed level (the
  CPU squares used whatever level a square's chunk picked).
- 2026-10-25 (40.3b): Copies keep an identity only when asked: a ray picks
  a copy through whichever of the set's own draws is shown, by walking the
  copies (a sphere test, then the detailed meshes); `copyBox`, `setCopies`
  (hidden and removed script copies, the editor's preview) and the
  diagnostics' counts (by block where a block is at one level and does not
  thin, cached per view) read the copy texture on the page. Colliders and
  `ctx.scatter` addresses stay the runtime's (`scatter-copies.ts`).
- 2026-10-25 (40.3b): The CPU instance sets that remain (generated
  architecture's and splines' pieces) pick one level per chunk; the
  main-thread per-copy pick and thinning (`ChunkLodPicker`'s per-copy loop,
  `lodPerCopy`, `density`, the sets' worker preparation) are removed.
  Occlusion culling's per-copy GPU path (`occlusion-instances.ts`) applies
  to those sets and to batches, not to copies sets (D313).
- 2026-10-25 (40.3 B): Default chosen, owner to confirm: meshes take ground
  cover through an optional `scatter` on the `model` and `architecture`
  components (the scatter rule format; only `cover: true` rules: a mesh has
  no stored scatter), edited in the Inspector's Ground cover panel. A
  model's cover grows on every face of its most detailed level that looks
  up (a roof and the floor under it alike), read once the model has loaded
  and the object has stood still 10 frames (a drag or a scripted move bakes
  once, where it rests; nothing per frame while it moves); architecture's
  on its flat fills facing up (rooms', storeys' and stairwell-cut floors;
  roofs, vaults and stair treads not). Points are baked per 16 m square of
  the object's frame on the cover worker, as block layers' chunks are.
  Layer, block and region conditions read nothing on a mesh (no paint, no
  cells).
- 2026-10-25 (40.3b): D212 is not met by this item: the copies' per-copy
  work left the main thread (the CPU sets' cull and near-shadow squares were
  ~0.7 ms a frame of the landscape class; the copies' block lists ~0.1–0.2
  ms), but the frame's main thread is three's draw submission, and the
  draws stayed (306 → 310 scene draws: 140 block-layer chunks, 97 others,
  30 spline, ~75 copies draws). What remains is fewer draws: merging the
  copies of sets that share a model and material, block chunks' draws.
- 2026-10-25 (40.4): Default chosen, owner to confirm: the engine's gust
  pattern is a 128² tiling value noise made in code (three octaves, no
  look of its own), not a shipped file; a scene names its own with `noise`.
  The pattern spans `scale` 20 m by default and travels at `speed`, absent:
  `gustFrequency` × `scale` (as many gusts pass a point a second as the
  old sine gusts); a second layer at 0.27 × the size and 1.6 × the speed
  gives 35 % of it.
- 2026-10-25 (40.4): Default chosen, owner to confirm: wind zones are read
  from above (a box turns with its object about up, a sphere is its circle;
  height ignored) and blend inward: whole `blend` metres inside the edge
  (default 2 m, smoothstep), nothing outside the shape, so the gizmo's
  shape is the zone's whole reach. Overlaps lay on by priority, then entity
  id. A new zone is a 20 × 10 × 20 m box (sphere radius 10 m) that changes
  nothing until a value is set. The noise texture and its second layer are
  the scene's only.
- 2026-10-25 (40.4): Default chosen, owner to confirm: the wind map is 64
  texels of 4 m (256 m round the camera, re-centred in 32 m steps), so a
  zone's edge is no sharper than 4 m; past it (and when no zone reaches
  it) shaders read the global uniforms alone and skip the map. Where a zone
  changes the pattern's direction, speed or size, the pattern flows as flow
  maps do (two reads half of a 6 s period apart) blended in by the zone's
  weight; elsewhere it scrolls exactly (the page works out the offsets).
- 2026-10-25 (40.4): Default chosen, owner to confirm: a foliage vertex
  bends by the wind's strength (gusts included) × COLOR_0 R² × its height
  above its root (a cover/copies draw's place, an instance's origin, else
  the object's) × 0.12 per metre, so a 1 m plant bends as the old fixed
  ~0.12 m sway did and taller ones further; existing projects' foliage
  changes with its height. A mesh without COLOR_0 (which did not move)
  now sways by its height share of the first metre in fixed metres.
  Foliage materials read their object's frame, so they are never merged
  by static batching (the village's draws did not change).
- 2026-10-25 (40.4): Default chosen, owner to confirm:
  `ctx.environment.setWind` adds to the last change (`setWind(null)` goes
  back to the scene's own wind), blends like presets over whole steps (at
  most 16 script winds at once) and is its own state beside the presets,
  so a wind change never retimes a sky blend. Its typed script and graph
  form omit `octave` (the graph generator has no object port); the runtime
  accepts it. Wind zones keep laying their values over a script wind.
- 2026-10-25 (40.4): The materials e2e grew 3.7 s (9.7 → 13.4 s) for the
  editor surface: the panel's gust size and a calm zone made from the menu
  and set in its Inspector stills the foliage; no other e2e covers zones.
- 2026-10-25 (40.4b): Default chosen, owner to confirm: clouds drift at the
  global wind's gust `speed` (m/s, absent `gustFrequency` × `scale`; the
  engine's breeze 6 m/s) on a layer 1 km up, so a cloud crosses the zenith
  in minutes; there is no separate cloud speed. `cloudCoverage` and
  `cloudDensity` default to 0.4 (three's own values: existing physical skies
  start as they looked); `cloudTime` 0. What changes for existing projects:
  their physical-sky clouds now drift (they stood still), and the clouds
  join the image-based lighting's re-bake inputs. Cloud colour stays the
  sky's (sun and atmosphere), not a setting. The Scene view still draws on
  demand: its clouds move only while something keeps it drawing.
- 2026-10-25 (40.4b): Three's `SkyMesh` drives its clouds by `time ×
  cloudSpeed` with no way in, so the engine keeps a copy (MIT, unchanged but
  the drift lines; checklist row). Drawing the sky after opaque surfaces
  (render order) was tried and measured no gain on the meadow, so dropped.
  The meadow at the cap with a clear physical sky drew a WebGPU scene pass
  of 9.1 ms against 6.3 ms in 40.4's colour-sky run (other session; the
  sky's lighting), clouds at 0.6 cover +0.55 ms more: 40.8 measures the sky
  with the rest.
- 2026-10-25 (40.5): Default chosen, owner to confirm: the subject's
  values live on a new `foliageBend` component (`radius` m, absent: the
  body's radius + 0.3 m; `strength` 0–4, default 1: a tip leans by about its
  own height at the body; `recovery` s, default 1), the rule's on
  `bendAway` (0–4, default 1, a factor; for trees or rocks drawn with a
  foliage material set 0). A subject without the component still bends
  grass with the defaults. Recovery without per-plant state: each subject
  keeps a tail point easing toward its body over the recovery time, and the
  push falls along the segment from the body (all) to the tail (none), so a
  path closes behind a moving subject and stays parted round a still one; a
  turn cuts the corner of the trail (straight segment). The push is held
  under the plant's height (0.95 of it) and the vertex drops to keep its
  length; vertices above the body's top or below its feet are spared by
  that distance. The list is see-through's (named ?? camera target, nearest
  four), followed by its own view so it works with see-through off.
- 2026-10-25 (40.6): Default chosen, owner to confirm: the Scene view's
  wind preview is off by default and view-only (not saved): an editing view
  draws on demand, and swaying foliage kept it drawing every frame. Off
  holds only the wind's clock (foliage keeps the pose of the held moment,
  zones and strength still shape it); water and a graph's Time node run on.
  Play and exports never hold.
- 2026-10-25 (40.6): Cover edits reach the Scene view through the rule
  cards' Bake/Apply, as before (a draft is not drawn before it is applied;
  material rules have a live draft preview, scatter rules none). Painting
  layer weights and sculpting show in GPU cover at once (it reads the
  terrain's textures; from 40.2, not looked at again here). A live draft preview of cover rules is left out.
- 2026-10-25 (lead): 40.8 runs before 40.7: the stretch (roots take the surface colour) is kept only if it
  fits the budget, which 40.8 sets.
