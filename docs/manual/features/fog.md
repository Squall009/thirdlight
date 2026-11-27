# Fog: gas voxels

Fog, mist and smoke are **voxels**, like ground and water: cells whose role
is `gas`. A gas cell holds a material (which fog it is) and a **density** in
16 steps (0 none, 15 the material's full density). It is painted with the
voxel brush and filled to a level in the [world editor](world-editor.md),
or written with the same `editVoxels` commands over the API. A cell is
ground, water or gas, never two.

What a voxel world is: [Voxel worlds](voxel-worlds.md).

This first version of fog has a **plain look**: one flat colour, see-through
by how much of it lies behind each pixel, unlit, drawn near the camera only.
Lit fog, drifting fog and fog seen from far away come later.

## The gas material

A fog is a material whose **voxel use** is `gas` (the material Inspector's
Voxel use section; in a fresh project the world editor's Fill panel offers
**Make a mist material**). It has two fields of its own:

- **gas colour**: the fog's one colour (white when left out).
- **full density /m**: how much a cell at density 15 hides a metre (0–8;
  0.5 when left out: two metres of it hide about two thirds of what is
  behind).

Through the API it is a [`setMaterial`](../reference/ops-detail.md#op-setMaterial):

```json
{"op": "setMaterial", "args": {"material": {"materialId": "mist", "name": "Mist",
  "shader": "standard", "params": {"color": "#dfe6ea"}, "textures": {},
  "voxel": {"id": 31, "use": "gas", "gas": {"color": "#dfe6ea", "density": 0.5}}}}}
```

A gas names no kit and no dressing. Changing the colour or the density is
live: nothing is remeshed.

## Filling a hollow

**In the editor**: the world editor's **Fill** rail, **Fog** (G). Press on a
point in a hollow, drag up or down to set the level, release. The fog fills
every open cell joined to that point under the level. **Fade** thins its top;
**Reach** bounds how far it may spread. A fill that would pass its reach or
leave the world is a **leak**: nothing is written and red marks show where.
**Drain** (R) takes fog and water out the same way. The details:
[Fill](world-editor.md#fill).

**Through the API**: one `flood` stroke of
[`editVoxels`](../reference/ops-detail.md#op-editVoxels). Positions are
cells of 0.5 m; `level` is a height in cells, `reach` a distance in cells,
`fade` metres:

```json
{"op": "editVoxels", "args": {"world": "yard", "command":
  {"v": 3, "grid": 0, "kind": "flood", "seed": [40, -3, 12], "level": -1,
   "value": {"material": 31, "role": 10}, "reach": 32, "fade": 1}}}
```

A leak is refused with `flood_leaks`, and the error's `leaks` lists the
places in metres. To drain, send the same with
`"value": {"material": 0, "role": 0}` and no `fade`. One fill reaches about
60 m from its seed at most, and a fill that meets its reach is refused as a
leak: an open hollow wider than about 120 m cannot be filled yet (D850).

## Painting fog

**In the editor**: on the **Paint** rail, pick a gas in the palette and the
brush becomes the fog brush: **Fog** (P) paints it into the open cells under
the brush at the **Density** set, **Erase** (E) takes fog out, **Smooth** (S)
evens its density so an edge thins. Ground, walls and water under the brush
are never changed. The details:
[Fog with the brush](world-editor.md#fog-with-the-brush).

**Through the API**: fog is written into the cells you name. Painting is a
`set` of open cells with the gas at a density (`shape` is the density, 1 to
15); erasing is a `dig` of the gas cells; smoothing is the brush's `smooth`
mode with the gas as its `voxel`:

```json
{"v": 3, "grid": 0, "kind": "set", "cells": [10, 2, 10, 11, 2, 10, 12, 2, 10],
 "voxel": {"material": 31, "role": 10, "shape": 8, "wetness": 0}}
```

```json
{"v": 3, "grid": 0, "kind": "dig", "cells": [10, 2, 10, 11, 2, 10]}
```

```json
{"v": 3, "grid": 0, "kind": "brush", "shape": "sphere", "size": [9, 9, 9],
 "points": [11, 2, 10], "mode": "smooth", "smooth": true,
 "voxel": {"material": 31, "role": 10, "wetness": 0}}
```

A `set` writes exactly the cells it lists, whatever they held: list open
cells only (air or gas), or it replaces ground. The editor's brush reads the
cells first for that reason. A brush in `add` mode is no substitute: it
writes full density and also takes water's cells.

## How fog looks

Fog is drawn in the Scene view, in Play and in an exported game alike, in
its material's colour and full density.

- **From outside** a bank is see-through by how much of it lies behind each
  pixel: thin where it meets the ground at its edge, thick over its middle.
  A fill's fade makes its top thin.
- **From inside** the whole view is fogged: near things clearer than far
  ones, and clearer upward, where the view leaves the bank sooner.

The world editor can show fog by its density instead (**Fog in the view**:
Density), so fog too thin to see can be found and erased.

## Limits of the plain look

- **Near only.** Fog is drawn within the detail ring (about 45 m on the low
  quality level, 64 m on medium). Farther away a bank is not there, and it
  is not in the far field at all.
- **Unlit.** One flat colour: the sun, lamps and shadows do not light it. A
  pale fog stays pale at night and in a dark cave.
- **Still.** It does not drift or react to anything.
- **One density from the brush.** A painted stroke writes one density with a
  hard edge; Smooth softens it. A fill's fade is the only gradient written
  for you. A fog brush is at most 8 m across.
- **Fog standing free** (a blob in open air, not lying in a hollow or
  against a wall) looks as thick as the view behind it is far, and shows
  the cells it is made of. Fog reads best in or against something.
- **A fill does not follow the ground.** Dig the bank away later and the
  fog stays where it was. Fill again, or drain first. (A lake does follow:
  it is a water body.)
- Fog does not block light, walkers or collisions, and nothing grows or
  stops growing because of it.

## Reading fog from a script

[`ctx.voxels.surfaceAt`](../guides/voxel-scripts.md#surfaces-surfaceat)
answers the lowest bank of gas over the surface under a point: its `bottom`
and `top` (metres), mean `density` (0 to 1) and `material`. `ctx.voxels.get`
reads one cell (role 10 is gas; its shape is the density).

## Which to use

Use the editor: a bank is judged by eye, and the level gesture shows where
it will lie. Use the API to place fog from data (every hollow of a
generated map), sending a `flood` a hollow.
