# Handoff: lead for phase 47a (structures and water bodies): plan it first, then build it

You are the lead for phase 47a of the Thirdlight engine. 47a has **no plan yet**. Your first job is to write
`docs/plan-phase-47a.md` and bring its item list to the owner. **Stop there.** Build only after the owner approves the
list and order; then run 47a to its close without asking, unless you hit a stop below. Do not begin 47b.

## Where things stand

- 46e-b is done and accepted (owner 2026-11-20: "All of the defaults are accepted"). Its close is 6eab7d86; this
  handoff's commit is the start commit of 47a (use it for `tools/gate.sh start phase <commit>` at the close).
- Work only in the worktree `/home/dadmin/projects/thirdlight-p45` (branch `phase-45`). Never touch
  `/home/dadmin/projects/thirdlight` (main, frozen, production) or any game repo.
- Next free D-number: **D742** (D700–D799 is reserved for the branch; reserve D800–D899 in the audit file before it
  runs out). three.js is 0.187.0 = the pin (checked 2026-11-16): check again at the start, assess and record, never
  update.
- The previous lead's running notes and lessons: memory file `phase46e-b-autonomous-run.md`. Start your own
  (`phase47a-autonomous-run.md`) and log each step as it closes.

## Read first, in this order

`AGENTS.md`; `docs/architecture/voxel-engine.md` (what exists; §6 the shared foundations: 47a builds foundation 5,
"regenerated structures"); `docs/decisions/owner-decisions.md` (all of it: the 2026-11-12 rows on water, splines and
"editing terrain updates bodies of water", and "Format proposals waiting for the owner's note"); `docs/roadmap.md`
(the voxel order: item 3 is 47a's scope); `docs/plan-phase-45.md` §1b (owner decisions on workflow and structures),
§1d, §1e (one grid per structure; what separate grids cost; "47a measures the same houses aligned in the world grid
and in their own rotated grids"), §4's 47a line, and the open cross-grid contract gap recorded near line 2266;
requirements R40 and R45 and the others that name structures, openings, splines or water in
`docs/architecture/voxel-format-requirements.md`; `docs/research/water.md` (static voxel water first; bodies that
regenerate; its "Decisions for the owner" and "Items") and `docs/research/derived-fields-and-shared-tools.md` where
it names structures or splines; `packages/voxel/src/structure-overrides.ts` (a draft with no users);
`docs/plan-phase-46e.md` §1's "Out, with the phase that takes it" (what 46e left for 47a: structures on their own
grids and their stitched walk graphs, door and window portal state as props) and its sections "46e.15", "46e.16"
and "46e.18" (props in the light's rays, rooms and `portalsOf`, the walk graph: the things 47a's doors and
structures must meet); `docs/briefs/acceptance-46e-b.md` (what is open); `docs/briefs/voxel-agent-brief.md` (the
item agents' standing brief; its last section is 46e-b's).

## Scope of 47a (the roadmap's words; the plan turns them into items)

"Regenerated structures (a definition → voxels + overrides) for buildings and for road, path and river splines;
water bodies as definitions (seed, level, liquid material) whose liquid voxels are regenerated when the ground in
their reach is edited, in the editor only, bounded and flagged when breached, with a plain liquid look; the
regenerate step is what a later run-time settle calls." With plan 45's 47a line: structure objects with footprint,
storeys, roof, material swap, copy/paste, scale, extend, drag up and hand-edit overrides; one grid per structure;
openings with door and window props (R45: open/shut is portal state, not voxels; R40: collision one static body per
structure, the walk graph per grid stitched at doors and foundations, the tracer stepping each grid in its own
space).

Not 47a: the world edit mode, the height-based fill, the fog role, dressing and scatter (47b); the world map (47c);
converters and retirement (48); water's surface shader, flow and buoyancy (49).

## What the plan must contain (follow `docs/plan-phase-46e.md`'s shape)

Scope in and out; the owner's requirements quoted; what exists (a survey you do, with file names); the three.js
check; budgets and how each item is judged; where things live (reuse first: name the module each thing extends);
the items as a contract table with an order; the format and spec steps; open questions for the owner (at most
five, each with a default). In particular:

- **The format stops, each a proposal the owner must note before it is built**: anything a structure or a water
  body stores (definitions, overrides, a structure's own grid and transform, door state) and the "narrowed feeds for
  liquid edits" entry the register lists for 47a. Write each as an add-only entry proposal with what a designer
  sets, what is stored, and one picture or mock; publish them early so approvals can arrive while other items run.
- **A measurement item first** for rotated grids (plan 45 §1e): the same houses in the world grid and in their own
  grids at 30° and 45°: frame cost, memory, collision, light volume and walk graph across the seam. The answer may
  change the design; it comes before the build items that depend on it.
- **Carried defects, as the plan's first small items or with the item they touch**: D740 (the 128-lamp scene's near
  +2.4 ms since the tuning, cause not found: compare the generated WGSL of the surface programs at 481e0491 and the
  head); D735 (the walk graph's walker is 0.25 m wide: structures and doors need an ordinary humanoid to pass, so
  size the fix with the door work); D736; D727 (thin props block no light: a door leaf is thin); D728 (moving lit
  props are costly: doors move); D729 (watch); **D741** (light passes or stops whole at half coverage: the owner's
  coverage-fraction decision, R93, is in the data but not in the light's rays; put its placement to the owner in the
  plan's questions, since 47a's doors, shutters and panes are where it first shows). Open and decided, not to be "fixed": rooms under cut-away stay dark
  (D737), no minimum brightness indoors.
- An interim look for the owner after the first structure can be made and edited in the editor.

Publish the plan's item list on the owner-review page (below) and **stop for the owner's approval**.

## How to run it (after the approval)

- One item at a time, in the approved order; slice an item into a/b/c where one agent cannot finish and verify it.
- Launch each item or slice as a fresh sub-agent on the Opus model with a written brief: the goal, the plan row
  quoted, the files and modules to reuse, what is out of scope, how it will be checked, what to report. A sub-agent
  knows only what its brief says. Add a "47a" section to `docs/briefs/voxel-agent-brief.md` before the first item.
- Only one code-writing agent at a time. A read-only or docs-only agent may run beside it, never beside a
  measurement or while a phase gate runs.
- Do not take a report as proof: read the diff, check the gate log, open the pictures, and send it back with
  specifics if something is missing. Done = it works in a real browser on WebGPU and has a test at the boundary it
  changes. Editor work needs a Playwright test driving the real page against a real backend.
- After each green item: the plan's progress row and results, STATUS, the design page if what it says changed, then
  commit to `phase-45` and push.
- At the close: the phase gate once, one independent review by a fresh agent that built none of it, fixes, an
  end-of-phase reading, the acceptance page, at most five questions each with a default.

## Lessons from 46e-b that you must apply

- **Keep the session alive.** Background agents died three times, each about 30 minutes after the lead's turn
  ended. Whenever an agent or a gate runs, set a recurring wake-up of 10 minutes (CronCreate; it is session-only:
  re-create it after any restart) and on each tick check git, the gate, the agent's `progress.txt` and the disk.
  Still read the gate's result yourself: the lead once sat idle for 100 minutes after a gate ended.
- **Every agent keeps a `progress.txt`** in its work folder, writes a line after each step, and commits and pushes
  each green slice at once. An agent that dies is resumed with a message that states the state you found (git
  status, the gate, staging, its progress file).
- **A login can expire mid-run** (it did once): for a long unattended run the owner may set a token; say so once.
- **Never pipe `node tools/check-docs.mjs`** and never chain a publish after it with a variable set earlier in the
  chain: a failed check once pushed an over-long row and once published an empty page.
- **Measure the heavy scene after every item that touches a lit program**, not only at the end: a +2.4 ms step in
  the 128-lamp scene went unnoticed across two items (D740). The bench: `run.mjs headroom --quality low --lamps 128`.
- **Item agents overwrite the plan's contract rows with status text.** The item table is the contract; status goes
  in the progress table. Check after every item.
- **Prove a switch is off before using it as a comparison**; keep the evidence for any finding that changes a
  design; a base worktree needs its own `@thirdlight` links (a symlinked node_modules builds the head's packages).
- **The leak test runs only in `gate.sh start area play`** (or the phase gate): an item that adds a worker, buffer
  or texture living with the adapter or the simulation runs it.
- **Stopping Play is now ordered** (the page reports stopped when its simulation worker is gone); anything that adds
  workers must end them before that report (D729).
- **The review server** (`python3 -m http.server 8766` in `~/.cache/thirdlight-owner-review`, started with
  `setsid nohup`) does not survive restarts: check it answers before you say a page is published. Publish with
  `python3 ~/.cache/thirdlight-owner-review/add-phase.py <id> "<title>" <pack dir> <review.md>`; pages are served at
  `http://10.0.10.223:8766/review.html#<id>`.
- **Disk**: about 15 GB free. Staging exports are removed by the bench that made them; agents delete Playwright
  outputs and traces and keep pictures, JSON and logs; check `df -h ~` between items and clean under 10 GB.
- Never write to `/tmp`; gates through `tools/gate.sh start …` then `wait`, one at a time,
  `TL_GATE_MEM=12G TL_VITEST_WORKERS=6`; no hand-run Playwright between a red gate and its rerun; the phase gate is
  run once. A change in `project-model` or `shared` runs every area (about 40 minutes): one commit for it.
- How anything that draws or lights is measured is unchanged: `docs/briefs/handoff-46e-b.md`, "How lighting items
  are measured". Low tier, WebGPU, 1280 × 720, the 30 Hz cap, each run alone, never uncapped, committed built code,
  A B A B in the same hour.

## Rules that matter most

- WebGPU only for new work; WebGL 2 keeps what it draws and its one smoke test stays green.
- Voxels are the single source of truth: a structure or a water body is a definition that writes voxels (plus
  overrides); nothing keeps a second authored copy. Derived data is never stored.
- One mutation path: the commands. The editor and MCP send the same commands; one undo line.
- Generic capability only; nothing shaped to one game. No per-project count caps.
- Nothing inside block layers, heightfield terrain or generated architecture (they retire in 48); phase 42's stack
  is not touched.
- Reuse before building: name the foundation (`voxel-engine.md` §6) first. Time slices from the frame arbiter's
  table, budgets from the budget tables; a tuned constant becomes a tier setting or a table entry.
- A defect found and not fixed gets a D-row. Never invent a result: say "unverified" when you did not observe it.
  Nothing visual is verified without a picture someone looked at; nothing in motion has been seen by anyone yet.

## Stops (the only reasons to wait for the owner)

- The plan's item list and order, before anything is built.
- Every format or spec entry (structure definitions and overrides, a structure's grid, door state, water body
  definitions, narrowed liquid feeds): proposal first, build after the owner's note. A note relayed by another
  session is recorded as relayed and confirmed with the owner at the next page.
- A newer three.js release: assess and record, do not update.
- Something that would delete or overwrite the owner's data, or touch main, production or a game repo.
- A finding that makes an item's goal wrong, not merely hard: write what you found and your recommendation, and
  carry on with the items it does not affect.

Anything else: choose the default, log it in the plan's decision log as "default chosen, owner to confirm", and
keep going.

## When you finish 47a

The acceptance page (`docs/briefs/acceptance-47a.md`, published as `acc47a`): what exists that did not, what the
owner would notice in the editor, the measured table on the low tier, what is still open, at most five questions
each with a default. Then stop. Do not begin 47b.
