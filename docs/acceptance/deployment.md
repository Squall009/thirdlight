# Thirdlight — minimal self-host deployment (M1)

Version 0.1 · Packet 13 · 2026-09-18. Describes the **actual server
architecture** (one backend process, two origins, per-launch stdio MCP) and the
**minimal configuration** to run it self-hosted. Verified in this environment
by the M1 acceptance run (disposable instance, `docs/acceptance/m1-report.md`);
what is *supplied* (this config + docs) vs *performed* (a disposable local
instance) is stated at the end. **No public hosting; no deployment to the
user's host was performed or authorized.**

## 1. Architecture (as built)

| Component | What it is | Runs where |
|---|---|---|
| Backend | one Node process (`node dist/backend/backend.mjs`), two HTTP listeners: **authoring** (editor statics + `/api/v1` + WS `/api/v1/ws`) and **preview** (play preview template + `preview.js`) | the host/container that owns the data |
| Editor browser | static bundle at `O_A/` (React panels, viewport, session client) | the user's browser |
| Play preview | `O_P/?play=<id>` iframe; receives the snapshot over the bridge; owns the WebGL render | the user's browser (separate origin, credential-free) |
| MCP adapter | `node dist/mcp-adapter/mcp.mjs`, **stdio** transport, one process per harness launch | wherever the harness spawns it (same filesystem + network reach to `O_A`) |
| Exports | static trees under `<exportRoot>/<projectId>@r<revision>/`, served by any plain static HTTP server, backend NOT required | any static host |

One mutation engine: the browser, the MCP tools, and future clients all reach
the backend's single command route; the backend owns the workspace (durability,
ownership, external-change handling). The browser is a projection; exports are
frozen snapshots.

## 2. Directories and (shared) mounts

```
<engineRoot>/                        engine checkout (this repository)
  packages/, tools/, docs/           sources (read-only at runtime)
  node_modules/                      pinned dependencies (the deployment
                                     bundle resolves `esbuild` from here —
                                     the backend must run FROM this checkout)
  dist/                              build artifacts (npm run build):
    editor/{index.html,main.js}      editor statics (O_A)
    preview/preview.js               preview statics (O_P)
    backend/backend.mjs              backend deployment bundle
    mcp-adapter/mcp.mjs              MCP stdio bundle (fully self-contained)
<dataRoot>/projects/<projectId>/     workspace data (the durable state)
  project.json, scenes/main.json, .thirdlight/{ownership.json,claim-<e>,recovery/}
<exportRoot>/<projectId>@r<rev>/     exported game trees (plain static files)
```

On this host the deployment lives inside the Proxmox LXC container as plain
directories (decision 0001 §6: same `/proc` namespace, no nested containers,
no daemon-socket mounts — builds run in the same LXC, so the container daemon
socket is **not** mounted merely to run builds). Where the harness and the
server share a filesystem (as here: `/home/dadmin/projects/thirdlight`), the
MCP adapter needs no additional mount; it resolves `O_A` over the network.

## 3. Configuration (environment, all `THIRDLIGHT_*`)

| Variable | Required | Example / rule |
|---|---|---|
| `THIRDLIGHT_DATA_ROOT` | yes | an absolute path to a writable dir (created on demand) |
| `THIRDLIGHT_AUTHORING_ORIGIN` | yes | `http://127.0.0.1:8501` (exactly what the browser loads `O_A` from) |
| `THIRDLIGHT_PREVIEW_ORIGIN` | yes | `http://127.0.0.1:8502` |
| `THIRDLIGHT_AUTHORING_BIND` | yes | `host:port` (port `0` ⇒ ephemeral, used by tests) |
| `THIRDLIGHT_PREVIEW_BIND` | yes | `host:port` |
| `THIRDLIGHT_AUTHORING_ORIGINS` | yes | comma-separated **exact** Origin allowlist (no wildcards) — for local use: `http://127.0.0.1:8501` |
| `THIRDLIGHT_EDITOR_DIR` | yes | `<engineRoot>/dist/editor` (must contain `index.html`) |
| `THIRDLIGHT_PREVIEW_DIR` | yes | `<engineRoot>/dist/preview` (must contain `preview.js`) |
| `THIRDLIGHT_TOKENS` | yes | comma-separated `scope:token` pairs; the split is on the **last** colon, so `authoring:<projectId>` scopes work: `admin:<token>,authoring:<projectId>:<token>` (tokens must not contain `:`) |
| `THIRDLIGHT_EXPORT_ROOT` | export route | e.g. `/home/dadmin/thirdlight/exports` |
| `THIRDLIGHT_ENGINE_ROOT` | export route | the engine checkout root (three/typescript/esbuild install + workspace packages) |
| `THIRDLIGHT_BACKEND_ID` | no | `tb-` + 32 hex (fresh per process if unset) |

Startup validation is strict (config shape, exact origins, token syntax); a
bad config fails fast with a structured one-line error on stderr.

**Authentication.** Bearer tokens only: `admin` (project lifecycle, export,
takeover/release/accept/discard) and `authoring:<projectId>` (sessions,
commands, play). Tokens are never logged, never served, and never embedded in
any static page (the preview page carries only the authoring *origin* string
for the bridge's exact-origin check).

## 4. Startup / shutdown / restart

```bash
# build (once per change)
cd <engineRoot> && npm ci && npm run build

# start (from the engine checkout — esbuild resolves from node_modules)
env THIRDLIGHT_DATA_ROOT=/home/dadmin/thirdlight/data \
    THIRDLIGHT_AUTHORING_ORIGIN=http://127.0.0.1:8501 \
    THIRDLIGHT_PREVIEW_ORIGIN=http://127.0.0.1:8502 \
    THIRDLIGHT_AUTHORING_BIND=127.0.0.1:8501 \
    THIRDLIGHT_PREVIEW_BIND=127.0.0.1:8502 \
    THIRDLIGHT_AUTHORING_ORIGINS=http://127.0.0.1:8501 \
    THIRDLIGHT_EDITOR_DIR=$PWD/dist/editor \
    THIRDLIGHT_PREVIEW_DIR=$PWD/dist/preview \
    THIRDLIGHT_TOKENS='admin:<ADMIN_TOKEN>,authoring:<project>:<AUTHORING_TOKEN>' \
    THIRDLIGHT_EXPORT_ROOT=/home/dadmin/thirdlight/exports \
    THIRDLIGHT_ENGINE_ROOT=$PWD \
    node dist/backend/backend.mjs
# ready when stderr prints:
#   thirdlight-backend: listening (authoring port 8501, preview port 8502)
```

- **Shutdown:** `SIGTERM` ⇒ graceful close (bounded startup log line
  `thirdlight-backend: closed`). Every acked command is already durable, so a
  crash loses nothing acknowledged.
- **Restart:** the new process finds the old process's ownership record
  stale ⇒ commands fail `stale_ownership` until the operator explicitly runs
  **takeover** (`POST /api/v1/admin/projects/<id>/takeover`) — never automatic
  (workspace.md §6). A `released` project needs no takeover (any backend
  claims it, `lockEpoch` + 1).
- **Liveness caveat (documented, bounded):** ownership liveness uses
  `/proc/<pid>` + a process marker (default: argv[0] contains `thirdlight`).
  Launching as `node dist/backend/backend.mjs` does not match the marker, so an
  *ambiguous* live rival is conservatively treated as **live** (rejected — an
  operator investigates); the dead-pid stale path is unaffected. For a
  production marker, name the process (e.g. a launcher named
  `thirdlight-backend`) — see the open items in the M1 report.

## 5. Backup / restore

The durable state is plain files: `<dataRoot>` (workspace) + `<exportRoot>`
(exported trees).

- **Backup:** stop the backend (SIGTERM) or take the copy while it runs
  (atomic per-file writes ⇒ a copy sees whole documents; for a consistent
  multi-project snapshot, stop first), then `tar czf tl-backup.tgz
  <dataRoot> <exportRoot>`.
- **Restore:** stop the backend, replace the directories, start the backend.
  Projects whose owner died during the outage need the explicit **takeover**
  (above); `released` projects are claimed automatically on first open.
  The `.thirdlight/recovery/` snapshots (byte-exact external-change evidence)
  are preserved by the copy and remain resolvable after restore.

## 6. Harness MCP connection

The harness spawns the adapter and speaks MCP over stdio (no network listener):

```
command: node <engineRoot>/dist/mcp-adapter/mcp.mjs
env:
  THIRDLIGHT_MCP_RUN=1
  THIRDLIGHT_AUTHORING_ORIGIN=http://127.0.0.1:8501
  THIRDLIGHT_PROJECT_ID=<projectId>
  THIRDLIGHT_MCP_TOKEN=<authoring:<projectId> token>
  THIRDLIGHT_MCP_CLIENT_ID=<recorded client id, e.g. pi-harness>   (optional)
  THIRDLIGHT_MCP_TIMEOUT_MS=30000                                   (optional)
```

Seven tools (`tl_inspect`, `tl_command`, `tl_sessions`, `tl_play_start`,
`tl_play_stop`, `tl_diagnostics`, `tl_screenshot`) route to the backend's
`/api/v1`; mutations carry `origin: {kind: "mcp", clientId}` and a fresh
`requestId` (Web Crypto). No credentials are printed; the token is the
adapter's only secret.

## 7. Serving exported games

`<exportRoot>/<projectId>@r<revision>/` is a self-contained static tree
(`index.html`, `js/main.js`, `snapshot.json`, `meta.json`) with relative
references only. Serve it with any plain static server
(`python3 -m http.server`, nginx, caddy, …) — the backend, MCP, and model
service are NOT required. `file://` is not supported (the snapshot load is a
relative `fetch`).

## 8. Supplied vs performed (honest scope)

- **Supplied:** this configuration + documentation, the deployment bundle
  build step (`tools/build.mjs`), and the executable entry's env contract
  (sessions.md §13.7 shape).
- **Performed (locally, disposable):** the full M1 acceptance run against a
  fresh instance (`/tmp/tl-m1`, data + exports) including the export tree
  served by an independent static server with the backend stopped —
  `docs/acceptance/m1-report.md`.
- **NOT performed:** no long-running production instance was left up, nothing
  was deployed to the user's host (no task authorization for that), no
  reverse proxy / TLS / service manager was installed (out of M1 scope; the
  config is plain-HTTP loopback by design).