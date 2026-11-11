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
CURRENT SUB-PHASE: 46d-c (see the "46d-c" section at the end; the lead's prompt names your item). NEVER start 46e (lighting).
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
`| Dn | Sev | open | … |`; closing sets `fixed <commit>` (or superseded / won't fix / watch).

Host rules (an OOM once forced a shutdown of this host (16 GiB then, 32 GiB since 2026-11-11); the owner was furious):
- EVERY backend, browser, perf, benchmark or gate run is memory-capped, reruns included. Gates:
  `TL_GATE_MEM=12G TL_VITEST_WORKERS=6 tools/gate.sh start fast <e2e files>` then `tools/gate.sh wait`, started only
  with >= 14 GB available. Ad-hoc runs (benchmarks too):
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

Gates (owner 2026-11-11: run only what a change affects; tools/gate.sh, AGENTS.md "Gates"):
- tools/gate.sh REFUSES uncapped runs. Every mode runs detached and capped, started only with >= 14 GB available:
  `TL_GATE_MEM=12G TL_VITEST_WORKERS=6 tools/gate.sh start <mode> …` then `tools/gate.sh wait` (NEVER run a mode
  directly in your shell). TL_VITEST_WORKERS=6 always (an uncapped vitest OOM-killed a full gate at 8G). The unit
  is also CPU-capped (TL_GATE_CPU, default 1100% = 11 of 16 threads); the summary's last line gives the 1-minute
  load's mean and peak (load.log). Steps run in turn: lint + vitest beside e2e was measured and backed out
  (docs/environment.md "Gate on this host"); keep e2e at 2 workers (fast) / 3 (wide).
  - `fast [--all] [e2e files…]` per commit: build, lint, `vitest related` on the files changed since the branch's
    last green gate (~/.cache/thirdlight-logs/last-green-phase-45; whole suite with --all, without a base, or when
    package/config/gate/check files changed), the core smoke (authoring-loop, play-export), the e2e areas the
    changed files map to (tools/gate-areas.json; voxel = voxel-world + webgl2-smoke; project-model, shared and the
    backend's plumbing = every area, `everyArea`) and any files named; the
    village perf check (WebGPU only, at the cap) only when three-adapter/runtime/game-host/voxel/effects/perf
    changed. Only a clean tree is recorded as green: commit before you gate.
  - `area <name>…` at the end of an item that changed an area broadly (leak test on).
  - `phase <start-commit>` once at a sub-phase's end (lead): every unit test + core + areas touched since then.
  - `full` only for the merge to main or on the owner's word. There is no `--both-renderers` any more: WebGL 2
    is covered by tests/e2e/webgl2-smoke.e2e.ts alone.
  - Perf one-off miss → `tools/gate.sh rerun`; repeat miss → interleaved same-hour A/B against base d4053cab
    (3 rounds, base worktree built with `node tools/build.mjs` under ~/.cache/thirdlight-phase46/work/, removed
    after); equal = host state, note it.
- Never edit tools/gate.sh (or scripts it runs, tools/gate-areas.json, tools/check-gate-areas.mjs) while
  `systemctl is-active thirdlight-gate` is active, and no code while a phase or full gate runs. A new e2e file
  must be put in an area (the build fails).
- `tools/gate.sh rerun` rebuilds from the working tree: move uncommitted changes aside first.
- Tests at real boundaries. Format/codec/store/streaming logic → vitest (real codec, real files on disk, real workers
  where workers are claimed). Browser behaviour → Playwright against a real backend. A test that only confirms its own
  mock does not count. Vitest: pass `--exclude '.claude/**'`.
- E2E budget: NO new e2e files. Extend tests/e2e/voxel-world.e2e.ts (one backend) for browser behaviour; everything
  else is vitest. Record voxel-world.e2e.ts time before → after (~58–65 s at the start of 46c, up from 22.5 s at the start of 46a: do NOT grow it further without need — extend existing tests, prefer vitest) and of any file you touch.
- Flaky tests on watch: grep 'watch' in docs/audit-2026-09-22.md. A failure that passes on rerun gets a note.
- HIDDEN REGRESSIONS: a fast-gate failure that ALSO fails at the base still gets a D-row and must be fixed before the
  phase's full gate; say so in your final message.
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
GATES: always pass TL_VITEST_WORKERS=6 (an uncapped vitest OOM-killed a full gate at 8G).

46d-b (owner 2026-11-09, plan-46d §9 entries of that date + §6d are REQUIREMENTS): height in the ALBEDO alpha (texture
layout v1 amended, owner note); relief displacement OFF on every tier for now (switch kept, height lighting stays);
blend distance per material with a world default (smaller wins); far mesh field ~1/4 of its triangles keeping
silhouette + colour; brick far field must stop turning to mush. PERFORMANCE ROLE: keep measuring and recording, but
you are not the go/no-go validator; flag only obvious regressions (the owner's "demo" project tests real-game scale).
D-rows continue at D568.

WEBGPU FIRST (owner 2026-11-10; AGENTS.md; plan-46d §2/§9): WebGPU is the renderer voxel work is designed, built,
tested and measured for. WebGL 2 is a fallback: it keeps what it draws today and gets ONE smoke check per area
(loads, draws, no console error), no new features, no parity. New items measure and take pictures on WebGPU only;
cut existing both-renderer e2e passes / two-renderer rounds in the area you touch (not a sweep). Vista steps
46d.17–46d.20 go on compute, reusing three-adapter occlusion-pyramid.ts and occlusion-instances.ts (no second
culling path). Vista note: docs/research/voxel-vista-performance.md (§6 supersedes §4 where they differ).
Commit trailer now: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

46d-c (owner 2026-11-11). CURRENT SUB-PHASE = 46d-c: plan-46d §6d rows 46d.24 (travel at speed by hitches and settle
times) and 46d.25 (fine bricks from GPU compute past the detail ring); spec = docs/briefs/streaming-rings-2026-11-11.md
(§1 decisions, §2 measures, §4 layout). 46d-c start commit fda36fa8. D-rows continue at D612 (block D600–D699).
Commit trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Deferred by the owner, never revive:
detail-piece LODs, relief, GPU tessellation of the near mesh, whole-map bake of near detail ("derived data is never
stored" stays). Never start 46e.
