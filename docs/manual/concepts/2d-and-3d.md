# 2D and 3D

Thirdlight always draws in 3D. What changes between a 2D and a 3D game is
the **simulation**: where things can move and collide.

The project setting **Physics** (`physics_dimension`, in
**File → Project Settings… → Gameplay**) chooses it:

- **2D plane** (the default, and what the Starter uses). Movement and
  collision happen in X and Y; colliders turn about Z only. The camera
  looks at the plane, so you get a side-on game drawn with 3D models and
  lights: a platformer, a side-scroller, a 2.5D puzzle game. The default
  input moves left and right (`move` is a 1D axis: A/D, the arrow keys).
- **3D**. Full 3D physics: colliders have depth and any rotation, and there
  are sphere, capsule, convex hull and mesh colliders. The player is a 3D
  character that walks, runs, jumps and climbs. The default input moves in
  two axes (`move` is a 2D axis: W/A/S/D, the arrow keys, the left stick)
  and adds `run` (Shift). Use it for third-person, first-person and
  top-down games.

A 2D game is a constrained case of the same engine: the same objects,
components, scripts, cameras, UI and export.

## Switching

Switch a project to 3D in the Gameplay settings. It is refused while any
box collider has no depth (its **Half depth**) or a collider is a polygon,
which only exists on the 2D plane. (The Starter's boxes have no depth yet:
give each collider a Half depth first.) A few gameplay blocks are 2D-plane only
(switches, one-way colliders). "+ Add component" offers the shapes that fit
the project's dimension.

The setting's exact values are in
[the settings in the reference](../reference/content-blocks-script-libraries.md#content-settings);
collider shapes in [Collider](../reference/components-physics.md#component-collider)
and the character in [Player controller](../reference/components-physics.md#component-controller).
