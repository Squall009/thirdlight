# Measure and budget performance

**Goal:** know what your game costs on the machines you target, find what
is expensive, and keep it inside budget. The engine's own measuring tools
are described in [Performance](../features/performance.md).

## What to aim for

The engine is designed for **60 fps at 1920 × 1080 on an integrated GPU**
and measured there. These are soft targets: they guide design, and a miss
is recorded with its cause, never a reason to throw working progress away.
For level-building content the engine aims at:

| Measure | Target |
|---|---|
| Whole frame | p95 ≤ 16.7 ms, GPU and CPU |
| Terrain GPU time | ≤ 2 ms |
| Scatter and ground cover GPU time | ≤ 3 ms |
| Terrain and scatter draw calls | ≤ 60 |
| Main-thread work for terrain, scatter and streaming | ≤ 2 ms a frame |
| Frames over 16.7 ms while streaming or re-baking | none in a 60 s flight |
| Generated architecture | ≤ 5 ms a chunk on a worker; the spawn's chunks ready ≤ 100 ms after load |

Use the same numbers for your own game unless you target something else.

## Look at it while you play

- **The stats overlay:** **Project Settings → Gameplay → Engine → Stats overlay**
  (`stats_overlay` 1: shown, **F3** hides it; 2: hidden until F3). It shows
  fps, frame, CPU and GPU time, draws and triangles, texture and geometry
  memory, the object count, the quality level and the frame-rate cap, in
  Play and the export.
- **Scripts** read the same numbers from
  [`ctx.stats`](../reference/script-api.md#ctx-stats) (UI documents:
  `$flow.stats`) — for a debug HUD, never for game rules.
- **Play diagnostics:** `tl_diagnostics` (or `POST …/play/<id>/diagnostics`)
  carries `frameTimes`, `framePacing` and per-system blocks:
  `renderer.terrain`, `renderer.streaming`, `renderer.architecture`,
  `renderer.probes`, `renderer.lod`, `runtime.blockMemory` and more.
- **Switches** on the game page's URL turn one feature off to see what it
  costs: `?probes=off`, `?shadowcache=off`, `?batching=off`,
  `?terrain=off`, `?scatter=off`, `?splines=off`, `?architecture=off`,
  `?portals=off`, `?quality=<id>`, `?renderScale=0.75`. On the editor's URL
  they are passed on to Play.

## Keep it inside budget

- **Cap the frame rate** (`frame_rate_cap` 30, 60 or 120): a phone with a
  120 Hz display does not burn its battery drawing a game that needs 60.
  Game time does not change with the cap.
- **Quality levels** let the player trade picture for speed (render scale,
  shadows, lamps, ambient occlusion); **dynamic resolution**
  (`dynamic_resolution` 1) lowers the render scale by itself while frames
  run long. See [lighting](lighting.md).
- **Memory budgets** are project settings: textures (`texture_budget_mb`,
  512 MiB) and world streaming (`streaming_budget_mb`, 768 MiB). See
  [Streaming and budgets](../concepts/streaming-and-budgets.md).
- **Thin and shorten:** density falloff and impostors on scatter and
  instance sets, shadows only near the camera, wind only near (the foliage
  policy in [Terrain](../features/terrain.md#foliage-best-practice-the-foliage-policy)),
  a shadowed-lamp budget for interiors.

## Measure a build

From an engine checkout, with the backend built:

```sh
node tools/perf/run.mjs village               # the engine's reference scene, both renderers
node tools/perf/run.mjs level --classes landscape
tools/perf/games.sh ~/projects/my-game         # a copy of your game, measured the same way
```

The harness measures the export on the host's GPU at 1920 × 1080: frame
p50/p95/p99, main-thread time, draws, triangles and GPU time per pass. It
works on copies, never on your game's folder. Reports go to
`~/.cache/thirdlight-perf/reports/`.

## Which to use

While you build, watch the stats overlay in Play. When something is slow,
read Play diagnostics (the editor's Play, or `tl_diagnostics` from a script
or an AI tool) and turn features off with switches to find the cost. Run the
harness on a copy of your game before a release, on the slowest machine you
support.

## Pitfalls

- **Measure uncapped and on the real GPU.** A capped frame hides its cost;
  a software renderer (SwiftShader) says little about a player's machine.
- **The Scene view is not the game.** It draws everything at full
  resolution and keeps every streamed tile loaded; measure Play or the
  export.
- **`ctx.stats` is presentation:** it is not in replays or saves, and a
  game rule that reads it would differ between machines.
- **GPU time is `null` where the browser has no timestamp queries;** it is
  never estimated.
