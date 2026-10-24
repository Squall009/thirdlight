# Make and spawn a prefab

**Goal:** a barrel made once, placed twice in the scene by hand, and spawned
by a script every half second while the game runs, with the oldest copies
removed; then one copy overridden, the prefab edited, a variant and a nested
prefab. What a prefab is: [Prefabs (concept)](../concepts/prefabs.md).
Everything a spawned copy can do: [Spawning prefabs from scripts](../features/scripting.md#spawning-prefabs-from-scripts).

A prefab is a saved group of objects. Placing it makes a linked copy: an
edit of the prefab reaches every copy, except what a copy overrides.

## In the editor

1. Make the object: **GameObject → Box**, name it `Barrel`, give it a size
   and a colour, and **+ Add component → Collider: Box**. The collider
   starts at half sizes of 0.5 m, not the box's: set its **Half width**,
   **Half height** and (in a 3D project) **Half depth** to half the box's
   size. Children come along, so a prefab can be a whole group.
2. Select it and choose **GameObject → Create prefab from selection** (also
   in the Hierarchy's right-click menu). The prefab is made at once, named
   after the object. It is in the project window under `t:prefab` (or the
   `assets/prefabs` folder; **All assets** with *any kind* lists asset
   files only).
3. Choose the prefab in the project window. Its Inspector shows its **id**
   (generated, for example `prefab-7902b2e2c166558e`): a script spawns the
   prefab by this id. **place copy** puts one copy where the source object
   stood, at the scene root, each press. Move the copies like any object.
4. For spawning, write a script (see [the script guide](scripts.md)) that
   calls `ctx.spawn` with the id from step 3, and put it on an object (step
   4 of the API path shows one).
5. Press **▶ play**.
6. **Override one copy.** Select a copy and change its colour in the
   Inspector. The field gets a bar in the prefab colour and a bold label:
   it is that copy's override. The other copy and the prefab keep theirs.
7. **Edit the prefab.** Double-click a copy (or the prefab in the project
   window, or press **Open prefab** in a copy's Inspector). The prefab
   editor shows the prefab alone; pick an object in its column and change
   it in the Inspector (say its size). Every copy follows at once, except
   what a copy overrides: the recoloured copy keeps its colour and takes the
   new size. The root's place, name and tags stay each copy's own. **Done**
   or Esc goes back to the scene.
8. **Revert or apply.** The copy's **Overrides** list (in its Inspector
   header) holds every override; revert or apply each, or all. Right-click a
   marked field for the same on one field. **Apply to prefab** writes it
   into the prefab: every copy and every `ctx.spawn` from the next Play use
   it.
9. **A variant.** Right-click the prefab in the project window and choose
   **Create variant** ("Barrel Variant"). Open the variant and change its
   colour: that is the variant's own; an edit of the barrel still reaches
   it.
10. **Nesting.** Place a copy of another prefab (a lid) and make it a child
    of a barrel copy (drag it onto the copy in the Hierarchy), then press
    **Apply all** in that copy's Overrides list: the lid is now a nested
    copy in the barrel prefab, on every barrel, following the lid prefab.
    Making a prefab from a selection that holds copies nests them too.
11. **Unpack** (a copy's Inspector) turns a copy back into plain objects
    with the same ids, for when you want it to stop following the prefab.

## Through the API

1. The object ([`createEntity`](../reference/ops-detail.md#op-createEntity)):
   `{"sceneId": "scene-main", "kind": "box", "name": "Barrel", "transform": {"position": [0, 3, 0]}, "box": {"size": [0.6, 0.8, 0.6], "material": {"color": "#a0522d"}}, "components": {"collider": {"shape": {"type": "box", "hx": 0.3, "hy": 0.4}}}}`.
   The answer's `createdId` is its id.
2. The prefab ([`createPrefab`](../reference/ops-detail.md#op-createPrefab)):
   `{"prefabId": "barrel", "displayName": "Barrel", "sourceEntityId": "<the box>"}`.
3. Copies in the scene ([`instantiatePrefab`](../reference/ops-detail.md#op-instantiatePrefab)):
   `{"prefabId": "barrel", "sceneId": "scene-main", "transform": {"position": [10, 0.4, 0]}}`.
   Each copy carries a [Prefab link](../reference/components-organisation.md#component-prefab).
4. A spawner script ([`ctx.spawn`](../reference/script-api.md#ctx-spawn),
   [`ctx.destroy`](../reference/script-api.md#ctx-destroy)), published as in
   [the script guide](scripts.md#through-the-api) and put on an empty object
   with [`setBehaviorProperties`](../reference/ops-detail.md#op-setBehaviorProperties):
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export const properties = {
     prefab: property.string('barrel'),
     every: property.number(1, { min: 0.1, max: 60 }),
     keep: property.number(3, { min: 1, max: 32, step: 1 }),
   };

   interface State { alive: string[] }

   export default {
     instantiate(): State {
       return { alive: [] };
     },
     step(state: State, ctx: BehaviorContext): void {
       ctx.timers.every('spawn', ctx.properties.every as number);
       if (!ctx.timers.fired('spawn')) return;
       const id = ctx.spawn(ctx.properties.prefab as string, { position: [ctx.random.range(0, 16), 4] });
       if (id !== null) state.alive.push(id);
       while (state.alive.length > (ctx.properties.keep as number)) ctx.destroy(state.alive.shift()!);
     },
   };
   ```
5. Play and look: the observation's `spawned` lists the live copies
   (`{count, ids}`).
6. Override a copy: any ordinary command on its parts, for example
   [`setComponent`](../reference/ops-detail.md#op-setComponent)
   `{"entityId": "<a copy>", "component": "box", "value": {"material": {"color": "#ff0000"}}}`.
   `queryEntity` on the copy answers `prefabCopy` with its overrides.
7. Edit the prefab: `tl_content_query`
   `{"target": "prefabs", "prefabId": "barrel", "stage": true}` returns the
   prefab opened on its own; a `tl_command` that names those objects' ids
   changes the prefab, and every copy follows except what it overrides.
8. Revert or apply ([`revertPrefabOverrides`](../reference/ops-detail.md#op-revertPrefabOverrides),
   [`applyPrefabOverrides`](../reference/ops-detail.md#op-applyPrefabOverrides)):
   `{"entityId": "<the copy>", "path": "components/box/material/color"}` for
   one field, `{"entityId": "<the copy>", "all": true}` for all.
9. A variant ([`createPrefabVariant`](../reference/ops-detail.md#op-createPrefabVariant)):
   `{"basePrefabId": "barrel", "prefabId": "red-barrel", "displayName": "Red barrel"}`.
10. Nesting: place a lid copy under a barrel copy
    (`instantiatePrefab {"prefabId": "lid", "sceneId": "scene-main", "parentId": "<a barrel copy>"}`),
    then `applyPrefabOverrides {"entityId": "<the lid copy>"}`: it becomes a
    nested copy in the barrel prefab.
11. [`unpackPrefab`](../reference/ops-detail.md#op-unpackPrefab)
    `{"entityId": "<a copy>"}` makes a copy plain objects (ids kept).

## Which to use

Make prefabs in the editor: you see what goes in. Place hand-picked copies
in the editor too. Use the API to place many copies from data (a level
file, a generator); for hundreds of identical props without scripts or
colliders, an [instance set](instance-sets.md) is cheaper. Spawning is
always a script's job.

## Pitfalls

- **An edit of a copy is that copy's override.** Its Inspector marks it;
  right-click it, or use the **Overrides** list, for **Apply to prefab** (MCP: [`applyPrefabOverrides`](../reference/ops-detail.md#op-applyPrefabOverrides)
  `{"entityId": "<the copy>", "all": true}`, or `updatePrefab`
  `{"prefabId": "barrel", "fromEntity": "<the copy>"}`) writes it into the
  prefab: every copy and every `ctx.spawn("barrel")` from the next Play
  use it. [`revertPrefabOverrides`](../reference/ops-detail.md#op-revertPrefabOverrides)
  drops it instead.
- **Some edits a link cannot hold.** Moving a copy's part to another
  parent or scene, or giving a part its own flags, is refused
  (`prefab_override_unsupported`): unpack the copy, or edit the prefab. A
  copy's root place, name and tags are always its own, so the prefab editor
  refuses them.
- **A player is a prefab.** A character with its controller and a follow
  camera targeting it, made into a prefab, placed twice, is two players,
  each with its own camera; override the second copy's `moveAction` and
  `jumpAction` so it reads its own input. A prefab never holds what the
  scene keeps (block layers, instance sets, terrains, vertex paint,
  folders). The exact list: [content.prefabs](../reference/content-blocks-settings.md#content-prefabs).
- **Spawned copies are the game's, not the project's.** They are gone when
  the run restarts, and a save keeps them only when its schema has the
  `spawned` section. `ctx.destroy` removes spawned copies only.
- **A box collider is static.** A spawned copy with only a collider stays
  where it appears. To move it, give it a mover or a script that owns its
  transform (`"@self"` in the script's owned transforms).
- **`ctx.spawn` takes effect at the next step** and returns `null` at an
  engine limit (64 spawns a step, 16,384 alive).
- **A prefab in use cannot be deleted.** `deletePrefab` is refused with
  `reference_in_use` while a copy links it (placed, nested in another
  prefab, or as a variant's base), a block look uses it, or a script names
  its id as a string (`ctx.spawn("barrel")`); the refusal lists the uses.
  Unpacked copies no longer count.
- **Projects from before schema 8** open with their copies linked and
  their differences kept as overrides; Problems names, per prefab, the
  copies that came out with overrides
  ([migration notes](../features/migration.md#opening-a-project-with-this-engine-schemaversion-8)).

Related: [scripts](scripts.md), [instance sets](instance-sets.md),
[which tool for which job](which-tool.md).
