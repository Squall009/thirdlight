# Deployment

Thirdlight runs as plain Node processes inside the owner's Proxmox LXC. No
containers, no reverse proxy required. Everything below is what the
repository actually does today; the commands are the ones the tests run.

## Requirements

- Node 22.15 or later in 22 (`engines.node` `^22.15.0`: zstd in `node:zlib` arrived in 22.15; the LXC has v22.22.1), git.
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

- `project.json`: id, name, engine version (schemaVersion 7; an older one
  is upgraded on open, see "Migration notes");
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

**Where new things go.** The folder chosen in the project
window (the dock's Project tab) (the upload folder's rules: inside the game folder, no hidden folder,
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
  browses, searches (`t:` / `l:`), labels and moves them (see [Assets](manual/features/assets.md)).
- **Import a folder** of any size in one command with labels on every file
  (**import folder…**, `importAssets`).
- **Labels and addresses** make assets and resources loadable by name:
  scripts load them with `ctx.assets.load(key)` and let them go with
  `ctx.assets.release(handle)` (see [Loading assets by name](manual/features/scripting.md#loading-assets-by-name-from-scripts)).
- **Audio is one kind** with a load type and preload per file (see [Audio](manual/features/audio.md)); nothing audio is read at start, and a conversation reads
  its voices a few lines ahead.
- **The game frees what it no longer uses**: each loaded file, model,
  texture, sound and font is held by the scenes, objects, sounds and handles
  that use it and freed when the last one goes (`resources` in
  `tl_game_observe` and Play diagnostics shows what is resident per kind).
- **Large textures stream** their mips inside the texture budget (see
  [Texture streaming](manual/features/assets.md#texture-streaming)).
- **Play and the export read what they need**: the runtime manifest is about
  2 KB at any size and points to a catalog read in parts (a scene load reads
  its scene and its dependency list); Play serves files from disk, the export
  copies them one at a time.
- One file's size and the runtime's memory are bounded; the number of
  assets and resources is not (see [Engine limits](manual/features/tuning.md#engine-limits-constants)).

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
  controller reads the actions it names (`moveAction`, `jumpAction`,
  `runAction` in 3D; defaults `move`, `jump`, `run`).
- **Local co-op**: any number of player controllers share the view (see
  "Several player controllers (local co-op)").
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

## The view, cameras and kept objects

The engine owns the view. A camera is a shot: a `virtualCamera` (GameObject
→ Cameras → Camera for a plain one; follow, orbit, top-down, rail and track
rigs as before) in any scene, any number of them. The view shows the enabled
camera with the highest priority (on a tie the one activated last); its
lens is the camera's own `fovY`/`near`/`far`, else the project's camera
settings (Gameplay → Camera: `camera_fov_deg` 60, `camera_near_m` 0.1,
`camera_far_m` 100). With no camera live the view holds a default pose
(1.6 m up, 6 m back along +Z, looking down −Z): Play and the export start
anyway and write one Problems line ("no camera is live when the game
starts"); the game's log warns whenever the view falls back to it.
Every view read is keyed by a view (`readCameraView(…, view)`): there is one
view today, so a second one (a split screen) is a new key.

Checked when the game starts (Play and the export), not per edit — each a
Problems line: no camera live (warning), a player in a scene the game does
not start with (warning: loading it is refused while the game runs), one id
kept loaded in two scenes (refused), Keep loaded under an object that is not
kept (warning). Any number of player controllers may start together; they
share the view (see "Several player controllers (local co-op)").

### Several player controllers (local co-op)

A scene may hold several objects with a Character controller. They share the
one view and each is a player: its own physics body (players pass through
each other and are never in the way of a ray or an overlap query), its own
input and its own state.

- **Input.** Each controller names the actions it reads — `moveAction`,
  `jumpAction`, `runAction` (3D), `climbAction` — so the second player reads
  `move_p2` and `jump_p2` (any names) bound to its own keys. A gamepad
  binding may name one pad: `pad` is the pad's slot (0 for the first pad the
  browser lists, up to 3; Project Settings → Input, "pad 1"…"pad 4"), so each
  player plays on a pad of their own; without `pad` a binding reads the pad
  used last, as a one-player game does.
- **Scripts.** Every call about "the player" names the controller's object
  and defaults to the first controller (the first in the scene's order), so
  a one-player game never names it: the intents `control_move`,
  `control_jump`, `character_move`, `character_place`, `character_enable`
  and `respawn` take `entityId` right after `kind`;
  `ctx.character.impulse(v, entityId?)`, `ctx.lifecycle.respawn(spawnId?,
  entityId?)`, `ctx.physics.characterState(entityId?)`,
  `ctx.physics.characterResult(entityId?)`, `ctx.game.health(entityId?)`.
  Visual-script nodes drive the first controller (their player input picks
  another where they have one).
- **Triggers, switches, pickups.** Every player takes part: a trigger's
  `enter`/`exit` events name the player (`by`), its signal fires when the
  first player enters and its exit signal when the last one leaves; a
  switch or a collectible reacts to any player (a collect event's `by` names
  who).
- **Placement.** A scene transition's arrival, a listed scene's spawn (each
  kept player) and a run restart place every player; a respawn or a
  `character_place` places the one it names.
- **Saves.** The save's `world.character` is the first player's place;
  `world.characters` keeps the others by their object (an older save has
  none: they stay where they are).
- **Observation.** `tl_game_observe` (and the export's
  `window.__thirdlightObserve`) add `players` [{id, x, y, z}] when there are
  several; `player` stays the first one's.
- A player's physics body is made when the game starts, so a scene loaded
  later or a spawned copy cannot bring one (the `player_scene` warning):
  put every player in a start scene and keep it loaded.

**Upgrade (schemaVersion 7, on open).** A project's scene `camera` entity
becomes a fixed virtual camera at the lowest priority, where it was placed
(the view whenever no other camera is live, as before); its lens becomes the
project's camera settings where it was not the default. The camera and the
player (each start scene's controller) were never unloaded before, so the
object at the top of each one's hierarchy gets **Keep loaded**. A game with a
camera entity in a start scene, or a title scene holding the camera and the
player, plays as it did; clear Keep loaded to let them go with their scene.
A 3D character moves as it did: a 3D project without any virtual camera
moved along the world axes, so the upgrade sets each controller's **Move
relative to** to **World axes** (`moveFrame: "world"`); a project with virtual
cameras keeps **Camera**, as they turned the input before. Only where such a
project's old scene camera, turned about Y, is the one live shot does the
input now follow its heading; the upgrade notes name that camera.

Scripts: `ctx.spawn(prefab, {position, keepLoaded: true})` spawns a kept
copy; `ctx.entity(id).set('object', {keepLoaded})` keeps an object (and its
children) or lets it go (refused for an object under a kept parent, and for
a kept object whose scene is not loaded); `get('object').keepLoaded` reads
it. A save's world (an opt-in section, see "Saves") never destroys a kept
object; the engine saves nothing for them — a game fills them in from its
own save data.

## Scenes

A project has one or more scenes, one file each. Entity ids are
unique across the whole project. One command edits one scene.

- **Start scenes.** The game starts with the scenes in the start set,
  merged. The player (the controller) is made when the game starts, so it
  is in a start scene; cameras and spawns may be in any scene.
- **New objects** go into the scene the editor has active (or their
  parent's). Over the API `createEntity`, `createEntities`,
  `instantiatePrefab` and `pasteEntities` need a `sceneId` or a `parentId`:
  there is no default scene.
- **Moving between scenes**: drag objects onto another scene's header or
  rows in the hierarchy, or `moveEntities {entityIds, parentId, beforeId?,
  sceneId}`: they move with their children into that scene, ids (and so
  every reference to them) and world positions kept, one undo for both
  scene files.
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
  - `reload(sceneId)` puts a loaded scene back as authored at the next
    boundary: its objects return where they were authored (where it was
    loaded with `at`), the copies its objects' scripts spawned go, its
    scripts start over (disposed and made again, as at the start: no
    `onDisable`/`onDestroy`, `onEnable` again), its sounds stop. Kept
    objects (their scripts too), `ctx.save`, the counters and the other
    scenes stay as they are; a kept player arrives at the scene's listed
    spawn as on a load. An unloaded scene loads; a scene being loaded is
    left to arrive. Like `unload`, it is refused for a scene holding a
    player that is not kept loaded. A UI button does the same with the
    engine action `{do: "engine", action: "reloadScene", scene?}` (absent
    scene: the active one); `{do: "engine", action: "loadScene", scene}` and
    `{do: "engine", action: "unloadScene", scene}` are `load` and `unload`
    for a button (refusals are logged like a script's).
  - `status(sceneId)` returns `unloaded`, `loading` or `loaded`.
  - `loaded()` lists the loaded scenes.
  - A loaded scene brings its colliders, script instances, tags and triggers.
    An unload releases them: colliders leave the physics world, scripts get
    `dispose`, meshes and textures are freed, and a model no loaded object
    uses any more is released.
  - Kept objects (Keep loaded) stay when their scene unloads: they belong to
    no scene from then on (as spawned copies), and loading their scene
    again does not bring a second copy. A kept object's reference to an
    object of a scene that went reads as empty (one Problems line per Play).
    The player is the one object that cannot go: a scene holding a player
    that is not kept does not unload. When a scene of the shell's scene
    list loads, however it was loaded, a kept player arrives at that
    entry's spawn (a transition or the list naming its own spawn wins).
  - A replay returns to the start scenes. A start scene unloaded and
    loaded again takes its kept objects back, so a replay keeps them.
- **Scene transitions**: a trigger's scene transition loads and unloads
  scenes when the character enters it and can name a spawn it arrives at
  (see "Scene transitions, impulses, …").
- **Game rules in scripts.** There are no level bounds or kill heights any
  more.
  - `ctx.world.transform(entityId)` reads any loaded object's position,
    rotation and scale this step, local to its parent (as the Inspector
    shows them; for an object without a parent that is its world
    transform). `ctx.world.worldTransform(entityId)` (or
    `transform(entityId, {space: 'world'})`) composes them up the parents:
    where the object is drawn. Under a parent scaled unevenly and turned,
    its scale is the length of each world axis (Unity's `lossyScale`).
  - `ctx.lifecycle.respawn(spawnId?)` puts the character back at a spawn.
  - `ctx.emit({kind: 'pose', entityId, rotation: {yaw, pitch, roll}, scale})`
    (transform phase, an entity the script owns; degrees, applied yaw then
    pitch then roll; `scale` is a number or `[x, y, z]`; either may be left
    out) turns or scales it — a spinning sign, a pulsing light. It is visual:
    colliders keep their shape.
  - A call the runtime refuses does not stop the run: `ctx.emit` returns
    false for a refused intent (a bad value, the wrong phase, an entity the
    script does not own, a second write of a channel in one step) and
    `ctx.debug.command` answers no calls for a refused declaration; each
    refusal is one Console line. `ctx.game.add` refuses (false, one line) a
    counter name a save cannot keep (a letter or _, then up to 31 letters,
    digits or _); a save holding such a name still loads the rest.
  - Play diagnostics (the Console, `tl_diagnostics`) fit 16 KiB: a long
    run's report drops its oldest log entries first and says how many
    (`trimmed.logEntries`). `physicsPenetrationCorrectedCount` counts steps
    the 3D character began inside a collider; `physicsDeepestOverlap` names
    the deepest one's entity pair.
  - Camera bounds are optional (Gameplay → Camera → "Keep the camera
    inside bounds").
- **Play and export** ship every scene file and load the others on demand.
  An exported game needs nothing else.
- **MCP.**
  - `tl_command createScene {name, sceneId?}`, `renameScene`,
    `deleteScene` (only an empty scene), `setStartScenes {sceneIds}`.
  - `createEntity`/`instantiatePrefab` take `sceneId` (or a parent: a
    create with neither is refused). `createEntity` takes every component
    `setComponent` adds, except those its `kind` makes (box, model).
  - `tl_inspect target="entities"` takes `sceneId` and names every entity's
    scene; `target="project"` lists the scenes.
  - `tl_game_control` takes `loadScene`/`unloadScene` with `sceneId`.
  - The game observation lists the loaded scenes.

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

`tl_screenshot` draws the game's UI (documents, fades, the pause panel,
overlays) over the frame; `ui: false` (also on the HTTP route) gives the
frame alone. It always answers: a capture the preview cannot make comes back
as `relay_failed` with the preview's code in `cause` (`screenshot_failed`,
`render_failed`, `not_ready`) and its reason in the message. A PNG over the
1 MiB bound is captured again at a smaller width; the reply's `width` says
which. It works the same on the WebGPU and WebGL 2 renderers.

`tl_game_control` `replay` answers once the restart is applied: `runId` is
the new run (`<snapshotId>#<run>`, the run counting every restart of the
play) and `restart {state: "applied", atStep}`. When the game takes no step
within half the relay's timeout (paused, held by the debugger, a
busy page), it answers `restart {state: "pending"}` with the run id the
restart will have; the restart still applies at the next step, and
`tl_game_observe`'s `runId` shows it.

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

Importing FBX needs Blender on the server: `THIRDLIGHT_BLENDER` (default
`blender` on `PATH`; this LXC has Blender 5.2.2 in `/usr/local/bin`, which the
systemd unit's default `PATH` includes). How assets are stored, imported and
streamed: [Assets](manual/features/assets.md).

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

## Input actions

The game reads named **actions**, not keys (File → Project Settings… → Input): `move`
(A/D, ←/→, D-pad, left stick), `jump` (Space, pad A), `attack` (J, pad X),
`interact` (E, pad Y), and for menus `pause` (Esc, Start), `submit` (Enter,
pad A), `cancel` (Backspace, pad B), `navigate` (arrows/WASD, stick). "+ key"
listens for the next key (an axis asks for two or four keys), "+ pad" for
the next gamepad button; × removes a binding; new actions can be added. The
first edit makes the controls the project's own; "Reset to defaults" goes
back. The character controller moves and jumps with the actions it names
(`moveAction`, `jumpAction`; defaults the `move` and `jump` bindings; each
player of a co-op game names its own):
their keys, and their pad buttons and stick axis (`jump`'s pad buttons,
`move`'s button pair and axis; a part with no pad binding of its kind keeps
the standard layout — A jumps, D-pad and left stick move). Players rebind
the pad on the game shell's Controls screen (see "The game shell"). Scripts read
`ctx.input.value(name)`, `.vector(name)`, `.pressed(name)`, `.held(name)`,
`.released(name)`; the actions are part of the recorded input, so replays
match. `ctx.input.anyPressed()` answers any key, mouse or pad button that
went down this step, bound to an action or not — `{device, code}` (device
`keyboard`, `mouse` or `gamepad`; code a key's `KeyboardEvent.code` such as
`KeyK`, `left`/`right`/`middle`, or `button0`…`button31` of any standard
pad) or null: a "press any key" prompt. MCP: `setInput {input}` through `tl_command`; `tl_input_exercise`
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
  it (`ctx.events`; `by` names the player that entered or left).
- **Character impulse**: `ctx.character.impulse([x, y, z], entityId?)` adds a velocity
  (m/s) at a player's next move (a push, a launch, a bounce; up lifts it
  off the ground; the 2D plane ignores z; absent id: the first player).
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
- **Event sounds** (Project Settings → Audio): rows that play a sound when a **signal** is
  sent (by name) or an **event** happens (`enter`, `exit`, `collected`,
  `damaged`, `died`, `contact`, … or an animator clip event's name;
  optionally only one object's), at a volume on a bus. The export carries
  their sounds. MCP: `setEventCues {cues}`.

### The game shell: menus and HUD as UI documents (phase 24.4j)

The **Game shell** tab (MCP: `setShell {shell}`) draws
the menus and HUD with the project's own UI documents (make them in the UI
tab):

- **Screens**: **Title** (shown before play; the game waits behind it),
  **Pause** (Escape / pad Start; absent: the engine's pause panel, Resume only),
  **Settings**, **Controls** (rebinding), **Save** and **Load**. Their buttons
  use engine actions: `resume` (from the title too: it starts play), `reloadScene`, `continue` (the newest save),
  `back`, `open` (a screen), `save` / `load` (slot 1–3, the project saves of
  Project Settings → Saves), `setSetting`, `rebind`, `nextScene`,
  `loadScene` / `unloadScene` (a scene), and the deprecated `quitToTitle`
  (see "Migration notes").
- **HUD**: documents shown while the game plays. Bindings read
  `$flow.counters.<name>` (named counters: collectibles, scripts),
  `$flow.health.<objectId>.current|max`, `$flow.prompts` (made from the
  project's input actions, e.g. "A/D move x · E interact"), `$flow.shell`
  (screen, scene, `canContinue`, `saves.<n>.label`, `note`) and script values
  (`ctx.ui.set`).
- **Scene list**: the game's scenes in order, each with the spawn it starts
  at (a new game the game builds starts at the first; the deprecated `newGame`
  action restarts the run there, see "Migration notes"); **Next scene** loads the next
  and moves the character to its spawn.
- **Pause allowed**, and a debug **Status line** (screen, scene, prompts).

A save from the shell includes the named counters in the `components`
section and, since save format version 2, which scenes are loaded and where
the character stands. `tl_game_observe` reports `shell {screen, scene, hud,
note}`.

## Saves

Saves are the project's own (below): the game shell's Save and Load screens
and scripts write and read project save slots in the player's browser. The
level flow's autosave, its three slots and its checkpoint saves went with
the flow in phase 24.7. Play keeps its saves apart from exported games (and
each project apart from the others); **Saves → Clear Play save** forgets
Play's (MCP: `tl_game_control` `clearSave`).

**Where the play stands (`world`).** A save can also carry the loaded
scenes, the active spawn, the scene-list entry and the character's position,
velocity and facing (`world`, save format version 2). Loading such a save
unloads the scenes it did not have (never a kept object: those stay), loads
the ones it had, and puts the character back where it stood (from rest, its
velocity given back at its next move). Because that decides where a game
stands after Continue, `world` is an **opt-in section**: list it in the
schema's sections (**Where the play stands**), or set `legacyWorld: false`
(the Saves tab's *restore scenes in the game*) and restore scenes and the
player from the game's own document (`ctx.scenes.load`, `character_place`
with `facing`). A schema that does neither keeps the always-on world of
before, with one Problems line per Play (see "Migration notes"); a new save
schema starts with `legacyWorld: false`. A game that does not keep `world`
writes none and loads any save — one with a world too — without a scene
change. A version 1 save (no `world`) still loads; a save whose world names
a scene the game does not have is refused.

### Project save documents (phase 23.19)

Any game can declare its own save format in
Project Settings → **Saves** (MCP: `setSaveSchema {schema | null}`):

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
  `ctx.environment`; phase 23.18), *where the play stands* (`world`, above).
  A section the schema includes but a save lacks is reset to the run's start
  on load (a missing world leaves the scenes as they are).
- **Slot picture**: size and format (default 256 × 144 JPEG; at most
  512 px a side and 64 KiB).
- **Settings document**: fields (bool, number, string, choice) with
  defaults, which the game's own settings screen writes with
  `ctx.saves.setSetting(key, value)` and reads with `ctx.saves.setting(key)`.
  A field may drive an engine setting — music, sound or menu volume (a 0–1
  number) or quality (a choice of the project's quality level ids: low/medium/high unless it lists its own) — which applies at once.
  It is kept in the player's browser (localStorage, per project) and the
  game starts with it.

Scripts build the document themselves: `ctx.saves.write(doc)` / `read()`
(any JSON, at most **1 MiB per slot** with its sections), `save(slot, {title,
chapter, location, thumbnail, meta})`, `load(slot)`, `delete(slot)`, `slots()` (title,
chapter, location, play time, when, version, size, picture, `meta`), `ready()`,
`results()` (the outcomes, one step after storage answers), `playSeconds()`.
A save is taken at the end of the step it was asked for; a loaded save is
restored at the end of the step storage's answer arrives, so every host (the
page, the simulation worker, a replay) restores it at the same step —
storage's answers are part of the recorded input. `meta` is the game's own
small record for a slot card (a party leader, a portrait id, a difficulty):
names (letters, digits, _; up to 32 characters, so a load screen binds them
as `$item.meta.<name>`) to texts, as many as fit in **4 KiB** for the whole
record as JSON (UTF-8 bytes; `SAVE_LIMITS.metaBytes`, read for every slot
when the slots are listed); a record over it is refused (`save()` answers
false). `slots()` gives `{}` for a slot saved without one. In a 3D project the save's `world.character` also keeps the
character's facing (degrees), and a load turns it back (older saves without
it leave it as it is). A UI `image` widget shows a slot's picture with
`saveSlot` (a slot number, or a binding to one such as `$item.slot` on a
load screen's list) in place of `image`; nothing while the slot has none, a
new picture as soon as the slot is saved again.

Slots live in the browser's IndexedDB for the game's site (localStorage's
~5 MB per site could not hold 99 slots of 1 MiB): database
`thirdlight-saves`, keys `<ns>:slot:<n>:meta`, `:body` and `:thumb`, where
`<ns>` is `thirdlight:<projectId>` in an export and
`thirdlight-play:<projectId>` in Play, so Play, exported games and each
project keep separate ones; the settings document is in localStorage under
`<ns>:project-settings`. An export needs no backend. A slot's metadata,
body and picture are written (and deleted) in **one transaction**: a save
the browser refuses or a page closed while it writes leaves the slot's
previous save whole, never a slot the checksum calls damaged.

A refused write is a clear result for the game's own message: the outcome
in `results()` is `{ok: false, code, reason}`, `reason` the browser's text
and `code` one of `storage_full` (the disk or the site's quota is full),
`storage_unavailable` (the page has no IndexedDB — storage turned off, some
private windows — so nothing can be saved; reads find no slots) or
`storage_failed` (anything else, such as a write cut off). A settings
document localStorage refuses is reported the same way, as a result
`{op: 'settings', slot: 0, ok: false, code, reason}`; the value still applies
for the session (the game shell's own volumes and the player's key
bindings are logged instead). At the first save the host asks the browser to
keep the site's data under disk pressure (`navigator.storage.persist()`;
some browsers ask the player, others decide silently); `ctx.saves.storage()`
gives `{persisted, usage, quota}` (bytes from `navigator.storage.estimate()`,
refreshed after each save; null where the browser does not say).

`tl_game_observe` (and an export's `__thirdlightObserve()`) report `saves
{slotCount, storage (indexeddb, memory or unavailable), persisted, usage,
quota, persistAsked, slots (the first 32 used, with their picture's type and
size), settings}`, and Play diagnostics `saves {storage, persistAsked,
persisted, usage, quota}`; the page exposes a slot's picture as
`__thirdlightSaveThumbnail(slot)` (a data URL).
`tl_play_start` also takes a project save document (`{format:
"thirdlight.save", version, playSeconds?, doc, sections?}`, loaded at the
first step and migrated) or `saveSlot` 1–99 (a project slot of the Play page).

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

A **timeline** is project content (the project window: Create →
**Timeline**, double-click to open, delete from the Inspector; one undo step each) that sequences what a cutscene or a
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
- **Material swap** — from the key on, the target's slots wear other
  project materials (`materials: { slot: materialId | null }`, `null` the
  authored one), as `set('materials', …)`; the material ships because the
  key names it, and shows once it has loaded. Skip applies the remaining
  keys in order.
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

**Editor.** Open a timeline in the editor window (it plays on its scene in the preview pane): the timeline's fields and
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
  `hold` time (seconds) in Project Settings → Input.
- **One pad**: a gamepad binding may name a pad (`pad`, its slot 0–3) — each
  player of a local co-op game on a pad of their own; absent: the pad used last.
- **Glyphs**: the engine has a neutral SVG icon set (key caps, face buttons by
  position, bumpers/triggers, D-pad, sticks, mouse buttons); pad labels follow
  the pad family (Xbox, PlayStation, Switch, generic) detected from the pad.
  Projects replace icons with their own textures in Project Settings → Input's Glyphs
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

## Migration notes

### Opening a project with this engine (schemaVersion 7)

Opening a project of schemaVersion 6 or older upgrades it on open and writes
it back as 7 (Problems notes it once, `project_upgraded`, naming what
changed). Commit what it wrote. The upgrade:

- turns each scene `camera` entity into a fixed `virtualCamera` shot at the
  lowest priority (−1000), where it was placed: the view whenever no other
  camera is live, as before. A lens that was not the default becomes the
  project's camera settings (`camera_fov_deg`, `camera_near_m`,
  `camera_far_m`); a camera's own lens wins over them;
- marks the camera and each start scene's player (the object at the top of
  each one's hierarchy) **Keep loaded** (`keepLoaded`): the engine never
  unloaded them before. A title scene holding the camera and the player, or
  a camera in a start scene, plays as it did; clear the flag to let them go
  with their scene;
- writes `moveFrame: "world"` on every controller (scenes and prefabs) of a
  3D project without any virtual camera, which moved along the world axes; a
  project with virtual cameras keeps `view` (input relative to the live
  shot). Only where its old scene camera, turned about Y, is the one live
  shot does the input change; the upgrade note names that camera.

Nothing else changes: ids, recorded commands and replays stay valid. New in
the format and additive (no upgrade step): `keepLoaded` on any object,
`ctx.scenes.reload`, the `reloadScene` UI action, a save schema's `world`
section and `legacyWorld`, and the rest of this phase's fields.

### Problems lines a game may see after the upgrade

Each is one line per Play in Problems (the start checks are also the
export's `warnings` or its refusal):

- `deprecated_restart_level`, `deprecated_new_game`,
  `deprecated_quit_to_title`, `deprecated_lifecycle_restart`: the run
  restart, below;
- `deprecated_save_world`: the always-on `world` in saves, below;
- at the start of Play and the export (see "The view, cameras and kept
  objects"): `view_missing` (no camera live: the default pose is drawn),
  `player_scene` (a player in a scene the game does not start with; the
  one-player-per-view `player_count` refusal is gone: players share the view), `kept_ignored` (Keep loaded under an object that is not kept),
  `kept_twice` (one id kept in two scenes: refused);
- while it runs: `kept_reference_unloaded` (a kept object names an object of
  a scene that unloaded: the reference reads as empty).

### The run restart and the engine's new game (deprecated)

The engine does not know what a level restart or a new game is: that is the
game's own flow. These keep working for now and are removed once no game uses
them; each use writes one Problems line per Play naming its replacement:

- **`restartLevel`** (UI engine action) restarts the whole run: the start
  scenes, every object as authored, every script fresh, the start mode, every
  script sound stopped; `ctx.save` values stay. Use **`reloadScene`** (or
  `ctx.scenes.reload(sceneId)` in a script) for the scene that starts over,
  and reset what the game keeps itself (its counters, its `ctx.save` values,
  a kept player's place: `ctx.lifecycle.respawn` or the scene list's spawn).
- **`newGame`** (UI engine action; also a title without a focusable button
  on submit) restarts the run and goes to the scene list's first entry.
- **`quitToTitle`** (UI engine action) restarts the run and shows the
  shell's title screen. A game's title is its own: a title scene (and its
  own title document) it goes to with the scene API — a button with
  `[{do: "engine", action: "loadScene", scene: "title"}, {do: "engine",
  action: "unloadScene", scene: "level-1"}]`, or `ctx.scenes.load("title",
  {unload: [...]})` from its director answering a UI event — plus whatever
  it resets of its own. The run goes on; nothing restarts.
- **`ctx.lifecycle.restart()`** restarts the run like `restartLevel`.
- The engine's pause panel no longer offers Restart (Resume only); a game
  that wants one shows its own pause document.

The pattern for a new game is the one Skyforge Tactics builds in script: no
engine new game, a director script that owns the flow. Its title is a game
mode (or a UI document) whose button raises a UI event (`{do: "event", name:
"new-game"}`, plus `{do: "engine", action: "resume"}` when it is the shell's
title screen); the director answers the event: it resets the counters and
`ctx.save` values the game uses, unloads the scenes of the old run
(`ctx.scenes.unload`), loads the first scene (`ctx.scenes.load`, or
`ctx.scenes.reload` for one that is already in), places the kept player
(`ctx.lifecycle.respawn`, or the scene list's spawn on load), stops its own
music (`ctx.audio.stopAll`) and switches to the play mode
(`ctx.modes.switch`). Quit to title is the same in reverse. A level restart is
a `reloadScene` button (or `ctx.scenes.reload` from the director) plus
whatever the game resets of its own.

### The always-on `world` in saves (deprecated)

Every save used to carry where the play stands and every load moved the game
there. It is now the save section `world`. A save schema that neither lists
it nor sets `legacyWorld: false` keeps the old behaviour for now, and its
first save or load in a Play writes one Problems line
(`deprecated_save_world`). To move on, either:

- list `world` in the schema's sections (Saves tab: **Where the play
  stands**) — the same behaviour, without the line; or
- set `legacyWorld: false` (Saves tab: *restore scenes in the game*) and
  restore the game's place yourself: keep the scenes and the player's place
  in the save document (`ctx.saves.write`), and after a load
  (`ctx.saves.results()` has the load) call `ctx.scenes.load` /
  `ctx.scenes.unload` for the scenes and `character_place` with `facing`
  for the player. Kept objects are the game's to fill in either way.

Saves written before load in both cases: a game without `world` ignores a
save's world. The default changes (no `world` unless listed) once no game
relies on it.

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
  9-slice, or a save slot's picture: `saveSlot`), bar (linear or radial), button, text input. Styles and themes are
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
- Bindable placement: each axis of `offset`, `opacity` (0–1, multiplied
  with the style's and a fade, like Unity's CanvasGroup alpha) and
  `rotation` (degrees about the pivot, ±3,600) may be a number or
  `{ "bind": "path" }`.
- Scale with the view (`scale {reference: [w, h], mode}`): `fit`, `width`,
  `height`, `cover` (fills the view, cropping the reference) or `expand`
  (fits the reference and grows the box to the view's shape, Unity's
  CanvasScaler expand). `ctx.ui.view()` and `$flow.view` read the view the
  UI is drawn over, `{width, height, aspect, pixelRatio}` (presentation: not
  in the digest or a save; 1280 × 720 at 1 until the host reports one).
- Lists keep their item widgets (and the focus) when only the items' values
  change: by index, or by one field of each item named in `itemKey`; a
  focused item that goes passes the focus to the item now at its index.
  `ctx.ui.focus(doc, widget, index)` focuses a list's item.
- Sounds: `sounds {click, hover, focus}` (audio assets) on a widget, a style
  (its base) and the document (the default for every widget that takes the
  pointer or the focus), played on the `ui` bus. Click plays on any use
  (engine actions too), hover when the pointer comes over an enabled widget,
  focus when the keyboard, a gamepad or a script moves the focus.
- A shell screen may let scripts run under it: `shell.simulate {title:
  "scripts"}` (Game shell → *While shown*) steps the scripts outside behavior
  groups while physics and grouped scripts hold (default `pause`).
- Engine limits: 48 KiB and 512 widgets per document (a document is saved
  in one 64 KiB command), a 64 KiB view model; as many documents and themes
  as the project needs.

## Game modes (phase 23.10)

A project defines game modes — named states of the running game such as
explore and tactical, on foot and driving, build and play, a photo mode or a
title screen. Edit them in Project Settings → **Game modes** (the list, the selected
mode's form, the behavior groups) or with `setModes` / `setBehaviorGroups`
through MCP. The first mode is the one a run starts in.

- Each mode sets, together: the **input maps** that are active (gameplay, ui
  or maps the project adds in Project Settings → Input — the actions of other maps read
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
  resume, reloadScene or the game's own events), the game shell's pause screen or the engine's
  small pause panel; a mode that does not allow the pause keeps it closed.
- Every game has these lifecycle calls: `ctx.lifecycle.respawn(spawnId?)` puts the character at a
  Player spawn object (from rest), `setSpawn` picks the spawn respawns use
  (`restart()` is deprecated: see "Migration notes"; `ctx.scenes.reload`
  puts a scene back as authored). What winning, losing or a death means is the
  game's own scripts.
- Play from a mode: "Play from…" / MCP `tl_play_start` `mode`; the Play
  toolbar shows the mode the running game is in; `tl_game_observe` reports
  `mode` and `paused`.
- Engine limits: 16 modes, 32 behavior groups, 8 project input maps.

### The UI document editor

- The project window lists the UI documents and themes (`t:ui`, `t:uitheme`):
  Create → **UI document** / **UI theme**, rename in the editor's header,
  delete from the Inspector, double-click to open.
- A document opens in the editor window as a **UI: <name>** tab. Left: the widget hierarchy (add a
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
- **Game shell** (Project Settings → Game shell) picks the UI documents shown as the title,
  pause, settings, controls, save and load screens and as HUDs.

## Dialogue (phase 23.16)

Conversations with speakers, portraits, voice and choices, built into the
engine as project content; the game's own rules stay in its scripts.

- **Conversations** are made in the project window (Create → **Dialogue**),
  renamed in the editor's header, deleted from the Inspector, opened with a
  double-click. **Project Settings → Dialogue** holds the *Speakers* (name, name-plate colour, portraits per
  expression — texture assets —, default expression, voice profile id, text
  blip sound), *Settings* (text speed in characters/s, 0 = whole lines;
  auto-advance and its delay; how low music and effects go under a voice;
  backlog length; the UI document and theme of the dialogue box).
- **Dialogue editor** (the editor window's "Dialogue: <name>" tab): the conversation is a node graph.
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
