# Phase 28 — Requests from Sprout and Skyforge Tactics, second batch

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
| E61 (river flow on `water`) | Skyforge built a river graph; a flow-map option on `water` waits for a request from a second game. |
| E63 part 2 | Done by 27.7 (extract textures). |
| E63 part 3 (`specular` on the graph `pbr` output) | Phase 31 (materials). |
| E54 (scene depth as a material input) | Phase 31, with projected decals. |
| E43, E45, E53 | Phase 29 (29.7, the whole phase, 29.6). |
| E70 (sky rotation), E71 (project quality levels) | Phase 29 (29.11, 29.8). |
| E18 (triangles per LOD in the Inspector) | Phase 30 (30.1). |
| Sprout question 1 (static kit pieces) | Instancing at 4+ copies exists; static batching is 29.10. |
| Sprout question 2 (movers on polygon colliders) | They carry the player (`docs/deployment.md`). Sideways push is unverified. |
| Sprout's unfiled notes: `modes.switch` / `camera.activate` in the transform phase, a mover hook for a door-grind sound | Not taken until Sprout files them. |
| E21, E37, E40 leftovers | Not requested again; they stay on the list for a later batch. |

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
| 28.2–28.13 | — |

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
