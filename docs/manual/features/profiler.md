# The frame profiler

The engine keeps a profile of every game page's last frames (Play and an exported game): how long each thread
spent in a frame, by what it spent it on, against the quality tier's frame budget, and what every thread was
doing in the frames that ran long. Three places show it: the editor's **Profiler** tab while Play runs, a small
view in the game's **stats overlay** (Play and the export, off by default), and **`tl_diagnostics`** for an agent.
A profile is saved as a **capture file** from the tab or the overlay, and the tab opens one again. How the data is
recorded (spans, the budget table, the frame arbiter) is in [Performance](performance.md).

## The Profiler tab

Open **Window → Profiler** (or the **Profiler** tab of the bottom dock) and start Play. The tab reads the play
page about twice a second while it shows (only what arrived since its last read) and keeps the last 120 frames of
every thread, as the page does. Nothing is read while the tab is closed.

- **Timeline.** One column a frame of the page, newest at the right; one lane a thread: the **page** (the frame's
  host work, scene sync, culling, draw submission, voxel draws made), the **simulation** worker (its ticks that
  started in that frame: scripts, physics, voxel streaming, animation) and the **job workers** (each voxel job's
  time on its worker, shown per worker). Each bar is stacked by category, one colour a category (the legend under
  the timeline). The dashed amber line half way up a lane is the frame interval at the cap (33.3 ms at 30 Hz):
  a bar past it took longer than a frame. A red tick over a column marks a long frame (a missed frame, or a
  thread's own work past the interval). Under the lanes, the **GPU** as the render and compute passes' shares
  of its last timestamp read; never milliseconds at a frame-rate cap (the GPU's clock follows its load there),
  and "not measured" where the renderer has no timestamps. Hover a column for its numbers; click it to select it.
- **Frame.** The selected frame (the newest until you click one): the page's spans as a tree (name, category, ms,
  own ms without what ran inside), the simulation's ticks in it each with its spans, and each job by worker.
- **Budget.** The tier's budget per thread and category (low 30 Hz, medium and high 60 Hz), beside the mean and
  worst own time a frame over the kept frames and the use; a category over its budget is marked red. Under it the
  GPU's planned shares and the frame arbiter's time slices (what the streaming and upload steps may each spend a
  frame: a table of limits, not a scheduler; they are not summed against the frame).
- **Counters.** Draw calls and triangles of the last frame, instance copies (and those in view), page heap,
  texture and geometry memory, GPU resources, voxel chunks, instances, triangles and far-field memory, the job
  queues, and the profiler's own cost (spans a frame and a span's cost). Under them the **Memory** table: every
  memory budget of the tier (voxel streaming, physics memory, the far nodes drawn, a scene's objects, the far
  field on the GPU, streamed textures, streamed scene cells, the surface cache, probe tiles, the voxel undo in the
  backend), each with the bytes its system holds now, its budget (the project's own where it sets one: textures,
  scene streaming) and the use; a budget whose system keeps no count on the page reads "not counted here". The
  last two rows add up the page's (with its workers') and the GPU's budgets and what they hold, against the tier's
  hardware target (low: page 1,536 MiB, GPU 2,560 MiB of an 8 GB machine; medium and high have none of their own
  yet). The simulation worker's share (the voxel streamers, physics) arrives with its ticks.
- **Spikes.** The last 8 long frames, each kept with every thread's frames over it; **Open** shows those frames in
  the timeline and the Frame view ("what every thread was doing"), **Back** returns.
- **Pause / Resume** freezes the view to inspect it (the page keeps recording). **Save capture** writes the
  profile as a file; **Open capture…** shows a capture file in the same views, marked as a file (**Back to live**
  returns to the running Play).

**Measure GPU** (in the bar, while Play runs on WebGPU) measures how many GPU milliseconds a frame each kind of
pass costs: the voxel world's near surfaces and kit pieces (`near`), its far field (`far`), the shadow maps
(`shadows`), the live light's passes (`lighting`: the surface light, probes and reflection tracer), the post stack
(`post`) and the particles with the interaction field (`effects`). It takes one to two minutes and loads the GPU
past its frame-rate cap meanwhile (the picture keeps drawing, slower; measure nothing else at the same time). The
bar shows its progress (**Stop measuring** ends it, everything shown again). The result fills the **Budget** view's
GPU tables: each kind's ms with its spread, or "below resolution" when the run cannot tell it from nothing (never a
negative number), the run's resolution, the whole frame's GPU ms, kinds with no pass on this page, and each GPU
budget row (render, lighting, effects, other: the tier's shares of the frame) with what was measured against it.
How it works: the frame is loaded past its cap so the GPU runs at its busy clock (at the cap its timestamps follow
its clock, which slows when it idles), each kind is hidden for a window between two windows with everything shown,
and the frames are timed by when the GPU finished them; the sequence repeats five times. WebGL 2 answers "not
available". The room at the cap (how much more the frame can take) is the headroom bench's
(`node tools/voxel-bench/run.mjs headroom`), which also runs this measurement.

## The overlay (Play and an export)

A project opts into the engine's stats overlay with **Engine → Stats overlay** (`stats_overlay`: 1 shown, 2
hidden until **F3**; 0, the default, no overlay and no key). With it on, **Shift+F3** adds the profiler's view
under the stats (and shows the overlay if it was hidden); Shift+F3 again hides the view, F3 the whole overlay.
The view shows the tier and cap, each thread's own ms a frame with its three busiest categories as
`ms/budget ms`, the categories over budget, the GPU's pass shares and the last long frame with its longest spans,
a **Save capture** button and a **Measure GPU** button (the same measurement as the tab's; its progress and then each
kind's ms and the GPU budget rows show as lines of the view). It works in an exported game served on its own, with no editor or backend. The
profile is read only while the view shows (once a stats window, every half second): hidden, it costs nothing.

## Capture files

A capture is one JSON file, `thirdlight-profile-<date>.json`:

```json
{
  "version": 1,
  "kind": "thirdlight-frame-profile",
  "header": { "build": "<the Play or export build id>", "tier": "low", "quality": "low", "frameRateCap": 30,
              "renderer": "webgpu", "date": "2026-11-13T18:01:02.345Z", "source": "editor | play | export" },
  "report": { "...": "the page's profile read, as window.__tlProfiler.read() returns it" }
}
```

The report holds every thread's frames (`threads.page | sim | jobs`, each frame with its start on the wall clock,
its ms, own ms by category and its spans), the counters, the GPU's pass shares, the budget rows, the arbiter's
slices, the spikes and the profiler's cost; `counters.memory` (the Memory table) and `gpu.measure` (the GPU
measurement's state and last result) are optional, so older captures of version 1 still open (without them). A reader refuses another `version` (and says which it reads); a newer
engine adds a version, never changes this one.

## For agents: `tl_diagnostics`

`tl_diagnostics {playSessionId, sections: ["profile"]}` returns the profile's digest (at most 6 KiB): the tier,
rate and cap; per thread its mean own ms a frame and each category's mean, worst, budget and use; the categories
over budget; the counters (with `memoryMiB`: each memory budget's MiB resident and budgeted, and the page's and
GPU's sums against the tier's target); the GPU's pass shares; the worst long frame kept with its longest spans per thread; the
profiler's cost, and the GPU measurement's state in a few numbers. It is left out of an answer that does not name it.
`sections: ["gpuMeasure"]` starts the GPU measurement (unless one runs) and answers its state at once;
`sections: ["gpu"]` reads its state or result (per kind `ms` or null below resolution, `medianMs`, `spreadMs`,
`resolutionMs`, the budget rows) and starts nothing: poll it every few seconds until `state` is `done`. The digest is made on the play page from the
same profile the Profiler tab reads, through the same relay as the rest of a Play's diagnostics.
