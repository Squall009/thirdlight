# Phase 46d — Rendering and materials

Status: **planned 2026-11-08** (planning agent, owner asleep; the owner's word of 2026-11-08 is to run all of 46d
without stopping, defaults logged "default chosen, owner to confirm"). On branch `phase-45` (worktree
`~/projects/thirdlight-p45`, head 774dd6a9 at planning; main frozen at d4053cab). Planned from `docs/plan-phase-45.md`
§4 (46d), §1c (one material model), §1d (tiling and texel density by tier), §2 (LOD table, the brick renderer
experiment), §5c (high tier measured by the owner), §7 (owner 2026-11-02: wetness R111, no trim for voxel faces
R112), §7a (surface subdivision and displacement: investigate before committing), §9 (efficiencies), and the owner
entries of `docs/plan-phase-46c.md` §9 (2026-11-04 … 2026-11-08), which take precedence where they revise plan-45.
Contracts: format spec v1 (APPROVED, `docs/architecture/voxel-format-spec.md`: changes are versioned add-only steps
with an owner note), role spec v1 and texture layout v1 (APPROVED), kit format 1 (final, add-only). Never 46e.

## 1. Scope

> **Superseded in part (2026-11-13).** Written before the owner's 2026-11-09 to 11-12 decisions: near relief, the far field built both ways and both-renderer measurement are history; the phase ended as bricks with a bake level, WebGPU first. What is true now: `docs/architecture/voxel-engine.md`; what was decided and dropped: `docs/decisions/owner-decisions.md`.

**Make the voxel world look like its materials, near and far, inside a budget per quality tier.** 46d builds:
- **Near-ring relief, decided by a spike first (owner):** a denser voxel mesh in the near ring (building grids and
  terrain) displaced in the vertex shader by each material's height, on both renderers (WebGPU has no hardware
  tessellation, so the worker emits the topology and the vertex stage moves it). Measured, pictured, then the chosen
  path is built.
- **One material record (§1c)** in `project-model` with the commands as the one mutation path: look (shader family
  + texture set + parameters), optional physical block with shared profiles, optional opaque game data, optional
  voxel use (id, construction / terrain / liquid, kit, tile metres, height depth in metres); variants as material
  instances; badges and filters, minimal. The kit → material binding moves from the kit's test field into it.
- **Texture sets on the GPU:** per map type one texture array (a layer per voxel material surface), slot residency
  by quality tier and the page's texture budget, reusing terrain's per-layer slot assembly into KTX2 arrays and the
  KTX2 mip streaming; construction tiles 4 × 4 m grid-anchored (authored 4096² at 1024 px/m), terrain triplanar
  2 m, wall / floor / ceiling surfaces per material, kit sheets and crack maps read for real (the labelled debug set
  retired as the default), per-material height depth in metres, wetness R111 in full.
- **Kit pieces across chunks:** one instanced draw per piece mesh for the whole near ring, GPU culling on WebGPU and
  per-chunk-range culling on WebGL 2 (D485); the base-surface merges D526 names.
- **The far field with no draw cut-off (owner):** the chunk tree past 46b's rings (HLOD from voxel mips) and the
  far-field choice, built **both ways** behind a switch — (a) voxel-mip meshes, (b) ray-marched distance-field bricks
  (Enshrouded's brick renderer is the gold standard; the phase-42 brick format and tracer math reused) — on an
  engine-owned multi-km synthetic test world with mountains, measured side by side; **both are kept until the owner
  picks.** D463, D516, D479 and the L1 door/window "legs" are closed by this work.
- **Every feature behind a quality-tier switch and a budget** (§4): texel density, relief, far field mode and its
  screen error, piece culling.

**Not in 46d:** lighting (the tracer over occupancy, the light-volume vs surface-cache measurement), rooms and
portals, chunk connectivity culling and the walk graph (all 46e; 46d keeps the light/nav inputs as they are);
structure objects, rotated grids, door/window props in openings (47a); brushes, role painting, stamps, scatter and
ground-contact fringe (47b); the world-map editor view and debug views at world scale (47c); converting block
layers, terrain, architecture and today's materials to the material model (48a: 46d adds fields and families, it
converts nothing; graph materials stay graph); water (49); performance tuning (the performance phase after 49:
misses are recorded with their cause, never chased — D468 stays there). Macro noise, hashed per-run jitter and
hex-tile sampling stay future proposals (owner, §1d) unless repetition shows in the acceptance pictures. No paint
overlay layer (owner 2026-11-06: dirt/moss = decals + whole-voxel material swaps). The detail-piece ring stays the
level-0 ring (owner 2026-11-06 A5: unchanged until the far-field numbers are in). No procedural world generation as
a product feature: the multi-km world is test data written by `tools/voxel-bench`. Game repos and art-factory are
not edited (an art-factory request doc may be written). three.js is not updated (§3).

## 2. Owner requirements (quoted; REQUIREMENTS, never silently dropped)

- 2026-11-06 (plan-46c §9, acc46c-r batch 4): "**Near-ring tessellation:** the near ring renders voxel meshes denser
  so relief can displace them (building grids and terrain); how well the mesher does it is measured as **the first
  item of 46d** (owner choice). Replaces the 2026-10-27 'no displacement tessellation' decision."
- 2026-11-04 (OWNER (6)): "**Far field: no arbitrary draw cut-off** — mountains must be visible from several km;
  this needs extremely cheap chunk/region stand-ins at distance (Enshrouded's brick renderer is the reference); a
  requirement for 46d's far field (D463)."
- 2026-11-08 (brief, the 46d run): "build BOTH voxel-mip meshes and ray-marched bricks behind a switch, measure
  both, the OWNER picks (keep both until then)."
- 2026-11-04 (OWNER): "**construction tiling textures are authored to a 4 × 4 m full wall**: one texture repeat =
  one full-size wall (4 m) in both directions, anchored to the build grid in metres, floors on the same grid."
- 2026-11-05 (OWNER B1): "**author base tiles at 4096² (1024 px/m) by default;** the resident mip level is chosen by
  the quality level (performance settings) and the texture memory budget." (§1d: low keeps up to 256 px/m, medium
  512, high 1024; one asset set, no per-tier copies.)
- 2026-11-02 (OWNER): "**no trim sheet for terrain and construction voxels.** Their materials are tileable texture
  arrays with separate wall, floor and ceiling surfaces (chosen by role and face direction), mapped triplanar."
  Terrain repeats every 2 m by default (46c R4).
- 2026-11-05 (OWNER B8): "**no shared absolute height scale.** Height maps stay 0–1; each material declares its own
  height depth in metres (sand shallow, jagged rock deep), so no texture is crushed; height blending compares in
  metres. 46d's material model owns the field."
- 2026-11-05 (OWNER B5): "**one kit uses exactly one texture set** (one trim sheet or one material) for all its
  pieces, for batching and performance."
- 2026-11-02 (OWNER, R111): "**wetness is more than darkening.** Rising wetness darkens the albedo, lowers roughness
  and fills in the normals (flattens the material's normal detail and fills crevices first, using the height in the
  normal map's alpha), so a level-7 surface reads as standing water in the low parts."
- 2026-11-06 (OWNER B3 correction): "**dirt/moss = decals + whole-voxel material swaps.** Decals on voxel surfaces
  are made to work and tested; the 9 reserved bits get no overlay meaning now."
- 2026-11-06 (OWNER, acc46c-r2 O-answers): "**Middle-distance door/window merge ('legs' at L1): left to the
  far-field / large-world rendering work (46d),** where distance drawing changes anyway."
- 2026-11-06 (OWNER A5): "**the detail-piece ring = the level-0 ring stays until the voxel phases are done and the
  far-rendering phase has performance numbers;** do not change it before."
- 2026-11-05 (OWNER): "**ring distances are fully configurable per scene, at runtime, and scale with the quality
  level** … No hard-coded ring distances anywhere; defaults only as defaults." (Applies to the relief ring and the
  far-field distances 46d adds.)
- 2026-10-28 (§1c, owner direction): one material record for every purpose, a handful of shader families, variants
  instead of copies, shared physical profiles, capabilities as derived badges, tools list only materials that fit.
- 2026-10-28 (owner): the Iris Xe is the floor; 720p60 the goal, 720p30 acceptable in 45–49; measure at the display
  cap, never uncapped; record misses with their cause, never block on a threshold.
- 2026-11-10 (OWNER, relayed by session thirdlight-65; vista note §6): "**we keep webgl2 as a fallback for weird
  drivers but we move to a webgpu everything and eventually clean up the gates as we get to them so we cut all the
  extra double passes out. Move the steps 1-4 to compute shaders.**" WebGPU is the renderer the voxel work is
  designed, built and measured for; WebGL 2 keeps what it draws today and must still load and draw a voxel world (no
  new voxel feature, no parity). Replaces the 2026-10-26 one-shared-path preference.
- 2026-11-10 (OWNER): vista pass steps 1–4 (46d.17–46d.20) in 46d-b; goal an order of magnitude of headroom on the
  Iris Xe at 720p30 with fidelity kept, room for foliage, weather and fog later.
- 2026-11-10 (OWNER, after 46d.16, relayed by session thirdlight-65): **the Iris Xe target is the LOW tier: 720p
  upscaled, capped at 30 Hz.** Low renders at about 0.667 render scale with the temporal upscaler (as medium does)
  and everything else cheaper; the headroom meter measures low against its 30 Hz cap. "No room at 60 Hz on medium"
  is not a blocker; medium and high cannot be judged on this host: report their pass shares and scaling, frame
  times labelled "unverified on target hardware" (a workstation meter run is still wanted, §10).
- 2026-11-10 (OWNER): **travel at 150 m/s** (racing-game class). Streaming "need not be perfect, but we need to make
  sure a world is maintained around the camera while moving even if things are still streaming in at various
  quality levels": the pass criterion at speed is coverage (no hole, no missing ground or collision under the
  camera), not zero missed frames or full detail.
- 2026-11-10 (OWNER): a page + GPU **memory ceiling for the low tier only** for now; no budgets for medium/high
  until they can be tested properly. The post stack (19–24 % of medium's frame) gets its own later phase, not 46d.
  A fuller frame budget (GPU and CPU per thread) is drafted with the owner once low's numbers exist; nothing to
  build yet. No stand-in forest: the owner's demo project is the stress scene; the 8 km world stays for
  like-for-like numbers.
- 2026-11-11 (OWNER, relayed by session thirdlight-65): "**A hair over a gb … seems ridiculous. 4gb would be better
  but honestly everyone and their dog have at least 8 to work with. I'm not making games for mobile devices
  here.**" Minimum spec 8 GB system memory, not mobile; the low tier's design budget is about 4 GB for the game in
  total (page + GPU; an integrated GPU shares system memory). Replaces 46d.21's 1,024 / 1,280 MiB ceiling (that
  day's measurement plus a margin, not derived from hardware). Still no budgets for medium/high until they can be
  tested properly, but they must not end up below low.
- 2026-11-11 (OWNER, relayed by session thirdlight-65; `docs/briefs/streaming-rings-2026-11-11.md`): **the 150 m/s
  test measures the wrong thing** — "the more important thing during that test is that there are no large spike
  hiccups that would make player experience feel sluggish and second, how long does it take after stopping for the
  detail to fill in and settle around the camera." Full-detail data under a flying camera (D598, review H3) is no
  longer a pass criterion; new measures: longest frame in flight, frames > 100 ms, after a stop the seconds until
  ground is solid / full detail stands / nothing is pending, never falling through. **Fine bricks from GPU compute**:
  "the gpu compute stage for brick generation at the 0.5/1m level should be attempted for anything beyond the detail
  ring." Deferred, not to revive now: detail-piece LODs, relief, GPU tessellation of the near mesh. No whole-map
  bake of near detail ("derived data is never stored" stays).
- 2026-11-12 (OWNER, relayed by session thirdlight-65; `docs/briefs/bake-level-2026-11-12.md`): "**brick compute
  and storage should be tunable per scene.** Just select how fine grained scene gets baked with 2m being default but
  you can change it to one or 0.5 and have it all cached. At any level chosen the runtime brick compute is based on
  that so no realtime needed if 0.5 is selected or only 0.5 if 1 is selected." And for low: "At 720p30hz we have a
  lot of frame time available but the streaming and load speed are the current bottlenecks. If we keep the current
  detail zone on low, bake down to 0.5m we can cut out the additional detail voxels that are going so far out and use
  the precomputed 0.5 pushed out to keep the detail reasonable." A bake level per voxel world (2 m default, 1 m or
  0.5 m, cached); run-time compute builds only levels finer than the bake; low = today's detail ring + baked 0.5 m
  pushed out, so the voxel read ring shrinks.

## 3. three.js check

Checked 2026-11-08 at the 46d start (`npm view three time`): **0.187.0 (released 2026-10-30) is still the newest
release** on npm; the branch pins 0.187.0 (`packages/three-adapter`, `packages/editor`). No newer release, so nothing
to assess against `docs/three-upgrade-checklist.md`; no update (owner-only). Items that touch private hooks listed
in the checklist (the shadow pass's use of a material's `positionNode` for displacement, 46d.1b; fragment depth
writes for the brick marcher, 46d.7c) add their hook to the checklist in the same commit.

46d-c start (checked 2026-11-11, `npm view three time`): 0.187.0 is still the newest release on npm; nothing to assess.

## 4. Baseline (measured at the start of 46d.1a; the numbers 46d reports against)

Measured by the first item before it changes anything, on staging (`tools/staging.sh`), Iris Xe, 1280 × 720, the
60 Hz cap, both renderers, ≤ 3 rounds, `uptime` recorded. The right column is the last number 46c recorded; where
the re-measure differs, the re-measure wins.

| What | How | Last recorded (46c) |
|---|---|---|
| Slice and town at the cap: render() CPU ms p50/p95, GPU ms (timestamps), frames missed (orbit ~480), draws, triangles, piece instances, page MB | `run.mjs slice` scenes on staging, both renderers | town 42.7 k instances, 1,412 piece draws, render() 8.7–9.3 ms, 0 missed, 126.5 MB (46c.16g); GPU town 2.9–3.3 ms (R6/R9) |
| Multi-km flight (streaming + LOD under travel): frames missed, swap ms, MB | `run.mjs stream-page` on the 2 × 2 km hilly world | 46b.11b / 46c.11: flight 0–3 missed |
| Mesher µs a 16³ section p50/p95 (terrain, roofs) | `run.mjs mesher`, `cases --roofs --fill` | evaluate+mesh slice 217 / town 207 µs; roofs 345/1,131 → after D525 fix (46c.16k) |
| Base triangles town (roofs filled) | `cases --roofs --fill` | 468,872 (D526: +51 k over 46c.16d) |
| Texture memory (voxel surface: grid, table, pattern, crack arrays) | page GPU bytes report | not recorded: record it |
| What the far field draws today | load box 192 m, nothing past it (D463, D516) | — |
| `tests/e2e/voxel-world.e2e.ts` time | fast gate log | 64.5 s (46c.16k) |
| Full gate | 46c close | 34 min, 8.0 GB, 393 e2e (9e50b65e) |

## 5. Where things live (reuse first; import or move to `@thirdlight/shared` in its own commit, never copy)

> **Superseded in part (2026-11-13).** Relief and mesh-far modules listed here still exist behind switches and are not to be extended. What is true now: `docs/architecture/voxel-engine.md`; what was decided and dropped: `docs/decisions/owner-decisions.md`.

- **Voxel surface shader** — three-adapter `voxel-surface.ts` (material table texture: a texel a material id, looks
  in block 1, tiles in block 2, a layer column already read at :644; grid 3D texture; pattern and crack arrays; four
  of sixteen texture units, `texture-units.ts`), `voxel-surface-projection.ts` (grid-anchored construction U/V,
  roof slope, triplanar), `voxel-crack-texture.ts` (engine crack map or the kit's own, on the 4 m tile),
  `voxel-trim-debug-texture.ts` (the debug set 46d retires as the default), `voxel-chunk-view.ts`
  (`voxelStandInLook`: today's per-id stand-in colours), `voxel-kit-pieces.ts`, `voxel-piece-placement.ts`,
  `voxel-world-draws.ts`, `voxel-world-decals.ts` (46c.16f decals on voxel surfaces), `camera-relative.ts`.
- **Voxel derive** — `@thirdlight/voxel` `base-surface.ts`, `terrain-mesher.ts`, `roof-mesher.ts`,
  `derived-mesh.ts`, `derived-shader.ts` (the per-chunk 34³ material + wetness grid), `voxel-mips.ts`,
  `mip-derive.ts`, `lod-seam.ts`, `lod-select.ts`, `stream-lod.ts`, `stream-ring.ts`, `stream-mips.ts`,
  `derive-pieces.ts`, `piece-table.ts`; `FIELD_FEEDS`/`DERIVED_PART` in `record.ts` (the feeds mask).
- **Materials today** — project-model `materials.ts` (`MaterialDef`: shader + params + textures, `graph`,
  `instanceOf` = material instances, `MAX_MATERIAL_INSTANCE_DEPTH`), `material-schema.ts` (shader types and texture
  slots), `material-use.ts` (what ships), `layered-surface.ts` (phase 35's layered surface: the one layout terrain,
  blocks, architecture wear; height-blended layers template `albedoHeight` / `normals` / `orm`); three-adapter
  `material-library.ts`, `material-variant.ts`, `material-swaps.ts`, `runtime-materials.ts`; editor material
  library. The 46d record extends `MaterialDef` add-only; it does not replace it (48a converts).
- **Texture arrays and streaming** — project-model `texture-slots.ts` (per-layer slots, `MAX_TEXTURE_LAYERS` 256 in
  `content-limits.ts`, `withAssembledSlots`: Play and export assemble a list into one KTX2 array, cached by digest;
  height arrays), `ktx2-levels.ts` (a KTX2's levels by byte range; reads `layers`), `texture-streaming.ts`
  (`texture_budget_mb`, `TEXTURE_BUDGET_DEFAULT_MB` 512); three-adapter `texture-streaming.ts` (head + mip tail,
  levels by on-screen need), `texture-budget.ts` (which levels fit), `ktx2.ts` (one loader a page),
  `texture-holds.ts`. Whether array KTX2s stream per level today is checked in 46d.4b (extend, never fork).
- **Terrain far-drawing ideas** — three-adapter `terrain-quadtree.ts` (CDLOD selection, morph), `terrain-macro.ts`
  (a tile's baked macro albedo + normal for far nodes), `terrain-node-culling.ts`; heightfield only, so ideas, not
  representation (§7a).
- **Instancing and culling** — `instancing.ts` (instance sets), `attribute-instancing.ts`, `batching.ts` (automatic
  instancing), `instance-lod.ts`, `view-cull.ts` (per-member culling inside one draw, both renderers),
  `occlusion-instances.ts` + `occlusion-pyramid.ts` (WebGPU depth-pyramid culling of instanced copies),
  `dither-fade.ts` (the engine's dither cross-fade), `impostor.ts` (octahedral impostors; scatter only, §2).
- **Distance-field bricks and the tracer (phase 42)** — project-model `distance-bricks.ts` (sparse brick format,
  `DISTANCE_BRICK_SIDE`, `DISTANCE_BRICK_CELLS`, inside/outside codes), `distance-bricks-build.ts`; three-adapter
  `tracer-wgsl-objects.ts` (`brickDistance`, sphere tracing through bricks), `tracer-cpu-objects.ts` (the same walk
  on the CPU, `BRICK_HIT_VOXELS`, `BRICK_MIN_STEP_VOXELS`), `probe-bricks.ts`, `probe-atlas.ts` (atlas packing),
  `gpu-timing.ts` (GPU timestamps).
- **Quality** — project-model `quality-levels.ts` (`QualityLevelConfig`, `DEFAULT_QUALITY_LEVELS` low/medium/high,
  `voxelRings`), `quality-device.ts` (device → level), `voxel-world.ts` (`resolveVoxelWorld`, per-scene rings,
  `quality[<level>]`); three-adapter `quality-control.ts`, `dynamic-resolution.ts`.
- **Kits** — project-model `voxel-kit.ts` (format 1 final; `materials` = the test binding 46d moves),
  `voxel-kit-check.ts`, `voxel-trim-layout.ts`; `tools/voxel-bench/kits/`.
- **Bench and staging** — `tools/voxel-bench` (`run.mjs` modes: `slice`, `stream-page`, `mips`, `seams`, `mesher`,
  `cases`, `slice-world`; `worlds.ts` hilly 2 × 2 km and the 2 km tall mountain world; `flight-path.ts`; `town.ts`),
  `tools/staging.sh`, `tests/e2e/png.ts`. New bench modes go in `run.mjs`'s list.
- **New code homes** — `@thirdlight/voxel`: `relief-mesh.ts` (subdivision), `far-tree.ts` (chunk tree / far nodes),
  `far-bricks.ts` (distance bricks from mips); three-adapter: `voxel-relief.ts`, `voxel-textures.ts` (arrays and
  residency), `voxel-piece-batches.ts`, `voxel-far-mesh.ts`, `voxel-far-bricks.ts`; project-model
  `material-profiles.ts`, `voxel-materials.ts`. Files near 2,000 lines are split first.

## 6. Items

Order inside an item per AGENTS.md: schema/commands → runtime/adapter/host → editor → exporter → tests → docs. One
code agent at a time, ~1–2 h an item, fast gate green, commit early. Browser checks only extend
`tests/e2e/voxel-world.e2e.ts` (one backend; no new e2e file; record its time before → after); everything else is
vitest at real boundaries (real derive and workers, region files on disk, the real KTX2 assembly and transcoder,
real program builds on both backends). Perf: Iris Xe, 1280 × 720, the 60 Hz cap, both renderers, ≤ 3 rounds,
`uptime` recorded, GPU ms from timestamps; misses recorded with their cause (performance phase after 49). Pictures
go to `~/.cache/thirdlight-phase46/acceptance/46d/<item>/` and are looked at before anything is called seen;
otherwise "unverified". Every placeholder asset (texture sets, height test set) is game-ready and reported: texture
sizes and encodings, mips, file size (and triangles/LODs where geometry). A format addition is an add-only step
with an owner note, in the split pages after 46d.2. Every new distance is a default per scene, runtime-settable and
quality-scaled like the 46c.16a rings; every new limit is defined once in its owning package.

| Item | Builds | Tested at | Measures | Done when / closes |
|---|---|---|---|---|
| 46d.1a | **Spike part 1 — denser near-ring topology (worker):** first the §4 baseline. Then a spike-only derive option (bench + `?relief=n` page switch, no format version yet) that subdivides level-0 base-surface output for sections within a relief radius: construction faces (walls, floors, flat roofs) into n × n quads on the 0.5 m lattice (n = 2, 4, 8: 25, 12.5, 6.25 cm), roof planes along their rows, terrain-mesher triangles split 4^k; vertices welded inside a section and placed identically on both sides of section and chunk faces; a per-vertex **crease weight** (0 on a face edge where the normal turns more than a set angle, on cells carrying a kit edge piece, at owned-face seams, on the relief ring's last metres; 1 inside); the boundary to non-relief sections and to level 1 left as today's edges (no new T-junctions: border vertices stay on the coarse edge, weight 0). Collision, occupancy, nav and light inputs unchanged (byte-equal). | vitest in `@thirdlight/voxel` + `tools/voxel-bench/derived.test.ts`: watertight per section and across section/chunk faces for n = 2/4/8 on slice, town, hilly and caves; border vertices of relief sections equal to their plain neighbours' edges; collision/occupancy bytes equal with relief on/off; deterministic | triangles and vertex bytes per section and for the ring (n = 2/4/8), derive µs a section p50/p95 (Node + browser worker), memory of the ring, at radii 16/32/64 m | topology crack-free in tests; costs recorded; baseline recorded in §8 |
| 46d.1b | **Spike part 2 — vertex displacement, both renderers, and the verdict:** a TSL `positionNode` that moves each relief vertex inward along its smooth normal by (1 − height) × the material's depth × crease weight, the height a filtered sample (mip from the vertex spacing, never sharper than the topology) of a spike height array (engine-owned, generated by a bench script: brick, stone, plank, rock, sand heights, 1024² a layer, reported) blended between the cell's materials exactly as the surface shader blends (so both sides of a seam move the same); the lighting normal from the material's normal map (geometry normals not rebuilt); the shadow pass displaced the same (three's shadow use of `positionNode` checked, added to the upgrade checklist); culling bounds grown by the largest depth in the chunk; relief ring faded over its last metres with hysteresis; kit pieces on crease-0 edges meet the undisplaced lattice. Pictures: walls, floors, roofs, terrain slope/cliff/cave, kit edge seams, chunk and section boundaries, ring edge in motion, shadows, both renderers. **Verdict** in §8 and the decision log: per tier the n and radius (or "off"), or the mesh path rejected with why and the replacement that keeps the goal (e.g. parallax in the fragment) for the owner. | vitest (program builds with the displacement on WebGL 2 and WebGPU; bounds include the depth); staging pictures looked at, both renderers; `voxel-world.e2e.ts` untouched | GPU ms at the cap relief off vs n = 2/4/8 at 2–3 radii, both renderers, slice and town; shadow pass ms; vertex count drawn; pop/swim seen at the ring edge | verdict with pictures and numbers; the chosen path named for 46d.5 |
| 46d.2 | **Format spec split (D496), docs only, before any format addition:** `voxel-format-spec.md` §3.7's *Kits: edges, roofs and damage* and §3.9 (kit record) move unchanged to `docs/architecture/voxel-kit-format.md`; a new `docs/architecture/voxel-render-spec.md` (empty sections: material record, texture sets, relief part, far-field data) receives every 46d format addition; the main spec keeps a pointer and its version table (§3.8), its traceability (§4) re-pointed; manual links and `role-spec-doc.test.ts` anchors fixed. Owner note: a split, no content or version changed. | check-docs, `tools/manual-links.test.mjs`, the spec doc tests | spec lines before/after | spec under 2,000 lines; D496 closed |
| 46d.3a | **Material record (schema + commands):** add-only optional fields on `MaterialDef`, canonicalized field by field (trap: tested present after a round trip): `physical` {`profile`, `density` kg/m³, `friction`, `restitution`, `flowRate`}, `gameData` (opaque JSON, passed through, never interpreted), `voxel` {`id` 1–4,095 unique in the project, `use` `construction` \| `terrain` \| `liquid`, `kit` (a voxel kit id; not with liquid), `tileMetres` (default 4 construction / 2 terrain), `heightDepth` metres, `surfaces` {`wall`, `floor`, `ceiling`} texture sets (floor/ceiling default to wall)}. Profiles: `material-profiles.ts` (engine profiles Wood, Stone, Metal, Earth, Glass, Water, Lava as constants; a project's own in `content.materialProfiles`, overriding by id). Variants = material instances (`instanceOf`): an instance inherits physical, game data and voxel fields and overrides any; a voxel variant takes its own id. **Kit binding moved in:** the derive's material → kit table is built from `voxel.kit`; a kit's `materials` list (kit format 1, still accepted) binds only ids no material names, with a kit-check info row "set the binding on the material". Commands: the existing material commands carry the fields (one undo each), `setMaterialProfile` / `deleteMaterialProfile`; refusals `voxel_id_taken`, `kit_missing`; MCP and HTTP the same commands. Shader families as a derived read (`materialFamilyOf`: standard, projected, liquid, decal, effect, graph), no new shader types. | vitest (validate, canonical round trip, instance inheritance depth, binding table from records with a kit fallback, refusals), commands integration (backend + export manifest carries the fields) | record bytes; project load ms with 4,095 voxel materials | one record serves mesh and voxel use; binding read from materials |
| 46d.3b | **The record drawn and read (runtime + editor):** the voxel material table built from records (colour/tint, tiles, depth, layer slots; ids without a record keep `voxelStandInLook`); a material edit re-uploads the table only (no remesh: feeds rule); `ctx.voxels.materialAt(p)` / `materialOf(id)` return the resolved physical block, profile and game data for game logic (footsteps, block health); chunk colliders keep the engine friction (per-triangle friction is not in Rapier's trimesh; recorded); editor: badges (mesh / voxel + kit / liquid / decal / graph "compiles its own shader") and a filter in the material library, the voxel world page's material picker lists only voxel-capable materials, the voxel section in the material inspector; export ships the records of used materials (`material-use.ts`). | vitest (table from records; `ctx.voxels` reads in a real runtime), e2e `voxel-world.e2e.ts` extended (set a material's voxel tile/colour through the UI → the table changes, no remesh; the picker lists only voxel materials), export served statically | table upload ms; e2e time before → after | records drive the drawn world on both renderers (seen) |
| 46d.4a | **Texture sets in arrays:** per map type one KTX2 array (albedo + height in A, normal, ORM) assembled by `texture-slots.ts` from each voxel material's surface sets (wall / floor / ceiling chosen by role and face direction; terrain one set), the slot per (material, surface) written into the table's layer column; the debug pattern array leaves the default program (kept under `?patterns=1`); texture units counted (`texture-units.ts`: 3 arrays replace the pattern array); construction U/V from the build grid on the 4 m tile, terrain triplanar 2 m, both from `tileMetres`. Placeholder sets (engine-owned test data from a bench script: stone, plaster, timber, earth, grass, rock; authored 4096² at 1024 px/m into scratch, a 512² cut committed for tests), reported per set: sizes, encoding, mips, bytes. | vitest (assembly of a voxel material list into arrays through the real assembly; slot table; program builds both backends within 16 units), staging pictures both renderers (bands line up across walls/floors/chunks with real textures) | GPU MB per tier; reads a pixel; GPU ms vs baseline | real textures on walls, floors, ceilings, roofs and terrain (seen) |
| 46d.4b | **Slot residency per quality tier and the texture budget:** a quality-level field `voxelTexelDensity` (low 256, medium 512, high 1024 px/m; the resident top mip = authored 1024 px/m >> tier) applied by the existing mip streaming (array KTX2s streamed per level: checked, `ktx2-levels.ts` / `texture-streaming.ts` extended for layers if they are not) under the page's `texture_budget_mb` (`texture-budget.ts` decides; the arrays' mip tail always resident = the "always-resident low array" of §2); the near need from the ring's on-screen texel density. | vitest (levels chosen per tier and budget; streamed array levels decoded by the real transcoder), browser check on staging (tier switch at runtime changes resident levels without reload) | resident MB per tier, levels per tier, stream-in ms, frames missed while streaming | each tier stays inside its budget (numbers) |
| 46d.4c | **Kit sheets and crack maps for real; debug set retired:** kit pieces draw with their kit's one material (B5: its textures through the same arrays or its own standard-family set), the trim debug texture only under `?trimDebug=1`; the kit's own crack map (4 × 4 m tile, 46c.16k) read from its material; the export writes the kit material's real images (replaces 46c.17's placeholder); the sample kit in the authoring package shows textured. | vitest (piece program reads the kit material; export manifest lists the images), e2e extended (kit pieces drawn textured, `png.ts` reads differ from the debug set), export served statically with the backend stopped | piece draws unchanged vs 46c; GPU ms | pieces wear their kit's material (seen both renderers) |
| 46d.4d | **Height depth in metres and wetness R111:** the blend between the two heaviest materials compares height × `heightDepth` (metres), so sand stays shallow and rock deep; wetness per the owner's contract: darken albedo, lower roughness, flatten normal detail and fill crevices first by height (the water line rises with the level; level 7 = standing water in the low parts), on terrain, construction and kit pieces' surfaces; decals on voxel surfaces (dirt/moss) checked with the real textures. | vitest (shader nodes on both backends; wetness levels 0–7 on a fixed pixel set give the ordered darkening/roughness/fill), staging pictures both renderers (wet ground 0/3/5/7, sand/rock blend, decal on a textured wall) | GPU ms vs 46d.4a | R111 met (seen); slice placeholder darkening gone |
| 46d.5a | **Relief on the chosen path (derive + format):** 46d.1's verdict built as product: the relief part as a derived output with its version step and owner note (`voxel-render-spec.md`), a relief ring per scene (`voxelWorld.levels.relief`, metres, runtime `ctx.voxels.setRings`, scaled per quality level, off where the verdict says), crease weights from the derive, the feeds rule kept (a material paint never remeshes relief: depth is shader data). If the verdict rejected the mesh path, this item builds the replacement it named instead. | vitest (relief part per level and ring, format step, conformance at section/chunk edges, ring re-plan swaps atomically), stream test with real workers | derive µs, ring MB per tier | relief ring configurable and crack-free |
| 46d.5b | **Relief drawn (adapter + hosts + export):** the displacement with real heights from 46d.4's arrays and `heightDepth`, shadow pass, grown bounds, ring fade with hysteresis, Play, Scene view and export; an editor toggle for the relief view in the voxel world page. | vitest (program builds), e2e extended (relief on: a wall's silhouette row read by `png.ts` differs from relief off; edge seams closed), export served statically, staging pictures both renderers | GPU ms per tier at the cap, slice/town; shadow ms | relief seen on walls, floors, roofs and terrain; numbers recorded |
| 46d.6a | **Piece instancing across chunks (D485):** one instance buffer per (kit piece mesh, variant, mirror) for the whole level-0 ring, chunk ranges packed and compacted on chunk add/remove (no per-chunk draws), reusing `attribute-instancing.ts`; WebGL 2: per-chunk-range frustum culling compacting visible ranges into the draw's instance list (`view-cull.ts` path) when visibility changes. | vitest (buffers after add/remove/swap equal a rebuild; atomic swap keeps pieces of a group together), `voxel-world.e2e.ts` piece checks unchanged | piece draws, instances, render() CPU p50/p95 town orbit vs D485/46c.16g, frames missed | draws ≈ piece kinds in view; D485 numbers re-recorded |
| 46d.6b | **GPU culling of pieces on WebGPU:** the piece buffers join `occlusion-instances.ts` (frustum + depth pyramid per instance), so each pass draws only visible copies; shadow pass culls against its own frustum; tier switch (`occlusionCulling` level field). | vitest (cull lists on a fixed view), staging both renderers | render() CPU, GPU ms incl. the cull pass, town orbit and flight | D485 closed or re-recorded with the cause |
| 46d.6c | **Base-surface merges (D526):** owned and blended faces merge where the blend reads no plane cell; vertex sharing along a roof row; derived step with owner note. | `roof-mesher.test.ts`, `derived.test.ts` (bytes, watertight, owner offsets exact) | town base triangles (468,872 →), roof mesher µs p50/p95 | D526 closed or re-recorded |
| 46d.6d | **Relief shadows from plain casters (D545):** relief chunks cast from their plain surfaces (shadow-only draws), relief meshes cast none and look shadows up at their plain place; both renderers, one draw path. | vitest (real derive + view, program builds), real-worker batch test, staging pictures | town shadows med/high at the cap | D545 closed or re-recorded |
| 46d.7a | **Multi-km test world and the far tree (data):** `run.mjs far-world` writes an engine-owned synthetic test world tile by tile to disk (default 8 × 8 km, mountains to ~1.5 km with cliffs, overhangs and valleys, the town patch at its centre; within the 6 G cap, never held in memory), plus `far-tree.ts`: a chunk tree past the load ring whose nodes (16 m · 2^k) hold voxel mips built from the regions by workers into a derived far cache (never committed; rebuilt per node when an edit lands under it; shipped in an export like distance bricks), streamed by on-screen size over the whole world (no cut-off). Mip readers role-aware: openings narrower than two of a level's cells close in the wall's material (the L1 door/window "legs"). | vitest (tree selection by screen error with hysteresis; far cache bytes deterministic; an edit rebuilds exactly its ancestors; legs closed at L1/L2 on test houses), Node bench | build s/km², cache MB/km², nodes resident vs distance | the world's far data exists for every km; legs closed |
| 46d.7b | **(a) Voxel-mip mesh far field (chunk-tree HLOD):** far nodes meshed by the 46b mesher on their mips, a macro colour + normal per node baked from the material table (the `terrain-macro.ts` idea; one read a pixel), skirts between far levels, dither cross-fade (`dither-fade.ts`) on level change, per-level shader data so a material/wetness paint updates far nodes without a mesh derive (D479); the near rings hand over to it without the ring-edge pop (D516) and tall terrain past the load box draws (D463). `?farField=mesh` and quality field `farField`. | vitest (skirts close seams; shader-only far derive on paints), staging pictures both renderers at 1, 3, 5 km and at the ring edge | GPU ms, CPU ms, triangles, MB, build time, pop seen in a flight | mountains visible from 5 km (seen); D463, D479, D516 closed or re-recorded |
| 46d.7c | **(b) Ray-marched distance-field brick far field:** per far node sparse 8³ distance bricks from the mips (`far-bricks.ts`, the phase-42 brick format's constants and inside/outside codes), a shared 3D atlas + page table, each brick's box drawn and sphere-traced in a TSL fragment shader on both renderers (the `brickDistance` walk of `tracer-wgsl-objects.ts` / `tracer-cpu-objects.ts` ported once, shared with the CPU check), colour from a per-node macro, normal from the field's gradient, depth written so it composes with meshes; `?farField=bricks`; optional hybrid (bricks mid band, meshes horizon) only if 46d.7d's numbers call for it. | vitest (CPU march = shader math on fixed rays; atlas packing; program builds on both backends), staging pictures both renderers at 1, 3, 5 km | GPU ms (the horizon band's pixel cost), atlas MB, build time, crispness, steps a ray | both modes switchable at runtime; nothing cut off |
| 46d.7d | **The far-field comparison:** both modes on the 8 km world, Iris Xe at the cap, both renderers, a multi-km flight and fixed views at 1, 3, 5 km; GPU ms (timestamps), CPU ms, GPU and page MB, build time, crispness (silhouette pictures side by side), pop/transition (frames during the flight); writes `~/.cache/thirdlight-phase46/far-field-comparison.md` (plain words, one table, the pictures, a lead recommendation, what the owner must pick); high tier unverified until the owner runs the harness page (§5c). **Both modes stay.** | `run.mjs stream-page --far …` on staging; pictures looked at | all of the above | comparison written; the owner's pick listed in §10 |
| 46d.8a | **Measurement:** the whole of 46d against §4 at the cap, both renderers: slice, town, flight on the 8 km world, per tier (texel density, relief, far field), texture and page memory, gate and e2e time; misses with causes. | `run.mjs` on staging | §4's table again | numbers + causes in §8 |
| 46d.8b | **Docs and acceptance page:** `voxel-render-spec.md` complete (material record, texture sets, relief part, far data, each step with its owner note), requirement traceability (R88, R89, R111, R112 and the 46d rows), manual (`features/voxel-worlds.md`: materials, texture sets, relief, far field switch, tiers; the material guide of the authoring package updated for heights, depth and surfaces), reference regenerated (`node tools/gen-reference.mjs`); acceptance shots and README in `~/.cache/thirdlight-phase46/acceptance/46d` for review page acc46d (both renderers; near relief, wetness, kit pieces textured, mountains at 1/3/5 km both modes). | check-docs, `tools/manual-links.test.mjs` | — | pages match the code; acc46d ready |
| 46d.9 | **Close (lead):** full gate once (detached, `TL_VITEST_WORKERS=4`), independent review (fresh agent), High/Medium fixes on fast gates, acceptance page acc46d to the owner, STATUS row; then 46e only on the owner's word. | full gate | gate time and peak vs 34 min / 8.0 GB; voxel e2e time | review in the decision log |

## 6d. 46d-b follow-ups (owner 2026-11-09)

Before 46e. One agent each, fast gate per item, one closing full gate + review at the end of 46d-b.

| Item | Builds |
|---|---|
| 46d.10 | Height in the albedo's alpha (arrays, shaders, relief/height lighting, placeholder generator, kit sheets, import, docs); texture layout v1 amended add-only with an owner note; the normal map keeps no height. |
| 46d.11 | Relief displacement off on every tier (switch kept, height-map lighting stays); blend distance: world default + per-material override, smaller value wins where two meet, live without remesh. |
| 46d.12 | Brick far field quality spike (the chosen direction): why it turns to mush (resolution tied to node size, built from mips, one material a coarse sample); bricks from full-detail surfaces, brick resolution by screen size, colour per sample, cost on the Iris Xe; pictures vs 46d.7c at the same poses; a verdict for 46d.13. |
| 46d.12b | done (55ad23cf + tune 81b291a9): realistic `far-world` default (terraced behind `--style`), 644 MB, on staging. Pictures both modes/renderers + 6 near (§8, seen): mesh rings everywhere, bricks only on far lowland; D571 both modes (thin top cells: mesh 55–62 %, bricks 2–35 % non-grass L2–L6). Baseline: meshes 0 missed orbit, bricks 22–24 / 56–71 |
| 46d.13 | Brick far field built on 46d.12's verdict as the default far field (cost, detail, edges D556/D558, memory D557), measured; the mesh field stays only as the fallback behind the switch. |
| 46d.14 | Mesh fallback revision (the ~1/4 triangle cut, view culling D550) — only if the fallback is still needed after 46d.13; else deferred with a note. |
| 46d.16 | (owner 2026-11-10, vista pass step 0; WebGPU) A GPU headroom meter that works at the 60 Hz cap (D544 rules out timestamps): load a chosen pass N times or raise the render scale in steps until the orbit misses; a frame-budget table per pass (near surfaces, far march, shadows, post) on the Iris Xe at 720p — the baseline 46d.17–46d.20 report against. |
| 46d.17 | (vista step 1, compute, WebGPU) Stop the far field's wasted work: far node boxes as rows of the existing culled-instance table (`occlusion-instances.ts`; frustum + depth pyramid in compute, indirect draws), no nodes wholly under the near cover, depth reject before the march (F2), normal baked into the atlas (F4), a cheap far shading (sun, ambient, fog), unused reads (F6) and uploads (F7) — each re-checked against 46d.13c-3 first. |
| 46d.18 | (vista step 2) Bricks baked at world-bake time into the far cache (distance, colour, normal per node; edited nodes re-baked only); the runtime job becomes decode + upload. Edits (owner design 2026-11-10): the bake is the same builder code run ahead of time (identical bricks from identical voxels, or edited nodes seam against baked neighbours); an edit dirties its node at each level plus border neighbours, workers rebuild those while the old brick keeps drawing; rebuilt bricks stored beside the save, keyed by their source voxels' content, so a much-edited save does not rebuild every load. A compute brick build for edited nodes tried and measured against the CPU job. Far cache version bump, add-only, with the owner's note (instruction 2026-11-10). Target fill < 10 s (today 48–80 s). |
| 46d.19 | (vista step 3, WebGPU) Near surface shader and submission (also: measure near voxel chunks as static casters in `cached-shadow.ts` and whether its reach and invalidation fit chunks and edits — terrain shadows are an owner proposal, not decided): near chunks and seams as rows of the same culled table, one indirect draw a level (N4); fast paths per chunk/draw (single material, one projection, cheap levels 1–2; N1), a position-only depth prepass (N2), packed vertices read directly (N3), mip nodes without collision/nav/light and a cheap hash (N5). May split a/b. |
| 46d.20 | (vista step 4) The far pass shaped like Enshrouded's: the march writes a visibility target (brick id, depth), one far shade with fog (full-screen pass or compute, by the meter); culling and visibility feedback in compute (per-node seen/error in a storage buffer, read back a frame or two late); half resolution with reuse (D574) only if 46d.16 asks; far motion output for TAAU checked in a moving shot. The largest item; starts on 46d.17's numbers. |
| 46d.21 | (owner 2026-11-10) The low tier as the Iris Xe target: render scale ~0.667 + the temporal upscaler, everything else cheaper, capped at 30 Hz; the meter measures low against that cap (`headroom --quality low`); a stated page + GPU memory ceiling for low only; medium/high reported as shares and scaling, frame times "unverified on target hardware". Runs right after 46d.17. |
| 46d.22 | (owner 2026-11-10) Coverage at 150 m/s: a world is kept round the moving camera at some quality (no hole, ground and collision under the camera). Candidates: top far levels of the whole world kept resident, motion prefetch scaled with speed, near levels 1–2 before 0 at speed, collision along the velocity first; a 150 m/s bench that asserts coverage (D584, D585). After 46d.18 (baked bricks). |
| 46d.23 | (owner 2026-11-11) Low's memory: the ~4 GB total budget replaces the 1,024 / 1,280 MiB ceiling (split page/GPU proposed from measurements); starting values to measure: voxel stream budget 256 → ~768 MiB, far GPU budget 96 → ~384 MiB, texture residency 256 → 512 px/m; medium/high raised at least to match (unverified on target hardware). What each buys measured with the coverage and headroom benches. D597 stays a retention check (heap 396 → 1,119 MiB over one 60 m/s flight): trace what holds it, whatever the budget. After 46d.19, before 46d.20. |
| 46d.15 | 46d-b close (lead), after 46d.20: `gate.sh phase a376c761` (whole vitest + areas touched + core smoke); full only for the merge to main or on the owner's word; review, fixes, acceptance acc46d-b (pictures and numbers on WebGPU; WebGL 2 a load-and-draw smoke). |

### 46d-c (owner 2026-11-11)

After the 46d-b close, before 46e (`docs/briefs/streaming-rings-2026-11-11.md`; §2 and §9 entries of 2026-11-11).

| Item | Builds |
|---|---|
| 46d.24 | Travel at speed by the owner's new measures (the coverage bench keeps its hole check): longest frame in flight, frames over 100 ms, missed a minute; after a stop the seconds until the ground under the camera is solid, full detail stands (~50 m), nothing is pending; never falling through. Mechanisms in order: no level 0 at speed, stale work cancelled, collision on its own path along the bodies' velocity, a coarse fallback floor from the far field's 2 m data, D585. Pinned regions and path hints planned, built only if cheap. 60 and 150 m/s, low and medium. |
| 46d.25 | Fine bricks (levels 0–1) built in GPU compute past the detail ring, on demand from the chunks' voxel grids, never stored, behind a switch beside the level 1–2 mesh rings; compared on WebGPU, low and medium (D593 and 46d.12b poses by picture, the headroom meter, fill, 46d.24's measures, memory) before any mesh ring or seam is retired; say if the level 1 → 2 boundary shows. |
| 46d.26 | Bake level per world (26a), baked fine levels read at run time (26b), the final comparison (26c): A mesh rings, B compute bricks, C baked 0.5 m on WebGPU low and medium, 13 poses, travel, meter, memory, a baked export; verdict for the owner in `docs/briefs/fine-bricks-comparison-2026-11-12.md` |

## 7. Progress

| Item | Status |
|---|---|
| 46d.1a | done: §4 baseline re-measured (§8). Spike relief mesh (`relief-mesh.ts`, `?relief=n`, `run.mjs relief`): crack-free with plain neighbours, crease weights, other outputs byte-equal (vitest). Ring 32 m slice/hilly 4/16/64× triangles, town 18/69/276× (merges lost); n = 8 fills the low budget. Relief µs p50 0.3/1.0/4.0 ms a section. No displacement yet |
| 46d.1b | done: vertex displacement both renderers + shadow pass, crease attribute, grown bounds, ring fade, test heights; normal from heights on all surfaces. Town n = 2/4 at 32 m: GPU +0.8–1.1 / +0.5 ms WebGPU, ±0 / +0.5 WebGL 2, 0 missed; the vertex stage itself ~0.1 ms. VERDICT: low normal only, medium n = 2, high n = 4, 16–24 m section ring; n = 8 rejected (§8, D528) |
| 46d.2 | done: format spec split (D496), docs only: kits section + §3.9 kit record moved unchanged to `voxel-kit-format.md` (264 lines), `voxel-render-spec.md` skeleton (material record, texture sets, relief part, far-field data); main spec 2,225 → 1,983 lines, pointers left; links re-pointed in the spec, requirements and role spec |
| 46d.3a | done: `MaterialDef` gains `physical`, `gameData`, `voxel` (id, use, kit, tile, height depth, wall/floor/ceiling sets), canonical round trip tested; engine + project profiles with their commands; voxel_id_taken, kit_missing; kit binding from `voxel.kit` (kit list for unnamed ids). Record 414 B; 4,095 voxel materials load in 63 ms, an edit 5.5 ms |
| 46d.3b | done: voxel table from the records (colour, tile, depth; stand-in for the rest), a record edit re-uploads the table only (0.8 ms, 0 meshes; seen WebGPU + WebGL 2); `ctx.voxels.materialAt`/`materialOf`; badges, `f:` filter, voxel-only picker, Inspector voxel section; every voxel material ships with a world. voxel-world e2e 65.6 → 70.8 s |
| 46d.4a | done: albedo+height, normal and ORM arrays from every voxel material's wall/floor/ceiling sets (slot assembly, KTX2 cache), layers in the table; floor/ceiling/wall by face, grid 4 m, terrain triplanar 2 m; patterns under `?patterns=1`; Play/export ship `voxelTextures`. 6 units. Town GPU WebGPU 3.4 → 4.1 ms, WebGL 2 4.7 → 4.8, 0 missed. Seen both renderers |
| 46d.4b | done: quality field `voxelTexelDensity` (low 256, medium 512, high 1024 px/m) caps each voxel array (4096²: levels 2/1/0); arrays stream per level under `texture_budget_mb`, need from the chunks; builds ship them cut; Play, export, Scene view, voxel world page. 2048² sets: 24/96/96 MiB per tier, switch 0.93 s, 0–2 missed; GPU ±0.1 ms. 4096² not assemblable (D532) |
| 46d.4c | done: D532 fixed (4096² in UASTC stripes, 14–49 s a map, mean error ≤ 1.4/255). Kit pieces wear their GLB material (sheet extracted to KTX2, trim U on every map) in Play, export, Scene view, page; debug sets only under `?trimDebug=1`; kit crack maps by brightest texel; Blender export writes the images. Town draws 1,857 either way, GPU ±0.2 ms. D535–D537 |
| 46d.4d | done: D531 height = normal map's A only (record map renamed `albedo`); heights blend in metres (1 cm contrast), relief reads the normal array; R111 wetness (darker, smoother, flatter, water in the low parts by height). D535: textures to 65.3 MiB. Town GPU 3.81–3.85 / 4.42–4.43 ms (46d.4c 3.66 / 4.48); WebGL 2 3–5 missed (D540). Seen both renderers; pieces dry (D538) |
| 46d.5a | done: relief part = derived v29; ring per 8 m section round the focus (hysteresis, atomic re-plan, bodies stand), `levels.relief` 16 m scaled, `voxelRelief` low 0/med 2/high 4, setRings; own 1/8 budget share, ring shrinks (D528 fixed). Town med/high: relief 12.9/106 MB, 1.29/4.10 M tris, `render()` +0–1.1 ms, 0–7 missed; shadows main-thread bound (D529). D541, D542 |
| 46d.5b | done: relief displaced in Play (worker + page), exports, Scene view (its quality level) and the voxel world page (tier default, relief switch); batches carry the ring (steps, radius, centre). High ring 24 m (relief scale 1.5). Town GPU med/high 4.26/4.36 WebGPU, 4.42/5.05 WebGL 2, 0–7 missed. D541 fixed; D542 cause found (kit pieces); D543. voxel e2e 64.2 → 83.2 s |
| 46d.6a | done: kit pieces drawn across chunks, one instanced draw a piece kind (49 in the town, was 1,466), culled by chunk per pass (view, shadow), written once a batch; pieces wear their cell's wetness (D538). Town `render()` 10.2–11.8 → 2.7–3.2 ms, shadows 15.5–20.3 → 4.1–4.6 ms (D529 fixed); GPU +0.6–2.5 ms (D544); high+shadows GPU-bound (D545). e2e 83.2 → 82.3 s |
| 46d.6b | done: D544 traced (timestamps follow the GPU clock; pieces now draw after the surfaces, −0.3 ms). Piece draws are column-instanced copies the WebGPU culler tests against the depth pyramid (71 % of 35.4 k culled): town GPU 5.6–7.0 → 3.5–3.8 ms, `render()` +0.7 ms (D546); WebGL 2 keeps chunk culling. D485 closed; D545 re-measured. Same pictures |
| 46d.6c | done (0c85d3a8): D526 fixed. Owned body faces merge with blended ones, the rectangle owned whole (derived 30); roof mesher scans plane cells once, typed vertex table. Town roofs: base 468,872 → 415,636 tris (46c.16d 417,396), mesher p50/p95 296/728 → 213/545 µs (238/577). D519 holds. Town at cap 0 missed, GPU within drift. D545 proposal in its row |
| 46d.6d | done (4635510e): D545 fixed. Relief chunks cast from their plain surfaces (shadow-only draws, 46.9 k tris for ~2.4 M at high), relief meshes cast none and read shadows at their plain place; one draw path. Town high + shadows missed 13–15 / 4–8 of ~430 (relief casters same hour 27–30 / 38–39); pictures equal (0.00 %). D547 |
| 46d.7a | done: `run.mjs far-world`: 8.2 km mountain world (peaks 1.51 km, cliffs, overhangs, town at centre) written per region column in 4 workers, 476 MB (7.1 MB/km²), 249 s; far cache L2–L8 (`far-tree.ts`, region files) 48.5 MB (0.72 MB/km²), 255 s; peak 2.2 GB. Selection by screen error + hysteresis + budget; edit rebuilds exactly its ancestors; doors/windows close at L1+ (v31) |
| 46d.7b | done: D548 fixed (backend opens worlds on demand: 8 km world 0.65 s, 264 MB). Far field as meshes (`far-field.ts`, `far-mesh.ts`, `voxel-far-mesh.ts`): cache served, rebuilt per command (190–350 ms), shipped; 40 draws (D549 fixed), no cut-off (D463, D516 fixed). Medium 4 px: 5.0 M tris, 0 missed orbit, flight 16–18 missed; high 3 px 8.1 M. D550–D553 |
| 46d.7c | done: `farField=bricks`: far nodes as sparse 8³ distance bricks in workers (13.9 of 64 a node), one shared atlas, a box a brick marched in the fragment with its own depth; one path both renderers, switched at run time. Medium: 36.9 k bricks, 98.8 MB GPU, fill 16 s, orbit 18–39 missed (GPU-bound, D555; hidden 0), flight 21–26. D555–D557 |
| 46d.7d | done: `far-field-comparison.md` for the owner; same-hour re-measure, medium, both renderers: meshes 0 missed orbit, heap +0.74 GB, fill 13 s; bricks 17–24 missed (GPU march), heap +0.1–0.2 GB, fill 16 s; flight 18–22 both. Silhouettes 1–5 km alike (1–4 % px). Side-by-side pictures. Lead pick: meshes default, bricks kept; no hybrid. D558 |
| 46d.8a | done: §4 again at the cap, both renderers, per tier (§8): town `render()` 9.1 → 2.8–3.0 ms, 0–1 missed every tier; village 0 missed; 8 km world 0 missed orbit low/medium, high 2–13 (D550), flights 15–36 missed (D550/D551); arrays 24/96/96–384 MiB. `voxel-world.e2e.ts` 88.5 → 70.7 s (assembly proof merged, export once at high, …). Render/format spec, manual. D559 |
| 46d.8b | done: requirement trace (render spec §5; R88/R89/R111/R112/R27/R28 rows re-pointed), material-set guide (`voxel-kits.md` §1), art-factory request update; acc46d: 62 shots × 2 renderers (WebGL 2 ≤ 0.4 % px apart but Scene view orbits), README + approve-46d.md, published. Seen wrong: D560 (town edge gap), D542, D533, D553, D556, D558 again. D539 pictured dry |
| 46d.9 | done: full gate GREEN (35 min vs 34, 8.0 GB, 868 vitest files, 392 e2e). Review 0H 3M 8L: D559 traced + fixed (column waits for every section), D552 fixed (far builds in workers, commands go on, export waits ≤ 2 min then warns), acc46d lists all 116 defaults; L1–L7 fixed (D561–D564), L8 deferred (D560). voxel e2e 70.7 → 71.1 s |
| 46d.10 | done (f05807ba): height in the albedo's A (layout v1 amendment 1); albedo array a height array (brightness height for an opaque albedo, the layered rule); shader, relief vertex stage, placeholders, kit sheets (OPAQUE GLB, Blender keeps A) moved; normal A unused. Shipped A error 4.4/255 at 256² (ETC1S), 0.2–0.4 at 4096² UASTC. Fast gate GREEN; e2e 71.1 → 70.8 s |
| 46d.11 | done (ee2ba690): relief off on every tier (`RELIEF_STEPS_BY_TIER` 0; `voxelRelief`, ring, page switch kept): town high 3.17 M → 802 k tris, stream 221 → 116 MB, no relief mesher; medium 1.25 M → 802 k. Blend: `voxel.blendMetres` + `voxelWorld.blendMetres` (0–0.5 m, default 0.25), narrowest of the 8 cells wins, live (uniform / table only). e2e 70.8 → 71.8 s |
| 46d.12 | done (0c1be6cb, spike): mush traced — bricks built from the node's own mips (town roofs 9.0 m low at 512 m nodes; from children 3.6 m), not sample spacing (2.2–2.8 px/sample already). `?farBricks=faces2`: children's face field, tight bounds, colour blend + field AO; D556/D558 gone. Fill 16 → 49–55 s, orbit 17–23 (WebGPU) / 64–121 (WebGL 2) missed. Verdict §8 |
| 46d.12b | done (55ad23cf + tuning): `far-world` style `realistic` (default; `--style terraced` keeps the old): stream-power drainage (32 m grid, same in every worker: seams exact), gullies, scarps, crags, rivers + floodplains, outcrops, boulders, 31 arches, snow (id 7). 644 MB (9.6 MB/km²), 463 s; cache 54.1 MB, 253 s; peak 2.6 GB. On staging. Mesh rings = D571 |
| 46d.13 | done (ea5a0542 … 2ce43208): v3 bricks the default far field, meshes the fallback; D569/D577 fixed; Play fill 142 → 79 s, far GPU budget per tier. 13c-4: D582 was a camera inside the massif; the near field's level choice no longer freezes in a fast flight (0 chunks drawn → back 8 s after), far refines a level a step, ring first. D582 fixed; D583 open (high: GPU), D584–D586 |
| 46d.14 | deferred (lead 2026-11-10): bricks are the default; the mesh fallback is not revised. Its flight OOM stays D581. The vista note's §5 gate replaces it: if 46d.16's meter shows the bricks cannot reach their budget, the top levels become a simplified height-field mesh |
| 46d.16 | done (ba27e91c): headroom meter at the 60 Hz cap without timestamps (ballast to the edge, passes hidden/copied past it; `run.mjs headroom`). Iris Xe 720p town orbit: medium room 0.7–2.5 ms of ~14–16; far 39–50 %, near 28–33 %, post 19–24 %, shadows 2–4 %; ms ±40 %. High ~23–31 ms: D583 = GPU-bound, far hidden holds the cap. D587, D588 |
| 46d.17 | done (73adedac, 287ed0d2): far node boxes rows of the culled table (frustum + pyramid in compute, far depth, drawn after the pyramid; auto culling on with a far field), covered nodes left out, depth reject before the march, F6. Medium room 0.7–1.8 → 4.5 ms, frame GPU 15–16 → 12 ms, far 6–8 → 4.4 ms; high 17/127 missed (D583). d, e measured, not kept; pictures 0.00 % >60 |
| 46d.18 | done (f50e6ab2, ead1c53a, 5c51b45a, e3dd1ec9): TAAU on low/medium WebGPU (D591/D592). Far cache format 2 bakes every node's bricks (8 km: +300.9 MB zstd, 1,421 s staging; projection 270 MB); job 74 → 0.3 ms, Play fill low 31 → 8.5 s, medium 79 → 16 s (D596); edits rebuild farBrickDirty, reuse by content. Pictures same (0.00–0.73 % >60). D594–D597 |
| 46d.19 | done (84c60578 D600, a3639669): D600 fixed (TAAU hold never started: pose bits; a late stop of an earlier play). Per-draw programs (1 set / 1 projection; levels 1–2 one axis), chunks+seams culled-table rows. Low room 21.5 → 23.2–24.2 ms, medium 7.6 → 6.6–7.6; near share below the meter's noise. c, d, e measured, not built; static casters +1.6 ms low. Pictures ≤ 0.26 % >60 |
| 46d.20 | done (46872194; 14617da1, f7a9df90, f2d6a1eb): visibility pass + one shade; feedback: compute counts each brick's pixels + nearest depth, read back late, versioned, to the far tree (seen-coarse refined first, unseen wait; released near the GPU budget only). 8 km low: 1,037 nodes, 77 MiB unchanged (budget never binds); release at any fill churned (D608). D598 not helped |
| 46d.21 | done (52caccdc, c6d0925e): D590 fixed (the sky follows the camera). Low = 0.667 + dyn res, TAAU where the look anti-aliases else MSAA + FSR 1, 30 fps level cap (`frameRateCap`), shadow map ≤ 2048; ceiling 1024 / 1280 MiB heap / GPU. Iris Xe town orbit at 30 Hz: room 15–23 ms, 0–3 / 239 missed, flight 12 / 1197; heap 614 → 834, GPU 880 → 1105 MiB. No TAAU ghosting seen. D591, D592 |
| 46d.22 | done (75f78691, 28c1aa66): D593 fixed (low's load ring + level 1 at medium's reach). `run.mjs coverage`: 9.8 km at low 30 Hz, every frame. 150 m/s: holes 0–4 → 0 frames; ground under camera missing 97 → 15 % of updates (60 m/s 58–95 → 0–1 %): ring narrows with speed, work along the way ahead. Live heap 60 m/s hug 1,119 MiB over 1,024 (D597); D585 seen hugging; D598 |
| 46d.23 | done (dd09676d, 85428e3f): D597 fixed (removed voxel meshes kept by three's render objects): 60 m/s hug heap 395 → 1,132 became 428 → 656, home 633 MiB. `LOW_MEMORY_BUDGET_MIB` 4096 = page 1536 + GPU 2560; low stream 768, far 384, 512 px/m, medium/high ≥ low. None binds on the 8 km world (0 evictions, 0 held, 1024² sets): same pictures, room 25 → 24 ms. D604–D606 |
| 46d.15 | done (d484d1d2 … e9581c15, 57522215): phase gate GREEN gate-phase-20261111-144708 (23 min vs 35 full), review close-after-fixes, fixes H1 H2 M1–M3 L1–L8 (H3 superseded by the owner), M5 export at low 2.1–2.5 of 4 GiB, acc46d-b published (16 poses, 2 strips, WebGL 2 smoke) |
| 46d.24 | done (24a–24d; 72f2cee5): export low: longest 40–49 ms, ground 0.03 s, pending 7.2–8.6 s, 0 through; full detail 3.6–4.8 s with the mesh rings. Final (26c, Play): baked 0.5 m 3.7–4.0 s; < 2 s met only with a ~32 m detail ring at low (1.9–2.0 s, owner's call); D620 stays open for it |
| 46d.25 | done (25a–25c; d7320305): compute fine bricks L0–1 behind `fineBricks` (off); ON does no mip work (D633). 26c: on a 2 m world they do not beat the mesh rings (full detail 0.5–1 s later at low, up to ~3 s at medium); kept behind the switch, B in the final comparison |
| 46d.26 | done (26a–26c; 26c 9bc95e2a, 1bfd05e1): bake level, baked fine read, read ring to the detail reach. Final (Play, 2 rounds): low detail C 3.7–4.0 / A 5.0–6.0 / B 6.1–6.7 s, medium C 11.6–13.5 / A 16.7–30+ s; C +0.3 GiB, 64 MB/km² more in an export. D640 fixed. Verdict (ii): bake 0.5 m for new worlds, rings stay for 2 m; nothing retired |
| 46d-c review fixes | done (4644fca4 … 6b947726): phase gate's units fixed, WebGL 2 keeps the rings unless 0.5 m draws past the ring, `fineBuild` (off), D635 fixed (one look rule), failed bakes answered, D641 traced (stop altitude): baked export full detail 2.1–2.3 s at low against 4.8–5.4 s with the rings. D637, D643, D644, D599 open |

## 8. Results

### 46d.1a baseline and the denser near-ring topology

**§4 baseline, re-measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, 2026-11-08 06:27–06:50, load 0.8–3.1,
uptime 15.6 d; scratch `~/.cache/thirdlight-phase46/work/46d.1a/`; town = R9's view and ~480-frame orbit, village =
46c.16g's two houses on the slice world; the page was built from the item's tree with relief off, which changes no
output):

| What | Re-measured |
|---|---|
| Town at the cap, WebGPU / WebGL 2 (2 rounds) | `render()` CPU p50/p95 9.1–9.2/10.2–10.3 / 9.2–9.6/10.6 ms; GPU 3.35–3.40 / 4.72–4.78 ms; 0 / 0 missed of 479; 43,711 instances, 1,466 piece draws, 1,319 draw calls, 842,024 triangles; stream 124.8 MB (derived 84.2, mips 32.0, kits 6.1); derive job µs p50/p95 3,000–3,100/9,500–9,800 |
| Village (slice), WebGPU / WebGL 2 | `render()` 1.7/1.9 / 1.6/2.0 ms; GPU 7.33 / 4.0 ms; 0 missed; 785 instances, 110 piece draws, 177 calls, 379.8 k triangles; 79.0 MB (derived 42.5, mips 23.5) |
| Flight (`run.mjs stream-page`, hilly 2 × 2 km, 60 s, 1 round) | 40 m/s: 1 / 1 missed of 3,600 (WebGPU / WebGL 2); 80 m/s: 0 / 1; stream 11.0–13.2 MB |
| Mesher µs a 16³ section with ground p50/p95 (`run.mjs mesher`) | slice 217/313, town 239/332, hilly 226/488, caves 349/662 |
| Roofs (`cases --roofs --fill`, town 512², 1,070 sections) | roof pass 287/737 µs, derive 997/1,564 µs; base triangles 468,872 (unchanged) |
| Voxel surface textures | grid 3D textures 23.1 MB (town view) / 19.8 MB (village); material table 128 KB (Float32 RGBA 64 × 128); pattern array 64 KB; crack array 256 KB a layer (512² R8); kit textures 5.94 MB (trim debug set) |
| Far field | load box 192 m, nothing past it (D463, D516) |
| `voxel-world.e2e.ts` / full gate | 65.1 s (gate 02:17, 46c.17) / 34 min, 8.0 GB (46c close) |

**Built (spike, no format version).** `@thirdlight/voxel` `relief-mesh.ts`: a level-0 unit's ground and base
surfaces split until no edge spans more than 1.5 / n cells on any axis (a triangle with every edge too long into
four, else its longest such edge halved; whether and where an edge splits depends on that edge alone, so two
sections split a shared edge alike); base faces drawn unmerged first (`baseSurface(…, merge = false)`), so a face is
an n × n lattice; roofs split along their merged rows. A crease weight a vertex (0 fixed, 255 free): base from the
voxels round each lattice point (`baseCreaseRule`: a face that does not continue flat, roof contact), ground from the
terrain mesher's crease vertices (`TerrainCreases`) and every vertex within half a cell of a wall, beam or rail,
roofs from their own triangles (turn > 30°, open edges), wall contact and a one-cell margin at section faces. Toward
plain units (26 neighbours, `plainNeighbours`) shared edges stay whole and fixed. Derived as `DerivedData.relief`
(level 0, outside the canonical bytes), joined into the draw (`JoinedDraw.relief`, crease joined too), drawn in
place of the surfaces by `ChunkDrawBatcher`, read by the seams; collision keeps the plain ground. Page switch
`?relief=n&reliefRadius=m` (chunks within m of the focus when derived, plain chunks named to the worker), state
`reliefUs`. Bench `run.mjs relief`.

**Tested** (`packages/voxel/src/relief-mesh.test.ts`, `tools/voxel-bench/relief.test.ts`, 18 s alone, ~1 GB): an
n × n lattice a face; shared edges split alike; edges ≤ 1.5 / n; plain faces kept whole and fixed; a section's plain
neighbours from its chunk's; on slice, town (ground, roofs), hilly and caves (near the surface, deep), each a
2 × 2 × 2-section window straddling chunk faces (16³ sections, world rules), for n = 2, 4, 8 every relief edge with other than
two triangles lies along plain edges with as many (no crack, no T-junction, across section and chunk faces), area
equal (3 decimals), copies of a point with different normals all fixed and same-normal copies one weight (ground
and bodies together), every other output's canonical bytes equal with relief on and off, mixed relief/plain
sections crack-free with their border vertices fixed; deterministic.

**Measured, Node** (`run.mjs relief --rounds 2`, 6 GB scope, 06:50–06:53, load 1.9–3.4; ring = sections within the
radius of the camera, sections with surface; derive µs = the whole derive of a relief section):

| world, radius | sections | triangles plain → n = 2 / 4 / 8 | ring MB plain → 2 / 4 / 8 | relief µs a section p50/p95 n = 2 / 4 / 8 | derive µs p50 plain → 2 / 4 / 8 |
|---|---|---|---|---|---|
| slice 16 m | 20 | 10.7 k → 44 k / 175 k / 694 k | 0.14 → 0.58 / 2.2 / 8.8 | 485/4,294; 1,250/2,308; 4,318/10,314 | 726 → 1,197 / 1,939 / 5,082 |
| slice 32 m | 76 | 32.7 k → 133 k / 526 k / 2.09 M | 0.43 → 1.7 / 6.7 / 26.4 | 281/468; 990/1,411; 3,899/6,766 | 637 → 941 / 1,628 / 4,545 |
| slice 64 m | 286 | 115 k → 463 k / 1.84 M / 7.34 M | 1.5 → 6.0 / 23.4 / 92.7 | 265/387; 944/1,139; 3,883/5,066 | 639 → 916 / 1,590 / 4,528 |
| town 16 m | 46 | 20.3 k → 440 k / 1.74 M / 6.92 M | 0.35 → 5.8 / 26.1 / 123 | 836/11,316; 2,284/41,437; 9,663/170,789 | 710 → 1,839 / 2,963 / 10,350 |
| town 32 m | 136 | 57.3 k → 1.00 M / 3.98 M / 15.8 M | 0.94 → 13.3 / 59.8 / 274 | 320/6,085; 1,004/26,813; 3,965/113,090 | 625 → 957 / 1,672 / 4,701 |
| town 64 m | 538 | 228 k → 4.40 M / 17.5 M / 70.0 M | 3.8 → 58 / 261 / 1,218 | 315/6,766; 999/24,306; 4,140/113,783 | 638 → 957 / 1,695 / 4,989 |
| hilly 32 m | 69 | 32.7 k → 131 k / 520 k / 2.07 M | 0.42 → 1.7 / 6.6 / 26.1 | 303/442; 1,028/1,150; 4,141/5,093 | 661 → 981 / 1,687 / 4,803 |
| hilly 64 m | 285 | 115 k → 460 k / 1.83 M / 7.29 M | 1.5 → 6.0 / 23.3 / 92.0 | 265/377; 957/1,113; 4,025/5,258 | 637 → 904 / 1,589 / 4,689 |
| caves 32 m | 101 | 56.6 k → 198 k / 777 k / 3.09 M | 0.81 → 2.7 / 10.1 / 39.4 | 276/776; 869/2,813; 3,562/12,573 | 589 → 883 / 1,471 / 4,156 |
| caves 64 m | 449 | 305 k → 1.02 M / 4.04 M / 16.1 M | 4.5 → 14.2 / 53.2 / 207 | 299/949; 1,027/3,598; 4,099/14,314 | 633 → 933 / 1,661 / 4,793 |

Terrain and the slice grow 4 / 16 / 64× as the lattice says; the town 18–22 / 69–86 / 276–340×, because its plain
base merges coplanar faces (a whole floor two triangles) and the lattice cannot; a dense town section (p95) takes
0.4 / 2.4 / 9.4 MB and 6 / 27 / 113 ms. The mesher budget (0.1–0.2 ms a section) holds for none: n = 2 adds ~0.3 ms.

**Measured, browser** (staging, town view and orbit, `?relief=n` at the default 32 m, 06:55–06:58, load 2.5–5.4, one round each):
n = 2: 1.66 M triangles drawn (842 k plain), stream 156.8 MB (derived 116.2), `render()` 9.1/9.9 (WebGPU) and
9.9/11.0 ms (WebGL 2), GPU 3.85 / 4.90 ms, 0 missed, relief µs a section in the workers p50/p95 1,400/18,300–23,400;
n = 4: 4.10 M, 248.8 MB, GPU 4.90 / 4.63 ms, 0 missed, 2,500–2,800/49,100–52,100 µs; n = 8: the low tier's 256 MB
stream budget fills and holds the ring back (120 piece draws instead of 1,466, 5.54 M triangles, most of the town
missing: seen), 6,600–8,400/130,000 µs. Village (two houses near, n = 4): 1.14 M triangles (380 k), GPU 9.84 / 4.37
ms, 0 missed. Memory of the ring is the derived share (+32 MB at n = 2, +134 MB at n = 4 over the town's 84 MB).

**Looked at** (`shots/`, both renderers): `relief4-log-house-near`, `relief4-stone-house-near` against `base-*`:
the same pictures (1.1 % / 0.8 % of pixels differ, at most 4 by more than 24 levels: normals interpolated over the
finer triangles), no crack or gap at walls, roofs, the foundation or the ground; `relief2/4-town-mid` the same near,
differing only on the horizon (far nodes streamed at another moment under the fuller budget); `relief8-town-mid`
shows the budget cut. Displacement is 46d.1b: nothing moves yet, so the crease weights are tested, not seen.

**Gate:** gate-fast-20261108-070711 GREEN (13 min, 5.1 GB; perf 0 missed both renderers); `scan-bounded-log` (D307,
D418) and `world-host` (D484) failed once under load and passed alone. `voxel-world.e2e.ts` 65.1 → 64.6 s (no e2e
change). A first gate (06:59) was OOM-killed at 7 GB: the first relief test kept whole n = 8 chunk windows as JS
arrays; it now checks 2 × 2 × 2-section windows in typed arrays (~1 GB).

**For 46d.1b:** the crease weights travel in `JoinedDraw.relief.{ground,base}.crease` but not yet on the chunk draw
wire (`ChunkDrawBatcher` sends the relief positions only); the vertex stage needs them as an attribute. Expect
roofs undisplaced in a 1 m stripe at section faces and ground fixed within half a cell of walls (both by design).

### 46d.1b vertex displacement and the verdict

**Built.** The chunk draw carries the relief mesh's crease weights (`DrawSurface.crease`, transferred with the batch)
into a `voxelCrease` attribute (`VOXEL_CREASE_ATTRIBUTE`); only relief draws have it. The voxel surface takes an
optional height array (`heights`) and a relief per material look (layer, depth in metres; a third table block); with
it, (1) `positionNode` moves a relief vertex inward along its normal by the recess
(1 − h) × depth, blended between the two heaviest materials by the surface shader's own blend (`blendAt`, the same
nine grid reads and owner cell, so both sides of a seam move alike), × crease × the ring's fade (smoothstep over
`fadeStartM`–`fadeEndM` from a focus in each object's own metres, so the shadow pass fades alike), the heights read at
the mip whose texel is as wide as the vertex spacing (`log2(cell / n · size / tile)`); a draw without the attribute
builds none of it (program per attribute set). (2) Every surface's lighting normal follows the heights: the recess at
full resolution (implicit mips) bends the view normal by its screen derivatives (surface gradient in metres;
geometry normals never rebuilt). Three's shadow pass takes the material's `positionNode` (checked against r187's
`_getShadowNodes`; row in `docs/three-upgrade-checklist.md`). Bounding spheres of relief geometry grow by the deepest
relief (`reliefDepthM`). Test heights `voxel-relief.ts` (engine-owned, made by code at page load, not shipped):
brick, stone (Voronoi cobbles), plank, rock (ridged fractal), sand (ripples); 1024² R8 a layer, tileable,
deterministic; one `r8unorm` array texture, mipmapped on the GPU: 5.2 MB + mips ≈ 7.0 MB GPU, no file (asset-less);
material → layer and depth by the bench worlds' ids (rock 12 cm, stone 6, roof tile 4, brick 3, sand/soil 3, grass 2,
timber/plank 2, plaster 1). Page: `?relief=n` displaces, `?reliefFade=a,b`, `?displace=0`, `?bump=0`, `?shadows=1`
(2048² sun map over 80 m round the focus), hook `setRelief`, state `relief`, `vertices`, `reliefVertices`
(`page-view.ts` holds the page's relief, sun and input). Bench `run.mjs relief` reports the share of free vertices
(n = 4, 32 m: slice 98 %, town 61 %, hilly 100 %, caves 87 %).

**Tested** (`packages/three-adapter/src/voxel-relief.test.ts`, real relief derive of 16³ sections joined): crease
attribute = the derive's bytes / 255; bounds = plain sphere + 12 cm; the vertex program reads the heights 6 times at an
explicit level and the grid 10 times on WGSL, 6 `textureLod` on GLSL; a plain chunk's vertex program reads nothing;
`_getShadowNodes(material).positionNode` is the material's and a shadow-pass-like material built with it displaces;
no heights → no position or normal node (programs unchanged: `voxel-surface.test.ts` counts unchanged); the test
heights deterministic, tileable, using the range. Fast gate gate-fast-20261108-074413 GREEN (13 min, 4.3 GB; perf 0
missed both renderers); `edge-cases.test.ts` timed out once and passed alone (D523 watch). `voxel-world.e2e.ts`
untouched (64.6 → unchanged; no e2e change).

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, 2 rounds of town (R9 view, 60 m out, ~480-frame orbit) and
village, 07:58–08:40, load 1.7–5.1, uptime 15.6 d; relief ring 32 m = chunks whose centre is within it, displaced to
18 m (fade 14–18 m); scratch `~/.cache/thirdlight-phase46/work/46d.1b/`):

| Town, WebGPU / WebGL 2 | triangles (vertices, displaced) | GPU ms | `render()` p50/p95 | missed | stream MB (derived) |
|---|---|---|---|---|---|
| plain | 0.84 M (0.63 M) | 3.22–3.55 / 4.61–4.70 | 9.1–9.2/10–11 / 9.1–9.5/10.5 | 0 / 0 | 124.8 (84.2) |
| normal from heights only (`reliefRadius=0`) | 0.84 M | 3.44–3.71 / 4.67–4.86 | 8.8–8.9/10 / 9.4–9.5/10.5 | 0 / 0 | 124.8 |
| n = 2 | 1.66 M (1.07 M, 0.49 M) | 4.29–4.31 / 4.65–4.69 | 8.9–9.3/12 / 9.4/10.5 | 0 / 0 | 158.7 (118.2) |
| n = 4 | 4.01 M (2.25 M, 1.81 M) | 4.52–4.62 / 5.15–5.25 | 9.2–9.4/10.5 / 10.1–10.2/11–13 | 0 / 0 | 242.6 (223.5) |
| n = 4, displacement off (mesh only) | 4.01 M | 4.43–4.52 / 5.15–5.20 | 9.4/10.5–11 / 10.0–10.1/11–13 | 0 / 0 | 242.5 |
| n = 4 at 48 / 64 m | 5.18 M, budget full: 331 piece draws, half the town missing (D528) | 6.4 / 5.2 | — | 0 | 248.5 |
| n = 8 | never settled in 180 s (budget, D528) | — | — | — | — |
| shadows, plain / n = 4 | as above | 4.18–4.19 / 5.25–5.35; n = 4 not usable (D529) | 14.6–15.3/16.4; n = 4: 15.8–16.9/17–19.5 | 0; n = 4: 30–34 / 77–107 of ~320 | — |

Village (two houses near, 40 m orbit): triangles 0.36 → 0.52 / 1.12 / 3.51 M (n = 2 / 4 / 8), stream 74.8 → 81.6 /
105.1 / 207.3 MB, 0 missed everywhere; its GPU ms are not readable (WebGPU plain 7.5–8.4 ms, above n = 8's 6.5–6.7: the
village's WebGPU GPU time was already 7.3 ms at §4 and varies by more than relief adds; WebGL 2 4.4–4.8 plain, 4.5–4.6
n = 4, 5.9–6.2 n = 8). Worker relief µs a section p50/p95 town n = 2 1.4–1.7/17–24 ms, n = 4 2.7–3.8/42–58 ms, village
n = 8 6.1–7.3/34–38 ms. Shadow pass GPU ms (plain town, shadows on − off): +0.6–1.0 WebGPU, +0.6 WebGL 2.

**What costs.** The displacement in the vertex stage is cheap: n = 4 with it on vs off differs by 0.0–0.1 ms GPU on
both renderers, though every relief vertex runs the full nine-texel blend and six height reads. The cost is the
topology and its memory: GPU +1.0–1.3 ms WebGPU / +0.5 ms WebGL 2 at n = 4 for 4.8× triangles, +139 MB derived data
(more than half the low tier's 256 MB budget), 50 ms p95 worker time a dense town section. The normal from the heights
costs +0.2 ms WebGPU, ±0.2 WebGL 2 on the whole town.

**Looked at** (both renderers, `~/.cache/thirdlight-phase46/acceptance/46d/46d.1b/`, each relief on / normal only / off:
`look4-log-wall-near`, `-stone-wall-near`, `-stone-roof`, `-ground-near`, `-rock-slope`, `-rock-cliff-near`,
`-ring-wide`; `lowsun-*` with the sun at 12°; `r2/r4/r8-log-wall-near-webgpu`): the normal from the heights makes the
look (cobbles, planks, rock read as material from 4 m to 40 m); displacement adds a little on top near: the rock cliff
and slope's surface undulates and their silhouettes move a few pixels at 5–10 m, walls show nothing a normal does not,
because a wall's silhouette edges are its creases (fixed: corners, openings, kit pieces stay on the undisplaced lattice;
no crack or gap seen anywhere, roof/wall seams, foundation corners and chunk borders included). At 60 m
(`ring-wide`) on vs normal-only differ in 90 pixels: relief past ~20 m is invisible. WebGPU and WebGL 2 show the same
pictures (at most 0.7 % of pixels differ by > 24 levels). Shadows are displaced the same (no acne seen on the rock
or walls). Low sun: the derivative-based normal sparkles in single pixels on rock at grazing light (seen on WebGL 2;
a stand-in until normal maps, 46d.4). The roofs' 1 m stripe at section faces is not distinguishable at n = 4 under the
normal (unverified close up). Ring edge in motion: not pictured as frames; by construction the displacement fades to
none before any relief/plain chunk border and moves at most depth × speed · dt / 4 m a frame (rock at 5 m/s: 0.25 mm a
frame), so no pop; swim unverified.

**VERDICT** (default chosen, owner to confirm; for 46d.5a/b):
- **The mesh path is kept, but small, and the normal from heights is the base for every tier.** Low (Iris Xe): relief
  mesh **off**; lighting normal from the material's height/normal on every surface (+0.2 ms). Medium: **n = 2** in a
  **16 m** ring. High: **n = 4** in a **24 m** ring (high tier unverified until the owner runs it, §5c). **n = 8
  rejected** (15.8 M town triangles at 32 m, does not fit the low budget at all, and nothing in the pictures needs
  6 cm vertices next to a normal).
- 46d.5a builds the ring per **section** (16³ = 8 m, half diagonal 6.9 m), not per chunk: the chunk ring meshes out to
  R + 14 m but may displace only to R − 14 m (here 18 m of 46). With sections the fade can end at R − 7 m. Relief gets its
  own budget share (D528); the fade ring re-plans with hysteresis (sections change only outside the fade).
- Displacement goes first on terrain and roofs (smooth normals, few creases: the rock reads better); construction faces
  keep the lattice but gain little (creased silhouettes); if 46d.5's numbers are tight, medium may drop construction
  relief (normal only) before dropping terrain's. The replacement for walls, if the owner wants depth there without
  triangles, is parallax occlusion in the fragment (not built; a proposal).

### 46d.3a material record

**Built.** `project-model`: `MaterialDef.physical` / `gameData` / `voxel` (add-only, canonicalized last and field by
field, so a material without them keeps its bytes), `material-profiles.ts` (engine profiles earth, glass, lava,
metal, stone, water, wood; `content.materialProfiles`; resolution own → profile → defaults), `voxel-materials.ts`
(the voxel part, `materialFamilyOf`, the project rules, `boundVoxelKits`), `game-data.ts` (the kit format's JSON rule
moved out of `voxel-kit.ts` so materials and profiles share it). Instances fold the three parts in
(`resolveMaterial`); a voxel variant gives its own `voxel.id`. Project rules over the whole block: `voxel_id_taken`,
`kit_missing` (so deleting a kit a material names is refused too), a profile neither the engine nor the project
has (`reference_missing`), a liquid with a kit, a voxel variant without a use in its chain; surface texture sets
name plain texture assets. Commands: `setMaterial` carries the parts; `setMaterialProfile` / `deleteMaterialProfile`
(project family, one undo each, workspace change keys, protocol, MCP docs; API-only until the inspector's physical
section, `tests/editor-op-reach.test.ts`); `queryGameConfig` lists `materialProfiles`. Binding: the editor's kit read,
Play and the export build the piece table from `boundVoxelKits` (a build ships each kit with its bound ids, the
materials with physics resolved against their profile); the kit check's info row `binding`; a material change that
moves a voxel id, use or kit re-reads the Scene view's kits. Spec: `voxel-render-spec.md` §1 with its owner note;
kit page pointers; manual `features/voxel-worlds.md#voxel-materials`, the kit guide's step 2; reference regenerated.

**Tested.** `voxel-materials.test.ts` (real content validator: every new field present and ordered after the
canonical round trip, empty parts dropped, refusals at every level, cross-list refusals, inheritance down the
8-deep chain, families, physics resolution and the build's resolved physics, the binding read by the voxel package's
real piece table, the 4,095-material load); `material-profile-ops.test.ts` (commands, undo/redo, refusals);
`voxel-kit-check.test.ts` (the binding row); `descriptors.test.ts` (the new descriptors probed against the
validator; registry +4.7 KB); `tests/integration/voxel-world/voxel-world.test.ts` (HTTP and MCP's `tl_command`,
kept across a restart, refusals; the export's kit block carries ids 3 + 12 and the oak material its parts with
resolved physics). No e2e change (`voxel-world.e2e.ts` untouched).

**Measured** (Node, vitest): a record with every part 414 B compact (79 B without); 4,095 voxel materials: load
(validate + canonical) 63 ms, one material edit on the trusted block 5.5 ms, the list 1.65 MB compact.

**Gate:** gate-fast-20261108-085657, reruns -090843 and -091247 GREEN (9 + 3 + 1 min, peak 4.4 GB; perf 0 missed of
360 both renderers). The first run's stale reference pages were the code commit's (regenerated in the docs commit);
`edge-cases.test.ts` (D523) and `start.e2e.ts` (D417) failed once and passed in the rerun. `voxel-world.e2e.ts`
untouched (no e2e change).

### 46d.3b the record drawn and read

**Built.** three-adapter `voxel-material-looks.ts`: each voxel id's look from its material record (instances
resolved): `params.color`, `voxel.tileMetres` (both projections, drawn at the nearest tile dividing the 512 m phase),
`voxel.heightDepth` over the base look's relief layer; the rest, and ids no record names, keep `voxelStandInLook`.
`VoxelSurface.setLooks` rewrites and uploads the table only (no program, grid or mesh; crack layers kept; `tableUploads`,
`tableMs`, `tableEntry` for diagnostics); `VoxelWorldDraws.setMaterials` (Play and exports from the build's
`manifest.materials`, the Scene view from every material change through `voxelsChanged({materials})`), the voxel world
page from `queryGameConfig` (read again on window focus). Runtime: `ctx.voxels.materialAt(x, y, z)` /
`materialOf(id)` from the build's records (`voxelMaterialInfos`, frozen; handed over with the world ports, worker and
page alike); chunk colliders keep the engine's one friction (Rapier's trimesh has no per-triangle friction).
project-model: `materialBadges` (mesh, voxel, kit, liquid, decal, graph), `isVoxelMaterial`; `materialsInUse` counts
every voxel material when the game holds a voxel world (closes the 46d.3a gap). Editor: the material Inspector's
**Voxel use** section (badges, use / variant, id with the smallest free one for a new voxel material, kit, tile, height
depth), badges on material tiles, `f:<badge>` in the project window search (`queryIndex` `badges`, never kept as a
reused page, MCP `tl_content_query` too), the voxel world page's picker (voxel materials only; shift-click adds the
picked one, id 2 without any).

**Tested.** `voxel-material-looks.test.ts` (looks from records, instance variants, stand-ins, tile snapping, the key;
a record change rewrites the table with the WGSL program text unchanged and crack layers kept);
`voxel-materials.test.ts` (badges, voxel-capable, runtime infos), `material-use.test.ts` (voxel materials used with a
world only); `tools/voxel-bench/world-host.test.ts` (a real runtime through the game host's ports on region files with
real workers: `materialAt` on the ground, an instance variant's merged game data, nulls, frozen);
`resource-files.test.ts` (`badges` filter, answered anew after an edit the index does not see); integration export
(a voxel-only material ships, an unworn mesh material does not); `voxel-world.e2e.ts`: the picker lists only the
stone; the Scene view's stone colour and tile set through the Inspector rewrite the table (+2 uploads, 0 mesh builds,
0 replaced), blue pixels 96 → 3,704, set back by command (+1); badges on the tile, `f:voxel` / `f:mesh paint`; the
export ships the stone record.

**Measured.** Table upload (4,095 entries, rewrite + upload flag) 0.80 ms in the Scene view (e2e log), the WGSL program
unchanged (vitest). Runtime reads: one map lookup (the build's voxel materials, frozen at start). `voxel-world.e2e.ts`
65.6 → 70.8 s (gate-fast-20261108-074413 → -094858): the Scene view test +0.4 s for the material steps; the WebGL 2
streams test 9.9 → 14.8 s has no change of this item beyond one hook read (host variance, recorded, not chased);
`project-window.e2e.ts` untouched, 13.2 s.

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.3b/shots/`, Scene view, both renderers): `scene-view-kit-back-*`
(stand-in), `scene-view-stone-record-*` (the stone record's blue and 1 m tile through the Inspector: the stone
pillars blue with the finer pattern on WebGPU and WebGL 2; blue pixels 96 → 3,704 and 100 → 9,225, the WebGPU run's
lintel front being the brick the streams test painted before it), `scene-view-stone-back-*` (back as before). The
voxel world page's picker is checked by hook (the e2e pictures hide it); not pictured.

**Gate:** gate-fast-20261108-094858 GREEN (13 min, 5.2 GB; 855 vitest files; e2e 39 passed with `voxel-world` and
`project-window`; perf 0 missed of 360 both renderers). The first run (-093015, before the e2e and UI) was red only on
the regenerated reference and the visual-script catalogue's skip list (both fixed in the commit).

### 46d.4a texture sets in arrays

**Built.** project-model `voxel-surface-textures.ts` (`voxelSurfaceTextures`): from the voxel materials' surface sets
one slot list a map (albedo + height `color`/height, normal `normal`, ORM `data`), a layer per distinct set in
ascending voxel id (wall, floor, ceiling), each id's three layers; a map left out takes its neutral constant layer, a
map no set names has no array, at least two layers, at most `MAX_TEXTURE_LAYERS` (`dropped`). three-adapter: the
surface's table gains a layer block; `VoxelSurface.setTextures` binds the arrays (repeat wrap, 4× anisotropy) and
writes the layers, no program change; `voxel-surface-sets.ts` reads a material's set (floor where the normal's y >
0.95, ceiling < −0.95, wall else; terrain its wall set triplanar; the image's top up; normal maps turned by the grid
frame `gridFrame` or each axis's frame), ORM to roughness/metalness/occlusion, the record's colour tints;
`VoxelWorldDraws` loads the arrays through the host (`textures`, `release`) and keeps drawing the old ones until the
new are there; the test patterns only under `patterns` (`?patterns=1`), the bands in both programs. Hosts: Play and
the export assemble the arrays with the slot lists (`closure-texture-slots.ts`), name them in the catalog block
`voxelTextures`, list them project-wide; the game page reads them as any shipped texture; the Scene view and the voxel
world page ask the backend's slot route (the same bytes). Bench `run.mjs textures` (placeholder generator
`texture-sets.ts`; `--import N` puts the sets on a running backend as materials for the bench ids, kits kept).

**Placeholder sets** (engine test data, deterministic, nothing committed): stone (ashlar, 0.5 m courses, 1 m blocks),
plaster, timber (0.25 m boards), earth, grass, rock; each albedo (height in A), normal (OpenGL, height in A too),
ORM. Authored 4096² (1024 px/m on a 4 m tile; 2048 px/m on terrain's 2 m tile), PNG 8-bit RGBA, full mip chain made
by the assembly: 145 MB for the 18 PNGs (stone 3.8/5.4/1.5 MB albedo/normal/ORM, plaster 5.6/4.7/2.7, timber
2.5/1.9/1.0, earth 6.5/13.0/2.6, grass 16.8/46.0/7.1, rock 4.2/17.7/2.1), 59 s to write; deleted after measuring.
Staging holds the 1024² cut (19.5 MB PNG, 256 px/m on a 4 m tile); its arrays: albedo ETC1S, normal and ORM
UASTC, transcoded to BC7 on the Iris Xe, 6 layers × 11 levels each, assembled in 40 s once, then cached (0.5 s a page
load). GPU bytes (BC7, 1 B a texel, mips 4/3): 8.4 MB a map, 25 MB the three at 1024² (low's 256 px/m); 2048²
(medium) 101 MB, 4096² (high) 403 MB, before 46d.4b's residency; textures a project imports at another size draw at
that size.

**Reads a pixel** (default program): 9–10 grid texels, 7 table texels, 18 array samples (3 maps × 3 projections × 2
materials; the patterns' 6), 1 crack sample; 6 texture units (the patterns' 4), 8 with bands and the relief heights,
within 16 with the light path's 3 (vitest, WGSL and GLSL).

**Tested.** `voxel-surface-textures.test.ts` (layers, sharing, fallbacks, neutral fills, two layers, the limit, the
keys); `voxel-surface.test.ts` (programs on both backends: reads, units, top-level samples, bands; `setTextures`
binds, wraps and writes layers); `voxel-material-looks.test.ts` (colour as tint, white with a set, layers from records
and variants); `manifest-v5.test.ts` (the block); `tests/integration/voxel-world` export: placeholder images imported,
a voxel material's sets → the export's `voxelTextures` block names a normal and an albedo array (no ORM), both
project-wide, two layers of 32² each, byte-equal to the editor route's answer for the same slot list.

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view and ~480-frame orbit, 1 round, 11:00–11:10,
load 2.4–2.9, uptime 15.8 d): WebGPU `?patterns=1` / arrays: GPU 3.37 / 4.06 ms, `render()` p50/p95 9.2/11.0 /
8.8/10.0 ms; WebGL 2 4.65 / 4.81 ms, 9.5/10.3 / 9.7/11.3 ms; 0 missed of 479 everywhere; 842 k triangles, 1,319
calls either way. The arrays cost +0.7 ms GPU on WebGPU, +0.2 on WebGL 2 (18 samples for 6).

**Looked at** (`~/.cache/thirdlight-phase46/acceptance/46d/46d.4a/`, both renderers, 15 views each): the log
house's timber walls, roof (roof tile = timber tinted) and corner; the stone house's walls, corner and hip roof
(courses at the same heights round the corner and across the foundation: the 4 m grid lines up); the plaster house's
wall and its timber floor seen through the opened front (floor set ≠ wall set); grass ground near; rock slope and
cliff (triplanar); village mid and wide; terrain slope; the town mid (WebGPU). WebGPU and WebGL 2 show the same
pictures. Seen: the grass's 2 m repeat reads as a pattern at 20–60 m (macro variation is a §1d proposal); a faint
horizontal line across the rock cliff at a section face (shading of the mesh normals there; cause unverified). The
first pictures drew every face in one colour: a loaded KTX2 clamps, so the tile's coordinates read its edge texel;
`setTextures` now sets repeat wrapping (tested).

**Gate:** gate-fast-20261108-103313 (red only on the e2e's band test: the bands had left the textured program; they
draw in both now) → rerun -104701 GREEN; gate-fast-20261108-111109 GREEN (13 min, 4.5 GB; 856 vitest files; e2e 36
passed; perf 0 missed of 360 both renderers); `scan-bounded-log` (D307/D418) and `edge-cases` (D523) failed once in the
first run and passed alone. `voxel-world.e2e.ts` 70.8 → 63.7 s (no e2e change; host variance).

### 46d.4b slot residency per quality tier and the texture budget

**Built.** project-model: quality level field `voxelTexelDensity` (texels a metre on a construction tile, one of
64 … 4096; absent the tier's `VOXEL_TEXEL_DENSITY_BY_TIER` 256 / 512 / 1024; `levelVoxels(l).texelDensity`; validated,
descriptor, reference), `VOXEL_AUTHORED_TEXEL_DENSITY` 1024 and `voxelArrayTopLevel(edge, density)`. three-adapter
texture streamer (extended, not forked): array KTX2s stream (`StreamedArrayTexture`: a part is one level of every
layer; the tail ≤ 128² always resident), a per-texture cap (`limit`, the planner's `top`: never asked for or kept above
it, a lowered cap drops at once), world-mapped textures measured by their tile (`WORLD_MAPPED_TEXTURES_KEY`: the voxel
surface lists its arrays with the finest textured tile), `wholeKtx2Source` (a whole file in memory streamed by parts),
injectable `decode`. `VoxelWorldDraws` caps the arrays from the level drawn each frame (`residency`, `capVoxelArrays`;
adapter `qualityLevelSettings()`). Hosts: Play/export (the build cuts each voxel array into mip parts and ships them in
place of the file, rows carry `mipParts`), the Scene view (its own streamer for the arrays, updated by the adapter's
frame, default budget), the voxel world page (`?quality=`, `?textureBudget=`, hooks `setQuality`, `textureStreaming`).
Docs: render spec §2 residency, manual (texture detail by quality level), reference regenerated.

**Tested.** `tests/voxel-texture-residency.test.ts` (real 2 × 1024² array from the backend encoder, cut as a build
cuts it, decoded by three's Basis transcoder): tier → level for 4096² (low 2, medium 1, high 0) and the validator; a
cap at 64 px/m streams to level 2 only (bytes = levels 2 … tail × 2 layers; the level equals the whole file's); raised
at run time 512² then 1024² stream in (2 upgrades); lowered, level 0 drops in the same plan (no read); a 1-byte budget
keeps the tail (`over`), a budget for 512² stops at level 1 inside it; 200 m away nothing past the tail is asked.
Integration export: 256² placeholder sets → each voxel array ships as parts `[1–8], [0]`, no whole file, the parts
join to the editor route's bytes. Fast gate gate-fast-20261108-114635 (red: one test pinned `levelVoxels`' old shape,
fixed) → rerun -115740 GREEN (4 min, 4.6 GB; e2e 36 passed; perf 0 missed both renderers). `voxel-world.e2e.ts`
63.7 → 64.1 s (no e2e change).

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, 12:08–12:31, load 1.8–3.2, uptime 15.8 d; placeholder
sets imported at **2048²** because 4096² layers are refused by the encoder (D532); 3 arrays × 6 layers, BC7):

| Tier (2048² sets) | resident, town 60 m | resident, near 5 m | GPU ms town 60 m, WebGPU / WebGL 2 | GPU ms near 5 m | missed (orbit ~478) |
|---|---|---|---|---|---|
| low (256 px/m: cap level 1, 1024²) | level 2, 6 MiB | level 1, 24 MiB | 3.82 / 4.65 | 4.04 / 4.49 | 1 / 0 |
| medium (512: level 0) | level 2, 6 MiB | level 0, 72–96 MiB | 3.83 / 4.61 | 4.08 / 4.60 | 1 / 3 |
| high (1024: level 0) | level 2, 6 MiB | level 0, 96 MiB | 3.82 / 4.74 | 4.07 / 4.68 | 0 / 3 |

At 60 m the need (level 2) is below every cap, so tiers draw alike; near they differ by the cap. With 4096² sets
(computed): 24 / 96 / 384 MiB. Runtime switch at the near view, orbiting: low → medium streams 3 × 2048² level 0 in
934 / 942 ms, 0 / 2 frames missed (33 ms: WebGL 2 uploads a whole 25 MB array chain in one frame); high → low drops in
0.1 ms, 0 / 1 missed; a medium ↔ high switch changes nothing (same cap). The first assembly of the 2048² arrays took
175 s on staging (then cached, 0.4 s a load). Round 1's per-tier logs were overwritten (one file name per renderer),
round 2 lost its logs to a script error; the table is round 3, one round.

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.4b/shots/`, both renderers): `t-{low,medium,high}-{stone-wall-near,
log-wall-near,rock-cliff-near,ground-near}-*`, `p-town-near-{tier}-*`, `p-town-{tier}-*`: walls, floor and terrain
textured on every tier; low against high differs in 0.01–0.15 % of pixels at 2 m (the placeholders' detail is coarse:
the step from 256 to 512 px/m barely shows), medium = high, WebGPU = WebGL 2 (≤ 0.01 %). The rock cliff's faint line
(46d.4a): `c-cliff-{tex,flat,patterns}-webgpu`: at the 56 m section face, only with texture sets (D533).

### 46d.4c kit sheets and crack maps for real; D532

**D532 (default chosen, owner to confirm).** The pinned encoder (Basis 2.5) takes 12 Mpix an encode. A larger
image (to `KTX2_IMAGE_PIXELS_MAX`, 32 Mpix) is now encoded in UASTC in stripes of its whole width
(`ktx2-striped.ts`; 3,072 rows a stripe at 4096): UASTC blocks are encoded each on its own and stored row by row,
so the stripes' blocks laid one after another are block for block the level one encode makes (vitest: byte-equal
to a whole-image encode); the levels below are the image halved (colour in linear light, normals renormalized,
data as stored) until one encode takes the rest with its own mip chain; the container is that encode's. Any mode
goes UASTC there (ETC1S's codebook spans the image), a colour import included. Imports, model texture extraction,
the slot route and the decode checks take it. Proof (`run.mjs textures --encode 4096 --sets stone,grass`, one
thread, the assembled effort, decoded by three's transcoder): stone albedo / normal / ORM 35.5 / 43.0 / 13.7 s,
4.57 / 7.85 / 2.24 MB KTX2 (PNG 3.82 / 7.75 / 1.53), grass 40.5 / 49.3 / 29.5 s, 10.45 / 16.71 / 10.18 MB; 13
levels each; mean error level 0 0.01–1.39 /255, level 1 against the box halving 0.02–2.81, at the stripe-edge
texels ≤ 4.0. On staging the 4096² base arrays (3 maps × 4 layers, BC7) assembled in 394 s once (then cached) and
streamed to level 0 at `high` (85 MiB a map). What remains: the import's byte caps (D535); the join's 256 MiB
level bound takes at most 16 layers of 4096² in one array.

**Built.** three-adapter `voxel-kit-look.ts`: a kit's look from its GLB material (base colour, normal, roughness /
metal / occlusion maps and factors; null without an image) and its draw material (standard node material, camera-
relative; a trim kit samples every map at the world-anchored U, the normal map's tangent frame from that U's
derivatives). `VoxelKitMeshes`: a GLB read and parsed once however many nodes a kit names, the parse kept while a
look draws its textures, extracted images loaded through the host's `texture` reader, `debug` (the old stand-in +
debug sets), `states()` names the sheet ("ready, sheet <asset>"). Hosts: Play/export (the catalog row's
`textures`, the page's streamed texture loader), Scene view and voxel world page (the asset record's `textures`,
a backend texture reader; `?trimDebug=1`). Crack maps read by the brightest texel of each 512² texel. Authoring:
the Blender export writes the kit material's images when it carries a sheet (`--sheet DIR`), the placeholder only
on the UV guide (the committed sample re-exports byte-identical). Bench: `kit-sheets.ts` (placeholder sheets on a
layout, the GLB with the sheet as its one material, a 4 m crack map), `run.mjs kits --sheets N --crack N --from DIR`.

**Tested.** vitest `voxel-kit-look.test.ts` (a real GLB through the loader: one read for two nodes, the image from
the extracted texture asset, plain and trim materials, programs build in WGSL and GLSL; no image → stand-in; debug
only behind the switch), `kit-sheets.test.ts` (neutral gutters, the GLB's one material and its bytes, a 4096²
one-pixel crack map kept), `ktx2-striped.test.ts`; `voxel-kit-pieces.test.ts`' debug test now constructs the debug
switch (the default changed by design). e2e `voxel-world.e2e.ts`: the test kit's GLB carries a 16² magenta sheet;
page (both renderers) states "ready, sheet stone-sheet" and draws 1,681 / 2,100 magenta pixels on the boards; Play
and the export (backend stopped) report the sheet's texture asset loaded. Fast gates gate-fast-20261108-124828
(D532) and -131407 GREEN (13 min, 4.7 / 4.9 GB; perf 0 missed both renderers); docs slice -140735 red only on
`rendering.e2e.ts` dynamic resolution (D320, watch; `world-host.test.ts` failed once and passed alone, D484) →
rerun -142122 GREEN. `voxel-world.e2e.ts` 64.2 → 64.9 s.

**Texture assets** (engine test data on staging, none committed): log and stone sheets on `detail-trim`, 4096²
(1024 px/m), PNG albedo / normal / ORM 1.67 / 2.54 / 0.83 MB (log), 2.17 / 6.38 / 1.27 MB (stone) inside GLBs of
5.06 / 9.84 MB; extracted to UASTC KTX2, 13 levels: 2.87 / 2.48 / 1.16 MB and 3.82 / 6.93 / 1.85 MB; the stored GLBs
with stand-ins 27.9 / 21.1 kB (meshes unchanged: 304 / 170 triangles, no LODs, collision from the voxels). Sample
kit through Blender with a 2048² sheet: GLB 2.23 MB, extracted ETC1S albedo 0.13 MB, UASTC normal 1.70 MB, ORM
0.47 MB (12 levels); stored GLB 21.1 kB. Crack map 4096² PNG 0.41 MB (read into 512², R8). GPU when resident: a
4096² BC7 map 21.3 MiB with mips, 64 MiB a kit's three.

**Measured** (staging, Iris Xe, 1280 × 720, 60 Hz cap, town, `high`, 1 round, 14:03–14:05, load 2.0–2.3, uptime
15.9 d), sheets / `?trimDebug=1` (the 46c look): WebGPU GPU 3.66 / 3.71 ms, `render()` p50 9.1 / 8.5 ms, WebGL 2
4.48 / 4.68, 10.4 / 8.8 ms; 0 missed of 479–480; 53,036 pieces, 1,857 piece draws, 842 k triangles either way. The
lit standard material costs ~0.6 / 1.6 ms of `render()` CPU (more uniforms a draw), not GPU.

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.4c/shots/`, both renderers alike): `sheet-log-corner-near`,
`-log-gable-near` (log ends, sill and eave rails in the timber sheet), `-stone-corner-near`, `-stone-eave-near`
(stone trim in the stone sheet), `-sample-corner-near` (the Blender-exported sample on the plaster house: corner
and door/window rims), `-crack-wall`, `-crack-stone-wall`, `-crack-roof` (the kit's map: long cracks on the wall
and the hip roof; `enginecrack-*` the same views with the engine's branching map), `-base-stone-wall-1m` (the
4096² base set at 1 m: crisp joints), `-village-mid`, `-town`; `debug-*` the same views under `?trimDebug=1` (the
debug sets). Seen: the sheets read on every piece; the placeholder sheets are flat-looking at a distance; grass and
rock wear the earth set in these pictures (D535).



### 46d.4d height depth, wetness R111; D531, D535

**D531 (default chosen, owner to confirm).** The approved texture layout v1 and R111 put a set's height in the normal
map's A; that is now its only home. The material record's map `albedoHeight` is renamed `albedo` (its A unused; the
manifest's `voxelTextures` key with it: nothing of this branch shipped, and a record naming the old key is refused as
unknown, so staging's materials were rewritten by hand); voxel arrays no longer derive a brightness height (the
layered surface keeps its own convention). A normal map without alpha, the flat fill layer and a layerless material
read height 1. Render spec §2 *Height, height depth and wetness*, manual (voxel materials, wetness, the kit guide).

**D535 (default chosen, owner to confirm).** `MAX_TEXTURE_SOURCE_BYTES` (project-model) is derived from
`MAX_TEXTURE_EDGE`: a 4096² 8-bit RGBA PNG stored uncompressed (16,385 B a row) + 1/256 for zlib and IDAT framing +
1 MiB of other chunks = 68,423,696 B (65.3 MiB); the image inspector's bound is it. `MAX_IMPORT_BYTES` = the larger of
it and the 32 MiB model/audio bound (`MAX_SOURCE_BYTES`, unchanged) bounds the upload stage, an asset's
`sourceByteLength` (the commands' copy of 32 MiB now imports it) and a source read back; staged bytes a project = 4 ×
that (273.7 MB, was 4 × 32 MiB). A GLB drop checks the model bound. 16-bit 4096² PNGs may still not fit (recorded in
the row). Tested at the HTTP boundary (`folder-import.test.ts`: an uncompressed noise 4096² PNG of 67.2 MB imports
and reads back whole; a file one byte past the bound is refused `stage_bytes`); on staging the 4096² placeholder sets
imported, grass normal 59.9 MB included.

**Built.** three-adapter `voxel-surface-wetness.ts` (written once over the projection's scalar ops; the program and
the tests run the same code): `heightBlend` — each of the two heaviest materials' surface level (h − 1) ×
`heightDepth` raised by its share × (deeper depth + 1 cm), the higher wins over a 1 cm contrast
(`HEIGHT_BLEND_CONTRAST_METRES`); colour, normal, ORM, the recess and the water use that share; `wetLook` — albedo ×
(1 − 0.5 w)(1 − 0.2 water), roughness × (1 − 0.6 w) then toward 0.03 under water, normal toward the surface's own by
0.4 w + water, water line w² × 0.6 of the blended height with a 0.04 shore. The surface's table holds every material's
depth (third block, g; the r channel the debug program's test layer). `voxel-surface-sets.ts` returns the height from
the normal read and `textureHeightAt` (explicit level) for the vertex stage; relief (`relief: true`) displaces by the
same blend; the derivative bump stays on the debug program only (`?patterns=1`, test heights). `createVoxelSurface`
split (`surfaceBlend` module function) to stay under 400 lines. Placeholder generator and kit sheets: albedo opaque,
height in the normal's A.

**Tested.** `voxel-surface-wetness.test.ts` (numbers through the program's functions: higher-in-metres wins, a whole
share alone, flat by share; levels 0–7 on 8 pixel heights darken / smooth / flatten in order, water fills the lowest
first, none at levels 1–2 above the floor, level 7 under the 0.6 line); `voxel-surface.test.ts` (+2 table loads,
WGSL and GLSL); `voxel-relief.test.ts` (relief reads the normal array at an explicit level, 6 samples, WGSL and GLSL;
no derivative bump on texture sets; the debug program's test heights and bump; a negative depth refused);
`voxel-material-looks.test.ts` (depth on every record, variants inherit); integration export (the shipped normal
array's A, transcoded by three's Basis transcoder, is the stone's height, mean error < 3/255; the floor's flat layer
255). e2e: the material step paints brick back to stone (plank's stand-in swatch 0x6d6a5f is as dark as wet brick, so
brick → plank measured a colour coincidence; WebGPU stone → brick changes 3,850 pixels); `voxel-world.e2e.ts`
64.1 → 64.1 s. Fast gates gate-fast-20261108-143421 → rerun -144515 GREEN (D535), -153655 GREEN (13 min, 4.7 GB;
perf 0 missed both renderers).

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, town R9 view at `high`, ~478-frame orbit, 2 rounds,
16:01–16:06, load 2.1–4.3, uptime 16.0 d; six placeholder sets at 4096²): WebGPU GPU 3.85 / 3.81 ms, `render()` p50
9.6 ms, 0 / 0 missed; WebGL 2 4.42 / 4.43 ms, 10.7 ms, 3 / 5 missed (max 50 / 33 ms); WebGL 2 with `?patterns=1` (no
arrays) 4.02 ms, 0 missed, so the misses are the arrays' stream-ins (D540), not the shader. Against 46d.4c (3.66 /
4.48 ms) and 46d.4a (4.06 / 4.81, low): within the rounds' spread; the two extra table reads and the blend math cost
no measurable GPU time.

**Texture assets** (engine test data on staging, none committed): 18 PNGs at 4096² (1024 px/m on 4 m, 2048 px/m on
terrain's 2 m), 8-bit RGBA, 149.4 MB, written in 50 s: albedo (opaque now) stone 2.18, plaster 1.40, timber 1.67,
earth 4.09, grass 1.01, rock 2.13 MB; normal + height stone 7.75, plaster 9.04, timber 2.88, earth 16.0, grass 59.9,
rock 24.3 MB; ORM as 46d.4a. Arrays (6 layers, 13 levels, UASTC, BC7 on the Iris Xe): albedo 17.9 MB, normal 62.8 MB
KTX2, assembled in 373 s on the first page load, then cached; GPU at `high` near 85 MiB a map (46d.4c's figure),
levels by need below.

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.4d/shots/`, both renderers, sun at 12°): `look-stone-wall-near-
wet{0,3,5,7}-*` (the stone house's front wall: darker and smoother as it rises, the joints dark at 7; door, window and
their kit rims unchanged and dry, D538), `look-ground-near-wet{0,3,5,7}-*` (grass shines in the low sun from 5, the
rock patch's low parts stand as dark flat pools at 5 and 7), `look-seam-grass-rock-wet{0,3,5,7}-*` (the rock patch
let into grass: an irregular seam where rock's tops and grass's fill meet by height, no straight blend band; wet the
pools follow the rock's low parts), `relief-{rock-cliff-near,stone-wall-near,seam-grass-rock}-{displaced,flat}-*`
(`?relief=4`: the cliff's silhouette moves a few pixels, the patch's surface undulates, no crack or gap; shading
from the normal maps). WebGPU and WebGL 2 alike. Water reads dark rather than mirror-like: the page has a hemisphere
light and no environment to reflect (46e). Decals over the real sets: not pictured (D539).

### 46d.5a relief on the chosen path: derive + format; D528

**Built.** `@thirdlight/voxel`: `relief-ring.ts` (the plan: a section whose centre lies within R + its half diagonal
joins, it leaves past that + 4 m; 3D distances; `optionsFor` names its plain neighbours; `affected` = the changed
sections and the relief sections round them; `fit` drops the farthest to 90 % of the share and keeps the ring small
until the focus has moved 8 m; `reliefFade`), `stream-relief.ts` (the streamer's ring: planned each update, a change
derived again in one edit-style group, relief bytes = the `relief…` budget parts: each section's relief part and its
chunk draw's relief copy, `RELIEF_DRAW_PART` from the batcher), the job asks relief per section (`{n, ids, plain}`),
`chunk` events carry `reliefOnly` (canonical bytes equal: the runtime and the page keep bodies), eviction counts the
budget less the share and the base bytes without relief. Derived v28 → v29 (format spec table, render spec §3).
project-model: `voxelWorld.levels.relief` (0 allowed, never past `level0`, scaled per level), `ResolvedVoxelWorld.reliefSteps`,
quality field `voxelRelief`, descriptors; runtime: `setRings({levels: {relief}})`, `rings().reliefSteps`, hosts
apply the ring (`worldReliefRing`, `applyWorldRings`). Page: `?relief=tier` (the quality level's steps and distance),
`setQuality` also sets the level's stream budget and ring, the fade follows where the ring displaces now. Manual
(*Relief*), reference regenerated.

**Tested.** `packages/voxel/src/relief-ring.test.ts` (join/leave distances, every point within R in a relief section,
re-plan only on a cell's move, hysteresis, plain-neighbour bits, `affected`, shrink farthest first and grow back,
a new step re-meshes all); `tools/voxel-bench/relief-ring.test.ts` (real workers, the town's regions on disk, 16³
sections: relief exactly on the ring, every section's canonical bytes = the plain derive on the oracle, the window
round the focus watertight against the plain mesh after settling and **at every swap** while the focus moves 6 m,
the move's chunk events all `reliefOnly`, off → all plain; a share holding half the ring's relief: the ring shrinks
(28 of 100 sections, 10.6 of 17.3 MB), no chunk evicted, resident count as with room); `world-host.test.ts`
(`setRings` and the quality level drive the streamer's ring: low none, high 4 steps to 20 m, a script's 6 m → 12 m);
`voxel-world.test.ts`, `descriptors.test.ts`. Fast gate gate-fast-20261108-165416 (red: lint read a scratch file
deleted mid-run) → rerun -165733 GREEN (13 min, 4.7 GB; 863 vitest files; e2e 36; perf 0 missed both renderers).
`voxel-world.e2e.ts` 64.1 → 64.2 s (no e2e change).

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view 60 m out, ~478-frame orbit, one round
each, `?relief=tier`, the level's own stream budget, 17:00–17:16, load 1.9–4.7, uptime 16.0 d):

| Town, WebGPU / WebGL 2 | ring (sections, displaced to) | triangles | relief MB / share | `render()` p50 ms | GPU ms | missed |
|---|---|---|---|---|---|---|
| low (n 0) | none | 0.84 M | 0 / 0 | 8.9 / 10.3 | 4.05 / 4.80 | 1 / 2 |
| medium, no relief | — | 0.84 M | — | 9.9 / 10.7 | 3.91 / 4.56 | 0 / 3 |
| medium (n 2) | 100, 16 m | 1.29 M | 12.9 / 67.1 | 9.3 / 10.9 | 4.34 / 4.49 | 1 / 3 |
| high, no relief | — | 0.84 M | — | 9.8 / 10.6 | 3.87 / 4.58 | 0 / 0 |
| high (n 4) | 212, 22.6 m | 4.10 M | 106.2 / 134.2 | 10.3 / 11.7 | 1.46 / 2.29 (not usable) | 7 / 3 |
| shadows low / medium / high, WebGPU | as above | | | 15.5 / 16.1 / 18.2 | — | 10 / 32 / 95 of ~450 |
| shadows low / medium / high, WebGL 2 | as above | | | 17.5 / 18.1 / 20.3 | — | 59 / 77 / 153 of ~400 |

Every run drew all 1,466 piece draws (D528: at n = 4 the town no longer loses half its pieces to relief). Worker relief
µs a section p50/p95: medium 1.9–2.4 / 15–19 ms, high 2.1–2.3 / 26–32 ms. Village at high (n 4, 22.6 m): 251
sections, relief 22.8 MB. The high tier's GPU timestamps came back lower than medium's (as 46d.1b's shadow runs):
not usable, `render()` and misses stand. Misses: high WebGPU 7 (relief adds +0.5 ms `render()` and 3.3 M triangles;
the arrays' stream-ins at high, D540, give the rest; cause per frame not traced); shadows are main-thread bound as
D529 records (the shadow pass draws every piece draw again; relief's triangles add ~2 ms at high): performance phase.

**Looked at** (`work/46d.5a/shots/`, both renderers, high, sun 12°): `l-high-rock-cliff-near-*`, `-stone-wall-near-*`,
`-seam-grass-rock-*`, `-village-ring-wide-*`, `-cliff-face-d533-*` displaced and flat; `p-town-{low,medium,high}-*`,
`ps-*` (shadows), `p0-*` (no relief). The cliff's rock moves and its silhouette shifts a few pixels, no crack or gap
at section faces, the ring's edge or the ground; the town whole at every tier. The 56 m cliff line (D533) not seen.
Shards on the stone house's door leaf through the doorway with displacement on (D542; identical in 46d.4d's
`?relief=4` picture). Ring edge in motion: not pictured as frames (crack-free at every swap is tested, not seen).

### 46d.5b relief drawn in the hosts; D541, D542

**Built.** `@thirdlight/voxel`: `RELIEF_RING_SCALES` and `RELIEF_FOCUS_STEP_CELLS` (relief-ring.ts); the streamer emits
a `relief` event (stream-relief.ts `drawState`: steps, displace radius, centre; again when the centre moves 1/8 m or
the ring changes) and `ChunkDrawBatcher` carries it as `ChunkDrawBatch.relief`; per-section derive readiness (D541,
stream-sections.ts). project-model: `levelVoxels().reliefScale`, `resolveVoxelWorld` scales `relief` by it.
three-adapter: `VoxelWorldDraws` builds the displacing surface, fades it by each batch's ring, `setRelief({displace})`,
stats `relief`. Hosts: Play/export through the draws (hook `__tlVoxelPlay.setRelief`), Scene view (open message
`reliefSteps`, `relief` message on a level change, scene-voxels-worker.ts), voxel world page (tier default, relief
switch). Manual *Relief* updated.

**Tested.** `relief-ring.test.ts` (real workers, town regions: the batches tell steps/radius/centre, not under a
step, once a step, off once; relief chunks come with crease weights); `voxel-relief.test.ts` (the draws' surface
displaces a batch's relief chunk, WGSL vertex stage reads the heights; the switch); `voxel-world.test.ts` (medium
16 m, high 24 m); `world-host.test.ts` (D541: after 8 m → 32 m round a chunk corner every reloaded chunk derives,
level 0 drawn, a body under the focus). `voxel-world.e2e.ts`: Play (worker / single) and the static export (backend
stopped) at `high` with the pad's grass as a textured voxel material (placeholder grass set 256², depth 0.25 m):
24 m ring, ~200 k relief vertices, moved vs flat 5,401 / 5,068 / 45,595 px (>20 levels). Fast gate
gate-fast-20261108-180929 (vitest green, edge-cases D523 passed alone; e2e red: relief checks) → reruns
-182313/-182517/-182731 (test fixes) → -182954 GREEN (perf 0 missed both renderers). `voxel-world.e2e.ts`
64.2 → 83.2 s (+18 s: the relief checks in Play ×2 and the export's reload at `high`).

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view 60 m out, ~480-frame orbit, one round,
`?relief=tier`, 18:33–18:35, load 1.6–2.6, uptime 16.1 d): medium (n 2, 16 m, 100–104 sections, 12.9 MB):
`render()` p50 10.2 / 11.1 ms, GPU 4.26 / 4.42 ms, missed 0 / 7 (WebGPU / WebGL 2); high (n 4, 24 m asked, **shrunk
to 21.4 m** by its 134 MB share: 176 sections, 77.3 MB, 3.21 M triangles): `render()` 10.4 / 11.8 ms, GPU 4.36 /
5.05 ms, missed 0 / 0. 1,466 piece draws each run. Shadow pass not re-measured (46d.5a's stands; hosts cast none).

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.5b/shots/`): `play-webgpu-relief-{moved,flat}`,
`play-webgl2-relief-{moved,flat}` (Play at high: the pad's grass texture shifts with its vertices; no crack seen),
`export-relief-{moved,flat}` (WebGPU, backend stopped: the same, ground pattern moves), `sceneview-high-{webgpu,
webgl2}-b` (Scene view at high: textured world drawn, 147 k relief vertices; displacement not distinguishable by eye
at that distance), `d-d542-*` and `nokits-d542-*` (D542). Unverified: relief on walls and roofs in Play (the e2e
scene displaces only ground), the Scene view's fade stepping as the view pans.

**D542 cause.** The bright shards on the stone house's doorway jamb are the door frame's kit pieces: with `?kits=0`
the same displaced view shows none (`nokits-d542-stone-wall-near-displaced-webgpu`). An edge piece reaches a few cm
over the face beside its edge; the face's crease is 0 only on the edge line, so the lattice vertices beside it
recess (stone 6 cm) and uncover the piece's buried sides. Fix (not small, recorded): crease 0 on every vertex within
a piece's reach of a cell carrying an edge piece, decided from cells alone so every section meeting a vertex agrees.

### 46d.6a kit pieces drawn across chunks; D529, D538

**Built.** three-adapter `voxel-piece-batches.ts` (`VoxelPieceBatches`): a chunk view's kit pieces as one
`InstancedMesh` a piece kind (geometry, material, cut; keyed by the objects, so two kit sets never share a draw) for
all of its chunks and nodes. Each chunk gives a run a kind (matrices in metres from an anchor cell, a `pieceU` vec4:
trim U offset, factor, wetness); a chunk set/removed marks its kinds and the view writes them once at the end of
`applyChunkDrawBatch` (`VoxelChunkView.inBatch`; a direct `set` writes at once). Culling: each pass's camera against
the chunks' spheres (half diagonal + 1 m); a draw's buffer holds the view's chunks (nearest first), then those only
another camera (a shadow map) holds, then the rest; three asks `count` per pass in `onBeforeRender`: the view its
part, a still other camera view + its own, a moved or new camera all. The view is the last camera drawn without an
override material; it is culled before any pass of a frame draws (its matrices change only between frames); another
camera's chunks are picked in a microtask after the frame, so no buffer changes between two passes of one frame
(WebGPU uploads before the frame's commands run). Room in powers of two (≥ 64); the anchor follows a chunk past
1 km. Wetness: the dressing cell's (read with its kit at `set`, again on a shader-only change, no mesh), every piece
material (kit look, trim, stand-ins) applies `wetLook` at height 1. Stats: the draws and the voxel world page report
`pieceDrawsInView`, `piecesInView`. Manual (*Voxel kits*: wet pieces, per-kind draws); the three checklist names
`voxel-trim-u.ts`' `builder.hasGeometryAttribute`.

**Tested.** `voxel-piece-batches.test.ts` (real derives, a real chunk view): two kinds over six chunks are two draws;
removes, adds and a swap leave the GPU-side instances (world matrix + data) equal to a rebuild in another order; a
batch writes nothing until its end, then both chunks at once (also through `applyChunkDrawBatch`); a chunk 1.6 km out
moves the anchor and no instance moves in the world; per-pass counts with a real perspective view and an orthographic
shadow camera (first pass all, then the view's chunks only, the shadow's after its microtask, a moved shadow all);
a wetness paint rewrites `pieceU`.z with no mesh built. Existing piece tests now read the batch draws
(`voxel-kit-pieces`, `voxel-chunk-view`, `voxel-decals`, `kit-house`). Fast gate gate-fast-20261108-190425 (red:
the three checklist row; edge-cases D523 passed alone) → rerun -191554 GREEN (perf 0 missed both renderers);
`voxel-world.e2e.ts` 83.2 → 82.3 s (unchanged tests: the page, Play ×2, Scene view and export draw the pieces).
Nearest-first order and docs: gate-fast-20261108-193214 (red only on `start.e2e.ts`, D417 watch;
`scan-bounded-log.test.ts` failed once, passed alone) → rerun -194545 GREEN; `voxel-world.e2e.ts` 81.6 s.

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view 60 m out, ~479-frame orbit,
`?relief=tier`, 19:21–19:29, load 1.9–3.4, uptime 16.1 d; rounds: p1, p2 = nearest first, p3 = attribute matrices,
p4 = p2 again; base = 46d.5b):

| Town, WebGPU / WebGL 2 | piece draws (in view) | instances (in view) | draw calls | `render()` p50/p95 ms | GPU ms | missed |
|---|---|---|---|---|---|---|
| 46d.5b medium / high | 1,466 | 43,711 | 1,319 | 10.2 / 11.1, 10.4 / 11.8 | 4.26 / 4.42, 4.36 / 5.05 | 0 / 7, 0 / 0 |
| medium | 49 (49) | 43,711 (37,182) | 298 | 2.7–3.0/4.3–4.9 / 2.9–3.0/4.2–5.1 | 5.4–6.1 / 5.0–5.1 | 0 / 1–2 |
| high | 49 (49) | 43,711 (37,182) | 298 | 2.9–3.2/3.8–4.5 / 2.9–3.1/4.4–4.6 | 6.9 / 5.9–6.0 | 0 / 0 |
| shadows low / medium / high (46d.5a: 15.5/16.1/18.2, 17.5/18.1/20.3 ms; 10/32/95, 59/77/153 missed) | 49 | | 499 | 4.1/4.3/4.4 / 4.5/4.6/4.6 | not usable at high | 0/0/27 of 344 / 0/2/50 of 326 |

The main thread no longer limits the town: `render()` falls ~7.5 ms, with shadows ~12–15 ms (D529 fixed). The GPU
rose 0.6–2.5 ms (D544, cause not traced: neither the matrix path nor the order). High with shadows is GPU-bound now
(D545). Village (`MODE=pieces`, high): 45 piece draws for 839 pieces; away and back: 0 → 45 draws.

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.6a/shots/`, both renderers): `p-town-{medium,high}-*` (as
46d.5b's, pieces in place), `p-town-near-*`, `p-town-mid-*` (rails, fences, window and door frames, eaves),
`ps-town-*` (shadows), `v-stone-wall-near-*`, `v-log-corner-near-*`, `v-village-wide-*` and `*-back-*` (pieces back
after the ring moved away and back), `v-stone-wall-near-hole-*` (a hole dug: its frame pieces), `-dry-` vs `-wet7-`
(the window and door frame pieces darken with the wall). D542's shards still show on the door leaf (unchanged).

### 46d.6b D544 traced; pieces culled on the GPU

**D544 trace** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view 60 m out, ~479-frame orbit, `medium`,
`?relief=tier`, 19:55–20:10, load 1.1–2.4, uptime 16.1 d; 3 rounds; scratch `~/.cache/thirdlight-phase46/work/46d.6b/`,
switches built only for the trace; GPU clock sampled from `gt_act_freq_mhz` every 25 ms of the orbit: mean of the
non-idle samples and the share not in RC6):

| Town, WebGPU / WebGL 2 | GPU ms | clock MHz | GPU awake | `render()` p50 |
|---|---|---|---|---|
| before 46d.6a (fd3fa355 rebuilt, same hour, 2 runs) | 4.16–4.25 / 4.62–4.71 | 1371–1398 / 1320–1355 | 0.94–0.96 / 0.79–0.81 | 9.8–10.0 / 10.6–10.7 |
| 46d.6a head (4 runs) | 5.62–6.02 / 4.95–5.09 | 1330–1347 / 1344–1384 | 0.71–0.78 / 0.61–0.68 | 2.6–2.9 / 2.9–3.2 |
| no kit pieces (`?kits=0`), either build (4 runs) | 6.76–7.37 / 4.39–4.64 | 936–974 / 945–1004 | 0.66–0.75 / 0.57–0.60 | 2.5–2.8 |
| pieces without the wet look / every instance drawn (no cull) / view held still | 5.79 / 5.01, 5.50 / 5.08, 7.54 / 5.02 | 1263–1310 | | |
| a 7 ms busy loop a frame on the main thread | 4.98 / 5.14 | 1329 / 1348 | | |
| piece draws after the surfaces (render order 1, 2 runs) | 5.66–5.68 / 5.01–5.03 | 1346–1350 / 1355–1370 | | |

The rise is real in timestamp ms (WebGPU +1.4–1.8 ms, WebGL 2 +0.3–0.4 at the same hour) but it does not follow
the pieces' work: the wet look, culling (every instance drawn) and buffer uploads (view held still) change nothing,
and **drawing no piece at all raises WebGPU's GPU ms by 1.5 ms** (the governor drops the clock to ~950 MHz), so on
this host the timestamps at the cap measure the clock governor as much as the work; the clock cannot be pinned here
(sysfs read-only in the container). What changed with 46d.6a is that the GPU sleeps more of each frame (awake 0.95
→ 0.75: the main thread no longer feeds it for 10 ms). One part is the work: a draw holds a kind's pieces near and
far, and drawn among the surfaces at its nearest chunk it shaded far pieces before the walls that hide them; the
piece draws now come after every surface (`PIECE_RENDER_ORDER`), −0.3 ms WebGPU, ±0 WebGL 2. The rest (~1.1–1.5 ms
WebGPU) is not traced further (round limit): D544 re-recorded for the performance phase, where GPU work should be
read at a fixed clock (or as GPU busy share) rather than as timestamp ms at the cap.

**Built (GPU culling of pieces).** three-adapter `voxel-piece-draw.ts` (`PieceDraw`): a piece kind's draw is a plain
mesh whose copies are placed by instance-matrix columns (attribute-instancing.ts) instead of three's `InstancedMesh`;
a copy's trim U offset, factor and wetness ride in its matrix's spare fourth row (floats 3, 7, 15:
`PIECE_RIDER_FLOATS`; the `pieceU` attribute is gone), so the culler's pools carry them with the matrix and a culled
draw reads them through its list (vertex stage, passed on as varyings). Each copy's sphere (the piece's bounds through
its matrix) is kept per place. It is a `CullableCopies` the GPU culler (occlusion-instances.ts) adopts at its first
draw once a culler is there and **lists itself** (`nested`: it lies inside the chunk view, below the scene's
drawables the culler walks); `viewDraw` culls the view by chunk first (`VoxelPieceBatches.viewCountOf`), so the
copies handed over are this frame's. Shadow maps and other cameras keep 46d.6a's per-chunk culling against their own
frustum. Raycasts test each copy as an instanced mesh's are. The voxel world page draws through the same culler with
`?occlusion=hiz|off` (adapter `createOcclusionFrame`: `OcclusionCuller` + a scene pass, two passes on `hiz`), state
`occlusion`. Readers `pieceDrawCopies`, `pieceCopyMatrix`, `pieceCopyData`, `isPieceDraw` (tests, bench). Manual
(*Voxel kits*, *Occlusion culling*).

**Tested.** `voxel-piece-batches.test.ts`: a real `InstanceOcclusion` attached to the scene adopts both piece draws at
their first pass and marks them; nested two groups deep they are listed (2 draws) with the copies the view draws: in
the pools exactly as drawn (riders included: wetness 3/7), each world sphere holding its copy, all in the chunks in
view; hidden → not listed, shown → listed again; the culled build's WGSL reads the copy through the list (more storage
bindings than the plain build). Every piece test reads the columns (`voxel-kit-pieces`, `voxel-chunk-view`,
`voxel-decals`, `voxel-kit-look`, `voxel-relief`, `kit-house`). Gates: D544 slice gate-fast-20261108-201239 (red only on
`start.e2e.ts`, D417 watch) → rerun -202604 GREEN; GPU culling gate-fast-20261108-205259 (red: the three-hook check
read a rider's `.w` beside `builder` as a hook, restructured; `scan-bounded-log` D307/D418 timed out once) → rerun
-210414 GREEN (perf 0 missed both renderers); `see-through.test.ts`' bounded-time case failed once in a local run and
passed alone and at the base. `voxel-world.e2e.ts` 81.8 → 82.5 s (no e2e change).

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view 60 m out, ~479-frame orbit, `?relief=tier`,
2 rounds, 20:36–20:46, load 1.3–4.6, uptime 16.2 d; `off` = the same scene pass without culling; scratch
`~/.cache/thirdlight-phase46/work/46d.6b/`):

| Town, medium / high | GPU ms WebGPU | GPU ms WebGL 2 | `render()` p50/p95 ms (WebGPU) | missed | piece copies drawn |
|---|---|---|---|---|---|
| page draws itself (as 46d.6a) | 5.55–6.05 / 6.95–6.97 | 5.14 / 5.69–5.70 | 2.8–3.0 / 4.1–4.8 | 0 / 0–2 | 37,182 in view |
| scene pass, no culling (`off`) | 5.40–5.58 / 7.0 | 4.90–5.03 / 5.39–5.46 | 2.8–3.0 / 4.1–4.6 | 0 / 0–1 | 37,182 |
| GPU culling (`hiz`, WebGPU) | **3.51–3.59 / 3.84** | — (no path) | 3.5–3.9 / 6.2–7.0 (D546) | 0 | 10.3–11.1 k of 35.4–36.9 k tested (71 % culled), 40 draws |
| shadows low / medium / high, page (D545) | 6.52 / 7.34 / — | 4.88 / 5.34 / — | 4.4 / 4.4 / 4.5 | 0 / 2 / 28 of 344 (WebGL 2 0 / 2 / 39 of 333) | |
| shadows low / medium / high, `hiz` | 4.72 / 4.14 / — | | 5.2 / 5.4 / 5.4 | 0 / 0 / 84 of 375 | |

Culling: pools 12.6 MB (18.9 with shadows), pyramid 1.23 MB (640 × 360, 11 levels), the culler's own main-thread time
0–0.1 ms; copies drawn in the second pass read 0 at each read-back (a slow orbit). Flight: not measured (the flight
page `stream-page` draws boxes, no kit pieces). Play: the adapter's culler adopts the piece draws the same way when a
project or quality level sets `occlusion_culling` on; not run on staging (unverified).

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.6b/shots/`): `m{a,b}-{plain,off,hiz}-town-{,near-,mid-}{medium,high}
-webgpu.png`, `m{a,b}-{plain,off}-…-webgl2.png`, `sh-{plain,hiz}-town-{,near-,mid-}{low,medium,high}-webgpu.png`,
`sh-plain-…-webgl2.png`, `s2-hiz-town-*`: rails, fences, balconies, window and door frames and eaves present at the
screen edges and in shadow on both renderers; `hiz` and the page's own draw differ in 0.00 % of pixels (> 24 levels)
in all 18 WebGPU pairs, with and without shadows; WebGL 2 vs WebGPU 0.01–0.02 %. Unverified: the first frame after a
jump (pass 2's newly visible copies; the read-back never caught one).

### 46d.6c Base-surface merges (D526)

**Built** (0c85d3a8, derived 29 → 30, format spec row with owner note). `base-surface.ts`: an owned face (a body's
face whose read reaches a roof plane cell) no longer splits the greedy merge; the rectangle holding one is owned whole
(its offset, a quarter cell in, lands each pixel in the body cell behind it), and owned rectangles of a direction share
vertices as blended ones do. `roof-mesher.ts`: the job's plane cells are collected in the one scan of its cells (the
tops pass walked all 16³ again through a closure), and vertices are keyed in a typed open-addressing table (a `Map` of
keys past 31 bits boxed each key); output bytes unchanged. The relief path (unmerged faces) keeps per-cell ownership.
The 46d.6c row names no D545 work: its proposal is in the D545 row (relief meshes cast no shadow; the ring's plain
surfaces, set `heightDepth` in, cast instead).

**Tested.** `roof-mesher.test.ts` +1 (fails on bb3bba7b): walled houses 45°/1:2, gable/hip, walls striped stone/timber
cell by cell with wetness: base mesh byte-equal to one-material walls (feeds rule), the eave wall's outer face from the
ground to the eaves owned at every triangle (one rectangle), every owned wall sample shows the material of the body
cell behind it, blended faces still read no plane cell; the D519 two-material and roof-row tests unchanged and green.
`packages/voxel` + `tools/voxel-bench` vitest 385/386 (the one red `edge-cases` corner case is D523's watch, green
alone). Gate gate-fast-20261108-212741 (red only on `role-spec-doc.test.ts`: the approved page may not say "owner to
confirm", reworded) → rerun -213909 GREEN (perf 0 missed both renderers). `voxel-world.e2e.ts` not touched.

**Measured, Node** (town 512², 1,070 roof sections, `run.mjs cases --roofs --fill --rounds 2`, 6 GB scope, 21:11–21:20,
load 0.6–3.1): base triangles incl. ramps **468,872 → 415,636** (46c.16d 417,396; ramps 204,388 unchanged), roof mesher
µs p50/p95 **296/728 → 213/545** (46c.16d 238/577, another hour), section derive p50 1,058 → 957 µs. Steps: owned faces
merged 468,872 → 415,636 (the narrower read reach alone, own layer only, gave −1.9 k and was not kept); single scan
296 → 227 µs; typed vertex table → 213 µs.

**Measured, staging** (Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 orbit 60 m out, ~479 frames, `?relief=tier`, 1
round each, before = bb3bba7b's build 21:25–21:27 load 2.6–4.7, after 21:44–21:47 load 1.7–2.4):

| Town medium / high | triangles | GPU ms WebGPU | GPU ms WebGL 2 | `render()` p50 WebGPU / WebGL 2 | missed |
|---|---|---|---|---|---|
| before | 1,285,254 / 3,211,122 | 5.35 / 6.99 | 5.20 / 5.69 | 3.2 / 3.0, 3.1 / 3.0 | 0 / 0 (WebGL 2 1 / 0) |
| after | 1,254,195 / 3,180,969 | 5.80 / 6.94 | 5.13 / 5.72 | 2.7 / 3.0, 2.7 / 2.9 | 0 / 0 (WebGL 2 1 / 0) |

−31 k triangles in the streamed town (the relief ring is unmerged either way); GPU ms move within the clock drift D544
describes, not traced.

**Looked at** (staging, both renderers alike, `~/.cache/thirdlight-phase46/work/46d.6c/shots/{before,after}-fill-…`:
stone walls under the log kit's timber roofs with the wall-top fill): `g45-near`, `h45-near`, `g12-near`,
`g45-eave-under`, `g45-attic`, `g45-gable-end`: the roof's timber to the seam, the stone up to the underside, no blend,
0.00–0.05 % of pixels differ before → after (> 24 levels). `stripe-eave-wall`, `stripe-eave-close`, `stripe-near`
(walls checkered stone / plaster): before, the top row met in hard cell lines and the rows below blended (rounded
corners); after, the whole wall face meets in hard lines (2.2 / 1.5 % of pixels), §9 default. `town-medium|high`.

### 46d.6d relief shadows from plain casters (D545)

**Built** (4635510e). `ChunkDrawBatcher` sends a relief chunk's plain surfaces with its relief meshes (`ChunkDrawWire.caster`,
handed over in the transfer list; the plain bytes count as the chunk's mesh part, as drawn plain). `VoxelChunkView`
with shadows: the relief mesh casts none; the plain surfaces become a shadow-only mesh (`VOXEL_CASTER_KEY`, on
`OFF_VIEW_LAYER`, the layer the engine's shadow cameras already see for cut-aways, a plain `MeshBasicNodeMaterial`: no
grid, table or texture read in the shadow pass), stat `casterTriangles`. The surface material's
`receivedShadowPositionNode` is the plain (undisplaced) world position for relief geometry. `?reliefShadow=relief` on
the voxel world page casts from the relief meshes, to compare; the page's sun sees the off-view layer
(`shadowSeesCutaways`, now exported). Play, exports and the Scene view take the same path; they cast no voxel
shadows (46d.5b default), so nothing changes there today. Manual (*Relief*, Shadows).

**Why not the proposal's push.** three draws a front-sided material's back faces into the shadow map, so a lit
relief surface is compared with its solid's far side and never with its own front; relief only recesses, so the
plain solid holds the relief solid. Casting the plain surfaces at their plain place gives exactly the shadow every
chunk outside the ring casts: no leak at walls, roof edges or seams, no peter-panning or acne beyond the plain
world's. Pushed `heightDepth` in, the caster's far side would shrink (light through thin walls and convex edges by
up to 12 cm). What a recessed point needs is to look its shadow up where the plain surface is (else a side facing
away from the sun, recessed past the normal bias, reads lit): that is the received shadow position.

**Lost.** The relief's own micro-shadows (a joint's side facing away from a low sun, drawn as back faces of the
lattice). At the page's map (80 m over 2048², 3.9 cm a texel, PCF) they did not show: every picture pair below is
equal. The relief normals still shade it.

**Tested.** `voxel-relief.test.ts` (real relief derive, real chunk view, three's program builders on both backends):
the relief mesh casts none and receives; the caster holds the plain triangles, casts only, is seen by a shadow camera
with the off-view layer and never by the view's, sits where the relief mesh is, is not pickable, costs bytes, goes
with its chunk; its shadow pass has no position or colour node; the relief's shadow lookup reads a varying made from
the geometry's own `position` (without the node: the displaced `positionLocal`); no shadows → no caster;
`reliefCasters: 'relief'` → the displaced shadow as before. `relief-ring.test.ts` (real workers, the town's regions):
every relief draw carries a caster byte-equal to the plain join and in the transfer list, a plain draw none; casters
< 1/3 of the relief triangles at n 2. Fast gate gate-fast-20261108-220842 GREEN (13 min, 5.0 GB; `scan-bounded-log`
and `edge-cases` D523 failed once, passed alone; perf 0 missed both renderers). `voxel-world.e2e.ts` not changed (Play
and exports cast no voxel shadows; the page's shadows have no e2e).

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 orbit 60 m out, `?relief=tier&shadows=1`, round 1
21:55–22:05 medium + high, round 2 22:06–22:08 high, load 2.4–3.6, uptime 16.2 d; GPU timestamps of shadow runs at
high not usable, as before):

| Town + shadows, WebGPU / WebGL 2 | shadow triangles of the relief ring | `render()` p50 ms | GPU ms (medium) | missed medium | missed high |
|---|---|---|---|---|---|
| D545 at 46d.6b | relief meshes | 4.4 / — | 7.34 / 5.34 | 2 / 2 | 28 of 344 / 39 of 333 |
| relief casters (`?reliefShadow=relief`), same hour | ~2.4 M | 4.2–4.3 / 4.8–5.2 | 7.12 / 5.28 | 0 / 3 | 27–30 of ~355 / 38–39 of ~370 |
| plain casters | 46,940 | 4.5–4.6 / 4.6–4.8 | 6.88 / 4.98 | 0 / 2 | **13–15 of ~430 / 4–8 of ~445** |
| high, no shadows | — | 2.9 / 3.2 | — | — | 0 / 1 |

What high + shadows still misses is D547 (GPU-bound; the view's 3.2 M relief triangles and the shadow pass of the
base world and pieces; not traced). Village at high: relief ring 1.28 M triangles drawn, casters 61.8 k.

**Looked at** (`~/.cache/thirdlight-phase46/work/46d.6d/shots/`, village at high, sun 12°, both renderers,
`s-relief-*` = relief casters, `s-plain-*` = plain casters): `stone-back-wall`, `stone-back-wall-close` (stone relief
lit at a grazing angle), `stone-east-eave` (the eave's shadow on the wall: no gap at the wall top), `stone-roof`,
`log-house-roof`, `plaster-gable`, `wall-foot-shadow` (the house's shadow on the ground from the wall's foot),
`rock-cliff-steps`, `rock-cliff-near`: every pair differs in 0.00 % of pixels (> 24 levels; ≤ 24 pixels of 921,600),
mean luminance equal, on both renderers. No leak, gap or acne seen.

### 46d.7a the far world and the far tree (data)

**Built.** `tools/voxel-bench/far-world.ts` (`run.mjs far-world --project-dir DIR`): the multi-km test world,
engine-owned test data. Side 8.192 km (32 × 32 region columns of 256 m, so the town sits at the centre), seed 97:
ridged mountain masses to 1,513 m (mean 205 m, 14.8 % of the ground above 500 m, 3.9 % above 1 km), terraced
cliffs (28 m steps, 12 % risers) where a cliff mask is high, overhangs (the ground pushed ±5 m within 8 m of its
surface there), rolling ground in the middle, grass / soil / rock with rock past a slope of 1.1 and gravel above
1.1 km, base −64 m; the bench town (town.ts, world grid only) flat at the centre within 210 m. Each region column is
a pure function of the seed and written straight to its stacked region files by a worker (`far-worker-node.ts`,
`FarPool` in `far-world-run.ts`); chunks wholly under the ground are uniform rock entries; the manifest
(`writeVoxelWorldManifest`, new in the workspace) last; a disk guard stops between columns under 2.5 GiB free.
`@thirdlight/voxel` `far-tree.ts`: the far tree's nodes (levels 2 … top), the uniform shortcut, `buildFarNode`
(a node from chunks or cached children), `farAncestors`, `FarNodeIndex`, `FarSelection` (screen error, hysteresis,
budget, near box; a binary heap, largest error first) and `farSelectionDiff`. `@thirdlight/workspace`
`voxel-far-cache.ts`: the far cache (`buildFarCache` per region column through a runner, here the workers;
`rebuildFarCache` for an edit's ancestors; `FarCacheReader`, `farCacheFiles`). `voxel-mips.ts`: narrow openings
close at every level ≥ 1, wider ones stay openings (derived 31). The format is
[voxel-render-spec.md](architecture/voxel-render-spec.md) §4.

**Tested.** `packages/voxel/src/far-tree.test.ts` (10, 2 s): a node opens past the threshold and closes only
under (1 − hysteresis) of it, a fresh selection at the same eye keeps it closed; every node of a 4 km world is
covered exactly once from any eye, coarser with distance, the far corner (5.6 km) drawn; the near box is left out
and met by level-2 nodes only; the budget holds and the nearest get the finest; an edit's ancestors exactly; the
uniform shortcut equals the downsample (not for roofs or damaged walls); a node built from cached children equals
one built from chunks; a door (2 × 4 cells) and a window (2 × 2) close in their wall at level 1, a 3 m gate stays
open at level 1 and closes at level 2, and the same door as air leaves the gap (the legs). The derive test's lone
opening among ground and water stays open (it closes only in a body). `tools/voxel-bench/far-world.test.ts` (4,
~30 s, 2 worker threads, a 512 m world on disk): region files written by the workers byte-equal to one thread's,
read back through the shipped-world reader, mountains' depths as uniform entries; the far cache from the workers
byte-equal to one thread's, far data in every 64 m column and every level, the whole world drawn from the town
inside the default budget; a dig through the workspace's `VoxelWorlds` command rebuilds exactly
`farAncestors(changed chunks)`, writes only the files holding them, and leaves the cache byte-equal to a full build
of the edited world; on the town's houses no opening leaves a gap at levels 1 or 2 with the wall solid on both sides
(1,000+ opening cells). Fast gate gate-fast-20261108-230257 GREEN (14 min, 5.5 GB; `scan-bounded-log` failed once, passed alone; perf 0 missed both renderers); `voxel-world.e2e.ts` not changed.

**Measured** (Node, 4 workers, 6 GB scope, 22:39–23:01, load 1.5–7.3, uptime 16.3 d; scratch
`~/.cache/thirdlight-phase46/work/46d.7a/`):

| What | 8.192 km world (67.1 km²) |
|---|---|
| World on disk | 476.1 MB in 2,917 region files (7.09 MB/km²); 572,645 stored + 4,082,352 uniform chunks; estimate from 32 spread columns was 460 MB |
| World generation | 249 s wall (3.7 s/km² with 4 workers) |
| Far cache | 48.5 MB (0.72 MB/km², 10 % of the world): L2 85,938 nodes 36.2 MB · L3 14,960 9.3 MB · L4 2,915 2.3 MB · L5 610 0.56 MB · L6 138 · L7 32 · L8 8 |
| Far cache build | 255 s wall (3.8 s/km²; 326 s the first time, cold file cache) |
| Memory | scope peak 2.2 GB (main + 4 workers, world write then cache build); a worker holds one region column |
| Disk free | 4.52 → 4.02 GiB |

Nodes drawn against distance (from scratch each, 720p 60°, the load ring's box as the near box; per band of the
node's distance from the eye, 0–1 / 1–2 / 2–4 / 4–8 / 8+ km, and the coarsest level there):

| Eye | 1 px | 2 px (default) | 4 px |
|---|---|---|---|
| town square, 2 m up | 28,851 nodes, 16.4 MB; 2,494 / 8,119 / 13,761 / 4,477 / 0; L2 L2 L3 L4 | 8,905, 6.2 MB; 2,494 / 2,896 / 2,803 / 712 / 0; L2 L3 L4 L5 | 2,584, 2.0 MB; L3 L4 L5 L5 |
| 300 m over the town | 28,938, 16.5 MB | 8,945, 6.2 MB | 2,624, 2.0 MB |
| a valley 2.5 km out, 200 m up | 21,254, 12.7 MB | 6,721, 4.8 MB | 2,162, 1.8 MB |
| world corner, 1.6 km up | 22,926, 8.9 MB; 8+ km at L5 | 5,207, 3.1 MB; 8+ km at L6 | 1,050, 0.9 MB |

Selection from scratch 9–18 ms at 2 px (Node; 49–91 ms at 1 px); none held by the 48 MiB budget. The draw count is
D549.

**Looked at** (staging slice page, 1280 × 720, both renderers, `~/.cache/thirdlight-phase46/work/46d.7a/shots/`;
the 46c-r2 houses with a 1 × 3-cell door and a one-cell window, `&levels=6,400` so they draw at level 1):
`log-g45`, `log-g12`, `stone-g45`, `stone-ell` `-mid-l1`: the front walls stand whole down to their foundations
(46c-r2's `*-mid-l1` showed them on legs); `*-near` (level 0) still show the door and window open. Seen on WebGPU and
WebGL 2.

**For 46d.7b/7c.** The world and its cache stay on disk (`work/46d.7a/project`: `voxels/far/`, `cache/voxel-far/far/`,
~0.52 GB) for the draw modes and 46d.7d; delete after 46d.9 unless the owner's pick needs them. Serving it from
staging needs D548 first (the backend loads a world whole). Not wired yet, by default (§9): the backend's rebuild
on an edit (the function is built and tested at the workspace boundary), the export shipping the cache, the page
streaming it; nodes need batching (D549).

### 46d.7b the far field as voxel-mip meshes; D548, D549

**Built.** D548 first: the backend's voxel worlds open on demand (`RegionWorld.scan`: every listed file read once,
one at a time, to check its tile and take its hash; a file's chunks load when an edit reaches them (`ensure`) and
clean files drop past `REGION_WORLD_RESIDENT_BYTES`, 256 MiB, least recently used first). The far field
(`@thirdlight/voxel` `far-field.ts`): beside the streamer (`far` option; `VoxelStreamer.far`), selection by screen
error from the focus over every node the far cache keeps, neighbourhoods read ahead from the cache (64 nodes a
read), `far-mesh` jobs in the stream's workers last in the `mip` lane (8 in flight, 64 queue places left to the near
field), changes swapped whole per group (a parent and its children in one batch), an edit re-reads its ancestors
and meshes them and their neighbours again. `far-mesh.ts`: the node meshed by the world rules at its level with a
same-level apron, a material/wetness word per vertex, skirts 2 cells along the inward normal at every box edge.
Batches carry `far` and `nearCover` (the near field's drawn chunks eroded by one). Three-adapter
`voxel-far-mesh.ts`: one draw per level and 8 × 8 node columns, colour from the material table × the wall set's
mean albedo in the vertex stage, a depth of its own (perspective × 1.05 to half the far plane, logarithmic past it
to 64 km), discarded inside the near cover. Backend: `…/voxels/<world>/far` (+ files by range; Play's locator
too), a missing or stale cache built in the world's queue, every command rebuilds its ancestors before it answers
(`far`). Export: the cache's files ship as content, the catalog row's `far` (add-only), read whole by
`shippedFarSource`. Hosts: the voxel world page (`?farField=`, `?farError=`, `?farShow=0`, hooks `setFar`,
`settleFar`, `showFar`, `state().far`), Play and the Scene view (`RangeWorld.far`), exports; quality fields
`voxelFarField` (`mesh` | `off`) and `voxelFarError` (low 8, medium 4, high 3 px). Spec: `voxel-render-spec.md` §4.

**Tested.** `workspace/voxel-worlds.test.ts` (+2): a world served on demand holds no chunk until an edit, loads only
the files an edit names and drops them once saved (undo reads them back), keeps the files used last, refuses an edit
over a file changed since opening. `far-world.test.ts` (+1, 7 s): the selection meshed in Node workers from the
cache on disk, no drawn node over another, same-level neighbours meet exactly on their shared face (82 faces, gap 0,
nodes above and below included), every vertex a solid cell's material, skirts present, a dig through
`VoxelWorlds` (which rebuilds the cache) meshes the changed level-2 nodes again with new vertices.
`chunk-batch.test.ts` (+1): the near cover by chunk, eroded by one, sent only when it changes. Project-model
tests: tiers, a level's own mode and detail, validation. `voxel-world.e2e.ts` extended (no new test): the page's
far field settles with nodes drawn on the slice world (the backend built its cache on the first read); the export
ships the far files at their content paths.

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, the 8 km world from the town square looking at the
peak; 01:43–01:53, load 0.9–3.0, uptime 16.4 d; GPU ms from timestamps; `work/46d.7b/perf-*.json`):

| | far nodes / tris / GPU MB / draws | fill after open | orbit missed (3 × 8 s) | GPU ms | render() p50 | flight 2.4 km at 60 m/s, missed of ~2,350 (max ms) |
|---|---|---|---|---|---|---|
| WebGPU medium | 2,648 / 4.97 M / 106 / 40 | 14.5 s | 0 / 0 / 0 | 7.0–8.5 | 2.2–2.3 | 18 (217) |
| WebGL 2 medium | same | 13.3 s | 0 / 0 / 0 | 5.2–5.3 | 2.6–2.7 | 16 (150) |
| WebGPU high (3 px) | 8.08 M / 172 | 23.7 s | 1 / 6 / 11 | 5.3 (later rounds unusable) | 2.5–2.8 | 29 (133) |
| WebGL 2 high (3 px) | same | 24.7 s | 0 / 0 / 6 | 4.6 (later unusable) | 2.7–2.9 | 36 (183) |
| WebGPU medium, `farField=off` | 0 | — | 0 / 0 / 0 | 9.2–9.4 (clock) | 1.9 | 8 (50) |

Near field there: 1.03 M triangles, ~150 draws. Page heap 1.36–1.44 GB at medium (0.70 off), 2.79 GB at high; at
2 px the high page closed in the 6 GB browser scope (Node: 8,969 nodes, 14.1 M triangles, meshed in 310 s by 3
workers), hence high 3 px (D550). Far mesh job 13–37 ms p50. Selection 7–31 ms (D551). Backend: the 8 km world
(476 MB, 2,917 files) opens in 0.65 s; after a dig, its undo and two far rebuilds (14 nodes, 351 / 189 ms) the
staging backend holds 264 MB (D548). Misses' causes: the flight's are far meshing and group rebuilds on the page's
thread while thousands of nodes land (3.7 k still unmeshed at its end), and the near field's own (8 with the far
field off); high's orbit misses with 8 M far triangles drawn whole every frame (no culling, D550). GPU ms at the
cap follow the clock (D544): the far-off run reads more than with it on.

Re-measured after the near cover's fix (its texels were read as 1/255 and hid nothing; found by the gate's
`voxel-world.e2e.ts`, where far 2 m blocks covered the slice's wall; 02:40–02:44, load 3.0–4.3): medium WebGPU 0 / 0 /
0 missed, GPU 7.8–8.4 ms, flight 25 missed (max 200 ms); WebGL 2 0 / 0 / 0, 5.4–5.5 ms, flight 23 (167). Fast gate
gate-fast-20261109-022117 GREEN (15 min, 5.2 GB; village perf 0 missed both); `voxel-world.e2e.ts` 82 → 87 s (the
far field settled on the slice, the export's far files).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/meshes/`, retaken after that fix, both renderers, medium): `town-peak-4.5km`,
`town-west`, `town-north` (the town's roofs, the valley and the 1.5 km massif behind; no cut-off, no floating roofs
at the ring's edge), `sight-1km`, `sight-3km`, `sight-5km` (the massif from 1.7 km up at those distances: terraced
cliffs as stepped 2–8 m voxels, grass and rock), `peak-to-town` (the whole world from above the peak, the town a
dark patch 4.5 km away, the world's edge visible). A few light specks on a hillside in `town-north` (D553). The
pictures are 46d.7d's input.

### 46d.7c the far field as ray-marched distance bricks; D555–D557

**Built.** `@thirdlight/voxel` `far-bricks.ts`: a far node as sparse bricks of the distance-brick format (its
constants moved into `distance-brick-format.ts`, project-model and the tracer re-export them): occupancy by fill
level, Euclidean distance (Felzenszwalb, a 3-cell apron from the 26 neighbours), corner samples the mean of 8 cells,
a brick stored only where its samples change sign, a material word a sample, node-face bits a brick;
`marchFarBrick`, the draw's march on the CPU. `far-field.ts`: a `draw` view setting (`mesh` | `bricks`, `farViewOf`),
`far-bricks` jobs in the stream workers, a draw change remakes every node and swaps it in node by node.
Three-adapter `voxel-far-bricks.ts` (atlas, instanced boxes, the marching material), `voxel-far-common.ts` (the far
depth, clip position and near cover both modes share; `voxel-far-mesh.ts` holds mesh and brick groups);
`VoxelShaderGrids` takes a texel format (r8 filtered for distances). Page `?farField=bricks` and the hook's
`setFar({ mode })`; Play, Scene view and exports through the quality field `voxelFarField: 'bricks'`. Spec:
`voxel-render-spec.md` §4 (no format change). Upgrade checklist: the fragment depth and clip-position hooks.

**Tested.** `far-bricks.test.ts` (4): distances within a quantization step of flat ground, stored/inside/outside
bricks, a partial top cell moving the surface, determinism, the transform against brute force, fixed rays (down,
slanted, through air, into the skirt). `far-world.test.ts` (+bricks in the existing test, real workers, cache on
disk): the mode switched at run time, every node made again as bricks, no node drawn twice, grass and rock looks,
rays meeting surfaces, same-level neighbours sharing their face samples exactly. `voxel-far-view.test.ts`: brick
groups, regions uploaded where the instances point, the program built on WGSL (`frag_depth`) and GLSL
(`gl_FragDepth`), a node swapping kinds, regions given back. `voxel-world.e2e.ts`: the slice's far field switched
to bricks (drawn, no triangles, no background below the horizon) on both renderers; 87 → 88.5 s. Fast gate
gate-fast-20261109-032204 red on two tests the change made wrong (the descriptor budget, a level test using
`bricks` as the invalid mode), fixed; rerun gate-rerun-20261109-033312 GREEN (5 min, 5.0 GB; village perf 0 missed
both renderers).

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, the 8 km world, mode A's poses and scripts; 03:41–03:52,
load 2.7–4.3, uptime 16.5 d; `work/46d.7c/perf-*-bricks*.json`):

| | far nodes / bricks / GPU MB / draws | fill | orbit missed (3 × 8 s) | render() p50 | flight missed of ~2,350 (max ms) | page heap |
|---|---|---|---|---|---|---|
| WebGPU medium | 2,648 / 36.9 k / 98.8 / 40 | 15.9 s | 21 / 18 / 18 | 2.1–2.3 | 26 (233) | 703 MB |
| WebGL 2 medium | same | 16.4 s | 39 / 21 / 34 | 2.1–2.2 | 21 (200) | 793 MB |
| WebGPU high (3 px) | 61.4 k / 152.7 / 52 | 28.7 s | 23 / 22 / 24 | 2.4–2.5 | 33 (267) | 1.28 GB |
| WebGL 2 high | same | 29.3 s | 59 / 65 / 81 | 2.6–2.7 | 29 (1,217) | 1.28 GB |
| WebGPU medium, brick draws hidden | same | — | 0 / 0 / 0 | 1.8–1.9 | 13 (150) | — |

Against the meshes (46d.7b): GPU memory 98.8 vs 106 MB (medium), page heap 0.70–0.79 vs 1.36 GB, no triangles (the
boxes are 12 each); a brick job 19–20 ms p50 / 30–32 p95 (a mesh job 13–37). The orbit misses are the brick draws
(hidden: 0): GPU-bound march (D555). GPU timestamps read 0.5–1.5 ms at a boosted clock (D544), so no GPU ms is given.
The flight's misses are the same far rebuilds on the page's thread as the meshes' (D550, D551). Atlas MB grows with
travel and is not given back (122 MB after the massif views, D557).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/bricks/`, the same names and poses as `meshes/`, both
renderers, medium): the same massif, ridges and valleys from 1–5 km and from above the peak, no cut-off, the
town's patch 4.5 km away; slopes smooth where the meshes show 2–8 m terraces (cliff terraces still show as steps);
WebGPU and WebGL 2 alike. A dark strip along the near field's edge from the town (D556). First takes showed black
boxes and a blank view from 1.7 km up: three shares one node build between materials with the same graph (a
material per group read the first group's atlas) and the boxes past the far plane were clipped; both fixed before
these pictures.

### 46d.7d the far-field comparison; D558

**Written.** `~/.cache/thirdlight-phase46/far-field-comparison.md` (for the owner: the two methods, one table, the
pictures, what Enshrouded is known to do, a hybrid, the lead recommendation and what changes with the other pick).
No code changed (no gate). Side-by-side pictures `~/.cache/thirdlight-phase46/far-field/side-by-side/<pose>-<renderer>.png`
(meshes left, bricks right, a 4× crop of the horizon band below), made from 46d.7b/7c's pictures by a scratch Node
script (`work/46d.7d/compose.mts`: `tests/e2e/png.ts`'s decoder, a zlib PNG writer; nothing in /tmp).

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, medium, the 8 km world from the town square, 46d.7c's
scripts; both modes and renderers interleaved in one hour, 03:53–04:02, load 2.5–3.6, uptime 16.5 d;
`work/46d.7d/perf-*.json`):

| | fill | orbit missed (3 × 8 s) | render() p50 | flight missed of ~2,350 (max ms) | page heap | far GPU MB |
|---|---|---|---|---|---|---|
| WebGPU meshes | 12.7 s | 0 / 0 / 0 | 2.1–2.3 | 19 (150) | 1,440 MB | 105.7 |
| WebGPU bricks | 16.3 s | 19 / 17 / 17 | 2.2 | 18 (317) | 793 MB | 98.8 |
| WebGL 2 meshes | 13.1 s | 0 / 0 / 0 | 2.5–2.6 | 19 (200) | 1,440 MB | 105.7 |
| WebGL 2 bricks | 16.6 s | 24 / 23 / 18 | 2.3 | 22 (200) | 894 MB | 98.8 |
| WebGPU off | — | 0 / 0 / 0 | 1.9 | 9 (83) | 703 MB | 0 |

The same picture as 46d.7b/7c's separate hours: the bricks' orbit misses are their march (D555), the flight's misses
are the far field's commits on the page's thread for both (D550, D551). GPU timestamps again unusable (off 8.8–9.3,
meshes 5.5–7.0, bricks 0.7–1.4 ms: the clock, D544). Far job p50 13 ms (meshes) / 20 ms (bricks).

**Looked at** (every 46d.7b/7c picture, through the side-by-side pairs, both renderers): silhouettes at 1, 3 and
5 km are practically the same (0.9 / 2.2 / 3.7 % of pixels differ by more than 60; WebGPU against WebGL 2 under
0.5 % within a mode); meshes show the 2–8 m terraces and keep the town's houses as lumps from above the peak, bricks
smooth the slopes and melt the town into a flat slab; meshes show sky-coloured pixels between far nodes in the
town-west crop (D553's specks); bricks show the near-edge strip (D556), thin dark slivers on crests, and streaky
material stripes on ground at grazing angles, strong on WebGL 2 and slight on WebGPU (D558; crops
`work/46d.7d/crop-*.png`). Pop in motion not looked at (unverified for both).

### 46d.8a the 46d measurement against §4; `voxel-world.e2e.ts` trimmed; D559

**`voxel-world.e2e.ts` trimmed** (it grew 64.6 s → 88.5 s in 46d: relief pixel checks +18 s in 46d.5b, far field +5 s
in 46d.7b/7c, the Scene view and export checks +4 s). Timed step by step in capped runs first (scratch
`work/46d.8a/e2e-t*.log`), then cut where a step repeated what another already proved; every product behaviour stays
covered. What moved where:
- **Assembly proof merged into the WebGPU streams test** (one page load instead of two): it runs first on the page
  the streams checks then use (`assemblyProof(page, errors)`), its refused 409 the one console error.
- **WebGPU streams test: no backend-less reload** of its own: the assembly proof's reload on WebGPU (every derived
  hash of the window from the files) and the WebGL 2 test's restart + reload (the same picture, the dug cell) keep
  "the edit is in the files" covered.
- **Play relief only on WebGL 2** (the runtime `setQuality` switch, sim in the page); WebGPU relief with the
  simulation in its worker is read in the export, which plays the same way.
- **Export opens once, at `&quality=high`** (was a second page load at high for the relief check); its fill wait is
  "over 20 chunks drawn" instead of "no growth for a second" (the later checks wait for what they read).
- **Scene view orbit dropped**: two 60-frame orbits that only logged `render()` ms with and without the world (no
  assertion); the deletion check (the world's draw goes with its object) stays.
- Nothing moved to vitest: the remaining browser-free checks (the export's catalog rows) cost milliseconds and need
  the export the browser part makes anyway.

Seven tests → six; fast gate gate-fast-20261109-041528: `voxel-world.e2e.ts` **88.5 → 70.7 s** (21.5 / 11.7 / 8.9 /
10.3 / 7.1 / 11.2 s), vitest and lint green; the smoke set's `rendering.e2e.ts` render-scale test failed (D320,
watch) and passed alone: gate-rerun-20261109-042940 GREEN (village perf 0 missed both renderers). Capped local runs:
80.9 → 64.4 s.

**D559.** A trial that switched Play to `high` right after the world became resident (to overlap the relief derive
with the rest of the test) failed: WebGPU drew the stone wall oversized and sheared with the projected mark gone,
WebGL 2 never stood the character on the pad; the same switch after the restore (as the test keeps it) passes. Seen
once each, not traced (D559).

**Measured: 46d against the §4 baseline** (staging from this tree, Iris Xe, 1280 × 720 at the 60 Hz cap, both
renderers, a tier at a time through the page's `setQuality` (town, village) or `?quality=` (8 km world); one ~480-frame
orbit a tier (two on the 8 km world), 04:32–04:52, load 1.3–3.9, uptime 16.5 d; scripts and JSON
`work/46d.8a/perf.mjs`, `m-*.json`, `h-far-webgpu.json`). Village = 46d.6d's three houses on the slice (46d.1a had
two). GPU ms from timestamps are **not usable** (the clock follows the load at the cap, D544: the village reads 9.4–9.9
ms on WebGPU, more than the town): listed for the record only.

| What (WebGPU / WebGL 2) | §4 baseline (46d.1a) | low | medium | high |
|---|---|---|---|---|
| Town `render()` p50/p95 ms | 9.1/10.2 / 9.2/10.6 | 2.9/4.3 / 2.9/3.4 | 2.8/3.5 / 3.0/3.9 | 2.8/4.0 / 3.0/5.1 |
| Town missed of ~480 | 0 / 0 | 0 / 0 | 0 / 1 (33 ms) | 0 / 0 |
| Town draw calls, piece draws, triangles | 1,319, 1,466, 842 k | 299, 49, 802 k | 299, 49, 1.25 M (relief 279 k vertices) | 299, 49, 3.17 M (relief 1.28 M) |
| Town stream MB; voxel arrays MiB (level) | 124.8; — (pattern 64 KB) | 116.4; 24 (L2) | 134.0; 96 (L1) | 221.4; 96 (L1: the 60 m view needs no more) |
| Town GPU ms (clock, D544) | 3.4 / 4.7 | 5.7 / 4.9 | 5.7 / 5.2 | 7.0 / 5.4 |
| Village `render()` p50/p95 | 1.7/1.9 / 1.6/2.0 | 1.5/2.5 / 1.5/1.8 | 1.5/2.4 / 1.6/1.9 | 1.5/2.4 / 1.6/2.7 |
| Village missed; calls, piece draws, triangles; stream MB | 0 / 0; 177, 110, 380 k; 79.0 | 0 / 0; 142, 45, 370 k; 73.0 | 0 / 0; 142, 45, 510 k; 79.1 | 0 / 0; 142, 45, 1.26 M; 109.3; arrays 384 MiB (L0) |
| 8 km world: far nodes, triangles, draws, GPU MB | nothing past the 192 m load box | 892, 2.13 M, 20, 41.7 | 2,131, 4.97 M, 40, 105.7 | 3,490, 8.08 M, 52, 172.2 |
| 8 km world: far fill after open | — | 4.5 / 4.9 s | 12.5 / 12.8 s | 24.1 / 24.4 s |
| 8 km world: orbit missed (2 × ~480), `render()` p50 | — | 0, 0 / 0, 0; 1.9 / 2.0 | 0, 0 / 0, 0; 2.1–2.2 / 2.5–2.7 | 8, 13 / 2, 3 (one 817 ms); 2.6 / 2.8 |
| 8 km flight (2.4 km at 60 m/s) missed of ~2,350 (max ms) | hilly 2 × 2 km, 40 m/s: 1 / 1 of 3,600 | 15 (100) / 17 (50) | 17 (233) / 15 (217) | 32 (117) / 36 (333) |
| Grid textures; kit textures | 23.1 MB; 5.94 MB debug set | 23.1 MB (town, 8 km), 19.8 (village); kits: the GLB sheets | same | same |
| Mesher µs a 16³ section p50/p95 (`run.mjs mesher`) | slice 217/313, town 239/332, hilly 226/488, caves 349/662 | slice 220/331, town 240/318, hilly 215/327, caves 374/685 (no mesher change in 46d) | | |
| Roofs (`cases --roofs --fill`, town) | roof pass 287/737 µs, derive 997/1,564, base 468,872 tris | 210/520 µs, derive 960/1,503, base **415,636** tris (46d.6c) | | |
| `voxel-world.e2e.ts` | 64.6 s (88.5 at the end of 46d.7c) | 70.7 s | | |

**Causes of the misses.** The 8 km flights' misses are the far field's commits and selection on the page's thread
while thousands of nodes land (D550, D551; with the far field off 46d.7d's flight missed 9, the near world's own);
they grow with the tier's node count. High's orbit misses on the 8 km world: 8.1 M far triangles drawn whole every
frame (no view culling of far draws, D550) beside 1.48 M relief vertices; the one 817 ms WebGL 2 frame was not traced
(the L0 texture levels, 384 MiB, stream in at high). Town and village hold the cap on every tier and renderer (one
33 ms frame in one run). **Memory at high on the 8 km world (WebGPU):** the 6 GiB scope reached its cap (peak 6.44 GB
measured by the scope; page heap 2.79 GB, as 46d.7b); in the run that opened low, medium and high one after another in
one browser, the browser closed on opening high, so high was measured again alone (`h-far-webgpu.json`): D550's page
memory, now with the high tier's textures. The page heap read by `performance.memory` is coarse (Chrome caches it):
46d.7d's 1.44 GB at medium stands. The hilly 2 × 2 km world of the §4 flight is no longer on disk (deleted for space);
the 8 km world's flight replaces it (default chosen, owner to confirm). Full gate time and peak: 46d.9 (lead).

**What 46d bought against the baseline** (same views): `render()` 9.1 → 2.8–3.0 ms on the town (pieces instanced
across chunks, 46d.6a: 1,466 → 49 piece draws, 1,319 → 299 calls); base triangles 468,872 → 415,636 (46d.6c); real
texture arrays at 24 / 96 / 96–384 MiB by tier in place of the 64 KB pattern; relief at medium and high (0.28 / 1.28 M
vertices in the town); a far field drawing the whole 8 km world with nothing cut off. Not yet better: the far field's
page memory and flight hitches (D550, D551), high on the floor GPU with an 8 km world (orbit 2–13 missed).

**Docs (the lead's 46d.8a scope).** Render spec status and its step table (complete for 46d: §1–§4, 46d.6d's shadows
added), format spec §3.8 (derived 31, far cache 1) and §3.7's history (30 → 31) with their owner notes, the manual's
kit texture text (pieces wear their kit's sheet; `?trimDebug=1`), the reference checked current (`gen-reference
--check`: up to date). Left for 46d.8b: requirement traceability (R88, R89, R111, R112), the authoring package's
material guide, the acceptance shots and README.

### 46d.8b docs and the acceptance pack acc46d; D560

**Docs.** [voxel-render-spec.md](architecture/voxel-render-spec.md) §5: requirement traceability for 46d (R88, R89,
R111, R112, R27/R28, R64 and every owner row of §2 → where built, tested, status); the format spec's §4 rows and the
requirements page's R88/R89/R112 rows point at it. The authoring package's material guide:
`docs/manual/guides/voxel-kits.md` §1 *The material set first* (base tiles at 4096² / 1024 px/m, terrain 4096² on its
2 m tile, the three maps with height in the normal map's alpha, import bound and encoding, height depth per material
with the test sets' values, wall / floor / ceiling sets, the record with an example, physical profiles, variants, kit
binding, what each tier keeps, wetness, how to check). `docs/requests/art-factory-2026-11-08.md`: an update section
(height only in the normal alpha, `voxel.heightDepth`, terrain sets at 4096², import bounds, the set checks not built).
No code change (no gate).

**Acceptance pack** `~/.cache/thirdlight-phase46/acceptance/46d/` (README, `final/` 62 × 2 pictures; review page
acc46d): relief per tier (wall, roof, cliff, seam), low-sun relief displaced vs flat and shadows, textured materials
near/mid, the floor set, kit pieces with their sheets, wetness 0/3/5/7 (wall with pieces, ground, seam), cracks, the
showcase, decals in Play and the Scene view over the real sets (D539: dry only), town near/mid/far, the far-field
pairs of 46d.7d (copied, not re-shot). Scripts `work/46d.8b/` (staging, 6 GB scopes, 04:54–05:12, load 0.5–7.6).
WebGPU looked at whole; WebGL 2 by pixel difference (0.00–0.36 %, `lowsun-showcase` 1.25 %, Scene view orbits 2.6–2.9 %,
each looked at). **D560:** the town world from outside its edge misses a strip of its side wall (both renderers).
Owner questions: `~/.cache/thirdlight-phase46/approve-46d.md`.

### 46d.9 the close: full gate, review, fixes

**Full gate** gate-full-20261109-051432 at f83a2ff4 (lead): GREEN, 35 min (46c's 34), peak 8.0 GB, 868 vitest files,
392 e2e tests. **Review** `~/.cache/thirdlight-phase46/review-46d.md`: 0 High, 3 Medium, 8 Low (decision log).

**D559 traced.** The trial switched Play to `high` right after the play started (before the world streamed in;
46d.8a's log marks the switch 0.15 s after the start). Re-run in capped Playwright runs on staging-free e2e backends
(scripts and pictures `work/46d.9/t1`–`t8`): WebGL 2 failed 2 of 19 runs: the character fell through the pad to y
−46 m (pad 51.5 m). The world host counts a collision column settled once each chunk in it has had a `chunk` event
and is in the ring; a chunk's first event carries only the sections that could derive, and a section whose apron
reaches a chunk still loading waits, so the body built from that first join can lack the ground under the
character. The fix asks the streamer whether every section of the chunk has its result (or waits on a chunk past
the load ring, as it is drawn): `VoxelStreamer.chunkReady`; 10 of 10 runs stand, and `collision-ready.test.ts`
(real workers, region files on disk, Rapier) holds a neighbour's load and fails on the old rule. WebGPU: 2 of 6 runs
showed the wall coarse with no projected mark at the first probe after the stand (as in 46d.8a's trial picture),
then right at every probe 1 s apart for 11 s (`t4/*/probe-*.png`): the new tier's sections and draws landing. Not
traced further (D566, watch). The kept e2e switches WebGL 2 at the start (10.3 → 10.8 s); WebGPU keeps its relief
check in the export.

**D552 fixed** (re-rated M): full builds and edit rebuilds in worker threads (`packages/backend/src/far-cache-runner.ts`);
`voxel-far-jobs.test.ts` holds a build after it read the world, sends a dig and an export meanwhile (answered;
the export ships without the far cache and says why) and checks the landed cache equals a full build of the edited
world byte for byte; `far-cache-runner.test.ts` runs the built worker (same bytes as this thread, timers keep
running, the export warning through `shipVoxelWorlds`).

Fast gates: gate-fast-20261109-061300 RED in vitest (two tests pinned the old relief scale, the role spec test
refuses "owner to confirm" in the approved spec; fixed) and `edge-cases.test.ts` timed out under load (passed
alone), gate-rerun-20261109-062500 GREEN (village perf 0 missed both renderers); `voxel-world.e2e.ts` 69.7 s. With
the D559 fix: gate-fast-20261109-065936 RED in e2e (the export test read 0 kit pieces right after the kit turned
ready, once; 5 of 5 alone; D567, watch) and `edge-cases.test.ts`' 5 s timeout again under load (passed alone),
gate-rerun-20261109-071516 GREEN (village perf 0 missed both renderers); `voxel-world.e2e.ts` 70.7 → 71.1 s
(21.0 / 11.4 / 9.2 / 10.8 / 7.3 / 11.4 s: WebGL 2's Play switches to `high` at the start, +0.5 s).

### 46d.10 height in the albedo's alpha

**Built** (f05807ba). The owner's convention (§9, 2026-11-09): a voxel texture set's height is the **albedo's A**,
the normal map keeps none. `voxel-surface-textures.ts`: the albedo array is a height array again
(`TextureSlotSet.height`, key `color+height:…`), so the backend's slot assembly gives a layer whose albedo has no
height a brightness one, the layered surfaces' rule (Play, export, Scene view and the voxel page all pass the flag
through). `voxel-surface-sets.ts`: `textureSetAt`'s height and `textureHeightAt` (relief's vertex stage, explicit
level) read the albedo array; the height edge uniform takes the albedo array's width. Blend in metres, crevice water,
wet look and the debug program unchanged. Placeholder sets and kit sheets: height in the albedo's A, normal A 255;
the kit GLB's material stays OPAQUE; `kit_templates.py` channel-packs the albedo (Blender 5.2.2's export of a 512²
sheet: the GLB's albedo pixels equal the PNG's, A 31–247, no `alphaMode`). Texture layout v1 amendment 1 (owner
note, add-only, §9 of that page), render spec §2, manual (voxel worlds, kit guide), art-factory request,
reference regenerated.

**Tested.** `voxel-relief.test.ts` (new: the TSL graphs of `textureSetAt` and `textureHeightAt` sample only the
albedo array for the height, the normal array for the normal, construction and terrain); `voxel-surface-textures`
(the albedo set carries `height`, the others none); `kit-sheets.test.ts` (height in the albedo's A, normal A 255,
no `alphaMode`); integration export (the shipped albedo array transcoded by three's Basis transcoder: the stone
wall's layer is the stone's height, mean error 4.4/255 at 256², which is ETC1S as every small colour array, bound
1 mm at the stone's 4 cm depth, a tenth of the blend's 1 cm contrast; the opaque timber albedo got a brightness
height, range > 60; the normal array's A is 255 in both layers). At the authored size the UASTC stripes keep it:
`run.mjs textures --encode 4096` (A error now printed) stone albedo mean A error 0.20/255, grass 0.42. Fast gate
gate-fast-20261109-193846 GREEN (14 min, 5.1 GB; `scan-bounded-log.test.ts` failed once under load, passed alone;
village perf 0 missed both renderers); `voxel-world.e2e.ts` 71.1 → 70.8 s.

**Looked at** (staging regenerated: `run.mjs textures --import 4096`, 18 PNGs 145.1 MB, materials unchanged; the
arrays reassembled on first ask in 421 s). 14 of the acc46d poses a renderer (`work/46d.10/shots/`, script
`shots.mjs`): the grass/rock height seam, the stone wall dry and wet 5/7, the rock cliff at 12° sun displaced and
stepped, the stone back wall in low sun, grass and a kit corner near. Same look as `acceptance/46d/final/`: mean
difference 0.25–1.16/255, ≤ 0.39 % of pixels over 8/255 (the low-sun cliff steps 1.88 %, its far edge), on both
renderers (`work/46d.10/diff.txt`); wet 7 still fills the rock's low parts first on WebGPU and WebGL 2.

### 46d.11 relief off on every tier; blend distance per material with a world default

**Built** (ee2ba690). Relief: `RELIEF_STEPS_BY_TIER` is 0 on low, medium and high (`relief-ring.ts`), the one switch: with no
steps the streamer plans no relief ring, its budget share is 0, no relief part is derived or streamed and no
shadow caster made (bounds grow only for geometry carrying crease weights, so nothing changes there). The quality
field `voxelRelief`, the ring, the derive part, the draws' displacing program and the page's `?relief=n` and
switch stay: a level that sets 2/4/8 draws relief as before. The heights still light every surface (normal and
height blend from the albedo's A). Blend: `voxel.blendMetres?` on the material record and `blendMetres?` on
`voxelWorld` (0–0.5 m, default 0.25 m, limits once in `VOXEL_MATERIAL_LIMITS`), validated and canonical field by
field, inherited along instance chains; descriptors (Inspector rows for both; the material's voxel section gets
**blend m**, placeholder "world"), MCP docs. The material table's third block carries each material's own value
(b; −1 none); the surface reads the eight cells round a pixel once, then takes the narrowest blend any solid cell
asks for (`voxel-surface-blend.ts` `seamBlendMetres`, written over the projection ops so the program and the tests
run the same function; an optional `hold` op keeps the node graph linear). The world's value is a draw setting:
Play, exports and the Scene view read it from the scene's `voxelWorld` object through the link that already carried
its decal layers (`VoxelWorldDecals.blendOf`, `onChange`), and an edit sets the surface's uniform; a record edit
re-uploads the table (existing path). The voxel world page (no object) keeps `?blend=` (default the engine's) and
`setBlend`, its records' own values as the hosts; state reports the live value. Render spec (two owner notes,
add-only), manual (world table row, material field, Relief section), reference regenerated.

**Tested.** `voxel-surface-blend.test.ts` (new): the min rule on numbers (crisp beats soft from both sides, a soft
material alone keeps its own, a material without one takes the world's, 0 wins, air ignored, none solid → the
world's); the surface's table holds a record's blend (−1 without), `setBlendMetres` uploads nothing, `setLooks` one
table upload, the material's version (three's program rebuild trigger) unchanged by either, the program builds on
WGSL and GLSL, a NaN refused; `VoxelWorldDraws` over a real derive and join in a scene with the link: drawn at the
object's 0.1 m, an object edit to 0 and its removal (→ 0.25) set only the uniform (mesh builds and table uploads
unchanged), a record edit one table upload and no mesh build. `voxel-materials.test.ts` / `voxel-world.test.ts`
(canonical round trip with the new fields in order, ranges refused, 0 and one cell accepted), descriptors
(registry reached; size bound 376.5 → 377.2 KB with its reason), `voxel-surface.test.ts` (program reads: 13 table
texels, was 5), `voxel-world.test.ts` / `world-host.test.ts` (tiers resolve 0 steps; a level's own `voxelRelief`
4 still drives the real streamer's ring). `voxel-world.e2e.ts`: the relief checks (Play WebGL 2, export WebGPU) now
turn relief on explicitly (the project's levels = the engine's with `voxelRelief: 4` at high, removed after); Play
and the export assert the world draws at its object's `blendMetres` (0.2 m).
Fast gate gate-fast-20261109-203353 (vitest red: the script access digest, re-pinned for the added optional field
as its test says; `dedup-retry.test.ts` timed out under load and `edge-cases.test.ts` (D523 watch) failed once, both
passed alone) → gate-rerun-20261109-204534 GREEN (4 min, 5.1 GB; perf 0 missed both renderers).
`voxel-world.e2e.ts` 70.8 → 71.8 s (21.9 / 11.5 / 9.2 / 11.5 / 6.8 / 10.9 s; relief still moves 4,268 px in Play,
57,312 px in the export).

**Measured** (staging, Iris Xe, 1280 × 720 at the 60 Hz cap, town R9 view 60 m out, ~480-frame orbit a tier, one
round each, before = the tree at cd29ca3a 20:17–20:19 load 1.2–2.6, after 20:29–20:31 load 4.4–6.0 (another
project busy), uptime 17.1 d; `work/46d.11/perf.mjs`, `b-town-*.json`, `a-town-*.json`). Low is unchanged by
construction (it drew no relief); medium and high lose the relief mesh:

| Town, WebGPU / WebGL 2 | triangles | relief vertices | relief mesher a section p50/p95 | stream MB (relief) | `render()` p50/p95 ms | missed of ~479 |
|---|---|---|---|---|---|---|
| low before → after | 802 k → 802 k | 0 | — | 116.4 (0) → 116.4 | 2.8/4.5 → 3.0/5.1 / 3.2/4.1 → 3.2/5.5 | 0 → 0 / 0 → 0 |
| medium before → after | 1.25 M → 802 k | 279 k → 0 | 2.0–2.4/20–22 ms → none | 134.0 (12.8) → 116.4 | 2.8/4.8 → 2.9/5.0 / 3.3/4.9 → 3.2/5.8 | 0 → 0 / 2 → 3 |
| high before → after | 3.17 M → 802 k | 1.28 M → 0 | 2.2–2.3/31–34 ms → none | 221.4 (77.1) → 116.4 | 2.8/4.6 → 2.8/4.8 / 3.3/4.5 → 3.2/5.8 | 0 → 0 / 0 → 0 |

Derived bytes 188.4 → 83.4 MB at high, 101.0 → 83.4 MB at medium; JS heap 624 / 588–624 MB both. GPU timestamps
(not usable at the cap, D544) low 5.81 → 5.61 / 4.98 → 5.03 ms: the eight extra table texels a pixel show no
cost above that noise. p95 `render()` rose 0.2–1.3 ms with the host's load (4–6 against 1–3); the WebGL 2 misses
(2 → 3 at medium) are within the runs' spread. No obvious regression.

**Looked at** (`work/46d.11/shots/`, village at high, both renderers, `shots.mjs`): `off-high-stone-wall-*`
(stone wall, door and window frames, foundation: plain faces, normal-mapped joints, no relief vertices),
`off-high-seam-grass-rock-*`, `off-high-rock-cliff-*` (relief ring 0 sections, triangles 366–399 k), and the
grass/rock seam at the world blend `blend005-*` (0.05 m: a straight hard edge along the cells), `blend05-*` (0.5 m:
a wide ragged height-blended edge), `blend0-*` (hard cell line); the default 0.25 m is `off-high-seam-*`. WebGPU and
WebGL 2 show the same pictures. The per-material override is not pictured (tested in vitest through the draws);
the Scene view's and Play's live edit of the world's object is tested through the draws, not pictured.

### 46d.12 the brick far field's mush: a measured spike and the verdict for 46d.13

**What Enshrouded is known to do** (searched 2026-11-09). *Verified* (Keen Games' 1.0 changelog, October 2026, on
enshrouded.com and quoted by GamingOnLinux): "Thanks to a new rendering method called brick rendering, voxel terrain
and buildings now have a much higher level of detail at large distances, drastically improving the look of vistas
and far away points of interest"; the same release lists "improved performance on handheld devices, low-end graphics
cards and the Steam Deck" and is Steam Deck Verified. *Not found in any Keen source* (search summaries and settings
guides only, so unverified): that the brick renderer replaces their voxel-to-triangle conversion; that it is
ray-marched; that its bricks are sparse signed distance fields in an atlas with a page table (46d.7d's comparison
said Keen had said so publicly: that was an overstatement, corrected here); that it runs on the Steam Deck (an
RDNA 2 iGPU of the Iris Xe's class) rather than only on desktop GPUs. A settings guide says their global
illumination uses a low-resolution SDF of the scene (inferred). No talk, paper or interview with technical detail
was found. So "it is possible" holds for "a brick renderer with far detail shipping in a game that also targets an
iGPU handheld"; everything about how is ours to find.

**The lead's diagnosis, tested** (Node, `work/46d.12/analyse.mts` over 12 real nodes of the 8 km world's far cache:
the town's at levels 4 and 5 and 8 hill nodes; each build's surface found by a ray straight down every 2 m column,
against the finest kept level's (L2) top cell; selection from the shot poses at medium 4 px):

- (a) *Sample spacing doubles per level, ≈32 m at a 256 m node — refuted.* A node is 32³ cells as 4³ bricks, so its
  samples are its cell size apart: 8 m at a 256 m node (level 4), 16 m at level 5. The selection already ties that
  to the screen: the median drawn node's sample covers 2.2–2.8 px from the town, 2.0–3.8 px from 1.7 km up
  (`analyse4.out` POSE lines). The meshes draw the same nodes and keep houses as lumps.
- (b) *Built from downsampled mips, detail lost twice — confirmed.* Mean height error against L2 (m): town L4
  1.56 → 1.09 with the faces field from the children (`faces x2`), roofs ("built" columns) 3.58 → 1.73; town L5
  1.52 → 1.26, roofs 9.05 → 3.59; hills L4 1.62 → 1.40, L5 4.88 → 3.78 (p95 13.4 → 12.0). The faces field from the
  node's own cells (`x1`) is no better than occupancy (roofs 3.84 / 9.58): the loss is the mip, not the corner
  averaging. Grandchildren (`x4`) gain ≤ 0.4 m more on terrain and nothing on roofs at 7× the build (378–404 ms a
  node against 51–72 ms for x2, 11–34 ms occupancy).
- (c) *One dominant material a coarse sample — partly.* The topmost solid of 8 cells paints roof over the gaps
  between houses (51–60 % of the town's columns show their L2 top material; the "red slab"), and the draw read the
  nearest sample, so colour came in sample-sized blocks. A neighbourhood vote (shown cells round the sample, tops
  twice) gives 61–68 % and the draw now blends the 8 samples. The town stays a red patch from above the peak:
  its 8–10 m houses are under one 16 m sample there; no field fixes that, only a finer error at that distance.
- (d) *Cost: every box marched per pixel, no early depth test — confirmed, not fixed.* Tight bounds (each brick's
  marched box shrunk to the cells the surface crosses: 20–60 % of the brick's volume) bring WebGL 2's misses
  31 → 18 a round and WebGPU's 18 → 17 (same hour, below): the pixels a box covers, not its depth, are the cost.

**Built** (0c1be6cb; occupancy stays the default, the rest behind the switch). `@thirdlight/voxel`
`far-bricks-faces.ts`: `farBricksFromFaces` (the exact signed distance at each corner to the solid cells' faces, by
the separable transform over the corner lattice; a surface corner moved by ½ − the mean fill of its 8 cells, so
partial terrain cells still move it), read from cells `scale` times finer; a sample's look the most-shown material
round it; per brick the cells the surface can be in (`FarBricks.bounds`, 6 bytes; the occupancy build gives the whole
brick); a surface on a brick face drawn by its solid side. `brickFarNodeBy` (the worker's job) builds by
`FarBrickBuild`; `FarField` reads a node's children (a 4³ block a level down) for `faces2` and sends them with the
job; `FAR_BRICK_BUILDS` (`occupancy`, `faces`, `faces2`). Three-adapter: the box from the bounds (lip only where they
reach a node face), and the fine shading (a uniform branch): colour blended over the 8 samples, ambient occlusion
from the field one and two cells out, a march stopping at half a pixel. Page `?farBricks=`, `?farShade=fine|flat`,
hook `setFar({ bricks, shade })`, `state().far.brickBuild`.

**Tested.** `far-bricks-faces.test.ts` (3): a one-cell block built from cells twice finer keeps more height than the
occupancy field (8.44 against 8.30 of 9), a surface half a node cell up sits at 8.5 within 0.1 and a ¾-full finer
layer lifts it 0.375 within 0.12, the ground brick's bounds are its bottom cell row only, looks (grass ground, the
block's own material); a job carrying uniform finer entries as the far field sends them equals the build from a
store, and a node without finer cells of its own draws nothing. `voxel-far-view.test.ts`: the instance bytes with
the bounds, the occupancy build's whole-brick bounds; the program with both shadings builds on WGSL and GLSL.
Fast gate gate-fast-20261109-220108 GREEN (16 min, 4.9 GB; `tools/voxel-bench/stream.test.ts` "refreshes chunks another writer
changed" timed out once at 5 s under load and passed alone, as D454's neighbour; perf 0 missed both renderers);
`voxel-world.e2e.ts` not changed, 71.8 → 72.7 s.

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, medium, the 8 km world from the town square, 46d.7d's
orbit (3 × 8 s) and flight (2.4 km at 60 m/s); all in one hour, 21:46–22:00, load 2.8–5.2, uptime 17.2 d;
`work/46d.12/perf-*.json`, `perf-uptime.txt`):

| | bricks | far GPU MB | page heap | brick job p50 / p95 | far fill | orbit missed (of ~480) | flight missed (max ms) |
|---|---|---|---|---|---|---|---|
| WebGPU occupancy (v1) | 36,888 | 99.1 | 703 MB | 20 / 33 ms | 16.2 s | 20 / 17 / 18 | 22 (233) |
| WebGPU faces2 + fine (v2) | 42,628 | 99.4 | 842 MB | 73 / 109 ms | 49.0 s | 22 / 23 / 23 | 36 (250) |
| WebGPU faces2, flat | 42,628 | 99.4 | 793 MB | 78 / 125 ms | 55.4 s | 19 / 16 / 16 | 23 (167) |
| WebGL 2 occupancy (v1) | 36,888 | 99.1 | 793 MB | 21 / 34 ms | 16.8 s | 42 / 24 / 26 | 20 (100) |
| WebGL 2 faces2 + fine (v2) | 42,628 | 99.4 | 894 MB | 77 / 124 ms | 54.6 s | 97 / 64 / 121 | 29 (183) |
| WebGL 2 faces2, flat | 42,628 | 99.4 | 793 MB | — | 49.3 s | 25 / 9 / 20 | 27 (433) |
| WebGPU meshes (reference) | 4.97 M tris | 105.7 | 1,440 MB | — | 14.0 s | 0 / 0 / 0 | 24 (183) |

Read: v2 makes 16 % more bricks; the atlas holds the same GPU MB (it grows in steps). The page reads 3.2× the far
cache bytes (entries 2.8 → 8.9 MB) and the job is 3.5× slower (its 76³ cells read one `voxelAt` at a time), so the
fill triples. The fine shading costs ~5 missed a round on WebGPU and 40–100 on WebGL 2 (the 8 colour reads, each a
table and an array lookup, and two more field reads; D568). The flight's misses stay the far field's commits on the
page's thread (D550, D551), more with longer jobs. GPU timestamps not usable at the cap (D544).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/bricks-v2/` at 46d.7c's poses, both renderers; pairs v1 left,
v2 right, 4× horizon crop below, in `far-field/side-by-side-v2/`, `work/46d.12/compose.mts`): `peak-to-town` — slopes
show their terraces as crisp, shaded steps where v1 melted them, the green/grey bands softer and blended (less
pixel-noise, a little blur), the town a smaller red patch with some relief, still not houses (14 % of pixels
differ by > 60); `sight-5km` — the cliff face shows its layered steps, its grass flecks gone (the vote), fine
horizontal banding on the steepest face (D569); `town-west` and `town-peak-4.5km` — the dark strip along the near
field's edge (D556) is gone; WebGL 2 `peak-to-town` — the grazing material stripes (D558) are gone; `sight-1km`,
`sight-3km`, `town-north` — nearly the same (1–3 %). WebGPU and WebGL 2 pictures match. Motion and pop not looked
at (unverified).

**VERDICT for 46d.13.** The brick direction holds: the mush was the source data and the colour, both fixable without
more GPU memory, and v2 looks clearly better at every pose. Build as the default far field:
1. **The faces field from the children** (`faces2`), with the page job made cheap: read the decoded children as
   dense arrays instead of `voxelAt` per cell (expected 73 → ~20–30 ms, fill back near 20 s; unmeasured), and
   keep the far entry cache's budget (16 MiB) above the 9 MB the children need from the town. Baking bricks into the
   far cache instead is not advised: ~1.6 M bricks × 2.2 KB ≈ 3.5 GB raw for the 8 km world (estimate, compression
   unmeasured) against its 48.5 MB cache.
2. **Shading at build, not per pixel:** bake the occlusion into a sample byte and the colour blend into the look (two
   words and a weight a sample, one read), so the fine look costs what the flat one does (removes D568).
3. **The pixel cost (D555) is the open risk:** box-per-brick overdraw, not march depth, misses 17–23 frames a round
   on WebGPU. Try, in order, measured: one fragment a pixel per node (front faces of the node's box, a DDA through its
   4³ page table, skipping empty and inside bricks), then the march at half resolution with a depth-aware upsample.
4. Edges: the solid-side rule and tight bounds keep D556/D558 away; keep the lip only at node faces. Then retire
   the occupancy build and the nearest-sample colour.

*Expected cost:* far GPU memory ~100 MB at medium (unchanged), page heap +0.05–0.15 GB against today's bricks
(meshes +0.74 GB), +16 % bricks, fill ≤ 2× today's once the reads are dense (to be measured). *Unknown:* whether any
draw change reaches 0 missed on the Iris Xe; how Enshrouded draws its bricks (not published); the town's houses
under one sample at 4–5 km (needs a finer error there, ~4× bricks, or a building colour cue); pop in motion; the
high tier.

### 46d.12b the realistic far test world

**Built** (55ad23cf, then a material tune). `tools/voxel-bench/far-drainage.ts`: the world's drainage on a 32 m
node grid (261² for 8 km, ~1 MB): massifs from domain-warped ridged noise drive an uplift; 90 steps of implicit
stream-power erosion (erodibility varied ±45 % for soft and hard rock) with hillslope creep (4 × 0.2 a step), pits
filled by priority flood (a filled basin drains as a tree to its spill point, so it becomes a flat floor), water
leaving at the world's edge; relief scaled so the top peak is 1.5 km. Every worker computes the same grid (4 s), so
no tile needs a guard band and region columns meet exactly. `far-landscape.ts`: the grid read with a Catmull-Rom
cubic, then gullies down the slope (three slope-aligned stripe octaves, 36/15/6.5 m, furrows narrower than spurs),
crags on steep ground, winding escarpments (one domain-warped step of 15–55 m where a mask allows), rolling ground,
river channels along the drainage's reaches (area ≥ 90 nodes; width, depth and floodplain from the area and the
reach's slope; meandering by a warp), floodplains levelling only ground near the bank; materials per column from
slope, height, curvature, river distance, scree (steep ground just uphill, scarp feet) and noise at 32 and 11 m
(grass, soil, gravel, rock, sand on banks and plains, snow over ~1.1 km), wet river beds; 3D near the surface:
outcrops (rock pushed ±3 m in and out: overhangs), boulders (0.5–2.3 m, more on scree), 31 arches; 0.5 m roughness
by bareness. `far-world.ts` `style` (`realistic` default, `terraced`), `farSurfaceHeight`, CLI `--style`; snow is
bench voxel id 7 (`textures-cli.ts`, plaster set tinted, imported on staging).

**Tested** (`far-world.test.ts`, 5 → 8 tests, ~34 → ~65 s): the drainage computed twice is byte-equal, another seed
differs; heights over the whole 8 km world every 48 m are finite, within the base and 1.1 × the peak, the town at 0,
>0.5 % over 1 km, arches placed; two region columns written apart (a flank and its river) equal a chunk column
straddling their seam written from the landscape alone, cell for cell (>10 k cells: material, role, shape, wetness),
the same column twice is byte-equal, the columns hold rock, soil, grass, gravel, wet beds (>1,000 cells) and ground
over air; the terraced style is still written the same every time. The existing far cache, legs and far field tests
pass on the realistic default. Fast gates gate-fast-20261110-001721 (D567 once, GREEN on rerun) and
gate-fast-20261110-011544 (`start.e2e.ts` D417/D453 and `rendering.e2e.ts` "the export draws the box field instanced"
timed out at 240 s once under load; both GREEN on rerun gate-rerun-20261110-042538).

**Measured** (Node, 4 workers, 6 GB scope; written straight into the staging project after the old world was
deleted, 00:45, load 1.4):

| | realistic (seed 97) | terraced (46d.7a) |
|---|---|---|
| World | 644.2 MB, 3,056 files (9.6 MB/km²); 563 k stored + 5.25 M uniform chunks | 476 MB (7.1 MB/km²) |
| Generation | 463 s (6.9 s/km²; 489 s with a vitest run beside it) | 249 s |
| Far cache | 54.1 MB (L2 101,572 nodes 40.5 MB), 253 s | 48.5 MB, 255 s |
| Peak memory | 2.64 GB (scope) | 2.2 GB |
| Heights | peak 1.50 km, 20 % over 500 m, 3.8 % over 1 km (drainage grid) | 1.51 km, 14.8 %, 3.9 % |
| Top materials (576 sampled chunk columns) | grass 69 %, rock 18 %, soil 7 %, gravel 3.5 %, sand 2 %, snow 0.1 % | — |

Far selection at 2 px: 11,979 nodes from the town (7.1 MB), 3,439 from the corner. Disk free stayed ≥ 19 GiB.

**Pictures on the regenerated world** (staging, Iris Xe, 1280 × 720, medium, 04:30–04:50, load 1.3–5.8; the 00:34
set was of the world before the material tune and is replaced). `~/.cache/thirdlight-phase46/far-field/realistic/`:
`meshes/` and `bricks/` (`faces2` + fine shading) at 46d.7c's poses (`town-*`, `sight-*`, `peak-to-town`) and the new
peak's (`peak-sight-1/3/5km`, `beyond-peak-to-town`), both renderers; `side-by-side/` meshes left, bricks right, a
4× horizon crop below (`work/46d.12b/r2-compose.mts`); `near/` ground-level poses (`r2-plan-near.json`, picked by
`near.mts`/`nearplan.mts` from the landscape: river bed, boulders on scree, outcrop, grass/rock border, valley floor,
escarpment). The near poses ran one browser each after the third (an outcrop on a 970 m flank) filled the browser's
6 GB scope (5.9 GB RSS, 8.2 M far triangles while two selections were held; the shot run in one browser died there).

**Looked at** (every PNG opened). *Rings:* meshes paint every gentle grass slope and valley as alternating
grass/grey contour bands of about equal width (`peak-to-town`, `beyond-peak-to-town`, `sight-5km`, the town's
surroundings in `town-*`); bricks keep those slopes mostly grass with thinner grey/brown contour lines, still plain on
the far lowland in `peak-to-town`, `beyond-peak-to-town` and `sight-5km` (coarse nodes, numbers below), and none on
the near slopes of `town-west`/`town-north`. *Mush:* none in either mode at these poses; the bricks' rock faces show
a fine scaly ripple (the steps, D569), the meshes' a smoother fine banding. *Seams/specks:* meshes show white dotted
lines down cliff faces (`peak-to-town` right, `beyond-peak-to-town`, `sight-3km`); not seen in the bricks.
*Strips:* horizontal strips of colour across the valley floor seen from the town in both (4× crops of
`town-west`/`town-north`), fainter in the bricks. *River and town:* the dry gravel channels read as winding grey
paths below the town in both modes, crisper in the bricks; from the peaks the town is a red patch ringed by its
plain (bricks a cleaner rectangle). Snow caps read in both (bricks as solid patches, meshes speckled). Meshes against
bricks differ in 0.2–14 % of pixels (> 60), most at `peak-to-town` (14 %) and `beyond-peak-to-town` (10.7 %).
*Renderers:* WebGPU against WebGL 2 0.0–0.2 % of pixels in every far and near pair (`r2-rdiff.out`). *Near:*
`near-river` — the channel a stepped gravel trench with a soil bank patch, small boulders on the grass, and soil
strips on the far slopes; `near-boulders` — boulders sit on a gravel scree, but the cliff beside it is a regular
lattice of 0.5 m steps with pale ledge tops (reads as a grid, not rock), dark slits where rock meets gravel, and
rows of soil dots in the gravel; `near-outcrop` — a steep rock flank from 45 m: the near ring's face is a diagonal lattice of pale 0.5 m ledge squares between dark vertical slabs (stair-stepped, no overhang visible from here); `near-border` — a clean grass slope with soil patches, a rock strip along a gully down-slope, and past ~200 m the far meshes' grass/grey rings begin at once (the near/far edge reads as a change of pattern); `near-valley` — a flat grass floor with scattered boulders, soil banks and the stepped gravel channel, the far hills ringed; `near-escarpment` — boulders on a soil slope in front, the scarp face a stepped lattice with pale ledges, a white speck line on the mountain behind (far mesh). WebGPU and WebGL 2 near pictures differ in 0.0 % of pixels. `sight-1km`/`sight-3km` look at sky and a flank (46d.7c's terraced peak
is not in this world); the `peak-sight-*` poses replace them. Motion and pop not looked at (unverified).

**Rings, measured** (`work/46d.12b/ringmesh.mts`, `ringbrick.mts`, `r2-thin.mts`; the far cache's nodes over a
256 m grass valley at (−2048, −1536) cells, and a grass/rock flank at (2960, 2320); `r2-*.out`). The cause is one in
both modes: **a top cell under half full is not the surface** — 52–58 % of grass top cells at L2–L6 are filled
under half (the ½ m roughness and slopes mipped), and the cell under them is grass at L2, rock at L4–L6.
- Meshes (D571 confirmed): upward vertices over grass top cells taking another look — L2 56 % (soil 49), L3 56 %
  (rock 37, soil 20), L4 55 % (rock 52), L5 55 %, L6 62 % (rock 54–60); the flank the same (L2 57, L3 58, L4 55 %).
- Bricks, upward surface samples within a cell of the surface over grass top columns, non-grass, occupancy /
  `faces2`: L2 2 / 18 %, L3 3 / 6 %, L4 2 / 3 %, L5 14 / 11 %, L6 35 / 18 % (valley); flank L2 4 / 23 %, L3 6 / 6 %,
  L4 8 / 4 %. As drawn at the surface hit (colour weight not grass, fine ≈ flat): `faces2` L2 12–15 %, L3 4–9 %,
  L4 1–9 %, L5 10 %, L6 18 %. Occupancy's topmost-of-8 rule keeps a thin top's look at fine levels, but at L5–L6 its
  thin tops are dropped too; `faces2` at L2 has no L1 to read (built from its own cells) and its vote also counts the
  soil a step's riser shows. Fix for 46d.13 in D571 (not fixed here).

**Baseline for 46d.13** (this world, staging, Iris Xe, 1280 × 720, the 60 Hz cap, medium, from the town square;
46d.7d's orbit (3 × 8 s) and flight (2.4 km at 60 m/s); one run each, 04:50–04:58, load 2.8–4.0, uptime 17.5 d;
`work/46d.12b/r2-perf-*.json`, `r2-perf-uptime.txt`):

| | far draw | far GPU MB | page heap | job p50 / p95 | far fill | orbit missed (of ~480), p95 / max ms | flight missed (max ms) |
|---|---|---|---|---|---|---|---|
| WebGPU meshes | 4.80 M tris | 101.4 | 1,200 MB | 12.7 / 22.5 ms | 14.2 s | 0 / 0 / 0, 16.8 / 16.8 | 19 (67) |
| WebGPU bricks `faces2` + fine | 43,581 bricks | 99.4 | 588 MB | 71 / 108 ms | 55.1 s | 24 / 22 / 24, 150 / 350 | 32 (267) |
| WebGL 2 meshes | 4.80 M tris | 101.4 | 1,200 MB | 12.6 / 22.4 ms | 14.2 s | 0 / 0 / 0, 16.8 / 16.8 | 11 (83) |
| WebGL 2 bricks `faces2` + fine | 43,581 bricks | 99.4 | 703 MB | 71 / 109 ms | 55.7 s | 71 / 68 / 56, 33 / 1,333 | 27 (500) |

Read: against the terraced world (46d.12, same build) the bricks are 2 % more (43.6 k against 42.6 k), the fill and
job the same, the far entries 10.6 MB (8.9). The WebGPU bricks miss in long stalls (the misses are ~150 ms frames,
not 33 ms ones: p95 150 ms), WebGL 2 in more, shorter ones with 1.2–1.3 s spikes; the meshes hold the cap in the
orbit. Both flights miss on the far commits (D550/D551), the bricks more with 5.6× longer jobs. The meshes' page heap
is 0.5–0.6 GB over the bricks'. GPU timestamps not usable at the cap (D544).

### 46d.13a the shared foundation: thin tops as the look (D571), the faces job's reads (D570)

**Built** (ea5a0542). *Looks* (`@thirdlight/voxel`): a top cell under half full is not the surface in any build,
yet it is what the ground shows. `far-mesh.ts` `look`: first a thin top over the vertex (out along its normal to
1.5 cells, the outermost cell under half full before air; for ground facing up also straight up, since a slope's
normal leans downhill into the lower neighbour's air), then for ground facing more up than sideways straight down
before along the inward normal (which leans uphill into the higher neighbour's subsoil), then as before.
`far-bricks.ts` (occupancy) `sampleLook`: the topmost of the corner's 8 cells with air above (thin included), then
such a top one cell above or below, then the topmost solid, then the nearest. `far-bricks-faces.ts`: thin cells keep
their word; a cell is a top when it is not air and the cell above is; the vote is lexicographic: tops in the
footprint, then tops a node cell above or below it, then side cells (risers, walls) only where no top is in reach.
*Job* (D570): the `faces2` job decodes its finer entries straight to dense chunks and copies the cells it reads
(no store, no `voxelAt` per cell); the two distance transforms run their y and z passes only along the node's
sample lattice (`squaredDistances(…, every, from)`), exact. Output byte-equal to the old build before the look
change (digest over 433 town jobs).

**Tested.** `far-looks.test.ts` (3, new): a gentle slope of soil under a grass skin 3/16–7/16 full and a rock
cliff, built at level 3 through the jobs' own inputs (encoded entries): every upward vertex of the far mesh, every
upward surface sample of the occupancy and the `faces2` bricks is grass, every cliff-face vertex/sample is rock;
the `faces2` job decoding its entries equals `farBricksFromFaces` from a store. All three fail on the old code (the
bricks showed no grass at all). The far tests (21) pass; `far-bricks-faces.test.ts` caught a first vote that let
the ground's tops a cell below outvote a one-cell roof block (fixed by the lexicographic order).

**Measured.** *Rings* (`work/46d.13a/rings-run.sh`, the 46d.12b scripts on the staging far cache; valley at
(−2048, −1536), flank at (2960, 2320); non-grass share over grass top cells, before → after; `rings-summary.txt`):

| | meshes (upward vertices) | occupancy (upward samples / drawn) | `faces2` (upward samples / drawn) |
|---|---|---|---|
| valley L2 | 56.5 → 2.4 % | 1.8 → 0.0 / 1.6 → 1.1 % | 18.2 → 0.0 / 11.5 → 0.4 % |
| valley L3 | 56.3 → 1.8 % | 3.0 → 0.0 / 3.6 → 2.0 % | 5.9 → 0.1 / 4.1 → 0.7 % |
| valley L4 | 54.8 → 1.8 % | 2.3 → 0.0 / 3.8 → 1.9 % | 2.5 → 0.0 / 1.3 → 0.5 % |
| valley L5 | 55.2 → 1.2 % | 14.1 → 0.0 / 14.6 → 2.2 % | 11.4 → 0.0 / 10.0 → 0.6 % |
| valley L6 | 61.5 → 0.6 % | 35.1 → 0.0 / 32.6 → 2.0 % | 17.5 → 0.0 / 17.6 → 0.2 % |
| flank L2–L4 | 55–58 → 5.1–5.8 % | 4–8 → 0.0 / 7–13 → 5–8 % | 4–23 → 0–0.3 / 9–15 → 3–5 % |

The rest is material borders (a vertex or sample shared with a soil, rock or gravel top; on the flank most of it).
*Job* (Node, 433 town jobs L3–L6): 56.8 / 71.6 → 39.7 / 53.1 ms p50 / p95 (dense reads 49.8, then the lattice-only
transforms 35.0; the top vote adds ~5). *Page* (staging, Iris Xe, 1280 × 720, 60 Hz cap, medium, town square,
WebGPU, `faces2` + fine, 05:31, load 3.0–3.5; 46d.12b's baseline at 04:50, another hour): job 71 / 108 → 45 / 78 ms,
far fill 55.1 → 43.7 s, 43,581 bricks, 99.4 MB, heap 588 MB (same); orbit missed 24/22/24 → 21/24/24 (p95 150 ms,
D555), flight 32 → 27. The fill stays well above the ~20 s 46d.12 expected: the transforms and the decode of 64
entries a job remain (35 ms in Node), and the fill is bounded by the job queue too; for 13b/13c.

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13a/`: `mesh/`, `bricks/` at 46d.12b's poses, `side-by-side/`
46d.12b left, 13a right, a 4× crop below; `work/46d.13a/compose13a.mts`, every picture opened). *Rings:* gone in
both modes at every pose. `peak-to-town` (both renderers, WebGPU and WebGL 2 alike): the meshes' grey/green contour
maze is now a green plain with the gravel channels as brown/grey lines and the town a red patch; the bricks' grey
contour lines are gone, faint darker contour lines of the steps' shading remain on the lowland (shade, not
material). `beyond-peak-to-town`: both green lowlands; the meshes' snow caps now solid white instead of a white/grey
maze. `peak-sight-5km`: the grass on the massif's flanks reads as grass in both (meshes were rings). `town-west`:
the valley floor's horizontal strips (46d.12b) are gone in the meshes and nearly in the bricks (very faint thin
lines left): they were the rings seen at a grazing angle, and what is left in the bricks is the step shading. *New:*
in the meshes' `peak-to-town` far lowland, scattered pale grey flecks (likely boulders' rock tops a coarse vertex
now shows; unverified); a few sky-blue pixel specks on the meshes' rock face in `peak-sight-5km` (geometry, which
this change does not touch: the 46d.12b dotted cliff lines' kind). Motion and pop not looked at (unverified).

### 46d.13b-1 the ray-marched bricks improved: baked shading, the node march, half resolution

**Built** (d116bf13, fab6bf4f, 434cc33e; every step a switch, nothing made the default;
`faces2` + fine stays selectable as the reference). *a. Baked shading (D568)*, `?farShade=baked` /
`setFar({ shade: 'baked' })`: `@thirdlight/voxel` `far-bricks-shade.ts` (each sample's occlusion as the fine
shading had it at the hit, baked in the far job when the build asks: `FarBrickBuild.occlusion`, `FarBricks.occlusion`;
`bakeFarBrick`, `farBrickFineShade` the old per-pixel blend on the CPU). Three-adapter `voxel-far-palette.ts`: the far
colour of every look word drawn on the GPU with the surface's own `farColour` (256² RGBA8, a first draw of each
texel's word measures the read-back order) and read back, drawn again when the surface's table uploads; the atlas
then holds each sample's colour and occlusion (RGBA8, filtered: one read is the eight samples' blend) instead of
its look word, and resident bricks holding a changed word are baked again. *b. The node march (D555)*,
`?farMarch=node` / `setFar({ march: 'node' })`: a node is one instance of its stored bricks' marched boxes' union,
its fragment walks the node's 4³ brick table in ray order (a page in two atlas page stores: region and bounds +
faces, made only for the node march) and marches only stored bricks over their own boxes (`far-bricks-node.ts`
`marchFarNode`, the CPU port). The skip map is the build's own brick table (empty and inside bricks are skipped in
one DDA step); no finer coarse map was needed (below). *c. Half resolution*, `?farRes=half` /
`setFar({ res: 'half' })`: `voxel-far-half.ts`: the brick draws go into the pass's own scene, marched before the
frame (`VoxelFarView.prepare`, called by the page) into a half-size RGBA float target holding packed colour, octahedral
view normal and view depth; a full-screen composite in the frame upsamples (bilinear weights × depth similarity to
the nearest hit texel, under half the weight on hits → behind), is lit by the scene's lights and writes the far
depth. One path both renderers. The reuse of the last frame (reprojection) is **not built** (D574). Page only:
Play, Scene view and exports draw the full-resolution bricks (no `prepare`). Upgrade checklist row added.

**Tested.** `far-bricks-shade.test.ts` (2): faces2 bricks from a real store (rough ground of four materials and
wetness, a roof block), 11,732 surface points: the baked read against the per-pixel fine shading: blend identical
(< 1e-6), mean 1.2 % of the colour, p90 3.3 %, p99 5.7 % (the occlusion taken at the samples); the far job bakes
the same occlusion, samples unchanged. `far-bricks-node.test.ts` (1): 6,000 rays from all bearings and heights into
a node of rough ground, a roof block and an overhang: the node march meets exactly what the nearest brick-by-brick
march meets (2,914 hits, worst |Δt| 0), never a hit where none is (3,086 misses), ≤ 8 bricks walked; the node box
holds every brick box. `voxel-far-view.test.ts` (+3): baked switch uploads every brick again (4 bytes a sample),
the baked program reads ≥ 30 fewer textures than the fine one; node instances, boxes, pages; the half pass and the
composite built on WGSL and GLSL; back again. Fast gates gate-fast-20261110-061054 (D567 once, GREEN on rerun
gate-rerun-20261110-062449) gate-fast-20261110-064526 and gate-fast-20261110-073410 GREEN (D523/D554 failed once, passed alone);
`voxel-world.e2e.ts` not changed.

**Measured** (staging, Iris Xe, 1280 × 720, the 60 Hz cap, medium, the realistic 8 km world from the town square,
46d.7d's orbit (3 × 8 s) and flight; one run each per renderer, 06:27–07:10, load 3.5–4.6, uptime 17.6 d;
`work/46d.13b-1/perf-*.json`, `perf-uptime.txt`; the reference's WebGPU run had a vitest run beside it):

| | far GPU MB | page heap | job p50 / p95 | fill | orbit missed (of ~480), p95 ms | flight missed (max ms) |
|---|---|---|---|---|---|---|
| WebGPU `faces2` + fine (ref) | 99.4 | 588 MB | 46 / 79 | 44.3 s | 23 / 24 / 24, 150 | 34 (233) |
| WebGPU a. baked | 164.5 | 624 MB | 52 / 94 | 49.3 s | 16 / 14 / 12, 16.8 | 18 (233) |
| WebGPU b. + node march | 164.3 | 624 MB | 51 / 90 | 48.3 s | 1 / 3 / 0, 16.7 | 14 (67) |
| WebGPU c. + half resolution | 164.3 | 624 MB | 50 / 89 | 47.6 s | 0 / 0 / 0, 16.8 | 17 (67) |
| WebGL 2 ref | 99.4 | 747 MB | 49 / 91 | 48.2 s | 75 / 26 / 59, 33.4 | 25 (283) |
| WebGL 2 a. baked | 164.5 | 662 MB | 52 / 92 | 48.9 s | 13 / 14 / 10, 16.8 | 23 (333) |
| WebGL 2 b. + node march | 164.3 | 624 MB | 51 / 90 | 48.2 s | 0 / 0 / 1, 16.7 | 15 (67) |
| WebGL 2 c. + half resolution | 164.3 | 747 MB | 49 / 88 | 47.4 s | 0 / 0 / 0, 16.8 | 13 (83) |

Read: baking removes the per-pixel colour reads (WebGL 2's misses ÷ 4; WebGPU's long stalls gone, p95 150 → 16.8 ms)
at +65 MB of GPU memory (RGBA8 a sample for the 2-byte look words). The node march takes the overdraw away (D555's
cause): from 12–16 to 0–3 a round, the meshes' level (46d.12b: 0). Half resolution takes the last few, within one
run's noise. The flights' misses are the far commits on the page's thread (D550/D551) as before, their longest
frames 233–333 → 67–83 ms. The job's occlusion costs ~5 ms p50 (fill 44–48 → 48–49 s). 43,581 bricks every run;
the brick-table pages are 2 × 256 B a node (inside the MB above, as allocated). GPU timestamps not usable (D544).
Why no finer skip map: with the node march the 0–3 left are within noise, and a stored brick's tight bounds
(46d.12) already start the march at its surface's cells.

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13b-1/`: `ref/`, `v3/` (baked + node), `v3-half/` (+ half
resolution) at `town-west`, `town-peak-4.5km`, `peak-to-town`, `peak-sight-5km`, `beyond-peak-to-town`, both renderers;
`side-by-side/` ref left, variant right, a 4× crop below (`work/46d.13b-1/compose.mts`); every picture opened).
*v3 against ref:* the same picture at every pose: 0.00–0.03 % of pixels differ by > 60, 0.03–0.63 % by > 20
(most on `peak-to-town` / `beyond-peak-to-town`: the lowland's step-shading contour lines a little softer where the
occlusion is the samples' blend); crops alike (rock steps, snow edges, grass flecks, town roofs against the far
slope). *v3-half against ref:* 0.19–0.47 % by > 60, 0.9–4.7 % by > 20: silhouettes against the sky step in 2-pixel
stairs (`peak-sight-5km`, `town-peak-4.5km` crop, `peak-to-town` horizon), surfaces softer (rock step texture and
grass flecks blurred), and on the slope left of the valley in `town-west` the step shading turns into a moiré of
wavy bands not in ref. No holes, no bleeding across silhouettes, no dark fringes at the near field's edge seen.
WebGPU against WebGL 2: ≤ 0.03 % (> 60) for every variant. *Motion* (`motion/v3-strip.png`, `v3-half-strip.png`:
8 frames ~0.2 s apart during the orbit at `town-west`, WebGPU): v3 steady; v3-half's moiré bands on that slope
change from frame to frame (shimmer), silhouettes crawl in 2-pixel steps. Ghosting: none possible (no reuse of the
last frame). WebGL 2 in motion and the high tier: unverified. A material record's edit re-baking the bricks: unverified
in a browser (the palette's first draw and read-back are seen right on both renderers: v3 matches ref).

**For 13b-2.** Select the variant by URL `?farField=bricks&farBricks=faces2&farShade=baked&farMarch=node` (add
`&farRes=half` for the half-resolution march) or the hook `setFar({ mode: 'bricks', bricks: 'faces2', shade: 'baked',
march: 'node', res: 'half' | 'full' })`; `state().far` reports `shading`, `march`, `half`. The reference is
`farShade=fine` with the brick march (the defaults).

### 46d.13b the bake-off: ray-marched bricks (v3) against rasterized bricks, meshes as reference

**Built (13b-2, f99af3cb; a switch, not the default).** `?farMarch=raster` / `setFar({ march: 'raster' })` with any
brick build (bake-off: `faces2` + `farShade=baked` for the occlusion). `@thirdlight/voxel` `far-bricks-raster.ts`:
each brick sample the centre of a cube one node cell across, solid below 0; a face between two neighbouring samples
of opposite signs, half way, facing out of the solid one, with its look word (a neighbour's where it is 0) and baked
occlusion; a node owns its samples 0–32 an axis, each cube clipped to its box (same-level neighbours draw a shared
sample half each, nothing twice; nodes of any level cover their boxes, so no gap across the ground); skirts on the
box faces for solid samples within `FAR_SKIRT_CELLS` of the surface (the lip rule), lit as the field's steepest
direction (first lit as the box face: downward skirts read as black dots along node seams; without skirts sky holes
opened at level seams; both seen and fixed before the runs). Three-adapter `voxel-far-raster.ts`: one instanced
square draw a group, 12 bytes a face (cell, kind, shading direction, look, occlusion; positions in whole cells, the
object scaled, so shared corners are bit-equal); colour as the meshes' times the occlusion; far depth from the vertex
stage; the near cover tested per face in the vertex stage (moved off screen). No atlas, no march, no fragment depth
or discard. Faces are made on the page when a node arrives (0.3 / 0.7 ms p50 / p95 a node). Merged runs (one
tangent, same look) were counted, not built: 2.34 M instances for 3.65 M faces (−36 %), at the price of T-junction
cracks. *Tested:* `far-bricks-raster.test.ts` (3, real `faces2` bricks from stores): flat ground gives exactly its
33² top faces covering 32² cells once, skirts only on the four sides; a block in the air its six 3 × 3 sides; over
rough ground across bricks and two nodes no face lies between two solid samples, none is missing between solid and
air, the shared samples are equal and each node draws half of every face there. `voxel-far-view.test.ts` (+1): an
instance a face, no atlas (bytes = faces × 12 + the square), programs built on WGSL and GLSL with no `frag_depth` /
`gl_FragDepth`, no `discard`, no loop; back to the node march. Fast gate gate-fast-20261110-081703 GREEN (15 min,
5.0 GB; D307/D418 `scan-bounded-log` once, passed alone); `voxel-world.e2e.ts` not changed.

**Measured** (staging, Iris Xe, 1280 × 720, 60 Hz cap, the realistic 8 km world from the town square, 46d.7d's orbit
(3 × 8 s) and flight (2.4 km at 60 m/s); one run each, back to back, 08:32–08:50, load 3.0–3.8 (1-min), uptime
17.7 d; high 08:50–08:55, load 4.4–5.7; `work/46d.13b-2/perf-*.json`, `perf-uptime.txt`). Far job p50 / p95 the
same far brick job for all brick rows (50 / 90 ms); the meshes' 13 / 23 ms.

| medium | far draw | far GPU MB | page heap | fill | orbit missed (of ~480), p95 ms | flight missed (max ms) |
|---|---|---|---|---|---|---|
| WebGPU meshes | 4.80 M tris, 40 draws | 101.4 | 1,200 MB | 14.1 s | 0 / 0 / 0, 16.8 | 9 (67) |
| WebGPU v3 full | 43,581 bricks | 164.3 | 624 MB | 48.3 s | 1 / 2 / 0, 16.8 | 16 (100) |
| WebGPU v3 half | same | 164.3 | 588 MB | 48.6 s | 0 / 0 / 0, 16.8 | 14 (83) |
| WebGPU raster | 3.65 M faces, 7.30 M tris | 43.8 | 1,360 MB | 48.8 s | 18 / 17 / 16, 16.8 | 23 (250) |
| WebGL 2 meshes | 4.80 M tris | 101.4 | 1,280 MB | 15.4 s | 0 / 0 / 0, 16.7 | 13 (83) |
| WebGL 2 v3 full | 43,581 bricks | 164.3 | 703 MB | 48.8 s | 1 / 1 / 0, 16.8 | 19 (83) |
| WebGL 2 v3 half | same | 164.3 | 747 MB | 48.2 s | 0 / 0 / 0, 16.7 | 16 (67) |
| WebGL 2 raster | 3.65 M faces, 7.30 M tris | 43.8 | 1,360 MB | 49.8 s | 38 / 24 / 26, 33.4 | 20 (283) |
| high, WebGPU v3 full | 72,691 bricks, 52 draws | 315.2 | 747 MB | 81.1 s | 8 / 7 / 7, 16.8 | 26 (100) |
| high, WebGPU raster | 6.07 M faces, 12.1 M tris | 72.8 | 2,620 MB | 83.8 s | 23 / 23 / 24, 166.6 | 188 (383) |

Read: draws 40 (52 at high) and ~192 frame draw calls in every row; `render()` p50 2.2–2.5 ms everywhere. The raster
faces are 12 bytes each (43.8 MB: a quarter of v3's atlas), but 3.65 M of them are 1.5× the meshes' triangles:
1.14 M face up, 1.14 M face down (undersides: back-facing from the town, culled only after the vertex stage; where
they lie not traced), 0.74 M sideways, 0.73 M skirts (20 %; counts from the probe run before the bake-off). The orbit misses are vertex work (the meshes' 4.8 M triangles miss 0; no
fragment cost is left to cut); WebGL 2's p95 33 ms is a steady half rate. The page heap +0.74 GB over v3 (the faces
and instance arrays held on the page, plus the rebuilds' garbage; not split further) and 2.6 GB at high, where the
flight missed 188 frames with ~150 ms stalls. v3 full holds the cap at medium on both renderers (0–2), half
resolution takes the rest (0), and at high misses 7–8 a round with far GPU 315 MB (D573). WebGL 2 raster runs logged
ANGLE's "Running out of reserved outsideRenderPass queueSerial" (instance buffers rebuilt per group, D557's kind).
GPU timestamps not usable at the cap (D544).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13b-2/`: `raster/` both renderers at the five 46d.12b poses;
`side-by-side/` raster left, v3 full right (13b-1's v3 pictures: its draw is unchanged since), a 4× crop below;
`motion/raster-strip.png`, `v3-strip.png`, 8 frames ~0.2 s apart in the orbit at `town-west`, WebGPU; every picture
opened). *Raster:* silhouettes keep the massif's outline but step in visible cubes against the sky (`peak-to-town`,
`beyond-peak-to-town`, `peak-sight-5km`); gentle slopes and the lowland become a dense maze of terrace contours
(lit tops against dark risers: the step pattern the old mesh rings had, now from shading, `peak-to-town`); rock faces
a grid of light/dark specks (`peak-sight-5km`, `beyond-peak-to-town` crops); the whole far field reads darker and more
saturated than v3 (faces lit by their cube normal, not the field's gradient); a few pale flecks where skirts show at
level seams (`town-peak-4.5km` peak); snow caps and gravel channels thinner; the town a red patch, as in v3. No sky
cracks, no black dots, no strips at the near edge seen. WebGPU against WebGL 2: 0.1–0.6 % of pixels (> 60). Against
v3 17–36 % of pixels differ by > 60, partly the near town framed a few pixels apart (the orbit's start), mostly the
far field's darker step shading. *v3 full:* smooth slopes, soft rock, snow caps whole, as 13b-1 described.
*Motion:* the raster strip's slopes show step-edge moiré arcs that change from frame to frame (shimmer); v3's strip is
steady. Pop at level changes not seen in either strip; WebGL 2 in motion and the high tier's pictures unverified.

**Verdict (recommendation for 13c's default, owner to confirm).** **Ray-marched bricks v3 at full resolution**
(`faces2` + baked + node march): it holds the cap at medium on both renderers with the meshes' smooth look kept, uses
half the meshes' page heap, and is the owner's chosen direction. Rasterized bricks lose on the floor GPU on every
count but GPU memory: 1.5× the meshes' triangles at medium (16–38 missed a round), 2.5× at high (stalls), +0.7 GB
page heap, a terraced, speckled look that shimmers. They stay behind the switch for a measurement on a dedicated GPU
(where vertex rate is cheap) or are retired in 13c (owner). Half resolution stays a switch (not needed at medium;
D574 before it is used). **13c must still fix:** far GPU memory (164 MB medium, 315 MB high: D573's palette index,
D557's atlas growth and give-back); the fill (48 s against the meshes' 14 s; the far job 50 ms) and the flight
(14–19 missed against the meshes' 9–13: D550/D551, commits off the page's thread); the high tier's 7–8 misses (try
half resolution there with D574's reuse); Play, the Scene view and exports drawing v3 (today only the page selects
it); pop at level changes (unverified); then make it the default and the mesh field the fallback (46d.14).

### 46d.13c-1 bricks v3 the default far field; the losing variants retired

**Built** (40fe19d0 the default, 1cd4be9a the retirement). *Default:* `FAR_FIELD_BY_TIER` draws `bricks` on every
tier (low, medium, high); the far field builds `FAR_BRICK_BUILD` (`@thirdlight/voxel` `far-bricks.ts`: faces from the
children, `scale` 2, occlusion baked in the job), the one place the build is defined; the three-adapter far view has
one shading (baked) and one march (a node a box over its brick table), so every host that draws a voxel world draws v3:
Play (worker and single thread), exports, the Scene view and the voxel world page, both renderers. The mesh far field
stays selectable: the quality field `voxelFarField: 'mesh'`, the page's `?farField=mesh`, the hook's
`setFar({ mode: 'mesh' })`. Play's voxel hook (`__tlVoxelPlay`) now reports each world's far draws (`far`: nodes,
bricks, triangles, draws, GPU bytes) and can hide them (`showFar`). *Retired* (one path to maintain): the occupancy
build (`brickFarNode`, `farBricksOf`, `FAR_BRICK_BUILD_OCCUPANCY`, `FAR_BRICK_BUILDS`), the flat and per-pixel fine
shadings (`FarBrickShading`, the look-word atlas), the box-a-brick march (`farBrickGeometry`, its three attributes,
`marchFarBrick`, `farBrickBox`), the rasterized bricks (`far-bricks-raster.ts`, `voxel-far-raster.ts` and their
tests, the page's `farRuns`). Their code is in git: ad8b9da3 (occupancy, flat, box a brick), 0c1be6cb (faces builds,
fine), d116bf13 (baked), fab6bf4f (node march), f99af3cb (raster); a0de93e3 is the last tree holding all of them.
The page's `?farBricks`, `?farShade`, `?farMarch` are ignored with a console warning naming them; the hook's `bricks`,
`shade`, `march` throw (nothing applied). *Kept:* half resolution as the page's off-by-default switch (`?farRes=half`,
`setFar({ res })`): one module and one flag, and the planned path for the high tier's misses (13c-2, with D574's reuse).
Lines: 1,399 removed, 319 added in the retirement. Render spec §4 and the manual's far field section rewritten; the
reference regenerated (the field's description).

**Tested.** `voxel-world.e2e.ts` (extended, no new file): the page's far field settles as bricks by default (draw
`bricks`, bricks > 0, no triangles, no background below the horizon) and switches to the mesh fallback (triangles,
no bricks, no background) on both renderers; Play (WebGPU worker, WebGL 2 single) and the export served with the
backend stopped switch to the low tier, where the play world's own load ring is 40 m (`quality.low`, so the pit
camera's upper frame looks past the near field), and prove far bricks drawn (no triangles) and pixels past the near
field that are the background with the far draws hidden and ground with them shown (Play 2,854 / 2,495 px, export
25,674 px). Time 72.1 → 75.3–77.3 s (two gates). Vitest: the tiers' far mode (`voxel-world.test.ts`), the far view's
one path (`voxel-far-view.test.ts`: a node an instance over its pages, baked uploads, programs on WGSL and GLSL,
kind swaps, half resolution), the faces build from the node's own cells as the lowest level reads it
(`far-bricks.test.ts`, the box march on fixed rays with the lip), the page's defaults and refused switches
(`page-view.test.ts`, new). Fast gates gate-fast-20261110-092005 (red: the far view test assumed the old defaults;
GREEN on rerun gate-rerun-20261110-093122) and gate-fast-20261110-094844 GREEN (15 min, 5.1 GB; D523/D554's two
tests timed out once under load and passed alone; village perf 0 missed both renderers).

**Measured** in Play (staging, Iris Xe, the editor's Play frame pinned to 1280 × 720, the 60 Hz cap, medium pinned
by the project's level, the realistic 8 km world; a camera script orbits the town square at 0.15 rad/s as the page's
perf does and flies 2.4 km toward the peak at 60 m/s; one round each, 10:32–10:43, load 2.0–7.4, uptime 17.7 d;
`work/46d.13c-1/play-perf-*.json`, `perf-uptime.txt`, `play-perf.mjs`):

| medium, Play | far draw | far GPU MB | fill from page load | orbit missed (of ~480), max ms | flight missed (of ~2,390), max ms | frame heap |
|---|---|---|---|---|---|---|
| WebGPU v3 (worker) | 2,598 nodes, 43,681 bricks, 40 draws | 164.3 | 138 s | 0 / 0 / 0, 16.8 | 3, 133 | 1.13 GB |
| WebGL 2 v3 | same | 164.3 | 137 s | 1 / 0 / 0, 66.6 | 1, 50 | 1.07 GB |
| WebGPU meshes | 2,290 nodes, 4.81 M tris, 40 draws | 101.6 | 38 s | 1 / 0 / 0, 33.4 | browser OOM-killed in its 6 GB scope | 1.83 GB |
| WebGL 2 meshes | same | 101.6 | 38 s | 0 / 1 / 0, 33.3 | browser OOM-killed in its 6 GB scope | 1.83 GB |

Read: v3 holds the cap in Play as on the page (13b: 0–2); the mesh fallback too, at +0.7 GB of frame heap, and its
flight ran the editor + Play browser out of its 6 GB cap on both renderers (the bricks' did not). The fill is 3.6×
the meshes' (the page: 48 vs 14 s); counted here from the editor's page load, near field and far field together.
During the flight the drawn far set did not change (2,598 nodes before and after, the camera 2.4 km on at its end):
no far group was swapped in within 40 s while the near field streamed (its jobs go first; D550/D551, 13c-2). A run
before the level was pinned started at the device's high tier and filled 4,298 nodes, 71,189 bricks, 315 MB in 217 s
with 0 missed a round. From above the peak side the atlas held 204 MB (D557's growth). GPU timestamps not used (D544).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13c-1/`, Play, medium, both renderers: `town-0` the town
square toward the massif, `town-1` a third of the orbit on, `peak-to-town` from 1.8 km up 3.6 km toward the peak;
every picture opened). The town's near field in front, the far field past it with no cut-off, no dark strip or gap
along the near field's edge; the valley floor and the grass slopes carry fine horizontal step-shading lines (the
terraces' shading, strongest on the gentle slopes before the massif: the look 13a/13b described, D569's kind), the
massif's rock and grass patches and the gravel channels read clearly, snowless peaks smooth. `peak-to-town`: the green
lowland with contour-like shading, the channels as brown/grey lines, the town a small red patch, the massif's peaks
behind, a rocky ridge in front; WebGPU and WebGL 2 pictures alike (the town poses differ by the orbit's timing). The
first e2e pictures at a 20 m test ring showed the far field drawing over the near field in the near cover's
uncovered outer chunk ring, the mesh fallback too (D577). Motion in Play not looked at (unverified); the high tier's
pictures and an edit re-baking the palette in a browser unverified.

### 46d.13c-2 the far slopes' contour lines (D569) and the near field's edge ring (D577)

**Cause (numbers; `work/46d.13c-2/slope.mts`, `real.mts`).** The faces field took a finer cell under half full as
air and moved only a corner touching both kinds (by ½ − the mean fill). A gentle slope's tops are part-full cells
whose solid steps one finer cell every few columns; the node's samples, two finer cells apart, made those steps flat
treads and steep risers: on a synthetic 6° slope at the children's resolution the draw's normal (the hit brick's
gradient, ±½ cell) swung −6° … +15° about the true slope (sd 5.6°), the height 0.08 node cells rms off, the tread
period one finer cell of rise, i.e. a contour every 0.5 · 2^(L−1) m of height (L3: 2 m, L4: 4 m). On 22 real far-cache
nodes along the town–peak line (L3–L5; 52 % of the children's top cells part-full) the normal against its local
median (±1.5 node cells, ground under 30°) was 4.8–5.2° rms, p95 10–11°. The Play sun at a low angle and the grazing
view turn that into the bands. Not aliasing of the sample spacing: the same field read at ¼-cell columns shows it.
A second, smaller part: the trilinear blend's slope changes from cell to cell where the surface is not a plane, so
even an exact field swung the ±½-cell normal by ~2–3° a cell (the fine lines left after the first fix).

**Built** (c0ca48b3 the spans and the edge ring, 46731dbe the ±1-cell normal). `@thirdlight/voxel` `far-bricks-faces.ts` `spanDistances`: a part-full
cell is solid up to its fill as a height (from the side of its fuller vertical neighbour, below on a tie; the near
terrain mesher reads the fill as a height too); each corner's distance is exact to that solid: the distance along y
to each vertical corner line's solid or air spans (one pass up, one down), then the separable transform's x and z
passes (`squaredDistanceLines`, split out of `squaredDistances`); a surface corner whose 8 finer cells are all whole
keeps the old ½ − mean rounding, so whole-cell worlds and buildings build byte-equal to before. `far-bricks-shade.ts`
`FAR_BRICK_NORMAL_SPAN_CELLS` = 1: the normal's central differences a cell either side (CPU and both shaders; same six
reads, no per-pixel cost); the baked occlusion follows it. D577: the near cover's wire marks its edge ring
(`NEAR_COVER_EDGE` 1, hidden `NEAR_COVER_HIDDEN` 2); `FarCover.behindNear` gives a far point in the ring at least the
distance of the cover box's farthest corner from the camera, so every near fragment is in front of it and the far
field there only fills gaps: bricks per fragment (also the half-resolution target's depth), the mesh fallback per
vertex (its depth is written in the vertex stage; a triangle across the ring's outer edge blends, not looked at).

**Tested.** `far-bricks-faces.test.ts` (+1): a 6° slope of part-full finer tops: heights within 0.06 node cells and
the normal within 3° of the slope over 720 columns (old build: 0.19 cells, fails); a 15 m scarp at level 3 keeps its
3.75-cell step within a node cell, its face > 60°, the terraces < 2° up to it. `chunk-batch.test.ts`: the cover's
hidden chunks, its edge ring and nothing else. `voxel-world.e2e.ts` (`farBeyondNear`, Play both renderers and the
export): no near-field pixel away from its silhouette drawn over when the far field shows (< 200). At the e2e's 40 m
ring this held before too; at a 20 m ring (a scratch copy, not committed) the old build fails it with 895 (Play
WebGPU) and 8,490 px (export: the grey wedge in front of the wall, far slabs over the ground, `far-field/13c-2/ring20/`),
the new one passes. Fast gates: gate-fast-20261110-111027 GREEN (14 min, 5.1 GB; `scan-bounded-log` once, D307/D418's
watch, passed alone; village perf 0 missed both); gate-fast-20261110-115630 (the normal) red on the export's new check,
146 k "drawn over" pixels: the pair was taken while the camera's auto exposure still adapted to the far draws hidden
(the whole frame shifted, nothing drawn over, picture opened), so each shot now waits for it (3 s hidden, 1.2 s
shown) and a pair taken meanwhile is taken again; GREEN on rerun gate-rerun-20261110-121245, the Play tests passed
alone with it (`scan-bounded-log` and `edge-cases.test.ts` once, passed alone). `voxel-world.e2e.ts` 75.3–77.3 →
~83 s (the exposure waits, +6 s in the three far checks).

**Measured.** Synthetic slopes (normal − true, sd; old → spans → spans + ±1 cell): 3° 4.6 → 0.66 → 0.30°, 6° 5.6 →
0.72 → 0.51°, 10° 6.7 → 1.9 → 1.2°, 20° 5.3 → 3.6 → 2.1°, 35° 5.0 → 3.9 → 1.9°; whole-cell slopes unchanged (their steps
are the data). Real nodes (rms against the local median): L3 5.23 → 2.32 → 1.48°, L4 5.15 → 2.91 → 1.86°, L5 4.76 →
3.37 → 1.89°; p95 10.4–11.1 → 3.3–4.3°. Far brick job (Node, the 433 town jobs L3–L6): p50 / p95 48.6–49.2 / 65–67 →
50.8 / 71 ms (+4 %; a first version's per-corner scan upward was +16 ms, made linear). Play (staging, Iris Xe, editor
Play frame 1280 × 720, 60 Hz cap, medium, the realistic 8 km world, town square, orbit 3 × 8 s, one round a renderer;
before 11:25–11:34, load 1.4–4.7; after 11:46–11:55, load 1.6–5.6; uptime 17.8 d; `work/46d.13c-2/play-*.json`,
`perf-uptime.txt`): WebGPU missed 0/0/0 → 2/0/0 (max 83 ms), WebGL 2 1/0/0 → 1/0/0 (max 150 → 67 ms) of ~480; far
2,598 → 2,600 nodes, 43,681 → 43,698 bricks, 164.3 MB both; fill from page load 136–143 → 140–145 s (D550/D551's,
13c-3); frame heap 1.07–1.13 GB both. Within one round's noise: no cost change seen.

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13c-2/`: `side-by-side/<pose>-<renderer>.png` before left, after
right, a 4× crop of the most banded rows below, poses `town0`, `town1` (13c-1's town-0/1 as static poses), `west`,
`peak` (13c-1's peak-to-town), `sight5` (peak-sight-5km), both renderers; `motion/before-strip.png`,
`after-strip.png`; `ring20/`; every picture opened). *town1, west:* the valley's wide curved contour rings on the
gentle slopes before the massif are gone, the lowland reads as one smooth green slope; the gravel channels, the rock
patches and the massif's ridges unchanged. Faint thin horizontal lines are left on the steeper grass slopes in the
distance (much weaker; visible in the 3–4× crops, hard to see at 1:1). *town0:* the slope behind the town loses its
treads; the rock face is smoother than before (the first fix alone made it speckled, which the ±1-cell normal took
away). *peak:* the lowland's dense contour maze round the town is gone; cliffs, scarps, crags and the ridge lines keep
their shape and shading. *sight5:* the massif alike, its faces a little smoother, the grass below free of the fine
contours. Pixels changed by > 60: 0.6–3.9 % (> 20: 7–20 %); vertical-over-horizontal gradient in the far band 2.21–2.71
→ 1.90–2.23 at the town poses, ~1.1 unchanged from above. WebGPU against WebGL 2 ≤ 0.23 % (> 60), as before. *Strip*
(8 frames in the orbit from town-west, WebGPU, ~0.3 s apart): steady, no crawling bands seen at the strip's half size
(the camera turns a lot between frames; fine shimmer at full size unverified). *ring20:* the export's grey wedge in
front of the wall and the far slabs over the near ground are gone, the Play pit view the same as with the far field
hidden; a small grey far spike past the near field's back edge remains where the near field draws nothing.
*Unverified:* WebGL 2 in motion, the high tier, the mesh fallback's ring in pictures, the faint lines' cause (not
traced further: the slope's fill rounding, 1/15 cell a column, or the march's half-pixel stop).

### 46d.13c-3 the far field follows the flight; its GPU memory bounded

**Built.** *Step 1* (47cfbde4): the pump looks at a todo node once a scan by key (its reads remembered, checked when
sent) at most every 50 ms (pump 10 → 0.3 ms); diagnostics carry the stream, pool and far stages. *Step 2* (3dff0720):
far jobs are the pool's background jobs (`PoolJob.background`): their own queue, sent when nothing else waits or
while fewer than `BACKGROUND_WORKER_SHARE` (¼, at least one) of the workers run one; the selection is a generator
(`FarSelection.steps`, 256 nodes a step) the far field runs in 2 ms slices; nodes are made where the error drawn now
is largest (nothing drawn, then a coarse stand-in by its error, then nodes closing over finer ones) and a commit puts
in whole groups in that order up to 1 MiB of event bytes, the rest 50 ms later. *Step 3* (7a27b8a9):
`FAR_GPU_BUDGET_BYTES_BY_TIER` (`@thirdlight/voxel`; low 96, medium 176, high 288 MiB, through `levelVoxels` →
`resolveVoxelWorld().far.gpuBudgetBytes` to Play, exports, the Scene view and the page; a level cannot set it).
The selection opens nodes by error, largest first, while their GPU bytes fit (`FarView.gpuBudgetBytes`,
`gpuBytesOf`); `FarGpuLedger` counts a made node's bytes as they came (`farBricksGpuBytes`: `FAR_BRICK_GPU_BYTES`
3,645 a brick + 8 a table entry, the atlas's own regions, pinned by a test) and foresees the others from their stored
bytes by the made nodes' ratio (prior `FAR_GPU_PER_STORED_BYTE` 70: measured 66.5–71.2 on the 8 km world); it
selects again when that ratio moves 25 %, or (≤ 3 times an eye) when all came in over the budget. Over the budget,
nodes closing over finer ones go first and refinements wait while jobs are out. `VoxelShaderGrids` (the atlas's
stores and the near grids) hands out its oldest part first and `trim` gives back growths no region uses (a GPU copy
of the smaller box; regions keep their origins). `spanDistances` (~42 % of a far job) not made cheaper: not cheap
without a profile, left for the performance phase.

**Tested.** `stream.test.ts` (+1): a background share under a steady stream of near jobs; idle workers all theirs;
a queued one cancelled. `far-world.test.ts` (extended; real cache, workers): moves under a full pool swap in and out
and settle drawing exactly the selection; then a budget of half what is drawn held after 8 moves (drawn GPU bytes ≤
budget, nodes held), the way's peak < 1.25 × budget. `voxel-far-view.test.ts` (+2): a window of 8 nodes slid 60 nodes
keeps the atlas's size; 32 more grow it and their going trims it below half; a region store shrinks only past regions
in use and keeps their origins; the brick bytes equal the atlas's regions. `voxel-world.test.ts`: the tiers' budgets.
Fast gates gate-fast-20261110-141550 (step 2) GREEN (16 min, 5.0 GB; `edge-cases` D523 and far-world's "on disk"
test D579 timed out once, passed alone) and gate-fast-20261110-150057 (step 3) red on one e2e (the export's
`exportRoot is not a directory`, before anything ran), GREEN on rerun gate-rerun-20261110-151832 (`v4-limits` D416,
`edge-cases` D523, `stream` D554 once, passed alone; village perf 0 missed both). `voxel-world.e2e.ts` 88.5 (step 1)
→ 92.6 (step 2) → 91.2 s (step 3).

**Measured** in Play (staging, Iris Xe, editor Play frame 1280 × 720, 60 Hz cap, the realistic 8 km world, town
square orbit 3 × 8 s, then 2.4 km at 60 m/s; one round each, 14:57–15:36, load 4.9–10.6 (1-min), uptime 17.9 d;
`work/46d.13c-3/play-*.json`, `perf-uptime.txt`, `sum.mjs`). Far GPU = the atlas's texture bytes (MB = 10⁶ B).

| medium WebGPU unless named | fill from load | orbit missed (max ms) | flight missed (max) | flight swaps in / out, pending at end | far GPU town → flight end → settled | page heap |
|---|---|---|---|---|---|---|
| before (13c-2 code) | 142.5 s | 0 / 1 / 0 (50) | 1 (67) | 0 / 0, 5,214 | 164.3 → 164.3 → 315.2 | 1,070 MB |
| step 2 | 72.4 s | 1 / 1 / 0 (33) | 1 (117) | 255 / 558, 4,935 | 164.3 → 204.1 → 315.2 | 949 MB |
| step 3 | 79.0–80.0 s | 0 / 1 / 0 (33) | 2 (50–117) | 531–543 / 1,001–1,047, 4,322–4,392 | 164.3 → 204.1 → 204.1 | 894 MB |
| step 3, WebGL 2 | 80.8 s | 0 / 0 / 0 (17) | 0 (17) | 538 / 1,042, 4,393 | 164.3 → 204.1 → 204.1 | 842 MB |
| step 3, high | 128.7 s | 18 / 25 / 25 (417) | 8 (200) | 273 / 1,010, 7,713 | 315.2 → 315.2 → 315.7 | 1,070 MB |

Read: the town draws the same set as before at medium (2,600 nodes, 43,698 bricks, 153 MiB live, nothing held) and
high (4,392 nodes, 72,722 bricks, 255 MiB live). Settled at the flight's end medium draws ~2,940 nodes, 48.5 k
bricks, 170 MiB live with 3–6 nodes held by the budget (before: 3,448 nodes, 56.8 k bricks, ~198 MiB live in a 315 MB
atlas); the live peak 176.2–176.9 MiB (the budget 176: one commit's groups over), high 286.5 of 288 MiB. The atlas
did not trim in these runs (its last growth stayed in use; it stops at the budget instead); settling at the end 98 →
55–56 s (high 120 s). ~4,400 nodes are still pending at the flight's end (the far field's ~1 worker of 4 while the
near field streams). The high orbit's misses came while the far field was idle (no job, nothing pending, drawn set
unchanged, the near field streaming 821–866 chunks); not traced (D583); the first high run's browser closed mid-fill.

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13c-3/`; every picture opened). `town-webgpu-medium-s3b.png`,
`town-webgl2-medium-s3b.png` (the orbit's start, a few degrees apart): the town's roofs in front, the far grass slopes
and the massif past it, the gravel channel; no gap or strip at the near field's edge; the faint thin lines on the
slopes (D578) still there; both renderers alike. `end0/1/2-webgpu-s3b.png` (the flight's end, ahead, left, right,
settled): the near field in front a light grey surface with a grid of square recesses; right behind it the far bricks
read as coarse stepped cubes (2–4 m, snow, grass, rock), with a few black cells (end1) and thin shards and a dark box
along the near/far seam (end2); farther out the massif's slope and the green valley with its channels smooth (D582).
*Unverified:* WebGL 2 at the flight's end, the high tier's pictures, motion during the flight, a trim in a browser.

### 46d.13c-4 the flight's end traced (D582), the near field in a fast flight, the high orbit (D583)

**What the pictures showed (numbers; `work/46d.13c-4/heights.mts`, `probe.mjs`, `play.mjs`).** The 13c-3 flight
climbed 40 → 240 m over 2.4 km while the ground rises to 419 m there: from 0.7–0.95 km and again from 2.0 km on the
camera flew 9–17 m and then up to 180 m *inside* the massif (end pose: camera y 240.8 m, ground 419 m). (a) The flat
grey grid with square holes is not terrain and not the near field (with the far draws hidden the page and Play show
only sky there): it is the far bricks seen from inside solid rock: a ray starting inside a node's solid stops at the
first stored brick's box (a flat, unlit-looking face; the unstored solid bricks between read as square recesses, 16 m
chunk lines as the thicker ribs). Not a correct picture of anything; a camera inside the ground has nothing right to
show. (b) The stepped cubes with black cells and shards past it are the same view of the mountain's inner bricks
(their box faces and lips from inside). Above the ground (a new flight 30 m over the highest ground 60 m behind to
120 m ahead, the far cache's level-2 heights, 46–492 m) neither shows at the end. Two real faults came out of it:
- *The near field drew nothing during a fast flight and after it* (D584 new): in Play's flight the page drew 0 near
  chunks from 4 s in, the pool's queue full (253 of 256), and still 0 for 50+ s after the end with the queue empty
  (resident 7,394–7,616 chunks). The level choice ran only at the end of an update's node work, which returned early
  whenever the pool had no room or the work ran over its 2 ms: choices froze at 690 for the whole flight and after.
  Fixed (2ce43208): the choice and its seams run every update; a seam build the full queue refused is sent again
  20 ms later (else the swap draws its faces toward the finer level open: 487 bare faces in the test without it).
  After the fix the near field is back 8 s after the end (227 chunks); during the flight it still draws ~0 from 6 s
  on: at 60 m/s the load ring takes ~1,000 chunks a second and the loads keep the queue full (D584 stays open for that).
- *Coarse stand-ins next to the eye while travelling*: a refinement went in only once every wanted node under its
  stand-in was made (one group), and the nodes under the near field were made first (nearest first among equal
  errors). Fixed (2ce43208): a wanted node two or more levels finer than its stand-in is reached one level at a time
  (the stand-in's children first), and nodes whose every chunk the near field draws are made last. The far field
  remains the only thing drawn near the eye in a fast flight, at one worker's share (~15 nodes a second against
  ~35 the eye's band wants at 60 m/s); a camera inside a coarse stand-in's solid still shows the grid (D585 new).

**Tested.** `far-world.test.ts` (extended, real cache and workers): asked for nodes much finer than drawn with a near
field drawing a cylinder round the eye, every node wholly under it comes after every other in the work order, the
first is at the cylinder's edge, and every refinement swap replaces a node by nodes one level finer, never two (the
old order fails it: 0 hidden-last). `stream.test.ts` (the lod flight): its second half with the pool's queue kept
full by other jobs still swaps levels (> 2) with every seam (`bare` 0). Fast gate gate-fast-20261110-163707 GREEN
(16 min, 5.1 GB; village perf 0 missed both renderers). `voxel-world.e2e.ts` 91.2 → 93.7 s (not changed; noise).
Not done: a vitest of "no face-aligned cube surfaces on a smooth slope at a coarse level": the cubes were the
inside-solid view, not the brick build (above the ground no cube look was seen at any level).

**Measured** (staging, Iris Xe, Play 1280 × 720 at the 60 Hz cap, the realistic 8 km world, orbit 3 × 8 s, then the
new 2.4 km flight at 60 m/s; one round each, 15:50–17:43, load 2.1–9.3 (1-min), uptime 18.0 d;
`work/46d.13c-4/play-*.json`, `perf-uptime.txt`). In the flight (WebGPU / WebGL 2, at 30 s and 38 s): far nodes two
or more levels coarser than wanted outside the near field 2,107–2,162 / 3,175–3,248 before → 1,668–1,784 /
2,771–2,915 after; worst stand-in error 96–111 px before, 80–127 px after (noisy).

| medium unless named | fill from load | orbit missed (max ms) | flight missed (max) | flight swaps in / out, pending at end | far GPU town → end | page heap |
|---|---|---|---|---|---|---|
| WebGPU after | 84.7 s | 11 / 0 / 0 (50) | 4 (117) | 394 / 1,041, 4,944 | 164.3 → 204.1 MB | 894 MB |
| WebGL 2 after | 87.1 s | 8 / 1 / 0 (400) | 4 (233) | 263 / 1,002, 4,833 | 164.3 → 204.1 MB | 894 MB |
| high WebGPU after (7 GB scope) | 167.7 s | 20 / 24 / 17 (400) | 6 (183) | — | 315.2 → 315.3 MB | 1,070 MB |
| high, lighting medium | — | 24 / 26 / 26 (283) | 8 (167) | — | — | — |
| high, render scale 0.667 | — | 57 / 37 / 37 (133) | 8 (133) | — | — | — |

D583 (high orbit at load < 3): still 17–26 missed a round, a 117–150 ms frame every ~0.32 s while the far field and
the pool are idle (no job, no trim, no upload) and the near field swaps ~2 batches a second. Not the page's main thread
(0 long tasks ≥ 50 ms in the frame), not GC (heap flat at 1,130 MB), not the high lighting (same with medium
lighting); at render scale 0.667 the long frames go (1–3 a round) and 33 ms frames come (32–53): pixel cost at the
high tier's full resolution on the floor GPU. Left to 46d.16's meter (D583 open). Twice the editor + Play browser at
high closed mid-fill in its 6 GB scope (~114 s, 17.6 k resident chunks); in a 7 GB scope it ran (D586 new).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/13c-4/`; every picture opened). `page-end0-*-a` (the old end
pose in the page): the grey grid and the cubes with the far field shown, sky only with it hidden (the camera inside
rock). `fly10/20/30/38-*-before*` and `-nofar-`: the valley and massif smooth, the near field absent (sky only with
the far hidden) at every point; at 30 s a grey slab with square recesses in the foreground (the camera inside a coarse
stand-in's solid). `fly*-{webgpu,webgl2}-after`: 10 s and 20 s the green lowland, the channels and the massif with no
slab; 30 s a smooth green slope up to the rock (both renderers, no slab); 38 s WebGPU at the cliff: the grid and
blocky cubes on the left third again (inside a stand-in's solid at the steep face, D585), the rest smooth.
`end0/1/2-{webgpu,webgl2}-after` (65 m over the slope, settled): the near field's textured rock and grass patches in
front, the massif's ridge and the green valley with its channels past it; no grey grid, no cubes, no black cells, no
shards at the seam; both renderers alike; `end*-nofar-`: the near field alone covers the slope in front. *Unverified:*
motion (frames saved while moving only), the high tier's pictures, the seam at a camera low over flat ground.

### 46d.16 the GPU headroom meter at the cap; D583 traced

**Built** (ba27e91c). A load a measuring run adds to every frame at the 60 Hz cap, never uncapped and without
timestamps (D544): `GpuLoad` (three-adapter `gpu-headroom.ts`, the adapter's `gpuLoad()`, applied after the
frame's draw): a **ballast** of N copies of one fixed fragment load (32 dependent ALU steps over a 640 × 360
target) in one instanced draw, so its CPU cost does not grow with N; **copies** of chosen roots' drawables drawn
again into a target of the scene pass's size with the same camera, lights and programs (meter layer 29; their
CPU ms reported); **shadows hidden** (the shadow-casting lights stop casting); **post bypassed** (the scene drawn
at the stack's size, then copied to the canvas so the frame is still presented). The game page's
`__tlVoxelPlay.meter` (game-host `voxel-meter.ts`) drives it with the near field (`VoxelChunkView.showNear`) or
the far field hidden, and pins the tier's render scale with dynamic resolution off (it would draw smaller under
the load). The bench `node tools/voxel-bench/run.mjs headroom --quality medium --rounds 2` (`headroom-cli.ts`, how-to
in its comment; arithmetic `headroom.ts`) runs Play in the editor on staging's 8 km world, the town-square orbit
(the project's "Perf far camera"), WebGPU, 1280 × 720, and per round: (1) a window with no load; (2) **the edge**:
the ballast the frame holds before it misses (> 2 % of frames over 25 ms, or a mean interval 3 % over the budget),
doubling then halving the gap; (3) **past the edge**, where the GPU sets the interval, a load doubled until the
mean interval is ~30 ms and two lighter ones: their line; (4) at that load each pass hidden and near/far copied
once: the interval it moves; (5) copies held at no load, each pass hidden at no load, render scales at no load.

**Tested.** `headroom.test.ts` (search and line on a capped-GPU model: a window holds or misses, the edge within
its precision in ≤ 11 windows, no room, the line's slope and intercept, a hidden pass's share, a lower bound when
hiding takes the frame under the cap); `gpu-headroom.test.ts` (real three objects, a recording renderer: copies draw
only the roots' layer-0 drawables with both lights into a target of the pass's size, later arrivals too, and give
back the camera mask, target, MRT, auto-clear, sky and every layer bit; the ballast one draw clamped to its maximum,
its WGSL runs the steps; shadows off and back; the bypass draws at the stack's size then to the canvas). The bench
runs are the browser proof (staging, the hook in a real Play page). No e2e touched. Fast gate
gate-fast-20261110-182332 red on 4 vitest files (the first `near` group broke tests that read the view's root;
replaced by a visibility switch), rerun gate-rerun-20261110-183705 red once on D567 (Export `kitInstances` 0),
GREEN on rerun gate-rerun-20261110-184129 (village perf 0 missed both renderers).

**Measured** (staging, Iris Xe, Play 1280 × 720 at the 60 Hz cap, WebGPU, the realistic 8 km world settled
(fill 81 s medium); medium three rounds 18:17–18:52 (one session of two, one before), high one round 18:53–19:01,
load 1.4–5.5 (1-min), uptime 18.1 d; `work/46d.16/headroom-{medium,high}-*.json`, combined
`work/46d.16/headroom-baseline.json`, `table.mjs`). Room = the ballast held at the edge × its ms past the edge.
Pass ms: the interval fall with the pass hidden past the edge, given as its share of the four passes' falls
(range over rounds) × the frame's GPU ms from the edge; raw falls in brackets.

| tier | no load | room at the cap | frame GPU (busy clock) | near surfaces | far bricks march | post stack | shadows |
|---|---|---|---|---|---|---|---|
| medium (0.667 + TAAU) | 0 / 180 missed ×3 | 7–16 ballast (0.7–2.5 ms) | 14.2–15.9 ms | 28–33 %: 4.0–5.3 ms (4.2–6.9), × 1.14–1.6 | 39–50 %: 5.5–7.9 ms (7.3–8.1), × 1.09–1.5 | 19–24 %: 2.7–3.9 ms (2.8–5.0), × 1.2–1.9 | 2–4 %: 0.2–0.6 ms (0.25–0.75) |
| high (1.0 + TAAU) | 8 / 97 missed, 8 stalls, mean 30.9 ms | none (misses at no load) | ~23–31 ms | ≥ 12.7 ms hidden (copy 7.9) | ≥ 13.2 ms hidden (copy 11.9) | 7.3 ms | 0.7 ms |

"×" = how many times the pass could be drawn before the frame misses (1 + room / pass). Copies (cross-check,
medium): far 5.4–7.3 ms (agrees with its hidden share), near 2.0–7.3 ms (does not: per-draw work or the copy's own
target; not traced, D588); one more copy of either misses at no load; a near copy costs 1.7–2.4 ms of page-thread
CPU (high 4.4), a far one 0.6–1.0. Render scale at no load (medium): 0.75 held in 2 of 3 rounds (0 / 0 / 8 missed),
0.833 missed 6–32, 1.0 missed with stalls (mean 22–25 ms). Shadows: one light stops casting (the key light's map;
Play's voxel surfaces cast none).

**How stable.** The edge moved 7 → 7 → 16 ballast between rounds (0.7–2.5 ms of room), the ballast's slope past the
edge 0.105–0.14 ms (high 0.46 from 4-unit steps, residual 1.6 ms: not used), the frame's GPU ms from the line
agreed with the edge in 1 of 3 medium rounds (13.7 vs 14.2–14.4; the others 17.6 vs 15.8–15.9): past the edge the
interval bends with the load (the clock and Chrome's queue: frames at vsync, then a 50–100 ms block), so a pass's
raw fall moves by up to 60 % between rounds while its share of the four moves by ≤ 11 points. The same round's
base twice: 30.61 / 30.68 ms. **The method gives:** the room in ballast units, which passes fit and their ratios,
ms to about ±40 %; **it does not give** a pass's ms to better than that, nor any pass under ~0.3 ms.

**D583 (which pass).** At high with no load the orbit misses with stalls (mean 30.9 ms, 8 frames over 100 ms in
3 s: the 46d.13c-4 pattern). Hidden one at a time at no load: **far → 0 / 180 missed, no stall**; near → 3 / 171,
no stall; post → 8 / 140, 1 stall; shadows → 8 / 127, 7 stalls; render scale 0.667 → 11 / 163, 1 stall. The long
frames are how a GPU-bound WebGPU frame shows at this cap (Chrome draws at vsync until its queue is full, then
blocks; the mean interval is the GPU's time): the high frame needs ~23–31 ms of GPU, the far march at full
resolution its largest pass (≥ 13 ms), near next (≥ 12.7 hidden; 7.9 as a copy). Not the far field's jobs or
uploads (idle in 13c-4). The vista steps (46d.17, 46d.20) are its fix; D583 stays open with the cause.

*Unverified:* no picture taken (the loads draw off screen; the bypass's frames show the scene untone-mapped
for their windows, not looked at); the high tier's ms from one round; low not measured; the Iris Xe only.

### 46d.17 the far field's wasted work stopped (vista step 1, WebGPU)

**Findings re-checked** (against cf009500). F1: selection still screen error only (`near: null`), no frustum; the
frustum and occlusion now act at the draw (below), residency unchanged. F2: the cover test ran after the march:
still so for the cover, but a pyramid reject now runs before it (c). F3: D555's overdraw was already fixed by the
node march (46d.13c-1); fragment depth still disables early-Z. F4: 6 distance reads + standard material a hit
pixel: present (d, e tried, not kept). F5: job cost: 46d.18. F6: present (the 27 same-level cells read, copied and
sent, unused at scale 2): fixed. F7: three texture writes a brick (two regions + pages) and the JS palette bake on
the page thread: present, not changed (46d.18 bakes bricks at world-bake time). F8, F9: not this item.

**Built** (73adedac a–c, then f and the test fix). *a.* Far node boxes are rows of the existing culled-instance table
(`voxel-far-cull.ts` `FarNodeCopies`: 16 floats a node in one interleaved buffer, the brick program reads them with
`culledCopyVec4`), tested as world boxes in the late dispatch in the far draws' own depth mapping (`far-depth.ts`,
the mapping the far fragments write, shared with `voxel-far-common.ts`: the camera's own depth puts a box past the
far plane behind the sky) and against the frustum's sides (new in the shared rule, `rectMayShow`: a projection
wholly off screen is hidden, every culled copy); the far groups draw in the second pass only, after the pyramid of
the first pass (near field, pieces), indirect. Rows of fragment-bound draws are listed whatever their triangles
(`fragmentBound`). The pyramid path was **off** in Play (`occlusion_culling` auto = off): auto now takes it on
WebGPU while a far field draws (`wantPyramidPath`). *b.* Nodes wholly in the near cover's hidden chunks are left out
of the view's list (`FarCover.hides`), resident. *c.* Before the node march a pixel whose box entry lies behind the
pyramid's farthest depth over its 2 × 2 texels is discarded (`culledDepthAt`, the pyramid's level 0 bound per draw;
the culled-copies refresh rule also compares it). *d.* Octahedral normals baked a sample (RG8 third atlas store,
one filtered read for six): built, measured, **not kept** (patch in `work/46d.17/d-and-e-and-f6.patch`). *e.* Lambert
far shading (diffuse, the scene's lights, fog): built, pictured, **not kept**. *f.* F6: a brick job built from finer
cells reads, copies and sends only those (`far-field.ts` `reads`, `submit`).

**Tested.** `occlusion-instances-rule.test.ts` (+3): boxes off the screen's sides hidden (both depth kinds), a box 3 km
past a 100 m far plane lost to the sky in the camera's depth and shown in the far depth, hidden behind a wall in it;
the far depth's CPU form (own depth of the pushed distance to the split, then monotone, under the far plane's).
`voxel-far-view.test.ts` (+2): the culled table's row for a far group (box + far-depth flags, second pass only,
listed with 12 triangles a node, the pool holding the node floats and the world box, moved boxes follow, no culler
= no change and GLSL builds), the culled WGSL reads the list and the pyramid in its fragment stage; nodes the cover
hides left out and back. `occlusion.test.ts`: auto with a far field. *d*'s vitest (baked normal vs the gradient over
11,732 surface points: p50 1.25°, p90 4.33°, p99 12.2°) went with d. `stream.test.ts`: D589 fixed (the queue is topped
up before each update). Fast gates gate-fast-20261110-201002 / gate-rerun-20261110-202529 (red on D589 only, which
failed at 2ce43208 and cf009500 too) and gate-fast-20261110-211514 GREEN (18 min, 6.0 GB; D523 and D554 once, passed alone; village perf 0 missed both renderers; a first start red on the file size of `stream.test.ts`). `voxel-world.e2e.ts` not changed
(93.7 → ~99 s, its tests' sum: the Play checks now draw with the pyramid path on); its far checks already run Play WebGPU and one WebGL 2 smoke each.

**Measured** (staging, Iris Xe, Play 1280 × 720 at the 60 Hz cap, WebGPU, the 8 km world's town orbit,
`node tools/voxel-bench/run.mjs headroom`, one round each in turn 19:08–21:05, load 1.7–4.8, uptime 18.1 d;
`work/46d.17/headroom-*.json`, `sum.mjs`). Room = ballast held × its ms; far = hidden far's share of the four × frame GPU.

| medium | room at the cap | far share, ms | frame GPU (edge) | orbit missed (no load) | far GPU MB |
|---|---|---|---|---|---|
| base (19:08) | 1.6–1.8 ms | 41 %, 6.2 | 14.9–15.1 | 0 / 180 | 164.3 |
| base again (20:00) | 0.7–0.9 ms | 48 %, 7.6 | 15.8–15.9 | 0 / 180 | 164.3 |
| a (path off: layout only) | 0.4–0.5 ms | 47 %, 7.6 | 16.2–16.3 | 0 / 180 | 164.3 |
| a (path on) | 0.3–0.5 ms | 50 %, 8.2 | 16.2–16.3 | 0 / 181 | 164.3 |
| a + b + c | **4.5–4.7 ms** | 49 %, 5.9–6.0 | **11.9–12.2** | 2 / 177 | 164.3 |
| + d (not kept) | 3.8–4.2 ms | (line disagrees) | 12.4–12.9 | 0 / 180 | 229.4 |
| c + e + f (e not kept) | 3.4–3.7 ms | 55 %, 7.1–7.3 | 13.0–13.3 | 0 / 180 | 164.3 |

Read: a alone changes nothing measurable in the town orbit (the meter's edge moved 11 → 7 between two baseline runs,
D588): from the square the far slopes are seen over the roofs, so few boxes are hidden whole (the town poses test
~24 k copies, pieces included; at the far poses 35–36 % of the far nodes are culled: 388 / 1,107, 576 / 1,593,
417 / 1,278). b leaves 10–13 nodes out at the town (48 at high), 0 at the far poses: moot after 13c-4's order. c is
the gain: the frame's GPU time 15–16 → 12 ms, room ×3–6 (0.3–1.8 → 4.5 ms), far hidden 7.0–8.0 → 4.4 ms: most far
pixels at the town lie behind the near ground and the houses, and now stop before their march. d's six reads saved
nothing the meter sees (far 4.4 → 4.2 ms) for +65 MB (+40 %); e's far copy fell 4.0 → 2.5 ms but the pictures changed
(below). f is worker and page memory (the 27 copies a job), no GPU change. **High** (final code, one round, 7 GB
scope): 17 / 127 missed, 1 stall, mean 23.6 ms at no load (46d.16: 8 / 97, 8 stalls, mean 30.9): better, still
GPU-bound; far hidden or near hidden at no load each hold the cap (0 / 180), render scale 0.8: 2 / 178, 0.667: 0 / 180;
315 MB far, 4,392 nodes (D583).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/46d.17/`: Play, WebGPU, medium, the five 46d.12b far poses
before (cf009500) and after (final), `side-by-side/<pose>.png` before left, a 4× crop below; `side-by-side/orbit-strip.png`
8 frames ~0.25 s apart in the town orbit, before above, after below; `lambert-e/` e's pictures; every picture opened).
After = before: 0.00 % of pixels differ by > 60 at every pose, ≤ 0.06 % by > 20, ≤ 0.83 % by > 8 (the far slopes'
fine shading, frame timing). Colour, light and silhouettes the same; no hole, no box missing at the screen's edges
or behind the roofs, no seam at the near field's edge. Strip: steady, no node popping in or out while the camera
turns (at half size). e (Lambert): every far slope much darker and greener-grey, rock faces near black on the shade
side: the standard material's environment term (the sky's blue-grey light) is gone; 30–52 % of pixels differ by
> 60, so not kept. Seen in before and after alike: at the poses 1.6–1.7 km up (peak-to-town, beyond-peak-to-town)
the sky covers only a slanted quad, black outside it (D590). *Unverified:* WebGL 2 pictures (unchanged code path;
the e2e's smoke covers it), motion at full size, popping in a flight, the high tier's pictures.

### 46d.21 the low tier as the Iris Xe target; D590

**D590 traced and fixed** (52caccdc). The physical sky is three's `SkyMesh` box scaled to 4.5 km and the gradient
dome a 4 km sphere, both at the world's origin; the peak poses stand 1.6 km up and 4.6 km out, outside the box, so
one face showed as a slanted quad over the black clear. Every sky mesh (the physical sky, the gradient dome, the
cross-fade layers) is now centred on the camera that draws it (`followCamera` in `environment-nodes.ts`, an
`onBeforeRender` that moves the mesh before three reads its matrices); both shade by view direction and draw on the
far plane, so nothing inside changes and the sky has a camera's motion only (rotation) for TAAU. vitest
(`environment.test.ts`): a camera at 4 far poses up to 6 km up / 12.7 km out lies inside both meshes when they draw.
Seen: `far-field/46d.21/peak-to-town-after.png` sky over the whole frame (before: the quad, `-before.png`). The fix
changed one e2e assumption: `voxel-world.e2e.ts`'s far-ground check read black as "the background" because the
world 8 km out stood outside the sky box (D590 itself); it now reads the sky or black (`background()`).

**Low built** (c6d0925e). The engine's low level (`DEFAULT_QUALITY_LEVELS`, project-model): `renderScale`
`UPSCALED_RENDER_SCALE` (0.667, renamed from `MEDIUM_RENDER_SCALE`: low and medium share it) with dynamic resolution,
anti-aliasing `taau` where the look anti-aliases (the same post-taau.ts / post-upscale.ts path medium takes; on
WebGL 2 and in the Scene view the look's FXAA/SMAA in its place, as for medium), MSAA where no post stack
anti-aliases (the renderer's 4: an upscale wants an anti-aliased input; it had `msaa: 0`), bloom/AO/DOF off as before,
`shadowMapSize` 2048 (no effect on the 8 km world: its sun's map is 1024), and a new level field **`frameRateCap`**
(30; validated against `FRAME_RATE_CAPS`, descriptor, canonical form). What low already cut stays: lighting tier
low (saved light, atlas 2048, no SSR/contact shadows), voxel texels 256 px/m, stream 256 MiB, rings × 0.71, far
error 8 px, far GPU 96 MiB. The cap reuses 28c's `FramePacer`: it takes the level's cap beside the game's
(`setLevelCap`), paces by the lower one, a page pin (`?frameRateCap=`) still wins; the host tells it each drawn
frame (`setFrameRateCap(fps, 'level')` on the runtime / remote simulation, read from the adapter's
`qualityFrameRateCap`); `frameTargetMs` and `ctx.stats.frameRateCap` follow the paced cap, so dynamic resolution
budgets 33 ms at low. **WebGL 2 low** draws the same level (render scale + FSR 1, MSAA; no TAAU there, which is
WebGPU-only): no new WebGL 2 code, the medium path it already had. **Memory ceiling** `LOW_MEMORY_CEILING_MIB`
(project-model, low only): page heap 1024 MiB, GPU 1280 MiB (the GPU process's DRM resident count), reported by
the headroom bench against its town reading (not enforced). **Meter** (`headroom.ts`, `headroom-cli.ts`):
`frameCap(fps)` gives the budget, the miss interval (budget + half a refresh: 25 ms at 60, 41.7 ms at 30) and the
deep load (1.8 budgets); `--cap` defaults to the level's `frameRateCap`; frames are timed as the page presents them
(`GpuLoad.record`, `__tlVoxelPlay.meter.record`), since at a 30 cap every other animation frame draws nothing; town
memory read after the fill; an orbit behaviour record that exists is reused.

**Tested.** vitest: `quality-levels.test.ts` (low's fields, the cap 30 only on low, low cheaper than medium in every
shared voxel budget, its GPU budgets under the ceiling, `frameRateCap` validated and kept canonical);
`frame-pacing.test.ts` (a level cap paces with the game's: the lower holds, a pin wins, the budget follows, 30 at
60 Hz draws every other refresh); `headroom.test.ts` (30 Hz windows: two vsyncs hold, three miss, saturation, the
edge's GPU ms); `environment.test.ts` (D590); `environment-nodes.test.ts` and `descriptors.test.ts` moved to the new
low (TAAU / SMAA in its place, a level with `msaa: 0` for the plain-pass case); `rendering.e2e.ts` now checks "a level
without MSAA" with a project level (the engine's low keeps MSAA by design). Fast gate gate-fast-20261110-222020
red on those tests (fixed) and D523/D554 once (passed alone); reruns gate-rerun-20261110-223451 (e2e: the
rendering test, D590's e2e assumption); a rerun's full e2e set was OOM-killed in its 7 GB scope (the rerun list was lost: my mistake), it showed env-parity `quality-low` (the old low's picture; the case now names that level itself, the engine's low upscales and a still harness cannot compare it) and two unrelated files fail under that load; fresh fast gate gate-fast-20261110-231443 with voxel-world, env-parity, cameras, resource-manager GREEN (15 min, 5.5 GB; 879 vitest files, 66 e2e; village perf 0 missed both renderers). `voxel-world.e2e.ts` ~99 → 89.3 s (its tests' sum; nothing added).

**Measured** (staging, Iris Xe, Play in the editor, WebGPU, 1280 × 720, the realistic 8 km world, town orbit; uptime
18.2 d, load 4.8 before / 6.7 after (1-min); `work/46d.21/headroom-low-{before,after}.json`, `low-perf-*.json`).

| low | cap | room at the cap | frame GPU | near / far / shadows / post (hidden, ms) | orbit missed | flight 2.4 km | page heap town → after flight | GPU MiB town → after flight |
|---|---|---|---|---|---|---|---|---|
| before (full res, no AA) | 60 | 30 ballast × 0.119 = 3.6 ms | 12.9–13.1 (edge) | 1.6 / 7.4 / 2.2 / (−4.6) | 0–1 / 480 ×3 | 3 / 2394 | 672 → 752–831 | 1000 → 1089 |
| after (0.667 + MSAA + FSR 1) | 30 | 120–176 × 0.128–0.132 = 15.4–23.2 ms | 8.0–12.1 (line; 1 of 2 rounds agree) | 1.7–2.2 / 6.6–6.8 / 0.8–3.1 / 3.1–6.1 | 0–3 / 239 ×3 | 12 / 1197 (1 over 100 ms) | 607–614 → 802–834 | 880–883 → 1053–1105 |

Shares of the four (after): far 38–52 %, post (FSR 1 + MSAA resolve + output) 24–35 %, near 10–17 %, shadows 6–17 %;
at no load each pass hidden holds the cap, render scale 0.833 and 1.0 hold it too (0–2 / 89). Memory includes the
editor's page (Play runs inside it); under the ceiling at the town and after the flight. **Medium / high** are
unchanged by this item: their shares and scaling are 46d.17's (medium far 49 %, frame ~12 ms at the busy clock;
high GPU-bound, D583), frame times **unverified on target hardware**, and (D591) medium on this world is FSR 1 +
MSAA 4, not TAAU.

**Looked at** (`far-field/46d.21/`: `<pose>-{before,after,taau}.png`; `side-by-side/<pose>.png` before | after |
after under an anti-aliased look (TAAU), a 2× crop below; `side-by-side/orbit-strip.png` rows before / after / taau;
`strip-crops-<tag>.png` full-size crops of the 8 orbit frames ~0.25 s apart; every picture opened). After vs
before: the same scene, colours and far field; peak-to-town now all sky above the ridge (17.8 % of pixels by > 60,
the quad gone); town-west / town-peak-4.5km / near-ground 0.2–1.4 % by > 60. Edges: before hard and stair-stepped;
after smoother but FSR 1's sharpening puts light rims on roof edges and makes the far green slopes' fine contour
bands stand out more (D592). TAAU: softest of the three, roof tiles and far slopes blurred, the bands faint; the
look's post also tones it a little darker. **Ghosting:** none seen in the TAAU orbit strip (roof edges against the
far slopes and the ridge against the sky single in every frame); the orbit turns slowly (0.15 rad/s) and mostly
rotates, where a far box's motion equals its hit's, so the hit's motion was not written. *Unverified:* ghosting in a
fast or translating shot (the flight under TAAU not pictured), WebGL 2 low pictures (the e2e's smoke draws it),
medium/high on target hardware, the meter's ms (±40 %, D588).

### 46d.18 bricks baked into the far cache (vista step 2); step 0: TAAU on low; D591, D592

**Step 0** (f50e6ab2). The 8 km world's look has no post stack, and `levelPost` lays a level's anti-aliasing only
over a look's own, so low and medium (the same cause, D591) drew MSAA + FSR 1 there. A level below the full
resolution that names TAAU now upscales by it on WebGPU in a view drawn frame after frame whatever the look's
anti-aliasing (`drawnAntialias`, environment.ts), with no MSAA under it and no contact shadows or reflections the
look does not draw; WebGL 2 and the Scene view keep FSR 1. vitest `environment-nodes.test.ts`. Seen (Play, WebGPU,
low, town-west): `far-field/46d.18/side-by-side/step0-town-west-fsr1-vs-taau.png`, FSR 1 left, TAAU right, a 2× crop
below: the far slopes' hard horizontal contour bands and the light rims on the roof edges are gone, bands faint; the
same frame as 46d.21's look-AA TAAU shot within 0.33 % of pixels (> 60). The back-row melted roofs (D593) stay.

**Size first** (`work/46d.18/size.mts`: the shipped builder on 1,960 real nodes of the 8 km world's cache, every
level, town nodes always in, zstd level 3 as the cache): per node L2 1.8 KiB (9.3 bricks), L3 3.6, L4 4.5, L5–L8
6.0–6.9 KiB; samples and occlusion are ~90 % of the packed bytes. Projected: 1.20 M bricks, 3.5 GB raw, **270 MB
zstd**, 2,424 s of one thread (~10 min on 4). Under the ~1 GB stop line, so built. Measured after the bake: 300.9 MB
(the L2 sample ran low), so the cache is 355 MB (nodes 54.1 + bricks 300.9), 5.6 MB/km².

**Built** (ead1c53a and the route fix): the far cache **format 2** (add-only, owner note on the [render
spec](architecture/voxel-render-spec.md) §4 *Baked bricks*, format spec §3.8): every kept node's bricks built at
cache build by the far field's own builder from the cells its job would send (`farBrickJobCells`, shared),
encoded (`encodeFarBricks`, `TLFB` v1) and zstd-packed as entries of `B<level>/` region files; the backend bakes on up
to 4 threads of its far worker, the bench pool in its workers; served at `…/far/B<level>/…` (also under Play's
locator: its route took only `L<level>`, so the first Play run drew nothing, fixed), shipped in exports; Play,
exports, the Scene view and the page read a node's entry at level 64 + L and the far job only unpacks and decodes it.
A format-1 cache still reads (a page builds its bricks); the backend builds it again. Edits: the brick nodes whose
read box meets a changed ancestor (`farBrickDirty`, node-granular: the mip's opening rule reads a whole parent node)
are built again in the backend's rebuild, looked up first by content key in the cache's `rebuilt/` store; only their
bricks files are written; the old bricks draw until the new ones land. Not built: run-time game edits/saves reaching
the far field (D594); the compute brick build (D595, not tried: with every node baked only edits build, and those run
on the backend's worker).

**Tested.** `far-world.test.ts` (real 512 m world, real workers): the bricks the far field draws from the baked cache
equal, node for node and byte for byte, those it builds in its workers from the same cache as format 1 (levels 2–4,
two eyes); a format-1 copy reads with no bricks, is stale to the backend ("format 1") and draws; an edit (a dig
through `VoxelWorlds`) rebuilds exactly `farBrickDirty`'s held nodes, every other node's baked bytes unchanged, and
the cache then equals a full build of the edited world (seams included); undo, then the same dig again: 0 built, all
reused from the rebuilt store by content (a store opened afresh). `far-bricks-baked.test.ts` (codec, job cells,
dirty set); `far-cache-runner.test.ts`: the backend worker's threaded bake equals the in-thread bake.
`voxel-world.e2e.ts`: the export ships `B<level>/` files and the export's far field reads them with the backend
stopped (two assertions in the existing test, no new test). Fast gate gate-fast-20261111-004545 red on
`voxel-world.test.ts` (the export's far file list, now with `B<level>/`: fixed) and D418 (timed out under load);
rerun gate-rerun-20261111-005857 red on two `rendering.e2e.ts` checks step 0 broke (a level's TAAU dropped the
colour sky laid under the picture: fixed in the product; the culling on/off comparison under a render scale now pins
`taau=0`, since a jittered temporal upscale gives no two equal frames); gate-rerun-20261111-010426 GREEN (village
perf 0 missed both renderers). `voxel-world.e2e.ts` ~89.3 → 102.2 s (its tests' sum, under the gate's parallel load;
nothing added but two assertions).

**Measured** (staging, Iris Xe, Play in the editor, WebGPU, 1280 × 720, the realistic 8 km world, town orbit 3 × 8 s
then the 2.4 km flight; before = this code on a format-1 cache (the page builds), after = the baked cache; one round
each, 23:58–00:50, load 1.7–4.1, uptime 18.3 d; `work/46d.18/perf-*.json`, `low-perf-after-*.json`, `uptime-*.txt`).
Fill = from the canvas to the far field settled.

| | fill | far job p50 / p95 | nodes, bricks | orbit missed | flight missed (max ms) | flight swaps in / out, pending at end | page heap town → flight → settled | far GPU MiB |
|---|---|---|---|---|---|---|---|---|
| low 30 Hz, before | 31.1 s | 74 / 127 ms | 1,052, 17,980 | 1 / 1 / 1 of 239 | 9 / 1,198 (117) | 1,506 / 363, 1,518 | 681 → 789 → 909 | 69 → 103 |
| low 30 Hz, baked | **8.5 s** | **0.3 / 1.2 ms** | 1,050, 17,952 | 1 / 2 / 1 | 3 / 1,199 (60) | 3,528 / 2,942, **0** | 586 → 1,007 → 1,001 | 69 → 84 |
| medium 60 Hz, before | 78.9 s | 78 / 140 ms | 2,934, 43,698 | 11 / 12 / 5 of 478 | 10 / 2,382 (198) | 3,014 / 1,213, 4,906 | 939 → 1,072 → 1,007 | 157 → 195 |
| medium 60 Hz, baked | **16.3 s** | **0.3 / 0.7 ms** | 2,927, 43,597 | 8 / 5 / 2 | 10 / 2,388 (181) | 6,259 / 4,218, 1,990 | 784 → 937 → 975 | 157 → 195 |

Read: the job is decode only (~250× cheaper); low fills under the 10 s target, medium does not (D596): 133 of its 141
commits were cut at `FAR_COMMIT_BYTES` (1 MiB of events, the rest 50 ms later; ~127 MB of brick events) and its
116 reads ran one batch at a time (p50 36 ms); the pacing is the page thread's upload guard, not tuned here. In the
flight the far field now keeps up (low ends with nothing pending, medium 4,906 → 1,990), so it swaps 2–8× more nodes;
low's page heap after the flight rose 789 → 1,007 MiB, at its 1,024 MiB ceiling (D597). GPU process memory not read
(the DRM counter was empty in these runs); far GPU within the tier budgets. Bake: staging's backend rebuilt the
format-1 cache in 1,421 s (nodes ~690 s on its one build thread, as before; bricks ~730 s on 4 threads), peak 4.74 GB
of its 6 GB scope; the bench's 4 workers would bake it in about the same. Export: the far cache ships 355 MB for this
world (was 54.1); the e2e's 128 m slice ships its bricks beside its nodes.

**Looked at** (`far-field/46d.18/`: `<pose>-rt.png` runtime-built, `<pose>-baked.png`, `side-by-side/<pose>-runtime-vs-baked.png`
runtime left, a 2× crop below; Play, WebGPU, low; every picture opened). peak-to-town: the same picture (0.00 % of
pixels by > 60, 0.33 % by > 8): massif, slopes, channels, the red town patch alike. town-west: the same but the back
row of houses at the near field's edge (0.73 % by > 60): the two runs selected 1,052 and 1,050 nodes (the GPU ledger
selects again as made nodes' bytes arrive, so the set at the near field's edge depends on arrival order), and those
houses are drawn by the far field there (D593); the bricks themselves are byte-identical (vitest). town-peak-4.5km and
near-ground: the same scene (the clouds moved). *Unverified:* medium and the flight's pictures, WebGL 2 (unchanged
path; the e2e smoke), an edit in the Scene view in a browser (vitest only), motion.

### 46d.22 coverage at 150 m/s; D593

**D593 traced** (`work/46d.22/trace.mjs`, Play, WebGPU, low, town-west; `far-field/46d.22/d593-*`). Shots with the far
field hidden and with the near field hidden: the melted back-row houses vanish with the far field hidden and are all
there, melted, with the near field hidden, so the **far bricks** draw them. The near field drew levels 0/1 only
(110 / 49 nodes; level 1 is complete only ~30 m inside the load ring), ending at ~95 m: low's ring scale 0.71 put the
load ring at 136 m and level 1 at 91 m. Past it the far field's finest level (2 m cells) is 9–13 px a cell at 92–140 m
(`farCellPixels`, 623.5 px/rad), over low's 8 px error; a house of 4 × 3 cells marched from a trilinear field is a
rounded blob whatever the build. Level 1 alone to 136 m changed nothing (49 → 51 nodes: completeness, not the ring).
**Fix** (75f78691): `VOXEL_REACH_SCALES` (stream-ring.ts): a tier's load ring and level-1 distance scale by its ring
scale but never under 1; level 0, collision and relief keep the ring scale. Low now loads 192 m and draws level 1 to
128 m (125 level-1 nodes, near triangles 308 k → 446 k at the pose, resident 62 → 90 MB of the 256 MiB budget). Seen:
`side-by-side/d593-town-west-before-after.png` (before left): the back row crisp with gables and walls, 2.5 % of pixels
by > 60. vitest `voxel-world.test.ts` (low's reach, level 1 = medium's).

**The bench** (28c1aa66; `node tools/voxel-bench/run.mjs coverage`, `coverage-cli.ts`, `coverage.ts`): Play in the editor
on staging's 8 km world, WebGPU, 1280 × 720, low at its 30 Hz cap; a 9.84 km line (east lowland → town → up the
massif's cliffs, 0–1,065 m → west valleys → eastern mountains) 30 m over the highest ground near it (`high`) or 5 m
(`hug`), 0.08 rad down. The sky is a key colour for the run. **Every presented frame** (screencast 320 × 180, 1,962–4,919
frames a run of 1,995–4,950 presented) is checked: a key pixel whose ray falls to the world's lowest ground inside its
bounds is a hole (the world is a height field, so that ray meets ground; rays leaving the world first may see sky —
a first version with a fixed margin under the horizon called the world's edge a hole). Per streamer update the
simulation counts the ground under the focus and under its lead point (`stream-coverage.ts`: every chunk down to the
first solid resident and derived — what collision is made from — within the ring's height; deeper is "out of reach").
The camera inside a drawn far node's solid is sampled at 4 Hz (`VoxelFarView.solidAt`, `farBricksInside`).

**Measured** (staging, Iris Xe, one round each, before 01:45–02:05, after 02:55–03:15, uptime 18.4 d;
`work/46d.22/cov-low-*.json`, `uptime-*.txt`). Ground % = flight updates with the ground missing (before: out of
reach counted as missing; after: out of reach 21–25 % `high`, 0–1 % `hug`).

| low | hole frames (events) | ground missing under / ahead | missed frames | live heap start → end (MiB) | GPU MiB | far swaps in / out, pending end |
|---|---|---|---|---|---|---|
| 150 high before → after | 1 (1) → 0 | 97 / 98 % → 15 / 47 % | 4 → 9 of 1,997 | 385 → 532 / 407 → 606 | 664 → 938 / 676 → 893 | 6,359 / 6,518, 1,719 → 10,771 / 14,019, 0 |
| 150 hug | 4 (1) → 0 | 97 / 97 % → 16 / 68 % | 6 → 17 | 450 → 576 / 395 → 766 | 711 → 959 / 668 → 1,037 | 6,738 / 7,309, 1,506 → 10,986 / 14,770, 0 |
| 60 high | 0 → 1 (1) | 58 / 74 % → 1.2 / 8.4 % | 21 → 23 of 4,948 | 369 → 951 / 407 → 967 | 710 → 1,033 / 656 → 1,045 | — , 0 → 0 |
| 60 hug | 0 → 0 | 95 / 96 % → 0.0 / 2.8 % | 7 → 48 | 439 → 609 / 396 → 1,119 | 711 → 907 / 698 → 1,075 | 527 → 0 pending |

Holes per km: 0–0.4 → 0–0.1. The one-frame events (m ≈ 4.44 km) are at the line's 90° corner on the massif, where
the bench's camera for a frame comes from polls 0.25 s apart and turns instantly: likely the check, not the draw.
Camera inside a far node's solid: 0 of 184–538 samples in every run (but see the pictures). Before the change the far
field alone kept the screen covered: the far coverage candidates (top levels kept resident) were not needed and not
built. **Built** (28c1aa66): the load ring narrows with speed past 20 m/s (`speedRing`, `STREAM_FULL_RING_SPEED`: radius
× 20 m/s ÷ speed in whole chunks, never under the collision radius 48 m; at 60 m/s 64 m, at 150 m/s 48 m; the motion
keeps the base ring so the speed is not reset); the lead point reaches a second of travel up to the set ring (was
capped at 96 m); loads, decodes and derives are queued by `motionDistance2` (distance from the way between the focus
and the lead point, a quarter of the distance along it, behind × 4) and derives are asked in that order. vitest
`stream-speed.test.ts` (real workers, region files, a 512 m hilly world, 150 m/s: the ring at the floor in flight, the
base again when still, the ground under the focus known within a second of stopping; ordering and ring arithmetic).
Not built: near levels 1–2 before level 0 at speed (with the ring at 48 m the near field is the collision ring; the
far field draws the rest), collision bodies built along the velocity (the bench has no physics port: it checks the
derived ground they are made of).

**Memory:** GPU stays under low's 1,280 MiB (≤ 1,075). The live page heap (after a GC) ends the 60 m/s hugging flight at
1,119 MiB, over the 1,024 MiB ceiling (before 609: the near field then drew nothing in flight); 150 m/s ends 606–766.
D597 updated. **Gate:** gate-fast-20261111-011830 red on the descriptor size guard (fixed) and D523 once; rerun
gate-rerun-20261111-013124 GREEN; gate-fast-20261111-022637 GREEN (16 min, 4.9 GB, 881 vitest files; village perf 0
missed both renderers). `stream.test.ts`'s lod flight failed once in a local 3-worker run with other files, passed alone
twice and in the gate (a timing test, D589's family). `voxel-world.e2e.ts` not touched (its tests' sum 152 s under this
gate's load; 102 s at 46d.18).

**Looked at** (`far-field/46d.22/low-150-{hug,high}-after-t*.png`, six hugging and four at 30 m, every one opened).
At 30 m (t12, 24, 36, 48): the lowland, the town as a red coarse patch from 1 km, the massif's rock and the valleys
whole, no hole, slopes in coarse stand-ins with terrace lines, smooth enough at speed. Hugging: t6, t18, t42, t54 and
t62 show along the bottom or sides of the frame the **grey grid with square recesses** (a coarse far node's faces seen
from under its surface, D585) next to near-field ground; t18 also has black wedges where near chunks end; t30 is the
massif's cliff face close up, dark and blocky. No sky hole in any. *Unverified:* motion at full rate (stills only),
WebGL 2, medium/high, collision bodies in a game with physics, the eye-point sampler's blind spot for D585.

### 46d.19 near surface shader and submission (vista step 3, WebGPU); D600

**D600 first** (84c60578, 1bcfd6be). Two causes, neither the TAAU jitter's existence. (1) TAAU's hold (a still view
stops jittering after 120 frames) compared the camera's matrices bit for bit; Play rebuilds its pose every step and
the last bits alternate (±2.8e-17, probed in the page), so the hold never started and a still Play picture never
settled: `samePose` (post-taau.ts) allows 1e-7 an element, measured from the pose the stillness began at. (2) With
the hold's 120 frames, batch-dispose's second Play ran long enough for the backend's late `play.stopped` of the
first play (stopped, its page gone: "unconfirmed") to reach the new page, and the editor ended whatever play ran:
`PlayLink.receiveStopped` now ignores a stop of another play. Two tests read what a temporal upscale legitimately
changes and pin `taau=0` with the reason written: layered-material (lit rooms read at a few pixels of distant
rooms: lit / across / off 499 / 288 / 250 under TAAU against 560 / 313 / 297, the brightness-weighted resolve
settles darker where jittered samples differ; the culling on/off comparison wants equal frames) and sim-worker's
export (a walk read as pixels changed against a standing view, which TAAU keeps resolving for its first seconds).
vitest `post-taau.test.ts`, `play-link.test.ts`; the three files alone pass; fast gate gate-fast-20261111-050647
green but its perf step (the lead's cap change, fixed by the lead) and gate-rerun-20261111-052547 GREEN (village
perf 0 / 360 missed). The lead's perf-cap commit failed the history check (a date in a comment): fixed (85209218).

**N1–N6 re-checked** (against 1bcfd6be). N1 present: 3 maps × 3 projections × 2 materials = 18 array samples a
pixel whatever the draw, 10 grid texel loads, the table, a crack sample. N2 present: no depth prepass; and the
near surfaces were **not occludees at all** (Play: 1 occludee): the registry follows the scene's children only,
the chunks sit below the view's root, and the relief position node had no declared vertex reach. N3 present
(`placedGeometry`'s `DataView` loop). N4 present (one draw a chunk, a seam, per-object uniform callbacks). N5
present (every mip node derives collision, nav, light, occupancy; hash = CRC of the full encode). N6 not
re-measured.

**Built** (a3639669). *b.* A program per **draw path** (`VoxelSurface.materialFor`, `voxel-surface-path.ts`
`voxelDrawPath`), chosen when a draw's shader data arrives, never per pixel: one solid material in the draw's
grid (border cells included) reads one texture set; construction alone at level 0, and every draw from level 1
out (64 m and past), reads **one projection** a map (`SetProjectionMode` `axis`: the grid's UV on construction,
the same pixels; on terrain the normal's largest axis, sampled with that axis's gradients so the mip does not
jump at the axis's seams). Seams take two materials and their level's projection. Four programs: 18 / 9 / 6 / 3
array samples. WebGPU only (WebGL 2 keeps its one program); `?voxelPaths=full` draws the full program everywhere
(passed on to Play). Anisotropy at levels 1–2 not changed: a sampler is per texture, so it needs second array
textures (memory) — not done. *a.* Chunk, node and seam surfaces are **rows of the culled table**: the view's root
is an occludee group (`markOccludeeGroup`; the registry follows its visible marked meshes), the surface programs
declare vertex reach 0 (a relief geometry's bounds already hold its relief), so each is tested whole (frustum +
pyramid in compute, indirect draw; `occlusion-whole.ts`). **One indirect draw a level is not built**: WebGPU has no
multi-draw indirect (vista §3), so a shared-buffer level draw could not leave chunks out without an index
compaction pass; recorded (D602). Diagnostics count surface draws by program (`voxelWorld.paths`).

**Not built, measured:** *c* the depth prepass: the meter cannot tell near's share at low from noise (below), so
nothing says overdraw costs; not built. *d* packed vertices read directly: the page-thread unpack is 41–87 µs a
draw (p50, 1,089–1,161 vertices; the whole town's 834 chunks 63 ms once), level-0 meshes are the clipped decals'
surfaces and the picking meshes (float positions on the CPU) and the caster and relief programs read `position`:
not worth the vertex-stage decode now; dropped. *e* mip nodes without collision/nav/light/occupancy and a cheap
hash: `work/46d.19/n5.mts` (the shipped derive on the town and hilly worlds): consumers 1.08–1.18 ms a node p50,
**11–24 % of a level-1/2 node's worker time**, the hash (encode + CRC) 72–153 µs, ≤ 2.5 %. The hash is not worth
changing; dropping the consumers for mips changes the derived payload of mip nodes (a format note) and every
consumer must be shown level-0-only first: not built, D601.

**Tested.** vitest: `voxel-surface-path.test.ts` (one / two materials with air, wetness and the construction bit;
the projection by construction-only, level, solid entry; the page flag); `voxel-surface.test.ts` (each path's
program builds on WGSL: 18 − 9 / 12 / 15 fewer array samples, `textureSampleGrad` for one projection, every sample
in uniform control flow; every path's draw is an occludee culled whole, reach 0); `occlusion.test.ts` (a marked
group's nested marked draws followed while shown, a hidden level dropped). The meter and pictures are the browser
proof (staging, Play). Gates: gate-fast-20261111-063302 red on `voxel-relief.test.ts` (it read the shared program,
the relief mesh now draws its path's: fixed), rerun red once on D410 (`project-items.e2e.ts:186`, passed on rerun),
gate-rerun-20261111-064624 GREEN (village perf 0 / 360); `area voxel rendering` gate-area-20261111-064830 GREEN
(4 min, 38 tests, 6.0 GB; voxel area 184 s, its tests' sum). No e2e file changed for the item.

**Measured** (staging, Iris Xe, Play in the editor, WebGPU 1280 × 720, the realistic 8 km world's town orbit,
`run.mjs headroom`, one round a tier a step, 05:27–06:29, load 1.0–5.2, uptime 18.6 d; `work/46d.19/headroom-*`).
Room = ballast held × its ms; frame GPU from the line past the edge; hidden = the interval the pass saves past the edge.

| step | low 30 Hz room | low frame GPU | low near hidden | medium 60 Hz room | medium frame GPU | medium near hidden | missed (no load) |
|---|---|---|---|---|---|---|---|
| before | 176 × 0.122 = 21.5 ms | 10.0 | 1.53 ms | 60 × 0.127 = 7.6 ms | 8.7 | 0.66 ms | 0 / 89, 0 / 179 |
| b (paths) | 192 × 0.126 = 24.2 ms | 7.5 | 1.98 | 60 × 0.127 = 7.6 | 8.4 | 1.50 | 0 / 89, 1 / 179 |
| b again (reach only, no row yet) | 192 × 0.121 = 23.2 | 10.5 | −2.38 | 60 × 0.125 = 7.5 | 9.0 | 1.06 | 0 / 89, 2 / 179 |
| a + b (rows) | 192 × 0.122 = 23.4 | 10.3 | 2.54 | 52 × 0.127 = 6.6 | 8.5 (edge 9.6–10.1) | 1.67 | 0 / 89, 2 / 179 |
| f: + surfaces as static casters | 176 × 0.126 = 22.2 | 8.2 | 3.09 (shadows 1.55) | 44 × 0.131 = 5.8 | 8.6 | 1.85 (shadows 0.53) | 0 / 89, 2 / 179 |

Which paths draw (the page's `__tlVoxelPlay.stats()`, low, three town poses): 109 surfaces on the full program
(level 0: every chunk holds ground and two or more materials, construction with it) and 141–146 on two materials, one
projection (levels 1–2 and seams); none on one material (no chunk of this world's near field holds a single one). Read: at the cap the low room moved 21.5 → 23.2–24.2 ms with b (one ballast step, 16 units ≈ 2 ms: the meter's
resolution), medium's not at all; the "b again" row is the same code measured twice and shows what a hidden pass's
ms is worth at low (1.98 vs −2.38 ms): **near's share at low cannot be resolved by the meter** (D588), so b and a
are reported as room only. a's rows: at the town 176 surfaces are occludees, 32 pass the runtime's class test and
are tested whole, 1 culled: nothing to gain at an orbit over open roofs; medium's room −1 ms is within one ballast
step. Kept both (b: never worse in a picture, fewer samples by construction; a: the step the vista asked for,
neutral here, it pays where streets and slopes hide chunks — not measured). Page heap (low, Play in the editor):
town 589–665 MiB, after the 2.4 km flight 850–869, settled 796–891 (a2, f): under 46d.21's 1,024 and the 46d.23
starting split (page ≤ 1.5 GiB); GPU (DRM resident) 870–958 town, 1,097–1,120 after the flight. The 60 m/s hugging
flight of D597 not run again. Worker ms: above (e).

**f — near chunks as static casters** (`?voxelShadows=static`, measurement only; the owner's proposal is not
decided). Play draws voxel surfaces with no shadow at all: with them on, the key light's maps run (a2: 0 static /
0 dynamic draws; f: the static map 3 draws by the fill, the dynamic map every frame). Cost by the meter: low room
23.4 → 22.2 ms, shadows hidden 1.55 ms (2 ballast steps; 15–20 % of low's measured passes); medium room 6.6 → 5.8
ms, shadows 0.53 ms. The 2.4 km flight at low held 30 Hz either way (mean 33.5 ms, 1 → 2 frames over 100 ms).
Reach and invalidation (from `cached-shadow.ts`, not traced frame by frame): the static map is redrawn on any
static caster change in its reach and at each step of half the shadow square, so streaming chunks in and out
redraws it about as often as the near field changes in a flight (it then costs as an uncached map), and an edit
redraws it once; its square (the sun's map of this world: 1024 texels) covers the near field, not the far field.
Seen: the 8 km world's sun (intensity 1.2, nearly overhead) makes the cast shadows faint: 0.00 % of pixels differ
by > 20 at the town poses, 2.97 % at near-ground (a wall's foot darker); so the pictures say little about the look.

**Looked at** (`far-field/46d.19/`: `<pose>-{before,b,a2,f}.png`, `side-by-side/<pose>-<A>-vs-<B>.png` A left, a 2×
crop below; Play, WebGPU, low; town-west, town-peak-4.5km (the square), near-ground, peak-to-town; every one
opened). before → a2: the same pictures: ≤ 0.01 % of pixels by > 60 at town-west, near-ground and peak-to-town,
0.26 % at the square (roof edges at the far field's edge and the clouds: the run-to-run noise, before → b 0.24 %);
materials, blends, triplanar ground, wetness and the far slopes the same; no seam where level 0 meets level 1 at
the square's distance. *Unverified:* a pose where whole culling hides chunks (streets, behind a ridge), motion,
medium/high pictures, WebGL 2 (unchanged path; the voxel area's smoke), the meter's ms (±40 %, D588).

### 46d.23 low's memory: the 4 GB budget, the raised budgets; D597

**D597 traced and fixed** (dd09676d). The coverage bench gained `--return S` (the camera put back at the line's
start, memory read again S seconds on), `--heap-profile` (live allocation sites from the start reading on) and
`--heap-snapshot` (a whole snapshot; `work/46d.23/snap.mjs` groups array buffers' backing stores by retainer path),
and reads the renderer and GPU processes' RSS. The sampled JS objects grew only 131 MiB of the 737; the rest were
array buffers. A snapshot after 3 km of the 60 m/s hugging flight (975 MiB live): 138 MiB of geometry arrays held
by **three's render objects** of meshes already removed. A removed chunk, seam, far group or piece draw disposed its
geometry only; three's `RenderObject` listens on the object, the material and the lights, and disposes on the
object's or material's `dispose`, not the geometry's, and the shared surface material and the lights node kept the
listener — so every voxel mesh ever drawn stayed, with its arrays, for the renderer's lifetime. Each removal now
also runs `disposeObjectTree` (dispose.ts, as the scene's entities already did). vitest
(`voxel-chunk-view.test.ts`): three's own `RenderObjects` on a backend that draws nothing, a 2-chunk window slid 12
moves: only the drawn meshes keep render objects (12 → 1 without the fix), none after `dispose`. **Legitimate
working set** at 3 km after the fix (673 MiB): textures' CPU mip copies 308 MiB (kit textures twice: D604), far
brick copies 181 MiB (Play's ~20 k drawn bricks ~58 MiB and the editor's Scene view behind Play; D604), live
geometry 39 MiB, script source 56 MiB. Events, the far entry cache, worker transfers and chunk payloads were not
among the holders (they live in the workers; D606 for what the workers hold).

**Budgets** (85428e3f). `LOW_MEMORY_BUDGET_MIB` (project-model, replaces `LOW_MEMORY_CEILING_MIB`): total 4096,
page heap 1536, GPU 2560. Low: stream 256 → 768 MiB, far GPU 96 → 384 MiB, texels 256 → 512 px/m; medium stream
512 → 768, far 176 → 384; high far 288 → 384 (stream 1024 and texels 1024 kept); medium/high **unverified on target
hardware**. `VOXEL_RING_SCALES` are no longer the square roots of the budgets (same values, 0.71 / 1 / 1.41): with
medium's budget moved they would have shrunk high's rings, and the rings cost GPU and worker time, the budget only
memory. vitest: `quality-levels.test.ts` (low's budgets inside the GPU share, medium/high ≥ low in every voxel
budget, far error ≤ low's), `voxel-world.test.ts`, `voxel-texture-residency.test.ts` (4096² at low now level 1).
Gates: gate-fast-20261111-092458 GREEN (D597; 6 min, 5.5 GB; voxel area 159 s); gate-fast-20261111-101729 (budgets; 12 min, 7.1 GB, 719 vitest files) red only on D603 (`voxel-world.e2e.ts:401`, 752 chunks replaced where 8 were expected), GREEN on rerun gate-rerun-20261111-103052. No e2e file changed; voxel area 152–159 s.

**Measured** (staging, Iris Xe, Play in the editor, WebGPU 1280 × 720, low at 30 Hz, the realistic 8 km world;
`run.mjs coverage` 150 m/s `high` and 60 m/s `hug`, both with `--return 30`; `run.mjs headroom --quality low
--hide none --copies none --scales none`; one round a step, one change a step, 09:30–10:15, uptime 18.8 d, load
1-min 1–6; `work/46d.23/{cov-*,headroom-*}.json`, `sum.py`). Heap = page heap live after a GC (MiB); GPU = the GPU
process's DRM resident (MiB); RSS = the renderer processes (page + workers + the editor).

| low | 150 high: ground under / ahead missing | holes | 150 heap start → end → home | 150 GPU end | 60 hug: heap start → end → home | 60 GPU end → home | 60 RSS end | far held / coarser (end) | evictions | room at the town |
|---|---|---|---|---|---|---|---|---|---|---|
| D597 not fixed (the 46d.22 flight) | — | — | — | — | 395 → 1,132 → 1,093 | 1,102 → 1,080 | 3,465 | 0 / 0 | 0 | — |
| base (dd09676d) | 15.6 / 45.4 % | 0 | 384 → 487 → 466 | 881 | 399 → 665 → 642 | 1,077 → 1,066 | 2,966 | 0 / 0 | 0 | 192 × 0.131 = 25.2 ms |
| + stream 768 | 16.4 / 46.7 % | 1 (1 frame, m 6,815) | 381 → 511 → 476 | 869 | 378 → 694 → 636 | 1,108 → 1,092 | 3,045 | 0 / 0 | 0 | — |
| + far 384 | 15.4 / 44.7 %, again 14.3 / 44.6 | 0, 0 | 372 → 684 → 641, again 368 → 636 → 603 | 1,032–1,038 | 397 → 836 → 764 | 1,203 → 1,189 | 3,154 | 0 / 0 | 0 | — |
| + texels 512 | 12.0 / 44.7 % | 0 | 395 → 639 → 576 | 931 | 393 → 868 → 800 | 1,210 → 1,206 | 3,230 | 0 / 0 | 0 | 192 × 0.124 = 23.8 ms (first run 5: streaming hitch) |

Missed frames 7–17 of 1,997 (150) and 57–73 of ~4,940 (60) in every row. Read: on this world **none of the three
budgets binds at low** (D605): the stream never reaches 256 MiB (0 evictions), the far field never reaches 96 MiB
(50–85 MiB drawn, 0 held, 0 coarser stand-ins; detail is set by low's 8 px error), and the world's texture sets are
1024² (256 px/m), so 512 px/m keeps the same top level (`textureTops` 0 both). Play draws the same far set in every
row (2,094–2,137 nodes at the flights' end, 1,200 page nodes, 20,393 bricks). The far step's +150 MiB page heap and
+150 MiB GPU is the **editor's Scene view** behind Play, no longer held by its budget (the snapshot: brick copies
181 → 317 MiB, page far nodes unchanged; D604). Kept all three: they cost nothing where unused, bound travel, and
are the room the owner set; what they buy wants a 4096²-set world and a lower far error or wider low rings (D605).
**The split** page 1.5 / GPU 2.5 GiB confirmed as the default: the most measured was page 868 MiB, GPU 1,210 MiB
(GPU holds low's far 384 + stream 768 + textures 512 + saved light 32 MiB = 1.7 GiB of budgets, the page only its
copies); but page + workers + editor (RSS) reach 3.2 GB and with the GPU about 4.4 GB (D606).

**Looked at** (`far-field/46d.23/`: `<pose>-{before,after}.png`, `flight150-{before,after}.png` (t = 20 s), side by
side in `side-by-side/` with a 2× crop; every one opened; before = the far-384 build at 256 px/m). town-west,
peak-to-town, near-ground: the same pictures (≤ 0.01 % of pixels by > 60; near-ground's brick wall the same texel
blur both sides, the town's roofs, walls and the massif identical); town-peak-4.5km 0.24 % (clouds); the 150 m/s
frame (grass slope, gravel channel, cliff): the same view a few metres apart, no sharper ground. No sharper texture
and no more far detail, as the numbers say. *Unverified:* sharper textures on a world with 2048²/4096² sets, medium
and high on target hardware, an export without the editor (D606), WebGL 2.

### 46d.20a the far pass reshaped: a visibility target and one shade (vista step 4, WebGPU); D583

**Built** (46872194). The lead split 46d.20: 20a reshapes the far pass, 20b (visibility feedback streaming in compute)
is later. *Visibility pass* (`voxel-far-visibility.ts`, WebGPU; `?farPass=direct` and WebGL 2 keep the per-fragment
shading, `?farRes=half` keeps its own pass): the brick groups move to the pass's own scene; the march is the same
node march (culled-table rows, pyramid reject before it, 46d.17) but writes no colour, only its hit into an RGBA float
target with its own depth: **the texel** = the hit's brick (atlas region, a byte an axis), the hit in that brick's
cells (12 bits an axis over −1.5…9.5 cells), its view depth, and the face the ray entered by (the normal where the
field has no gradient); 0 = nothing hit; 16 B + 4 B depth a pixel (7.8 MiB at low/medium's 853 × 480, 17.6 at high).
The pass is drawn from the shade's `onBeforeRender` inside the frame's second pass (after the pyramid and the late
culling, so the lists and the per-pixel reject hold), into its own target at the frame target's size, MRT off, its
clear set and put back. *The shade*: one full-screen draw in the frame (`AFTER_PYRAMID_KEY`), the standard material
as before (metalness 0, roughness 1: the sun, the ambient **and the environment light**), reading its own pixel's texel
(`textureLoad`), placing the hit on the pixel's ray at its depth, reading the normal (the brick field's gradient,
six reads) and the baked colour (one read) once a pixel; **fog** is the scene's fog at the hit's own depth (three's
`context.getViewZ`; the per-fragment march fogged at its box's back face, a little farther), the depth the far
draws' (edge ring behind the near field), and the **motion** the hit's own (`OWN_MOTION_KEY` in `motion-vectors.ts`:
this frame's view-projection × the hit's world place minus last frame's × its last place, a floating-origin re-base
or a moved root carried by one matrix), so TAAU reprojects far pixels by where the surface was, not where its box's
back face was. The atlas's texture nodes and reads are shared by every far program (`voxel-far-brick-field.ts`).
*Shade pass type:* a full-screen fragment draw, not compute: the shade must write the frame's depth (the far field
sorts against the near field per pixel) and its motion attachment, which a compute pass cannot write; nothing to
choose by the meter. *Normals:* the field's gradient kept: its six reads now run once a pixel in the shade (the shade
is below the meter's resolution, below); a baked normal costs +65 MB at medium (46d.17 d: 164 → 229 MB) and was not
rebuilt. *Half resolution* (D574): not needed — low has 23–27 ms of room at its 30 Hz cap either way; left as is.

**Tested.** `voxel-far-view.test.ts` (+3): the texel's round trip (bricks to 227 an axis, the brick's whole span to half
a 4095th of it, the depth exactly in a float32, every face; a cleared texel reads as no hit); on WebGPU the brick
draws move to the pass scene, the march's WGSL keeps its depth and discard with 7 fewer filtered reads than the lit
march (the gradient's six and the colour), the shade's WGSL has its depth, discard, `textureLoad` and the 7 reads;
built under the motion MRT the shade writes a second output with no motion varying from its quad's vertices (its own
motion); half resolution takes the bricks and gives them back; WebGL 2 stays direct; the shade's hook against a
recording renderer: one nested render of the pass scene into a target of the frame target's size (853 × 480), MRT
null, auto-clear on and alpha 0 for it, then the frame's target, MRT, clear and flags put back; the culler handed to
the pass scene; a one-chunk re-base gives a point's last place +64 m, the next still frame the identity. Fast gate
gate-fast-20261111-110034 red only on D603 (`voxel-world.e2e.ts:401`, 771 replaced for 8), GREEN on rerun
gate-rerun-20261111-111151 (village perf 0 / 360). The e2e's Play, Scene view and export runs report `pass:
"visibility"` on WebGPU and `"direct"` on WebGL 2 (webgl2 smoke passed). No e2e file changed.

**Measured** (staging, Iris Xe, Play in the editor, WebGPU 1280 × 720, the 8 km world's town orbit, `run.mjs headroom
--scales none`, one round each, before = this build with `--query '&farPass=direct'`, interleaved 11:14–11:43, load
1-min 0.9–2.3, uptime 18.8 d; `work/46d.20a/headroom-*.json`, `sum.mjs`). Room = ballast held × its ms; frame GPU from
the edge; far = hidden far's ms past the edge (its share of four in brackets); far GPU = the far view's bytes after
the fill (atlas + draws + the visibility target).

| tier | room at the cap | frame GPU | far hidden (share) | no-load missed | far GPU MB | page heap / GPU MiB |
|---|---|---|---|---|---|---|
| low 30 Hz, direct | 192 × 0.120 = 23.0 ms | 8.4–10.3 | 1.89 ms (40 %) | 0 / 89 | 72.4 | 598 / 902 |
| low 30 Hz, visibility | 192 × 0.129 = 24.8 ms | 6.5–8.6 | 2.25 ms (23 %) | 0 / 89 | 80.6 | 606 / 959 |
| medium 60 Hz, direct | 60 × 0.124 = 7.4 ms | 8.7–9.2 | 3.02 ms (76 %) | 0 / 179 | 164.3 | 796 / 1,313 |
| medium 60 Hz, visibility | 64 × 0.129 = 8.3 ms | 7.9–8.4 | 0.16 ms (6 %) | 0 / 179 | 172.5 | 767 / 1,239 |
| high 60 Hz, direct | none (misses at no load) | — | 9.1 ms | 25 / 142, mean 21.0 ms | 315.3 | 1,022 / 1,858 |
| high 60 Hz, visibility | none (misses at no load) | — | 5.2 ms | 7 / 176, mean 17.1 ms | 333.7 | 1,095 / 1,922 |

Read: low's room moved by the ballast's slope only (the edge 192 both: one step is 16 units ≈ 2 ms, D588), frame GPU
−1.7 to −1.9 ms; medium's edge 60 → 64 (+0.5 ms room), frame GPU −0.8 ms. The far pass's own ms is not resolved by
the meter at low or medium (hidden far 2.25 / 0.16 ms against shadows or post hidden at −0.6 to −3.2 ms in the same
rounds): the change is a small gain, within the meter's noise at low. **High (D583): better, does not hold its
cap** — no-load misses 25 / 142 → 7 / 176 (mean 21.0 → 17.1 ms, 0 stalls both); far hidden 9.1 → 5.2 ms past the edge;
at no load near hidden holds (0 / 179), far hidden 2 / 179, shadows and post hidden still miss (12 / 179, 11 / 164);
high's frame times are **unverified on target hardware**. Memory: +8.2 MB far GPU at low/medium, +18.4 at high (the
target); page heap and the GPU process within run-to-run noise (GPU +57 low, −74 medium).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/46d.20a/`: Play, WebGPU, the five far poses at low (`-direct`,
`-vis1`) and medium (`-meddirect`, `-medvis`), `side-by-side/<pose>-<A>-vs-<B>.png` direct left, a 2× crop below;
8-frame strips ~0.25 s apart of the town orbit (`strip*`) and of the 60 m/s flight 10 s in (`fly*`), `side-by-side/
{strip,fly}-<A>-vs-<B>.png` and full-size crops `{strip,fly}-crops-<tag>.png`, TAAU on both tiers; every one opened).
Direct → visibility, low: 0.00 % of pixels by > 60 at peak-to-town, town-peak-4.5km, peak-sight-5km and
beyond-peak-to-town (≤ 0.08 % by > 20), town-west 0.25 % (the town's roof edges: TAAU's settle between runs, near
field); medium: 0.00–0.01 % at the far poses, town-west 0.71 % (the same roof edges, the visibility run a touch
softer). **Light:** sunlit slopes, rock and snow the same; **shade-side rock** keeps its blue-grey environment light
(not the black of 46d.17 e). **Fog:** the distant haze on the massif the same to the eye (this world's fog is thin;
the shade's fog is taken at the hit, a little nearer than the box's back face, no visible change). **Edges:** ridge
silhouettes against the sky and the far slopes behind the roofs single and as sharp as before; no hole, no fringe at
the near field's edge, no box missing. **Ghosting: none seen** — in the orbit strip the roof edges against the far
slope stay single in every frame; in the flight strip the massif's silhouette and slopes stay single, both runs as soft
as TAAU at speed is on low (no trail behind the ridge). *Unverified:* WebGL 2 pictures (unchanged path; the webgl2
smoke), high's pictures, the Scene view's and an export's far field in pictures (the e2e reads them drawing,
`pass: "visibility"`), a world with position-lit far ground (D607), medium/high frame times on target hardware.

### 46d.20b visibility feedback: the far tree streams by what the eye sees (vista step 4, WebGPU); D585, D598

**Built** (14617da1, f7a9df90, f2d6a1eb). *The reduction* (`voxel-far-feedback.ts`): right after the visibility pass
(20a) is submitted, every 4th pass while no round is out, one compute call of two dispatches: a clear, then a thread a
2 × 2 pixels reading its texel; on a hit `atomicAdd` on its brick region's count and `atomicMin` on its view depth's
bits (two u32 a region of the atlas, 256 KiB at low/medium). The buffer is copied for reading in the same turn
(`getArrayBufferAsync`, submitted after the dispatches) and mapped whenever the GPU gets there: rounds came back
after 0–1 passes (6–28 ms), ~7 a second at low; nothing in the frame waits. *Per brick, not per node:* the texel names
the brick, the page knows each region's node, so the GPU needs no table; regions are stamped with the far view's
version when given (`FarRegionOwners`), a round with its frame's version and atlas shape, and a region given later or
given back is left out. *The wire:* `voxels.farSeen` to the simulation worker (or the page's own simulation),
`FarSeenWire` = round number, the last far event its frame drew (`FarEvent.seq`, new), and per node seen level, place,
pixels, nearest depth in cells. *The tree* (`far-seen.ts` `FarSeenLog`): a node's last sighting and, per ancestor, the
last sighting under it; stale rounds (number or frame not newer) dropped. Seen = itself, a node under it or its drawn
stand-in seen within the turn window (6 s); unseen once rounds came for a whole window and none did; never a node
inside the near field's load cylinder, never one held seen (seen again after a window twice within 4 windows: held for
10). The work order puts refinements under unseen stand-ins after the seen ones and ranks a seen stand-in by the
error it was seen at. Near the far GPU budget (≥ 90 %) the selection also takes an unseen node at ¼ of its error (two
levels coarser), so the budget goes to what is seen. `?farFeedback=off` (now passed through Play) makes no rounds;
WebGL 2 and `?farPass=direct` have none (screen error alone, as before).

**Chosen by measurement.** *Release at any fill* (14617da1, the first build): the far field at low drew 271–301
nodes (28 MiB) for 1,037 (77 MiB), medium 915–1,042 (92 MiB) for 2,594 (165 MiB) — but it never settled with a still
camera: at the flight's start 9,097–13,957 far jobs for 362–468 drawn nodes before the camera moved, fill 143–276 s
(the bench's fill rule timed out), a town pose 33 k jobs in 5 min, and peak-to-town visibly softer (0.35 % of pixels
> 60). Two cycles, both traced: nodes wholly under the near field are never drawn by the far view, so never seen,
drawn coarser they reach out of it, are seen, refine and vanish again; and a coarse stand-in whose surface stands
above the finer one is seen drawn coarse, hidden drawn fine. The cylinder rule and the hold cut the churn by a third
(9.1 k jobs, fill 177 s), not to zero, so release is bound to the budget (f2d6a1eb): below 90 % the unseen keep their
detail. *Step 2 × 2:* a node over a few pixels is met; a quarter of the threads and atomics of every pixel; the pass
is below the meter's resolution either way (not resolved: no rows hidden in these runs). *4 passes:* ~7 rounds a
second at 30 Hz, latency ≤ 1 pass seen; one round out at a time keeps a single 256 KiB copy. *6 s window:* a look
round and back finds its detail; the town orbit's turn is 42 s.

**Tested.** vitest `voxel-far-feedback.test.ts` (+3): a known visibility target (packed texels) reduced to each
brick's pixels and nearest depth, step 1 and 2; owners' versions (a round of version 1 leaves out a region given at 2,
regions given back are stale, one reused by another node is not the old one's); the far view's pass hook with a
recording renderer: one compute call of two dispatches every 4th pass, none while a round is out, the round's node
handed on with its frame's far event, a node given after the frame left out. `far-seen.test.ts` (+5): stale rounds,
seen through self/under/stand-in, unseen only after a full window, the hold, the near cylinder; the selection draws
the unseen half of a flat world two levels coarser and gives a tight budget to the seen half first. `far-world.test.ts`
(the far field test, real cache and workers): asked for finer nodes, every refinement under the seen stand-in comes
before every other; turned away, the detail stays within the window and after it far from the budget, and near the
budget the stand-in is drawn again (never nothing); a stale round changes nothing. `coverage.test.ts` (+2),
`headroom.test.ts` (+1, the fill rule). e2e `voxel-world.e2e.ts` (Play and the export, WebGPU): a round names seen
nodes, and a round's GPU reduction equals region for region the CPU's of the same target read back (`differ` 0);
WebGL 2 smoke: no rounds, passes. Fast gate gate-fast-20261111-125426 GREEN (16 min, 6.7 GB, 724 vitest files, 63 e2e;
voxel area 167 s; village perf 0 / 361).

**Measured** (staging, Iris Xe, Play in the editor, WebGPU 1280 × 720, the 8 km world; before = this build with
`&farFeedback=off`, 13:16–13:37; after = f2d6a1eb, 14:21–14:29; one round each; load 1-min 2.4–7.9 (after higher),
uptime 18.9 d; `work/46d.20b/{headroom,cov}-*.json`, `low-shots-*.json`, `sum.mjs`; the release-at-any-fill runs in
`work/46d.20b/on1`, `on2`, `on3`).

| | far nodes / bricks at the fill | far GPU MiB | far jobs built (fill) | fill | room at the cap | no-load missed |
|---|---|---|---|---|---|---|
| low 30 Hz, off → on | 1,037 / 17,952 → same | 76.9 → 76.9 | 1,050 → 1,050 | 7.2 → 8.1 s | 176 × 0.126 = 22.2 → 136 × 0.130 = 17.7 ms | 0 → 2 / 89 |
| medium 60 Hz, off → on | 2,594 / 43,597 → same | 164.5 → 164.5 | 2,927 → 2,927 | 12.8 → 15.1 s | 0.4 → 0.4 ms (edge 3 both) | 1 → 0 / 179 |
| low, released at any fill (first build) | 271–301 / 5,032–5,516 | 28.2–28.3 | 1,050–1,182 | (never settled) | 17.7–22.2 ms | 0–1 / 89 |

| low, coverage | ground missing under / ahead | hole frames | view rays into a stand-in (polls) | eye inside | missed | far drawn end, jobs | heap start → end, GPU end MiB |
|---|---|---|---|---|---|---|---|
| 150 m/s high, off → on | 16.3 / 47.5 % → 18.3 / 55.0 % | 0 → 0 | 0 → 1 of 192–196 | 0 → 0 | 23 → 24 / ~1,995 | 2,094 → 2,098, 16.1 k → 15.7 k | 394 → 666, 1,072 / 376 → 674, 1,043 |
| 60 m/s hug, off → on | 0.56 / 2.5 % → 0.85 / 4.0 % | 0 → 0 | 100 → 109 of 484–493 | 0 → 0 | 89 → 86 / ~4,930 | 2,137 → 2,137, 17.4 k → 17.4 k | 385 → 899, 1,243 / 412 → 875, 1,240 |

Read: on this world the far budget never binds at low or medium (77 / 165 of 384 MiB), so the shipped rule draws the
same nodes and bricks, swaps the same (in/out within 1 %) and holds the same memory; what feedback changes here is
the order of the far work (seen-coarse first), and its cost is below the meter's resolution: low's room moved by 5
edge steps (a step ~2 ms, D588) with the load 1-min at 7.9 when the "on" run started, medium's edge 3 both (medium has
no room at the town on this host, D587). What release would buy where the budget binds is the first build's line:
−71 % nodes, −63 % far GPU at low; it waits on a selection that does not flap (D608). **D598:** no — the ground under
the camera at 150 m/s is the near field's: 16–18 % missing either way (60 m/s 0.6–0.9 %), the far field's jobs
are decodes of baked bricks (~0.3 ms) on its quarter of the workers, and feedback took nothing from the near field's
work (the first build's runs are not comparable: their long fills counted standing updates). What would: the near field's collision ring derived first and coarser at speed (levels 1–2 for collision only under
the camera), a narrower lead corridor, more workers for the ring while fast, and mip nodes without
collision/nav/light (D601: 11–24 % of a mip node's worker time). **D585:** the bench now also casts 15 rays through
the lower half of the view (to 48 m) at every position poll and counts a ray entering a far node's solid at a box
face: hugging at 60 m/s 20–22 % of polls (212–245 rays) see it while the eye check stays 0; 30 m up at 150 m/s 0–1
poll. That is D585's measure; feedback does not change it (a coarse stand-in under the camera is seen and refined
first, but at 60 m/s the near field has not drawn there either).

**Looked at** (`~/.cache/thirdlight-phase46/far-field/46d.20b/`, every picture opened; `side-by-side/<pose>-off-vs-on.png`
off left, 2× crop below; `fly150-off-vs-on.png` 150 m/s frames at 10/20/30/40 s, off above; `orbit-strip-off-vs-on.png`
the town orbit 0.5 s apart). peak-to-town: the same picture (0.00 % of pixels by > 60): massif, lowland channels and
the red town patch alike. town-west: the same (0.12 % by > 60, TAAU's settle at the roof edges). Orbit strip: the same
frames, steady, no node popping in either. 150 m/s: the same scenes a few metres apart, no hole; at 30 s the massif's
cliff dark and blocky both (D585's inside view at the cliff), at 40 s the channel alike. Seen with the first build
(`on1/`): peak-to-town visibly softer lowland channels (0.35 % by > 60), the release flapping. In both orbit strips a
roof at the near field's edge shows a notch (left, frame 4; near field, not this item). *Unverified:* motion at full
rate, medium/high pictures, the Scene view and the voxel world page (no rounds: D609), a world whose far budget binds,
WebGL 2 pictures (the smoke passes).

### 46d.15 review fixes

The independent review's tooling and test findings (§9, "46d.15, independent review"); H3, M2, M3 and L7 are the
next fix pass's.

| Finding | What changed | Commit |
|---|---|---|
| H1 | `everyArea` in `tools/gate-areas.json`: project-model, shared and the backend's plumbing (api-router, auth, backend, config, engine, full-state, http, index, services, sessions, session and static routes, util, ws-channel) run every area, as wide as `phase`; the rest of the backend's 75 unmapped sources mapped to their areas; `check-gate-areas.mjs` fails a package source (packages/*/src, tests aside) in no area, and `--for` runs every area for one anyway; a unit test beside an every-area source runs no area | d484d1d2, c2c63280 |
| H2 | `tests/e2e/webgpu-reference.e2e.ts` (environment, materials areas): WebGPU against the frozen references, 21 environment/post cases + 5 behaviour checks, 8 shader families + 5 as graphs + the control; harnesses and refs `git mv`ed back to `tests/e2e/webgpu-reference/` | 6892a30c |
| M1 | `stream-speed.test.ts`: renamed to what it checks; counts, not ms | bd1534e3 |
| L1 | history check reads `.sh` comments; gate.sh's date and defect id gone | 61d0f8d3 |
| L2 | voxel-world.e2e.ts WebGPU only; restart + reload and the run-time tier switch moved into the WebGPU runs | 3b4ac226 |
| L3 | webgl2-smoke: a voxel world in the scene, drawn in Play and the export; a real share of the picture | 4518059f |
| L5 | stream.test.ts 2,000 → 1,252 lines + stream-levels.test.ts 716 + stream-fixture.ts 128 | c18c162e |
| L6 | quality-levels.test.ts: the 4096 and the sum dropped, the relation checks kept | 81f2ab58 |
| L8 | `perf/run.mjs see-through-cpu`; voxel-bench `stream` prints a pool line | 2e6bf6c2 |
| watch | D610 (memory.e2e.ts:350, gpu.buffers 88 → 91 once in the phase gate) | this docs commit |

H1, before → after: 268 of 1,584 package sources reached no area; now 0 (203 every area: project-model 173,
shared 17, backend plumbing 13; content 13, materials 12, scripting 6, voxel 5, mcp 4, the rest in one or two areas
each). Dry run, `check-gate-areas.mjs --for packages/project-model/src/quality-levels.ts`: all 19 areas, 179 of 179
e2e files (180 with H2's); `--for packages/backend/src/far-cache-worker.ts`: voxel. A probe file
`packages/backend/src/zz-unmapped-probe.ts` failed the build check ("reaches no area").

H2: the references are the archived WebGLRenderer's pictures (`bloom`, `tone-aces`, `tone-neutral` redrawn on
purpose before, unchanged now); none was redrawn from today's WebGPU (a reference from the code under test passes
whatever it draws). All 40 tests pass within their rules on this GPU (sky-color mean 0.04, bloom 0.10; the
control misses), 43 s on one worker. Not restored: `scene-view-parity` (Scene view against Play on the product's
renderer, no reference image): it needs its own backend and editor; left archived for the owner to choose.

M1: the flight still runs in real time (the focus's speed is read from the clock); it now asserts the ring
narrowed, that every update counted the ground (200 of 200, ground missing 0, ahead 39 in the run measured), and
that once stopped the ground under the focus is known after 10 of the 7,736 jobs that refill the widened ring
(bound: a tenth). The flight's missing share is the coverage bench's to report.

L2/L3 e2e times, fast gates at 2 workers (gate-fast-20261111-154323 → gate-fast-20261111-160835): voxel-world.e2e.ts
149 s (6 tests) → 113 s (4); webgl2-smoke 19.1 → 23.7 s (the voxel world in Play and the export). Area gate
`voxel environment materials rendering` (gate-area-20261111-161413, 43 files, 3 workers, leak test on): green, 8 min;
`layered-material.e2e.ts:258` failed once on the export's `export_output_path_invalid` and passed alone (D319). Dropped with the WebGL 2 runs: a voxel world in Play with the simulation in
the page (`threads=off`; sim-worker.e2e.ts keeps that path for a game) and WebGL 2's relief in Play. The smoke's
bounds: a scene 0.2 of the picture off its most common colour (Scene view measured 35 %), a voxel world 0.5 (Play
83 %, export 80 %, the voxel page 66 %); Play's and the export's pictures looked at: ground, wall and pad drawn.

L8 (load 2.0–2.3): see-through search over 600 instanced members, members moved every frame: 0.68–0.71 ms mean,
0.96–1.11 p95 (the removed unit bound was 5 ms); the merge of 600 boxes into 6: 0.62–0.63 ms mean (bound was
20 ms). 8 background jobs of 40 ms on 4 idle workers: 81.6 ms, ideal 80 (bound was 240 ms).

**Second pass (H3, M2, M3, L7, the `threads=off` gap).**

| Finding | What changed | Commit |
|---|---|---|
| M3 / D603 | a product defect: one step of the camera (the page's `look`, 26 m in a frame) read as a burst of speed, the ring narrowed and half a second later widened and refilled into the edit's swap (752–782 chunk draws for 8). Motion now needs a run of steps lasting the smoothing window | b393b182 |
| H3 / D598 (part) | the speed ring flapped (222 ring changes, 172 k reloads in one flight: steps reach the simulation's streamer 0.3 ms apart, the per-step speed test reset the velocity): a jump is judged by length only, a narrowed ring widens after 1 s down; at speed the way ahead is a 32 m corridor (one shape with the focus's bounds, near lane, read under the focus first) in place of a 48 m ring round the lead point; the count says why the ground was missing | b393b182 |
| test race | stream.test.ts collision ring: the dig waits for a still ring (failed once in the gate, passed alone) | 99099271 |
| threads=off | the export's second load (low, far bricks) runs the simulation in the page: streams, draws, character on the pad | 251c23b0 |
| M2 / D608 | far-world.test.ts `seenUnderBudget`: budget half of what is drawn, rounds naming the drawn nodes in front | eb88e200 |
| L7 / D574 | half-resolution march retired (`archive/removed-phase-46d/`), `?farRes` refused | e9581c15 |

H3, `run.mjs coverage` (staging, Iris Xe, Play WebGPU low 30 Hz, the 8 km world, one round each; before 16:32–16:46
at d4a9f83d, after 17:22–17:31 at b393b182's streaming code; ground % of all updates, as 46d.22 read them;
`work/fix2/cov-{before,after}-*.json`, `sum.mjs`):

| low | under / ahead before → after | why under (after: unread, reading, blocked, deriving) | holes | missed |
|---|---|---|---|---|
| 150 m/s, 30 m up | 20.9 / 51.6 → 14.1 / 40.9 % | 87, 13, 812, 381 | 0 → 0 | 17 → 30 / ~1,990 |
| 150 m/s, hugging | 18.5 / 63.6 → 9.1 / 62.7 % | 39, 9, 431, 357 | 0 → 0 | 24 → 28 |
| 60 m/s, 30 m up | 2.9 / 8.9 → 4.2 / 15.1 % | 107, 13, 542, 212 | 0 → 0 | 56 → 53 / ~4,940 |
| 60 m/s, hugging | 0.6 / 3.1 → 0.6 / 13.1 % | 35, 13, 42, 35 | 0 → 0 | 95 → 89 |

Not 0 %: the pool is the bound (its queue sat at 100–250 jobs through the flight); what is missing under the camera
is resident chunks waiting for a neighbour (blocked) or for their derive. Ahead is worse at 60 m/s: the corridor is
narrower than the ring round the lead point it replaced. Measured in a node harness (3 workers, hilly world,
150 m/s): the coarser levels (levels 1–2) took 35 % of the workers' time in flight though only level 0 draws inside
the narrowed ring; skipping them there cut it to 1 % but made the browser flight worse (33–44 % under: the stale
nodes the change left were walked every update), so it was not kept. The owner then replaced the criterion
(hitches and settle times, 46d-c): D598 superseded, these numbers its last. Pictures
(`far-field/46d.15-fix2/{before,after}/low-150-high-*-t{10,20,30,40}.png`, all eight opened): t10 the same frame
(lowland, the town's red patch, the massif), t20 the valley floor and its channel, t30 the massif's cliff close
(after: a moment later, the rock shoulder against the sky; both dark and blocky as in 46d.22), t40 the valley with
the channel; no hole in any, no visible difference between before and after at these stills.

M2: with the budget binding a still eye's far field releases the unseen half and settles: meshes made per 0.6 s
window 17, 3, then 0 six times, no job left; turned round, 17, 3, then 0 eight times, the new front finer (mean level
lower) and the old front coarser. The release does not flap on this feedback model; the stand-in whose surface
stands above the finer one (D608's second cycle) needs real pictures and is not reproduced here.

Gates: gate-fast-20261111-165602 GREEN (14 min, 5.3 GB; stream.test.ts collision ring failed once, passed alone
→ 99099271); voxel-world.e2e.ts 113 → 111 s (export 25.0 s with the `threads=off` reload).

### 46d.15 close: the low tier's memory in an export (M5) and acc46d-b

**M5** (`run.mjs export-memory`, 57522215; `work/46d.15-close/m5/`): the staging Play project (8 km world) exported
with the debug console on and a camera that orbits the town and flies the coverage bench's 9.84 km line on
`fly60` / `fly150`; the export served statically with the backend stopped; low, WebGPU (`webgpu/ready`), 1280 × 720,
30 Hz; 2 rounds 17:53–18:03 UTC, load 0.8–3.0. Fill 4.2 s. No console error, no request outside the export.

| low, export (2 rounds) | town orbit | after 60 m/s | after 150 m/s | home (town, 30 s on) | budget |
|---|---|---|---|---|---|
| page heap MiB (live after a collection) | 301–356 (283–318) | 296–305 (283–290) | 278–290 (273–275) | 297–304 (287–288) | 1,536 |
| GPU, driver-resident MiB | 543–552 | 576–578 | 580–583 | 627–628 | 2,560 |
| renderer process RSS GB (page, simulation, voxel workers) | 1.30 | 1.62–1.68 | 1.62–1.68 | 1.48–1.51 | |
| whole browser RSS / PSS GB | 1.79 / 1.54–1.56 | 2.15–2.21 / 1.88–1.94 | 2.14–2.21 / 1.87–1.94 | 2.00–2.04 / 1.73–1.78 | |
| game total, PSS + GPU GiB | 2.05 | 2.40–2.46 | 2.39–2.46 | 2.31–2.35 | 4.0 |

Against Play in the editor (D606, 46d.23): renderer RSS 1.9–2.1 GB at the start and 2.5–3.2 after a flight, GPU
process 0.4–0.5 GB beside 0.7–1.2 GB driver-resident, about 4 GB in all; the export holds about 60 % of the low budget
at its peak, the split well inside both halves (heap ≤ 23 %, GPU ≤ 25 %). Frames at the cap in the export: 60 m/s 30–35
missed of ~4,910, 3 over 100 ms, longest 142–155 ms; 150 m/s 12–14 of ~1,965, 1 over 100 ms, longest 153–173 ms (46d-c's
starting point). Per-worker heaps are inside the renderer's RSS, not separated. D606 fixed, D604 updated.

**acc46d-b** (`~/.cache/thirdlight-phase46/acceptance/46d-b/`, README, `approve-46d-b.md`; scripts
`work/46d.15-close/acc/`): Play in the editor on staging, 18:04–18:09 UTC, load 2.2–4.5. 8 poses × low and medium on
WebGPU (both draw 0.667 + TAAU), a TAAU orbit strip and a 150 m/s strip (8 frames 0.25 s apart, low above medium, with
1:1 crops), three before/after pairs (46d.12b's bricks | now, medium), one WebGL 2 smoke picture (low, FSR 1). All
looked at: no mush, crisp far silhouettes and the town's back row (D593 holds); D578's thin lines on the grass slopes
and D572's lattice on the near escarpment still show; the low 150 m/s frames 1–5 have dark green slivers at the bottom
edge (not seen on medium; not traced); medium looks like low at these poses.

### 46d.24 travel at speed by hitches and settle

**The measures** (46d.24a, `run.mjs coverage`, `coverage-cli.ts`; arithmetic `travel.ts`, page side `travel-page.ts`,
the probe in the shared flight behaviour `flight-camera.ts`; vitest `travel.test.ts`). Same 9.84 km line 30 m up
(`high`), the camera stops at its end (eastern mountains) and stands 30 s. Runs in the **export** (`--export` with
staging up, then `--dir` with it stopped, served statically) or Play in the editor (default). Per run:

- *Flight frames*: the meter's presented-frame intervals at the tier's cap: longest, count over 100 ms, missed (over
  the cap's miss interval) a minute.
- *Ground solid after the stop*: a ray straight down from the camera every simulation step against the colliders
  (`ctx.physics.raycast`), solid when it hits within 3 m of the ground under the line (the far cache's level-2 cells);
  seconds in simulation steps from the stop step to the first solid one. In flight the same ray gives the share of
  steps with collision under the camera (`groundRay`).
- *A body never falls through*: the project gets a capsule player controller for the run (`Perf probe character`,
  taken out after); the flight places it 2.5 m over the line's ground under the camera every 2 s of flight and once
  at the stop (`character_place`), and reports its height, standing and suspension as run counters (read from the
  play's observation, 20 Hz in an export, 4 Hz in Play). A fall-through = a reading neither suspended nor standing
  and 6 m under the drop point's ground. Covers: a body resting where dropped while the world streams round the
  camera and round it (a player is a collision focus), and collision swapped from under a standing body. Does not
  cover: a body moving over the ground at speed, bodies other than a character controller, falls shorter than 6 m,
  a 2 m-cell ground estimate wrong by more than that (steep cliffs), drops between readings (≥ 5 readings a drop).
  `bodyFree` / `bodyStands`: after the stop's drop the first step not suspended / standing (includes a ~0.5 s fall
  from 2.5 m).
- *Full detail stands*: the page's level-0 chunk count and kit pieces drawn (every frame, `__tlVoxelPlay.stats()`)
  within 1 % (or 2) of their final values and held 3 s; *nothing pending*: every near count (chunks, levels 0–2,
  pieces) and the far nodes/bricks (2 %) so. In Play the simulation's queue, jobs in flight and far pending at 0
  (`simIdle`) agree with the page's within 0.1–0.3 s in all four runs, so the export's page-count reading stands for
  it. Not seen by either: work that changes no count (textures streaming in, a rebuild drawing the same count).
- *Spikes*: every gap over 100 ms between the page's animation frames with the Long Animation Frame overlapping it
  (its longest script's invoker) and what the draws' counts did across it. Play's preview frame reports no long
  frames (0 kept in every Play run): its gaps are unattributed.
- *Pictures*: the screencast at 640 × 360 every frame (the hole check reads every second pixel, 320 × 180 as before);
  `--strip` keeps chosen frames without a capture of its own. The bottom 9 rows' near-black share is kept a frame for
  D611 (but see below). D585: the 15-ray view check and the eye-inside sample, 4 Hz, as before.

**Baseline** (Iris Xe, WebGPU, 1280 × 720, at the cap: low 30 Hz, medium 60 Hz; the 8 km world; export
`voxel-slice@r716` (product code as at dda61ab9: nothing under packages/ changed since e9581c15); 2 rounds each 20:41–21:05 UTC, uptime 19.2 d,
load 1.9–4.8 (the bench decodes every screencast frame); Play 1 round 21:06–21:17, load 3.5–5.9;
`work/46d.24/{exp,play}-*.json`, `sum.py`, `*.uptime`). Medium/high frame times are **unverified on target hardware**
(this host has only the Iris Xe). Seconds after the stop; two export rounds as a–b.

| export | longest ms | > 100 ms | missed / min | ground solid | body free / stands | full detail | nothing pending | falls | hole frames |
|---|---|---|---|---|---|---|---|---|---|
| low 60 | 85.5–98.8 | 0, 0 | 14.3, 10.6 | 0.01 | 0.07–0.08 / 0.27–0.50 | 3.6–4.4 | 8.2–8.5 | 0 of 83, 83 | 0, 0 |
| low 150 | 151.8–207.8 | 2, 2 | 20.1, 22.9 | 0.01 | 0.03–0.09 / 0.50–0.52 | 4.3–4.4 | 7.8–8.2 | 0 of 34, 34 | 1, 0 |
| medium 60 | 107.9–161.9 | 1, 2 | 46.1, 44.6 | 0.01 | 0.13–2.25 / 0.33–2.41 | 9.5–11.8 | 14.5–15.1 | 0 of 83, 83 | 1, 3 |
| medium 150 | 53.1–57.0 | 0, 0 | 21.0, 29.3 | 0.48–0.53 | 1.05–1.25 / 1.48 | 13.6–15.4 | 16.0–17.3 | 0 of 34, 34 | 0, 1 |
| starting target (low) | < 100 | | | < 0.5 | | < 2 | < 10 | never | |

| Play (1 round) | longest ms | > 100 ms | missed / min | ground solid | body free / stands | full detail | nothing pending (sim idle) |
|---|---|---|---|---|---|---|---|
| low 60 | 105.4 | 1 | 20.9 | 0.01 | 0.35 / 0.50 | 5.5 | 9.4 (9.5) |
| low 150 | 674.8 | 3 | 26.5 | 0.01 | 0.57 / 0.79 | 5.7 | 10.2 (10.3) |
| medium 60 | 153.4 | 2 | 46.1 | 0.01 | 0.35 / 0.53 | 12.4 | 17.2 (17.5) |
| medium 150 | 106.9 | 1 | 15.5 | 0.64 | 1.47 / 1.57 | 22.0 | 22.9 (23.0) |

No body fell through in any run (0 of 34 / 83 drops, 12 runs). In flight the ray under the camera found collision in
8.7 % (low 150), 12 % (medium 150), 23 % (low 60), 38 % (medium 60) of steps, none in the rest (0–0.2 % hit deep under
the ground); of the drops 8–63 landed, 12–31 stayed suspended the whole 2 s (collision never came: the engine holds
them, by design). Holes: every hole frame but one is at the line's 90° corner on the massif (m ≈ 4,434, a key-pixel
spike of 3,600–4,200 in one or two frames, 46d.22's camera-poll artefact of the check), the other a 34–35 px frame at
m ≈ 6,834 (both tiers). D585: rays entering a stand-in at a box face in 1–3 of 185–580 samples a run, eye never inside.

**Where the spikes come from.** Every export frame over 100 ms on the page's thread is one `Worker.onmessage` task:
the simulation's batch for one streamer swap applied whole — at the town (t ≈ 15.6–16.8 s at 150 m/s, 38.9–40.9 s at
60 m/s): 39–89 new level-0 chunks, 93–248 meshes built and 7,600–35,200 kit pieces placed in one task of 80–131 ms
of script (low 150 both rounds, medium 60 both rounds; D612). The other long frames (50–100 ms) are the same task with
fewer chunks or a rAF callback (`Q`, the render) of 50–56 ms right after it. In low 150's runs those were the only page
gaps over 100 ms (the meter's longest presented frames, 151.8 and 207.8 ms, carry no time to match them one to one). In Play the same counts move across its gaps (71–124 level-0 chunks, up to
35,219 pieces; the 674.8 ms frame at t 9.5 s applied 71 level-0 chunks / 237 meshes) but the preview frame gives no
long-frame timing. Built for nothing: in the low 150 Play flight the simulation loaded 53,943 chunks (43,489 air) and
unloaded 53,932, ran 281,240 section derives (4,300 a second) and cancelled 813 loads; its queue stood at 105 jobs on
mean, at its 256 limit at peaks (medium 150: 217 on mean, the far field 3,064 nodes pending on mean, 6,616 at peak).

**What the settle waits on.** After the stop the ring widens back (one `speedRings`) and refills: the queue goes from
0 to its 252–256 limit 2 s after the stop and drains by 5 s (low); low's level-0 count and pieces settle at 3.6–5.7 s,
the far field and the rest at 7.8–10.3 s; medium at 9.5–22 s (its level-0 ring 64 m against low's 45 m, its queue
holding far work: 33–39 k section derives and 5.3–5.8 k loads after the stop at either tier). Ground under the camera
is solid at once except medium 150 (0.48–0.64 s).

**Looked at** (`work/46d.24/strip-export-{low,medium}-150-{flight,stop}.png`, montages of `shots/export-*-r1-strip-*`;
all 30 frames opened). Flight, both tiers alike: lowland, the town as a red patch at t 10, valley channels, mountains;
no sky hole; t 30 (the massif's cliff close by) dark blocky rock with a square grid and a straight seam (the cliff
noted in 46d.22 — not the grey D585 grid); low t 5 a lighter flat green rectangle along the bottom edge (a near patch
drawn over the coarse ground); medium t 64 a black wedge at the bottom-right corner. No dark green slivers at the
bottom edge in these nine stills (D611 not reproduced at these times; the acc46d-b frames were 0.25 s apart at the
flight's start). Stop, both tiers alike: 0.5–4 s a coarse, blurred surface (streaked at the bottom right), at 8 s the
detail has popped in (sharper rock and grass, different material patches): a visible pop between 4 and 8 s, later than
the counts settle at 4.3 s on low (textures streaming in, not counted); low at 1 s and 15 s and medium at 15 s show flat
grey untextured patches (D613). The bottom-rows dark share is no sliver detector: it flags 15–19 % of flight frames and
every frame at the stop pose (dark rock at the bottom), so it is kept as a raw series only.

**D612 (first Play smoke, 1.5 km park).** Once, standing at a 1.5 km park point in Play, the probe character stayed
suspended for 30 s with the simulation idle and the ray under the camera solid at 0.01 s (`work/46d.24/smoke3.json`);
at the line's end it was free in 0.03–2.3 s in all 12 runs. Not traced (D614).

**Proposal for the mechanisms slice** (ordered by what the numbers say):

1. **Apply a swap's batch over frames, or make it smaller** (D612, the only > 100 ms frames): `three-adapter`
   `voxel-world-draws.ts` (`apply`), `voxel-chunk-view.ts` (`applyChunkDrawBatch`), `voxel-piece-batches.ts` (kit
   instances rebuilt per batch) — build the batch's meshes and instances hidden over several frames within a
   ms budget and flip them in one frame, keeping the atomic swap; or `game-host/voxel-play.ts` / `voxel/chunk-batch.ts`
   splitting a streamer task's batch. Measured by `spikes.worst` (delta per gap).
2. **No level 0 at speed**: the batches that spike are level 0 and pieces at the town at 60 and 150 m/s, thrown away
   within a second. Above `STREAM_FULL_RING_SPEED` the near field asks for levels 1–2 only (`voxel/stream-lod.ts`
   `LevelRings`, `stream-mips.ts`, `stream-ring.ts` `speedRing`) except round collision foci; pieces follow level 0.
   Then levels return from the camera outward when the speed falls (the settle's refill order, `stream-reads.ts`).
3. **Cancel stale queued work**: 53,932 of 53,943 loaded chunks unloaded within the flight, the queue at its limit:
   `voxel/worker-pool.ts` (cancel queued jobs by a predicate), `voxel-streamer.ts` (`drop`: loads only today),
   `stream-sections.ts` (queued section derives of chunks out of the ring), `far-field.ts` (far jobs for nodes no
   longer selected). The settle's 2–5 s queue refill is then the ring's own work only.
4. **Collision on its own path**: ground solid is already at once at the stop except medium 150 (0.5–0.6 s), but in
   flight collision under the camera exists in only 9–38 % of steps: a collision-only derive job (`voxel/stream-job.ts`,
   `derived-collision.ts`, `ground-heightfield.ts`) round `collide` foci and along their velocity (`runtime/
   voxel-world-host.ts` `step`, `voxel/collision-ring.ts`), not round the camera.
5. **A coarse fallback floor**: 12–31 drops a flight stayed suspended (no collision came); a level-2 heightfield from
   the far tree's nodes the simulation already holds (`voxel/far-field.ts`, `far-tree.ts`, `ground-heightfield.ts`)
   as a body under the fine ring (`voxel-world-host.ts` `PortBodies`), and `runtime/body-suspension.ts` counting a
   column on the coarse floor as loaded.
6. **D585**: rarely seen at 30 m (1–3 face-ray samples a run); a `hug` run is its before/after (`--altitude hug`);
   in `three-adapter/voxel-far-visibility.ts` / `voxel-far-bricks.ts` a node holding the eye skipped or drawn from
   outside, `far-field.ts` refining round the eye first (exists).
7. **D611**: not reproduced in the strips; a `--strip` at 0.25 s steps over the flight's first 3 s at low is the
   check before any change (`voxel-chunk-view.ts` near cover by chunk, the far draw's hide).

**46d.24b: the mechanisms** (51d69259, 3d9acf42; export `voxel-slice@r761` for the steps' last two columns and the
final table, one round a step before it; Iris Xe, WebGPU, at the cap, alone on the host, uptime 19.2 d, load 1.6–4.7;
`work/46d.24b/{s1,s2,fin,play2}-*.json`, `sum.py`, `*.uptime`). Medium frame times **unverified on target hardware**.

1. **A swap made over frames, shown in one** (D612; `three-adapter/voxel-batch-stage.ts`, `VoxelChunkView.prepare/commit`,
   `VoxelWorldDraws.pump`). Rule: a batch's draws (surface geometry, kit piece instances, the shader grid into a region
   of its own) are made hidden within `VOXEL_BATCH_FRAME_SHARE` (a quarter) of the page's measured frame interval a frame
   (never more than the slowest cap's: ~8 ms at 30 Hz, ~4 at 60), at least one draw a frame; once every draw is made the
   whole batch (removals, shader changes, draws, seams, far change) is shown in one task; later batches wait. Why: the
   atomic swap is about what is *shown* (R107: no half edit, no half-swapped level or seam), and showing is cheap (commit
   ≤ 10.5–18.7 ms) while making is what cost 80–131 ms. A batch that fits the frame's rest still shows in its own task.
   vitest: a level swap made one draw a step changes nothing drawn until its commit.
2. **No level 0 at speed** (`voxel/stream-detail.ts`, `stream-reads.ts` `holdDetail`, `stream-lod.ts` `setDetail`): past
   `STREAM_DETAIL_SPEED` (40 m/s) level 0 is held at once, let go after the speed stayed under it 1 s (the ring's
   `STREAM_WIDEN_AFTER_MS`; a placed camera is not travel, as before). Held: the level choice has no level-0 ring
   (level 1 drawn there; level 0 only as a stand-in next to a focus for a level-1 node not ready), level-0 derives go out
   only for chunks within the **collision ring's keep bounds of a focus** (stream focus + characters; the host gives its
   tier-scaled bounds) — the minimum collision kept, so bodies neither fall nor float (0 falls in every run); derive jobs
   still queued for chunks that left those bounds are cancelled and wanted again. Let go: the held sections derive
   nearest the focus first and level 0 returns by swaps. vitest (real workers, `stream-speed.test.ts`): 0 level-0
   derives sent past the collision ring held, stand-ins within 80 cells, level 0 back nearest first.
3. **Stale work**, measured (Play low 150, `play2-low-150.json` against 46d.24a's): flight section derives 281,240 →
   156,965 (115,112 of them air answered without a job), derive checks 134,713 → 31,034, pool jobs done 66,845 → 54,623,
   queue mean / peak 105 / 256 → 18 / 159, cancelled loads 813 → 265, queued derives cancelled 583; loads unchanged
   (54,028, 42,778 air: an air chunk is an index read and costs no worker, its derive no apron cells). The cancel landed
   with step 2 (it is what makes derives stale); mip and far jobs were already cancelled when their node leaves. Step 3's
   commit only reports the pool's cancelled counts (Play diagnostics); no further mechanism was worth building.
   Play low 150 after: longest 95.9 ms (674.8), 0 > 100 (3), detail 5.35 s (5.7), pending 9.4 s (10.2), sim idle 9.8 s.

| export, per step (1 round) | baseline (46d.24a) | (1) staged swaps | (2) no level 0 at speed |
|---|---|---|---|
| low 150: longest / > 100 / missed a min | 152–208 / 2 / 20–23 | 86.1 / 0 / 11.0 | 68.9 / 0 / 1.8 |
| low 150: ground / detail / pending (s) | 0.01 / 4.3–4.4 / 7.8–8.2 | 0.01 / 5.6 / 8.5 | 0.03 / 4.3 / 8.3 |
| medium 60: longest / > 100 / missed a min | 108–162 / 1–2 / 45–46 | 75.8 / 0 / 32.2 | 56.0 / 0 / 14.6 |
| medium 60: ground / detail / pending (s) | 0.01 / 9.5–11.8 / 14.5–15.1 | 0.01 / 11.1 / 15.3 | 0.10 / 12.1 / 14.2 |

| export, after (2 rounds) | longest ms | > 100 | missed / min | ground solid | body free / stands | full detail | nothing pending | falls | hole frames |
|---|---|---|---|---|---|---|---|---|---|
| low 60 | 62.6–67.6 (86–99) | 0, 0 | 4.8, 4.0 (14, 11) | 0.06 (0.01) | 0.13 / 0.43–0.61 | 3.8–4.5 (3.6–4.4) | 7.3–7.8 (8.2–8.5) | 0 of 83 | 0, 0 |
| low 150 | 48.8–51.6 (152–208) | 0, 0 (2, 2) | 1.8, 3.7 (20, 23) | 0.07–0.10 (0.01) | 0.12–0.18 / 0.34–0.36 | 4.1 (4.3–4.4) | 7.4–8.1 (7.8–8.2) | 0 of 34 | 0, 0 |
| medium 60 | 54.7–75.7 (108–162) | 0, 0 (1, 2) | 18.7, 20.5 (46, 45) | 0.08 (0.01) | 0.19–0.25 / 0.35–0.68 | 10.5–11.3 (9.5–11.8) | 13.9–14.8 (14.5–15.1) | 0 of 83 | 5, 2 |
| medium 150 | 57.8–66.0 (53–57) | 0, 0 | 27.4, 32.0 (21, 29) | 0.33–0.71 (0.48–0.53) | 0.94–1.01 / 1.08–1.49 | 13.1–14.9 (13.6–15.4) | 15.6–16.0 (16.0–17.3) | 0 of 34 | 2, 4 |

Baseline in brackets. No frame over 100 ms in any run; batches made over 2–19 frames (13–57 a run), the longest commit
10.5–18.7 ms, the longest single step 11–22 ms (one chunk's pieces). Settle: full detail on low 3.8–4.5 s (target < 2 s
still missed: the refill's derives, not the page), nothing pending a little better; medium unchanged within noise.
Ground solid got later at low (0.01 → 0.06–0.10 s, under the 0.5 s target; D615). Holes are the old places only (m ≈ 4,434
corner artefact, m ≈ 6,833 35-px frames, now 2–4 frames there). Medium 150's missed frames did not move (GPU-bound there).

**Looked at** (`work/46d.24b/strip-export-{low,medium}-150-{flight,stop}.png`, `strip-export-low-150-early-d611.png`, every
frame opened, beside 46d.24a's). Flight: the same poses, no sky hole; t30 the massif's dark blocky cliff, medium t64 the
black corner wedge, as before. Stop, low: the coarse stand-in to 2 s, the detail in at 4 s in the lower half (as before);
46d.24a's grey square at 1 s is gone, the flat grey patch at 15 s is still there (D613). Medium: coarse to 4 s, detail
from 8 s. Early low strip (12 frames, 0.25–3 s): no dark sliver at the bottom edge (D611 not reproduced).
*Unverified:* motion at full rate (stills), medium/high on their hardware, WebGL 2 (not run), a body moving at speed.

**46d.24c: collision on its own path, the coarse floor, D615, D585** (f0eadb60, 92eee6f7, 14a6552d, 56da399b, 12024562,
197c7bfa, and the near-deep shading commit; export `voxel-slice@r803` for the final table, Iris Xe, WebGPU, at the cap,
alone on the host, 2 rounds 01:45–02:07 UTC 2026-11-12, uptime 19.4 d, load 3.0–6.5; `work/46d.24c/{c1,c2,fin,h1,h2,h3}-*.json`,
`*.uptime`). Medium frame times **unverified on target hardware**.

1. **Collision on its own path** (`voxel/stream-collision.ts`, `derived-data.ts` `deriveCollision`, job `parts:
   collision`). A collision-only derive runs the same evaluation and code as the full derive and skips the base
   surface, pieces, relief, light, navigation, occupancy and shader data; its `collision` and `ground` are the full
   derive's byte for byte, per section and joined (`joinCollisionParts`; vitest on the town with a kit, hills, the hard
   cases). Cost (derive bench, world rules, 16³ sections, no kit): 1.36–1.55 ms a chunk against 1.94–2.51 ms. It is asked
   for in the pool's edit lane for resident chunks within the collision ring's add bounds of a collision focus that have
   never had their full result: the characters, points ahead of each along its velocity (`collisionLeadPoints`, 0.5 s,
   spaced by the ring's radius, none under 2 m/s or over 600 m/s), and the camera only while it is not fast. A result is
   kept while it is of the chunk as it is now (`fresh`, the sections' stamps) and handed to the full result once that is
   current (`chunkCurrent`): the same surface, so a body does not pop (vitest, real workers: 190–217 hand-overs, 0 differ).
   At speed no streaming level-0 derive goes out any more (24b kept them in the collision ring; vitest: 0 full level-0
   derives while fast, collision jobs only round the body and ahead of it, 278–285 for chunks only ahead). Derived data:
   no format moves (`DERIVED_FORMAT_VERSION` 31 unchanged; the collision part is a job output, never stored; the job
   contract gains a `parts` value, add-only).
2. **The coarse floor** (`voxel/far-ground.ts`, `runtime/voxel-floor.ts`). Where a collision focus's chunk column has no
   fine collision, a heightfield of the far cache's level-2 ground (a `far-ground` worker job decodes a node column's
   nodes into each 2 m column's top; a corner is the highest top of the four cells round it, so the floor lies on or above
   the coarse ground and neighbouring columns share their corners) is a static body. A body over a floor counts as on
   collision unless it is 2 m or more under the floor's lowest point (a cave under the top). Hand-over: the floor goes when
   its column settles; a character on a higher floor drops onto the fine ground (vitest: 5 cm; at the bench's stop 1.5–2 m),
   one the fine ground holds inside it is lifted onto it in the same step (raycast down 4 m, `riseAt`). vitest (real
   workers, real Rapier, level-2 nodes from the engine's mip code): with every chunk read held, a dropped body rests on the
   floor, moves 89.5 m at 60 m/s over floors alone never under the fine ground by more than a coarse cell, and ends on the
   fine ground after the hand-over, never thrown up. Bench: dropped bodies at speed end on the floor (66 of 83 at low 60,
   46 at medium 60, 21–27 of 34 at 150), not suspended (24b: 12–31 a flight hung suspended). Fine collision under a body
   dropped at speed seldom settles within its 2 s (1 a run); after the stop it does (bodyEnd on fine ground every run).
3. **D615 and the settle.** Loads leave a quarter of the pool's queue to derives (`STREAM_DERIVE_RESERVE_SHARE`: a refill's
   decodes filled it and the stopped camera's ground waited behind them), collision-only derives go first, derives resume
   as soon as the focus is not fast and level 0 comes back 200 ms after a stop (`STREAM_STOPPED_MS`; a dip keeps the 1 s
   hold). Ground solid 0.02–0.05 s everywhere (24b 0.06–0.71; vitest: ground known after 64–69 of the refill's ~9,000
   jobs). **Full detail did not get faster; it got later** (D620): low 4.6–5.6 s (24b 3.8–4.5), medium 13.4–16.7 s
   (10.5–14.9). Per step (one round each, low 150 / medium 60): collision path + reserve 5.55 / 12.7 s, + floor 4.89 /
   12.8, final 5.2–5.6 / 13.4: the change came with the first step, where nothing round the camera is derived at speed any
   more (24b derived its collision ring at 150 m/s, which the stop then found done) and loads have three quarters of the
   queue. Which of the two costs what was not split (an A/B is the next measurement); what bounds the level-0 ring after a
   stop is its outer edge waiting for level-1 neighbours, which wait for the 192 m load ring's downsample (46d.25's
   question). The < 2 s starting target is not reachable with the mesh rings on this host; proposed: keep it as the
   target for 46d.25 (fine bricks need no level-1 downsample) and report the mesh rings' 4.6–5.6 s (default chosen, owner
   to confirm).
4. **D585.** A ray whose first sample in a far node lies inside the solid with the eye inside the node's box is not hit
   until it leaves that solid; one that never leaves is drawn where it began as the ground's look from above (baked colour,
   unoccluded, facing up). Letting every ray that entered a box side under the surface through first showed the sky where
   hills stood (21–208 hole frames a 30 m flight against 0–4; restricted, 0–4 again). The hugging flights' face rays all
   enter a neighbouring node from outside (`eyeNode` 0 of 92–259): a hit deep in the solid within 64 m of the eye
   (`FAR_INSIDE_LOOK_M`) is drawn as the ground's look too, farther ones keep the step's face shading. 15-ray check, hug,
   share of polls with face rays: 60 m/s 20 % before (114 of 562), 19 % after (106 of 568); 150 m/s 19 % / 23 % (the
   geometry does not change: the coarse stand-in still lies above the true ground near the eye; what changes is how it is
   drawn). Looked at (`work/46d.24c/hug-{60,150}-before-after.png`): no grey grid with dark recesses in either set at the
   strip's times; after, flat ground-coloured squares show at the bottom edge where a coarse step lies near the eye (t18 at
   150 m/s: a brown and a green square). D585 stays open: the step itself goes with refinement near the eye or 46d.25's
   fine bricks.
5. **D611**: not reproduced (the final rounds' t64 at medium: a step at the near field's edge in the bottom-right, green,
   no wedge). Left open as a watch.
6. **D613**: the grey areas at 15 s are textured near rock (the stone set's pattern shows, drawnEnd `textured`, texture
   tops at level 0), darker than the far palette's colour for the same material: a far look vs near texture difference,
   not residency (`work/46d.24c/fin1-hole-build/shots/export-low-150-high-fin-r1-after15.png`). The far palette taking
   each set's mean albedo would join them (not built). A 16 m darker patch at the level-0 ring's edge stays untraced.
7. **Pinned regions and path hints: planned, not built** (neither is a small change on the one-second lead). Design:
   - `ctx.voxels.world(name).pin(region, { id? })` → a pin id; `unpin(id)`; `pins()` lists them with their state
     (`reading`, `ready`, bytes). A pinned region (a box, or a polyline with a half-width: a track corridor) is read,
     derived (level 0 or a level the game names) and kept: its chunks are never unloaded or evicted while pinned and
     their bytes count in the stream budget like any chunk (a pin that cannot fit is refused with the bytes it needs,
     no count cap). Built in the pool's far lane, nearest the stream focus first, so a loading screen can wait for
     `ready` (`whenResident` already answers per region).
   - `ctx.voxels.world(name).hint(points, { seconds? })`: "the focus will be along here": the read plan's lead segment
     becomes the hint's polyline from the focus (reads and the collision path's lead points along it), dropped when the
     focus leaves it or after `seconds`.
   - Where: `voxel/stream-reads.ts` (`StreamReadPlan`: the lead from a hint instead of the velocity; pinned chunks never
     `pastUnload`), `voxel-streamer.ts` (`enforceBudget` skips pinned chunks; a pin's byte reckoning), runtime
     `voxel-world-host.ts` + `voxel-api.ts` (the API, its refusals), docs and the reference. Cost estimate: a pin 300–400
     lines with tests, a hint ~150; 2,500 chunks for a 5 km × 64 m corridor fit low's 768 MiB stream budget (24b's
     measure: 11–69 KB derived a chunk) at level 1, not all at level 0.

| export, final (2 rounds) | longest ms | > 100 | missed / min | ground solid | body free / stands | full detail | nothing pending | falls (never stood) | drops' end: suspended / floor / fine | hole frames |
|---|---|---|---|---|---|---|---|---|---|---|
| low 60 | 49.5–50.9 (62.6–67.6; 85.5–98.8) | 0, 0 | 1.5–2.2 (4.0–4.8; 11–14) | 0.02–0.03 (0.06) | 0.07–0.08 / 0.24–0.25 | 4.6 (3.8–4.5) | 8.3–8.5 (7.3–7.8) | 3 (2) of 83 | 1 / 66 / 1 | 0, 1 |
| low 150 | 40.8–51.8 (48.8–51.6; 152–208) | 0, 0 | 0–2.7 (1.8–3.7; 20–23) | 0.03 (0.07–0.10) | 0.07–0.08 / 0.25–0.26 | 5.2–5.6 (4.1) | 8.9–9.5 (7.4–8.1) | 1–2 (1) of 34 | 1 / 27 / 1 | 0, 0 |
| medium 60 | 35.5–41.0 (54.7–75.7; 108–162) | 0, 0 | 11.0–11.3 (18.7–20.5; 45–46) | 0.03–0.04 (0.08) | 0.01 / 0.52–0.53 | 13.4 (10.5–11.3) | 17.6–18.0 (13.9–14.8) | 7–10 (5) of 83 | 1 / 46 / 1 | 3, 4 |
| medium 150 | 37.5–51.8 (57.8–66.0; 53–57) | 0, 0 | 16.5–28.4 (27.4–32.0; 21–29) | 0.02–0.05 (0.33–0.71) | 0.07–0.10 / 0.53–0.57 | 16.6–16.7 (13.1–14.9) | 20.5–20.6 (15.6–16.0) | 1–3 (1) of 34 | 1 / 21–22 / 1 | 3, 1 |
| starting target (low) | < 100 | | | < 0.5 | | < 2 | < 10 | never | | |

46d.24b in brackets, then the 46d.24a baseline. Falls: the bench's old count (6 m under the 2 m ground, neither suspended
nor standing) now catches bodies that used to hang suspended: those that stood later in the drop were onto ground the
2 m cells did not show (a reading's drop counter ahead of the body's position, or a cliff's foot); "never stood" are the
same drops each run at the massif's cliffs (m ≈ 4.5 km), ~6 m under within 1 s and ~30 m by the drop's end (D619:
untraced, off a cliff's edge or through; the probe records no x, z). Hole frames are the old places. The hugging flights
in the export show 123–129 hole frames at m ≈ 4,760 at 24b's code too (D617). Looked at: the final strips
(`work/46d.24c/shots/export-{low,medium}-150-high-fin-r1-strip-*.png`, the 15 s full-size frames) and the hug montages;
flight frames as 24b's (no sky hole, the massif's dark cliff at t30); after the stop the coarse stand-in to 2–4 s, detail
from 4–8 s, the grey near rock as in D613. *Unverified:* motion at full rate (stills), medium/high on their hardware,
WebGL 2 (not run), the lift at the hand-over in a game (the vitest's floor lay within 5 cm, so no lift happened there).


**46d.24d: D619 traced and fixed, D620 split and fixed at 60 m/s, D618** (60f4c9ca, 72f2cee5; export `voxel-slice@r860` for
the final table, Iris Xe, WebGPU, at the cap, alone on the host, 2 rounds 04:21–04:46 UTC 2026-11-12, uptime 19.5 d, load
2.3–4.4; traces `work/46d.24d/{t1,t2}-*.json`, A/B `ab-*`, `cd-*`, final `fin-*`, `sum2.py`, `*.uptime`). Medium frame times
**unverified on target hardware**.

1. **D619: through, not off an edge.** The probe now records the body's x, z and the first collider under it and over it
   (`flight-camera.ts`), and the bench judges each fall by the true ground (the world's voxels, `fineGround`) at the body's
   own place (`travel.ts` `judgeFall`). Before the fix (low 60, `t1`): drops 38 and 39 were placed at x = −2,000 (a chunk
   column's edge on the massif) 2.5 m over the 2 m ground but already 1.7 m **under the coarse floor** (floor 874.3, body
   872.6, true ground 870.4): no collider under them, not suspended (a floor counted for anything above its lowest point
   less 2 m), so they fell through the world (sideways 0 m, the floor over them all the way). Drop 41 stood on a steep floor
   cell, slid 5 m and a floor came over it with nothing under it. Cause: the floor's corners take the highest coarse top
   round them, so at a cliff's foot (or a street under rooftops) it stands metres over the true ground. Fix
   (`runtime/voxel-floor.ts`): a floor holds a body only over its surface at the body's place (the heightfield's own
   triangle, `FLOOR_UNDER_M` 0.5 m) or where fine collision lies right under it (a ray, 4.5 m); otherwise it waits
   (suspended) for its fine collision. vitest (`collision-ready.test.ts`, real workers, real Rapier, a 20 m cliff world
   `cliffWorld`): a body on the steepest floor rests or slides, never under the fine ground; one placed under a floor 19.7 m
   over the cliff's foot waits all 2 s, then ends on the fine ground at the hand-over (−0.27 m); before the fix it fell
   through. Bench after: through the true ground 0 in every run (low 60/150, medium 60/150, 3 + 8 runs); "onto lower ground"
   0–4 a flight (stood or slid on real ground lower than the drop point's cells). The one drop a run that ends suspended is
   at the town (m ≈ 2.43 km, x 32.7, z −5.4): the floor lies 3.2 m up at the rooftops' corners over the street; it waits
   for fine collision, which at speed does not come within its 2 s (as before the fix: the old rule's 2 m cave margin).
   With the fix more drops wait instead of falling: 2 / 5 / 10–11 a flight end suspended (low 150 / low 60 / medium 60;
   D621). While suspended the probe reads the body's last physics result, so a waiting drop may show the previous drop's place.
2. **D618: by design.** Traced in `stream-speed.test.ts` after the 150 m/s stop: every chunk with a full rebuild asked and
   not sent is at the load ring's edge: a neighbour loaded, its sections were wanted again, then blocked on another neighbour
   outside the ring (never read, or past unload). Not pending (`pending()` skips them), no work, its old result drawn; a
   neighbour's landing wants it again. Won't fix.
3. **D620: the A/B** (one round each, export, seconds after the stop to full detail / nothing pending; ground solid
   0.02–0.04 s in all):

| variant | low 150 | medium 60 | flight |
|---|---|---|---|
| base (60f4c9ca) | 5.67 / 8.97 | 13.79 / 18.08 | as 24c |
| A: loads take the whole queue (24b) | 4.73 / 8.57 | 12.54 / 16.31 | as base |
| B: level-0 derives in the camera's collision bounds at speed (24b) | 5.46 / 8.76 | 12.54 / 17.88 | medium missed 17.6 a min (11.7) |
| C: the reserve only while a body's collision-only derives wait (kept) | 4.72 / 8.49 | 11.69 / 15.41 | as base |
| D: C + B | 5.06 / 8.34 | 11.10 / 15.88 | medium missed 20.5 a min (8.0) |

   The reserve was the larger part: with it held back always, the stop's refill decoded at three quarters of the queue and
   the level-0 ring waits for the chunks round it to load. Ground solid did not need it (collision-only derives already go
   first: A kept 0.02–0.03 s). Kept C (`voxel-streamer.ts` `loadRoom`, `stream-collision.ts` `look`/`waiting`); B was left
   out (no gain at low, medium's missed frames doubled). vitest (real workers, a 64-job queue, the load replies held until
   it fills): with no ground waiting the refill's loads fill the whole queue (68 = 64 + 4 running; the fixed reserve held
   them to 52); with a body's ground waiting 18; the stopped ground still known after 69 of 9,136 jobs.

| export, final (2 rounds) | longest ms | > 100 | missed / min | ground solid | body free / stands | full detail | nothing pending | through (old count) | drops' end: suspended / floor / fine | hole frames |
|---|---|---|---|---|---|---|---|---|---|---|
| low 60 | 48.3–48.8 (49.5–50.9; 62.6–67.6) | 0, 0 | 1.5–2.6 (1.5–2.2; 4.0–4.8) | 0.03 (0.02–0.03; 0.06) | 0.06–0.07 / 0.25 | **3.55–3.86** (4.6; 3.8–4.5; 3.6–4.4) | **7.18–7.59** (8.3–8.5; 7.3–7.8; 8.2–8.5) | 0 (1) of 83 | 5 / 66 / 1 | 0, 0 |
| low 150 | 40.4–44.0 (40.8–51.8; 48.8–51.6) | 0, 0 | 0–1.8 (0–2.7; 1.8–3.7) | 0.03 (0.03; 0.07–0.10) | 0.07–0.08 / 0.26 | **4.65–4.76** (5.2–5.6; 4.1; 4.3–4.4) | **8.40–8.56** (8.9–9.5; 7.4–8.1; 7.8–8.2) | 0 (0) of 34 | 2 / 27 / 1 | 0, 0 |
| medium 60 | 36.1–43.1 (35.5–41.0; 54.7–75.7) | 0, 0 | 9.1–11.7 (11.0–11.3; 18.7–20.5) | 0.03–0.06 (0.03–0.04; 0.08) | 0.07 / 0.08–0.53 | **10.2–12.0** (13.4; 10.5–11.3; 9.5–11.8) | **15.0–15.8** (17.6–18.0; 13.9–14.8; 14.5–15.1) | 0 (1–2) of 83 | 10–11 / 46 / 1 | 1, 2 |
| medium 150 | 34.5–46.4 (37.5–51.8; 57.8–66.0) | 0, 0 | 20.1–22.0 (16.5–28.4; 27.4–32.0) | 0.02–0.05 (0.02–0.05; 0.33–0.71) | 0.12–0.15 / 0.28–0.57 | **16.0–17.1** (16.6–16.7; 13.1–14.9; 13.6–15.4) | **18.0–18.4** (20.5–20.6; 15.6–16.0; 16.0–17.3) | 0 (0) of 34 | 2 / 21–22 / 1 | 2, 5 |
| starting target (low) | < 100 | | | < 0.5 | | < 2 | < 10 | never | | |

   46d.24c in brackets, then 46d.24b (and for the settle 46d.24a). "Through" is the bench's new count (under the true ground
   at the body's place, or ending a drop falling with nothing under it); the old count (6 m under the drop point's 2 m
   ground) in brackets catches drops onto lower real ground. Holes are the old places only (m ≈ 4,434 corner artefact,
   m ≈ 6,834 35-px frames). Against the targets (low): longest frame met (40–49 ms), ground solid met (0.03 s), nothing
   pending met (7.2–8.6 s), never through met; full detail missed (3.6–4.8 s for < 2 s). At 60 m/s the settle is back to
   24b's or better at both tiers; at 150 m/s low is 0.6 s and medium ~2 s later than 24b (D620 stays open there).

   **What bounds the settle now** (each count's own settle, `settleBy`): the level-1 count (and the chunk count with it)
   settles last in every run, and nothing pending equals it (low 7.2–8.6 s, medium 15–18.4 s); level 0 settles before it
   (low 3.6–4.8 s, medium 10–17 s), level 2 and the kit pieces at once (the stop pose has no pieces), the far field at once
   except medium 150 (8.8–11.2 s: still refining after the stop, the only cell where far counts move). So the refill of the
   load ring that widens back after the stop bounds it: level 0's edge waits for level-1 neighbours downsampled from it,
   and at 150 m/s the ring was narrower, so more is read and decoded after the stop. 46d.25's fine bricks need no level-1
   downsample; that is where < 2 s can come from (46d.24c's proposal stands).

   **Looked at** (`work/46d.24d/strip-export-{low,medium}-150-stop.png`: 0.5, 1, 2 / 4, 8, 15 s after the stop, beside
   `work/46d.24b/strip-export-{low,medium}-150-stop.png`). Low: near detail shows at the bottom right already at 2 s (24b:
   still coarse), with a flat dark-grey square at the right edge at 2 s only; at 4 s 24b had more of the lower left in
   detail than this build (4.1 against 4.7 s); 8 and 15 s alike, the grey patch at the top centre at 15 s as before (D613).
   Medium: coarse to 8 s, detail at 15 s (24b: detail at 8 s), and a flat dark-green rectangle at the bottom centre at 1, 2
   and 4 s, gone by 8 s (D622). *Unverified:* motion at full rate (stills), medium on its hardware, WebGL 2 (not run), a
   body walking under a floor in a game (the vitest covers a placed one).

*Gates* (added at the 46d-c review, M4(c); 46d.24a–d recorded none here). 24a–24b: gate-fast-20261111-212018 and
-215805 GREEN, closing area gate-area-20261111-224210 GREEN. 24c: gate-fast-20261111-231718 GREEN;
gate-fast-20261111-235325 RED (vitest `far-world.test.ts` failed once and passed alone; e2e `cameras.e2e.ts:315` WebGL 2
0.4948 against > 0.5 twice, also in gate-rerun-20261112-000947: D616, passed alone at 793a7622 and 92eee6f7);
gate-fast-20261112-003928, -010053, -013227, -022455 GREEN; closing gate-area-20261112-023656 GREEN (one test failed
once, passed alone). 24d: gate-fast-20261112-031050 GREEN; -035618 RED build (fixed before the next);
gate-fast-20261112-035904 RED vitest (`far-world.test.ts:634`, D599, and `stream-speed.test.ts` failed under load, passed
in gate-rerun-20261112-041455 GREEN); closing gate-area-20261112-044727 GREEN.

### 46d.25 fine bricks from GPU compute

**46d.25a design** (the brief's §4 points, settled; the render spec's §4 *Fine bricks* is the format view).

- *Input.* Not the near surface's 34³ × 2-byte grid (material and wetness only: the fill-aware surface of 46d.13c-2
  needs each cell's fill level, and the look vote needs each shown cell's word): a fine node's **cell block**, the
  block the CPU build reads (`gatherFarCells`): level 0 its chunk's cells and an apron of 4 (40³), level 1 its eight
  chunks' cells at scale 2 and an apron of 7 (78³). Decoded on the world's thread from the streamer's resident chunks
  (`exportChunk` through the run-time overlay: no worker derive, no file read), packed 16 bits a cell (fill 4 bits,
  the word's place in the block's word list 12 bits): 128 KB (level 0) and 949 KB (level 1) a node on the wire,
  transferred with the batch. The page uploads it into one of `FINE_BUILD_SLOTS` (4) slot buffers (~4 MiB each),
  builds, and lets it go: nothing of a block is kept on the page or the GPU after its build. A shared GPU chunk pool
  (each chunk uploaded once, read by every node over it) would cut the wire ~2× for level 1; not built (measure
  first).
- *The build.* Five passes on the renderer's device (raw WGSL on `backend.device`, the pattern of the surface
  light's passes; the atlas textures through the hooks the region store already uses, no new private hook): (1–3)
  the corner field — the CPU build's exact distance to the solid and air spans, along y per corner line, then the
  separable x and z passes, each over a window of the band (`2S + 2` rows, `2S + 1` offsets): a nearer span or
  offset always lies inside it and a corner farther than the band stores the band either way, so the narrow band is
  exact, not a search approximation, at ~5–12 M simple operations a level-1 node instead of the brute force's ~70 M;
  (4) a workgroup a brick: the CPU build's stored / outside / inside rule and the hit bounds; (5) a workgroup a stored
  brick: the distance bytes, each sample's look by the CPU build's vote and weights (tops first), its far palette
  colour and its occlusion from its own bytes (`farBrickOcclusionAt`), staged in 256-byte rows that
  `copyBufferToTexture` puts straight into the brick's two atlas regions. The brick list and the staged distances are
  read back (`mapAsync`, 1–2 frames) for the regions, the node's page, its box (culled-table row) and the CPU's inside
  test; the march and the one shade read the atlas unchanged. *Exact vs approximate against the CPU build of the
  same block:* the stored-brick set, bounds and distances exact up to float rounding (the windowed passes mirrored in
  64-bit floats with the CPU build's 32-bit stores give its bytes exactly: vitest; the GPU's 32-bit `sqrt` and byte
  rounding land one byte off at the rounding ties that part-full fills (k/15) make, measured in the browser check);
  looks exact where a sample's footprint shows at most 8 words, and a sample with no shown cell in reach takes the
  look of the brick's nearest earlier sample (the CPU carries it across bricks); occlusion within a byte or so (32-bit).
- *The level 1 → 2 boundary.* Level 2 stays the far cache's (built from the level-2 mip, doors and windows closed at
  levels ≥ 1, the mip's opening rule of 46d.7a), level 1 is built from the chunks' own cells (openings kept): the same lip and
  skirt rule as any level change (the brick on the node face hangs its skirt), and the doors show at level 1 and not
  at level 2 by design. Whether the boundary shows: first look below.
- *Selection.* The far tree's own (`FarFineIndex` under the kept index): a kept level-2 node opens into the level-1
  nodes over its chunks, a level-1 node into its chunks, by the screen error with hysteresis, the far GPU budget
  (a fine node foreseen at `FAR_FINE_GPU_FORESEEN_BYTES`, ~58 KB) and the visibility feedback as every level, only
  where every chunk the children's blocks read is resident and the near field does not draw the node whole. At low
  (8 px, 623.5 px/rad) that is level 0 to ~78 m and level 1 to ~156 m; medium (4 px) level 0 to ~156 m, level 1 only
  where the 192 m load ring still holds a whole level-2 node's chunks. The near detail ring covers by the near cover
  as before (fine nodes under its hidden chunks are not drawn; its edge ring puts them behind the near field).
- *Edits.* A changed chunk (an editor command's refresh, a run-time dig, a save restored, the overlay cleared) makes
  every fine node whose block reads it (`farFineDirty`: up to 27 level-0, 8 level-1) again from the edited cells, sent
  in the next commit and built on the page; its old bricks draw until then. Levels 2+ keep 46d.18's path (the
  backend's rebuild; D594 for run-time edits).
- *The load ring.* Unchanged (192 m on every tier): fine bricks read the voxels out to where they draw. What goes with
  the switch on: the near field's levels 1–2 (their downsample, derive, seams and draws: no mip node is drawn and
  only the one holding the focus stays derived, the level choice draws the level-0 ring only, ending at its ring as
  where level 1 draws past it, not one level-1 node farther as a stand-in would). What it costs: the blocks' decode on the world's thread
  (`FAR_FINE_PACK_MS` 4 ms an update at most) and their GPU builds. Shrinking the ring toward the fine reach is the
  comparison slice's.
- *Budgets.* Fine bricks are far bricks: they count in the far GPU budget (`FAR_GPU_BUDGET_BYTES_BY_TIER`, 384 MiB
  every tier) through the selection and the ledger; no count cap. The build's constants are its package's
  (three-adapter `FINE_BUILD_SLOTS`, `FINE_BUILD_CELLS_PER_FRAME` 1 M cells of blocks started a frame, at least one;
  voxel `FAR_FINE_*`); a far event carries at most `FAR_FINE_COMMIT_BYTES` (8 MiB) of blocks, the coarse levels keep
  `FAR_COMMIT_BYTES`.
- *Low tier, devices without WebGPU, WebGL 2.* Off by default everywhere. The switch is the world streamer's
  `fineBricks` (a world setting, defined once in `@thirdlight/voxel`), the page and bench override `?fineBricks=1`
  (the voxel world page, Play, exports), the page hook `setFar({ fine })`. WebGL 2 gets nothing new: the voxel world
  page asks for fine bricks only on WebGPU; a Play page that falls back with the flag draws nothing past the detail
  ring (one console warning). Not a quality-level field yet (a project-model change once the comparison keeps it).

**46d.25a built** (f4af93a3, 2d235b54): as designed above. `@thirdlight/voxel` `far-fine.ts` (block, packing, `FarFineIndex`,
dirty set), `far-fine-nodes.ts` (the far field's fine nodes: make, edits, reselect on residency and near-level changes),
`far-tree.ts` (`FarSelectIndex`, `openable`), `far-bricks-faces.ts` (`gatherFarCells` / `farBricksFromBlock` split
out, bytes unchanged), `stream-lod.ts` (`setNearOnly`), `voxel-streamer.ts` (`setFineBricks`, the fine host);
three-adapter `voxel-fine-bricks-wgsl.ts` (five passes), `voxel-fine-bricks.ts` (slots, budget, readback, atlas copies,
the CPU check), `voxel-far-mesh.ts` (far changes held until their fine nodes are built). Switch: `?fineBricks=1`
(voxel world page on WebGPU, Play, exports), `setFar({ fine })`, world setting `fineBricks`.

**Tested.** vitest `far-fine.test.ts` (6): the packed block is the CPU build's block and builds byte-equal bricks; the
windowed field passes mirrored in 64-bit floats with the CPU build's 32-bit stores give its corner bytes exactly (scale
1 and 2, terrain, scarp, house; >20 k corners); selection opens 2 → 1 → 0 by error only where resident and not drawn
whole by the near field; the dirty set; the far field sends fine blocks from a real store, again after an edit, and
closes back to level 2 when off. `page-view.test.ts` (+1). e2e `voxel-world.e2e.ts` (the page test, WebGPU): with
fine on the near field draws level 0 only, fine nodes are built and drawn (>90 % of the far nodes in that small
world), the GPU build against the CPU build of the same blocks (6 nodes: same bricks every time, distance bytes off by
one in 0–0.5 % of samples, colours equal, occlusion ±1), no background below the horizon, their pixels gone with the far
hidden, a dig 54 m out rebuilt (the far solid there ground → air, read back) and seen (>300 px), off: level 1 back.
That test 51–66 s in gates before → 53 s alone after (the gate's own figure in gate-fast-20261112-062359). Gates:
gate-fast-20261112-053043 red only on the then uncommitted e2e extension; gate-fast-20261112-062359 red on D599
(failed once, passed alone in the gate) and `project-items.e2e.ts` (D331/D410 watch), GREEN on rerun
gate-rerun-20261112-064525. WebGL 2 smoke passed in both (no new path there).

**First look** (staging, Iris Xe, Play in the editor, WebGPU 1280 × 720, the 8 km world, off vs on, one run each
06:47–07:05, load 1.1–4.3, uptime 19.6 d; `work/46d.25a/{low,medium}-shots-{off,on}.json`, `shots/<pose>-<q>-<tag>.png`,
`shots/side-by-side/<pose>-<q>-off-vs-on.png`, `compose.mts`; every picture opened). Medium frame times unverified on
target hardware.

| | near levels drawn (town-west) | far nodes / bricks | far GPU MiB | fine nodes L0 / L1, built, bricks | settle after the pose (s) | fine block read ms p50 / p95 |
|---|---|---|---|---|---|---|
| low off | 110 / 121 / 0 | 1,040 / 17,991 | 77–92 | — | 8.4–11.2 | — |
| low on | 83 / 0 / 0 | 1,163 / 21,244 | 92 | 100 / 39, 445–776, 11.3–16.3 k | 4.2–7.1 | 2.6 / 9.4–11 |
| medium off | 302 / 111 / 0 | 2,600 / 43,698 | 164–202 | — | 14.3–19.6 | — |
| medium on | 193 / 0 / 0 | 3,165 / 54,188 | 202–249 | 575 / 18, 1,740–2,474, 32–43 k | 12.9–21.3 | 2.3 / 11–13 |

Build cost: at most 4 blocks started a frame (the cell budget lets one level-1 block, 949 k cells, or a few level-0 ones),
the encode 0.1 ms a build on the page, a block's build in the atlas 17–88 ms after it arrives at low (p50), 50–960 ms at
medium while 1.7–2.5 k fill; the blocks' read on the world's thread 2–3 ms p50, 9–13 ms p95 a node. GPU ms a build not
resolved (timestamps are not usable at the cap; the meter was not run with builds held going: the comparison slice's).
Atlas: fine bricks add 11–16 k bricks at low (~40–60 MiB of atlas at 3.6 KiB a brick; far GPU 77–92 → 92 MiB, the atlas
growing in steps) and 32–43 k at medium (~110–150 MiB; far GPU 164–202 → 202–249 MiB), plus the build's slot buffers
16 MiB; under the 384 MiB budget at both. The orbit fill from a cold start did not settle by the bench's rule in either
mode (its key now holds the near counts, which move in an orbit); the settle after each pose is the fill measure here.

**Travel at speed, low 150 m/s, fine on** (export `voxel-slice@r874`, 1 round 07:10, `exp-low-150-fine.json`,
`travel/*after*.png`): longest frame 45.1 ms (46d.24d 40.4–44.0), 0 over 100 ms, 1.8 missed a minute; ground solid 0.03 s;
**full detail 3.86 s (4.65–4.76), nothing pending 3.89 s (8.40–8.56)**: level 0 settles last, the far field with it; no
level-1 refill (none is drawn); 0 falls, 0 hole frames. The < 2 s detail target is still missed, now by the level-0 ring
alone.

**Looked at.** *town-west (D593's back row), low:* off, the houses past the detail ring are the level-1 meshes, textured
(planks, plaster, window rows); on, they are fine bricks: every house keeps its block, gable and roof slope, the roof's
0.5–1 m steps visible as a serrated ridge, no blob anywhere, but flat far-palette colours: no texture, no window rows, no
kit pieces (fences, frames). So the hand-off at the detail ring is a texture
and detail line, not a silhouette change: textured houses with windows in front, flat-coloured clean blocks behind, the
ground's tiled grass turning to flat green there. Medium: the same with the line farther out. *near-valley / near-border:*
the same slopes and channel; on, the gravel bed past the ring is a flat grey patch where off showed its tiled stones, and
the grass slopes past ~70 m carry a fine regular dimple pattern (the fine field's 0.5–1 m cell steps lit), faint at medium.
*Level 1 → 2 boundary:* not seen as a line in these poses (the 2 m far bricks begin past 150 m on low's slopes, colours and
slopes continuous; no crack, no skirt visible). *Holes, cracks, z-fighting against the near cover:* none seen in these
stills. The orbit strips (`shots/strip*-<q>-<tag>.png`) were saved but not looked at frame by frame: shimmer and pop
unverified. *Stop strip (150 m/s):* blocky but complete
terraces at 0.5–4 s, detail in by 4 s. *Unverified:* motion and shimmer, medium/high on their hardware, an edit past the
ring in Play (vitest and the page e2e only), WebGL 2 with the switch (D624).

**For 46d.25b:** the texture line at the hand-off (the far palette's flat colour against the near's tiled sets: D613's
cause too) is the first thing to judge; then the headroom meter with builds going (GPU ms a build), medium's fill
(2.5 k fine nodes, latency to 1 s), 60 m/s and medium 150, the load ring shrunk toward the fine reach, memory.

**46d.25b-1 textured fine bricks** (5c970289, 5abc05c9; the lead saw 25a's ON pictures turn every house past the detail ring
into flat palette colour, worse than the mesh rings in the very band bricks would take over).

- *What a fine sample holds.* The GPU build keeps each sample's look word where a coarse brick keeps its baked palette
  colour: red the word's low byte, green the high, alpha the occlusion as before (`voxel-fine-bricks-wgsl.ts` pass 5).
  A fine block's words carry the near grid's construction bit (`SHADER_CONSTRUCTION_BIT`, bit 15, from the cell's
  role: `gatherFarCells(…, construction)`), so the word is the near surface's grid entry; the far cache's builds leave
  it out. **Memory: none.** A brick is 3.6 KiB either way; the build no longer holds the 256 KiB palette buffer.
- *The shade.* The march marks a fine node's hit (cells under 1.5 m) in the visibility texel (face code + 8). The one
  far shade, for those pixels only (a branch: coarse pixels read nothing new), loads the eight words round the hit,
  takes the two heaviest by the trilinear weights (the near blend's `addHeaviest`, moved to `voxel-surface-sets.ts` and
  shared), and calls `VoxelSurface.farSurface`: the near surface's `textureSetAt` on the two materials (construction on
  the grid's 4 m tiles with the wall/floor/ceiling set by the hit's normal, terrain on the 2 m tiles of the normal's
  largest axis, one read a map), `heightBlend`, `wetLook` (R111); its world point from the frame's camera and the far
  view's root (64 bits on the CPU each frame) plus the floating origin's grid phase (`gridPhases`; vitest: the same
  (U, V) in the tile as the chunk's at any origin). Mip level explicit: texels as wide as the pixel's footprint
  (distance × pixel angle ÷ the slant's cosine, at least ¼), so the reads may sit in the branch. The material blend
  is the near one's two-material height blend without its per-material blend width (samples are 0.5–1 m apart
  already). The colour fades to the two words' far colours (the palette's colour, read live from the table) between
  the far event's `fineFade` (`farFineFade`): ending where a level-2 cell is the error on screen, or three chunks
  short of the load ring (the middle of the band where level 2's near side lies); starting at half: 72–144 m at low
  and medium on the 8 km world. (First built with the band's worst case, five chunks: 56–112 m, which faded the town's
  back row still drawn by level 1; `town-west-low-backrow-off-on-on2.png`.) The direct march (`?farPass=direct`)
  draws fine hits in the palette's colour.
- *Tiers.* One program on every tier: albedo, normal and ORM (`fineTexture` `full`); `albedo` (albedo only) and `off`
  are there for comparisons (`?fineTexture=`; `setFar({ fineTextured })` at run time, no new program). Low did not
  need the albedo-only tier (below).
- *D623.* Colours and sets are read when shaded: a record's change reaches fine bricks without a rebuild (page e2e: a
  texture set added to the ground, 0 fine builds, detail 1.9 → 14.0–15.6 a pixel step). *D624.* The far view tells
  the page when a fine node arrives it cannot build (WebGL 2); the page sends `voxels.fine` off to the simulation
  (worker or page), which turns fine bricks off: the near field's levels 1–2 come back (WebGL 2 smoke: export with
  `?fineBricks=1` draws near levels [156, 20], the console says why once).
- *Dimples (25a, grass slopes past ~70 m).* The GPU build already has 46d.13c-2's fill-aware surface (part-full cells
  as heights, the normal over ±1 cell; mirrored and checked against the CPU build). In the new pictures the regular
  pattern on the far grass slope is in OFF's mesh rings as much as in ON (`near-border-low-off-vs-on2.png`); textured,
  it is no stronger than OFF. No new row.

**Measured** (staging, Iris Xe, Play 1280 × 720, WebGPU, the 8 km world, fine on; headroom meter 1 round a tier,
`--hide far,near --copies far`; before 07:19–07:25 at 25a's build, after 08:27–08:34; load 0.5–3.2, uptime 19.6 d;
`work/46d.25b1/meter/`). The far pass hidden (march + shade): **low 5.94 → 5.88 ms, medium 5.65 → 6.14 ms**; frame GPU
low 9.2 → 7.6–10.5 ms, medium 9.0–10.0 → 9.0–9.5. The texture reads are under the meter's resolution at low (±40 %),
medium +0.5 ms within it; medium unverified on target hardware. Low's room 0 → 176 ballast copies at the edge (the
before round missed at no load once and found no edge: host noise, not texturing). Page heap / GPU at the town: low
560 / 944 → 585 / 939 MiB, medium 760 / 1,345 → 718 / 1,389 MiB. Tests: vitest `far-fine.test.ts` (+2: construction
words, the fade), `voxel-surface.test.ts` (+1: the far shade's projection = the chunk's), `voxel-far-view.test.ts`
(the shade's reads: 7 at its top as before, 9 more only in the fine branch; the texel's fine flag);
`voxel-world.e2e.ts` page test (textured vs off, D623) 1.1 m → 1.0 m in the gate; WebGL 2 smoke (D624). Gates:
gate-fast-20261112-074841 red on the e2e's wrong colour-step bound (fixed: a set keeps the palette's mean) and
`project-items.e2e.ts` (D331/D410 watch), `surface-probes.test.ts` failed once, passed alone (D419 watch);
gate-fast-20261112-080731 GREEN (19 min).

**Looked at** (`work/46d.25b1/shots/side-by-side/<pose>-<q>-off-vs-on2.png`, `town-west-low-backrow-off-on-on2.png`,
`strip-low-on2-crop.png`; every picture opened). *town-west, low:* the walls past the detail ring now carry their
sets (stone courses, white plaster, plank boards on the brown houses) to ~100 m and fade after; the hand-off at the
ring is no longer a texture line (the walls continue textured); the ground's tiled grass continues past the ring.
**Still different from OFF:** the roofs are 0.5–1 m stepped slabs (each step lit and textured as tread and riser)
where OFF's level-1 meshes show smooth tile planes with rows (D625); no window rows, frames, fences (kit pieces end at
the detail ring by the owner's choice); the farthest back-row houses (level 1, past ~110 m) are rounded lumps in the
palette's colour; a dark square on a stone wall where OFF has a window. *Medium:* the back row is level 0, crisp and
textured (planks, stone, plaster), roofs stepped as at low. *near-valley:* the gravel bed past the ring is textured
stones (25a's flat grey patch is gone), fading to grey past ~140 m without a line; a thin dark dashed line across the
gravel at ~60–70 m (D626). *near-border:* grass and the gully textured as OFF; the gully's rock outcrops past the ring
are lumpy (D625). *Level 1 → 2:* no line seen in these poses (palette to palette). *Orbit strip (4 frames 0.25 s
apart):* no sparkle or crawl between frames in the back row; motion and TAAU shimmer otherwise unverified.

**For 46d.25b-2 (the comparison):** first D625 (roof steps: what the owner sees as the mesh rings' advantage), then
the full table (meter per pass with builds going, fill, 60/150 m/s both tiers, memory, the load ring shrunk).

**46d.25b-2 sloped roofs as the roof mesher's planes; D625, D626** (0548778d, aa0a7be8, 0815a6a6; the lead saw every roof
past the detail ring as 0.5–1 m stepped slabs with swollen edges and the farthest back-row houses as rounded lumps).

- *The trace.* A roof is stored as a one-cell stair (`town.ts`: one roof cell a column, one up a column), whose cells
  touch only along their edges; the near field draws it as a slab through the stair's outer corners (roof-mesher.ts).
  A field of the cells has no inside there: every corner touches air, so the surface rule puts the corners at 0 or
  +¼ cell and the solid is only a thin tube along each step's edge. Measured with the CPU build (byte-equal to the GPU's)
  against the roof mesher's own planes, vertical rays half a cell apart over the roof tests' five 45° and eight 1:2
  roofs (`tools/voxel-bench/roof-mesher.test.ts`, first run with the old rule): **level 0: 62–90 % of the rays passed
  through a 45° roof (11–39 % through a 1:2 one), the rest hit 0.35–0.57 m off the plane on average; level 1: 30–100 %
  passed through, 0.30–0.66 m off**; the hits' normals 20–165° off (p90). So the roof was the steps' edges and whatever lay under them, lit and textured by
  the steps' gradient: not the ±2-cell band, not the 8³ sampling, not level 1's spacing alone.
- *The fix: the roof mesher's planes in the fine field* (`far-bricks-roofs.ts`; render spec §4 *Sloped roofs*). A fine
  block reads its roofs as the near field does: a roof cell drawn whole with nothing solid above that the mesher's own
  reading (`roofReading`) lays as a slope is a plane cell (the highest of its column); the block carries a column table
  (u32 a column: the cell's height, its top at the column's four corners by the mesher's `roofTopAt`, now shared, and a
  1:2 bit). The plane cell leaves the cell field (fill 0, its word kept for the looks, a top in the vote); the roofs'
  distance at a corner over a roof column is the height off its plane times the slope's cosine (a trilinear read of a
  plane's corners is the plane), elsewhere the distance to the nearest roof column's span, over a slab two sample
  spacings deep, joined to the cell field by the least: in `farBricksFromBlock` and in the GPU's z pass alike (one rule,
  one source: the CPU oracle is the rule, the WGSL mirrors it). The texture follows the plane's normal on its own (the
  near surface's `textureSetAt` on the 45°/1:2 grid phases). Levels 2+ (the far cache, CPU) are unchanged.
- *After* (the same test, now its assertions): **level 0: 0 rays missed, 2–4 cm off on average (max 0.16 m at a 45°
  centre ridge cut between two samples), normals p50 2.4°, p90 3.0°; level 1: 0 missed, 4–11 cm (max 0.58 m: an odd
  ridge between 1 m samples is cut flat), p90 5.3°.** The bounds in the test: level 0 mean < 5 cm, max < 0.2 m, p90
  < 6°; level 1 mean < 15 cm, max < 0.6 m, p90 < 10° (the hit distance of 0.05 node cells, a ridge's cut, 8-bit samples).
- *Exact vs approximate now.* Unchanged for cells (distance bytes ±1 at ties, looks within 8 words, occlusion ±1-2); the
  roofs' distance is the same function on both sides in 64 vs 32 bits. Browser check (page e2e, a 45° gable laid at run
  time 54 m out): the two fine nodes over it built on the GPU and the CPU agree: same bricks, distance bytes off by one
  in 0.4–2 % of samples (never more), looks 0.2–0.6 % apart, occlusion ±2; the far solid under the plane over a stair
  cell reads inside (it was air), over the plane outside. What is approximate against the near mesher: the far slab is
  two sample spacings deep (1 m at level 0, 2 m at level 1) where the mesher's is one cell, so an eave's underside sits
  lower (seen only from under an eave); a supported roof closes onto its walls by that depth instead of the kit's
  wall-top rule; a second plane cell lower in a column keeps its cells; damage by the engine's stages (no kit table).
- *D626* (the dashed line across the gravel 60–70 m out). Traced by pictures (`work/46d.25b2/d626-tint.png`): it is in
  the far draw (there with the near field hidden, gone with the far hidden) and on fine pixels (a scratch build tinted
  them green). Rays entering a fine node's side under its surface, where a level-1 neighbour lies a cell or so lower than
  level 0, were shaded as the side's face past `FAR_INSIDE_LOOK_M` (64 m): dark dashes. Fixed: on fine nodes a hit more
  than `FAR_FINE_DEEP_CELLS` (½ cell) under takes the ground's look at any distance (coarse nodes keep 46d.13c-4's
  rule). One 2–3 px dot is left (`d626-after.png`).
- *Cost.* Per node: the block grows by the column table only where a roof is (n² × 4 bytes: 6.4 KB level 0, 24 KB level
  1, against 128 / 949 KB of cells); the far event's fine bytes at the town 155.8 → 164.9 MB low (385 nodes vs 370
  sent), 573.8 → 541.8 MB medium (1,660 vs 1,724); one more storage buffer a build slot (24 KiB, 4 slots); the same five
  passes, the z pass reading 6 × 6 (level 0) or 10 × 10 (level 1) roof columns a corner when the block has roofs. The
  block's read on the world's thread (it now also reads the roofs' cells three past the block): p50 3.2 → 4.1 ms low,
  2.3 → 3.3 medium, p95 10.9 → 14.4 and 13.5 → 19.1 (one Play run each; the 4 ms an update budget holds the frame).
  **Atlas / far GPU at town-west: low 92.1 → 92.1 MiB (21,016 → 21,064 bricks), medium 202.5 → 202.5 MiB (54,188 →
  54,255)**: the planes store about the bricks the stairs did.
- *Measured* (staging, Iris Xe, Play 1280 × 720, WebGPU, the 8 km world, fine on; uptime 19.7 d). Headroom meter, far
  pass hidden (`work/46d.25b2/meter/`): **low 5.88 → 8.04 ms (10:17, load 3.4–4.8; the near pass in the same round
  2.33 → 3.91) and 5.39 ms in a second round (10:24, load 1.5); medium 6.14 → 6.34 ms** (one round, load 1.4–3.0;
  unverified on target hardware): within the meter's ±40 %, no change shown. Low 150 m/s travel in an export
  (`voxel-slice@r919`, one round, `exp-low-150-fine.json`; 25a's in brackets): longest frame 43.2 ms (45.1), 0 over
  100 ms, 0.9 missed a minute (1.8); ground solid 0.03 s; full detail 2.65 s (3.86); nothing pending 4.56 s (3.89, the
  far nodes last); 0 falls, 0 hole frames. Nothing regressed beyond one round's spread. Page e2e (`voxel-world.e2e.ts`
  page test with the roof check) 1.0 m in both gates (1.0–1.1 m before). Gates: gate-fast-20261112-091027 GREEN;
  gate-fast-20261112-095223 GREEN (`far-world.test.ts` failed once, passed alone: D599 watch).
- *Looked at* (`work/46d.25b2/shots/side-by-side/<pose>-<q>-off-vs-on.png`, `town-west-<q>-backrow-off-on.png`,
  `town-street-<q>-off-vs-on.png`, `town-street-low-far-crop.png`, `strip-low-on-crop.png`; every picture opened).
  *town-west, low:* every roof drawn by fine bricks is a straight tiled plane with a clean ridge and eave, at the
  hand-off and in the middle rows; the stepped slabs are gone. **Still different from OFF:** the back row's farthest
  houses (left and right, past ~110 m) are still rounded red lumps: a scratch build that tinted fine pixels green
  (`shots/town-west-low-tint.png`) shows them **not fine at all but level 2**, the far cache's 2 m bricks, so D593's
  look where level 2 begins (D627); no ridge or eave kit pieces, window frames or fences past the ring (owner's choice);
  roof colours flatten past the fade (72–144 m). *town-west, medium:* the back row is fine bricks out to its end: roofs,
  gables, ridges and eaves read as OFF's; the ridges a little softer, kit pieces absent. *town-street* (a new pose: eye
  ~7 m in a street at the town's south edge, roofs from 10 to 120 m): near roofs identical (near field); down the street
  at low the roofs past ~78 m (level 1 by distance; not tinted) keep their planes but their verges and eaves are thick and rounded (the slab is
  2 m deep at level 1 and its edges are rounded by the 1 m samples) and a few dark specks lie on one roof face (not
  traced); medium is close to OFF there. *near-valley:* the dashed line is gone (one 2–3 px dot left); gravel textured
  as before. *near-border:* grass and channel as OFF; **the gully's rock outcrops past the ring are still rounded lumps**
  where OFF's terrain mesher draws crisp facets (D628: the fine field is the cells', not the terrain rules'). *Orbit
  strip (low, 4 frames 0.25 s apart):* the roofs hold their planes frame to frame; no crawl or sparkle seen; motion
  otherwise unverified. *Travel stop (after 0.5–4 s):* complete, blocky terrain filling in; a dark slope at the right
  edge, not traced (no roof there; its texture set in shadow, as far as one frame tells).

**For the comparison slice:** first D627 (at low the town's back row is level 2 because a level-2 node opens into fine
children only with all its chunks and one round them resident in the 192 m ring: the fine reach is short of the error's
156 m at the ring's corners; options in §9), then low's level-1 roof edges (thick, rounded: the slab's depth; a
thinner slab at level 1 with the top kept, or level 0 farther for construction), D628 (rocks: the terrain mesher's
rules in the field, as roofs now are), then the full table as planned.

**46d.25b-3 D627 counted and fixed; the comparison** (0b02327e; staging, Iris Xe, Play 1280 × 720, WebGPU, the 8 km
world; `work/46d.25b3/`).

- *D627 counted* (`d627-count.mjs`: the selection's rule against the 192 m ring at town-west, the eye 12 m off the
  square 20 m up; the stream budget never binds there, so in-ring chunks are resident after the fill). A level-2 node
  opened into fine children only with its 4 × 4 × 4 chunks and one round them resident: 6 chunk columns a side, whose
  far corner lies ~1.4 node widths past its near face. **No level-2 node whose near face lies past ~96 m opened, at
  either tier**: low's 8 px error wants level 2 open to 156 m (64 nodes there), 36 refused (8 at 96–128 m, 28 at
  128–160 m); medium's 4 px to 312 m (180), 148 refused. Every missing chunk was past the ring horizontally (2,376 at
  low), none vertically; not the far GPU budget (92 of 384 MiB), not the near field, not the threshold. Whole nodes to
  the error's reach would need a ~277 m ring at low (~2.1× the chunks), ~433 m at medium.
- *The fix (option a, the cheapest generic rule).* A level-2 node the ring ends across opens into the level-1 children
  whose blocks are resident (a level-1 child reads its 2 × 2 × 2 chunks and one round them) and stays drawn over the
  rest (`FarFineIndex.partial`, `FarSelectIndex.partial`): its cost is its children's, it is not taken out. The page
  leaves its bricks in the octants that drawn fine nodes cover out of its brick table (`farFineOctants`,
  `farBrickOctant`, `FarBrickAtlas.writePage`; a 256-byte page written again, in the same apply as the change), so
  the two never draw one place and no octant is left undrawn; the march passes masked bricks as air and the fine
  nodes' skirts close the octant faces as at any level change. At town-west low that opens 40 of the 64 children in
  the 96–128 m nodes and 56 of 224 in the 128–160 m ones. Fine nodes drawn at the pose: low 96 / 32 → 176 / 100 (levels
  0 / 1), far GPU 92 → 111 MiB; medium 575 / 18 → 747 / 27, 202 → 249 MiB. The fade's reach follows (level 2 now
  begins 1–3 chunks short of the ring, `FAR_FINE_REACH_CHUNKS` 3 → 2). The selection asks `openable` only of a node
  that wants to open and counts its refusals (`fine.refused`: resident, near, partial). Option (b), a wider ring, was
  not needed for the back row in view; the ring and the fine band stay one setting (the load ring), the band ending
  ~2 chunks inside it.
- *Looked at* (`shots/side-by-side/town-west-{low,medium}-backrow-count-vs-partial-{left,right}.png`, the old rule
  "count" above the new): low, the right back row's rounded red lumps with window holes are now gables with straight
  roof planes and ridges (1 m stair on the gable edges, a few dark specks on one roof); the far left's last house (past
  ~150 m) is still a lump (level 2: beyond the ring's reach). Medium: the same houses were already crisp and stay so.
  *Untraced:* why medium's back row was crisp before with the same refusals (the houses in that crop lie in nodes
  nearer than 96 m at medium's level-0 reach; not counted per house).
- *Low's level-1 eaves* (`town-street-low-count-vs-partial.png`): roofs past ~78 m down the street keep thick, rounded
  verges (D629, not fixed: a construction-weighted error would open level 0 to ~156 m for buildings; its cost to
  measure first). *D628* traced, left open (the terrain mesher's crease placement is a per-corner rule over the rule
  set's neighbourhood that 8-bit samples at the cell spacing cannot hold; not the roof planes' kind of change).
- *Tests.* vitest `far-fine.test.ts`: the old "kept closed" case is now the partial rule (a chunk away: the two
  level-2 nodes over it stay drawn, open into the children not reading it, the other two open whole; no fine node reads
  a missing chunk; no octant undrawn; the refusals counted), and the octant rules. Page e2e unchanged (1.0 m in the
  gate). Gate gate-fast-20261112-113346 GREEN (12 min).

**The comparison: pictures** (one build 0b02327e, OFF vs ON, Play on staging, WebGPU 1280 × 720, low at its 30 Hz
cap, medium at 60; 11:47–12:04, load 2.6–3.4, uptime 19.8 d; `shots.mjs`, `{low,medium}-shots-{off,on}.json`,
`shots/side-by-side/<pose>-<q>-off-vs-on.png` (full frames and a 2× centre crop, every one opened), orbit
`strip-low-on-backrow.png`, walk `walk-{low,medium}-on-strip.png` (a 4 m/s walk down the street, frames 1.5 s
apart)). Pixels over 60 apart, low / medium:

| pose | px > 60 low / med | low | medium |
|---|---|---|---|
| town-west (D593's back row, 92–192 m) | 5.45 / 2.97 % | **worse in detail**: silhouettes, gables and roof planes as OFF, but past ~78 m (level 1) no window rows, frames or fences (OFF's level-1 mesh keeps 0.5 m openings) and the walls softer; the last house far left past ~150 m still level 2 | same (fences and windows kept to ~156 m; roof edges a little smoother) |
| town-north | 3.15 / 2.33 % | **worse**: back-row roofs past ~100 m read as rounded slabs (thick eaves, D629), gable triangles gone | slightly worse: the same eaves, thinner |
| town-peak-4.5km | 5.20 / 3.18 % | back rows: rounder roofs, no windows past ~78 m (worse); nearer, ON's shot had kit pieces OFF's had not yet built (the settle rule) | same |
| town-street (new) | 0.42 / 0.35 % | same near; roofs past ~78 m thick-eaved (D629) | **worse**: the roofs 70–100 m down the street are rounded "pillows" with soft eaves where OFF's level-0/1 meshes are crisp |
| near-border | 0.30 / 0.11 % | **worse in the gully**: rock outcrops past the ring are rounded lumps (D628); grass same; black sky in both (D630) | as low |
| near-valley | 0.05 / 0.02 % | gravel same; **a short dark dashed line across the gravel ~60–70 m** (D626's look; the same with the old all-or-none rule: D631) | same |
| near-river | 0.03 / 0.02 % | same (gravel bed a little sharper far) | same |
| near-boulders | 2.99 / 2.45 % | **worse**: the far grass patch upper left carries thin dark streaks along the slope and a paler flat green (D631) | **worse**: a straight line across that patch and the same paler green (D631) |
| near-escarpment | 0.20 / 0.10 % | same | same |
| near-outcrop | 0.05 / 0.06 % | same or better: the far wall's ledge lattice (D572) is calmer | same |
| peak-to-town, peak-sight-5km, beyond-peak-to-town | ≤ 0.01 % | same (no fine band in view from the peaks' eye) | same |

*Hand-off at the detail ring:* the walls stay textured across it; what changes is kit pieces (owner's choice) and,
at low, windows and fences once level 1 takes over (~78 m). *Level 1 → 2:* not seen as a line in these poses (palette
colour both sides); at low the last back-row house past ~150 m is the boundary. *Finite-world edge:* not in view in
any pose. *Orbit (low ON, 4 frames 0.25 s):* roofs hold their planes, no crawl or sparkle. *Walk (12 frames 0.5 s, low
and medium ON):* no shimmer seen; a pop where a far roof enters the detail ring (rounded slab → the near mesh's gable),
the same kind of step OFF has at its level 1 → 0 change. Motion at full rate unverified (stills).

**The comparison: frame, fill, memory** (same build; staging 12:07–12:28, load 1.6–4.2; export `voxel-slice@r943`
12:29–12:39, staging stopped; `work/46d.25b3/meter/`, `mem/`). Headroom meter, town orbit 12 m out at 0.15 rad/s
(fine builds idle once filled), one round each, ms a pass by hiding it past the edge (±40 %, the meter's noise; a
negative figure is noise), frame GPU from the line (and from the edge):

| | near ms | far ms (march + shade) | shadows | post | frame GPU ms | room (ballast copies held) |
|---|---|---|---|---|---|---|
| low OFF (30 Hz) | 5.24 | 2.08 | 1.66 | 2.21 | 5.9 (8.2–10.3; line and edge disagree) | 176 |
| low ON | 1.55 | 4.76 | (−2.6) | 4.32 | 11.6 (9.5–11.5, agree) | 176 |
| medium OFF (60 Hz) | 0.91 | 2.60 | 0.45 | (−3.2) | 8.5 (8.0–8.5) | 64 |
| medium ON | 0.38 | 3.84 | (−0.1) | (−0.4) | 11.7 (11.2–11.7) | 40 |

Read: the near pass shrinks (no level-1/2 meshes: low 5.2 → 1.6 ms, medium 0.9 → 0.4) and the far pass grows (more
and finer bricks marched and textured: low 2.1 → 4.8, medium 2.6 → 3.8); the frame's GPU time rises ~3 ms at medium
(8.5 → 11.7) and its room falls from 64 to 40 copies (~3 ms at 0.13 ms a copy); low holds its 30 Hz cap with the same
room either way (176 copies). Medium figures **unverified on target hardware**. With the eye moving (60 m out at 0.25
rad/s, builds running) and GPU ms a fine build: see below. *Fill* (cold start of Play to the town-west pose settled:
page counts unchanged 4 s, no fine build pending, the far field's queue empty): low OFF 14.0 s, ON 13.1 s; medium OFF
22.0 s, ON 26.8 s (the meter's own fill on the orbit: low 6.5 → 11.6 s, medium 12.3 → 27.3 s; the export's at the
town, low: 4.5 → 8.3 s). ON fills slower where it has more to build (medium's 750 fine nodes through 4 build slots).
*Memory, low, export* (`export-memory`, the 4 GiB budget = page 1.5 + GPU 2.5): at the town page heap 302 → 269 MiB,
GPU (driver-resident) 564 → 610, far GPU 77 → 92, renderer RSS 1,301 → 1,249 (the simulation worker lives there),
whole browser PSS 1,557 → 1,500 MiB; after the 60 and 150 m/s flights GPU 582–595 → 610–622, heap 287–301 → 278–286;
back home GPU 636 → 666 MiB, far GPU 111 both. Page + GPU 866 → 879 MiB of 4,096: both well under. Flights in that
bench at 30 Hz: missed 8 → 3 (60 m/s), 21 → 4 (150 m/s), longest 61 → 54 ms. Play at the town-west pose: low far GPU
77 → 92 MiB (partial nodes at 111 MiB in the D627 shots), medium 164 → 249 MiB of the 384 MiB far budget.

**The comparison: travel** (coverage bench in the export `voxel-slice@r950`, same build, staging stopped, Iris Xe,
WebGPU, at the cap, 2 rounds interleaved OFF/ON 12:39–13:27, load 1.7–5.7, uptime 19.8 d; `work/46d.25b3/travel/`,
`sum2.py`). OFF is the mesh rings (46d.24d's last table: same order). Two rounds a cell, OFF → ON:

| | longest ms | > 100 | missed / min | ground solid s | full detail s | nothing pending s | through | hole frames |
|---|---|---|---|---|---|---|---|---|
| low 60 | 49.0–50.1 → 40.5–43.0 | 0 → 0 | 1.1–1.5 → 0–0.4 | 0.03 → 0.03 | 4.41–4.48 → **1.35–1.43** | 7.52–8.21 → 5.05–5.28 | 0 → 0 | 0 → 0 |
| low 150 | 41.7–43.6 → 44.8–47.0 | 0 → 0 | 0.9–3.7 → 1.8–4.6 | 0.03 → 0.04–0.11 | 4.57–4.61 → 5.66–6.42 | 7.52–8.02 → 5.89–6.97 | 0 → 0 | 0–1 → 0 |
| medium 60 | 39.2–48.9 → 34.1–39.8 | 0 → 0 | 12.1–12.4 → 20.5–23.0 | 0.03–0.08 → 0.03–0.12 | 12.0–12.9 → 19.6–21.7 | 16.4–16.7 → 19.6–21.7 | 0 → 0 | 2–4 → 2–3 |
| medium 150 | 33.9–42.2 → 30.4–37.7 | 0 → 0 | 23.8–31.1 → 9.1–11.0 | 0.08 → 0.09–0.10 | 18.2 → 26.3–26.7 | 19.2–19.4 → **not settled in 30 s** (far nodes) | 0 → 0 | 2–4 → 15–33 |

Per-count settle (`settleBy`): OFF ends on the level-1 count (the ring's downsample, 46d.24d) at every cell; ON has no
level 1 or 2 to wait for and ends on level 0 and the far (fine) nodes. **At low the < 2 s full-detail target is met at
60 m/s** (1.35–1.43 s; it was 3.6–4.8 s) and nothing pending comes 2–3 s sooner at both speeds; at 150 m/s low's level
0 comes ~1–2 s later (5.7–6.4 s against 4.6) and ground solid 0.04–0.11 s (still under 0.5). **Medium is worse with
ON**: level 0 settles 7–8 s later, missed frames at 60 m/s double (12 → 21–23 a minute), and after the 150 m/s stop the
fine nodes are still building 30 s on, with 15–33 hole frames (the known places m ≈ 4,434 and 6,834 with more frames,
and once a new place at m ≈ 6,491, 10 frames): D632. Never fell through, either way. *Unverified:* medium on its own
hardware.

**The comparison: what the load ring costs** (a scratch vitest at real boundaries, not kept: the real streamer, 4
`worker_threads` workers, region files on disk, a 1.5 km hilly world, the 192 m ring, a 60 m/s flight of 368 m then a
stop; OFF = the mesh rings, ON = the near field as fine bricks leave it (`setNearOnly`, mip rings of radius 0, the read
ring unchanged); `work/46d.25b3/loadring/result.txt`, 13:25, load 3.7–4.0). Jobs in the flight and its settle:

| | loads | section derives | mip (downsample) jobs | seam jobs | queue max | world thread ms a s | fill s | settle after stop s |
|---|---|---|---|---|---|---|---|---|
| OFF | 877 | 3,370 | 1,750 | 1,108 | 54 | 128 | 16.0 | 5.6 |
| ON | 877 | 3,059 | 1,688 | 0 | 39 | 121 | 9.4 | 5.0 |

The reads are the same (fine bricks need the voxels to 192 m); ON drops every seam job and 9 % of the derives (the
mip nodes' derive), **but the run-time downsample still runs for the whole ring** (1,688 of 1,750 mip jobs: the mip
rings of radius 0 stop a node's derive, not its cells' downsample, `stream-mips.ts`): today's ON does not yet save
what retiring the rings would (D633). In Play the fine blocks' reads on the world's thread add 2.6–4.1 ms p50 a node
within the 4 ms an update budget (46d.25a/b-2). Shrinking the worker-derived reach to the detail ring is then: derives
(already, with ON) and the downsample (not yet); the read ring stays.

**What retirement would remove** (inventory by grep and `wc -l`, nothing removed): files only for the level-1/2 rings:
`stream-mips.ts` 959, `stream-seams.ts` 569, `lod-seam.ts` 545, `lod-select.ts` 265, `stream-lod.ts` 241,
`mip-derive.ts` 138 (2,717 lines in `@thirdlight/voxel`), bench tools `lod-seams.ts` 935, `mips-cli.ts` 209,
`seams-cli.ts` 95, `lod-checks.ts` 61 (1,300); about 600 lines mixed into shared files (`chunk-batch.ts` ~130 levels
and seams wire, `voxel-chunk-view.ts` ~130 node and seam draws, `voxel-streamer.ts` ~70, `stream-sections.ts` ~60,
`stream-handlers.ts` ~40, `stream-job.ts` ~35, `stream-ring.ts` ~35 (`DEFAULT_MIP_LEVELS`, `mipRingsFor`,
`MIP_RING_HYSTERESIS_CELLS`), the `level1` world setting ~15, others); tests ~1,300 lines outright
(`stream-levels.test.ts` 714, `lod-select.test.ts`, the mip/seam parts of `derived.test.ts`, `mesh-cases.test.ts`,
`voxel-chunk-view.test.ts`) and ~460 in part, the page e2e's level/seam checks (~25 lines). What stays either way:
`voxel-mips.ts` (the far tree's downsample and node keys), the derive's `level` parameter (the far meshes), the far
cache. Two caveats: with fine bricks on, `stream-lod.ts` / `lod-select.ts` still give the level-0 drawn set
(`nearDrawn`, the batch's level gate) and need a level-0-only replacement first; and **the WebGL 2 fallback (D624:
no compute, fine bricks off, the mesh rings back) runs all of it**.

**The comparison: with the eye moving, and the WebGL 2 question.** Headroom meter with the camera 60 m off the square
at 0.25 rad/s (15 m/s; fine nodes opening and closing all round), same build, 13:27–13:48, one round each:

| | near ms | far ms | frame GPU ms | room (copies) |
|---|---|---|---|---|
| low OFF / ON | 3.89 / 7.17 | 1.61 / 10.19 | 9.8 / 11.1 (edge 9.5–11.5 / 10.5–12.5) | 176 / 160 |
| medium OFF / ON | 2.40 / 1.39 | 3.29 / 6.77 | 11.0 / 11.0 (edge 9.9–10.4 / 14.0–14.3) | 52 / 18 |

With builds running the far pass grows by 3–5 ms over the still orbit (low 4.8 → 10.2, medium 3.8 → 6.8, both ±40 %),
which is the GPU's fine builds (up to 4 blocks, 1 M cells, a frame) plus the bricks they add: at most ~1–1.5 ms a
build, not isolated further (the meter cannot separate a build from what it draws; timestamps are not usable at the
cap). Low keeps its 30 Hz cap (room 160 copies); medium's room falls from 52 to 18 copies (~4.4 ms less) while moving,
**unverified on target hardware**.

*WebGL 2.* Fine bricks need WebGPU compute; WebGL 2 (and a device without it) turns them off and draws the mesh rings
(D624). Retiring the rings leaves WebGL 2 the level-0 ring and the far cache's level-2 bricks. Seen with a scratch build
where no fine node opens (`shots/side-by-side/town-west-low-gl2today-vs-gl2retired.png`, WebGL 2, low): every house
past the detail ring (~45 m at low) becomes a melted 2 m blob with holes for windows, where today's WebGL 2 draws them
crisp; 13 % of the pixels > 60 apart. That breaks the owner's rule that WebGL 2 keeps what it draws today. Options for
the owner: (1) keep the mesh rings as WebGL 2's path only (the ~4,600 lines stay, WebGPU never runs them, covered by
the WebGL 2 smoke); (2) the CPU fine-brick build in workers for WebGL 2 (`farBricksFromBlock` is the GPU build's oracle,
byte-equal; worker time instead of compute; the mesh rings could then go everywhere); (3) accept the blobs on WebGL 2.

**46d.25 comparison: the verdict** (for the lead and the owner; one page: `docs/briefs/fine-bricks-comparison-2026-11-12.md`).
Fine bricks hold at **low** for terrain and for travel: the same pictures on the realistic world's slopes, rivers and
cliffs, the town's back row now gables and roof planes (D627 fixed), full detail after a 60 m/s stop in 1.4 s (4.4 s
with the rings: the < 2 s target met), nothing pending 2–3 s sooner, fewer missed frames, the 30 Hz cap held with the
same room, memory +13 MiB of 4 GiB. They are **worse at low for construction past ~78 m** (no window rows, frames or
fences, thick rounded eaves: level 1's 1 m samples, D629), in the gully rocks (D628) and on one grass slope (D631);
and **worse at medium**: +3 ms GPU still, room 64 → 40 copies (52 → 18 moving), level 0 settling 7–8 s later after a
stop, after 150 m/s the fine nodes still building at 30 s, 15–33 hole frames (D632). The load ring's saving is not yet
what retiring the rings would give (D633: the downsample still runs). WebGL 2 would draw blobs past the detail ring if
the rings went (options above). **Recommendation (default chosen, owner to confirm): keep both behind the switch; retire
nothing now.** Next: D632 and D633, then construction at low (D629: level 0 farther for buildings), then this
comparison again with the same scripts (`work/46d.25b3/*.sh`); if low and medium then hold, retire the rings for WebGPU
and give WebGL 2 the CPU fine-brick build (option 2), which keeps one draw path.

### 46d.25c the switch's work, the detail ring, the streaks; D633, D632, D629, D631

(40c05fce, 6b3a04f0, 3503c1b9, d7320305; Iris Xe, WebGPU 1280 × 720, staging and export `voxel-slice@r969`, one round
a cell, 14:00–15:05, load 1.5–4.5, uptime 19.9 d; `work/46d.25c/`). The second full comparison was dropped by the lead
for 46d.26 (the owner's bake level, §2 2026-11-12): only the cells and poses these fixes touch were measured again.

- *D633 fixed (40c05fce).* Counted (25b-3): with the switch on the mip rings got radius 0, which stopped a node's
  derive but not its cells' downsample, and level 0 was still derived for every chunk of the 192 m read ring. Now
  near only (`setNearOnly`, called by `setFineBricks`) the coarser levels are dormant (`StreamMips.setDormant`: no node
  kept, downsampled or derived; waking rebuilds them from the resident chunks) and streaming level-0 derives go out
  only under a level-1 node within level 0's ring, its hysteresis and a chunk of a focus (`StreamDetail.setReach`,
  `StreamLod.inDetailReach`); the read ring is unchanged (fine nodes read the chunks). The 25b-3 flight again (real
  streamer, 4 workers, region files, a 1.5 km hilly world, 192 m ring, 368 m at 60 m/s; scratch, not kept,
  `work/46d.25c/loadring/`), same hour OFF → ON: loads 830 → 832, downsample jobs 1,455 → **0**, level-1/2 derives
  352 → 0, seams 944 → 0, level-0 derives 2,043 → 673, fill 11.5 → 2.0 s, settle after the stop 11.5 → 2.5 s, world
  thread 0.90 → 0.77 s over the run (25b-3's ON: 1,688 downsample jobs, 3,059 derives). vitest
  (`stream-levels.test.ts`, real workers): near only no downsample or level-1/2 job, every level-0 derive within the
  reach, no node kept; off again the levels come back equal to fresh derives.
- *The detail ring: a comparison error (6b3a04f0).* Near only, no coarser node is ready, so level 0 stood in for every
  level-1 node round the focus, with every ring pulled in by one level-1 node to end it at the ring: per chunk,
  inside the ring, where with every ring level 0 covers each whole level-1 node the ring splits. ON compared against
  a smaller detail ring: low town-west 83 level-0 chunks against OFF's 110 (25a's table). Now near only keeps the
  rings and lets nothing stand in (at speed what is derived still stands in by the focus): town-west low ON draws
  110 chunks, as OFF; vitest: the level-0 set near only equals OFF's split set (192 of 192). **Cost of being fair:**
  low 60 m/s full detail ON 5.86 s against OFF 4.80 s the same hour (25b-3's 1.35–1.43 s was the smaller ring: the
  last ~25 chunks of the full ring land 5–6 s after the stop); nothing pending ON 5.86 / OFF 9.22 s; low 150 ON
  6.38 s, 0 hole frames.
- *D632 traced (counted), not fixed.* The coverage bench now records the page's fine builds and its counts a second
  after the stop, and saves each hole event's worst frame (3503c1b9). Medium 150 m/s ON (export and Play): the page's
  fine build queue was empty (0 pending, 0 far changes held) in 28 of 30 one-second samples; fine builds 2,117 →
  2,573 over 30 s; **the simulation's worker pool queue stood full (253–256 of 256) from 2 s to 26 s after the stop**,
  with 5,982 loads (870 stored, 2,887 uniform, 2,225 air) and 13,084 section derives after it and the far field's
  coarse work 5,800 → 4,865 pending behind them. So medium's settle is bound by refilling the 192 m read ring that
  the fine nodes need resident (and level 0 waits in the same queue: 94 chunks from 8 to 18 s), not by the GPU build,
  its 4 slots, the block reads or their order: nearest-first and cancelling builds would not move it. The far side's
  "parent drawn until every opened child is built" already holds (checked in code: a far change is grouped by root
  and the page holds it whole until every fine build in it is in). That bound is what 46d.26's bake removes (the read
  ring shrinks). Holes at medium 150 ON: 19 frames (export), 69 (Play; a new place m ≈ 2,447 with 34 frames); the
  worst frame (`travel/shots/play-medium-150-high-playon-t1-hole-m2447.png`) shows **the ground band nearest the camera
  undrawn** while the coarser ground behind is drawn: at speed the near field draws only its stand-ins and the far
  field does not cover the band round the eye; untraced (D634).
- *D629.* The ring above was the comparison's part. The remaining construction loss past the level-0 fine reach
  (~78 m at low: window recesses, thick level-1 eaves) is not changed here: with baked level 0 the reach costs march
  time and atlas only, so it is set with the headroom meter in 46d.26. Window frames, fences, ridges and kit pieces
  end at the detail ring in both modes (owner's choice); OFF shows window *recesses* past it because its level-1 mesh
  keeps 0.5 m openings, not frames.
- *D631 mostly fixed (d7320305).* Traced by pictures (`shots/side-by-side/near-boulders-low-on-vs-notex.png`): with the
  fine textures off the streaks and the pale band are gone, so they are the texture read, not the field: the fine
  shade read terrain on the normal's largest axis only, and a fine field's normal (its gradient over 0.5–1 m) flips
  that axis from sample to sample on a slope near 45°. Terrain now blends the three axes as the near surface does:
  the streaks are down to two faint hairlines, the pale band gone (`near-boulders-low-off-vs-blend.png`); near-valley
  shows no dashed line (`near-valley-low-off-vs-blend.png`). Cost: 9 → 21 samples a fine pixel; low's meter (town
  orbit, one round) far pass 4.76 → 7.05 ms, frame GPU 11.6 → 10.1 ms (both within ±40 %), room 176 copies, the 30 Hz
  cap held. Medium not metered (unverified).
- *D628* left with its trace (the terrain mesher's creases are not a one-plane rule).
- *Looked at* (`work/46d.25c/shots/side-by-side/`, low OFF vs ON same build, every picture opened): town-west better
  than 25b-3 (the right-front houses now level 0 with window rows as OFF; past ~78 m the back rows still without
  windows and fences; px > 60: 5.45 → 4.46 %); town-north 3.15 → 2.98 % (back-row eaves still thick: D629); town-street
  0.42 → 0.34 % (same); near-boulders better (streaks mostly gone; the material split on that slope still differs from
  OFF's level-1 mesh); near-valley same as OFF. Medium town-west 2.97 → 2.21 %, town-street 0.35 → 0.70 % (not
  looked at closely; medium unverified on target hardware).
- *Tests and time.* vitest `stream-levels.test.ts` +1 (near only), `page-view.test.ts`, `voxel-far-view.test.ts` (the
  fine reads 9 → 21). No e2e change; the voxel area 173 → 147 s in the fast gates (gate-fast-20261112-141915, -150923, both GREEN); area gate voxel/rendering/play gate-area-20261112-152410 GREEN with the page test failing once on its fine-build look check and passing alone (D635 watch).
- *Verdict (unchanged): keep both behind the switch, retire nothing.* Low holds for terrain and travel by pictures and
  frame, but with the fair ring its 60 m/s settle is ~1 s behind OFF's and construction past ~78 m is still worse;
  medium does not hold (settle bound by the read ring's refill, D632; holes at speed, D634). Both open points are what
  46d.26 (baked fine levels, the read ring shrunk to the detail ring) is for.

### 46d.26 brick bake level per voxel world

**What a km² costs** (the owner's table; one page for the owner: `docs/briefs/bake-level-storage-2026-11-12.md`).
Disk is the far cache a world holds at that bake level (each level adds to the coarser ones); bake is one CPU thread
(the backend bakes on up to 4).

| a km² of | 2 m (today) | 1 m | 0.5 m |
|---|---|---|---|
| terrain: disk / bake | 5.4 MB / 0.9 min | 19.6 MB / 5.0 min | 71 MB / 12.1 min |
| town: disk / bake | 3.8 MB / 0.9 min | 10.6 MB / 4.7 min | 30 MB / 11.2 min |
| the 8 km world (67 km²): disk / bake on 4 threads | 355 MB / 24 min | 1.36 GB / ~1.6 h | 5.0 GB / ~3.7 h |

**Hard stop rule:** not triggered (0.5 m: 5.0 GB < ~8 GB, ~3.7 h < ~12 h on this host), so the format and the bake
are built (below).

**Storage, measured** (46d.26a, before any product change; `work/46d.26a/fine-size.mts`, a scratch bench: 8
`worker_threads`, a world region column of a level's nodes a task, the world's own region files read through
`FarWorldSource`; 15:39–15:44, load 0.7–7.8 with the bench itself, uptime 19.97 d). Each fine node is built by the
fine builder's CPU side exactly as the GPU build's oracle: `gatherFarCells(…, fine)` (construction words, roof
planes) → `farBricksFromBlock` → `farBrickOcclusion`, encoded by `encodeFarBricks` (`TLFB` v1), zstd 3 a node, region
files of the cache's own format (`writeRegion`, stacked, the level's node coordinates). Slices: **town** = world
region columns rx, rz −2…1 (1.05 km² round the origin; the town's own footprint is its middle 256 m, 0.066 km²,
counted apart), **terrain** = rx −6…−3, rz 2…5 (1.05 km²: the valley floor, slopes, a ridge to ~800 m; 7,405 stored
chunks, the world's mean for that area is 7,802, so it is a typical piece of this world).

| | nodes holding anything | all air / all solid (not stored) | no stored brick (not stored) | stored nodes | bricks a node | raw MB | **zstd MB (files)** | **MB a km²** | bytes a node | CPU s a km² (gather / build) |
|---|---|---|---|---|---|---|---|---|---|---|
| terrain, level 0 (0.5 m) | 68,201 | 56,439 | 699 | 11,063 | 16.2 | 526.9 | 54.0 | **51.5** | 4,886 | 423 (145 / 275) |
| terrain, level 1 (1 m) | 8,966 | 6,059 | 172 | 2,735 | 16.3 | 130.9 | 14.8 | **14.2** | 5,427 | 248 (96 / 151) |
| town footprint, level 0 | 1,253 | 512 | 0 | 741 | 18.9 | 41.2 | 1.29 | **19.7** | 1,745 | 389 (50 / 337) |
| town footprint, level 1 | 192 | 0 | 0 | 192 | 17.8 | 10.0 | 0.44 | **6.8** | 2,310 | 229 (40 / 189) |
| the town slice's terrain round it, level 0 / 1 | 22,774 / 3,200 | 13,493 / 850 | 755 / 207 | 8,526 / 2,143 | 16.0 / 15.9 | 400 / 100 | 22.8 / 7.0 | 23.2 / 7.2 | 2,677 / 3,288 | 275 / 160 |

Wall time: town slice 49 s a level (8 / 4 workers), terrain 77 s (level 0, 8 workers) and 83 s (level 1, 4: a level-1
region column is 512 m, so the slice is 4 tasks). The terrain round the town is the floodplain: flatter, and half its
nodes repeat byte for byte, so it is half the terrain slice's bytes.

*2 m today, per km², by the nodes' places* (`coarse.mts`: level-2 nodes and bricks in the slices, levels 3–8 at the
world's mean, 1.43 MB/km²): terrain 5.4 MB/km², town footprint 3.8; the whole cache 355 MB (5.3 MB/km²), baked in 1,421
s on staging (nodes ~690 s on one thread, bricks ~730 s on 4) = ~54 CPU s/km².

*The whole 8 km world, extrapolated* by the slice's bytes and CPU per stored chunk (the cost follows the surface: the
world has 499,313 stored chunks; by area alone it is within 5 %): **level 0: 3.65 GB, 8.3 CPU-h; level 1: 1.00 GB, 4.9
CPU-h.** So a 1 m bake is 355 MB + 1.00 GB = 1.36 GB, a 0.5 m bake 355 MB + 1.00 + 3.65 = 5.0 GB, beside the voxels'
644 MB; bake on 4 threads +1.2 h (1 m) and +3.3 h (0.5 m) over the 24 min of 2 m. (The town slice's own figures
extrapolate to 2.0 / 0.63 GB: a world of floodplain is cheaper.)

*The material word against the palette colour.* On disk nothing: a coarse baked node stores its look words too (the
colour is the page's palette bake, 46d.18), u16 a sample either way. The fine words' construction bit costs 2.5 % in
the town (1.261 → 1.293 MB at level 0), 0 on terrain. On the GPU nothing (a baked sample is RGBA8 either way, 46d.25b-1).

*Format wins, measured on the same nodes:*

| | terrain level 0 | terrain level 1 | town level 0 |
|---|---|---|---|
| all-air / all-solid nodes left out (in already: what the run-time build sends nothing for) | 83 % of the nodes | 68 % | 41 % |
| nodes with no stored brick left out (a 268-byte table each) | 699 nodes, 0.03 MB | 172, 0.007 MB | 0 |
| **occlusion not stored, made again on load** (`farBrickOcclusion`, the same function) | 54.0 → 29.3 MB (−46 %) | 14.8 → 9.0 (−39 %) | 1.29 → 0.79 (−39 %) |
| zstd 19 instead of 3 (an export's packing) | 54.0 → 43.4 MB (−20 %) | 14.8 → 12.6 (−15 %) | 1.29 → 0.71 (−45 %) |
| bricks that are another brick's copy (samples, words, occlusion) | 37 % | 37 % | 77 % |
| nodes that are another node's copy | 37 % | 37 % | 40 % |

The cost of not storing occlusion (`decode.mts`, the baked files read back): **decode 0.09–0.11 ms a node, the occlusion
made again 6.7–7.0 ms a node** (0.42 ms a brick), 70× the decode, on the thread that loads. Loading is the owner's
bottleneck (§2 2026-11-12), so occlusion stays stored (the blob's occlusion flag already lets a cache leave it out:
an owner's choice for disk, 5.0 → 2.9 GB for the 0.5 m world). Shared copies need a region file whose entries may share
bytes (a region format change): not taken now; the same sharing in the GPU atlas (37–77 % of fine bricks) is noted for
46d.26b's memory.

*Atlas memory a km² resident* (3,645 bytes a brick, `FAR_BRICK_GPU_BYTES`): terrain level 0 593 MiB/km², level 1 147;
town level 0 743, level 1 181. In view at low (the fine bands round the eye, every direction): level 0 from the detail
ring (~45 m) to 78 m 0.013 km² = 8 MiB, to 156 m 0.070 km² = 42 MiB (town 52); level 1 from 156 to 312 m 0.23 km² = 34
MiB (town 41). Within low's 384 MiB far budget with room (the coarse levels drew 77–92 MiB at the town, 46d.25c);
level 0 to 312 m would be 177–222 MiB.

**Design** (46d.26a; decisions with reasons, §9 "default chosen, owner to confirm").

- *The setting.* `voxelWorld.bakeLevel`: metres, `2` (the default, absent) | `1` | `0.5`, on the scene's voxel world
  component (the owner's "per scene"): validated (`field_value` for any other value), rebuilt field by field by the
  canonicalizer, set by the scene's component commands (the one mutation path; no new op), an Inspector field from the
  component's descriptor, in the generated reference for MCP. The values and the level they mean are defined once in
  `@thirdlight/voxel` (`FAR_BAKE_LEVELS_M`, `farBakeLevelOf`: 2 m → level 2, 1 m → 1, 0.5 m → 0). A world two scenes
  name is baked to the finer of the two (the cache is the world's; a coarser scene reads the finer cache it does not
  need, which costs disk, not frames). An export ships the levels down to the finest bake level its scenes ask, never
  finer levels the cache happens to hold.
- *The format: far cache format 3,* add-only (owner note in the render spec §4 *Fine levels baked*): `far.json` gains
  `fine`: the finest level baked toward (`bakeLevel`, 0 or 1), the blob version and build, the world revision its
  levels are current with, the region columns baked so far per level, and per fine level its region files, nodes and
  bytes. A fine level's nodes are stored in `B<level>/` (`B0/`, `B1/`) at the level's node coordinates: level 0's files
  tile the world exactly as its region files do (a node is a chunk), level 1's span 512 m, so fine bricks stream by
  region and an export ships them as files of the existing `B<level>/` names. A node is stored only where its block
  draws something (a stored brick); a missing node of a baked level is nothing to draw. Formats 1, 2 and 3 read; any
  other is refused. A format-2 cache stays current for a 2 m world (no rebuild: the coarse content is the same); a fine
  bake writes format 3.
- *One builder.* The bake runs the fine builder's CPU side, the GPU build's oracle: the block from the world's files as
  the streamer would read it (`gatherFarCells(…, fine)`: construction words, roof planes), packed and unpacked as the
  page's block is (`packFarFine` / `unpackFarFine`), `farBricksFromBlock`, `farBrickOcclusion`. So a baked node is
  byte for byte the CPU build of the same block, and within 46d.25a's rounding of the GPU's (distance bytes ±1 at the
  ties, occlusion ±1–2). A slower, more exact bake (more samples, the terrain mesher's creases for D628) was not
  chosen: an edited node is rebuilt by the run-time build next to baked neighbours, and two builders would seam there;
  D628, D629 and D631 are fixed in the one builder, so bake and run time stay equal.
- *The bake.* After the coarse cache is current, by world region column and level, level 1 first (a 1 m bake is the
  0.5 m bake's first half), in the backend's far cache worker on its bake threads (up to 4: cores − 1). A column's
  nodes are built from the world's files at a revision, then written (its region files and the manifest's done list)
  in the world's queue, so commands go on while a column builds and never see a half-written column. Resumable: an
  interrupted bake (the backend stopped) keeps every column it wrote and goes on from the next. A world whose bake is
  not finished draws as a 2 m world plus the regions baked so far: the editor keeps the compute fine bricks (WebGPU)
  where a level is not baked yet. Progress: columns done of the world's columns per level, in the far info answer
  (the editor can show it; no panel built in this slice). Edits: a command's changed chunks make exactly their fine
  nodes stale (`farFineDirty` at the baked levels, in baked columns), built again by the same builder in the same
  rebuild as the coarse levels, looked up first by a content key (the build and every chunk entry the block reads) in
  the cache's `rebuilt/` store (46d.18's, now also fine nodes), only their files rewritten. Changes made while a column
  builds are built into it when it lands. A coarse rebuild of the whole cache (another revision on disk) starts the
  fine bake again.
- *Run time (designed here, built in 46d.26b).* Levels at or above the bake level come from the cache: a baked fine
  node is decoded and uploaded (0.1 ms decode), never built; only levels finer than the bake are built by the compute
  build (WebGPU). On a world baked to the finest level drawn past the detail ring, the voxel read ring shrinks to what
  the detail ring (level 0's ring and its hysteresis) and collision need, plus a chunk (a fine block's apron); on a 1 m
  world it reaches only as far as level 0 is drawn by compute. Baked fine reads follow 46d.24's "no fine detail at
  speed" rule: past `STREAM_DETAIL_SPEED` no level-0 node is opened (its reads at 150 m/s would be ~2.4 MB/s of terrain
  at low's 156 m reach); level 1 opens as reads allow (~1.3 MB/s at 150 m/s to 312 m). Low's 0.5 m reach becomes a
  tier setting set with the headroom meter (D629: a lower error for the fine levels, or construction-weighted).
  WebGL 2 draws baked fine bricks too (the march needs no compute; the direct path shades fine hits in the palette's
  colour): on a world baked to 0.5 m it needs no mesh rings; on a 2 m world it keeps the mesh rings (the owner's call
  later, with pictures; nothing is deleted).
- *Memory.* Fine bricks count in the far GPU budget as now (see above: 8–42 MiB of level 0 and ~34 MiB of level 1 in view
  at low against 384 MiB). The read ring's shrink frees stream memory (low's 768 MiB budget held the 192 m ring);
  measured in 46d.26b.

**46d.26a built** (as designed above; render spec §4 *Fine levels baked*, format spec far cache 2 → 3, manual
`voxel-worlds.md`). `voxelWorld.bakeLevel` (project-model: type, validation, canonical copy, descriptor with a number
choice, `voxelWorldBakeLevel`; a number field may now list `values`, shown as a select as an int's is); `@thirdlight/voxel`
`far-fine-bake.ts` (`FAR_BAKE_LEVELS_M`, `farBakeLevelOf`, `bakeFarFineNode`), far cache format 3, a shipped world's
`far.bakeLevel`; `@thirdlight/workspace` `voxel-far-fine.ts` (column bake, write, pending, progress, edits through the
rebuilt store), `voxel-far-jobs.ts` (the jobs, `bakeFine`; the rebuild includes the fine nodes), `VoxelWorlds` (the
scenes' bake level, the background bake a column at a time written in the queue, far info `fine`, the export);
backend `far-cache-threads.ts` (one thread pool for the coarse bake and the fine one), the worker's `fine` jobs.

*Tested* (vitest, real region files and caches on disk): `voxel-far-fine.test.ts` (5: a 1 m world stores level 1 and a
0.5 m world levels 1 and 0, every stored node byte for byte the fine builder's bricks of the block read from a world
store as the streamer reads it, nothing else stored; a bake stopped after two columns goes on with only the rest and
ends file for file equal to one never stopped; a dig's answer builds exactly `farFineDirty`'s nodes (shared content
keys built once), only those entries change, the cache equals a fresh bake of the edited world, undo then the same dig
reuses every node; an export ships levels 0–1 at 0.5 m, level 1 only at 1 m, none at 2 m, and the catalog row checks;
a format-2 cache reads and is current at 2 m, format 4 refused), `far-cache-runner.test.ts` (+1: the backend's worker
threads bake the same files as this thread), `voxel-world.test.ts` (project-model: values, round trip, finest of the
scenes), descriptors (the field reached), the script access table re-pinned (an added optional field). Counts and
bytes only. Gates (a project-model change: every area): gate-fast-20261112-161546 red on the script access pin (re-pinned,
f5bccc30); gate-rerun-20261112-162630 (180 e2e files, 23 min, peak 7.5 GB) 317 passed, 3 failed, all outside the far
cache: `layered-material.e2e.ts` (D349 watch; passed in gate-rerun-20261112-165030), `block-layers.e2e.ts:490`
(failed again in the rerun under the gate's load, passed alone at this head and at the base 2bc9f009: D637 watch),
`scene-loads.e2e.ts:107` (fails alone at the base 2bc9f009 too: a hidden regression since 2026-11-10, D638, to fix
before the phase's full gate). voxel area 172 s in the wide run. Area gate voxel + content gate-area-20261112-165523
GREEN (33 passed, 4 min; voxel 148 s, content 229 s).

*The product bake on staging's 8 km world* (`work/46d.26a/stage-bake.mts`: `bakeFarFineColumn` on 8 worker threads,
`writeFarFineColumn` here, the two measured slices only, 16:10–16:13, load 2.2 → 8.2): 40 columns (8 at level 1, 32 at
level 0) in 198 s, 1,484 CPU s (the scratch bench's 1,172 without the chunk decode and holding checks); level 0 20,330
nodes, 78.2 MB, level 1 5,070, 22.3 MB: **the 89 region files are byte for byte the scratch bench's.** Staging's cache is
now format 3 with a partial `fine` record toward 0.5 m (those 40 columns of 1,280), its coarse levels unchanged; its
scene asks 2 m, so its backend bakes nothing more and its exports ship no fine level. Unverified: a bake of the whole
world (~3.7 h on 4 threads by the extrapolation), the bake's memory on the backend's 6 GB scope (a column holds its
chunks two node columns deep), the editor's Inspector select in a browser.

### 46d.26b the bake level at run time: baked fine levels read, the read ring shrunk; D638, D637, D636

**Step 0.** *D638* (`scene-loads.e2e.ts:107`, first frame 20 draws against 18): it fails alone at the 46d-c start
fda36fa8 too, so `git bisect` from the last pass (f317bedf) found **f50e6ab2** (upscaled levels draw TAAU whatever the
look's anti-aliasing). Counted per frame (a scratch log of each `render` call's draws): Play's first frame draws the
start scene exactly as every later frame (dynamic shadow 7, scene 15 with its post pass) plus two full-screen draws that
seed TAAU's history (three's `TAAU.seed` and a second resolve); from the second frame on 18. No frame drew less than the
scene: the test compared whole-frame draw counts, which count post-stack quads. Fixed in the test (57882976): it adds
the seed's two draws when Play's diagnostics say the frame upscales by TAAU. *D637* (`block-layers.e2e.ts:490`, the
export's WebGPU cut-away): at fda36fa8 in `gate.sh start area levels` (gate-area-20261112-170826) it failed the same way
(23 px left) and passed in the gate's rerun; later it failed alone about half the time at 57882976 and b07407ee alike
(1 of 2, 2 of 3). Not a 46d-c regression: watch kept. *D639* (new, watch): `sockets.e2e.ts:259` timed out twice beside
other e2e (its hierarchy row re-rendered for 4 min), passes alone at fda36fa8 and 57882976.

**Built** (b07407ee; render spec §4 *Fine levels baked*, *Read at run time*, *The bake in the editor*; manual
`voxel-worlds.md`). `@thirdlight/voxel`: `FarNodeSource.fineBaked` / `fineBakeLevel` (`regionFarSource` `fine` with the
columns baked; `shippedFarSource` the levels a catalog ships whole), `FarFineIndex` with its sources (baked children need
no chunk and hold something until read; built ones as before), `FarFineNodes.readBaked` / `built` (a run-time edit of a
baked node is built from the chunks while builds are on), the far field's baked fine reads through the coarse levels'
job path (`bakedReadOf`; a node a baked column does not hold draws nothing, no job), `refresh` reading edited baked fine
nodes again, the selection's `openWithin` and `FAR_FINE_HOLD_M_BY_TIER`, `farFineFade`'s hold, `FarFineHost.fast` (the
detail speed), `StreamReadReach` (`stream-read-reach.ts`) and `StreamLod.detailReadReach`, `fineLevelsChanged`;
three-adapter `bakeFineFarBrick` uploads (`FarBrickAtlas.add(…, 'words')`), fine nodes not recoloured, `fineBaked`
counts; project-model `levelVoxels.farFineHoldM` and the resolved `far.fineHoldM`; workspace `VoxelWorlds.scenesChanged`,
`fineBakeControl`, `VoxelFineBake.paused`; backend `POST …/voxels/:world/far/bake`, the mutation hook; editor
`VoxelBakeStatus` in the voxel world's Inspector section, the range world's `fine` levels, the page's hold.

*Tested.* vitest `far-fine.test.ts` +2 (a far field over baked levels 0–1 and no chunk resident: every fine node drawn is
the bake's bytes decoded by the worker's own handler, 0 blocks read, none built; none read or drawn past the detail
speed, back after; an edited node read again after `refresh` equals the new bake; the hold opens more level-0 nodes),
`stream-levels.test.ts` +1 (real streamer, 4 workers, region files, a 192 m ring: baked to 0.5 m it reads to the detail
reach, 1,608 resident chunks against 5,688, 218 loads against 406, no level above 0 built), `page-view.test.ts` and the
project-model pins (the hold). e2e: `voxel-world.e2e.ts` Play test extended (the bake level set by one command on the
128 m world, the Inspector shows it baking through to `1:4/4 0:4/4` in 5.2 s, a new Play at low draws 31 baked level-0
nodes with 0 built and 0 blocks read, the read ring 90 m of the 100 m set); `webgl2-smoke.e2e.ts` +1 check (baked to
0.5 m the voxel world page on WebGL 2 draws 148 baked level-0 nodes, nothing built). voxel-world.e2e.ts in the wide
gates 124 → 155 s (the Play test +17 s; the rest within the gate's spread). Gates: gate-fast-20261112-171753 (57882976,
every area: 3 failed: block-editor D452, start D453, sockets D639; rerun -175623 from a clean scratch worktree at
57882976: sockets again, the others passed, sockets alone passed); gate-fast-20261112-181650 (b07407ee, every area: red
on block-editor D452 and block-layers D637, rerun -185107 the same two; alone block-editor passes, block-layers fails
half the time at 57882976 too).

**Measured** (staging, Iris Xe, WebGPU 1280 × 720 at the tier's cap, Play on the 8 km world, one round, 19:05–20:17,
load 2.4–6.4, uptime 20.1 d; `work/46d.26b/`). The bench regions baked first (`bake/stage-bake.mts`, the product's column
bake on 8 threads): 39 columns, 323 s, +140 MB (staging's fine levels now 59 + 20 columns, 240 MB). A = mesh rings (2 m,
switch off), B = compute fine bricks (2 m, `?fineBricks=1`), C = baked to 0.5 m (scene `bakeLevel` 0.5, the bake
paused past the bench regions).

*Travel* (coverage bench in Play, the 9.8 km line ending in a baked region; detail = full detail after the stop, pending
= nothing pending; loads and derives after the stop; queue full = the worker pool's queue at ≥ 250 of 256):

| | longest ms | > 100 | missed/min | ground s | detail s | pending s | holes | loads / derives after stop | queue full s | fine read / built |
|---|---|---|---|---|---|---|---|---|---|---|
| low 60 A / B / C | 63 / 64 / **49** | 0 / 0 / 0 | 7.3 / 5.9 / **2.9** | 0.03 | 5.2 / 6.5 / **3.9** | 9.6 / 6.5 / **5.0** | 0 / 0 / 0 | 4,068 / 28,150; 4,146 / 6,582; **1,658 / 6,590** | 1.4–8.8 / 1.2–4.6 / 2.2–3.3 | 0 / 1,675 built / **938 read** |
| low 150 A / B / C | 54 / 65 / 57 | 0 / 0 / 0 | 20 / 24 / **9.1** | 0.03 / 0.08 / 0.03 | 5.3 / 7.2 / **5.0** | 10.7 / 7.9 / **6.4** | 0 / 1 / 0 | 4,034 / 28,961; 4,288 / 6,776; **1,949 / 6,847** | 2.5–10.1 / 3.4–7.1 / 2.2–3.3 | 0 / 1,724 / 938 |
| medium 60 A / B / C | 53 / 45 / **34** | 0 | 34 / 32 / **17** | 0.03–0.07 | 16.1 / 22.5 / **12.3** | 21.0 / not in 30 s / **14.6** | 2 / 2 / 3 | 5,396 / 38,719; 5,677 / 12,718; **2,855 / 12,859** | 1.3–19.9 / 1.7–23.4 / 2.5–11.3 | 0 / 3,827 / 1,023 |
| medium 150 A / B / C | 49 / 41 / **32** | 0 | 25 / 26 / **18** | 0.05–0.07 | 17.7 / 26.3 / **13.3** | not in 30 s (all three) | 20 / 41 / **11** | 5,363 / 36,873; 5,905 / 12,805; **2,833 / 12,784** | 0.5–29 / 1.2–26.4 / 0.4–11.6 | 0 / 2,243 / 1,031 |

Never fell through in any run. Read: baked C settles soonest in every cell; the < 2 s full-detail start target at low is
still missed (3.9 s at 60 m/s, 5.0 at 150: level 0's own derives, 6.6 k after the stop, are what is left). The loads after
a stop halve (the read ring: low 192 → 133 m reach) and the worker queue stands full 1 s instead of 7–28 s (D632's bound).
Cache reads: none in flight (the speed rule); after the stop ~940–1,030 fine nodes uploaded, × 4.3–5.1 KB a node ≈ 4–5 MB
over ~5 s, ≈ 1 MB/s (an estimate from uploads, not a byte count). Holes at medium 150: 11 frames (A 20, B 41), D634 not
gone. One round a cell: the spreads of 46d.25b-3 (±1 s settle) apply.

*Low's 0.5 m hold (D629), the headroom meter, town orbit 12 m at 0.15 rad/s, one round each:*

| low | far nodes | far MiB of 384 | far pass ms (hidden) | near ms | frame GPU ms | room (copies) | fill s | page heap + GPU MiB |
|---|---|---|---|---|---|---|---|---|
| A (mesh rings) | 1,037 | 77 | 3.3 | 1.0 | 7.4 | 3 (a miss at no load; not pursued) | 7.3 | 592 + 847 |
| C hold 110 m | 1,655 | 111 | 7.7 | 5.2 | 9.5 | 176 | 9.9 | 673 + 1,078 |
| **C hold 156 m (chosen)** | 1,933 | 134 | 6.4 | 0.6 | 7.7 | 128 | 8.4 | 629 + 1,048 |
| C hold 220 m | 2,626 | 165 | 6.9 | 0.8 | 7.8 | 128 | 13.9 | 720 + 1,193 |

All within the meter's ±40 % for pass times; low keeps its 30 Hz cap at every hold. Memory at the town in Play (low):
A 610 + 892, B 577 + 960, C 671 + 1,122 MiB (page heap + GPU of 4,096); medium C 905 + 1,821. Export memory not
measured (no export of a part-baked world; §9).

*Looked at* (`shots/side-by-side/<pose>-<q>-A-vs-C.png`, `town-west-low-A-vs-C-backrow.png`, `town-west-low-C110-vs-C220-
backrow.png`, `town-street-low-A-vs-B.png`, `town-west-low-gl2C.png`; every picture opened). *town-west low:* C the same
houses; the back row's roofs are straight planes with clean eaves where A's level-1 meshes show 0.5 m stair-stepped
eaves and ridges; A keeps sharper wall textures and a few more window dots on the farthest houses, C's back-row walls
softer; **about the same, slightly better silhouettes, slightly softer walls**. *town-north low:* C's back-row roofs are
smooth planes where A's are serrated: **better**; the wells past the ring pale grey rings in C (A darker water). *town-
street low:* near identical (near field) but **worse in one thing**: thin dark curved lines float just above two far
roof ridges (~80–100 m) in C and the same in B, never in A (D640). *near-boulders low:* the cliff lattice the same (near
field); the far grass slope is smoother in C but carries dark hairline streaks along it (D631's leftovers) where A has
blocky pixel patches: **mixed**. *near-valley:* same (0.02 % > 60). Medium: town-west/north/street as low with the line
farther out; near-boulders the same hairlines. *Hold 110 vs 220 m:* 220 thins the back-row eaves a little more; window
recesses in the farthest row show at neither (0.5 m openings at 150–200 m are under a pixel). *WebGL 2 (C, town-west):*
the town drawn whole with baked fine bricks in palette colours (pass `direct`): gables, roofs and back rows as on WebGPU,
flat colour past the ring, grass slopes with fine moiré banding; no blob. Motion unverified (stills).

*Not done here (26c):* the 13-pose comparison and the verdict page, a second round, medium/high on their hardware, an
export of a baked world (needs a whole bake: 5 GB).

Closing area gate of 26b: gate-area-20261112-205610 (voxel, rendering, play) GREEN.

### 46d.26c the final comparison: D640 fixed, D631 and D634 traced, A / B / C on both tiers, a baked export

(9bc95e2a, 70b59330, 1bfd05e1; staging, Iris Xe, WebGPU 1280 × 720 at the tier's cap, alone on the host, capped
scopes; `work/46d.26c/`, every `*.uptime` / `uptime-shots.txt` beside its run.) A = mesh rings (2 m world, `fineBricks`
off, today's default), B = compute fine bricks (2 m, `?fineBricks=1`, WebGPU only), C = baked 0.5 m (scene `bakeLevel`
0.5), C1 = baked 1 m with level 0 built by compute. Medium figures are **unverified on target hardware**.

**D640 traced and fixed (9bc95e2a).** Scratch builds that dropped one kind of far hit at a time (`d640-c3.png`: skirts,
the near cover's edge ring, the march's pixel tolerance; `d640-c4.png`: the edge ring per level) showed the curved
lines are far bricks in the near cover's **edge ring** (drawn chunks next to undrawn ones, where the far field draws
behind the near field to close gaps) and **only level 2**. A level-2 node the near field drew whole stayed closed, so
there the far cache's 2 m bricks drew, whose roofs are hollow 1 m stairs (D627 (c)), standing out past the near roofs'
silhouettes. The CPU field of the fine levels holds no shell there (`d640-scan.mts`: no column at levels 0 or 1 with a
hit over 1.5 cells above every filled cell or roof plane round it). Fix (`far-fine.ts`): fine nodes stay closed only
where the near cover **hides** the far field (the chunk and every chunk round it drawn, the cover's own erosion); a
level-2 node opens into its level-1 children the cover does not hide whole, a level-1 node into its chunks the cover
does not hide. vitest `far-fine.test.ts` (+1: near field over columns 0–6: every edge-ring chunk holding anything is
drawn at level 0, no fine node under the hidden part; at the old rule the edge chunks were level 2). Seen gone in C and
B (`d640-fix.png`). At town-west (the simulation's fine nodes drawn, levels 0 / 1): low 2,272 / 1,076 → 1,776 / 994 (children the cover hides are no longer opened), medium 2,488 / 116 → 2,400 / 116; far GPU at low 134 MiB both.

**D631 traced, left open.** The hairlines on near-boulders' far grass slope stay with the D640 fix
(`shots/side-by-side/near-boulders-low-oldC-vs-fixC.png`), with skirts dropped and without the march's pixel
tolerance (`d631-crop.png`, dotted then): they run along the slope's contours at the fine field's 0.5 m cell steps, lit
at a grazing angle. Not the builder's roof rule, so the bake stays as is (no re-bake).

**D634 traced (counted), left open.** The coverage bench keeps, per hole event, what the page drew at its worst frame
(70b59330). Medium 150 m/s, one round each (`travel/medium-150-{C,B}-d634*.json`): at every hole frame the near field
draws 0 chunks (at speed level 0 is held and nothing is derived round the camera), the near cover is empty (0 hidden,
0 edge chunks), no fine node is drawn: the missing ground is the far field's own coarse nodes near the eye, not a
cover or ordering rule between the two fields. Baked: only the known corner artefact (m ≈ 4,434, 4 frames); compute:
that and 8 frames at m ≈ 5,481; the band of 25c/26b did not come back in these two runs.

**Staging's bake for the poses.** The 26b bench regions plus 52 columns round near-border, near-river,
near-escarpment and near-outcrop (`bake/stage-bake.mts`, the product's column bake on 8 threads, 597 s, 4,491 CPU s):
staging's fine levels now B0 328 MB + B1 129 MB = 457 MB (240 MB before). The builder did not change, so nothing
was re-baked.

**Pictures** (one build, 9bc95e2a; Play, the 13 poses of 25b-3's `shots.mjs`, 21:58–22:29 UTC 2026-11-12, uptime
20.2 d, load 1.7–6.4; `shots/side-by-side/<pose>-<tier>-A-vs-C.png` (full frames and a 2× centre crop), `C-vs-B`,
`C-vs-C1`, `gl2A-vs-gl2C`, `gl2C-vs-gl2C1`, montages `medium-{town,near}-A-C.png`, `peaks-low-A-C.png`, orbit
`strip-low-C.png`, walk `walk-low-{C,A}-strip.png`). Every low pair and the medium town, near and boulder pairs were
opened; the medium peaks only by pixels (0.00 % > 60). Pixels > 60 apart A → C, low / medium:

| pose | px > 60 | C against the mesh rings (A), low | medium |
|---|---|---|---|
| town-west | 3.92 / 2.15 % | **better**: back-row roofs straight planes with clean verges where A's are 0.5 m serrated stairs; fences show as outlines past the ring; a few window dots darker | better (the same) |
| town-north | 2.68 / 2.13 % | **better**: smooth roof planes and eaves (A serrated); the wells' water paler | better |
| town-peak-4.5km | 3.48 / 2.53 % | **better**: clean roofs, fences past the ring; one white house's balcony a flat blob | same or better |
| town-street | 0.47 / 0.14 % | **slightly worse**: no lines any more (D640), but the roofs 70–100 m down the street have softer, rounder verges than A's | same |
| near-border | 0.31 / 0.26 % | **slightly worse**: the gully's rock outcrops rounder (D628); black sky in both (D630) | as low |
| near-valley | 0.03 / 0.06 % | **slightly worse**: a short thin dark line across the gravel ~60–70 m out (D626's look) | same |
| near-river | 0.03 / 0.01 % | **slightly worse**: faint regular dark dashes on the far river bed (~150 m); bed otherwise sharper | same |
| near-boulders | 4.54 / 1.89 % | **mixed**: the far slope's material blend smoother and more natural than A's flat pale patch, but dark contour hairlines on it (D631) | mixed, fewer hairlines |
| near-escarpment | 0.27 / 0.26 % | same | same |
| near-outcrop | 0.08 / 0.16 % | same or better (the far wall's lattice calmer) | same |
| peak-to-town, peak-sight-5km, beyond-peak-to-town | ≤ 0.01 % | same | same (pixels) |

*B (compute) against C* (`<pose>-low-C-vs-B.png`, ≤ 1.1 % > 60): the same except the town's back rows, which at low
B draws at level 1 past ~78 m (serrated verges, softer walls), where C holds level 0 to 156 m. *C1 against C*
(`<pose>-{low,medium}-C-vs-C1.png`, ≤ 1.2 % > 60): on WebGPU a 1 m bake with level 0 built by compute looks the same
as a 0.5 m bake (verges a hair more stepped at low). *WebGL 2, town-west low:* A draws the rings textured; C draws the
same houses past the ring as baked 0.5 m bricks in flat palette colour (clean shapes, no textures: walls flat brown or
white); C1 has no compute, so level 1 draws past ~78 m: roofs' colour bleeds onto rounded walls (worse than C). *Orbit
(8 frames 0.25 s apart) and walk (12 frames 0.5 s):* no shimmer, crawl or floating lines; the step where a house enters
the detail ring (windows and kit pieces appear) as with the rings. Motion at full rate unverified (stills).

**Travel** (coverage bench in Play, the 9.84 km line, at the cap; A and C 2 rounds interleaved, B one round,
22:25–23:32 UTC, uptime 20.2–20.3 d, load 1.7–6.4; `travel/<q>-<v>-<mode>-r<n>.json`, `sum.py`; medium 150 C round 2 failed
once on a game relay error and was run again at 00:13). Detail = full detail after the stop, pending = nothing
pending (s); "-" not within the 30 s held; loads / derives = the simulation's after the stop; queue full = the worker
pool's queue at ≥ 250 of 256 (s after the stop).

| | longest ms | missed / min | ground s | detail s | pending s | holes | loads / derives after | queue full s | fine nodes |
|---|---|---|---|---|---|---|---|---|---|
| low 60 A | 64.6, 52.6 | 11.0, 8.4 | 0.03 | 5.59, 4.98 | 10.2, 9.8 | 0, 1 | 4.0k / 28.4k | 1.3–8.9 | — |
| low 60 C | 45.6, 53.1 | 2.6, 2.6 | 0.03 | **3.68, 3.95** | **4.8, 4.8** | 0, 1 | **1.5–1.6k / 6.6k** | 2.2–2.7 | 939 read |
| low 60 B | 43.1 | 4.4 | 0.07 | 6.08 | 6.7 | 0 | 4.1k / 6.6k | 1.4–5.9 | 1,704 built |
| low 150 A | 62.2, 64.2 | 10.1, 14.6 | 0.03–0.10 | 5.93, 5.98 | 10.2, 10.8 | 0, 0 | 3.9–4.3k / 28.6–29.0k | 0.5–9.1 | — |
| low 150 C | 46.6, 49.8 | 9.1, 5.5 | 0.03 | **3.86, 3.83** | **5.3, 5.1** | 0, 0 | 1.8–1.9k / 6.9k | 2.3–3.6 | 930 read |
| low 150 B | 45.7 | 11.0 | 0.03 | 6.65 | 6.7 | 0 | 4.2k / 6.8k | 2.5–6.0 | 1,710 built |
| medium 60 A | 72.2, 55.8 | 26.3, 26.7 | 0.04–0.07 | 19.9, 16.7 | 23.4, 21.6 | 4, 5 | 5.3–5.4k / 38.9–39.2k | 0.4–21.5 | — |
| medium 60 C | 52.4, 44.6 | 20.1, 15.4 | 0.03 | **11.8, 13.5** | **13.8, 15.5** | 2, 2 | 2.9k / 12.8k | 0.5–12.5 | 1,009–1,015 read |
| medium 60 B | 44.0 | 32.6 | 0.09 | 19.6 | 23.5 | 1 | 5.8k / 12.7k | 2.5–20.0 | 3,814 built |
| medium 150 A | 54.8, 46.9 | 16.5, 23.8 | 0.03–0.07 | 22.7, - | -, - | 19, 7 | 5.6–5.7k / 33.4–38.7k | 0.2–29.0 | — |
| medium 150 C | 47.9, 32.5 | 17.4, 18.3 | 0.08 | **11.6, 12.4** | **23.5, 25.9** | 3, 0 | 3.1–3.2k / 12.7–12.8k | 1.2–11.1 | 993–1,005 read |
| medium 150 B | 42.1 | 24.7 | 0.03 | 25.5 | - | 20 | 6.2k / 13.2k | 1.5–26.6 | 2,109 built |

No frame over 100 ms and no body through the ground in any run (0 of 83 / 34 drops). Read: **C settles soonest in
every cell and both rounds**, with the fewest loads and derives after the stop (the read ring ends at the detail reach)
and the shortest full queue; the longest frame and the missed frames are lowest or equal with C at low and at medium 60 m/s; at medium 150 C's
missed frames sit between A's and B's (medium frame times unverified on target hardware). After 150 m/s at medium only
C has nothing pending within 30 s (23–26 s: the far field's coarse tail, D632's rest). Holes at medium 150: A 7–19,
B 20, C 0–3 (D634). Every cell's settle ends on level 0 for C (`settleBy`), on level 1 for A.

**The < 2 s full-detail target (low).** What bounds C now: level 0's own refill after the stop. The full queue lasts
only 0.5–1 s; the settle ends on the level-0 count; after the stop the simulation runs 6.6–6.9 k section derives
(2.7–2.8 k of them air, answered without a job) and 1.5–1.9 k loads for the 91 level-0 chunks low draws at the end
pose (the detail ring with its hysteresis, the level-1 nodes it splits, and an apron). The derive cost per section is
46d.24's (1.4–2.5 ms a chunk); the fine bricks past the ring are read and uploaded in parallel (939 nodes) and are done
~1 s after level 0. **One cheap candidate measured:** low's detail ring at half the tier's area (the scene's own
`quality.low.scale` 0.5; a level's `voxelRings` does not reach the coverage bench, which resets the levels): level-0
chunks drawn 91 → 38, derives after the stop 6.6 k → 3.2–3.3 k, loads 1.5 k → 0.6 k, **full detail 1.98 s (60 m/s)
and 1.90 s (150 m/s), nothing pending 3.2–3.3 s** (one round each, `travel/low-*-C-ring05s.json`). Its cost in a
picture (`shots/side-by-side/town-west-low-C-vs-Cring05.png`): the detail ring ends ~32 m out instead of ~45 m, so the
middle houses of town-west lose their window frames, recesses and kit pieces (the fine bricks carry no kit pieces).
Default unchanged (the owner's A5: the detail ring = the level-0 ring stays until the far-rendering numbers exist;
they do now): the target is met by a smaller detail ring or not at today's ring (default chosen, owner to confirm).

**Headroom meter** (town orbit 12 m at 0.15 rad/s still; 60 m at 0.25 rad/s moving; one round each, ms a pass by
hiding it past the edge, ±40 %, a negative figure is noise; 23:33–00:12 UTC; `meter/*.json`, `sum.py`):

| | near ms | far ms | frame GPU ms | room (copies) | far nodes / MiB | fill s | heap + GPU MiB |
|---|---|---|---|---|---|---|---|
| low A still / moving | 3.16 / 3.48 | 3.74 / 4.22 | 7.8 / 6.0 | 176 / (no edge found) | 1,037 / 77 | 6.5 | 563 + 850 |
| low C still / moving | 4.52 / 5.44 | 8.66 / 8.79 | 9.2 / 9.0 | 176 / 152 | 1,969 / 134 | 7.9 | 642 + 1,010 |
| medium A still / moving | 0.16 / 2.25 | 2.45 / 2.59 | 8.7 / 11.0 | 64 / 52 | 2,594 / 164 | 12.0 | 783 + 1,217 |
| medium C still / moving | 0.83 / 0.24 | 4.17 / 4.43 | 9.7 / 10.0 | 44 / 36 | 3,869 / 250 | 22.6 | 967 + 1,496 |

Low keeps its 30 Hz cap with room either way; C's far pass is ~5 ms larger (more and finer bricks, textured) and the
frame ~1.4–3 ms more. Medium's room falls 64 → 44 copies still, 52 → 36 moving (unverified on target hardware).
*Cold fill to town-west settled* (the shots' runs): low A 14.3 s, B 12.7, C 11.4, C1 12.1; medium A 22.6, B 25.9,
C 26.9, C1 28.6 (C fills more far nodes at medium). *Memory at the town in Play* (page heap + GPU driver-resident,
MiB, of low's 4,096): low A 639 + 874, B 660 + 911, C 666 + 1,153, C1 631 + 1,185; medium A 714 + 1,309, B 776 +
1,329, C 933 + 1,543, C1 941 + 1,635. C costs +306 MiB at low over A (far GPU 77 → 134 MiB, the fine nodes' atlas).

**The baked reads, counted** (1bfd05e1: the far field counts the stored bytes it reads, the baked fine levels apart;
the coverage bench reports them; Play, C, one round each, 01:44–01:54 UTC, `travel/*-C-bytes.json`). After the stop:
low 60 m/s 4,776 baked entries asked (~940 hold bricks; the rest are nodes the bake stored nothing for), **7.7 MB read**
(detail 3.68 s); low 150 4,969, **8.1 MB** (3.43 s); medium 60 5,700, **10.9 MB** (11.45 s): about 2 MB/s at low over the
settle, against 26b's estimate of 4–5 MB from the uploads. In flight the counter shows 48–49 MB at low at either speed,
94 MB at medium: the same at 60 and 150 m/s, so it is the line start's fill, not a flight rate (no baked node is read
past the detail speed).

**A baked world in an export** (the "cut": a scratch staging project `voxel-cut`, the 8 km world's region columns rx
−9…10, rz −3…1, 6.55 km², the town and the coverage line's first 4.3 km, `cut-world.py`; its own far cache built by the
backend, then **baked by the product to 0.5 m on 4 threads in 1,448 s: level 1 (the 1 m bake) in 653 s, level 0 in
795 s more** (`cut-bake.mjs`); exported at 0.5 m, 1 m and 2 m; each export served statically with staging stopped,
01:05–01:44 UTC, uptime 20.4 d, load 1.4–6.0; `export/`):

| the cut world, 6.55 km² | 2 m (A) | 1 m (C1, level 0 by compute) | 0.5 m (C) |
|---|---|---|---|
| far cache on disk (coarse / + 1 m / + 0.5 m) | 33.4 MB | + 91.6 MB | + 325.1 MB |
| the whole export on disk | 162.2 MB | 253.9 MB | 579.0 MB |
| shipped a km² over 2 m | — | + 14.0 MB | + 63.6 MB |
| export memory at the town, low (page heap + GPU, of 4,096 MiB) | 320 + 539 | 310 + 593 | 329 + 597 |
| the same back at the town after both flights | 281 + 564 | 274 + 614 | 308 + 615 |
| low 60 / 150 m/s: far field settled after the stop | 3.2 / 3.0–3.2 s | 0.8 / 1.0 s | 1.8–2.0 / 1.9–2.1 s |
| low 60 / 150: longest frame, missed a minute | 40–41 / 45–52 ms, 0 / 2–4 | 47 / 42 ms, 1 / 2 | 46–58 / 42 ms, 1–2 / 0–2 |
| medium 60 / 150: far settled, missed a minute | 5.3 / 5.3 s, 11 / 19 | — | 3.1 / 2.9 s, 11 / 13 |

Ground solid 0.02–0.04 s, no body through, no frame over 100 ms in any run. **Not measured here: full detail after the
stop.** At the line's 4.3 km park (next to the massif's corner) the export drew **no level-0 chunk for the 30 s after
the stop in every run, A and C alike** (A drew 12 level-1 nodes there; the town reading of the memory bench has its
110 level-0 chunks, so level 0 works in these exports elsewhere): D641, untraced. The hole counts (212–1,047 frames)
are the bench's, not the world's: it takes a world's bounds as a square, so the strip's sides read as holes (worst
frames looked at, `export/shots/*-hole-*.png`: the world's side edge and the debug console at the start; no ground
missing inside the strip). The memory bench flies the whole 9.8 km line, past the strip's end, so its after-flight
readings are of an empty world; the town and home readings stand. Medium unverified on target hardware.

*Tests and gates.* vitest `far-fine.test.ts` +1 (the cover's edge ring) and the baked-read test's counted bytes; no e2e
change (`voxel-world.e2e.ts` untouched; the voxel area 176 / 148 / 170 s in the gates below). gate-fast-20261112-212743
(9bc95e2a) GREEN, `stream-speed.test.ts` (level 0 back nearest first, a mean over thirds, 85.98 against 85.67) and
`stream.test.ts` (a worker-pool timeout) failed once under the gate's load and passed alone; gate-fast-20261113-002210
(1bfd05e1) GREEN; closing area gate gate-area-20261113-015607 (voxel, rendering, play; 59 e2e) GREEN.

*Unverified / not done in 26c:* full detail in an export of a baked world (D641), a whole bake of the 8 km world
(5.0 GB), a hosted (HTTP) export's read rate, medium and high on their hardware, motion at full rate (stills only).

### 46d-c review fixes

The independent review of 46d-c (§9, "46d-c close") and the phase gate gate-phase-20261113-020301 (RED at vitest);
each finding and what became of it. Gates: §8 "46d-c review fixes, gates" below.

| Finding | What changed, or why not | Commit |
|---|---|---|
| A1 (L1) three hooks | Checklist row for `voxel-fine-bricks.ts` and the grid store's uploads (`backend.device`, `backend.get(texture).texture` after `initTexture`; no public three API writes a compute buffer into a texture three owns). The scan's miss was a local named `builder` (the engine's own fine build): renamed | 4644fca4 |
| A2 (L2) clock-bound tests | `stream-speed`: stand-ins measured from the camera where their swap was chosen (a swap event carries its choice's foci); nearest first counted in the order full level-0 derives are asked, not the order results land (one swap shows most at once, as a set). Worker pool: timeouts far apart (1 s / 3 s hang). Both pass beside 14 busy loops | 4644fca4 |
| A3 `getRenderTarget is not a function` | `voxel-far-view.test.ts`: a disposed view's palette redraw queued after the frame ran on the test's recorder. Not a broken path in the product; a disposed view now skips the redraw | 4644fca4 |
| H1 fine build only a URL flag | `voxelWorld.fineBuild: off \| compute` (default off) beside `bakeLevel`: schema, canonical form, validation, resolve, Inspector "Fine build", manual, reference; the page's flag stays as a bench override and a renderer that cannot build turns it off in every world. Inspector and export texts corrected | af076a4a, 9f2f79b3 |
| M1 D641 untraced | Traced: the 4.3 km park is 316 m over the ground (the "high" altitude takes the highest ground 150 m ahead: the massif's cliff), past the load ring's 96 m height, so no chunk with ground loads there, in every export and with every bake. Not a product defect. Measured with the stop inside the world at 2.5 km (44 m over the ground): baked 0.5 m full detail 2.14–2.34 s after a 60 m/s stop and 2.27–2.32 s after 150 m/s (2 rounds), nothing pending 3.9–4.1 s, longest frame 40–51 ms, 0 of 64 drops through; mesh rings 4.83 / 5.44 s (1 round). D641 won't fix (the bench's stop point) | docs |
| M2 D635 two builders | Traced: deterministic per node (the same nodes differed in every run; the first six built, which the check read, change with load). Every differing sample had no shown cell in reach: the CPU carried the last look of earlier bricks, the GPU the nearest in its brick. One rule now (the GPU's) in the CPU builder; 0 of 780,759 samples apart over 64 nodes, 0 of 28,431 over the roof gable; the e2e checks every node built (up to 64), bound 2 → 0.5 %. A builder change: caches baked before keep the old fallback in those samples until rebuilt (not versioned) | f0b40578 |
| M3(a) D594 dig past the ring | Not fixed (no cheap path): with level 0 baked round the focus the edited chunk is outside the shrunk read ring, so even the compute build has no voxels for it. D594 now says what a game sees | docs |
| M3(b) full rebuild discards the bake | Not fixed: the full build replaces the folder whole. D644 open (keep fine columns whose content keys did not change) | docs |
| M3(c) failed bake swallowed | Kept and answered: far info `fine.failed`, Inspector "failed: <reason>" with Resume; far reads no longer restart it | 9f2f79b3 |
| M3(d) `job.changed` never cleared | A landed column rebuilds only its own nodes over the changes made meanwhile (`rebakeFarFine(…, only)`) | 9f2f79b3 |
| M3(e), M5 WebGL 2 and the bake | Mesh rings kept unless 0.5 m bricks draw past the detail ring: built (fine build, WebGPU) or baked for every column round the focus (the read ring's test); 1 m without compute, a bake under way or stale, and 2 m keep the rings on every renderer. A scene asking 2 m of a world baked finer draws what the cache holds (default chosen, owner to confirm). On the owner page's "for you to confirm" | de7208c4 |
| M4(a) terrain-cdlod impostor ratio | Alone ×3: 0.601–0.620 at fda36fa8, 0.603–0.617 at 6b947726: not 46d-c's; the ratio was 0.68 to 2026-11-10 and sits at its bound since 46d-b (candidate f50e6ab2, TAAU on upscaled levels): D643 open | docs |
| M4(b) D637 | Alone ×3: 2 of 3 passed at fda36fa8, 1 of 3 at 6b947726 (31–33 px left): fails alone at the base too, so not a 46d-c regression; D637 open (a test failing alone) | — |
| M4(c) 46d.24 gate lines | Added to §8 46d.24 | docs |
| M6 "no shimmer" | Owner page: stills only, motion at full rate unverified | docs |
| L3 D599 | Reproduced on demand beside 14 busy loops (the same 3,450,364 B); the drawn bytes less the newest commit's groups still pass the budget then (3,274,380 against 2,266,946), so a bound by one commit's groups would not hold: several commits put finer nodes in before the coarse ones close. D599 open (a real overshoot when the far workers are slow); the test's bound kept | docs |
| L4 one-round cells, partly baked C | Owner page labels B and the 32 m ring as one round, says C in Play ran on a world baked round the bench regions | docs |
| L5 two scene walks | `voxelWorldBakeLevel` derived from `voxelWorldBakeLevels` | af076a4a |
| L6 4,096 look words | A look past them draws as its material dry where named, else the block's first look | 9f2f79b3 |
| L7 46d.24 row | Ends whole | docs |
| L8 gate time | Nothing cut: the e2e's bake step is the Inspector's state (the browser's part); the far info's states (failed, resumed) are now in vitest (`voxel-far-fine.test.ts`). voxel-world.e2e.ts: the voxel area 147–176 s in 46d-c's gates, 158 / 165 s in this slice's (gate-fast-20261113-030759, the every-area run); its page test alone 54–58 s with every built node checked (64, was 6). The phase gate's time against 46d-b's is the close's to record | — |
| L9 TAAU/post → scene-loads | `environment` (post, TAAU, upscale, exposure) runs `scene-loads.e2e.ts` too | 6b947726 |
| D616 cameras exposure 0.4948 | Not a regression: the check read the exposure 150 ms after the key's release, so it measured whether the cut's screenshot ended before then (2 of 4 alone at head). Every reading now held to ≤ 1 − e^(−speed·t) of the way since the key went down; 5 of 5 alone | 09ab8d70 |
| D637 export cut-away | The roof was gone; the px left were the T-join's blue resolved into the yellow piece under it, read as the roof's front face. The classifier counts the roof's lit top only (blue > 140, no such mix reaches 124); 5 of 5 alone. D643 is not this cause (left open) | 09ab8d70 |

*46d-c review fixes, gates.* gate-fast-20261113-023443 (4644fca4) GREEN; -025032 RED build (FarField over 80 members,
fixed in the same commit) and -025250 RED vitest (`page-view.test.ts`'s fake far field, fixed the same) before
gate-fast-20261113-030759 (de7208c4) GREEN (`visual-script-debug.test.ts` failed once under load and passed alone:
D642); gate-fast-20261113-033517 (af076a4a, every area for the project model) RED vitest (`script-fields.test.ts`'s pin
for the new optional field, re-pinned: f9051b5a), its rerun gate-rerun-20261113-034612 RED e2e (318 passed, 22.5 min:
`block-layers.e2e.ts:490` D637 and `shadows.e2e.ts:281` D645), alone gate-rerun-20261113-041028: shadows passed,
block-layers failed (as at the base). The final run, every unit test and every area: gate-fast-20261113-045522 RED (vitest: `stream.test.ts`'s stale-results case D454 failed once, passed alone; e2e 318 passed, `cameras.e2e.ts:315` D616 and `project-items.e2e.ts:186` failed; alone in gate-rerun-20261113-053141 project-items passed, cameras failed with D616's same 0.4948: D616 now open).

### 46d-c close: acc46d-c

**acc46d-c** (`~/.cache/thirdlight-phase46/acceptance/46d-c/`, README, `approve-46d-c.md`; review page `#acc46d-c`,
the questions page linked first): built from pictures already taken, none new (a phase gate held the machine). 39
pictures, all opened: `travel/` (46d.24a before against 46d.24b/24d after, 150 m/s flight and stop strips, low and
medium, exports; the 32 m ring pair), `poses/` (the 13 poses at low A against C, the four town poses at medium),
`bake-levels/` (C against C1 and B, the storage table), `webgl2/` (gl2A against gl2C, gl2C against gl2C1), `strips/`
(orbit, walks A and C), `history/` (1:1 crops of town-west's back rows: rings, 25a, 25b-1, 25b-2, 26c). The page: five
questions (below, §10), the review's eyes/ears list, the 65 "default chosen, owner to confirm" entries of §9 dated
2026-11-11 to 2026-11-13 (1–23 already on approve-46d-b and approved with it, 42 new), targets met / not met, the 16 open
D-rows of 46d-c. Seen again: the stop strips before and after look alike at low (detail by 8 s; the hitch gain is a
timing); medium after 24d is coarse to 8 s with D622's green rectangle; at town-west C's back-row roofs are straight
planes where A's are stair-stepped; WebGL 2's baked 0.5 m draws flat-colour walls past the ring.

## 9. Decision log

- 2026-11-08 (plan, default chosen, owner to confirm): **the spike comes before the spec split and the material
  model**, as the owner asked; it uses a bench-generated height test set and a spike-only switch, so it needs no
  format step or material record. Its product version (46d.5) waits for real heights (46d.4).
- 2026-11-08 (plan, default chosen, owner to confirm): **relief displaces inward only** (height 1 = the base
  surface, 0 = `heightDepth` below it), so walkable tops stay on the collision surface, characters never sink into
  peaks and nothing pokes into a neighbouring cell; collision, occupancy, nav and light never see relief (§7a).
- 2026-11-08 (plan, default chosen, owner to confirm): **crack-free relief by a crease weight** (0 where the normal
  turns, at kit-edge cells, owned-face seams, section/LOD borders and the ring's fade), with border vertices kept on
  the coarse edge, rather than stitching subdivided and plain sections; kit edge pieces therefore meet an
  undisplaced lattice. The spike may replace it if pictures show the creases.
- 2026-11-08 (plan, default chosen, owner to confirm): **the relief ring is its own ring inside level 0**
  (`levels.relief`, per scene, runtime, quality-scaled; default from the spike), not the level-0 ring itself: the
  detail-piece ring stays level 0's (owner A5), relief is a cost the tiers scale separately.
- 2026-11-08 (plan, default chosen, owner to confirm): **the format spec is split into three pages** (main spec,
  `voxel-kit-format.md` for kits, `voxel-render-spec.md` for 46d's additions); the split changes no content or
  version (D496).
- 2026-11-08 (plan, default chosen, owner to confirm): **the material model extends `MaterialDef` add-only** (no
  project schema bump: every field is optional and absent means today's behaviour) instead of a new record type;
  shader families are a derived read of shader + graph + voxel use, not a new field, so today's materials need no
  conversion before 48a.
- 2026-11-08 (plan, default chosen, owner to confirm): **voxel ids live on the material record** (1–4,095, unique in
  the project; every world of a project shares them), and a voxel variant is a material instance with its own id.
- 2026-11-08 (plan, default chosen, owner to confirm): **the kit binding moves to `material.voxel.kit`**; kit
  format 1's `materials` list stays accepted (format 1 is final, add-only) and binds only ids no material names,
  with a kit-check info row; nothing is removed from a format.
- 2026-11-08 (plan, default chosen, owner to confirm): **physical profiles: engine constants (Wood, Stone, Metal,
  Earth, Glass, Water, Lava) plus a project's own in `content.materialProfiles`**, overriding by id; the engine reads
  density/friction/restitution/flow only where its physics already has a slot (chunk colliders keep one friction:
  Rapier trimeshes have no per-triangle friction); games read everything through `ctx.voxels.materialAt`.
- 2026-11-08 (plan, default chosen, owner to confirm): **wall / floor / ceiling are texture sets of one material**
  (`voxel.surfaces`; floor and ceiling default to the wall's), chosen by role and face direction, not three
  materials, so a voxel stays one material id.
- 2026-11-08 (plan, default chosen, owner to confirm): **tier texel density 256 / 512 / 1024 px/m** (low / medium /
  high) as a quality-level field, one authored 1024 px/m set; the budget is the page's existing `texture_budget_mb`,
  no voxel-only budget.
- 2026-11-08 (plan, default chosen, owner to confirm): **placeholder texture sets are made by a bench script**
  (engine-owned test data; full 4096² in scratch, a 512² cut committed for tests), not through art-factory; real
  sets come from the games via the authoring package.
- 2026-11-08 (plan, default chosen, owner to confirm): **the multi-km test world is 8 × 8 km** with mountains to
  ~1.5 km and the town patch at the centre, written tile by tile to disk inside the 6 G cap, deleted after 46d.9
  unless the owner's pick needs it.
- 2026-11-08 (plan, default chosen, owner to confirm): **far data is a derived far cache** (never committed, rebuilt
  per node on edit) that an export ships, so a game draws its horizon without the backend.
- 2026-11-08 (plan, default chosen, owner to confirm): **L1 door/window "legs": the mip readers close an opening
  narrower than two of a level's cells in the wall's material**, so a far wall reads as a wall (role-aware
  downsample), rather than keeping thin pillars.
- 2026-11-08 (plan, default chosen, owner to confirm): **both far-field modes ship behind `farField`
  (`mesh` | `bricks`), default `mesh` until the owner picks**; the brick marcher is a TSL fragment shader (both
  renderers), not the WGSL compute tracer, which WebGL 2 cannot run; a hybrid is built only if the comparison calls
  for it.
- 2026-11-08 (plan, default chosen, owner to confirm): **far-field shading has no shadow maps** past the shadow
  distance: sun and sky from the node's normal and macro colour; far shadows are 46e's lighting question.
- 2026-11-08 (plan, default chosen, owner to confirm): **D526 is its own small item (46d.6c)**, beside the piece
  instancing, since it is mesher work; D468 stays with the performance phase.
- 2026-11-08 (46d.1a, default chosen, owner to confirm): **the relief mesh splits each triangle until no edge spans
  more than 1.5 / n cells on any axis** (a regular n × n lattice on unmerged base faces, about 4^log2 n triangles a
  ground triangle, roofs along their rows) rather than a per-surface lattice, because an edge-only rule keeps every
  shared edge identical across sections without either side seeing the other.
- 2026-11-08 (46d.1a, default chosen, owner to confirm): **crease weights**: base points from the voxels round them
  (a face continuing flat on every side, no roof plane cell touching); ground from the terrain mesher's crease
  vertices plus every vertex within half a cell of a wall, beam or rail (the ground meets bodies along a line their
  faces stop at); roofs from their own triangles, wall contact, and **fixed within one cell of every section face**
  (a neighbour's roof reaches a cell in, unseen): roofs get no relief in a 1 m stripe at section faces (46d.1b to
  judge in pictures, an exact rule from the roof words if it shows). Kit edge pieces sit on cell edges the base rule
  already fixes; no per-piece flag.
- 2026-11-08 (46d.1a, default chosen, owner to confirm): **plain neighbours over all 26 units round a section**
  (`plainNeighbours`), not its 6 faces: a point on an edge or corner is shared by up to 8 sections, and all must fix
  it alike. The ring's fade over its last metres is left to the vertex stage (a distance, 46d.1b), not baked.
- 2026-11-08 (46d.1a, default chosen, owner to confirm): **the spike relief is a derived part outside the canonical
  bytes** (no derived version step until 46d.5a), drawn in place of the surfaces while collision keeps the plain
  ground; the page's relief ring is chunks within `?reliefRadius=` (default 32 m) of the focus when derived, not
  re-planned as the camera moves (46d.5a builds the ring), and level seams read the relief boundary.
- 2026-11-08 (46d.1a, default chosen, owner to confirm): **relief tests in a new vitest file**
  (`tools/voxel-bench/relief.test.ts`, with `relief-checks.ts` shared with the bench) instead of `derived.test.ts`
  (1,541 lines); no e2e change.
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **the spike's lighting normal comes from the height map's
  screen derivatives** (surface gradient of the blended recess in metres) on every surface, because no material has a
  normal map yet; 46d.4's normal maps replace it (it sparkles at grazing light). It is also what "relief off" keeps.
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **the vertex stage runs the surface shader's full blend**
  (nine grid reads, the owner cell, two materials' heights) rather than a per-vertex material attribute, so a material
  paint still never remeshes and both sides of a seam move alike; measured ~0.1 ms at n = 4 in the town.
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **heights are read in the vertex stage at the mip whose texel
  is as wide as the vertex spacing** (so n = 2 shows only the 25 cm shape of a material; finer detail is the normal's).
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **the fade ends a chunk's half diagonal inside the relief
  ring, over 4 m**, so a chunk at the ring's edge, relief or plain, never moves (46d.5a: a section's half diagonal).
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **culling bounds grow by the deepest relief of any material**
  (12 cm with the test set), not per chunk: one number, conservative, no per-chunk scan.
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **the test heights are made by code at page load** (engine
  test data in `voxel-relief.ts`, by the bench worlds' material ids), not written to files by a bench script, so the
  page needs no asset; nothing ships them.
- 2026-11-08 (46d.1b, default chosen, owner to confirm): **the relief verdict**: low off (normal only), medium n = 2 in a
  16 m section ring, high n = 4 in 24 m, n = 8 rejected; terrain and roofs first, construction may fall back to normal
  only (§8 46d.1b).
- 2026-11-08 (46d.2, default chosen, owner to confirm): **the kits section moves whole, its derived history stays.**
  Under the old *Kits* heading the main spec also held the derived version history (v2 → v28), chunk-tree flags and
  the prop lighting channel, which are not kit formats: they stay in the main spec under their own heading (§3.8
  points at the history there). The kit page keeps §3.9's number, so every "§3.9" elsewhere reads as before; a § on
  the kit page names the main spec unless marked. Moved text changed only where a link crossed the split ("above" /
  "below" to a named section of the other page); the main spec keeps a pointer heading at each old place.

- 2026-11-08 (46d.3a, default chosen, owner to confirm): **the voxel id is identity, never inherited**: an instance
  with its own `voxel {id, …}` is a voxel variant (inheriting use, kit, tile, depth and texture sets map by map); an
  instance without one is a mesh variant only, so "maple prop" needs no voxel id.
- 2026-11-08 (46d.3a, default chosen, owner to confirm): **game data merges by top-level key** (instance over
  parent, material over profile); a value that is not an object replaces the farther one whole. The engine still
  never reads a member.
- 2026-11-08 (46d.3a, default chosen, owner to confirm): **physical numbers and profiles**: density kg/m³ in
  (0, 30,000], friction 0–4, restitution 0–1, flowRate 0–100 relative to water = 1; defaults density 1000, friction
  0.5, restitution 0; engine profile values earth 1500/0.8/0.05, glass 2500/0.3/0.3, lava 3100/0/0 flow 0.05, metal
  7850/0.4/0.15, stone 2500/0.7/0.1, water 1000/0/0 flow 1, wood 700/0.6/0.2; a project profile's fields are optional
  and override the engine profile of its id one by one. Profiles live in `content.json`, not one file each.
- 2026-11-08 (46d.3a, default chosen, owner to confirm): **voxel ranges**: `tileMetres` 0.5–64 m (absent: the
  derive's 4 / 2 m), `heightDepth` 0–0.25 m (half a cell, so a one-cell wall's two recesses never meet; absent
  0.02 m); a texture set is `{albedoHeight, normal, orm}` of plain textures (46d.4a's arrays), floor and ceiling
  falling back to wall, wall to the material's own look.
- 2026-11-08 (46d.3a, default chosen, owner to confirm): **`kit_missing` is a project rule**, so the material command
  and deleting the kit are refused alike (as a material an object uses); a project-only profile a material names is
  held the same way, while deleting a project override of an engine profile falls back to the engine's.
- 2026-11-08 (46d.3a, default chosen, owner to confirm): **a build resolves what the runtime would otherwise need
  the project for**: each shipped kit carries its bound ids in its `materials` (same meaning, the material records
  applied) and each shipped material its physics with the profile's numbers and game data folded in, so the runtime
  reads neither profiles nor unshipped materials (46d.3b's `ctx.voxels` reads the shipped records).
- 2026-11-08 (46d.3a, default chosen, owner to confirm): **shader families as `materialFamilyOf`**: graph > decal >
  liquid (water shader or liquid use) > projected (construction / terrain use; on a mesh the same record draws
  standard) > standard (standard, foliage, atlas, trim, unlit); `effect` belongs to the effect records. No new shader
  types, nothing stored.

- 2026-11-08 (46d.3b, default chosen, owner to confirm): **what a record draws before texture sets**: its colour is
  `params.color` (a record naming none keeps the per-id stand-in colour), every id keeps its test pattern until
  46d.4a's arrays, `tileMetres` sets the construction and the terrain tile alike (one repeat whatever the projection),
  drawn at the nearest tile dividing the 512 m texture phase (3 m → 2.994 m), and `heightDepth` replaces the depth
  only where the page names a height layer (the relief test heights) until real heights arrive (46d.4).
- 2026-11-08 (46d.3b, default chosen, owner to confirm): **every voxel material ships when the game holds a voxel
  world** (any `voxelWorld` object), rather than reading every region file for the ids it holds; a mesh-only material
  still ships only when something names it.
- 2026-11-08 (46d.3b, default chosen, owner to confirm): **`materialOf(id)` / `materialAt(p)` answer null** for an id
  no shipped material has (as for unloaded or air cells), never a defaults record; `materialOf` answers with no world
  loaded (materials are the game's). The engine reads no physical number: chunk colliders keep one friction.
- 2026-11-08 (46d.3b, default chosen, owner to confirm): **badges** `mesh`, `voxel`, `kit`, `liquid`, `decal`, `graph`
  (derived, never stored; `voxel` = has a voxel use, what voxel tools list); the filter is the project window's
  search `f:<badge>` (several narrow), served by `queryIndex`'s `badges` from the records and never kept as a reused
  page (a record edit does not change the index), not a separate material library panel.
- 2026-11-08 (46d.3b, default chosen, owner to confirm): **the voxel world page's picker** lists voxel materials by
  id and starts on the lowest; with none, shift-click adds id 2 as before records; the page has no feed, so it reads
  the records again when its window gets the focus back (a material edited in the editor meanwhile).
- 2026-11-08 (46d.3b, default chosen, owner to confirm): **the Inspector's voxel section** sets use, id (a new voxel
  material takes the smallest free id), kit, tile and depth; an instance becomes a voxel variant with its own id; no
  section on decal materials; the surface texture sets and the physical block stay API-only (the profile commands
  remain listed in `tests/editor-op-reach.test.ts`) until 46d.4a draws sets and an Inspector physical section is
  planned.

- 2026-11-08 (46d.4a, default chosen, owner to confirm): **one array per map for every voxel material** (albedo with
  height in A, normal, ORM: three units in place of the pattern array, six of sixteen), layers one size (the
  assembly's rule), so a 2 m terrain tile in a 4096² array carries 2048 px/m, twice construction's; arrays per tile
  size would cost three more units a program.
- 2026-11-08 (46d.4a, default chosen, owner to confirm): **which set a face draws**: on construction the floor set
  where the face's normal points up (y > 0.95), the ceiling set where it points down, the wall set on every other
  face, roof slopes included (the roof material's main set); terrain draws its wall set alone, triplanar.
- 2026-11-08 (46d.4a, default chosen, owner to confirm): **a record's colour tints its sets** (albedo × `color`);
  a record with a set and no colour draws the set as authored (white), not the stand-in swatch; an id without a set
  draws its flat colour (no test pattern).
- 2026-11-08 (46d.4a, default chosen, owner to confirm): **no placeholder images committed** (the plan said a 512²
  cut): the generator (`tools/voxel-bench/texture-sets.ts`) is deterministic at any size, tests make 32² sets on
  the fly, the bench writes the authored 4096² to scratch and imports 1024² (256 px/m on a 4 m tile, the low
  tier's density) into staging until 46d.4b streams the top mips.
- 2026-11-08 (46d.4a, default chosen, owner to confirm): **the build names the arrays in a `voxelTextures`
  catalog block** (by map) and the runtime makes each id's layers from the shipped records with the same function,
  so no layer table ships.
- 2026-11-08 (46d.4a, default chosen, owner to confirm): **the image's first row is its top**: V up reads it from
  the bottom, the tile's foot on the grid's 0 m line; the normal map is turned by the projection's own frame (the
  grid's U and V, each axis's on terrain), not by screen-derivative tangents; with the spike's test heights the bump
  bends the mapped normal.
- 2026-11-08 (46d.4a, default chosen, owner to confirm): **the band test texture draws over construction in both
  programs**, the test patterns only under `?patterns=1`; arrays sampled with 4× anisotropy (floors at grazing view).
- 2026-11-08 (46d.4a): **the height's place** (normal A per texture layout v1 and R111, albedo A per the 46d.3a
  record) is left to 46d.4d (D531); the placeholder sets carry it in both.

- 2026-11-08 (46d.4b, default chosen, owner to confirm): **the tier's texel density is a quality-level field**
  (`voxelTexelDensity`, powers of two 64 … 4096, tier defaults 256 / 512 / 1024), a cap on the arrays' top level; the
  page's one `texture_budget_mb` decides below it (no voxel-only budget), the tail ≤ 128² always resident.
- 2026-11-08 (46d.4b, default chosen, owner to confirm): **the near need is measured from the chunks drawn with the
  surface material at the finest tile a textured material draws** (terrain's 2 m tile asks one level more than a 4 m
  wall); the cap is measured on the construction tile (4 m), so a 2 m terrain tile keeps twice the density.
- 2026-11-08 (46d.4b, default chosen, owner to confirm): **voxel arrays always stream** (no per-texture `streaming`
  setting: they are not texture assets); a build cuts them into parts whenever they have a level past the tail.
- 2026-11-08 (46d.4b, default chosen, owner to confirm): **the editor's views stream the arrays from the whole file**
  they fetch (the backend route answers whole arrays), at the engine's default budget; asset textures in the editor
  still load whole. The voxel world page starts at `low` (the floor it measures); Play and exports at the level drawn.

- 2026-11-08 (46d.4c, default chosen, owner to confirm): **4096² past the encoder: UASTC stripes assembled**
  (D532) rather than a newer encoder (a dependency change is the owner's) or layers made outside the engine; every
  image past 12 Mpix goes UASTC, colour too (larger than ETC1S, the price of one asset set at 1024 px/m), up to
  32 Mpix an image (an encoder worker's memory); the levels just below a striped top are box-filtered here, the
  rest by the encoder.
- 2026-11-08 (46d.4c, default chosen, owner to confirm): **a kit's one texture set is its pieces' GLB material**
  (images extracted on import into KTX2 textures, as every model's), not a material record the kit names: kit
  format 1 is read as it is, the artist's export carries the sheet, and a kit sheet streams like any model texture.
- 2026-11-08 (46d.4c, default chosen, owner to confirm): **pieces draw lit with three's standard node material**
  (colour, normal, ORM), the trim U on every map, the normal map's frame from that U; **a material without an image
  draws a stand-in colour a kit**, and the debug sets (layout or cell) only under `?trimDebug=1` on the voxel world
  page (no switch in Play or the Scene view).
- 2026-11-08 (46d.4c, default chosen, owner to confirm): **a kit's crack map is read into the 512² crack layer by
  the brightest texel of each** (not the nearest), so a 4096² map's one-pixel cracks survive; the layer size stays
  the engine's.
- 2026-11-08 (46d.4c, default chosen, owner to confirm): **the authoring export writes the kit material's images
  only when it carries a sheet** (an albedo image that is not the UV guide); the committed sample stays untextured
  (no images committed) and exports with a sheet through `--sheet DIR`.
- 2026-11-08 (46d.4c): kit sheets follow the texture budget and on-screen need, not the tier's texel density
  (D536); the extraction's time inside one import command (D537).

- 2026-11-08 (46d.4d, default chosen, owner to confirm): **height lives in the normal map's A only** (texture layout
  v1, R111; D531): the record's map is renamed `albedo` rather than kept as `albedoHeight` with its A ignored, since
  nothing of the branch shipped and a name that says height where none is read would mislead; no fallback to the
  albedo's A (one home); a normal map without alpha draws no height.
- 2026-11-08 (46d.4d, default chosen, owner to confirm): **the import bound for textures is derived from the largest
  edge** (a 4096² 8-bit RGBA PNG stored uncompressed, 65.3 MiB; D535), not streamed import; the 32 MiB model and audio
  bound stays; the stage takes the larger; four of the largest files may be staged a project at once.
- 2026-11-08 (46d.4d, default chosen, owner to confirm): **height blend**: the higher surface in metres wins over a
  1 cm contrast, each surface raised by its share × (deeper depth + 1 cm), so a whole share always shows alone and two
  flat materials blend by share (the old linear blend, slightly steeper in the middle).
- 2026-11-08 (46d.4d, default chosen, owner to confirm): **wetness numbers**: albedo × (1 − 0.5 w), standing water ×
  0.8 more; roughness × (1 − 0.6 w), water 0.03; normal detail flattened by 0.4 w (all under water); the water line
  at w² × 0.6 of the blended height (levels 1–2 only darken and shine, crevices fill from 3, level 7 under 60 % of
  the height range), over a 0.04 shore. The line is in each pixel's blended height (0–1), the blend itself in metres.
- 2026-11-08 (46d.4d, default chosen, owner to confirm): **the texture sets' lighting normal is the normal map's**;
  the screen-derivative bump from heights (46d.1b's stand-in) stays only on the debug program with its test heights.
- 2026-11-08 (46d.4d, default chosen, owner to confirm): **kit pieces stay dry for now** (D538): a piece's material
  would need its cell's wetness from the grid per instance, which 46d.6a's cross-chunk piece buffers decide.

- 2026-11-08 (46d.5a, default chosen, owner to confirm): **`levels.relief` is where the displacement ends** (default 16 m, the verdict's medium ring, scaled per quality level like every distance: high 22.6 m rather than the verdict's 24 m; a scene sets 17 m to get 24), and the ring meshes a section whose centre lies within it plus the section's half diagonal (6.9 m), keeping it 4 m longer (hysteresis); the fade is the last 4 m before the distance. So what the owner reads as "relief to 16 m" is what is drawn, and a section turns relief or plain only where nothing of it moves.
- 2026-11-08 (46d.5a, default chosen, owner to confirm): **relief steps are a quality level field (`voxelRelief`, 0/2/4/8; tiers low 0, medium 2, high 4)**, not a scene field: how fine is a device question, how far a scene one. A world resolved without a level (the Scene view) has none.
- 2026-11-08 (46d.5a, default chosen, owner to confirm): **relief's budget share is 1/8 of the stream budget while the ring is on** (low 32, medium 64, high 128 MiB), reserved: the base world's eviction counts the rest; relief bytes are each section's relief part and its chunk draw's relief copy (GPU). Over its share the ring shrinks farthest first to 90 % of it and grows back once the focus has moved 8 m (D528).
- 2026-11-08 (46d.5a, default chosen, owner to confirm): **a ring change derives the whole section again** (the plain outputs are byte-equal, the relief part is new) in one group with every relief neighbour, rather than a relief-only job: one derive path, the atomic swap and the stamps reused; the swap's `chunk` events say `reliefOnly` (canonical bytes equal) so bodies stand.
- 2026-11-08 (46d.5a, default chosen, owner to confirm): **Play and exports derive the relief ring at medium and high from now on** but draw it undisplaced until 46d.5b; the Scene view (no quality level) derives none.

- 2026-11-08 (46d.5b, default chosen, owner to confirm): **the relief distance scales by its own tier scale** (`RELIEF_RING_SCALES`: low 0.71, medium 1, high 1.5), not the ring scale (√2), so the default 16 m gives the verdict's medium 16 m and high 24 m; a level that sets **Voxel ring scale** scales relief with every distance, and a scene's per-level `scale` or own `relief` wins as before. Replaces 46d.5a's "high 22.6 m; a scene sets 17 m".
- 2026-11-08 (46d.5b, default chosen, owner to confirm): **the draws learn the relief ring from the streamer** (a `relief` stream event → the chunk batch's `relief`: steps, where it displaces now, the ring's centre, re-sent each 1/8 m the centre moves), not from the page's camera: Play's stream focus is the sim's camera, the Scene view's the orbit target (whole cells there, so its fade moves in 0.5 m steps), and the fade must be the ring's.
- 2026-11-08 (46d.5b, default chosen, owner to confirm): **the Scene view draws relief at the view's quality level** (its steps and the relief distance scaled by it; its other distances stay the scene's own); a level change re-plans the ring in the worker, no reopen. The voxel world page takes the level's relief by default (`?relief=0` none) with a **relief** switch (moved / mesh flat).
- 2026-11-08 (46d.5b, default chosen, owner to confirm): **Play and exports still cast no voxel shadows** (as before: the voxel world's shadows and their cost, D529, are lighting work, 46e); where shadows are on (the page's `?shadows=1`) the shadow pass is displaced the same.
- 2026-11-08 (46d.5b, D541, default chosen, owner to confirm): **a section waits only for the chunks it reads** (its box + R), and a section reading a chunk neither resident nor coming counts as drawn-empty for the level choice and the seams (the world ends per section at the load ring's edge). Cost: the ring's edge sections now derive (a 32 m ring: 3.2× the derives; default 192 m ring unmeasured, D543).

- 2026-11-08 (46d.6a, default chosen, owner to confirm): **pieces are culled per chunk on the CPU on both
  renderers** (a chunk's sphere against each pass's frustum, a draw's buffer ordered view / other camera / rest, each
  pass drawing its leading part) with three's `InstancedMesh`, not `attribute-instancing.ts`' per-instance culling:
  that one tests and re-sorts every instance on each view change and carries only its own riders (no trim U or
  wetness); a few hundred chunk tests serve every kind. GPU culling per instance stays 46d.6b's (WebGPU).
- 2026-11-08 (46d.6a, default chosen, owner to confirm): **which camera is the view**: the last one drawn without an
  override material; any other camera (a shadow map) draws the view's chunks and its own while it is still, all
  while it moves; buffers are never rewritten between two passes of a frame. Draw room in powers of two (≥ 64
  instances); the matrices' anchor follows a chunk past 1 km.
- 2026-11-08 (46d.6a, D538, default chosen, owner to confirm): **a kit piece wears its dressing cell's wetness**
  (the cell its kit is read from), with the surface's R111 look taken at height 1: darker, smoother, normal detail
  flattened; water never stands on a piece (it stands proud of its faces).

- 2026-11-08 (46d.6b, D544, default chosen, owner to confirm): **kit pieces draw after the world's surfaces** (render
  order 1): a piece draw holds a kind's pieces near and far, so drawn among the surfaces it shaded hidden far pieces.
- 2026-11-08 (46d.6b, default chosen, owner to confirm): **piece draws place their copies by instance columns with
  their data in the matrix's spare fourth row** (floats 3, 7, 15; 11 stays the surface cache's), not three's
  `InstancedMesh` and a `pieceU` attribute: the GPU culler's pools and lists carry the 16 floats as they are, so a culled
  draw reads its riders through the same list. A copy's data is read in the vertex stage and passed on as a varying.
- 2026-11-08 (46d.6b, default chosen, owner to confirm): **the culler lists piece draws itself** (`CullableCopies.nested`:
  adopted at their first draw, listed every frame they are in the scene and shown) rather than the voxel world adding
  its draws to the scene's top level; a draw adopts whenever a culler appears (its program built once more).
- 2026-11-08 (46d.6b, default chosen, owner to confirm): **copies are handed to the culler by place** (slot = place),
  so a reorder (a chunk crossing the view's edge) copies every copy in view again and the visibility kept per place
  belongs to other copies for a frame (they move to the second pass, never missing); by slot is D546.
- 2026-11-08 (46d.6b, default chosen, owner to confirm): **WebGL 2 keeps the per-chunk CPU culling** of 46d.6a: it has
  no compute, storage buffers or indirect draws for per-copy lists, and the engine's WebGL 2 occlusion queries were
  dropped earlier (answers frames late, too little saved); culling every copy on the CPU would rewrite the buffers on
  every view change. **Shadow maps keep per-chunk culling against their own frustum** (the pyramid is the view's).
- 2026-11-08 (46d.6b, default chosen, owner to confirm): **the tier switch is the existing `occlusionCulling` level
  field** (and the project's `occlusion_culling`); no tier turns it on by default (auto culls nothing), although it
  saves 2–3 ms GPU in the town on WebGPU: whether medium/high default to `on` for voxel worlds is the owner's call
  (§10). The voxel world page pins a path with `?occlusion=`.
- 2026-11-08 (46d.6c, default chosen, owner to confirm): **a body's owned faces merge with its blended ones, and the
  rectangle holding an owned face is owned whole** (derived 30): every pixel on it shows the body cell behind it,
  unblended, so a wall face next to a roof (its top row, a gable's steps) and the rest of that wall in the same plane
  read alike: two wall materials meet there in a hard line on the cell boundary and wetness steps per cell, as the
  wall's top row already did (role spec item 27). The other way (blending the merged face) would bring D519 back; a
  face kept blended needs its own polygon, the +53 k triangles of D526. One-material walls look the same either way.
  The relief ring (unmerged faces) keeps the narrower ownership, so a two-material wall next to a roof can differ
  between the relief ring and past it.
- 2026-11-08 (46d.6c): **D545 not built here** (the 46d.6c row names no D545 work); the proposal (the relief ring's
  plain surfaces as shadow-only casters set `heightDepth` in, relief meshes casting none) is in its audit row for the
  performance phase.

- 2026-11-08 (46d.6d, D545, default chosen, owner to confirm): **relief chunks cast from their plain surfaces at the
  plain place, not pushed `heightDepth` in** (the proposal): three casts a front-sided surface's back faces, and the
  plain solid holds the relief one, so the plain caster gives the plain world's shadow exactly; the push would let
  light through thin walls and edges. Relief surfaces look their shadow up at the plain place. The relief's own
  micro-shadows go (none showed at the page's 3.9 cm map texel). `?reliefShadow=relief` keeps the old way to compare.
- 2026-11-08 (46d.6d, default chosen, owner to confirm): **the plain caster is sent with every relief draw**, shadows
  or not (a quarter of the relief bytes at n 2, a sixteenth at n 4, handed over without a copy); a view without
  shadows builds nothing of it. Play and exports still cast no voxel shadows (46d.5b default).
- 2026-11-08 (46d.7a, default chosen, owner to confirm): **the far world** is 8.192 km a side (32 × 32 regions, the
  town at the centre), seed 97, peaks 1.51 km, base −64 m, terraced cliffs (28 m steps, 12 % risers) with overhangs
  (±5 m within 8 m of the surface) where a cliff mask is high, no lakes, the town's rotated-grid houses left out; it
  stays on disk (scratch, ~0.52 GB with its cache) for 46d.7b–7d.
- 2026-11-08 (46d.7a, default chosen, owner to confirm): **the far cache is the world's own region format per
  level** (stacked, the world's footprint and id) in the project's `cache/voxel-far/<world>/`, levels 2 (64 m nodes,
  2 m cells) up to the lowest level at which two nodes span the world (8 for 8 km); built per region column in
  workers, the levels above from those nodes.
- 2026-11-08 (46d.7a, default chosen, owner to confirm): **far selection**: a node's error is its cell (2^L cells)
  over its box distance from the eye in pixels, 2 px at 720p and 60° by default, hysteresis 0.25, a budget of
  48 MiB of stored node bytes, largest error opened first; nodes reaching into the load ring's box open to level 2
  and are marked for the draw modes. Per quality tier and per scene (like the rings) when 46d.7b draws them.
- 2026-11-08 (46d.7a, default chosen, owner to confirm): **openings at the coarser levels** close when narrower
  than two of the parent's cells and a body ends them across their width (its role, the opening's material);
  wider ones stay openings, so they keep their width up the levels (derived 31). An opening the parent's side cuts
  is judged by its part inside.
- 2026-11-08 (46d.7a, default chosen, owner to confirm): **the backend's rebuild on an edit, the export's shipping
  of the cache and the page's streaming of it come with the draw modes (46d.7b)**: before them nothing in the
  backend or a game reads the cache, so shipping or rebuilding it would only cost; the rebuild and file list are
  built and tested now.

- 2026-11-09 (46d.7b, default chosen, owner to confirm): **the far field draws under the near field everywhere**
  (no near box in its selection) and is discarded per storage chunk where the near field draws, one chunk in from the
  near field's edge; along that ring both draw and the near field wins on depth. A chunk the near field has not
  streamed yet shows its far stand-in (no hole while flying); the price is the far field's nodes under the town.
- 2026-11-09 (46d.7b, default chosen, owner to confirm): **far depth is written in the vertex stage**: the camera's
  depth of 1.05 × the distance up to half its far plane, logarithmic past it to 64 km, so no camera's far plane
  changes in any host and far nodes are never clipped there (D553 has the limit).
- 2026-11-09 (46d.7b, default chosen, owner to confirm): **far colour = the material's table colour × its wall
  set's mean albedo** (the array's coarsest level), per vertex from the cell behind it, darkened by wetness; no far
  texture detail, no macro normal map (the mesh's normals light it).
- 2026-11-09 (46d.7b, default chosen, owner to confirm): **detail by tier: low 8, medium 4, high 3 px**
  (`FAR_ERROR_PIXELS_BY_TIER`); 2 px (46d.7a's default) is 14 M triangles from the town and closed the high page.
  Mode `mesh` on every tier until the owner picks between meshes and bricks.
- 2026-11-09 (46d.7b, default chosen, owner to confirm): **one far draw per level and 8 × 8 node columns**, rebuilt
  whole when a node in it changes, changes gathered every 250 ms (`FAR_COMMIT_MS`); far draws are not frustum culled
  (three's frustum ends at the far plane; D550).
- 2026-11-09 (46d.7b, default chosen, owner to confirm): **the backend opens worlds on demand** (D548) with 256 MiB
  of clean region files kept per open world; it builds a missing far cache itself, in the world's queue (D552),
  and rebuilds the ancestors of every command's chunks before answering; runtime edits (`ctx.voxels`) do not reach
  the far field.
- 2026-11-09 (46d.7b): the 8 km world and its cache moved into the staging project (`voxel-slice/voxels/far`,
  `cache/voxel-far/far`); `work/46d.7a/project` links to them.
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **a far brick is drawn as its own box** (one instance a
  stored brick, all of a group in one instanced draw), its region in the atlas carried by the instance: the box's
  raster is the page table, so a ray is marched only through bricks the surface passes, never through empty ones.
  The plan's node-level page table walk would march a node's whole box per pixel.
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **a brick is stored only where its samples change sign**
  (phase 42 keeps every brick within the band): 13.9 of a node’s 64 on average from the town (36.9 k for 2,648 nodes).
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **the far field is the cells' occupancy as a distance**:
  solid where the fill level is at least half, Euclidean distance to the other kind less half a cell, ½ − fill next
  to it, corners the mean of 8 cells, so slopes come out smooth where the meshes show terraces (both kept as they
  are for the comparison).
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **skirts as a lip**: a brick on its node's face is marched
  0.5 cell past it with the field rising 4 per cell there, a steep skirt; deep under the surface the samples are
  clamped to the band, so a hit there (a coarser neighbour lies lower) is shaded as the box face it entered: a wall
  down to the brick's floor instead of a crack.
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **colour as mode A**: a material and wetness word a sample
  (the plan said a per-node macro), coloured by the same table read as the far meshes, so the two modes differ only
  in shape.
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **one shared atlas, one material**: every brick's samples
  and looks are a region of two 3D textures (r8 filtered, rg8 texels), the voxel surface's region store reused
  (`VoxelShaderGrids` takes its texel format), uploaded per brick on both backends; one material for every brick
  draw, since three keys a program build by the material's properties and a second material with the same graph
  would read the first one's textures and uniforms.
- 2026-11-09 (46d.7c, default chosen, owner to confirm): **same selection, detail and tiers as the meshes** (low 8,
  medium 4, high 3 px) so the comparison measures the draw, not the selection; at most 32 steps a ray through one
  brick. No hybrid built (46d.7d decides whether one is needed).

- 2026-11-09 (46d.7d, lead recommendation, owner to pick): **meshes as the far-field default on every tier, bricks
  kept behind the switch, no hybrid now**: meshes hold the cap orbiting on the Iris Xe (0 missed, both renderers),
  bricks miss 17–24 of ~480 from their march; silhouettes are alike, edits/export/build are shared; meshes cost
  +0.74 GB page heap (bricks +0.1–0.2). Bricks are re-measured after D555 and on the high tier.
- 2026-11-09 (46d.7d, default chosen, owner to confirm): **the plan's D479 (shader-only far derive) is not part of
  46d.7d** (its row names none); it stays open as re-recorded in 46d.7b. The comparison is at medium in one hour;
  high numbers come from 46d.7b/7c's hours.

- 2026-11-09 (46d.8a, default chosen, owner to confirm): **the §4 flight on the 8 km world** (2.4 km at 60 m/s, per
  tier) in place of the hilly 2 × 2 km world's 60 s flight, whose world was deleted for disk space; the village is
  46d.6d's three houses (46d.1a had two). Each tier measured on its own page state (town, village) or a fresh page
  (8 km world), one round (two orbits on the 8 km world), ≤ 3 rounds kept.
- 2026-11-09 (46d.8a, default chosen, owner to confirm): **`voxel-world.e2e.ts` keeps one page a renderer for the
  voxel world page** (the assembly proof first on WebGPU's), relief by pixels in Play on WebGL 2 and in the export on
  WebGPU (not twice on WebGPU), and no logged-only measurements (the Scene view orbit); a test that only logs a number
  belongs in the staging scripts, not the gate.

- 2026-11-09 (46d.8b, default chosen, owner to confirm): **the 46d traceability lives on the render spec (§5)**, the
  page holding 46d's formats, with the format spec's §4 and the requirements page pointing at it (the approved format
  spec stays under 2,000 lines); **the material guide extends the kit guide's §1** (its title already promises a
  material set) instead of a new manual page.
- 2026-11-09 (46d.8b, default chosen, owner to confirm): **proposed for the owner, not built**: occlusion culling on by
  default at medium/high on WebGPU for scenes with a voxel world; voxel shadows in Play/exports stay off until 46e.

- 2026-11-09 (lead, 46d.9): **closing full gate GREEN** gate-full-20261109-051432 at f83a2ff4: 35 min (46c's 34), peak
  8.0 GB (8.0), 868 vitest files, 392 e2e tests; `voxel-world.e2e.ts` 70.7 s in the fast gates. **Independent review**
  (fresh agent, read-only, 774dd6a9..f83a2ff4, `~/.cache/thirdlight-phase46/review-46d.md`): 0 High, 3 Medium, 8 Low;
  every owner requirement of §2 found built. Findings and what 46d.9 did:
  - M1 D559 (Play switched to `high` at first residency): traced and fixed. WebGL 2: the collision column counted a chunk settled at its
    first `chunk` event, which carries only the sections that could derive; a section still waiting on a neighbour
    being loaded (more of them at high's larger rings) left the ground missing under the character, which was let
    go and fell through (y −46 m, pad 51.5 m; 2 of 19 runs). Now a column waits until every section of its chunks
    has its result (`VoxelStreamer.chunkReady`): 0 of 10; `collision-ready.test.ts` fails on the old rule. WebGPU:
    the missing mark and the coarse wall last ≤ 1 s after the switch (2 of 6 runs at the first probe, every later
    probe right); not traced further (D566, watch). The kept e2e switches WebGL 2 to `high` before the world streams.
  - M2 D552 (far cache build held the world's commands and exports; per-edit rebuild on the event loop): fixed, re-rated
    M: builds and rebuilds in worker threads (`far-cache-runner.ts`), a full build outside the world's queue with the
    meanwhile edits built in when it lands, exports wait ≤ 2 min then ship without it and warn (D565 split off).
  - M3 (approve page listed ~48 of the defaults): approve-46d.md §6 now lists all 112 (+4 of 46d.9) in 12 groups, and
    a §5 *Not as planned* (D479 open, D559, D560, 64 km far depth, `off`, D550); acc46d republished.
  - L1 residency under-counted (D561), L2 far cache swap gap (D562), L3 relief scale overridden by `voxelRings`
    (D563), L4–L7 item id in a comment, personal default path, far level literals, second names of texture limits,
    unmarked role spec rule (D564): fixed. L8 (stranded sections at a finite world's edge, D560; D543 unmeasured):
    deferred: D560 stays open with its candidate (a chunk with no region file as
    air rather than "not coming") for 46e or the performance phase, D543 unmeasured (plan note in §10).
- 2026-11-09 (46d.9, default chosen, owner to confirm): **a far cache build runs outside the world's queue** in a
  worker thread of its own; commands go on and their chunks are built into the new cache in the queued step that
  swaps it in; a change by someone else meanwhile leaves it stale (built again when next read). An edit's rebuild
  runs in one kept worker, still before the command is answered (the page re-reads its far nodes on the answer).
- 2026-11-09 (46d.9, default chosen, owner to confirm): **an export waits at most `FAR_EXPORT_WAIT_MS` (2 min) for a
  far cache being built**, then ships the world without it and says so in the export's warnings
  (`voxel_far_cache_building`): a game without a far field beats an export that times out after 300 s.
- 2026-11-09 (46d.9, default chosen, owner to confirm): **a level's `voxelRings` moves relief by its factor against
  the tier's ring scale** (`voxelRings / VOXEL_RING_SCALES[tier] × RELIEF_RING_SCALES[tier]`), so relief keeps its
  own tier scale (D563); a scene's per-level `scale` still sets every distance alike.

- 2026-11-09 (OWNER, first look at acc46d): **far field undecided.** The owner does not like that the mesh mode
  makes rings of joined materials (contour bands) where the brick renderer keeps material coherence better, and
  sees room for improvement in both; both modes stay behind the switch, no pick yet, no further far-field work for
  now. Owner asked why height sits in the normal map's alpha rather than the albedo's (the engine's layered surfaces
  and the owner's convention use the albedo alpha) — answer and proposal in the next entry once decided.

- 2026-11-09 (OWNER, after acc46d):
  - **Height moves to the albedo's alpha** (the engine's layered surfaces and the owner's convention); the normal map
    keeps no height. An add-only, owner-noted amendment to texture layout v1 (the v1 text said normal alpha — a
    drafting slip carried into the approval).
  - **Close-ring relief displacement is disabled for now** (keep it simple; fewer triangles, lighter mesher) until
    the brick far field works; then reconsider (or bevelled edges near, plain geometry past the ring).
  - **Far field: ~8 M triangles is too many**; keep silhouette and colour approximation at about a quarter.
  - **Brick renderer: ours turns to mush where Enshrouded's does not** — much room for improvement; it must be
    solved before relief returns.
  - **Performance role:** the owner's new "demo" project pushes the engine at real-game scale and feeds back; engine
    runs keep measuring but are no longer the go/no-go validator except for obvious regressions.
  - Material blend distance asked about: today fixed at 0.25 m in Play/export (only the voxel page has a switch).

- 2026-11-09 (OWNER choices): relief **off now on every tier** (code kept behind the switch; lighting from the height
  map stays), bevelled near edges come with relief's return after bricks work; **blend distance per material with a
  world default** (where two materials meet the smaller value wins); **follow-ups first** as 46d-b (§6d) before 46e.

- 2026-11-09 (46d.10, default chosen, owner to confirm): **the record's map keeps the name `albedo`** (not
  `albedoHeight` again): records and builds made since 46d.4d stay valid and nothing stored changes; the map is still
  the albedo, its A documented as the height, as a layered surface's albedo is.
- 2026-11-09 (46d.10, default chosen, owner to confirm): **the layered surfaces' brightness rule applies to voxel
  albedos too**: the voxel albedo array is a height array (`TextureSlotSet.height`), so an albedo without a height
  (opaque or one value) gets one from its brightness at assembly instead of reading flat (46d.4d: a normal without A
  read height 1). One convention, one assembled array for a texture both kinds of surface name.
- 2026-11-09 (46d.10, default chosen, owner to confirm): **a kit sheet's glTF material stays `OPAQUE`** (no
  `alphaMode`) with the height in the albedo's A; three's opaque materials force alpha 1, so pieces are never cut
  out. The Blender template marks the albedo image channel-packed and leaves its Alpha unlinked (checked: Blender
  5.2.2's export keeps the PNG's pixels, A included, byte-equal in pixels).

- 2026-11-09 (OWNER, relayed by the owner's session "thirdlight-e8"): **the far field goes the brick way.** Owner:
  "I want to move towards the brick far renderer. If Enshrouded is using it and they are getting fantastic detail
  and far draws then we should trust their judgement. We may need to work on improving this to be usable since they
  don't publish how, but we know it is possible and that is the direction I wish to go." The ray-marched brick
  renderer is the chosen far-field direction; making it usable (detail, cost on the Iris Xe, no mush) is the work.
  The mesh far field stays only as the fallback behind the switch: no mesh revision before the bricks work, and the
  "~1/4 triangles" cut applies to the mesh fallback only if it is still needed then. §6d reordered accordingly.

- 2026-11-09 (46d.11, default chosen, owner to confirm): **relief off = `RELIEF_STEPS_BY_TIER` 0 on every tier**, the
  one switch: no relief part is derived, streamed or budgeted (its share is 0 with no steps) and no caster made; the
  quality field `voxelRelief`, the ring, the part and the page's `?relief=n` stay, so a level that sets 2/4/8 gets
  relief as before. Tests that need relief turn it on explicitly (the e2e: the project's levels = the engine's with
  `voxelRelief: 4` at high; the bench host test: its level's own 4).
- 2026-11-09 (46d.11, default chosen, owner to confirm): **blend distance fields**: `voxel.blendMetres` on the
  material record and `blendMetres` on the `voxelWorld` component, 0–0.5 m (one cell, the shader's reach between
  cell centres; 0 a hard cell line), world default 0.25 m (what every host drew), limits once in
  `VOXEL_MATERIAL_LIMITS` (`blendMetresMax`, `blendMetresDefault`); inherited along instance chains like the other
  voxel fields.
- 2026-11-09 (46d.11, default chosen, owner to confirm): **"the smaller wins" = the narrowest of the eight cells
  round a pixel** (solid cells only; a material without its own asks for the world's), so both sides of a seam read
  the same width; costs eight table texels a pixel more (13 in all).
- 2026-11-09 (46d.11, default chosen, owner to confirm): **the world's blend is a draw setting** read from the scene's
  `voxelWorld` object as its decal layers are (first object naming the world), never part of the resolved streaming
  settings, so changing it reloads nothing; the voxel world page (no object) keeps `?blend=` and the `setBlend` hook.
- 2026-11-09 (46d.12, default chosen, owner to confirm): **the far bricks' best build is the faces field from the
  node's children** (`faces2`): grandchildren gain ≤ 0.4 m at 7× the build; the node's own cells (`faces`) are no
  better than occupancy. Occupancy stays the default until 46d.13; `faces`/`faces2` are switches only (page, hook).
- 2026-11-09 (46d.12, default chosen, owner to confirm): **a surface corner is moved by ½ − the mean fill of its 8
  cells** (as the occupancy build moves a cell next to air): against "out by the solid cells' missing fill, in by the
  air cells' fill" it gave roofs 3.59 against 5.07 m and fewer holes, at the price of rounding a lone cell's convex
  corners by up to ⅜ of a finer cell.
- 2026-11-09 (46d.12, default chosen, owner to confirm): **a surface lying on a brick face is drawn by its solid
  side** (faces build): a node of only air is not kept, so the air side may not exist; the occupancy build keeps the
  air side (unchanged).
- 2026-11-09 (46d.12, default chosen, owner to confirm): **a sample's look is the material most shown cells round it
  show**, over the finer cells its trilinear reach covers, tops counted twice; **the fine shading** blends the 8
  samples' colours, darkens by the field one and two cells out along the normal (to half at most), and ends a march
  at half a pixel. All three are switches for the spike; 46d.13 moves occlusion and blend to the build.
- 2026-11-10 (46d.12b, default chosen, owner to confirm): **the realistic far world's erosion is a whole-world
  drainage grid at 32 m computed the same in every worker** (stream power with uplift, creep, filled pits), not a
  per-tile droplet pass with guard bands: a tile's result would depend on its band and not match its neighbour's
  exactly; the grid is 1 MB and 4 s. Finer erosion look comes from slope-aligned gullies, analytic, so it is seamless.
- 2026-11-10 (46d.12b, default chosen, owner to confirm): **rivers are dry, wet-gravel channels** (wetness 5, banks
  3), no water: the bench has no water material record and liquid in the far field is untested. Snow is a bench
  material (id 7, the plaster set tinted near white). The town keeps its flat at the centre; valleys that reach it
  end on its plain.
- 2026-11-10 (46d.12b): the realistic world is the far world's default; `--style terraced` writes the 46d.7a world
  for measurements against it. The 8 km staging world is the realistic one; 46d.7a/46d.12 pictures are of the old.

- 2026-11-10 (46d.13a, default chosen, owner to confirm): **the far look of ground is its exposed top, however
  thin**, in both far modes and every brick build; side cells (step risers, which show the subsoil) colour a sample
  only where no top is within a node cell of it, so a cliff keeps its rock and a slope its grass. A one-cell body on
  the ground (a roof) still keeps its own look (its tops are in the footprint; the ground's a cell below rank lower).
- 2026-11-10 (46d.13a, default chosen, owner to confirm): **the far mesh looks straight down first for a vertex
  facing more up than sideways** (else along its inward normal first, as before).
- 2026-11-10 (46d.13a): D570's fix stops at dense reads and lattice-only transforms (job −37 %, fill −21 %); the
  fill is still ~44 s at medium from the town, left to 13b/13c's build choice (bake-off) rather than tuned here.

- 2026-11-10 (46d.13b-1, default chosen, owner to confirm): **baked colour from a palette drawn on the GPU**: every
  look word's far colour by the surface's own `farColour`, read back and redrawn when the table uploads, so far meshes
  and bricks keep one colour function and a record's look still reaches the bricks without a far rebuild (resident
  bricks using a changed word are baked again). Price: an RGBA8 atlas beside the distances (+65 MB at medium);
  occlusion is baked in the far job (a build flag), not on the page's thread.
- 2026-11-10 (46d.13b-1, default chosen, owner to confirm): **the skip map is the build's brick table**, walked by a
  DDA a node: no per-cell distance map was added; the node box is the union of its stored bricks' boxes.
- 2026-11-10 (46d.13b-1, default chosen, owner to confirm): **13b-1's variant for the bake-off is baked + node march at
  full resolution** (`v3`): it misses 0–3 a round, looks like ref within 0.03 % of pixels and steady in motion. Half
  resolution stays a switch: it takes the last 0–3 but steps silhouettes at 2 px and shimmers on the stepped slopes
  without a reuse of the last frame (D574); worth measuring again on the high tier or a weaker GPU.
- 2026-11-10 (46d.13b-2, default chosen, owner to confirm): **13c's default far field is the ray-marched bricks v3 at
  full resolution** (`faces2` + baked shading + node march): at medium it holds the cap on both renderers (0–2 missed
  a round) with the smooth look; rasterized bricks miss 16–38 (vertex-bound, 7.3 M triangles) and look terraced and
  speckled. Raster and half resolution stay switches until 13c; the mesh field becomes the fallback (46d.14).
- 2026-11-10 (46d.13b-2, default chosen, owner to confirm): **rasterized bricks draw one square a face, not merged
  runs**: runs along a tangent would be 36 % fewer instances but put T-junctions in the surface (pixel cracks);
  cubes are clipped to their node's box and skirts lit as the surface's steepest direction (lit as their own face
  they read as black dots along node seams).

- 2026-11-10 (46d.13c-1, lead on the owner's "build the winner as the default far field"; default chosen, owner to
  confirm): **ray-marched bricks v3 are the far field on every tier and in every host**, meshes the fallback behind
  `voxelFarField: 'mesh'`; one build (`FAR_BRICK_BUILD`, faces from the children, baked occlusion), one shading
  (baked), one march (a node a box).
- 2026-11-10 (46d.13c-1, default chosen, owner to confirm): **the losing variants are retired, not kept behind
  switches** (occupancy, flat, fine, box a brick, raster; code in ad8b9da3 … f99af3cb, last tree a0de93e3); the old
  page parameters warn and are ignored, the hook's refuse. **Half resolution stays** as an off-by-default page switch:
  small to keep and the planned trial for the high tier (D574 open).
- 2026-11-10 (46d.13c-1, default chosen, owner to confirm): **Play and the export prove the far field in the e2e at
  the low tier with the play world's own 40 m load ring** (`quality.low`): the other tiers load the whole 128 m test
  world, so nothing is far there; a 20 m ring put the near cover's uncovered outer ring in view (D577).

- 2026-11-10 (46d.13c-2, default chosen, owner to confirm): **a part-full far cell is solid up to its fill as a
  height**, from its fuller vertical neighbour's side (below on a tie), in the brick build's distance; whole-cell
  configurations keep the old corner rounding (buildings and whole-cell terrain build as before). Gentle slopes are
  smooth; real steps (scarps, terraces of whole cells, cliffs) stay steps.
- 2026-11-10 (46d.13c-2, default chosen, owner to confirm): **the far bricks' normal is taken over a cell either side**
  (was half a cell): half the residual slope banding, no per-pixel cost; edges round over ±1 node cell in shading only
  (silhouettes and the march are the field's). The faint thin lines left on far grass slopes are not traced further.
- 2026-11-10 (46d.13c-2, default chosen, owner to confirm): **in the near field's edge ring the far field draws behind
  all of the near field** (depth at least the near cover's farthest corner), both far modes; the ring still fills
  gaps between the two. Clipping the far field there was not chosen: the ring is what closes the near/far gap.
- 2026-11-10 (46d.13c-3, default chosen, owner to confirm): **far jobs are background jobs with at least a quarter
  of the workers** while the near field's wait; with none waiting they take every worker. Strict near-first left the
  far field still during a flight (0 swaps in 40 s).
- 2026-11-10 (46d.13c-3, default chosen, owner to confirm): **a far GPU budget per tier, low 96 / medium 176 / high
  288 MiB, not a level field**: sized to hold the town's set at each tier unchanged (153 / 255 MiB live) and to stop
  travel piling up (medium flight end 315 → 204 MB). The selection spends it by screen error; nodes closing over finer
  ones go first while over it. A level setting can be added later if a game needs one.
- 2026-11-10 (46d.13c-3, default chosen, owner to confirm): **the atlas gives memory back only from its end** (oldest
  regions handed out first, emptied growths trimmed by one GPU copy, 1/8 slack); no compaction that moves bricks (it
  would rewrite every moved node's brick table). Under the budget the atlas stops growing, so compaction was not needed.
- 2026-11-10 (46d.13c-3): the 2-byte palette index (D573's option) not built: the budget bounds the colour atlas.
  `spanDistances` left as it is (performance phase).

- 2026-11-10 (OWNER, relayed by session thirdlight-65 with the research note `docs/research/voxel-vista-performance.md`):
  the goal is an order of magnitude over today with fidelity kept or improved, leaving room on the Iris Xe at 720p30
  for detail, foliage, weather and volumetric fog at low quality. **Steps 1–4 of the note's §4 are wanted in the
  phase being worked on now** (46d-b), as a focus. Steps 5–6 (foliage, fog/weather) come later.
- 2026-11-10 (lead, placement): the vista pass is 46d.16 (step 0, the headroom meter — first, because it makes 1–4
  measurable), 46d.17–46d.20 (steps 1–4), after 46d.13 and before the 46d-b close (46d.15 moves to the end).
  46d.14 is deferred: the note's §5 gate (bricks unless the meter says otherwise, then a height-field mesh past
  ~2 km) replaces it. The note's findings are not requirements; each item re-checks them against the code at its
  start (46d.13c-3 already closed D550, D551, D557, D573). 46d.18 changes the far cache format: an add-only
  version step whose owner note is the instruction above. Still one closing full gate for all of 46d-b.

- 2026-11-10 (OWNER, relayed by session thirdlight-65; `docs/research/voxel-vista-performance.md` §6): **WebGPU
  first, WebGL 2 a fallback; vista steps 1–4 on compute.** Lead applied it: 46d.16–46d.20 are designed, built and
  measured on WebGPU and reuse the engine's compute depth pyramid (`occlusion-pyramid.ts`) and culled-instance
  table with indirect draws (`occlusion-instances.ts`), no second culling path; new items test and measure on
  WebGPU only; existing both-renderer e2e passes and two-renderer measurement rounds are cut as each area is next
  touched (not one sweep), down to one WebGL 2 smoke per area (loads, draws, no console error). Recorded in
  AGENTS.md (branch) and the agent brief. Lead default, owner to confirm: the 46d-b closing full gate keeps
  `--both-renderers` as already instructed (it is the last both-renderer run of the old e2e passes); 46d.15's
  pictures and numbers are WebGPU only. The compute mappings are designs to verify against three r187 and the
  WebGPU docs, not tested code.
- 2026-11-10 (46d.13c-4, default chosen, owner to confirm): **a coarse far node gives way one level at a time**: a
  wanted node two or more levels finer than its drawn stand-in is made after the stand-in's children (then theirs),
  each step a small group swapped whole; costs ~1/7 more jobs where a refinement is deep, and the drawn field is never
  held at the stand-in until hundreds of nodes under it are made.
- 2026-11-10 (46d.13c-4, default chosen, owner to confirm): **far nodes the near field draws every chunk of are made
  last** (the near field's drawn levels, not its load ring: in a fast flight the near field draws little, and the far
  field there is all there is).
- 2026-11-10 (46d.13c-4, default chosen, owner to confirm): **the near field's level choice runs every update** and a
  seam build a full queue refused is sent again 20 ms later (`SEAM_REQUEUE_MS`); the far worker share stays ¼ (raising
  it while the near field cannot follow a flight is left to the vista pass, D584).
- 2026-11-10 (46d.13c-4, default chosen, owner to confirm): **a camera inside the ground draws what the bricks give**
  (the grid seen from inside, D585): not hidden by a shader rule yet; discarding a node whose solid holds the eye would
  show holes to the sky instead. Proposed: refine the eye's own node first (done) and decide with the owner.
- 2026-11-10 (46d.16, default chosen, owner to confirm): **the headroom meter loads the GPU to the edge of the cap
  and reads passes past it**, not by timestamps (D544) and never uncapped: a fixed ballast in one instanced draw
  finds the room; each pass's ms is the interval it saves hidden where the GPU sets the interval, quoted as its
  share of the four passes × the frame's GPU ms from the edge (raw falls move up to 60 % between rounds, shares
  ≤ 11 points); ms are ±40 %. Copies of a pass are a cross-check only (near's disagrees, D588).
- 2026-11-10 (46d.16, default chosen, owner to confirm): **measured in Play in the editor**, the town-square orbit
  on the 8 km world, WebGPU, 1280 × 720, the tier's render scale pinned and dynamic resolution off (it would hide
  the load); "missed" = more than 2 % of frames over 25 ms or a mean interval 3 % over the budget (a busy GPU
  shows 20 ms frames that are not over 25). Hidden shadows = the casting lights stop casting (programs rebuilt,
  the run waits for it); hidden post = the scene at the stack's size copied to the canvas (that copy stays in).
- 2026-11-10 (46d.16, default chosen, owner to confirm): **the baseline 46d.17–46d.20 report against** is
  `work/46d.16/headroom-baseline.json` (medium three rounds, high one); a later item runs the same command
  before and after its change in the same hour (at most 3 rounds) and quotes room, shares and the D583 check.
- 2026-11-10 (46d.16): **D583 is GPU pixel cost at high's full resolution**, mostly the far march: with the far
  field hidden the high orbit holds the cap; it stays open for the vista steps. Medium has almost no GPU room on
  the floor GPU (D587): the half-resolution far march (D574) is worth its trial in 46d.20, as the note said.

- 2026-11-10 (OWNER, after reading 46d.16; relayed by session thirdlight-65): low tier = the Iris Xe target (720p
  upscaled, 30 Hz cap; render scale ~0.667 + temporal upscaler); 150 m/s with coverage as the criterion; a memory
  ceiling for low only; post stack a later phase; fuller frame budget later with the owner; no stand-in forest (the
  owner's demo project). Also asked: low's headroom at 30 Hz; the edited-node rebuild design for the baked far
  cache (folded into 46d.18); terrain shadows proposal (near chunks as static casters in the cached key-light map,
  lamps through atlas tiles near only, far terrain from a compute horizon-shadow texture) — not decided; the near
  part measured in 46d.19, the rest waits for the owner / 46e.
- 2026-11-10 (lead, placement): order 46d.17 → **46d.21** (low tier; the meter's baseline on the target) → 46d.18
  (baked bricks, edits as designed) → **46d.22** (150 m/s coverage) → 46d.19 → 46d.20 → 46d.15 close. 46d.21 comes
  early because every later item should report against low at 30 Hz; 46d.22 after 46d.18 because baked bricks
  make far coverage cheap at speed.

- 2026-11-10 (46d.17, default chosen, owner to confirm): **far groups draw after the pyramid** (second pass only), culled
  by the near field and every other first-pass draw; far boxes do not hide other far boxes (no far depth in the
  pyramid). The per-pixel reject before the march reads the same pyramid. WebGL 2 draws as before.
- 2026-11-10 (46d.17, default chosen, owner to confirm): **occlusion culling's `auto` takes the depth pyramid path on
  WebGPU while a voxel far field draws** (it was off everywhere on auto, so the culled table never ran in Play); kit
  pieces are culled with it. `off` still turns it off; elsewhere auto is unchanged.
- 2026-11-10 (46d.17, default chosen, owner to confirm): **the culling rule hides a copy whose projection is wholly off
  the screen** (the frustum's sides, in compute) for every culled copy, not only the far field's.
- 2026-11-10 (46d.17, default chosen, owner to confirm): **baked normals (d) not kept**: +40 % far GPU bytes (164 → 229
  MB, or the budget's nodes cut by 2/7) for no gain the meter sees after c; the per-pixel gradient stays. The patch
  is in `work/46d.17/`; 46d.18's bake at world-bake time may store normals instead of colour-side bytes.
- 2026-11-10 (46d.17, default chosen, owner to confirm): **the cheap far shading (e) not kept**: Lambert drops the
  standard material's environment light and darkens every far slope (30–52 % of pixels by > 60). One sun term,
  ambient and fog are left to 46d.20's far shade pass, which can take the environment term once a pixel.
- 2026-11-10 (46d.17): F7 (three writes a brick, the palette bake in JS) unchanged; 46d.18 removes the runtime bake.

- 2026-11-10 (46d.21, default chosen, owner to confirm): **low = render scale 0.667 with dynamic resolution, TAAU
  where the look anti-aliases, MSAA + FSR 1 where it does not** (exactly medium's path), bloom/AO/DOF off, largest
  shadow map 2048, the low lighting and voxel budgets as they were. Low had `msaa: 0`; an upscale from 853 × 480
  without anti-aliased input stair-steps, so low keeps the renderer's MSAA like medium.
- 2026-11-10 (46d.21, default chosen, owner to confirm): **a quality level's `frameRateCap`, low 30**; the frames
  follow the lower of the level's and the game's cap, a page pin over both; dynamic resolution budgets from it.
- 2026-11-10 (46d.21, default chosen, owner to confirm): **WebGL 2 low draws the same level** (render scale, FSR 1,
  MSAA; TAAU is WebGPU-only, the look's FXAA/SMAA in its place): no WebGL 2 code changed, the medium path it had.
- 2026-11-10 (46d.21, default chosen, owner to confirm): **low's memory ceiling: page heap 1024 MiB, GPU 1280 MiB**
  (the browser GPU process's DRM resident memory), measured in Play in the editor (so with the editor page):
  low reads 614 / 880 MiB at the town, 834 / 1105 after the 2.4 km flight. Reported by the headroom bench, not
  enforced; medium/high have none.
- 2026-11-10 (46d.21, default chosen, owner to confirm): **the meter times presented frames and scales its miss rule
  with the cap** (budget + half a refresh), so `headroom --quality low` measures at 30 Hz.
- 2026-11-10 (46d.21, default chosen, owner to confirm): **the sky follows the camera** (D590): every sky mesh is
  centred on the drawing camera; the far-ground e2e check reads the sky (or black) as the background.
- 2026-11-10 (46d.21): medium/high not re-measured (unchanged by the item; 46d.17's shares stand, "unverified on
  target hardware"). The far bricks' own motion output not written: no ghosting seen in the orbit (D591: TAAU runs on
  the 8 km world only with an anti-aliased look).
- 2026-11-11 (46d.18 step 0, default chosen, owner to confirm): **a level below the full resolution that names TAAU
  upscales by it on WebGPU whatever the look's anti-aliasing** (low and medium; the shared cause of D591), with no
  MSAA under it; the level's TAAU is not a look effect, so it brings no contact shadows or reflections the look does
  not draw. At the full resolution (high) a look without anti-aliasing still gets none. WebGL 2 and the Scene view
  keep the spatial upscale over MSAA (no FXAA/SMAA added there).
- 2026-11-11 (46d.18, default chosen, owner to confirm): **what is baked is the brick job's output** (distances, look
  words, occlusion, table, blocks, bounds), not the RGBA colour: the colour stays the page's palette bake, so a
  material record's edit recolours the far field without a re-bake. Normals are not baked (46d.17 measured them as
  +40 % GPU bytes for no gain).
- 2026-11-11 (46d.18, default chosen, owner to confirm): **the far cache bakes every kept node at every level**
  (measured projection 270 MB zstd for the 8 km world, under the 1 GB stop line; §8), in region files of the cache's
  own format (`B<level>/`), one stored entry a node; format 2 add-only, a format-1 cache read as one without bricks
  (a page builds them) and built again by the backend.
- 2026-11-11 (46d.18, default chosen, owner to confirm): **an edit's dirty set is node-granular**: the node over a
  changed ancestor at each level and every node whose read box (margin: the distance band at the node's spacing and
  a cell) meets that ancestor, up to 8 a level (27 at the lowest level). A cell-exact set would be smaller, but the
  mip's opening rule reads across a whole parent node, so a change's reach at a coarse level is its node.
- 2026-11-11 (46d.18, default chosen, owner to confirm): **the rebuilt store lives in the far cache's folder**
  (`rebuilt/`, a file a SHA-256 content key of the build and every cell entry read, 64 MiB kept, oldest first, never
  shipped); the editor's rebuild rewrites the cache's bricks files too, so a reload builds nothing. "Beside the save"
  for a game's run-time saves waits for D594 (the far field does not follow run-time edits yet).
- 2026-11-11 (46d.18, default chosen, owner to confirm): **the backend bakes on up to four threads** (cores − 1) of
  its far cache worker while it serves the old cache; the bench pool bakes in its workers.
- 2026-11-11 (46d.18): the compute brick build for edited nodes not tried (D595): with every node baked the only
  builds left are edits, which run on the backend's worker; it matters once D594 brings run-time edits.

- 2026-11-11 (46d.22, default chosen, owner to confirm): **a tier never scales the near field's reach under medium's**
  (D593): low loads 192 m and draws level 1 to 128 m like medium (resident 62 → 90 MB of its 256 MiB at the town);
  level 0, collision and relief keep low's 0.71. Past the near field the far field's 2 m cells melt buildings.
- 2026-11-11 (46d.22, default chosen, owner to confirm): **the pass check of the coverage bench**: a hole is a sky
  pixel whose ray falls to the world's lowest ground inside the world; the ground under the camera counts when every
  chunk down to the first solid within the ring's height is resident and derived; the camera inside a stand-in is
  sampled at 4 Hz at the eye.
- 2026-11-11 (46d.22, default chosen, owner to confirm): **the load ring narrows with speed** past 20 m/s to
  radius × 20 / speed in whole chunks, never under the collision radius (48 m at 150 m/s), and widens when still; work
  is queued along the way ahead (`motionDistance2`). The far field draws the rest; no far level kept resident (the
  far field alone kept the screen covered before), no near levels 1–2 first at speed.
- 2026-11-11 (OWNER, relayed by session thirdlight-65; tooling, not an item): **gates split by what a change
  affects.** Owner: "Doing full gate runs that take a half hour at a time need to be split up and only run gates on
  affected systems, kept modular and efficient/quick. I think this would help with false failures too. I agree the
  agents.md file needs cleaned up to reflect the current project and objectives." Applied on the branch: vitest
  timeouts 30 s and no wall-clock bounds in unit tests; the fast gate runs `vitest related` on the files changed
  since the branch's last green gate, a two-file core smoke (authoring-loop, play-export; start.e2e.ts quarantined
  into the `startup` area, D417/D453) and the e2e areas of `tools/gate-areas.json`; WebGPU once on a GPU host,
  WebGL 2 one smoke file, the parity specs archived, `--both-renderers` gone (this supersedes the 2026-11-10 lead
  default that the 46d-b close keeps it); `gate.sh area` and `gate.sh phase <start>`; AGENTS.md rewritten. A fast
  gate went from 16 min (whole suite) to 2 min for a docs change. `phase a376c761` once: build + lint + the whole
  unit suite green in 11 min, then OOM-killed at the 7G cap on 3 e2e workers (wide runs use 2 since); its e2e (core
  + 8 areas, 103 files) as `area` on 2 workers: 14.8 min + a 3.4 min rerun alone, about 31 min in all against the
  last full gate's 35. Three tests fail alone that passed at the 46d-b start: D600, to fix before the close.

- 2026-11-11 (OWNER, relayed by session thirdlight-65): low's memory budget is ~4 GB total on an 8 GB minimum-spec
  machine (quote in §2); starting values (proposed by that session, agreed by the owner as values to measure): voxel
  stream 768 MiB, far GPU 384 MiB, texture residency 512 px/m on low; medium/high not below low. Lead placement:
  **46d.23**, after 46d.19 and before 46d.20. Lead's starting split, to be confirmed by 46d.23's measurements:
  page heap ≤ 1.5 GiB, GPU ≤ 2.5 GiB (the GPU side holds the stream's meshes, far atlas and texture arrays, which
  grow most with the new budgets). D597 stays open as a retention check, separate from the budget.

- 2026-11-11 (46d.19, default chosen, owner to confirm): **a voxel draw's program follows its grid and level**
  (`voxelDrawPath`): one solid material reads one set; construction alone at level 0 and every draw from level 1
  out reads one projection, terrain the normal's largest axis (no triplanar blend past 64 m). WebGPU only; WebGL 2
  keeps the one program. Anisotropy at levels 1–2 unchanged (second array textures would cost memory).
- 2026-11-11 (46d.19, default chosen, owner to confirm): **near chunks, nodes and seams are rows of the culled table**
  (tested whole on the GPU, drawn indirect), kept though neutral at the town orbit (1 of 32 tested culled); no
  merged per-level draw: WebGPU has no multi-draw indirect (D602).
- 2026-11-11 (46d.19): the depth prepass (c), packed vertices read in the vertex stage (d: 41–87 µs a chunk on the
  page) and mip nodes without collision/nav/light/occupancy (e: 11–24 % of a mip node's worker time, D601) measured,
  not built. Terrain as static casters measured only (low +1.6 ms, medium +0.5 ms by the meter): the owner decides.
- 2026-11-11 (46d.19, default chosen, owner to confirm): **D600: a still TAAU view holds once the camera's matrices
  stay within 1e-7 an element** of the pose its stillness began at; the editor ignores a `play.stopped` of a play
  other than the one it runs; two e2e reads pin `taau=0` with the reason written.

- 2026-11-11 (46d.23, default chosen, owner to confirm): **low's memory budget is 4096 MiB = page heap 1536 + GPU
  2560** (`LOW_MEMORY_BUDGET_MIB`), the lead's starting split kept: measured at most 868 / 1,210 MiB on the 8 km
  world; the GPU share holds low's budgets (far 384, stream 768, textures 512, saved light) with room for targets.
  The renderer's workers and the editor are not in the page number (RSS to 3.2 GB, D606).
- 2026-11-11 (46d.23, default chosen, owner to confirm): **the starting values kept**: low stream 768 MiB, far GPU
  384 MiB, 512 px/m; medium stream 768, far 384; high far 384 (unverified on target hardware). None binds on the
  8 km world (D605); they are bounds, not targets.
- 2026-11-11 (46d.23, default chosen, owner to confirm): **ring scales no longer follow the stream budget**
  (0.71 / 1 / 1.41 kept as numbers): a budget is memory, a ring is GPU and worker time.
- 2026-11-11 (46d.23): D597's cause was removed voxel meshes kept alive by three's render objects (fixed); the far
  brick and texture copies the page keeps are working set (D604), not leaks.

- 2026-11-11 (46d.20a, default chosen, owner to confirm): **the far bricks draw as a visibility pass and one shade on
  WebGPU** (default; `?farPass=direct` keeps the per-fragment shading for comparisons, WebGL 2 keeps it): the texel
  holds the hit's brick, its place in the brick, its view depth and its entry face (RGBA float, 20 B a pixel with
  its depth: 7.8 MiB at low/medium, 17.6 at high), the smallest the shade can read the atlas from.
- 2026-11-11 (46d.20a, default chosen, owner to confirm): **the shade is a full-screen fragment draw, not compute**: it
  writes the frame's depth and motion attachments, which compute cannot; it keeps the standard material (sun,
  ambient, environment), fogs at the hit's own depth (before: the box's back face) and writes the hit's own motion.
- 2026-11-11 (46d.20a, default chosen, owner to confirm): **normals stay the brick field's gradient** (six reads, now
  once a pixel), not baked (+65 MB at medium, 46d.17 d), since the shade is below the meter's resolution.
- 2026-11-11 (46d.20a): half resolution with reuse (D574) not built: low keeps 23–27 ms of room at 30 Hz.

- 2026-11-11 (46d.20b, default chosen, owner to confirm): **visibility feedback is reduced per brick region on the
  GPU and mapped to nodes on the page** (versioned region owners), a round every 4th pass at 2 × 2 pixels, one out at a
  time, read back with no wait; the far tree keeps sightings per node and ancestor (turn window 6 s).
- 2026-11-11 (46d.20b, default chosen, owner to confirm): **unseen nodes are released only near the far GPU budget**
  (≥ 90 %, at ¼ of their error); below it they keep their detail and only wait behind what is seen. Released at any
  fill the far field never settled with a still camera (D608). Nodes under the near field are never unseen; a node
  that keeps coming back into view is held seen.
- 2026-11-11 (46d.20b): feedback does not help D598 (the near field's work); the Scene view and the voxel world page
  make no rounds (D609).

- 2026-11-11 (46d.15, independent review of 46d-b by a fresh agent that did not build it; range a376c761..b0338420).
  Verdict: close after fixes (H1 gate area map gaps, H2 WebGPU pixel coverage lost with the parity archive, H3 the
  150 m/s ground-under-camera criterion not met). Lead's plan: fix H1/H2/M1/L-test findings (tooling), H3/M2/M3/L7
  (product), M5 + acc46d-b + the owner decisions list (M4) — then close. The page:
  > # 46d-b independent review (a376c761..b0338420, phase-45) — 2026-11-11
  >
  > **Verdict: close after fixes.** The work follows the owner's 11-09/10/11 direction (bricks the default far field, relief off, height in albedo A, blend per material, WebGPU-first compute culling on the one culled table, low = 720p/0.667/TAAU/30 Hz, 4 GB low budget, gates by area). Build checks pass on HEAD (check-size, check-redefinitions, history-comments: OK, run read-only). Three things block a clean close: the new gate map leaves whole packages unmapped (the D600 class of hidden regression stays likely), the parity archive removed the only WebGPU pixel-reference tests along with the WebGL 2 ones, and the owner's 150 m/s pass criterion is not met.
  >
  > ## Findings
  > **H1 Gate area map incomplete.** 265 of 1,574 package sources reach no area: all of `packages/project-model` (173, including `quality-levels.ts`, which turned TAAU on for low, the D600 cause), `packages/shared` (17, imported everywhere), most of `packages/backend` (75, including `far-cache-worker.ts`, `preview-routes.ts`). Changing them runs only the core smoke and `vitest related`. `tools/gate-areas.json` / `tools/check-gate-areas.mjs`. Fix: send unmapped sources (or project-model/shared) to every area, or have check-gate-areas fail on an unmapped source the way it fails on an unmapped e2e file.
  > **H2 Parity archive dropped WebGPU coverage.** `env-parity`, `shader-parity` and `scene-view-parity` (commit 9a49193d, now `archive/webgl2-parity/`) also compared **WebGPU** against frozen references: sky ×5, fog, fog volume, shadows, tone ×3, grading, LUT, bloom, SSAO, DoF, SMAA/FXAA, and the standard/unlit/water/foliage/kit/lightmap/look shader families. The owner asked to cut the doubled WebGL 2 passes, not WebGPU regression checks. Fix: restore the WebGPU half (`project()==='webgpu'` branch) as one file in `environment`/`materials`, keep WebGL 2 out of it.
  > **H3 150 m/s criterion unmet (D598 open).** The owner's criterion (§2, 2026-11-10) is "no hole, no missing ground or collision under the camera". Measured: ground under the camera missing in 12–18 % of updates, and in 45–55 % one second ahead. 46d.22 is marked "done". Fix: reword 46d.22 to "partial", and either fix it (collision ground first and coarser at speed, D601) or put it to the owner as one of the 46d-b decisions before the close.
  > **M1** `tools/voxel-bench/stream-speed.test.ts:73`: the title says "keeps the ground under a focus flying at 150 m/s", but nothing asserts ground in flight. It also asserts wall clock (`knownAfterMs < 1000`, `:113`), which AGENTS.md forbids, and `knownAfterMs` is set on the first unchanged poll, so the check is weak. Fix: assert counts (groundMissing over updates against a bound) and drop the ms bound.
  > **M2 D608 shipped untested on its binding path.** Release is gated at ≥ 90 % of the far GPU budget (f2d6a1eb). The budget never binds on the 8 km world (77–165 of 384 MiB), and release at any fill flapped (33 k jobs). The flapping comes back wherever the budget binds. Fix: a far-seen.test case at a tight budget asserting a still camera settles (jobs → 0), or build the non-flapping release the row names.
  > **M3 D603 (watch, 3 times) looks like a defect, not load.** `replacedChunks` was 752–782 where 8 were expected (`voxel-world.e2e.ts:522`), so an edit's swap counted a whole stream batch. Fix: trace before the close. If it is real, edits re-swap a batch (cost and pop).
  > **M4 Vista item requirements dropped with D-rows only.** 46d.18's "compute brick build tried and measured" was not tried (D595). 46d.19's N4 (one indirect draw per level, D602) and N2/N3/N5 were measured, not built (D601). Fill is 16.3 s at medium against the < 10 s target (D596). Each has a logged reason. Fix: list them on the owner's decisions page; no code needed.
  > **M5** `LOW_MEMORY_BUDGET_MIB` (`quality-levels.ts:308`) is read only by benches. The 4 GB total was measured only in Play inside the editor (D606, D604: 181–317 MiB of CPU brick copies, kit textures twice). Owner requirement "about 4 GB in total" is unverified for a game. Fix: one export measurement (no editor) before acc46d-b.
  > **L1** `tools/gate.sh:45` has a dated comment ("since 2026-11-11"). The history check skips `.sh`.
  > **L2** `tests/e2e/voxel-world.e2e.ts:399,903`: two WebGL 2 loops are still in a file heavily touched this phase. The rule is to cut them when the area is next touched. Cut them; the smoke covers WebGL 2.
  > **L3** `tests/e2e/webgl2-smoke.e2e.ts`: the export it draws is the box scene, not the voxel world. Also `brightPixels > 20` is a very weak bound. Export a voxel scene, or say "no voxel export on WebGL 2" in its header.
  > **L4** `docs/architecture/voxel-render-spec.md:600`: the trace row lists D550/D551/D557/D573 as open; they were fixed in 46d.13c-3.
  > **L5** `tools/voxel-bench/stream.test.ts` is at exactly 2,000 lines (it was 1,969). Split it before the next addition.
  > **L6** `quality-levels.test.ts:134-135` asserts the constant's own value (4096, sum). This is a test of its own code; keep only the "budgets < gpu" check.
  > **L7** The far brick output keeps three paths (`visibility` default, `half`, `direct`), plus the mesh fallback (`voxel-far-mesh.ts:173`). `half` is unused ("not needed", 46d.20a) and D574 is open. Retire `half`, or record why it stays.
  > **L8** The see-through and worker-pool timing bounds were removed (1e3ac083) and no bench reports those timings. A slowdown there is now silent. Add one bench line.
  > Clean: one culling path (`voxel-far-cull.ts` uses occlusion-instances), far cache format 2 is add-only with its owner note (`voxel-render-spec.md:537`), format 1 still reads (`far-world.test.ts:295`), no new per-project caps, the size/redefinition ratchets only shrank, the D600 pins (`taau=0`) carry written reasons.
  >
  > ## Owner requirements 2026-11-09…11
  > Met: height → albedo A (46d.10); relief off on every tier, switch kept (46d.11); blend per material + world default, narrowest wins (46d.11); bricks the far direction / default, mesh fallback (46d.13); WebGPU-first, steps 1–4 on compute over the existing pyramid and table (46d.17/20; WebGL 2 kept direct); low = 720p 0.667 + TAAU, 30 Hz (46d.21); memory ceiling for low only, then 4 GB with medium/high ≥ low (46d.23); post stack and stand-in forest left out; gates split + AGENTS rewrite.
  > Deviated, logged: mesh ~1/4 triangle cut (46d.14 deferred, D581); compute edit build (D595); N4 (D602); fill < 10 s (D596); run-time edits never reach the far field (D594); bevelled edges wait for relief's return.
  > Not met: 150 m/s ground under the camera (H3). Unverified: "order of magnitude of headroom" (low room 15–24 ms at 30 Hz; medium 0.7–2.5 → 6.6–7.6 ms) and 4 GB in a game (M5).
  >
  > ## Owner's eyes / ears
  > 1. acc46d-b pictures (46d.15 not built yet): is the brick far field still "mush"? Also D578 faint lines, D572 near cliff lattice, D607 far lit at the wrong position, D585 camera inside the ground.
  > 2. TAAU on low in motion: ghosting and shimmer on far slopes and roof edges. Only stills and one orbit strip were checked.
  > 3. A 150 m/s flight: does missing ground ahead show or feel wrong? Is H3 acceptable?
  > 4. Medium/high frame times: unverified on target hardware. The workstation meter run (§10) is still wanted.
  > 5. Decisions marked "owner to confirm": the far release policy (D608), the inside-ground look (D585), the terrain-shadow proposal (static casters cost +1.6 ms at low), the WebGPU-only test suite including the parity archive (H2), and the 1.5 / 2.5 GiB split.

- 2026-11-11 (46d.15 second pass, default chosen, owner to confirm): **a camera placed once is not travel**: the
  focus counts as moving only after a run of steps lasting the velocity's smoothing window (0.25 s), and a jump is a
  step longer than the near radius whatever its speed; a ring narrowed for speed widens only after the speed stayed
  down for 1 s.
- 2026-11-11 (46d.15 second pass, default chosen, owner to confirm): **at speed the way ahead is a corridor** 32 m
  either side of the line from the focus to its lead point (two chunks: the chunks on it have their neighbours), its
  work in the near lane, read under the focus first; slower than 20 m/s the lead's ring stays the load ring.
- 2026-11-11 (46d.15 second pass, default chosen, owner to confirm): **the far release policy stays "unseen released
  only near the far GPU budget"**: where the budget binds a still eye settles (M2 test); the half-resolution march is
  retired (L7).
- 2026-11-11 (lead, placement of the streaming/rings decisions): **a new sub-phase 46d-c after the 46d-b close**
  (46d-b closes as built; review H3 is answered by the owner: superseded, D598 superseded): 46d.24 travel at speed by
  the new measures (hitches, settle times, never falling through; mechanisms: no level 0 at speed, cancel stale
  work, collision on its own path, a coarse fallback floor from the far field's 2 m data, D585); 46d.25 fine bricks
  (levels 0–1) built in GPU compute past the detail ring, on demand from the chunks' voxels, never stored, behind a
  switch beside the mesh rings and compared (D593 and 46d.12b poses, meter, fill, the speed measures, memory) before
  anything is retired; pinned regions and path hints for games with a known route are planned there, not built
  unless cheap. 46e still only on the owner's word.

- 2026-11-11 (46d.15, lead, the close): **46d-b closed**. Phase gate gate-phase-20261111-144708 GREEN in 23 min
  (8.5 GB peak, 887 vitest files, 189 e2e tests in core + 8 areas, 105 files, 2 failed once and passed alone) against the previous
  phase close's full gate of 35 min (gate-full-20261109-051432): the phase gate runs the areas the phase touched
  (voxel, rendering, materials, environment, editor-ui, content, play, mcp) and not effects/input/startup in full,
  so the drop is the gate's shape, not lost coverage; voxel-world.e2e.ts 71.1 → 111 s over 46d-b (the export's
  `threads=off` reload, the WebGPU runs that took over the WebGL 2 loops). M5: an export at low holds 2.05–2.46 GiB
  of the 4 GiB budget (§8). acc46d-b published (review page `#acc46d-b`); `approve-46d-b.md` lists the owner's five
  questions first and every default since 2026-11-09 after them (92 entries, 22 carried from approve-46d). Closed
  D-rows stay in the open list until 46d ends (AGENTS.md: they move when a phase ends; 46d-b is a sub-phase).
  Bench note: coverage-cli.ts's camera behaviour and memory readers moved into shared modules (57522215); its
  behaviour is the same source but the coverage bench was not re-run after the move.

- 2026-11-11 (OWNER, answers to acc46d-b / approve-46d-b.md): (1) "Brick far field looks much better to me." (2) Low =
  720p upscaled with TAAU at 30 Hz: "the right target for the current igpu and leaves room for foliage, wind, water,
  and fog systems later." (3) The 4 GB low budget and its split: "Current budget is fine. We can revise if we hit a
  limit later." (4) The vista goals: "I think you met the vistas goals for now" — the deviations (D595, D602, D596,
  D594, 46d.14/D581) accepted as recorded. (5) 46d-c starts in a fresh session (the owner moves orchestration to
  Fable, sub-agents on Opus). The other "default chosen, owner to confirm" entries stand as approved (owner review
  model: defaults left are approved).

- 2026-11-11 (46d.24a, default chosen, owner to confirm): **how the travel measures read** — ground solid = a ray down
  from the camera hits a collider within 3 m of the far cache's level-2 ground under the line; a fall-through = a
  dropped capsule character neither suspended nor standing 6 m under that ground; full detail = level-0 chunks and
  pieces drawn within 1 % (or 2) of their final count for 3 s; nothing pending = every near and far count so (far
  2 %); primary numbers in the export, Play a second column; 30 s recorded after the stop.
- 2026-11-11 (46d.24a, default chosen, owner to confirm): **the starting targets stand unchanged**. Measured on low
  (export): ground solid 0.01 s and nothing pending 7.8–8.5 s already meet theirs, never falling through holds (0 of
  234 drops), longest frame (152–208 ms at 150 m/s, 86–99 at 60) and full detail (3.6–4.4 s for < 2 s) do not; nothing
  measured argues for moving a target before the mechanisms are tried. Medium misses full detail (9.5–15 s) and
  nothing pending (14.5–17 s), unverified on target hardware: no medium targets proposed.

- 2026-11-11 (46d.24b, default chosen, owner to confirm): **a swap's batch is made within a quarter of the frame
  interval a frame** (`VOXEL_BATCH_FRAME_SHARE`, three-adapter; ~8 ms at 30 Hz, ~4 at 60; at least one draw a frame) and
  shown whole in one task once made; batches keep their order. The atomic swap holds for what is shown.
- 2026-11-11 (46d.24b, default chosen, owner to confirm): **level 0 is held back past 40 m/s** (`STREAM_DETAIL_SPEED`):
  at once above it, released after 1 s under it (the ring's widening delay). Held, level 1 is drawn where level 0 was;
  level 0 is still derived inside the collision ring of each focus (camera and characters) so bodies keep their ground —
  the collision-only derive is 46d.24c's.
- 2026-11-11 (46d.24b, default chosen, owner to confirm): **what is cancelled**: level-0 derive jobs still queued for
  chunks that left the collision ring while level 0 is held (sent jobs run on; edits never cancelled), besides what was
  already cancelled (loads/derives of unloaded chunks, mip and far jobs of nodes that left). Air chunks get no new path:
  measured, they cost an index read and no worker job.
- 2026-11-12 (46d.24c, default chosen, owner to confirm): **collision follows the bodies**: a collision-only derive
  (same code and bytes as the full derive's collision) round each character and 0.5 s ahead of it along its velocity, in
  the pool's edit lane; round the camera only while it is not faster than 40 m/s. At speed no streaming level-0 derive goes
  out at all.
- 2026-11-12 (46d.24c, default chosen, owner to confirm): **the coarse floor**: where fine collision is late a body stands on
  a heightfield of the far cache's 2 m ground, each corner the highest coarse top round it; a body 2 m or more under the
  floor's lowest point is in a cave and waits as before; at the hand-over a body the fine ground holds inside it is lifted
  onto it (4 m search), one on a higher floor drops. 4 MiB of node-column tops kept.
- 2026-11-12 (46d.24c, default chosen, owner to confirm): **a stop is 200 ms without a step**: level 0 and its derives come
  back at once; a dip under 40 m/s keeps the 1 s hold. Loads leave a quarter of the pool's queue to derives.
- 2026-11-12 (46d.24c, default chosen, owner to confirm): **a far stand-in seen from inside**: with the eye inside a node's
  box a ray beginning in the solid waits to leave it; a hit deep in the solid within 64 m of the eye is drawn as the
  ground's look from above. From outside the box a side entered under the surface is the step it is (letting it through
  showed the sky).
- 2026-11-12 (46d.24c, default chosen, owner to confirm): **the < 2 s full-detail target is kept for 46d.25**; the mesh rings
  measure 4.6–5.6 s at low after this slice (D620: later than 24b's 3.8–4.5 s).
- 2026-11-12 (46d.24c): pinned regions and path hints planned in §8 "46d.24" (7), not built: neither is a small change on
  the one-second lead. D601 not changed (a draw-only mip derive is a format note, not a few lines).
- 2026-11-12 (46d.24d, default chosen, owner to confirm): **a body under the coarse floor's surface waits**: the floor
  holds a body only over its surface where the body is (0.5 m skin) or where fine collision lies right under it; otherwise
  the body is suspended until its fine collision comes (a placed body at a cliff's foot, a street under rooftop-high floor
  corners, a slide off a floor's edge). Never falling wins over standing at once: at speed 2–11 drops a flight now end
  suspended instead of 1 (D621).
- 2026-11-12 (46d.24d, default chosen, owner to confirm): **loads leave the pool's reserve only while a body's ground
  waits** (collision-only derives queued or wanted); the stop's refill takes the whole queue otherwise. Level-0 derives
  round the camera at speed (24b's) not brought back: no gain at low, medium's missed frames doubled.
- 2026-11-12 (46d.24d, default chosen, owner to confirm): **"falls through" reads the true ground at the body's own
  place**: a body under the world's voxels' top there by 6 m, or ending its drop falling with nothing under it; a body
  that went down to lower real ground is counted apart ("onto lower ground"), the old count kept beside it.
- 2026-11-12 (46d.24d): D618 won't fix (sections at the load ring's edge blocked on neighbours outside it: no work, not
  pending). The < 2 s full-detail target stays with 46d.25 (the level-1 refill bounds the mesh rings' settle).
- 2026-11-12 (46d.25a, default chosen, owner to confirm): **fine bricks are the far tree's levels 0–1**, opened by its
  own selection where their chunks are resident and the near field does not draw them whole, built on the page's
  WebGPU device from the chunks' cell blocks (the CPU build's block, 16 bits a cell), never stored; levels 2+ stay the
  far cache's (no level with two builders). Off by default; `?fineBricks=1`, `setFar({ fine })`, world setting
  `fineBricks`; not a quality-level field until the comparison keeps it.
- 2026-11-12 (46d.25a, default chosen, owner to confirm): **with fine bricks the near field draws only its level-0
  ring**, ending at that ring (no stand-in reach past it); levels 1–2 are not drawn (the node holding the focus stays
  derived); the mesh rings, downsample and seams stay in the code.
- 2026-11-12 (46d.25a, default chosen, owner to confirm): **build budget**: 4 build slots (~4 MiB each), 1 M cells of
  blocks started a frame (at least one), 8 MiB of blocks a far event, 4 ms of block reading an update on the world's
  thread; a fine node foreseen at ~58 KB in the far GPU budget.
- 2026-11-12 (46d.25a, default chosen, owner to confirm): **the GPU build matches the CPU build up to 32-bit rounding**
  (distance bytes ±1 at ties, occlusion ±1, a look vote over at most 8 words a sample, a sample with no shown cell
  taking its brick's nearest earlier look); checked in the browser against `farBricksFromBlock` on the same blocks.
- 2026-11-12 (46d.25b-1, default chosen, owner to confirm): **fine bricks are textured on every tier as the near
  surface** (albedo, normal, ORM, wetness; one read a map, terrain on the normal's largest axis), only on their own
  pixels; `?fineTexture=albedo|off` kept for comparisons. Low did not need albedo only (far pass 5.9 ms either way).
- 2026-11-12 (46d.25b-1, default chosen, owner to confirm): **a fine sample holds its look word, not its colour**
  (no byte more; colours and sets read live, so a record's change needs no rebuild); words carry the construction bit.
- 2026-11-12 (46d.25b-1, default chosen, owner to confirm): **the textures fade to the palette's colour between half
  and all of where level 2 begins** (the error's hand-over, or three chunks short of the load ring): 72–144 m at
  low and medium; the level 1 → 2 boundary joins two palette colours.
- 2026-11-12 (46d.25b-1, default chosen, owner to confirm): **a page that cannot build fine bricks turns them off**
  in the simulation (WebGL 2): the mesh rings come back rather than nothing past the detail ring.
- 2026-11-12 (46d.25b-2, default chosen, owner to confirm): **fine bricks draw sloped roofs as the roof mesher's
  planes** (its reading and top rule, shared), not their stair of cells: the near field's own look past the detail
  ring, at no atlas cost. The far slab is two sample spacings deep (1 m at level 0, 2 m at level 1) so its top stays
  the plane; its underside under an eave sits that much lower than the near mesher's one cell, and at low's level 1 the
  verges and eaves read thick and rounded. Damage by the engine's stages (a fine block has no kit table). The far
  cache's levels (2+) keep their rule (their roofs re-laid in the mip); D627 asks whether level 2 needs the planes too.
- 2026-11-12 (46d.25b-2, default chosen, owner to confirm): **a fine node's side entered half a cell under its surface
  takes the ground's look at any distance** (D626): between fine levels such a side is only ever the seam; coarse nodes
  keep the 64 m rule.
- 2026-11-12 (46d.25b-2, for the owner, before any mesh ring is retired): **what still keeps the back row's roofs from
  OFF's at low (D627)** and the options that keep one path: (a) a level-2 node opens its resident children and leaves
  the rest at level 2 (the selection's all-or-none per node relaxed; no more memory; the hand-off moves to the ring's
  edge); (b) the load ring wider where construction is (~260 m instead of 192 m for the 156 m fine reach: ~1.8× the
  resident chunks there; reads and memory to measure); (c) the roof planes in the far cache's level 2 too (its roofs
  re-laid as 1 m stairs in the mip are the same stair problem at 2 m; a far cache rebuild); (d) keep the level-1 mesh
  ring for construction chunks only. The comparison slice measures (a) and (b) first.
- 2026-11-12 (46d.25b-3, default chosen, owner to confirm): **a level-2 node the load ring ends across opens into its
  resident level-1 children and stays drawn over the rest**, its bricks under fine nodes left out of its brick table (D627);
  the load ring stays the one reach setting, the fine band ending ~2 chunks inside it (no wider ring: ~2× the chunks for
  the last ~40 m at low).
- 2026-11-12 (46d.25b-3, default chosen, owner to confirm): **the comparison's verdict is keep both behind the switch,
  retire nothing now** (§8 "46d.25 comparison: the verdict"): low holds for terrain and travel, construction past ~78 m
  at low and medium's settle (D629, D632) do not; WebGL 2 needs its own answer before any ring goes (keep the rings
  for WebGL 2 only, a CPU fine-brick build in workers, or blobs).
- 2026-11-12 (46d.25c, default chosen, owner to confirm): **near only, the coarser levels do no work at all** (no node
  kept, downsampled or derived) and level 0 is derived only within its ring's reach; waking rebuilds them (D633).
- 2026-11-12 (46d.25c, default chosen, owner to confirm): **near only, level 0 covers what it covers with every ring**
  (no stand-in reach past it): the comparison's detail ring was smaller with fine bricks on; low 60 m/s full detail
  is 5.9 s ON against 4.8 s OFF with the fair ring (25b-3's 1.4 s came from the smaller ring).
- 2026-11-12 (46d.25c, default chosen, owner to confirm): **fine bricks' terrain blends the three triplanar axes**
  (D631): 21 reads a fine pixel instead of 9.
- 2026-11-12 (46d.25c): D632 counted: medium's settle with fine bricks is bound by the 192 m read ring's refill (the
  pool's queue full 2–26 s after a 150 m/s stop), not by the GPU build; the build's order, slots and cancelling
  left as they are.
- 2026-11-12 (lead): placed the owner's bake-level decision (§2 2026-11-12) as **46d.26 in 46d-c**, after 46d.25c and
  before the close; 25c's second full comparison dropped in its favour (46d.26 runs it with baked bricks).
- 2026-11-12 (46d.26a, measured): the 8 km world baked to 0.5 m is **5.0 GB and ~3.7 h on 4 threads** (1 m: 1.36 GB,
  ~1.6 h; 2 m today 355 MB, 24 min); terrain 5.4 / 19.6 / 71 MB a km² at 2 / 1 / 0.5 m, town 3.8 / 10.6 / 30 (§8
  "46d.26"). Under the hard stop (~8 GB, ~12 h): the format and the bake are built.
- 2026-11-12 (46d.26a, default chosen, owner to confirm): **the bake level is the scene's voxel world's
  `bakeLevel`** (2 m default, 1 m, 0.5 m), set by the component commands; a world two scenes name is baked to the finer;
  an export ships levels down to the finest its scenes ask.
- 2026-11-12 (46d.26a, default chosen, owner to confirm): **baked fine nodes store their occlusion** (as the coarse
  levels): not storing it halves the disk (0.5 m world 5.0 → 2.9 GB) but costs ~7 ms of CPU a node on load against a
  0.1 ms decode, and loading is the bottleneck. zstd 19 for exports (−15–45 %) and shared copies of identical bricks
  (37–77 % of fine bricks; a region format change) are not built.
- 2026-11-12 (46d.26a, default chosen, owner to confirm): **one builder, no more exact bake**: the bake is the GPU
  build's CPU oracle (roof planes included), so an edited node rebuilt at run time meets baked neighbours as any node
  does; the pictures' builder problems (D628, D629, D631) are fixed in that one builder.
- 2026-11-12 (46d.26a, default chosen, owner to confirm): **far cache format 3, fine levels in `B0/` and `B1/`** at the
  level's node coordinates (level 0 tiles as the world's region files), a node stored only where it draws something;
  a format-2 cache stays current for a 2 m world; the bake runs by world region column, level 1 first, resumable,
  commands going on meanwhile; edits rebuild exactly their fine nodes at the baked levels through the content-keyed
  `rebuilt/` store.
- 2026-11-12 (46d.26b, default chosen, owner to confirm): **baked fine levels are read wherever the cache holds them for
  the scenes' bake level** (whole in an export; by region column in Play, the voxel world page and the Scene view while
  a bake is under way), decoded in a worker and uploaded as the GPU build lays its samples (look word, occlusion), with
  no build; levels finer than the bake are built where `fineBricks` is on. With fine levels offered the near field runs
  near only on every renderer (WebGL 2 draws the baked bricks in the palette's colours), so a partly baked world on
  WebGL 2 shows 2 m bricks past the detail ring where not baked yet (the editor's state while it bakes).
- 2026-11-12 (46d.26b, default chosen, owner to confirm): **the read ring ends at the detail ring's reach where the
  level drawn past it is baked in every column within the load ring round the focus** (`StreamLod.detailReadReach`:
  level-0 ring + hysteresis + 4.5 chunks, as a chunk drawn at level 0 lies under a level-1 node within the ring and its
  derive reads its neighbours); elsewhere, and on a 1 m world with level 0 built, the ring as set. Looked at as the
  focus enters another chunk, applied without resetting the motion.
- 2026-11-12 (46d.26b, default chosen, owner to confirm): **no baked fine node is read past the detail speed** (40 m/s,
  level 0's rule, both fine levels): they close into level 2 and come back nearest first after the stop. Built
  (compute) fine nodes keep 46d.25's behaviour.
- 2026-11-12 (46d.26b, default chosen, owner to confirm): **low holds baked 0.5 m bricks to 156 m**
  (`FAR_FINE_HOLD_M_BY_TIER`, medium and high the same, not below low; levels 2 and 1 open over it there whatever their
  error, the fade ends no nearer): measured at 110 / 156 / 220 m at the town (far 111 / 134 / 165 MiB of 384, far pass
  7.7 / 6.4 / 6.9 ms within the meter's ±40 %, room 176 / 128 / 128 copies, fill 9.9 / 8.4 / 13.9 s); 220 m adds 700
  nodes and 5 s of fill for back-row eaves only a little thinner than at 156 m.
- 2026-11-12 (46d.26b, default chosen, owner to confirm): **the bake starts when a scene's bake level changes** (a
  command naming `voxelWorld` makes the backend compare the levels its scenes ask; a world asking a finer one is baked
  from then, its far cache built first if needed; a level no longer asked stops its bake); Pause/Resume is a route
  (`POST …/voxels/<world>/far/bake {run}`), not a command: it controls a background job, not project state; a pause
  lasts until resumed or the backend restarts.
- 2026-11-12 (46d.26b): **the benches ran in Play, not an export**: an export ships fine levels only whole, and a whole
  0.5 m bake of the 8 km world is 5.0 GB plus the export's copy (the ≥ 8 GB free rule would not hold); the bench
  regions (the town, the flight's end, near-valley, near-boulders) were baked instead, 39 columns more (27 at level 0,
  12 at level 1), 140 MB, 323 s on 8 threads; the three modes ran in Play the same hour for that reason.
- 2026-11-13 (46d.26c, default chosen, owner to confirm): **fine nodes stay closed only where the near cover hides the
  far field** (the chunk and every chunk round it drawn by the near field), not wherever the near field draws: in the
  cover's edge ring the far field draws behind the near field, and a level 2 kept closed there showed its 2 m roofs past
  the near roofs (D640, fixed 9bc95e2a). Children the cover hides whole are not opened at all.
- 2026-11-13 (46d.26c): D631's hairlines and D634's holes traced, not fixed: the hairlines are the fine field's contour
  steps lit at a grazing angle (not skirts, not the march's tolerance, not the builder's roof rule: no re-bake); at
  every hole frame at speed the near field draws nothing and the cover is empty, so the missing ground is the far
  field's own coarse nodes near the eye (no cover or ordering rule to change).
- 2026-11-13 (46d.26c, default chosen, owner to confirm): **the < 2 s full-detail target stays the target; today's
  detail ring stays the default.** With baked 0.5 m bricks low settles in 3.7–4.0 s, bound by level 0's own refill
  (~6.6 k section derives after the stop for 91 chunks); a ~32 m detail ring at low (the scene's `quality.low.scale`
  0.5) gives 1.9–2.0 s, but windows, frames and fences end ~13 m nearer. The owner's A5 (detail ring unchanged until
  the far-rendering numbers exist) is now the owner's to revisit with these numbers.
- 2026-11-13 (46d.26c, default chosen, owner to confirm): **the comparison's verdict is (ii) in this form**: baked
  0.5 m the recommended setting for new worlds shipped as packaged games (1 m where disk matters and the game targets
  WebGPU), the mesh rings kept as the default for 2 m worlds (compute bricks did not beat them on a 2 m world: full
  detail 0.5–1 s later at low, up to ~3 s at medium); nothing retired, no default changed (`bakeLevel` 2 m,
  `fineBricks` off). What stands in the way of retiring the rings: 2 m worlds on WebGL 2 or without compute (blobs),
  2 m worlds on WebGPU (B slower than A), the detail-ring-only mode's replacement for `stream-lod`/`lod-select`, the
  open look rows (D628, D631, the gravel and river-bed lines) and medium on real hardware. One page:
  `docs/briefs/fine-bricks-comparison-2026-11-12.md`.
- 2026-11-13 (46d.26c): the coverage bench resets the quality levels to the defaults, so a level's `voxelRings` does not
  reach it; a ring candidate is set through the scene's `voxelWorld.quality.<level>.scale`.

- 2026-11-13 (46d-c close, independent review by a fresh agent that did not build it; range fda36fa8..8c5f3e0d).
  Verdict: close after fixes (H1 the 1 m + compute setup only a URL flag, M1 D641 untraced with the packaged-game
  recommendation resting on Play runs, M2 two builders held equal by a tolerance that already failed, M3 risks
  nobody wrote down, M4 gate records, M5 WebGL 2 decided ahead of the owner, M6 "no shimmer" from stills). The
  phase gate that followed (gate-phase-20261113-020301) was RED at vitest: the fine build's private three hooks not
  in the checklist (L1), and the speed and worker-pool tests under load (L2). Lead's plan: this fix slice (the
  gate's failures first, then the WebGL 2 rule, the fine build setting, D641 in an export, D635, the bake's risks,
  the gate records, the owner page and docs), then the phase gate again, then acc46d-c. The review's findings and
  what became of each: §8 "46d-c review fixes". The page:
  > # 46d-c independent review (fda36fa8..8c5f3e0d, phase-45) — 2026-11-13
  >
  > **Verdict: close after fixes.** The work follows the owner's 11-11/11-12 direction (new travel measures, compute fine bricks behind a switch, bake level per world, nothing retired, deferred items untouched). Fix H1 and M1–M4 before the owner is asked to confirm verdict (ii).
  >
  > ## Findings
  > **H1 The recommended 1 m setup cannot be chosen by a game, and the Inspector text describes the wrong default.** Compute fine bricks exist only as the page URL flag `?fineBricks=1` (`three-adapter/src/voxel-fine-bricks.ts:33`, `game-host/src/game-page.ts:742`, `runtime/src/voxel-world-host.ts:115`).
  > There is no project, world or quality field (plan §8 46d.25a:3533 calls it a "world setting"; it is only the streamer's internal option). So "1 m where disk matters and the game targets WebGPU" (owner page :69, :122), which needs the 0.5 m band built by compute, gives a shipped game 1 m bricks past ~78 m.
  > `voxel-world-descriptor.ts:64` says a 2 m world builds finer bricks while playing (false by default: it keeps the mesh rings). The export note at `workspace/src/voxel-worlds.ts:910` says the same. Fix: correct both texts and say on the owner page that C1 needs a setting that does not exist yet (or add it as a world field).
  >
  > **M1 D641 is untraced, and the packaged-game recommendation rests on Play runs.** In every export of the cut world, no level-0 chunk came back after the stop (plan:4407). The one export measure of "full detail" is missing for exactly the case (ii) recommends.
  > 46d.24's voxel-slice exports did settle (3.6–4.8 s), so exports in general are not shown broken. But "detail held as if still fast" is not ruled out, and that would hit every game. Fix: before asking for (ii), re-run with the stop inside the strip (e.g. 3 km) and trace.
  >
  > **M2 "One builder" is two builders, held equal by one tolerance check that already failed.** The bake runs the CPU oracle (`far-bricks-faces.ts`); run-time builds and edits run the WGSL in `voxel-fine-bricks-wgsl.ts` (≤ 8 vote words a sample, :44, where the CPU counts them all).
  > Equivalence is enforced only in `voxel-world.e2e.ts:747-757`: 6–12 nodes of the small test world, looks < 2 %. D635 read 2.47 %. A GPU build has no load dependence, so the jump from 0.2–0.6 % means some blocks really differ. "Watch" is the wrong status.
  > Fix: make D635 open, log which nodes differ, and add a town or construction block to the check.
  >
  > **M3 Risks for a game that nobody wrote down.**
  > (a) A run-time dig past the detail ring in a baked world keeps the baked brick: fine bricks are off, and the edited chunk is outside the shrunk read ring (`far-fine-nodes.ts:93-101`). D594 still describes only the coarse levels; with 0.5 m bricks to 156 m it is now far more visible. Update D594.
  > (b) A full rebuild of the far cache replaces the folder whole (`voxel-far-cache.ts:483`): a brick-build bump or an external edit throws away a 5 GB / 3.7 h fine bake.
  > (c) A bake that fails is swallowed (`voxel-worlds.ts:797` `.catch(() => undefined)`) and restarted by the next far read (:120), with no problem shown. That matters at 5 GB (ENOSPC).
  > (d) `job.changed` is never cleared, so every column that lands re-bakes every change made since the bake began (:807).
  > (e) A scene asking 2 m on a world another scene baked to 0.5 m still draws near-only with baked bricks, and on WebGL 2 loses its mesh rings.
  >
  > **M4 Gate records.**
  > (a) gate-fast-20261112-201901 (head c2b0933a, wide) was RED on `terrain-cdlod.e2e.ts:520` (impostor ratio 0.594 against > 0.6, D376's check). It appears in no plan line and no D-row, and was never re-run: the later gates skipped the levels area.
  > (b) D637 fails alone about half the time inside the range, but it was run alone at the base only once (2bc9f009, which is inside the range; fda36fa8 failed only under load). "Not a 46d-c regression" is not shown, and watch is the wrong status for a test that fails alone.
  > (c) 46d.24a–d's results record no gate at all: 235325 RED (D616) and 035904 RED (D599) appear only in audit rows.
  > Fix: add a D-row and an alone rerun for (a); make D637 open with alone runs ×3 at fda36fa8; add a gate line to §8 46d.24.
  >
  > **M5 WebGL 2 behaviour was decided ahead of the owner's call.** The bake brief §4 left WebGL 2 on baked worlds to the owner, "do not delete the rings on this ground alone". Yet any offered bake turns near-only on for every renderer (`voxel-streamer.ts:1489`), including a partly baked world (2 m blobs while it bakes, 3.7 h on the 8 km world). The brief wanted the editor on compute bricks while a bake is stale, but compute is off.
  > A 1 m world on WebGL 2 now draws worse than today (page :71), against "WebGL 2 keeps what it draws". It is logged as a default (§9 26b), but it is not in the page's "for you to confirm". Fix: list it there, or keep the rings until the bake is complete.
  >
  > **M6 The owner page says "no shimmer or crawl" (:61-62) from stills only.** That is 8 frames 0.25 s apart and 12 frames 0.5 s apart; plan:4320 says motion at full rate is unverified. Fix: label it unverified on the page.
  >
  > **L1** `voxel-fine-bricks.ts:119-121,319-321` uses `backend.device` and `backend.get(texture).texture`, but `docs/three-upgrade-checklist.md` (unchanged in the range) has no row for the file. Add one.
  > **L2** `stream-speed.test.ts:315` (mean over thirds, 85.98 vs 85.67) and `stream.test.ts` failed in gate-fast-20261112-212743 with no watch row. `:100` drives the flight by `performance.now()`: the ordering depends on the clock. Count by updates, or add the row.
  > **L3** D599 repeated 3× in the range with the identical 3,450,364 B. Its own row says to bound it by groups in flight if it repeats. Do that.
  > **L4** Owner page: B's cells are one round and the 32 m ring result is one round, neither labelled. C in Play ran on a world baked only round the bench regions (plan §9 26b), which the page does not say. The in-flight cells for C are of a partly baked world.
  > **L5** `project-model/src/voxel-world.ts:163,177`: `voxelWorldBakeLevel` duplicates the scene walk of `voxelWorldBakeLevels`. Derive one from the other.
  > **L6** `far-fine.ts:139` throws RangeError on a block with more than 4,096 look words (material × wetness × construction can exceed that). Degrade instead of failing the node.
  > **L7** Plan :326, the 46d.24 progress row, ends mid-sentence ("D620 open at that").
  > **L8** Gate time: the voxel area went ~113 s (46d-b close) → 147–176 s. That is explained by the WebGPU fine-brick check (+GPU vs CPU, textured, dig, roof) and the Play bake (+17 s, a second Play). The bake's progress API could be a backend vitest, with only the Inspector state left in e2e. Record the phase-gate time against 46d-b at the close.
  > **L9** D638 (scene-loads, broken since f50e6ab2 in 46d-b) slipped past the 46d-b phase gate. Its area map still does not tie TAAU/post changes to `scene-loads.e2e.ts`.
  >
  > Clean: no history comments, no undocumented `eslint-disable` (none added), no new e2e files, size, redefinition and docs checks OK with no ratchet entry grown.
  > Constants are imported into the WGSL from `@thirdlight/voxel`. The far shade reuses `voxel-surface.ts` `farSurface` and the shared `heaviestTwo`/`triplanarWeights` (no copy).
  > Far cache format 3 is add-only: format 2 stays current for a 2 m world, and an unknown format is refused (`voxel-far-cache.ts:174`). The canonicalizer and field list carry `bakeLevel`; the script pin was re-pinned with a reason.
  > 57882976's "+2 TAAU seed draws" is sound but couples the test to three's TAAU internals. 5abc05c9's dropped pixel-count bound has a sound reason (mips keep the mean; the 7× detail ratio is kept).
  > Relief, detail-piece LODs and GPU tessellation were not revived. No near-mesh detail is stored. 25c's unfair-ring correction (B 1.4 → 5.9–6.1 s) is carried through to the page.
  >
  > ## Owner requirements 2026-11-10…12
  > **Met (low, Iris Xe, at the cap):** longest frame < 100 ms, 0 frames over it (C 46–53 ms, A 53–65 ms); ground solid < 0.5 s (0.03–0.10 s); nothing pending < 10 s with C (4.8–5.3 s). No level 0 at speed, staged swaps, stale work cancelled, collision-only derives round bodies, coarse floor.
  > Also met: compute fine bricks built, compared and behind a switch; nothing retired; bake level per world (2 / 1 / 0.5 m), by region, resumable; format 3 with its owner note; the export ships the asked levels; no baked read past 40 m/s.
  > **Not met:** full detail < 2 s at low (C 3.7–4.0 s, A 5.0–6.0 s; only a ~32 m detail ring gives 1.9–2.0 s, one round, which costs windows and kit pieces: D620). Nothing pending < 10 s with the default mesh rings at 150 m/s (10.2–10.8 s).
  > Also not met: "no hole" at speed on medium (A 7–19 frames, C 0–3: D634). At low it is 0–1.
  > **Never falls through — met as measured, narrowly:** 0 of 83 / 34 drops. The bench drops a body at rest every 2 s and judges it by the true ground (D619's fix). D621: 2–11 drops a flight end held mid-air.
  > A body moving at 150 m/s is not measured (vitest moves one at 60 m/s only: `collision-ready.test.ts:321`).
  > **Deviated, logged:** D618 (won't fix); WebGL 2 draws baked bricks (M5); one builder with tolerance (M2); the benches ran in Play, not an export (§9 26b).
  > **Unverified:** medium/high on target hardware (labelled); full detail in a baked export (D641); a whole 8 km bake and its backend memory (D636); a hosted (HTTP) read rate; motion at full rate.
  > Open rows are fairly described: D585, D613, D617, D620, D621, D622, D628, D631, D634.
  >
  > ## Owner's eyes / ears
  > 1. Motion at full rate, low and medium: the pop where houses enter the detail ring (kit pieces and windows appear), and TAAU shimmer or crawl on textured fine bricks and on the D631 contour lines. Only stills were checked.
  > 2. Baked 0.5 m against the mesh rings at town-west, town-street, near-border and near-boulders (`work/46d.26c/shots/side-by-side/`): is "better at the town, slightly worse at rocks/gravel" right?
  > 3. WebGL 2 on a baked world: flat palette walls past the ring (`gl2A-vs-gl2C`), and the 1 m world's colour bleeding onto walls. Is that acceptable for the fallback?
  > 4. A 150 m/s stop with a character: does being held mid-air (D621) or the coarse floor's drop at the hand-over feel wrong?
  > 5. The 32 m detail ring against the < 2 s target (A5 is the owner's to revisit). Disk: +64 MB/km² for 0.5 m; an export of 579 MB against 162 MB.
  > 6. Decisions marked "owner to confirm" in §9 from 2026-11-11 on, especially fine-hold 156 m on every tier, near-only on every renderer once a bake is offered, and the bake starting on a scene change.
- 2026-11-13 (46d-c review fixes, M5, default chosen, owner to confirm): **a world gives its mesh rings up past the
  detail ring only where it draws 0.5 m bricks there**: where fine bricks are built (`fineBuild: compute`, WebGPU) or
  where its far cache holds level 0 baked for every region column round the focus (the read ring's own test). A world
  baked to 1 m with nothing built, a bake under way or stale round the focus, and a 2 m world keep their level-1/2 rings
  and their whole read ring on every renderer, and the far field draws out from the rings as for a 2 m world. This
  restores the bake brief's "do not delete the rings on this ground alone" for WebGL 2 until the owner has the pictures
  (WebGL 2 on a complete 0.5 m bake draws flat-colour bricks: `gl2A-vs-gl2C`; on the owner page's "for you to confirm").
  The editor's views follow the same rule (the streamer's); the brief's "editor on compute bricks while a bake is stale"
  holds only where the world's fine build is compute.
- 2026-11-13 (46d-c review fixes, M3(e), default chosen, owner to confirm): **a scene draws what its world's cache
  holds**: the cache is the world's (baked to the finest level any scene asks), so a scene asking 2 m of a world another
  scene baked to 0.5 m draws the baked bricks where they are complete round the focus, as that scene does. The scene's
  own `bakeLevel` decides only what is baked and shipped.
- 2026-11-13 (46d-c review fixes, H1): **`voxelWorld.fineBuild: off | compute`, default off**, beside `bakeLevel`: the
  0.5 m (and, at 2 m, 1 m) bricks the bake does not hold are built while playing on WebGPU only where a world asks it;
  the page's `?fineBricks=1` stays as a bench override, and a renderer that cannot build turns it off in every world.
- 2026-11-13 (46d-c review fixes, M2): **one look rule for a sample with no shown cell in reach**: the nearest sample
  before it in its brick with a look, else after, else none: the GPU build's (each brick alone), now the CPU
  builder's too. Not versioned: caches baked before keep the old fallback in those samples until their nodes are built
  again (inside or deep under the surface; the e2e's 64 nodes read 0 looks apart afterwards).

- 2026-11-13 (46d-c, lead, the close): **46d-c closed**. Phase gate gate-phase-20261113-062934 (start fda36fa8):
  build, lint and every unit test green (891 files, 13 skipped), e2e 325 passed, 5 skipped, 1 failed in the run and
  again alone in the gate's own rerun step (`block-editor.e2e.ts:144`, D452: the old block editor's redo not seen;
  no 46d-c commit touches it; it passed alone 30 min earlier at the same code), then passed in `gate.sh rerun`
  (gate-rerun-20261113-065936, GREEN): green on rerun, D452 noted. 28 min, 10.5 GB peak, load mean 7.4, against
  46d-b's 23 min (gate-phase-20261111-144708, 189 e2e tests in core + 8 areas): this gate ran every area (180 files,
  326 tests) because 46d-c changed project-model (`bakeLevel`, `fineBuild`), which maps to every area; the voxel area
  itself 111 → 189 s (the fine-brick GPU-vs-CPU check, textured bricks, roofs, the dig, the Play bake with its
  Inspector progress, the WebGL 2 baked check). A first phase gate (gate-phase-20261113-020301) was RED at the unit
  tests after 12 min (the three-hooks checklist, two clock-bound tests: fixed in 4644fca4) and never reached e2e.
  Review: close after fixes (above); fixes finding by finding in §8 "46d-c review fixes"; not fixed and open: D594
  (a dig past the detail ring in a baked world), D644 (a full far-cache rebuild drops the fine bake), D599, D643.
  acc46d-c published (review page `#acc46d-c`; `approve-46d-c.md`: five questions, 65 defaults listed, 42 new).
  Nothing retired, no default changed (`bakeLevel` 2 m, `fineBuild` off). 46e only on the owner's word.

## 10. Open questions for the owner

46d-c (acc46d-c, `approve-46d-c.md`; defaults in brackets stand if unanswered):

1. Travel at speed: accept the result (no frame over 100 ms, never through), and the < 2 s target: keep the ~45 m
   detail ring and accept ~2–4 s baked / ~5–6 s rings, or shrink low's ring to ~32 m (1.9–2.0 s, windows end ~13 m
   nearer)? (keep the ring; D620 open)
2. Bake level per world (2 m default, 1 m, 0.5 m; cached, by region, resumable): confirm; baked 0.5 m recommended for
   packaged games, 1 m with `fineBuild: compute` for WebGPU games where disk matters. (as built)
3. The mesh rings stay; a world gives them up only where it draws 0.5 m bricks past the detail ring; WebGL 2 draws a
   baked 0.5 m world in flat colour there. (as built, nothing retired)
4. The look past the detail ring with baked bricks: better at the town, slightly worse at rocks, gravel and far
   street roofs (D628, D631); motion is yours to judge. (accepted, rows open)
5. Next: a short 46d-d for D621, D594, D644, D634, or 46e (lighting) now with them carried? (nothing starts without
   the owner's word)
   **Owner 2026-11-12:** neither first: 46f (shared foundations, `docs/plan-phase-46f.md`) comes next, then 46e; the
   four rows are carried. Question 2 was built from the owner's decision of 2026-11-12. Questions 1 to 4:
   the defaults stand until the owner says otherwise.

- 4096² sets now encode in UASTC stripes (D532 fixed, 46d.4c): confirm the method; texture files now import up to
  65.3 MiB (a 4096² RGBA PNG uncompressed, D535 fixed in 46d.4d): confirm the bound.
- The voxel texture set's maps are `albedo` (height in A since 46d.10, owner 2026-11-09), `normal`, `orm`: confirm
  the name `albedo` kept, the brightness height for an albedo without one, and the wetness look (numbers in §9;
  pictures in `work/46d.4d/shots`, `work/46d.10/shots`).

- **The far-field pick:** voxel-mip meshes, ray-marched bricks, or a hybrid — read
  `~/.cache/thirdlight-phase46/far-field-comparison.md` (46d.7d; lead: meshes default, bricks kept, no hybrid).
  Both stay until then. Owner 2026-11-09 chose the brick direction; 46d.13b's bake-off (§8, the
  comparison's new top section) recommended ray-marched bricks v3 at full resolution; 46d.13c-1 made it the default
  everywhere (meshes the fallback) and retired the raster and other variants (in git, f99af3cb …): confirm.
- The relief verdict (46d.1b, §8): low normal only, medium n = 2 in 16 m, high n = 4 in 24 m, n = 8 rejected; and
  whether walls should get parallax occlusion instead of mesh relief.
- Whether relief should also push outward (proud stones) where the collision shape allows it, against the inward-only
  default.
- The engine's physical profiles list (Wood, Stone, Metal, Earth, Glass, Water, Lava) and whether a project's
  profiles may override them.
- Walls next to a roof unblended whole (46d.6c, §9): a two-material wall under a roof now meets in hard cell lines
  over the whole wall face that merges with its top row (pictures `work/46d.6c/shots/*stripe*`); confirm, or say if
  the blend matters more than the 53 k triangles.
- Occlusion culling for voxel worlds (46d.6b): on WebGPU it culls ~71 % of the town's kit pieces and saves 2–3 ms
  GPU at medium/high (`render()` +0.7 ms, D546); should medium/high default `occlusionCulling: on`, or stay a project
  setting? With shadows at high it misses more (D545).
- The high tier (RTX 5090): run the harness page on the workstation against staging (§5c); until then high-tier
  numbers are unverified.
- Whether the 8 km test world (now the realistic one: 644 MB on disk, its far cache 54 MB) is kept after 46d for 46e's measurements; whether it looks real enough (`far-field/realistic/`).
- D560 (a finite world seen from outside its edge misses a strip of its side wall) and D543 (derives at the load
  ring's edge) were deferred by 46d.9: proposed to treat a chunk with no region file as air rather than "not
  coming", and to measure D543 on the flight bench before the far-field pick is built on.
