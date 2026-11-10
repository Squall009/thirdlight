# Voxel rendering and materials — format page (46d additions)

Status: **complete for 46d** (checked against the code in 46d.8a): §1 material record (46d.3a, 46d.3b), §2 texture
sets (46d.4a–46d.4d), §3 relief part (46d.5a, drawn 46d.5b, shadows 46d.6d), §4 far tree, far cache and both far
draw modes (46d.7a–46d.7c), §5 requirement traceability (46d.8b). This page holds every format addition of 46d (rendering and materials), each as a
versioned, add-only step with its owner note, so the [format spec](voxel-format-spec.md) v1 (APPROVED by the owner
on 2026-11-02) is not grown further; the derived steps 28 → 31 are also rows of its §3.7 history and its §3.8 table.
**Nothing here is approved yet:** every step is "default chosen, owner to confirm" ([plan 46d](../plan-phase-46d.md)
§9), and which far draw mode is the default is the owner's pick (§4). Steps:

| Step | Item | What | Stored formats |
|---|---|---|---|
| material record parts | 46d.3a | `physical`, `gameData`, `voxel` on a material; `content.materialProfiles` | schema 8, add-only |
| texture sets | 46d.4a, 46d.4d, 46d.10 | catalog `voxelTextures`, the table's fourth block; height in the albedo's A (46d.10, the normal's A in 46d.4d) | manifest v5, add-only |
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
- `voxel?` `{id, use, kit?, tileMetres?, heightDepth?, blendMetres?, surfaces?}`, in that order (`blendMetres?`
  added by 46d.11, owner note below):
  - `id` 1–4,095 (the voxel value's 12 material bits; 0 is air), **unique in the project** (`voxel_id_taken`);
    every world of the project shares the ids.
  - `use` `construction` | `terrain` | `liquid` (required on a material; an instance may leave it to its chain).
  - `kit` a voxel kit id the project has (`kit_missing`; deleting that kit is refused the same way); never with
    `liquid`.
  - `tileMetres` 0.5–64 m a texture repeat (absent: `CONSTRUCTION_TILE_METRES` 4 for construction,
    `TERRAIN_TILE_METRES` 2 for terrain and liquid, the derive's own constants).
  - `heightDepth` 0–0.25 m between the height map's 1 (the surface) and 0 (absent: 0.02 m). Relief only recesses,
    and half a 0.5 m cell keeps both sides of a one-cell wall apart.
  - `blendMetres` 0–0.5 m (`VOXEL_MATERIAL_LIMITS.blendMetresMax`, one cell; 0 a hard cell line) over which it
    blends into a neighbouring material (absent: its world's, below). Inherited along an instance chain as the
    other fields.
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

**Owner note (46d.11, 2026-11-09): material blend distance.** The owner asked for the blend distance per material
with a world default, the smaller winning where two meet. An add-only step inside project schema 8, not a new
format: two optional fields, nothing else changes, an older project loads unchanged and draws as before (the
default is the 0.25 m the hosts drew with). `MaterialDef.voxel.blendMetres?` (above) and the `voxelWorld`
component's `blendMetres?` (0–0.5 m; absent: `VOXEL_MATERIAL_LIMITS.blendMetresDefault` 0.25 m, half a cell), both
canonical field by field (the world's after `decalLayers`). Drawn: the material table's third block carries each
material's own value in b (−1: none); the world's is the surface's uniform. Of the eight cells round a pixel the
narrowest blend any solid cell asks for (its material's own, else the world's) is the blend there
(three-adapter `voxel-surface-blend.ts`, `seamBlendMetres`), so both sides of a seam blend alike; air asks for
nothing. Shader data only (the feeds rule): a record edit uploads the table, a world's object edit sets the
uniform; no derive, mesh, grid upload or new program. Play, exports and the Scene view read the world's value from
the scene's `voxelWorld` object (the same link as its decal layers); the voxel world page has no object and takes
`?blend=` (default the engine's), its records' own values as the hosts. Cost: eight more table texels a pixel (13
in all; a 4,096-texel float table, cache-resident).

## 2. Texture sets

**Owner note (46d.4a, 2026-11-08):** an add-only step inside project schema 8 and runtime manifest v5, not a new
format: one optional catalog block (`voxelTextures`) and a fourth block of rows in the surface's material table (a
runtime texture, not a file). A build or project without voxel texture sets reads and writes byte for byte as
before. Nothing in the approved format spec, the role spec, the texture layout or kit format 1 changes. Default
chosen, owner to confirm (plan 46d §9).

**The arrays.** Per map type one texture array: `albedo` (sRGB, **the height 0–1 in A**, linear; texture layout v1
as amended 2026-11-09), `normal` (tangent-space, OpenGL green up, its A unused), `orm` (occlusion, roughness,
metalness). A layer is one distinct texture set of
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

### Height, height depth and wetness (46d.4d, 46d.10)

**Owner note (46d.10, 2026-11-09):** the owner moved the height to **the albedo's A** (the engine's layered
surfaces and the owner's convention); the normal map keeps no height. Texture layout v1 is amended add-only
([voxel-trim-layout.md](voxel-trim-layout.md) §9: the v1 row's "normal + height" was a drafting slip). The record's
map keeps the name **`albedo`** (no rename back to `albedoHeight`: records and builds made since 46d.4d stay valid,
and the map is still the albedo; its A is documented as the height, as a layered surface's albedo is), so nothing
stored changes. The albedo array is a height array (`TextureSlotSet.height`, the layered surface's rule): a layer
whose albedo has no height in A (opaque or one value) gets one from its brightness at assembly, so it never blends
by a constant. This replaces the 46d.4d note below where they differ. Default chosen, owner to confirm (plan 46d §9).

**Owner note (46d.4d, 2026-11-08; superseded on the height's home by the 46d.10 note above):** D531 resolved toward the approved texture layout v1 and R111: **a voxel
texture set's height lives in its normal map's A**, nowhere else. Two changes to this page's unapproved 46d steps,
not to any approved spec: the material record's map `albedoHeight` is renamed **`albedo`** (its A is unused) and the
catalog block's key with it (nothing of this branch is merged or shipped; a record or build naming `albedoHeight` is
refused as an unknown field), and no voxel array derives a brightness height any more (the layered surface's albedo
convention stays the layered surface's). Default chosen, owner to confirm (plan 46d §9).

- **Height.** The albedo array's A, 0–1 (1 the surface, 0 the material's `heightDepth` below it), read on the same
  layer and projection as the colour, in the pixel (blend, water, lighting) and at an explicit level in the vertex
  stage (relief). An albedo without a height in A reads its brightness height (above); a material without a set
  reads height 1: no relief, no crevice. The normal array's A is never read.
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

**Owner note (46d.11, 2026-11-09): relief displacement off on every tier.** The owner turned the close-ring relief
displacement off for now (fewer triangles, a lighter mesher) until the brick far field works; then it is
reconsidered (or bevelled near edges). No format change: `RELIEF_STEPS_BY_TIER` is 0 on low, medium and high, so no
relief part is derived, streamed, budgeted or drawn and no shadow caster is made; the relief part, the ring, the
quality field `voxelRelief` (a level that sets 2, 4 or 8 still gets it) and the voxel world page's `?relief=n`
switch stay. The heights still light every surface (the normal and the height blend from the albedo's A).

**Settings.** `voxelWorld.levels.relief` (metres, 0: none; default 16 m = `DEFAULT_RELIEF_RADIUS_CELLS`, scaled per
quality level like every distance, never past `level0`); a quality level's `voxelRelief` (lattice steps a cell,
`RELIEF_STEPS` 0 | 2 | 4 | 8; absent its tier's `RELIEF_STEPS_BY_TIER`: 0 on every tier since 46d.11, owner note
below; until then low 0, medium 2, high 4). A world resolved
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
`FAR_ERROR_PIXELS_BY_TIER`), the mode its `voxelFarField` (`bricks` | `mesh` | `off`, `FAR_FIELD_BY_TIER`: `bricks` on every tier since 46d.13c-1; `mesh` is the fallback).

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
`x + size₀·(y + size₁·z)`: 2 (`NEAR_COVER_HIDDEN`) where the near field's drawn levels cover the chunk and every
chunk round it, 1 (`NEAR_COVER_EDGE`) in the drawn chunks of its edge ring, else 0; the edge ring is new in
46d.13c-2). A node
replacing others goes in with their removal in one batch once every new node of its group is meshed.

**Drawn** (three-adapter `voxel-far-mesh.ts`): one draw per level and 8 × 8 node columns (`FAR_GROUP_NODES`);
colour from the material table and the wall set's mean albedo (the array's coarsest level), darkened by wetness;
lit, no shadows. Depth: the camera's perspective depth of the distance × 1.05 up to half the far plane, past it
the logarithm of the distance up to 64 km in what remains of the depth range, so far nodes are never clipped at the
far plane and lose to the near field where both cover a pixel; a far fragment in a covered chunk is discarded, and
one in the near field's edge ring takes at least the distance of the near cover's farthest corner from the camera
(meshes a vertex at a time, bricks a fragment at a time), so it shows only through a gap in the near field and
never in front of near ground, though a coarser far surface may lie above it (D577).

**Owner note (46d.7c, 2026-11-09):** the far field drawn as ray-marched distance bricks, the second mode behind the
same switch (`voxelFarField` gains `bricks`, add-only; a level without the field still draws meshes). No stored or
derived format changes (derived 31, far cache format 1); added: the far bricks job and its wire. The brick format's
constants (`DISTANCE_BRICK_*`, the tracer's hit and shortest step) moved into `@thirdlight/voxel`
(`distance-brick-format.ts`) with project-model and the tracer re-exporting them unchanged. Default chosen, owner
to confirm (plan 46d §9, the 46d.7c defaults); which mode is the default stays the owner's pick (46d.7d).

**Owner note (46d.13c-1, 2026-11-10):** the ray-marched bricks are the far field on every tier and in every host
(Play, exports, the Scene view, the voxel world page); the meshes stay as the fallback behind the same switch. One
build, one shading and one march are kept (below); the first build (occupancy distances from the node's own cells),
the flat and per-pixel fine shadings, the box-a-brick march and the rasterized bricks are retired (their last tree
is a0de93e3). No stored or derived format changes (derived 31, far cache format 1); the far bricks job's wire gains
nothing new since 46d.12/13b (`build`, `fine`). Default chosen, owner to confirm (plan 46d §9).

**Far bricks job** (`far-bricks`, `@thirdlight/voxel` `far-bricks-faces.ts` `brickFarNodeBy`, format in
`far-bricks.ts`): the same 27 entries as the far mesh job, and with the build `FAR_BRICK_BUILD` (`scale` 2,
`occlusion`) the node's children and one of theirs round them (`fine`: (2 + 2)³ entries of the level below, y
fastest; none below the far tree's lowest kept level, where the node's own cells are read at scale 1). The node's
32³ cells are 4³ bricks of 8³ cells (`DISTANCE_BRICK_CELLS`). Each corner sample is the exact signed distance (node
cells) to the solid read `scale` times finer, a part-full cell solid up to its fill as a height (from the side of its
fuller vertical neighbour, below on a tie; liquid and air are not solid): the distance along y to each vertical
corner line's solid or air spans, then the separable transform's x and z passes (exact: the solid's boxes have
their sides on the corner lattice), negative inside; a surface corner whose 8 finer cells are all whole moved by
½ − their mean fill (whole-cell steps round off by up to ⅜ of a finer cell). A gentle slope of part-full tops is
then a smooth slope, not terraces of the finer cells' steps (46d.13c-2; before, cells under half full were air and
the steps showed as contour bands, D569); quantized to a byte over ± `DISTANCE_BRICK_BAND_VOXELS` (2) cells
(`sampleOfDistance`: 0 is −2, 255 is +2). Read from an apron of the neighbours, so same-level neighbours share their
face's samples exactly. A brick whose samples are all > 0 is `DISTANCE_BRICK_OUTSIDE`, all ≤ 0
`DISTANCE_BRICK_INSIDE`, else stored; a surface lying on a brick face is drawn by its solid side. Output
(`FarBricks`): `side` (4), `bricks` (`Int32Array` 64, x fastest then y then z: block index or a code), `samples`
(729 bytes a block, x fastest), `looks` (`Uint16Array`, a word a sample: the material most top cells in its
trilinear footprint show, thin tops included, then tops a node cell above or below, then side cells only where no
top is in reach), `blocks` (4 bytes a block: brick x, y, z in the node and the node box faces it lies on, bits −x +x
−y +y −z +z), `bounds` (6 bytes a block: the brick cells the surface can be in, low x y z then high), `occlusion`
(a byte a sample: the field's ambient occlusion one and two cells out along the gradient, 0 shut … 255 open). Draw
batches carry a node's `bricks` instead of its `mesh`.

**Drawn as bricks** (three-adapter `voxel-far-bricks.ts`): every stored brick's samples are a 9³ region of a shared
r8 (filtered) 3D texture and its baked samples a region of a twin RGBA8 (filtered) one, uploaded per brick, given
back when its node goes, the atlas grown by a GPU copy (the voxel surface's region store); a baked sample is the
look word's far colour from a palette the GPU draws with the surface's own `farColour` (`voxel-far-palette.ts`,
256² RGBA8, read back once and again when the material table uploads; resident bricks holding a changed word are
baked again) and its occlusion. Each node's brick table is a page of two more stores (a stored brick's region, its
bounds and node faces). One instanced box draw per group (as the meshes' groups), an instance a node (corner, cell
size, page, box = the union of its stored bricks' marched boxes), one material for all. Each box's back faces are
drawn; the fragment enters the node's box, walks its 4³ bricks in ray order (a 3D DDA over the page, at most
3 × 4 steps, `marchFarNode`) and marches each stored brick over its own box (its bounds, grown by
`FAR_BRICK_LIP_CELLS` (0.5) on the node faces it lies on, so a brick there hangs a steep skirt past its node;
`marchBrickBox`): field = the trilinear sample at the point clamped into the brick plus `FAR_BRICK_SKIRT_SLOPE` (4)
× the distance outside it, hit under the larger of `BRICK_HIT_VOXELS` (0.05 cells) and half a pixel
(`FAR_BRICK_HIT_PIXELS`), step the field (÷ 5 in the skirt), at least `BRICK_MIN_STEP_VOXELS` (0.25), at most
`FAR_BRICK_STEPS` (32) a brick; a ray that leaves the node first is discarded. Normal: the samples' gradient inside
the brick by central differences a cell either side (`FAR_BRICK_NORMAL_SPAN_CELLS`), or the entered face where the samples are clamped (deep under the surface); colour: one filtered read of
the baked samples (the eight samples' colours and occlusions blended by the hit's weights), the occlusion darkening
to `FAR_BRICK_AO_FLOOR` (½) at most; depth: the hit's own (`depthNode`), the same mapping as the meshes, and the boxes
placed with that depth so none is clipped at the far plane. **Half resolution** (`voxel-far-half.ts`, the voxel world
page only, `?farRes=half`, off by default): the brick draws marched into a half-size target before the frame and a
lit, depth-aware composite in it (no reuse of the last frame: D574).

**Culled on the GPU** (46d.17; WebGPU, where the frame takes the depth pyramid path; three-adapter
`voxel-far-cull.ts`): a brick group's nodes are rows of the engine's one culled-instance table
(`occlusion-instances.ts`), 16 floats a node in the group's instance buffer (corner + cell size, page + the box's
low corner packed a byte an axis in quarter cells, the world box from `COPY_BOX_FLOAT`, its spare float the packed
high corner). The groups draw in the second pass only (`AFTER_PYRAMID_KEY`), so the pyramid holds the near field
and everything else the first pass drew; the late dispatch tests each node's world box against the frustum's sides
and that pyramid, its nearest point in the far draws' own depth mapping (`far-depth.ts`), and the group's indirect
draw draws the nodes it lists. Nodes wholly inside the near cover's hidden chunks are left out of the view's list
(they stay resident and every other pass draws them). In the fragment, before the node march, a pixel whose ray
enters the node's box behind the pyramid's farthest depth there is discarded (`culledDepthAt`). Occlusion culling's
`auto` takes the pyramid path on WebGPU while a far field draws (the scene asks through `wantPyramidPath`). WebGL 2
and every pass but the view's draw every node as before. Not built (measured, not kept): normals baked per sample
(+40 % far GPU bytes, no measured gain) and a Lambert far shading (darker without the environment term).

---

## 5. Requirement traceability (46d)

Where each requirement 46d answers is built, where it is tested, and what is still open. Requirement numbers are
[voxel-format-requirements.md](voxel-format-requirements.md); the owner rows are [plan 46d](../plan-phase-46d.md) §2
(quoted there). "Seen" means pictures looked at (the item's, and the acceptance pack acc46d); every default below is
"default chosen, owner to confirm" until the owner answers acc46d.

| Requirement | Built (item: code) | Tested | Status |
|---|---|---|---|
| R88 displacement (superseded "no displacement tessellation": shader displacement of worker topology) | 46d.1a/1b spike, 46d.5a/5b product: `@thirdlight/voxel` `relief-mesh.ts`, `relief-ring.ts`, `stream-relief.ts`; three-adapter `voxel-relief.ts`, `voxel-surface-sets.ts` (`textureHeightAt`); derived 29 (§3) | `relief-mesh.test.ts`, `tools/voxel-bench/relief.test.ts`, both `relief-ring.test.ts`, `voxel-relief.test.ts`, `voxel-world.e2e.ts` (Play and export: displaced vs flat pixels) | served; per-tier verdict (low off, medium 2 steps to 16 m, high 4 to 24 m, 8 rejected) awaits the owner |
| R89 subdivision LOD separate from voxel shape LOD; displacement never touches collision/occupancy | relief ring `levels.relief` beside the level rings; relief only recesses; collision, occupancy, nav and light from the plain derive; shadows from plain casters (46d.6d) | `relief.test.ts` (every other output byte-equal relief on/off), `relief-ring.test.ts` (canonical bytes equal, `reliefOnly` swaps keep bodies), `voxel-relief.test.ts` (plain caster) | served |
| R111 wetness beyond darkening | 46d.4d `voxel-surface-wetness.ts` (`wetLook`: darker, smoother, flatter normals, water in the low parts by height); 46d.6a pieces wear their cell's wetness | `voxel-surface-wetness.test.ts` (levels 0–7 ordered), `voxel-piece-batches.test.ts` (wetness rider, no mesh) | served; seen (acc46d `wet0…7`); water reads dark, not mirror-like, until 46e's environment light |
| R112 no trim sheet for terrain/construction voxels; wall/floor/ceiling arrays, triplanar | 46d.4a `voxel-surface-textures.ts`, `voxel-surface-sets.ts` (floor y > 0.95, ceiling < −0.95, wall else; terrain its wall set triplanar), Play/export `closure-texture-slots.ts` | `voxel-surface-textures.test.ts`, `voxel-surface.test.ts`, integration export (`voxelTextures` block) | served; trim layout only for kit sheets |
| R27, R28 material id space and the material record | 46d.3a `voxel-materials.ts` (`voxel.id` 1–4,095 on the material record, `voxel_id_taken`) | `voxel-materials.test.ts`, `material-profile-ops.test.ts`, integration voxel-world | served |
| R64 textures inside the memory budget | 46d.4b `voxelTexelDensity` cap + the page's `texture_budget_mb` (`StreamedArrayTexture`, `texture-budget.ts`) | `tests/voxel-texture-residency.test.ts` | served: 24 / 96 / 96–384 MiB by tier (46d.8a) |
| Owner 2026-11-06: near-ring denser mesh for displacement, measured first | 46d.1a (topology, measured), 46d.1b (displacement, verdict) | as R88 | done; numbers plan 46d §8 |
| Owner 2026-11-04 (6): far field, no draw cut-off, mountains from several km, cheap stand-ins | 46d.7a far tree + far cache (`far-tree.ts`, workspace `voxel-far-cache.ts`, derived 31), 46d.7b meshes (`far-field.ts`, `far-mesh.ts`, `voxel-far-mesh.ts`), 46d.7c bricks (`far-bricks.ts`, `voxel-far-bricks.ts`) | `far-tree.test.ts`, `tools/voxel-bench/far-world.test.ts`, `far-bricks*.test.ts`, `far-looks.test.ts`, `voxel-far-view.test.ts`, `voxel-world.e2e.ts` (bricks on the slice page, the mesh fallback, bricks past the near field in Play both renderers and the export with the backend stopped) | served (D463, D516, D555, D556, D558, D569, D577 fixed); open D550, D551, D553, D557, D573, D574 |
| Owner 2026-11-08: build both far modes behind a switch, the owner picks | `voxelFarField` `bricks` \| `mesh` \| `off`, runtime switch; owner 2026-11-09: the brick way | as above | bricks v3 the default everywhere, meshes the fallback (46d.13c-1, after the 46d.13b bake-off); default chosen, owner to confirm |
| Owner 2026-11-04: construction tile 4 × 4 m, grid-anchored | `voxel-surface-projection.ts` (grid U/V in metres), `tileMetres` | `voxel-surface.test.ts`, `voxel-material-looks.test.ts` | served; seen (courses line up round corners, 46d.4a) |
| Owner B1: author 4096² at 1024 px/m; resident mip by tier and budget | 46d.4b residency; 46d.4c D532 (4096² in UASTC stripes, `ktx2-striped.ts`); D535 (import bound 65.3 MiB) | `voxel-texture-residency.test.ts`, `ktx2-striped.test.ts`, `folder-import.test.ts` | served |
| Owner 2026-11-02: tileable arrays wall/floor/ceiling, terrain triplanar 2 m | as R112 | as R112 | served |
| Owner B8: per-material height depth in metres, blend in metres | `voxel.heightDepth` (46d.3a), `heightBlend` (46d.4d), relief depth | `voxel-surface-wetness.test.ts`, `voxel-material-looks.test.ts` | served; seen (grass/rock seam) |
| Owner B5: one texture set per kit | kit check (46c); 46d.4c pieces draw the kit's GLB material (`voxel-kit-look.ts`), debug set only under `?trimDebug=1` | `voxel-kit-look.test.ts`, `voxel-world.e2e.ts` (sheet pixels on page, Play, export) | served |
| Owner R111 | as R111 | as R111 | served |
| Owner B3: dirt/moss = decals + material swaps, no overlay | decals on voxel surfaces (46c.16f), now over real sets; the 9 reserved bits unused | `voxel-decals.test.ts`, `voxel-world.e2e.ts` | served; decals over real sets seen in acc46d |
| Owner 2026-11-06: L1 door/window "legs" to the far-field work | derived 31: openings narrower than two of a level's cells close in the wall's material (`voxel-mips.ts`) | `far-tree.test.ts`, `far-world.test.ts` (1,000+ opening cells) | served; seen (46d.7a) |
| Owner A5: detail-piece ring = level-0 ring, unchanged | not changed; relief has its own ring | `world-host.test.ts` | held |
| Owner 2026-11-05: every distance per scene, runtime, quality-scaled | `levels.relief` (scaled by `RELIEF_RING_SCALES`), `setRings`; the far field has no distance (screen error `voxelFarError` per level) | `world-host.test.ts`, `voxel-world.test.ts`, project-model level tests | served |
| §1c one material record, families, variants, profiles, badges | 46d.3a/3b (`MaterialDef` parts, `material-profiles.ts`, `materialFamilyOf`, `materialBadges`, Inspector voxel section) | `voxel-materials.test.ts`, `material-profile-ops.test.ts`, `voxel-material-looks.test.ts`, `voxel-world.e2e.ts` | served; texture sets and physics in the Inspector not built (API only) |
| Iris Xe floor, measured at the cap | 46d.8a | staging scripts (`work/46d.8a`) | measured; misses with causes D550, D551, D555 |
