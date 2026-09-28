# Phase 26 — Asset scale and streaming

Goal: a project holds as many assets and resources as a full-size game needs
(thousands of voice lines, textures, models, prefabs, materials, scenes), and
the runtime loads and unloads them as the game asks, inside memory budgets.
Loading and unloading is core engine, not an optimization. Read
`docs/roadmap.md` (principles 1 and 1b) first. Phase 26 starts after phase 25;
documentation moved to phase 27 so the manual describes the engine after this.

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
  file is decoded or streamed is the engine's business, chosen per file.
- **Loading and unloading at runtime is core to the engine.** Every kind of
  asset is loaded when something needs it and released when nothing does,
  under budgets, and the game can see and steer it.

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
- **Audio:** `audio` must be 2 s mono 48 kHz 16-bit WAV
  (`AUDIO_PCM_WAV_PROFILE`, `types-v3.ts:527`); `music` is Ogg/Opus/MP3/WAV up
  to 16 MiB and 10 min. Event cues and dialogue blips take `audio` only.
  Every `audio` asset is read and decoded when the game mounts
  (`game-host/src/host.ts:1388`); decoded buffers of both kinds are kept
  until the page closes.
- **Storage and commands:** every command re-validates the whole content
  document and rewrites the whole `content.json`
  (`commands/src/ops.ts:311`, `workspace/src/session-v4.ts:344`); a blob read
  scans the catalog (`content-store.ts:878`); each publish stats every blob
  for the quota (`content-store.ts:644`).
- **Play and export:** each build reads and verifies every asset reachable
  from any scene into memory (`exporter/src/content-closure.ts:569-612`); the
  export bundle hard-codes every artifact path in a `switch`
  (`exporter/src/export-bundle.ts:62-75`).
- **Runtime caches:** models are refcounted and disposed when their last
  scene unloads (25.24e). Nothing else is evicted: verified bytes
  (`game-host/src/asset-reader.ts:73`), material-library textures
  (`three-adapter/src/material-library.ts:202,477`), environment and effects
  caches, decoded audio, fonts. No memory budget or LRU exists anywhere.
- **Editor:** the session holds only the first 128 assets, prefabs and
  behaviors (`backend/src/backend.ts:357`, `editor/src/session/client.ts:615`);
  more arrive only on "Refresh". The asset panel fetches every texture's full
  bytes and parses every GLB to draw its tiles (`editor/src/ui/App.tsx:1110`),
  and the list is not virtualized (`AssetBrowser.tsx:112`).

## 3. Items

Order: measure → storage → caps → audio → backend → manifest and export →
runtime → editor → acceptance. One format bump for the phase: `project.json`
schemaVersion 5 and runtime content manifest version 5; a 4 is upgraded on
open (25.7 made it 4), and the upgrade is tested on fixtures like 25.7a's.
Each item keeps the gate green and is tested at the boundary it changes
(Playwright for any editor surface).

| Item | What |
|---|---|
| 26.0 | This plan, and its rows in `docs/STATUS.md` and `docs/roadmap.md`. |
| 26.1 | **Scale bench.** A generator (`tools/`) that writes a synthetic project of a full game's size: 10,000 voice lines (1–15 s Opus) and 1,000 other sounds, 5,000 textures, 2,000 models, 5,000 prefabs, 2,000 materials, 300 scenes and 2,000 dialogue nodes with voices. A perf-harness class that measures open, one command's latency, Play start, scene load, memory resident while walking 50 scenes, a 500-line voiced dialogue played through, and export. Run it first with the caps lifted in a scratch branch to find what breaks, and record the before numbers in §5. |
| 26.2 | **Content stored per record.** The catalog and the project's resources (assets, prefabs, materials, material functions, behaviors, libraries, graphs, UI documents and themes, dialogue, timelines, effects, animators, environment presets) each live in their own file under `content/`, with a small index `content.json` keeps. A command validates the records it touches plus the references into and out of them, and writes only the files that changed. Undo, history, the WebSocket change feed and MCP stay as they are. Open reads the index and loads records as they are asked for. A crash mid-write never leaves a half project (write then rename, as today). |
| 26.3 | **Count caps removed.** Every per-project count listed in §2 goes, in the model, commands, editor, game host, MCP descriptions and docs. The 1 MiB content cap becomes a per-record byte cap. The 512 MiB project quota goes; publishing refuses only when the disk is short, with the free space in the message. The project-wide animation-key budget becomes a per-model one. A test fails if a new per-project count cap on importable or project content appears (it looks for `MAX_*` count constants checked against a catalog length). Per-object caps (nodes per graph, widgets per document, keys per track, entities and colliders per scene, lights active at once) stay; they bound one thing, not the project. |
| 26.4 | **One audio kind.** `audio` accepts Ogg Vorbis, Opus, MP3, WAV (any channel count, rate and bit depth the browsers decode) and FLAC, checked against the MDN codec tables for Chromium, Firefox and Safari; no duration cap; a per-file size cap only. `music` records become `audio` on upgrade (ids kept). Every reference (dialogue voice and blip, audio source, event cue, timeline key, `ctx.audio.play`, `ctx.audio.music`) takes any audio asset. The editor's drop and MCP's `tl_content_upload` take every audio extension as `audio`. Import reads the header only (duration, channels, rate), as today; no transcoding. |
| 26.5 | **Backend reads scale.** Blob lookup by an index, not a catalog scan. Queries page from a sorted index instead of copying and sorting the catalog. Play and export no longer read every reachable asset per build: an asset's bytes are verified once per digest (kept across builds), and Play serves them from disk at the stable digest URLs of 25.24c instead of holding them in the backend's memory. Play start time and the backend's memory do not grow with the number of assets in the project. |
| 26.6 | **Manifest and export scale.** Asset rows, rigs and prefabs leave the inline manifest for content files listed by digest (as 25.7b did for materials), split so a scene's load reads only what it needs. The export bundle no longer bakes every artifact path into its code; it reads them from the manifest. Export streams files to disk instead of holding the closure in memory. |
| 26.7 | **Runtime resource manager.** One manager in the game host for everything loaded from assets: verified bytes, models, textures (loaded images, `ImageBitmap`s closed), animation clips, audio, fonts, environment maps and effect models. Each resource is held by references (loaded scenes, live entities, playing sounds, script handles) and released when the last one goes. Released resources stay cached until a budget needs the room, then leave least-recently-used first. Budgets for GPU memory (textures and geometry), decoded audio and raw bytes, with defaults sized for a mid-range laptop and project settings to change them. Scene read-ahead (25.24e) and dialogue ask the manager to prefetch. Scripts get `ctx.assets.preload(ids)` / `release(handle)` and a loading state; the simulation never waits on a load (presentation stays out of determinism). `tl_game_observe` and Play diagnostics report resident bytes per budget, loads, evictions and misses. Scene view and Play share it. |
| 26.8 | **Audio streaming.** No audio is read at mount. Short files decode into buffers under the audio budget; long ones stream (a media element through Web Audio, or chunked decode; the choice is checked against current browser behaviour first). A sound asked for before it is ready plays when ready, or is dropped past a lateness bound the caller can set; either way the observation says which. Dialogue prefetches the next lines' voices (every branch within a small depth), so a voiced conversation has no gap. The 64-entry audio stores go. |
| 26.9 | **Editor at scale.** The session holds the index, not the first 128 records; lists, pickers and search page from the backend. Asset tiles come only from backend thumbnails (textures and models alike); a model's pieces load when it is selected, not to draw its tile. The Scene view's model store releases models no scene uses, through 26.7's manager. The 25.23 project window's virtualized list carries the catalog. Playwright on the scale bench: open, search, scroll the whole catalog, place an asset, pick a voice for a dialogue line. |
| 26.10 | **Acceptance and docs.** The scale bench's after numbers in §5, with targets fixed from 26.1's before numbers (as 25.24 did). The limits table in `docs/deployment.md` lists per-file sizes and runtime budgets only. MCP tool descriptions updated. |

**Done when:**
- The scale bench opens, edits, plays and exports in a real browser on both
  renderers. One command's latency and Play start do not grow with the
  project's asset count.
- Walking 50 scenes stays inside the memory budgets (measured, not assumed).
  A 500-line voiced dialogue plays through with no gap and bounded decoded
  audio.
- No per-project count cap remains on importable or project content, and the
  test from 26.3 guards it.
- A version-4 project opens and upgrades; its replays still match.
- `tools/gate.sh full` is green.

## 4. Progress

| Item | Status |
|---|---|
| 26.0 | done 2026-09-28 |
| 26.1–26.10 | — |

## 5. Measurements

(26.1's before numbers and 26.10's after numbers.)

## 6. Decision log

- 2026-09-28: where the caps came from. The first ones (128 models, 16
  sounds, the 2 s mono WAV profile, the 1 MiB content document) were in the
  M2–M4 packet specs (snapshot `0adc7aa`); later phases copied the pattern
  for textures (256), music (64) and the rest. They sized the project for a
  sample, not a game. 25.7c's decision to keep a count of 64 sounds "for no
  case that needs it" is reversed here: voiced dialogue needs thousands.
- 2026-09-28: phase 26 is this plan; the documentation plan became phase 27
  so the manual and its limits page describe the engine after it.
