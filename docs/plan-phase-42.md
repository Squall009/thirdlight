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
| — | Not started. |

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
