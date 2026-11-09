# Voxel rendering and materials — format page (46d additions)

Status: **complete for 46d** (checked against the code in 46d.8a): §1 material record (46d.3a, 46d.3b), §2 texture
sets (46d.4a–46d.4d), §3 relief part (46d.5a, drawn 46d.5b, shadows 46d.6d), §4 far tree, far cache and both far
draw modes (46d.7a–46d.7c). This page holds every format addition of 46d (rendering and materials), each as a
versioned, add-only step with its owner note, so the [format spec](voxel-format-spec.md) v1 (APPROVED by the owner
on 2026-11-02) is not grown further; the derived steps 28 → 31 are also rows of its §3.7 history and its §3.8 table.
**Nothing here is approved yet:** every step is "default chosen, owner to confirm" ([plan 46d](../plan-phase-46d.md)
§9), and which far draw mode is the default is the owner's pick (§4). Steps:

| Step | Item | What | Stored formats |
|---|---|---|---|
| material record parts | 46d.3a | `physical`, `gameData`, `voxel` on a material; `content.materialProfiles` | schema 8, add-only |
| texture sets | 46d.4a, 46d.4d | catalog `voxelTextures`, the table's fourth block; height in the normal map's A | manifest v5, add-only |
| derived 28 → 29 | 46d.5a | the relief part | none (derived) |
| derived 29 → 30 | 46d.6c | owned faces merged (format spec §3.7) | none (derived) |
| derived 30 → 31, far cache 1 | 46d.7a | openings closed at coarse levels; the far cache | none (derived, cache) |
| far serving and modes | 46d.7b, 46d.7c | far routes, catalog `far` rows, `voxelFarField` / `voxelFarError` | manifest v5, schema 8, add-only |

§ numbers name the format spec's sections unless marked as this page's. Kits are on
[voxel-kit-format.md](voxel-kit-format.md), the role spec on [voxel-role-spec.md](voxel-role-spec.md), the texture
layout on [voxel-trim-layout.md](voxel-trim-layout.md).

---

## 1. Material record

**Owner note (46d.3a, 2026-11-08):** an add-only step inside project schema 8, not a new format: three optional
parts on the existing material record and one optional content list. A project or build without them reads and
writes byte for byte as before (each part is canonicalized last, only when present). Nothing in the approved
format spec, the role spec, the texture layout or kit format 1 changes; kit format 1's `materials` list keeps its
meaning for the ids no material record names (below). Default chosen, owner to confirm (plan 46d §9).

**Where it lives.** `project-model` `materials.ts` (`MaterialDef`), `material-profiles.ts` and `voxel-materials.ts`.
A material is still its own resource file, as before; profiles live in `content.json`
(`content.materialProfiles`). The record has no version of its own: it rides the project schema (8; a newer schema
is refused whole), unknown fields at every level are refused, and later steps only add fields.

**Fields, in canonical order** after the existing ones (`materialId … layerSheets`):
- `physical?` `{profile?, density?, friction?, restitution?, flowRate?}`: a physical profile id (an engine one or the
  project's) and the numbers it changes. density kg/m³ in (0, 30,000], friction [0, 4], restitution [0, 1],
  flowRate [0, 100] (relative to water = 1; solids leave it out) (`PHYSICAL_LIMITS`). Resolved number by number:
  the material's own, else its profile's, else `PHYSICAL_DEFAULTS` (density 1000, friction 0.5, restitution 0).
  An empty block is left out canonically.
- `gameData?`: any JSON nested at most 32 deep (`game-data.ts`, the kit format's rule), object keys sorted, never
  read by the engine.
- `voxel?` `{id, use, kit?, tileMetres?, heightDepth?, surfaces?}`, in that order:
  - `id` 1–4,095 (the voxel value's 12 material bits; 0 is air), **unique in the project** (`voxel_id_taken`);
    every world of the project shares the ids.
  - `use` `construction` | `terrain` | `liquid` (required on a material; an instance may leave it to its chain).
  - `kit` a voxel kit id the project has (`kit_missing`; deleting that kit is refused the same way); never with
    `liquid`.
  - `tileMetres` 0.5–64 m a texture repeat (absent: `CONSTRUCTION_TILE_METRES` 4 for construction,
    `TERRAIN_TILE_METRES` 2 for terrain and liquid, the derive's own constants).
  - `heightDepth` 0–0.25 m between the height map's 1 (the surface) and 0 (absent: 0.02 m). Relief only recesses,
    and half a 0.5 m cell keeps both sides of a one-cell wall apart.
  - `surfaces` `{wall?, floor?, ceiling?}`, each a texture set `{albedo?, normal?, orm?}` of plain texture
    assets (not arrays: each becomes one layer of its map's array in 46d.4a). Floor and ceiling fall back to wall,
    wall to the material's own look (`voxelSurfaceSet`). Empty sets are left out canonically.
- `content.materialProfiles?`: `[{profileId, name, density?, friction?, restitution?, flowRate?, gameData?}]` by
  `profileId`. Engine profiles are constants (`ENGINE_MATERIAL_PROFILES`: earth, glass, lava, metal, stone, water,
  wood); a project profile with one of their ids overrides it field by field (game data whole), one with a new id
  adds one. A material naming a profile neither has is refused (`reference_missing`).

**Variants are material instances** (`instanceOf`, at most `MAX_MATERIAL_INSTANCE_DEPTH` 8 deep). An instance
inherits its chain's `physical` (number by number), `gameData` (top-level keys, the nearer level's winning; a
non-object replaces) and `voxel` fields (field by field, texture sets map by map) and overrides any. **The voxel id
is identity, never inherited**: an instance with its own `voxel {id, …}` is a voxel variant; one without is a mesh
variant only (no voxel use).

**Shader families** are a derived read, never stored (`materialFamilyOf`): `graph` (a graph material), `decal`,
`liquid` (water shader or liquid use), `projected` (construction or terrain use; the same record on a mesh draws
`standard`), `standard` (standard, foliage, atlas, trim, unlit); `effect` is the effect records'. No new shader
types.

**The kit binding.** The piece table's material → kit pairs (§3.9 of the kit page) are built from the records:
`boundVoxelKits(kits, materials)` gives each kit, as `materials`, the ids whose (resolved) material names it, then
the ids of its own format-1 list that **no material record names**; a liquid binds none. The kit check adds an info
row (`binding`, "Set the binding on the material") while a kit has a list. The editor's views compute it from
`queryGameConfig`; a build (Play and export) ships each kit with its bound ids, so the runtime reads one list.

**What a build ships.** The materials the game uses, resolved (instances folded in), each `physical` block
resolved against the project's profiles (every number filled in, the profile id kept, the profile's game data
under the material's own keys), so the runtime never reads a profile. **Every voxel material is used** when the
game holds a voxel world (`material-use.ts`): a world's cells name materials by voxel id, any id may be in its
files or painted at run time, so a build ships them all instead of reading every region file (46d.3b; default
chosen, owner to confirm). No format changes: the manifest's `materials` list carries them as any material.

**What the world draws (46d.3b).** The voxel surface's material table (a texel a voxel id: colour and pattern,
tiles and crack layer, relief layer and depth; three-adapter `voxel-surface.ts`) is built from the records
(`voxel-material-looks.ts`): `params.color` → colour, `voxel.tileMetres` → the construction and the terrain tile
both (drawn at the nearest tile dividing the 512 m texture phase), `voxel.heightDepth` → the relief depth over the
height layer the page names; what a record leaves out, and every id no record names, keeps the per-id stand-in
(`voxelStandInLook`), the test pattern included until texture sets are drawn (46d.4a). A record change rewrites and
uploads the table only (the feeds rule: looks are shader data; no derive, mesh or grid upload), in Play, an export,
the Scene view and the voxel world page alike. Since 46d.4a the test pattern is gone from the default program: a
record's surface texture sets draw from arrays (§2), the colour tinting them; an id without a set draws its flat
colour.

**What the game reads (46d.3b).** `ctx.voxels.materialOf(id)` / `materialAt(x, y, z)` answer `{id, materialId,
name, use, kit, physical, gameData}` from the build's shipped records (`voxelMaterialInfos`; frozen), handed to the
runtime with the world ports. Chunk colliders keep the engine's one friction: Rapier's triangle-mesh colliders have
no friction per triangle, so per-material friction is game logic over these reads.

**Measured** (vitest, Node): a record with every part 414 bytes compact (79 without them); a project with all
4,095 voxel ids given a material loads (validate + canonical) in 63 ms, one material edit on the trusted block
5.5 ms, the list 1.65 MB compact.

## 2. Texture sets

**Owner note (46d.4a, 2026-11-08):** an add-only step inside project schema 8 and runtime manifest v5, not a new
format: one optional catalog block (`voxelTextures`) and a fourth block of rows in the surface's material table (a
runtime texture, not a file). A build or project without voxel texture sets reads and writes byte for byte as
before. Nothing in the approved format spec, the role spec, the texture layout or kit format 1 changes. Default
chosen, owner to confirm (plan 46d §9).

**The arrays.** Per map type one texture array: `albedo` (sRGB, its A unused), `normal` (tangent-space,
OpenGL green up, **the height 0–1 in A**, texture layout v1), `orm` (occlusion, roughness, metalness). A layer is one distinct texture set of
the voxel materials' `voxel.surfaces` (`project-model` `voxel-surface-textures.ts`, `voxelSurfaceTextures`):
layers numbered in ascending voxel id, wall then floor then ceiling; equal sets share a layer (a floor falling back
to its wall, two materials on the same textures). A set without an albedo has no layer (its surfaces draw the
material's flat colour); a set leaving out a normal or ORM map takes that map's neutral constant layer (a flat
normal; AO 1, roughness 0.8, no metal); a map no set names has no array (the surface reads its neutral value).
Every array has at least two layers (a single-layer KTX2 is not an array). At most `MAX_TEXTURE_LAYERS` (256, the
GPU's array limit) layers; a set past it has no layer (`dropped`). All layers of an array are one size (the
assembly's rule): the authored size, 4096² for a 4 m construction tile (1024 px/m), so a 2 m terrain tile carries
2048 px/m in the same array.

**Assembly.** The arrays are slot lists like a layered material's (`texture-slots.ts`): Play and the export
assemble each through the backend's slot assembly into one KTX2 array (cached by the layers' digests) and ship it
under `slots-<digest>`; the editor's views and the voxel world page ask the same route
(`POST …/content/textures/slots`) and draw the very same bytes.

**The build's block** `voxelTextures?: {albedo?, normal?, orm?}` names each map's shipped array (texture
ids); the ids are in the catalog's project-wide `dependencies`. Absent when no voxel material has a set with an
albedo. The runtime makes each id's layers from the shipped material records with the same function, so the block
carries no table.

**The table.** The surface's material table (`voxel-surface.ts`) gains a fourth block of 64 × 64 texels: per
material id its wall, floor and ceiling layer (r, g, b; −1 none). The arrays and the layers are set together
(`VoxelSurface.setTextures`): the table is rewritten and uploaded, no program, grid or mesh changes.

**Drawing.** Construction (a cell of a construction role) picks the floor layer on a face whose normal points up
(y > 0.95), the ceiling layer on one pointing down, the wall layer on every other (roof planes included), mapped on
the build grid (U along the face, V up it, the tile's foot on the grid's 0 m line; `tileMetres`, default 4 m);
terrain draws its one set (the wall's) triplanar at its tile (default 2 m). Each map is read on the same
projection; the normal map is turned by that projection's frame (the grid's U and V, or each axis's) and blended
between the two heaviest materials like the colour. The albedo is multiplied by the material's colour (`color`:
a tint, white for the set as authored). The image's first row is its top. Roughness is the ORM's G (wetness lowers
it), metalness its B, occlusion its R. The test patterns leave the default program (`?patterns=1` on the voxel
world page draws them).

**Residency (46d.4b; default chosen, owner to confirm).** No format change: the arrays keep every level. A quality
level field `voxelTexelDensity` (texels a metre on a construction tile, one of 64 … 4096 in powers of two; absent:
the lighting tier's, `VOXEL_TEXEL_DENSITY_BY_TIER` low 256, medium 512, high 1024) caps each array at the largest
level at or below it (`voxelArrayTopLevel`: an array of edge E keeps level ⌈log2(E / (4 m × density))⌉, 0 when
authored smaller; sets are authored at `VOXEL_AUTHORED_TEXEL_DENSITY` 1024 px/m, so 4096² keeps level 2 / 1 / 0).
Under the cap the page's texture streamer keeps what its budget (`texture_budget_mb`) holds, measuring the need
from the chunks drawn with the surface material (world-mapped textures: texels a metre = edge / the finest tile a
textured material draws at); the levels at or below 128² (`TEXTURE_STREAM_TAIL_PX`) are the always-resident tail. A
build cuts each voxel array into its mip parts (the head with the tail, then one part a level, every layer in
it) and ships the parts in place of the file; the editor's views stream the same parts from the whole file they
fetch. A level change at run time moves the caps: levels above a lowered cap go in the same plan; a raised cap
streams the finer levels in one at a time while the old chain draws.

**Authored size (46d.4c, D532; default chosen, owner to confirm).** No format change. One encode of the pinned
KTX2 encoder takes 12 Mpix (`KTX2_SOURCE_PIXELS_MAX`); a larger image, up to `KTX2_IMAGE_PIXELS_MAX` (32 Mpix,
two 4096² tiles), is encoded in UASTC in stripes of the image's whole width and assembled (`ktx2-striped.ts`):
the top level's blocks are the stripes' blocks one after another (block for block what one encode would make:
UASTC blocks are encoded each on its own), the levels below are the image halved (colour in linear light, normals
renormalized, data as stored) until one encode takes the rest with its own mips; the container is that encode's.
Every mode, a colour image too, goes UASTC there (ETC1S's codebook spans the image). Measured on the 4096²
placeholder sets (one thread, the assembled effort): 14–49 s a map, 2.2–16.7 MB a KTX2, 13 levels, mean error
against the source 0.01–1.39 / 255 at level 0, decoded by three's transcoder. Imports, model texture extraction
and the slot route take it; an array of 4096² layers joins at most 16 of them (`KTX2_JOIN_LEVEL_BYTES_MAX`).

### Kit sheets and crack maps (46d.4c)

**Owner note (46d.4c, 2026-11-08):** no format change: kit format 1, the texture layout v1 and the manifest are
read as they are. Default chosen, owner to confirm (plan 46d §9).

- **A kit's one texture set is its pieces' GLB material** (owner B5): base colour, normal map, and occlusion /
  roughness / metal (glTF: R, G, B of one ORM image) with their factors, as the authoring export writes them. A
  model import extracts the images into KTX2 texture assets (the model's `textures`: image index → asset), which a
  build ships with the model; every host (Play, an export, the Scene view, the voxel world page) hands the GLB
  loader those textures, so a kit sheet streams and counts in the texture budget like any model texture. A kit
  names no material record: the voxel material's arrays dress its faces, the kit's sheet its pieces.
- **Mapping.** A kit with a trim layout (named or its own `sheetLayout`) reads every map at the world-anchored U
  of its run faces, the normal map's tangent frame from that U's screen derivatives; a kit without one keeps its
  authored UVs. Pieces draw lit (three's standard node material), camera-relative.
- **No image** (a placeholder material): a stand-in colour a kit. The labelled UV debug textures (a layout's debug
  set, or the cell checker) draw only on a page that asks (`?trimDebug=1`).
- **Crack maps.** A kit's `damage.crackTexture` (an image, one 4 × 4 m construction tile) is read into the crack
  array's layer (512²) by the brightest texel of each, so a map authored at the base tile's 1024 px/m (4096²) keeps
  its one-pixel cracks; laid on walls and roof planes as before.

### Height, height depth and wetness (46d.4d)

**Owner note (46d.4d, 2026-11-08):** D531 resolved toward the approved texture layout v1 and R111: **a voxel
texture set's height lives in its normal map's A**, nowhere else. Two changes to this page's unapproved 46d steps,
not to any approved spec: the material record's map `albedoHeight` is renamed **`albedo`** (its A is unused) and the
catalog block's key with it (nothing of this branch is merged or shipped; a record or build naming `albedoHeight` is
refused as an unknown field), and no voxel array derives a brightness height any more (the layered surface's albedo
convention stays the layered surface's). Default chosen, owner to confirm (plan 46d §9).

- **Height.** The normal array's A, 0–1 (1 the surface, 0 the material's `heightDepth` below it), read on the same
  layer and projection as the colour. A normal map without alpha (opaque), the neutral flat normal layer and a
  material without a set read height 1: no relief, no crevice.
- **Height depth** (`voxel.heightDepth`, metres; absent `VOXEL_MATERIAL_LIMITS.heightDepthDefault`, 0.02) is in the
  surface's material table (third block, g) for every material; the r channel is the debug program's test height
  layer (−1 none).
- **Height blend, in metres** (three-adapter `voxel-surface-wetness.ts`, `heightBlend`): of the two heaviest
  materials (A, B with B's cell share s), each surface's level (h − 1) × depth is raised by its share times
  (the deeper depth + `HEIGHT_BLEND_CONTRAST_METRES` 0.01 m); the higher wins over that contrast. A whole share shows
  its material alone; two materials without depth blend by share. Colour, normal, ORM, the recess (relief) and the
  water all use that blended share, in the pixel and in the vertex stage (relief, explicit level).
- **Wetness R111** (`wetLook`; the voxel wetness bits, 0 … 7 → 0 … 1): albedo × (1 − 0.5 w) × (1 − 0.2 water);
  roughness × (1 − 0.6 w), then toward 0.03 by the water; the normal toward the surface's own by 0.4 w + water;
  the water line at w² × 0.6 of the blended height's 0–1, a pixel below it under water over a 0.04 shore. So levels
  1–2 only darken and shine, the crevices fill from level 3, level 7 stands as water in the lowest 60 % of the
  height range. Shader data only: no remesh, no format change (the bits exist since format v1).
- **Not covered:** kit pieces draw dry (their material does not read the cells' wetness; D538). Relief on the
  debug program (`?patterns=1`) keeps the engine's test heights (`voxel-relief.ts`) and its lighting normal from
  their screen derivatives; the texture sets' lighting normal is the normal map's.

## 3. Relief part

**Owner note (46d.5a, 2026-11-08):** derived data steps **28 → 29** (nothing stored, nothing to upgrade, no world
regenerated; a worker of another version is refused as ever) and an add-only step inside project schema 8 (one
optional distance on `voxelWorld.levels`, one optional quality level field). The relief part was the 46d.1 spike's
switch; it is now a derived output a section carries when the relief ring holds it. Outside the canonical bytes:
every other output and every hash are v28's, byte for byte. Nothing in the approved format spec, the role spec,
the texture layout or kit format 1 changes. Default chosen, owner to confirm (plan 46d §9: the 46d.1b verdict and
the 46d.5a defaults).

**The part** (`DerivedData.relief`, `@thirdlight/voxel` `relief-mesh.ts`): a level-0 section's ground and base
surfaces again, in the surface layout (12-byte vertex, u16/u32 indices), each triangle split until no edge spans
more than 1.5 / n cells on any axis (n = 2, 4 or 8 lattice steps a cell: 25, 12.5, 6.25 cm; a base face an n × n
lattice, roofs along their merged rows), plus a **crease weight** byte a vertex (0 fixed, 255 free; the vertex
stage scales its displacement by it): 0 where the surface turns, at kit edge cells, wall–roof seams and roofs'
one-cell stripe at section faces, and on every edge shared with a section drawn plain, which is kept whole
(no T-junction). An edge splits by its two end positions alone, so two relief sections split a shared edge bit for
bit alike. A job asks it per section (`DeriveInput.relief = {n, ids, plain}`: the sections of the chunk that are
relief and, per section, its plain neighbours among the 26 round it); a section not named derives none. Collision,
occupancy, navigation and light never read it. A shader-only derive (material or wetness) keeps it as it is:
heights and depths are shader data (the feeds rule).

**The ring** (`relief-ring.ts`, `stream-relief.ts`): the streamer plans which sections are relief round its focus,
per derive section (16³ = 8 m), not per chunk. A ring displacing to R (cells) holds a section whose centre lies
within R + its half diagonal (6.9 m), and keeps it to R + its half diagonal + 4 m (`RELIEF_HYSTERESIS_CELLS`), 3D
distances as the vertex fade's; the fade ends at R and starts 4 m inside (`reliefFade`). So a section changes
state only where nothing of it is displaced, and every displaced point is in a relief section. A plan (the focus
moved a cell, or new settings) derives again, in **one group** (one atomic swap, as an edit's), every section that
changed and every relief section round one; the swap's `chunk` events say `reliefOnly` when only relief meshes
changed (the canonical bytes are equal), so bodies stand. New lattice steps mesh every relief section again.

**Settings.** `voxelWorld.levels.relief` (metres, 0: none; default 16 m = `DEFAULT_RELIEF_RADIUS_CELLS`, scaled per
quality level like every distance, never past `level0`); a quality level's `voxelRelief` (lattice steps a cell,
`RELIEF_STEPS` 0 | 2 | 4 | 8; absent its tier's `RELIEF_STEPS_BY_TIER`: low 0, medium 2, high 4). A world resolved
without a quality level has steps 0. The relief distance scales by its tier's own `RELIEF_RING_SCALES` (low 0.71,
medium 1, high 1.5: 16 m and 24 m by default), or by the level's `voxelRings` when it sets one.

**Drawn** (46d.5b, no format change). The streamer tells the draws its ring (a `relief` stream event; the chunk
batch's `relief`: steps, where it displaces now and the ring's centre, cells; again when the centre moves
`RELIEF_FOCUS_STEP_CELLS`, 1/8 m), and the vertex stage fades the displacement from that centre by `reliefFade` of
that radius. Play, exports and the Scene view draw through `VoxelWorldDraws`; the Scene view derives the ring at
its quality level round the point it orbits. `ctx.voxels.setRings({levels: {relief}})` changes the
distance at run time; `rings()` reports it and `reliefSteps`.

**Shadows (46d.6d, D545; no format change).** A relief chunk sends its plain surfaces with its relief meshes
(`ChunkDrawWire.caster`); with shadows on they are a shadow-only mesh (`VOXEL_CASTER_KEY`, on the off-view layer the
shadow cameras see), the relief meshes cast none and read the shadow map at their plain, undisplaced place
(`receivedShadowPositionNode`). So relief casts exactly the shadow the plain world casts; its own micro-shadows are
lost. One draw path on both renderers. Play, exports and the Scene view cast no voxel shadows yet (46d.5b default).

**Budget (D528).** Relief has its own share of the stream budget, `RELIEF_BUDGET_SHARE` (1/8: low 32, medium 64,
high 128 MiB) while the ring is on: the base world's eviction counts the budget less that share and the base bytes
without relief, so relief never evicts a chunk of the world. Relief bytes are the budget parts named `relief…`
(`RELIEF_PART`): each section's relief part, and each chunk draw's relief share (`RELIEF_DRAW_PART`, the GPU's
copy of the relief meshes it sent). Over its share the ring **shrinks**: its farthest sections drop until the
rest hold 90 % of the share, sections join only nearer than the nearest dropped one, and the displacement ends a
half diagonal inside that; once the focus has moved a section edge (8 m) it tries its full radius again.


## 4. Far-field data

**Owner note (46d.7a, 2026-11-08):** derived data steps **30 → 31** (nothing stored, nothing to upgrade, no world
regenerated; a worker of another version is refused as ever): the chunk tree's downsample closes narrow openings and
keeps wider ones as openings. Level-0 results are v30's byte for byte. A new derived store, the **far cache**
(format 1), is never committed and is built again whenever its format or its world's revision differs. Nothing in
the approved format spec, the role spec, the texture layout or kit format 1 changes. Default chosen, owner to
confirm (plan 46d §9, the 46d.7a defaults). The draw modes that read it (voxel-mip meshes, ray-marched bricks) are
46d.7b and 46d.7c.

**Openings at the coarser levels** (`voxel-mips.ts`, every level ≥ 1, near rings and far tree alike). Before a
parent is downsampled from its 8 children, an opening narrower than `MIP_OPENING_KEEP_CELLS` (2) parent cells is
closed in the body round it: its width is the middle of the three run lengths of opening cells through a cell
(the shortest is the wall's thickness), in child cells, clipped at the parent's sides; it closes only when a body
cell ends that run on a side, takes that body's role and its own material, and is whole. A parent left with no
solid or liquid share but holding an opening cell is an opening (drawn as open space, like air), so a wider opening
keeps its width up the levels until it too is that narrow. So a 0.5 m door or window is wall at level 1 (no
"legs" under a far front wall), a 3 m gate stays open at level 1 and closes at level 2.

**The far tree** (`@thirdlight/voxel` `far-tree.ts`). The chunk tree over the whole world: a level-L node covers
2^L chunks a side (16 m · 2^L) and holds the voxel mip of that block, a chunk-shaped block of 0.5 m · 2^L cells.
The tree keeps levels `FAR_MIN_LEVEL` (2: 2 m cells, 64 m nodes) up to its top level, the lowest at which at most
two nodes span the world's widest side (`farTopLevel`; 8 for 8 km, nodes 4 km). A node whose 8 children are one
whole solid value (not roof, not opening) is that value without a downsample, which is what the downsample gives.

**The far cache** (`@thirdlight/workspace` `voxel-far-cache.ts`), per world in the project's
`cache/voxel-far/<world>/` (`FAR_CACHE_SEGMENTS`; the project's `.gitignore` keeps `cache/` out of git):
- `far.json`: `format` (1), `worldId`, `edge`, `footprint`, `minLevel`, `maxLevel`, `revision` (the world's when
  built), and per level its sorted region file names, nodes and bytes.
- `L<level>/`: the level's nodes in region files of the world's format (stacked, the world's footprint and id, zstd
  per node, uniform nodes as 12-byte entries), node (nx, ny, nz) of level L stored as "chunk" (nx, ny, nz). Read,
  checked and decoded by the code that reads the world.
- Deterministic: the same world gives the same bytes whatever order or process builds it. A full build works one
  region column at a time (levels `minLevel` … the level at which a node spans one region, 4 at 256 m), in workers,
  then the levels above from those nodes, into a fresh folder moved into place last.
- An edit's changed chunks make exactly their ancestors at the kept levels stale (`farAncestors`); a rebuild
  (`rebuildFarCache`) builds those, reading their untouched children from the cache, rewrites only the level files
  holding them, then `far.json`; the result equals a full build byte for byte.
- An export ships `farCacheFiles` (the manifest and the files it lists) beside the world's region files, from the
  draw modes' item on (46d.7b: nothing in a game reads it before).

**Selection** (`FarSelection`). Every top-level node holding anything is drawn, or opened into its children while
its on-screen error (2^L cells × pixels a radian / its distance from the eye, at least its own size) is over
`FAR_ERROR_PIXELS` (2 px); an open node closes again only under (1 − `FAR_HYSTERESIS`) of it (0.25). Opening that
would pass the byte budget (`FAR_BUDGET_BYTES`, 48 MiB of stored node bytes) keeps a node closed, largest error
opened first. Nodes wholly inside the box the near rings load are not drawn; nodes reaching into it open down to
the lowest kept level and are marked (`nearOverlap`) for the draw modes to meet the near field. The top level
covers the world, so nothing is cut off at any distance.

**Owner note (46d.7b, 2026-11-09):** the far field drawn as voxel-mip meshes. No stored or derived format changes
(derived 31, far cache format 1 as above); added: the far cache's serving routes, the export catalog's optional
`far` rows of a voxel world (add-only: a catalog without them draws nothing past the near rings), the far mesh job
and its wire, and two quality-level fields. Default chosen, owner to confirm (plan 46d §9, the 46d.7b defaults);
the ray-marched bricks (46d.7c) join as a second mode behind the same switch, and which is the default is the
owner's pick.

**Served and shipped.** The backend serves a world's far cache beside it: `GET …/voxels/<world>/far` (the
manifest and its files `L<level>/<name>` with their tags; `far_cache_building` while it is built) and
`GET …/voxels/<world>/far/L<level>/<file>` by byte range, the same under a play's locator. A missing or stale cache
(another revision, world or format) is built in the backend, in the world's command queue, a region column at a
time with the event loop given back between columns. Every applied voxel command rebuilds the cache's ancestors of
the chunks it changed (`rebuildFarCache`) before it answers (`far: { nodes, ms }`, or `{ stale }` when the cache was
not current and is built again whole on its next read). An export ships the cache's files as content files beside
the world's region files; the catalog row's `far` is `{ minLevel, maxLevel, files: [{ name: 'L<level>/<file>',
digest, byteLength }] }`, files in name order.

**Selection.** As above, from the stream focus, with no near box: the far field draws under the near field
everywhere (see the near cover), so a chunk the near field has not drawn yet still shows its far stand-in. The
on-screen error is the quality level's `voxelFarError` (pixels at 720 rows and 60°; tiers low 8, medium 4, high 3,
`FAR_ERROR_PIXELS_BY_TIER`), the mode its `voxelFarField` (`mesh` | `bricks` | `off`, `FAR_FIELD_BY_TIER`: `mesh` on every tier).

**Far mesh job** (`far-mesh`, `@thirdlight/voxel` `far-mesh.ts`): a node's cells and its 26 same-level neighbours
as the cache stores them (27 entries, index `(dx + 1)·9 + (dz + 1)·3 + (dy + 1)`, null for air), meshed by the
world rules' mesher at the node's level (an apron from the neighbours, so same-level neighbours meet exactly), ground
and base surfaces in one buffer. A vertex is 12 bytes (`FAR_VERTEX_BYTES`): position `uint16x3` in 1/1024 cells
from 16 cells below the node's corner (`FAR_POSITION_ORIGIN_CELLS`), `uint16` look word (material bits 0–11,
wetness 12–14: the first solid cell behind the vertex along its inward normal, then below it, then round it),
normal `snorm8x3`, one byte 0. Every edge where the surface leaves the node's box hangs a skirt of
`FAR_SKIRT_CELLS` (2) of the node's cells along the inward normal, both windings, its triangles last
(`skirtTriangles`).

**Draw batches.** A batch (`ChunkDrawBatch`) may carry `far` (`added`: nodes with their meshes, drawn or drawn
again; `removed`: nodes) and `nearCover` (`min`, `size` in storage chunks and one byte a chunk, index
`x + size₀·(y + size₁·z)`: 1 where the near field's drawn levels cover the chunk and every chunk round it). A node
replacing others goes in with their removal in one batch once every new node of its group is meshed.

**Drawn** (three-adapter `voxel-far-mesh.ts`): one draw per level and 8 × 8 node columns (`FAR_GROUP_NODES`);
colour from the material table and the wall set's mean albedo (the array's coarsest level), darkened by wetness;
lit, no shadows. Depth: the camera's perspective depth of the distance × 1.05 up to half the far plane, past it
the logarithm of the distance up to 64 km in what remains of the depth range, so far nodes are never clipped at the
far plane and lose to the near field where both cover a pixel; a far fragment in a covered chunk is discarded.

**Owner note (46d.7c, 2026-11-09):** the far field drawn as ray-marched distance bricks, the second mode behind the
same switch (`voxelFarField` gains `bricks`, add-only; a level without the field still draws meshes). No stored or
derived format changes (derived 31, far cache format 1); added: the far bricks job and its wire. The brick format's
constants (`DISTANCE_BRICK_*`, the tracer's hit and shortest step) moved into `@thirdlight/voxel`
(`distance-brick-format.ts`) with project-model and the tracer re-exporting them unchanged. Default chosen, owner
to confirm (plan 46d §9, the 46d.7c defaults); which mode is the default stays the owner's pick (46d.7d).

**Far bricks job** (`far-bricks`, `@thirdlight/voxel` `far-bricks.ts`): the same 27 entries as the far mesh job.
The node's 32³ cells are 4³ bricks of 8³ cells (`DISTANCE_BRICK_CELLS`). A cell is solid where its fill level is at
least half (liquid and air are not); a cell centre's value is its Euclidean distance (cells) to the nearest cell of
the other kind less ½, negative inside, except a cell with a face neighbour of the other kind, which takes
½ − its fill (so a partial terrain cell moves the surface inside it); a corner sample is the mean of its 8 cells,
quantized to a byte over ± `DISTANCE_BRICK_BAND_VOXELS` (2) cells (`sampleOfDistance`: 0 is −2, 255 is +2). Read
from a 3-cell apron of the neighbours, so same-level neighbours share their face's samples exactly. A brick whose
samples are all > 0 is `DISTANCE_BRICK_OUTSIDE`, all ≤ 0 `DISTANCE_BRICK_INSIDE`, else stored. Output
(`FarBricks`): `side` (4), `bricks` (`Int32Array` 64, x fastest then y then z: block index or a code), `samples`
(729 bytes a block, x fastest), `looks` (`Uint16Array`, a word a sample: the topmost solid of its 8 cells, else the
nearest solid within 2 cells, else the block's last), `blocks` (4 bytes a block: brick x, y, z in the node and the
node box faces it lies on, bits −x +x −y +y −z +z). Draw batches carry a node's `bricks` instead of its `mesh`.

**Drawn as bricks** (three-adapter `voxel-far-bricks.ts`): every stored brick's samples and looks are a 9³ region
of a shared r8 (filtered) and rg8 (texel) 3D texture, uploaded per brick, given back when its node goes, the atlas
grown by a GPU copy (the voxel surface's region store). One instanced box draw per group (as the meshes' groups),
an instance a brick (corner, faces, region, cell size), one material for all. Each box's back faces are drawn and
the fragment marches the camera ray from where it enters the box: field = the trilinear sample at the point
clamped into the brick plus `FAR_BRICK_SKIRT_SLOPE` (4) × the distance outside it; the box grows by
`FAR_BRICK_LIP_CELLS` (0.5) on the node faces it lies on, so a brick there hangs a steep skirt past its node; hit
under `BRICK_HIT_VOXELS` (0.05 cells), step the field (÷ 5 in the skirt), at least `BRICK_MIN_STEP_VOXELS` (0.25),
at most `FAR_BRICK_STEPS` (32) a brick; a miss is discarded. Normal: the samples' gradient inside the brick, or the
entered face where the samples are clamped (deep under the surface); colour: the material table's far colour of the
nearest sample's look, as the meshes; depth: the hit's own (`depthNode`), the same mapping as the meshes, and the
boxes placed with that depth so none is clipped at the far plane. `marchFarBrick` is the march on the CPU.
