# Interiors with a follow camera

**Goal:** a two-storey building the player walks through and climbs, seen
from above by a follow camera, where the roof is hidden while the player is
inside and the walls on the camera's side thin to a dither round the
player, so doorways and rooms stay readable. Three features work together:

- a **follow camera** ([Cameras](cameras.md)) frames the player;
- a **cut-away** on the building's block layer
  ([Blocks](../features/blocks.md#block-layers)) hides whole zones, the roof
  and the storey above, while the player is under them;
- **see-through** ([Rendering](../features/rendering.md#see-through)) thins
  what is left between the camera and the player (a wall in front, a pillar,
  the slab of the storey above on the stairs) in a soft circle, never the
  floor the player stands on.

## In the editor

1. **The building.** Make the project from the **3D starter** and paint the
   ground floor as in [the block layers guide](block-layers.md) (floor,
   walls on the cell edges, a doorway). Paint the upper floor's slab on the
   row above the walls, its walls on the rows above that, stairs between the
   two, and a roof on top. (Generated rooms work the same: see
   [Generate rooms and buildings](generated-architecture.md); a room's
   upper storey is the region `<room>-s1`.)
2. **The camera.** Select the starter's follow camera and set **Pitch** 50,
   **Distance** 12 and **Target offset** 0, 1, 0. Turn **Collision** off:
   with it on, the camera is pulled in under the roof (the roof still
   collides) and you look at the walls from inside.
3. **The roof cut-away.** In the block editor **Select** (S) the roof's
   cells, make a region `roof` in **Regions** and tick **Cut away**: the
   roof is hidden while the player stands under it. **Preview** shows it in
   the Scene view. For the upper storey while the player is downstairs, the
   layer's **Cut-away** in the Inspector also takes a plane: the row of the
   upper floor's walls hides every cell from there up while the player is
   below it.
4. **See-through.** Project Settings → Quality → Rendering → **See-through**
   On. The defaults fit a follow camera (a circle a fifth of the view's
   height, thinning to a 75 % dither); raise **See-through radius** for
   larger rooms.
5. **Look at it while you build.** Select the player and press the Scene
   view's **see-through** toolbar switch: everything between the Scene
   view's camera and the player dithers round them. Move the view round the
   building to check the doorways read.
6. **Opt out** what must stay solid (a sign, a glass case): select it and
   untick **See-through** in its Box, Model or Instance set section. A
   scatter rule has the same toggle on its card.
7. **▶ play.** Walk in: the roof goes, the wall between the camera and the
   player dithers inside the circle, the floor and the low furniture round
   the player stay solid. Climb the stairs: the slab of the upper floor
   above you fades; once you are up, the slab under your feet stays solid
   and the roof above is the one that is cut.

**Only indoors.** A game that wants see-through only inside keeps the
setting on (so nothing is built in the middle of the game) and switches it
from a script. On the player (see [scripts](scripts.md)):

```ts
import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  layer: property.entityRef(null, { tooltip: 'The building\'s block layer' }),
  region: property.string('house'),
};

interface State { inside: boolean | null }

export default {
  instantiate(): State {
    return { inside: null };
  },
  step(state: State, ctx: BehaviorContext): void {
    const layer = ctx.properties.layer as string | null;
    const at = ctx.world.worldTransform(ctx.entityId)?.position;
    if (!layer || !at || !ctx.grid || !ctx.camera) return;
    const cell = ctx.grid.worldToCell(layer, at);
    const inside = cell !== null && ctx.grid.inRegion(layer, ctx.properties.region as string, cell.x, cell.y, cell.z);
    if (inside === state.inside) return;
    state.inside = inside;
    ctx.camera.setSeeThrough({ enabled: inside });
  },
};
```

Make a region `house` over the whole building (it needs no cut-away) and
pick the layer in the script's **Layer** property. The first step turns it
off outside; the fade time eases each switch.

## Through the API

1. The building: the commands of [the block layers guide](block-layers.md#through-the-api)
   (one [`editBlocks`](../reference/ops-detail.md#op-editBlocks) per storey:
   `fill` for floors, `edges` for walls, a `region` for the roof).
2. The camera ([`setComponent`](../reference/ops-detail.md#op-setComponent)):
   `{"entityId": "<follow camera>", "component": "virtualCamera", "value": {"pitch": 50, "distance": 12, "targetOffset": [0, 1, 0], "collision": false}}`.
3. The cut-aways: `{"entityId": "<layer>", "component": "blockLayer", "value": {"cutaway": {"regions": [{"region": "roof"}], "planes": [<upper floor's wall row>]}}}`.
4. See-through ([`setSettings`](../reference/ops-detail.md#op-setSettings)):
   `{"settings": {"see_through": 1, "see_through_radius": 0.25}}`
   ([the settings](../reference/content-blocks-settings.md#content-settings)).
5. An object that stays solid: `{"entityId": "<sign>", "component": "model", "value": {"seeThrough": false}}`
   (`box`, `instances`, `blockLayer`, `terrain` and `architecture` take the
   same field; a scatter rule takes it in the rule).
6. Play and check: send movement as test input to walk the player through
   the doorway and up the stairs, and take a screenshot at each stage.
   `tl_game_observe` shows `camera.seeThrough` once a script has called
   `setSeeThrough`.

## Which to use

Cut-aways for what should be gone (a roof, a whole storey): they are cheap
(a cut zone is not drawn) and take whole regions. See-through for what is
in the way only from where the camera stands: the walls on the camera's side,
pillars, trees outside; it needs no regions and follows the player and the
camera everywhere. Use both for interiors. Build the building and switch
features in the editor, where you see the result; use the API to set up many
levels the same way.

## Pitfalls

- **Nothing fades without a subject.** The default subject is the live
  camera's target: a camera without a target fades nothing. Name subjects
  with `ctx.camera.setSeeThrough({subjects: [...]})`; each view fades round
  the 4 nearest the camera, and Problems says when more were asked for.
- **Low things never fade**, by design: only what is higher than half the
  subject's height above its feet. A low wall in front of a short subject
  stays solid.
- **Turning see-through on from a script with the setting off** rebuilds
  every shader in the middle of the game (a held picture of about half a
  second, and a `see_through_rebuild` Problems line). Keep the setting on
  and switch it off from a script instead.
- **A dither, never gone.** Two faded walls in a row still hide what is
  behind them as much as one: the fades share one pattern. Cut the farther
  one away if the room behind must show.
- **Shadows stay.** A faded wall still casts its shadow into the room.
- **Cost.** On a large two-storey interior see-through costs about 1 ms GPU
  on an integrated GPU (see [Rendering](../features/rendering.md#see-through)).

Related: [cameras](cameras.md), [block layers](block-layers.md),
[generated architecture](generated-architecture.md).
