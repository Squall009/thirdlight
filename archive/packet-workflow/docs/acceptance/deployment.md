# Thirdlight — minimal self-host deployment (M1 + M2 additions)

Version 0.2 · M1 packet 13 (2026-09-18) + M2 packet 37 (2026-09-19). Describes the **actual server
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

## 5. Backup / restore (M4: the reliability.md §1–§2 procedure — accepted at Gate Q, replacing the raw-`tar` text whose rationale is recorded in `docs/planning/m4-contracts/diffs/deployment.md`)

The durable state is plain files: `<dataRoot>` (workspace) + `<exportRoot>`
(exported trees). The M4 backup is an **inventory-based, verified** copy of
the accepted consistent set (workspace.md §15: the manifest, the envelope
and every `sources/sha256/<digest>` file — all versions, including
superseded; staging/derived/ownership/recovery/migration/temp files are
excluded and must never be restored):

- **Backup** (`backup` — the packet-75 tooling, reliability.md §1): the
  backend stopped (or the project released) — a project with a LIVE owner
  is refused (`backup_live_project`, bytes untouched). The tool copies the
  consistent set into `<backupDir>/projects/<projectId>/…` with per-file
  digests and writes `backup-manifest.json` LAST (a directory without a
  valid manifest is `backup_incomplete` — never a backup). `retention` is
  **manual**: no tool prunes sources or backups.
- **Verify** (`verify` — before any restore): re-hash the inventory
  (truncation / bad hash / missing-or-superseded blob / ownership-included /
  path-escape checks — reliability.md §1.4). A bad backup never reaches the
  filesystem.
- **Restore (same ID)** (`restore`): the verified set into a **clean,
  empty, same-`projectId`** destination (a nonempty destination is refused —
  `restore_destination_nonempty`; the existing destination is never
  modified). No ownership is restored; `released` projects are claimed
  automatically on first open; projects whose owner died during the outage
  still need the explicit **takeover** (unchanged — the old text's note
  stands). The accepted post-restore verification (workspace.md §15)
  applies.
- **Create (new ID)** (`create`): the same verified set with a new identity
  (manifest `id`, envelope `projectId` and directory name rewritten to the
  new id — a documented operator copy, distinct from restore).
- **Diagnostics:** `GET /api/v1/admin/health` (admin scope) returns the
  bounded, redacted point-in-time report (reliability.md §3: ≤ 32 KiB, no
  credentials, no absolute paths, `backendId`-tagged — re-fetch after any
  restart).
- The `.thirdlight/recovery/` snapshots remain optional operator-retained
  evidence (unchanged: never part of the consistent set, never restored over
  the envelope).

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

**M4 (accepted at Gate Q):** two authoring-scope tools and one admin-scoped
tool are added — ten tools total:

| Tool | Scope | Arguments | Routes to |
|---|---|---|---|
| `tl_project_create` | admin-scoped token only (C65-6) | `projectId`, `name`, `templateId` | the `POST /api/v1/admin/templates/projects` route (workspace.md §8.4): the identity-carrying result or the §11 template error set (bounded, structured) |
| `tl_templates_list` | any authoring scope (C65-7) | — | the installed verified templates: descriptor summaries (`templateId`, `name`, `version`, `engineVersion`, `contentDigest`) — never bytes, never recipe contents |
| `tl_health` | admin scope, read-only (C67-2) | — | `GET /api/v1/admin/health` (sessions.md §6.3; the §11.5 envelope) |

The accepted "no alternate mutation engine" rule applies: every tool
routes into the backend's `/api/v1` surface via the same `BackendClient`.

## 7. Serving exported games

### 7.1 M1 exports (schemaVersion 1, unchanged)

`<exportRoot>/<projectId>@r<revision>/` is a self-contained static tree
(`index.html`, `js/main.js`, `snapshot.json`, `meta.json`) with relative
references only. Serve it with any plain static server
(`python3 -m http.server`, nginx, caddy, …) — the backend, MCP, and model
service are NOT required. `file://` is not supported (the snapshot load is a
relative `fetch`).

### 7.2 M2 exports (schemaVersion 2; packet 36)

An M2 export tree is

```text
<projectId>@r<revision>/
  index.html
  js/main.js                       the shared runtime bundle (no backend)
  manifest.json                    the immutable runtime-content manifest
  scene.json                       the captured scene document (sceneDigest-verified)
  content/sha256/<64-hex>          one GLB per reachable asset version (byte-identical blob)
  behaviors/<64-hex>.js            one compiled behavior output per reachable source behavior
  meta.json                        export metadata (schemaVersion 2)
```

It is still one static tree with relative references only, but the deployment
records below are **required** (an M2 export will not run without them). No
service, no CDN and no external request is involved: the page reads only
`./manifest.json`, `./scene.json` and the manifest-declared `./content/sha256/…`
paths (same-origin, one read per unique path).

**Non-root subpath is supported and is the verified shape.** The acceptance
evidence serves a tree under a non-root prefix (e.g.
`http://127.0.0.1:8600/games/<projectId>@r<revision>/`); every reference in the
output is relative, so any prefix works as long as the prefix is preserved in
the URL (do not strip the directory when serving).

**MIME records (required).** The digest-addressed artifact paths carry **no
file extension**, so an extension-only MIME map serves the GLB as
`application/octet-stream` and some browsers then refuse to decode it. Map by
path class:

| Path | `Content-Type` |
|---|---|
| `content/sha256/<64 hex>` | `model/gltf-binary` |
| `behaviors/<64 hex>.js`, `js/main.js` | `text/javascript; charset=utf-8` |
| `manifest.json`, `scene.json`, `meta.json` | `application/json; charset=utf-8` |
| `index.html` | `text/html; charset=utf-8` |
| `*.wasm` (only if a future export emits a separate module) | `application/wasm` |

`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are
recommended on every response (the packet-36 evidence server sets both).

**nginx (static, non-root prefix):**

```nginx
location /games/ {
  alias /home/dadmin/thirdlight/exports/;
  types { }
  default_type application/octet-stream;
  location ~ "^/games/(?<exp>[^/]+)/content/sha256/[0-9a-f]{64}$" {
    alias /home/dadmin/thirdlight/exports/$exp/content/sha256/;
    default_type model/gltf-binary;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer;
  }
  location ~ "^/games/(?<exp>[^/]+)/behaviors/[0-9a-f]{64}\.js$" {
    alias /home/dadmin/thirdlight/exports/$exp/behaviors/;
    default_type "text/javascript; charset=utf-8";
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer;
  }
  location ~ "\.wasm$" { default_type application/wasm; }
  location ~ "\.(js|json|html)$" {
    default_type "text/javascript; charset=utf-8";
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer;
  }
}
```

**CSP (recommended for an M2 export):** the page needs no network origin
beyond its own, no inline script and no worker:

```text
default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:;
style-src 'self'; font-src 'none'; worker-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`connect-src 'self'` is required (the relative manifest/scene/asset reads);
`script-src 'self'` is required (the module script). WASM initialization is
inlined in the pinned Rapier compat build today, so no separate `.wasm`
response is needed — a future separately emitted module needs
`application/wasm` and a CSP that permits `wasm-unsafe-eval` (or a hash).
The real-browser WASM-init/CSP behaviour is **UNVERIFIED** in this environment
(no browser in-container): the packet-36 procedure is in
`docs/acceptance/evidence-m2/36/manifest.md`; packets 14/31 recorded the same
limitation.

**Python one-liner (compatible with the packet-36 evidence server):**
`python3 -m http.server` serves an extension-less GLB as
`application/octet-stream`, so an M2 tree served that way may fail to load
models in a strict browser; use the nginx/`http.server` wrapper with the path
rule above for an M2 export (the M2 acceptance evidence used a small Node
static server implementing exactly this table).

## 8. M2 content, behavior trust and secure-context topology (supplied)

### 8.1 M2 setup additions

The M1 startup is unchanged. M2 adds no new `THIRDLIGHT_*` variable; it adds
content/behavior operations on the running instance.

```bash
# 1. (optional) migrate an M1 project to an M2 project — operator action, no HTTP route
#    (workspace.md §14): new project id, manifest stays v1, scene v1→v2,
#    storageVersion 1→2, revision reset to zero, source retained byte-for-byte.
#    Re-run the same call to resume a crashed destination, or delete the
#    (never-authoritative) destination directory. No automatic completion.

# 2. import a GLB through the authoring HTTP routes (editor Asset Browser or MCP):
#    POST   /api/v1/projects/<id>/content/stages
#    PUT    /api/v1/projects/<id>/content/stages/<stageId>/bytes   (X-Thirdlight-Offset/Total)
#    POST   /api/v1/projects/<id>/content/stages/<stageId>/inspect
#    POST   /api/v1/projects/<id>/commands   { op: "publishAsset", ... }

# 3. publish a trusted behavior (packet 33/35): stage the canonical source
#    container exactly as a GLB, then acknowledge trust and prepare+publish:
#    POST   /api/v1/projects/<id>/commands   { op: "publishBehavior", mode: "declaration-create" }
#    POST   /api/v1/projects/<id>/commands   { op: "acknowledgeBehaviorTrust", args: { sourceDigest } }
#    POST   /api/v1/projects/<id>/content/behaviors/source   { stageId, behaviorId, declaration, ... }
```

### 8.2 Behavior trust acknowledgment (binding)

M2 behaviors are **trusted main-thread TypeScript**, compiled on the backend
**without executing project source**, and then run in the browser on the main
thread. There is **no sandbox and no hard runtime timeout**; the static
import/dynamic-code restrictions and the output scan are defense in depth only
(decision 0002 §5). The durable `acknowledgeBehaviorTrust` gate precedes the
first compile/publication of each source digest, and an M2 export presents the
same trust notice before starting the game (packet 36). Do not weaken this
notice; a hard boundary would require a separate execution-boundary design
packet.

### 8.3 Secure-context / gamepad topology (BR-3 — owner decision still open)

| Topology | `getGamepads` / physical controller | Who must decide |
|---|---|---|
| `http://127.0.0.1:<port>` (the default loopback deployment) | available (loopback is a secure context) | — |
| `http://<lan-ip>:<port>` plain HTTP | **not** a secure context ⇒ the controller API is absent/denied; the input layer degrades to keyboard only and reports the structured `input_unavailable` state | **owner** — choose this knowingly or deploy TLS |
| HTTPS / localhost with TLS | available | owner (no TLS was installed by this project) |

The play preview iframe must carry `allow="gamepad"` (packet 35 sets it) or
the policy blocks the API even in a secure context. WASM (Rapier `-compat`) is
inlined, so no separate `.wasm` response is needed today; if a future export
emits one, serve it as `application/wasm` and allow `wasm-unsafe-eval` (or a
hash) in the CSP. The secure-context decision is the owner's and is recorded as
open; no TLS or reverse proxy was installed by any M2 packet.

## 9. M2 source-backup classification (supplied)

An M2 project's durable state is the same single envelope plus immutable
content-addressed bytes:

| Path | Classification | Notes |
|---|---|---|
| `project.json` | **authoritative** | immutable manifest (stays schemaVersion 1) |
| `scenes/main.json` | **authoritative** | the single envelope: scene + `content` catalog + behavior records/source digests |
| `sources/sha256/<digest>` | **authoritative** | every GLB version and every canonical behavior source container; write-once, verified on read |
| `.thirdlight/{ownership,claim-*}.json` | operational | ownership liveness; restore may require an explicit takeover |
| `.thirdlight/recovery/**` | evidence | byte-exact external-change snapshots |
| `.thirdlight/staging/**` | **non-authoritative** | bounded open upload stages (TTL 3 600 s); safe to lose |
| `.thirdlight/derived/**` | **non-authoritative, regenerable** | derived caches keyed by `sourceDigest`/`recipeDigest` |
| `<exportRoot>/<id>@r<rev>/**` | reproducible output | a static M2 game tree; re-export from the authoritative state |

**Complete M2 backup** = `project.json` + `scenes/main.json` + **all** of
`sources/sha256/**` (there is no M2 garbage collection, so superseded versions
must be kept for undo/history/pins). Deleting `.thirdlight/derived/**` or
`.thirdlight/staging/**` is always safe.

**Restore:** stop the backend, restore the directories, start the backend, and
run an explicit **takeover** for any project whose owner died during the
outage (`POST /api/v1/admin/projects/<id>/takeover`); `released` projects need
none. The packet-37 journey proved this: after a `SIGKILL`, a session attempt
returned structured `stale_ownership`, takeover succeeded and a source backup
restore brought a fresh Play back to `200`
(`docs/acceptance/evidence-m2/37/journey/08-durability.json`).

## 10. Supplied vs performed (honest scope)

- **Supplied:** this configuration + documentation, the deployment bundle
  build step (`tools/build.mjs`), the executable entry's env contract
  (sessions.md §13.7 shape), the M2 export tree layout/MIME/CSP records (§7.2),
  the operator migration API, the behavior trust acknowledgment gate and the
  source-backup classification (§9).
- **Performed (locally, disposable):** the full M1 acceptance run against a
  fresh instance (`/tmp/tl-m1`, data + exports) including the export tree
  served by an independent static server with the backend stopped —
  `docs/acceptance/m1-report.md`. For M2, packet 37 ran the **built deployed
  artifacts** (`dist/backend/backend.mjs`, `dist/mcp-adapter/mcp.mjs`) on a
  disposable data + export root: migration copy, GLB import/reimport,
  prefab/property flows, behavior publish/trust/compile, Play locator + bounded
  MCP input relay, `SIGKILL` + takeover + retry, tamper/missing/backup restore,
  double export, failure isolation and backends-stopped static serving
  (`docs/acceptance/evidence-m2/37/**`, `docs/acceptance/m2-report.md`). A
  disposable `npm ci` clean-install copy passed the full toolchain.
- **NOT performed:** the real-browser/GPU/keyboard/gamepad procedures and the
  real rendered PNG/screenshots (`m2-report.md` §8); the packet-14 desktop
  physics evidence; nothing was deployed to the user's host; no reverse proxy /
  TLS / service manager was installed (out of M1/M2 scope; the config is
  plain-HTTP loopback by design). The secure-context/gamepad topology decision
  (BR-3) remains the owner's.