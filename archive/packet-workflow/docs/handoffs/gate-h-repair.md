# Gate H bounded repair (R1–R7)

**Outcome.** All adjudicated repairs R1–R7 applied as one docs-and-test-first
change. No git commit (per Gate H prompt). Owner pre-approval tag; final manual
review pending. This record is not owner or separate-reviewer approval.
Browser/hardware claims stay UNVERIFIED.

**Per-R status.**

- **R1 (F1) applied.** `packages/runtime/src/runtime.ts` initialises
  `committed = cloneCurr(args.curr)` at instantiate. New first-step
  fail-stop fixture case `F1b-first-step-throw`
  (`fixtures/m2/runtime/failstop.json`, index re-hashed) and regression test in
  `tests/m2-runtime/runtime-fixtures.test.ts` (both the `x=9` mutation probe and
  the port-commit `x=1` probe render the committed initial `[0,1,0]` at
  `stepIndex 0`, alpha 0).
- **R2 (F2) applied.** `packages/input/src/browser.ts` routes every active-pad
  change through a shared `freshActivation()` (used by `deviceLost` and the
  lower-index takeover). New test in `packages/input/src/browser.test.ts` proves
  no phantom `pressed` on takeover while the button is held, then a real
  release→press still produces the edge.
- **R3 (F3) applied.** `fixtures/m2/contracts/runtime/catchup.json` O7 is now
  the reachable zero-controller case (`config_invalid`/`controller_target`);
  new `O7b-controller-count-two` is `snapshot_invalid`/`scene_validation`
  (`controller_count_invalid`). Test coercion removed; `sceneErrorCode`
  asserted. Checker code set and `expected.json` (`ownershipCases: 9`) updated.
- **R4 (F4/C30-1) applied.** `input.md` §4–§5 promoted into
  `docs/contracts/runtime.md` §12.5.4–§12.5.8 with the C30-2 (both keys cancel,
  D-pad/stick still apply) and C30-6 (awaiting-release tap dropped) diffs;
  references repointed; proposal marked as completed promotion.
- **R5 (F5/C32-1) applied.** Exact slide rule (steep normal **or** bounded
  descending correction with the `tan(min_slide)` ratio guard, gated on
  `moveX === 0`) added as `platformer.md` §7.4 + §7 step H and as a
  `project-model.md` §21.6 row; `physics.md` §8 attribution corrected (no
  adapter slide at 30°, C31-4).
- **R6 (D rows) applied.** C29-1/2/4/5/6/7/8/9; C30-3/4; C31-1/2/5 and the
  additive `physics-rapier` row; C32-2/3/4. C32-5 rejected as recorded;
  C30-5 docs half (`sessions.md` §13.1 `allow="gamepad"`) applied.
- **R7 (F6/F7) applied.** Snap-beyond wording now describes both phases
  (grounded + `snapped` descent then ~20 ungrounded free-fall steps, landing
  0.36000) in `manifest.md`/`32.md`; CPU paragraph/handoff quote the committed
  `06-cpu.json` (p99 0.116521/0.088128/0.060646); `physics-rapier`/`input`
  index comment misattributions and the browser-procedure pointer corrected.

**Files changed (grouped).** Runtime: `runtime.ts`. Input: `browser.ts`,
`browser.test.ts`, `index.ts`. Fixtures: `m2/runtime/failstop.json`+`index.json`,
`m2/contracts/runtime/catchup.json`, `expected.json`, `tools/check-fixtures.mjs`,
`m2/course/tolerances.json`+`index.json`. Tests:
`tests/m2-runtime/runtime-fixtures.test.ts`,
`tests/browser/m2-input/m2-input.browser.ts`. Docs/contracts:
`runtime.md`, `project-model.md`, `dependencies.md`, `sessions.md`;
`planning/m2-contracts/{input,physics,platformer}.md`; evidence-32 manifest;
handoffs `32.md`; `STATUS.md`.

**Commands + actual results.** `npm test` 119 files/**1564 passed**;
`npm run typecheck` exit 0; `npm run check-deps` exit 0; `npm run
check-boundaries` 14/251/908, 0 violations; `npm run build` 4 built/0 skipped;
`check-fixtures.mjs` 34/34; runtime/input/physics/course checkers exit 0;
targeted `tests/m2-runtime`, `packages/{runtime,input,platformer}`,
`tests/m2-{controller,physics}` = 25 files/**302 passed**.
**Negative controls:** R1 (comment out the `committed` init) → F1b fails
`expected [9,1,0] to equal [0,1,0]`; R2 (skip `freshActivation()` on takeover)
→ `expected 'pressed' to be 'held'`; R3 (restore the old coercion) → `O7b:
expected 'config_invalid' to be 'snapshot_invalid'`. All restored after
recording.

**Re-acceptance.** The reopened Gate E destination portions changed here are
re-accepted as of this repair: `runtime.md` §8, §12.0–§12.2, §12.4,
§12.5.1–§12.5.8, §12.6; `project-model.md` §21.1/§21.6; `dependencies.md` §3
rows; `sessions.md` §13.1; and the accepted `platformer.md` §7/§7.4 +
`physics.md` §8 text.

**Not applied.** C30-5's `App.tsx` `allow="gamepad"` attribute stays for packet
35 (adjudication: lands when packet 35 attaches input; R6 is docs-only).
C32-5's packet-31 edit is rejected as recorded.

**Next step:** packet 33 — immutable behaviour builds (not started).
