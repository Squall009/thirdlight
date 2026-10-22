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
