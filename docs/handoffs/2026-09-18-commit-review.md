# Handoff — review of 2026-09-18 commits

## Outcome

Owner-requested review, not an implementation packet. Reviewed all **11 commits**
from 2026-09-18 00:00 UTC (host timezone) through `be59d15`:
`b15786a^..be59d15`. Starting tree clean.

**Changes required before packet 08.** Report:
[docs/reviews/2026-09-18-commits.md](../reviews/2026-09-18-commits.md).
It contains file/line references, concrete repros, expected behavior, repair
criteria, every commit's disposition, and proposed orchestration work order.

**17 new findings: 11 P1, 6 P2**, plus two separately labeled inherited P2
command-validation issues. Principal risks: lost foreign bytes, false ownership
claims/split-brain, writes outside the configured root, inconsistent operator
failure recovery, exposed mutable authoritative state, successful writes that
cannot reopen, and malformed JSON aborting service startup. The ownership
rename/verify primitive is also a defect in the accepted contract, not something
to silently change during repair. The packet 06 revision-ordering repair itself
passed review; inherited issues are not attributed to that repair.

Existing BF-1…BF-5 remain outstanding. A docs-only BF repair is no longer
sufficient to proceed. Prior acceptance records remain historical; packet 07's
progress row now points to this superseding review.

## Changed files / scoped diff

No commit made, no fixes applied, nothing pushed.

- `docs/reviews/2026-09-18-commits.md`: detailed review and repair instructions.
- `docs/reviews/2026-09-18-probes.mjs`: reproducible public-API audit harness.
- `docs/reviews/2026-09-18-path-ownership-probes.ts`: filesystem/ownership/scan
  observational repros.
- `docs/handoffs/2026-09-18-commit-review.md`: this handoff.
- `docs/STATUS.md`: only packet 07's progress row updated.

No production source, contract, fixture, dependency or existing test changed.

## Commands and results

- Dated git log, status, commit stats and scoped diffs: 11 commits inspected.
- `npm test`: exit 0; **438/438 tests**, 27 files, including existing SIGKILL tests.
- `npm run build`: exit 0; dependency and boundary checks pass (54 source
  files/220 specifiers), strict typecheck passes for three packages; no bundle
  entries implemented yet (0 built, 2 skipped).
- `node fixtures/commands/tools/generate-fixtures.mjs --check`: exit 0;
  **71 files byte-identical**.
- `node docs/reviews/2026-09-18-probes.mjs`: exit 0; assertions reproduce current
  bugs, **not** desired acceptance behavior.
- Pinned esbuild bundle + node execution of the retained path/ownership probe:
  exit 0; observed symlink escapes, false claims/takeover, two successful
  interleaved claims, skipped 101st project, create-side effects, and pruning of
  the newest snapshot. Exact commands are in the report.
- Independent commands review: 152/152 tests and 15 additional ordering/purity
  probes passed. Parent independently reran principal workspace repros.

## Acceptance assessment

- Review all today's commits, document actionable findings, avoid applying fixes:
  **passed** (UTC scope explicitly stated).
- Existing automated gates: **passed**, but insufficient coverage.
- Packet 07 ownership, containment, evidence preservation, write-failure
  consistency and robust loading: **failed** in the documented repros.
- New real simultaneous two-process claim test, power-loss durability,
  clean-install repeat and browser/visual checks: **unverified/not run**.
- All new filesystem probes used disposable roots, finally cleaned; retained
  versions run on home-directory ext4. No production projects/services touched.

## Contract-change requests and next step

Review R9's exclusive ownership mechanism; R1's unreadable/unknown-state handling;
R3's snapshot-failure pause/resolution semantics; any operator failure-state or
snapshot-ordering schema changes needed for R5/R16. Do not silently amend accepted
contracts. Complete independent safe repairs first.

**Exact next work:** bounded packet 07 repair steps and reopened Gate B review,
including outstanding BF follow-ups. **Next implementation packet remains 08 —
Runtime and three.js adapter**, blocked until repairs and required reviews are
complete; not started automatically.
