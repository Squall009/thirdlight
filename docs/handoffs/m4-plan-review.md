# M4 plan review (2026-09-21)

**In-session model review of the M4 planning set — not independent or owner
approval.** Performed under the M4 execution authorization recorded below, in
the same session (no sub-sessions available on this host — the same constraint
recorded at packets 53/55). The reviewer re-read the five planning deliverables
against the working tree, the accepted contracts and the M3 completion record;
every cited claim was re-derived from source/evidence in this session.

## Scope reviewed

- `docs/planning/m4-plan.md`, `docs/planning/m4-packets.md` (packets 63–82),
  `docs/planning/m4-acceptance.md` (C01–C16), `docs/acceptance/m4-owner-checklist.md`
  (O01–O11), `docs/handoffs/m4-planning.md`.
- Baseline: `git status --short` (363 paths: 257 untracked + 106 modified —
  the uncommitted M2/M3 working tree is the baseline; preserved, not reset).
  HEAD `5b746ee` (M1) is historical only.
- Spot-checked public interfaces the plan depends on:
  `packages/exporter/src/export-types.ts` (`ExportContext`),
  `export-m3.ts` (`exportProjectM3`), `packages/backend/src/backend.ts`
  (admin export route wiring, `readGameBundle`), `packages/workspace/src/
  service.ts` (`openWorkspaceService`, `readCapturedV3`),
  `packages/game-host/src/host.ts:462–480` (CC-55-3 fail-closed),
  `packages/exporter/src/content-closure.ts:443–506`
  (`behaviors_unsupported`), `packages/platformer-game/src/index.ts`
  (actual K-3 surface), `docs/contracts/commands.md` §5.6/§12
  (queryProject v3 summary), `docs/acceptance/deployment.md` §5
  (backup/restore), the packet-38 browser runner
  (`tests/evaluations/m3-browser/`).

## Verified consistent (no defects)

1. **Dependencies**: 63→64→65→66→67→68→Q→69→70→71→R→72→73→74→75→76→S→77→78→
   79→80→T→81→82→U is sequential and matches every packet's gate/prerequisite
   fields. Bounded parts (67-A/67-B, 70-A/70-B, 73-A/73-B) follow the accepted
   M3 pattern (39-A/39-B).
2. **Acceptance coverage**: every C-row (C01–C16) has named implementation
   owners, evidence owners and an owner-checklist anchor (O01–O11). No C-row
   is owned only by a contract packet.
3. **Durability**: template creation is a staged, resumable, marker-phased
   workspace operator (65) with SIGKILL phases (72); backup/restore excludes
   live ownership/staging/derived state and restores same-ID (67/77);
   "no ready partial project" is a repeated, testable rule.
4. **Module boundaries**: no new package is presumed; workspace stays the only
   authoritative writer; the editor↔game-host edge stays on the preview
   wrapper (delivery.md §4.3 rule carried); kit builds invoke public
   exporter/workspace APIs (no internal imports); every new unit/export/edge
   needs an exact dependencies-contract + scanner change at Q.
5. **Hardware-deferred route**: plan §2.6, acceptance §3, gate-T row (§4) and
   packets 79/80/81/82 state one consistent branch — independent software
   work + 81's non-performance evidence + 82's owner runbook may finish under
   an explicit hardware-only partial T; C11 stays UNVERIFIED; deferred
   67-B/79/80 and T/U re-review must complete before final acceptance; a
   demonstrated budget FAIL never qualifies for the route.
6. **K-3**: the actual `@thirdlight/platformer-game` public surface (packet
   49/51: `platformerGameSessionSpec`, `platformerGameCameraSpec`,
   `stepZones`, `zoneOverlap`, `followCamera`, `PLATFORMER_GAME_MODULE_ID`,
   `PLATFORMER_GAME_CAMERA_MODULE_ID`, `RUN_LIMITS`, `CAMERA_CONSTANTS`,
   `CAMERA_SNAP_EPS`, zone/geometry types) is the delivery.md §3.4/D42-2
   surface plus the packet-51 camera rows. Packet 63 records these exact
   names for the pending owner K-3 confirmation; no rename is proposed.
7. **Baseline honesty**: the ledger's observed-limitation rows (model attach,
   rendered motion, settings hydration, prefab copies, deployment §5 vs
   workspace §15, CC-55-3, K-3, stale debt) were each verified against the
   named source; all are real and all have M4 owners. Deployment §5's
   "take the copy while it runs" advice was verified to contradict
   workspace.md §15's released/stopped + all-source-blobs + exclude-live-state
   rule — a real, documented defect that 67/77/82 must supersede.

## Findings and bounded follow-ups

None blocking. Applied or enforced as recorded:

- **PR-M4-1 (P3, docs convention — APPLIED this step, docs-only):** M4
  proposal documents under `planning/m4-contracts/` must open with a "Relation
  to the accepted contracts" section naming (a) the exact
  `docs/contracts/**` sections each owned diff row changes, (b) the new home
  file (`docs/contracts/templates.md` / `distribution.md` / `reliability.md`)
  after promotion, and (c) which M3 proposal documents of the same base name
  (e.g. `planning/m3-contracts/delivery.md`) are unrelated. Prevents
  base-name confusion between `planning/m4-contracts/delivery.md` (64) and the
  M3 delivery pack. Applied as one bullet in `m4-packets.md` common rules.
- **PR-M4-2 (P2, enforce at 65):** the "installed template" location must be
  frozen as a backend-configured path (analogous to `engineRoot`), with the
  template's descriptor digest verified by the workspace initializer at
  creation and the template bytes reaching the operator through an injected
  read — never a hardcoded monorepo path. New creations record the installed
  template's identity (version + digest); replacement/removal after creation
  must not affect existing projects (65's required test).
- **PR-M4-3 (P2, enforce at 63):** the CC-55-3 records conflict in meaning,
  not only wording: Gates N/O carry it as "the §3.1 config has no
  behavior-linking channel; the 55 composition rejects behavior-carrying
  scenes fail-closed" (matches source: `host.ts` behavior-component
  fail-closed + `content-closure.ts` `behaviors_unsupported`), while
  Gate P / `m3-report.md` carry it as "the packet-55 HUD/status wording diff".
  63 must reconcile against source, split them into **separate ledger IDs**
  (CC-55-3 kept for the behavior-linking channel; a new ID for any HUD/status
  wording item if one actually exists), and route only the behavior-linking
  row to the Gate Q scope decision. Neither record is authoritative by
  recency; source is.
- **PR-M4-4 (P3, prediction, no repair):** from the M3 baseline (box-only
  visible player, no model attachment, no physical reference desktop in this
  container), packet 63 cannot measure functioning representative media on a
  reference device at Q. The expected branch is therefore: 67-B freezes the
  measurement **protocol** at Q and **defers the numeric table**; 79 resumes
  calibration on the completed, re-pinned independent game; Gate T may issue
  the hardware-only partial verdict. Recorded so the Gate Q review does not
  treat the absent numeric table as a planning defect.
- **PR-M4-5 (P3, guidance for 66):** the kit allowlist should be the minimal
  set the independent build resolves (exporter import graph + build/scan
  tools + root manifests/lockfile + notices/identity). If a whole-monorepo
  vendor set is simpler and the bundle graph check already proves the
  editor/backend/MCP sources cannot enter the shipped bundle, that is
  acceptable — but the identity digest must cover exactly the vendored
  files, and 66 must state the rule.
- **PR-M4-6 (P3, clarification):** 67-A/67-B, 70-A/70-B and 73-A/73-B execute
  inside ONE packet handoff each (the M3 39-A/39-B pattern) with per-part
  evidence sections; the STATUS row records both parts. No separate handoff
  file per part.
- **Stale-record note for the 63 ledger (not repaired here):** the STATUS
  row 62 still reads `pending` although handoff 62 + Gate P record packet 62
  done (M3 in-container acceptance final, `acceptance/m3-report.md`). C01
  owns the reconciliation; historical labels are preserved.

## Verdict

**ACCEPT WITH BOUNDED FOLLOW-UPS PR-M4-1…PR-M4-6** (PR-M4-1 applied
docs-only this step; PR-M4-2/PR-M4-3 enforced at packets 65/63; PR-M4-4/5/6
recorded guidance). No blocking defect; packet 63 is unblocked. This verdict
is the session review record only — **not owner approval and not an
independent human review**.

## Execution authorization (recorded separately from the review)

The owner's M4 execution authorization (2026-09-21) is recorded here
**separately** from the review verdict. It authorizes: the M4 planning
review, packets 63–82, Gates Q–U, bounded contract proposals/promotions,
implementation, testing, repairs and re-reviews, executed sequentially in
ONE session without routine owner questions; ordinary test subprocesses,
disposable backend processes and the real in-container browser runner are
permitted; additional AI sessions are not. It does **not**: constitute
approval of unreviewed artifacts or evidence; approve numeric performance
targets, the reference desktop, the behavior-scope decision or K-3 (those
remain explicit owner decisions); authorize a commit/push/deploy/system
service/real user-project modification; or authorize any later milestone.
Reviews in this session are in-session model reviews and must be labelled
as such.

**Next: packet 63 (current-baseline audit and reference-device measurement
path).**