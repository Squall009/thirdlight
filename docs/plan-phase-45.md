# Phase 45 — Voxel world: formats and storage, then phases 46–49 (sub-phases)

Status: **planned, approved by the owner 2026-10-28** (planning sessions 2026-10-27/28). It starts only after phases
43, 44 and 44b are done and merged.

Goal: one voxel world replaces block layers and heightfield terrain as the backend of every level. Authors build with
the tools they use today: brushes, room drawing, interiors, rule placement, materials, paint and scatter. The
voxelization, the mesher and the materials do the hard work, so large amounts of content are fast to author and easy
to vary. The direction is decided (owner, 2026-10-28): there is no go/no-go. Phase 45 settles the formats every
later system depends on (storage, streaming, editing, saves, derived data), by measurement. Phases 46–49 build the
world on them, each in sub-phases (§4).

Background: the voxel research in this session's memory (`voxel-world-research`); Enshrouded (Keen Games) as the
reference; a read-only review of the owner's earlier project `~/projects/cuubz`; `docs/plan-phase-30.md` §1 (the
earlier decision to keep terrain separate, which this phase revisits) and its decision log on why cells did not scale.

## 1. Owner decisions (2026-10-27)

**Process and safety**
- **A branch of its own, never deployed to production.**
  - All voxel work happens on one branch in a separate worktree, like phase 42.
  - The production service keeps running from `main` and never runs branch code.
  - Testing uses a **staging backend** on another port with its own data root and engine-owned test worlds. It runs
    in a memory-capped scope, only while testing.
  - **No copies of the games for testing** (owner, 2026-10-28), except one copy of **Sprout**, the smallest and the
    only one far along, used to test the automatic converter (48a). Game work is frozen during the voxel phases, so
    breaking the games until the projects are updated is fine. Skyforge and Temporal rebuild on the new world (every
    project makes its material kits from scratch anyway); they need the spec sheets and templates (below), not a
    converter run.
- **`main` is frozen while the voxel phases run (3–4 phases).** The owner runs no other phase in parallel.
  - No merges in either direction until the end.
  - The only exception is a production hotfix on `main`, which is also cherry-picked onto the branch.
- **The merge to `main` happens only after the upgrade path is proven.** The converter must have run on the Sprout
  copy, the owner must have looked at the result, and its saves and play must work.
- **Owner hard stops** (owner, 2026-10-28). These three specs are drafted, prototyped and shown to the owner, but are
  **not frozen as v1, and nothing builds on them as final, until the owner approves each one**:
  - the **format spec** (storage, region files, edits, saves, derived data; end of 45);
  - the **role spec** (every role's canonical cases, required/optional pieces and fallbacks; 46b);
  - the **standard trim layout** (texel density, field, strips, caps; 46b).
  The run stops at each and waits for the owner; work that doesn't depend on the spec may continue meanwhile.
- **The decisions in §1–§1e, §5b–§5c, §8 and §9 were worked out with care to remove roadblocks ahead of time** and to
  unify workflows so fewer systems have more than one path. They are requirements, not suggestions:
  - every format and spec traces back to the decisions it serves (45.1 writes that requirements list first);
  - **if a decision doesn't pan out** in measurement or use, it is not dropped: the phase records why, proposes one or
    more replacements that keep the decision's goal (unified workflow, one path), with their costs, and the owner
    chooses before anything is discarded.
- **Spec sheets and art requirements for the game projects.** The games build their own kits and materials, so the
  engine delivers a complete, well laid-out authoring package: the role spec with case diagrams, the trim layout spec,
  Blender templates (kit piece templates per role with the UV regions as guides, scale and pivot rules, LOD and naming
  rules), art-factory Texture Designer graphs per material type, the kit check and a kit test scene, and a manual
  section on making a kit and a material set from scratch.
- **No go/no-go** (owner, 2026-10-28). The voxel world is the way forward whatever the Iris Xe says. Phase 45 is not
  a spike; it chooses the formats by measurement (§3).
- **The Iris Xe is the floor, not the target** (owner, 2026-10-28). It is about as low as current hardware goes and
  is treated as the low tier: 720p at 60 Hz is the goal there, and 720p at 30 Hz is acceptable while the voxel phases
  add features. Mobile-class hardware is no longer a target. Performance still leads the design: every phase measures
  at the display's cap, records the numbers and the cause of a miss, and keeps scaling and streaming in the quality
  tiers; but no phase blocks on a frame-time threshold. A dedicated performance phase follows once 46–49 are done.

**Scope**
- **Hand-authored worlds only.** No procedural or seeded world generation.
- **Performance is the top priority.** Not every game needs editable worlds; the main value is fast authoring with
  easy swapping and variation.
- **Scale: a 10 × 10 km world is the design target** (owner, 2026-10-27, raised from 2 × 2 km). Temporal's city alone
  could be a kilometre across at true scale.
  - Frame cost is set by the near ring and the number of HLOD proxies, not by the world's total size. The size mostly
    loads memory, disk, download and streaming.
  - Pushing to that size is deliberate: it forces every streamed system to scale (meshes, lighting cache and probes,
    simulation, LODs, scatter, texture slot swaps).
  - Full detail near the player; low-detail background scenery out to the horizon.
- **Breaking, debris and structural integrity are game logic, not engine.** The engine provides voxel set/dig and a
  guaranteed path for a gameplay edit to update meshes, collision, the walk graph and lighting.
- **Out of scope, and next:** water. It should use the same voxel technology (river carving, lakes, waterfalls), so the
  voxel format includes a `liquid` role from the start (owner 2026-10-28: water is ordinary voxels, see §8). Also out of scope: multiplayer and procedural
  generation.

**The voxel model**
- **Voxel size is 0.5 m, with no exceptions.** Kit pieces may be thinner than their cell, so a 15 cm ledge is fine.
  This gives walls 0.5 m thick, doors 1 m wide (2 voxels), and storeys in 0.5 m steps.
- **The backend is entirely voxels.** A voxel holds:
  - a material id,
  - a role,
  - shape/density,
  - and an orientation.

  It is stored sparsely. The target is about 4 bytes; 45.2 measures it. Liquids are ordinary voxels with the
  `liquid` role (§8), so there is no separate fluid channel.
- **Roles** say what a voxel is: terrain, foundation, floor, wall, roof, stair, window, door, beam/ledge, pillar, and
  more as the role spec decides. Piece selection reads the voxel's own role, its neighbours' roles and the local case.
- **The rules live in the authoring tools, not in the mesher.**
  - The room tool writes floor, wall and roof roles.
  - Options such as "pillar every 3 m" or "terrace every N m" write pillar and terrace voxels.
  - A voxel one cell out from a wall (not at a corner) becomes a ledge or beam; a run of them is one continuous ledge.
  - The mesher stays local and simple: what is in the voxels is what gets built.
- **Slopes come from roles, with no special pieces.** The same diagonal stair pattern means:
  - a 45° roof piece under the roof role,
  - stairs under the stair or ground role,
  - a smooth slope under the terrain role.

  The roof kit has peaks, gables, hips, valleys and soffits, as the wall kit has corners and caps. Only 45° ships at
  first; a 2:1 (~27°) pattern is a later option.
- **Stamps.** A plain untextured mesh with no UVs (a bridge, say) is voxelized and reused anywhere with any material,
  so it gets a unique look and a unique break and sound profile. A material's break and sound data is something the
  game reads; it has no engine behaviour.

**Materials and kits**
- **Two kinds of material:**
  - *Projected* materials (earth, rock, sand, snow) draw as a smooth surface extracted from density, with bi-planar
    texturing and height blending.
  - *Modular* materials (everything else) draw as hand-modelled kit pieces.
- **A kit belongs to a material *type*, not to one material.** Oak, maple and pine all use the wood kit and differ
  only in textures.
  - The kit carries default behaviour data, and a material may override it.
  - All materials of a kit share its instanced pieces, so draw calls scale with kits × pieces, not with the number of
    materials.
- **One standard trim UV layout for every kit, with no unique-UV exceptions.** Any texture set dresses any kit. A
  unique-UV piece is only a last-resort backup, and should be avoided.
- **Paint overlays** (dirt, moss, snow, wetness, any material) blend in world space with bi-planar projection and
  height-in-alpha. They cross kits, terrain and kit geometry seamlessly, as terrain paint does today.
- **No displacement tessellation.** Detail comes from modelled kit geometry: more hand-made kit content, but cheaper
  geometry.
  - WebGPU and WebGL 2 have no tessellation stage, and a compute-based version would break the one-renderer-path rule.
  - So LODs, instancing and heavy culling are essential.
- **A role spec, versioned in the engine docs.** For each role it lists:
  - the complete list of canonical cases, with rotations and mirrors folded together, each with a diagram;
  - whether each case's piece is required or optional, and its fallback;
  - which neighbour roles change the choice.

  A game knows its kit is complete when the kit check is green. The role spec is an owner hard stop (§1): v1 only
  after the owner approves it.

## 1b. Owner decisions (2026-10-28): workflow, prop occluders, tiles and storage

**Building workflow: structures as editable objects that generate voxels.**
- You pick a material, draw the layout (footprint), and place windows and doors. The tool writes the voxels and
  roles, and the material's kit draws the building with all the role and neighbour rules.
- The building stays an editable **structure** (a source definition), not loose voxels:
  - footprint polygons, storeys and storey height, roof type, material, openings;
  - its generated voxels are a pure function of that definition.
- What that makes possible:
  - **Change the material** on the selection (wood → stone), and it re-meshes into the new kit's pieces. Only
    material ids change.
  - **Copy and paste** duplicates the structure.
  - **Scale** resizes the footprint in 0.5 m steps. It never stretches pieces.
  - **Extend** adds footprint polygons for L-, T- or any shape. Wings join in voxel space, so walls merge and
    junctions get their T-wall cases automatically.
  - **Drag upward** for another floor: the storey count goes up and a floor snaps in.
- **Hand edits on top are kept as overrides.** Manual voxel edits on a structure are stored as a delta over its
  generated voxels, like linked-prefab overrides (39c). Regenerating keeps the overrides that still fit the new shape
  and reports the ones that don't.
- Structures are authoring-time objects. Exports ship the resolved voxels, and gameplay edits and saves work on
  those voxels.
- This is what the architecture generator becomes (§5b): one structure tool, used for every building.

**Large props as light occluders: an opt-in setting.**
- A placed object can be marked **"affects lighting"**. Its shape is then voxelized into a separate **lighting
  occupancy** channel that the phase-42 tracer reads.
  - That channel is never part of the world voxels, so it doesn't affect meshing, roles or collision.
  - Each voxel stores a **coverage fraction** rather than solid/empty: a tree canopy might block 30 %, a fence 20 %.
    Thin and leafy objects then shade softly instead of as 0.5 m blocks.
- **Defaults:** on for large static props (big boulders, trees, large structures); off for scatter, grass and small
  props, which only receive light.
- **Objects that move only occasionally** (a drawbridge, a large gate) re-stamp their occupancy when they move. That
  marks only the chunks nearby for re-lighting.
- **Constantly moving objects** (characters, vehicles) stay receivers only, as phase 42 already decided.
- **Proxies are voxelized at placement into the grid they stand in** (owner, 2026-10-28). A prop's proxy is not a
  grid of its own. When the prop is placed or moved, a quick voxelization pass writes it into the lighting-occupancy
  channel of whichever grid it occupies: a bed or cabinet into its building's grid, a tree or boulder into the world
  grid. Each grid then answers occupancy questions on its own, and there are never hundreds of tiny prop grids.
  - **Fast and accurate.** The model's fine inside/outside shape is computed once at import. Phase 42 already builds
    distance-field bricks for every model at import, at a finer resolution than 0.5 m. Placement then only samples
    that shape at a few points per host cell (e.g. 4 × 4 × 4), using the prop's position, rotation and scale. That
    takes milliseconds and needs no mesh work.
  - **Coverage per cell** is the fraction of sample points inside the model. Cells a solid prop fills completely get
    about 1.0 and occlude fully (a stone pillar, a cabinet's body). Edge cells get partial values. A leafy canopy
    comes out low, from its own shape.
  - **Rotation doesn't break it.** The proxy is never drawn. It only feeds lighting, culling and the camera. A
    cabinet at 30° fills a staircase of cells with partial coverage along its edges, and its error stays within one
    cell whatever its angle. Buildings needed their own grids because their *visible* pieces must line up; proxies
    have nothing visible to line up.
  - It goes into the occupancy channel only, never the world voxels, so meshing, roles and collision are untouched.
  - **Per voxel, not per prop.** A prop that straddles two grids (a tree beside a wall, a cart through a doorway) is
    voxelized into each grid it overlaps.
  - **Overlaps combine:** combined coverage = 1 − (1 − a)(1 − b).
  - **Not stored in files.** The result is recomputed at placement, on move and when a chunk loads, from the prop
    list. Saves and git stay small.
- **Doors and windows use the portal state, not voxels.** Opening or closing a door flips its portal, which is exact
  and immediate, and phase 42's rooms already stop light at a shut doorway. Voxel occupancy is for big shapes, not
  for gating light through openings.

**Worlds grow tile by tile; 10 × 10 km is capacity, not the default.**
- A new world is small. You add tiles where you need them, as the terrain works today.
- Each tile is its own region file on disk. That gives small commits, streams per tile, and splits the world
  naturally.
- Region files are written deterministically: the same content always produces the same bytes, so git sees no
  false changes.
- Git LFS for region files is likely for large or frequent commits. 45.3's repo-growth measurement decides.

**Uniform storage: one compact voxel format everywhere** (owner, 2026-10-28; this replaces the hybrid idea).
- Every chunk is stored the same way. The savings come from the encoding rather than from a second format.
  - **A palette per chunk with bit packing.** A chunk using 3 materials needs 2 bits per voxel for them, not 16.
  - **Uniform chunks collapse to a few bytes.** All-air chunks (sky) and all-one-material chunks (deep ground) are
    most of a world's volume.
  - **Vertical run-length encoding**, column by column. A plain terrain column is roughly "rock × n, soil × m, air",
    which is 2–3 runs. That is nearly what a height map stores, so plain ground costs about what the old terrain tiles
    did without needing a second format.
  - **Density stored only at the surface.** Voxels fully inside or outside the ground don't need it; only the
    boundary voxels carry a density byte for the smooth surface.
  - **Each field in its own plane** (material, role, shape, orientation), then zstd. Planes of similar values
    compress far better than interleaved records.
- Rough estimate for plain terrain at 0.5 m: about 8–10 bytes per column before zstd, 4 million columns per km², so
  about 30–40 MB raw and perhaps 8–15 MB after zstd. That is close to the height-map figure. Unverified; 45.1 measures
  it.
- **Every system still reads through one function, `voxelAt`.** If the measurements ever argue for a cheaper special
  form (such as height maps for huge plain areas), it can slot in behind that function without touching the mesher,
  tools, physics or lighting.

**Tiles and region files.**
- **Chunk:** 32³ voxels = 16 m (16³ vs 32³ decided in 45.2).
- **Tile (region file):** 16 × 16 chunks = 256 m × 256 m, matching today's default terrain tile, with the full world
  height above it. Empty air chunks in it cost almost nothing.
- **Count:** 16 tiles per km², 1,600 tiles for a full 10 × 10 km. A typical game might start with a handful and grow.
- 512 m tiles (4 per km²) would mean fewer files but bigger commits. 256 m is the default.

## 1c. One material model (owner direction 2026-10-28; proposal to settle in 46)

Goal: one material record for every purpose, as few shader variants as possible, and a library that is easy to tell
apart. Solid and liquid materials both carry physics (owner: density also gives games block health, sound profiles
and anything else they need).

**One record, three optional parts.** Every material is the same kind of asset:
1. **Look (always present).** A shader *family* plus a texture set in the standard layout (albedo; normal with
   height in alpha; roughness/metal/AO), plus parameters (tint, tiling, …).
2. **Physical (optional, with defaults).** Mass density, friction and bounciness for solids; flow rate for liquids.
   Engine physics and the liquid simulation read these. Games read them too: density as block health, for example.
3. **Game data (optional).** Sound profile, break tags, any keys a game wants. The engine stores them and never
   interprets them.

On top of these, **voxel use** is optional. A material used in the voxel world names its kit (modular) or `projected`
or `liquid`. A material without it never appears in the voxel tools.

**A handful of shader families, not one shader per material.**

| Family | Used for |
|---|---|
| `standard` | Meshes: props, characters, and kit pieces (the trim layout is the standard layout) |
| `projected` | Voxel terrain-role surfaces: bi-planar, height-blended |
| `liquid` | Water and other liquids |
| `decal` / `effect` | Decals and particles |
| `graph` | The escape hatch: a custom node graph that compiles its own shader. The library marks it with a "compiles its own shader" badge and counts it, so the cost stays visible. |

Hundreds of materials share each family's shader. A material is data: texture-array slots and parameters, never a
new compile. Paint overlays and blending live inside the family shaders. Shader count is roughly families × a few
feature toggles.

**Keeping the library clean.**
- **Capabilities are derived, not separate types.** Each material shows badges for what it can be used for: mesh,
  voxel (with its kit name), liquid, decal. The library filters by them.
- **Tools only list materials that fit.** The voxel brush lists voxel-capable materials; a mesh's material slot lists
  `standard` ones. A wrong pick is impossible, not just discouraged.
- **One oak for everything.** Because kits use the standard layout, the same oak record dresses a table prop and a
  log wall. There are no duplicate "oak (prop)" and "oak (voxel)" records.
- **Variants instead of copies.** Maple is a variant of oak that overrides only its textures and tint, like linked
  prefabs (39c). Fixing the base fixes every variant.
- **Shared physical profiles.** Wood, Stone, Metal, Water, Lava and so on hold the physics and sound defaults.
  Materials reference a profile and override only what differs. Change wood's footstep sound once and every wood
  material follows; the kit's defaults come from the same profiles.

**Existing materials** (today's graph materials, the layered surface material, water and decals) map onto these
families in the migration phase: graph materials that a standard family can express become data, and the rest stay
`graph`.

## 1d. The standard trim layout and tiling (owner question 2026-10-28; proposal)

The current trim sheet will be remade (owner). The worry is that a 0.5 m grid means a texture repeating every 0.5 m.
It doesn't have to: **the voxel size sets the geometry, not the texture repeat.**

- **UVs come from world position along a surface, not 0–1 per piece.**
  - Along a run (the length of a wall, a beam, a ledge), U is the world distance divided by the texture's real-world
    width. A stone texture authored to repeat every 4 m spans 8 voxels without a seam, and pieces join because they
    all read the same world coordinate.
  - Only the trim band across the run (V) is fixed by the layout.
  - Repetition therefore happens at the texture's authored size (2–4 m), never at 0.5 m.
- **Layout proposal (prototyped in 46b, versioned; v1 only after the owner approves it, §1):**
  - **One texel density for everything,** for example 256–512 px per metre. At 720p, 256 px/m is likely enough up
    close, which halves memory on the iGPU.
  - **A field region** that tiles in both directions, world-mapped: big wall and floor faces.
  - **Trim strips** of standard real-world heights (e.g. 0.125, 0.25 and 0.5 m) that tile along U only: beams, ledges,
    mouldings, plank edges, frames. The geometry's dimensions match these heights, so density is the same everywhere.
  - **An end/cap region:** log ends, stone ends, cut faces.
  - **No unique regions** (owner rule).
- **Breaking repetition, cheapest first:**
  1. **Paint overlays and surface rules** already do most of the work: dirt at bases, moss on shaded or north faces,
     wetness, edge wear. The engine has surface rules (`project-model` `surface-rules.ts`) that can drive them.
  2. **A macro variation layer:** low-frequency world-space colour and roughness noise over everything. The terrain
     macro texture is the same idea.
  3. **Piece variants:** each kit case may have 2–4 variants (different brick breaks, knots, cracks), chosen by a
     hash of world position, so the choice is deterministic and stable.
  4. **Per-run offset and tint jitter:** each run starts at a random U offset with a slight hue and value jitter,
     also hashed.
  5. **Stochastic (hex-tile) sampling** hides tiling on any surface but costs about three texture reads. Use it only
     where it pays (large projected terrain), and measure it on the Iris Xe.
- **Doors, windows and glass are props, not trim** (owner, 2026-10-28). The door and window roles make the
  *opening* and its frame from kit pieces in the trim layout. The leaf, glass, shutters and hardware are props that the
  structure tool places into the opening automatically, picked by opening size. Openings come in standard sizes
  (multiples of 0.5 m: a 1 × 2 m door, a 1 × 1 m window, …), so door and window props are authored to fit them. The
  props keep their own unique-UV materials, which keeps the trim layout free of unique regions. A door prop drives its
  portal's open/shut state.
- **Texel density scales by tier** (owner): the lowest spec is 720p at 60 Hz with 256 px/m; the high end (an RTX
  5090) is 4K at 60 Hz with 1024 px/m.
  - Textures are authored once at 1024 px/m.
  - Each tier caps which mip levels stay resident: low keeps up to 256 px/m, medium 512, high 1024. One asset set, no
    per-tier copies.
  - At 1024 px/m a 4 m repeat is 4096² per map, about 60 MB per material for three compressed maps with mips. That is
    fine on a 32 GB card and impossible on the iGPU, which is exactly why the cap is per tier.
  - Other tier-scaled values: the near-ring radius, LOD distances, shadow atlas size, and the phase-42 surface cache
    budget.
- **Breaking repetition, for now** (owner): the trim layout plus the existing paint and material blending are enough.
  Macro noise, hashed piece variants, per-run jitter and hex-tile sampling stay as future proposals, added only if
  repetition shows in practice.
- **Making the sheets.**
  - Write a layout spec with a diagram and a Blender template with the UV regions as guides.
  - Build one Texture Designer graph per material *type* (stone, wood, plaster, metal…) in art-factory that renders
    straight into the layout. Oak, maple and pine are parameter sets of the wood graph, so one graph gives every
    variant.
  - Add a kit test scene with a labelled debug texture that shows every piece's UVs, so layout errors are visible.
  - Prototype with 46b's two placeholder kits (stone, wood), iterate during 46, and present layout v1 to the owner;
    real kits are made only after the owner approves it.

## 1e. Rotation: one grid per structure, anchored on its foundation (owner decision 2026-10-28)

**Decision.** Every structure owns a local 0.5 m voxel grid, anchored by its **foundation**.
- The foundation can be placed anywhere, at **any yaw angle**. Floors stay level: rotation is about the vertical axis
  only.
- Walls, floors and roofs snap to the foundation's grid in 90° steps, as in Enshrouded and Valheim. The kits and roles
  are unchanged; they work inside the local grid as if it were the world grid.
- Building over or next to an existing foundation joins its grid. A new foundation at another angle starts a new grid.
- Two grids at different angles never merge voxels. Where they meet, their pieces end in caps.
- This matches what Enshrouded shows players, though its internals are unpublished.

**Terrain, liquids and stamps stay in the world grid.** Smooth ground meets any angle, and stamps are rotated before
they are voxelized. Props are meshes and rotate freely.

**Where a structure meets the ground,** foundation pieces skirt into the terrain and hide the seam.

**What separate grids cost** (46d and 47a measure it):
- The lighting tracer steps each structure's grid in its own space, as phase 42 already does for model bricks.
- Chunk connectivity culling works inside each structure; structures cull against each other by bounds.
- The walk graph is per grid, stitched at doors and foundations.
- Collision is one static body per structure.
- Exports keep structures as voxel objects with transforms. They are never resampled into the world grid, which would
  make them jagged.

**Dropped options** (owner, 2026-10-28):
- Diagonal kit pieces (one set per angle): too many piece and joint permutations.
- 16-direction buildings rasterized into the world grid: more complexity than separate grids.

**47a measures** the same houses aligned in the world grid and in their own rotated grids (30°, 45°): frame
time, lighting, culling and memory, so the cost of separate grids is known.

## 2. Design

**Storage.**
- Sparse chunks with a palette, and empty or uniform chunks cost almost nothing.
- Chunks are cubic, not full-height columns (exact size decided in 45.2, e.g. 32³ voxels = 16 m).
- On disk, the binary chunk codec carries a magic number, version, checksum and world-scoped key.
- Saves hold only the chunks a player changed, relative to the shipped world.
- Save and database upgrades only ever add steps; an unknown version is refused, and a damaged chunk is repaired or
  regenerated, never silently dropped.

These lessons come from cuubz:
- Never save every generated chunk.
- Prevent the unload, save and worker-timeout races by giving every job an id and tracking dirty state.
- Queue work by priority: edits first, then near, then LOD.
- Send thin neighbour strips, not whole neighbour chunks.

**Meshing**, in module workers, as a pure function of the voxels (the same input always gives the same output):
- *Projected* roles: surface extraction from density (surface nets to start), smooth, with partial digs.
- *Modular* roles: the case pass. Each surface cell's role and neighbourhood picks a kit piece through matching rules
  with wildcards and priorities, like autotile rule tiles. Every role has a guaranteed fallback piece.
  - **Run pieces** in standard lengths (0.5 / 1 / 2 / 4 m) cut instance counts. A log wall is about 60 instances, not
    240 cells.
  - Foundation pieces sink a skirt into the terrain, so buildings sit in the ground instead of on top of it.

**Materials on the GPU.**
- One texture array per map type, so each array holds one layer per material.
- Near the player: a resident slot array with a material-id → slot table, filled by distance and on-screen size under
  the existing texture budget and mip streaming.
- An always-resident low-resolution array covers everything far away or not yet loaded.
- Each vertex carries up to 4 overlay ids and weights.
- Rough cost: about 15–20 texture reads per pixel up close, dropping to the top 2 overlays at mid range.
- No full virtual texturing. A baked near-camera blended cache (like Unreal's runtime virtual texture) is a later
  option.

**LOD and scale.**

| Distance (rough) | What draws |
|---|---|
| ~0–150 m | Full kit pieces (GPU-instanced and GPU-culled), full materials and paint |
| ~150–600 m | Kit piece LODs, made at import by meshoptimizer; then plain voxel chunk meshes at 1–2 m |
| Across the map | Automatic HLOD from the chunk tree (below): each node is one simplified mesh with a baked texture, chosen by on-screen size; impostors only for scatter such as trees (`impostor.ts`) |
| Horizon | The top levels of the chunk tree (voxel mips), with a macro colour texture |

Tier changes cross-fade with the engine's dither. Streaming rings load and unload full detail as the player travels.
Distance-field bricks shared with the phase-42 tracer, used to draw the far field, are an experiment, not the plan.

**The brick renderer experiment.**

Keen hasn't published how Enshrouded's 1.0 brick renderer works. What they have published is sparse distance-field
bricks in a 3D texture atlas with a page table. The most likely technique built on that data:
- Each distant node keeps a few small bricks of distance values (e.g. 8³) in a shared 3D atlas.
- The GPU draws each brick's bounding box, and the pixel shader ray-marches the distance field inside it.
- Silhouettes stay crisp at any distance, because the surface is evaluated per pixel rather than approximated by a
  few triangles. LOD is choosing coarser bricks, and memory stays small.

That fits why it looks so good, and why Enshrouded needs a dedicated GPU: the cost moves from triangles to pixel-shader
work. On the Iris Xe the horizon band covers many pixels, and each ray costs several steps.

We already own the pieces: phase 42 builds distance-field bricks and a GPU tracer, and both renderers support 3D
textures, so it stays on the one-renderer path. Sub-phase 46c renders the same far field both ways (voxel-mip meshes
vs ray-marched bricks) and compares GPU ms, crispness and memory on the Iris Xe. A hybrid is possible: bricks for the
mid band, meshes for the horizon.

**Collision and navigation.**
- Projected roles collide against the extracted smooth surface, per chunk, so there are no stair steps.
- Modular roles collide as voxel boxes. Stair and roof-slope cases collide as ramps.
- The character controller uses auto-step and a slope limit.
- The walk graph samples the same surfaces, grouped per chunk for hierarchical search. This replaces the 65,536-node
  cap and the roadmap's "one walk graph" item.

**Lighting.**
- Phase 42's surface cache addresses voxel surfaces and kit pieces.
- Edits mark only their own chunks stale (today a block edit re-lights the whole layer).
- Phase 43's clustered lights apply unchanged.

**What a 10 km world adds** (owner target; each must hold, not just the frame rate):
- **A floating origin.** 32-bit floats lose precision far from the origin: about 1 mm at 10 km, which shows as
  jitter in rendering, shadows and physics. The renderer and physics work relative to a camera or player origin that
  is re-based as the player travels. Block and terrain coordinates are bounded today (±4096 cells, ±4096 tiles); the
  voxel world's coordinates must cover 10 km.
- **Storage that doesn't grow badly with untouched ground.** Naive storage of 100 km² at 0.5 m would be about 9.5 GB.
  The uniform format's column run-length encoding makes plain ground cost about what a height map does (§1b), and
  worlds grow tile by tile. Target on disk: hundreds of MB for a large world, not gigabytes (to be measured).
- **Everything streams.** Voxel chunks, kit instances, collision, the walk graph, the lighting cache and probes,
  scatter and cover, and texture slots all stream by distance under one memory budget. Nothing is loaded for the
  whole world.
- **The editor streams too.** A world-map view to navigate; the editor loads only the region being edited, and
  commands and undo are per chunk. The backend never holds the whole world in memory.
- **Download and export.** A browser game can't download gigabytes up front. Exports stream chunks on demand (HTTP
  range or per-chunk files) with a local browser cache, so a player starts quickly and pulls the world as they travel.
- **Automatic HLOD from a chunk tree, with no hand-marked villages.**
  - **The tree.** Chunks group into a fixed spatial tree: level 0 is one 16 m chunk at full detail. Each level above
    merges 2 × 2 × 2 children, so the levels are 32 m, 64 m, 128 m … up to about 2 km nodes. Seven or eight levels
    cover 10 km.
  - **One proxy per node, built from the voxels, not from meshes** (owner, 2026-10-27).
    - Each tree level is a voxel mip: level L holds voxels of 0.5 m × 2^L, made by downsampling the level below.
      Density is averaged, and the material is the dominant one, with its paint colour folded in.
    - The proxy is that mip meshed with the same smooth (projected) mesher, with normals from the density gradient.
      Kit pieces don't exist at these distances, so walls, roofs and terrain all become simple smooth shapes.
    - Colour comes from each material's lowest texture mip (its average colour) plus paint, written per vertex or
      into a tiny per-node texture. There are no material slots and no kit instances: one draw call per node.
    - One source of truth: the same voxel data drives the near detail and every distance level. Rebuilding after an
      edit is a downsample plus a small mesh, not a mesh simplification.
  - **Selection at runtime** by on-screen error, as terrain CDLOD and 3D map-tile engines do. A node draws its proxy
    when that is accurate enough for its size on screen; otherwise it opens into its children. The number of nodes
    drawn stays roughly constant however big the world is: a few hundred draw calls for the whole far field.
  - **Transitions.** Parent and children cross-fade with the engine's dither. Proxy edges get short skirts so
    neighbouring nodes at different levels show no cracks.
  - **Edits.** A changed chunk marks its ancestors stale. The editor rebuilds them in the background. At runtime, a
    gameplay edit rebuilds only the low levels nearby, which are the only ones that can be visible at that distance;
    the high levels are rebuilt at the next export.
  - **Terrain far away** uses the horizon height field, which is already CDLOD; the tree's proxies carry structures.
    The crater city is a handful of high-level nodes, visible from anywhere on the map, with no special setup.
  - **Lighting.** Proxies take their light from the phase-42 cache, or from the baked colour, at that distance.


**Rooms and portals** come from roles. Floor, wall and roof voxels enclose rooms; window and door voxels are portals.
Room culling and lighting through portals need no separate room drawing.

## 3. Phase 45 items: formats and storage (owner, 2026-10-28; replaces the spike)

Goal: pick, by measurement, the formats that storage, streaming, editing, saves and derived data use, and present
them as the format spec v1 draft for the owner's approval (a hard stop, §1). The formats must serve every workflow
decision in this plan (structures with overrides, per-structure grids, roles, the lighting-occupancy channel, liquids,
streaming at 10 km, edits-only saves, git-friendly tiles), not only the benchmarks. Mostly CPU and worker work, measured in vitest, Node benchmarks and one browser streaming page. It
ends with a thin working slice, so the formats are judged in use, not only in benchmarks.

| Item | What |
|---|---|
| 45.0 | **Branch, staging and baseline.** Branch and worktree from `main` after 44b is merged; main frozen from here. Staging backend (own port and data root, engine-owned test worlds, memory-capped; no game copies yet). Re-measure village, landscape and interior at the cap on the Iris Xe (the floor record). |
| 45.1 | **Requirements, harness and test worlds.** First the requirements list: every decision in §1–§1e, §5b–§5c, §8 and §9 that the formats must serve, each with the field or rule that serves it (the format spec cites this list). Then synthetic worlds of plain terrain, a hilly 2 × 2 km area, a dense town of structures and a cave system, written as voxels; one harness that runs every candidate format over them (memory, `voxelAt` speed, random and stroke edits, encode/decode, compressed size, worker transfer cost). |
| 45.2 | **Chunk store candidates.** At least: palette + bit packing per chunk; that plus vertical run-length per column; sparse bricks under a per-chunk mask (SVO-like). Chunk size 16³ vs 32³. Uniform-chunk collapse, density only at the surface, planes + zstd vs lz4. Measure each on the test worlds; pick one, with the numbers. |
| 45.3 | **Region files and git.** Tile = region file (256 m default vs 512 m); deterministic bytes; header, version, checksum; per-chunk offsets for partial reads and HTTP range streaming; repo growth per hour of scripted editing; LFS only if the numbers call for it. |
| 45.4 | **Editing, undo and saves.** Stroke commands (brush, fill, stamp) as the one mutation path; per-chunk undo records and their size; save diffs against the shipped world with base-chunk hashes; save upgrade steps (add-only, unknown version refused). |
| 45.5 | **Streaming.** Worker pool with job ids and a priority queue (edits > near > far), transferable buffers, apron strips for neighbours, one memory budget per tier, load/unload churn; world coordinates for 10 km with a floating origin (precision test far out). Measured in a browser page flying a 2 × 2 km world. |
| 45.6 | **Derived-data formats.** The occupancy bitmask and solid/empty/mixed flags, voxel mips for the chunk tree, mesh output buffers (projected and kit-instance lists), collision and walk-graph inputs — shaped so meshing, lighting, culling, physics and navigation all read them; never committed, always rebuilt. |
| 45.7 | **Thin slice and format spec v1.** One browser page on staging: stream a world in, dig and build with a stroke, re-mesh with a plain surface-nets mesher, collide, save and reload the diff, at the cap on both renderers. Write the format spec v1 draft (storage, region files, edits, saves, derived data) in the engine docs, with the measured numbers and the requirements it serves; any decision that didn't pan out comes with its proposed replacements. **Hard stop: the owner reviews; 46 starts only after the owner approves the spec.** |

Throughout 45, nothing on `main` relies on branch code, and every existing system stays in place.

## 4. Phases 46–49, in sub-phases (owner, 2026-10-28)

Each sub-phase is a phase of its own size (about one phase-42-sized run or less), with its own plan written at its
start from the numbers before it, its own full gate (on the branch), review and fixes. Acceptance by eye is per
sub-phase on staging; the merge to `main` happens once, at the end of 48.

- **46 — Voxel core.**
  - **46a Core runtime:** the store from 45, `voxelAt`, `ctx.voxels` (get/set/dig, change events, the guaranteed
    update path), streaming in runtime, editor and export, floating origin, per-chunk collision (Rapier churn
    measured), the occupancy channel.
  - **46b Meshing and kits:** surface nets for projected roles; the case pass with rules, wildcards, priorities and
    fallbacks; run pieces; the role spec and the standard trim layout drafted and prototyped on two placeholder kits
    (log, stone), then **presented to the owner: hard stop, v1 only after approval**; the kit pipeline, kit check, kit
    test scene and a default fallback kit; the game-facing authoring package (§1: spec sheets, Blender templates,
    art-factory graphs per material type, the manual's kit and material guide), finished against the approved specs.
  - **46c Rendering and materials:** the material model (§1c: shader families, physical block, profiles, game data,
    variants, badges); texture arrays and slot residency; kit-piece instancing and GPU culling; LOD tiers and the
    chunk-tree HLOD from voxel mips; the far-field choice (voxel-mip meshes vs brick ray-marching, measured here);
    every feature behind a quality-tier switch and budget.
  - **46d Lighting, culling and navigation:** the tracer over occupancy; lighting storage chosen by measurement
    (phase 42's cache addressed by voxel face vs the voxel light volume, §5c); rooms and portals from roles; the prop
    lighting-occupancy channel; chunk connectivity culling; the hierarchical walk graph.
- **47 — Structures and tools.**
  - **47a Structures:** structure objects (§1b) with footprint, storeys, roof, material swap, copy/paste, scale,
    extend, drag up and hand-edit overrides; one grid per structure (§1e); openings with door and window props.
  - **47b Brushes and dressing:** volume brushes, role painting, pillar and terrace options, stamps, paint, scatter
    and rules reading material and role.
  - **47c Editor at world scale:** the world-map view, an editor that streams only the region being edited, per-chunk
    undo, cut-aways and see-through from roles, debug views, MCP and the manual.
- **48 — Migration, retirement and merge.**
  - **48a Converters:** block layers, terrain, architecture and existing materials to voxels and the material model;
    `ctx.grid` as a deprecated wrapper; run on a staging copy of Sprout only; the owner looks; its saves and play
    verified. Skyforge and Temporal rebuild on the voxel world from the authoring package. The game repos port in
    their own sessions.
  - **48b Retirement:** the old systems and their e2e specs removed, voxel specs in their place; docs and manual.
  - **48c Merge:** full gate, phase review, owner approval, merge to `main`, deploy.
- **49 — Water (§8),** after the merge, with its own sub-phases.
- **Then a performance phase** over the whole voxel world (owner, 2026-10-28), from the numbers every phase recorded.

## 5. Open defaults (used unless the owner says otherwise)

- 45° roofs only at first; 2:1 pitch later if games ask for it.
- Chunk size 32³ voxels (16 m), confirmed or changed by 45.2's numbers.
- Surface nets for projected roles; dual contouring only if surface nets loses edges that matter.
- Block layers and terrain retired in phase 48 after the converter is proven, not kept running side by side.
- Uniform storage per §1b, 256 m tiles; floating origin re-based every ~1 km of travel; new worlds start as a few tiles.
- Far field: voxel-mip proxies (rasterized) are the default. A brick ray-marched far field (Enshrouded-style, see
  §2) is measured side by side in 45.5, and the numbers decide.

## 5b. Settled up front (defaults, 2026-10-27)

- **Generated architecture becomes a tool that writes voxels.** The architecture generator (sweeps, repeats, roofs,
  rooms) writes voxels and roles instead of producing its own meshes and colliders. The parametric meshes are retired
  with block layers and terrain in 48. That leaves one structure system, not three.
- **Placed objects stay meshes.** Props, furniture, trees, characters and prefabs are not voxelized; they sit on the
  voxel world as they sit on terrain today.
- **Game repos and git.** Game projects live in git, so the on-disk format must stay git-friendly:
  - chunks grouped into region files (e.g. 16 × 16 chunks a file), so a 10 km world doesn't become hundreds of
    thousands of files;
  - untouched terrain stored as the field (§2), so only authored regions are voxel data;
  - derived data (meshes, HLOD proxies, bricks) never committed, only rebuilt;
  - 45.3 measures repo growth per hour of editing; Git LFS for region files only if that number calls for it.
- **Commands work in strokes, not single voxels.** Brush strokes, stamps, room and fill operations are each one
  command, so undo, MCP and game sessions edit worlds at a useful granularity, and history stays small.
- **Kit art for 46b is a placeholder.** Two simple kits (log, stone) are made through the Blender pipeline, just
  good enough to measure. The owner's real kits come in 46–47; 46 must not wait on final art.
- **Phase 44 (consolidation) leaves block, terrain and architecture internals alone** wherever 48 will retire them.
  Fixes there only if a game needs them now.
- **Tests follow AGENTS.md.** Voxel e2e specs replace the block, terrain and architecture specs they supersede rather
  than adding to them. The gate's time and memory peak (already at its 5 GB cap, D344) are recorded per phase.
- **Host resources.** The staging backend, gates and perf runs share this host, which has a history of OOM kills.
  They run one at a time, each in a capped scope.

## 5c. Further considerations (2026-10-28, to settle in the phase plans)

- **Measuring the high tier.** This host only has the Iris Xe; the RTX 5090 is the owner's Windows workstation.
  - The perf harness gets a page the owner opens in Edge on the workstation, pointed at the staging service. It runs
    the same scenes and posts its report back to the server.
  - Until the owner runs it, high-tier results are recorded as unverified, never assumed.
- **Generator upgrades apply automatically** (owner, 2026-10-28). When the structure generator improves, every
  structure regenerates with it; no per-structure version pinning.
  - The one risk is hand-edit overrides landing in the wrong place after a generator change. After an engine upgrade
    the editor regenerates all structures in one undoable step and reports any whose overrides no longer fit, so
    nothing changes silently.
  - Exports bake the voxels, so shipped games are never affected.
- **Game saves when the world is re-exported.** Saves store voxel edits against the shipped world. If a later export
  changes a chunk a player had also edited, the save's diff no longer fits.
  - Saves record a content hash per base chunk, and the engine detects the mismatch.
  - What to do about it (keep the player's edit, or take the new base) is the game's choice.
- **Lighting for voxels: a sparse voxel light volume** (owner idea, 2026-10-28; measured against phase 42's cache).
  - Store bounced and soft light in the **air voxels that touch a surface**, as six directional values per voxel (an
    "ambient cube": the light arriving from ±X, ±Y, ±Z). Any mesh near the surface samples it by position and normal,
    blended between neighbouring voxels: kit pieces, props, characters, scatter.
  - Storing it on the air side means each side of a 0.5 m wall has its own cells, so light doesn't leak through.
  - Sharp detail is not this volume's job. Sun shadows stay per-pixel shadow maps, and local-light shadows come from
    phase 43's shadow atlas. The volume carries the soft, low-frequency light, where 0.5 m resolution is plenty.
  - **Expected to be faster and leaner than per-texel caching:**
    - one sample per 0.5 m face instead of roughly 144 texels (12 × 12 at about 4 cm);
    - far fewer rays per update;
    - no UV charts or surfels, so kit pieces need no cache addressing at all.
  - **One shared light for everything.** Moving characters and static walls read the same volume, so they match.
  - **Memory:** about 24 bytes per surface-adjacent voxel (six packed HDR colours), resident only near the player.
    Roughly 40–50 MB for a few hundred metres around the player (estimate).
  - **Cost:** lower spatial detail than phase 42's texel cache (bounce light at 0.5 m), and some interpolation softness
    on thin features.
  - **It replaces probes too.** Each surface-adjacent voxel is in effect a tiny probe, so the volume *is* a dense
    probe grid exactly where surfaces are.
    - For open air (a character's head 1.7 m above a field, the middle of a big hall, particles, fog) the volume has
      coarser levels at 1, 2 and 4 m, built like the voxel mips.
    - Together that is "dense near geometry, sparse in the open", which is what 42.9b's adaptive probe placement
      aimed for, but with no placement step at all.
    - The saved bake for the low tier and WebGL 2 is the settled volume per tile.
    - Phase 42's work carries over: the tracer, change tracking, rooms and portals, budgets and tiers. Only where the
      light is stored changes.
    - If 46d shows the phase-42 cache winning instead, its probes stay.
  - **Decided by measurement:** sub-phase 46d runs the voxel light volume against phase 42's surface cache on the
    same village (GPU ms, update time after an edit, memory, look). If it wins, the voxel world uses it and the texel
    cache is retired with the old systems.
- **The script API transition.** Games call `ctx.grid` (block layers) and terrain queries today.
  - Phase 46 adds `ctx.voxels`.
  - Phase 48 keeps `ctx.grid` as a deprecated wrapper over voxels (layer coordinates mapped to structure and world
    grids), with a Problems line wherever it is used, so games keep running until they port.
  - Each game ports in its own repo; the engine never edits game repos.
  - The manual's migration page and the request docs tell each game what to change.
- **Rapier with many chunk colliders.** Static trimeshes per chunk, streamed in and out. Measure the add/remove cost
  during the 10 km flight.

## 6. Progress

| Item | Status |
|---|---|
| — | Not started (draft). |

## 7. Decision log

- 2026-10-27 (owner, planning session): §1 decided in conversation. The research behind it covers Enshrouded's
  published talks (0.5 m voxels; smooth surfaces meshed from voxel data; bi-planar texturing; a distance-field-based
  lighting cache like phase 42; saves storing edits against the shipped world) and the cuubz review.
  - Enshrouded's exact mesher, its kit-piece mechanism and its brick renderer are unpublished; the design here is the
    established technique that fits what is visible, not a copy of theirs.
  - Later the same day the owner raised the scale target from 2 × 2 km to 10 × 10 km (§1); floating origin,
    editor streaming and streamed exports were added to §2 (storage later settled as uniform, §1b).
  - Estimates (about 95 MB per km² sparse at 0.5 m; about 5–10k kit pieces for a 50-house village; 15–20 texture reads
    per pixel) are unverified until 45.6 measures them.

## 8. Next: water (a later phase; owner decisions 2026-10-28)

Water is ordinary voxels, so it shares storage, streaming, meshing, LOD and saves. The look is each game's own.

- **Data: water uses a `liquid` role, with no separate fluid channel** (owner).
  - Water, lava, swamp and so on are materials like any other, so you can swap the liquid's material as you can swap
    a wall's.
  - Only the surface voxel needs a fill level, and it uses the same shape/density field terrain uses for its surface.
  - Voxels below the surface are simply full, which the uniform storage already compresses away.
  - The one edge case is shorelines, where a cell is partly ground. The rule: liquid fills the non-solid part of its
    cell. The mesher clips the water surface against the ground surface, and the shader softens the shoreline by water
    depth.
- **Liquid materials carry physical properties that the engine uses** (owner, 2026-10-28).
  - Every material with the `liquid` role defines:
    - a **mass density** (kg/m³; named that way to keep it apart from the voxel shape/density field);
    - a **flow rate** (how fast it spreads and settles; viscosity in effect).
  - **New liquid materials default to water:** 1000 kg/m³, fast flow. Every value is editable, so lava is heavy and
    slow and swamp water is thick.
  - **The simulation reads them.** In local settling, each liquid spreads at its own rate, so lava creeps where water
    rushes.
  - **Physics reads them.** Buoyancy compares a body's density with the liquid's; drag scales with flow rate. Swapping
    the material on a lake from water to lava changes how things float and move in it, with no other change.
  - These are engine physics, so they are engine-owned. What a liquid *does* to a player (lava burning, say) stays
    game logic, read from the material's game data like break and sound profiles.
  - Solid materials could carry the same kind of physics block (friction, bounciness, mass density) to keep one
    pattern. Proposed for phase 46; not yet decided.
- **Authoring: water bodies are structure objects until export** (owner).
  - **Lake:** fill a basin to a level.
  - **River:** a spline with width and depth that carves its bed.
  - **Waterfall:** automatic wherever a river drops over an edge.
  - **Sea level:** one plane per world.
  - **The water's fill is regenerated from the structure and the ground it sits in.** Reshape a river's banks with
    the terrain tools and the water follows. Structures resolve in a fixed order: ground, then buildings, then water.
  - At export everything becomes plain voxel data.
- **Simulation, in tiers chosen per game.**
  - **Static** (the default): no cost.
  - **Local settling:** a cellular flow over liquid voxels runs only in the chunks around an edit or gameplay change,
    sleeps once settled, and is deterministic, saved, and budgeted in the simulation workers.
  - No full fluid dynamics.
- **Rendering.**
  - The surface is meshed from liquid voxels by the smooth mesher; flat lakes become planes.
  - The shading kit is per game: depth colour and fog, refraction, shoreline foam, flow maps, and reflections from
    phase 42.
  - The engine draws falling-water sheets.
  - Far away, each HLOD node carries its water as a flat plane.
  - Refraction cost on the Iris Xe needs measuring.
- **Mist, splash and spray are game-specific** (owner). The engine draws no mist. It exposes the fall points (where
  falling water meets a surface, with flow rate) so a game can attach its own effects.
- **Gameplay.** Queries for water level and flow at a point; generic buoyancy and drag; an underwater view effect.
  Swimming stays the game's own.
- **Order.** Its own phase after 45–48, with its own first measurements: a lake, a river with a waterfall, banks reshaped with the
  water following, and a channel dug to drain the lake, measured on the Iris Xe.

## 9. Efficiencies a voxel world unlocks (overview, 2026-10-28; for the phase planners)

A world that is a uniform 0.5 m grid lets many systems use exact, cheap grid operations instead of mesh queries. Each
one needs measuring before it counts.

- **One occupancy bitmask is shared by almost everything.** One bit per voxel is about 4 KB per 32³ chunk, plus a
  "solid / empty / mixed" flag per chunk and per tree node. The tracer, culling, physics queries, navigation, audio
  and gameplay queries all read it.
- **Lighting.**
  - **Leaks become almost impossible.** Every wall is at least one solid voxel, rays step exactly through occupancy,
    and light is stored on the air side of each surface. One rule is needed: rays may not slip diagonally between
    two voxels that only touch at an edge or corner (6-connected stepping). Open doors and windows let light through
    deliberately, as portals.
  - **Rays are as cheap as rays get:** grid stepping over bits, skipping empty chunks and tree nodes whole.
  - **Ambient occlusion** per vertex comes free from neighbour occupancy, as blocks do today.
  - **Sky visibility** is the highest solid voxel per column: "indoors or outdoors" in one lookup, for the sky light,
    rain, wind and ambience.
- **Culling.**
  - **Chunk connectivity culling,** as Minecraft's "advanced cave culling" does. Each chunk records which of its six
    faces are joined through air. A search outward from the camera's chunk, crossing only joined faces, reaches only
    chunks that could possibly be seen. Sealed rooms, underground and the far side of solid hills drop out whole.
    It costs very little on the CPU and needs no GPU occlusion pass.
  - **Rooms and portals come straight from roles** (floor, wall, roof, door, window), with no separate room drawing.
  - **Empty and fully buried chunks cost nothing:** no mesh, no draw, no light.
  - **Faces grouped by direction:** each chunk's flat faces are split into six direction buckets, and buckets facing
    away from the camera are skipped before drawing.
- **Meshing and LOD.**
  - Only surface voxels make geometry.
  - An edit re-meshes only its own chunk (plus a neighbour at a border), deterministically, in workers.
  - The distance levels are voxel mips, and the chunk tree drops whole chunks or nodes at once.
- **Streaming and memory.** Fixed chunk and tile sizes give predictable memory, simple priority by distance, and
  palette and run-length compression.
- **Physics and queries.**
  - Raycasts, line of sight, overlap tests, editor picking and "what's under the player" are grid steps, not mesh
    queries.
  - Chunk colliders are built only where something can touch them.
- **Navigation.** The walk graph reads standable voxels directly and is hierarchical per chunk; an edit rebuilds one
  chunk's piece.
- **Audio, generic and cheap.**
  - Room size is the count of enclosed air voxels.
  - Obstruction between a sound and the listener is a grid ray.
  - Absorption comes from each material's physical and sound profile.
  - Together these give reverb and muffling without hand-placed zones. Using them is optional for each game.
- **Gameplay helpers.** Line of sight, cover, blast radius and "is inside" all become simple grid queries.
- **See-through and cut-aways** (owner, 2026-10-28). Today's occluder search (39b.6e) steps block layers by grid and
  uses bounds for models.
  - With voxels, one grid step from camera to subject over the occupancy map finds every true occluder: walls,
    roofs, terrain overhangs, cliffs. Each structure's grid is stepped in its own space.
  - The voxel runs it crosses become the occluder boxes the dither shader already uses, so there are no false fades
    of walls that aren't in the way.
  - Roles decide what may fade: walls and roofs yes; floors and the ground under the subject no.
  - Cut-aways come straight from roles and rooms. When the subject is inside a room (its air voxels are enclosed),
    hide that structure's roof and the storeys above the subject's floor. No hand-drawn cut-away regions.
  - Cheaper and more exact than today, and the same code serves every kind of geometry.
- **Camera occlusion: pull-in by default, see-through per camera** (owner decision, 2026-10-28).
  - Each virtual camera chooses how it handles an occluder: `pullIn` (the default), `seeThrough`, or `none`.
  - Projects switch between them by switching cameras, which already happens through priorities and camera regions.
    Temporal, for example, could use see-through on interior cameras and pull-in on its freer outdoor cameras.
  - **Pull-in feel.** Today the follow rig already pulls in when a ray hits a collider, but it snaps both ways. It
    should instead:
    - move in fast (it must never sit inside geometry), using a sphere test of the camera's radius so walls don't
      clip the near plane;
    - hold briefly once clear;
    - ease back out to the target distance over an authored time;
    - expose per-camera times for in, hold and out.
  - **Cost:** pull-in is one cast per camera per step. With voxels it is a grid step over occupancy, cheaper still.
    See-through keeps its occluder search and dither shader, but only on cameras that choose it.
  - Today see-through is a project-wide setting (off by default) with a script override. It moves to the per-camera
    choice, and the project setting becomes the default for new cameras.
  - This doesn't depend on voxels. It ships first, in phase 44b (`docs/plan-phase-44b.md`), together with adaptive
    exposure; the voxel phases only make pull-in's world test a grid walk.
  - **Props** (owner, 2026-10-28). The voxel grid walk sees world geometry plus any prop that has a voxel proxy
    ("affects lighting": big boulders, trees, large structures). Small props are invisible to the walk, which is an
    accepted trade-off.
    - For pull-in, the camera can still cast against physics colliders for props that have them, as it does today,
      so nothing is lost. The voxel walk only makes the world part cheaper.
    - Leafy proxies don't trigger pull-in: only voxels above a coverage threshold (about 0.5) count, so the camera
      doesn't dive into a canopy. See-through may still fade them.
- **Scatter, fog and the editor.**
  - Scatter rules read material and role directly: grass only on terrain-role top faces, never on paths or
    foundations.
  - Volumetric fog takes its shadowing from occupancy.
  - Copy and paste are voxel blocks, and undo works per chunk.
- **Caveat.** Smooth (projected) ground is not exactly its voxel boxes. Occupancy treats a voxel as solid when it is
  more than half full, a conservative approximation. Kit pieces may stick out slightly past their voxels, which is
  why lighting and collision use the voxels and not the pieces.
- 2026-10-28 (owner, with the 42/43 lead session): the spike and its go/no-go are dropped; the direction is fixed.
  Phase 45 becomes a formats-and-storage phase ending in a thin working slice and format spec v1 (§3). Phases 46–48
  are split into sub-phases 46a–d, 47a–c and 48a–c (§4), on the branch with main frozen for the few weeks this takes.
  The Iris Xe is the floor (low tier): 720p60 is the goal, 720p30 acceptable; numbers are recorded every phase, no
  phase blocks on a threshold, and a performance phase follows the voxel phases. The old spike items' measurements
  (village of 30–50 houses, rotated grids, lighting A/B, brick renderer, 10 km flight) move into 46b–46d where they
  decide their questions.
- 2026-10-28 (owner): (1) the format spec, the role spec and the standard trim layout are owner hard stops: drafted,
  prototyped and presented, v1 only after the owner approves each. (2) The decisions in this plan are requirements:
  every format and spec traces to them, and a decision that doesn't pan out is replaced only by an owner-chosen
  proposal that keeps its goal, never silently dropped. (3) No copies of the three games for testing; only a Sprout
  copy for the converter (48a). Game work is frozen, breaking the games until they are updated is fine, and Skyforge
  and Temporal rebuild from scratch. (4) The engine ships a complete authoring package for the games: spec sheets,
  Blender templates, art-factory graphs, kit check and test scene, and the manual's guide.
