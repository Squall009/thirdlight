# Voxel rendering and materials — format page (46d additions)

Status: **skeleton** (46d.2, D496); §1 written by 46d.3a and 46d.3b. This page receives every format addition of 46d (rendering and materials), each
as a versioned, add-only step with its owner note, so the [format spec](voxel-format-spec.md) v1 (APPROVED by the
owner on 2026-11-02) is not grown further. Nothing here is approved yet: a section is filled by the 46d item that
builds it ([plan 46d](../plan-phase-46d.md) §6), and every section stays empty until then. § numbers name the format
spec's sections unless marked as this page's. Kits are on [voxel-kit-format.md](voxel-kit-format.md), the role spec
on [voxel-role-spec.md](voxel-role-spec.md), the texture layout on [voxel-trim-layout.md](voxel-trim-layout.md).

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
  - `surfaces` `{wall?, floor?, ceiling?}`, each a texture set `{albedoHeight?, normal?, orm?}` of plain texture
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
the Scene view and the voxel world page alike.

**What the game reads (46d.3b).** `ctx.voxels.materialOf(id)` / `materialAt(x, y, z)` answer `{id, materialId,
name, use, kit, physical, gameData}` from the build's shipped records (`voxelMaterialInfos`; frozen), handed to the
runtime with the world ports. Chunk colliders keep the engine's one friction: Rapier's triangle-mesh colliders have
no friction per triangle, so per-material friction is game logic over these reads.

**Measured** (vitest, Node): a record with every part 414 bytes compact (79 without them); a project with all
4,095 voxel ids given a material loads (validate + canonical) in 63 ms, one material edit on the trusted block
5.5 ms, the list 1.65 MB compact.

## 2. Texture sets

Not yet written (46d.4a–46d.4d: texture sets in arrays, residency, kit sheets and crack maps, height depth and wetness).

## 3. Relief part

Not yet written (46d.5a: the relief part as a derived output).

## 4. Far-field data

Not yet written (46d.7a–46d.7c: the far tree, voxel-mip meshes and ray-marched bricks behind a switch).
