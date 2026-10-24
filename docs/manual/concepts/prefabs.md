# Prefabs

A **prefab** is a saved group of objects you place many times: a lamp post,
a door with its trigger, a projectile, an enemy with its script. It is made
from objects in a scene, with their children and components.

## Linked copies

Placing a prefab makes a **linked copy**: one object that names the prefab.
Its parts are made from the prefab whenever the scene is built (the editor,
Play, the export), with ids derived from the copy's, so editing the prefab
reaches every copy. Editing a copy's part (a colour, a position, a script
value, a child added under it, a part deleted) is kept on that copy as an
**override**: the prefab and the other copies stay as they are. A copy's
overrides can be **reverted** (one field, one part, or all) or **applied**
to the prefab (the same, plus the objects added to the copy), and a copy can
be **unpacked** into plain objects that no longer follow the prefab. A
prefab can hold linked copies of other prefabs (**nesting**), and a
**variant** is a prefab made of one linked copy of a base: it follows the
base. A prefab can never contain itself.

Each part of a copy carries a [Prefab link](../reference/components-organisation.md#component-prefab)
component that says which prefab and which of its objects it is.

What a prefab keeps: any component a scene object can carry (models and
boxes, colliders, materials, animators, scripts, the gameplay blocks, a
player controller, virtual cameras, lights, spawn points), and each
object's tags (its folders' tags included), so scripts find placed and
spawned copies with `ctx.tags`. A camera's target (any object reference)
naming an object of the prefab names that object of each copy. What it
never holds is what the scene itself keeps: a block layer's cells, an
instance set, a terrain, vertex paint, and folders. The exact list is in
[prefabs in the reference](../reference/content-blocks-settings.md#content-prefabs).

The scene's own rules hold for copies: a player character is a root object,
each copy with a controller is one more player (several players share the
view), the live camera is the enabled one with the highest priority, and a
scene's counted limits (one hemisphere light, player spawns, fog volumes)
count its copies' parts.

## In the editor

- Select objects and choose **GameObject → Create prefab from selection**
  (also in the Hierarchy's right-click menu).
- The prefab appears in the Project window. Choose it to see it in the
  Inspector; **place copy** puts one copy at the scene root.
- **GameObject → Prefab copy…** opens the Project window on your prefabs.
- Drag a prefab from the Project window into the Scene view to place a
  copy where it lands. Right-click it (or press **create variant** in its
  Inspector) for a **variant**: a new prefab made of one copy of it.
- A copy's Inspector names its prefab (a variant with its base), and marks
  the fields the copy overrides; right-click one for **Revert** or **Apply
  to prefab**. Its **Overrides** list holds every override of the copy, each
  reverted or applied (or all of them). **Open prefab** opens the prefab;
  **Unpack** makes the copy plain objects. Each is one undo step.
- The Hierarchy marks a copy's objects in the prefab colour, and a copy
  (nested ones too) shows its prefab's name.

## Through the API and in scripts

- [`createPrefab`](../reference/ops-detail.md#op-createPrefab) makes a
  prefab from objects.
- [`instantiatePrefab`](../reference/ops-detail.md#op-instantiatePrefab)
  places a copy in a scene.
- Editing a copy's part with the ordinary commands writes an override;
  [`revertPrefabOverrides`](../reference/ops-detail.md#op-revertPrefabOverrides),
  [`applyPrefabOverrides`](../reference/ops-detail.md#op-applyPrefabOverrides),
  [`unpackPrefab`](../reference/ops-detail.md#op-unpackPrefab) and
  [`createPrefabVariant`](../reference/ops-detail.md#op-createPrefabVariant)
  do the rest. Each is one undo step.
- [`updatePrefab`](../reference/ops-detail.md#op-updatePrefab) from a
  linked copy of the prefab applies all its overrides; from other objects it
  replaces the prefab's contents with them, keeping the id.
- [`deletePrefab`](../reference/ops-detail.md#op-deletePrefab) deletes one.
  It is refused while anything uses it.
- A script spawns copies into the running game (never into the project)
  with [`ctx.spawn`](../reference/script-api.md#ctx-spawn) and removes
  spawned copies with [`ctx.destroy`](../reference/script-api.md#ctx-destroy).
  A new run removes every spawned copy.

A full walk-through: [make and spawn a prefab](../guides/prefabs.md).
