# Assets

Everything about files in a project: the asset database and its sidecars,
the project window, the model and texture formats the importer takes,
texture streaming, packed textures and per-layer slots, levels of detail,
job exports from asset tools and deleting. The idea in short:
[Assets (concept)](../concepts/assets.md).

## The asset database: files and sidecars

Every imported file lives in the game folder (a project in the data root is
its own game folder), as Unity keeps files under `Assets/` and Godot under
`res://`. Next to each file is its `<file>.tlasset` sidecar: the asset's
stable id, its kind, its import settings (a KTX2 encode, audio load type and
preload, texture streaming, vertex colours, …), its labels and its address.
Everything refers to the id, so a file moved or renamed together with its
sidecar keeps every reference. Commit the files and the sidecars; there is
no count limit on either.

- **Uploads** (the project window's file picker or drop, MCP
  `tl_content_upload` + `publishAsset`) are written into the folder chosen
  in the project window, or `assets/` (MCP: `publishAsset {folder}`); a name
  already taken gets `-2`, `-3`, … An upload named as a hidden file (a
  leading dot), a `.tlasset` sidecar, a `*.scene.json` or a resource file
  (`<name>.<kind>.json`) is refused: the file check would take it in as
  project data.
- **A file already in the game folder** is imported where it is: project
  window → "from project folder…" (a picker limited to the game folder; hidden
  entries, `.git` and `thirdlight/` are not offered, a symlink out of the
  folder is refused), or MCP `tl_content_query {target: "projectFiles",
  dir}` then `tl_content_upload {projectPath}` and `publishAsset` with the
  returned `sourcePath`.
- **A whole folder** comes in with **import folder…** in the project window (or
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
  window (labels on many items at once), in the Inspector of the chosen item, or with
  `setLabels {items: [{kind, id}], add?, remove?}` and `setAddress {kind, id,
  address | null}` (one command and one undo however many items). An asset or
  resource with an address or a label is **loadable**: Play and the export
  ship it even when no scene uses it, and scripts load it by name (see
  [Loading assets by name](scripting.md#loading-assets-by-name-from-scripts)). A script that names an asset by id
  in a string literal while the asset is not loadable is a Problems row.

## The project window

The project window (the dock's **Project** tab) shows the game folder's real folders, as
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
  resource at once; the Inspector sets the chosen item's address and labels.
- **Organizing**: drag items or folders onto a folder, or cut (Ctrl/Cmd-X)
  and paste (Ctrl/Cmd-V); **new folder**, rename a folder (F2). A move is one
  command and one undo (`moveResources`, `renameFolder`, `createFolder`,
  also over MCP): an asset moves with its sidecar, and ids never change, so
  no reference and no built file changes. A taken target is refused.
- **Opening**: a double-click opens a folder, or the item's editor (a
  material, animator, graph, effect, script or visual script, library, UI
  document or theme, dialogue, timeline) in the editor window; a scene opens
  in the Scene view; a prefab, a shader material, an environment preset or
  an asset shows in the Inspector.
- **Creating**: **create ▾** (or a right-click on the list) is the Create
  menu for every kind of resource and scenes; the new item is named in place
  and opens in its editor (or the Inspector).
- The folder chosen is where uploads land and new scenes and resources are
  created ([Where new things go](projects.md#projects)).

## Supported glTF extensions

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

## FBX

An `.fbx` can be imported like a `.glb` (upload, "from project folder…", or
MCP `tl_content_upload` with `dataBase64` or `projectPath`). The backend
converts it with headless Blender (`THIRDLIGHT_BLENDER`, default `blender` on
`PATH`; installing it is part of [running the server](projects.md#projects-in-a-games-own-folder)) into a GLB — Y up, animations kept, textures
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
game through a role binding, as for any GLB.

The Draco and Basis decoders are three's own (`three@0.186.1`,
`examples/jsm/libs/{draco,basis}`, Apache-2.0). The editor and the Play
preview serve them at `/decoders/`; an export gets a `decoders/` folder (and a
license row in `meta.json`) only when one of its models needs it. Both run in
Web Workers, so the Play preview allows `worker-src blob:`; the Basis
transcoder also builds functions at run time, so a Play whose models carry a
KTX2 texture is served with `'unsafe-eval'` added to its script policy (other
Plays are not).

## KTX2 textures

A texture can be a KTX2 (Basis Universal ETC1S or UASTC, with its mip
levels): it stays compressed on the GPU and is transcoded on the player's
machine (three's Basis transcoder, shipped in an export only when it is
needed). Import a `.ktx2` as it is, or let the backend encode a PNG/JPEG on
import: the project window's **texture import encoding** → *KTX2 colour (ETC1S)* for albedo and
emissive art, *KTX2 normal map (UASTC)* for normal maps (MCP:
`tl_content_upload {kind: "texture", ktx2: "color" | "normal"}`, then publish
with the returned `convertedFrom`). Encoding takes seconds (a 2048² normal map
about 40 s on the GPU host) in a worker thread; up to 12 Mpix; WebP sources
and data maps (ORM, masks) stay images (a WebP is decoded with libwebp,
`@jsquash/webp`, pinned, and encoded like a PNG). The selected asset shows
`KTX2 · ETC1S · n mip levels` and the original it was encoded from. UI
images, portraits and input glyphs are drawn by the page and need a PNG,
JPEG or WebP. The encoder is the pinned `ktx2-encoder` package.
*KTX2 data (UASTC, linear)* is for masks, heights and packed
occlusion/roughness/metalness (MCP `ktx2: "data"`).

## Texture streaming

A large KTX2 texture **streams its mips** in Play and the export, as Unity's
mipmap streaming and Unreal's texture streaming pool do: the page first reads
the file's metadata and its mip tail (every level up to 128 px, one small
request), draws with it at once, and reads larger levels one at a time as the
texture's size on screen asks for them, inside the project's **texture
budget** (Project settings → Quality → Rendering → *Texture budget*, `texture_budget_mb`,
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

## Textures inside models: extraction and sharing

**Extract model textures** (the model import setting, on for new models)
turns every image a GLB holds — PNG, JPEG or WebP (`EXT_texture_webp`) —
into a KTX2 texture asset in `<model>_textures/`, encoded by its use (colour,
normal map, data), and the stored model keeps none of them. When a lossless
PNG of the image's name and size lies beside the model (in its folder or
its `textures/`, Blender's export layout), the KTX2 is encoded from that PNG
instead of the lossy copy inside; a PNG of another size is not taken.

The project setting **Import → Extract model textures**
(`import_extract_textures`: 0 *New models*, the default; 1 *Every model*)
extracts older imports too: each GLB model still holding images is
extracted where its file is, once per file version, as one undoable
`publishAsset` re-import. While it is 1, Problems lists the models still
holding images and why (`models_hold_images`: no file in the game folder,
converted from FBX, the extraction's own reason). With 0 a model may keep
its images on purpose (`extractTextures: false`).

## Packed textures and texture arrays

The project window's **pack texture…** makes one KTX2 from texture assets
already in the project (PNG, JPEG, WebP or KTX2), channel by channel: each layer's R, G, B and A come
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

KTX2 sources: when every layer is the whole of a UASTC KTX2 and all
share size, mip count and the encoding's colour space (sRGB for colour,
linear for normal map and data), the layers are **joined as stored** — no
texel is decoded or encoded, and no encoder limit applies (up to 256 MiB in
the largest mip level). Otherwise (ETC1S, whose codebook is per file; a size
or mip mismatch; a channel repack such as height into albedo's alpha) a
KTX2 is transcoded to RGBA and the layers are encoded once; where the KTX2
has a lossless original, that PNG is read instead: the PNG it was encoded
from on import (still holding the recorded bytes), or a PNG of the same name
and size beside the KTX2 file **whose sha-256 the KTX2 records** — the
import's recorded digest, or a key/value entry `thirdlight.sourceSha256`
in the KTX2 (the PNG's sha-256 as 64 lowercase hex characters, a
NUL-terminated string) that an asset tool writes when it exports both. A PNG
beside the file that the KTX2 does not tie to itself is not read (it may be
left over from before the KTX2 was exported again): the KTX2 is the source
and the layer counts as re-encoded. `packedFrom.reencoded` says per layer
whether it was encoded again from a lossy KTX2, and the dialog stays open
after a pack to say so. A join also needs the layers to agree on
premultiplied alpha, `KTXorientation` and whether the loader makes the mips
(level count 0); otherwise they are encoded again. A KTX2 level whose
declared size is not its image's is refused before it is decompressed.

## Per-layer texture slots

A graph material's texture parameter that its graph samples as an array
(the height-blended layers template's `albedoHeight`, `normals` and `orm`)
can name **one single-layer texture per layer** instead of a prebuilt array:
in the material's parameters (Material editor) the texture's **slots**
button turns it into a picker per layer (`+` / `−` add and drop the last
layer, **one** goes back to a single texture). MCP: the parameter's
`default` (or an instance's `values` entry) is a list of texture asset ids,
`""` for an empty slot. Each slot names a plain texture (not an array); an
empty slot takes the first filled slot's texture. An object's override of
the parameter is one texture, not slots.

The Scene view, the material preview, Play and the export draw the slots as
one KTX2 array the backend assembles from them — the pack route's rules
(UASTC layers alike joined as stored, others encoded once), each layer the
whole RGBA of its texture, encoded by how the graph reads the parameter (a
Normal map node: normal map; a Sample texture or Triplanar node in linear
colour space: data; otherwise colour). An albedo + height slot texture holds
its height in alpha. The array is made once and kept in the project's import
cache, keyed by the layers' file digests, the digest of the lossless PNG read
in each layer's place (or none) and the encoding: later Plays and exports, a
backend restart and every material naming the same list reuse it, a PNG
that turns up beside a slot's KTX2 later makes the array again, and two hosts
with the same files make the same array. An A/B
trial is a material instance with one slot changed: only that role's array
is assembled again, and the slots it shares with its parent stay one array.
The export ships the assembled arrays (under ids `slots-…`, made from the
array file's digest) and the materials name them; the slot textures ship
only if something else uses them. 4 × 1024²: joined in about 14 ms (UASTC),
encoded in about 9 s (ETC1S); a cached array is found in a few
milliseconds (the layers' files are read and any PNG beside them hashed
first, as both are part of the key).

## Levels of detail

A model's levels are its `<piece>_LOD0..n` nodes. Where each coarser level
takes over is a **screen size**: the share of the screen height the model's
LOD0 bounding sphere covers, measured for a 50° view (so a camera's lens
does not move it) and scaled with the object's (or copy's) size.

- **Per model** (asset inspector → **LOD switch %**, **cull below %**; MCP
  `setAssetOptions {assetId, lod: {screenSizes?: [...], cullSize?} | null}`,
  stored in the asset record and shown in its `.tlasset` sidecar's import
  settings): `screenSizes` lists where LOD1, LOD2, … take over, largest
  first, each in (0, 1] (absent: 0.08, 0.03, 0.012, 0.005); `cullSize` is the size below which the model is not drawn
  (absent: never). A model without levels and a cull size is culled as one;
  a model with levels culls its other parts (meshes outside its `_LOD`
  groups) where its first group is culled, as an instance set's copies are.
  Block layers use the switch points but never cull (a chunk holds many models).
- **Project** (Project Settings → Quality → Rendering): **LOD bias** (`lod_bias`,
  0.25–4, default 1) divides every switch point and cull size — 2 keeps every
  level twice as far, 0.5 halves the distances (cheaper); **LOD hysteresis**
  (`lod_hysteresis`, 0–0.5, default 0.1) — a shown level switches back to the
  finer one only that share of its switch distance closer, so a model
  standing at a switch point does not flicker. Both apply in the Scene view,
  Play and the export.

## Generated levels of detail

**Generate LODs** (a model import setting, off unless the import asks for
it: `publishAsset {…, generateLods: true}` or `importAssets {folder,
generateLods: true}`) gives a GLB model without authored `<piece>_LOD<n>`
levels three coarser levels at 50 %, 25 % and 12.5 % of its triangles
(meshoptimizer's simplifier; each level may move the surface by at most 1 %,
2 % and 4 % of the mesh's size, and stops early where the shape would
suffer). Each mesh node becomes `<name>_LOD0` with `<name>_LOD1…` beside it,
sharing its vertex data, so the levels switch at the model's screen sizes
like authored ones and nothing is simplified at load. The stored model is
converted (`convertedFrom.lods` lists the shares; the file in the game folder
is unchanged); a re-import of the file and a rebuilt import cache make the
levels again. A model with authored levels, and nodes that are skinned or
animated, have morph targets or children, or hold compressed geometry, keep
what they have; the result's `textureExtraction.lods` says what was made
(triangles per level, the largest error) and what was skipped. A model
converted from FBX gets no levels. Without the setting a model is stored as
imported.

Standard-shader project materials share one prepared texture per (texture,
colour space, wrap, UV channel, tiling and offset) across every model file
that uses them, freed with the last: one material on 14 model files holds
one copy of its texture on the GPU (the streamed texture's `copies` in
`resources.textures`).

## Job exports from asset tools

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
  publishAsset`. There is no editor button for it: the project window's
  "from project folder…" still imports the GLB itself.
- Limits: a manifest up to 64 KiB, files up to 128 MB in a folder, an
  uploaded zip up to the 32 MB stage limit; zips are read with stored or
  deflated entries (no zip64, no encryption).

## Deleting assets, prefabs and scripts

Project window → choose an asset or a prefab → **delete** in its Inspector
(MCP: `deleteAsset {assetId}`, `deletePrefab {prefabId}`, the
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

A script is deleted the same way: project window → choose the script →
**delete** in its Inspector (or Delete in its context menu; MCP:
`deleteBehavior {behaviorId}`). It is refused while an object in any scene
or a prefab (and so a live block type) carries it; the script's resource
file leaves the game folder, and one undo brings it back.

**Script trust.** File → Project Settings… → **Script trust** lists every
acknowledged script source (the digest of a script's source or of a script
library version), the revision it was acknowledged at and the published
scripts that use it. **revoke** withdraws one (MCP: `revokeBehaviorTrust
{sourceDigest}`); the next publication of that exact source asks again. It
is refused (`reference_in_use`, naming the scripts) while a published script
was built from that source or against that library version: delete the
script or publish another version first. One undo restores the entry. MCP
reads the list with `tl_content_query target="behaviors" includeTrust:
true`.
