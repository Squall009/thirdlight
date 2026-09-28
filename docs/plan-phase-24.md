# Phase 24 — Engine/game separation

Goal: Thirdlight contains only generic engine capabilities. Game behaviour
and level logic live only in game repos. The engine never reads a game repo,
and no game is an engine test fixture. Read `docs/roadmap.md` (principles 1
and 1b) first. The findings come from `docs/audit-engine-game-separation.md`,
and ids such as C1, H2 or T1 below refer to it.

Owner rule (2026-09-27, strict): the engine holds physics, input, cameras,
rendering, UI, audio, scripting APIs, data formats and editor tools. Game
rules are never written into it. Engine and games exist in isolation from
each other.

## 1. What changes compared with the audit's migration outline

The audit proposed keeping the platformer layer as an optional kit inside
the engine repo, and keeping Beacon Reach as a sample. That would still
leave game rules in the engine repo, so the owner's question ("will
everything be generic?") would be answered *no*. This plan closes that gap:

- **No genre kit in the engine repo.** Enemies, pickup currencies,
  player-only health and knockback, checkpoint/goal/hazard zones, the
  won/death session, lives, score, the level flow and its save, the classic
  HUD, and the platformer editor panel are **deleted** from Thirdlight.
  - Git history keeps them.
  - A game that wants them builds them from engine primitives as its own
    scripts or 23.7 shared libraries, in its own repo.
- **Beacon Reach leaves the engine repo** (`samples/beacon-reach` is
  deleted). New projects start from a neutral starter template.
  - If the owner wants Beacon Reach kept as a game, it is re-created in its
    own repo later, like Sprout.
- **Sprout is not touched from here.** Once 24.7 lands, Sprout's
  `content.json` no longer loads in the engine: the load reports the removed
  components by name, nothing is silently dropped. Sprout is ported in its
  own repo, on the owner's say, using the primitives from 24.4. That port is
  not an engine item.
- **No compatibility layer for removed game components.** No existing
  project data needs to be preserved (owner, 2026-09-22).
  - Generic data is upgraded by the loader: pickup `kind` → a collectible's
    `counter`, and the `beacon` preset → `emissive-accent`.
  - Game data fails validation with a clear message and is not kept alive
    in the engine.
  - Replays that change are re-recorded, and each one is listed in the
    decision log.

### What stays, and why it is a capability

- **The character controller** (plane2d and 3D): moves the character, jumps,
  follows slopes, ground probes, coyote time and jump buffering.
  - Why: every genre with a walking character uses these, as Unity and
    Godot controllers do.
  - Change: it reads named input actions instead of the fixed `moveX`/`jump`
    frame channels (C9).
  - Change: `packages/platformer` is merged into the generic character
    module, so the name "platformer" leaves the engine.
- **Movers, triggers, one-way colliders, switches, signals, named counters,
  `ctx.lifecycle`, game modes, dialogue, the sequencer and saves.** All
  already generic (audit §1 and §2, "checked").

## 2. Items

Order: tests and fixtures first (so the gate stops depending on games) →
wiring → primitives → editor/protocol → deletion → formats → guard. Each item
keeps the gate green.

| Item | What | Audit ids |
|---|---|---|
| 24.0 | This plan. Principle 1b in the roadmap. Freeze: no new fields on the enemy, pickup, health, gameZone, session or flow blocks. The unplanned 24.0 chase fields from commit `1f99be6` are left in place until 24.7 deletes the enemy block. | — |
| 24.1 | Tests stop reading Sprout. Delete `tests/integration/sprout-meadows`, `tests/e2e/sprout-live.e2e.ts` and `TL_SKIP_SPROUT`. Re-fixture `animator-sprout` and `lightmaps-sprout` with the generated skinned and multi-piece GLBs and rename them. Neutral names in `stage-expiry` and the workspace registry test. Roadmap principle 1 stops naming opt-in Sprout tests. | T1 |
| 24.2 | A neutral starter template: ground, boxes, a spawn, a camera, lights, no game rules. Every test whose subject is generic moves off `beacon-reach`, the smoke set first. | T2, T3 |
| 24.3 | Modules come from the manifest only. Remove the platformer pin (`behavior-build/src/limits.ts:74`), the "game block ⇒ platformer set" rule (`modules.ts`), and the host's hard imports, default set and required `controller`. The exporter bundles only what is declared or referenced. | C8, H1 |
| 24.4 | Generic primitives, one sub-item each, each with its own tests (unit plus a Playwright test for any editor surface). Additive, so no replay changes. | C1–C5, C9, C10, H4–H6 |
| | a. `collectible { counter, amount, respawn, onCollect signal }` | C2 |
| | b. `health` on any entity; `ctx.health.damage/heal`; `damaged`/`died` events | C3 |
| | c. a `patrol` mover (waypoints, or edge walking with wall/ledge probes) | C1 |
| | d. `hitbox` contact events that carry the contact normal and the other entity | C1 |
| | e. trigger enter/exit events, and a `sceneTransition` trigger action | C4, C5 |
| | f. `ctx.character.impulse(v)`; facing as a yaw or "face velocity"; a configurable switch action | C10 |
| | g. a standalone camera follow behaviour (dead zone, smoothing, bounds) | C10 |
| | h. a per-entity look override (emissive/tint), set from the sim or scripts | H6 |
| | i. an event → cue table keyed by event name | H5 |
| | j. shell menus: title, pause, settings, rebind and save/load screens as UI documents, plus an ordered scene list. HUDs are project UI documents. Prompts are generated from the declared input actions. | H2, H4 |
| 24.5 | Editor: menus, panels, icons and wording come from descriptors. Remove the Gameplay panel's platformer tabs, the zone/coin/enemy menus and the lives/score flow sections. The Animator preset becomes "Character locomotion". MCP tool descriptions are generated from descriptors. | H8, H9 |
| 24.6 | Protocol and observation become generic. Run states, checkpoint/goal events, `GameHostObservation` session fields and `$flow` level/lives/score are removed. What remains is play state, named counters, scripted events, the current scene, and the lifecycle. | C6, H5 |
| 24.7 | Delete the genre layer: `packages/platformer-game`; the enemy block, pickup kinds, player-only health/knockback, gameZone roles, `GameSession`, `RunSaveState` block fields, flow lives/score, `game-host/src/save.ts` and `score.ts`, the classic HUD, the checkpoint glow, the `beacon`/`hazard` presets, `samples/beacon-reach` and its tests, and `fixtures/m2/contracts/platformer`. Merge `packages/platformer` into the generic character module. | C1–C7, C10, H2–H7, T2, T3 |
| 24.8 | Formats. A schema version bump. The loader upgrades generic data (collectible, preset rename, facing). Removed game components are refused with a problem naming the component and "removed in phase 24: build it as project scripts". A new input frame version without fixed channels. Replays re-recorded and listed. | C9, C10 |
| 24.9 | A guard that keeps it generic. `tools/check-boundaries.mjs` fails the build when a package's `src/` uses genre vocabulary: coin, gem, lives, stomp, enemy, boar, checkpoint, goal, hazard, score, level-complete, platformer, sprout, beacon. A short, reviewed allowlist covers generic uses such as "lives" in particle lifetimes. The charter's first-release list and decisions table, and `docs/deployment.md`, are rewritten to match. | — |

**Done when:**
- The guard passes.
- `grep -ri sprout\|beacon packages tests tools samples` finds nothing.
- `tools/gate.sh full` is green without any game repo on disk.
- A new project from the starter template can be built into a small game
  (a collectible, a patrolling hazard with health, a scene transition, a
  title screen, a HUD) using only the primitives and project scripts. A
  Playwright test proves this through the editor. The game's rules live in
  that test's project scripts, not in the engine.

## 3. Progress

| Item | Status |
|---|---|
| 24.0 | done 2026-09-27 |
| 24.1 | done 2026-09-27: Sprout tests deleted; `animator-skinned`, `lightmaps-kit` on generated GLBs (browser bake always, Blender bake when Blender is there) |
| 24.2 | done 2026-09-28: `templates/starter` (no game block, plays as a scene); 35 e2e files, the template unit test and 5 project-model tests off `beacon-reach`; the rest listed below for 24.7 |
| 24.3 | done 2026-09-28: modules resolve from component/block references only; the platformer is unpinned; the host has no default set and no module import (specs injected by the composition entries); an export links only the specs its manifest names |
| 24.4 | a–j done 2026-09-28 (fast gate; the full gate runs when 24.4 is complete) |
| 24.4a | done 2026-09-28: `collectible {counter, amount?, size?, onCollect?, respawn?}`; `ctx.collectible.collected/restore`; `collected`/`restored` events |
| 24.4b | done 2026-09-28: `health` on any object; `ctx.health.get/damage/heal/events`; `damaged`/`healed`/`died` events |
| 24.4c | done 2026-09-28: `patrol {mode: waypoints or edges, …}` (the mover's path code; wall/ledge probes); `ctx.patrol.get/setActive/turn`; `turned` events |
| 24.4d | done 2026-09-28: `hitbox {shape?, size or radius, damage?}`; `contact`/`separate` events with the other object and the normal; `ctx.hitbox.setActive/touching` |
| 24.4e | done 2026-09-28: `trigger.sceneTransition {scene, spawn?, unload?}`; trigger enter/exit events also without the session (2D) |
| 24.4f | done 2026-09-28: `ctx.character.impulse([x, y, z])`; `faceMovement {mode: 'velocity', yawOffset?}`; `playerSpawn.yaw`; `switch.action` |
| 24.4g | done 2026-09-28: `virtualCamera` rig `track {target, trackOffset?, deadZone?, damping?, boundsMin?, boundsMax?}` |
| 24.4h | done 2026-09-28: `ctx.look.set/clear/get` (emissive, intensity, tint), both renderers |
| 24.4i | done 2026-09-28: `content.eventCues` (`setEventCues`; signal or event name → sound), Media tab |
| 24.4j | done 2026-09-28: `content.shell {screens?: {title, pause, settings, controls, save, load}, hud?, scenes?: [{scene, spawn?}], pause?, status?}` (`setShell`, Game shell tab); engine actions `open`, `nextScene`; `$flow.counters/health/prompts/shell`; counters in the `components` save section |
| 24.5 | done 2026-09-28: descriptor `create` entries and `icon`s drive the GameObject menu, the hierarchy and Scene-view icons; zone/pickup/enemy no longer offered; Gameplay panel = settings, camera (+ an existing game block); no lives/score UI; "Character locomotion" preset; MCP wording generic |
| 24.6 | done 2026-09-28 (fast gate): observations and control results report a play state (`running`/`paused`); the session's run state, checkpoint, deaths, goal, events, level flow and title view moved to an optional `legacy` block (24.7 deletes it); `$flow` lost level/lives/HUD/totals/score/result; `health` is every object's; the 20 `addGameSession` tests run in scene mode (a title shell where they waited for a start) |
| 24.7 | done 2026-09-28 (fast gate): `platformer-game`, the session, flow, enemy, pickup, gameZone, cameraFollow, knockback, legacy block, classic HUD and Beacon Reach deleted; one runtime mode; `packages/platformer` → `packages/character` (`thirdlight.character:controller`, old id aliased) |
| 24.8 | — |
| 24.9 | — |

## 4. Decision log

- 2026-09-27: no genre kit in the engine repo, and Beacon Reach leaves it
  (see §1). Reason: the owner rule is that game behaviour lives only in game
  repos. An optional kit inside the engine would still be game code in the
  engine.
- 2026-09-27: the character controller, including jump, coyote time and
  jump buffering, stays as a capability (see §1). This is the line between a
  motor and a game rule. A motor describes how a character can move. A rule
  describes what happens in the game: dying, winning, scoring, or enemies
  being stomped.
- 2026-09-27: the unplanned chase fields (commit `1f99be6`, labelled
  "Phase 24.0" in code comments) are frozen, not reverted, because 24.7
  deletes the whole enemy block. The label is unrelated to this phase's
  24.0.
- 2026-09-28 (24.2): the starter template (`templates/starter`, built by
  `tools/build-template.mts` through `applyMutation`) has no game block: a
  project from it plays in scene mode. A generated character (48 triangles,
  7.8 KB, clips Idle/Run/Airborne) carries the controller; a generated
  pillar (24 triangles, 3 KB) is the decoration model. The camera uses the
  engine default field of view (60°).
- 2026-09-28 (24.2): tests whose generic subject still runs through the
  platformer session's run states (awaiting start, the HUD, counters in the
  observation) call `addGameSession(be)` (`tests/e2e/backend.ts`): it adds
  the v4 game block, a following camera and an out-of-reach goal zone (the
  block requires one) by command. The template stays free of game rules and
  the coupling is greppable. Twenty files use it: animator-skinned,
  debug-entry, instances (D34), mcp, mcp-headless, memory, play-memory,
  project-ui, rebind, scenes (exit zones), script-editor, script-libraries,
  script-properties, sensors, sim-worker, spawn, tags, ui-editor,
  visual-script, visual-script-debug. 24.6 rewrites them when the run states
  go. Behaviors, backup, capsule, input, insecure-context, layout and one
  scenes test now assert scene mode (`state: 'scene'`; the export's
  `__thirdlightObserve`).
- 2026-09-28 (24.2): "coin" as a counter name became neutral (`opened`,
  `items`; a `custom` pickup with a counter in sim-worker); Beacon assets
  became the starter's `Pillar`; audio comes from the WAV fixtures through
  `publishWav` (the starter has none).
- 2026-09-28 (24.2): left on `beacon-reach` for 24.7 because their subject is
  the platformer or its game flow: `beacon-reach`, `score`, `blocks` (coins,
  stomp), `flow` (levels, lives), `saves` (checkpoint run saves), `level-look`
  and `pad-menus` (flow levels, title and menus), the pickup-effect test in
  `effects-runtime`; `tests/integration/m3-sample/*`,
  `tests/evaluations/m3-browser`, `tests/evaluations/m4-baseline/*`, and the
  kill-height migration case in `project-v4.test.ts`.
- 2026-09-28 (24.2): `effects-runtime` expected the CPU effect executor for
  `auto`; on the GPU host `auto` is WebGPU (the compute executor). The test
  now follows the backend (a stale test expectation since the gate moved to
  the GPU, not a product bug).
- 2026-09-28 (24.3): module resolution is table data — `COMPONENT_MODULES`
  (component → module per dimension) and `CONTENT_BLOCK_MODULES` (the `game`
  block references the session and camera until 24.6/24.7 remove it). The
  platformer packages are no longer a behavior dependency
  (`BEHAVIOR_PACKAGE_MODULES`), matching the unpinned compiler table.
- 2026-09-28 (24.3): the host takes an ordered spec table (`moduleSpecs`,
  keyed by `spec.id`, dependency order from `ENGINE_MODULES`, which now names
  each non-runtime spec's export). Runtime built-ins (character3d) stay in the
  host. No `modules` means no modules. The session declares its own
  `requiresEntityWith: ['controller']`; the preview/export "game requires a
  controller" throws are gone (the host reports the module's requirement).
- 2026-09-28 (24.3): the export generates `thirdlight:export-modules` for the
  page and the worker bundle; `checkBundleGraphM3` allows a module package
  only when the manifest names one of its modules. The preview registers all
  specs (`editor/src/preview/module-specs.ts`). The manifest `enginePins`
  table still lists `@thirdlight/platformer-game`: it is identity data in
  every buildId, left for 24.7/24.8.
- 2026-09-28 (24.3): the packet-33 behavior fixtures keep their recorded
  digests by compiling under the fixture's own pin table
  (`expected.json` `pinnedModules`); the live table no longer matches it.
  Test compositions derive `modules` from their snapshot with the product
  resolver (`tests/game-modules.ts`). One expectation changed:
  `m23-3d/block-layers` ran a 3D scene without the character module the
  manifest names; with it the fall starts in the dig step itself (the test
  had asserted one step later). No recorded replay changed.
- 2026-09-28 (24.4a–d): the primitives live in `runtime/src/primitives.ts`
  (owned by the gameplay blocks, so scene loads, spawns, a new run and the
  step order are shared) and run in both dimensions, with or without the
  game session: a 2D scene without the session now runs them after its
  transform phase, and a 2D plain step (no modules) runs them too. The
  platformer blocks keep their old scope (with the session only), so no
  recorded replay changed. `geometry3.ts` holds the 3D helpers both use.
- 2026-09-28 (24.4a): the collect area is centred on the object (as a trigger's),
  default 1 m; a 3D box's absent depth is its width (no dimension rule to
  trip over). `respawn` is seconds (0: never), not the pickup's "on death"
  (a death is a game rule; a script calls `ctx.collectible.restore`). The
  character (the controller's object) is the only collector, as for triggers.
- 2026-09-28 (24.4b): generic health reuses the frozen `health` component
  (no new fields: `max` and `start`; `current` is the run value). Health may
  now sit on prefabs. Its add value stays `{max: 3, invulnerableSeconds: 1}`
  (unchanged until 24.7; the grace is ignored off the session player). The game session's player shares one record with the
  session's own health, so `ctx.health` and `ctx.game.health()` agree; the
  session's grace time, knockback and death at 0 stay on its own damage path
  (hazards, enemies) until 24.7, and that path does not emit the new events.
  `ctx.health.damage` at 0 does nothing (false); `heal` works at 0 (a script
  may revive).
- 2026-09-28 (24.4c): a patroller keeps its placed height, has no collider
  (excluded: it is posed, not simulated) and probes from a centred body box
  (a ray ahead at mid-height reaching half its width + one step + the wall
  probe; a ray down from 0.1 m above its underside, just past its front). The
  2D plane walks along x only (the sign of `direction`). Without a physics
  port (a 2D scene with no controller) an edge walker walks on unprobed.
  Waypoints reuse the mover's path code (`advancePath`; the mover's own
  behaviour is unchanged).
- 2026-09-28 (24.4d): hitboxes are axis-aligned boxes or spheres (circles on
  the 2D plane); the character takes part with its capsule's bounding box.
  The normal points from this side toward the other and comes from the axis
  along which the two were still apart one step before (so a fall onto a
  hitbox reads `[0, 1, 0]` from below), else the shallowest overlap. Pairs
  are found by a sweep along x and reported in sorted order (deterministic).
  Parents and children never touch. `damage` applies once per new contact to
  the other side's health or its nearest parent's. Other collider objects
  (walls) are not contacts: that is `ctx.physics` queries' job.
- 2026-09-28 (24.4): the events reach `ctx.events` for the objects a script
  owns (the trigger rule); `ctx.health.events()` lists every object's. The
  save schema gains a `components` section (health, collected collectibles
  with their respawn countdown, patrol state, switched-off hitboxes). A
  scene-mode play observation now includes the named `counters` (additive,
  the generic part of 24.6). Found on the way: D36 (a missing `return`
  handed a restored dialogue state to the environment; fixed).
- 2026-09-28 (24.4): visual-script nodes come from the typings for the
  calls (`ctx.health.damage`, …); there are no "On damaged / On contact"
  event nodes yet (a graph reads the calls; event nodes are open for 24.5,
  whose descriptors drive menus and nodes).
- 2026-09-28 (24.4e): the trigger already had `enter`/`exit` events in
  `ctx.events` (phase 14.2); the gap was a 2D scene without the game session,
  where triggers did not run at all. They now run there (after the transform
  phase, against the controller's object); no recorded replay changed.
  `sceneTransition` is a trigger field, not a new component: an entry (as
  its signal, once with `once`) queues the unloads and the load like
  `ctx.scenes`, then moves the character to the spawn once the scene is
  loaded — through the session's transfer when there is one, else at the next
  step boundary (3D: `pendingRespawn`; 2D: the port's placement and the
  controller's reset hook). The spawn must be a `playerSpawn` in the loaded
  scene or the trigger's (checked across scenes by the project rule, as the
  exit's), and becomes the active spawn. The Inspector's "+ add" for an
  object with a required scene reference starts at another scene of the
  project (`startValue` refs).
- 2026-09-28 (24.4f): an impulse adds to the velocity (the controllers' own
  acceleration brings it back to what the input asks), summed per step and
  consumed by the next controller phase; a positive y lifts a grounded
  character into an arc. Limit 100 m/s per component (a safety bound).
  Facing: `faceMovement.mode: 'velocity'` (the yaw of the horizontal motion,
  atan2(dx, dz), plus `yawOffset`; `turnSeconds` is the time of a half turn)
  and `playerSpawn.yaw` (degrees, 0 = +Z). Velocity models turn in 3D and
  without the session; two-sided models keep their old scope (the session's
  2D step) so nothing recorded changes. `facing: left|right` stays readable
  (24.8 upgrades it). The switch's `action` defaults to `interact`.
- 2026-09-28 (24.4g): the camera follow is a new virtual-camera rig
  (`track`) in the phase 23.4 brain, not a new component: it runs wherever
  the brain runs (both dimensions, any mode), keeps the camera's placed
  rotation and offset (its depth is data, no `CAMERA_Z`), reuses `damping` as
  its smoothing, and clamps the framed point to per-axis bounds. No frustum
  clamp (a level-bounds rule of the platformer camera). The dead zone and
  bounds have no Scene handle yet (world-space boxes not tied to the camera
  object; a handle kind for them is open for 24.5).
- 2026-09-28 (24.4h): look overrides live with the primitives (reset with a
  new run, removed with their object, saved in the `components` section,
  at most 1024), reach the renderer as `entityLooks()` (mirrored from the
  simulation worker; in the step digest only while one is set) and are
  applied by `setEntityLook` (the checkpoint glow's own-copy rule; a tint
  multiplies the base colour). The checkpoint glow now goes through it.
- 2026-09-28 (24.4i): `content.eventCues` rows `{on: signal|event, name,
  entity?, assetId, volume?, bus?}` (at most 64). The runtime notes the
  step's signals and trigger/primitive events (only when the project has a
  table) and plays each matching row once per step through the audio intent
  log, so the host plays it in both threading modes and the export (its
  sounds are captured with the content). Signals and event types share one
  `name` field, told apart by `on`. The Media tab edits the table (a row is
  made from its three essentials, then edited with the descriptor form).
- 2026-09-28 (24.4e–i): `shader-parity` expected `auto` to take WebGL 2 in
  the default project; on the GPU host that project has a WebGPU adapter
  (`auto` → WebGPU). The test now follows `gpuAvailable()` (a stale test
  expectation since the gates moved to the GPU, as `effects-runtime` in
  24.2; not a product bug). The inspector test's Face movement option is now
  its preset "Two sides" (the component has presets).
- 2026-09-28 (24.4j): the shell is a new content block (`content.shell`),
  not the flow with its levels removed: it drives a game that plays as a
  scene, and the model refuses it beside the flow or the game session (one
  thing owns the menus; the flow goes in 24.7). The host's
  `game-host/src/shell.ts` holds the engine pause while a menu shows (as the
  23.10 scene pause; the engine's settle pre-roll still runs first), draws a
  screen with the UI layer's screen slot and the HUD documents in a new
  host-shown layer under the scripts' documents (never focused). Without a
  pause document the 23.10 pause panel is used; a game mode's `pause: false`
  and `pauseScreen` still win. Settings, controls, save and load exist only
  as documents (a missing one is logged, nothing opens).
- 2026-09-28 (24.4j): new game, restart and next scene ride on the input
  frame as UI events (`restart`, and a new `scene` kind whose value is the
  scene list entry), applied at the next step boundary. The runtime keeps the
  entry it is at (`listedSceneIndex`, mirrored from the worker); a move
  unloads the previous listed scene unless it is a start scene, loads the
  entry's scene when needed and places the character at its spawn with the
  24.4e arrival. The snapshot carries the list as `sceneList`.
- 2026-09-28 (24.4j): a shell save is made by the simulation between steps
  (`Runtime.requestSave`, worker op `requestSave`), because a paused game
  takes no steps; a load uses the 23.19 save service's `loadSlot` and resumes
  play (it restores at the next step). Slots come from the UI action's
  `slot` ("1"–"3"; `auto` is the flow's and is ignored). Continue loads the
  newest slot by `savedAt`. The `components` section now carries the named
  counters (restoring collected collectibles without their totals would
  disagree). Open: a save does not carry the loaded scenes or the
  character's place (a later save section).
- 2026-09-28 (24.4j): HUD values come from the host as `$flow.*` (the
  existing host root, now also in scene mode): `counters`, `health` (every
  object's, `Runtime.healthsView`, mirrored), `prompts` / `promptList` and
  `shell`. Prompts are generated from the declared actions of the active
  maps (gameplay by default), "<keys> <action words>", labelled by the
  rebinding's glyph for the device used last; no action name is special
  (`bindings.ts` `actionPrompts`; `hudPrompts` stays for the classic HUD
  until 24.7). The generic status overlay is the shell's opt-in debug line.
- 2026-09-28 (24.4j): the editor's descriptor list widget starts a new item
  of references at the first choice and a listed scene at the first scene
  (a list of refs had no "+ add" before). D37 (a 2D scene restart without
  the session fail-stopped) was found and fixed on the way. In the shell
  integration test the two threading modes are compared by outcome: the
  menus are live input there, so each mode sees them at its own step.
- 2026-09-28 (24.5): a component descriptor may carry `create` entries
  (label, submenu, a placeholder box, the component value, extra
  components, a physics dimension, scene pointers filled with another
  scene) and an `icon` (`COMPONENT_ICONS`, most specific first; the
  registry carries the order as `icons`). The GameObject menu renders them
  (a submenu of an existing name, Light, gains its entries: the fog
  volume); the hierarchy and Scene-view icons come from the registry
  (`iconTableOf`, no hard-coded component list). Entries: Spawn point;
  Gameplay → one-way platform and switch (2D plane only: 3D refuses both),
  moving platform, door, trigger, scene transition (disabled until the
  project has a second scene), object with health, collectible, patrolling
  object, hitbox (3D entries with a depth); Cameras → camera track.
  `createEntity` now also takes `virtualCamera` (so the camera track is one
  command, one undo).
- 2026-09-28 (24.5): gameZone, pickup and enemy are `legacy` with
  `add: never` ("removed in phase 24"): not offered in "+ Add component" or
  the Component menu; existing objects still show and edit them in the
  descriptor Inspector (and the Scene view's zone gesture still moves and
  resizes existing zones) until 24.7. The exit-zone dialog and the
  Inspector's exit special case are gone (a scene transition trigger does
  it generically). The pickup and enemy objects show the collectible and
  patrol icons; the enemy and door artwork was deleted (a door is a mover),
  `pickup.png` became `collectible.png`; patrol, hitbox and health are SVG
  glyphs (no artwork file yet).
- 2026-09-28 (24.5): the Gameplay panel keeps Settings (descriptor-built;
  the six-key fallback form is gone) and Camera; a project that still has a
  game block sees it under "game session" (descriptor-built, no Create
  button: the editor never makes one). The v3 game-config form with its
  goal-required/one-checkpoint validation, the Zones tab and the zone
  placement tool, the cue slots (`planCueEdit`) and the checkpoint
  activation planner are deleted; `gameplay.ts` keeps the game block's wire
  shape and the zone gesture's placement planning for 24.7. The Game flow
  window drops Lives and Score (a flow that has them keeps them; a new flow
  has no lives) and the `coins, gems, keys, lives, defeated` counter seeds.
- 2026-09-28 (24.5): the Animator preset is "Character locomotion"
  (`locomotionController`). Its parameters stay `speed`, `grounded`,
  `velocityY` and `landed`: these are the names the character controller
  writes on its animators, and they describe motion, not a genre (renaming
  them would break the automatic feed).
- 2026-09-28 (24.5): the MCP adapter may not import project-model (its
  boundary row), so its descriptions are generic wording that points to the
  descriptors (`tl_content_query target="game" includeDescriptors`: fields,
  create entries, icons) instead of text generated at build time; the
  pickup/enemy/zone fields, lives, score rules, levelId and the effect hooks
  of removed components are no longer taught.
- 2026-09-28 (24.5): tests. No test was deleted: every test that drove a
  removed menu or section still has a live subject until 24.7, so the
  removed UI step became a command — `blocks` (coins and the enemy by
  `createEntity`), `flow` (lives by `setFlow`), `score` (score rules by
  `setFlow`), `inspector` (the game block by `setGameConfig`; its menu list
  now adds a collectible, a patrol and a hitbox instead of a zone, a pickup
  and an enemy). `menus` and `placeholders` use "Spawn point",
  `animator-skinned` the new preset, `gizmos` the renamed artwork. New e2e
  `create-menu` (2D and 3D). `DEFAULT_ZONE_SIZE` is one 1.5 m square for
  every role (the per-role sizes were fitted to the default jump).
- 2026-09-28 (24.6): the session's view is not deleted now but moved into
  an optional `legacy` block of the observation (protocol
  `validateGameObservation`; host `GameHostObservation.legacy`: `runState`,
  `checkpointId`, `checkpointActive`, `goalReached`, `failed`, `deathCount`,
  `eventCount`, `eventDropped`, `events` and the level flow's `flow` and
  `titleView`). Reason: least churn — the session and the flow live until
  24.7, their tests read one block through `legacyObservation()`
  (`tests/e2e/backend.ts`), and 24.7 deletes the block, the helper and
  `LEGACY_RUN_STATES`/`LEGACY_EVENT_KINDS` wholesale. The core is generic in
  both kinds of play: `state` is `PLAY_STATES` (`running`, `paused` while the
  engine pause holds the simulation — a shell menu, the pause panel, a game
  mode, the flow's menus; `stopped` for a disposed host), the same field in
  control results; `GAME_RUN_STATES`, `GAME_EVENT_KINDS` and state `scene`
  are gone. A scene-mode observation now also carries `animators`, `spawned`
  and `effects`, and `health` is every object's health
  (`{objectId: {current, max}}`, at most 64), not the session player's.
- 2026-09-28 (24.6): the control route answers every command alike in both
  kinds of play (run 0 in scene mode; D34 fixed); `replay` in scene mode is
  the engine restart (an input-frame entry, as the pause panel's). `start`
  is only a session's (scene mode refuses it, as before).
- 2026-09-28 (24.6): `$flow` keeps the menu values (screen, title,
  subtitle, objective, instructions, volumes, quality, slots, saveNote,
  canSave) and the generic ones (counters, health, prompts, input, shell);
  the flow's `level`, `lives`, `hud`, `totals`, `score` and `result` are
  gone now (no test or engine document read them after the ports; the
  flow's own DOM menus still show them until 24.7). The export's debug line
  names the build and the play state only. MCP: `tl_game_observe` teaches the
  play state, counters, health, shell and the `legacy` block;
  `tl_play_start` no longer teaches the flow save (`save {levelId, run}`,
  `saveSlot auto`), which still loads until 24.7.
- 2026-09-28 (24.6): tests. The 20 files that called `addGameSession` run in
  scene mode; `addGameSession` is deleted. Where a test waited in
  `awaitingStart` to see the world before play (visual-script's timed door,
  sim-worker's keyboard start), a game shell title holds the start
  (`addTitleShell(be, hud?)`: a corner panel with a Start button; its HUD
  replaced the classic HUD text). Rebind now uses a project controls screen
  (the engine `rebind`/`resetBindings` actions) instead of the flow's
  settings list; project-ui and ui-editor use the shell's pause screen
  (heading bound to `$flow.shell.screen`); scenes' exit zone became a
  trigger with `sceneTransition`; sim-worker's chiming pickup a collectible
  with an event cue; sensors checks the door after it closes (the scene
  plays at once). The perf benchmark and large-project still build the
  session (24.7 moves them) and read `legacy.runState`. The platformer's own
  tests (beacon-reach, blocks, flow, pad-menus, m9-flow, m3-sample, m3-shell)
  read `legacy` and are deleted in 24.7.
- 2026-09-28 (24.6): found on the way and fixed: D38 (a shell screen took
  the keyboard focus from the game canvas, so Enter did not reach its
  focused button), D39 (no locomotion animator parameters and no start
  spawn without the session: the controller's object is now fed from its
  own motion — horizontal speed over x and z — and `Runtime.requestArrival`
  places it at a Play-from scene's spawn). No replay or digest changed: the
  runtime's `GameView` and the step digest are untouched (the observation
  is a host view), and the animator feed only changes games without the
  session, which have no recorded fixtures with a character animator. The
  m3 delivery wire fixture (`fixtures/m3/delivery/wire/observe-result.json`,
  not in the gate) still shows the packet-48 shape; it goes with 24.7.
- 2026-09-28 (24.6): load-sensitive tests hardened on the way (3 workers on
  the GPU host): shell's walk past the second collectible holds the key until
  the character is there (not 1.5 s); look-override reads the counter beside
  each picture; dialogue's audio sampler loop is paced and bounded (unpaced,
  after a failure it kept the worker busy past every timeout and the whole
  run hung); project-ui adds a `track` camera shot (the session's following
  camera made its world label move). D38's fix is on the modal backdrop's
  `pointerdown` (a `mousedown` handler on the document root broke the
  dialogue box's clicks in Play).
- 2026-09-28 (24.7): the level flow (`content.flow`: levels, lives, score,
  menus, per-level looks, flow saves and best scores) is deleted entirely,
  not slimmed: the game shell (24.4j) is its generic replacement. Lost with
  it and not re-offered: music per screen, per-level ambience, menu sounds,
  the title pan, per-level looks, the logo, flow default volumes, flow saves
  and best scores, and the old key/pad settings migration. `content.flow`
  and a non-null `content.game` are refused with "removed in phase 24"; the
  `game` key stays (always null) and the manifest keeps `game: null` and
  its all-null cue slots until 24.8 (format bump).
- 2026-09-28 (24.7): deleted from the model, commands, descriptors, editor
  and MCP: `gameZone` and `cameraFollow` (v3 and v4; the `track` camera rig
  replaces the latter), `pickup` (the `collectible` replaces it), `enemy`
  (with the chase fields; `patrol` + `hitbox` + `health` replace it), the
  player-only knockback, i-frames and hit bounce (`health` is `{max, start}`
  on any object), `RunSaveState`, the protocol `legacy` block and its run
  states/events, the play-start `levelId`/flow save, `game-host` flow,
  score, save and classic HUD, the checkpoint glow and the fade. The
  `beacon`/`hazard` presets are renamed `emissive-accent`/`signal-red`
  without an alias (only Beacon Reach used them; 24.8 adds the format
  alias). `BLOCK_DEFAULTS` keeps `maxPush` only.
- 2026-09-28 (24.7): the runtime has one mode (every game plays as a
  scene; the controller entity is the character). Switches run on the 2D
  plane without the session, `ctx.lifecycle.respawn` works in 2D (at the
  next step boundary), drop-through and settle times come from
  `ENGINE_TIMING_DEFAULTS` (0.125 s, 0.1 s: the old game-block defaults, so
  no replay moved), and a spawn's `facing` left/right maps to a yaw of
  −90°/+90°. Found and fixed: D40 (a second shell or event-cue edit was
  refused as a conflict), D41 (a face-movement model turned on a
  placement). The host observation carries `counters`/`health` (the export
  reported neither); "Clear Play save" clears the project save slots.
- 2026-09-28 (24.7): tests. Deleted (subject was the genre layer):
  beacon-reach, score, flow, pad-menus, saves, level-look, m15-hud-prompts
  e2e; m3-sample/m3-shell/m3-gameplay/m3-respawn/m3-camera, m4-render, the
  m3 contract replay, m9-flow flow/save, the m4 baseline evaluation. Ported
  first: blocks (collectible, plate/door, one-way shelf, lift on the
  starter), effects-runtime, rebind (pad button), shell (export save and
  Continue, Clear Play save), `shell-scenes` (new: the scene list and the
  kept music volume in Play and the export), inspector (event sounds in
  place of the game block), handles, scenes, shader-parity (`look` case).
  The m2 motor fixtures (`fixtures/m2/contracts/platformer`) stay: they are
  the controller's contract, not a game's.
- 2026-09-28 (24.7): re-recorded: `fixtures/m3/contracts` (3 valid and 10
  invalid envelopes without the game layer, 11 invalid game/zone/cue cases
  deleted; `tools/remove-game-layer.mts`), `fixtures/m3/storage` demo
  scene, `fixtures/m3/delivery` (manifest, digests, pinned run, deps, fetch
  graph and wire files; buildId `41b5a60b…` → `78f5ca46…`;
  `tools/derive-manifest.mts`; the wire observation was written by hand and
  checked by the validator), `tests/integration/m15-tuning/replay-nondefault.json`
  (the old one recorded session state; bit-identical on two runs), and
  `tests/perf/baseline.json` (generator 3: the benchmark's camera is a
  `track` rig instead of the session camera and goal; against the 21.6
  baseline the medium `command.applyFrameP50` and the sims' heap read
  higher, but 24.6's tree measures the same — its apply→frame read 48 and
  370 ms in two runs — so nothing there is 24.7's).
- 2026-09-28 (24.7): `packages/platformer` is `packages/character`
  (`@thirdlight/character`, `characterControllerSpec`,
  `CHARACTER_MODULE_ID` = `thirdlight.character:controller`; input
  `characterKeys`, `characterPad`, `readCharacterPad`, `CharacterPad`,
  `STANDARD_CHARACTER_PAD`). A manifest naming the old id still plays: the
  runtime's `MODULE_ID_ALIASES`/`canonicalModuleId` map it and the host's
  module resolver applies it (a host test mounts a manifest with the old
  id). The recorded M2/M3/M4 fixtures keep the old id (the m2 runtime
  fixture test maps it the same way); the m3 delivery fixtures were
  re-derived (buildId → `3dabf352…`). `fixtures/m2/contracts/platformer`
  keeps its name (the controller's motor contract, not a game's).
- 2026-09-28 (24.7): left for 24.8/24.9: the always-null `game` key and
  the manifest's null cue slots (24.8 format bump, with the old preset
  names as aliases), the `game_*` error codes and the separation guard
  (24.9). The m3 delivery/audit fixture checkers still read the archived
  `docs/contracts` and crash (not in the gate).
