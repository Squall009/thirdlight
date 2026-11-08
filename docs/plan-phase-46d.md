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
| 46d.1a | done: §4 baseline re-measured (§8). Spike relief mesh (`relief-mesh.ts`, `?relief=n`, `run.mjs relief`): crack-free with plain neighbours, crease weights, other outputs byte-equal (vitest). Ring 32 m slice/hilly 4/16/64× triangles, town 18/69/276× (merges lost); n = 8 fills the low budget. Relief µs p50 0.3/1.0/4.0 ms a section. No displacement yet |
| 46d.1b | done: vertex displacement both renderers + shadow pass, crease attribute, grown bounds, ring fade, test heights; normal from heights on all surfaces. Town n = 2/4 at 32 m: GPU +0.8–1.1 / +0.5 ms WebGPU, ±0 / +0.5 WebGL 2, 0 missed; the vertex stage itself ~0.1 ms. VERDICT: low normal only, medium n = 2, high n = 4, 16–24 m section ring; n = 8 rejected (§8, D528) |
| 46d.2 | done: format spec split (D496), docs only: kits section + §3.9 kit record moved unchanged to `voxel-kit-format.md` (264 lines), `voxel-render-spec.md` skeleton (material record, texture sets, relief part, far-field data); main spec 2,225 → 1,983 lines, pointers left; links re-pointed in the spec, requirements and role spec |
| 46d.3a | done: `MaterialDef` gains `physical`, `gameData`, `voxel` (id, use, kit, tile, height depth, wall/floor/ceiling sets), canonical round trip tested; engine + project profiles with their commands; voxel_id_taken, kit_missing; kit binding from `voxel.kit` (kit list for unnamed ids). Record 414 B; 4,095 voxel materials load in 63 ms, an edit 5.5 ms |
| 46d.3b | done: voxel table from the records (colour, tile, depth; stand-in for the rest), a record edit re-uploads the table only (0.8 ms, 0 meshes; seen WebGPU + WebGL 2); `ctx.voxels.materialAt`/`materialOf`; badges, `f:` filter, voxel-only picker, Inspector voxel section; every voxel material ships with a world. voxel-world e2e 65.6 → 70.8 s |
| 46d.4a | done: albedo+height, normal and ORM arrays from every voxel material's wall/floor/ceiling sets (slot assembly, KTX2 cache), layers in the table; floor/ceiling/wall by face, grid 4 m, terrain triplanar 2 m; patterns under `?patterns=1`; Play/export ship `voxelTextures`. 6 units. Town GPU WebGPU 3.4 → 4.1 ms, WebGL 2 4.7 → 4.8, 0 missed. Seen both renderers |
| 46d.4b | done: quality field `voxelTexelDensity` (low 256, medium 512, high 1024 px/m) caps each voxel array (4096²: levels 2/1/0); arrays stream per level under `texture_budget_mb`, need from the chunks; builds ship them cut; Play, export, Scene view, voxel world page. 2048² sets: 24/96/96 MiB per tier, switch 0.93 s, 0–2 missed; GPU ±0.1 ms. 4096² not assemblable (D532) |
| 46d.4c | done: D532 fixed (4096² in UASTC stripes, 14–49 s a map, mean error ≤ 1.4/255). Kit pieces wear their GLB material (sheet extracted to KTX2, trim U on every map) in Play, export, Scene view, page; debug sets only under `?trimDebug=1`; kit crack maps by brightest texel; Blender export writes the images. Town draws 1,857 either way, GPU ±0.2 ms. D535–D537 |
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

## 10. Open questions for the owner

- 4096² sets now encode in UASTC stripes (D532 fixed, 46d.4c): confirm the method, and whether a texture file may
  exceed 16 MiB on import (D535: busy 4096² PNGs do).

- **The far-field pick:** voxel-mip meshes, ray-marched bricks, or a hybrid — after 46d.7d's comparison
  (`~/.cache/thirdlight-phase46/far-field-comparison.md`). Both stay until then.
- The relief verdict (46d.1b, §8): low normal only, medium n = 2 in 16 m, high n = 4 in 24 m, n = 8 rejected; and
  whether walls should get parallax occlusion instead of mesh relief.
- Whether relief should also push outward (proud stones) where the collision shape allows it, against the inward-only
  default.
- The engine's physical profiles list (Wood, Stone, Metal, Earth, Glass, Water, Lava) and whether a project's
  profiles may override them.
- The high tier (RTX 5090): run the harness page on the workstation against staging (§5c); until then high-tier
  numbers are unverified.
- Whether the 8 km test world (scratch, ~0.5 GB on disk estimated) is kept after 46d for 46e's measurements.
