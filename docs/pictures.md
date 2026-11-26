# The picture set

How a phase's looks are judged: a fixed list of pictures taken by one command, opened by an agent who writes
what it sees and what is wrong, then looked at by the owner. No pixel percentages, no timing bounds: a picture is
read, never measured against a threshold.

## The list

`tools/voxel-bench/picture-list.ts` is the one list: each picture's id (the same from phase to phase), title and
one line of what to look for.

- **L1–L22, world pictures**: the lighting bench's reference cameras and rooms (`lighting-cameras.ts`) on the
  8 km town of staging's `voxel-slice` project (world `far`, staged once by `run.mjs far-world`; nothing is
  generated per run), low tier, WebGPU, 1280 × 720, at the tier's cap. Two `light-shots` runs: the day run
  (two lit props, the L-shaped room) and the lamps run (128 lamps).
- **E1–E6, editor screens**, 1600 × 900: the editor with a scene, structure mode, a water body, a spline road (a
  fresh backend's made yard), the voxel world page and Play with the Profiler (staging's town).

Every picture waits for the engine's own settle signals: streaming still, nothing pending in the simulation, no
texture level loading and the light volume settled (world pictures); the Scene view's worlds and grids settled
with no frame wanted, the page's `settle`, or Play's counts still and the light volume settled (screens). A
picture that does not settle in time is kept as `<id>-…-UNSETTLED.png` and listed "did not settle: <what>".

Changing the list: add an entry (a new id, never a reused one), keep it about 30 pictures (the owner's default),
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

A picture that could not be taken or did not settle turns the run RED: the run did not do its job. What a
picture shows never turns anything red.

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

## Publishing

```
python3 ~/.cache/thirdlight-owner-review/add-phase.py <id> "<title>" <pack dir> <pack dir>/read.md
```

The review page is served by `python3 -m http.server 8766` in `~/.cache/thirdlight-owner-review` (started with
`setsid nohup`; it does not survive a restart): check `curl -s -o /dev/null -w '%{http_code}'
http://localhost:8766/` answers 200, then that the page lists the pictures and one image URL opens.
