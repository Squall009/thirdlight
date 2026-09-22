# M4 contract-diffs — the complete inventory (packet 68, Gate Q)

**Status:** the review-pack inventory of every M4 proposal diff (packets
63–67). All rows are **PROPOSED — not accepted**; Gate Q reviews this pack
and the promotion is explicit, docs-only. **Authority note (the packet's
rule):** the owner's M4 execution authorization ("continue until all of M4
is implemented") is an instruction to BUILD; it does not approve any
contract row — M3's execution authorization is not read as M4 approval
(every row below keeps its PROPOSED status until the Gate Q record).

## 1. The inventory (every diff row)

Columns: **ID** — **author** — **exact destination** — **fixture(s)** —
**consumer (implement / evidence)** — **version/graph effect** — **status**.

### Packet 63 (baseline audit — capture only)

| ID | Author | Destination | Fixture | Consumer | Effect | Status |
|---|---|---|---|---|---|---|
| D-63-2…9, SD-63-1/2, CC-55-3a/b, K-3, P2-B, M3-GLB | 63 | `debt-ledger.md` (the record, not a contract diff) | `evidence-m4/63/` | §3 below | none (capture) | open — dispositioned in §3 |
| CCR-63-1 / CCR-63-2 | 63 | — (contract-change requests) | `evidence-m4/63/` | — | — | **REFILED by 64** as implementation repairs (C64-7/C64-8) — no contract change (§4.1) |

### Packet 64 (delivery — `delivery.md` + owned diffs)

| ID | Author | Exact destination | Fixture | Consumer (impl / evidence) | Effect | Status |
|---|---|---|---|---|---|---|
| C64-1 | 64 | `commands.md` §2 op table + new §3.1.12 + §5.6 | `fixtures/m4/delivery/cases/query-cases.json` | 71 / 78 | no version, no graph | PROPOSED |
| C64-2 | 64 | `commands.md` §5.6 (the accepted `queryProject` content summary — count semantics; P2-B) | `fixtures/m4/delivery/cases/query-cases.json` | 71 / 78 | no version, no graph | PROPOSED (clarification of accepted text) |
| C64-3 | 64 | `presentation.md` §41.3.6 rule 7 clarification (static model; the run proceeds) + non-player animated entities pin the neutral view ⇒ `idle` | `fixtures/m4/delivery/` (scan rows) | 69/70 / 78, 81 | no version, no graph | PROPOSED |
| C64-4 | 64 | `presentation.md` §41.9 — the `createSceneAdapter` options `models` block + `SceneAdapterDiagnostics.models` counters (additive; root subpath, no new subpath/pin) | `fixtures/m4/delivery/` | 69/70 / 78, 81 | no version, no new graph member | PROPOSED |
| C64-5 | 64 | `export.md` §5.2 — M3 entry file row correction (`export-bootstrap-m2.ts` → `export-bootstrap-m3.ts`; the exact M3 exporter file list) | `fixtures/m4/delivery/` (scan-graph rows) | 70 / 75–76, 81 | no version; the scan-table row corrected to the accepted behavior | PROPOSED (clerical correction — CCR-64-5) |
| C64-6 | 64 | `dependencies.md` §4/§5 — the M3 play-preview + M3 export bundle graphs include the `three-adapter` `./gltf-loader` subpath (the `export.md` §5.4.1 GLTFLoader row applies per bundle) | `fixtures/m4/delivery/cases/scan-graph-cases.json` | 69/70 (the GLB attachment) / 75–76 (the scan) | **bundle-graph effect** (one subpath, version-bound to the three pin) | PROPOSED |
| C64-7 | 64 | `runtime.md` — **NO change** (adjudication: §2 already mandates the v3 `game` field; D-63-9 is an implementation repair) | — | 70 (the repair) / 81 | none | PROPOSED no-change |
| C64-8 | 64 | `sessions.md` — **NO change** (adjudication: §13.4/§17.6/§10.2/§5.2 already mandate the observed repairs; D-63-4/5/6/7 are implementation repairs) | — | 70 (the repairs) / 78, 81 | none | PROPOSED no-change |

### Packet 65 (templates — `templates.md` + five owned diffs)

| ID | Author | Exact destination | Fixture | Consumer (impl / evidence) | Effect | Status |
|---|---|---|---|---|---|---|
| C65-1 | 65 | `project-model.md` §6/§7 — manifest `schemaVersion 2` + the required `template` block | `fixtures/m4/templates/cases/{recipe,identity}-cases.json` | 72 / 81 | **version effect:** the named combination (manifest 2, storage 3, scene 3); migration never re-versions (accepted rule unchanged) | PROPOSED |
| C65-2 | 65 | `project-model.md` — `manifest_storage_mismatch` (the (2, ≤2) refusal) | same | 72 / 81 | one new code | PROPOSED |
| C65-3 | 65 | `workspace.md` §8.4 — the `createProjectFromTemplate` operator (5 phases, marker, crash table) | `fixtures/m4/templates/cases/failure-cases.json` | 72 / 77 (the crash drill), 81 | 11 new operator codes; no new artifact class | PROPOSED |
| C65-4 | 65 | `workspace.md` scan/operator-table/codes/backup rows | same | 72/77 / 81 | the operator in the table; the reservation marker excluded with the migration-marker rule | PROPOSED |
| C65-5 | 65 | `workspace.md` content-store adjudication (the template blobs are ordinary `sources/sha256/` blobs) | same | 72 / 77 | no new artifact class | PROPOSED no-change adjudication |
| C65-6 | 65 | `sessions.md` §6.3 — the admin route `POST /api/v1/admin/templates/projects` + the permission rule (project-scoped tokens cannot create) | — | 73 / 81 | one new admin route | PROPOSED |
| C65-7 | 65 | `sessions.md` — the MCP tools `tl_project_create`/`tl_templates_list` + the origin kind `template` (engine pre-promotion: `admin` substitution, documented) | `fixtures/m4/templates/cases/recipe-cases.json` (the replay origin note) | 73 / 81 | two new MCP rows; one proposed origin value | PROPOSED |
| C65-8 | 65 | `dependencies.md` — **NO change** (`templates/` is engine data, not a package; no graph effect) | — | 72 / 75–76 (the kit carries the template set) | none | PROPOSED no-change |
| C65-9 | 65 | `commands.md` — **NO change** (the recipe uses only accepted ops; `queryProject` carries the v2 manifest with no shape change) | `fixtures/m4/templates/cases/recipe-cases.json` (the real-engine replay) | 72 / 81 | none | PROPOSED no-change |
| C65-10 | 65 | `runtime.md` — **NO change** (the module closure derives from declarations + referenced content; layout is never an input) | `fixtures/m4/templates/cases/module-cases.json` | 72/74 / 78, 81 | none | PROPOSED no-change |

### Packet 66 (distribution — `distribution.md` + three owned diffs)

| ID | Author | Exact destination | Fixture | Consumer (impl / evidence) | Effect | Status |
|---|---|---|---|---|---|---|
| C66-1 | 66 | `dependencies.md` — the kit = a distribution of the existing workspace; **one new tooling unit edge** (`tools/game-build.mjs`, plain `node:*`); no new package/dep/pin/lockfile change | `fixtures/m4/distribution/cases/{license-inventory,build-tool-cases}.json` | 75 (the kit + build tool) / 76, 81 | a tooling edge (Q attention); no graph effect | PROPOSED |
| C66-2 | 66 | `export.md` — **NO change** (the game's build entry is the accepted admin export route; the kit satisfies `THIRDLIGHT_ENGINE_ROOT` by shape; the scans unchanged) | `fixtures/m4/distribution/cases/build-tool-cases.json` | 75/76 / 81 | none | PROPOSED no-change |
| C66-3 | 66 | `workspace.md` — **NO change** (the game's project is a plain workspace instance under the game's data root; the 65 operator runs against the kit's `templates/` set; no new artifact class) | `fixtures/m4/distribution/cases/pin-cases.json` | 75/76 / 81 | none | PROPOSED no-change |

### Packet 67 (reliability — `reliability.md` + four owned diffs + the deployment replacement)

| ID | Author | Exact destination | Fixture | Consumer (impl / evidence) | Effect | Status |
|---|---|---|---|---|---|---|
| C67-1 | 67 | `workspace.md` — **NO change** (the backup/restore/create tools execute the accepted §15 classification offline; no new operation/route/class/code) | `fixtures/m4/reliability/cases/{backup-example,refusal-cases,transform-cases}.json` | 77 (the tools) / 81 | none | PROPOSED no-change |
| C67-2 | 67 | `sessions.md` §6.3 + §19 — `GET /api/v1/admin/health` + the admin MCP row `tl_health` + the bound rows (32 KiB / 100 / 32 — the accepted scan/ring values re-used) | `fixtures/m4/reliability/cases/health-envelope.json` | 77 (the route) / 79 (the budget consumer), 81 | one admin route + one MCP row; no graph effect | PROPOSED |
| C67-3 | 67 | `runtime.md` — **NO change** (the report aggregates the accepted §8 diagnostics; no runtime field/bound/code change) | — | 77 / 81 | none | PROPOSED no-change |
| C67-4 | 67 | `dependencies.md` — **NO change + tooling edge** (the backup/restore/budget tools are plain-Node scripts — the packet-66 pattern; CCR-67-1) | — | 75/77/79 (the tooling) | a tooling edge; no graph effect | PROPOSED |
| C67-5 | 67 | `docs/acceptance/deployment.md` §5 — **REPLACEMENT PROPOSAL** (the raw whole-tree `tar` that copies the §15-excluded classes + carries no verification is replaced by the inventory-based, verified procedure; the takeover note preserved) — `diffs/deployment.md` carries the exact old/new text | `fixtures/m4/reliability/cases/refusal-cases.json` (the executed refusals) | 77 + the owner at Q (it is an acceptance document, applied only on Q acceptance) | none (documentation of the operator procedure) | PROPOSED replacement |

**Totals:** 26 diff rows across 64–67 (8 + 10 + 3 + 5), of which 11 are no-change adjudications and 1 is a replacement proposal; 38 NEW error codes (the registry, §6); 0 new packages/dependencies/pins/lockfile changes; 1 manifest-version combination introduced (C65-1); 1 bundle-graph subpath (C64-6); 3 tooling edges (C66-1, C67-4 ×2 surfaces); 2 new routes + 3 new MCP rows (C65-6/7, C67-2).

## 2. The fixture → checker map (the audit)

| Pack | Fixtures | Checker | Green (2026-09-22) |
|---|---|---|---|
| 64 | `fixtures/m4/delivery/` (5 GLBs, 4 case files, index) | `tools/check-fixtures.mjs` | OK + corruption negative control (exit 1) |
| 65 | `fixtures/m4/templates/` (the complete template, 5 case files, index) | `tools/check-fixtures.mts` (real-engine replay) | OK + tampered-descriptor negative control (exit 1) |
| 66 | `fixtures/m4/distribution/` (the 403-row inventory, identity, license, pin, build-tool cases) | `tools/check-kit.mjs` | OK + tampered-fixture negative control (exit 1) |
| 67 | `fixtures/m4/reliability/` (backup example, refusal/transform/matrix/health/budget cases) | `tools/check-reliability.mts` (executes the refusals; S3 by independent engine replay) | OK + tampered-digest negative control (exit 1) |
| **68** | `fixtures/m4/audit/` (the error-code registry + the audit runner) | `tools/audit.mjs` — **all four checkers green + 4 deliberately corrupted edges (module edge, destination identity, kit digest, backup inventory) each exit nonzero + the registry consistent** | **OK (EXIT 0, 2026-09-22)** |

## 3. Debt-ledger dispositions (the packet-63 record, as of this pack)

| Item | Disposition at Gate Q | Owner | Checkpoint |
|---|---|---|---|
| D-63-2 (canvas not keyboard-focusable) | open delivery defect — implementation repair | 70 | 70 + 81 evidence |
| D-63-3 (merged into D-63-4) | — | — | — |
| D-63-4/5/6/7 (editor WS receive-only; the v3 ack gap; the ready body; the locator drop) | open defects — **implementation repairs against already-accepted sessions.md text** (C64-8 adjudication) | 70 (the §18 channel gap may split to a separate owner line — owner decision at Q) | 70 + 78/81 |
| D-63-8 (export HUD refreshes once) | open minor defect — implementation repair | 70 | 70 + 81 |
| D-63-9 (the v3 snapshot cannot carry `game`) | open defect — **implementation repair** (runtime.md §2 already mandates the field — C64-7 adjudication); NO contract diff | 70 | 70 + 81 |
| P2-B (`queryProject` content summary missing) | open defect — **contract semantics specified** by C64-2 (the accepted text's count semantics), implemented by 71 | 71 | 71 + 78 |
| M3-GLB (models render as empty groups) | open known M3 gap — packet 69 scope (the C64-3/4/6 rows are its contract support) | 69/70 | 69/70 + 81 |
| SD-63-1 (deployment §5 vs workspace §15) | **superseded by C67-5** (the §5 replacement proposal) | 77 + owner at Q | Q |
| SD-63-2 (STATUS row 62 stale) | closed at packet 63 | — | — |
| CC-55-3a (no behavior-linking channel) | open by decision (Gate N) — **owner scope decision at Q** (CCR-65-1: keep the built-in-only refusal vs open linking); the M4 profile stays fail-closed (`module_unresolved`) until the decision | owner | Q / 69 |
| CC-55-3b (packet-55 HUD wording diff) | open, non-blocking — owner disposition (fix wording vs close); renumbered from CC-55-3 in this ledger | owner | Q |
| K-3 (the `platformer-game` export-surface confirmation) | the actual symbol names are recorded (debt ledger §1 K-3: `platformerGameSessionSpec` + `platformerGameCameraSpec` + the constant/math exports); **owner confirmation outstanding** — the FU-7/K-3 coordinator adjudication stands as applied, not as owner-approved | owner | Q |
| `play.preview.ready` relay ownership (editor vs backend path) | unresolved fact — owner decision with the D-63-4/5 repair | owner | Q / 70 |
| §18 relay channels for v3 plays | unresolved fact — owner decision (D-63-5) | owner | Q / 70 |

## 4. Cross-pack reconciliation (64–67 collisions, explicit)

The packet's "reconcile collisions explicitly" rule — every apparent
collision found in the pack, and its resolution:

1. **CCR-63-1/2 vs the 64 framing.** The 63 contract-change requests
   (sessions.md send path; the v3 snapshot `game` field) were **re-filed by
   packet 64 as implementation repairs**: `sessions.md` §13.4/§17.6/§10.2/
   §5.2 and `runtime.md` §2 already mandate the behavior (C64-7/C64-8
   no-change adjudications). **Resolution: no contract change; the repairs
   are packet 70's scope.** The record chain is preserved (the ledger rows
   keep their sources/evidence).
2. **Settings order (64 vs 65).** The 64 `querySettings` result maps use the
   §21.4 registry-table order; the 65 fixtures pin `content.settings` in
   **canonical (alphabetical) storage order** (project-model §12.2). **Not a
   collision:** the stored map and the query-result order are distinct by
   design (the 65 README + the 64 diff row state both orders explicitly).
3. **Origin kind (65 vs the accepted engine).** The 65 origin kind
   `template` (C65-7) is PROPOSED; the accepted engine validates
   `browser|mcp|admin` — verified live at 65 (`invalid_request /
   origin/kind`). **Resolution:** the fixture replay uses the documented
   `admin` substitution (an audit tag, no semantic effect — commands.md §3
   origin discipline); the `template` value lands with the Gate Q
   promotion.
4. **`templates/` location (65 vs 66).** 65: the installed template set is
   the workspace data root's `templates/<id>/`. 66: the kit carries the
   template at the kit root's `templates/platformer-starter/`. **Not a
   collision:** the 66 build tool step 5 copies the kit set into the data
   root (verified install, `template_content_mismatch` on identity
   mismatch) — the chain is kit → data root → the 65 operator.
5. **Backup set vs kit set (66 vs 67).** Different artifacts, no overlap:
   the kit (engine distribution) excludes `node_modules`/`dist`/`.git`/
   fixtures/samples/top-level tests/symlinks; the backup (project data)
   includes the §15 set and excludes staging/derived/ownership/recovery/
   migration/temp. A kit is never a backup and a backup never a kit.
6. **Admin routes (65 vs 67).** C65-6 (`POST /api/v1/admin/templates/
   projects`) and C67-2 (`GET /api/v1/admin/health`) are additive rows in
   the same accepted §6.3 admin group — distinct methods/paths/scopes; no
   collision.
7. **Template provenance in backups (65 vs 67).** The 65 `template` block
   lives inside the manifest ⇒ the 67 backup (manifest + envelope + blobs)
   carries the provenance **with no extra class** (C10 satisfied by
   construction; the backup-manifest's `projects[].template` projection is
   informational).
8. **`engineVersion` (65 vs 66).** The 65 exact-match rule (CCR-65-2) and
   the 66 kit identity both pin `0.1.0` — consistent; the rule is proposed
   inert at the baseline.
9. **Tooling edges (66 vs 67).** The kit's `tools/game-build.mjs` (C66-1)
   and the 67 backup/restore/budget tools (C67-4) are the same pattern
   (plain `node:*`, no dependencies, shipped with the 75/79 tooling) —
   additive, no collision; the kit's `tools/` allowlist (66 §1) is the
   assembler-time rule and does NOT include the 67 tools (operator-side).
10. **Error-code names (65 vs 66 vs 67).** Three path-escape codes
    (`template_path_rejected` / `kit_path_rejected` /
    `backup_path_rejected`) and distinct content-mismatch codes are
    **deliberately distinct** (three surfaces, three checks) — the audit's
    no-double-definition rule (§6) enforces that no code is defined twice.

## 5. Pending owner decisions (the Q docket — not inferred from execution
authorization)

| # | Decision | Source | Default if unanswered (proposed) |
|---|---|---|---|
| 1 | **K-3**: confirm (or amend) the `platformer-game` export symbol list | debt ledger §1; the FU-7/K-3 adjudication stands as applied | confirm the recorded list (no code change requested) |
| 2 | **Behavior scope (CC-55-3a)**: keep the built-in-only refusal (CCR-65-1) vs open a behavior-linking channel | Gate N record; CCR-65-1 | keep the refusal for M4 (the fail-closed `module_unresolved` stands; the config diff is filed only if a delivered game carries behavior records) |
| 3 | **CC-55-3b** (wording diff): fix the wording vs close as accepted | debt ledger §1 | record as accepted (non-blocking) or fold into 70's export repair — owner's call |
| 4 | **Reference device (67-B)**: choose/confirm the named desktop (the reference-device.md §2 proposal) | 67 §5 | 67-B stays protocol-only; thresholds stay BLOCKED; 79 preflight only |
| 5 | **`play.preview.ready` relay ownership** (editor path vs backend path) + the §18 v3 channels | debt ledger §5; D-63-4/5 | the editor relays (the sessions.md §13.4/§17.6 reading) — implemented by 70 either way |
| 6 | **The `origin.kind: "template"` audit value** (C65-7/CCR) | templates.md §7.1 | promote with the pack (the `admin` substitution remains the pre-promotion behavior) |
| 7 | **The `docs/contracts/**` evidence-path exemption** (CCR-66-1) | distribution.md §7 | accept the exemption (documentation text, never resolved; digests still bind) |
| 8 | **The C64-5 clerical correction** (CCR-64-5): text correction vs bounded re-review | delivery.md §6.4 | correct the text (the scan evidence of record already binds the bytes) |

## 6. The error-code registry (the contradictory-errors check)

`fixtures/m4/audit/cases/error-code-registry.json` is the **single source of
truth** for the 38 new M4 error codes (templates 16, distribution 8,
reliability 14, delivery 0 — reuse only), with the meaning notes for the
deliberately distinct names. `fixtures/m4/audit/tools/audit.mjs` verifies:
set-equality with each proposal's closed "New error codes" section, no code
defined in two sections, and delivery's reuse-only status — **run green on
2026-09-22** (and the audit's corrupted-edge section proves each checker
exits nonzero on deliberate corruption).

## 7. Gate Q review protocol (this pack)

1. **Review:** the in-session model review of this pack (contract-diffs +
   traceability + the audit) — a review, NOT an owner/independent approval
   (the owner rows in §5 are the owner's, separate from any model review).
2. **Repairs:** any finding is repaired inside this packet (docs + fixtures
   only) and re-audited before the promotion record.
3. **Promotion:** EXPLICIT, **docs-only** — on the owner's Gate Q decision,
   the accepted contracts (`docs/contracts/*.md`) gain the promoted rows and
   the planning proposals move to accepted status; the promotion record is a
   new handoff (`docs/handoffs/gate-q.md`) listing every row's accepted /
   amended / rejected / deferred disposition. **Packet 69 does not start
   automatically** — it starts on the owner's go after the Q record.
4. **Traceability:** `traceability.md` carries the template field →
   command → UI/MCP → storage → module closure → both hosts → acceptance
   chain and the C01–C16 owner table (every C-row has implementation /
   evidence owners).