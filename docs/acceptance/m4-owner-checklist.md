# Final owner review — after M4

**Checklist only; not an acceptance result. Nothing below is checked off.**
Run this after the packet-82 owner pack and Gate U review. An explicitly partial
hardware-pending verdict permits this walkthrough, not final acceptance: complete
any deferred target ratification/performance runs and T/U re-review first. It consolidates the M4 checks and the
remaining M2/M3 desktop claims; it does not rewrite their historical reports.

You should receive a working candidate and copy/paste run commands, not a list of
missing features to debug. If models do not render/animate, the player does not
move, or preview does not work, return the candidate for repair. Those are not
hardware-verification tasks that can be closed by checking a box.

## Before you begin

Packet 82 must fill in a short launch sheet in `handoffs/m4-owner-review.md`:

| Required entry | Supplied by packet 82 |
|---|---|
| Candidate | actual commit if any + working-tree/engine-kit digest; template version/digest |
| Evidence | `acceptance/m4-report.md`, performance/recovery reports, Gates Q–U and outstanding decisions |
| Fresh setup | exact install/build commands, required Node/npm, independent-game directory |
| Launch | exact disposable workspace command; editor URL; different-origin preview URL; project IDs |
| MCP | working client command/config and how to supply scoped credentials privately |
| Standalone | export/build/serve commands and exact non-root URL |
| Safety | disposable backup/restore paths and script; commands must refuse live/nonempty destinations |
| Budgets | named desktop, frozen numeric thresholds, exact runner and output directory |

**Do not accept an incomplete launch sheet.** Do not paste secrets into evidence,
commit them, or run crash/restore drills against your real project. Do not stop the
PI WEB/session daemon. Export independence can be tested by blocking authoring
origins in the test browser, not by shutting down shared services.

Record: date, candidate identity, desktop/OS, CPU/RAM/GPU/driver, browser version,
WebGL renderer, resolution/refresh/DPR, two aspects (16:9 and 4:3), keyboard,
controller model/mapping, audio device, URLs and secure-context status. Use this
same candidate for every check; a later fix needs a scoped retest.

For each O-row record **PASS / FAIL / UNVERIFIED**, evidence link and a short note.
Leave anything you did not perform UNVERIFIED. Save records under a dated owner
folder outside ordinary test output; do not overwrite automated evidence.

## O01 — Review what is being delivered [C01/C15/C16]

- [ ] Read the current M4 owner brief and C01–C16 matrix. Every remaining defect,
  limitation and unavailable test has a named disposition, not just “tests green.”
- [ ] Confirm the clean-install/full-check logs cover this actual candidate,
  including the independent engine kit, not an old commit or monorepo-only build.
- [ ] Review the explicit decisions: K-3 public export naming if still pending;
  built-in-only template versus source-bearing behavior support (the reconciled
  CC-55-3 record); reference desktop and numeric budget targets; local-use kit
  licensing/provenance. Record acceptance or requested change, not implied approval.

## O02 — Create a genuinely new game [C04/C05]

- [ ] From the editor, create project A using the platformer template. Open it,
  close/reopen the browser and confirm it is complete and playable.
- [ ] Using the supplied MCP workflow, create project B. Check A/B have different
  project IDs. An unauthorized project-only credential must not create globally.
- [ ] Change A's title and a platform/hazard arrangement. B and the template remain
  unchanged. A repeated creation request does not produce an extra project or
  overwrite either one.
- [ ] Review the template replacement test: an existing project still opens/builds
  after the installed template is removed or replaced; new creation records the
  new version, without silently upgrading old projects.

Evidence: project IDs, creation/reopen screenshots and the redacted MCP result.

## O03 — Edit, undo, reconnect and reuse content [C05/C06/C07]

- [ ] Make one visual transform edit, undo and redo it. Submit an MCP edit and see
  it in the browser; a stale edit is rejected instead of overwriting newer work.
- [ ] Set non-default speed/gravity, reconnect/reopen and confirm the inspector
  shows actual saved values. New Play uses them; an already-running Play remains
  pinned to its original settings.
- [ ] Edit one of two decoration prefab copies. The second copy stays unchanged.
- [ ] Import/reimport the supplied valid animated model; stable entity/asset IDs
  remain. Reject the supplied corrupt/missing-role replacement without losing the
  working model. Undo the successful reimport and confirm the prior model returns.

Evidence: revision/IDs, before/after images and query results. Existing M2/M3
import/prefab/UI walkthroughs can use this same record where the claim matches.

## O04 — Four real playthroughs [C02/C03]

Run **Start → death before checkpoint → checkpoint → death after checkpoint →
goal → replay** for every row. No injected movement or test-only teleports.

| Host | Input | Result / recording |
|---|---|---|
| Editor's isolated Play | Physical keyboard | — |
| Editor's isolated Play | Physical controller | — |
| Standalone static export | Physical keyboard | — |
| Standalone static export | Physical controller | — |

- [ ] Title/instructions are readable; Start does not cause a phantom jump.
- [ ] Player motion is visible; hazard and fall deaths work; respawn chooses start
  then checkpoint correctly, without a streak/jump from the old location.
- [ ] Checkpoint visibly activates once; goal freezes the completed run; replay
  clears checkpoint/death state and returns to the original spawn.
- [ ] Camera frames the player/next landing at both recorded aspects; resizing
  does not change gameplay. Test hide/resume and controller disconnect/reconnect:
  no stuck direction/jump. Stop Play and return to editing without leftover input.

Evidence: four short recordings or sufficient frames + run traces, controller
mapping, separate canvas and HUD captures for preview and export.

## O05 — Models, lighting and audible sound [C02/C13/C14]

- [ ] Models are actually visible (not invisible entities/box substitutes), with
  idle/run/airborne poses and a smooth bounded transition. Independent instances
  do not animate as one shared state.
- [ ] Compare viewport, preview and export: same intended material colours,
  roughness, key-light direction and hazard/checkpoint readability.
- [ ] After a local gesture, hear start/jump/checkpoint/death/goal cues through
  your physical audio device. Mute/unmute works; stopped/hidden games do not keep
  playing abandoned sound. Use the supplied denial probe: silent play still works.
- [ ] Run documented shadow-off and no-WebGL probes. Shadow-off stays playable
  with a truthful diagnostic; no-WebGL reports failure, not an empty “running” game.

Evidence: pose/lighting frames, audible checklist or recording, probe diagnostics.
Audio decode logs alone cannot satisfy the audible check.

## O06 — Hide panels without disabling the game [C06]

- [ ] Hide gameplay/media panels, reload and play/export again. Behavior and
  authored content remain; revision/content/module-closure comparison is unchanged.
- [ ] Reset Layout restores the panels; your other browser/project is not silently
  modified. Invalid local layout preferences can be reset safely.
- [ ] Review the missing/unknown module negative-test result: a build refuses an
  unresolved required module rather than silently dropping its behavior.

Evidence: layout screenshots and before/after identity comparison.

## O07 — Diagnose a failure without guessing [C07/C13/C14]

- [ ] Use the supplied disposable corrupt-media and unavailable-preview probes.
  Editor and MCP show the same useful code and relevant revision/run identity.
- [ ] Confirm messages distinguish corruption, unavailable session, stale run and
  audio policy denial. Follow one documented safe recovery action successfully.
- [ ] Inspect the diagnostic sample: no bearer token, privileged capability, raw
  source dump or absolute server path; output remains bounded after repeat failures.

Evidence: redacted UI/MCP result pair and recovery outcome. You need not manually
re-run the entire security suite; inspect its real integration/negative-control log.

## O08 — Build and run independently [C08/C12/C15]

- [ ] Follow the independent-game README in a fresh directory outside the engine
  checkout. Install exact dependencies and build without editing engine sources.
- [ ] Verify recorded engine-kit/template/source digests and lockfiles. The build
  must not resolve a mutable `../thirdlight` checkout or require unpublished remote
  packages. Understand any registry access needed for the first dependency install.
- [ ] Serve the export with the documented plain static server under its non-root
  path. Block editor/preview/backend origins for this browser; reload and complete
  the game. Network requests stay within the static game tree—no backend, MCP,
  model service or CDN dependency.
- [ ] Inspect the two-build reproducibility/graph-scan report and failed-build test:
  the previous working export is preserved on failure. Sources/licenses and the
  large-asset backup policy are included; an export is not your only source copy.

Evidence: clean setup/build log, exact URL, network trace and successful run.

## O09 — Rehearse recovery and backup safely [C09/C10/C15]

**Disposable game only.** Use the supplied script and clean destination paths.

- [ ] Acknowledge an edit, run the documented crash/restart/takeover drill, and
  confirm the edit survived. Replaying its lost-ack request has no second effect.
- [ ] Test a valid and invalid external-file replacement. Conflicting writes pause;
  invalid bytes are retained/reported, not silently accepted or discarded.
- [ ] Release the project or stop only its disposable backend; make a complete
  source backup including superseded source blobs, engine pin/lockfiles and the
  kit bytes (or a separately retained, verified recoverable kit artifact). A digest
  alone is not a backup of an unpublished engine kit.
- [ ] Restore with the same project ID into a clean isolated root. Integrity passes;
  reopen, Play and export work without copying derived caches/live ownership files,
  with the original engine checkout/kit location unavailable.
- [ ] Supplied tampered/missing-blob backup and nonempty-destination tests refuse
  without changing the original project or previous good backup. Know where your
  real backups will live separately from the workspace and which assets Git omits.

Evidence: inventory hashes, refusal logs and restored Play/export identities.
This demonstrates the tested crash model, not an unperformed power-loss guarantee.

## O10 — Confirm performance on the reference desktop [C11/C13]

- [ ] If 67-B target ratification is deferred, first complete its representative-
  scene calibration, target review and owner confirmation; then run the scored
  tests. Confirm any engine repairs are included in the re-pinned kit/candidate.
- [ ] Use the **approved** device/settings/content and exact runner. Confirm
  baseline/target/actual columns are distinct; no target changed after a failure.
- [ ] Run the warm-up + repeated traversal and cold/warm load protocol. Inspect
  p50/p95/p99 frame timing, missed frames, fixed-step work/drops, load times,
  transfer size, draw calls and resource counts—not average FPS alone.
- [ ] Complete the 20 Play/stop cycles and 10-minute soak. No cumulative owned
  resource/listener/audio leak, extra loop or post-stop sound. Review counter
  baseline and memory measurement limitations.
- [ ] Every required metric meets its numeric threshold. Unsupported GPU timing/
  memory is labelled unavailable/estimated as contracted, not reported as zero.

Evidence: raw samples, calculation output, hardware/browser facts and budget table.
SwiftShader results do not replace this check. A missed required target is FAIL.

## O11 — Make a separate final decision [C14/C16]

- [ ] Review Gates Q–U and all FAIL/PARTIAL/UNVERIFIED rows. No silent waiver or
  historical M2/M3 approval inferred from this checklist.
- [ ] Confirm unsupported features are clearly stated (especially source-bearing
  behavior delivery if excluded), and security/dependency negative controls pass.
- [ ] File a dated decision with the exact candidate identity and O01–O10 results:
  **accept**, **request repairs**, or **defer pending evidence**. If accepting a
  narrower scope, state the exact excluded claim; do not call it a passed test.

Final decision: **not recorded**. Owner name/date: **not recorded**.
Remaining issues and retest scope: **not recorded**.

Stop here. Advanced rendering, new genre systems or a subsequent milestone require
another planning request; completing M4 does not authorize them.
