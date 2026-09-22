# Test-hygiene repair — disposable test roots and orphaned children (2026-09-21)

Owner-requested maintenance (not a packet): the test suite had filled
`/home/dadmin` with ~9,900 orphan `.tl07-tmp-*` directories, and `.tl*`
directories were never cleaned up. Fixed and removed. No commit made (the
tree carries a large uncommitted M2/M3 campaign; changes left in-tree for
the owner to commit).

## 1. Why the garbage accumulated

Every disposable test root is cleaned up ONLY by in-process mechanisms:

- per-test `rmSync(root)` in some files,
- `afterAll` hooks in the crash/ownership test files,
- `process.on('exit')` backstops in `packages/workspace/tests/helpers.ts`
  and `tests/integration/m2-builds/helpers.ts`.

`process.on('exit')` (and `afterAll`) **never run when the process is
killed by a signal**. This project's long suite runs are killed regularly
(pi-service restarts, orchestrator/model stalls, timeouts), so every killed
run left every root it had created behind, forever. Nothing ever reaped
stale roots. Evidence recorded during the repair:

- all 9,898 accumulated dirs were `.tl07-tmp-*` (the two helper files,
  which create one root per `setup()`-per-test — 19 in
  `m2-storage.test.ts` alone per run);
- one full-suite run SIGKILLed at t=12s leaked roots (65 in a t=45s kill);
- **second garbage class found**: 21 orphaned test CHILD processes
  (`claim`-mode holders, `contend-*` gate waiters, ppid=1), the oldest
  3.5 days old — the workers that spawned them were SIGKILLed mid-test.

## 2. The fix (smallest complete)

**External reaping** — in-process cleanup cannot survive SIGKILL, so the
suite now reaps its own residue between runs:

- `tests/test-hygiene.ts` (new):
  - `sweepStaleRoots()` — removes dirs under `/home/dadmin` (the tests'
    own `ROOT_BASE` rule: home when `/tmp` is tmpfs) matching the complete
    set of disposable prefixes (`.tl07-tmp-`, `.tl07-crash-`,
    `.tl23-crash-`, `.tl46-crash-`, `.tl07e1-crash-`, `.tl07e1-bundle-`,
    `.tl25-`, `.tl35-`, `.tl36-serve-`, `.tl48-`) whose mtime is older than
    60 s. The floor guarantees a live run's roots (fresh mtimes) are never
    touched — an age-0 teardown sweep was tried and rejected when it
    destroyed a concurrent run's in-flight roots (orphan-run incident,
    recorded in the module header).
  - `sweepStaleBundleFiles()` — same floor for stale `child-<pid>.mjs` /
    `mcp-<pid>.mjs` in the repo's `.tl25/35/48-bundles/` dirs (a killed
    integration worker never runs `cleanupBundles()`).
  - `reapOrphanedTestChildren()` — kills node processes with ppid==1 whose
    command line references a disposable test bundle dir (crash
    `child.bundle.mjs`, ownership `ownership-child.bundle.mjs`,
    integration backend/MCP children). Live runs' children (ppid != 1)
    are never touched.
- `vitest.config.mts` (new): wires the module as `globalSetup` +
  `globalTeardown` — the only non-default in the root config; everything
  else stays at vitest defaults.
- Backstop hardening (both helpers): the `exit` handler now also covers
  the SIGTERM/SIGINT supervisor paths (`process.once` + cleanup +
  exit) — covers `systemctl restart pi`-style SIGTERM before escalation.
- `.gitignore`: `.tl*-bundles/` (repo-internal bundle dirs no longer show
  as untracked garbage).

Steady state: normal runs leave zero residue (per-process backstop);
SIGKILLed runs leave at most one run's residue (≤ ~65 dirs + a few
children), reaped at the next `vitest` invocation (roots once >60 s old;
orphaned children and stale bundle files immediately).

## 3. Changed files

- new `tests/test-hygiene.ts` (reaper module)
- new `vitest.config.mts` (globalSetup/globalTeardown wiring)
- `packages/workspace/tests/helpers.ts` (backstop: +SIGTERM/SIGINT)
- `tests/integration/m2-builds/helpers.ts` (backstop: +SIGTERM/SIGINT)
- `.gitignore` (+`.tl*-bundles/`)

## 4. Commands run and results

- Baseline: `ls -d ~/.tl*` → **9,898** dirs (all `.tl07-tmp-*`).
- Root-cause proof: full suite SIGKILLed mid-run → 65 roots leaked
  (pre-fix), next run left them (no reaper existed).
- First post-fix run: globalSetup **reaped all 9,963** stale roots
  (incl. the 65) in ~1 s; home count 0.
- Orphan proof: 21 ppid=1 test children found (3.5 days old); next run's
  globalSetup killed all 21; 0 remain.
- End-to-end kill cycle (post-fix, correct process-group SIGKILL at
  t=12s): 1 root + 2 bundle files leaked → next run's globalSetup reaped
  both (logged) → suite green → home 0, repo bundle dirs 0.
- Final gate: `npm test` → **179/179 files, 2237/2237 tests passed**
  (45–48 s); `npm run build` (check-deps, check-boundaries, typecheck,
  build) → exit 0.

## 5. Acceptance

- PASS: home `/home/dadmin` has zero `.tl*` directories after a run,
  after a SIGKILLed run + next run, and after the one-shot cleanup.
- PASS: the one-shot garbage (9,898 dirs + 21 orphan children + 2 stale
  bundle files) is removed.
- PASS: full suite + toolchain green with the new config.
- UNVERIFIED: nothing visual; no browser involved.
- Limitations: two concurrently running suites are forbidden by project
  protocol; if they ever overlap, a run may fail on ENOENT of roots the
  other run's teardown considers stale — the 60 s mtime floor minimizes
  this. SIGKILL residue is reaped at the NEXT invocation, not instantly
  (by design — no external daemon).
- Contract-change requests: none.
- Exact next packet: N/A (owner-requested maintenance; whatever the
  owner resumes — M2/M3 campaign work in the uncommitted tree).