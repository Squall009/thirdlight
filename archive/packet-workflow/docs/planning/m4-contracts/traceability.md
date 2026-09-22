# M4 traceability — the review pack's chains (packet 68, Gate Q)

**Status:** the traceability companion to `contract-diffs.md` (the packet's
"trace template field→command→UI/MCP→storage→module closure→both hosts→
acceptance" rule). Every hop names its contract section and its evidence
owner. All rows are PROPOSED (Gate Q).

## 1. The template chain (field → command → UI/MCP → storage → module
closure → both hosts → acceptance)

The starter template is **data + a bounded command recipe** — no template
interpreter exists outside the accepted command engine. Every hop:

| Hop | What | Contract of record | Owner (impl / evidence) |
|---|---|---|---|
| **1. Field** | the template descriptor's `starter` fields: the base scene (the `br-cam-main` camera + cameraFollow bounds), the 30-command recipe (26 accepted Beacon Reach commands + 4 additions), the 7 source blobs, the layout preset, the module requirements | `templates.md` §1–§4; `fixtures/m4/templates/templates/platformer-starter/` (descriptor digests) | 72 (the install surface) / 75–76 (the kit carries it) |
| **2. Command** | each recipe command is an accepted `commands.md` op (7 `publishAsset`, 17 `createEntity`, 1 `setGameConfig`, 1 `setSettings`, 1 `setComponent` modelAnimation, 1 `createPrefab`, 2 `instantiatePrefab`) — the closed 8-op whitelist (C65-9: **no new op**); deterministic `req-<sha256-32hex>` requestIds (the accepted `^req-[0-9a-f]{32}$` shape) | `commands.md` §3/§5 (accepted); `templates.md` §4/§7 | 72 (the replay through the accepted pipeline) / the fixture's real-engine replay (65, verified) |
| **3. UI/MCP** | creation through the UI (the editor's new-project flow) and the authorized MCP/backend path: `tl_project_create` (admin scope) / the admin route `POST /api/v1/admin/templates/projects`; project-scoped tokens CANNOT create (C65-6/7); the origin is `template` post-promotion (the documented `admin` substitution pre-promotion — the replay fixture records both) | `sessions.md` §6.3/§19 (C65-6/7 diff rows) | 73 (the route + MCP) / 74 (the UI) / 81 (the MCP parity evidence) |
| **4. Storage** | the 5-phase operator (`reserved→blobs→envelope→replayed→published`): the blobs are ordinary `sources/sha256/<digest>` files (C65-5); the manifest is **schemaVersion 2** + the `template` block (C65-1/2 — the named combination (2,3,3)); the envelope is the v3 authoring state at revision 0 → 30 (the recipe replay); the reservation marker (`.thirdlight/reservation.json`) is the migration-marker pattern (C65-4: excluded from backup with the marker rule) | `workspace.md` §8.4/§11 (C65-3/4/5); `project-model.md` §6/§7 (C65-1/2) | 72 (the operator) / 77 (the crash drill over the phases) / 81 |
| **5. Module closure** | the finite M4 module registry: the 3 platformer core modules (required by `content.game !== null`), `thirdlight.demo:box-motion` (optional), `thirdlight.behavior:<id>` (reference-only ⇒ `module_unresolved` on the built-in-only profile — the C14 explicit refusal, CC-55-3a fail-closed). Resolution at creation, every capture (Play/export snapshot build) and after edits; **the panel/layout state is never an input** (C65-10; C06) | `templates.md` §8 (C65-10 adjudication; runtime.md no-change) | 72 (the resolver) / 74 (the UI surfaces the refusal) / 78 (the post-edit re-derivation) |
| **6. Both hosts** | the created project plays in the **preview** host (the v3 preview bundle — the M3 rows of C64-6's `./gltf-loader` subpath; the D-63-4/5/6/9 repairs in 70 make the snapshot/handshake/ready path work) and in the **export** host (the static closure — C64-5's entry row; the kit's build tool step 7, 66 §6; the 67 backup carries the build metadata/pins, C10) | `export.md` §2/§4/§5 (C64-5; C66-2 no-change); `sessions.md` §13.4/§17.2/§10.2 (accepted — the C64-8 repairs) | 70 (both hosts work) / 75–76 (the independent game) / 81 (the 4 real playthroughs) |
| **7. Acceptance** | C04 (one template creates a valid project through UI + authorized MCP/backend; retry never two destinations), C05 (two projects independent; the two decoration prefab copies independent), C06 (panel visibility local-only; modules derive at every capture/build; settings hydrate from backend values), C09 (creation/recovery publication survives crashes — no ready partial), C10 (the backup incl. template provenance + the kit identity), C12 (the export closure, kit-built) | `docs/acceptance/m4-owner-checklist.md` O02/O03/O06/O08/O09 | **evidence owners: 72–74 (creation), 76 (the independent game), 77 (the crash drill + backup), 78 (parity), 79/80 (the budget on the owner device), 81 (the integrated acceptance)** |

**Chain invariants (the audit's failure modes):** no creation path is missing
(hop 3's two surfaces are both specified); no template JSON bypass (the
recipe is the ONLY content path — hop 2's whitelist + digest binding); no
hidden panel disabling a module (hop 5 — layout is never a closure input);
no kit depending on monorepo paths (66 §7 — the symlink-escape +
absolute-checkout-path rules; kit paths under the game directory only); no
live-backup assumption (67 §1.2 — the live-owner refusal; the tools run
only after release/stop); no **physical-only excuse for a product gap**
(the hardware UNVERIFIED rows — the 63 annex — name the exact missing
prerequisites; the product defects D-63-2/4/5/6/7/9 are captured and
repaired regardless of hardware); no **absent thresholds labelled PASS**
(67 §8 — every budget row is `BLOCKED — unmeasured`; a box-only number is
refused `budget_source_not_representative`); no **contradictory errors**
(the audit's registry rule, contract-diffs §6).

## 2. The C01–C16 owner table (every row has implementation/evidence owners)

From `docs/planning/m4-acceptance.md` (the acceptance matrix) — the
implementation and evidence owners per row (the "no row is ownerless" rule):

| Row | Implementation owner(s) | Evidence owner(s) | Status at this pack |
|---|---|---|---|
| C01 (baseline/debt ledger; M3 history preserved) | 63 (the record) | 63 (the evidence index); 68 (this inventory); final disposition 81/82 | **specified + recorded** (the ledger dispositions, contract-diffs §3) |
| C02 (models render/animate in both hosts) | 69/70 | 81 (the real-browser captures) | the contract support is specified (C64-3/4/6); the gap captured (M3-GLB) |
| C03 (real player motion; Start→death→checkpoint→goal→replay) | 70 | 81; the physical input evidence is the owner's (the 63 annex) | the repair rows specified (D-63-2/4/5/6/7/9 → 70) |
| C04 (one template → valid project, UI + MCP/backend; retry never two destinations) | 72–74 | 81 | specified (the 65 contract + fixtures) |
| C05 (two projects independent; two decoration copies independent) | 72/76 | 81 | specified (the 65 identity cases re-derive independence) |
| C06 (panel visibility local-only; modules derive at every capture/build; settings hydrate) | 65 (specified)/71–74 | 78/81 | specified (the 65 layout/module cases) |
| C07 (UI/MCP parity; bounded settings/summaries; retry/undo/resync semantics) | 71/73 | 78/81 | specified (the 64 query rows C64-1/2 + P2-B) |
| C08 (independent game in two unrelated dirs; kit + lockfile only) | 75/76 | 79/80 (the candidate refresh), 81 | specified (the 66 contract + fixtures) |
| C09 (crash/write-fault survival; no ready partial; no unauthorized takeover) | 72/77 | 81 (the safe witnessed drill) | specified (the 65/67 crash tables + F1–F8) |
| C10 (consistent released/stopped backup incl. provenance + pins; restore same-ID clean; tamper refuses) | 67 (specified)/77 | 81 | specified (the 67 fixtures EXECUTE the refusals) |
| C11 (budgets on the named hardware; no fabricated metrics) | 63/67-B (protocol) /79/80 | 81 (the owner-device run) | **protocol frozen; thresholds BLOCKED** (the owner device decision pending) |
| C12 (verified relative static closure; pinned modules/settings/media; no editor dependency; invalid build preserves previous output) | 70/75/76 | 81 | specified (the 64/66 rows; the 65 starter as the canonical scene) |
| C13 (lifetime bounds; bounded diagnostics identifying degradation) | 69/70 | 78–81 | specified (the 67 health report envelope; the runtime §8 aggregation) |
| C14 (auth/scope/nonce/identity enforced; unsupported behavior not silently omitted; audio denial playable; corrupt media not success) | 64/70/73 | 78/81 | specified (the C14 refusal is the `module_unresolved` fail-closed — CCR-65-1/CC-55-3a) |
| C15 (exact owner run commands recreate the game + two-origin + MCP + export + recovery; licenses/provenance; backup policy) | 76/77 | 82 (the owner brief) | the command procedure is enumerated (the 66 §11 smoke + the 67 procedures; the 82 owner brief assembles it) |
| C16 (full test/typecheck/dep/boundary/build + regressions + negative controls + clean installs; gate findings dispositioned; owner/physical separate from model reviews) | all packets | 81/82 + Gate U | the audit runner (68) is the negative-control evidence pack; the per-packet `npm test` rows are recorded per handoff |

## 3. The separate-records rule (the packet's authority boundary)

- **Model reviews ≠ owner approvals.** This pack (and every M4 handoff)
  records in-session model reviews as reviews; the owner's decisions are
  the contract-diffs §5 docket (K-3, behavior scope, CC-55-3b, the device,
  the relay ownership, the origin value, the exemption, the clerical
  correction) and they land only as the owner's Gate Q record.
- **Physical checks are separate from product verdicts.** The 63 annex
  (SwiftShader-only, no physical input/audio/display) marks those rows
  UNVERIFIED with the exact missing prerequisites — it is never an excuse
  for a product gap (the defects are captured and dispositioned regardless)
  and never a PASS for an absent threshold (the 67-B table stays BLOCKED).
- **The M3 execution authorization is not M4 approval.** Every M4 row
  remains PROPOSED until the explicit Gate Q promotion (contract-diffs §7).
