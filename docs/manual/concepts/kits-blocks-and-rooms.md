# Kits, blocks and rooms: what to supply

You build a 3D level from three things: **block types** painted on a grid,
**rooms and buildings** the engine generates from outlines, and the
**pieces** you model. A **kit** gathers them with one **trim sheet**, so a
level can swap its whole look by swapping the kit's sheet and presets while
its shapes stay as they are.

This page answers two questions plainly: *must I model everything, or does
Thirdlight make the basic geometry?* and *what must a trim sheet look like
to work with every kit?*

## You do not have to model walls, floors or buildings

The engine makes the structural geometry itself. You never supply a mesh
for any of this:

| The engine makes | From | Where you edit it |
|---|---|---|
| **Block shapes**: full cubes, half blocks, ramps, stairs, slabs, wall pieces on cell edges, sloped ground tops | each block type's **Collision** shape (a block type with no model draws as its shape) | the [block editor](../guides/block-editor.md): Build, Shape |
| **Walls, floors and ceilings** of rooms, with their baseboards, dado rails, crowns and other mouldings | an outline drawn on a block layer and its **preset** (a style plus slider values) | the block editor's **Rooms & buildings** |
| **Vaults, roofs and stairs** | the preset's style (vaulted ceilings) and the room's or building's settings (roof shape, storeys, stairs) | Rooms & buildings, the picked room's section |
| **Openings**: doors, windows and arches cut in the walls, with reveals, frames and panes | an opening on a wall (its place, width, sill and head) | Rooms & buildings: Door, Window, Arch |
| **Buildings**: a footprint with storeys, a facade and a roof | a building outline | Rooms & buildings: Building |
| **Interiors**: a building split into rooms and furnished by room type, or rooms drawn on their own furnished by type | the building's floor plan, or the room's type; a room program and furnishing set (the engine's starters, or graphs your game makes) | the picked building's or room's section |
| **Rails, fences and pipes** | an open path | Rooms & buildings: Path |

All of it is generated when the scene loads (on worker threads), from a
few numbers per room. The engine ships neutral starter presets (room, tall
room, hall, rail, fence, pipe) and the **Basic Kit**, so a new level never
draws grey.

## What you model

Models are for what is not a wall, a floor or a moulding: things with a
shape of their own.

| You model | Goes in kit slot | Used by |
|---|---|---|
| **Doors** | `door` | Rooms & buildings → Door: the piece stands in the opening, the hole sized to it |
| **Windows** | `window` | Rooms & buildings → Window (1 m up by default) |
| **Special wall pieces** (a fireplace, a shop front, a broken wall) | `wall-override` | Rooms & buildings → Wall piece: replaces one segment of a generated wall |
| **Corner pieces** (a column, a buttress) | `corner` | Rooms & buildings → Corner piece |
| **Railings** (balusters, a fence post) | `railing` | a path's **repeated piece**, spaced by its style |
| **Stairs and roof edges** of your own | `stairs`, `roof-edge` | kept with the kit (checked like every piece); nothing places them for you yet |
| **Props and anything else** (a lamp, a sign, a crate) | a slot of your own (e.g. `shop-sign`), or none | placed as objects, as block looks, or by scatter rules |
| **A block that is a model** (a barrel block, a bush, a statue on a cell) | none: it is a block type's **Looks** | the block editor's block type editor |

Every model is a game asset: within a triangle budget, with LOD0–2,
collision (`_COL`), baked normal maps for fine detail and compressed
textures. A kit piece also stands with its **origin at its bottom centre**,
its size a whole number of 1 m cells, its transforms applied — the kit
editor checks all of this when you drop it in. The rules and suggested
budgets are in the [trim sheet spec](../guides/trim-sheet-spec.md).

## What you paint

One **trim sheet** per kit: a 2048² texture set (albedo with height in A,
an OpenGL normal map, ORM) whose rows are strips at their real height in
metres — floor, upper wall, lower wall, baseboard, crown, frame, column,
bevel, emissive and a row of decal cells. Every generated wall, floor and
moulding reads its row from the sheet, and so do the block faces and the
kit pieces UV'd against it. A sheet made to the
[trim sheet spec](../guides/trim-sheet-spec.md) works with every kit and
every preset, which is what lets you swap one sheet for another.

Ground that is not a block — a terrain, a painted floor — wears a
**layered material**: up to four tiling textures blended by their heights
(grass, soil, rock), painted by hand or laid by rules. Block layers take the
same layered material, so a block floor and the terrain beside it match.

## Where each piece goes: the kit

A kit is one item in the project window holding:

- its **trim sheet** (one trim material);
- the **style presets** that use it;
- the **block types** its palette offers;
- the **piece slots**: door, window, wall override, corner, stairs,
  railing, roof edge and slots of your own, each holding one or more
  weighted pieces.

A kit references its parts; it does not copy them. The presets, block
types and materials stay ordinary items, and one may be in several kits.
Swapping the kit's trim sheet in the [kit editor](../guides/kit-editor.md)
re-points its presets, block types and pieces to the new sheet in one undo step.

## The workflow

1. **Start from the 3D starter** (Projects page → *3D starter*): 3D
   physics, a character with a follow camera, a block ground on the Basic
   Kit, a small terrain, a sun and sky. In another 3D project, add the kit
   with **Create → Basic Kit (ready-made)** in the project window.
2. **Make the kit yours** in the [kit editor](../guides/kit-editor.md)
   (double-click the kit): pick your trim sheet, drop your door and window
   GLBs on their slots, fix what the piece checks flag.
3. **Build the ground and walls** in the [block editor](../guides/block-editor.md)
   (double-click the block layer): pick block types from the kit's palette,
   paint floors and walls, shape slopes.
4. **Draw rooms and buildings** in its **Rooms & buildings** mode: outlines
   on the layer, doors and windows from the kit, presets with sliders.
   **Presets in use** swaps one preset for another on every room at once:
   the plan stays, the style changes.
5. **Paint** wear on the ground and walls (the block editor's Paint mode:
   the layered material's layers and wetness), or on any mesh with the
   [vertex paint editor](../guides/vertex-paint.md).
6. **Add decals** — dirt, cracks, leaks, signs — with the
   [decal editor](../guides/decals.md).

The editors share their brushes, cursor and keys: see
[Level editors](../guides/level-editors.md).

Related: [Blocks](../features/blocks.md), [Generated architecture](../features/architecture.md),
[Trim sheets](../guides/trim-sheets.md).
