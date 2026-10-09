# Play tools

What the MCP play tools (and their HTTP routes) do: driving a play step by
step, the engine's version, headless play-tests, screenshots, replays,
plays that ended, where a Play's start time went and how a Play loads.
Connecting MCP: [Deployment](../../deployment.md#mcp-coding-harness); step
by step: [the play-testing guide](../guides/playtesting.md).

## Driving a play step by step

`tl_input_exercise` drives a play step by step. A frame may
hold for `steps` steps (up to 7,200 in one call; its first step as written,
the rest with pressed actions held); steps no frame covers are neutral. A
frame's `ui` edges (`up`, `down`, `left`, `right`, `submit`, `cancel`,
`pause`) drive menus like the keys, also while the game is paused. Its
`pointer` goes through the UI hit test: a press and release on a UI button
clicks it, and scripts read `ctx.input.pointer().overUi` (the real mouse
too). A `gamepad` `{buttons, axes}` is a virtual standard pad read through the
project's bindings. `tl_game_observe` lists the shown widgets' rectangles in
`ui.elements`. With `restart: true` the exercise restarts the
game and applies its frames from the new run's first step;
`tl_game_observe`'s `run.lastInput.digest` is the world's digest right after
its last step, so the same frames run twice give the same digest when the game
is deterministic. With `hold: true` the game holds right after
the exercise's last step until the next exercise, which begins at exactly the
next step: a tool can observe, decide and go on step for step, whatever the
time between its calls. `tl_play_start {threads: "worker"|"single"}` picks
where one play's simulation runs; start `variables` apply at the start and
again at every restart (a replay, a shell's New game).

## Which engine is running

`tl_inspect target="engine"` (or
`GET /api/v1/engine` with any token) answers the version, commit and lockfile
the backend started with, the build it started with (`dist/build-info.json`,
written by `npm run build`), its start time, and `dist.newerThanProcess`: true
when dist/ was rebuilt after the backend started — restart the service
(`sudo systemctl restart thirdlight`) to run it. Graph materials are compiled
by the backend when it loads a project and after every change:
`tl_diagnostics` lists the broken ones in `materialProblems` (and logs a
`material_graph_problems` entry when problems appear), and
`tl_content_query target="materials"` pages every material with its
problems (`withProblems: true` for the broken ones only).

## Headless play-tests

`node tools/playtest.mjs <game folder>
--input script.json` (or the MCP tool `tl_playtest {frames}`) plays the game
from its start with an input script — `tl_input_exercise` frames counted from
the run's first step, as long as an hour — and prints JSON: per run the run
digest and the observed fields (`--fields player,ui.values`, `--at 60,400`
for observations inside the run) and whether the runs agreed. `--runs N`
plays it N times, `--threads both` in the simulation worker and on a single
thread; every run begins with a restart and the script is sent as exercises
that hold the game in between, so the runs of a deterministic game give the
same digests. `--driver bot.mjs` runs the project's own driver instead: a
Node module of the game folder whose default export `async (game) => result`
plays each run with `game.step(frames)` (returns the observation after them),
`game.wait(n)`, `game.observe()` and `game.log()` — a genre's test bot is
game code and lives in the game's repository; the engine ships none. Drivers
run from the command line only (the MCP process runs no project code). With
no editor open the backend plays in its headless editor; the game runs at its
step rate. The exit status is 0 when every run finished and they agreed.

## Screenshots

`tl_screenshot` draws the game's UI (documents, fades, the pause panel,
overlays) over the frame; `ui: false` (also on the HTTP route) gives the
frame alone. It always answers: a capture the preview cannot make comes back
as `relay_failed` with the preview's code in `cause` (`screenshot_failed`,
`render_failed`, `not_ready`) and its reason in the message. A PNG over the
1 MiB bound is captured again at a smaller width; the reply's `width` says
which. It works the same on the WebGPU and WebGL 2 renderers.

## Replays

`tl_game_control` `replay` answers once the restart is applied: `runId` is
the new run (`<snapshotId>#<run>`, the run counting every restart of the
play) and `restart {state: "applied", atStep}`. When the game takes no step
within half the relay's timeout (paused, held by the debugger, a
busy page), it answers `restart {state: "pending"}` with the run id the
restart will have; the restart still applies at the next step, and
`tl_game_observe`'s `runId` shows it.

## Plays that ended

A play that has ended says why. `tl_game_observe`, `tl_diagnostics`,
`tl_game_control`, `tl_screenshot`, `tl_input_exercise` and `tl_play_stop`
on it answer `play_not_found` with `ended {reason, presented, at, detail?}`
(`request`, `preview_failed` with the preview's code and message,
`preview_timeout`, `expired`, `session_lost` — the editor page that ran it
closed, reloaded or lost its connection, or the owner's browser took the
project over from the headless editor) and the reason in the message. A play
that ended before it was presented (other than by a Stop or a reported
preview failure) is also listed in the project's problems
(`tl_diagnostics` without a play id). An id the backend never had (for
example after a backend restart) stays a plain `play_not_found`. The
backend keeps the last 64 ended plays for an hour (their end, not their
scene); an older one answers a plain `play_not_found` too.

## Where a Play's start time went

`tl_diagnostics` on a play
has `startTimings` — stages in ms from the preview page's time origin
(`epochMs`): `bundleFetch`/`bundleEval` (the game bundle), `handshake`,
`snapshot`, `manifest`, `startScenes`, `worker` (overlaps the reads),
`assets`, `mount`, `models`, `ready`, `rendererInit` and `firstRender` (the
first drawn frame's own call), then `firstFrameMs` and the frames in the
10 s after it (how many over 50/100/250 ms, the worst eight), and each scene
loaded during play (request, read, the frame that attached it, the frames
after). The reply's `buildTimings` is the backend's part (session, state,
capture, bundle, `closure.*`, publish, total); the play-start reply carries
the same as `timings`.

## How a Play loads

A Play (and an exported game) builds its shaders before it shows the first
picture and before it shows a scene loaded later: the
`precompile` stage above, and `renderer.precompile` in the diagnostics
(runs, failed, gave up, the last one's ms). Meanwhile the previous picture
stays. Repeated objects of one material are drawn with one shader however
many batches or instance-set chunks they form (`renderer.batching.programs`;
`renderer.instanced` counts both).

From the second Play on, the browser takes the game's scripts and the
project's files from its cache: the preview origin serves the
game bundle and the worker scripts under `/play-build/<digest>/`, and a
project's models, textures, scene files and compiled scripts by their digest
under a per-project address, with `Cache-Control: private, max-age=31536000,
immutable` and the digest as `ETag` (a proxy in front of the preview origin
should pass these headers on). The page still checks every file against the
build before using it. The addresses change when the backend restarts.

A Play (and an exported game) reads only its start scenes' files before it
starts: the models, textures and bakes its start scenes use,
eight at a time, each checked against the build. A scene loaded later reads
its own when it loads (see [Scenes: preparing a scene](scenes-and-cameras.md#preparing-a-scene-and-scene-transitions)), and a sound is read when it first plays. The
diagnostics' `assetReads` counts what has been read so far.

The first picture of a Play or an exported game waits for its start scenes'
models, so it shows the whole world; textures a material asks
for later, instance sets, clips and sounds arrive after. A Play that is still
loading keeps sending progress: the 15 s present timeout counts from the
last progress (a stage done, a file read, a model prepared), not from the
start, so a large project is not stopped while it loads and a hung one still
is.

## Component and content descriptors

`tl_content_query {target:"game", includeDescriptors:true}` also returns the
component and content descriptor registry: for every component and content
block, each field's type, unit, range, step, default, group, label, tooltip,
when it applies and which Scene-view handle edits it (about 120 KB; the
command route answers `queryGameConfig {args:{descriptors:true}}` the same
way, and the editor reads it with its first game query).
