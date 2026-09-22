# M4 — Acceptance matrix and evidence rules

**DRAFT · planning only. All C-rows UNVERIFIED until executed.**
Plan: [m4-plan.md](m4-plan.md). Packets: [63–82](m4-packets.md).
Owner procedures: [final checklist](../acceptance/m4-owner-checklist.md).

## 1. Required outcomes

| ID | Acceptance criterion | Implementation / evidence owner | Owner check |
|---|---|---|---|
| C01 | Current baseline/debt ledger distinguishes real product gaps, stale records, owner decisions and unavailable hardware. M3 history is preserved. | 63, 68; final disposition 81/82 | O01 |
| C02 | Model entities visibly render and animate in both production hosts; idle/run/airborne, per-instance independence, bounded blend and checkpoint appearance. The authoring viewport attaches/reimports/disposes models and preserves the same intended material/light appearance. No physics-root animation writes. | 69/70; real-browser captures 81 | O04/O05 |
| C03 | Actual browser player motion and Start→death→checkpoint→death→goal→replay work in preview and standalone. Camera/resize, input reset, hidden/resume and stop remain coherent. | 70/81; physical evidence owner | O04 |
| C04 | One versioned platformer template creates a valid new project through UI and authorized MCP/backend, including server-only create. Complete sources reopen; retry cannot create two destinations. | 72–74, 81 | O02 |
| C05 | Two projects created from the template are independent; two decoration prefab copies are independent inside the new game. Editing either does not alter template/other copy/project. | 72/76/81 | O02/O03 |
| C06 | Panel visibility is local presentation only: hide/reset/reload does not change authoring revision, content or module closure. Required modules derive from declarations plus referenced content at every capture/build, not just creation; post-edit missing/unknown/cyclic/incompatible requirements fail clearly. Settings hydrate from actual backend values. | 65/71–74/81 | O03/O06 |
| C07 | UI/MCP edits and reads share the backend command/query path; bounded settings and project summaries, non-default settings on reopen, stale/retry/undo/resync semantics and error identities agree. | 71/73/78/81 | O03/O07 |
| C08 | Independent game builds in two unrelated directories using only its integrity-pinned engine kit and exact dependency lockfile. No original checkout path, mutable engine link, registry release assumption or gameplay fork. | 75/76, candidate refresh 79/80, 81 | O08 |
| C09 | Creation/recovery publication survives tested subprocess crash/write-fault points without a ready partial project, lost acknowledged edit, duplicate retry effect or unauthorized takeover. External replacement fails safely and preserves evidence. | 72/77/81 | O09 (safe witnessed drill) |
| C10 | Consistent released/stopped backup includes manifest, envelope, every source blob and independent build metadata/pins plus a recoverable engine kit; restore same ID into a clean root, no live ownership/cache dependence. Tamper/missing bytes/existing destination refuse without overwriting originals. | 67/77/81 | O09 |
| C11 | Completed representative game meets the preapproved numeric frame/load/resource budgets on the named hardware desktop under the frozen protocol, with raw data and repeatable calculations. Unsupported GPU/memory metrics labelled, not fabricated. | 63/67-B/79/80/81 | O10 |
| C12 | Export is a verified relative static closure at a non-root URL with correct MIME/CSP, pinned settings/media/modules, repeatable bytes under accepted normalization and no editor/backend/MCP/model-service dependency. Invalid/cancelled build preserves previous output. | 70/75/76/81 | O08 |
| C13 | Repeated load/Play/stop/reimport/cancel and soak respect lifetime bounds: no cumulative owned-object/listener/audio/mixer/physics/GPU-resource leak, late attachment or extra frame loop. Diagnostics are bounded and identify actual degradation. | 69/70/78–81 | O05/O07/O10 |
| C14 | Auth/project scope, origin/source/nonce/run identity, artifact containment, graph/content restrictions and redaction remain enforced. Unsupported source-bearing behavior is not silently omitted. Audio denial is playable; corrupt required media is not success. | 64/70/73/78/81 | O05/O07/O11 |
| C15 | Exact owner run commands recreate new game, two-origin editor/preview, MCP and static export, and rehearse recovery in disposable paths. Licenses/source provenance and large-asset backup policy included. | 76/77/82 | O01/O08/O09 |
| C16 | Full tests/typecheck/dependency/boundary/build, M1–M3 regressions, fixture negative controls and clean installs are recorded for the actual candidate. Gate findings have dispositions; owner decisions and physical checks are separate from model reviews. | all packets; 81/82 + Gate U | O01/O11 |

## 2. Integrated scenario (packet 81)

1. Identify the actual tree/kit/template digests and software versions. Run full
   checks in a clean disposable copy preserving the candidate's uncommitted files;
   do not test only the older HEAD. Re-run fixture corruption controls.
2. Create project A in the real browser, project B through real SDK stdio-MCP;
   retry the creation request and exercise denied creation with a project-only
   credential. Both use the same workspace initializer. Reopen both.
3. Remove/replace the installed template after creation: A/B still reopen and
   build unchanged; a later creation records the new template identity. In A,
   change title, geometry, copied preset, cue and non-default run speed /
   gravity using mixed UI/MCP commands. Verify stale rejection, one-action undo,
   duplicate retry and reconnect values; query B unchanged. Edit one of two
   prefab decorations; the other stays unchanged. Reimport valid reordered clips,
   then reject corrupt/missing-role replacement without changing accepted bytes.
4. Hide gameplay/media panels, close/reopen editor and reset layout. Capture
   revision/scene/content/module-closure hashes before/after. They are unchanged
   by layout; required modules remain. Exercise missing-module validation separately.
5. Execute both production hosts through Start→pre-checkpoint death→checkpoint→
   post-checkpoint death→goal→replay. Capture canvas **and** HUD separately, motion
   state and poses at known frames, console/network. Use two aspects (16:9 and
   4:3 minimum); resize cannot alter physics. Stop/restart, hide/resume and input
   reset. Verify audio decode and denial automatically; audible output remains a
   separately witnessed claim. No Node-only substitution for browser traversal.
6. During captured Play, edit/reimport the authoring project. Old Play keeps old
   content/settings; new Play gets new content. Exercise missing/corrupt content,
   denied audio, no-WebGL and shadow-off separately with honest labels.
7. Export A twice to independent trees and compare canonical manifest/build IDs
   and all files under the existing capturedAt normalization. Test failed/cancelled
   replacement preserving the previous build. Serve under `/games/m4-check/` on a
   plain static server with authoring/preview origins unreachable **to the test
   browser**. Do not stop live production or harness services to prove independence.
8. Create the customized independent game outside the engine tree using the kit.
   Regenerate/re-pin with packet 75's tooling after any 78/80 engine changes;
   preserve customized game sources and verify measured/source/kit candidate
   agreement. Clean-install/build twice in unrelated directories. Inspect import/content scans
   and runtime network trace for hidden authoring/checkout dependencies.
9. Rehearse crash/external-change/lost-ack and backup/restore tests only in
   disposable workspaces. Verify all original bytes retained on refusals, all
   authoritative sources and kit recovered, original kit/checkout unavailable,
   and fresh Play/export from restored state.
10. Run the frozen reference-device performance/lifetime protocol on the finished
    content. Link raw samples and calculations, not only an average FPS screenshot.
11. File `acceptance/m4-report.md`: per-C-row subclaims, result, artifact paths,
    candidate/device identity, review dispositions and owner-only remainder.
    82 verifies the runbook. Gate U reviews; owner then performs the checklist.

## 3. Evidence and stop rules

- Evidence under `docs/acceptance/evidence-m4/<packet>/` has an index identifying
  command, environment, artifact hashes and claim proved. Screenshots alone do
  not prove persistence/security; unit mocks alone do not prove delivered behavior.
- Row status: **PASS** only if every required subclaim is executed and passed;
  **PARTIAL** for an executed subset; **FAIL** for a demonstrated defect;
  **UNVERIFIED** for missing execution. A pure logic success must not label a
  combined browser/physical row PASS. Keep individual subclaim results visible.
- Owner instructions are not evidence until performed. Synthetic controller
  injection is not a physical gamepad; AudioContext decode is not audibility;
  SwiftShader is not the reference hardware GPU; SIGKILL is not a power-loss test.
- Q fixes the budget protocol; 67-B fixes measured numeric targets and owner
  confirmation before 79's scored runs. If representative media was unavailable
  at Q, resume 67-B on the completed, re-pinned game after 76/78, record the
  separate target-ratification review/promotion, then score. No post-hoc target
  movement. Hardware-only partial T allows 81's non-performance evidence and 82's
  owner runbook; C11 remains UNVERIFIED. Deferred 67-B/79/80 and T/U re-review must
  finish before final acceptance. A demonstrated budget FAIL does not qualify
  for the hardware-unavailable route.
- Gate U can record **software work complete; owner acceptance pending** with an
  explicit list. It cannot waive visible model/motion defects or a failed required
  budget as “manual only.” A scope reduction needs a separately recorded owner
  decision and corrected release claims; it is not a PASS.
- No owner/human/independent review is claimed unless that review actually occurred.
  Final owner acceptance is a separate dated record linked to the exact candidate.
