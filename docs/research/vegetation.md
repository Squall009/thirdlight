# Vegetation on voxel worlds — research and design note (2026-11-12)

**Status: research input, frozen once its phase is planned. Not a plan.** Input to 46f (trees and cover into the culled table), 47b (dressing and rules) and 50 (LODs, impostors, canopy). What is decided is in `docs/decisions/owner-decisions.md`; what is true now in `docs/architecture/voxel-engine.md`.

Read-only study of `phase-45` (worktree `thirdlight-p45`). Not a plan. Nothing was built or measured here:
engine numbers are quoted from the plans, specs and manual; outside facts carry a URL; **J:** marks my judgement.

> **Revised 2026-11-12 (owner decision).** Voxels are the single source of truth: "vegetation rules derived
> from the voxel and material id". Changed: (1) placement reads **voxel-derived fields only**; painted
> density/biome layers are out of the first version; (2) vegetation hangs off the **material record** (a
> dressing reference), taking up plan 45's deferred "material-driven terrain dressing"; (3) roads, rivers and
> water are voxels (road material, liquid role), so "no plants on roads" and "reeds in shallow water" are
> ordinary rule conditions, not spline or layer masks; (4) the 2 m surface map is restated as an exact field
> list, to be reconciled with the backbone note; (5) edits change rule inputs directly; (6) items and decisions
> updated. Sections 1–2 are unchanged.

## 1. What exists

| Part | Files | Bound to |
|---|---|---|
| Rule scatter, stored copies (trees, rocks): hashed candidate grid of 1/density m², conditions, spacing by priority, hand `added`/`erased` per candidate cell, local re-bake on edits | project-model `scatter.ts`, `scatter-surfaces.ts`, `terrain-scatter.ts`, `block-scatter.ts` | Rule maths generic (`ScatterSurface`); storage and both surfaces are old terrain tiles / block chunks (retired in 48) |
| Ground cover, never stored: terrain cover placed in the vertex stage from terrain page texels; other surfaces from point sets baked per chunk on a worker (16 B a point, sorted by threshold) | `cover-placement.ts`, `cover-gpu.ts`, `cover-points.ts`, `cover-points-gpu.ts`, `cover-view.ts`, `cover-worker.ts`, `cover-models.ts`, `mesh-scatter.ts` | Texel path: old terrain. Point sets, rings, thinning: generic |
| Stored copies drawn on the GPU: 48 B a copy, blocks of ≤ 64, per-copy LOD and thinning in the vertex stage | `copies-gpu.ts`, `scatter-worker.ts`, `scatter-host.ts` | Generic draw; old sources |
| Instance sets / brush (10 floats a copy, `MAX_INSTANCES` 65,536 a set) | `instancing.ts`, `attribute-instancing.ts`, `instance-brush.ts`, `view-cull.ts` | Generic |
| Compute culling against the depth pyramid, indirect draws; ~96 B a copy in its pools | `occlusion-pyramid.ts`, `occlusion-instances.ts` | Generic; carries voxel kit pieces and far nodes |
| Impostors: hemi-octahedral 8 × 8 × 128 px = 1024², albedo+coverage and normal, baked on the page (10–25 ms, **11 MB GPU a model**), 3-frame blend, no depth, no shadow | `impostor.ts` | Generic |
| Shadows: blob discs; `shadowDistance` near shadows in 64 m squares | `scatter-shadows.ts` | Generic |
| Wind: global + zones in a camera-centred 64 × 4 m map, two-layer gust noise | `wind-field.ts`, `foliage-nodes.ts` | Generic |
| Bending by entities: up to 4 subjects as head→tail segments in uniforms, eased recovery, rule `bendAway` | `foliage-bend.ts` | Generic, but analytic: no field |

Voxel worlds draw **no vegetation today** (manual `voxel-worlds.md`); only `prop-coverage.ts` stamps a prop's
light coverage.

Measured (plan 40, Iris Xe, 1080p, 60 Hz cap): the GPU cover sweep held to ~2.1–2.9 M triangles in view and
missed at 2.7–4.8 M; default budget 8 clumps/m² to 30 m + 2 /m² to 80 m ≈ 1.2 M tris in 5 draws; vertex-stage
placement cost +3.4 ms scene pass against +1.7 on the CPU path (977k candidate tris for 431k kept); 13 cover
draws ≈ 0.5 ms main thread; 4× MSAA with dense cover ≈ +4.8 ms. Impostors: 542k → 452k tris, 15.2 → 14.6 ms.

## 2. State of the art (verified unless marked)

- **Horizon Zero Dawn placement.** 2D maps ~4 MB/km²; density maps 64² texels a block, 128 m blocks for trees,
  32 m for grass; ordered-dither discretisation; compute density → generate → place with readback; 100k+
  objects, ~250 µs GPU average. https://www.slideshare.net/slideshow/gpubased-procedural-placement-in-horizon-zero-dawn/72897079
- **Ghost of Tsushima grass** (secondary write-ups): a compute thread a blade from a jittered grid and tile
  textures, Bezier blades of 15 / 7 vertices, far tiles drop 3 of 4 blades, far grass is a terrain texture, a
  displacement texture feeds generation. https://tigerabrodi.blog/grass-in-ghost-of-tsushima · https://cainrademan.github.io/Unity-Grass/
- **Unreal.** Impostor Baker: hemi or full layouts, 3-frame blend on an 8-triangle card, Fortnite 12 × 12 at
  2048, optional depth. https://dev.epicgames.com/documentation/en-us/unreal-engine/impostor-baker-plugin-in-unreal-engine
  Nanite assemblies: https://dev.epicgames.com/documentation/unreal-engine/nanite-assemblies. Fortnite's opaque
  leaves over masked cards: search snippet, unverified.
- **Alpha test.** HZD tests alpha in a depth-only pass, shades at equal depth.
  https://80.lv/articles/horizon-zero-dawn-interview-with-the-team
- **Wind.** Crysis main + detail bend from vertex colours
  (https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis);
  Pivot Painter 2, 4 hierarchy levels (https://dev.epicgames.com/documentation/en-us/unreal-engine/pivot-painter-tool-2.0-in-unreal-engine).
- **Browser.** 200k trees, meshes to 100 units then a 16 × 16 atlas at 2048; cut-out cards save ~30 % of pixels;
  no fps stated (https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735). 12 × 12 hemi atlas
  ≈ 9 MB, targets 1 M trees, no fps (https://app.cinevva.com/blog/2026-05-04-open-world-browser-part-19-imposters).
- **WebGPU.** No multi-draw indirect in the spec (https://github.com/gpuweb/gpuweb/issues/1354); Dawn validates
  per indirect buffer: 412 draws in separate buffers ≈ 3 ms, in one ≈ 10 µs
  (https://toji.dev/webgpu-best-practices/indirect-draws); three r182+ batches `indirectOffset`s
  (https://github.com/mrdoob/three.js/pull/32413); `alphaToCoverage` needs MSAA
  (https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgpu/utils/WebGPUPipelineUtils.js).
- **Not public / not found:** Enshrouded foliage, Zelda LOD, Far Cry 5 numbers, canopies baked into far terrain
  (billboard clouds are the nearest: https://graphics.cs.yale.edu/publications/billboard-clouds-extreme-model-simplification).

## 3. Design (J throughout)

### Where vegetation hangs: a dressing reference on the material record

**Recommended:** the material record's `voxel` block names a **dressing asset** (`voxel.dressing: <asset id>`);
the dressing asset is its own file: an ordered list of species entries, each with density, spacing, seed and
conditions. Against a separate rule set keyed by material id: the reference keeps one place to look (the
material the owner paints with), lets many materials share one dressing, lets a material instance
(`instanceOf`, render spec) swap only its dressing, and follows the feeds rule: a record or dressing change
re-derives no voxels, only vegetation cells. This is plan 45's "terrain material recipes generate nearby
dressing". A rule file keyed by id would be a second table to keep in step with 4,096 ids.

**Rule conditions** (all voxel-derived): the cell's material and role (the dressing is found through it, so a
road material simply has none: *no plants on roads*); slope; height; open sky; liquid above and its depth
(*reeds where depth < 0.5 m*, a submerged species where depth > 1 m, wet-bank species within n m of liquid);
distance to a material edge (flowers along a path's verge) and to construction (46c A6: none under
foundations); wetness; the region's climate (temperature, humidity: format spec §2.4); noise terms with their
own scale and seed.

**Variety without a painted layer.** Three levers: (1) *material variants*: "meadow grass" and "forest-floor
grass" are instances of one material with different dressings, painted with the voxel paint tool the owner
already has, so the material id is the biome map; (2) *noise and seeds in the rule*: large-scale noise makes
clearings and clumps, per-species seeds keep neighbours from repeating; (3) *derived context*: altitude,
slope, climate, water distance, shade under canopy. What would still want a painted layer later: thinning
or a clearing on ground that must look and behave identically (today that costs a look-alike variant and a
material id), smooth art-directed gradients finer than 0.5 m cells, and gameplay masks that should not touch
materials. None blocks the first version.

### Placement

- **Never stored.** Dressing + world seed + derived fields → instances per cell. Keep `scatter.ts`'s candidate
  grid, hashed thresholds and local decisions.
- **Two classes.** *Large* (trees, big bushes, boulders): 64 m cells on a **worker** (spacing by priority,
  trunk colliders, picking). *Cover* (grass, flowers, reeds, pebbles): 16 m chunk cells in **compute**, from
  the chunk grid the near shader already uploads, straight into the instance pool.
- **Fields needed at range (2 m, large class only):** top open-sky surface height (u16, 1/8 m); that cell's
  material id (12 bits) and role (4 bits); liquid depth above it (u8, 1/4 m, 0 = dry); a flags byte
  (construction within 2 m, sky fully open). Slope and distance to material edge or liquid are computed from
  neighbours at load, not stored. 6 B a sample ≈ 1.5 MB/km² raw. **Either source the backbone note picks
  works** (a baked 2 m set beside the far cache, or the 2 m far nodes' look words) on one condition: placement
  always reads the 2 m level, never whichever level is resident, so a tree never moves. J: the baked set is
  cheaper to hold to impostor reach. Inside the detail ring only y is refined against real voxels; large
  species grow under open sky only. Cover needs nothing at range.
- **Edits change the inputs directly.** Dig, build, lay a road (voxel material), flood a basin (liquid voxels):
  the changed chunks' cover cells regenerate with their mesh; large cells within the rule's reach regenerate
  when the 2 m fields under them change; thresholds are per candidate, so untouched plants do not move.
  A far node whose materials changed is re-baked by the existing edited-node path and its canopy stamp with it;
  a **dressing** change marks every far node holding that material stale: old canopy shows until a background
  re-bake by region.
- **Hand work (the game's exception list).** `added`: species + position, independent of any rule, so it
  survives a material change under it; it follows the ground, and is hidden (not deleted) while its place is
  air, liquid deeper than the species allows, or construction. `erased` (felled, harvested): candidate address
  (species, cell); it stays valid while that candidate exists and is inert otherwise. Saved by the game.

### Representation by distance

| Range | Large | Cover |
|---|---|---|
| Detail ring (~45–64 m) | LOD0/LOD1 mesh, wind + bending, near shadows | compute clumps, thinned to the ring edge |
| to ~150–250 m | LOD2 mesh, opaque-ish leaves | none: ground colour |
| to ~0.8–1.5 km | octahedral impostors, all species in **one draw** (atlas array) | — |
| beyond | canopy **stamped into bricks** at levels ≥ 2 m at world bake (canopy proxy + mean colour, as `prop-coverage.ts`) | tint in the brick colour |

Levels 0–1 bricks hold no canopy; impostors dither out where level ≥ 2 is certain. Fallback: a 2D canopy
height+colour map per far node.

### Rendering

- One pool, **16 B an instance** (cell-relative u16 × 3, yaw, scale, threshold, variant, tint, normal) in a
  storage buffer; cells are rows of the existing culled table; a compute pass buckets survivors by (mesh, LOD)
  into one indirect buffer; one draw per mesh × LOD.
- Alpha: no MSAA on low, so no alpha-to-coverage. Opaque grass geometry; leaf cards tested in the depth
  prepass only; cut-out impostor cards; dither fades.
- Shadows: blob + `shadowDistance`; beyond, a derived canopy-coverage field as a sun term; baked into far
  bricks.
- **Targets to measure with the headroom meter, not facts** (Iris Xe, 720p30, low): cover ≤ 1.2 M tris /
  ≤ 100k clumps; mesh trees ≤ 400, ≤ 600k tris; impostors ≤ 100k; ≤ 8 ms GPU, ≤ 0.5 ms main thread, ≤ 48
  draws; pool ≤ 24 MB; textures ≤ 64 MB.

### Streaming at 150 m/s

At speed: large cells only, from the 2 m fields (~70 cells/s at 1 km reach, my arithmetic); meshes and atlases
are resident per species, so trees show at once. Cover and trunk colliders wait with level 0; stale cells are
cancelled; after a stop cover fills per chunk inside the 2 s detail target.

### Water and fog as neighbours

Plants read nothing from fog. From water they read derived data only: liquid above a cell, depth, distance to
liquid (wet banks), and flow as an extra bend direction for submerged plants through the interaction field.
Voxel wetness is a condition, never written by vegetation.

### Authoring and pipeline

Editor: a **Dressing** card on the material (species, density, conditions, live preview in the Scene view);
paint materials and variants as now; splines for roads and rivers write voxels and vegetation follows.
MCP: the material and asset commands plus `queryVegetation {box}` (generated counts per species).
Per plant, game-ready (proposed): tree LOD0 ≤ 6k / LOD1 ≤ 1.5k / LOD2 ≤ 300 tris, bush 800/200/60, clump
70/21/6; `_COL` trunk capsule; COLOR_0 R height, G phase, B flutter, plus branch pivots for trees; one 1024²
compressed atlas a species family; impostor baked offline, 8 × 8 hemi at 1024² (albedo+alpha, normal+depth),
KTX2; no hidden geometry; tris per LOD, texture and file sizes reported. Per material: its dressing asset.

### Needed from the shared backbone

The derived fields above with identical values on worker and GPU, change notices per chunk and per 2 m tile,
and the 2 m set to impostor reach; climate per region; the wind map as is; the **interaction field**
(velocity, pressed amount, stamp foot and top height) replacing the 4-subject uniforms; a canopy-coverage
field that vegetation writes and lighting reads.

## 4. Ideas to try, ranked

1. One-draw impostors from a compressed atlas array. 2. Compute LOD bucketing on the culled table. 3. Canopy
in bricks at bake. 4. Cut-out cards, opaque LOD2 leaves. 5. Canopy coverage as far shadow. 6. Impostor depth.
7. Far cover as 1-in-4 tiles.

## 5. Items

| # | Item | When |
|---|---|---|
| V1 | Species asset, offline impostor bake, compressed atlas array, one-draw impostors | now (generic) |
| V2 | Pool + compute LOD bucketing on the culled table, fed by a test list | after 46d-c |
| V3 | Dressing asset + `voxel.dressing` on the material record; rule evaluator on derived fields (TS, vitest) | now for schema and evaluator; needs the derived-field definitions |
| V4 | Large-class worker placement on the 2 m fields; edits; exception list | waits on the derived fields (2 m set / 46d.26) |
| V5 | Cover in compute from chunk grids; water conditions | 47b, liquid derived data |
| V6 | Canopy in bricks; coverage shadows; stale-bake handling | after bake levels |
| V7 | Interaction field, hierarchical tree wind | after V2 and the backbone |

**Risks:** variants used as biome paint eat material ids (4,096 a world); three's per-draw cost with many
species; canopy stamps blobby or popping at the hand-over; 2 m y against real ground; leaf-card overdraw; a
dressing edit staling much of the far bake.

## 6. Decisions for the owner

1. Dressing as a reference on the material record (recommended) or a rule set keyed by material id.
2. Far forests stamped into bricks (recommended) or a separate canopy layer.
3. Trees placed from 2 m fields and only under open sky; the fields' source follows the backbone note.
4. A dressing edit leaves far canopy stale until a background re-bake by region.
5. Hand-placed and removed plants are the game's saved list; hidden, not deleted, when their ground changes.
