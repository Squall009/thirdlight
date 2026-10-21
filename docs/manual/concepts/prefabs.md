# Prefabs

A **prefab** is a saved group of objects you place many times: a lamp post,
a door with its trigger, a projectile, an enemy with its script. It is made
from objects in a scene, with their children and components.

## Copies, not links

Placing a prefab makes an **independent copy**: new objects with new ids,
which you then edit like any other objects. Nothing rewrites copies already
placed. To change a prefab, **apply** an edited copy (or any objects) to it:
its contents are replaced under the same id, so scripts that spawn it by
name spawn the new contents. Copies already placed or spawned keep what
they have. There is no revert or variant.

Each placed object carries a [Prefab link](../reference/components-organisation.md#component-prefab)
component that says which prefab and which of its objects it came from.

What a prefab keeps: models and boxes, colliders, materials, animators,
scripts and the gameplay blocks (movers, triggers, health and so on), and
each object's tags (its folders' tags included), so scripts find placed and
spawned copies with `ctx.tags`. What
it never holds: the player controller and level wiring such as cameras,
lights and spawn points. The exact list of components a prefab may hold is
in [prefabs in the reference](../reference/content-blocks-settings.md#content-prefabs).

## In the editor

- Select objects and choose **GameObject → Create prefab from selection**
  (also in the Hierarchy's right-click menu).
- The prefab appears in the Project window. Choose it to see it in the
  Inspector; **place copy** puts one copy at the scene root.
- **GameObject → Prefab copy…** opens the Project window on your prefabs.
- On a placed copy, the Inspector's **Apply to prefab** makes the copy (from
  its root down, as it is now) the prefab's contents. One undo puts the old
  contents back.

## Through the API and in scripts

- [`createPrefab`](../reference/ops-detail.md#op-createPrefab) makes a
  prefab from objects.
- [`instantiatePrefab`](../reference/ops-detail.md#op-instantiatePrefab)
  places a copy in a scene.
- [`updatePrefab`](../reference/ops-detail.md#op-updatePrefab) replaces a
  prefab's contents with an object and its children, keeping the id. The
  object may be a copy of that prefab: the parts it came from keep their
  local ids. It cannot hold a copy of another prefab.
- [`deletePrefab`](../reference/ops-detail.md#op-deletePrefab) deletes one.
  It is refused while anything uses it.
- A script spawns copies into the running game (never into the project)
  with [`ctx.spawn`](../reference/script-api.md#ctx-spawn) and removes
  spawned copies with [`ctx.destroy`](../reference/script-api.md#ctx-destroy).
  A new run removes every spawned copy.

A full walk-through: [make and spawn a prefab](../guides/prefabs.md).
