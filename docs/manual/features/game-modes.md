# Game modes

Named states of the running game, each with its own input maps, camera,
UI, running scripts, pause and time scale. Step by step:
[the game modes guide](../guides/game-modes.md).

## Game modes

A project defines game modes — named states of the running game such as
explore and tactical, on foot and driving, build and play, a photo mode or a
title screen. Edit them in Project Settings → **Game modes** (the list, the selected
mode's form, the behavior groups) or with `setModes` / `setBehaviorGroups`
through MCP. The first mode is the one a run starts in.

- Each mode sets, together: the **input maps** that are active (gameplay, ui
  or maps the project adds in Project Settings → Input — the actions of other maps read
  as released), the **camera** (a virtual camera that is live over the
  priorities while the mode is), the **UI documents** shown, the **behavior
  groups** whose scripts run (an object joins a group with its Behavior group
  component; the other groups pause; ungrouped scripts tick unless the mode
  says otherwise), whether the **engine pause** is allowed and the **pause
  screen** document, the **time scale** (0.1–4) and whether **physics**
  steps or holds. A transition may blend the camera (cut, linear, eased) and
  show a fade document for a moment.
- Switching: a script calls `ctx.modes.switch('tactical')` (it applies at the
  next step; `ctx.modes.events()` / `entered()` / `exited()` report the switch
  in that step), or a UI button runs `{ "do": "mode", "mode": "explore" }`.
  Nothing is loaded: the switch happens in one step and replays exactly.
- Pause: a game with modes pauses with the pause key when its mode allows
  it — the mode's pause screen document (buttons with the engine actions
  resume, reloadScene or the game's own events), the game shell's pause screen or the engine's
  small pause panel; a mode that does not allow the pause keeps it closed.
- Every game has these lifecycle calls: `ctx.lifecycle.respawn(spawnId?)` puts the character at a
  Player spawn object (from rest), `setSpawn` picks the spawn respawns use
  (`restart()` is deprecated: see [Migration notes](migration.md#the-run-restart-and-the-engines-new-game-deprecated); `ctx.scenes.reload`
  puts a scene back as authored). What winning, losing or a death means is the
  game's own scripts.
- Play from a mode: "Play from…" / MCP `tl_play_start` `mode`; the Play
  toolbar shows the mode the running game is in; `tl_game_observe` reports
  `mode` and `paused`.
- Engine limits: 16 modes, 32 behavior groups, 8 project input maps.
