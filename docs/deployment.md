# Deployment

Thirdlight runs as plain Node processes inside the owner's Proxmox LXC. No
containers, no reverse proxy required. Everything below is what the
repository actually does today; the commands are the ones the tests run.

## Requirements

- Node 22 (the LXC has v22.22.1), git.
- This shell exports `NODE_ENV=production`, which makes npm skip dev
  dependencies. Install with:

```sh
NODE_ENV=development npm ci --include=dev
```

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
  MCP:      THIRDLIGHT_AUTHORING_ORIGIN=... THIRDLIGHT_MCP_TOKEN=<the token> ...
```

Open the printed URL. The browser stores the token in localStorage; after
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
journalctl -u thirdlight -n 50         # the printed editor URL is in here
sudo systemctl restart thirdlight      # after a rebuild
```

Edit `--host` in the unit if the address browsers use changes. The editor
is then at `http://10.0.10.223:8501/` (token from
`~/thirdlight/owner-token`). Note the start script prints the token to the
journal, which other local users in `adm`/`systemd-journal` can read.

## The owner token

There is exactly one token. It is the `Authorization: Bearer` credential
for the editor, the MCP server and the admin routes. Rotate it by deleting
`~/thirdlight/owner-token` and restarting (browsers then ask for the new
one; the picker has "Forget the access token in this browser").

## Projects

Open `http://127.0.0.1:8501/` for the picker: it lists every project under
`~/thirdlight/projects/` and creates new ones, empty or from a template.
Templates are directories under the engine's `templates/` or `samples/`
holding `captured/project.json` (+ `assets/`, optional `template.json` with
`name`, `description`, `requiredModules`). `samples/beacon-reach` is the
one shipped today.

A project directory is `project.json`, `scenes/main.json` (the scene +
content envelope) and `sources/sha256/<digest>` (imported asset and script
sources). `.thirdlight/` is process state (ownership, recovery, staging,
derived caches); it is not part of a backup.

## MCP (coding harness)

The MCP server is `dist/mcp-adapter/mcp.mjs` over stdio, one process per
project:

```sh
THIRDLIGHT_AUTHORING_ORIGIN=http://127.0.0.1:8501 \
THIRDLIGHT_PROJECT_ID=my-game \
THIRDLIGHT_MCP_TOKEN=$(cat ~/thirdlight/owner-token) \
node dist/mcp-adapter/mcp.mjs
```

Optional: `THIRDLIGHT_MCP_CLIENT_ID` (recorded as the command origin),
`THIRDLIGHT_MCP_TIMEOUT_MS`. Configure your harness's MCP client with that
command and environment; the tools are listed by the server
(`tl_inspect`, `tl_command`, `tl_diagnostics`, `tl_sessions`,
`tl_play_start`/`tl_play_stop`, `tl_input_exercise`, `tl_game_control`,
`tl_game_observe`, `tl_screenshot`, `tl_content_upload`, `tl_content_job`,
`tl_content_query`). Play tools need an editor browser
connected to the project; without one they return `session_unavailable`.

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
(SHA-256 inventory, written last). Copy the directory anywhere; `tar czf`
it if you want one file. Nothing is pruned automatically. `--data-root` and
`--out` override the locations.

## Independent game projects

A game can live outside the engine's data root, in its own directory and
git repository, pinned to the engine it was built with:

```sh
node tools/game.mjs create ~/games/reach --id reach --name "Reach" --template beacon-reach
node tools/game.mjs start  ~/games/reach          # the editor on that game (same options as start.mjs)
node tools/game.mjs check  ~/games/reach          # this engine vs the pin
node tools/game.mjs export ~/games/reach --out ~/games/reach/build
```

`game.json` records the engine version, git commit and lockfile digest.
`check` and `export` refuse a mismatch; after upgrading the engine on
purpose, `check --repin` records the new engine. The export is a static
directory that needs nothing else (serve it with any web server). The game
directory's `.gitignore` keeps process state, exports, backups and the
token out of git; `projects/` (sources included) is what you commit.

## Upgrade

```sh
node tools/backup.mjs create <each project>       # with the backend stopped
git pull
NODE_ENV=development npm ci --include=dev
npm start -- --build
node tools/game.mjs check ~/games/<game>          # per independent game; --repin once verified
```

## Verification

```sh
npm test                                    # unit + integration (vitest)
npm run build && npm run test:e2e           # Playwright: real backend + Chromium
```

The browser tests need Playwright's Chromium (`npx playwright install
chromium`); on this LXC they use the library tree described in
`tests/e2e/browser-env.mjs`.
