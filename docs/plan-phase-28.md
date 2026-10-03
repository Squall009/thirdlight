# Phase 28 — Requests from Sprout and Skyforge Tactics, second batch

Status: done 2026-10-03, owner look pending.

Goal: close the engine gaps the two game projects reported after phase 25,
as generic capabilities, and stop the engine deciding a game's flow. Read
`docs/roadmap.md` (principles 1 and 1b) first. Phase 28 starts after phase 27
(the editor layout) and before phase 29 (scalable lighting), so the
batcher and static batching are built against keep-loaded objects and scene
reloads (owner, 2026-10-02).

Sources, checked against main at `d546cff5` (2026-10-02):
- Sprout: `~/projects/sprout/docs/thirdlight_requests.md` (TL-REQ-24 …
  TL-REQ-27 and the "found on the way" notes; uncommitted in Sprout's tree)
- Skyforge Tactics: `~/projects/skyforge-tactics/docs/engine-gaps.md`
  (E56 … E78, and the leftovers of E59 and E63)

The engine never reads either repo. The ids are only here so a request can
be traced back to the game that raised it.

## 1. Owner decisions (2026-10-02)

- **No start-scene rule for the view and the player** (Skyforge E75). The
  engine owns the view; scenes hold shots. An object that lives through
  scene changes carries a keep-loaded flag (Unity `DontDestroyOnLoad`).
  Multiplayer will need several cameras and controllers per scene, so
  nothing in the API assumes one view or one player.
- **The 32-property cap on a behavior declaration goes.** It had no reason
  beyond a sample-sized number; `MAX_DECLARATION_BYTES` (32 KiB) bounds the
  declaration.
- **The engine does not know what a run, a level restart or a new game
  is.** `restartLevel`, `newGame` and `ctx.lifecycle.restart()` are
  deprecated (they keep working, with a one-time Problems line) and are
  removed later. The engine's one primitive is `ctx.scenes.reload(sceneId)`,
  a plain API call like `ctx.scenes.load`, also offered as a UI engine
  action a game may bind. **No engine screen binds it:** the built-in pause
  panel keeps only Resume. A game builds its own restart and new game in
  script (Skyforge's script-built new game is the documented pattern).
- **This phase goes before lighting.** Lighting becomes 29, documentation
  30, decals 31, occlusion culling 32.

## 2. Closed without engine work, or placed elsewhere

| Request | Why |
|---|---|
| E46–E52, E55 | Done in phase 27 (27.1–27.5, 27.18, 27.19). Skyforge's doc still lists some as open; Skyforge re-checks them, and can drop `physics: 'run'` (E51). |
| E62 | Skyforge's own builder, resolved there. |
| E61 (river flow on `water`) | Phase 30 (30.14, river splines; owner 2026-10-03, rivers are an engine tool). |
| E63 part 2 | Done by 27.7 (extract textures). |
| E63 part 3 (`specular` on the graph `pbr` output) | Phase 32 (materials). |
| E54 (scene depth as a material input) | Phase 30 (30.14, river shorelines), reused by projected decals in phase 32. |
| E43, E45, E53 | Phase 29 (29.7, the whole phase, 29.6). |
| E70 (sky rotation), E71 (project quality levels) | Phase 29 (29.11, 29.8). |
| E18 (triangles per LOD in the Inspector) | Phase 31 (31.1). |
| Sprout question 1 (static kit pieces) | Instancing at 4+ copies exists; static batching is 29.10. |
| Sprout question 2 (movers on polygon colliders) | They carry the player (`docs/deployment.md`). Sideways push is unverified. |
| Sprout's unfiled notes: `modes.switch` / `camera.activate` in the transform phase, a mover hook for a door-grind sound | Not taken until Sprout files them. |
| E21 | Not requested again; it stays on the list for a later batch. |
| E37, E40 leftovers | Phases 28b and 30 (2026-10-03). |

## 3. Scene model (item 28.4)

- **The view.** The camera brain already picks the live shot (the enabled
  virtual camera with the highest priority, then the one activated last).
  It now also owns the renderer's eye. Lens settings (field of view, near,
  far) move onto `virtualCamera`, with project defaults. The scene `camera`
  entity goes; the upgrade turns each one into a virtual camera with its
  lens. With no live shot the view falls back to a default pose and Play
  warns, instead of the project being refused. The brain is per view: one
  view today, keyed so a second view (split screen, a networked player's)
  needs no API change.
- **Keep loaded.** An entity flag `keepLoaded` keeps the object, its
  children and its scripts alive across scene loads, unloads, reloads and a
  save's `applyWorld`. It is set in the editor or at run time
  (`ctx.spawn(…, {keepLoaded: true})`, writable on the entity handle). It
  replaces the hard-wired rule that a scene holding the camera or the
  player is never unloaded. Acceptance covers:
  - **duplicates:** a scene loaded again does not create a second copy of a
    kept object whose id is alive; Play refuses one id marked keep-loaded in
    two scenes;
  - **references:** a reference from a kept object to an object of an
    unloaded scene reads as empty, with one Problems line, and never throws;
  - **saves:** the engine saves nothing for kept objects. Loading a save
    only leaves them alone: `applyWorld` unloads the scenes the save
    doesn't list but never a kept object. The game decides which scene
    holds or spawns them before Continue and fills them in from its own save
    schema; old saves still load;
  - **spawns:** each scene's player spawn (`shell.scenes[].spawn`) places a
    kept player on load.
- **Rules checked at Play, not per command.** "One player controller per
  view" and "a view exists" become checks before Play (a Problems line that
  warns or refuses Play), not checks that refuse a single edit through an
  intermediate state. `moveEntities` gains a `sceneId` (a cross-scene move
  that keeps ids and references). A create without `sceneId` or parent
  goes to the scene the editor has active, not "the first start scene";
  over the API it is refused without one.
- **The upgrade runs on open, as today** (owner): opening a game folder
  writes it as schemaVersion 7 (each scene `camera` entity becomes a
  virtual camera with its lens). The game repo commits the result.

## 4. Items

Order: defects first, then the scene model and its flow primitives, then
the API groups, then memory and stats, then acceptance. Each item keeps the
gate green and has a test at its real boundary (Playwright for editor
surfaces). Format changes share one bump: `project.json` schemaVersion 7
(26 made it 6), with an upgrade on load.

| Item | What | Requests |
|---|---|---|
| 28.0 | This plan, its rows in `docs/STATUS.md` and `docs/roadmap.md`, the defects in the audit list (D125–D135), and the renumbering of 29–32. | — |
| 28.1 | **Small defects:**<br>• Counter names have one rule, defined once in project-model and used by `ctx.game.add`, `setCounters` and the save loader. `add` refuses (returns false, one Problems line) a name the save would refuse; a load never fails as a whole on one bad name (D125).<br>• Play diagnostics past the bridge's bound trim the log (oldest entries first) and say how many were dropped, instead of `relay_failed` (D128).<br>• The 3D character's penetration counter counts only real depenetration, not a grounded step stopped by the floor; diagnostics report the deepest overlap's entity pair (D129).<br>• A script call the runtime refuses (an invalid debug command, a refused intent) returns false and logs, instead of failing the run (D130).<br>• The dialogue runner focuses `box` and `choice` in whichever document `dialogueSettings.document` names, not only `tl-dialogue` (D132).<br>• `createEntity` accepts every component `setComponent` accepts (`effect` first); a test compares the two lists (D133).<br>• The upload route refuses a file name that is hidden (a leading dot), a `.tlasset` sidecar or a `*.scene.json` (D83, owner).<br>• A model may hold 256 animations (was 64; images stay at 64 per model, owner): `ASSET_METRIC_CAPS.animations` (D84).<br>• D104's open half: find and fix why a KTX2 image transcoded to plain RGBA stops the editor worker's renderer (a GPU without compressed formats meets it); a thumbnail test forces the RGBA path. | TL-REQ-24, E77, E64.5, E69, E64.4, E59.2, Sprout note |
| 28.2 | **Script sounds have an owner.** A sound or music track a script starts belongs to the script's object by default (`{owner: 'scene'}` or `{owner: 'none'}` on play): it stops (with the play's fade-out) when that object unloads or its scene unloads or reloads. `ctx.audio.stopAll(bus?, fade?)`. While the deprecated run restart exists it stops every script sound. A play dropped for the voice cap writes one Problems line per Play. Acceptance: 20 scenes each starting a loop leave at most one loop playing (D126). | TL-REQ-27, E66 |
| 28.3 | **A fixed effect-light pool.** The effect light pool's lights are created dark when Play (and the export) starts, so the number of lights in the scene never changes during play and no material recompiles. Acceptance: visible light-emitting effects rising from 1 to 16 compile nothing after the first frame (D127). | TL-REQ-25 |
| 28.4 | **Scene model** (§3): the engine-owned view, `keepLoaded`, rules checked at Play, a cross-scene `moveEntities`, no primary-scene default for creates. Editor: the flag in the Inspector, kept objects marked in the hierarchy. Both games' upgrade paths tested on fixtures shaped like theirs (a camera in a start scene; a title scene holding the camera and player). | E75 |
| 28.5 | **Scene reload, and the run restart deprecated.** `ctx.scenes.reload(sceneId)`, committed at the step boundary like `load`: the scene's objects return to how they were authored, copies spawned in it go, its scripts start over through their reset hook, its sounds stop (28.2); kept objects, `ctx.save`, counters and the other scenes are untouched. `reloadScene` as a UI engine action (with a scene id, default the document's own scene). The built-in pause panel keeps only Resume. `restartLevel`, `newGame` and `ctx.lifecycle.restart()` keep working and write one Problems line per Play naming the replacement; their docs move to the migration notes, with Skyforge's script-built new game as the pattern. | Sprout note, owner |
| 28.6 | **Behavior property cap removed.** `MAX_PROPERTIES` goes from content-limits, the commands, the editor and the schema; the declaration byte budget governs. A test declares 100 properties and edits one in the Inspector. | Sprout note, owner |
| 28.7 | **Scripting API:**<br>• `ctx.world.transform(id)` is documented as local to the parent; `ctx.world.worldTransform(id)` (or `{space: 'world'}`) returns the composed world transform. Acceptance: for a child of a moved, rotated, scaled parent the world read equals the rendered position (D134 is the doc half).<br>• `ctx.input.anyPressed()`: any key, mouse or pad button this step, with its device.<br>• **Runtime material swap:** `materials` is writable on the entity handle (`set('materials', {slot: materialId})`), and on instance sets and block types; a timeline `materialSwap` key. A swap loads the material through the resource manager before it shows.<br>• `ctx.spawn` takes per-copy property values.<br>• Saves: `character_place` takes a `facing`, and the save's `world.character` keeps it; a slot carries a small `meta` object (≤ 8 short text keys) returned by `ctx.saves.slots()`; a UI `image` can show a save slot's thumbnail. | TL-REQ-26, E68, E76, Sprout note, E64.1–3 |
| 28.8 | **Game UI:**<br>• UI sounds: `sounds {click, hover, focus}` per widget and per style, with a document-wide default, played on the `ui` bus, for engine actions too.<br>• `scale.mode` `cover` and `expand`; `ctx.ui.view()` and `$flow.view` give `{width, height, aspect, pixelRatio}`.<br>• Bindable `offset`, `opacity` and `rotation` on widgets.<br>• A bound list keeps its item widgets and the focus when only item values change (keyed by index or `itemKey`); `ctx.ui.focus` takes an `index` (D131).<br>• Shell screens may let scripts keep ticking (`simulate: 'scripts'`: ungrouped behaviors step, physics and groups held, as a mode with `groups: []` and `physics: 'hold'`).<br>• Play screenshots include the UI layer (an option, default on). | E59.1, E59.3, E73, E67, E65 |
| 28.9 | **Animation:**<br>• `blend1d` children carry the ground speed they were authored for, and the tree scales time so the blended speed matches the parameter (Unity's homogeneous speed).<br>• The `animator` component takes a start time (normalized) or `randomStart` from the seeded game RNG; `play(state, fade, layer, time)` for scripts.<br>• A look-at constraint on the animator: a bone chain (head, optionally neck and chest), a target (entity or point), a weight (or a float parameter), per-bone yaw and pitch limits and a turn speed, applied after the clip pose; scripts set target and weight. | E56, E57, E58 |
| 28.10 | **Colliders:** a `center` and optional rotation on every collider shape; compound colliders (a list of shapes, or `{type: 'model'}`: every convex part of the model's `_COL` node, resolved at build); colliders on child entities, which follow their parent (static, or kinematic when the parent is moved by a script or timeline); the `_COL` conversion is a command, so the API can do what the editor's button does.<br>• **Scene view:** collider outlines are off by default (owner); selecting an object shows its own colliders (every shape of a compound, and its child colliders); View → Collider outlines still shows all of them. Playwright: no outlines on open, one object's outlines on select, all with the toggle. | E60, owner |
| 28.11 | **Texture memory and stats:**<br>• Extract textures decodes WebP (and every other non-KTX2 image the importer reads) and encodes it to KTX2 by its use, as it does PNG and JPEG; a lossless PNG of the same name beside the model is preferred. A project setting makes extraction the default for every model, older imports included, and Problems lists models still holding embedded images.<br>• Standard-shader project materials share one texture object per (asset, colour space, wrap, tiling) instead of cloning per model file. Acceptance: one material on 14 models holds one GPU copy (`copies: 1`).<br>• `ctx.stats` and `$flow.stats` (read-only): frame time (CPU ms; GPU ms where timestamp queries exist), fps, average and worst over a window, draw calls, triangles, resident texture and geometry bytes against the budget, entity count, quality level. A project setting (and key) shows a built-in stats overlay in Play and the export.<br>• Play diagnostics carry the environment renderer's post passes, quality level and the same frame times. | E78, E63.1, E74, E72 |
| 28.12 | **Saves on the player's device.** Saves live in the browser's storage for the game's site (IndexedDB `thirdlight-saves`, keys `<ns>:slot:<n>:meta|body|thumb`; settings in `localStorage`; `<ns>` is `thirdlight:<projectId>` in an export, `thirdlight-play:<projectId>` in Play).<br>• **`world` becomes an opt-in section** like the others. Today every save writes it and every load applies it: it loads and unloads scenes to the saved list and places the character, so it decides where a game stands after Continue. As a section a game lists it or restores scenes and its player itself from its own document (`ctx.scenes.load`, `character_place` with facing from 28.7). Projects without `sections` listing it keep it for now with a one-time Problems line (both games rely on it); the default changes when neither does, like the deprecated actions of 28.5. A kept object (28.4) is never destroyed by it.<br>• **Persistent storage:** the host asks for it (`navigator.storage.persist()`) at the first save, so the browser doesn't evict saves under disk pressure; whether it was granted, and `navigator.storage.estimate()`'s usage and quota, are in diagnostics and `ctx.saves`.<br>• **A slot is written in one transaction** (body, thumbnail and metadata together), so a refused or interrupted write leaves the previous save whole (D135).<br>• **A full disk is a clear result:** a quota refusal answers `{ok: false, code: 'storage_full'}` (and `storage_unavailable` without IndexedDB) next to the browser's text, for the game's own message; a settings write `localStorage` refuses is caught and reported the same way instead of throwing. Acceptance: a save refused for quota (a test backend that refuses) reports `storage_full` and the slot still loads its earlier save; a game without `world` in its sections loads a save without any scene change. | owner |
| 28.13 | **Acceptance.** Each request's acceptance above as a test at its boundary; `docs/deployment.md` updated (and the migration notes for the deprecated actions); `tools/gate.sh full` green. Then the phase review. | — |

## 5. Progress

| Item | Status |
|---|---|
| 28.0 | done 2026-10-02 |
| 28.1 | done 2026-10-02 — counter-name rule, refused script calls return false, Play diagnostics trimmed, real-overlap penetration count, dialogue focus in any document, createEntity takes setComponent's components, upload names, 256 animations, RGBA KTX2 as data textures (D83, D84, D104, D125, D128–D130, D132, D133) |
| 28.2 | done 2026-10-02 — script sounds owned by their object (or scene, or nothing), stopped with the play's fade-out when it leaves; `ctx.audio.stopAll`; the run restart stops every script sound; one Problems line per Play for voice-cap drops; 20 scenes leave one loop (D126) |
| 28.3 | done 2026-10-02 — the effect light pool's 16 lights are added dark before the first frame of a game whose effects emit light (Play, export, Scene view, Effect tab), never mid-play; e2e: lights rising 1 → 16 build no program or pipeline in Play and the export (D127) |
| 28.4 | done 2026-10-02 — schemaVersion 7 (scene cameras upgraded to lowest-priority fixed shots, their lens the project's camera settings; camera and player keep loaded); the camera brain owns the view per view key (default pose + Play warning without a live shot); `keepLoaded` (flag, spawn option, handle write; survives unload/reload/applyWorld, no second copy, references read empty with a Problems line, listed spawns place a kept player); start rules checked at Play/export; cross-scene `moveEntities {sceneId}`; creates need a scene over the API; Inspector flag, hierarchy marker, cross-scene drag |
| 28.5 | done 2026-10-02 — `ctx.scenes.reload(sceneId)` and the `reloadScene` UI engine action (`scene`, default the active scene) at the step boundary: objects as authored, copies spawned in the scene gone, its scripts made again, its sounds stopped, kept objects/`ctx.save`/counters/other scenes untouched; the engine pause panel has only Resume; `restartLevel`, `newGame`, `ctx.lifecycle.restart()` work with one Problems line per Play; migration notes; `resume` leaves the shell title (D137) |
| 28.6 | done 2026-10-02 — no count cap on a behavior's properties (model, commands, compiler, code-declaration reader, runtime, visual-script variables, editor, schema); `MAX_DECLARATION_BYTES` (32 KiB, measured once by `declarationBytes`) refuses with the size; e2e: 100 properties, one edited in the Inspector, a 101st added in the declaration editor, both survive a backend restart |
| 28.7 | done 2026-10-03 — `ctx.world.worldTransform` / `{space: 'world'}` (`transform` documented as local, D134); `ctx.input.anyPressed()` (`{device, code}` of any key, mouse or pad button, bound or not); `ctx.spawn` per-copy `properties` (saved with spawned copies); runtime material swaps (entity handle `set('materials', …)` on models, boxes, instance sets; `ctx.grid.setTypeMaterials`; timeline `materialSwap` key) shown only once their textures are loaded; `character_place` `facing` and `world.character.facing`; slot `meta` (≤ 8 short texts) from `slots()`; UI image `saveSlot` shows a slot's picture |
| 28.8 | done 2026-10-03 — UI sounds `{click, hover, focus}` per widget, per style and as the document's default, on the `ui` bus (engine actions click too); scale modes `cover` and `expand`; `ctx.ui.view()` / `$flow.view`; bindable `offset`, `opacity`, `rotation`; bound lists keep their item widgets and focus (by index or `itemKey`), `ctx.ui.focus(doc, widget, index)` (D131); shell `simulate: {screen: 'scripts'}`; Play screenshots draw the UI and overlays over the frame (`ui: false` for the frame alone) |
| 28.9 | done 2026-10-03 — blend clips carry their authored ground speed and a tree with one on every clip plays at the rate that covers its parameter (Unity's homogeneous speed); `animator.startTime` and `randomStart` (from `random_seed` and the object id), `play(state, fade, layer, time)` for scripts; a look-at constraint on the animator (head, optional neck and chest with yaw/pitch limits, target object or point, weight × float parameter, turn speed, after the clip pose; `setLookTarget`/`setLookPoint`/`setLookWeight`); measured in Play: blended ground rate, random starts and their replay, the drawn head bone's turn, limit and return |
| 28.10 | done 2026-10-03 — every collider shape takes a `center` and a `rotation`; `compound` (a list of shapes on one body) and `model` (each mesh of the object's model's `_COL` node a convex hull, read when the game is built: manifest `modelColliders`); colliders on child objects where their parents put them, kinematic once a parent is moved by a script, a timeline or a mover; `colliderFromModel` (box, convex, mesh, polygon, compound) is the editor's button over HTTP/MCP; Scene view: no collider outlines until asked for, the selection's (and its children's) always; D138 logged |
| 28.11 | done 2026-10-03 — extract textures decodes WebP (libwebp, pinned) and encodes every non-KTX2 image to KTX2 by its use, from the lossless PNG of the image's name and size beside the model (or in its `textures/`) when one is there; setting `import_extract_textures` extracts every model, older imports included (where their GLB file is), and Problems lists models still holding images (`models_hold_images`); standard-shader project materials share one prepared texture per (texture, colour space, wrap, tiling, offset): one material on 14 model files holds one copy (14 before); `ctx.stats` / `$flow.stats` (fps, frame/CPU/GPU ms average and worst over 500 ms, GPU null where not measured, draw calls, triangles, texture bytes against the budget, geometry bytes, objects, quality); setting `stats_overlay` (F3) shows a built-in overlay in Play and the export; Play diagnostics carry `frameTimes` and the environment renderer's passes, quality, samples and fallback |
| 28.12 | done 2026-10-03 — saves in the player's browser: a slot's metadata, body and picture in one IndexedDB transaction (a write refused for quota or cut off leaves the earlier save loadable, D135); refusals answer `{ok: false, code: storage_full, storage_unavailable or storage_failed, reason}` (the browser's text), a settings document localStorage refuses too (`op: 'settings'`); persistent storage asked at the first save, `ctx.saves.storage()` / observation / Play diagnostics carry `persisted`, `usage`, `quota`; `world` is a save section (listed, or `legacyWorld: false` to restore scenes in the game; neither keeps the always-on world with one `deprecated_save_world` Problems line per Play), never destroys a kept object; a game without it loads any save without a scene change; migration notes |
| 28.13 | done 2026-10-03 (owner look pending) — full gate `--both-renderers` GREEN first run (437 e2e, 530 vitest, 32 min, peak 6.8 GB); independent review fixed in 2b2dbc53 (D139–D144), D145/D146 open. Acceptance: map of every acceptance to its boundary test; new: kept objects in Play (unload/load/reload as one object, references read empty with one Problems line, listed spawn), a repeated kept id taken in with new ids, `createEntity` components over HTTP, sound owners' fade-out / `none` / run restart, no penetration counted at rest; `docs/deployment.md`: UI, colliders, model textures, stats, v7 upgrade and Problems lines in the migration notes. Unverified: sounds by ear (UI sounds, owner fade-outs, `stopAll`, the restart silence); by eye the default-pose framing, kept objects across unload/reload, block-type and instance-set swaps (unit tests only), look-at, blend foot sliding, collider outlines, screenshot and stats overlays; `moveFrame` feel after the upgrade in both games; the `persist()` prompt |
| 28.14 | owner 2026-10-03: one-time e2e prune — phase-end gate ≤ 15 min; then an e2e time budget per phase |
| 28.15 | owner 2026-10-03: `quitToTitle` deprecated like `newGame` (D145); games load their title scene with the scene API |
| 28.16 | owner 2026-10-03: several player controllers per view (local co-op): no one-controller check, no single controller id (D146) |

## 6. Decision log

- 2026-10-02: planned from the triage of both games' request docs (owner).
  The owner's decisions are §1. Placed outside this phase: §2.
- 2026-10-02: the deprecated actions are not removed in this phase. Sprout
  uses `newGame` in its UI documents and has to move to its own new game
  first; the removal is planned once neither game uses them.
- 2026-10-02: three.js 0.186.1 is the newest release (npm), the version
  in the lockfile; nothing to take at the start of the phase.
- 2026-10-02: kept objects get no save section of their own (owner). Every
  game loads a scene before Continue; the game decides where kept objects
  are held or spawned and restores their state from its own save schema.
  An engine section would restore them a second time and fight a game that
  builds them from save data. The engine only guarantees that loading a
  save never destroys them.
- 2026-10-02: saves added as 28.12 (owner): the engine's `world` block
  becomes an opt-in section (it decides where a game stands after Continue),
  the host asks for persistent storage, and a full disk is a clear save
  result. Reading the write path for the last showed D135 (a slot written in
  three transactions). Exporting and importing a slot as a file, and a
  swappable storage backend for a desktop or cloud target, are not taken.
- 2026-10-02 (owner): projects upgrade to schemaVersion 7 on open, as
  before; the game repos commit the result. D83 accepted (the upload route
  refuses hidden, sidecar and scene file names), D84 decided (animations
  per model 256, images stay 64), both in 28.1 with D104's open half.
  Collider outlines off by default, the selection's shown (28.10).
- 2026-10-02 (28.1): counters — the save loader's 256-counter count check
  went with the name rule (the 1 MiB save document bounds it); a counter
  name is checked where it is made and skipped (logged) where it is loaded.
- 2026-10-02 (28.1): refused script calls — `ctx.emit` (false) and
  `ctx.debug.command` (no calls) refuse and log once per distinct refusal;
  a scene or spawn call with a bad argument still stops the run (a wrong id
  is a script error, as an engine API throws on one).
- 2026-10-02 (28.1): `createEntity` takes `setComponent`'s list minus what
  `kind` makes (box, model) and the scene camera (no command creates one; it
  goes in 28.4).
- 2026-10-02 (28.1): uploads also refuse resource file names
  (`<name>.<kind>.json`): like a scene or sidecar, the file check would take
  them in as project data. A model's animation channels rose with its
  animations (4,096 → 16,384: 64 a clip on average, as before).
- 2026-10-02 (28.1): Play diagnostics trim to the bound in the page (log
  first, then other lists, then whole parts) with a `trimmed` note; no
  paging. The 3D penetration counter counts steps begun in a real overlap
  (the 2D port's unchanged: not requested).
- 2026-10-02 (28.1): D104's cause — three r186's KTX2 loader wraps an RGBA
  transcode as a `CompressedTexture`; WebGPU throws in the draw (no block
  size) and WebGL refuses the compressed upload. RGBA transcodes become
  `DataTexture`s (streamed ones `StreamedDataTexture`) rather than patching
  the renderer.
- 2026-10-02 (28.2): script sounds — the owner is resolved when the sound
  starts (`object` default, `scene`, `none`); a spawned copy has no scene, so
  its `scene` sounds go with the copy. The owner's stop fades over the play's
  `fadeOut` (default 0, as Unity and Godot stop an object's sounds with it);
  a music track set with `music()` has an owner too and is released over its
  own fade. `stopAll(bus?, fade?)` stops every voice on the bus whoever
  started it and releases the scripts' music on the music bus or all. The
  run restart resets the mixer (voices, music, duck, mix), as a new run.
  Event cues, timelines and dialogue keep owning nothing.
- 2026-10-02 (28.2): a running game's problems reach Problems through a new
  bridge/WS message (`tl.play.problem` → `play.problem`); the backend writes
  one line per kind and Play (at most `PLAY_PROBLEM_KINDS_MAX` kinds). The
  voice cap is its first kind; 28.5's deprecation lines can use it.
- 2026-10-02 (28.3): the pool is reserved only when an effect of the game
  has a Lights block (a game without one pays no shading for 16 dark lights);
  an edit that adds the first Lights block adds the pool once (one
  recompile, edit time only). The pool size `EFFECT_LIGHT_LIMIT` moved to
  project-model, where it is also the Lights block's `maxLights` max.
- 2026-10-02 (28.4): the view — the scene `camera` component is gone from
  the format; the upgrade (`upgrade-scene-model.ts`, the phase's one v7
  step) turns it into a `fixed` shot at the lowest priority (-1000, so any
  camera a game has goes live over it, as before) and moves a non-default
  lens to three new settings (`camera_fov_deg/near_m/far_m`, Unity's and
  Godot's per-camera lens with a project default). The default pose without
  a live shot is 1.6 m up, 6 m back, level, looking at the origin; Play and
  the export warn, the runtime logs. A build or test snapshot that still
  holds a scene camera plays it as that shot (`sceneCamerasAsShots`). Views
  are keyed in the runtime/host API (`DEFAULT_VIEW_ID`); `ctx.camera` drives
  the main view (a second view adds an option there, not a new API). A 3D
  character moves relative to the live shot's heading, the upgraded camera
  included (it used world axes without virtual cameras). Amended by the
  28.4 fix below: an upgrade must not change how a game plays.
- 2026-10-02 (28.4): keep loaded follows Unity's DontDestroyOnLoad: an object
  under a parent that is not kept is not kept (Play warns); a folder passes
  the flag down. The upgrade marks the camera and the start scenes' players
  (their top object) kept, since the runtime never unloaded them; new
  projects take the same shape. The player body is still made at start: a
  scene holding a player that is not kept does not unload, and a later scene
  cannot bring one (Play warns). A kept object whose scene went is listed
  with the spawned copies (renderers and audio follow it there) and goes at
  a run restart (its start scene brings it back). References into a scene
  that went are found by id in the kept object's components and reported
  once per Play through a new runtime → page → Problems channel
  (`takeProblems`, the one 28.5's deprecation lines can use).
- 2026-10-02 (28.4): creates — no default scene: the editor sends its active
  scene (`createEntities` too); the API refuses a create without `sceneId`
  or a parent (`field_missing /args/sceneId`). Cross-scene `moveEntities`
  edits two scene files in one transaction; the pure command layer gets the
  second scene as `otherScene` and records `moveEntitiesScene` with its
  inverse. Prefabs may carry a camera (the capture refusal was for the scene
  camera).
- 2026-10-02 (28.4 fix, D136): the controller has a move frame,
  `moveFrame: 'view' | 'world'` (Unity's and Godot's controllers read input
  in camera or world space); `view` stays the default (new projects move
  relative to the camera). The v7 upgrade writes `world` on every controller
  of a 3D project that had no virtual camera (scenes and prefabs): it moved
  along the world axes before. A project with virtual cameras keeps `view`;
  only where its old scene camera, turned about Y, is the one live shot does
  the input change, and the upgrade note names that camera. Fixtures shaped
  like both games (`fixtures/phase28/move-frame`) carry paths recorded on the
  v6 engine; the upgraded projects walk them.
- 2026-10-02 (28.5): a reload is an unload and a load of the scene's own
  authored entities at one step boundary (no fetch; where it was loaded with
  `at`). Its scripts start over as at a run restart — disposed and made
  again, no `onDisable`/`onDestroy` (the objects come straight back),
  `onEnable` again, their random streams from the start. Copies "spawned in
  it" are those a script on one of its objects spawned (a copy spawned by a
  copy takes its scene; a kept or scene-less spawner gives none), as a Godot
  scene frees the nodes its scripts added; an unload leaves copies as before.
  Like unload it is refused for a scene holding a player that is not kept; an
  unloaded scene loads, one being loaded is left to arrive, and of an unload
  and a reload in one step the last wins. A kept player arrives at the
  scene's listed spawn, as on a load.
- 2026-10-02 (28.5): `reloadScene` takes `scene`; without it the active
  scene (UI documents have no scene of their own; reloading the active scene
  is Unity's restart idiom). Neither a reload nor the button resumes a paused
  game: a button lists `resume` too when it should.
- 2026-10-02 (28.5): the deprecated restarts ride the existing channels: a
  restart UI event carries the action that asked (`restartLevel`, `newGame`,
  `quitToTitle`; the tool's replay none), the runtime writes one problem per
  kind (`deprecated_restart_level`, `deprecated_new_game`,
  `deprecated_lifecycle_restart`) through `takeProblems`, and Play's
  Problems shows one line per Play. `quitToTitle` is not deprecated (not in
  the owner's list) though it restarts the run too. The table of deprecated
  actions and their replacements is project-model's
  `UI_DEPRECATED_ENGINE_ACTIONS` (the editor marks them "(deprecated)").
- 2026-10-02 (28.5): `resume` now leaves the shell's title for play (it did
  nothing there): with `newGame` deprecated, a game whose script builds its
  new game had no other way off the title. The engine pause panel lost
  Restart. Found on the way: a start scene unloaded and loaded again lost its
  kept objects at the next run restart (D137, fixed: an arriving scene takes
  its scene-less kept objects back).
- 2026-10-02 (28.6): the count caps went everywhere they were copied, not
  only `MAX_PROPERTIES`: the compiler's `properties` limit (so the compile
  recipe digest changed once: cached builds recompile), the code-declaration
  reader's 64, the runtime host's 32 and the visual-script variable limit.
  One measure, `declarationBytes` (2-space JSON, as stored), serves the model,
  the command and the compiler (the compiler measured compact JSON before).
  The schema's `minItems: 1` went too (a behavior may declare none).
- 2026-10-03 (28.7): world transforms — `transform` stays local (what the
  Inspector shows, Godot's `transform`); `worldTransform` (or `{space:
  'world'}`) is the composed matrix decomposed, its scale the length of each
  world axis under a turned, unevenly scaled parent (Unity's `lossyScale`).
- 2026-10-03 (28.7): `anyPressed()` answers the first key or pad button that
  went down since the last sample (a new optional input-frame field `press`,
  so replays hold), else a pressed mouse button (the pointer's edges), as
  `{device: keyboard | mouse | gamepad, code}` or null; any standard pad
  counts, active or not, so a "press any button" prompt wakes a pad.
- 2026-10-03 (28.7): spawn `properties` are the root script's values (an
  object carries one script) over the prefab's, checked against its
  declaration like the Inspector (a private or undeclared key is a script
  error); a save's `spawned` section keeps them.
- 2026-10-03 (28.7): material swaps are simulation state (the step's end,
  the digest, a save's `components` fields and `grid` section, cleared by a
  new run) and visual only; static objects may swap (no static batching yet;
  lightmaps go back on). A swap may name any material the game ships — one
  an object or a timeline uses, or one with an address or label (the
  snapshot carries the ids). The renderer keeps what an object wore until
  the new materials' textures are decoded and held (resource manager), then
  puts them on — a newer swap replaces one still loading; reverting loads
  the authored ones the same way. Block types swap through `ctx.grid`
  (`setTypeMaterials`, every layer's cells re-mesh once loaded); timelines
  get a discrete `materialSwap` track. The v7 script-access table now lists
  `materials` as writable (additive: no format step).
- 2026-10-03 (28.7): saves — `character_place.facing` is in degrees about +Y
  (what `characterState().facing` reads; 3D only), kept as optional
  `world.character.facing` (older saves load and keep the facing as it is).
  A slot's `meta` is at most 8 identifier names → texts of up to 128
  characters (`SAVE_LIMITS.metaKeys/metaKeyChars/metaText`), stored in the
  slot's metadata record (the `:meta` key 28.12 writes in its one
  transaction). A UI image shows a slot's picture through `saveSlot` (a
  number or binding) in place of `image`; it refreshes when the slot is
  saved again.
- 2026-10-03 (28.8): lists — items are kept by index unless `itemKey` names
  one field of each item (React's `key`; a nested path was not needed); a
  kept item only reads its values again; a focused item that goes passes the
  focus to the item now at its index (else the last), not the document's
  first widget. Widget `opacity` multiplies with the style's and a fade (a
  CSS filter, Unity's CanvasGroup alpha); `rotation` turns about the pivot (a
  flowed child about its centre). A bound offset applies to panel children,
  as a numeric one does. `expand` fits the reference and grows the box to
  the view's shape (Unity's CanvasScaler expand); `cover` fills it.
- 2026-10-03 (28.8): `ctx.ui.view()` is presentation, not simulation state
  (like the camera's aspect, which a script already read): the host reports
  the view it draws over each frame; it is not in the digest or a save, and
  a replay in another window reads that window's. 1280 × 720 at 1 until
  reported.
- 2026-10-03 (28.8): UI sounds — a widget's own (or its own style's), then
  its named styles' (the last first), then the document's. Click plays on
  any use (button, Enter, pad A, an input's submit, whatever the action);
  hover when the pointer comes over an enabled widget that takes it; focus
  when the keyboard, a gamepad or a script moves the focus (not the pointer,
  which plays hover; not a document's first focus when shown). No cancel
  sound (no field asked for). The sounds are project-wide assets (preloaded
  by their own setting).
- 2026-10-03 (28.8): `simulate` is a map beside `screens`
  (`shell.simulate: {title: 'scripts'}`, default `pause`) rather than an
  object per screen entry, so `screens` keeps its shape and the descriptor
  editor shows it as one select per screen. A held screen rides on the input
  frame as a `hold` UI event (replays hold); it holds whatever the mode says
  and survives a run restart (it is the host's screen). Format additive (no
  upgrade step); the page's settle steps before the shell opens run as they
  did under a paused title.
- 2026-10-03 (28.8): screenshots — the page draws its container (the UI
  documents, fades, letterbox, pause panel; not the canvas) into an SVG
  `foreignObject` with its style rules, its `blob:` images as `data:` URLs
  and the project fonts as `@font-face` rules, over the frame; on by
  default, `ui: false` (HTTP, MCP) for the frame alone. Tween animations show
  their end styles. The Play toolbar's renderer label 28.7 saw as
  "pending (initialising)" is a 2 s poll of Play diagnostics: it reads
  "(ready)" within one poll of the first frame (e2e), so no defect.
- 2026-10-03 (28.9): ground speed — clip i plays `rate·dᵢ/L` of its own
  seconds a second, so the blend covers rate·Σwᵢsᵢdᵢ/L; the tree scales its
  rate so that equals the parameter (exact for clips of different lengths,
  not only at the thresholds). It applies only when every clip of the tree has
  a speed (a tree being filled in clip by clip plays as authored: no
  all-or-none refusal mid-edit); where the blended speed is 0 the tree plays as
  authored. State speed, speed parameter and the animator's speed multiply on
  top. A transition `cycleOffset` (asked "optionally") is not taken.
- 2026-10-03 (28.9): start time — normalized, the same for every layer's entry
  state; `randomStart` is the first draw of an engine stream seeded by
  `random_seed`, the purpose and the object id (not a shared stream: a copy's
  start never depends on load order, and scripts' streams never shift); a
  reload and a run restart start a copy at the same place. Setting both is
  refused (the Inspector hides the start time under a random start).
  `play(..., time)` takes a normalized time ≥ 0 (Unity's normalizedTime).
- 2026-10-03 (28.9): look-at — simulation state, stepped after the animator
  with the fixed step (replays and sockets agree), on the model's rig (rigs
  now ship for projects with a look-at, as for sockets). Angles in the model's
  space from its +Z at the head bone as the clips pose it (the chest's own
  turn moving the head is not iterated); the turn is split over the chain in
  proportion to the limits (every bone within its own; the sum is the reach)
  and composed so the head ends at exactly yaw·pitch; the current angles move
  as one step in yaw–pitch space at the turn speed (default 360°/s), toward 0
  at weight 0 or with no target. Scripts get `setLookTarget(id | null)`,
  `setLookPoint([x,y,z])` and `setLookWeight(w)` (the visual-script generator
  needs one type per argument, so target and point are two calls). Play's
  observation with an `entityId` gives the pose (`look`) and the drawn bones
  (`renderedBones`), which the e2e measures.
- 2026-10-03 (28.10): shapes — every primitive takes `center` [x, y, z] (a
  plane reads x, y) and `rotation` [x, y, z, w] (about Z only on a plane);
  `{type: 'compound', shapes}` lists primitives (no nesting, no count of its
  own: its hull and mesh points count toward the scene's 3D point budget, the
  request size bounds one edit); `{type: 'model'}` needs a model on the same
  object. A turned shape under an uneven scale is built from its moved points
  (a box becomes its 8 corners' hull), Unity's approximation of a sheared
  collider. A model's parts: each mesh primitive under its piece's `<piece>_COL`
  node (every `_COL` node of a model shown whole) is one convex hull of at most
  64 points (Unreal's UCX_, Godot's -convcolonly), read from the file when the
  game is built into the manifest's `modelColliders` (like rigs: the runtime
  never reads a model); Draco or flat parts are left out and Play/export warn
  `collider_model`. The meshopt decoder moved to project-model (`./meshopt`)
  so the build and the importer decode with one.
- 2026-10-03 (28.10): colliders on children are allowed (not the controller,
  not a mover's own collider: their systems pose them in world space). They are
  placed where their parents put them and follow once the object or a parent is
  moved by something other than physics — a script owning its transform, a
  timeline's transform track, a mover — as kinematic bodies posed every step
  (Unity's moving collider on a kinematic body, Godot's AnimatableBody); a mesh
  collider stays static (one log line). They push the player as a mover does
  (D138: in 3D with the character controller the push leaves the player about
  0.1 m inside, movers too). On the 2D plane children's colliders are placed at
  load and stay (its scripts drive no collider).
- 2026-10-03 (28.10): `colliderFromModel {entityId, kind}` — box (around the
  LOD0 render geometry, now centred where it is with `center`, where the
  editor made an 8-corner hull), convex or mesh (the `_COL` node, else the
  geometry; 3D), polygon (the plane), compound (the `_COL` parts). The host
  reads the model's latest version; one setComponent change (one undo). The 3D
  editor buttons send it (plus "Compound of _COL parts"); the plane's outline
  buttons stay in the editor: they measure the drawn model with its children.
- 2026-10-03 (28.10): outlines — the Scene view's toggle is the Gizmos menu's
  "Collider outlines" (the editor has no View menu; Gizmos is the Scene view's),
  off by default; the selected object's outlines and its children's are always
  drawn (a player's capsule too, and clickable then). The component field orders
  are one list (`commands` v3.ts `COMPONENT_FIELD_ORDER`; the history's copy had
  lost five light fields).
- 2026-10-03 (28.11): WebP — decoded with libwebp's own decoder
  (`@jsquash/webp` 1.5.0, WASM, decision 0006), so a lossy WebP is encoded
  from the pixels a browser draws; texture imports, packing and thumbnails
  take WebP too. "Every other non-KTX2 image the importer reads" is PNG,
  JPEG and WebP (the importer reads no other). The lossless original is a
  PNG named as the image (its name as written, or the file name extraction
  gives it) of the same size, in the model's folder or its `textures/`
  (Blender's export layout); a PNG of another size is not the image's source
  (it would change the texture's memory) and is not taken. A PNG inside the
  model is already lossless and is used as it is.
- 2026-10-03 (28.11): `import_extract_textures` (0 new models, the default;
  1 every model) — with 1 the backend extracts each GLB model still holding
  images where its file is, once per file version (one `publishAsset`
  reimport each, on the change feed and undoable; Unity reimports when an
  importer default changes), at the project's load and after a change that
  can matter; a re-import or a changed file extracts too. Problems lists the
  models left and why (no file in the game folder, converted from FBX, the
  extraction's reason) only while the setting is 1: with 0 a project may keep
  images inside on purpose (`extractTextures: false`).
- 2026-10-03 (28.11): shared textures — the prepared copy (colour space,
  repeat wrap, the material's tiling and offset, UV channel) is keyed by the
  decoded texture and shared by every built material that asks for the same,
  freed with the last; a material is still built per model file (the file's
  material stays its base, so slots it fills keep working). Unity and Godot
  share a texture between materials the same way. Measured in Play (both
  renderers): the streamed texture's `copies` 1 with 14 files (14 before);
  GPU textures 7 with 14 files and with 1.
- 2026-10-03 (28.11): stats — measured by the page over a 500 ms window
  (`STATS_WINDOW_MS`, runtime): frame interval, the page thread's work (from
  the animation frame's start to the draw's submission when the simulation
  runs on the page; the host's frame work in worker mode) and the GPU's time
  from three's timestamp queries (WebGPU `timestamp-query`, WebGL 2
  `EXT_disjoint_timer_query_webgl2`; Play always asks for them, an export
  only with the overlay on); null where the device has none, never
  estimated. A resolve covers several frames, so the GPU "worst" is the
  worst resolve's mean. `ctx.stats` is presentation like `ctx.ui.view()`
  (not in the digest or a save). Draw calls and triangles are the last
  frame's; geometry bytes are the loaded models' resident bytes without their
  images. On this host (Iris Xe, headless Chrome, WebGPU) the GPU time is
  measured.
- 2026-10-03 (28.11): the overlay is engine UI a game opts into:
  `stats_overlay` 0 (default: no overlay and no key), 1 shown from the start,
  2 hidden until F3 (the usual PC performance-overlay key; the browser's
  find-again is prevented while the game has the page); top-right, so it
  does not cover a game's top-left HUD or the export's status line. No URL
  flag (not asked for).
- 2026-10-03 (28.12): saves — the storage layout was already the planned
  one; a slot write is one IndexedDB transaction (removes first, the
  metadata last) and a delete too. Refusals carry a code next to the
  browser's text: `storage_full` (QuotaExceededError), `storage_unavailable`
  (no IndexedDB, or it cannot open: a page without it now refuses saves
  rather than keeping them for the page's life) and `storage_failed`
  (anything else, a cut-off write included). A refused settings document is
  reported as a result `{op: 'settings', slot: 0}` (failures only); the shell's
  own settings and key bindings are logged. `persist()` is asked at the first
  save, never awaited in the save chain (a browser may prompt); `persisted()`
  and `estimate()` at start and after each save go to scripts as input
  (`storage` frame entries; in the digest once known).
- 2026-10-03 (28.12): `world` — a section in `SAVE_SECTIONS`, still stored as
  the save document's top-level `world` (old saves load unchanged); the
  opt-out is `legacyWorld: false` (the always-on default stays for schemas
  that set neither, as both games rely on it; additive, no upgrade step). A new
  schema made in the Saves tab starts with `legacyWorld: false`. A game that
  does not keep it neither writes nor applies one (a format 2 save without
  `world` now loads). The deprecation line is `deprecated_save_world`, written
  where the world is saved or applied.
- 2026-10-03 (28.13): "Play refuses one id kept in two scenes" cannot be
  reached through the API or the file check — ids are unique across scenes
  and a scene file repeating one is taken in with new ids — so its boundary
  test checks that; the play check stays as the guard for builds made
  otherwise. Acceptances left unverified at a boundary (unit-tested only, or
  needing ears/eyes) are listed in the acceptance map handed to the review:
  a second view, swaps on instance sets and block types, `owner: 'scene'`
  and music ownership, run-time keep writes, the deepest-overlap pair.
- 2026-10-03 (28.13): `docs/deployment.md` had nothing for 28.8, 28.10 and
  28.11; added once each (UI placement/scale/lists/sounds/simulate,
  screenshots' `ui: false`, collider shapes/children/`colliderFromModel`/
  outlines, model texture extraction and sharing, `ctx.stats` and the
  overlay), and the migration notes gained the v7 upgrade and the Problems
  lines a game sees. Stale lines fixed: schemaVersion 5 in the project
  layout, a 64-scene limit that no longer exists.
- 2026-10-03: independent post-phase review (b8f2de26..62999a04, read-only,
  by an agent that did not build the phase). Security: `play.problem` taken
  from the play's owner only and bounded (32 kinds, 512 characters, code
  pattern); upload names, `import_extract_textures` paths, WebP sizes,
  `colliderFromModel` arguments and screenshot `ui` are checked; no
  credentials in logs, diagnostics or tests. Defects, fixed the same day:
  slot `meta` had a sample-sized count cap (8 fields) — now names to texts
  within `SAVE_LIMITS.metaBytes` (4 KiB as JSON, UTF-8), names stay
  identifiers because load screens bind them (D139); the 16 KiB diagnostics
  bound was compared in UTF-16 units at the bridge and the WS validator —
  now UTF-8 bytes (`playDiagnosticsBytes`, D140); `{type: 'model'}` parts
  were outside the scene's 3D collider point budget — the build counts the
  resolved `_COL` parts per object and refuses past it (D141); runtime.ts
  grew in three commits without moving the area first — respawns, arrivals,
  a save's placement, `character_place` and facing moved to
  `character-placement.ts` (5,233 → 5,080 lines, D142); one history-style
  test comment (D143); STATUS and §5 claimed swaps and sounds without an
  "unverified" (D144). Open: `quitToTitle` still restarts the run (owner
  decides whether to deprecate it like `newGame`, D145); one-player
  assumptions to lift before multiplayer — the `player_count` check, a
  later scene cannot bring a player, the single `controllerEntityId`, the
  shell spawn placing "the" kept player, one view (D146). Acceptable as
  they are: `resume` leaving the title (a primitive the game binds), the v7
  upgrade writing `keepLoaded`/`moveFrame: 'world'` as editable data, F3
  fixed for the stats overlay (off by default). Limits are each defined
  once with a reason (16 effect lights, 64 hull points, 256 animations and
  16,384 channels, 32 problem kinds); no copied constants or code paths.
  Files near 2,000 lines: commands types.ts 1,990, viewport.ts 1,989,
  adapter.ts 1,923, behavior.ts 1,916, host.ts 1,856 — move before growing.
  Weak tests: material swaps on instance sets and block types record their
  own callbacks; frame-stats passes stub values; per-view keys proven only
  by an unknown view; collider outlines by the editor's own attribute. Needs
  the owner: the unverified list in §5 28.13, D138 (push leaves ~0.1 m
  overlap), deprecated lines in both games and both repos committing the
  v7 upgrade; decisions: `quitToTitle`, a second view.
- 2026-10-03 (owner): `quitToTitle` is deprecated like `newGame` (28.15); a game loads its title scene with `ctx.scenes.load` and binds that to its own title screen. Never assume one player controller per view: local co-op games share a view (28.16). Before both, a one-time prune of the e2e suite (28.14): the phase-end full gate died or reran for hours.
