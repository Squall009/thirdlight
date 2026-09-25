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

## Projects

Open `http://127.0.0.1:8501/` for the picker: it lists every project under
`~/thirdlight/projects/` and every registered folder project (see "Projects
in a game's own folder"), and creates new ones, empty or from a template.
Templates are directories under the engine's `templates/` or `samples/`
holding `captured/project.json` (+ `assets/`, optional `template.json` with
`name`, `description`, `requiredModules`). `samples/beacon-reach` is the
one shipped today.

A project directory holds:

- `project.json`: id, name, engine version (schemaVersion 2);
- `content.json`: assets, prefabs, scripts, settings, the game block, tags,
  the scene list and the start scenes;
- `scenes/<sceneId>.json`: one file per scene;
- `sources/sha256/<digest>`: imported asset and script sources, and
  instance-set buffers. A folder project's assets can instead stay in the
  game folder, see "Assets referenced in place".

An edit writes only the files it changed. An edit that touches several files
(a new scene: the index plus its file) goes through a small redo journal
(`.thirdlight/journal.json`), so a crash in the middle is completed at the
next open. `.thirdlight/` is process state (ownership, recovery, staging,
derived caches, the journal); it is not part of a backup.

**Older projects upgrade automatically** the first time the backend opens
them. A v3 project (one `scenes/main.json` envelope) becomes one scene,
"Main" (`scenes/scene-main.json`); the old envelope is kept as
`.thirdlight/migrated-v3/main.json`. The level bounds are dropped. A kill
height becomes a "Fall zone" hazard zone below the old level. Falls are game
rules now: a hazard zone, or a script (see "Scenes"). Take a backup first if
you want the old files outside `.thirdlight/`.

## Workspace tabs

The centre area holds **Scene**, **Game** and any number of document tabs
next to them. Double-click an animator controller (bottom dock → Animator,
the controller list under the toolbar, or **Open in tab**) to open
"Animator: <controller>", or a behavior tile (bottom dock → Behaviors) to
open "Script: <behavior>". The document takes over the centre area: the
Animator tab is the full state-graph editor for that one controller
(states, transitions, layers, parameters, live preview — see "Animation
(Animator)" below); the Script tab is
the behavior's code editor (see "Script editor" below) with its declaration
editor docked beside it. Edits
are the same commands as in the bottom dock (one undo step each; Ctrl+Z
works while a document is in front; the scene's own shortcuts — Delete,
W/E/R, F, copy/paste — do not act on the hidden scene).

Opening a document that is already open focuses its tab. Document tabs close
with their **×** or a middle click; Scene and Game cannot be closed. Drag a
tab onto another to reorder. **Ctrl+Tab** / **Ctrl+Shift+Tab** (or Window →
Next tab / Previous tab) cycle through all tabs. Some browsers keep
Ctrl+Tab for their own tabs in a normal window; the Window menu entries
always work. The **⤢** button at the right of the tab strip (or Window →
Maximize centre area) hides the docks so the centre fills the window; press
it again to restore them. The open tabs, their order, the active tab and
the maximize state are remembered per project in the browser's layout
storage (Window → Reset layout forgets them). A tab whose document was
deleted says so; close it.

## Script editor

The "Script: <behavior>" tab edits a behavior's TypeScript source.

- **Files**: the list on the left holds the behavior's source files
  (`src/index.ts` is the entry; its `export default { step(state, ctx) {…} }`
  is the behavior). **+ File** adds one (lower-case path ending in `.ts`,
  e.g. `src/util.ts`; import it with a relative path, `import { f } from
  './util'`), **Rename** and **Delete** act on the open file (the entry
  stays). At most 16 files of 64 KiB each. `behavior-api.d.ts` (italic) is
  the behavior API — what `ctx` offers, with its documentation — read-only.
- **Code**: TypeScript highlighting, bracket matching, find (Ctrl+F),
  undo per file. Completion (Ctrl+Space, or while typing after a `.`)
  offers the behavior API: `ctx.` lists the context (`ctx.game.`,
  `ctx.timers.`, `ctx.animator(id)?.` go deeper), and type names after `:`
  or in `import type { … } from '@thirdlight/runtime'`. Any name annotated
  with an API type (`info: BehaviorInstanceInfo`) completes too; `ctx`
  always means the step context. Type-only imports from
  `@thirdlight/runtime` are erased by the compiler (the editor adds the
  module to the source's required modules for you).
- **Compile**: **Ctrl+S** (or **Compile**) and a short pause after typing
  compile the source with the backend's pinned compiler — the same one
  publishing uses — without publishing or storing anything. Problems are
  underlined in the code, marked in the gutter, counted on their file and
  listed under the code (`src/index.ts:7:96 …`; click one to jump there).
  The compiler checks syntax, imports and the declaration; it does not
  type-check, so a misspelt member shows only when the script runs.
- **Publish**: compiles again and publishes the source through the ordinary
  source route — one `publishBehavior` command, one undo step. A source
  digest that was never acknowledged first shows the trust notice and asks
  for the acknowledgment of that exact digest (its own command). Play then
  runs the new code (a running Play keeps the code it started with).
- **Beside the code**: **Moves (owned transforms)** — the objects this
  script may move (`@self` = the object carrying it, or object ids) — and
  the declaration editor (properties, visibility, groups; read-only when
  the code declares `export const properties`).

Unpublished edits are kept while the page is open (switching tabs keeps
them) and are lost on a reload; the tab shows "unpublished edits" until
they are published. When another client publishes the same behavior, an
unedited tab follows; an edited one says so and publishing replaces it.

## The Inspector

The Inspector shows the selected object's name, flags and tags, then one
section per component, built from the engine's component descriptions (the
same ones MCP reads with `tl_content_query {target: "game",
includeDescriptors: true}`): every stored field has a control, with its unit
in the label and what it does in the tooltip. Numbers have a text box (Enter
or leaving the box commits, Escape reverts) and, when bounded, a slider
(commits on release); whole numbers, switches, choices, colours, vectors
(one box per axis), rotations (degrees), asset pickers (only assets of the
right kind — models, sounds, music, textures), object pickers (only objects
with the right component, e.g. a spawn), scene pickers, material, animator,
script and prefab pickers, signal names (with the names already in use as
suggestions), texts, nested groups (a **+ add** / **×** pair for optional
ones, such as camera bounds), and lists (waypoints, scenes: **+ add** and
**×** per item). A field left at its engine default shows its label in
italics; an optional field set back to its default is removed from the data.
Fields that only apply to one variant appear when it is chosen (a circle
trigger's radius, a spot light's cone): switching fills the new variant's
fields from its preset or default and drops the old ones, in the same edit.

Every edit is one command and one undo step (Edit → Undo, Ctrl+Z); a
refused edit says why under the section (e.g. "the start scenes together
hold exactly one active camera") and changes nothing.

**+ Add component** (and the Component menu, the same list) offers every
component by category, with its presets (Light: directional, ambient, point,
spot, hemisphere; Zone: hazard, goal; Collider: box, polygon). A component
that needs a choice first — a model's asset, a script, an animator's
controller, an audio source's sound, a material mapping — opens a small form
with just that choice and **Add**. Components that cannot be added are
listed greyed with the reason: already on the object, excluded by another
one ("an object shows one model, box or camera"), needing another one (a
surface needs a box or a model; camera follow needs the camera), or made by
a tool (instance sets, prefab copies, folders). Each section has **remove**;
box, camera and model are added and removed like any other component
(`setComponent` with a complete value / `null`).

Some sections have extra tools next to the generic fields: the player
controller's capsule (**Fit to model**, **Default**), an exit zone
(**Edit exit…**), a surface (presets), an object's materials (the mapping
editor, which knows the model's own material names) and a script (its
declared properties). The game block (Gameplay → Game: texts, the player,
camera and start spawn, and the sound cues as sound pickers) is built the
same way, and so is Gameplay → Settings (every project setting, the engine
settings included; the step rate is a choice of 60, 120 or 240 Hz; each
change is saved at once); the Gameplay tab's Camera page points to the camera object, whose
lens and follow settings are Inspector sections. The Media tab is for
listening to the project's sounds.

## Hierarchy: folders and flags

- **Folders** (GameObject → Folder, or `createEntity {kind: "folder"}`)
  only organise. A folder has no transform and sits at the root or inside
  another folder, never under an object. Filing something into a folder keeps
  it where it is in the world. Zones, spawns and physics bodies may sit in
  folders (they still may not sit under a transformed object).
- **The tree.** The arrow collapses a row. Which rows are collapsed is
  remembered in this browser, per project; it is not written to the project.
  Click selects, Ctrl/Cmd+click toggles, Shift+click selects a range. Drag a
  row, or a selection, onto the top or bottom edge of a row to place it
  before or after that row, or onto its middle to file it inside. Drop on the
  empty list area to move it to the end of its scene's root. Every drop is one
  `moveEntities` command, so it is one undo step. Moves keep world
  positions; moving out of a rotated or scaled parent re-expresses the local
  transform. Delete removes every selected subtree, one undo step each.
- **Flags** (inspector: Active, Locked, Static; `updateEntity {active,
  locked, static}`) are stored on the entity in the scene, only when they
  differ from the default.
  - A folder passes all three down to everything inside it.
  - An inactive object also deactivates its own children.
  - The inspector shows the entity's own value, and next to it any value it
    inherits and from where.
  - Inactive: hidden in the Scene view and left out of Play and the export.
    The scene camera and an active checkpoint's safe spawn must stay active.
  - Locked: editor only. The object cannot be picked or moved in the Scene
    view, but can still be selected in the hierarchy.
  - Static: stored and inherited; nothing uses it yet.
- `updateEntity` with `parentId` keeps the world position too (it used to
  keep the local values).

The game resolves folders and flags once, when a scene loads. Folders and
inactive entities are removed, and each entity gets its effective `static`.

## Tags

- **The registry** (bottom dock → Tags, or File → Project tags) holds up to
  32 named tags. Each tag has a fixed bit (0–31):
  - Renaming keeps the bit, so every object keeps the tag.
  - A new tag takes the lowest free bit.
  - A tag can be removed, which frees its bit, only when no object carries it.
  - Names are a letter followed by letters, digits, `_` or `-`, 32 characters
    at most, and unique ignoring case.
  - The registry is stored in the scene envelope's content block as
    `content.tags`, and only when it is not empty. Every edit is one `setTags`
    command, so it is one undo step.
- **On objects.** Each object stores its own tags as a 32-bit mask (`tags`,
  stored only when non-zero). The inspector's Tags section toggles them.
  `updateEntity {tags: [names]}` replaces an object's tags; names ignore
  case. A folder's tags reach everything inside it, and the inspector marks
  those as "inherited from a folder". An object's effective mask is its own
  mask OR every folder above it.
- **In the game.** The effective masks are computed once when the scene
  loads. Inactive objects are left out. Scripts get `ctx.tags`, in
  `instantiate` (as `inst.tags`) and in every `step`:
  - `mask(...names)` returns the bits of the named tags; an unknown name
    throws.
  - `of(entityId)` returns an object's effective mask.
  - `has(entityId, mask, 'any' | 'all')` tests an object.
  - `query(mask, 'any' | 'all')` returns object ids in scene order. It is
    computed once per mask.
  The registry travels in the Play/export manifest (`tags`), so an exported
  game needs nothing else.
- **MCP.**
  - `tl_command setTags {tags: [{bit?, name}]}` replaces the registry: an
    entry with `bit` keeps it, an entry without one gets the lowest free bit.
  - `updateEntity {tags}` sets an object's tags.
  - `tl_inspect target="project"` lists the registry.
  - `tl_inspect target="entity"` shows `tagNames: {own, effective}`.

## Scenes

A project has one or more scenes (up to 64), one file each. Entity ids are
unique across the whole project. One command edits one scene.

- **Start scenes.** The game starts with the scenes in the start set,
  merged. The camera, the player, the lights and the start spawn live only
  in start scenes.
- **In the editor.** Each open scene is a header in the hierarchy.
  - Click a header to make that scene active. New root objects go into the
    active scene; a child goes into its parent's scene.
  - **+ Scene** creates a scene, which becomes the active one.
  - Double-click a header name to rename the scene.
  - ★ adds the scene to the start set, or takes it out.
  - 🗑 deletes a scene. It shows only on an empty scene.
  - × closes a scene in this browser. Closed scenes are listed under
    "open scene…". Which scenes are open is remembered per browser, not in
    the project.
  - Dragging objects to another scene is refused; moving between scenes
    comes later.
  - An editor session loads up to 65 536 objects over all scenes.
- **Loading at run time.** Scripts get `ctx.scenes`:
  - `load(sceneId, {at?: [x, y, z]})` requests a load. The page fetches
    `scenes/<id>.json` and checks its digest; the scene joins at the next
    step boundary. `at` offsets its root objects.
  - `unload(sceneId)` removes the scene at the next boundary.
  - `status(sceneId)` returns `unloaded`, `loading` or `loaded`.
  - `loaded()` lists the loaded scenes.
  - A loaded scene brings its colliders, script instances, tags and zones.
    An unload releases them: colliders leave the physics world, scripts get
    `dispose`, meshes and textures are freed, and a model no loaded object
    uses any more is released.
  - A scene holding the camera, the player, the start spawn or a light
    cannot be unloaded.
  - A replay returns to the start scenes.
  - A checkpoint whose scene was unloaded no longer counts.
- **Exit zones** (GameObject → Zone → Exit zone…; the inspector's
  "Edit exit…"). An exit zone lists scenes to load and scenes to unload
  when the player enters it. It can also name a spawn: once those scenes are
  loaded, the player is moved there.
- **Game rules in scripts.** There are no level bounds or kill heights any
  more.
  - `ctx.world.transform(entityId)` reads any loaded object's current
    position, rotation and scale.
  - `ctx.emit({kind: 'respawn'})` (intent phase) kills the player.
  - `ctx.emit({kind: 'pose', entityId, rotation: {yaw, pitch, roll}, scale})`
    (transform phase, an entity the script owns; degrees, applied yaw then
    pitch then roll; `scale` is a number or `[x, y, z]`; either may be left
    out) turns or scales it — a spinning coin, a pulsing gem. It is visual:
    colliders keep their shape.
  - Camera bounds are optional (Gameplay → Camera → "Keep the camera
    inside bounds").
- **Play and export** ship every scene file and load the others on demand.
  An exported game needs nothing else.
- **MCP.**
  - `tl_command createScene {name, sceneId?}`, `renameScene`,
    `deleteScene` (only an empty scene), `setStartScenes {sceneIds}`.
  - `createEntity`/`instantiatePrefab` take `sceneId`.
  - `tl_inspect target="entities"` takes `sceneId` and names every entity's
    scene; `target="project"` lists the scenes.
  - `tl_game_control` takes `loadScene`/`unloadScene` with `sceneId`.
  - The game observation lists the loaded scenes.

## Instance sets

An instance set is one object that draws many copies of one model (up to
65 536) with instancing. Use it for foliage, rocks and other repeated
detail. Copies have no ids, colliders or scripts.

- The copies' placements are a buffer: 10 float32 per copy (position xyz,
  rotation quaternion xyzw, scale xyz, local to the object). It is stored by
  its SHA-256 like an asset source. `POST .../content/buffers` publishes one
  from `{transforms: [...]}` (up to 4096 copies inline) or `{stageId}` (an
  uploaded stage); `GET .../content/buffers/<digest>` reads it.
- GameObject → **Instance set…** scatters copies of a model on the ground
  plane around the point the camera looks at. You choose the count, width,
  depth, scale range and random turn; a seed repeats the same layout. The
  object's transform moves, turns and scales the whole set.
- MCP: `tl_instance_buffer {transforms}` returns `{digest, count}`. Then
  `createEntity {kind: "group", components: {instances: {asset: {assetId},
  buffer, count}}}`.
- Single copies (phase 15.2): with the set selected, click one of its copies
  in the Scene view. The gizmo then moves, turns or scales just that copy
  (W/E/R), **Del** (or **Delete copy**) removes it, **Whole set** goes back
  to the set. **Brush: add copies** paints new copies where you click or drag
  in the Scene view (upright, scale 1, at least 1 m apart). Every edit
  publishes a new buffer and stores it with one `setComponent instances
  {buffer, count}` — one undo step; the old buffer stays, so undo points back
  to it. MCP does the same: `tl_instance_buffer {digest}` reads a set's
  copies (`{digest, count, transforms}`, sets of up to 4096 copies), edit the
  list, publish it, `setComponent`.

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
(`tl_inspect`, `tl_command`, `tl_diagnostics`, `tl_sessions`,
`tl_play_start`/`tl_play_stop`, `tl_input_exercise`, `tl_game_control`,
`tl_game_observe`, `tl_screenshot`, `tl_content_upload`, `tl_content_job`,
`tl_content_query`, `tl_instance_buffer`).

`tl_content_query {target:"game", includeDescriptors:true}` also returns the
component and content descriptor registry: for every component and content
block, each field's type, unit, range, step, default, group, label, tooltip,
when it applies and which Scene-view handle edits it (about 120 KB; the
command route answers `queryGameConfig {args:{descriptors:true}}` the same
way, and the editor reads it with its first game query).

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

## Projects in a game's own folder

A project can live in the game's own folder (its git repository) instead of
the data root. One backend serves all projects; `~/thirdlight/registry.json`
maps each such project id to its folder. The folder holds:

- `thirdlight.json` — the marker: project id, name, the subfolder name and
  the engine pin (version, git commit, lockfile digest);
- `thirdlight/` — the project files (the same layout as above) and a
  `.gitignore` keeping `.thirdlight/` process state out of git. Commit the
  marker and `thirdlight/`.

In the picker, "Folder on the server" under New project creates one (the
folder may not exist yet; it may not overlap the data root or another
project); "Open project folder" registers an existing folder holding a
`thirdlight.json`; "remove" on a folder project forgets it and never touches
its files. A registered folder that goes missing is listed as "folder
unavailable" until it is back. From the shell, with the backend running:

```sh
node tools/project.mjs create ~/projects/my-game --id my-game --name "My game" [--template beacon-reach]
node tools/project.mjs register ~/projects/my-game       # an existing folder
node tools/project.mjs unregister my-game                 # files are kept
node tools/project.mjs list
node tools/project.mjs check ~/projects/my-game [--repin] # this engine vs the pin (offline)
node tools/project.mjs export ~/projects/my-game --out ~/projects/my-game/build
```

`--origin` and `--token-file` override `http://127.0.0.1:8501` and
`~/thirdlight/owner-token`. The engine pin is advisory in the editor: a
different version or lockfile is shown in the picker and in Problems, a
different commit alone is normal after an upgrade; the project still opens.
`project.mjs export` refuses a version or lockfile mismatch unless
`--force`; `check --repin` records this engine once you have checked the
game. The export is a static directory that needs nothing else.

### Assets referenced in place

In a folder project, an asset can stay where the game keeps it (for example
`assets/env/kit/meadow/env_kit_meadow.glb`, built by a script, in Git LFS)
instead of being copied into `thirdlight/sources/`. The asset version records
the file's path relative to the game folder and its SHA-256; nothing is
copied. Projects in the data root keep copying uploads as before.

- **Import.** Assets tab → "from project folder…" opens a picker limited to
  the game folder (it starts in `assets/`; hidden entries, `.git` and
  `thirdlight/` are not offered, and a symlink that leads out of the folder is
  refused). "reimport from folder…" records a file as a new version of the
  selected asset. The MCP server does the same:
  `tl_content_query {target:"projectFiles", dir:"assets"}` lists a folder,
  `tl_content_upload {projectPath:"assets/props/crate.glb"}` inspects the file
  in place and returns `sourcePath`, and `tl_command publishAsset` with
  `sourcePath` in its args records it — the same command the editor sends.
  Paths are always relative to the folder holding `thirdlight.json`.
- **Reads are verified.** Every read (the editor view, Play, export) checks
  that the file is still inside the game folder and still has the recorded
  SHA-256. A changed file is `asset_source_changed`, a missing one
  `asset_source_missing`; other bytes are never used.
- **When a file changes** (a Blender rebuild): the editor checks the files
  when it opens a project, when its window gets focus back, after each import
  and on "check files" in Problems. Problems then says which asset and file
  changed and offers **Re-import**, which records a new version with the new
  bytes as one undoable command. There is no file watcher: the check on focus
  covers switching back from Blender, rebuild scripts write many files at
  once, and the reads are verified anyway. Older versions of that asset can
  no longer be read once the file changed; Problems says so. They stay in the
  history, and come back if the old bytes do (for example `git checkout`).
- **Play and export** copy the referenced bytes into the play build and the
  standalone game (`content/sha256/<digest>`), so an export needs no editor,
  backend or game folder. With a changed or missing file, Play and export
  refuse and name the file (export: `export_scene_invalid` with
  `reason: asset_source_changed`).
- **Backups** of a folder project hold the whole game folder, so the
  referenced files are in them (see "Backups find folder projects" below).

### Supported glTF extensions

GLB is the only model format the game loads. Besides core glTF 2.0 the
importer accepts these extensions (each has a fixture in `fixtures/import-ext`
that imports, and renders in the editor, Play and the export):

- `EXT_texture_webp` (what the Blender pipeline writes), `KHR_texture_transform`,
  `KHR_mesh_quantization`, `KHR_materials_unlit` and the material extensions
  `clearcoat`, `emissive_strength`, `ior`, `sheen`, `specular`, `transmission`
  and `volume`;
- compression: `EXT_meshopt_compression` (the importer decodes it itself and
  checks the decoded data), `KHR_draco_mesh_compression` and
  `KHR_texture_basisu` (KTX2 / Basis Universal GPU textures). Draco and KTX2
  payloads are checked for structure, header and declared sizes at import and
  decoded when the model loads; a stream that does not decode shows in
  Problems ("view") in the editor.

Any other extension is refused at import with `asset_extension_unsupported`,
naming it; an allowlisted extension in a place where it would mean nothing, or
not declared in `extensionsUsed`, is refused too.

### FBX

An `.fbx` can be imported like a `.glb` (upload, "from project folder…", or
MCP `tl_content_upload` with `dataBase64` or `projectPath`). The backend
converts it with headless Blender (`THIRDLIGHT_BLENDER`, default `blender` on
`PATH`; this LXC has Blender 5.2.2 in `/usr/local/bin`, which the systemd
unit's default `PATH` includes) into a GLB — Y up, animations kept, textures
embedded — and that GLB goes through the same import profile. The game only
ever loads GLB:

- the converted GLB is the version's stored bytes (`thirdlight/sources/`), so
  Play and export never need Blender or the FBX;
- the FBX is recorded as the version's original (`convertedFrom`: checksum,
  size, the Blender version, and its path when it is in the game folder; an
  uploaded FBX is stored as a blob next to the GLB). An FBX in the game folder
  stays where it is; textures next to it are found by Blender;
- when the FBX changes, Problems says so and offers **Re-import**, which
  converts it again into a new version. Until then Play and export keep using
  the previous conversion (unlike a referenced GLB, the stored GLB stays
  readable). A missing FBX is only noted;
- one conversion runs at a time and is stopped after 3 minutes; an FBX in the
  folder may be up to 128 MB, an upload up to the 32 MB stage limit. Without
  Blender an FBX import fails with `converter_unavailable`; a file Blender
  cannot convert with `conversion_failed` (with Blender's reason).

Animations survive the conversion, but a model's animations only play in the
game through a role binding (Media panel), as for any GLB.

The Draco and Basis decoders are three's own (`three@0.186.0`,
`examples/jsm/libs/{draco,basis}`, Apache-2.0). The editor and the Play
preview serve them at `/decoders/`; an export gets a `decoders/` folder (and a
license row in `meta.json`) only when one of its models needs it. Both run in
Web Workers, so the Play preview allows `worker-src blob:`; the Basis
transcoder also builds functions at run time, so a Play whose models carry a
KTX2 texture is served with `'unsafe-eval'` added to its script policy (other
Plays are not).

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

## Baked lighting

The Lighting tab bakes lightmaps for the active scene's static objects
(Inspector → Static; boxes, and models with a second UV set) from the lights
set to **baked** (direct + bounce; no longer realtime once baked) or
**mixed** (realtime direct light, baked bounce light). The atlases become
texture assets named `lightmap <scene> <n>`; a re-bake adds versions to them.

- **Bake preview** runs in the browser: direct light and sky occlusion from
  baked lights, no bounce. Seconds for a small scene.
- **Bake final** sends the scene to Blender Cycles on the bake host:
  `THIRDLIGHT_BAKE_HOST` is `user@host` (the backend copies the scene there
  with `scp` and runs Blender over `ssh`, so the service user needs a key
  login without a passphrase) or `local`; `THIRDLIGHT_BAKE_BLENDER` is Blender
  on that host; `THIRDLIGHT_BAKE_TIMEOUT_MINUTES` stops a bake (default 60).
  Cycles uses OptiX when the GPU has 4 GB free, else the CPU; the result is
  denoised. One bake runs at a time. Without a bake host the button explains
  what to set. This install bakes on the RTX 5090 workstation (see the
  systemd unit).

A bake whose static objects or baked/mixed lights changed since is shown as
stale; it is still used until it is baked again or cleared (Clear bake). A
scene with a bake cannot be deleted until the bake is cleared. MCP can clear
a bake (`setLighting {sceneId, lighting: null}`); bakes are made in an
editor (the headless one works too).

## Animation (Animator)

Models with clips (skinned or not) play them through **animator
controllers**: parameters (float, int, bool, trigger), states that play a
clip or a 1D blend tree, transitions with conditions, crossfade and exit
time, an entry state, and clip events. Bottom dock → **Animator** lists the
controllers: pick the model whose clips a new controller uses, then **New
controller** or **New from clips: Platformer** (idle/run/jump/fall/land
states from a model's clips); a controller opens as the centre tab
**Animator: <controller>** with a double-click, Enter or **Open in tab**
(a new one opens by itself). The Inspector's "+ Add component" →
**Animator** puts a controller on a model object.

**The Animator tab** shows a layer's state machine on the node-graph editor
(all its gestures work, see "Graph editing" below):

- **Nodes**: one per state — **State** (plays a clip), **Blend tree**, and on
  override layers **Empty state** — plus the fixed **Entry** (its one wire
  goes to the state the layer starts in; drag a new wire from Entry to
  change it) and **Any State**. Add states with a right click, Space or
  **+ Node** (a new state plays the model's first clip until you pick one);
  Delete removes the selected states (Entry and Any State stay; deleting the
  entry state makes the first remaining state the entry).
- **Transitions**: drag from a state's output (or Any State's) to another
  state's input (a state may also go to itself). One wire stands for every
  transition between that ordered pair; a pair with several shows **×n** on
  the wire. A new wire starts as one transition at exit time 1 with a 0.1 s
  crossfade; deleting the wire removes the pair's transitions.
- **Inspector** (right dock): a selected state shows its name, clip (or the
  blend parameter and **Open blend tree**), speed and its × parameter, loop,
  **Set as entry state**, its clip events and the transitions leaving it
  (click one to select its wire). A selected wire lists its transitions in
  the order they are checked (↑ reorders): conditions, crossfade, exit time,
  interruption; **Add transition** adds another between the same states.
  Tab onto a wire's handle (the dot in its middle) to select it with the
  keyboard.
- **Blend trees** open as their own graph (double-click the node's body, or
  **Open blend tree**): one **Clip** node per blend clip (threshold and clip
  in the Inspector; clips stay in threshold order) feeding the fixed
  **Blend** node; the path above the graph (**Base layer › Blend tree:
  …**) leads back.
- **Layers** are the tabs above the graph; **Parameters** and, on an
  override layer, the layer's settings are on the left.
- **Live preview**: a pane inside the tab (the **Preview:** buttons dock it
  **Right**, at the **Bottom** or **Hide** it; remembered in the browser).
  **Preview** runs the controller on its model with the parameters as
  sliders, checkboxes and trigger buttons (nothing is saved); the states it
  is in are outlined in the graph.

Every gesture is one command and one undo step (Ctrl+Z works while the tab
is in front): graph gestures (states, wires, moves, groups, comments) are
`graphEdit` on the controller, the rest (transition details, parameters,
layers, events, the name) `setAnimator`. Positions, groups, comments and
collapsed nodes are stored in the controller (editor-only: exports drop
them); a controller without them (older projects, or made by MCP) opens
with an automatic layout, columns by distance from the entry state.

The game steps animators with the simulation (deterministic; a replay looks
the same). An animator on the player (or on a model under the player) gets
`speed` (horizontal m/s), `grounded`, `velocityY` and a `landed` trigger
automatically, when its controller defines them. Scripts use
`ctx.animator(entityId)?.set(name, value)`, `.trigger(name)`, `.state()`;
clip events of the previous step are in `ctx.events`. MCP: `setAnimator` /
`deleteAnimator` through `tl_command`, or the graph ops through `graphEdit
{owner: {kind: "animator", id}}` (id `<controllerId>` = the base layer,
`<controllerId>@<n>` = override layer n, `<controllerId>#<stateId>` = a blend
tree; the node ids are the state ids, `ENTRY`, `ANY` and, in a blend tree,
`OUT` and `C0`, `C1`, …) — it changes the controller exactly as
`setAnimator` would (one undo step); `tl_game_observe` reports each
animator's current state.

**Layers and bone masks.** "Add layer" (the layer tabs above the graph) adds an
override layer — up to three — on top of the base layer, e.g. an attack
played by the upper body while the legs keep running. Each layer has its own
states, transitions and entry state and shares the controller's parameters
(a trigger reaches every layer that tests it in the same step). The panel
left of its graph sets the name, the weight (0–1, optionally times a float parameter, so
a script can fade the layer in and out) and the **bone mask**: a checkbox per
bone of the model's skeleton ("+ children" takes a bone and everything under
it; no bone picked = every bone). A layer state may be **empty** (right
click → **Empty state**): the layer plays nothing and the layers under it
show through, so the usual layer is Empty → Attack (on a trigger) → back to
Empty at its exit time. A masked bone that the layer's clip does not animate
goes to its rest pose while the layer plays. `tl_game_observe` reports the
states as `Run | Upper body: Attack`; scripts read a layer's state with
`ctx.animator(id)?.state(1)`. Controllers without layers play exactly as
before.

**Animation-only files.** A GLB with bones and clips but no mesh imports as
a model asset. Select it in the Asset browser and set **clips for rig of**
to the model it animates: its clips then appear in the Animator's clip lists
for that model (as `clip · file`) and play on it, matched by bone names (the
field reports animated bones the rig does not have; those stay still). MCP:
`setAssetOptions {assetId, clipsFor: rigAssetId | null}`.

**The old idle/run/airborne animation.** A model object that still has the
old `modelAnimation` profile keeps playing it until the project is opened
again; on open it becomes an animator controller "Idle/run/airborne
(<model>)" (the same three clips, airborne while not grounded, else run
above 0.05 m/s, else idle, 0.2 s crossfades), written as one new revision.
If a clip length cannot be read from the model file the old component stays
and keeps playing.

## Graph editing

Node graphs share one editor (phase 16.1): the Animator's state graphs use
it (phase 16.2, see "Animation (Animator)"), and material graphs, visual
scripts and effect graphs will. Each graph has a **kind** that sets its node
catalogue (categories, ports, fields — phase 19.2: a port may repeat once
per item of a node field, e.g. one output per case of a Switch), its port
types with the implicit conversions between them (a control-flow type is
drawn thick with arrows), and its rules (cycles allowed or not, a node
budget, nodes a graph must have, fixed nodes every graph of the kind has
once). Graphs that belong to a document (an animator controller's layers
and blend trees) open from that document. The only standalone kind is
**Test graph**, a small numeric graph used to test the editor; it has no
effect on the game and is never exported.

Bottom dock → **Graphs** lists the project's graphs: pick a kind, type a
name and **Create graph**; **Open** (or double-click) shows it in the centre
area as a **Graph: <name>** document tab (like the other centre tabs:
opening an open graph brings its tab to the front, × or middle-click closes
it, Ctrl+Tab cycles, and the open tabs come back after a reload). While a
graph tab is in front, the Inspector on the right shows the selected node
(its fields), wire (its type or implicit conversion), group (title, colour)
or comment. Deleting a graph closes its tab.

- **View:** wheel zooms at the cursor; middle-drag or Space+drag pans; **F**
  fits the selection, **Shift+F** everything (or the **Fit** button); click
  or drag in the minimap (bottom right) to move the view. **Snap** keeps
  positions on the 20-unit grid.
- **Adding nodes:** right click or press Space over the graph (or **+ Node**)
  for the catalogue: type to filter, arrows + Enter or a click to add. Drag
  from a port to empty space: the catalogue lists only the nodes that can
  take that wire and connects the new node.
- **Wires:** drag from an output to an input (or the other way). Ports are
  coloured by type; a wire that needs an implicit conversion is dashed and
  names it (e.g. number→vector). An incompatible type or a wire that would
  close a cycle (in kinds without cycles) is refused with the reason in the
  bottom-left status. A single input takes one wire: a new wire replaces the
  old one. Click a wire to select it; double-click a wire to add a reroute
  point (drag it; double-click it to remove it).
- **Selecting and moving:** click, Shift+click (add), Ctrl+click (toggle),
  or drag a box on empty space; drag a selected node to move the whole
  selection; dragging a group by its title moves everything inside its frame.
  Double-click a node's title (or its ▸/▾) to collapse it.
- **Editing:** Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste (at the pointer;
  also into another graph of the same kind), Ctrl+D duplicates, Delete
  removes (a node takes its wires), Ctrl+A selects all, Ctrl+G frames the
  selection in a group (double-click its title to rename it), **Comment**
  adds a note (double-click to edit). The toolbar aligns (left, centre, right,
  top, middle, bottom) and distributes the selected nodes.
- **Keyboard:** Tab reaches nodes and ports; arrows move the selection one
  grid step (Shift: five); Enter on a port starts a wire and Enter on another
  port connects it; Esc cancels.
- **Problems:** the kind's rules are checked as you edit — a required input
  left unconnected or a missing required node is an error, a node whose
  result reaches no output a warning. They show as a badge on the node (hover
  for the text), in the toolbar count and in the **Problems** tab, where a
  click opens the graph at the node.

Every gesture is one command on the backend (a drag of many nodes is one
move on release), so it is one undo step (Ctrl+Z / Ctrl+Y) and every
connected editor and MCP client sees the same graph. MCP: `setGraph
{graph: {graphId, kind, name, graph: {nodes: [], edges: []}}}` creates or
renames a graph, `deleteGraph {graphId}` removes one, and `graphEdit {owner:
{kind: "graph", id}, ops: [...]}` applies up to 512 ops atomically (addNodes,
removeNodes, moveNodes, setNodeData, setCollapsed, connect, disconnect,
setReroutes, setGroups, removeGroups, setComments, removeComments — the full
shapes are in the `tl_command` description). `tl_content_query
target="game"` returns the graphs; with `includeDescriptors` also the kinds'
catalogues. Limits: 4096 nodes per graph (the kind may set fewer), 256
groups, 256 comments, 16 reroute points per wire, 64 graphs per project;
graphs count toward the 1 MiB content cap (about 70 bytes per node and 80 per
wire).

## Material graphs

A material can be built as a node graph (phase 18.0/18.1). Bottom dock →
**Materials**: **+ new graph material** makes one (a graph with a **PBR
output**) and opens it as a **Material: <name>** centre tab; a standard or
unlit material's **Convert to graph** rebuilds it as a graph with the same
values and textures (foliage, kit and water become built-in templates in
18.2). Double-click a graph material's tile (or **Open graph**) to open its
tab. The tab is the graph editor (every gesture in "Graph editing") with the
material catalogue; the Inspector on the right edits the selected node
(texture fields pick from the project's textures, colours use a colour
picker). **Remove graph** turns it back into its shader material.

**Rendering waits for the graph compiler.** Until the WebGPU renderer
(phase 17.4) and the graph compiler (18.3) land, the Scene view, Play and
exports draw a graph material with its shader part (`shader`, `params`,
`textures`); the tab says so. The graph is project data now and is what 18.3
compiles.

**The catalogue** (generic, any genre): *Inputs* — Float, Vector 2/3/4,
Colour, Parameter, Time, UV (set 0/1), Vertex colour, Position and Normal
(object/world/view), View direction, Camera distance, Screen UV, Instance
index, Global wind; *Maths* — add, subtract, multiply, divide, min, max,
power, dot, cross, normalize, length, lerp, clamp, saturate, smoothstep,
step, abs, floor, fraction, sin, cos, one minus, remap; *Vectors* — split,
combine, swizzle (mask `xyzw`/`rgba`); *Textures* — Sample texture (wrap,
filter, colour space), Normal map, Triplanar, Flipbook, Noise (value,
gradient, Voronoi), Gradient (linear/radial/angular), Colour ramp;
*Utility* — Fresnel, Rim, Posterize, Dither, World-aligned UV, Parallax,
Vertex displacement, Alpha clip; *Functions* — Function call; *Output* —
PBR output (base colour, metalness, roughness, normal, emissive, AO,
opacity, alpha clip) or Unlit output (one of them per material), Vertex
offset; the render flags (double-sided, transparent, casts shadows) are
fields of the surface output. Port types are float, vec2, vec3, vec4 and
texture; every value width converts to every other (a float fills every
component, a wider vector keeps its first components, a narrower one is
padded with 0 and w = 1 — shown dashed on the wire); a texture only feeds a
texture input. Maths nodes have a **Type** field, `auto` by default: they
take the widest width among their wires (a texture's rgb × a colour is a
vec3). Every input has a default (a constant, or the mesh's UV, position,
normal, view direction, screen position or time), so nothing is left
undefined. Rules (a refused edit changes nothing): known node types and
fields, compatible port types, no cycles, at most 512 nodes, one surface
output, one vertex offset.

**Exposed parameters** (left of the graph): key, type (float, vec2–4,
colour, texture), default, range, visibility (public/private, like script
properties). A **Parameter** node reads one (its type is the parameter's).
Objects override the **public** ones: select an object that uses the
material (its own material mapping or its model's default one) — the
Inspector's **Materials** section lists each graph material's public
parameters; a value set there is stored on the object (the
`materialParams` component) and ↺ goes back to the material's value.

**Material functions** (reusable sub-graphs) are standalone graphs of kind
**Material function** (Graphs → pick the kind → Create graph). Their
**Function input** (name, type, default) and **Function output** (name,
type) nodes become the ports of every **Function call** node (field
*Function* = the function's graph id; a new call runs the first function).
Functions may call functions, but never in a cycle; a function cannot drop a
port a material wires, and a used function cannot be deleted.

MCP: `setMaterial` takes `graph` and `parameters`; `graphEdit {owner:
{kind: "material", id: materialId}, ops}` edits the graph (one undo);
`setComponent "materialParams" {<materialId>: {<key>: value}}` sets
overrides; functions are `setGraph` with kind `material-function`. The
catalogues are in `tl_content_query target="game" includeDescriptors`
(`graphKinds.material`, `graphKinds["material-function"]`).

## Visual scripts

A behavior can be written as a node graph instead of TypeScript (phase
19). Bottom dock → **Behaviors**: type a name next to **+ Visual script**
and press it; the new behavior opens as a **Graph: <name>** centre tab (the
graph editor above, with the visual-script catalogue) holding an **On
start** node (a script needs no variable: a behavior may declare no
property). Double-click a visual script's tile (it says "visual script") to
open it again. Right click (or Space, or **+ Node**) opens the catalogue
with its search; the Inspector on the right edits the selected node's
fields.

The tab has three parts (phase 19.2):

- **Graph tabs** along the top: **Event graph** (the script's events) and
  one **ƒ** tab per function of the script. **+ Function** asks for a name
  and creates the function with its **Function start** node; double-click a
  function's tab to rename it (the name of its Function start; calls keep
  pointing at it); **×** deletes it (refused while a Call function uses its
  ports). A problem or a breakpoint inside a function opens its tab.
- **Left: Variables** of the graph in front (inside a function: its local
  variables) — the name, the type (Number, Boolean, Text, Vector, Entity,
  Choice, List, Map) and the visibility (public / private / local; lists
  and maps are private or local) are edited in place, each change one
  undoable edit (renaming also renames the Get/Set nodes of that graph that
  name it). **+ Variable** adds one, **×** deletes it, **edit** selects its
  node (the Inspector edits its default, label, group and tooltip), **watch**
  puts it on the debugger's watch list. Drag a variable by its **≡** onto
  the graph and pick **Get** or **Set** for a Get/Set variable node there.
  Below: the project's **shared functions** (click one to open it in its
  own Graph tab) and **+ Shared function**.
- **Right:** the compile status, the problems, **Publish** and the
  **debugger** (below).

Exec wires (the flow: which node runs next) are drawn thick with arrows
pointing along the flow; data wires are thinner and coloured by type.
Reroute points (double-click a wire), comments and groups work as in every
graph. Compile problems show as a badge on their node, in the list beside
the graph and in the bottom dock's **Problems** tab ("script error"/"script
warning"; a click opens the script's Graph tab at the node).

- **Events** start the flow along the white **exec** wires. Each event has
  a **Phase**: *intent* (decide: counters, timers, signals, control) or
  *transform* (move objects — it runs only in scripts that move something).
  **On start** (the first step of every run: a new game or a replay starts
  with fresh script state), **On step**, **On signal**, **On trigger**
  (enter or exit of a trigger the script owns: on its object, below it, or
  named by one of its entity variables), **On overlap** / **On raycast** (a
  query around the object every step: an entity starts or stops
  overlapping/being hit, or each step), **On input** (an input action
  pressed, released or held), **On animator event** (a clip event), **On
  timer** (one of the script's timers fired), **On message** (a message
  another script sent). Each step the On start nodes run first, then every
  other event in a fixed order; an event with several occurrences in a step
  runs once per occurrence.
- **Flow:** each exec output takes one wire (a **Sequence** has four
  outputs, run top to bottom); an exec input takes any number. **Branch**,
  **For** (first..last), **For each** (the items of a list), **While** (the
  condition is read again before each round), **Gate** (enter/open/close/
  toggle), **Do once** (with reset), **Delay** (continues after the given
  seconds, counted in fixed steps; values from before it are kept),
  **Switch** (text or whole number: its **Cases** field is a comma-separated
  list — one exec output per case, up to 32, plus default; an empty case
  never matches), **Select**
  (a or b). A script may run at most 10 000 loop iterations per step (all
  loops, functions included) — more stops the play with a script error
  naming the loop node.
- **Data:** coloured wires carry numbers, true/false, text, vectors (x, y,
  z), lists and maps (a number or true/false feeds a text input as text,
  true/false feeds a number as 1/0, a number feeds a vector as (n, n, n), a
  vector feeds text as "x, y, z"). An input without a wire uses the value
  set on the node. Graphs have no cycles: repetition happens only inside
  the loop nodes. Constants, maths (incl. modulo, power, min/max, rounding,
  clamp, lerp, sine/cosine/angle in degrees), logic, text, vectors, lists
  (at most 1024 items) and maps (text keys, at most 256 entries) — list and
  map nodes never change a value, they give a new one (store it with Set
  variable) — and **Random** number / integer / chance: each object draws
  from its own sequence, which starts again with every run, so a replay
  repeats it exactly.
- **Script API:** every call and value a TypeScript script reaches on `ctx`
  is a node — game counters, health and visibility, signals, messages,
  timers, physics queries (raycast, overlap, character result), tags, world
  transforms, scenes, input actions, animators, sounds, the save, spawning
  prefabs and removing spawned objects, the intents (control move/jump,
  respawn, **Move object** and **Pose object**) and values such as This
  object, Step index and the settings. They are generated from the runtime's
  typings (new script API appears as nodes without hand work). An empty
  entity means **this object**; **Play sound** picks from the project's
  audio. **Move object** / **Pose object** run in the transform phase only:
  with an empty entity the script moves its own object (it owns "@self");
  a typed entity id is owned by the script (at most 16 objects).
- **Messages:** **Send message** (name, a number/text/true-false value,
  optionally one target entity) reaches **On message** of every script (or
  the target's) in the next step; at most 256 messages per step. TypeScript
  scripts use the same `ctx.messages.send` / `received`.
- **Variables:** Number, Boolean, Text, Vector, Entity (an entity id; as a
  property it is picked in the Inspector), Choice (one of listed texts),
  List and Map variable nodes; the name is the property key (lower case,
  a-z, 0-9, _). **Public** variables are the script's properties — shown
  and set per object in the Inspector; **private** ones are per object and
  start at their default; **local** ones live for one event run (lists and
  maps are private or local). **Get variable** / **Set variable** name a
  variable; their value port takes its type (a Get naming no variable is
  grey and connects to anything until fixed). The script's properties come
  only from its public and private variables (at most 32).
- **Functions:** a script can have functions — graphs with a **Function
  start**, **Input** nodes and **Output** nodes (name and type); **Call
  function** runs one: its ports are the function's Inputs and Outputs (read
  when the function's flow has finished). Variables declared in a function
  are local to one call; a function may use the script's variables.
  **Shared functions** are graphs of kind "behavior-library" in the
  project's graph list, called from any script with **Call shared
  function** (they see only their own inputs and locals). Functions may not
  call each other in a cycle. A new Call function picks the script's first
  function; its **Function** field (and a Call shared function's) is a
  list of the functions by name.
- **Check and publish:** a moment after each change the backend compiles
  the script with its functions and the shared functions it calls (to
  TypeScript, with the same compiler, limits, output scan and engine pins as
  a TypeScript script; the shared functions' code is part of the published
  digest); problems are listed beside the graph with their node (click one
  to frame it) — e.g. an empty counter name, a Get naming no variable, a
  Move object reached from an intent event, a node no event reaches (a
  warning). **Publish** shows the trust notice for a new digest, then
  publishes (one `publishBehavior`, one undo step); Play and exports run the
  published script, which the stored source record marks `kind: "graph"`.
  Editing the graph (or a shared function) never changes the published
  script until you publish again.
- **Errors in Play:** a script error from a visual script names the node
  that was running (`nodeId` in the play diagnostics and `tl_diagnostics`;
  `fn:<function>/<node>` or `lib:<graph>/<node>` inside a function).

### Debugging visual scripts in Play

While Play runs, the Graph tab's **Debug (Play)** panel watches one
object's instance of the script: pick it under **Object** (the object
selected in the scene is picked when it carries the script). The editor
never runs game code: four times a second it asks the running Play over
the preview relay.

- **Active nodes:** the nodes that ran in the last half second light up
  (gold outline), and exec wires between them glow.
- **Wire values:** hover a data wire to see the last value that moved along
  it (numbers to 3 decimals, vectors "x, y, z", lists and maps by size and
  first items).
- **Breakpoints:** select nodes and press **F9** (or **● Breakpoint** in the
  graph toolbar) — a red dot. When a node with a breakpoint runs, Play
  pauses right after that step (the same step at any frame rate); the
  paused node gets a green outline and a ▶, the panel says "Paused at step
  N on <node> (<object>)" and the wire values and the watch list show that
  step. **Step once** runs exactly one step and pauses again; **Resume**
  lets the game run on; **Pause** holds it at the next step boundary. The
  breakpoint list under the buttons jumps to a node (click) or removes it
  (×). Breakpoints stay while the editor page is open (they are not project
  data). Closing the tab resumes a paused game.
- **Watch:** the variables ticked "watch" with their values (per-object
  variables, and the last value of a local).
- **What runs:** Play builds each published visual script as a *debug
  build* — the same graph, compiled by the same compiler, that also records
  its trace (at most 256 node entries per step), wire values and locals —
  but only while the graph still generates exactly the published source;
  after unpublished edits Play runs the published script without debugging
  and the panel says to publish and restart Play. Exports never contain
  debug builds or breakpoints: an exported game runs the published module
  byte for byte. A pause never changes what the game computes (the same
  steps run with the same input, only later).
- **MCP:** `tl_game_observe` shows `debug {paused, stepIndex, breakpoints,
  hit {behaviorId, entityId, nodeId}}` while the editor debugs or the game is
  held; `tl_game_control` takes `debugPause`, `debugResume` and `debugStep`.
  Breakpoints are set in the editor only.

Every graph gesture is one `graphEdit {owner: {kind: "behavior", id:
behaviorId}, ops}` command (one undo step; MCP edits appear in the open tab).
A script's function is owner id `"<behaviorId>#<functionId>"` (kind
`behavior-function`): the first edit that adds nodes to a new id creates the
function, removing its last node removes it. Shared functions are `setGraph
{graph: {graphId, kind: "behavior-library", name, graph}}` and `graphEdit
{owner: {kind: "graph", id}}` (a change that breaks a script calling it is
refused, naming the script). MCP creates a script with `publishBehavior
{mode: "declaration-create", …, graph: {nodes, edges}}`; publishing is `POST
/api/v1/projects/<id>/content/behaviors/source {graph: true, behaviorId,
displayName, expectedRevision, requestId}` (`{check: true, graph: true,
behaviorId}` compiles without publishing and returns the `sourceDigest`;
a new digest must be acknowledged first with `acknowledgeBehaviorTrust
{sourceDigest}`, the same step the editor's trust notice takes). The
published record (`tl_content_query target="behaviors" behaviorId
includeDeclaration: true`) shows `source.kind: "graph"`; attach the script
with `setBehaviorProperties` and play it with `tl_play_start` like any
behavior. Limits: 256 nodes per graph, 32 functions and 32 properties
per script; Delay nodes use timers named `vs.delay.<n>`.

**Exports:** an exported game runs a visual script exactly like a
TypeScript one — the published module is part of the export (a
`behaviors/<digest>.js` file) and runs from a plain static server with no
editor backend; debugging exists in Play only.

## Visual effects (particle graphs)

Effects are particle systems authored as node graphs (phase 20.0/20.1).
They are **visual only**: nothing in an effect changes the game simulation,
so recorded replays never depend on them. The runtime executors (WebGPU
compute, and a CPU fallback on WebGL 2) arrive with phase 20.2 and the
looping preview pane with 20.3: until then effects are authored and stored
but **not drawn** in the Scene view, Play or exports.

Bottom dock → **Effects**: type a name and press **Create effect**; the
effect opens as an **Effect: <name>** centre tab (double-click a row or
**Open** to reopen it; **Rename** and **Delete** are there too — an effect
an object still plays cannot be deleted). In the tab:

- **Effect settings** (left): the cycle **duration** (bursts and the effect
  time refer to it), **loop** (off: spawning stops after one cycle and the
  effect ends when its particles are gone), the random **seed** (the same
  seed gives the same particles), and the culling **bounds** (a box around
  the origin). New effects: 2 s, looping, seed 1, a 4 m box 1 m above the
  origin.
- **Systems**: **+ System** adds a particle system (up to 16; they run in
  list order). Each has a name, **max particles** (its capacity, default
  1000; an executor may cap lower) and its **space** (local: the particles
  move with the object; world: they stay where they were born). The system
  tabs choose which graph is shown.
- **Exposed parameters**: float, vec3 or colour values the graphs read with
  **Parameter** nodes; public ones can be overridden per object (below),
  private ones are the effect's own.
- **The graph** of the shown system (the graph editor above, with the effect
  catalogue). Every system has four fixed **context** nodes — **Spawn**,
  **Initialize**, **Update**, **Output** — and each runs a **chain**: wire
  the context's `then` to a block's `in`, that block's `then` to the next
  block's `in`, and so on; the chain order is the execution order. A chain
  only takes blocks of its context (a force cannot go into Initialize, a
  renderer only into Output); a block off every chain does nothing.
  - *Spawn*: Constant rate (per second, fractions carry over), Burst (count
    at a time of the cycle, repeated `cycles` times every `interval`
    seconds; 0 cycles = forever), Over distance (per metre the object
    moves), From event (particles born where another system's particles die,
    are born or collide; they may inherit its velocity and colour).
  - *Initialize*: positions (Point, Sphere, Box, Circle, Cone, Line, Mesh
    surface of a model asset — a shape also sets the direction that
    **Velocity from direction** uses), Velocity, Lifetime, Size, Colour,
    Colour from gradient, Rotation (angle and spin), Mass.
  - *Update*: Gravity (−9.81 m/s² by default), Drag, Wind (follows
    Environment → Wind and its gusts), Vortex, Turbulence (curl noise),
    Attractor; Collide with plane (bounce, friction, lifetime loss, kill),
    Collide with scene (depth buffer — **honoured only on WebGPU**, the CPU
    fallback ignores it); Size over life (a curve), Colour over life (a
    gradient), Speed limit over life (a curve); kills (behind a plane,
    inside/outside a sphere or box, when slower than a speed).
  - *Output*: Billboard (facing the camera, along the velocity or around a
    fixed axis; texture, flipbook over the life or at a frame rate,
    blending alpha/additive/premultiplied/multiply/opaque, soft particles,
    unlit/lit or a project material), Mesh particles (a model asset),
    Ribbon/trail (a strip through each particle's recent positions, or one
    ribbon joining the particles in birth order), Lights (a point light on
    up to 16 of the oldest particles).
  - Every number, vector and colour field of a block is also an input of
    the same name: a wire from a value node replaces the field — Float,
    Vector, Colour, Parameter, Random (fixed per particle), Random vector,
    Curve and Gradient (read at the particle's normalized age, the effect
    time or a random position), Particle attribute (position, velocity, age,
    size, colour, …), Effect time, and maths (add, subtract, multiply,
    divide, min, max, lerp, one minus, sine, length, normalize, combine,
    split). A float feeds a vector or a grey colour; a vector and a colour
    convert both ways.
- **Curves and gradients** are edited in the Inspector: a curve shows a plot
  (drag its keys) and a row per key (time 0–1, value; **+ key** adds one in
  the widest gap); a gradient shows a preview bar and a row per stop (time,
  colour, alpha; **+ stop**).

**Playing an effect:** select an object, **+ Add component → Effect** and
pick the effect. **Play on start** (on by default) starts it with the scene;
the **Parameters** rows set this object's values for the effect's public
parameters (× goes back to the effect's value).

Every graph gesture is one `graphEdit {owner: {kind: "effect", id:
"<effectId>/<systemId>"}, ops}` (one undo step); `setEffect {effect}`
creates or replaces an effect (settings, parameters, systems with their
graphs — adding or removing a system is a `setEffect`), `deleteEffect
{effectId}`, `renameEffect {effectId, name}`; the component is
`setComponent "effect" {effectId, playOnStart?, params?}`. The effects
travel in `queryGameConfig` (`effects`) and `tl_content_query
target="game"`. Limits: 128 effects, 16 systems and 32 parameters per
effect, 256 nodes per system graph, up to 1 048 576 max particles per
system (the CPU fallback's lower cap comes with 20.2).

The CPU reference semantics of every node live in the runtime-safe package
`@thirdlight/effects` (deterministic per seed; unit-tested), which the
executors of 20.2 use.

## Input actions

The game reads named **actions**, not keys (bottom dock → Input): `move`
(A/D, ←/→, D-pad, left stick), `jump` (Space, pad A), `attack` (J, pad X),
`interact` (E, pad Y), and for menus `pause` (Esc, Start), `submit` (Enter,
pad A), `cancel` (Backspace, pad B), `navigate` (arrows/WASD, stick). "+ key"
listens for the next key (an axis asks for two or four keys), "+ pad" for
the next gamepad button; × removes a binding; new actions can be added. The
first edit makes the controls the project's own; "Reset to defaults" goes
back. The platformer moves and jumps with the `move` and `jump` bindings:
their keys, and their pad buttons and stick axis (`jump`'s pad buttons,
`move`'s button pair and axis; a part with no pad binding of its kind keeps
the standard layout — A jumps, D-pad and left stick move). Players rebind
the pad in the game's Settings (see Game flow). Scripts read
`ctx.input.value(name)`, `.vector(name)`, `.pressed(name)`, `.held(name)`,
`.released(name)`; the actions are part of the recorded input, so replays
match. MCP: `setInput {input}` through `tl_command`; `tl_input_exercise`
frames may carry `actions: {name: {v, p}}`.

## Gameplay blocks

GameObject → Gameplay places ready-made pieces (v4 projects): a moving
platform, a one-way platform, a switch, a door (opens on the signal `open`),
a coin, an enemy and a trigger. Any object can get these in the Inspector
("+ Add component", Gameplay):

- **Mover** — a path of offsets from where the object stands (waypoints, x/y/z each),
  speed, ping-pong / loop / once, a wait at each stop, smooth easing, and
  "waits for signal" (a door or a lift that starts when a switch or trigger
  fires). With a box collider it carries the player standing on it and
  pushes a player it moves into. A mover rising beside or under the player
  (a gate opening, a pillar) pushes the player aside, never up: only a player
  above it rides it up. The Scene view draws its path.
- **Trigger** — an area that sends a signal when the player enters it
  (and, if set, another one when the player leaves it). Its shape is a box
  (width, height) or a circle (radius; tested against the player's capsule
  itself, not its bounding box); switching the shape in the Inspector
  replaces the size with a radius (1 m) and back. Mode "stay" sends the signal
  every step while the player is inside instead of once per entry. The
  Scene view draws a circle trigger as a circle with one handle that drags
  its radius (5 cm snapping, Shift for exact, one undo per drag).
- **Switch** — `interact` (the interact action while inside) or `stand`
  (a pressure plate); sends a signal.
- **Health** — on the player: max health, the health a level starts with,
  invulnerability after a hit and a knockback (the player is pushed away
  from what hurt it). Without it an enemy touch or a hazard is a death, as
  before.
- **Pickup** — coin, gem, heart (heals), extra life, key or a custom counter;
  collected pickups disappear; "comes back" on death if wanted; a collect
  sound (an audio asset) if wanted.
- **Enemy** — walks between two x offsets or until a ledge/wall, hurts on
  contact, can be defeated by jumping on it (the player bounces; the enemy
  squashes, then vanishes). With "chases the player within" it walks toward
  a player that near (still inside its range / not off a ledge); its
  Animator gets `speed`, `attacking` (chasing), `hurt` and `defeated`.
- A collider's **one-way** flag: jump up through it, land on it from above,
  Down + Jump drops through. A spawn or checkpoint inside one is not
  blocked (the player drops to what is below). A hazard zone's **damage** takes health instead
  of a life.

The HUD shows the counters and health ("Coins 2 · Health 3/3").
`tl_game_observe` reports `counters` and `health`. Scripts use
`ctx.signals.emit(name)` / `.on(name)` (seen the next step),
`ctx.game.counter(name)` / `.add(name, n)` / `.health()` /
`.setVisible(entityId, visible)` (until the next run; it still collides),
and `ctx.physics.raycast(origin, direction, maxDistance)`,
`.overlapBox(center, half)` and `.overlapCircle(center, radius)` (the
entities whose colliders overlap, never the player; 32 queries per step in
all).

### Timers and trigger events in scripts

- `ctx.timers.after(name, seconds)` fires once, `ctx.timers.every(name,
  seconds)` repeatedly; `ctx.timers.fired(name)` is true in the step the
  timer fires; `ctx.timers.cancel(name)` stops it. Timers count fixed steps
  (seconds × the step rate, rounded, at least one step), so a replay fires
  them in the same steps. Calling `after`/`every` again with the same length
  while it runs changes nothing (a script may call `every` every step);
  another length restarts it; to restart the same one, cancel it first.
  Each script instance (each object carrying the script) has its own
  timers, at most 64 running; a new run (start, replay, the next level)
  clears them. A bad name (1–64 letters, digits, `_ . : -`) or length
  (0–3600 s) or a 65th timer stops the game with the script error.
- `ctx.events` also lists `{ type: "enter" | "exit", trigger: id, stepIndex }`
  when the player entered or left a trigger the script owns, in the step
  after (like signals). A script owns the triggers on its own object, on
  objects below it in the hierarchy, and the triggers named by its
  entity-reference properties. Every entry and exit is reported, even for a
  trigger whose signal is "only once". (Animator clip events stay in the
  same list; they have `name` and `clip` instead of `type`.)

A timed door, for example: a script on the door with a "sensor" entity
property naming a trigger; on its `enter` event `ctx.timers.after("open",
1)`; when `fired("open")` it hides the door (`ctx.game.setVisible`) and
starts `after("close", 4)`, which shows it again.

- Phase 19.1: `ctx.messages.send(name, value?, target?)` sends a named
  message (name like a timer name; value a number, text of at most 256
  characters or true/false) to every script, or only to the scripts on the
  entity `target`; `ctx.messages.received(name)` lists, in send order, the
  messages of that name sent in the previous step to everyone or to this
  object (`{ name, value, from, stepIndex }`). At most 256 messages per step
  (`send` returns false beyond, or for a bad name/value); a new run clears
  them. A behavior may now declare no property at all.

### Spawning prefabs from scripts

A script can put copies of a project prefab into the running game (never
into the project): projectiles, dropped coins, falling crates, enemies from
a spawner. Make the prefab as usual (select an object → Prefabs → create);
in a v4 project a prefab now keeps the object's collider (on its root),
surface, materials, animator and gameplay blocks (mover, trigger, switch,
pickup, enemy, audio source, face movement), so a copy collides, is
collected, patrols or flies like the original. The player controller and
level wiring (camera, lights, zones, spawn markers) never go into a prefab.

- `ctx.spawn(prefabId, { position, rotation?, scale? })` — `position` is
  `[x, y]` (the root keeps the prefab's own z) or `[x, y, z]`; `rotation` a
  quaternion `[x, y, z, w]`, `scale` a number or `[x, y, z]` (a prefab with
  a collider turns about Z only and keeps scale 1). It returns the new root
  id (`spawn-1`, `spawn-2`, …; never reused while the game runs) at once; the copy appears at
  the next step. Children keep their places under the root, and a script
  property that names an object of the prefab points at the copy's object.
- `ctx.destroy(id)` removes a spawned object and its children at the next
  step (`false` if it is already gone). Objects placed in the editor cannot
  be destroyed; hide them with `ctx.game.setVisible`.
- Engine limits: 64 spawns per step and 1024 spawned objects alive; past
  them `ctx.spawn` returns `null` and the runtime diagnostics record one
  `spawn_refused` line. An unknown prefab or bad options stop the game with
  the script error, like a bad `ctx.scenes` call.
- A new run (start, replay, the next level) removes every spawned object.
  Scripts keep running before the run starts, so spawn once the game is
  playing (or spawn again when your object is gone). Saves never keep
  spawned objects.
- A spawned object's own script runs. To let it move its object, list
  `"@self"` in the script's `ownedTransforms` (the source container): every
  object carrying that script — placed in the editor or spawned — may then
  write its own transform and pose with `ctx.emit({ kind: "transform",
  entityId: ctx.entityId, position: { x } })` in the transform phase (never
  another object's; not on the camera or an object with a collider or the
  player controller). A mover or an enemy component moves objects too.

`tl_game_observe` reports `spawned: { count, ids }` (the first 64 ids). Play
and the export carry the project's prefabs with the game.

### Script properties: public and private

A script declares the properties objects give it (`ctx.properties.<key>`):
number, boolean, text, choice (enum), vector, object or asset. Each one is
**public** (the default) or **private**, like Unity's public/private
fields:

- **Public**: shown in the Inspector of every object carrying the script
  and set per object there (or with `setBehaviorProperties`). Optional
  `group` (the Inspector section it is listed in), `header` (a heading
  above it) and `tooltip` (hover help).
- **Private**: not shown and not settable per object or per prefab copy
  (refused with `property_private`); the script always reads the declared
  default. A property made private later keeps any old per-object value
  in the file, unused, until that object's properties are next set.
- An object stores only the public values it sets; a key added to a script
  in use reads its default until set.

Declare them in Bottom dock → **Behaviors**: "+ New behavior" (or select a
behavior) opens the declaration editor — key, label, type, default,
visibility, group, header, tooltip and the type's limits (min/max/step,
max length, choices, vector bounds) — and one save publishes the whole
declaration (one undo step). Saving no longer detaches the behavior's
published source.

Or declare them in the script itself, in `src/index.ts`:

```ts
export const properties = {
  speed: property.number(3, { min: 0, group: 'Movement', tooltip: 'Metres per second' }),
  secret: property.private.number(1),
  mode: property.enum('walk', { values: ['walk', 'run'] }),
};
```

`property[.public|.private].<number|boolean|string|enum|vec3|entityRef|assetRef>(default, options?)`
with literal values; options: label (default: the key in words), min, max,
step, maxLength, values, bounds, group, header, tooltip. The compiler reads
it without running the code and publishes it as the declaration: **the code
wins** over any JSON declaration sent with the source (the source route then
needs none), so the two cannot drift. Such a declaration shows read-only in
the Behaviors tab, and a JSON `declaration-update` of it is refused
(`behavior_declaration_mismatch`, reason `declared_in_code`): change the
source. The source still publishes into an existing behavior record. A
script without that export keeps using its JSON declaration.

**Play debug view**: while Play runs, selecting an object that carries a
script shows under the Inspector the values its running script reads —
public and private — read-only, refreshed twice a second (read from the
running game over the game-observe relay; the editor runs no game code).
`tl_game_observe {entityId}` returns the same values as `behaviors`.

## Game flow, menus and music

Bottom dock → **Game flow** turns a scene into a game with levels (v4
projects). "Set up levels and menus" makes level 1 from the start scenes;
then:

- **Levels** play in the listed order. Each level loads the scenes ticked
  for it (every level must also load the scene holding the player and the
  camera — usually the start scene) and starts at the chosen player spawn. A
  closed scene's spawns appear once the scene is opened in the Hierarchy.
  Each level can loop a music track.
- **Lives**: a death costs one, an extra-life pickup gives one (up to the
  maximum); at 0 the game shows *Game over* (retry the level or quit to the
  title). Without limited lives a death only respawns.
- **Title screen** (always shown with a flow): the game title, a subtitle,
  the instructions and title music; *New game*, *Settings*.
- **HUD and menus**: layout (classic, minimal, corners), a level timer, the
  menu font, colours and an optional logo (a texture asset), the *Level
  complete* / *Game over* texts and credits for the end screen, default
  music, sound and menu-sound volumes.
- **Title screen background**: *the first level's start* (as before) or any
  scene of the project. The chosen scene is loaded while the title shows
  (like a level scene: it may not hold the camera, the player or lights —
  the start scenes' lights shine on it) and unloaded when a level starts;
  the game camera frames its first player spawn (else the middle of its
  objects) the way it frames the player, so keep it away from the levels'
  space. *Slow camera pan* slides the camera sideways by the given metres
  over the given seconds and back (default 4 m, 20 s; works with either
  background).
- **Menu sounds**: an audio asset each for *move* (the selection or a value
  changes), *confirm* (an item is chosen) and *back* (leaving a menu, a
  cancelled rebinding). They play on their own `ui` sound bus; the game's
  Settings then offer *Menu sounds volume*.
- **Ambience** per level: up to four audio or music assets looped together
  on the sound-effects bus while the level plays (and while it is paused);
  they stop on the title, *Level complete*, *Game over* and end screens.

In the game: Esc (or the pad's Start) pauses — *Resume*, *Restart level*,
*Settings*, *Quit to title*. Arrow keys / W-S / D-pad move through a menu,
Enter or pad A chooses, left/right change a volume. **Settings** has music
and sound volume (and the menu-sound volume when the game has menu sounds),
quality (low/medium/high), the jump/attack/interact keys (choose one, press
the new key) and the pad buttons for jump, attack, interact, move left and
move right (choose one, press the new button on the pad; Esc cancels). A
rebound pad button replaces that action's pad button (the keys stay); the
platformer jumps and moves with it at once. Reaching a goal shows *Level
complete* (time, counters, deaths) and goes on to the next level; after the
last one the end screen shows the totals and credits.

**Music** assets are Ogg (Vorbis or Opus) or MP3 files, up to 10 minutes and
16 MB (import them like other assets; a long WAV can be imported with kind
`music` through MCP). Music starts with the first key press or click (the
browser's sound rule), loops, and crossfades between the title and the
levels. `tl_game_observe` reports `flow` (screen, level, lives, music, the
volumes, `menuSounds` {played, last}, `ambience`, the rebound `pad`
buttons), `loops` (each audio source's current gain; a level's ambience as
`ambience:<n>`) and, while the title shows, `titleView` (its scene and the
camera's offset).

Inspector → "+ Add component" → **Audio source** loops an audio or music asset where
the object is: full volume within a quarter of its range, fading to silent
at the range (measured along X from the player); the Scene view draws both
distances. Scripts play a sound with `ctx.audio.play(assetId, { volume })`
(an audio asset; it is presentation only and never changes the game). MCP: `setFlow {flow}` through `tl_command`; with a flow,
`tl_game_control` *start* begins a new game and *replay* restarts the
level. Settings last until the page is reloaded (saving them is phase 9.11).

## Saves

A game with a game flow saves in the player's browser (localStorage): an
**autosave** when a checkpoint is reached and at the start of each next level,
and three **slots** (pause menu → *Save game*). The title screen offers
*Continue* (the autosave) and *Load game*; a game continues at the saved
level and checkpoint with the lives, health, counters, collected pickups and
defeated enemies it had, and with the scripts' saved values
(`ctx.save.get/set/remove/keys`, at most 64 keys of 4 KB JSON each).
Settings (volumes, quality, rebound keys and pad buttons) are saved as soon
as they change.
Each save is versioned, checksummed and at most 64 KB; a damaged one is
named on the title screen and ignored. Play keeps its saves apart from
exported games (and each project apart from the others); **Game flow →
Clear Play save** forgets Play's (MCP: `tl_game_control` `clearSave`).

## Score

**Game flow → Score**: tick *keep score*, then add the counters that earn
points and how many each (*counter*, *points each*, *Add counter*). The
names are the game's own counters: pickups count into `coins`, `gems`,
`keys`, `lives` or a custom pickup's counter, stomped enemies into
`defeated` (the field suggests these and the open scenes' custom counters);
negative points are a penalty. *Time bonus* adds points for every second a
level takes under a target time (default 60 s and 10 points a second;
rounded down, nothing over the target).

In the game the HUD shows the game's score so far ("Score 1230": the
levels completed plus the current level's counters); *Level complete* adds
the time bonus and shows the level's score and its best (or *New best
score!*), the end screen shows the game's total. The best score per level
is kept in the player's browser apart from the save slots, so it survives a
new game (the pause menu shows it); the save slots keep the game's score so
far. Without score rules nothing about score is shown (projects from before
stay as they were). MCP: `setFlow` with `flow.score: { points?: { counter:
points }, timeBonus?: { targetSeconds, perSecond } }`; `tl_game_observe`
reports `flow.score` (game, level, best per level id).

## Level look (per-level environment)

**Game flow → Level look…** on a level opens the **Environment** window for
that level's look. Tick *this level has its own sky / fog /
post-processing / wind* for each part the level changes: the part starts as
a copy of the project's and is edited with the usual controls; everything
not ticked stays the project's. While the level plays (Play and the
exported game) its own sky, fog and wind replace the project's, and its
post-processing settings replace the project's effect by effect (e.g. only
the grading). The title screen shows level 1's look. Levels without a look
(and projects from before) look exactly as before. *project environment*
(or choosing another window) goes back to editing the project environment.

The Scene view shows the look of the level being edited, otherwise of the
level the active scene belongs to (the first level that loads it), with game
lighting; the toolbar's **level look: on/off** (beside *light: game*,
present when that level has a look) switches between it and the project
environment. MCP: `setFlow` with `flow.levels[].environment: { sky?, fog?,
post?, wind? }` (quality stays project-wide).

Also in the Environment window, post-processing grading has **lift**
(raises the blacks, −0.5–0.5), **gamma** (mid-tones, 0.2–5; above 1
brightens) and **gain** (scales the whites, 0–4); the defaults (0, 1, 1)
leave the image unchanged. A **fog volume** (Inspector) has *thins with
height*: its density fades by e^(−k·height) above the box bottom (k per
metre, 0–10; 0 = even fog, as before).

## Icons and gizmos

The Scene view and the hierarchy show what an object is: its light type
(directional, ambient, point, spot, hemisphere), a fog volume, an audio
source, a gameplay piece (mover or door, switch, trigger, pickup, enemy) or
a player spawn. The **Gizmos** menu turns the helpers on and off: icons,
light ranges (point spheres, spot cones), **collider outlines** (every box
and polygon collider on the game plane — a kit piece's `_COL` shape too;
one-way platforms in a softer green), and gameplay paths and areas (an
enemy's chase distance is drawn as the band it notices the player in). A
selected camera shows its real frustum (its field of view, near and far, at
the game view's aspect — the Game preview while it plays, else the window).
Handles for sizes, ranges, directions and paths: see **Scene handles**.

Inspector → "+ Add component" → **Face movement** on a model under the player or an
enemy turns it to face where its parent goes (a yaw for moving right and for
moving left, reached over a short turn time); it keeps its facing while the
parent stands still.

## The player's collision capsule

The player (the object with the controller) collides as an upright capsule.
Select it: the Player controller section's **Collision** group shows the capsule's radius,
height (end caps included, at least twice the radius) and offset (where the
capsule's centre sits relative to the object's origin). Without an own
capsule it uses the default — radius 0.3 m, height 1.8 m, centred — so older
projects play exactly as before. **Fit to model** sizes it to the player's
model and its children's models (their height, half the smaller of width and
depth, the feet at their lowest point); **Default** goes back to the default.
Objects under the player show "collides with its parent's capsule".

The Scene view draws the capsule in the collider colour (Gizmos → collider
outlines); clicking its outline selects the player. While the player is
selected, white handles on the capsule's top and side drag its height (the
feet stay where they are, so the offset follows) and its radius — one undo
step per drag, sizes snap to 5 cm with snapping on (hold Shift for exact
sizes). Every other sized object has handles too — see **Scene handles**.

Everything uses the capsule: physics (walls, ceilings, slopes, one-way
platforms), spawn and respawn placement (the object's origin goes to the
spawn marker; with the offset at half the height the origin is the feet, so
a spawn on the ground puts the feet on the ground), hazard, checkpoint, goal
and exit zones, pickups, triggers, switches, stomps, enemies' chase height
and moving platforms' push-out. MCP: `setComponent` `controller`
`{capsule: {radius, height, offset?} | null}`; `tl_inspect` shows it.

## Scene handles

While an object is selected, the Scene view shows white grips for every
field of its components that has a size, range, direction or path (the
component descriptors say which; the same list the Inspector is built
from). Drag a grip: the object's outline follows while you drag, and the
release stores it in one command — one undo step, the Inspector updates.
Esc cancels a drag. Snapping (the toolbar's snap toggle; hold Shift for one
drag to turn it off): sizes, radii, ranges and polygon corners land on 5 cm,
path points and world-space bounds on the 0.25 m grid, a spot cone's
half-angle on 5°, directions on 0.05 per axis. Values stay inside the
field's range.

- **Box sizes** (`box2`/`box3`): top and side grips (and a depth grip for a
  box mesh and a fog volume); areas stay centred, an enemy's body keeps
  standing on its feet. A box collider's half extents turn with the object;
  a box mesh's size is in the object's own (scaled) space.
- **World bounds** (camera follow): a grip on each edge.
- **Capsule** (the player): see above.
- **Radius**: a circle trigger, a point light's range; along X only for an
  enemy's chase distance and an audio source's range (the engine compares
  horizontal distance).
- **X range** (`segment1d`): an enemy's patrol range, a grip at each end
  (the left end stays left of the right one).
- **Cone** (spot light): the tip grip points it (and sets its range when it
  has one); the rim grip sets its half-angle. **Direction** (directional
  light): the tip grip points it. These grips move on a plane facing you.
- **Path** (mover waypoints) and **polygon** (collider corners): drag a
  point; drag a small grey point on a segment to add one there; Alt+click a
  point to delete it. A polygon collider must stay convex and
  counter-clockwise: a drag that breaks that is shown red and not stored
  (a notice says why).
- **Collider from the model**: "+ Add component" (and the Component menu's
  Collider submenu, and buttons in the Collider section) offer **Box from
  model** and **Polygon from model outline**: the model's vertices (its own
  and its children's models) projected on the play plane; the polygon is
  their convex hull reduced to 8 corners, the box their bounds (a box
  collider is always centred, so an off-centre model gets the same rectangle
  as a 4-corner polygon).
- **Spawn facing**: a player spawn's **Facing** (none / left / right; an
  arrow in the Scene view) turns the player's face-movement models that way
  at once when the player starts or respawns there. MCP: `setComponent`
  `playerSpawn {facing}` (`null` = none).
- **Animator starting values**: the Animator section lists the controller's
  parameters (float, int, bool; triggers start unset) with its defaults;
  setting one stores this object's own starting value, × goes back to the
  controller's default.

The v4 game block has no level bounds or kill height (games state those
rules in scripts), so there is nothing of that kind to draw.

## Tuning values

Every gameplay value a designer tunes is data with an engine default; a
project that sets none plays exactly as before (recorded replays stay
valid). The values are in the component descriptor registry, so the generic
Inspector lists them in groups with units and tooltips; MCP sets them with
the same commands (`setComponent`, `setGameConfig`, `setSettings`; `null`
puts an optional value back to its default).

- **Player (`controller`)** — *Movement*: acceleration 40 m/s²,
  deceleration 60 m/s². *Jump*: coyote time 0.05 s, jump buffer 1/15 s
  (0.067), jump release 0.5 (the share of the upward speed kept when jump is
  released early; 1 = fixed jump height). *Collision*: ground snap 0.1 m,
  skin 0.01 m, autostep off (on: climbs steps up to its height, default
  0.25 m, without jumping). The steepest walkable slope, run speed, jump
  speed and gravity stay project settings (`max_slope_climb_deg` …).
- **Health** — hit bounce 5 m/s, knockback time 0.25 s, grace time 1 s.
- **Enemy** — stomp bounce 9 m/s, stomp tolerance 0.2 m (how far below its
  top the player's feet may be for a stomp), defeat effect squash / fade /
  none over a defeat time of 0.3 s (fade draws the enemy fading out), chase
  height 2 m, and for edge walkers the wall probe (0.05 m ahead) and ledge
  probe (0.4 m down from 0.1 m above its feet).
- **Mover** — max push 60 m/s: how hard it shoves a player out of its way
  (0.5 m per step at 120 Hz; a safety limit). The gap it keeps is the
  player's skin plus 1 mm.
- **Pickup without a size** — collects over its model's recorded bounds (its
  own model, else its first model child, scaled by their transforms); models
  imported from now on record their bounds (from the glTF position bounds,
  collision `_COL` nodes left out). Without bounds (no model, or one
  imported before) the area is a neutral 1 × 1 m.
- **Camera follow** — distance: absent, the camera stays at the depth it is
  placed (its z minus the player's); set, it keeps that distance in front of
  the player plane. Max speed 480 m/s (the per-axis cap while smoothing; 4 m
  per step at 120 Hz).
- **Game block (session)** — respawn delay 0.25 s, drop-through time
  0.125 s (down + jump on a one-way platform), settle time 0.1 s (the world
  settles before the first frame).
- **Project settings (engine)** — fixed step 60 / 120 / 240 Hz (default
  120; times in seconds keep their length, a replay is recorded at one
  rate), sound voices 8 (at most 32), music fade 1 s, animation blend 0.2 s
  (the idle/run/airborne model animation; animator transitions have their
  own durations). These are stored only when set.

### Engine limits (constants)

These protect the runtime and are not tuning values:

| Limit | Value |
|---|---|
| Fixed-step catch-up per frame | 8 steps (the rest are dropped) |
| Script physics queries | 32 per step |
| Zones per scene | 64 |
| Game-view events kept | 32 |
| Sound voices | 32 at most (the `audio_voices` setting's range) |
| Registered sound assets / music tracks | 16 / 64 |
| Spawns | 64 per step, 1024 alive |
| Timers | 64 per script instance |
| Camera "no move" threshold | 1e-9 m; aspect 16:9 until the host reports the viewport |
| Model animation run threshold | 0.05 m/s |
| Shadow-follow extent | 24 m |
| Stick dead zone default | 0.2 (per action: `deadZone`) |

### Engine defaults

Every default is sized for any project, not for a sample: sizes are set
against the default 1.8 m character and its 1.25 m jump, and each default has
its reason next to it in the code (`project-model/src/descriptors.ts` and the
constants it names). The GameObject menu's camera and lights are the same
values as "+ Add component" and a new project's starter camera and lights
(a white key light at 1.2 with shadows and a cool fill at 0.6, a 60° camera).
A new checkpoint glows plain white; a gradient sky is grey below the
horizon; an instance scatter starts as a 20 × 20 m square. Samples (Beacon
Reach) keep their own values in their own data. The classic HUD's prompts name the game's
actual move and jump bindings (the player's rebinding included), with pad
button names while a pad is in use; a saved rebinding also applies in a game
without a game flow. Scene validation now refuses
negative camera-follow dead zones and smoothing, directional/ambient light
intensities, surface roughness/metalness/glow and checkpoint glow (they were
accepted before although the range said `0 ≤ v`).

## Renderer backends

Play, the exported game, the Scene view, the asset/Animator previews, the
asset thumbnails and the browser lightmap baker get their renderer from one
factory. Since phase 17.4 everything draws with three's `WebGPURenderer`,
all shading written once in TSL (node materials and node post-processing);
three's older `WebGLRenderer` path is gone (archived in the repository under
`archive/webgl-renderer-17/`). Three backends:

| Name | What draws | |
|---|---|---|
| `auto` | WebGPU when the browser gives a working adapter and device, else the WebGL 2 backend | the default |
| `webgpu` | WebGPU; where WebGPU cannot start it runs on WebGL 2 and says why | |
| `webgl2` | the WebGL 2 backend, even where WebGPU would work | |

Choose one in **Gameplay → settings → Renderer** (the `render_backend`
project setting: 1 auto, 2 WebGPU, 3 WebGL 2; MCP:
`setSettings {render_backend: 3}`). The Scene view switches at once; the
next Play and the next export use it. A URL flag overrides the setting for
one page: `?renderer=auto|webgpu|webgl2` on the editor URL (the editor
passes it on to Play) or on an exported game's `index.html`. To force WebGL 2
(an older GPU driver, a WebGPU bug, comparing the two), set the setting to
"WebGL 2" or add `?renderer=webgl2`. A project that stored 0 (the removed
WebGL renderer, "legacy") and an old `?renderer=legacy` link get `auto`.

Browser support: WebGPU needs a browser with WebGPU and a secure context —
https, or `localhost`/`127.0.0.1`. Every other page (plain http on a LAN
address, a browser without WebGPU) gets the WebGL 2 backend at once, with the
reason; a browser without WebGL 2 cannot draw (Play reports
`render_unsupported`).

What was chosen and why is shown in the status bar ("scene view: …", the
reason as its tooltip), in the Play label above the game, in
`tl_diagnostics` (the play's `renderer.renderer` block: requested backend,
where the choice came from, the backend that draws, its state and the
reason), in `tl_game_observe` (`renderer`) and on every render canvas
(`data-tl-renderer`, `data-tl-renderer-state`, `data-tl-renderer-reason`).

If the GPU device is lost the
renderer is rebuilt on a new one (at most 3 times, then it reports `failed`:
reload the page); a lost WebGL context is rebuilt when the browser restores
it.

Project materials draw the same on both backends: the material library
builds node materials (TSL) for each shader type —
standard, foliage wind (COLOR_0 + the global wind), kit (world-X UVs, the
UV1 macro normal), unlit, water — and lightmaps (UV1, the bake's range, the
lights a bake holds left out), the Scene view's selection tint and the
checkpoint glow work there too. A pixel test compares each against the
reference images the old WebGL renderer drew (`tests/e2e/shader-parity/`).

The environment draws the same on both backends too (phase 17.3): every sky
mode (physical — three's TSL sky —, gradient, colour, texture as an equirect
image or six cube faces) with its image-based lighting, fog, fog volumes
(with the height falloff), shadows (also the square that follows the camera
in games without level bounds) and the whole post stack per quality level —
ambient occlusion, depth of field, bloom, grading with lift/gamma/gain, the
LUT and the vignette, SMAA/FXAA and AgX/ACES/Neutral tone mapping — as
three's node post-processing. A level's own look works the same. A pixel
test compares 21 environments with the old WebGL renderer's reference images
(`tests/e2e/env-parity/`). Differences from the old WebGL renderer you may
see: scene fog is mixed before tone mapping (the WebGL renderer mixed it
after when there was no post stack), so its tint is a little different;
ambient occlusion has a different noise pattern and depth of field a
slightly different blur shape; the low quality level also turns MSAA off.

**Shadows (phase 17.4).** Boxes, models and instance sets cast and receive
the sun's (the directional light's) realtime shadow when the light has "Cast
shadows" on. Each has **Casts shadows** and **Receives shadows** checkboxes
in its Box / Model / Instance set section (on by default; turn them off for a
decal, a glow or a distant backdrop). The sun's shadow is tuned in its Light
section: **Shadow map size** (512–4096, default 1024), **Shadow bias**
(default −0.0005), **Shadow normal bias** (default 0.02 m) and **Shadow
extent** (half the side of the shadowed square that follows the camera in a
game without level bounds, default 24 m). Before, only instance sets cast
shadows, with a fixed 512² map without bias (they striped themselves).
The Scene view shows no realtime shadows (Play and the export do).

Fixed with phase 17.3: the gradient sky now shows — it sat
4 km out, beyond every camera's far plane (1 km in the Scene view, 100 m by
default in games), so only its lighting was seen — and it is tone mapped
like the rest of the picture. The browser lightmap baker ("Bake preview")
draws with the editor's renderer backend (it reads the atlases back
asynchronously), and a lightmapped object in Play picks up its
project material's texture even when the texture arrives after the
lightmap.

The kit's macro normal map shows since phase 17.2: before, it was silently
never applied (a shader-hook bug), so kit pieces with a macro normal map
look bumpier than before. Thumbnails render with the backend the editor had
when it drew the first one.

Exported games link only three's WebGPU build (`three/webgpu`, which carries
the whole three core, plus TSL); the WebGL renderer code is no longer in the
bundle (`js/main.js` about 0.8 MB smaller unminified, see
`docs/plan-phase-17.md` §6). On this CPU-only server the WebGL 2 backend and
WebGPU (Dawn on SwiftShader) are slower than the old WebGL renderer was;
real-GPU looks and frame times: owner look pending.

## Performance

Phase 21 measures the engine against written budgets with generated
benchmark projects and an automated harness. The budgets (frame time,
heap and GPU memory, load time, draw calls, simulation step cost and
garbage, editor command latency, per scene class) are in
`docs/plan-phase-21.md` §2 and `tools/perf/classes.ts`; they are for a
mid-range desktop GPU at 1920×1080. Measured numbers are in §4 there.

**Benchmark projects.** Five classes — small (100 entities), medium (2000
entities, 50 materials, 20 effects), large (16 000 entities over 10 scenes,
four instance sets of 50 000 copies), script-heavy (500 scripted objects),
effect-heavy (20 effects, 50 000 particles) — are generated
deterministically (`tools/perf/generate.ts`, seed 21) and built through the
real HTTP API into a throwaway data root under
`~/.cache/thirdlight-perf/runs/` (deleted after the run unless `--keep`).
Effects are generated but not drawn until phase 20.2.

**Run the harness** (needs `dist/`; not part of `npm test` or the default
Playwright run):

```sh
npm run build
node tools/perf/run.mjs                                  # every class, legacy + webgl2 renderers
node tools/perf/run.mjs --classes small,medium --quick   # a short smoke run
node tools/perf/run.mjs --renderers webgpu               # WebGPURenderer on (headless) WebGPU
node tools/perf/run.mjs --compare tests/perf/baseline.json   # exit 1 on a regression
```

Options: `--classes`, `--renderers legacy,webgl2,webgpu,auto`, `--surfaces
play,export,editor,sim`, `--record-ms`, `--warmup-ms`, `--commands`,
`--sim-steps`, `--viewport WxH` (default 1280x720), `--seed`, `--keep`,
`--out FILE`, `--write-baseline FILE`. For each class and renderer it
measures:

- **Play** (the editor's preview iframe) and the **export** (served by a
  plain static server): first-frame time, rendered-frame intervals
  (p50/p95/p99), draw calls and triangles per frame, live programs or
  pipelines, textures, buffers and an estimate of GPU memory — counted at
  the WebGL / WebGPU API, so the legacy renderer and WebGPURenderer are
  measured the same way — the JS heap after a forced collection
  (`performance.memory`; `measureUserAgentSpecificMemory` needs a
  cross-origin-isolated page and is reported unavailable), and for Play
  three's own renderer counts from the play diagnostics;
- the **editor**: time to the Scene view's first frame, frame intervals while
  orbiting, heap, and the p95 round trip of `setTransform` commands with the
  project open;
- the **simulation** in Node (runtime, platformer, Rapier and the project's
  scripts, headless, `--expose-gc`): step cost percentiles and the bytes
  allocated per steady step.

The JSON report goes to `~/.cache/thirdlight-perf/reports/<time>.json`
(and `latest.json`) with the machine, its load average at start and end, the
calibrations and every number above.

**Regression check.** This server renders on the CPU (SwiftShader) and
shares its cores, so absolute times say little. The checked-in baseline
`tests/perf/baseline.json` stores only machine-independent metrics: counts,
memory, and times divided by a calibration measured in the same run (a fixed
raw-WebGL page for frame times, a fixed arithmetic workload for Node times).
`TL_PERF=1 npx vitest run tests/perf/regression.test.ts` runs the harness
and fails on a regression beyond the tolerance (`tools/perf/stats.ts`:
counts +10 %, memory +25 %, calibrated times +75 %);
`TL_PERF_REPORT=<report.json>` compares an existing report,
`TL_PERF_CLASSES=small` limits it and `TL_PERF_KINDS=count,memory` leaves
out the calibrated times (the noisiest here). The always-on checks are
`tests/perf/plumbing.test.ts` (generator and comparison) and
`tests/e2e/perf-harness.e2e.ts` (the whole harness on the small benchmark).
Frame and load times on a real GPU: owner look pending.

## Upgrade

```sh
node tools/backup.mjs create <each project>       # with the backend stopped
git pull
NODE_ENV=development npm ci --include=dev
npm start -- --build
node tools/project.mjs check ~/projects/<game>    # per folder project; --repin once verified
```

Projects in an older layout are upgraded the first time they are opened
(see "Projects").

## Verification

```sh
npm test                                    # unit + integration (vitest)
npm run build && npm run test:e2e           # Playwright: real backend + Chromium
npx playwright test --project=default       # every spec, WebGL 2 (no WebGPU)
npx playwright test --project=webgpu        # the renderer-sensitive specs with headless WebGPU
node tools/perf/run.mjs                     # the performance harness (long; see "Performance")
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
in `default`, `webgpu` in `webgpu`; the shader-parity and env-parity specs
compare every shader type and environment with its reference image (drawn
by the old WebGL renderer, frozen since phase 17.4) on WebGL 2 and on
WebGPU.

The browser tests need Playwright's Chromium (`npx playwright install
chromium`); on this LXC they use the library tree described in
`tests/e2e/browser-env.mjs`.
