# The voxel engine as it stands

What is true now, in one place. Plans say what is being built and why; this page says what exists and what every
new system sits on. Owner decisions are in `docs/decisions/owner-decisions.md`; formats in
`voxel-format-spec.md`, `voxel-render-spec.md`, `voxel-role-spec.md`, `voxel-kit-format.md` and
`format-versions.md`; the order of work in `docs/roadmap.md`. When a phase changes something here, it edits this
page in the same commit.

## 1. Principles

- **Voxels are the single source of truth.** Terrain, buildings, water, fog, materials and physics are voxels;
  vegetation rules derive from the voxel and its material id. A system that needs world data derives it from
  voxels; it does not keep a second authored copy.
- **WebGPU is the renderer.** WebGL 2 is a fallback that keeps what it draws and has one smoke test.
- **Targets.** The floor GPU (Intel Iris Xe) runs the low tier at 720p with a temporal upscale (render scale
  about 0.667), capped at 30 Hz, in about 4 GB (page 1,536 MiB + GPU 2,560 MiB) of an 8 GB machine. Medium and
  high are unverified on target hardware. Travel up to 150 m/s is judged by hitches and by the settle after a
  stop; nothing falls through.
- **Generic capability only.** A game's behaviour lives in the game's repo.
- **Name the foundation first.** A new system says which shared foundation of §6 it sits on before it is built.

## 2. Data

- **Cell** 0.5 m; **chunk** 32³ cells (16 m), derived in 16³ sections; region files in 256 m tiles.
- **Record** (32 bits): material 12 bits, role 4 bits (10 of 16 assigned: air, terrain, liquid, wall, floor,
  roof, foundation, stair, pillar, opening), shape 4 bits (the fill for terrain, the fill level for liquid, the
  integrity for construction roles), wetness 3 bits, 9 reserved bits (two are held, unspent, for a vegetation
  density value).
- **Derived data is never stored**: meshes, collision, navigation, light coverage, occupancy, detail pieces are
  rebuilt in workers from voxels. The one stored derivative is the **far cache** (levels 2 and up of the mips,
  and baked bricks down to the world's bake level).
- **Edits** go through `editVoxels` strokes (set, dig, add, brush, fill, stamp). The project's one `undo` /
  `redo` steps scene edits and strokes on one line in the order they were made (workspace `undo-timeline.ts`,
  in the backend, per project); a stroke's undo and redo write back the records its world's undo store keeps
  (redo exact, the same byte budget); a stroke whose world dropped it is skipped and named.
- **Known limits to design around:** mips keep a non-solid cell only where no solid shares its parent, so shore
  water and ground fog vanish from the 2 m level up (far water and fog need a far-cache channel); `liquid` is
  excluded by scattered checks, not one predicate; a liquid edit re-derives mesh, collision, navigation and
  light until its feeds are narrowed; a brick cannot hold rule-built crisp geometry exactly.

## 3. Drawing, near to far

| Band | Drawn as | Built |
|---|---|---|
| The detail ring: level 0 to 64 m at medium, about 45 m at low; collision to 48 m (34 m at low) | the terrain mesher's surface and merged construction faces, kit detail pieces instanced across chunks, the voxel surface shader (triplanar texture sets, material blend, wetness) | workers, from resident voxels |
| Past it on a world baked to 2 m | level 1 meshes to 128 m and level 2 meshes to 192 m (the mesh rings), then bricks | workers, from voxels downsampled at run time |
| Past it on a world baked to 0.5 m or 1 m | baked fine bricks, textured as the near surface; the read ring ends at the detail reach | decoded from the far cache, nothing built |
| Finer than the bake, where a world asks for it (`fineBuild: compute`) | fine bricks built on the GPU | compute, from the chunks' voxel grids |
| To the horizon | bricks at 2 m and coarser, chosen by screen error (8 px low, 4 medium, 3 high) | the far cache |

- **Bricks**: 8³ cells with 9³ distance samples, 4³ bricks a node, a node 32³ cells of its level; two 3D
  atlases; drawn through a **visibility target** (brick id and depth) and **one deferred shade** with fog by
  the hit's depth; node boxes are rows of the **culled-instance table** (frustum and depth pyramid in compute,
  indirect draws); what is seen feeds back to what is built.
- **Bake level** per voxel world: 2 m (default), 1 m or 0.5 m; by region, resumable; exports ship what the level
  says. Measured on the 8 km test world: 355 MB at 2 m, 1.36 GB at 1 m, 5.0 GB at 0.5 m.
- **Relief displacement** is off on every tier and **detail-piece LODs** do not exist: both deferred by the
  owner. The **mesh far field** is a fallback behind a switch.
- **Lighting of voxels** is not built (46e): voxel surfaces cast no shadows in Play; far bricks carry baked
  occlusion.

## 4. Streaming

- A load ring around each focus (192 m by default; it ends at the detail reach on a world baked to its drawn
  level), a memory budget per tier (768 MiB at low), far GPU budget (384 MiB at low); both are entries of the one
  memory budget table (`MEMORY_BUDGET_BY_TIER`, §6 row 7).
- **At speed:** no level 0 is built, stale queued work is dropped, the far field carries the view; level 0
  returns from the camera outward when the focus stops.
- **Collision** is on its own path round moving bodies; a **coarse floor** from the 2 m data stops anything
  falling through when fine collision is late.
- Measured at 150 m/s on the low tier (export): longest frame 40–49 ms, ground solid 0.03 s after a stop, full
  detail 3.7–4.0 s on a world baked to 0.5 m.

## 5. Measuring

- Always at the display's cap; GPU timestamps are not usable there (D544). The **headroom meter** loads the
  frame until it misses and gives room and pass shares (`run.mjs headroom`); the **coverage bench** gives
  hitches, settle times and fall-throughs (`run.mjs coverage`).
- The **frame profile** (`window.__tlProfiler.read()` on a game page) gives each thread's CPU a frame (page,
  simulation worker, job workers) by budget category against the tier's budget, and the last long frames. It is
  shown in the editor's **Profiler** tab while Play runs, in the stats overlay (Shift+F3, Play and exports), saved
  as a capture file (`version: 1`) and read by agents as a digest (`tl_diagnostics` sections ['profile']).
- Gates run by affected area (`tools/gate.sh`, `tools/gate-areas.json`).

## 6. Shared foundations

| # | Foundation | Used by | State |
|---|---|---|---|
| 1 | Fields derived from voxels (height, slope, material, role, sky, water, fog, spline distance), one arithmetic for worker, shader and tests | vegetation rules, water, fog, `ctx.voxels`, far placement | 47b |
| 2 | Open-region labelling (a walk through connected non-solid cells) | rooms, cut-away, audio room size, stream priority, the water and fog fill, water bodies | 46e |
| 3 | Far-node side channels and one bake runner | far water, far fog, forest canopy, baked occlusion | 49; the runner exists (far cache) |
| 4 | Camera-following window helper | wind, interaction field, ripples, water info, fog density and simulation | exists: `three-adapter` `camera-window.ts` (`CameraWindow`, `WindowTargets`); the wind map (`wind-field.ts`, its sample public as `MaterialLibrary.windSample`) and the interaction field (`interaction-field.ts`: 256² × 0.25 m, every `interactor` stamped by one compute pass, read by foliage; WebGPU only) sit on it |
| 5 | Regenerated structures (a definition → voxels + overrides) | buildings, road and river splines, water bodies | 47a; `structure-overrides.ts` is a draft |
| 6 | One culled-instance table for every instanced draw | kit pieces, terrain and far nodes; stored copies (trees, rocks, instance sets); ground cover from point sets; impostors | exists (`occlusion-instances.ts`, on every occlusion path on WebGPU); stored copies and point-set ground cover (block layers, models, architecture floors: `cover-rows.ts`, a point expanded to a copy's 16 floats) are its rows (`copy-rows.ts`: level by the shared screen-size rule `lodLevelStep` with hysteresis and a cross-fade, thinning by rank or by the cover's share across the ground, frustum and depth pyramid, picked in compute). Not in it: terrain cover placed from heightfield texels (retires in 48); on WebGL 2 copies and point-set cover keep their vertex-stage paths |
| 7 | Budget table, profiler and frame arbiter | everything | exists: spans on every thread (`threadProfiler`, shared), `__tlProfiler.read()` on game pages, `FRAME_BUDGET_BY_TIER`, `frameSliceMs` (the arbiter is one table the 12 per-frame slices read their ms from; it does not sum them against the frame, hand unused time on or react to load, so slices can still add past a frame; left outside: block layers', heightfield terrain's and `STREAM_ARRIVAL_MS`, all retiring in 48); memory too: `MEMORY_BUDGET_BY_TIER` (every memory budget as an entry, summed against the tier's page and GPU target) and the resident-bytes report (`residentBytes` registries per thread, game-host `page-memory.ts`, the Profiler tab's Memory table); views and capture in game-host `profile-view.ts` / `profile-capture.ts`; editor Profiler tab (`editor/src/ui/profiler`), overlay Shift+F3, `tl_diagnostics` profile |
| 8 | One world edit mode on the brush kit, in the Scene view | sculpt, paint, fill, splines, rule preview | 47b; the brush kit exists |

Also shared already and to be reused, not rebuilt: the editor's brush settings, cursor, keys and panel; the
preview renderer; the node-graph canvas; asset pickers; the edit-mode shell; `paint-brush.ts`; the scatter rule
core (`scatter.ts`); the spline format and curve maths; the voxel `WorkerPool` and `job-queue`; `view-cull.ts`; the level-of-detail rule by screen size with hysteresis (`@thirdlight/shared` `lodLevelOf` / `lodLevelStep`, for the CPU and shaders; voxel rings keep their own);
`screen-history.ts`; `dither-fade.ts`; one buffer grow (`@thirdlight/shared` `grownCapacity` / `grownArray`;
`grownGpuBuffer` for raw GPU scratch buffers); one region-texture helper for a texture three owns (`region-texture.ts`:
partial upload, grow by copy, the texture version rule; the private three hooks for it live there alone); one scene realizer for the editor and games; one content closure for
Play and export.

## 7. What is planned on top (see the roadmap)

Water is liquid-role voxels: bodies that regenerate when the ground is edited in the editor (47a), a derived
surface, flow and falls, queries and buoyancy (49). Fog is a new non-solid role with the fill bits as density
and the material id as fog type, painted with the voxel brushes and one height-based fill shared with water
(47b); lit fog and an interactive ground fog on the interaction field (51). Vegetation is rules hanging off the
material record as a dressing; a hand-placed tree is an ordinary prop; density by material variations (47b),
LODs, impostors and canopy in bricks (50).
