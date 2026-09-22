# Gate Q — the explicit docs-only promotion record

Date: 2026-09-22. Scope: M4 packets 63–68 (baseline, delivery, templates,
distribution, reliability, audit + Gate Q review pack). Authority: the
owner's standing M4 authorization (2026-09-22: "I specifically told you to
continue until all of M4 is implemented. Do not stop until it is
finished.") — the gates Q–U are inside that authorization. This record is
the **owner pre-approval** (same pattern as decision 0002's Gate E record
and the M3 gate records): it is an in-session model review + promotion
under the standing instruction, **not** an independent reviewer's approval
and **not** the owner's final manual review. The owner may amend or reject
any row; amendments follow the change rules.

## 1. Review (in-session model review, packet 68)

The review pack (`contract-diffs.md`, `traceability.md`, the 4-fixture
audit, the 38-code registry, the 8-item docket) was read row-by-row
against the accepted contracts and the packet-63/64/65/66/67 evidence.
Two defects were found and repaired in-packet (recorded in `68.md`): the
missing delivery section in the error-code registry, and the MCP tool
table location (the accepted seven-tool surface lives in
`docs/acceptance/deployment.md`, not `sessions.md` §14/15 — the promotion
below applies the tool rows to `deployment.md`). The audit
(`fixtures/m4/audit/tools/audit.mjs`) passed end-to-end: the four
packets' checkers green, all four deliberately corrupted edges failing
nonzero, the registry consistent.

## 2. Dispositions of the 26 diff rows

**ACCEPTED (25):** C64-1 (`querySettings` — applied to `commands.md` §2
op table, new §3.1.12, §5.6 bullet), C64-2 (`queryProject` count
semantics — `commands.md` §5.6 additive), C64-3 (rule-7 scope + non-player
neutral pinning — `presentation.md` §41.3.6), C64-4 (`models` block + two
codes — `presentation.md` §41.9 + §41.7.2 D), C64-5 (M3 entry-file
correction — `export.md` §5.2; a clerical correction with evidence of
record, `M3_EXPORTER_FILES`), C64-6 (two M3 bundle entry rows + gltf-loader
subpath record — `dependencies.md` §4.2), C65-1/2 (manifest `schemaVersion
2` + `template` block + `manifest_storage_mismatch` — `project-model.md`
§6/§7/§12.6), C65-3 (the `createProjectFromTemplate` operator, new
`workspace.md` §8.4), C65-4 (scan row, operator table row, 11 code rows,
`project_unavailable` reason), C65-5 (content-store adjudication —
recorded in §8.4), C65-6 (admin route + creation permission rule —
`sessions.md` §6.3; MCP `tl_project_create` row — `deployment.md`), C65-7
(`tl_templates_list` row — `deployment.md`; `origin.kind` `template` value
— `sessions.md` §6.1), C66-1 (kit = distribution of the existing
workspace; `tools/game-build.mjs` tooling edge — `dependencies.md` §4.2
M4 record; CCR-66-2: the kit assembler ships with packet 75), C67-2
(`GET /api/v1/admin/health` + `tl_health` + §11.5 bound — `sessions.md`
§6.3/§11.5 + `deployment.md`), C67-5 (deployment.md §5 replacement — the
inventory-based verified backup/verify/restore/create procedure).

**NO-CHANGE ADJUDICATIONS (11 — accepted as recorded, zero text change):**
C64-7 (runtime.md), C64-8 (sessions.md — the D-63-4/5/6/7 binding
citations), C65-8 (dependencies.md), C65-9 (commands.md), C65-10 (runtime.
md), C66-2 (export.md), C66-3 (workspace.md), C67-1 (workspace.md §15
inclusion list), C67-3 (runtime.md §8), C67-4 (dependencies.md — tooling
edge recorded in the §4.2 M4 record), plus CCR-65-1/CCR-65-2 (exact-match
engine rule — no version-skip rule).

**REJECTED (0). DEFERRED (0).**

**CCR-66-1 (evidence-path exemption):** accepted as a documented
non-functional exemption (the 5 contract docs containing absolute
`/home/dadmin/...` evidence paths); no code change.

## 3. The 8-item owner docket — rulings under pre-approval

Ruled with the conservative defaults recorded in `contract-diffs.md` §5;
the owner may overturn any ruling (that is an amendment, tracked):

1. **K-3 (owner checklist):** CONFIRMED as recorded (C01–C16, the C07
   >10 KB bound, the C12/C13/C14/C15/C16 notes). No code change.
2. **Behavior scope (CCR-65-1):** the M4 profile stays **built-in-only**;
   linked behaviors in the M4 starter are an EXPLICIT refusal
   (`module_unresolved`, the C14-style explicit-refusal design). A later
   owner decision may open the channel (contract amendment).
3. **CC-55-3b (audio source):** owner decision **PENDING** — the M4 audio
   scope is fixed (the accepted M3 relay), so no work is blocked; the
   decision only affects post-M4 audio content work.
4. **The reference device:** selection **PENDING with the owner** (owner
   hardware). 67-B stays protocol-only; every budget threshold stays
   BLOCKED — unmeasured, never invented; packets 79/80 proceed to the
   measurement-ready state and then report BLOCKED until the device
   exists.
5. **CC-64-1 (relay ownership):** CONFIRMED by the accepted text (the
   editor sends the WS command; the backend only marks `presented`) —
   recorded in the C64-8 adjudication.
6. **`origin.kind: "template"` value:** ACCEPTED (sessions.md §6.1).
7. **CCR-66-1:** accepted (see §2).
8. **C64-5:** accepted as a clerical correction (evidence of record in
   `64.md`/`contract-diffs.md`).

## 4. Promotion applied (docs-only; no code, no package, no dep)

| File | Sections changed |
|---|---|
| `docs/contracts/project-model.md` | §6 taxonomy (manifest `[1, 2]`), §7.1 (schemaVersion row + the v2 `template` block), §12.6 (`manifest_storage_mismatch`) |
| `docs/contracts/workspace.md` | new §8.4 (the operator), §8.4 content-store note, §10 scan row, §11 operator row + 11 code rows + `project_unavailable` reason |
| `docs/contracts/sessions.md` | §6.1 origin kinds, §6.3 route block (+ template route + health route) + creation permission rule, §11.5 health bound |
| `docs/contracts/commands.md` | §2 op table row, §3.1.12, §5.6 (queryProject counts + querySettings bullet) |
| `docs/contracts/presentation.md` | §41.3.6 rule 7, §41.7.2 D, §41.9 three-adapter row |
| `docs/contracts/export.md` | §5.2 M3 entry-file correction |
| `docs/contracts/dependencies.md` | §4.2 two bundle rows + GLTFLoader bullet (C64-6, C66-1/C67-4 records) |
| `docs/acceptance/deployment.md` | §6 MCP tool rows (3 tools added — ten total), §5 REPLACED (the verified backup/restore procedure) |
| `docs/decisions/0004-*.md` + the 5 M4 proposal docs | status → ACCEPTED at Gate Q (pre-approval) |

`runtime.md` is unchanged (C64-7/C65-10/C67-3 adjudications). The M4
error-code registry (`fixtures/m4/audit/cases/error-code-registry.json`,
38 codes) is the single source of truth for the new codes; the audit
re-verifies it.

## 5. What this is not

- Not an independent reviewer's approval and not the owner's final manual
  review (both may still amend any row).
- No code was changed; the implementation packets (69–81) implement **to
  the promoted text**, and the packets-70/71 repairs implement to the
  already-accepted text (C64-8 citations).
- The device selection and the CC-55-3b audio decision remain owner
  items; the conservative status quo applies in the meantime (nothing
  blocked by #3; #4 stays BLOCKED by design).

## 6. Gate closure and next

Gate Q is CLOSED for the M4 scope: every owned row is accepted, amended,
or adjudicated above; the promotion is applied and recorded. **Next:
packet 69** (Scene model attachment and animation resource ownership —
the C64-4 implementation + the delivery C rows), per the standing
authorization.