# Packet 43 follow-up — M3 Gate K docs-only contract promotion (2026-09-19)

## Outcome

The Gate-K-accepted M3 contract rows are promoted into the accepted contracts.
**109 of the 110 inventory rows** in
`docs/planning/m3-contracts/contract-diffs.md` §2 were applied — the 97 rows
whose verdict stayed `open` (96 accepted + the repair-authored R40-17) and the 12
rows marked `repaired (FU-…/K-…)`. **PM13 stays rejected and was not applied**
(PM41-1 supplies the §18.1 rule-3 text). Two new accepted contract homes were
created: `docs/contracts/gameplay.md` (NC-1) and `docs/contracts/presentation.md`
(NC-2), from the promoted proposal text with the PROPOSED status lines replaced by
an accepted header.

**Honest status wording (used in the decision, the two new homes and STATUS):**
accepted by the **Gate K architectural review — a session review, not owner
approval and not an independent human review — under the owner's M3 execution
authorization; final manual review pending.** There is no M3 pre-approval tag
(unlike M2/decision 0002).

Docs-only: no production code, package, dependency, lockfile, install, commit or
service restart.

## Files and sections promoted

- `docs/contracts/project-model.md` — PM1–PM19, PM41-1…PM41-7, PM43-1/PM43-2; new
  §23 appended from `planning/m3-contracts/model.md` (cross-refs rewritten:
  `storage.md §S…`→`workspace.md §16`, `authoring.md §A…`→`commands.md`).
- `docs/contracts/workspace.md` — W1–W9; §4.5 threshold `≥3`→`≥4` and the
  "exactly two passable combinations" sentence **replaced**; new §16 appended from
  `planning/m3-contracts/storage.md` (subsection headings `S1…S11`→`16.1…16.11`,
  `§S…`→`§16.n`).
- `docs/contracts/commands.md` — C1–C14, CMD41-1…CMD41-3 (C9/CMD41-3 combined on
  the §5.4 `limits_exceeded` row; C7 split between §4 and §5.6).
- `docs/contracts/runtime.md` — R40-1…R40-17, R41-1…R41-4, R42-1…R42-4; new §15
  (subsections §15.0–§15.7) carrying the runtime-shaped interfaces verbatim from
  `gameplay.md` §3.3/§4.1/§5.2/§6/§6.1, including R40-17's `playerMotion` rule.
- `docs/contracts/sessions.md` — S42-1…S42-12; **C38-1** §17.4 CSP now
  `script-src 'self' 'wasm-unsafe-eval'` (one-token diff, consequences recorded);
  **C38-2** §13.1 requires `allow="gamepad"` on **every** play iframe; new §20.
- `docs/contracts/export.md` — E42-1…E42-9, PM43-3 (manifest v2, closure,
  §5.4.1 re-measure duty, static serving/CSP, two-tree rule).
- `docs/contracts/dependencies.md` — D42-1…D42-7 (new units `platformer-game`,
  `game-host`; editor-UI-must-not-import-`game-host`; check 12) plus the
  `gameplay.md`/`presentation.md` registration.
- `docs/contracts/gameplay.md`, `docs/contracts/presentation.md` — new homes.
- `docs/decisions/0003-m3-sample-game.md` — §1–§5 statuses flipped; promotion
  record added (applied rows, C38-1/C38-2 repairs, K-3 adjudication flagged for
  owner confirmation, rejected PM13, open owner items).
- `docs/STATUS.md` — Gate K row, M3 gate table K row, packet rows 38–43 (stale
  "7 new components"/"109 rows"/"next N, not started" strings corrected), Next =
  packet 44 ready/not started.
- `fixtures/m3/audit/tools/check-promotion.mjs` — new machine check;
  `fixtures/m3/audit/index.json` + `check-audit.mjs` and
  `fixtures/m3/delivery/tools/check-fixtures.mjs` updated for the promoted CSP
  quote and supersession state (fixture tooling only).

## Commands run and exit codes

- `node fixtures/m3/audit/tools/check-promotion.mjs` → **0** (5 groups, 110
  markers). `--corrupt-control` → **0**: remove-marker, remove-registration,
  drop-csp-token and restore-pm13 each produce a non-zero child exit (all four
  detected).
- `fixtures/m3/{contracts,gameplay,media,delivery}/tools/check-fixtures.mjs` → 0,
  0, 0, 0. `check-audit.mjs` → 0; its `--corrupt-control` → 0.
- `fixtures/m2/contracts/tools/check-fixtures.mjs` → 0 (**34/34**);
  `fixtures/m2/{behaviors,course,input,physics,runtime}/tools/check*.mjs` → 0.
- `npm test` → 0 (135 files / 1701 tests); `npm run typecheck` → 0;
  `npm run check-deps` → 0; `npm run check-boundaries` → 0 (15 packages, 1068
  specifiers, 0 violations); `npm run build` → 0 (4 built).
- `git status --short docs/contracts` lists only the seven edited contracts
  (`M`) plus the two new homes (`??`). `sha256sum docs/contracts/*.md` recorded
  before and after; `git diff --stat docs/contracts` after = 7 files,
  **+7506/−178** (vs +5657/−161 before the promotion, so the promotion itself is
  **+1849/−17** across the seven files plus the two new home files).
  - before (7): commands `0487a88c…`, dependencies `8d215089…`, export
    `75f3e3b5…`, project-model `b24c0601…`, runtime `1bb31030…`, sessions
    `67ac486c…`, workspace `8403b27a…`.
  - after (7 + 2 new): commands `dfa14fc5…`, dependencies `847ebded…`, export
    `4b7843df…`, project-model `0a5a0cf1…`, runtime `4d5136d4…`, sessions
    `f3d3eaff…`, workspace `d516dcdd…`, gameplay `46ea510c…`, presentation
    `40bd50b2…`.

## No accepted guarantee weakened

Every replaced sentence comes from the pack's exact OLD/NEW text: workspace §4.5
("exactly two passable combinations" → three; `≥3`→`≥4`; new `| 1 | 3 | 3 |`
row), project-model §6/§8.1 version rows and the `limits_exceeded` row, commands
§2/§3.1.1/§3.1.6/§5.4/§8.10/§9.1, runtime §3.1 (C35-5 deferral blockquote),
§12.1/§12.4/§13, sessions §13.5/§17.1.1/§17.4, export §5.2/§5.5/§6, and the
PM43-* obsolete M1/M2 non-goal sentences. Superseded text was replaced, not
extended additively (the M2/GE-2 lesson). The only mid-line diff fragments
(PM2's row, commands C2, runtime R40-13c, export E42-4 forbidden list) were
applied as inline edits preserving the surrounding accepted prose.

## Remaining open items

1. **K-3 owner confirmation** — the coordinator-adjudicated rename to
   `platformerGameSessionSpec`/`platformerGameCameraSpec` (gameplay.md §11,
   `delivery.md` §3.4, D42-2, the delivery fixture) is **not** an owner
   acceptance; if reversed, those four move together.
2. **Owner final manual review** of the promoted contracts and decision 0003.
3. **All browser/hardware UNVERIFIED rows stand** — physical gamepad, audible
   output, hardware GPU/desktop walkthrough; promotion verifies nothing in a
   browser. `--corrupt-control` and the checkers are docs/fixture-level only.

## Limitation observed (pre-existing, not part of this step)

While checking markdown fence balance, `docs/contracts/project-model.md` was
found to have an **unbalanced fence that pre-dates this step**: the `storageVersion
2` envelope example opening near the start of §18 is truncated (no closing fence line, and its tail `behaviors`/`settings`/`retry`/closing brace are absent),
so the file's pre-§23 fence count is odd. This promotion removed **zero** fence
lines (the diff contains no removed fence line), and the region is outside every M3 row, so it
is a pre-existing accepted-M2 content defect; it was **left untouched** (fixing
it would be an unrequested accepted-contract edit). Flagged for the owner and
for the packet that next reopens `project-model.md`. No checker depends on it.

## Next step

**Packet 44 (M3 v3 model and pure migration) — ready, do not start it.**
