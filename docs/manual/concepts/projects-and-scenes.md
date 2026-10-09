# Projects and scenes

## A project

A project is one game. It has an id (fixed when you create it), a name and a
**revision**: a counter that goes up by one with every change.

A project lives in one of two places:

- **In the data folder** (`~/thirdlight/projects/<id>/`). This is what the
  Projects page makes when you leave the folder empty.
- **In your game's own folder**, usually a git repository. The folder then
  holds `thirdlight.json` (a marker with the project id and the engine
  version it was pinned to), `thirdlight/` (the project's own files) and
  your assets and resources, by default in `assets/`. Commit all of them.
  See [Deployment: Projects in a game's own folder](../../deployment.md#projects-in-a-games-own-folder).

A project in the data folder is its own game folder: everything below is in
one directory.

| File | What it holds |
|---|---|
| `project.json` | The id, the name and the project format version. |
| `content.json` | Project-wide settings: the gameplay settings, tags, the scene list and start scenes, input, the game shell and more. |
| `scenes/<sceneId>.json` | One file per scene: its objects. |
| `assets/…` | Imported files (models, textures, audio, fonts), each with a `.tlasset` sidecar beside it (its id, kind, import settings and labels). |
| `assets/<folder>/<name>.<kind>.json` | One file per resource: a prefab, a script, a material, an animator controller, a UI document, a dialogue, a timeline and so on. Each kind has its own folder; the Starter's animator controller is `assets/animators/idle-run-airborne-01.animator.json`. |
| `.thirdlight/`, `cache/` | Process state and data derived from your files. Never commit them; a folder project's `.gitignore` leaves them out. |

In a folder project, `project.json`, `content.json` and `scenes/` are in
`thirdlight/`; assets and resources are in the game folder.

You may move resources, assets (with their sidecars) and scene files into
folders of your own, in the editor's Project window. Everything refers to
ids, never to paths, so a move breaks nothing.

The fields of every content document are in the reference:
[content documents](../reference/content.md#content-index).

## Scenes

A **scene** is a set of objects that load together: a level, a room, a
title screen, the player and the camera. A project has one or more scenes.
Object ids are unique across the whole project, so an object in one scene
may refer to an object in another.

- **Start scenes.** The game starts with the scenes in the start set, loaded
  together. The player object must be in a start scene. In the Hierarchy,
  **★** puts a scene in the start set or takes it out; the header shows
  START.
- **Loading more.** While the game runs, a script loads and unloads scenes
  with [`ctx.scenes`](../reference/script-api.md#ctx-scenes), and a trigger
  can load one when the player walks in. Only the start scenes are read
  before the first picture; the rest are fetched when they are loaded.
- **In the editor.** Each open scene is a header in the Hierarchy. Click a
  header to make it the active scene: new objects go there. **+ Scene**
  makes a new one. Which scenes are open is remembered by your browser, not
  by the project.
- **Through the API.** [`createScene`](../reference/ops-detail.md#op-createScene),
  [`setStartScenes`](../reference/ops-detail.md#op-setStartScenes), and
  `sceneId` on every command that creates an object (there is no default
  scene).

Related: [objects and components](objects-and-components.md),
[game flow](game-flow.md), [the scene list and start scenes in the reference](../reference/content-blocks-save-schema.md#content-scenes).
