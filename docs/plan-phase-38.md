# Phase 38 — Requests from Sprout, Skyforge Tactics and Temporal, third batch

Status: in progress (started 2026-10-21).

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
