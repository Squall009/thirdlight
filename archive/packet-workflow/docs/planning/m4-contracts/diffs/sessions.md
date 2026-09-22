# Owned diff rows — `sessions.md` (packets 64, 65, 67)

Proposal: `../delivery.md` §4. Gate Q. **PROPOSED — not accepted.**

## C64-8 — NO contract text change (adjudication record)

The packet-63 bridge failures (D-63-4/5/6/7) were read against the
accepted `sessions.md` text, and that text **already mandates** the
required behavior. No `sessions.md` text is changed by packet 64. This
record fixes the binding citations so the Gate Q review and the
packets-70/71 repairs implement **to the accepted text** (not to a
re-statement), and so no repair is read as a contract change:

| Gap | Binding accepted text (exact location) | Required behavior | Defect |
|---|---|---|---|
| D-63-5 (missing handshake ack) | §13.4 step 2: "The preview verifies origin/source (§13.3) and `playSessionId` (must equal its `?play=` value) ⇒ replies `tl.handshake.ack` (echoing `nonce`)" | the v3 wrapper acks the handshake exactly as the M2 wrapper does | implementation (the v3 wrapper omits the accepted step) |
| D-63-5b (missing relay handlers) | §18.1 (the input relay), §17.6 (the v2 message set incl. `tl.load.progress`/`tl.input.request`), §20 (the M3 control/observation relays) | the v3 wrapper registers the accepted relay handlers for v3 plays | implementation |
| D-63-6 (invalid `tl.ready`) | §17.6: "`tl.ready` gains `buildId, contentDigest, stepIndex`"; §13.5 validator: `contentDigest` is 64 lowercase hex | the v3 wrapper sends the real identity tuple (the manifest v2 `contentDigest`, the snapshot `revision`, the runtime `stepIndex`) | implementation (the wrapper sends `''`) |
| D-63-4 (no WS send path) | §13.4 step 5: "the editor sends WS `play.preview.ready` (the backend marks `presented`)" and step 6 (`play.preview.failed`); §5.2 (the client heartbeat ≥ every 20 s); §10.2 (the 15 s present timeout) | the editor client has the WS command send path and relays the preview's `tl.ready` as `play.preview.ready` | implementation (the editor client has zero `.send(`) |
| D-63-7 (dropped `playContent`) | §17.2 (the `/play` result's `playContent` field; the retained `play.started`) | the editor retains the locator across the `play.started` merge | implementation (the client merge drops the field) |

**Owner note for Gate Q:** the D-63-4 relay ownership question (the
ledger's owner table — "editor vs backend path") is resolved by the
accepted text: the **editor** sends the WS command (it is the registered
owner session; the backend only marks `presented`). No backend change is
required for the ready path.

**No other `sessions.md` change (packet 64).** The §13.3 origin/source/
nonce checks, the §17.3 lifetime bounds and the §17.4 redaction rules are
untouched.

---

# Packet 65 rows (proposal: `../templates.md` §6, §12)

## C65-6 — the admin route and the creation permission rule

### Row 1: `sessions.md` §6.3 (operator routes block) — one route added

OLD (the accepted route block ends with the export route):

```text
POST /api/v1/admin/projects/:projectId/export        exportProject (export.md)
```

NEW (one route appended; admin-scoped like the rest of the block):

```text
POST /api/v1/admin/projects/:projectId/export        exportProject (export.md)
POST /api/v1/admin/templates/projects                createProjectFromTemplate { projectId, name, templateId } (workspace.md §8.4 C65-3)
```

### Row 2: `sessions.md` §6.3 (permission paragraph) — the creation rule

OLD (the accepted §6.3 opening: "The workspace.md §11 operator commands
and `createProject`/`exportProject` are **admin-scoped HTTP operations**
(token scope `admin`), implemented in packets 09/12:"):

NEW (the sentence gains the template route and the scoped-token rule —
the exact added text after the route block):

```text
**Template creation is admin-scoped (C65-6):** `POST
/api/v1/admin/templates/projects` requires the admin token (the
operator's). A project-scoped token (scope `authoring:<projectId>`) CANNOT
create projects — a project-scoped MCP token gains no global admin
privilege (m4-plan.md §2.1). The editor UI's creation flow (packet 74)
uses the deployment's configured admin token (a deployment value, never
logged); without one, the creation UI is disabled with a bounded message.
Browser creation and MCP creation route into the same workspace operator
(templates.md §5) — there is no second creation path.
```

## C65-7 — the MCP tool rows and the `origin.kind` audit value

### Row 3: `sessions.md` §14/§15 (the MCP tool table) — two rows added

OLD (the accepted seven-tool table — `tl_inspect`, `tl_command`,
`tl_sessions`, `tl_play_start`, `tl_play_stop`, `tl_diagnostics`,
`tl_screenshot`; the tool surface note that every tool routes into the
backend's `/api/v1` surface via the same `BackendClient`):

NEW (two rows appended — the accepted "no alternate mutation engine" rule
applies: both tools route into the admin route / the read surface):

```text
| `tl_project_create` | mutation (admin-scoped token only) | `projectId`, `name`, `templateId` | the §6.3 template route (workspace.md §8.4): the identity-carrying result or the §11 template error set (bounded, structured) |
| `tl_templates_list` | query (any authoring scope) | — | the installed verified templates: descriptor summaries (`templateId`, `name`, `version`, `engineVersion`, `contentDigest`) — never bytes, never recipe contents |
```

### Row 4: `sessions.md` (origin kinds — the accepted
`{ "kind": "browser" | "mcp" | "admin" }` value set) — one documented
value added

OLD (the accepted origin shape in the mutation-request/audit text — three
kinds):

NEW (one value added; the template creation origin is the creation
context's, injected by the operator — templates.md §7.1):

```text
`"kind": "browser" | "mcp" | "admin" | "template"` — `template` is minted
only by `createProjectFromTemplate` (`clientId: "<templateId>@<version>"`),
never by a client request; the audit records show the starter replay as
template-originated commands.
```

**No other `sessions.md` change (packet 65).**

## C67-2 — the `GET /api/v1/admin/health` admin route + the `tl_health`
MCP row (reliability.md §3/§10)

Proposal: `../reliability.md` §3, §10. Gate Q. The exact promotion text:

### Route row (the §6.3 admin group table — new row)

```
GET /api/v1/admin/health
  auth:     admin scope (the §6.3 admin token — the sessions' project tokens
            cannot read it; read-only)
  origin:   the admin origin rules (§6.3) — no authoring Origin required
            (loopback/admin client)
  result:   { ok, v: 1, ts, backendId, engineVersion, process, workspace,
              sessions, play, content, errors, truncated? }
            (reliability.md §3 envelope; total ≤ 32 KiB; `blocked` ≤ 100;
             `errors` ≤ 32 — the existing scan/ring bounds re-used)
  errors:   the §11.2 error discipline (a serializer overflow is impossible
            by construction — the bounded clip sets `truncated: true`;
            redaction: no credentials, no absolute paths, no content bytes —
            the §11.1 "no secrets, no absolute paths" rule extended to the
            admin surface)
```

### MCP tool row (the §19 tool table — new admin-scoped read row)

```
tl_health          admin scope; read-only; routes to GET /api/v1/admin/health
  (no arguments; the envelope above; the tool records no state)
```

### Constants (§11.5 — additive rows)

```
| health report total | 32 KiB (serialized; the bounded clip sets `truncated: true`) |
| health `blocked` list | ≤ 100 (the accepted startup-scan log bound) |
| health `errors` list | ≤ 32 (the accepted runtime diagnostics ring bound) |
```

**Normative notes (reliability.md §3):** the report is a point-in-time
snapshot tagged `backendId` + `ts` + `engineVersion`; consumers must
re-fetch on any `backendId` change (stale-identity rule); the report asserts
nothing about hardware (device records are the 67-B/79 surfaces). **No other
`sessions.md` change (packet 67)** — the auth model, the §11.3 code table and
the §12 relay chain are untouched (no new session-layer code; the tool-
surface `backup_*`/`restore_*`/`budget_*` codes of reliability.md §9 are
raised by the offline/budget tools, not the session layer).