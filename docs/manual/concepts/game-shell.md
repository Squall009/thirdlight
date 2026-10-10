# The game shell

The **game shell** is the frame around your game: a title screen before
play, the pause menu, settings, controls (rebinding), the save and load
screens, and the HUD shown while playing. You draw each of these with your
own **UI documents** and tell the shell which document is which screen.

A project without a shell (the Starter has none) starts its game at once,
with no menus. A shell without a Pause screen gets the engine's small pause
panel, with **Resume** only.

## What the shell holds

- **Screens**: Title, Pause, Settings, Controls, Save and Load, each a UI
  document. For each you choose what runs while it shows: nothing (the game
  is paused) or the scripts (so a title screen can animate).
- **HUD**: up to 8 UI documents shown while the game plays. They show
  values with bindings: named counters, an object's health, input prompts
  made from your input actions, and any value a script publishes with
  [`ctx.ui`](../reference/script-api.md#ctx-ui).
- **Scene list**: your scenes in order, each with the spawn the player
  starts at and an optional fade. A **Next scene** button moves on to the
  next.
- **Pause allowed**, and a small debug status line.

Buttons in the shell's documents use **engine actions**: resume (from the
title it starts play), continue (the newest save), back, open a screen,
save or load a slot, change a setting, rebind, next scene, load, unload or
reload a scene. Anything else is a UI event your scripts answer.

## Where to edit it

- Editor: **File → Project Settings… → Game shell**. UI documents are made
  with the Project window's **create ▾ → UI document**.
- API: [`setShell`](../reference/ops-detail.md#op-setShell); the fields are
  in [the shell in the reference](../reference/content-blocks-script-libraries.md#content-shell),
  UI documents in [UI documents](../reference/ui.md#ui-document).

The shell gives you screens and wiring, not a game flow. What *New game*,
*Restart* or *Quit to title* do is your game's decision; see
[game flow belongs to your game](game-flow.md).

A full walk-through: [a HUD and menus with UI documents](../guides/ui-documents.md).
