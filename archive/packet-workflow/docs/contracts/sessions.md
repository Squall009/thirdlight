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
- The **authoring content-byte reads** (new §16) and the **immutable
  play-content locator** the preview frame loads its artifacts from (new §17).
- The **versioned bridge (v2)** message set and the bounded **input-exercise
  relay** for MCP (new §18).
- The M2 **gesture snapping** increments (this contract's §9 extension).

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
  deployment — decision 0001 §6). The **preview listener serves the static
  preview page** (a small HTML template + the preview bundle) **and, in M2,
  the immutable play-content locator routes of §17** (`/play/…`,
  `/play-content/<contentId>/…`). It still exposes **no authoring API
  endpoints, no WS, and no authenticated channel**: the locator routes return
  only completed immutable artifacts for one play session, carry no authoring
  credential, and are not an `/api/v1` surface. The preview frame's only
  inputs are the static page, the injected config (§13.2), the locator
  artifacts (§17) and bridge messages from the verified authoring origin
  (§13.3–§13.5).
- **The locator identifier is a capability, not a credential, and is redacted
  in logs** (§17.4). It grants reads of one immutable artifact set only and is
  excluded from exports (export.md §5.4.1).
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
| `contentId` | 43-char base64url (32 CSPRNG bytes, no padding: `^[A-Za-z0-9_-]{43}$`) | **server** | one play artifact set; `PLAY_CONTENT_TTL` 900 s (+ 60 s grace, §17.3) |
| `requestId` | `req-` + 32 hex (commands.md §3) | client | the dedup lease (commands.md §6) |

- The client generates `sessionId` once per editor page (per project) and
  reuses it on every re-attach — that is what makes reconnect
  re-association possible (§8.4).
- `playSessionId` appears in the preview URL query (`?play=<id>`, §13.2);
  it grants nothing by itself (the preview origin has no API), and the
  snapshot reaches the preview only via the checked bridge from the verified
  authoring origin.
- `contentId` appears in the preview URL query (`?content=<id>`, §13.2) and in
  the play-start result (§10.1). It is a **bearer capability** for immutable
  reads only: it is never logged verbatim (§17.4), never accepted as an
  authoring credential, and never included in an export.
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
  "workspace": { "writePaused": false },
  "content": { "assets": [ "…" ], "prefabs": [ "…" ], "behaviors": [ "…" ] } }
```

- `scene` is the **full normalized scene document** (project-model §8) at
  the current revision; `manifest` is the normalized manifest. This full
  state is the initial projection and the resync payload (§8).
- `content` is the **additive, v2-only bounded content projection** (§19.4):
  summary pages of `queryAssets`/`queryPrefabs`/`queryBehaviors` at the same
  revision — never definitions, declarations, versions, metrics or bytes. It
  is absent for a v1 envelope. M1 clients ignore an unknown top-level field
  (verified), so the addition is backward compatible.
- `workspace` is exactly the commands.md §5.6 query `workspace` object:
  `{ writePaused: false }` when clean; while an external
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
  **M4 (C65-7):** the `origin.kind` value set is
  `"browser" | "mcp" | "admin" | "template"` — `template` is minted only
  by `createProjectFromTemplate` (`clientId: "<templateId>@<version>"`),
  never by a client request; the audit records show the starter replay as
  template-originated commands.
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
POST /api/v1/admin/projects/:projectId/migrate-copy-v3   migrateProjectCopyV3 (v2→v3)
POST /api/v1/admin/projects/:projectId/export        exportProject (export.md)
POST /api/v1/admin/templates/projects                createProjectFromTemplate { projectId, name, templateId } (workspace.md §8.4, M4 C65-3)
GET /api/v1/admin/health                            admin health diagnostic envelope (M4 C67-2: { ok, v: 1, ts, backendId, engineVersion, process, workspace, sessions, play, content, errors, truncated? }; total ≤ 32 KiB; `blocked` ≤ 100; `errors` ≤ 32 — the §11.5 scan/ring bounds re-used; admin scope, read-only; redacted: no credentials, no absolute paths, no content bytes)
```

**CC-48-2 (promoted at Gate L):** the v2→v3 copy operator has its own admin
route, `POST /api/v1/admin/projects/:projectId/migrate-copy-v3`, with body
`{ "newProjectId": <id> }`; it returns the §16.5.2 reported object on success or
the §16.8 error set (`migration_version_unsupported`,
`migration_source_invalid`, `migration_destination_exists`,
`migration_marker_conflict`, `path_rejected`, `content_publish_failed`).
Refusals write nothing. The accepted v1→v2 `migrateProjectCopy` operator has no
HTTP route (packet 09/12 exposed the workspace.md §11 operator commands listed
above only).

- They are **never** browser editor commands and, in M1, **not MCP tools**
  (the charter §7 M1 tool categories do not include project creation,
  maintenance, or export; workspace.md §11 records the same bound). The
  harness reaches them over plain HTTP with the admin token or by direct
  operator action (decision 0001 §5 option 2).
- Result/error shapes: the workspace.md §11 result objects and codes,
  wrapped in the standard `{ ok, … }` / `{ ok: false, error }` envelope.

**Template creation is admin-scoped (M4, C65-6):** `POST
/api/v1/admin/templates/projects` requires the admin token (the
operator's). A project-scoped token (scope `authoring:<projectId>`) CANNOT
create projects — a project-scoped MCP token gains no global admin
privilege (m4-plan.md §2.1). The editor UI's creation flow (packet 74)
uses the deployment's configured admin token (a deployment value, never
logged); without one, the creation UI is disabled with a bounded message.
Browser creation and MCP creation route into the same workspace operator
(templates.md §5) — there is no second creation path.

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
| `input.request` | `{ requestId, frames: [{ stepOffset, moveX, jump }] }` — 1–`maxRelaySteps` (600) strictly ascending step-indexed semantic frames, body ≤ 16 384 B | the §18 bounded input-exercise relay forwards the caller's frames to the owner editor, which relays them to the preview (`tl.input.request`); packet-35 contract-change request C35-8 (the §7 catalog predates §18) |
| `game.control.request` | `{ relayId, command, expectedRunId? }` — `command` ∈ `{start, replay, mute, unmute}`; `expectedRunId` shape `<snapshotId>#<replayEpoch>`; body ≤ 4 KiB | a §20 control request is forwarded to the owner editor, which relays it to the preview |
| `game.observe.request` | `{ relayId, timeoutMs }` — 250–15 000; body ≤ 4 KiB | a §20 observation request is forwarded to the owner editor (packet-42 addition; the §7 catalog predates §20) |
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
| `input.result` | `{ requestId, ok, appliedFromStep?, appliedToStep?, error? }` — on `ok: true` both step bounds are present; on failure `error.code` is one of the §18 codes | the preview's `tl.input.result` relayed back by the owner editor, resolving the §18 input-exercise request (packet-35 C35-8) |
| `game.control.ack` | `{ relayId, ok, result?, error? }` — on `ok: true` the §20 control result (≤ 4 KiB); on failure `error.code` is one of the §20 codes | the preview's `tl.game.control.result` relayed back by the owner editor (never fabricated) |
| `game.observe.ack` | `{ relayId, ok, result?, error? }` — on `ok: true` the §20 observation result (≤ 16 KiB); on failure `error.code` is one of the §20 codes | the preview's `tl.game.observe.result` relayed back by the owner editor |

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
- **Content projection (M2, additive).** The full state additionally carries
  the bounded `content` object of §19.4 (`{ assets, prefabs, behaviors }`
  summary pages at the same revision). It is rebuilt on every full state
  (establish/re-attach/resync) and updated from the same `mutation.applied`
  `change` records the scene uses — `change.next` carries the full content
  record, so the summary fields are recomputed locally. Like the scene
  projection, a content gap is resolved by a fresh full state, never by a
  partial merge; `mutation.applied` never carries bytes.
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

**Snapping (M2, local preview only; normative).** Snapping is applied to the
local preview transform only; it changes no server message and adds no command:

| Aspect | Rule |
|---|---|
| Translate | increment `SNAP_TRANSLATE_M = 0.25 m`, independently per world axis in the scene's Y-up/right-handed metre space (project-model §2); the **gesture delta** is snapped, not the absolute position, so repeated moves do not accumulate drift |
| Rotate | increment `SNAP_ROTATE_DEG = 15°` about each accumulated gizmo axis (yaw about +Y, pitch about +X); each accumulated gesture angle is snapped, the quaternion is composed from the snapped angles and re-normalized (project-model §12.2 quaternion rule) |
| Scale | increment `SNAP_SCALE = 0.25` on the uniform scale factor; result clamped to `[SCALE_MIN 0.01, SCALE_MAX 100]` (a snap never produces a zero/negative/non-finite scale) |
| Rounding | `snapped = clamp(round(value / increment) * increment)` with round-half-away-from-zero, then quantized to `1e-4` before it is displayed or committed (the committed value is the quantized value) |
| Coordinate space | world-space axis-aligned deltas for translate, the accumulated gizmo axes (yaw about +Y, pitch about +X) for rotate, the entity's uniform scale for scale; no parent-space or local-space snapping in M2 |
| Disable for one gesture | holding `Shift` during the gesture disables snapping for that gesture only (local UI state; **no persistent setting, no project field, no localStorage/backend write**) |
| Commands | **zero** commands during the drag; snapping never changes the number of commands; on release **exactly one** `setTransform` carrying the snapped, quantized final values with `expectedRevision = baseRevision`; on cancel **none** |
| Conflict | unchanged §9: at most one automatic re-issue, then the conflict is surfaced; a snapped value is never silently re-snapped or re-rounded on re-issue |

`SNAP_TRANSLATE_M`, `SNAP_ROTATE_DEG`, `SNAP_SCALE`, `SCALE_MIN`, `SCALE_MAX`
and the `1e-4` quantum are fixed M2 constants (acceptance A08 and the packet-27
tests reference their exact values); there is no snapping setting in the
project document, in the backend configuration or in `localStorage`. Snapping
is a gesture option, never a second authority: nothing about it is observable
to other clients before the single release commit.

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
  "snapshotId": "demo-0001@r12", "revision": 12, "demo": true, "expiresAt": "…",
  "playContent": { "contentId": "<43-char base64url>", "buildId": "<64 hex>",
    "path": "/play-content/<contentId>/", "manifestPath": "manifest.json",
    "expiresAt": "…" } }
```

plus the WS event `play.started` (with the full `snapshot`) delivered to the
**owner editor**. The editor constructs the preview URL as
`<playBase>?play=<playSessionId>` (§13.1/§13.2); with M2 content it builds the
iframe `src` from the locator instead:
`<playBase><path>?play=<playSessionId>&content=<contentId>` (§17.2). Both
identifiers are quoted from this result; neither is invented client-side.
`playContent` is present for a snapshot with assets or source-bearing
behaviors; for an M1-style snapshot it is still present (the locator serves
the manifest-only artifact set). The snapshot in the
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

### 10.5 Play-content readiness, staleness and failure

- The play record gains one derived field: `buildId` (the immutable runtime-
  content manifest's `buildId`, delivery §2). It is fixed at start with
  `revision`/`snapshotId` and never changes for the play session (§10.2's
- **The build is a manifest v2 capture.** `buildId` identifies the immutable
  runtime-content manifest (delivery.md §2); for an M3 build that manifest also
  binds the resolved six-key settings, the frozen `content.game` block and the
  media identity (cue/role resolution) by digest. Ready additionally requires
  those blocks to match the served bytes (S42-10). A later settings/game/media
  edit changes the authoring revision and therefore a *fresh* capture's
  `snapshotId`/`buildId`; it never changes this play's (delivery.md §2.6/§3.3).
  freeze rule).
- **Ready is truthful:** `presented` (the existing `play.preview.ready` ack)
  is sent only after the preview confirms the manifest `buildId`, all declared
  asset reads and the physics initialization and the runtime instantiation
  (delivery §7). A load that is still running or that failed never
  produces `presented`; the failure carries the load phase.
- **Stale capture/build:** a play whose captured `snapshotId`/`buildId` no
  longer matches the requested one (e.g. a reload against a newer play) is
  reported as stale, never silently served: unknown/stopped ⇒
  `play_locator_invalid`, expired ⇒ `play_locator_expired`, build missing ⇒
  `play_build_unavailable` (§17.2).
- **Cancellation:** a stop requested while the preview is still loading takes
  the existing §10.3 stop path; the preview must abort in-flight artifact
  reads and dispose and the backend must not report `presented` afterwards.
- **No binary in WS:** neither the full-state frame nor `play.started`,
  `mutation.applied` or `change` carries GLB bytes, compiled behavior bytes or
  source text; the preview loads them from the locator (delivery §7).

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
| `project_unavailable` | unavailable | `reason` (a permitted `project_unavailable.reason` value — workspace.md §11: its code table plus the §4.3 load-pipeline codes), `holder?`, `details?` | as in commands.md |
| `play_already_active` | conflict | `activePlaySessionId` | second concurrent play for the project (§10.1) |
| `play_not_found` | not_found | `playSessionId` | stop/screenshot/diagnostics for an unknown or stopped play |
| `session_unavailable` | unavailable | `playSessionId?`, `hint` | no registered browser / owner WS not connected / play not yet `presented`, for a live action (§10.4, §12) |
| `screenshot_timeout` | unavailable | `relayId` | no `screenshot.ack` within 10 s (§12) |
| `diagnostics_timeout` | unavailable | `relayId` | no `play.diagnostics.ack` within 10 s |
| `relay_failed` | unavailable | `code?` (the preview/bridge cause) | the editor could not complete a relay (§7.2) |
| `play_locator_invalid` | not_found | — | malformed/unpaired `contentId`/`playSessionId` on a locator route (§17.2) |
| `play_locator_expired` | unavailable | `expiresAt` | the locator TTL elapsed (§17.3) |
| `play_content_not_ready` | conflict | `phase` | the artifact set is not complete / a load phase failed (§10.5, §17.2) |
| `play_build_unavailable` | unavailable | `reason`, `snapshotId` | no successful build for the requested `buildId` (build failure preserves the previous artifact) |
| `content_frame_invalid` | validation | `path`, `found`/`expected` | malformed binary upload frame (bad `X-Thirdlight-Offset`, wrong total, truncated frame) |
| `job_not_found` | not_found | `jobId` | an unknown content job |
| `job_expired` | unavailable | `jobId` | a late/expired job result |
| `input_relay_conflict` | conflict | `playSessionId` | a relay while physical input is engaged / a second relay (§18.3) |
| `input_relay_limits_exceeded` | validation | `limit`, `found` | relay frames/body over a bound (§18.1) |
| `input_relay_timeout` | unavailable | `requestId` | no `tl.input.result` within 10 s (§18.3) |
| `scan_forbidden_content` | internal | `hits` (≤ 4) | a format-aware scan found forbidden content in a built artifact |

`blob_missing`, `blob_corrupt`, `path_rejected`, `stage_not_found`,
`stage_expired`, `stage_limits_exceeded` and `import_rejected` are the accepted
workspace/content-storage codes surfaced unchanged by the new routes
(`import_rejected` with cls `validation`, HTTP 400). The resulting status is the
§11.2 class mapping except for the recorded route-level overrides:
`unauthorized` ⇒ 401 (§4.1), `bad_origin` ⇒ 403 (§4.2), and the §16.1 asset-byte
read's `blob_corrupt` ⇒ 500 (`internal`) and
`asset_not_found`/`asset_version_not_found` ⇒ 404 (`not_found`). Every other code
keeps the §11.2 class mapping.

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

### 11.5 Constants (normative; M1 rows unchanged, M2 rows added)

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
| `PLAY_CONTENT_TTL` / `PLAY_CONTENT_GRACE` | 900 s / 60 s |
| `contentId` length | 43 base64url chars (32 CSPRNG bytes) |
| play artifact set cap / single artifact cap | 512 MiB / 32 MiB |
| asset byte-read response cap | 32 MiB |
| upload frame cap / stage cap | 1 MiB / 32 MiB |
| input relay max frames / max body / ack timeout | 600 / 16 KiB / 10 s |
| bridge v2 message cap (non-snapshot) / `tl.load.progress` cap | 64 KiB / 1 KiB |
| manifest document cap | 256 KiB |
| game control relay: request body cap / result cap | 4 KiB / 4 KiB |
| game observation relay: request body cap / result cap / timeout | 4 KiB / 16 KiB / 250–15 000 ms (default 5 000) |
| game observation events | ≤ 32 (`MAX_GAME_EVENTS`, `gameplay.md` §6) |
| admin health envelope (M4 C67-2) | ≤ 32 KiB total; `blocked` ≤ 100 entries (clip + `truncated: true`); `errors` ≤ 32 (the runtime diagnostics ring) — no secrets, no absolute paths, no content bytes |

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
- **Every** play `<iframe>` embedding carries `allow="gamepad"` — the editor
  preview wrapper and the M3 locator shell alike (C30-5, confirmed and extended by
  packet 42's C38-2). The `gamepad` Permissions-Policy feature defaults to `*`, so
  the attribute is harmless today, but it is required hardening once any
  `Permissions-Policy` header exists: a policy that does not delegate `gamepad`
  denies `navigator.getGamepads()` in the cross-origin frame. Packet 38 measured
  the failure directly: with `allow="gamepad 'none'"`, `navigator.getGamepads()`
  throws a `SecurityError` (`acceptance/evidence-m3/38/raw/summary.json`), so the
  gamepad half of the acceptance rows is unreachable without the attribute. If a
  `Permissions-Policy` header is added, it must delegate `gamepad`; the attribute
  stays required either way.

### 13.2 Page config (the only dynamic content)

The preview HTML (a backend-served template) injects exactly:

```js
window.__thirdlightPreview = {
  v: 2,
  authoringOrigin: "<O_A exact>",
  playSessionId: "<from ?play=>",
  contentId: "<from ?content=>",
  manifestPath: "./manifest.json"
};
```

plus the static bundle script tag (`./preview.js`, relative). **No tokens,
no API URLs, no credentials** in the page or the bundle (packet 10
verifies). `authoringOrigin` is configuration, not a secret; `contentId` is a
read-only artifact capability and is redacted in logs (§17.4). The preview
reads the expected `playSessionId`/`contentId` from its own URL query at load;
a missing/unrecognized parameter, or a URL whose `contentId` does not match
the served shell, ⇒ the preview shows a static "no active play" notice and
processes no bridge messages (it never falls back to another locator).

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

All messages are strict JSON with `v: 2` (the M2 bridge discriminator); a
`v: 1` message from an M2 preview is rejected exactly like an unknown field.
Unknown
fields are rejected by the `protocol` package validators; anything outside
this table is dropped (§13.3). No message type carries credentials;
`tl.snapshot` carries only the snapshot document.

**Editor → preview** (`targetOrigin = O_P`):

| Message | Fields |
|---|---|
| `tl.handshake` | `v, playSessionId, nonce, demo (bool)` |
| `tl.handshake` (v2) | `v, bridgeVersion: 2, playSessionId, nonce, demo, contentId, buildId` |
| `tl.snapshot` | `v, playSessionId, nonce, snapshot (runtime.md §2 document)` |
| `tl.playContent.expect` | `v, playSessionId, contentId, buildId` |
| `tl.input.request` | `v, playSessionId, requestId, frames (1–600 ActionFrame values, ascending stepOffset)` |
| `tl.game.control` | `v, playSessionId, relayId, command, expectedRunId?` |
| `tl.game.observe` | `v, playSessionId, relayId, timeoutMs` |
| `tl.play.stop` | `v, playSessionId` |
| `tl.screenshot.request` | `v, playSessionId, relayId, maxWidth?` |
| `tl.diagnostics.request` | `v, playSessionId, relayId` |
| `tl.ping` | `v` |

**Preview → editor** (`targetOrigin = O_A`):

| Message | Fields |
|---|---|
| `tl.handshake.ack` | `v, playSessionId, nonce` |
| `tl.ready` | `v, playSessionId, snapshotId, revision` |
| `tl.ready` (v2) | `v, playSessionId, snapshotId, revision, buildId, contentDigest, stepIndex` |
| `tl.load.progress` | `v, playSessionId, phase ∈ {shell, manifest, assets, behaviors, runtime}, loadedBytes, totalBytes` |
| `tl.input.result` | `v, playSessionId, requestId, ok, appliedFromStep?, appliedToStep?, error?` |
| `tl.game.control.result` | `v, playSessionId, relayId, ok, result?, error?` |
| `tl.game.observe.result` | `v, playSessionId, relayId, ok, result?, error?` |
| `tl.stopped` | `v, playSessionId` |
| `tl.screenshot.result` | `v, playSessionId, relayId, ok, dataUrl?, width?, height?, error?` |
| `tl.diagnostics.result` | `v, playSessionId, relayId, ok, diagnostics? (≤ 16 KiB), error?` |
| `tl.error` | `v, playSessionId, code (a runtime.md code or a §11.3 delivery code), phase?, message? (≤ 256)` |
| `tl.pong` | `v` |

**Payload bounds (v2).** Every bridge message is ≤ 64 KiB except
`tl.snapshot` (≤ 1 MiB, unchanged) and `tl.screenshot.result` (≤ 1.5 MiB,
unchanged); `tl.load.progress` ≤ 1 KiB; `tl.input.request` ≤ 16 KiB with ≤ 600
frames; `tl.game.control`/`tl.game.control.result` ≤ 4 KiB;
`tl.game.observe.result` ≤ 16 KiB. **No message carries GLB bytes, compiled
behavior output bytes, audio bytes/base64, an authoring token or a `contentId`
capability**, and no bridge message is a second mutation or storage path
(delivery §5.4/§7). A `tl.snapshot` for a content-bearing snapshot references
assets by `assetId`/version only; audio is referenced by `assetId` only
(C41-5).

### 13.6 Reload, refresh, and orphaning (normative behavior)

- **Preview reload/refresh:** the iframe re-runs the handshake; the editor
- A reload constructs a **fresh `game-host`** from the re-sent snapshot and the
  same manifest/artifact set: the host holds no cross-load state, and a stale
  run/menu latch cannot survive the reload (delivery.md §4.2/§5.3).
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
engineRoot:        /home/dadmin/projects/thirdlight   # optional; engine tree (packages/ + node_modules/)
# env: THIRDLIGHT_ENGINE_ROOT (executable entry, packet 13)
```

- **`engineRoot` (optional, U-4 ACCEPT — owner pre-approval (autonomous M2
  build instruction, 2026-09-18); final manual review pending).** The export
  route uses it for output-target containment and the export.md §5.4.1
  reference-build identity paths. Absent/empty ⇒ the export route fails closed
  with a structured `unavailable` result; no other route reads it, and no
  M1 behavior changes.

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
- Adding a locator route, changing `PLAY_CONTENT_TTL`/the locator's read-only
  scope, weakening the no-listing/no-traversal/redaction rules, changing a
  bridge message or its bound, or changing a snapping constant is a reviewed
  contract diff (facts and fixtures reference their exact values).
- The v2 bridge discriminator (`v: 2`) and the new messages require the
  `protocol` package's strict validators in the same review (the
  exhaustive-catalog rule: a message not in §13.5 is invalid by definition).
- The input relay is **not** a command path and must never mutate authoring
  state; giving it write authority is a contract change, not a feature.
- The manifest v1/v2 rules, the block-digest preimage and the `capturedAt`
  reproducibility rule are contract material: adding a required manifest key,
  changing a digest rule or normalizing an extra field is a reviewed diff
  (`delivery.md` §2/§11).
- The preview CSP token set (including `'wasm-unsafe-eval'`) and the
  `allow="gamepad"` attribute are security material: relaxing either — or
  replacing `'wasm-unsafe-eval'` with `'unsafe-eval'` — is a reviewed diff, never
  a convenience change (S42-4/S42-8).
- The §20 relay codes, bounds and identity tuple are contract material; every
  new WS event or bridge message updates §7/§13.5 **and** the `protocol`
  validators in the same review (the exhaustive-catalog rule).


## 16. Authenticated committed asset-byte reads (authoring scope)

### 16.1 Route, origin, response, token isolation and failure mapping


The authoring viewport obtains **committed GLB bytes** through one route. This
route is **not** the preview delivery path and can never expose staged or
arbitrary project files.

**Route.** `GET /api/v1/projects/:projectId/content/assets/:assetId/versions/:version/bytes`

| Aspect | Rule |
|---|---|
| Origin | the authoring origin only (`sessions.md` §4.2 allowlist); any other Origin ⇒ `bad_origin` (HTTP 403, the accepted §4.2 status) |
| Auth | the project's authoring bearer token or admin scope (sessions.md §4.1); missing/invalid/expired ⇒ `unauthorized` (401) |
| Addressing | `assetId` and `version` are identifiers, never paths; `version` is a positive integer; both are validated before any storage call (`field_value` on failure). No path segment may contain `/`, `\`, `%2e`, `%2f` or `..` — decoded and rejected ⇒ `path_rejected` (400, before any read) |
| Resolution | the workspace resolves `(assetId, version) → sourceDigest` from the last acknowledged catalog; a version the catalog does not contain ⇒ `asset_not_found` / `asset_version_not_found` (404) |
| Integrity | the workspace re-verifies the digest before returning bytes (`content-storage.md` §8.1); mismatch ⇒ `blob_corrupt` (500), missing ⇒ `blob_missing` (503); bytes are never substituted or degraded |
| Response | `200`, `Content-Type: application/octet-stream`, `Content-Length: <byteLength>`, `X-Thirdlight-Digest: <sourceDigest>`, `ETag: "<sourceDigest>"`, `Cache-Control: private, max-age=31536000, immutable` |
| Bound | ≤ 33 554 432 B (the source-blob cap); a larger declared version is `limits_exceeded` and is never streamed |
| Never | staged bytes (`stageId` is not addressable here), a path read, another project's blob, a directory listing, a range request that bypasses digest verification, or a second version of an `assetId` under a different `assetId` |

**Renderer receives no authoring token.** The editor fetches the bytes (or hands a
resolver closure that performs the authenticated fetch) and passes **bytes or a
resolver** into `three-adapter`'s realization helpers. The adapter, its resources
and any injected loader never see a token, a URL or `fetch`. `three-adapter`
gains no network edge (dependencies.md §4.3 is unchanged; the fetch lives in
`editor`'s authoring transport layer, which already talks HTTP to the backend).


## 17. Immutable play-content locator and format-aware delivery

### 17.1 The immutable runtime-content manifest and snapshot capture


A play or export build consumes exactly one **runtime-content manifest**: the
complete, frozen description of what will run. It is captured from **one
authoring revision** and never re-read afterwards.

#### 17.1.1 Manifest document (strict)

```json
{
  "manifestVersion": 2,
  "type": "thirdlight-runtime-content",
  "projectId": "demo-0001",
  "revision": 12,
  "snapshotId": "demo-0001@r12",
  "capturedAt": "2026-09-18T10:00:00Z",
  "sceneDigest": "<64 lowercase hex>",
  "contentDigest": "<64 lowercase hex>",
  "assets": [
    { "assetId": "asset-0001", "version": 2, "sourceDigest": "<64 hex>",
      "sourceByteLength": 4096, "recipeDigest": "<64 hex>",
      "metricsDigest": "<64 hex>", "path": "content/sha256/<64 hex>" }
  ],
  "behaviors": [
    { "behaviorId": "behavior-0001", "sourceDigest": "<64 hex>",
      "sourceByteLength": 1234, "manifestDigest": "<64 hex>",
      "outputDigest": "<64 hex>", "outputByteLength": 4096, "apiVersion": 1,
      "declaration": { "properties": [ … ] },
      "ownedTransforms": [], "requiredModules": ["@thirdlight/runtime"],
      "path": "behaviors/<64 hex>.js" }
  ],
  "modules": [
    { "id": "thirdlight.platformer:controller", "apiVersion": 1,
      "package": "@thirdlight/platformer", "version": "0.2.0" }
  ],
  "enginePins": [
    { "id": "@thirdlight/runtime", "version": "0.2.0", "apiVersion": 1 },
    { "id": "@thirdlight/three", "version": "0.186.0", "apiVersion": 0 }
  ],
  "recipes": { "gltf-glb": 1, "behavior-source": 1 },
  "toolchain": {
    "esbuild": "0.28.2", "typescript": "5.9.3",
    "optionsDigest": "<64 hex>"
  },
  "buildOptionsDigest": "<64 hex>",
  "buildId": "<64 hex>"
}
```

Fields (all required; unknown fields ⇒ invalid; canonical key order as written,
2-space indent, LF, one trailing newline, no BOM):

| Field | Rule |
|---|---|
| `manifestVersion` | exactly `2` for an M3 capture. `1` remains a **readable** version under its old meaning (no `settings`/`game`/`media`, `assets` rows without `kind`, the M2 pin set) and is **never** upgraded in place. A v1 reader receiving a v2 document fails with `manifest_invalid` (`reason: "manifest_version"`) rather than ignoring unknown required keys. The authoring `project.json` `schemaVersion` stays `1` (delivery.md §2.1). |
| `type` | exactly `"thirdlight-runtime-content"` (discriminator; no auto-detection). |
| `projectId` / `revision` / `snapshotId` | from the captured snapshot; `snapshotId` must equal `<projectId>@r<revision>` (runtime.md §2). |
| `capturedAt` | UTC second at capture (project-model §7.2 format). **It IS a digest input** (C36-7, accepted with diff, Gate I): it is part of the `buildId` preimage, so `buildId` — and the export `outputDigest` closure that embeds it — is **capture-second-dependent**. Two same-input captures inside one second are byte-identical apart from `meta.json.exportedAt`; captures in different seconds additionally differ in `capturedAt` and `buildId`. Reproducibility claims normalise the capture second; this supersedes the earlier "not a digest input" wording. |
| `sceneDigest` | SHA-256 of the canonical scene document bytes at that revision (project-model §12.2). |
| `contentDigest` | SHA-256 of the canonical **captured content view** (`assets.md` §9.2; recomputable, `fixtures/m2/contracts/catalog/captured-content-view.json`). |
| `gameDigest` | SHA-256 of the canonical serialization of the `game` value; `null` hashes the four bytes `null`. |
| `settingsDigest` | SHA-256 of the canonical serialization of the resolved `settings` block. |
| `mediaDigest` | SHA-256 of the canonical serialization of the `media` block. |
| `settings` | the **resolved** six-key gameplay settings (`defaults ⊕ content.settings`, project-model §21.5), registry key order. A resolution failure at capture ⇒ `game_config_invalid`/`field_value`; never a partial object. These are the values the host passes to both the runtime and the physics configuration (delivery.md §3.3). |
| `game` | the frozen `content.game` value (39 §23.4) or `null`; embedded (no side-car file), canonical block order, ≤ 16 384 B. |
| `media` | the resolved media identity: `cues` (five keys `start, jump, checkpoint, death, goal` → `{assetId, version}` or `null`) and `animation` (per `modelAnimation` entity, ascending `entityId` then `assetId`, carrying the immutable `(assetId, version)`, the `profileDigest` of its canonical `roles` bytes and the validated `roles`). It must equal the captured content's resolution or the manifest is `manifest_invalid` (`reason: "media_identity"`). It carries **no** audio bytes and no URL. |
| `assets` | every asset version reachable from the captured scene/prefabs, ascending by `assetId` then `version`; `version` is the **resolved immutable version**; each row carries a required `kind ∈ {model, audio}` matching the captured record (`asset_kind_mismatch` otherwise), and `path` is always `content/sha256/<sourceDigest>`. |
| `behaviors` | every published behavior with a non-null `source` reachable from the captured scene, ascending by `behaviorId`. Declaration-only behaviors are omitted (they link nothing). Each row carries the declared `properties` (`declaration`), the `ownedTransforms` IDs and the `requiredModules` list so the loader can materialize declared properties and validate transform ownership without re-reading the project (C35-2, accepted with diff, Gate I). |
| `modules` | the **required engine modules** for this snapshot's module set, ascending by `id`; `thirdlight.demo:box-motion` when selected. |
| `enginePins` | the pinned engine package versions + `apiVersion`s the bundle was built against (ascending by `id`), copied verbatim from the pinned module table (`behaviors.md` §5.3). |
| `recipes` | the recipe/profile versions used to derive every `recipeDigest`/`outputDigest`. |
| `toolchain` | the exact build tool versions and `optionsDigest` (the record of the pinned option set, §4.2). |
| `buildOptionsDigest` | SHA-256 of the canonical option-set record. |
| `buildId` | SHA-256 (lowercase hex) of the canonical **document serialization** of this manifest without the `buildId` key: `JSON.stringify(manifestWithoutBuildId, null, 2) + "\n"` (UTF-8), key order exactly as in §2.1 with `buildId` last. The manifest is self-identifying. |
The block digests are `sha256(JSON.stringify(value, null, 2) + "\n")` UTF-8 over
the declared canonical key order (`delivery.md` §2.4). Because `settings`,
`game` and `media` sit inside the `buildId` preimage, every runtime-affecting
authored value is hash-bound; the block digests let a consumer verify one block
without re-serializing the document. No map order, clock or locale may affect a
block — the only clock input is `capturedAt`.

#### 17.1.2 Snapshot identity vs build identity (normative)

- **The manifest is captured at exactly one authoring revision.** `snapshotId`
  identifies the input: an asset reimport, a source publication or a settings
  edit after capture produces a *different* `snapshotId`. `manifestVersion`-level
  input identity is `<projectId>@r<revision>`, nothing more.
- **`buildId` is derived and is NOT an engine-independent binary hash.** It
  identifies the manifest + engine pins + toolchain versions + option set. Two
  projects at the same `revision` can produce different `buildId`s; the same
  `snapshotId` can produce a different `buildId` after an engine/toolchain/option
  change. The contract **never equates `project@revision` with a binary hash**,
  and no UI, log or `meta.json` field may present them as interchangeable.
- **The output closure digest** (export, §9) is a separate, later value: it is the
  SHA-256 record of the emitted tree and is reported as `outputDigest` in
  `meta.json`, alongside (not instead of) `snapshotId`/`buildId`.
- **Staleness rule.** A play/export build is stale iff the captured
  `snapshotId` no longer matches the revision it was captured from **or** any
  resolved asset/behavior/output digest differs from the manifest. A stale build
  is never served as current: the locator (§6) resolves the captured content, the
  requestor is told it is stale, and a fresh play/export captures a new manifest.
- **Build failure preserves the previous output** (`behaviors.md` §8.7 table
  row B, applied to the derived bundle): the previous immutable artifact and its
  locator remain served and exportable; the failed build writes no output, and
  the publication that triggered it stands (record, revision, blobs unchanged).

#### 17.1.3 Atomic snapshot capture

1. The backend resolves the project through the workspace (read-only), loads the
   current revision and reads `scene` + `content` from **one** acknowledged
   envelope state.
2. It derives `sceneDigest` and `contentDigest` from the canonical bytes, then
   builds the manifest of §2.1 from that single read.
3. It re-reads the revision (workspace re-read) and compares; a change ⇒
   `export_snapshot_mismatch` (export) / the play-start equivalent
   (`revision_conflict` with `currentRevision`) — never a mixed capture.
4. The capture is a pure derivation (`captureContentView` + `captureManifest`);
   it takes no mutation lock, writes nothing authoritative and creates no
   revision.
5. Only **completed** artifacts are addressable: the manifest is published at the
   same moment as the artifact set it names, and the locator points at the
   artifact set, never at a work-in-progress directory.

Numeric bounds: the manifest document ≤ 262 144 B (2 × `content_bytes` headroom
for the resolved copies; enforced at capture); a manifest that exceeds it is
`limits_exceeded` (`manifest_bytes`) and no artifact is produced.

### 17.2 Locator routes, shape and error mapping


`POST /api/v1/projects/:projectId/play` (unchanged shape plus one field) returns:

```json
{ "ok": true, "playSessionId": "play-…", "playBase": "http://127.0.0.1:8502/",
  "snapshotId": "demo-0001@r12", "revision": 12, "demo": true, "expiresAt": "…",
  "playContent": { "contentId": "<43-char base64url>", "buildId": "<64 hex>",
                   "path": "/play-content/<contentId>/", "expiresAt": "…",
                   "manifestPath": "manifest.json" } }
```

- `contentId` = 32 cryptographically random bytes, base64url without padding
  (`^[A-Za-z0-9_-]{43}$`). It is the **bearer capability** for one immutable,
  project-scoped artifact set captured from one `snapshotId`/`buildId`.
- `path` is relative to the preview origin. The editor builds the iframe `src` as
  `<playBase><path without leading slash>?play=<playSessionId>&content=<contentId>`
  (both identifiers; the preview reads them from its own URL, never from a bridge
  message).
- The artifact set is served by `backend` from the completed artifact store —
  never from a project directory, never from a temp directory.

#### 17.2.1 Locator routes (preview origin, no credentials)

| Route | Purpose |
|---|---|
| `GET /play/:playSessionId?content=<contentId>` | the preview shell (the only dynamic page); validates the live `playSessionId`↔`contentId` pairing |
| `GET /play-content/<contentId>/manifest.json` | the §2 manifest |
| `GET /play-content/<contentId>/game.js` | the built entry bundle |
| `GET /play-content/<contentId>/content/<assetId>/<version>` | one immutable committed asset version (same digest/`ETag`/`Cache-Control` rules as §5, re-verified) |
| `GET /play-content/<contentId>/behaviors/<outputDigest>.js` | one immutable compiled behavior output |

Success `200`; the response for every artifact carries its declared digest and
byte length. Failure mapping (all before any bytes are served):

| Condition | Code | HTTP | cls |
|---|---|---|---|
| malformed `contentId` / `playSessionId` / unpaired | `play_locator_invalid` | 404 | `not_found` |
| expired locator (§6.4) | `play_locator_expired` | 503 | `unavailable` |
| artifact set not yet complete (build in flight) | `play_content_not_ready` | 409 | `conflict` |
| no successful build for the requested `buildId` | `play_build_unavailable` | 503 | `unavailable` |
| traversal / listing / undeclared path / cross-project path | `path_rejected` | 400 | `validation` |
| declared artifact missing or digest mismatch | `blob_missing` / `blob_corrupt` | 503 / 500 | `unavailable` / `internal` |

`play_locator_expired` is `cls: "unavailable"` because sessions.md §11.2's status
mapping is normative and has no "gone" class; the distinct code, not the status,
is what a client must branch on. `expiresAt` is carried for truthful UI.

### 17.3 Lifetime, cache behavior and cleanup


| Constant | Value | Rule |
|---|---|---|
| `PLAY_CONTENT_TTL` | 900 s (15 min) | absolute from play start; never extended by reads |
| `PLAY_CONTENT_GRACE` | 60 s | after a terminal play state, in-flight reads may complete |
| `PLAY_CONTENT_ID_BYTES` | 32 | → 43-char base64url `contentId` |
| max artifact set | 536 870 912 B (512 MiB) | the §2 manifest closure; larger ⇒ `play_build_unavailable` (`reason: "closure_bytes"`) |
| max single artifact | 33 554 432 B (32 MiB) | per asset/behavior path |

A locator whose TTL elapsed is `play_locator_expired` for every route, including
a reload of an already-presented preview; the editor must start a new play.

### 17.4 Capability handling, redaction and exclusions


- **Single-purpose:** the locator authorizes **reads of one immutable artifact
  set only**. It cannot start/stop plays, read authoring state, run commands, list
  assets, list locators, or reach another project's artifacts.
- **No listing, no traversal, no enumeration:** only the exact routes above
  resolve. Directory listing is disabled; any other path (including
  `/play-content/<contentId>/` and `/play-content/`) is `path_rejected`; a request
  for a path under a different `contentId` is `path_rejected` (never a
  cross-project read).
- **Redaction:** `contentId` (and the `?content=` value) is a secret-equivalent.
  It is replaced by `<redacted:contentId>` in every session log entry, error
  `message`/`hint`, diagnostics relay and telemetry. The bounded log rule of
  sessions.md §11.1 already forbids absolute paths; this adds locator redaction as
  a normative rule. `contentId` values are **excluded from exports** (export.md
  §5.4 pattern set gains a locator-value check; §9 below).
- **Origin and framing:** the locator routes are served from the preview origin
  (§2 of sessions.md) with `X-Frame-Options`/`frame-ancestors` restricted to the
  exact authoring origin, `Referrer-Policy: no-referrer`, and
  `Cross-Origin-Resource-Policy: same-origin`.
- **CSP (preview origin, artifact responses and shell):**

  ```text
  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
  img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none';
  object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors <exact authoringOrigin>
  ```

- **CSP consequence (C38-1, packet 42).** `'wasm-unsafe-eval'` permits **WebAssembly compilation only**;
  it does **not** permit `eval`, `new Function` or arbitrary script evaluation, and
  no `eval` interface is introduced by M3. The implementation's nonce clause is
  unchanged: the header is `"default-src 'none'; script-src 'self'
  'wasm-unsafe-eval'"` + (nonce ? `" 'nonce-${nonce}'"` : `""`) +
  `"; connect-src 'self'; …"`, applied to the shell and artifact responses alike.
  Evidence of record: `acceptance/evidence-m3/38/raw/engine.json`
  (`physicsOk: false`, `WebAssembly` compile blocked by `script-src 'self'`),
  `…/engine-nocsp.json` (`physicsOk: true`) and `…/engine-csp-wasm.json`
  (`physicsOk: true` with this exact token). The standalone export states its own
  policy with the same token (`export.md` §3); a separately emitted WASM artifact
  keeps the accepted `scanWasmContainer` validation and `application/wasm` MIME.
  No other CSP source is added: no `unsafe-inline`, no `unsafe-eval`, no remote
  origin, no `data:` script.

- **Cache behavior:** artifact responses are `Cache-Control: private, immutable`
  with a `max-age` equal to the remaining locator lifetime (never longer), plus
  `ETag: "<digest>"`. A reload of the same `contentId` therefore resolves to the
  **same bytes** for the life of the capability: a reconnect, reload or repeated
  fetch must never resolve to newer bytes. A fresh play allocates a new
  `contentId`.
- **No authoring credentials:** the preview page config and bundles contain no
  token, no `/api/v1` URL and no authoring-service call (sessions.md §13.2;
  package scans in §10.2). The only content capability is the read-only locator.
- **Cleanup:** on play termination (stop, `preview_failed`, `preview_timeout`,
  `expired`, `session_lost`) the backend marks the artifact set unreachable after
  a **60 s grace** (for in-flight reads) and removes the contentId↔playSessionId
  pairing. The artifact bytes themselves are immutable and retained outside the
  locator (they may already be pinned by another play/export); removing the
  capability never removes authoritative or derived content that another
  snapshot pins, and a locator is never reused for a different artifact set.

### 17.5 Format-aware resource validation and the fetch policy


M1 pinned **exactly one engine-initiated `fetch`** (`./snapshot.json`) and no
preview content fetch. M2 replaces that rule **only through this contract diff**;
it does not weaken the scan.

| Bundle | Permitted engine-initiated fetches (exhaustive) |
|---|---|
| play-preview bundle | `./manifest.json`, `./game.js`-relative behavior outputs, and one read per unique declared asset path of the manifest — every path **relative to the artifact root**, each requested **once per unique path**, all same-origin with the artifact root |
| export bundle | the same set, relative to the export output tree (`./manifest.json`, `./scene.json`, `./content/sha256/<digest>`, `./behaviors/<digest>.js`) |
**M3 (packet 42): no new fetch.** `game-host` initiates none, and the M3
manifest keys (`settings`, `game`, `media` and their digests) are **embedded**
in `manifest.json`: there is **no** `game.json` side-car and no additional
artifact class. The list stays `./manifest.json`, `./scene.json` (export) and
one read per unique declared asset path — count `1 + |unique declared
artifacts|`. `content/sha256/<digest>` remains the path for model **and** audio
bytes. Packets 58/60 re-measure the real bundles (delivery.md §6.5).

Normative rules:

1. Every fetch target must be a **declared path of the served manifest** for the
   resolved `contentId`/output tree. A fetch of an undeclared path is a contract
   violation (a build finding, not a runtime fallback).
2. No absolute URL, no cross-origin request, no CDN, no `data:` script, no
   `file://`, no `http(s)://` literal (§5/§6 below). The fetch count is
   `1 + |unique declared artifacts|` and is asserted per bundle in the negative
   matrix (§10.2).
3. The `behaviors.md` §5.5 output scan and export.md §5.4/§5.4.1 scans still run
   over the emitted bytes; the §5.4.1 recorded-exception table is unchanged and
   remains bound to `three@0.186.0` + the §5.3 option set.
4. A manifest that declares zero behaviors and zero assets (M1-style scene)
   reduces to the M1 case: `./manifest.json` replaces `./snapshot.json` as the
   single engine fetch (recorded as the compatibility rule in §12 below).

#### 17.5.1 Format-aware resource validation (normative)

M1's textual pattern scan was written for JavaScript bundles. Running it over a
GLB or a WASM binary is meaningless (patterns can appear inside compressed/binary
payloads by chance, and real forbidden content can hide in structures a text scan
cannot see). M2 therefore validates **by container format**, then scans text:

| Container | Validator | Must reject |
|---|---|---|
| JS/text bundle | `scanTextBundle(bytes)` — the export.md §5.4 a–j patterns + §5.4.1 counts | absolute/remote locators, credentials, `node:`, `__dirname`/`process.`, `/api/v1/`, `/mcp`, `XMLHttpRequest`/`WebSocket` |
| GLB (asset bytes) | `scanGlbContainer(bytes)` — glTF magic/version/declared length, chunk table, JSON-chunk strict parse, **every `uri` value**: no value may contain `://`, `data:`, `file:`, `//`, a leading `/`, `..`, or a backslash; `buffer.uri` absent (embedded) or a `data:`-free relative name that exists in the container's own blob map | remote/external/absolute URIs, undeclared external buffers, non-GLB file magic |
| WASM (if separately emitted) | `scanWasmContainer(bytes)` — `\0asm` magic + version 1, declared SHA-256 pin match, MIME record `application/wasm`, imports ⊆ the approved host-import allowlist (`[]` for M2) | magic/version mismatch, digest mismatch, any host import, `fetch`-style custom section is not a thing but any declared `http(s)://` name section value is rejected |
| Output tree | `assertRelativeClosure(tree)` — every file is under the output root; every reference in every emitted file is relative (`./…`); no absolute path, no `file://`, no `http(s)://` | any absolute/remote reference or escape |

Numeric assertions: each declared asset path is read exactly once; the total
fetched byte count equals the sum of declared `sourceByteLength`/`outputByteLength`
(±0); no request leaves the artifact origin. The **browser** network panel is the
acceptance-level check (A18/A21/A22); the byte-level checks above are the
build-time checks.

### 17.6 Readiness and load failure


The M1 bridge is versioned in place: `window.__thirdlightPreview.v` becomes `2`.
The exact-origin/source/nonce checks of sessions.md §13.3–§13.4 are **unchanged**
and remain mandatory; v2 adds messages and payload rules.

**Preview page config (sessions.md §13.2, v2):**

```js
window.__thirdlightPreview = {
  v: 2,
  authoringOrigin: "<O_A exact>",
  playSessionId: "<from ?play=>",
  contentId: "<from ?content=>",
  manifestPath: "./manifest.json"
};
```

Still **no tokens, no API URLs, no credentials**. `contentId` is a capability, so
it is treated as sensitive in logs (redaction, §6.3) but is not an authoring
credential.

**New/changed messages (added to the sessions.md §13.5 allowlist):**

Editor → preview: `tl.handshake` gains `bridgeVersion: 2, contentId, buildId`;
new `tl.playContent.expect` (`v, playSessionId, contentId, buildId`) sent once
after a successful handshake; new `tl.input.request`
(`v, playSessionId, requestId, frames[]`).

Preview → editor: `tl.ready` gains `buildId, contentDigest, stepIndex`;
`tl.error` gains `phase`; new `tl.load.progress`
(`v, playSessionId, phase, loadedBytes, totalBytes`) with `phase ∈
{"shell","manifest","assets","behaviors","runtime"}`; new `tl.input.result`
(`v, playSessionId, requestId, ok, appliedFromStep?, appliedToStep?, error?`).

**Payload bounds:** every v2 message ≤ 65 536 B except `tl.snapshot` (≤ 1 048 576 B,
unchanged) and `tl.screenshot.result` (≤ 1 572 864 B, unchanged); `tl.load.progress`
≤ 1 024 B; `frames[]` in `tl.input.request` ≤ 600 entries and ≤ 16 384 B.
**No GLB bytes and no compiled behavior source/bytes appear in any bridge message
or WS full-state frame** — the preview loads bytes itself from the locator.
`mutation.applied`/full-state frames are unchanged and carry no binary content
(sessions.md §11.6 bound restated).

**Readiness:** the preview posts `tl.ready` only after (1) the manifest is loaded
and its `buildId` matches `tl.playContent.expect`, (2) every declared asset read
completed and verified, (3) the physics port initialized, and (4) the behavior
outputs are linked and the runtime instantiated. A failed/cancelled load posts
`tl.error` with the phase; the editor reports a truthful failure and never
`presented`. A mismatch of `buildId`/`contentDigest` ⇒ `tl.error` (`phase:
"manifest"`, code `play_content_not_ready`), never a silent retry against newer
**M3 readiness and the title screen.** Ready means the **title screen loaded**,
not that gameplay started: the preview reports ready after the manifest v2
identity matches (including `settingsDigest`/`gameDigest`/`mediaDigest`), every
declared asset read completed and verified, the physics port initialized from the
manifest `settings` (same object the runtime receives — delivery.md §3.3), the
linked behavior outputs are linked and the `game-host` composition instantiated.
The run is `awaitingStart` and no movement step has executed. The
game-control/observation channel is available from that moment, and every
start/replay/mute is serviced between frames — the host never waits for a
physics tick to accept a menu action (delivery.md §4.5). Injected/relayed input
is never a trusted user gesture and can never unlock audio (delivery.md §4.4).
bytes.


## 18. Bounded input-exercise relay (MCP)

### 18.1 Route, result, exclusive test-input mode and failure mapping


#### 18.1.1 Route and shape

`POST /api/v1/projects/:projectId/play/:playSessionId/input`

```json
{ "mode": "exclusive-test",
  "frames": [ { "stepOffset": 0, "moveX": 1, "jump": "pressed" },
              { "stepOffset": 1, "moveX": 1, "jump": "held" } ] }
```

- `mode` is exactly `"exclusive-test"`; any other value ⇒ `field_value`. There is
  no per-frame time field: the relay is **step-indexed** (the same `ActionFrame`
  shape and validation as the recorded source, `input.md` §2/§6).
- `frames` is 1–`maxRelaySteps` (600) entries, ascending by `stepOffset`, no
  duplicates, `stepOffset` gaps allowed. Body ≤ 16 384 B.
- Semantic actions only: this is **not** DOM event injection, `eval`, synthetic
  `KeyboardEvent`/`GamepadEvent` dispatch or a second mapping implementation.

#### 18.1.2 Result

```json
{ "ok": true, "mode": "exclusive-test", "playSessionId": "play-…",
  "snapshotId": "demo-0001@r12", "buildId": "<64 hex>",
  "appliedFromStep": 1481, "appliedToStep": 1531,
  "inputMode": "test", "clearedAt": "2026-09-18T10:00:01Z" }
```

- It reports the **applied step range** and the `snapshotId`/`buildId` the frames
  ran against; a caller can therefore distinguish stale observations.
- The mode is **exclusive**: while it is active the browser binding's sampled
  frames are ignored (physical and injected input must not race), and the bridge
  applies the injected sequence strictly in `stepOffset` order. On completion, on
  stop, on preview disconnect and on locator expiry the mode is cleared and the
  physical source is re-armed from a neutral frame; a subsequent physical press is
  a fresh edge. There is no partial clear.
- Failure mapping: no registered browser / owner WS detached ⇒ `session_unavailable`
  (503, the existing structured no-browser outcome — never a simulated success);
  unknown/stopped play ⇒ `play_not_found` (404); a relay with physical input
  already engaged since the last neutral step ⇒ `input_relay_conflict` (409);
  `frames` over a bound ⇒ `input_relay_limits_exceeded` (400); no
  `tl.input.result` within 10 s ⇒ `input_relay_timeout` (503).
- The relay never mutates authoring state, never writes the envelope and never
  becomes a second command path.

## 19. Content, job and query service surface (authoring scope)

Promoted at Gate E from the accepted packet-19 delivery §15 surface and pinned by
the accepted fixtures `fixtures/m2/contracts/delivery/protocol-surface.json`
(routes, auth, origin, response caps and the error→status mapping) and
`fixtures/m2/contracts/delivery/upload-bounds.json` (the frame/stage bounds), and
reconciled with `commands.md` §4 by the Gate F repair GF-1. It is the binding
home of the packet-25 content routes; §16.1 owns the asset-byte read and §17/§18
own the locator/bridge and input relay.

### 19.1 Routes, origin, auth and results

All routes below are relative to `/api/v1/projects/:projectId`. They are
**authoring-origin only** (§4.2 allowlist; any other Origin ⇒ `bad_origin` 403)
and require the project's authoring bearer token or admin scope
(missing/invalid/expired ⇒ `unauthorized` 401). Results are strict JSON with the
§11.2 error shape; `:stageId`, `:assetId`, `:version` and `:jobId` are
identifiers, never paths (a path-shaped or malformed value is `path_rejected` /
`field_value` **before** any storage call).

| Route | Result | Principal failures |
|---|---|---|
| `POST /content/stages` | `{ ok, stageId, expiresAt }` | `stage_limits_exceeded` (400, `open_stages`) |
| `PUT /content/stages/:stageId/bytes` | `{ ok, stageId, byteLength, digest, complete }` — raw body ≤ 1 MiB per frame, `X-Thirdlight-Offset` / `X-Thirdlight-Total` | `content_frame_invalid` 400, `stage_limits_exceeded` 400, `stage_not_found` 404, `stage_expired` 503 |
| `POST /content/stages/:stageId/inspect` | `{ ok, proposal, truncated }` (proposal ≤ 256 KiB) | `stage_not_found` 404, `stage_expired` 503, `import_rejected` 400 |
| `DELETE /content/stages/:stageId` | `{ ok, discarded }` | `stage_not_found` 404 |
| `GET /content/assets` | `{ ok, assets, total, nextCursor }` (`limit`/`offset`) | `field_value` 400 |
| `GET /content/assets/:assetId` | `{ ok, asset, versions }` | `asset_not_found` 404 |
| `GET /content/integrity` | `{ ok, entries, summary }` | `project_not_found` 404 |
| `GET /content/jobs/:jobId` | `{ ok, job }` (a bounded job record) | `job_not_found` 404, `job_expired` 503 |
| `POST /content/behaviors/source` | `{ ok, revision, behaviorId, sourceDigest, outputDigest }` — runs the packet-33 `publishBehaviorSource` facade end to end (stage → validate/compile → trust gate → prepared record → `publishBehavior{mode:"source"}`); the body is `{ stageId, behaviorId, displayName, declaration, expectedRevision, requestId }` | the `commands.md` §5.4 codes (`behavior_source_invalid`, `behavior_trust_unacknowledged`, `behavior_compile_failed`/`behavior_output_forbidden_content`, `behavior_publication_unavailable`, `behavior_declaration_mismatch`, `revision_conflict`) mapped per §11.3 | **C35-4 (accepted with diff, Gate I):** this additive route closes C34-8 — the editor's source-publication flow no longer stops at `behavior_publication_unavailable`. There is **no second commit path**: the route runs the existing packet-33 facade, which itself commits through `workspace.runCommand`. |
| `GET /content/assets/:assetId/versions/:version/bytes` | the §16.1 binary read | §16.1 |

**Queries** (including the packet-16 `queryAssets`/`queryPrefabs`/
`queryBehaviors`) are **not** a separate route: like every M1 query they are
query envelopes on `POST /commands` (§6.1; `commands.md` §4/§5.6). The packet-19
delivery §15 line naming a `GET …/queries` route is realized here by that
existing command route, which is what the accepted fixture pins (14 routes).

**Non-authority (normative).** Every write still goes through
`POST /commands` → `workspace.runCommand` (the sole executor). The upload route
only **stages**; `inspect` only **proposes** and — after a successful
import-profile validation — triggers the workspace's immutable
`sources/sha256/<digest>` publication (`workspace.md` §13.3.2); the command
commits (dedup precedes stage lookup, `content-storage.md` §6.1). This transport
performs **no filesystem write and no authoritative mutation** of its own, and
`mutation.applied` never carries bytes (§17.6).

### 19.2 Bounds and limits (reconciled)

| Bound | Value |
|---|---|
| assets query `limit` / default | 1–128 / 50 (`commands.md` §4 `queryAssets`/`queryPrefabs`/`queryBehaviors`) |
| asset versions per asset | ≤ 32 (project-model §18.3) |
| integrity entries | ≤ 1 024 (the project-model §18 `version_records` cap; the full bounded report is returned) |
| upload frame / stage | 1 048 576 B / 33 554 432 B |
| stage TTL / open stages / staged bytes per project | 3 600 s / 8 / 134 217 728 B |
| inspection job / publish job timeout | 30 s / 120 s |
| job concurrency | 2 per project / 4 global |
| job record TTL / response | 900 s / ≤ 16 KiB |
| inspect proposal response | ≤ 262 144 B (`truncated` when the display lists are dropped) |

These replace the packet-19 proposal's earlier asset page bound (1–200): M2 uses
**128**, the value `commands.md` §4 and the implementation already fix. The
accepted fixture `protocol-surface.json` pins no page-limit number, so no fixture
change was needed. **Job records** are bounded by the 900 s result TTL and the
concurrency slots; M2 exposes no job-listing route, so no job-count bound is
required (recorded as GF-6).

### 19.3 Failure mapping

Failure classes follow §11.2 with the recorded route-level overrides named in
§11.3: `unauthorized` ⇒ 401, `bad_origin` ⇒ 403, and the §16.1 asset-byte read's
`blob_corrupt` ⇒ 500 / `asset_not_found`+`asset_version_not_found` ⇒ 404. The
workspace/content-storage codes (`blob_missing`, `blob_corrupt`, `path_rejected`,
`stage_not_found`, `stage_expired`, `stage_limits_exceeded`, `import_rejected`)
surface unchanged; `import_rejected` is cls `validation` (400) with the ordered
`asset_*` diagnostics. Because `inspect` completes the workspace §13.3.2
immutable publication, it can additionally surface the publication codes
(`content_quota_exceeded`, `content_publish_failed`, `blob_corrupt`,
`blob_missing`); §19.1 lists the principal failures per route.

### 19.4 The additive `content` projection

The full-state payload (§5.1/§8) additionally carries a bounded, **v2-only**
`content` object `{ assets, prefabs, behaviors, behaviorTrust }` — the summary
pages of `queryAssets`/`queryPrefabs`/`queryBehaviors` at the same revision plus
the bounded `behaviorTrust` read (`{ entries: [{ sourceDigest,
acknowledgedRevision }] }`, ≤ 64 entries, ascending by `sourceDigest`;
**C34-4/C36-4** accepted with diff, Gate I). It carries
**no** definitions, declarations, versions, metrics or bytes, and it is absent
for a v1 envelope. M1 clients ignore the unknown top-level field (verified), so
the addition is backward compatible. Content changes converge through the same
`mutation.applied` `change` records the scene uses. `behaviorTrust` is the
editor's reload-safe source of acknowledged digests (the packet-34 editor could
otherwise learn them only from `acknowledgeBehaviorTrust` change records).

**Scene document `schemaVersion` (C35-5, accepted with diff, Gate I;
CC-48-3 promoted at Gate L).**
`queryProject` (and the full-state scene projection) reports the **scene
document's** `schemaVersion` directly — `3` for a `storageVersion 3` envelope,
`2` for `storageVersion 2`, `1` otherwise — instead of leaving a client to
derive it from the project manifest (which stays `1`). The play snapshot's
`scene.schemaVersion` is the same document value (`backend.ts`'s full-state
projection and snapshot both read it).

## 20. M3 game control and observation relay

Two bounded, typed relays address an explicitly selected play session. `protocol`
is the sole home of the shapes (packet 48 implements the validators and the
`tl_game_control`/`tl_game_observe` MCP tools); `backend` frames the routes and
routes through the owner browser's WS; the preview supplies the values from the
committed read-only `GameView` (`gameplay.md` §6) and the injected audio owner.
Neither relay simulates gameplay, mutates authoring state or becomes a second
command path.

### 20.1 Routes, shapes and bounds

| Route | Body | Result |
|---|---|---|
| `POST /api/v1/projects/:projectId/play/:playSessionId/control` | `{ command ∈ {start, replay, mute, unmute}, expectedRunId? }` ≤ 4 KiB | `{ ok, playSessionId, snapshotId, buildId, runId, command, state, acceptedAtStep, inputMode }` ≤ 4 KiB |
| `POST /api/v1/projects/:projectId/play/:playSessionId/observe` | `{ timeoutMs }` 250–15 000 (default 5 000) ≤ 4 KiB | the observation document (≤ 16 KiB; `delivery.md` §5.2) |

Both are authoring-origin routes with the accepted bearer/admin auth. The
observation carries the identity tuple `(playSessionId, snapshotId, buildId,
runId, stepIndex)`, the run state, checkpoint id + active bit, death count,
`goalReached`, cumulative event counters, ≤ 32 events, `inputMode` and the sound
status (`muted`/`blocked`/`ready`/`unavailable`, `unlocked`, `voices`, `gesture`).

### 20.2 Failure mapping (closed)

`field_value`/`field_unexpected` (400 `validation`);
`game_command_invalid` (`reason: "state"`, 400); `game_run_stale` (409
`conflict`, carrying the current `runId`, **not applied**); `play_not_found`
(404); `play_locator_expired` (503 `unavailable`); `bad_origin` (403);
`game_relay_rejected` (503 `unavailable`, dropped and counted — wrong source or
nonce); `session_unavailable` (503, no registered browser / owner WS detached /
not yet `presented` with `reason: "not_presented"`); `game_relay_timeout` (503);
`input_relay_conflict` (409, physical input engaged during exclusive test mode);
`limits_exceeded` (`result_bytes`, 400).

**Nothing binary or sensitive crosses.** No relay request, result, WS frame,
bridge message or log entry carries GLB/WAV bytes, base64 media, an authoring
token, a `contentId` capability (redacted `<redacted:contentId>`), an absolute
workspace path or a generic eval/script field. Audio is referenced by `assetId`
only; bytes are read by the preview from the immutable blob/locator path.

### 20.3 Staleness and exclusive mode

A stale identity is always detectable from the result alone
(`runId`/`stepIndex`/`snapshotId`/`buildId`); a stale **control** is refused
with `game_run_stale`. While the accepted §18 exclusive test-input mode is
active, physical frames **and** the physical menu channel are ignored, so an
injected sequence cannot race a physical press. Injected input is never a
trusted user gesture and cannot unlock audio (delivery.md §4.4).