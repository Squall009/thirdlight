# Gate P — packet 62 review (in-session, final M3 gate)

**Verdict: ACCEPTED** (the in-container acceptance evidence is complete and
honest; the physical/audible/hardware-GPU subclaims are disclosed UNVERIFIED,
each with an owner procedure). No new CCs; CC-55-3 remains open (non-blocking).

Reviewed in-session (no sub-session available — host constraint).

## Scope

Packet 62 (integrated M3 acceptance + PR-6 headless-browser evidence), the final
M3 packet. Deliverables: the M3 acceptance record (`docs/acceptance/m3-report.md`,
B01–B24 row-level verdicts + owner annex §6) and the PR-6 integrated-browser probe
(`tests/evaluations/m3-browser/beacon-reach.mts` + `docs/acceptance/evidence-m3/62/`)
against the real Beacon Reach export. Plus the one sample defect the probe found
(the camera authored at z=0) and its repair.

## A. Toolchain re-run (fresh, 2026-09-21)

- `npm test`: **179 files / 2237 tests passed**, exit 0.
- `typecheck`: 17 packages OK. `check-deps`: all exact §7 pins.
  `check-boundaries`: 17 packages / **335 files / 1319 specifiers, 0
  violations**. `build`: **5 built, 0 skipped**.
- Checkers (all green): the binding M2 `bundle-scan.test.ts` **1/1**; M3-export
  determinism+bundle-scan **5/5**; M3 sample integrity+step-trace **7/7**; M3
  contracts/gameplay/media/delivery/audit checkers `EXIT=0` (the
  `--corrupt-control` negative control passes — the checker detects corruption).

## B. Reviewer-side verification pass (independent re-derivation)

**B1. PR-6 evidence is real (re-derived from `docs/acceptance/evidence-m3/62/raw`).**
The probe (`npx tsx …/beacon-reach.mts`, exit 0, `startedAt 2026-09-21T03:35:37Z`,
`Chrome/151.0.7922.34`) builds the standalone M3 export of the captured sample by
the real `exportProjectM3` over the 7 real asset bytes (fixed clock →
deterministic tree), serves it at `http://127.0.0.1:<port>/games/beacon-reach/`,
and loads it in headless Chrome (ANGLE/SwiftShader — software rasteriser, never a
hardware-GPU claim). Independently re-verified:

- **Title/HUD**: `#hud-root h1` = "Beacon Reach"; objective+instructions rendered
  as text (never HTML). `br-01-title.png` present.
- **Canvas pixels**: all five canvas PNGs re-decoded — `blackRatio ≈ 0.94–0.95`
  (i.e. ~5–6% non-black content), so the **scene renders** (the platform/player/
  lights are visible; the view is mostly the clear colour because the 2.5-D strip
  is small in the 12 m view). Not a blank/black canvas.
- **WAV decode**: 5/5 cues decode through a real `AudioContext` (durations
  0.140–0.420 s, mono, ~44.1 kHz resample of the 48 kHz source). Audibility itself
  stays UNVERIFIED (no audio device).
- **Network**: 17 requests, **0 external origins**; the only 404s are the
  browser's same-origin `favicon.ico` (a browser artifact, not a closure
  dependency). The closure is `manifest.json` + digest-addressed assets.
- **Console**: no `console.error` (only the same-origin `favicon.ico` 404s).
- **Resize (PR-6 requires it executed, not deferred)**: the canvas renders
  non-black at two desktop aspects (1280×720 / 16:9 and 1280×549 / ~21:9) and the
  view differs across the resize (`br-04`/`br-05`).
- **Lifecycle**: the packet-38 hidden-tab probe (PASS) is the browser lifecycle
  evidence (B09); the Node half covers the full state machine.
- **B05 scripted traversal (honest UNVERIFIED)**: the scripted `KeyD` reaches the
  focused canvas (keydown spy `{code:"KeyD",repeat:false,isTrusted:true}`; the
  input owner latches the move) and the rAF timestamp advances, yet the rendered
  canvas is byte-identical across 8 rAF frames — the standalone export's
  simulation could not be confirmed to step the capsule in this headless/software
  environment, and the export exposes no player position. The **Node step trace**
  (real Rapier) is the authoritative controller evidence.

**B2. The report is honest and complete.** `m3-report.md` §3 assigns B01–B24
row-level verdicts: **22 PASS, 2 PARTIAL (B17, B22), 0 FAIL**. Every PASS is
backed by an executed Node/API or PR-6-browser subclaim (recorded). Every
UNVERIFIED subclaim (physical keyboard/gamepad, audible, hardware GPU, real
display, rendered animated GLB poses, cross-host visual checklist, preview canvas,
two-aspect visual framing, two independent prefab copies) names an owner procedure
in §6 (O-B02/04/05/06/07/08/10/11/13/14/15/17/20/22/24). No row is claimed PASS
on a subclaim that was not executed; no placeholder screenshot; no sound inferred
from an AudioContext counter.

**B3. The PR-6 in-container execution rule is satisfied.** Every browser-
executable category is executed: DOM/HUD (B04), canvas pixels (B04/B05/B10),
console/network (B21 + console), **resize** (B10, two aspects), **lifecycle**
(packet-38 hidden-tab), **WAV decode** (B13), **export loading** (the probe loads
the real export in the browser). The physical/audible/hardware-GPU subclaims (not
executable in-container) are UNVERIFIED with owner procedures.

**B4. The camera-z sample repair is correct.** The probe found a black canvas
because the sample's baseline camera was authored at `z = 0` (in the z=0 scene
plane, looking away from the scene); the camera's `position.z` is the fixed view
depth (`CAMERA_Z = 12`, gameplay.md §7.1) and is never written by the follow
module. Corrected to `z = 12` in `capture-project.mts` + `sample.test.ts`; the
sample re-captured (camera position `[0, 4, 12]` confirmed; `scene.revision = 26`,
18 entities, 7 assets; `contentDigest` unchanged `e4d4906e…`); the sample tests
re-run (7/7). This is a sample-authoring correction (no `packages/**` change),
disclosed in the handoff + report.

## C. Findings (disclosed, non-blocking)

- **F1 (B05)**: the standalone export's capsule motion could not be confirmed via
  the rendered canvas in this headless/software environment (canvas static; no
  exposed player position). The Node step trace is the authoritative controller
  evidence. UNVERIFIED (owner O-B05).
- **F2 (B14)**: the GLB courier/beacon are imported but not rendered as animated
  models (the three-adapter realizes boxes/lights/surfaces/camera — the visible
  player is a box). The animated-pose subclaim is UNVERIFIED (owner O-B14).
- **F3 (B20)**: the preview rendered canvas in a real browser is UNVERIFIED (owner
  O-B20); the preview isolation (both-origin, credential-free, session/run-
  specific) is Node-verified (packet 59). The **export** loading (the standalone
  artifact the owner runs) is fully browser-verified by this probe.
- **F4 (B17/B22)**: the sample authors the courier/beacon as direct model entities
  (it does not create two independent decoration prefab copies — B17 PARTIAL);
  the physical keyboard/gamepad playthroughs are not executed (B22 PARTIAL).
- **F5**: the physical/audible/hardware-GPU subclaims are UNVERIFIED (owner annex
  §6) — a hard container limit, not a waiver.

## D. Contract-change requests

None new. **CC-55-3** (the packet-55 HUD/status wording diff) remains open,
carried through Gates N/O/P, awaiting an explicit owner scope decision; it does
not block any gameplay/durability/security/export row. **CC-L-1** is resolved
(`repair-cc-l-1.md`).

## E. Verdict

**ACCEPTED.** Packet 62 is complete in-container: the acceptance record is honest
and complete (B01–B24: 22 PASS / 2 PARTIAL / 0 FAIL), the PR-6 in-container
execution rule is satisfied (every browser-executable category executed), the
evidence is real (re-derived), and the one sample defect the probe found is
repaired and disclosed. The remaining UNVERIFIED subclaims are the physical/
audible/hardware-GPU rows that only the owner's desktop can witness (annex §6).
This is the in-container acceptance; it is **not** owner/independent-human
approval, and it does not close the M2 rows. **M4 receives a new planning request
only when the owner asks for it.**

Reviewed in-session (no sub-session available — host constraint).