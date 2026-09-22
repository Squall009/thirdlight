# Packet 62 — Beacon Reach integrated-browser evidence (PR-6)

The real headless-browser path is **executed**, not deferred. The standalone M3
export of the captured Beacon Reach sample is built by the real exporter
pipeline over the real generated asset bytes, served from an independent
static origin, and loaded in the local headless Chrome over CDP.

## Environment

- **Browser**: `Chrome/151.0.7922.34` (HeadlessChrome),
  `/home/dadmin/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`.
- **Rasteriser**: ANGLE / SwiftShader (software) — a **real** WebGL2 context,
  but NOT a hardware-GPU claim. No display is composited.
- **Origin**: `http://127.0.0.1:<port>/games/beacon-reach/` (an independent
  static server; the authoring/backend origins are `authoring.invalid` /
  `preview.invalid` and are never reachable).
- **CDP harness**: `tests/evaluations/m3-browser/lib/browser.mjs` (repo-pinned
  `ws`; navigate / evaluate / key dispatch / canvas PNG / console + network).

## Inputs (hashes)

| Input | SHA-256 |
|---|---|
| `samples/beacon-reach/captured/project.json` | `c6125b1469c2ffa4d5461bcdf8eaef6d0a2672a4cb185512e4294951635baa66` |
| `samples/beacon-reach/recipe/commands.json` | `2a0f079a894039a2bc2e2feb76b08a25ae6b28f6243bbc4793a66f3891858a19` |
| 7 asset blobs | the `sourceDigest` values in `samples/beacon-reach/assets/provenance.json` |

The export is built with a **fixed clock** (`now() = 1_700_000_000_000`), so the
export tree is byte-deterministic (packet 60 two-tree determinism).

## Command

```
npx tsx tests/evaluations/m3-browser/beacon-reach.mts   # exit 0
```

- `startedAt` (br-summary.json): `2026-09-21T03:35:37.838Z`
- Capture IDs: `br-01-title.png`, `br-02-spawn.png`, `br-03-moved.png`,
  `br-04-aspect-16-9.png`, `br-05-aspect-21-9.png`, `br-console-network.json`,
  `br-summary.json`.

## Rows (this probe)

| Row | Status | Evidence |
|---|---|---|
| B04-title (HUD title/objective/instructions) | **PASS** | `#hud-root h1` = "Beacon Reach"; objective + instructions rendered as text (never HTML). `br-01-title.png`. |
| B04-no-movement-prestart | **PASS** | two rAF-aligned canvas snapshots at the title are identical. |
| B04-canvas-focus | **PASS** | `#game` focused (the input owner scopes keydown to the canvas). |
| B04-start (run begins) | **PASS** | scripted Enter flips the prompt to the playing prompt. |
| B05-scripted-traversal (player moves) | **UNVERIFIED** | see note below. |
| B10-resize-two-aspects (PR-6: resize is EXECUTED) | **PASS** | the canvas renders non-black at two desktop aspects (1280×720 / 16:9 and 1280×549 / ~21:9) and the view differs across the resize (`br-04-aspect-16-9.png`, `br-05-aspect-21-9.png`). The camera respects the frustum (the scene stays in view); the physics invariance to aspect is the Node half (B10). |
| B13-wav-decode (cues decode) | **PASS** | all 5 cue assets decode through a real `AudioContext` (mono, ~44.1 kHz, correct durations). Audibility itself stays UNVERIFIED. |
| B21-network-relative | **PASS** | 16 requests, **0 external origins** (the browser auto-`favicon.ico` is same-origin; the closure is `manifest.json` + 10 digest-addressed assets). No authoring/backend origin. |
| console-no-js-errors | **PASS** | no `console.error`; the only network error is the same-origin `favicon.ico` 404 (a browser artifact). |
| raf-timestamp-advances | **PASS** | the rAF timestamp advances (~616 ms over a 600 ms sleep) — the render loop runs. |

## B05 note (honest limitation)

The scripted `KeyD` keydown **reaches the canvas** (a keydown spy records
`{code: "KeyD", repeat: false, isTrusted: true}`; the input owner's handler
accepts it and latches the move), and the rAF timestamp advances (the render
loop runs). Yet the rendered canvas frames are **byte-identical** across 8
rAF-aligned samples while holding `KeyD` (`distinctHoldFrames = 1`), so the
player's motion is not reflected in the canvas, and the standalone export does
not expose the runtime state (the player position) to the page. The standalone
export's fixed-timestep simulation therefore could not be confirmed to step the
capsule in this headless, software-rasteriser environment.

The **authoritative** evidence for the controller obeying the accepted rules
(move, jump, hazard death, checkpoint, respawn, goal) is the **Node step trace**
(`tests/integration/m3-sample/step-trace.test.ts`, real Rapier physics, 3
scenarios: death→start respawn, full traversal→goal, post-checkpoint death→
checkpoint respawn). The physical-keyboard / gamepad row stays UNVERIFIED
(owner manual annex).

## Sample defect found + fixed by this probe

The first run rendered a **black canvas**: the sample's camera was authored at
`z = 0` (in the z=0 scene plane, looking away from the scene). The camera's
`position.z` is the fixed view depth (`CAMERA_Z = 12`, gameplay.md §7.1) and is
never written by the follow module. The sample's baseline camera was corrected
to `z = 12` (`samples/beacon-reach/tools/capture-project.mts`,
`tests/integration/m3-sample/sample.test.ts`), the sample re-captured (new
`sceneDigest d339acb1…`, content digest unchanged), the sample tests re-run
(7/7 green), and the probe re-run — the canvas now renders the scene (the
platform/player/lights are visible; the view is mostly the clear colour because
the 2.5-D strip occupies a small part of the 12 m view).

## Out of scope for this probe (UNVERIFIED)

- Audible output (the cues decode; no audio device is present).
- Physical keyboard / gamepad events (scripted CDP key events only).
- Hardware-GPU behaviour / real display compositing (software rasteriser).