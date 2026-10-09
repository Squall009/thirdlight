---
name: thirdlight
description: How to build and play-test a game made with the Thirdlight engine through its MCP tools (tl_docs, tl_command, tl_script_publish, tl_playtest) - the workflow, where game rules go, game flow, determinism, performance habits and common traps. Use whenever you work on a Thirdlight project (a folder holding thirdlight.json): its scenes, objects, scripts, UI, levels, saves or play-tests.
metadata:
  thirdlight-engine: "0.1.0"
---

# Working on a Thirdlight game

Thirdlight is a browser game editor and engine. A backend holds the project;
the editor, HTTP clients and you (over MCP) change it with the same commands.
An exported game is a folder of static files that runs without Thirdlight.

This skill says **how to work**. It lists no ops, components, fields or
script calls on purpose: the running engine answers "what exists" through
`tl_docs`, generated from its own source, so it is never stale. The skill
was installed for the engine version in its `metadata` above; if
`tl_inspect target="engine"` reports another version, trust `tl_docs`.

Topics below are `tl_docs` topics: call `tl_docs {topic: "<topic>"}`.

## 1. Orient first

1. `tl_docs` with no topic: the manual's contents and the reference's topic
   kinds (`op.…`, `component.…`, `ctx.…`, `content.…`, `node.…`, `limit.…`,
   `tool.…`).
2. Read `getting-started/first-project` and `concepts/editor-and-api` once.
   Before larger work read the concepts: `concepts/projects-and-scenes`,
   `concepts/objects-and-components`, `concepts/scripts-and-the-step-model`,
   `concepts/game-flow`.
3. `tl_inspect target="project"` for the scenes, start scenes and ids.
4. Choosing how to build something: `guides/which-tool`. Each guide in
   `guides/…` has an API path; follow it rather than inventing one.

The MCP server works on the project of the folder you run in (the nearest
`thirdlight.json`). If the tools say the folder is not registered, the owner
registers it (`deployment#mcp-coding-harness`).

## 2. Look it up before you use it

- An op's arguments: `op.<op>`. A component's fields, ranges and defaults:
  `component.<name>`. A script call: `ctx.<member>`. A graph node:
  `node.<kind>.<type>`. A limit: `limit.<NAME>`. A tool's full text:
  `tool.<name>`; how `tl_command` ops behave by area: `tool.tl_command`.
- Unsure of a name: `tl_docs {query: "<words>"}`.
- Never write a field or op from memory or from another engine. A refused
  command changes nothing and names the field (`path`) and why; read it,
  fix the request, send it again.

## 3. One way to change the project

- Every change is a `tl_command` (script code: `tl_script_publish`). Never
  edit the project's files under `thirdlight/` by hand while the backend
  has it open; never write the project from a script at run time (a running
  game never writes back).
- Send the revision you read as `expectedRevision`. `revision_conflict`
  means someone (often the owner in the editor) changed it first: read
  again and resend. Every command is one undo step in the editor.
- Many objects at once: one bulk command (`op.createEntities`), not hundreds
  of single ones.
- Read whole documents before you change them: several ops replace the
  whole document or list they name (see [traps.md](traps.md)).
- Files you bring in (models, textures, sounds, fonts): `tool.tl_content_upload`
  and `concepts/assets`. Commit asset files with their `.tlasset` sidecars;
  never commit `cache/`.

## 4. Build scripts, the editor, and the owner

- Use commands for what should be repeatable: generated layouts, data
  imported from tables, setup applied to many scenes. A build script kept
  in the game's repository that sends commands is reviewable and can be
  run again.
- Leave to the owner, in the editor, what is judged by eye or ear: a
  light's colour, a jump's feel, a sound's mix. Show a screenshot and say
  what you could not check.
- Both edit the same project and mix freely; your changes show in an open
  editor at once.

## 5. Game rules live in the project's scripts

The engine holds **generic capabilities only**. What the game *is* -
winning and losing, lives, scores, currencies, enemy behaviour, level
order, what an item is worth - is this project's code.

- Prefer the engine's gameplay components (movers, switches, triggers,
  collectibles, health, hitboxes) for behaviour they already cover; script
  what they mean (`guides/which-tool#behaviour`).
- Scripts are TypeScript: `step(state, ctx)` runs every fixed step; a
  script reads the world and commits **intents** (`ctx.emit`); most
  requests take effect at the next step. Read
  `concepts/scripts-and-the-step-model` and `guides/scripts`.
- Shared rules go in a script library (`@lib/<id>`), tables of numbers in
  the library's JSON files, so a balance change is one edit.
- Small event wiring may be a visual script (`guides/visual-scripts`); it
  compiles to the same kind of script.
- Publishing: `tl_script_publish` with `check: true` first (diagnostics
  with file and line, nothing written), then publish with
  `expectedRevision`. A new source answers
  `behavior_trust_unacknowledged`: acknowledge its `sourceDigest` once
  (`op.acknowledgeBehaviorTrust`) and publish again. Then attach the
  script to an object. Play runs only the published script.
- Missing a **generic** capability? Do not work around it in engine files
  and do not ask for a game rule in the engine. Write the request down in
  this game's own docs for the engine owner, with what a game in another
  genre would also use it for.

## 6. Game flow is the game's

The engine has no "new game", "restart" or "quit to title". Build them:

- A **director** script on a kept object (Keep loaded) runs the flow:
  scenes load, unload and reload with `ctx.scenes`; a level restart is a
  scene reload plus what the game resets itself; the player is placed with
  `ctx.lifecycle` respawn or a scene list spawn.
- Show a title and menus as a game mode or a UI document, not with the
  shell's title screen actions (those restart the whole run and are
  deprecated).
- Saves hold the game's own document; restore kept objects from it
  yourself. `concepts/game-flow`, `guides/game-flow`, `guides/game-modes`,
  `guides/saves`.

## 7. Play-test every change

The loop after a change:

1. `tl_play_start` (headless when no editor is open; `sceneId`, `mode`,
   `variables` choose the start).
2. Drive it: `tl_input_exercise` frames (`restart: true` from a run's first
   step; `hold: true` to go on step by step).
3. Look: `tl_game_observe` (state, player, counters, UI, scenes …),
   `tl_diagnostics` with the play id (script errors with source lines,
   renderer, memory), `tl_screenshot` (what the player sees).
4. `tl_play_stop`.

For anything you will check again, use `tl_playtest` (several runs; they
must agree). `guides/playtesting`, `features/play-tools`.

- **Determinism.** The same start and input give the same run. Use
  `ctx.random` and `ctx.timers`, never `Math.random` or the clock; keep
  per-object state in the script's `state`. Runs that disagree name the
  first differing step.
- **Errors.** Read `tl_diagnostics` after every play: a script that throws
  stops the run even while observe still says running.
- **A test bot is game code**: a driver module in this repository, run
  from the command line runner (`features/play-tools#headless-play-tests`).
- **Observed, not claimed.** A screenshot shows pixels, not feel; a
  headless play never plays sound (check the audio observation, then say
  "not heard"). Report what you did not observe as unverified.

## 8. Performance habits

- Design for 60 fps at 1080p on an integrated GPU (`guides/performance`).
  Measure Play or the export, uncapped, on a real GPU; the headless editor
  renders in software and the Scene view draws everything, so neither
  says much about speed.
- Many copies of one thing: instance sets or rule scatter, not objects.
  Level geometry: block layers or terrain, not piles of boxes.
- Lights: give lamps a range, shadows to few; cheap fill lights per vertex
  (`guides/lighting`).
- Big worlds stream: split into scenes, set streaming rings and budgets
  (`concepts/streaming-and-budgets`). Limits are per file, per object, per
  request or per step - never a count of assets in the project
  (`guides/limits`). Meeting one means split the thing, not raise it.
- `ctx.stats` is for a debug HUD only, never for game rules.

## 9. Traps

The common mistakes, collected from the guides: [traps.md](traps.md). Read
it before your first build script and when something "does nothing".

## 10. This skill

`tools/project.mjs` in the engine installs this folder into
`.claude/skills/thirdlight/` (also on `create`) and its `check` warns when
it is older than the engine. Do not edit it here (an update would refuse
until forced); keep project notes in the game's own `CLAUDE.md`.
How it is installed: `getting-started/agents`.
