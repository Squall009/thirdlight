# Phase 25 — Requests from Sprout and Skyforge Tactics

Goal: close the engine gaps the two game projects reported, as generic
capabilities. Read `docs/roadmap.md` (principles 1 and 1b) first. Phase 25
starts after phase 24 is finished; nothing here is added to phase 24.

Sources, checked against main at `6cb394a` (2026-09-28). The plan was
reconciled with what phase 24 did at `9ca1c1d` (step 0, §6):
- Sprout: `~/projects/sprout/docs/thirdlight_requests.md` (ids TL-1 … TL-22)
- Skyforge Tactics: `~/projects/skyforge-tactics/docs/engine-gaps.md`
  (ids E1 … E40)

The engine never reads either repo. The ids are only here so a request can
be traced back to the game that raised it.

## 1. Owner decisions (2026-09-28)

- **Everything goes in phase 25.** Phase 24 is not extended. The id space
  and the manifest cap wait for this phase rather than for 24.8's schema
  bump.
- **Lights belong to scenes.** Any scene may hold any light kind. At most
  one directional light is active at a time. Spot lights get cookies;
  directional lights don't.
- **The scripting model (E38)** is taken in the shape of §3: shared
  libraries, generic component reads, writes only to fields marked writable,
  callbacks, and source-mapped errors. Ownership is relaxed but not dropped.
  Fully dropping ownership is revisited only if a real game hits the limit.
- **Play-testing:** the engine ships a generic headless runner. A genre bot,
  such as Sprout's platformer bot, is game code and stays in the game's repo.
- **Entity ids:** wider global ids. Ids scoped per scene are revisited only
  if a real game hits the wider limit.

## 2. Closed without engine work

| Request | Why |
|---|---|
| E1–E17 | Done in phase 23. The leftovers that are still open are items 25.20 and 25.21. |
| TL-1 | Done: project UI HUD documents and `content.shell.hud`. |
| TL-1 addendum (`preset: 'none'`) | With `content.shell` no built-in HUD is drawn and the status line is opt-in. The flow and its HUD presets were deleted in 24.7. |
| TL-5 (enemy APIs) | This is a game rule. It is now covered by `health`, `patrol` and `hitbox` (24.4b–d). The generic remainder is in 25.13. |
| TL-9 (`completeLevel`, cutscene flow entries) | This is a game rule. It is now covered by `trigger.sceneTransition` and the shell's scene list (24.4e, 24.4j). The remainder is in 25.10. |
| TL-10 (death, respawn and checkpoint events) | These are game rules. Generic `damaged` and `died` events and trigger enter/exit events already exist. |
| TL-18, level-start path | That start path was deleted with the flow in 24.7; every game now starts as a scene. The remaining check is in 25.17. |
| TL questions 1 and 2 | Q1: automatic instancing exists (21.3). Q2: a mover carries whatever stands on it, whatever the collider shape. Sideways pushing on polygon colliders is checked in 25.4's tests. |

## 3. The scripting model (items 25.8–25.10)

Today every engine system has its own script service on `ctx` (about 35:
`health`, `patrol`, `look`, `camera`, `materials`, `sockets`, …). Writes are
intents applied at the end of the step. A behavior moves only the transforms
it declares in `ownedTransforms`; physics bodies and the camera can't be
claimed. Any property without a service needs a new engine API, which is
where most of the games' new requests come from.

Phase 25 adds one generic path next to the services:

1. **Shared libraries.** Libraries are compiled once, minified and tree
   shaken, and loaded as shared runtime modules. Behaviors link to them
   instead of bundling them. The determinism pins cover the linked output.
   This fixes E34 and E33.
2. **`ctx.entity(ref).get(component)`**: a read-only snapshot of any
   component, taken from the step-start state. Only fields the component
   descriptors mark as script-readable are exposed. The descriptors are
   versioned with the schema, so a field rename is a schema change and not
   a silent break.
3. **`ctx.entity(ref).set(component, patch)`**: a queued write, applied at
   the end of the step in a fixed order like intents today. Only fields that
   the descriptors mark `runtimeWritable` are accepted. Each such field has
   defined runtime behavior and its own test. Fields the engine treats as
   fixed at run time are not writable: static batching, baked lightmaps,
   static colliders, instancing, and assets that need loading. A write to any
   other field is refused with a problem naming the field.
4. **Relaxed ownership.** Any script may write the transform of an object
   that is neither a physics body nor the camera. Two writes to the same
   object in one step are resolved in script order, and the conflict is
   reported in diagnostics. Physics bodies keep dedicated intents
   (`character_place`, which is 3D-only today and gains the 2D plane in
   25.10).
5. **Callbacks** on the behavior spec: `onTriggerEnter/Exit`, `onContact`,
   `onMessage`, `onUiEvent`, `onAnimatorEvent`, and
   `onEnable/onDisable/onDestroy`. They are dispatched inside the step in a
   fixed order, on top of the event lists that already exist, which stay.
   Replays stay identical.
6. **Typed references.** `entityRef` properties become the normal way to wire
   objects, and prefab-local references work in spawned copies. `find(name)`
   stays.
7. **Source-mapped errors.** The editor shows the project's own sources, and
   error and log locations map back to the source files.

Services that act rather than set a field (`health.damage`,
`character.impulse`, `audio.play`, dialogue, timelines) stay. They carry
rules (events, clamping, physics) that a raw write can't. The generic path
replaces future "let scripts change field X" APIs, not the existing
services.

## 4. Items

Order: bugs → Play-start speed (25.24) → limits → scene lighting →
scripting → movement → tools → rendering and terrain (the project window,
25.23, moved to phase 26). Each item keeps the gate green and has tests at the
boundary it changes (Playwright for any editor surface).

| Item | What | Requests |
|---|---|---|
| 25.0 | This plan, and its row in `docs/STATUS.md` and `docs/roadmap.md`. | — |
| **Bugs** | | |
| 25.1 | One exported manifest key list. Partly done in 24.8: the preview and both exporter paths now take the order from `MANIFEST_KEYS_V2` (`manifest-v2.ts:98`; used at `preview-m3.ts:400`, `export-m3.ts:510`, `export-bootstrap-m3.ts:164`), so the `modes` mismatch is gone. Left: a test that builds, verifies, plays and exports a manifest with every optional key present (`modes`, timelines, eventCues and shell together), so the lists can't drift again. | TL-15 |
| 25.2 | Screenshots always answer. The preview handler sends `screenshot_failed` with the reason whenever capture throws (`preview-m3.ts:895`). Add a WebGPU capture path (render and read back in the same task, or read a render target). Check that image textures upload in headless WebGPU. | TL-14, E24 |
| 25.3 | Environment blends are cheap. A new `t` updates fog, exposure and light uniforms; the environment map is re-baked only when its sky inputs change past a threshold (`three-adapter/src/environment.ts:412`, `updateSkyInPlace`, and `rebakeIbl` at 387). Acceptance: a new `t` every step at 120 Hz drops no steps once loaded. | TL-21 |
| 25.4 | 2D internal edges. The 2D character (`packages/character`) doesn't ground on or hang at internal edges between static colliders that share a face. Stacked or tiled colliders behave like one surface. | TL-20 |
| 25.5 | Scripts see a timeline's `ended` event. Reproduce first with a script-level test, main thread and sim worker, then fix. Add a play-end reason. A play that ends before it is presented records why (e.g. "the project reloaded"), and observe and diagnostics report it instead of a bare `play_not_found`. | TL-17, E26 |
| 25.6 | Small fixes:<br>• glTF `extras` are accepted and ignored on materials and every other object.<br>• The import scan says when a hit is in a comment or string, and gives the line.<br>• A `createEntity` refusal for a `setComponent`-only component says so.<br>• `input.cursor` accepts every map in `input.maps` (today only `gameplay` and `ui`). | E19, E21, E23, E25 |
| **Limits** | | |
| 25.7 | Scale limits:<br>This is one format bump: `project.json` schemaVersion 4 (24.8 made it 3; a 3 is upgraded on load, as 24.8 upgrades a 2) and runtime content manifest version 4 (24.8 made it 3).<br>a. **Entity ids:** wider global ids (`<kind>-N`, at least 6 digits) in `commands/src/ops.ts:230`, `prefab-ops.ts:104` and `paste-ops.ts:63` (all `padStart(4)` today). Old four-digit ids still load. The limit is documented.<br>b. **Manifest:** buffers, materials, material functions, libraries, dialogue and UI documents move out of the capped manifest into their own content files, listed by digest. Unused materials are left out.<br>c. **Assets:** the audio cap is raised to 64 (or becomes a byte budget, whichever the limits doc makes consistent). `deleteAsset` and `deletePrefab`, each refused while anything references it.<br>d. **Instance sets** are also chunked by spatial extent (a project default, overridable per set), so each chunk is culled and LOD'd locally.<br>e. **Bulk building:** `createEntity` accepts `static`, `active`, `locked` and `tags`. A `createEntities` batch is one revision and one undo step. | TL-12, E37, TL-19, E35, TL-22, TL-4 |
| **Scene lighting** | | |
| 25.8 | Lights belong to scenes. Every light kind (directional, ambient, hemisphere, point, spot) may sit in any scene. The start-scene rule for lights is removed from the model (`project-v4.ts:144-186`; it already lets point and spot lights sit anywhere) and from the runtime (`runtime.ts:4094`, `addBatch`, which still refuses every light kind in a later-loaded scene). The camera and controller rules stay.<br>• Each scene holds at most one directional light.<br>• With scenes loaded on top of each other, the most recently loaded scene's directional light is active and the others are switched off, not added. When that scene unloads, the previous one comes back. Ambient and hemisphere lights follow the same rule.<br>• Point and spot lights from all loaded scenes count against the local-light budget.<br>• **Spot light cookies:** a texture on a spot light (three.js `SpotLight.map`, r186), in both renderers, with an Inspector field and a Scene-view preview. The WebGPU path is checked against the three.js docs first. Directional lights get no cookie.<br>Acceptance: a level scene with 12 point lights loads and they light it, and two scenes with different directional light colours switch correctly on load and unload. | TL-13, owner |
| **Scripting** | | |
| 25.9 | Shared libraries (§3.1), staged library edits (several patches, one commit, dependents compiled once) and source-mapped errors (§3.7). | E34, E33, E38 |
| 25.10 | Generic component access, relaxed ownership and typed references (§3.2–3.4, §3.6). First writable fields:<br>• light intensity, colour and range<br>• object `active`, with no rendering, collision, triggers or ticking while inactive<br>• `visible`<br>• the mover's speed and `active` flag<br>• material parameters<br>Also: `character_place` works on the 2D plane too, with velocity reset (it reuses the 2D placement of 24.4e's `sceneTransition` and 24.7's 2D `ctx.lifecycle.respawn`), and a script service `ctx.shell.nextScene()` (new; it queues the same move as the shell's `nextScene` UI action from 24.4j). | E38, TL-6, TL-11c, TL-2, TL-9 |
| 25.11 | Callbacks (§3.5). | E38 |
| **Movement** | | |
| 25.12 | Mover signals: `stopOn`, `reverseOn` and `toggleOn`, and a `gravity` easing (constant acceleration). | TL-8 |
| 25.13 | Character controller (`packages/character`, since 24.7): climb volumes (up/down input moves along them, jump leaves), and optional wall slide and wall jump. Both are off by default, in 2D and 3D. Gravity for bodies that aren't characters. `patrol` in 2D moves along any axis (24.4c walks the 2D plane along x only). | TL-7, TL-5 |
| 25.14 | The `track` virtual-camera rig (24.4g: target, offset, one dead zone, damping, one pair of bounds) gains camera regions (bounds, dead zone and distance per region, blended on enter) and vertical look-ahead. Scene handles for the dead zone and bounds (left open in 24.4g) come with it. | TL-11a/b |
| **Tools and tests** | | |
| 25.15 | Relay input (input frame version 2 since 24.8: relay frames are `{stepOffset, actions?, pointer?}` with named actions):<br>• run-length frames (`steps: n`)<br>• test frames drive the UI (pause, submit, cancel, navigate, and pointer clicks through the UI hit test), through the frame's `ui` events that the runtime frame already has<br>• `pointer().overUi`<br>• element rectangles in `tl_game_observe`<br>• a virtual standard gamepad<br>The tool descriptions say gaps are neutral. | E22, TL-16, E27, E28 |
| 25.16 | Mostly done in phase 24: every game plays as a scene (24.7), `replay` is the engine restart there (24.6), and the `start` control went with the session (a shell's new game replaces it). Left: a per-step digest in the observation for comparing a run with its replay. | E36 |
| 25.17 | A generic headless play-test runner: a CLI plus an MCP/API route taking a project folder, a scene, an input script or a project-supplied driver script, and an observation spec. It returns JSON. No genre bot ships with the engine. Also check that start `variables` apply on every start, including a shell's new game and a restart (one start path since 24.7). | TL-3, TL-18 |
| 25.18 | An engine-info route and `tl_inspect target="engine"`: commit, build time, start time, and whether `dist/` is newer than the running process. The backend runs `materialGraphProblems` on set and load, and reports the problems in `tl_diagnostics` and `tl_content_query target="materials"`. | E20, E31 |
| **Rendering and terrain** | | |
| 25.19 | Materials and textures: material instances (an asset- or block-type-level mapping to a material plus parameter values), KTX2 texture assets, and KTX2 encoding on import (colour ETC1S, normals UASTC, with mipmaps). | E29, E30 |
| 25.20 | Block layers: sloped terrain (corner heights, slope and wall meshing, `ctx.grid` surface queries, height and smooth brushes, a `maxSlope` setting); lightmaps and chunk LOD on block layers (phase 23 leftovers). | E39, E8 |
| 25.21 | A painted terrain material: 4 height-blended PBR slots packed into 3 compressed texture arrays, paint and wetness stored with the layer, and an editor Paint mode. Needs 25.19 and 25.20.<br>• **The height blend is a material-graph node** (layers mixed by their height maps, weights from any input), not terrain-only code: the terrain material is one graph using it, and any mesh can use it with its vertex colours as weights (trim sheets: clean → dirt → moss). Its test covers both a block layer and a vertex-coloured GLB.<br>• The Paint mode's brush (radius, strength, falloff, target channel) is its own module, so painting other targets (mesh vertex colours, a later phase) reuses it. | E40, owner |
| 25.22 | Small UI and content items: a bindable `startAngle` and `size` on UI widgets, and an art-factory import route. The route reads a job's export, not the art-factory repo. | E32, E18 |
| **Editor quality of life** | | |
| 25.23 | **Moved to phase 26** (owner, 2026-09-29): the project window is built on phase 26's storage, where folders are real directories of the game folder (26.4) instead of organization data in the content; its scope is in `docs/plan-phase-26.md` item 26.13. Not done in phase 25. | owner |
| 25.24 | **Faster Play start and scene loads.** Today every Play starts cold. The backend recompiles every behavior with esbuild and re-reads and re-hashes every asset. A new iframe re-downloads the 8.8 MB game bundle under a per-Play URL. `readDeclaredAssets` (`preview-m3.ts:252`) fetches and hashes **every asset of every scene, one at a time**, before mount. No pipelines are precompiled (no `compileAsync`), so the first frames stall; the large bench shows a 3.3 s frame. A runtime scene load does all its `addBatch` work in one step, then parses GLBs and compiles pipelines on first draw, with no preloading and no loading state. The large bench measured 4.5 s to first frame; asset-heavy real projects are unmeasured and likely much worse. In order:<br>a. **Stage timings** in play diagnostics and the perf harness: backend build, bundle load, asset read, worker start, mount, models settled, first frame, and the slow frames after it. Timings per scene load too. Add an asset-heavy class to the perf harness (many distinct GLBs and textures; the bench has one model). Measure before any fix, and record the split in §6.<br>b. **Asset reads:** only the start scenes' assets, read in parallel (bounded, e.g. 8 at a time). Other scenes' assets load when their scene does.<br>c. **Caching across Plays:** compiled behaviors keyed by source, compiler and library digests; blobs kept by digest instead of copied per Play; the bundle, worker and physics scripts and content served at stable, digest-keyed URLs with `immutable`/`ETag` headers, so the browser's HTTP and code caches hit. The digests are still verified.<br>d. **Pipeline precompile:** `renderer.compileAsync` before the first present and after each scene attach, in both renderers.<br>e. **Scene loads:** preload the scenes named in the shell scene list and in `trigger.sceneTransition` targets (fetch, parse, colliders prepared); spread `addBatch` over steps when it is over budget; a loading state scripts and UI can read, and an optional fade, so a transition never shows an empty world.<br>f. **Progressive presentation:** present once the start scene's blocking assets are in, and stream the rest. The 15 s present-timeout counts from the last progress, not from the start.<br>g. **Small items:** read the game bundle from disk once, not per Play; drop the page's second pretty-JSON serialize and hash of the scene (the buildId already binds it).<br>h. **Warm preview page:** keep a preloaded iframe (bundles parsed, worker and physics started) for the next Play. Only done if (a)'s split shows boot is still a large share after (b)–(g).<br>Acceptance: the before/after split in §6. On the GPU host, Play of an unchanged large project reaches its first frame in under 3 s from the second Play on, with no frame over 250 ms after it. A scene transition shows no empty frames. The exact targets are fixed from (a)'s numbers. | owner |
| 25.25 | Small requests found after the plan (added 2026-09-29, owner; done after 25.22):<br>• **Dialogue glyphs:** dialogue text renders `{action:x}` as the glyph of the device used last, as UI texts do.<br>• **Authored hidden objects:** an object can be placed hidden (`visible: false` in the scene data, Inspector checkbox, MCP), drawn but not shown until `ctx.game.setVisible`, `ctx.entity().set` or a timeline activation key shows it; hidden objects still simulate (unlike `active: false`). Saved scene data, not runtime-only.<br>• **Signals from tools:** `tl_game_control {signal: name, value?}` emits a signal in a running Play, as a script's emit would (timelines, effects, switches on signals testable without a script); also a `signal <name>` debug command. | E42, E43 (hidden part), E44 |

**Done when:**
- Every item above is done with its tests, and `tools/gate.sh full` is green.
- A new starter project can use in one scene: per-scene lights with a spot
  cookie, a script that reads and writes a light through `ctx.entity`, a
  shared library imported by two behaviors, a callback, and a mover toggled
  by signals. A Playwright test drives this through the editor.
- Each game's request doc can mark its items answered. That is a game-side
  edit made on the owner's say, not an engine item.

## 5. Progress

| Item | Status |
|---|---|
| 25.0 | done 2026-09-28 |
| Step 0 (reconcile with phase 24) | done 2026-09-28 |
| 25.1 | done 2026-09-28: every-optional-key unit test (all 23 keys, strict reader) and `manifest-keys.e2e.ts` (Play and static export); found and fixed D45 |
| 25.2 | done 2026-09-28: screenshots always answer (a throw or an over-bound PNG becomes `screenshot_failed` with the reason, relayed in the backend's message); WebGPU capture checked in pixels (GPU and headless SwiftShader), image textures in a GLB and a material upload there |
| 25.3 | done 2026-09-28: blended skies re-bake their lighting only past a threshold (colour 0.01, 1 %, sun 0.5°), into the same target from a kept bake scene; `iblRebakes` in Play diagnostics; `environment-blend-cost.e2e.ts`: a new t every step at 120 Hz, 0 dropped steps in 10 s on WebGPU and WebGL 2 (GPU host), 0 re-bakes when only fog/exposure/lights change |
| 25.4 | done 2026-09-28: static colliders sharing a face or overlapping act as one surface for the 2D character (no ground or hang at seams: port, integration and Play tests); D46 (left-wall hold) and D47 (polygon mover push fail-stop) fixed; replay fixtures unchanged |
| 25.5 | done 2026-09-28: `ended` reproduced as seen by scripts (main thread, worker, no physics/2D/3D, modes, real Play) — TL-17 did not reproduce, tests kept as guards; an ended play's routes answer `play_not_found` with `ended {reason, presented, at, detail?}`, unpresented ends listed in problems |
| 25.6 | done 2026-09-28: glTF extras accepted, import-scan hits located (line, comment/string/regex), createEntity refusal says how to add a setComponent-only component, cursor per any input map |
| 25.24a | done 2026-09-28: stage timings in Play diagnostics (`startTimings`: bundle, manifest, start scenes, worker, assets, mount, models, ready, renderer init, first render, slow frames after; per scene load) and the backend's (`buildTimings`, `closure.*`); perf harness `--plays N --gpu`, an asset-heavy class; before split in §6 |
| 25.24b, g | done 2026-09-28: Play and the export read only the start scenes' assets before the start (at most 8 at a time, each checked once), the rest when asked for (a later scene, a texture, a sound); the game bundle is read and hashed once per build, not per Play; the preview no longer re-serializes and hashes the scene; after split in §6 |
| 25.24d | done 2026-09-28: pipelines built ahead of a present (`compileAsync` into the pass the frame draws, before the first present and after each scene attach, both backends; `precompile` stage and counters in diagnostics); automatic batches drawn through instance-matrix columns so batches of one material share one node program (three r186 built one per instanced mesh: 573 on the large bench); the shadow probe is the first frame, not an extra render; large first frame 7.1 → 3.7–3.9 s; after split in §6 |
| 25.24c | done 2026-09-28: the bundle, worker and physics scripts at `/play-build/<digest>/`, a project's declared artifacts by digest under a stable per-project cache root (`immutable`, `ETag`, 304; the page still checks the bytes); blobs held once by digest; compiled behaviors cached by source, declaration, library and compiler digests; the closure's derivation of an unchanged capture reused, scene files hashed natively; large second Play 7.1 → 2.7 s (backend 1 s → 40–60 ms, bundle from the browser's caches); after split in §6 |
| 25.24d (instance sets) | done 2026-09-28: instance-set chunks drawn through the same columns (one program per mesh of the model, not per chunk; picked per copy as before); the editor's first frame on the large bench 1.6 → 0.4 s of programs, so its first Play answers after 1.3 s (was 2.5–5 s); large second Play 2.4–2.5 s |
| 25.24e | done 2026-09-28: scene loads prepared before the simulation gets them (file read, models parsed, instance buffers and textures decoded: `prepareScene`, the page's preloader); the next scenes read ahead (transition targets of the loaded scenes, the shell's next listed scene; at most 4); a transition's unloads leave in the step its scene arrives (never an empty world); optional `fade`/`fadeColor` on scene transitions, scene list entries and `ctx.scenes.load`; loading state in `ctx.scenes.loading()/transition()`, `$flow.scenes`, the observation; a large scene's entities copied over steps (4 ms a step); 2D/3D collider removal one pass (unload 54 → 17 ms); `scene-loads.e2e.ts` measures no empty frame (draw calls per frame, both renderers) |
| 25.24f | done 2026-09-28: the first present waits for the start scenes' models (whole first picture; its precompile covers them), the rest streams (instance buffers, textures of later use, clips, other scenes prepared when they load); the 15 s present timeout counts from the last progress (`play.preview.progress`, the editor forwards the preview's load progress at most once a second; the preview reports each stage and each model prepared) |
| 25.24h | resolved 2026-09-28, not done: boot is ~0.15 s of the large bench's 2.3–2.6 s first frame (≤ 7 %); the warm page would hold a hidden page, worker and physics world per editor; numbers in §6 |
| 25.24 | done 2026-09-28: (a)–(h) resolved; targets fixed in §6 (large ≤ 3 s from the second Play, no frame > 250 ms; a scene transition never draws an empty world) |
| 25.7a | done 2026-09-28: new entity ids `<kind>-N` with at least six digits (`box-000001`), N up to 1,048,576 (64 scenes × 16,384: no `id_exhaustion` below the entity limits), one allocator (`project-model/entity-ids.ts`) for create, paste, prefab copies and the v3 → v4 storage migration; `project.json` schemaVersion 4 (a 3 upgraded on open without a document change, written back; a 2 goes 2 → 3 → 4); four-digit ids load and stay (HTTP test on `fixtures/phase25/legacy-v3-ids`); limit in `docs/deployment.md` engine limits |
| 25.7b | done 2026-09-28: runtime content manifest version 4: materials (only the used ones), material functions, UI documents, dialogue and the instance buffer table are content files (`content/sha256/<digest>`, the block's canonical bytes) listed in `contentFiles` and bound by the buildId; Play and the export read each once, check it against its row and put it back under its key (`expandManifestContentFiles`); `manifest-keys.e2e.ts` plays and exports (backend stopped) a project with all four, the material graph e2e checks pixels in Play and the export on both renderers |
| 25.7c | done 2026-09-28: sound-effect records 16 → 64 (music's 64; the limits table), `deleteAsset {assetId}` and `deletePrefab {prefabId}` refused (`reference_in_use`, the uses listed by scene and path) while any typed reference in any scene or the content, or a script's string literal, names the record; the bytes stay, one undo restores it (`removeAsset` change; a prefab's undo is a `createPrefab` change); editor delete buttons (Assets, Prefabs) and MCP `tl_command` tested against the real backend (`delete-content.e2e.ts`), workspace test across scenes |
| 25.7e | done 2026-09-28: `createEntity` takes `active`, `locked`, `static`, `tags`; `createEntities {entities: [createEntity args + ref?], sceneId?}` up to 1024 entities in one revision and one undo (a `pasteEntities` change, undone by removing them), validated once; workspace test and the MCP e2e |
| 25.7d | done 2026-09-28: instance sets also chunked by extent: project setting `instance_chunk_m` (default 32 m), per-set `instances.chunkSize` (Inspector field); no chunk wider than it (≤ 256 chunks, cells grow past that), finer of the count and extent grids per axis; each chunk culled and LOD'd at its own centre, drawn through the shared instance-matrix columns (25.24d); Scene view, Play and export alike; `instances.e2e.ts` (the Inspector's chunk count follows the default, the per-set field and the setting), unit tests |
| 25.7 | done 2026-09-28: (a)–(e) hold |
| 25.8 | done 2026-09-28: lights belong to scenes: any kind in any scene (model and runtime; per scene one directional, ambient, hemisphere, 16 point/spot); the most recently loaded scene's directional, ambient and hemisphere light on (each kind on its own), the previous back on unload; point/spot of all loaded scenes share the budget of 16 (most recent scenes first); the key light's own shadow settings follow the switch; spot cookies (`light.cookie`, a texture; `SpotLight.map`) in the Scene view, Play and export on both backends, Inspector field; `renderer.lights` in Play diagnostics; `scene-lights.e2e.ts` (pixels: 12 point lights, sun colours on load/unload, cookie; Play and export, auto/webgl2/webgpu), `lights.e2e.ts` (Inspector cookie, Scene view pixels); D49 fixed |
| 25.9 | done 2026-09-28: each script library compiled once into its own minified, tree-shaken module (`libraries/<digest>.js`, manifest `libraries` rows under the buildId) that scripts import by digest instead of bundling (Play worker and page, export with the backend stopped; one module instance per realm, tested); records published before it still build (bundled digest re-derived, shared form shipped); staged library edits (`stageScriptLibrary` route/MCP op, files in pieces, `commitScriptLibraryStage`: one revision, one undo, each dependent compiled once; the Libraries panel's Save all, large saves staged); source maps for every compiled output, runtime errors and `ctx.log` record compiled frames, Play diagnostics map them to `{behaviorId|libraryId, path, line, column}`, the Console tab opens the line; `script-libraries-shared.e2e.ts`, `m25-libraries` integration, unit tests |
| 25.10 | done 2026-09-29: `ctx.entity(id).get(component)` (step-start snapshot of the descriptor-marked script-readable fields; the marks are pinned for schemaVersion 4) and `.set(component, patch)` (queued, applied at the end of the step in script order; refusals name the field; a field written twice: later wins, conflict in diagnostics); writable: object `active` (not drawn, no collision, triggers or ticking) and `visible`, transform (relaxed ownership: not physics bodies, the camera, static or system-driven objects), light colour/intensity/range, mover speed/`active` (new stored field), material parameters; `character_place` on the 2D plane (from rest); `ctx.shell.nextScene()`; typed prefab-local references in spawned copies; object pickers for script object properties; typings and visual-script nodes; `m25-entity-access` (2D/3D, page and worker, replay digests), `entity-access.e2e.ts` (Inspector, typings, pixels on both backends) |
| 25.11 | done 2026-09-29: callbacks on the behavior spec (`onEnable/onDisable/onDestroy`, `onTriggerEnter/Exit`, `onContact`, `onMessage`, `onUiEvent`, `onAnimatorEvent`; `step` optional), run in the intent phase before the script's step in a fixed order; lifecycle follows the object's switched-on state (25.10's `active`, spawns, scene loads/unloads, destroys; a restart sends onEnable again, no onDestroy); the event lists stay; typings with completion of the callbacks and their event fields; visual-script nodes On enable/disable/destroy, On contact, On UI event; `m25-callbacks` (2D/3D, page and worker, replay digests), `callbacks.e2e.ts` |
| 25.12 | done 2026-09-29: mover `stopOn`, `toggleOn`, `reverseOn` (with `startOn`, read in that order from last step's signals, through the same `active` flag scripts write; a reversed loop goes round the other way, a finished once-mover travels back) and a `gravity` easing (from rest at each point, constant acceleration, each stretch as long as at its speed; a reverse part-way keeps the position); Inspector fields; `mover-signals.test.ts` (unit, model, `m25-movement` 2D/3D page and worker, replay digests), `mover-signals.e2e.ts`; D50 fixed |
| 25.13 | done 2026-09-29: `climbVolume` component (a box turned with its object; Scene size handle, create menu) climbed in by both controllers (up/down along its +Y, sideways across, `climbSpeed`, no gravity; jump lets go with a jump, leaving lets go; optional `climbAction`), `wallSlide`/`wallSlideSpeed` and `wallJump`/`wallJumpAway`/`wallJumpUp` (off by default) in 2D and 3D; `gravity` component (non-character bodies fall under the project gravity onto colliders, saved); 2D edge patrols walk any direction of the plane; Inspector fields; `climb-walls.test.ts` (`m25-movement` 2D/3D page and worker, replay digests), unit and model tests, `climb-walls.e2e.ts` |
| 25.14 | done 2026-09-29: `cameraRegion` component (a world-axis box; dead zone, bounds from the region, distance along the camera offset, blended on enter and leave, priority then entered last; one or every track camera), track `lookAhead`/`lookAheadMax`/`lookAheadSmoothing` (per axis, vertical = `[0, t, 0]`); Scene handles: the dead zone around the target (handle `anchor`), a new `bounds` corner handle, the region's size; Inspector, create menu, observation `camera.region`; brain unit tests, `m25-movement/camera-regions.test.ts` (2D/3D page/worker/replay digests), handle tests, `camera-regions.e2e.ts` (editor, Play position and pixels) |
| 25.15 | done 2026-09-29: relay frames `{stepOffset, steps?, actions?, pointer?, gamepad?, ui?}`: run length (≤ 7,200 steps a call, no overlap; the backend waits by the span), gaps neutral (tool text); `ui` edges drive menus, pause and resume (frames of a paused game take steps' places); the pointer through the UI hit test (a click on a UI button clicks it, the game never sees that press; `pointer().overUi`, real mouse too); `ui.elements` rectangles in `tl_game_observe`; a virtual standard gamepad read through the bindings on the page; unit tests, `relay-input.e2e.ts` (MCP stdio → HTTP relay → editor, worker and single thread) |
| 25.16 | done 2026-09-29: `tl_game_observe` `run {stepIndex, runStep, digest, lastInput?}` — the run digest (steps from the run's start, a run's spawned copies by their number in it, loaded scenes instead of the set's revision) now and right after the last exercise's last step (a step observer in the simulation's realm); `tl_input_exercise {restart: true}` restarts the game and applies the frames from the new run's first step; `relay-input.e2e.ts`: the same frames after a restart give the same digest at the same run step, other frames another, and the worker and a single thread agree; unit tests |
| 25.17–25.22 | — |
| 25.23 | moved to phase 26 (26.13), owner 2026-09-29 |
| 25.25 | — |

## 6. Decision log

- 2026-09-28: the owner put every request in phase 25 and none in phase 24.
  Wider ids and the manifest split therefore don't ride on 24.8's schema
  bump. They get their own schema bump in 25.7.
- 2026-09-28: when scenes are loaded on top of each other, the most recently
  loaded scene's directional light wins (owner). Ambient and hemisphere
  lights follow the same rule so that a scene's lighting is one unit.
- 2026-09-28: the scripting model is taken without dropping ownership
  (owner). The reason is that physics bodies and the camera belong to their
  systems, and writing them directly bypasses collision. Relaxed ownership
  covers the common case (a director moving units).
- 2026-09-28: Sprout's platformer bot stays in Sprout (principle 1b). The
  engine runner only runs input and scripts and returns observations.
- 2026-09-28: the owner added the project window (25.23). Folders cover
  every resource kind, not only imported files, as Unity's Project window
  does. They are organization data only and stay out of the manifest and
  the buildId.
- 2026-09-28: the owner added Play-start and scene-load speed (25.24), after
  seeing 10–20 s starts on larger scenes. The code trace found no stage
  timings, so 25.24a measures first and the fixes follow the measured split.
  25.24 may run right after the bug items, since every other item's testing
  pays for slow Play starts.
- 2026-09-28 (step 0): the plan was reconciled with phase 24 (`9ca1c1d`),
  docs only. File paths and line numbers re-located (manifest key users,
  screenshot handler, environment re-bake, light rule in `project-v4.ts`
  and `runtime.ts` `addBatch`, id padding in the three ops files). 25.1
  narrowed: 24.8 already made `MANIFEST_KEYS_V2` the one list; the
  every-key test remains. 25.16 narrowed to the per-step digest: `replay`
  is the scene-mode restart (24.6) and `start` went with the session. 25.7
  names its bump: schemaVersion 3 → 4 and manifest version 3 → 4. 25.10's
  2D `player_place` became `character_place` on the 2D plane, and
  `ctx.shell` is marked new. 25.13 and 25.4 point at `packages/character`;
  25.14 builds on the 24.4g `track` rig; 25.15 on input frame version 2.
  §2 wording is past tense for what 24.7 deleted (flow, HUD presets, level
  start). The progress table now covers 25.23 and 25.24.
- 2026-09-28 (25.1): the every-key check is split by what each layer can
  hold. The unit test gives the pure builder all 23 optional keys at once
  and fails when a key is added to `MANIFEST_KEYS_V2` without it. The e2e
  test builds a real project with the keys that travel together (modes,
  timelines, eventCues, shell, dialogue, and also saveSchema, tags,
  collisionLayers, input and uiDocuments) and plays and exports it. Keys
  that need imported models or bakes (rigs, lighting, buffers) stay in the
  unit test. The test found D45 (document key order), which is fixed.
- 2026-09-28 (25.6): `input.cursor` is keyed by any map the project has.
  During play without modes the gameplay map's setting applies, as before.
  With a mode (or a focused document) the first active map that sets one
  wins, and ui counts last. So a mode that doesn't activate gameplay no
  longer inherits gameplay's lock. Removing a map in the Input window drops
  its setting.
- 2026-09-28 (25.6): the import scan stays textual, as specified. A small
  lexer (comments, strings and template text, regex literals) only labels
  where a hit sits. The diagnostic carries line and column, so the script
  editor marks the line. A declaration is judged at its `from`, so
  `x; // … from 'y'` reads as a comment hit. The regex-vs-division call is
  a heuristic, and a wrong call only changes the note, never the verdict.
- 2026-09-28 (25.6): createEntity's refusal of a component that only
  setComponent adds keeps the code `component_unknown`, because clients key
  on codes, and changes only the message. `box`/`model` point at the kind
  argument. glTF `extras` were refused only by the material and PBR field
  allowlists; both now accept them. The check is a unit test at the
  inspector that the import route calls, covering every object kind.
- 2026-09-28 (25.2): the WebGPU capture path is "render and read back in
  the same task", the plan's first option. It is the path the adapter
  already took for both backends: the canvas copy (and the downscale's
  `drawImage`) run in the task that drew the frame, while the WebGPU
  canvas' current texture is still the drawing buffer. `screenshot.e2e.ts`
  checks the relay's PNG in pixels on WebGPU (on the GPU and on headless
  Dawn/SwiftShader), with a GLB whose base colour is an embedded PNG; the
  texture shows, so image textures upload in headless WebGPU. A render
  target readback was not added: it would need the post stack to draw into
  a second target, for no case that fails today. The capture failures that
  did lose the answer are fixed instead: a throw outside the adapter's PNG
  step, an error message over the bridge's 256 characters, and a PNG over
  the backend's 1 MiB (the preview now captures again at a smaller width,
  down to 256 pixels, and reports the width it has). The backend keeps the
  `relay_failed` code with the preview's code as `cause` (clients key on
  them) and puts the preview's reason in the message.
- 2026-09-28 (25.3): measured first. On the GPU host the 23.18 code already
  dropped no steps with a new `t` every step in a small scene (frame gaps
  17 ms, 0 dropped, both renderers); what it did wrong was re-bake every
  30th frame even when the sky did not change (12 re-bakes in 6 s of a
  fog/exposure/lights-only blend). The fix keeps the re-bake cap and adds a
  threshold against the last bake's inputs (`SKY_REBAKE_THRESHOLD`: sRGB
  channel 0.01, procedural numbers 1 %, sun 0.5°, the most generic
  "invisible in blurred lighting" bound), and re-bakes into the same render
  target from a kept bake scene. The old path gave the scene a new
  environment texture per bake, which makes three's node manager build a
  new environment node and rebuild every lit material's node state; the new
  one allocates and compiles nothing per bake. That saving was not
  separately measurable here (frame gaps were already at vsync); a large
  scene's gain is unmeasured. Cross-fades between different sky structures
  are unchanged (their bakes happen once per layer).
- 2026-09-28 (25.4): internal edges are handled in the 2D port, not by
  merging colliders. Rapier grounds on any contact whose normal tilts up; a
  contact is internal when its point on collider A is inside another fixed
  collider B, or on B's boundary with a normal outside B's normal cone there
  (for convex B: the point pushed out along the normal projects back onto B
  elsewhere). Rapier's ground flag is refused only when an internal contact
  is found and no real one, at the sweep's end (or its start, where Rapier
  also snaps; an airborne sweep starting on internal-only ground is made
  without the snap). A level without shared faces moves exactly as before,
  and every replay fixture is unchanged. Merging colliders into one outline
  was not done: it needs a polygon union, and the port rule covers every
  measured case.
  Left as is: a landing right on a seam, or a head bump under a tiled
  ceiling, can differ from the one-collider path by a few millimetres (the
  sweep's corner contact; measured ≤ 5 mm per landing, ≤ 2 cm over 4 s of
  repeated head bumps); nothing stops or catches.
- 2026-09-28 (25.4): the Play test found D46 (a falling player creeps down
  any fixed wall on its left, stacked or not). Fixed in the same item since
  it is the same symptom (held at a wall); the retry sweep is limited to
  fixed colliders, so a rising mover's side keeps its phase 14.7 behavior
  and the recorded non-default replay (a player beside a rising lift) is
  bit-for-bit unchanged. Checking §2's note found D47 (a polygon mover
  moving into the player fail-stopped); the runtime push now clips the
  polygon to the player's box, and a box keeps its old rule exactly.
- 2026-09-28 (25.5): TL-17 did not reproduce. Scripts saw every `ended`
  (finished, stopped, skipped; `ended(h)`, `events()`, `state(h)`) once, in
  the step after it, for plays started by a script, on start, on a signal
  and with a mode track handing a behavior group back, in the intent and
  transform phases, on the main thread and in the sim worker, with no
  physics, 2D and 3D (`tests/integration/m25-timeline-ended`), and in real
  Play in the worker (`tests/e2e/play-end.e2e.ts`). The timeline code has not
  changed since 23.17, so the report most likely came from the flow path
  24.7 deleted; the Sprout repo is not read to confirm. The tests stay as
  guards. Note for testers: an observation shows only the last step's
  timeline events, so polling `tl_game_observe` rarely catches `ended`; a
  script counter does.
- 2026-09-28 (25.5): the play-end reason keeps the `play_not_found` code (a
  closed set clients already handle) and adds `ended {reason, presented, at,
  detail?}` plus the reason in the message, so no client breaks. No new
  stop reason: `session_lost` carries a detail when the owner's browser
  evicts the headless editor. Not done: a socket replaced by a re-attach
  still leaves its play running (the backend can't tell a page reload from
  the same page reconnecting); it ends by the present timeout or the TTL.
- 2026-09-28 (25.24a): the start is measured, not guessed. The preview
  records stages from its page's time origin (`diagnostics.startTimings`:
  stages that may overlap, the first frame, the frames in the 10 s after it,
  and each scene loaded during play: request, read, the frame that attached
  it, the frames after); the backend records its part of the start
  (`buildTimings`, also in the play-start response as `timings`). The
  renderer reports each drawn frame through an optional adapter hook
  (`onFrameDrawn`), which also splits the wait for the first frame into
  `rendererInit` (the first render call until the renderer is ready) and
  `firstRender` (the first drawn frame's own call). The perf harness runs
  Plays in the same editor page (`--plays N`; the second and later are the
  "warm" case of the acceptance), draws on the host's GPU with `--gpu`, and
  has an asset-heavy class (48 distinct model files of ~0.5 MB, each with
  its own texture, and 24 textures of ~1 MB on 24 materials; four scenes,
  one starts). **Before split** (GPU host, Iris Xe, renderer `auto` =
  WebGPU, simulation worker; ms from the click on Play, Plays 2–3; Play 1
  in brackets where it differs; `tools/perf/run.mjs --classes
  small,large,asset-heavy --surfaces play --renderers auto --gpu --plays 3`):

  | Stage | small | large (16 000 entities, 10 scenes) | asset-heavy |
  |---|---|---|---|
  | Play-start response (backend total) | 105–111 (36–47) | 1 110–1 170 (980–1 060) | 185–200 (118–134) |
  | backend: closure view / scenes / manifest / assets / behaviors | 8–13 / 3–4 / 3 / 0 / 12 | 273–278 / 333–366 / 340–379 / 0 / 12–14 | 29–36 / 25–28 / 9–10 / 33–34 / 11–14 |
  | click → preview page starts | 104–112 | 1 155–1 203 | 185–203 |
  | bundle fetch + eval (8.8 MB `game.js`, per-Play URL) | 48–55 + 57–61 | 50–76 + 56–64 | 51 + 56–58 |
  | manifest read + verify | 3–4 | 5–9 | 4–8 |
  | scene re-serialize + hash (`sceneCheck`, 25.24g) | 0 | 66–67 | 1 |
  | start scene files | 3–4 | 91–94 | 3–8 |
  | worker start (overlaps the reads) | 105–115 | 455–474 | 126–141 |
  | asset reads (every asset, one at a time) | 3–4 (1 file) | 6–7 (1 file) | 267–295 [408] (73 files, 35 MB) |
  | host mount | 8–9 | 152–200 | 15 |
  | models settle | 7 | 262–329 | 38–46 |
  | ready | 373–376 | 2 480–2 485 | 664–693 [1 211] |
  | renderer init (first render call → ready) | 23–25 | 31–38 | 32–33 |
  | first drawn frame's own call | 123–127 | **4 464–4 546** | 304–327 |
  | first frame | 551–552 | **7 123–7 221** | 1 035–1 044 [1 535] |
  | frames > 50 ms in the 10 s after (worst) | 0 | 91–102 of 102–111 (366–385) | 1 (56–60) |
  | scene load (scene 2 of 4, 294 entities): read / attach frame / slow after | — | — | 8 / 63 / 0 |

  What it says for the next steps: the large project's first frame waits
  4.5 s on its own first render call (pipeline and first-draw work), which
  is 63 % of its 7.2 s; that is 25.24d's target (and f's). The backend's
  closure is the next second (view, scenes and manifest serialization and
  hashing each ~0.3 s), 25.24c's target; the worker start (0.45 s) overlaps
  the reads. Asset reads matter only where there are many assets (asset
  heavy: 0.27–0.4 s of ~1.04 s, all 73 files though only a quarter belong to
  the start scene), which is 25.24b's target. The bundle costs ~0.1 s per
  Play on this host (localhost; more over a LAN), 25.24c/g. The large
  class's frames after the first are its steady frame time on this GPU
  (~50 ms at 583 draws), not a start effect; the start's own stall shows as
  the one 370–385 ms frame. A scene loaded later is cheap here (its assets
  were already read at start).
- 2026-09-28 (25.24b, g): the start set is found by scanning, not by a
  per-component list: every declared asset id the start scenes' objects
  name, followed through the materials they use (and a model's own
  material map), material functions and effects, plus the environment and
  the start scenes' bakes. A missed name costs only latency (that asset is
  read when it is asked for); an extra one costs a read. Sounds are left to
  the host, which reads them through the same reader when it plays them.
  Reads go through one reader per play (`createVerifiedAssetReader` in
  game-host, shared by Play and the export): each asset at most once, at
  most 8 in flight, length and digest checked before any caller gets the
  bytes. Consequence: a bad asset of a scene that does not start no longer
  refuses the start; it fails when its scene loads (the model realization's
  `models_*` error, a texture that stays empty), with the asset named. The
  scene check the preview did (pretty-print and hash the whole bridged
  scene) is replaced by checking that the snapshot names the manifest's
  capture (snapshotId, project, revision): the backend builds both from one
  capture and already checks the scene bytes against `sceneDigest`. The
  bundle is kept while `dist/`'s file keeps its size and modification time,
  so a rebuild is picked up on the next Play without a restart.
  **After split** (same run as the before split; Plays 2–3):

  | Stage | small | large | asset-heavy |
  |---|---|---|---|
  | backend `bundle` | 0 (was 5–8) | 0 (was 2–4) | 0 (was 3–5) |
  | scene re-serialize + hash | gone (was 0) | gone (was 66–67) | gone (was 1) |
  | asset reads before the start | 3–4 (1 file) | 3 (1 file) | **41–50 [58]** (19 of 73 files, 9 of 35 MB; was 267–295 [408]) |
  | ready | 360–368 | 2 361–2 523 | **509–550 [943]** (was 664–693 [1 211]) |
  | first frame | 548–552 | 7 000–7 244 | **838–886 [1 284]** (was 1 035–1 044 [1 535]) |
  | scene load (scene 2 of 4): read / attach frame / slow after | — | — | 8 / 57 / 0 (its model files and textures are now read after the attach; the time until they show is 25.24e's to measure) |

  On asset-heavy the worker start (~130 ms) is now the longest step before
  the mount; on large nothing before the first render call moved the total,
  whose 4.5 s first render stays the largest share (25.24d). The large
  class's first Play in a fresh editor page answered its start request after
  1.1–5.2 s across runs while the backend's own part stayed ~1 s: the rest is
  spent before the request reaches the route (the editor and backend just
  opened a 16 000-entity project); not investigated here.
- 2026-09-28 (25.24d): the large bench's 4.5 s first render call was not
  GPU pipelines but three's node building in JavaScript: 573 node builds for
  583 draws (counted with call coverage), because three r186 keys the node
  program of every `InstancedMesh` by its object id (its matrices are bound
  into the program; a TODO upstream), and the automatic batches were
  instanced meshes (50 materials × kit pieces × LOD levels × cells). So a
  precompile alone would only have moved those 4.5 s. Two changes:
  - **Batches share node programs.** A batch is now a plain mesh whose own
    `InstancedBufferGeometry` shares the source geometry's attributes and
    index and adds the instance matrices as four `vec4` columns of one
    interleaved instanced buffer (`attribute-instancing.ts`). Every node
    material, the renderer's shadow-pass material included, applies the
    columns when the geometry it draws carries them — a hook on
    `NodeMaterial.prototype.setupPosition`, idempotent, active only for
    that geometry, applied where three applies an `InstancedMesh`'s
    matrices (before `positionNode`; batches take no morphed, skinned or
    displaced mesh). The render object's key then holds no object id:
    batches of one material and vertex layout share one program (573 → 79
    builds on the large bench). A batch starts at 16 slots (the 1 025 floor
    was there to force three's attribute path) and grows by doubling; its
    geometry and instance buffer are disposed with it, never the shared
    attributes. `instanceOrigin` (kit/graph world UVs) reads the columns.
    Instance sets (`instances` component) keep their chunked instanced
    meshes (their chunks are culled and LOD-switched per chunk; a later
    item may move them over).
  - **Precompile.** The adapter holds a present that would build programs:
    before the first present and after a frame that attached a scene (and
    after a new renderer), it calls `compileAsync` for the scene as the
    frame will draw it — into the post stack's scene pass (its target and
    outputs, set only around compileAsync's synchronous collect: three's
    `PassNode.compileAsync` leaves them set across its awaits, which a
    capture drawn meanwhile would inherit) or the canvas — and skips frames
    until it settles (at most 20 s, then the frame builds what is left). A
    skipped frame does none of the frame's work: measured on the large
    bench, a precompile competing with the per-frame transform sync of
    16 000 objects took 2.4 s instead of 0.65 s. A capture (screenshot,
    save thumbnail) draws regardless. Shadows go on before the precompile,
    and the §41.1.4 shadow probe is now the first real frame (a throw turns
    shadows off and draws it again) instead of an extra full render in it.
    Diagnostics: `renderer.precompile {runs, failed, gaveUp, lastMs,
    running}`, `renderer.batching.programs`, the `precompile` start stage
    and a scene load's `precompileMs`. On small scenes compileAsync's
    per-object yields cost ~30–60 ms over a synchronous first render;
    accepted for no multi-second task and pipelines built in parallel.
  - **The slow first start response** (large bench, first Play in a fresh
    editor page: 1.1–5.2 s while the backend's part was ~1 s) had the same
    cause: the editor's Scene view draws the same automatic batches and
    built a node program per batch right after the project opened, holding
    its main thread for seconds, and the click on Play waited for it. With
    shared programs the first response is 1.2 s (backend 1.1 s).
  **After split** (same command as §6's before split, GPU host, Plays 2–3,
  Play 1 in brackets; `--classes small,large,asset-heavy --surfaces play
  --renderers auto --gpu --plays 3`):

  | Stage | small | large | asset-heavy |
  |---|---|---|---|
  | Play-start response | 93–96 [134] | 1 203–1 236 [1 204] (was 1 110–1 170 [4 941]) | 179–210 [427] |
  | precompile | 114–120 [152] | 632–644 [660] | 194–232 [331] |
  | first drawn frame's own call | 33–36 (was 123–127) | 386–403 (was 4 464–4 546) | 38–41 (was 304–327) |
  | first frame | 580–595 [659] (was 548–552) | **3 718–3 930 [3 745]** (was 7 000–7 244) | 778–902 [1 261] (was 838–886 [1 284]) |
  | frames > 50 ms in the 10 s after (worst) | 0 | 10–21 of 214–232 (59–95 [135]; was 91–102 of 102–111, 366–385) | 0 |
  | scene load (scene 2 of 4): attach frame | — | — | 59 (was 57) |

  The large class now waits ~1.2 s for the backend (25.24c's), ~0.5 s for
  the simulation worker, ~0.3 s for the models and ~1 s for the precompile
  and first draw.
- 2026-09-28 (25.24c): caching across Plays, measured first (backend CPU
  profile of the large bench's start): of the closure's ~1 s, 0.62 s was
  project-model's portable (pure JavaScript) SHA-256 over the scene files,
  0.24 s validating the 16 000 entities twice (content view, media
  identity), ~0.1 s pretty-printing them; compiling was 12 ms. So:
  - **Scripts at stable URLs.** The game bundle, the simulation worker and
    the 3D physics script are one "play build" (read and hashed once while
    the files are unchanged; the build before it stays servable for a page
    that started before a rebuild), served at `/play-build/<digest>/<name>`
    (the digest of the three files' digests). The play page loads the
    bundle and the worker from there (the worker finds the physics script
    next to itself).
  - **Declared artifacts by digest under a stable root.** Each project gets
    a cache root `/play-content/<cacheId>/`, the cacheId a keyed hash of the
    project id with a per-process secret (the contentId's shape: the same
    for every Play of the project while the backend runs, unguessable, new
    after a restart). Under it only the digest routes answer
    (`content/sha256/<digest>`, `behaviors/<digest>.js`, a scene file by its
    digest), and only while a live (or grace) Play of that project declares
    the digest; the manifest and anything else stay on the Play's own root.
    The page reads assets, scene files, instance buffers and compiled
    scripts from there, and still checks every asset, scene file and buffer
    against the manifest before use (compiled scripts are imported by URL,
    as before; the URL is their digest and the backend serves only bytes it
    hashed to it). Every locator and build response is `private,
    max-age=31536000, immutable` (per-Play ones keep their remaining-TTL
    max-age) with the digest as `ETag`, and answers a matching
    `If-None-Match` with 304. Consequence: the browser's HTTP and code
    caches hit from the second Play on (large: bundle 0 ms over the wire,
    evaluation 11–14 ms instead of 56–64).
  - **Blobs by digest.** The play-content store holds each artifact's bytes
    once by digest with the sets that declare it; a new Play of unchanged
    content shares them (the closure still reads and checks each asset
    through the workspace; `counters().blobs`).
  - **Compiled behaviors** are kept by the compiler instance (successful
    compiles, 256 least recently used) keyed by the digest of the source
    container, the declaration, each library's digest, the forbidden-string
    list and the compiler's recipe (compiler and esbuild pins, pinned
    modules, limits); a custom `build` is never cached.
  - **The closure's derivation of a capture** (content view, media
    identity, scene files and digests, instance buffers, the merged start
    scene and its digest) is kept for the next build of the same capture:
    keyed by the captured content object and compared by identity over the
    captured scenes' fields and the merged scene's entities, with the
    revision and start scenes. Only frozen inputs are remembered (the
    workspace's captured reads are deep-frozen), so a remembered input
    cannot have changed; an edit is a new capture and derives everything
    again (tested). The backend passes Node's native SHA-256 for the scene
    files (the same digests).
  - The play-started message no longer serializes an over-bound snapshot
    into a message before sending it by reference.
  Not done: the preview origin's other static files (the Draco/KTX2
  decoders) still carry no cache headers; the export path still hashes
  scene files with the portable SHA-256 (not part of a Play start).
  **After split** (same command; Plays 2–3, Play 1 in brackets):

  | Stage | small | large | asset-heavy |
  |---|---|---|---|
  | Play-start response (backend total) | 73–75 (3–10) [113] | 133–178 (37–61) [2 526 (485)] | 109–110 (42–43) [471] |
  | backend closure view / scenes / manifest | 0–1 / 0 / 1–5 | 10–15 / 0 / 6–29 [325 / 54 / 69] | 2 / 0 / 3 |
  | bundle fetch + eval | 0 + 12 (was 47–49 + 56–58) | 0 + 11–14 (was 49–70 + 59–79) | 0 + 12–13 |
  | first frame | **467–468** [628] (was 580–595 after d) | **2 662–2 692** [5 458] (was 3 718–3 930) | **562–622** [1 299] (was 778–902) |
  | frames > 50 ms in the 10 s after (worst) | 0 | 23–55 of 209–222 (61–71; 0 > 250 ms) | 0 |

  The acceptance's large case (under 3 s from the second Play on) is met;
  its steady frame time on this GPU is ~48 ms at 583 draws, so the frames
  over 50 ms after the first are not a start effect. Play 1 of the run
  above answered its start after 2.5 s (backend 0.5 s): the editor's Scene
  view was still building its first frame's programs for the instance sets
  (chunked instanced meshes, one program each) — see the next entry.
- 2026-09-28 (25.24d, instance sets): the editor page's own first frame
  after it opened the large bench still built a program per chunk of each
  instance set (chunked `InstancedMesh`es: 1.4 s of node builds in a 1.6 s
  render, profiled), and a click on Play waited for it. Instance-set chunks
  now draw through the same instance-matrix columns: their geometry shares
  the model mesh's attributes, each copy is placed once and offset per mesh
  of the model, and a chunk mesh answers a ray per copy like an instanced
  mesh (`instanceId` = its slot; `copyOf`, `copyBox`, the editor's copy
  picking and gizmo unchanged). Diagnostics: `renderer.instanced {meshes,
  programs}` for every mesh drawn through columns. Measured (same command;
  Plays 2–3, Play 1 in brackets):

  | Stage | small | large | asset-heavy |
  |---|---|---|---|
  | Play-start response | 73–75 [116] | 202–250 [1 294] (Play 1 was 2 526; backend 536) | 111–112 [536] |
  | precompile | 108–124 | 386–393 [435] (was 657–666) | 231–237 |
  | first frame | 454–470 [763] | **2 414–2 546** [4 252] | 677–680 [1 363] |
  | frames > 50 ms in the 10 s after (worst) | 0 | 18–25 of 219–228 (62–67; 0 > 250 ms) | 0 |

  Overall for the large bench from 25.24a's before split: first frame from
  the second Play on 7.1–7.2 s → 2.4–2.5 s, no frame over 250 ms after it
  (was one of ~370 ms). What is left before its first frame: the
  simulation worker composing 16 000 entities (~0.5 s), the model
  realization (~0.3 s), the precompile and the first draw with its shadow
  map (~0.8 s).

- 2026-09-28 (25.24e): a scene transition never shows an empty world. Before,
  a transition queued its unloads for the next step and its load for when
  the file was read; the frames between drew the world without either scene,
  and the new scene's models and textures were read and parsed on the frames
  after it attached. Now:
  - **The swap is one step.** A transition (a trigger's, a scene list move,
    or `ctx.scenes.load(id, {unload})`) keeps the scenes it unloads until its
    scene is in, then removes them in the step boundary that adds it (one
    scene set revision). A scene that cannot be read cancels the transition
    and keeps the world (logged); a transition to a scene already in unloads
    at once. `ctx.scenes.unload` alone is unchanged.
  - **Prepared before it attaches.** The page's scene loader (`createScene-
    Preloader`, game-host, Play and the export) reads the file, then has the
    render side prepare the scene — its declared assets read and checked (the
    start scenes' scan, `startSceneAssets`, per scene), models parsed and kept
    (`ModelsRealization.hold`), instance buffers and textures decoded
    (`SceneAdapter.prepareScene`) — and only then answers the simulation. The
    adapter lets go of the hold once it realized the scene (its entities hold
    the assets then). The frame that attaches it is held for its precompile
    (25.24d), so the old picture stays until the whole new one is drawn. A
    preparation that takes over 30 s lets the scene go anyway (its assets then
    stream in).
  - **Read ahead:** the targets of the scene transitions in the loaded
    scenes (and spawned copies) and the shell's next listed scene, at most 4,
    unloaded ones only, re-named whenever the scene set changes; one no longer
    named is let go. Every entry of the scene list was the plan's wording;
    the next one is taken (the most generic sound choice: a 32-scene list
    read ahead whole would hold every model of the game). A jump to another
    entry still shows no empty world, only a longer wait (with the fade).
  - **Loading state:** `ctx.scenes.loading()`, `ctx.scenes.transition()`
    (`{scene, phase: out|loading, fade, seconds, color, unload}`), the
    runtime's `sceneLoadingView` (mirrored from the worker), `$flow.scenes`
    `{loading, scenes, transition}` for UI documents, `scenes.transition` /
    `preloading` / `preloaded` in the observation.
  - **Fade** (optional, 0–5 s, `fadeColor`): on `trigger.sceneTransition`,
    shell scene list entries and `ctx.scenes.load`. The fade-out runs in
    steps (the swap waits for it and for the scene), the fade-in on the page
    once a presented frame drew the swap (`presentedSceneRevision`), both on
    the host's fade overlay (the timeline fade's; the stronger wins). A
    paused game finishes a fade-out at once (no steps).
  - **Spread over steps:** measured in the headless simulation (perf `sim`
    surface, large class, its last scene of 1 714 entities loaded later):
    the attach step was ~40–90 ms on a loaded host, of which copying and
    freezing the entities was 13–38 ms and the 2D port's collider removal on
    unload 28 ms (it scanned every collider record per removed entity). The
    copy now runs 4 ms per step boundary before the attach; the rest (adding
    colliders, attaching, behaviors instantiated: ~11–18 ms) stays one step,
    since a half-attached scene would be a partial world. Collider removal is
    one pass in both ports (unload step 54–60 → 17–19 ms). In a worker these
    run off the page, which keeps drawing.
  - **Measured in a real browser** (`scene-loads.e2e.ts`, GPU host, auto =
    WebGPU and the forced WebGL 2 variant): the start scene alone draws 21
    calls, scene A 23; a door in A sends the character to B (a textured wall
    and a model file) with a 0.4 s fade. Every frame from B's request to 10 s
    after it attached drew at least 23 calls (no empty frame); B was
    prepared 27 ms after its request and attached after the fade-out (~0.45 s)
    in a 58–85 ms frame drawing its final 25 calls; no frame over 250 ms; the
    fade overlay went 0 → 1 → 0.
- 2026-09-28 (25.24f): progressive presentation, measured first. After (b)
  only the start scenes' files are read before the mount, and that read
  overlaps the worker start (asset-heavy: assets end at 190–223 ms, the worker
  at 261–306 ms), so reading less of it would not move the first frame. What
  the first picture still lacked was a guarantee: the first present could
  come before the start scenes' models had settled (a large model file on a
  small scene), then the models popped in and built their programs on their
  first draw. So "blocking" is taken as the start scenes' models (the world's
  geometry, the settle gate that already decides `tl.ready`): the adapter
  holds the first present until they settle (at most 20 s, like the
  precompile), so the first picture is whole and its precompile covers them.
  The rest streams: instance-set buffers, textures a material asks for later,
  animation clips, sounds, and other scenes (prepared when they load, 25.24e).
  The first frame did not move (it already came after the settle on the
  benches). The present timeout (15 s) now counts from the last progress: the
  preview reports each stage (manifest, worker, assets by bytes, mount, each
  model prepared) as `tl.load.progress`; the editor passes it on as the WS
  event `play.preview.progress` at most once a second until `ready`; the
  backend re-arms the timer on it (a play that hangs still ends 15 s after
  its last progress). Tested: backend unit (progress every 0.5 s keeps a 1 s
  timeout from firing, silence then ends it), `scene-loads.e2e.ts` (the
  editor's WS frames: progress first, nothing after ready; the first frame
  draws the start scene with its models).
- 2026-09-28 (25.24h): not done, by the measured split. After (b)–(g), the
  large bench's first frame from the second Play on is 2.31–2.58 s (GPU host,
  auto = WebGPU, worker; `--classes small,large,asset-heavy --surfaces play
  --renderers auto --gpu --plays 3`), of which boot — what a warm page would
  have done already — is the bundle's evaluation (12–15 ms, from the code
  cache) and the worker's own start (script and Rapier WASM, ~110 ms: the
  small class's whole worker stage) — about 0.13–0.15 s, ≤ 7 %. The rest is
  the content: the backend (0.19–0.25 s), the snapshot and start scene files
  (~0.15 s), the worker composing 16 000 entities (~0.4 s beyond its boot),
  the host mount (0.13–0.17 s), the models (0.3 s), the renderer init,
  precompile and first draw (~0.9 s). A warm page would keep a hidden page, a
  worker and a physics world alive per editor for that ~0.15 s. Small: first
  frame 0.42–0.49 s (boot ~0.13 s of it, already under half a second);
  asset-heavy 0.59–0.66 s.
  **Targets (fixed from these numbers, 25.24's acceptance):** on the GPU
  host, from the second Play on, the large bench's first frame ≤ 3 s (2.31–
  2.58 s; was 7.1–7.2 s before 25.24), small ≤ 0.6 s (0.42–0.49; was 0.55),
  asset-heavy ≤ 1 s (0.59–0.66; was 1.04); no frame over 250 ms in the 10 s
  after the first (large worst 85 ms; was 366–385); a scene transition draws
  no frame with less than the world it leaves or the one it arrives in
  (`scene-loads.e2e.ts`), and a scene loaded during play attaches prepared
  (asset-heavy scene 2 of 4, 294 entities, 12 model files and their
  textures: prepared 95 ms after the request, attached at 160 ms in a 70 ms
  frame, no frame over 50 ms after; before 25.24e it attached at 64 ms and
  its models and textures were read after, their arrival unmeasured). The
  large Play 1 in a fresh editor page is 3.8 s (backend 0.5 s cold).
- 2026-09-28 (25.7a): the plan's format bump was checked. The id width
  alone needs no document change (an id is any string of the id syntax, so
  a four-digit id loads as it is and a six-digit one would load in a phase 24
  build too); the bump is kept as the plan names it, as the marker of the
  25.7 format (and for 25.7b's manifest and 25.7c–e's fields): the loader
  upgrades a schemaVersion 3 project to 4 without touching a document
  (`upgradeProjectDocsV25`) and writes it back as one new revision, as 24.8
  does; a 2 goes through `upgradeProjectDocsV24` and then this. The id
  limit is the project's entity capacity (64 × 16,384 = 1,048,576), not a
  round 999,999: numbers past 999,999 simply get seven digits, so no kind
  can run out before the entity limits refuse the creation. Old ids are not
  renamed (a rename would touch every reference in scenes, prefabs, scripts'
  properties and saves). New ids start at N = 1 in the wider space, so a
  project with `box-0001` gets `box-000001` next (a different string). The
  fixed ids of a new project's default objects (`cam-main`, `light-0001`,
  `light-0002`) and of the Starter template are data, not assigned, and stay.
  Recorded fixtures re-derived because created ids changed (no behaviour
  changed; each replay still passes byte for byte): the commands/workspace
  corpus by its generator (`fixtures/commands/tools/generate-fixtures.mjs`:
  manifest schemaVersion 4, six-digit allocator; the 08 recovery snapshot's
  file name carries a hash of the new bytes), the packet-16/22 prefab
  fixtures and the model-authoring messages by a fixed rename of the created
  ids (model-0003 → model-000001, box-0002 → box-000001, group-0002 →
  group-000001, …), verified by their replays.
- 2026-09-28 (25.7c): the audio cap is a count, 64, not a byte budget. The
  limits table already bounds each sound by its own PCM byte cap and lists
  music at 64 records, so 64 sound effects is the consistent row (the game
  host's registered-sound store follows it). A byte budget would add a second
  kind of limit next to the per-file caps for no case that needs it.
- 2026-09-28 (25.7c): "refused while anything references it" is decided by
  the model's own reference rules, not a second list: the record is taken out
  and the resulting project validated (the carrier scene and content in the
  command layer, every other scene in the workspace's cross-scene check);
  whatever no longer resolves is a use, reported as `reference_in_use` with
  the model errors as `details`. So a new kind of reference is covered as
  soon as the model checks it. Code is the one place the model cannot see: a
  script (a published behavior's source container, a visual script's
  generated source, a library file) that holds the id as a quoted literal
  also refuses the delete (a textual check, so a mention in a comment inside
  quotes counts too; the safe side). A placed prefab copy keeps its link, so
  a prefab with copies cannot be deleted until they are. The record's bytes
  are not removed (unreferenced blobs are kept, workspace §13.7), which is
  what makes the undo exact. New change `removeAsset {assetId, previous}`;
  `deletePrefab` reuses `removePrefab` (the undo of a capture) and its undo
  is a `createPrefab` change (new inverse `restorePrefab`).
- 2026-09-28 (25.7e): `createEntities` records a `pasteEntities` change
  (the created entities, parents first) undone by `removeEntities`, so the
  editor, the history and the stored records needed no new change type. The
  batch is checked item by item like `createEntity` (errors at
  `/args/entities/<i>/…`), ids come from one allocator pass, and the result
  scene is validated once (a per-item gate would validate the scene N
  times). 1024 entities per batch; the 64 KiB request cap usually bounds it
  first. `ref` is batch-local and never stored.
- 2026-09-28 (25.7d): extent chunking is added to the count chunking, not
  put in its place: per axis the finer of the two grids is used, so a dense
  small set still splits by count and a sparse wide one by extent. Default
  32 m (three-adapter `INSTANCE_CHUNK_METERS`, the setting's default): a few
  seconds' walk for the default character and a LOD error of at most the
  half diagonal (~23 m), genre-neutral. The cap rises from 64 to 256 chunks
  for extent chunking (only chunks in view draw); past it the cells grow
  rather than the set being refused. Only cells holding copies become chunks.
  The chunk size is rendering data: it does not enter the simulation, so
  replays and the determinism pins are unchanged; the setting is optional
  (stored only when set) and the component field kept only when set, so
  existing documents and buildIds stay byte-identical. It is not
  `runtimeWritable` (sets are built once when their scene loads).
- 2026-09-28 (25.7b): the manifest split. The five blocks are written as
  their canonical bytes (`JSON.stringify(block, null, 2) + "\n"`, so a
  file's digest is the block digest) at `content/sha256/<digest>`, the path
  assets and buffers already use: Play serves them from the play's cache
  root and the export writes them into its tree with no new route or
  layout. The manifest lists them in a fixed key order (`contentFiles`:
  key, path, digest, byteLength; only when the game has one of the blocks),
  so the buildId still covers every byte the game reads. Readers verify the
  manifest first, then each file against its row, and hand the rest of the
  page the manifest with the blocks back under their keys: nothing after the
  read changed. A file may hold 32 MiB (the play store's single-artifact
  cap); the manifest document keeps its 256 KiB cap for what is left in it.
  "Libraries" have nothing to move: today a script library is compiled into
  each behavior that imports it (23.7) and never rides in the manifest; when
  25.9 makes them shared modules they ship as their own digest-named files
  like behaviors. Unused materials: a material ships when an object or a
  prefab maps or overrides it, a shipped model's default mapping, a block
  type, an effect's material shading or a timeline's material track names it
  (`materialsInUse`); scripts only set parameters on materials an object
  wears, so nothing else can reach one. The textures of an unused material
  still ship (they stay in the captured content view, so the contentDigest
  is unchanged, and `ctx.materials.set` accepts any texture of the game).
  A writable material mapping (25.8's generic `set`) would have to add the
  names a script can set. The recorded m3 delivery fixtures were re-derived
  by their tool (`derive-manifest.mts`): only `manifestVersion` changed
  (their project has no content file blocks), buildId `6e8f2c6f…` →
  `e6a0968f…`. No replay or determinism pin changed (the runtime reads the
  same blocks).
- 2026-09-28 (25.8): "the most recently loaded scene's light" is chosen per
  kind: the most recently loaded scene that holds a directional light has
  its sun on, and likewise for ambient and hemisphere lights, each on its
  own. So a level that holds only a sun keeps the start scene's fill light,
  and a level that wants no fill says so with an ambient light at 0.
  (Taking all three kinds from one scene, the "one unit" wording above, would
  drop the fill of every scene below a level that holds only a sun.) Start scenes count as loaded in their
  listed order, so two start scenes may each hold a sun and the later one's
  is on; the start-scene limit of one sun and one ambient is gone, the per
  scene limits stay. A light that is off is not drawn (`visible = false`:
  three leaves it out of the lights, so switching one sun for another keeps
  the light count and the shading programs); the key light's shadow
  settings, shadow square and the sky's sun direction follow it.
- 2026-09-28 (25.8): the local-light budget is enforced by the renderer, not
  by refusing loads: point and spot lights of all loaded scenes past 16 are
  off, the most recently loaded scenes' first (document order within a
  scene), and come back when a scene unloads; Play diagnostics count them
  (`renderer.lights.local`/`localOn`). A refused load would stop a game for
  a presentation limit. The Scene view applies the same selection to its
  open scenes, in hierarchy order.
- 2026-09-28 (25.8): cookies. The WebGPU path was checked in the r186
  sources (`SpotLightNode.setupDirect`: `light.map` sampled at
  `lightProjectionUV`, the spot's shadow matrix, which `lightShadowMatrix`
  updates also without a shadow), so it works with and without
  `castShadow`, unlike WebGLRenderer's documented "map needs castShadow";
  the adapter draws with WebGPURenderer on both backends, so one path
  covers both. A cookie that arrives after its light was drawn changes the
  lights' cache key (three hashes `map.id`), so the adapter asks for a
  precompile before the next present. The cookie is `light.cookie`, a
  texture assetId on spot lights only (a directional light refuses it); it
  is captured, read ahead with its scene and refused on delete like every
  typed reference. Baked lights ignore cookies (the browser and Blender
  bakes are unchanged).
- 2026-09-28 (25.8): the pixel test found D49 (spot lights shone from 1 m
  above their object and aimed wrongly unless pointing straight down;
  hemisphere lights tilted by their object's position). Fixed in the item.
- 2026-09-28 (25.9): **shared modules are linked by digest, through a stub.**
  A library is built on its own (esbuild bundle of its files, tree shaking
  and minify on, every export kept, external source map); a behavior's
  (or another library's) `@lib/<id>` resolves to a stub that re-exports the
  module's export names from `../libraries/<digest>.js` (`./<digest>.js`
  between libraries). So esbuild still refuses an import of a name the
  library does not export (the 23.7 check), the importer's own output digest
  covers the library's exact bytes (the recorded output digests and the
  buildId pin the linked output), and relative imports work unchanged in the
  page, the worker and a static export (no import map). Tree shaking is per
  library, not per project: a module does not depend on which scripts use
  it, which is what lets it be compiled once and cached by digest (the
  compiler's library cache, keyed by source, dependencies' output digests,
  pins, limits and forbidden strings; the 25.24c compile cache key gains the
  linking mode). A library change still recompiles its importers (their
  import paths name the new digest) — once per commit.
- 2026-09-28 (25.9): **library state is per realm.** A library's top-level
  variables are shared by every script that imports it (one module instance
  in the page, one in the worker), as a script's own module state already
  was; bundled copies used to give each script its own. Documented; game
  state belongs in the script's state or `ctx`. Replays restart scripts, not
  module state, as before.
- 2026-09-28 (25.9): **records published before 25.9** recorded the bundled
  output. The closure still treats the recorded digest as an assertion: when
  the shared compile differs and the record pins libraries, the bundled form
  is compiled and must equal it; the build then ships the shared form. No
  record, fixture or template changes; a library change or republish moves a
  record to the shared digest. The M2 path never has libraries.
- 2026-09-28 (25.9): **source maps without changing outputs.** Every compile
  now names an output file only for esbuild's external map (`outfile`,
  `sourcemap: 'external'`, no sources content); the JavaScript bytes are
  identical (tested; every recorded digest and fixture still matches), so
  `COMPILER_OPTIONS` and the recipe digest are unchanged. Maps stay on the
  backend's Play record (never served, released when the Play ends); exports
  ship none (they would disclose the sources).
- 2026-09-28 (25.9): **locations are recorded by the runtime, mapped by the
  backend.** A step, prepare, instantiate or dispose error keeps up to 4
  frames of the digest-named compiled modules from its stack
  (`behaviors|libraries/<digest>.js:line:col`, every browser's format), a
  `ctx.log` the first such frame of a fresh stack (accepted logs only;
  bounded per step). They live in the diagnostics error ring only, never in
  the simulation state or step digest. The Play diagnostics route maps them
  (`source`, `sources`) with the Play's maps, so the editor and
  `tl_diagnostics` read the same. Start-time failures (a throw while the
  game composes) are still reported by message only.
- 2026-09-28 (25.9): **staged edits are workspace state, the commit is a
  command.** A stage (`lstage-<n>`, at most 8 per project, 2 MiB of staged
  text, dropped on restart) holds whole staged libraries and the digest each
  was staged on; `commitScriptLibraryStage {stageId}` reads only that fact
  (never caller args), refuses a library that changed since it was staged,
  and makes one `setScriptLibraries` change (all libraries and the
  dependents' records; one undo). The backend compiles the dependents of
  every changed library once, against the committed set, before the command
  (as `setScriptLibrary` does for one). Patches may send a file in pieces
  (`append: true`). The stage route is not a command (like the content
  upload stages): it changes no revision. The editor stages only when a save
  does not fit one request, and for the panel's Save all.
- 2026-09-29 (25.10): **the marks and their version.** Descriptor fields
  carry `scriptReadable` and `runtimeWritable` (and `runtimeOnly` for a
  field that exists only while the game runs); a small table in
  `descriptors.ts` applies them: every top-level field of every component
  scripts may read (not folders, instance sets or block layers: bulk data),
  the object's own fields as the pseudo-component `object` (id, name,
  parentId, active, visible, static, tags; `locked` is editor-only). The
  derived table (`scriptAccessTable`, project-model `script-fields.ts`)
  carries the project schemaVersion, and a unit test pins its digest for
  schemaVersion 4: renaming or unmarking a field fails it until the schema
  is bumped (with an upgrade) and the pin renewed.
- 2026-09-29 (25.10): **refusals answer, they do not stop the game.**
  `set` returns `{ok, field, code, message}` (one flat shape so a visual
  script's node has plain outputs); a refused patch writes nothing. Each
  refusal is also noted in the diagnostics error ring (`entity_write`,
  reason `refused`, the code as detail) once per step, script and field,
  so a script that ignores the answer still shows in the Console.
  `get` of a component scripts cannot read throws (a misspelt name is a
  programming error, like a bad timer call); `get` of a component the
  object does not carry answers null.
- 2026-09-29 (25.10): **when writes apply and what reads see.** The queue is
  applied after the transform phase and the blocks' character tests, before
  the timelines and the camera brain (so the camera sees a moved object in
  the same step). Reads during a step see its start: transforms from the
  pre-step copy, material parameters from the values kept before their
  first change in the step, the visible state from a copy taken at its
  first change; the other fields change only at the queue's application.
  A field written twice in a step: the later write (script order) wins and
  the conflict is reported (`entity_write`, reason `conflict`, both writers
  named); a transform write to an object an owned transform intent also
  moved in the step counts as a conflict too (the write is applied after
  it). Limit: 4,096 accepted writes per step.
- 2026-09-29 (25.10): **relaxed ownership is the `transform` write.** Any
  script may write `transform.position/rotation/scale` of an object that is
  not a physics body (a collider or the controller, in both dimensions),
  not the camera, not static, and not posed every step by its mover,
  patrol, socket or facing model (the write would be overwritten). Owned
  transform intents (`ctx.emit`) keep their strict ownership and phases
  unchanged, so no existing script changes meaning.
- 2026-09-29 (25.10): **`active` switches loaded objects.** A script switches
  an object (and its children) off and on while it is in the game: off, it
  is not drawn (its lights and effects neither), its colliders leave the
  physics world (and come back where the object is now), its triggers,
  switches, movers, patrols, hitboxes, collectibles, animators, facing and
  scripts do not step, and its audio source is silent. A trigger or switch
  forgets that the character was inside (switched on again, an entry is an
  entry; no exit is sent), a hitbox's contacts end with `separate`. The
  camera, the character and objects above them stay on (`character_enable`
  switches the controller); static objects are refused (batched and baked
  once); virtual cameras keep their own switch (`ctx.camera`). An object
  made inactive in the editor stays out of the game as before: loading such
  objects would change every existing game's step digests and replays; a
  script switches an object off in its first step instead (owner review:
  whether authored-inactive objects should load switched off).
- 2026-09-29 (25.10): **`visible` is runtime-only.** It is the state
  `ctx.game.setVisible` and collectibles already used (the object with its
  children is drawn or not), marked `runtimeOnly` on the object descriptor;
  no stored flag was added. A light whose object is hidden or switched off
  is off and counts for nothing in 25.8's choice (the previous scene's sun
  of that kind comes back; a point or spot light frees its place in the
  budget), since directional, ambient and hemisphere lights hang off the
  scene rather than their object.
- 2026-09-29 (25.10): **lights, movers, materials.** Light writes are
  colour, intensity and range (point and spot; a `when` condition refuses
  range elsewhere, naming the field); a baked light is refused (it lives in
  the lightmaps). Written colour and intensity become the light's base, so
  an environment preset blends from them. The mover gains a stored
  `active` field (default on, stored only when off: a mover held until a
  script or, in 25.12, a signal starts it); `speed` and `active` are
  written, a new run restores the authored ones. Only material *parameter
  values* are writable, never the material mapping, so 25.7b's shipped set
  (used materials only) stays complete.
- 2026-09-29 (25.10): **saves and digests.** The `components` save section
  gains `fields` (objects switched off, `visible`, light and mover writes;
  only when any) — material values keep their own section, transforms and
  `ctx.game.setVisible` are not saved (as before). The step digest adds the
  written fields only while any exist, so every recorded pin is unchanged.
- 2026-09-29 (25.10): **`character_place` on the 2D plane** takes effect in
  the step it is committed, before the controller (as in 3D), through the
  2D placement arrivals and respawns use (the port's motion cleared, the
  controller reset as a transfer: from rest); z is ignored there. A respawn
  asked for in the same step gives way to it, as in 3D. `character_move`
  and `character_enable` stay 3D-only.
- 2026-09-29 (25.10): **`ctx.shell`** has `nextScene()` (the shell's
  `nextScene` move, queued for the next step boundary like the UI event;
  false without a next entry; calling it twice in a step asks for the same
  move), `sceneIndex()` and `sceneCount()`.
- 2026-09-29 (25.10): **typed references.** A spawned copy remaps only its
  scripts' `entityRef` properties (by the behavior's declaration) from the
  prefab's local ids to the copy's ids; before, any text value spelling a
  local id was remapped. Script object properties are pickers of the
  scene's objects in the Inspector ("none" clears); the prefab panel's
  initial overrides keep their id field (they may name a scene object or a
  local one).
- 2026-09-29 (25.10): **visual scripts** get the handle nodes the generator
  makes from the typings (category Entity: "Get component", "Set
  component" with ok/field/code/message outputs; the object input defaults
  to this object) and Shell nodes (Next scene, Scene list entry, Scene list
  length).
- 2026-09-29 (25.11): **the callbacks' shape.** `onX(state, ctx)` for the
  lifecycle, `onX(state, event, ctx)` for the events (the record the lists
  already carry: `TriggerEventRecord`, `ContactEventRecord`,
  `BehaviorMessage`, `UiEventRecord`, `AnimatorEventRecord`); like `step`
  they are synchronous and return nothing (else the same fail-stop, the
  callback named). `step` became optional for a script with callbacks; a spec
  with neither, or a callback key that is not a function, is refused.
- 2026-09-29 (25.11): **when they run.** Inside the step's intent phase, per
  script module in module order and per instance in instance order, before
  the instance's `step`: first the instances whose objects left the game
  since the last intent phase (onDisable if enabled, then onDestroy, then
  dispose), then per instance onEnable/onDisable, then (only while it ticks)
  triggers, contacts, messages, UI events, animator events in the order they
  happened, then `step`. The events are the ones the lists already give
  (last step's triggers, contacts, messages and clip events; this step's UI
  events), so nothing new enters the step's state and a script without
  callbacks steps exactly as before; replays and the worker stay identical.
- 2026-09-29 (25.11): **enable follows the object, not the game mode.**
  onEnable/onDisable follow whether the object is switched on (25.10's
  effective `active`, children included), compared at each intent phase, so
  every path (a script's write, a restart, a loaded save's `fields`) counts
  and a switch within one step that ends where it began sends nothing. They
  are sent while a game mode pauses the script's group too; the event
  callbacks are not (they belong to the tick, like `ctx.events`).
- 2026-09-29 (25.11): **onDestroy** is sent in the step the object left
  (removals happen at the step boundary, before the intent phase), after
  onDisable; the object is gone (`ctx.entity(ctx.entityId)` is null). A
  restart clears spawned copies without onDestroy and sends every instance
  onEnable again (it starts fresh, as its state does); stopping the game only
  disposes.
- 2026-09-29 (25.11): **ownership.** onTriggerEnter/Exit, onContact and
  onAnimatorEvent get the events of what the script owns (its object, below
  it, its object properties — the `ctx.events` rule); for clip events this is
  narrower than `ctx.events`, which lists every clip event. onContact gets
  both `contact` and `separate` (the record's `type`). onMessage gets every
  message to all scripts or to this object; onUiEvent every UI event.
- 2026-09-29 (25.11): **editor and visual scripts.** The typings generator
  also puts `BehaviorSpec` and the callbacks' event types in the completion
  table: inside `export default { … }` the callbacks complete, and an event
  parameter completes by its position in the callback (no annotation needed).
  Visual scripts get hand-written core event nodes for the callbacks the
  existing nodes did not cover — On enable, On disable, On destroy, On
  contact, On UI event — compiled into the spec's callback methods; On
  trigger, On message and On animator event keep reading the lists.
- 2026-09-29 (25.12): **one running flag.** The new signals act on the
  mover's `active` flag (25.10's Moving switch, the one scripts write), so a
  hold by signal is what `get('mover').active` reads and a mover authored
  with Moving off waits for its start or toggle signal (the 25.10 log said
  "a script or, in 25.12, a signal starts it"). `startOn` now also moves a
  held mover (before, it only ended the wait for the first signal); only
  movers authored since 25.10 with Moving off and a start signal behave
  differently. Order within a step: start, stop, toggle, reverse; one signal
  may not name two of start/stop/toggle (refused: it would undo itself),
  `reverseOn` may share a signal with any. Signal holds are not saved in a
  project save (mover positions never were); script writes still are.
- 2026-09-29 (25.12): **gravity easing** is an easing, not a physics body:
  the position along a stretch is the square of the time share (`along`
  still advances at `speed`), so the stretch takes as long as a linear one
  and `speed` stays its average (the mover arrives at twice it). The
  acceleration is therefore 2·speed²/length per stretch rather than the
  project gravity: a path's timing stays what its speed says, in any genre.
  A reverse part-way re-reads the distance for the new direction so the
  position never jumps. Patrols keep linear motion.
- 2026-09-29 (25.12): the script access pin (25.10) re-pinned for schema 4:
  the three new optional fields only add to what scripts read; a rename or an
  unmarked field stays a schema change.
- 2026-09-29 (25.12): D50 found by the lift test: in 3D the grounded
  character's per-step fall was swept together with a rising platform's
  carry while the port poses movers after the sweep, so each step ended
  inside the risen platform. While the carry lifts it, the character's own
  fall is cancelled (2D never had the fall on the ground).
- 2026-09-29 (25.13): **climbing is a volume, not a switch.** A
  `climbVolume` component (a box centred on its object, turned with it; its
  +Y is "up") is what a character climbs; the controller carries only the
  climb speed (2 m/s, the default 3D walk: slower than running) and an
  optional `climbAction`. A scene without volumes plays as before, so no
  on/off field was added. Up/down past half the input takes hold (a stick's
  drift or a sideways push does not), sideways input moves across the box
  (a ladder is narrow, a net wide: the size says which), leaving the box or
  a jump press lets go, and a character still rising from a jump does not
  take hold (a jump off a volume leaves it). The 2D plane's default move
  action is left/right only, so a 2D project either makes `move` a 2D axis
  or names an up/down axis as `climbAction` (the default input was not
  changed: that would change every project's manifest). A climb volume's
  depth counts in 3D; in 3D the climb input is the move's forward/back.
- 2026-09-29 (25.13): **walls.** Wall slide and wall jump are off by
  default. A wall is what the last step's move pushed into in the air (the
  port's wall contact, the side from the blocked part of the move; 3D: the
  blocked horizontal part gives the wall's normal). Slide holds the fall at
  `wallSlideSpeed` (2 m/s: a controlled slip) while pushing into the wall;
  wall jump works while touching it or within the coyote time after, leaves
  at `wallJumpAway` (absent: the run speed) and `wallJumpUp` (absent: the
  jump speed), and the input does not steer until the top of that jump —
  without that the 2D ground deceleration (60 m/s²) ate the push in 0.08 s
  (found by the integration test). Later the same day the lock became data
  (principle 2): `wallJumpLock` seconds (absent: until the top of the jump,
  the rule above, so recorded replays are unchanged; 0: steers at once; a
  landing always ends it), an Inspector field under "Wall jump".
- 2026-09-29 (25.13): **gravity for bodies that aren't characters** is a
  `gravity` component on objects without a physics body (not with a mover,
  a collider or a waypoint patrol — those set their own position): it
  falls under the project's `gravity_y` × scale, capped at `max_fall_speed`,
  onto colliders found by rays down from 0.1 m above its body's underside
  (centre and near its sides; 3D its corners too), landing on the highest.
  A falling solid (a collider that falls and carries the character) is not
  in it: the engine has no dynamic bodies and a kinematic falling collider
  would need the mover push rules; revisit if a game needs it. The height
  and fall speed are saved in the `components` section (`fall`, only when a
  scene has gravity bodies).
- 2026-09-29 (25.13): **2D patrol direction.** An edge patrol's direction
  on the 2D plane is now its x and y (unit); before only the sign of x
  counted. Directions along x walk exactly as before; one with a y part
  moves up or down (wall probe that way, no ledge probe). A stored
  direction with a y part in an existing 2D project now walks diagonally
  (such a value did nothing before; none of the engine's fixtures has one).
- 2026-09-29: 25.23 (the project window) moved to phase 26 (owner). Phase
  26 stores assets and resources as files in real folders of the game folder,
  so 25.23's folders-as-content-data would be thrown away; the window is built
  once, on that storage (26.13).
- 2026-09-29: 25.25 added (owner): Skyforge's E42, E44 and the authored-hidden
  half of E43, found after the plan. E41 (voice clips) is phase 26, E45 and
  E43's effect lights are phase 27 (scalable lighting). 25.10's decision that
  `visible` is runtime-only stands for scripts; 25.25 adds the authored
  starting value.
- 2026-09-29 (25.14): **camera regions are objects** (a `cameraRegion`
  component), not a list inside the camera: they load and unload with their
  scene (a level scene brings its own regions for a camera in a persistent
  scene), are moved, duplicated and placed from prefabs like any object, and
  apply to one named track camera or to every one. The box keeps to the
  world axes (the dead zone and bounds are per world axis; the object's
  rotation is not used); without a depth it holds every depth (2D). A
  region's bounds are offsets from its position, so they travel with it;
  the camera's own bounds stay world coordinates (the camera moves). Each
  absent region field keeps the camera's own. Overlaps: the highest
  priority, then the region entered last, then load order.
- 2026-09-29 (25.14): **the blend on enter** eases over the region's
  `blendTime` (the entered region's; leaving to no region: the left one's;
  default 0.5 s, the camera blend's). The dead zone and distance blend as
  numbers; bounds blend as the two clamped points (so a bound that appears
  or goes away moves the view smoothly, with no infinite numbers). A blend
  interrupted by another region change continues from where it was (kept
  at most two deep). The distance is along the camera's offset (absent: the
  offset as authored or placed). With no region and no look-ahead the maths
  is the 24.4g rig's bit for bit, so recorded replays are unchanged.
- 2026-09-29 (25.14): **look-ahead** is the target's velocity (from its
  positions, eased over `lookAheadSmoothing`, 0.2 s) times `lookAhead`
  seconds per axis, capped at `lookAheadMax` (3 m); a vertical look-ahead
  is `[0, t, 0]` and a platformer's run look-ahead `[t, 0, 0]` (principle 1:
  the axis is data). A look up/down on a button is a script moving
  `targetOffset` (`ctx.camera.set`), not a rig field. The cap keeps a
  respawn's jump from throwing the view.
- 2026-09-29 (25.14): **Scene handles** for what 24.4g left open: a new
  `bounds` handle kind (two corners; on the 2D plane drawn where the box
  crosses it, depth grips in 3D; a corner never passes the other) and an
  `anchor` on handle descriptors (the frame on another object named by an
  entity field, plus an offset field): the dead zone is drawn around the
  target plus `targetOffset`, where the camera frames it at the start. The
  handles show once both bounds, or a target, are set.
- 2026-09-29 (25.15): **the relay's UI parts run on the page, its steps in
  the simulation.** Frames reach the simulation (the page's or the worker's)
  as before; a frame's `ui` edges and a pointer click are handed to the page
  (in worker mode as a message) and applied at its next frame, where UI
  events already ride the next input frame. The pointer's hit test is plain
  data: the page lists where a press goes to the UI (the engine pause panel,
  then each shown document's buttons and inputs topmost first, a modal
  document's backdrop over everything below it) and the worker tests relayed
  pointers against the list the page sends while an exercise runs. A press
  over the UI goes to the UI (the game sees neither it nor its release, as
  with the real mouse, whose presses there never reach the view); a left
  press and release on one target clicks it (a button's click, an input's
  focus). `overUi` is part of the pointer sample (absent: false), so
  recordings replay. The real mouse over the page's UI is tracked through a
  window listener and gets `overUi` too; `over` stays true there (before,
  the view's pointerleave made it false).
- 2026-09-29 (25.15): **a paused game still takes the exercise's UI
  frames**: each page frame of a paused game (the engine pause, a menu, the
  debugger's hold) takes one step's place, so `[{0: pause}, {30: submit}]`
  pauses and resumes; the actions of those frames have nothing to drive.
- 2026-09-29 (25.15): **the virtual gamepad** is read on the page before the
  frames go to the simulation (the page has the bindings, rebinding
  included): step by step through the action evaluator with a pad that
  starts at rest and rests in gaps and in frames without one; each step of
  a pad frame becomes its own frame (the frame's own actions win by name).
  Its D-pad or left stick past 0.6, A, B and start give menu edges as a real
  pad does. Not done: the device status scripts read (`ctx.input.device`)
  stays as it was (the relay has no device entry); a focused document's
  action map does not mask relayed actions (as before for relayed actions).
  The character's `move`/`jump` come from the bindings through the
  evaluator, not the browser owner's keyboard device rules.
- 2026-09-29 (25.15): the relay's span is bounded at 7,200 steps (60 s at
  120 Hz) per call; the backend waits 10 s plus the span at 30 steps a
  second. Frames may not overlap; `stepOffset` above 7,199 is now refused.
- 2026-09-29 (25.16): **the run digest** compares a run with its replay
  (`replay` is the restart): a separate digest beside the worker-parity
  `stepDigest`, which hashes the absolute step and the scene set's revision
  (both grow across restarts). It counts steps from the run's start (a
  restart's boundary; `runtime.runStart()`), names a run's spawned copies by
  their number in the run (ids are never reused in a play, as 14.1 decided,
  so a replay's copies have higher ids; the ids stay as they are) and hashes
  the loaded scenes. It leaves out the logs of when things happened (sounds,
  timelines, dialogue, saves, a mode's switch step: they hold absolute
  steps); ids inside values scripts wrote are hashed as written. The
  observation's `run.digest` is the state between frames when observed;
  `run.lastInput` is taken right after an exercise's last step by a step
  observer where the simulation runs (the page or the worker), so it does
  not depend on frame timing. `tl_input_exercise {restart: true}` makes runs
  comparable: its first step asks for the restart, which happens at the next
  step's boundary, where the frames begin (run step 1). A paused game
  restarts when it runs again. Not step-exact: UI edges and clicks apply at
  the page's next frame (as a player's do), so an exercise with UI input
  compares with its replay only where the UI's effect has settled.
- 2026-09-29: 25.21's height blend became a general material-graph node and
  its brush a module (owner): trim-sheet environment pieces blend by vertex
  colour with the same node; painting mesh vertex colours in the editor and
  decals are a later phase (roadmap).
