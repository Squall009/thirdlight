# Handoff: lead for phase 46e-b (the voxel light volume built out, then rooms, culling, the walk graph)

You are the lead for phase 46e-b of the Thirdlight engine. You orchestrate and verify; Opus sub-agents write the
code. Run 46e-b to its close (items 46e.9–46e.19) without stopping to ask the owner, unless you hit one of the
stops below. The item list and its order are approved by the owner (2026-11-16).

## Where things stand

- 46e-a is done (closed at 34253940; the 46e-b plan at dec0c2c5; this handoff's commit is the start commit of 46e-b:
  use it for `tools/gate.sh start phase <commit>` at the close). It built voxel shadows and the sun field, one
  occupancy walk, open regions, GPU time per pass in the profiler, and two lighting stores with a hybrid for an A/B.
- The owner chose **the voxel light volume**. The surface cache's voxel port and the hybrid are still in the tree
  behind `?voxelLight=cache|hybrid`; removing them is your first item. Every store is off by default; shadows and
  the sun field are on at every tier.
- Work only in the worktree `/home/dadmin/projects/thirdlight-p45` (branch `phase-45`). Never touch
  `/home/dadmin/projects/thirdlight` (main, frozen, production) or any game repo.
- Next free D-number: **D711** (D700–D799 is reserved for the branch). three.js is 0.187.0 = the pin (checked
  2026-11-14): check again at the start, assess and record, never update.
- The previous lead's running notes: memory file `phase46e-a-autonomous-run.md`. Start your own
  (`phase46e-b-autonomous-run.md`) and log each item as it closes.

## Read first, in this order

`AGENTS.md`; `docs/architecture/voxel-engine.md`; `docs/decisions/owner-decisions.md`; `docs/plan-phase-46e.md`:
§1–§5, §6 (the 46e-b table is your contract), §8 (spec steps), §8b (the A/B: what the volume cost and looked like),
in §8a only "46e.6a", "46e.6b", "46e.8 — travel fixes" and "46e.8 — the close", §9's entries of 2026-11-16, §10;
`docs/briefs/acceptance-46e-a.md` (what the owner saw); `docs/plan-phase-45.md` §5c (the volume as proposed);
`docs/briefs/voxel-agent-brief.md` (the item agents' standing brief: its last section is 46e-a's). The volume's code:
`packages/three-adapter/src/voxel-light-volume.ts`, `-layout.ts`, `-wgsl.ts`. The open rows you will meet: D448,
D662, D667, D672, D675, D690, D692, D695, D696, D701–D709 in `docs/audit-2026-09-22.md`.

Before the first item: add a "46e-b" section to `docs/briefs/voxel-agent-brief.md` (current phase, what to read, the
scope fence below, how lighting items are measured, D711 next) and commit it. Tag the tree before the removal so the
A/B's code stays easy to find: `git tag ab-46e-a dec0c2c5 && git push origin ab-46e-a`.

## What the owner has decided (do not ask again)

- The store is the voxel light volume. The cache's voxel port (charts, face hashes, chart worker) and the hybrid are
  removed first. Phase 42's own stack is not touched; it retires in phase 48. The hybrid with the cache's texels
  near is not measured.
- **No tuning first.** The order is: remove → the default path's cost → the emissive proposal → every light type in
  the volume → the observed defects, fixed on the update side → only then the tuning, on the town and on a
  many-lamps scene → props and particles → rooms → culling → the walk graph → close.
- Every light type: a per-brick lamp list in world space built in compute (replacing the flat loop in
  `voxel-light-volume-wgsl.ts` `direct_light`; the clustered lists are per camera and cannot serve bricks off
  screen); spot lights bounce with their cone; area lights add bounce; emissive materials.
- Emissive: "the glow is a property of the voxel's material, not stored per voxel. The volume keeps it per cell the
  way it keeps the bounce colour. Propose the add-only material format entry for my approval before building it."
- The look is fixed where cells are written (accumulate while idle, filter as cells are written), not in the
  per-pixel read, so the tuning cannot undo it.
- Shadows and the sun field stay on at every tier. Fix D667, D675, D701; trace D672 (page render +0.9–1.8 ms with no
  store) and the end-of-phase round that held only 7 copies of room at the cap.
- The low tier's target is 720p at the 30 Hz cap.
- Not in scope: a compute build of the clustered light lists; baking the volume to disk; any saved light.

## The items (plan §6; quote the row in each brief)

46e.9 remove the cache port and the hybrid → 46e.10 the default path's cost → 46e.11 the emissive material entry
(proposal, then a stop for that part only) → 46e.12 every light type in the volume (a lamp list per brick, b spot
cones, c area lights, d emissive after the owner's note) → 46e.13 the observed defects on the update side (D692,
dark rooms, D695, D696, D690) → 46e.14 a many-lamps scene, then the tuning (D705 read cost, the update's share, the
low tier's setting; D702, D703, D708 as constants become settings) → 46e.15 props through the coverage channel
(D448) and particles → 46e.16 rooms from regions → 46e.17 connectivity culling, measured, built only if it wins →
46e.18 the walk graph on a generic A* core → 46e.19 close.

Defaults the previous lead chose and the owner let stand, with what to do about each:

- **Emissive approval gates more than 46e.12 (d).** The tuning (46e.14) is meant to be done once, on every light
  type. Write the 46e.11 proposal as the first thing after 46e.9, publish it to the owner at once (one page: the
  entry, what a designer sets, what the volume stores, one picture or mock of the result), and carry on with 46e.10
  and 46e.12 a–c. If the owner's note has not come when 46e.13 is done, do not tune without emissive: go on to
  46e.15–46e.18 (they do not depend on it) and come back to 46e.12 (d) and 46e.14 when it arrives.
- **"Dark rooms" is not yet a diagnosed defect.** With either store a room read 5–10 of 255 against the street's
  ~100, in stills taken with auto-exposure off. First find out whether energy is lost (the 24 m ray reach, the
  bounce count, the 0.3 grey fallback for materials with no colour, sky rays ending at unknown space); fix what is
  lost. Then show the room with the camera's auto-exposure on, as a game would run it. Do not add an artificial
  fill light as a default; if the room is still too dark to play in, offer a per-scene minimum as a question.
- **The many-lamps scene** (default chosen, owner to confirm): engine-owned bench data, lamps of every type (point,
  spot, area, and emissive once approved) in the town, at three sizes (about 32, 128 and 512 lights), some indoors.
- **A moving sun was never measured.** The sun field re-marches while the sun moves (D675) and the volume would
  relight. Add a time-of-day run (the sun moving at a game's pace) to 46e.14's measurements on the town; record what
  it costs and give the low tier a setting if it does not fit.
- **An interim look page after 46e.14** (lighting complete): publish the five cameras and the many-lamps scene
  before/after as an acceptance page for the owner, without stopping; carry on with 46e.15.
- Props and particles (46e.15) come after the tuning, as approved; re-measure the volume's update on the town and the
  many-lamps scene once props are in its rays and record the difference.

## How to run it

- One item at a time, in the order above. Split an item into a/b/c slices where it is more than one agent can finish
  and verify (46e.12 by light type; 46e.14 as scene / measure / tune; 46e.9 may need two: code, then tests and docs).
- Launch each item or slice as a fresh sub-agent on the Opus model with a written brief: the goal, the plan row
  quoted, the files and modules to reuse (plan §5), what is out of scope, how it will be checked, what to report.
  A sub-agent knows only what its brief says.
- Only one code-writing agent at a time: they share the worktree and its build output. A read-only or docs-only
  agent may run beside it, never beside a measurement.
- Do not take a report as proof. For each item: read the diff, check the gate log, open the pictures it says it
  looked at, and send it back with specifics if something is missing. Done = it works in a real browser on WebGPU
  and has a test at the boundary it changes.
- After each green item: the plan's progress row and results, STATUS, the design page if what it says changed, then
  commit to `phase-45` and push. Small commits.
- At the close (46e.19): the phase gate once, one independent review by a fresh agent that built none of it, fixes,
  results, the acceptance page.

## How lighting items are measured (the same things every time)

Low tier, WebGPU, 1280 × 720, at the 30 Hz cap, each run alone, never uncapped, `uptime` recorded, from committed
built code; the town inside the 8 km world (staging's `voxel-slice`, world `far`), and from 46e.14 on the
many-lamps scene too.

- GPU ms per pass with the page's own measurement (`measureGpu`, `run.mjs headroom` on the moving orbit,
  `light-shots --gpu` at the five cameras); a run takes about 125 s and resolves about 0.1 ms within a run, 0.5 ms
  between runs.
- Page and simulation ms a frame from the profiler, the `lighting` category against 2.0 ms; the GPU lighting row is
  6.67 ms with shadows (which use 0.6–0.7).
- Memory against the budget table; the time for an edit to show in the light; Play start to settled.
- Pictures at the five fixed cameras (`run.mjs light-shots`), looked at, beside the previous item's.
- A difference is claimed only from same-hour interleaved runs (A B A B); smaller than the spread between rounds is
  "not resolved". Medium and high: shares only, "unverified on target hardware".
- The budget is the budget table's. A miss is recorded with its cause and does not block; a tier that cannot afford
  a feature gets it off or cheaper by a tier setting. Never tune a test bound to pass.

## Lessons from 46e-a that you must apply (on top of 46f's in the agent brief)

- **Prove a switch is off before using it as a comparison.** `surfaceRead=0` never reached Play, so two items
  reported "the read costs nothing" (D698). Every on/off comparison first shows a reading that only the off state
  can give.
- **Keep the evidence for any finding that changes a design.** The hybrid's design rested on a white-fallback
  picture nobody kept (D699). Pictures and logs for such a finding go in the work folder and are named in the plan.
- **Per-adapter resources need a release, and the leak test runs only in the phase gate.** A worker started per
  scene adapter leaked for four items (found at the close). When an item adds a worker, buffer or texture that lives
  with the adapter, name `tests/e2e/memory.e2e.ts` in its fast gate.
- **Code must match an approved spec entry.** The derived version stayed 31 in code while the approved entry said
  32. When a spec or register line changes, grep the constant.
- **Item agents overwrote §6's contract rows with status text.** The item table is the contract; status goes in §7.
- **`measureGpu` limits:** it must run alone (another browser on the GPU ruins it); hiding `near` at close cameras
  is unreliable (D660: use the orbit for `near`); `post` cannot be read on the voxel town (D661); the whole-frame
  reading from the ballast line swings by 15 ms and is not used.
- **The Play test of `voxel-world.e2e.ts` ran 3.3–3.5 min against a 240 s timeout.** 46e.9 removes the cache and
  hybrid checks; record the new time. Anything that grows it again is split or moved to vitest; the timeout is not
  raised.
- **Disk.** About 9 GB is free. Agents leave Playwright output folders and exports in
  `~/.cache/thirdlight-phase46e/work/<item>/`; this filled the disk to 4.7 GB once. Tell every agent to delete them
  when done (keep pictures, JSON, logs) and check `df -h ~` between items.
- **An agent can die on the usage limit mid-item.** Its work is saved: check `git status`, the gate and staging
  yourself, then resume it with a message that says what state you found. Finished agents sometimes report again
  from a leftover waiter; check that nothing of theirs is still running before the next measurement.
- **Travel is easy to make worse.** Three things added this phase cost frames at 150 m/s. Any item that adds
  per-frame work on the default path runs one coverage round at 150 m/s against a same-hour base round.
- Never write to `/tmp`; gates through `tools/gate.sh start …` then `wait`, one at a time, `TL_GATE_MEM=12G
  TL_VITEST_WORKERS=6`; no hand-run Playwright between a red gate and its rerun; the phase gate is run once.

## Rules that matter most

- WebGPU only for new work; WebGL 2 keeps what it draws today and its one smoke test stays green. "WebGL 2 loses X"
  is never a default.
- Scope fence: nothing inside block layers, heightfield terrain or generated architecture; phase 42's stack is not
  retired or changed beyond removing the voxel port from it; no structures on their own grids, no far-cache
  channels, no lit fog, no saved light or bake, no world edit mode, no relief, no detail-piece LODs, no compute
  build of the clustered lists.
- Reuse before building: every item names the module it extends and the shared foundation it sits on
  (`voxel-engine.md` §6). Time slices from the frame arbiter's table, budgets from the budget tables; a tuned
  constant becomes a tier setting or a table entry, not a new bare constant.
- A defect found and not fixed gets a D-row; a test that fails only under load is fixed or gets a watch row. Never
  invent a result: say "unverified" when you did not observe it. Nothing visual is "verified" without a picture
  someone looked at; nothing in motion has been seen yet at all.

## Stops (the only reasons to wait for the owner)

- The emissive material entry: nothing of 46e.12 (d) is built before the owner's note (work around it as above).
- Any other change to an approved voxel format or spec; any stored light.
- A newer three.js release: assess and record, do not update.
- Something that would delete or overwrite the owner's data, or touch main, production or a game repo.
- A finding that makes an item's goal wrong, not merely hard: write what you found and your recommendation, and
  carry on with the items it does not affect.

Anything else: choose the default, log it in the plan's decision log as "default chosen, owner to confirm", and keep
going. The owner has promised not to steer mid-phase; a new idea goes into the decisions register for the next phase
boundary unless it fixes something broken.

## When you finish

Publish the acceptance page for 46e-b (the pack goes in `~/.cache/thirdlight-phase46e/acceptance/46e-b/`, the page
itself in `docs/briefs/acceptance-46e-b.md`, published with
`python3 ~/.cache/thirdlight-owner-review/add-phase.py acc46e-b "<title>" <pack dir> <review.md>`, served at
`http://10.0.10.223:8766/review.html#acc46e-b`): the five cameras and the many-lamps scene before and after, each
light type shown once, an edit in the light, the measured table on the low tier (town and many lamps, the moving
sun), what rooms, culling and the walk graph give a game, and at most five questions, each with a default that
stands.

Then tell the owner in plain language, shortest first: what now exists that did not, what they would notice in the
editor or a game, the measured before and after on the low tier, what is still open (D-rows), and your questions.
Then stop. Do not begin phase 47a.
