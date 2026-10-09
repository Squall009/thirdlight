# Thirdlight traps

Collected from the manual's guides. Each names its guide for the details;
the exact fields and ops are in `tl_docs`.

## Commands

- **Whole documents and lists are replaced, not merged.** The environment
  document you name, a terrain's rules or scatter rules on a bake, the
  input actions, an architecture's outlines: read them first, change your
  part, send them back whole (`guides/environment`, `guides/terrain`,
  `guides/input`, `guides/generated-architecture`).
- **A new object needs a scene** (or a parent); without one it is refused.
- **Storing terrain rules is not baking them.** Rules take effect when
  baked (`guides/terrain`).
- **An input takes one wire** in material graphs and visual scripts: over
  the API, disconnect the old wire before connecting a new one.
- **An API brush stroke lands only on block layers** unless it names a
  surface (`guides/instance-sets`).
- **An `edges` box fills its inside**: a box of walls is a room full of
  walls. List the outline's edges for walls round a room
  (`guides/block-layers`).
- **Something in use cannot be deleted** (an asset, prefab, script or
  effect): the refusal lists the uses; remove them first.

## Scripts

- **One script per object.** Attaching a second replaces the first; put
  more scripts on child objects or kept helper objects.
- **Unpublished code does not run.** Play runs the published script, and a
  running Play keeps the code it started with.
- **Object and asset references start as `null`**, never `""`; a property
  default must be a literal.
- **Library variables are shared** by every script importing the library;
  per-object state goes in the script's `state`.
- **Changing a library recompiles its users**; the change is refused while
  a user no longer compiles, and the new library version needs its own
  trust acknowledgment.
- **Events, signals, messages, spawns and scene loads arrive at the next
  step**, never in the step that asked.
- **`ctx.log` lines show among a run's errors** (code `behavior_log`); check
  the code before treating one as a failure.
- **Name assets through asset properties**, not string literals: an export
  ships only what objects and properties reference (or what carries a label
  or address).

## Game flow, saves and UI

- **The shell's title screen and its new game / quit to title actions
  restart the whole run** (deprecated). Show your own title mode or
  document.
- **Under a paused shell screen nothing steps.** A button's UI event
  reaches scripts only once the game runs: add `resume` after it.
- **A scene reload does not move a kept player** and leaves a menu open;
  respawn the player and resume yourself (`guides/game-flow`).
- **Counters and `ctx.save` survive a reload**: reset what a new game must
  not keep.
- **A load arrives a step later**: restore scenes and the player when the
  result arrives, not right after asking (`guides/saves`).
- **A save never destroys or replaces kept objects**; fill them in from
  your own document.
- **Change the save document's shape, raise its version** and register a
  migration, or older saves stop loading.
- **A menu needs focus** (Modal or Takes focus) to take keys and pad.
- **Actions of an action map the current mode does not list read as
  released**: a mode listing only `ui` stops the character.
- **Scripts without a behavior group tick in every mode** (`guides/game-modes`).

## Play-testing

- **A test frame's action needs `p`** (none, pressed or released); a value
  alone does nothing. Frames count from the run's first step and must
  ascend.
- **`tl_playtest` refuses a game that starts paused** on a title screen:
  start it past the title with `sceneId`.
- **Nothing plays a sound before the first key press or click**; a
  headless play-test sees sounds as pending.
- **A rebind listens to the real device**; test input cannot answer it.
- **Two player controllers do not repeat their digests across restarts**
  yet: compare observed fields instead (`guides/co-op`).
- **Pointer picks in 3D need 3D physics**; the Starter's physics is the 2D
  plane.

## Look, cameras and lighting

- **Keep one enabled camera in a start scene**; priority decides which
  camera is live, not order (`guides/cameras`).
- **Only the active scene's look shows** in Play (`guides/environment`).
- **Probe baking needs WebGPU**; a baked light gives moving objects only
  its bounce; changing an image sky after a bake makes probes stale
  (`guides/lighting`).
- **A graph material ignores the model file's own material**
  (`guides/material-graphs`).
- **Particles pass through the floor** without a collide block, and effects
  never change the game (`guides/effects`).
- **Instance sets cast no shadow and have no colliders** unless told
  (`guides/instance-sets`).
- **Generated architecture needs a trim sheet with every row its styles
  name** (`guides/trim-sheets`).

## Export

- **Serve the export over HTTP**; `file://` does not load.
- **An export is one revision**: change, then export again.
- **Changing the game's id loses the players' saves** (`guides/export`).
