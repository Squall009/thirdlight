# The world editor: sculpt and paint a voxel world

The world editor is the edit mode of a voxel world's ground. It works on the
live Scene view, in the same frame as every other editor (the header with
undo and **Done**, the rail on the left, the settings column on the right,
the status line with its keys). What a voxel world is: [Voxel worlds](voxel-worlds.md).

Every stroke is one `editVoxels` command, the same one a script or an AI
agent sends ([Edits: `editVoxels`](voxel-worlds.md#edits-editvoxels)), and one
step of the project's undo (Ctrl+Z takes a stroke back, Ctrl+Shift+Z puts it
back).

## Opening it

- Select the scene's **voxel world object** (the one with the `voxelWorld`
  component) and press **Edit world** in the Inspector, or double-click the
  object in the Hierarchy.
- The whole scene stays drawn (structures, props, water). The brush acts on
  the world's own ground only: over a structure the cursor goes away and a
  drag orbits. A structure's own cells are edited in its **Structure editor**
  (Hand edits), with the same brush.
- The editor opens with no tool in hand (**Navigate**: a drag orbits). Pick a
  tool or press its letter; Esc drops the tool, Esc again leaves; Space takes
  the last tool again. **Done** leaves.

## The brush

- **The cursor** is a ring on the ground at the brush's size, level, round
  the cell the stroke would start on. The size is a whole odd number of cells
  (0.5 m each), so a 4 m brush is 9 cells across.
- **A stroke**: press on the ground and drag. A line follows the dabs; the
  ground changes when you **release** (one command a stroke). Esc while
  dragging drops the stroke: nothing is changed.
- **Size**: the Brush panel, `[` and `]`, or F then a drag in the view (a
  click sets it, Esc puts it back). From 0.5 m to 32 m.
- **Spacing**: how far apart the dabs of a stroke lie, as a share of the size
  (25 % to start). A fast drag is filled in between, so it leaves no gaps.
- **Shape**: a ball, a box or a cylinder (as tall as it is wide).
- **Soft rim / Hard rim** (Sculpt): soft lets the stroke fade over the
  brush's rim, so ground joins smoothly; hard writes whole cells.

## Sculpt

| Tool | Key | What a stroke does |
|---|---|---|
| **Add** | A | Adds the picked material in front of the ground under the brush. It never replaces what is there. Hold Ctrl to dig for one stroke. |
| **Dig** | D | Takes ground (and anything else in the world's cells) out. Hold Ctrl to add for one stroke. |
| **Smooth** | S | Evens out the ground's surface under the brush, a little a stroke: go over a place again to smooth it more. Walls and floors are left as they are. |
| **Flatten** | T | Brings the ground under the brush to one height: the height of the surface where the stroke **starts**. Start on the level you want and drag over what should meet it. |

Add writes the material picked under **Adds** (the same palette as Paint's).
A ground material is added as ground, a construction material as plain wall
blocks.

## Paint

- **Material**: the project's voxel materials for ground and construction.
  Materials that stand alone are listed under **Ground** and
  **Construction**; a material that has **variants** (material instances of
  it with a voxel id of their own, see [Voxel materials](voxel-worlds.md#voxel-materials))
  is shown with them under its own name, the variants marked **V**. The
  number keys 1–9 pick a tile.
- **Wetness**: 0 (dry) to 7. Painted cells get the picked material **and**
  this wetness.
- A painted cell keeps what it is: ground stays ground, a wall a wall, water
  water. Only its material and wetness change. Air is never painted.
- **Noise mask** (its own panel): paint only where a noise pattern lets it
  through, for patches instead of a solid area. The cursor's fill shows where
  paint will land. The pattern stays put in the world, so strokes side by
  side meet without a seam.

## Limits to know

- The ground changes at the release, not under the pointer while you drag.
- Wetness cannot be painted alone: a Paint stroke always writes its material
  too.
- Smooth and Flatten have no strength setting; a stroke over a place again
  goes further.
- Liquids and gases are not in the palette: a lake is a
  [water body](voxel-worlds.md), fog comes with the fill tools.
- A world needs at least one voxel material for ground or construction
  before Add and Paint can write (a material's **Voxel** section).
