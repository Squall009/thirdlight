PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Consolidated M2 contract proposal inventory (packet 19)

**PROPOSED — pending Gate E.** This is packet 19's consolidated diff inventory
(`docs/planning/m2-packets.md` §19; "Contract drafting and promotion"). It lists
**every** M2 contract proposal from packets 15–19 exactly once, names its
destination contract section(s), its destination decision §, its Gate E status
and the packet(s) that implement it, and resolves the conflicts the drafts left
open. Later packets read **this file** instead of re-reading every proposal.
It changes no accepted contract.

Owner pre-approval for this autonomous M2 build:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.** A pre-approval, not an independent review. Nothing here is
approved: Gate E records **accept/reject per row**, and a separate docs-only
promotion step applies only the accepted rows before packet 20.

---

## 1. How to read this inventory

- **Status** is one of:
  - `proposed` — a draft the reviewer has not ruled on (all rows today);
  - `accept` / `reject` — set only by the Gate E reviewer, per row;
  - `superseded` — an earlier packet's text replaced by a later packet's (the
    replacement row is named);
  - `change-request` — a cross-document item that promotion must apply (or
    reject) as part of the owning row.
- **Destination decision §** refers to
  `docs/decisions/0002-m2-content-and-behavior.md` (draft §§1–6, none approved).
- **Implementing packet(s)** are from `docs/planning/m2-packets.md`.
- Where a proposal document has an internal section-level diff file, the diff is
  the normative text for promotion; the proposal document is the rationale.

## 2. Master inventory

### 2.1 Proposal documents (packets 15–19)

| # | Proposal | Destination contract sections | Decision § | Status | Implements |
|---|---|---|---|---|---|
| I-1 | `content-storage.md` (packet 15) | `workspace.md` §3, §4.2–§4.4, **new §4.5**, §5.1, §5.4, §5.5, **new §7.6**, §7.1–§7.2, §8.3, §9, §10, §11, §12, **new §13/§14/§15**; `project-model.md` §3, §5.1–§5.2, §6, §12.1–§12.6, §14, §17, **new §18/§19**; `commands.md` §2/§3.1/§5/§6/§7/§8/§9/§11/§12 | §2 | proposed | 20, 23, 24, 25 |
| I-2 | `assets.md` (packet 15) | `project-model.md` §5.1, §6, §12.1–§12.6, §13.1, §14, §17, **new §18/§19**; `commands.md` §2/§3.1/§5.4/§5.6/§8/§11/§12; `workspace.md` §11/§13; `dependencies.md` §3/§4/§7 | §2 | proposed | 20, 24, 25 |
| I-3 | `prefabs.md` (packet 16) | `project-model.md` §5.1, §5.2, §9, §10, §11.3, §12.2, §12.6, §13.1, §14, §17, **new §20**; `commands.md` §2, §3.1, §5.1, §5.3, §5.4, §5.6, §8.5–§8.11, §9.1, §11, §12 | §3 | proposed | 21, 22, 25 |
| I-4 | `properties.md` (packet 16) | same destinations as I-3 (declarations/settings/components) | §3 | proposed | 21, 25, 28 |
| I-5 | `input.md` (packet 17) | `runtime.md` §1, §3.1, §5, §6, §8, §9, §10, §11, **new §12/§13**; `dependencies.md` §2/§3/§4/§5/§6; `delivery.md` §7/§8 (relay reuses the frame) | §4 | proposed | 29, 30 |
| I-6 | `physics.md` (packet 17) | `project-model.md` §9, §10, §11.3, §12.2, §12.6, §13.1, §14, §17, **new §21**; `runtime.md` **new §12/§13**; `dependencies.md` §3/§4/§7 | §4 | proposed | 29, 31 |
| I-7 | `platformer.md` (packet 17) | `project-model.md` **new §21**; `runtime.md` **new §12/§13**; `dependencies.md` §6 | §4 | proposed | 29, 32 |
| I-8 | `behaviors.md` (packet 18) | `project-model.md` §10, §12.2, §12.3, §12.6, §13, §14, §17, **new §22**; `runtime.md` §1, §3.1, §5, §5.1, §7.2, §7.3, §8, §9, §10, §11, **new §14**; `commands.md` (packet-16 additions); `dependencies.md` §2–§6; `export.md` §5.1–§5.4/§6/§8/§9; `content-storage.md` §5/§6.1; `assets.md` §7 | §5 | proposed | 33, 34 |
| I-9 | `delivery.md` (packet 19) | `sessions.md` §1, §2, §3, §9, §10.1, **new §10.5**, §11.3, §11.5, §13.2, §13.5, §13.7, §15, **new §16/§17/§18**; `export.md` §2, §3, §4, §4.1, §5.2, §5.3, §5.4, §5.4.1, §6, §7, §8, §9; `dependencies.md` §2, §3, §4.1–§4.3, §5, §6, §7, §8, §9 | §6 | proposed | 25, 33, 35, 36 |

### 2.2 Section-level diff files

| # | Diff file | Destination contract | Items | Status | Implements |
|---|---|---|---|---|---|
| D-PM | `diffs/project-model.md` | `project-model.md` | packet 15 A1–A15; packet 16 P16-A1–P16-A12; packet 17 P17-A1–P17-A11; packet 18 P18-A1–P18-A9 | proposed | 20–23, 29–34 |
| D-WS | `diffs/workspace.md` | `workspace.md` | W1–W17 | proposed | 20, 23 |
| D-CMD | `diffs/commands.md` | `commands.md` | A1–A18 (+ recorded change requests 1–3) | proposed | 21, 22, 25, 33 |
| D-RT | `diffs/runtime.md` | `runtime.md` | R1–R18; packet 18 R19–R30 | proposed | 29, 30, 34 |
| D-DEP | `diffs/dependencies.md` | `dependencies.md` | D18-1–D18-10; packet 19 D19-1–D19-10 | proposed | 20–36 (registration rows) |
| D-EXP | `diffs/export.md` | `export.md` | E18-1–E18-7; packet 19 E19-1–E19-10 | proposed | 36 |
| D-SES | `diffs/sessions.md` | `sessions.md` | S19-1–S19-14 | proposed | 25, 27, 35 |

### 2.3 Interface items packets 15/16 left for packet 19 (now resolved)

| Left open by | Item | Resolution in this packet |
|---|---|---|
| packet 15 `content-storage.md` §14 | `dependencies.md` §3 rows for `workspace`/`project-model` content exports | D19-2 (`workspace`, `project-model` rows) |
| packet 16 `prefabs.md` §12 / `properties.md` §12 | `dependencies.md` §3 rows for `commands` prefab/property exports | D19-2 (`commands` additions) |
| packet 16 `diffs/commands.md` §C items 1–3 | `publishAsset` name; empty-container supersession; `dependencies.md` §3 rows | §3 (a), (c), D19-2 |
| packet 17 `diffs/runtime.md` §D R18 | `dependencies.md` §2/§3/§4/§5/§6 rows for `input`/`platformer`/`physics-rapier` | D19-1…D19-7 |
| packet 17 `diffs/project-model.md` P17-A11 | `properties.md` §9/§12/§16 settings-registry placeholder | §3 (h) — promotion pass |
| packet 18 `behaviors.md` §13 C18-1…C18-8 | cross-document change requests | §3 (g), (h), D19-*, D-SES/D-EXP/D-DEP |

## 3. Recorded conflict resolutions (must be applied at promotion)

Each resolution is one Gate E decision. None weakens a promised outcome; none
changes accepted M1 semantics.

**(a) `createAssetVersion` vs `publishAsset` — RESOLVED: `publishAsset`.**
`content-storage.md` §6.1/§13.1 labels the delegated authoritative content
mutation `createAssetVersion`; `diffs/commands.md` A2/A3/A16/§8.5 names it
`publishAsset` with identical args/ordering/semantics. The single name is
**`publishAsset`**; at promotion, `content-storage.md` §6.1 and §13.1 are
re-worded to `publishAsset` and `diffs/commands.md` §C item 1 is marked resolved.
No fixture byte changes (the packet-15 case fixtures carry no op name).

**(b) The `content` container rows — RESOLVED: packet 16 supersedes packet 15's
empty-only rule.** Packet 15 pinned `content.prefabs`/`behaviors` as empty and
`content.settings` as `{}` in v2 (`assets.md` §4.1/§10.2 step 6,
`content-storage.md` §3). Packet 16 defines their element shapes (`project-model`
P16-A8/P16-A11, `diffs/project-model.md` P16-A12). Promotion applies P16-A12's
three edits; the committed packet-15 envelope fixtures stay valid because an
empty container remains valid. `assets.md` §4.1/§10.2, `content-storage.md` §3
and `diffs/project-model.md`/`diffs/workspace.md` are updated in the same pass.

**(c) `diffs/project-model.md` section numbering — RESOLVED: P17-A5/P17-A6 are
real sections; the stray `+` prefixes are a formatting defect.** In the packet-17
block, the headings `+### P17-A5 — §12.2 rule 4 …` and `+### P17-A6 — §12.6
error-code table …` are emitted as diff-add lines, so they do not render as
headings and duplicate the packet-17 summary-table rows. They are **not**
duplicates of any other item and their destination sections are unique
(`§12.2` rule 4 after P16-A6; `§12.6` table after P16-A7). Resolution: promotion
treats both as ordinary sections (heads without the `+`), keeps the A-numbering
(`P17-A5`, `P17-A6`), and applies them in the stated order. No renumbering; no
content changes. `contract-diffs.md` (this file) §2.2 is the authoritative list.

**(c2) Stray diff-added closing fences — REPAIRED (formatting-only).** The same
class of defect as (c) also left insertion blocks unclosed: `diffs/export.md`
line 177 (E18-7) and eight lines in `diffs/project-model.md` (655, 711, 723, 733,
739, 754, 763, 774) carry a `+`-prefixed closing fence (`+``` `), so the
following text rendered inside a code block. `diffs/sessions.md`'s S19-8 block
used a 3-backtick outer fence around a nested ```` ```js ```` block. Packet 19
repaired **only the fence delimiters** (the `+` removed / the outer fence made
4 backticks); **no normative line of packets 15–18 changed**, and this repair is
part of the packet-19 deliverable so Gate E reviews rendered diffs. No other
content in those files differs.

**(d) Unit naming: `behavior-compiler`/`behaviors` vs plan §4 `behavior-build` —
RESOLVED by `diffs/dependencies.md` D19-A.** The Node-side compiler unit is
**`behavior-build`**; the browser-safe behavior host surface lives in **`runtime`**
as types (no `behaviors` package). Packet 18's `D18-1`/`D18-2`/`D18-3`/`D18-5`/
`D18-6` rows are read with this name; `COMPILER_ID` stays the stable string
`'thirdlight.behavior-compiler'`. `runtime.md`'s behavior sections and
`behaviors.md`'s rules are unchanged.

**GE-2 repair applied 2026-09-18 (docs-only, bounded follow-up).** The
reading rule above is now materialized as explicit replacement text in
[`diffs/dependencies.md`](diffs/dependencies.md) §D19-A item 4: the D18
`behavior-compiler` rows are **superseded by and replaced with** the D19
`behavior-build` rows, and every D18 `behaviors` row/bullet is folded into the
existing `runtime` rows — promotion inserts only the final unit names and never
both. No normative behavior text changes.

**(e) `engineRoot` / reference-entry (U-4; Gate C CF-2/CF-3) — RESOLVED: ACCEPT
both, exactly as implemented fail-closed.** Recorded with the owner pre-approval
tag (final manual review pending) in `delivery.md` §13 and
`decisions/0002` §6; exact diffs are `diffs/sessions.md` S19-10 (config field +
`THIRDLIGHT_ENGINE_ROOT`) and `diffs/export.md` E19-7 (reference-build entry).
If rejected at Gate E, both implementations stay fail-closed and a bounded
follow-up is recorded — no other row depends on them.

**(f) Packet 15/16 content-export interface notes — RESOLVED: D19-2.**
`dependencies.md` §3 rows for the packet-15/16 `project-model`/`workspace`/
`commands` content exports are supplied by D19-2; the command op/inverse shapes
are packet 16's A16/A15 (`diffs/commands.md`), unchanged.

**(g) C18-1/C18-2 (behavior-source preparation profile; `acknowledgeBehaviorTrust`)
— RESOLVED: applied at promotion as content-storage/assets/commands text
updates.** Recorded as `C19-D1` in §3.1 below; no fixture changes (the
packet-18 fixtures already exercise the rules).

**(h) C18-8 / P16-A12 / P17-A11 supersessions — RESOLVED: one promotion pass.**
The `behaviorTrust` envelope field, the settings-registry fill and the
empty-container edits are applied together in the owning rows' promotion pass;
the committed fixtures stay valid by construction (see §3.1).

**(i) `snapshot.json` → `manifest.json` layout change — RESOLVED: versioned.**
`diffs/export.md` E19-2 supersedes export.md §3's `snapshot.json` for M2 exports;
`meta.json.schemaVersion` becomes `2` and readers branch on it. M1 exports are
unchanged, and no M1 reader is asked to read a v2 tree.

### 3.1 Promotion-pass change requests (text updates, no fixture byte changes)

| # | Destination | Change | Owner row |
|---|---|---|---|
| C19-D1 | `content-storage.md` §5/§6.1, `assets.md` §7 | add the `kind: "behavior-source"` preparation profile, the `prepareBehaviorSource` preparation-layer operation, the prepared-output derived-cache class and the trust-aware refusal before stage resolution | I-1/I-2 + I-8 (C18-1) |
| C19-D2 | `diffs/commands.md` (packet-16 additions) | add `acknowledgeBehaviorTrust` and the `preparation_missing` reason to `publishBehavior{mode:"source"}` | I-8 (C18-2) |
| C19-D3 | `platformer.md` §2/§2.1/§3/§7 | behavior-module inventory row, `readonly intents: IntentSet` in `StepContext`, the effective-input rule | I-7 + I-8 (C18-3) |
| C19-D4 | `properties.md` §5.2/§15 | source-mode wording ("until packet 33's preparation path") | I-4 + I-8 (C18-4) |
| C19-D5 | `content-storage.md` §3, `assets.md` §4.1/§10.2 | the empty-container supersession (§3 (b)) | I-1/I-2 + I-3 (P16-A12) |
| C19-D6 | `properties.md` §9/§12/§16 | fill the settings-registry placeholder with packet 17's six keys | I-4 + I-6 (P17-A11) |
| C19-D7 | packet-15 v2 envelope fixtures (`expected.json` notes) | add `"behaviorTrust": { "entries": [] }` in the same promotion pass | I-8 (C18-8) |
| C19-D8 | `content-storage.md` §6.1/§13.1, `diffs/commands.md` §C | apply §3 (a)'s single name `publishAsset` | I-1 + I-3 |

## 4. Gate E promotion order (both accepted rows only)

1. `project-model.md` (D-PM, in A/P16/P17/P18 order) — other contracts reference
   its §18–§22.
2. `workspace.md` (D-WS), then `commands.md` (D-CMD).
3. `runtime.md` (D-RT).
4. `sessions.md` (D-SES), then `export.md` (D-EXP).
5. `dependencies.md` (D-DEP) — the registration/edge rows last, after the units
   they name exist in §2.
6. `decisions/0002-m2-content-and-behavior.md` §§2–6 statuses updated by the
   owner/reviewer; nothing is marked approved by a packet.

Every row keeps its `proposed` status until the reviewer writes `accept` or
`reject`; no promotion step invents an acceptance and no row is applied silently.

## 5. Owner decisions still required at Gate E

1. §2/§3 content storage, asset identity and migration (incl. the no-GC/quota
   cliff and the migration reset-to-zero policy).
2. §3 prefab/copy semantics and the declared-property vocabulary.
3. §4 the 2.5D physics contract **and the physics pin**
   (`@dimforge/rapier2d-compat@0.20.0`) plus the descriptor evidence
   (`delivery.md` §13, `diffs/sessions.md` header).
4. §5 the trusted-main-thread behavior boundary (no hard timeout, no sandbox).
5. §6 delivery/protocol/export integration, the new units/pins
   (`asset-pipeline`, `input`, `physics-rapier`, `platformer`, `behavior-build`;
   no new GLB pin) and the U-4 accept/reject of §3 (e).
