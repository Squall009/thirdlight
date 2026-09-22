# M3 acceptance — complete sample game

**DRAFT · 2026-09-19 · planned checks, none executed in this planning task.**
Scope: [plan](m3-plan.md), [packets](m3-packets.md), [Beacon Reach](m3-sample.md).
B-prefix IDs distinguish these rows from M2 A01–A24. K fixes exact schema/error/
limit/geometry/delay values before implementation; it cannot erase a requirement.

## 1. Required environment and evidence rules

Use the current pinned stack and real built backend/editor/MCP/export artifacts;
record their hashes and actual versions. Disposable project/export roots only.
Desktop browser with WebGL 2, keyboard, a physical standard-mapped controller and
audible output; record OS/device/browser/version, GPU/backend if reported,
resolution, origin topology, secure-context status and iframe policies. No broad
environment/credential dump. Packet 38 establishes availability, not a substitute
for the final sample playthrough.

Evidence lives in `docs/acceptance/evidence-m3/<packet>/`; final integration under
`62/`. Include an artifact index with commands, exit statuses, timestamps, input
hashes and capture IDs. Sanitize authoring credentials/locator capabilities. Tests
write evidence only under an explicitly selected output path; ordinary tests must
not mutate committed records. Distinguish Node/API, real browser, physical device
and manual/witnessed audio evidence per row.

Every final row is PASS, FAIL or UNVERIFIED, with separate subclaims if needed.
Mocks are useful for injected failures, never proof of browser/audio/SDK behavior.
The existing canvas screenshot relay proves the canvas only; title/HUD/goal need
a separate full-page screenshot or recorded browser walkthrough. Do not create a
placeholder screenshot or infer sound from an AudioContext counter.

**In-container execution rule (plan-review PR-6).** A real headless browser path
was established during the M3 plan review (Chrome for Testing 151 on
ANGLE/SwiftShader WebGL 2, plus DOM/network/console and AudioContext decode;
labelled *software rasteriser*, never hardware GPU). Rows that this path can
execute — DOM/HUD, canvas pixels, console/network, resize, lifecycle, WAV decode,
preview/export loading — must be **executed**, not deferred to a manual
procedure. Rows it cannot execute (physical keyboard/gamepad events, audible
output, hardware-GPU behaviour, real display compositing of WebGL) stay
UNVERIFIED and must each name a precise owner procedure in a §5 manual annex.
A README procedure with no executed browser evidence is UNVERIFIED, not PASS.

## 2. Acceptance matrix

| ID | Observable requirement and expected outcome | Owning packets | Required evidence |
|---|---|---|---|
| B01 | V1/v2 projects remain unchanged and usable; explicit v2→v3 copy is valid with the contracted identity/reset policy; unknown versions refuse without rewrite | 39, 44, 46, 62 | Source-tree hashes before/after success+refusal, canonical fixtures, restart/interrupted-copy probe, old-path regression |
| B02 | Every game role/config value can be created, queried, edited and removed where legal through the shared command surface; no sample-only file mutation | 39, 45, 48, 56, 61 | Feature/command coverage table, real UI creation/edit, HTTP and real stdio-MCP SDK results with revision/IDs |
| B03 | Typed validation, reference/deletion safety, one-command gesture undo, no-change, redo/retry IDs, mixed UI/MCP convergence and stale conflict | 45, 48, 56–57, 61 | Real backend+WS+SDK transcript and browser projection; rejected requests preserve envelope/revision |
| B04 | Loaded title has objective/controls/sound status; no movement until Start; keyboard and gamepad start without phantom jump | 49, 55, 59, 61–62 | Actual title image, physical input record, authoritative frame/run trace |
| B05 | Ordinary movement/jumping/grounding still obey M2; sample obstacles traversable without test-only movement | 49, 61–62 | M2 frozen traces + real Rapier sample trace + human keyboard/controller traversal |
| B06 | Hazard and falling cause exactly one death event; sweep catches fast crossing; overlap/tie precedence follows K fixtures | 40, 49–50, 61 | Independent geometry fixtures, real fixed-step event trace and visible death demonstration |
| B07 | Before checkpoint respawn at start; after checkpoint at safe checkpoint; physics/velocity/windows/input/interpolation/camera reset together | 50–51, 61–62 | Real Rapier state/counter trace, held/buffered jump negatives, blocked-spawn failure, video or before/after frames showing no interpolation streak |
| B08 | Checkpoint activates once; goal wins once and freezes play; replay clears checkpoint/deaths and starts at original spawn | 49–50, 55, 61–62 | Transition/event trace, checkpoint/goal/replay images, keyboard and gamepad full run |
| B09 | Start/win/respawn/hidden/disconnected/stopped/failed states have defined lifecycle; fail-stop never exposes an abandoned step or resumes half-reset state | 49–50, 55, 59, 62 | Failure injected at each commit/reset phase plus actual hide/resume/stop; no phantom actions/catch-up/old-run cues |
| B10 | Follow camera frames player/next landing, respects frustum bounds and snaps on reset; desktop aspect changes do not affect physics | 40, 51, 59, 61–62 | Numeric fixtures and real browser at two specified desktop aspects; snapshot/physics comparison across resize |
| B11 | Editable key/fill/shadows/material presets look consistent in viewport and both game hosts; preset copies independent; shadow-off playable | 41, 52, 57, 61–62 | UI edit/undo/reopen plus WebGL images; degraded-capability probe and ownership counters. K binds "look consistent" to a named checklist (e.g. same preset id → same colour/roughness values and the same visible key-light direction/hazard contrast in all three hosts), not a subjective judgement |
| B12 | Bounded WAV import/reimport/cue assignment works; malformed/oversized/kind-mismatched data refused before durable publication; required bytes pinned | 41, 47–48, 54, 57–60 | Byte-exact positive/negative fixtures, digests, real upload/publication/integrity and browser decode |
| B13 | Start/jump/checkpoint/death/goal sounds audible after local activation; denied/absent/muted audio allows full silent game; no stale/flooded voices | 38, 54–55, 59–62 | Witnessed audible checklist or recording, policy-denial path, mute/visibility/disposal/voice-cap probes; relay cannot fake trusted gesture. In-container: decode/lifecycle/voice-cap/denial rows executable; **audibility itself UNVERIFIED** (no audio device) |
| B14 | Rigid idle/run/airborne selection and bounded crossfade work independently per instance; clip reorder uses new version-local mapping; missing roles/skins/root-motion profile rejected | 41, 47, 53, 57, 61 | Real loader/mixer tests and rendered poses; reimport/undo restores role+byte identity; no physics-holder drift |
| B15 | HUD readable and correct; keyboard/controller can complete and replay without mouse; disconnect/resume causes no stuck controls | 55, 59, 61–62 | Full-page UI evidence and physical keyboard/controller walkthrough, device/mapping/topology details; text-escaping negative. In-container: DOM HUD screenshots + scripted key events executable; **physical device UNVERIFIED** |
| B16 | Non-default authored settings reach both production hosts and physics/controller, are hash-bound, and do not change an active pinned run | 42, 58–60, 61 | Measured numeric comparison defaults vs changed `run_speed` or gravity plus manifest identity; same captured run unchanged during edit |
| B17 | Content workflows exercised: GLB import/preview, two independent prefab copies, one-copy edit, legal reimport and rejected replacement, save/reopen and MCP edit | 45, 48, 56–57, 61 | Real browser/SDK workflow, stable asset/entity IDs, images and durable bytes; no linked prefab/material behavior |
| B18 | New content/config edits retain one-envelope durability, lost-ack replay and external-change protection; source backup includes authoritative media | 46, 48, 61–62 | Real SIGKILL/restart, durable retry bytes, rejected external change, restored disposable source backup; power-loss guarantee not invented |
| B19 | Capture/build pins scene+game/settings/media/behavior/modules at one revision; late edit/reimport and failed/cancelled build cannot mix bytes or replace successful artifacts | 58–60, 62 | Actual production closure hashes, revision race/failure injection, old/new Play comparison and cancellation cleanup |
| B20 | Preview isolation and game controls/observations stay bounded, credential-free and session/run-specific; no browser means unavailable | 42, 48, 59, 62 | Real both-origin HTTP/WS/SDK negatives for auth, origin/source/nonce, stale run, locator expiry/traversal, limits/timeouts; real rendered canvas PNG and separately captured HUD |
| B21 | Export is complete declared==emitted relative closure including audio, models and code; no authoring/server/MCP/Node/credential/capability/CDN dependency | 58, 60, 62 | Graph/content/container scans with negative controls, complete file/hash/MIME list, browser network under a non-root static URL with authoring backend stopped/unreachable |
| B22 | Editor and standalone both complete Start→death→checkpoint→death→goal→replay using the same production modules and content | 59–62 | Four physical playthroughs (two hosts × keyboard/gamepad), matching event/state traces from captured semantic replay, no sample-only test consumer. In-container: scripted-key playthroughs + production-composition traces executable; **physical keyboard/gamepad playthroughs UNVERIFIED** |
| B23 | Repeated/cold exports reproducible within accepted timestamp scope; failure preserves old output; lifecycle resources return to baseline | 54, 58–60, 62 | Two distinct output trees hashed independently, timestamp-normalized buildId derivation, cold subprocess builds; ten load/start/stop/dispose cycles with input/audio/mixer/physics/GPU-object ownership counters |
| B24 | Sample can be recreated/restored from documented sources and public workflow with clear rights, exact pins and operational instructions | 61–62 | Source recipe/license/hash inventory, clean disposable `npm ci` full checks, sample recreation/source restore, documented preview/audio/gamepad setup; no claim of unperformed deployment |

Numerical parity: use accepted runtime replay tolerances until K explicitly
changes them (same-build/same-engine exact recorded behavior; repeated sessions
≤1e-6 m, different browser engines ≤1e-3 m per sampled position). Event ordering,
checkpoint/win/death counts and identity are exact regardless of pixel differences.
Freeze sampling steps, expected values and allowed differences **before** acceptance
runs. Do not widen tolerances in response to a failing implementation. Audio/pixel
output is observed, not claimed bit-identical across hardware.

## 3. Integrated journey for packet 62

1. Record baseline tree/build/toolchain and actual hardware. Run clean install/full
   tests/checkers in a disposable copy; preserve repository lockfile and evidence.
   Record owner M2 disposition separately from new M3 results.
2. Copy/migrate a disposable M2 project to v3 through the operator path. Exercise
   refusal/interruption/restart and original-preservation checks. Keep M1/M2
   non-migration edit/export regressions working.
3. Recreate Beacon Reach through its public command/upload recipe. In the actual
   browser create/edit a hazard, checkpoint, follow-camera control and light;
   apply a material preset; import WAV and assign cue. Query through real MCP.
4. Import courier GLB, set version-local roles, preview; create two decoration
   prefab copies and edit one. Undo/redo/reopen. Submit a stale MCP edit while a
   browser edit commits: conflict, authoritative resync, no lost update.
5. Reimport valid reordered clips/mapping; verify asset/entity IDs unchanged. Try
   missing-role/corrupt audio replacements: rejection and unchanged revision/bytes.
   Undo/redo successful reimport. Prove active Play retains old content.
6. Launch isolated Play from a recorded snapshot/build. Capture the title/HUD and
   canvas; verify no movement pre-Start. Locally enable sound if necessary. On
   keyboard, die before checkpoint, activate it, die after it, reach goal, replay.
   Repeat on physical controller. Record actual audible cues or policy fallback;
   show release-before-jump, disconnect/reconnect and hidden-tab resume.
7. Exercise bounded MCP control/observation/input and screenshot against that real
   browser; assert session/snapshot/build/run identities and no-browser failure.
   Do not treat injected input as a physical-device or audio-activation test.
8. Test a non-default gameplay setting in a disposable variant. Fresh preview and
   export both show the contracted numeric effect; change authoring state mid-run
   and verify the current capture is unchanged. Restore sample defaults for the
   final authored artifact.
9. Run reset/load/corruption/failure negatives and ten lifecycle cycles. Stop during
   loading/respawn and verify resource ownership returns to baseline. Check source
   hashes/revision unchanged by play. Crash only disposable backend processes and
   verify durable edit/retry and documented ownership recovery.
10. Export the same frozen sample twice to distinct directories. Hash each tree
    before any mutation, re-derive identities, compare exact declared closure and
    the accepted timestamp-normalized differences. Test failed export against an
    already-good destination and prove old artifacts remain unchanged.
11. Serve output through an independent static server at `/games/beacon-reach/`;
    stop the **disposable** authoring backend or make it unreachable. Fresh browser
    load (cache disabled/clean profile) must not lean on prior editor resources.
    Repeat the entire keyboard and controller game journey including audio/local
    unlock, silent mode, resize and replay; capture network/console/full-page views.
12. Compare fixed semantic replays using the same production composition in preview
    and export with the captured content; compare positions and exact state/events.
    Restore the sample from source backup to another disposable project and verify
    import/integrity/export. Write row-level report, limitations, owner checklist
    and exact next review; do not start M4.

## 4. Acceptance decision and stop rules

- **K:** exact contracts/fixtures/versioning/authorability/public boundaries accepted
  and promoted; unresolved safety/ownership/feasibility decisions block dependents.
- **L/M:** real data/durability/runtime integration, not only mocked modules.
- **N/O:** actual presentation/controls and isolated/static browser behavior required;
  unavailable browser/hardware remains UNVERIFIED with the blocked scope named.
- **P:** complete B01–B24 evidence, with all required browser/physical-input/audio
  subclaims executed, no unresolved gameplay/durability/security/export failure,
  and recorded architectural review. Missing evidence is not an implicit pass or
  an inherited waiver from M2. An explicit owner scope change requires its own
  reviewed record; do not silently reduce the target to Node-only acceptance.

## 5. Owner manual verification annex (required by packets 38/62)

Rows that no in-container path can execute must name, in one annex, the exact
procedure and the exact artifact to file. Minimum annex contents: browser build
and version, OS/device, GPU/backend string, display resolution, origin topology
and secure-context status; the physical controller model and its reported
mapping; the audio output device and how audibility was witnessed; the two
desktop aspects used for B10; and, for every UNVERIFIED row, the command or URL
to reproduce it. The annex is written by packet 38 (availability) and completed by
packet 62 (results); it never claims a result that was not observed.

Report actual verdict and its scope, separate from implementation completion or
owner sign-off. Do not claim another reviewer approved this plan. On acceptance,
stop. M4 receives a new planning request only when the owner asks for it.
