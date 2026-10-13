# The block editor

**Goal:** know every part of the block editor — where its modes are, what
each tool does, its keys and where a block type's settings live — so a
level goes from an empty layer to floors, walls, slopes, painted wear and
rooms without leaving it. A step-by-step first level is in
[Build a level with block layers](block-layers.md); what to model and what
the engine makes is in [Kits, blocks and rooms](../concepts/kits-blocks-and-rooms.md).

## Open it

- Double-click a block layer in the Hierarchy or the Scene view, or select
  it and press **Edit blocks** in its Inspector.
- **GameObject → Block layer** makes a new layer of 1 m cells and opens it
  (one undo takes the layer away again).
- A rooms object drawn on a layer opens its layer's editor in **Rooms &
  buildings** (**Edit in block editor** in its Inspector, or a
  double-click).

The editor takes the work area over, like the terrain editor: the header
names the layer and its size in cells, **Done** (Esc) goes back with the
selection as before. The Scene view shows only the layer and the rooms
drawn on it; **Context** (C) shows the rest of the scene, not pickable.
The rail on the left holds the modes (Shift+1 … Shift+6), the column on the
right the mode's tools and settings, the line at the bottom the tool, what
to do and its keys.

## The modes

| Mode | What it is for |
|---|---|
| **Build** | Put and take blocks: Single (Q), Line (L), Rect (R), Box (B), Flood (G), Column (U), Erase (X), Pick (I), Replace (H), Stamp (K), Paste (V), Select (S). |
| **Shape** | Slope the ground's tops with a round brush: Raise (Q), Lower (W), Smooth (E), Flatten (R). |
| **Paint** | Paint the layered material's layers and wetness on the tops and walls: Paint (B), Erase (X). |
| **Regions** | Named boxes of cells — cut-aways (a roof hidden while the player is under it), themes — and cell metadata: Region (R), Metadata (M). |
| **Rooms & buildings** | Generated rooms, paths and buildings on the layer, with the kit's doors and windows ([Generate rooms and buildings](generated-architecture.md)). |
| **Rules** | Material rules (layers laid by height, slope, noise) and scatter rules (models placed on the tops), and the Scatter brush (B). |

## The palette and the kit

Build's **Palette** shows the block types of the layer's **kit** (the
picker above it) as pictures — a model's thumbnail, or the stand-in drawn
as a small block of its shape and colour — then other types the layer's
cells hold, marked *not in the kit*. **1**–**9** pick by number; the
picker's **No kit · every type** lists the project's whole set. **New
type** makes a coloured stand-in (added to the kit); a model dropped on it
makes a type wearing that model.

The slice is the row the tools work on where no block is under the pointer:
**PageUp** / **PageDown** move it, and the view shows it as a faint plane
with an outline and a chip naming its row. With a block under the pointer,
an adding tool places on the face it points at.

## The block type editor

The type picked in the palette is edited in the column beside it (in Build
and Shape). Every setting is a control, none a JSON field, and each change
is one `setBlockType` (one undo step). The header renames, copies or deletes the type.

- **Looks**: a model (browse or drop one), a kit piece, a prefab or a
  colour; several looks with **weights** are drawn at random; texture
  coordinates from the model or in world metres.
- **Shape** (what collides): Full, Half, Ramp, Stairs, **Boxes** of your
  own as numbers, or None; **Fills the cell** (hides its neighbours'
  faces); its footprint.
- **Turns** and **Placement**: in the cell or **on a cell edge** (walls,
  doors, fences), **Blocks the way across its edge**, **Spawns its prefab
  as a live object** in the game.
- **Connections**: **Its look follows its neighbours** — alone, end,
  straight, corner, T-join, cross, base and cap pieces, each with its look
  and turn.
- **Themes** (looks swapped per region or by a script), **metadata**
  defaults and the **material** it wears.

## Brushes and keys

Shape, Paint and the Scatter brush use the shared brush kit — size,
strength, opacity, falloff, spacing and the noise mask — with the one
cursor and keys of every editor: `[` / `]` size, Shift+`[` / `]` strength,
F to resize on the surface, X to switch to the opposite tool, Ctrl held for
it for one stroke. See [Brushes](brushes.md).

Build's shape tools show a readout by the pointer while you drag
("3 × 3 m · 9 Stone · release to place"). **T** turns the brush's block (an
edge piece end for end). Select's cells can be copied, moved, mirrored,
turned, deleted or saved as a stamp.

## Paint

Paint's palette is the material the picked type wears. A layered material
shows its layers (Base, 2, 3, 4) by name and picture and **Wet**. A material
that reads no paint shows **Make it paintable**: one undo step makes a
layered material whose first layer is the old look and puts it on the
types that wore it. Painted wear is stored on the layer either way, and
rooms drawn on the layer show it on their walls.

## Through the API

Every tool sends the same command the editor does:
[`editBlocks`](../reference/ops-detail.md#op-editBlocks) for cells, edges,
regions, metadata and paint,
[`setBlockType`](../reference/ops-detail.md#op-setBlockType) for a type,
[`setComponent`](../reference/ops-detail.md#op-setComponent) `blockLayer`
for the layer's own settings (kit, themes, cut-aways, rules),
`setComponent architecture` for its rooms. Read with `queryBlocks`
(MCP: `tl_content_query target="blocks"`).

Related: [Level editors](level-editors.md), [Blocks](../features/blocks.md).
