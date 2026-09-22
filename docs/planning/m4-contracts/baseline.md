# M4 baseline record (packet 63)

The reproducible M3-carry-forward baseline as measured 2026-09-22 in this
container by the packet-63 probe suite (`tests/evaluations/m4-baseline/`).
This record is the regression reference for packets 64–82 and for the
hardware route (`reference-device.md`). Capture only — no product changes.

## 1. Baseline identity

- Working tree: the uncommitted M2/M3 set (365 changed paths at the final
  run; 363 at audit start — the delta is this packet's probe suite + docs).
  HEAD `5b746ee` alone is historical; the dirty tree is the candidate.
- Toolchain: node v22.22.1, npm 9.2.0; `npm run build` exit 0 (typecheck +
  5 bundles: editor `main.js`, preview `preview.js` (M2
  `preview-bootstrap.ts`), preview `preview-m3.js` (M3 `preview-m3.ts`),
  mcp-adapter `mcp.mjs`, backend `backend.mjs`).
- Browser: real headless Chrome for Testing 151 via the
  `tests/evaluations/m3-browser/` runner (CDP).
- Unit tests: `npm test` green at audit start (179 workers isolate,
  EXIT=0) — recorded in the pre-run baseline check (2026-09-21).

## 2. Capability table (E02, final run)

| capability | value |
|---|---|
| WebGL2 | true |
| renderer | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` — **software rasteriser, never a hardware-GPU claim** |
| vendor | Google Inc. (Google) |
| maxTextureSize | 8192 |
| AudioContext | true (no output device; audibility UNVERIFIED) |
| getGamepads | true, 0 gamepads (no physical device) |
| devicePixelRatio / screen | 1 / 800×600 (headless window) |
| userAgent | HeadlessChrome/151.0.0.0 (Linux x86_64) |
| `isTrusted` support | true (CDP trusted clicks/keys) |

## 3. Row matrix (final run, `summary.json`)

**Phase A — standalone export (real browser, file-served export root):**
A01 title PASS · A02 canvas-as-shipped INFO (no tabindex — D-63-2) · A03
start PASS · A04 wrapper-HUD staleness INFO (D-63-8) · A05 scripted motion
UNVERIFIED (canvas byte-identical under SwiftShader; motion proven via
Phase B state) · A06 rAF cadence PASS · A07 wav decode PASS · A08 two
aspects PASS (16:9 vs 4:3 render differently) · A09 relative network PASS ·
A10 console clean PASS · A11 model entities INFO (3 GLB entities render as
empty groups — M3-GLB / packet 69).

**Phase B — production composition (real browser, in-page):**
B00 ready PASS · B01 sim steps idle PASS · B01b canvas renders PASS · B02
keyboard as-shipped INFO (D-63-2) · B03 Enter starts PASS (awaitingStart →
playing) · **B04 held-KeyD moves the player in real interpolated runtime
state PASS** (x 3.0 → 5.6901, Δ2.6901 over steps 518→927; closes the
packet-62 B05 gap) · B04b canvas reflects motion UNVERIFIED (identical
SwiftShader captures) · B05 diagnostics INFO (audio pre-gesture blocked by
contract; audibility UNVERIFIED).

**Phase C — real backend + real editor + real Play (loopback 18501/18502):**
C01 backend start PASS (`listening (authoring port 18501, preview port
18502)` on stderr) · C02 editor loaded PASS · C03 authoring viewport
renders PASS · C03b session-stable INFO (status bar never read
connected-without-error within 60 s — a re-establish cycle; the click
proceeded and C05 passed) · C04 Play button PASS (CDP trusted click) ·
**C05 preview iframe PASS** (src `…/play-content/<contentId>/?play=<id>&content=<id>`
104 ms after click) · **C06 preview host mounted FAIL** · **C07 preview
canvas renders FAIL** (only the flat 300×150 bootstrap canvas; no scene
render) · C08/C09/C10 UNVERIFIED (host never mounted; frame torn down by the
15 s present timeout) · C11 no external requests PASS · C12 console clean
PASS · C13 harness keepalive INFO (5 posts, 0 errors — compensates the
missing §5.2 client heartbeat, D-63-3→D-63-4).

**The C05→C07 break, precisely (evidence: `c-bridge.json`,
`c-06-failure.json`, session logs):** the editor sends a valid `tl.handshake`
(delivered, validator-OK with the real 43-char contentId / 64-hex buildId);
the v3 preview wrapper (`preview-m3.ts`) never acks it (D-63-5), so the
editor never sends the `tl.snapshot`; the v3 wrapper's `tl.ready` body would
also fail the §13.5 validator (D-63-6), the editor client can never send
`play.preview.ready` (D-63-4) so the backend stops every play at the 15 s
`preview_timeout`, and the v3 snapshot document structurally cannot carry
the `game` block the M3 host requires (D-63-9). Transport proven healthy by
control `tl.ping`/`tl.pong` round-trip; probe snapshot accepted at the
Bridge nonce gate and reaching `startM3Preview` (failed only on the probe's
fake scene digest). Full chain: `debt-ledger.md` §2.

## 4. Baseline operational facts (how to reproduce)

- **Run:** `npx tsx tests/evaluations/m4-baseline/run.mts` (default
  evidence dir `docs/acceptance/evidence-m4/63/raw`; overrides
  `TL_M463_EVIDENCE_DIR`, `TL_M463_PHASES=A,B,C`, `TL_M463_NO_BUILD=1`).
  Ends with a diagnostic active-handle report + hard exit.
- **Backend deploy contract (real `dist/backend/backend.mjs`):** env vars
  `THIRDLIGHT_DATA_ROOT`, `THIRDLIGHT_AUTHORING_ORIGIN`,
  `THIRDLIGHT_PREVIEW_ORIGIN`, `THIRDLIGHT_AUTHORING_BIND`,
  `THIRDLIGHT_PREVIEW_BIND`, `THIRDLIGHT_AUTHORING_ORIGINS`,
  `THIRDLIGHT_EDITOR_DIR`, `THIRDLIGHT_PREVIEW_DIR`, `THIRDLIGHT_ENGINE_ROOT`,
  tokens `THIRDLIGHT_TOKENS=authoring:<projectId>:<token>,admin:<token>`
  (split on the LAST colon). Ready line `listening (authoring port …)` on
  stderr. Baseline ports 18501/18502 (free-checked before spawn); tokens are
  probe-local (`m463-*`), not credentials of record.
- **Loadable v3 workspace seeding:** the committed captured envelope
  (`samples/beacon-reach/captured/project.json`) is NOT directly loadable —
  it carries `recipe` and lacks `retry`. The loadable form is the captured
  scene+content with the `retry` block
  (`{retention:128, records:[]}`) in the canonical key order
  `storageVersion,type,projectId,scene,content,retry`,
  `JSON.stringify(doc,null,2)+'\n'` (envelope.ts §4.4). Verified via public
  `openWorkspaceService({root}).query({op:'queryProject'})` and by the real
  editor (C02/C03: `conn: connected … revision 26`, scene `scene-main`,
  controller entity `group-0001`).
- **Snapshot identity:** `snapshotId = <projectId>@r<revision>` (beacon-reach:
  `beacon-reach@r26`); the `/play` response carries `playContent`
  (43-char base64url contentId, 64-hex buildId, `/play-content/<id>/` path)
  and the retained `play.started` WS event carries the 4-key runtime.md §2
  snapshot document.
- **Session log API (diagnostic):** `GET /api/v1/sessions?projectId=…` +
  `GET /api/v1/sessions/:id/log?limit=128` with the authoring token — the
  authoritative play lifecycle (registered → started → preview_timeout at
  +15 s in every baseline run).
- **Motion evidence split (software rasteriser):** canvas-identity rows
  (A05/B04b/C10) are UNVERIFIED under SwiftShader; authoritative motion is
  the runtime interpolated-transform delta (B04 PASS). `getInterpolatedState()
  .state.transforms` is an array of `{id, position:[x,y,z], rotation:[…4],
  scale:[…3]}` ordered by scene entity ids.

## 5. Evidence index (`docs/acceptance/evidence-m4/63/raw/`)

- `summary.json` — row matrix + env; `environment.json` — toolchain/identity.
- Phase A: `a-summary.json`, `a-01-title.png`, `a-02-spawn.png`,
  `a-03-moved.png`, `a-04-aspect-16-9.png`, `a-05-aspect-4-3.png`,
  `a-console-network.json`.
- Phase B: `b-summary.json` (B04 step/x samples), `b-01-idle.png`,
  `b-02-spawn.png`, `b-03-moved.png`.
- Phase C: `c-summary.json`, `c-01-authoring-viewport.png`,
  `c-02-preview-spawn.png` (flat bootstrap canvas), `c-04-playrect.json`,
  `c-04-editor.png`, `c-06-editor.png`, **`c-06-failure.json`** (bridge logs,
  preview requests/responses, session log, context events),
  **`c-bridge.json`** (editor↔preview bridge transcript, control probes,
  `/play` response capture, load timing), `c-console-network.json`.

## 6. Timing samples (container samples, NOT budget data)

- Full suite (build + A + B + C): ≈ 6–9 min wall.
- `/play` POST → iframe src: ≈ 100 ms (C05 `msAfterClick`, content already
  built; first-build runs are slower).
- Preview document load: ≈ 60 ms after src set (headless, loopback, 4.6 MB
  bundle).
- Play present timeout: +15.0 s from play start (every run; §10.2).
- Session keepalive posts: 15 s cadence (harness), 0 errors.
These are reproducibility samples of this container (67-B: “Early box-only
data is not representative calibration”).