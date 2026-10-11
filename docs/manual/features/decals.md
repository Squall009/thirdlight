# Decals

Three kinds: [mesh decals](#mesh-decals) (a mesh drawn over a surface),
[projected decals](#projected-decals) (a box that marks every surface in
it, channel by channel) and [clipped decals](#clipped-decals) (a mesh cut
from the surfaces in a box at load). The data — the decal component, decal
layers, decal materials and the decal cells of trim sheets — saves,
reopens, travels through MCP and ships with an export; the
[decal pages](#decal-pages) put the decal materials' images on texture
arrays; the Scene view's [Decal tool](#the-decal-tool) places them; scripts
[spawn](#decals-spawned-by-scripts) short-lived ones. How-to:
[Decals](../guides/decals.md). For colour and weights painted on a mesh's
vertices see [Vertex paint](vertex-paint.md).

Decals put the detail that breaks up repetition — dirt, cracks, stains,
leaks, signs, puddles, scorch marks — on the surfaces of a level without new
unique textures.

## Which decal for which mark

| The mark | Use | Why |
|---|---|---|
| A wet patch, a scratch or crack in the normal only, a change of roughness or metalness | projected | Only a projected decal blends one channel into the surface before it is lit; mesh and clipped decals blend their own lit colour over it. |
| A mark on terrain | projected | Terrain's levels of detail change its surface with distance, so a clipped mesh would float or sink; a projected decal follows the pixel. |
| Many static marks on blocks, walls, generated architecture and props: dirt, stains, signs, leaks | clipped | Clipped once at load (cached), merged into the static cells: one draw per cell per decal material, and no receiving shader changes. A pixel pays only where a mark is. |
| A mark modelled with the asset (a sign on a crate, a painted stripe) | mesh | Its geometry ships in the model file and draws the same way as a clipped mark. |
| Marks left during play (bullet holes, footprints, scorch) | spawned (projected) | A script spawns them from a prefab; the transient budget keeps the newest. |
| A mark on a character | mesh, parented to a bone | A world projector slides over a moving skin; skinned models take no projected decal by default. |

- **Projected decals cost per receiver, not per decal:** every draw a
  projected decal's box reaches wears a shader with the decal steps and is
  checked on the CPU each frame. Many projected decals spread over a level
  reach most of its draws (see [Limits and budgets](#limits-and-budgets)).
  For static marks that need no per-channel blending, prefer clipped ones.
- **Keep overlaps low.** Stacked projected decals cost every pixel they
  share; past the overlap budget the lowest sort orders drop. Merge a dense
  cluster into one image, or spread it out.
- **Clipped and mesh decals blend in order, not per channel.** Use
  `multiply` for a stain that darkens what is under it, `add` for a glow,
  `blend` otherwise.

## Limits and budgets

None of them caps how many decals or painted objects a project holds; each
is a cost per spot, per frame or per step. Each number links its constant
in the generated reference, which holds this build's value.

- **Overlap:** a cell of the projected decals' index lists at most 16
  decals ([`DECAL_CELL_BUDGET`](../reference/limits-project-model-1.md#limit-decal-cell-budget));
  past it the highest sort orders stay and the dropped ones are counted
  (`renderer.projectedDecals.dropped`, Play's `decal_overlap` problem).
- **Spawned decals:** at most 256 kept at once
  ([`DECAL_TRANSIENT_BUDGET`](../reference/limits-project-model-1.md#limit-decal-transient-budget));
  a spawn past it fades the oldest out. A spawn's scale and lifetime are
  clamped to [`DECAL_SPAWN_LIMITS`](../reference/limits-runtime.md#limit-decal-spawn-limits).
- **The component:** a box side up to 1000 m, sort orders −1000 to 1000
  and the fades' ranges ([`DECAL_LIMITS`](../reference/limits-project-model-1.md#limit-decal-limits));
  a new decal's values are [`DECAL_DEFAULTS`](../reference/limits-project-model-1.md#limit-decal-defaults).
- **Decal pages:** composed pages up to 2048²
  ([`DECAL_PAGE_LIMITS`](../reference/limits-project-model-1.md#limit-decal-page-limits)),
  counted against the project's texture budget (default
  [512 MiB](../reference/limits-project-model-2.md#limit-texture-budget-default-mb)).
- **Clipped meshes** are kept in a memory cache of a fixed size and, in an
  exported game, in the player's browser; neither is a limit on decals.

What each kind costs on this engine's test host (Iris Xe, 1080p, uncapped,
one test level) is in the cost line of [mesh](#mesh-decals),
[projected](#projected-decals) and [clipped](#clipped-decals) decals.

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
  decals of one material on the test level (Iris Xe, 1080p) add 1 draw,
  the scene pass +0.25 ms GPU and the main thread about +0.1 ms a frame.
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
- **The overlap budget:** a cell lists at most 16 decals
  ([`DECAL_CELL_BUDGET`](../reference/limits-project-model-1.md#limit-decal-cell-budget)),
  so no pixel blends more than that. Past it the
  cell keeps the highest sort orders and drops the rest there; Play
  diagnostics count the dropped entries (`renderer.projectedDecals.dropped`).
  It is a cost per spot, not a cap: a level may hold any number of decals,
  spread out.
- A decal added, removed, changed or moved rewrites only its own row of the
  decal table and the grid cells it left and entered (a few microseconds);
  the objects it may reach are looked for only near it. A still frame costs
  nothing. The whole grid is built again only when the images change (a
  page arrives, a material is edited), when a decal of a material not
  placed yet comes, or when the grid's layout cannot take a change (far
  more decals or much larger ones than it was built for): 10–20 ms for 200
  decals.
- Measured on this engine's test host (Iris Xe, 1080p, uncapped), 200
  decals spread over a test level's ground, walls and props (they reach 226
  of its 238 scene draws): the scene pass +0.6 ms GPU, the main thread
  +0.35–0.4 ms (WebGPU) and +0.45–0.6 ms (WebGL 2) a frame, 2 more shaders; table
  and grid 368 KiB. With 20 of them moving and 30 spawned a second (about
  500 in all, 30 fading at a time): the changes 0.4–0.7 ms a frame (about
  50 decals changed), the frame as with 200 still decals. Without projected
  decals: nothing.

**Moving decals.** A decal follows its object: one on a door, a cart or a
platform (a `mover`, a parent that moves, a script that moves it) marks
where the object is in every frame. Its table row and grid cells are
written again in place each frame it moves.

**Images.** Play and the export read the decal pages; the Scene view draws
each decal material's own textures (or its sheet's cell) into a small page
array of its own (512² a layer), so it shows what Play shows.

**Diagnostics.** Play's `renderer.projectedDecals`: `decals` (loaded,
spawned ones included), `drawn`, `unplaced` (an image on a page array other
than its set's: not drawn), the grid's `cells` and `entries`, `dropped` (over
the overlap budget), `builds` and `buildMs` (whole builds, the last one's
time), `updates` and `updateMs` (frames that changed decals in place, the
last one's time), `spawned` and `fading` (decals scripts spawned that are
alive, and of them fading out), `dataBytes` (table and grid),
`viewPageBytes` (the Scene view's pages) and `receiverDraws` (draws in the
last frame that blended decals). The first time a spot has more decals than
the overlap budget, Play's Problems say so (`decal_overlap`). `?decals=off`
on a Play or export URL draws without them, to see what they cost.

## Clipped decals

A decal component in `clipped` mode is drawn as a **mesh cut from the
surfaces inside its box**: their triangles clipped to the box, lifted 1 mm
off them, with the box's image coordinates. It then draws as a
[mesh decal](#mesh-decals) — its own lit colour over the surface (`blend`,
`multiply`, `add`), pushed toward the camera, before other transparent
surfaces — so it changes no receiving shader and costs no pixel of a
surface outside it. Use it for many static marks that need no per-channel
blending; use a projected decal for a wet patch, a crack in the normal
only, or a mark on terrain.

- **What it is cut from:** placed models (their base pose), boxes, block
  layers' chunks, generated architecture and spline meshes, at full detail,
  in one of the decal's layers. Not terrain (its levels of detail change the
  surface with distance: a projected decal marks it), instance sets and
  scatter copies, see-through materials or other decals.
- **Fades:** faces turned past `normalFade` from the projector are left
  out, the rest fade over its last fifth; `edgeFade` fades the mark near the
  box's ends; the component's **albedo opacity** scales the whole mark.
  `fadeDistance` and the other channels' opacities are the projected mode's.
- **Order:** the component's `sortOrder` is added to its material's.
- **When it is made:** when the scene loads, and again when a surface under
  it changes — a block chunk re-meshed, a generated object made again (a
  slider, a preset swapped by a script), a model reimported, a surface that
  moves through the box — or when the decal itself moves over them. Until
  the new mesh is in, the old one stays drawn. A decal and the surfaces it
  marks moving together (a mark parented to the cart it is on) are never
  clipped again for the motion. The component stores the projector, never
  the triangles.
- **Ready before the first frame:** a game's first picture waits for the
  start scenes' clipped decals, as it waits for their models: they are cut
  while the level's surfaces arrive, and a decal with nothing under it is
  settled as soon as every surface is in. A level without clipped decals
  does not wait. A scene loaded later (a transition, streaming) shows its
  clipped decals a moment after the scene itself.
- **On workers, cached:** each clip is a job for generated architecture's
  worker pool; a big model's vertices cross to a worker once for all the
  marks on it. A clip is kept by a hash of everything it is made from (the
  box and fades, each surface's geometry and its place relative to the
  decal, the clipper's version `DECAL_CLIP_VERSION`): in the page's memory
  (an edit, an undo or a decal realized again finds it), and in an exported
  game in the player's browser (IndexedDB, with the architecture's chunks),
  so a second visit clips nothing.
- **Drawn:** a static decal's mesh merges into the static cells — one draw
  per cell per decal material and sort order; a decal under a moving parent
  is its own draw and follows it. A static mark is lit and culled with the
  room its projector looks from (a mark across a room's outside corner is
  outside).
- **Bake to model:** the Inspector's **Bake to model** button on a
  clipped decal writes its mesh, as the Scene view clipped it, as a model
  asset (a GLB: positions, normals, texture coordinates, tangents and the
  per-vertex fade as the custom attribute `_DECAL_FADE`, which the model
  import accepts; its one material named `<decal material>_decal`), maps
  the decal material to it in the asset's materials, and puts the model on
  the decal's object in place of the decal component — four ordinary
  commands (the import's `publishAsset`, `setAssetOptions`, `setComponent`
  model, `setComponent` decal removed). The model draws as a mesh decal of
  the same material in the same place; edit the file by hand from there. It
  is no longer clipped again when the surfaces change, and the component's
  sort order is not kept (the material's applies).
- **Cost** (this engine's test host, Iris Xe, 1080p, uncapped; 1,000
  clipped decals over a test level's ground, walls and props, 881 with
  something under them, 39k triangles): 4 more draws, the scene pass
  +0.5–0.6 ms GPU on WebGPU, the main thread +0.35–0.4 ms a frame on both
  renderers; a clip 0.3 ms on average on a worker (10 ms the worst, a big
  prop); all drawn 1.3–1.4 s after the first was set, before the first
  frame, which comes about 0.9 s later than it would without them; on a
  second visit (every mesh from the browser's storage) the same. A still
  frame does no clipping work.
- **Diagnostics:** Play's `renderer.clippedDecals` — `decals`, `drawn`,
  `empty` (nothing under them), `pending`, `triangles`, `surfaces` (what
  they may be cut from), `made` (meshes clipped on a `worker` or the `page`,
  found in `memory` or the `store`), `workerMs` and `pageMs` (a clip's mean
  and worst), `readyMs` (from the first decal set to all drawn),
  `readyAfterFirstFrameMs` and `readyFrames` (the same from the first frame
  shown: negative and 0 when they were drawn before it), `firstFrameAtMs`,
  `cacheBytes` and `problems`. Performance marks `tl:decal:clip` (each
  decal's first mesh: `{decal, ms, where}`) and `tl:decal:clip-ready`.
  `?decals=off` leaves clipped decals out too.

## The Decal tool

The Scene view places decals with the **Decal tool** (the tool row's
**decal** button, or **Window → Decals**; armed while its window is open
over the Scene view, where it takes the left click from selection and the
block and terrain tools):

- **What:** a decal material, or a trim sheet's decal cell by name (picking
  a cell no decal material draws makes one, one `setMaterial`, sized at the
  sheet's texel density); the mode, the box's width, height and depth, and
  an angle about the normal.
- **Preview:** the decal under the pointer is drawn as it would be placed,
  projected or clipped, through the same path as a stored one (a clipped
  preview is cut at once; an empty result is final, not waited on).
- **Place:** a click is one `createEntity` with the decal component (one
  undo step) — the box centred on the surface point, its +Z along the
  surface normal; on a floor or ceiling the image's top points to −Z,
  elsewhere up the slope.
- **Stamp:** Shift+click adds a random turn (± the stamp turn) and size
  factor (stamp size min to max) drawn from the seed and the stamp's
  number: the same clicks with the same seed give the same decals.
- **Adjust:** the selected decal shows a ring about its normal with a turn
  knob (one `setTransform` on release, 15° steps with snapping) and a corner
  grip that scales width and height together (one `setComponent`); both
  preview while dragging, Esc drops the drag.

Its settings are remembered per browser, never in the project. A reload
leaves its window closed, so the left click selects again.

## Decals spawned by scripts

Bullet holes, footprints, tyre marks and scorch marks are left while the
game runs: a script calls

```ts
const mark = ctx.decals.spawn('scorch', { position: hit.point, normal: hit.normal, angle: 30, scale: 1.2, lifetime: 20 });
```

- **What it leaves** is a prefab's decal: the `decal` component of the
  prefab's first object that has one (a prefab may carry a decal like any
  copy component; place one in a scene, add the Decal component, make it a
  prefab). Its material, opacities, fades, sort order and layers are the
  component's; `scale` multiplies its box. Only `projected` decals spawn.
- **Where:** centred on `position` (world metres), facing out of the surface
  along `normal` (it projects back along it; absent: up), turned `angle`
  degrees about the normal. With `entityId` the position and normal are in
  that object's own space and the decal sticks to it: it moves with it and
  goes when the object goes (unloaded, destroyed).
- **How long:** `lifetime` seconds, then it fades out over
  `DECAL_TRANSIENT_FADE_SECONDS` (1 s); absent, it stays until the
  **transient budget** needs its place. `ctx.decals.remove(handle)` fades
  one out now, `ctx.decals.remove(objectId)` every decal spawned on that
  object.
- **The transient budget**, 256 decals
  ([`DECAL_TRANSIENT_BUDGET`](../reference/limits-project-model-1.md#limit-decal-transient-budget)):
  the most spawned decals kept at once. A spawn past it starts the oldest spawned
  decal fading out, so a long fight keeps the newest marks and never costs
  more than this many. Authored decals never count, and a spawn is never
  refused for it. A script may spawn at most
  `PRESENTATION_REQUESTS_PER_STEP` (32) decals in one fixed step; more return 0.
- **Presentation only.** Spawned decals are drawn by the page and never
  reach the simulation: they are not saved, not part of the run's state, and
  a replay is the same with or without them. A run restart clears them.
  The decal pages of a spawned decal's material load with its first spawn
  (a scene decal of the same material keeps them loaded).
- **Visual scripts:** the **Spawn decal** and **Remove decal** nodes.

Spawning and fading change only their own rows and cells, as moving decals
do (see what it costs above).

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
