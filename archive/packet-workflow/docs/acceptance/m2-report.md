# Thirdlight — M2 acceptance report

Version 1.1 · Packet 37 · 2026-09-19 (v1.1 = Gate J bounded close-out
applied 2026-09-19: P2-1 UNVERIFIED-row completeness/consistency, P2-2
non-vacuous A22 tree diff, P3-1 A20 clean-stop assertion, P3-2 A19 probe
naming, P3-3 citation corrections — docs/evidence only, no product, contract
or decision change; the Gate J verdict is unchanged).
Owner pre-approval tag: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** This report is the packet-37
integrated acceptance evidence; it is **not** an independent review and not a
Gate J verdict. Gate J (`docs/handoffs/gate-j.md`) reviewed it and returned
**accept with bounded follow-ups (no P1)**; this v1.1 applies those bounded
docs/evidence follow-ups without changing the verdict.

Normative plan: `docs/planning/m2-acceptance.md` (A01–A24, §1 evidence rules,
§3 integrated journey, §4 acceptance rule). Evidence index and replay
instructions: `docs/acceptance/evidence-m2/37/manifest.md`.

Environment (actual): Node v22.22.1 · npm 9.2.0 · Linux x86_64 (Proxmox LXC,
same `/proc` namespace) · three 0.186.0 · esbuild 0.28.2 · typescript 5.9.3 ·
vitest 5.0.1 · ws 8.21.3 · @dimforge/rapier2d-compat 0.20.0 ·
@modelcontextprotocol/sdk 1.30.0 · react/react-dom 19.3.0.

**Browser, GPU, keyboard and gamepad hardware: NOT AVAILABLE in this
container** (no browser; the container lacks `libnspr4`/`libnss3` and root).
Every executable row was executed at process/filesystem/HTTP/WS/SDK level
against the real deployed artifacts. Rows that require a real browser/hardware
are marked **UNVERIFIED** and rolled into the owner checklist (§8). **No
screenshot, browser log, gamepad report or performance figure is fabricated;
`find docs/acceptance/evidence-m2 -iname '*.png'` is empty
(`evidence-m2/37/judgement/no-png.txt`).**

## 1. What was executed

1. **Deployed artifacts.** The integrated journey launched the built
   deployment bundles and spoke only to them:
   - `dist/backend/backend.mjs` (SHA-256 `b3cf2f5a17bb684f33b250ff9ac8ae40b66d1c5e3747d1dcfd1dfa0f0cfc808c`),
   - `dist/mcp-adapter/mcp.mjs` (SHA-256 `53f305504ad6bd0ade5ff63a63b6da82c3c8ddc216aa9e805414af38a5f21d7d`),
   with the exact `THIRDLIGHT_*` environment of `docs/acceptance/deployment.md`
   §3 (loopback origins `http://127.0.0.1:8611` / `:8612`), a disposable
   `m2-course`-style project migrated from the committed M1 fixture, a
   disposable export root, a real WS owner session, and the real stdio MCP SDK
   client over the deployed MCP bundle.
2. **Integrated journey — 18/18 checks PASS** (`journey/results.json`,
   `journey/transcript.md`): migration copy, M1 v1 edit + malformed-version
   refusal, GLB import/reimport/undo/redo/malformed rejection, prefab
   capture/instantiate/override + invalid captures + MCP typed edit + stale
   conflict, behavior declaration/trust/compile/publish + hostile rejection,
   play locator/pinning/security negatives/MCP input relay/lifecycle, SIGKILL
   crash + takeover + lost-ack retry, tamper/missing/derived-cache/backup,
   double export + failure isolation + backends-stopped static serving, pins.
3. **Toolchain (repo, real):** `npm test` **135 files / 1701 passed**;
   `npm run typecheck` exit 0 (15 packages); `npm run check-deps` exit 0 (all
   exact); `npm run check-boundaries` OK (15 packages / 283 files / 1068
   specifiers / 0 violations); `npm run build` **4 built, 0 skipped**;
   fixture checker **34/34**.
4. **Targeted real-process suites:** `tests/integration/m2-content` 2 files/25,
   `m2-builds` 3/11, `m2-play` 2/14, `m2-export` 2/9; `tests/m2-runtime` 20,
   `tests/m2-physics` 3/61, `tests/m2-controller` 4/35, `tests/m2-builds` 3/26,
   `tests/m2-crash.test.ts` 6, `tests/crash-recovery.test.ts` 3,
   `tests/browser/**` (Node/`node:vm`) 3/27.
5. **Clean-install gate (disposable `/tmp` copy, `npm ci`):** 167 packages
   added; `npm test` **135/1701 passed**, typecheck / check-deps /
   check-boundaries / build (4/0) / fixture checker 34/34 all exit 0. The
   repository lockfile and `node_modules` were not touched.
6. **Nothing was deployed to the owner's host; no service, reverse proxy, TLS
   or system package was installed.**

## 2. Acceptance matrix (A01–A24)

Legend: **PASS** = executed at process/filesystem/HTTP/WS/SDK/Node level with
the cited evidence; **UNVERIFIED** = requires a real browser/GPU/keyboard/
gamepad and was not executed (no fabrication); every row that also states PASS
still carries the listed browser/hardware caveat.

| ID | Status | Evidence and reasoning |
|---|---|---|
| A01 | **PASS** (process) | Real operator `migrateProjectCopy` (real subprocess over `packages/workspace`, fixed clock) produced the accepted `expected-v2-destination` bytes exactly (`newRevision 0`, `reset-to-zero`, source tree byte-identical before/after) — `journey/01-migration.json`. M1 v1 project created/edited unchanged, and an unknown-`storageVersion` project failed `project_unavailable` with the file unchanged — `journey/02-m1-v1.json`. M1 regression: full suite + workspace 178 tests + migration/crash suites. |
| A02 | **PASS (API) / UNVERIFIED (browser)** | Real stage→upload→inspect→`publishAsset` over HTTP, two model placements with distinct IDs (`model-0001`/`model-0002`) via the extended `createEntity kind:"model"` — `journey/03-import-reimport.json`. Real in-browser images of model/materials and clip play/pause/scrub: **UNVERIFIED** (`tests/browser/m2-assets/m2-assets.browser.ts`). |
| A03 | **PASS** (process) / UNVERIFIED (browser images) | Reimport under the same `assetId` appended version 2; both placements kept entity IDs and transforms and resolve the whole-model identity; `undo` restored version 1, `redo` version 2 — `journey/03-import-reimport.json`. Real in-browser before/after images: **UNVERIFIED** (`tests/browser/m2-assets/m2-assets.browser.ts`). |
| A04 | **PASS (process) / UNVERIFIED (UI error display)** | `bad-chunk`, external-URI (`external-uri-buffer`), required-extension and decoded-limit GLBs were all rejected; the envelope hash and revision were unchanged — `journey/03-import-reimport.json`; 102 asset-pipeline adversarial tests (`suites/00`,`10-m2-content`). UI error display: UNVERIFIED (`tests/browser/m2-assets/m2-assets.browser.ts`). |
| A05 | **PASS (API) / UNVERIFIED (browser)** | `createPrefab` captured a group with an internal reference + typed property; two `instantiatePrefab` copies resulted, one with a legal `speed: 7.25` override and remapped internal `target`; copies independent — `journey/04-prefabs-properties.json`; real backend/SDK retry via the deployed MCP. Browser reopen walkthrough: UNVERIFIED (`tests/browser/m2-prefabs/m2-prefabs.browser.ts`). |
| A06 | **PASS** (process) | Camera capture → `prefab_camera_capture_forbidden`; unknown override → `property_unknown`; envelope and revision unchanged (atomic) — `journey/04-prefabs-properties.json`. Nested/external/overflow cases are covered by the packet-22/28 suites. |
| A07 | **PASS (API) / UNVERIFIED (paint)** | Real MCP `tl_command setBehaviorProperties` changed the typed value (3.5→1.5); a stale mutation returned `revision_conflict`; the WS projection received `mutation.applied` without reload — `journey/04-prefabs-properties.json`. Real browser paint: UNVERIFIED. |
| A08 | **PASS (Node) / UNVERIFIED (browser network)** | Snapping math (0.25 m/15°/0.25, clamp `[0.01,100]`, round-half-away, `1e-4`), zero-commands-during-drag / one-on-release / none-on-cancel and one undo are Node-verified (`packages/editor` 146 tests, `suites/14-editor.txt`). Browser network recording: UNVERIFIED. |
| A09 | **PASS** (process) | Real `SIGKILL` of the deployed backend: the next session attempt reported structured `stale_ownership`; explicit admin takeover then succeeded; the lost-ack replay of the original `requestId` returned `duplicated:true` and the acknowledged entity survived — `journey/07-crash-takeover.json`; plus 6 real SIGKILL blob/envelope crash tests and 3 crash-recovery tests. |
| A10 | **PASS** (process) | Source tampering was detected by the integrity query, a missing source was reported, deleting the derived cache was recoverable, and restoring the source backup brought a fresh Play back to `200` — `journey/08-durability.json`. (No M2 garbage collection; superseded versions retained.) |
| A11 | **PASS (pure) / UNVERIFIED (hardware)** | Exact keyboard/gamepad frames, dead zone, press/hold/release, latch, hot disconnect, index reuse, insecure/absent `getGamepads`, focus suppression and idempotent cleanup are Node-verified (input fixture checker + `packages/input` 79 tests). Physical keyboard/gamepad, real browser logs and the iframe `allow="gamepad"` policy: **UNVERIFIED** (`tests/browser/m2-input/m2-input.browser.ts`; BR-3 topology). |
| A12 | **PASS (real Rapier/Node) / UNVERIFIED (browser course)** | The real packet-31 Rapier adapter + packet-32 controller reproduce floor/wall/ceiling/ledge/seam/ramp/slope, coyote/buffer/release, no extra air jump, no Z drift and all 16 accepted traces × 178 rows (`tests/m2-controller` 35, `tests/m2-physics` 61; measured table in `evidence-m2/32/03b-measured-table.txt`). Browser keyboard+controller course: **UNVERIFIED** (`tests/browser/m2-controller`). CPU numbers remain container/directional (BR-2). |
| A13 | **PASS (clock-injected) / UNVERIFIED (tab resume)** | A long stall executes ≤8 steps and drops the remaining wall time with no phantom physics step, and one jump edge is consumed exactly once (`tests/m2-controller/failures`, `tests/m2-runtime` 20). A real browser tab-resume check is **UNVERIFIED**. |
| A14 | **PASS** (Node) | Fault injection after a physics/private-state mutation fail-stops the runtime, retains only the last committed state, refuses resume and disposes idempotently (`tests/m2-controller/failures`, `tests/m2-runtime/failstop` fixtures). |
| A15 | **PASS (process+Node) / UNVERIFIED (live effect)** | The deployed backend staged a canonical source container, passed the trust gate, compiled without executing project source (digest-bound `sourceDigest`/`outputDigest`), and published it; a fresh Play adopted the new build — `journey/05-behavior.json`, `journey/06-play.json`; production composition with a real property→`x` measurement is recorded in `evidence-m2/34/effective-input.json`. Visibly affecting a live browser Play: **UNVERIFIED** (`tests/browser/m2-behaviors/README.md`). |
| A16 | **PASS (process+Node) / UNVERIFIED (UI evidence)** | A network-import container was rejected `behavior_import_forbidden`; compile-failure/invalid-declaration/intent/log-flood cases are covered by the packet-33/34 suites; the previously published artifact stayed byte-identical; the trust warning explicitly states there is **no hard main-thread timeout and no sandbox** — `journey/05-behavior.json`. No hostile-code safety claim is made. Browser UI evidence (trust-notice paint, staged-edit/log-flood presentation): **UNVERIFIED** (`tests/browser/m2-behaviors/README.md`, `m2-behaviors.browser.ts`). |
| A17 | **PASS (process) / UNVERIFIED (browser reload)** | A real scene change during a live Play left the locator manifest byte-identical (pinned); a fresh Play captured a different `buildId` and adopted the new revision — `journey/06-play.json`; same in `tests/integration/m2-play` (14 tests). Browser reload/new-start log capture: UNVERIFIED. |
| A18 | **PASS (process) / UNVERIFIED (browser network capture)** | Traversal, undeclared path, foreign `contentId` and directory listing were rejected; the capability was redacted from errors; preview has no authoring token and no `/api/v1`; cancelled/failed loads never report ready — `journey/06-play.json`, `suites/10-m2-content.txt` (12 security tests), `suites/10-m2-play.txt`; bundle credential/API scan re-derived. Browser DevTools capture: UNVERIFIED. |
| A19 | **PASS (real MCP relay) / UNVERIFIED (real PNG)** | The deployed stdio MCP `tl_input_exercise` ran a bounded 3-frame sequence against the presented play and reported `appliedFromStep 100 / appliedToStep 102`, `inputMode "test"`, pinned `snapshotId`/`buildId`; an unknown play returned structured `play_not_found` (never a simulated success) — `journey/06-play.json`; full relay matrix in `tests/integration/m2-play`. The real no-browser `session_unavailable` negative is covered by `packages/backend/src/play.test.ts` and `packages/mcp-adapter/src/mcp.e2e.test.ts` (executed by `npm test`). A **real rendered PNG** requires a browser and is **UNVERIFIED** — no placeholder or synthetic image was substituted. |
| A20 | **PASS (process lifecycle, clean stop asserted) / UNVERIFIED (browser counters)** | Six stops (the reused presented play + five start/stop cycles) each returned HTTP 200 `{ok:true}` **and** the owner ack drove `play.stopped` with reason `request` and no `stopUnconfirmed` (a stop-ack timeout sets that flag) — `journey/06-play.json` (`lifecycle.stopResults`/`stopEvents`); five cycles each got fresh capabilities. The packet-9/35 relay/disconnect tests cover disposal, and the three-adapter **27 allocations / 27 releases / 0 outstanding** balance is recorded in `docs/acceptance/evidence-m2/26/raw/ownership-counters.txt` (`PACKET26_OWNERSHIP`, packet-26 probe), not in a package suite file. Browser console/loop-count capture: UNVERIFIED. |
| A21 | **PASS (export+static) / UNVERIFIED (browser traversal)** | The M2 closure exported with an exact declared==emitted file set; with the backend SIGTERM-stopped an independent static server served the tree under a non-root prefix with `model/gltf-binary` for the extension-less GLB and JS MIME for the behavior, zero external requests — `journey/09-export.json`, `suites/10-m2-export.txt` (cold builds, trace equality). Real-browser keyboard+gamepad traversal: **UNVERIFIED** (`evidence-m2/36/manifest.md` §9). |
| A22 | **PASS** | Play/export share `composeExportRuntime` and build identities; the same 120-step action sequence gives **max abs(Δ) = 0** (tolerance 1e-9) — `suites/10-m2-export.txt`. Two genuinely separate exports into **distinct disposable export roots** produce identical file sets (7 files each); the only differing files are the agreed timestamp carriers `manifest.json` (`capturedAt`→`buildId`, C36-7) and `meta.json` (`exportedAt`→`buildId`/`outputDigest`), every other artifact is byte-identical, and normalising `capturedAt` + re-deriving `buildId` reproduces the first export's `buildId` — `journey/09-export.json` (`exportRoots`, `tree1Hash`, `tree2Hash`, `differing`, `nonTimestampIdentical`, `rederivedBuildIdMatchesFirst`). |
| A23 | **PASS (process)** | Missing source/asset, corrupt blob and a hostile source fail the export without replacing the previous good output (hash-verified untouched), rejected before publication; cold first builds repeatedly exercised (3 + 6 + 2 across packets 36/33/37). **U-2** (the M1 transient `__filename` fault) was not observed in any cold build. |
| A24 | **PASS** | Clean `npm ci` copy: full suite 135/1701, typecheck/check-deps/check-boundaries/build/fixtures green; current exact pins recorded (`journey/10-pins.json`, `suites/02-check-deps.txt`); deployment/source-backup/trust/secure-context additions documented in `docs/acceptance/deployment.md` with supplied configuration separated from actually performed setup. |

## 3. Integrated journey (§3) outcome

Steps 1–9 of `m2-acceptance.md` §3 were executed non-mocked; step 10 is this
report. **8/9 executable steps fully passed; step 2/6/7/9 passed at their
API/process level with the browser-visual/interaction half UNVERIFIED.**

1. Disposable M2 project created (migration copy from the committed M1 fixture) — PASS.
2. Import → inspect → place ×2 → prefab + second copy with override → reopen persistence — API PASS; browser/pixels UNVERIFIED.
3. Snap/edit/undo/redo; real MCP typed-property change; stale command → conflict not overwrite — PASS.
4. Reimport GLB v2 with stable whole-model references; malformed replacement rejected; undo/redo — PASS.
5. Character/course configured through supported commands; a trusted behavior staged, compiled and published (old artifact retained on failure) — PASS.
6. Production isolated Play started; bounded MCP input sequence, pinning, security, repeated stop/reload — process PASS; keyboard/gamepad traversal + real screenshot UNVERIFIED.
7. Change during Play pinned the running content; fresh Play adopted the new revision; repeated start/stop — PASS.
8. Backend restarted after `SIGKILL`; explicit takeover; lost-ack retry matched durable references; source backup restore re-enabled Play — PASS.
9. Export twice, compared, served independently under a subpath with the backend unavailable — PASS; real-browser traversal UNVERIFIED.
10. This report + Gate J.

## 4. U-1…U-5 disposition

- **U-1 (browser verification) — still PARTIALLY RESOLVED; carried to the owner.**
  M1's owner confirmations stand. For M2, every browser/GPU/pixel/interaction
  row (A02, A03, A04, A05, A07, A08, A11, A12, A13, A15, A16, A17, A18, A19,
  A20, A21 — the 16-row union; A03 browser images, A04 UI error display and
  A16 UI evidence included) is **UNVERIFIED** in-container. Closing requires the
  desktop procedures in §8. **Missing real browser/gamepad evidence means M2
  milestone acceptance stays pending.**
- **U-2 (transient export build fault, M1) — NOT REPRODUCED; downgraded to a
  monitoring note.** Cold builds exercised in packets 33 (6), 36 (3) and 37
  (2) plus the clean-install build all succeeded with no `__filename` failure.
  Root cause remains unproven; the export route stays retryable and fails
  closed. No repair performed.
- **U-3 (ownership process marker) — UNCHANGED, documented.** The
  conservative-safe behavior was exercised in this packet's restart test: a
  dead holder is detected (stale) and requires explicit operator takeover; an
  ambiguous live rival is still treated as live. The production recommendation
  (name the launcher) remains in `deployment.md` §4.
- **U-4 (M1 contract-change requests) — CLOSED.** Both were accepted by
  decision 0002 §6.8 (optional `engineRoot` + `THIRDLIGHT_ENGINE_ROOT`; the
  §5.4.1 reference-entry interpretation, counts unchanged) and are implemented
  fail-closed. No residual item.
- **U-5 (playwright pin) — WITHDRAW / owner decision.** No headless-browser
  step exists in M2; the pin request is moot unless the owner adopts browser
  automation for the §8 procedures, in which case a pinned-version request
  must be raised (a new dependency is out of packet-37 scope and was not
  installed).

## 5. Honesty statement (missing browser/hardware evidence)

There is **no browser, GPU, keyboard or gamepad** in this container. This
packet therefore executed everything observable at process/filesystem/HTTP/WS/
SDK level and marked the rest UNVERIFIED. It did not:
- capture or fabricate any screenshot, browser console/network log, gamepad
  report, WebGL/pixel result, tab-resume observation or browser performance
  figure;
- substitute a synthetic gamepad/input trace for physical-device evidence;
- lower any Gate-E-fixed tolerance or threshold;
- use a mock where the contract requires integration (the journey used the
  built backend/MCP bundles, real fs, real HTTP/WS, real esbuild, real Rapier
  and the real MCP SDK).

`find docs/acceptance/evidence-m2 -iname '*.png'` is **empty** and is recorded
in `judgement/no-png.txt`. **M2 acceptance is incomplete until the
owner records the real browser/gamepad evidence below.**

## 6. Known limitations

- Physics selection remains **PROVISIONAL** pending the packet-14 desktop
  evidence; CPU figures are container/Node numbers (BR-2), not a
  reference-desktop or product-budget claim.
- `capturedAt` participates in the manifest `buildId` preimage, so wall-clock
  re-exports in a later second change `manifest.json`/`buildId` (C36-7,
  accepted with diff); everything else is byte-identical.
- No host service, reverse proxy or TLS was installed or changed; no
  long-running instance was left running; nothing was deployed to the owner's
  host.
- Browser WASM-init/CSP/static-packaging for Rapier compat, the real rendered
  PNG, physical input, tab resume and all GPU/pixel claims remain UNVERIFIED.
- Non-gating nits carried: the packet-34 README still shows the stale C34-3
  label, and `export.md` §5.4.1's GLTFLoader `h` sub-count wording (recorded by
  the Gate I re-review; docs-only, not repaired here).

## 7. Contract-change requests carried from packets 33–36

All change requests from packets 33 (`C33-1…C33-7`), 34 (`C34-1…C34-8`), 35
(`C35-1…C35-8`) and 36 (`C36-1…C36-7`) were adjudicated by Gate I
(29 accept-with-diff, 1 accept-as-recorded, 0 rejected) and the accepted docs
diffs were applied in the Gate I repair; the Gate I re-review confirmed them at
their destination sections. **No new contract-change request is raised by
packet 37.** The accepted-but-informational items (async `compileBehavior`;
`absWorkingDir` determinism pin; `StepContext.intents`/`emit`;
`ModuleConfig.behaviorLog`; `readSourceBlob`; the M2 bundle-entry file list; the
`scene.json` layout; `outputDigest` definition; the `capturedAt` digest-input
contradiction) are recorded in the packet handoffs and in decision 0002 and are
binding. No accepted contract was changed by this packet.

## 8. Owner actions required to close the UNVERIFIED rows

Run these on a desktop with a WebGL 2 browser and a **physical keyboard and
gamepad** (secure context), against the deployment in
`docs/acceptance/deployment.md`; record browser/OS/version, WebGL backend,
device/mapping, secure-context status, iframe permissions, console/network
captures and real screenshots:

1. `tests/browser/m2-input/m2-input.browser.ts` — A11 physical input, hot
   disconnect, denied/absent API, iframe `allow="gamepad"` (also the BR-3
   secure-context/gamepad topology decision: loopback vs LAN TLS).
2. `tests/browser/m2-controller/m2-controller.browser.ts` — A12/A13 course
   traversal with keyboard then gamepad, slope/jump cases, real tab resume.
3. `tests/browser/m2-assets/m2-assets.browser.ts` — A02/A03/A04/A08 GLB pixels,
   clip play/scrub, snapping network recording, UI error display.
4. `tests/browser/m2-prefabs/m2-prefabs.browser.ts` — A05/A07 prefab
   copy/edit in pixels.
5. `tests/browser/m2-behaviors/README.md` + `m2-behaviors.browser.ts` —
   A15/A16 trust notice and live property effect.
6. `tests/browser/m2-play/README.md` — A17/A19/A20 live Play, real rendered PNG
   via `tl_screenshot`, reload/new-start logs, resource counters.
7. `docs/acceptance/evidence-m2/36/manifest.md` §9 — A21 real-browser export
   walkthrough from an independent static server with the backend stopped.
8. `docs/acceptance/evidence-m2/14/manifest.md` "Manual desktop evidence
   procedure" — record the physics selection desktop evidence (ends
   PROVISIONAL) and re-measure CPU on real hardware.

Until this evidence is recorded, **M2 acceptance is pending** and the physics
selection stays PROVISIONAL. Do not reduce the criteria to the container
environment; record an explicit scope-change request if the target changes.

## 9. Deployment documentation

`docs/acceptance/deployment.md` was extended for M2 (setup, trust
acknowledgment, source-backup classification, secure-context/gamepad topology
per BR-3), clearly separating **supplied configuration** from **actually
performed setup**. No host service or TLS installation was performed or
authorized.

**Next: owner walkthrough (§8) to close the 16 UNVERIFIED browser/hardware rows;
the Gate J bounded follow-ups were applied 2026-09-19 (`docs/handoffs/gate-j-repair.md`).
After acceptance, stop; M3 is a separately requested planning task.**
