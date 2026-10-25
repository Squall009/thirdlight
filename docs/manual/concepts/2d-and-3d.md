# 2D and 3D

Thirdlight always draws in 3D. What changes between a 2D and a 3D game is
the **simulation**: where things can move and collide.

Every project runs on one physics backend, Rapier 3D. "2D" is not a kind
of project: it is a **plane** a body is locked to (an axis-aligned plane,
its normal world X or Z), which a game can switch on and off at any time
(`ctx.physics.setPlane`, `ctx.character.setPlane`).

- **A scene with a default plane** (`setScenePlane {sceneId, plane:
  {axis, origin}}`): its colliders and controllers that name no `plane` of
  their own are locked to it (`plane: null` frees one), and a script's
  `{x, y}` queries run on it. A game that starts in such a scene gets the
  side-view input (`move` is a 1D axis: A/D, the arrow keys) and hears
  sounds by their distance along the plane, unless it sets its own. Use it
  for a platformer, a side-scroller, a 2.5D puzzle game.
- **A scene without one**: full 3D. Colliders have depth and any rotation,
  and there are sphere, capsule, cylinder, convex hull and mesh colliders.
  The default input moves in two axes (`move` is a 2D axis: W/A/S/D, the
  arrow keys, the left stick) and adds `run` (Shift).

A project made for the 2D plane before (the retired project setting
`physics_dimension`) is upgraded once when it opens: its scenes get the
default plane Z at 0, its 2D colliders their 3D forms 1 m deep, its
controllers the `arcade` movement profile, and Problems lists every
converted object, grouped by kind, with the field to check. Recorded step
digests and replays of such a game change once.

A 2D game is a constrained case of the same engine: the same objects,
components, scripts, cameras, UI and export. Block layers are level
geometry in both: on the 2D plane a layer collides where it crosses the
play plane (its ground, slopes, stairs and one-way ledges; see
[Blocks: Collision](../features/blocks.md#block-layers)). Terrain, scatter,
splines and generated architecture collide in 3D only.

## Starting in 3D

The **3D starter** (Projects page) is a 3D project from the first moment:
the character with a follow / orbit camera, a ground block layer on the
Basic Kit, a small terrain, a sun and a sky. Start a 3D game there rather
than switching a 2D one.

## Switching

Switch a project to 3D in the Gameplay settings. It is refused while any
box collider has no depth (its **Half depth**) or a collider is a polygon,
which only exists on the 2D plane. (The 2D starter's boxes have no depth:
give each collider a Half depth first.) A few gameplay blocks are 2D-plane only
(switches, one-way colliders). "+ Add component" offers the shapes that fit
the project's dimension.

The setting's exact values are in
[the settings in the reference](../reference/content-blocks-settings.md#content-settings);
collider shapes in [Collider](../reference/components-physics.md#component-collider)
and the character in [Player controller](../reference/components-physics.md#component-controller).
