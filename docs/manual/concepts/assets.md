# Assets

An **asset** is a file you bring into the project: a model (glTF/GLB, or FBX
converted on import), a texture, a sound or music file, or a font. The
Starter has two: the Character and Pillar models.

## Files and sidecars

Each asset is a real file in your game folder. Beside it is a sidecar,
`<file>.tlasset`, holding the asset's id, its kind, its import settings,
its labels and its address. Scenes and resources refer to the id, never to
the path, so you may move or rename a file together with its sidecar and
nothing breaks. Commit both.

The file is the truth. There is no version history inside the project: use
your game's git history. When a file changes on disk, the editor notices
(when it connects, when its window gets focus, on **check files**) and
imports it again with the same settings, as an ordinary change you can
undo.

What importers make from your files (converted models, compressed textures,
thumbnails) goes into `cache/`. It is rebuilt when missing, so never commit
it.

## Resources

Things you make inside Thirdlight are **resources**: materials, prefabs,
scripts, animator controllers, graphs, effects, script libraries, UI
documents and themes, dialogues, timelines and environment presets. Each is
one `<name>.<kind>.json` file in the game folder. Resources and assets are
listed, searched and moved in the same Project window.

## Labels and addresses

A scene loads what its objects use. To load something no scene uses (a
level's props ahead of time, a set of voice lines), give it a **label** or
an **address**; a script then loads it by that name with
[`ctx.assets`](../reference/script-api.md#ctx-assets) and releases it when
done. Anything with a label or an address ships with the game even if no
scene uses it.

## In the editor

The **Project** tab of the bottom dock is the project window. **import…**
uploads files; **from project folder…** imports a file already in the game
folder; **import folder…** brings in a whole folder in one step. Choose an
asset to see its facts, preview and import options in the Inspector. The
**create ▾** button makes resources (a material, an animator controller, a
UI document, …). Double-click a resource to open its editor.

## Through the API

[`importAssets`](../reference/ops-detail.md#op-importAssets) imports a
folder; [`publishAsset`](../reference/ops-detail.md#op-publishAsset) makes
an uploaded file an asset; [`setAssetOptions`](../reference/ops-detail.md#op-setAssetOptions)
changes import settings; [`setLabels`](../reference/ops-detail.md#op-setLabels)
and [`setAddress`](../reference/ops-detail.md#op-setAddress) name things
for scripts; [`deleteAsset`](../reference/ops-detail.md#op-deleteAsset)
deletes a file and its sidecar, and is refused while anything uses it.
Uploads go through MCP's `tl_content_upload`. The asset fields are in
[assets in the reference](../reference/content-blocks-script-libraries.md#content-assets).

There is no limit on how many assets or resources a project holds. Limits
apply to the size of one file and to the game's memory; see
[streaming and budgets](streaming-and-budgets.md).
