# Prefabs

A **prefab** is a saved group of objects you place many times: a lamp post,
a door with its trigger, a projectile, an enemy with its script. It is made
from objects in a scene, with their children and components.

## Copies, not links

Placing a prefab makes an **independent copy**: new objects with new ids,
which you then edit like any other objects. A prefab definition never
changes after it is made, and nothing rewrites copies already placed. There
is no apply, revert or variant: to change a prefab, make a new one from
edited objects.

Each placed object carries a [Prefab link](../reference/components-organisation.md#component-prefab)
component that says which prefab and which of its objects it came from.

What a prefab keeps: models and boxes, colliders, materials, animators,
scripts and the gameplay blocks (movers, triggers, health and so on). What
it never holds: the player controller and level wiring such as cameras,
lights and spawn points. The exact list of components a prefab may hold is
in [prefabs in the reference](../reference/content-blocks-script-libraries.md#content-prefabs).

## In the editor

- Select objects and choose **GameObject → Create prefab from selection**
  (also in the Hierarchy's right-click menu).
- The prefab appears in the Project window. Choose it to see it in the
  Inspector; **place copy** puts one copy at the scene root.
- **GameObject → Prefab copy…** opens the Project window on your prefabs.

## Through the API and in scripts

- [`createPrefab`](../reference/ops-detail.md#op-createPrefab) makes a
  prefab from objects.
- [`instantiatePrefab`](../reference/ops-detail.md#op-instantiatePrefab)
  places a copy in a scene.
- [`deletePrefab`](../reference/ops-detail.md#op-deletePrefab) deletes one.
  It is refused while anything uses it.
- A script spawns copies into the running game (never into the project)
  with [`ctx.spawn`](../reference/script-api.md#ctx-spawn) and removes
  spawned copies with [`ctx.destroy`](../reference/script-api.md#ctx-destroy).
  A new run removes every spawned copy.

A full walk-through: [make and spawn a prefab](../guides/prefabs.md).
