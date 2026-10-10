# Scripting

What a TypeScript script can declare and call beyond the basics: its
properties, shared libraries and JSON data, timers, trigger events and
messages, callbacks, reading and writing components, spawning prefabs,
loading assets by name, random numbers, the ground at a point, and the
Console. The step model: [Scripts and the step model](../concepts/scripts-and-the-step-model.md);
step by step: [the script guide](../guides/scripts.md); every `ctx` member:
[Script API](../reference/script-api.md); the editor tab:
[Script editor](editor.md#script-editor); where scripts run:
[Simulation thread](physics.md#simulation-thread-worker).

## Script properties: public and private

A script declares the properties objects give it (`ctx.properties.<key>`):
number, boolean, text, choice (enum), vector, object or asset. Each one is
**public** (the default) or **private**, like Unity's public/private
fields:

- **Public**: shown in the Inspector of every object carrying the script
  and set per object there (or with `setBehaviorProperties`). Optional
  `group` (the Inspector section it is listed in), `header` (a heading
  above it) and `tooltip` (hover help).
- **Private**: not shown and not settable per object or per prefab copy
  (refused with `property_private`); the script always reads the declared
  default. A property made private later keeps any old per-object value
  in the file, unused, until that object's properties are next set.
- An object stores only the public values it sets; a key added to a script
  in use reads its default until set.
- There is no count limit: a script declares as many properties as fit in
  32 KiB (`MAX_DECLARATION_BYTES`, the declaration as 2-space JSON). A
  larger one is refused with `limits_exceeded` (`limit: declaration_bytes`)
  naming its size — declare fewer or shorter properties (shorter labels,
  tooltips, choices).

Declare them in File → Project Settings… → **Scripts**: "+ New behavior" (or select a
behavior) opens the declaration editor — key, label, type, default,
visibility, group, header, tooltip and the type's limits (min/max/step,
max length, choices, vector bounds) — and one save publishes the whole
declaration (one undo step). Saving keeps the behavior's published
source.

Or declare them in the script itself, in `src/index.ts`:

```ts
export const properties = {
  speed: property.number(3, { min: 0, group: 'Movement', tooltip: 'Metres per second' }),
  secret: property.private.number(1),
  mode: property.enum('walk', { values: ['walk', 'run'] }),
};
```

`property[.public|.private].<number|boolean|string|enum|vec3|entityRef|assetRef>(default, options?)`
with literal values; options: label (default: the key in words), min, max,
step, maxLength, values, bounds, group, header, tooltip. The compiler reads
it without running the code and publishes it as the declaration: **the code
wins** over any JSON declaration sent with the source (the source route then
needs none), so the two cannot drift. Such a declaration shows read-only in
Project Settings → Scripts, and a JSON `declaration-update` of it is refused
(`behavior_declaration_mismatch`, reason `declared_in_code`): change the
source. The source still publishes into an existing behavior record. A
script without that export keeps using its JSON declaration.

**Play debug view**: while Play runs, selecting an object that carries a
script shows under the Inspector the values its running script reads —
public and private — read-only, refreshed twice a second (read from the
running game over the game-observe relay; the editor runs no game code).
`tl_game_observe {entityId}` returns the same values as `behaviors`.

## Script libraries and JSON data

- **Libraries** are shared TypeScript (and JSON) every script of the
  project can use: the project window's Create → **Script library** makes one from a
  name (its id is the name in lower case, e.g. "Scoring" → `scoring`),
  renames, deletes and opens it. Its tab is the code editor: `src/index.ts`
  is what scripts import — `import { points } from '@lib/scoring';` — and
  **+ File** adds more modules or `.json` data (`import table from
  './table.json'`). The draft compiles after a short pause (or Ctrl+S);
  problems are marked in the code. **Save** stores the changed files (one
  undo step) and recompiles every published script that imports the
  library in the same step; the first save that changes a library such
  scripts use asks for the trust acknowledgment of the new version (like
  publishing a script). If a script no longer compiles against the change,
  the save is refused and the message names the script. A library a
  published script imports cannot be deleted.
- A library may import other libraries (`@lib/<id>`); a cycle between
  libraries or an import of a library that does not exist is a compile
  error. Bounds: 16 files and 256 KiB per library, 64 KiB per
  file, as many libraries as the project needs (a save of more than ~64 KiB of changed text goes in several
  patches, below).
- Scripts may also keep `.json` files in their own source and import them
  the same way.
- MCP: `tl_command` `setScriptLibrary {libraryId, name?, files?: [{path,
  text|null}]}` (text null removes a file; other files are kept) and
  `deleteScriptLibrary {libraryId}`; the libraries are in
  `tl_content_query target="game"` (`scriptLibraries`).
- **Shared modules.** Each library is compiled once into its
  own minified, tree-shaken module (`libraries/<digest>.js`; code no export
  reaches is dropped) that scripts import instead of carrying a copy. Play
  (worker and page) and exports load each library once, so a library's
  top-level variables are shared by every script that imports it (keep
  per-object state in the script's state, not in library variables). An
  import of a name the library does not export is a compile error.
  Exports ship the modules next to the scripts; scripts published by
  older engines need no republish.
- **Several libraries or large edits at once.** The Libraries
  tab lists the libraries with unsaved edits; **Save all** commits them in
  one step (one undo), recompiling each script that imports any of them
  once. A library save larger than one request (the 64 KiB command cap) is
  sent in several patches and committed once the same way. MCP:
  `tl_command` op `stageScriptLibrary {stageId?, libraryId, name?, files?}`
  (a file may come in pieces: `{path, text, append: true}`; no revision)
  answers a `stageId`; `commitScriptLibraryStage {stageId}` commits the
  stage (its answer's `libraryStage` names the scripts compiled);
  `{stageId, discard: true}` drops one. Stages live until the backend
  restarts (at most 8 per project).

## Timers and trigger events in scripts

- `ctx.timers.after(name, seconds)` fires once, `ctx.timers.every(name,
  seconds)` repeatedly; `ctx.timers.fired(name)` is true in the step the
  timer fires; `ctx.timers.cancel(name)` stops it. Timers count fixed steps
  (seconds × the step rate, rounded, at least one step), so a replay fires
  them in the same steps. Calling `after`/`every` again with the same length
  while it runs changes nothing (a script may call `every` every step);
  another length restarts it; to restart the same one, cancel it first.
  Each script instance (each object carrying the script) has its own
  timers, at most 64 running; a new run (start, replay, the next level)
  clears them. A bad name (1–64 letters, digits, `_ . : -`) or length
  (0–3600 s) or a 65th timer stops the game with the script error.
- `ctx.events` also lists `{ type: "enter" | "exit", trigger: id, stepIndex }`
  when the player entered or left a trigger the script owns, in the step
  after (like signals). A script owns the triggers on its own object, on
  objects below it in the hierarchy, and the triggers named by its
  entity-reference properties. Every entry and exit is reported, even for a
  trigger whose signal is "only once". (Animator clip events stay in the
  same list; they have `name` and `clip` instead of `type`.)

A timed door, for example: a script on the door with a "sensor" entity
property naming a trigger; on its `enter` event `ctx.timers.after("open",
1)`; when `fired("open")` it hides the door (`ctx.game.setVisible`) and
starts `after("close", 4)`, which shows it again.

- `ctx.messages.send(name, value?, target?)` sends a named
  message (name like a timer name; value a number, text of at most 256
  characters or true/false) to every script, or only to the scripts on the
  entity `target`; `ctx.messages.received(name)` lists, in send order, the
  messages of that name sent in the previous step to everyone or to this
  object (`{ name, value, from, stepIndex }`). At most 256 messages per step
  (`send` returns false beyond, or for a bad name/value); a new run clears
  them. A behavior may declare no property at all.

## Callbacks on a script

- Besides `step(state, ctx)` (optional), a script's `export default` may
  have callbacks: `onEnable(state, ctx)` (the object is in the game and on:
  its first step, a scene load, a spawned copy, and each time it is switched
  on again), `onDisable` (switched off, itself or an object above it, or
  leaving), `onDestroy` (it left the game: destroyed or its scene unloaded;
  the object is already gone; not on a restart), and with the event as the
  second argument `onTriggerEnter`/`onTriggerExit` (triggers the script owns),
  `onContact` (its hitboxes: `type` contact or separate), `onMessage`
  (messages to every script or to this object), `onUiEvent` (the step's UI
  events) and `onAnimatorEvent` (clip events of animators it owns).
- They run inside the step's intent phase, before the script's `step`, in a
  fixed order: leaving objects' onDisable/onDestroy first, then per script
  onEnable/onDisable, triggers, contacts, messages, UI events, animator
  events. `ctx.events`, `ctx.messages.received` and `ctx.ui.events()` still
  list the same events. Page, worker and replays run them alike.
- The script editor completes the callbacks inside `export default { … }`
  and the fields of their event parameter. Visual scripts have **On enable**,
  **On disable**, **On destroy**, **On contact** and **On UI event**
  (category Events).

## Reading and writing any component: `ctx.entity`

- `ctx.entity(id)` is one loaded object (an object property's value, a
  spawned copy's id, `ctx.entityId`; null for no id or an object that is not
  loaded). `.get(component)` is a read-only snapshot of the component's
  fields as they stood at the start of the step (`'object'`: the object's
  own id, name, parentId, active, visible, static and tags); null when the
  object has no such component. Which fields scripts read is marked in the
  component descriptors (`queryGameConfig`: `scriptReadable`) and belongs to
  the project schema.
- `.set(component, patch)` writes fields while the game runs; the writes of
  a step are applied at its end, in script order, identically in the page,
  the simulation worker and a replay. Writable (`runtimeWritable`):
  - `object`: `active` — off, the object and its children are not drawn,
    collide with nothing, fire no trigger or switch and do not tick (scripts,
    movers, patrols, hitboxes, collectibles, animators, audio sources); on
    again, everything comes back where the object is. `visible` — drawn or
    not (the state `ctx.game.setVisible` uses). Not for the camera, the
    character or objects above them, nor static objects. An object switched
    off in the editor is still not in the game.
  - `transform`: `position`, `rotation`, `scale` of any object that is not a
    physics body, the camera, static, or moved every step by its mover,
    patrol, socket or facing — no `ownedTransforms` needed.
  - `light`: `color`, `intensity`, `range` (point and spot); presets blend
    from the written values. `lightMask` and `shadowCasterMask` ([light
    layers](lighting.md#light-layers)).
  - `mover`: `speed` and `active` (the Inspector's **Moving** switch: a
    mover that is off holds where it is, still solid).
  - `materialParams`: `{ materialId: { parameter: value } }` for the graph
    materials the object wears (`null`: back to the authored value).
  - `materials`: `{ slot: materialId }` swaps which project material a slot
    wears (a model's source material name, or `*` for every slot; `null`:
    back to the authored one) on a model, a box or an instance set, static
    objects included. Any material the game ships may be named: one an
    object or a timeline uses, or one with an address or a label. The
    simulation has the swap at the end of the step; the picture keeps what
    the object wore until the new material's textures are loaded (decoded
    and held in the resource manager), then puts it on — never a half-loaded
    material. `get('materials')` reads the mapping with the swaps over it.
    Block types swap with `ctx.grid.setTypeMaterials(blockId, { slot:
    materialId | null })` (every layer's cells; `typeMaterials(blockId)`
    reads it; a save's `grid` section keeps it), and a timeline with a
    **Material swap** key.
  Any other field is refused: the answer `{ok, field, code, message}` names
  it, nothing of the patch is written, and the refusal shows in the Console
  and `tl_diagnostics` (`entity_write`). A field two scripts write in one
  step takes the later write; the conflict is reported there too. A new run
  puts every written field back; a save's `components` section keeps them.
- Object properties of a script (type object, `entityRef`) are pickers of
  the scene's objects in the Inspector. In a spawned prefab copy they name
  the copy's own objects.
- `ctx.emit({ kind: 'character_place', position: [x, y, z] })` also works on
  the 2D plane (z ignored): the character is placed from rest in that step.
  In 3D an optional `facing` (degrees about +Y, 0 facing +Z — what
  `ctx.physics.characterState().facing` reads) turns it as it is placed;
  without it it keeps facing as it was.
- `ctx.shell.nextScene()` moves to the next entry of the shell's scene list
  (the same move as the shell's Next scene action); `sceneIndex()` and
  `sceneCount()` read the list.
- Visual scripts have the same as nodes: **Get component**, **Set
  component** (category Entity) and **Next scene** (Shell).

## Spawning prefabs from scripts

A script can put copies of a project prefab into the running game (never
into the project): projectiles, dropped coins, falling crates, enemies from
a spawner. Make the prefab as usual (GameObject → **Create prefab from
selection**, see [the prefab guide](../guides/prefabs.md)); a prefab keeps the object's collider (on its root),
surface, materials, animator and gameplay blocks (mover, trigger, switch,
collectible, health, patrol, hitbox, audio source, face movement), so a copy
collides, is collected, patrols or flies like the original. The player
controller and level wiring (camera, lights, spawn markers) never go into a
prefab.

- `ctx.spawn(prefabId, { position, rotation?, scale? })` — `position` is
  `[x, y]` (the root keeps the prefab's own z) or `[x, y, z]`; `rotation` a
  quaternion `[x, y, z, w]`, `scale` a number or `[x, y, z]` (a prefab with
  a collider turns about Z only and keeps scale 1). It returns the new root
  id (`spawn-1`, `spawn-2`, …; never reused while the game runs) at once; the copy appears at
  the next step. Children keep their places under the root, and a script
  property that names an object of the prefab points at the copy's object.
  `properties: {key: value}` gives this copy its own values for the script
  on the prefab's root (keys its declaration has, values it accepts; an
  object property names a live object id); the rest keep the prefab's. A
  key the script does not declare, a private one or a value it refuses is
  a script error, like bad options. A save's `spawned` section keeps them.
- `ctx.destroy(id)` removes a spawned object and its children at the next
  step (`false` if it is already gone). Objects placed in the editor cannot
  be destroyed; hide them with `ctx.game.setVisible`.
- Engine limits: 64 spawns per step and 16,384 spawned objects alive (one
  scene's entity capacity); past
  them `ctx.spawn` returns `null` and the runtime diagnostics record one
  `spawn_refused` line. An unknown prefab or bad options stop the game with
  the script error, like a bad `ctx.scenes` call.
- A new run (start, replay, the next level) removes every spawned object.
  Scripts keep running before the run starts, so spawn once the game is
  playing (or spawn again when your object is gone). A save keeps spawned
  objects only when its schema lists the `spawned` section.
- A spawned object's own script runs. To let it move its object, list
  `"@self"` in the script's `ownedTransforms` (the source container): every
  object carrying that script — placed in the editor or spawned — may then
  write its own transform and pose with `ctx.emit({ kind: "transform",
  entityId: ctx.entityId, position: { x } })` in the transform phase (never
  another object's; not on the camera or an object with a collider or the
  player controller). A mover or a patrol component moves objects too.

`tl_game_observe` reports `spawned: { count, ids }` (the first 64 ids). Play
and the export carry the project's prefabs with the game.

## Loading assets by name from scripts

A scene's objects load what they use with the scene. A script that needs
assets no loaded scene uses (a level's props before it opens, a boss's
models, a set of voice lines) loads them by name and lets them go when it is
done, as Unity's Addressables do. Give the assets (or prefabs, materials) an
address or a label first (project window or Inspector; `setLabels`,
`setAddress`): only what has one ships for scripts.

- `ctx.assets.load(key)` takes an address, an asset or resource id, or a
  label (every asset and resource with that label), in that order, and
  returns a handle (a number; 0 when the key is not a name at all). The game
  never waits: the handle is `loading` until the assets are read, parsed and
  decoded, a later step.
- `ctx.assets.state(handle)` is `loading`, `ready` or `failed` (null once
  released); `ready(handle)`, `ids(handle)` (what the key named) and
  `error(handle)` (why it failed, e.g. nothing is named that).
- `ctx.assets.release(handle)` lets the assets go; they leave memory once
  nothing else (a scene, a spawned object, a playing sound) uses them.
  Release every handle you load. A prefab loaded by handle spawns at once
  with its models and textures already in memory.
- The answer arrives as the game's input at the step it came, so a recording
  of the input replays it the same however long the loads take then, and the
  simulation worker sees it at the same step.
- A handle still open when a run ends (a restart, the shell's new game) is
  released then and reported: the script log says which, and
  `tl_game_observe` / Play diagnostics list it under `resources.notReleased`.
  `resources.open` lists the handles open now; one still open when Play
  stops is named in the page console.

Visual scripts have Load assets, Release assets, Assets state, Assets ready
and Assets error nodes.

## Random numbers, finding objects and facing

- `ctx.random` gives each object's script its own seeded random numbers:
  `next()` (0 up to 1), `range(min, max)`, `int(min, max)` (both ends
  included), `chance(p)` and `pick(list)` (`undefined` for an empty list).
  `ctx.random.stream(name)` is an independent stream of that object (same
  API, without `stream`; names like timer names, at most 64 per object):
  draws from one never shift another, so adding a loot roll does not change
  how an enemy moves. The numbers come from the project setting **Random
  seed** (Project settings → Gameplay → Engine, `random_seed`, 0–4294967295, default 0)
  mixed with the script, the object and the stream name, so every run,
  replay, Play in the worker or on the main thread, and the export draw the
  same numbers; change the seed to reshuffle every choice of the game at
  once. A new run (start, replay) starts every stream over. Never use
  `Math.random` in a script — a replay could not repeat it. Visual scripts
  have the same numbers as the **Seeded random / range / integer / chance**
  nodes (with a "(stream)" variant taking a stream name).
- `ctx.world.find(name)` is the id of the first loaded object with exactly
  that name (or `undefined`), `ctx.world.findAll(name)` all of them and
  `ctx.world.withComponent(kind)` every object carrying a component of that
  kind (`"light"`, `"collider"`, `"behavior"`, …) — in load order (the start
  scene as authored, then loaded scenes and spawned copies as they came).
  Nodes: Find object by name, Find objects by name, Find objects with
  component.
- Transform and pose intents take a rotation as a quaternion or a direction
  besides angles: `{ kind: "pose", entityId, quaternion: [x, y, z, w] }`
  (normalized for you), or `facing: [x, y, z]` — the object's forward (+Z,
  the glTF forward) points that way, its top towards `up` (default
  `[0, 1, 0]`; straight up or down leans the top away from / towards +Z).
  A `transform` intent may carry the same `quaternion` or `facing`/`up`
  after its `position` to move and turn in one intent. One rotation form per
  intent (angles, quaternion or facing); an all-zero vector or an `up`
  parallel to `facing` stops the game with the script error. These fields
  are for code scripts; the Pose object and Move object nodes do not take
  them.

## The ground at a point (`ctx.surface`)

One query answers what ground is at a world point, from whichever block
layer or terrain is there — for footsteps, effects, decals and placing
things. Scripts ask `ctx.surface`; tools and MCP ask the backend's
`querySurface` (MCP `tl_content_query target="surface"`); both read the
same way, from the same cells and tiles, so they agree.

- `ctx.surface.at([x, y, z])`: the ground at or below the point (a point
  inside blocks gives their top); `ctx.surface.top(x, z)`: the highest
  ground there. Null where nothing has ground (a hole, off the level, a
  streamed tile not loaded yet). Graph nodes: **Surface at**, **Top
  surface**.
- The answer: `source` (`'blocks'` or `'terrain'`) and `object` (its id),
  `height` and `point`, `normal`, `slope` (degrees), `layers` and `weights`
  (the material layers showing there, strongest first, weights 0–1 summing
  to 1), `wetness` (block paint's, 0–1; 0 on terrain), and on blocks `cell`
  and `block` (read its metadata with `ctx.grid.meta`/`get`).
- Which one answers: the highest ground at or below the point; a block
  layer wins a tie and terrain within 1 cm above a block top
  (`SURFACE_TIE_METRES`: terrain heights are 16-bit steps). A block area on
  terrain therefore answers on its tops and the terrain round it; a bridge
  answers only from above it. Terrain counts as below the point when it
  stands at most 25 cm over it (`SURFACE_SINK_METRES`: a foot sunk into a
  slope); higher terrain answers only when nothing lies below the point (a
  point deep in the ground climbs to the surface), so a cellar or tunnel of
  blocks under a hill answers on its own floor, not the hilltop.
- Weights: on blocks, the paint the chunk's mesh shows there (hand paint
  over the layer's material rules); on terrain, the nearest sample's layers
  (baked rules under hand paint) — what the ground is drawn with.
- `ctx.grid.surface` / `columnSurface` stay: they ask one block layer by
  cell.
- In a game the simulation (its worker) reads the terrain tiles the page
  decoded: heights and holes at once (collision), the layer weights and hand
  paint after them within 4 MiB a frame (a tile answers layer 0 until they
  arrive, a frame or two). The weights take 8 bytes a sample (the heights
  2; a 257² tile: 0.5 MB) and hand paint 9 more where a tile has it;
  Play's diagnostics show them (`terrainMemory.layerBytes`). A query costs
  about 2 µs on terrain and 11 µs on a block layer with material rules
  (Node, `TL_PERF=1 npx vitest run tests/perf/surface-query.test.ts`).

## The Console: script logs and errors at their source lines

- The **Console** tab (bottom dock) lists the running Play's `ctx.log`
  lines and script errors with the file, line and column in the project's
  own sources — the script's or the library's (`@lib/tally ·
  src/index.ts:15:9`), and for an error the script frames it came through.
  A location opens the Script or Library tab with the cursor on that line.
  It refreshes about once a second while shown and keeps the last Play's
  entries after it stops.
- `tl_diagnostics` carries the same: each entry of `runtime.errors` with a
  compiled position (`at`, `frames`) also has `source` (and `sources`)
  `{behaviorId | libraryId, path, line, column}`. Exports carry no source
  maps or sources; an exported game's errors keep their compiled positions.
