# Thirdlight — M1 acceptance report

Version 0.2 · Packet 13 · 2026-09-18 (v0.2 adds §1B — the owner's
real-browser observations — and updates §2, §5, U-1). Executes the
normative 14-step scenario
(`docs/planning/m1-acceptance.md` §1) on a **disposable project** `demo-m1`
against the **real deployment bundle** (`dist/backend/backend.mjs`, started as
a separate process with the environment in
`docs/acceptance/deployment.md`), on this host (Proxmox LXC container).

**Environment (actual):** Node v22.22.1 · npm 9.2.0 · Linux x86_64 (LXC,
same `/proc` namespace) · three 0.186.0 · esbuild 0.28.2 · typescript 5.9.3 ·
ws 8.21.3 · @modelcontextprotocol/sdk 1.30.0 · react/react-dom 19.3.0 (editor
panels only) · Python 3 (independent static server).

**Browser/render backend: NOT AVAILABLE in this environment.** No browser is
installed (the container lacks `libnspr4`/`libnss3` and root). Every step is
therefore executed at its **protocol/HTTP/WS/process level** — against the
real backend process, real workspace files, real stdio MCP server, and real
esbuild builds — with the browser-visual portions marked **UNVERIFIED**
(honest recording per AGENTS.md; precise manual steps in §5). Headless
editor/preview behavior (session attach, play relay, screenshot relay, bridge
handshake model) is performed by a headless WS stub
(`/tmp/tl-m1/ws-client.mjs`, disposable) that speaks the exact session
protocol; it renders nothing. **This is not a mocked test run: the scenario
ran the deployed artifact end-to-end; only the pixel layer could not run.**

**Instance:** `THIRDLIGHT_DATA_ROOT=/tmp/tl-m1/data`,
`THIRDLIGHT_EXPORT_ROOT=/tmp/tl-m1/exports`, `THIRDLIGHT_ENGINE_ROOT=<repo>`,
origins `http://127.0.0.1:8501` / `http://127.0.0.1:8502`, tokens
`admin:m1-admin-token-1`, `authoring:demo-m1:m1-auth-token-1` (test-only,
disposable instance). Raw command outputs: `/tmp/tl-m1/out/*.txt` (kept with
the disposable data root).

---

## 1. Step results

### Step 1 — create the project (`createProject("demo-m1","M1 Demo")`) — **PASS**

```
POST /api/v1/admin/projects  (admin token)  body {"projectId":"demo-m1","name":"M1 Demo"}
→ 201 {"ok":true,"created":true,"revision":0}
```
On disk (`/tmp/tl-m1/data/projects/demo-m1/`): `project.json` (immutable
manifest: `id demo-m1`, `name "M1 Demo"`, `scenes: [scene-main → scenes/main.json]`),
`scenes/main.json` envelope at revision 0 with the default scene (exactly
`cam-main`, project-model §15), `.thirdlight/ownership.json`
(`state: owned`, `lockEpoch: 0`, live pid). Evidence: `out/s1-createProject.txt`,
`out/s1-disk.txt`.

### Step 2 — open the editor (session attach) — **PASS (protocol) / UNVERIFIED (render)**

```
POST /api/v1/sessions  (authoring:demo-m1 token)
  body {"projectId":"demo-m1","sessionId":"sess-<32hex>","clientInfo":{"kind":"browser","label":"headless-editor-stub"}}
→ 200 {ok, sessionId, connId, wsToken, revision:0, manifest, scene(cam-main), history{0,0}, workspace}
GET ws://127.0.0.1:8501/api/v1/ws?sessionId=…&wsToken=…  → `attached {connId, revision:0}`
```
Full state returned at attach (sessions.md §5.1); the attach revision/scene
match the on-disk envelope. **UNVERIFIED (manual):** viewport render of the
default scene, WebGL 2 renderer-backend report, clean browser console — no
browser here. Post-run real-browser confirmation (2026-09-18, §1B-2): a real
browser loaded the page, attached over WS, and committed edits; the
pixel-level items remain unconfirmed. Evidence: `ws-events.jsonl`
(establish + ws.open + attached).

### Step 3 — create a box (Create → Box) — **PASS (command level) / UNVERIFIED (UI)**

```
POST /api/v1/projects/demo-m1/commands
  {"op":"createEntity","projectId":"demo-m1","expectedRevision":0,"requestId":"req-…",
   "args":{"kind":"box","name":"M1 Box","transform":{…identity…},"box":{"size":[0.4,0.4,0.4],"material":{"color":"#4a90d9"}}}}
→ 200 {ok, revision:1, duplicated:false, createdId:"box-0001", change{createEntity…}, history{undo:1,redo:0}}
```
The connected session received `mutation.applied {requestId, revision:1, change}`
over WS (the hierarchy would update from it — sessions.md §6.2). The UI click
path is UNVERIFIED (no browser) — post-run, real-browser UI commits are
confirmed at transport level (§1B-2); the command surface is exactly what the
UI sends (same envelope, protocol-validated). Evidence: `out/s3-createEntity.txt`.

### Step 4 — gizmo drag ⇒ one commit on release — **PASS (commit semantics) / UNVERIFIED (drag network)**

```
setTransform {entityId:"box-0001", transform:{position:[0.75,0,0]}} @ expectedRevision 1
→ 200 {ok, revision:2, change{previous/next, changedFields:[position]}}
```
Exactly one command advanced the revision (the release commit); the gesture
logic (≤ 1 undoable commit, one auto-rebase, second conflict surfaced) is
established by packet 10's gesture unit tests. **UNVERIFIED (manual):** "zero
`/commands` requests mid-drag" in a browser network panel — real-browser UI
commits are confirmed at transport level (§1B-2); the network-panel
assertion itself remains unconfirmed. Evidence: `out/s4-setTransform.txt`.

### Step 5 — undo, redo, redo-truncation — **PASS**

| cmd | result |
|---|---|
| `undo` @2 | 200 → r3, inverse change (position back to [0,0,0]), `appliedOf` = the original setTransform requestId, history {1,1} |
| `redo` @3 | 200 → r4, re-applied, `appliedOf` same requestId, history {2,0} |
| fresh `setTransform` @4 (position→[0,0,0]) | 200 → r5, **redoDepth truncated to 0** |
| `queryProject` | revision 5, entityCount 2, history {undo:3, redo:0} |

Evidence: `out/s5a-undo.txt` … `out/s5d-queryProject.txt`.

### Step 6 — close editor, restart backend, reopen — **PASS**

1. Editor stub closed (WS dropped).
2. Backend SIGTERM'd → stderr `thirdlight-backend: closed`, port refused.
3. New process, same `THIRDLIGHT_DATA_ROOT`. Establish **before** takeover ⇒
   **503** `project_unavailable {reason:"stale_ownership"}` with the holder
   record + hint (never automatic — workspace.md §6.2).
4. `POST /api/v1/admin/projects/demo-m1/takeover` ⇒ 200 `{ok, lockEpoch:1}`
   (audit counter advanced 0→1).
5. Reopen (establish with the same sessionId — the editor's reopen path) ⇒
   200, full state, **revision 5**, WS `attached {revision:5}`.
6. **Envelope bytes identical across the restart** (md5
   `8dd99e4c0a9c26405e8872678026d916` pre/post — workspace.md §5 G1/G2).

Note: the undo/redo *depths* are session-scoped (0 after reopen); the
envelope revision (5) is durable. Evidence: `out/s6-*.txt` (stale establish,
takeover, reopen attach, byte comparison).

### Step 7 — start isolated play — **PASS (backend/protocol) / UNVERIFIED (preview render)**

```
POST /api/v1/projects/demo-m1/play {}  (authoring token, connected session)
→ 200 {playSessionId:"play-…", playBase:"http://127.0.0.1:8502/", snapshotId:"demo-m1@r5", revision:5, demo:true, expiresAt}
```
- WS `play.started` carried the **full frozen snapshot** (runtime.md §2 shape:
  `snapshotId/projectId/revision/scene`, 2 entities) + `startedBy` (the
  browser session).
- Stub (mimicking the editor opening the preview) sent `play.preview.ready`.
- Preview template served at `O_P/?play=<id>` (separate origin; the page
  embeds only the authoring-origin string for the bridge's exact-origin check
  — no credentials).
- `queryProject` **during** play: revision 5, authored transforms unchanged —
  play motion does not mutate the authoring scene (runtime.md §10).

**UNVERIFIED (manual):** the preview iframe actually rendering the oscillating
box (±0.5 m, 120 Hz fixed-step) in WebGL 2, the `demo-m1@r5` HUD line,
t≈0/t≈2 s screenshots, clean console. Post-run: a real-browser Play round trip
(start → stop) is confirmed at transport level (§1B-2); the render/HUD items
remain unconfirmed. Evidence: `out/s7-*.txt`, ws-events.

### Step 8 — stop play; repeat cycle — **PASS (lifecycle, incl. failure modes)**

Four start/stop cycles executed. Confirmed stop sequence (final cycle):
HTTP stop 200 → WS `play.stop.request {reason:"request"}` → client
`play.stopped.ack` → WS `play.stopped {reason:"request"}` (no
`stopUnconfirmed`). Additional structured behaviors observed and recorded:

- stop of a play whose editor session is **disconnected** ⇒ 503
  `session_unavailable` ("the editor browser must be connected to stop this
  play") — structured, no hang;
- stops with **no ack** bounded at 5 s ⇒ `play.stopped {…,"stopUnconfirmed":true}`
  (bounded cleanup, no leaked loop at the protocol level);
- stop of an **unknown** playSessionId ⇒ 404 `play_not_found`.

**UNVERIFIED (manual):** the preview disposing its runtime/adapter in a real
browser (runtime.md §3.4) — "no leaked loop / no stale GPU state" pixel-level.
Post-run real-browser stop cycle confirmed at transport level (§1B-2);
pixel-level disposal remains unconfirmed. Evidence: `out/s8*.txt` (start/stop
acks + full WS sequences).

### Step 9 — MCP edit through the external harness — **PASS (convergence proven at event level) / UNVERIFIED (hierarchy paint)**

Real stdio MCP server (`node dist/mcp-adapter/mcp.mjs`, spawned by a real SDK
`Client` over `StdioClientTransport`, env per deployment.md §6;
`clientId: m1-harness`):

```
tl_command createEntity @5 → {ok, revision:6, createdId:"box-0002", requestId req-… (adapter-generated)}
tl_command setTransform @6 → {ok, revision:7, change{previous/next}}
tl_inspect {target:"project"} → {revision:7, entityCount:3}
```
The **connected editor session received both `mutation.applied` events with
`origin {kind:"mcp", clientId:"m1-harness"}`** — without any reload (browser
edit and AI edit converge; charter §9). **UNVERIFIED (manual):** the new box
actually appearing in the browser hierarchy (the event bytes are what the
hierarchy consumes). Evidence: `out/s9-mcp.txt`, `out/s9b-mcp-inspect.txt`,
ws-events (origin-bearing events).

### Step 10 — stale concurrent edit — **PASS**

```
setTransform @ expectedRevision 5 (current is 7)
→ 409 {code:"revision_conflict", cls:"conflict", expectedRevision:5, currentRevision:7, hint}
re-issue @ expectedRevision 7 (fresh requestId) → 200 {ok, revision:8}
```
Never a silent overwrite; conflict carries `currentRevision` (commands.md
§6.4). Evidence: `out/s10-stale-edit.txt`.

### Step 11 — MCP screenshot + no-browser structured results — **PASS (relay + bounds) / UNVERIFIED (real capture)**

Play started on the connected session (`play-…`, snapshot `demo-m1@r8`):

```
MCP tl_screenshot {playSessionId, maxWidth:512}
→ {ok, playSessionId, snapshotId:"demo-m1@r8", revision:8, width:1, height:1, dataUrl:"data:image/png;base64,…"}
```
WS relay: `screenshot.request {relayId, maxWidth:512}` ⇄ `screenshot.ack`
(same relayId). The capture payload is a **synthetic 1×1 PNG from the stub**
(the headless stand-in for the preview's real capture — the relay, validation,
and response bounds are exercised; a real browser capture is UNVERIFIED). The
response carries the play's `snapshotId` + `revision` (sessions.md §12).

No-browser (WS killed; session registered but disconnected): screenshot on the
active play ⇒ **503 `session_unavailable`** ("the preview is not ready: the
play is not yet presented"); stop on that play ⇒ **503
`session_unavailable`** ("the editor browser must be connected") — structured,
bounded, no error dump, no hang (charter §7). Evidence: `out/s11-*.txt`,
ws-events (relay pair).

### Step 12 — export + independence + reproducibility — **PASS (artifact + serving) / CONFIRMED (game render in a real browser — §1B-1)**

```
POST /api/v1/admin/projects/demo-m1/export {} → 200
{ok, outputDir:"demo-m1@r8", snapshotId:"demo-m1@r8", revision:8,
 files:{index.html:626, js/main.js:1859797, snapshot.json:2015, meta.json:497}, scanHits:0}
```
- **Independent static server, backend STOPPED** (its port refused):
  `python3 -m http.server 8931` over the export tree ⇒ all four files 200 with
  exact sizes; unknown path 404.
- **Content scan of the served bundle:** `fetch("./snapshot.json")` exactly 1
  (total `fetch(` = 4 = the three@0.186.0 recorded 3 + the engine's 1);
  `http(s)://` = 26 (the recorded 3 + 23); credentials/origins/`/api/v1/`/
  `node:` = **0**; `index.html` relative-only; `snapshot.json`/`meta.json`
  origin/credential-free.
- **Reproducibility:** second export of the same snapshot (r8) ⇒
  `js/main.js`, `snapshot.json`, `index.html` **byte-identical**; `meta.json`
  differs only in `exportedAt` (21:28:18Z vs 21:28:59Z) — exactly the §7 scope.
- `meta.json` records the dependency versions (three 0.186.0, typescript
  5.9.3, esbuild 0.28.2, runtime {fixedStepHz:120, modules
  `[thirdlight.demo:box-motion]`}) + scene {entityCount:3, cameraId,
  boxCount:2}.

**UNVERIFIED (manual) — PARTIALLY RESOLVED 2026-09-18 (§1B-1):** the owner
ran a served export page (a different export, `demo-0001@r1`, no backend) and
confirmed the demo box oscillation verbatim; its engine bundle is
code-identical to this step's `demo-m1@r8` bundle (only esbuild banner
source-path comments differ — §1B-1). The WebGL-2/HUD/network-panel/console
assertions of this step remain unconfirmed. Evidence: `out/s12-*.txt`
(export results, static-server log + scan, reproducibility diff, tree copies).

One transient fault during this step is recorded honestly: the first export
attempt against one backend process returned
`export_bundle_graph_forbidden` with esbuild text `__filename is not defined`
(no artifacts were written — the atomic pipeline left the previous tree
untouched and removed its temp dir); a clean restart of the **same bundle**
exported successfully, and isolated probes (bundled exporter context, same
cwd) reproduce neither build failure. Likely an esbuild service-worker
initialization race on the first build call in a fresh process; the export
route is retryable and the failure mode is safe (fails closed, no partial
output). See unresolved issues U-2.

### Step 13 — external-change behavior — **PASS (both paths)**

**(a) Supported path (release → hand-edit → reopen):**
1. `POST …/admin/projects/demo-m1/release` ⇒ 200 `{ok, revision:8, retryCleared:true}`.
2. While released: queries from the **releasing** process ⇒ 503
   `project_unavailable {reason:"workspace_closed"}` (scoped precisely — it
   never re-opens its own released project).
3. Hand edit of `scenes/main.json` (scene only: `box-0002` renamed
   `MCP Box (hand-edited)`; envelope otherwise intact; `retry.records: []`).
4. A **new backend process** opens it on demand ⇒ claims the released record
   (`lockEpoch` 4→5, `state: owned`, new backendId) and loads the edited
   state: `queryProject` revision 8, `queryEntity` shows the new name,
   **history reset** (`{undoDepth:0, redoDepth:0}` — the new boundary).

**(b) Unexpected path (foreign bytes while owned):**
1. Foreign writer replaces the envelope on disk (`box-0001` position →
   `[9.99,0,0]`; sha8 `87ed675e`).
2. Next mutation ⇒ **503 `external_change_unresolved`** with
   `pendingChange {snapshotState:"ok", externalHash:"87ed675e…", externalValid:true,
   externalErrorCount:0}` — "writes are paused".
3. **Recovery snapshot byte-exact:**
   `.thirdlight/recovery/scene-20260918T212941Z-87ed675e.json` — identical
   bytes to the foreign file (sha256 matches the filename suffix).
4. **Queries during the pause** serve the last known good state: revision 8,
   `box-0001` at its acked `[0.25,0,0]` (not the foreign value),
   `workspace {writePaused:true, pauseReason:"external_change", pendingChange…}`.
5. Operator resolution `discard-external` ⇒ 200 `{ok, revision:8,
   historyReset:true}`; the next mutation succeeds (r9).

Evidence: `out/s13a-*.txt`, `out/s13b-*.txt`, recovery snapshot.

### Step 14 — disconnected browser: reconnect + lost-ack retry — **PASS**

1. Session re-attached (WS up); command A `setTransform` (requestId
   `req-12a7925e…`, @9) ⇒ 200 r10.
2. Browser closed mid-session (WS socket killed abruptly).
3. Reconnect (re-establish with the same `sessionId`) ⇒ 200 full state at
   **revision 10**, new connId, WS `attached {revision:10}` — the gap rule:
   full resync, valid, at the current revision (sessions.md §8.3).
4. **Lost-ack retry**: re-issued command A with the **same requestId** and its
   original `expectedRevision` 9 ⇒ 200 **`duplicated: true`** replaying the
   original result (revision 10, same change) — no double-apply, no lost edit.
5. Revision unchanged by the retry: in-memory query 10 and on-disk envelope
   revision 10.

Evidence: `out/s14-*.txt`.

## 1B. Real-browser observations (owner, recorded 2026-09-18, post-run)

Observed by the owner (user) in a real desktop browser that can reach the
container IP `10.0.10.223`. Reported verbatim; the transport-level evidence
below is backend-side and stands independently of what the browser displayed.

**B-1 — Export page (S12; charter §9 clause "exported scene runs without
backend") — CONFIRMED by a real browser.**
- Setup: the static tree `/home/dadmin/thirdlight/exports/demo-0001@r1`
  (exported 2026-09-18T21:02:57Z by the deployment bundle's export route;
  scene: `cam-main` + 1 box) served by `python3 -m http.server 8765 --bind
  0.0.0.0` — **no backend process running** (8501/8502 free at the time).
- The owner opened `http://10.0.10.223:8765/` and reported (verbatim):
  **"I see the demo box moving back and forth on the x axis"** — the demo
  module's x-axis sine motion running in a real WebGL context with zero
  backend.
- Bundle cross-link (fresh hashes): served `js/main.js` (sha256
  `977a031d…0f38025`, 1,859,113 B) vs the acceptance export
  `demo-m1@r8/js/main.js` (sha256 `26e85c0d…a6de83a`, 1,859,797 B): the
  **only** byte differences are esbuild section-banner source-path comments
  (relative vs absolute — derived from the build process's cwd; the
  acceptance run executed from `/tmp/tl-m1`, so its banners read
  `../../home/dadmin/…`); the engine code is identical, and both
  `meta.json` record the same pinned set (three 0.186.0, typescript 5.9.3,
  esbuild 0.28.2, runtime {fixedStepHz:120, modules
  `[thirdlight.demo:box-motion]`}).
- Not individually confirmed by the owner (remain UNVERIFIED, §5 item 5):
  the network-panel zero-request assertion, a clean console, and the HUD
  line. The owner's report noted no errors.

**B-2 — Editor + isolated play (S2/S3/S7/S8) — real-browser transport
CONFIRMED; visual details reported qualitatively.**
- Setup: deployment-bundle backend (authoring `0.0.0.0:8501`, preview
  `0.0.0.0:8502`, origin `http://10.0.10.223:8501`, data root
  `/home/dadmin/thirdlight/projects`); project `demo-0001` created fresh
  (r0) + one box `box-0001` (r1); editor statics from `dist/editor`.
- The owner's browser loaded `http://10.0.10.223:8501/`. Backend session
  log (verbatim, `GET /api/v1/sessions/sess-d085ff…/log`, 7 entries,
  22:25:38–22:28:00Z): `registered` → play `started` (r1) → play
  `stop_requested` → play stop (`request`) → `command` r2 → `command` r3 →
  `detached`.
- Established from the real browser: the editor page loads; the session
  client establishes and attaches over WS; the toolbar's Play drives the
  full isolated-play round trip (start → presented → stop request →
  stop); two edits are committed through the UI (revision 1→3, durable on
  disk).
- The owner's only substantive report (verbatim):
  **"…is this supposed to be missing nearly all of the functionality?"** —
  a qualitative scope assessment: the UI rendered and the feature set was
  evaluable. The feature set is exactly the M1 scope by design (charter
  §9: primitives, transform/undo/redo, save/reopen, isolated play, simple
  export; assets, materials/lights, gameplay are M2–M4).
- Not individually confirmed (remain UNVERIFIED, §5 items 1–2): pixel-level
  viewport detail (WebGL backend report, HUD), the zero-`/commands`-
  mid-drag assertion, the preview HUD line, and the preview-disposal
  console check.

---

## 2. Verdict

**14/14 steps PASS at the protocol/HTTP/WS/process level** (against the real
deployment artifact: process restarts, real files, real stdio MCP, real
esbuild builds). The browser-visual portions of steps 2, 4, 7, 8, 9, 11, 12
were **UNVERIFIED** at run time (no browser in this environment) with manual
steps in §5. The charter §9 M1 evidence clauses are each covered: *browser
edit and AI edit converge* (S9 events), *restart retains data* (S6
byte-identical envelope), *stale writes rejected* (S10 conflict), *exported
scene runs without backend* (S12 static serving).

**Post-acceptance, 2026-09-18 (§1B):** the owner's real-browser observations
closed the remaining clause — *exported scene runs without backend* now has
a real-browser render confirmation (B-1, verbatim quote). The editor/Play
clauses gained real-browser **transport** confirmation (B-2: page load, WS
attach, full Play round trip, two UI-committed edits) plus the owner's
qualitative scope report. Still UNVERIFIED (the owner did not individually
confirm; §5, U-1): the pixel/WebGL details — renderer-backend report, clean
console, network-panel zero-traffic assertions, preview HUD, and real
screenshot capture (S11).

## 3. Defects found and fixed by this packet (bounded)

1. **`THIRDLIGHT_TOKENS` parsing** (backend executable entry): split on the
   first colon broke `authoring:<projectId>:<token>` (scope read as bare
   `authoring` ⇒ structured startup failure). Fixed: split on the **last**
   colon; docstring updated (tokens must not contain `:`). Exercised by the
   real deployment run.
2. **Configured bind ports ignored**: `createBackend` hardcoded `listen(0, …)`
   (ephemeral), so a configured `host:port` bound to a different port than the
   advertised origins. Fixed: `listen(bindPort, bindHost)` (port 0 ⇒
   ephemeral, test behavior preserved). New test: a second backend on the same
   configured port fails with `EADDRINUSE` (static.test.ts).
3. **Deployment bundle: `esbuild` must stay external** (`tools/build.mjs`):
   the exporter's esbuild JS API cannot be bundled (it resolves its service
   binary relative to its own file location; bundled ESM context ⇒
   `__filename is not defined` at export time). The backend deployment bundle
   now keeps `esbuild` external (resolved from the checkout's `node_modules`
   — documented: the backend runs FROM the engine checkout); the MCP bundle
   remains fully self-contained. The `ws` CJS interop needs the
   `createRequire` banner (same artifact class, not the export.md §5.3 pinned
   browser-bundle option set).

No contract was changed. Two **contract-change requests** remain open from
packet 12 (owner disposition): sessions.md §13.7 optional `engineRoot`
config field (implemented additive/optional, fail-closed), and export.md
§5.4.1 reference-entry interpretation under pinned esbuild (the literal bare
namespace entry elides to a 15-byte empty IIFE; the implemented entry
references the namespace; the §5.4.1 table counts are unchanged and remain the
binding record).

## 4. Toolchain (all green at report time)

`npm test` 66 files / 841 tests · `npm run typecheck` exit 0 (10 packages) ·
`check-deps` all exact · `check-boundaries` OK (10 packages, 150 files, 514
specifiers) · `npm run build` 4 built (editor, preview, MCP stdio, backend
deployment bundle), 0 skipped.

## 5. UNVERIFIED — precise manual steps for a real browser

Run on a desktop with a WebGL-capable browser (Chrome/Firefox/Edge), with the
backend started per `docs/acceptance/deployment.md` and a project created:

**Status (2026-09-18, §1B):** item 5 (export) — performed by the owner,
confirmed (B-1). Items 1–2 (editor, play) — partially performed by the owner
(B-2): page load, attach, Play round trip, two UI edits at transport level;
the per-item assertions remain unconfirmed. Items 3–4 (MCP convergence, real
screenshot) — not performed.

1. **Editor render (S2/S3/S4):** open `http://<host>:8501/`; expect the
   viewport to render the default scene (Main Camera at [0,0.5,4]), DevTools
   console clean; create a box via the toolbar; drag its gizmo — the network
   panel must show **zero** `/commands` requests during the drag and exactly
   one `setTransform` on release; HUD reports the renderer backend
   (WebGL 2 baseline).
2. **Play (S7/S8):** press Play; the preview origin loads in the separate
   tab/iframe; the demo box oscillates ±0.5 m; the play panel + preview HUD
   show `demo-m1@r<n>`; take screenshots at t≈0 and t≈2 s; Stop — the preview
   disposes (console clean, no leaked rAF loop across two cycles).
3. **MCP convergence (S9):** with the editor open, run the MCP client
   (deployment.md §6) `tl_command createEntity`; the new box appears in the
   hierarchy without a reload.
4. **Screenshot (S11):** with play active, `tl_screenshot` returns a PNG
   showing the rendered scene (real capture, ≤ 1 MiB).
5. **Export (S12):** serve `exports/<id>@r<n>/` with `python3 -m http.server`
   while the backend is stopped; open it; the demo runs (WebGL 2), HUD shows
   the snapshot id + backend, network panel shows **zero** requests to the
   authoring origin and zero `/api/` calls, console clean.

## 6. Unresolved issues / bounded follow-ups

- **U-1 (browser verification) — PARTIALLY RESOLVED 2026-09-18 (§1B):**
  owner real-browser observations recorded: the export-page demo run is
  confirmed (B-1, verbatim quote; the observed bundle is code-identical to
  the acceptance export's), and the editor session attach + Play round trip
  + two UI edits are confirmed at transport level (B-2, session log).
  Still UNVERIFIED: the §5 pixel/WebGL details (renderer-backend report,
  clean console, network-panel zero-traffic assertions, preview HUD, real
  screenshot capture S11). The container constraint (no browser; missing
  `libnspr4`/`libnss3`, no root) is unchanged; the owner's desktop browser is
  the available real-browser path.
- **U-2 (transient export build fault):** one first-attempt
  `__filename is not defined` esbuild failure in a fresh process (S12 note;
  fails closed, no artifacts). Root cause unproven (suspected service-worker
  initialization race); mitigations recorded (retryable route, isolated probes
  clean). If it recurs, instrument the esbuild service spawn.
- **U-3 (process marker):** the ownership-liveness default marker
  (argv[0] contains `thirdlight`) does not match `node dist/…` launches;
  behavior is conservative-safe (ambiguous ⇒ live ⇒ reject + operator
  investigates). For production, name the launcher process (deployment.md §4).
- **U-4 (contract-change requests, owner disposition):** the two packet-12
  requests (sessions.md §13.7 `engineRoot`; export.md §5.4.1 reference-entry
  interpretation) remain open and implemented fail-closed.
- **U-5 (playwright pin):** the packet-08 open pin request is moot unless a
  headless-browser verification step is adopted (U-1); otherwise withdraw.

**M1 is accepted only after this evidence is reviewed (Gate D).** Remaining
failures: none at the protocol/process level; the browser-visual items above
are unverified, not failed. No automatic start of M2.