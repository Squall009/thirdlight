# Phase 26 — Asset scale and streaming

Goal: a project holds as many assets and resources as a full-size game needs
(thousands of voice lines, textures, models, prefabs, materials, scenes), and
the runtime loads and unloads them as the game asks. Loading and unloading is
core engine, not an optimization. The design follows Unity and Godot (§3)
rather than inventing its own. Read `docs/roadmap.md` (principles 1 and 1b)
first. Phase 26 starts after phase 25; documentation moved to phase 27 so the
manual describes the engine after this.

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

## 2. Where things stand (checked at `34847ae`, 2026-09-28)

- **Count caps** (`project-model/src/content.ts:91-127`, copied into
  `commands/src/content-ops.ts:156-184`, `scene-ops.ts:20`, `prefab-ops.ts:69`,
  `editor/src/session/prefab-authoring.ts:49`, `game-host/src/audio.ts:72,271`,
  `mcp-adapter/src/tools.ts`, `docs/deployment.md`): 128 models, 256 textures,
  64 sounds, 64 music, 16 fonts, 1024 version records, 128 prefabs, 64
  behaviors, 64 scenes (32 in the shell's scene list), 256 materials, 64
  animators, 64 timelines, 64 UI documents, 256 dialogues, 128 effects, 64
  graph documents, 32 script libraries, 64 environment presets, 64 event
  cues; a project-wide 1,048,576 animation keys (`model-rig.ts:79`).
- **Byte caps that act as count caps:** the whole content document is one
  file, `content.json`, at most 1 MiB (`MAX_CONTENT_BYTES`); the runtime
  manifest is at most 256 KiB with asset rows, rigs and prefabs inline; a
  project's sources are at most 512 MiB together
  (`workspace/src/content-store.ts:79`); a Play content set at most 512 MiB
  in the backend's memory (`protocol/src/delivery.ts:33-35`).
- **Asset storage:** uploads are copied into `thirdlight/sources/sha256/`;
  in a folder project an asset may instead reference a game-folder file in
  place (path and SHA-256, phase 10). Each asset keeps a list of versions;
  a changed file is an error until someone re-imports it.
- **Audio:** `audio` must be 2 s mono 48 kHz 16-bit WAV
  (`AUDIO_PCM_WAV_PROFILE`, `types-v3.ts:527`); `music` is Ogg/Opus/MP3/WAV up
  to 16 MiB and 10 min. Event cues and dialogue blips take `audio` only.
  Every `audio` asset is read and decoded when the game mounts
  (`game-host/src/host.ts:1388`); decoded buffers of both kinds are kept
  until the page closes.
- **Commands:** every command re-validates the whole content document and
  rewrites the whole `content.json` (`commands/src/ops.ts:311`,
  `workspace/src/session-v4.ts:344`); a blob read scans the catalog
  (`content-store.ts:878`); each publish stats every blob for the quota
  (`content-store.ts:644`).
- **Play and export:** each build reads and verifies every asset reachable
  from any scene into memory (`exporter/src/content-closure.ts:569-612`); the
  export bundle hard-codes every artifact path in a `switch`
  (`exporter/src/export-bundle.ts:62-75`). Assets a script names by string
  are found by scanning script literals (25.7c).
- **Runtime caches:** models are refcounted and disposed when their last
  scene unloads (25.24e). Nothing else is released: verified bytes
  (`game-host/src/asset-reader.ts:73`), material-library textures
  (`three-adapter/src/material-library.ts:202,477`), environment and effects
  caches, decoded audio, fonts. No memory budget exists anywhere.
- **Editor:** the session holds only the first 128 assets, prefabs and
  behaviors (`backend/src/backend.ts:357`, `editor/src/session/client.ts:615`);
  more arrive only on "Refresh". The asset panel fetches every texture's full
  bytes and parses every GLB to draw its tiles (`editor/src/ui/App.tsx:1110`),
  and the list is not virtualized (`AssetBrowser.tsx:112`).

## 3. How Unity and Godot do it (checked 2026-09-29)

| Topic | Unity 6 | Godot 4 | Thirdlight after phase 26 |
|---|---|---|---|
| Asset database | Each file under `Assets/` has a `.meta` sidecar with a GUID and its import settings; references use the GUID. Imported artifacts are cached in `Library/` and can always be regenerated. [1][2] | Each imported file has a `.import` sidecar; imported data in `.godot/imported/`; stable `uid://` references (`.uid` files for scripts and shaders since 4.4). [9] | Each file in the game folder has a `.tlasset` sidecar (stable id, kind, import settings, labels); imported data in a rebuildable cache keyed by digest. No count limit. (26.2) |
| Project resources | Scenes, prefabs, materials are asset files in `Assets/`, in real folders. | Scenes and resources are files in `res://`. | Each scene, prefab, material, … is its own file, in real folders of the game folder. (26.3) |
| Audio | One `AudioClip`. Load Type per clip: Decompress On Load, Compressed In Memory, Streaming; Preload Audio Data, Load In Background; per-platform overrides. [3] | One `AudioStream` family (WAV, Ogg Vorbis, MP3); docs advise WAV for short effects, Ogg for music, speech and long effects — advice, not a type split. [12] | One `audio` kind; load type per file (decode on load, decode while playing, stream), default by length. (26.5) |
| Runtime loading | Scenes load what they reference. Code loads by key or label (`Addressables.LoadAssetAsync`) and must pair each load with `Release`; the count reaching zero frees memory when its bundle unloads. `Resources.UnloadUnusedAssets` frees what nothing uses. [4][5] | `Resource` is refcounted and freed when no longer used; `ResourceLoader` caches by path while referenced; background loads with `load_threaded_request` / `_get_status` / `_get`. [10][11] | Refcounted resources, freed when the last holder goes (Godot); scripts load by id, address or label and release handles (Addressables). (26.9) |
| Memory budget | Texture mipmap streaming budget (`streamingMipmapsMemoryBudget`, all textures). [6] | None in 4.7 stable; 4.8 dev 5 adds opt-in mip streaming ("Texture2D Streamed"). [14] | Texture mip streaming under a budget, after 25.19's KTX2 mip chains. (26.11) Other kinds are freed by refcount, not a budget. |
| Build inclusion | Scenes in the build list and what they reference; `Resources/` always; addressable assets (loadable by key) in a separate content build with a catalog. [4][7] | Export modes: all resources, selected scenes and dependencies, selected resources and dependencies, all except selected. [13] | What the start and listed scenes and resources reference, plus assets marked loadable (an address or a label), listed in a catalog. (26.6, 26.8) |
| Editor | Project window, real folders, search `t:AudioClip l:voice`, cached thumbnails. [8] | FileSystem dock over `res://`. | Project window over real folders, same search, thumbnails from the import cache. (26.12) |
| Unreal (for reference) | Asset Registry indexes unloaded assets; soft object pointers loaded with `FStreamableManager::RequestAsyncLoad`; texture streaming pool budget. [15] | | The index of 26.3 is the Asset Registry's role. |

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

Order: measure → asset database → resources as files → caps → audio →
labels → backend → manifest and export → runtime → audio loading → texture
streaming → editor → acceptance. One format bump for the phase:
`project.json` schemaVersion 5 and runtime content manifest version 5; a 4
is upgraded on open (25.7 made it 4) and the upgrade is tested on fixtures
like 25.7a's, replays included. Each item keeps the gate green and is tested
at the boundary it changes (Playwright for any editor surface).

| Item | What |
|---|---|
| 26.0 | This plan, and its rows in `docs/STATUS.md` and `docs/roadmap.md`. |
| 26.1 | **Scale bench.** A generator (`tools/`) that writes a synthetic project of a full game's size: 10,000 voice lines (1–15 s Opus) and 1,000 other sounds, 5,000 textures, 2,000 models, 5,000 prefabs, 2,000 materials, 300 scenes and 2,000 dialogue nodes with voices. A perf-harness class that measures open, one command's latency, Play start, scene load, memory resident while walking 50 scenes, a 500-line voiced dialogue played through, and export. Run it first with the caps lifted in a scratch branch to find what breaks, and record the before numbers in §6. |
| 26.2 | **Asset database: files and sidecars** (Unity `.meta`, Godot `.import`). Every imported file lives in the game folder; an upload from the browser or MCP is written there (a default `assets/` folder, or the folder the user drops it in). Next to it, `<file>.tlasset` holds the asset's stable id, kind, import settings, labels and address. References use the id, so a move or rename keeps them (the editor moves the sidecar with the file; a sidecar found at a new path outside the editor is the same asset). The file is the truth: a changed file is re-imported when the backend notices (project open, window focus, "check files", as today), and the change goes out on the change feed; there is no per-asset version list (history is the game repo's, as in Unity and Godot). Imported data (FBX → GLB, audio and image headers, thumbnails, later KTX2) goes in `thirdlight/cache/imported/`, keyed by source digest, settings digest and importer version, git-ignored and rebuilt when missing. Projects in the data root get the same layout in their own folder. Upgrade: each asset's current version is written out as a file with its sidecar; older versions stay in `thirdlight/sources/` untouched and are listed in the upgrade report. |
| 26.3 | **Project resources as files, with an index.** Each scene, prefab, material, material function, behavior, library, graph, UI document and theme, dialogue, timeline, effect, animator and environment preset is its own file with a stable id, in real folders the user chooses (25.23's folders become these directories). `content.json` keeps only project-wide settings. The backend keeps an index of every asset and resource (id, kind, path, name, labels, references out), rebuilt from the files on open and updated by each command (Unreal's Asset Registry role), so open and queries don't parse everything. A command validates the files it touches plus the references into and out of them, and writes only those (write then rename, as today). Undo, history, the change feed and MCP work as before. |
| 26.4 | **Count caps removed.** Every per-project count in §2 goes, in the model, commands, editor, game host, MCP descriptions and docs. The 1 MiB content cap becomes a per-file byte cap. The 512 MiB project quota goes; an import refuses only when the disk is short, with the free space in the message. The project-wide animation-key budget becomes a per-model one. A test fails if a per-project count cap on assets or resources comes back. Per-object caps (nodes per graph, widgets per document, keys per track, entities and colliders per scene, lights active at once) stay; they bound one thing, not the project. |
| 26.5 | **One audio kind** (Unity `AudioClip`, Godot `AudioStream`). `audio` takes Ogg Vorbis, Opus, MP3, WAV and FLAC in any channel count, rate and bit depth, checked against the MDN codec tables for Chromium, Firefox and Safari; no duration cap; a per-file size cap only. Import settings in the sidecar: **load type** (decode on load, decode while playing, stream), default by length (under 5 s decode on load, over 60 s stream, between decode while playing; the thresholds fixed from 26.1's measurements), and **preload** (read with its scene or only when played). `music` records become `audio` on upgrade (ids kept). Every reference (dialogue voice and blip, audio source, event cue, timeline key, `ctx.audio.play`, `ctx.audio.music`) takes any audio asset; sound, music, voice and UI are mixer buses only, as today. No transcoding (Unity's compression settings would need it; revisited only if a real game needs it). |
| 26.6 | **Addresses and labels** (Addressables). An asset or resource may have an address (a name scripts use; default none) and labels (`voice`, `level-3`, …), set in the Inspector, the project window and through MCP (commands, one undo). An asset with an address or a label is **loadable**: the export includes it even if no scene references it. The 25.7c scan of script string literals becomes a Problem ("script names an asset that isn't loadable") instead of a build rule. |
| 26.7 | **Backend reads scale.** Blob and file lookup through the index. Queries page from the index instead of copying and sorting the catalog. Play and export no longer read every reachable asset per build: a file's digest is checked once per change (kept across builds), and Play serves files from disk at the stable digest URLs of 25.24c instead of holding them in the backend's memory. Play start time and the backend's memory do not grow with the number of assets. |
| 26.8 | **Catalog, manifest and export scale.** The runtime manifest keeps the start and the catalog's location; the catalog (id, address, labels, digest, kind, load settings, dependencies) is content files listed by digest (as 25.7b did for materials), split so a scene's load reads only what it needs. The export includes what the start scenes, the shell's scene list, loaded-by-reference scenes and resources reference, plus every loadable asset (Unity's build-list-plus-addressables, Godot's "selected scenes and dependencies" plus "selected resources"). The export bundle no longer bakes every artifact path into its code, and export streams files to disk instead of holding the closure in memory. |
| 26.9 | **Runtime resource manager** (Godot's refcounted `Resource`, Addressables' handles). One manager in the game host for everything loaded from assets: verified bytes, models, textures (`ImageBitmap`s closed), animation clips, audio, fonts, environment maps and effect models. A resource is held by its holders (loaded scenes, live entities, playing sounds, script handles) and freed when the last one goes, after the step's scene changes settle, so a transition that unloads and reloads the same model doesn't drop it. Scripts get `ctx.assets.load(idOrAddressOrLabel)` → a handle with a state (loading, ready, failed) and `ctx.assets.release(handle)`; a load of a label loads every asset carrying it. The simulation never waits on a load (presentation stays out of determinism; a script reads the state). Scene read-ahead (25.24e) goes through the manager. `tl_game_observe` and Play diagnostics report what is resident (count and bytes per kind), loads, frees and handles not released at the end of a play. Scene view and Play share it. |
| 26.10 | **Audio loading.** No audio is read at mount. Each file loads per its load type: decode on load into a buffer; decode while playing (compressed bytes kept, decoded per play); stream (a media element through Web Audio). The browser mechanics (decode per play vs chunked decode, media elements in a worker-driven page) are checked against current browser behaviour before choosing. A sound played before it is ready starts when ready, or is dropped past a lateness bound the caller sets; the observation says which. Dialogue loads the next lines' voices ahead (every branch a few nodes deep), so a voiced conversation has no gap. The 64-entry audio stores go. |
| 26.11 | **Texture streaming under a budget** (Unity's mipmap streaming budget, Unreal's streaming pool, Godot 4.8's streamed textures). Textures with mip chains (KTX2 from 25.19) load their smallest mips first and higher ones by on-screen size, inside a GPU texture budget (a project setting with a default for a mid-range laptop); over budget, the least-needed mips drop first. Opt-in per texture in its import settings, on by default for textures over 1024 px. Both renderers; pixels checked. |
| 26.12 | **Editor at scale.** The session holds the index, not the first 128 records; lists, pickers and search page from the backend. The project window (25.23) browses real folders, virtualized, with Unity-style search (`t:audio l:voice name`). Tiles come from the import cache's thumbnails; a model's pieces load when it is selected, not to draw its tile. The Scene view's models and textures go through 26.9's manager and are freed when no scene uses them. Playwright on the scale bench: open, search, scroll the whole catalog, place an asset, give a dialogue line a voice, label 1,000 files at once. |
| 26.13 | **Acceptance and docs.** The scale bench's after numbers in §6, with targets fixed from 26.1's before numbers (as 25.24 did). The limits table in `docs/deployment.md` lists per-file sizes and runtime budgets only. MCP tool descriptions updated. |

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
  26.4 guards it.
- A version-4 project opens and upgrades; its replays still match.
- `tools/gate.sh full` is green.

## 5. Progress

| Item | Status |
|---|---|
| 26.0 | done 2026-09-29 |
| 26.1–26.13 | — |

## 6. Measurements

(26.1's before numbers and 26.13's after numbers.)

## 7. Decision log

- 2026-09-28: where the caps came from. The first ones (128 models, 16
  sounds, the 2 s mono WAV profile, the 1 MiB content document) were in the
  M2–M4 packet specs (snapshot `0adc7aa`); later phases copied the pattern
  for textures (256), music (64) and the rest. They sized the project for a
  sample, not a game. 25.7c's decision to keep a count of 64 sounds "for no
  case that needs it" is reversed here: voiced dialogue needs thousands.
- 2026-09-28: phase 26 is this plan; the documentation plan became phase 27
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
