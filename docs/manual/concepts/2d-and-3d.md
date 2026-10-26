# 2D and 3D: planes, not project kinds

Thirdlight always draws in 3D, and it always simulates in 3D: every project
and every scene runs on one physics backend, Rapier 3D. There is no 2D
project and no 3D project. "2D" is a **plane** a body is locked to, and a
game can lock and free any body at any time, mid-scene, with no reload.

## The plane

A plane is `{ axis: 'x' | 'z', origin }`: its normal is the world X or Z
axis, and `origin` is where it lies along that axis (m). Only these
axis-aligned planes exist; they cover side-scrollers and side-on stretches
of a 3D level. A body locked to one does not move along the normal and
only turns about it. Everything else is the same as in free 3D: the same
objects, components, scripts, cameras, UI and export.

A body gets its plane in one of three ways:

- **The scene's default plane** (Window → Scene settings, or
  `setScenePlane {sceneId, plane: {axis, origin} | null}`): every collider
  and player controller of the scene that names no `plane` of its own is
  locked to it. It is inherited, not copied: a new object in the scene is on
  it, and moving the scene's plane moves them all. `plane: null` on a
  collider or controller frees that one.
- **Its own `plane`** field on the `collider` or `controller` component.
- **A script**, at any step: `ctx.physics.setPlane(id, plane | null)` for
  any object with a collider or a player controller,
  `ctx.character.setPlane(id, plane | null)` for a player character (absent
  or null id: the first), `ctx.physics.planeOf(id)` to read the plane in
  effect. Visual scripts: **Set plane**, **Set character plane** (axis
  `none` frees) and **Plane of**.

**Switching.** A lock or a release takes effect at the next step boundary,
the same in the page and in the simulation worker. Locking snaps the body
onto the plane (its coordinate along the normal set to the plane's, its
rotation reduced to the turn about the normal) and drops its speed along
the normal. Freeing leaves it where it stands, free in all six degrees of
freedom. A script's plane lasts until it is changed, the object leaves the
game or the run restarts. The camera and the input are the game's: a side
view is a camera the script activates. The worked example is
[switching to a plane and back](../guides/switching-to-a-plane.md).

A game that starts in a scene with a default plane, and has no input
actions or audio setting of its own, gets the side-view defaults: `move` is
a 1D axis (A/D, the arrow keys) and sounds are heard by their distance
along the plane. Otherwise it gets the free 3D defaults (`move` a 2D axis:
W/A/S/D, the arrow keys, the left stick; `run` on Shift).

## Shapes

Every collider is a 3D shape. The flat shapes take a depth across the
plane:

- a **flat box** (a box without `hz`) is a box the collider's **Depth**
  deep (`depth`, absent: 1 m);
- a **polygon** is a prism that deep (a concave outline is split into convex
  prisms, always the same way);
- a **cylinder** is the 3D form of a circle.

Sphere, capsule, box, convex hull and mesh colliders work on and off a
plane. Terrain, block layers, scatter, splines and generated architecture
collide everywhere: a plane-locked character walks on the same collision
as a free one. Details: [Physics](../features/physics.md#one-3d-backend-planes).

**One-way** colliders (`oneWay: true`) and one-way block types hold only
from the side their local +Y faces: the player jumps up through them, lands
on top, and down + jump drops through. They work on a plane and in free 3D
alike (a one-way floor in a 3D level; turned, a one-way wall).

## Characters

The player controller has two **movement profiles**, and either works on a
plane or free: **Character** (the default: walk and run speeds, air
control, instant step-up, ledge climb) and **Arcade** (`profile: 'arcade'`:
one speed, the same acceleration in the air, a jump release that ends the
rise, autostep that rides over a step's edge). Coyote time, the jump
buffer, wall slide and wall jump, climb volumes, one-way platforms and
riding movers work in both. See
[Physics: the 3D character](../features/physics.md#the-3d-character).

## Queries

`ctx.physics.raycast` and `overlapBox` take `[x, y, z]` arrays (a world
query). Given `{x, y}` points instead, they and `overlapCircle` ask on a
plane: the one the calling script's object is locked to, else its scene's
default plane, else Z at 0. See
[Physics: queries](../features/physics.md#queries).

## Bodies outside the loaded world

With world streaming, collision is loaded only round the camera, its target
and the players. A body over ground whose collision is not loaded is
**suspended** (no gravity, movement or contacts, its state kept) and resumes
in the step that collision arrives, on a plane or free. See
[Physics](../features/physics.md#bodies-outside-the-loaded-world).

## In the editor

- **Window → Scene settings** sets the active scene's default plane (axis
  none, Z or X, and its origin along the axis): one `setScenePlane`, one
  undo.
- **The gizmo keeps a body on its plane**: an object whose collider or
  player controller is on a plane (its own or its scene's) loses the
  normal's arrow and planes in Move, and every ring but the normal's in
  Rotate; Scale stays free. Objects without a body (scenery, lights,
  markers) move freely, so background props can stand at any depth.
- The toolbar's **side view** button (shown while the active scene has a
  plane) puts the Scene view's camera on the plane's normal, level, looking
  back across it (the lens stays perspective).
- The menus and "+ Add component" offer every shape in every project: Box,
  Flat box (depth), Polygon (prism), Sphere, Capsule, Cylinder, Convex hull
  and Mesh, and GameObject → Gameplay → **One-way platform**. A flat box or
  a polygon is drawn as the solid the game makes of it.

## Starting points

The **2D starter** (Projects page) is a side-view level: a scene with a
default plane, Z at 0, its character on the arcade profile. The **3D
starter** is a free 3D scene: the character with a follow / orbit camera,
a ground block layer on the Basic Kit, a small terrain, a sun and a sky.
Either can gain the other's kind of play: give a 3D scene a side-on stretch
with `setPlane`, or free a side-view character for a 3D room.

## Older side-view projects

A project made before the one backend (the retired project setting
`physics_dimension`) is upgraded once when it opens: its scenes get the
default plane Z at 0, its flat colliders their 3D forms 1 m deep, its
controllers the arcade profile, and Problems lists what was converted,
grouped by kind, with the field to check. Its recorded step digests change
once. What to check: [Migration notes](../features/migration.md#a-side-view-project-moves-onto-planes).

Collider shapes: [Collider](../reference/components-physics.md#component-collider);
the character: [Player controller](../reference/components-physics.md#component-controller).
