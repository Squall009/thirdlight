# Decals

> **Growing.** This page grows as decals are built. What exists now: the
> data — the decal component, decal layers, decal materials and the decal
> cells of trim sheets save, reopen, travel through MCP and ship with an
> export — the [decal pages](#decal-pages) (Play and the export put the
> decal materials' images on texture arrays), [mesh decals](#mesh-decals)
> and [projected decals](#projected-decals), which draw. **Clipped decals do
> not draw yet**, nor are decals spawned at run time; this page will say so
> when they do. How-to: [Decals](../guides/decals.md).

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
**emissiveIntensity**, **blend** — `blend`, `multiply` (darkens what is
under it: stains) or `add` (adds light: glow) — how a mesh or clipped
decal's lit colour goes over the surface, and **sortOrder** (−1000 to 1000,
default 0: where mesh decals overlap, the higher draws on top). A projected
decal blends channel by channel with its component's opacities and takes
its component's sort order instead.

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

## Mesh decals

Any mesh wearing a decal material is a **mesh decal**: geometry authored
for the mark (a quad, a strip along a curb, a splash over a corner) laid on
a surface. Map a model's glTF material to a decal material (the asset's or
the object's **materials**), or put one on a box. A glTF material whose
name ends in `_decal` (any case) draws as a decal with the file's own
textures by itself; a mapping to another material replaces that. A graph
material draws as one when its output's **Decal** field is `blend`,
`multiply` or `add` (its **Decal sort order** orders it).

How it draws:

- **Transparent, no depth written, no shadow cast**, after the opaque
  scene; it is lit like the surface under it (light layers, probes, its
  room, ambient occlusion). `multiply` is unlit: its colour (white where its
  opacity is 0) multiplies the lit surface. `add` adds its lit colour.
- **Pushed toward the camera** in the vertex stage, along the view ray, by
  2 mm or 1 mm per metre of distance, whichever is more (never more than
  half the distance): it keeps its place on screen and always wins the
  depth test against the surface it lies in, with the standard, reversed-Z
  and logarithmic depth buffers alike. A standard depth buffer also takes
  one fixed polygon offset for grazing angles (the same for every decal, so
  no extra pipeline). Lay the mesh on the surface or a few millimetres over
  it; an object passing within the push of the surface may show through it
  far away (8 cm at 80 m).
- **Order:** before every other transparent surface (water, effects), in
  sort order; decals of the same order sort by distance.
- **Texture coordinates** 0–1 cover the decal's image (outside, the edge is
  held); its reads stop at the image's safe mip level, so a far decal never
  takes in a neighbour's pixels on its page.
- **Draws:** decal meshes are batched like other meshes (copies of one mark
  mesh are one instanced draw) and static ones merge into the static cells:
  one draw per cell per decal material and sort order. 1,000 static mesh
  decals of one material on the test level add 1–2 draws.
- **Images:** Play and the export draw a decal material from the decal
  pages (its own textures and sheet cell are not loaded there); the Scene
  view draws its own textures or the sheet's cell directly, in the same
  place and with the same safe mip level.

## Projected decals

A decal component in `projected` mode (the default) draws in the material
of every surface inside its box: the surface blends the decal into its own
albedo, normal, roughness, metalness, occlusion and emission **before it is
lit**, so the mark takes the surface's light, shadows, probes and room, and
a wet patch can change roughness alone. It works the same on WebGPU and
WebGL 2, and on every lit surface: block layers, terrain, props (models,
boxes), instance copies, generated architecture, splines and static merged
cells. Unlit materials and mesh decals take none.

How a pixel takes it:

- **The box.** Only the part of a surface inside the box is marked. The
  image is the box's XY face (+Y up); the mark is stretched along −Z, the
  way the box projects.
- **Channels.** Each channel blends by the image's alpha × the material's
  opacity × the component's opacity for that channel × the fades. A channel
  the material has no image for is left alone: a decal with only a colour
  image keeps the surface's normal map, roughness and occlusion; one with
  only a normal map (albedo opacity 0) bends the light and keeps the colour.
  Roughness and metalness also blend when the material sets them as values.
  Emission adds the material's `emissive` × `emissiveIntensity` where the
  ORM image's emissive mask is set.
- **Normals.** The decal's normal map is read in a frame made from the
  surface's own facing and the box's X axis, and bends the surface's normal
  (its own normal map stays under it).
- **Fades.** `normalFade` against the surface's facing (a wall beside a
  floor decal takes nothing at the default 90°), `edgeFade` near the box's
  front and back, `fadeDistance` from the camera.
- **Layers.** The decal's `layers` and the object's `decalLayers` must share
  one (a per-object value: no extra shader per mask).
- **Order.** Overlapping decals blend lowest `sortOrder` first, so the
  higher one is on top.
- **Mips.** Reads take their mip level from how the surface spreads on
  screen, capped at the image's safe level on its page, so a far decal
  never takes in its neighbours' pixels.

**What it costs.**

- Only objects whose bounds meet a decal's box (and share a decal layer
  with it) draw with the decal steps; every other object keeps the shader it
  had. A scene without projected decals builds exactly the shaders it built
  before.
- Decals are data: however many there are, in whatever sizes, places and
  images, each material that receives them builds one more shader (two
  materials alike share one). A shader is made only for the channels some
  decal in the scene changes.
- A pixel of a reached object finds its decals through a **world grid**: a
  cell lists the decals reaching into it. A pixel under no decal reads one
  value and goes on.
- **The overlap budget:** a cell lists at most 16 decals (the
  `DECAL_CELL_BUDGET` limit), so no pixel blends more than 16. Past it the
  cell keeps the highest sort orders and drops the rest there; Play
  diagnostics count the dropped entries (`renderer.projectedDecals.dropped`).
  It is a cost per spot, not a cap: a level may hold any number of decals,
  spread out.
- The grid and the decal table are built when a decal is added, removed,
  changed or moved, or its images arrive, never on a still frame.
- Measured on this engine's test host (Iris Xe, 1080p, uncapped), 200
  decals spread over a test level's ground, walls and props (they reach 226
  of its 238 scene draws): the scene pass +0.8 ms GPU, the main thread
  +0.5 ms (WebGPU) and +0.6–1.0 ms (WebGL 2) a frame, 2 more shaders; the
  grid 320 KiB, built in 10–16 ms. Without projected decals: nothing.

**Images.** Play and the export read the decal pages; the Scene view draws
each decal material's own textures (or its sheet's cell) into a small page
array of its own (512² a layer), so it shows what Play shows.

**Diagnostics.** Play's `renderer.projectedDecals`: `decals` (loaded),
`drawn`, `unplaced` (an image on a page array other than its set's: not
drawn), the grid's `cells` and `entries`, `dropped` (over the overlap
budget), `builds` and `buildMs` (the last build), `dataBytes` (table and
grid), `viewPageBytes` (the Scene view's pages) and `receiverDraws` (draws in
the last frame that blended decals). `?decals=off` on a Play or export URL
draws without them, to see what they cost.

## Decal cells on trim sheets

A trim sheet may hold square marks placed once — the Texture Designer's
`decals` layer — besides its rows. **Import layout.json** in the trim sheet
table reads them as the sheet's **decal cells** (`cells: [{name, rect: [x,
y, width, height]}]`, pixels from the image's top-left), listed under the
table with their size in pixels and in metres at the sheet's texel density.
Cell names are unique on the sheet and every cell lies inside it. A sheet
without cells keeps its old data exactly.

## Decal pages

Every decal of a scene may be drawn by one shader, so Play and the export
put the images of the decal materials the game uses on **decal pages**:
square images, all of one size, each decal a rectangle on one. The pages of
a channel set are the layers of one texture array, so a decal that changes
one channel reads one texture:

| Set | Holds | Encoding |
|---|---|---|
| albedo | colour, opacity in alpha | UASTC, sRGB |
| normal | the normal map | UASTC, linear |
| ORM | occlusion, roughness, metalness; an **emissive mask** in alpha | UASTC, linear |

The emissive colour is the material's (`emissive` × `emissiveIntensity`);
the mask says where it glows: the largest of the `emissiveMap`'s red, green
and blue, or, without one, the ORM texture's alpha.

How images get there:

- The page size is the largest image's, rounded up to a power of two (at
  least 256).
- An image exactly the page size is a page **as it is**: a trim sheet's
  textures (its decal cells are then rectangles on it) or a loose decal's.
  When the texture is a UASTC KTX2 with a full mip chain in the set's
  colour space, its file is joined into the array untouched — nothing is
  copied or encoded.
- Everything else is **copied** onto composed pages: smaller images, the
  cells of a sheet of another size, an ETC1S or PNG texture, and an ORM
  page that needs an emissive mask. Each copied rectangle keeps an 8-pixel
  **gutter** that repeats its edge, in a box aligned to 16 pixels. A page is
  encoded once (an ETC1S texture from its PNG original when the backend
  knows it, else transcoded: a second lossy generation) and cached in the
  project's import cache, so the next Play and the export reuse it and a
  new decal encodes only the page it lands on. A composed page is at most
  2048² (the encoder's limit); a larger image is copied at a reduced size.
- **Sampling caps the mip level** at each rectangle's safe level: the
  deepest level whose texels stay inside the rectangle and its gutter, as
  the trim material does with its rows. Distant decals then alias a little
  rather than bleed in a neighbour's colours.

A trim sheet's cells use the sheet's own gutter (the Texture Designer
repeats each cell's edges by its `gutter_px`, the sheet's padding).

**Cost.** A composed 2048² page takes about 12 s to make once on this
engine's test host (a 1024² page about 2.5 s); a page as it is and a cached
page take milliseconds. On the GPU a page is 1 byte a texel with its mips:
5.3 MiB for 2048², 1.3 MiB for 1024², per set.

**Memory and streaming.** The pages count against the project's
[texture budget](../concepts/streaming-and-budgets.md) like every texture
that does not stream. A page array is loaded while a loaded decal names a
material on it and let go when the last such decal leaves (its scene
unloaded), and it goes to the GPU as soon as it arrives, before anything
draws it (a mesh decal's material holds the arrays it draws with itself and
uploads them with its first frame). There is no cap on decals or pages: a set holds as many pages as
its decals need, split into several arrays when one would pass what a join
takes. Play diagnostics show them as `renderer.decals` — `decals` (loaded
decals with a page), `pages` (arrays), `layers`, `bytes`, `onGpu` and
`missing` — next to `renderer.textures` (the budget); an exported game's
canvas carries `data-tl-decal-pages` (`arrays|layers|bytes|uploaded`).

Related: [trim sheets](material-graphs.md#trim-sheets),
[light layers](lighting.md#light-layers), the reference for the
[decal component](../reference/components-rendering-1.md#component-decal).
