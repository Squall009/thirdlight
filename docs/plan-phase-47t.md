# Plan — phase 47T: the test suite reset (after 47L, before 47b)

Owner, 2026-11-26 (quoted): "gates should be fucking fast… an hour total of test, e2e, and gate time per phase is
what I would want." "A rerun should be a minute, full gate 5." "The browser tests probably majorly don't need to be
done. This dev box should be doing nearly everything through unit tests. In browser acceptance usage in the editor
should be done manually by me." "I want an ai agent to look at them [the end-of-phase pictures], not compare the
goddamn black level percentages." "This container is a dev box… one of 10s that run on a single host… a throttle
here means throttles across many services." "We use the frame performance to gather the stats… as a baseline to
compare to but not the gods source of truth." "we need to be using a cached world." On the review page: "The acceptance page has grown into a fucking monster. We need to archive old
phases. I really only care about the current phase being worked on… If the pictures are taking up a ton of repo
space, we get rid of them… a clean review page that I can quickly go through and go yay or nay." On GPU-side defects that only
a browser shows: "a risk I am willing to take. I'd rather progress go fast and have me tell you something isn't
rendering right and fix it then."

Approved in substance by the owner in that conversation; he starts it in a fresh session. Start commit: the commit
of this plan. Branch `phase-45`. Next free D-number: D825.

## 1. Why (measured 2026-11-25/26)

- Gates took 15–25 % of the last three phases' wall clock (46e-b 15.0 h, 47a 16.4 h, 47L 8.7 h): 7–10 every-area
  gates a phase where the rule says one; most first attempts red on old flaky rows; all ten of the last
  every-area gates red before reruns.
- One wide gate is 39 min: build 48 s, lint 100 s, unit tests 9.5 min, browser tests 27 min.
- Unit: 796 files, 6,257 tests. 585 files take under 1 s each (87 s together). 42 files take 1,711 s (72 %),
  1,346 s of it in `tools/voxel-bench`, because they generate real-scale worlds on every run.
- Browser: 327 tests in 179 files, each file its own backend and page; ten acceptance stories take 26 % of the
  time; 197 fixed sleeps; four bounds sit inside their own noise (D659, D643, D817, D824).
- The defects that mattered were found by a person or an agent looking at pictures or reading code, not by a
  pixel bound.

## 2. What the suite is after this phase

| | Runs | Contains | Budget on this host |
|---|---|---|---|
| **check** | every commit an agent calls green | build and lint (incremental), the fast unit tests, the boot check | under 5 min; a rerun of what failed under 1 min |
| **phase** | once, at a phase's close | every unit test (on cached worlds), the boot check, the picture set | about 15 min, capped workers |
| **pictures** | at a phase's close | a fixed list of cameras and editor screens, each opened and described by an agent, published for the owner | part of the phase run |

- **Unit tests prove behaviour.** New work gets unit tests at the code boundary it changes (commands over HTTP in
  Node count as unit tests here: no browser).
- **The boot check** is the only browser test: about five tests, about a minute, pass or fail on "it starts and
  nothing errors" — the editor loads with no console error, a voxel world draws a frame, Play starts and stops,
  an export runs served statically with the backend stopped. No pixel bounds, no timing bounds.
- **Looks are judged from pictures** by an agent's honest written read and then by the owner; the owner uses the
  editor by hand between phases. No pixel-percentage criteria.
- **Performance is recorded, never gating**: frame rate, frame time, GPU time and memory are written to a report
  with the previous phase's numbers beside them. This host is a shared dev box; the numbers are a baseline.
- **A red is fixed or the test goes.** No rerun to see whether it passes this time, no "placing" at a base commit.
  The watch-row category for tests ends.
- **Total per phase: about one hour** (about eight checks and one phase run).

Accepted by the owner: a GPU-side or user-experience defect that only a browser shows is found at the phase's
pictures or by him in the editor, later than a browser test might have found it.

## 3. Scope

**In:** `tools/gate.sh` and its area file, the Playwright suite (`tests/e2e`), the slow unit files, the bench's
picture command, `AGENTS.md` and the agents' brief (the rules that demand browser tests, wide gates, reruns and
placing), the audit list's test rows, `docs/perf-recommendations.md` for demoted bounds.

**Out:** engine behaviour (a real defect found on the way gets a D-row, not a fix, unless it is one line);
`/home/dadmin/projects/thirdlight` (main) and game repos; removing engine code of retiring systems (48 does
that); 47b.

## 4. Items (the contract; status goes in §5)

| Item | Builds |
|---|---|
| 47T.0 | **The inventory.** One table, a row a browser test file (179): what it proves, and its fate — *retire* (block layers, heightfield terrain, generated architecture, terrain-splines, old probe lighting, WebGL 2: archived with their rows), *logic* (what it checks can be a unit test: name the unit test it becomes or the existing one that already covers it), *looks* (dropped; a camera or screen joins the picture set if nothing shows it yet), *boot* (the five kept). And a row a slow unit file (42): what world it builds and whether a cached world serves it. No test is changed in this item. The table is the plan for 47T.2–47T.4 and goes to the owner page; work goes on without waiting. |
| 47T.1 | **The two commands and the rules.** `tools/gate.sh check` (incremental build, cached lint, the fast unit set, the boot check; prints its time; under 5 min) and `tools/gate.sh phase` (everything, capped workers and memory, prints its time, writes the performance report). The old `fast`, `area`, `rerun`, `full` modes and the "changed since last green" widening go. `AGENTS.md` and `docs/briefs/voxel-agent-brief.md` rewritten to §2 (the Playwright-per-editor-change rule, wide gates, reruns, placing, watch rows for tests: gone). The check's time is recorded in the plan each time it runs in this phase. |
| 47T.2 | **Cached worlds.** The bench worlds the slow unit files build (the hilly world, the town, the caves, lakes) are generated once into a cache on disk outside the repo, keyed by the generator's version and parameters, and read by the tests; a changed generator rebuilds its cache once. Files that still take over 10 s after that are split: the part that proves a rule on a small made case stays in the check; the real-scale part runs in the phase run only. Target: the check's unit set under 2 min at six workers; the phase run's unit part under 8 min. |
| 47T.3 | **Browser tests to unit tests, then archived.** By the inventory: each *logic* check gets its unit test (or is shown covered) BEFORE its browser test is archived with `git mv`; *looks* and *retire* files are archived; their helper modules with them when nothing else imports them. The boot check is written fresh (five tests, one file, one backend), not carved from an old story. Bench tools that drive a browser to take pictures or measure stay as tools, not tests. |
| 47T.4 | **The picture set.** One command produces a phase's pictures from a fixed list (the lighting reference cameras and rooms that exist, plus the editor screens the archived *looks* tests covered: the structure mode, water body, spline, voxel world page), on a cached world, settled, with the bench's speck count and the performance report beside them. An agent opens every picture and writes what it sees and what is wrong, in a fixed short form; the pack is published with `add-phase.py`. The first run of it is this phase's own acceptance. |
| 47T.5 | **The defect list.** Closed: rows of retiring systems (about 59), rows whose only subject is an archived test (the watch rows of tests; duplicates merged), bounds demoted to stats (D659, D643, D817, D824 and the like). Moved to `docs/perf-recommendations.md`: rows that are a measured cost. Left open: real defects of the voxel path. The status key loses "watch" for tests. Counts before and after on the owner page. |
| 47T.6 | **The review page.** Measured 2026-11-26: the page lists 44 phases; its packs hold 913 MB behind it and the phases' work folders about 8 GB under `~/.cache/thirdlight-phase*` (46: 3.0 GB, 46e: 2.8 GB); pictures are NOT in the repo (181 tracked images, 9.6 MB, almost all editor assets). The page shows the phase being worked on and the one before it, nothing else: one short page a phase in a fixed form the owner can answer with yes or no (what changed, the pictures with the agent's read, what is wrong, the questions). Every older section leaves the page. Older picture packs and work folders are DELETED on the owner's word (quoted in the header), after a list of what goes with its size is written to the plan; kept: each old phase's acceptance text in the repo (`docs/briefs/acceptance-*.md`, moved to `archive/` with `git mv` when two phases old), the last two phases' packs, anything a current doc links to. `add-phase.py` (it lives outside the repo: a copy joins `tools/`) drops the oldest section itself when a new phase is added, so the page never grows again. Disk free before and after reported. |
| 47T.7 | **Close.** The check run three times in a row, green, with its times; the phase run once, with its time; a short independent review (did any *logic* check get archived without a unit test; do the rules and the commands agree; is anything still gating on a pixel or a time); the acceptance page `acc47t`: the times against §2's budgets, what was archived, the picture set's first run, what is no longer checked by anything. **Stop. 47b is not begun.** |

Order: 47T.0, 47T.1, 47T.2, 47T.3, 47T.4, 47T.5, 47T.6, 47T.7. 47T.1 comes early so the rest of the phase already runs
on the new check.

## 5. Progress

| Item | Status |
|---|---|
| 47T.0 | done 2026-11-26: `docs/inventory-47t.md`. 180 browser files (326 tests run): logic 149, retire 15, dropped browser-only 8, looks 5, boot 3; 131 logic files covered today, 19 new unit tests to write; 43 slow unit files (1,743 s), most partly served by a cached world; boot check and a 32-picture set drafted. |
| 47T.1 | done 2026-11-25: `tools/gate.sh check` (build in lanes, cached lint, fast unit set, `tests/e2e/boot.e2e.ts`) and `phase` (all units, boot, picture step skipped, perf report recorded); old modes and gate areas archived; AGENTS.md and the brief rewritten. Check GREEN 342–367 s (unit 287–308 s: over 5 min until 47T.2); `--failed` 31–60 s; phase trial GREEN 946 s. |
| 47T.2 | done 2026-11-26: shared vitest workers (isolate off where no state leaks; 10 files and the bench keep isolation, with why), bench worlds cached in `~/.cache/thirdlight-voxel-bench/worlds` (code-digest key), two oracles made fast, slow list 43 → 29 (real scale only). Check GREEN 204–225 s (unit 146–171 s: over the 2 min target); phase units 418 s. |
| 47T.3 | not started |
| 47T.4 | not started |
| 47T.5 | not started |
| 47T.6 | not started |
| 47T.7 | not started |

## 6. How this phase is run

- It obeys its own budget: until 47T.1 lands, an item's green is build + lint + the unit tests related to the
  change; no every-area gate, no rerun of an old flaky row, no placing. After 47T.1: `gate.sh check`.
- One Opus agent at a time, in the foreground (`AGENTS.md`, "Sessions and sub-agents"); no timers. Work folders
  `~/.cache/thirdlight-phase47t/work/<item>/` with a `progress.txt`; each green part committed and pushed at once.
- Light on the host: capped workers and memory for anything heavy; nothing left running.
- Archive with `git mv` into `archive/`, never `git rm`. Nothing stored by the engine changes. The one deletion
  this phase makes is 47T.6's old picture packs and work folders outside the repo, on the owner's word.
- Estimate: 8–14 hours of agent time; the uncertain part is how many browser tests hold logic worth a unit test.

## 7. Results

(one section an item)

### 47T.2

Measured on this host, 6 workers, capped like the gate; "tracked" is vitest's per-file import + test time summed over files.

| Step | Fast unit set | What it bought |
|---|---|---|
| before (47T.1's check) | 287–308 s; import 649–713 s tracked, tests 732–791 s | — |
| `isolate: false` everywhere | OOM at the 12 GB cap after 85 s | — (workers kept every file's worlds, backends and esbuild services) |
| two projects: 16 in-memory packages shared, the rest isolated | 213 s | import 713 → 427 s tracked |
| shared widened to backend, workspace, tests, tools (bench, crash isolated) | OOM at 127 s, then 147 s | esbuild's service (≈ 650 MB) stayed in each worker: stopped after each file |
| bench shared too | 146 s, peak 10.3–12.0 GB | nothing (146 against 147 s): the bench went back to isolation |
| world cache (fast files) | 146 s (check 204 s) | little in the check: its bench fills are small |
| 11 files back from the slow list, walk.test.ts to it, two oracles | 171 s (check 225 s) | coverage: the rules those files prove run in every check again |

- **Shared workers** (`vitest.config.mts`): project `shared` (`isolate: false`, setup `tests/shared-worker-setup.ts`: after
  each file esbuild's service stops and timers, stubbed globals and env are restored) and project `isolated` (a fresh
  process a file) for `tools/voxel-bench/`, `tests/crash/` and ten named files. Failed only when sharing a worker, and
  isolated with why rather than rerun: `tests/authoring-rules` and `environment-nodes` (vi.mock does not take on a module the
  worker already holds); `mesh-decals`, `projected-decals`, `see-through` (stored WGSL digests: three numbers nodes from a
  process-wide counter); `clipped-decals` (fakes `performance`) with `profiler` and `profile-view` (failed after it, cause
  not traced); `surface-relight`, `surface-probes` (old probe lighting, not traced); `stream.test` (its stale-result test
  needs the pool's replies after the second edit; once they came first). Memory peak 10.4 GB of 12.
- **The world cache** (`tools/voxel-bench/world-cache.ts`, `loadAreaCached`; the bench tests, `featuresStore` and
  `writeWorldRegions` load through it): `~/.cache/thirdlight-voxel-bench/worlds/` (beside the benches' other output; 43
  files, 44 MB). Key: the grid's `cacheKey` (generator and every parameter, set by `keyedWorld` in each generator), the
  area, chunk edge, store name, a digest of the generators' bundled code (esbuild, tree-shaken, no comments: a change to code
  that fills a world refills it once, a comment does not; chosen over a version constant that a change could forget) and
  V8's serializer version. Temp file + rename; an older digest's file of the same area is removed. Its own tests:
  `world-cache.test.ts`. Hilly 512 m: 2.6 s generated, 11 ms read; 1 km: 9.5 s, 32 ms. A cold cache costs 50 s of
  worker time once (34 areas of the slow set 44.7 s, 7 of the fast set 4.8 s).
- **What the cache did not do**: the slow files are derive-bound, not fill-bound (inventory's "partly"): the slow set took
  330 s cold, the fills 45 s of it summed. Caching derives (the oracle side) needs a decoder for derived data the engine
  does not have; not built.
- **Oracles made fast, same worlds and checks**: `occupancy-walk` 37 → 3 s (its blob world tests a cell against the balls in
  its 8-cell bucket, not all 40); `walk-graph` 33 → 7 s (the brute force's Dijkstra pops from a heap instead of sorting
  its open list, and keeps clearances during one search). Both left the slow list.
- **The slow list** (43 → 29) now holds real-scale files only (its `about` says so). Back in the check, as the inventory has
  them (no test over about 8 s, small made cases): open-regions, light-volume layout and rooms, check-boundaries,
  walk-graph-links, play, voxel-world, voxel-structures, far-cache-runner, spline-writer, create, edits, walk-feed. Moved to
  the phase run: `tools/voxel-bench/walk.test.ts` (20 s of real-scale derive at import; the walk's rule on made worlds is
  occupancy-walk's, now in the check).
- **Not split** (still on the list whole, the inventory's "check + phase" rows): derived, collision, stream, liquid,
  mesh-cases, glow, roof-mesher, far-fine, voxel-far-fine, kit-pieces, structure-grid, world-host, relief, relief-ring,
  light-volume-reference, kit-cases, case-forms. Each split moves their small tests (about 150 s tracked together) into the
  check, about 25 s more on the unit step; left for the owner's call against the 2 min target.
- **Phase run's unit part**: 603 s → 418 s (973 files passed, 13 skipped; warm cache; memory peak 10.4 GB).
- **Over target**: the fast set is 171 s, not under 2 min; the whole check is 225 s (under 5 min). Where the rest is: test
  bodies, 700 s tracked over 940 files (integration 248 s, backend 105 s, bench 80 s, three-adapter 63 s); import 123 s.
  Options: (a) the 11 returned files back on the slow list: about 25 s less, their rules out of the check; (b) more oracle
  work file by file (open-regions, light-volume layout); (c) more workers (the host rule caps 6).
- Build 25–28 s warm: nothing obvious; left. Boot test 2 keeps the made 48 m world.

### 47T.1

- `tools/gate.sh` 425 → 238 lines: `check`, `check --failed`, `phase`, `start check|phase`, `wait`. Each caps itself
  (a scope when run from a shell, the `thirdlight-gate` unit when started); one at a time (the shared lock). A red
  step no longer stops the run (a red build does), so one run lists every failure and `--failed` reruns the build,
  lint and only the failed unit files and boot tests.
- Build: `npm run build` is `tools/build-all.mjs`, the same steps in lanes (typecheck, history comments, the other
  checks in two lanes, the bundles). Warm 50 s one after another → 26–28 s in lanes; cold (no tsc build info) 128 s.
  Lint in the check: `--cache --cache-strategy content` under `node_modules/.cache/eslint`: cold 108 s, warm 1–2 s;
  a changed file is always linted again; a type-aware rule's answer in an unchanged file whose import changed is
  seen only by the phase run's full lint (111 s).
- The slow list: `tests/slow-unit-files.json` (the inventory's 43 files, with their seconds), read by
  `vitest.config.mts` (`TL_UNIT_SET=fast|slow`, unset = all: 941 / 43 / 984 files) and checked by
  `tools/check-slow-units.mjs` in the build. Vitest's config now leaves out `.claude/**` itself.
- The boot check, `tests/e2e/boot.e2e.ts`, one backend, a made 48 m flat-ground world with the wall-beam-banister
  scene: the editor loads (token, picker, Scene view frames); the world draws in the Scene view (chunks > 0, no
  problems); Play draws it and stops; an MCP play with no editor open (headless editor: observe running, a PNG
  screenshot); the export served with the backend stopped draws it, no request outside the folder. "Nothing errors":
  no console or page error, no failed or 4xx/5xx request. 19–30 s. The export test runs last (it stops the backend).
  One fix while writing it: the MCP observe answers `not_presented` until the first frame, so the poll reads the
  state instead of failing on that answer. None of the five needed a timing bound.
- `phase`'s performance step: on a GPU host, staging (started at 6G if not running, stopped after), then
  `run.mjs headroom --quality low --rounds 1 --copies none --scales none` on the 8 km world, then
  `tools/perf-report.mjs` (frame rate, frame p50/p95, GPU frame and per-pass ms, page heap and GPU memory) beside
  the newest earlier report in `~/.cache/thirdlight-logs/perf-reports/`; it never turns a run red. The picture step
  prints that it is skipped; 47T.4 replaces `pictures()` in `tools/gate.sh` with its command (and may add the
  bench's speck count to the report).
- Gone: `fast`, `area`, `rerun`, `full`, the changed-since-last-green widening, the rerun-alone of failed tests, the
  village perf check as a gate, `tools/gate-areas.json` and `tools/check-gate-areas.mjs`
  (`archive/removed-gate-modes/`). Docs that taught them: AGENTS.md (new section "Tests and the gate"), the agents'
  brief, `docs/deployment.md`, `docs/environment.md`, `docs/three-upgrade-checklist.md`,
  `docs/architecture/voxel-engine.md`, `docs/manual/features/performance.md`, STATUS's notes.
- Over budget: the fast unit set is 306–308 s at 6 workers (its files' own time 774 s; module imports 711 s more,
  vitest's report). That is 47T.2's target (under 2 min); moving more files to the slow list would hide coverage,
  so it was not done.

Check runs in this phase:

| When, commit | Total | Build | Lint | Unit | Boot | Result |
|---|---|---|---|---|---|---|
| 2026-11-25 23:07, 7a5f76cc + this item (uncommitted) | 366 s | 28 s | 2 s | 306 s (929 files passed, 13 skipped) | 30 s | GREEN |
| 2026-11-25 23:15, `--failed` (one boot test failed on purpose, one unit file) | 60 s | 27 s | 2 s | 17 s (1 file) | 14 s (1 test) | GREEN |
| 2026-11-25 23:17, `--failed` (one unit file) | 31 s | 28 s | 2 s | 1 s | — | GREEN |
| 2026-11-25 23:22, ea2d3363 | 367 s | 27 s | 2 s | 308 s | 30 s | GREEN |
| 2026-11-25 23:45, 4445b56b | 342 s | 28 s | 1 s | 287 s | 26 s | GREEN |
| 2026-11-26 00:35, 0582452d + 47T.2 (uncommitted) | 204 s | 28 s | 4 s | 145 s (1 file failed: a WGSL digest test in a shared worker) | 27 s | RED |
| 2026-11-26 00:39, the same, that file isolated (→ 5aa08fd5) | 204 s | 27 s | 2 s | 146 s (932 files) | 28 s | GREEN |
| 2026-11-26 00:46, 5aa08fd5 + 11 files back from the slow list (→ 9899be4e) | 225 s | 25 s | 4 s | 171 s (944 files) | 25 s | GREEN |
| 2026-11-26 01:23, dc274ab1 (47T.3 batch A: 74 browser files and 4 unit files archived, 8 new unit tests) | 236 s | 26 s | 6 s | 179 s (946 files) | 25 s | GREEN |
| 2026-11-26 01:49, 8d1b7f0b (47T.3 batch B: 24 more browser files archived, 14 new unit tests) | 239 s | 25 s | 8 s | 181 s (1 file failed: `memory3d`, Rapier's WASM heap shared with earlier files in a worker) | 24 s | RED |
| 2026-11-26 01:53, `--failed` (that file isolated) | 34 s | 25 s | 2 s | 6 s (1 file) | — | GREEN |
| 2026-11-26 02:04, aae79d14 (47T.3 batch B done: 57 browser files archived, 17 new unit tests) | 250 s | 26 s | 9 s | 188 s (1 file failed: `vertex-paint-draw`, stored WGSL digests after other files in its worker) | 27 s | RED |
| 2026-11-26 02:08, `--failed` (that file isolated, as the other WGSL-digest files) | 33 s | 26 s | 1 s | 6 s (1 file) | — | GREEN |

The phase run's one trial, 2026-11-25 23:29 at 0e511679 (`tools/gate.sh start phase`): GREEN in 946 s — build 29 s,
full lint 110 s, every unit test 603 s (972 files passed, 13 skipped), boot 25 s, pictures skipped, perf 179 s
(staging started and stopped; low tier 30 fps, 0 of 89 frames missed, p50/p95 33.2/36.5 ms, GPU frame 17.09 ms, page
heap 687 MiB, GPU 1040 MiB; post's GPU ms reads below zero, which the report shows as not readable). Memory peak
6.2 GB, load mean 7.3 peak 12.3. Its report is the first in `~/.cache/thirdlight-logs/perf-reports/`: the next phase
run's "previous".

### 47T.0

- `docs/inventory-47t.md`, built from the last every-area gate's e2e log (gate-fast-20261125-163859) and the last whole-suite vitest log (gate-fast-20261125-183438); nothing was run. Its generator and raw tables: `~/.cache/thirdlight-phase47t/work/47T.0/`.
- Browser: 180 files, 326 tests run + 11 skipped, 2,861 s summed. Lead fates: logic 149 files (2,295 s), retire 15 (409 s), dropped browser-only 8 (76 s), looks 5 (47 s), boot 3 (34 s); 27 files mixed. Of 150 files with logic, 131 are covered by unit tests that exist (titles read, bodies to be read in 47T.3), 19 need one new unit test each.
- Unit: 43 files at 10 s or more, 1,743 s (19 voxel-bench files 1,242 s). Most are "partly" served by a cache: the world comes from it, the derive they prove still runs; the real-scale tests inside them go to the phase run.
- Boot check: editor loads, a voxel world draws, Play starts and stops, an export runs with the backend stopped, and an MCP play with no editor open (the agents' path).
- Pictures: 22 existing bench cameras plus 10 new editor screens.
- For the lead: blocks.e2e.ts is gameplay entities, not block layers (census said retiring; here logic); ktx2-rgba-thumbnails (WebGL 2) retire; webgpu-reference and memory dropped or kept as bench tools; the retiring systems' slow unit files (surface-probes, surface-bake, block-mesh-worker, m42 bake-lighting) archive now or at 48.

## 8. Decision log

- **2026-11-26 — the reset is the owner's direction** (quoted in the header): unit tests first, a five-test boot
  check, looks from pictures read by an agent and by the owner, performance as recorded stats, cached worlds, one
  hour of test time a phase, later discovery of browser-only defects accepted.
- **2026-11-26 — the workstation is not part of the routine** (lead): it is not always on; the check must fit
  this host. Real performance numbers are taken there by hand when wanted.
- **2026-11-26 — the inventory's unsure fates** (lead; default chosen, owner to confirm): `blocks.e2e.ts` is
  *logic* (gameplay entities, not block layers); `ktx2-rgba-thumbnails.e2e.ts` retires as WebGL 2-only;
  `webgpu-reference.e2e.ts` and `memory.e2e.ts` are archived and not kept as bench tools (the picture set shows
  post effects and skies; leak checks were already skipped in every gate); the retiring systems' slow unit files
  are archived in 47T.3 with their browser tests (§9 question 2's default); the repository test in
  `tools/check-size.test.mjs` runs in the phase run only. The fifth boot test is an MCP play with no editor open.

## 9. Open questions for the owner (each with the default that stands if unanswered)


1. **The picture set's size.** Default: about 30 pictures a phase (the reference cameras and rooms, four editor
   screens), so an agent's read and yours stay short.
2. **Old systems' tests go now, before 48 removes the systems.** Default: yes (you do not expect to use block
   layers after the merge); their engine code is untested until 48 deletes it.
3. **How many phases the review page keeps.** Default: two (the current one and the one before it); older
   picture packs are deleted, their acceptance text stays in the repo's archive.
