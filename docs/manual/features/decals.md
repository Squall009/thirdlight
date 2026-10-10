# Decals

> **Growing.** This page grows as decals are built. What exists now is the
> data: the decal component, decal layers, decal materials and the decal
> cells of trim sheets save, reopen, travel through MCP and ship with an
> export. **Nothing draws a decal component yet**: projected decals, mesh
> decals and clipped decals are drawn by the items that follow, and this
> page will say so when they do.

Decals put the detail that breaks up repetition — dirt, cracks, stains,
leaks, signs, puddles, scorch marks — on the surfaces of a level without new
unique textures.

## The decal component

A **Decal** (component `decal`, Inspector "+ Add component", MCP
`setComponent "decal"`) is a box centred on its object that marks the
surfaces inside it. Its image lies in the object's XY plane (+Y up) and it
projects along the object's −Z: turn the object to face the surface. Its
fields:

- **size** `[w, h, d]` metres: the mark's width and height, and the depth of
  the box it reaches through (the object's scale applies);
- **mode**: `projected` (the default) — the surfaces inside the box blend
  the decal into their own material before they are lit, channel by
  channel — or `clipped` — a mesh is cut from the surfaces inside the box
  when the scene loads and drawn as a mesh decal;
- **material**: a decal material (below); any other is refused;
- **opacity** `{albedo, normal, roughness, metalness, occlusion, emission}`,
  each 0–1 (empty: 1): how much of each surface channel a projected decal
  changes — a wet patch changes roughness only, a crack the normal only;
- **normalFade** (degrees, 1–180, default 90): surfaces turned further than
  this from facing the projector take no mark, fading out over the last
  fifth of the angle (180: back faces too);
- **edgeFade** `[front, back]` (0–1, default 0.3 each): the share of the box
  depth it fades over near each end, so a mark ends softly where a surface
  leaves the box;
- **fadeDistance** (metres, empty: never): where it has faded out, over the
  last fifth;
- **sortOrder** (−1000 to 1000, default 0): where decals overlap, the higher
  order is drawn over the lower;
- **layers** (decal layers, default every layer): which objects it marks.

The component stores the projector only, never triangles: a clipped decal's
mesh is made again whenever a surface under it changes (a block chunk, a
regenerated wall), as generated architecture is.

There is no cap on decals in a project.

## Decal layers

Every drawn object — box, model, instance set, block layer, terrain,
generated architecture and spline — has **Decal layers** (`decalLayers`):
eight checkboxes in the Inspector, a bit mask in the data (bit n is layer
n + 1). A decal marks an object when its **layers** and the object's decal
layers share one. Unchecking every box keeps every projected decal off the
object.

Absent, an object is in every layer, so a level takes decals without
setting anything — except a **skinned model**, which is in none: a projector
fixed in the world would slide over a moving skin. Marks on a character are
mesh decals parented to a bone. Checking boxes on a skinned model stores
its mask, every layer included.

## Decal materials

A material with the **decal** shader (Project window: a material's shader
→ `decal`) is what decals draw with. Its parameters: **color** (a tint),
**opacity**, **roughness** and **metalness** (factors on the ORM texture's;
1 and 0 without one), **normalScale**, **aoIntensity**, **emissive** and
**emissiveIntensity**, and **blend** — `blend`, `multiply` (darkens what is
under it: stains) or `add` (adds light: glow) — how a mesh or clipped
decal's lit colour goes over the surface. A projected decal blends channel
by channel with its component's opacities instead.

Its images come from one of two sources (the Inspector's **source**):

- **its own textures**: `map` (albedo, opacity in alpha), `normalMap`,
  `ormMap` (occlusion, roughness, metalness) and `emissiveMap`;
- **a trim sheet's decal cell**: a trim material and one of its cells by
  name (`decal: {sheet, cell}`). The textures are then the sheet's, inside
  the cell, so a level restyled by swapping its trim sheet swaps its decals
  too. A material takes one source, not both. A material instance uses its
  parent's cell.

A decal material that draws a sheet's cell ships with that sheet in an
export.

Until mesh decals are drawn, a model wearing a decal material shows it as a
plain see-through surface (its own textures, tint and opacity; no depth
push, blend mode or sheet cell yet).

## Decal cells on trim sheets

A trim sheet may hold square marks placed once — the Texture Designer's
`decals` layer — besides its rows. **Import layout.json** in the trim sheet
table reads them as the sheet's **decal cells** (`cells: [{name, rect: [x,
y, width, height]}]`, pixels from the image's top-left), listed under the
table with their size in pixels and in metres at the sheet's texel density.
Cell names are unique on the sheet and every cell lies inside it. A sheet
without cells keeps its old data exactly.

Related: [trim sheets](material-graphs.md#trim-sheets),
[light layers](lighting.md#light-layers), the reference for the
[decal component](../reference/components-rendering-1.md#component-decal).
