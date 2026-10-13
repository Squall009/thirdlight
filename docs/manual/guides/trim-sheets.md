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
   starter layout.
2. Its Inspector has the usual values and textures and the **Trim sheet**
   table: the sheet's size in pixels, its texel density (pixels per metre
   along a strip) and **padding** (pixels above and below each row that
   repeat its edge; 8 by default), then one line per row.
3. **Equal rows** splits the sheet again; **Import layout.json** reads a
   Texture Designer trim export's table; **Check padding** compares the
   albedo's padding with each row's edge and names the row that differs.
4. Put the sheet on generated architecture: a preset's **Trim sheet**, or
   the architecture object's **Materials** slot `architecture`.

## Through the API

- The material: [`setMaterial`](../reference/ops-detail.md#op-setMaterial)
  with `shader: "trim"` and a [`TrimSheet`](../reference/types-p-u.md#type-trim-sheet):
  ```json
  {"material": {"materialId": "trim-a", "name": "Trim A", "shader": "trim", "params": {},
    "textures": {"map": "<albedo>", "normalMap": "<normal>", "ormMap": "<orm>"},
    "trim": {"size": [1024, 1024], "texelDensity": 256, "padding": 8, "rows": [
      {"slot": "floor", "top": 0, "bottom": 256}, {"slot": "lower_wall", "top": 256, "bottom": 512}]}}}
  ```
  `params` and `textures` are required (they may be empty).
- On an object: [`setComponent`](../reference/ops-detail.md#op-setComponent)
  `{"component": "materials", "value": {"architecture": "trim-a"}}`, or a
  preset graph's `sheet` (see [generated architecture](generated-architecture.md)).
- The padding check: `POST …/content/textures/trim-check {texture, trim}`.

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
- **Block walls wear one row per cell face.** Under a trim material (or a
  layered surface with a trim layer) a block layer's first storey of cells
  wears `lower_wall`, the storeys above `upper_wall`, tops and undersides
  `floor`; a row shorter than the cell is stretched up the face.
- **Decal cells take their opacity from the albedo's alpha.** A sheet a
  layered surface reads as a layer has its height there instead, so its
  cells draw opaque: each its whole rectangle on the decal pages (the Scene
  view before **Rebuild pages** still reads the sheet's alpha). Keep shaped
  marks on a sheet with opacity in alpha, or as loose decal textures.
