# 46e.11 — emissive voxel materials: the proposed entry (owner's note needed)

**Status: the owner's note came 2026-11-17 (relayed by the owner's other session): approved with changes.**

- Question 1: yes, reuse the two existing fields.
- Question 2, changed: drawn glow and light given off are separate. **Without a mask** a voxel surface draws
  glow colour × strength × the material's colour texture (a glowing block keeps its texture), and the volume uses
  glow colour × strength × the material's mean colour: one value a material. **A mask** affects only the drawn pixel
  (and so bloom); it is packed into a spare channel of a map the voxel surface already reads (no extra texture
  read, no 14th binding); the volume then uses glow × the mask's mean, computed by the engine when the table is
  built, never set by hand. If no channel is free: report what was checked and stop. The mask is stored data in a
  material's surface sets: its add-only entry text is published for the owner **before** the mask part is built.
- Question 3: no glow in the far field in 46e-b.
- Known and accepted: voxel materials that already carry a glow start glowing.

The no-mask part is approved and 46e.12 (d) is built on it. The text below is the proposal as first published; where
it differs from the note above (the surface drawing the bare glow colour; "the mean glow of the faces"), the note wins.

**As first published (2026-11-16):** nothing of it was built. Only 46e.12 (d) and the tuning (46e.14) wait for your
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

## The glow as built (46e.12 (d), 2026-11-18)

The approved no-mask entry, in its final words, is in `docs/architecture/voxel-render-spec.md` §1 ("Owner note (46e.11,
2026-11-17 …): emissive voxel materials"). What it says, briefly: no new field; the record's `params.emissive` ×
`params.emissiveIntensity` (0–16) in linear light is the glow; a near voxel surface draws glow × the pixel's colour
(texture × tint, or the flat colour), blended between neighbouring materials as the colour is; the light volume keeps a
second word a cell (the mean glow of the solid faces the cell borders, each the material's one value glow × mean
colour), its rays see glow + bounce, and each brick's glowing faces are emitters its neighbours' cells aim at so a
one-block lamp is even within seconds; a record edit rewrites the cells beside the changed material; nothing glows past
the mesh rings. Where it differs from the first published text: the mean glow is of the solid faces a cell borders (not
of the glowing ones only), and the emitters (next-event estimation) were added after measuring the blotches.

## The mask: the proposed entry (owner's note needed)

**Nothing of the mask is built** (no field, no validation, no shader read of a mask channel). This is the
investigation and the entry text for your note.

**What the voxel surface reads per pixel today** (`voxel-surface.ts`, `voxel-surface-sets.ts`; every one of the four
near draw paths, level 0 and the level 1–2 mesh rings, reads the same maps; the one-material paths read one set):

| Map | Channels and their use | Free? |
|---|---|---|
| albedo array (`color`: ETC1S, UASTC past 12 Mpix; sRGB) | RGB colour; **A height** (texture layout v1, amended 2026-11-09) | no |
| normal array (`normal`: UASTC, normal preset, linear) | RGB the tangent-space normal (`.xyz × 2 − 1`); **A unused, never read** | yes |
| ORM array (`data`: UASTC + Zstandard, linear) | R occlusion, G roughness, B metalness; **A unused, never read** | yes |
| crack array (512², engine-made) | R the crack strength | no (engine-owned, kits' cracks) |
| material table (float, 64 × 256 texels) | per id: colour, pattern; tiles, crack layer, **glow r**; relief layer, depth, blend, **glow g**; layers, **glow b** | not a texture of the set |
| shader grids (`rg8unorm`) | the cells' material, wetness, construction bit | no |

**The candidate: the ORM array's A** (the decals' convention: `project-model` `decal-pages.ts` keeps a decal page's
emissive mask in its ORM alpha). Checked:
- **The pipeline keeps it.** The slot assembly copies each layer's four channels from its texture (`texture-slots.ts`
  `packLayersOf`: channels 0–3; only the albedo's A is replaced, by a height); `data` encodes UASTC (RGBA) with
  Zstandard and a mip chain made by the encoder (alpha filtered as the other channels, so a mask's mean is kept down the
  levels); joins and stripes copy UASTC blocks as they are. Measured (`~/.cache/thirdlight-phase46e/work/46e.12d/
  maskcost/`, the repo's encoder, the town's rock ORM upscaled to one 4096² layer, the import's path `encodeKtx2(…,
  'data')`): **A = 255: 2,162,565 bytes; a crack mask in A (37 % of the texels lit, soft edges): 2,236,899 bytes
  (+3.4 %)**; decoded, the mask comes back to a mean error of 0.0007 / 255 and the RGB's error stays under 0.002 / 255.
- **The GPU bytes do not change.** UASTC transcodes to BC7 (`RGBA_BPTC`, 16 bytes a 4 × 4 block with or without
  alpha) where `texture-compression-bc` is on. Probed on the Iris Xe (the bench's GPU browser, `work/46e.12d/probe/`): WebGL 2
  exposes BPTC, S3TC, ASTC and ETC and the WebGPU adapter `texture-compression-bc`; three's KTX2Loader drops ASTC and ETC
  on Linux (Mesa emulates them), so UASTC goes to BC7: a 4096² ORM layer is 16 MiB plus its mips with or without a
  mask. (Only on a GPU with S3TC and no BPTC would three pick BC3 for an image with alpha over BC1 without; an ORM
  array's fill layer already has A = 0, so such an array is BC3 today.)
- **No extra read**: the ORM sample is already taken on all four draw paths (`textureSetAt` reads `orm` for the
  full maps; only its `.xyz` is used), so a mask is its `.w` of the same read.
- **The default without a mask: 1 (the whole surface glows, as built now).** An ORM image without alpha decodes A =
  255 (mask 1). **But the absent-map constants have A = 0 today**: the neutral texel `NEUTRAL_TEXELS.orm` ([255, 204,
  0, 0]) and the fill layer of an ORM array (`TEXTURE_ABSENT_VALUES.orm` [1, 0.8, 0, 0]). The entry therefore needs
  the voxel ORM's absent A set to 1 (a voxel-arrays fill of its own, so the layered surfaces' and graphs' absent ORM
  stays as it is): a set without an ORM map, and a material without a set, glow whole.
- **The mean for the volume** is the engine's, never set by hand: measured with the bounce colour's texture means
  (`textureLayerMeans`, one compute pass over a coarse level of every layer when the arrays arrive) by averaging the
  ORM array's A per layer the same way (one more read back of the same size); the volume's glow of a material is then
  glow × mean colour × mask mean, and the emitters' power the same.
- **The normal array's A** is the second candidate (also free, also UASTC → BC7, also read on every path); the ORM's
  A is proposed because the decals already use it and the ORM map is linear data, where a mask belongs.

**The proposed entry text** (for `voxel-render-spec.md` §2; add-only, no new array, no new binding, no new field in
the material record):

> **Owner note (date of approval): a glow mask in a texture set's ORM alpha.** An add-only reading inside texture
> layout v1 and project schema 8: the A of a voxel texture set's `orm` map is the **glow mask** (0 no glow, 1 the
> material's full glow; linear). A designer paints it into the ORM image's alpha (cracks of a lava rock, the lit
> panes of a window texture); an ORM image without alpha, a set without an ORM map and a material without a set glow
> whole (the voxel ORM array's absent value gets A = 1). Drawn: a near voxel surface's glow is glow × the pixel's
> colour × the mask (the same ORM read, its fourth channel), blended as the colour is; so bloom follows the mask.
> Lit: the light volume uses glow × the material's mean colour × the mean of its wall set's mask, measured by the
> engine with the texture means when the arrays arrive, never set by hand. Nothing else changes: the arrays, their
> encoding (UASTC, linear) and their GPU format and bytes are as they are; a mask costs about 3 % of an ORM layer's
> file bytes. Not read by the far field (no glow there in 46e-b).

**A picture**: `docs/briefs/proposal-46e.11-mask-mock.png` is a **mock-up, not an engine picture** (nothing of the
mask is built): the night street's crystal panel as built (left: painted over a brick front and a window, it draws the
crystal's plaster texture glowing) and the same crop with a hand-drawn crack mask applied to its glow (right: the
unmasked part shows the front as the standard night picture draws it). The engine's own pictures of the glow as built: `docs/briefs/proposal-46e.11-night.png`,
`docs/briefs/proposal-46e.11-room.png` (replacing the hand-drawn mock for the owner's page).
