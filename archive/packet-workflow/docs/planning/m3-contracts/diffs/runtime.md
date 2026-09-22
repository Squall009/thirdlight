**PROPOSED — not accepted.** Packet 40 (`docs/planning/m3-packets.md` §40)
output. Section-level diffs for `docs/contracts/runtime.md`. This file contains
no accepted text. Normative text lives in
[`../gameplay.md`](../gameplay.md) (the new contract home for the M3 game
session) and is referenced per row; this file names the exact destination, the
shortest unique OLD quote and the NEW text. Convention (same as
[`../../m2-contracts/diffs/runtime.md`](../../m2-contracts/diffs/runtime.md)):
`OLD` is accepted text exactly as it reads today; `NEW` is the replacement; `+`
blocks are pure insertions. Accepted section numbers are never renumbered: new
runtime material is appended as **§15**; `gameplay.md` is the new sibling
contract. Superseded text is called out explicitly — no accepted sentence is
silently redefined.

Read basis: accepted `runtime.md` §§1–14; `project-model.md` §§6/21;
`commands.md` §5.4; [`../model.md`](../model.md) §23 (packet 39 PROPOSED);
[`../gameplay.md`](../gameplay.md) (§§2–8 are the normative rule text);
packet 38 evidence (no bearing here); handoffs 38/39.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| R40-1 | §1 "Scope and ownership" | insert bullets | gameplay.md §1 |
| R40-2 | §2 "Runtime snapshot" | insert field + rule | gameplay.md §3.3, §4.1 |
| R40-3 | §3.2 "`start()`" | insert bullet (run-start barrier) | gameplay.md §2.2 T1, §5.1 |
| R40-4 | §4 "Mutable simulation state" | insert paragraph (`lastCommitted`) | gameplay.md §3.3 |
| R40-5 | §5 "Fixed steps with bounded catch-up" | insert boundary rule | gameplay.md §3.2 item 0 |
| R40-6 | §6 "Render interpolation policy" | reword frame ordering | gameplay.md §3.2, §7.2 |
| R40-7 | §8 "Structured diagnostics" | insert rows + reasons + fields | gameplay.md §8.1 |
| R40-8 | §12.1 "Phase registration…" | reword type + order + inventory + `ModuleConfig` | gameplay.md §3.1, §3.4 |
| R40-9 | §12.2 "Write guard…" | insert M3 clause | gameplay.md §3.4 |
| R40-10 | §12.3 "Transform ownership…" | insert camera row | gameplay.md §3.4 |
| R40-11 | §12.4 "Unsupported module combinations" | **supersede** one row (M3 sets) + insert rows | gameplay.md §3.4 |
| R40-12 | §12.6 "The physics port…" | insert restricted reset ops + forbid `reset()` | gameplay.md §5.2 |
| R40-13 | §13 "M2 fail-stop lifecycle" | insert reset failure + view retention | gameplay.md §5.4, §6 |
| R40-14 | §14.5 "`IntentSet`, … effective-input rule" | insert M3 overrides | gameplay.md §2.5 |
| R40-15 | **new §15** "M3 game session: schedule, reset barrier, view and camera" | insert section | gameplay.md §§2–7 (pointer + runtime mechanics) |
| R40-16 | §11 "Change rules" | insert bullets | gameplay.md §12 |
| R40-17 | §15.5 "The committed `GameView`" (via R40-15) | insert field + rule (Gate K repair, C41-1) | gameplay.md §6 |

Not changed: §3's runtime state machine (`instantiated/running/stopped/failed/
disposed` — the **run** state is different data and lives in the new §15);
§3.3 `stop()`, §3.4 `dispose()` (the retained view follows the retained
interpolated state); §4's `order`/`entities`/`prev`/`curr` structure; §5's
constants (`SIM_HZ = 120`, `MAX_CATCHUP_STEPS = 8`), `rawN` formula and
drop-and-resync; §6's interpolation math and read-only rule; §7's demo math;
§9's import list; §10's non-goals (§15/gameplay.md §12 adds M3 non-goals without
redefining an M1 one); §12.5's sampling, latch and quantization rules; §12.7's
replay tolerances; §14.2–§14.8's behavior boundary (the M3 additions are
orthogonal to behaviors).

---

## B. Existing sections

### R40-1 — §1 "Scope and ownership": insert bullets

Anchor: after the bullet ending `- The **structured diagnostics** shape and error
codes.`

```diff
+- The **M3 run** and its schedule: the run state machine, the M3-only phases
+  (`gameplay`, `camera`), the step-boundary reset transaction, the committed
+  read-only game view and the gameplay camera's transform ownership (new §15;
+  rule text in the sibling contract `gameplay.md`).
+- The **gameplay zone service boundary**: a pure swept-capsule/zone predicate
+  over the last completed motion segment, which never moves anything
+  (`gameplay.md` §4).
+- The **committed `GameView`** observation and its bound (`gameplay.md` §6).
+- The **restricted physics reset/clearance operations** the runtime owns for
+  respawn; the accepted diagnostic `PhysicsPort.reset` stays tests-only
+  (`gameplay.md` §5.2).
```

### R40-2 — §2 "Runtime snapshot": the v3 `game` field

**(a) the example block** — anchor: the line ending `"entities": [ "…" ]`:

```diff
   "scene": {
     "schemaVersion": 1,
     "sceneId": "scene-main",
     "revision": 12,
     "entities": [ "…" ]
-  }
+  },
+  "game": null
 }
```

**(b) insert a field row** after the `scene` row of the field table:

```diff
+| `game` | **v3 snapshots only, required.** A deep-frozen copy of the validated `content.game` block (`project-model` §23.4) or `null`. Present iff `scene.schemaVersion === 3`; absent for v1/v2 (an unknown field on a v1/v2 snapshot is still `snapshot_invalid`, `reason: "shape"`). A v3 snapshot without it, or with a value that fails the §23.4 shape/level/`killY` rules, is `snapshot_invalid` (`reason: "shape"` / `reason: "scene_validation"`). |
```

**(c) insert a rule** after the bullet ending `- **Bounded.** ≤ 1024 entities
(project-model §10.4) — the snapshot is a bounded document; this bound makes the
bridge relay and export metadata bounded as well.`

```diff
+- **The game block travels with the snapshot (M3).** The run's level bounds,
+  `killY`, cue references and `spawnId`/`playerId`/`cameraId` are the frozen
+  `content.game` block, which is envelope content rather than scene data. It is
+  therefore carried **inside** the snapshot (never re-read from disk, never
+  looked up through the runtime's host) so that one snapshot remains the
+  runtime's only input (`gameplay.md` §3.3). The zone/`cameraFollow`/
+  `playerSpawn` data it references is already scene data and needs no wrapper.
```

### R40-3 — §3.2 "`start()`": insert the run-start barrier bullet

Anchor: after the settle-pre-roll bullet ending `A module or port error during
the pre-roll is a normal fail-stop (§13). M1 module sets execute no pre-roll.`

```diff
+- **Run-start barrier (M3-enabled sets).** `start()` does not itself start a
+  run: the run begins in `awaitingStart` and becomes `playing` only when the
+  host's `start` run command is consumed at a step boundary (§15,
+  `gameplay.md` §2.2 T1). The barrier makes `prev == curr` and snaps the
+  gameplay camera (`gameplay.md` §5.1 R7, §7.4); it performs no physics reset,
+  so the accepted settle pre-roll still owns capsule settling.
```

### R40-4 — §4 "Mutable simulation state": insert `lastCommitted`

Anchor: after the bullet ending `- **Private state is not in `state`.** … safe
restart, not rollback.` (the paragraph beginning `The physics world, the
controller's velocity/window state`).

```diff
+- **`lastCommitted` (M3, runtime-private).** The runtime keeps one additional
+  map, `lastCommitted: Map<id, transform>`, holding the transforms committed at
+  the end of the last completed step. It is updated at every commit and **by the
+  reset transaction** (`gameplay.md` §5.1 R7). It exists because during step `n`
+  the accepted commit order leaves `state.prev` holding the end of step `n−2`
+  (the `prev := curr` promotion happens at the end of the step): a `gameplay`
+  phase that needs "the last completed motion segment" must ask for it instead
+  of reading `state.prev` (`gameplay.md` §3.3, fixture `segment-source`).
+  `lastCommitted` is not exposed to modules as a map; it is readable only
+  through `GameSessionPort.lastMotionSegment(entityId)`.
```

### R40-5 — §5 "Fixed steps with bounded catch-up": the boundary rule

Insert a bullet after the list item ending `- **No phantom steps, no replayed
edges.** … (platformer.md §2.1, fixtures `runtime/catchup.json`).`

```diff
+- **M3 step boundary (additive).** For an M3-enabled set, the step loop first
+  consumes the runtime's boundary queues — a pending `replay`/`start` run
+  command and a due scheduled reset — and only then performs `prev := curr` and
+  samples. Consuming a reset therefore writes into `curr` **before** the
+  promotion, which is what makes a reset produce `prev == curr` (no teleport
+  sweep, no render streak; `gameplay.md` §3.2, §5.1). Non-M3 sets do not enter
+  the hook at all: no branch, no state, no timing change.
```

### R40-6 — §6 frame ordering: the M3 phases

Anchor: the paragraph beginning `**Frame ordering (normative for the adapter,
packet 08; extended for M2):**`.

```diff
-**Frame ordering (normative for the adapter, packet 08; extended for M2):**
-the runtime owns the single frame driver. Each **executed step** runs the six
-phases of §12 (`sample → intent → controller → physics → transform`), then the
-frame continues with (2) `onFrame()` — the adapter reads
+**Frame ordering (normative for the adapter, packet 08; extended for M2 and
+M3):** the runtime owns the single frame driver. Each **executed step** runs the
+phases of §12/§15 (`boundary → sample → intent → controller → physics →
+transform → gameplay → camera → commit`; the last three are M3-only and absent
+for M1/M2 sets), then the frame continues with (2) `onFrame()` — the adapter reads
 `getInterpolatedState()`, copies values into Object3Ds, (3) renders. The
 adapter never installs its own animation loop (no duplicate loops; one loop
 owner = the runtime), never writes authoritative state, and never applies
 gameplay smoothing: the interpolated values are derived read-only from the
 authoritative `prev`/`curr` (`physics.md` §7's stall-jitter decision).
+
+The M3 gameplay camera's pose needs **no extra adapter API and no new read
+call**: the camera entity is a transform owner, so its pose is published through
+`getInterpolatedState()` exactly like every other entity
+(`gameplay.md` §3.4/§7.2). `getCamera()` keeps returning the projection
+parameters only (unchanged). A viewport resize reaches the camera through the
+runtime's viewport record (`Runtime.setViewport`, §15); the adapter never
+computes a gameplay camera pose.
```

### R40-7 — §8 "Structured diagnostics": rows, reasons and fields

**(a) error-code rows** — insert after the `physics_port_error` row:

```diff
+| `game_command_invalid` | a run command is rejected for the current run state or conflicts with a pending command (M3) |
+| `game_spawn_invalid` | the reset destination does not resolve, is outside `content.game.level`, or is at/below `killY` (M3; fail-stop) |
+| `game_spawn_blocked` | the reset destination's clearance/overlap probe failed: `blocked` / `no_support` / `hazard` / `query_failed` (M3; fail-stop) |
+| `camera_viewport_invalid` | `setViewport` received a non-finite, non-positive or oversized dimension (M3; presentation-only) |
+| `game_session_unavailable` | a run/view/viewport call on a runtime that is not M3-enabled (`reason: "schedule"`) |
```

**(b) reason strings** — anchor: the paragraph ending `… plus `physics_port`,
`controller_target`, `scene_version`.`

```diff
+**M3 additions.** `module_error` additionally accepts the reason
+`gameplay_invalid` (a session commit call violates a run-state rule);
+`physics_port_error` additionally accepts the reason `reset` (a reset-barrier
+port failure). No accepted code, reason or carries-shape changes meaning.
```

**(c) diagnostics fields** — insert after the `failed` row of the field table:

```diff
+| `runState` / `runId` / `deathCount` / `checkpointId` / `gameEventCount` | M3-only run counters (`gameplay.md` §6). Present exactly when the set is M3-enabled; absent for M1/M2 sets (frozen field set preserved). `gameEventCount` is cumulative; the retained list is bounded at `MAX_GAME_EVENTS = 32`. |
```

### R40-8 — §12.1 "Phase registration and the canonical phase order"

**(a) the phase type** (two lines):

```diff
-type SimulationPhase = 'intent' | 'controller' | 'transform';   // canonical order
+type SimulationPhase = 'intent' | 'controller' | 'transform'    // accepted M2 order
+                     | 'gameplay' | 'camera';                   // M3 additions, appended
```

and, after the code block's closing fence, one sentence:

```diff
+`SIMULATION_PHASE_ORDER` becomes
+`['intent','controller','transform','gameplay','camera']`. Every accepted M2
+phase list is a **prefix** of the new order and stays valid unchanged; a phase
+list that skips or reorders a phase is still rejected. A set is **M3-enabled**
+iff at least one selected module declares `gameplay` or `camera`
+(`gameplay.md` §3.1).
```

**(b) the module interface** — insert into the `SimulationPhaseModule` block:

```diff
 interface SimulationPhaseModule {         // the M2 phased module interface (C29-4)
   readonly transformOwners: readonly string[];   // declared once, at create
   step(phase: SimulationPhase, ctx: StepContext): void;
+  /** M3 only: runtime-called reset-barrier hook (`gameplay.md` §5.1 R6). */
+  reset?(ctx: ModuleResetContext): void;
   dispose?(): void;
 }
```

**(c) `ModuleConfig`** — two additive fields:

```diff
 interface ModuleConfig {                    // `cfg`, passed to `create`
   fixedStepHz: number;                      // §3.1
   settings: Readonly<GameplaySettings>;     // resolved at instantiate (§8)
-  sceneVersion: 1 | 2;                      // the snapshot's schemaVersion
+  sceneVersion: 1 | 2 | 3;                  // the snapshot's schemaVersion
+  game?: Readonly<GameConfig>;              // v3 only: the frozen content.game block
   behaviorLog?(level: BehaviorLogLevel, message: string): void;  // C34-2
 }
```

**(d) module inventory** — insert rows after the behavior-modules row:

```diff
+| `thirdlight.platformer-game:session` (M3) | `["gameplay"]` | none (`[]`) | the pure run/zone module; stateless (`gameplay.md` §3.3/§4) |
+| `thirdlight.platformer-game:camera` (M3) | `["camera"]` | exactly the scene's single `camera` entity | the only camera writer (`gameplay.md` §3.4/§7) |
```

### R40-9 — §12.2 "Write guard and phase violations": M3 clause

Anchor: the bullet ending `- `state.prev`, `state.order`, `state.entities`
component data and the snapshot are read-only in every phase.`

```diff
+- **M3 phase scoping.** In the `camera` phase, a phased module may write `curr`
+  only for declared owners that are the camera entity, and only
+  `position.x`/`position.y`. In the `gameplay` phase `curr` is read-only
+  (throwing). Writing outside these rules is `module_error`
+  (`reason: "phase_violation"`) → fail-stop. The accepted `transform` rule is
+  unchanged (`gameplay.md` §3.4).
```

### R40-10 — §12.3 "Transform ownership": the camera row

Insert a bullet after the bullet ending `… the character cannot be moved twice in
one step.`

```diff
+- **Exactly one camera writer (M3).** The M3 gameplay camera entity's `curr`
+  `position.x`/`position.y` is written only by the single `camera`-phase module
+  in the `camera` phase; `position.z` (the authored view depth), `rotation` and
+  `scale` are never written. The camera pose is published through §6's
+  interpolation like any other transform. Editor navigation owns a different
+  camera object and reads/writes no runtime state (`gameplay.md` §7.6).
```

### R40-11 — §12.4 "Unsupported module combinations"

**(a) supersede the camera row for M3 sets.** The OLD row is *not* deleted for
M1/M2 sets; it is qualified:

```diff
-| a module claims the camera entity | `transform_owner_forbidden` | `camera` |
+| a module claims the camera entity, in a **non-M3** set | `transform_owner_forbidden` | `camera` |
```

and insert after the table:

```diff
+**M3 supersession (scoped).** For an M3-enabled set the camera row above is
+replaced by `gameplay.md` §3.4's validation: the set must contain exactly one
+`camera`-phase module whose `transformOwners` is exactly `[cameraId]`
+(`config_invalid`, `reason: "camera_owner"`, `detail` `missing` / `multiple` /
+`owner_mismatch`); at most one `gameplay`-phase module
+(`config_invalid`, `reason: "gameplay_module"`); a v3 requirement
+(`config_invalid`, `reason: "scene_version"`); `game !== null`
+(`config_invalid`, `reason: "game_config"`); and a `cameraFollow` component on
+the camera entity (`config_invalid`, `reason: "camera_follow"`). Every other row
+of this table is unchanged for M3 sets, including
+"a module claims a `collider`/`controller` entity without being the controller
+module".
```

### R40-12 — §12.6 "The physics port and the physics-phase call": restricted reset ops

**(a) the port interface block** — insert after the `PhysicsPort` block:

```diff
+/** M3 additions (`gameplay.md` §5.2). Callable by the runtime only, at the
+ * reset barrier. Never exposed on `PhysicsStepClient` or `GameSessionPort`. */
+interface CharacterClearanceResult {
+  ok: boolean;
+  reason?: 'blocked' | 'no_support' | 'out_of_bounds' | 'hazard' | 'query_failed';
+  supportNormal?: Vec2;
+  penetration?: number;              // m, deepest overlap with a static collider
+}
+interface PhysicsResetPort extends PhysicsPort {
+  clearCharacterMotion(): void;                     // zero cached/kinematic motion
+  placeCharacter(center: Vec2): CharacterClearanceResult;   // re-place + report
+  characterClearance(center: Vec2): CharacterClearanceResult; // query only
+}
```

**(b) the rules list** — extend the bullet ending `- **No Z.** No port method
accepts or returns a Z value.`

```diff
+- **The diagnostic `reset()` is never a gameplay path (normative).** `reset`
+  stays tests/diagnostics-only and **must not** be called by any module, the
+  session, the camera, a behavior, the HUD, the editor or the exporter. Respawn
+  uses the three restricted operations above under the runtime's reset
+  transaction (`gameplay.md` §5); `characterClearance` mutates nothing, and the
+  runtime performs R1–R3 of that transaction before the first mutation.
```

### R40-13 — §13 "M2 fail-stop lifecycle": reset failure and view retention

**(a) trigger list** — extend the paragraph beginning `**Trigger.** Any of:`:

```diff
-**Trigger.** Any of: a module `step` throws (any phase); the injected port
+**Trigger.** Any of: a module `step` or `reset` throws (any phase); a
+reset-barrier failure with the codes `game_spawn_invalid` / `game_spawn_blocked`
+(`gameplay.md` §5.4); the injected port
```

**(b) effect item 4** — insert after item 4 (`… the last completed render state
is retained`;):

```diff
+4a. `getGameView()` keeps returning the last committed view with
+   `failed: true` and `failure: { code, reason?, stepIndex }`; the run state is
+   frozen at its last committed value, no run event is appended, and a death is
+   never fabricated from a failure (`gameplay.md` §5.4/§6).
```

**(c) the no-rollback paragraph** — extend the sentence ending `**Safe restart
is the only recovery:**`:

```diff
-**No rollback (normative).** The runtime never attempts a transform-only
+**No rollback (normative).** The runtime never attempts a transform-only
 rollback of a half-mutated world
+(including a reset that failed after `clearCharacterMotion()` or
+`placeCharacter()` mutated the private world: the failed position is left as it
+is, unreported as a death and never resumed — `gameplay.md` §5.4)
```

### R40-14 — §14.5 "`IntentSet`, deterministic ordering and the effective-input rule"

Insert a paragraph after the bullet ending `… `ctx.action` remains the sampled
frame everywhere.`

```diff
+- **M3 effective-frame overrides (additive).** Two M3-only rules narrow the
+  effective frame without touching `ActionFrame`, the sampling rule or the
+  latch: (1) while the run is `awaitingStart`, `respawning` or `won` the
+  effective frame is neutral (`moveX: 0`, `jump: 'none'`) even though the frame
+  is still sampled exactly once; (2) the first `playing` step after a run-start,
+  respawn or replay boundary forces the effective `jump` column to `'none'`.
+  Both are pure functions of the committed run state and are replayed
+  identically by a recorded source (`gameplay.md` §2.5).
```

### R40-16 — §11 "Change rules": insert M3 bullets

Anchor: the last bullet of the accepted §11 list, ending `…is a contract
violation, not a feature.` This is the section body packet 40's summary row
declared but did not write (Gate K K-1/FU-6). OLD is verbatim:

```diff
 - Behavior source publication may be enabled only by packet 33's preparation
   path plus a reviewed contract diff (`behaviors.md` §8.3); a change that makes
   `publishBehavior{mode:"source"}` succeed without the prepare step is a
   contract violation, not a feature.
+- **The M3 game session is contract material.** Any change to a number in
+  `gameplay.md` §8.2, to the zone precedence order of `gameplay.md` §4.3, to the
+  phase order of `gameplay.md` §3.2 or to the reset transaction of `gameplay.md`
+  §5.1 invalidates the corresponding fixtures (`fixtures/m3/gameplay/**`,
+  `fixtures/m3/camera/**`) and reopens this contract; the fixtures are the
+  reviewable form of those numbers. Reordering the M3 phases, adding a second
+  transform writer, continuing after a module error or changing
+  `RESPAWN_DELAY_STEPS`/`CAMERA_Z`/`CAMERA_MAX_STEP` requires a reviewed change,
+  not a local implementation choice.
+- **The committed `GameView` is read-only contract material.** Its fields
+  (including the derived `playerMotion` of §15.5), the single-publication rule,
+  the `MAX_GAME_EVENTS` bound and the run identity tuple may not be extended or
+  reinterpreted without a reviewed diff; an implementation may not add a second
+  view, a second run-state owner or a second mutation path.
+- **M3 is additive over M2.** The M3 additions are optional and go through
+  `ModuleConfig`/`StepContext` exactly as `gameplay.md` describes; no accepted
+  M1/M2 field, code, order or default changes meaning and the M1/M2 fixtures
+  stay byte-identical (`gameplay.md` §3.5).
```

The rule text lives in `gameplay.md` §12 ("Change rules"); this row only
appends the bullets at the accepted §11 anchor, so promotion needs no accepted
sentence rewritten.

---

## C. New sections

### R40-15 — new §15 "M3 game session: schedule, reset barrier, view and camera"

Insert **after** §14 (end of document). This section is the runtime-side
mechanics; the **rule text** (run states, zone predicate, resets, camera math,
limits, errors, fixtures) is the new sibling contract `docs/contracts/gameplay.md`
and is promoted as one document ([`../gameplay.md`](../gameplay.md)):

| New subsection | Text source |
|---|---|
| §15.0 Scope: M3-enabled runtime, additive to §12 | `../gameplay.md` §1/§3.1 |
| §15.1 Run state machine, queued effects, bounded respawn delay | `../gameplay.md` §2 |
| §15.2 The M3 phase order and the step boundary | `../gameplay.md` §3.2 |
| §15.3 `StepContext.gameplay`, `GameSessionPort`, `ModuleResetContext` | `../gameplay.md` §3.3 |
| §15.4 The reset transaction and the restricted physics operations | `../gameplay.md` §5 |
| §15.5 The committed `GameView` and the run surface (`getGameView`, `gameCommand`, `setViewport`) | `../gameplay.md` §6 |
| §15.6 Camera transform ownership and the viewport record | `../gameplay.md` §7 |
| §15.7 Limits, error codes and diagnostics fields | `../gameplay.md` §8 |

The inserted section carries exactly the runtime-shaped interfaces
(`StepContext.gameplay`, `ModuleResetContext`, `PhysicsResetPort`,
`GameView`, the three `Runtime` calls) and cross-references `gameplay.md` for
every number, precedence rule and fixture, so no number is stated twice.

### R40-17 — §15.5 "The committed `GameView`": the `playerMotion` field

Authored by the Gate K bounded repair (**C41-1 resolved**, K-2/FU-4). It rewrites
no packet-40 row above: `gameplay.md` §6 is the rule text, and this row is the
runtime-side shape + rule restatement. Anchor: R40-15's §15.5 `GameView` shape
(`gameplay.md` §6).

```diff
 interface GameView {
   ...
+  readonly playerMotion: PlayerMotion;  // the committed motion the role selector consumes (C41-1)
 }
+
+interface PlayerMotion {
+  readonly speed: number;      // |Δ| over the last completed motion segment × fixedStepHz, m/s, finite ≥ 0
+  readonly grounded: boolean;  // the controller's committed grounding after that step
+}
```

Normative rule (restated; `gameplay.md` §6 owns it): `playerMotion` is derived at
phase 8 and at every reset boundary from the last **completed** step's
`lastMotionSegment(playerId)` (§3.3 item 0 / R40-4) and the controller's committed
grounding. It adds **no runtime state, no counter, no second writer and no second
simulation**, is never written back into the run, and is exactly
`{ speed: 0, grounded: true }` in `awaitingStart` and `won`. §2's snapshot shape
is unchanged: this is a `GameView` field, not a snapshot field (R41-4). The
selector (`presentation.md` §41.3.6) reads the view, never the runtime-private
motion segment.

---

## D. Cross-file requests (recorded, NOT applied here)

| # | Destination | Request |
|---|---|---|
| C40-D1 | `project-model.md` §21.4/§21.6 | Confirm that **no** `content.settings` key is added: `RESPAWN_DELAY_STEPS`, `CAMERA_Z`, `CAMERA_MAX_STEP`, `CAPSULE_RADIUS`/`HALF_HEIGHT` and `ZONE_OVERLAP_EPS` are contract constants (the §21.6 pattern). 39's v3 non-goal ("no new numeric/gameplay tuning keys") is kept. |
| C40-D2 | `model.md` §23.4 (packet 39 PROPOSED) | No change requested: `content.game.level`/`killY` are consumed as written. Recorded so Gate K does not read the M3 runtime changes as a v3 data change. |
| C40-D3 | `commands.md` §5.4 | **No row added.** Run-command failures are runtime codes (`game_command_invalid` etc.), not authoring-command failures; the authoring error model is untouched. |
| C40-D4 | `sessions.md` (packet 42) | The play surface must expose `start`/`replay` as runtime run commands (`Runtime.gameCommand`), publish `GameView` as the committed observation and route `setViewport` on resize; no second run-state owner in the session layer. |
| C40-D5 | `dependencies.md` §3/§4.1/§4.2/§6 (packet 42) | New unit `platformer-game` rows + its import edges (`runtime` types only; no three, no DOM, no physics, no workspace); the `camera`-phase module is a module, not a port. Gate K records it per PR-4. |
| C40-D6 | `export.md` / `sessions.md` (packet 42/60) | Delivery must carry `content.game` into the snapshot (`RuntimeSnapshot.game`); the export manifest `manifestVersion` 1→2 is packet 42's and is not touched here. |
| C40-D7 | `presentation.md` (packet 41) | `GameView.checkpointActive` + `checkpointId` are the read-only bit the adapter consumes for the activation appearance; packet 41 owns the appearance values (`CheckpointActivationAppearance`). |

---

## E. Explicitly not changed

- §2's snapshot provenance, immutability, deep-freeze, boundedness and strict
  shape (the `game` field is additive and v3-only).
- §3's runtime state machine and every lifecycle result code; `stop()`/`dispose()`
  semantics.
- §4's `order`/`entities`/`stepIndex`/`simTime`/`prev`/`curr` structure, the
  "every mutation writes only to this state" rule and the "private state is not
  derivable" statement.
- §5's constants, `rawN` formula, catch-up cap and drop-and-resync; §6's
  interpolation math, `alpha` rule and read-only derivation.
- §7's demo constants/math; §9's import list and DOM guards; §10's non-goals.
- §12.5's sampling/latch/quantization/binding rules; §12.7's replay tolerances.
- §14's behavior execution boundary, intent API, trust disposition and bounds —
  the M3 phases are additive and behavior modules never declare them.
- Accepted fixtures: `fixtures/m2/contracts/platformer/traces.json` (178 rows),
  `fixtures/m2/runtime/{scheduler-traces,demo-traces,failstop}.json`,
  `fixtures/m2/{input,course,physics}/**`, `fixtures/project-model/**`,
  `fixtures/commands/**` must stay byte-identical (`gameplay.md` §3.5).

---

## Packet 41 additions (presentation lifetimes) — PROPOSED

**PROPOSED by packet 41** (`planning/m3-contracts/presentation.md`). This
section is appended by packet 41 and rewrites no packet-40 row above. Packet 41
owns the presentation resources (lights/shadows, primitive materials, rigid
roles/mixers, audio) — all of which are **host/adapter resources, not runtime
resources**. The runtime contract is therefore changed only where an explicit
boundary statement prevents a second owner.

| # | Destination | Kind | Normative text |
|---|---|---|---|
| R41-1 | §9 "Dependencies and environment" | insert bullet | this file |
| R41-2 | §12.3 "Transform ownership and duplicate-writer rejection" | insert sentence | this file |
| R41-3 | §13 "M2 fail-stop lifecycle" | insert paragraph | this file |
| R41-4 | §2 "Runtime snapshot" | confirm (no text change) | the snapshot already carries every presentation value as ordinary v3 component data (`light`/`surface`/`modelAnimation`/`gameZone.activation`); packet 41 adds **no** snapshot field and **no** `ModuleConfig` field |

### R41-1 — §9: presentation resources are host-owned

Anchor: in the §9 environment-boundary list, after the bullet naming the two
DOM guards.

```diff
+- **Presentation resources are host-owned.** Lights, shadow maps, primitive
+  materials, rigid animation mixers/actions and the audio owner are created and
+  disposed by the host and the `three-adapter`/`game-host` units
+  (`presentation.md` §41.6). The runtime never constructs a `WebGLRenderer`, a
+  `THREE.AnimationMixer`, an `AudioContext`, an `HTMLAudioElement` or a voice
+  node; it never decodes or plays audio, never fetches bytes and never receives
+  a URL, token or media byte. It publishes only the committed read-only
+  `GameView` (including `checkpointActive` and the committed derived
+  `playerMotion` field of §15.5, C41-1) and its read-only interpolated
+  transforms. No presentation
+  resource is part of the snapshot, the mutable state or the diagnostics ring.
```

### R41-2 — §12.3: the adapter writes no presentation-driven transform

Anchor: after the bullet "The read-only interpolation (runtime.md §6) is the
only consumer-side math; the adapter copies interpolated values into
`Object3D`s and performs no other transform computation."

```diff
+- **Animation roles write no transform.** The rigid-role controller
+  (`presentation.md` §41.3.6) writes only mixer time and action weights; it never
+  writes an entity transform, never applies root-motion translation to the
+  entity holder, and never calls the physics port. The single transform owner
+  table of §12.3 is unchanged, and the checkpoint activation material change
+  (`checkpointActive`) touches a material instance, never a transform.
```

### R41-3 — §13: fail-stop disposal and retained presentation

Anchor: after the M2 fail-stop paragraph that states the last completed state is
retained for rendering.

```diff
+- **Presentation survival across fail-stop.** A failed runtime's last committed
+  state (including the retained `checkpointActive` bit) stays renderable; the
+  host keeps its adapter resources until it disposes them itself. A runtime
+  `dispose()`/`stop()` disposes **no** shared visual or audio resource and does
+  not close a `PreparedVisualResource` or `AudioContext` it does not own. A new
+  runtime for the same snapshot re-uses the host's resources; disposal ordering
+  is the host's (`presentation.md` §41.6 rules 4–6).
```

## Explicitly not changed by packet 41

- §2's snapshot shape (no field added; `playerMotion` is a
  **committed** `GameView` field — `gameplay.md` §6, C41-1 resolved, runtime row
  R40-17 — not a snapshot field), §3's lifecycle, §4's mutable state, §5's
  scheduling, §6's interpolation math (the role selector is a read-only consumer
  of it), §8's diagnostics ring (audio/shadow diagnostics are host diagnostics,
  not runtime errors), §12.1's phase list, §12.4's combination table, §12.6's
  physics port and §14's behavior boundary.
- Accepted M1/M2 fixtures and traces stay byte-identical.

---

## Packet 42 additions (settings closure and the menu channel) — PROPOSED

**PROPOSED — not accepted.** This section is appended by packet 42 and rewrites
no packet-40/packet-41 row above. Packet 42 owns the **closing diff for C35-5**
(the accepted `runtime.md` §3.1 deferral) and one host-separation sentence in
§12.5.

| # | Destination | Kind | Normative text |
|---|---|---|---|
| R42-1 | §3.1 `settings` field row | reword (supersede the C35-5 clause) | this file |
| R42-2 | §3.1 C35-5 note | **supersede** the deferral with the closure rule | [`../delivery.md`](../delivery.md) §3.3 |
| R42-3 | §12.5 "The input port and per-step sampling" | insert one sentence (menu channel separation) | [`../delivery.md`](../delivery.md) §4.1 |
| R42-4 | §15 (packet 40's new section) | confirm, **no text change** | the host reads the committed `GameView` only; this packet adds no runtime field |

### R42-1 — §3.1 "`instantiateRuntime(config)`": the `settings` row

Anchor: the `settings` row of the config table.

```diff
-| `settings` | a (partial) gameplay-settings record, resolved through `project-model`'s `resolveGameplaySettings`; an invalid key/value ⇒ `config_invalid` (`reason: "settings"`) | absent ⇒ the six-key defaults (`project-model.md` §21.4). **C35-5:** authored `content.settings` is not yet plumbed through the play snapshot (bounded deferral, §3.1 note below). |
+| `settings` | a (partial) gameplay-settings record, resolved through `project-model`'s `resolveGameplaySettings`; an invalid key/value ⇒ `config_invalid` (`reason: "settings"`) | absent ⇒ the six-key defaults (`project-model.md` §21.4). **C35-5 closed (packet 42):** the play and export wrappers pass the **resolved** settings object from the `manifestVersion 2` runtime-content manifest (`sessions.md` §17.1.1), captured from the envelope's `content.settings` through the same `resolveGameplaySettings`; the identical object configures the physics port (`gravity_y`), so the controller and physics never disagree (delivery.md §3.3). |
```

### R42-2 — §3.1 C35-5 note: supersede the deferral

Anchor: the whole blockquote beginning "> **C35-5 (accepted with diff, Gate I) —
where `content.settings` comes from.**"

```diff
-> **C35-5 (accepted with diff, Gate I) — where `content.settings` comes from.**
-> If `config.settings` is supplied it wins; otherwise the runtime resolves the
-> six-key defaults (`project-model.md` §21.4) and `sceneVersion` is read from
-> the snapshot's `scene.schemaVersion`. **Bounded deferral, honestly recorded:**
-> authored `content.settings` does **not** yet reach the runtime through the play
-> path — neither `tl.snapshot` nor the runtime snapshot carries a settings
-> field, so the M2 play/export composition (`preview-bootstrap.ts` and the export
-> bootstrap) uses the contract defaults today. The exact proposed diff, to
-> apply before the settings-plumbing milestone: add a resolved `settings` object
-> to the §17.1.1 runtime-content manifest (captured from the envelope's
-> `content.settings` via `resolveGameplaySettings`), have the play and export
-> bootstraps pass it as `config.settings`, and extend the §17.5 numeric
-> assertion accordingly. Until then, authored settings affect authoring
-> validation and `resolveGameplaySettings` only — no hidden or implicit wiring is
-> claimed.
+> **C35-5 — where `content.settings` comes from (closed by packet 42).**
+> If `config.settings` is supplied it wins; otherwise the runtime resolves the
+> six-key defaults (`project-model.md` §21.4) and `sceneVersion` is read from
+> the snapshot's `scene.schemaVersion`. **M3 wiring (normative):** the
+> `manifestVersion 2` runtime-content manifest carries a resolved `settings`
+> object plus its `settingsDigest` (`sessions.md` §17.1.1, delivery.md §2.3);
+> the play and export wrappers pass that object as `config.settings` **and**
+> configure the physics port from the same in-memory object (`gravity_y` is the
+> configured gravity). One capture, one resolution, two consumers — there is no
+> second read of `content.settings` and no hidden wiring. Authored non-default
+> settings therefore reach the controller and the physics configuration in both
+> hosts; the numeric acceptance comparison (defaults vs a changed `run_speed`
+> and `gravity_y`) is delivery.md §3.3 item 5. A later authoring edit produces a
+> new snapshot/build and never changes a pinned run's resolved values or bytes
+> (delivery.md §3.3 item 6).
```

### R42-3 — §12.5: the menu channel is not an action frame

Anchor: after the §12.5.1 bullet ending "catch-up can therefore never multiply a
jump edge."

```diff
+- **Menu controls are not action frames (packet 42).** Host-level menu actions
+  (`menuConfirm`, mute) are consumed by `game-host` as a separate bounded
+  semantic channel (`delivery.md` §4.1); they never enter `ActionFrame` and never
+  reach `ActionSource.sample`. A consumed menu press requires a release before it
+  can become a jump (`delivery.md` §4.2), and the exclusive test-input mode
+  suppresses the physical menu channel as well as the physical frames
+  (`delivery.md` §4.4). The per-step sampling, press-latch and jump-phase rules of
+  §12.5.1–§12.5.8 are otherwise unchanged.
```

### R42-4 — §15: confirmed, no text change

Packet 40's §15 (M3 game session) is read, not changed: the host consumes the
committed read-only `GameView` and calls `gameCommand('start'|'replay')` /
`setViewport` exactly as §15/§6.1 define. Packet 42 adds **no** runtime snapshot
field, no `StepContext` field, no `ModuleConfig` field and no new runtime error
code — the observation relay (`delivery.md` §5) is a transport projection of the
existing view plus the injected audio owner.

## Explicitly not changed by packet 42

- §2's snapshot shape (`content.game` arrives through packet 40's `game` field and
  the manifest, not a new runtime field), §3's lifecycle, §4's mutable state,
  §5's scheduling, §6's interpolation math, §8's diagnostics ring, §9's
  dependency list, §10's non-goals, §12.1–§12.4/§12.6/§12.7, §13 and §14.
- Accepted M1/M2 fixtures and traces stay byte-identical.
