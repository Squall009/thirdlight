# Vertex paint

**Goal:** grime at a wall's foot, a wet patch, a tinted prop, moss weights
on a rock, painted straight onto the meshes in the Scene view. The full
description is in [Vertex paint](../features/vertex-paint.md).

## Give the object a material that reads paint

Paint changes nothing until a material reads it:

- a **standard** material: tick **Paint tint**. Paint channel A says how
  much the albedo is tinted toward the paint's RGB (A alone, RGB 0: the
  surface darkens);
- a **trim** material (generated walls): channel G is grime, B wetness;
- a **material graph**: a **Vertex colour** node set to **paint** gives the
  paint as RGBA; a **Height blend** with its weights unwired takes the paint
  as its layers' weights (see [Material graphs](material-graphs.md)).

Put it on the object: its **Materials** component (a model, an instance set,
generated architecture, a spline).

## Paint

1. **Window → Vertex paint** (or **paint** on the toolbar). The window
   floats over the Scene view; while it is open, a left drag paints.
2. Set the brush: **radius** (metres in the world), **strength** (how far
   one dab moves a vertex toward full), **falloff**, and the **channel**.
3. Drag on the object. The paint shows as you drag; the release stores
   the stroke — one undo step (Ctrl+Z).
   - On an instance set, the drag paints the copy it starts on, and only
     that copy (one draw still draws all of them).
   - On generated architecture, it paints the path nearest where it starts
     (an outline, a building, a swept element) on the side the face looks
     to; the paint stays where it is when the wall is made again (a new
     door, another storey, another preset).
4. **Erase** takes paint off the channel the same way.
5. **channel view** shows one channel as grey over the view to see faint
   paint; set it back to **off** to see the materials.

Alt+drag orbits while painting; a drag that starts on something that holds
no paint (a box, a block layer, terrain) orbits or selects as usual. Esc
drops a stroke in progress.

## Over MCP

The same stroke is one `paintVertices` command (`tl_command`): the object,
the dabs (world points) and the brush; `copy` for a copy, `path` and `side`
for generated objects. See the feature page for the arguments.

## Good to know

- Paint lands on vertices: a mesh with few vertices takes soft paint (a
  generated wall has a vertex about every metre along). Use a decal for a
  sharp mark.
- A reimport that changes a painted mesh leaves its paint undrawn and
  reported (`paint_mismatch` in Problems). A stroke over it is refused; the
  paint window offers **Remove its stale paint**, then paint again.
- Painted copies stay in their instanced draw, and painted static objects
  stay merged: painting adds no draws.
