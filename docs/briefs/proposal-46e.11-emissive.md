# 46e.11 — emissive voxel materials: the proposed entry (owner's note needed)

**Status: proposed 2026-11-16. Nothing of it is built.** Only 46e.12 (d) and the tuning (46e.14) wait for your
note; the other light types and the defect fixes go on meanwhile. Answer **yes / no / change** to the three
questions at the end; a default you leave stands once you say "approved".

Your decision this follows: "the glow is a property of the voxel's material, not stored per voxel. The volume keeps
it per cell the way it keeps the bounce colour."

## The entry, in one sentence

**No new stored field.** A material record already has **Glow colour** (`params.emissive`) and **Glow strength**
(`params.emissiveIntensity`, 0–16); meshes draw them today and voxel surfaces ignore them. The entry says: *a voxel
surface draws its material's glow, and the light volume reads it as light given off by that surface.*

So the add-only step is in what the engine **reads**, not in what a project **stores**: every project, region file,
build and export stays byte for byte as it is. The voxel value (32 bits), the region files and the far cache do not
change.

The text proposed for `docs/architecture/voxel-render-spec.md` §1 (it goes in with your note, not before):

> **Owner note (46e.11, date of approval): emissive voxel materials.** An add-only step inside project schema 8, not
> a new format and with no new field: the voxel path now reads two fields the material record already has,
> `params.emissive` (a colour, default black) and `params.emissiveIntensity` (0–16, default 0). A voxel material
> whose strength is over 0 and whose colour is not black **glows**: the radiance it gives off is colour × strength,
> in the units the lights use (a white glow of strength 1 is as bright as a white wall lit by 3.14 units of light).
> Inherited along an instance chain as any parameter. The glow is the material's, never the voxel's: nothing is
> stored per voxel, in a region file or in the far cache. Drawn: the material table carries each id's glow, blended
> between neighbouring materials as its colour is, and the surface adds it to the pixel. Lit: the light volume keeps,
> for each open cell it holds, the mean glow of the solid faces that cell borders (one more 32-bit word a cell beside
> the bounce colour, never stored on disk), and a ray of its update that meets a surface sees that glow added to the
> surface's bounce. Shader data only (the feeds rule): a record edit rewrites the table and the cells' glow words and
> marks the bricks within the rays' reach; no derive, mesh or grid upload. A project whose voxel materials already
> carry a glow (ignored until now) starts to glow.

## What a designer sets

- In the Materials panel, on any voxel material (terrain or construction): **Glow colour** and **Glow strength**,
  the two fields that are already there for meshes. Nothing else.
- Paint or build with that material using the voxel brushes, as any material. Lava, a crystal vein, a lamp block, a
  lit window pane, a neon strip are each a material.
- A glow that can be switched (a lamp block on and off): two materials, the lit one a **material instance** of the
  unlit one with its own voxel id and a glow. The game changes the cell's material; the light follows like any edit.
  There is no per-voxel "on" bit.
- A game's script changes nothing new: `ctx.voxels` edits that place a glowing material light the cells round it.

## What the volume stores and does

- **Stores:** per kept 0.5 m cell beside a surface, one more word: the mean glow of the solid faces it borders, packed
  as the light is (HDR, 32 bits). 28 → 32 bytes a cell; the fixed pool goes from 29.8 MB to about 34 MB (of the
  160 MiB the tier's table allows). Built on the page from the chunks' material grids, exactly as the bounce colour
  is today; never written to disk.
- **Does:** when a ray of the update meets a surface it now sees *glow + bounce* instead of bounce alone. So a
  glowing surface lights the cells round it softly, out to the rays' reach (24 m today), and that light bounces on
  like any other. Every lit draw that reads the volume (voxel surfaces, kit pieces, props, moving objects) is lit
  by it.
- **Edits:** painting or digging a glowing material, or changing a material's glow, relights what it reaches as an
  edit does today (first light about 0.1 s, settled in 0.5–1.7 s as measured for lamps and windows in 46e-a;
  unverified for glow until built).

## What it will not do (by design, so you are not surprised)

- **Soft light only.** A glowing voxel casts no sharp shadow and gives no highlight: the volume holds light at 0.5 m.
  For a crisp pool of light with shadows, put a lamp object there as well.
- **Small glows may be noisy at first.** One glowing 0.5 m face is found by few of a cell's rays, so its light can
  be blotchy until the update has run several times. Making that even is part of 46e.13 (the look fixed where cells
  are written) and of how 46e.12 (d) is built (a brick with glowing faces can be listed in the per-brick lamp list
  so cells aim at it instead of finding it by chance). No format consequence.
- **The whole material glows evenly.** No glow mask texture in this step (question 2).
- **The far field does not glow** (question 3): the brick far field's colour is baked and has no glow channel; a
  far-cache channel is phase 49's kind of step, and stored data is your stop.

## The mock

`proposal-46e.11-mock.png` beside this page (`mock-emissive.png` in the published pack): a drawn sketch, **not an engine picture** (nothing is built). A room at night
in section: a lava channel in the floor (a glowing material) and a crystal vein in the wall; the open cells beside
surfaces hold the light; no lamp object in the room.

## Cost, as estimated (unverified until built)

- Memory: about +4 MB GPU (above). Page: the glow words are written with the colour words (same pass over the grid).
- GPU update: one more texel read a ray hit. Per-pixel: one add from the material table the pixel already reads.
- No new texture binding on voxel surfaces (they are at 13 of the Iris Xe's 16 with the volume on).

## The three questions (each with the default that stands)

1. **Reuse the two existing fields, or add separate voxel ones?** Default: **reuse** (`params.emissive`,
   `params.emissiveIntensity`): no new stored field, one glow for a material whether it is on a mesh or in voxels.
   The alternative is a new optional `voxel.glow {colour, strength}` (a real add-only field) if you want a voxel's
   glow apart from the same record's glow on a mesh.
2. **A glow mask texture** (only parts of the surface glow, such as cracks in lava rock)? Default: **not now**. It
   would be a fourth map in a material's surface sets: one more texture array (a 14th binding of 16, and its VRAM).
   A later add-only step if you want it.
3. **Glow in the far field?** Default: **no** in 46e-b: a glowing surface is drawn glowing as far as the near
   surface shader draws it (the detail ring and the mesh rings; whether baked fine bricks show it is checked when
   built), and lights its surroundings only inside the volume's window (±48 m). Past that it is dark at night until
   a far-cache channel exists (phase 49).
