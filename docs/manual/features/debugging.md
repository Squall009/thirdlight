# Testing, debugging and quality settings

Starting Play somewhere else, debug commands and the in-game console, frame
statistics, the frame-rate cap, and the render settings a player may
change: ambient occlusion, render scale, dynamic resolution and quality
levels. Play-testing step by step: [the play-testing guide](../guides/playtesting.md);
measuring: [Performance](performance.md).

<a id="test-and-debug-entry-points"></a>
## Play from…

**Play from…** (the toolbar button next to *play*) starts Play somewhere
other than the game's start:

- **Scene** — loads the scene together with its start scenes (they hold the
  camera and the player), skipping the title, and the player starts at the
  scene's first player spawn (else the game's own).
- **Variables** — a JSON object the scripts read with `ctx.save.get(key)`
  from the very first step (the save's rules: at most 64 keys of 4 KB JSON
  each). With a save they are added on top of the save's values.
- **Save slot** — continue from one of the project's save slots of the Play
  page (a project with a save schema).

MCP's `tl_play_start` takes the same options — `sceneId`, `variables`,
`save` (a project save document, `format: "thirdlight.save"`, at most 1 MiB;
loaded at the first step, an older version migrated) or `saveSlot` (`1`–`99`,
within the schema's slots), and `mode` (a game-mode id: checked when the
project defines game modes, otherwise ignored and named in the result's
`start.notes`). The backend checks them against the project (an unknown
scene, a save in a project without a save schema, a save newer than the
schema or a slot past its slots is refused) and the result echoes the
resolved start; `tl_game_observe` reports what the game did with it as
`start {ok, applied | reason}`. It works with the headless editor too (no
browser open).

## Debug commands

**Debug commands** are declared by the project's scripts:

```ts
ctx.debug?.command('giveItem', {
  description: 'Give the party an item',
  args: [{ name: 'item', type: 'string' }, { name: 'count', type: 'number', optional: true }],
}, (args) => { /* runs once per call, in this step */ });
```

The call also returns this step's calls (a list of argument objects) for a
script that prefers to loop over them. Every script instance that declares
the command receives each call, in the `intent` phase. The first declaration
fixes the arguments (a second one with other arguments stops the game with
the script error); at most 32 commands per game. A command runs **inside the
simulation step as part of that step's input** (the input frame carries it),
so it is deterministic and a recording that carries it replays it exactly;
`tl_game_observe` lists `debugCommands {registered, applied [{stepIndex,
name, args}] (the last 16)}` — the steps a playtest needs to reproduce a run.
Run one from:

- MCP: `tl_game_control` with `command: "debugCommand"`, `name` and `args`
  (refused with `game_command_invalid` when no script declared it or the
  arguments do not match);
- **Signals from tools:** the engine declares `signal {name}` in every game.
  `tl_game_control {signal: "door"}` (or the console's `signal door`, or
  `debugCommand` with `name: "signal"`) emits the signal in the next step as a
  script's `ctx.signals.emit` would: switches, movers, timelines
  (`playOnSignal`), effects, event sounds and scripts react, so they are
  testable without a script. Signals carry no value (a `value` is refused).
  It is input like any debug command, so a recording replays it;
- the **in-game console**: press **`** (backquote) in Play — it lists the
  commands (`help`), takes `giveItem lantern 2` (the declared order) or
  `giveItem count=2 item="iron key"`, and prints each call the game ran with
  its step. Play always has it. An exported game has it only when **Project
  settings → Engine → Debug console in export** (`debug_console`) is on —
  off by default, so a release build never ships a console by accident.
  The same setting shows the export's build line (snapshot, build id,
  play state) at the top left; a release game shows only its own UI.

## Frame statistics

`ctx.stats` (read-only; also `$flow.stats` for UI
bindings) gives `fps`, the frame time, the page thread's CPU time and the
GPU time (each `{avg, worst}` over the last 500 ms; GPU `null` where the
browser has no timestamp queries — never estimated), the last frame's draw
calls and triangles, resident texture bytes against the texture budget,
the loaded models' geometry bytes, the object count, the quality level and
the frame-rate cap the page draws under (`frameRateCap`, null: none).
It is presentation like `ctx.ui.view()`: not in the digest or a save. The
project setting **Engine → Stats overlay** (`stats_overlay`: 0 off and no
key, 1 shown with **F3** hiding it, 2 hidden until F3) draws them top right in Play
and the export. Play diagnostics carry the same `frameTimes` and the
environment renderer's post passes, quality, samples and fallback
(`renderer.environment`).

## Frame-rate cap

A game caps how many frames a second Play and the export
draw, so a phone with a 120 Hz display does not burn its battery drawing a
game that needs 30 or 60. The cap is **30, 60 or 120 fps, or none** (the
display's own rate, the default). Game time does not change with it: the
simulation keeps its fixed step and a frame that is not drawn runs its steps
in the next drawn one, so a recorded replay plays the same at any cap. Four
ways set it, all live:

- the project setting **Rendering → Frame-rate cap** (`frame_rate_cap`: 0
  none, 30, 60, 120; Project Settings → Quality) — the start value;
- a player's setting: a field of the save schema's settings document bound to
  the engine with `engine: 'frameRateCap'` — an enum of `30`, `60`, `120`
  and/or `none` — applies its value from the start (its default until the
  player changes it), again whenever the document is written, and is kept with
  the player's settings in the browser;
- the UI action `{ do: 'engine', action: 'setSetting', setting:
  'frameRateCap', value: 30 | 60 | 120 | 'none' }` (no value: `step` ±1 moves
  along 30 → 60 → 120 → none); the game shell keeps the player's choice with
  its volumes and quality and shows it as `$flow.shell.frameRateCap`;
- scripts: `ctx.display.frameRateCap` (30, 60, 120 or null) and
  `ctx.display.setFrameRateCap(fps | null)` (false for another value; in a
  visual script the **Frame-rate cap** and **Set frame-rate cap** nodes, 0 for
  none). Presentation like `ctx.stats`: not in the digest or a save.

How it paces: the page skips the animation frames that come early for the
cap and keeps the drawn ones on a fixed grid, so the average is the cap on
any faster display (144 Hz at 60 alternates two and three refreshes); a frame
less than half a refresh early still draws, so vsync jitter never halves a
60 Hz display at 30. A cap at (or within 10 % above) the display's rate draws
every frame, as does a cap above it. With the simulation in its worker the
tick for a drawn frame goes out on the animation frame just before it, so the
worker computes one frame per drawn frame and the input it samples reaches the
screen a display refresh later. Play diagnostics report `framePacing`
(`frameRateCap`, `drawnFrames`, `skippedFrames`, `displayMs`, and `pinned`),
the stats overlay shows the cap. The page URL flag `?frameRateCap=none|30|60|120`
pins the pacing whatever the game sets (Play takes the editor's); the
performance harness always runs with `none`.

## Ambient occlusion, render scale and dynamic resolution

Three render
settings a game sets in **Project Settings → Quality → Rendering** and a
player may change:

- **Ambient occlusion** (`ambient_occlusion`: 0 off, 1 SSAO, 2 GTAO) is the
  kind drawn where a scene's look turns AO on (Post → Ambient occlusion, its
  radius and intensity). A project that does not set it draws GTAO, so an
  existing game keeps its look; new
  projects (empty or from a template) are made with SSAO written into their
  settings. It darkens only the *indirect* light — ambient, sky and probe
  light, reflections, and local lights shaded per vertex (they join the
  ambient light) — in creases and corners; the sun and per-pixel lamps are
  never dimmed. With AO off (the look, a quality level or the setting) no
  lit pixel samples the occlusion; turning it on or off while a game runs
  builds the lit shaders again on the next frame (a short hitch, as a shadow
  map size change). SSAO is
  three's fast screen-space AO at half resolution; GTAO is darker and more
  exact, at about twice its cost. Each frame uses the occlusion computed from
  the previous one, reprojected (a surface just uncovered gets none for one
  frame; nothing is drawn twice). Transparent materials take none.
- **Render scale** (`render_scale`, 0.5–1, default 1) draws the 3D view of
  Play and the export at that share of the screen's resolution — 0.75 draws
  about half the pixels, the post effects included — and upscales it with AMD
  FidelityFX Super Resolution 1 (an edge-adaptive upscale, then sharpening).
  The Scene view always draws at full resolution. A colour sky is shown as
  its colour (not tone mapped) under a render scale or dynamic resolution
  as at full resolution, so Play and the Scene view agree; an image sky under
  a render scale is tone mapped with the scene.
- **Dynamic resolution** (`dynamic_resolution`, 0 off — the default — or 1)
  lowers the render scale, down to 0.5, while the GPU takes longer than a
  frame and raises it again, up to the render scale, when it has room. A
  frame is the interval of the cap the frames are paced by (a page's
  `?frameRateCap=` pin over the game's; no cap: 60 fps), never shorter than
  the display's refresh (a 50 Hz display, or a cap of 120 on a 60 Hz one). It reads the GPU's time from timestamp
  queries (turned on for it); where the browser has none it reads the time
  between frames and only acts when the page's own work is well inside the
  frame (fewer pixels do not help a frame slow on the CPU). Decisions are
  made every 250 ms, a step down needs two slow windows in a row, a step up
  six fast ones predicted to stay fast at the higher scale, and a step up
  that does not hold doubles the wait for the next one, so the scale does not
  flicker.

A player's setting: a field of the save schema's settings document bound to
the engine with `engine: 'ambientOcclusion'` (an enum of `off`, `ssao`,
`gtao`), `'renderScale'` (a number field with `min` ≥ 0.5 and `max` ≤ 1) or
`'dynamicResolution'` (a bool) applies the value the player set — from the
start and whenever the document is written (the game's settings screen, or a
script's `ctx.saves.setSetting`). A field the player never changed leaves the
quality level and the project's setting alone: its default is what the
settings screen shows, not an override (the same for a `quality` field and
the project's starting level; volume and `frameRateCap` fields apply their
default from the start). The stored settings document keeps only the fields
the player set. The Saves panel gives a new binding its shape.
Play diagnostics report `renderer.render` (`ambientOcclusion`, `renderScale`,
`dynamicResolution`, the `scale` drawn now, `internal`: the scene's size in
pixels, and dynamic resolution's state: its source `gpu` or `frame`, the last
load, steps down and up).

## Quality levels

A project lists its own quality levels in **Project
Settings → Quality → Quality levels** (`environment.qualityLevels`, lowest
first; *Customize levels* starts from the engine's three); a project that
lists none has the engine's low (no bloom, ambient occlusion, depth of field,
anti-aliasing or MSAA), medium (no ambient occlusion or depth of field) and
high (the look as authored). *Starting level* is
`environment.quality` (absent: the highest). Each level has an `id` (what a
player's setting and game control name), a `name`, and changes only what it
sets:

- `post` — per effect (`bloom`, `ssao`, `dof`) the fields it lays over each
  scene's look *where the look has the effect on* (a smaller AO radius, a
  weaker bloom); `enabled: false` (Off) turns the effect off; `antialias`
  replaces the look's kind where the look has anti-aliasing (`none`: off). A
  level never turns on an effect or anti-aliasing the look leaves off, and
  tone mapping, exposure and grading stay the look's.
- renderer settings — `renderScale` (0.5–1), `pixelRatio` (1–2: the most
  drawing-buffer pixels per CSS pixel; absent 1), `msaa` (0 or 4 — WebGPU
  multisamples at 4 only; absent: the renderer's), `shadowMapSize` (512–4096:
  the largest shadow map any light draws; a light's larger own size is lowered
  to it), `localLights` (0–16 point and spot lights drawn at once),
  `shadowedLights` (0–16 point and spot lights drawing their shadow at once;
  absent: every one that casts — see [Interior lighting best practice](architecture.md#interior-lighting-best-practice-shadow-rules)),
  `ambientOcclusion` (off/ssao/gtao), `lodBias` (0.25–4, over `lod_bias`) and
  `dynamicResolution`. What a level leaves out is the project's setting; a
  value the player set in a settings field bound to `renderScale`,
  `ambientOcclusion` or `dynamicResolution` lays over the level, and the page flags (`?ao=`,
  `?renderScale=`, `?dynamicResolution=`) over everything.

The player's quality setting picks the level: a settings field bound with
`engine: 'quality'` (an enum of the project's level ids — the project check
refuses one it lacks), or the game shell's quality setting, which steps
through the levels in order. A running Play switches level for the rest of
the session with game control — `tl_game_control {command: 'setQuality',
level}` or `POST …/play/<id>/control {"command":"setQuality","level":"low"}`
(presentation only: not simulation input, not the player's saved setting;
a level the project lacks is refused) — to compare levels in one session.
Scripts read the level drawn in `ctx.stats.quality` (UI documents:
`$flow.stats.quality`). Play diagnostics report `renderer.quality` (`level`,
`levels`, `source` page/chosen/project/highest, `pixelRatioCap`,
`shadowMapSize`, `localLights`, `shadowedLights`, `lodBias`, `keyShadowMapSize`: the key light's
map as drawn) beside `renderer.render` and `renderer.environment` (passes,
samples). The page flag `?quality=<id>` pins a level (the perf harness's
`--switches quality=low`). The Scene view draws the starting level at full
resolution. A level change rebuilds the post stack only when the passes
change and frees the old one; shadow-casting lights are made again at the new
size.
