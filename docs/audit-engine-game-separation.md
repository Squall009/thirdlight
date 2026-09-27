# Audit — engine/game separation

2026-09-27, at `da5773c` (phase 23 done). Read-only analysis; no product code
changed.

**Owner rule (2026-09-27, strict).** Thirdlight holds only generic engine
capabilities: physics, input, cameras, rendering, UI, audio, scripting APIs,
data formats, editor tools. Game behaviour and level logic are game project
code. They live only in the game's own repo (`~/projects/sprout`,
`~/projects/skyforge-tactics`, …) and are never written into the engine.
Engine and games exist in isolation from each other.

**Verdict.** No product package names Sprout. Instead, a whole **platformer
genre layer** sits in the engine core and is wired in by default. It includes
enemies with stomp and chase, pickup kinds with fixed currencies, player-only
health with knockback, checkpoint/goal/hazard zones with fixed priorities, a
won/death session, a level/lives/score flow with its own save format, and a
classic HUD. It runs through project-model → runtime → game-host →
three-adapter → editor → MCP. `game-host` imports the platformer packages
directly, and every build pins `@thirdlight/platformer`. Beacon Reach, a
platformer sample, is the default fixture for about 47 test files, and 4 tests
read the Sprout repo. Phase 23's own additions are generic: `ctx.lifecycle`,
project saves, and the default dialogue UI.

Recommendation codes:
- **(a)** replace with a generic primitive
- **(b)** move to the game repo as project scripts or shared libraries (23.7)
- **(c)** keep as an optional sample/template kit outside the engine core
- **(d)** delete

Effort: **S** ≤ ½ day, **M** 1–2 days, **L** 3+ days.

---

## 1. Core runtime and model (highest severity)

These define the data formats and the simulation. Everything else mirrors them.

### C1. Enemy block: patrol, contact damage, stomp, defeat, chase
- **Where:**
  - `packages/project-model/src/blocks.ts:151-190, 218` (`EnemyComponent`)
  - `packages/runtime/src/blocks.ts:548-588, 1071-1095, 1146-1238`
  - `enemySight` at `runtime/src/blocks.ts:1227`
  - Field lists duplicated in `commands/src/v3.ts:69` and `commands/src/validate-content-args.ts:488`
  - `project-model/src/descriptors.ts:1305-1347`
- **What:** a complete Mario-style enemy AI in the core. It patrols points or edges and deals contact damage. It is stomped "from above" (`stompTolerance`, `stompBounce`, one health per stomp) and squashes or fades on defeat. It keeps a `defeated` counter and drives hard-wired animator parameters (`hurt`, `defeated`, `attacking`, `speed`). Commit `1f99be6` ("Phase 24.0: an enemy can run the player down", no plan) added `chaseSpeed`, `chaseSight`, `chaseFacing`, `chaseMemory` and `chaseBeyondPatrol` across 10 files, including the commands and MCP.
- **Why it's a game rule:** what an enemy is, how it is defeated, and when it gives chase are design decisions for one game. They are not capabilities.
- **Dependents:**
  - Sprout's boars
  - Beacon Reach
  - m9-blocks and m15-tuning tests, plus the replay `replay-nondefault.json`
  - editor icons and descriptor fields
  - the MCP descriptions
- **Recommendation:** split it three ways:
  - Keep generic primitives in the core (a):
    - a **`patrol` mover**: a waypoint or edge walker with wall and ledge probes
    - line of sight through the existing `ctx.physics.raycast`
    - a **`hitbox`/`contactDamage`** event that carries the contact normal, so a script can decide what "from above" means
  - Move the enemy behaviour to (b) Sprout's shared script library.
  - Freeze the current block for v3 content only (c).
  - Revert or freeze the 24.0 chase fields now, so nothing else lands.
- **Effort:** L.

### C2. Pickup kinds with fixed currencies
- **Where:**
  - `project-model/src/blocks.ts:23`: `PICKUP_KINDS = coin|gem|heart|life|key|custom`
  - `runtime/src/blocks.ts:1063-1067`: kind → counter `coins/gems/keys/lives`; `heart` heals the player
  - `descriptors.ts:1286-1299`: the default is `coin`
- **Why it's a game rule:** currency names and "a heart heals" are content decisions.
- **Dependents:**
  - flow score rules, `game-host/src/score.ts`
  - `RunSaveState.counters`
  - the m9-blocks and sprout-meadows tests
- **Recommendation:** (a) a generic **`collectible { counter, amount, onCollect: signal, respawn }`** with no kind enum. On load, `kind` upgrades to `counter`, keeping the old counter names.
- **Effort:** M.

### C3. Player-only health, invulnerability, knockback
- **Where:**
  - `project-model/src/blocks.ts:123-136`
  - `runtime/src/blocks.ts:589-604` (health exists only when `e.id === playerId`, line 590) and `1240-1276`
  - `ctx.game.health()` (`runtime/src/types.ts:1948`)
- **Why it's a game rule:** health lives only on the player, and it comes with a platformer feel: i-frames, a hit bounce, and "without health, any damage kills".
- **Dependents:**
  - `RunSaveState.health`
  - the HUD
  - the protocol flow view
  - the respawn refill (`runtime/src/blocks.ts:703`)
- **Recommendation:** (a) a generic **`health` component on any entity**, with `ctx.health.damage/heal` and `damaged`/`died` events. Knockback and i-frames move to (b) scripts.
- **Effort:** M.

### C4. Game zones with fixed roles and priority
- **Where:**
  - `project-model/src/types-v3.ts:59-93` (`GAME_ZONE_ROLES(_V4)`, `GameZoneComponent`)
  - `platformer-game/src/zones.ts:141, 165-200` (`decideZones`)
  - `runtime/src/runtime.ts:5000-5044` (`beginRespawn`, `activateCheckpoint`, `reachGoal`)
- **What:**
  - A closed set of roles, where hazard (death) beats checkpoint, which beats goal (`won`).
  - Only the first checkpoint of a run activates (`zones.ts:141`, enforced again at `runtime.ts:5019`).
- **Why it's a game rule:** death, checkpoints, winning, and their order of precedence are level logic.
- **Dependents:**
  - protocol `m3.ts:526` (`won` state) and `:556-557` (events)
  - game-host flow
  - the editor zone overlay and gameplay validation
  - `scene-v3.ts:290-360`
  - `RunSaveState.checkpointId`
  - the renderer (see H6)
  - Beacon Reach, Sprout
- **Recommendation:**
  - (a) a generic **trigger zone with enter/exit events**, combined with the existing `ctx.lifecycle` (`setSpawn`/`respawn`/`restart`).
  - The role semantics move to (b) or (c) as a kit script.
  - At minimum, delete (d) the single-activation rule.
- **Effort:** L. It changes the schema and needs an upgrade path.

### C5. The `exit` zone role
- **Where:** `types-v3.ts:61, 86-89`; `runtime.ts:4940-4970`.
- **What:** scene streaming (unload, load, spawn at) disguised as a zone role.
- **Why:** this is a real capability, but it is packaged as a platformer rule.
- **Recommendation:** (a) a **`sceneTransition` trigger action**, or `ctx.scenes` from a script.
- **Effort:** S-M.

### C6. `GameSession`: run states, deaths, killY, cues
- **Where:**
  - `runtime/src/game-session.ts:110-432`
  - `GameConfig` in `types-v3.ts:440-469` (`killY`, `level`, `cues.{start,jump,checkpoint,death,goal}`)
  - `platformer-game/src/session.ts`
- **What:**
  - Run states: awaitingStart, playing, respawning, won.
  - `deathCount`, a fixed 30-step respawn delay, and death by falling below `killY`.
- **Why it's a game rule:** "won", "deaths" and "fall death" are rules. The v4 comments already say these belong in scripts.
- **Dependents:**
  - `GAME_RUN_STATES` and the event kinds in protocol `m3.ts`
  - HUD, flow, observation, cues
  - the step digest
  - Beacon Reach
- **Recommendation:**
  - (c) keep it for loading v3/Beacon content only.
  - New projects use `ctx.lifecycle` plus game modes (23.x).
  - Cues become an event → cue table (H5).
- **Effort:** L.

### C7. Flow model: lives and score formulas
- **Where:** `project-model/src/flow.ts:64` (`lives`), `:86-106` (`FlowScore`: points per counter plus a time bonus), `:176-182`.
- **Why it's a game rule:** lives, game over, and scoring are game design.
- **Dependents:** game-host `flow.ts`/`score.ts`, protocol `m3.ts:884`, the editor FlowPanel, the MCP `setFlow`.
- **Recommendation:**
  - (b) scripts using counters and UI bindings.
  - Keep the generic parts of the flow: `title`, `screens`, `hud`, `volumes`, and an ordered scene list.
- **Effort:** M.

### C8. Platformer module pinned into every build and every game
- **Where:**
  - `behavior-build/src/limits.ts:74` (`M2_PINNED_MODULES` pins `@thirdlight/platformer`)
  - `project-model/src/modules.ts:7-8, 40-42, 58, 61, 107-120`: any `content.game` implies the platformer set of controller → session → camera
  - `project-model/src/manifest.ts:82, 93`; `manifest-v2.ts:161-170`
  - `runtime/src/registry.ts:30`
  - `runtime/src/character3d.ts:348`
- **Why:** the "game block" is effectively the platformer, and there is no game without it.
- **Recommendation:**
  - (a) modules resolve only from declared or referenced components.
  - Unpin the platformer from `limits.ts`.
  - The platformer packages become an optional kit (c).
- **Effort:** M.

### C9. Platformer input and replay frame channels
- **Where:**
  - `input/src/actions.ts:299-374` (`platformerKeys`, `STANDARD_PLATFORMER_PAD`, `readPlatformerPad`) and `:383-388` (default config)
  - `runtime/src/actions.ts:32, 39, 161`: `ActionFrame` has fixed `moveX`/`jump` channels
- **Why:** the engine's input frame and default bindings are shaped around one controller.
- **Recommendation:**
  - (a) frames carry only generic named actions (they already carry an `actions` map).
  - The platformer controller reads `move`/`jump` from that map.
  - This needs a frame version bump and a replay migration.
- **Effort:** M.

### C10. Smaller core items
| Where | What | Rec. | Effort |
|---|---|---|---|
| `runtime/src/blocks.ts:1047` | The switch's `interact` mode reads the action name `'interact'` directly | (a) an `action` field, default `interact` | S |
| `runtime/src/blocks.ts:807-812, 1075-1078` → `runtime.ts:3405`, `platformer/src/controller.ts:253` | Only a stomp or a hit can make the character bounce | (a) expose **`ctx.character.impulse(v)`** (the intent already exists) | S |
| `runtime/src/blocks.ts:678-700`; `types-v3.ts:118-127`; `project-model/src/blocks.ts:443-456`, `runtime/src/blocks.ts:461-468, 1294-1314` | `playerSpawn.facing` left/right; `faceMovement` yaw fixed to the X-axis sign | (a) **a facing yaw or direction vector**, "face velocity" | S |
| `project-model/src/types-v3.ts:560-583`, `commands/src/types.ts:346`, `commands/src/v3.ts:177`, `validate-request.ts:845`, `validate-content-args.ts:272` | Surface preset `beacon`, named after the demo | (d), or rename to `emissive-accent` with a v3 alias | S |
| `runtime/src/types.ts:914-921`, `runtime.ts:2260` | `RunSaveState` hard-codes `collected`, `defeated`, `health`, `checkpointId` | (a) fold into the 23.19 saves as a `blocks` section | M |
| `platformer-game/src/camera.ts:152, 277, 315-320`; `cameraFollow` in `types-v3.ts:130-140` | Dead-zone/smoothing/bounds follow math (generic), but locked to the session module and a fixed `CAMERA_Z` | (a) a standalone **camera follow behaviour** beside `camera-brain.ts` | M |
| `platformer/src/` | The single-jump controller with coyote time and jump buffer | (c) a legitimate optional module; it just must not be pinned (C8) | — |

### Checked and generic in the core
- Mover, trigger, one-way colliders, signals and messages.
- `ctx.game.counter/add/setVisible`: counters are free-named. Only `health()` is tied to the player block.
- **23.10 `ctx.lifecycle`:** mechanism only (respawn, setSpawn, spawnPoint, restart). Lives, score and goals are explicitly left to scripts. One issue: it returns `false` while the platformer session is active, so there are two lifecycle owners. This resolves once C6 goes.
- **23.19 saves** (`runtime/src/project-saves.ts`, `project-model/src/save-schema.ts:50`, sections grid/materials/spawned/storage/environment/dialogue): generic.
- `character3d.ts`, `physics-rapier`, and the input evaluator.

---

## 2. Host, renderer, editor, MCP

### H1. game-host hard-wires the platformer modules
- **Where:**
  - `game-host/src/host.ts:67-71`: imports `platformerSpec` and the platformer-game specs.
  - `host.ts:634-674`: `selectModules` defaults to the platformer set.
  - `host.ts:711-716`: a game without a `controller` entity is refused ("the M3 game requires the player controller").
  - `exporter/src/graph.ts:40` allows both packages in every bundle.
  - `tools/check-boundaries.mjs:93-94, 190, 362, 370, 383, 444` lists them in the runtime, export and game-host rows.
- **Recommendation:**
  - (a) resolve modules through an injected spec table keyed by the manifest's module ids, with no default set.
  - A kit declares its own entity requirements.
- **Effort:** M.

### H2. The built-in game flow: levels, lives, score, level complete, game over
- **Where:** `game-host/src/flow.ts` (981 lines):
  - `:744-758`: a death costs a life; game over at 0.
  - `:760-764`: a checkpoint autosaves.
  - `:765-790`: `won` completes the level and tallies score, best scores and time.
  - `:453, 470, 709`: the `lives` and `defeated` counter names are special-cased.
  - `:948-966`: `$flow` exposes level, lives, score and result.
- **Also in game-host:** `host.ts:1422-1424` and `:1729-1810`.
- **Dependents:**
  - editor `FlowPanel.tsx`
  - `preview-m3.ts:672`, `export-bootstrap-m3.ts:525`, `content-closure.ts:511`
  - MCP `setFlow` and the `flow` field of `tl_game_observe`
- **Recommendation:**
  - Split it. Keep (a) a generic **shell menus** primitive: title, pause, settings, rebind, and save/load screens driven by UI documents. 23.9a `flow.screens` already allows replacing them, and `pause-panel.ts` is already genre-neutral.
  - The level list, lives, score and level-complete logic move to (b) scripts in Sprout, or to a shared platformer library.
- **Effort:** L.

### H3. The flow's platformer save format and score rules
- **Where:**
  - `game-host/src/save.ts:21-41`: `SaveDocument` with `levelId`, `levelIndex`, `lives`, `levels{collected,bestSeconds}`, `score`, `bestScores`, and an embedded `RunSaveState`.
  - `game-host/src/score.ts:1-37`: points per counter plus a time bonus.
- **Dependents:**
  - `host.ts:1462-1486` (`start.save`/`saveSlot`)
  - the MCP `tl_play_start` `save` input (`mcp-adapter/src/tools.ts:543, 555`)
  - the FlowPanel ScoreSection
  - `editor/src/ui/App.tsx:165-172` seeds the counter names `coins, gems, keys, lives, defeated`
- **Recommendation:**
  - (d) once 23.19 project saves carry the same data.
  - Ship a v1 flow-save reader in the kit so existing localStorage slots can be converted (b).
  - Score goes with the flow (b).
- **Effort:** M.

### H4. The classic HUD and prompts
- **Where:**
  - `game-host/src/hud.ts:37-58, 160-167`: deaths, checkpoint step, and a "Coins 3 · Health 2/3" line.
  - `host.ts:918-938` builds it and drops `defeated`/`lives`.
  - `game-host/src/bindings.ts:35, 150-161`: `PAD_STANDARD {jump,left,right}`, "… to move, … to jump", "You win — press … to replay".
  - `export-bootstrap-m3.ts:606`: the export debug HUD shows deaths and goal.
- **Recommendation:**
  - (a) a generic status overlay (title, objective, prompts generated from the declared input actions).
  - Game HUDs become project UI documents.
  - The classic HUD moves to the kit (c).
- **Effort:** S-M.

### H5. Fixed observation fields and cue slots
- **Where:**
  - `host.ts:204-213`: `GameHostObservation.{checkpointId, deathCount, goalReached, failed}`.
  - `host.ts:509-521`: the cue map start/jump/checkpoint/death/goal, where `jump` is derived from the platformer's grounded → airborne change.
  - editor `session/media.ts:98` `CUE_SLOTS`.
- **Recommendation:**
  - (a) an **event → cue table** keyed by event name, which the kit fills.
  - The observation keeps generic fields; session data becomes an optional sub-object.
- **Effort:** M. This changes the MCP contract.

### H6. The renderer knows about checkpoints
- **Where:** `three-adapter/src/adapter.ts:1076-1100` reads `getGameView().checkpointId` and applies `gameZone.activation`.
- **Recommendation:** (a) a generic **per-entity emissive/look override** that the sim or scripts set.
- **Effort:** S.

### H7. Surface presets named after the demo
- **Where:** `three-adapter/src/lighting.ts:77-98` and `editor/src/session/media.ts:286-299` (`hazard`, `beacon`).
- **Recommendation:** move them to the Beacon sample's material library (c) and keep an alias (see C10).
- **Effort:** S.

### H8. The editor's platformer authoring layer
- **Where:**
  - `editor/src/session/gameplay.ts`:
    - `:27-53`: six hard-coded platformer tuning settings.
    - `:243-261`: validation requires a goal zone and allows at most one checkpoint.
    - `:292`: cue slots.
    - `:338-370`: `ZONE_ROLES`, zone sizes fitted to a 1.8 m character and a 1.25 m jump.
  - `ui/GameplayPanel.tsx` (all four tabs; killY defaults at `:158, :174`; `:298-302`).
  - `ui/App.tsx:4146-4171`:
    - GameObject menu: Player spawn; Zone → Hazard/Checkpoint/Goal/Exit.
    - Gameplay menu: Coin, Enemy ("0.4 m coin, 0.8 m enemy it can jump on").
  - `ui/FlowPanel.tsx:97, 201-207, 342-355`: a lives section; the default is `lives {start:3,max:9}`.
  - `ui/Inspector.tsx:189, 300-313`: capsule text mentions "pickups and stomps"; special cases for controller and exit.
  - `viewport/icons.ts:21-91`: enemy and pickup icons.
- **Recommendation:**
  - (a) **editor extension points**: panels, menu items, icons and wording contributed by descriptors or an installed kit.
  - The platformer panel, menus and validation move to the kit (c).
  - The core keeps generic items: platforms, mover, switch, trigger, spawn point.
- **Effort:** M-L.

### H9. Smaller host items
| Where | What | Rec. | Effort |
|---|---|---|---|
| `editor/src/ui/AnimatorPanel.tsx:49-89`, `ui/animator/parts.tsx:132-180` | "New from clips: Platformer" preset | (c), or rename it "Character locomotion" with generic parameters | S |
| `backend/src/play-start.ts:53-80` | Start scene → flow `levelId`/`playerSpawn` lookup | (a) key it on "the start scene's spawn" | S |
| `workspace/src/envelope.ts:885-895` | Placeholder `playerSpawn` for `gameZone.safeSpawnId/spawnId` | moves with C4 | S |
| `mcp-adapter/src/tools.ts:134-135, 190-206, 270-271, 515, 543` | Tool descriptions teach coin/gem/heart/life/key, stompable, lives, level save | (a) generate from descriptors and installed kits | S-M |
| `gameplay.ts:365-366`, `App.tsx:1706-1707`, `descriptors.ts:699, 771, 914` | Comments naming Beacon (values were de-Beaconised in 15.5) | (d) the comments | S |

### Checked and generic in the host
- **23.19** `game-host/src/project-saves.ts`: schema-driven slots with no level or lives fields. This is the replacement for H3.
- **23.16** default dialogue UI (`dialogue-preview.ts`, `project-model/src/dialogue.ts`): no genre terms.
- `pause-panel.ts`, `ui-layer.ts`, `ui-text.ts`, `audio.ts`, `rebind.ts`, `input-bindings.ts`.
- Scene mode (a game without a game block).
- `effects`, `asset-pipeline`.
- Templates are data-driven, and the default new project is "Empty scene".

---

## 3. Tests, samples, tooling

### T1. Tests that read the Sprout repo
| Where | What | Rec. | Effort |
|---|---|---|---|
| `tests/integration/sprout-meadows/sprout-meadows.test.ts:28, 268-271, 281-282` | Plays Sprout's 10 levels headlessly; asserts Sprout's level list and "every stomped boar dropped a coin". Runs in `npm test` whenever the Sprout repo exists, so an unfinished edit in the game repo turns the engine gate red. | (b) move to the Sprout repo's CI | S |
| `TL_SKIP_SPROUT` (read only at `sprout-meadows.test.ts:282`; documented in `docs/plan-phase-23.md:292, 332`) | An opt-out needed because of the above. The final phase 23 gate was green only with it set. | (d) delete with the test | S |
| `tests/e2e/sprout-live.e2e.ts:18-24, 52, 74, 121` | Drives the owner's live `projects/sprout` over the admin API with an optional Blender bake. This is a production script. | (b) move to the Sprout repo | S |
| `tests/e2e/animator-sprout.e2e.ts:18, 50` | Reads `char_sprout.glb` (skips if missing) | (a) re-fixture with `tests/e2e/skinned-glb.ts` | M |
| `tests/e2e/lightmaps-sprout.e2e.ts:18, 36` | Reads Sprout's meadow kit GLB | (a) re-fixture with `tests/e2e/multi-piece-glb.ts` | M |
| `tests/integration/m2-builds/stage-expiry.test.ts`, `packages/workspace/tests/registry.test.ts:36-126` | "sprout" used as a name only | (d) rename to a neutral name | S |

### T2. Beacon Reach as the engine's default fixture
- **Where:**
  - `samples/beacon-reach/` is a complete platformer game, and it is the only template (`backend/src/templates.ts:29`, `ROOTS = ['templates','samples']`).
  - 38 e2e files call `startBackend(…, 'beacon-reach')`. That includes the **smoke set** (`tools/gate.sh:24`: `start`, `scenes`), so every per-commit gate depends on the sample.
  - A further 9 integration/evaluation files use it, including `m3-sample/*`, `evaluations/m3-browser`, `m4-baseline`, and `m4-render/tools`.
- **Recommendation:**
  - (a) a minimal generic fixture template: boxes, a spawn, a camera, a light. Switch every test whose subject is generic to it.
  - Beacon Reach stays as (c) an optional sample kit with its own acceptance tests (`beacon-reach.e2e.ts`, `m3-sample/*`) in an optional sample gate.
- **Effort:** L (mechanical, but many files).

### T3. Game rules asserted as engine requirements
- **Tests:**
  - `tests/integration/m9-blocks/blocks.test.ts:5, 105-115`: expects `{coins, gems, stars}` counters and "stomped from above".
  - `m15-tuning/tuning.test.ts:22, 145-162`: tunes enemy stomp values.
  - `tests/e2e/score.e2e.ts:3-5, 53`: "10 points per coin".
  - Coin/lives cases in m9-flow, m14-*, visual-script, flow, and saves.
- **Fixtures:** `fixtures/m2/contracts/platformer/`, `fixtures/m2/course/`, and `fixtures/m3/contracts/migration/v2-source`.
- **Recommendation:**
  - Rules move with the kit (c).
  - Where the subject is a generic counter or score, rename to neutral counters (a).
  - Keep one generic "trigger → counter/hide" test in the core.
- **Effort:** S-M each.

**Counts:**
- About 16 test/tool files import `@thirdlight/platformer(-game)` directly.
- About 47 name the platformer, and about 33 use coin/lives/stomp in assertions.
- In total about **80-90 test files** depend on platformer features or Beacon content.

**What happens to them:**
- **Rewrite against generic fixtures:** the 38 Beacon e2e files, m3-camera/*, m3-respawn, m23-camera/determinism, m22 worker parity, m3-builds/*, m3-export bundle-scan, m9-flow/*, m14-*, visual-script, perf/alloc, `tools/perf/*`, m4-render probes, browser/m2-input, and browser/m3-render.
- **Move with the kit unchanged:** m2-controller/*, browser/m2-controller, m3-gameplay/course, the enemy and pickup-kind cases of m9-blocks and m15-tuning, m3-sample/*, beacon-reach.e2e, and evaluations/m3-browser.

### T4. Docs
- Plans for phases 9, 14, 15, 17, 19, 21 and 22, `roadmap.md`, and `decisions/0005` set engine acceptance in terms of Sprout's levels (e.g. 9.13 and 14.9, "a boar drops a coin").
- `docs/plan-phase-23.md:9-14, 42` already frames Skyforge correctly, as a consumer whose rules stay in its own repo.
- **Recommendation:** use that as the template, and rewrite future acceptance criteria as generic capabilities. **Effort:** S.

---

## 4. Proposed migration phase (phase 24, "separation")

**Aims:**
- Each step leaves existing projects loadable.
- Recorded replays either stay bit-identical or are explicitly re-recorded with a note in the plan.
- The gate stays green per step.
- Sprout is migrated in its own repo, by its owner, after the engine ships the primitives. The engine never reads Sprout.

1. **Freeze.**
   - No new fields on the enemy, pickup, health, gameZone or flow blocks.
   - Revert or freeze the 24.0 chase fields (C1).
   - Add a principle 1b to `docs/roadmap.md` (see section 5).
2. **Decouple the tests from Sprout.** Move sprout-meadows and sprout-live out, delete `TL_SKIP_SPROUT`, and re-fixture animator/lightmaps (T1). This makes the gate independent of the game repo immediately.
3. **Add a generic fixture template** and switch the smoke set and every generic-subject test to it (T2). Beacon Reach tests move to an optional `gate.sh sample` tier.
4. **Unwire the modules:**
   - Unpin the platformer (`limits.ts:74`).
   - The host resolves modules from the manifest with no default set.
   - Drop the implication that a game means the platformer (C8, H1).
   - Bundles without platformer content stop shipping it. The m3-export bundle-scan is updated deliberately.
5. **Ship the generic primitives:**
   - `collectible`
   - `health` on any entity with events
   - `patrol` mover
   - `hitbox` contact events with normals
   - trigger enter/exit plus `sceneTransition`
   - `ctx.character.impulse`
   - facing yaw
   - standalone camera follow
   - configurable switch action
   - per-entity look override
   - event → cue table
   - editor extension points (C1-C5, C9, C10, H4-H6, H8)

   These are additive, so no replay changes.
6. **Create the platformer kit.** Move `packages/platformer`, `platformer-game`, the enemy/pickup-kind/health/gameZone/session runtime code, the classic HUD, the flow's level, lives and score logic, and the editor Gameplay panel and menus into an optional kit, loaded as a module and a set of editor contributions. v3 and Beacon projects that reference these components resolve the kit through their manifest, so they keep loading and their replays keep matching. Beacon Reach declares the kit.
7. **Upgrade the formats:**
   - A new schema version maps v3 content: pickup `kind` → `counter`, `beacon` preset → `emissive-accent`, and gameZone roles → kit components.
   - The input frame version drops the fixed `moveX`/`jump` channels.
   - A kit-shipped reader converts flow saves v1 to project saves.
   - Replays that change are re-recorded, with one line each in the plan.
8. **Make the core generic:**
   - Protocol `GAME_RUN_STATES` and checkpoint/goal events become kit events.
   - `GameHostObservation` and the MCP descriptions become generic (H5, H9).
   - `$flow` keeps only generic keys.
9. **Sprout moves over, in its own repo.** Sprout replaces kit blocks with its own scripts and 23.7 shared libraries over the new primitives (boars, coins, lives, score), or it declares the kit. The Sprout playthrough runs in Sprout's CI.
10. **Delete (d)** the kit pieces no project depends on any more, and the demo-named comments.

**Rough total:** 3–4 weeks of agent work. The larger steps are 3 (L), 5 (L), 6 (L) and 7 (M-L); steps 1–2 take a day.

---

## 5. Why game-level logic ended up in engine code

- **The first goal was a playable demo, and the engine was the only place to put code.**
  - The charter's first release named "platformer movement, … HUD" as an engine feature, and "first game is a side-scrolling 2.5D platformer".
  - Phase 4 ("Beacon Reach is honestly playable") and phase 9 ("towards a real platformer") had to produce a game you could play.
  - At that time there were no project scripts, shared libraries, UI documents, game modes or `ctx.lifecycle`. Those arrived in phases 19 and 23.
  - So every feature the demo needed was written as an engine block: enemies, coins, lives, checkpoints, score, the HUD. The "game block" and the platformer became the same thing.
- **Roadmap principle 1 checked the wrong thing.**
  - "Generic, never demo-shaped" was applied to *defaults and dimensions*. Phase 15.5 removed Beacon values, and phase 23 fixed 2D-only APIs.
  - It never asked whether a feature was itself a *game rule*. A stompable enemy with neutral defaults passes principle 1 and is still Mario's rule in the engine.
  - Acceptance criteria were written against Sprout's levels (T4), which pulled game rules in as engine requirements.
- **The work drifted without a plan.** The Phase 24.0 chase fields were added by another model without a plan, because the pattern "Sprout needs X → add X to the enemy block" was already established and nothing stopped it.
- **The coupling made itself look normal.** Beacon Reach became the default test fixture and Sprout became a gate test. That made the genre layer look load-bearing, and it let an unfinished game edit break the engine gate (`TL_SKIP_SPROUT`).
- **Fix for the process:** add a principle 1b to the roadmap. "Before adding a component, block, field or API, ask: would a game in a different genre use this unchanged? If it encodes what the game *is* (win and lose, currencies, enemy behaviour, level order), it is project code and goes in the game repo, built on engine primitives. The engine never reads a game repo, and game repos are not engine test fixtures."
