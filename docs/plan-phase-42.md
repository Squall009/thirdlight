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
| 42.4 | Done 2026-10-26. Change tracking in three-adapter: `surface-relight.ts` (units: resident block/architecture charts in squares of ≤ 64² texels with their plane, model tiles, terrain ring patches of 64² texels cut to the terrain; stale nearest the eye first, a unit's distance halving every 30 frames it waits; settled = nothing stale, then a frame does no work; diagnostics `renderer.surfaceCache.relight`: live, settled, stale pages/texels, budget and GPU ms used, texels a frame, ms per 1,000 texels, last change's time and frames to settle) and `surface-changes.ts` (lights switched/recoloured ≥ 2 %/moved ≥ 1 cm mark their reach sphere, flat units behind the light left; the sun marks all once it turns 0.5°; geometry the host sees change — block chunks built again (commands and live/scripted edits alike), terrain tiles with new heights or holes, architecture, static objects moved — marks itself ± the bounce reach, the lights touching it and its shadow's sweep from the sun; probes listen through `onStale`). Budget in GPU ms per quality level, new `surfaceLightMs` (low/medium/high 0/1.5/3; 0 and WebGL 2: saved light only), the count following the timestamped cost (start 32k texels, 1k–256k). Tracer cuts: one block DDA loop stepping the largest empty node (chunk, 4³ sub-block, cell) inside the layer's occupied box; bounce rays capped at 2 × the probe spacing (`bounceRayMetres`); models marched only over each grid cell's span with brick steps shared per ray. GPU hit→texel resolve (`surface-resolve*.ts`: one word table, WGSL pass, CPU twin = CPU addressing on 6,000 hits of all four kinds, f32 neighbours < 0.2 %; GPU = twin on 65,536 hits but 1 (door) and 5 (village)). The update pass (`surface-light-pass.ts`: texel points on their surfaces → sun 8 / point-spot 4 rays a texel, halved a cache level → tracer → irradiance, three passes timestamped) runs in `node tools/perf/run.mjs relight`; the page wires only the tracking and diagnostics (no live pass until the cache is drawn). Iris Xe, 60 Hz cap, 3 rounds, 6 ms stand-in frame load, GPU at its 300–330 MHz floor (load 1.0–1.6): door lamp switch marks 132k texels, the room's texels lit in 301–384 ms (17–22 frames), all settled in 385–535 ms, GPU 1.36–1.52 ms median, ≤ 4.98 ms max a frame (≈ 0.34–1.07 at full clock), 0 missed, main 1.0–1.5 ms; village sun step: 1.19 M texels settled in 18.7–18.8 s (1,121–1,128 frames) at 3.3–3.7 ms a frame, over the 1.5 ms budget (D334: brick shadow rays' latency floor; the block ground alone 522k texels in 1.0 s within budget); still: 0 frames of work in 30. Missed: the lamp's ≤ 250 ms at the floor clock (≈ 65–85 ms scaled to full clock: an estimate); village over budget. Vitest: every change path marks exactly what the rules give (host over a real `BlockGrid`, `TerrainField`, bricks), nearest-first and aging, settled timing, budget adaptation, facing cull, texel points round-trip to their texels (blocks exact; arch D335). Tracer bench (`run.mjs tracer`, 1 round each): grouped blocks 46.6 → 37.5 ns/ray at 48 m bounce (~10 % at equal clock), and with the 4 m cap blocks/terrain/mixed/arch/bricks ≈ −14/−32/−32/−36/−37 % clock-normalized. No e2e file touched. |

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
