# Phase 42 — Unified lighting

Status: planned 2026-10-22. Built on a branch after the current phases
(through 41) are done; merged to `main` only after acceptance.

Goal: one lighting system for every static surface (terrain, block layers,
generated architecture, static models). It gives direct light from every light
kind (sun, point, spot, area, line, emissive) with soft shadows, bounced light,
and reflections. It works like Unreal's Lumen, but uses what this engine
already knows about its geometry, rooms and changes, so it fits an integrated
GPU with upscaling. On WebGL 2 the same system's saved result draws as baked
lighting. Read `docs/roadmap.md` (principles 1, 5 and 7) first.

## 1. Owner decisions (2026-10-22)

- **The target is Lumen-quality lighting:** realtime bounced light,
  reflections, and soft shadows from direct light, including area lights.
  Performance costs are accepted where the gain in lighting quality and ease
  of use justifies them.
- **Integrated GPU with upscaling.** The medium tier must run on this host's
  Iris Xe at a 1080p output, rendered at a lower internal resolution and
  upscaled. Measured at the display's 60 Hz cap, never uncapped.
- **WebGL 2 keeps baked lighting** as the low tier. It is required, not a
  stretch.
- **On a branch.** The work starts after the phases now planned are done
  (through 41), on a branch of this repo, and is merged when the phase
  passes acceptance. Until then `main` keeps the current lighting.

Owner to decide (defaults below, used if the phase starts without an answer):

- **This phase and the planned lighting phase** (`docs/roadmap.md`, Future):
  - Its "light modes in probes" and area lights are covered here (42.5, 42.6).
  - Its adaptive probe placement is partly replaced by probes per room (42.6).
  - Clustered lighting is still needed for lights that reach moving objects
    and for pixel-rate highlights.
  - Default: this phase absorbs the lighting phase except clustered lighting,
    which stays its own item, run before or inside this phase.
- **Static models without a second UV set (UV1).**
  - Default: their cache is surfels (small disks spread over the surface at
    import, EA's GIBS approach), so no model needs an unwrap.
  - The alternative is an automatic unwrap at import, cached with the asset
    like other import results.
  - Models that opt out are lit from probes only, like moving objects.
- **Moving objects add nothing to the bounced light.**
  - Default: they receive all lighting but do not block or bounce it, apart
    from casting sun and local-light shadows as today.
  - Kept unless the 42.1 spike shows a cheap way to include them.

## 2. Design

### The core idea: light is computed on surfaces, once, and reused

One **surface radiance cache** stores the diffuse light of every static
surface: direct light from every light kind with its soft shadows, plus bounced
light and emissive light.

- Pixels, probes, reflections and bounces all read that one cache.
- The cache is updated only where something changed.

That makes one scene representation, one tracer and one result. Unreal splits
the same work across Virtual Shadow Maps, MegaLights, Lumen GI and Lumen
reflections.

### What the engine knows that Lumen has to approximate

**Exact geometry for tracing.**

- **Block layers:** rays step cell by cell (DDA) through the chunk grid,
  uploaded straight from the binary chunk data. No voxelizing, and no leaks
  through block walls.
- **Terrain:** a ray march over the height tiles with a min/max height
  pyramid. Exact, with no extra representation.
- **Generated architecture:** walls, floors and trims are boxes and quads
  known from their parameters, with their real thickness. A uniform grid over
  them accelerates the search.
- **Imported static models:** the only approximated part. Each gets a
  distance-field brick set at import, cached with the asset and shipped in
  the export.

One tracer module answers "what does this ray hit": the hit's distance, its
normal and its cache address, for every geometry kind.

**A surface cache that is generated, not captured.**

- **Blocks:** one slot per visible cell face, addressed by cell and face.
- **Terrain:** a texture laid over the height grid, in rings that get coarser
  with distance from the camera.
- **Architecture:** its generated UVs.
- **Static models:** UV1 where they have it (the same UVs the lightmap path
  uses), otherwise surfels (owner decision, §1).

The cache is a dynamic lightmap atlas, stored in pages. Pages around each view
are resident at resolutions that fall with distance. Pages stream with the
scene's tiles (the probe-residency pattern). Its size is a memory budget in
the quality settings, never a count of surfaces or lights.

**Rooms and portals stop leaks.**

- Room portals (`project-model/src/arch-portals.ts`) already say which rooms
  connect and through which openings.
- Probes belong to a room. A ray that leaves a room continues only through
  its portals.
- Interiors made from generated buildings cannot leak light through closed
  walls.
- The probes' `edgeWalls` stay as the fallback for interiors made from blocks
  or imported models without rooms.

**Updates follow changes, not frames.**

Every change reaches the runtime through known paths:

- commands in the editor;
- block and terrain edits, live or scripted;
- a light's state: on, off, colour, intensity, moved;
- time of day;
- objects marked static being moved.

Each change marks the affected cache pages and probes stale. A per-frame
budget (ms, set per quality tier) re-lights stale work nearest the camera
first.

- A still scene settles and then costs close to nothing.
- A switched lamp re-lights its room over a few frames.
- Time of day steps the sun and re-lights a slice of the world each frame.

### How each kind of light flows through the system

**Direct diffuse light, for every light kind.**

- It is computed at cache texels, not pixels: about 10 cm per texel near the
  camera, coarser further away.
- Shadows come from rays through the tracer. Area and line lights trace
  several rays per texel over their shape, which gives real penumbrae. The
  sun's soft shadows trace toward its angular size.
- Texels are far fewer than pixels and are updated only on change, so many
  shadowed area lights are affordable. Static lights are not bound by the
  per-scene local-light cap (`MAX_LOCAL_LIGHTS`); the cap still applies to
  lights drawn per pixel.
- Light layers (`lightMask`, `shadowCasterMask`) are respected.
- **New light kind `area`:** shape `rect` or `line`, a size, one- or
  two-sided, and the existing modes (`realtime`, `baked`, `mixed`).
- **Emissive surfaces** inject their light into the cache from their
  material.

**Bounced light.**

- Each cache texel adds bounce light from its room's probes.
- Probes are updated by rays through the tracer that read the cache where
  they hit. Feeding the result back in builds up multiple bounces over time.
- Moving objects, foliage and ground cover read the probes, so they are lit
  consistently with the static world.
- The probe sampling (`three-adapter/src/probe-lighting.ts`) and its walls
  stay. Only the source of the probes' light changes.

**What pixels do.**

- Static surfaces read their diffuse light from the cache: one filtered
  lookup, about the cost of a lightmap.
- **The sun keeps a per-pixel shadow map**, because sharp sun shadows need
  pixel resolution. It uses the cached static map with moving casters on top,
  as today.
- **Screen-space contact shadows** add fine detail.
- **Highlights** are computed per pixel, with three's rectangle-light maths
  for area lights. Their shadowing reuses the cache's visibility for that
  light.

**Reflections.**

1. Screen-space rays, using the depth pyramid that occlusion culling already
   builds.
2. On a miss, the same tracer, reading the cache at the hit. Reflections then
   show the lit world, including bounced light and emissive surfaces.
3. Rough surfaces use the probes. Glossy surfaces trace at quarter
   resolution, and the temporal pass resolves them.
4. Mirror-sharp reflections of things off screen are out of scope.

### Temporal upscaling

- Every pixel pass runs at the render scale, which the engine already has
  (with dynamic resolution). The image is upscaled with three's `TAAUNode`.
- This needs motion vectors from every material kind: skinned, instanced,
  wind-bent foliage, decals and block chunks.
- The caches do not depend on resolution, so upscaling saves pixel work only.

### The bake is the same system

- In the editor (WebGPU), "Bake lighting" runs the system until it settles,
  then saves the cache pages and the probes.
- WebGL 2 draws those saved results the same way WebGPU draws live ones.
- WebGPU games ship the same bake as their starting state and update it live
  on the medium and high tiers.
- `lightmap-baker.ts` and `probe-bake.ts` are replaced by this path and
  removed. There are not two bakers.
- Existing bakes keep drawing until a scene is rebaked, and an upgrade marks
  them stale.
- The Scene view and Play show the same lighting by construction.

### Quality tiers

| Tier | Renderer | What runs |
|---|---|---|
| Low | WebGL 2 (or a chosen WebGPU setting) | Saved cache and probes, sun shadow map; no live updates |
| Medium | WebGPU, integrated GPU | Live cache and probe updates within budget, screen-space reflections with probe fallback, TAAU |
| High | WebGPU, discrete GPU | Medium, plus more rays per texel, traced glossy reflections, a larger budget and resident area |

The tier is a quality-level setting, chosen per device, as other quality
settings are.

### Budget: medium tier, Iris Xe, 1080p output from about 720p internal

Soft targets (principle 7). They guide the design; a miss is recorded with its
cause.

| Pass | Target |
|---|---|
| Cache update (texel lighting and shadow rays), only for stale work | ≤ 1.5 ms while changing, ≈ 0 when settled |
| Probe update | ≤ 0.5 ms |
| Sun shadow map | no more than today |
| Cache lookup and highlights in materials | within 0.3 ms of a lightmap lookup |
| Reflections | ≤ 1.5 ms |
| TAAU | ≤ 1 ms |
| A switched lamp re-lights its room | ≤ 250 ms |

### Limits of the design

- Moving geometry does not block or bounce bounced light (owner decision
  above).
- A level made mostly of imported meshes loses the exact-geometry advantage
  and gets distance-field quality.
- A large change (a sun sweep, a lot of terrain dug at once) shows light
  catching up over several frames.
- Mirror-sharp reflections of things off screen are out of scope.
- The phase adds private three.js hooks. Each one is listed in
  `docs/three-upgrade-checklist.md`.

### Platform constraints

- **No hardware ray tracing in WebGPU.** Every trace is software, in compute.
  That is why the tracer leans on exact grids and fixed shapes.
- **Divergent work is slow on Intel GPUs.** Godot's HDDAGI reports problems on
  Intel from divergent control flow. The tracer keeps neighbouring threads on
  similar paths: rays sorted or grouped by direction and geometry kind, and
  fixed step counts per pass.
- **Storage buffers per compute pass are capped** (Chrome; met by the WebGPU
  surfel GI work below). Passes are split, or data packed into textures,
  to stay under the cap.

### Prior art (checked 2026-10-22)

| Work | What it is | What this phase takes from it |
|---|---|---|
| Enlighten (Geomerics, Silicon Studio; Battlefield, Unity 5) | Realtime radiosity into lightmaps and probes from precomputed visibility between surface patches | Shipped proof of a realtime lightmap. Its precompute ties it to static geometry, so this phase traces instead (blocks and terrain change live) |
| Godot proposal 6033, "raytraced dynamic lightmaps" (closed, not planned, 2023) | The same idea, turned down over moving objects, UV2 for procedural geometry, and memory | Moving objects use probes; blocks and terrain need no UVs; pages stream. Memory is measured in the 42.1 spike |
| Godot HDDAGI | Voxel hierarchy traced by DDA, replacing distance-field GI: faster updates, less leaking | The block-grid DDA tracer; the Intel divergence warning |
| On-surface radiance caches (TU Graz, HPG 2024) | A two-level cache kept only on surfaces in texture space, at the lowest resolution that holds quality; diffuse and glossy | The core design: one surface cache read by everything |
| GIBS (EA SEED and Frostbite; College Football 25) | Light cached on surfels: no UV sets, no precompute, works for player-made content (uses hardware ray tracing) | Surfels for static models without UV1 |
| Surfel GI on the web (Jure Triglav, 2026) | three.js and WebGPU compute, software tracing through `three-mesh-bvh`; 60 fps on Sponza on a desktop GPU; static, diffuse only | Proof the stack can run a surface cache; the storage-buffer cap |
| AMD GI-1.0 and Brixelizer GI | Screen probes plus a world hash-grid cache (1.9–3.1 ms on an RX 6900 XT); sparse distance-field bricks built on compute only | Bricks for imported models; a hash grid as a later probe upgrade |
| Split Radiance Cascades (Freeman and Sannikov, arXiv 2026) | Radiance Cascades in 3D world space: sparse hashed probes, rays split by hit distance, detail at every scale without noise | A later upgrade for the probe layer; too new to plan on (no numbers checked) |
| MegaLights (Unreal 5.5–5.7) | A few rays per pixel to randomly chosen lights: soft shadows from hundreds of area lights | The alternative this phase does not take: shadows at cache texels are cheaper and stable, but only as sharp as the cache, so contact shadows and the sun's map stay per pixel |
| NVIDIA DDGI (RTXGI) | Probe grid updated by rays: 1–2 ms on an RTX 2080 Ti, about 5 MB per cascade | Probe update and the distance test against leaks |

### Later, not this phase

- Probes in a world hash grid (GI-1.0) or Split Radiance Cascades in place of
  the uniform grid, if probe detail turns out to be the weak part.

## 3. Items

**E2E budget:** no new e2e file and no net added e2e time.

- Tracer, cache addressing and change tracking get vitest checks against CPU
  references.
- Pixel checks extend `tests/e2e/lights.e2e.ts`, `tests/e2e/shadows.e2e.ts`
  and the lightmap and rooms-lighting e2e files.
- Old bake tests are replaced, not kept beside the new ones.

| Item | What |
|---|---|
| 42.0 | **Release checks and branch.** three.js release check through `docs/three-upgrade-checklist.md`. Create the branch from `main` once 41 is done. **Measure first:** the village, landscape and an interior class (blocks and generated rooms with a door) with today's lighting, at the 60 Hz cap on both renderers. Record frame p95, GPU ms per pass and bake times. Add four look-reference scenes: a block room lit through a door, a generated building at sunset, a corridor lit by area and line lights, and an emissive sign on terrain at night. Check the WebGPU features the design needs on the Iris Xe (storage textures, timestamp queries) in the reference browser. |
| 42.1 | **Spike and go/no-go.** The tracer over block layers and terrain only, a cache for one block-layer room, and sun plus one area light with soft shadows into it, drawn by the block material. Measure on the Iris Xe: re-lighting the room after a light change, the tracer's cost with rays grouped versus ungrouped (Intel divergence), and cache memory per room and per km² of terrain. **Stop the phase** and record why if one room cannot re-light within 250 ms at ≤ 1.5 ms a frame, or the cache cannot fit the memory budget. |
| 42.2 | **The tracer.** Block layers, terrain, architecture primitives, and distance-field bricks for imported static models (made at import, cached, shipped in the export). One tracer module returns hit distance, normal and cache address. Vitest against a CPU reference for every geometry kind. |
| 42.3 | **The surface cache.** Addressing per kind (block faces, terrain rings, UV1 and architecture pages, surfels for models without UV1), residency around each view, streaming with the scene's tiles, a memory budget per quality tier. Surfels spread at import, or the unwrap, per the owner decision. |
| 42.4 | **Change tracking.** Stale marks from commands, live block and terrain edits, light state, time of day and moved static objects. A per-frame budget that re-lights nearest-first, and a settled state. Diagnostics: stale pages, ms used, settled. |
| 42.5 | **Direct light into the cache.** Sun, point, spot, the new `area` light (`rect`/`line`, size, sides, modes) and emissive surfaces, with traced soft shadows and light layers. The `area` light in project-model, the Inspector, MCP and the docs. Static lights not bound by `MAX_LOCAL_LIGHTS`. |
| 42.6 | **Bounced light.** Probes per room through portals, `edgeWalls` as the fallback, probes updated by rays into the cache, cache texels lit by their probes (multi-bounce over time). Moving objects and foliage read the probes. Light modes: `baked` and `mixed` lights in the saved result as in §2, `realtime` lights live only. |
| 42.7 | **Materials read the cache.** Every lit material kind (custom-lit, graph, layered surface, blocks, architecture). Sun per-pixel shadow kept, screen-space contact shadows, highlights with area-light maths and cache visibility. Both renderers. |
| 42.8 | **Reflections.** Screen-space rays on the depth pyramid, tracer fallback reading the cache, rough surfaces from probes, glossy at quarter resolution. |
| 42.9 | **Temporal upscaling.** Motion vectors from every material kind, `TAAUNode` at the render scale with dynamic resolution, ghosting checks on moving characters, foliage in wind and particles. |
| 42.9b | **Adaptive probe placement** (owner, 2026-10-26). Probes dense near geometry and sparse in open space: bricks subdivided by geometry (Unity APV-style) from the occupancy the tracer already holds for blocks, terrain and model bricks; invalid probes (inside geometry, behind walls) moved or dropped; a sparse lookup structure the shaders read; probes over terrain near the eye, with the surface cache's rings. Fixes D342 and D343. Runs before 42.10 because 42.10 fixes the saved probe format and the shaders' probe lookup. |
| 42.10 | **One bake.** "Bake lighting" runs the system to settled and saves cache pages and probes. WebGL 2 and exports draw them. `lightmap-baker.ts` and `probe-bake.ts` removed. An upgrade marks old bakes stale; they draw until rebaked. |
| 42.11 | **Quality tiers.** Low, medium and high in the quality levels, with per-tier budgets, chosen per device. `ctx` access for the tier and the settled state. |
| 42.12 | **Editor.** Live lighting in the Scene view, debug views (cache texels, probes, rooms and portals, stale pages, ms per pass), and the Lighting window settings. One step in an existing e2e. |
| 42.13 | **Performance to target** on village, landscape and the interior class, medium tier, Iris Xe, 1080p output at the 60 Hz cap: frame p95 ≤ 16.7 ms, the §2 budget table, and low tier on WebGL 2 no slower than before the phase. High tier measured on a discrete GPU if one is available, otherwise unverified. |
| 42.14 | **The manual:** the lighting model (what is cached, what is per pixel), light kinds including `area`, emissive lighting, rooms and portals for lighting, tiers and budgets, baking, and what the design does not cover. |
| 42.15 | **Acceptance.** In a real browser on both renderers at 1920×1080, at the cap: the four look scenes, a lamp switched in a closed room (no light outside), time of day running, a block dug out live, and a character walking through all of them. Screenshots and a short capture to `~/.cache/thirdlight-phase42/acceptance`. Owner look pending; the owner judges the look. Full gate, then the phase review, then the merge to `main`. |
| 42.16 | **Review fixes.** |

**Done when:**

- Every static surface is lit by one cache, with direct light from every light
  kind, soft shadows, bounced light and emissive light.
- Reflections read the same cache.
- No light leaks through a closed generated-room wall (pixels).
- A changed light or edited block updates its lighting live within the §2
  budget on the Iris Xe.
- WebGL 2 draws the saved result of the same system, and only one baker
  remains.
- The medium tier meets 42.13 at the 60 Hz cap.
- `tools/gate.sh full --both-renderers` is green and the branch is merged.

## 4. Progress

| Item | Status |
|---|---|
| 42.0 | Done 2026-10-26. three: 0.186.1 pinned is npm's latest (2026-09-24): no patch or minor to take. Baseline at the 60 Hz cap, Iris Xe, 1080p (one round, load 1.1–1.7): village / landscape / interior (40 rooms, doors) p95 16.7/16.7/16.7 WebGPU and 16.7/16.7/16.8 WebGL 2, 0 missed everywhere; WebGPU GPU at full clock 5.27 / 10.59 / 8.75 ms (scene pass 2.9 / 6.7 / 5.0 raw, SSAO 1.35 / 0.92 / 1.75, sun shadow 0.12–0.23, interior spot shadows 0.37); main CPU 5.0 / 4.0 / 3.3 (WebGPU), 4.5 / 3.8 / 2.7 ms (WebGL 2). Bakes: village probes 8,712 in 114 s; look scenes lightmap preview 0.2–1.2 s, probes 0.2–7.5 s. Look-reference scenes added (`node tools/perf/run.mjs look [--no-bake]`, tools/perf/look.ts: door, sunset, corridor with soft-spot and point-row stand-ins for rect and line lights, emissive sign at night): 0 missed, GPU 3.6–5.9 ms full clock; "before" shots looked at, `acceptance/42.0-{realtime,baked}-*` (no bounce in the door room, emissive lights nothing, baked sunset and corridor broken: D333). WebGPU on the Iris Xe (`run.mjs gpu-features`): timestamp-query, float32-filterable and -blendable, subgroups, shader-f16, read-write storage textures (r32float, r32uint, rgba8unorm, rgba16float, rgba32float, r16float, r8unorm, rgba8uint; not rg32float, rg16float, rg11b10ufloat, rgb10a2unorm); limits: 16 storage buffers per stage (default 8: the renderer asks no limits), 4 storage textures per stage, workgroups 1024 invocations, 48 KiB shared. Fixed on the way: the interior level class no longer sends an empty `setSettings` (refused). Details: `~/.cache/thirdlight-phase42/baseline.md`. No e2e file touched. |
| 42.1 | **GO** 2026-10-26. Spike (`node tools/perf/run.mjs cache-spike`, tools/perf/cache-spike-*.ts, export-side only, no product code): the door room plus a ceiling rect lamp (1.2 × 0.6 m), a pillar and 128 m of hilly terrain; rays traced per cache texel through the block grid (DDA over occupancy bits decoded from the export's binary chunks) and the terrain (max-pyramid march over the decoded height tiles); one rgba16float slot of 12 × 12 texels (10 cm inside the margin) per visible cell face, read by the block material as its lightMap; sun (8 rays over a 0.02 rad disc) + rect (16 rays over its area), soft shadows from both seen in `acceptance/42.1-door-{sun-only,lamp,lamp-64rays}-webgpu.jpg` (looked at). Iris Xe, 1080p, 60 Hz cap, 3 rounds, GPU at 770–1060 MHz of 1,400 (full clock = ms × clock ÷ 1,400): (a) lamp switched (326 faces, 47k texels): 16k texels/frame → settled 62–77 ms in 3 frames, ≤ 0.88 ms raw / 0.55 full clock a frame; 32k → 46–59 ms in 2 frames, ≤ 1.28 / 0.77; 4k → 218–223 ms, ≤ 0.44 / 0.26; sun moved (whole layer, 1,582 faces, 228k texels): 32k/frame → 142 ms in 7 frames, ≤ 1.3 / 0.79; 0 missed frames in every re-light, settled p95 16.7 ms. (b) same texels and rays in random order vs grouped by kind, facing and slot: blocks 68 vs 19 ns/texel (3.6×), terrain 37 vs 17 (2.1×), both mixed 76–83 vs 18 (4.3×). 64 rect + 16 sun rays cost 86–91 ns/texel (2.8× of 16 + 8) with no visible gain in this room. (c) 1,152 B per m² of block face (8 B × 144 texels); the whole layer 1.8 MB, the room 0.37 MB; terrain dense 800 / 128 / 32 / 8 MB per km² at 10 / 25 / 50 / 100 cm, rings of 512² texels (10 cm doubling per ring, 7 rings to 3.3 km) 14 MiB per view whatever the world's size; proposed medium budget 64 MiB fits (decision log). Reports `~/.cache/thirdlight-perf/reports/cache-spike-2026-10-26T05-3*.json`. Unverified: WebGL 2 (not in the spike), bounce, larger layers' longer rays. No e2e file touched. |
| 42.2 | Done 2026-10-26. One tracer in three-adapter (`tracer-*.ts`: one packed scene buffer, a WebGPU compute pass on 3 storage bindings, and a CPU twin over the same words) answers hit distance, normal and cache address (cell + face; terrain cell + place; box + face uv; triangle barycentrics; model instance + field position) for block layers (DDA over 16³ chunks, empty chunks stepped whole), terrain (min/max pyramid over the heights, the render's two triangles per cell), generated architecture (its collider boxes with their profile's thickness, floors and roofs as triangles, in a uniform grid) and imported static models (distance-field bricks, `project-model` `distance-bricks*.ts`: made right after import by a backend hook, kept in the import cache under the model file's digest, shipped as buffers on the model's catalog row only for models placed static; starter character 4,796 tris → 19 KB in 136 ms, props 768–9,216 tris → 34–54 KB in 54–296 ms). Fixed step budgets per kind; unfinished rays resume. Vitest: tracer vs brute force for all four kinds (6 tests), the bricks import→cache→export path over a real backend, the game's verified bricks read. GPU (`node tools/perf/run.mjs tracer`, Iris Xe, 60 Hz cap, 131,072 lighting rays a pass — half sun disc, half 48 m hemisphere — random vs grouped passes taking turns, 1 round of 40 passes each): blocks town 8.73 → 6.10 ms (1.43×), terrain 512 m 7.03 → 5.28 (1.33×), blocks + terrain 8.01 → 5.48 (1.46×), 36 generated buildings 11.11 → 4.75 (2.34×), 400 placed models 12.45 → 7.20 (1.73×), i.e. 36–55 ns a ray grouped at the GPU's 300–913 MHz (≈ 9–36 ns at full clock, scaled linearly from the floor clock: an estimate); GPU = CPU on every ray but 68 of 131,072 brick rays (0.05 %, sphere tracing in f32). Scene memory: 124 KB for the 96 m block town, 3.85 MB for 0.26 km² of 1 m terrain, 53 KB for the district, 202 KB for the 400 models. Missed: 32k texels × 24 rays a frame of these open scenes' long rays is ≈ 8 ms, not ≤ 1.5 ms (the spike's closed room cost 0.8 ns a ray): cause and follow-ups in the decision log. Unverified: WebGL 2 (no compute; the low tier is baked). No e2e file touched. |
| 42.3 | Done 2026-10-26. Fast gate green (lights + block-lightmaps e2e, 33 passed in 2.9 min; village at the cap 0 missed, main CPU 4.96 / 4.72 ms WebGPU / WebGL 2). One surface cache in three-adapter (`surface-cache*.ts`): block faces as greedy rectangles of coplanar visible faces per chunk column (the room's chunk: 300+ faces in under a quarter as many charts), terrain in rings of 512² texels from 10 cm (7 rings, 14 MiB, to ~1.5 km), generated architecture in plane charts from its own collider pieces, static models in their UV1 square or on surfels spread at import (`project-model` `surfels.ts`, in the bricks file, format v2: starter character 1,116 surfels, file 19 → 28 KB, 0.17 s). Atlas of 256² rgba16float pages in buddy blocks (8 texels to a page); tiles resident round the eye at levels 10 cm … 3.2 m by distance (level 0 to 12 m, doubling), coarser then let go farthest first when full; budget `surfaceCacheMiB` per quality level (low/medium/high 32/64/128; terrain rings ≤ ¼). A traced hit resolves to its texel or null (not resident). Vitest: every face texel unique, 6,000 traced hits on all four kinds resolve with no shared texel across surfaces, atlas never overlaps, residency within budget over a 14 km move (2,000 tiles decided ≤ a few ms), surfel coverage per level, host feeding from a real grid. Browser (Iris Xe, WebGPU, 60 Hz cap, 1 round each, load 2.2–3.5): village with the camera flying a 30 m loop (`village --flight 30`): 666 tiles resident, 12.0 MiB (peak 13.6) of 128, levels 67/150/388/61/0/0, 5,184 taken and 4,518 re-levelled on the way, decision 0.5 ms, p95 16.8 ms, main 5.81 ms (flying; the still baseline is 5.02); landscape `--flight` (400 m loop): 14.9 MiB of 128 (rings 7 = 14 MiB), at quality=low 8.9 of 32 (4 rings), 0 missed of 3,600, main 3.77 ms (baseline 3.99). No GPU memory yet: the atlas texture is made by the first pass that writes it (42.5); diagnostics count the bytes the resident pages take. No e2e file touched. |
| 42.4 | Done 2026-10-26. Fast gate green (lights, scene-lights, block-lightmaps e2e, 34 passed in 2.9 min; village at the cap 0 missed, main CPU 5.02 / 4.73 ms WebGPU / WebGL 2; one run's rendering.e2e export 400 passed on rerun, D319). Change tracking in three-adapter: `surface-relight.ts` (units: resident block/architecture charts in squares of ≤ 64² texels with their plane, model tiles, terrain ring patches of 64² texels cut to the terrain; stale nearest the eye first, a unit's distance halving every 30 frames it waits; settled = nothing stale, then a frame does no work; diagnostics `renderer.surfaceCache.relight`: live, settled, stale pages/texels, budget and GPU ms used, texels a frame, ms per 1,000 texels, last change's time and frames to settle) and `surface-changes.ts` (lights switched/recoloured ≥ 2 %/moved ≥ 1 cm mark their reach sphere, flat units behind the light left; the sun marks all once it turns 0.5°; geometry the host sees change — block chunks built again (commands and live/scripted edits alike), terrain tiles with new heights or holes, architecture, static objects moved — marks itself ± the bounce reach, the lights touching it and its shadow's sweep from the sun; probes listen through `onStale`). Budget in GPU ms per quality level, new `surfaceLightMs` (low/medium/high 0/1.5/3; 0 and WebGL 2: saved light only), the count following the timestamped cost (start 32k texels, 1k–256k). Tracer cuts: one block DDA loop stepping the largest empty node (chunk, 4³ sub-block, cell) inside the layer's occupied box; bounce rays capped at 2 × the probe spacing (`bounceRayMetres`); models marched only over each grid cell's span with brick steps shared per ray. GPU hit→texel resolve (`surface-resolve*.ts`: one word table, WGSL pass, CPU twin = CPU addressing on 6,000 hits of all four kinds, f32 neighbours < 0.2 %; GPU = twin on 65,536 hits but 1 (door) and 5 (village)). The update pass (`surface-light-pass.ts`: texel points on their surfaces → sun 8 / point-spot 4 rays a texel, halved a cache level → tracer → irradiance, three passes timestamped) runs in `node tools/perf/run.mjs relight`; the page wires only the tracking and diagnostics (no live pass until the cache is drawn). Iris Xe, 60 Hz cap, 3 rounds, 6 ms stand-in frame load, GPU at its 300–330 MHz floor (load 1.0–1.6): door lamp switch marks 132k texels, the room's texels lit in 301–384 ms (17–22 frames), all settled in 385–535 ms, GPU 1.36–1.52 ms median, ≤ 4.98 ms max a frame (≈ 0.34–1.07 at full clock), 0 missed, main 1.0–1.5 ms; village sun step: 1.19 M texels settled in 18.7–18.8 s (1,121–1,128 frames) at 3.3–3.7 ms a frame, over the 1.5 ms budget (D334: brick shadow rays' latency floor; the block ground alone 522k texels in 1.0 s within budget); still: 0 frames of work in 30. Missed: the lamp's ≤ 250 ms at the floor clock (≈ 65–85 ms scaled to full clock: an estimate); village over budget. Vitest: every change path marks exactly what the rules give (host over a real `BlockGrid`, `TerrainField`, bricks), nearest-first and aging, settled timing, budget adaptation, facing cull, texel points round-trip to their texels (blocks exact; arch D335). Tracer bench (`run.mjs tracer`, 1 round each): grouped blocks 46.6 → 37.5 ns/ray at 48 m bounce (~10 % at equal clock), and with the 4 m cap blocks/terrain/mixed/arch/bricks ≈ −14/−32/−32/−36/−37 % clock-normalized. No e2e file touched. |
| 42.5 | Done 2026-10-26. Fast gate green (lights, scene-lights, block-lightmaps e2e, 34 passed in 3.0 min, was 2.9: the area light's Inspector step; village at the cap 0 missed, main CPU 4.93 / 4.78 ms WebGPU / WebGL 2; `scan-bounded-log.test.ts` failed once in the run, passed alone: D307 watch). First D334: models' distance samples in a 3D brick atlas (one filtered sample a step), an instance marched once from the cell its box is entered in, shadow rays any-hit with a cone of half the sun's disc, surfel points a voxel off their mesh: `tracer --rays 8192 --kinds bricks` 1.92 → 1.07–1.17 ms; village sun step (3 rounds, 60 Hz cap, 6 ms stand-in load, GPU 516 MHz avg of 1,400) settles in 2.45 s (was 18.8 s), frame GPU median 3.2–4.4 ms raw (≈ 1.2–1.6 ms at full clock, an estimate), 0 missed: over 1.5 ms raw, any run costs 1.3–2 ms at the floor clock (D334 left open). Direct light (`surface-light-{frame,wgsl,cpu,runtime}.ts`, `adapter-surface-light.ts`): sun, point, spot, the new `area` light (rect or line, size, one- or two-sided, rays in strata) and static glowing boxes (faces as rect lights) with traced soft shadows, shadows off, light masks per unit and shadow caster masks per ray; every light the scene holds (past the per-pixel cap, baked, area); on a WebGPU page with `surfaceLightMs` > 0 the pass runs on the renderer's device into the atlas (2D array of 256² rgba16float pages, as many as the budget) and the ring textures, a frame's rays held to the budget (≥ 64 k rays) in runs within a binding, the rest handed back; `?surfaceCacheView=1` draws the lit texels. `area` light in project-model (additive on 8), Inspector, menus, Scene view outline, MCP docs and the manual; baked and area lights left out of the per-pixel cap. Door lamp now a 1.2 × 0.6 m rect (16 rays): the room re-lit in 618–619 ms (36 frames) at 300–323 MHz (≈ 140 ms at full clock, an estimate), frame median 1.9–2.3 ms raw; lamp off 217 ms; GPU = CPU twin within 2 % on 1,365 of 1,365 (door) and 2,113 of 2,114 (village) lit texels. Vitest: each light kind vs closed forms and quadrature (sun, point, spot, rect one/two-sided, line), soft-shadow umbra/penumbra, shadows off, caster masks, light layers, frames split by rays, hand-back, texel addresses, shadow rays vs exact. Look scenes in the cache view (WebGPU, realtime, 0 missed, p95 16.7): `acceptance/42.5-{door,sunset,corridor,sign}-cache-view-webgpu.jpg` looked at (corridor's rect and line lights smooth after strata; door: sun only, no bounce yet). Unverified: the sign's light on the ground reads faint (units checked, owner's eyes); WebGL 2 (no live light). D337, D338 open. |
| 42.6 | Done 2026-10-26. Fast gate green (lights, scene-lights, block-lightmaps, layered-material e2e, 35 passed in 3.4 min; layered-material (auto) 1.1 → 1.6 min: its picture comparisons wait for the live light and probes to settle, D344; memory peak 5.0 GB of the 5 GB cap; village at the cap 0 missed, main CPU 5.95 / 4.97 ms WebGPU / WebGL 2; earlier runs found two bugs, fixed: stale room indices looped the shaders until the device was lost, and the probe light on every WebGPU page). Bounce: live probes (`surface-probes.ts`, `surface-probe-{wgsl,pass,cpu,sky}.ts`, `adapter-live-probes.ts`) where a probe bake puts them (a grid per generated room first, then over the static objects' bounds snapped to 16 m); a stale probe casts 64 turned Fibonacci + 6 axis rays, reads the hit's cache texel (GPU resolve) plus the probes' own light there (multi-bounce over updates, albedo 0.3) and the sky where nothing is hit (three's own environment diffuse, a sun in it held down, plus probe-held ambient/hemisphere); one workgroup a probe and a commit pass; the live grids stand in for baked tiles in the probe lighting (moving objects, foliage, ground cover read them; tiles written a probe at a time). Rooms (`surface-rooms.ts`, `RoomCulling.lighting()`): a lamp in rooms its open portals keep from the outside lights only them (texels tested per room in the light pass; door pieces do not stop rays), its marks cut to its rooms plus a frustum through open exits; probe rays end at their room's boundary unless leaving by an open portal and never pass a shut doorway. Modes: `savedLights` for 42.10. Iris Xe, 60 Hz cap, 6 ms stand-in load, GPU 300–310 MHz of 1,400 (`run.mjs relight --rooms`, 3 rounds, load 1.4–1.9): door lamp on: direct light settled 384–385 ms (room's texels 268–270 ms; ≈ 83 ms at full clock, an estimate), 171–178 k texels (no rooms 834 ms, 400 k; door shut 251 ms, 115 k); lamp off 152 ms; frame GPU ≤ 2.69 ms raw (0.59 full clock), 0 missed; probe update 0.71–0.72 ms raw median for 64 probes (0.16 full clock), ≤ 1.65 (0.36); the door's 2,701 probes settle in 4.1–4.3 s (D342); village 15,129 probes, 3.8–4.7 ms an update raw (1.2–1.5 full clock: brick rays, D334), not settled in 20 s after a sun step (D342). GPU = CPU twin: village 218 of 218 probes (0.02 %), door 134–139 of 256 within 5 % (D341). Leak (`run.mjs look --scenes shut-off,shut-on,open-on`, WebGPU live): lamp on behind a shut generated door: 0.06 % of pixels brighter by > 8 of 255 (the 10 cm gap over the door piece, C's wall seen directly), door gone 5.0 %; shots looked at. Vitest: portal exit and traversal, the leak both ways (direct and probes), frustum marks, enclosure convergence to ρE₀/(1−ρ) within 3 %, sky, settle, selection, modes. Looked at: `acceptance/42.6-cache-view-{door,sunset,corridor,sign}-webgpu.jpg` (door: bounce from the sunlit patch and the doorway's sky; corridor: bright, a closed corridor's light builds up; sign: no probes over terrain, no bounce, D343; sunset: washed out, D339) and the door's probes view (out-of-room probes drawn through walls). Unverified: the look (owner's eyes), WebGL 2 (no live light; the saved result is 42.10). e2e time unchanged (no e2e file touched).
| 42.7a | **Partial** 2026-10-26 (7de92a87, 4debf2c0, 4d370f26, cbb77181; the next agent finishes it). Fast gate green (lights, scene-lights, block-lightmaps, layered-material e2e, 35 passed in 3.5 min, was 3.4; layered-material (auto) 1.6 → 1.7 min: its lit-rooms step now checks the rooms read the cache and drew their colours; one run's `drawBuilding` timeout passed on rerun, D349 watch; memory peak 5.3 GB at a 6 GB cap; village at the cap 0 missed, main CPU 6.86 / 4.97 ms WebGPU / WebGL 2). Done: on WebGPU with the live light, block layers (any block geometry, by its cell and face), terrain (its rings) and generated architecture (its plane charts) read their diffuse light from the cache through every node material kind (standard, Lambert, graph, layered, custom-lit into its `direct` term) by a per-draw material variant (`surface-cache-read.ts`, the local-light variant hook), one filtered lookup found from the pixel's world position and normal (`surface-cache-lookup.ts`, CPU twin = CPU addressing on 6,000 traced hits of the three kinds); the sun stays per pixel (texel alpha = 1 + the sun's share, taken back out), local lights keep highlights, probes give bounce, a pixel with no texel keeps its per-pixel lights, a surface with a saved lightmap keeps it, WebGL 2 and `surfaceLightMs` 0 draw as before. Real albedo (D340 updated): reading draws write their colour beside the cache one frame in 30, the probes bounce it. Iris Xe, 60 Hz cap: look scenes 0 missed, p95 16.7–16.8 (shots `acceptance/42.7-{door,corridor,sunset,sign}-webgpu.jpg`, looked at: the corridor's walls and floor now show the rect lamps' pools and the line light's blue spill, the sign lights the ground teal, door unchanged (sun only), sunset still washed out, D339); village (4 rounds A/B `?surfaceRead=0`, GPU 788–1,387 MHz) scene pass +0.8–0.9 ms full-clock estimate, the lookup ~0.7–0.8 of it (target ≤ 0.3 over a lightmap lookup: missed, D345), main thread +0.15–0.3 ms with reading (6.05–6.17 against 5.86–5.91; the gate's 6.86 against 42.6's 5.95 is not explained by reading alone); interior +2.2 ms scene pass at 1,400 MHz (D345); landscape ~1 fps on and off and on the 42.6 tip (D346: traced scene over the binding size, repacked while chunks stream; partly eased here). Left for 42.7a: static models (UV1 squares, surfels; their tiles exist only in built games) do not read the cache (needs a per-instance tile id: float 11 of the instance columns, a per-object uniform, a merged-cell attribute; then UV1 lookup per pixel, surfels per vertex); static boxes (D347); the lookup's cost (D345); an e2e pixel check of a cache-lit surface against `?surfaceRead=0` (the lit-rooms step checks reading and colours, not pixels against no reading); the reading's WebGL 2 path is untouched by design (unverified there beyond the gate's village run). Unverified: the look (owner's eyes). |
| 42.7c | Done 2026-10-26 (12012cfa; D346 fixed, D350 opened). Cause measured by a main-thread profile (landscape, WebGPU live, 60 Hz cap): 1.1 fps, 1,055 ms a frame, ~90 % packing the whole 3,072² heightfield (138 MB, over the 128 MiB binding) every frame while tiles arrived. Fix: terrain traced in rings round the eye (`tracer-terrain-rings.ts`), the scene packed by section within the binding size (`tracer-scene-packer.ts`, dirty ranges uploaded), probe planning ordered once per 8 updates, the lookup table grown into a new texture (its "destroyed texture" error every frame gone). Iris Xe, 60 Hz cap, 1 round each, GPU 1,400 MHz, load 3–5.5 (uptime 3 d): landscape 56.5 fps, p95 33.3 ms, main 5.19 ms (42.0: 4.0), render passes 15.7 ms full clock (scene 10.4); `?surfaceRead=0` 60 fps p95 16.7, main 5.23 — the cap missed on the GPU (D350, D345); interior p95 16.7 (main 4.14, GPU 14.6; read off 4.02 / 12.3); village p95 16.7, 0 missed, main 6.19 (export run) / 6.0 (gate; 42.7a 6.86, 42.6 5.95): the 42.7a rise was mostly probe planning (0.6 ms a frame on the landscape, scanning every stale probe each update); the rest of the village's rise over 42.5 is three's draw work with the live light and probes on (unchanged here). Vitest (`tracer-terrain-rings.test.ts`, 4; a probes test): rings trace exactly as the whole field near the eye and meet far ground within their cells, every ring's hits resolve to the terrain's texel on the GPU twin as on the CPU, a 16 km field's scene < 32 MiB and within the binding, a ring move or block change writes only its own section (copy < 50 ms), rings made over calls of ≤ 15 ms with 1 ms budgets, a scene over the binding not packed; probes nearest-stale picked from the kept ordering. Fast gate green (lights, block-lightmaps, layered-material e2e, 34 passed in 3.5 min, unchanged; village at the cap 0 missed, main CPU 6.0 / 5.13 ms WebGPU / WebGL 2; memory peak 5.7 GB at a 6 GB cap; D307 failed once, passed alone). No e2e file touched. Unverified: the look of terrain shadows past ring 0 (owner's eyes). |
| 42.7d | **Partial** 2026-10-26 (7c5df68f, and the commit after it; the next agent finishes it). Static models read the cache on WebGPU live: a copy carries its object's slot (instance column float 11, a merged cell's vertex attribute, the object's own uniform), the slot's fixed record holds the placement and its piece; a UV1 piece reads its UV1 square (now lit at the surfel nearest each texel's UV1), a surfel piece the surfel of the pixel's cell and facing in two-bucket hashes, no loop (loops bounded by texels stalled the Iris Xe, D352); their colours feed the bounce (D340 fixed). Lookup costs: table reads without three's uv transform (each read had cost a uniform, a mat3 multiply and a CPU matrix update), architecture charts listed by facing, the first terrain's rings as uniforms. Iris Xe, 60 Hz cap, scene pass with reading against `?surfaceRead=0` (1 round each; target ≤ 0.3 ms over a lightmap lookup: missed, D345): interior +2.0 ms at 1,400 MHz (9.80 against 7.79; blocks, terrain and architecture alone +1.76; 42.7a +2.2 without models), p95 16.7, 59.8 fps; landscape terrain alone +0.61 (42.7a +1.75 for all), all kinds +2.3 (11.13 against 8.78), p95 33.3 (D350); village +0.6–1.6 scaled to full clock (GPU 1,040–1,350 MHz: noisy), blocks alone +0.6, p95 16.7, 0 missed. Main thread: village 7.9–8.1 ms with models reading against 5.8–5.9 off and 6.3–6.6 with blocks alone (D351); interior 4.6 against 4.2. Vitest: a model pixel's lookup against surfels in its cell (< 5 % misses, < 1 % a neighbour cell) and UV1 places, the slot sources' programs, slots kept and used again. Fast gate green (lights, block-lightmaps, layered-material e2e, 34 passed in 3.4 min, unchanged; layered-material's furnishing-panel step failed once, passed on rerun, D349; vitest `scan-bounded-log` failed once, passed alone, D307; memory peak 4.7 GB at a 6 GB cap; its village perf check did not run after the rerun: village at the cap measured by hand, 60 fps, p95 16.7). No e2e file touched (e2e time unchanged). Left: the e2e pixel check against `?surfaceRead=0` (a cache-only light — an area light or glowing box — is the robust signal: point lights read alike either way); static boxes (D347: traced and read as one-box architecture worked, but changed block-lightmaps' baseline look before a bake, so backed out); the look shots (`node tools/perf/run.mjs look` has no models: shots of the village are unverified); 3 rounds of the A/B; multi-piece models read their first piece only (D353). |

## 5. Decision log

- 2026-10-22: Planned from the owner's goal: Lumen-quality lighting
  (bounced light, reflections, soft direct shadows, area lights), accepting
  performance costs that buy quality and ease; an integrated-GPU tier with
  upscaling; WebGL 2 keeps baked lighting; built on a branch after phase 41.
  The design uses what the engine knows that Lumen must approximate: exact
  geometry (block grid, height tiles, architecture parameters), rooms and
  portals for leaks, and change tracking instead of tracing every frame. The
  bake becomes the same system saved. The relation to the planned lighting
  phase, UV1 for static models and moving objects' contribution are defaults
  for the owner to confirm (§1).
- 2026-10-22: Prior art folded in at the owner's request (§2): surfels became
  the default for static models without UV1; the spike also measures Intel
  divergence and cache memory; the storage-buffer cap is a design
  constraint; hash-grid probes and Split Radiance Cascades noted as later.
- 2026-10-22 (owner): the three defaults of §1 are confirmed: this phase
  absorbs the planned lighting phase except clustered lighting, which is its
  own item run inside this phase; surfels for static models without UV1;
  moving objects receive all lighting but don't block or bounce it. The phase
  runs in the current autonomous run after 41, on its branch, with 42.1's
  go/no-go as a hard stop.
- 2026-10-26 (42.0): Default chosen, owner to confirm: the corridor's rect and line lights are stood in by fully soft spots under emissive panels and a row of point lights along an emissive strip until `area` lights exist (42.5); the look scenes are run both realtime and baked (the browser bake only bakes `baked` lights). For 42.1: the renderer requests no device limits, so compute gets 8 storage buffers per stage, not the adapter's 16; only 4 storage textures per stage; rg11b10ufloat and rgb10a2unorm are not read-write, so the cache's read-write targets are r32float / rgba16float / rgba8unorm.
- 2026-10-26 (42.1): **GO.** One room re-lights in 46–77 ms at 0.5–0.8 ms a frame at full clock (target ≤ 250 ms at ≤ 1.5 ms), and the cache fits the budget below. Default chosen, owner to confirm: the medium tier's surface-cache budget is **64 MiB** (rgba16float): terrain rings 14 MiB, about 50 MiB of pages for blocks, architecture and models (≈ 45,000 m² at 10 cm, 4× that at 20 cm further away). Design adjustments from the spike: (1) work lists are always grouped by geometry kind, facing and page (random order cost 2–4× on the Iris Xe); (2) the per-frame budget is counted in texels and starts at 32k a frame on medium (small dispatches cost ~2× per texel: 46–48 ns at 4k against 21–25 ns at 16–32k); (3) 16 rect + 8 sun rays a texel on medium, more rays only on high (64 + 16 cost 2.8× with no visible gain in the door room); (4) 10 cm texels hold, but the fractional slot margin spends 31 % of texels on borders: coplanar faces should share pages (greedy rectangles) with a one-texel border; (5) per-texel results may be packed as rgb9e5 in r32uint (read-write on this GPU) to halve memory if the budget is tight; (6) the spike's single-level DDA crossed a 24 × 8 × 24 grid; larger layers need a chunk-level skip (empty chunks stepped whole) in 42.2; (7) the default device limits sufficed (4 of 8 storage buffers, 2 of 4 storage textures), so the renderer need not ask for the adapter's limits yet. The block material read the cache through its existing lightMap input (UV1 moved onto the atlas tiles): the lookup costs exactly a lightmap lookup.
- 2026-10-26 (42.2): Default chosen, owner to confirm: (1) the tracer is three-adapter's (`tracer-*.ts`), one scene buffer of words for all kinds so the pass stays at 3 storage bindings under the default limits (the renderer still asks the adapter for nothing); (2) a block stops light when its type fills its cell (`blockTypeSolid`, the rule that hides neighbours' faces); half blocks, ramps, stairs, custom shapes, multi-cell pieces and edge pieces let rays through, and sloped tops count as full cells; (3) terrain is exact as the finest render level draws it (two triangles per cell), holes and unloaded tiles open; (4) generated architecture is traced as its colliders are made (boxes per wall run with the profile's thickness, cut round openings; floors and roofs as triangles), its kit copies as models; (5) bricks: sample spacing ≥ 32 and ≤ 128 to the longest side, else 10 cm, ±2 voxels in a byte, 8³-cell bricks, one set per top-level piece, sign from pseudo-normals with the interior flooded from outside (a mesh with holes reads as a shell); made right after `importAssets` / `publishAsset` of a model, kept in the import cache by the model file's digest (a build makes missing ones, e.g. for models imported before today), shipped only for models placed static and architecture's kit copies, as buffers on the model's catalog row (`bricks`); (6) fixed step budgets per pass (blocks 384, terrain 256, grid cells 128, brick steps 96), a ray out of steps returns where to resume; (7) rays group by source kind, direction octant and a Morton code of the origin on a 1 m grid. Finding: in open scenes (a 96 m block town, 512 m of hills, a district) grouped rays cost 36–55 ns raw at the floor clock, 9–36 ns scaled to full clock, against 0.8 ns in the spike's closed room: sun rays cross the whole layer and 48 m bounce rays march far. A 32k-texel frame at 16 + 8 rays is then ≈ 8 ms. Follow-ups: 42.4 counts the per-frame budget in GPU ms from timestamps (not texels) so a frame stays within 1.5 ms whatever the rays cost; bounce rays shorten to the probe spacing (the probes give the far field, 42.6); a 4³ sub-chunk mask for blocks; the full-clock scaling is only an estimate while the governor holds the GPU at its 300 MHz floor in a bare page (42.13 measures inside the game's frame).
- 2026-10-26 (42.3): Default chosen, owner to confirm: (1) pages of 256² rgba16float texels (512 KiB) handed out in power-of-two blocks from 8 texels, a tile packed whole at one level; (2) levels: 10 cm to 12 m from the eye, doubling the texel each time the distance doubles, to 3.2 m; 10 % hysteresis; when the budget is full, farther tiles take coarser levels, then are left out; (3) the budget is the quality level's `surfaceCacheMiB` (16–2048; engine low/medium/high 32/64/128, a project level without it 64); terrain rings take at most a quarter of it; (4) a block face is visible when its cell holds a block and the neighbour does not stop light (the tracer's rule, so every hit has a chart; the mesher's finer profile rule is not copied); (5) architecture charts come from its generated pieces' planes (touching coplanar pieces share), not its render UVs, which are trim UVs that repeat; (6) every static model gets surfels at its brick voxel, one per occupied cell and facing, nested coarse to fine; UV1 models keep their light in a UV1 square sized by area (a tracer hit there finds its UV1 point from the nearest surfel); (7) a static model's tiles need its bricks file, so only built games (rows with `bricks`) feed models; the editor's Scene view gets them with 42.12; (8) the hit-to-texel resolve is CPU only (with tables shaped for upload); its WGSL twin comes with the first pass that reads it (42.5/42.6). Measured: in the village and landscape the budget never binds (peak 13.6 of 128 MiB, 8.9 of 32 at low); eviction under a full budget is checked in vitest only.
- 2026-10-26 (42.4): Default chosen, owner to confirm: (1) units of work are resident block and architecture charts cut into squares of 64² texels (6.4 m at 10 cm) with their plane, a model tile's surfels as one, terrain ring patches of 64² texels (patches wholly inside the finer ring are not lit); (2) nearest the eye first, a waiting unit's distance halving every 30 frames, a unit marked again starts over and waits from then; (3) a light marks the units within its reach (its range, else where its intensity falls below 0.01) that face it; it changes when switched, ≥ 2 % in colour × intensity, moved ≥ 1 cm, or a spot turned 0.5°; the sun (and time of day) re-marks everything once it turns 0.5° or its colour changes 2 %; (4) geometry changes mark their box ± the bounce reach (2 × the probe spacing, 4 m), every light reaching them, and their shadow swept from the sun to the floor (sine ≥ 0.1); a chunk or object streamed in or out counts as a change, the first listing does not; terrain paint does not (it changes colour, not light), heights and holes do; (5) the budget is `surfaceLightMs` per quality level (low 0 = saved light only, medium 1.5, high 3; range 0–8), the texel count follows timestamped GPU ms (an average weighting each new frame ¼), starting at 32k texels, between 1k and 256k; without timestamps the count stays at its start; (6) the update casts 8 sun rays over a 0.02 rad disc and 4 per point or spot light over a 5 cm sphere, halved per cache level, unfinished rays counting as reaching the light; (7) the page runs the tracking and its diagnostics now, the update pass only once the cache is drawn by materials (until then it would light texels nobody reads); (8) the bounce/probe ray cap is 2 × the probe spacing; brick steps (256) are shared by all models a ray meets. Findings: a closed room's lamp marks 132k texels of which the room holds about a sixth — walls stop the light but not the marks; rooms and portals (42.6) are what cuts the rest. Brick shadow rays have a latency floor per dispatch (D334).

- 2026-10-26 (42.5): Default chosen, owner to confirm: (1) an `area` light faces its object's local −Y, a rect lies in the local XZ plane (`width` along X, `height` along Z), a line runs along local X; its `intensity` is the whole light's candela along its facing (far away it lights like a point light of that intensity); a rect emits as a Lambertian panel, a line as isotropic elements (one-sided: only toward its facing half); `castShadow` defaults to true; its size scales with the object; (2) area lights are not drawn per pixel until materials read the cache (42.7), and the lightmap bake skips them; baked point and spot lights and area lights do not count toward `MAX_LOCAL_LIGHTS`; (3) the cache's lights are read from the entities every 250 ms (all of them), a light three draws from its three.js light every frame (scripts switch, dim and move it there); (4) a static box with an emissive `surface` lights the cache as one-sided rect lights over its faces (faces under 5 % of its largest left out), radiance × area as intensity; glowing models, blocks and trims later (D337); (5) rays a texel at level 0: sun 8, point/spot 4, area 16, halved a level; area rays in strata of a power-of-two grid, sun rays in sectors of its disc; (6) shadow rays: any hit, a model's field blocks within half the sun's disc (0.01 rad) × distance; (7) the cache's textures: a 2D array of 256² rgba16float pages (budget ÷ 512 KiB) and 512² ring layers, 7 per ring terrain; a texel holds irradiance (pixel diffuse = albedo × it ÷ π); (8) a frame's rays: at least 64 k (`MIN_PASS_RAYS`; smaller runs cost as much on the Iris Xe) and at most what the GPU budget fits by a per-ray cost average, in runs of ≤ 2 M rays (the default 128 MiB binding); `RELIGHT_MIN_TEXELS` 1,024 → 8,192 for the same reason; texels a frame's run did not reach are handed back to the scheduler; (9) the debug view (`?surfaceCacheView=1`) draws each lit texel as a square on its surface shaded as albedo 0.5; (10) models' distance samples are read with the hardware's trilinear filter (37 of 8,192 brick rays end differently from the CPU twin's exact maths, 0.45 %); (11) a surfel's point stands a voxel of its model's field off the mesh (its own field read inside within a voxel). Findings: the village's sun step cost was not the brick march alone: a run of 8 k rays costs as much as one of 64 k at the floor clock, so the minimum run, not the per-ray cost, sets the settle time; scalar-to-vec4 loads of the scene words made the tracer slower on the Iris Xe (reverted).
- 2026-10-26 (42.6): Default chosen, owner to confirm: (1) cache texels hold direct light only; their bounce is read from their room's probes where the cache is read (the probes' rays at their hits, the debug view; materials in 42.7; the saved result in 42.10), as DDGI does, so a change of bounce re-traces no shadow rays and bounces build up through the probes reading probes; (2) probes stand where a probe bake puts them: a grid per room (inset 0.25 m) first, then grids over the static objects' bounds (block layers, architecture, models; not terrain or static boxes, as the bake) snapped out to 16 m; a probe of the outside's grids standing in a room is never lit; ray origins sit a millimetre off the lattice (lattice points fall on block faces); (3) an update casts 64 directions (a spherical Fibonacci set turned at random per probe and update) and 6 axis rays (walls), closest hit, rays 8 spacings long (16 m), a miss is sky; first-order SH (what the probe lighting draws); (4) bounces assume albedo 0.3 everywhere (the cache holds no surface colour, D340); (5) blend max(1/n, 0.25); a probe settles after 4 updates with < 5 % change or after 16, only once the cache's direct light is settled; noise does not spread to neighbours (it kept them stale for ever); (6) the probes' budget is a third of `surfaceLightMs` (medium 0.5 ms), at least 64 probes an update, 256 before any cost is measured, picked nearest first with the cache's aging; (7) a hit's indirect light is read from the first grid within 0.3 m of the hit lifted 0.3 m off its surface (a room's grid only for a point in that room), held inside it; (8) the sky: three's own environment diffuse (the map at roughness 1 × π) at 512 directions, each held to 3 × the mean of the darker nine tenths (a sun in the map), projected and turned back into radiance, plus the ambient and hemisphere lights the probes hold (baked or mixed), else the background colour; (9) rooms hold a light only when it stands in a room whose open portals do not reach the outside; a texel's room is that of its point lifted 5 cm along its normal among the rooms its unit's box touches (± 0.1 m); a probe ray ends 0.5 m past its room's boundary unless it leaves by an open opening, hole or open top, and no probe ray passes a shut doorway; a ray so held sees the probe's own light off the wall; (10) a lamp's marks: the units its rooms touch, and where its rooms open onto the outside, those inside a frustum from its sphere (an area light's half diagonal) through each such portal; probe marks keep the light's reach box (D342); (11) the live grids replace baked tiles while the light is live (WebGPU, `surfaceLightMs` > 0) and the scene has probes (the probe light joins then, before the frame's programs are built), a changed probe written into its tile with the walls of the probes before it, a tile uploaded at most every 200 ms per 256 KB; (12) light modes: live, every light lights the cache; the saved result (42.10) takes a `baked` light's direct light and bounce, a `mixed` light's bounce, a `realtime` light nothing (`savedLights`); (13) `?probesView=1` draws the live probes on a game page. Findings: the door's lamp marks fell from 400 k to 171–178 k texels with rooms (115 k with the door shut, where the lamp's room is all it lights); probe updates were latency-bound with a thread per probe (4.9 ms for 64 at the floor clock) and take 0.7 ms with a workgroup per probe; GPU sin and cos lose accuracy far from zero (the Fibonacci angle is kept within a turn).
- 2026-10-26 (42.7a): Default chosen, owner to confirm: (1) a pixel finds its cache texel from its world position and geometric normal alone (no per-object data, so merged cells, batches and shared materials need nothing of their own): a block pixel by its cell (its point 0.001 cell behind the face it faces) and face, terrain by the finest ring holding it one texel in from the edge, architecture by the plane charts crossing its 2 m world cell (within 5 cm of the plane, facing within 60°); (2) which draws read is per mesh (`SURFACE_READ_KEY`: block chunks, terrain pages, architecture chunks; the terrain's far macro ground not), in a scene lighting live, through a material variant per kind and page (programs shared, a scene without live light builds the programs it did); (3) the sun stays per pixel with its shadow map, so a texel's alpha carries the sun's share (1 + max(n·l, 0) × its rays' visibility; 0: not lit) and a reading pixel takes the sun's colour × that share back out; the probes and the debug view use the whole texel; (4) the cache's light goes into the direct diffuse light (never darkened by ambient occlusion); point and spot lights drawn per pixel keep their highlights, their diffuse light replaced by the cache's where a texel is found (blended by how much of the filtered lookup was lit), the effect pool's lights untouched; (5) bounce is the pixel's own probe lookup (the probes hold it, decision 42.6 (1)); (6) a surface whose material has a saved lightmap keeps drawing it until the scene is baked again (42.10); (7) atlas blocks newly handed to a tile are cleared (read as not lit until lit); (8) the surfaces' colours: reading draws write their diffuse colour (rgba8) into an atomic buffer at half the atlas's resolution and a quarter the rings', one frame in 30 (a writing draw loses early depth culling: written every frame it cost ~0.6 ms on the village), the probes' bounce reads it, 0.3 where nothing drew. Findings: the lookup texture's integer format given as `internalFormat` made three draw a 1 × 1 stand-in (nothing was found; lights looked right only through the probes); a texture made again under a new object left bind groups on the destroyed one, the same one let go and made again does not; the traced scene was made every frame while tiles arrived (the version was checked after making it).
- 2026-10-26 (42.7c): Default chosen, owner to confirm: (1) terrain is traced as a clipmap round the drawn eye: ring 0 holds the field's own samples 512 cells a side (`TRACE_RING_CELLS`), each next ring samples twice as far apart over a window twice as wide with the finer ring's cells open, until a ring holds every loaded tile (a 6 km field at 2 m: 4 rings, ~15 MB, was 138 MB; 16 km at 1 m: 7 rings under 32 MiB); far ground shades only as a coarser horizon; a coarse cell is open where a corner has no loaded tile or the base cell at its middle is a hole; (2) ring 0 moves when the eye is a quarter window (128 cells) from its centre, ring k when ring k−1 leaves it, windows snapped to their ring's grid; rings moved are made again a few rows a frame within `SURFACE_PREPARE_MS` (1 ms, the same budget as charts, spent again), the old rings traced until all new ones are made; (3) the traced scene is one storage buffer laid out by section (blocks, terrain, architecture and models) with a quarter room to grow each, a block layer or terrain ring packed once as an item and copied, only changed sections written and uploaded; its size is held within the device's `maxStorageBufferBindingSize` (the renderer still asks no limits, so 128 MiB): room to grow is given up first, a scene still over it is not packed (the last one stays traced, a console warning once) — a memory budget, no count; (4) live probe planning orders the stale probes once and picks the nearest stale among the kept 8 updates' worth for the next 8 updates while the eye stays within a probe spacing (a new mark orders again); (5) a lookup table that outgrows its texture moves to a new texture, the old one kept (not destroyed) until the cache textures go: three left bind groups on the disposed one. Findings: the 1 fps was the main thread packing the whole heightfield (its hole callback a string-keyed map lookup per cell) every frame while tiles arrived, not the GPU; with it gone the landscape is GPU-bound at the cap (D350).
- 2026-10-26 (42.7d): Default chosen, owner to confirm: (1) a static model copy finds its light by its object's slot (a small integer per placed object, used again once the object leaves; per-instance in batches, per-vertex in merged cells, a uniform for an object drawn alone), not from world position (overlapping props would read each other's light); (2) per pixel, not per vertex: a surfel piece reads the surfel of the pixel's cell and facing at the level the cache holds it at (one texel, unfiltered: light steps at the surfel spacing), the cell across the nearer boundary on a miss; a UV1 piece reads its square filtered at the pixel's UV1, the square's texels lit at the surfel nearest each texel's UV1 (texels off the unwrap left dark); (3) a model placed whole with several pieces reads its first piece only (the others keep per-pixel light and probes, D353); (4) surfel hashes are two-slot buckets, a cell in its home bucket or the next (rebuilt twice the size until every cell fits), so a pixel reads two texels and never loops; keys are a cell's place from the set's lowest cell, 10 bits an axis; (5) architecture charts are listed per world cell and per facing they face at least 0.25 (a cosine) of; (6) the first terrain's rings are uniforms; the lookup table is read through an untransformed texel node shared with the decals. Findings: three r186 gives a texture node cloned for a read (`load`, `sample`) a uv matrix uniform and a CPU matrix update per read and draw; on the Iris Xe a fragment loop whose count and exit come from texels ran to its bound (seconds a frame) in a program without side effects while the same program with a storage write (the colour capture) exited early — loops in reading programs are kept off texel counts; moving the reading's shared uniforms to the render group made the interior's blocks and architecture walk stall the same way, so they stay per draw.
- 2026-10-26 (owner, relayed from session thirdlight-45): (1) adaptive probe placement joins this phase as 42.9b, before 42.10 ("One bake"), since 42.10 fixes the saved probe format and the shaders' probe lookup; it fixes D342 and D343, and leaves the roadmap's Future list. (2) Clustered lighting leaves this phase and becomes phase 43 (`docs/plan-phase-43.md`): the 2026-10-22 decision made it "its own item inside 42", but no 42.x item was ever added. 42.7 is run as 42.7a (materials read the cache) and 42.7b (contact shadows, highlights).
