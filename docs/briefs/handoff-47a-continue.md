# Handoff: lead for phase 47a, continued (items 47a.10 to 47a.13)

You take over as lead of phase 47a of the Thirdlight engine in the middle of its run. The previous lead's session
was stopped by the owner on 2026-11-23 because it had grown too heavy and because of how its keep-alive timer was
used (see "The timer" below). Nothing was running when it stopped. **Do not begin 47b.**

Your first standing instructions are still `docs/briefs/handoff-47a.md` (the original handoff: rules, stops, how to
orchestrate, what to deliver at the end). Read it in full; everything in it holds except where this page says
otherwise. This page says where things stand and what is left.

## Where things stand (2026-11-23, about 16:00 UTC)

- Worktree `/home/dadmin/projects/thirdlight-p45`, branch `phase-45`, clean, pushed; head `df38eff5` plus this
  handoff's commit. Never touch `/home/dadmin/projects/thirdlight` (main, production) or any game repo.
- Phase start commit for the phase gate: **b5093d11** (`tools/gate.sh start phase b5093d11`).
- The plan: `docs/plan-phase-47a.md` (§6 the contract table: never edited; §7 progress rows ≤ 400 characters;
  §8a results an item; §9 the decision log; §10 the questions). The owner approved the item list, the seven format
  entries F1–F7 (`docs/briefs/proposal-47a-formats.md`) and the five defaults on 2026-11-20.
- **Done and verified: 47a.0 to 47a.9.** Their results are in the plan's §8a; one-line states in §7.
- **Left: 47a.10, 47a.11, 47a.12, 47a.13**, in that order.
- Next free D-number: **D786** (the block D800–D899 is reserved too).
- three.js is 0.187.0 = the pin (checked 2026-11-20). No update.
- The previous lead's full log: memory file `phase47a-autonomous-run.md` (long; read its last ten entries, not all
  of it). Continue the log in a NEW memory file `phase47a-run-2.md` so it stays short.
- Owner pages published (the review server is `python3 -m http.server 8766` in `~/.cache/thirdlight-owner-review`,
  started with `setsid nohup`; check it answers before saying a page is published):
  `plan47a`, `acc47a-1` (`docs/briefs/result-47a.1.md`), `acc47a-interim` (`docs/briefs/acceptance-47a-interim.md`).
  Packs under `~/.cache/thirdlight-phase47a/`; work folders `~/.cache/thirdlight-phase47a/work/<item>/`.

## What is left

Quote the plan's §6 row in each brief; these notes are what the rows do not say.

- **47a.10 Water bodies (F6, approved).** The level fill as one pure function in `@thirdlight/voxel` (47b's fill
  stroke and a later settle call the same one); the `waterBody` component exactly as F6; in the editor's backend a
  stroke or a structure regenerate inside a body's reach writes the body again **in the same undo step**, locally
  where it can; a breach is flagged (reported, never stored) and drawn at its place, nothing spilled; order ground →
  buildings → water (R41). The owner's wish this item exists for: "I want to be able to edit in the world tools and
  have the shoreline updated, not see a wall of water that I then have to refill with the water tools."
  47a.9 built what it stands on: liquid edits feed the liquid part alone (`changeFeeds`, `EditOutcome.parts`), and
  water is drawn plainly inside the detail ring (`?voxelLiquid=off` hides it for a bench). Use
  `structure-commands.ts` and `voxel-structure-writes.ts` as the pattern for "a command's follow-up writes in its
  own transaction". Budget: the shore redrawn within about 0.5 s of a brush dab on a 250 m lake. Pictures for the
  owner: a bank dug back with the shore following (before and after), a breach flagged. Known limits to state, not
  fix: water is drawn near only (the bed shows dry past the detail ring: accepted for 47a); D782, D783.
- **47a.11 Splines write voxels (F5, approved).** Road, path and river sections on the `spline` component; the
  record of what a world-grid structure replaced (`TLVO` layout, "before" and "written", in
  `voxels/<world>/structures/<object id>.tlvo`); moving the spline puts the ground back and writes the new course in
  one undo step; a river meeting a body writes down to its level. Sits on the structure core
  (`packages/voxel/src/structures/`, 47a.3) and the fill of 47a.10. The heightfield path (`terrain-splines.ts`) is
  not touched (48).
- **47a.12 Light through partial cells (D741).** The owner's accepted default: it is 47a's last build item **and the
  first thing cut if the phase runs long**. The phase has run long (four days, two session losses). Recommend to
  the owner, on the acceptance page, that it moves to a lighting item before vegetation; do not build it without
  the owner's word. Record whatever is decided in the plan's §9 and the register.
- **47a.13 Close**, as the original handoff says: the phase gate once (from b5093d11), one independent review by a
  fresh agent that built none of it, fixes, the end-of-phase reading against 47a.0's baseline (plan §8a "47a.0"),
  `docs/architecture/voxel-engine.md` checked, STATUS, the acceptance page `docs/briefs/acceptance-47a.md` published
  as `acc47a` with at most five questions each with a default. Then stop.

## Owner decisions waiting (build none of them before the owner's note)

On `acc47a-interim`, each with its default: (1) D751 the overrides' fit rule gives four results a designer would
call wrong: change it as proposed in §8a "47a.3"; (2) D752 a ridge direction a polygon on F1, so L- and T-plans
get a cross gable (today: two parallel roofs with fragments at the junction); (3) D753 F2's sentence "one region
file" becomes "one, or two in a stacked world"; (4) D756 a stored key a grid so scripts can name a building by its
scene object; (5) D759 a far view left stale by a restart: leave; (6) D762 a material-only paint: leave for 47b.
Also unanswered and built on its default: structures have **no `pieces` list** (the owner's Enshrouded question;
add-only later). If the owner answers any of these, record the note in `docs/decisions/owner-decisions.md`, the
proposal and plan §9 in one commit, then schedule the work as a slice before the close.

## What the acceptance page must say plainly (collected so far)

- Flipping a door's `open` does not move the leaf: the engine has no door behaviour (a game swings or hides it).
- A gable on an L or a wing looks wrong (D752). No stairs tool in the structure mode (D775). The prop picker offers
  models, not prefabs (D776). Handles draw and grab through walls (D764).
- Costs: many buildings cost the simulation thread 1.4–1.5× the same houses in the world grid on a moving camera
  (aim 1.3×; D743), and one 224 ms simulation frame crossing a town at 150 m/s; the walk graph is over its budget
  row on the town (18.0 MB against 16 MiB at low; D778); the job queue lets the ground's full detail arrive after
  the houses' work (D745, a fix was tried and backed out).
- Light: turned doors and windows pass 12–18 % less light; corner lines at 45° (D746); eave specks (D744); coarse
  light past the detail ring does not see a shut door (D773).
- Unverified by anyone: anything in motion; a house on a slope; medium and high tiers; a 1 m door in the browser;
  stairs at 45°; the Add tool in a browser; a turned house in the far bricks of a world baked to 0.5 m.
- Readings never explained: 47a.0's page time at 128 lamps (+2 ms against 46e-b); the "first round after Play
  start" low headroom reading (D711); D740 (the 128-lamp near cost: the extra is in the coarse levels' read).
- Watch rows opened in this phase: D760, D768, D777, D785 (each failed once under load and passed alone).

## The timer

The owner stopped the previous session over this: **the keep-alive was a 10-minute cron whose every tick ran a
full turn of the lead** (a shell check and a written status), about 600 ticks over the run. That is what made the
session too heavy. Before you start an agent, **ask the owner once how they want the keep-alive done**, and offer
this default: one cron every 20 minutes whose prompt tells you to do nothing and say nothing unless an agent's
`progress.txt` has not changed for 30 minutes or an agent has reported (one quiet line at most a tick, no status
essay, no tool call when the previous tick's check is still fresh). The agents' completion notices wake you
anyway; the cron only has to keep the session from idling out. Never run two crons (list them first; one survived
a reboot once and doubled the ticks). Delete it when nothing runs.

## Lessons of this run (apply them; they cost time to learn)

- **Verify every clause of a row against what was proven** before counting an item: an agent ended 47a.7 on a
  "partial" with the editor tool, the Play proof, the pictures and the measurements missing, and another removed
  checks it could not make pass. Put "DO NOT STOP EARLY" and the row's clauses in the brief.
- **A red on a test of a spec rule is never rerun blind** (the feeds rule, a format round trip, undo exactness, a
  "this switch is off" proof): run it alone three times at the head and at the commit before the item, and place
  it. 47a.5b's gates passed with such a test failing two runs in three.
- **Look at the pictures yourself.** They showed what reports did not: an "open" door that looks shut, an unstyled
  list, a band across a pond that needed explaining.
- Agents must **wait for scripts and gates in the foreground**: one slept 17 hours "waiting" on a background
  script when the lead's session paused. And a **progress line at least every 15 minutes**; nudge by SendMessage
  when it goes quiet, and make them commit and push each green part at once (a host reboot hit 29 uncommitted
  files once; they survived by luck).
- After a reboot or a pause: check git status, the agent's `progress.txt`, the gate logs
  (`~/.cache/thirdlight-logs/`), restart the review server, list the crons, then resume the agent by SendMessage
  with the state you found.
- Known load-sensitive tests that pass alone (rerun allowed): D410 project-items, D411 tracer-terrain-rings, D454
  stream.test, D599 far-world.test, D643 terrain-cdlod, block-editor, start, shadows, frame-rate-cap, scene-loads
  (D777). The Export test's old failure ("exportRoot is not a directory") was the host's hourly clean-up at
  minute 17 deleting an empty folder; fixed in the test fixture (D780).
- A change in `project-model`, `shared` or `workspace` runs every gate area (about 40 minutes); a wide gate is
  also the only thing that catches stale generated files (the behavior-API typings, the reference, the script
  access table's pin): tell agents to run the generators' checks before their last gate.
- `run.mjs headroom` cannot run on staging's world after bench edits to it ("the far field did not settle",
  D784); the page's own GPU measurement at a fixed camera is the fallback.
- Staging listens on 127.0.0.1 and runs only while testing. The owner was offered, and has not asked for, a
  staging left up on the LAN to try the structure mode.
- Never pipe `node tools/check-docs.mjs`; count a §7 row before committing it (400 characters).
- Disk: about 17 GB free; work folders hold pictures and logs only.

## Deliver at the end

As the original handoff: `docs/briefs/acceptance-47a.md` published as `acc47a` (what exists that did not, what the
owner would notice in the editor, the measured table on the low tier, what is still open, at most five questions
each with a default), a plain summary, the cron deleted. Then stop. Do not begin 47b.
