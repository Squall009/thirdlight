# Thirdlight — Session Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 03 · 2026-09-17
Scope: M1 browser/backend sessions — connection and session IDs, exact
HTTP/WS request and event shapes, authentication and origin policy, the
authoring projection and snapshot resync, gesture preview/commit,
reconnection after dropped acknowledgements, bounded logs and errors, play
session routing (play/screenshot to an explicitly selected browser), and the
separate-origin play preview with its checked message bridge.

Companion documents (same milestone, review together):

- `docs/contracts/commands.md` v0.1 — the command/query envelopes this
  contract carries (payloads defined there; transport defined here).
- `docs/contracts/workspace.md` v0.1 — authoring-state durability, the
  single writer, and the operator workspace operations whose transport this
  contract defines.
- `docs/contracts/runtime.md` — the runtime snapshot this contract routes to
  the preview frame.
- `docs/contracts/export.md` — the export operation (admin scope; not MCP).
- `docs/contracts/dependencies.md` — the `protocol` package that implements
  the strict message parsers/validators named here.

Inputs read: `AGENTS.md`, `docs/STATUS.md`,
`docs/architecture/charter.md` (§4 deployment, §6 editing and runtime state,
§7 AI integration and context limits), `docs/decisions/0001-stack-and-deployment.md`
(§5 MCP, §7 remote access and secure context), `docs/environment.md`,
planning packet 03.

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense. All payloads are strict JSON (unknown fields rejected,
mirroring the commands.md discipline); the `protocol` package (packet 09)
owns the shared strict parsers/validators. Booleans appear throughout this
protocol (transient messages, not persisted documents — the commands.md
note applies).

---

## 1. Scope and ownership

This contract owns:

- The topology: authoring origin, preview origin, backend listeners (§2).
- Connection/session/play-session/connection-token IDs and syntaxes (§3).
- Authentication and origin policy shapes (§4) — token mechanics are
  implemented in packet 09; the shapes are fixed here.
- The authoring session lifecycle: establish/re-attach over HTTP, the WS
  channel, heartbeat, and the one-active-authoring-session rule (§5).
- Command/query transport and the `mutation.applied` convergence event (§6).
- The complete WS event catalog (§7) — exhaustive for M1.
- The authoring projection, resync, and the gap rule (§8).
- Gesture preview/commit semantics (§9).
- Play sessions: start/stop, the backend-side state machine, frozen play
  revisions, and the routing of play/screenshot/diagnostics to an
  explicitly selected browser (§10–§12).
- Bounded logs, error shape and codes, payload and timeout bounds (§11).
- The separate-origin preview: page config, exact-origin/source-checked
  message bridge, handshake sequence, and the exhaustive message allowlist
  (§13), plus development/deployment origin configuration (§13.7).

This contract does **not** own:

- Command semantics, revisions, retry records — `commands.md`.
- Filesystem persistence — `workspace.md`.
- Runtime behavior — `runtime.md`.
- The React UI internals (packet 10 implements panels against this
  protocol; the UI is a consumer, not a co-author).
- MCP transport/client selection — decision 0001 §5 (packet 11); this
  contract fixes only the backend operations the MCP tools route into.

## 2. Topology and origins

```text
Authoring origin  O_A   (dev:  http://127.0.0.1:8501     deploy: https://thirdlight.<lan>.local)
  ├── editor UI (React panels + imperative three.js viewport + preview embed)
  └── backend listeners: HTTP API (/api/v1/…) + WS (/api/v1/ws)

Preview origin    O_P   (dev:  http://127.0.0.1:8502     deploy: https://play.thirdlight.<lan>.local)
  └── play preview page (runtime + three-adapter bundle), static — NO API endpoints

MCP (external harness) → backend MCP endpoint (decision 0001 §5; packet 11)
```

- `O_A ≠ O_P` always: different ports in development (same host, different
  port ⇒ different origin), different hostnames in deployment. The exact
  strings are backend configuration (§13.7); nothing in this contract
  hardcodes ports.
- The backend process serves both listeners (one process, process-level
  deployment — decision 0001 §6). The **preview listener serves only the
  static preview page** (a small HTML template + the preview bundle). It
  exposes no API endpoints, no WS, and no authenticated channel: the
  preview frame's only inputs are the static page, the injected config
  (§13.2), and bridge messages from the verified authoring origin
  (§13.3–§13.5).
- **Preview frames receive no backend credentials, normatively** (charter
  §7): no authoring token, no connection token, no API URL, no origin that
  carries an API. The preview never talks to the backend. Packet 10
  verifies the preview code contains no privileged authoring token.
- Editor and preview run **independent** three.js contexts (separate
  canvases); they share no JS context and no state — only the checked
  bridge messages (§13).

## 3. IDs and tokens

| ID / token | Syntax | Generated by | Lifetime |
|---|---|---|---|
| `sessionId` | `sess-` + 32 lowercase hex (CSPRNG) | **client** (the browser) | logical; re-attachable across connections |
| `connId` | `conn-` + 32 lowercase hex | **server** | one WS connection |
| `playSessionId` | `play-` + 32 lowercase hex | **server** | until stopped/expired (§10) |
| `wsToken` | 64 lowercase hex | **server** | single-use, TTL 60 s, bound to `(sessionId, connId)` |
| `relayId` | `relay-` + 32 lowercase hex | **server** | one screenshot/diagnostics relay (§12) |
| `requestId` | `req-` + 32 hex (commands.md §3) | client | the dedup lease (commands.md §6) |

- The client generates `sessionId` once per editor page (per project) and
  reuses it on every re-attach — that is what makes reconnect
  re-association possible (§8.4).
- `playSessionId` appears in the preview URL query (`?play=<id>`, §13.2);
  it grants nothing by itself (the preview origin has no API), and the
  snapshot reaches the preview only via the checked bridge from the verified
  authoring origin.
- The server log **must not** record query strings (the `wsToken` travel
  rule, §4.3).

## 4. Authentication and origin policy (shapes; packet 09 implements)

### 4.1 Project-scoped bearer tokens

- All authoring HTTP APIs require `Authorization: Bearer <token>`. A token
  is bound to a scope: `authoring:<projectId>` (the browser editor) or
  `admin` (operator operations, §6.4). Tokens are issued by the owner's
  deployment (packet 09/13); this contract fixes where they are presented
  and how failures are shaped, not the issuance UX.
- **Authenticated authoring access, normatively:** browser authoring
  (session establishment, commands, play start) is possible only with a
  valid `authoring:<projectId>` token. No anonymous authoring, not even on
  localhost (decision 0001 §7: authenticated project-scoped access even for
  private deployment).
- The MCP client authenticates per decision 0001 §5 (its own transport;
  same backend service boundary, origin recorded `mcp` in command envelopes).
- Failure shape: `401 { ok: false, error: { code: "unauthorized", cls: "validation" } }`
  (or WS close 1008, reason `unauthorized`).

### 4.2 Origin allowlist

- The backend config carries `authoringOrigins: string[]` — an exact-string
  allowlist of browser `Origin` values for the authoring origin (§13.7).
- Every browser HTTP request and the WS upgrade carry the `Origin` header;
  the backend compares it by **exact string equality** against the
  allowlist — no wildcards, no suffix matching, no `Host`-based fallback for
  browser clients. Mismatch ⇒ HTTP `403 { code: "bad_origin" }` / WS close
  1008 reason `bad_origin`.
- Non-browser clients (MCP, operator tooling over plain HTTP) are not
  subject to the Origin allowlist; they are bound by the token and, for MCP,
  by the transport decision (decision 0001 §5).

### 4.3 WS upgrade authentication

1. `POST /api/v1/sessions` (token-authenticated) returns a `wsToken`
   (64 hex, single-use, TTL 60 s, bound to the `(sessionId, connId)` pair).
2. The browser upgrades: `ws(s)://<O_A>/api/v1/ws?sessionId=<id>&wsToken=<t>`.
   The server verifies: valid token, unused, unexpired, `sessionId` matches
   the token's binding, and the Origin allowlist (§4.2). Any failure ⇒
   close 1008 with the reason code (`ws_token_invalid` /
   `ws_token_replayed` / `session_not_found` / `bad_origin`).
3. A replayed or expired `wsToken` never opens a channel; re-attaching
   requires a fresh `POST /sessions` (a new `wsToken`).
4. Reconnect: a new connection always starts with a fresh
   `POST /sessions` re-attach (§5.2) — the WS itself is never "resumed".

## 5. Authoring session lifecycle

### 5.1 Establish / re-attach — `POST /api/v1/sessions`

Request (strict):

```json
{ "projectId": "demo-0001", "sessionId": "sess-9f2c8a1d3b4e5f60718293a4b5c6d7e8",
  "clientInfo": { "kind": "browser", "label": "desktop-chrome" } }
```

`clientInfo` is optional: `kind` exactly `"browser"` (the only M1 session
kind — MCP and admin clients never establish sessions; any other `kind` ⇒
`field_value`), `label` ≤ 128 chars, no control chars (display metadata for
session listing only — never used for authorization).

Result (strict):

```json
{ "ok": true, "sessionId": "sess-…", "connId": "conn-…", "wsToken": "<64 hex>",
  "revision": 4,
  "manifest": { "…" },
  "scene": { "…" },
  "history": { "undoDepth": 3, "redoDepth": 0 },
  "workspace": { "writePaused": false, "pendingChange": null } }
```

- `scene` is the **full normalized scene document** (project-model §8) at
  the current revision; `manifest` is the normalized manifest. This full
  state is the initial projection and the resync payload (§8).
- `workspace` is exactly the commands.md §5.6 query `workspace` object:
  `{ writePaused: false, pendingChange: null }` when clean; while an external
  change is pending it carries `writePaused: true`,
  `pauseReason: "external_change"`, and the `pendingChange` block (queries —
  and this response — are affected alike).

Outcomes:

| Case | Result |
|---|---|
| New `sessionId` for the project, no active session | created; success result |
| Same `sessionId` again (reload/reconnect) | **re-attach**: the session binds to the new connection; a still-open old connection is closed (1000, reason `detached`) and logged |
| A **different** `sessionId` while an active session exists | `409 { code: "session_conflict", cls: "conflict", activeSessionId, lastActivityAt }` |
| Project missing / unloadable | `project_not_found` / `project_unavailable` (workspace.md §11 codes) |

- **One active authoring session per project (normative, M1)** — decision
  0001 §2 / charter §2. The external harness (MCP) is a separate client
  kind and never occupies the browser session slot (server-only commands
  remain usable without an open browser — charter §7).

### 5.2 The WS channel

- One WS per connection (`connId`). On successful attach the server sends
  `attached` (§7). Text frames, one strict JSON object per frame.
- **Heartbeat:** the client sends `ping` at least every 20 s; the server
  replies `pong`. A connection silent for 60 s is dropped (close 1000,
  reason `heartbeat_timeout`, logged `detached`). Dropping a connection does
  **not** destroy the session (re-attach in §5.1 restores it).
- Frame bounds: incoming ≤ 64 KiB (except `screenshot.ack` ≤ 1.5 MiB),
  outgoing ≤ 1 MiB. Oversized frame ⇒ close 1009 reason `frame_too_big`.
- A frame that is not valid JSON or fails the strict shape check ⇒ error
  event `protocol_error` (counted); ≥ 10 protocol errors within 60 s ⇒ close
  1008 reason `protocol_error`. (Bounded self-defense, §11.)

### 5.3 Session bookkeeping

- Per session the backend tracks: `lastActivityAt` (any request/event),
  connected `connId` (or detached), the current projection revision the
  client last acknowledged by attach (for the gap rule, §8.3).
- Session listing and logs: §11.4.

## 6. Commands and queries over HTTP

### 6.1 `POST /api/v1/projects/:projectId/commands`

- Body: exactly a commands.md envelope (mutation §3 or query §4); response:
  exactly the commands.md result (§5). This contract adds the transport
  envelope discipline: strict parsing of the bytes first (project-model
  §12.3 pass 1 rules apply to the request body), then the commands.md
  pipeline.
- **Caller binding:** a request with `origin.kind: "browser"` must come
  from the project's registered authoring session's token/connection
  (else `403 { code: "session_required" }`). `origin.kind: "mcp"` /
  `"admin"` bypass the browser-session requirement (server-only usability,
  charter §7). The `origin` field is recorded in the dedup digest
  (commands.md §6.6) and in the history (commands.md §9.3) — unchanged
  semantics; this contract only fixes who may send which origin.
- **Delegation, normatively:** the transport layer (HTTP handlers, MCP
  adapter) delegates every persistent change to the workspace service
  (`runCommand`, the sole command executor — workspace.md §4/§5; packet 09
  instruction). The transport never mutates files independently.

### 6.2 `mutation.applied` (projection convergence)

After the commands.md pipeline publishes a mutation (step 8), the backend
sends the registered browser session the WS event `mutation.applied` (§7.1)
**for every applied mutation, of any origin** (browser, MCP, admin). The
browser projection updates from `change` alone (commands.md §5.1). This is
what makes browser and AI edits converge (charter §9 M1 evidence) without
polling.

- A browser that sent the command itself receives both the HTTP response and
  the WS event; it must **deduplicate by `requestId`** (an event whose
  `requestId` it already acked via HTTP is skipped).
- MCP/admin callers get no WS channel (the harness observes through command
  responses and queries — charter §7; no server-push to MCP in M1, §14).

### 6.3 Operator (admin) operations

The workspace.md §11 operator commands and `createProject`/`exportProject`
are **admin-scoped HTTP operations** (token scope `admin`), implemented in
packets 09/12:

```text
POST /api/v1/admin/projects                          createProject(projectId, name)
POST /api/v1/admin/projects/:projectId/release       releaseWorkspace
POST /api/v1/admin/projects/:projectId/takeover      takeoverWorkspace
POST /api/v1/admin/projects/:projectId/accept-external   acceptExternalState
POST /api/v1/admin/projects/:projectId/discard-external  discardExternalState
POST /api/v1/admin/projects/:projectId/export        exportProject (export.md)
```

- They are **never** browser editor commands and, in M1, **not MCP tools**
  (the charter §7 M1 tool categories do not include project creation,
  maintenance, or export; workspace.md §11 records the same bound). The
  harness reaches them over plain HTTP with the admin token or by direct
  operator action (decision 0001 §5 option 2).
- Result/error shapes: the workspace.md §11 result objects and codes,
  wrapped in the standard `{ ok, … }` / `{ ok: false, error }` envelope.

## 7. WS event catalog (normative, exhaustive for M1)

All events are strict JSON objects; every event carries `type` and, where
relevant, `projectId`. Unknown fields ⇒ rejected (§5.2). Unknown `type` ⇒
the server replies `{ "type": "error", "code": "unknown_event" }` and
counts it (the connection survives — robustness rule).

### 7.1 Server → client (the editor)

| `type` | Payload (strict) | Trigger |
|---|---|---|
| `attached` | `{ connId, revision }` | successful WS attach; the client compares `revision` with its projection and resyncs on mismatch (§8.3) |
| `pong` | `{}` | on `ping` |
| `mutation.applied` | `{ requestId, revision, origin, change }` — `change` is the commands.md §5.3 change data | any applied mutation, after publish (§6.2) |
| `play.started` | `{ playSessionId, startedBy: origin, snapshot: <the full runtime snapshot document, runtime.md §2> }` | a play start succeeded (§10.1) — sent to the owner editor |
| `play.stop.request` | `{ playSessionId, reason: "request" \| "expired" }` | the backend initiates a stop (§10.3); the editor relays `tl.play.stop` to the preview |
| `play.stopped` | `{ playSessionId, reason: "request" \| "preview_failed" \| "preview_timeout" \| "expired" \| "session_lost", stopUnconfirmed?: true }` | stop complete, preview failure, or auto-stop (§10.3) |
| `screenshot.request` | `{ relayId, maxWidth? }` | relay step 3 (§12) |
| `play.diagnostics.request` | `{ relayId }` | relay step 3 (§12) |
| `error` | `{ code: "unknown_event" \| "protocol_error", frameHint? ≤ 64 chars }` | bounded protocol errors (§5.2) |

- **One-shot delivery (`play.started`).** `play.started` is delivered exactly
  once per play session, to the owner *session*. If the owner's connection is
  down at that moment, the backend holds the event in the session's pending
  queue (bounded: one event; the session outlives the connection, §5.2) and
  delivers it on (re)attach; it is dropped if the play record is
  stopped/expired first. The editor holds the snapshot this way before
  initiating the bridge handshake (§13.4); the 15 s present timeout (§10.2)
  bounds any such wait.

### 7.2 Client → server (the editor)

| `type` | Payload (strict) | Meaning |
|---|---|---|
| `ping` | `{}` | heartbeat (§5.2) |
| `play.preview.ready` | `{ playSessionId }` | the editor presented the preview and received the preview's `tl.ready` (the play is `presented`, §10.2) |
| `play.preview.failed` | `{ playSessionId, code, message? ≤ 256 }` | the preview could not start (runtime `snapshot_invalid`/`config_invalid`, bridge failure) |
| `play.stopped.ack` | `{ playSessionId }` | the preview's `tl.stopped` was received (or the preview frame was closed) |
| `screenshot.ack` | `{ relayId, ok, dataUrl?, width?, height?, error? }` — `dataUrl` a base64 PNG ≤ 1 MiB | relay step 6 (§12) |
| `play.diagnostics.ack` | `{ relayId, ok, diagnostics?, error? }` — `diagnostics` ≤ 16 KiB JSON | relay step 6 (§12) |

- The editor **relays, it does not fabricate**: `screenshot.ack` /
  `play.diagnostics.ack` values must be the exact results received from the
  verified preview origin (§13.4); if the relay failed (preview not
  present, timeout, bridge error), the editor sends `ok: false` with
  `error.code: "relay_failed"` — it never invents a capture.
- `play.preview.ready` is sent exactly once per play session (after the
  bridge handshake + `tl.ready`, §13.5).

## 8. Authoring projection and resync

- The browser's **projection** = normalized scene + revision + history
  depths + workspace flags, plus the local gesture preview (§9). It is a
  *projection of backend state* (charter §6); the authoritative state is the
  backend's (workspace.md). The editor viewport (imperative three.js) is
  built from the projection; the editor never writes to browser storage as
  an authoritative project database (packet 10 instruction).
- The projection is updated from exactly two sources:
  1. **Full state** — the `POST /sessions` result (establish, re-attach,
     resync).
  2. **`mutation.applied` events** — apply `change` to the projection
     (commands.md §5.3 change data is complete for that).
- **Gap rule (normative).** `mutation.applied` events carry monotonically
  increasing revisions. If the client observes `revision > lastSeenRevision
  + 1` (missed events — e.g., the WS was down), or an `attached`/attach
  revision different from its projection revision, the client **must
  discard the projection and take a fresh full state** (re-attach). A
  change is never applied onto a stale projection.
- **Resync = full replacement (M1).** There is no partial resync; the cost
  is bounded by the model limits (≤ 1024 entities). The editor viewport is
  rebuilt from the projection on a full resync (M1: a full three.js scene
  rebuild is the simple correct behavior).
- **8.4 Reconnection after a dropped acknowledgement (normative).** The
  command ack is the **HTTP response**, not a WS message — a WS drop
  therefore never loses a command ack. A lost HTTP ack (network failure
  between backend ack and client) is recovered exactly per commands.md
  §6.1/§7.2: the client retries the **identical** request (same
  `requestId`) on a fresh `POST /commands`; the backend either replays the
  recorded result (`duplicated: true`) or re-executes fresh — never
  double-applies. Meanwhile the WS re-attach (§5.1) returns the full state,
  and the gap rule (§8.3) guarantees the projection converges. Together: no
  silent divergence, no double-apply, no lost edit.
- **Stale projections are visible.** The editor UI displays the projection
  `revision` and the connection state (connection status panel, packet 10);
  a detached or gap-resynced projection is visibly marked, never silently
  trusted.

## 9. Gesture preview / commit (normative)

Gizmo dragging previews locally and commits as exactly one undoable command
(charter §6; packet 10 instruction):

- **Preview (during the gesture):** the editor viewport applies the
  candidate transform to the local projection/viewport **only** (an
  imperative three.js mutation of the editor's own render objects — not the
  backend, not the projection's committed values). **No server traffic
  during the gesture; per-frame mouse motion must not require a round trip**
  (charter §6). The backend state and revision are unchanged; other clients
  (MCP queries) observe the pre-gesture state.
- **Commit (gesture completion):** exactly **one** `setTransform`
  (commands.md) carrying the final field values, with
  `expectedRevision = baseRevision` (the revision at gesture **start**) and
  a fresh `requestId`.
- **Conflict (an intervening edit advanced the revision):** the result is
  `revision_conflict` with `currentRevision` (commands.md §6.4). The editor
  must: (a) re-read the state (query or resync); (b) determine from the
  `change` data whether the target entity's transform was altered by the
  intervening commands; (c) if **unchanged**: re-issue the logical edit with
  a fresh `requestId` at the current revision — **at most one automatic
  re-issue per gesture**, then surface the conflict; (d) if **changed**:
  surface a structured explanation to the user (what was edited, by which
  origin — `originOfApplied`/`origin` — and the current value). The gesture
  outcome is **explained, never silently lost** (packet 10). The local
  preview transform is reset to the authoritative value after any conflict.
- **Cancellation (Esc / cancel control):** no command is sent; the preview
  reverts; no record, no revision, nothing observable to other clients.
- M1 defines **no server-side gesture state**: there is no partial/preview
  transform in the backend, no gesture API, no per-frame commit.

## 10. Play sessions (backend side)

### 10.1 Start — `POST /api/v1/projects/:projectId/play`

Request (strict): `{ "options": { "demo": true } }` — `options` optional;
`demo` boolean, default `true` (selects the moving-box module, runtime.md
§7). No other fields (M1).

Preconditions and outcomes:

| Check | Failure |
|---|---|
| project openable/loadable (workspace.md §4.3) | `project_unavailable` (workspace code) / `project_not_found` |
| **exactly one registered authoring session exists for the project** (the **owner** — the live-browser requirement, charter §7) | `session_unavailable` (cls `unavailable`, hint: connect the editor browser) |
| no active play session for the project | `play_already_active` (cls `conflict`, carrying `activePlaySessionId`) |

Effect: the backend reads the **current** revision and the embedded scene
from its loaded authoring state (the backend is the only reader of the
envelope — workspace.md), constructs the **runtime snapshot** (runtime.md
§2; `snapshotId = <projectId>@r<revision>`), allocates `playSessionId`, and
records `{ projectId, ownerSessionId, revision, snapshotId, demo, state:
"active", createdAt, lastActivityAt }`.

Result (to the requester, browser or MCP):

```json
{ "ok": true, "playSessionId": "play-…", "playBase": "http://127.0.0.1:8502/",
  "snapshotId": "demo-0001@r12", "revision": 12, "demo": true, "expiresAt": "…" }
```

plus the WS event `play.started` (with the full `snapshot`) delivered to the
**owner editor**. The editor constructs the preview URL as
`<playBase>?play=<playSessionId>` (§13.1/§13.2). The snapshot in the
`play.started` payload is what the editor relays to the preview — whether
the play was started by the editor's own button or by MCP (packet 11: the
MCP "start play" tool routes into this endpoint; its response carries the
same result, which is how the harness can also learn the snapshot revision).

### 10.2 States

```text
active → presented → stopping → stopped
active → (play.preview.failed) → stopping (reason "preview_failed")
active → (present timeout 15 s) → stopping (reason "preview_timeout")
active/presented → (inactivity TTL 30 min) → stop path (reason "expired")
any → (owner session lost) → stop path (reason "session_lost")
```

- `active`: created; no preview presented yet.
- `presented`: the editor sent `play.preview.ready` (handshake + `tl.ready`
  complete, §13.4/§13.5). **Screenshot and diagnostics require `presented`**
  (§12).
- `stopping`: a stop is in flight (§10.3).
- `stopped`: terminal. The backend discards the play record (log entry kept,
  §11.1).
- **Play revisions are frozen (normative).** The play session's
  `revision`/`snapshotId` never change after start. The **authoring**
  revision may advance during play (the editor keeps authoring; MCP keeps
  editing) — the play continues on the old immutable snapshot, and play
  motion never changes the authoring scene (structurally: the runtime owns
  no authoring write path, runtime.md §10; the preview holds no
  credentials, §2). Starting a new play captures the then-current revision.
  Stopping play never changes the authoring revision. Packet 10 displays
  the `snapshotId` in the editor's play panel and in the preview HUD, so the
  play session's revision is always identified (charter §7).

### 10.3 Stop — `POST /api/v1/projects/:projectId/play/:playSessionId/stop`

Available to the owner browser session or admin/MCP (a stop is not a
browser-exclusive action — the harness may stop a play it started).

Sequence (normative): backend marks `stopping`, sends WS `play.stop.request`
to the owner session; the editor relays bridge `tl.play.stop`; the preview
`dispose()`s the runtime and adapter and posts `tl.stopped`; the editor
sends WS `play.stopped.ack`; the backend marks `stopped` and broadcasts
`play.stopped { reason }`.

- No `play.stopped.ack` within **5 s** ⇒ the backend marks `stopped`
  anyway with `stopUnconfirmed: true` (log entry; the preview may have been
  closed by the user — treated as stopped; later screenshot/diagnostics to
  it ⇒ `session_unavailable`).
- The stop path is also how `preview_failed`, `preview_timeout`, `expired`,
  and `session_lost` terminations are delivered. If the owner WS is detached
  at that moment,
  the play is marked `stopped` (unconfirmed) directly — there is no relay
  path through a dead editor (M1 bound, §13.6: an orphaned preview tab may
  keep rendering until the user closes it; only the backend record is
  bounded).

### 10.4 Routing to an explicitly selected browser (normative)

- Live play actions (play start, stop-with-relay, screenshot, diagnostics)
  target the **explicitly selected browser**: the play session's
  `ownerSessionId` (the registered authoring session that owns the editor
  viewport). The MCP "screenshot from the selected connected browser"
  (charter §7; decision 0001 §5) names a `playSessionId` in its request;
  the backend resolves it to the owner browser and relays through that
  browser's WS. Session listing (§11.4) is how a caller discovers and
  selects the live session.
- **No browser means a structured unavailable result, normatively**
  (charter §7): play start with no registered browser ⇒
  `session_unavailable`; screenshot/diagnostics/stop-relay on a play whose
  owner WS is not connected ⇒ `session_unavailable` (cls `unavailable`,
  `hint` states that the editor browser must be connected). These are
  well-formed results with stable codes — never an error, never a hang, and
  never a headless substitute (no server-side browser/GPU is assumed —
  decision 0001 §3/§9; headless automation is a later separate capability).
- Play start requires the registered browser (the play UI *is* the browser
  viewport in M1). Commands/queries/workspace operations remain fully
  usable with no browser at all (server-only, charter §7).

## 11. Bounded logs, errors, and payload/timeout bounds

### 11.1 Session log (bounded)

- Per session: a ring of the last **128** entries
  `{ ts (UTC seconds), kind, ref, revision?, code? }` with
  `kind ∈ { registered, detached, command, play, screenshot, diagnostics,
  error }` and `ref` the relevant `requestId` / `playSessionId` / `relayId`.
- Exposure: only via the log endpoint (§11.4), bounded by `limit`
  (1–128, default 32) plus the true `total`. Never streamed in full; no
  unbounded growth; entries carry no secrets, no absolute paths.

### 11.2 Error shape

`{ "code", "cls": "validation" | "conflict" | "unavailable" | "not_found" |
"internal", "message" (≤ 256 chars, log-safe, no secrets), "hint"?,
…code-specific fields }` — the commands.md discipline. HTTP status mapping
(normative): `validation`→400, `conflict`→409, `not_found`→404,
`unavailable`→503, `internal`→500; success→200.

### 11.3 Session-layer error codes (stable, normative for M1)

| Code | cls | Carries | Raised when |
|---|---|---|---|
| `unauthorized` | validation | — | missing/invalid/expired token (HTTP 401 / WS 1008) |
| `bad_origin` | validation | `found` (the Origin, clipped ≤ 256) | Origin not in the allowlist (§4.2) |
| `invalid_request` / `field_missing` / `field_unexpected` / `field_type` / `field_value` | validation | `path`, `found`/`expected` | strict shape failure of any HTTP/WS payload |
| `session_conflict` | conflict | `activeSessionId`, `lastActivityAt` | a different `sessionId` while an active session exists (§5.1) |
| `session_not_found` | not_found | `sessionId` | WS upgrade / log query for an unknown session |
| `session_required` | validation | — | a browser-origin command from a non-registered session (§6.1) |
| `ws_token_invalid` | validation | — | malformed/expired `wsToken` (§4.3) |
| `ws_token_replayed` | validation | — | second use of a `wsToken` (§4.3) |
| `unknown_event` | validation | `type` (clipped ≤ 64) | WS frame with an unknown `type` (§7) |
| `protocol_error` | validation | — | malformed WS frame (§5.2) |
| `project_not_found` | not_found | `projectId` | as in commands.md |
| `project_unavailable` | unavailable | `reason` (a workspace.md §11 code), `holder?`, `details?` | as in commands.md |
| `play_already_active` | conflict | `activePlaySessionId` | second concurrent play for the project (§10.1) |
| `play_not_found` | not_found | `playSessionId` | stop/screenshot/diagnostics for an unknown or stopped play |
| `session_unavailable` | unavailable | `playSessionId?`, `hint` | no registered browser / owner WS not connected / play not yet `presented`, for a live action (§10.4, §12) |
| `screenshot_timeout` | unavailable | `relayId` | no `screenshot.ack` within 10 s (§12) |
| `diagnostics_timeout` | unavailable | `relayId` | no `play.diagnostics.ack` within 10 s |
| `relay_failed` | unavailable | `code?` (the preview/bridge cause) | the editor could not complete a relay (§7.2) |

Workspace codes (workspace.md §11) and command codes (commands.md §5.4)
surface through these operations unchanged.

### 11.4 Session listing and log (M1 MCP/browser operations)

- `GET /api/v1/sessions?projectId=<id>` →
  `{ ok: true, sessions: [ { sessionId, projectId, connId, connected,
  lastActivityAt, playSessionId? } ] }` — at most **20** sessions (M1 has
  ≤ 1 browser session per project; the bound covers admin/other kinds),
  bounded by construction.
- `GET /api/v1/sessions/:sessionId/log?limit=32` →
  `{ ok: true, sessionId, total, entries: [ … ≤ limit … ] }` (§11.1).
- Both require the project's authoring token or admin scope. These are the
  operations the MCP "session listing" and "bounded diagnostics" categories
  route into (charter §7; packet 11).

### 11.5 M1 constants (normative)

| Constant | Value |
|---|---|
| wsToken TTL | 60 s |
| ping period / silent-drop | 20 s / 60 s |
| WS in-frame bound (default / `screenshot.ack`) | 64 KiB / 1.5 MiB |
| WS out-frame bound | 1 MiB |
| HTTP body bounds (in / out) | 1 MiB / 1 MiB (model limits keep real payloads far below — §11.6) |
| screenshot relay timeout | 10 s |
| diagnostics relay timeout | 10 s |
| stop-ack timeout | 5 s |
| preview-present timeout | 15 s |
| play inactivity TTL (backend record) | 30 min |
| protocol-error tolerance | 10 / 60 s |
| session log ring | 128 entries |
| runtime diagnostics ring (runtime.md §8) | 32 entries |
| screenshot image bound | ≤ 1 MiB PNG; width ≤ `maxWidth` (default 1024, max 2048) |
| diagnostics relay payload | ≤ 16 KiB JSON |

### 11.6 Boundedness argument

Every session payload is bounded: the full scene ≤ 1024 entities × bounded
fields (project-model §10.4) ≪ 1 MiB; `change` data is bounded by the same
limits (a `deleteEntity` carries ≤ 1024 short IDs); the snapshot ≪ 1 MiB;
logs and error rings are capped; the screenshot is capped and downscaled
(the preview captures at ≤ `maxWidth` — packet 10/11 implements the
downscale). No session data path returns an unbounded document (charter §7).

## 12. Screenshot and diagnostics relay (normative chain)

1. A caller (MCP tool or admin/browser operation) requests
   `POST /api/v1/projects/:projectId/play/:playSessionId/screenshot`
   (body `{ "maxWidth": 1024 }`, optional, 256–2048) or
   `…/diagnostics` (body `{}`).
2. The backend verifies: the play session exists (unknown or already
   `stopped` ⇒ `play_not_found`), is `presented` (still `active`/`stopping`
   ⇒ `session_unavailable`, hint: the preview is not ready), and the owner WS
   is connected (else `session_unavailable`).
3. The backend allocates a `relayId` and sends WS `screenshot.request` /
   `play.diagnostics.request` to the owner session.
4. The editor relays bridge `tl.screenshot.request` /
   `tl.diagnostics.request` to the preview (§13) — and **only** to the
   verified preview (§13.3).
5. The preview: screenshot — capture the current frame's canvas, downscale
   to ≤ `maxWidth`, `canvas.toDataURL("image/png")` (same-origin canvas —
   the preview draws no cross-origin images, so the canvas is never
   tainted); diagnostics — compose the runtime core block (runtime.md §8)
   and the adapter block (§8 there) and post the result.
6. The editor forwards the exact preview result as WS `screenshot.ack` /
   `play.diagnostics.ack` (a failed relay ⇒ `ok: false,
   error.code: "relay_failed"`, §7.2).
7. The backend answers the caller:

```json
{ "ok": true, "playSessionId": "play-…", "snapshotId": "demo-0001@r12",
  "revision": 12, "width": 1024, "height": 576, "dataUrl": "data:image/png;base64,…" }
```

  — **every screenshot response carries the play's `snapshotId` and
  `revision`**, so agents can distinguish stale observations (charter §7).
  On timeout: `screenshot_timeout` / `diagnostics_timeout` (cls
  `unavailable`).
- A screenshot request when **no play is active** at all ⇒ `play_not_found`
  (structured, not an error dump); when a play exists but no browser is
  connected ⇒ `session_unavailable` (§10.4). The charter's
  "session-unavailable error" is this pair of structured outcomes.

## 13. Separate-origin preview and message bridge

### 13.1 Isolation

- The preview page is served from `O_P` (§2) — a **different origin** from
  the authoring page. The editor embeds it as an `<iframe>` (M1 mechanism;
  a new tab works identically — the bridge is the same; the editor holds
  the `window` handle either way). The iframe `src` is
  `<playBase>?play=<playSessionId>`.
- The preview runs the play-preview bundle: the runtime + three-adapter
  (runtime.md §9: same runtime as play mode; dependencies.md §4 bundle
  graph). It is **useless standalone**: without the checked bridge from the
  verified authoring origin it has no snapshot — the snapshot is never
  fetched from the backend and never embedded in the page.

### 13.2 Page config (the only dynamic content)

The preview HTML (a backend-served template) injects exactly:

```js
window.__thirdlightPreview = { v: 1, authoringOrigin: "<O_A exact>" };
```

plus the static bundle script tag (`./preview.js`, relative). **No tokens,
no API URLs, no credentials** in the page or the bundle (packet 10
verifies). `authoringOrigin` is configuration, not a secret. The preview
reads the expected `playSessionId` from its own `?play=` query at load; a
missing/unrecognized parameter ⇒ the preview shows a static "no active
play" notice and processes no bridge messages.

### 13.3 Origin and source checks (normative)

- **Editor → preview:** `iframe.contentWindow.postMessage(msg, O_P)` — the
  exact `targetOrigin` string: the configured `previewOrigin`, which the
  editor obtains as the origin part (scheme + host + port, without the
  trailing slash) of `playBase` from the play-start result (§10.1); **never
  `"*"`**.
- **Editor receives:** only messages where `event.origin === O_P` **and**
  `event.source === iframe.contentWindow`.
- **Preview receives:** only messages where `event.origin ===
  authoringOrigin` (the injected config) **and** `event.source` equals the
  window that sent the accepted handshake (the preview stores that source
  handle at handshake time; **before a completed handshake the preview
  processes nothing**).
- Any other origin, source, or type: **dropped and counted** (the preview's
  internal error counter, visible in its diagnostics relay result); never
  processed, never answered. No wildcard origins anywhere in the bridge.

### 13.4 Session handshake (normative sequence)

1. The editor's iframe `load` event fires and the editor holds the retained
   `play.started` snapshot (§7.1 one-shot delivery; if it has not arrived
   yet, the editor waits — the 15 s present timeout bounds this) ⇒ the editor
   sends `tl.handshake` (carrying `nonce`, a fresh 16-hex value, and the
   `demo` flag from the play-start result).
2. The preview verifies origin/source (§13.3) and `playSessionId` (must
   equal its `?play=` value) ⇒ replies `tl.handshake.ack` (echoing
   `nonce`). A nonce mismatch on a later `tl.snapshot` ⇒ the preview
   drops it (stale/duplicate handshake defense).
3. The editor sends `tl.snapshot` — **exactly once per completed
   handshake**, carrying the full runtime snapshot document received in
   the `play.started` WS event (the owner editor always receives it, §10.1 —
   whether the play was started by its own button or by MCP; the play-start
   HTTP result carries only the identifiers). The editor retains this
   snapshot for the play's duration and re-sends it after a preview reload
   (§13.6).
4. The preview deep-freezes the snapshot, `instantiateRuntime`
   (modules per the `demo` flag: `["thirdlight.demo:box-motion"]` or `[]`,
   runtime.md §3.1), builds the adapter (the WebGL 2 renderer path,
   decision 0001 §3), and `start()`s.
5. The preview posts `tl.ready` (carrying `snapshotId`, `revision`) ⇒ the
   editor sends WS `play.preview.ready` (the backend marks `presented`).
6. A runtime failure at any step ⇒ the preview posts `tl.error` (the
   runtime.md code) ⇒ the editor sends WS `play.preview.failed`; the play
   session terminates (`play.stopped` with reason `preview_failed`
   immediately, or `preview_timeout` at the 15 s bound).

### 13.5 Message allowlist (normative, exhaustive for M1)

All messages are strict JSON with `v: 1` (the M1 discriminator); unknown
fields are rejected by the `protocol` package validators; anything outside
this table is dropped (§13.3). No message type carries credentials;
`tl.snapshot` carries only the snapshot document.

**Editor → preview** (`targetOrigin = O_P`):

| Message | Fields |
|---|---|
| `tl.handshake` | `v, playSessionId, nonce, demo (bool)` |
| `tl.snapshot` | `v, playSessionId, nonce, snapshot (runtime.md §2 document)` |
| `tl.play.stop` | `v, playSessionId` |
| `tl.screenshot.request` | `v, playSessionId, relayId, maxWidth?` |
| `tl.diagnostics.request` | `v, playSessionId, relayId` |
| `tl.ping` | `v` |

**Preview → editor** (`targetOrigin = O_A`):

| Message | Fields |
|---|---|
| `tl.handshake.ack` | `v, playSessionId, nonce` |
| `tl.ready` | `v, playSessionId, snapshotId, revision` |
| `tl.stopped` | `v, playSessionId` |
| `tl.screenshot.result` | `v, playSessionId, relayId, ok, dataUrl?, width?, height?, error?` |
| `tl.diagnostics.result` | `v, playSessionId, relayId, ok, diagnostics? (≤ 16 KiB), error?` |
| `tl.error` | `v, playSessionId, code (a runtime.md code), message? (≤ 256)` |
| `tl.pong` | `v` |

### 13.6 Reload, refresh, and orphaning (normative behavior)

- **Preview reload/refresh:** the iframe re-runs the handshake; the editor
  re-sends the retained snapshot (§13.4 step 3). Play state (runtime)
  resets to a fresh instance — M1 has no state-preserving reload
  (runtime.md §10).
- **Editor page reload:** the editor re-attaches its session (full state,
  §5.1). A running play's owner WS is gone: the backend delivers the
  `session_lost` stop path (§10.3). The preview tab keeps rendering (it has
  no backend dependency) until the user closes it — **the documented M1
  bound: there is no remote kill switch for an orphaned preview**; only the
  backend record is bounded (TTL). The next play start for the project
  allocates a fresh `playSessionId`.
- **Backend restart:** all sessions, play records, and WS channels are gone
  (in memory — workspace.md §6/§9); browsers re-attach on next action
  (full state resync, §8). Any running preview keeps rendering the last
  snapshot until closed (same orphan bound).
- **Repeated play disposal (packet 10 check):** start → stop → start → stop
  cycles must each dispose the runtime/adapter cleanly (runtime.md §3.4) —
  no leaked loops or GPU resources across cycles.

### 13.7 Development / deployment origin configuration (normative shape; packet 09/13 implements)

```text
# backend configuration (packet 09 implements; values are deployment facts)
authoringOrigin:   "http://127.0.0.1:8501"   # dev      (deploy: "https://thirdlight.<lan>.local")
previewOrigin:     "http://127.0.0.1:8502"   # dev      (deploy: "https://play.thirdlight.<lan>.local")
authoringBind:     0.0.0.0:8501              # LAN-reachable in dev (decision 0001 §7)
previewBind:       0.0.0.0:8502
authoringOrigins:  ["http://127.0.0.1:8501", "http://<lan-ip>:8501"]   # exact browser Origin values, no wildcards
editorStaticDir:   <repo>/dist/editor
previewStaticDir:  <repo>/dist/preview
exportRoot:        /home/dadmin/thirdlight/exports
```

- **Development:** two localhost **ports** on the same host (different
  origin by port). If the desktop browser reaches the server by LAN IP
  instead of `127.0.0.1`, that exact origin string must be added to
  `authoringOrigins` (no suffix matching).
- **Deployment:** a reverse proxy with two hostnames and TLS termination
  (decision 0001 §7 — WebGPU requires a secure context; the WebGL 2
  baseline must remain fully sufficient either way, so TLS is a later
  requirement, not an M1 blocker). The configured origins must equal
  exactly what the browser reports as `event.origin` / the `Origin` header
  (scheme + host + port, no trailing slash).
- `authoringOrigin`/`previewOrigin` are used verbatim as the bridge
  `targetOrigin`/`event.origin` comparison strings (§13.3) and in the
  preview page config (§13.2). Changing them is a configuration change +
  backend restart (M1: no dynamic origin updates).
- The editor/preview bundles are pre-built static files (workspace build
  script, dev context — dependencies.md §7: esbuild is a dev tool + an
  `exporter` dependency, not a backend runtime build); the backend serves
  the configured directories. Missing bundle at startup ⇒ structured
  startup error (build required first), recorded in the bounded log.

## 14. What is deliberately not in M1 (normative non-goals)

- No collaborative editing; one active authoring session per project plus
  the external harness (decision 0001 §2).
- No server-push to MCP clients (the harness observes via responses/queries;
  its transport semantics are decision 0001 §5).
- No operator/admin operations in the M1 MCP tool set (create/maintenance/
  export are admin-scope HTTP only — §6.3, workspace.md §11).
- No preview → authoring write-back of any kind; no "apply play state"
  operation (charter §6 — a later explicit operation).
- No remote kill switch for orphaned previews (§13.6); no preview
  keep-alive channel to the backend (the preview is backend-free by design).
- No hosting of untrusted code in the preview (M1 ships the engine's own
  built-in bundle only; user-script execution is deferred — runtime.md
  §7.3).
- No token refresh/rotation (owner re-issues; packet 09).
- No mobile/tablet session targets (desktop authoring, decision 0001 §1).
- No partial resync, no event log replay, no WS multiplexing beyond the
  catalog in §7.

## 15. Change rules

- After Gate A acceptance, changes to ID syntaxes, endpoint paths, event
  names/shapes, the bridge allowlist, origin policy, or the §11.5 constants
  are reviewed contract diffs (AGENTS.md: accepted contracts are binding).
- Adding a WS event or bridge message requires updating §7/§13.5 **and**
  the `protocol` package's strict validators (packet 09) in the same review.
- The exhaustive-catalog rule (normative): a message/event not in §7/§13.5
  is invalid by definition; silence is not a protocol.