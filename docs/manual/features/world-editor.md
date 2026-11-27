# The world editor: sculpt, paint, fill and read the rules of a voxel world

The world editor is the edit mode of a voxel world's ground. It works on the
live Scene view, in the same frame as every other editor (the header with
undo and **Done**, the rail on the left, the settings column on the right,
the status line with its keys). What a voxel world is: [Voxel worlds](voxel-worlds.md).

Every stroke is one `editVoxels` command, the same one a script or an AI
agent sends ([Edits: `editVoxels`](voxel-worlds.md#edits-editvoxels)), and one
step of the project's undo (Ctrl+Z takes a stroke back, Ctrl+Shift+Z puts it
back). A water body and a spline made here are one object each, made by the
command that makes any object, and one undo step too.

The rail has five parts: **Sculpt**, **Paint**, **Fill**, **Splines** and
**Rules**. Fog has a page of its own ([Fog](fog.md)), and so has what grows
on the ground ([Dressing](dressing.md)).

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

## Fog with the brush

Paint's palette lists the project's **gases** after the ground and
construction materials (materials whose voxel use is gas). Pick one and the
brush becomes the fog brush:

| Tool | Key | What a stroke does |
|---|---|---|
| **Fog** | P | Writes the picked fog into the **open cells** under the brush, at the **Density** set. Ground, walls, doorways and water under the brush stay exactly as they are; another fog there is painted over. Hold Ctrl to erase for one stroke. |
| **Erase** | E | Takes fog out of the cells under the brush: fog only, of any kind. Ground and water are left. Hold Ctrl to paint for one stroke. |
| **Smooth** | S | Evens out the picked fog's density under the brush: a bank's edge thins into the air beside it. Other fogs and the ground are left. |

- **Density**: 1 to 15, shown as a share of the material's full density (a
  cell holds fog in 16 steps; 15 is the material's own density).
- The brush sits on the cell **over** the ground under the pointer, so half
  of a ball brush reaches into the ground and writes nothing there.
- A fog brush is at most 8 m across. A wider bank is made with the Fill
  rail.
- Fog painted or erased has a hard edge; go over it with Smooth.

## Fill

The Fill rail fills the open space joined to a point, up to a level.

- **Fog** (G): pick a gas, **press** on a point in a hollow and **drag up or
  down** to set the level, then release. The ring in the view shows the level;
  the status line reads it in metres. A press and release without a drag
  fills to the **Depth** set over the point. The fog fills every open cell
  joined to that point under the level: round a rock, into a cave, never
  through ground, walls or water.
  - **Depth**: the level a click gives, over the point clicked. A drag
    changes it, and the next click starts from where the last drag ended.
  - **Fade**: the metres under the level over which the fog thins to nothing
    at the level (0: full density up to the level).
  - **Reach**: how far from the point the fill may spread, and how deep.
    The panel says the most one fill can reach (about 60 m).
- **A leak**: when the fill would pass its reach or leave the world (the
  hollow is open on one side, or the level is over its rim), **nothing is
  written**. The status line says so and red marks in the view show where
  the fill crossed its bound. Close the gap, lower the level or shorten the
  reach, and fill again. The marks go with the next fill that is taken.
- **Drain** (R): the same press and drag; fog **and water** under the level,
  joined to the point, are taken out. Water that belongs to a water body
  comes back at once: delete or lower the body instead. Fog lying on open
  ground cannot be drained (it leaks as a fill would): erase it with the fog
  brush.
- **Water** (L): pick a liquid, press on a point in a basin and drag the
  level. This makes a **water body**: an object at that point which fills the
  basin, and fills it again whenever the ground there changes, so a shore
  follows your sculpting. Its level, liquid and reach are changed in the
  Inspector after **Done** (see [water bodies](voxel-worlds.md)); where it
  leaks is marked as a fill's leak is. The editor stays open, so several can
  be made.
- When the project has no gas or no liquid material yet, the panel offers
  **Make a mist material** or **Make a water material**: a plain material
  with the next free voxel id, to change in its material editor.

A fog fill is a stroke: it does not follow later ground edits (dig the bank
away and the fog stays where it was). Fill again, or drain it first.

## How fog looks

Fog is drawn in the Scene view, in Play and in an exported game alike, in
its material's colour and full density: see-through by how much of it lies
behind each pixel, one flat colour, unlit, near the camera only. What that
looks like from outside and inside, and its limits: [Fog](fog.md#how-fog-looks).

**Fog in the view** (on the Fill panel, and on the Paint panel while a gas
is picked) switches the Scene view between **As drawn** and **Density**: every
fog face in a colour for its density (blue the thinnest, magenta half,
yellow the full density), nearly opaque, so fog too thin to see can be found
and erased. It is an editing aid of this editor: it shows while the Fill
panel or the fog brush's panel is open, and never in Play.

## Splines

**Road** (R), **Path** (P) and **River** (V) start a spline that writes
voxels. Pick the surface material (a river: the liquid), then **drag on the
ground** from where it starts to where its first stretch ends. The spline is
made as an object with those two points and its voxels section already set
(a road or path on a metre of bed; a river of the liquid), and the editor
**closes with it selected**: move, add and remove its points with its handles
in the Scene view, and set its width, bed and shoulders in the Inspector. A
click without a drag makes nothing.

## Rules

The Rules rail reads; it changes nothing. It answers "what grows here, and
why not" for the plants a material's [dressing](dressing.md) grows.

- **Read** (I): move the pointer over the ground. A small ring marks the
  cell read. **Click** to hold the read where it is (so the pointer can go
  to the column); click elsewhere to move it; Esc lets go.
- **What grows here**: the material under the pointer and its dressing,
  then every species of that dressing in order:
  - ✓ **grows**, at its full density or at a share of it, with the
    conditions that thin it there;
  - ✗ **does not grow**, with the first condition that fails and the number
    read against what the condition asks ("the slope here is 41°; it grows
    where it is at most 35°"), or "a static prop stands here";
  - a `large` species says it is stored and placed in a later phase.
  A material that names no dressing says so.
- **The ground here**: the numbers the conditions are checked against at
  that point: material, role, slope, height, open sky or under cover,
  wetness, water depth, the distance to another material and the distance
  to construction (8 m means "none within 8 m"). Read a spot where a plant
  should grow, and type what you see into the species' condition.
- **Starter ground**: while the Basic Kit's dressings have no material yet,
  buttons make a plain **grass**, **shore** or **gravel** material that
  names the kit's Meadow, Shore or Gravel. Without the kit in the project
  the panel says how to add it (Create → Basic Kit).

The rules themselves are edited on the material's **Dressing card**
(Project window → the material → Voxel use). The Scene view grows each
change at once, here too. Cover is drawn within about 40 m of where the
view looks.

The answer is the engine's own: the same check that decides where plants
are made. A script reads the same numbers with
[`ctx.voxels.surfaceAt`](../guides/voxel-scripts.md#surfaces-surfaceat).

## The same edits through the API

Every tool sends an ordinary command, which an agent sends with
`tl_command` ([Edits: `editVoxels`](voxel-worlds.md#edits-editvoxels) has
every field). Positions are **cells of 0.5 m**; a brush's `size` is in
cells, its `points` are x, y, z triples.

| Tool | Command |
|---|---|
| Add | `{"v": 3, "grid": 0, "kind": "brush", "shape": "sphere", "size": [9, 9, 9], "points": [x, y, z, …], "mode": "add", "smooth": true, "voxel": {"material": 3, "role": 1, "wetness": 0}}` (role 1: ground) |
| Dig | the same with `"mode": "dig"` and no `voxel` |
| Smooth | `"mode": "smooth"`, no `voxel` |
| Flatten | `"mode": "flatten", "height": h` (the plane's height in cells) |
| Paint | `"mode": "paint", "smooth": false, "voxel": {"material": 3, "wetness": 2}` (no `role`: every cell keeps what it is) |
| Fog fill, Drain | a `flood`: [Fog](fog.md#filling-a-hollow) |
| Fog brush | a `set`, a `dig` or a `smooth` of named cells: [Fog](fog.md#painting-fog) |
| Water | `createEntity` of an object with `waterBody: {world, level, material}` at the point |
| Road, Path, River | `createEntity` of an object with a `spline` whose `voxels` section is set |

Each is wrapped as `{"op": "editVoxels", "args": {"world": "<world>",
"command": {…}}}`. One command is one undo step (`tl_command` `undo`).

## Limits to know

- The ground changes at the release, not under the pointer while you drag.
- Fog has a plain look for now: one flat colour, unlit, near the camera
  only ([How fog looks](#how-fog-looks)).
- Wetness cannot be painted alone: a Paint stroke always writes its material
  too.
- Smooth and Flatten have no strength setting; a stroke over a place again
  goes further.
- A fog stroke changes the cells the view has loaded. Wait for the view to
  settle after a big edit before painting fog over the same place.
- A world needs at least one voxel material for ground or construction
  before Add and Paint can write. With none, the palette offers **Make a
  grass material** (a plain green ground; it names the Basic Kit's Meadow
  when the kit is in the project). Any material becomes one in its
  **Voxel use** section.
- The Rules rail reads the world's own ground. Over a structure it reads
  nothing: a structure's floors grow nothing.
