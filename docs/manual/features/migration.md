# Migration notes

What changes when an older project opens with this engine, the Problems
lines it may show, and the deprecated engine actions with their
replacements. The rule: [Existing projects keep their look](../concepts/existing-projects.md).

## Migration notes

### Opening a project with this engine (schemaVersion 7)

Opening a project of schemaVersion 6 or older upgrades it on open and writes
it back as 7 (Problems notes it once, `project_upgraded`, naming what
changed). Commit what it wrote. The upgrade:

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
