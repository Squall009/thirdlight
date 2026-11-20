# Script a voxel world (`ctx.voxels`)

**Goal:** a script that reads, digs, builds and paints a
[voxel world](../features/voxel-worlds.md) while the game runs, waits for
ground to load, reacts to changes, and keeps the player's changes in the
game's save. The calls:
[`ctx.voxels`](../reference/script-api.md#ctx-voxels) and its types
[`BehaviorVoxels`](../reference/script-types-behavior-random.md#script-type-behavior-voxels),
[`BehaviorVoxelWorld`](../reference/script-types-behavior-pointer.md#script-type-behavior-voxel-world).

`ctx.voxels` reaches the worlds of the loaded scenes (a scene names a world
with a `voxelWorld` component). Its own calls act on the **first world
loaded**; `ctx.voxels.world(name)` gives another (null when no loaded scene
names it) and `ctx.voxels.worlds()` lists their names in load order. With no
world loaded, reads give null and changes are refused with `no_world`.

## Positions and regions are world metres

Every call takes world positions in metres; cells (0.5 m) stay inside the
engine. A **region** is one of:

- `{at: [x, y, z]}` — the cell holding a point;
- `{min: [x, y, z], max: [x, y, z]}` — every cell the box touches (a box
  ending exactly on a cell face does not reach into the next cell);
- `{center: [x, y, z], radius: r}` — every cell whose centre is within `r`.

A region reaching past the world's bounds, or malformed, is refused as
`invalid`.

## Read: `get` is null where the world is not loaded

```ts
const v = ctx.voxels?.get(x, y, z) ?? null;
if (v === null) {
  // not loaded here (off the ring, or still loading): unknown, NOT air
} else if (v.material === 0) {
  // air
} else {
  // v.material 1–4095, v.role 0–9, v.shape 0–15 (15 full), v.wetness 0–7
}
```

A cell that is not loaded reads `null`, never air: treat null as "don't
know yet". `isResident(region)` says whether every cell of a region is
loaded.

## Wait for ground to load: `whenResident`

A script hook cannot wait, so `whenResident(region)` returns a **wait id**
at once. The answer arrives in `ctx.voxels.waits` at the start of a later
step (that step only): `resident` true once every cell is loaded, false
when the world unloaded first (or no world was loaded to ask).

## Change: `set`, `dig`, `paint`

- `set(region, {material, role, shape?, wetness?})` writes one voxel into
  every cell (shape absent: full; wetness absent: dry). Writing material 0
  or shape 0 is a dig.
- `dig(region)` empties every cell to air.
- **Damage** is a building cell's shape: for walls, floors, roofs,
  foundations, stairs and pillars the shape is their integrity (15 intact).
  `set` the same material and role with shape 1–14 and the cell draws as
  debris with broken rims round it, while it still collides, blocks light
  and is walked on as a whole block; `dig` it when it breaks. How much damage
  a cell takes, and when, is the game's.
- `paint(region, {material?, wetness?})` changes only material (1 or more)
  and wetness of the solid cells, keeping their shape and role: only the
  surface's shading is rebuilt, no mesh or collider.

Each answers `{ok: true, edit, cells}` (`cells` 0: nothing changed) or
`{ok: false, reason, message}` with `reason` `not_resident` (some cell is
not loaded: nothing was written), `invalid` or `no_world`. A change is
**read at once** in the same step; its meshes, colliders and shading follow
together a little later, in one swap, so no frame shows half a change.
Then it is reported once in `ctx.voxels.changes` at the next step's start:
`{world, edit, chunks, shaderOnly}` (`edit` is the id the call answered,
`chunks` the boxes rebuilt in metres, `shaderOnly` true for a paint).
Loading and unloading as the camera moves is not reported.

A game's changes are its own: they are kept over the world's files while
the game runs and never written to them. A restart, or reloading the scene
that holds the world, starts again from the files.

### Example: wait for the ground, dig a pit on an event

```ts
import type { BehaviorContext } from '@thirdlight/runtime';

interface State {
  wait: number;
  ready: boolean;
  pit: number;
}

const PIT = { center: [12, 3, -4], radius: 1.75 } as const;

export default {
  instantiate(): State {
    return { wait: -1, ready: false, pit: -1 };
  },
  step(state: State, ctx: BehaviorContext): void {
    const voxels = ctx.voxels;
    if (voxels === undefined) return;
    if (state.wait < 0) state.wait = voxels.whenResident(PIT);
    for (const w of voxels.waits) {
      if (w.wait !== state.wait) continue;
      state.ready = w.resident;
      if (!w.resident) state.wait = -1; // the world went (or none was loaded yet): ask again
    }
    if (!state.ready) return;

    if (ctx.ui?.event('blast')) {
      const r = voxels.dig(PIT);
      if (r.ok) state.pit = r.edit;
      else ctx.log('warn', `dig refused: ${r.reason} (${r.message})`);
      // Already air in this step, before anything is rebuilt.
      ctx.log('info', `centre now ${voxels.get(12, 3, -4)?.material}`);
    }
    for (const c of voxels.changes) {
      if (c.edit === state.pit) ctx.log('info', `pit built: ${c.chunks.length} chunks rebuilt`);
    }
  },
};
```

Rain is a paint: `voxels.paint({min: [0, 0, 0], max: [64, 20, 64]},
{wetness: 5})`; it never touches meshes or colliders.

## Light coverage: `coverageAt`

`coverageAt(x, y, z)` gives how much light the cell at a point blocks, 0
(open) to 1 (solid): the world's own cells joined with the props whose model
has **Affects lighting** on. Null where the world is not loaded there or the
cell's piece is not built yet. Nothing draws from it yet; it is there for
scripts and the world's lighting later.

## Rays: `raycast`

`raycast(origin, direction, maxDistance, options)` walks a ray from a point
(metres) along a direction to the first voxel that stops it, within
`maxDistance` metres, or gives null. It steps from cell face to cell face, so it
never slips between two voxels that touch only by an edge. `options.stop` says
what stops it: `'solid'` (the default: a voxel drawn as a body, what a click
picks) or `'light'` (a voxel that blocks light: ground at least half full, a
wall unless damaged past half). Water, openings and air never stop it. The
answer has `distance`, the `point` met, `at` (the centre of the voxel hit, for
`get`, `dig` or `set`), the face's `normal`, the `voxel` and `far`: past the
full-detail ring the ray goes on through the coarser levels and the far field,
which hold no single voxel (`voxel` null, `far` true). Where nothing is loaded
it passes as through air.

```ts
const down = ctx.voxels.raycast([x, y + 10, z], [0, -1, 0], 50);
if (down !== null) ctx.voxels.dig({ center: down.at, radius: 1 });
```

## Regions: `regionAt`

`regionAt(x, y, z)` names the open region the voxel at a point is in: the
open voxels (air, water, rails and posts: anything not drawn as a body) joined
face to face, never through an edge alone. The answer has the region's `id`
(the same while the region does not change), `enclosed` (nothing of it under
open sky and nothing of it reaching ground that is not loaded yet: a room whose
doors and windows are its only ways out), `complete` (false while it reaches
space not loaded, so it may go on there), `volume` in m³, `sky` (this voxel is
under open sky: nothing solid above it), `seesSky` (some voxel of the region
is) and `portals`. Door and window openings (the `opening` role) are
**portals**: they separate the regions either side, so a house's room is its
own region joined to the street by its doors and windows; `portals` counts
them (in an opening, `portal` is true and `portals` counts the regions it
joins). A hole dug through a wall is not an opening: it joins the room to what
is behind it. Null where the voxel is solid, or the world is not loaded there,
or the regions are not stitched yet: just after a chunk arrives or an edit
lands, read again on a later step.

The answer also says what the region is to a game, `kind`: `room` (enclosed),
`outdoors` (some voxel of it under open sky), `portal` (an opening) or
`unknown` (it reaches ground not loaded yet, or the world's edge). `bounds`
is the box its voxels fill (`{min, max}` in metres), `surface` its area
against solid voxels in m² (openings are not surface) and `meanFreePath`
4 × volume / surface in metres: the mean distance sound travels between two
reflections in it, what a reverb's decay is set from (a 4 × 3 × 5 m room:
2.55 m). The engine has no reverb of its own; a game's audio reads these.
`portalsOf(id)` lists a region's doors and windows, each with its `bounds`,
`volume` and the `regions` it joins (a door between a room and the street
names both), so a game can tell which rooms a door connects. The answers are
kept as the regions are stitched: a query walks nothing, and an edit that
opens a wall changes them a few steps later.

```ts
const r = ctx.voxels.regionAt(x, y, z);
if (r !== null && r.kind === 'room') {
  ctx.game.add('indoors', 1);
  const reverbSeconds = 0.161 * r.volume / (r.surface * 0.3); // a game's own choice of absorption
  for (const door of ctx.voxels.portalsOf(r.id)) ctx.game.add('doors', 1);
}
```

## Paths: `findPath`, `reach`

`findPath(from, to, options?)` asks for a way a walker can go between two
points; `reach(from, maxDistance, options?)` for every place it can stand
within a walking distance. Each returns an id at once and is answered at a
later step in `ctx.voxels.paths` (or `reaches`), like a `whenResident` wait:
the engine serves the queries in the order asked within the path-finding
share of each frame (a tenth of the frame at the quality level's tier: 3.3 ms
at 30 Hz), so a long path or a hundred at once never stall the game; a long
path can take a few steps (a 200 m path through a town about ten). A point is where a body stands or its middle: the standing
place under it (down to 2 m) or beside it is taken.

The walk goes over **standing places**: a free 0.5 m cell on one that
supports (ground, a wall's or floor's top; not water, not an opening), with
room for the walker's `height` over it (default 2 m). From one it steps to
the eight round it on the same level or one cell (0.5 m) up or down, so
stairs, terraces and kerbs are walked; a step up or down needs one cell more
headroom at its lower end; a diagonal is taken only where both cells beside
it can be walked too (it never cuts a corner) and only inside a 16 m chunk.
Doors are walked through when they are as tall as the walker; windows and
low gaps are not. With `maxDrop` (metres) it also walks off ledges onto the
first floor below, as deep as that, one way only. Under water counts as
ground (there is no swimming). The walker's footprint is one cell: it fits a
body up to 0.25 m in radius; wider bodies need their own margin.

A path's answer has its `status`: `found`, `partial` (its `maxNodes` was
spent: the way to where it got closest), `unreachable` (every way out of the
start is known and none reaches the end) or `unknown` (the way runs into
ground not loaded yet: the answer is the way to where the known world ends,
nearest the end; never `unreachable` for that). `points` are waypoints in
world metres, on the floor in the middle of each cell where the way turns
(corners are kept, not cut tight), `length` in metres, and what it cost
(`searched` places, `steps` it took, `ms`). A long path is searched over the
chunks' pieces first and then cell by cell along that route, so it is within
a few per cent of the shortest, never through a wall. A reach answers
`count`, `area` (m²), `bounds` and, with `points: true`, each place.

Props, doors as objects and other moving things are **not** in the walk (it
is made from the voxels alone): a game steers its walkers round them. An
edit is in the walk a few steps after it lands (the chunk it changed is made
again); a query asked meanwhile sees the world as it was.

```ts
if (state.asked === undefined) state.asked = ctx.voxels.findPath(me, target);
for (const a of ctx.voxels.paths) if (a.path === state.asked) {
  state.route = a.status === 'found' ? a.points : null; // a game's own steering follows the points
  state.asked = undefined;
}
```

## Materials: `materialAt`, `materialOf`

`materialAt(x, y, z)` gives the material record of the voxel at a point,
`materialOf(id)` the one a voxel material id is: `{id, materialId, name,
use, kit, physical, gameData}`, with the physics resolved against the
material's profile (`physical.density`, `friction`, `restitution`, and
`flowRate` for liquids) and the game's own `gameData` (the material's keys
over its profile's), as the build ships them. Null where the world is not
loaded, the cell is air, or no material in the build has that id. The
engine never reads `gameData`: it is yours (a footstep sound, how many hits
a block takes).

```js
const m = ctx.voxels.materialAt(feet.x, feet.y - 0.1, feet.z);
if (m !== null) ctx.audio.play(m.gameData?.footstep ?? 'step-default');
```

## Save and restore

The engine has no voxel section in a save: **the game keeps its world
changes in its own save**, like the rest of its state
([saves](saves.md)).

1. **Which fields.** A save keeps the fields the `voxelWorld` component's
   **Saved fields** name (default material, role and shape: wetness is
   dropped on quit). `ctx.voxels.setSavedFields(['material', 'role',
   'shape', 'wetness'])` changes it for this run (false: an unknown field);
   a restart goes back to the component's.
2. **Save.** `ctx.voxels.save()` returns a save id at once; the answer
   arrives in `ctx.voxels.saves` at a later step (a save may read world
   files again): `{save, world, ok, bytes, text, chunks, message?}`. `bytes`
   is the save; `text` is the same as base64 text.
3. **Keep it in your save document.** The game's save document holds JSON
   only, so store `text`: `ctx.saves.write({..., voxels: a.text})`, then
   `ctx.saves.save(slot)`. Text is a third larger than the bytes (100 small
   digs: about 18 KB, 24 KB as text). A save document holds at most 1 MiB,
   so a world changed very heavily can outgrow it; a binary place in the
   save slot is an open item.
4. **Restore.** After loading the slot, `restore(doc.voxels, choice)` (bytes
   or text) replaces the game's changes with the save's: loaded cells read
   it at once, the rest as they load. It answers `{ok: true, edit, chunks}`
   (reported in `changes` once rebuilt) or a refusal: `not_resident` (the
   world is not open yet — wait for a `whenResident` answer first) or
   `invalid` (another world's save, a damaged one, bad text, a bad choice).
5. **When the world's files changed since the save** (you edited the world
   and shipped a new version), the **choice** decides each such chunk:
   `'save'` puts the player's changed cells over the new files, `'base'`
   keeps the new files there. There is no default: name one. Each such
   chunk is reported once in `ctx.voxels.mismatches`
   (`{world, chunk, kept}`), so a game that wants something else there can
   change it.

```ts
// in step(): save into slot 1, and restore after a load
if (ctx.ui?.event('save')) state.save = voxels.save();
for (const a of voxels.saves) {
  if (a.save === state.save && a.ok && a.text !== null) {
    ctx.saves?.write({ voxels: a.text });
    ctx.saves?.save(1);
  }
}
for (const r of ctx.saves?.results() ?? []) {
  if (r.op === 'load' && r.ok) {
    const doc = ctx.saves?.read() as { voxels?: string } | null;
    if (doc?.voxels !== undefined) {
      const restored = voxels.restore(doc.voxels, 'save');
      if (!restored.ok) ctx.log('warn', `restore refused: ${restored.reason}`);
    }
  }
}
```

A save is not compressed, and `restore` refuses a compressed one.

## Visual scripts

The read calls are graph nodes (**Worlds**, **Voxel at**, **Light coverage
at**, **Save voxel changes**, and the **changes**, **waits**, **saves** and
**mismatches** lists), acting on the first world loaded. `set`, `dig`,
`paint`, `isResident`, `whenResident`, `setSavedFields`, `restore` and
`world` are not nodes yet (a graph input cannot take a region or a save);
call them from a TypeScript script.

## Pitfalls

- **Null is not air.** Never dig or build on a null read; wait for the
  region.
- **Answers come next step.** `waits`, `saves` and `changes` list only what
  arrived at this step's start; read them every step.
- **Edits in the editor are different:** `editVoxels` changes the world's
  files and takes cells, not metres
  ([edits](../features/voxel-worlds.md#edits-editvoxels)).
