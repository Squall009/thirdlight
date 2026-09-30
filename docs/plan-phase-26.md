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
| 26.3 | done 2026-09-29: A files and sidecars (uploads filed into `assets/`, `.tlasset` sidecars, import cache, file check re-imports and follows moves, project.json 5 with the upgrade of a 4); B folder import with labels (`importAssets`, one undo; editor and MCP), uploads into the folder named, a folder uploaded file by file, labels on records and sidecars, whole-folder moves, upgrade report in Problems |
| 26.4 | done 2026-09-30: A storage out of `buildService` (typed readers); resources as files, asset records in their sidecars, `content.json` project-wide only; the index (`queryIndex`); validation of what a command touched (D61); one command's latency flat at full size (§6); environment presets as files (their order in `content.json`). B scenes as files anywhere in the game folder (`<name>.scene.json`), `folder` on every create (editor "new items in"), files added, moved, copied, changed or removed while open taken in by the file check (`importResources`, one undo), lost sidecars put back at the open (D63; D64 open) |
| 26.5 | done 2026-09-30: no per-project count cap on assets or resources (model, commands, editor, game host, MCP, docs; guarded by `tests/count-caps.test.ts` and `tests/e2e/count-caps.e2e.ts`); `MAX_CONTENT_FILE_BYTES` per file; no project quota (disk space only); manifest at the content file cap; animation keys per model; limits audit (§7; table in `docs/deployment.md`); full bench uncapped on main (§6) |
| 26.6 | done 2026-09-30: one `audio` kind (Ogg Vorbis/Opus, MP3, WAV integer or float, FLAC; any channels, rate, bits, length; the 32 MiB file cap only); header inspection per format; load type and preload in the sidecar (`setAssetOptions`), defaults by length, carried in the manifest; `music` and short-sound records upgraded on open (v4 and earlier v5, ids kept, replays answered); browser gaps as a Problem; asset inspector shows the facts and settings; e2e `audio-kinds` |
| 26.7 | done 2026-09-30: an address and labels on any asset (on its record, in its sidecar, format 3) or resource (in its resource file, beside the record); `setLabels {items: [{kind, id}], add?, remove?}` and `setAddress {kind, id, address}` (unique project-wide), one command and one undo however many items; the Assets tab labels a multi-selection and its side panel sets one asset's address and labels; MCP commands and index filters (`address`, `loadable`); loadable assets and materials ship with Play and export though no scene references them, and the manifest lists them (`loadable`); a script naming a non-loadable asset is a Problem; on open, older projects' script-named assets get the label `script-named` (reported in Problems and `upgrade-report.json`); e2e `loadable` |
| 26.8 | done 2026-09-30: a file's digest checked once per change (stamps in memory and in `cache/imported/file-stamps.json`, a restart hashes nothing unchanged); Play serves assets and instance buffers from disk at their digest URLs, verified while sent (a changed file refused, or cut short, and re-checked); the 512 MiB Play set cap gone (per held file only); record lookups and query pages from indexes, the integrity report paged (`limit`, `offset`, `problems`); the check before Play and export takes changed files in; full-size Play 9.0 → 2.8 s (§6); D67 logged, D68 fixed; e2e `play-files` |
| 26.9 | done 2026-09-30. A: runtime content manifest 5 (identity, settings, start scenes, the catalog's location; ~1.7 KB at any size); the catalog (root, block files in parts, entry shards by id with address, labels and dependencies, a dependency file per scene) read lazily by the game page (`openRuntimeContent`: a scene load reads its file and its dependency file, an unnamed id its one shard); a v4 build read the same way (fixture `legacy-v4-build`); D67 fixed; an asset property's default ships; the content view no longer validates or hashes what the model did; e2e `manifest-keys`, integration `m26-catalog`. B: the export copies assets and buffers from disk one at a time, hashed while copied (the 26.8 serving path), into a temp directory renamed into place (a failure leaves nothing); the bundle names no artifact (one relative reader by row path); one game page (`game-host/game-page`) starts Play and exports, their differences injected; full export 7.7 → 5.2 s, growth +171 → +104 MiB; HTTP test `export-streaming` |
| 26.10 | done 2026-09-30. A: one resource manager per game page (runtime `createResourceManager`, held by the game host and settled after each frame) for verified bytes, models, animation-only clips, textures, decoded audio, fonts, UI and glyph images, environment maps and effect models; each freed when its last holder (entity, scene being prepared, material, voice, UI layer…) went, a same-step transition keeps what both scenes use; the store forgets freed models; the decoded-music LRU replaced; scene preparation and read-ahead through it; the Scene view's models and material textures through its own manager; `resources` in `tl_game_observe` and Play diagnostics (handles slot for B); 50-scene walk: resident bytes of every kind back to zero, heap +50 → +5 MiB at full (§6); e2e `resource-manager`. B: `ctx.assets.load(id, address or label)` → a handle (loading, ready, failed) and `release`; the page loads what the key names (a prefab's or material's models and textures too) and holds it for the handle; the answer is the simulation's input (a recording replays it at its step, page and worker alike, a recorded input takes no live answer); a handle open when a run ends is released and reported (`resources.open`/`notReleased`, script log); visual-script nodes; bench step `handles`: 1,000 labelled assets loaded and released at full, resident back to zero (§6); a texture that is the sky and a map decoded once; compiled graph materials and their textures go with their last mesh; prefabs stay whole at open, no grace before a free (§7); e2e `asset-handles`, integration `m26-asset-handles` |
| 26.11 | done 2026-09-30: nothing audio is read at mount; each file loads by its load type through the resource manager (`audio` decoded, `audio-bytes` kept compressed and decoded per play, `audio-stream` a media element through Web Audio), held by its scene (preload) or from its first play by the scenes loaded then; a sound not ready starts when ready or is dropped past `maxLateMs` (script play/stinger, event cues, timeline keys, dialogue `voiceMaxLateMs`), reported in `audio.late`; a conversation reads its next voices ahead on every branch three lines deep (the next lines decoded); the per-kind audio stores gone; full 500-line dialogue: every voice heard, line → voice p95 0 ms, gap p95 12 ms, Play start reads no audio (§6); e2e `audio-loading` |
| 26.12 | done 2026-09-30: large KTX2 textures stream their mips in Play and the export under a texture budget (`texture_budget_mb`, default 512 MiB): the build cuts each into parts by level (import cache, catalog `mipParts`, shipped instead of the whole file), the page reads the tail first and larger levels by on-screen size (UV density and the camera), least-needed dropped first; `streaming` per texture (sidecar, `setAssetOptions`, the asset inspector; on above 1024 px); `resources.textures` in observe and diagnostics; bench step `stream` (full: level 0 in 102 ms p50, resident ≤ 7.75 of 8 MiB, Play start unchanged); e2e `texture-streaming` (pixels, both renderers, export); D70 fixed, D71–D73 logged |
| 26.13 | done 2026-09-30. A: the editor reads the project index in pages and records by id (no first 128 records), virtualized asset list and pickers, tiles from the import cache, the Scene view's cookies, environment and lightmaps in its resource manager, lazy dialogue voices; `App.tsx` and `viewport.ts` split; D74 fixed, D75–D78 logged. B: the project window (folder tree, every asset, resource and scene by folder, Unity search `t:`/`l:`, kind menu, sort, grid/list and tile size, breadcrumb, cut/paste and drag moves, new and renamed folders, double-click opens each kind's editor, labels on many items); `moveResources`, `renameFolder`, `createFolder` (one undo each, MCP too); `queryIndex` folder/recursive/folders/sort/labels; a move changes no built file; full: 1,000 files labelled 2.6 s, moved 4.4 s (fsync bound, D80) |
| 26.14 | done 2026-09-30 (phase review and `tools/gate.sh full` pending): after numbers on both renderers in §6 with targets fixed (three missed: Play start, backend resident at open — both revised with reasons —, export growth by 6 MiB; content-edit ratio); limits table per file and runtime budget only; MCP texts; D60 fixed with a string check in the build; D81 found and fixed |

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

After 26.3 B (1,000-file folder import, `--steps open,import`, the caps
lifted on the scratch patch for the run only; GPU host; 2026-09-29): 1,000
Opus voice files of 1–3 s, written into a new folder and imported with
labels in one `importAssets` command, round trip: small preset (60 assets)
0.65 s; ×0.1 (1,800 assets) 1.1 and 1.7 s — inspection 0.3 s, the command's
content validation 0.44 s (grows with the catalog: D61, 26.4), sidecars
0.2 s; one scene edit after it (2,800 assets) 175–227 ms. Before sidecars and
import-cache headers skipped their per-file flush: 7–11 s at ×0.1.

After 26.4 A (the resources and asset records as files, validation of what
a command touched; `--steps open,commands --gpu`, the caps lifted on the
scratch patch for the run only, generator version 4 — resources and sidecar
records as files, `content.json` 15 KiB; commit `d75b8d75`; 2026-09-30):

| | ×0.01 | full |
|---|---|---|
| open: backend's first read | 64 | 815 |
| open: editor connected / Scene view first frame | 712 / 530 | 883 / 552 |
| backend resident after open | 145 | 265 |
| command: scene edit (setTransform) | 5.7 / 16.2 | 8.3 / 26.7 |
| command: content edit (setMaterial) | 12.6 / 14.3 | 23.2 / 31.4 |

One command no longer grows with the project the way it did (full size: 11 s
and 26 s before): within 1.5× (scene edit) and 1.8× (content edit) of the
×0.01 project at p50; a content edit writes two files through the journal at
any size (its record and `content.json`, which carries the revision and the
retry record), the rest of both is the flushes (renaming into and flushing a
folder of 2,000 materials costs more than one of 20). Again at `51fc3260`
(an edit sets one record of its list; the material check only after changes
that reach materials), two runs each: full scene edit 7.7–7.8 / 21–66 ms,
content edit 22.6 / 31–36 ms, open 0.8–1.1 s; ×0.01 5.9 / 8 ms and
12.4–12.6 / 15–19 ms. The command's own work at full size (profiled, the
flushes left out) is 1–3 ms. Linear passes that remain
per command at full size, each well under a millisecond: the project-wide
id uniqueness over every entity, the asset list's counts when an asset
changes, the per-kind id sets when a record is added or removed.

After 26.4 B (scenes found in the game folder, the file check for resource
files, the record cache; same steps and scratch patch, commit `3eeb70bc`
against `dabb4473` built the same way, one after the other on the GPU host;
2026-09-30; p50 / p95 ms):

| | ×0.01 base / B | full base / B |
|---|---|---|
| open: backend's first read | 63 / 55–61 | 1,005 / 927 |
| open: editor connected / first frame | 856 / 564 — 862–870 / 587–590 | 1,086 / 600 — 1,041 / 642 |
| backend resident after open | 147 / 148–150 | 335 / 343 |
| command: scene edit | 12.3 / 14.3 — 10.8–12.1 / 13.8–17.4 | 13.4 / 17.5 — 15.0 / 41.5 |
| command: content edit | 31.1 / 46.8 — 30.0–31.7 / 34.3–34.9 | 40.4 / 51.6 — 39.9 / 44.9 |

No change beyond run-to-run spread (this session's host is slower than 26.4
A's, base included). The full-size scene-edit p95 of B's run includes the
record cache being filled in the background after that first open (18,000
sidecar copies in batches of 256 between commands; later opens find it
filled). The 1.5 s poll no longer hashes the game folder's thousands of
resource files; the file check's cost at full size is 26.8's to measure.

After 26.5 (no count caps on main, no scratch patch: the first uncapped run
on main; `node tools/perf/run.mjs scale --preset full --gpu`, commit
`efc3eeeb`, GPU host, 2026-09-30; report
`scale-full-2026-09-30T03-08-27-613Z.json`): every step ran at full size
(18,000 assets, 5,000 prefabs, 2,000 materials, 300 scenes, 2,000 voiced
lines).

| | full (26.2, scratch) | full (26.5, main) |
|---|---|---|
| open: backend's first read | 6,703 | 954 |
| open: editor connected / Scene view first frame | 1,128 / 603 | 1,064 / 644 |
| backend resident after open | 560 | 342 |
| command: scene edit (setTransform) | 11,198 / 11,804 | 15.7 / 43.8 |
| command: content edit (setMaterial) | 26,057 / 27,505 | 44.1 / 63.9 |
| Play: click → first frame | 22,778 | 9,033 |
| Play: backend build (closure) / manifest bytes | 22,077 (22,048) / 9.2 M | 8,358 (6,772; its asset reads 5,354) / 9.2 M + 2 content files 0.97 M |
| scene load: request → drawn (game timings) | 138 / 156 | 145 / 158 |
| walk: scenes; heap before → after | 50; 66.2 → 115.1 | 50; 67.0 → 115.8 |
| walk: live GPU textures before → loaded → after | 4 → 49 → 5 | 4 → 49 → 5 |
| dialogue: lines heard; line → voice p95; gap p50 / p95 / max | 500/500; 35; 4 / 11 / 28 | 500/500; 35; 6 / 10 / 26 |
| export: time; files; MiB; exported first frame | 9,058; 9,309; 119; 852 | 12,175; 9,309; 119; 848 |

Nothing is refused any more. What still does not scale is the later items':
Play start is 9 s and grows with the asset count (the backend's closure reads
and verifies every reachable asset, 5.4 s of it: 26.8); the manifest is 9.2 MB
because asset rows, rigs and prefabs are inline (26.9); the heap grows about
1 MiB per distinct scene walked and is not given back (26.10); every `audio`
asset is still read and decoded at mount (26.11); the export bundles every
reachable file into memory (12 s: 26.9). This session's host ran 26.4 B's
commands at 13–15 / 40 ms (§6 above), so the command numbers are within
spread of that run.

After 26.6 (one audio kind; generator version 5 — voices are `audio`
records with preload off, sounds `audio` decoded on load; `--factor 0.1
--steps open,play,dialogue --gpu`, commit `2f9e9f34`, 2026-09-30; report
`scale-x0.1-2026-09-30T04-00-01-131Z.json`): Play click → first frame
867 ms (905 in 26.2), backend build 403 ms; the 200-line voiced dialogue
heard 200/200, line → voice p50/p95/max 32/34/40 ms, gap p50/p95/max
5/10/17 ms (26.2: 35 p95, 5/11/26). The voices take the same path as the
`music` records did (read on first use, decoded when played), so no change
beyond spread; the 100 sounds are still decoded at start (26.11).

After 26.7 (addresses and labels; generator version 6 — sidecars in format
3, no labels, so nothing extra ships; `--factor 0.1 --steps
open,commands,play --gpu`, commit `2a313745`, 2026-09-30, five runs; report
`scale-x0.1-2026-09-30T04-54-31-021Z.json` and four more): open backend
125–204 ms, editor connected 0.99–1.19 s; scene edit p50 5.4–7.3 / p95
8.6–32 ms, content edit p50 13.5–15.0 / p95 14–25 ms; Play click → first
frame 872–1,225 ms (backend build 428–524, closure 267–317); manifest
927,842 B, the same bytes as before (no `loadable` rows without labels). Two
runs of `360abfc0` in the same session: Play 919–954 ms, closure 269–283, so
Play is within spread; that build's open (4.6–4.9 s) and commands (41–124 ms
p50) read its own generator-5 cached project and are not compared.

After 26.8 (backend reads: files checked once per change, Play assets
served from disk, lookups and pages from indexes; `--steps files,open,play
--gpu`, the reads' code at `c108a1bd` plus its follow-up (roots resolved once
per pass, a stat before any open), GPU host, 2026-09-30; reports
`scale-small-2026-09-30T06-23-11-133Z.json`,
`scale-x0.1-2026-09-30T06-23-25-109Z.json`,
`scale-full-2026-09-30T06-22-35-745Z.json`; ms, MiB):

| | small (60 assets) | ×0.1 (1,800) | full (18,000) | full before (26.5) |
|---|---|---|---|---|
| file check: first after the copy (every file hashed) / again / first after a restart | 13 / 15 / 12 | 147 / 132 / 167 | 990 / 492 / 628 | not measured (each check hashed every file past a 1,024-entry cache) |
| Play: click → first frame | 432 | 670 | 2,816 | 9,033 |
| Play: backend total (pre-Play check; closure; its asset stage) | 45 (–; 26; 2) | 215 (–; 167; 13) | 1,623 (230; 1,368; 107) | 8,358 (–; 6,772; 5,354) |
| backend resident: after open / peak during the start / after the stop | 143 / 160 / 144 | 182 / 215 / 215 | 374 / 498 / 473 | 342 after open |

The asset stage no longer grows with the project (107 ms for 18,000 assets:
one stat each; it was 5.4 s of reading and hashing), and the backend holds no
asset bytes (the Play set held every reachable file before). What still grows
with the asset count at full size: the content view (`closure.view` 788 ms, a
first build of the capture) and the 9.2 MB inline manifest (`closure.manifest`
442 ms, and most of the ~125 MiB the backend gains during the start: the
manifest, the view and the remembered derivation) — both 26.9's catalog; the
pre-Play check (230 ms, one stat per asset). A first run of the same commit
before the follow-up measured the file check at 2.5 / 2.0 / 2.2 s and Play at
5.6 s: the check spent its time resolving the game folder's real path for
every file and opening each file to stat it, and blocked the event loop while
the editor's connect-time check ran, delaying the Play request behind it.

After 26.9 A (manifest 5 and the lazily read catalog; `--steps
files,open,play,walk,dialogue --gpu`, the working tree on `8c21bfa3`, GPU
host, 2026-09-30; reports `scale-small-2026-09-30T07-17-16-074Z.json`,
`scale-x0.1-2026-09-30T07-17-44-874Z.json`,
`scale-full-2026-09-30T07-21-33-110Z.json`; ms, MiB):

| | small (60 assets) | ×0.1 (1,800) | full (18,000) | full before (26.8) |
|---|---|---|---|---|
| Play: click → first frame | 437 | 577 | 1,278 | 2,816 |
| Play: backend total (closure; view / assets / manifest) | 42 (14) | 117 (70) | 736 (476; 208 / 110 / 134) | 1,623 (1,368; 788 / 107 / 442) |
| what the page reads at open: manifest + catalog files | 1.8 K + 7 files 16 K | 1.8 K + 7 files 263 K | 1.8 K + 8 files 2.6 M | 9.2 M + 2 files 0.97 M |
| backend resident: open / peak during the start / after the stop | 147 / 163 / 179 | 180 / 212 / 245 | 368 / 458 / 375 | 374 / 498 / 473 |
| scene load (walk): request → drawn p50 / p95 | 64 / 115 | 103 / 156 | 138 / 176 | 145 / 158 (26.5) |
| dialogue: heard; line → voice p95; gap p95 / max | 6/6; 35; 4 / 4 | 200/200; 34; 10 / 12 | 500/500; 35; 10 / 23 | 500/500; 35; 10 / 26 (26.5) |

Play start at full is 1.3 s (it was 2.8 s): the manifest is 1.7 KB and the
page reads 2.6 MB of catalog files at open (the prefabs 1.6 MB, the
simulation's facts, materials and dialogue), none of the entry shards; each
scene load reads its scene file and its dependency file (walk: read p50
3 ms), a voice its shard once. Still growing with the asset count: the
blocks the simulation needs whole (above), the backend's entries and
dependency files (`closure.manifest` 134 ms), the content view (208 ms: the
references of every scene and prefab and the view's digest) and one stat per
asset (the locate 110 ms and the pre-Play check). The heap still grows over
the walk (61 → 112 MiB): 26.10.

After 26.9 B (export streamed to disk, one game-page bootstrap, the bundle
names no artifact; `--steps open,export --gpu`, each size run on `2a4e507c`
(before) and on the working tree with this change (after), GPU host,
2026-09-30; the backend's resident set sampled every 50 ms during the export
request; the exported game served by a static server with the backend
stopped; reports `scale-{small,x0.1,full}-2026-09-30T07-5*`; ms, MiB):

| | small (60 assets) before / after | ×0.1 (1,800) before / after | full (18,000) before / after |
|---|---|---|---|
| export request | 982 / 1,038 | 1,616 / 1,539 | 7,715 / 5,187 |
| backend resident: before the export → peak (growth) | 145 → 210 (+65) / 147 → 206 (+59) | 182 → 258 (+77) / 181 → 252 (+70) | 350 → 520 (+171) / 354 → 458 (+104) |
| output: files; MiB | 76; 13.4 / 76; 13.4 | 976; 21.6 / 976; 21.3 | 9,644; 123.5 / 9,644; 120.5 |
| exported game (backend stopped): first frame; state | 509 / 537; running | 560 / 563; running | 680 / 630; running |

The 26.5 full export was 12.2 s with 9,309 files; 26.9 A's catalog files
made it 9,644 files and 7.7 s. Streaming takes the full export to 5.2 s and
its growth from +171 to +104 MiB: no asset's bytes are held (each file is
copied, hashed while copied and checked, one at a time); what still grows
with the asset count is the closure's metadata that Play's start also builds
(the content view, the catalog's entries and dependency files, 14 MB of
catalog files held until written; Play's start at full peaks at 458 MiB
too). The output is 3 MB smaller: the page bundle no longer carries every
path (it is now the same bytes for any project with the same modules).

After 26.10 A (the resource manager; `--steps open,play,walk --gpu`, the
same session on the GPU host: before = `8fab4d51` built as is, after = the
working tree with this change, both with the bench reporting the resource
manager when there is one; reports `scale-{x0.1,full}-2026-09-30T09-0*`;
heap after a collection, MiB):

| | ×0.1 (29 scenes) before / after | full (50 scenes) before / after |
|---|---|---|
| walk: heap before → most → after | 51.4 → 66.2 → 65.5 / 47.6 → 53.6 → 51.5 | 61.1 → 112.7 → 111.5 / 57.3 → 64.6 → 62.5 |
| walk: heap growth over the walk | +14.1 / +3.9 | +50.4 / +5.2 |
| walk: resident KiB per kind before → most → after (the manager) | not observable / model 0 → 78.9 → 0; texture 0 → 1,024 → 0 | not observable / model 0 → 75.3 → 0; texture 0 → 960 → 0 |
| walk: loads = frees (bytes / model / texture) | – / 1,800 / 500 / 1,300 each | – / 3,060 / 850 / 2,210 each |
| walk: asset bytes read | 6.0 / 15.6 MiB | 26.6 / 26.6 MiB |
| walk: scene load request → drawn p50 / p95 (ms) | 68 / 86 — 119 / 144 | 120 / 138 — 120 / 128 |
| walk: live GPU textures before → loaded → after | 4 → 50 → 5 / 4 → 50 → 5 | 4 → 49 → 5 / 4 → 49 → 5 |
| Play: click → first frame (ms) | 709 / 782 | 2,199 / 2,329 |

Walking frees what each scene used: after every unload the resident bytes of
each kind are back at the start's (zero here: the start scene draws nothing
from assets), and every load has its free. The heap growth that remains
(+3.9 / +5.2 MiB) is, by a heap snapshot diff before and after the ×0.1 walk
(+4.1 MiB), V8's compiled code (+2.5 MiB, the node programs' JavaScript
warming up) and strings and catalog rows read (the catalog keeps the rows and
dependency lists it read, a few KiB per scene); no parsed file, material,
texture or buffer is left. The first run of this change still grew +26.7 MiB
at full: the visual resource store kept each freed model reachable through
its last load's handle (200 `GLTFParser`s alive after the ×0.1 walk); the
store now forgets it (§7). What freeing costs: a model or texture a later
scene uses again is read (from the HTTP cache) and decoded again. At ×0.1,
where 29 scenes share 1,800 assets, the walk reads 15.6 MiB instead of 6.0
and a scene load is drawn after 119 ms p50 instead of 68 (a scene read
ahead is prepared before the load); at full (18,000 assets, fewer shared)
the same as before.

After 26.10 B (scripts' asset handles; `--steps open,play,walk,handles --gpu`,
the working tree with this change on the GPU host; reports
`scale-x0.1-2026-09-30T09-57-28-550Z`, `scale-full-2026-09-30T10-01-02-761Z`;
the generator (version 7) labels `labelled` textures and models alternately
`bench-batch`: 100 at ×0.1, 1,000 at full). The bench's script loads the
label with `ctx.assets.load`, waits for the handle to be ready, releases it,
and does it all again; heap after a collection, MiB:

| | ×0.1 (100 labelled) | full (1,000 labelled) |
|---|---|---|
| command → handle ready (again) | 127 (133) ms | 1,607 (1,265) ms |
| ids the handle names; asset bytes read per load | 100; 0.7 MiB | 1,000; 7.6 MiB |
| resident KiB before → held → after the release | model 0 → 203 → 0; texture 0 → 1,067 → 0 | model 0 → 2,060 → 0; texture 0 → 10,667 → 0 |
| heap before → held → after (second cycle: held → after) | 51.5 → 54.5 → 52.3 (54.5 → 52.3) | 58.1 → 82.1 → 66.7 (76.4 → 66.7) |
| catalog files read before → after | 1.00 → 1.00 MiB (36 → 37 files) | 2.50 → 3.42 MiB (8 → 14 files) |
| release → settled | 14 ms | 50 ms |

"A script loads 1,000 assets by label and releases them; resident memory
returns to where it was": every kind's resident bytes are back at zero after
the release, the GPU's live textures unchanged (4 → 4: loaded, not drawn).
The heap keeps +8.6 MiB after the first cycle at full and nothing after the
second (66.7 → 66.7): the first load read the loadable index and five entry
shards (0.92 MiB of catalog JSON, kept like every row read) and compiled the
parsers' code on first use; nothing a handle loaded stays.

The re-reads freeing at zero costs (26.10 A's trade-off), measured on the
×0.1 walk with the page's Resource Timing (a fetch that transferred nothing
was answered by the browser's HTTP cache): 1,858 fetches, 1,100 of them from
the cache; 7.3 MiB crossed the network of 16.6 MiB read (6.0 MiB is the
distinct assets' first reads). Scene load request → drawn p50 110 / p95 121
ms (A: 119 / 144; before A: 68 / 86). What a re-read costs is the decode
(hash, parse, texture decode), not the backend.

After 26.11 (audio loaded by load type; `--preset full --steps
open,play,dialogue --gpu` and `--preset small`, the working tree on
`d975b882`, GPU host, 2026-09-30; reports
`scale-full-2026-09-30T10-54-49-646Z.json`,
`scale-small-2026-09-30T10-54-14-589Z.json`). The walkthrough's voices are
the generator's 1 s lines, decode on load, preload off: each is read and
decoded when the conversation is three lines before it (the next line
decoded), none at the start.

| | full before (26.9 A) | full after |
|---|---|---|
| Play: click → first frame; audio files read before it | 1,278; every start-row sound decoded at mount | 1,234; 0 (`startAssetReads` 0) |
| dialogue: lines heard | 500/500 | 500/500 |
| dialogue: line start → voice playing p50 / p95 / max (ms) | – / 35 / – | 0 / 0 / 16 (only the first line: not read ahead, 18 ms late) |
| dialogue: gap p50 / p95 / max (ms, the relay's resolution 5–10 ms) | – / 10 / 23 | 7 / 12 / 23 |
| dialogue: voices started late / dropped | not observable | 1 / 0 |
| resident audio KiB during (most) → after | not observable | before 0; most `audio` 1,027 + `audio-bytes` 10; after `audio` 171 (the first line's voice, kept by the start scene from its first play) |

A voice now starts on the step its line starts (it was read, decoded and
waited on per line: 35 ms p95). The gap between one voice ending and the
next starting stays what the relay's observation round trip resolves
(5–10 ms per poll); what the ear hears is owner listen pending. Resident
audio during the conversation is the voices three lines ahead and the one
playing (about 1 MiB of decoded 1 s mono voices), not the conversation's
500. Play start does not read audio at any size (it read and decoded the
start rows' decode-on-load sounds before).

After 26.12 (texture streaming; the working tree on `3f4171e0`, GPU host,
2026-09-30; reports `scale-full-2026-09-30T12-01-30-332Z.json` (`--steps
open,play,walk,stream`), `…12-04-42-475Z.json` and `…12-02-55-676Z.json`;
baseline A/B from a worktree at `3f4171e0`: `…12-05-21-488Z.json`,
`…12-05-51-097Z.json`). The stream step imports six 2048² checkers as KTX2
colour (ETC1S, transcoded to BC7 on this GPU: 5.33 MiB a whole chain), puts
each on a box in a scene of its own, sets an 8 MiB budget, loads the scene
and brings the boxes up to the camera one after another (the one before sent
back), polling the observation between moves.

| | full |
|---|---|
| stream: a box brought close → its full-size level resident p50 / p95 / max (ms) | 102 / 121 / 121 |
| stream: resident texture bytes, most of 254 observations / budget | 7.75 / 8 MiB (0 observations over) |
| stream: mip tail per texture; levels read; drops | 21.4 KiB; 24 (4 per texture); 9 |
| stream: after the scene unloaded | 0 bytes |
| walk 50: texture bytes before → most → after (512 MiB budget; nothing streams) | 0 → 0.94 → 0 MiB; scene load p50 136 / p95 164 ms (140 / 171 in the run with the stream step) |
| Play: click → first frame, files,open,play (baseline `3f4171e0` / 26.12) | 1,903 / 1,907 ms |
| Play: click → first frame, open,play (baseline / 26.12, three runs) | 2,220 / 2,276–2,315 ms |

Play start does not regress: the same steps on the same host within minutes
give the same time before and after (the page's part, response → first
frame, is 425 ms either way). Both are above 26.11's 1,234 ms because the
Play request now waited 0.7–1.1 s for the file check the editor starts on
connect (a freshly copied project hashes its 18,000 files once; 26.11's run
waited 59 ms): the bench's copy, not the build. In the e2e (2048², a box
filling the Play view) the full-size level arrives 117–122 ms (WebGPU)
and 365 ms (WebGL 2) after the box is brought close, the picture then shows
the checker's squares (luma steps in 20 % of samples; the tail is flat
grey), and under a 9 MiB budget the resident bytes peak at 6.67 MiB. The
import of the six textures raised the backend's resident set 408 → 795 MiB
and it stayed there: the KTX2 encoder's worker is kept with its WASM heap
(D72).

After the fixes between 26.12 and 26.13 (Play joins a file check that is
running; the check's walk over the assets gives the event loop back every
16 ms; the connect check's Problems report waits a turn; the KTX2 worker
ends after 10 s idle). The working tree on `581eeb86`, GPU host,
2026-09-30, one run each; before = the same tree with the old pre-Play
check (a second pass queued behind any running check); reports
`/tmp/d73/bench-{base,after}-*.json` (not kept). The Play request's
backend stages now name the pre-Play check (`check`) apart from `state`
(ms):

| Play: click → first frame (response; backend total; its pre-Play check) | small (60) | ×0.1 (1,800) | full (18,000) |
|---|---|---|---|
| fresh copy, Play right after the editor connects (`open,play`), before | 451 (102; 38; 3) | 709 (319; 165; 60) | 2,406 (1,979; 798; 242) |
| the same, after | 467 (118; 40; 3) | 692 (249; 127; 21) | 2,018 (1,372; 1,176; 637 joined) |
| files hashed first (`files,open,play`), before | 463 (100; 39; 3) | 722 (307; 144; 25) | 1,940 (946; 799; 280) |
| the same, after | 430 (87; 34; 1) | 553 (180; 113; 18) | 1,790 (1,052; 763; 245) |

Confirmed: on a fresh copy the Play request sat about 1.2 s in the event
loop (response 1,979 ms against 798 ms of backend work) while the editor's
connect check hashed 18,000 files in one synchronous pass, and then ran a
second pass of its own (242 ms). Now it is answered between slices of that
walk, joins it (637 ms: the rest of the one-time hashing) and runs no
second pass: full 2.41 → 2.02 s. Play start still grows with the asset
count: with no check running, the pre-Play pass is one walk over every
asset (about 14 µs each: 1 / 18 / 245 ms), and the closure's stat of each
shipped file (`closure.assets` ~110 ms at full) and the content view stay;
a pre-Play pass that visits only files changed since the last check needs
a file watcher (Unity's directory monitoring) — for 26.14 to weigh against
its targets. The KTX2 worker (D72), small preset `open,play,stream`, six
2048² encodes: backend resident after the import / after the Play stopped
(~13 s later) 544 / 571 MiB with the worker kept, 690 / 414 MiB ended when
idle; the encoder alone in a test process, six encodes then 20 s:
kept ≈ 600 MiB, ended 271–292 MiB (started at 130).

The editor at scale (26.13 A), the bench's new `editor` step
(`tools/perf/scale-editor.ts`), full size (18,000 assets), GPU host,
`c4a7011f` plus the step's driver fixes, 2026-09-30, one run
(`scale-full-2026-09-30T15-16-29-072Z.json`); before = the open step at
`3f4171e0` (eight runs), when the editor held the first 128 assets, prefabs
and scripts and drew its tiles from each texture's bytes and each model
parsed on the page:

| | before (`3f4171e0`) | after |
|---|---|---|
| editor open → connected | 949–1,109 ms | 1,099–1,246 ms |
| open → usable (the asset list drawn with the catalog's size) | – (128 of 18,000 listed) | 1,304 ms (18,000 listed) |
| editor heap after the open | 35.8–38.5 MiB | 35.3–36.0 MiB |
| the asset list scrolled top to bottom (7,200 screens, one per frame) | – | 120 s; frame p50/p95/max 16.7/16.7/16.8 ms; heap 35.9 → 47.0 MiB; 70 index pages, 2,636 summary reads, 8,334 thumbnail reads, 667 model files read to draw thumbnails (none of any other kind) |
| a picker search (10,000 voices; "Voice 9999") | – (a `select` of the first 128) | 38 ms to the match shown |
| placing a model at list position 11,000 | – (not listed) | 115 ms click → the object in the backend |
| a dialogue line given a voice through the picker | – | 91 ms pick → stored |

The heap growth over the scroll is the summaries read (one per tile seen,
kept) and the 512 picture URLs kept; the frame time is the display's
(vsync): no frame over 16.8 ms. At ×0.1 the end-to-end test
(`editor-scale.e2e.ts`) sees every one of 1,800 tiles, reads no texture or
sound bytes, and on the next open no bytes at all besides the placed model's
in the Scene view. The connect is ~0.1 s slower: not investigated (within
the run-to-run spread of the open step, 0.95–1.25 s over these runs).

The project window (26.13 B), the bench's `editor` step (its new part,
`tools/perf/scale-project.ts`, also driven by `editor-scale.e2e.ts` at ×0.1),
full size, GPU host, the working tree on `2ed970e8`, 2026-09-30, one run
(`scale-full-2026-09-30T17-31-23-721Z.json`): 1,000 of the 10,000 voice
files in `assets/voice`, chosen with a click and a Shift-click 1,000 tiles
down, labelled from the labels bar, cut, and pasted into a new folder beside
them; then both undone from the Edit menu:

| | full (18,000 assets) | ×0.1 (e2e, same host) |
|---|---|---|
| Shift-click → 1,000 chosen (the range read from the index) | 66 ms | 86 ms |
| "add labels" → labelled (one command, one revision) | 2,603 ms | 2,490–2,532 ms |
| Ctrl+V → moved: 1,000 files and 1,000 sidecars (one command, one revision) | 4,352 ms (listed in the window 4,434 ms) | 3,751–3,762 ms |
| Undo of the move / of the label | 7,735 / 3,010 ms | 3,692–3,756 / 6,509–6,529 ms |
| In memory on tmpfs (×0.1, workspace service alone): label / undo / move / undo | – | 218 / 231 / 418 / 373 ms |

The time is the transaction's `fsync` of every file (a profile of the ×0.1
run: 14 s of `fsyncSync`), not the project's size; the backend answers
nothing meanwhile (D80).

After D80's fix (a command of several files is answered once its journal is
on disk; its files are renamed into place at once and flushed in the
background, a few at a time and each directory once), the same step, full
size, GPU host, 2026-09-30 (`scale-full-2026-09-30T17-50-16-752Z.json`):
labelled 2,603 → 354 ms, moved 4,352 → 641 ms (listed 747 ms), undo of the
move 7,735 → 575 ms, of the label 3,010 → 402 ms. The workspace service
alone at ×0.1 on the same disk (the flush measured to its end): label /
move / undo move / undo label answered in 155 / 314 / 252 / 151 ms, on disk
0.2–0.3 s (label) and 1.0 s (move) after that; the longest event-loop stall
over the four 0.3–0.5 s (the commands themselves), where it was 6.5–7.8 s. The rest of the step is as in 26.13 A: usable
585 ms, the scroll (9,600 screens now: the list is narrower beside the
folder tree) at frame p50/p95/max 16.7/16.7/16.8 ms.

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

### After (26.14, 2026-09-30)

Host and command as for the before numbers (GPU host, Iris Xe; Chromium of
Playwright 1.62.1), commit `971cbe33` with 26.14's working tree (messages and
tool texts, the behavior-module cap gone: nothing on a measured path). Two
whole-bench runs at full size, one per renderer, every step in the order
files, open, commands, editor (the project window included), stream, play,
walk, handles, dialogue, export (`--steps
files,open,commands,editor,play,walk,handles,dialogue,stream,export --gpu
--renderer webgl2|webgpu`; reports `~/.cache/thirdlight-phase26/2614/full-{webgl2,webgpu}.json`);
then per renderer ×0.01 and ×0.1 (`files,open,commands,play`) and a clean
full Play and export (`files,open,play,export`, `fullplay-*.json`); a full
run of 60 command round trips (`cmd-full.json`) and a full export straight
after the open (`export-full.json`). The renderer that drew is read off the
Play canvas (`data-tl-renderer`, a bench addition): "WebGPU on intel
gen-12lp" and "WebGPURenderer on its WebGL 2 backend". Nothing broke on
either renderer. Times in ms (p50 / p95), memory in MiB; two numbers in a
cell are WebGL 2 / WebGPU.

| | target (fixed from 26.2's before) | ×0.01 | ×0.1 | full | before (26.2 full, caps lifted) | result |
|---|---|---|---|---|---|---|
| open: backend's first read | ≤ 2,000 | 31 / 33 | 161 / 111 | 818 / 821 (clean 976 / 819) | 6,703 | pass |
| open: editor connected | ≤ 2,000 | 818 / 776 | 830 / 735 | 918 / 882 | 1,128 | pass |
| backend resident after open | ≤ 300 (proposed) → revised ≤ 400 | 154 / 153 | 184 / 184 | 354 / 352 (351–357 over six runs) | 560 | **fails 300**, meets the revision (§7) |
| command: scene edit (setTransform) | p95 ≤ 100, within 2× of ×0.01 | 5.9 / 8.2 — 5.4 / 7.6 | 6.6 / 35 — 5.7 / 43 | 24.1 / 51.3 — 22.8 / 50.1 (60 round trips: 8.6 / 23.8) | 11,198 / 11,804 | p95 pass; p50 1.5× (60 trips) pass; p95 2.9× **fails** |
| command: content edit (setMaterial) | p95 ≤ 100, within 2× of ×0.01 | 8.3 / 11.1 — 7.7 / 10.3 | 7.0 / 14.3 — 9.4 / 13.6 | 20.1 / 32.5 — 19.1 / 29.8 (60 trips: 21.4 / 37.4) | 26,057 / 27,505 | p95 pass; 2.6× p50 **fails** |
| Play: click → first frame | ≤ 1,500 and within 1.5× of ×0.01 (proposed) → revised ≤ 2,000, backend ≤ 50 µs per asset | 467 / 496 | 579 / 588 | clean 1,619 / 1,659; in the whole run 1,717 / 1,819 | 22,778 | **fails 1.5 s and 1.5×** (3.5×), meets the revision (§7) |
| Play: backend total (pre-Play check; closure: view / assets / manifest) | does not grow (proposed) | 41 (3; 10 / 2 / 5) | 117 (24; 35 / 12 / 20) | 845 / 805 (248 / 237; 249 / 128 / 154) | 22,077 | **grows**: 45 µs per asset (§7) |
| Play: what the page reads at open | – | 1.8 K + 6 files 27 K | 1.8 K + 6 files 262 K | 1.8 K + 7 files 2.6 M | 9.2 M | – |
| walk 50 scenes: heap before → most → after | after within 5 MiB of before | – | – | 69.5 → 76.4 → 74.4 (+4.9) / 69.6 → 76.6 → 74.6 (+5.0) | 66.2 → 115.1 (+48.9) | pass (at the edge) |
| walk: resident KiB per kind before → most → after | back to before after each scene | – | – | model 2.3 → 77.6 → 2.3, texture 0 → 960 → 0 (both); loads = frees (bytes 3,060, texture 2,210, model 850 / 849: the start scene's) | not observable | pass |
| walk: live GPU textures before → loaded → after | back to baseline | – | – | 6 → 50 → 6 / 8 → 52 → 8 | 4 → 49 → 5 | pass |
| walk: scene load request → loaded p50 / p95 (drawn p95) | p95 ≤ 200 | – | – | 155 / 176 (150) — 126 / 150 (184) | 138 / 156 (drawn) | pass |
| textures inside their budget: stream step (six 2048² KTX2, 8 MiB budget) | resident ≤ budget at every observation | – | – | most 7.75 MiB of 8, 0 of 248 / 216 observations over; close → full size 101 / 122 — 96 / 119; 0 after the unload | not observable | pass |
| walk under the default 512 MiB budget: texture bytes before → most → after | – | – | – | 0 → 0.94 → 0 (both) | – | – |
| 500-line voiced dialogue: heard; line → voice p95 / max; gap p50 / p95 / max | every voice heard, gap p95 ≤ 20, max ≤ 50 | – | – | 500/500; 0 / 12; 4 / 12 / 26 — 500/500; 0 / 15; 5 / 12 / 28 | 500/500; 35 / –; 4 / 11 / 28 | pass |
| dialogue: voices started late / dropped | – | – | – | 1 (the first line, 19 ms) / 0 — 1 (20 ms) / 0 | not observable | – |
| 1,000 assets by label: ready (again); resident KiB before → held → after | resident returns to where it was | – | – | 1,431 (1,360) / 1,604 (1,520); model 2.3 → 2,060 → 2.3, texture 0 → 10,667 → 0 (both); heap 74.1 → 96.5 → 81.6, second cycle → 81.6 (both alike) | not possible (caps) | pass |
| project window, 1,000 voice files: chosen / labelled / moved (listed) / move undone / label undone | – | – | – | 67 / 284 / 546 (633) / 460 / 335 — 66 / 350 / 602 (687) / 533 / 351 | not possible | – |
| editor: open → usable (18,000 listed); scroll of every tile, frame p50 / p95 / max; picker search; place | – | – | – | 564 / 560; 16.7 / 16.7 / 16.8 (both, 9,600 screens); 31 / 34; 70 / 70 | 128 listed | – |
| export: time; files; MiB | ≤ 15,000 | – | – | 3,754 / 4,151 (clean 3,636 / 3,940; after the open 4,792); 9,645–9,677; 121 | 9,058; 9,309; 119 | pass |
| export: backend resident growth | ≤ 100 above the open's | – | – | straight after the open: 351 → 457 (**+106**); after a Play: 430 → 499 (+69) / 429 → 497 (+68) | – | **fails by 6 MiB** |
| exported game (backend stopped): first frame | ≤ 1,500 | – | – | 640 / 663 (clean 696 / 612) | 852 | pass |
| file check: first after the copy / again / after a restart | – | 85 / 40 / 25 | 232 / 138 / 265 | 1,391 / 673 / 800 | – | – |

What still grows with the asset count, and why the three misses are left:

- **Play start** (1.6–1.8 s at full, 0.47–0.50 s at ×0.01): the page's part
  (response → first frame) is 0.36–0.40 s at ×0.01 and 0.64–0.65 s at full,
  the 2.6 MB of blocks read whole at open (the prefabs 1.6 MB of it, kept
  whole for deterministic spawns, §7); the backend's part grows by 45 µs per
  asset: the pre-Play check (one `stat` per asset, 240–300 ms),
  the closure's locate of every shipped file (a second `stat` each,
  120–300 ms), the content view (references of every scene and prefab,
  ~240 ms) and the catalog's entries and dependency files (~150 ms). Meeting
  1.5 s needs the two stat walks merged or a file watcher; both change how a
  changed file is caught before Play and are left with their reasons (§7).
- **Backend resident after open** (352–357 MiB): the backend keeps the index
  and every asset and resource record in memory, about 7 KiB per record over
  the empty project's ~150 MiB (18,000 assets, ~9,300 resources and scenes).
- **Content edit** (21 ms at full against 8 at ×0.01, p95 37 against 11):
  a content edit writes its record and `content.json` through the journal
  and the flushes of a folder of 2,000 materials cost more than of 20
  (26.4 A); the command's own work at full is 1–3 ms. Scene edit p95 in the
  whole-bench runs (50 ms) includes the record cache being filled in the
  background after the open; 60 trips give 23.8.
- **Export growth** (+106 MiB): the closure's metadata (content view,
  catalog entries and dependency files, 14 MB of catalog files held until
  written), as 26.9 B found (+104 then).
- The first cycle of 1,000 handles keeps +7.5 MiB of heap (the loadable index
  and entry shards read, compiled parser code); the second cycle keeps
  nothing. The KTX2 encodes of the stream step raise the backend to
  817–962 MiB until the encoder worker ends (10 s idle, D72).

"Done when", line by line:

- *Opens, edits, plays and exports in a real browser on both renderers*:
  holds (two full runs, nothing broken; the export played with the backend
  stopped). *One command's latency and Play start do not grow*: partly.
  Scene edit p50 1.5× over ×100 assets; content edit 2.6×; Play start 3.5×
  (45 µs per asset in the backend). Revised targets and reasons in §7.
- *Walking 50 scenes frees what each scene used; textures inside their
  budget; 500 voiced lines with no gap*: holds (table above).
- *1,000 assets by label loaded and released, resident memory back*: holds.
- *No per-project count cap, guarded by 26.5's test*: holds after D81 (a
  64-script cap in the runtime, found here and removed). Guards:
  `tests/count-caps.test.ts` (now also `behaviorModules`),
  `tests/e2e/count-caps.e2e.ts`, `packages/runtime/src/timers.test.ts`
  (150 scripts).
- *A version-4 project opens and upgrades; its replays still match*: holds,
  by the tests: `packages/backend/src/format-upgrade.test.ts` ("writes each
  current version as a file with its sidecar, keeps the older bytes,
  replays, exports the same bytes" on `fixtures/phase26/legacy-v4-assets`;
  "makes every music and short-sound record audio, ids and files kept, and
  replays" on `legacy-v5-music`), `tests/integration/m26-catalog` (a v4
  build reads to the same rows and simulation inputs, its last command
  replays), the command corpus replays (`fixtures/commands`, M2 content-ops).
- *`tools/gate.sh full` is green*: the main session's, not run here.

Heard and seen: nothing was listened to or looked at; the dialogue's gaps
are the relay's observation (5–10 ms resolution) and the stream step's
levels are resident bytes (the e2e `texture-streaming` checks pixels).
Owner listen and look pending.

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
- 2026-09-29 (26.3 B): a folder import is one command, `importAssets
  {folder, labels?, ktx2?}`. The request names only the folder; the backend's
  command route inspects the folder's new files first (converting an FBX, or
  a PNG/JPEG with `ktx2`), the workspace gives each its id at the command, and
  the pure command reads only those prepared facts (`preparedAssetImport`, as
  `publishBehavior` reads prepared sources), so a request stays under the
  64 KiB request bound however many files the folder holds. One revision, one
  undo (it forgets the assets; the files stay, as for any import), redo puts
  the same records back. Files are walked recursively, a folder's own files
  before its subfolders.
- 2026-09-29 (26.3 B): names and collisions, as Unity's asset database: an
  asset is named after its file without the extension, and two files of one
  name in different folders are two assets of that name; the id is the name
  made id-safe (lowercase, `-`, `_`), then `-2`, `-3`, … while taken (so
  scripts can name a voice line by a readable id). A file whose sidecar names
  an id no asset has keeps it (a folder copied from another project keeps its
  references); a sidecar naming an asset whose file is elsewhere is a copy and
  gets a new id. Files the catalog already imports are skipped and listed, so
  importing a folder again brings only its new files; hidden files and
  folders, sidecars and symlinks are not imported; files no importer takes and
  files an importer refuses are listed next to the result, never fatal.
- 2026-09-29 (26.3 B): the sound kind until 26.6 merges them: a WAV is taken
  as `audio` when the short-sound profile accepts it and as `music` (any
  length) otherwise; Ogg, Opus and MP3 are `music`. The most generic kind that
  takes the file, so a folder of voice lines never fails on length.
- 2026-09-29 (26.3 B): labels are on the catalog record (`labels`: ascending,
  unique, a letter or digit then letters, digits, `_ - . /`, up to 64
  characters; no count per asset) and in the sidecar; the record wins when it
  has labels, otherwise a sidecar's own are kept. A folder import applies the
  request's labels plus each file's sidecar labels. They show in the Assets
  tab's side panel and in `queryAssets`/`tl_content_query`; editing them is
  26.7's.
- 2026-09-29 (26.3 B): uploads go into the folder the user names: the Assets
  tab's "upload to" (default `assets`), `publishAsset {folder}` for MCP. The
  workspace consumes `folder` before the pure command (as `sceneId`) and vets
  it: relative, inside the game folder, no hidden folder, not the project's
  own files; a re-import that names no folder keeps its own file. A folder
  from the computer arrives file by file (`POST …/content/stages/:id/file
  {path}`, MCP `tl_content_upload {writeTo}`; never over another file) under
  its own name in the upload folder (`-2`, … when taken, never merged), then
  `importAssets` imports it; a failed import leaves the uploaded files where
  they are, as files the user copied there.
- 2026-09-29 (26.3 B): sidecars and import-cache headers are written then
  renamed but not flushed one by one: both are made again from the catalog or
  the file when missing or stale, and 2,000 flushes made a 1,000-file import
  take 7–11 s (now 1.1–1.7 s at ×0.1). The project's own files keep their
  flushes.
- 2026-09-29 (26.3 B): a whole folder moved outside the editor with its
  sidecars keeps every asset: the file check re-points each (one
  `setAssetOptions` per asset; 26.13's `moveResources` makes a move one
  command). A project in the data root has the same layout in its own folder
  (tested over HTTP and in the browser). The open's upgrade notes go to the
  Problems log once (`project_upgraded`, naming `upgrade-report.json`), on the
  editor's load and on the Problems query MCP reads.
- 2026-09-29 (26.3 B): the editor's import flow left `App.tsx` (5,159 lines)
  for `useAssetImport.ts` before it grew; the folder controls are
  `FolderImportPanel.tsx`. The MCP adapter's v3 op list was a copy of the
  protocol's and now is it. An import's change carries its records; one larger
  than a WebSocket message (1 MiB) makes the editor re-read the project, as
  any oversized change does.
- 2026-09-30 (26.4 A): storage left `buildService` first: the v4 command
  commit (`command-v4.ts`), project creation on disk (`project-create.ts`) and
  the request envelope (`request-envelope.ts`); typed readers
  (`content-shapes.ts`: `commandContentOf`, `catalogV4Of`, `sceneV4Of`, the
  workspace's own `CommandError`s) replace the `as unknown as` casts on the
  content and scene shapes the commit rewrites (`service.ts` 1,849 → 875 lines).
- 2026-09-30 (26.4 A): resources as files. Each prefab, behavior, material
  (instances included), animator controller, graph (material functions
  included), effect, script library, UI document, UI theme, dialogue,
  timeline and environment preset is `<folder>/<id>.<kind>.json` in the game folder
  (`{tlresource: 1, kind, id, data}`, the project-file layout), default
  folder `assets/<kind>/` (`resource-files.ts`, `RESOURCE_KINDS`). The open
  finds them by name anywhere in the game folder (hidden folders,
  `node_modules` and the project's own files skipped), so a file moved or
  renamed outside the editor is the same resource; two files with one id
  block the open naming both. `content.json` (storageVersion 5) keeps the
  project-wide settings, the revision and the retry records: resource files
  hold no project state, so a command that writes resources writes
  `content.json` with them in one journaled transaction (a scene edit still
  writes its scene file alone). Environment presets are files too
  (`assets/environment/<id>.envpreset.json`); their order is the author's,
  not by id, so `content.json`'s environment lists their ids in that order
  (a preset file it does not list comes last). Scenes stay
  `scenes/<id>.json` in the project folder (user folders for scenes: part B
  with 26.13's moves).
- 2026-09-30 (26.4 A): the asset catalog records move to the sidecars, which
  become the truth (Unity's `.meta` role): `.tlasset` format 2 carries the
  record (`record`) next to id, kind, import settings, labels and address;
  the open reads the assets from the sidecars, a command writes the sidecars
  it changes in its transaction (durable, journaled with `content.json`), and
  the file check no longer rewrites them from the catalog (it writes a
  sidecar deleted by hand back from the session's record, as a transaction).
  A record whose bytes are stored (no file, so no sidecar) stays in
  `content.json`. A second sidecar naming an id is a copy unless its record
  names the file it stands next to. Sidecars are tracked like project files
  for writes but not polled by the external-change check: a file moved with
  its sidecar outside the editor is the file check's (it follows it, as in
  26.3), and removing a sidecar that already moved is not a conflict. A
  packed texture's sidecar names its sources by id only (their paths were a
  copy that went stale on a move). The rejected alternative, keeping the
  records in a persisted index, is one file rewritten by every asset command.
- 2026-09-30 (26.4 A): the phase's one format bump covers it: a v4 project
  (and a 5 written by 26.3, whose `content.json` still holds everything)
  opens, and the open writes the resource files, the sidecars and a
  storageVersion 5 `content.json` in one transaction. A layout change alone
  keeps the revision (no document changed; retry records stay valid); the
  schemaVersion 4 → 5 asset upgrade still takes one revision. The command
  corpus (`fixtures/commands`) was re-derived for storageVersion 5 (its
  projects hold no resources); the recorded replays and the v4 fixture's
  replay still match.
- 2026-09-30 (26.4 A): the index (`project-index.ts`, the Asset Registry's
  role): every asset, resource and scene with kind, id, path, name, labels
  and the ids it references, and who references each id; built at the open,
  updated in place from each command's result by identity (a list or record
  the command left alone is not read). References are any string equal to a
  project id (an asset's: its default materials, rig and packed layers), so
  the index answers "what may use this"; the model's rules decide what must
  resolve. Query `queryIndex {kind?, id?, label?, referencing?, limit ≤ 1024,
  offset}` (HTTP) and MCP `tl_content_query {target: "index"}`; the bench
  finds its material through it. Paging the other queries from it is 26.8's.
- 2026-09-30 (26.4 A): a command validates what it touched. The model's
  `validateContentV4(doc, previous)` trusts a block it normalized before:
  a list or record the command left as the same object is not validated or
  canonicalized again, and the cross-reference rules run only when a section
  they read changed (D61's per-asset scan is gone with it: the derived id and
  kind maps are made once per list, `derivedOf`). The per-scene composition
  and each scene's reference rules are kept with the scene and the content
  sections they read (a material edited in place keeps its id set, so scenes
  that only map materials are not composed again); the content block's own
  cross-block rules run once per project, not per scene. The no-change check
  compares canonical blocks key by key and record by record. The 1 MiB
  content cap now applies per resource record and to the project-wide part
  (the unit that is a file), as 26.5 planned for the whole content; the
  prefab cap is unchanged.
- 2026-09-30 (26.4 A): `setMaterial`/`deleteMaterial` and
  `setAnimator`/`deleteAnimator` (and a controller's `graphEdit`) record the
  one record before and after (`setMaterial`/`setAnimator` changes and
  inverses), not the whole list: the retry record, the change feed and undo
  no longer carry every material. Stored records of the old shape still
  validate; the editor applies the new ones by id.
- 2026-09-30 (26.4 B): scenes are files like the resources. A scene is
  `scenes/<id>.json` in the project folder by default, or
  `<folder>/<name>.scene.json` in the game folder (the same format: it keeps
  its revision and retry records, so a scene edit still writes one file),
  found by the scene id it holds (the project folder's file first, then the
  game folder's `.scene.json` files). The scene index in `content.json`
  stays what says which scenes the project has: a scene file it does not
  list is taken in by the file check, not by the open. Block chunk files stay
  in the project folder (`scenes/<id>.blocks/`), keyed by the scene id, so a
  moved scene keeps them. The default path is unchanged, so the v4 upgrade,
  the layout upgrade and the recorded replays are as before.
- 2026-09-30 (26.4 B): a folder for new things. Every command that creates a
  scene or a resource (`RESOURCE_CREATING_OPS`, defined once in
  project-model's limits) takes an optional `folder`, vetted like the upload
  folder and consumed by the workspace before the pure command (as
  `publishAsset`'s). It places what the command creates; a record it only
  changes stays where its file is (Unity's Create menu writes into the
  project window's current folder; an edit never moves a file). The paths of
  removed resources and scenes are remembered in the session (`formerPaths`),
  so undo of a delete and redo of a create write the file back where it was.
  Editor: "new items in" in the Assets tab; the session client adds it to
  every create, the role 26.13's project window takes over.
- 2026-09-30 (26.4 B): files changed in the game folder while the project is
  open are the file check's (connect, focus, "check files", MCP integrity
  `check: true`), not the 1.5 s poll's, which now reads the project folder's
  own files only (it hashed every resource file each time). A moved or
  renamed resource or scene file is followed without a revision (paths are
  found, not stored); added and copied files, changed resource files and
  removed ones go in as one `importResources` command, prepared by the
  workspace from the files (as `importAssets` reads a folder): the change
  feed, one undo (it takes the adopted files out, as undoing any resource
  create does; redo writes them back where they were). A copy (a second file
  with an id the project has) gets a new id from its file name, 26.3 B's rule
  (`<name>`, `<name>-2`); a copied scene's objects get new ids too, since
  entity ids are unique across the project. The acknowledgement names
  adopted scenes without their documents, so retry records stay small; the
  editor reads the project again on this change.
- 2026-09-30 (26.4 B): a changed or removed tracked resource file is reloaded
  (its record becomes the file's; a removed one leaves the project), as
  Unity re-imports a changed asset and Godot reloads a changed resource: the
  more generic choice than pausing the project on every edit made in a text
  editor or by a merge. The pause stays for what cannot be taken in: a
  resource file that no longer reads or validates, one removed while the
  index says something uses it, and a scene file changed or removed outside
  the editor (scenes are edited in the editor; Godot asks before reloading an
  open scene). A new file that cannot be read is a Problems row and stays
  out. At the open, two files with one id no longer block (26.4 A): the one
  named after the id is the resource, the other is taken in as a copy by the
  first check; a resource file that does not read is left out with a
  Problems row, and named first if the open then fails on a reference.
- 2026-09-30 (26.4 B): D63. Every sidecar a transaction writes is copied into
  the record cache (`cache/records/<id>.tlasset`, git-ignored, unflushed;
  removed with the sidecar, filled in the background at an open that finds
  it empty); the open puts a lost sidecar back from it when the record's
  file is there without one (`asset_sidecar_restored`). With no cache (a
  fresh clone), a missing id that something uses is rebuilt from a file
  named for it (the name made id-safe equals the id, the folder-import rule)
  by a new import with default settings (`asset_sidecar_rebuilt`; an FBX
  needs Blender and is a Problem instead), as Unity makes a lost `.meta`
  again. An id neither can put back still stops the open, now naming the id
  and what to do: D64 (the model has no state for an unresolved reference).
- 2026-09-30 (26.5): every per-project count of assets and resources is gone
  from the model, the commands, the editor, the game host, MCP and the docs:
  models, textures, sounds, music, fonts, version records, prefabs, scripts,
  scenes (and the shell's scene list), materials, animators, timelines, UI
  documents and themes, dialogues and speakers, effects, graphs, script
  libraries (and their 1 MiB of text together; a library stage keeps its
  2 MiB of held text), environment presets, event sounds, trust entries,
  block types and stamps, and the ones found along the way: the runtime
  snapshot's model-bounds, audio-duration and rig rows (4,096), the thumbnail
  cache's 8,192 images per project (refused writes), the 9,999 generated scene
  ids (`scene-NNNN` now grows a digit) and the entity id space tied to 64
  scenes (the search stops at the ids taken + 1). Guards:
  `tests/count-caps.test.ts` (no limit the model exports, and no `const` in any
  package, names a per-project count: `MAX_<kind>`, `*_LIMITS.<kind>`,
  `<kind>_PER_PROJECT`) and `tests/e2e/count-caps.e2e.ts` (a project with 1.5 ×
  every old cap of every kind opens, takes one command of each kind that
  makes one more, plays and exports in the browser). The e2e guard is in the fast
  gate's smoke set (about 25 s), so a cap coming back fails every gate.
- 2026-09-30 (26.5): the byte caps. `MAX_CONTENT_FILE_BYTES` (1 MiB) is the
  one per-file cap: each resource record, each environment preset (they were
  measured with `content.json`) and `content.json`'s project-wide part; a
  prefab's cap is the same (was 128 KiB). The project source quota (512 MiB)
  is gone: an import or upload is refused only when the disk it writes to
  would keep less than the 64 MiB reserve, `statfs` of that folder (the game
  folder may be on another disk than the data root), and the message says
  how much is free. The runtime manifest's cap is the content file cap (32
  MiB; was 256 KiB): asset rows, rigs and prefabs are still inline until
  26.9's catalog, and the full bench's manifest is 9.2 MB. The 512 MiB Play
  content set stays with a comment: the backend holds a Play build in memory
  until 26.8 serves it from disk. The animation-key budget is per model only
  (262,144 key numbers, animation-only files included; the project-wide
  1,048,576 is gone).
- 2026-09-30 (26.5): the game host's audio stores no longer refuse (keyed by
  asset id, one entry per sound the game registers). Removing the store
  without 26.11's loader would keep every decoded voice of a long dialogue,
  so decoded music buffers are a bounded cache that never refuses
  (`MUSIC_DECODED_KEEP` = 64, least recently used dropped and decoded again
  from its bytes; a playing source keeps its buffer). Every `audio` asset is
  still read and decoded at mount until 26.11.
- 2026-09-30 (26.5): the limits audit, against a full-size game (the bench's
  2,000 models, 300 scenes; Rapier measured in Node on the GPU host with
  `~/.cache/thirdlight-phase26/measure/rapier-colliders.mjs`: 256 static
  colliders step in 0.2 ms, 16,384 in 3.0 ms (p95 5.6), plus 1,024 rays 4.6
  ms; 1,024 trimesh colliders of 1,024 vertices build in 1.8 s and step in
  0.7 ms; 16,384 spawns over 257 steps 3.7 s in the runtime's test harness).
  **Raised:** colliders per scene 256 → none of their own (every entity may
  carry one; the 2D 1,024 polygon-vertex total went with it); 3D hull/mesh
  points per scene 32,768 → 1,048,576; spawns alive 1,024 → 16,384 (one
  scene's entities); script physics queries 32 (2D, a literal) and 64 (3D) →
  1,024 per step for both, one constant (`PHYSICS_QUERY_LIMIT`); script
  intents 5 → 40 per instance per step (a transform and a pose on each of 16
  owned entities plus control intents; the 5 blocked a script moving its own
  parts); entity writes 4,096 → 65,536 per step; prefab entities 256 → 1,024
  and bytes to the content file cap. **Runtime budgets kept:** spawns 64 per
  step (0.1 ms each), catch-up 8 steps, voices 32, audio handles 64 and 32
  plays a step, view events 32, timers 64 per instance (saved with the
  script). **Kept with a reason:** entities per scene 16,384 (a load unit;
  worlds are several scenes), collision layers 15 + default (Rapier's 16-bit
  groups), tags 32 (a 32-bit mask), fog volumes 16 (a fixed uniform array),
  local lights 16 per scene and drawn, lightmap atlases 16 / entries 4,096 /
  baked lights 64 (phase 27 reworks lighting), texture-array layers 256 (the
  WebGL 2 / WebGPU guarantee), texture edge 4,096 (26.12 revisits), KTX2
  encoder 12 Mpix (a known limit of the pinned encoder; owner deferred),
  material-instance depth 8, graph nodes 4,096 (256 for script and effect
  system graphs: one compiled module), UI documents 512 widgets / 48 KiB and
  timelines 256 keys per track / 48 KiB (each saved in one 64 KiB command),
  dialogue 1,024 nodes per conversation, 256 variables and 8,192 seen lines
  (saved with the game), block layer sizes (chunked, 1,048,576 cells per
  scene), instance sets 65,536 copies, model import metrics, per-asset
  version counts (one version since 26.3), the Play content set (26.8), the
  folder listing's 500 entries (a page; 26.13 pages from the index), the
  editor session's first 128 assets, prefabs and scripts (26.13), the 64 KiB
  command request, the 1 MiB WebSocket frame. Project configuration that is
  not assets or resources keeps its bounds (input: 64 actions, 8 maps; 16
  game modes; 32 settings keys; 99 save slots of 1 MiB). The table in
  `docs/deployment.md` lists each with its reason, as the code does next to
  the constant. The packer's literal 256 layers now reads
  `MAX_TEXTURE_LAYERS`, and a behavior source's literal 262,144 bytes
  `MAX_BEHAVIOR_SOURCE_BYTES`.
- 2026-09-30 (26.6): the browsers, from MDN's codec guide and container
  tables (checked 2026-09-30): MP3, FLAC (own container or Ogg) and linear
  PCM WAV play in Chromium, Firefox and Safari; ADPCM, GSM, µ-law and MP3 in
  WAV play in none (refused at import); Ogg Vorbis and Ogg Opus play in
  Chromium and Firefox, and in Safari only from 18.4 (macOS 15.4, iOS 18.4;
  the codec guide still says Safari plays Opus only in CAF, the container
  table and WebKit's 18.4 notes say Ogg; reports of incomplete support in
  18.4 exist). So Ogg is imported and one `audio_browser_support` Problem per
  command names the files and "Safari before 18.4"; the same rule flags more
  than 32 channels and rates outside 8–96 kHz (what Web Audio promises). MDN
  names no WAV bit depths; Chromium decodes 8/16/24/32-bit integer and 32/64
  float, which the importer takes. Whether Safari's `decodeAudioData` takes
  Ogg is not documented: owner check on a Mac pending.
- 2026-09-30 (26.6): no duration cap; the audio file cap is the one
  imported-file cap `MAX_SOURCE_BYTES` (32 MiB, also the upload stage's):
  3 minutes of 16-bit 44.1 kHz stereo WAV or hours of Opus. Raising it waits
  on Play reading files from disk (26.8). `AUDIO_PCM_WAV_PROFILE`, the music
  duration and size caps and `MAX_MUSIC_VERSIONS` are gone.
- 2026-09-30 (26.6): the record: `kind: "audio"`, recipe `{profile:
  "audio", recipeVersion 1, toolchain {asset-pipeline}}`, metrics `{format,
  channels, sampleRate, bitsPerSample? (WAV, FLAC), float? (WAV),
  durationMs}` — header facts only, no PCM arithmetic. Opus records 48 kHz
  (what it decodes and counts granules at). The load settings live on the
  record as `loadType?` and `preload?: false`, stored only when changed (as
  `vertexColors`), so thresholds can move without rewriting records; the
  sidecar's `importSettings` states the effective values, and the manifest
  row carries `loadType` and `preload` for 26.11.
- 2026-09-30 (26.6): thresholds kept at the plan's defaults (under 5 s
  decode on load, over 60 s stream). 26.2's bench shows voice lines of 1–15 s
  read and decoded when played start within 35 ms p95 with gaps p95 11 ms, so
  decoding a mid-length file per play costs no audible gap; 5 s keeps a
  decoded effect under ~2 MiB (stereo 48 kHz float), 60 s is where a decoded
  buffer passes ~23 MiB. Preload defaults on (Unity's Preload Audio Data);
  the bench generator turns it off for its 10,000 voice lines, as a voiced
  game would.
- 2026-09-30 (26.6): until 26.11 the game host uses its two existing paths
  by the load settings: an asset decoded on load and preloaded is read and
  decoded at start (the old sound path); any other is read on first use and
  decoded when played, least recently used dropped (the old music path).
  Event cues, dialogue voices and timelines already go through the script
  sound path, which waits for bytes, so any audio asset plays in every role.
- 2026-09-30 (26.6): the upgrade is pure (`upgradeAudioAssets` in the model)
  and runs on every open before validation, for a storage-v3 envelope, a v4
  `content.json` and v5 sidecars alike; it bumps the revision once and
  writes the changed sidecars back (the file check then finds nothing), and
  the note is a `project_upgraded` Problem. Fixture
  `fixtures/phase26/legacy-v5-music` was written by the engine at `e235e907`.
  The M3 contract fixtures (`fixtures/m3/contracts`) now hold the one-kind
  record; `captureManifestV2` takes a supplied recipe table as the table
  (as it does engine pins) so the M3 manifest example keeps its bytes.
- 2026-09-30 (26.7): what the 25.7c scan was. It never chose what builds
  include: it only refused `deleteAsset`/`deletePrefab` while a script's
  string literal named the id. An asset a script names only by id (a visual
  script's Play sound, `ctx.audio.play("thud")`) was in no Play or export
  build unless a scene, prefab or declared property referenced it (D65). The
  scan now also feeds a Problem (`script_names_unloadable_asset`, checked on
  load and after a script, library, label or asset change, literals cached
  by source digest), and keeps refusing the delete. The upgrade labels such
  assets `script-named`, so they ship from now on; nothing that shipped
  stops shipping.
- 2026-09-30 (26.7): the commands. `setLabels {items: [{kind, id}], add?,
  remove?}` and `setAddress {kind, id, address: string | null}` (the set/
  noun vocabulary of `setTags`, `setAssetOptions`); an item's kind is
  `asset` (or the asset's own kind, as the index lists it) or a resource kind,
  since an asset and a resource may share an id. One change type per op
  (`items: [{kind, id, previous, next}]`, only the items that changed), one
  undo; no count limit on items (the 64 KiB request bounds one request, about
  1,500 items).
- 2026-09-30 (26.7): where the names live. An asset's address joins its
  labels on the catalog record (sidecar format 3: the record holds the
  address; a 2's address sat beside the record). A resource's address and
  labels sit in its resource file beside `data` (`{tlresource: 1, kind, id,
  address?, labels?, data}`; a file without them is byte-identical), and in
  the session in `content.loadable` (`[{kind, id, address?, labels?}]`),
  which `content.json` never holds: so no resource's own record, validator or
  set-command changes, and replacing a record keeps its names. An entry
  outlives its deleted resource while the project is open (undoing the delete
  brings the names back) and counts for nothing then (uniqueness, index,
  builds). Address syntax: the label characters, up to 128.
- 2026-09-30 (26.7): uniqueness. The command refuses an address another
  asset or resource has, naming it ("an address is unique project-wide: … is
  already the address of asset x"); the content validation checks the same
  across assets and live resources, so a hand-edited duplicate names both.
- 2026-09-30 (26.7): what ships. The closure (`content-closure.ts`) passes
  the loadable asset ids to the content view (`captureContentViewV3`'s
  `include`), adds loadable materials to the used set (the one resource kind
  a build otherwise trims), and gives `captureManifestV2` the rows for the
  runtime catalog: a new optional manifest key `loadable` (`[{kind, id,
  address?, labels?}]`, assets with their asset kind, only what the build
  holds; absent when empty, so other manifests keep their bytes). 26.9 moves
  it into the catalog files; 26.10's `ctx.assets.load` resolves by it.
- 2026-09-30 (26.7): the upgrade's marker is the sidecar format: assets read
  from format-2 sidecars, or every asset of a project whose assets or
  resources the open still moves into files, are checked once; a script
  literal naming one without an address or a label gives it `script-named`
  (a new revision only when a record changed), the sidecars are written as
  format 3 in the same transaction, the note goes to Problems
  (`project_upgraded`) and the list into `upgrade-report.json`
  (`scriptNamed`). Removing the label later is kept. Assets whose bytes are
  stored (no file, no sidecar) are not checked. The scale generator writes
  format 3 (generator version 6).
- 2026-09-30 (26.7): the editor. The Assets tab's side panel is the asset's
  inspector (the Inspector dock shows entities): address field, label chips
  with ×, an "add label" field; Ctrl/Cmd-click and Shift-click choose several
  tiles and a bar labels them all in one command. Resources get their names
  through the commands and MCP for now; 26.13's project window lists
  resources and sets them there. `App.tsx` lost the model options to
  `ModelAssetOptions.tsx` before it gained its two lines.
- 2026-09-30 (26.7): a resource file's address or labels edited by hand
  while the project is open are not taken in by the file check (it reloads
  the record, not the names beside it); the next open reads them (D66).
- 2026-09-30 (26.6): test fixtures: no ffmpeg on the host, but Blender's
  audaspace writes FLAC, 5.1 Vorbis and 24-bit WAV
  (`fixtures/music/make-music.py`, checked in with their base64 bundle);
  float/extensible WAV, FLAC STREAMINFO, MP3 frame runs and Ogg pages of
  other codecs are built byte by byte in `inspect-audio.test.ts`; the e2e's
  70 s Opus comes from the scale bench's Opus packet pool.
- 2026-09-30 (26.8): a file's digest is kept under its stamp (size,
  modification and change times, inode) per open project and in the import
  cache (`cache/imported/file-stamps.json`, git-ignored, written then renamed
  unflushed); a file whose stamp is unchanged is not read by the file check, a
  Play or export build or the integrity report, so a restart hashes nothing
  unchanged (Git's index and Unity's asset database skip unchanged files the
  same way). A hash made within 2 s of the file's last write is not trusted
  (Git's "racily clean" rule). This replaces the process-wide 1,024-entry
  cache, which at full size re-hashed every file on every check.
- 2026-09-30 (26.8): Play serves the project's files (assets, instance
  buffers) from disk at the stable digest URLs of 25.24c; the backend holds
  only what the build generates (manifest content files, scene files,
  compiled scripts). The 512 MiB Play set cap (`PLAY_CONTENT_SET_MAX_BYTES`)
  is gone; the per-file cap (32 MiB, the content file cap) stays for what the
  backend holds, and a file served from disk is bounded by the import's
  source cap only.
- 2026-09-30 (26.8): integrity on serve, both ways the plan named: a file's
  stamp is checked when it is opened, and one whose stamp changed since it was
  hashed is hashed whole before a byte is sent and refused
  (`409 asset_source_changed`) when its digest differs, which starts a file
  check (one queued per project); while a file is sent it is hashed again and
  its last chunk held back until the whole file matched, so a file changed
  during the send ends the response short (the browser drops a response short
  of its `content-length`; the page's reader checks digests too) and is
  re-checked. Refusing alone would leave the stat-to-send race; hashing alone
  would send bytes before knowing.
- 2026-09-30 (26.8): the check before Play and export now imports a changed
  file again (Unity refreshes its asset database before entering Play mode),
  not only the import cache; with stamps it costs one stat per asset. Moves
  and resource files stay the full check's (connect, focus, "check files").
  A Play started after a file changed on disk ships the new file at its new
  URL without "check files".
- 2026-09-30 (26.8): lookups and pages. An asset record by id goes through a
  position map made once per asset list (lists are replaced, never changed
  in place; a stale position makes it again), not a catalog scan; `queryAssets`,
  `queryPrefabs` and `queryBehaviors` page from an id order made once per list
  (the same response shapes), `queryIndex` from its keys sorted once per change
  of the key set. The integrity report (HTTP `…/content/integrity`, the check
  route's body, MCP `tl_content_query {target: "integrity"}`) takes `limit`,
  `offset` and `problems` (only the entries that are not ok) and answers
  `total` and `nextCursor`; without them it answers every entry as before. The
  editor's check asks for problems only. `queryGameConfig` still returns every
  material, graph and dialogue at once (the editor's load; 26.13 pages the
  editor).
- 2026-09-30 (26.8): the closure locates for Play (`locate: true`: one
  batched `locateBlobs` per build) and reads for the export (26.9 streams the
  export; it gains the lookups). A Play's need for the Basis transcoder comes
  from the records (a model's used extensions, a KTX2 texture's format), not
  the bytes. Reading the closure found D67 (a behavior's required modules
  never reach the module set) and D68 (only the first 128 behaviors were
  compiled: fixed, every page is read).
- 2026-09-30 (26.9 A): the runtime content manifest is version 5, and its
  catalog follows Addressables' catalog (entries with their keys, labels and
  dependencies) and Godot's dependency lists (a scene names what it needs).
  `manifest.json` keeps the build's identity and digests, the resolved
  settings, `start` (the start scene ids) and `catalog` (the root file's path,
  digest and length), then modules, pins, recipes, toolchain and `buildId`:
  1.7 KB at any size (×0.1 and full differ only in the digits of the root's
  length). The root (a content file, like every file below) lists every
  block's file by key (the v4 manifest's inline blocks and content files,
  plus `media`, `behaviors`, `loadable`, `facts` and `dependencies`), every
  scene with its dependency file, the entry shards (first and last id, count)
  and the library rows. `buildId` covers the root, the root covers the rest.
- 2026-09-30 (26.9 A): the pieces. A catalog entry is the v4 asset row plus
  `address`, `labels` and `dependencies` (a model's textures through its
  material map). Entries sit in shards sorted by id; a shard ends after an id
  whose FNV-1a hash is 0 modulo 256 (or at 1 MiB), so an added asset rewrites
  one shard, and a lookup is one binary search over the root's ranges and one
  read. A scene's dependency file holds the full entries its objects need
  (directly, through materials, functions, effects, animators, prefabs, a
  model's own material map, its bake: one generic scan of the documents,
  `scanDependencies`), so a scene load reads its file and that one file; the
  duplication across scenes is about 5 MB of files at full size that nothing
  reads at start. `dependencies` does the same for the project-wide blocks
  (environment, effects, UI, shell, timelines, event cues, block types,
  input, the dialogue speakers' portraits and blips; a line's voice is found
  when it plays). A list or map block past 1 MiB is split into parts, so no
  block meets the 32 MiB per-file cap as a project grows (a per-file cap must
  not become a count cap). Catalog files are compact JSON (`JSON.stringify(v)
  + "\n"`, half the bytes of the indented form at full size); the manifest
  stays indented.
- 2026-09-30 (26.9 A): what a page reads (`openRuntimeContent` in game-host,
  used by both bootstraps): at open the root, every block file but the
  loadable index, and the start scenes' dependency files; those entries and
  the project-wide blocks' are the rows known at start (the start-scene reads
  of 25.24 pick from them). A scene load reads its file and its dependency
  file together (`prepareSceneCatalog` with the catalog), and its preparation
  reads those entries (`pageScenePreparation`); read-ahead does the same. An
  id no read named (a script's sound, a line's voice, a spawned copy's model,
  a portrait, a UI image) reads its shard: the verified asset reader, the
  host (`lookupAsset`: sounds, images, fonts) and the adapter's models
  (`rowOf`, `findRow`) find rows through the catalog. The loadable index is
  read when a script loads by name (26.10's `ctx.assets.load`).
- 2026-09-30 (26.9 A): what is still read whole at start: what the simulation
  must know from its first step, deterministically: the prefabs (a script
  spawns any prefab by id, synchronously), rigs, dialogue, materials and
  `facts` (every model's bounds and material map, every audio file's
  duration, texture ids when graph materials have parameters: a few fields
  per asset, not its row). At full size that is 2.9 MB of the start's reads,
  the prefabs 1.6 MB of it. Loading spawnable prefabs with their scene or by
  handle needs the simulation to take definitions with a scene batch or
  through `ctx.assets.load`: 26.10's resource manager.
- 2026-09-30 (26.9 A): a v4 manifest. An older export plays as it was built:
  its bundle carries its own v4 reader and nothing new reads its files. The
  page's reader also reads a v4 build, upgraded where it is loaded: every row
  known at open, its content files as before, the same content object as a
  v5 build gives. Tested on `fixtures/phase26/legacy-v4-build` (written by the
  engine at `8c21bfa3` from `legacy-v4-assets`): the v4 build and the v5
  export of the same project open to the same asset rows, blocks, scene rows
  and simulation inputs (model bounds, durations, material catalogue), so a
  recorded run replays the same; the project's last command replays from its
  record. `captureManifestV2` stays (this fixture and the M3 contract fixture,
  byte-identical).
- 2026-09-30 (26.9 A): build ids change for every project with version 5 (the
  manifest's shape), and again for a project whose scripts need a module no
  scene component pulls in (D67 fixed: the closure reads the behavior records
  with their sources once, for the module set and the compile).
- 2026-09-30 (26.9 A): inclusion checked against the closure. Every scene
  ships (a script may load any scene by id; the start set, the shell's list
  and the scenes transitions name are all of them). Assets: what the scenes
  and prefabs reference, every project material's textures, effects, UI,
  glyphs, dialogue, timelines, event cues, environment, animators, bakes, plus
  the loadable assets and materials. One gap fixed: an asset property's
  default (a script property of type asset; every object that sets no value
  uses it, and every object a private one) did not ship; it does when it names
  an asset of the project.
- 2026-09-30 (26.9 A): the content view at Play start. The closure does not
  validate the captured content again when the model already did (the
  workspace's captured block is a normalized one: `validateContentV4(c, c)`);
  the view's digest takes the host's SHA-256; a version's metrics digest is
  made once per frozen metrics object and a recipe's once per recipe. What
  still grows with the asset count in the backend: building and serializing
  the entries and dependency files (the `manifest` stage) and one stat per
  asset (26.8's locate and pre-Play check).
- 2026-09-30 (26.9 B): the export streams. The closure locates the assets
  and instance buffers (as Play does) instead of reading them; the export
  opens each located file with the workspace's serving path (stamp check at
  open, hashed while read, last chunk held until the digest matched) and
  writes it into the staging directory, holding one file at a time for its
  container check and its decoder needs (read from the bytes, as before). The
  staging directory is created under the export root once the bundles and
  scans passed and renamed into place at the end; any failure (a file that
  changed while it was copied answers `export_build_unavailable`, reason
  `asset_source_changed`) removes it and leaves the previous output as it was.
  The catalog files are generated in memory by the closure (14 MB at full)
  and written one by one; generating them straight to disk would need the
  manifest builder to emit files as it goes: left, it is shared with Play.
- 2026-09-30 (26.9 B): the export bundle names no artifact. The page reads
  every file (manifest, scene, catalog files, assets, scripts) through one
  relative reader by the path its row gives; only plain relative paths are
  read, and every read is checked against its row's digest, so the switch of
  declared paths added nothing the digest checks do not. The only generated
  module left is the module-spec table.
- 2026-09-30 (26.9 B): one game page. The composition both pages ran lives
  in game-host's `./game-page` subpath (a browser-bundle row in the boundary
  check: three-adapter, physics-rapier, input, runtime, project-model; the
  game-host root stays free of three and physics). The Play page (editor)
  reads the manifest from the locator and checks the bridge snapshot; the
  export page reads `manifest.json` and `scene.json`; both then call
  `startGamePage` with what differs: the reader, script/worker/physics/decoder
  URLs, module specs, the input exercise relay (Play), the start block
  (Play), the save namespace, the debug console (Play always; an export when
  `debug_console` is on) and whether the start waits for the models (Play:
  `tl.ready` only after they settle; an export plays on and shows the
  failure). Small differences that were accidental were made one: an export
  now gets the lighting option when a project has bakes but no materials, and
  checks the media animation rows, as Play did.
- 2026-09-30 (26.10 A): one resource manager per game page, held in the
  game host. Its code (`createResourceManager`, runtime `resources.ts`) lives
  in runtime, the one package the game host, the scene adapter and the
  editor all import (pure: no timers, no I/O; the owner settles it); the
  page makes one instance and hands it to the verified reader, the adapter
  (models, clips, textures, environment maps, effect models), the audio
  owner (decoded sounds), the UI layer (images, fonts) and the host (glyph
  images), which settles it after each frame and reports it (`resources` in
  `tl_game_observe` and Play diagnostics: resident count and bytes per kind,
  loads and frees per kind, loads in flight or failed, waiting, handles).
  Kinds: bytes, model, texture, clip, audio, font, image, environment,
  effect-model.
- 2026-09-30 (26.10 A): holders are names, not counts (a holder holding
  twice is one hold, `releaseHolder` lets go of everything it holds): an
  entity (`entity:<id>`, its model file and the animation-only file its
  animator plays), a scene being prepared or read ahead (its files and
  textures until its entities took them), a built material (the textures it
  draws with), a lightmapped object (its atlas), a spot light (its cookie),
  a playing voice, loop or music track (its decoded buffer), the UI layer
  (its images and fonts), the environment and the effect player (for their
  life), and in part B a script handle (`handle:<n>`). A loaded scene holds
  through its entities; there is no separate scene holder. A resource whose
  last holder went waits for the settle: the host runs it after
  `renderFrame`, which applied the step's scene changes, so a transition
  that drops scene A and takes scene B in one step keeps a model both use
  (tested: `resource-manager.e2e.ts`, `models.test.ts`). Freed means the
  resource's own free ran (GPU data disposed, `ImageBitmap` closed, object
  URL revoked, font face deleted) and the manager holds no reference.
- 2026-09-30 (26.10 A): verified bytes are held only while something needs
  them: the start (until the renderer draws and the models settled), a
  scene's preparation (until its entities took what they draw), a decoder
  until it has them. Asked for again later they are read again (the HTTP
  cache has them, digest-keyed and immutable since 25.24c) and hashed again,
  as Godot and Unity load from disk again. A scene's preparation does not
  read a model or texture that is already resident.
- 2026-09-30 (26.10 A): a decoded texture is one entry per asset shared by
  every user; each user that changes how it samples (materials, lightmaps,
  cookies, graphs, the LUT) draws with a clone it owns and disposes, so
  freeing the shared one never changes a user's look. The environment keeps
  its own `environment` entries (the sky's faces and the LUT, for the
  environment's life); a texture used as both is decoded twice.
- 2026-09-30 (26.10 A): the 64-entry decoded-music LRU of 26.5 is gone. A
  sound decoded when played is held by the voice, loop or music track that
  plays it and freed after it stops (decoded again when played again: the
  load type's "decode while playing"); a sound decoded on load is held by
  its registration, which lasts the play until 26.11 registers per load
  type. The compressed bytes of sounds read on use stay registered in the
  audio owner (26.11 takes them over).
- 2026-09-30 (26.10 A): the visual resource store forgets a resource the
  manager frees (`release`): before, a retired model stayed reachable from
  the store's map until the next load of the same asset, so its parsed file
  (geometry arrays, images) outlived the scene.
- 2026-09-30 (26.10 A): the Scene view holds its model files (by object)
  and its materials' textures in a manager of its own, settled in a task
  after each change (`data-resources` on the view): closing a scene frees
  what only it showed. Left for part B / 26.13: the Scene view's cookies,
  environment and lightmaps decode through their own caches in viewport.ts
  (over 2,000 lines: split first), and the asset tiles' `prepared` reads
  parse a model to draw its tile (held only while handed over now).
- 2026-09-30 (26.10 A): prefabs and the other blocks read whole at open
  stay whole in part A. Loading a scene's prefabs with the scene is not a
  manager question: the simulation spawns any prefab by id synchronously and
  deterministically (in the worker too), so the definitions must reach the
  simulation with a scene batch or a script's handle before a spawn can
  name them. Listed for part B with `ctx.assets.load`.
- 2026-09-30 (26.10 A): the visual resource store (`createVisualResourceStore`)
  gains `release(resource)`: the manager's free of a model retires it and
  drops the store's references to it (its map entry and the load handle
  whose result held it). Found with the walk: a heap snapshot diff after the
  ×0.1 walk still held 200 parsed files (`GLTFParser`, their geometries,
  materials and textures) through the store's `latest` handles.
- 2026-09-30 (26.10 A): asset loading left `createGameHost` for
  `game-host/src/host-assets.ts` (glyph images, the sounds' registration,
  the manager's settle and observation), and the adapter's public shapes
  left `three-adapter/src/adapter.ts` (over 2,000 lines) for
  `adapter-types.ts`; the Scene view's asset setup left `App.tsx` for
  `editor/src/viewport/scene-assets.ts`.
- 2026-09-30 (26.10 B): scripts' handles are numbers, as sound, timeline
  and effect handles are: `ctx.assets.load(key)` answers a handle at once
  (0 for a key that is no name at all) and `state` (loading, ready, failed,
  null once released), `ready`, `ids`, `error` and `release` read and end it.
  A key is resolved as an address, then an asset or resource id, then a
  label (every entry carrying it), as Addressables takes a key or a label.
  Handles are never reused in a play. No count caps: one answer carries any
  number of ids; a frame carries 64 answers and the rest wait (never
  refused: a refused answer would leave its handle loading).
- 2026-09-30 (26.10 B): the simulation never waits on a load. A load is a
  request that leaves the simulation after its step; the host's answer
  rides on the next sampled step's input frame (`ActionFrame.assets`), as
  storage's answers do, so a recording replays it at the step it arrived and
  the worker applies it at the same step, however long the loads take when
  it is replayed. A recorded input (`ActionSource.recorded`, kept through the
  relay) takes no live answer on top of its own (tested: page and worker
  replays with the replaying host answering at once or never give the live
  run's step digests, `tests/integration/m26-asset-handles`).
- 2026-09-30 (26.10 B): a handle belongs to the run, not to the script that
  loaded it (Addressables' handles are global; releasing is the script's
  job). A handle still open when a run ends (a restart, the shell's new
  game) is released then and reported: the script log names it and
  `resources.notReleased` (with `notReleasedCount`) in `tl_game_observe` and
  Play diagnostics lists it; `resources.open` lists the open handles (key,
  state, ids, why one failed). A handle still open when Play stops is named
  in the page console only: after Stop there is no play to ask (the editor
  acknowledges the stop before the page closes), so a tool reads
  `resources.open` before stopping.
- 2026-09-30 (26.10 B): what a handle holds, under `handle:<n>` in the
  page's resource manager: the models parsed and the textures decoded (a
  project without materials has no texture decoder: their verified bytes),
  any other file's verified bytes (a sound played later is not read again);
  a prefab or material key brings its models, materials and textures by the
  build's dependency scan, so a prefab loaded by handle spawns drawn at once
  (the e2e checks no model is parsed for the spawn). A file that fails fails
  the handle, holding nothing. Visual scripts get Load assets, Release
  assets, Assets state, Assets ready and Assets error (generated); the key is
  text, not an asset picker (a label or an address is not one asset).
- 2026-09-30 (26.10 B): prefab definitions stay whole at open, not per scene
  or per handle. At full size 5,000 prefabs are 1.59 MB of compact JSON, the
  largest of the 2.6 MB of blocks read at open. Unity loads the prefabs a
  scene references with the scene and others by an Addressables handle;
  Godot loads a `PackedScene` when something references it. Here
  `ctx.spawn(prefabId)` is synchronous and deterministic in the page and the
  worker: with definitions per scene or per handle a spawn's outcome would
  depend on whether its definition had arrived, so the definitions would have
  to ride on the recorded input, and a script spawning by a computed id or by
  one no loaded scene names would stop working (every game that spawns, and
  the replays of existing games). What is heavy in a prefab (models,
  textures) already loads per use, and a handle on the prefab's key loads it
  before a spawn. Revisit when a project's prefab data reaches tens of MB.
- 2026-09-30 (26.10 B): a texture that is the sky (or a sky face, or the
  grading LUT) and a material's map is decoded once: the environment holds
  the shared `texture` entries (it builds its cube, equirect copy and LUT
  from their images and never changes them); the `environment` resource kind
  is gone (e2e `resource-manager`: the sky's texture is loaded once, and a
  scene whose box wears it does not decode it again).
- 2026-09-30 (26.10 B): a compiled graph material is counted per mesh, as a
  built material is: it, the decoded textures it samples (holder
  `graph:<digest>`) and its sampler copies go with the last mesh wearing it
  (a scene unloaded, an object destroyed) and are compiled and decoded again
  when worn again (unit test in `material-graph.test.ts`). Before, they were
  held for the material library's life.
- 2026-09-30 (26.10 B): no grace before a free. The re-reads of a walk over
  scenes that share assets come from the browser's HTTP cache (×0.1: 1,100
  of 1,858 fetches, §6), so what freeing at zero costs is the decode, about
  40 ms per scene load at ×0.1 and nothing measurable at full. Godot frees a
  `Resource` when its count reaches zero; Unity's `UnloadUnusedAssets` runs
  when a game or a single-mode scene load asks, and Addressables frees at a
  count of zero. A grace would leave memory above its baseline for its
  length and add a timing policy; a same-step transition already keeps what
  both scenes use, and a game that wants a set kept across scenes holds a
  handle on its label.
- 2026-09-30 (26.10 B): runtime.ts (5,796 lines) grew no longer: the save
  sections' port moved to `runtime/src/save-sections.ts` and the host's
  queued frame entries share one helper (`frame-queues.ts`), 5,708 lines
  after the handles. Play diagnostics carry `catalogReads` (catalog files
  read so far), and the bench counts the page's fetches and those the HTTP
  cache answered.
- 2026-09-30 (26.11): the browser mechanics, checked against MDN and the
  Web Audio spec: `decodeAudioData` decodes only complete files, resamples
  to the context's rate and detaches its input (a copy is decoded; the kept
  bytes stay usable). WebCodecs `AudioDecoder` (chunked decode) is not
  Baseline, is secure-context only and takes demuxed packets (the page would
  need Ogg, MP3 and FLAC demuxers): decode-while-playing decodes the whole
  file per play (26.2's bench: 1–15 s voices decoded in tens of ms). Stream
  is an `<audio>` element per play through `createMediaElementSource`
  (Baseline since 2015; one node per element), made on the page's main
  thread (AudioContext is `[Exposed=Window]`; the simulation's worker only
  sends the audio intent log). Autoplay: the context is created and resumed
  on the first trusted key or click (unchanged), and an element's `play()`
  after that gesture has the sticky user activation MDN's autoplay guide
  asks for; the Play page's CSP gains `media-src 'self'` (streams are
  same-origin: a cross-origin element without CORS is heard as silence).
  Safari's behaviour with streams through Web Audio: owner check on a Mac
  pending.
- 2026-09-30 (26.11): lifetimes follow Unity's Preload Audio Data. A
  preloaded file is held by each loaded scene whose dependency list names it
  (`scene:<id>`, read after the scene is loaded, not during its
  preparation: a read-ahead scene never loaded would keep it) and by the
  play for the project-wide blocks' files (event cues, timelines, shell); a
  file not preloaded is held from its first play by the scenes loaded then
  (freed when they have all unloaded). What is held is the load type's
  data: the decoded buffer (decode on load) or the compressed bytes (decode
  while playing); a play holds its decoded buffer or its stream until it
  ends. Before the first gesture there is no context: files to be decoded
  keep their bytes and are decoded at the unlock. A stream reads nothing
  ahead; its element and node are freed when its play ends (resident bytes
  0: what the element buffers is not observable).
- 2026-09-30 (26.11): the lateness bound. `maxLateMs` (whole ms, 0–60,000;
  `AUDIO_MAX_LATE_MS_DEFAULT` 500 and `AUDIO_MAX_LATE_MS_LIMIT` in
  project-model) on `ctx.audio.play` and `stinger` (and the visual-script
  node), event cue rows, timeline stinger/sfx keys, and the dialogue setting
  `voiceMaxLateMs` (default 1,000: a voice a second late still matches its
  subtitle). It rides on the play command only when given (the simulation's
  state and digests are unchanged); the host measures from the command's
  arrival with the page clock. A one-shot not started within it is dropped
  (`audio.late` says started-late or dropped, how late, and whether it
  waited for its file or the unlock); loops, audio sources and music wait as
  long as it takes. It replaces the fixed 30-frame drop. The simulation's
  timing never waits (a late voice ends later than its line's recorded
  length).
- 2026-09-30 (26.11): dialogue reads ahead in the page, not the
  simulation: each time the conversation's node changes, the voices on
  every path from it (options, branches, jumps) up to three lines deep are
  held by the conversation (`dialogue:<n>`), the next lines' decoded too, and
  the previous set let go after the new one is held (voices still ahead are
  not read again). A file held ahead is not added to the first-play scope,
  so a long conversation keeps only what is ahead (full: ~1 MiB during, one
  voice after). The conversation's first line is not read ahead (nothing
  says it is about to start); a game that wants it ready holds a handle on
  its label.
- 2026-09-30 (26.11): the audio owner's per-asset stores (`assets`, the
  registered cues' bytes and buffers; `music`, the read-on-use files'
  bytes) are gone: every byte, buffer and stream is a resource of the page's
  manager, kinds `audio`, `audio-bytes`, `audio-stream` (so
  `resources.resident` reports each). `registerCue`/`registerMusic` stay (the
  M3 owner contract, the dialogue previewer) and hold what they are given
  under the owner's `registered` holder; a file registered again is a new
  resource (a play of the old one keeps its buffer). A decode is the
  file's, not the run's: a run change stops voices and clears the cue
  dedupe but no longer re-decodes. The host's audio moved out of `host.ts`
  (1,896 lines) into `host-audio.ts`, the loading into `audio-loading.ts`
  and the page's catalog side into `page-audio.ts`. Left: the editor's
  dialogue previewer still registers every voice of the project's
  conversations when it opens (an editor tool; the owner holds them in its
  own manager); the event cue and timeline editors show `maxLateMs` only
  where their forms come from the descriptors (event cues do).
- 2026-09-30 (26.12): which textures stream. A plain KTX2 texture (a KTX2
  file, or a PNG/JPEG with a KTX2 encode) whose mip chain goes past the
  128 px mip tail; the import setting `streaming` on the asset's record
  (sidecar `importSettings.streaming`, `setAssetOptions {streaming:
  bool|null}`, the asset inspector's "stream mips"), on by default above
  1024 px on the longer edge. A PNG/JPEG without a KTX2 encode never
  streams: the KTX2 encode is where a stored mip chain comes from (Unity
  streams only textures with mips), and a second mip cache per image would
  be a second texture format to keep. Texture arrays load whole (at most
  12 Mpix by the encoder, sampled by layer on terrain, where a mesh's UV
  density says nothing of a layer's need). The texture edge stays 4,096
  (the encoder makes at most about 3,500²; WebGL 2 promises 2,048).
- 2026-09-30 (26.12): the budget is the project setting `texture_budget_mb`
  (1–65,536, default 512 MiB: Unity's `streamingMipmapsMemoryBudget`
  default, which a mid-range laptop's shared GPU memory (Iris Xe class,
  8–16 GiB) holds beside the page). It counts every decoded texture:
  streamed ones at their resident levels times their GPU copies (D71: each
  user that samples a texture its own way has its own GPU texture in three's
  WebGPURenderer), the others once, fixed. The mip tails are never dropped.
  Play and the export read it; the Scene view reads textures whole (an
  authoring view through the editor's asset route; streaming is the game's).
- 2026-09-30 (26.12): split files, not HTTP range requests. The build cuts
  a streamed KTX2 at its level offsets (the level index): a head (header,
  level index, format descriptor, key/value and supercompression data, and
  the tail levels, which KTX2 stores smallest first) and one part per larger
  level. The parts are cut once per KTX2 digest into the import cache
  (`ktx2-parts-1-…/`, with `parts.json`), listed in the catalog row
  (`mipParts`: digest, bytes, offset, levels) and shipped instead of the
  whole file (Play serves them from disk, the export copies them and checks
  them together as one KTX2). Each part is a file the verified reader checks
  against its own digest and the browser caches under its own immutable
  URL; a range of a file has no digest to check, 26.8's Play route hashes
  whole files as it sends them, and some static hosts answer a range with
  the whole file. A reader that needs the whole file (a script's handle in
  a project without materials) reads the parts and checks their
  concatenation against the file's digest.
- 2026-09-30 (26.12): the mechanics, checked against three 0.186.1
  (`renderers/common/Textures.js`, `KTX2Loader.js`). The transcoder is
  always handed a whole, valid KTX2: the tail as a smaller texture, a larger
  level alone as a one-level file (`buildKtx2Subset`: BasisLZ's image
  descriptors cut to the levels kept, codebooks whole; unit test: the tail
  and level 0 transcode byte for byte as in the whole file, ETC1S and UASTC).
  The transcoded levels are kept and the texture's `mipmaps` is the chain
  from its largest resident level. A change of resident levels is a new GPU
  texture: three allocates storage once at the size and level count of the
  first upload (WebGL 2 `texStorage2D`, WebGPU `createTexture`) and later
  uploads only write into it, so the streamer raises the texture's `dispose`
  event (which also drops the bind groups that point at it) and marks it for
  upload with the new chain. A base/max-level window over a full-size
  allocation would keep the memory the budget exists to save, and WebGPU
  has none. A level that transcodes to another GPU format than the tail
  (the format picked by size, PVRTC only) is not applied. The same path on
  both renderers; e2e `texture-streaming` checks pixels on WebGPU and
  WebGL 2 and in an export.
- 2026-09-30 (26.12): the needed level from on-screen size, as Unity does
  (mesh UV distribution and the camera): per geometry and UV set its UV
  density (square root of UV area over surface area, 4,096 triangles
  sampled, cached), times the texture's size and tiling over the mesh's
  scale, gives texels per world unit; the camera's pixels per world unit at
  the distance of the bounding sphere's nearest point (perspective or
  orthographic, device pixels) turns that into texels per pixel, and the
  level is its base-2 logarithm. Meshes outside the view are not counted. A
  graph material lists the textures its compile samples in its user data.
  A streamed texture that a sky, a light's cookie or a lightmap draws is
  kept at full size (pinned, first in line for the budget): their need is
  not a mesh's size on screen. Worked out every 100 ms before a frame, in
  presentation only.
- 2026-09-30 (26.12): the policy (`texture-budget.ts`, unit-tested): the
  tails first; then levels in rounds, the texture furthest below its need
  first (ties: larger on screen), one level at a time while the budget
  holds; then levels resident but no longer needed, kept while there is
  room, the most recently needed texture first. Drops apply at once, loads
  one level at a time (two in flight), so the resident bytes stay inside
  the budget at every frame (the bench samples it).
- 2026-09-30 (26.12): D70 found on the settings path the budget takes: a
  project that set `instance_chunk_m` could not play or export (the
  manifest's optional-keys list lacked it); fixed, and a unit test holds the
  list equal to the registry's. D71 logged (one GPU texture per sampling
  copy). Resident texture bytes against the budget, and each streamed
  texture's resident and wanted level, are `resources.textures` in
  `tl_game_observe` and Play diagnostics.
- 2026-09-30 (between 26.12 and 26.13): Play and the file check. A Play
  (or export) start joins a file check that is running or queued for the
  project (the editor's on connect or focus, or another Play's) instead of
  queuing a second pass behind it: the full check does everything the
  pre-Play pass does. A file changed after that walk read it, before the
  click, is caught when Play or the export sends it (hashed while sent:
  409, a check, the next Play ships it), the same backstop 26.8 put under
  the stat-only pass. The check's walk over the assets
  (`assetFilesYielding`) gives the event loop back every
  `FILE_CHECK_SLICE_MS` (16, workspace), so a Play asked for during a long
  first hash is answered and joins it, and no other request waits seconds
  behind it; the route's integrity report waits one turn so a joined Play
  goes first. Not done: a cheaper connect check than one stat per asset —
  the check already hashes only files whose stamp changed; a fresh copy
  changes every stamp (inode, ctime, mtime), so its one hash of every file
  stays (Unity imports a fresh clone once too). A pre-Play pass that does
  not grow needs a file watcher; left for 26.14 (see §6).
- 2026-09-30 (between 26.12 and 26.13): D72. The KTX2 encoder worker ends
  after `KTX2_WORKER_IDLE_MS` (10 s, backend) without a job and is started
  again by the next encode: its WASM memory can only grow, so ending the
  thread is the one way to give it back; a heap cap would fail large
  encodes instead. Only the current worker's exit fails waiting jobs (an
  idle one may exit after its successor took new work).
- 2026-09-30 (between 26.12 and 26.13): D73 was a product race. The
  inspector's address field kept the last asset's typed text when another
  asset was chosen and reset it in an effect a frame later, so what was
  typed in that frame was lost. The fields are now one instance per item
  (keyed), and follow a committed change (undo, another client) while
  rendering; no test change.
- 2026-09-30 (26.13 A): the session holds the index, not the first 128
  records. The full state's `content` is the index's size (`{index:
  {total}}`); lists and pickers read `queryIndex` pages (new filters `kinds`,
  `text` — a part of the name, id or file, any case —, `ids`, `refs: false`,
  and `records: true` for a resource's record), and what a view needs is read
  by id: asset summaries (`queryAssets {ids}`), prefab definitions
  (`queryPrefabs {ids}`), conversations (`queryIndex {kind, ids, records}`),
  batched per task a page at a time (`editor/src/session/catalog.ts`). The
  Scene view asks for the summaries of the models the open scenes place and
  draws them when they arrive. Scripts stay whole (every page read at a full
  state): their declarations are the schema of every behavior component and
  they compile together. A check that needed the whole catalog (an override's
  asset reference, a new prefab or conversation id) is the backend's, or asks
  the index.
- 2026-09-30 (26.13 A): pickers. A choice that fits one index page (256) is a
  plain `select`; a longer one is a button that opens a search over the index
  in a virtualized list (Unity's object picker); either way the value is named
  by id from the index. 256 is how a choice is shown, not a limit on a
  project. The index lists in `kind:id` order; sorting is part B's.
- 2026-09-30 (26.13 A): the virtualized list is built here
  (`ui/catalog/VirtualList.tsx`, ~150 lines: a fixed row stride, a grid mode
  that matches the CSS auto-fill grid, spacer rows) rather than a package: the
  editor needs one fixed-stride list, and each dependency is pinned and
  audited.
- 2026-09-30 (26.13 A): tile thumbnails. A texture's is made by the backend
  when a tile asks for a missing one (`GET …/thumbnails/<digest>?asset=`),
  in the texture worker thread (the image scaled to 128 px, a PNG), from the
  PNG/JPEG or the image a KTX2 was encoded from; a KTX2 imported as is and a
  packed texture keep the icon. A model's is drawn in a kept editor worker
  (an `OffscreenCanvas`, the same glTF loader and renderer factory; a lane of
  its own so it never holds up the small jobs), the file and each piece of a
  file of several, and stored in the import cache; files wait newest-first
  and a tile that scrolled away is dropped from the queue. Drawing a tile
  reads its PNG only; a model's pieces load when it is chosen. The page keeps
  the URLs of the tiles on screen and 512 more.
- 2026-09-30 (26.13 A): the Scene view's spot cookies, environment textures
  and lightmap atlases are held in its resource manager (`textureHolds`, the
  one its models and materials use): a light holds its cookie while it is
  drawn, a baked object its atlas while it is drawn (its scene open), the
  environment what it names (a changed set of textures makes a new
  environment renderer and lets the old set go). The Scene view still reads
  a streamed texture whole (its own mips, no budget); kept, it edits one
  scene's worth. `viewport.ts` split first (2,354 → 1,964 lines:
  `scene-lighting.ts`, `camera-previews.ts` — the two copies of the camera
  rig's world pose made one —, `helper-shapes.ts`).
- 2026-09-30 (26.13 A): `queryGameConfig {omit: [...]}` leaves out
  conversations, graphs, timelines, UI documents or effects; the editor omits
  conversations and reads one when its tab opens or a preview plays it (with
  the ones it jumps to). Materials stay in the reply: their change record
  (`setMaterials`' keyed list) carries the whole id order, so a client holds
  the list (2,000 materials ≈ 1.3 MB of files at full); graphs stay: material
  functions and sub-graph calls resolve across all function graphs. The
  pickers still read materials, prefabs and scripts from the index.
- 2026-09-30 (26.13 A): the dialogue previewer reads the facts of the assets a
  conversation names (a clip's length from its import metrics, not by
  decoding it), the voices of the first lines before it starts (`prepare`)
  and then the voices ahead of the line it plays (runtime
  `dialogueVoicesAhead`, as Play does), a speaker's blip at the start and a
  portrait when shown.
- 2026-09-30 (26.13 A): `App.tsx` (4,952 lines) did not grow: the areas this
  item changed went to modules (`ui/catalog/*`, `ui/assets/useSelectedAsset.ts`,
  `ui/assets/TileImage.tsx`, `ui/uidoc/useUiPreviewAssets.ts`,
  `session/dialogue-closure.ts`) and every whole-list prop left the panels.
  The scale bench has an `editor` step (`tools/perf/scale-editor.ts`, also
  driving `tests/e2e/editor-scale.e2e.ts` at ×0.1).

- 2026-09-30 (26.13 B): the project window (`ui/project/`) replaces the flat
  asset list: a folder tree (the game folder's real folders, read a level at
  a time from `queryIndex {folder, folders: true}`, plus folders the index's
  files are in, such as a project folder's own `scenes/`) and "All assets"
  (every asset file wherever it is, the old list, the default); a folder
  shows its subfolders, then every asset, resource and scene in it. The
  folder chosen is where new scenes and resources are created and uploads
  land (the "new items in" field went; the top of the game folder uploads to
  `assets/`).
- 2026-09-30 (26.13 B): moves are three ops, each one command and one undo:
  `moveResources {items?: [{kind, id}], folders?: [path], to}` (items and
  whole folders into a folder), `renameFolder {folder, name}`,
  `createFolder {folder}`. Where a resource's or scene's file is belongs to
  the workspace (files are found by id on open), so the workspace prepares
  the moves (`CommandState.preparedMoves`, as imports are prepared) and the
  command layer reads only them: it rewrites an asset record's path (every
  version naming the old file) and records `{moves, folders}`; undo is the
  same change the other way. The transaction writes each moved resource
  file, scene file and sidecar at its new path and removes the old one; the
  asset files, and whatever else a moved folder holds (files the project
  does not track, empty folders), follow after the commit; an undone
  `createFolder` removes the folder only when it is empty. Refused: a taken
  target, a folder into itself, an asset whose bytes are stored (no file).
  An undo or redo first checks its targets are still free. Renaming a
  resource's or asset's file is not part of this (their names are their
  panels' and the importer's; Unity renames the file with the asset).
- 2026-09-30 (26.13 B): a move changes no build. What a build ships names no
  file path (the catalog is by id and digest); the buildId covers the
  revision and the capture time (it names a build: every scene document is
  stamped with the capture's revision), so it is new for any revision. The
  e2e test compares the export before and after a move with those masked:
  the same files, byte for byte, and no source path in any of them.
- 2026-09-30 (26.13 B): browsing: Unity's search syntax parsed in the editor
  (`session/project-search.ts`): `t:` kinds (a kind, Unity's type names
  such as `AudioClip`, `Texture2D`, `Prefab`, or a kind's start; several
  widen), `l:` labels (several narrow: `queryIndex {labels}` holds every
  one), the rest a part of the name, id or file; in a folder the search
  covers the folder and its subfolders (`recursive`). The kind menu writes
  the box's `t:`. `queryIndex` sorts by `name`, `kind` (then name) or `path`
  (`descending`), an order made once per change of the index and kept.
  Choosing: click, Ctrl/Cmd-click, Shift-click (a range past the tiles on
  screen is read from the index), Ctrl/Cmd-A. Cut and paste move (a
  project window has no copy of a file: Unity's Duplicate is not built).
  Keys pressed in the window do not reach the Scene view's shortcuts
  (paste, delete), except undo and redo. A double-click opens a folder, or
  the item's editor tab (material, animator, graph, effect, library, UI
  document and theme, dialogue, timeline, a script or visual script); a
  scene opens in the Scene view, a prefab in the Prefabs panel, an
  environment preset in the Environment panel, an asset in its preview. The
  per-kind panels stay. Labels on many items: the labels bar on any
  multi-selection of assets and resources; a resource's address and labels
  in the side panel when it is chosen.
- 2026-09-30 (26.13 B): `App.tsx` did not grow (4,899 → 4,840): the asset
  preview moved to `ui/assets/useAssetPreview.ts`, the project window's
  state and openers are `ui/project/useProjectWindow.ts`. `RESOURCE_KIND_TABLE`
  is in the `limits` subpath (the editor's search names the kinds).
- 2026-09-30 (D80): durability of a command of several files. Its journal
  (every byte it writes) is written and flushed with its directory: that is
  the commit point, and the command is answered after it. The files are then
  written beside their targets and renamed into place at once, without a
  flush each, so readers see the new bytes. In the background the files are
  flushed two at a time (libuv's pool keeps two threads for the reads the
  backend serves), then each directory touched once, then the journal is
  removed and `.thirdlight/` flushed. A crash anywhere before that leaves the
  journal and the next open replays it; a failed flush leaves it for the next
  command, which replays it flushing each file. Journals are numbered and
  replay oldest first; while one waits, every later write is journaled too
  (even one file), so an older journal can never replay over a newer write.
  A graceful close or release finishes the flushes first. Crash-safety is
  unchanged: every file is still written to a temp and renamed.
- 2026-09-30 (D80): why connections were reset. A request that arrives on a
  kept-alive connection while the event loop is blocked for longer than the
  server's keep-alive timeout (Node's 5 s) is reset: when the loop comes
  back, the connection's idle timer fires before its data is read
  (reproduced with a bare `http` server: a 6 s block resets, 4 s does not).
  With the commands no longer blocking for seconds the bench's retry on
  `ECONNRESET` is gone. Why an undo took up to twice its command: it does the
  same file operations (counted), and which of the steps was slow varied
  between runs; each flush also paid for the unflushed writes before it (the
  record cache, the moved files) in the disk's journal commit.
- 2026-09-30 (D76): a project made from a template is current when made. The
  Starter's captured project predates animators (storage v3 has no animator
  list), so its character's old idle/run/airborne animation becomes an
  animator while the project is created (the same conversion an open does,
  the clip lengths read from the template's model files) instead of at the
  first open, which bumped the revision and put upgrade notes in a new
  project's Problems log. The captured template stays as it is.
- 2026-09-30 (26.14): the targets. Kept as proposed and met: open ≤ 2 s
  (backend and editor), one command p95 ≤ 100 ms, the walk (heap within
  5 MiB, textures and every kind's resident bytes back, scene load p95
  ≤ 200 ms), the dialogue (gap p95 ≤ 20, max ≤ 50 ms), the export time and
  its game's first frame. Missed and reported, not relaxed: the content
  edit's 2× ratio (2.6× at p50) and the export's growth (+106 MiB against
  +100). Revised, each with its reason: **backend resident after open ≤ 300
  → ≤ 400 MiB** (352–357 measured): the backend holds the index and every
  record in memory by design (the Asset Registry role, 26.4), ~7 KiB per
  record over an empty project; 300 was proposed before the index existed.
  **Play start ≤ 1.5 s and within 1.5× of ×0.01 → ≤ 2 s at full, the
  backend's part at most 50 µs per asset** (1.62–1.66 s clean, 45 µs):
  what grows is two stat walks over every asset (the pre-Play check that
  takes changed files in, as Unity refreshes before Play mode, and the
  closure's locate of each shipped file), the content view and the catalog
  entries. Both stay until a change is made on purpose: merging the walks
  means the locate trusting the check's stamps, and a file watcher (Unity's
  directory monitoring) needs one inotify watch per folder of the game
  folder (a system limit; a missed event would ship a stale file until the
  serving hash refuses it). Owner to confirm the two revisions.
- 2026-09-30 (26.14): D81. The runtime still refused a game with more than
  64 behavior modules (`INTENT_LIMITS.behaviorModules`), a count of scripts
  26.5's guards missed (its name is no kind, and the e2e guard's scripts
  have no source, so none are compiled). The check is gone (a module is
  compiled code; its cost is its work per step, which the intent and step
  budgets bound); `timers.test.ts` runs 150 scripts (it fails with the old
  check), and the static guard also flags `behaviorModules`/`modules` keys.
- 2026-09-30 (26.14): D60. Every string literal, template part and JSX text
  of package sources that named a phase, packet, milestone or `§` (116,
  MCP descriptions most of them) says what it means instead;
  `REMOVED_IN_PHASE_24` is `REMOVED_FROM_ENGINE` ("removed from the engine:
  build it as project scripts"); three messages the M2 contract fixtures pin
  byte for byte changed in the fixtures too (no digest covers them). The
  history check reads those strings as well, for package sources other than
  tests (tests may quote old messages): cheap (the same parser pass) and
  clean (no allowlist; "Safari before 18.4" reads "Safari older than 18.4",
  since a version after "before" looks like an item id). Fixtures, docs and
  tools stay outside it.
- 2026-09-30 (26.14): the limits table in `docs/deployment.md` lists only
  per-file and per-object sizes and runtime budgets, each checked against
  its constant: the decoded-audio LRU row went (26.10/26.11 removed it), the
  thresholds and id format moved to "Engine defaults", and the command
  request, upload stages, scripts, model import, instance sets, block edits,
  audio plays, script asset handles and timelines playing were added. The
  KTX2 encoder's 12 Mpix source stays as a known limit of the pinned
  encoder.
- 2026-09-30 (26.14): MCP descriptions. Phase 26's commands and queries were
  described by their items; added: scripts' `ctx.assets` handles in
  `tl_command`, `resources`/`assetReads`/`catalogReads` in `tl_diagnostics`,
  `envpreset` among the index kinds. The scale bench records the renderer
  that drew Play (canvas attribute), so a run names what it measured.
- 2026-09-30 (26.14, Play start): the file watcher. Node 22's recursive
  `fs.watch` on Linux is a JavaScript emulation that puts a watch on every
  file and stats every entry synchronously when it starts (61,000 watches
  and a blocked event loop for the full bench); the backend instead puts one
  inotify watch on each directory of the game folder (and of the import
  cache when it is outside it; `.thirdlight/`, the record cache, the blob
  store and `.git` are left out), as Unity's directory monitoring and
  Godot's filesystem scan do; macOS and Windows watch the tree natively
  (`recursive: true`); other platforms are not watched. A new directory is
  watched as it appears (watched before it is listed), a removed one's
  watches go (workspace `file-watch.ts`).
- 2026-09-30 (26.14, Play start): what the watch is trusted with. A full
  check (connect, focus, "check files", or the first Play) that started with
  the watch running indexes where every asset's file, sidecar and imported
  data are; from then on an event on one of those paths marks its asset
  changed and its file unverified, and the check before Play visits only the
  changed assets and the records added, moved or re-imported since (the
  list is compared by identity only when it was replaced). A change to a
  directory an indexed file is under (renamed, removed, a symlink changed)
  is not followed file by file: the next check is a full one. Everything is
  looked at again when the watch cannot be relied on: it failed or errored,
  an event came without a name, a turn of the event loop delivered as many
  events as the kernel queues (`max_queued_events`: libuv drops inotify's
  overflow notice, so the count is the only sign), after a restart (the
  stamps kept since 26.8 make that walk one stat per asset),
  `THIRDLIGHT_FILE_WATCH=off`, or no watch on the platform. What a watch
  cannot see (a write through a hard link from outside the game folder, a
  change racing the click) is still caught when Play sends the file (hashed
  while sent, refused, re-checked). The backend's own sidecar writes mark
  their asset too (one extra stat at the next Play).
- 2026-09-30 (26.14, Play start): one walk. The closure's locate trusts a
  file the watch index verified and saw no event on since (no `realpath`,
  no `stat`), and a converted asset's import-cache entry once a build found
  it; anything else is located and checked as before.
- 2026-09-30 (26.14, Play start): the content view and the catalog are
  remembered by the identity of the frozen inputs they come from (the
  captured project is deep-frozen and replaced piece by piece): a scene's
  validated entities by its entity list (a capture stamps only `revision`),
  an asset version's view row by its version and record, the view's digest
  per content block with the parts it came from, each shipped asset's
  catalog input and entry, an entry's and a block item's JSON, a shard's,
  part's or scene dependency file's bytes by the items it holds, each
  scene's dependencies per content object and entity list. A build of an
  unchanged capture re-stamps the manifest (`capturedAt`, `buildId`) and
  makes no catalog file. The bytes are those of the whole-value
  serialization (checked byte for byte against `dc442d71` on the full bench
  project: content digest, build id, manifest and all 339 catalog files).
  Full-size closure after a scene edit 306 → ~110 ms, a second Play of the
  same revision ~30 ms; the first build of a capture is not cheaper
  (~460 ms at full: every row made once).
- 2026-09-30 (26.14, Play start): the Play build is made ahead. After a full
  file check the backend builds the next Play in the background (its stages
  give the event loop back), unless a Play is starting or running or that
  revision was built already; a Play asked for meanwhile waits for it and
  then only re-stamps. Unity keeps imports and compiled scripts ready before
  Play mode the same way. Not done: a build ahead after every command (a
  second ~100 ms of work per edit at full size, for Plays that may not
  come).
- 2026-09-30 (26.14, commands): what a content edit still walked. A
  material edit re-ran the project-wide address check over every asset and
  resource and the references of every material; now the address check runs
  when the assets, the loadable rows or a resource list's ids changed, and
  the material references of the materials the edit replaced (instances
  always: their parameters come from their chain; graph, effect,
  environment, input, animator and bake references only when those changed).
  The entity-id uniqueness check across scenes keeps a count per id and
  recounts only the scenes a command replaced (a content edit recounts
  none); the index and the resource file writes compare a replaced list
  position by position and copy its path map only when a path changed.
  In-process at full size a material edit is 13.3 → 7.4 ms p50 (×0.01:
  3.8–4.6 ms), a transform edit 6.1 → 6.0 ms (×0.01 4.0 ms).
- 2026-09-30 (26.14, commands): what is left is the flush. A command's
  files are written and flushed (file and directory) before it is answered;
  the flush costs the same per command at every size on an idle disk, but
  pays for other dirty data on the disk: right after a large open (the
  record cache written in the background) or a copy of the project, single
  flushes of 20–50 ms show up in p95 (in-process runs on the same data
  varied 7–20 ms p50 with the disk state alone). Durability is kept; the
  record cache and stamps stay unflushed.
