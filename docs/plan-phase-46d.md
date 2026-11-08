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

## 3. three.js check

Checked 2026-11-08 at the 46d start (`npm view three time`): **0.187.0 (released 2026-10-30) is still the newest
release** on npm; the branch pins 0.187.0 (`packages/three-adapter`, `packages/editor`). No newer release, so nothing
to assess against `docs/three-upgrade-checklist.md`; no update (owner-only). Items that touch private hooks listed
in the checklist (the shadow pass's use of a material's `positionNode` for displacement, 46d.1b; fragment depth
writes for the brick marcher, 46d.7c) add their hook to the checklist in the same commit.

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
| 46d.7a | **Multi-km test world and the far tree (data):** `run.mjs far-world` writes an engine-owned synthetic test world tile by tile to disk (default 8 × 8 km, mountains to ~1.5 km with cliffs, overhangs and valleys, the town patch at its centre; within the 6 G cap, never held in memory), plus `far-tree.ts`: a chunk tree past the load ring whose nodes (16 m · 2^k) hold voxel mips built from the regions by workers into a derived far cache (never committed; rebuilt per node when an edit lands under it; shipped in an export like distance bricks), streamed by on-screen size over the whole world (no cut-off). Mip readers role-aware: openings narrower than two of a level's cells close in the wall's material (the L1 door/window "legs"). | vitest (tree selection by screen error with hysteresis; far cache bytes deterministic; an edit rebuilds exactly its ancestors; legs closed at L1/L2 on test houses), Node bench | build s/km², cache MB/km², nodes resident vs distance | the world's far data exists for every km; legs closed |
| 46d.7b | **(a) Voxel-mip mesh far field (chunk-tree HLOD):** far nodes meshed by the 46b mesher on their mips, a macro colour + normal per node baked from the material table (the `terrain-macro.ts` idea; one read a pixel), skirts between far levels, dither cross-fade (`dither-fade.ts`) on level change, per-level shader data so a material/wetness paint updates far nodes without a mesh derive (D479); the near rings hand over to it without the ring-edge pop (D516) and tall terrain past the load box draws (D463). `?farField=mesh` and quality field `farField`. | vitest (skirts close seams; shader-only far derive on paints), staging pictures both renderers at 1, 3, 5 km and at the ring edge | GPU ms, CPU ms, triangles, MB, build time, pop seen in a flight | mountains visible from 5 km (seen); D463, D479, D516 closed or re-recorded |
| 46d.7c | **(b) Ray-marched distance-field brick far field:** per far node sparse 8³ distance bricks from the mips (`far-bricks.ts`, the phase-42 brick format's constants and inside/outside codes), a shared 3D atlas + page table, each brick's box drawn and sphere-traced in a TSL fragment shader on both renderers (the `brickDistance` walk of `tracer-wgsl-objects.ts` / `tracer-cpu-objects.ts` ported once, shared with the CPU check), colour from a per-node macro, normal from the field's gradient, depth written so it composes with meshes; `?farField=bricks`; optional hybrid (bricks mid band, meshes horizon) only if 46d.7d's numbers call for it. | vitest (CPU march = shader math on fixed rays; atlas packing; program builds on both backends), staging pictures both renderers at 1, 3, 5 km | GPU ms (the horizon band's pixel cost), atlas MB, build time, crispness, steps a ray | both modes switchable at runtime; nothing cut off |
| 46d.7d | **The far-field comparison:** both modes on the 8 km world, Iris Xe at the cap, both renderers, a multi-km flight and fixed views at 1, 3, 5 km; GPU ms (timestamps), CPU ms, GPU and page MB, build time, crispness (silhouette pictures side by side), pop/transition (frames during the flight); writes `~/.cache/thirdlight-phase46/far-field-comparison.md` (plain words, one table, the pictures, a lead recommendation, what the owner must pick); high tier unverified until the owner runs the harness page (§5c). **Both modes stay.** | `run.mjs stream-page --far …` on staging; pictures looked at | all of the above | comparison written; the owner's pick listed in §10 |
| 46d.8a | **Measurement:** the whole of 46d against §4 at the cap, both renderers: slice, town, flight on the 8 km world, per tier (texel density, relief, far field), texture and page memory, gate and e2e time; misses with causes. | `run.mjs` on staging | §4's table again | numbers + causes in §8 |
| 46d.8b | **Docs and acceptance page:** `voxel-render-spec.md` complete (material record, texture sets, relief part, far data, each step with its owner note), requirement traceability (R88, R89, R111, R112 and the 46d rows), manual (`features/voxel-worlds.md`: materials, texture sets, relief, far field switch, tiers; the material guide of the authoring package updated for heights, depth and surfaces), reference regenerated (`node tools/gen-reference.mjs`); acceptance shots and README in `~/.cache/thirdlight-phase46/acceptance/46d` for review page acc46d (both renderers; near relief, wetness, kit pieces textured, mountains at 1/3/5 km both modes). | check-docs, `tools/manual-links.test.mjs` | — | pages match the code; acc46d ready |
| 46d.9 | **Close (lead):** full gate once (detached, `TL_VITEST_WORKERS=4`), independent review (fresh agent), High/Medium fixes on fast gates, acceptance page acc46d to the owner, STATUS row; then 46e only on the owner's word. | full gate | gate time and peak vs 34 min / 8.0 GB; voxel e2e time | review in the decision log |

## 7. Progress

| Item | Status |
|---|---|
| 46d.1a | not started |
| 46d.1b | not started |
| 46d.2 | not started |
| 46d.3a | not started |
| 46d.3b | not started |
| 46d.4a | not started |
| 46d.4b | not started |
| 46d.4c | not started |
| 46d.4d | not started |
| 46d.5a | not started |
| 46d.5b | not started |
| 46d.6a | not started |
| 46d.6b | not started |
| 46d.6c | not started |
| 46d.7a | not started |
| 46d.7b | not started |
| 46d.7c | not started |
| 46d.7d | not started |
| 46d.8a | not started |
| 46d.8b | not started |
| 46d.9 | not started |

## 8. Results

(empty; one subsection an item, numbers and pictures looked at)

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

## 10. Open questions for the owner

- **The far-field pick:** voxel-mip meshes, ray-marched bricks, or a hybrid — after 46d.7d's comparison
  (`~/.cache/thirdlight-phase46/far-field-comparison.md`). Both stay until then.
- The spike's verdict: subdivision density and relief radius per tier, or the replacement path if the mesh path
  is rejected (46d.1b).
- Whether relief should also push outward (proud stones) where the collision shape allows it, against the inward-only
  default.
- The engine's physical profiles list (Wood, Stone, Metal, Earth, Glass, Water, Lava) and whether a project's
  profiles may override them.
- The high tier (RTX 5090): run the harness page on the workstation against staging (§5c); until then high-tier
  numbers are unverified.
- Whether the 8 km test world (scratch, ~0.5 GB on disk estimated) is kept after 46d for 46e's measurements.
