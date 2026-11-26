# The picture set

How a phase's looks are judged: a fixed list of pictures taken by one command, opened by an agent who writes
what it sees and what is wrong, then looked at by the owner. No pixel percentages, no timing bounds: a picture is
read, never measured against a threshold.

## The list

`tools/voxel-bench/picture-list.ts` is the one list: each picture's id (the same from phase to phase), title and
one line of what to look for.

- **L1–L24, world pictures**: the lighting bench's reference cameras and rooms (`lighting-cameras.ts`) on the
  8 km town of staging's `voxel-slice` project (world `far`, staged once by `run.mjs far-world`; nothing is
  generated per run), low tier, WebGPU, 1280 × 720, at the tier's cap. Two `light-shots` runs: the day run
  (two lit props, the L-shaped room) and the lamps run (128 lamps). **L23 and L24** are the fog bank
  (`bench-fog.ts`): a hollow dug into the town's empty lot beside the room camera's house and filled with a gas
  material by one `flood` stroke with a fade, written through the commands before Play and taken out after by
  the project's undo (the world's files end as they were); L23 from 17 m off and 6 m up, L24 from inside the
  bank, 1.7 m over the hollow's floor, looking up at its rim. Their facts hold the gas as drawn (the hull's
  triangles, whether the eye stood in gas) and what the bench wrote.
- **E1–E8, editor screens**, 1600 × 900: the editor with a scene, structure mode, a water body, a spline road (a
  fresh backend's made yard), the voxel world page and Play with the Profiler (staging's town), and the world mode
  (E7, last on the yard: a hill raised, smoothed and painted there by the strokes the mode's brush sends, then one
  Add stroke dragged with the real pointer; the view before that drag is kept beside it in the raw folder as
  `screen-world-mode-before-drag.png`, and the picture's facts say what the drag did), and its Fill rail (E8, after
  E7: two hollows dug by commands, a gas material made; then with the real pointer one stroke of the fog brush, a
  fog fill of the far hollow with its level dragged down, and a fill of the near hollow, which a trench breaches, so
  it is refused and its leak marked. The facts hold each command's answer and the Scene view's gas as drawn; the
  same view with the panel's fog view switched to Density is kept beside it in the raw folder as
  `screen-world-fill-density.png`).

Every picture waits for the engine's own settle signals: streaming still, nothing pending in the simulation, no
texture level loading and the light volume settled (world pictures); the Scene view's worlds and grids settled
with no frame wanted, the page's `settle`, or Play's counts still and the light volume settled (screens). A
picture that does not settle in time is kept as `<id>-…-UNSETTLED.png` and listed "did not settle: <what>".

Changing the list: add an entry (a new id, never a reused one), keep it about 30 pictures (the owner's default; 32 with 47b.7's two),
and say in the phase's results what was added or dropped.

## Running it

```
tools/gate.sh start pictures; tools/gate.sh wait     # alone, detached (about 15 minutes)
tools/gate.sh start phase; tools/gate.sh wait        # the phase run: it takes the pictures after the perf report
```

`TL_PICTURES_DIR=DIR` puts the pack in `DIR/<run>/` (default `~/.cache/thirdlight-pictures/<run>/`). The command
itself is `node tools/voxel-bench/run.mjs pictures --out DIR [--only L1,E2]` inside a capped scope. It needs the
GPU: on a host without one it takes nothing (software rendering is not the product's look). It starts staging
when staging is not running and stops it after; nothing is left running.

The pack: one PNG a picture (`L01-street-noon.png` …), `pictures.json` (id, title, what to look for, file, settle
state, the bench's speck count for world pictures, capture facts), `README.md`, `perf-report.md` (the newest phase
performance report beside the one before it) and `read.md`, the skeleton of the read. The benches' own output
(every picture they took, their JSON and logs) is in `<pack>.raw/`.

A picture that could not be taken or did not settle within its timeout (120 s a screen, `SETTLE_MS` in
`editor-screens.ts`; a world picture's camera light-shots' `--timeout`, 180 s by default) turns `pictures` and
the phase run RED: the run could not do its job. Besides the timeouts that only catch a hang (a unit test's 30 s,
the boot check's start timeouts), that settle timeout is the only time-dependent red in the suite: no unit test
and no boot test asserts a wall time. What a picture shows never turns anything red.

## The read

The agent opens every picture (the Read tool shows images) and fills `read.md`, one block a picture:

```
## L4 — Street at night
Sees: one or two plain sentences of what is actually in the picture.
Wrong: what looks wrong (light leaks, specks, banding, black or empty areas, half-loaded or missing textures,
       wrong scale, UI overlapping), or "nothing seen".
Sure: high / medium / low, and why when not high.
```

Then five lines at the top: how many pictures, how many with something wrong, the three things most worth the
owner's eye.

The honesty rule: write what the picture shows, not what the code should produce. Never "looks correct" without
saying what was looked at. "Cannot tell" with the reason is an answer. A read is a first pass for the owner, not
a verdict. The speck count beside a world picture is a recorded number for comparing one camera across phases,
never a pass or fail.

A defect seen gets a D-row in `docs/audit-2026-09-22.md` naming the picture's id; it is not fixed in the read.

## The review page

The owner's page shows two phases, the one being worked on and the one before it, nothing else; each in one
fixed form he can answer with yes or no. One tool builds it, `tools/review/add-phase.mjs` (unit test beside it):

```
node tools/review/add-phase.mjs <phase> --pictures <pack dir>                 # a phase's picture set
node tools/review/add-phase.mjs <phase> --acceptance docs/briefs/acceptance-<phase>.md   # its acceptance text
node tools/review/add-phase.mjs <phase> --title "<title>"                      # rename a section
```

`<phase>` is the phase id in lower case (`47t`); every part of a phase goes under it, in one section. The parts
are copied into `~/.cache/thirdlight-owner-review/<phase>/` (`--root DIR` for another root), so the page needs
nothing outside its folder. Adding a third phase drops the oldest: its section leaves the page and its folder
under the root is deleted (only there; it prints the megabytes freed). The acceptance text stays in the repo; when
it is two phases old it moves to `archive/briefs/` with `git mv`.

A section reads, in this order: **What changed** (the acceptance text's list), **Pictures** (the pack's pictures,
those whose read says something is wrong or that did not settle first and marked, each with its Sees, Wrong and
Sure; a click opens the full picture), **What is wrong** (the read's summary and the acceptance text's list),
**Numbers** (the perf report's table, the picture run's time, the acceptance text's list), **Questions**. A part
not given shows "not provided"; nothing is filled in.

The acceptance text's form (other sections may follow; the page links the whole text as "full text"):

```
# 47T — the test suite reset

## What changed
- at most five lines

## What is wrong
- the new D-rows and what the owner should know is broken

## Numbers
- the check's and the phase run's times, anything measured

## Questions
1. The question in one or two sentences. Default: what stands if he does not answer.
2. … at most five, each with "Default:"; an answered one adds "Answer: …"
```

The tool refuses a text with more than five "What changed" lines, more than five questions or a question without
its default.

The page is served by `python3 -m http.server 8766` in `~/.cache/thirdlight-owner-review` (started with
`setsid nohup`; it does not survive a restart), at `review.html` (and `index.html`): check `curl -s -o /dev/null
-w '%{http_code}' http://localhost:8766/review.html` answers 200, then that one picture's URL opens.
