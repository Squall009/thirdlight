# Height in alpha

**Goal:** layers of a [layered surface](../features/material-graphs.md#layered-surface)
that meet along their stones, cracks and clumps — moss in the joints, dirt
between the cobbles — instead of fading into each other evenly.

A layered surface blends its layers by their **heights**: where two layers
are painted half and half, the one whose height is higher there shows. Each
layer's height comes from the **alpha of its colour texture**. Without one,
every texel is "as high" as every other, and the blend is a soft, even fade.

## The rule

| Material | Colour texture RGB | Colour texture A |
|---|---|---|
| Opaque, blendable (Layered surface: terrain, block ground and walls, generated architecture, painted props) | colour, sRGB | **height**, linear (0 = low, 1 = high) |
| Cut-out, transparent and decal (foliage, decals, alpha clip, blended surfaces) | colour, sRGB | **opacity** |

The engine works out which one a material is from what it reads (the
material's **reads** in the Inspector: *albedo alpha = height* or
*albedo alpha = opacity*). A cut-out or decal material keeps A as opacity and is never
checked for a height.

## What the engine does without one

When a texture goes into a layer of a layered surface (dropped on a palette
tile, picked for a slot, set by a command), the backend looks at its alpha.
If it has none, or it is flat (one value everywhere, give or take a level
or two of compression noise):

- the project's problems say so: *"rock-albedo: no height in alpha — blends
  between layers will be soft"*, with the material and layer it is used in;
- the layer's palette tile shows a small **no height** badge;
- the layer gets a height made from the texture's **brightness** (dark
  joints low, bright faces high, stretched to the full range). It is made
  once, when the layer array is put together, so the Scene view, Play and
  the exported game all draw the same thing and no shader works it out per
  pixel. It is a stand-in: brightness often follows height on stone and
  bark, and often doesn't on painted or patterned surfaces.

Import a version of the texture with a real height in A and the badge,
the problem and the stand-in go away; the array is made again with the new
texture.

## How to make one

- **art-factory Texture Designer**: render the material with the albedo +
  height packing — the `skyforge` packing preset writes
  `<name>_albedo_height` (PNG and KTX2: albedo in RGB, the graph's height in
  A, kept above 1/255 so encoders keep the colour) beside the normal and ORM
  maps. Import those three into the layer (dropping the colour texture
  brings the normal and ORM maps named alike).
- **Any other tool** that packs a height map into the alpha channel: Substance
  Designer or Painter (an output with the height in A), Material Maker, an
  image editor (paste the height map into the alpha channel), or the
  engine's own channel packing (`tl_content_upload` with `pack`: albedo R,
  G, B and the height map's R as A).

Keep the height linear (not gamma-encoded) and use the range: a height that
spans only a few levels counts as flat.

## Through the API

- `tl_diagnostics` lists the problem (`no_height_in_alpha`), one line per
  texture.
- `GET /api/v1/projects/<id>/content/textures/height-alpha?ids=a,b` answers
  `height`, `flat`, or null per texture.
