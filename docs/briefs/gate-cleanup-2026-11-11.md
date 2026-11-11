# Gate and rules cleanup — ready-to-apply brief (2026-11-11)

Written by session thirdlight-65 for the session that owns the `phase-45` worktree. Nothing in the repo was
touched to write this. Read at 18217878; re-check line numbers against your tree. The designs below were read
from the files, not run: verify each with one gate and record the before/after times.

**Owner's instruction (2026-11-11):** "Doing full gate runs that take a half hour at a time need to be split up
and only run gates on affected systems, kept modular and efficient/quick. I think this would help with false
failures too. I agree the agents.md file needs cleaned up to reflect the current project and objectives." Also:
this is a hobby project with nothing shipped; "I would rather move a little fast and loose rather than extremely
slow"; all game projects are on hold and may break until the voxel migration; the voxel phases finish on the
branch, then merge to main, then the demo project comes in; nightly backups exist at the host level.

Apply between two rendering items, each step its own commit. Order is by value for effort. Steps 1–3 are an hour
or two together and pay back on every later commit.

## Why (numbers from `~/.cache/thirdlight-logs`, Nov 1–10)

- 172 fast gates, about 1,890 min; green average 10.0 min (Nov 1) → 15.1 min (Nov 10); latest 13–18 min.
- Vitest is the growth: 892 files, wall 521 s (`gate-fast-20261110-222020`). Summed test time by file:
  `tools/voxel-bench/stream.test.ts` 162 s, `derived.test.ts` 116 s, `far-world.test.ts` 108 s,
  `level-materials.test.ts` 58 s, `mesh-cases.test.ts` 53 s, `collision.test.ts` 39 s, `roof-mesher.test.ts`
  33 s. They run on every commit whatever it touched.
- 59 of 250 gate runs had "failed once, passed alone": `scan-bounded-log.test.ts` 37×, voxel-bench
  `stream.test.ts` 27×, `edge-cases.test.ts` 24×, `see-through.test.ts` 8×. `vitest.config.mts` sets no
  `testTimeout`, so these are vitest's default 5 s under 4-worker load, or millisecond bounds.
- The smoke set's `start.e2e.ts` (D417/D453) and `rendering.e2e.ts` (D320) redden unrelated commits.

## Step 1 — test timeouts (minutes)

`vitest.config.mts`, in `test`: add `testTimeout: 30_000, hookTimeout: 30_000`. Update the header comment (it
says the hygiene setup is the suite's only non-default).

Then the wall-clock assertions: a unit test must not assert elapsed milliseconds (they read the host's load).
In `packages/workspace/src/scan-bounded-log.test.ts`, voxel-bench `stream.test.ts` and `edge-cases.test.ts`, and
`see-through.test.ts`, replace each ms bound with a count or ratio (work done, calls made, bytes read), or move
the timing to the bench CLI (`run.mjs …`) where it is reported, not asserted. When a flake's cause is gone, move
its watch row (D307, D418, D454, D523, D554, D311, D435) to closed.

## Step 2 — the unit step runs what the change affects

In `tools/gate.sh`:

- **Remember the last green tree.** In `done_`, on GREEN, write `git rev-parse HEAD` to
  `$LOGS/last-green-$(git rev-parse --abbrev-ref HEAD)`, but only when `git status --porcelain` is empty (a gate
  that ran on uncommitted work proves a tree no ref names; skip the write and say so in the summary).
- **The changed set.** `base` = that file's commit if it is an ancestor of HEAD, else none.
  `changed` = `git diff --name-only $base` (working tree against it, so uncommitted work counts) plus
  `git ls-files -o --exclude-standard`.
- **Whole suite when** there is no base, or `changed` matches any of: `package.json`, `package-lock.json`,
  `tsconfig*.json`, `vitest.config.mts`, `eslint.config.mjs`, `tools/gate.sh`, `tools/check-*.mjs`,
  `tests/test-hygiene.ts`, `**/package.json`, or a non-source file tests read from disk (`fixtures/**`,
  `templates/**`, `packs/**`, `docs/architecture/**` for `role-spec-doc.test.ts` and its kind). Otherwise
  `npx vitest related --run $changed_source_files` with the same excludes and worker cap. `related` follows the
  import graph, so a change in `shared` or `project-model` still runs nearly everything (correct), and a change
  in `three-adapter` no longer runs `tools/voxel-bench` (it imports `voxel`, not the adapter).
- **`gate.sh fast --all`** forces the whole suite. Say in the summary which it was: "vitest: related to N
  changed files (M test files)" or "vitest: whole suite (reason)".
- Check on vitest 5.0.1 that `related --run` exists with these flags (`npx vitest related --help`); if the
  spelling changed, `--changed $base` is the equivalent.
- Changed test files themselves are in `changed`, so they run.
- The rerun path (`unit "${files[@]}"`) stays as it is.

Expected: a three-adapter-only commit drops most of the 521 s; a voxel commit still runs the bench tests. For
those, shrink the three largest (`stream`, `derived`, `far-world`) to the smallest world that still proves the
behaviour, and leave the large-world numbers to the bench CLIs. Estimate only: 3–5 min for a typical gate.

## Step 3 — WebGPU first, once, centrally

The owner agreed to do this in one cut rather than area by area.

- `tests/e2e/renderer-variants.ts:30,38`: `RENDERER_VARIANTS` and `PRODUCT_RENDERER_VARIANTS` become the product's
  renderer only on a GPU host (`auto`); keep SwiftShader's behaviour for hosts with no GPU. 44 e2e files loop
  over these; fix the few that index a variant by name.
- Add one `tests/e2e/webgl2-smoke.e2e.ts` on forced WebGL 2: the editor opens a project, the Scene view draws,
  Play runs, an export served with the backend stopped draws, a voxel world draws; no console error. That is
  the whole WebGL 2 coverage.
- Archive with `git mv` (not delete): `env-parity.e2e.ts`, `shader-parity.e2e.ts`, `scene-view-parity.e2e.ts`,
  `tests/e2e/parity.ts` and their folders.
- `playwright.config.mts`: drop the `webgpu` project's `WEBGPU_BY_PROJECT` on a GPU host (it only served the
  parity specs); keep `WEBGPU_SPECS` for a host without a GPU. Rewrite the header comment.
- `tools/gate.sh`: remove `--both-renderers`, `FULL_WORKERS_BOTH`, `TL_E2E_ALL_VARIANTS` and the header lines
  about them.
- The perf check (`perf_check`, `tools/perf/run.mjs village --gate`): WebGPU only; drop the WebGL 2 half of
  `tests/perf/village-baseline.json`. Run it only when `changed` touches `packages/three-adapter`,
  `packages/runtime`, `packages/game-host`, `packages/voxel`, `packages/effects` or `tools/perf`.

## Step 4 — e2e by area, and no routine full gate

- **Area map.** A new `tools/gate-areas.json`: area name → source globs → e2e files. Start from what agents
  already pass by hand to `gate.sh fast`: e.g. `voxel` (`packages/voxel/**`, `packages/three-adapter/src/voxel-*`,
  `packages/runtime/src/voxel-*` → `voxel-world.e2e.ts`), `rendering`, `materials`, `lighting`, `effects`,
  `editor-ui`, `scenes`, `content`, `export`, `mcp`, `physics`, `audio`, `input`. A file may sit in two areas.
  An e2e file in no area fails `npm run build` (a small check beside the others), so the map cannot rot.
- **Fast gate e2e** = a core smoke of three files (`start`, `authoring-loop`, `play-export`) + the areas the
  changed files map to + any files named on the command line. The other seven of today's `SMOKE` files move
  into their areas. Fix or quarantine `start.e2e.ts`'s exit-code flake first; it is in every run.
- **`gate.sh area <name>…`** runs every e2e file of those areas (leak test on), for the end of an item that
  changed an area broadly.
- **Phase close** = `gate.sh phase <start-commit>`: whole vitest suite + the areas touched since that commit +
  the core smoke. `gate.sh full` (everything) stays, for the merge to main and on the owner's word only.
- Record each area's time in the summary so growth is seen per area.

## Step 5 — AGENTS.md

Replace with `~/.cache/thirdlight-tooling/AGENTS.proposed.md` (beside this file): diff it against the tree
first. What changed and why:

- Commits go to the working branch (`phase-45`); `main` is frozen until the voxel merge. The old line said
  "commit to `main`".
- Gates rewritten for steps 1–4; "the full gate is never run twice" and "one pass" wording gone.
- New: one writing session per worktree; another session hands work over as a brief. Briefs live in the repo.
- New: no wall-clock assertions in unit tests; timing belongs to benches.
- New: the performance target and the travel speed (owner 2026-11-10), the project's pace (owner 2026-11-11),
  games on hold.
- Removed: the `.claude/worktrees` trap (the gate excludes it; the folder does not exist), "from phase 26.1".
- Unchanged in substance: architecture rules, WebGPU first, done-means-observed, size and redefinition
  ratchets, three.js updates, the per-phase review, engine/game separation, the traps that still apply.

## Step 6 — stale orientation (minutes each)

- `docs/STATUS.md` header: "Updated 2026-11-01. Current phase: 44b" and "On 2026-10-30: 118 open … 18 watch".
  Now: branch `phase-45`, 46d-b in progress, 171 open (M 39, L 132), 38 watch; re-count when you edit.
- `skills/thirdlight/SKILL.md:168` and `docs/manual/guides/performance.md:96` say to measure uncapped; the
  owner's rule is the display cap, always (`docs/manual/features/performance.md:117` has it right, and its
  line 95 still describes an uncapped run).
- `docs/manual/guides/which-tool.md` has no voxel row and sends level work to block layers, terrain and
  architecture, which 48b retires: add the voxel path and say the old systems are going. The skill and
  `traps.md` have no mention of voxels or of `no_change`.
- `docs/deployment.md`'s tool list omits `tl_bake_lighting`. `docs/environment.md` says `/` is 48 GB with
  512 MiB swap; `df` shows 63 G and no swap.
- `docs/roadmap.md` principles 5 and 7 (both renderers; 60 fps at 1080p) and charter §2's "supported WebGL 2
  baseline" predate the 2026-11-10 decisions.
- Reserve D600 onward (the block ends at D599; the list is at D590).

## Step 7 — from the next plan on, split results out (optional, cheap)

`plan-phase-46d.md` is ~3,070 lines / 324 KB, about 80 k tokens before an item starts. From the next plan:
`plan-phase-<n>.md` keeps scope, items, progress and the decision log; `results-phase-<n>.md` takes the
measured results and pictures. Extend `tools/check-docs.mjs`'s plan glob if it needs to know. Do not split the
existing plans. Move the agent brief from `~/.cache/thirdlight-phase46/` into `docs/briefs/` when next edited.

## Not in this brief

The frame profiler and one shared frame budget (a phase of its own, being planned with the owner); the
post-stack performance phase; anything for the game repos (on hold by the owner).
