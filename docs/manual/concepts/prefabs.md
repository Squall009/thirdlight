# Prefabs

A **prefab** is a saved group of objects you place many times: a lamp post,
a door with its trigger, a projectile, an enemy with its script, a player
with its camera. It is made from objects in a scene, with their children
and components, and kept as its own file (`assets/prefabs/<name>.prefab.json`).

## Linked copies

Placing a prefab makes a **linked copy**: one stored object that names the
prefab, plus its overrides. Its parts are made from the prefab whenever the
scene is built (the editor, Play, the export), so editing the prefab reaches
every copy, except what a copy overrides. The runtime only ever sees plain
objects: a linked copy costs nothing while the game runs.

A part's id is derived from the copy's id and the part's place in the
prefab, so it stays the same across prefab edits: scripts, saves and object
references that name a part keep working. Each part carries a
[Prefab link](../reference/components-organisation.md#component-prefab)
component that says which prefab and which of its objects it is.

## Overrides

An **override** is something a copy has of its own. Editing a copy's part
with the ordinary tools (a colour, a position, a script value, a component
added or removed, a child added under it, a part deleted) writes an override
on that copy; the prefab and the other copies stay as they are. The copy's
root keeps its own place, name and tags: they are never overrides, and a
prefab edit never moves a copy.

- **Marks.** The Inspector marks an overridden field with a bar in the
  prefab colour and a bold label, and its component's title with a dot.
- **The Overrides list.** A copy's Inspector header lists every override of
  the copy (behavior values and transforms included).
- **Revert** drops overrides: one field, one part, or all of the copy.
  Objects added to the copy stay (delete them as any object).
- **Apply to prefab** writes overrides into the prefab, so every copy gets
  them: one field, one part, or all. Applying all also makes the objects
  added to the copy parts of the prefab. An override inside a nested copy is
  applied to the outermost prefab, as that nested copy's override there.

Each revert or apply is one undo step. An edit a link cannot express (a part
moved to another parent or scene, a part given its own flags) is refused
with `prefab_override_unsupported`: unpack the copy, or edit the prefab.

## Prefab edit mode

A prefab opens on its own, in a full-screen edit mode: double-click it in
the Project window (or press its **open prefab**), double-click a copy in
the Hierarchy or the Scene view, or press **Open prefab** in a copy's
Inspector. Only the prefab is shown, at its root's own place, in the active
scene's look. Each change there is one command and one undo step, and every
copy follows at once, except what a copy overrides. A nested copy inside it
shows as a copy: its edits are overrides on it (double-click one of its
objects to open that prefab). The root's place, name and tags are each
copy's own, so the prefab editor refuses them. **Done** or Esc leaves.

## Nesting and variants

A prefab can hold linked copies of other prefabs (**nesting**): make a
prefab from objects that include a copy, or add a copy under a copy and
apply it. A nested copy follows its own prefab and keeps its own overrides.

A **variant** is a prefab made of one linked copy of a **base**: it follows
the base, and what it changes is that copy's overrides. A "locked door"
variant of a door changes the colour and the script value; an edit of the
door reaches both. A variant can be the base of another variant.

A prefab can never contain itself, through any chain: such a change is
refused with `prefab_cycle`.

## Unpack

**Unpack** turns a copy into plain objects with the same ids, nested copies
included. They keep how they look now and no longer follow the prefab, and
no longer count as its uses when it is deleted.

## What can be in a prefab

Anything a scene object can carry: models and boxes, colliders, materials,
animators, scripts, the gameplay blocks, a player controller, virtual
cameras, lights, spawn points, decals. Each object keeps its tags (its
folders' tags included), so scripts find placed and spawned copies with
`ctx.tags`. A component that names an object of the prefab (a camera's
target, a rail's path, a socket's model) names that object of each copy.

What stays in the scene is what the scene itself keeps: a block layer's
cells, an instance set, a terrain, vertex paint, and folders. The exact list
is in [prefabs in the reference](../reference/content-blocks-settings.md#content-prefabs).

The scene's own rules hold for copies: a player controller is a root object,
the live camera is the enabled one with the highest priority, and a scene's
counted limits (one hemisphere light, player spawns, fog volumes) count its
copies' parts, so a second copy of a hemisphere-light prefab is refused like
a second hemisphere light.

**The player prefab** is the normal pattern: a character with its controller
and a follow camera targeting it, made into one prefab. Placed twice, it is
two players, each with its own camera (several players share the view);
override the second copy's input actions so it reads its own keys.

## In the game

- A script spawns copies into the running game (never into the project)
  with [`ctx.spawn`](../reference/script-api.md#ctx-spawn) and removes them
  with [`ctx.destroy`](../reference/script-api.md#ctx-destroy). A spawn uses
  the prefab as it is assembled, nested copies and variants included, and a
  spawned prefab with a controller is one more player. A new run removes
  every spawned copy.
- A block type's look can be a prefab, a variant or a prefab with nested
  copies, drawn as assembled; a **live** block spawns that prefab in its
  cell ([blocks](../features/blocks.md)).
- A copy's parts write their block footprints like plain objects: placing,
  moving or deleting a copy, moving one of its parts, or editing the prefab
  rewrites the cells in the same undo step.
- [`ctx.decals.spawn`](../reference/script-api.md#ctx-decals) leaves a
  prefab's decal (a variant's too) on a surface.

## In the editor

- Select objects and choose **GameObject → Create prefab from selection**
  (also in the Hierarchy's right-click menu). A selection may hold copies:
  they become nested copies.
- The prefab appears in the Project window, with its model's thumbnail.
  Choose it to see it in the Inspector; **place copy** puts one copy at the
  scene root. Drag it into the Scene view to place a copy where it lands.
- **GameObject → Prefab copy…** opens the Project window on your prefabs.
- Right-click a prefab (or press **create variant** in its Inspector) for a
  variant, named "<base> Variant".
- A copy's Inspector header names its prefab (a variant with its base) and
  holds **Open prefab**, **Unpack** and the **Overrides** list; right-click a
  marked field for **Revert** or **Apply to prefab**.
- The Hierarchy tints a copy's objects in the prefab colour, and a copy
  (nested ones too) shows its prefab's name.

## Through the API and MCP

The editor and MCP send the same commands; each is one undo step.

- [`createPrefab`](../reference/ops-detail.md#op-createPrefab) makes a
  prefab from objects (linked copies among them nest).
- [`instantiatePrefab`](../reference/ops-detail.md#op-instantiatePrefab)
  places a linked copy; its result maps the parts' ids.
- Editing a copy's part with the ordinary commands (`setComponent`,
  `setBehaviorProperties`, `setTransform`, `updateEntity`, `createEntity`
  under a part, `deleteEntity` of a part) writes an override.
  `queryEntity` on a copy answers `prefabCopy`: its prefab, its overrides
  and its parts' ids.
- [`revertPrefabOverrides`](../reference/ops-detail.md#op-revertPrefabOverrides)
  and [`applyPrefabOverrides`](../reference/ops-detail.md#op-applyPrefabOverrides)
  take `{entityId, part?, path?, all?}`: `entityId` is the copy or one of its
  parts, `path` a field (`name`, `tags`, `components/<component>/<field>`),
  and the copy's root alone means all. Applying an object added to a copy,
  named alone, makes it a part (a linked copy so applied nests).
- [`unpackPrefab`](../reference/ops-detail.md#op-unpackPrefab) `{entityId}`
  and [`createPrefabVariant`](../reference/ops-detail.md#op-createPrefabVariant)
  `{basePrefabId, prefabId, displayName}`.
- [`updatePrefab`](../reference/ops-detail.md#op-updatePrefab) is kept as an
  alias: from a linked copy of the prefab it applies all its overrides; from
  other objects it replaces the prefab's contents with them, keeping the id.
- `tl_content_query` `{"target": "prefabs", "prefabId": "<id>", "stage": true}`
  returns the prefab opened on its own, as the prefab editor shows it; a
  `tl_command` that names those objects' ids changes the prefab itself.
- [`deletePrefab`](../reference/ops-detail.md#op-deletePrefab) deletes one.
  It is refused while anything uses it (a copy, a nested copy, a variant, a
  script naming its id, a block look).

## Older projects

Before schema 8 a placed copy was a set of plain objects that only
remembered its prefab. Opening such a project links them: each copy becomes
a linked copy, what it differed in is kept as overrides, its objects keep
their ids, and Problems lists, per prefab, the copies that came out with
overrides. Objects of a prefab that is gone become plain objects. The
details: [migration notes](../features/migration.md#opening-a-project-with-this-engine-schemaversion-8).

A full walk-through: [make and spawn a prefab](../guides/prefabs.md).
