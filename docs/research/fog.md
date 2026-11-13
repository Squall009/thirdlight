# Fog, mist and volumetrics — inventory, research, design

**Status: research input, frozen once its phase is planned. Not a plan.** Input to 46f (interaction field), 47b (the fog role and painting) and 51 (lit fog, the slab march, the interactive ground fog). What is decided is in `docs/decisions/owner-decisions.md`; what is true now in `docs/architecture/voxel-engine.md`.

> **Revised 2026-11-12 (owner decision).** Fog is now **stored in voxels**, the engine's one source of truth: a
> new non-solid role, the shape bits as density, the material id as fog type. Removed: painted 2D fog layers, fog
> splines and ribbons (withdrawn by the owner), the separate fog-types table. Added: a height-based fill shared
> with water, a camera-centred 3D density window built from resident chunks, a far "fog column" summary, the
> consumers that must ignore the role, and format-spec amendments as proposals. The interactive simulation stays
> 2D and is honest about what that costs against 3D data. Precedent: Keen's 2024 Shroud (§2).

Branch `phase-45` at 5f7c0d21, read only. §1–2 are verified in the cited file or source; §3–5 are judgement.
Every cost is a **target to measure with the headroom meter**, not a fact.

## 1. What exists (verified, paths under `packages/`)

| Thing | Where | State |
|---|---|---|
| Classic and height fog | `three-adapter/src/height-fog.ts` (`scene.fogNode` + sky dome); `FogConfig`, `HeightFogConfig` in `project-model/src/materials.ts`; blended by `runtime/src/environment-blend.ts` | closed-form, on every fogged material |
| Far shade fog | `three-adapter/src/voxel-far-visibility.ts` (`getViewZ: () => hitViewZ`) | the same fog node at the hit's depth: a new fog node reaches the far field for free |
| Fog volumes | `fogVolume` component, `MAX_FOG_VOLUMES = 16` per scene; `fogVolumes()` in `environment-nodes.ts` | post pass: analytic boxes, flat colour, **unlit**, drawn over transparents |
| Sky | `physical-sky.ts` (three's Preetham `SkyMesh`) | no aerial perspective, shafts or froxels |
| Wind | `project-model/src/wind.ts`, `three-adapter/src/wind-field.ts` | zones in a camera-centred 64² × 4 m map; `WindField.sample(p)` in TSL; 2D |
| GPU effects | `three-adapter/src/effects-gpu.ts:583` | `update.wind` reads only the global wind uniforms |
| Foliage bending | `three-adapter/src/foliage-bend.ts` | nothing stamped: 4 subjects per view as uniforms |
| Voxel value | `voxel/src/record.ts`, `docs/architecture/voxel-format-spec.md` §2.2 | 12-bit material, 4-bit role (10 of 16 assigned; larger values **refused by every reader**), 4-bit shape, 3-bit wetness, 9 reserved |
| `liquid` (role 2) | stored, mipped, drawn by nothing | excluded by scattered checks: `OPEN_ROLE` (`voxel/src/assembly.ts:298`), `far-bricks-faces.ts:204`, `far-ground.ts:54`, `voxel-mips.ts:610–700`, `edit-apply.ts:283` (`add` writes into air or liquid) |
| Mips | spec lines 1290–1299 | a parent with any solid role keeps the solid; liquid survives only where no solid is |

## 2. Research (unchanged)

**Keen, 2024** (Feller; video captions, https://www.youtube.com/watch?v=OR8HbFnQdlk): a height map was tried and
dropped; shipped a **world-spanning 1 m voxel grid, R8 index into a lookup of media properties**, full detail
near the camera, hierarchical bitmasks far for empty-space skipping. Froxels near at 16 px per froxel (4 px was
too slow), detail from wind-modulated noise; half-res march far with fixed 4 + 16 + 4 samples. No ms given.

**Keen, 2025** (Krause; slides, https://static.graphicsprogrammingconference.com/public/2025/talks/the-fog-is-lifting-volumetric-rendering-enshrouded/Krause-the-fog-is-lifting-volumetric-rendering-enshrouded.pdf):
16 m voxels in sparse 16³ tiles (distance + density) behind an indirection of 240 m cells; dense fog marched
apart from froxels at half res, 1 ray in 4, reprojected; **4 extra samples toward the sun** for self-shadowing;
temporal accumulation "still needed"; transparents unsolved. No sizes or ms. Neither talk shows pushed fog.

**Froxels.**
- Wronski 2014, 160 × 90 × 64, about 1.1 ms:
  https://www.advances.realtimerendering.com/s2014/wronski/bwronski_volumetric_fog_siggraph2014.pdf
- Frostbite 2015 (via a transcript), PS4: 2.95 ms at 8 px tiles, 0.83 ms at 16 px:
  https://www.slideshare.net/DICEStudio/physically-based-and-unified-volumetric-rendering-in-frostbite
- RDR2, 160 × 88 × 64 to 160 m then a half-res 1-in-4 march (PS4 1.31 ms):
  https://advances.realtimerendering.com/s2019/slides_public_release.pptx
- Nubis' Beer + powder and height-growing ambient for billowy tops:
  https://www.advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf

**Fluids.**
- GPU Gems 38: back-traced advection is stable; "40 to 80 Jacobi iterations", under 20 shows error:
  https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu
- A much-copied WebGL solver: 128², 20 iterations, warm-started pressure, vorticity:
  https://raw.githubusercontent.com/PavelDoGreat/WebGL-Fluid-Simulation/master/script.js
- **No published ms for 2D solvers on integrated GPUs or WebGPU was found.**

**Analogues.**
- Returnal: a Stam solver round the player drives voxel fog:
  https://housemarque.com/news/2021/9/15/returnal-vfx-breakdown
- A Unity gist: 256² density, no pressure solve, a hole at the player that regrows:
  https://gist.github.com/adammyhre/192275218a61156680e1186752418a1f
- **Zelda:** no technical breakdown exists; one second-hand mention of "a fluid simulation behind reactive low
  fog" in the 2026 Ocarina remake, not read at source:
  https://www.gamerfuzion.com/zelda-ocarina-of-time-remake-digital-foundry-60fps-resolution-day-one-update-1-1-1/ .
  L3 below is my reconstruction.

## 3. Design

**The picture is delivered by L3 (simulation + march) over L1 (fog voxels).** Froxels (L2) come last.

### L0 — analytic fog (keep)
Keep `heightFog` as the global haze and the WebGL 2 answer. Move `fogVolume` boxes into the fog node, lit
(retires the post pass and its cap); `update.wind` reads `WindField.sample`.

### L1 — fog as voxels
- **Role `gas`** (value 10), non-solid, beside `liquid`. **Shape = density** in 16 levels (0 none … 15 the
  material's full density), read as a smooth field: trilinear between neighbours, air and solids counting as 0.
- **Material id = fog type**: a material record with voxel use `gas` (a fourth `VOXEL_MATERIAL_USES`): albedo,
  full density (1/m), anisotropy, self-shadow strength, emission, detail-noise scale and erosion, wind response,
  `groundStick`, `interactive` (the simulation applies), regrow seconds. Environment presets blend one density
  multiplier per gas material.
- **One thing per cell.** A cell is solid, liquid or gas. Fog over a lake is gas above liquid cells. **Ground
  contact:** the surface cell is partly solid and holds no fog, so the window build (below) copies a gas cell's
  density one cell down into a terrain or liquid surface cell beneath it when the material has `groundStick`;
  the march stops at scene depth, so fog meets the drawn surface with no gap.
- **Authoring** (the voxel brushes, same panel): *paint fog* (role gas, a material, strength → density), *erase*,
  *smooth density* (the smooth brush on gas shape).
- **Height fill**, shared with water: pick a point and a level; flood through open cells at or below the level,
  bounded by solids and a stated radius; an unbounded fill is refused, not clipped silently. Gas gets density 15
  fading to 0 over a *fade* height below the level; liquid gets full cells and a fill level at the surface.
  One op (`fillVoxels {from, level, value, fade?, radius}`), undo per chunk as any edit.
- **Rules**: static placement (hollows, over water) is **written into voxels at bake** by a generate step, so it
  is visible and editable and stays one truth. Anything time-varying (night, weather) is a **run-time
  multiplier on the gas material**, never a voxel rewrite: "mist over water at night" = baked voxels of a
  night-mist material whose multiplier is 0 by day.

### Run time: how fog voxels reach the GPU
- **Near: a density window.** Chunk derive workers emit, per resident chunk that holds gas, a 16³ block at **1 m**
  (mean of 2³ cells; R8 density, R8 material slot). Chunks without gas emit nothing. The blocks fill a
  camera-centred, toroidally scrolled 3D texture, **128 × 48 × 128 at 1 m** (RG8, 1.6 MB; low tier 96 × 32 × 96),
  with a 4 m min/max mip for empty-space skipping (Keen's bitmask idea). 1 m, not 0.5 m: an eighth of the memory,
  and detail comes from noise. Its extent is the detail ring's; **the voxel read ring is shrinking toward that
  ring, so nothing past it may depend on chunk reads.**
- **Far: baked.** Mips drop non-solid cells wherever a solid shares the parent, so ground fog vanishes from
  levels 2 and up. Proposal: a **fog column summary** in the far cache: per 8 m column, bottom, top, mean
  density, material slot (4 bytes; 62 KB/km²), built with the far cache. The fog node integrates it with 4–6
  jittered samples past the window, in the far shade and sky, so banks read at kilometres. Stacked far fog
  collapses to one run per column.

### L3 — interactive ground fog (the picture)
- **State**: camera-centred 2D fields aligned to the interaction field, scrolled in whole cells: velocity RG16F,
  presence `s` R16F (1 undisturbed, 0 cleared, above 1 piled up), pressure R16F. Low 128² × 0.5 m, medium
  256² × 0.25 m, high 384² × 0.25 m.
- **Binding 2D to 3D data.** A small pass derives a 2D **run map** from the density window: per column, the
  bottom and top of the gas run nearest the view subject's foot height. `s` multiplies density only inside that
  run and only for `interactive` materials. **Limits:** one simulated layer; fog in the cellar and on the floor
  above both draw correctly, but only the subject's storey parts and swirls, the other stays static with wind
  noise; a staircase crossing two runs shows a seam in the response, not in the fog.
- **Step**: semi-Lagrangian advection of velocity and `s`; forces (relax to the wind field; add the interaction
  field's velocity; carve `s` by its pressed amount where the stamp's foot-to-top span overlaps the run; walls
  where the run map ends; relax `s → 1` over the regrow time; optional vorticity confinement); divergence,
  warm-started Jacobi (low 0 or 8, medium 12, high 20), gradient subtract. **L3a** = no solve (pocket and wake);
  **L3b** = solve + vorticity (curling rims).
- **Interaction field, as reconciled**: velocity m/s in RG, pressed amount in B, stamp foot height in A, plus a
  small channel for the stamp's top height. Wind field unchanged.
- **Render**: a half-res march through the density window. Skip to the first gas with the 4 m mip; 8 jittered
  steps inside it (blue noise, TAAU resolves); density = trilinear voxel density × material × `s` × 3D detail
  noise eroding the top, carried by the sim velocity with the two-phase flow trick of `wind-field.ts`. Light: sun
  × cached shadow map × 1–2 density samples toward the sun + ambient rising with height in the run + powder;
  occupancy stops light indoors. Depth-aware upsample, composited before transparents.
- **Targets (Iris Xe, 854 × 480 render, 30 Hz)**: sim low ≤ 0.3 ms, medium ≤ 0.8 ms; march ≤ 1.5 ms, zero with
  no gas in the window; window upkeep under 0.1 ms.
- **150 m/s**: the sim scrolls 10–20 cells a frame, entering strips start at `s = 1`; only wakes are lost. The
  density window needs blocks from chunks as they become resident: at that speed fog appears with the detail
  ring's own lag, the fog column summary covering until then. Above about 30 m/s skip the solve.
- **Many entities**: cost independent of count.

### L2 — froxels (haze, shafts, local lights)
Compute, WebGPU. Low 54 × 30 × 32 (16 px tiles), medium 80 × 45 × 48, high 160 × 90 × 64, to 96 m. Inject height
fog, fog volumes and the density window at low weight (thin gas); dense gas stays in the march. Sun through the
cached shadow map, clustered lights, history about 0.9. Target low ≤ 1.0 ms.

### Gameplay hooks
`ctx.fog.densityAt(x, y, z)` and `materialAt` read the voxels (deterministic; never the simulation). A `fogZone`
trigger at a density threshold. Clearing fog for gameplay is a voxel edit in the runtime overlay.

### Editor, MCP, preview
Voxel edit mode: Fog brush, Fill to height (water and fog), density overlay, "simulate while editing". MCP:
`editVoxels` with role `gas`, `fillVoxels`, gas materials through the material ops, fog diagnostics in
`tl_inspect`.

### Storage and streaming (to measure)
A uniform fog chunk is one palette value: almost nothing. Cost comes from gradients: each density level of each
gas material is a palette entry (up to 15 more per type), and open-air chunks that were uniform air become
stored chunks. Rough bound: 1 km² of fog 3 m deep is 24 M cells; at 4–5 palette bits that is 12–15 MB raw before
the codec, far above a 2D layer; flat fills with a vertical fade repeat per layer and should compress well.
Measure real chunk bytes before promising a figure, and show fog bytes in the editor.

### What must ignore `gas` (follow `liquid`)
`OPEN_ROLE` (mesher, kit cases, collision, occupancy and light, navigation, the `sky` derivation);
`far-bricks-faces.ts:204` and `far-ground.ts:54` (explicit liquid tests); `voxel-mips.ts` (gas adds nothing to a
solid parent; with no solid and no liquid, a parent is gas when its share rounds to 1, shape the mean);
`edit-apply.ts:283` (`add` also writes into gas); assembly class: gas reads as `empty`.

### Format-spec amendments (proposals; owner hard stops)
1. Role 10 `gas`, `VOXEL_ROLE_COUNT` 11: a value-form bump, since readers refuse unknown roles.
2. Shape for gas = density; wetness and reserved bits stay 0.
3. Mip rule for gas (derived version bump).
4. Voxel material use `gas` and its fields.
5. Far cache: the fog column summary (add-only format bump).
6. `fillVoxels` op.

### Items, smallest first
1. Lit fog volumes in the fog node; effects read the wind field. *Independent of voxels.*
2. The march on a test density volume: look sign-off. *Independent.*
3. Role, material use, mips, the ignore list, paint/erase/smooth.
4. Density window + march on real voxels; ground-contact rule.
5. Height fill (with water).
6. L3a on the interaction field, then L3b.
7. Fog column summary and far term.
8. `ctx.fog`; froxels.

### Risks
Ghosting of pockets under TAAU; 16 density levels banding without noise; 1 m window softening thin fog;
storage growth; one simulated layer; fog arriving late at speed; the FSR 1 path has no temporal resolve;
WebGL 2 gets L0 only; the three targets sum to about 3.4 ms on a post stack already at 19–24 % of a frame.

## 4. Decisions for the owner
1. Approve the value-form bump: role `gas`, shape as density (amendments 1–4)?
2. Approve the far-cache fog column summary (amendment 5), or accept no painted fog past the detail ring?
3. Rule-made fog written into voxels at bake with run-time multipliers per material, as proposed?
4. One simulated fog layer (the subject's storey) is acceptable?
5. Low tier: L3a, or no interactive fog on the Iris Xe if targets are missed?
