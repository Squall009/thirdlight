# Thirdlight — M1 Acceptance

Version: 0.1 (normative, pending Gate A acceptance) · Packet 03 · 2026-09-17
Scope: the exact M1 acceptance scenario (the integrated loop executed in
packet 13), the requirement → future-check map linking each normative
requirement of the M1 contract pack to the check that proves it, and the
explicit list of later tools that are **not** M1 promises.

Inputs read: `docs/contracts/project-model.md` v0.2,
`docs/contracts/commands.md` v0.1, `docs/contracts/workspace.md` v0.1,
`docs/contracts/runtime.md` v0.1, `docs/contracts/sessions.md` v0.1,
`docs/contracts/export.md` v0.1, `docs/contracts/dependencies.md` v0.1,
`docs/architecture/charter.md` (§9 M1 evidence list),
`docs/decisions/0001-stack-and-deployment.md`, planning packet 03.

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense.

---

## 1. The M1 acceptance scenario (integrated loop)

Executed in **packet 13** on a **disposable project** (`demo-m1`) on the
recorded reference desktop/browser (decision 0001 §8 item 5: the reference
desktop/browser is recorded when performance is first measured — the
scenario records whatever browser/backend is actually used; no invented
figures). Each step lists the expected outcome and the evidence to capture.
A step that cannot be verified (e.g., no browser available) is recorded as
**unverified** with precise manual steps (AGENTS.md) — never fabricated.

| # | Action | Expected outcome (contract ref) | Evidence |
|---|---|---|---|
| 1 | Create the project: admin HTTP `createProject("demo-m1", "M1 Demo")` | `{ ok: true, created: true, revision: 0 }`; on disk: `project.json` (immutable manifest, workspace.md §8.2) + `scenes/main.json` envelope at revision 0 with the default scene (project-model §15) | command result; file bytes; envelope validates via the workspace §4.3 pipeline |
| 2 | Open the editor in the desktop browser at `O_A` (authoring token) | session attach returns the full state (sessions.md §5.1); hierarchy shows "Main Camera"; viewport renders the default scene (WebGL 2 renderer backend reported — decision 0001 §3) | attach HTTP result; screenshot; browser console clean; renderer backend string |
| 3 | Create a box via the UI (Create → Box) | one `createEntity` command; ack `createdId: "box-0001"`, `revision: 1`, `duplicated: false` (commands.md §5.1); hierarchy updates from `change` (sessions.md §6.2) | command request/response bytes; hierarchy screenshot |
| 4 | Edit the box's position with a gizmo drag | **no server traffic during the drag** (sessions.md §9 — verified via the browser network panel: zero `/commands` requests mid-gesture); on release exactly one `setTransform`, `revision: 2` | network panel capture during the gesture; the single command's bytes; `change.previous/next` |
| 5 | Undo, then redo (UI) | undo applies the inverse (`revision: 3`, `change` type per commands.md §5.3), redo re-applies (`revision: 4`); a fresh edit afterwards truncates the redo stack (commands.md §9.1) | three command results; `history` depths after each; the redo truncation result |
| 6 | Close the editor; **restart the backend process**; reopen the editor | re-attach returns the state at `revision: 4` — the durable envelope survived (workspace.md §5 G1/G2); the projection is full-state resync (sessions.md §8) | attach result after restart; the on-disk envelope bytes identical to the pre-restart bytes |
| 7 | Start play (UI Play button) | play session `active → presented` (sessions.md §10.2); preview origin loads; bridge handshake + `tl.snapshot` relay (sessions.md §13.4); the **snapshot revision is displayed** in the play panel and preview HUD (`demo-m1@r4`); the demo box oscillates ±0.5 m (runtime.md §7.1) | screenshots at t≈0 and t≈2 s (mid-oscillation); `play.started`/`play.preview.ready` events; a `queryProject` **during** play shows `revision: 4` and the authored (un-moved) transform — play motion does not change the authoring scene (runtime.md §10) |
| 8 | Stop play; repeat start/stop once more | `play.stopped { reason: "request" }`; the preview disposes the runtime/adapter (runtime.md §3.4); the second cycle behaves identically — no leaked loop, no stale GPU state | the stop/ack sequence; the second cycle's screenshots; browser console clean after both cycles |
| 9 | MCP edit through the external harness: `createEntity` + `setTransform` (origin `mcp`) | commands acked (commands.md §5.1); the registered editor session receives `mutation.applied` (sessions.md §6.2) — the new box appears in the browser hierarchy **without a reload**: browser edit and AI edit converge (charter §9) | MCP tool responses; the WS event bytes; the hierarchy screenshot after the event |
| 10 | Stale concurrent edit: issue a `setTransform` with the pre-step-9 `expectedRevision` | `revision_conflict` carrying `currentRevision` (commands.md §6.4) — never a silent overwrite; a fresh re-issue at the current revision succeeds | the conflict result bytes; the recovery re-issue result |
| 11 | Screenshot via MCP (the active play session selected by `playSessionId`) | bounded PNG (`≤ 1 MiB`, width ≤ `maxWidth`) **with the play's `snapshotId` + `revision`** (sessions.md §12); with **no browser connected** (after stopping the editor): a fresh screenshot/play request returns the structured `session_unavailable` — never an error dump, never a hang (charter §7) | screenshot response bytes; the no-browser structured result bytes |
| 12 | Export (admin HTTP `exportProject`) | a static tree `demo-m1@r<rev>/{index.html, js/main.js, snapshot.json, meta.json}` (export.md §3); `meta.json` records the dependency versions (export.md §6). **Independence verification:** serve the tree with `python3 -m http.server` with the editor backend **stopped**; the game runs (demo motion, WebGL 2 baseline); the browser network panel shows **zero** requests to the authoring origin and zero `/api/` calls; console clean. **Reproducibility:** a second export of the same revision → trees byte-identical except `meta.json:exportedAt` (export.md §7) | the served-page screenshots; the network panel capture; the console log; the `diff -r` of the two exports (excluding `exportedAt`) |
| 13 | External-change behavior (expected failure modes) | (a) supported path: `releaseWorkspace` → hand-edit the envelope (scene only) → reopen loads the edited state, history reset (workspace.md §9); (b) unexpected path: replace the envelope while owned → the next mutation fails `external_change_unresolved` with `pendingChange`, writes paused, byte-exact recovery snapshot retained (workspace.md §7); queries still served from the last known good state | both result bytes; the recovery snapshot file (byte-identical to the external bytes); the query result during the pause |
| 14 | Disconnected browser: close the browser mid-session; reconnect | re-attach returns the full state; the gap rule (sessions.md §8.3) — the projection is a full resync, valid, at the current revision; a lost-ack command retry (same `requestId`) replays `duplicated: true` or re-executes (commands.md §7.2, sessions.md §8.4) — no double-apply, no lost edit | the re-attach result; the retry result bytes (`duplicated: true`); the on-disk envelope revision unchanged by the retry |

**Scenario success = all 14 steps pass with the listed evidence, or are
explicitly recorded unverified with manual steps.** This is the charter §9
M1 evidence set: "Browser edit and AI edit converge; restart retains data;
stale writes rejected; exported scene runs without backend" — steps 3–14
cover each clause. Packet 13 writes `docs/acceptance/m1-report.md` with the
actual commands, versions, browser/render backend, screenshots, and
pass/fail/unverified status (no mocked substitution — packet 13
instruction).

## 2. Requirement → future-check map

Each normative requirement of the M1 contract pack links to the check(s)
that prove it. "Packet" = where the check runs; "Evidence" = what the
record must show. Contract-internal checks (pure-function tests) run in the
implementing packet's test suite; integration checks run against the real
backend + a disposable workspace (mocks alone do not establish integration
success — AGENTS.md).

### 2.1 Runtime (runtime.md)

| Requirement (ref) | Check | Packet | Evidence |
|---|---|---|---|
| Lifecycle states + transitions; `runtime_already_started` / `runtime_not_running` / `runtime_disposed` / `tick_not_allowed` (§3) | unit tests: every transition incl. start→stop→start→dispose×2; method-after-dispose results | 08 | test results (pass list) |
| Single loop owner; no duplicate loop after start/stop cycles; owned listeners removed (§3.2/§3.4) | unit test: count active rAF subscriptions across cycles (injected driver fake); browser check in the preview | 08 (unit), 10 (browser) | unit test; browser console/cycle screenshots |
| Snapshot deep-frozen; simulation leaves the source snapshot unchanged (§2/§4) | unit test: run N steps, deep-compare the snapshot to the input, assert frozen | 08 | test result |
| Separate mutable state; snapshot not aliased (§4) | unit test: mutate the state, assert the frozen snapshot is byte-identical (canonical bytes) | 08 | test result |
| Fixed steps; `n = min(rawN, 8)`; drop-and-resync; `droppedSteps` counted; no unbounded burst (§5) | unit tests with an injected clock: normal 2-step frames, a 100 ms stall (12 raw → 8 executed, 4 dropped), anchor resync, zero-step frames, non-monotonic clock warning | 08 | test results (exact step/drop counts) |
| Determinism: same input + step sequence ⇒ identical states (§4/§7.3) | unit test: two instances, same fake-clock sequence, deep-equal state after N steps; the demo position at fixed stepIndexes equals the §7.1 formula | 08 | test results (values) |
| Interpolation policy: lerp/slerp math, derived-copy quaternion normalization, read-only (§6) | unit tests: alpha endpoints (0/≈1), sign-alignment, near-identity slerp shortcut, prev==curr short-circuit, input state unmutated | 08 | test results (values + mutation assertions) |
| Demo math exact (A=0.5, T=4.0, 120 Hz, `x0 + A·sin(…)`), all boxes, camera static, bounded ±0.5 m (§7) | unit tests at stepIndexes 0, 143/4 (quarter period), 288/4 (half); a group + camera entity untouched | 08 | test results (positions) |
| Diagnostics shape; 32-entry error ring; `errorCount` cumulative; `module_error` no-op rollback (§5.1/§8) | unit tests: ring overflow (33 errors → 32 kept), a throwing module (injected) ⇒ state restored, step not advanced | 08 | test results |
| No filesystem/backend/editor/MCP dependency (§9) | boundary check 1 + negative fixture (dependencies.md §5.1–5.2): a `runtime` source importing `three` or a Node builtin fails the build | 04 (check), 08 (fixture re-proven in the test suite) | boundary check output; handoff 04 negative-fixture record |
| No user scripts / no input / no physics (§7.3/§10) | negative check: the runtime bundle contains no `eval`, no dynamic `import()` of content, no input listeners (content scan, dependencies.md §5.4 patterns extended with `eval(`/`addEventListener("key`) | 08/10 | scan output |
| Runs in the export with the same code (§9; export.md §5.1) | export independence run (scenario step 12) with the same bundle graph as the preview | 12 | bundle metafile comparison; served-page screenshots |

### 2.2 Sessions (sessions.md)

| Requirement (ref) | Check | Packet | Evidence |
|---|---|---|---|
| Session establish / re-attach / full-state result (§5.1) | integration test: attach, re-attach (same `sessionId`), the old connection detached (1000 `detached`) | 09 | test transcript (request/result bytes) |
| One active authoring session per project; `session_conflict` (§5.1) | integration test: a second `sessionId` for the same project ⇒ 409 with `activeSessionId` | 09 | result bytes |
| Origin allowlist exact match; `bad_origin` (§4.2) | integration tests: allowlisted origin accepted; a different origin ⇒ 403 / WS 1008 `bad_origin`; no wildcard behavior | 09 | both results |
| wsToken single-use + TTL + replay rejection (§4.3) | integration tests: second upgrade with the same token ⇒ 1008 `ws_token_replayed`; expired token ⇒ `ws_token_invalid`; server logs contain no query string | 09 | close codes; log excerpt (token-free) |
| WS catalog exhaustive; unknown `type` ⇒ `unknown_event` event, connection survives; 10-errors/60 s ⇒ close 1008 (§5.2/§7) | integration tests: unknown type, malformed frames, the tolerance boundary | 09 | events + close codes |
| `mutation.applied` on every applied mutation (any origin); browser dedups its own `requestId` (§6.2) | integration test: an MCP-origin command applied → the registered browser receives the event; the browser's own command → HTTP ack + event, deduped by `requestId` (asserted by the editor's projection state) | 09 (event delivery), 11 (MCP origin), 13 (convergence, scenario step 9) | event bytes; hierarchy screenshot |
| Gap rule + full resync on revision mismatch (§8.3) | integration test: drop WS events artificially (server test hook or a second client), the client observes `revision > lastSeen + 1` ⇒ full re-attach; the projection equals the backend state | 09 | transcript; projection comparison |
| Reconnection after a dropped ack (§8.4; commands.md §7.2) | integration test: retry an identical request after the ack is dropped (test hook discards the response) ⇒ `duplicated: true` replay or fresh execution; envelope revision advanced exactly once | 09 (transport), 07 (durable records) | result bytes; on-disk envelope revision |
| Gesture: no per-frame traffic; one commit command; conflict recovery (explain, never silently lose; ≤ 1 auto-retry) (§9) | browser check: network panel during a drag (zero `/commands`); one `setTransform` on release; a stale base revision mid-gesture ⇒ `revision_conflict` surfaced in the UI (screenshot) with the explanation fields | 10 | network capture; the command bytes; the UI screenshot |
| Play start: preconditions (`session_unavailable` with no browser; `play_already_active`), snapshot at the current revision, `play.started` to the owner editor (§10.1) | integration tests: each precondition; the snapshot's `revision` == the current authoring revision; the owner editor receives `play.started` with the full snapshot | 09/10 | results; event bytes |
| Play revisions frozen; authoring advances during play; play never changes authoring (§10.2; runtime.md §10) | integration test (scenario step 7): a command during play advances the revision; the play session's `revision` unchanged; the authoring transform unchanged | 10/13 | query results during play; the play session record |
| Stop path: relay, 5 s ack timeout ⇒ `stopUnconfirmed`; `preview_timeout` / `expired` / `session_lost` terminations (§10.3) | integration tests: the happy relay; a non-acking editor (test hook) ⇒ `stopped stopUnconfirmed: true`; the timeout paths with a test-clock or shortened constants (test config only — the M1 constants stand in production) | 09/10 | state transitions (log entries) |
| Screenshot/diagnostics relay chain; bounded PNG ≤ 1 MiB / ≤ `maxWidth`; `snapshotId`+`revision` in the response; `screenshot_timeout` at 10 s (§11.5/§12) | integration test: full relay (preview stub in the test harness that posts a valid `tl.screenshot.result`); a non-responsive preview ⇒ timeout code; the response carries the play's `snapshotId`/`revision` | 09 (relay), 10 (real capture), 11 (MCP tool) | response bytes; the timeout result |
| No-browser ⇒ structured `session_unavailable` (play/screenshot), never a hang/headless substitute (§10.4) | integration test (scenario step 11): with no registered browser, play start and screenshot both return the structured code | 09/11 | result bytes |
| Preview receives no credentials; the preview bundle has no authoring token/API URL (§2/§13.2) | bundle scan (dependencies.md §5.4 patterns a–i over the preview bundle) + manual inspection of the page config (only `v` + `authoringOrigin`) | 10 | scan output; the config snippet |
| Bridge: exact `targetOrigin`/`event.origin` + `event.source` checks; wildcard `"*"` forbidden; handshake sequence; allowlist exhaustive (§13.3–§13.5) | unit tests on the bridge validators (`protocol` package): a wrong origin/source/type is dropped + counted; the nonce mismatch drops `tl.snapshot`; the handshake order enforced | 09 (validators), 10 (wiring) | test results; the drop counters |
| Preview reload ⇒ re-handshake + snapshot re-send; editor reload ⇒ `session_lost` stop path; orphaned preview bound (§13.6) | integration tests: each path (test hooks for the iframe lifecycle) | 10 | state transitions; log entries |
| Dev/deploy origin config shape; bundle dirs; missing bundle ⇒ structured startup error (§13.7) | startup test: missing `dist/preview` ⇒ the structured error in the bounded log; the config values used verbatim in the Origin checks | 09 | log entry; the config echo |
| Bounded logs (128 ring) / payload / timeout bounds (§11) | unit/integration tests: ring overflow, frame-size bounds (oversized frame ⇒ 1009), log endpoint `limit` bounds | 09 | test results |

### 2.3 Export (export.md)

| Requirement (ref) | Check | Packet | Evidence |
|---|---|---|---|
| Same runtime as play mode; no separate gameplay implementation (§5.1) | metafile comparison: the export bundle's runtime/three-adapter modules are the same workspace sources/versions as the preview bundle (scenario step 12) | 12 | metafile diff |
| Exact import graph; no editor/server/MCP/node modules in the bundle (§5.2) | metafile check (dependencies.md §5.3) at export time ⇒ `export_bundle_graph_forbidden` on violation | 12 | metafile check output |
| Single relative `fetch(./snapshot.json)`; browser-only target (§5.3) | the scan (export.md §5.4 pattern d) + a `node:`/`process.`/`__dirname` scan (e/f) | 12 | scan output |
| Forbidden-content scan, all 9 patterns, no silent exceptions (§5.4) | the scan on all emitted bytes; a deliberate fixture (a bundle containing the authoring origin) fails with the reported hit | 12 (incl. the negative fixture) | both scan outputs |
| Static layout, relative paths, `file://` unsupported, serving via plain static HTTP (§3) | scenario step 12: serve with `python3 -m http.server`, backend stopped; the game runs; the `file://` attempt is documented as unsupported | 12 | screenshots; the network panel; the documented attempt |
| `meta.json` exact shape + recorded dependency versions (§6) | a schema test on `meta.json` (strict, unknown fields rejected); the `dependencies` values equal the pinned installs (`check-deps`) | 12 | test result; the meta bytes |
| Validation pipeline order; no partial artifact; previous tree untouched on failure; the 6 failure codes (§4) | integration tests: each code (invalid scene, revision bump mid-build via a test hook, bad output path, a forbidden-graph fixture, a forbidden-content fixture, a read-only FS target); after each: previous tree byte-identical, temp dir removed | 12 | per-code result bytes; the tree diff |
| Reproducibility scope: byte-identical `snapshot.json`/`js/main.js`, `meta.json` equal except `exportedAt` (§7) | two consecutive exports of the same revision; `diff -r` (scenario step 12) | 12 | the diff output (empty except `exportedAt`) |
| One small supported scene only (no asset system) (§8) | negative: an M1 scene is only the registry components (project-model §10) — the exporter's supported set equals the registry; no asset code paths exist in the bundle (metafile) | 12 | metafile; the registry comparison |

### 2.4 Dependencies (dependencies.md)

| Requirement (ref) | Check | Packet | Evidence |
|---|---|---|---|
| Units created only when implemented; no premature wiring (§2) | the boundary check asserts no `dependencies` entry references a non-existent workspace package (dependencies.md §5.6) | 04 onward, every packet | check output per handoff |
| `exports`-map-only public surface; internals unreachable (§3) | check 1: a specifier reaching a non-exported file fails; a temporary internal-import fixture fails the build | 04 (check + fixture), per-unit thereafter | check output; handoff 04 record |
| Allowed-edge tables (node-side + bundles) (§4.1/§4.2) | check 1 (node-side) + check 3 (bundles) on every implemented package/bundle | 04/05–12 (incremental) | check outputs in each handoff |
| Forbidden edges incl. `runtime → three`, `mcp-adapter → backend` (non-`/services`), `editor → workspace` (§4.3) | the negative fixture proof (check 2) + per-edge negative fixtures in the check tool's test suite | 04 (proof), per-edge in the tool tests | handoff 04 record; tool test results |
| No hidden global services; no duplicate mutation path (§4.3) | check 1: `globalThis` assignments flagged for review; a code-review rule per packet (each handoff states the mutation paths its code touches); the workspace `runCommand` is the only executor (verified by the edge table: only `workspace` imports `commands` apply) | 04 (check), 06/07/09 (structure) | check output; handoff statements |
| Narrow registration: exactly one M1 module; unknown/duplicate names rejected; no string-to-code resolution (§6) | unit tests on `createSimulationRegistry`/`registerSimulationModule`/`instantiateRuntime.modules` (runtime.md §8 `config_invalid` cases) | 08 | test results |
| Stack pins + exact-version enforcement; React only in `editor`; no web framework anywhere (§7) | `check-deps` (exact pins); check 1: `react`/`react-dom` may appear only in `editor`'s `dependencies`; no web-framework package in any `dependencies` (the check's forbidden-package list includes the common ones: express, fastify, koa, hapi, next, nuxt, vue, svelte, preact, angular) | 04 (tool), every install thereafter | `check-deps` output; the lockfile excerpt |
| esbuild TSX loader for the editor's React UI (decision 0001 §10) | the editor build (packet 10) succeeds with the TSX loader; `check-deps` shows the pinned esbuild; typecheck (tsc 5.9.3 strict) passes on the TSX | 10 | build + typecheck output |

### 2.5 Earlier contracts (packets 01–02; recorded for completeness)

- **project-model.md** — fixture-driven: every valid/invalid fixture in
  `fixtures/project-model/` (incl. the byte-input cases R1–R6 and the
  `expected.json` index) passes the validator/serializer (packet 05);
  canonical round-trip byte-identity (packet 05).
- **commands.md / workspace.md** — the 9 fixture scenarios
  (`fixtures/commands/scenarios/`) + envelope fixtures pass the real
  implementation: retry/lost-ack, `request_id_reused`, stale revision, no
  partial changes, mixed-origin undo/redo, crash before/after replace,
  external modification, second-backend ownership (packet 06/07 unit +
  packet 07 durable-workspace tests against the real filesystem, with fault
  injection per the packet 07 instruction).
- **M1 evidence clauses (charter §9)** — scenario steps 3–14 (packet 13).

## 3. What is NOT an M1 promise (explicit)

These later tools are **not** M1 promises. They are deferred by the
contracts (normative non-goals), not foreclosed — each has a recorded
extension point. A packet or a review may not cite any of them as M1
acceptance evidence, and an implementation must not add them speculatively
(AGENTS.md: no unrequested future game systems).

| Later tool | Status in M1 | Recorded extension point / next step |
|---|---|---|
| **Input simulation** (keyboard/controller/gamepad in play) | Not M1. The runtime consumes no input events; play runs the built-in demo only (runtime.md §10). The platformer controller is M2 (charter §9 M2 row). | New simulation module(s) through the registry (dependencies.md §6) with a reviewed step/input contract; desktop gameplay with keyboard + controller is a confirmed M2+ decision (decision 0001 §1). |
| **Physics** (collision, gravity, integration) | Not M1. No physics engine anywhere in M1 (decision 0001 §3: explicitly unselected); the demo motion is prescribed, not simulated. | The bounded M2 physics evaluation (charter §9 M2 row; decision 0001 §1) picks the engine and the 2.5D dimensional model before the character controller. |
| **Graphs** (node-graph tooling, curve/animation graphs, material/shader graphs) | Not M1. No graph authoring or data in the runtime or editor (runtime.md §10; charter §3 defers full shader graphs; decision 0001 §10 scope guard: no graph editor panels in M1). | Graphs enter as reviewed contracts when their milestones (M2+ gameplay systems, later advanced authoring — charter §9) make them concrete; the UI-framework rationale recorded the roadmap expectation (decision 0001 §10) without making it M1 scope. |
| User-script loading / arbitrary code execution in play | Not M1 (runtime.md §7.3). | Deferred until the execution boundary (origin isolation — present; capability/timeout/failure isolation — absent) is reviewed as a separate contract; the registry is deliberately insufficient for untrusted code. |
| Play → authoring write-back ("apply play state") | Not M1 (charter §6; runtime.md §10). | A later explicit operation with a selected change set (charter §6). |
| Prefabs, assets (GLB/glTF), lights, audio, materials beyond `box.material.color` | Not M1 (project-model §14; export.md §8). | M2 content contracts (charter §9 M2 row). |
| Rename/reorder commands, settings edits, multi-scene | Not M1 (commands.md §11; project-model §3/§14; workspace.md §12 — multi-scene needs a new persistence contract). | Future contract changes, each reviewed. |
| Collaborative editing / multiple browser sessions per project | Not M1 (sessions.md §14; decision 0001 §2). | A future session-contract change. |
| WebGPU rendering | Not an M1 promise. WebGL 2 baseline is the M1 target; the WebGPU path only after feature coverage is proved (decision 0001 §2/§3); TLS/secure context is a later deployment requirement (decision 0001 §7). | Measured capability work before any parity claim (charter §8). |
| Headless browser / server-side rendering / screenshots without a browser | Not M1 (decision 0001 §3/§9; sessions.md §10.4). The no-browser outcome is the structured `session_unavailable`. | A separate later capability (charter §7). |
| A general asset build system / incremental export / publishing | Not M1 (export.md §8). One small supported scene, served by a plain static HTTP server. | M2+ asset pipeline + M4 template/export validation (charter §9). |
| Backups as a feature, mobile acceptance, multiplayer, RPG systems | Not M1 (workspace.md §12; decision 0001 §1/§9; charter §3). | Recorded for the later milestones. |

**Bound of the M1 claim:** M1 is an architectural proof (charter §9) — the
authoring loop, isolated play, and standalone export, with the contracts
above as the normative interface. Anything listed here that appears in a
packet's evidence must first be approved as a contract change (AGENTS.md:
accepted contracts are binding; contract changes are separate reviewable
proposals).

## 4. Change rules

- This document is part of the Gate A contract pack (charter §9 M0:
  "reviewed contracts and fixtures"). After Gate A acceptance, changes to
  the scenario, the check map, or the non-promise list are reviewed diffs.
- A requirement may be removed from M1 only by a contract change that also
  updates the affected packet instructions (the prompts pack is the task
  source — an out-of-band scope change is forbidden).
- Unverifiable checks stay in the map: they are recorded **unverified**
  with manual steps at execution time (packet 13) — a check is never
  silently dropped to make the scenario pass.