# Your first export

An export builds your game into a folder of static files. The folder runs
from any web server. It needs no Thirdlight backend, editor or MCP server.

## In the editor

1. Choose **File → Export game…**.
2. Press **Export now**. When it is done the dialog says
   `Exported revision 0: 18 files in my-first-game@r0 under the server's export root.`
   (the numbers depend on your project).
3. Press **Download zip** to get the folder as a zip file.

The folder also stays on the server, in the data folder's `exports/`
(`~/thirdlight/exports/my-first-game@r0`). Each export is named after the
project and its revision.

## Run the exported game

The zip holds the game's files with no folder around them. Unpack it into
a folder of its own and serve that folder with any static web server, for
example:

```sh
unzip my-first-game-r0.zip -d my-first-game
cd my-first-game
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/`. The game starts at once and plays as it
did in Play. Serve it over HTTP: the game loads its files with web
requests, so opening `index.html` straight from disk does not work.

The folder holds `index.html`, the game's code in `js/` (with source maps),
the physics engine's WebAssembly, `manifest.json`, the scenes in `scenes/`
and the asset files in `content/`.

Optional: served with the headers
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, the game's simulation worker
shares memory with the page (one copy less per frame). It works the same
without them.

## Through the API

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:8501/api/v1/admin/projects/my-first-game/export
# → {"ok": true, "outputDir": "my-first-game@r0", "revision": 0, "files": {...}}

# Every export of the project, then one as a zip.
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8501/api/v1/projects/my-first-game/exports
curl -s -H "Authorization: Bearer $TOKEN" -o game.zip \
  http://127.0.0.1:8501/api/v1/projects/my-first-game/exports/my-first-game@r0/zip
```

For a project in a game's own folder, the project tool exports and unpacks
in one step:

```sh
node tools/project.mjs export ~/projects/my-game --out ~/projects/my-game/build
```

It refuses when the folder was pinned to a different engine version or
lockfile (`--force` exports anyway). MCP has no export tool: an export is
an owner action, done in the editor or with the token.

## Next

You have a project, a Play and an export. Read the
[concepts](../index.md#concepts) next, then pick a guide.
