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
  ([edits](../features/voxel-worlds.md#edits-editvoxels-and-undovoxels)).
