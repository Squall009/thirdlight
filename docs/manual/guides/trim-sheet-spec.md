# Trim sheet spec: how to author a sheet that works with every kit

**Goal:** paint one trim sheet that dresses everything the engine builds —
generated rooms and buildings, block walls and floors, and the kit pieces
(doors, windows, wall pieces) you model yourself — and swaps in for any
other sheet made to the same spec. This page is the art spec: the sizes, the
rows, the maps, and how to UV a model against the rows. The editor side
(the row table, importing, checking padding) is in [Trim sheets](trim-sheets.md).

The art-factory Texture Designer lays sheets out by the same rules (its
defaults are already 2048², 512 px/m, 8 px gutters, 16 px alignment), and
its `layout.json` imports straight into a trim material's row table.

## The sheet

| | |
|---|---|
| Size | **2048 × 2048** px. Sides are powers of two (mips then halve evenly). |
| Texel density | **512 px per metre**, one density for the whole sheet. A strip is 2048 px = **4 m** across before it repeats. |
| Gutters | **8 px** above and below every row (the row table's *padding*). |
| Alignment | Every row's height is a multiple of **16 px**, and every band (8 px gutter + row + 8 px gutter) starts on a multiple of 16 px. A row's own pixels therefore start 8 px into its band. |
| Rows | Strips the full width of the sheet, top to bottom in the order below. |
| Used height | 2,000 of 2,048 px; the last 48 px are free (the decal row may spill into them). |

With these numbers the engine reads every row cleanly down to mip level 4
(a strip drawn at 1/16 of its size); past that it stops sampling coarser
mips, so very distant trims alias a little instead of bleeding into the
next row.

A 4096² sheet at 1024 px/m is the high-resolution version: the same metres,
every pixel number below doubled (gutters 16 px, alignment 32 px).

## The rows

Two kinds of row:

- **`tile_uv`, a field.** Tiles both ways: its top edge continues into its
  bottom edge, so the engine may stack it up a tall surface. Its gutters hold
  the wrap (the 8 rows above the row repeat its last 8 rows, the 8 below its
  first 8). Floors, wall faces, columns.
- **`tile_u`, a trim.** Tiles along u only: its top and bottom differ (a
  baseboard's rounded top, a frame's chamfer). Its gutters repeat its edge
  rows (the row's first pixel row 8 times above, its last 8 times below).

**Author every row at the real metre height it shows.** A 15.6 cm baseboard
is 80 px tall because 0.15625 m × 512 px/m = 80 px; it is not drawn taller
"to get more detail". The engine reads a row's metres from its pixel
height, so a part drawn at the row's metres shows the pattern at the scale
you painted.

The standard slots (slot names are exact: lower case, as written):

| Slot | Kind | Metres | Row px | Row pixels (top–bottom) | Band with gutters | v (glTF, from the top) | v (Blender, from the bottom) |
|---|---|---|---|---|---|---|---|
| `floor` | tile_uv | 1.0 | 512 | 8–520 | 0–528 | 0.00415–0.25366 | 0.74634–0.99585 |
| `upper_wall` | tile_uv | 1.0 | 512 | 536–1048 | 528–1056 | 0.26196–0.51147 | 0.48853–0.73804 |
| `lower_wall` | tile_uv | 0.5 | 256 | 1064–1320 | 1056–1328 | 0.51978–0.64429 | 0.35571–0.48022 |
| `baseboard` | tile_u | 0.15625 | 80 | 1336–1416 | 1328–1424 | 0.65259–0.69116 | 0.30884–0.34741 |
| `crown` | tile_u | 0.125 | 64 | 1432–1496 | 1424–1504 | 0.69946–0.73022 | 0.26978–0.30054 |
| `frame` | tile_u | 0.125 | 64 | 1512–1576 | 1504–1584 | 0.73853–0.76929 | 0.23071–0.26147 |
| `column` | tile_uv | 0.25 | 128 | 1592–1720 | 1584–1728 | 0.77759–0.83960 | 0.16040–0.22241 |
| `bevel` | tile_uv | 0.0625 | 32 | 1736–1768 | 1728–1776 | 0.84790–0.86304 | 0.13696–0.15210 |
| `emissive` | tile_u | 0.125 | 64 | 1784–1848 | 1776–1856 | 0.87134–0.90210 | 0.09790–0.12866 |
| `decals` | decal cells | 0.25 | 128 | 1864–1992 | 1856–2000 | (cells, see below) | |

"Row pixels" count from the image's top, bottom exclusive (row `floor` is
pixel rows 8 to 519). The v columns are the row's edges **inset by half a
texel**, the range a model's UV0 must stay inside (see
[UV a model against the rows](#uv-a-model-against-the-rows)).

**The decal row** holds square marks placed once — signs, cracks, stains —
not a strip. Cells are squares of up to 128 px (0.25 m at the sheet's
density) with 8 px gutters of their own (edges repeated), placed from the
left at x = 8 with 16 px between cells; smaller cells stack under a larger
one in its column. Decal materials draw a cell by name (see [Decals](decals.md)).

```text
 2048 px (4 m) across, every row repeats along u
+--------------------------------------------------+    0
|                                                  |
|  floor                      tile_uv  1.0 m 512px |
|                                                  |
+--------------------------------------------------+  528
|                                                  |
|  upper_wall                 tile_uv  1.0 m 512px |
|                                                  |
+--------------------------------------------------+ 1056
|  lower_wall                 tile_uv  0.5 m 256px |
+--------------------------------------------------+ 1328
|  baseboard                  tile_u 0.156 m  80px |
+--------------------------------------------------+ 1424
|  crown                      tile_u 0.125 m  64px |
+--------------------------------------------------+ 1504
|  frame                      tile_u 0.125 m  64px |
+--------------------------------------------------+ 1584
|  column                    tile_uv 0.25 m  128px |
+--------------------------------------------------+ 1728
|  bevel                    tile_uv 0.0625 m  32px |
+--------------------------------------------------+ 1776
|  emissive                   tile_u 0.125 m  64px |
+--------------------------------------------------+ 1856
| [sign ][crk][stn]  decals: cells up to 128 px    |
+--------------------------------------------------+ 2000
|  free                                            |
+--------------------------------------------------+ 2048
 each box is a band: 8 px gutter + row + 8 px gutter
```

A sheet may add rows of its own (any id, e.g. `stave`, `moss_edge`) in the
free pixels or by giving up a standard slot's space; a style or a
profile then names that slot. Keep the standard slots at the bounds above
so the sheet still swaps in for any other made to this spec.

## What reads which slot

| Slot | Generated rooms and buildings | Block layers |
|---|---|---|
| `floor` | Floors (a fill's default slot), stair treads | Tops and undersides of blocks |
| `upper_wall` | Wall faces above the dado, ceilings, vaults, roofs (the roof's default slot) | Wall faces above the layer's first storey of cells |
| `lower_wall` | Wall faces below the dado, stair risers | Wall faces of the first storey of cells |
| `baseboard` | Band profiles: baseboards, dado rails, string courses | — |
| `crown` | Cove profiles under a ceiling | — |
| `frame` | Frame profiles round doors and windows, the reveals (jambs, head, sill) of an opening, the starter rail | — |
| `column` | Shaft profiles (pilasters, columns), round profiles (pipes) | — |
| `bevel` | Wall tops and chamfers | — |
| `emissive` | Nothing by default: a profile's slot may name it for a lit-looking strip (lamps, sign bands) | — |
| `decals` | Decal materials that name a cell | — |

A block layer's wall face missing its row falls back along `lower_wall` →
`upper_wall` (or the other way round), tops along `floor` → `upper_wall` →
`lower_wall`, then the sheet's first row. A generated part whose slot the
sheet lacks is not drawn (unless its profile names a fallback slot the sheet
has), and Play's architecture problems name the row.

The trim material has no emission of its own: the `emissive` row draws only
as the colours you paint (it lights nothing and does not bloom).

How the heights meet the geometry (a sheet with **rows at their real
height** on, as new sheets and imported layouts are; see
[Trim sheets](trim-sheets.md#rows-at-their-real-height)):

- **Fields repeat at their own height.** A `tile_uv` row repeats up a
  surface from the part's lower end, and the last repeat is cut where the
  part ends — never stretched (a 3 m wall wears `upper_wall` three times; a
  0.9 m dado wears `lower_wall` once and 0.4 m of it again, under the dado
  rail). On 1 m and 0.5 m block cells and 3 m storeys the standard field
  heights divide evenly, so nothing is cut.
- **Trims are drawn once, at their own height.** A `tile_u` row on a part
  within 5 % of its height is fitted to it (a 0.15 m baseboard on the
  0.156 m row); on a shorter part the row's top shows at its painted scale,
  on a taller part the row sits at the top and its bottom edge carries on
  below. Size the parts to the rows: a style slider tied to a row (a band's
  height, a frame's width) shows the row's height and offers **Snap to row**,
  and a part that doesn't fit is listed in the sheet's problems.
- **Block walls repeat the wall rows up each face.** The mesher cuts a wall
  face where its row repeats (`lower_wall` on a 1 m first-storey cell: two
  repeats of 0.5 m), counted from the layer's row 0, so the pattern runs on
  unbroken from cell to cell.

A sheet with the option off is drawn as sheets made before it were: every
part fitted to a whole number of rows and stretched, block wall faces one
row each.

## Maps

Three textures, all 2048² with identical layouts:

| Map | Channels | Colour space |
|---|---|---|
| **Albedo + height** | RGB base colour, **A height** (0 low, 1 high, per row, using the range) | RGB sRGB, A linear |
| **Normal** | Tangent-space normal, **OpenGL convention: green up** (+Y), as glTF | linear |
| **ORM** | R ambient occlusion, G roughness, B metalness | linear |

- **Height in A** is what lets a sheet blend with other layers on a
  layered surface (moss settling into the joints instead of fading
  evenly). A sheet with an opaque A still draws, but its blends are soft;
  see [Height in alpha](height-in-alpha.md). The Texture Designer writes it
  with an albedo + height packing (`<name>_albedo_height`).
- **No lighting in the albedo.** Cavity darkening goes in the ORM's R;
  the engine adds its own vertex occlusion in corners.
- **Gutters in every map**, not only the albedo: a normal map that stops at
  the row edge shows a seam at distance just like colour does.
- Import PNGs. The project window's texture import encoding makes
  KTX2 copies that stay compressed on the GPU (*KTX2 normal map* for the
  normal map, *KTX2 data* for the ORM); see
  [Assets: KTX2 textures](../features/assets.md#ktx2-textures).

## Tiling rules

- **Along u every row tiles with the sheet's width (4 m).** The pattern's
  own repeat must divide 4 m evenly (4, 2, 1, 0.5, 0.25 m …) so the
  left edge meets the right edge without a seam. The Texture Designer fits a
  material's repeat to whole repeats across the sheet and reports the small
  scale change.
- **A `tile_uv` row also tiles in v over its own height:** its top pixel row
  continues from its bottom pixel row. Stacked courses of brick must end on
  a whole course at the row's edges.
- **A `tile_u` row never wraps in v.** Bevels, rounded edges and shading may
  differ top and bottom; the gutters repeat the edge rows, so nothing of the
  neighbouring row is ever read.
- **No feature crosses a row boundary.** Every row must read correctly on
  its own: a model or a generator may put any row next to any other.

## UV a model against the rows

Kit pieces (a door, a window, a wall piece, a corner) and models that
replace a generated segment can wear the sheet too: UV them in **strip
space**, so the same model restyles when the sheet is swapped.

- **u is metres along the part × density ÷ width:** u = metres × 512 ÷ 2048
  = **metres ÷ 4**. One metre of a frame is 0.25 of u; u may run past 1 (the
  sampler repeats it). Keep u continuous along a part so the pattern runs
  on.
- **v stays inside one row**, between the row's inset edges in the table
  (glTF v from the top; Blender's UV editor counts from the bottom, so use
  the Blender column, which the glTF exporter turns into the glTF one). The
  half-texel inset keeps filtering from reading the gutter's last pixel row
  as part of the next row. Never let a face's UVs span two rows.
- **Square texels:** the v span you give a face is its real height in
  metres ÷ the row's metres × the row's v range, for `tile_u` rows exactly
  one row tall at the row's metres (a 0.125 m frame edge spans the whole
  `frame` row). A part taller than a field row repeats the row in separate
  UV islands (a face cannot wrap inside one row).
- **Upright:** a row's top pixels go at the top of a vertical part.
- **A wall piece** (a kit model put in place of one segment of a room's
  wall) is an edge piece like any other: **one cell long along +X**, origin
  at its bottom centre. It is drawn as a block layer draws a run of edge
  pieces, one copy per cell along the segment (a 4-cell wall on 1 m cells
  takes four copies; on 2 m cells a 6 m wall takes three). A diagonal
  segment, no whole number of cells long, takes the nearest count, each
  copy scaled a little to fill it. Set **stretch** off to place one copy at
  its own size at the segment's middle, and model it at the length it will
  be used. (A raw element's override, made outside a kit, keeps the older
  rule: made 1 m long from its start and stretched to the segment.)

### Placing and naming kit pieces

- **Origin at the bottom centre.** An edge piece (a wall, door, window or
  railing on a block layer's cell edge) stands at the bottom centre of the
  edge, **+X along the edge, +Z facing across it**, +Y up. An opening's model
  (a door or window in a generated wall) stands at the opening's middle at
  its sill height, on the wall's centre line, +X along the wall and +Z to
  the right of the path's direction (inside a room drawn clockwise). In
  Blender's terms (the glTF exporter turns Blender Z up into +Y and
  Blender −Y into +Z): length along +X, up along +Z, front facing −Y.
- **Apply the transforms.** Each piece's top-level node sits at the file's
  origin with no rotation or scale: the engine keeps a node's own transform,
  so a piece modelled away from the origin draws offset.
- **Metres, sized to the grid.** One block cell is 1 m wide by default; an
  edge piece is one storey of cells tall, or a multiple; a wall or railing
  piece is one cell long (a longer wall is several copies, one per cell), a
  door or window piece a whole number of cells wide (its hole is that many
  cells).
- **Names:** `<piece>_LOD0`, `<piece>_LOD1`, `<piece>_LOD2` for the render
  levels (the engine switches below 8 % and 3 % of screen height by default)
  and `<piece>_COL` for its collision mesh (never drawn; a few boxes or
  convex parts), and optionally `<piece>_OCC` for an occluder stand-in
  (below). Several pieces may share one GLB as top-level nodes. See
  [Assets: levels of detail](../features/assets.md#levels-of-detail).
- **A triangle budget per piece**, set for the kit and kept: as a guide, a
  door or window 500–2,000 triangles at LOD0, about half at LOD1 and a
  quarter at LOD2. Fine detail goes into the sheet's normal map, not
  geometry; no hidden faces inside walls.

## Occluder stand-ins (`_OCC`)

[Occlusion culling](../features/occlusion.md) leaves out what solid
surfaces hide. A piece whose own surfaces are not solid (a hedge of leaf
cards, a window with glass) hides nothing, unless you give it a
`<piece>_OCC` node beside its `_LOD<n>` and `_COL` nodes:

- **A few boxes or slabs inside the piece**: the stand-in counts as solid
  wherever it covers, so keep it inside what really blocks the view. A
  hedge's stand-in is a box a little smaller than the hedge, not its outline.
  What is seen through the hedge's gaps or the glass where the stand-in is
  disappears: give one only where nobody looks through.
- **Inside the LOD0 surfaces**: a stand-in with a vertex more than 1 mm
  outside the LOD0 bounds, or one over a place the LOD0 triangles do not
  cover (an arch's opening, the gap between a fence's posts) or in front of
  them, seen along the axes, is ignored and named in Problems
  (`model_occluder_ignored`). A fence of posts and an open lattice get none.
- **Never drawn** in colour or shadows, and not part of the piece's bounds,
  colliders, vertex paint or generated levels; no material or UVs needed.
- **Only where it pays**: large pieces that stand between areas. A solid
  wall piece needs none, its own surfaces hide. A small prop is not worth it.

The model's import setting `occluder` (`auto`, `occ`, `none`; see
[Assets](../features/assets.md#occluder-stand-ins-_occ)) chooses between the
stand-in and the piece's own surfaces.

## Vertex colours the engine reserves

The engine reads vertex colours as data, not as a tint:

- **On a trim material** a model's `COLOR_0` is **R occlusion** (0 open,
  1 fully occluded), **G grime**, **B wetness**; A is unused.
- **On a layered surface** a model's `COLOR_0` is the layer weights:
  **R, G, B = layers 2–4**, **A = wetness**; the base layer is what R, G and
  B leave.
- **Generated architecture** keeps its own occlusion, grime and wetness in
  an attribute of its own, and **block layers** write theirs (`COLOR_0` the
  four layer weights, `COLOR_1` red the wetness). You never author those.

So **leave `COLOR_0` out of kit pieces** unless you mean it: a model with
no vertex colours reads clean, dry and unoccluded. A colour attribute left
at Blender's default white reads as fully occluded, grimy and wet on a trim
material. Paint wetness and layers in the editor's
[vertex paint editor](vertex-paint.md) instead.

## Checklist

The [kit editor](kit-editor.md) runs this list on a kit's sheet and pieces
(items 7, 8 and 10 of the sheet's are for you to check: the engine cannot
tell a normal map's convention or a channel's meaning from its pixels).

A sheet:

1. 2048 × 2048 (power-of-two sides), 512 px/m, one density.
2. The standard slots present with exactly these names, at the pixel
   bounds in the table; extra rows only in free pixels.
3. Every row's height a multiple of 16 px; every band starting on a
   multiple of 16 px; 8 px gutters above and below every row.
4. Gutters filled in all three maps: `tile_uv` rows with their wrap,
   `tile_u` rows with their edge rows repeated (the row table's
   **Check padding** passes).
5. Every row seamless along u with a repeat that divides 4 m; `tile_uv` rows
   seamless in v over their own height; nothing crosses a row boundary.
6. Albedo RGB in sRGB with no baked lighting; a real height in A (linear,
   not one value everywhere, not opaque).
7. Normal map in the OpenGL convention (green up).
8. ORM: R occlusion, G roughness, B metalness, linear.
9. The row table shows no warnings and a safe mip level of 4.
10. `layout.json` imports with no layer skipped.

A kit piece:

1. Origin at the bottom centre; +X along, +Z facing out, +Y up (glTF).
2. Top-level nodes at the file origin, transforms applied.
3. Sized in whole cells (1 m by default) and storeys.
4. `<piece>_LOD0..2` and a `<piece>_COL` present (a `<piece>_OCC` only
   where its own surfaces are not solid); triangles within the kit's budget.
5. UV0 inside the rows: u = metres ÷ 4, v within one row's inset bounds,
   no face spanning two rows.
6. No `COLOR_0` unless it carries the reserved meaning above.
