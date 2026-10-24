# Projects

Where projects live, what a project folder holds, where new files go,
files changed outside the editor, how older projects are upgraded, what a
project can hold, and projects kept in a game's own folder. The idea:
[Projects and scenes](../concepts/projects-and-scenes.md); assets:
[Assets](assets.md).

## Projects

Open `http://127.0.0.1:8501/` for the picker: it lists every project under
`~/thirdlight/projects/` and every registered folder project (see [Projects in a game's own folder](#projects-in-a-games-own-folder)), and creates new ones, empty or from a template.
Templates are directories under the engine's `templates/`
holding `captured/project.json` (+ `assets/`, optional `template.json` with
`name`, `description`, `picture` — a small image the picker shows on the
template's card —, `packs` — engine packs a new project gets, such as
`basic-kit` — and `requiredModules`), and an optional `setup/pack.json`: a
pack of asset files and commands run once the project exists (what a
captured v3 project cannot hold: materials, terrain, block layers, the
scene's look). A project made from a template starts with nothing to undo.
Two ship, neither with game rules:

- `templates/starter` ("2D starter"): a side-on level — a ground, three
  boxes, a character with the controller, a spawn point, a camera, two
  lights and a pillar model (it plays as a scene). Rebuilt by
  `templates/starter/tools/build-template.mts`. Its character is a
  game-ready skinned model made in Blender (`assets/model/character.glb`,
  949 KB: three levels of detail of 4,796 / 2,398 / 958 triangles, a
  capsule `_COL`, a 22-bone skin, 1024² albedo and ORM and a 512² normal
  map in KTX2, clips Idle, Run, Airborne, Walk, Jump and Land in place);
  the controller's capsule collides, not the model.
- `templates/starter-3d` ("3D starter"): 3D physics, the same character with
  a follow / orbit camera on a spawn point, a sun and a gradient sky, a
  ground block layer on the Basic Kit (added from `packs/basic-kit` when the
  project is made), and a 64 m terrain with a layered ground material
  (grass, soil, rock by slope; 512² KTX2 maps, 1.4 MB). It also holds
  grass for ground cover, placed nowhere until a cover rule uses it: the
  model `meadow-grass` (pieces `grass_a`, `grass_b`, `grass_c`, tall to
  short, each `_LOD0..2` of 55–70 / 21 / 6 triangles, wind weights in
  COLOR_0, no collider; 26 KB) and its `meadow-grass` foliage material
  with a 64×256 KTX2 colour texture (4 KB). Rebuilt by
  `templates/starter-3d/tools/build-template.mts` (the grass from
  `templates/starter-3d/tools/grass.py`, run in Blender with `bpipe`). The engine ships no sample
games: games live in their own repositories.

A project directory holds:

- `project.json`: id, name, engine version (schemaVersion 8; a 6 or 7 is
  upgraded on open, an older one is refused, see [Migration notes](migration.md)),
  and `upgrades`: the one-time data upgrades the project has had (`trim-data`:
  old trim paint and COLOR_0 moved, see [Vertex paint](vertex-paint.md); also
  recorded by the edit that adds a project's first trim material), so none
  runs twice;
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

**A project older than schemaVersion 6** (from before the asset database,
the engine/game separation or the per-scene looks) does not open with this
engine: open it once with the last engine that upgrades it (see [Migration
notes](migration.md#opening-a-project-with-this-engine-schemaversion-8)),
which writes it back as 7, then open it here.

### What a project can hold

A project holds as many assets and resources as a full game needs (the
scale bench's project has 18,000 asset files — 10,000 voice lines, 5,000
textures, 2,000 models — and 5,000 prefabs, 2,000 materials, 300 scenes and
2,000 voiced dialogue lines), and the game loads and frees them as it plays.

- **Assets are files with sidecars** in the game folder, **resources and
  scenes are files** in folders you choose, and the **project window**
  browses, searches (`t:` / `l:`), labels and moves them (see [Assets](assets.md)).
- **Import a folder** of any size in one command with labels on every file
  (**import folder…**, `importAssets`).
- **Labels and addresses** make assets and resources loadable by name:
  scripts load them with `ctx.assets.load(key)` and let them go with
  `ctx.assets.release(handle)` (see [Loading assets by name](scripting.md#loading-assets-by-name-from-scripts)).
- **Audio is one kind** with a load type and preload per file (see [Audio](audio.md)); nothing audio is read at start, and a conversation reads
  its voices a few lines ahead.
- **The game frees what it no longer uses**: each loaded file, model,
  texture, sound and font is held by the scenes, objects, sounds and handles
  that use it and freed when the last one goes (`resources` in
  `tl_game_observe` and Play diagnostics shows what is resident per kind).
- **Large textures stream** their mips inside the texture budget (see
  [Texture streaming](assets.md#texture-streaming)).
- **Play and the export read what they need**: the runtime manifest is about
  2 KB at any size and points to a catalog read in parts (a scene load reads
  its scene and its dependency list); Play serves files from disk, the export
  copies them one at a time.
- One file's size and the runtime's memory are bounded; the number of
  assets and resources is not (see [Engine limits](tuning.md#engine-limits-constants)).

### The engine and the game kept apart

Thirdlight holds generic capabilities only; a game's rules are its own
project scripts (in its own repository when it has one).

- **Start from the 2D starter template**: ground, boxes, a character with the
  controller, a spawn, a camera and lights, no game rules.
- **Build a game from primitives and scripts**: collectibles adding to named
  counters, health on any object with `damaged`/`died` events, patrols,
  hitboxes with contact events and damage, triggers with enter/exit events
  and scene transitions, movers, switches, a camera track, look overrides,
  event sounds, and `ctx.lifecycle` (respawn) with `ctx.scenes` (load,
  unload, reload). What a collected item, a hit or 0 health *means* is
  decided by the project's scripts (see [Gameplay](gameplay.md)). A tested
  example: `tests/e2e/starter-game.e2e.ts` builds a small game in the
  editor (a collectible counted in a HUD, a patroller whose hit a script
  turns into a respawn, a door to a second scene, a title screen) and plays
  it.
- **Menus and HUD** are the game shell's UI documents (title, pause,
  settings, controls, save and load screens, HUDs, the scene list).
- **Saves**: project save slots, save format version 2 (a save can carry
  the loaded scenes, the spawn and where the character stands; see
  [Saves](saves.md)).
- **Input**: named actions only (input frame version 2); the character
  controller reads the actions it names (`moveAction`, `jumpAction`,
  `runAction` in 3D; defaults `move`, `jump`, `run`).
- **Local co-op**: any number of player controllers share the view (see
  [Several player controllers](scenes-and-cameras.md#several-player-controllers-local-co-op)).
- **Removed game data**: a game block, a level flow, enemies, game zones,
  the session camera follow and pickups are refused where a document still
  holds them: the project does not open; the open error names each problem
  and the picker shows the first (… "removed from the engine: build it as
  project scripts"). Rebuild those parts as project scripts on the
  primitives, then open it again.
- The build fails when a package's source uses genre words (coin, enemy,
  checkpoint, score, platformer, …; `tools/check-boundaries.mjs`, with a
  short reviewed allowlist for the refusal text).

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
node tools/project.mjs skill ~/projects/my-game [--force] # install or update the agent skill (offline)
node tools/project.mjs export ~/projects/my-game --out ~/projects/my-game/build
```

`--origin` and `--token-file` override `http://127.0.0.1:8501` and
`~/thirdlight/owner-token`. The engine pin is advisory in the editor: a
different version or lockfile is shown in the picker and in Problems, a
different commit alone is normal after an upgrade; the project still opens.
`project.mjs export` refuses a version or lockfile mismatch unless
`--force`; `check --repin` records this engine once you have checked the
game. The export is a static directory that needs nothing else.

`create` (from the tool or the picker) also installs the engine's agent skill
into `.claude/skills/thirdlight/`; `check` warns when that copy is missing,
edited, or not the one this engine ships, and `skill` updates it (an edited
copy only with `--force`). See [Working with an AI agent](../getting-started/agents.md).
