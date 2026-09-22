# Evidence — M2 docs-only promotion (2026-09-18)

Post-Gate-E promotion of the accepted M2 proposal/diff rows into
`docs/contracts/**`, plus the bounded docs follow-ups GE-1…GE-4. Docs-only: no
code, no install, no lockfile/node_modules/packages/tools change; the M1
regression toolchain is unchanged and green.

Owner pre-approval tag for this work:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.** No packet and no independent reviewer approval is claimed.

| # | Artifact | What it shows |
|---|---|---|
| 1 | `01-promotion-check.txt` | `promotion-check.mjs` output: every accepted destination section exists, sampled accepted-diff text is present, no `PROPOSED — pending Gate E` marker survives in `docs/contracts/`, the GE-2 rename is materialized, all 17 proposal/diff files carry the PROMOTED header, and decision 0002 records the pin/trust/U-4 dispositions. 11/11 groups, exit 0. |
| 2 | `02-toolchain.txt` | The post-promotion toolchain runs with actual results (all exit 0): fixture checker 33/33, inventory check 6/6, `npm test` 66 files / 841 passed, typecheck, check-deps, check-boundaries (10 packages / 150 files / 514 specifiers), build (4 built), and the non-empty `docs/contracts` diff stat. |
| 3 | `promotion-check.mjs` | The repeatable consistency-check script (docs-only; executes no proposed behavior). |

## Scope of the checks

- The destination markers are drawn from `docs/planning/m2-contracts/
  contract-diffs.md` §2 (the Gate-E-accepted inventory): `project-model.md`
  §18–§22 + §13.1/§13.2; `workspace.md` §4.5, §7.6, §13–§15; `commands.md`
  §3.1.1–§3.1.8 and §8.5–§8.12; `runtime.md` §12–§14; `sessions.md` §10.5 and
  §16–§18; `export.md` manifest layout/§5.4.1/schemaVersion 2;
  `dependencies.md` units/edges/pins.
- These checks establish structural presence and toolchain health only. They do
  **not** claim implementation success; no implementation exists for packets
  20–36.
- Known item **not** applied (recorded in `docs/handoffs/m2-promotion.md`):
  C19-D7 (adding `"behaviorTrust": { "entries": [] }` to the committed v2
  envelope fixtures) was deferred because it is a fixture-byte change and the
  instruction is to preserve fixtures/evidence. The contract text requires the
  field; the committed fixtures remain the packet-15/16 record.
