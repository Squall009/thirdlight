# Migration notes

What changes when an older project opens with this engine, the Problems
lines it may show, and the deprecated engine actions with their
replacements. The rule: [Existing projects keep their look](../concepts/existing-projects.md).

## Migration notes

### Opening a project with this engine (schemaVersion 8)

Opening a project of schemaVersion 6 or 7 upgrades it on open and writes it
back as 8 (Problems notes it once, `project_upgraded`, naming what changed).
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
  3D project without any virtual camera, which moved along the world axes; a
  project with virtual cameras keeps `view` (input relative to the live
  shot). Only where its old scene camera, turned about Y, is the one live
  shot does the input change; the upgrade note names that camera.

Nothing else changes: ids, recorded commands and replays stay valid. New in
the format and additive (no upgrade step): `keepLoaded` on any object,
`ctx.scenes.reload`, the `reloadScene` UI action, a save schema's `world`
section and `legacyWorld`, and the other fields of schemaVersion 7.

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
- **`newGame`** (UI engine action; also a title without a focusable button
  on submit) restarts the run and goes to the scene list's first entry.
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
- **Block layers collide on the 2D plane.** A 2D project's layer now
  collides where it crosses the play plane. A layer meant as scenery only
  can move its *Play plane z* to a z it does not reach
  ([Blocks](blocks.md#block-layers)).
- **An unpainted wall with material rules** that name only tops is the
  material's second layer, as [Blocks](blocks.md#block-layers) says,
  instead of the first.
- **3D movers push a player sideways** when they move into it (they used
  to stop against it).
- **A transform key on a 2D player character** places it (before: a
  warning and nothing), and a rotation key on a player character turns its
  controller too. Walk characters with the Character track
  ([Timelines](timelines.md)).
- **Prefab copies keep their objects' tags**, so `ctx.tags` finds placed
  and spawned copies.
- **A trim sheet draws at its own colours.** A trim material's **color**
  tints its sheet, white by default, wherever it is put; it no longer takes
  the colour of the surface under it (generated architecture's grey
  stand-in `#9a968c`, or a model's own material colour). A trim material
  that stored no colour therefore draws brighter (an exception to keeping
  the look, the owner's call); its row in Problems says so until a colour is
  stored: `#9a968c` keeps the old look on generated architecture, `#ffffff`
  the sheet's own. A layered surface made from a trim sheet (**Make it
  paintable**) draws its base at its own **color** the same way.
