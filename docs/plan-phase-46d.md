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
| 46d.6d | **Relief shadows from plain casters (D545):** relief chunks cast from their plain surfaces (shadow-only draws), relief meshes cast none and look shadows up at their plain place; both renderers, one draw path. | vitest (real derive + view, program builds), real-worker batch test, staging pictures | town shadows med/high at the cap | D545 closed or re-recorded |
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

## 10. Open questions for the owner

- 4096² sets now encode in UASTC stripes (D532 fixed, 46d.4c): confirm the method; texture files now import up to
  65.3 MiB (a 4096² RGBA PNG uncompressed, D535 fixed in 46d.4d): confirm the bound.
- The voxel texture set's maps are `albedo`, `normal` (height in A), `orm` (46d.4d, D531): confirm the rename and the
  wetness look (numbers in §9; pictures in `work/46d.4d/shots`).

- **The far-field pick:** voxel-mip meshes, ray-marched bricks, or a hybrid — read
  `~/.cache/thirdlight-phase46/far-field-comparison.md` (46d.7d; lead: meshes default, bricks kept, no hybrid).
  Both stay until then.
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
- Whether the 8 km test world (scratch: 476 MB on disk, its far cache 48.5 MB) is kept after 46d for 46e's measurements.
