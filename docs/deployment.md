# Deployment

Thirdlight runs as plain Node processes inside the owner's Proxmox LXC. No
containers, no reverse proxy required. Everything below is what the
repository actually does today; the commands are the ones the tests run.

This page is about running the server: requirements, starting it, the
service, a reverse proxy, the owner token, the MCP connection, backup and
restore, upgrading and verification. Building games with it — the editor,
projects, scenes, scripts, every feature — is in the
[manual](manual/index.md).

## Requirements

- Node 22.15 or later in 22 (`engines.node` `^22.15.0`: zstd in `node:zlib` arrived in 22.15; the LXC has v22.22.1), git.
- This shell exports `NODE_ENV=production`, which makes npm skip dev
  dependencies. Install with:

```sh
NODE_ENV=development npm ci --include=dev
```

Importing FBX needs Blender on the server: `THIRDLIGHT_BLENDER` (default
`blender` on `PATH`; this LXC has Blender 5.2.2 in `/usr/local/bin`, which the
systemd unit's default `PATH` includes). How assets are stored, imported and
streamed: [Assets](manual/features/assets.md).

**The bake host.** Final light bakes run Blender Cycles on a bake host:
`THIRDLIGHT_BAKE_HOST` is `user@host` (the backend copies the scene there
with `scp` and runs Blender over `ssh`, so the service user needs a key
login without a passphrase) or `local`; `THIRDLIGHT_BAKE_BLENDER` is Blender
on that host; `THIRDLIGHT_BAKE_TIMEOUT_MINUTES` stops a bake (default 60).
This install bakes on the RTX 5090 workstation (see the systemd unit;
delete both lines there to switch the final bake off). What a bake does:
[Lighting](manual/features/lighting.md).

## Start

```sh
npm start                      # = node tools/start.mjs
```

On the first run this builds `dist/` if needed, creates the data root
`~/thirdlight` (projects under `projects/`, exports under `exports/`,
backups under `backups/`), writes the owner token to
`~/thirdlight/owner-token` (mode 0600) and starts the backend on ports 8501
(editor + API) and 8502 (play preview). It prints:

```
Thirdlight is running.
  editor:   http://127.0.0.1:8501/#token=<token>
  projects: /home/dadmin/thirdlight/projects
  token:    /home/dadmin/thirdlight/owner-token
  MCP:      THIRDLIGHT_AUTHORING_ORIGIN=... THIRDLIGHT_MCP_TOKEN=<the token> node .../mcp.mjs ...
```

Open the printed URL. On a terminal it carries the token
(`#token=...`); when the output is not a terminal (systemd, a log file) the
token is left out and the page asks for it once. The browser stores the token in localStorage; after
that `http://127.0.0.1:8501/` is enough. Ctrl+C stops the backend cleanly
(projects are released for the next start).

Options: `--data-root DIR`, `--port N`, `--preview-port N`, `--build`
(rebuild `dist/` first), `--host HOST`.

**Reaching it from another machine.** The backend allows only exact
origins and the play preview embeds the editor origin, so the browser must
use the origin the backend was started with. Start with the name or address
the browser will use:

```sh
node tools/start.mjs --host 192.168.1.20
# open http://192.168.1.20:8501/#token=<token>
```

This binds 0.0.0.0. There is no TLS and one shared owner token: keep it on a
trusted LAN.

## Run it as a service (systemd)

`deploy/thirdlight.service` runs the start script as `dadmin` at boot,
restarting on failure. It is installed on this LXC (`Pi-CT`, 10.0.10.223):

```sh
sudo cp deploy/thirdlight.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thirdlight
systemctl status thirdlight            # state
journalctl -u thirdlight -n 50         # the printed editor URL (without the token)
sudo systemctl restart thirdlight      # after a rebuild
```

Edit `--host` in the unit if the address browsers use changes. The editor
is then at `http://10.0.10.223:8501/` (token from
`~/thirdlight/owner-token`). The journal never gets the token. Builds
before 2026-09-23 printed it there; if yours did, rotate the token (see
below).

## Behind a reverse proxy

The backend accepts only the exact origins it was started with, and the
play preview is isolated from the editor by origin, so a proxy needs **two
hostnames**: one forwarded to the editor port (8501, WebSocket upgrades
included) and one to the preview port (8502). Tell the start script the
public origins the browser will use:

```sh
node tools/start.mjs --origin https://editor.example --preview-origin https://play.example
```

A single proxied hostname cannot work: the editor's requests arrive with
the proxy's origin and are refused with `bad_origin`, and the preview
iframe must load from a different origin than the editor.

## The owner token

There is exactly one token. It is the `Authorization: Bearer` credential
for the editor, the MCP server and the admin routes.

**No token on your own network.** `--trusted-networks 10.0.0.0/16,127.0.0.1`
(env `THIRDLIGHT_TRUSTED_NETWORKS`) lets requests from those IPv4 ranges in
without a token, and the editor served to them never asks for one — useful
with throwaway browser profiles. Behind a reverse proxy add
`--trusted-proxies <proxy IP>` (`THIRDLIGHT_TRUSTED_PROXIES`): for requests
from the proxy only the client address it forwards in `X-Forwarded-For`
counts (the rightmost one that is not a listed proxy); a proxied request
without that header needs the token. Everything else still needs the token,
and the Origin allowlist still refuses other sites and Play-preview code.
Only for a single-user install that is not reachable from the internet —
anyone on a trusted network is treated as the owner. This LXC's unit trusts
`10.0.0.0/16` and itself, with the proxy `10.0.30.201`. Rotate it by deleting
`~/thirdlight/owner-token` and restarting (browsers then ask for the new
one; the picker has "Forget the access token in this browser").

## MCP (coding harness)

The MCP server is `dist/mcp-adapter/mcp.mjs` over stdio. Register it once,
for every project, in Claude Code's user scope:

```sh
claude mcp add --scope user thirdlight -- sh -c 'THIRDLIGHT_MCP_TOKEN=$(cat ~/thirdlight/owner-token) THIRDLIGHT_AUTHORING_ORIGIN=http://127.0.0.1:8501 exec node /home/dadmin/projects/thirdlight/dist/mcp-adapter/mcp.mjs'
```

Without `THIRDLIGHT_PROJECT_ID` the server works on the folder project the
harness runs in: on the first tool call it asks the backend which registered
project holds the nearest `thirdlight.json` at or above its working folder
(so a session in `~/projects/my-game/src` works on `my-game`). This needs the
harness and the backend on the same filesystem. Outside any project folder,
or in a folder the backend does not know, the tools return an error saying
what to do. Setting `THIRDLIGHT_PROJECT_ID=<id>` pins the server to one
project instead (needed for projects in the data root).

Optional: `THIRDLIGHT_MCP_CLIENT_ID` (recorded as the command origin),
`THIRDLIGHT_MCP_TIMEOUT_MS`. The tools are listed by the server
(`tl_docs`, `tl_inspect`, `tl_command`, `tl_script_publish`,
`tl_diagnostics`, `tl_sessions`, `tl_play_start`/`tl_play_stop`,
`tl_input_exercise`, `tl_game_control`, `tl_game_observe`, `tl_screenshot`,
`tl_content_upload`, `tl_content_job`, `tl_content_query`,
`tl_instance_buffer`, `tl_playtest`). What the play tools do:
[Play tools](manual/features/play-tools.md).

**The manual over MCP.** The server's instructions send an agent to
`tl_docs` first; the tool descriptions are short and point into it.
`tl_docs` answers from the manual the backend read when it started: the copy
`npm run build` puts in `dist/docs/` (this manual, the generated reference and
this page), or, when dist/ has none, the checkout's `docs/`. After pulling a
newer engine, rebuild and restart the service so the manual matches the code
it runs; `tl_inspect target="engine"` shows `manual.dir` and the build.
`GET /api/v1/docs?topic=…|query=…&part=n` answers the same with any token.

### The headless editor

Play tools use the owner's editor browser when it is connected to the
project. When none is, `tl_play_start` makes the backend open the editor
itself in a headless Chromium (`playwright-core`, installed with the engine;
the browser is Playwright's own download, `npx playwright install chromium`)
on the authoring origin with the owner token; screenshots, input and
observations then go through it. It closes after 5 idle minutes
(`THIRDLIGHT_HEADLESS_IDLE_SECONDS`), and when the owner's browser connects
it gives the project up at once. `THIRDLIGHT_HEADLESS=off` switches it off
(play tools then return `session_unavailable` without a browser). Hosts
without Chromium's system libraries (this LXC) set `THIRDLIGHT_BROWSER_LIBS`
to an extracted library tree (see `deploy/thirdlight.service`); the backend
compiles two no-op libavahi stubs into `<dataRoot>/.browser-stubs` with gcc.
WebGL runs on SwiftShader there, so the headless play is slower than a
desktop GPU.

## Backup and restore

Stop the backend (or release the project through
`POST /api/v1/admin/projects/<id>/release`) first; a project a running
backend owns is refused.

```sh
node tools/backup.mjs create my-game            # -> ~/thirdlight/backups/my-game-<UTC stamp>/
node tools/backup.mjs verify ~/thirdlight/backups/my-game-20260922T120000Z
node tools/backup.mjs list
node tools/backup.mjs restore ~/thirdlight/backups/my-game-20260922T120000Z            # same id; refuses if it exists
node tools/backup.mjs restore ~/thirdlight/backups/my-game-20260922T120000Z --as my-game-2
```

A backup is a directory: the project's files plus `backup-manifest.json`
(SHA-256 inventory, written last). Both layouts are handled: a v4 project
(`content.json` + `scenes/*.json`) and an older one (`scenes/main.json`). Copy the directory anywhere; `tar czf`
it if you want one file. Nothing is pruned automatically. `--data-root` and
`--out` override the locations.

**Projects in a game's own folder** ([Projects](manual/features/projects.md#projects-in-a-games-own-folder)).
Backups find folder projects through the registry and copy the **whole game
folder**: the marker, `thirdlight/`, the assets, art sources and `.git` —
everything except Thirdlight's process state (`thirdlight/.thirdlight/`).
The game folder is the bound; nothing outside it belongs to the project.
`--out` may not point inside the game folder. Such a backup restores only
into a new or empty folder, then you register it:

```sh
node tools/backup.mjs restore ~/thirdlight/backups/my-game-20260922T120000Z --folder ~/projects/my-game-restored [--as my-game-2]
node tools/project.mjs register ~/projects/my-game-restored
```

## Upgrade

```sh
node tools/backup.mjs create <each project>       # with the backend stopped
git pull
NODE_ENV=development npm ci --include=dev
npm start -- --build
node tools/project.mjs check ~/projects/<game>    # per folder project; --repin once verified
```

Projects in an older layout are upgraded the first time they are opened
(see [Projects](manual/features/projects.md#projects) and the
[migration notes](manual/features/migration.md)).

## Verification

```sh
tools/gate.sh fast [e2e files…]             # per change: build, vitest, smoke e2e + the named files (minutes)
tools/gate.sh full                          # everything incl. the leak test, before an item is done
tools/gate.sh rerun                         # only the tests that failed last time
npm test                                    # unit + integration (vitest)
npm run build && npm run test:e2e           # Playwright: real backend + Chromium
npx playwright test --project=default       # every spec, WebGL 2 (no WebGPU)
npx playwright test --project=webgpu        # the renderer-sensitive specs with headless WebGPU
node tools/perf/run.mjs                     # the performance harness (long; see manual/features/performance.md)
TL_PERF=1 npx vitest run tests/perf/regression.test.ts   # harness run vs the stored baseline (opt-in)
```

`npm run test:e2e` runs both Playwright projects: `default` (every spec,
Chromium with WebGL 2 on SwiftShader and no WebGPU adapter, so `auto`, the
default, covers the WebGL 2 fallback everywhere) and `webgpu` (the
renderer-sensitive specs again with
`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader`:
Dawn's SwiftShader adapter). The materials, textures, lightmaps,
environment, lights, sky-texture, level-look and shadows specs run once per
renderer variant: `auto` (no flag) and `webgl2` (forced with `?renderer=`)
in `default`, `webgpu` in `webgpu` (the `auto` variant only with
`TL_E2E_ALL_VARIANTS=1` where no WebGPU adapter exists, since it then draws
exactly like `webgl2`); `TL_E2E_WORKERS=<n>` runs spec files in parallel
(`tools/gate.sh` uses 2, its full gate 3 on a GPU host); the shader-parity and env-parity specs
compare every shader type and environment with its reference image (drawn
by the old WebGL renderer and frozen) on WebGL 2 and on WebGPU.

The browser tests need Playwright's Chromium (`npx playwright install
chromium`); on this LXC they use the library tree described in
`tests/e2e/browser-env.mjs`.
