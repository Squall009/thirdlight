# Migration notes

What changes when an older project opens with this engine, the Problems
lines it may show, and the deprecated engine actions with their
replacements. The rule: [Existing projects keep their look](../concepts/existing-projects.md).

## Migration notes

### Opening a project with this engine (schemaVersion 8)

Opening a project of schemaVersion 6 or 7 upgrades it on open and writes it
back as 8 (Problems notes it once, `project_upgraded`, naming what changed).
An 8 whose `project.json` `upgrades` list lacks `planes` or
`light-counts` gets that step once too ([planes](#a-side-view-project-moves-onto-planes),
[light counts](#light-counts-retired)).
Commit what it wrote. A 7 with nothing to change only gets the new number in
`project.json` (no new revision). A project older than 6 (schemaVersion 2 to
5) is not opened: the open error and the project list say so and name the
last engine that upgrades it, git tag `upgrades-project-schema-2-to-5`
(commit `f3d40136`). Open it once with that engine (it writes the project
back as 7), commit, then open it here; its files are left untouched until
then.

The upgrade of a 7 (and of a 6, after the steps below) links prefab copies.
A placed copy was a set of plain objects that remembered their prefab; now a
copy is one object linking its prefab, and editing the prefab reaches it:

- every copy becomes a linked copy. What it differed in from the prefab as
  it is now (a changed field, an added or removed component, a deleted part,
  its own name) is kept as an override, so it looks and plays as before. Its
  objects keep their ids (`partIds` in the link), so scripts, saves and
  references naming them keep working; an object added under one of its
  parts hangs from the copy (`parentPart`);
- Problems has one line per prefab listing the copies that came out with
  overrides (tidy them up: revert what was never meant to differ);
- a copy a link cannot reproduce exactly (a part moved under another parent,
  an object placed between its parts) stays plain objects, as do parts found
  outside any copy: one Problems line per prefab names them;
- objects whose prefab is gone stay plain objects and no longer name it (a
  project naming a missing prefab does not load); one line per prefab.

Prefabs themselves, `ctx.spawn`, live blocks and block looks are unchanged.
After the upgrade, an edit of a copy's object is that copy's override, and
an edit of the prefab reaches every copy: see [Prefabs](../concepts/prefabs.md).

The upgrade of a 6:

- turns each scene `camera` entity into a fixed `virtualCamera` shot at the
  lowest priority (−1000), where it was placed: the view whenever no other
  camera is live, as before. A lens that was not the default becomes the
  project's camera settings (`camera_fov_deg`, `camera_near_m`,
  `camera_far_m`); a camera's own lens wins over them;
- marks the camera and each start scene's player (the object at the top of
  each one's hierarchy) **Keep loaded** (`keepLoaded`): the engine never
  unloaded them before. A title scene holding the camera and the player, or
  a camera in a start scene, plays as it did; clear the flag to let them go
  with their scene;
- writes `moveFrame: "world"` on every controller (scenes and prefabs) of a
  project then on 3D physics without any virtual camera, which moved along the world axes; a
  project with virtual cameras keeps `view` (input relative to the live
  shot). Only where its old scene camera, turned about Y, is the one live
  shot does the input change; the upgrade note names that camera.

Nothing else changes: ids, recorded commands and replays stay valid. New in
the format and additive (no upgrade step): `keepLoaded` on any object,
`ctx.scenes.reload`, the `reloadScene` UI action, a save schema's `world`
section and `legacyWorld`, and the other fields of schemaVersion 7.

### A side-view project moves onto planes

Every project runs on one physics backend, Rapier 3D; "2D" is a plane a
body is locked to ([2D and 3D](../concepts/2d-and-3d.md)). The project
setting `physics_dimension` is retired. The step `planes` runs once on
open (on a 7, and on an 8 whose `upgrades` list does not name it) and is
recorded in that list. A project without the setting was a 2D project (the
setting's old default), as is one with any value but 3.

**What it does to a former 2D project:**

- every scene gets the **default plane** Z at 0, where the 2D backend
  simulated: its colliders and controllers that name no `plane` of their
  own are locked to it (Window → Scene settings);
- **colliders take their 3D form, 1 m deep**, centred on the plane: a box
  without depth gets `hz: 0.5`, a polygon becomes a convex prism, a concave
  one a compound of convex prisms (`shapes`), a circle a cylinder across the
  plane. A collider's own `depth` is used where it had one;
- **controllers take the arcade profile** (`profile: "arcade"`, the 2D
  controller's behaviour on the one controller, with the same tuning
  fields; [Physics](physics.md#the-3d-character));
- gameplay blocks (triggers, switches, hitboxes, collectibles, climb
  volumes, patrols, gravity, movers) keep their data: the backend reads
  their 2D forms as they were;
- prefabs' bodies name the plane themselves (a prefab is in no scene, so a
  spawned copy stays on the plane), and the overrides of linked copies that
  hold a collider or controller are converted too; both are listed once in
  the upgrade's `project_upgraded` notes, not as lines that stay;
- a game without its own input actions gets the side-view input when its
  first start scene has a plane (`move` a 1D axis), and with **Audio
  sources** unset it hears sounds by their distance along the plane, as
  before.

A former 3D project only loses the setting (one note).

**The Problems lines** (`migrated_from_2d`). The upgrade notes every
converted item per scene (`migratedFrom2D` in the scene file), and Problems
shows them as one line per kind, naming the objects (scene in brackets,
five names, then "and N more") and the field to check. They are logged
once each time the backend runs, and after an edit the line is replaced by
one with what is left, until each item is saved in its new form: an edit that changes the named component (or deletes the object)
clears that object's note (for an area on a turned object, turning it does too), and `setScenePlane` on a scene (even to the same
plane: that confirms it) clears its plane line. An undo does not bring a
note back.

| Line | What to check |
|---|---|
| scenes got a default plane, Z at 0 | `defaultPlane`: is the side view Z at 0? Set it (or clear it for a free 3D scene) in Window → Scene settings |
| box colliders became 3D boxes 1 m deep | `collider.shape.hz` (half the depth): deeper for ground a free character walks, thinner where depth shows |
| polygon colliders became convex prisms | `collider.shape.points` and the collider's depth |
| concave polygons became compounds of prisms | `collider.shape.shapes`: the convex pieces tile the outline exactly, always split the same way |
| circle colliders became cylinders | `collider.shape.height` (the depth across the plane) |
| one-way platforms | `collider.oneWay`: the platform holds from its local +Y side (by position, not by the contact normal) |
| controllers took the arcade profile | `controller.profile`: keep `arcade` for the old feel, or try `character` |
| block layers' plane cut | `blockLayer.planeZ` is no longer read: the layer collides as 3D blocks; check what crosses the plane |
| circle triggers are spheres | `trigger.radius` |
| `[w, h]` triggers, switches, hitboxes, collectibles, climb volumes, patrols and gravity areas are as deep as wide | their `size`: add a third value for a depth of its own |
| box triggers and switches test the capsule | `trigger.size` / `switch.size`: a corner is reached up to 9 cm later at the default radius (2D tested the capsule's bounding box) |
| areas on turned objects turn with them | `transform.rotation` of triggers, switches, hitboxes and collectibles (2D kept them axis-aligned) |
| mover and patrol waypoints with a z part | `mover.waypoints`, `patrol.waypoints` / `patrol.direction`: a z offset now moves the collision in depth too, unless the body is on the plane |
| terrain, spline surfaces, generated architecture, block layers' scatter copies collide now | see below |
| model colliders are their `_COL` parts in 3D | `collider.shape` and the object's depth: 2D flattened the parts onto the plane, so a part off the plane no longer reaches it |

**Scenery collides now.** The 2D backend never collided with terrain, spline
surfaces, generated architecture or scatter copies; the one backend does, so
in a side view anything of theirs that crosses the play plane is solid
there (background hills or a house behind the level, if they reach z = 0).
Each kind gets its own Problems line naming the objects. Where a game wants
the old behaviour, make it scenery only: `terrain.collision: false` (and
`collide` off on its scatter rules), `spline.mesh.collision: false`,
`collide: false` on architecture elements (or the style's collide setting
for rooms and buildings), `collide` off on a block layer's scatter rules.
Editing the component clears its line.

**Behaviour within stated tolerances.** The arcade profile on a plane was
measured against recorded traces of the 2D controller (jump apex and air
time, run speed, slopes and slope slides, stairs with autostep, wall slide
and wall jump, ladders, one-way platforms and drop-through, lifts, a
sideways platform, coyote time and the jump buffer):

- each key event (leaving or touching the ground, a state change) on the
  same fixed step (±1 allowed, none measured) and within 1 cm;
- every step within 1.5 cm of the 2D path, a step either side (the 2D
  backend's own bumps on flat ground reached 1.1 cm); the controller's
  velocity the same;
- two cases held otherwise, for the 2D backend's own reasons: at rest after
  a flight of stairs within 5 cm, and on a sideways-moving platform 3.3 cm
  ahead (the 2D backend stalled the carry for 4 steps; the 3D one carries on
  every step).

**Recorded runs change once.** The simulation is a different one, so a
former 2D game's step digests (`tl_playtest`, `run.lastInput.digest`) and
the positions a recorded input replay reaches differ from those recorded
before the upgrade. Recorded inputs still play; re-record the expected
digests and positions once after upgrading ([Playtesting](../guides/playtesting.md)).
They are deterministic again from then on, in the page, the worker and the
export.

**Download size.** An export ships one physics engine for every game: a
former 2D game's code grows by 551 KiB (208 KiB gzipped), from 7,142 to
7,693 KiB (2,278 to 2,486 KiB gzipped), measured on the 2D starter: the 3D
engine's WebAssembly is 1,974 KiB where the 2D one was 1,451 KiB, its
script 213 KiB where the 2D one was 177 KiB. A 3D game's export is
unchanged (+15 KiB).

**Also worth a look:** a follow camera's **Collision** (on by default) now
works in side views too and pulls the camera in front of colliders between
it and its target; scripts' `{x, y}` queries ask on the scene's plane and
`character_move` is accepted on a plane. How to switch a body between the
plane and free 3D mid-game: [the guide](../guides/switching-to-a-plane.md).

### Light counts retired

Local lights (point, spot, area and effect lights) have no count any more:
each pixel loops over the lights of its light cluster, and shadowed ones
share the quality level's shadow atlas (`shadowAtlas`, a memory budget; see
[Lighting](lighting.md)). The `light-counts` step drops the fields that only
kept a game within the old count of 16 lights a pixel:

- a quality level's `localLights` (how many point and spot lights were on)
  and `shadowedLights` (how many point lights drew a shadow). A level that
  used them to keep a low-end machine cheap sets a smaller `shadowAtlas`
  now; lights it switched off are on.
- a furnishing set's **Lights** count: every room a Light node names gets
  its light. A set whose count was 0 lit no room: its Light nodes are kept
  and switched off (their **On** box cleared), so it still lights none;
  switch one on to light its rooms. Nothing is deleted.

Problems notes it once (`project_upgraded`). The `lights_local` scene check
and the `lights_dropped` Problems line are gone with the count.

### Problems lines a game may see after the upgrade

Each is one line per Play in Problems (the start checks are also the
export's `warnings` or its refusal):

- `deprecated_restart_level`, `deprecated_new_game`,
  `deprecated_quit_to_title`, `deprecated_lifecycle_restart`: the run
  restart, below;
- `deprecated_next_scene`, `deprecated_shell_scene_list`: the move along
  the shell's scene list, below;
- `deprecated_save_world`: the always-on `world` in saves, below;
- at the start of Play and the export (see [The view, cameras and kept
  objects](scenes-and-cameras.md#the-view-cameras-and-kept-objects)): `view_missing` (no camera live: the default pose is drawn),
  `player_scene` (a player in a scene the game does not start with; the
  one-player-per-view `player_count` refusal is gone: players share the view), `kept_ignored` (Keep loaded under an object that is not kept),
  `kept_twice` (one id kept in two scenes: refused);
- whenever the project opens, until each item is saved in its new form:
  `migrated_from_2d`, one line per kind of converted item ([above](#a-side-view-project-moves-onto-planes));
- whenever the project loads or a prefab or copy changes (one line per
  kind and prefab, naming its copies): `prefab_override_stale` (an override
  names a part or field the prefab no longer has: it is skipped),
  `prefab_missing` (a copy names a prefab that is gone), `prefab_cycle`,
  `prefab_part_id_taken` (a part's id is already another object's);
- while it runs: `kept_reference_unloaded` (a kept object names an object of
  a scene that unloaded: the reference reads as empty).

### The run restart and the engine's new game (deprecated)

The engine does not know what a level restart or a new game is: that is the
game's own flow. These keep working for now and are removed once no game uses
them; each use writes one Problems line per Play naming its replacement:

- **`restartLevel`** (UI engine action) restarts the whole run: the start
  scenes, every object as authored, every script fresh, the start mode, every
  script sound stopped, no conversation or timeline running, the save play
  time back to 0; `ctx.save` values stay. Use **`reloadScene`** (or
  `ctx.scenes.reload(sceneId)` in a script) for the scene that starts over,
  and reset what the game keeps itself (its counters, its `ctx.save` values,
  a kept player's place: `ctx.lifecycle.respawn` or the scene list's spawn).
- **`newGame`** (UI engine action) restarts the run and goes to the scene
  list's first entry. A shell title without a focusable button no longer
  uses it: its confirm leaves the title and plays the start scenes
  (reloaded first when the title's scripts ran).
- **`quitToTitle`** (UI engine action) restarts the run and shows the
  shell's title screen. The `open` engine action with `screen: "title"` is
  the same (a run restart, and the same Problems line). A game's title is its own: a title scene (and its
  own title document) it goes to with the scene API — a button with
  `[{do: "engine", action: "loadScene", scene: "title"}, {do: "engine",
  action: "unloadScene", scene: "level-1"}]`, or `ctx.scenes.load("title",
  {unload: [...]})` from its director answering a UI event — plus whatever
  it resets of its own. The run goes on; nothing restarts.
- **`ctx.lifecycle.restart()`** restarts the run like `restartLevel`.
- The engine's pause panel no longer offers Restart (Resume only); a game
  that wants one shows its own pause document.

The pattern for a new game is built in script: no
engine new game, a director script that owns the flow. Its title is a game
mode (or a UI document) whose button raises a UI event (`{do: "event", name:
"new-game"}`, plus `{do: "engine", action: "resume"}` when it is the shell's
title screen); the director answers the event: it resets the counters and
`ctx.save` values the game uses, unloads the scenes of the old run
(`ctx.scenes.unload`), loads the first scene (`ctx.scenes.load`, or
`ctx.scenes.reload` for one that is already in), places the kept player
(`ctx.lifecycle.respawn`, or the scene list's spawn on load), stops its own
music (`ctx.audio.stopAll`) and switches to the play mode
(`ctx.modes.switch`). Quit to title is the same in reverse. A level restart is
a `reloadScene` button (or `ctx.scenes.reload` from the director) plus
whatever the game resets of its own.

### Moving along the shell's scene list (deprecated)

A game changes levels with the scene API: `ctx.scenes.load` / `unload` (the
`loadScene` / `unloadScene` buttons), in its own order, and
`ctx.scenes.setActive` for the scene whose look shows. The shell's scene
list was a second way, with its own position that the scene API never
moved. These keep working for now and are removed once no game uses them;
each writes one Problems line per Play:

- **`nextScene`** (UI engine action, `deprecated_next_scene`) moves to the
  list's next entry: its scene loads, the previous listed scene unloads
  unless it is a start scene, the character arrives at the entry's spawn.
- **`ctx.shell.nextScene()`**, **`sceneIndex()`**, **`sceneCount()`** (and
  their Shell nodes in visual scripts; `deprecated_shell_scene_list`): the
  same move from a script, and the list's position and length.

To move on, keep the level order in the game (a list in its director, or a
`next_scene` property on each level's exit) and load the next level with
`ctx.scenes.load(next, {unload: [current]})`. A scene that stays loaded,
such as a start scene with a kept player, stays the active look until the
game calls `ctx.scenes.setActive(next)` once the level is loaded; a load
that unloads the active scene makes its own scene active. See
[the next level](../concepts/game-flow.md#the-next-level-built-by-your-game).

What stays (not deprecated): the scene list itself, each entry's spawn (a
kept player arrives there whenever that scene loads, however it loads), its
fade (used by the list move only), `$flow.shell.scene` for UI documents and
`world.listedScene` in saves (both follow only the list's own moves), the
read-ahead of the next listed scene, and the debug status line.

### The always-on `world` in saves (deprecated)

Every save used to carry where the play stands and every load moved the game
there. It is now the save section `world`. A save schema that neither lists
it nor sets `legacyWorld: false` keeps the old behaviour for now, and its
first save or load in a Play writes one Problems line
(`deprecated_save_world`). To move on, either:

- list `world` in the schema's sections (Saves tab: **Where the play
  stands**) — the same behaviour, without the line; or
- set `legacyWorld: false` (Saves tab: *restore scenes in the game*) and
  restore the game's place yourself: keep the scenes and the player's place
  in the save document (`ctx.saves.write`), and after a load
  (`ctx.saves.results()` has the load) call `ctx.scenes.load` /
  `ctx.scenes.unload` for the scenes and `character_place` with `facing`
  for the player. Kept objects are the game's to fill in either way.

Saves written before load in both cases: a game without `world` ignores a
save's world. The default changes (no `world` unless listed) once no game
relies on it.

### What else behaves differently for an existing game

No upgrade step and no Problems line; worth a look after updating the
engine:

- **A script that throws no longer stops the game.** Only that script on
  that object is switched off; the rest keeps running. A play-test that
  expected `playtest_game_failed` from a script error now finds the error
  in its run's `errors` and `runtime.errors` instead
  ([Scripts and the step model](../concepts/scripts-and-the-step-model.md)).
- **`ctx` works only while a hook runs.** A call on a `ctx` kept past its
  hook (after an `await`, in a promise callback or a timer) is refused with
  an error, and an `async` hook is switched off at its first call. Such
  code used to act at whatever step came next.
- **A script check type-checks.** `tl_script_publish {check: true}` and the
  editor's check refuse a source with a type error
  (`behavior_type_error`); publishing and Play do not, so the project still
  opens and runs ([the script guide](../guides/scripts.md#through-the-api)).
- **Play diagnostics fold copies and trim instead of refusing.** Repeated
  rows come as one with `count`; an answer over 16 KiB carries `trimmed`
  ([Play tools](play-tools.md#diagnostics-and-observations-that-fit)).
- **Block layers collide as 3D blocks everywhere** (also on a plane; the
  former 2D plane cut at *Play plane z* is gone). A layer meant as scenery
  only stands clear of the plane's depth (behind the play area) ([Blocks](blocks.md#block-layers)).
- **An unpainted wall with material rules** that name only tops is the
  material's second layer, as [Blocks](blocks.md#block-layers) says,
  instead of the first.
- **3D movers push a player sideways** when they move into it (they used
  to stop against it).
- **A transform key on a plane-locked player character** places it (before: a
  warning and nothing), and a rotation key on a player character turns its
  controller too. Walk characters with the Character track
  ([Timelines](timelines.md)).
- **Prefab copies keep their objects' tags**, so `ctx.tags` finds placed
  and spawned copies.
- **Placed prefab copies are linked.** `instantiatePrefab` places one
  object that links its prefab; its parts' ids are derived from the copy's
  (its result maps them). A command on a part writes an override, and one
  a link cannot hold (a part moved to another parent, a part's own flags)
  is refused with `prefab_override_unsupported`. `updatePrefab` from a
  linked copy of its prefab applies all its overrides
  (`applyPrefabOverrides`); from other objects it replaces the prefab's
  contents as before. A prefab may now hold a player controller, cameras,
  lights and spawn points.
- **A trim sheet draws at its own colours.** A trim material's **color**
  tints its sheet, white by default, wherever it is put; it no longer takes
  the colour of the surface under it (generated architecture's grey
  stand-in `#9a968c`, or a model's own material colour). A trim material
  that stored no colour therefore draws brighter (an exception to keeping
  the look, the owner's call); its row in Problems says so until a colour is
  stored: `#9a968c` keeps the old look on generated architecture, `#ffffff`
  the sheet's own. A layered surface made from a trim sheet (**Make it
  paintable**) draws its base at its own **color** the same way.
