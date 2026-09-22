# Thirdlight M3 — owner review brief

2026-09-19 · **State: M3 execution in progress. Contracts accepted and promoted;
packets 38–45 done; packets 46–62, Gate L and Gates M–P not started; milestone
acceptance NOT reached.** No git commit was made in this session; the whole M3
delta (and the pre-existing M2 work) sits uncommitted in the working tree.

Report: [`../acceptance/m3-report.md`](../acceptance/m3-report.md). Gate records:
[`m3-plan-review.md`](m3-plan-review.md), [`gate-k.md`](gate-k.md),
[`gate-k-repair.md`](gate-k-repair.md), [`m3-promotion.md`](m3-promotion.md).

## 1. Deliverables actually produced

- **Plan review** of the four M3 planning documents: ACCEPT WITH BOUNDED
  FOLLOW-UPS, with PR-1…PR-7 applied (`m3-plan-review.md`). It also recorded your
  **M3 execution authorization separately from the verdict** and established the
  real verification path.
- **Packet 38 browser baseline**: a real Chrome-for-Testing 151 / SwiftShader
  WebGL 2 path in this container with **no installation** (a pre-existing local
  browser + library tree, plus two locally compiled no-op avahi stubs); pinned
  three/GLTFLoader/Rapier-WASM/input/audio measured; a reproducible harness under
  `tests/evaluations/m3-browser/`; raw evidence under
  `docs/acceptance/evidence-m3/38/`.
- **A P1 contract defect found by real-browser execution (C38-1)**: the accepted
  preview-origin CSP (`sessions.md` §17.4) lacked `'wasm-unsafe-eval'`, so the
  pinned `rapier2d-compat` WASM could never initialize — i.e. M2 Play could not
  have worked on a CSP-compliant preview origin. Isolation evidence: blocked
  under the accepted CSP, works with the one-token fix, works with no CSP.
  Also C38-2: the preview iframe needs `allow="gamepad"`. **Both are now repaired
  in the promoted contract.**
- **The M3 contract pack** (packets 39–42): v3 model/storage/migration, the game
  session/zone/respawn/camera contract, the presentation (lighting/shadows/preset
  materials/rigid animation roles/PCM audio) contract, and the host/control/
  delivery/dependency contract — with 110 inventoried diff rows, a
  feature→command→UI/MCP→runtime→export→acceptance traceability matrix, and five
  executable fixture checkers (contracts 39 groups, gameplay 23/127, media 13/85,
  delivery 16/153, audit 8) each with a corruption negative control.
- **Gate K** by a fresh read-only reviewer: ACCEPT WITH BOUNDED FOLLOW-UPS
  (96 accepted / 9 accepted-with-diff / 2 rejected / 2 deferred), blocking
  findings B1–B4, followed by the **bounded repair** (FU-1…FU-7) and the
  **docs-only promotion** of 109 of 110 rows into `docs/contracts/**`, including
  two new accepted homes (`gameplay.md`, `presentation.md`).
- **Implementation started**: packet 44 (`project-model` v3 validation/pure
  migration — 31/31 committed contract fixtures executed through the real
  validators) and packet 45 (`commands` v3 surface — 7/7 scenario messages, 3/3
  no-change, 11/12 failure codes replayed through the real engine).
- **Post-44 bounded contract repair** (`handoffs/repair-cc44-3-4.md`): packet 44
  exposed two genuine defects in the promoted text — the migration source fixture
  was not a loadable v2 scene (CC-44-3) and §16.5.2's reset-to-0 destination
  violated §18.9.2 rule 4's `publishedRevision ≤ revision` (CC-44-4). Both are
  repaired docs+fixtures-only; the repaired sections are **reopened** and owe a
  fresh architectural re-review before Gate L acceptance. The repair temporarily
  left `npm test` red because packet 44's test had pinned the contradictory
  behaviour; the coordinator repaired that test (the tree is green again:
  **138 files / 1768 tests**). Remaining requests CC-44-1/2/5/6 and
  CC-45-1…8 are owned by 46/47/48 with the Gate L checkpoint.

## 2. Actual review verdicts and their limits

| Review | Verdict | Who |
|---|---|---|
| M3 plan review | accept with bounded follow-ups; repairs applied | one fresh read-only reviewer subsession + coordinator verification of every cited claim |
| Gate K | accept with bounded follow-ups; repairs + promotion performed | one fresh read-only reviewer subsession |

Both are **session reviews by fresh model contexts in this same harness** — not
your review, not another person's approval, and not an independent audit. The
promoted contract headers say so explicitly. No M3 pre-approval tag exists (your
authorization covered executing the workflow; it did not approve the artifacts).

## 3. Verification you can rely on

`npm test` 138 files / 1768 tests; `typecheck`, `check-deps`, `check-boundaries`
(15 packages, 292 files, 1131 specifiers, 0 violations), `build` (4 built) all
exit 0. M1/M2 checkers unchanged and green (`fixtures/m2/contracts` 34/34, plus
input/course/runtime/behaviors/physics). All M3 checkers green with working
corruption controls. The packet-42 manifest `buildId` digest was re-derived two
extra ways (Node and Python) with identical results, and the packet-40 geometry
constant `dx_max = 0.29393876913398137` was re-derived independently.

## 4. Remaining work and what only you can do

- **Nothing is at risk in the tree**; all M1/M2 behaviour and fixtures are
  unchanged.
- **Continue execution from packet 46** (durable v3 workspace + migration-copy,
  then 47 media inspection, 48 backend/MCP parity, Gate L, then 49–62). The
  standing authorization says to continue; no new permission is needed.
- **Owner decisions/actions I could not complete:**
  1. **Confirm or overrule the K-3 adjudication** — I renamed the
     `platformer-game` export to `platformerGameSessionSpec` +
     `platformerGameCameraSpec` (three conflicting readings existed; this is
     flagged for your confirmation, `gate-k-repair.md`).
  2. **The M3 desktop walkthrough** — physical keyboard/gamepad, audible output
     and hardware-GPU rows cannot be closed here (no gamepad device, no audio
     device, no display, software rasteriser only). Procedures: `m3-acceptance.md`
     §5 and `planning/m3-contracts/baseline.md` §3.
  3. **Final manual review of the promoted M3 contracts** (05:00–05:19 mtimes;
     `handoffs/m3-promotion.md` lists every promoted section).
- **Recorded, owned follow-ups** (no unspecified debt): Gate-K FU items are
  closed; `CC-44-1…6` (owners 46/47/48) and `CC-45-1…8` (owners 46/47/48) are
  listed in `m3-report.md` §4 with the **Gate L** checkpoint. Two of them are
  genuine contract contradictions (the migration destination's
  `publishedRevision ≤ revision` rule and the v2-source migration fixture) and
  must be repaired before Gate L acceptance.
- **M2** still has its 16 UNVERIFIED browser/hardware rows and its own owner
  walkthrough; this work neither closes nor re-labels them.
