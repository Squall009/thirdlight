# The kit editor

**Goal:** fill a kit — its trim sheet, its door, window and other pieces,
the presets and block types it gathers — and see at once whether every
part follows the [trim sheet spec](trim-sheet-spec.md), so the kit swaps in
for any other made to it. What a kit is: [Blocks: kits](../features/blocks.md#kits).

## Open it

Double-click a kit in the project window (or make one: **Create → Kit**, or
**Create → Basic Kit (ready-made)** for the engine's prototype kit). It
opens as a tab of the editor window, **Kit: <name>**. The picked slot's
settings and the preview are docked panels over the kit's centre (they
collapse, move to another edge or corner, and keep their layout); the
Inspector beside the window only links to them. Every change is one undo step (`setKit`, the
same command MCP sends); a GLB file you drop is imported and put in its
slot as one step too.

| Part | Where |
|---|---|
| Piece slots, Trim sheet, Picture and notes, Uses | the left side of the kit |
| The trim checker, or the spec | the centre; the panels dock over it |
| **Preview**: the piece in a sample wall | a panel (top right, open) |
| The picked slot: its pieces, Piece checks, Placement, Placed by (or a block type's summary) | one panel named after the slot ("Door slot", right edge, open) |
| The Inspector | a note and **Show the Door slot's panels**, which shows and opens that panel |

The panels work as in the level editors: [Level editors](level-editors.md#panels).

## Slots and pieces

The left column lists the **piece slots**: Door, Window, Wall override,
Corner, Stairs, Railing and Roof edge always, then slots of your own
(**Add slot**, e.g. "shop sign"; a slot of your own is kept once it holds a
piece). Each row shows its piece's picture, its file, and a state: a green
tick when its checks pass, amber when one warns, red when one fails.

- **Drop** a GLB file from your computer on a slot, or a model (or one
  piece of a multi-piece file) from the project window. Dropped on a filled
  slot it replaces the piece.
- **Click** a slot: its panel (named after it, on the right edge) shows its
  pieces, their checks, where it stands and the presets that place it; the
  **Preview** panel (top right) the piece. In the slot's panel, **Replace** or the drop zone opens a browser of
  the project's models (the project window may be hidden by the editor
  window), or **Choose a GLB…**.
- A slot can hold up to eight **variants**: add more with the drop zone,
  give each a **weight** (how often it is picked among them), pick which
  **piece of the file** it draws, remove one with ×.

## Piece checks

When a piece is set, and again whenever it or the kit changes, the backend
reads its file and checks it against the spec's kit piece checklist:

| Check | Fails when |
|---|---|
| Origin at the bottom centre | the geometry's bottom centre is more than 2 cm from the file's origin (it would draw off its cell) |
| Node transform at the file origin | a top-level node of the piece is moved, turned or scaled (apply the transforms before export) |
| Size fits the cell | it is not a whole number of 1 m cells wide (and, in an opening or on a wall's line, tall), or deeper than a cell |
| `_COL` collision present | there is no `<piece>_COL` node (players walk through it) |
| LOD 0–2 present | `<piece>_LOD1`/`_LOD2` are missing |
| UVs inside the sheet's rows | on the parts mapped to the kit's trim sheet, a triangle spans two rows or reaches a gutter |
| No vertex colours on the sheet | those parts carry `COLOR_0` (read as occlusion, grime and wetness) |

Errors are red (it draws wrong), warnings amber. A model whose materials
are not mapped to the kit's trim sheet is not UV-checked; the check offers
**Use the sheet**, which maps its trim-named material to the sheet. Pieces
that fail with an error are also listed in Problems (`tl_diagnostics`) on
the kit's line.

The **Preview** panel shows the piece where the engine would put it: in an
opening of a sample wall (a door on the floor, a window 1 m up), on the
wall's line (a wall override, a railing) or on the floor before it, the
wall and floor wearing the kit's trim sheet. **Wall**, **Room** and **Piece
alone** switch the sample. The dashed blue box is the cell it should fill,
the red box where it draws; small axes mark its file origin.

## The trim checker

The centre shows the kit's trim sheet (pick it in **Trim sheet** on the
left) with each row's bounds and gutters drawn over it, coloured by state,
the rows as a table (slot, field or trim, height, pixels), and the spec's
sheet checklist: size and texel density, gutters, the standard slots at
their pixel bounds, rows on the 16 px grid, rows reading cleanly to mip
level 4, gutters repeating their rows, no seam at the u wrap (nor the v
wrap of a field), a real height in the albedo's alpha. The pixels are read
when the kit is first opened and on **Check all**. **Trim sheet spec** (or
**Open the spec**) shows the spec page itself.

## Swap the trim sheet

**Trim sheet** on the left picks the kit's sheet from the project's trim
materials. Picking another sheet in place of one the kit had also puts it on
the kit's presets that name the old sheet, on its block types that wear
it and on its pieces whose materials are mapped to it — one undo step — so
the rooms, blocks, doors and windows built from the kit take the new sheet
and keep their shapes. A GLB you drop later is mapped with **Use the
sheet** in its piece checks. Presets and block types the kit does not
list keep theirs. To restyle the rooms themselves with other presets, use
**Presets in use** in the block editor's Rooms & buildings
([generated architecture](generated-architecture.md)).

## Picture, notes and uses

- **Picture and notes**: the kit's picture is its trim sheet's walls and
  floor unless you pick a texture of its own (**Pick a picture…**; **Use
  the sheet** goes back); the notes say what the kit is for.
- **Uses**: the style presets and block types the kit names, each with
  **Open** (a preset opens in its graph tab; a block type shows in the
  Inspector — it is edited where blocks are built) and × to take it out of
  the kit (the item itself stays). **Add …** names another.

## From an agent

The same edits are `setKit {kit}` with the whole kit (see `op.setKit`); a
sheet swap is that `setKit` plus a `graphEdit` per preset (its head node's
`sheet`), a `setBlockType` per block type and a `setAssetOptions` per piece
model (its `materials` mapping);
`tl_content_upload {addPack: "basic-kit"}` adds the Basic Kit. The checks
are `GET /api/v1/projects/<id>/kits/<kitId>/check` (`?image=1` reads the
sheet's pixels), the report the editor shows.
