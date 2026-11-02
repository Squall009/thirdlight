# Phase 45 — Voxel world: formats and storage, then phases 46–49 (sub-phases)

Status: **planned, approved by the owner 2026-10-28** (planning sessions 2026-10-27/28). It starts only after phases
43, 44 and 44b are done and merged.

**Planning revision 2026-10-30:** read §7a before implementing the earlier kit, role, trim and meshing requirements.
It records the owner's revised direction: voxel-derived base surfaces and inferred architectural detail meshes,
plus deferred scatter and rendering prototypes. Where they conflict, §7a takes precedence; unresolved proposals
are not approved specifications. No implementation or visual/performance validation is claimed by these notes.

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
- **Vertical extent (owner clarification, 2026-10-31):** the 10 × 10 km world needs roughly 1–2 km from
  the world base to its highest peak. A 256 m region dimension is a horizontal footprint, never a world-height
  limit. Benchmark 2 km of vertical extent, including deep caves and tall terrain/structures; allow headroom above
  the highest terrain when defining bounds. Exact vertical bounds and their placement remain to be settled in 45.
  At 0.5 m resolution, 2 km is 4,000 cells or 125 chunks at the candidate 16 m chunk size. Store this sparsely:
  absent air allocates no cell arrays and uniform solid chunks collapse compactly. Full-height region columns
  remain the current default; vertically stacked region containers are a candidate to compare for file size and
  write amplification, not a restriction on elevation.
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
| 45.1 | **Requirements, harness and test worlds.** Trace the owner decisions, including §7a, to format fields/rules. Establish stored intent, derived occupancy and edit-dependency requirements below. Compare storage candidates on synthetic terrain, town and cave worlds for size, access, edits, codec and worker-transfer cost. |
| 45.2 | **Chunk store candidates.** At least: palette + bit packing per chunk; that plus vertical run-length per column; sparse bricks under a per-chunk mask (SVO-like). Chunk size 16³ vs 32³. Uniform-chunk collapse, density only at the surface, planes + zstd vs lz4. Measure each on the test worlds; pick one, with the numbers. |
| 45.3 | **Region files and git.** Tile = region file (256 m default vs 512 m); deterministic bytes; header, version, checksum; per-chunk offsets for partial reads and HTTP range streaming; repo growth per hour of scripted editing; LFS only if the numbers call for it. |
| 45.4 | **Editing, undo and saves.** Stroke commands (brush, fill, stamp) as the one mutation path; per-chunk undo records and their size; save diffs against the shipped world with base-chunk hashes; save upgrade steps (add-only, unknown version refused). |
| 45.5 | **Streaming.** Worker pool with job ids and a priority queue (edits > near > far), transferable buffers, apron strips for neighbours, one memory budget per tier, load/unload churn; world coordinates for 10 km with a floating origin (precision test far out). Measured in a browser page flying a 2 × 2 km world. |
| 45.6 | **Derived-data formats.** The occupancy bitmask and solid/empty/mixed flags, voxel mips for the chunk tree, mesh output buffers (projected and kit-instance lists), collision and walk-graph inputs — shaped so meshing, lighting, culling, physics and navigation all read them; never committed, always rebuilt. |
| 45.7 | **Thin slice and format spec v1.** On staging, stream, edit, mesh, collide and save/reload on both renderers. Include the 45.1 assembly-data proof below. Present the format draft, requirement traceability, measurements and replacements for decisions that failed. **Hard stop: owner approval before 46.** |

### 45.1 required assembly-data questions (owner, 2026-10-30)

The requirements list traces every decision in §1–§1e, §5b–§5c, §7a, §8 and §9 to the field or rule that
serves it. §7a takes precedence where it revises earlier requirements. Include these three questions explicitly:

1. **Stored intent versus inferred architecture.** Establish the minimum stored metadata distinguishing terrain,
   construction and roofs. Beams, banisters, soffits and mouldings are derived cases, not mandatory per-cell labels.
   The data must support runtime building without structure-authoring metadata. Settle the minimum contract during
   45; the complete case catalogue belongs to 46b.
2. **Authoritative versus derived occupancy.** Treat the earlier claim that one solid bitmask serves every system
   as provisional. An arrangement resolved as an open banister must not automatically become a full opaque wall
   for collision, navigation or lighting. The proposed contract stores construction intent and derives appropriate
   representations through shared assembly rules. Establish how the derived-data formats accommodate these
   distinctions; measure and resolve the representation rather than freezing a full-cell assumption.
3. **Edit dependency and invalidation.** Represent the neighbourhood dependency radius of assembly rules in job
   inputs, neighbour-data requests and invalidation. Do not assume only the edited chunk and its immediate border
   can be affected. The full rule catalogue determines the eventual radius; the format/job contract must express
   that dependency and rebuild all affected results, including across chunk boundaries.

The storage harness retains synthetic plain terrain, a hilly 2 × 2 km area, a dense town of structures and caves.
Include a world with 2 km of vertical extent to exercise mountains, deep caves, tall structures and vertical
streaming; a shallow landscape alone does not satisfy the vertical-extent requirement in §1b.
Measure memory, `voxelAt` access, random/stroke edits, encoding/decoding, compressed size and worker-transfer cost.
These assembly questions are work for 45.1, not additional owner decisions required before phase 45 starts.

**45.7 acceptance requirement:** before presenting the format for owner approval, demonstrate a small
wall-to-beam/banister example as neighbouring voxels change, using minimal placeholder geometry. Show that stored
intent survives codec/save round trips, surface/detail and occupancy outputs can express the different cases, and
an edit crossing a chunk boundary invalidates all dependent results. Exercise equivalent runtime voxel input without
structure-authoring metadata. This proves the data contract, not the finished rule catalogue or art pipeline; record
what was observed and any limitations. Finished kit art, displacement, exact LOD levels, 2×2 variation sections,
Kit Designer and deferred scatter are not prerequisites for this proof.

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
| 45.0 | done (8db90379 + this): `tools/staging.sh` (staging on 127.0.0.1:4180/4181, own data root, 6 GB cap; proven start, page 200, test project, stop clean). Floor record at the cap, Iris Xe, both renderers: village, landscape, interior at 720p and 1080p all p95 16.7–16.8 ms, 0 missed (720p60 met); see **45.0 floor record**. three 0.187.0 newest, no update. |
| 45.1b | done (4f9c3340, 6bcbbd5e, 8bd00db7 + this): `@thirdlight/voxel` (cells ±32,768 xz / ±8,192 y, key math for 16³ and 32³, PROVISIONAL record, store contract, dense oracle) and `tools/voxel-bench` (5 test worlds, all swept whole). Dense baseline at 32³: 3.3 GB/km² in memory, plain 5.9 MB/km² zstd, voxelAt 110–123 ns random; see **45.1 harness baseline**. |
| 45.2a | done (ebfd57b9 + this): palette family (record/per-plane palettes, packed/runs, uniform collapse, surface-only density, codec v1 DRAFT), oracle-checked on all worlds. Record palette, packed, 32³: 10–50× less memory than dense, zstd 1.7–5.9 MB/km² (terrain, town), voxelAt 35–80 ns; runs and per-plane lose; see **45.2a palette candidates**. |
| 45.2b | done (38742e3a, a7cd1177 + this): sparse 4³ bricks, codec matrix, browser-worker decode, edge costs. PICK (draft): bricks in memory, packed body + zstd 3 at rest, 32³. Hilly 4 km²: 163 MB loaded (P 371), 5.9 MB/km² zstd, voxelAt 36–111 ns; fzstd 4–53 µs/chunk in a worker; see **45.2b bricks, codecs and the 45.2 pick**. |
| 45.2c | done (382cfcd2 + this): hidden regressions. D423 fixed: the on-demand Scene view stopped drawing while a probe placement (or an early sky change, or a tile upload) waited, so the ground kept the old sky's light; it now draws on. D428 to watch: 0 failures in 10 runs (6 alone, base and fix; under load; fast gate). Both also on main (frozen): carry over at the merge. |
| 45.3 | done (this): region file v1 DRAFT (header, CRCs, sorted chunk table, uniform inline, canonical bytes, range reads). 256 m tiles kept; stacked cubes proposed over columns (2 km tile: 12.3 MB file, 1.47 MB stacked); 10 km ≈ 430–580 MB, 1,600 tiles; HTTP chunk 0.41 ms, 3×3×3 0.54 ms coalesced; git +0.13–0.22 MB/h after gc (7–22 loose): no LFS; see **45.3 region files**. |

### 45.0 floor record

Main's code (d4053cab, the branch's dist; only the perf harness gained `--viewport`), Iris Xe, headless Chrome at the
display's 60 Hz cap, device pixel ratio 1, the default tier as 44b. `run.mjs village --vsync --no-bare --viewport WxH`
and `run.mjs level --classes landscape,interior --vsync --viewport WxH`; 3 rounds 2026-11-01 19:51–21:49, each round
720p then 1080p, load 0.7–2.7 (uptime 9 days). Per round: p95 frame ms, missed frames of ~600, main-thread ms a frame,
WebGPU GPU ms at full clock (timestamps × clock ÷ max clock; WebGL 2 has no pass timestamps).

| Scene | Renderer | Size | p95 ms | missed | main ms | GPU ms full |
|---|---|---|---|---|---|---|
| village | WebGPU | 720p | 16.7 ×3 | 0 ×3 | 5.41 / 5.30 / 5.23 | 3.26 / 2.71 / 2.79 |
| village | WebGL 2 | 720p | 16.7–16.8 | 0 ×3 | 3.89 / 3.95 / 3.86 | - |
| landscape | WebGPU | 720p | 16.7 ×3 | 0 ×3 | 4.23 / 4.39 / 4.35 | 7.68 / 7.62 / 7.48 |
| landscape | WebGL 2 | 720p | 16.7–16.8 | 0 ×3 | 3.32 / 3.14 / 3.07 | - |
| interior | WebGPU | 720p | 16.7–16.8 | 0 ×3 | 3.47 / 2.92 / 2.78 | 3.27 / 2.97 / 3.05 |
| interior | WebGL 2 | 720p | 16.7–16.8 | 0 ×3 | 1.74 / 1.81 / 1.77 | - |
| village | WebGPU | 1080p | 16.7 ×3 | 0 ×3 | 5.54 / 5.45 / 5.33 | 5.11 / 5.27 / 5.40 |
| village | WebGL 2 | 1080p | 16.7–16.8 | 0 ×3 | 4.01 / 3.94 / 3.96 | - |
| landscape | WebGPU | 1080p | 16.7–16.8 | 0 ×3 | 4.59 / 4.55 / 4.68 | 10.09 / 10.22 / 10.27 |
| landscape | WebGL 2 | 1080p | 16.7–16.8 | 0 ×3 | 3.71 / 3.18 / 3.19 | - |
| interior | WebGPU | 1080p | 16.7 ×3 | 0 ×3 | 2.93 / 2.84 / 2.93 | 6.76 / 6.77 / 6.95 |
| interior | WebGL 2 | 1080p | 16.7–16.8 | 0 ×3 | 1.87 / 1.77 / 1.82 | - |

- **720p60 is met** on every class and renderer: no missed frame in 7,200 frames at 720p. No miss, so no cause to
  record. 1080p matches the end of 44b (village 5.25–5.01, landscape 10.03–10.19, interior 6.29–6.53 GPU ms full;
  main ms within 0.3 ms) on the same code.
- 720p saves GPU, not main thread: GPU ms full falls 25–55 % (landscape 10.2 → 7.6, interior 6.8 → 3.1, village
  5.3 → 2.9); main-thread ms is the same at both sizes (it does not scale with pixels). The landscape is the class
  with least headroom on the GPU (7.6 of 16.7 ms at full clock at 720p).
- At the cap the GPU clock drops (raw timestamps 4.3–9.1 ms at 720p); 720p GPU numbers below ~3.5 ms full clock
  spread most between rounds (village 3.26 vs 2.71), so read them as ± 0.5 ms.
- Reports and logs: `~/.cache/thirdlight-phase45/work/45.0/` (scratch, not committed).

### 45.1 harness baseline

Dense reference store (plain typed arrays per chunk, 5 bytes a voxel: material 16 bits, category, shape, orientation
8 bits each; PROVISIONAL record, not the format) over every test world, whole (nothing sampled or extrapolated),
both chunk edges. `node tools/voxel-bench/run.mjs --edge 32,16` in a 6 GB scope, 2026-11-01 22:34–22:45, i5-12600H
(10 threads), load 1.5–3.4, peak RSS 920 MB, 11 min. Report: `~/.cache/thirdlight-phase45/work/45.1b/results/`
(latest.json / latest.md, kept for 45.2; no world files: the generators are deterministic and regenerate faster
than reading back).

Test worlds (`tools/voxel-bench/worlds.ts`, `town.ts`; engine-owned test data, a pure function of seed and cell):
- **plain** 256 × 256 m: surface 2 m ± 1 m, grass on 2 m soil on rock, base −64 m.
- **hilly** 2 × 2 km: hills to ~120 m, rock on steep slopes, lakes at 12.3 m (liquid, top cell partly full), base −64 m.
- **town** 256 × 256 m: 144 lots of 20 m; houses of 1–3 storeys with 0.5 m walls, floors, stairs (orientation),
  45° gable roofs with overhangs (category roof, slope direction), doors and windows, beams one cell out at the
  storey lines, balconies with open banisters (posts every other cell under a rail), fences, ponds; 11 houses stand
  in their own 30°/45° grids (own chunk sets with a yaw and origin, swept like the world grid).
- **caves** 256 × 256 m: 3D-density ground to ~30 m with overhangs, tunnels, caverns, water below −40 m.
- **vertical** 256 × 256 m × 2 km: base −1,000 m, mountain to ~+925 m, sparse deep caverns with water below
  −850 m, a 300 m tower of 0.5 m walls (4,000 cells of height; 125 chunk layers at 32³).

Per world at 32³ (16³ in brackets). Memory = dense arrays if the whole world were loaded; zstd/deflate = each chunk
compressed alone (zstd 3, raw deflate 6, Node zlib); −cat / −orient = share of the zstd size the category / the
orientation plane costs (zstd of the chunk without that plane).

| World | Chunks (uniform) | Memory | zstd | deflate | zstd/km² | −cat / −orient | runs/col |
|---|---|---|---|---|---|---|---|
| plain | 1,280 (60 %) [9,216 (78 %)] | 210 MB [189] | 0.39 MB [0.67] | 0.80 MB | 5.9 MB [10.2] | 5.5 / 2.2 % [3.2 / 5.7] | 1.59 |
| hilly 4 km² | 112,218 (77 %) [845,486 (88 %)] | 18.4 GB [17.3] | 49.4 MB [74.2] | 82.4 MB | 12.4 MB [18.6] | 11.7 / 1.5 % [7.7 / 4.5] | 1.41 |
| town (+11 grids) | 1,297 (59 %) [9,730 (74 %)] | 213 MB [199] | 0.35 MB [0.69] | 0.57 MB | 5.4 MB [10.5] | 24.0 / 12.1 % [14.2 / 9.3] | 1.66 |
| caves | 1,727 (0.2 %) [12,457 (14 %)] | 283 MB [255] | 8.4 MB [8.4] | 8.5 MB | 129 MB [128] | 17.4 / 0.1 % [15.6 / 0.7] | 2.45 |
| vertical | 19,625 (37 %) [147,423 (65 %)] | 3.2 GB [3.0] | 27.7 MB [30.4] | 30.8 MB | 422 MB [464] | 17.3 / 0.5 % [14.5 / 2.0] | 1.24 |

Speeds (32³ [16³]; window = 256 m square, 64 m for vertical, all heights): `voxelAt` random 110–123 ns
[154–184], coherent column scan 9.5–10.9 ns [10–13]; single edit 0.08 µs [0.12–0.17]; spheres r = 1 / 2 / 4 m
1.1–4.1 / 6.9–7.5 / 53–58 µs (~25 ns a cell); boxes 2 / 8 m 1.6–4.2 / 79–86 µs; dense encode / decode 3.1–3.7 /
3.3–3.6 GB/s [2.6 / 2.0–2.5]; zstd compress / decompress 1.2–2.4 / 1.7–2.5 GB/s [0.45–0.62 / 1.1–1.6]; deflate
170–440 MB/s / 1.3–2.1 GB/s [160–480 / 0.8–1.2]. Worker round trip per chunk (real `worker_threads` Worker, each
chunk its own message): raw 32³ chunk (164 KB) copied 27–46 µs, transferred 5.5–6.2 µs; raw 16³ (20 KB) 5.6–11 /
3.2–3.5 µs; a zstd-compressed chunk (a few KB) 3–6 µs either way.

- Every chunk read back equal to what was generated (oracle check in the sweep, both edges, every world).
- The general-purpose compressor on raw planes, per chunk, already lands near §1b's 8–15 MB/km² estimate for
  plain ground at 32³ (5.9 MB/km², base 64 m deep; base depth sets how many uniform rock chunks there are). What the
  candidates must win is memory (dense: 3.3 GB/km², 3.2 GB for the 2 km column) and access, not disk size.
- 16³ costs 1.1–1.9× the zstd bytes of 32³ (frame overhead and less context per chunk; caves equal) and is slower
  to compress (0.6 vs 2 GB/s); it raises the uniform share from 59–77 % to 74–88 % (caves 0.2 → 14 %).
- The category plane is a visible share where construction is: 24 % of the town's zstd bytes (orientation 12 %),
  12–17 % on terrain worlds, where it mostly repeats the air/ground boundary the material plane already holds.
  Q-a's "with/without a category plane" therefore matters most in towns; 45.2 measures it under palette/RLE.
- Random `voxelAt` is dominated by finding the chunk (a Map keyed by numbers up to 2^35): reads that hit the
  last-chunk cache cost ~10 ns, random ones 110–184 ns, more at 16³ (8× the chunks). A candidate's chunk index is
  part of its access cost.
- Copying a raw 32³ chunk to a worker costs 5–8× moving it; compressed chunks are small enough that it doesn't matter.
- Not measured here: lz4 (needs a dependency), browser/worker decode of zstd (WASM) vs DecompressionStream deflate
  (needs a browser page), assembly-derived occupancy (Q-b) and apron/dependency radius (Q-c).
- For 45.2: add a factory to `CANDIDATES` in `tools/voxel-bench/harness.ts` and run
  `node tools/voxel-bench/run.mjs --candidate <name> --edge 32,16` (memory-capped scope; ~11 min for both edges,
  hilly 3.5–4.7 min of it); `--worlds`, `--sample-tiles N`, `--no-bench`, `--quick` cut it down.

### 45.2a palette candidates

The palette family in `@thirdlight/voxel` (`PaletteStore`, `palette-*.ts`, `cell-layout.ts`, `surface-density.ts`,
`chunk-index.ts`), each run over every test world whole, both edges, 6 GB scope, 2026-11-01 23:26 – 11-02 00:23,
same host as 45.1b, load 1.3–2.2, peak RSS 0.7–0.9 GB. Reports: `~/.cache/thirdlight-phase45/work/45.2a/results/<candidate>/`
(scratch; no world files). Candidates (all share the chunk index, the surface-only density and uniform collapse):
- **P** `palette`: one record palette per chunk (material, category, orientation packed per entry, a flag for
  surface voxels), ids bit-packed at 0/1/2/4/8/16 bits; at rest the palette codec v1 (decision log), packed.
- **PR** `palette-runs`: P with vertical runs per column in memory (offsets per column, start + entry per run) and
  runs at rest. `palette-rest-runs`: P in memory, runs only at rest.
- `palette-planes`: one palette per plane (material + flag, category, orientation), packed.
- `palette-nocat` / `palette-noorient`: P keeping no category / no orientation plane (what the plane costs in memory).

Checks: every chunk of every world exported equal to the generated one, `voxelAt` compared on 1 cell in 37 of every
chunk (1.1 M cells on a 256 m world, 100 M on the hilly one), every fourth chunk decoded and compared, and the
benchmark's 200 k edits and 1,500 strokes replayed on the dense oracle and compared at 2 M random cells plus a 19³ box
around every stroke: all equal, every candidate, both edges. Liquids with a partly full top cell (lakes, ponds, cave
water) and the town's thin features (banister posts, rails, beams, oriented stairs and roofs) are in that data.

Memory (MB if the whole world were loaded; counted arrays, uniform chunks 8 B), zstd (each chunk's codec bytes, zstd 3,
MB) and speed at **32³** [16³]; dense re-run on the new chunk index. Window heap = measured JS heap + array buffers
of the 256 m benchmark window (64 m for vertical) after GC; it includes per-object overhead the count leaves out.

| World | Store | Memory MB | zstd MB | zstd MB/km² | window heap MB | voxelAt rand / coh ns | sphere 4 m / box 8 m µs | enc / dec µs a chunk |
|---|---|---|---|---|---|---|---|---|
| plain | dense | 210 [189] | 0.39 [0.67] | 5.9 [10.2] | 211 | 113 / 9.5 | 49 / 86 | 44 / 45 |
| plain | P | 4.2 [2.7] | 0.28 [0.50] | 4.3 [7.6] | 5.0 [5.1] | 35 / 14 | 77 / 133 | 70 / 117 |
| plain | PR | 6.8 [6.9] | 0.29 [0.52] | 4.4 [7.9] | 7.7 | 42 / 15 | 144 / 295 | 113 / 131 |
| plain | planes | 5.3 [3.3] | 0.30 [0.51] | 4.5 [7.8] | 6.8 | 44 / 15 | 101 / 180 | 139 / 185 |
| hilly 4 km² | dense | 18,386 [17,316] | 49.4 [74.2] | 12.4 [18.6] | 301 | 129 / 10 | 56 / 86 | 53 / 50 |
| hilly | P | 371 [207] | 23.7 [43.3] | 5.9 [10.8] | 6.5 [5.5] | 42 / 14 | 93 / 144 | 55 / 70 |
| hilly | PR | 387 [388] | 25.5 [48.3] | 6.4 [12.1] | 7.0 | 36 / 12 | 145 / 272 | 78 / 69 |
| hilly | planes | 463 [247] | 26.4 [46.4] | 6.6 [11.6] | 8.4 | 34 / 13 | 107 / 178 | 108 / 110 |
| town | dense | 213 [199] | 0.35 [0.69] | 5.4 [10.5] | 206 | 118 / 11 | 58 / 88 | 54 / 56 |
| town | P | 6.2 [3.1] | 0.11 [0.35] | 1.7 [5.4] | 6.5 [5.4] | 57 / 14 | 90 / 132 | 116 / 168 |
| town | PR | 5.4 [6.0] | 0.16 [0.43] | 2.4 [6.6] | 5.9 | 39 / 14 | 144 / 265 | 131 / 125 |
| town | planes | 9.8 [4.8] | 0.19 [0.42] | 2.9 [6.4] | 10.5 | 47 / 17 | 105 / 179 | 202 / 224 |
| caves | dense | 283 [255] | 8.4 [8.4] | 129 [128] | 284 | 136 / 12 | 61 / 84 | 53 / 50 |
| caves | P | 26.6 [19.9] | 3.6 [4.2] | 55 [64] | 28.6 [31.4] | 173 / 20 | 114 / 143 | 239 / 322 |
| caves | PR | 28.3 [33.0] | 4.7 [5.6] | 72 [85] | 31.0 | 312 / 21 | 157 / 304 | 393 / 348 |
| caves | planes | 34.6 [25.6] | 4.6 [5.1] | 70 [78] | 39.3 | 248 / 25 | 114 / 195 | 483 / 501 |
| vertical | dense | 3,215 [3,019] | 27.7 [30.4] | 422 [464] | 294 | 136 / 11 | 55 / 81 | 52 / 48 |
| vertical | P | 141 [86] | 12.2 [16.6] | 187 [253] | 15.3 [13.8] | 80 / 16 | 87 / 141 | 144 / 183 |
| vertical | PR | 115 [117] | 14.3 [20.3] | 218 [310] | 12.6 | 82 / 16 | 266 / 515 | 216 / 186 |
| vertical | planes | 191 [113] | 15.1 [19.6] | 230 [299] | 22.0 | 125 / 19 | 110 / 189 | 325 / 323 |

Single edits: P 0.07–0.20 µs [0.19–0.29], PR 0.13–0.30 [0.38–0.49], dense 0.08 [0.10–0.15]. Worker round trip of a
zstd chunk 3–17 µs, transferred or copied alike (chunks are a few KB). Encode/decode µs are means over every chunk,
uniform ones included (a uniform chunk is 13 bytes); 16³ chunks encode/decode in 5–23 / 5–35 µs.

What each choice costs and saves, and the requirement it serves:
- **Palette + bit packing, uniform collapse (R15–R17):** memory 10–84× below dense (P at 32³: 0.10 B a voxel on plain
  ground up to 0.47 B in caves; ~4 bytes was the target, O6). Uniform chunks (59–77 % of terrain and town chunks) cost
  8 B each. The general compressor then lands at 1.7–5.9 MB/km² on terrain and town (dense raw planes: 5.4–12.4),
  caves 55 MB/km² (dense 129). Random `voxelAt` gets 1.7–3.2× faster than dense (35–80 ns; less memory, fewer cache
  misses) except caves (173 ns: 4–8-bit palettes); coherent column scans cost 14–20 ns (dense 9.5–12). Strokes cost
  1.5–1.9× dense (palette lookup and reference counts per cell).
- **Surface-only density (R19):** 0–3.8 % of cells carry a byte; P stores 4 B a surface voxel in memory (sorted
  cell/density) and 1 B at rest. Without it the shape plane's 1–254 values would multiply palette entries per column.
- **Record palette vs per-plane palettes (R16, R20):** the record palette wins on memory and size on every world: per-plane needs 1.2–1.6×
  the memory and 1.1–1.7× the zstd bytes; random reads 0.8–1.6× P's. The reason is the category plane: as its own
  plane it costs 6–31 % of the zstd bytes (town 31 %), inside a record palette 0.2–2.9 %, because category follows
  material in these worlds. R20's "planes, then zstd" is kept at rest: the codec writes each field of the palette
  as its own plane.
- **Category plane (Q-a, R11, R14, R101):** P without it saves 0 % memory and 0.2–2.9 % zstd at 32³ (1.1–4.7 % at
  16³). Cheap enough to keep as stored intent; caveat: in these worlds no material is used in two categories (a
  material used as wall and roof would add palette entries, still small).
- **Orientation plane (O8):** P without it saves 5 % memory and 3.2 % zstd in the town, ≤ 0.8 % elsewhere. Stored per
  voxel it costs little; deriving it needs a rule set 45.2a does not have, so storing stays the cheaper option for now.
- **Vertical runs (R18), in memory (PR):** not a win. Memory at 32³ is +4–6 % on hilly and caves, +62 % on plain,
  −13–19 % only in town and vertical; at 16³ it is 1.4–2.6× P (offsets per column); strokes cost 1.4–3.7× P and
  caves' random reads 1.8×. **At rest only** (`palette-rest-runs`): codec bytes shrink 27–49 % before zstd (hilly
  322 → 223 MB; plain +15 %) but zstd of them is 2–47 % larger than zstd of packed ids (zstd finds the column runs itself). Runs
  serve R18's goal (plain ground near height-map cost) no better than packing + zstd: plain is 4.3 MB/km² either way,
  below the §1b estimate of 8–15. Proposal for the owner (R1): keep R18's goal, met by packing + zstd; drop column
  runs unless 45.2b's codec comparison (lz4 has no entropy stage) shows runs pay off without zstd.
- **16³ vs 32³ (R22, O1):** 16³ needs 0.5–0.75× the memory of 32³ (palette widths fit smaller regions), similar
  read speed, slower single edits (0.19–0.29 µs) and 1.2–3.2× the zstd bytes (frame and header overhead per chunk,
  less context); measured window heap shows per-chunk object overhead eating part of the gain (caves 16³: 19.9 MB
  counted, 31.4 MB heap). Memory favours 16³, disk 32³; 45.2b weighs it with region files (45.3) and the apron
  radius (Q-c).
- **Chunk index (R21 access):** dense random reads did not get faster on the shared index (113–136 ns vs 110–123):
  they are cache misses into 164 KB chunks, not lookups (decision log).
- **Codec cost:** encode/decode run per-cell JS loops (~3 ns a cell, 100–200 µs a non-uniform 32³ chunk); word-level
  paths (copying packed words when the ids are already canonical) are untried headroom.

### 45.2b bricks, codecs and the 45.2 pick

**Candidate B, sparse bricks** (`BrickLayout`, `brick-layout.ts`; harness candidate `bricks`): the record palette of P
with each chunk split into 4³-cell bricks (8³ in a 32³ chunk, 4³ in 16³). A brick of one entry is just that id (u16);
a mixed brick keeps its 64 ids bit-packed at the palette width in a slot pool; one mask bit per brick says which.
Edits split a brick into a free slot and fold it back when its words equal the id's repeated pattern. At rest the
codec v1 gains body 3 (bricks: mask, uniform ids, mixed bricks; a mixed brick of one id is refused). Same checks as
45.2a on every world and both edges (export, `voxelAt` 1 in 37, decode, 200 k edits + 1,500 strokes vs the dense
oracle): all equal. Run 2026-11-02 00:52–01:13, 6 GB scope, load 1.6–2.0, peak RSS 788 MB. Reports:
`~/.cache/thirdlight-phase45/work/45.2b/results/` (scratch; corpus files kept there for 45.5's streaming page).

| World (32³) | Memory MB B / P | zstd MB B-body / P-body | voxelAt rand ns B / P | coherent ns B / P | edit µs B / P | sphere 4 m / box 8 m µs B (P) | decode µs/chunk B / P (Node) |
|---|---|---|---|---|---|---|---|
| plain | 2.1 / 4.2 | 0.29 / 0.28 | 35 / 35 | 14 / 14 | 0.10 / 0.07 | 87 / 155 (77 / 133) | 132 / 117 |
| hilly 4 km² | 163 / 371 | 27.5 / 23.7 | 36 / 42 | 13 / 14 | 0.24 / 0.17 | 108 / 165 (93 / 144) | 91 / 71 |
| town | 2.0 / 6.2 | 0.15 / 0.11 | 38 / 57 | 15 / 14 | 0.10 / 0.14 | 91 / 146 (90 / 132) | 205 / 168 |
| caves | 15.4 / 26.6 | 3.77 / 3.63 | 111 / 173 | 22 / 20 | 0.14 / 0.20 | 92 / 148 (114 / 143) | 436 / 322 |
| vertical | 55 / 141 | 12.6 / 12.2 | 67 / 80 | 17 / 16 | 0.13 / 0.14 | 97 / 163 (87 / 141) | 246 / 183 |

At 16³ bricks need 1.9 / 145 / 1.6 / 14.2 / 50 MB (0.8–0.92× of 32³; P at 16³ was 0.5–0.75×), the measured window
heap is 2.2–3.4× the counted bytes there (5.2–30.8 MB vs 2.8–18.2 at 32³), and random reads are 41–248 ns.

- Bricks hold a world in 0.3–0.6× P's memory (0.04–0.27 B a voxel; ~4 B was the target, O6) and read randomly as
  fast or faster (caves 1.6×, town 1.5×); coherent scans cost 1.0–1.1× P, single edits 0.7–1.4×, strokes 0.8–1.2×. They lose at
  rest: the brick body is 2.6–4× smaller raw but zstd of it is 3–36 % larger than zstd of the packed body (zstd
  finds the uniform runs itself, and the mask/id split breaks its context).
- The brick mask is a free coarse occupancy level: a uniform air or solid brick is 64 cells a ray, mesher or
  culling pass skips at once (input for 45.6, not yet measured as such). A two-level 64-bit mask tree was not tried.

**Codecs** on P's packed body (B's body in brackets), whole worlds, MB/km² at 32³:

| World | zstd 1 | zstd 3 | zstd 9 | zstd 19 | zstd 3 + dict | deflate 6 | lz4 | runs body: zstd / lz4 |
|---|---|---|---|---|---|---|---|---|
| plain | 5.48 | 4.30 [4.45] | 4.09 | 3.86 | 4.31 | 3.98 [3.82] | 5.15 [5.20] | 4.40 / 5.30 |
| hilly | 6.27 | 5.91 [6.87] | 5.62 | 5.46 | 5.86 | 5.92 [6.52] | 8.46 [9.92] | 6.38 / 8.64 |
| town | 1.75 | 1.66 [2.25] | 1.48 | 1.42 | 1.62 | 1.69 [1.75] | 3.01 [3.72] | 2.44 / 3.86 |
| caves | 56.7 | 55.4 [57.6] | 51.8 | 48.8 | 55.8 | 55.9 [56.0] | 86.5 [76.1] | 72.0 / 107.5 |
| vertical | 194 | 187 [192] | 172 | 165 | 187 | 186 [185] | 275 [242] | 218 / 294 |

At 16³ deflate beats zstd 3 (hilly 9.0 vs 10.8 MB/km²): a zstd frame costs 9 bytes, a 13-byte uniform chunk becomes
22, and 88 % of 16³ chunks are uniform. The dictionary (110 KB of other-seed chunks, raw content) saves at most 2.4 % and
fzstd cannot decode with one (caves and vertical grow 0.4–0.7 %). zstd 19 saves 8–14 % over level 3 and compresses at 3–20 MB/s (export-time only).

**Decode in a browser module worker** (`node tools/voxel-bench/run.mjs decode`; Chrome 151 headless, this host, best
of 3; 2,000 sampled chunks a world, uniform ones included; 2026-11-02 01:35, load 1.6). µs a chunk at 32³, P body:

| World | fzstd (zstd 3) | lz4js | DecompressionStream deflate | palette decode after it | fzstd MB/s |
|---|---|---|---|---|---|
| plain / hilly / town | 7.1 / 6.6 / 9.6 | 3.3 / 3.6 / 5.5 | 171 / 165 / 161 | 70 / 46 / 77 | 376 / 442 / 498 |
| caves / vertical | 53 / 17 | 22 / 9.4 | 193 / 166 | 190 / 115 | 226 / 359 |

- zstd costs 4–53 µs a chunk in plain JS (fzstd, 3.4 KB gzip), 9–22 % of the chunk's total decode; the palette
  decode (per-cell JS loops) is 46–190 µs and is where the time is. lz4js saves 3–31 µs a chunk for 1.4–1.8× the
  bytes (1.2–1.8× after zstd 3; 2.5 KB gzip). DecompressionStream costs ~160–190 µs a chunk however small (stream setup; starting all
  chunks at once does not help), so per-chunk deflate is out; whether it pays when a region's range is inflated in
  one stream is 45.3/45.5's to measure. Both decoders pass the export scan as strict non-bundle files. WebAssembly
  zstd was not tried: fzstd's 4–53 µs leaves little to win next to the palette decode.

**Chunk edge** (`node tools/voxel-bench/run.mjs costs`; aprons as dense 5-byte records, worker round trip measured):
at R = 2 a job reads 42 % more cells than its chunk at 32³, 95 % at 16³ (R = 4: 95 % / 238 %); moving an apron to a
worker costs 3.2–7.1 µs transferred at either edge. A stroke at a random place with R = 2 rebuilds 1.7–4.3 chunks at 32³
(55–141 k cells) and 2.6–11.4 at 16³ (11–47 k cells): 16³ re-meshes 3–5× fewer cells per edit, in 1.6–2.7× more
jobs. 32³ has 7.5× fewer present chunks (hilly 112 k vs 845 k: index entries, region-table rows, frames, range
requests), 1.2–3.2× smaller zstd and, with bricks, 1.1–1.3× the memory of 16³.

**The 45.2 pick (DRAFT; owner approves at the 45.7 hard stop):**
- **Store family:** one record palette per chunk (45.2a), uniform chunks collapsed, density only on surface voxels;
  **in memory: sparse 4³ bricks** under a per-chunk mask (B).
- **Chunk edge: 32³** (16 m). Edit latency is 16³'s one win; meshing jobs can split a 32³ chunk into sub-chunk
  regions if 46 measures that it matters (proposal, unmeasured).
- **At rest: codec v1 with the bit-packed body, then zstd level 3 per chunk** (zstd 19 for exports, which are
  derived); decoded in workers with fzstd. Uniform chunks: 13 bytes, best kept out of zstd frames (45.3).
- **Size:** 1.7–5.9 MB/km² on terrain and town, 55 MB/km² caves, 187 MB/km² for a 2 km column; memory 0.04–0.27 B a
  voxel, 41 MB/km² loaded on hilly ground (bricks) vs 3.3 GB dense.
- **Rejected:** P packed in memory (1.7–3.1× bricks' memory); bricks body at rest (+3–36 % zstd); column runs
  (45.2a; under lz4 too: +2–28 % over packed); per-plane palettes (45.2a); 16³ (above); lz4 (1.2–1.8× bytes for
  3–31 µs a chunk); per-chunk deflate (160–190 µs a chunk in a worker); zstd dictionary (≤ 2.4 %, fzstd can't).

### 45.3 region files

**Region file v1 DRAFT** (`packages/voxel/src/region-file.ts`; pure, so workers and exports read it; the compressor
is passed in): a 64-byte header (magic `TLVR`, version, layout column/stacked, chunk edge, chunk codec version,
compressor id, chunks a side, 16-byte world id, grid id (0 = world grid, else a structure grid), region x/y/z,
entry count, data bytes, CRC-32 of the table, CRC-32 of the header), then one 12-byte table entry per present
chunk (column and flags, chunk y, then a uniform chunk's record value, or a stored chunk's length and CRC-32), then
the stored chunks back to back in table order (offset = sum of the lengths before it). All-air chunks are absent;
uniform chunks live in the table only; a chunk is stored raw only when zstd does not shrink it. Canonical bytes
(sorted entries, no duplicate or air entry, zero reserved fields, exact length; no time anywhere). Reader:
`openRegion` (header + table in one 32 KB request for tables up to ~2,700 entries), `readRegionChunks` (absent =
air, coalesced ranges, a damaged chunk comes back `damaged` with its coordinates, never as air),
`damagedRegionChunks` (whole-file scan). Header/table damage, an unknown version, layout, compressor or chunk codec
version, set reserved bytes and a wrong length refuse the file. Vitest (`tools/voxel-bench/region.test.ts`, real
zstd, real files, a real HTTP range server): round trip, byte-identical files for equal content reached by different
edit orders and entry orders, 3×3 range reads from disk and HTTP, corrupt header/table/chunk, unknown version,
inline uniform chunks, 2 km column vs stacked cubes, a structure grid in its own container.

Run 2026-11-02 03:39–03:52 (repo part rerun 03:53–04:01), 6 GB scope, load 0.4–1.6, i5-12600H;
`node tools/voxel-bench/run.mjs region` (the pick: record palette, bricks in memory, packed body + zstd 3 at rest,
32³). Results: `~/.cache/thirdlight-phase45/work/45.3/results*/` (region.md/json; scratch repos deleted).

| World (whole) | 256 m column: files, MB, MB/km² | header + table (share) | uniform entries | 512 m column | 256 m stacked | max file 256 m column / stacked |
|---|---|---|---|---|---|---|
| plain 256 m | 1, 0.280, 4.28 | 15 KB (5.5 %) | 769 of 1,280 | same | 2 files, +0.1 % | 281 / 245 KB |
| hilly 4 km² | 64, 23.10, 5.78 | 1.35 MB (5.8 %) | 86,418 of 112,218 | 16 files, 23.10 | 128 files, 23.11 | 402 / 390 KB (512 m: 1.49 MB) |
| town 256 m | 1, 0.102, 1.55 | 15 KB (14.9 %) | 768 of 1,253 | same | 2 files | 102 / 76 KB |
| caves 256 m | 1, 3.65, 55.7 | 21 KB (0.6 %) | 3 of 1,727 | same | 2 files | 3.65 / 2.18 MB |
| vertical 256 m × 2 km | 1, 12.30, 188 | 236 KB (1.9 %) | 7,206 of 19,625 | same | 8 files, 12.30 | 12.30 / 2.69 MB |

- **Tile size and layout cost nothing in bytes** (±0.1 %); they decide file size, file count and what a save
  rewrites. Header + table are 5.5–5.8 % on terrain, mostly uniform deep-ground entries (77 % of hilly entries);
  the town's 15 % is its small body. The 11 rotated houses in their own containers: 44 files, 9 KB (39 % header and
  table): their local grids straddle cell 0, so each house splits over four regions.
- **One stream per region instead of a frame per chunk** (45.2b's open question): zstd 3 of a 256 m region's
  concatenated chunk bytes saves 1.8 % on hilly ground (21.35 vs 21.75 MB body), deflate 2.3 %; plain 15 %, town
  22 %, caves +3 % worse. It would cost random access: one chunk then needs the whole tile (~360 KB) fetched and
  inflated. Per-chunk frames stay.
- **Range reads** (1 km² hilly area, 60 surface spots, page cache warm; the HTTP server is a separate Node process
  on loopback): one chunk with the table cached 0.018 ms disk / 0.41 ms HTTP (median); cold (header + table + chunk,
  2 requests, 34 KB) 0.20 / 1.38 ms (p95 1.06 / 5.4). A 3×3×3 neighbourhood (12.5 stored chunks, 12 KB): apart 12.5
  requests, 0.12 / 1.67 ms; coalesced over gaps ≤ 4 KB 3 requests, 0.08 / 0.54 ms, no extra bytes; ≤ 64 KB 1 request,
  0.06 / 0.35 ms but 47 KB fetched. Default gap 4 KB. Decode (zstd + palette into the brick store, Node) 239 µs a
  chunk. Real network latency is per request, so coalescing matters more off loopback (45.5 measures it there).
- **Write amplification** (a save rewrites the whole file; mean of 60 random surface edits): one voxel changes
  1 chunk (1.2 KB entry) and rewrites 363 KB at 256 m column, 351 KB stacked, 1.45 MB at 512 m; a 4 m brush changes
  1.9 chunks, same files. On the 2 km tall world a column file is 12.3 MB: one voxel rewrites 12.3 MB (12,900×),
  stacked 256 m cubes 1.47 MB, 512 m cubes 2.70 MB.
- **Repo growth** (scripted hour on the 1 km² hilly area, 5.8 MB of region files: a stroke every 3 s, 1,200
  strokes, a cursor wandering ~5 m a stroke and jumping every 5 min; half 1–2 m dabs, a quarter 4 m dabs, a quarter
  walls; one scratch repo per layout):

| Layout | Commit every | Files / commit | MB written / commit | .git growth / hour, loose | after `git gc` | blobs in pack (deltas) |
|---|---|---|---|---|---|---|
| 256 m column | 10 min | 3.7 | 1.33 | 7.0 MB | 0.13 MB | 38 (22) |
| 256 m column | 2 min | 1.6 | 0.59 | 15.6 MB | 0.22 MB | 65 (49) |
| 256 m stacked | 10 min | 3.7 | 1.28 | 6.9 MB | 0.14 MB | 54 (34) |
| 512 m column | 10 min | 2.8 | 4.11 | 21.8 MB | 0.13 MB | 21 (17) |
| 512 m stacked | 10 min | 2.8 | 3.97 | 21.6 MB | 0.14 MB | 25 (19) |

- Git's delta compression works on these binary files: unchanged chunks keep byte-identical frames (the writer
  re-packs only edited chunks), so `git gc` stores a new version as a delta of a few KB. Loose objects (whole files,
  zlib) grow 7–22 MB an hour until gc; git's own `gc --auto` packs them at 6,700 loose objects, long after that.
  **LFS is not called for:** it stores every version whole, with no delta, so it would keep the 7–22 MB an hour
  forever; the packed history grows 0.13–0.22 MB an hour.
- **10 × 10 km:** 1,600 tiles at 256 m (400 at 512 m); plain to hilly ground at 4.3–5.8 MB/km² (tables included)
  projects to **430–580 MB** of region files, ~270–360 KB a tile; 256 m stacked: about twice the files where ground
  straddles a stack boundary. zstd 19 at export is 8–14 % smaller per 45.2b (not re-measured on region files).
  Mountains, caves and dense towns move it: caves are 56 MB/km², a 2 km column 188 MB/km² (both whole-world test
  cases, not typical ground).

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
- 2026-11-01 (45.0): three.js check at the phase start: `npm view three version` gives 0.187.0 (published
  2026-10-30), the version in use. No newer release than the one in use, nothing to assess; no update.
- 2026-11-01 (45.0, default chosen, owner to confirm): the staging backend is `tools/staging.sh` running the
  checkout's `dist/` as the transient systemd unit `thirdlight-staging` (a unit, not a scope, so it is detached and
  stops by name), 6 GB cap and no swap, on 127.0.0.1:4180/4181 (`TL_STAGING_HOST` for the LAN when the workstation
  needs it), data root `~/thirdlight-staging-p45` with its own owner token. It refuses production's ports and data
  root (read from the `thirdlight` unit), a taken port, and less than 8 GB available. Its only test world so far is
  the empty project `staging-empty`, made by `smoke` through the admin API and read back with `queryProject`. Proven
  2026-11-01: start, editor page 200, project created then found again, stop with the unit gone and both ports free.
  `tools/staging.test.mjs` runs the script's refusals (vitest); the start itself needs sudo and 8 GB, so it is not
  in the gate.
- 2026-11-01 (45.0): the village and level perf runs take `--viewport WxH` (default 1920x1080, as every record
  before) so the low tier's 720p goal is measured, not inferred; the gate's baseline check stays at 1080p
  (`--viewport` is refused with `--gate`, `--check`, `--write-baseline`). Editor pages inside those runs (Scene view,
  edit windows, the see-through mid-run switch) stay 1080p.
- 2026-11-01 (45.1b, default chosen, owner to confirm): voxel code lives in `packages/voxel` (`@thirdlight/voxel`),
  pure like the runtime (no packages, no three.js, no Node built-ins; its own boundary row, own commit). Node-only
  tooling over it lives outside the package (`tools/voxel-bench/`, typechecked with the packages); no separate
  Node entry point is needed yet.
- 2026-11-01 (45.1b, default chosen, owner to confirm): voxel coordinates are integer cells, x and z in ±32,768
  (±16.4 km: a 10 km world centred or cornered on the origin) and y in ±8,192 (±4.1 km: 2 km of height anywhere
  around y = 0, the same again as headroom). A chunk key is one integer below 2^35 (x, then z, then y: a column's
  chunks are consecutive); cells in a chunk are stored y fastest. Every chunk function takes the edge (16 or 32), so
  45.2 decides it without touching callers. Where a world sits inside these bounds (O2) is still 45.2/45.3's.
- 2026-11-01 (45.1b, default chosen, owner to confirm): the harness's `VoxelRecord` is a PROVISIONAL test shape
  (material 16 bits; category, shape, orientation 8 bits; categories air, terrain, construction, roof, liquid =
  Q-a option 1). It exists so planes can be measured apart; it is not the format and decides nothing for Q-a.
- 2026-11-01 (45.1b): test-world choices that move the numbers: shallow worlds' ground goes 64 m deep; a cell
  partly ground and under liquid stays ground (one material per cell; O15 open); liquid surfaces sit inside a cell
  so the top liquid cell is partly full; rotated houses are their own chunk sets (cheap, so the town includes them).
- 2026-11-01 (45.2a, default chosen, owner to confirm): a **surface voxel** (the only kind that stores a density
  byte, R19) is one whose shape differs from the shape its material implies: air empty, any other material full. So
  partly filled ground and a liquid's partly full top cell carry a byte; full ground, full liquid and air carry none.
  It is a rule on the stored value, not on neighbours, so it is exact and lossless (a non-air cell with shape 0 is
  kept too) and an edit never touches a neighbour's bytes.
- 2026-11-01 (45.2a, default chosen, owner to confirm): palette ids are bit-packed only at 0, 1, 2, 4, 8 or 16 bits
  (no cell straddles two words; a read is one load, shift and mask); a one-entry palette is width 0 (no per-cell
  storage). A chunk that is one voxel everywhere is a single number in the chunk index, an all-air chunk is absent
  (R17). Palettes are reference-counted; a palette narrows only when its live entries fit half the width and fill a
  quarter of it, or one entry is left (hysteresis, so an edit toggling one value does not repack the chunk).
- 2026-11-01 (45.2a, DRAFT, not the format): the palette chunk codec v1 measured here: 8-byte header (magic `VC`,
  version, flags: planes held, edge, body uniform/packed/runs, record or per-plane palette; CRC-32 of the body),
  each field written as its own plane, canonical bytes (entries by first appearance, no unused or repeated entry, no
  stored density equal to the implied one; the decoder refuses anything else, an unknown version included), so the
  same content always gives the same bytes (R3, R5 except the world-scoped key, which 45.3's region table holds; R51).
- 2026-11-01 (45.2a): one chunk index for every store (`ChunkIndex`, open addressing on the split key column/y);
  the dense baseline was re-run on it. Correction to 45.1b's note: a `Map` lookup on the 2^35 key costs 20–42 ns
  (microbenchmark, 6k–25k chunks), the index 15–20 ns; the rest of dense's 110–184 ns random read is cache misses
  into 164 KB chunks.
- 2026-11-02 (45.2a, for the owner, R1): vertical run-length encoding (R18) did not pan out against palette packing:
  in memory it costs as much or more and slows strokes 1.4–3.7×; at rest zstd of packed ids is 2–47 % smaller than
  zstd of runs. Its goal (plain ground at about height-map cost) is met without it: 4.3 MB/km² for plain ground at
  32³. Proposed replacement: packing + a general compressor; runs kept only if 45.2b's lz4/browser-decode comparison
  shows they pay where no entropy stage runs. Not dropped until the owner chooses. Per-plane palettes likewise lose
  to one record palette (R20 kept by writing each field as its own plane at rest).

- 2026-11-02 (45.2b, default chosen, owner to confirm): the 45.2 pick (DRAFT, see **45.2b bricks, codecs and the
  45.2 pick**): record palette per chunk, sparse 4³ bricks in memory, codec v1 bit-packed body + zstd 3 per chunk at
  rest (zstd 19 for exports), 32³ chunks, fzstd in workers. The memory form and the bytes at rest differ on purpose:
  bricks win memory and random reads, the packed body wins after zstd.
- 2026-11-02 (45.2b, default chosen, owner to confirm): fzstd 0.1.1 and lz4js 0.2.0 are root dev dependencies of the
  voxel bench (pinned in `tools/check-deps.mjs`), shipped in no bundle yet. fzstd is the proposed worker decoder for
  46a (3.4 KB gzip, passes the export scan); lz4js is a measurement only (it also allocates 5 MB on load).
- 2026-11-02 (45.2b, for the owner, R1): R18's replacement stands: column runs do not pay without an entropy stage
  either (lz4 of the runs body is 2–28 % larger than lz4 of the packed body). R20 ("planes, then zstd") holds with
  zstd; lz4 and per-chunk deflate lose (numbers in 45.2b).
- 2026-11-02 (45.2b): the codec v1 DRAFT gains body 3 (sparse bricks) so bricks could be stored as they are; the pick
  does not use it at rest. A chunk of 13 bytes costs 22 in its own zstd frame and 13 in deflate: 45.3 should keep
  uniform chunks out of frames (in the region table) rather than change the codec.
- 2026-11-02 (45.3, default chosen, owner to confirm): region file v1 DRAFT as in **45.3 region files**: 64-byte
  header (magic, version, layout, edge, chunk codec version, compressor, world id, grid id, region x/y/z, counts,
  table and header CRC-32), a sorted 12-byte entry per present chunk with uniform chunks inline and per-chunk length
  and CRC-32, stored chunks after it in table order. The world-scoped key of a chunk (R5) is world id + grid id +
  chunk coordinates, held once per file. Files are canonical, so equal content gives equal bytes whatever the edit
  order (tested). Caveat: a chunk's zstd frame depends on the zstd build; the writer re-packs only edited chunks and
  copies the others' frames, so a Node/zstd upgrade changes only what is edited afterwards.
- 2026-11-02 (45.3, default chosen, owner to confirm): **tile 256 m stays.** 512 m costs the same bytes but a save
  rewrites 4× as much (1.45 MB vs 363 KB for one voxel) and loose git growth is 3× (21.8 vs 7.0 MB an hour); its one
  win is 4× fewer files (400 vs 1,600 for 10 km).
- 2026-11-02 (45.3, for the owner, R1): **full-height columns (R50 default) do not pan out on tall ground.** Same
  bytes as stacked cubes, but a 256 m tile of the 2 km test world is one 12.3 MB file: every save of a one-voxel edit
  rewrites 12.3 MB, and each commit adds 12 MB of loose objects. Proposed replacement keeping R49/R50's goals (no
  height limit, small commits): **stacked 256 m cubes** (region x, y, z; a stack is absent when its air allocates
  nothing): one-voxel saves rewrite 1.47 MB there, files stay under 2.7 MB. Cost: twice the files on terrain that
  straddles a stack boundary (hilly 64 → 128 files), +0.1 % bytes. Both layouts are in the format (the layout byte);
  45.4/45.5 use stacked unless the owner keeps columns. Not dropped until the owner chooses.
- 2026-11-02 (45.3, default chosen, owner to confirm; O2): **vertical bounds** stay the coordinate bounds (±8,192
  cells, ±4.1 km; 45.1b); the format stores no world base or height: a world's extent is the chunks it has, so a 2 km
  world sits anywhere in it with headroom both ways and empty sky or depth costs nothing. Stacks are aligned at y = 0
  (boundaries every 256 m); a per-world stack offset to keep typical ground in one stack is possible later, unmeasured.
- 2026-11-02 (45.3, default chosen, owner to confirm; O9): **structure grids** use the same container: one set of
  region files per structure grid, grid id in the header, its own local region coordinates, in a folder per grid id.
  The transform is not in the voxel file (moving a structure changes its record, not its voxels; 47a owns the
  record). Measured: 11 test houses = 44 files of ~200 B, because their local grids straddle cell 0; proposal for
  47a: anchor a structure's local grid at its foundation's minimum corner so a structure under 256 m is one file.
  Packing many small grids into one file per tile is the fallback if file counts hurt (unmeasured).
- 2026-11-02 (45.3, default chosen, owner to confirm; R53): **no Git LFS.** Packed history grows 0.13–0.22 MB an hour
  of heavy editing (1,200 strokes) because git deltas the files (unchanged chunk frames are byte-identical); loose
  objects grow 7–22 MB an hour until gc. LFS keeps every version whole without deltas, i.e. the loose number forever.
  Recommended instead: run `git gc` (or `git gc --auto` with a lower `gc.auto`) after saves/commits; derived data
  stays out of the repo (R54).
- 2026-11-02 (45.3): range reads coalesce stored chunks across gaps up to 4 KB (3 requests and no extra bytes for a
  3×3×3 neighbourhood; 64 KB merges to 1 request but fetches 4× the bytes); per-chunk zstd frames stay (one stream
  per region saves 1.8–2.3 % on hilly ground but loses random access). A damaged chunk is reported with its
  coordinates and never read as air (R4); repairing it (from the shipped base, a structure regeneration or the save)
  is 45.4's path.

## 7a. Kit and surface planning session (2026-10-30)

This records the conversation about the reference material kits, art-factory and runtime construction. It revises
the initial full-mesh-kit direction; it does not start the voxel phases or freeze a format. The existing owner
approval stops remain. The role/assembly and material-layout drafts must reflect these revisions before approval.

### Agreed direction: voxel surfaces with inferred architecture

- **Generate the base geometry from the voxel world.** Do not require artists to model every wall/floor surface
  case as a complete replacement kit. The owner has no large art team; minimise bespoke asset work while retaining
  the reference's visual quality. Follow the documented Enshrouded workflow where practical, within our renderer
  constraints, rather than assuming its internals from screenshots.
- **Project tileable material textures onto the base surfaces, using texture arrays.** The owner's initial
  direction is triplanar mapping with full-resolution tileable wall and floor textures, rather than forcing broad
  surfaces into trim bands. A construction material set can provide different surfaces for walls, floors, roofs,
  undersides and other contexts. Surface selection and texture projection are separate decisions. Architectural
  coordinates following a rotated structure's grid are the recommended default, still to prototype.
- **Infer beams, banisters, soffits, ceiling mouldings and running boards.** They must not require manual semantic
  labels or placement as props. Material/construction style and the surrounding voxel arrangement determine the
  architectural expression. A low exposed run may become an open banister; extending its neighbours can change
  it into a wall. Specific predicates and precedence remain to be designed, not inferred as facts about Keen.
- **Runtime building must work too.** A game can offer broad building/roof/terrain categories, materials and shape
  brushes in sizes such as 2 m and 4 m, as in the supplied build-menu reference. Brush dimensions are not render
  mesh dimensions. Broad category metadata may be written automatically; detailed architectural cases must be
  derived from the arrangement. The stored category/role schema is unresolved. Structure authoring metadata must
  not be necessary for equivalent runtime voxel edits to produce the right result.
- **One shared assembly evaluation is the proposed contract.** Before emitting geometry, resolve which base
  surfaces remain, which are suppressed or reshaped, and which detail pieces appear. Replacement is essential
  for open railings or thin beams; a solid base hidden under every detail mesh is insufficient. This revises the
  assistant's withdrawn suggestion that railings should generally be props and replacement merely exceptional.
- **Collision, navigation and light occupancy must agree with the resolved architecture.** An open rail cannot
  automatically retain the behaviour of an opaque full voxel wall. Decide representations and acceptable visual
  approximation explicitly; this revisits §2's blanket modular-box collision and §9's shared solid occupancy.
  Original voxel data remains authoritative; resolved meshes and other representations are derived.
- **Author merge-compatible sections, not separate hand-modelled run lengths.** Repeating bodies, junctions,
  corners and exposed terminations combine into longer features. This supersedes the requirement to author
  separate 0.5/1/2/4 m models. Whether the renderer instances sections or caches merged geometry is a measured
  implementation choice, not an artist obligation.
- **Authored high and low detail meshes, then voxel fallback.** High carries detail; low preserves the important
  silhouette, openings and construction character. Automatic simplification is not a dependable production
  requirement. Beyond detail-mesh visibility, voxel-derived geometry must still look sensible. Distances and
  transitions require observation and measurement; do not freeze the earlier approximate rings as art guarantees.

### Surface subdivision and displacement: investigate before committing

The owner proposed near/middle/base surface levels: densely subdivided voxel surfaces displaced by material height
near the camera, coarser subdivided/displaced surfaces farther out, then undisplaced voxel geometry. This is viable
in principle without a hardware tessellation stage: generate vertices during meshing and displace existing vertices
in the shader. It is **not implemented or measured**, and is not a promise of Enshrouded-equivalent performance.
The earlier blanket rejection of displacement must not be used to rule out this prototype.

- Generate topology on chunk load/edit/LOD changes, not every frame; prototype worker meshing and shader displacement.
- Separate **surface subdivision LOD** from **voxel shape LOD**: reducing relief detail must not immediately erase
  doors or other occupied/empty-cell features.
- Existing terrain CDLOD provides relevant selection/transition ideas, but its heightfield representation cannot
  directly describe caves, walls, undersides and overhangs. Inspect existing code before claiming reuse. A few
  discrete subdivision levels are the suggested first prototype, not a decided adaptive algorithm.
- Prove matching boundaries between chunks and subdivision levels, shared corner displacement, filtered height
  sampling, stable transitions and hysteresis. Shared texture coordinates alone do not prevent geometric cracks.
- Account for normals, shadow-pass displacement, conservative culling bounds, texture residency and vertex cost.
  Shader displacement does not update collision or voxel occupancy. Establish the decorative displacement envelope;
  substantial blocking/walkable features need agreement with the resolved shape. No numerical budget is chosen yet.

### Art-factory workflow: useful proposals and superseded alternatives

The owner wants a dedicated **Kit Designer** alongside Texture Designer/Painter. This is a proposed art-factory
capability, not work performed or authorised in that repository by this session. Thirdlight owns the versioned
assembly contract, case catalogue and validation; art-factory consumes them. Preview should exercise the same rules
as the runtime where practical. Blender or other modelling tools can remain part of the production pipeline.

The discussion explored these approaches in order; they must not be mistaken for simultaneous requirements:

1. **Construction-specific painted atlas.** Assign material IDs in art-factory to select paint-library materials,
   then bake one final texture set per appearance variant into the kit's shared UV layout. IDs are authoring
   assignments, not separate runtime materials/textures. Swap assignments and rebake to make another variant.
   Unique mapping helps ornaments and caps but restarting the same UV patch on each cell exposes repetition.
2. **Sculpt plus construction bakes and a second material mapping.** Sculpt, retopologise the high runtime mesh,
   author low, and bake mesh-specific normals/local AO/IDs into one UV layout. Another mapping samples tileable
   surface materials or trims. The sculpt is an authoring source, not the high runtime mesh itself. This separates
   permanent construction relief from swappable surface character, but adds work and shader/map cost.
3. **Current initial direction:** voxel-derived base surfaces with projected tileables and authored detail pieces.
   Sculpted detail-mesh bakes can supplement the shared material textures where useful; a complete sculpted surface
   kit is not a prerequisite. Surface subdivision/displacement is the pending experiment above.

**Trim sheets are no longer a universal requirement.** The latest discussion asks whether detail meshes can instead
combine their own sculpt bakes with the existing material-array surfaces. Recommended answer: permit this and keep
trim sheets optional for features that benefit from them. Final mapping/channel contracts remain open. A material
array does not replace mesh-specific construction bakes; those are separate shader inputs. Keep Painter IDs in
authoring unless a runtime mask has a defined purpose. Do not invent one runtime draw material per Painter ID.

If two mappings are used, resolve normal blending across their tangent frames, local-only baked occlusion, material
alignment at joins, and high/low bake correspondence. Automatic reuse of a high mesh's normal bake on low is not
guaranteed. Continuous run mapping requires placement-aware coordinates, not just a second static unwrap.

**Larger variation sections:** the owner proposed 2×2 sections for broad walls, floors and roofs to reduce monotony.
The unit was not settled: the assistant interpreted two cells per surface axis (1×1 m), but the owner did not confirm
that rather than 2×2 m. This is not a proposal to change storage chunk size. Prototype larger authored compositions
with compatible subdivisions and stable surviving details after a cell is removed. Do not make nearby stones or
carvings rearrange merely because an intact patch falls back to smaller pieces. Larger patches still repeat; variants
and boundary compatibility need testing. This remains optional research, not mandatory kit scope.

### Deferred material-driven terrain dressing

- Terrain material recipes should eventually generate nearby dressing automatically: grass/flowers for grassy
  ground, small pebbles/stones for volcanic basalt. Do not require painting individual scatter placements.
- **All rule scatter is disposable.** Persistent interactions belong to placed props. No harvesting identities,
  persistent per-instance exceptions or saved millions of scatter positions are required for this system.
- Store rules, stable seed and necessary inputs; derive placements deterministically, independent of chunk loading
  order and floating-origin shifts. The scatter radius stays inside already loaded chunks, including the required
  sampling neighbourhood; cross-boundary sampling need not trigger a separate streaming scheme.
- Terrain edits, building grids and large props contributing to their host grid's occupancy all influence scatter.
  Regenerate the edited chunk and any affected neighbouring region within the rule's influence. Preserve unaffected
  placements. Resolve coverage/occupancy semantics for exclusions rather than assuming every proxy is a solid wall.
- Material-blend boundaries and their scatter behaviour must be configurable. Slope and other recipe conditions can
  refine placement. This is procedural dressing of hand-authored worlds, not procedural world generation.
- **Deferred:** preserve this direction for later planning; do not make it a prerequisite for initial voxel kits.

### Research and reference limits

The strongest technical source found was [Game Dev Podcast #84](https://gamedevpodcast.de/84/), 2024-11-05,
with Julien Koenen and Philipp Krause. Relevant transcript passages and chapter images were inspected; no claim
is made to have watched the entire recording. The transcript contains transcription errors; paraphrase carefully.

- 2:51:30: building relief includes hardware tessellation/displacement.
- 3:01–3:04: runtime neighbourhood rules select authored detail meshes, with stable seeded variants; some inspect
  two voxels away. Long wooden members combine matching authored sections and terminations.
- 3:06:23: GPU culling and instancing for detail objects.
- 3:23:29: triplanar terrain mapping, principal-axis mapping for building faces.
- 3:24:49: MagicaVoxel building authoring with palette-to-engine-material assignment.

See the [layer comparison](https://media.gamedevpodcast.de/gdp084/enshrouded_details.jpg),
[wall/opening comparison](https://media.gamedevpodcast.de/gdp084/enshrouded_wall.jpg) and
[recording near the detail discussion](https://www.youtube.com/watch?v=LJWqNAUff2o&t=10845s).
These document the 2024 implementation. They do not establish today's complete implementation, sculpt/retopology
pipeline, UV/bake contracts, authored high/low pairs, 2×2 patches or thin-feature collision/occupancy behaviour.
The earlier §7 description of kit mechanisms as entirely unpublished, and attribution of biplanar mapping to Keen,
are corrected by this source; our biplanar proposals are not proof of Keen using that technique.

[Keen's world-creation demo](https://www.youtube.com/watch?v=G6wXwZQISVY) and its
[published transcript](https://www.linkedin.com/posts/keen-games_creating-the-world-of-enshrouded-activity-7140369674289995777-SJ2t)
show mesh brushes, subtractive stamps, voxel objects and spline authoring. The
[world-design AMA](https://enshrouded.com/zh-Hant/news/enshrouded-world-design-team-reddit-ama-recap)
describes authored asset pools. Neither supplies a complete detail-mesh production specification.
[GPC 2024](https://graphicsprogrammingconference.com/archive/2024/) covers GI, fog and Vulkan;
[GPC 2025](https://graphicsprogrammingconference.com/archive/2025/) covers water, volumetrics and particles.
No verified kit sculpt-to-bake production talk was found. Existing-vertex displacement is documented by
[three.js](https://threejs.org/docs/pages/MeshStandardMaterial.html); this does not validate our integration.

Visual references reviewed: the fourteen owner-supplied `all-blocks-as-of-now-examples-acquisition-5-for-enshrouded-v0-*.webp`
images at the repository root, plus build-menu image `sbpuwkoh6s0h1.png`. These are reference images, not licensed
production assets or evidence of hidden algorithms. They remain untouched and untracked by this documentation edit.

### What to prove before freezing the revised specification

First prove a shared assembly resolver on a wall, beam and banister as neighbours are added/removed, with openings,
corners and material changes. Observe base-surface suppression, detail selection and collision/light agreement.
Then test a textured wall/floor and roof, chunk boundaries and rotated grids; compare near/middle/base displacement
and detail-mesh transitions. Include a long uninterrupted surface to expose repetition and a local dig/rebuild to
expose unstable variation. Evaluate high and low silhouettes in motion and under moving light on both renderers.
Measure costs before promising parity with the reference. Kit Designer templates, required/fallback cases, join
profiles, mapping conventions and validation should grow from this proof, not from an untested asset-count target.

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
