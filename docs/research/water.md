# Water for Thirdlight (phase 49): research and design, 2026-11-12

**Status: research input, frozen once its phase is planned. Not a plan.** Input to 47a (water bodies), 47b (the fill) and 49 (derive, shader, queries, far channel). Its "static first" stands with one change by the owner: in the editor a body regenerates when the ground is edited (decisions register, 2026-11-12). What is decided is in `docs/decisions/owner-decisions.md`; what is true now in `docs/architecture/voxel-engine.md`.

> **Revised 2026-11-12 (owner decision).** Water is **stored in voxels**, the engine's one source of truth: liquid-role
> voxels painted with the voxel brushes, written by a height-based basin fill (a tool shared with fog) and by river
> splines as regenerated structures. The first version's painted 2D water layer is gone; what it held (surface
> heights, depth, shore distance, flow) is now **derived** from the liquid voxels, as meshes are from solid ones.
> Static water first still stands. New findings from the code: the mips drop shallow water, a dig beside water
> leaves air, and a liquid change feeds mesh and collision today (§3, amendments).

Read-only study of `thirdlight-p45` (branch phase-45). Nothing was built or measured. **[F]** = verified in a source
or the code, **[J]** = judgement, **[T]** = a target to measure with the headroom meter.

## 1. What exists (paths under `packages/`)

| Area | State [F] |
|---|---|
| Voxel liquid | Role `liquid` = 2, shape = fill level, 16 levels (`voxel/src/record.ts`, format spec §2.2). Assembly class `liquid`, open for kit rules ("meshed and simulated by the liquid systems, not here", `assembly.ts`); no render, no collision, light coverage 0 (spec §3.7 table); bodies do not stand on it (`far-ground.ts`). `add` writes into air or liquid; `dig` leaves air (`edit-apply.ts`). Far bricks skip it (`far-bricks-faces.ts:204`). Nothing draws it. |
| Mips | A parent is liquid only **with no solid role in it** (`voxel-mips.ts`, spec "downsample v9"): terrain holds a cell with any fill. |
| River spline | `project-model/src/spline.ts` (`mesh.kind: 'water'`, one `flow`, `foam`), `spline-mesh.ts` (64 m pieces, flow in UV1, bank foam in COLOR_0), `terrain-splines.ts` (carves the old heightfield terrain, not voxels), `runtime/src/splines.ts` (`ctx.splines`). |
| Water shader | `three-adapter/src/material-library.ts` `installWaterNodes`: scrolling normal + Fresnel. Graph node `sceneDepth` (`material-graph.ts`). No scene-colour copy or refraction. |
| Wetness, profiles | 3 bits, shader data only (`three-adapter/src/voxel-surface-wetness.ts`, R111); `material-profiles.ts`: Water 1000 kg/m³, `flowRate` 1. |
| Wind, interaction | `wind.ts` (`windAt`), `wind-field.ts` (64² × 4 m camera map); `foliage-bend.ts`: per-view subject slots as uniforms, no field, no velocity. |
| Reflections, physics | `post-reflections.ts`: half-res SSR + off-screen GPU rays, WebGPU only, transparent receivers unchecked; `physics-rapier` has no buoyancy or fluid volumes. |

## 2. Research

**Enshrouded (Keen, GPC 2025; slides read in full, simulation slides are mostly pictures)** [F]
https://static.graphicsprogrammingconference.com/public/2025/talks/water-simulation-rendering-in-enshrouded/Mantler-Koenen-water-simulation-rendering-in-enshrouded.pdf

- *Simulation:* **columns** ("bottom & height": fluid and displacement sections, stackable), chunks of 16 × 16
  columns, soft real-time, fixed memory, authoritative server. Solver, sources and sinks are not in the slide text.
  The renderer receives voxelised dirty boxes with 16 fill states and **no velocity**.
- *Rendering:* a forest of 107 × 30 × 107 octrees of 96 m; bricks 6³ 8-bit SDF + border (512 B) in a 3D atlas,
  only near surfaces; the CPU alone edits the tree, the GPU sends versioned LOD requests; bricks lerp to a target
  with temporal dither to hide 16-level popping; compute cull against the depth pyramid, indirect brick boxes,
  sphere tracing, a half-width surface buffer.
- *Surface:* detail normals near, 2–3 octave FBM far, **no FFT**; ripples = 1024² planar sim fed by VFX shapes;
  flow from SDF gradient + wind, material by slope (waves → slow flow → white water → waterfall); a shoreline table
  (coast direction, distance, depth 0–3 m); screen-space refraction; SSR with a GI-probe fallback on low;
  pre-rendered caustics; water displaces fog.
- *Numbers:* node pool 20 MB, SDF 64 MB (128 k bricks), shoreline 32 MB, surface 15 + 15 MB at 1440p. RTX 4060 Ti,
  1440p, average/stress: tree 190/200 µs, shoreline 120/125, cull 115/125, surface 180/220, waves+FX 205/230,
  reflections 0.87/1.0 ms, volumetrics 0.64/0.7 ms.
- *Did not work / open:* a second water layer; fill-amount vs fill-height (edge AA, holes, overfill); LOD
  mismatch with terrain; props thinner than a voxel; the near-plane water line; waterfalls and wetness future work.

**Others**
- Unreal Water [F]: river/lake/ocean splines; river points carry depth, width, velocity; rivers use a flow map;
  bodies carve the landscape. https://dev.epicgames.com/documentation/en-us/unreal-engine/water-body-actors-in-unreal-engine
- Horizon Forbidden West [F]: no run-time sim; Houdini sims baked to deformation textures and volumes.
  https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-Water-Malan.pdf
- three.js `webgpu_compute_water` [F]: 128² grid, height + previous height, 4-neighbour wave equation, no WebGL.
  https://raw.githubusercontent.com/mrdoob/three.js/r187/examples/webgpu_compute_water.html
- Valve flow maps [F, search summary only]: a 2D flow vector per point distorts normals in two blended phases.
  https://www.advances.realtimerendering.com/s2010/Vlachos-Waterflow(SIGGRAPH%202010%20Advanced%20RealTime%20Rendering%20Course).pdf
- Far Cry 5 [F, search summary only]: sloped rivers ruled out planar reflections; SSR reused.
  https://www.advances.realtimerendering.com/s2018/The%20Challenges%20of%20Rendering%20an%20Open%20World%20in%20Far%20Cry%205%20(With%20Notes).pdf
- Not opened, no claims: Mei et al. virtual pipes (https://inria.hal.science/inria-00402079), wave particles, Sea of
  Thieves, Assassin's Creed, Ghost of Tsushima, FFT oceans.

## 3. Design

### Central answer: static voxel water first, simulation later over the same voxels [J]

Liquid voxels are the only stored water. They do not move in v1. A **liquid derive** turns them into what is drawn
and queried. Keen's talk supports this split: their sim state and their drawn surface are two structures, and the
drawn one is rebuilt from fill states.

**Against plan-45 §8.** Now matching: the liquid role with no fluid channel, the fill level in the shape, bodies as
structures until export (lake = fill to a level, river = spline), static as the default tier, a flat far surface,
fall points, queries, profile-driven buoyancy. Still different: (1) the surface comes from a liquid derive of column
runs, not from the smooth mesher, because it must carry flow, foam and depth and smooth 3 cm fill steps; (2) the far
surface comes from the far bake's level-0 read, not from mips (finding 1 below); (3) the later settle is a 2.5D
column patch over the voxels, not a 3D cellular flow.

### Authoring and storage

- **Brushes:** the voxel brushes paint liquid materials (role 2; the brush already lists by use).
- **Level fill (shared with fog):** pick a point and a level; flood through non-solid cells from the seed, never
  above the level, bounded by solid voxels; the top cells take the partial fill. A fill that reaches a cell limit or
  open air at the level's rim is refused and reports the leak's place. In the editor a basin is a structure (seed,
  level, material), re-run when the ground under it changes (§8 order: ground, buildings, water).
- **River:** the spline (role `river`; per-point width, depth, optional speed) carves its bed and writes liquid
  voxels along its course to its surface height. Where it meets a basin it writes down to the basin's level, so
  the two bodies are simply adjacent liquid cells.
- **Bank wetness:** the fill and the river write wetness 7 → 1 into solid cells near the liquid (stored voxel
  data; vegetation rules and R111 read it).
- **Bytes:** full liquid cells are uniform runs in the palette codec; no figure until a lake-and-river world is
  benched [T].

### Derived data (never stored, like meshes)

| Range | Built | Holds |
|---|---|---|
| Detail ring (level-0 chunks) | simulation/derive workers, a new `liquid` part per chunk, cached with the chunk's other parts by version | per column up to **2 runs** (bottom, surface height from the top cell's fill, material); lateral liquid–air faces |
| Same ring, GPU | one compute pass into a camera-centred info texture (256² × 0.5 m) | depth, shore distance (dilation, as Keen's shoreline table), flow, foam; for the run nearest the camera's height |
| Past the ring to the horizon | the far bake (CPU builder, level-0 voxels), an add-only **liquid channel** per far node in the far cache | a coarse surface grid per node (height, presence, material) |

- **More than one surface per column** is native: each 16 m chunk holds its own runs, so a cellar pool under a lake
  or a tarn on a plateau draw and answer queries. v1 limits: 2 runs a column a chunk (extra ones dropped, counted);
  ripples and shore foam only on the surface nearest the camera's height.
- **Flow has no bits.** Derived: surface slope (rivers run downhill); inside a river spline's band its tangent ×
  speed; in basins a decay from river mouths plus wind drift, a solved potential later. Overrides live on spline
  points. **No reserved bits in v1** [J]: O15 is not needed for static water (the derive extends each surface one
  cell into the bank and the ground hides it); it stays the first candidate for the settle patch.
- **Cascades:** slope bands pick the look (calm → rapids → white water); a lateral liquid–air face is drawn as a
  fall sheet, so a river written down a cliff is a waterfall with no separate object. Each sheet's foot is a fall
  point (place, flow rate) for the game.
- **Vegetation rules** read "liquid above this cell", depth and shore distance from the liquid part.

### Edits while water is static

- A hole dug in a lake bed: the surface stays as authored. **Proposed rule:** a dug cell below the level of an
  adjacent liquid cell becomes that liquid, so no air pocket shows under water (one cell, no flow).
- A removed bank: nothing spills; the water stands as a wall, drawn as a lateral face. This is the visible cost of
  static water.
- Building into water (`add`) replaces liquid cells, as today.
- **Later settle patch:** reads runs and ground from the voxels round an edit, runs virtual pipes on a bounded
  column grid until still, and writes fill levels back through the edit path into the runtime overlay; the derive
  eases between 16-level steps (Keen's lerp). Only on the owner's word.

### What must handle the liquid role

| Consumer | Today | Needed |
|---|---|---|
| Terrain mesher, kit cases, collision, light | open / none [F] | nothing |
| Feeds mask | role and shape → mesh, collision, nav, light [F] | air↔liquid changes feed only the liquid part and shader data |
| `dig` | leaves air [F] | the backfill rule above |
| Far bricks | skipped [F] | keep skipping (the bed stays visible); add the liquid channel |
| Fine brick build (compute) | not checked by me | must skip liquid as the CPU builder does (byte-equal test) |
| Mips | shallow water lost where terrain shares the parent cell [F] | unchanged; far water does not read mips |
| Navigation | liquid is open: agents walk the bed | a depth mark from the liquid part, later |

**Format-spec amendments (proposals; owner hard stop):** P1 feeds: an air↔liquid change feeds a `liquid` derived
part only. P2 a level flood-fill edit op (seed, level, voxel, leak limit), usable for fog. P3 the dig backfill
rule. P4 derived data: the liquid part (derived version bump). P5 far cache: an add-only liquid channel (version
bump). P6 reserved bits: none taken.

### Rendering by distance

| Band | Technique |
|---|---|
| Near | Per-chunk surface patches from the runs (heights smoothed across cells and chunk borders). Vertex: 3–4 Gerstner waves scaled by the shared wind and by depth, damped on rivers. Pixel: two-phase flow-mapped normals, ripple normal, foam from shore distance and slope, absorption by depth, Fresnel. |
| Reflection | Low: sky + probes. Medium up: the existing SSR once checked on transparent pixels. No planar reflection. |
| Refraction | Medium up: an offset read of scene colour, first tried from the TAAU history [J]. Low: depth tint. |
| Far | The far nodes' liquid channel as flat patches drawn after the far shade against its depth, FBM normals, sun glint; no ripples or refraction. |
| Underwater | Camera-in-liquid test from the voxels; the fog system swaps to a homogeneous medium; a hard water line accepted. |

### Simulation budget [T]

Ripples 256² at 0.25 m, asleep with no subject in water: ≤ 0.3 ms. Info texture pass: ≤ 0.2 ms, only when chunks
change or the camera steps. Surface draw at 720p: ≤ 1.0 ms. Refraction ≤ 0.3 ms or off. Whole system ≤ 2 ms on
low. The liquid derive must not slow the 150 m/s settle: measure it with 46d.24's measures. WebGL 2: no ripples.

### Gameplay hooks (sim worker)

`ctx.water.at(point)` → in liquid, surface height, depth, flow, material profile; answered from the liquid part,
falling back to the voxels. Buoyancy and drag per body from 1–4 sample points with the profile's density and flow
rate; large waves evaluated on the CPU, ripples not. A character "in water / submerged" state; swimming is the
game's.

### Needed from the shared world layers

Spline roles with per-point values; the level fill as a shared tool; derived liquid values readable by the rule
language; wind on CPU and GPU (exists); an interaction field with position, radius and **velocity** for more than
the see-through slots, as a texture foliage and the ripple stamp both read.

### Items

| # | Item | Before the voxel core settles? |
|---|---|---|
| 49.1 | Liquid derive part, `ctx.water`, feeds amendment | needs P1, P4 approved |
| 49.2 | Liquid shader v1 (wind waves, flow, foam, absorption) | yes, on today's river spline |
| 49.3 | Level fill tool, basin structure, river writes voxels, bank wetness | needs P2 |
| 49.4 | Lateral faces, fall sheets, fall points, slope looks | after 49.1 |
| 49.5 | Info texture + ripple compute | needs the interaction field |
| 49.6 | Far liquid channel, underwater view | needs P5 |
| 49.7 | Buoyancy and drag | after 49.1 |
| 49.8 | SSR and refraction tiers | after 49.2 |
| 49.9 | Settle patch | owner's word only |

### Risks

Liquid edits re-deriving mesh and collision until P1 lands; rivers shallower than a far cell needing the liquid
channel everywhere; surface steps of 3 cm on slopes; transparent water under TAAU (`post-taau.ts`); draw order
against the far shade; streaming cost of one more derived part.

### Decisions for the owner

1. Approve the format amendments P1–P5 (P3, the dig backfill, is optional)?
2. Surface from a liquid derive rather than the smooth mesher (the remaining difference from §8)?
3. Static water with standing walls at removed banks for the first release, settle patch deferred?
4. Low tier look: sky/probe reflection and depth tint, no refraction or SSR?
5. Is a sea (one level per world) in phase 49 or later?
