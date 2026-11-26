# Inventory for phase 47T: every browser test file and every slow unit file

Item 47T.0 of `docs/plan-phase-47t.md`. Read-only: no test, tool or source changed. It is the plan for 47T.2 (cached worlds), 47T.3 (browser tests to unit tests, then archived) and 47T.4 (the picture set), and goes to the owner page. Branch `phase-45`, written 2026-11-26.

**Sources.** Browser tests and seconds: the last every-area gate, `~/.cache/thirdlight-logs/gate-fast-20261125-163859/e2e.log` (2 workers, under gate load; the census used the same log). Unit seconds: the last whole-suite vitest, `~/.cache/thirdlight-logs/gate-fast-20261125-183438/vitest.log` (6 workers, 600 s). No test was run for this inventory. "✓ covered" means the named unit file exists and its `describe`/`it` titles were read and match the logic the browser test checks; the bodies were not read line by line, so 47T.3 reads each one before its browser test is archived. Scripts and raw tables: `~/.cache/thirdlight-phase47t/work/47T.0/`.

## 0. Totals

**Browser suite today: 180 files** (the plan said 179; 180 after the WebGL 2 smoke test was archived), **326 distinct tests run + 11 skipped** (the run summary says 320 passed + 7 failed = 327, the plan's number; skipped: memory.e2e.ts's six without `TL_MEMORY=1`, two editor-workers, two effect-light-pool renderer variants, project-saves), **2861 s** of test time summed (47.7 min; 27.1 min wall at 2 workers).

Each file is counted once, under its lead fate (the first word of its fate; 27 files are mixed and split in their notes):

| Lead fate | Files | Tests run (+ skipped) | Seconds | What happens in 47T.3 |
|---|---|---|---|---|
| logic | 149 | 243 (+5) | 2295 | each check gets its unit test (or is shown covered), then the file is archived |
| looks | 5 | 5 | 47 | archived; its screen joins the picture set |
| retire | 15 | 16 | 409 | archived with their audit rows (the system retires in 48) |
| dropped (browser-only) | 8 | 53 (+6) | 76 | archived; what it checked is unchecked (browser-only, accepted by the owner) |
| boot | 3 | 9 | 34 | archived; the fresh boot check (§3) replaces it |
| **all** | **180** | **326 (+11)** | **2861** | the five boot tests stay, in one new file |

- Files with a *logic* part: 150. Fully covered by unit tests that exist today: **131**. Needing at least one new unit test: **19**, with **19 new unit tests** to write in all (listed in §1 with "→"). Covering unit files named: 329 references.
- Retiring systems: 15 files whose lead fate is *retire* (409 s), plus the retiring halves of five mixed files (editor-window, instance-brush, material-graph, renderer, window-tools).
- New pictures: 10 editor screens (E1–E10); the 22 world pictures already exist as bench cameras (§5). 32 in all.
- Unit suite: 984 files, 971 run, 600 s at 6 workers. **43 files take 10 s or more: 1,743 s** of file time (the plan counted 42 = 1,711 s from an older run), 1,242 s of it in 19 `tools/voxel-bench` files. The other 941 files take 790 s. §4 says which can be served by a cached world.

**The biggest risks for 47T.3** (the files whose logic is hardest to move or where a browser test is the only proof):

1. **voxel-world.e2e.ts**: 379 s, 5 tests, 437 `expect`s, 1,996 lines plus five helper modules (voxel-shadows.ts 1,422 lines). Its assembly proof (a runtime dig across chunk faces, every consumer following) has bench twins (edits, collision, world-host); 47T.3 must show one of them is the same case (a runtime dig across a chunk face, collision included) or write it (→ vb/world-host). The light-volume test (198 s) is pixel and timing reads only: it becomes pictures, and nothing checks the light volume's GPU path between phases.
1. **structure-mode.e2e.ts**: 64 s, 1,105 lines: the logic is in unit tests already (structure-shape, structure-openings, voxel-structures, voxel-water, voxel-splines), but the pointer-to-command wiring of the structure editor (draw a house by dragging, place an opening by pointer) exists only here. After archiving it is the owner's hands and the pictures E2–E4.
1. **authoring-loop.e2e.ts**: the core smoke today. Its gesture and undo logic is covered; the second-tab takeover and the reconnect after a restart need Node WebSocket tests (→ be/ws).
1. **rendering.e2e.ts**: 135 s: instancing equal to not instancing, FSR sharper than bilinear, TAAU without trails, dynamic resolution stepping. The rules are unit-tested; the pixel equalities are not and become pictures only.
1. **webgpu-reference.e2e.ts**: 40 reference-image cases of post effects, skies and node materials on WebGPU: the only check of their pixels. Dropped as browser-only; it could live on as a bench tool (lead decides).
1. **effects-gpu.e2e.ts, material-graph-render.e2e.ts**: cheap (3 s, 5 s) and the only GPU-side checks of the particle compute kernel and of graph materials' drawn values. No Node WebGPU: dropped, unchecked.
1. **memory.e2e.ts**: six leak tests, skipped in every gate since the full gate stopped running: page heap and GPU counts back to baseline are already unchecked today; after the reset they stay so (or become a bench tool).
1. **start.e2e.ts**: the one-command start (D417/D453/D815): becomes a Node test of `tools/start.mjs` (→ tools/start.test.mjs). It writes under `tmpdir()`: the new test must use `~/.cache`.
1. **count-caps.e2e.ts, large-project.e2e.ts, editor-scale.e2e.ts**: scale proofs (old caps ×1.5, a >1 MiB snapshot, 1,800 assets): the backend halves move to HTTP tests in Node; the browser halves (Play of that project, scrolling at scale) go unchecked.
1. **frame-rate-cap.e2e.ts, sim-worker.e2e.ts**: timing in a real page (9 of 10 gates red on D659; Play never waits on the simulation): the rules are unit-tested (frame-pacing, sim-state); the measured rates become recorded stats, not checks.

**Fates the lead decides** (unsure): `blocks.e2e.ts` (the census lists it as retiring; it is gameplay entities on the starter plane, not block layers: here *logic*, covered); `ktx2-rgba-thumbnails.e2e.ts` (*retire* as WebGL 2-only, or *dropped*); `webgpu-reference.e2e.ts` (dropped, or kept as a bench tool); `memory.e2e.ts` (dropped, or a bench tool); the retiring systems' slow unit files (surface-probes, surface-bake, block-mesh-worker, m42 bake-lighting: archive in 47T.3 or keep until 48 deletes the code); `tools/check-size.test.mjs`'s repository test (phase run, or dropped as a repeat of the build's own check).

## 1. The browser table

Legend for unit paths: `pm/` packages/project-model/src, `rt/` packages/runtime/src, `ta/` packages/three-adapter/src, `gh/` packages/game-host/src, `cmd/` packages/commands/src, `be/` packages/backend/src, `ed/` packages/editor/src, `ws/` packages/workspace/src, `wst/` packages/workspace/tests, `ti/` tests/integration, `vb/` tools/voxel-bench, `ap/` packages/asset-pipeline/src, `in/` packages/input/src, `pr/` packages/physics-rapier/src, `mcp/` packages/mcp-adapter/src, `bb/` packages/behavior-build/src, `vs/` tests/visual-script, `protocol/` and `shared/` their packages' src; `tests/x` is tests/x.test.ts; each name takes `.test.ts`. ✓ = covered today; → = the unit test it becomes (file, and the boundary in brackets). Pictures: L = a bench world camera, E = an editor screen (§5). Seconds and test counts per file are from the gate log above; RED = failed in that run.

| File (`tests/e2e/…e2e.ts`) | Tests | s | What it proves | Fate | Unit test | Picture | Notes |
|---|---|---|---|---|---|---|---|
| animator | 2 | 12 | an Animator-tab controller poses a skinned model in Play; graph layout, undo, blend tree | logic + looks | ✓ `pm/animator-graph`<br>✓ `tests/animator-graph-read`<br>✓ `rt/animator` | E9 |  |
| animator-layers | 1 | 11 | a bone-masked layer plays animation-only clips in the preview and Play | logic + looks | ✓ `pm/animator-layers`<br>✓ `ta/animator-player`<br>✓ `rt/animator` | E9 |  |
| animator-look-at | 1 | 8 | look-at turns the drawn head toward its target within limits | logic | ✓ `rt/look-at` | — | the drawn head pose is unchecked |
| animator-skinned | 1 | 5 | a rigged character's idle, run, airborne clips play on the starter player | logic | ✓ `ta/animation` | E6 |  |
| animator-timing | 1 | 6 | blend ground speeds, start times, random starts, play time in Play | logic | ✓ `rt/animator`<br>✓ `rt/animator-system` | — |  |
| asset-files | 1 | 5 | an import has a sidecar; renamed outside with it, "check files" keeps it | logic | ✓ `ws/asset-files` | — |  |
| asset-handles | 1 | 4 | a script loads by label, spawns, releases; resident back at baseline | logic | ✓ `rt/asset-handles`<br>✓ `ti/m26-asset-handles/determinism` | — | the page-side resident bytes after release are unchecked |
| assets | 1 | 3 | import → publish → isolated preview → place | logic | ✓ `tests/browser/m2-assets/authoring-flow` | — | the isolated preview pane draw is unchecked |
| audio-kinds | 1 | 5 | a long Opus and a stereo WAV are one Audio kind: load settings, Play voices | logic | ✓ `ap/inspect-audio`<br>✓ `pm/audio-assets`<br>✓ `gh/audio-loading` | — | Web Audio output is the owner's ears |
| audio-loading | 1 | 6 | each load type loads, plays, frees; a late sound dropped; voices read ahead | logic | ✓ `gh/audio-loading`<br>✓ `rt/dialogue-ahead` | — |  |
| authoring-loop | 7 | 22 | viewport, create, undo/redo, gizmo drag = one command, rename, keys, restart reconnect, tab takeover, token, MCP edit shows | boot + logic | ✓ `cmd/history-edge`<br>✓ `ed/session/client`<br>✓ `ed/session/edit-keys`<br>✓ `tests/browser/m2-assets/authoring-flow`<br>✓ `be/establish`<br>✓ `be/ws`<br>→ `be/ws` (Node WS clients: a second session attaching takes the project over, the first is told) | E1 | boot test 1 replaces its "editor opens" part |
| backup | 1 | 5 | a live project backup is refused; restored as a new project that opens and plays | logic | ✓ `tools/backup.test.mjs` | — |  |
| batch-dispose | 1 | 20 | dissolving an instancing group keeps the shared meshes drawn | logic | ✓ `ta/batching`<br>✓ `ta/dispose` | — |  |
| block-editor | 1 | 11 | block editor build/fill/stamp/walls/paint | retire | — | — |  |
| block-layers | 1 | 17 | a block map in Scene, Play, export; a script digs | retire | — | — |  |
| block-lightmaps | 1 | 12 | baked block-layer light on WebGL 2 and low | retire | — | — |  |
| block-lod | 1 | 12 | block-layer chunk LOD by distance | retire | — | — |  |
| block-world-uv | 1 | 12 | block looks with world UVs | retire | — | — |  |
| blocks | 1 | 10 | gameplay blocks from the menu: collectible, plate+door, one-way shelf, lift, in Play | logic | ✓ `ti/m9-blocks/blocks`<br>✓ `ti/m24-primitives/primitives`<br>✓ `ti/m15-inspector/inspector-fields` | — | the census listed it as retiring; it is gameplay entities on the starter plane, not block layers (unsure, lead decides) |
| callbacks | 1 | 6 | script-editor completion, On enable node, lifecycle/message callbacks in Play | logic | ✓ `ti/m25-callbacks/callbacks` | — | editor completion (Monaco) is unchecked |
| camera-depth | 1 | 7 | far plane and depth-buffer modes; mesh decals without z-fighting | dropped: browser-only | — | — | depth modes and decal z-fighting are unchecked (no voxel picture shows them) |
| camera-regions | 1 | 9 | track camera look-ahead, bounds, dead zone, a camera region in Play | logic | ✓ `ti/m25-movement/camera-regions`<br>✓ `rt/camera-regions` | — |  |
| cameras | 2 | 25 | virtual cameras in Play/export: follow, orbit, snap, rail, letterbox; editor fields and handles | logic | ✓ `rt/camera-brain`<br>✓ `ti/camera/determinism`<br>✓ `ti/m15-handles/handles` | — | the drawn letterbox is unchecked |
| capsule | 2 | 10 | player capsule Inspector, outline, top-handle drag one undo; walks under a low ceiling; trigger handle | logic | ✓ `ti/m14-capsule/capsule`<br>✓ `ti/m15-handles/handles`<br>✓ `ed/session/size-handles` | — |  |
| character-3d | 2 | 16 | 3D character up a riser and into a wall (keys, tl_input_exercise, export); step-up handle | logic | ✓ `ti/3d/character-controller`<br>✓ `ti/m15-handles/handles`<br>✓ `ti/m3-export/determinism` | — |  |
| climb-walls | 1 | 9 | a climb volume, wall fields and gravity; the character climbs | logic | ✓ `ti/m25-movement/climb-walls` | — |  |
| co-op | 2 | 22 | two player controllers from keyboard and a second pad, 2D and 3D, Play and export | logic | ✓ `ti/m28-coop/co-op`<br>✓ `in/actions` | — |  |
| colliders | 4 | 20 | _COL model colliders, the scene collider point budget at export, a child collider follows, outlines | logic | ✓ `cmd/collider-model-ops`<br>✓ `ti/3d/colliders-triggers`<br>✓ `ed/viewport/helper-overlay`<br>→ `be/export` (HTTP: an export at the 3D collider point budget is taken, one past it refused) | — |  |
| count-caps | 1 | 23 | a project 1.5x every old count cap opens, takes one command of each kind, plays, exports | logic | ✓ `tests/count-caps`<br>✓ `wst/v4-limits`<br>→ `tests/integration/count-caps/count-caps-http.test.ts` (HTTP backend in Node: open, one command of each kind, export) | — | Play of that project in a browser is unchecked |
| create-menu | 1 | 5 | the create menu lists the generic descriptor entries; each creates its component | logic | ✓ `pm/descriptors`<br>✓ `ti/m15-inspector/inspector-fields` | — |  |
| debug-entry | 4 | 17 | Play from a scene with variables; console and control route run a debug command; headless; export has no console unless set | logic | ✓ `ti/debug/debug-entry`<br>✓ `gh/debug-console`<br>✓ `protocol/play-start`<br>→ `be/export` (HTTP: an export without debug_console ships no console, with it ships one) | — |  |
| delete-content | 1 | 6 | used assets/prefabs/scripts refused, unused deleted; MCP same command; undo | logic | ✓ `wst/delete-content`<br>✓ `cmd/delete`<br>✓ `cmd/delete-behavior` | — |  |
| descriptors | 1 | 3 | the editor gets the descriptor registry with its first game query | logic | ✓ `wst/descriptors-query` | — |  |
| dialogue | 1 | 16 | dialogue with voice: previewer, Play, export | logic | ✓ `rt/dialogue`<br>✓ `ti/dialogue/dialogue-determinism` | — | the previewer UI is unchecked |
| edit-copy | 1 | 4 | Ctrl+D duplicates the selection with children, one undo; copy/paste across scenes | logic | ✓ `cmd/paste-entities`<br>✓ `ed/session/edit-keys` | — |  |
| editor-chrome | 1 | 6 | every item editor has a header, toolbar pictures, and an empty state that works | looks | ✓ `tests/editor-icon-registry` | E1, E7 |  |
| editor-scale | 1 | 29 | 1,800 assets: open, scroll the catalog, place, voice picker, tiles from the import cache | logic | ✓ `ed/ui/catalog/virtual-list`<br>✓ `be/thumbnails`<br>✓ `ti/m26-catalog/catalog` | — | scrolling responsiveness at scale is unchecked |
| editor-window | 3 | 29 | items open in a window with tabs, Esc returns; Open beside a reference; command after MCP edits | logic + looks + retire | ✓ `ed/session/editor-window`<br>✓ `ed/session/client` | E7 | its terrain edit-mode part retires |
| editor-workers | 2 +2 skip | 12 | a 50 000-copy scatter equal with and without workers; thumbnails equal; long tasks | logic | ✓ `tests/editor-workers` | — | long-task bound becomes a recorded stat; worker thumbnails (OffscreenCanvas) unchecked |
| effect-editor | 1 | 12 | the Effect tab previews: particles, pause, deterministic scrub, restart, slider, live edit, no leaks | logic + looks | ✓ `tests/effect-editor`<br>✓ `ta/effects-timeline` | E8 |  |
| effect-graph | 1 | 6 | an effect: create, add system, chains, curve, Effect component, reload, undo | logic | ✓ `cmd/effect-ops`<br>✓ `pm/effects` | — |  |
| effect-light-pool | 1 +2 skip | 26 | effect lights 1 → 40 build no shader after the first, Play and export | logic | ✓ `ta/effects-player` | — | the GPU pipeline count on WebGPU is unchecked |
| effects-gpu | 3 | 3 | WebGPU compute particles equal the CPU reference; billboards; effect light | dropped: browser-only | — | E8 | the WebGPU particle kernel against the CPU one is unchecked (no Node WebGPU) |
| effects-runtime | 2 | 15 | a burst started by a signal shows in Play/export; Scene view plays the selected effect | logic + looks | ✓ `rt/effects-requests`<br>✓ `ta/effects-player` | E8 |  |
| embedded-textures | 1 | 11 | images inside model files count against the texture budget, Scene view and Play | logic | → `ta/texture-budget` (pure: a model's embedded images enter the plan as budgeted textures) | — |  |
| engine-stats | 1 | 11 | ctx.stats, $flow.stats, Play diagnostics read frame stats; the F3 overlay only with the setting | logic + looks | ✓ `gh/frame-stats`<br>→ `rt/ui` (runtime in Node: ctx.stats and $flow.stats read the frame the host sent) | E6 |  |
| engine-view | 1 | 6 | the view is the live camera's, else the default pose with a Problems line | logic | ✓ `rt/views` | — |  |
| entity-access | 1 | 5 | ctx.entity: Inspector-picked properties, typings, a light and object switched by script | logic | ✓ `ti/m25-entity-access/entity-access`<br>✓ `pm/script-fields` | — |  |
| environment | 1 | 11 | sky, vignette, bloom and a fog volume in Scene view, Play, export | looks | ✓ `ta/environment` | L1, L4 | vignette and the fog volume are in no picture: unchecked |
| environment-blend-cost | 1 | 17 | a blend at 120 Hz drops no steps; lighting re-bakes only when the sky changes | logic | ✓ `rt/environment-blend`<br>→ `ta/environment` (pure: the environment map is rebuilt only for a sky change) | — | the dropped-steps bound becomes a recorded stat |
| environment-presets | 1 | 14 | presets captured and previewed; a script blends day to night | logic + looks | ✓ `pm/environment-presets`<br>✓ `rt/environment-blend` | L1, L4 |  |
| external-edit | 2 | 6 | an edit on disk is announced and loadable; a corrupt one is not; a failed command shows in Problems live | logic | ✓ `wst/external-change`<br>→ `be/ws` (Node WS: a refused command from another client reaches every session as a problem) | — |  |
| extract-textures | 2 | 18 | a model's extracted images become texture assets, streamed under the budget | logic | ✓ `be/model-textures`<br>✓ `ta/texture-budget` | — |  |
| folder-assets | 2 | 14 | a .glb from the project folder: place, reload, restart, Play, export, re-import; MCP in place | logic | ✓ `be/folder-import`<br>✓ `ti/m26-folder-import/folder-import-mcp`<br>✓ `be/resource-files-check` | — |  |
| folder-import | 1 | 3 | uploads land in the folder named; picked folders import with labels | logic | ✓ `be/folder-import` | — |  |
| folder-projects | 2 | 12 | a game-folder project: create, edit, restart, backup/restore, export, unregister, unavailable; MCP finds it | logic | ✓ `wst/registry`<br>✓ `tools/backup.test.mjs`<br>✓ `mcp/onboarding` | — |  |
| font-asset | 1 | 4 | a TTF and a WOFF2 import as fonts with tiles | logic | ✓ `ti/font/font-import` | — |  |
| frame-rate-cap RED | 1 | 27 | the cap (project, script, player) changes the drawn rate, never game time; player choice kept (D659) | logic | ✓ `rt/frame-pacing`<br>→ `gh/host` (game host in Node: the player's cap choice is stored and read back at the next start) | — | the measured fps bound becomes a recorded stat |
| game-modes | 2 | 14 | one switch changes input map, camera, UI, groups; pause in explore; static export | logic | ✓ `ti/modes/modes-determinism`<br>✓ `rt/modes`<br>✓ `ti/m27-held-modes/held-modes` | — | the Game modes panel UI is unchecked |
| gizmos | 1 | 3 | icons load, rows use them, collider outlines, the Gizmos menu toggles helpers | looks | ✓ `tests/editor-icon-registry`<br>✓ `ed/viewport/helper-overlay` | E1 |  |
| graph | 3 | 15 | graph editing: catalogue, wires, box select, copy/paste, groups, minimap; a 2000-node graph; survives restart | logic + looks | ✓ `tests/graph-editor-edits`<br>✓ `tests/graph-editor-placement`<br>✓ `cmd/graph-ops` | E7 | pointer gestures (box select, pan/zoom, minimap) unchecked |
| handles | 3 | 21 | box/capsule/radius, lights, paths and polygons dragged, stored snapped, one undo | logic | ✓ `ti/m15-handles/handles`<br>✓ `ti/m15-handles/spline-handle`<br>✓ `ed/session/size-handles` | — |  |
| hidden-signals | 1 | 9 | Visible off: hidden until a tool signal; console signal; export starts hidden | logic | ✓ `ti/m25-hidden-signals/hidden-signals` | — |  |
| hierarchy | 1 | 8 | folder flags inherited, locked not pickable, inactive left out of Play; drag keeps world positions | logic | ✓ `cmd/hierarchy-ops`<br>✓ `ed/session/hierarchy`<br>✓ `wst/hierarchy-storage` | — |  |
| import-extensions | 2 | 20 | WebP, material extensions, unlit, quantized, Draco, meshopt, KTX2 GLBs import and render | logic | ✓ `ap/import-ext` | — | the browser decoders (Draco, meshopt, Basis) drawing them are unchecked |
| import-fbx | 2 | 20 | an FBX converted, placed, played, exported; MCP upload and game-folder FBX | logic | ✓ `be/fbx`<br>→ `ti/m26-folder-import/folder-import-mcp` (HTTP + MCP client in Node: an uploaded FBX through the same tools) | — |  |
| input | 3 | 13 | jump rebound to W in the Input window; hold time; glyph image; a map's cursor with a mode | logic | ✓ `in/actions`<br>✓ `gh/rebind`<br>✓ `ti/input/rebind-replay`<br>✓ `rt/pointer-queries`<br>✓ `rt/modes` | — | the Input window UI is unchecked |
| insecure-context | 1 | 6 | Play without WebCrypto; the export over plain http on a LAN address | logic | ✓ `shared/sha256` | — | a real insecure browser context is unchecked |
| inspector | 3 | 16 | every component kind added, edited (one undo), removed; content tables; gameplay settings | logic | ✓ `ti/m15-inspector/inspector-fields`<br>✓ `ed/session/request-batches` | — |  |
| instance-brush | 2 | 42 | instance brush on a block-layer top and a model, one command a stroke; MCP; vertex paint | logic + retire | ✓ `pm/instance-brush`<br>✓ `cmd/instance-stroke-ops`<br>✓ `ed/session/vertex-paint-brush`<br>✓ `cmd/vertex-paint-ops` | — | the block-layer half retires; the painted pixels are unchecked |
| instances | 4 | 40 | scatter = one entity; buffer route refusals; chunking; shadows; LOD per copy; ground cover rows | logic | ✓ `ta/instancing`<br>✓ `ta/lod-switch`<br>✓ `pm/instance-chunks`<br>✓ `ta/cover-rows`<br>→ `be/play` (HTTP: the instance-buffer route refuses bad buffers) | — |  |
| internal-edges | 1 | 8 | the player slides down a wall of stacked boxes past every seam | logic | ✓ `pr/port3d-edges` | — |  |
| keep-loaded | 1 | 5 | Keep loaded in the Inspector; kept objects live through unload/reload | logic | ✓ `rt/kept-objects` | — |  |
| ktx2-rgba-thumbnails | 1 | 4 | a KTX2 model transcoded to RGBA (WebGL 2 extensions hidden) draws its thumbnail | retire | — | — | WebGL 2 only |
| ktx2-textures | 1 | 8 | KTX2 colour and normal maps encoded on import show in Scene, Play, export | logic + looks | ✓ `cmd/ktx2-texture`<br>✓ `tests/ktx2-pack`<br>✓ `tests/ktx2-levels` | L1, L2 |  |
| large-project | 2 | 21 | a snapshot over the 1 MiB frame bound starts Play by reference; a windowed Hierarchy | logic | ✓ `ed/session/hierarchy`<br>✓ `ed/ui/catalog/virtual-list`<br>→ `be/play` (HTTP: a snapshot over the frame bound is sent by reference and fetched whole) | — |  |
| layered-material | 1 | 78 | normal maps on painted terrain, layered material, trim rows | retire | — | — |  |
| level-acceptance | 1 | 37 | blocks on km terrain, splines, generated architecture (WebGPU and WebGL 2) | retire | — | — |  |
| lightmaps | 2 | 65 | phase-42 bakers and saved probes | retire | — | — |  |
| layout | 1 | 5 | docks where Unity puts them; Play in the Game tab; splitters survive a reload | logic + looks | ✓ `ed/session/dock-layout` | E1 |  |
| lights | 1 | 24 | a red point light tints a box; Inspector edits; a spot cookie; atlas shadows; a room of lamps | looks | ✓ `ta/lights-shadows`<br>✓ `ta/shadow-atlas`<br>✓ `ta/cluster-lights` | L4, L6, L7 | the spot cookie is in no picture: unchecked |
| loadable | 1 | 4 | labels, addresses, undo, reload; a script naming a non-loadable asset is a Problem | logic | ✓ `cmd/loadable-ops`<br>✓ `be/loadable` | — |  |
| look-override | 1 | 6 | a script's look override glows an object and clears it | logic | ✓ `ti/m24-primitives/transitions`<br>✓ `ta/dispose` | — | the glow pixels are unchecked |
| manifest-keys | 1 | 6 | a manifest with every optional key builds, verifies, plays, exports | logic | ✓ `pm/manifest-v5`<br>✓ `ti/m3-builds/manifest-v2` | — |  |
| material-custom-lit | 1 | 7 | a Custom-lit graph shades from the lights in preview, Scene, Play, export | dropped: browser-only | ✓ `ta/material-graph` | — | custom-lit shading on the GPU is unchecked |
| material-graph | 3 | 12 | graph material: nodes, texture × tint, reload, undo; New material defaults; Customize; functions; overrides | logic + retire | ✓ `cmd/material-graph-ops`<br>✓ `tests/material-defaults`<br>✓ `tests/material-graph-editor` | E7 | the terrain-editor warning part retires |
| material-graph-play | 1 | 8 | a graph material draws in Scene view, Play, export | logic | ✓ `ta/material-graph`<br>✓ `ta/runtime-materials` | E7 |  |
| material-graph-render | 6 | 5 | every node kind compiles and draws on WebGPU; known values; texture limit fallback; specular; custom-lit | dropped: browser-only | ✓ `ta/material-graph`<br>✓ `ta/texture-unit-guard`<br>✓ `ta/material-graph-specular` | — | compile is covered; the drawn values on the GPU are unchecked |
| material-instances | 1 | 6 | material instances on an object, a model default mapping, by command | logic | ✓ `tests/material-instances`<br>✓ `cmd/material-instance-ops` | — |  |
| material-preview | 2 | 8 | the Material tab previews on shapes; templates; convert to graph; compile problems | logic + looks | ✓ `tests/material-defaults`<br>✓ `be/material-problems` | E7 |  |
| material-runtime | 1 | 8 | a script sets one object's colour and writes a data grid on a shared material | logic | ✓ `ta/runtime-materials`<br>✓ `ti/materials/runtime-materials` | — |  |
| material-swap | 2 | 10 | a swapped material shows once loaded; a timeline key swaps; the Timeline track UI | logic | ✓ `ta/material-swaps`<br>✓ `cmd/timeline-ops` | — |  |
| materials | 2 | 23 | foliage moves in the wind and bends round interactors | logic | ✓ `ta/wind-field`<br>✓ `ta/subject-bend`<br>✓ `ta/interaction-field` | — | no voxel picture has foliage: the drawn bend is unchecked |
| mcp | 3 | 12 | an MCP agent inspects, plays, observes, moves, captures; folders; graphEdit + publish | logic + boot | ✓ `mcp/mcp.e2e`<br>✓ `cmd/hierarchy-ops`<br>✓ `cmd/behavior-graph-ops` | — | Play through MCP is boot test 4 |
| mcp-headless | 1 | 6 | with no editor open MCP plays, observes, moves, screenshots through a headless editor | boot | — | — |  |
| memory | 0 +6 skip | 0 | leak tests: tabs, previews, Scene view, Play, play sessions back to baseline (TL_MEMORY=1 only) | dropped: browser-only | — | — | skipped in every gate since the full gate stopped; page heap/GPU counts back to baseline are unchecked |
| menus | 4 | 12 | GameObject, Edit, Component, File → Export zip, Window, Help, full screen | logic | ✓ `pm/descriptors`<br>✓ `be/export` | — | the menus as UI are unchecked |
| missing-files | 1 | 4 | missing files listed at open and in Problems; Play stands placeholders in | logic | ✓ `be/missing-files` | — |  |
| model-pieces | 1 | 6 | a multi-piece GLB: piece tiles, drag into scene and folder, vertex colours as data | logic | ✓ `cmd/model-pieces`<br>✓ `pm/model-pieces` | — |  |
| mover-signals | 1 | 6 | a held lift with toggle/stop/reverse signals moved by a trigger | logic | ✓ `ti/m25-movement/mover-signals` | — |  |
| painted-terrain | 1 | 12 | height-blended layers on a painted block layer and a vertex-coloured GLB | retire | — | — |  |
| physics-3d | 1 | 10 | a 3D capsule lands on a box in Play (worker and page) and the export | logic | ✓ `ti/3d/character-controller`<br>✓ `ti/m22-worker/parity` | — |  |
| physics-3d-colliders | 1 | 16 | _COL node → convex collider; a 3D trigger starts a mover; sphere handle | logic | ✓ `cmd/collider-model-ops`<br>✓ `ti/3d/colliders-triggers`<br>✓ `ti/m15-handles/handles` | — |  |
| placeholders | 1 | 3 | lights, spawns, empties show as clickable icons | looks | ✓ `tests/editor-icon-registry`<br>✓ `ed/viewport/scene-queries` | E1 |  |
| play-audio-diagnostics | 1 | 4 | Play diagnostics: the audio block before/after unlock, the message-queue warning | logic | ✓ `gh/audio-report`<br>✓ `gh/audio` | — |  |
| play-end | 1 | 6 | a timeline ended event in the worker; a play ending before it is presented says why | logic | ✓ `ti/m25-timeline-ended/ended`<br>✓ `be/play-retention` | — |  |
| play-export | 1 | 6 | Play renders a fresh project in the isolated preview; the export runs served statically, backend stopped | boot | — | — |  |
| play-files | 1 | 4 | a model changed on disk between two Plays: the second shows the new file at a new URL | logic | ✓ `be/play-files` | — |  |
| play-logs | 1 | 12 | refused script calls answer false, logged once; diagnostics trimmed; dialogue focus | logic | ✓ `rt/error-ring`<br>✓ `ti/m38-script-errors/script-errors`<br>✓ `protocol/diagnostics-bound` | — |  |
| play-memory | 1 | 6 | the play preview holds a fixed set of GPU resources with post effects | dropped: browser-only | — | — | becomes a row of the performance report (resident bytes), not a check |
| play-reimports | 1 | 3 | Play reports the files the check imported again, with digests, over HTTP, MCP, Problems | logic | ✓ `be/play-files`<br>→ `be/play-files` (HTTP: the start answer lists re-imported files with old and new digests) | — |  |
| play-start-assets | 1 | 4 | Play reads only the start scene's assets; a later scene reads its own | logic | ✓ `ti/m26-catalog/catalog` | — |  |
| play-start-cache | 3 | 12 | batches share node programs; first present waits for a precompile; second Play from the browser cache | logic | ✓ `ta/precompile-gate`<br>✓ `be/play-files` | — | program sharing and the browser cache are unchecked |
| playtest | 2 | 36 | the CLI plays an input script twice, same digest; tl_playtest through MCP stdio | logic + boot | ✓ `mcp/playtest`<br>✓ `gh/run-probe` | — | the run itself needs the headless editor (boot test 4 starts it) |
| pointer-queries | 2 | 9 | hover and click in Play, through the relay, in the export; pointer binding UI | logic | ✓ `ti/pointer/replay`<br>✓ `rt/pointer-queries`<br>✓ `ti/pointer/collision-layers` | — |  |
| preview-pane | 1 | 4 | one preview pane: timeline, UI document, material, one renderer | logic | ✓ `ta/preview-controller` | — | one renderer for all previews is unchecked |
| primitives | 1 | 6 | collectible, patrol, hitbox, health from Add component; a counter, a turn, damage | logic | ✓ `ti/m24-primitives/primitives` | — |  |
| project-items | 2 | 11 | the bottom dock's panels; Create makes every kind; a chosen item in the Inspector; rename, delete | logic + looks | ✓ `ed/session/project-items`<br>✓ `ed/session/dock-layout` | E1 |  |
| project-saves | 0 +1 skip | 0 | a script saves to slot 2; a reload lists it; loading restores (Play and export) — skipped today | logic | ✓ `ti/saves/project-saves`<br>✓ `gh/project-saves` | — |  |
| project-settings | 1 | 4 | every sub-tab shows; edits round-trip; search filters | logic | ✓ `ti/m15-inspector/inspector-fields` | — |  |
| project-ui | 1 | 9 | project UI in Play and export: bound bar, click to script, focus, world label, pause screen | logic | ✓ `ti/ui/ui-determinism`<br>✓ `gh/ui-layer`<br>✓ `rt/ui` | — |  |
| project-upgrade | 1 | 7 | a version-6 project opens, upgrades and replays the same | logic | ✓ `be/format-upgrade` | — |  |
| project-window | 3 | 15 | folders, drag, rename, t:/l: search, cut/paste one undo, double-click opens | logic | ✓ `ws/file-moves`<br>✓ `ed/session/project-search` | — |  |
| projects | 1 | 15 | a wrong token is refused; token once; pick a project or create from a template | logic + boot | ✓ `be/projects`<br>✓ `be/templates`<br>✓ `be/establish` | — | boot test 1 opens the picker |
| rebind | 2 | 12 | rebind jump to K / a pad button on a controls screen; survives reload; reset; glyph | logic | ✓ `gh/rebind`<br>✓ `in/pad-rebind`<br>✓ `in/rebind-capture`<br>✓ `ti/input/rebind-replay` | — |  |
| relay-input | 2 | 15 | tl_input_exercise in the worker: runs, UI hits, gamepad, pause; replay same digest | logic | ✓ `gh/relay-input`<br>✓ `gh/run-probe` | — |  |
| renderer | 2 | 22 | auto picks WebGPU else WebGL 2; ?renderer= flag; project setting picks the backend | logic + retire | ✓ `ta/renderer-factory` | — | the WebGL 2 half retires |
| rendering | 6 | 135 | instancing, picking, idle draws nothing, quality levels, render scale/FSR/TAAU/dynamic resolution, HiDPI | logic + looks | ✓ `ta/batching`<br>✓ `ta/instancing`<br>✓ `ta/quality-control`<br>✓ `ta/dynamic-resolution`<br>✓ `ta/post-taau`<br>✓ `ta/motion-vectors` | L1–L5 | the pixel comparisons (instanced = not instanced, FSR sharper) are unchecked |
| replay-answer | 2 | 17 | a replay answers once applied with the new run id, or pending | logic | ✓ `ed/preview/replay-answer` | — |  |
| resource-folders | 1 | 3 | new scenes and materials go into the folder named; outside files appear | logic | ✓ `ws/resource-folders` | — |  |
| resource-manager | 3 | 7 | a transition keeps a shared model; a sky+map texture decoded once; opening B frees A's model | logic | ✓ `rt/resources`<br>→ `ta/visual-resource` (pure: one decode for a texture both the sky and a map name) | — |  |
| save-slots | 1 | 5 | character_place facing; a save keeps facing and slot meta; a UI image shows the slot picture | logic | ✓ `gh/project-saves`<br>→ `rt/project-saves` (runtime in Node: the world block keeps the character's facing) | — |  |
| save-storage | 1 | 6 | a quota-refused save leaves the earlier save whole; a refused settings write reported | logic | ✓ `gh/project-saves`<br>✓ `rt/project-saves` | — |  |
| save-world | 1 | 6 | world is an opt-in save section; a kept object stays | logic | ✓ `rt/project-saves` | — |  |
| scene-environment | 2 | 20 | each scene's look in the Scene view; the active scene's sky blended in Play/export | logic | ✓ `ti/m27-scene-environment/active-scene`<br>✓ `be/format-upgrade`<br>✓ `rt/environment-blend` | — |  |
| scene-lights | 1 | 9 | lights belong to scenes: the latest scene's sun, light layers, a spot cookie | logic | ✓ `ta/scene-lights`<br>✓ `ta/light-layers`<br>✓ `rt/scene-set` | — |  |
| scene-loads | 2 | 21 | a transition shows no empty frame; a fade; AO precompile does not hold a load | logic | ✓ `rt/scene-transition-25e`<br>✓ `gh/scene-preload`<br>✓ `ta/precompile-gate` | — | the drawn frames during a load are unchecked |
| scene-reload | 1 | 8 | reloadScene as authored; pause panel; scene-load button; deprecated restarts | logic | ✓ `rt/scene-reload` | — |  |
| scene-transition | 1 | 5 | a trigger's transition, track camera, event sounds in Play | logic | ✓ `ti/m24-primitives/transitions`<br>✓ `rt/scene-transition-25e` | — |  |
| scenes | 1 | 4 | several scenes in the editor: new, active, rename, start set, drag across, close/open, delete | logic | ✓ `be/scene-model`<br>✓ `be/retry-scene-id` | — |  |
| screenshot | 4 | 18 | a Play screenshot holds the drawn frame; a large one comes back; failures answer why; waits for the first frame | logic + boot | ✓ `ed/preview/screenshot-answer` | — | boot test 4 takes one screenshot |
| script-api | 1 | 5 | a moved parent's child reads where it is drawn; anyPressed; spawned copies' own values | logic | ✓ `rt/world-matrices`<br>✓ `rt/pointer-queries`<br>✓ `rt/spawn` | — |  |
| script-audio | 2 | 12 | script audio in Play/export: loop, pitch, fade, stop, finished event, panning | logic | ✓ `ti/audio/script-audio` | — |  |
| script-editor | 1 | 11 | edit, inline compile error, fix, publish, Play runs it; an import-scan hit in a comment | logic | ✓ `bb/compile-diagnostics`<br>✓ `be/script-publish-stages` | — | the editor markers are unchecked |
| script-libraries | 1 | 9 | a library made in the editor imported by two scripts; saving recompiles | logic | ✓ `ti/m25-libraries/shared-modules`<br>✓ `bb/libraries` | — |  |
| script-libraries-shared | 2 | 16 | libraries are shared modules in Play and export; staged edits commit together | logic | ✓ `ti/m25-libraries/shared-modules`<br>✓ `ti/m25-libraries/staged-edits` | — |  |
| script-properties | 2 | 7 | public/private script properties; 100 properties; the declaration byte budget | logic | ✓ `pm/script-fields`<br>✓ `ti/m15-inspector/inspector-fields` | — |  |
| script-sound-owners | 2 | 11 | loops of twenty scenes stop with them; voice-cap drop one line; stopAll | logic | ✓ `rt/script-sound-owners`<br>✓ `gh/audio` | — |  |
| sensors | 1 | 9 | a sphere trigger in Inspector and Scene view; a timed door | logic | ✓ `ti/3d/colliders-triggers`<br>✓ `ti/m15-handles/handles`<br>✓ `ed/viewport/helper-overlay` | — |  |
| shadows RED | 2 | 40 | a box casts the sun's shadow; Casts shadows off; static casters from a cached map | logic + looks | ✓ `ta/cached-shadow`<br>✓ `ta/lights-shadows` | L1, L12, L13 |  |
| shared-textures | 1 | 11 | one material on 14 model files holds one copy of its texture | logic | → `ta/material-library` (pure: fourteen models with one material resolve to one texture object) | — |  |
| shell | 2 | 17 | the game shell: title, HUD, pause, save, load; the export saves and continues | logic | ✓ `ti/m24-primitives/shell`<br>✓ `gh/shell`<br>✓ `gh/project-saves` | — |  |
| shell-scenes | 1 | 6 | the shell's scene list and settings; music volume kept | logic | ✓ `ti/m24-primitives/shell` | — |  |
| sim-worker | 4 | 41 | worker by default, ?threads=off; shared memory; Play never waits on the simulation; export | logic + boot | ✓ `ti/m22-worker/parity`<br>✓ `gh/sim-state` | — | cross-origin isolation and draw rate with a slow worker are unchecked |
| sky-texture | 1 | 4 | a texture sky is upright | dropped: browser-only | — | — | no bench look uses a texture sky: unchecked |
| smooth-tops | 1 | 8 | smoothed block-layer tops | retire | — | — |  |
| sockets | 2 | 20 | a socket follows an animated node; clip rate halved; detach; editor fields | logic | ✓ `rt/sockets`<br>✓ `ti/sockets/determinism`<br>✓ `ti/sockets/rig-parity` | — |  |
| spawn | 1 | 7 | a script spawns a projectile on a timer; old ones destroyed | logic | ✓ `ti/m14-spawn/spawn`<br>✓ `rt/spawn` | — |  |
| start | 2 | 6 | one command starts the backend; the URL opens the picker; clean stop; token kept; proxy origins (D815) | logic | → `tools/start.test.mjs` (Node: spawn tools/start.mjs on a data root under ~/.cache, GET the printed URL, stop, exit 0, token reused, --origin) | — |  |
| starter-capabilities | 1 | 18 | a new Starter project: spot cookie, a script writing a light, a library, a callback, a mover | logic | ✓ `be/templates`<br>✓ `ti/m25-callbacks/callbacks`<br>✓ `ti/m25-libraries/shared-modules`<br>✓ `ti/m25-movement/mover-signals` | — |  |
| starter-game | 1 | 6 | a small game from the Starter template: title, HUD counter, damage, respawn, transition | logic | ✓ `ti/m24-primitives/primitives`<br>✓ `ti/m24-primitives/shell`<br>✓ `ti/m24-primitives/transitions` | — |  |
| structure-mode RED | 4 | 64 | structure editor: draw, widen, storey, swap, dig, openings, water bodies, splines; undo/redo (D774/D788/D823) | logic + looks | ✓ `ed/session/structure-shape`<br>✓ `ed/session/structure-openings`<br>✓ `ti/voxel-world/voxel-structures`<br>✓ `ti/voxel-world/voxel-water`<br>✓ `ti/voxel-world/voxel-splines`<br>✓ `voxel/structures/*` | E2, E3, E4 | the pointer-to-command wiring on the page and the ghosts are unchecked |
| tags | 2 | 7 | tags in settings and Inspector; a script queries by tag | logic | ✓ `cmd/tag-ops`<br>✓ `rt/tags` | — |  |
| terrain | 1 | 14 | sloped block terrain | retire | — | — |  |
| terrain-brushes | 1 | 6 | block terrain brushes | retire | — | — |  |
| terrain-cdlod RED | 1 | 108 | CDLOD heightfield terrain (WebGPU and WebGL 2, D643) | retire | — | — |  |
| terrain-paint | 1 | 13 | terrain paint mode | retire | — | — |  |
| texture-streaming | 3 | 29 | a large KTX2 streams mips by on-screen size in the budget; RGBA transcode; inspector setting | logic | ✓ `ta/texture-budget`<br>✓ `cmd/ktx2-texture` | — |  |
| textures | 1 | 4 | a PNG imports as a texture with its tile; it shows on a box | logic | ✓ `be/image-thumbnail`<br>✓ `cmd/import-assets` | — |  |
| timeline | 2 | 14 | a six-shot timeline in Play/export; skip; the tab scrubs; a key drag is one command | logic | ✓ `rt/timeline`<br>✓ `ti/timeline/determinism`<br>✓ `cmd/timeline-ops` | — |  |
| trusted-network | 2 | 6 | a trusted network never asks for the token; a trusted proxy's forwarded client decides | logic | ✓ `be/trusted` | — |  |
| ui-bindable-size | 1 | 5 | a bound size and start angle in the UI editor and Play | logic | ✓ `pm/ui-documents`<br>✓ `gh/ui-layer` | — |  |
| ui-editor | 2 | 11 | UI document editor: build a HUD, drag, anchor, theme, undo; a button reloads a scene | logic + looks | ✓ `ed/session/ui-edit`<br>✓ `cmd/ui-ops`<br>✓ `rt/scene-reload` | E10 |  |
| ui-lists-motion | 1 | 8 | bound offset, opacity, rotation; a list keeps items and focus | logic | ✓ `gh/ui-layer`<br>✓ `rt/ui` | — |  |
| ui-sounds-shell-shot | 3 | 12 | UI sounds on the ui bus; a screenshot with or without UI; a shell title with simulate: scripts | logic | ✓ `gh/shell`<br>✓ `gh/audio-buses`<br>→ `ed/preview/screenshot-answer` (pure: ui:false asks the capture without the UI layer) | — |  |
| visual-script | 2 | 18 | build On start → Add to counter; catalogue search; trigger → timer → hide, count, sound | logic | ✓ `vs/visual-script`<br>✓ `vs/catalogue`<br>✓ `be/visual-script` | — |  |
| visual-script-debug | 1 | 10 | problems, variables, breakpoints, wire values, watch, step, resume | logic | ✓ `vs/debug`<br>✓ `gh/play-debug`<br>✓ `be/visual-script-debug` | — |  |
| voxel-world RED | 5 | 379 | assembly proof; streams/draws/edits through commands; Play 8 km world, dig, save; light volume; Scene view; export (D798/D799/D817/D824) | logic + looks + boot | ✓ `vb/edits`<br>✓ `vb/collision`<br>✓ `vb/world-host`<br>✓ `vb/stream`<br>✓ `ti/voxel-world/voxel-world`<br>✓ `ta/voxel-light-volume-*`<br>✓ `ws/voxel-worlds`<br>→ `vb/world-host` (Node, real workers: a runtime set/dig across chunk faces turns a banister into a wall; every consumer follows. Unless 47T.3 finds world-host's "changes a world" is already that case) | L1–L22, E5, E6 | boot tests 2, 3 and 5 replace its "draws, Plays, exports" part; the light volume is judged from the pictures |
| webgpu-reference | 40 | 44 | post effects, skies, fog, tone mapping and node materials on WebGPU equal stored references (40 cases) | dropped: browser-only | — | L1, L4 | dof, fxaa, smaa, lut, grading, fog kinds, sky kinds and node-material pixels are unchecked; could stay as a bench tool (lead decides) |
| window-tools | 1 | 6 | Lighting and Environment float over the Scene view; a prefab from the selection; audio Inspector | logic + retire | ✓ `cmd/prefab-ops-v4`<br>✓ `cmd/scene-environment` | E1 | the block layer Inspector part retires |

## 2. Helper modules in `tests/e2e`

Importers found by grep over `tests`, `packages`, `tools` and the configs (for each helper: other e2e files aside).

| Helper | Imported outside the e2e specs by | Fate |
|---|---|---|
| pw.ts | — (every spec) | stays: the boot check's fixture |
| backend.ts | `tests/support/backend-process.ts`, `tests/support/commands.ts` (used by the vitest `tests/test-support.test.ts`) | stays (boot check and tests/support) |
| ui.ts | — | stays for the boot check (trim to what it uses) |
| console-errors.ts | — | stays: the boot check's "nothing errors" |
| browser-env.mjs, browser-env.d.mts | `playwright.config.mts`, `tools/gate.sh`, `tools/perf/browser.ts`, `tools/perf/frame-run.ts`, `tools/perf/opus-pool.mjs`, `tools/bench-graph-render.mjs`, `tools/icons/pack-editor-icons.mjs` | stays (config, gate, bench tools) |
| global-setup.ts | `playwright.config.mts` | stays |
| package.json | — (`type: module` for the folder) | stays |
| png.ts | `tools/voxel-bench/light-shots-cli.ts`, `coverage-cli.ts`, `lighting-cameras.ts` (type) | stays: the picture command reads it (a later move to tools is cleaner) |
| png-make.ts | `tests/integration/m30-terrain/terrain-http.test.ts`, `tools/perf/{assets,level,level-run,level-walls,scale-generate,scale-media,trim-run}.ts` | stays (bench and a vitest) |
| multi-piece-glb.ts | `tools/perf/{build,generate,meadow-run}.ts` | stays (bench) |
| socket-glb.ts | `tests/integration/sockets/{determinism,rig-parity}.test.ts`, `tests/integration/m25-callbacks/callbacks.test.ts` | stays (vitest) |
| view-match.ts | `tools/voxel-bench/cull-page-cli.ts` | stays (bench) |
| webp-make.ts | `tools/perf/scale-generate.ts` | stays (bench) |
| trim-strips.ts | `tools/perf/trim-run.ts` (a retiring system's perf tool) | stays while trim-run does; goes with it |
| rooms-drawing.ts | `tools/check-redefinitions.test.mjs` names its path in a list of retired files (a string, not an import) | archive with layered-material/projects; check that test still passes |
| skinned-glb.ts | — | archive (animator, inspector, project-items, memory) |
| parity.ts | — | archive (rendering, shadows, lightmaps, effects-gpu, material-graph-render, webgpu-reference, batch-dispose) |
| renderer-variants.ts | — | archive (WebGL 2/WebGPU variants) |
| frame-reading.ts, painted-layers.ts, terrain-cdlod-steps.ts, vertex-paint-drive.ts, texture-settle.ts | — | archive (retiring terrain and level files) |
| buildings.ts, floor-plans.ts, layered-walls-scene.ts, projected-decals-scene.ts, rooms-lighting.ts | — | archive with layered-material.e2e.ts (generated architecture) |
| memory-probe.ts | — | archive with memory.e2e.ts (or a bench tool with it) |
| voxel-shadows.ts, voxel-liquid.ts, voxel-play-script.ts | — | archive with voxel-world.e2e.ts |
| voxel-grid-house.ts, voxel-scene-structures.ts | — | archive, unless boot test 2 builds its world with them (it should load a cached world instead) |
| effects-gpu/harness.ts, material-graph-render/harness.ts | `tools/gate-areas.json` (paths) | archive with their specs; drop the gate-areas entries in 47T.1 |
| webgpu-reference/ (env, shader reference images, 408 KB) | `tools/gate-areas.json` | archive with its spec (or keep for a bench tool) |

## 3. The boot check

One new file (`tests/e2e/boot.e2e.ts`), one backend, written fresh (not carved from an old story). Each test passes on "it starts and nothing errors" only: no pixel bound, no timing bound beyond a generous start timeout. "No error" = no console error, no page error, no failed request, no Problems entry the test did not cause (the console-errors.ts listener).

| # | Test | Pass | Fail | Replaces |
|---|---|---|---|---|
| 1 | **The editor loads.** Open the editor URL with the token, pick the starter project in the picker, the editor shows its Scene view, Hierarchy and Inspector. | the editor page is up and the Scene view has drawn one frame (its frame counter moved) | any console/page error or failed request; the picker or the editor never shows | authoring-loop (open), projects (picker), layout |
| 2 | **A voxel world draws a frame.** Open a project whose scene holds a voxelWorld object over a small cached world (from 47T.2's cache, not generated by the test). | the Scene view reports voxel chunks drawn (> 0) and a frame presented | an error; no chunk drawn | voxel-world (Scene view part) |
| 3 | **Play starts and stops.** On the same project: Play; the Game view presents a frame from the simulation worker; Stop; the editor is back. | a presented frame in Play, then a clean stop (the play ended answer) | an error; Play never presents; stop never answers | play-export (Play), sim-worker, voxel-world (Play) |
| 4 | **An agent plays with no editor open.** Through the MCP adapter (stdio, real client): `tl_play_start` with no editor page open starts the headless editor; `tl_game_observe` answers; `tl_screenshot` returns an image; `tl_play_stop`. | each tool answers ok and the screenshot is a decodable PNG | an error answer; the headless editor never starts | mcp-headless, mcp (Play part), playtest, screenshot |
| 5 | **An export runs on its own.** Export the same project, stop the backend, serve the export folder statically, open it. | the exported game presents a frame with the backend stopped | an error; a request to the backend; no frame | play-export (export), voxel-world (export), insecure-context |

**Why the MCP headless play is a boot test (test 4; the export runs last, test 5, since it stops the backend).** Agents build and test this engine through MCP; the headless editor is the one browser path nothing else in the boot check starts, and a break there stops every agent session at once. The alternative considered, the one-command start (`tools/start.mjs`), needs no browser past opening its URL and becomes a Node test instead (→ `tools/start.test.mjs`).

## 4. The slow unit files

Every unit file at 10 s or more in the last whole-suite run (6 workers, under gate load). "Cache serves it": a disk cache outside the repo keyed by the generator's version and parameters (47T.2) holds the generated world (chunks or region files); "partly" means the world comes from the cache but the derive the test proves still runs (the oracle side, a fresh full derive, may be cached too when keyed by the deriver's source digest as well). "Run": where it belongs after caching: `check` (fast, small made case), `phase` (real scale), or split. Not measured here: how much of each file's time is world fill (the generators fill chunks lazily, `tools/voxel-bench/worlds.ts`) and how much is the derive; 47T.2 should time one fill per world before building the cache.

| File | s | Tests | World / fixture | Cache serves it | Run | Proposed split |
|---|---|---|---|---|---|---|
| `tools/voxel-bench/far-world.test.ts` | 211 | 9 | the 0.5 km far world (farLandscape, seed 97 realistic + a 2 km other seed + terraced) written as region columns by workers; its far cache built in workers and one thread; bricks baked; meshes selected from the cache | partly: the written world and a reference far cache, keyed by far-world generator + sizeKm + seed + far-cache format | phase | check: one region column pair meeting cell for cell, and one node rebuilt over an edit; phase: workers-equal-one-thread over the whole world (34 s), ancestors of an edit (42 s), mesh selection from disk (71 s) |
| `tools/voxel-bench/stream-levels.test.ts` | 182 | 7 | the hilly world 512 m square (stream-fixture HALF 256) as region files on disk; real worker pools; rings of 32–384 m; a 0.5 m baked fine-far world | partly: the region files (generator + footprint) and the baked far levels; the derives in workers are the subject | phase | check: none of its 7 tests is small (9–56 s each); a 64 m world case per rule becomes the check part |
| `tools/voxel-bench/derived.test.ts` | 180 | 40 | hillyWorld footprint 96 and 256, townWorld; full derives (mesh, collision, nav, light, occupancy, regions) compared with fresh derives | partly: the generated chunks, and the fresh-derive oracle keyed by generator + deriver source digest | check + phase | check: the 33 tests under 4 s; phase: the 7 over 4 s (random edits near borders 21 s, section joins 27 s, forms 28 s, level seams 16 s ×2) |
| `tools/voxel-bench/stream-speed.test.ts` | 124 | 4 | the hilly world 1024 m square (HALF 512) as region files; real workers; a focus moving at 150 m/s | partly: the region files; the flight is the subject | phase | all 4 tests are flights (21–67 s) |
| `tools/voxel-bench/collision.test.ts` | 84 | 10 | townWorld, hillyWorld footprint 96 and 1024; collision derived alone vs the full derive, Rapier bodies round a moving focus | partly: the full-derive collision as the oracle (generator + deriver digest) | check + phase | phase: byte-for-byte on town + hills (42 s), hard-case drops (19 s), moving focus (12 s); check: the rest |
| `tools/voxel-bench/stream.test.ts` | 65 | 22 | the hilly world 512 m (stream-fixture) as region files; bundled worker; real workers and Rapier | yes for the region files (written once in beforeAll today) | check + phase | phase: real-worker section derives (13 s), the overlay read-through (13 s), refresh (7 s); check: the other 19 |
| `tools/voxel-bench/level-materials.test.ts` | 63 | 2 | hillyWorld footprint 1024 (the slice hills) and the hard cases at levels 1 and 2 | partly: the level-0 reference per case | phase | both tests are real scale (18 s, 45 s); a single hard case becomes the check |
| `tools/voxel-bench/mesh-cases.test.ts` | 63 | 25 | townWorld, hillyWorld footprint 512; marching cubes vs the terrain mesher on the hard cases | partly: the bench mesher output as the oracle | check + phase | phase: every hard case watertight (15 s), level seams (12 s), lattice (7 s ×2); check: the other 21 |
| `tools/voxel-bench/liquid.test.ts` | 60 | 14 | hillyWorld (lakes) and cavesWorld footprint 256 (pools); every consumer derived with and without the liquid | partly: the derive without liquid as the oracle | check + phase | phase: the lakes-and-pools equality (49 s); check: the other 13 |
| `packages/three-adapter/src/voxel-light-volume-glow.test.ts` | 49 | 16 | made closed boxes (white furnace, a glowing patch); no generated world | no: the time is rays (44 s in one test) | check + phase | phase: the every-wall-emitter furnace (44 s); check: the other 15; or fewer rays at a looser closed-form tolerance (lead) |
| `tools/voxel-bench/roof-mesher.test.ts` | 40 | 23 | made houses (putVoxel) with gable, hip and L roofs at levels 0–2 | no (small made cases; the time is the mesher at three levels) | check + phase | phase: the walled-house roofs at levels 1 and 2 (19 s); check: the other 22 |
| `packages/voxel/src/far-fine.test.ts` | 40 | 13 | made far-field blocks and chunk cells; baked entries | no (made data) | check + phase | phase: the edited-node refresh (12 s) and baked levels (10 s); check: the rest |
| `packages/voxel/src/occupancy-walk.test.ts` | 35 | 8 | derived occupancy of made chunks; rays against a reference walk | no (the time is the reference walk over every ray, 23 s) | check + phase | check: fewer rays (one seed); phase: the full ray set |
| `tools/typecheck.test.mjs` | 33 | 39 | no world: runs the real tsc over fixture configs (39 tests) | no (tsc runs); a build-info cache may help | phase | the build already type-checks the repo; this file proves the checker refuses loosened configs: phase only |
| `packages/voxel/src/walk-graph.test.ts` | 33 | 15 | a made world store; brute-force cheapest cost over every cell vs one A* | no (the brute force is the time, 23 s) | check + phase | check: the rest; phase: the brute force (or a smaller grid in the check) |
| `packages/workspace/src/voxel-far-fine.test.ts` | 31 | 6 | voxel worlds written at 1 m and 0.5 m bake levels; fine levels baked, resumed, rebuilt over an edit | partly: the written worlds (generator + bake level) | check + phase | phase: the 0.5 m bake (8 s) and edit rebuild (10 s) |
| `tools/voxel-bench/kit-pieces.test.ts` | 30 | 6 | townWorld / townStore with a kit | partly: the town store | check + phase | phase: paints within one kit (21 s) |
| `tools/voxel-bench/structure-grid.test.ts` | 29 | 4 | townWorld with houseGrid(townHouses) as structure grids, region files on disk | partly: the town and its region files | check + phase | phase: the shared pool across a tier change (24 s) |
| `packages/voxel/src/open-regions.test.ts` | 28 | 23 | made dense chunks in permuted arrival orders | no | check | every test under 7 s; keep whole in the check or trim permutations |
| `tools/check-size.test.mjs` | 27 | 9 | no world: scans the repository's own sources | no | phase | 'the repository's own list matches its sources' (19 s) repeats what npm run build checks: phase only (or dropped, lead) |
| `tools/voxel-bench/world-host.test.ts` | 23 | 11 | hillyWorld written as region files; bundled and node-pool workers; ctx.voxels in the runtime | yes for the region files | check + phase | phase: setRings re-plan (7 s); check: the rest |
| `packages/three-adapter/src/voxel-light-volume-layout.test.ts` | 23 | 26 | made town cells (townCell); cell-by-cell references | no | check | no test over 8 s; keep in the check |
| `tools/voxel-bench/relief.test.ts` | 22 | 3 | townWorld, hillyWorld footprint 96, cavesWorld footprint 128; relief n = 2, 4, 8 | partly: the plain derive as oracle | check + phase | phase: crack-free for n = 2, 4, 8 (16 s) |
| `packages/three-adapter/src/surface-probes.test.ts` | 18 | 14 | made rooms for the phase-42 surface probes (old probe lighting) | no | retiring system | the system retires in 48: archive with 47T.3 or keep until 48 (lead decides) |
| `packages/three-adapter/src/surface-bake.test.ts` | 18 | 6 | made tiles, PNG pages and probes of the phase-42 surface bake | no | retiring system | as above |
| `packages/three-adapter/src/voxel-light-volume-reference.test.ts` | 17 | 7 | made white-furnace boxes; reference bounces | no (rays) | check + phase | phase: the furnace convergence (11 s) |
| `tools/voxel-bench/relief-ring.test.ts` | 16 | 3 | townWorld; relief on a ring | partly: the town | check + phase | phase: the ring derive (8 s) |
| `tools/check-boundaries.test.mjs` | 15 | 89 | no world: 89 fixture cases of the boundary checker | no | check | no test over 4 s; it guards the build rule |
| `packages/voxel/src/walk-graph-links.test.ts` | 15 | 9 | a made world store with grid frames and props | no | check | no test over 4 s |
| `tools/voxel-bench/edits.test.ts` | 15 | 13 | townWorld / townStore; edits on the palette store and the dense oracle | partly: the town store | check | no test over 4 s |
| `packages/backend/src/play.test.ts` | 14 | 29 | no world: about 30 real backends started (timeouts per test) | no; the time is backend starts | check | share one backend where the timeouts allow (47T.2 option) |
| `tools/voxel-bench/kit-cases.test.ts` | 14 | 5 | townWorld; cases of every detail-bearing cell | partly: the town | check + phase | phase: the every-cell case pass (11 s) |
| `tests/integration/voxel-world/voxel-world.test.ts` | 14 | 15 | flat ground + wall/beam/banister scenes over a real backend and MCP; an export | no (small made scenes) | check | the export case is 7 s; keep |
| `packages/backend/src/far-cache-runner.test.ts` | 13 | 4 | a small far world built and baked on the runner's threads | partly | check | no test over 6 s |
| `packages/three-adapter/src/block-mesh-worker.test.ts` | 13 | 16 | block layers (retiring system) | no | retiring system | retires in 48 (lead decides) |
| `tools/voxel-bench/case-forms.test.ts` | 13 | 3 | townWorld, scenes and random worlds at levels 0–2 | partly: the town | check + phase | phase: the form pass (9 s) |
| `tests/integration/m42-bake/bake-lighting.test.ts` | 12 | 4 | the phase-42 lighting bake through the editor and export (old probe lighting) | no | retiring system | retires in 48 (lead decides) |
| `packages/three-adapter/src/voxel-light-volume-rooms.test.ts` | 12 | 8 | made rooms and turned walls | no | check | no test over 4 s |
| `packages/voxel/src/structures/spline-writer.test.ts` | 10 | 10 | made flat ground; a spline road | no | check | one 7 s test (rewrite equals fresh) |
| `tests/integration/voxel-world/voxel-structures.test.ts` | 10 | 16 | made structures over a real backend | no | check | one 8 s test (far rebuild after undo/redo) |
| `packages/backend/src/fbx.test.ts` | 10 | 5 | no world: headless Blender converts FBX files | no | phase | Blender start-up is the time; skipIf no Blender |
| `packages/commands/src/create.test.ts` | 10 | 22 | no world: a scene grown to its memory budget | no | check | the budget test is 9 s: a smaller budget constant in the test is not allowed (one definition); keep |
| `tools/voxel-bench/walk-feed.test.ts` | 10 | 1 | the stream-fixture hilly world as region files | yes for the region files | check | one 10 s test |

Sum of the 43 rows: 1743 s. The tests over 4 s inside these files (106 of them) are in `~/.cache/thirdlight-phase47t/work/47T.0/slow-tests.tsv`.

Generators in use: `hillyWorld` (footprints 96, 256, 512, 1024), `cavesWorld` (128, 256), `townWorld`/`townStore`/`townHouses` (the town), the far world (`farLandscape`, `writeFarWorld`, 0.5 km and 2 km), and the stream fixture (`stream-fixture.ts`: hillyWorld 512 m written as region files in `beforeAll`, shared by stream, stream-levels, walk-feed). Several files write region files under `tmpdir()` (16 test files in tools/voxel-bench call it; the gate points TMPDIR at `~/.cache`).

## 5. The picture set (draft for 47T.4)

World pictures: the bench's own cameras (`tools/voxel-bench/lighting-cameras.ts`, taken by `node tools/voxel-bench/run.mjs light-shots`, `light-shots-cli.ts`) on the 8 km far world of `run.mjs far-world` in project voxel-slice, at the low tier, settled, with the speck count and the frame profile beside each. The bench has 28 cameras; the set takes 22 and leaves out the six `LIGHT_CHECK_CAMERAS` that exist to be compared in pairs (far-lamp-a/b, far-view-1m, street-noon-1m/2m, room-window-2m).

| Id | Camera (bench name) | Shows |
|---|---|---|
| L1 | `street-noon` | the street between two house rows at noon |
| L2 | `room-window` | inside the centre house, its west wall and window |
| L3 | `cave` | the cave from 22 m in |
| L4 | `night-lamps` | the street at night, five warm lamps |
| L5 | `far-view` | from over the town's east edge across to the west (far field) |
| L6 | `lamps-street` | a street at night lit by many lamps |
| L7 | `lamps-room` | the room at night by its room lamp |
| L8 | `lamps-high` | the many-lamps town from 45 m up |
| L9 | `props-cart` | the lit cart by the third street lamp at night |
| L10 | `props-table` | the table under the room camera's window at noon |
| L11 | `house-60m` | a house front 60 m away from 40 m up (light through windows) |
| L12 | `house-above` | the room camera's house from 18 m over (see-through, cut-away) |
| L13 | `lroom-above` | the floating L-shaped room from above |
| L14 | `town-100m` | the town's middle from 100 m (mesh rings) |
| L15 | `town-150m` | from 150 m |
| L16 | `town-250m` | from 250 m (far bricks) |
| L17 | `town-600m` | from 600 m |
| L18 | `town-2km` | from 2 km |
| L19 | `ref-30m` | the reference house at 30 m |
| L20 | `ref-60m` | at 60 m |
| L21 | `ref-100m` | at 100 m |
| L22 | `ref-150m` | at 150 m |

Editor screens: new, one command to open each on the same cached world and settle it (47T.4 builds the command; none exists today).

| Id | Screen | Stands in for |
|---|---|---|
| E1 | the default editor view on the voxel project: Scene and Game views, Hierarchy, Inspector, Project dock; a selection with its gizmo, placeholder icons, Gizmos on | authoring-loop, layout, gizmos, placeholders, editor-chrome, project-items, window-tools |
| E2 | structure mode: a two-storey house drawn, its edge handles, an opening's ghost on a wall | structure-mode (structures, openings) |
| E3 | a water body: a lake in a dug hollow, selected, its level handle; a breach marker | structure-mode (water bodies) |
| E4 | a spline road selected in the Inspector: its points and the road written in voxels | structure-mode (splines), handles |
| E5 | the voxel world page (the voxelWorld item: far field, bake level, its files) | voxel-world (Scene view part) |
| E6 | Play in the Game view on the voxel world: the character standing, the Profiler open | voxel-world (Play), engine-stats, animator-skinned |
| E7 | the editor window: a material graph tab, its preview sphere, the Problems tab | material-graph, material-preview, material-graph-play, graph, editor-window |
| E8 | the Effect tab: a burst effect mid-scrub (particles drawn on WebGPU) | effect-editor, effects-runtime, effects-gpu |
| E9 | the Animator tab: a controller graph and the skinned preview posed | animator, animator-layers |
| E10 | the UI document editor: a HUD with an anchored bar and the widget inspector | ui-editor |

32 pictures. To reach the plan's "about 30", L19–L22 (the reference distances) can go first. Looks that no picture shows (unchecked after 47T.3): vignette and the fog volume, spot cookies, texture skies, depth-buffer modes and decal z-fighting, foliage wind and bending, post effects other than tone mapping and bloom (dof, fxaa, smaa, lut, grading), the drawn letterbox.

