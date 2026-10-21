# Phase 38 — Requests from Sprout, Skyforge Tactics and Temporal, third batch

Status: done 2026-10-21, owner look pending.

Goal: close the engine gaps the three game projects reported after phase 28,
as generic capabilities. Most of the work is about scripts that fail
safely, cutscenes that move characters, and Play tools that never hide an
error. Read `docs/roadmap.md` (principles 1 and 1b) first.

Sources, checked against main at `8315f041` (2026-10-20):
- Sprout: `~/projects/sprout/docs/thirdlight_requests.md` (TL-REQ-28 …
  TL-REQ-32, and question 2)
- Skyforge Tactics: `~/projects/skyforge-tactics/docs/engine-gaps.md`
  (E21, E83, E84, E86, E87)
- Temporal: `~/projects/temporal/docs/engine-gaps.md` (G1, G2, G4–G6)

The engine never reads these repos. The ids are only here so a request can
be traced back to the game that raised it.

## 1. Owner decisions (2026-10-21)

- **A game changes levels with `ctx.scenes.load` / `ctx.scenes.unload`.**
  It is the one standard way. The game decides which scene's look shows
  with `ctx.scenes.setActive`. The shell's scene list and its move
  (`ctx.shell.nextScene`, the `nextScene` UI engine action) are a second,
  older way to move between scenes. They keep working but are deprecated in
  this phase, the same as `restartLevel` / `newGame` in phase 28: a one-time
  Problems line, removed in a later phase.
- **Declined: Sprout TL-REQ-29 and TL-REQ-30.** Both come from a game moving
  through levels with the shell's scene list while it keeps its player in a
  start scene that never unloads.
  - **29** (moving through the list never makes the listed scene the active
    look): the game loads its levels with `ctx.scenes.load` and picks the
    look with `ctx.scenes.setActive`. Sprout already does this, and has
    verified it works.
  - **30** (no script call sets the shell list's index): a game that owns
    its flow keeps its own level order and loads the next level itself.
    Sprout already does this, through each level object's `next_scene`.
    Adding a way to mix the two systems would make the list's index drift
    again.

## 2. Closed without engine work, or placed elsewhere

| Request | Why |
|---|---|
| Sprout TL-REQ-1 … 27, Q1 | Done in phases 23–28 (Sprout's own table agrees). |
| Skyforge E1 … E82, E85 | Done in phases 23–32. Skyforge's `engine-gaps.md` still lists some of E53 … E82 as open; Skyforge re-checks them against the plans of phases 28–32. |
| Temporal G3 (headless Play in a 3D project) | Fixed by D289 (`29ef3505`). Temporal closed it on 2026-10-20. |
| Sprout `$flow.timer` (TL-REQ-1, optional) | A level timer is a game rule; the game publishes its own. |
| Sprout TL-REQ-32.3 (fence origin warning) | Sprout's asset; the warning is correct. |
| Skyforge texture-tool wishlist; Temporal X1–X3 | Studio / art-factory, not the engine. |

## 3. Items

Order: release checks → defects → script safety → Play tools →
cutscenes and content → the scene-flow decision → 2D block collision →
checks → manual → acceptance.

**E2E budget (D253):** the last full gates ran 26–31 min against a 15 min
budget.
- No new e2e file, and the phase adds no net e2e time.
- Runtime, build and protocol behaviour gets vitest checks against the real
  runtime and the real build.
- The only editor surface is the timeline panel's character track. It is
  one step in the existing timeline e2e.

| Item | What | Requests |
|---|---|---|
| 38.0 | **Release checks.** Is there a newer three.js than 0.186.1, or a newer Rapier than the pin? Patch releases are taken here; a minor release is planned as its own item. Either goes through `docs/three-upgrade-checklist.md`. | — |
| 38.1 | **Defects:**<br>• **D151:** hiding one object and showing another in the same step keeps the old one drawn. `hiddenEntities()` (`runtime/src/runtime.ts`) caches the union by set identity and size, while the block layer mutates its set in place. Fix: the block layer keeps a counter that goes up on every visibility change, and the cache compares the counter.<br>• **Prefab copies lose their tags:** `PrefabEntity` gets an optional `tags`. `createPrefab` (`commands/src/prefab-ops.ts`) stores each object's tags, `spawn.ts` gives them to each copy, and the live tag index adds copies when they spawn and drops them when they despawn.<br>• **E21:** a comment containing the word "import" above a type-only import gets that import refused. `behavior-build/src/scan.ts` blanks comments and strings (the region classifier is already in that file) before it matches imports.<br>Acceptance: vitest checks for each: a hide-one/show-one swap in a single step; a spawned copy found through `ctx.tags`; the comment case from 2026-10-17. | D151 / E83, TL-REQ-28, E21 |
| 38.2 | **A script error stops only that script.** An exception thrown in a script's step, event or message handler is caught for that one script instance on that object. It is logged to Problems and `runtime.errors` with the script, the object and the source-mapped frame, and that instance is switched off for the rest of the run. Every other script and the simulation carry on. `prepare` / `instantiate` failures keep failing at start, as they do now. Export: the same, with the error in the console. Acceptance: in a vitest on the real runtime, one script throws on step 10; the other scripts and the physics keep stepping; the error is listed once. | D155, Temporal G2, E64 leftover |
| 38.3 | **Script publish checks types.** `tl_script_publish {check}` and the editor's check run a TypeScript type check (the pinned `typescript`) of the script against the engine's generated typings, after the esbuild build. Type errors come back as diagnostics with line and column. They don't block a publish without `check`, so a game's project still opens. Acceptance: `ctx.camera.activate(id, {blendTime})` is reported with the field's real name. | Temporal G5 |
| 38.4 | **Play tools never hide errors:**<br>• `fitPlayDiagnostics` (`protocol/src/diagnostics-bound.ts`) keeps `runtime.errors` and the newest log lines, and cuts the other lists first.<br>• Identical rows are merged with a count ("×16").<br>• An observation over 16 KiB (`bridge.ts`) is trimmed the same way, with a `trimmed` note, instead of being refused.<br>• `tl_diagnostics` and `tl_game_observe` take a `sections` argument, so you can ask for only the parts you need.<br>Acceptance: vitest on the bound and the bridge; one MCP integration check. | E87 |
| 38.5 | **Cutscenes move characters.**<br>• A `character` timeline track (`project-model/src/timelines.ts`). Keys: `{position, facing, mode: place \| walk, run, enabled}`.<br>• `place` uses the existing character placement. `walk` feeds the controller's move input toward the key's position, so the character walks with its animator and collisions. `enabled` switches the controller off and on.<br>• A rotation key on a character turns the controller.<br>• The same track drives a 2D character.<br>• Script wrappers over the same intents: `ctx.character.place`, `walkTo`, `setEnabled`.<br>• The timeline panel adds and edits the track. That is one step in the existing timeline e2e.<br>Acceptance: a timeline walks a 3D and a 2D character to a mark and turns them. | E84, Temporal G1 |
| 38.6 | **Update a prefab in use.** A new `updatePrefab {prefabId, fromEntity}` command replaces a prefab's contents in place and keeps its id, so scripts that name it keep working. Copies already spawned keep what they have; new spawns use the new contents. It goes through the one command path, so MCP and the editor (a new "Apply to prefab" action on a prefab copy) both have it, and it can be undone. | Temporal G4 |
| 38.7 | **Play content stays valid for the whole Play session.** The play content's expiry (`PLAY_CONTENT_TTL_SECONDS`, 15 min) is pushed forward while the play session is alive. It ends with the session (30 min), plus the existing grace after Play stops. Acceptance: a backend integration check fetches a scene after the first expiry would have passed (with a short test clock). | Temporal G6 |
| 38.8 | **Scene changes go through `ctx.scenes`** (§1):<br>• `ctx.shell.nextScene`, the `nextScene` UI engine action and the shell's scene list get a one-time Problems line pointing at `ctx.scenes.load` / `unload` / `setActive`.<br>• The manual (`features/gameplay.md`, `guides/game-flow.md`, `concepts/game-flow.md`, the generated reference) shows level changes only with `ctx.scenes`, and says that `setActive` picks whose look shows. | TL-REQ-29/30 (declined) |
| 38.9 | **Block layers collide in 2D projects.** On the 2D plane, the 3D chunk collider's collision shapes are cut at the play plane, z = 0 by default (a layer setting can change it):<br>• a full cell becomes a box;<br>• sloped corners, half blocks, ramps and stairs become their profile polygon;<br>• an edge piece on a grid line becomes a thin box.<br>The shapes are merged per chunk into the 2D physics world, and rebuilt with the chunk the same way as the 3D mesh collider. A block type can be one-way (a floating ledge). `ctx.grid` reads agree with what the player stands on. Acceptance is Sprout's: a 2D project with ground, a 1:2 slope, stairs and a pit — the player stands, walks up both and falls into the pit; editing a cell changes collision at the next Play. | TL-REQ-31 |
| 38.10 | **Checks** (fix if they're bugs; otherwise clarify the manual):<br>• TL-REQ-32.1: an unpainted wall of `surface` columns shows layer 1, but `features/blocks.md` says layer 2.<br>• TL-REQ-32.2: `kit-check.ts` flags gutters on a KTX2 sheet whose PNG export has none. Check the decode orientation and how the check reads compressed blocks.<br>• Sprout Q2: do moving platforms on polygon colliders push the player sideways?<br>• E86 (frame-time spikes in Skyforge's Shatterfall): a CPU, GC and steps-per-frame profile on both renderers, read together with D235. If the cause is in the engine, it gets a D-row; if not, the findings go back to Skyforge. | TL-REQ-32.1–2, Q2, E86 |
| 38.11 | **The manual:** the character track, the script API additions, `updatePrefab`, script errors (what stops and what doesn't), the Play tools' `sections`, 2D block collision, the deprecations; the reference regenerated. | — |
| 38.12 | **Acceptance.** Each request's acceptance above as a test at its boundary. The cutscene walk is looked at in a real browser on both renderers (screenshots to `~/.cache/thirdlight-phase38/acceptance`); owner look pending. `tools/gate.sh full --both-renderers`, then the phase review. | — |
| 38.13 | **Review fixes.** | — |

**Done when:**
- A script exception stops only its own script.
- A timeline walks a character.
- Play diagnostics never drop an error before other lists.
- A prefab in use can be updated.
- A 2D project's ground can be built from blocks.
- The manual changes levels only with `ctx.scenes`.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| 38.0 | Done 2026-10-21: three.js 0.186.1 is still the latest on npm (no update). Rapier 0.21.0 is out; the pinned 0.20.0 stays, since nothing in this phase needs it (a minor release would be its own item). |
| 38.1 | Done 2026-10-21: D151 (the block layer counts hidden-set changes and owns the joined set; runtime.ts 4,154 → 4,146 lines), prefab objects keep their tags into placed and spawned copies (`ctx.tags` finds them until destroyed), E21 (imports matched in code only). New vitest checks in runtime, commands, project-model, behavior-build; no e2e change. Fast gate e2e 36/36 green; its village perf check missed twice (WebGPU p50 7.7 / 7.6 ms); interleaved A/B against `8315f041`, 3 rounds: A 7.7 / 7.7 / 7.9 ms, B 7.5 / 7.6 / 6.9 ms (plain three.js page 6.3–7.0 ms): host state (D290). |
| 38.2 | Done 2026-10-21: a throwing hook (step, any callback; an async step or a returned value) switches off that one instance at the throw, its `dispose` runs once; one `runtime.errors` entry with `entityId`, step, phase and frames, one Problems line per script (`script_error_<id>`), the export prints it to the console; a run restart switches it on again; an `instantiate` that throws after the start (a loaded scene, a spawned copy, a restart) switches that instance off and the load or spawn completes. Hook code moved to `behavior-hooks.ts`, errors to `behavior-errors.ts` (behavior.ts 1,945 → 1,677; runtime.ts 4,146 → 4,145). Vitest: runtime unit checks (spawned copy and loaded scene with a throwing `instantiate` included), `tests/integration/m38-script-errors` (page and worker, real 3D physics, a step and an `onMessage` throw); 9 tests that asserted the old halt rewritten. `playtest.e2e.ts` MCP step rewritten (the game runs on; source line; Problems; play-test run errors): 28.3 s (last full gate) → 15.7 s. Fast gate: build, lint, vitest 734 files, e2e 33/33 green; village perf missed twice (WebGPU p50 7.6 / 6.8 ms); A/B against `8315f041`, 3 rounds: A 7.7 / 7.5 / 7.9 ms, B 7.9 / 7.9 / 7.7 ms: host state (D290); the follow-up's fast gate green again but for the same miss (7.7 ms), within the same hour as that A/B. |
| 38.3 | Done 2026-10-21: a script check (`tl_script_publish {check}`, the editor's idle check / Ctrl+S) type-checks a source that builds with the pinned TypeScript 5.9.3 (now a `behavior-build` dependency, loaded on first check, external in the backend bundle) against the generated API typings (moved to `behavior-build/api-typings`; the editor shows the same), in memory with the script's modules and the project's libraries; a type error answers `compiled: false`, `behavior_type_error` with file, line, column and the option type's fields (`blendTime` → "CameraBlendOptions has: blend, time"). Check time: first check 0.6 s (compiler load), typical script 4–9 ms warm, a 64 KiB / 1,442-line module 41–55 ms warm (109 ms first). Vitest at the real build (`type-check.test.ts`) and through real MCP + backend HTTP (`onboarding.test.ts`: check refuses, publish of the same source goes through); `script-editor.e2e.ts` gained the type-error step: 7.9 s (last full gate) → 10.7 s (fast gate; earlier fast gates 9.4–22 s). Fast gate: build, lint, vitest 735 files, e2e 41/41 green; village perf missed twice (WebGL 2 p50 5.2 / 5.1 ms); A/B against `8315f041`, 3 rounds: WebGL 2 A 4.6 / 4.9 / 5.8, B 4.7 / 6.0 / 5.2 ms, WebGPU A 5.7 / 5.7 / 6.0, B 5.6 / 8.3 / 7.9 ms (load 2.6 → 8.7): host state (D290). |
| 38.4 | Done 2026-10-21: copies of one row (same code, message, script, position; differing in step or object) fold into one with `count`, `firstStep`, `entityIds` (first 4), at the runtime's 32-row play log (now `runtime/error-ring.ts`; log lines keep at most half the ring while errors need it) and in the bound; the shape is project-model `repeated-rows` (runtime cannot import protocol). `fitPlayDiagnostics` folds copies, then cuts other lists (longest first, oldest rows), then log lines, then whole parts, errors last; `fitGameObservation` trims an oversize observation (header and `error` never cut) instead of the bridge refusing it (bridge now checks `GAME_OBSERVATION_MAX_BYTES` in UTF-8 bytes); `trimmed {logEntries, errorEntries, lists, omitted, merged}` by path with counts. `sections` on `tl_diagnostics` / `tl_game_observe` (protocol `PLAY_DIAGNOSTICS_SECTIONS`, `GAME_OBSERVATION_SECTIONS`; unknown names refused with the valid ones), picked on the page before the trim; the Console shows `×N` and the step range. Vitest: protocol bound/bridge/sections (a big scene keeps all 10 errors, 16 effect copies → one row ×16; an oversize observation passes the bridge trimmed), runtime ring. E2E: `play-logs.e2e.ts` (Console ×N) 10.9–11.2 s → 11.0 s; `playtest.e2e.ts` MCP step (sections, refusal) 15.7–15.9 s → 16.0 s. Fast gate: build, lint, vitest 736 files, e2e 33/33 green; village perf missed once (WebGL 2 p50 4.9 ms > 4.84), rerun green (4.7 ms). The `×N` badge's look is unverified (asserted by text only). |
| 38.5 | Done 2026-10-21: a `character` timeline track (`{mode: place \| walk, position, facing, run, enabled}`, track `playerInput`) and `ctx.character.place / walkTo / walkState / stop / turn / setEnabled` (graph nodes too), one path: the new character director (`runtime/character-director.ts`; the track driver `timeline-character.ts`) writes the character's intent channels after the intent phase: a walk is the controller's own move input (braking, 0.1 m arrival, blocked after 1 s), the track holds the player's input while it plays, a skip lands walks on their marks; a rotation key on a character turns its controller; 2D: walks along x, facing turns face-movement models, `character_enable` and a transform key's position now work there. runtime.ts 4,143 → 4,140 lines. Vitest: `tests/integration/m38-character-track` (3D and 2D, page and worker, real Rapier: place, walk against held input, turn, park, skip, script walk, blocked walk, rotation key), timeline model/preview checks. `timeline.e2e.ts` editor step gained the character track (add, key, walk, preview): 2.3 s (last full gate) → 2.5 s; Play step 11.2 → 10.9 s. Fast gate: build, lint, vitest 737 files, e2e 34/34 green, village perf in its limits (WebGL 2 p50 4.8 ms ≤ 4.84). Seen in the editor's Play at 1920×1080 (WebGPU, screenshots looked at): mid-walk between the marks facing the way it walks, then on its mark facing −Z; WebGL 2 unverified (38.12). |
| 38.6 | Done 2026-10-21: `updatePrefab {prefabId, fromEntity, displayName?}` (one command path: commands, workspace, protocol op and change lists, MCP docs; undo/redo swap the whole definition) replaces a prefab's contents through the capture `createPrefab` uses (`capturePrefabEntities`), keeps its id, `createdRevision` and name, sets a new optional `updatedRevision`; parts copied from it keep their local ids (the root keeps the old root's), entity references inside are remapped; placed and spawned copies are untouched; the same contents again is `no_change`. Editor: a copy's Inspector "Apply to prefab". Vitest: `tests/integration/m38-prefab-update` (real workspace on disk: refusals, undo/redo, the untouched copy; the play content built from the project; a script's `ctx.spawn('crate')` in the real host spawns the new parts). `delete-content.e2e.ts` gained the Apply step: 4.8 s → 4.8 s. Fast gate: build, lint, vitest 738 files, e2e 31/31 green, village perf in its limits (WebGL 2 p50 4.7 ms). The button's look is unverified (asserted by role and result only). |
| 38.7 | Done 2026-10-21: a play's activity (presented, observe, control, input, screenshot, diagnostics: the same that pushes its 30 min inactivity expiry) renews its play content to the play's own expiry (`PlayManager` `onRenewed` → `PlayContentStore.renew`, never shortened); `PLAY_CONTENT_TTL_SECONDS` (900) stays the least lifetime, a stopped or expired play's content is readable `PLAY_CONTENT_GRACE_SECONDS` (60) more; one `deadline(set)` serves status, cache max-age, prune and the expired error (which had its own 60 s literal). `tl_play_start`'s `playContent.expiresAt` now equals the play's `expiresAt` and moves with it (MCP docs, `features/play-tools.md`, `guides/playtesting.md`). Content TTL and grace joined the backend's test-only timeouts (defaults are the protocol's constants). Vitest `backend/play-content-lifetime.test.ts` over real HTTP (1 s content TTL, 1 s grace, 3 s play inactivity): a scene served 1.5 s in, then 503 `play_locator_expired` a grace after a stop and after an inactivity end; fails without the renew. No e2e change. Fast gate (`playtest.e2e.ts`): build, lint, vitest 739 files, e2e 32/32 green, village perf in its limits (WebGL 2 p50 4.7 ms). |
| 38.8 | Done 2026-10-21: the scene list move is deprecated with phase 28's mechanism (one `takeProblems` line per kind per Play): the `nextScene` UI engine action (`deprecated_next_scene`, in `UI_DEPRECATED_ENGINE_ACTIONS`, so the editor marks it; the host now names the move's cause on the `scene` UI event, a new game's move writes no nextScene line) and `ctx.shell.nextScene / sceneIndex / sceneCount` (`deprecated_shell_scene_list`; `@deprecated` in the typings, the 38.3 check and the editor see it; graph nodes "… (deprecated)"); both keep working. `ctx.shell` moved to `runtime/scene-list.ts` (runtime.ts 4,140 → 4,124). Manual: game-flow concept and guide (next level with `ctx.scenes.load(next, {unload})` + `setActive` once loaded, type-checked with the 38.3 checker), gameplay, game-shell, projects-and-scenes, scripting, migration notes, deployment; reference regenerated. Vitest `runtime/scene-list.test.ts` (both paths move and write their line once), `game-host/shell.test.ts` (the cause). No engine templates or dogfood projects used the list. E2E unchanged (they still drive `nextScene` / `ctx.shell`): `shell-scenes.e2e.ts` 5.7 → 5.9 s, `entity-access.e2e.ts` 4.5 → 4.5 s. Fast gate: build, lint, vitest 740 files, e2e 32/32 green, village perf in its limits (WebGL 2 p50 4.7 ms, WebGPU 5.7 ms). |
| 38.9 | Done 2026-10-21: on the 2D plane each chunk's collision shapes (the 3D ones, `collisionLooks`) are cut at the layer's new `planeZ` (default 0) into convex pieces (`project-model/block-plane-cut.ts`: nonzero slab fill, runs merged: flat ground one box per chunk, a 1:2 slope one piece, stairs a box per step, x-line edge pieces thin walls, z-line ones none), one compound per chunk plus a collider per one-way piece (new block type `oneWay` on the port's one-way and drop-through), rebuilt at the 3D flush points and before the 2D sweep (`runtime/grid-plane-colliders.ts`; grid.ts 1,825 → 1,833, runtime.ts 4,124 → 4,124). Vitest: the cut's unit checks; `tests/integration/m38-block-plane` (Sprout's case on real Rapier 2D, page and worker: stands, up through a one-way ledge and drops back, stairs, the slope, a chunk edge, the pit; `ctx.grid.surface` within 1 cm of the feet, 8 cm on the slope; the filled pit's next Play walks over it; a script's dig drops it). Perf: a 512 × 64 × 2-cell layer cuts in 10 ms (289 solid + 69 one-way pieces), first build with Rapier 30 ms, a chunk rebuild 0.2 ms (max 0.9). Editor: block type toggle "One-way on the 2D plane" (`block-layers.e2e.ts` step: 15.8 → 15.7 s), *Play plane z* in the Inspector (descriptor). Fast gate: build, lint, vitest 742 files, e2e 31/31 green, village perf in its limits (WebGL 2 p50 4.7 ms). The toggle's look and a 2D block level in a browser Play are unverified. |
| 38.10 | Done 2026-10-21: (1) TL-REQ-32.1 was a bug: with wall paint and material rules, the rules filled a wall's unpainted share from layer 0, so rules naming only tops turned walls to the first layer; each share now takes the rules over its own base (top 0, wall 1); `features/blocks.md` says where layers count from 0 (`layer`, `channel`) and where they are named 1–4 (`a63d23e0`). (2) TL-REQ-32.2: the decode is right (UASTC of the same sheet passes, orientation checked); ETC1S's 4×4 blocks move a row's edge and gutter apart as much as a fault (padded sheet from the pinned encoder: up to 77 levels smooth, 186 noise; unpadded 38–78), so an ETC1S KTX2 without a lossless original passes when its gutters still repeat and otherwise says "not judged" instead of warning (`b47c17dd`). (3) Sprout Q2: 2D polygon movers push sideways and carry like boxes (real Rapier test); in 3D no mover pushed a standing player (box and convex alike: Rapier's sweep stopped the push at the ground contact) — fixed, a mover moving across keeps its velocity for the sweep unless stood on (`f2f9c92a`). (4) A 2D block layer and player arriving with a later scene already collide (new page+worker test, `3ad005f6`); no fix. (5) E86/D235: uncapped-only GPU-process back-pressure, not an engine defect (D235 has the trace); at vsync both renderers 16.8 ms max, nothing missed. Fast gates green (village WebGL 2 p50 4.7–4.8 ms); e2e files unchanged (`block-layers` 15.8 s, `layered-material` 57.5 s, `physics-3d-colliders` 14.5 s). The "not judged" text in the editor is unverified in a browser. |
| 38.11 | Done 2026-10-21: manual made consistent for the phase: stale "a script error stops the game" lines fixed (play-tools' failed run, spawn errors, the visual-script loop cap, first Play, the agent skill); new play-tools section on folded rows, trimming order and `sections`; type check's strictness and skips (guides/scripts, editor); character track details (one step later, held input, blocked walks, skip/stop, 2D x-only and `run`) in timelines, gameplay and a new walk-a-character cutscene in guides/timelines (its script and timeline JSON checked with the 38.3 checker and the timeline validator in a scratch vitest, deleted); later-scene layers and arriving players' Autostep (blocks), 2D block ground (2d-and-3d, which-tool), ETC1S "not judged" (trim-sheets), setActive (environment), a migration list of behaviour changes; skill and traps updated; `ctx.character`/`ctx.scenes`/`ctx.shell` doc comments fixed, reference regenerated. Fast gate green (`script-editor.e2e.ts` 10.7 → 9.8 s; village WebGL 2 p50 4.7 ms). |
| 38.12 | Acceptance in the browser done 2026-10-21 (the full gate and the review are the lead's): the real editor at 1920×1080 on the Iris Xe, both renderers, fresh projects; 30 screenshots looked at (`~/.cache/thirdlight-phase38/acceptance/INDEX.md`). Seen on WebGPU and WebGL 2: the guide's cutscene walk on the 3D starter (mid-walk, then on its mark turned to the camera), a 2D character track walking along x, a 2D block level (standing on the one-way ledge, on the 1:2 slope, falling into the pit), a script throwing on three copies while another keeps moving a box (one Console row ×3 with its objects). Seen on WebGPU: the one-way switch and *Play plane z*, Apply to prefab and its result, the script editor's `blendTime` type mark, ETC1S "not judged" in the trim table and the kit's Check all (a KTX2 imported twice through the Project window). Fixed: the guide's mark sat inside the starter's raised blocks (the walk ended blocked); a timeline field typed and a control used straight after lost one edit (`revision_conflict`; saves merge onto the stored timeline as materials do); three copies' throws were three rows (the error text named the object; it now says "its object", the Problems line keeps the name, the Console lists the objects and "step N" for one step); the Console said "relay failed" after a stop. E2E: `play-logs.e2e.ts` 11.0 → 11.1 s, `timeline.e2e.ts` editor 2.5 → 2.6 s, Play 10.9 → 10.5 s. Fast gate green (village WebGL 2 p50 4.6 ms, WebGPU 5.6 ms). Unverified: the 2D arrival's left/right facing by eye (the starter's model reads the same both ways), audio, the export. D291–D294 logged. Owner look pending. |
| 38.13 | Part A (scripts, errors, type check) done 2026-10-21 (`1687cc81`, `472e9d10`): H1 an async hook is switched off once and its promise settled (no unhandled rejection), every `ctx` call made after its hook returned is refused (one log line per script), page = worker in `m38-script-errors`; M1/M2 one Problems line per different script error (kind `script_error_<id>_<hash>`, collision-free), cleared by a restart, at most 32 a run, the export console prints each; M3 a physics port throw in a `ctx` query fails the run (`physics_port_error`) even when caught (physics queries moved to `runtime/physics-queries.ts`: runtime.ts 4,124 → 3,988); M9 the type check on a worker: first check's event-loop stall 615 → 3 ms quiet, 1,852 → 16 ms under the gate (warm 6–40 ms either way); L6 one error-row builder, L7, L11, L12, L13 (trim note within its room), L14 (debugCommands cut gone; sections checked in the playtest e2e). E2E: `playtest.e2e.ts` 16.5 / 15.7 → 16.8 / 15.7 s, `play-logs.e2e.ts` 11.2 → 11.1 s, `script-editor.e2e.ts` 9.8 → 9.8 s. Fast gates green (one `rendering.e2e.ts` dynamic-resolution miss passed on rerun; village WebGL 2 p50 4.6–4.7 ms). Part B done 2026-10-21 (`911dd219` … `43184f6d`): M4 a stopped cutscene gives the input back and switches its characters back to before (one rule, the director's `release`); M5 a cutscene on a character still loading waits for it; L1–L5 (skip faces a later turn, an arrival turn yields to input, no climb while held, a loaded save ends walks, a 2D unplaceable key logs once); M6/M10 3D movers carry a rim rider (footprint support for carry and stilling) and push every character in the step; M7/L9/L10 Apply to prefab takes the nearest copy, nested same-prefab sources refused, `nextLocalNumber`, definition copies keep tags; M8/L8 lifetime test on an exact clock, an expired set stays expired; L15–L18, L21 (exact cut spans, 8.5 vs 7.7 ms on 512 × 64 × 2; `MESH_WELD`; one flush loop; plane rings). New vitest `m38-character-track/director-rules`, rim/push case in `colliders-triggers`, each failing on the old code. E2E unchanged: `timeline.e2e.ts` 2.6 / 10.5 → 2.6 / 10.7 s, `delete-content` 4.8 → 4.9 s, `playtest` 16.8 / 15.7 → 16.8 / 15.9 s, `block-layers` 15.7 → 15.8 s, `physics-3d-colliders` 14.5 → 14.7 s. Fast gate (all five areas): build, lint, vitest 745 files, e2e 37/37 green, village WebGL 2 p50 4.8 ms, WebGPU 5.6 ms. |
| Phase gate | `full --both-renderers` at `51990a82` (2026-10-21 09:17, 2 workers): build, lint, vitest 742 files passed; e2e **389 passed, 1 failed** (project-settings, passed alone in 7.6 s → watch D295) in 21.9 min; **26 min — OVER BUDGET** (15 min; D253 is still the owner's decision); memory peak 6.4 GB. Review: `~/.cache/thirdlight-phase38/review.md` (1 High, 10 Medium) → 38.13. |

## 5. Decision log

- 2026-10-21: Planned from the three games' request docs, checked against
  `8315f041`. The owner made `ctx.scenes.load` / `unload` the standard way
  to change levels and declined TL-REQ-29 and TL-REQ-30 (§1).
- 2026-10-21 (38.1): a prefab keeps each object's *effective* tags (its
  folders' tags included), since a copy has no folder to inherit them from;
  a placed copy (`instantiatePrefab`) carries them as well as a spawned one,
  and `setTags` refuses to free a bit a prefab object still carries. Default
  chosen, owner to confirm.
- 2026-10-21 (38.1): the live tag index is now made for every runtime, not
  only one with a scene catalog, so spawned copies always reach `ctx.tags`.
- 2026-10-21 (38.1, E21): import declarations are matched in code only
  (comments, regular expressions and strings other than a specifier are
  blanked, offsets kept). The dynamic-code patterns (`import(`, `require(`,
  `eval(`, `Function(`) stay textual with the "inside a comment" note: a
  non-literal `import(x)` is caught by nothing else, so a region the
  classifier gets wrong must not hide one.
- 2026-10-21 (38.2): what a hook did before it threw stands (intents it
  committed through `ctx.emit`, sounds, messages, spawns); only its later
  hooks are skipped. `ctx.emit` applies at the call (a transform write moves
  the object at once and later scripts see it in `ctx.intents`), and the
  other channels cannot be taken back either, so discarding only the
  intents would be half a rollback; Unity and Godot also keep what ran
  before an exception. The switch-off point is the throw, which the fixed
  step order makes the same in every replay. Default chosen, owner to
  confirm.
- 2026-10-21 (38.2): only the run's first start fails on an `instantiate`
  that throws (the start scenes' objects). One that throws later (an object
  in a scene loaded mid-run, a spawned copy, a run restart) leaves that
  instance switched off with nothing to dispose, is reported the same way,
  and the load or spawn completes; a later restart tries it again. Every
  Play problem of an exported game now goes to the browser console (script
  errors as errors, the rest as warnings). Default chosen, owner to confirm.
- 2026-10-21 (38.2): `features/debugging.md` and `features/scripting.md`
  said a debug command declared twice and a zero `facing` "stop the game";
  both were already refusals (a log line, no stop), and say so now.
- 2026-10-21 (38.3): a type error makes `check` refuse (`compiled: false`,
  code `behavior_type_error`, `reason` the TypeScript error as `ts2353`),
  since a check is "may I publish this"; a publish (MCP, the editor's
  Publish, a library save's recompiles) and a Play build never type-check,
  so a project whose scripts have type errors still opens and runs. The
  check is `strict` minus `noImplicitAny` and `strictNullChecks`: the
  manual's `step(state, ctx)` is unannotated (the entry's default export is
  checked as `BehaviorSpec<any, any>`, so `ctx` is typed), and nearly every
  `ctx` member is optional in the typings while Play always has it, so null
  checks would flag every documented `ctx.camera.activate(…)`. Visual
  scripts are not type-checked (their source is generated; a type error
  there is an engine bug, covered by the generator's own tests). A script
  library's own check (its tab) is not type-checked yet; a script check
  reports type errors in the libraries it imports, with the library named.
  Default chosen, owner to confirm.
- 2026-10-21 (38.4): two rows are copies when everything but the step and
  the object is equal (code, message, script, reason, source position,
  frames); a log line repeated every step folds too, as the Console's
  "collapse" does in Unity, with the count shown. The ring keeps a folded
  row at its newest copy's place. When the 32-row ring is full a log line
  goes before an error unless log lines hold half the ring or less, so a
  per-step log cannot push errors out and many errors still leave the
  newest 16 log lines. In the bound, log lines go before whole parts
  (renderer, audio, …) and errors only after them. A section is a
  top-level part; `runtime` holds the errors and logs (no separate
  `errors` section), and an observation always carries its header (ids,
  step, state, `error`, `inputMode`, `sound`: the fields its validator
  requires). Default chosen, owner to confirm.
- 2026-10-21 (38.4): the folded-row shape lives in project-model
  (`repeated-rows` subpath, a value subpath for protocol like `limits`),
  since the runtime may not import the protocol; `BEHAVIOR_LOG_CODE` moved
  there with it (runtime re-exports it).
- 2026-10-21 (38.5): a character key is `{time, mode: place | walk, position,
  facing, run, enabled}` (`mode` is the key field the game-mode track already
  has; `facing` in degrees about +Y as `character_place`'s); the track's
  `playerInput: true` lets the player's input move the character, absent
  the track holds it (zero move, no jump) from the play's start to its end,
  as Unity's Timeline owns what it animates. `enabled` is `character_enable`
  (parked: no input, no gravity), not the hold, since a walk needs the
  controller on. Default chosen, owner to confirm.
- 2026-10-21 (38.5): a walk is its controller's move input toward the mark
  (`character_move` in 3D, `control_move` on the 2D plane), slowing inside
  the braking distance its deceleration needs and arriving within 0.1 m
  (`walkTo`'s `arrive` sets it); one that gets no 1 cm closer for a second
  is blocked: it ends there with a log line. A walk still under way when the
  timeline finishes carries on to its mark (the hold lasts until it
  arrives); a skip lands it on its mark (every walk key still to come is a
  placement, the way a transform track jumps to its end); a stop leaves the
  character where it is. Arrival facing turns at the controller's turn
  speed in 3D. Default chosen, owner to confirm.
- 2026-10-21 (38.5): the character director writes a character's channels
  once per step right after the intent phase, so a cutscene or a script
  walk has the last word over a script's own move of that step for that
  character; timeline keys fire at the end of a step and so reach the
  character in the next one (one step after a transform key). A transform
  track's rotation key on a player character turns its controller (the
  quaternion's yaw), and on the 2D plane its position key places it
  (before: a warning and nothing). Default chosen, owner to confirm.
- 2026-10-21 (38.5): on the 2D plane a walk goes along x (the mark's y is
  where the ground is), `run` changes nothing (the 2D controller has one
  speed), and a facing turns the character's face-movement models (90
  right, −90 left; after a walk once it stands still, since they follow its
  motion). `character_enable` now works on the 2D plane and
  `character_place`'s `facing` turns the face-movement models there.
  `ctx.character`'s new calls follow `impulse`'s shape (the controller's
  object last and optional): `place(position, facing?, entityId?)`,
  `walkTo(position, {run, arrive, facing, entityId})` → a handle for
  `walkState(handle)` (walking, arrived, blocked, stopped), `stop`, `turn`,
  `setEnabled`; each has a visual-script node. Default chosen, owner to
  confirm.
- 2026-10-21 (38.6): copies stay copies (no live link, as before): an
  update replaces the definition and rewrites no placed copy; new copies and
  every `ctx.spawn` from the next Play use the new contents. A copy's
  provenance now has to name an existing prefab only, not one of its local
  ids, so an update may drop a part that placed copies still have (before,
  that would have refused the update; Unity would delete the part from every
  instance, which a copy model cannot do). The source may be a copy of the
  same prefab (its provenance says which part each object came from; those
  keep their local ids, the root keeps the old root's), never a copy of
  another prefab; a definition holds no copies, so a prefab can never
  contain itself. Default chosen, owner to confirm.
- 2026-10-21 (38.7): the play content lives exactly as long as its play
  (renewed whenever the play's own inactivity expiry is), with the 15 min
  TTL kept as its least lifetime and the 60 s grace after the play ends; a
  locator read never renews it, so an open browser tab alone does not keep
  a finished play's files served. Default chosen, owner to confirm.
- 2026-10-21 (38.8): deprecated is the scene list as a *move*: the
  `nextScene` UI engine action and `ctx.shell` (`nextScene`, and its reads
  `sceneIndex` / `sceneCount`, which only follow that move), each with one
  Problems line per Play (`deprecated_next_scene`,
  `deprecated_shell_scene_list`), working as before. Not deprecated: the
  list itself (`content.shell.scenes`, its editor and validation), each
  entry's spawn (a kept player arrives there whenever that scene loads,
  `ctx.scenes.load` included), `$flow.shell.scene` for UI documents and
  `world.listedScene` in saves (both read the list's position; reads have no
  Problems line), the read-ahead of the next listed scene, the status line,
  and the `newGame` action's move to the first entry (it has its own line).
  The scene list never defined the start scenes, the scene index or the
  export (those are `content.scenes` / `startScenes`). A start scene that
  stays loaded stays the active look until the game calls
  `ctx.scenes.setActive` (a load that unloads the active scene hands it
  over; TL-REQ-29 declined); the manual says so. Default chosen, owner to
  confirm.
- 2026-10-21 (38.9): on the 2D plane a layer's collision is the 3D
  collision shapes (`collisionLooks`, the same per-type shapes, sloped
  corners, footprints and edge pieces) cut at the plane, not per-shape
  profiles: each crossing triangle gives a segment, slabs between segment
  ends are filled by the nonzero rule (downward faces enter, upward faces
  leave, never below zero), and spans whose top and bottom run on are
  merged. The pieces are convex polygons (a chunk's solid pieces one
  compound collider, each one-way piece its own collider, since the port
  lands a character by a one-way collider's own top), not polylines: the 2D
  world's overlap and inside-ray queries and its internal-edge rule (pieces
  sharing a side are its "tiles in a row") need solids, and a character on
  a polyline seam snags where that rule cannot see. The cut meshes the
  shapes without the "solid neighbour hides my face" rule (it keeps a slope's
  touching face but drops the solid's, which leaves the union open); only
  faces two neighbours share exactly go. Pieces are split to stay within the
  collider extent (64 m). Default chosen, owner to confirm.
- 2026-10-21 (38.9): the plane is a layer setting `planeZ` (world z,
  default 0, stored only when not 0); the cut takes the cell row holding it
  as `ctx.grid.surface` does (floor), so on a row boundary the row in front
  (+z) collides; a plane within 0.1 mm of a boundary is on it. Edge pieces
  on a z line (running along the plane) never collide on the 2D plane; on
  an x line they are thin walls. One-way is a block type flag `oneWay`
  (cells; a 3D project ignores it, as it does `planeZ`), on the port's
  existing one-way colliders, so down + jump drops through. Only the chunk
  row holding the plane (and the one behind when a footprint reaches over)
  is cut, and only the cells that can reach the plane are meshed. Terrain,
  scatter, splines and architecture still collide in 3D only. Default
  chosen, owner to confirm.

- 2026-10-21 (38.10): an unpainted wall with wall paint is the material's
  second layer (`layer: 1`) also under material rules that name only
  tops: each share of a vertex's unpainted paint takes the rules over its
  own base (a top's layer 0, a wall point's layer 1), as terrain tools
  default cliffs to their second layer. Default chosen, owner to confirm.
- 2026-10-21 (38.10): an ETC1S KTX2 without a lossless original is too
  lossy to judge a trim sheet's gutters pixel by pixel; gutters that still
  repeat within the transcoded tolerance pass, differing ones are an info
  line ("not judged", with the largest difference), never a warning. A
  UASTC KTX2 is judged as before. Default chosen, owner to confirm.
- 2026-10-21 (38.10): in 3D a mover moving mostly across keeps its
  velocity during the character sweep (Rapier's drag moves the character
  ahead of it, as in 2D); what the character stands on and movers rising
  or sinking stay at rest as before. Default chosen, owner to confirm.
- 2026-10-21 (38.10, E86): Skyforge's frame-time outliers are measured
  uncapped; the engine's area class shows the same WebGL 2 stalls only
  uncapped (GPU-process back-pressure, D235) and none at the display's
  rate. Back to Skyforge: measure at vsync; no engine D-row.
- 2026-10-21 (38.11): block layers now collide in existing 2D projects
  without a setting (the existing-projects rule covers defaults, not a
  missing capability); `concepts/existing-projects.md` says so and the
  migration notes give the opt-out (a *Play plane z* the layer does not
  reach). Owner to confirm.
- 2026-10-21 (38.12): a script error's play-log row no longer names its
  object in its text (`entityId` / `entityIds` do), so the same throw on
  many copies folds into one row as 38.4 intended; the one Problems line
  per script keeps the first object's name, and the Console lists a row's
  objects. Default chosen, owner to confirm.

- 2026-10-21 (38.13): hooks are synchronous by contract (the typings
  already said so), and `ctx` works only while a hook runs: every function
  reachable from a script's `ctx` (its `emit` and `log`, every engine
  control and the handles they return) is called through a facade that
  throws when no hook is running, and the script's module logs the first
  refusal. Guarding only `ctx.emit` would have left sounds, spawns, saves
  and the rest acting at whatever step the JavaScript job queue drained in,
  which differs between the page and the worker. An async hook is switched
  off at its first call and listed once as async; its promise is settled
  by the engine, so its later rejection is never an unhandled one and is
  not reported (it lands at no fixed step). Reading a plain value
  (`ctx.stepIndex`) is not refused. Measured cost: none in a micro
  benchmark (2 ns raw and guarded); the village class within its limits.
  Default chosen, owner to confirm.
- 2026-10-21 (38.13): the 38.2 line "every Play problem of an exported
  game goes to the console" was true only for a script's first error. Now
  each *different* script error (different text, source position or
  script; copies on many objects are one, as rows fold in the play log) is
  one Problems line per run and one console error in an export; a run
  restart reports again; past 32 different errors one line says the rest
  are in the play log only. The backend still writes each kind once per
  Play. The kind is `script_error_<script id as far as it fits>_<16 hex
  of the exact id and the error>`, so `a-b` and `a_b` (or ids sharing their
  first characters) no longer share a line. Default chosen, owner to
  confirm.
- 2026-10-21 (38.13): an engine failure inside a `ctx` call fails the run
  as before 38.2: a physics port that throws in a query is a
  `PhysicsPortFailure` (an `EngineFailure`, which records itself, so a
  script that catches it cannot hide it). Other engine code that throws a
  plain error inside a call (an argument check, or an engine bug) is still
  reported as that script's error: the two cannot be told apart without
  tagging each engine path, and argument errors must stay the script's.
- 2026-10-21 (38.13): the script type check runs on a worker thread (the
  KTX2 encoder's and the erosion's pattern), kept 60 s after its last
  check; a check that has not answered within twice its checking bound
  (building a program is not bounded inside the compiler) ends the worker
  and answers timed out. From source (tests) it checks in process.
- 2026-10-21 (38.13): a trimmed Play answer's note names at most the eight
  paths that lost the most rows (fewer if it still does not fit its 512 B)
  and counts the rest under "…", so a long note never costs an error; an
  answer still over its bound after that (a kept part near the bound by
  itself) keeps only what its plan never cuts.
- 2026-10-21 (38.13): what a cutscene leaves a character with is one rule,
  the director's `release`: its holds end however it ends; a stop also stops
  its walks where they are and switches each character it switched back to
  what it was before its first switch (a later play that still runs and has
  switched it since decides instead); a finish or skip leaves its last
  keys' state. A run restart forgets everything (controllers start on). A
  timeline has no owning scene (it plays on across scene loads and
  unloads), so there is no scene-unload case; a character whose scene goes
  out while a cutscene holds it is waited for until it comes back or the
  cutscene ends. Default chosen, owner to confirm.
- 2026-10-21 (38.13): a cutscene may name a character that is not in the
  game yet while a scene is loading or asked for in that step (the track
  holds and keys it; it applies once the character arrives); one that never
  becomes a player character once the loads are in is dropped with a log
  line. A loaded save ends every walk, placement and turn (it places the
  characters itself); cutscene holds stay with the cutscenes still playing.
  A turn on arrival ends as soon as the player (or a script's move) moves a
  character nothing holds; the director's hold or walk also holds the climb
  input (`IntentSet.inputHeld`, read by both controllers). A switch asked in
  a step a game mode holds physics waits for the next running step. Default
  chosen, owner to confirm.
- 2026-10-21 (38.13): in 3D what a character stands on is one answer for the
  carry, the sweep's stilling and the re-sweep on a kinematic support: under
  its centre, else under its footprint (a ball 0.9 × its radius at its
  bottom sphere, cast down as far as the centre ray reaches, so a wall at its
  side never counts). A stilled mover gets its velocity back after each
  character's sweep, so every character in the step is pushed. Default
  chosen, owner to confirm.
- 2026-10-21 (38.13): Apply to prefab captures the nearest copy root (the
  object whose provenance names the prefab's root part; an update never
  renames the root part), and `updatePrefab` refuses a source holding
  another copy of the same prefab (`prefab_nested_forbidden`). A definition
  carries an optional `nextLocalNumber` (additive, schema 7): a new part's
  local id is taken at or above it and undo never lowers it, so a dropped
  part's id never names another part. The editor's definition copy keeps
  every field (tags included).
- 2026-10-21 (38.13): a play content set's grace after its play ends never
  reaches past the set's own expiry (the old min restored), so an expired set
  stays expired; since the content's expiry follows the play's, a play that
  ends by itself takes its content with it and only a stop gets the 60 s.
  The lifetime test fakes only `Date` (the in-process backend's clock), each
  check at an exact time, the inactivity end still on its real timer.
- 2026-10-21 (38.13): the 2D cut's segments do cross inside a slab (an edge
  piece reaches into the cells beside its line; a kit's collision mesh can
  reach past its cell), so a slab now ends at its first crossing: the spans
  are exact; only the slab's own segments are scanned (a 512 × 64 × 2 layer
  cuts in about 8.5 ms against 7.7 ms). The 0.1 mm weld step is `MESH_WELD`
  (block-mesh), one flush loop builds the 2D and 3D chunk colliders, and on
  the 2D plane a streamed layer's rings are measured from a source's x and y
  to a chunk's column (terrain stays on x and z).
- 2026-10-21 (38.13): a 2D transform key that cannot place a player
  character (a physics world without placements) logs one line per
  character.
- 2026-10-21, phase review (fresh agent, `~/.cache/thirdlight-phase38/review.md`):
  1 High, 10 Medium, 21 Low. **High:** an async hook kept acting after its
  script was switched off (determinism broken). **Medium:** later errors of a
  script never reached Problems or the export console; Problems codes could
  collide; engine failures inside `ctx` calls were blamed on the script; a
  stopped cutscene left the character disabled; a cutscene lost its hold when
  the character's scene loaded the same step; the 3D mover push missed a
  rider on the rim and every character after the first; Apply to prefab could
  capture a parent copy; the content-lifetime test was timing-fragile; the
  first type check blocked the backend's event loop. All fixed in 38.13
  (part A `1687cc81`, `472e9d10`; part B `911dd219` … `43184f6d`) except
  M3's general case (D296). Rule checks passed: no file grown past 2,000
  lines (`runtime.ts` 4,154 → 3,988), no history comments, no per-project
  caps, boundaries kept, tests at real boundaries. Owner to read: every
  "default chosen, owner to confirm" row above; existing 2D projects'
  block layers now collide; the wall-paint fix changes existing wall-painted
  levels' look; the gate's 26 min against the 15 min budget (D253).
