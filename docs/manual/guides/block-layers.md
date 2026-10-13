# Build a level with block layers

**Goal:** a small 3D level painted from blocks: a stone floor, a room whose
walls stand on the cell edges, a doorway, and a roof that is hidden while the
player is inside. Everything else a block layer can do (live blocks,
auto-connecting walls, wall paint, themes, kits, walking queries) is in
[Blocks](../features/blocks.md).

A block layer is one object holding a grid of cells. Each cell shows a
**block type**: a look (a model, a prefab's model or a coloured stand-in), a
collision shape and default cell data. Walls, doors and fences can stand on
the **edges** between cells instead of in them.

## In the editor

**Before you start.** The Starter is a side-on game on the 2D plane: the
player walks left and right only, and its camera looks from the side. To
walk into a room you need a 3D project (see [2D and 3D](../concepts/2d-and-3d.md)):

- Give each Starter box collider a **Half depth** (Ground, Step, Platform
  and Crate: 0.5), then **File → Project Settings… → Gameplay → Physics**
  `3D`. The switch is refused while any box collider has no depth; the
  refusal names the first one.
- Add a camera that follows the player in 3D: **GameObject → Cameras →
  Camera**, **Rig** *Follow / orbit*, **Target** the player, **Priority**
  10 (see [Cameras](cameras.md)). A steep **Pitch** (60 or more) looks
  down into rooms.
- A new layer's floor painted on row 0 stands one cell above the Starter
  ground. Set the layer's **Position** y to `-1` so the floor's top is
  level with it.

How to turn, pan and zoom the Scene view while you paint:
[Moving around the Scene view](../features/editor.md#moving-around-the-scene-view).

1. **GameObject → Block layer** makes a layer of 1 m cells and opens it in
   the **block editor** (a full-screen mode on the Scene view: its modes on
   the left — Build, Shape, Paint, Regions, Rooms & buildings, Rules —, its
   settings on the right, Done or Esc to leave). Later, double-click the
   layer in the Hierarchy, or press **Edit blocks** in its Inspector.
2. In Build's **Palette**, press **New type**: a coloured stand-in, `Block 1`
   with the id `block` (the next one `block-2`; the id never changes, and
   scripts and the API use it). The **Block type** column beside the
   palette edits the picked type: rename it `Stone`, keep **Collision**
   Full. Its **Looks** take a model (drop one, or pick it), a kit piece or a
   colour, each with a weight. Make a second type `Wall` and set
   **Placement** to **On a cell edge**. With a kit on the layer (the
   palette's picker), its block types fill the palette.
3. Pick `Stone` (or press its number), choose **Rect** (R) and drag over the
   ground: one floor row. The row the tools use where no block is under the
   pointer is the **Slice** (PageUp / PageDown; its plane and outline show
   in the view); with a block under it, an adding tool places on the face
   under the pointer.
4. Pick `Wall`, raise the slice to 1 and drag the room's outline over the
   floor with **Rect**: walls on the cell edges, one row high. For taller
   walls use **Box** (B) with **Box height** 3: it draws the outline on
   three rows in one stroke. (A second Rect stroke goes on the face under
   the pointer: drag it from one wall-top corner to the opposite one.)
5. **Erase** (X) one wall edge for a doorway, row by row. The outline under
   the pointer shows the edge it will take: the cell edge nearest the
   pointer, on the row in front of the face under it. For the bottom row
   point at the floor right next to the wall; for a higher row point at
   the wall's face at that height. **T** turns an edge piece end for end
   (0° or 180°).
6. **The roof.** Pick `Stone`, choose **Rect**, set the Slice to the row
   above the walls and drag from one wall-top corner to the opposite one.
7. **Select** (S) the roof's cells (the Slice on the roof's row). In
   **Regions**, type a name such as `room` beside **+ Region**, then press
   it: the region takes the selection. Tick **Cut away** on it: its cells
   are hidden in the game while the camera's target stands under it.
   **Preview** shows that in the Scene view.
8. Press **Done** and **▶ play**. Walk in: the roof fades out above you.

Each stroke and button is one command and one undo step (Ctrl+Z).

## Through the API

The same steps as commands (see [the request](../reference/ops.md#op-request)):

1. Block types: [`setBlockType`](../reference/ops-detail.md#op-setBlockType)
   with a [`BlockType`](../reference/types-a-d.md#type-block-type):
   `{"block": {"blockId": "stone", "name": "Stone", "shape": "full", "variants": [{"color": "#8a8a8a"}]}}`,
   and `wall` the same with `"placement": "edge"`.
2. The layer: [`createEntity`](../reference/ops-detail.md#op-createEntity)
   `{"sceneId": "scene-main", "kind": "group", "name": "Level", "components": {"blockLayer": {"cellSize": [1, 1, 1], "bounds": {"min": [0, 0, 0], "max": [32, 8, 32]}}}}`
   ([`blockLayer`](../reference/components-rendering-1.md#component-blockLayer)).
   The answer's `createdId` is the layer's id.
3. Cells, walls and a region in one
   [`editBlocks`](../reference/ops-detail.md#op-editBlocks) (one undo step;
   edits are [`BlockEdit`](../reference/types-a-d.md#type-block-edit)s, boxes
   `[x0, y0, z0, x1, y1, z1]` with the max exclusive):
   ```json
   {"entityId": "<layer>", "edits": [
     {"kind": "fill", "box": [0, 0, 0, 16, 1, 16], "cell": {"block": "stone"}},
     {"kind": "edges", "at": [4, 1, 4, 0,  4, 1, 5, 0], "edge": {"block": "wall"}},
     {"kind": "region", "regionId": "room", "op": "set", "boxes": [[4, 1, 4, 10, 3, 10]]}
   ]}
   ```
   An edge is `x, y, z, axis`: axis 0 is the cell's −x side, axis 1 its −z
   side. List every edge of the outline (a script makes the list).
4. The cut-away: [`setComponent`](../reference/ops-detail.md#op-setComponent)
   `{"entityId": "<layer>", "component": "blockLayer", "value": {"cutaway": {"regions": [{"region": "room"}]}}}`.
5. Read it back with `queryBlocks {entityId, box?}` (MCP:
   `tl_content_query target="blocks"`): the counts of cells and edges, the
   regions, and the cells in a box.

## Which to use

Paint by hand in the editor: you see the level as you shape it, and the
brushes, flood fill, stamps and the eyedropper are quicker than coordinates.
Use the API for what a program should make: a generated dungeon, a level
imported from another tool, a layout repeated many times. Both send the same
commands, so you can mix them: generate the rough layout, then finish it by
hand.

## Pitfalls

- **A new object needs a scene.** `createEntity` without `sceneId` (or a
  `parentId`) is refused with `field_missing` at `/args/sceneId`.
- **An `edges` edit with a `box` covers every edge on its outline and
  inside it**, so a box makes a room full of walls. For walls round a room,
  list the outline's edges with `at` (the editor's Rectangle does that).
- **Cells are square from above:** the cell size's x and z must be equal;
  only the height may differ. The layer is a root object at identity
  rotation and unit scale.
- **Limits per layer, not per project:** at most 1,024 × 256 × 1,024 cells
  of bounds (a larger box is refused with `limits_exceeded`), 16 layers with
  cells per scene, 256 edits and 64 KiB per `editBlocks` request. See
  [Limits](limits.md).
- **A fixed look** (Placement → Look) paints that look *pinned*: a
  connected block then stops following its neighbours.
- **Cut-aways are drawing only.** Collision, grid queries and shadows stay;
  the Scene view cuts nothing unless you press Preview. A follow camera
  with **Collision** on is pulled in under the cut roof (the roof still
  collides), so you look at the walls: turn the camera's Collision off, or
  keep its distance short enough to stay inside.
- **Painting needs the Starter in 3D for a walkable level.** On the 2D
  plane the player moves along X only and the camera looks from the side
  (see *Before you start*).
- **Lasting state of a live block goes in its cell's metadata.** A live
  block's objects are made again when their chunk reloads.

Related: [which tool for which job](which-tool.md),
[blocks on terrain](terrain.md#a-block-area-on-terrain),
[rooms and buildings on a layer](generated-architecture.md).
