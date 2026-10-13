# Trim sheets

**Goal:** one texture set whose rows are strips — floor, wall bands,
baseboards, crowns, frames — that dresses every generated wall and room, so
swapping the sheet restyles a whole level. The full description is in
[Material graphs: Trim sheets](../features/material-graphs.md#trim-sheets).
To paint a sheet that works with every kit — its size, rows, maps and how to
UV kit pieces against it — follow the [trim sheet spec](trim-sheet-spec.md).

A trim material (shader `trim`) reads three textures — albedo, normal and
ORM (occlusion, roughness, metalness) — and a **row table**: each row is a
**slot** (`floor`, `lower_wall`, `upper_wall`, `baseboard`, `crown`,
`frame`, `column`, `bevel`, `emissive` in the engine's starter layout; any
id you like) with its pixel bounds. Generated architecture draws each part
of a wall as a strip of its slot's row.

## In the editor

1. In the project window, **create → Trim sheet material**. It starts in the
   [spec](trim-sheet-spec.md)'s layout: 2048², 512 px/m, the standard rows
   at their real heights, **rows at their real height** on.
2. Its Inspector has the usual values and textures and the **Trim sheet**
   table: the sheet's size in pixels, its texel density (pixels per metre
   along a strip) and **padding** (pixels above and below each row that
   repeat its edge; 8 by default), **rows at their real height** (below),
   then one line per row.
3. **Equal rows** splits the sheet again; **Import layout.json** reads a
   Texture Designer trim export's table (rows at their real height on);
   **Check padding** compares the
   albedo's padding with each row's edge and names the row that differs.
4. Put the sheet on generated architecture: a preset's **Trim sheet**, or
   the architecture object's **Materials** slot `architecture`.

## Through the API

- The material: [`setMaterial`](../reference/ops-detail.md#op-setMaterial)
  with `shader: "trim"` and a [`TrimSheet`](../reference/types-p-u.md#type-trim-sheet):
  ```json
  {"material": {"materialId": "trim-a", "name": "Trim A", "shader": "trim", "params": {},
    "textures": {"map": "<albedo>", "normalMap": "<normal>", "ormMap": "<orm>"},
    "trim": {"size": [2048, 2048], "texelDensity": 512, "padding": 8, "realHeight": true, "rows": [
      {"slot": "floor", "top": 8, "bottom": 520, "tileV": true}, {"slot": "baseboard", "top": 1336, "bottom": 1416}]}}}
  ```
  `params` and `textures` are required (they may be empty).
- On an object: [`setComponent`](../reference/ops-detail.md#op-setComponent)
  `{"component": "materials", "value": {"architecture": "trim-a"}}`, or a
  preset graph's `sheet` (see [generated architecture](generated-architecture.md)).
- The padding check: `POST …/content/textures/trim-check {texture, trim}`.

## Rows at their real height

With **rows at their real height** on (`realHeight: true`; new sheets and
imported layouts), every row is drawn at its own height in metres — its
pixel height over the texel density:

- A row that **tiles in v** (a field: floor, walls, columns) repeats up a
  surface at that height from the part's lower end, the last repeat cut
  where the part ends (a 2.1 m wall on a 1 m row: two repeats and 0.1 m of a
  third). Block walls repeat it too: the mesher cuts each wall face where the
  row repeats.
- A row that does not (a trim: baseboard, crown, frame) is drawn once. A part
  within 5 % of the row's height has the row fitted to it; a shorter part
  shows the row's top at its painted scale, a taller one the row at its
  painted scale at the top and its bottom edge carried on below. Curved
  mouldings (a cove) have their row fitted round the curve.
- A preset slider that sets a trim's size (a band's height, a frame's width)
  shows the row's height under it and offers **Snap to row**; a value that
  does not fit is listed in the trim material's problems (Problems tab,
  `tl_diagnostics`) with both heights.

Off (absent: sheets made before the option), each part is fitted to a whole
number of rows and stretched, as before. Turning it on changes how those
sheets' walls look, so it stays off until you tick it.

## Which to use

Make and lay out the sheet in the editor: the table shows each row's height
in metres and the deepest mip level it reads cleanly, and warns about thin
padding. Use the API to import a layout you keep with the texture source.

## Pitfalls

- **Give the sheet every slot your presets use.** A missing row is listed in
  Play's architecture problems (`renderer.architecture.problems`, e.g.
  *its sheet has no row "baseboard"*).
- **Padding stops bleeding.** Without it, distant strips read their
  neighbours' pixels; the material also caps each read at the sheet's safe
  mip level, so far trims alias a little instead.
- **Rows may not overlap**; a table the model refuses is not saved.
- **No lightmaps:** trim surfaces are lit by probes and the generator's
  vertex occlusion.
- **Sheets are textures:** at most 4,096 px a side.
- **Two sheets on one layered surface share one row table.** Sheets from
  different layouts disagree on some rows (a problem lists them): delete the
  rows the walls don't use from both tables (**delete row**) so the rest
  match.
- **Block walls wear the wall rows.** Under a trim material (or a layered
  surface with a trim layer) a block layer's first storey of cells wears
  `lower_wall`, the storeys above `upper_wall`, tops and undersides `floor`.
  Rows at their real height repeat up each face; otherwise a row shorter
  than the cell is stretched up the face once.
- **Decal cells take their opacity from the albedo's alpha.** A sheet a
  layered surface reads as a layer has its height there instead, so its
  cells draw opaque: each its whole rectangle on the decal pages (the Scene
  view before **Rebuild pages** still reads the sheet's alpha). Keep shaped
  marks on a sheet with opacity in alpha, or as loose decal textures.
