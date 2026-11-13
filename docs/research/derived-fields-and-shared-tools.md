# The shared backbone for vegetation, water and fog: fields derived from voxels, shared run-time fields, shared tools

**Status: research input, frozen once its phase is planned. Not a plan.** Input to 46f (interaction field, wind sampler), 47a (splines as structures) and 47b (derived fields, the fill, rules). What is decided is in `docs/decisions/owner-decisions.md`; what is true now in `docs/architecture/voxel-engine.md`.

2026-11-12. Read at `phase-45` 5f7c0d21 (read only; nothing built, run or measured). Every size and time is
arithmetic unless a source is cited. Paths are under `packages/`.

> **Revised 2026-11-12 (owner decision).** Voxels are the single source of truth: "One unified underlying voxel
> system that everything is based on from terrain, to building grids, water system, material and physics, fog,
> vegetation rules derived from the voxel and material id."
> - Painted 2D layers, `editLayer` / `undoLayers` / `setWorldLayers` and the Layers rail are **removed** from the
>   first version (§3.6 keeps the door open).
> - The backbone is now: **derived fields** (computed from voxels, never stored), **shared run-time fields**
>   (wind, interaction) and **shared tools** (voxel brushes, one height-based fill).
> - Splines are roads, paths and rivers only, and write voxels. No fog splines.
> - Water is liquid-role voxels; fog is proposed as a new non-solid role. Both read their surfaces and
>   densities as derived data.
> - No new baked set: the far fields are read from the 2 m far cache nodes (§3.1).

## 1. What exists today

| Piece | Where | Bound to | Verdict |
|---|---|---|---|
| Voxel record: material 12 bits, role 4 (10 of 16 used; liquid = 2, shape = its fill), shape 4, wetness 3, 9 reserved | `voxel/src/record.ts`, `docs/architecture/voxel-format-spec.md` | generic | **the source of truth** |
| Voxel strokes: brush (sphere, box, cylinder), fill, stamp; place / add / dig / paint; deterministic apply; world revision and undo | `voxel/src/edit-command.ts`, `edit-apply.ts`, `undo-store.ts`; ops `editVoxels`, `undoVoxels` | generic | **keep; every tool here is a stroke kind** |
| Structures: generated voxels + hand overrides | `voxel/src/structure-overrides.ts` (draft) | generic | splines and water bodies build on it |
| Far cache: level 2 and up of the voxel mips, whole voxel values in the chunk codec; already decoded to 2 m column tops for the fallback floor (4 KiB a 64 m column) | `voxel/src/far-tree.ts`, `far-ground.ts` | generic | **the far fields' input** |
| Spline format, curve maths (`nearest`), mesh, pieces, script reads, drawing, editor handles | `project-model/src/spline*.ts`, `runtime/src/splines.ts`, `three-adapter/src/spline-view.ts`, `editor/src/session/spline-handle.ts` | generic | **keep** |
| Spline shapes and paints ground, clears scatter | `project-model/src/terrain-splines.ts`, `commands/src/terrain-spline-ops.ts` | heightfield terrain | rebuild on voxels |
| Rule scatter core: hashed candidates, `RuleConditions` (height, slope, cavity, noise; `RuleRange {min,max,fade}`), local re-bake, `ScatterSurface` | `project-model/src/scatter.ts`, `surface-rules.ts` | core generic; surfaces are terrain and blocks | **keep core**, add a voxel surface |
| Ground cover in the vertex stage from hashes + ground texels | `three-adapter/src/cover-gpu.ts`, `cover-placement.ts`, `cover-view.ts` | terrain texels, block point sets | keep rings and hashing; input becomes the field window |
| `paint-brush.ts`, block paint, `trim-paint.ts`, terrain/block scatter, `scatter-surfaces.ts` | project-model | blocks, terrain, meshes | voxel tools do not need them; block/terrain ones go in 48 |
| Wind: scene wind + `windZone`, `windAt` (CPU reference), `fillWindMap` into a camera-centred 64² × 4 m map, refilled on change | `project-model/src/wind.ts`, `three-adapter/src/wind-field.ts` | generic | **keep unchanged**; make its sample node public |
| Bending: `foliageBend`, 4 subjects as head + tail segments in uniforms, analytic push | `project-model/src/foliage-bend.ts`, `three-adapter/src/foliage-bend.ts` | foliage only | generalise (§3.5) |
| Edit-mode shell, brush UI and cursor | `editor/src/ui/editmode/*`, `viewport/brush-control.ts`, `brush-cursor.ts` | generic | keep; voxel worlds have no mode yet (`voxel-world/page.ts`: click dig/add) |
| MCP | `mcp-adapter/src/tools.ts` builds `tl_command` from `MUTATION_OPS + VOXEL_WORLD_OPS` | generic | new stroke kinds arrive through `editVoxels` with no new op |

## 2. How shipping tools model it (unchanged research)

Verified:
- **Horizon Zero Dawn**: placement reads streamed 2D "World Data" maps (about 4 MB/km²), part painted, and
  discretises density on the GPU ([slides](https://www.guerrilla-games.com/media/News/Files/GDC2017_VanMuijden_GPUBasedProceduralPlacementInHorizonZeroDawn.pdf), [page](https://www.guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn)).
- **Unreal**: landscape splines deform terrain and write a paint layer ([docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-splines-in-unreal-engine), [API](https://docs.unrealengine.com/4.27/en-US/BlueprintAPI/Landscape/Editor/EditorApplySpline/)); grass ignores splines
  unless a layer is reserved ([forum](https://forums.unrealengine.com/t/tip-remove-procedural-landscape-grass-under-splines-and-steep-areas/266558)); water bodies deform the landscape and feed ground height into depth
  ([API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/Water/UWaterBodyComponent)), river velocity goes into a WaterInfo texture ([cvar](https://indxzero.github.io/ue544cvarwiki/articles/r.water.maxflowvelocity)); PCG reads height and layer
  weights as attributes ([API](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PCG/UPCGGetLandscapeSettings)).
- **Unity**: density maps can be generated from splatmaps and height ([Terrain Tools](https://docs.unity3d.com/Packages/com.unity.terrain-tools@5.1/api/UnityEditor.TerrainTools.DetailUtility.html)).
- **Houdini**: masks derived by feature (height, slope) and combined ([masking](https://www.sidefx.com/docs/houdini/heightfields/masking.html)).
- **Ghost of Tsushima / Yōtei**: wind, displacement, terrain and water position shared across systems; Yōtei
  renders particles and geometry into a displacement buffer ([Tsushima](https://blog.playstation.com/?p=345372), [Yōtei](https://blog.playstation.com/?p=411201)).
- **Far Cry 5**: biomes, texturing and freshwater generated from authored inputs ([talk](https://gdcvault.com/play/1025557/Procedural-World-Generation-of-Far)).
- **Enshrouded**: built with voxel brushes, negative stamps, voxel objects and splines ([Keen](https://enshrouded.com/news/creating-the-world-of-enshrouded)).

Not verified: HZD map resolutions, the WaterInfo channel layout, Tsushima's buffer formats.

My reading after the owner's decision: the heightfield engines need painted maps because a heightfield says
nothing but height. A voxel already says material, role and fill, so most of those maps can be *derived* here.
What carries over is the read side (rules read fields, never curves or meshes) and the one shared displacement
buffer. Enshrouded's tool list is the authoring model.

## 3. The design

### 3.1 Derived fields

One pure function, `surfaceFields(block)`, takes a chunk-shaped block of voxel values plus its apron and gives,
per top-down column, the **surface set**:

| Field | Meaning |
|---|---|
| `height` | top solid surface (fill read as height) |
| `slope` | from the height differences round it |
| `material`, `role` | of that surface cell |
| `sky` | no solid above (caves and interiors read 0) |
| `water.top`, `water.depth` | top of liquid cells above the ground, and the difference |
| `fog` | fog cells above the ground: bottom, top, mean density, material (if the role is approved) |
| `edge.<material>` | distance to the nearest column of another material, up to the apron (jump flood in the block) |
| `spline.<tag>` | distance to the nearest tagged spline (analytic, from `spline-curve.ts`) |

A far node has the chunk's form (same store and codec), so **the same function runs at every level**.

| Range | Input | Where | Stored |
|---|---|---|---|
| Detail ring (about 64 m) | real 0.5 m voxels | the derive workers, as one more derive section (declares its radius, passes the conformance check) | never |
| Past it, to each consumer's reach | the far cache's 2 m nodes (finer where the world is baked finer) | the far workers, widening today's `far-ground` job from tops to the whole set | never |
| Edits | changed chunks and their far ancestors | the paths both already have | — |

**Recommendation on the vegetation agent's baked 2 m surface set: do not bake one.** The far cache already holds
whole voxel values at 2 m and `far-ground.ts` already decodes them into column tops per 64 m column; material,
role, slope and liquid come from the same decode. No new file, no new bake, and edits already refresh it. Cost:
about 12 bytes a column, 12 KiB a 64 m node column, kept least-recently-used as the floor's tops are. Fall back
to a baked set only if the decode proves too slow to measure in at load.

Two limits to know:
- A mip cell holds one value, and a solid role wins it: a 2 m shore cell that is part ground, part water reads
  as ground. Far water edges and any fog over ground need the format answer in §6.
- The set is top-down. Placement near the camera should also call the function's per-point form on the surface
  point itself (its own cell's material and role, the cells above it for sky, water and fog), so cave floors and
  storeys get right answers; the 2D set is for shaders and the far range.

**Consistency.** `surfaceFields` lives once in `voxel`. Shaders never recompute it: they read it from two
camera-centred window textures the workers fill (0.5 m over the detail ring: 256², about 0.5 MB; 2 m over 1 km:
512², about 2 MB; scrolled, edge strips only). A test holds the level-2 result to the level-0 result of the same
ground within a stated tolerance. Scripts read the per-point form (`ctx.voxels`), from loaded chunks.

### 3.2 Splines: roads, paths and rivers

Keep the `spline` component; replace `terrain` and `scatter` with:

- `voxels { shape: flatten | carve | raise | none, falloff, depth, offset, material?, role?, order }`. A road is
  a voxel material painted along the curve. A river carves its bed and writes **liquid voxels** up to its
  surface line (`liquid { material, depth }`).
- `tags [...]`, read as the derived `spline.<tag>` distance.

A spline is a **regenerated structure** (plan 45 §1b and §8: ground, then buildings, then water): moving it
regenerates its voxels and gives back the ground it left; hand edits on it are overrides. "Road", "path" and
"river" are editor presets over these sections, not engine enums. A river meets a lake because both are liquid
voxels: where the river's surface line enters a filled basin the editor snaps that end point to the basin's
level, and the cells simply join. Flow direction is the spline's tangent for river cells; in basins it is the
water agent's derived field.

### 3.3 Shared tools

- **The existing voxel brushes** (`editVoxels`: place, add, dig, paint with material, role, wetness) are the
  brushes for ground, roads, water and fog alike. "Painting a voxel as fog" is `add` with a fog material.
- **One height-based fill**, a new stroke kind `flood` in `voxel/src/edit-command.ts`, applied by
  `edit-apply.ts`: a seed cell, a level (world height), a value (material + a non-solid role), a bounding box and
  cell budget, and an optional `fade` (metres under the level over which the shape falls from full to 0: fog's
  density fade; for liquid the top cell's shape is the fill level). It fills the non-solid cells connected to the
  seed (6-connected) at or below the level, stopped by solids. Integer breadth-first, so deterministic. If it
  reaches the box or the budget it is **refused and names where it leaked**, so the author plugs the gap. The
  same kind with air as the value drains.
- The same pure function is what a later water-body structure ("fill this basin to this level, follow the
  ground") calls when it regenerates: the stroke and the structure share one fill.
- **Editor:** one **World** edit mode on the Scene view with rails Sculpt, Paint, Fill, Splines, Rules. Water and
  fog add material pickers and looks, not tools. `tl_command editVoxels` reaches all of it.

### 3.4 Rules

`RuleConditions` gains voxel-derived conditions only, evaluated by one arithmetic written once over an ops
interface (the `BendOps` pattern) so worker, shader and tests run the same steps:

```
where: { height, slope, noise, cavity,                 // as today
         material: [ids], role: [roles],
         sky, waterDepth, fog,                         // ranges {min?, max?, fade?}
         spline: { <tag>: range }, edge: { <material>: range } }
```

- Grass: `{ material:[grass], slope:{max:35,fade:10}, waterDepth:{max:0} }`
- Nothing beside a road: `{ spline:{ road:{min:1.5,fade:1} } }`
- Reeds: `{ waterDepth:{min:0.05,max:1,fade:0.3} }`
- Moss in caves: `{ sky:{max:0}, material:[stone] }`
- Flowers at the meadow's edge: `{ material:[grass], edge:{ grass:{max:3,fade:2} } }`

The old `layers` condition (terrain material-layer shares) goes with terrain.

### 3.5 Shared run-time fields (three-adapter, visual only)

- **Wind**: unchanged. Its TSL sample (direction, strength, gust at a world XZ) becomes a public adapter node for
  water ripples and fog drift.
- **Interaction field** (replaces the 4-subject uniforms): camera-centred, 256² at 0.25 m (64 m), ping-pong.
  Target 1, RGBA16F: **RG velocity in m/s, B pressed amount, A stamp foot height**. Target 2, R16F: **stamp top
  height**. About 1.3 MB. Each frame: a decay-and-scroll pass, then every entity with an `interactor` component
  (today's `foliageBend`, renamed by an upgrade step) is stamped as a soft capsule footprint.
  - Foliage: bends by velocity and pressed amount where its height is inside foot..top (today's weights).
  - Fog: carves and drags density inside the foot..top span; needs velocity in real units to advect.
  - Water: an impulse where the water surface lies inside foot..top, scaled by speed; its ripple pass is its own.
  - Scripts never read it. Cost to be measured.

### 3.6 What a painted layer would still be the only answer for

One thing: variation the voxels do not express, such as sparse against dense forest, or a flower patch, on the
same grass. First answer, no new system: **material variants** ("grass, forest floor" with the same textures
and its own rules; 4,095 ids, variants are already in the material model). If that floods the palette, the next
steps in order are a few of the 9 reserved bits as a per-voxel variant, then an optional painted density layer
read through the same `where`. None is built now.

### 3.7 Where it lives

| Package | Holds |
|---|---|
| `voxel` | `surfaceFields` (block and per-point forms), the `flood` kind, the spline → voxels generator, the far job |
| `project-model` | spline sections, `where` schema and arithmetic, `interactor` |
| `commands` / `protocol` | nothing new: strokes ride `editVoxels` / `undoVoxels`; splines `setComponent` |
| `workspace` | regenerates spline structures on change |
| `runtime` | per-point reads on `ctx.voxels` |
| `three-adapter` | field windows, interaction field, wind node |
| `editor` | the World mode |

Phase 48 removes `terrain-splines.ts`, `terrain-spline-ops.ts`, `terrain-scatter.ts`, `block-scatter.ts`,
`scatter-surfaces.ts`, the `layers` rule condition, block paint, and cover's terrain texel masks. Generalise
now: a voxel `ScatterSurface` over the per-point form.

### 3.8 Budgets and 150 m/s

- Disk: nothing new.
- Memory: field windows about 2.5 MB GPU, far sets a few MB of CPU cache, interaction 1.3 MB, wind about 64 KB.
  Under 10 MB of the 4 GB.
- At speed: the far set comes from nodes the far field and the fallback floor already read, so no extra reads;
  the detail-ring set is skipped with level 0 above 46d.24's speed threshold (cover is not drawn there either).
  Nothing waits on a field: a missing detail set reads the 2 m one.

## 4. Items, smallest useful first

1. `surfaceFields` in the derive workers and the far job, the `where` arithmetic, per-point reads, tests.
2. Field windows on the GPU and a tint overlay to see a field.
3. A voxel `ScatterSurface`; cover and scatter on voxels (vegetation agent).
4. World edit mode: Sculpt, Paint, and Fill (`flood`).
5. Splines as regenerated structures (road material, river liquid), `spline.<tag>`.
6. Interaction field; wind node public.
7. Fog role, its mip rule and the far answer (after the owner's format decisions).

## 5. Risks

- The structure-override format is a draft; items 5 and the water-body structure wait on it.
- A flood that leaks is refused, which is safe but can annoy in open terrain: the leak report must be good.
- Far fields lose shore water and fog over ground until §6.2 is settled.
- Level-0 and level-2 fields differ at edges; rules crossing the detail ring's edge may pop.
- Material variants can multiply ids and texture slots if variants do not share slots.

## 6. Owner decisions

1. **A fog role** (role 10: non-solid, shape = density, material = fog type) with a mip rule like liquid's?
2. **Liquid and fog in the far cache**: a medium channel beside each far node's cells, or the reserved bits
   (O15, "liquid level in a ground cell", is already their first candidate)? I recommend a medium channel in the
   far nodes only, leaving the record alone.
3. **Reserved bits**: keep all 9 free for now (recommended), using material variants for density variation?
4. **Fill**: a one-off stroke now and a regenerating water-body structure later (recommended), or structure only?
5. **Placement**: items 1–4 as the opening of 47b (recommended), or after the merge with water?
