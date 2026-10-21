# Game flow belongs to your game

The engine does not know what a level, a new game, a restart or "quit to
title" is. Those are your game's flow, and your scripts build them from a
few engine tools. This keeps the engine usable for any kind of game.

## The tools

- **Scenes** load, unload and reload while the game runs:
  [`ctx.scenes`](../reference/script-api.md#ctx-scenes) has `load`,
  `unload`, `reload`, `status`, `loaded` and more. UI buttons have the same as
  the engine actions `loadScene`, `unloadScene` and `reloadScene`. This is
  the one way a game changes levels.
- **The active scene** decides the look: its sky, fog, post-processing and
  wind. At the start it is the first start scene. A load that unloads the
  active scene (`ctx.scenes.load(next, {unload: [current]})`) makes the
  loaded scene active (an unload of the active scene alone hands it to the
  first scene still loaded); otherwise the active scene stays as it is until
  your game calls `ctx.scenes.setActive(sceneId, {blend})`. So a scene that stays
  loaded, such as a start scene that holds a kept player, stays the active
  look while levels come and go: call `setActive` for each level whose own
  look should show.
- **`ctx.scenes.reload(sceneId)`** puts a loaded scene back as it was
  authored, at the next step: its objects return to their places, copies
  its scripts spawned go, its scripts start over and its sounds stop.
  Everything else stays as it is: kept objects, the other scenes, the
  counters and the values in `ctx.save`. A "restart level" is a reload plus
  whatever your game resets itself.
- **Keep loaded** is a flag on an object (Inspector, or `keepLoaded` in
  [`updateEntity`](../reference/ops-detail.md#op-updateEntity)). A kept
  object, with its children and scripts, survives its scene being
  unloaded, reloaded or replaced by a save. Use it for the player, the
  camera, a director script that runs the whole game, the music. In the
  starters, the camera and the player are kept; the Hierarchy marks them
  **K**. The player can only leave with its scene when it is not kept.
- **Respawn**: [`ctx.lifecycle.respawn`](../reference/script-api.md#ctx-lifecycle)
  puts the player back at a spawn point.

## The next level, built by your game

Your game keeps its own level order (a list in a director script, or a
`next_scene` property on each level's exit). To move on, the director:

1. loads the next level and unloads the current one in one step:
   `ctx.scenes.load(next, {unload: [current], fade: 0.5})` (the old level
   stays in view until the new one is in);
2. once `ctx.scenes.status(next)` is `loaded`, makes it the active look:
   `ctx.scenes.setActive(next)`;
3. places the kept player: a listed spawn of the shell's scene list does it
   on load, or `ctx.lifecycle.respawn(spawnId)` once
   `ctx.scenes.status(next)` is `loaded`.

## A new game, built by your game

A common pattern is one **director** script on a kept object. Your title
screen's *New game* button raises a UI event; the director answers it:

1. reset the counters and `ctx.save` values your game uses;
2. unload the scenes of the old run;
3. load the first scene (or reload it if it is already loaded);
4. place the kept player (respawn, or the scene list's spawn on load);
5. stop its music and switch to the game mode for playing.

*Quit to title* is the same in reverse, and a level restart is a
`reloadScene` (or `ctx.scenes.reload`) plus what the game resets itself.
Nothing restarts the whole engine run.

## The old engine actions

Older projects may still use the engine actions `restartLevel`, `newGame`
and `quitToTitle`, or `ctx.lifecycle.restart()`. They restart the whole
run. Others move along the shell's scene list: the `nextScene` action and
`ctx.shell`. They all still work but are deprecated: each use writes one
line to Problems per Play naming its replacement. New games should not use
them. Their exact behaviour is in
[Migration notes](../features/migration.md#the-run-restart-and-the-engines-new-game-deprecated).

A full walk-through: [title, new game, restart and scene changes](../guides/game-flow.md).
