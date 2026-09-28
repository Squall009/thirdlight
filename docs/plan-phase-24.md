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
| 24.4 | — |
| 24.5 | — |
| 24.6 | — |
| 24.7 | — |
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
