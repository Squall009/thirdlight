# Build a level with block layers

**Goal:** a small 3D level painted from blocks: a stone floor, a room whose
walls stand on the cell edges, a doorway, and a roof that is hidden while the
player is inside. Everything else a block layer can do (live blocks,
auto-connecting walls, wall paint, kits, walking queries) is in
[Blocks](../features/blocks.md).

A block layer is one object holding a grid of cells. Each cell shows a
**block type**: a look (a model, a prefab's model or a coloured stand-in), a
collision shape and default cell data. Walls, doors and fences can stand on
the **edges** between cells instead of in them.

## In the editor

1. **GameObject → Block layer** makes a layer of 1 m cells and selects it.
   Its Inspector shows the layer's fields, then the block tools.
2. In **Palette**, press **+ Block type**. Name it `Stone`, keep the shape
   `full` and pick a colour for the stand-in (or a model). Make a second type
   `Wall` and set **Placement** to **Edge**.
3. Tick **Edit cells**. Pick `Stone`, choose **Rectangle** and drag over the
   ground: one floor row. The row the tools use where no block is under the
   pointer is the **Slice** (PageUp / PageDown).
4. Pick `Wall`. With an edge piece as the brush, **Rectangle** draws the
   edges of its outline: drag the room's outline one row above the floor.
   Raise the slice a row and drag again for a taller wall. **Erase** on one
   edge leaves a doorway.
5. **Select** the room's cells and press **+ Region** (it takes the
   selection), then **Cut** on the region: its cells are hidden in the game
   while the camera's target stands under it. **Preview** shows that in the
   Scene view.
6. Press **▶ play** and walk in.

Each stroke and button is one command and one undo step (Ctrl+Z).

## Through the API

The same steps as commands (see [the request](../reference/ops.md#op-request)):

1. Block types: [`setBlockType`](../reference/ops-detail.md#op-setBlockType)
   with a [`BlockType`](../reference/types-a-d.md#type-block-type):
   `{"block": {"blockId": "stone", "name": "Stone", "shape": "full", "variants": [{"color": "#8a8a8a"}]}}`,
   and `wall` the same with `"placement": "edge"`.
2. The layer: [`createEntity`](../reference/ops-detail.md#op-createEntity)
   `{"sceneId": "scene-main", "kind": "group", "name": "Level", "components": {"blockLayer": {"cellSize": [1, 1, 1], "bounds": {"min": [0, 0, 0], "max": [32, 8, 32]}}}}`
   ([`blockLayer`](../reference/components-rendering.md#component-blockLayer)).
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
- **Random look** off paints the chosen look *pinned*: a connected block
  then stops following its neighbours.
- **Cut-aways are drawing only.** Collision, grid queries and shadows stay;
  the Scene view cuts nothing unless you press Preview.
- **Lasting state of a live block goes in its cell's metadata.** A live
  block's objects are made again when their chunk reloads.

Related: [which tool for which job](which-tool.md),
[blocks on terrain](terrain.md#a-block-area-on-terrain),
[rooms and buildings on a layer](generated-architecture.md).
