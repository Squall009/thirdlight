# M2 promotion — Gate E bounded repairs + docs-only accepted-contract promotion

2026-09-18. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.** No commit made; no
code, install, lockfile, node_modules, packages or tools change.

## Outcome

Gate E's bounded follow-ups were applied and all 16 accepted inventory rows
were promoted into `docs/contracts/**`. The seven contracts are now binding for
packets 20+; the proposal files remain under `docs/planning/m2-contracts/` as
historical record. Decision 0002 §§1–6 are marked approved under the
pre-approval tag. Physics selection stays **PROVISIONAL** (desktop/browser/
gamepad evidence **UNVERIFIED**, carried to the final owner checklist; CPU
numbers container/directional, BR-2). Nothing is claimed as independent
reviewer approval.

## Files changed (grouped)

- **Contracts (7, +5 078/−145):** `project-model.md` (+§18–§22, §13.1/§13.2),
  `workspace.md` (+§4.5, §7.6, §13–§15), `commands.md` (+§3.1.1–§3.1.8,
  §8.5–§8.12), `runtime.md` (+§12–§14), `sessions.md` (+§10.5, §16–§18),
  `export.md`, `dependencies.md` (units/edges/bundles/pins, incl. the Rapier
  pin text — no install).
- **Decisions:** `0002-m2-content-and-behavior.md` (statuses + promotion record).
- **Repairs:** packet-14 evidence moved to `docs/acceptance/evidence-m2/14/`;
  `docs/handoffs/gate-e.md` §10 repair note; GE-2 replacement text in
  `diffs/dependencies.md` D19-A and `contract-diffs.md` §3(d); GE-3 transcript
  re-recorded; GE-4 `unpackedBytes` labelled approximate.
- **Proposal headers:** the 17 proposal/diff files carry the PROMOTED line.
- **Evidence:** `docs/acceptance/evidence-m2/promotion/**` (checker, outputs,
  manifest). `docs/STATUS.md` row E + header note.

## Commands and actual results

`check-fixtures` 33/33 exit 0 · `inventory-check` 6/6 exit 0 · `npm test` 66
files/841 passed exit 0 · `typecheck` exit 0 · `check-deps` exit 0 ·
`check-boundaries` 10/150/514 exit 0 · `build` 4 built exit 0 ·
`promotion-check.mjs` 11/11 exit 0 · `git diff --stat 5b746ee -- docs/contracts`
non-empty, limited to the 7 contracts.

## Repairs

GE-1 closed. GE-2 closed (replacement, not additive). GE-3 closed as observed
(checker not modified; duplicate entry noted). GE-4 closed (approximate label).

## Limitations / recorded deviations

- **C19-D7 deferred:** v2 envelope fixtures were not edited to add
  `behaviorTrust` (fixture bytes preserved per the hard rules); contract text
  requires the field. Packet 20 must add it with updated fixtures.
- `diffs/project-model.md` §12.2/§12.6 step numbering in P18-A3 (steps 11/12)
  and the P17-A7 ordering were materialized sequentially (steps 5–7); the
  `behavior_publication_unavailable` extension landed in `commands.md` (where
  the row exists), not `project-model.md`.
- New §10.5–§10.8 were placed after §10.4 (numeric order) rather than between
  §10.3/§10.4.
- Promoted verbatim proposal text keeps file-qualified references to the
  historical proposal/diff docs; a handful of diff-internal labels were
  translated to section references.

## Exact next step

**Packet 20 (Model v2 and pure migration), Gate F — not started.** Do not
auto-start; bounded follow-ups and promotion are complete.
