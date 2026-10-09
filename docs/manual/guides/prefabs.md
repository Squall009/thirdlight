# Make and spawn a prefab

**Goal:** a barrel made once, placed twice in the scene by hand, and spawned
by a script every half second while the game runs, with the oldest copies
removed. What a prefab is: [Prefabs (concept)](../concepts/prefabs.md).
Everything a spawned copy can do: [Spawning prefabs from scripts](../features/scripting.md#spawning-prefabs-from-scripts).

A prefab is a saved group of objects. Placing it makes an independent copy;
the prefab itself never changes after it is made.

## In the editor

1. Make the object: **GameObject → Box**, name it `Barrel`, give it a size
   and a colour, and **+ Add component → Collider**. Children come along, so
   a prefab can be a whole group.
2. Select it and choose **GameObject → Create prefab from selection** (also
   in the Hierarchy's right-click menu). Name it. The prefab is now in the
   project window (`t:prefab`).
3. Choose the prefab in the project window. Its Inspector has **place
   copy**: each press puts one copy at the scene root. Move the copies like
   any object.
4. For spawning, write a script (see [the script guide](scripts.md)) that
   calls `ctx.spawn`, and put it on an object (step 3 below shows one).
5. Press **▶ play**.

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

## Which to use

Make prefabs in the editor: you see what goes in. Place hand-picked copies
in the editor too. Use the API to place many copies from data (a level
file, a generator); for hundreds of identical props without scripts or
colliders, an [instance set](instance-sets.md) is cheaper. Spawning is
always a script's job.

## Pitfalls

- **A copy is not linked.** Editing the prefab is not possible, and editing
  a copy changes only that copy. To change all of them, make a new prefab
  and place it again.
- **A prefab never holds the player controller, cameras, lights or spawn
  points.** The exact list: [content.prefabs](../reference/content-blocks-save-schema.md#content-prefabs).
- **Spawned copies are the game's, not the project's.** They are gone when
  the run restarts, and a save keeps them only when its schema has the
  `spawned` section. `ctx.destroy` removes spawned copies only.
- **A box collider is static.** A spawned copy with only a collider stays
  where it appears. To move it, give it a mover or a script that owns its
  transform (`"@self"` in the script's owned transforms).
- **`ctx.spawn` takes effect at the next step** and returns `null` at an
  engine limit (64 spawns a step, 16,384 alive).
- **A prefab in use cannot be deleted.** `deletePrefab` is refused with
  `reference_in_use` while a placed copy has its link or a script names its
  id as a string (`ctx.spawn("barrel")`); the refusal lists the uses.

Related: [scripts](scripts.md), [instance sets](instance-sets.md),
[which tool for which job](which-tool.md).
