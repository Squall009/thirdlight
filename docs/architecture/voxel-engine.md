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
- **Derived data is never stored**: meshes, collision, navigation, light coverage, occupancy, detail pieces and
  open regions (region labels, chunk face connectivity, sky columns) are rebuilt in workers from voxels. The one stored derivative is the **far cache** (levels 2 and up of the mips,
  and baked bricks down to the world's bake level).
- **Light coverage with props**: objects whose model is marked `affectsLighting` are stamped into the world's prop
  coverage channel (`prop-channel.ts`, a byte a cell over the resident chunks, never saved): each prop sampled once
  into its own cells where it stands (its collider, else its model's bounds; 4³ samples a cell), a chunk its props
  combined as 1 − (1 − a)(1 − b), a move recombining only the cells it left and entered, the stamps spread over
  steps in the derive slice on the simulation's thread. The walk's light stop reads one occupancy: a level-0 cell
  stops light where the voxels' coverage joined with the props' is at least half (`coverageAt`'s rule), so the light
  volume's rays and `ctx.voxels.raycast`'s light stop see lit props, moving ones too (a changed chunk's walk block
  is sent again and the volume restarts what it reaches, as for an edit). The mips and far nodes are the voxels'
  alone; kit pieces stamp nothing (the voxels they dress do).
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
- **Lighting of voxels**: in Play and exports the near field's surfaces (level 0 and the level 1–2 mesh rings) and
  kit pieces cast and receive like any lit draw, as static casters of the key light's cached map and the shadow
  atlas: each chunk, node or seam shown, replaced or taken away is reported where it stands, and only the cached map
  and the lamp faces it reaches are drawn again; the sun's square is centred on the voxel ground under the camera
  (sky heights). Past the square, and in the far field, the **sun heights** shade: the top of what is solid in each
  column round the camera (the sky heights, 0.5 m columns over 512 m; the far field's drawn bricks, 4 m columns over
  4 km), marched toward the sun in compute into two shade lines a column (every caster's; those past the map's reach),
  read by the key light's shadow node (near draws at their vertices, the far field's one shade at its pixels), the map
  fading into them across its edge (`voxel-sun-field.ts`, `sun-heights.ts`; the tier's `voxelSunSteps`). The far
  field's one shade lights every light at its hit. It casts nothing into the maps and carries baked occlusion. Sky
  occlusion and bounce from voxels come only from **the lighting store**, which is the **voxel light volume** (owner's choice
  after the 46e-a A/B; the surface cache's voxel port and the hybrid were removed, code at tag `ab-46e-a`), **on at
  every lighting tier** on game pages (Play, exports; the tier's `voxelLightVolume.enabled`, looked at each frame;
  not in the editor's Scene view); `?voxelLight=off|volume` overrides the tier for a comparison,
  `__tlVoxelPlay.light.setStore` changes it at run time, `?surfaceRead=0` lights it without reading it. WebGPU only
  (WebGL 2 never runs it): it
  keeps light in the open cells beside surfaces (`voxel-light-volume.ts`): six values a cell (an ambient cube), 2 m
  bricks in a pool texture round the camera, updated in compute by walk rays (the sky past 24 m; at a surface its
  colour (the look's tint times its albedo texture's mean for the side seen, measured once on the GPU when the arrays arrive) times the sun and lamps seen by walks, the lamps from a list per kept brick built in compute from the clustered lights' record (the hit's level-0 brick, else its finest coarse one, else the whole table) and lit as the per-pixel light lights them: points by three's falloff, spots within their cone (no cookie), area lights (rect and line) by their diffuse form factor on their facing side, walked toward a point of them each ray picks; the ambient and hemisphere lights are in its sky term; glowing materials' glow (each open cell keeps the mean glow of the solid faces it borders, a material's glow × the mean of what it draws, its colour × the glow mask in its ORM map's alpha (the mask draws per pixel; the volume takes its mean, measured with the texture means); and each kept brick's glowing faces are emitters in the lamp table that the cells of the bricks they reach aim at, each glow counted once); and the volume's own light there), and three coarse levels of 1, 2 and
  4 m cells for open air (a clipmap to ±24, ±48 and ±96 m), all in one pool made once (as many slots as the tier's
  `lightVolume` memory row holds); an edit, a lamp's change or a jump of the sun or sky (a look switched) restarts the
  bricks a ray can reach it from (half history while changes continue; past a changed lamp's reach, which saw only
  its bounce, to fewer updates), while a sun or sky that moves (a day: no faster than 10° a second) is **followed**:
  nothing restarts, every kept brick is refreshed in turn (near the eye and in front more often) with its estimate
  blended in by at least 1 / the tier's follow window, so the light lags the sun by a few refreshes without
  shimmer, and once it stops the refining converges from there; the update paced to
  the live light's share of the GPU frame (`gpuPassBudgetMs`), batches' work in its frame slice; while nothing is
  stale it keeps refining settled bricks (the view in front first) within its idle share (`gpuPassIdleBudgetMs`) until
  each has had the tier's history of updates, a face's light the mean of about the last quarter of them, and each write filtered with
  the same face of the cells beside it along the surface (a share that fades as the brick's updates grow). Its rays,
  reach, settle and history counts, follow window, lamp list size and level-0 window are the lighting tier's
  `voxelLightVolume` settings (project-model `VoxelLightVolumeSettings`); a brick's lamp list holds the lamps that can
  light it (a spot's cone, an area light's front) less those negligible against the rest; read per pixel by
  every lit draw (voxel surfaces, kit pieces, props, moving objects; the far shade opts out; lit particles once a
  vertex instead, below) in place of the flat ambient term (`voxel-light-volume-read.ts`): level 0, then each coarse level for what it left, a level read only
  where its window holds the point's bricks; the eight cells round the point half a cell off the surface in one loop
  (the far four of an axis face weigh 0: never across a wall), one index load for every cell in the first one's brick,
  only the faces the normal weights (`readFaceFloor`); past the tier's `readFullM` (low 24 m) the one cell in front
  alone. Where no level holds light for a pixel (past the windows, or before its bricks are lit) the flat ambient, sky
and environment term stands in; under a roof (the sun field's near tops over the point taken two columns off its
surface, read at each vertex: `sunCovered`) it is taken at the tier's `indoorShare` (0.2), so a far house's rooms
seen through its windows are not lit as the street is; not a minimum (no light from the volume is changed). Its floor on the Iris Xe is about 2 ms of `near` at a street (the read's presence in the lit program, not its
  loads: one cell costs what eight do); a lower-rate read is not built (D724). Lit particles (an effect output whose
  shading is `lit` or a lit project material) read it in the vertex stage at the particle's centre facing the eye
  (level 0's one cell there, the coarse levels' eight round it) and their pixels take that: particles overdraw, so a
  read a pixel would be paid many times; `?surfaceRead=particlepixel` reads them per pixel for a comparison. Unlit
  particles read nothing. The sun's and lamps' direct light stay per pixel. Measured: plan-46e §8a 46e.6b, §8b, §8d (46e.14).

## 4. Streaming

- A load ring around each focus (192 m by default; it ends at the detail reach on a world baked to its drawn
  level), a memory budget per tier (768 MiB at low), far GPU budget (384 MiB at low); both are entries of the one
  memory budget table (`MEMORY_BUDGET_BY_TIER`, §6 row 7), as are the default path's own: the open regions'
  stitch (`regionStitch`, page), the sun field's GPU side (`sunField`), the walk's GPU blocks (`voxelWalk`) and the
  light volume (`lightVolume`).
- **At speed:** no level 0 is built, stale queued work is dropped, the far field carries the view; level 0
  returns from the camera outward when the focus stops.
- **Collision** is on its own path round moving bodies; a **coarse floor** from the 2 m data stops anything
  falling through when fine collision is late.
- Measured at 150 m/s on the low tier (export): longest frame 40–49 ms, ground solid 0.03 s after a stop, full
  detail 3.7–4.0 s on a world baked to 0.5 m.

## 5. Measuring

- Always at the display's cap; GPU timestamps are not usable there (D544). **GPU ms per pass category** (near,
  far, shadows, lighting, post, effects) come from the page's own measurement (game-host `gpu-measure.ts`, on
  WebGPU): ballast loads the frame past its cap, each category's registered passes (three-adapter
  `gpu-pass-hides.ts`; a pass registers how to hide itself) are hidden in windows interleaved with windows that
  hide nothing, frames are timed by the GPU's own completions, and each category is a median with its spread or
  "below resolution" against a control that hides nothing (resolution about 0.2 ms on the low tier's 8 km town,
  §4b of plan-46e). One routine for the Profiler's **Measure GPU**, the overlay, `tl_diagnostics` (`gpu`,
  `gpuMeasure`) and the benches (`run.mjs headroom`, `light-shots --gpu`, perf `village --gpu-measure`); about
  80–130 s a run. The **headroom meter** loads the frame until it misses and gives the room (`run.mjs headroom`,
  the routine's reading beside it); the **coverage bench** gives
  hitches, settle times and fall-throughs (`run.mjs coverage`). The **lighting cameras** (`run.mjs light-shots`,
  `tools/voxel-bench/lighting-cameras.ts`) take five fixed pictures of the 8 km world's town (street at noon, a room
  with a window, a dug cave, night with lamps, the far view) once streaming settles, with the profile at each and
  the edit-to-screen time.
  The **many-lamps scene** (`tools/voxel-bench/many-lamps.ts`, `--lamps 32|128|512` in `light-shots`, `headroom` and
  `coverage`) puts lamps of every type in the town from its own layout (street points, spots under the eaves, door
  panels, fence lines, room lamps, and glowing patches painted at run time), nearest the scene's middle first, as
  bench data taken out after the run; with it `light-shots` also takes three night cameras (`lamps-street`,
  `lamps-room`, `lamps-high`) and times the lamp-lit room's edits. `light-shots --day slow|fast` moves the sun as a
  game's script does (`ctx.environment.blend` over day looks, `day-cycle.ts`) and reads the light following it.
  `?surfaceRead=` names parts of the light volume's read for a comparison (`level0`, `coarse`, `index`, `nodecode`,
  `allfaces` = the read as first built, the draw kinds `surface`, `kit`, `prop`; the volume's diagnostics carry it).
- The **frame profile** (`window.__tlProfiler.read()` on a game page) gives each thread's CPU a frame (page,
  simulation worker, job workers) by budget category against the tier's budget, and the last long frames. It is
  shown in the editor's **Profiler** tab while Play runs, in the stats overlay (Shift+F3, Play and exports), saved
  as a capture file (`version: 1`) and read by agents as a digest (`tl_diagnostics` sections ['profile']).
- Gates run by affected area (`tools/gate.sh`, `tools/gate-areas.json`).

## 6. Shared foundations

| # | Foundation | Used by | State |
|---|---|---|---|
| 1 | Fields derived from voxels (height, slope, material, role, sky, water, fog, spline distance), one arithmetic for worker, shader and tests | vegetation rules, water, fog, `ctx.voxels`, far placement | 47b |
| 2 | Open-region labelling (a walk through connected non-solid cells) | rooms, cut-away, audio room size, stream priority, the water and fog fill, water bodies | exists: `@thirdlight/voxel` `open-regions.ts` (per level-0 unit in the derive job: open cells, i.e. not drawn as a body, labelled 6-connected, `opening` cells as portals apart, faces reached, face connectivity, the highest solid cell a column) and `open-region-stitch.ts` (`OpenRegionStitch`: chunks' components joined across faces into regions and portals as chunks arrive, change and leave; enclosed, complete, sky, volume, portals, each region's box and surface against solid cells, its parts' boxes; sky heights a column, sent to the page with the draw batches, `sky-columns.ts`); `ctx.voxels.regionAt` (a room, the outdoors, a portal or unknown; box, surface, mean free path 4V/S for a game's audio) and `portalsOf`; the voxel world page's tint overlay (`?regions=1`). **Rooms** (an enclosed region) are used by see-through and the camera's cut-away (the page sends where its subjects stand, the batches answer each one's room and its parts' boxes: `ChunkDrawBatcher.setFocus`, three-adapter `voxel-focus-rooms.ts`, `see-through.ts`) and by the light volume's indoor share (below; by the sky heights alone). Stream priority and the water and fog fill do not use it yet |
| 3 | Far-node side channels and one bake runner | far water, far fog, forest canopy, baked occlusion | 49; the runner exists (far cache) |
| 4 | Camera-following window helper | wind, interaction field, ripples, water info, fog density and simulation | exists: `three-adapter` `camera-window.ts` (`CameraWindow`, `WindowTargets`); the wind map (`wind-field.ts`, its sample public as `MaterialLibrary.windSample`) and the interaction field (`interaction-field.ts`: 256² × 0.25 m, every `interactor` stamped by one compute pass, read by foliage; WebGPU only) sit on it |
| 5 | Regenerated structures (a definition → voxels + overrides) | buildings, road and river splines, water bodies | 47a; `structure-overrides.ts` is a draft |
| 6 | One culled-instance table for every instanced draw | kit pieces, terrain and far nodes; stored copies (trees, rocks, instance sets); ground cover from point sets; impostors | exists (`occlusion-instances.ts`, on every occlusion path on WebGPU); stored copies and point-set ground cover (block layers, models, architecture floors: `cover-rows.ts`, a point expanded to a copy's 16 floats) are its rows (`copy-rows.ts`: level by the shared screen-size rule `lodLevelStep` with hysteresis and a cross-fade, thinning by rank or by the cover's share across the ground, frustum and depth pyramid, picked in compute). Not in it: terrain cover placed from heightfield texels (retires in 48); on WebGL 2 copies and point-set cover keep their vertex-stage paths |
| 7 | Budget table, profiler and frame arbiter | everything | exists: spans on every thread (`threadProfiler`, shared), `__tlProfiler.read()` on game pages, `FRAME_BUDGET_BY_TIER`, `frameSliceMs` (the arbiter is one table the 12 per-frame slices read their ms from; it does not sum them against the frame, hand unused time on or react to load, so slices can still add past a frame; left outside: block layers', heightfield terrain's and `STREAM_ARRIVAL_MS`, all retiring in 48); memory too: `MEMORY_BUDGET_BY_TIER` (every memory budget as an entry, summed against the tier's page and GPU target) and the resident-bytes report (`residentBytes` registries per thread, game-host `page-memory.ts`, the Profiler tab's Memory table); views and capture in game-host `profile-view.ts` / `profile-capture.ts`; editor Profiler tab (`editor/src/ui/profiler`), overlay Shift+F3, `tl_diagnostics` profile; GPU ms per pass category on demand (`gpu-measure.ts`, passes registered in three-adapter `gpu-pass-hides.ts`) against the GPU budget rows (near and far → render, shadows and lighting → lighting, post → other, effects → effects: `GPU_PASS_BUDGET`) |
| 8 | One world edit mode on the brush kit, in the Scene view | sculpt, paint, fill, splines, rule preview | 47b; the brush kit exists |

Also shared already and to be reused, not rebuilt: the editor's brush settings, cursor, keys and panel; the
preview renderer; the node-graph canvas; asset pickers; the edit-mode shell; `paint-brush.ts`; the scatter rule
core (`scatter.ts`); the spline format and curve maths; the voxel `WorkerPool` and `job-queue`; `view-cull.ts`; the level-of-detail rule by screen size with hysteresis (`@thirdlight/shared` `lodLevelOf` / `lodLevelStep`, for the CPU and shaders; voxel rings keep their own);
`screen-history.ts`; `dither-fade.ts`; one buffer grow (`@thirdlight/shared` `grownCapacity` / `grownArray`;
`grownGpuBuffer` for raw GPU scratch buffers); one region-texture helper for a texture three owns (`region-texture.ts`:
partial upload, grow by copy, the texture version rule; the private three hooks for it live there alone); one occupancy walk for rays (`@thirdlight/voxel` `occupancy-walk.ts`, 6-connected, level 0 then the mips and far nodes; on the GPU `voxelWalkWgsl` over the blocks the draw batches carry while something on the page reads that walk (the light volume, a bench's check; none, and nothing is packed), to the mips only: a second copy of the loop sharing three step helpers (`walk-steps.ts`), held equal by a 1,200-ray check, not one definition; `ctx.voxels.raycast` and the editor's picks; light rays stop at half coverage, the voxels' and lit props' joined at level 0); one scene realizer for the editor and games; one content closure for
Play and export.

## 7. What is planned on top (see the roadmap)

Water is liquid-role voxels: bodies that regenerate when the ground is edited in the editor (47a), a derived
surface, flow and falls, queries and buoyancy (49). Fog is a new non-solid role with the fill bits as density
and the material id as fog type, painted with the voxel brushes and one height-based fill shared with water
(47b); lit fog and an interactive ground fog on the interaction field (51). Vegetation is rules hanging off the
material record as a dressing; a hand-placed tree is an ordinary prop; density by material variations (47b),
LODs, impostors and canopy in bricks (50).
