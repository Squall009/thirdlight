# Phase 46 brief (shared by every item agent; sub-phases 46a → 46b → 46c)

WORKING COPY: phase 46 is built on the branch `phase-45` in its OWN git worktree: /home/dadmin/projects/thirdlight-p45
(own node_modules, already built). Work, build, test and gate ONLY there (`cd /home/dadmin/projects/thirdlight-p45`).
Commit to `phase-45` and `git push origin phase-45`. NEVER commit to, push, merge into or rebase from `main`, and never
touch /home/dadmin/projects/thirdlight (that is main; the production service runs from it). MAIN IS FROZEN: the only
main change allowed is a production hotfix by the lead (then cherry-picked onto phase-45). Nothing on main may rely on
branch code. Nothing is merged or deployed in phase 46 (the merge is 48c). tools/gate.sh in the worktree shares the one gate lock and log
folder with main, so one gate at a time still holds.
Main at the freeze: d4053cab. Phase 46 base on the branch: aeb8114a (phase 45 done, format spec v1 APPROVED by the owner 2026-11-02).
46a DONE at ac283f22 (2026-11-03); 46b DONE at 6ffc2031 (2026-11-04). Last D-row used: D499; NEW BLOCK D500–D599 (continue at D500).
CURRENT PHASE: 47b, the world edit mode (docs/plan-phase-47b.md; the lead's prompt names your item; the "47b" section
at the very end is your rules). The sections between are history: read only the ones the 47b section names. NEVER
start 47p or any later phase.
TESTS AND GATES (from 47T on; AGENTS.md "Tests and the gate" is the rule, and it replaces every older gate, e2e and rerun
line of this brief): unit tests prove behaviour (commands over HTTP in Node count); the boot check
(tests/e2e/boot.e2e.ts, five tests) is the only browser test, and no other is written; looks are judged from pictures
by an agent's written read and then the owner (docs/pictures.md: the list, `tools/gate.sh pictures`, the read's
fixed form, publishing); performance is recorded, never gating. `tools/gate.sh check` (one
blocking call, under 5 min) for every commit you call green; `tools/gate.sh check --failed` after a real fix; the
lead runs `tools/gate.sh phase` once at the close. A red is fixed or the test goes (archived): no rerun to see whether
it passes, no placing, no watch rows for tests. About one hour of test time a phase.
Code agents run one at a time (they share the worktree's dist/); a docs-only agent may run beside you.

Read AGENTS.md; then the current sub-phase plan (docs/plan-phase-46a.md, 46b, 46c) IN FULL; then from
docs/plan-phase-45.md: §4 (46–49 sub-phases), §7 decision log entries dated 2026-11-02 (owner decisions), §7a (takes
precedence where it revises earlier sections), §9; and docs/architecture/voxel-format-spec.md (APPROVED v1 — the
contract; changing a format means a versioned, add-only step and an owner note, never a silent edit) and
docs/architecture/voxel-format-requirements.md (R1–R112). Proposals marked unresolved/proposed are NOT approved specs.

APPROVED STATE (owner, do not re-litigate):
- Voxel value v2 (u32): material 12 bits + role 4 + shape 4 (16 fill levels) + wetness 3 + 9 reserved; no
  orientation. One value everywhere: authored base files + runtime in-memory overlay (dropped on quit except fields the
  game marks saved). Feeds mask: shape/role → mesh, collision, nav, light occupancy; material/wetness → shader data
  only (no remesh). Saved-at-runtime mask is the game's choice (wetness default not saved). Climate = coarse per-region
  field (spec'd, not built).
- Material blending in the shader from a per-chunk 34³ material+wetness grid; vertices carry no material. Wetness
  R111 (darken + lower roughness + fill normals/crevices by height) is 46d; the slice only darkens. No trim sheet for
  terrain/construction voxels (tileable arrays wall/floor/ceiling, triplanar); the trim layout spec is only for
  detail pieces (R112).
- 32³ storage chunks, 16³ derive/mesh sections, atomic multi-section swap; remesh within a frame is the goal (R107):
  record frames on the Iris Xe, never block.
- 46b: terrain mesher = voxel-neighbourhood threshold rules (cliff/slope/terrace/overhang/cave) as rule sets on the
  derive contract (declared radius + conformance check); dynamic LOD (voxel mips in distance rings, crack-free, shader
  blend identical per level, detail pieces high → low → none); never assume flat terrain. Baseline to beat: 0.90 M
  triangles (slice) / 2.87 M (town) from the naive mesher; mesher budget 0.1–0.2 ms per section p50.
- 46c (REVISED by the owner 2026-11-04 — see docs/plan-phase-46c.md decision log OWNER 2026-11-04 and §6b): walls and
  floors are plain voxel faces; detail meshes only on edges/corners/roof edges per 0.5 m voxel with stagger; roofs
  have their own mesher; damage = construction shape (integrity); textures grid-locked at 4 × 4 m. The role spec and
  texture layout drafts await owner approval; nothing builds on them as final.
- Lighting is 46e (not in this run). Existing block-layer/terrain/architecture systems stay untouched (48 retires).
- Owner decisions are REQUIREMENTS: a decision that doesn't pan out → record why + propose replacements keeping its
  goal, mark for the owner; never silently dropped.
- Code home: packages/voxel (@thirdlight/voxel, pure TS, no three, no node: in runtime-facing parts); editor page in
  packages/editor/src/voxel-world; backend routes packages/backend/src/voxel-routes.ts; three-side in
  packages/three-adapter/src/voxel-surface.ts. Benchmarks tools/voxel-bench (`node tools/voxel-bench/run.mjs …`).
- No game copies, no procedural/seeded worldgen as a product feature (synthetic test worlds by benchmark scripts are
  engine-owned test data). Game repos and art-factory are never edited.
- Compression: fzstd 0.1.1 in workers (pinned). Any new dependency gets an exact version, a pin in
  tools/check-deps.mjs, and must pass the export bundle scan (exporter/src/scan.ts).

STAGING: `tools/staging.sh start|stop|status|smoke` (127.0.0.1:4180/4181, data root ~/thirdlight-staging-p45,
memory-capped 6G, engine-owned test worlds only). Regenerate the slice world with `node tools/voxel-bench/run.mjs
slice-world` when formats change. Start only while testing; stop it when done. Never the production ports/data root.

PERFORMANCE (owner, from phase 45 on): the Iris Xe is the FLOOR (low tier), not the target. Goal there: 720p at 60 Hz;
720p at 30 Hz is acceptable during 45–49. Always measure at the display's cap (`--vsync`/frame cap), never uncapped.
Record the numbers and the cause of every miss; NEVER block, revert or throw away working progress on a frame-time
threshold — misses go to the performance phase after 49. GPU ms per pass may be read from timestamps in capped runs.
Perf runs: ≤ 3 rounds, at the cap, `uptime` recorded. Format work is mostly CPU/worker: report ms, MB, bytes/column etc.

THREE.JS (owner rule, AGENTS.md): three is 0.187.0 = newest at the phase start (checked 2026-11-02). Never update three
(patch or minor), never plan an upgrade as an item. Only assess.

Owner rules (do not re-litigate):
- One mutation path: the commands. The editor and MCP send the same commands (voxel edits are stroke commands, §5b).
- The engine provides generic capability only. Game behaviour lives in the games (breaking/debris = game logic).
- No per-project count caps; counts become memory budgets. Define a limit once, in its owning package.
- Format: project schema 8 is current. Voxel formats are new, versioned, add-only upgrade steps, unknown version refused.

Big files: run `wc -l` before adding to a file. A file over 2,000 lines gets the area you touch split out first.
Unit-size rule (functions ≤ 400 lines, classes ≤ 80 members, files ≤ 2,000) checked at build (tools/check-size.mjs,
ratchet tools/size-ratchet.json: entries only shrink; split commits run `node tools/check-size.mjs --update`).
Redefinition check (tools/check-redefinitions.mjs): generic helpers live once in @thirdlight/shared; import, never copy.

Docs: user docs in docs/manual; fix pages your change makes wrong. Regenerate the reference with
`node tools/gen-reference.mjs` when APIs change, keep tools/manual-links.test.mjs passing. The approved format spec is
docs/architecture/voxel-format-spec.md; a format change updates it with a versioned step and an owner note.

Owner-level decisions: pick the most sensible generic default, log it in the sub-phase plan's decision log as "default
chosen, owner to confirm", keep going. Never stop to ask. If blocked: add a D-row and a plan note, move on.
D-ROWS: this branch owns D430–D499 (reserved on main). Take the next free number in that block (grep both
docs/audit-2026-09-22.md and docs/audit-closed.md; D430–D440 were used in phase 45; continue at D441). New rows
`| Dn | Sev | open | … |`; closing sets `fixed <commit>` (or superseded / won't fix).

Host rules (an OOM once forced a shutdown of this host (16 GiB then, 32 GiB since 2026-11-11); the owner was furious):
- EVERY backend, browser, perf, benchmark or gate run is memory-capped. `tools/gate.sh` caps itself. Ad-hoc runs
  (benchmarks too):
  `sudo -n systemd-run --scope --quiet -p MemoryMax=10G -p MemorySwapMax=0 -- sudo -n -u dadmin -- env HOME=$HOME PATH=$PATH TMPDIR=$TMPDIR NODE_OPTIONS=--max-old-space-size=4096 …`
  The inner `sudo -u` keeps the GPU groups. One backend and one browser at a time. Synthetic worlds: generate
  per tile / stream to disk; never hold a 10 km world in memory; size the benchmark to fit the cap.
- NEVER WRITE TO /tmp (RAM tmpfs; it OOM-killed every chat and agent twice). Before builds, vitest, Playwright,
  benchmarks or scripts: `export TMPDIR=$HOME/.cache/tmp/<your-item>; mkdir -p $TMPDIR`; delete it when done.
- Before EVERY heavy run check `free -g` (available ≥ cap + 2 GB) and `df -h ~ /tmp`; otherwise wait in short polls.
- Disk (~15 GB free at the start): scratch in ~/.cache/thirdlight-phase46/work/<item>/. Benchmark worlds on disk are
  scratch: delete them when done unless a later item needs them (say so). Never commit generated worlds or derived data.
- Never touch the thirdlight systemd service, /home/dadmin/thirdlight or the main checkout. Never kill a process
  unless `ps -o unit= -p <pid>` shows it is in your own run-*.scope / unit. NEVER pkill/killall/kill by pattern.
  Never delete files you didn't create.
- Run long browser runs detached with a timeout, poll in short calls.
- The shell exports NODE_ENV=production; use `NODE_ENV=development` for npm installs (`npm ci --include=dev`).

Gates and tests: the TESTS AND GATES section at the top (AGENTS.md "Tests and the gate").
- Tests at real boundaries: format/codec/store/streaming logic → vitest (real codec, real files on disk, real workers
  where workers are claimed); commands → vitest against a real backend over HTTP. A test that only confirms its own
  mock does not count.
- TESTS: never widen a test's bounds to make it pass, never change a test scene to hide a product difference. Fix the
  product, or write down exactly why the test was wrong.
- Never call anything visual "verified" unless you saw it (screenshots you looked at count); otherwise "unverified".

Work rules:
- Follow AGENTS.md in full. Comments say why; no phase numbers, item ids, dates or § in source comments. Constants
  defined once, in their owner. `npm run lint` and `npm run build` stay green.
- Commit to `phase-45` with a clear message when green, trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Then
  `git pull --rebase --autostash origin phase-45` and `git push origin phase-45`. On a GitHub 500, retry later.
- Update your item's row in the sub-phase plan's Progress table (≤ 400 chars per row, one or two lines with numbers; replace
  "not started" rows with real rows). Measurements/details → a results subsection or the plan's decision log. Close the D-rows you fixed.
- Only `git add` your own files. Do not touch the owner's reference images at the repo root.
- Helper agents (if any) are read-only or edit disjoint files, and never run browsers at the same time as you.
- Do not hand back before your gate has finished and you have committed. If you run out of room, commit only what is
  green and say exactly what is left. Do not start the next item. Leave no background loops or processes running
  (stop the staging backend you started).
- NUDGES: the lead nudges after ~45 min without a commit; commit green slices early. If asked to hand back
  "partial", commit what is green, record "partial" with what is left in the plan row, and stop.

Final message (≤ 15 lines): what was done, the commits, numbers, what is unverified, "default chosen, owner to
confirm" decisions you logged, D-rows opened/closed, and notes for the next item.

LESSONS FROM PHASE 45 (mandatory):
- Run `node tools/check-docs.mjs` WITHOUT piping it through tail/head before committing docs (agents pushed failing
  rows twice: a pipe hides the exit code).
- In the shared worktree only `git add` YOUR OWN files, by path. NEVER `git commit -a` or `git add -A`/`.` (a docs
  agent once committed another agent's staged deletion). Check `git diff --cached --stat` before each commit.
- Keep perf rounds tight: ≤ 3 rounds, one configuration change between rounds, stop when the cause is recorded (one
  item spent 2 h on 12 runs × 3 rounds). Report the cause of a miss, not a tuning hunt.
- Commit green slices early (≤ 45 min apart); a commit-less hour gets a nudge, then a "partial" hand-back.
- A world format change means the staging slice world must be regenerated; say so in your final message.

46d (owner 2026-11-08: run ALL of 46d without stopping; no questions; defaults logged "default chosen, owner to
confirm"). 46c is DONE (774dd6a9): role spec + texture layout v1 APPROVED, kit format 1 FINAL (add-only from here).
46d = Rendering and materials (docs/plan-phase-45.md §4 :592, §1c material model, §1d tiling, §2 far field, §7a
subdivision prototype, §9). Owner requirements (REQUIREMENTS, see plan-46c §9 OWNER entries): FIRST item = near-ring
denser voxel mesh for displacement on building grids AND terrain, measured; far field with NO draw cut-off, mountains
visible from several km, cheap chunk/region stand-ins (Enshrouded brick renderer = gold standard) — build BOTH
voxel-mip meshes and ray-marched bricks behind a switch, measure both, the OWNER picks (keep both until then);
construction tiles 4 × 4 m grid-anchored, authored 4096² at 1024 px/m, resident mip by quality tier + budget; terrain
triplanar 2 m; per-material height depth in metres; one texture set per kit; kit sheets + crack maps read for real
(debug set retired); wetness R111; dirt/moss = decals + material swaps (no overlay layer); L1 door/window "legs" go
to the far-field work; the L0 detail-piece ring stays = level-0 ring (owner: unchanged until far-field numbers).
Carried D-rows: D463, D485, D516, D479, D526, D496 (split format spec §3.7 BEFORE adding to it), D468 (perf phase).
Never start 46e (lighting, connectivity culling, walk graph). D-rows continue at D528 (block D500–D599).

46d-b (owner 2026-11-09, plan-46d §9 entries of that date + §6d are REQUIREMENTS): height in the ALBEDO alpha (texture
layout v1 amended, owner note); relief displacement OFF on every tier for now (switch kept, height lighting stays);
blend distance per material with a world default (smaller wins); far mesh field ~1/4 of its triangles keeping
silhouette + colour; brick far field must stop turning to mush. PERFORMANCE ROLE: keep measuring and recording, but
you are not the go/no-go validator; flag only obvious regressions (the owner's "demo" project tests real-game scale).
D-rows continue at D568.

WEBGPU FIRST (owner 2026-11-10; AGENTS.md; plan-46d §2/§9): WebGPU is the renderer voxel work is designed, built,
tested and measured for. WebGL 2 is no longer checked or kept working (owner 2026-11-25; its smoke test is archived);
no effort is spent on it. New items measure and take pictures on WebGPU only;
(the both-renderer browser passes are archived). Vista steps
46d.17–46d.20 go on compute, reusing three-adapter occlusion-pyramid.ts and occlusion-instances.ts (no second
culling path). Vista note: docs/research/voxel-vista-performance.md (§6 supersedes §4 where they differ).
Commit trailer now: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

46d-c (owner 2026-11-11). CURRENT SUB-PHASE = 46d-c: plan-46d §6d rows 46d.24 (travel at speed by hitches and settle
times) and 46d.25 (fine bricks from GPU compute past the detail ring); spec = docs/briefs/streaming-rings-2026-11-11.md
(§1 decisions, §2 measures, §4 layout). 46d-c start commit fda36fa8. D-rows continue at D612 (block D600–D699).
Commit trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Deferred by the owner, never revive:
detail-piece LODs, relief, GPU tessellation of the near mesh, whole-map bake of near detail ("derived data is never
stored" stays). Never start 46e.

46f (owner 2026-11-13). CURRENT PHASE = 46f, shared foundations: docs/plan-phase-46f.md (scope §1, owner requirements
§2, where things live §5, items §6). 46f start commit 45ec7ca3. D-rows continue at D646 (block D600–D699).
READ, in this order, instead of the plan-45/46a–c list above: AGENTS.md; docs/architecture/voxel-engine.md (what the
engine is now; §6 the shared foundations); docs/decisions/owner-decisions.md (decided, dropped, deferred);
docs/plan-phase-46f.md IN FULL; docs/research/duplication-audit.md; and only the parts your item names of
docs/research/derived-fields-and-shared-tools.md (§3.5 the interaction field), vegetation.md (§1 what exists) and
fog.md (L3, the field's channels). docs/plan-phase-46d.md is very long: read it only where your brief points.
SCOPE FENCE (owner; do not cross, do not re-litigate):
- Nothing a player or designer would see beyond the profiler. Same pictures before and after, unless your item says so.
- Nothing inside block layers, heightfield terrain or generated architecture (they retire in phase 48): do not merge,
  tidy or extend them. No relief, detail-piece LODs, mesh far field, painted layers or fog splines.
- No change to an approved voxel format (the format, render, role or kit specs). If your item seems to need one: STOP
  and report to the lead; that is an owner stop.
- three.js stays at 0.187.0. Never start 46e or any later phase.
- Reuse before building: your brief names the existing module each thing extends (plan §5). If you need something the
  plan did not foresee, make the smallest change and log it in the plan's decision log ("default chosen, owner to
  confirm"); do not widen the phase. Never copy a helper: import it (tools/check-redefinitions.mjs).
RENDERER: WebGPU only for new work, tests, pictures and measurements. WebGL 2 is not checked (owner 2026-11-25:
its smoke test is gone).
MEASURING (replaces the PERFORMANCE section above where they differ): the low tier, WebGPU, 1280 × 720, at its 30 Hz
cap, with the headroom meter (`run.mjs headroom`: room and pass shares) and the coverage bench (`run.mjs coverage`:
hitches, settle); never uncapped; GPU timestamps are not usable at the cap (D544). Medium and high: pass shares only,
"unverified on target hardware". A measurement runs ALONE (no gate, build or other agent loading the machine: the GPU
is integrated and shares the CPU's power budget); record `uptime` with it. ≤ 3 rounds.
HOST: 32 GB and 16 threads shared with production and staging. `tools/gate.sh` caps itself; a bench or ad-hoc run
stays within about 10–12 threads and its memory cap; never /tmp.
DONE = a unit test at the boundary it changes, `tools/gate.sh check` green, and what you say you looked at is a file
the lead can open (give the paths). The lead reads your diff and reruns your checks.
Commit trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Scratch: ~/.cache/thirdlight-phase46f/work/<item>/.

46e-a (owner 2026-11-14). CURRENT PHASE = 46e-a: docs/plan-phase-46e.md (scope §1, owner requirements §2, what exists
§3, budgets §4, where things live §5, items 46e.0–46e.8 §6, the approved spec step §8, decision log §9). 46e start
commit 2ff4af22. D-rows continue at D659 (block D600–D699; the lead reserves D700–D799 if it runs out).
READ, in this order, instead of the older lists above: AGENTS.md; docs/architecture/voxel-engine.md;
docs/decisions/owner-decisions.md; docs/plan-phase-46e.md IN FULL; docs/plan-phase-46f.md §8–§10 only where your brief
points (what 46f built: profiler, budget tables, arbiter table, camera window, region-texture helper); requirements
R40, R45, R97–R104, R110 in docs/architecture/voxel-format-requirements.md; docs/plan-phase-45.md §5c (the voxel light
volume as proposed). docs/plan-phase-46d.md is very long: read it only where your brief points.
OWNER DECISIONS (do not re-litigate): 46e-a stops at the lighting storage choice. The A/B runs BOTH stores on voxels on
one scene with the same cameras: phase 42's surface cache ported to voxel surfaces (46e.5), the voxel light volume
(46e.6), three arrangements measured (46e.7: cache alone, volume alone, cache near + volume beyond a hand-over
distance). Neither candidate is removed or polished past the other: both are built only as far as a fair measurement
needs, to the same depth. 46f's defaults stand (the arbiter stays a table, D652 waits, job kinds wait for 48, voxel
redo as built).
SCOPE FENCE (owner; do not cross):
- Nothing inside block layers, heightfield terrain or generated architecture (retire in 48): their lighting code
  (surface-cache-blocks.ts, -terrain.ts, block-walk.ts …) is READ as a pattern, never touched. Phase 42's stack is not
  retired, and keeps working on the old scene kinds.
- No structures on their own grids, no far-cache channels, no lit fog, no saved light bake (stored data = owner stop),
  no world edit mode, no relief, no detail-piece LODs. No rooms for cut-away or audio, no connectivity culling, no walk
  graph or A* (46e-b).
- Approved formats and specs do not change. The ONE exception is 46e.3's add-only entry for three derived outputs
  that are never stored (region labels, chunk face connectivity, sky columns; owner 2026-11-14). Anything else that
  seems to need a spec change: STOP and report to the lead.
- three.js stays at 0.187.0. No new private three hook where a public API does the job (tools/three-hooks.test.mjs).
- WebGL 2 is not checked (owner 2026-11-25: the smoke test is archived); spend no effort on it.
- Reuse before building (plan §5): name the module you extend and the shared foundation (voxel-engine.md §6) you sit
  on. Time slices come from the frame arbiter's table (`frameSliceMs`), budgets from FRAME_BUDGET_BY_TIER /
  MEMORY_BUDGET_BY_TIER; no new constant for a slice or a budget. Smallest change for anything unforeseen, logged in
  plan §9 as "default chosen, owner to confirm".
MEASURING A LIGHTING ITEM (the same things every time, low tier, WebGPU, 1280 × 720, at the 30 Hz cap, each run ALONE,
never uncapped, `uptime` recorded, ≤ 3 rounds; the scene is the town inside the 8 km world, staging's `voxel-slice`
world `far`):
1. GPU ms per pass (46e.1's "Measure GPU" reading once it exists; before it, the headroom meter's hide-a-pass shares);
2. page and simulation ms a frame from the profiler (`__tlProfiler.read()`), with the `lighting` category against
   its budget: 20 % of the GPU frame (6.7 ms) and 6 % of the page frame (2.0 ms);
3. memory against its MEMORY_BUDGET_BY_TIER entry;
4. the time for an edit to show in the light;
5. pictures at the plan's five fixed cameras (street at noon, a room with a window, a cave, night with lamps, the far
   view), from the SAME camera definitions 46e.0 commits (tools/voxel-bench), which you look at and list by path.
Medium and high: pass shares only, "unverified on target hardware". A miss is recorded with its cause and does not
block; a tier that cannot afford a feature gets it off or cheaper by a tier setting. Never tune a test bound to pass.
A before/after comparison needs the same hour and an interleaved base (A B A B), not one run of each. three's counters
do not count triangles in indirect draws: use the profiler's own counters. The bench drivers are bundled from the
working tree: measure from committed, built code (commit, `npm run build`, then measure).
TESTS (lessons of 46f): a test that counts something waits for the reading to arrive and requires a NON-ZERO count. In
your final message say, for each new test, what it would do with the feature broken or switched off (run it that way
once if cheap).
NAMES: say what the code does, not what the item is called. If the plan says "walk", "cache", "volume", "regions" and
you built less (a table, a stub, a debug view), write the plain description in the plan's results; the lead checks.
HOST: as the 46f section. One gate at a time; a measurement never beside a gate, build or another agent.
DONE = a unit test at the boundary it changes, `tools/gate.sh check` green, the plan's progress row and results
written, pictures you looked at listed by path. You commit and push your own green slices; the lead reads the diff,
the gate log and the pictures before the item counts.
Commit trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Scratch: ~/.cache/thirdlight-phase46e/work/<item>/.

46e-b (owner 2026-11-16). CURRENT PHASE = 46e-b: docs/plan-phase-46e.md §6's 46e-b table (items 46e.9–46e.19: the
contract; never write status into it, status goes in §7 and results in §8a/§8c). 46e-b start commit f048b411. D-rows
continue at D711 (block D700–D799; grep both audit files for the next free number before you take one).
READ, in this order, instead of the older lists above: AGENTS.md; docs/architecture/voxel-engine.md;
docs/decisions/owner-decisions.md; docs/plan-phase-46e.md §1–§5, §6, §8, §8b, in §8a only "46e.6a", "46e.6b",
"46e.8 — travel fixes" and "46e.8 — the close", §9's entries of 2026-11-16; docs/plan-phase-45.md §5c; the volume's
code (packages/three-adapter/src/voxel-light-volume.ts, -layout.ts, -wgsl.ts); the D-rows your brief names. The rest of
plan-46e §8a and docs/plan-phase-46d.md only where your brief points.
OWNER DECISIONS (do not re-litigate): the lighting store of voxel worlds is the voxel light volume. The surface cache's
voxel port and the hybrid are removed (46e.9; the A/B's code is at the tag `ab-46e-a`). NO TUNING until every light
type is in the volume and its observed defects are fixed on the update side: do not tune the per-pixel read, ray
counts, reach or pacing shares before 46e.14, and fix the look where cells are written (accumulate while idle, filter
as cells are written), never in the per-pixel read. Every light type: a per-brick lamp list in world space built in
compute; spot lights bounce with their cone; area lights add bounce; emissive materials (the glow is a property of the
voxel's material, never stored per voxel; NOTHING of it is built before the owner's note on the 46e.11 proposal).
Shadows and the sun field stay on at every tier. The low tier's target is 720p at the 30 Hz cap.
SCOPE FENCE (owner; do not cross):
- Nothing inside block layers, heightfield terrain or generated architecture. Phase 42's stack (surface cache, tracer,
  probes, rooms on the old scene kinds) is not retired or changed beyond removing the voxel port from it.
- No structures on their own grids, no far-cache channels, no lit fog, no saved light or bake (stored data = owner
  stop), no world edit mode, no relief, no detail-piece LODs, no compute build of the clustered light lists.
- Approved formats and specs do not change. Anything that seems to need a spec change: STOP and report to the lead.
- three.js stays at 0.187.0 (checked 2026-11-16). No new private three hook where a public API does the job.
- WebGPU only; WebGL 2 is not checked (owner 2026-11-25: the smoke test is archived).
- Reuse before building (plan §5; voxel-engine.md §6): name the module you extend and the foundation you sit on. Time
  slices from `frameSliceMs`, budgets from FRAME_BUDGET_BY_TIER / MEMORY_BUDGET_BY_TIER; a tuned constant becomes a
  tier setting or a table entry, never a new bare constant.
MEASURING A LIGHTING ITEM: as the 46e-a section (low, WebGPU, 1280 × 720, the 30 Hz cap, each run ALONE, `uptime`
recorded, from committed built code, the town inside staging's 8 km world; from 46e.14 on the many-lamps scene too),
with: `measureGpu` readings only (`run.mjs headroom` on the moving orbit, `light-shots --gpu` at the five cameras;
about 125 s a run, 0.1 ms within a run, 0.5 ms between runs); page `lighting` against 2.0 ms, the GPU lighting row
6.67 ms (shadows use 0.6–0.7); memory against the budget table; edit → light; Play start → settled; the five pictures
(`run.mjs light-shots`) looked at beside the previous item's. A difference is claimed only from same-hour interleaved
runs (A B A B); smaller than the spread between rounds is "not resolved". `measureGpu` limits: it must run alone;
`near` at close cameras is unreliable (D660: use the orbit); `post` cannot be read (D661); the whole-frame reading
from the ballast line is not used.
LESSONS OF 46e-a (mandatory):
- Prove a switch is off before you use it as a comparison: show a reading only the off state can give (D698).
- Keep the evidence (pictures, logs) of any finding that changes a design in your work folder, named in the plan (D699).
- A worker, buffer or texture that lives with the scene adapter needs a release with it, and a unit test that the
  release frees it.
- When a spec or register line changes, grep the constant: code must match the approved entry.
- DISK: an export made by `run.mjs coverage --export` is 1.1 GB in ~/thirdlight-staging-p45/exports/: delete the
  ones you made when your runs are done. Delete Playwright output folders and trace files from your work folder when
  done; keep pictures, JSON and logs. Run `df -h ~` before a heavy run; under 10 GB free, clean first.
- Any item that adds per-frame work on the default path runs one coverage round at 150 m/s against a same-hour base.
- Finished agents leave nothing running: no waiter, no staging backend, no browser.
DONE = a unit test at the boundary it changes, `tools/gate.sh check` green, the plan's §7 row and results written
(§6 untouched), pictures you looked at listed by path. You commit and push your own green slices;
the lead reads the diff, the gate log and the pictures before the item counts.
Commit trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Scratch: ~/.cache/thirdlight-phase46e/work/<item>/.

47a (owner 2026-11-20). CURRENT PHASE = 47a: docs/plan-phase-47a.md §6 is the item table (the CONTRACT: never write
status into it; status goes in §7's row, at most 400 characters, results in §8a under a heading for your item, decisions
in §9). 47a start commit b5093d11. D-rows continue at D742 (block D700–D799; grep both audit files for the next free
number before you take one; tell the lead if fewer than ten are left).
READ, in this order, instead of the older lists above: AGENTS.md; docs/architecture/voxel-engine.md;
docs/decisions/owner-decisions.md; docs/plan-phase-47a.md in full; docs/briefs/proposal-47a-formats.md (the approved
entries F1–F7: build exactly what an entry says); the 46e-b section above for how anything that draws or lights is
measured and for its lessons (they all still hold); then only what your brief points at.
OWNER DECISIONS (do not re-litigate): voxels are the single source of truth: a structure, a spline or a water body is
a definition that WRITES voxels (plus overrides); nothing keeps a second authored copy and derived data is never
stored. One structure = one scene object = one grid of its world, placed by the object's position and yaw (floors
level). Definitions and overrides are authoring data and are never exported. Doors and windows are props; open or shut
is portal state, never voxels. Water regenerates in the editor only; nothing settles at run time. A building leaves
the ground alone. Rooms under cut-away stay dark and there is no minimum brightness indoors (D737: not a defect to fix).
SCOPE FENCE (owner; do not cross):
- Nothing inside block layers, heightfield terrain, generated architecture or terrain-splines (they retire in 48):
  read them as patterns, never extend them. Phase 42's stack is not touched.
- Not 47a: the world edit mode on the brush kit, the fill as a brush stroke, the fog role, dressing, scatter (47b); the
  world map (47c); converters (48); the liquid's flow, surface shader, far water, queries, buoyancy, settle (49).
- A stored thing not written in an approved entry (a new field, file or manifest key), or any change to the voxel
  value, chunk codec, region file bytes, edit command, undo record, save file, far cache, kit, role or render spec:
  STOP and report to the lead. An approved entry's text goes into its spec in the commit that builds it.
- three.js stays at 0.187.0 (checked 2026-11-20). No new private three hook where a public API does the job.
- WebGPU only; WebGL 2 is not checked (owner 2026-11-25: the smoke test is archived).
- One mutation path: the commands. The editor and MCP send the same ops; one undo line (workspace undo-timeline.ts).
- Generic capability only; no per-project count caps; no game behaviour (how a door swings is a game's).
- Reuse before building (plan §5; voxel-engine.md §6): name the module you extend. Time slices from `frameSliceMs`,
  budgets from FRAME_BUDGET_BY_TIER / MEMORY_BUDGET_BY_TIER; a tuned constant becomes a tier setting or a table entry.
HOW YOU WORK:
- Work folder ~/.cache/thirdlight-phase47a/work/<item>/ with a `progress.txt`: append a dated line after EVERY step
  (what you did, what is next, any commit). The lead reads it every ten minutes; if you die you are resumed from it.
- Commit and push each green slice at once (never leave green work uncommitted). Commit trailer:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>.
- Gates: `tools/gate.sh check` (one blocking call) per green commit, `check --failed` after a real fix; one gate at a
  time. Anything that adds a worker, buffer or texture living with the adapter or the simulation ends its workers
  before the page reports Play stopped (D729), with a unit test of the release. Never run `tools/gate.sh phase`: the
  lead's.
- NEVER delete or clean `TMPDIR` (~/.cache/tmp) or anything under it while a gate runs; clean only your own work
  folder, after the gate.
- NEVER end your turn while a script or gate of yours runs in the background: wait for it in the foreground (a blocking
  wait with a timeout, repeated). A progress.txt line at least every 15 minutes.
- NEVER pipe `node tools/check-docs.mjs` and never chain anything after it; run it alone and read its exit code.
- Never write to /tmp (`export TMPDIR=~/.cache/tmp`); heavy runs in a memory-capped scope, one at a time; `df -h ~`
  before a heavy run, clean under 10 GB free; delete exports, Playwright outputs and traces you made, keep pictures,
  JSON and logs. Leave nothing running when you finish: no staging backend, no browser, no waiter.
- After an item that touches a lit program or the default path: the town orbit and `run.mjs headroom --quality low
  --lamps 128` against the reading before your item (same hour, A B A B), reported with the spread.
- Editor work gets unit tests of its commands and state (no new browser test). Nothing visual is "verified"
  without a picture you opened and looked at; say "unverified" for anything you did not observe; nobody has seen
  anything in motion. A defect found and not fixed gets a D-row.
- A base worktree for an A/B needs its own @thirdlight links (a symlinked node_modules builds the head's packages).
  Prove a switch is off before you use it as a comparison.
REPORT to the lead at the end: commits, the check's log name and result, numbers with how to reproduce them, pictures
by path, D-rows opened or closed, what is unverified, what you left out and why.
DONE = a unit test at the boundary it changes, `tools/gate.sh check` green, §7's row and §8a's results written (§6
untouched), pushed.

47L (owner 2026-11-24). CURRENT PHASE = 47L, the lighting pass: docs/plan-phase-47l.md §6 is the item table (the
CONTRACT: never edit it; status in §7's row, at most 400 characters; results in §8a; decisions in §9). Start commit
41bbcf38. D-rows continue at D802 (block to D899; grep both audit files first).
READ: AGENTS.md; docs/plan-phase-47l.md in full; docs/architecture/voxel-engine.md; the "47a" section above (its OWNER
DECISIONS, SCOPE FENCE and HOW YOU WORK hold in full) and the 46e-b section (how anything that draws or lights is
measured); then only what your brief points at.
WHAT IS DIFFERENT IN 47L:
- You run in the FOREGROUND of the lead's turn. NEVER use `run_in_background`, never start a detached helper and
  poll it with sleep loops in separate calls: every command is one blocking call under 10 minutes (`timeout 560 …`;
  `timeout 560 tools/gate.sh check` is one such call). A command that hits a tool
  timeout is moved to the background by the harness: avoid it by the 560 s bound.
- Work folder ~/.cache/thirdlight-phase47l/work/<item>/ with `progress.txt` (a dated line a step).
- No stored thing is expected in this phase: a fix that needs one is an OWNER STOP (report to the lead).
- The light walk and its WGSL twin change together, in one commit, with the test that pairs them.
- A picture is evidence only with its settle state recorded (streaming settled or not, far field settled or not);
  every picture you report you have opened and looked at, and you say what is still wrong in it.
- Reference cameras live in tools/voxel-bench/lighting-cameras.ts (one list); bench worlds are changed only through
  the commands and restored after; staging on 127.0.0.1 only while you test; leave nothing running.
- Gates: as the TESTS AND GATES section at the top; the lead runs the close's phase run.

47b (owner 2026-11-26). CURRENT PHASE = 47b: docs/plan-phase-47b.md §5 is the item table (the CONTRACT: never edit it;
status in §6's row, at most 400 characters; results in §9 under a heading for your item; decisions in §8 as "default
chosen, owner to confirm"). Start commit a22b8a99. D-rows continue at D835 (block to D899; grep both audit files first).
READ: AGENTS.md in full (the rule for tests, gates and sub-agents); docs/plan-phase-47b.md in full;
docs/architecture/voxel-engine.md; docs/decisions/owner-decisions.md; in this brief the "Host rules" list, the "47a"
section (its OWNER DECISIONS, SCOPE FENCE and HOW YOU WORK hold where this section does not replace them) and the
"47L" section's WHAT IS DIFFERENT; then only what the lead's prompt points at (a research note is an input: where it
differs from the plan, the plan stands).
OWNER'S RULES FOR 47b (do not cross, do not re-litigate):
- SCOPE IS FIXED: your item's row and nothing more. Trees, rocks, large props, the `prop` role, stamps from models and
  overlays are 47p: never built here. Anything that comes up is reported to the lead as one line for the roadmap's
  "noted for after the merge" list; do not build it. Nothing inside block layers, heightfield terrain, generated
  architecture or their scatter sources (48 removes them).
- FORMATS: only the plan's G1–G6, exactly as §4 says. Anything stored beyond them (a field, a file, a manifest key, a
  record bit, a command field G4 does not name) is an OWNER STOP: do not build it, report to the lead what you need and
  why, and finish the rest of the item. The two reserved vegetation bits stay unspent.
- TESTS: unit tests prove behaviour (real files, real workers, commands over HTTP in Node). No new browser test, no
  pixel bound, no wall-clock bound. Inside the item a commit is green on `npm run build` and the unit files you touched
  (`npx vitest run <files>`); `tools/gate.sh check` runs ONCE, at the item's end (`timeout 560 tools/gate.sh check`, one
  blocking call). If it is red: fix the cause or archive the test with the reason, then `tools/gate.sh check --failed`
  once. Never rerun to see whether it passes. Never run `tools/gate.sh phase` or `pictures` unless the lead's prompt
  says so. Report every gate call you made and its seconds: the phase has about 75 minutes of test time in all.
- PICTURES: a picture your item names is added to tools/voxel-bench/picture-list.ts (a new id) with what makes it
  (docs/pictures.md), taken once with `node tools/voxel-bench/run.mjs pictures --only <ids> --out <work folder>` in a
  capped scope, OPENED by you with the Read tool and described honestly in the results: what it shows, what is wrong,
  how sure. "Unverified" for anything you did not open. Give the lead the paths.
- PERFORMANCE is recorded, never a gate. This is a shared dev box: keep its load low (one heavy run at a time, in a
  capped scope, at most 3 rounds, no uncapped runs), and delete exports and traces you made.
- You run in the FOREGROUND of the lead's turn: never `run_in_background`, no detached helper, no timer, no sub-agent
  of your own. Every command is one blocking call under 10 minutes.
- Work folder ~/.cache/thirdlight-phase47b/work/<item>/ with `progress.txt` (a dated line a step: done, next, commit).
  `export TMPDIR=~/.cache/tmp`. Commit and push each green slice at once (only your own files, by path).
  Commit trailer: Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>.
- Docs with the code: the spec text an entry needs, voxel-engine.md where your item changes what it says, the manual
  page and reference entries your row names, §6's row and §9's results, STATUS's 47b row (at most 400 characters).
  `node tools/check-docs.mjs` alone, never piped or chained.
- Art (47b.10 only): game-ready assets by the art pipeline's rules, reported with triangle counts per LOD, texture
  sizes and file sizes.
REPORT to the lead at the end (at most 25 lines): commits; each gate call with its seconds and result; what each new
test would do with the feature broken; pictures by path with your read; D-rows opened or closed; anything stored that
you added (should be none beyond G1–G6); "default chosen" decisions you logged; what is unverified; what you left out
and why; lines for "noted for after the merge".
DONE = unit tests at the boundary changed, `tools/gate.sh check` green, §6's row and §9's results written (§5
untouched), pushed, nothing left running.
