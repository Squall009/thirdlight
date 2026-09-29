# Phase 26 — Asset scale and streaming

Goal: a project holds as many assets and resources as a full-size game needs
(thousands of voice lines, textures, models, prefabs, materials, scenes), and
the runtime loads and unloads them as the game asks. Loading and unloading is
core engine, not an optimization. The design follows Unity and Godot (§3)
rather than inventing its own. Read `docs/roadmap.md` (principles 1 and 1b)
first. Requests: Skyforge Tactics E41 (voice clips; `~/projects/skyforge-tactics/docs/engine-gaps.md`) and the owner. Phase 26 starts after phase 25; documentation moved to phase 28 (scalable
lighting is phase 27) so the manual describes the engine after both.

## 1. Owner decisions (2026-09-28)

- **No limit on the number of assets in a project**, or one so large it never
  matters. This holds for anything that can be imported (audio, models,
  textures, fonts, …) and for the project's own resources (scenes, prefabs,
  materials, scripts, UI documents, dialogue, timelines, effects, animators,
  graphs). What stays bounded is one file's size and the runtime's memory,
  never how many a project has.
- **Audio is audio.** There is one audio kind. No sound-effect or music
  class, no 2-second clip profile. A script (or a dialogue line, an audio
  source, a timeline, an event cue) names an audio asset and it plays. How a
  file is held in memory is a per-file import setting with a default the
  engine picks.
- **Loading and unloading at runtime is core to the engine.**
- **Follow the engines that came before** (2026-09-29): the asset database,
  the runtime loading model and build inclusion take Unity's and Godot's
  shape (§3). Where the browser differs (the network is the disk, every load
  is asynchronous), the difference is named.

## 2. Where things stand (checked at `811c14c5`, 2026-09-29, after phase 25)

- **Count caps** (`project-model/src/content.ts:92-125,242`, `materials.ts:172`,
  `animator.ts:163`, `timelines.ts:47`, `dialogue.ts:90`, `effects.ts:88`,
  `graph.ts:1168`, `script-libraries.ts:61`, `event-cues.ts:24`,
  `ui-documents.ts:267`, `environment-presets.ts:31`, `shell.ts:35`; copied into `commands/src/content-ops.ts:156,169,402` as
  literals, `scene-ops.ts:20`, `prefab-ops.ts:69`,
  `editor/src/session/prefab-authoring.ts:49`, `game-host/src/audio.ts:72,271`,
  `workspace/src/behavior.ts:484`, `mcp-adapter/src/tools.ts:394`, the
  limits table in `docs/deployment.md:2618`; D57): 128 models, 256 textures,
  64 sounds (16 until 25.7c), 64 music, 16 fonts, 1024 version records, 128
  prefabs, 64 behaviors, 64 scenes (32 in the shell's scene list), 256
  materials (instances included), 64 animators, 64 timelines, 64 UI
  documents, 256 dialogues, 128 effects, 64 graph documents, 32 script
  libraries, 64 environment presets, 64 event cues; a project-wide 1,048,576
  animation keys (`model-rig.ts:79`).
- **Byte caps that act as count caps:** the whole content document is one
  file, `content.json`, at most 1 MiB (`MAX_CONTENT_BYTES`,
  `content.ts:95`); the runtime manifest (version 4) is at most 256 KiB
  (`project-model/src/manifest.ts:33`). Since 25.7b materials (only the used
  ones; a used instance ships resolved, 25.19), material functions, UI
  documents, dialogue and the instance-buffer table are content files listed
  by digest in `contentFiles`, and since 25.9 each script library is its own
  module (`libraries/<digest>.js`); asset rows, rigs and prefabs are still
  inline. A project's sources are at most 512 MiB together
  (`workspace/src/content-store.ts:79`, checked at `:742`); a Play content
  set at most 512 MiB in the backend's memory
  (`protocol/src/delivery.ts:31-33`).
- **Asset storage:** uploads are copied into `thirdlight/sources/sha256/`;
  in a folder project an asset may instead reference a game-folder file in
  place (path and SHA-256, phase 10). Each asset keeps a list of versions;
  a changed file is an error until someone re-imports it. Import routes:
  the upload and inspection route, KTX2 encoding on import (25.19; the
  KTX2 is stored as the asset, the PNG/JPEG recorded in `convertedFrom`),
  packed texture arrays (25.21, `packedFrom`) and the job-export import
  (25.22: a folder or zip with a GLB and `manifest.json`, then
  `publishAsset`). `deleteAsset`/`deletePrefab` exist (25.7c), refused while
  anything references the record; the bytes stay.
- **Audio:** `audio` must be 2 s mono 48 kHz 16-bit WAV
  (`AUDIO_PCM_WAV_PROFILE`, `types-v3.ts:538`); `music` is Ogg/Opus/MP3/WAV up
  to 10 min (`content.ts:123`). Event cues and dialogue blips take `audio`
  only. Every `audio` asset is read and decoded when the game mounts
  (`registerSounds`, `game-host/src/host.ts:1406`) into a 64-entry store
  (`audio.ts:72`; music's is `:271`); decoded buffers of both kinds are kept
  until the page closes.
- **Commands:** every command re-validates the whole content document and
  rewrites the whole `content.json` (`commands/src/ops.ts:318`,
  `workspace/src/session-v4.ts:347`); a blob read scans the catalog
  (`readBlob`, `content-store.ts:878`); each publish stats every blob for
  the quota (`authoritativeBytes`, `content-store.ts:644`).
- **Play and export:** since 25.24 the page reads only the start scenes'
  assets before the start (8 at a time, each verified once) and the rest on
  demand; artifacts are served at stable digest-keyed URLs (`immutable`,
  `ETag`), compiled behaviors and an unchanged capture's derivation are
  cached, and blobs are held once by digest. The backend still reads and
  verifies every asset reachable from any scene into memory for each build
  (`exporter/src/content-closure.ts:569-613`); the export bundle hard-codes
  every artifact path in a `switch` (`exporter/src/export-bundle.ts:62-75`).
  Assets a script names by string are found by scanning script literals
  (25.7c). The two game-page bootstraps are still near-duplicates.
- **Runtime caches:** models are refcounted and disposed when their last
  scene unloads (25.24e); scene loads are prepared ahead and up to 4 next
  scenes read ahead. Nothing else is released: verified bytes
  (`game-host/src/asset-reader.ts:74`, the 25.24 verified reader), material
  and texture caches (`three-adapter/src/material-library.ts:265,540`,
  KTX2 textures and arrays included), environment and effects caches,
  decoded audio, fonts. No memory budget exists anywhere.
- **Editor:** the session holds only the first 128 assets, prefabs and
  behaviors (`backend/src/backend.ts:368-370`,
  `editor/src/session/client.ts:615,625-626`); more arrive only on
  "Refresh". The asset panel fetches every texture's full bytes and parses
  every GLB to draw its tiles (`editor/src/ui/App.tsx:1121`), and the list
  is not virtualized (`AssetBrowser.tsx:119`). The project window (25.23)
  was not built; it is 26.13.

## 3. How Unity and Godot do it (checked 2026-09-29)

| Topic | Unity 6 | Godot 4 | Thirdlight after phase 26 |
|---|---|---|---|
| Asset database | Each file under `Assets/` has a `.meta` sidecar with a GUID and its import settings; references use the GUID. Imported artifacts are cached in `Library/` and can always be regenerated. [1][2] | Each imported file has a `.import` sidecar; imported data in `.godot/imported/`; stable `uid://` references (`.uid` files for scripts and shaders since 4.4). [9] | Each file in the game folder has a `.tlasset` sidecar (stable id, kind, import settings, labels); imported data in a rebuildable cache keyed by digest. No count limit. (26.3) |
| Project resources | Scenes, prefabs, materials are asset files in `Assets/`, in real folders. | Scenes and resources are files in `res://`. | Each scene, prefab, material, … is its own file, in real folders of the game folder. (26.4) |
| Audio | One `AudioClip`. Load Type per clip: Decompress On Load, Compressed In Memory, Streaming; Preload Audio Data, Load In Background; per-platform overrides. [3] | One `AudioStream` family (WAV, Ogg Vorbis, MP3); docs advise WAV for short effects, Ogg for music, speech and long effects — advice, not a type split. [12] | One `audio` kind; load type per file (decode on load, decode while playing, stream), default by length. (26.6) |
| Runtime loading | Scenes load what they reference. Code loads by key or label (`Addressables.LoadAssetAsync`) and must pair each load with `Release`; the count reaching zero frees memory when its bundle unloads. `Resources.UnloadUnusedAssets` frees what nothing uses. [4][5] | `Resource` is refcounted and freed when no longer used; `ResourceLoader` caches by path while referenced; background loads with `load_threaded_request` / `_get_status` / `_get`. [10][11] | Refcounted resources, freed when the last holder goes (Godot); scripts load by id, address or label and release handles (Addressables). (26.10) |
| Memory budget | Texture mipmap streaming budget (`streamingMipmapsMemoryBudget`, all textures). [6] | None in 4.7 stable; 4.8 dev 5 adds opt-in mip streaming ("Texture2D Streamed"). [14] | Texture mip streaming under a budget, after 25.19's KTX2 mip chains. (26.12) Other kinds are freed by refcount, not a budget. |
| Build inclusion | Scenes in the build list and what they reference; `Resources/` always; addressable assets (loadable by key) in a separate content build with a catalog. [4][7] | Export modes: all resources, selected scenes and dependencies, selected resources and dependencies, all except selected. [13] | What the start and listed scenes and resources reference, plus assets marked loadable (an address or a label), listed in a catalog. (26.7, 26.9) |
| Editor | Project window, real folders, search `t:AudioClip l:voice`, cached thumbnails. [8] | FileSystem dock over `res://`. | Project window over real folders, same search, thumbnails from the import cache. (26.13) |
| Unreal (for reference) | Asset Registry indexes unloaded assets; soft object pointers loaded with `FStreamableManager::RequestAsyncLoad`; texture streaming pool budget. [15] | | The index of 26.4 is the Asset Registry's role. |

Where the browser differs: the network is the disk, so every load is
asynchronous and the HTTP cache (digest URLs, 25.24c) holds what Godot's
`.pck` or Unity's bundles hold on disk. That favours a catalog of files
fetched on demand (Addressables) over one package file.

Sources:
[1] https://docs.unity3d.com/6000.0/Documentation/Manual/AssetMetadata.html
[2] https://docs.unity3d.com/6000.0/Documentation/Manual/asset-database-contents.html
[3] https://docs.unity3d.com/6000.0/Documentation/Manual/class-AudioClip.html
[4] https://docs.unity3d.com/Packages/com.unity.addressables@2.3/manual/load-assets.html, …/MemoryManagement.html, …/AddressableAssetsOverview.html, …/AssetDependencies.html
[5] https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Resources.UnloadUnusedAssets.html
[6] https://docs.unity3d.com/6000.0/Documentation/ScriptReference/QualitySettings-streamingMipmapsMemoryBudget.html
[7] https://docs.unity3d.com/6000.0/Documentation/Manual/LoadingResourcesatRuntime.html
[8] https://docs.unity3d.com/Manual/ProjectView.html
[9] https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/import_process.html, https://godotengine.org/article/uid-changes-coming-to-godot-4-4/
[10] https://docs.godotengine.org/en/stable/classes/class_resource.html, https://docs.godotengine.org/en/stable/classes/class_resourceloader.html
[11] https://docs.godotengine.org/en/stable/tutorials/io/background_loading.html
[12] https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_audio_samples.html
[13] https://docs.godotengine.org/en/stable/tutorials/export/exporting_projects.html
[14] https://godotengine.org/article/dev-snapshot-godot-4-8-dev-5/
[15] https://dev.epicgames.com/documentation/en-us/unreal-engine/asset-registry-in-unreal-engine, https://dev.epicgames.com/documentation/en-us/unreal-engine/asynchronous-asset-loading-in-unreal-engine, https://dev.epicgames.com/documentation/unreal-engine/texture-streaming-configuration-in-unreal-engine?lang=en-US

## 4. Items

Order: cleanup → measure → asset database → resources as files → caps → audio →
labels → backend → manifest and export → runtime → audio loading → texture
streaming → editor → acceptance. One format bump for the phase:
`project.json` schemaVersion 5 and runtime content manifest version 5; a 4
is upgraded on open (25.7 made it 4) and the upgrade is tested on fixtures
like 25.7a's, replays included. Each item keeps the gate green and is tested
at the boundary it changes (Playwright for any editor surface).

| Item | What |
|---|---|
| 26.0 | This plan, and its rows in `docs/STATUS.md` and `docs/roadmap.md`. |
| 26.1 | **Cleanup first** (owner, 2026-09-29; the code review of that day). Done before the storage rewrite, while no other agent works in the tree:<br>• **History comments go.** Source comments lose their phase numbers, item ids, dates and `§` references to archived specs (~5,900 and ~3,100 today); a comment whose content is history ("was 16", "since 24.8") is rewritten to say why the code is as it is, or deleted. Checked comment-only: the build with `removeComments` emits the same JavaScript before and after. A check in `npm run build` fails on new ones in `packages/*/src`; it covers the ~1,390 lines phase 25 added in `packages/` and `tools/`, and test names that carry them (D59).<br>• **Limits defined once.** Every limit or constant copied between packages (about 15, e.g. `MAX_PREFABS` in three places, the scene and audio caps) is defined in the package that owns it and imported elsewhere, so 26.5 removes each cap in one place. Includes phase 25's copies (D57): `MAX_TRANSITION_FADE`, the 256 texture layers (`KTX2_LAYERS_MAX`, `TEXTURE_PACK_LAYERS_MAX`, `MAX_TEXTURE_LAYERS`), `MAX_MATERIAL_INSTANCE_DEPTH`, `AUDIO_MAX_REGISTERED_ASSETS`, the literal 32 libraries in `workspace/src/behavior.ts`, the per-kind literals in `commands/src/content-ops.ts`.<br>• **Split before growing (D58).** `project-model/src/content.ts` (2,780 lines), `descriptors.ts` (2,213), `editor/src/session/client.ts` (2,417) and `runtime/src/types.ts` (2,489) grew in phase 25 without a split; each is split by area before any item adds to it.<br>• **Minimal ESLint** in the fast gate (`npm run lint`), versions pinned in the lockfile and checked against the official docs: `eslint-plugin-react-hooks` (rules-of-hooks, exhaustive-deps), a few correctness rules (`eqeqeq`, `no-fallthrough`, `no-unreachable`, `no-self-compare`, `no-constant-condition`, `no-dupe-keys`), typescript-eslint's `no-floating-promises` and `no-misused-promises`, and `ban-ts-comment`. Existing findings are fixed, or listed in the item's decision log where a fix is a behaviour change; the 53 inert `eslint-disable` comments are removed or given a reason.<br>• **three.js 0.186.0 → 0.186.1** (the newest release, a patch of 2026-09-24; npm `latest` re-checked 2026-09-29, no newer minor), after reading its release notes, with the full gate. |
| 26.2 | **Scale bench.** A generator (`tools/`) that writes a synthetic project of a full game's size: 10,000 voice lines (1–15 s Opus) and 1,000 other sounds, 5,000 textures, 2,000 models, 5,000 prefabs, 2,000 materials, 300 scenes and 2,000 dialogue nodes with voices. A perf-harness class that measures open, one command's latency, Play start, scene load, memory resident while walking 50 scenes, a 500-line voiced dialogue played through, and export. Run it first with the caps lifted in a scratch branch to find what breaks, and record the before numbers in §6. |
| 26.3 | **Asset database: files and sidecars** (Unity `.meta`, Godot `.import`). Every imported file lives in the game folder; an upload from the browser or MCP is written there (a default `assets/` folder, or the folder the user drops it in). Next to it, `<file>.tlasset` holds the asset's stable id, kind, import settings, labels and address. References use the id, so a move or rename keeps them (the editor moves the sidecar with the file; a sidecar found at a new path outside the editor is the same asset). The file is the truth: a changed file is re-imported when the backend notices (project open, window focus, "check files", as today), and the change goes out on the change feed; there is no per-asset version list (history is the game repo's, as in Unity and Godot). Imported data (FBX → GLB, audio and image headers, thumbnails, KTX2 encodes) goes in `thirdlight/cache/imported/`, keyed by source digest, settings digest and importer version, git-ignored and rebuilt when missing. **Folder import:** pointing the importer (editor or MCP) at a folder brings every file in it in as assets named after their files (`assets/audio/voice/<line>.ogg` → an asset named `<line>`), one command, with labels applied to all of them (E41). Every import route writes this way: uploads, KTX2 encoding (25.19's `ktx2` option becomes an import setting of the PNG/JPEG file, as Unity's texture compression is; the KTX2 is cached, not stored as a second asset), packed texture arrays (25.21: a derived asset whose sidecar lists its source files, as `packedFrom` does today) and the job-export import (25.22: the GLB and its manifest's files go into the game folder). `deleteAsset` (25.7c) deletes the file and its sidecar, still refused while referenced. Projects in the data root get the same layout in their own folder. Upgrade: each asset's current version is written out as a file with its sidecar (a `convertedFrom` KTX2 as its original with the encode setting); older versions stay in `thirdlight/sources/` untouched and are listed in the upgrade report. |
| 26.4 | **Project resources as files, with an index.** Each scene, prefab, material, material function, behavior, library, graph, UI document and theme, dialogue, timeline, effect, animator and environment preset is its own file with a stable id, in real folders the user chooses (25.23's folders become these directories). `content.json` keeps only project-wide settings. The backend keeps an index of every asset and resource (id, kind, path, name, labels, references out), rebuilt from the files on open and updated by each command (Unreal's Asset Registry role), so open and queries don't parse everything. A command validates the files it touches plus the references into and out of them, and writes only those (write then rename, as today). Undo, history, the change feed and MCP work as before. Storage leaves `workspace/src/service.ts`'s `buildService` closure for its own module first, and typed readers replace the `as unknown as` casts on the content shapes it rewrites. |
| 26.5 | **Count caps removed.** Every per-project count in §2 goes, in the model, commands, editor, game host, MCP descriptions and docs. The 1 MiB content cap becomes a per-file byte cap. The 512 MiB project quota goes; an import refuses only when the disk is short, with the free space in the message. The project-wide animation-key budget becomes a per-model one. A test fails if a per-project count cap on assets or resources comes back. The caps phase 25 added or raised go too (audio 64 from 25.7c, 32 script libraries from 25.9, the game host's 64-entry audio stores; D57), each already defined once by 26.1. Per-object caps stay only if they survive a **limits audit**: every remaining engine limit (the table in `docs/deployment.md` and every constant behind it — colliders per scene (256), spawns (64 per step, 1,024 alive), script intents (5 per instance per step), timers, entities per scene, block-layer sizes, nodes per graph, widgets per document, keys per track, lights, bake atlases and entries, material-instance depth (8), texture-array layers (256), KTX2 encoder source size (12 Mpix, kept: owner deferred the encoder), …) is checked against a full-size game. Each is raised, turned into a runtime budget, or kept with a one-line reason next to it and in the limits table. The audit's list goes in this plan's decision log. |
| 26.6 | **One audio kind** (Unity `AudioClip`, Godot `AudioStream`). `audio` takes Ogg Vorbis, Opus, MP3, WAV and FLAC in any channel count, rate and bit depth, checked against the MDN codec tables for Chromium, Firefox and Safari; no duration cap; a per-file size cap only. Import settings in the sidecar: **load type** (decode on load, decode while playing, stream), default by length (under 5 s decode on load, over 60 s stream, between decode while playing; the thresholds fixed from 26.2's measurements), and **preload** (read with its scene or only when played). `music` records become `audio` on upgrade (ids kept). Every reference (dialogue voice and blip, audio source, event cue, timeline key, `ctx.audio.play`, `ctx.audio.music`) takes any audio asset; sound, music, voice and UI are mixer buses only, as today. No transcoding (Unity's compression settings would need it; revisited only if a real game needs it). |
| 26.7 | **Addresses and labels** (Addressables). An asset or resource may have an address (a name scripts use; default none) and labels (`voice`, `level-3`, …), set in the Inspector, the project window and through MCP (commands, one undo). An asset with an address or a label is **loadable**: the export includes it even if no scene references it. The 25.7c scan of script string literals becomes a Problem ("script names an asset that isn't loadable") instead of a build rule. |
| 26.8 | **Backend reads scale.** Blob and file lookup through the index. Queries page from the index instead of copying and sorting the catalog. Play and export no longer read every reachable asset per build (25.24 limited the page's reads to the start scenes, but the backend's closure still reads and verifies every reachable asset, `content-closure.ts:569-613`): a file's digest is checked once per change (kept across builds), and Play serves files from disk at the stable digest URLs of 25.24c instead of holding them in the backend's memory. Play start time and the backend's memory do not grow with the number of assets. |
| 26.9 | **Catalog, manifest and export scale.** The runtime manifest keeps the start and the catalog's location; the catalog (id, address, labels, digest, kind, load settings, dependencies) is content files listed by digest (as 25.7b did for used materials, material functions, UI documents, dialogue and the buffer table, and 25.9 for script library modules), split so a scene's load reads only what it needs. The export includes what the start scenes, the shell's scene list, loaded-by-reference scenes and resources reference, plus every loadable asset (Unity's build-list-plus-addressables, Godot's "selected scenes and dependencies" plus "selected resources"); only used materials ship (a used instance resolved, its parents only when named), and the KTX2 transcoder only when a KTX2 texture does, as today. The export bundle no longer bakes every artifact path into its code, and export streams files to disk instead of holding the closure in memory. The Play page's and the export's bootstraps (`editor/src/preview/preview-m3.ts`, `exporter/src/export-bootstrap-m3.ts`, near-duplicates today) become one shared game-page bootstrap. |
| 26.10 | **Runtime resource manager** (Godot's refcounted `Resource`, Addressables' handles). One manager in the game host for everything loaded from assets: verified bytes, models, textures (`ImageBitmap`s closed), animation clips, audio, fonts, environment maps and effect models. A resource is held by its holders (loaded scenes, live entities, playing sounds, script handles) and freed when the last one goes, after the step's scene changes settle, so a transition that unloads and reloads the same model doesn't drop it. Scripts get `ctx.assets.load(idOrAddressOrLabel)` → a handle with a state (loading, ready, failed) and `ctx.assets.release(handle)`; a load of a label loads every asset carrying it. The simulation never waits on a load (presentation stays out of determinism; a script reads the state). The verified asset reader (25.24b, `game-host/src/asset-reader.ts`, which today keeps every verified read) becomes the manager's byte layer; prepared scene loads and read-ahead (25.24e) go through the manager, and the refcounted models of 25.24e become one kind among the others. `tl_game_observe` and Play diagnostics report what is resident (count and bytes per kind), loads, frees and handles not released at the end of a play. Scene view and Play share it. Asset loading leaves `game-host/src/host.ts`'s `createGameHost` closure for this module first. |
| 26.11 | **Audio loading.** No audio is read at mount. Each file loads per its load type: decode on load into a buffer; decode while playing (compressed bytes kept, decoded per play); stream (a media element through Web Audio). The browser mechanics (decode per play vs chunked decode, media elements in a worker-driven page) are checked against current browser behaviour before choosing. A sound played before it is ready starts when ready, or is dropped past a lateness bound the caller sets; the observation says which. Dialogue loads the next lines' voices ahead (every branch a few nodes deep), so a voiced conversation has no gap. The 64-entry audio stores go. |
| 26.12 | **Texture streaming under a budget** (Unity's mipmap streaming budget, Unreal's streaming pool, Godot 4.8's streamed textures). Textures with mip chains (KTX2 from 25.19, texture arrays from 25.21) load their smallest mips first and higher ones by on-screen size, inside a GPU texture budget (a project setting with a default for a mid-range laptop); over budget, the least-needed mips drop first. Opt-in per texture in its import settings, on by default for textures over 1024 px. Both renderers; pixels checked. |
| 26.13 | **The project window, and the editor at scale** (25.23 moved here, owner 2026-09-29). Today the asset browser is one flat list with no search, filter or sort, and materials, prefabs, scripts, UI documents, timelines, dialogue, effects and animators each live in their own panel.<br>• **Folders** are the game folder's real directories (26.3, 26.4), for every asset and resource kind; nested, renamable, "new folder".<br>• **Drag and drop:** items and folders move between folders; multi-select, cut and paste. A move is a command (`moveResources`, one undo) that moves the file and its sidecar, so MCP can organize too; ids don't change, so a move never changes a build (paths stay out of the buildId). The existing drop targets stay: Scene view, Inspector fields, Hierarchy.<br>• **Browsing:** Unity-style search (`t:audio l:voice name`), filter by kind, sort, grid or list with a tile-size slider, a breadcrumb, a virtualized list that scrolls tens of thousands of items. Tiles come from the import cache's thumbnails; a model's pieces load when it is selected, not to draw its tile.<br>• **Opening items:** a double-click opens the item's editor (material, timeline, UI document, …); the per-kind panels remain as views.<br>• **Labels and addresses** (26.7) are set here too, on many items at once.<br>• **At scale:** the session holds the index, not the first 128 records; lists, pickers and search page from the backend. The Scene view's models and textures go through 26.10's manager and are freed when no scene uses them.<br>Playwright against a real backend: create a folder, drag an asset into it, search, reload; on the scale bench, open, scroll the whole catalog, place an asset, give a dialogue line a voice, label 1,000 files at once. |
| 26.14 | **Acceptance and docs.** The scale bench's after numbers in §6, with targets fixed from 26.2's before numbers (as 25.24 did). The limits table in `docs/deployment.md` lists per-file sizes and runtime budgets only. MCP tool descriptions updated. |

**Done when:**
- The scale bench opens, edits, plays and exports in a real browser on both
  renderers. One command's latency and Play start do not grow with the
  project's asset count.
- Walking 50 scenes frees what each scene alone used (measured by resident
  bytes, not assumed), and textures stay inside their budget. A 500-line
  voiced dialogue plays through with no gap.
- A script loads 1,000 assets by label and releases them; resident memory
  returns to where it was.
- No per-project count cap remains on assets or resources, and the test from
  26.5 guards it.
- A version-4 project opens and upgrades; its replays still match.
- `tools/gate.sh full` is green.

## 5. Progress

| Item | Status |
|---|---|
| 26.0 | done 2026-09-29; reconciled with phase 25 at `811c14c5` |
| 26.1 | done 2026-09-29: limits once, splits (D57, D58); ESLint in the gates; three.js 0.186.1; history comments removed with a build check (D59) |
| 26.2 | done 2026-09-29: scale bench (generator, harness, small-size tests in the fast gate); before numbers in §6; D61 |
| 26.3 | A done 2026-09-29: files and sidecars (uploads filed into `assets/`, `.tlasset` sidecars, import cache, file check re-imports and follows moves, project.json 5 with the upgrade of a 4); B (folder import, drop into a folder, editor surfaces) next |
| 26.4–26.14 | — |

## 6. Measurements

(26.2's before numbers and 26.14's after numbers.)

### Before (26.2, 2026-09-29)

Host: Intel Core i5-12600H (10 vCPU), 16 GiB; Chromium (Playwright 1.62.1)
on its Iris Xe (ANGLE on Vulkan, WebGPURenderer on WebGL 2); commit
`a15a994e` for Starter, half-caps and caps; the ×0.01, ×0.1 and full columns
ran on a scratch branch that lifts the count caps, the 1 MiB content cap and
the 256 KiB manifest cap (not merged; 26.5 removes caps properly). Command:
`node tools/perf/run.mjs scale --preset <p> | --factor <f> --gpu`; reports in
`~/.cache/thirdlight-perf/reports/scale-*.json`. Times in ms (p50 / p95),
memory in MiB. "–": not applicable; "refused": the step could not be taken
(reason below the table).

| | Starter | half-caps | caps | ×0.01 | ×0.1 | full |
|---|---|---|---|---|---|---|
| assets (voices / sounds / textures / models) | 2 | 256 (32/32/128/64) | 512 (64/64/256/128) | 180 | 1,800 | 18,000 (10,000/1,000/5,000/2,000) |
| prefabs / materials / scenes / dialogue lines | 0 / 0 / 1 / 0 | 64 / 128 / 32 / 250 | 128 / 256 / 64 / 250 | 50 / 20 / 3 / 20 | 500 / 200 / 30 / 200 | 5,000 / 2,000 / 300 / 2,000 |
| sources on disk | – | 3.7 | 6.9 | 2.7 | 27 | 302 |
| open: backend's first read | 6 | 61 | 90 | 49 | 191 | 6,703 |
| open: editor connected / Scene view first frame | 881 / 626 | 908 / 590 | 941 / 612 | 898 / 608 | 940 / 620 | 1,128 / 603 |
| backend resident after open | 139 | 161 | 171 | 145 | 196 | 560 |
| command: scene edit (setTransform) | 6.6 / 10.3 | 14.9 / 29.1 | 32.6 / 45.5 | 13.4 / 17.5 | 130 / 155 | 11,198 / 11,804 |
| command: content edit (setMaterial) | – | 35.9 / 46.8 | 76.6 / 91.1 | 17.9 / 25.2 | 322 / 342 | 26,057 / 27,505 |
| Play: click → first frame | 548 | 530 | refused | 528 | 905 | 22,778 |
| Play: backend build (closure) / manifest bytes | 31 (10) / 6 K | 93 (71) / 185 K | refused | 82 (56) / 94 K | 429 (400) / 916 K | 22,077 (22,048) / 9.2 M |
| scene load: request → drawn (game timings) | – | 47 / 52 | refused | 103 / 127 | 73 / 93 | 138 / 156 |
| walk: scenes; heap before → after | – | 31; 48.1 → 52.4 | refused | 2; 46.8 → 49.4 | 29; 52.3 → 65.7 | 50; 66.2 → 115.1 |
| walk: live GPU textures before → loaded → after | – | 4 → 7 → 5 | refused | 4 → 30 → 5 | 4 → 50 → 5 | 4 → 49 → 5 |
| dialogue: lines heard; line → voice p95; gap p50 / p95 / max | – | 250/250; 32; 6 / 11 / 24 | refused | 20/20; 35; 9 / 12 / 12 | 200/200; 35; 5 / 11 / 26 | 500/500; 35; 4 / 11 / 28 |
| export: time; files; MiB; exported first frame | 1,160; 9; 13.1; 735 | 1,166; 265; 15.1; 579 | refused | 1,017; 102; 13.8; 538 | 1,498; 939; 21.1; 606 | 9,058; 9,309; 119; 852 |

What broke, and where each number could not be taken:

- **Open at full size on `a15a994e`:** refused (`content_invalid`, 8 problems):
  scenes 300 > 64, models 2,000 > 128, music 10,000 > 64, textures 5,000 >
  256, audio 1,000 > 64, version records 18,000 > 1,024, prefabs 5,000 > 128,
  materials 2,000 > 256. Nothing else could be measured at that size on main.
- **At the caps:** the 1 MiB content block binds first — 1,000 dialogue lines
  did not fit (1.2 MiB canonical), so the caps preset carries 250. Play and
  the export are refused: the runtime manifest is over 256 KiB
  (`export_manifest_invalid`); every Play-side number at today's limits is
  taken at half the caps.
- **Voices:** `audio` takes only 2 s mono WAV, so voice lines are `music`
  records (the one kind that takes Opus); the other sounds are WAV of
  0.2–1 s.
- **With those three caps lifted (scratch):** every step ran at full size,
  but commands take 11 s (scene) and 26 s (content), Play starts in 23 s
  (18.3 s of it the backend's `closure.view`), the open takes 6.7 s and the
  backend holds 560–581 MiB. Command latency grows faster than the asset
  count (×10 assets from ×0.1 to full: ×86 scene edit); most of it is a
  quadratic step in content validation (D61). `content.json` grows from 11 MB
  as generated to 24 MB after the first command rewrites it.
- **Walking scenes:** GPU objects are freed on unload (live textures back to
  baseline + 1), but the heap grows about 1 MiB per distinct scene loaded
  and is never given back (66 → 115 MiB over 50 scenes; 27 MiB of asset bytes
  read): verified bytes and decoded data stay cached (§2, 26.10).
- **Dialogue:** no audible gap at any size: voices are small `music` files
  read and decoded when played (p95 line start → voice playing 35 ms, gap
  p95 11 ms). The resolution is the relay's observation round trip
  (5–10 ms); nothing was listened to (owner listen pending).
- **Not reached:** the 512 MiB source quota and the 512 MiB Play content set
  (the generated files are small: 64 px textures, tiny models; 302 MiB of
  sources). A game with real texture and model sizes would hit both; the
  generator's `textureSize` and counts are parameters for 26.8's check.
- **Not observable today:** resident bytes by kind (the game host has no such
  metric; 26.10 adds it). The bench records the JS heap after a collection,
  the graphics API's live objects and byte estimate, three's renderer counts,
  asset bytes read (Play diagnostics) and the backend's resident set instead.
  The Play page shares its renderer process with the editor, so its heap is
  editor + game.

After 26.3 A (small preset, open and commands only, generator version 2 —
assets as files with sidecars; 2026-09-29): backend's first read 58 ms
(38 ms in 26.2's small run), editor connected 732 ms, scene edit p50/p95 7.1/10.3 ms,
content edit 9.8/14.7 ms. The editor's file check after the open hashes each
asset file once per change (stat-keyed); its cost at full size is 26.8's to
measure.

Proposed targets for "Done when" (fixed in 26.14 from these numbers):

- One command at full size: p95 ≤ 100 ms for a scene edit and a content edit,
  and within 2× of the same command at ×0.01 ("does not grow").
- Open at full size: backend ≤ 2 s, editor connected ≤ 2 s; backend resident
  ≤ 300 MiB.
- Play start at full size: click → first frame ≤ 1.5 s and within 1.5× of
  ×0.01; the backend's build time does not grow with the asset count.
- Walking 50 scenes at full size: heap after the walk within 5 MiB of before;
  live GPU textures back to baseline; scene load p95 ≤ 200 ms.
- 500-line voiced dialogue at full size with voices loaded on demand (26.11):
  every voice heard, gap p95 ≤ 20 ms and max ≤ 50 ms at the bench's
  resolution.
- Export at full size: ≤ 15 s, the backend's resident set during it no more
  than 100 MiB above the open's; the exported game's first frame ≤ 1.5 s.

## 7. Decision log

- 2026-09-28: where the caps came from. The first ones (128 models, 16
  sounds, the 2 s mono WAV profile, the 1 MiB content document) were in the
  M2–M4 packet specs (snapshot `0adc7aa`); later phases copied the pattern
  for textures (256), music (64) and the rest. They sized the project for a
  sample, not a game. 25.7c's decision to keep a count of 64 sounds "for no
  case that needs it" is reversed here: voiced dialogue needs thousands.
- 2026-09-28: phase 26 is this plan; the documentation plan became phase 27
  (phase 28 since 2026-09-29, when scalable lighting took 27)
  so the manual and its limits page describe the engine after it.
- 2026-09-29: the plan was revised to follow Unity and Godot (owner). The
  first draft had its own per-record store under `content/` and an
  LRU cache with budgets for every kind; it now has sidecars next to the
  files, resources as files with an index, refcounted freeing, addresses and
  labels for loading by name, and a budget only for texture mips, where all
  three engines have one.
- 2026-09-29: assets lose their per-asset version list. In Unity and Godot
  the file is the truth and history lives in version control; a game folder
  is a git repo here too. An upgrade keeps older version bytes on disk and
  lists them, so nothing is lost.
- 2026-09-29: Addressables' `Release` frees memory only when a whole bundle
  unloads [4]. Thirdlight has no bundles (each file is its own URL), so a
  resource is freed when its own count reaches zero, as in Godot.
- 2026-09-29: no audio transcoding. Unity re-encodes per platform; the
  browser plays Ogg, Opus, MP3, WAV and FLAC as imported, so load type is
  the only setting that changes memory. Revisited if a real game needs
  smaller files than its source.
- 2026-09-29: 26.1 (cleanup) added first and the other items renumbered by
  one (the project window from 25.23 is now 26.13). The code review found the
  codebase workable with debt: closures of 1,000–1,700 lines, limits copied
  between packages, history comments, no linter. Splits happen in the items
  that rewrite those areas.
- 2026-09-29: plan reconciled with phase 25 (`34847ae` → `811c14c5`). §2's
  file:line references re-checked; it now names what 25.7b/c, 25.9, 25.19,
  25.21, 25.22 and 25.24 changed (content files by digest, used materials
  only, library modules, 64 audio records and deletes, KTX2 and texture
  arrays, the job-export import, the verified reader and read-ahead). Items
  adjusted: 26.1 takes D57–D59 (phase 25's copied limits, the four files
  past 2,000 lines, its history comments); 26.3 routes every import
  (KTX2 encode as an import setting, packed arrays as derived assets, job
  exports) through files and sidecars; 26.5 lists phase 25's caps and limits
  for removal or the audit; 26.8–26.10 and 26.12 build on 25.24's reader
  and 25.19/25.21's KTX2. 25.23 already sits in 26.13. three.js check: npm
  `latest` is 0.186.1 (repo pins 0.186.0), a patch already in 26.1; no newer
  minor, so no new item.
- 2026-09-29 (26.1 A): shared limits live in project-model (the owner every
  package reaches) and are re-exported from `src/limits.ts`, also the
  `@thirdlight/project-model/limits` subpath (constants only): protocol,
  asset-pipeline, backend and the editor value-import it over their
  types-only edge, and physics-rapier and mcp-adapter get that subpath as
  their one project-model edge; game-host and three-adapter take the few
  they need through runtime's re-exports. Limits no model rule uses but two
  packages share (prefab overrides per request, compile diagnostics, stage
  and asset-page bounds, the inline instance-set bound in protocol) are
  defined next to their nearest owner. The id syntax regex (about 50 copies)
  is `ID_RE`. Left as is: independent bounds with equal values (error-message
  lengths per package, the MCP entity page of 1,024, GLB image entries in the
  loader), runtime-owned numbers in MCP prose (spawns, timers, queries per
  step: mcp-adapter has no runtime edge; 26.5/26.14 rewrite those texts),
  the frozen M2/M3 engine pin tables' three version, and three-adapter's
  copy of `resolveMaterialInstances` (a code path, not a limit).
- 2026-09-29 (26.1 A): the four files past 2,000 lines are split by area,
  re-exported so imports stay the same: `content.ts` 2,780 → 777 (+
  `content-limits`, `-helpers`, `-assets`, `-prefabs`, `-behaviors`,
  `-settings`), `descriptors.ts` 2,213 → 153 (+ `descriptor-types`,
  `-builders`, `-components`, `-content`), `runtime/src/types.ts` 2,489 → 323
  (+ `types-scene`, `-simulation`, `-behavior`, `-behavior-world`),
  `editor/src/session/client.ts` 2,417 → 773 (the HTTP project operations,
  a `SessionClient` subclass) + `client-core.ts` 1,667 (connection,
  projection, commands).
- 2026-09-29 (26.1 B): ESLint 10.11.0 (flat config, `defineConfig`),
  typescript-eslint 8.71.0 and eslint-plugin-react-hooks 7.1.1, versions
  checked on npm and the typed-linting setup against typescript-eslint.io;
  pinned in `check-deps`. `npm run lint` (`eslint.config.mjs`) runs in the
  fast and full gates after the build, about 40 s. Package sources get the
  typed rules through each package's tsconfig (project service); `tests/`
  and `tools/` have no tsconfig and get the untyped ones; the React hooks
  rules apply to the editor. `eqeqeq` ignores `== null` (the codebase's
  null-or-undefined idiom); `no-fallthrough` allows empty cases with
  comments between labels. Unused disables are errors, and a small local
  rule requires `-- reason` on every `eslint-disable`: the 101 inert
  disables (rules never configured: `no-explicit-any`, `no-console`,
  `no-this-alias`, …) were removed, the 34 live `exhaustive-deps` ones got
  their reason. Fixed without behaviour change: dependency keys extracted
  (`idsKey`, `hasLayer`), the stable `setSelectedId` added to five
  `useCallback` lists, one shared empty breakpoint list, `void` on
  `renderer.compute` (returns a promise only before init) and on the
  viewport's async gesture-end callback (its type now says so), a duplicate
  `runs` key in an evaluation probe (the first was always overwritten; now
  `runCount`). Left with a reason instead of a change of effect timing: the
  editor's key listeners installed once (their callbacks are declared later,
  so listing them would hit the temporal dead zone), `useWorkerJob`'s
  caller-given dependency list, and the block editor's slice reapplied per
  edited layer.
- 2026-09-29 (26.1 B): three.js 0.186.0 → 0.186.1. GitHub has no separate
  r186.1 release; npm 0.186.1 is the "r186 (bis)" commit on the r186 tag
  (2026-09-24), five fixes, all in the node/WebGPU renderer (the tarball diff
  touches nothing else; `three.module.js`, the loaders and the addons are
  byte-identical): #34567 `VelocityNode` camera-matrix uniform scoped to the
  render group; #34612 `NodeMaterialObserver` refreshes every material once
  on a resize (before, only transmission ones); #34640 `wireframe` is
  observed, so toggling it rebuilds the material; #34648 `Geometries`
  drops a disposed geometry's data (the leak class `dispose.ts` works around;
  its guarded deletes stay valid); #34650 `getSharedContext` clears loop
  state. No `@types/three` 0.186.1 exists; the 0.186.0 types stay (no API
  change). Per site: the package pins, `check-deps`, the export scan's
  identity record (`THREE_RECORD`: version and lockfile integrity; the
  pattern counts re-verified by `bundle-scan`) and `M3_ENGINE_PINS` (the
  table every current export manifest carries, so each game's build id
  changes once) move to 0.186.1. `M2_GLTF_TOOLCHAIN` stays 0.186.0: it
  names the GLTFLoader line of a model's import recipe, is part of every
  model's recipe digest, and the loader did not change. `M2_ENGINE_PINS`
  (the v1 manifest, test-only now) and the fixtures' recorded recipes stay
  as recorded. Version numbers in comments now say "the pinned three".
- 2026-09-29 (26.1 C): history comments. Comments are found with the
  TypeScript parser (the trivia before every token; JSX text excluded), never
  a regex over code. A scripted pass stripped leading tags ("Phase 23.4: ")
  and all-reference parentheticals ("(sessions.md §13.7)", "(packet 57)");
  per-package agents rewrote the rest by hand, including history told in
  words ("was 16", "no longer", "before the fix") and review ids (R7, C29-4,
  Gate B) that no pattern names. D-numbers are history too: a comment states
  the why, the audit list keeps the defect. `M1`–`M4` stay only inside live
  names (`M3_ENGINE_PINS`, `preview-m3.ts`); `decision 000N` (docs/decisions,
  live) may be cited without a section. Proof: `tools/emit-compare.mjs`
  compiles all 1,177 files of packages/*/src, tools/ and tests/ with
  `removeComments` (TypeScript `transpileModule`) and hashes the output:
  `record` before, `compare` after; byte-identical for every file (the tool
  itself was checked: stripping every comment it finds changes no output,
  and keeping comments shows none it missed). Test titles changed in their
  own commit (strings, so outside that proof); no title became a duplicate.
  `editor.css` comments were cleaned by hand. The guard is
  `tools/history-comments.mjs` in `npm run build` (after check-boundaries),
  not an ESLint rule: the build runs in every gate and before every start,
  it covers `tools/` and `tests/` the typed lint does not type, and it is
  one small script next to the other boundary checks; the patterns
  (`HISTORY_PATTERNS`) are defined there only, with a unit test for both
  sides (flags "since 24.8", leaves "the broad phase", "1.5 s", 3D alone).
  It checks comments and `describe`/`it`/`test` titles in packages/*/src,
  tools/ and tests/. Left for later: history in string literals the user or
  an AI client reads (MCP tool descriptions "(phase 25.17)", some error
  hints citing `§`, the export bundle header, `REMOVED_IN_PHASE_24`; the behavior API generators' headers were fixed, as the generated typings carry them); 26.14
  rewrites the MCP texts, the rest is logged as D60.
- 2026-09-29 (26.2): the scale bench writes the project's files directly
  (`tools/perf/scale-generate.ts`) instead of issuing commands: each command
  re-validates and rewrites the whole content document (at full size 11–26 s
  a command, so 26,000 imports would take days), and the caps refuse the
  build long before the size the bench is for. Every asset record is the
  proposal the backend's own inspector makes from the file's bytes, and the
  open runs the model's full validation, so the project is exactly what the
  imports would leave; a refused open is a measurement.
- 2026-09-29 (26.2): no Opus encoder on the hosts (no ffmpeg, opusenc or
  sox). Voice lines are assembled from a checked-in pool of real Opus packets
  (`tools/perf/fixtures/opus-pool.bin`, 61 KB, 12 tones × 2 s at 16 kbit/s,
  made by Chromium's WebCodecs `AudioEncoder` with `tools/perf/opus-pool.mjs`)
  and wrapped in Ogg pages by the generator: every file decodes as Opus and
  is distinct bytes, and generation needs no browser and is deterministic
  across Chromium upgrades. Other sounds are PCM WAV (today's `audio`
  profile), textures 64 px noise PNGs, models small textured spheres:
  counts are the subject; sizes are parameters.
- 2026-09-29 (26.2): the caps were lifted on a local scratch branch
  (`scratch/26.2-caps-lifted`, not pushed): the per-kind count caps, the
  version-record cap, the 1 MiB content cap and the 256 KiB manifest cap,
  each raised to a value never reached. The quota and Play-set byte caps
  were left (not reached). The dialogue is started by a bench script through
  a debug command after the click that unlocks sound; scenes are walked with
  the play relay's `loadScene`/`unloadScene` (what `ctx.scenes` does). The
  small-size run is in the fast gate's smoke set (about 25 s).
- 2026-09-29 (26.3 A): the catalog record stays in `content.json` for now
  (the index role 26.4 gives the resource files); the sidecar
  (`<file>.tlasset`: `tlasset: 1`, id, kind, import settings, labels,
  address) is written from it after every asset command and by the file
  check when missing or stale, and it is what identifies a moved file. The
  record keeps its shape with one version: a re-import replaces it and the
  version number only counts changes (`currentVersion + 1`); a legacy
  `modelAnimation` binding keeps the version it names.
- 2026-09-29 (26.3 A): uploaded bytes are held by digest
  (`.thirdlight/held/`, a day) and filed into the game folder when
  `publishAsset` commits them: the workspace chooses `assets/<name>.<ext>`
  (or the asset's own file on a re-import of the same kind of file) and
  writes the path into the command's args, so browsers, MCP and scripts that
  publish without a path keep working and the change, history and retry
  record carry the path. A project in the data root is its own game folder
  (its `project.json`, `content.json`, `scenes/`, `sources/`, `cache/` are
  never asset paths).
- 2026-09-29 (26.3 A): undo follows the files: `deleteAsset` deletes the file
  and sidecar (bytes held) and its undo puts both back; undoing an upload's
  replace writes the held old bytes back; undoing an import only forgets
  the asset (its sidecar goes, the file stays, as it was the user's).
  A move is `setAssetOptions {sourcePath}` (any kind, one undo): the
  workspace moves file and sidecar, or records a move made outside the
  editor; 26.13's `moveResources` can build on it.
- 2026-09-29 (26.3 A): "the backend notices" is one check
  (`POST …/content/files/check`; the editor on connect, window focus,
  after a publish and "check files"; MCP `tl_content_query {target:
  "integrity", check: true}`): a missing file is looked for by its sidecar
  and its record re-pointed, a changed file is imported again (converted
  first when it is an FBX or an image with a KTX2 setting), the import cache
  is made whole. Each change is an ordinary command (change feed, undo; origin
  `admin`/`file-check`). Before Play and export only the cache is made whole.
  A file the check cannot import (no Blender, an animated model whose roles
  must be chosen) stays a Problems row with the reason and "Re-import".
- 2026-09-29 (26.3 A): the import cache is
  `<project>/cache/imported/<source digest>/<importer>-<version>-<settings
  digest>/` (git-ignored: `cache/` is added to the project `.gitignore`):
  a GLB converted from an FBX and a KTX2 encoded from a PNG/JPEG
  (`<digest>.bin`), the inspected header of a file (used by the check's
  re-import), and the tile thumbnails (moved from `<dataRoot>/cache/`). A
  PNG/JPEG with a KTX2 setting is one asset whose file is the image; the
  record's `convertedFrom` states the encoding and the sidecar shows it as
  `importSettings.ktx2`. When the converter makes other bytes than recorded
  (another Blender), the check records them as a re-import.
- 2026-09-29 (26.3 A): a packed texture array's KTX2 is written as its own
  file (`assets/<name>.ktx2`) whose sidecar lists its sources by id and
  file, rather than a cache entry: packing reads other assets and is not a
  property of one file, and a file keeps it readable without the encoder.
  A changed source is not re-packed automatically (re-pack from the Assets
  tab); an asset tool's zip export lands as a folder `assets/<name>/` and
  its model is imported where it is.
- 2026-09-29 (26.3 A): the phase's format bump for `project.json` is
  schemaVersion 5 (the runtime manifest's 5 is 26.9's). A 4 is upgraded on
  open (`workspace/src/upgrade-assets.ts`): each asset's current version is
  written as a file with its sidecar (a converted version's original as the
  file, what was made from it into the import cache), the record keeps that
  version, older versions stay in `sources/sha256/` untouched and are listed
  in `upgrade-report.json` next to `project.json`; one new revision, retry
  records kept. Tested over HTTP on `fixtures/phase26/legacy-v4-assets`
  (written by the engine at `48a7bf98`): files, sidecars, cache, report,
  a recorded retry replayed, the export shipping the same bytes. The
  command corpus (`fixtures/commands`) and the M2 content-ops replay were
  re-derived for the new manifest version and the replaced-version record;
  each replay still passes byte for byte. Opening Sprout or Skyforge on this
  build upgrades them and writes their asset files and sidecars into their
  folders (the owner's open, as with earlier bumps).
