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
Templates are directories under the engine's `templates/`
holding `captured/project.json` (+ `assets/`, optional `template.json` with
`name`, `description`, `requiredModules`). `templates/starter` ("Starter")
is the neutral one: a ground, three boxes, a character with the controller,
a spawn point, a camera, two lights and a pillar model, with no game rules
(it plays as a scene). It is rebuilt by
`templates/starter/tools/build-template.mts`. The engine ships no sample
games (phase 24.7): games live in their own repositories.

A project directory holds:

- `project.json`: id, name, engine version (schemaVersion 5; a 4 or older
  is upgraded on open);
- `content.json`: the project-wide settings: settings, tags, the scene list
  and the start scenes, the environment (its presets' order), input, the game
  shell, event sounds, modes, the save schema, speakers and dialogue
  settings, the revision and the retry records;
- `scenes/<sceneId>.json`: one file per scene, unless it was created in a
  folder of the game folder or moved there (below);
- `sources/sha256/<digest>`: script sources and instance-set buffers (and
  asset versions an older project stored there).

In the game folder (a project in the data root is its own), each asset is a
file with its `.tlasset` sidecar, which holds the asset's record (id, kind,
import settings, labels); each prefab, script (behavior), material, animator,
graph, effect, script library, UI document and theme, dialogue, timeline and
environment preset is its own `<name>.<kind>.json` file, in `assets/<kind>/`
unless moved (the open finds them anywhere in the game folder by their name
and id). A scene may live in the game folder too, as `<name>.scene.json`
(the same format as `scenes/<id>.json`), found by the scene id it holds.

**Where new things go.** The folder chosen in the Assets tab's project
window (the upload folder's rules: inside the game folder, no hidden folder,
not the project's own files) is where uploads land and a new scene, prefab,
material or other resource is created (`<folder>/<id>.scene.json`,
`<folder>/<id>.<kind>.json`). With "All assets" chosen: scenes go to
`scenes/`, resources to `assets/<kind>/`, uploads to `assets/`. MCP and scripts send `folder`
with the create command (`createScene {name, folder}`,
`setMaterial {material, folder}`, …). A record a command only changes stays
where its file is; undo and redo put a file back where it was.

**Moving files in the editor.** The project window moves assets (with
their `.tlasset` sidecars), resources, scenes and whole folders by drag and
drop or cut and paste, renames and makes folders; each is one command and
one undo (`moveResources`, `renameFolder`, `createFolder`, also over MCP).
Ids never change, so no reference and nothing a build ships changes.

**Files changed outside the editor while it is open** are picked up by the
same file check as assets (on connect, window focus, "check files", MCP
`tl_content_query {target: "integrity", check: true}`): a resource or scene
file moved or renamed is followed (paths are not stored, so no revision); a
file added or copied comes in as one undoable `importResources` command (a
copy of a file whose id the project has gets a new id from its file name; a
copied scene's objects get new ids); a changed resource file is reloaded and
a removed one leaves the project. A scene file changed or removed outside the
editor, a resource file that no longer reads or validates, or one removed
while something uses it pauses the project on that file (accept the disk or
keep the editor's version, as for any external change). A new file that
cannot be read is a Problems row and stays out. At the open, a resource file
that does not read is left out with a Problems row; of two files with one
id, the one named after it is the resource and the other is taken in as a
copy by the first check.

**A lost `.tlasset`** (deleted while the project was closed, dropped by a
merge) is put back when the project opens: from the record cache
(`cache/records/<id>.tlasset`, a copy of every sidecar this machine wrote,
git-ignored) with its id, settings and labels, else, while a scene or
resource still uses the id, by importing the file named for the id again
with default settings. Problems says which (`asset_sidecar_restored`,
`asset_sidecar_rebuilt`). An id that neither can put back still stops the
open, which names it: put the sidecar back or import the file with that id.

`content.json` and the scene files are indented JSON with every list of
objects written one item per line (one entity, material or retry record per
line), so a diff shows one line per changed item and an edit writes about a
third of the fully indented size. Any JSON reader reads them.

An edit writes only the files it changed. An edit that touches several files
(a new scene: the index plus its file) goes through a small redo journal
(`.thirdlight/journal.json`), so a crash in the middle is completed at the
next open. `.thirdlight/` is process state (ownership, recovery, staging,
derived caches, the journal); it is not part of a backup.

**Older projects upgrade automatically** the first time the backend opens
them. A v3 project (one `scenes/main.json` envelope) becomes one scene,
"Main" (`scenes/scene-main.json`); the old envelope is kept as
`.thirdlight/migrated-v3/main.json`. The level bounds and a kill height
are dropped: falls are game rules, a project script's (for example a
trigger below the level whose `enter` event a script answers with
`ctx.lifecycle.respawn`). Take a backup first if you want the old files
outside `.thirdlight/`.

**A project from before the asset database** (`project.json` schemaVersion
4, or an earlier 5 whose `content.json` still holds every record) is upgraded
on open too, and **the upgrade writes into the game folder**: each asset's
current version becomes a file with its `.tlasset` sidecar (bytes the
project stored are written to `assets/<name>.<ext>`; a file already
referenced in place stays where it is and gets a sidecar next to it; an FBX
or a PNG/JPEG with a KTX2 encode keeps its original as the file and what was
made from it in the import cache); each prefab, script, material, animator,
graph, effect, library, UI document and theme, dialogue, timeline and
environment preset becomes its own file in `assets/<kind>/`; `content.json`
keeps only the project-wide settings. `music` records and the old 2 s WAV
sounds become `audio` with their ids; an asset a script names by id gets the
label `script-named`, so it keeps shipping. Ids do not change, so scenes,
recorded retries and replays stay valid. Older versions of an asset stay in
`sources/sha256/` untouched and are listed in `upgrade-report.json` next to
`project.json`; Problems notes the upgrade once (`project_upgraded`). So
opening an older game's folder with this engine adds files and sidecars to
it: commit (or back it up) before, and commit what the upgrade wrote after.

### What you can do now (asset scale and streaming)

A project holds as many assets and resources as a full game needs (the
scale bench's project has 18,000 asset files — 10,000 voice lines, 5,000
textures, 2,000 models — and 5,000 prefabs, 2,000 materials, 300 scenes and
2,000 voiced dialogue lines), and the game loads and frees them as it plays.

- **Assets are files with sidecars** in the game folder, **resources and
  scenes are files** in folders you choose, and the **project window**
  browses, searches (`t:` / `l:`), labels and moves them (see "The asset
  database" and "The project window" above).
- **Import a folder** of any size in one command with labels on every file
  (**import folder…**, `importAssets`).
- **Labels and addresses** make assets and resources loadable by name:
  scripts load them with `ctx.assets.load(key)` and let them go with
  `ctx.assets.release(handle)` (see "Loading assets by name from scripts").
- **Audio is one kind** with a load type and preload per file (see "Music,
  fonts and audio"); nothing audio is read at start, and a conversation reads
  its voices a few lines ahead.
- **The game frees what it no longer uses**: each loaded file, model,
  texture, sound and font is held by the scenes, objects, sounds and handles
  that use it and freed when the last one goes (`resources` in
  `tl_game_observe` and Play diagnostics shows what is resident per kind).
- **Large textures stream** their mips inside the texture budget (see
  "Texture streaming").
- **Play and the export read what they need**: the runtime manifest is about
  2 KB at any size and points to a catalog read in parts (a scene load reads
  its scene and its dependency list); Play serves files from disk, the export
  copies them one at a time.
- One file's size and the runtime's memory are bounded; the number of
  assets and resources is not (see "Engine limits").

### What you can do now (phase 24: engine and game kept apart)

Thirdlight holds generic capabilities only; a game's rules are its own
project scripts (in its own repository when it has one).

- **Start from the Starter template**: ground, boxes, a character with the
  controller, a spawn, a camera and lights, no game rules.
- **Build a game from primitives and scripts**: collectibles adding to named
  counters, health on any object with `damaged`/`died` events, patrols,
  hitboxes with contact events and damage, triggers with enter/exit events
  and scene transitions, movers, switches, a camera track, look overrides,
  event sounds, and `ctx.lifecycle` (respawn, restart). What a collected item,
  a hit or 0 health *means* is decided by the project's scripts. A tested
  example: `tests/e2e/starter-game.e2e.ts` builds a small game in the
  editor (a collectible counted in a HUD, a patroller whose hit a script
  turns into a respawn, a door to a second scene, a title screen) and plays
  it.
- **Menus and HUD** are the game shell's UI documents (title, pause,
  settings, controls, save and load screens, HUDs, the scene list).
- **Saves**: project save slots, save format version 2 (the save carries
  the loaded scenes, the spawn and where the character stands).
- **Input**: named actions only (input frame version 2); the character
  controller reads the actions it names (`moveAction`, `jumpAction`;
  defaults `move`, `jump`).
- **Older projects**: a schemaVersion 2 project is upgraded on open (a
  pickup becomes a collectible and its counter, a spawn's left/right facing
  a yaw, a pickup's sound an event sound) and written back once. Game data
  the engine no longer has — a game block, a level flow, enemies, game
  zones, the session camera follow, and pickup rules such as healing or
  "back on death" — is refused: the project does not open; the open error names each
  problem and the picker shows the first ("component "enemy" (…) was removed
  in phase 24: build it as project scripts"). Rebuild those parts as
  project scripts on the primitives, then open it again.
- The build fails when a package's source uses genre words (coin, enemy,
  checkpoint, score, platformer, …; `tools/check-boundaries.mjs`, with a
  short reviewed allowlist for the upgrade code).

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
right kind — models, audio, textures), object pickers (only objects
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
spot, hemisphere; Patrol: edge to edge, waypoints; Collider: box, polygon). A component
that needs a choice first — a model's asset, a script, an animator's
controller, an audio source's sound, a material mapping — opens a small form
with just that choice and **Add**. Components that cannot be added are
listed greyed with the reason: already on the object, excluded by another
one ("an object shows one model, box or camera"), needing another one (a
surface needs a box or a model), or made by
a tool (instance sets, prefab copies, folders). Each section has **remove**;
box, camera and model are added and removed like any other component
(`setComponent` with a complete value / `null`).

Some sections have extra tools next to the generic fields: the player
controller's capsule (**Fit to model**, **Default**), a surface (presets), an object's materials (the mapping
editor, which knows the model's own material names) and a script (its
declared properties). Gameplay → Settings is built the same way (every project setting, the engine
settings included; the step rate is a choice of 60, 120 or 240 Hz; each
change is saved at once); the Gameplay tab's Camera page points to the camera object, whose
lens and follow settings are Inspector sections. The Media tab is for
listening to the project's sounds.

## Hierarchy: folders and flags

- **Folders** (GameObject → Folder, or `createEntity {kind: "folder"}`)
  only organise. A folder has no transform and sits at the root or inside
  another folder, never under an object. Filing something into a folder keeps
  it where it is in the world. Triggers, spawns and physics bodies may sit in
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
- **Long lists.** Above 400 rows the list is windowed: only the rows in view
  (and a margin) are in the page, with a fixed row height, so thousands of
  objects scroll, select and rename as fast as a few. Selecting an object in
  the Scene view scrolls its row into view. The filter works on every row.
- **Flags** (inspector: Active, Locked, Static; `updateEntity {active,
  locked, static}`) are stored on the entity in the scene, only when they
  differ from the default.
  - A folder passes all three down to everything inside it.
  - An inactive object also deactivates its own children.
  - The inspector shows the entity's own value, and next to it any value it
    inherits and from where.
  - Inactive: hidden in the Scene view and left out of Play and the export.
    The scene camera must stay active.
  - Locked: editor only. The object cannot be picked or moved in the Scene
    view, but can still be selected in the hierarchy.
  - Static: stored and inherited; nothing uses it yet.
  - **Visible** off (`updateEntity {visible: false}`, also on
    `createEntity`): the object starts the game hidden. It is loaded,
    collides, triggers and ticks, but is not drawn (with its children) until
    a script (`ctx.game.setVisible`, `ctx.entity(id).set('object', {visible:
    true})`) or a timeline activation key shows it; every restart hides it
    again. The Scene view still draws it; the Hierarchy marks it `H`. Not on
    folders (they are not in the game).
- `updateEntity` with `parentId` keeps the world position too (it used to
  keep the local values).
- **Bulk building** (phase 25.7e): `createEntity` also takes `active`,
  `locked`, `static` and `tags` (tag names), so an object is made with its
  flags in one step. `createEntities {entities: [createEntity args + ref?],
  sceneId?}` makes up to 1024 objects (and folders with their children) in
  one revision and one undo step; a later item's `parentId` may name an
  earlier item's `ref`. One bad item refuses the whole batch, at its path
  (`/args/entities/<i>/…`). The change lists the created objects in order.

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
  The registry travels in the Play/export catalog (`tags`), so an exported
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
  merged. The camera, the player and the start spawn live only in start
  scenes.
- **Lights belong to scenes** (phase 25.8). Any scene may hold any light:
  at most one directional, one ambient and one hemisphere light and 16
  point/spot lights per scene. With scenes loaded together (start scenes in
  their listed order, then loads in order), the most recently loaded
  scene's directional light is on and the others are off; the same for
  ambient and hemisphere lights, each kind on its own (a scene with only a
  sun keeps the fill light below it). When that scene unloads, the previous
  one's light comes back. Point and spot lights of all loaded scenes share
  the budget of 16; past it the most recently loaded scenes' lights are on.
  The Scene view applies the same rule to the open scenes, in hierarchy
  order. Play diagnostics (`renderer.lights`) name the lights that are on.
- **Spot light cookies** (phase 25.8): Inspector → Light → Cookie picks a
  texture the spot projects through its cone (three's `SpotLight.map`;
  white passes the light, black blocks it, colour tints it), in the Scene
  view, Play and the export, on WebGPU and WebGL 2. Directional lights take
  no cookie.
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
  - A loaded scene brings its colliders, script instances, tags and triggers.
    An unload releases them: colliders leave the physics world, scripts get
    `dispose`, meshes and textures are freed, and a model no loaded object
    uses any more is released.
  - A scene holding the camera, the player or the start spawn cannot be
    unloaded (its lights go with it).
  - A replay returns to the start scenes.
- **Scene transitions**: a trigger's scene transition loads and unloads
  scenes when the character enters it and can name a spawn it arrives at
  (see "Scene transitions, impulses, …").
- **Game rules in scripts.** There are no level bounds or kill heights any
  more.
  - `ctx.world.transform(entityId)` reads any loaded object's current
    position, rotation and scale.
  - `ctx.lifecycle.respawn(spawnId?)` puts the character back at a spawn.
  - `ctx.emit({kind: 'pose', entityId, rotation: {yaw, pitch, roll}, scale})`
    (transform phase, an entity the script owns; degrees, applied yaw then
    pitch then roll; `scale` is a number or `[x, y, z]`; either may be left
    out) turns or scales it — a spinning sign, a pulsing light. It is visual:
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
- **Chunks** (phase 25.7d): a set is drawn in chunks, each hidden when out of
  view and given its level of detail at its own centre. The copies are split
  by count (about 2048 per chunk) and by extent: no chunk is wider than the
  chunk size, 32 m unless the project sets **Rendering → Instance chunk
  size** (`setSettings {instance_chunk_m}`, 1–4096 m) or the set its own
  (Inspector → Instance set → **Chunk size**, `instances.chunkSize`; `null`
  puts it back to the project's). A set needs at most 256 chunks; a wider one
  gets larger chunks. The Inspector says how many chunks the selected set is
  drawn in. Smaller chunks cull and pick levels of detail more finely at the
  cost of more draw calls where many are in view. Play, the export and the
  Scene view chunk alike.

## Deleting assets and prefabs (phase 25.7c)

Assets → select an asset → **delete**, and Prefabs → **delete** on a
definition (MCP: `deleteAsset {assetId}`, `deletePrefab {prefabId}`, the
same commands). A delete is refused while anything uses the record: an
object in any scene (a model, an instance set, an audio source, a pickup
sound, a script property of type asset, a placed prefab copy, a block look),
a prefab, another asset (clips for a rig), a material's texture, a UI
document, dialogue, a timeline, the shell, or a script whose source names
the id as a string literal (`ctx.spawn("crate")`). The refusal is
`reference_in_use` and lists the uses (scene, path); the editor shows it under
the button. Remove those first (a placed copy is deleted like any object).
A deleted record's stored bytes stay in the project's content store, so one
undo brings it back as it was; a file referenced in a game folder is never
touched.

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
`tl_content_query`, `tl_instance_buffer`, `tl_playtest`).

`tl_input_exercise` (phase 25.15) drives a play step by step. A frame may
hold for `steps` steps (up to 7,200 in one call; its first step as written,
the rest with pressed actions held); steps no frame covers are neutral. A
frame's `ui` edges (`up`, `down`, `left`, `right`, `submit`, `cancel`,
`pause`) drive menus like the keys, also while the game is paused. Its
`pointer` goes through the UI hit test: a press and release on a UI button
clicks it, and scripts read `ctx.input.pointer().overUi` (the real mouse
too). A `gamepad` `{buttons, axes}` is a virtual standard pad read through the
project's bindings. `tl_game_observe` lists the shown widgets' rectangles in
`ui.elements`. With `restart: true` (phase 25.16) the exercise restarts the
game and applies its frames from the new run's first step;
`tl_game_observe`'s `run.lastInput.digest` is the world's digest right after
its last step, so the same frames run twice give the same digest when the game
is deterministic. With `hold: true` (phase 25.17) the game holds right after
the exercise's last step until the next exercise, which begins at exactly the
next step: a tool can observe, decide and go on step for step, whatever the
time between its calls. `tl_play_start {threads: "worker"|"single"}` picks
where one play's simulation runs; start `variables` apply at the start and
again at every restart (a replay, a shell's New game).

**Which engine is running (phase 25.18).** `tl_inspect target="engine"` (or
`GET /api/v1/engine` with any token) answers the version, commit and lockfile
the backend started with, the build it started with (`dist/build-info.json`,
written by `npm run build`), its start time, and `dist.newerThanProcess`: true
when dist/ was rebuilt after the backend started — restart the service
(`sudo systemctl restart thirdlight`) to run it. Graph materials are compiled
by the backend when it loads a project and after every change:
`tl_diagnostics` lists the broken ones in `materialProblems` (and logs a
`material_graph_problems` entry when problems appear), and
`tl_content_query target="materials"` pages every material with its
problems (`withProblems: true` for the broken ones only).

**Headless play-tests (phase 25.17).** `node tools/playtest.mjs <game folder>
--input script.json` (or the MCP tool `tl_playtest {frames}`) plays the game
from its start with an input script — `tl_input_exercise` frames counted from
the run's first step, as long as an hour — and prints JSON: per run the run
digest and the observed fields (`--fields player,ui.values`, `--at 60,400`
for observations inside the run) and whether the runs agreed. `--runs N`
plays it N times, `--threads both` in the simulation worker and on a single
thread; every run begins with a restart and the script is sent as exercises
that hold the game in between, so the runs of a deterministic game give the
same digests. `--driver bot.mjs` runs the project's own driver instead: a
Node module of the game folder whose default export `async (game) => result`
plays each run with `game.step(frames)` (returns the observation after them),
`game.wait(n)`, `game.observe()` and `game.log()` — a genre's test bot is
game code and lives in the game's repository; the engine ships none. Drivers
run from the command line only (the MCP process runs no project code). With
no editor open the backend plays in its headless editor; the game runs at its
step rate. The exit status is 0 when every run finished and they agreed.

`tl_screenshot` always answers: a capture the preview cannot make comes back
as `relay_failed` with the preview's code in `cause` (`screenshot_failed`,
`render_failed`, `not_ready`) and its reason in the message. A PNG over the
1 MiB bound is captured again at a smaller width; the reply's `width` says
which. It works the same on the WebGPU and WebGL 2 renderers.

A play that has ended says why. `tl_game_observe`, `tl_diagnostics`,
`tl_game_control`, `tl_screenshot`, `tl_input_exercise` and `tl_play_stop`
on it answer `play_not_found` with `ended {reason, presented, at, detail?}`
(`request`, `preview_failed` with the preview's code and message,
`preview_timeout`, `expired`, `session_lost` — the editor page that ran it
closed, reloaded or lost its connection, or the owner's browser took the
project over from the headless editor) and the reason in the message. A play
that ended before it was presented (other than by a Stop or a reported
preview failure) is also listed in the project's problems
(`tl_diagnostics` without a play id). An id the backend never had (for
example after a backend restart) stays a plain `play_not_found`. The
backend keeps the last 64 ended plays for an hour (their end, not their
scene); an older one answers a plain `play_not_found` too.

Where a Play's start time went (phase 25.24a): `tl_diagnostics` on a play
has `startTimings` — stages in ms from the preview page's time origin
(`epochMs`): `bundleFetch`/`bundleEval` (the game bundle), `handshake`,
`snapshot`, `manifest`, `startScenes`, `worker` (overlaps the reads),
`assets`, `mount`, `models`, `ready`, `rendererInit` and `firstRender` (the
first drawn frame's own call), then `firstFrameMs` and the frames in the
10 s after it (how many over 50/100/250 ms, the worst eight), and each scene
loaded during play (request, read, the frame that attached it, the frames
after). The reply's `buildTimings` is the backend's part (session, state,
capture, bundle, `closure.*`, publish, total); the play-start reply carries
the same as `timings`.

A Play (and an exported game) builds its shaders before it shows the first
picture and before it shows a scene loaded later (phase 25.24d): the
`precompile` stage above, and `renderer.precompile` in the diagnostics
(runs, failed, gave up, the last one's ms). Meanwhile the previous picture
stays. Repeated objects of one material are drawn with one shader however
many batches or instance-set chunks they form (`renderer.batching.programs`;
`renderer.instanced` counts both).

From the second Play on, the browser takes the game's scripts and the
project's files from its cache (phase 25.24c): the preview origin serves the
game bundle and the worker scripts under `/play-build/<digest>/`, and a
project's models, textures, scene files and compiled scripts by their digest
under a per-project address, with `Cache-Control: private, max-age=31536000,
immutable` and the digest as `ETag` (a proxy in front of the preview origin
should pass these headers on). The page still checks every file against the
build before using it. The addresses change when the backend restarts.

A Play (and an exported game) reads only its start scenes' files before it
starts (phase 25.24b): the models, textures and bakes its start scenes use,
eight at a time, each checked against the build. A scene loaded later reads
its own when it loads, and a sound is read when it first plays. The
diagnostics' `assetReads` counts what has been read so far.

A scene loaded during play is prepared before it appears (phase 25.24e):
its file, models, textures and instance buffers are read and parsed first,
so the frame that shows it shows all of it. The scenes a game is likely to
load next — the targets of the scene transitions in its loaded scenes and
the shell's next listed scene — are read ahead in the background (at most
four). A scene transition (a trigger's, a move along the shell's scene list,
or `ctx.scenes.load(id, {unload: [...]})`) keeps the scenes it unloads in
view until its scene is in, then swaps them in one step, so the view never
shows an empty world. Its optional `fade` (seconds, 0–5; `fadeColor`) fades
the view out before the swap and back in once the new scene is drawn; set it
in the Inspector under the trigger's Scene transition or on a scene list
entry. Scripts read the loading state with `ctx.scenes.loading()` and
`ctx.scenes.transition()`; UI documents with `$flow.scenes.loading`,
`$flow.scenes.scenes` and `$flow.scenes.transition.phase` (`out`, `loading`);
`tl_game_observe` shows `scenes.transition`, `preloading` and `preloaded`.
Each scene load in `startTimings.sceneLoads` also says whether it was read
ahead, when it was prepared, and the draw calls before it, of the frame that
attached it and the fewest in between.

The first picture of a Play or an exported game waits for its start scenes'
models (phase 25.24f), so it shows the whole world; textures a material asks
for later, instance sets, clips and sounds arrive after. A Play that is still
loading keeps sending progress: the 15 s present timeout counts from the
last progress (a stage done, a file read, a model prepared), not from the
start, so a large project is not stopped while it loads and a hung one still
is.

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
node tools/project.mjs create ~/projects/my-game --id my-game --name "My game" [--template starter]
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

### The asset database: files and sidecars

Every imported file lives in the game folder (a project in the data root is
its own game folder), as Unity keeps files under `Assets/` and Godot under
`res://`. Next to each file is its `<file>.tlasset` sidecar: the asset's
stable id, its kind, its import settings (a KTX2 encode, audio load type and
preload, texture streaming, vertex colours, …), its labels and its address.
Everything refers to the id, so a file moved or renamed together with its
sidecar keeps every reference. Commit the files and the sidecars; there is
no count limit on either.

- **Uploads** (the Assets tab's file picker or drop, MCP
  `tl_content_upload` + `publishAsset`) are written into the folder chosen
  in the project window, or `assets/` (MCP: `publishAsset {folder}`); a name
  already taken gets `-2`, `-3`, …
- **A file already in the game folder** is imported where it is: Assets tab
  → "from project folder…" (a picker limited to the game folder; hidden
  entries, `.git` and `thirdlight/` are not offered, a symlink out of the
  folder is refused), or MCP `tl_content_query {target: "projectFiles",
  dir}` then `tl_content_upload {projectPath}` and `publishAsset` with the
  returned `sourcePath`.
- **A whole folder** comes in with **import folder…** in the Assets tab (or
  **upload a folder…**, which first copies a folder from your computer into
  the upload folder): every supported file in it and its subfolders becomes
  an asset named after its file (`assets/audio/voice/line-001.ogg` → an asset
  `line-001`; the id is the name made id-safe, `-2`, … when taken), with the
  labels you type put on every one, in one command and one undo. Files
  already imported are skipped, so importing a folder again brings only its
  new files; files no importer takes or that an importer refuses are listed,
  never fatal. MCP: `tl_command importAssets {folder, labels?, ktx2?}`; a
  folder from another machine is sent file by file with
  `tl_content_upload {dataBase64, writeTo}` first.
- **Imported data** (an FBX converted to GLB, a KTX2 encoded from a PNG or
  JPEG, audio and image headers, the project window's thumbnails, the mip
  parts of streamed textures, the file digests) is kept in
  `thirdlight/cache/imported/`, keyed by the file's digest, the importer's
  version and the settings. It is git-ignored and rebuilt when missing, so a
  fresh clone rebuilds it on first use.
- **The file is the truth.** There is no version list per asset: history is
  the game repository's, as in Unity and Godot. The editor checks the files
  when it connects, when its window gets focus back, after an import and on
  "check files" in Problems (MCP `tl_content_query {target: "integrity",
  check: true}`): a file moved with its sidecar is followed, a changed file
  is imported again with its settings, a missing one is looked for by its
  sidecar; each change is an ordinary undoable command and shows in the
  change feed. A file whose size and times did not change is not read again
  (the digests are kept in the import cache, so a restart hashes nothing
  unchanged). Play and the export run the same check first. Checks look only
  at the files that changed: the backend watches the open project's folders
  (one watch per folder on Linux, the whole tree on macOS and Windows) and,
  once a check has looked at every file, later checks visit just the assets
  whose file, sidecar or imported data changed since. Whenever the watch may
  have missed something (it failed, the kernel's event queue may have
  overflowed, a folder holding asset files was renamed or removed, after a
  restart) the next check looks at every file again. On Linux each watched
  folder uses one inotify watch (`fs.inotify.max_user_watches`; a project
  with more folders than that is checked in full every time).
  `THIRDLIGHT_FILE_WATCH=off` turns the watch off. After a full check the
  backend also builds the next Play ahead in the background, so a Play of an
  unchanged project starts without deriving anything again.
- **Reads are verified.** Play serves each file from disk at a URL named by
  its digest and hashes it while it is sent; a file changed since the check
  is refused (`asset_source_changed`), checked again and shipped by the next
  Play. The export copies each file the same way into the standalone game
  (`content/sha256/<digest>`), which needs no editor, backend or game folder.
- **Deleting** an asset (`deleteAsset`, refused while anything uses it)
  deletes its file and sidecar; undo puts both back.
- **Labels and addresses.** Any asset or resource may carry labels (`voice`,
  `level-3`: a letter or digit, then letters, digits, `_ - . /`) and one
  address (a name scripts use, unique in the project), set in the project
  window (labels on many items at once), in the asset's side panel, or with
  `setLabels {items: [{kind, id}], add?, remove?}` and `setAddress {kind, id,
  address | null}` (one command and one undo however many items). An asset or
  resource with an address or a label is **loadable**: Play and the export
  ship it even when no scene uses it, and scripts load it by name (see
  "Loading assets by name from scripts"). A script that names an asset by id
  in a string literal while the asset is not loadable is a Problems row.

### The project window

The Assets tab is a project window over the game folder's real folders, as
Unity's Project window and Godot's FileSystem dock: a folder tree (every
folder of the game folder, and folders the project's files are in) and
**All assets** (every asset file wherever it is). A folder shows its
subfolders, then every asset, resource (prefab, material, script, …) and
scene in it, as tiles or rows (the tile-size slider, the sort menu: name,
kind or file, either way) with a breadcrumb. The list is virtualized and
reads the project index in pages, so tens of thousands of items scroll
without loading them; tiles are the import cache's thumbnails (a model's
pieces load when it is chosen, not to draw its tile).

- **Search** as in Unity: `t:audio`, `t:material`, `t:scene`, Unity's type
  names (`t:AudioClip`, `t:Texture2D`, `t:Prefab`), `l:voice` (several `l:`
  must all match), the rest a part of the name, id or file; in a folder the
  search covers its subfolders. The kind menu writes the `t:` for you.
- **Choosing**: click, Ctrl/Cmd-click, Shift-click (a range, also past the
  tiles on screen), Ctrl/Cmd-A. The labels bar labels every chosen asset and
  resource at once; the side panel sets one item's address and labels.
- **Organizing**: drag items or folders onto a folder, or cut (Ctrl/Cmd-X)
  and paste (Ctrl/Cmd-V); **new folder**, rename a folder (F2). A move is one
  command and one undo (`moveResources`, `renameFolder`, `createFolder`,
  also over MCP): an asset moves with its sidecar, and ids never change, so
  no reference and no built file changes. A taken target is refused.
- **Opening**: a double-click opens a folder, or the item's editor (a
  material, animator, graph, effect, script or visual script, library, UI
  document or theme, dialogue, timeline); a scene opens in the Scene view, a
  prefab in the Prefabs panel, an environment preset in the Environment
  panel, an asset in its preview. The per-kind panels stay as views.
- The folder chosen is where uploads land and new scenes and resources are
  created (above, "Where new things go").

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

### KTX2 textures (phase 25.19)

A texture can be a KTX2 (Basis Universal ETC1S or UASTC, with its mip
levels): it stays compressed on the GPU and is transcoded on the player's
machine (three's Basis transcoder, shipped in an export only when it is
needed). Import a `.ktx2` as it is, or let the backend encode a PNG/JPEG on
import: Assets panel → **textures** → *KTX2 colour (ETC1S)* for albedo and
emissive art, *KTX2 normal map (UASTC)* for normal maps (MCP:
`tl_content_upload {kind: "texture", ktx2: "color" | "normal"}`, then publish
with the returned `convertedFrom`). Encoding takes seconds (a 2048² normal map
about 40 s on the GPU host) in a worker thread; up to 12 Mpix; WebP sources
and data maps (ORM, masks) stay images. The selected asset shows
`KTX2 · ETC1S · n mip levels` and the original it was encoded from. UI
images, portraits and input glyphs are drawn by the page and need a PNG,
JPEG or WebP. The encoder is the pinned `ktx2-encoder` package
(decision 0006). Phase 25.21 adds *KTX2 data (UASTC, linear)* for masks,
heights and packed occlusion/roughness/metalness (MCP `ktx2: "data"`).

### Texture streaming (phase 26.12)

A large KTX2 texture **streams its mips** in Play and the export, as Unity's
mipmap streaming and Unreal's texture streaming pool do: the page first reads
the file's metadata and its mip tail (every level up to 128 px, one small
request), draws with it at once, and reads larger levels one at a time as the
texture's size on screen asks for them, inside the project's **texture
budget** (Project settings → Rendering → *Texture budget*, `texture_budget_mb`,
1–65,536 MiB, default 512: Unity's default, which a mid-range laptop's shared
GPU memory holds with room to spare). When the budget is full the
least-needed levels go first: levels nothing on screen needs now, then the
textures furthest from the camera. Textures that do not stream count against
the budget but are never dropped; the tails always stay.

Streaming is an import setting of the texture (its `.tlasset`
`importSettings.streaming`; the asset inspector's **stream mips**; MCP
`setAssetOptions {assetId, streaming: true | false | null}`): on by default
for textures over 1024 px. Only a KTX2 mip chain streams: a PNG or JPEG
streams once it is imported with a KTX2 encoding (the encode makes the chain);
texture arrays load whole. The build cuts each streamed KTX2 into parts by
mip level (in the import cache, keyed by the KTX2's digest), and Play and the
export ship the parts instead of the whole file; each part is its own
digest-addressed file, verified by the page and cached by the browser like
any other. The Scene view reads textures whole. Resident texture bytes against
the budget, and each streamed texture's resident and wanted level, are in
`tl_game_observe` and Play diagnostics (`resources.textures`). Streaming is
presentation only: it never touches the simulation.

### Packed textures and texture arrays (phase 25.21)

Assets panel → **pack texture…** makes one KTX2 from PNG/JPEG texture assets
already in the project, channel by channel: each layer's R, G, B and A come
from a channel of a texture (or a constant 0 / 128 / 255; "RGBA of…" fills a
layer from one texture), all sources one size; the encoding is colour
(ETC1S, sRGB — alpha stays linear, so a height map fits there), normal map
or data (UASTC). Several layers make a **texture array**, which graph
materials sample by layer (the Sample texture, Normal map and Triplanar
nodes' **layer** input); shader-material slots, skies, cookies, lightmaps,
UI images and effects read plain textures and refuse an array. The asset
shows `KTX2 · … · n layers` and the textures it was packed from. MCP:
`tl_content_upload {pack: {layers: [[{assetId, channel} | {value}, ×4], …],
encoding}}`, then `publishAsset` with the returned `packedFrom`. The encoder
takes at most 12 Mpix across the layers (four layers of 1024²).

### Job exports from asset tools (phase 25.22)

An asset tool (an art pipeline, a generator, a hand-made delivery) can hand
over a model as a **job export**: a folder, or a zip of one, holding a GLB and
a `manifest.json` at its root (a zip may wrap it in one top folder). The
engine reads only this shape, never the tool:

```json
{
  "name": "Crate",
  "files": [
    { "path": "crate.glb",   "role": "model",   "digest": "<sha256 hex>" },
    { "path": "preview.png", "role": "preview", "digest": "sha256:<hex>" }
  ],
  "triangles": 1180,
  "lods": [1180, 560, 210]
}
```

- `name` is the asset's suggested name; `files` lists 1–64 files by path
  inside the export, a role (a lowercase word) and the SHA-256 of their bytes.
  Exactly one file has the role `model` and is a `.glb`: it becomes the
  asset. Every listed file must be there with its digest (an incomplete or
  changed export is refused, `content_invalid`); other roles are checked and
  listed, not imported. `triangles` (the model's triangle count) and `lods`
  (triangles per level, LOD0 first) are optional claims: the response puts the
  inspected count next to them and warns when they differ. Other keys are
  ignored and listed back (`ignoredKeys`).
- Route: `POST /api/v1/projects/<id>/content/job-exports/inspect` with
  `{path}` (a folder or `.zip` relative to the game folder) or `{stageId}` (a
  zip uploaded to a stage), `displayName?`. The model goes through the
  ordinary import: from a folder it is referenced in place (the response has
  `sourcePath`), from a zip it is stored like an upload. Nothing is recorded
  until `publishAsset` (the same command as any import), with `sourcePath`
  when given.
- MCP: `tl_content_upload {jobExport: {path: "exports/crate"}}` (or a `.zip`
  path), or `{jobExport: {}, dataBase64: <zip>}`; then `tl_command
  publishAsset`. There is no editor button for it yet: the Assets tab's
  "from project folder…" still imports the GLB itself.
- Limits: a manifest up to 64 KiB, files up to 128 MB in a folder, an
  uploaded zip up to the 32 MB stage limit; zips are read with stored or
  deflated entries (no zip64, no encryption).

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

The Draco and Basis decoders are three's own (`three@0.186.1`,
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
controller** or **New from clips: Character locomotion** (idle/run/jump/fall/land
states from a model's clips, driven by the character's speed, grounded,
velocityY and landed); a controller opens as the centre tab
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
  take that wire and connects the new node. A node added where another
  node already is moves to the nearest clear spot.
- **Wires:** drag from an output to an input (or the other way). Dropping a
  wire on a node's body connects it to the first port there that takes it,
  or says why none does. Ports are
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
groups, 256 comments, 16 reroute points per wire; a project has as many
graphs as it needs, each its own file under the 1 MiB content file cap (about
70 bytes per node and 80 per wire).

## Material graphs

A material can be built as a node graph (phase 18). Bottom dock →
**Materials** lists every material (a graph material's tile says *graph*):
**+ new graph material** makes one and opens it as a **Material: <name>**
centre tab — from the menu beside it, an empty graph (a **PBR output**) or a
built-in template: *standard*, *foliage wind*, *world-aligned kit*, *unlit*
or *water* (the shader types as graphs, with their defaults), or (25.21)
*height-blended layers (painted terrain)* — four layers from texture arrays,
weighted by vertex colours (a painted block layer's paint, or a mesh's own:
trim sheets blending clean → dirt → moss). Any shader
material's **Convert to graph** rebuilds it as a graph that looks the same:
its values and textures wired in, and for foliage, kit and water their wind,
UV period / macro normal and water values as public exposed parameters
(objects may override them). The pixel parity test draws every shader type
both ways on WebGL 2 and WebGPU and holds them to the renderer's parity rule.
Values a shader material leaves unset convert to what it draws with on a
box (three's standard material: roughness 1, emissive intensity 1, normal
scale 1); a material on a model also used the file's own values and
textures, which a graph does not contain. Double-click a graph material's
tile (or **Open graph**) to open its tab. The tab is the graph editor (every
gesture in "Graph editing") with the material catalogue; the Inspector on
the right edits the selected node (texture fields pick from the project's
textures, colours use a colour picker). **Remove graph** turns it back into
its shader material.

**Material instances** (phase 25.19): select a material and press **+ new
instance** — an instance draws as its parent with the values you change in its
inspector (a shader material's parameters and texture slots, a graph
material's parameters; unset rows show the parent's value, ↺ goes back to it).
It is a material like any other: pick it for an object, as a model asset's
default materials (every placement), or in a block type's `materials`; an
instance may have instances. The game ships each used instance already
resolved. MCP: `setMaterial {material: {…, instanceOf, values?}}`.

**The Material tab** (phase 18.2): on the left a live **Preview** — the
material on a *sphere*, *plane*, *cube* or a *model* of the project (pick
it below), in the project environment (sky, image-based light, fog, tone
mapping and post; a neutral backdrop when the project has none), drawn on
the editor's renderer and compiled exactly as the Scene view and the game do
(drag to orbit; the line under it names the backend and counts compile
errors) — then the **exposed parameters**; in the middle the graph. A
problem shows as a badge on its node (the graph's rules and the compiler's:
a missing texture, function or parameter, a sampling node without a
texture, a pixel-only input in a vertex offset) and in the bottom dock's
**Problems** tab ("material error"/"material warning"; a click opens the
material's tab at the node).

**Rendering (phase 18.3).** The Scene view, Play and exports compile a
graph material's graph to a three.js node material (TSL) in the browser, on
WebGPU and on WebGL 2 alike — nothing generated is stored; the export
carries the graph (and the material functions it calls) in its manifest,
without comments and groups. A PBR output becomes a standard node material
(base colour, metalness, roughness, a tangent-space normal, emissive, AO,
opacity, alpha clip), an Unlit output a basic one, a Vertex offset moves
the vertices; *Double-sided*, *Transparent* and *Casts shadows* are the
output's fields (an object whose material casts no shadow casts none,
whatever its own flag says, while it wears it). A graph material uses only
what its graph contains: the model file's own material and textures are not
used (the `shader`/`params`/`textures` part comes back with **Remove
graph**). Moving a node or editing a comment never recompiles; editing the
graph, a parameter or a called function does. An object's value for a
public parameter is drawn for that object only (one shared material, the
value read per object); a texture parameter an object overrides gets its own
compiled copy. Problems found while compiling (a missing texture, a pixel-
only input such as Screen UV used in a Vertex offset, which reads a fixed
stand-in there) show on the node. Selected objects and look overrides
(`ctx.look`) still glow (the object's own emissive is added to the graph's).

**Custom-lit surfaces** (phase 23.15): a **Custom-lit output** takes a
colour the graph computes itself (plus emissive, a tangent-space normal,
opacity and alpha clip) — cel bands, painterly, hatching — and still gets
fog, tone mapping and the post stack. Under it the *Lighting* inputs read
the scene's lights: **Main light** (the brightest shadow-casting
directional light, else the first: direction to it in world space, colour ×
intensity, N·L from −1 to 1 — step or posterize it for bands), **Shadow**
(the main light's shadow on the pixel, 0 shadowed … 1 lit), **Diffuse
light** (total — every directional, point and spot light with its N·L,
shadow and falloff, plus ambient, environment and lightmap —, its
luminance, and the direct part alone) and **Ambient light** (ambient,
hemisphere and light probes; the environment's image-based light; a baked
lightmap's light). Every light value is on the diffuse scale: a colour ×
a light value is what a matte surface of that colour shows (the PBR
output's diffuse), so a point light near a custom-lit object brightens it
exactly as it would a standard one. A lightmapped custom-lit object adds its
lightmap to the total. Used under a PBR or Unlit output (which light
themselves) the Lighting inputs read no light and show a compile error on
the node; in a vertex offset a warning; a Custom-lit normal cannot read
them. The Material tab's preview, the Scene view, Play and exports draw
custom-lit graphs with their lights.

**The catalogue** (generic, any genre): *Inputs* — Float, Vector 2/3/4,
Colour, Parameter, Time, UV (set 0/1), Vertex colour (set COLOR_0 or
COLOR_1; a mesh without it reads white, zero with alpha 1 — for vertex
colours used as data — or `first`, all weight on the first channel — for
layer weights), Position and Normal (object/world/view), View
direction, Object position (the object's or instance's origin in the
world), Camera distance, Screen UV, Instance index, Global wind (direction,
strength with gusts travelling across the world, turbulence); *Lighting*
— Main light, Shadow, Diffuse light, Ambient light (Custom-lit only, see
above); *Maths* — add, subtract, multiply, divide, min, max,
power, dot, cross, normalize, length, lerp, clamp, saturate, smoothstep,
step, abs, floor, fraction, sin, cos, one minus, remap, Weighted mix (four
values by four weights, 25.21); *Vectors* — split,
combine, swizzle (mask `xyzw`/`rgba`); *Textures* — Sample texture (wrap,
filter, colour space; a texture array's layer), Normal map, Triplanar, Height
blend (25.21: up to four layers' weights shaped by their height maps — the
higher layer shows through where they meet; depth sets how soft), Flipbook, Noise (value,
gradient, Voronoi), Gradient (linear/radial/angular), Colour ramp, Sample data (a data parameter's cell);
*Utility* — Fresnel, Rim, Posterize, Dither, World-aligned UV, Parallax,
Vertex displacement, Alpha clip; *Functions* — Function call; *Output* —
PBR output (base colour, metalness, roughness, normal, emissive, AO,
opacity, alpha clip), Unlit output or Custom-lit output (colour, emissive,
normal, opacity, alpha clip) — one of them per material —, Vertex
offset; the render flags (double-sided, transparent, casts shadows) are
fields of the surface output. Port types are float, vec2, vec3, vec4,
texture and data (a data parameter, which feeds only Sample data); every value width converts to every other (a float fills every
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
colour, texture, data), default, range, visibility (public/private, like script
properties). A **Parameter** node reads one (its type is the parameter's).
Objects override the **public** ones: select an object that uses the
material (its own material mapping or its model's default one) — the
Inspector's **Materials** section lists each graph material's public
parameters; a value set there is stored on the object (the
`materialParams` component) and ↺ goes back to the material's value.

**Material parameters from scripts** (phase 23.12): while the game runs a
script sets a graph material's public parameters **per object** —
`ctx.materials.set(entityId, 'tint', '#ff4000')` (a number, 2–4 numbers,
`"#rrggbb"`, or a texture asset id that travels with the game — referenced
by a material, an object override or a script property), `get`, and
`reset(entityId, param?)` back to the object's authored value. Other objects
wearing the material keep theirs: the material stays one shared compiled
material and the value is read per drawn object (no recompile; a texture
value takes the texture-override path, a compiled copy). The call applies
to every graph material of the object that declares the key (or to one:
the optional last argument `materialId`). A **data** parameter is a small
grid of RGBA cells (its **size**, up to 64 × 64 — the engine limit — and a
default: the bytes every cell starts with): scripts write cells or
rectangles per object with `ctx.materials.setData(entityId, 'cells', x, y,
w, h, bytes)` (w × h × 4 values 0–255, row by row; `getData` reads a cell)
and the **Sample data** node reads one cell — at a UV (cell [0, 0] at UV
(0, 0), no filtering) or at integer cell coordinates — so one mesh can show
per-cell state without an object per cell. Values are part of the
simulation (deterministic, in replays and the step digest, identical in the
simulation worker and the page), go to the renderer only when they change
(a data grid uploads once per change) and start from the authored values at
every new run. At most 4,096 writes per step; a refused call returns
`false`. The visual-script nodes are under **Materials** (Set material
parameter, Material parameter, Reset material parameter, Write material
data, Material data cell).

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

Effects are particle systems authored as node graphs (phase 20.0/20.1),
run by a WebGPU compute executor or a CPU fallback on WebGL 2 (20.2) and
previewed in their tab (20.3). They are **visual only**: nothing in an
effect changes the game simulation, so recorded replays never depend on
them.

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
- **The preview** (right column, phase 20.3) plays the effect in a looping
  view of its own — its own renderer (the editor's backend), the project
  environment (a dark backdrop when the project has none) and a grid at the
  effect's origin; drag to orbit, the view frames the effect's bounds. It
  uses the executor Play would use (WebGPU compute on the WebGPU backend
  when the graph allows it — else the CPU executor, with the reason in the
  status line — and the CPU executor on WebGL 2), and it follows every edit
  (graph, settings, parameters) at once, continuing from the time it
  showed.
  - *Timeline*: **▶/❚❚** plays or pauses, **⟲** restarts from the seed, the
    slider scrubs. Time runs in fixed 1/60 s steps, and a scrub
    re-simulates from the seed up to that time (the CPU executor re-runs the
    reference evaluator, WebGPU re-runs the compute passes), so the same
    time always shows the same particles and counters. At the **preview
    length** (default: two cycles of a looping effect, one cycle plus a
    second for a one-shot; up to 60 s) the preview starts over.
  - *Spawn counters*: per system, particles **spawned** since time 0 and
    **living** now (on WebGPU read back from the GPU a few times a second).
  - *Frame cost*: GPU time from timestamp queries where the device has
    them (the WebGPU executor's compute passes and the render passes);
    otherwise CPU time — the line says which (the CPU executor's
    simulation is always CPU time).
  - *Preview parameters*: a slider per float parameter (its min/max, else a
    range around its value), three per vector, a colour picker per colour
    — preview only, never saved (**reset** goes back to the effect's
    values; objects set theirs in the Inspector's Effect component).
  - Closing the tab (or switching to another) disposes the preview's
    renderer, buffers and materials; the page's `data-tl-effect-previews`
    attribute counts open/closed previews and closes whose renderer
    geometry/buffer counts did not return to their baseline (`leaks`, 0).

**Playing an effect:** select an object, **+ Add component → Effect** and
pick the effect. **Play on start** (on by default) starts it with the scene;
the **Parameters** rows set this object's values for the effect's public
parameters (× goes back to the effect's value). **Play on signal** restarts
it whenever that signal is sent (a switch, trigger or script) and **Stop on
signal** stops its spawning (living particles finish) — turn Play on start
off for an effect that waits for its signal.

The removed game components' effect hooks went with them in phase 24.7: a
project script plays an effect where a game event happens. Scripts play and stop effects: `ctx.effects.play(effectId, {position?,
entityId?, params?})` returns a handle (0 when refused: a bad id or more
than 32 plays in one step) — with `entityId` the effect follows that object
and `position` is an offset from it, else `position` is a world point —
and `ctx.effects.stop(handle | entityId)` ends spawning. Visual scripts have
the same nodes (**Play effect**, **Stop effect**, category *Effects*; the
entity defaults to the script's own object). All of these are presentation
events: they are recorded in step order and played by the renderer, and the
game simulation never reads them back (replays do not depend on effects).

**Where effects play.** Play (the preview) and exported games draw every
effect of the project (the export's `manifest.json` carries them in
`effects`; their textures and models travel with the game). The **Scene
view** plays the selected object's effect while **Gizmos → Play selected
effects** is on (a finished one-shot starts again; off stops it); an edit of
the effect (in its tab or over MCP) shows there at once.

**Executors and caps.** One graph, two executors:

- **WebGPU** (the renderer draws on WebGPU): the graph runs as TSL compute
  passes over storage buffers — per system an update pass and a spawn pass
  (the CPU counts births with the rate carry, bursts and distance; the GPU
  initialises them with the reference's random stream, so a particle
  starts and moves as the CPU reference would, to float precision — checked
  particle by particle in the tests); a free list of slots is the pool;
  alpha and premultiplied outputs are sorted back to front each frame on
  the GPU (bitonic sort, up to 65 536 slots per system; beyond that they
  draw unsorted). Caps: 262 144 particles per system, 1 048 576 over all
  playing effects, 64 playing effects.
- **CPU** (the WebGL 2 backend; on WebGPU also the effects that use what
  only the CPU runs: *From event* spawns, *Mesh surface* shapes,
  ribbons/trails and lights — their data is used on the CPU): the reference
  evaluator of `@thirdlight/effects` over typed arrays, drawn instanced,
  sorted back to front on the CPU. Lower caps: 4 096 particles per system,
  16 384 over all playing effects, 64 playing effects.

A system's *max particles* is capped to its executor's cap; a play past the
total or the instance cap is refused (counted in the diagnostics). Point
lights: 16 shared by all effects (a fixed pool, so the lit materials never
recompile). A frame longer than 1/30 s is split into up to four steps.
*Collide with scene (depth)* is honoured on WebGPU only (the depth of the
last frame the player drew); *Soft particles* fade against the scene depth
on WebGPU only. Output block inputs (a billboard's axis, soft distance, a
ribbon's width, a light's intensity and range) are read once per frame
(their field, or their wire in the spawn context), not per particle.
Effects outside their bounds box (around their origin) are not drawn (they
keep simulating).

**Diagnostics.** `tl_diagnostics` has `renderer.effects` — the executor
(`webgpu` | `cpu`), its caps, what plays and how many particles (GPU counts
are read back every half second), refused plays, effect ids no effect of
the game has, and per playing effect its executor (and why an effect runs
on the CPU on WebGPU); `tl_game_observe` has a compact `effects` block. The
game canvas carries `data-tl-effects` (the executor), `data-tl-effects-playing`
and `data-tl-effects-particles`.

Every graph gesture is one `graphEdit {owner: {kind: "effect", id:
"<effectId>/<systemId>"}, ops}` (one undo step); `setEffect {effect}`
creates or replaces an effect (settings, parameters, systems with their
graphs — adding or removing a system is a `setEffect`), `deleteEffect
{effectId}`, `renameEffect {effectId, name}`; the component is
`setComponent "effect" {effectId, playOnStart?, params?, signal?,
stopSignal?}` (naming no effect of the project is refused, and so is
deleting an effect something names). The effects travel in `queryGameConfig` (`effects`) and
`tl_content_query target="game"`. Limits: 16 systems and 32
parameters per effect (as many effects as the project needs), 256 nodes per system graph, up to 1 048 576 max
particles per system (capped by the executor, see above).

The CPU reference semantics of every node live in the runtime-safe package
`@thirdlight/effects` (deterministic per seed; unit-tested); the CPU
executor runs it and the WebGPU executor mirrors it (three-adapter
`effects-gpu.ts`).

## Input actions

The game reads named **actions**, not keys (bottom dock → Input): `move`
(A/D, ←/→, D-pad, left stick), `jump` (Space, pad A), `attack` (J, pad X),
`interact` (E, pad Y), and for menus `pause` (Esc, Start), `submit` (Enter,
pad A), `cancel` (Backspace, pad B), `navigate` (arrows/WASD, stick). "+ key"
listens for the next key (an axis asks for two or four keys), "+ pad" for
the next gamepad button; × removes a binding; new actions can be added. The
first edit makes the controls the project's own; "Reset to defaults" goes
back. The character controller moves and jumps with the actions it names
(`moveAction`, `jumpAction`; defaults the `move` and `jump` bindings):
their keys, and their pad buttons and stick axis (`jump`'s pad buttons,
`move`'s button pair and axis; a part with no pad binding of its kind keeps
the standard layout — A jumps, D-pad and left stick move). Players rebind
the pad on the game shell's Controls screen (see "The game shell"). Scripts read
`ctx.input.value(name)`, `.vector(name)`, `.pressed(name)`, `.held(name)`,
`.released(name)`; the actions are part of the recorded input, so replays
match. MCP: `setInput {input}` through `tl_command`; `tl_input_exercise`
frames may carry `actions: {name: {v, p}}`.

## Gameplay blocks

The GameObject menu's create entries come from the component descriptors
(phase 24.5: each component's `create` list; MCP reads them with the
descriptors). In a v4 project: **Spawn point**; **Gameplay** → a one-way
platform (2D plane), a moving platform, a door (opens on the signal
`open`), a trigger, a scene transition (a trigger that moves the character
to another scene; needs a second scene), a switch (2D plane), an object
with health, a collectible, a patrolling object and a hitbox; **Cameras**
→ a camera track and a camera region; **Light** → a fog volume. A 3D project gets the 3D forms
(colliders, hitboxes and triggers with a depth). The hierarchy and Scene
view icons come from the descriptors too. Any object can get these in the Inspector
("+ Add component", Gameplay):

- **Mover** — a path of offsets from where the object stands (waypoints, x/y/z each),
  speed, ping-pong / loop / once, a wait at each stop, smooth easing, and
  "waits for signal" (a door or a lift that starts when a switch or trigger
  fires). With a box or polygon collider it carries the player standing on
  it and pushes a player it moves into (a polygon by its exact shape). A mover rising beside or under the player
  (a gate opening, a pillar) pushes the player aside, never up: only a player
  above it rides it up. The Scene view draws its path. Phase 25.12: more
  signals — **Stop on signal** holds it where it is, **Toggle on signal** moves
  a held mover and holds a moving one (with **Moving** off it waits for the
  first toggle), **Reverse on signal** turns it around (a finished once-mover
  goes back to its start); and a **gravity** easing: from rest at each point,
  speeding up evenly until the next (each stretch takes as long as at its
  speed). A script reads a signal's hold as `get('mover').active`.
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
- A collider's **one-way** flag: jump up through it, land on it from above,
  Down + Jump drops through. A spawn inside one is not blocked (the player
  drops to what is below).
- Colliders that share a face or overlap (a floor of tiles, a wall of
  stacked blocks, a slope cut in pieces) act as one surface for the 2D
  player: it does not stand on or catch at the seams between them.

A HUD document shows counters and health through its bindings (see "The
game shell"). `tl_game_observe` reports `counters` and `health`. Scripts use
`ctx.signals.emit(name)` / `.on(name)` (seen the next step),
`ctx.game.counter(name)` / `.add(name, n)` / `.health()` /
`.setVisible(entityId, visible)` (until the next run; it still collides),
and `ctx.physics.raycast(origin, direction, maxDistance)`,
`.overlapBox(center, half)` and `.overlapCircle(center, radius)` (the
entities whose colliders overlap, never the player; 1,024 queries per step
in all, 2D and 3D).

### Generic primitives (phase 24.4)

Four components that work the same on the 2D plane and in 3D (the
Inspector's "+ Add component", Gameplay). They
carry no game rules: what a collected item, a hit or 0 health *means* is the
project's scripts' decision.

- **Collectible** — the character (the controller's object) touching its
  area (width, height and, in 3D, depth; default 1 m) adds **amount** to a
  named **counter** (any name), hides it, sends its **on collect** signal and
  comes back after **comes back after** seconds (0: never). Scripts:
  `ctx.collectible.collected(id)`, `ctx.collectible.restore(id)`.
- **Health** — on any object: **maximum** and **start**. Scripts:
  `ctx.health.get(id)` → `{current, max}`, `ctx.health.damage(id, n, source?)`,
  `ctx.health.heal(id, n)`, `ctx.health.events()` (every object's events of
  the last step). There is no grace time, knockback or death rule: a script
  decides what `died` means (for example `ctx.lifecycle.respawn()` and a
  heal).
- **Patrol** — the object walks by itself at **speed**: **Edge to edge**
  (straight ahead from its **start direction**; turns at a wall ahead or a
  ledge past its front, probing from its **body** box with the wall and ledge
  probe distances; needs the physics world) or **Waypoints** (offsets from
  its start, back and forth or a **loop**), waiting **wait** seconds at each
  turn. Scripts: `ctx.patrol.get(id)` → `{direction, active}`,
  `ctx.patrol.setActive(id, on)`, `ctx.patrol.turn(id)`. Phase 25.13: on the
  2D plane the start direction may point anywhere in the plane (a y part walks
  it up or down, turning at a wall that way; only a walk along the ground
  looks for ledges).
- **Gravity** (phase 25.13) — an object that is not a character (a patroller,
  an item, a prop without a collider) falls under the project's gravity
  (times its **scale**, capped at the project's fall speed) until its
  **body** (a box centred on it, 1 m by default) rests on a collider below;
  it falls again when the floor goes. An edge patroller with gravity walks
  off nothing it did not before but follows the ground's height. Not with a
  mover, a collider or a waypoint patrol. Saves keep its height and fall.
- **Climb volume** (phase 25.13) — a box (centred on the object, turned with
  it) the character climbs in: while its capsule's centre is inside, pushing
  up or down (the move action's up/down, or the controller's **Climb
  action**) takes hold and moves it along the box's up axis, sideways input
  moves it across, at the controller's **Climb speed** (2 m/s), with no
  gravity; a jump press lets go with a jump, and leaving the box lets go. A
  2D project whose move action is left/right only names an up/down axis as
  the controller's climb action. Scene-view size handle; GameObject →
  Gameplay → Climb volume.
- **Hitbox** — a box or sphere (a circle on the 2D plane). A hitbox touching
  another hitbox or the character sends both a `contact` event (the other
  object and the contact **normal**, a unit vector toward the other: `[0, 1,
  0]` when the other came from above) and a `separate` event when they part.
  An object never touches its own parents or children. **Damage** takes that
  much health from the other side (or its nearest parent with health) on
  each new contact. Scripts: `ctx.hitbox.setActive(id, on)`,
  `ctx.hitbox.touching(id)`.

Their events (`damaged`, `healed`, `died`, `collected`, `restored`,
`turned` with `wall`/`ledge`/`end`/`script`, `contact`, `separate`) arrive in
`ctx.events` in the step after they happened, for the objects a script owns
(its own, those below it, and those its object properties name). A save
schema's **components** section keeps health, collected collectibles,
patrollers and switched-off hitboxes. The play observation
(`tl_game_observe`) reports the named `counters` and every object's `health`.

### Scene transitions, impulses, facing, camera tracking, looks and event sounds (phase 24.4e–i)

Generic again: both dimensions.

- **Trigger → Scene transition** (Inspector, a trigger's "+ add"): entering
  the trigger loads **Load scene**, unloads **Unload scenes**, and once the
  scene is loaded moves the character to **Arrive at** (a player spawn in
  that scene or the trigger's own; it becomes the spawn `ctx.lifecycle`
  respawns at). A trigger's `enter`/`exit` events reach the scripts that own
  it (`ctx.events`).
- **Character impulse**: `ctx.character.impulse([x, y, z])` adds a velocity
  (m/s) at the character's next move (a push, a launch, a bounce; up lifts it
  off the ground; the 2D plane ignores z).
- **Facing**: Face movement **Face velocity** turns a model toward its
  motion in any direction (3D too; **Yaw offset** for a model authored facing
  another way; at the top of the hierarchy it follows its own motion). A
  player spawn's **Yaw** is the way the character faces on arrival (3D: the
  character turns; 2D: its face-movement models).
- **Switch → Action**: an interact switch reads the input action you name
  (default `interact`).
- **Virtual camera → Track (dead zone)**: keeps its placed rotation and
  follows its target at its placed offset (or **Offset**), moving only when
  the target leaves the **Dead zone** box, lagging by **Damping**, and keeping
  the framed point inside **Bounds min/max**. No fixed camera distance.
  Phase 25.14: **Look-ahead** frames that many seconds of the target's
  movement ahead of it, per axis (a vertical look-ahead `[0, t, 0]` shows the
  ground below a fall), capped by **Look-ahead max** (3 m) and eased by
  **Look-ahead smoothing** (0.2 s). With the camera selected the Scene view
  shows the dead zone around its target and the bounds box, each dragged by
  its grips (one undo step).
- **Camera region** (phase 25.14; GameObject → Cameras → Camera region): a
  box on the world axes (no depth: every depth). While a track camera's
  target is inside, the camera uses the region's **Dead zone**, **Bounds**
  (from the region's position) and **Distance** (along its offset), each
  absent one keeping the camera's own; entering or leaving blends over the
  region's **Blend time** (0.5 s). **Camera** limits it to one track camera;
  overlapping regions: the highest **Priority**, then the one entered last.
  Scene handles for its size, bounds and dead zone. `tl_game_observe`
  reports the live camera's `region`.
- **Look overrides**: `ctx.look.set(id, {emissive, emissiveIntensity, tint})`
  glows and tints an object on both renderers until `ctx.look.clear(id)` or a
  new run (`ctx.look.get(id)` reads it; saved in the `components` section).
- **Event sounds** (Media tab): rows that play a sound when a **signal** is
  sent (by name) or an **event** happens (`enter`, `exit`, `collected`,
  `damaged`, `died`, `contact`, … or an animator clip event's name;
  optionally only one object's), at a volume on a bus. The export carries
  their sounds. MCP: `setEventCues {cues}`.

### The game shell: menus and HUD as UI documents (phase 24.4j)

The **Game shell** tab (MCP: `setShell {shell}`) draws
the menus and HUD with the project's own UI documents (make them in the UI
tab):

- **Screens**: **Title** (shown before play; the game waits behind it),
  **Pause** (Escape / pad Start; absent: the engine's Resume / Restart panel),
  **Settings**, **Controls** (rebinding), **Save** and **Load**. Their buttons
  use engine actions: `newGame`, `continue` (the newest save), `resume`,
  `back`, `open` (a screen), `save` / `load` (slot 1–3, the project saves of
  the Saves tab), `setSetting`, `rebind`, `nextScene`, `quitToTitle`.
- **HUD**: documents shown while the game plays. Bindings read
  `$flow.counters.<name>` (named counters: collectibles, scripts),
  `$flow.health.<objectId>.current|max`, `$flow.prompts` (made from the
  project's input actions, e.g. "A/D move x · E interact"), `$flow.shell`
  (screen, scene, `canContinue`, `saves.<n>.label`, `note`) and script values
  (`ctx.ui.set`).
- **Scene list**: the game's scenes in order, each with the spawn it starts
  at. New game begins a fresh run at the first; **Next scene** loads the next
  and moves the character to its spawn.
- **Pause allowed**, and a debug **Status line** (screen, scene, prompts).

A save from the shell includes the named counters in the `components`
section and, since save format version 2, which scenes are loaded and where
the character stands. `tl_game_observe` reports `shell {screen, scene, hud,
note}`.

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
collectible, health, patrol, hitbox, audio source, face movement), so a copy
collides, is collected, patrols or flies like the original. The player
controller and level wiring (camera, lights, spawn markers) never go into a
prefab.

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
- Engine limits: 64 spawns per step and 16,384 spawned objects alive (one
  scene's entity capacity); past
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
  player controller). A mover or a patrol component moves objects too.

`tl_game_observe` reports `spawned: { count, ids }` (the first 64 ids). Play
and the export carry the project's prefabs with the game.

### Loading assets by name from scripts

A scene's objects load what they use with the scene. A script that needs
assets no loaded scene uses (a level's props before it opens, a boss's
models, a set of voice lines) loads them by name and lets them go when it is
done, as Unity's Addressables do. Give the assets (or prefabs, materials) an
address or a label first (Assets tab or Inspector; `setLabels`,
`setAddress`): only what has one ships for scripts.

- `ctx.assets.load(key)` takes an address, an asset or resource id, or a
  label (every asset and resource with that label), in that order, and
  returns a handle (a number; 0 when the key is not a name at all). The game
  never waits: the handle is `loading` until the assets are read, parsed and
  decoded, a later step.
- `ctx.assets.state(handle)` is `loading`, `ready` or `failed` (null once
  released); `ready(handle)`, `ids(handle)` (what the key named) and
  `error(handle)` (why it failed, e.g. nothing is named that).
- `ctx.assets.release(handle)` lets the assets go; they leave memory once
  nothing else (a scene, a spawned object, a playing sound) uses them.
  Release every handle you load. A prefab loaded by handle spawns at once
  with its models and textures already in memory.
- The answer arrives as the game's input at the step it came, so a recording
  of the input replays it the same however long the loads take then, and the
  simulation worker sees it at the same step.
- A handle still open when a run ends (a restart, the shell's new game) is
  released then and reported: the script log says which, and
  `tl_game_observe` / Play diagnostics list it under `resources.notReleased`.
  `resources.open` lists the handles open now; one still open when Play
  stops is named in the page console.

Visual scripts have Load assets, Release assets, Assets state, Assets ready
and Assets error nodes.

### Script libraries and JSON data (phase 23.7)

- **Libraries** are shared TypeScript (and JSON) every script of the
  project can use: the **Libraries** tab (bottom dock) creates one from a
  name (its id is the name in lower case, e.g. "Scoring" → `scoring`),
  renames, deletes and opens it. Its tab is the code editor: `src/index.ts`
  is what scripts import — `import { points } from '@lib/scoring';` — and
  **+ File** adds more modules or `.json` data (`import table from
  './table.json'`). The draft compiles after a short pause (or Ctrl+S);
  problems are marked in the code. **Save** stores the changed files (one
  undo step) and recompiles every published script that imports the
  library in the same step; the first save that changes a library such
  scripts use asks for the trust acknowledgment of the new version (like
  publishing a script). If a script no longer compiles against the change,
  the save is refused and the message names the script. A library a
  published script imports cannot be deleted.
- A library may import other libraries (`@lib/<id>`); a cycle between
  libraries or an import of a library that does not exist is a compile
  error. Bounds: 16 files and 256 KiB per library, 64 KiB per
  file, as many libraries as the project needs (a save of more than ~64 KiB of changed text goes in several
  patches, below).
- Scripts may also keep `.json` files in their own source and import them
  the same way.
- MCP: `tl_command` `setScriptLibrary {libraryId, name?, files?: [{path,
  text|null}]}` (text null removes a file; other files are kept) and
  `deleteScriptLibrary {libraryId}`; the libraries are in
  `tl_content_query target="game"` (`scriptLibraries`).
- **Shared modules (phase 25.9).** Each library is compiled once into its
  own minified, tree-shaken module (`libraries/<digest>.js`; code no export
  reaches is dropped) that scripts import instead of carrying a copy. Play
  (worker and page) and exports load each library once, so a library's
  top-level variables are shared by every script that imports it (keep
  per-object state in the script's state, not in library variables). An
  import of a name the library does not export is a compile error, as
  before. Exports ship the modules next to the scripts; scripts published
  before 25.9 need no republish.
- **Several libraries or large edits at once (phase 25.9).** The Libraries
  tab lists the libraries with unsaved edits; **Save all** commits them in
  one step (one undo), recompiling each script that imports any of them
  once. A library save larger than one request (the 64 KiB command cap) is
  sent in several patches and committed once the same way. MCP:
  `tl_command` op `stageScriptLibrary {stageId?, libraryId, name?, files?}`
  (a file may come in pieces: `{path, text, append: true}`; no revision)
  answers a `stageId`; `commitScriptLibraryStage {stageId}` commits the
  stage (its answer's `libraryStage` names the scripts compiled);
  `{stageId, discard: true}` drops one. Stages live until the backend
  restarts (at most 8 per project).

### The Console: script logs and errors at their source lines (phase 25.9)

- The **Console** tab (bottom dock) lists the running Play's `ctx.log`
  lines and script errors with the file, line and column in the project's
  own sources — the script's or the library's (`@lib/tally ·
  src/index.ts:15:9`), and for an error the script frames it came through.
  A location opens the Script or Library tab with the cursor on that line.
  It refreshes about once a second while shown and keeps the last Play's
  entries after it stops.
- `tl_diagnostics` carries the same: each entry of `runtime.errors` with a
  compiled position (`at`, `frames`) also has `source` (and `sources`)
  `{behaviorId | libraryId, path, line, column}`. Exports carry no source
  maps or sources; an exported game's errors keep their compiled positions.

### Reading and writing any component: `ctx.entity` (phase 25.10)

- `ctx.entity(id)` is one loaded object (an object property's value, a
  spawned copy's id, `ctx.entityId`; null for no id or an object that is not
  loaded). `.get(component)` is a read-only snapshot of the component's
  fields as they stood at the start of the step (`'object'`: the object's
  own id, name, parentId, active, visible, static and tags); null when the
  object has no such component. Which fields scripts read is marked in the
  component descriptors (`queryGameConfig`: `scriptReadable`) and belongs to
  the project schema.
- `.set(component, patch)` writes fields while the game runs; the writes of
  a step are applied at its end, in script order, identically in the page,
  the simulation worker and a replay. Writable now (`runtimeWritable`):
  - `object`: `active` — off, the object and its children are not drawn,
    collide with nothing, fire no trigger or switch and do not tick (scripts,
    movers, patrols, hitboxes, collectibles, animators, audio sources); on
    again, everything comes back where the object is. `visible` — drawn or
    not (the state `ctx.game.setVisible` uses). Not for the camera, the
    character or objects above them, nor static objects. An object switched
    off in the editor is still not in the game.
  - `transform`: `position`, `rotation`, `scale` of any object that is not a
    physics body, the camera, static, or moved every step by its mover,
    patrol, socket or facing — no `ownedTransforms` needed.
  - `light`: `color`, `intensity`, `range` (point and spot); presets blend
    from the written values.
  - `mover`: `speed` and `active` (the Inspector's new **Moving** switch: a
    mover that is off holds where it is, still solid).
  - `materialParams`: `{ materialId: { parameter: value } }` for the graph
    materials the object wears (`null`: back to the authored value).
  Any other field is refused: the answer `{ok, field, code, message}` names
  it, nothing of the patch is written, and the refusal shows in the Console
  and `tl_diagnostics` (`entity_write`). A field two scripts write in one
  step takes the later write; the conflict is reported there too. A new run
  puts every written field back; a save's `components` section keeps them.
- Object properties of a script (type object, `entityRef`) are pickers of
  the scene's objects in the Inspector. In a spawned prefab copy they name
  the copy's own objects.
- `ctx.emit({ kind: 'character_place', position: [x, y, z] })` also works on
  the 2D plane (z ignored): the character is placed from rest in that step.
- `ctx.shell.nextScene()` moves to the next entry of the shell's scene list
  (the same move as the shell's Next scene action); `sceneIndex()` and
  `sceneCount()` read the list.
- Visual scripts have the same as nodes: **Get component**, **Set
  component** (category Entity) and **Next scene** (Shell).

### Callbacks on a script (phase 25.11)

- Besides `step(state, ctx)` (now optional), a script's `export default` may
  have callbacks: `onEnable(state, ctx)` (the object is in the game and on:
  its first step, a scene load, a spawned copy, and each time it is switched
  on again), `onDisable` (switched off, itself or an object above it, or
  leaving), `onDestroy` (it left the game: destroyed or its scene unloaded;
  the object is already gone; not on a restart), and with the event as the
  second argument `onTriggerEnter`/`onTriggerExit` (triggers the script owns),
  `onContact` (its hitboxes: `type` contact or separate), `onMessage`
  (messages to every script or to this object), `onUiEvent` (the step's UI
  events) and `onAnimatorEvent` (clip events of animators it owns).
- They run inside the step's intent phase, before the script's `step`, in a
  fixed order: leaving objects' onDisable/onDestroy first, then per script
  onEnable/onDisable, triggers, contacts, messages, UI events, animator
  events. `ctx.events`, `ctx.messages.received` and `ctx.ui.events()` still
  list the same events. Page, worker and replays run them alike.
- The script editor completes the callbacks inside `export default { … }`
  and the fields of their event parameter. Visual scripts have **On enable**,
  **On disable**, **On destroy**, **On contact** and **On UI event**
  (category Events).

### Random numbers, finding objects and facing (phase 23.7)

- `ctx.random` gives each object's script its own seeded random numbers:
  `next()` (0 up to 1), `range(min, max)`, `int(min, max)` (both ends
  included), `chance(p)` and `pick(list)` (`undefined` for an empty list).
  `ctx.random.stream(name)` is an independent stream of that object (same
  API, without `stream`; names like timer names, at most 64 per object):
  draws from one never shift another, so adding a loot roll does not change
  how an enemy moves. The numbers come from the project setting **Random
  seed** (Project settings → Engine, `random_seed`, 0–4294967295, default 0)
  mixed with the script, the object and the stream name, so every run,
  replay, Play in the worker or on the main thread, and the export draw the
  same numbers; change the seed to reshuffle every choice of the game at
  once. A new run (start, replay) starts every stream over. Never use
  `Math.random` in a script — a replay could not repeat it. Visual scripts
  have the same numbers as the **Seeded random / range / integer / chance**
  nodes (with a "(stream)" variant taking a stream name); the older Random
  nodes keep their per-object numbers unchanged.
- `ctx.world.find(name)` is the id of the first loaded object with exactly
  that name (or `undefined`), `ctx.world.findAll(name)` all of them and
  `ctx.world.withComponent(kind)` every object carrying a component of that
  kind (`"light"`, `"collider"`, `"behavior"`, …) — in load order (the start
  scene as authored, then loaded scenes and spawned copies as they came).
  Nodes: Find object by name, Find objects by name, Find objects with
  component.
- Transform and pose intents take a rotation as a quaternion or a direction
  besides angles: `{ kind: "pose", entityId, quaternion: [x, y, z, w] }`
  (normalized for you), or `facing: [x, y, z]` — the object's forward (+Z,
  the glTF forward) points that way, its top towards `up` (default
  `[0, 1, 0]`; straight up or down leans the top away from / towards +Z).
  A `transform` intent may carry the same `quaternion` or `facing`/`up`
  after its `position` to move and turn in one intent. One rotation form per
  intent (angles, quaternion or facing); an all-zero vector or an `up`
  parallel to `facing` stops the game with the script error. These fields
  are for code scripts; the Pose object and Move object nodes are unchanged.

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

## Music, fonts and audio

The level flow (levels, lives, the built-in title/pause/end menus, per-level
music, ambience and looks) was deleted in phase 24.7: a game's menus and HUD
are the **game shell**'s UI documents (see "The game shell"), its scene
order the shell's scene list, and anything like lives or a level timer is
the game's own scripts over named counters. A project that still has a
`content.flow` is refused on open, naming it (see "What you can do now").

**Audio** is one kind of asset, whatever its length or use (Unity's
`AudioClip`, Godot's `AudioStream`): Ogg Vorbis, Ogg Opus, MP3, WAV (integer
PCM of 8–32 bits or 32/64-bit float, plain or extensible) and FLAC, at any
channel count and sample rate, of any length; only the file size is bounded
(32 MiB, as every imported file). Sound effects, music, voice and UI are
mixer buses, not kinds: a footstep, a voice line and an hour of ambience are
all `audio`, and any of them can be a dialogue voice or blip, an audio
source, an event sound, a timeline key, `ctx.audio.play` or
`ctx.audio.music`. The import reads the headers only (no transcoding). A WAV
of ADPCM, µ-law or A-law is refused (MDN lists no browser that plays them);
Ogg Vorbis and Ogg Opus are imported, and the Problems list notes that
Safari before 18.4 (macOS 15.4, iOS 18.4) does not play them, as it does for
more than 32 channels or a rate outside 8–96 kHz.

Each audio asset has two import settings, in its `.tlasset` sidecar and in
the Assets tab's side panel (`setAssetOptions {assetId, loadType, preload}`,
one undo): the **load type** — *decode on load* (decoded into memory when it
loads, no wait when played), *decode while playing* (kept compressed,
decoded when played) or *stream* — defaulting by length: under 5 s decode on
load, over 60 s stream, anything between decode while playing; and
**preload** — read with the scene that uses it (the default) or only when
played (a long dialogue's voice lines). The runtime catalog's entry for the
file carries both.
Nothing audio is read when a game starts. A preloaded file is read with the
scene that names it (an audio source, say) and kept until that scene
unloads; files the project-wide parts name (event sounds, timelines, the
shell) are read after the start and kept for the play. A file that is not
preloaded is read when first played and then kept while the scenes loaded at
that moment stay loaded. *Decode on load* keeps the decoded sound, *decode
while playing* keeps the compressed file and decodes it for each play,
*stream* plays through a media element that reads the file as it plays
(nothing is kept). A running conversation reads the voices of the lines
ahead on every branch, three lines deep, and decodes those of the next
lines, so a voice starts with its line. A sound played before its file is
ready starts when it is, unless it would start later than its bound, then it
is dropped: `maxLateMs` on `ctx.audio.play` / `stinger` (default 500 ms, 0:
now or never, at most 60 s), on an event sound row, on a timeline stinger or
sfx key, and the dialogue setting `voiceMaxLateMs` (default 1000 ms) for
voices; loops and music wait as long as it takes. `tl_game_observe` `audio.
late` counts the sounds that started late and those dropped, with the newest
of each (asset, how late, the bound, and whether it waited for its file or
for the first click), and `resources.resident` reports `audio` (decoded),
`audio-bytes` (kept compressed) and `audio-stream` (streams playing). A
project with `music`
records (or short-sound records of the old fixed 2 s mono WAV profile) is
upgraded on open: each becomes `audio` with its id and file kept, and the
upgrade is listed in Problems. Sound starts with the first key press or
click (the browser's sound rule). `tl_game_observe` reports `loops` (each
audio source's current gain).

**Font** assets are TrueType (.ttf), OpenType (.otf), WOFF2 or WOFF files up
to 4 MiB, as many as the project needs. Choose or drop the file in
the Asset browser like other assets, or upload it with `tl_content_upload`
kind `font` and publish it with kind `font`. The import checks the file's
container only (the family name of a TTF/OTF is shown when it has one); the
game's UI loads the font in the browser. A font ships with Play and the export
when the project's UI uses it.

Inspector → "+ Add component" → **Audio source** loops an audio asset where
the object is: full volume within a quarter of its range, fading to silent
at the range (measured along X from the player); the Scene view draws both
distances. Scripts play a sound with `ctx.audio.play(assetId, { volume })`
(an audio asset; it is presentation only and never changes the game).
`tl_game_control` *replay* restarts the run.

**Script audio and 3D audio (phase 23.13).** `ctx.audio.play(assetId,
{volume, loop, pitch, bus, fadeIn, entityId, position, distanceModel,
refDistance, maxDistance, rolloff})` returns a handle: `stop(h, fade)`,
`fade(h, to, seconds)`, `setVolume`, `setPitch` (the playback rate, 0.25–4),
`setLoop`, `playing(h)`, `volumeOf(h)`, and `finished(h)` / `events()` in the
step after a sound ended or its stop fade finished (computed in the
simulation from the asset's recorded length, so replays and the worker agree).
Buses: sfx, music, voice, ui (`setBusVolume(bus, v, seconds)` mixes on top of
the player's volume). Music: `music(id | null, fade)` crossfades and holds
the music over any other track until `releaseMusic(fade)`;
`stinger(id, {duck, fade})` plays once over the music, ducked to 0.3 under it;
`duck(level, seconds)` / `unduck` — the deepest duck alive wins. A sound with
`entityId` or `position` is panned (equal-power) around the listener, the
active camera, and fades by its distance model (defaults linear, 2–30 m).
The project setting **Audio sources** (`audio_spatial`: 0 automatic, 1 by X
distance to the player, 2 panned) decides how audio sources are heard;
automatic keeps 2D projects exactly as before and pans in 3D, where an
audio source's range is its max distance and **Distance model**, **Full
volume within** and **Rolloff** are Inspector fields. Scenes without a game
block (3D projects) now play script sounds and audio sources too. A script
names its sounds through asset properties (the export carries only the
assets objects and script properties reference). `tl_game_observe` and the
export's `window.__thirdlightObserve()` report `audio`: live voices with
gain, playback rate, pan and distance gain (the Web Audio graph's state, not
heard sound), music owner and duck, bus gains and the listener. How it
sounds is owner look pending.

## Saves

Saves are the project's own (below): the game shell's Save and Load screens
and scripts write and read project save slots in the player's browser. The
level flow's autosave, its three slots and its checkpoint saves went with
the flow in phase 24.7. Play keeps its saves apart from exported games (and
each project apart from the others); **Saves → Clear Play save** forgets
Play's (MCP: `tl_game_control` `clearSave`).

**Save format version 2** (phase 24.8): every save also carries where the
play stands (`world`): the loaded scenes, the active spawn, the scene-list
entry and the character's position and velocity. Loading unloads the scenes
the save did not have, loads the ones it had, and puts the character back
where it stood (from rest, its velocity given back at its next move). A
version 1 save (no `world`) still loads and leaves the play where it is; a
version 2 save without `world`, or naming a scene the game does not have, is
refused.

### Project save documents (phase 23.19)

Any game can declare its own save format in
the **Saves** tab (MCP: `setSaveSchema {schema | null}`):

- **Version** of the save document, and **migrations**: for each older
  version the name of a script function that upgrades a document by one
  version. A script registers it with
  `ctx.saves.migration('v1to2', (doc, fromVersion) => newDoc)`; a save of
  version 1 loaded by a version-3 game runs `v1to2` then `v2to3`. A save
  newer than the game, or one whose migration no script registered, is not
  loaded (nothing changes; the outcome says why).
- **Slots**: 1–99 (engine limit 99).
- **Included state** (opt-in): *block cells* (the cells scripts changed,
  `ctx.grid`), *material values* (`ctx.materials`), *spawned objects*
  (prefab copies with their placement and ids; their scripts start fresh),
  *script storage* (`ctx.save`), *environment* (the preset blend,
  `ctx.environment`; phase 23.18). A section the schema includes but a save
  lacks is reset to the run's start on load.
- **Slot picture**: size and format (default 256 × 144 JPEG; at most
  512 px a side and 64 KiB).
- **Settings document**: fields (bool, number, string, choice) with
  defaults, which the game's own settings screen writes with
  `ctx.saves.setSetting(key, value)` and reads with `ctx.saves.setting(key)`.
  A field may drive an engine setting — music, sound or menu volume (a 0–1
  number) or quality (a choice of low/medium/high) — which applies at once.
  It is kept in the player's browser (localStorage, per project) and the
  game starts with it.

Scripts build the document themselves: `ctx.saves.write(doc)` / `read()`
(any JSON, at most **1 MiB per slot** with its sections), `save(slot, {title,
chapter, location, thumbnail})`, `load(slot)`, `delete(slot)`, `slots()` (title,
chapter, location, play time, when, version, size, picture), `ready()`,
`results()` (the outcomes, one step after storage answers), `playSeconds()`.
A save is taken at the end of the step it was asked for; a loaded save is
restored at the end of the step storage's answer arrives, so every host (the
page, the simulation worker, a replay) restores it at the same step —
storage's answers are part of the recorded input.

Slots live in the browser's IndexedDB (localStorage's ~5 MB per site could
not hold 99 slots of 1 MiB); Play and exported games, and each project, keep
separate ones, and an export needs no backend. `tl_game_observe` (and an
export's `__thirdlightObserve()`) report `saves {slotCount, storage, slots
(the first 32 used, with their picture's type and size), settings}`; the page
exposes a slot's picture as `__thirdlightSaveThumbnail(slot)` (a data URL).
`tl_play_start` also takes a project save document (`{format:
"thirdlight.save", version, playSeconds?, doc, sections?}`, loaded at the
first step and migrated) or `saveSlot` 1–99 (a project slot of the Play page).

## Test and debug entry points (phase 23.8)

**Play from…** (the toolbar button next to *play*) starts Play somewhere
other than the game's start:

- **Scene** — loads the scene together with its start scenes (they hold the
  camera and the player), skipping the title, and the player starts at the
  scene's first player spawn (else the game's own).
- **Variables** — a JSON object the scripts read with `ctx.save.get(key)`
  from the very first step (the save's rules: at most 64 keys of 4 KB JSON
  each). With a save they are added on top of the save's values.
- **Save slot** — continue a game with levels from Play's autosave or slot
  1–3 (the title's Continue / Load game path).

MCP's `tl_play_start` takes the same options — `sceneId`, `variables`,
`save` (a save document as the game writes them, at most 64 KB) or `saveSlot`
(`auto`, `1`–`3`), and `mode` (a game-mode id: checked once the project
defines game modes, and until then ignored and named in the result's
`start.notes`). The backend checks them against the project (an unknown
scene, a scene no level loads, or a save in a game without levels is
refused) and the result echoes the resolved start; `tl_game_observe`
reports what the game did with it as `start {ok, applied | reason}`. It
works with the headless editor too (no browser open).

**Debug commands** are declared by the project's scripts:

```ts
ctx.debug?.command('giveItem', {
  description: 'Give the party an item',
  args: [{ name: 'item', type: 'string' }, { name: 'count', type: 'number', optional: true }],
}, (args) => { /* runs once per call, in this step */ });
```

The call also returns this step's calls (a list of argument objects) for a
script that prefers to loop over them. Every script instance that declares
the command receives each call, in the `intent` phase. The first declaration
fixes the arguments (a second one with other arguments stops the game with
the script error); at most 32 commands per game. A command runs **inside the
simulation step as part of that step's input** (the input frame carries it),
so it is deterministic and a recording that carries it replays it exactly;
`tl_game_observe` lists `debugCommands {registered, applied [{stepIndex,
name, args}] (the last 16)}` — the steps a playtest needs to reproduce a run.
Run one from:

- MCP: `tl_game_control` with `command: "debugCommand"`, `name` and `args`
  (refused with `game_command_invalid` when no script declared it or the
  arguments do not match);
- **Signals from tools:** the engine declares `signal {name}` in every game.
  `tl_game_control {signal: "door"}` (or the console's `signal door`, or
  `debugCommand` with `name: "signal"`) emits the signal in the next step as a
  script's `ctx.signals.emit` would: switches, movers, timelines
  (`playOnSignal`), effects, event sounds and scripts react, so they are
  testable without a script. Signals carry no value (a `value` is refused).
  It is input like any debug command, so a recording replays it;
- the **in-game console**: press **`** (backquote) in Play — it lists the
  commands (`help`), takes `giveItem lantern 2` (the declared order) or
  `giveItem count=2 item="iron key"`, and prints each call the game ran with
  its step. Play always has it. An exported game has it only when **Project
  settings → Engine → Debug console in export** (`debug_console`) is on —
  off by default, so a release build never ships a console by accident.

## Grading and fog volumes

In the Environment window, post-processing grading has **lift**
(raises the blacks, −0.5–0.5), **gamma** (mid-tones, 0.2–5; above 1
brightens) and **gain** (scales the whites, 0–4); the defaults (0, 1, 1)
leave the image unchanged. A **fog volume** (Inspector) has *thins with
height*: its density fades by e^(−k·height) above the box bottom (k per
metre, 0–10; 0 = even fog, as before).

## Environment presets (runtime environment changes, phase 23.18)

An **environment preset** is a named look a game switches or blends to at
run time — the same village by day and by night, a storm rolling in. A
preset is project content (`environment.presets`, at most 64) with any of:

- `sky` and `fog` — a whole sky / fog (the Environment window's shapes);
- `post` — post-processing merged per effect over the base (exposure, tone
  mapping, grading incl. lift/gamma/gain/tint, bloom, vignette, …);
- `lights` (at most 32 entries) — colour, intensity, direction (directional
  and spot) and ground colour (hemisphere) for the scene lights an entry
  names: by `entity` id, by `tag` name or by light `type` (e.g. every
  `ambient` or `hemisphere` light), every light when it names none; later
  entries win per field;
- `lightmap: { intensity?, tint? }` — a multiplier on baked lightmaps.

A part a preset does not set is the **base look**'s: the project environment
with the playing level's look over it, and the lights as authored.

**Editor.** The Environment window's *Presets* section: type a name and
**capture current as preset** — the environment's sky, fog and post and
every scene light's colour, intensity and direction are stored (one
`setEnvironment`, undo/redo like any edit). **preview** shows a preset in the
Scene view (with game lighting); *blend from* / *blend to* and the **blend
preview** slider show a mix; **stop preview** goes back. Previewing stores
nothing. **delete** removes a preset. MCP: `setEnvironment` with
`environment.presets`.

**Scripts.** `ctx.environment`:

- `set(presetId, { blend?, easing?, override? })` — switch to a preset (`''`
  = the base look) over `blend` seconds (0–600; absent: at once), easing
  `linear` (default: a time-of-day fade progresses evenly), `easeIn`,
  `easeOut` or `easeInOut`; an interrupted blend continues from the look on
  screen. `override` changes fields of the preset for this change only
  (`{ fog: { color: '#ff0000' } }`: sky, fog, post and lightmap merge over
  the preset's, lights add entries). False (and a warning in the play log)
  for an unknown preset or a bad option.
- `blend(a, b, t)` — hold a mix of two presets (t 0–1), for a timeline or a
  script that drives t itself.
- `state()` → `{ target, progress, blending }`, `weight(presetId)`,
  `presets()`.

Visual scripts have the same as *Set environment*, *Blend environments*,
*Environment state*, *Environment weight* and *Environment presets*
(category Environment). The blend is simulation state: it replays, runs the
same in the simulation worker and in exports, and is in the step digest once
a script used it (games that never do are unchanged). A project save
document includes it when the save schema lists the `environment` section.
`tl_game_observe` (and an export's `window.__thirdlightObserve()`) reports
`environment: { target, progress, weights }` once a script changed it.

**How it draws.** Numbers blend linearly, colours in linear light, light
directions are normalized, the sun's azimuth goes the short way round. The
renderer changes them in place every frame — sky colours and parameters,
fog colour and distances, exposure, grading, vignette and bloom are
uniforms, so a blend compiles no new shaders (a change of tone-mapping mode
or fog kind does). Two presets with **different skies** (another mode, or
another sky image) **cross-fade**: each sky is drawn as a dome over the
background with its share as opacity; the image-based lighting is the
heavier sky's. A sky that only changes its numbers re-bakes its image-based
lighting at most every 30th frame, and only once it has moved past a
threshold from the last bake (phase 25.3: a colour channel by more than
0.01, a procedural sky number by more than 1 %, the sun by more than 0.5°);
the bake reuses its target, so the scene's environment texture never
changes during a blend. A blend that only changes fog, exposure, grading or
lights never re-bakes. A script may give `blend(a, b, t)` a new t every step:
measured on the GPU host (Iris Xe), no step is dropped once loaded
(`environment-blend-cost.e2e.ts`). Fog of different kinds converts (linear
↔ exp2 by density = 2 / far); a look without fog thins it. Tone mapping,
anti-aliasing, AO, depth of field and the LUT image cannot blend: the
heavier look's is used.

**Baked lighting.** A lightmap holds the light of the moment it was baked:
changing a baked light's colour in a preset does not change the baked
surfaces (a light a bake holds is not realtime at all). Give such presets a
`lightmap` multiplier — e.g. `{ intensity: 0.2, tint: '#8090ff' }` for night
— and the baked surfaces darken and tint with the blend.

## Icons and gizmos

The Scene view and the hierarchy show what an object is: its light type
(directional, ambient, point, spot, hemisphere), a camera, or the icon its
components' descriptors name (phase 24.5: a spawn, an audio source, a fog
volume, a patrol, a mover, a switch, a collectible, a trigger, a hitbox or
health; the most specific wins). The **Gizmos** menu turns the helpers on and off: icons,
light ranges (point spheres, spot cones), **collider outlines** (every box
and polygon collider on the game plane — a kit piece's `_COL` shape too;
one-way platforms in a softer green), and gameplay paths and areas (a patrol's waypoints, hitboxes, collect areas). A
selected camera shows its real frustum (its field of view, near and far, at
the game view's aspect — the Game preview while it plays, else the window).
Handles for sizes, ranges, directions and paths: see **Scene handles**.

Inspector → "+ Add component" → **Face movement** on a model under the player or a
patroller turns it to face where its parent goes (a yaw for moving right and for
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
a spawn on the ground puts the feet on the ground), collectibles, hitboxes,
triggers, switches and moving platforms' push-out. MCP: `setComponent` `controller`
`{capsule: {radius, height, offset?} | null}`; `tl_inspect` shows it.

## Scene handles

While an object is selected, the Scene view shows white grips for every
field of its components that has a size, range, direction or path (the
component descriptors say which; the same list the Inspector is built
from). Drag a grip: the object's outline follows while you drag, and the
release stores it in one command — one undo step, the Inspector updates.
Esc cancels a drag. Snapping (the toolbar's snap toggle; hold Shift for one
drag to turn it off): sizes, radii, ranges and polygon corners land on 5 cm,
path points on the 0.25 m grid, a spot cone's
half-angle on 5°, directions on 0.05 per axis. Values stay inside the
field's range.

- **Box sizes** (`box2`/`box3`): top and side grips (and a depth grip for a
  box mesh and a fog volume); areas stay centred. A box collider's half extents turn with the object;
  a box mesh's size is in the object's own (scaled) space.
- **Capsule** (the player): see above.
- **Radius**: a circle trigger, a point light's range; along X only for an
  audio source's range (the engine compares horizontal distance).
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

v4 projects have no level bounds or kill height (games state those rules in
scripts), so there is nothing of that kind to draw.

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
- **Patrol** — for edge walkers the wall probe (0.05 m ahead) and ledge
  probe (0.4 m down from 0.1 m above its underside).
- **Mover** — max push 60 m/s: how hard it shoves a player out of its way
  (0.5 m per step at 120 Hz; a safety limit). The gap it keeps is the
  player's skin plus 1 mm.
- **Collectible without a size** — a 1 m area centred on the object.
- **Engine timing** — drop-through time 0.125 s (down + jump on a one-way
  platform), settle time 0.1 s (the world settles before the first frame).
- **Project settings (engine)** — fixed step 60 / 120 / 240 Hz (default
  120; times in seconds keep their length, a replay is recorded at one
  rate), sound voices 8 (at most 32), music fade 1 s, animation blend 0.2 s
  (the idle/run/airborne model animation; animator transitions have their
  own durations). These are stored only when set.

### Engine limits (constants)

These protect the runtime and are not tuning values. A project has **no count
limit on its assets or resources** (models, textures, audio, fonts,
prefabs, scripts, scenes, materials, animators, timelines, UI documents and
themes, dialogues and speakers, effects, graphs, script libraries,
environment presets, event sounds, block types and stamps): each is its own
file, and only one file's size and the runtime's memory are bounded
(`tests/count-caps.test.ts` and `tests/e2e/count-caps.e2e.ts` guard it). Each
limit below is a per-file size, a per-object size or a runtime budget, with
its reason (the same line is next to its constant in the code):

| Limit | Value | Why |
|---|---|---|
| Content file | 1 MiB of canonical JSON per file: each resource record (material, dialogue, UI document, …, environment preset, prefab) and `content.json`'s project-wide settings | What one parse and one change carry; the number of files is not bounded |
| Asset file | 32 MiB per imported file (128 MiB for an FBX to convert); fonts 4 MiB, images 16 MiB; audio of any length within the 32 MiB | One read and one inspection in the backend's memory |
| Disk | An import or upload is refused only when the disk the game folder is on would keep less than 64 MiB free; the message gives the free space | No project quota |
| Runtime content manifest | `manifest.json` of a Play build or an export (version 5): the build's identity, settings, start scenes and the catalog's location, about 2 KB at any project size. The catalog's files (`content/sha256/<digest>`: its root, each block — prefabs, materials, UI documents, dialogue, behaviors, … — in parts of about 1 MiB, the entry shards, each scene's dependency file) are 32 MiB each, the content file cap | One file of the build |
| Play build in memory | 32 MiB per file the build generates (the manifest's content files, scene files, compiled scripts); no cap on the whole build. The project's files (assets, instance buffers) are not held: Play serves them from disk at their digest URLs, verified while sent | One file the backend holds; what the page reads of the project is read from disk per request |
| Fixed-step catch-up per frame | 8 steps (the rest are dropped) | A slow frame must not make the next one slower |
| Script physics queries | 1,024 per step, 2D and 3D together (1,024 rays cost Rapier about 1.6 ms with 16,384 colliders) | Runtime budget against a runaway loop |
| Game-view events kept | 32 | A display ring |
| Sound voices | 32 at most (the `audio_voices` setting's range; default 8) | Mixing cost; as Unity's real-voice default |
| Audio plays | 64 script sound handles alive; 32 plays per step; a sound whose file is not ready starts late up to its `maxLateMs` (default 500 ms, a dialogue voice 1,000 ms, at most 60 s) or is dropped | Runtime budget per step; decoded audio has no count: each file is held by what plays or preloads it and freed after |
| Script asset handles | 64 answers per input frame (the rest ride the next frames, never refused); keys up to 256 characters | What one input frame carries; handles themselves are not counted |
| Timelines playing | 8 at once | Runtime budget per step |
| Spawns | 64 per step (a spawn costs about 0.1 ms with 16,384 alive); 16,384 alive (one scene's entity capacity) | Runtime budget per step; spawned copies live like a scene's entities |
| Timers | 64 per script instance | Named timers of one script, saved with it; a script needing more keeps a list |
| Script intents (move, jump, transform, pose, respawn) | 40 per script instance per step (a transform and a pose on each of its 16 owned entities and its control intents); per step at most 64 or 40 × the running script instances, whichever is larger | Defense in depth against a runaway script |
| Script entity writes (`ctx.world.entity(id).set`) | 65,536 per step (four for every entity of a full scene) | Runtime budget against a runaway loop |
| Colliders | none of their own: every entity may carry one (16,384 static colliders step in about 3 ms in Rapier, measured); 3D hull and mesh points 1,048,576 per scene (a thousand full meshes build in about 2 s at load) | The load cost of mesh colliders |
| Scenes / entities | As many scenes as the game needs; 16,384 entities per scene (a big world is several scenes loaded together) | A scene is one load unit and one file |
| Prefabs | 1,024 entities and 16 levels per prefab; 1 MiB (the content file cap) | One definition is one file and one command's copy |
| Collision layers / tags | 15 named layers (+ `default`) / 32 tags | Rapier's 16-bit collision groups / a 32-bit tag mask |
| Local lights | 16 point and spot lights per scene, 16 drawn across loaded scenes | Forward-lighting cost; scalable lighting is phase 27 |
| Fog volumes | 16 per scene | A fixed-size uniform array in the shader |
| Lightmaps | 16 atlases and 4,096 entries per scene bake, 64 baked lights | The bake's own format; phase 27 reworks lighting |
| Texture arrays | 256 layers | What WebGL 2 and WebGPU both guarantee |
| Texture edge | 4,096 px | Kept after streaming: the KTX2 encoder makes at most about 3,500² (12 Mpix), WebGL 2 promises only 2,048 and many devices stop at 4,096, and a streamed texture close to the camera still needs its full-size level |
| Texture budget | 512 MiB by default (`texture_budget_mb`, 1–65,536) | A runtime budget: streamed textures' mips fit it, the least needed dropped first; the mip tails and textures that do not stream are counted, never dropped |
| KTX2 encoding | 12 Mpix per source (across a packed array's layers) | A known limit of the pinned encoder (Basis Universal 2.5), kept; a larger texture is imported as PNG/JPEG or encoded outside the editor |
| Material instances | 8 parents deep | A chain resolved at build; deeper chains are an authoring smell |
| Graphs | 4,096 nodes per graph (the kind may set fewer; 256 for a script or effect system graph, which compile into one bounded module) | The editor and the compiled output of one document |
| UI documents / timelines | 512 widgets and 48 KiB per document; 256 keys per track and 48 KiB per timeline | Each is saved in one 64 KiB command |
| Dialogue | 1,024 nodes per conversation; 256 dialogue variables; 8,192 seen lines | One conversation is one document; the variables and the seen set are saved with the game |
| Model rigs | 262,144 key numbers per model (clips past it are left out) | What one model adds to the catalog; per model, never per project |
| Folder listing | 500 entries per `tl_content_query target="projectFiles"` listing | A page of one folder; the project window and `queryIndex` page through any number of files |
| Command request | 64 KiB per request (a folder import names the folder, not its files; `setLabels` about 1,500 items per request) | One request's parse; larger edits are staged or name a folder |
| Upload stages | 8 open and 128 MiB staged per project at once | Uploads in flight in the backend; each is committed or expires |
| Scripts | 256 KiB of source, 16 files of 64 KiB each, 128 KiB compiled output per script; no count of scripts (a game runs as many as it has) | One compile and one module |
| Model import | 2,000,000 vertices, 4,000,000 triangles, 64 animations, 512 MiB decoded (geometry and images) per model | What one model's inspection and the page's decode hold |
| Instance sets | 65,536 copies per set | One buffer file and one draw set |
| Block edits | 1,048,576 cells per edit | One command's work; a layer is stored in chunks |
| WebSocket message to the editor | 1 MiB (a larger Play snapshot is fetched over HTTP; a larger change makes the editor re-read the project; anything else over it is dropped and listed under Problems) | One frame |

### Engine defaults

Every default is sized for any project, not for a sample: sizes are set
against the default 1.8 m character and its 1.25 m jump, and each default has
its reason next to it in the code (`project-model/src/descriptors.ts` and the
constants it names). The GameObject menu's camera and lights are the same
values as "+ Add component" and a new project's starter camera and lights
(a white key light at 1.2 with shadows and a cool fill at 0.6, a 60° camera).
A gradient sky is grey below the horizon; an instance scatter starts as a
20 × 20 m square. Games keep their own values in their own data. HUD prompts
(`$flow.prompts`) name the game's actual bindings (the player's rebinding
included), with pad button names while a pad is in use. Scene validation
refuses negative directional/ambient light intensities and surface
roughness/metalness/glow (the range is `0 ≤ v`). Other fixed values: the
camera's "no move" threshold 1e-9 m and a 16:9 aspect until the host reports
the viewport, the model animation's run threshold 0.05 m/s, the shadow-follow
extent 24 m and a stick dead zone of 0.2 (per action: `deadZone`). New
objects get `<kind>-N` ids with at least six digits (`box-000001`), unique
across the project and without a bound (older four-digit ids load and stay).

## Renderer backends

Play, the exported game, the Scene view, the asset/Animator previews, the
asset thumbnails and the browser lightmap baker get their renderer from one
factory. Since phase 17.4 everything draws with three's `WebGPURenderer`,
all shading written once in TSL (node materials and node post-processing);
three's older `WebGLRenderer` path is gone (archived in the repository under
`archive/webgl-renderer-17/`). Three backends:

| Name | What draws | |
|---|---|---|
| `auto` | WebGPU when the browser gives a working adapter and device within 5 s, else the WebGL 2 backend | the default |
| `webgpu` | WebGPU (the adapter gets up to 30 s); where WebGPU cannot start it runs on WebGL 2 and says why | |
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
lights a bake holds left out), the Scene view's selection tint and look
overrides work there too. A pixel test compares each against the
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

## Simulation thread (worker)

Since phase 22 the game's simulation — the runtime with its fixed steps,
Rapier physics, the gameplay blocks, animators, timers, spawns, effect and
sound requests, and the project's scripts — runs in a dedicated **worker**,
in Play and in exported games. The page keeps what needs the page: input
(keyboard, pads; sampled once per frame and sent with the frame), sound (the
worker sends the sound requests; the page's audio owner plays them), the
HUD, menus, the game shell and saves (browser storage), and rendering (the worker
sends each frame's interpolated transforms, visibility, fades, animator
poses, counters and effect requests). A long simulation step no longer
delays a frame or an input event. Results are identical to running in the
page: the same fixed steps with the same inputs (a test compares a digest of
every step's state in both modes), recorded replays and bots included.

**Where it runs.** In this order:

1. the page URL flag: `?threads=off` (also `single`, `main`) forces the page's
   main thread, `?threads=on` (`worker`) the worker — on the editor's URL it
   is passed on to Play (like `?renderer=`); on an exported game's URL it
   applies directly;
2. the project setting **Engine → Simulation thread** (`sim_thread`: Worker /
   Main thread);
3. otherwise the worker.

A browser that cannot start the worker (no `Worker`, a blocked script) plays
in the page instead. Every Play and export page logs its choice to the
console, e.g. `[thirdlight] simulation: worker (the default); transforms by
messages (cross-origin isolated: no)`; `tl_game_observe` and
`tl_diagnostics` report it as `simulation: { mode, transport, isolated }`,
and an exported page has it in `window.__thirdlightThreading`.

**Files.** Play loads the worker from the preview origin (`/sim-worker.js`,
built next to the preview bundle; the preview CSP allows `worker-src
'self'`). An export ships it as `js/sim-worker.js` next to `js/main.js`;
Rapier's WebAssembly is inside that bundle (no fetch, no URL), and the export
scan checks it like the main bundle. The compiled scripts are imported by
the worker from the same `behaviors/<digest>.js` files as before.

**Shared memory (optional).** The per-frame transforms go as messages
(transferred typed arrays; only the entities that moved when few did). Where
the page is *cross-origin isolated* they go through a `SharedArrayBuffer`
instead — the same results, one copy less per frame:

- *Exported games:* serve the game with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (every file of the export is
  same-origin, so nothing else is needed). Without these headers the game
  works exactly the same with messages.
- *Play:* start the backend with `THIRDLIGHT_CROSS_ORIGIN_ISOLATION=1`. The
  editor page and every preview-origin response then carry COOP + COEP (the
  play page also `Cross-Origin-Resource-Policy: cross-origin`, as it is
  embedded by the editor). Off by default: it changes how the editor page is
  isolated (a cross-origin resource the editor would load without CORP
  headers would be blocked), and Play works the same without it.

**Limits (22.3).** The physics engine's WebAssembly memory may grow to
512 MiB (`PHYSICS_MEMORY_CAP_BYTES`, an engine limit far above any 2D level);
past it the worker stops the simulation with `physics_memory_limit` instead
of growing without bound. Stopping Play (or leaving an exported page) frees
the worker's runtime and Rapier world before the worker ends. The physics
query budget (32 rays and overlaps per step) and overlap queries are the
same in the worker.

**What stays different.** Commands from the page (a level switch, pause, a
scene load, run start/replay) reach the worker in order and apply at its next
step boundary, as in the page; a level switch the worker refuses is logged
(`simulation worker refused startLevel …`) instead of being refused
synchronously. Frames are rendered as soon as the worker's frame arrives
(at most one frame in flight), so a key press moves the player within the
same few frames as in single-thread mode (an e2e test measures it).

**Measuring.** `node tools/perf/run.mjs --surfaces play,export --threads
worker,off` measures Play and the export in both modes; the report adds the
page's main-thread task time per frame (`mainThread`).

**Rendering stays on the page.** A render worker (the canvas moved to an
`OffscreenCanvas` in a worker) was built and measured in phase 22.2 and not
adopted: on the CPU-rendered test host it freed the page's main thread but
drew no more frames, and it showed unexplained stalls on WebGPU (numbers in
`docs/plan-phase-22.md` §5; the spike is kept in
`archive/spike-22-render-worker/`). Real-GPU measurements are pending.

## 3D physics (physics dimension)

Since phase 23.0 a project chooses its simulation's dimension in the project
settings: **Engine → Physics** (`physics_dimension`): **2D plane** (the
default, and what every earlier project keeps — movement and collision in X
and Y on the Rapier 2D backend, exactly as before) or **3D** (the Rapier 3D
backend, `@dimforge/rapier3d-compat` 0.20.0; decision 0005).

In a 3D project:

- every box collider needs a **depth**: the collider's **Half depth** field
  (`hz`, metres; its Scene handle becomes a 3-axis box that turns with the
  object once the depth is set). Switching a project to 3D is refused while a
  box has none; polygon colliders are 2D-plane shapes and are refused too;
- phase 23.1: a collider's **Shape** may also be a **sphere** (radius), a
  **capsule** (radius and total height, standing along the object's Y), a
  **convex hull** (up to 64 points) or a **triangle mesh** (up to 1,024
  vertices and 2,048 triangles; static level geometry — never on a mover).
  Hulls and meshes are made from a model: dragging a model with a `_COL`
  node into a 3D project gives it a mesh collider from that node (a convex
  hull when it is too big for a mesh), and the Inspector's **Box / Convex
  hull / Mesh from model** buttons make one from the object's model (its
  `_COL` node(s), else its LOD0 geometry). A 3D collider takes its object's
  scale (any positive scale for a box, hull or mesh; uniform for a sphere or
  capsule). The Scene view draws every 3D collider as a wire outline; a
  sphere has a radius handle, a capsule a height and a radius handle.
  "+ Add component" offers the 3D presets (Box (3D), Sphere, Capsule, Convex
  hull, Mesh) in a 3D project and the 2D ones in a 2D plane;
- **triggers** are 3D volumes: a **box** with a depth (`size` [w, h, d]),
  a **sphere** or a **capsule** (radius and height), turned with their
  object and tested exactly against the player's capsule — enter and exit
  signals, `mode: stay`, `once` and scripts' trigger events work as in 2D.
  Switches are 2D-plane blocks and are refused in a 3D project; one-way
  colliders too;
- **movers** move 3D colliders (box, sphere, capsule, hull) along their
  waypoints and carry the player standing on them; a script may drive a
  collider no mover moves through its transform intents (the runtime turns
  it into a moving body; the player standing on it rides along);
- colliders may be rotated about any axis; the player controller stays
  upright; the capsule's **Offset** may have a z component;
- in Play and the export the player is a kinematic **3D character**
  (phase 23.2, below; cameras: see *Cameras* below);
- `tl_game_observe` reports such a play with `state: "running"`, its
  step and `player: { x, y, z }`; an exported page has the same observation
  in `window.__thirdlightObserve()`.

### The 3D character (phase 23.2)

The object with the **Player controller** walks, runs, jumps and climbs in a
3D project. Its settings are fields of the controller (Inspector, 3D projects
only; the 2D plane's Autostep is hidden there), each with a default that fits
any genre:

- **Movement:** Walk speed (2 m/s), Run speed (absent: the project's run
  speed setting — used while the `run` input action is held), Acceleration /
  Deceleration (shared with the 2D controller), Air control (0.5: the share
  of acceleration in the air), Gravity scale (× the project's gravity), Turn
  speed (720°/s; 0 turns at once) and Face movement (on: the object turns
  about its up axis so its +Z faces where it moves — its model turns with it);
- **Jump:** Can jump (on), Jump speed (absent: the project's jump velocity),
  with the controller's coyote time, jump buffer and jump release;
- **Collision:** Slope limit (absent: the project's max slope setting),
  **Step-up height** (0.3 m, a stair riser — steps up to it are climbed
  without a jump, taller blocks stop the character; 0 turns it off; the
  ground snap is at least this height, so it also walks down stairs without
  falling), **Ledge climb** (off; when on, pushing against a ledge up to
  **Ledge height** (1.2 m) with a walkable top and room for the capsule pulls
  the character up onto it over **Climb time** (0.6 s)).

The step-up and ledge heights have Scene-view handles above the capsule's
feet (drag up or down; 5 cm snapping; one undo).

**Climbing and walls** (phase 25.13, both dimensions, the player controller's
group of that name): **Climb speed** and **Climb action** (see Climb volume);
**Wall slide** (off; when on, falling in the air while pushing into a wall
slides down it no faster than **Wall slide speed**, 2 m/s) and **Wall jump**
(off; when on, jump in the air next to a wall it touches — or touched within
the coyote time — pushes it off at **Wall jump away** (absent: the run speed)
and **Wall jump up** (absent: the jump speed); the input does not steer for
**Wall jump lock** seconds — absent: until the top of that jump; a landing
ends it). With both off a character plays exactly as before.

**Input.** The move is a 2D vector: a project without its own input actions
gets the 3D defaults (W/A/S/D and the arrow keys or the left stick move,
Shift or the left-stick press runs, Space jumps); a project's own `move`
action moves in 2D when it is a 2D axis (a 1D `move` only moves sideways).
The vector is read relative to the active virtual camera's yaw (see
*Cameras*: forward walks away from the camera); a scene without virtual
cameras walks along world axes (+x input along +X, forward along −Z).
`tl_input_exercise` frames take an optional `moveY` (the forward axis) and
named `actions` (e.g. `run`).

**Scripts** can drive the character with intents (intent phase): `{ kind:
'character_move', x, z, run? }` walks it along a world direction this step,
`{ kind: 'character_place', position: [x, y, z] }` teleports it,
`{ kind: 'character_enable', enabled }` switches the controller off (it stays
where it is: no input, no gravity) or on, and `control_move` takes an
optional `y` (the forward input). `ctx.physics.characterState(id)` reads its
position, velocity, grounding, contacts, whether it is on and climbing, and
its facing. These intents are refused in a 2D-plane project. A recorded
input replays the same positions in the page, the simulation worker and the
export.

**Files.** The 3D backend is a separate script so 2D games never download
it: Play loads `/physics-3d.js` from the preview origin, a 3D export ships
`js/physics-3d.js` (about 2.9 MB, 1.1 MB gzipped, the WebAssembly inside —
no fetch, no URL) and lists the `@dimforge/rapier3d-compat` license. It loads
in the simulation worker or, single-threaded, in the page.

## Cameras (virtual cameras)

Since phase 23.4 a scene can hold **virtual cameras**: shots the game cuts or
blends to. Add one to any object with **+ Add component → Virtual camera**
(Camera group; presets: follow/orbit, orbit a point, top-down, fixed). The
scene camera (the object with the Camera component) still draws the game;
with an enabled virtual camera it shows that camera's view instead. A
project without virtual cameras draws the scene camera as placed.

**Which camera is live.** The enabled virtual camera with the highest
**Priority** (on a tie the one activated last, then the first in the scene).
**Enabled at start** off keeps a camera waiting for a script. Without an
enabled virtual camera the view is the scene camera's own (its follow, or
where it is placed).

**Rigs** (the **Rig** field; the Inspector shows the fields each uses):

- **Follow / orbit** — circles its **Target** at **Distance**, **Yaw** and
  **Pitch** (limits **Pitch min/max**), plus a **Target offset** (e.g. head
  height). The player turns it with the **Turn action** (an axis; a 2D axis
  turns with x and tilts with y), tilts it with the **Tilt action** and zooms
  with the **Zoom action** (between **Min/Max distance**). In a 3D project it
  is pulled in front of colliders between it and the target (**Collision**,
  **Collision radius**; never closer than Min distance). **Damping** lets it
  lag behind a moving target.
- **Orbit a point** — circles the **Point** (a world point with a Scene
  handle; absent: the target, else where it is placed). Each press of the
  **Turn left/right action** turns one **Turn step** (90° by default), eased
  over **Turn time**; tilt and zoom as above.
- **Top-down** — straight down onto its target from **Distance**, turned by
  **Yaw**.
- **Fixed / look-at** — where it is placed; with a target it looks at it.
- **Rail (path)** — rides a **Camera path** (another component: points as
  offsets from its object, drawn and dragged with the path handle; **Closed**,
  **Smooth**). **Progress** (0–1) is where it starts, **Rail speed** (m/s)
  how fast it rides, **At the end** stop, loop or back and forth. It looks at
  its target, or along the path.

**Blends.** When the live camera changes, the view moves from what is on
screen to the new camera: **Blend in** cut, linear or eased over **Blend
time** (back to the scene camera: the camera being left sets it). A change
during a blend continues from the blended view.

**Lens and effects.** **Field of view**, **Near** and **Far** (absent: the
scene camera's — a camera with a far plane of kilometres draws distant
scenery), **Letterbox** (black bars over the top and bottom, each that share
of the view height, blended with the camera) and a constant **Shake**
(amplitude, frequency, rotation).

**Depth precision.** Project settings → Rendering → **Depth precision**
(`depth_buffer`): Standard (the default), Logarithmic or Reversed Z. The last
two keep close objects sharp while scenery kilometres away still sorts
correctly; reversed Z needs WebGPU or a WebGL 2 browser with
`EXT_clip_control` and falls back to standard otherwise. The game canvas
reports the mode in `data-tl-depth`.

**Scripts** (`ctx.camera`, and the Camera nodes of visual scripts):
`activate(id, {blend?, time?})`, `deactivate(id, …)`, `setPriority`,
`setTarget`, `set(id, {distance, yaw, pitch, progress, railSpeed, fovY,
letterbox, point, targetOffset})`, `turn(id, steps)`, `shake(amplitude,
seconds, frequency?, rotation?, seed?)`, `live()`, `blending()`, `get(id)`,
`worldToScreen(position)` and `screenToRay(x, y)` (screen coordinates 0–1
from the top left, with the aspect of the view the game is drawn in).
Changes take effect at the end of the step; the camera is resolved in the
simulation step, so replays, the simulation worker and the export give the
same camera (and the same screen rays) bit for bit.

**Editor.** A selected virtual camera shows its frustum where its rig puts
it (the same maths as Play) and a line to what it looks at; the orbit point
and camera path points are Scene handles (one undo step per drag).

**Observing.** `tl_game_observe` (and `window.__thirdlightObserve()` in an
export) reports `camera: { live, blend: {from, progress, style} | null,
position, rotation, fovY, near, far, letterbox, shake }` while the game has
virtual cameras.

## Timelines (sequencer, phase 23.17)

A **timeline** is project content (bottom dock → **Timelines**: create,
open, delete; one undo step each) that sequences what a cutscene or a
scripted event does on a time ruler. It has a **duration**, **tracks** of
**keys** (a key with a duration is a clip) and **markers**. Tracks never name
objects: they name **slots**, and a play binds the slots to objects (each slot
may have a default object — used by the editor preview and when a play binds
nothing), so one timeline serves any actors.

**Track types** (the key fields in brackets):

- **Camera** — a key makes a virtual camera live from its time until the next
  key, over the game's priorities [camera slot or release, blend cut / linear
  / eased and blend time, rail progress from→to over the key's span]. At the
  end the track **releases** the view to the game's cameras (with its end
  blend) or **keeps** the last camera enabled.
- **Transform** — the target's position, rotation, scale, each channel eased
  between keys (from its first key on). A 3D character's body moves with it.
- **Animator** — set a parameter, fire a trigger, or go to a state (with a
  crossfade) on the target's animator.
- **Audio** — music change (crossfade; no asset: silence), give the music back,
  a stinger, an SFX (optional loop, length, position of a
  bound object). The track can give the music back when the timeline ends.
- **Dialogue** — run a dialogue node and wait for it (needs the dialogue
  system of phase 23.16; until it is in the engine a dialogue key is skipped
  with a warning).
- **Effect** — start a visual effect (at a bound object or a position, with
  parameters; a length stops it).
- **Activation** — show or hide the target.
- **Signal** — fire a signal (scripts see it one step later with
  `ctx.signals.on`; effects and movers start on it). **On skip** fire (the
  default) or drop.
- **Fade** — a full-screen colour over the view (opacity 0–1); **Letterbox** —
  black bars (each a share of the view height; the larger of the timeline's
  and the camera's is drawn). Both are cleared at the end unless **hold**.
- **Wait for input** — the timeline stops at the key until the input action
  is pressed (optional timeout).
- **Material** — a public graph-material parameter of the target (number,
  vector or colour, eased).
- **Game mode** — switch the game mode (as `ctx.modes.switch`, with an optional camera blend); skip applies the last remaining mode key.
- **Environment** — switch to an environment preset (needs phase 23.18;
  skipped with a warning until it is in the engine).

Easing (linear, step, ease in, ease out, ease in-out) shapes the move from the
previous key to the key.

**Playing.** `ctx.timeline.play(id, { slot: entityId })` returns a handle (0
when refused: no such timeline, or 8 already playing); `pause`, `resume`,
`stop` (where it is, no end states; the sounds and effects it started stop),
`skip` (see below), `seek(handle, seconds)` (continuous tracks and cameras at
that time; keys in between do not fire), `state` (playing, paused, waiting,
ended), `time`, `isPlaying(id)`, `events()` (started, ended with reason
finished / skipped / stopped, marker — seen in the next step), `ended(handle)`
and `marker(name)`. A timeline can also play when a run starts (**Play when a
run starts**) or when a signal fires (**Play on signal**). Its **skip action**
(an input action) skips it while it plays.

**Skip** applies each track's end state at once: the last camera (cut), the
transforms, material values, fade and letterbox at the end, the remaining
animator parameter sets and state changes (triggers are dropped), the
remaining music changes (the music owner and track end as if played; stingers
and SFX are not played, the sounds it started stop), the remaining activation
keys, the remaining signals (unless a key says drop); waits pass, pending
dialogue does not run; markers after the skip point are not reported.

**Determinism.** Timelines run in the simulation step (after the scripts,
before the camera brain): time counts in fixed steps, a wait key reads the
step's input frame, and every change goes through the same channels scripts
use — so the simulation worker, the export and replays (skip and waits
included) give the same result.

**Editor.** Open a timeline in its centre tab: the timeline's fields and
slots at the top, the track list beside the time ruler (zoom slider), keys
dragged along the ruler (one command per drag), a key inspector for the
selected key, **Add key at playhead**. Clicking or dragging the ruler scrubs:
the Scene view stays visible above the timeline and shows the bound objects
where the timeline puts them and the live camera's frustum at that time;
animator tracks show the state their keys lead to; sound, effects, signals and
dialogue play in Play only.

**Observing.** `tl_game_observe` / `window.__thirdlightObserve()` report
`timeline: { screen: { fade, opacity, letterbox }, playing: [{ handle,
timeline, time, state, wait }], events }` once a timeline played; the fade
element carries `data-tl-fade`.

**Engine limits.** 32 tracks, 256 keys per track, 16 slots, 64 markers,
600 s and 48 KiB of JSON per timeline (a timeline is saved in one 64 KiB
command), 8 playing at once; as many timelines as the project needs.

## Block layers (phase 23.5)

A **block layer** builds a level from blocks on a grid (terrain, buildings, a
tactics map, a dungeon, a voxel sandbox). The core — data, storage,
rendering, collision, script API and bulk commands — is in; the editor's
brushes, overlays and stamp UI are below (23.6).

- **Block types** (`content.blockTypes`, `setBlockType` / `deleteBlockType`):
  up to 8 weighted **looks** each — a model (asset and optional piece), a
  prefab's root model, or a coloured stand-in shaped like the collision
  shape; a **collision shape** (`full`, `half`, `ramp`, `stairs` — both rising
  toward +Z —, `custom` boxes, `none`); `solid` (hides the faces of
  neighbours touching it; default for `full`); a **footprint** of several
  cells (stored at its min corner, the covered cells stay empty); the allowed
  **rotations**; default cell metadata; a material mapping.
- **Cell metadata schema** (`content.cellFields`, `setCellFields`): fields of
  type bool, enum, int, float or string with defaults, ranges and an overlay
  colour. The schema is the project's own; the engine knows no field names.
  A cell's effective metadata is the schema default, then its block's
  default, then the cell's own value. Cells may hold metadata only.
- **The `blockLayer` component** (Rendering): cell size per axis (e.g.
  `[1, 0.5, 1]`), bounds in cells (at most 1024 × 256 × 1024), metadata-only,
  collision and shadow flags. The object's position is the min corner of cell
  `[0, 0, 0]`; a layer is a root (a folder may hold it) at identity rotation
  and unit scale. Deleting the layer object deletes its cells (undo restores
  them). Several layers per scene (up to 16 with cells).
- **Storage**: each chunk of 16 × 16 columns is its own diff-friendly file,
  `scenes/<sceneId>.blocks/<entityId>.<cx>.<cz>.json` (the palette and one
  run-length column per line); the scene file lists them. External-edit
  detection and the recovery snapshots cover these files like any project file.
- **Editing** (`editBlocks {entityId, edits}`, one undo step, each request
  under 64 KiB): `fill` a box (set / keep / replace), `cells`, `array`
  (run-length data), `replace` a block type, `meta` (paint metadata), `flood`,
  `column` (raise / lower), `stamp`, `copy` (copy / move / mirror / turn a
  selection), `region` (named cell sets: set / add / remove / rename /
  delete), `heightmap` (a greyscale PNG → column heights, an optional colour
  PNG → blocks). Stamps: `setBlockStamp` (whole, or a layer selection) /
  `deleteBlockStamp`. The change names the chunks and regions touched;
  `queryBlocks` (MCP `tl_content_query target="blocks"`) reads layers, chunks,
  a box of cells (with effective metadata) or a region.
- **Rendering**: one merged mesh per block look and material per chunk; faces
  between neighbours are left out (a solid neighbour, or the same face
  profile — two half blocks, two ramps side by side); whole chunks are culled
  outside the view. The Scene view, Play and exports draw layers through the
  same code (WebGPU and WebGL 2).
- **Collision** (3D projects): one triangle-mesh collider per chunk built from
  the collision shapes, rebuilt when cells change, before the step's physics
  sweep. A 2D-plane project draws layers but they do not collide.
- **Scripts** (`ctx.grid`): `layers`, `get`, `set`, `clear`, `columnTop`,
  `worldToCell`, `cellToWorld`, `meta`, `setMeta`, `pick` (a ray → cell and
  entered face; a deterministic walk over cells, independent of physics),
  `neighbours`, `regions` / `region` / `inRegion`, `changes` (last step's
  writes), `diff` / `applyDiff` (plain data for a save). Writes are refused
  (`false`) when they do not fit; at most 4,096 per step. Visual-script nodes
  exist for the calls.
- **Lightmaps** (25.20): a block layer object marked **Static** is baked
  like a static box or model — each chunk gets its own lightmap (one entry
  per chunk in the bake, browser preview and Blender final alike); a chunk
  changed after the bake is drawn without it (the bake shows stale); other
  layers shade baked objects only.
- **Sloped terrain** (25.20): a single-cell `full` block may carry
  `corners` — the heights of its top corners (−x−z, +x−z, +x+z, −x+z) in cell
  heights, 0–4 in steps of 1/64 — and is drawn and collides with that sloped
  top (walls where neighbours differ, one smooth surface where their edges
  meet; a slope may cross rows inside a column). `surface` edits set column
  tops by corner heights, `sculpt` dabs raise, lower, smooth or flatten under
  a round brush. The layer's **Max slope** (`maxSlope`, degrees) is the
  steepest ground: characters do not walk up steeper parts, and
  `ctx.grid.surface(layer, position)` / `columnSurface(layer, x, z)` report
  the ground's height, normal, slope and whether it is walkable.
- **Levels of detail** (25.20): blocks shown by a model with `_LOD1..n`
  levels switch per chunk — each chunk's models at their coarser level past
  the models' own distance plus the chunk's size; stand-ins stay detailed.
- **Paint and wetness** (25.21): a layer's ground carries a paint of four
  material layers and a wetness per lattice vertex, stored with each chunk
  (`paint` edits: a round brush with radius, strength, falloff smooth /
  linear / constant and a channel — layer 1–4 or wetness — or `erase`). A
  painted layer's chunks carry it as vertex colours (COLOR_0 = the four
  layer weights, COLOR_1.r = wetness), so any graph material can read it; the
  **height-blended layers (painted terrain)** material template does: four
  PBR layers from three texture arrays (albedo + height, normal maps,
  occlusion/roughness/metalness) mixed by a Height blend, wet ground darker
  and glossier (a `wetness` parameter wets everything, e.g. rain from a
  script). Map it to a block type with **Materials** `*` → the material —
  since 25.21 a coloured stand-in takes the `*` material too. The paint is
  visual: scripts do not read it, replays do not depend on it.

## Block layer editing (phase 23.6)

The **Blocks** tab (bottom dock) edits block layers in the Scene view. Every
action is an ordinary command — `editBlocks` for cells and regions,
`setBlockType` / `setCellFields` / `setBlockStamp` for content — so each
stroke or button is one undo step, and MCP can do the same.

- **Layer**: choose the layer the tools edit (+ Layer makes a 64 × 16 × 64
  layer of 1 m cells); Hide and Lock are the object's Active and Locked flags
  (the Hierarchy shows the same). **Slice**: the row the tools use where no
  block is under the pointer — PageUp / PageDown or ] / [, or the − / + and
  number box. The grid of that row and the layer's bounds are drawn.
- **Tools** (the left button; Alt+drag or the right button orbits while
  "Edit cells" is on): Paint and Erase (drag, cell by cell), Line,
  Rectangle, Box (the rectangle raised to the box height), Flood, Raise /
  lower (Ctrl held or "Lower / remove" lowers), Height, Smooth and Flatten
  (terrain, 25.20: a round brush over the ground with Radius and Strength —
  Height raises or, with Ctrl, lowers the ground with sloped tops, Smooth
  evens it out, Flatten levels it to the height where the drag starts; a
  drag is one undo step), Paint texture (the Paint mode, 25.21: a round
  brush painting material layer 1–4 or wetness with Radius, Strength and
  Falloff; Ctrl or "Lower / remove" erases; a drag is one undo step), Pick (the eyedropper takes a
  cell's block, rotation and look), Replace all (every block of the clicked
  type becomes the brush block), Metadata, Select, Paste, Stamp and Region.
  Adding tools place on the face under the pointer. A stroke previews at once
  and is stored when the button is released (Esc drops it).
- **Brush**: Rotate (Q) steps through the block type's allowed rotations;
  "Random look" lets every cell show a look picked by the variants' weights
  (stable by position); off paints the chosen look.
- **Palette**: the project's block types as colour swatches (a model's
  thumbnail when it has one); + Block type makes one; clicking a type opens
  its form (looks, collision shape, footprint, rotations, default metadata,
  materials) — the same fields as its content descriptor.
- **Metadata**: pick a cell field and a value (or Clear), Cells or Rectangle,
  "Occupied only"; the overlay toggles colour the fields on the cells (the
  field's colour, a palette per choice for an enum, a shade along the range
  for numbers) with a legend. "Cell fields" edits the schema.
- **Selection**: Select drags a box; Copy (Ctrl+C) / Move (Ctrl+X) then click
  with Paste (another layer works too); Mirror X / Z, Rotate 90°, Delete
  (Del); "Save as stamp". **Stamps**: the library places a stamp (turned or
  mirrored) with the Stamp tool, or deletes it.
- **Regions**: the layer's named regions are outlined; click one to paint it
  with the Region tool (Ctrl removes), + Region makes one (from the selection
  when there is one), Rename, delete, "Add / Remove selection".
- **Props on blocks**: Edit → Snapping settings… sets the move, rotate and
  scale steps (per project, in this browser; defaults 0.25 m, 15°, 0.25) and
  "Snap objects to block cell tops": moved and dropped objects land on the
  top of the columns under them. The **Block footprint** component (`layer?`,
  `size` [x, z] cells, `set` {field: value}) writes its metadata into the
  cells beneath the object whenever it is moved in the editor (clearing them
  where it stood); the Inspector's "Write to cells" and "Snap to cell top" do
  it on demand. The runtime ignores the component (scripts read the cells).
- **Measured**: a stroke on a 64 × 64 × 16 layer holding 32,768 cells
  previews in about 40–55 ms per pointer move and is stored about
  110–160 ms after release on the test host.

## Sockets (objects on model nodes)

Since phase 23.11 an object can ride on a named node — a bone or any node —
of another object's model: equipment in a hand, a rider on a mount, a pilot
in a cockpit, a flash at a muzzle. Select the object and **+ Add component →
Socket**: **Target** is the object whose model carries the node, **Node** is
picked from that model's node list (read from its GLB, the names the game
uses), and **Offset** / **Rotation offset** / **Scale** place it relative to
the node. **Attached at start** off keeps the socket as data a script
attaches later.

The simulation places attached objects at the end of every fixed step,
after the animators, so an object follows the target's animation (its
animator's clips, blends, crossfades and layers, the way the renderer poses
the model) and replays, the simulation worker and the export agree bit for
bit. The object's own children ride along. An object on a socket cannot be a
physics body (collider, controller, mover) or the scene camera; a script's
transform writes on it are overridden while it is attached. Works in 2D and
3D projects.

**Scripts** (`ctx.sockets`): `attach(entityId, targetId?, node?, position?,
rotation?, scale?)` (no target: the object's own Socket component),
`detach(entityId, keepWorld = true)` — it stays where the node left it, or
snaps back to its transform from before the attach with `false` —,
`attachedTo(entityId)` (`{target, nodeName}` or null) and `nodePose(targetId, node)` (a node's world
position and rotation now, e.g. where to spawn a projectile). A refused
attach (an unknown node, a loop, a physics body) returns false and writes a
warning to the play log. Visual scripts have the same nodes under
**Sockets**.

**How the game knows the nodes.** The runtime never loads models, so a
project that uses sockets (a Socket component anywhere, or a script naming
`ctx.sockets`) gets each model's **rig** — its nodes and the node animation
channels of its clips — read from the GLB into the play/export build (the
manifest's `rigs`). Engine limit: 262,144 key numbers per model, its
animation-only files included (clips past that are left out and a socket on
them warns once); no budget is shared across the project. Projects without sockets build exactly as before.

**Animation speed and morph targets.** `ctx.animator(id)?.setSpeed(x)`
sets one object's playback speed (every clip and crossfade; 1 as authored,
0.5 half speed, 0 holds the pose; 0–10) — slow motion for a prompt, an
animation-speed setting; `.speed()` reads it. The Animator's live preview has
a **speed** slider that plays the controller the same way. A controller's
**morphs** list (MCP `setAnimator`: `morphs: [{target, parameter}]`) drives a
morph target (blend shape) by a float parameter (clamped to 0–1);
`ctx.animator(id)?.setMorph(name, weight)` / `.morph(name)` set and read any
morph target from scripts. Morph weights are presentation: the renderer
applies them to every mesh of the model that has that target.

**Observing.** `tl_game_observe` (and `window.__thirdlightObserve()` in an
export) reports `sockets: [{ entityId, target, node, position }]` (the
drawn world position) while something rides on a socket.

## Pointer input and 3D queries

Since phase 23.3 the mouse (or pen/touch) is part of the game's input.

**Pointer bindings.** In the **Input** window, **+ pointer** adds what fits
the action: a mouse button (left/right/middle) to a button or 1D axis, the
pointer's movement along x or y (up positive, percent of the view per step)
or the wheel (notches) to a 1D axis, the pointer's **position** (x, y 0–1
from the top left) or **movement** to a 2D axis. Movement and wheel are
amounts per step (a second step in the same frame sees 0). A binding of the
right button keeps the browser's context menu off the view; a wheel binding
keeps the wheel from scrolling the page.

**Cursor.** Each map has a **cursor** setting (free or locked; default free),
the project's own maps included. While a menu is open the ui map's setting
applies. During play, without game modes, the gameplay map's applies; with
modes, the first of the current mode's maps that sets one (ui after the
others). A script may
ask for another with `ctx.input.setCursor('free' | 'locked' | 'auto')`
(`auto` = the map's setting; a new run starts with none). Locked uses the
browser's pointer lock — browsers want a click in the view first, so the
game asks again on the next click — and the pointer then sits at the view's
centre (only its movement counts). The cursor is hidden while locked and
while a gamepad was used last; it shows again when the mouse moves.

**Scripts.** `ctx.input.pointer()` → `{ x, y, dx, dy, wheel, over, entered,
left, locked }` (null before the pointer is first seen);
`pointerPressed/Released/Held(button?)` (default left; a click between two
steps still presses). Pointer samples are part of the step's input, so a
replay (and `tl_input_exercise`, which takes an optional `pointer: { x, y,
dx?, dy?, wheel?, buttons?, pressed?, released?, over?, locked? }` per
frame — masks 1 left, 2 right, 4 middle) reproduces them; a frame without a
pointer keeps the last position and held buttons. Its `actions` are now
passed through too.

**3D queries** (physics dimension 3): `ctx.physics.raycast3d(origin,
direction, maxDistance = 100, filter?)` → `{ entityId, point, normal,
distance }` or null; `overlapSphere(center, radius, filter?)`,
`overlapBox3d(center, half, rotation?, filter?)`, `overlapCapsule(center,
radius, height, rotation?, filter?)` → sorted ids (at most 64);
`pickAt(x, y, maxDistance = 1000, filter?)` casts the active camera's ray
through a screen point (the scene camera's when no virtual camera is live —
`ctx.camera.screenToRay/worldToScreen` do the same now), `pickAtPointer`
through the pointer (null while it is off the view). A filter is `{ tags?,
layers?, exclude? }`. At most 1,024 queries a step for all scripts together
(then nothing; warned once in the play log). A 3D scene without a player
still has physics when it has colliders (they answer the queries).
Hover edges on objects are the script's own: compare this step's pick with
the last one.
A hit on a block layer names the layer (`entityId`) and carries `cell:
[x, y, z]` (`ctx.grid` coordinates), so `pickAtPointer` picks cells too.

**Collision layers.** **File → Project tags** also lists the project's
collision layers ("default" is implicit; up to 15 more). A collider's
**Collision layers** field lists the layers it is in (absent: "default");
queries see only the layers their filter names. Layers do not change what
collides with the player. A layer a collider still lists cannot be removed.
MCP: `setCollisionLayers {layers}`; collider `{ layers: [...] }`.

**Observing.** `tl_game_observe` (and `__thirdlightObserve()`) report
`pointer: { x, y, buttons, over, locked }`, `cursor: { mode, locked, hidden }`
and `hidden` (the objects scripts hid). Headless browsers may refuse pointer
lock; the `data-tl-pointer-lock` attribute on the game canvas shows whether
the browser granted it.

## Input rebinding and glyphs (phase 23.14)

- **Players rebind in the built-in settings screen**: every action is listed
  for keys/mouse and for the pad (composites one row per direction); choose
  a row, press the new key or button (Esc cancels, 10 s timeout). An input
  already used by another action of the same map is swapped. "Reset controls
  to defaults" restores the project's bindings. Changes are saved in the
  browser per player profile (`bindings:<profile>` in the game's storage
  namespace) and load at start.
- **Scripts** read `ctx.input.device()` / `usingGamepad()`, `bindings()`,
  `glyph(action)` (label, icon id, the project's image) and ask for
  `ctx.input.rebind(action, { index, part, device, policy: 'swap' | 'refuse' |
  'allow', cancelKey, timeout })`, `cancelRebind()`, `resetBindings(action?)`,
  `useBindingProfile(name)`; outcomes arrive in `rebindEvents()`. A game's own
  rebinding screen is built on these. Replays stay valid: the simulation only
  sees action values and the binding information travels in the recorded input.
- **Hold instead of tap**: a key, pad button or mouse button binding takes a
  `hold` time (seconds) in the Input window.
- **Glyphs**: the engine has a neutral SVG icon set (key caps, face buttons by
  position, bumpers/triggers, D-pad, sticks, mouse buttons); pad labels follow
  the pad family (Xbox, PlayStation, Switch, generic) detected from the pad.
  Projects replace icons with their own textures in the Input window's Glyphs
  list (e.g. `xbox:pad-south`, `pad-south`, `key:Space`).
- Observation: Play observe and the export's `window.__thirdlightObserve()`
  report `inputBindings` (device used last, profile, listening, changed
  actions, each action's glyph).
- **Project UI** (UI documents): a button's engine action `rebind` (with
  `input`: the action, optional `device`, `index`, `part`, `policy`),
  `cancelRebind` or `resetBindings`; `{action:jump}` in a text shows the
  action's glyph for the device in use, in a dialogue line too (one
  character of its typewriter reveal); `$flow.input.actions` lists every
  action's key and pad labels for a settings document.
- Limits: 64 actions per project; 8 binding requests per step from scripts.

## Performance

Phase 21 measures the engine against written budgets with generated
benchmark projects and an automated harness. The budgets (frame time,
heap and GPU memory, load time, draw calls, simulation step cost and
garbage, editor command latency, per scene class) are in
`docs/plan-phase-21.md` §2 and `tools/perf/classes.ts`; they are for a
mid-range desktop GPU at 1920×1080. Measured numbers are in §4 there.

**Benchmark projects.** Five classes — small (100 entities), medium (2000
entities, 50 materials, 20 effects), large (16 000 entities over 10 scenes,
four instance sets of 50 000 copies, 200 colliders per scene), script-heavy (500 scripted objects),
effect-heavy (20 effects, 50 000 particles) — are generated
deterministically (`tools/perf/generate.ts`, seed 21) and built through the
real HTTP API into a throwaway data root under
`~/.cache/thirdlight-perf/runs/` (deleted after the run unless `--keep`).
Effects are generated with their emitter objects; since phase 20.2 Play and exports draw them.

**Run the harness** (needs `dist/`; not part of `npm test` or the default
Playwright run):

```sh
npm run build
node tools/perf/run.mjs                                  # every class, WebGPURenderer on WebGL 2
node tools/perf/run.mjs --classes small,medium --quick   # a short smoke run
node tools/perf/run.mjs --renderers webgpu               # WebGPURenderer on (headless) WebGPU
node tools/perf/run.mjs --compare tests/perf/baseline.json   # exit 1 on a regression
```

Options: `--classes`, `--renderers webgl2,webgpu,auto` (`legacy` is accepted and draws with WebGL 2, as `?renderer=legacy` does since phase 17.4), `--surfaces
play,export,editor,sim`, `--threads worker,off` (phase 22: Play and the export in the worker and/or with `?threads=off`), `--record-ms`, `--warmup-ms`, `--commands`,
`--sim-steps`, `--viewport WxH` (default 1280x720), `--seed`, `--keep`,
`--out FILE`, `--write-baseline FILE`, `--plays N` (phase 25.24a: N Plays in
the same editor page, each start split into its stages in the report and the
log; a class with scenes that do not start also loads one during the first
Play) and `--gpu` (draw on the host's GPU instead of SwiftShader). The
`asset-heavy` class (25.24a) has 48 distinct model files and 24 textures over
four scenes, one of which starts. For each class and renderer it
measures:

- **Play** (the editor's preview iframe) and the **export** (served by a
  plain static server): first-frame time, rendered-frame intervals
  (p50/p95/p99), draw calls and triangles per frame, live programs or
  pipelines, textures, buffers and an estimate of GPU memory — counted at
  the WebGL / WebGPU API, so WebGL 2 and WebGPU are
  measured the same way — the JS heap after a forced collection
  (`performance.memory`; `measureUserAgentSpecificMemory` needs a
  cross-origin-isolated page and is reported unavailable), and for Play
  three's own renderer counts from the play diagnostics;
- the **editor**: time to the Scene view's first frame, frame intervals while
  orbiting, heap, and the p95 round trip of `setTransform` commands with the
  project open; and (phase 21.4, once per class) the Hierarchy — rows in the
  page, click-to-Inspector and rename latency, scrolling — and what each
  command costs after its response: the delay until the editor's second
  frame after the `mutation.applied` arrived, long tasks, WebSocket bytes per
  change, the bytes and files the backend writes (stat diff of the project
  folder, plus the process's `/proc` write counter), and the bytes one
  material edit puts on the socket;
- the **simulation** in Node (runtime, character controller, Rapier and the project's
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

**Runtime and simulation (21.2).** The fixed step no longer allocates per
entity: the step's backup and the committed state are reused copies that are
overwritten in place (one pass over index-aligned arrays), the motion segments
are numbers (the frozen segment objects are made only when a module asks for
one), and the state views, step contexts and script contexts are made once
per module, phase and script instance and read the step's values live. Intent
checks, action frames, timers, trigger events, messages, trigger decisions and
the committed game view avoid per-step collections; the
physics port visits only its one-way and moving colliders. Garbage per steady
step went from ~1.4 KiB per entity (2.6 MiB at 2000 entities, 21 MiB at 16 000)
to a constant 13–60 KiB whatever the size (what is left: Rapier's JS glue,
the physics results and scripts' own intents), and a 16 000-entity step from
~16 ms to ~1.4 ms; replays and traces are unchanged bit for bit. The render
side reads the interpolated transforms through `forEachInterpolated` (reused
arrays; no per-frame copy of every transform) and the host reads the
committed game view without copying it each frame. Two limits were fixed on
the way: the per-step intent cap now grows with the script instances (5 each;
hundreds of moving objects may move every step), and Play and the export
apply the 256-collider limit per scene instead of to all start scenes
together (see "Engine limits"). `tests/perf/alloc.test.ts` (always on; needs
`dist/`) builds the medium benchmark and fails when its steady step allocates
64 KiB or more; `node tools/perf/run.mjs --surfaces sim` measures every
class, and the sim child's `profile` input (tools/perf/sim.ts) writes the
steady loop's allocation sites.

**Large projects in the editor (phase 21.4).**

- *Play of a large project.* The editor gets `play.started` over its
  WebSocket, whose messages are at most 1 MiB. A runtime snapshot that does
  not fit (a few thousand entities and up) is not sent inline: the message
  carries a reference, and the editor fetches the snapshot from
  `GET /api/v1/projects/<id>/play/<playSessionId>/snapshot` (owner token)
  and hands it to the preview as before. If that fails, the editor shows the
  error and the play stops. Nothing waits silently on the frame bound: an
  oversized change record makes the editor re-read the project instead, and
  any other oversized message is dropped with an entry under Problems.
- *Changes on the socket.* A `mutation.applied` carries the change without
  its "before" side (the HTTP result and the undo history keep it), and a
  change to a keyed list (materials, animators) carries only the items that
  changed plus the order, so one material edit in a project with 500
  materials is one material on the wire.
- *The editor's projection* updates incrementally: a change replaces only the
  entities it touched, the Hierarchy rebuilds its rows only when the tree's
  shape or names change and draws only the rows in view (above 400 rows),
  and the editor's panels keep what did not change, so a transform edit does
  not redraw every panel. The Scene view syncs only the changed objects
  (phase 21.3, below).
- *Commands.* A command runs against its one scene; only that scene's file
  (and, when content changed, `content.json`) is written, in the one-item-per-
  line layout above. Unchanged scenes are no longer re-serialized to find out
  they did not change.
- *Thumbnails.* The cache keeps its per-project count (a write no longer lists
  the cache) and answers revalidation (`ETag` / `If-None-Match`) with 304.
- The editor bundle uses React's production build.

**Editor workers (phase 22.1).** Heavy editor jobs run in a worker
(`dist/editor/editor-worker.js`, loaded next to the editor page on first
use), so the page keeps answering input while they run:

- *Bake preview (browser):* the whole bake — drawing the lightmaps with
  WebGPURenderer on an `OffscreenCanvas` (WebGPU or WebGL 2, the editor's
  renderer choice), reading them back, filling the padding, sRGB and the PNG
  encoding — runs in its own worker, which ends after the bake. The Lighting
  window's message says "(in a worker)". Placing the lightmaps in the atlas
  still happens on the page (it reads the Scene view's objects).
- *Asset thumbnails:* the model is still drawn on the page (the loaded models
  live there), but the PNG is encoded in the worker from a snapshot of the
  canvas instead of a synchronous read-back.
- *Instance set scatter:* the placements are computed in the worker.
- *Problems tab:* the diagnostics of graphs and graph materials (the kind's
  rules and the material compiler's problems) are computed in the worker and
  appear a moment after an edit. The open graph editor checks its own graph
  on the page as before.

Every job gives the same result on the page: add `?workers=off` to the
editor URL (like `?renderer=webgl2`) to run them all inline, as before 22.1. The editor does so by itself when the browser has no
`Worker` or `OffscreenCanvas`, when the worker script does not load (it is
not tried again until the page reloads), when a worker stops during a job,
and — for the bake — when the worker's canvas gets no renderer. The editor
page needs no extra headers for this (no SharedArrayBuffer is used). Numbers
(main-thread long tasks before and after) are in `docs/plan-phase-22.md` §5;
`tests/e2e/editor-workers.e2e.ts` measures them.
**Rendering (phase 21.3).**

- *Automatic instancing.* Play, exports and the Scene view draw repeated
  objects together: boxes, and the meshes of placed models, that share a
  geometry, a material and their shadow flags become one instanced draw
  (boxes of any size share one unit box scaled by their size; boxes with the
  same colour or surface values share one material). Nothing to set up and
  nothing changes in the picture: every object stays an object — selection,
  picking, the gizmo, bounds, bakes and per-object looks (the selection
  tint, a look override, a fade, a lightmap, per-object graph material
  parameters) work as before; an object with its own look is drawn on its
  own. A group needs at least four members; transparent, skinned and morphed
  objects are always drawn on their own; detailed geometry (256 triangles
  and up) is grouped per 64 m cell so off-screen parts are still culled.
  `?batching=off` on the editor, Play or export URL draws one object per
  draw call (for comparisons).
- *Instance sets* are drawn in chunks of about 2048 copies (at most 64 per
  set): chunks out of view are culled, and a model with levels of detail
  draws each chunk at the level its distance asks for (before, every level
  of every copy was drawn).
- *Render on demand.* The Scene view draws only when something changed: an
  edit, a camera move, a selection, an arriving model or texture, an
  animated material (wind, water) or a playing effect preview. Left alone it
  draws nothing (three's own animation-frame tick still runs, drawing
  nothing). After an edit it syncs only the objects the edit touched.
- *MSAA is the quality level's choice.* The environment's (or the player's)
  quality level decides: low draws without MSAA, medium and high with it
  (a post stack uses its own anti-aliasing instead). The Scene view follows
  the project's level with the editor lighting too, and Play applies a
  player's level also in projects without an environment.
- *Textures.* Decoded textures get mipmaps (three's default trilinear
  filtering); imported GLB files may carry KTX2/Basis textures (read by the
  importer and transcoded in the browser). Since 25.19 the backend encodes
  PNG/JPEG textures to KTX2 on import and (25.21) packs texture arrays; see
  "KTX2 textures".
- *What the view reports.* The Scene view's canvas carries `data-frames`
  (frames drawn), `data-draw-calls` and `data-triangles` (the last frame),
  `data-batches` (instanced groups, objects drawn through them, marked
  objects drawn alone), `data-msaa` (samples) and `data-sync` (what the last
  sync touched). Play's diagnostics (`tl_diagnostics`) carry `batching` and
  `frame` (draw calls, triangles); an export's canvas carries
  `data-tl-draws` and `data-tl-msaa`. The harness adds the Scene view's
  frames while idle and its draw calls while orbiting.

**Memory (phase 21.5).** What is opened and closed again gives its memory
back: an editor session with many tab, preview and Play round trips, and a
game that loads and unloads scenes or spawns and destroys objects for a long
time, stay at the memory they started with.

- *Closed tabs and previews* (the Material and Effect tabs' previews, the
  asset browser's model preview, the Animator's live preview) release their
  renderer at once — also the WebGL context or the WebGPU device (before,
  browsers kept up to ~16 WebGL contexts and then dropped the oldest, which
  could be the Scene view's) — and nothing keeps the closed pane reachable.
  Switching the renderer backend (the project setting) replaces the Scene
  view's canvas the same way.
- *Play stop and new Play snapshots* release the game's input listeners, its
  sound (the audio context, looping sounds, music) and the page listeners; the
  simulation worker ends with the play.
- *Scene unloads, level restarts and destroyed spawns* release their objects
  in the renderer (render objects, shadow maps, instancing buffers, per-object
  material copies of fades and look overrides) as well as the objects
  themselves; a project material's built copy goes with its last object.
- *The Scene view* releases what a closed editor scene or a removed object
  used (also lightmapped material copies) and the edit-mode effect preview's
  material holders.
- Three.js (0.186) itself keeps some GPU objects until the garbage collector
  finds them (WebGL programs, shaders and vertex arrays) or never frees them
  (a texture shared between renderers kept every renderer that drew it); the
  engine releases these explicitly through the renderer's internals of the
  pinned three version (guarded: another version would only lose the early
  release).

`tests/e2e/memory.e2e.ts` checks it: each document tab kind opened and closed
50×, the preview panes 50×, an editor scene closed and opened 50×, instancing
groups formed and dissolved 50×, the backend swapped 10×, Play started and
stopped 20×, and in one Play session an additive scene loaded and unloaded
50×, a level restarted 20× and ~100 spawned pairs destroyed — the JS heap
(after a garbage collection), the WebGL/WebGPU objects per live context and
the renderer's own counts come back to where they were. The Scene view's
canvas carries the renderer's counts in `data-memory`; Play's diagnostics
(`tl_diagnostics` renderer.gpu) carry the same counts. Run it after
`npm run build` with `TL_MEMORY=1 npx playwright test tests/e2e/memory.e2e.ts` (both
projects; 10–15 min on a CPU renderer; `[memory] …` lines print each
scenario's baseline and end counts); `TL_MEMORY_CYCLES=5` shortens it for a
quick smoke run. Without `TL_MEMORY=1` the spec is skipped (the full gate
sets it).

**Scale bench.** A project of a full game's size — 10,000 voice lines
(Ogg Opus, 1–15 s), 1,000 other sounds, 5,000 textures, 2,000 models, 5,000
prefabs, 2,000 materials, 300 scenes, 2,000 voiced dialogue lines — is
generated deterministically (`tools/perf/scale-generate.ts`) straight into the
backend's on-disk format, every file distinct and every asset record the one
the backend's own inspector makes from its bytes. The bench
(`tools/perf/scale.ts`) opens it with a real backend and the editor in
Chromium and measures the open, one command's latency (a scene edit and a
content edit), the Play start, 50 scenes loaded and unloaded one after
another (load times, heap, graphics objects, asset bytes read, the backend's
resident set), a 500-line voiced dialogue played through (each line's start
to its voice playing, and the silence between voices) and the export (time,
files, bytes, the exported page's first frame). It also checks the game
folder's files (`files`), drives the editor at that size (`editor`: open to
usable, a scroll through every tile, a picker search, a placement, a line's
voice, and the project window labelling and moving 1,000 files and undoing
both), loads the labelled assets through a script's handle and releases them
(`handles`), and, when named, imports a folder of new voice files (`import`)
and streams large KTX2 textures under a small budget (`stream`). The
renderer that drew Play is in the report. A step that cannot be taken
records why (a refused open, a Play build that fails).

```sh
npm run build
node tools/perf/run.mjs scale --preset full --gpu        # the full size (about 25 min today)
node tools/perf/run.mjs scale --preset small             # a few of each (seconds)
node tools/perf/run.mjs scale --factor 0.1 --lines 200   # the full size × 0.1
node tools/perf/scale-summary.mjs ~/.cache/thirdlight-perf/reports/scale-*.json
```

Presets: `full`, `caps` (every kind at the count caps engines before phase 26 had), `half-caps`,
`small`, `starter` (the Starter template, nothing generated). Options:
`--steps files,open,commands,editor,import,play,walk,handles,dialogue,stream,export`
(export last: it stops the backend), `--import N`, `--stream N --budget MB`,
`--walk N`, `--lines N`, `--commands N`, `--seed N`,
`--renderer webgl2|webgpu`, `--gpu`, `--keep`, `--out FILE`.
The generated project is kept under `~/.cache/thirdlight-perf/scale/<preset>/`
and copied for each run. `tests/e2e/scale-bench.e2e.ts` (in the fast gate)
runs every step at the small size. The measured numbers are in
`docs/plan-phase-26.md` §6.

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
tools/gate.sh fast [e2e files…]             # per change: build, vitest, smoke e2e + the named files (minutes)
tools/gate.sh full                          # everything incl. the leak test, before an item is done
tools/gate.sh rerun                         # only the tests that failed last time
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
in `default`, `webgpu` in `webgpu` (the `auto` variant only with
`TL_E2E_ALL_VARIANTS=1` where no WebGPU adapter exists, since it then draws
exactly like `webgl2`); `TL_E2E_WORKERS=<n>` runs spec files in parallel
(`tools/gate.sh` uses 3); the shader-parity and env-parity specs
compare every shader type and environment with its reference image (drawn
by the old WebGL renderer, frozen since phase 17.4) on WebGL 2 and on
WebGPU.

The browser tests need Playwright's Chromium (`npx playwright install
chromium`); on this LXC they use the library tree described in
`tests/e2e/browser-env.mjs`.

## Project UI (UI documents)

Projects draw their own HUDs, menus and screens as UI documents: JSON widget
trees stored in the project (`setUiDocument`, `setUiTheme` through MCP, or the
visual editor below). The game host draws them over the view in Play and in
exported games.

- Widgets: panel (anchors, pivot, offset, size or stretch), stack, grid, list
  (repeats a template for a bound array), text (rich text `[b] [i]
  [color=#…] [size=N] [icon=name]`, `{path}` values), image (texture,
  9-slice), bar (linear or radial), button, text input. Styles and themes are
  data (colours, project fonts, padding, borders, 9-slice backgrounds, hover /
  focus / pressed / disabled variants); tweens fade, slide, scale or "stamp".
- Scripts: `ctx.ui.set('hud.hp', 3)` publishes values the documents bind to
  (`{ "bind": "hud.hp" }`); `ctx.ui.show/hide` shows documents (layers,
  modal); `ctx.ui.events()` / `ctx.ui.event('buy')` read clicks, submits and
  focus changes — they arrive on the next input frame, so replays hold.
- Keyboard and gamepad move the focus (spatial or explicit `nav`), Enter / pad
  A presses, Backspace / pad B runs the document's cancel action; the mouse
  hovers and clicks. A focused document can switch the input to its action
  map (`actionMap: "ui"`: the character does not move while a menu is open).
- World-anchored widgets follow an entity or a point, clamped to the screen
  edge with an indicator when off screen.
- The game shell (`setShell`) shows documents as the title, pause,
  settings, controls, save and load screens and as HUDs; their buttons use
  engine actions (resume, quit to title, save, load, a setting…).
- Fonts (TTF, OTF, WOFF2, WOFF) import as `font` assets and are used by name
  in a style's `font`.
- Bound size and gauge angle (phase 25.22): each axis of a widget's `size`
  may be `{ "bind": "path" }` — the px number the view model holds (anything
  else sizes that axis to its content; a stretched axis keeps its stretch) —
  and a radial bar's `startAngle` may be bound the same way. In the UI editor,
  type a path into the size field's w or h box, or tick "bind" by Start angle.
- Engine limits: 48 KiB and 512 widgets per document (a document is saved
  in one 64 KiB command), a 64 KiB view model; as many documents and themes
  as the project needs.

## Game modes (phase 23.10)

A project defines game modes — named states of the running game such as
explore and tactical, on foot and driving, build and play, a photo mode or a
title screen. Edit them in the **Game modes** tab (the list, the selected
mode's form, the behavior groups) or with `setModes` / `setBehaviorGroups`
through MCP. The first mode is the one a run starts in.

- Each mode sets, together: the **input maps** that are active (gameplay, ui
  or maps the project adds in the Input tab — the actions of other maps read
  as released), the **camera** (a virtual camera that is live over the
  priorities while the mode is), the **UI documents** shown, the **behavior
  groups** whose scripts run (an object joins a group with its Behavior group
  component; the other groups pause; ungrouped scripts tick unless the mode
  says otherwise), whether the **engine pause** is allowed and the **pause
  screen** document, the **time scale** (0.1–4) and whether **physics**
  steps or holds. A transition may blend the camera (cut, linear, eased) and
  show a fade document for a moment.
- Switching: a script calls `ctx.modes.switch('tactical')` (it applies at the
  next step; `ctx.modes.events()` / `entered()` / `exited()` report the switch
  in that step), or a UI button runs `{ "do": "mode", "mode": "explore" }`.
  Nothing is loaded: the switch happens in one step and replays exactly.
- Pause: a game with modes pauses with the pause key when its mode allows
  it — the mode's pause screen document (buttons with the engine actions
  resume and restartLevel), the game shell's pause screen or the engine's
  small pause panel; a mode that does not allow the pause keeps it closed.
- Every game has the run lifecycle as script calls: `ctx.lifecycle.respawn(spawnId?)` puts the character at a
  Player spawn object (from rest), `setSpawn` picks the spawn respawns use,
  `restart()` starts the run over (objects at their authored place, scripts
  fresh, the start mode). What winning, losing or a death means is the
  game's own scripts.
- Play from a mode: "Play from…" / MCP `tl_play_start` `mode`; the Play
  toolbar shows the mode the running game is in; `tl_game_observe` reports
  `mode` and `paused`.
- Engine limits: 16 modes, 32 behavior groups, 8 project input maps.

### The UI document editor

- The **UI** tab of the bottom dock lists the UI documents and themes: create,
  rename, delete, open. **Assets → new UI document** creates one too.
- A document opens as a **UI: <name>** tab. Left: the widget hierarchy (add a
  widget of any type into the selected container, delete, move up/down,
  duplicate, move into another container — or drag a row onto a container).
  Centre: the live preview — the same game-host code Play uses — at 16:9, 4:3,
  21:9, portrait or the document's reference size, with a safe-area frame.
  Click selects; drag an anchored widget to move it, drag a grip to resize;
  it snaps to the parent's and siblings' edges and centres or to the grid
  (hold Alt to drag freely). Arrow keys nudge (Shift: 10 px), Delete removes,
  Ctrl+D duplicates.
- Right: the Inspector. **Widget**: anchor presets (they keep the widget where
  it is; Alt-click moves it onto the anchor), layout, container settings,
  text, image / 9-slice, bar, list, input, bindings (a value or a view-model
  path), styles, an own style, click / submit / focus actions, navigation and
  a world anchor. **Document**: its settings, cancel action, own styles,
  tweens (with a play button) and icons. **Theme**: the document's theme
  styles beside the preview (the **UI theme** tab edits a theme on its own).
  **Mock values**: a JSON object of view-model values (as scripts would set
  with `ctx.ui.set`) that the preview's bound bars, lists and texts show;
  "Fill from bindings" adds a sample for every bound path. Mock values stay
  in this browser; they are not project data.
- Every change is one command with undo/redo; a drag is one command when you
  let go.
- **Game shell** (bottom dock) picks the UI documents shown as the title,
  pause, settings, controls, save and load screens and as HUDs.

## Dialogue (phase 23.16)

Conversations with speakers, portraits, voice and choices, built into the
engine as project content; the game's own rules stay in its scripts.

- **Dialogue window** (bottom dock → Dialogue): *Conversations* (create,
  rename, delete, open), *Speakers* (name, name-plate colour, portraits per
  expression — texture assets —, default expression, voice profile id, text
  blip sound), *Settings* (text speed in characters/s, 0 = whole lines;
  auto-advance and its delay; how low music and effects go under a voice;
  backlog length; the UI document and theme of the dialogue box).
- **Dialogue tab** ("Dialogue: <name>"): the conversation is a node graph.
  Start → Lines (speaker, expression, text, voice clip — an audio asset of
  any length —, auto-advance default/on/off) → Choice → Options (text, condition,
  effects, once; top to bottom) → Branch (condition), Set (effects), Signal
  (name, value; *wait* holds until a script resumes), Wait (seconds), Jump
  (to another conversation or one of its named Entries), End. Select a node to
  edit it in the Inspector. Line text is rich text (`[b]`, `[i]`,
  `[color=#hex]`, `[icon=…]`), with `{variable}` / `{$binding}` values and
  `[pause=0.5]` pauses of the typewriter.
- **Conditions and effects**: dialogue variables, `$bindings` (values a
  script passes to `start`), numbers, `"texts"`, `true/false/null`, `! not`,
  `* / %`, `+ -`, `< <= > >=`, `== !=`, `&& and`, `|| or`, `seen("node")`.
  Effects: `served = true; cups += 1; gold -= 2`. A condition that does not
  parse is refused when you type it.
- **Previewer** (right of the graph): ▶ Play runs the conversation outside
  Play with the game's own dialogue box, portraits and voice — from Start, a
  named entry or the selected node, with starting variables as JSON. Click the
  box or press Enter/Space to advance, arrows + Enter to choose, Backspace for
  the log. The ▶ Play click also starts the sound (the browser's autoplay rule).
- **In the game**: a script starts a conversation with
  `ctx.dialogue.start('talk', { entry?, node?, bindings? })`. The engine runs
  it: the typewriter (an advance shows the rest of the line at once, the next
  advance goes on), the voice clip on the voice bus with music and effects
  ducked until it ends, auto-advance a moment after the voice (or the text),
  skip for lines already seen, the choices. Scripts also have `advance`,
  `choose`, `resume`, `stop`, `setSkip`, `setAuto`, `setTextSpeed`,
  `get/set` (dialogue variables), `seen`, `history`, `current`, and
  `events()` (line start/end, choice, chosen, signal, start, end — seen the
  step after). Visual scripts have the same as nodes (Dialogue category).
- **The dialogue box** is an engine UI document (`tl-dialogue`): portrait,
  name plate, typewriter text, choices, Auto / Skip / Log buttons and a log
  view. Reskin it with a UI theme (style names `dialogueBox`, `dialogueName`,
  `dialogueText`, `dialoguePortrait`, `dialogueChoice`, `dialogueButton`,
  `dialogueBacklog`, `dialogueBacklogName`, `dialogueBacklogText`) chosen in
  the settings, or use your own UI document: bind it to `dialogue.*`
  (`dialogue.line.text` with a text widget's `content` binding and
  `reveal: {bind: 'dialogue.line.reveal'}`, `dialogue.line.name`, `.portrait`,
  `.hasPortrait`, `dialogue.choices` [{index, text}], `dialogue.backlog`,
  `dialogue.showLine`, `dialogue.showChoices`, `dialogue.backlogOpen`, …) and
  give its buttons the action `{do: "dialogue", input: advance | choose |
  skip | auto | backlog}`. Your document with the id `tl-dialogue` replaces the
  engine's.
- **Saves**: the project save schema's opt-in section *dialogue* keeps the
  dialogue variables and the lines seen (skip-if-seen) in each save.
- **Tools**: `tl_game_observe` reports `dialogue` (the conversation, the
  line with its reveal and portrait, the choices, the backlog's tail, the
  modes) and the audio observation's `music.duck` / `sfxDuck`. MCP edits
  everything with `setDialogue`, `graphEdit` (owner kind `dialogue`),
  `setSpeaker`, `setDialogueSettings`.
- **Localization**: every line is addressed by `<dialogueId>.<nodeId>` (node
  ids are stable), the key a future string table uses; no table is read yet.
- Engine limits: 1,024 nodes per conversation, 32 portraits per speaker (as
  many conversations and speakers as the project needs), 1,024 characters a line, 256 dialogue variables, 8,192 seen
  lines, a 100-line backlog.
