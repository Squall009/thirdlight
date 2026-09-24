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
controllers** (bottom dock → Animator): parameters (float, int, bool,
trigger), states that play a clip or a 1D blend tree, transitions with
conditions, crossfade and exit time, an entry state, and clip events. Right
click the graph to add states, right click a state to start a transition or
make it the entry state; drag states to arrange them. "New from clips:
Platformer" builds idle/run/jump/fall/land states from a model's clips. The
Inspector's **animator** field puts a controller on a model object.

The game steps animators with the simulation (deterministic; a replay looks
the same). An animator on the player (or on a model under the player) gets
`speed` (horizontal m/s), `grounded`, `velocityY` and a `landed` trigger
automatically, when its controller defines them. Scripts use
`ctx.animator(entityId)?.set(name, value)`, `.trigger(name)`, `.state()`;
clip events of the previous step are in `ctx.events`. MCP: `setAnimator` /
`deleteAnimator` through `tl_command`; `tl_game_observe` reports each
animator's current state.

## Input actions

The game reads named **actions**, not keys (bottom dock → Input): `move`
(A/D, ←/→, D-pad, left stick), `jump` (Space, pad A), `attack` (J, pad X),
`interact` (E, pad Y), and for menus `pause` (Esc, Start), `submit` (Enter,
pad A), `cancel` (Backspace, pad B), `navigate` (arrows/WASD, stick). "+ key"
listens for the next key (an axis asks for two or four keys), "+ pad" for
the next gamepad button; × removes a binding; new actions can be added. The
first edit makes the controls the project's own; "Reset to defaults" goes
back. The platformer moves and jumps with the `move` and `jump` keys (its
gamepad controls stay the standard ones). Scripts read
`ctx.input.value(name)`, `.vector(name)`, `.pressed(name)`, `.held(name)`,
`.released(name)`; the actions are part of the recorded input, so replays
match. MCP: `setInput {input}` through `tl_command`; `tl_input_exercise`
frames may carry `actions: {name: {v, p}}`.

## Gameplay blocks

GameObject → Gameplay places ready-made pieces (v4 projects): a moving
platform, a one-way platform, a switch, a door (opens on the signal `open`),
a coin, an enemy and a trigger. Any object can get these in the Inspector
under Gameplay ("+ Add gameplay component"):

- **Mover** — a path of offsets from where the object stands (`x y z; x y z`),
  speed, ping-pong / loop / once, a wait at each stop, smooth easing, and
  "waits for signal" (a door or a lift that starts when a switch or trigger
  fires). With a box collider it carries the player standing on it and
  pushes a player it moves into. The Scene view draws its path.
- **Trigger** — an area that sends a signal when the player enters it.
- **Switch** — `interact` (the interact action while inside) or `stand`
  (a pressure plate); sends a signal.
- **Health** — on the player: max health and invulnerability after a hit.
  Without it an enemy touch or a hazard is a death, as before.
- **Pickup** — coin, gem, heart (heals), extra life, key or a custom counter;
  collected pickups disappear; "comes back" on death if wanted.
- **Enemy** — walks between two x offsets or until a ledge/wall, hurts on
  contact, can be defeated by jumping on it (the player bounces).
- A collider's **one-way** flag: jump up through it, land on it from above,
  Down + Jump drops through. A hazard zone's **damage** takes health instead
  of a life.

The HUD shows the counters and health ("Coins 2 · Health 3/3").
`tl_game_observe` reports `counters` and `health`. Scripts use
`ctx.signals.emit(name)` / `.on(name)` (seen the next step),
`ctx.game.counter(name)` / `.add(name, n)` / `.health()`, and
`ctx.physics.raycast(origin, direction, maxDistance)` (32 per step).

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
  music and sound volumes.

In the game: Esc (or the pad's Start) pauses — *Resume*, *Restart level*,
*Settings*, *Quit to title*. Arrow keys / W-S / D-pad move through a menu,
Enter or pad A chooses, left/right change a volume. **Settings** has music
and sound volume, quality (low/medium/high) and the jump/attack/interact
keys (choose one, press the new key). Reaching a goal shows *Level
complete* (time, counters, deaths) and goes on to the next level; after the
last one the end screen shows the totals and credits.

**Music** assets are Ogg (Vorbis or Opus) or MP3 files, up to 10 minutes and
16 MB (import them like other assets; a long WAV can be imported with kind
`music` through MCP). Music starts with the first key press or click (the
browser's sound rule), loops, and crossfades between the title and the
levels. `tl_game_observe` reports `flow` (screen, level, lives, music, its
volume) and `loops` (each audio source's current gain).

Inspector → Gameplay → **Audio source** loops an audio or music asset where
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
Settings (volumes, quality, rebound keys) are saved as soon as they change.
Each save is versioned, checksummed and at most 64 KB; a damaged one is
named on the title screen and ignored. Play keeps its saves apart from
exported games (and each project apart from the others); **Game flow →
Clear Play save** forgets Play's (MCP: `tl_game_control` `clearSave`).

## Icons and gizmos

The Scene view and the hierarchy show what an object is: its light type
(directional, ambient, point, spot, hemisphere), a fog volume, an audio
source, a gameplay piece (mover or door, switch, trigger, pickup, enemy) or
a player spawn. The **Gizmos** menu turns the helpers on and off: icons,
light ranges (point spheres, spot cones), **collider outlines** (every box
and polygon collider on the game plane — a kit piece's `_COL` shape too;
one-way platforms in a softer green), and gameplay paths and areas. A mover's
waypoints are white handles: drag one to move that stop (one undo step;
snapping applies).

Inspector → Gameplay → **Face movement** on a model under the player or an
enemy turns it to face where its parent goes (a yaw for moving right and for
moving left, reached over a short turn time); it keeps its facing while the
parent stands still.

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
```

The browser tests need Playwright's Chromium (`npx playwright install
chromium`); on this LXC they use the library tree described in
`tests/e2e/browser-env.mjs`.
