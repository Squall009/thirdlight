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
scripting → movement → tools → rendering and terrain → the project window
(25.23). Each item keeps the gate green and has tests at the
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
| 25.21 | A painted terrain material: 4 height-blended PBR slots packed into 3 compressed texture arrays, paint and wetness stored with the layer, and an editor Paint mode. Needs 25.19 and 25.20. | E40 |
| 25.22 | Small UI and content items: a bindable `startAngle` and `size` on UI widgets, and an art-factory import route. The route reads a job's export, not the art-factory repo. | E32, E18 |
| **Editor quality of life** | | |
| 25.23 | **A project window with folders.** Today the asset browser is one flat list with no search, filter or sort. Materials, prefabs, scripts, UI documents, timelines, dialogue, effects and animators each live in their own panel.<br>• **Folders** for every project resource kind (assets, prefabs, materials and functions, behaviors and libraries, graphs, UI documents and themes, timelines, dialogue, effects, animators). They are nested and can be renamed.<br>• **Drag and drop:** resources and folders can be dragged between folders; multi-select, cut, paste and "new folder" work too. The existing drop targets stay: Scene view, Inspector fields, Hierarchy.<br>• **Browsing:** search by name, filter by kind, sort, grid or list view with a tile-size slider, a breadcrumb, and a virtualized list so thousands of items scroll smoothly.<br>• **Opening items:** a double-click opens the resource's editor (material, timeline, UI document and so on); the per-kind panels remain as views.<br>• **Imports** from a game folder default to a folder mirroring the file's path.<br>• **Storage:** folders are organization data only. They live in the project content and change through commands (`setResourceFolders` and a `moveResources` op) with undo, so MCP can organize them too. They are left out of the play manifest and the buildId, so moving an item never changes a build.<br>A Playwright test covers creating a folder, dragging an asset into it, search, and reload. | owner |
| 25.24 | **Faster Play start and scene loads.** Today every Play starts cold. The backend recompiles every behavior with esbuild and re-reads and re-hashes every asset. A new iframe re-downloads the 8.8 MB game bundle under a per-Play URL. `readDeclaredAssets` (`preview-m3.ts:252`) fetches and hashes **every asset of every scene, one at a time**, before mount. No pipelines are precompiled (no `compileAsync`), so the first frames stall; the large bench shows a 3.3 s frame. A runtime scene load does all its `addBatch` work in one step, then parses GLBs and compiles pipelines on first draw, with no preloading and no loading state. The large bench measured 4.5 s to first frame; asset-heavy real projects are unmeasured and likely much worse. In order:<br>a. **Stage timings** in play diagnostics and the perf harness: backend build, bundle load, asset read, worker start, mount, models settled, first frame, and the slow frames after it. Timings per scene load too. Add an asset-heavy class to the perf harness (many distinct GLBs and textures; the bench has one model). Measure before any fix, and record the split in §6.<br>b. **Asset reads:** only the start scenes' assets, read in parallel (bounded, e.g. 8 at a time). Other scenes' assets load when their scene does.<br>c. **Caching across Plays:** compiled behaviors keyed by source, compiler and library digests; blobs kept by digest instead of copied per Play; the bundle, worker and physics scripts and content served at stable, digest-keyed URLs with `immutable`/`ETag` headers, so the browser's HTTP and code caches hit. The digests are still verified.<br>d. **Pipeline precompile:** `renderer.compileAsync` before the first present and after each scene attach, in both renderers.<br>e. **Scene loads:** preload the scenes named in the shell scene list and in `trigger.sceneTransition` targets (fetch, parse, colliders prepared); spread `addBatch` over steps when it is over budget; a loading state scripts and UI can read, and an optional fade, so a transition never shows an empty world.<br>f. **Progressive presentation:** present once the start scene's blocking assets are in, and stream the rest. The 15 s present-timeout counts from the last progress, not from the start.<br>g. **Small items:** read the game bundle from disk once, not per Play; drop the page's second pretty-JSON serialize and hash of the scene (the buildId already binds it).<br>h. **Warm preview page:** keep a preloaded iframe (bundles parsed, worker and physics started) for the next Play. Only done if (a)'s split shows boot is still a large share after (b)–(g).<br>Acceptance: the before/after split in §6. On the GPU host, Play of an unchanged large project reaches its first frame in under 3 s from the second Play on, with no frame over 250 ms after it. A scene transition shows no empty frames. The exact targets are fixed from (a)'s numbers. | owner |

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
| 25.4–25.5 | — |
| 25.6 | done 2026-09-28: glTF extras accepted, import-scan hits located (line, comment/string/regex), createEntity refusal says how to add a setComponent-only component, cursor per any input map |
| 25.7–25.24 | — |

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
