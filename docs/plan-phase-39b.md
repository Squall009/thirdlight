# Phase 39b — Consolidation

Status: planned 2026-10-21.

Goal: make the engine cheaper to change before the two big rebuilds
(phase 40, ground cover and placement; phase 41, one physics backend). The
phase breaks up the large units every feature lands in, brings the test gate
back inside its budget, gives the defect list a real status, and applies the
owner's decisions on the backlog of defaults. **No behaviour changes**, except
where the owner's decision session reverses a default.

Source: the maintainability assessment of 2026-10-21 (HEAD `5dc0c4ca`; the
findings are summarised in §2). The owner approved a consolidation phase
between 39 and 40.

## 1. Owner decisions (2026-10-21)

- A consolidation phase runs between 39 and 40.
- The owner goes through one batched decision list (the defaults logged as
  "owner to confirm" in the plans since phase 17) and does one owner look
  across the phases marked "owner look pending". The outcomes are applied in
  this phase (39b.6).

## 2. Where things stand (assessment, 2026-10-21)

- **Package layering is clean and machine-checked.** 17 packages, a DAG, no
  boundary violations. The value-subpath exceptions grew one at a time:
  backend → project-model went from 4 to 10.
- **Large units under the 2,000-line file rule.** The rule caps files, not
  units:
  - `RuntimeInstance` (`runtime/src/runtime.ts`): 3,633 lines, 330 members;
  - `createSceneAdapter` (`three-adapter`): 1,793 lines;
  - `createBackend`: 1,708 lines;
  - `EditorApp`: 1,297 lines;
  - `GraphEditor`: 1,231 lines;
  - `attachBrowserInput`: 1,099 lines;
  - `Viewport`: 188 members;
  - `SessionClientCore`: 159 members.
  
  Over the file rule: `runtime.ts` (3,988 lines) and `asset-pipeline/src/
  inspect.ts` (2,876). Eleven more files are between 1,800 and 1,999 lines.
- **The full gate runs 26–31 min** against its 15 min budget (D253). 22 D-rows
  are flaky-test "watch" rows.
- **The defect list has no status column.** About 106 rows look open (1 H,
  23 M, 82 L by a text heuristic).
- **About 209 defaults are open "owner to confirm"** (74 decision-log entries; split per decision, plus audit questions: `~/.cache/thirdlight-owner-review/decisions-2026-10-21.md`); 4 were ever confirmed. 24
  phases are marked "owner look pending".
- **Logic kept in two places:**
  - 19 parity-test files guard pairs (editor vs runtime, CPU vs GPU, graph vs
    compiled);
  - project formats v2–v6 still have types and upgrade code;
  - `package.json` descriptions in 14 packages carry phase history and are
    stale.
- **Copied tolerances:** `1e-6` appears 159 times in 81 files; `0.001` 73
  times.

## 3. Items

**Rule for every item:** behaviour-preserving. Each split keeps the public
surface its callers use, moves one subsystem at a time behind a small
interface, and is proven by the existing tests (unchanged) plus the perf
classes at the cap (no regression). Splits that change no behaviour need no
new e2e.

| Item | What |
|---|---|
| 39b.0 | **Release checks.** Record the starting numbers: the unit-size list, gate time per file (the slowest 30 e2e files), the open D-rows, and the perf classes at the 60 Hz cap on both renderers. |
| 39b.1 | **A unit-size rule, checked at build.** `tools/check-size.mjs` in `npm run build`: no function or closure over 400 lines and no class over 80 members, alongside the 2,000-line file rule. A ratchet list names today's offenders with their current size; an entry may only shrink and is removed when it fits. AGENTS.md states the rule. |
| 39b.2 | **Split `RuntimeInstance`** into subsystem modules behind interfaces (scene set, entities and access, physics bridge, behaviours and hooks, audio, camera, UI, saves, streaming, diagnostics; the boundaries are chosen from the code). `RuntimeInstance` becomes a composition root. `runtime.ts` falls under 2,000 lines. |
| 39b.3 | **Split `createSceneAdapter`** (three-adapter) and **`createBackend`** (backend) the same way: per-subsystem modules wired by a thin root. |
| 39b.4 | **Split the editor's large units:** `EditorApp`, `Viewport`, `SessionClientCore`, `GraphEditor` and `attachBrowserInput`, each into per-area modules or hooks. `asset-pipeline/src/inspect.ts` is split per asset kind. |
| 39b.5 | **A lean test gate.** Fix or delete each of the 22 watch tests: fixed if it guards something real, deleted with a note if it duplicates another test. Merge and prune e2e files that duplicate coverage (one backend per file; browser-free checks move to vitest). There is no fixed time budget (owner, 2026-10-21): the gate must not grow without need, and each phase records its time against the previous one (D253 closed). |
| 39b.6 | **Apply the owner's decisions.** Every default from the decision list is marked confirmed or reversed in its plan. Reversals are implemented as items here (or moved to the phase that owns the area, if larger). The phases the owner has looked at are marked done without "owner look pending". |
| 39b.6b | **Reversals from the decision session (owner, 2026-10-21):**<br>• **Trim sheets draw at their own colour.** A material's tint is a visible field, white by default; nothing inherits the generator's grey stand-in (`#9a968c`, P35-12; owner confirmed).<br>• **An undo refused for a revision conflict is not resent** (D281): the user presses Ctrl+Z again.<br>• **JSON-shaped fields are editable in the Inspector** as structured fields (block-type Looks, Layer size and the rest; P31-3, D227).<br>• **`FLOOR_PLAN_COUNT_MAX` is removed** (no cap on rooms of a type per storey or copies of a prop per room; D218).<br>• **The 3D starter's character is game-ready:** a Blender character with LODs, `_COL` and a report (triangles per LOD, texture sizes, file size) replaces the 48-triangle placeholder (D272).<br>• **GPU effects cost no main thread per instance:** find why GPU-simulated systems cost main-thread time (one compute pass per effect instance: 15 fires gave 31 passes and 0.69 ms) and batch every instance of a system into one dispatch, so small systems no longer need to move to the CPU (P29-6); the `GPU_MIN_PARTICLES` rule is then re-measured and dropped if it no longer pays.<br>• **Selecting buildings only with no tool** (P37-12): in the level editors a click selects a building only in Navigate (no tool active; the first Esc drops the tool). A double-click enters the building (the room under the pointer). No tool selects on a click any more, Rect included: every tool click is the tool's.<br>• **No count of block layers per scene** (P30-3): the 16-layer limit goes; memory is shown and budgeted as for cells.<br>• **No count of objects per scene** (P26-3): the 16,384-entities-per-scene limit becomes a memory budget, shown like the others.<br>• **Every new project has a sky** (P36-11, P34-9): the 2D starter and the empty project get the physical sky (sun and atmosphere) like the 3D starter; the pixel baselines that change are re-recorded once.<br>• **The project window stays usable in edit modes** (P34-6): assets can be dragged in from it while a block, terrain, decal or vertex-paint editor is open.<br>• **`tl_docs` works without an open project** (P31-9), so an agent can read the docs before it picks a project.<br>• **An owner review page** for the look items (H): `review.html` on the owner review server shows each pending look (kit preview walls, pale-layer tiling, L/T/U roof overlap, the macro switch line, the yard light leak) as a captioned before/after or close-up screenshot, so the owner can judge them in one pass.<br>• **Per-vertex local lighting is removed** (P29-5): it was not cheaper (2.718 vs 2.705 ms) and costs extra shader variants. The `localLights` pixel/vertex/none setting keeps pixel and none; stored `vertex` values upgrade to pixel, with a Problems line.<br>• **Async hooks / late `ctx`:** the Problems line carries the fix ("keep work for later in `state` and act on it in a later step"). |
| 39b.6c | **The layered surface treats trim sheets as just another layer** (owner, 2026-10-21; P35-4, P35-13):<br>• Any of the 4 layers can be a trim sheet or a tiling texture; each has its own UV source (trim = the mesh's UVs; tiling = top/world/biplanar). Vertex colour: base = 1 − (R+G+B), R/G/B = layers 2–4, **A = wetness over every layer**: the same model as terrain, with different UV mapping.<br>• **No built-in grime.** The `grime` output, `grimeColor` and the trim-data grime channel go; grime is a painted layer like any other. Stored materials that used grime are migrated (their grime becomes nothing, with a Problems line naming the material, or a painted layer where the data allows it — decided in the item).<br>• **Generator and kit data:** generated architecture's trim data keeps baked occlusion (its own attribute, R), its wetness becomes the A channel, and its G (grime) channel is dropped. Kit models whose COLOR_0 holds the old trim convention (R occlusion, G grime, B wet) are converted at import or upgrade, so COLOR_0 always means layer weights + wetness.<br>• **Known constraint, documented:** trim sheets blended on one mesh share that mesh's trim UVs, so they must share one row layout (e.g. a clean and a worn version of the same sheet). Sheets with different layouts are refused in one material with a clear message, as today.<br>• **Terrain parity (optional, measured):** terrain gets the same wetness channel if its storage and cost allow; otherwise it stays parameter + scene wetness and the item says so. |
| 39b.6d | **Furnished rooms without a building** (owner, 2026-10-22; P30-21): today only a *building* has a furnishing set; a room drawn on its own (an interior-only scene) has a room type but nothing furnishes it. Rooms drawn with Rect or Polygon get the same as building rooms: pick a style (preset) and a room type, and a furnishing set fills it at load. The set comes from the room, else the rooms object, else the layer. The engine ships neutral starter furnishing sets and room programs beside its starter presets, so it works out of the box. Pins, Lock and Detach (which exist) cover set dressing: move a few things, pin them, and the rest stays generated. Acceptance: an interior-only scene where three drawn rooms of different types furnish themselves, and a pinned, moved prop survives a regenerate. |
| 39b.6e | **See-through fades only true occluders** (owner, 2026-10-23; Temporal G11): under a pitched follow camera the view-depth plane test (`fadeSteps`, `mayFade` in `three-adapter/src/see-through.ts`) fades walls *behind* the subject. Owner's design (no plane fix, no x-ray): the CPU finds true occluders per subject per frame (skipped when camera and subject are still) in the volume from the camera to the subject's capsule widened by a padding and ending at the body — block layers by ~12–20 rays through the layer grid, hit cells grouped into whole pieces (wall run, pillar, slab); placed models by bounds (members' own bounds for merged and instanced draws). The shader gets a fixed-size per-subject list of occluder boxes (constant defined once beside `SEE_THROUGH_SUBJECTS`; overflow merges nearby boxes, never drops one); a pixel fades only inside a box (cut-away cell rule: point nudged ¼ cell against its normal), each draw tests only its overlapping boxes (bit mask); no batch splits, no vertex attributes, no extra pass, no new programs during play. Guard: a pixel must also be nearer than the body along its own ray (`depthMargin` = metres nearer along that ray); the half-height rule stays. Per-occluder fade in/out over the fade time. **New setting:** occluder padding (default 0.3 m) beside the other six (project setting, `ctx.camera.setSeeThrough`, graph node, editor preview, manual, typings). Tests in `see-through.test.ts` with a 52° camera (walls 0.3 m and 1 m behind never fade; side wall beside the subject no fade; wall in front over the waist fades; L-shaped piece keeps its arm behind; straight-down camera; floor; padding changes selection; overflow never drops an occluder; CPU reference and per-draw test agree), one existing e2e extended. Perf before/after with `tools/perf/see-through-run.ts` (interior `--storeys 2` and village, 4 subjects, at the cap, both renderers) against D297. Temporal is told through the engine's answer that its margin can go back to 0.25 (its repo is not edited). Owner look pending in Temporal. |
| 39b.6f | **Prefabs keep every model field** (Temporal G12): `createPrefab` / `updatePrefab` store the model as `{asset}` only, so `seeThrough: false` (and any other stored model field) is lost on every placed copy. They keep the whole stored component; a vitest over HTTP. (39c rebuilds prefabs as linked assets; this is the small fix until then.) |
| 39b.7 | **The defect list gets a status column** (open / fixed `<commit>` / superseded / won't fix). Every row is classified; fixed and stale rows are closed with evidence; duplicates are merged. STATUS.md shows the open counts. |
| 39b.8 | **Old formats out.** Drop types and upgrade code for project formats older than the oldest version a supported project can still be on (default: older than schema 6 — every template and game repo is at 7). An older project is refused with a clear message naming the last engine version that upgrades it. Owner confirmed 2026-10-22. |
| 39b.9 | **Two-place logic shared where possible.** For each of the 19 parity pairs, either one implementation serves both sides (shared module) and the parity test goes, or the reason it can't (CPU reference for a GPU shader, for example) is written next to the pair. |
| 39b.10 | **Small hygiene:** `package.json` descriptions say what each package is today (no history); the boundary exceptions are reviewed (each one justified or removed); the repeated tolerances become named constants in their owners; the Inspector's hand-built panels that duplicate descriptor fields move to descriptors (the rest are declared exceptions). |
| 39b.10b | **Occlusion culling (owner, 2026-10-21):** it stays off by default, since it made too little difference to matter. The WebGL 2 occlusion-query path is removed (about 700 lines and 4 private three.js hooks; D287). The WebGPU path stays opt-in (`occlusion_culling: 2`) for a later performance pass (D282, D286). |
| 39b.11 | **Acceptance:** the size rule passes with the ratchet list shorter; `runtime.ts` and `inspect.ts` are under 2,000 lines; the full gate is green and shorter than at the phase start; no perf class regresses at the cap; the open D-row count is known. Then the phase review. |
| 39b.12 | **Review fixes.** |

**Done when:**
- No unit grows past the size rule, and the ratchet list only shrinks.
- The runtime, adapter, backend and editor roots are composition roots.
- The full gate is green, with no duplicated coverage and no watch tests left.
- The defect list has a status for every row.
- Every logged default is confirmed or reversed.

## 4. Progress

| Item | Status |
|---|---|
| 39b.0 | Done 2026-10-22: three.js 0.186.1 still latest; Rapier 0.21.0 (minor) stays planned for 41. Start numbers at 28701f1d (`node tools/check-size.mjs --near`): 50 units over the limits (2 files: `runtime.ts` 3,988, `inspect.ts` 2,876; 39 functions, largest `createSceneAdapter` 1,802, `createBackend` 1,709, `EditorApp` 1,307; 9 classes, `RuntimeInstance` 330, `Viewport` 190, `SessionClientCore` 159 members) and 12 files at 1,800–1,999 lines. Phase 39 full gate: 27 min, e2e 22.1 min wall (43.4 min summed over 182 files; the slowest 30 are 21.8 min: terrain-cdlod 204 s, rendering 129 s, layered-material 117 s, memory 115 s, lightmaps 56 s …). D-rows: 299, ~139 open by text heuristic (C 8, H 13, M 31, L 87; 22 watch). At the 60 Hz cap (`--vsync`) village export, its Scene view and the level area/landscape/interior classes: p95 16.7–16.8 ms, 0 missed frames on both renderers; main thread 2.4–4.6 ms (Scene view 8.3/8.7), WebGPU GPU 9.2–9.9 ms; the fast gate's village check (its own uncapped frame check) p50 5.7 / 4.7 ms (WebGPU / WebGL 2). Full lists: `~/.cache/thirdlight-phase39b/baseline.md`. |
| 39b.1 | Done 2026-10-22: `tools/check-size.mjs` runs in `npm run build` (after the history check, ~2.5 s): functions/closures ≤ 400 lines, classes ≤ 80 members, files ≤ 2,000 lines, spans from the TypeScript parser. `tools/size-ratchet.json` lists the 50 units over today (2 files, 39 functions, 9 classes); a new or grown unit fails, a shrunk one fails until recorded (`--update`, which only lowers and drops), a fitting or vanished one fails until removed. `tools/check-size.test.mjs` (9 tests, ~13 s) drives the tool on workspaces on disk and checks the repo's own list. AGENTS.md states the rule. No e2e touched. |
| 39b.2 | Done 2026-10-22 (e4c6f99a … 04c0915f, 7 commits): `RuntimeInstance` is a composition root over `RuntimeSim` (shared step state), `RuntimeFaults`, `RuntimeScenes`, `RuntimeEntities`, `RuntimePhases` + `ScriptContext`/`script-controls`, `RuntimeInput`, `RuntimeCharacters` (physics bridge), `FrameDriver` and `runtime-bindings`. `runtime.ts` 3,988 → 1,752 lines (off the ratchet), `RuntimeInstance` 330 → 147 members (ratchet; the `Runtime` interface alone is 87 of them). Tests unchanged, all vitest green; headless 2D step (sim, interleaved A/B vs 28701f1d) small 0.043–0.047 vs 0.045–0.049 ms, medium 0.109 vs 0.105–0.118, script-heavy 0.040–0.044 vs 0.042–0.044; village at the cap A/B: p95 16.7–16.8, 0 missed, main 4.96/4.54 (base) vs 4.92/4.60 ms (WebGPU/WebGL 2). No e2e touched. |
| 39b.3 (part A) | Done 2026-10-22 (20ce9cf4 … 10991896, 9 commits): `createSceneAdapter` is a composition root (228 lines; was 1,802, off the ratchet; `adapter.ts` 1,953 → 299 lines) over `AdapterEffects`, `AdapterMaterials`, `createAdapterLevel`, `AdapterEntities`, `AdapterModels`, `AdapterScenes`, `AdapterRenderer`, `AdapterEnvironment`, `AdapterFrame` (the frame's order), `adapterDiagnostics` and `createAdapterSurface` (the `SceneAdapter` object and dispose); largest new unit `createAdapterSurface` 179 lines, `AdapterFrame` 32 members. `SceneAdapter` surface unchanged, tests unchanged (three-adapter vitest 83 files/697 tests). At the cap, interleaved A/B vs 28701f1d: p95 16.7–16.8, max 16.8, 0 missed everywhere; village export main 4.82/4.93/4.59 (base) vs 5.17/4.79/4.50/4.44 ms (WebGPU), 4.67/4.45/4.26 vs 4.78/4.40/4.31/4.35 (WebGL 2), WebGPU GPU 8.9–9.4 vs 8.3–9.3; Scene view 8.0–8.8 vs 7.6–8.8 ms (one head run at 12.4/13.3, not repeated in two more); interior main 3.33/3.53 vs 3.40/2.98 (WebGPU), 2.68/2.57 vs 2.73/2.44 (WebGL 2), GPU 10.0/9.3 vs 10.0/9.4. No e2e touched (gate files rendering, block-layers, scene-view-parity, painted-terrain, env-parity, effects-runtime: 59 tests, 3.4 min, unchanged). Part B: next row. |
| 39b.3 (part B) | Done 2026-10-22 (d284bb67 … 3ffc21d7, 5 commits): `createBackend` is a composition root (321 lines; was 1,709, off the ratchet; `createBackend > dispatch` 516 → gone; `backend.ts` 1,850 → 438 lines) over `http` (answers, body, query, workspace errors), `createAuth`, `problems` (`createProblemLog`, `createProjectChecks`), `createWsChannel`, `createExternalEdits`, `createContentServices`, `makeFullState`, `makeLibraryRoutes`, `makeProjectRoutes` and `makeApiRouter` (the `/api/v1` table in its old order); largest new unit `createWsChannel` 339 lines. Routes, HTTP/WS protocol and the `Backend` surface unchanged, tests unchanged (vitest 751 files green); backend → project-model value subpaths still 10 (no new edge). Gate files start, authoring-loop, external-edit, mcp, play-export, delete-content, project-window: 36 tests, 3.0 → 3.0 min. Backend only: no A/B; the uncapped village check passed on every commit (WebGL 2 4.7–4.8 ms). `makePlayRoutes` (849) not touched. |
| 39b.4 (part A) | Done 2026-10-22 (ddea91a8, 4c706dee, fe342f01): `SessionClientCore` 159 → 72 members (off the ratchet; `client-core.ts` 1,898 → 1,092 lines) extends `SessionProjectState` (the content copy, 74) and holds `SessionSocket`, `CommandSender`, `PlayLink`, `OpenScenes`; `Viewport` 190 → 115 members (ratchet; `viewport.ts` 1,955 → 1,094) over `ViewportLook`, `ViewportBlocks`, `CameraOverlay`, `SceneQueries`, `ViewFraming`, `SelectionGizmo`, `CopySelection`, `ViewPointer`, `ViewMarks`, `ViewGround`, `SelectionOutline`, `ProbeDebugOverlay` (largest 26 members); `EditorApp` 1,307 → 25 lines (off the ratchet) over `useEditorModel` (309), `renderEditorShell` (313), `useEditorMount` (211), `useSceneViewSync`, `useSceneViewFollow`, `useEntityIndexes`. Client surface, WS frames, commands and the editor's element tree unchanged; tests unchanged, vitest 751 files green. Gates (smoke + area files): 39 tests 3.3 min, 49 in 4.3 min, 49 in 3.9 min; no e2e touched. Scene view at the cap, interleaved A/B vs 28701f1d (3 rounds): p95 16.7–16.8 both sides; main thread base 7.75–8.01 / head 7.67–8.25 ms (WebGPU), 8.12–8.40 / 8.12–8.39 (WebGL 2); a second set under host load 8.3–11.9 on both sides. Part B: next row. |
| 39b.4 (part B) | Done 2026-10-22 (dcb97624, 2943496e, 6d53c2b9): `inspect.ts` 2,876 → 532 lines (off the ratchet) runs the GLB steps over `GlbState` and six per-area modules (`inspect-glb-container/-buffers/-meshes/-materials/-animation/-scene`, 197–508 lines; proposals byte-identical on all 62 committed GLB fixtures, with and without the animated profile); `GraphEditor` 1,232 → 7 lines over `useGraphView`, `useGraphActions`, `useGraphPointer`, `useGraphKeyboard` and `renderGraphEditor` (337; same element tree, hooks in the old order); `attachBrowserInput` 1,100 → 394 over `browser-keys/-pads/-pointer/-rebind/-ui/-status` (all three off the ratchet). Tests unchanged, vitest 751 files green. Gates: asset files 35 tests 3.0 min, graph files 41 in 4.3 min (`start.e2e` failed once under host load, passed alone), input files 41 in 4.1 min; no e2e touched. The uncapped village check missed on every commit with the plain three.js page slow too (another session's Blender at ~8 cores; host state, D199/D290). Village export at the 60 Hz cap, interleaved A/B vs 28701f1d (3 rounds, host load 5–14): main thread base 5.3–9.4 / head 6.2–9.0 ms, `@thirdlight/input` 8–29 ms per 5 s profile on both sides (≈0.06 ms a frame); p95 16.7–16.8 both, a few 33 ms frames on both sides under the load. |
| 39b.5 | Done 2026-10-23 (e3ab25a7, 74365509, 95dd0d31): the 19 flaky-test watch rows resolved, none deleted (each guards something real). Product races fixed: `setSettings` was rebased as a whole document, so a setting changed before the previous one's answer arrived was refused (D162, D295; repro 1 in 12 → 0 in 24); the Material editor's slot picks dropped a held list (D219, D298); the project window kept every Escape from the editor window (D148, D171); a closing backend waited 30 s for an unanswered WS close frame, past its 10 s exit timeout (D90, `WS_CLOSE_GRACE_MS`); the preview's boot reported no load progress, and a present timeout now says how far the start got (D114, D241). Test races fixed: the dynamic-resolution readings (D201, reproduced; that part runs at a 30 fps cap now), the light-row delete loop (D200), the title hold (D184), the create answer wait (D115, D247), the CPU bound on CPU time (D229); D163 and D237 closed (fixed before, no recurrence). The village check runs at the 60 Hz cap (D194, D290): missed refreshes ≤ 10 % and main-thread CPU ≤ baseline + 60 % (baseline 5.64 / 4.90 ms WebGPU / WebGL 2, recorded at load 2–3; under another session's Blender, load 10: 6.91 / 7.23 ms, 13 of 345 refreshes missed, green), ~45 s, no plain page. `tools/gate.sh`'s full summary gives the previous green full gate's time instead of "OVER BUDGET". Duplicates deleted (test → what covers it): `lightmaps` "Bake final runs Blender Cycles…" (7.0 s) → `block-lightmaps` final bake (now also checks source, bounces and the cube's entry); `effect-editor` "edit-mode effect preview follows edits live" (3.8 s) → `effects-runtime` edit-mode test (the live colour edit folded in); `scenes` "Play: a scene transition trigger…" (3.3 s) → `scene-transition` (the relay unloads folded in); `materials`' textured box → `textures` (every backend). `terrain-cdlod`'s fixed walk waits are polls (a relay answers once its frames ran). E2E per file, phase 39 full gate (auto variants) → this item's fast gate: lightmaps 51.6 → 45.7 s, effect-editor 15.1 → 11.9, scenes 6.7 → 3.4, effects-runtime 11.2 → 12.6, scene-transition 4.7 → 5.1, terrain-cdlod 204 → 198, rendering 128.6 → 129.8, others within ±0.5 s (smoke set 3.4 min with these files; the village check 39 s); about 20 s summed less in all (of 43.4 min: the gate is not much shorter from this item; what it removes is the reruns of the flaky tests and of the village check, see the decision log). |
| 39b.6 (docs) | Done 2026-10-23: every "owner to confirm" default (and "owner's call", "owner decides", "for the owner" questions) in the decision logs of plans 26–38 and 41 and the audit questions carries the owner's 2026-10-22 answer, appended to the entry (none rewritten): 248 marks — **190 confirmed, 23 reversed** (→ 39b.6b 17, 39b.6c 2, 39b.6d 1, 39b.10b 3), **11 moved** (lighting phase 5, phase 41 1, roadmap Future 2: walk graph and dogfood pass, superseded by phase 39c 2: `updatePrefab` and live blocks, a note for the art-factory owner 1), **24 moot** (phase 40/41 replace the area, the WebGL 2 query path goes, the gate-time budget is gone), **0 unclear**. Audit: D181, D182, D183, D253, D268 closed; D204, D205 moved; D227, D272, D281, D287 point at their item; D274, D282 confirmed. Plans 17–25 and 28c hold no such entries; phase 39, 39b, 39c and 42 defaults (this run) stay "owner to confirm"; no "owner look pending" removed (the look pass waits for the review page). |
| 39b.6b (part 1) | Done 2026-10-23 (06b8ff33, f819d6fa, 67c817e9, 82693c20, 3c9bb3fa, ed67db15): `FLOOR_PLAN_COUNT_MAX` gone (a storey takes no more rooms than its grid cells, the rest one Problems line by type; the placer stops at the first copy with no place; 10⁶ asked: 0.1 s; D218). Async-hook / late-`ctx` lines end with `CTX_LATER_FIX`. Undo/redo never resent: the status bar says "undo refused … press Ctrl+Z again", save stays saved (D281). Trim sheets draw at their own colour: no tint inheritance; a trim material with no stored colour gets a Problems warning (looks brighter; `#9a968c` keeps the old look); new trim materials and the Basic Kit store white (defaults: decision log). No block-layer count per scene (`memoryBytes` per layer in the blocks query); no object count per scene: `SCENE_OBJECT_BUDGET_BYTES` 32 MiB of scene document (a created box ≈ 530 B, so ≈ 4 × 16,384 boxes), growth past it refused (`scene_bytes`), shown by `queryProject {memory}` / `tl_inspect memory` (defaults: decision log). Structured fields: layer bounds, footprint/block-type cell metadata (edited by cell field type), spline profile, block looks/turns/boxes; tool-written data stays read-only (D227). Gates: 6 fast gates green at the cap (village p95 16.7, 0 missed, main 4.4–5.7 ms vs baseline 5.64/4.90); block-editor once red on a test bug, green on rerun. E2E: editor-window MCP-feed test 5.7 → 6.8 s, block-editor main test +1.4 s (9.8 → 11.2 s); no new files. Trim look: seen in the layered e2e picture only (rows at full colour), no before/after: owner's eyes. Later parts: the game-ready character, GPU effect batching, Navigate-only building selection, skies, project window in edit modes, `tl_docs` without a project, review page, per-vertex lighting removal. |
| 39b.6b (part 2a) | Done 2026-10-23 (963f5433): both starters' character is the game-ready Blender model (D272 closed): LOD0/1/2 4,796 / 2,398 / 958 tris + a 64-tri capsule `_COL`, one material, KTX2 albedo and ORM 1024² (ETC1S), normal 512² (UASTC), 22-bone skin, 6 in-place clips (controller roles Idle/Run/Airborne unchanged; Walk, Jump, Land for game animators), 948,892 B; the import record comes from `inspectGlb` in `build-template.mts`. Seen in Play on both renderers (idle, run, jump/airborne poses; screenshots looked at, `acceptance/39b.6b-starter-character-play-{webgpu,webgl2}.jpg`), 60 fps at the cap, no page errors; the LOD switch by frame triangles: 15,979 at the follow camera's distance, 8,303 with the switch points forced to 90/80 % (−7,676 = 2 × (4,796 − 958): LOD0 → LOD2 in the colour and shadow passes), same on both. Gate: visual-script's export check now accepts the page's own `blob:` URLs (embedded textures); rendering, visual-script, projects, playtest, animator-skinned 35 passed (3.9 min); the earlier red render-scale/HiDPI were the memory-starved host. Village perf: one webgl2 CPU miss (8.3 > 7.84 ms), green on rerun (7.13 ms). D301 (the 2D starter script renumbers ids) logged. |
| 39b.6b (part 2b) | Done 2026-10-23 (c4e03812, 7d3336b0): buildings selected only in Navigate: no tool selects on a click (Rect draws, also over a building; Move walls' plain click no longer picks), a double-click goes into the building (the room or path under the pointer), a click comes back out; Esc drops the tool before it clears the selection (P37-12). The project window is a Project panel in every edit mode (collapsed, bottom edge); the terrain e2e now drags a texture from it onto a layer tile (real drag, was a synthetic drop; P34-6). E2E (fast gates green at the cap, village p95 16.7, 0 missed): block-editor 9.8 → 10.2 s, layered-material 58 → 60 s, editor-window terrain test 11.1 → 13.1 s; no new files. rendering.e2e:219's occlusion check failed twice under load ~20 (another session), passed alone and in the next gates. The panel's look: unverified. |
| 39b.6b (part 2c) | Done 2026-10-23 (3e2f2fac, 5654a8f3, 51edbaa1): `tl_docs` (and `tl_inspect target="engine"`) answer with no project resolved; the other tools still name the missing project (onboarding test at the MCP boundary, P31-9). Per-vertex local lighting removed (P29-5): `localLights` pixel/none, light and *Lights*-block `importance` gone, the vertex stage, pool ranges and `?vertexLights` gone (local-lights.ts 462 → 206 lines, effect-lights.ts 257 → 154); stored `vertex` opens as pixel with one Problems line (HTTP test); village at the 60 Hz cap: webgpu p95 16.7, 0 missed, main 5.03 ms (baseline 5.64), webgl2 p95 16.8, 0 missed, 4.81 ms (4.90). New projects have the physical sky (P36-11, P34-9): the empty project and the 2D starter (seen: `acceptance/39b.6b-sky-starter-{before,after}.jpg`, `-sky-empty-after.jpg`); 26 e2e files that read a feature against the dark background start without a sky (one command each); the command corpus re-generated with the sky. E2E: lights 5.7 → 5.6 s, instances 4.9 → 5.2 s, scene-lights 7.5 → 8.6 s, scene-view-parity 8.4 → 6.4 s (last full gate → fast gate); no new files. Gates green at the cap; v4-limits and scan-bounded-log failed once under load, passed alone; level-acceptance red before the sky too (D302). |
| 39b.6b (part 2d) | Done 2026-10-23 (c2291e18, da9947e7): D302 closed: the trim-colour change (82693c20) made sheet B's sunlit faces paler (pipe 126,82,175); the old grey stored passes, so the test's predicate takes the new look. The 3D starter used the gradient sky: now the physical sky (sky lighting 0.1, fog kept), card picture redone (`acceptance/39b.6b-sky-starter3d-*.jpg`). level-acceptance 1.7 m fail → 0.5 m alone; projects 16 → 17 s. |
| 39b.6b (part 2e) | Done 2026-10-23: every new project's sky lighting is 0.1 (`NEW_PROJECT_ENVIRONMENT`, the 3D starter takes it too); the sky's own default (1) stays, so stored skies don't change. 2D starter: pillar and character no longer washed out, horizon still pale (the sky itself; `acceptance/39b.6b-sky-{2d,empty}-after2.jpg`); empty project looks the same (nothing lit). Card picture redone, corpus regenerated. Fast gate green (projects, starter-capabilities, level-acceptance 32 passed, 3.4 m); visual-script-debug and scan-bounded-log failed once under load, passed alone. |

## 5. Decision log

- 2026-10-21: Planned from the maintainability assessment, on the owner's
  approval of a consolidation phase between 39 and 40, the placement pipeline
  folded into 40, and a batched owner decision session.
- 2026-10-21 (owner, decision session): no fixed gate-time budget; the gate
  must just not grow without need (AGENTS.md updated). Occlusion culling
  stays off; the WebGL 2 query path is removed (39b.10b). Confirmed:
  unpainted walls take layer 2, normals read glTF-style, AO darkens indirect
  light only and old projects keep GTAO, 3D movers push, 2D block collision,
  `ctx` only inside hooks, world UVs on kit pieces. Reversals: 39b.6b. Moved
  elsewhere: streamed-out bodies (41), more than 16 local lights (a later
  lighting phase), the owner's dogfood pass (a future goal). Answers in
  `~/.cache/thirdlight-owner-review/answers-2026-10-21.md`.
- 2026-10-22 (owner, decision session round 3): trim tint inheritance
  dropped; buildings are selected only in Navigate (click), entered by
  double-click; the layered surface treats trim as an ordinary layer with A =
  wetness and no built-in grime (39b.6c). Confirmed: cutscene timing and
  transform keys, a fresh physics world per run, a throwing hook's earlier
  work stands, late start-up errors don't stop the game, prefab tags, LOD by
  screen size, height in albedo alpha.
- 2026-10-22 (owner, round 4): confirmed the cutscene walk rules and input
  hold, one-way/drop-through, axis-aligned planes for 41, terrain collision
  patches, the scene-list deprecation scope, the `ctx.character` API, script
  trust and publish retries, run-time decals (256 budget), and the four
  documented API quirks.
- 2026-10-22 (owner, round 5): confirmed engine bounds, rooms as lighting
  zones (look at the yard leak), cut-away details, the scatter rule format,
  projected decals inside the material, light layers, render scale and
  dynamic resolution, quality levels. Probe placement goes adaptive in the
  later lighting phase (roadmap).
- 2026-10-22 (owner, round 6): per-vertex local lighting removed (39b.6b);
  probe light modes (baked / mixed / realtime) and adaptive placement planned
  for the lighting phase; probe budget, block-layer lightmaps (kept for now),
  CDLOD terrain, macro texture, height fog, far-terrain lighting, scatter
  addresses and impostors, cached-shadow instances confirmed.
- 2026-10-22 (owner, round 7): confirmed the merged-start-scene interiors and
  per-room furniture, re-bake shader keep-alive, and the decal internals
  (grid budget, clipper, mesh decal order, receivers, vertex-paint storage,
  start hold with D239 open, depth offset). D205 (first-room light hitch)
  moves to the lighting phase. Effects leaving decals waits for a game's
  request.
- 2026-10-22 (owner, round 8): confirmed the occlusion internals (the WebGPU
  path kept opt-in; WebGL 2 parts moot), the script type-check details, the
  play-log buffer, Play content lifetime, the ETC1S info line, script-error
  Problems lines, decal details, phase-30 gate fixes and old formats out
  (39b.8). **Prefabs need their own discussion**: the owner doesn't like how
  they work today; `updatePrefab`'s semantics stay open until then.
- 2026-10-22 (owner, round 9): rooms drawn on their own (interior-only
  scenes) get the same automatic furnishing as building rooms (39b.6d).
  Confirmed: live blocks (revisit with the prefab discussion), edge pieces,
  floor plans and furnishing, buildings, trim on block walls, wall paint and
  wetness, block layer size, themes, auto-connect, terrain data and material
  rules. To check: the 16-block-layers-per-scene count is reconsidered
  against the no-caps rule (round 9, item 87, confirmed by the owner as
  recommended: a memory budget instead of a count).
- 2026-10-22 (owner, final batch): no per-scene object count (a memory
  budget); every new project has the physical sky; the project window stays
  usable in edit modes; `tl_docs` without a project; the look items wait for a
  review page (39b.6b). Confirmed: edit-mode context drawn as is, UASTC for
  large layered arrays (D274), and the remaining ~95 items (level building,
  materials and textures, editors, docs/MCP/process, perf targets; moot items
  closed). Notes for the art-factory owner: KTX2 exports should record their
  source PNG's hash; decal sheets use alpha as opacity; the trim-sheet spec
  proposal is pending. Open: the prefab discussion.
- 2026-10-22 (owner): the prefab discussion became phase 39c (linked prefabs), after this phase and before 40.
- 2026-10-22 (39b.1, default chosen, owner to confirm): the unit limits hold for package sources and tools,
  not for tests (a test file's `describe` callback is a list of cases); tests keep the 2,000-line file limit.
  Generated files (`*.generated.*`, `.d.ts`) are not checked. A unit that shrank fails the build until its
  entry is lowered (`node tools/check-size.mjs --update`), so it cannot grow back to its old size; the file
  rule shares the same ratchet list (`runtime.ts`, `inspect.ts`). Units are named by their path of named
  parents (`createBackend > dispatch`, `Viewport.render`), repeats numbered in source order.
- 2026-10-22 (39b.2, default chosen, owner to confirm): `RuntimeInstance` keeps the public `Runtime` surface as its own
  methods (one-line delegations to the parts), so callers, the worker protocol and tests that read the instance
  (`curr`, `controllers`, `captureWorld`, `cameraYawSource`) are unchanged; at 147 members it stays on the ratchet
  (≤ 80 would need the surface moved off the class, a change to what callers hold). Parts share one `RuntimeSim`
  (the step state) and report through `RuntimeFaults`; each part names what it reaches in a small host interface.
  The fast gate's uncapped village check missed on WebGL 2 at 4.9 ms (limit 4.84) on three commits; interleaved
  A/B against 28701f1d was equal (base 4.7–5.0 ms), host state (D199, D290). `playtest.e2e.ts` `tl_playtest`
  New game failed once with the D114 preview timeout and passed on rerun.
- 2026-10-22 (39b.3 part A, default chosen, owner to confirm): the adapter's parts share one small `AdapterState`
  (disposed, the baked lightmaps, the camera, the hidden set) and are listed in `AdapterParts` for the frame, the
  diagnostics and the surface (as `RuntimeSim` for the runtime); each part names what it reaches in its own deps
  interface. The parts are made in the old order (material and object ids, so draw order, stay the same); dispose
  keeps its order except that the material parts (decal pages, projectors, script values, swaps, an own library,
  its listeners) now go together after the scene preparations. The always-empty `owned.geometries/materials` lists
  were dropped. The fast gate's uncapped village check missed on WebGL 2 at 4.9–5.0 ms (limit 4.84) on every commit;
  interleaved A/B against 28701f1d (3 rounds, twice) was equal (base 4.9–5.4 ms): host state (D199, D290).
  `rendering.e2e.ts` "repeated boxes … instanced" failed once in the last commit's gate (the editor did a full sync,
  124 processed, racing the setTransform under load) and passed 3/3 alone.

- 2026-10-22 (39b.3 part B, default chosen, owner to confirm): the backend's parts take explicit deps (no shared state object;
  `closed()` is the only shared fact) and are wired in the root in the old order; a part made before the one it calls
  reaches it through a closure, as the old closure did. `Problem` and the backend's exports stay importable from
  `backend.ts`. The router keeps the route order (the specific content routes before the content table, the materials
  route after it); the method/auth checks per route keep their order (405 before auth). `makePlayRoutes` (849 lines)
  stays on the ratchet: Play is its own split, not part of this item.

- 2026-10-22 (39b.4 part A, default chosen, owner to confirm): the session client keeps its whole surface by inheritance,
  as it already split core and client: `SessionProjectState` (the content copy and its `get…` methods) ← `SessionClientCore`
  (connection, commands, Play, open scenes as composed parts) ← `SessionClient`. `Viewport` keeps its public methods as
  one-line delegations to its parts; at 115 members it stays on the ratchet (its surface alone is 63 methods the editor
  calls). Five public methods nothing called were dropped (`setGizmoMode`, `environmentPreview`, `instanceStrokesSettled`,
  `frameScene`, the public `copyClientPoints`). The copies part is made before the adapter: an adapter reports content
  while it is made, and that report reads the selected copy (none yet). `EditorApp` is the config gate over
  `useEditorModel`; the shell is drawn by plain render functions (no hooks), so the page's React tree is the old one; the
  model's effects keep their old order (render-settings effects after the mount, the gizmos/hidden/occlusion ones before).
  The first viewport gate was red on that init order (the editor did not start) and green after the fix.

- 2026-10-22 (39b.4 part B, default chosen, owner to confirm): `inspect.ts` is the GLB inspector, so "per asset kind" (image,
  audio and font already had their own files) became per glTF area: one function per profile step over a shared
  `GlbState`, which `Inspector` extends, so the step order and the stop at the first failing step stay in one place. The
  graph editor's port-geometry helpers are made once (they only read the ports through a ref) so the split hooks can
  list them as dependencies without changing when callbacks are remade. `attachBrowserInput` returns a named
  `BrowserInputSource` (same members); its parts get the resolved window/document from the root, which stays the only
  module that reads the globals, and the listeners are installed in the old order.

- 2026-10-23 (39b.5, default chosen, owner to confirm): the fast gate's village check measures the export at the 60 Hz cap
  (`--gate` implies vsync) and fails on more than 10 % of the frames missing a refresh (`CAP_MISSED_SHARE`) or the main
  thread's CPU time per frame over the baseline by more than 60 % (`CAP_MAIN_REGRESSION`). CPU time (CDP `ThreadTime`),
  not task wall time: under another session's Blender (load 10) the task time went 4.9 → 10.0 ms on WebGL 2 while the
  CPU time went to 7.2; shared cores still slow the thread by up to half, hence the generous margin. A frame over its
  budget misses most refreshes, so the missed share catches it on either side (main thread or GPU). The gate no longer
  draws the plain three.js page (at the cap both draw every refresh; it stays in manual runs). The GPU time is not gated
  (WebGPU only, +3 s); a later perf item may add it. Baseline: one run of three at load 2–3 (the median WebGPU one).
- 2026-10-23 (39b.5, default chosen, owner to confirm): `tools/gate.sh full` prints its time beside the last green full
  gate's (read from that gate's summary in the logs folder; "not recorded" without one); no budget.
- 2026-10-23 (39b.5, default chosen, owner to confirm): Escape in the project window clears its own choice and cut
  first, then (nothing left to clear) goes on to the window: it closes the editor window or clears the Scene selection.
  `setSettings` is rebased like a patch (it carries only its keys). A closing backend drops an editor socket that has
  not answered its close frame after 2 s (`WS_CLOSE_GRACE_MS`). The preview's page load and handshake count as load
  progress for the present timeout.
- 2026-10-23 (39b.5): kept, with the reason. Folding files' tests onto one backend: a backend starts in ~0.4 s (370 ms to
  listening, measured), so the 7-test authoring loop would save ~3 s for a rework of isolated tests; one backend per
  file stays the rule for new and extended tests. Running editor-only steps of renderer-variant tests once
  (layered-material, terrain-paint, texture-streaming): their subjects include backend paths (mip uploads, shading)
  and later steps read what the UI steps made; layered-material is reworked by 39b.6c. scene-loads' 11 s wait is its
  10 s frame watch (`FRAME_WATCH_MS`), the subject. count-caps' browser-free half generates the project the bench then
  reuses: in vitest it would cost the same time once more. The export/occlusion test in rendering.e2e (45 s) shrinks
  with 39b.10b (the WebGL 2 query path goes). Watch rows D266, D273 and D277 are product questions, not flaky tests:
  left for 39b.7. `rendering.e2e` "repeated boxes … instanced" (no D-row; twice in fast gates): likely a full sync the
  editor made for its own reasons took the external move with it (not reproduced in 24 runs); the move is made again (up to 3 times) until a sync of only
  it is seen.

- 2026-10-23 (39b.6, docs): how the answers were applied. A mark is appended to its entry ("**confirmed by the owner 2026-10-22**", "reversed → item", "moved → …", "moot" with the reason), never a rewrite. An entry whose parts went different ways names each part; one with a reversed part counts as reversed in the tally (the moved and moot parts of confirmed entries count as confirmed). Questions that were not defaults but asked the owner (the gate's worker count, Part D as its own phase, the 2D starter's sky) are marked too. Entries of the final batch's "rest (~95): confirm" are marked confirmed. Audit rows the owner settled are closed the usual way ("Closed 2026-10-23 (39b.6): … Was: …"); rows whose fix is an item stay open with a pointer. Open: none unmapped; still with the owner are the looks (review page), the prefab model (39c) and the art-factory notes. STATUS.md's "Owner to decide: D282" is not a plan or audit line and is left for the lead.

- 2026-10-23 (39b.6b part 1, default chosen, owner to confirm): no migration writes the old grey into trim materials
  with no stored colour, so every such building brightens (the Problems warning says how to keep the old look);
  layered "Make it paintable" bases brighten too, with no line (a stored white can't be told from the default). The
  per-scene object budget counts the stored scene document's bytes, not heap; `MAX_LIVE_SPAWNED` stays 16,384 live
  spawns per run, and v2/v3 scenes keep their 1,024.

- 2026-10-23 (39b.6b part 2a, default chosen, owner to confirm): the starter character has LOD0–2 as the item row asks,
  although the art pipeline's rule gives characters no LODs; its auto-retopo topology and procedural clips wait for
  the owner's look (`~/.cache/thirdlight-phase39b/acceptance/39b.6b-starter-character-*.jpg`).
- 2026-10-23 (39b.6b part 2b, default chosen, owner to confirm): Esc now drops the tool before it clears the selection
  (the owner's "the first Esc drops the tool"; the selection is kept in Navigate, the next Esc clears it), in every
  editor. Move walls' click without a drag no longer picks the room (only a moved wall picks its room); a drawn room
  or opening is still picked as the tool's result. The project window in an edit mode is a docked **Project** panel
  (collapsed on the bottom edge, 260 px tall when open) rather than the bottom dock showing beside the mode, so each
  settings column keeps the full height it fits in at 1080p.
- 2026-10-23 (39b.6b part 2c, default chosen, owner to confirm): `tl_inspect target="engine"` answers without a project
  too (it names the build whose manual `tl_docs` reads). With per-vertex shading gone a light's importance chose nothing,
  so the field goes from point and spot lights and the effect *Lights* block; a stored one is dropped at load and only a
  `vertex` one is counted in the Problems line. The script access digest is re-pinned for schema 7 without a bump (a
  script reading `light.importance` gets nothing, as for an absent auto). New projects' sky is the physical sky at its
  defaults (sky lighting 1, sun from the key light), given to the first scene of an empty project and of any template
  whose scene sets no look; the 3D starter keeps its day gradient and fog (its setup sets them), although the owner's
  answer reads "physical sky everywhere". The look is the owner's: a pale horizon haze behind the 2D level, the starter's
  pillar and character washed bright by the sky light (`acceptance/39b.6b-sky-*.jpg`). Tests that read a feature's
  pixels against the dark background clear the sky in their setup (`withoutSky`) rather than re-recording thresholds
  against a bright one.
- 2026-10-23 (39b.6b part 2d, default chosen, owner to confirm): the 3D starter's sky is the physical sky too (it had
  the gradient). Its sky lighting is 0.1, not the default 1: at 0.6 (the gradient's) and 0.3 the blocks and character
  washed out and the sun's shadows faded; at 0.1 the ground reads 149–169 grey as before (132). Its fog stays.
- 2026-10-23 (39b.6b part 2e, default chosen, owner to confirm): all new projects (empty, 2D and 3D starter) take sky
  lighting 0.1 from one constant; the physical sky's own default stays 1, so existing skies keep their look.
- 2026-10-23 (owner, planning session thirdlight-ab): 39b.6e (Temporal G11, see-through fades only true
  occluders: CPU occluder search + the existing circle dither on them, padding a new setting) and 39b.6f
  (G12, prefabs keep every model field) added; they run after the 39b.6b work in progress.
