# Export

**Goal:** your game as a folder of static files you can put on any web
server, checked in a real browser before you share it. The first steps
are in [your first export](../getting-started/first-export.md); this guide
adds what ships, how to check an export, and the pitfalls.

An export is a build of one revision of your project: `index.html`, the
game code (`js/`, with source maps), the physics engine's WebAssembly,
`manifest.json`, every scene in `scenes/`, the compiled scripts and the
asset files in `content/`. It needs no Thirdlight backend, editor or MCP
server.

## In the editor

1. **File → Export game… → Export now.** The dialog names the export
   (`<project>@r<revision>`) and its file count. **Download zip** gives you
   the folder as a zip.
2. Unpack it into a folder of its own and serve it over HTTP, for example
   `python3 -m http.server 8080` in that folder, then open
   `http://127.0.0.1:8080/`. Opening `index.html` from disk does not work:
   the game loads its files with web requests.
3. Play it with the keyboard, mouse and pad as a player would. It starts in
   the first game mode with the start scenes, as Play does.

## Through the API

1. Export (the owner's token; MCP has no export tool):
   `POST /api/v1/admin/projects/<id>/export` with `{}` answers
   `{"ok": true, "outputDir": "<id>@r<revision>", "revision", "files": {path: bytes}, "buildId", …}`
   and `warnings` when the start checks found something (one per
   problem, the same lines Play writes to Problems).
2. List and download: `GET /api/v1/projects/<id>/exports`, then
   `GET …/exports/<outputDir>/zip`.
3. For a project in a game's own folder, `node tools/project.mjs export
   ~/projects/my-game --out ~/projects/my-game/build` exports and unpacks
   in one step; it refuses an engine version or lockfile other than the
   folder's pin unless `--force`.
4. **Check it in a browser.** The page exposes the same observation as
   Play: `window.__thirdlightObserve()` in the browser's console (or from
   a test with Playwright) gives the step, the game mode, the loaded
   scenes, counters, UI, timeline, audio and saves. For example: wait until
   `__thirdlightObserve().stepIndex` passes 60, press Enter, check that
   `mode.current` and `scenes.loaded` changed as your title should make
   them.

## What ships

- Every scene of the project, loaded on demand; the start scenes first.
- The assets, prefabs and materials objects, block types, timelines and
  script properties use, and everything with an address or a label (what
  `ctx.assets.load` may name). An asset a script names only by a string
  ships only when it has an address or a label.
- The compiled scripts of the published sources: an unpublished change is
  not in the export.
- The game's saves are the player's own: an exported game stores its slots
  in the browser under `thirdlight:<projectId>`, apart from Play's.
- Nothing but your game on screen: the line naming the build and the play
  state (top left) shows only with **Debug console in export** on
  (Project Settings → Gameplay → Engine). A start error shows there either way.

## Which to use

Export from the editor when you want the zip in your hands; use the route
or `project.mjs export` in a build script or before a release, and check
the export with a browser test, not only in Play: the export is what
players get.

## Pitfalls

- **Serve over HTTP.** `file://` does not load.
- **Optional headers**: `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` let the simulation worker
  share memory with the page (one copy less per frame); it works the same
  without them.
- **The export is one revision.** Edit, then export again; each export is
  a new folder named after its revision.
- **Start checks refuse some projects**: an object kept loaded in two
  scenes is refused; no live camera or a player in a scene the game does
  not start with is a warning (see
  [Problems lines](../features/migration.md#problems-lines-a-game-may-see-after-the-upgrade)).
- **A missing asset file refuses the export** until the file is back.
- **Change the game's id and its players lose their saves**: the save
  namespace is the project id.

Related: [play-testing](playtesting.md), [saves](saves.md),
[performance](performance.md).
