# M3 audit fixtures and integrated checker (packet 43)

**PROPOSED · not accepted.** This directory is packet 43's cross-pack audit. It
contains no contract text and no implementation: `index.json` holds the audit
expectations, `tools/check-audit.mjs` is a self-contained plain-Node checker (no
new dependency, no `eval`, no network).

Location chosen: **`fixtures/m3/audit/`** (a new root next to the four packet
fixture roots) so the packet checkers and the cross-pack audit are visibly
separate. Packet 43 also owns `docs/planning/m3-contracts/contract-diffs.md`
(the Gate K inventory) and `docs/planning/m3-contracts/traceability.md`.

## Run (from the repository root)

```bash
node fixtures/m3/audit/tools/check-audit.mjs           # exit 0 = all checks passed
node fixtures/m3/audit/tools/check-audit.mjs --report out.json
node fixtures/m3/audit/tools/check-audit.mjs --corrupt-control   # negative control
```

Environment overrides (used by the negative control and by packet-43 repairs):

- `TL43_FIXTURE_ROOT=<copy of fixtures/m3>` — fixture root (also forwarded to
  the four packet checkers as `TL39_…`/`TL40_…`/`TL41_…`/`TL42_FIXTURE_ROOT`).
- `TL43_DOCS_ROOT=<copy of docs>` — documentation root.

## What it checks

1. **Sub-checkers.** Runs `fixtures/m3/{contracts,gameplay,media,delivery}/tools/check-fixtures.mjs`
   as subprocesses and requires exit 0 from each.
2. **Inventory closure and Gate K dispositions.** Every proposed diff item in
   `docs/planning/m3-contracts/diffs/*.md` (the summary tables and `###` item
   headings) has exactly one row in `contract-diffs.md` §2, and every inventory
   row is a real proposed diff (or one of packet 43's `PM43-*` reconciliation
   rows / the two `NC-*` new-contract rows). The inventory is **110 rows**
   (105 section diffs incl. the repair row R40-17 + 3 + 2). Statuses come from
   `index.json` `inventory.repairedRows`: 97 rows stay `open`, the 13
   repaired/rejected rows must carry exactly the recorded
   `repaired (FU-…/K-…)`/`rejected (superseded by PM41-1)` text, and no
   unrecorded non-`open` status is accepted (the Gate K bounded repair,
   `docs/handoffs/gate-k-repair.md`).
3. **Destination ownership.** No two packets claim the same destination contract
   section unless the row records an explicit `supersede`/`coexist`
   reconciliation; `confirm`-only rows do not claim a section.
4. **Version agreement.** The scene/storage combination tables in `model.md`
   §23.2, `storage.md` §S2 and `diffs/workspace.md` W3 agree on every shared
   `(manifest, scene, storageVersion)` pair, the three passable rows are valid,
   and the manifest/scene/storage version claims in `model.md`, `storage.md`,
   `delivery.md` and `diffs/sessions.md` are present and consistent.
5. **Code ownership and no silent coercion.** Every new M3 error code has
   exactly one owning packet (defined in that packet's docs, never in another
   packet's code table), and every code or reason any fixture declares for a
   rejected input is registered in `index.json` (`codeOwners`, `acceptedCodes`,
   `reasonAllowlist`). A fixture that rejects without naming a code fails.
6. **One owner per entity.** Each v3 component has exactly one `setComponent`
   row in `authoring.md` §A3.2 and `diffs/commands.md` C11; each op appears once
   in `authoring.md` §A2; `gameplay.md` and `diffs/runtime.md` agree on the
   simulation phase order; the `platformer-game` module ids are declared once;
   the single `sources/sha256/` / `content/sha256/` artifact class is used.
7. **Traceability.** `authoring.md` §A8 is exactly rows 1–21 and
   `traceability.md` covers exactly those rows with a creation op; every
   B01–B24 row exists with the same owning packets as `m3-acceptance.md`; the
   three PR-1 values have a creation op and an owner; every C38/C39/C40/C41/C42
   request appears exactly once in the routing table and names a known row.
8. **Supersession.** The obsolete M1/M2 non-goal quotes the pack supersedes
   really exist in `docs/contracts/` and are recorded with their `PM43-*` row in
   `contract-diffs.md` §5.

Field-level ownership is checked for components (the only v3 field containers
with an owning registry); arbitrary field names are otherwise out of scope for a
text audit — the packet fixture checkers validate the field shapes.

## Negative control

`--corrupt-control` copies the doc and fixture trees, applies one deliberate
corruption to each, and requires this checker to exit non-zero with the expected
failure visible. Three controls:

| control | corruption | expected failing check |
|---|---|---|
| `version-table` | `storage.md` `1+3+3` changed from valid to `version_combination_unsupported` | `version` |
| `inventory-row` | a `contract-diffs.md` inventory row id renamed | `inventory` |
| `fixture-code` | `media/glb/profile-cases.json` rejection code changed to a bogus value | `unregistered code` |

A control that passes means the audit has no teeth.
