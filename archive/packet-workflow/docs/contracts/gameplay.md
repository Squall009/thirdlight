# Thirdlight — Gameplay Contract

Version: 0.1 (M3 contract, promoted on the Gate K architectural review) · Packet 40 · 2026-09-19
Status: accepted by the Gate K architectural review (a session review — **not**
owner approval and **not** an independent human review) under the owner's M3
execution authorization; final manual review pending. Promoted docs-only by the
M3 Gate K promotion step (`docs/handoffs/m3-promotion.md`) from
`docs/planning/m3-contracts/gameplay.md`.
Scope: the M3 game session — the run state machine, the M3-only phases, the
gameplay zone service, the respawn reset transaction, the committed read-only
`GameView` and the gameplay camera.
Companion documents (review together): `project-model.md` §23 (v3 data),
`runtime.md` §15 (runtime-side mechanics), `commands.md` (the command surface),
`presentation.md` (the read-only presentation consumers). Delivery-side rule text
(`docs/planning/m3-contracts/delivery.md`) is referenced but not promoted.
Companion fixtures: `fixtures/m3/gameplay/**`, `fixtures/m3/camera/**`.

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense. "The runtime" means the `runtime` package. Accepted section
numbers are never renumbered: new runtime material is appended as §15 by
`runtime.md`.

---

## 1. Scope and ownership

This contract owns:

- the **run state machine** (`awaitingStart → playing → respawning → playing`,
  `playing → won`, `replay`, terminal runtime failure) and its exact step/
  boundary semantics;
- the **M3-only phase order** (two appended phases `gameplay` and `camera`, the
  reset barrier and the commit phase) and what each phase reads and writes;
- the **gameplay zone service**: a pure swept upright-capsule vs axis-aligned XY
  rectangle predicate over the last completed motion segment, its numeric
  tolerances, precedence, single activation and edge semantics;
- **respawn** as one runtime-owned reset transaction (physics, controller
  windows, run latches, `prev`/`curr` rebase, camera snap) and its partial
  failure behaviour;
- the **committed read-only game view** (`GameView`) and the bounded observation
  surface;
- the **gameplay camera**: projection convention, follow/dead-zone/smoothing
  math, authored bounds, frustum-aware clamping, snap and resize rules;
- the new **error codes, limits and defaults** of the above.

| Unit | Ownership |
|---|---|
| `runtime` | run state, event log, reset barrier and transaction, `GameView` publication, viewport record, phase order, write guard, fail-stop |
| `platformer-game` (new, packet 49) | the pure session/zone module (`gameplay` phase) and the camera module (`camera` phase); no port, no world, no DOM |
| `platformer` (accepted) | controller module; gains an M3 `reset(ctx)` lifecycle hook only (packet 50) |
| `physics-rapier` (accepted) | gains the restricted reset/clearance operations of §5.2 (packet 50); `reset()` stays tests/diagnostics-only |
| `editor` / `exporter` / `game-host` (packet 42) | compose the set, feed controls, render; own no gameplay math |

**Not owned here.** The checkpoint activation *presentation* (material/emissive
values, cues) is packet 41's; this contract owns only the read-only view bit the
adapter consumes (§6). Media, lights, animation and audio are packet 41's. The
browser-side control surface (start/replay/mute, fresh-release rules) and the
delivery manifest are packet 42's. No new `content.settings` key is proposed:
every M3 gameplay number below is a **contract constant** in the sense of
accepted `project-model.md` §21.6 (changing one changes replay semantics).

---

## 2. Run state machine

### 2.1 States

```ts
type RunState = 'awaitingStart' | 'playing' | 'respawning' | 'won';
```

`awaitingStart` is the initial run state. The runtime itself is `instantiated /
running / stopped / failed / disposed` (accepted §3/§13); the run state is
independent data owned by the runtime, present only for a **M3-enabled** runtime
(§3.1).

### 2.2 Exact transitions

| # | From | Trigger (committed at) | To | Committed effects, in order |
|---|---|---|---|---|
| T1 | `awaitingStart` | run command `start` (boundary) | `playing` | event `runStarted` (`boundary: true`) |
| T2 | `playing` | gameplay decision `death` at step `n` | `respawning` | `deathCount += 1`; `respawnAtStep = n + 1 + RESPAWN_DELAY_STEPS`; event `died` at step `n` |
| T3 | `playing` | gameplay decision `checkpoint` at step `n` | `playing` | `checkpointId = zoneId`; event `checkpointActivated` at step `n` |
| T4 | `playing` | gameplay decision `goal` at step `n` | `won` | `goalReached = true`; event `goalReached` at step `n` |
| T5 | `respawning` | reset boundary before step `respawnAtStep` | `playing` | reset transaction (§5) with `reason: 'spawn'`; `respawnAtStep = null`; event `respawned` (`boundary: true`, `stepIndex = respawnAtStep`) |
| T6 | `playing` \| `respawning` \| `won` | run command `replay` (boundary) | `playing` | `replayEpoch += 1`; `checkpointId = null`; `deathCount = 0`; `goalReached = false`; `respawnAtStep = null`; reset transaction (§5) with `reason: 'replay'` to the start spawn; event `replayed` (`boundary: true`) |
| T7 | any | runtime fail-stop (§13 accepted) | *runtime* `failed` | the *run* state is frozen at its last committed value; no run event is emitted; the failure is **not** a death |
| T8 | any | `stop()` / `dispose()` | unchanged run state | the retained `GameView` stays readable exactly as `getInterpolatedState()` is (accepted §3.3/§3.4); `dispose()` makes it `runtime_disposed` |

There is **no** transition out of `won` except `replay`; there is **no**
transition into `awaitingStart`; a run is never resumed from a previous run.
`deathCount` never resets except at T6. `checkpointId` never clears except at T6
(after a T5 respawn it is preserved — that is B07).

### 2.3 What is queued, and what becomes visible on the next step

The runtime owns two queues, consumed **only at a step boundary** (§3.2 item 0):

1. **run command queue** — `start`, `replay` (host-submitted between frames).
2. **scheduled reset** — `respawnAtStep`, set by T2 (run state), and the
   `replay` command. It is data, not a closure.

Boundary rule (normative): at most **one** pending reset and at most **one**
pending command of each kind exist; a second identical submission is coalesced
(idempotent), a further conflicting submission within the same boundary is
rejected (`game_command_invalid`, `reason: 'pending'`). Consumption order at a
boundary is: `replay` command → scheduled reset → `start` command.

Observability (normative):

- a phase's writes become visible **only** at the commit of that step (§3.2
  item 8). A run event decided in the gameplay phase of step `n` is *not*
  observable during step `n` by any phase; it is visible in the `GameView`
  published at the commit of step `n` and in the next step's `run()` snapshot.
- a boundary event (`runStarted`, `respawned`, `replayed`) is published at the
  boundary and is visible to every phase of the step that follows it.
- the interpolated render state (accepted §6) reflects a reset only after the
  boundary (no frame is rendered between the reset and the step that follows it
  in the same frame update).

### 2.4 The bounded respawn delay (no wall clock)

```ts
const RESPAWN_DELAY_STEPS = 30;   // 30 / 120 Hz = 0.25 s exactly
```

Exact arithmetic for a death decided in the gameplay phase of executed step `n`
(arithmetic recorded in `fixtures/m3/gameplay/verification.md` §3):

- step `n`: the death is decided against the committed segment of step `n`
  (`prev → curr`), the `died` event carries `stepIndex = n`;
- steps `n+1 … n+30`: exactly **30 executed steps** run in `respawning`. The
  gameplay phase evaluates **nothing** (no zone, no fall check, no second death,
  no checkpoint, no goal); the effective frame is neutral (§2.5); the physics and
  camera phases still run;
- boundary before step `n+31` (= `n + 1 + RESPAWN_DELAY_STEPS`): the reset
  transaction runs; `respawned.stepIndex = n + 31`;
- step `n+31` is the first `playing` step of the new life.

Consequences: the delay is measured in **executed fixed steps** only; a dropped
wall-time interval (accepted §5.4) neither shortens nor lengthens it; a stall
cannot produce a catch-up burst of deaths; `clip` none. No timers, no wall-clock
reads, no `setTimeout` anywhere in a step.

### 2.5 Neutral effective frames and the first-live-step jump gate

Two M3-only overrides of the **effective frame** (accepted §14.5's mechanism;
`ctx.action` stays the sampled frame in every phase):

1. **During `respawning`** (steps `n+1 … n+30`) and during `awaitingStart` /
   `won` for every executed step, the effective frame is
   `{ stepIndex, moveX: 0, jump: 'none' }` — movement is neutral, no jump edge
   can be delivered. The frame is still **sampled exactly once** per executed
   step (accepted §12.5.1) and therefore the input binding's press latch is
   cleared by that sample. A tap during the delay is consumed by the delay step
   and cannot resurface.
2. **First-live-step jump gate**: for the *first* `playing` step after a boundary
   that started or restarted a life (T1, T5, T6), the effective `jump` column is
   forced to `'none'`. A `pressed` sampled at exactly that step is ignored; the
   next step can jump normally. This is what makes "held **or tapped** jump
   through start/respawn cannot produce a phantom jump" true without depending on
   an `ActionSource` implementation (a recorded source has no latch to clear,
   accepted §12.7).

Both overrides are pure functions of `(run state, stepIndex, last boundary)`;
they are replayed identically by a recorded source.

---

## 3. The M3 phase order

### 3.1 Schedule selection

`SimulationPhase` (accepted §12.1) gains two values, appended:

```ts
type SimulationPhase =
  | 'intent' | 'controller' | 'transform'          // accepted M2 order
  | 'gameplay' | 'camera';                          // M3 additions

const SIMULATION_PHASE_ORDER = ['intent','controller','transform','gameplay','camera'];
```

Every accepted M2 phase list stays a **prefix** of the new order, so
`validatePhaseList` accepts unchanged M2 module sets. A runtime is
**M3-enabled** iff at least one selected module declares `gameplay` or `camera`;
fields and hooks below are evaluated only when it is (an M2/M1 set has no
boundary hook, no extra phase loop and no run state — the accepted step function
is byte-identical in behaviour and ordering, §3.5).

### 3.2 Exact per-executed-step order (M3-enabled runtime)

For executed step `n`, in this order and no other:

| # | Phase / step | Owner | Reads | Writes |
|---|---|---|---|---|
| 0 | **boundary** | runtime | run command queue, `respawnAtStep`, frozen snapshot, `lastCommitted`, the port | §5 reset transaction (if due); run state/event/counter updates; then the standard promotion `prev := curr` for every entity |
| 1 | **sample** | runtime | `ActionSource` | frozen `frame_n` (exactly once, accepted §12.5.1) |
| 2 | **intent** | phase modules (accepted §12.1) | frame, `state` (read-only), settings, last result | validated intents, private module state |
| 3 | **controller** | `thirdlight.platformer:controller` | frame, `intents`, settings, read-only `curr` | private controller state; one staged character move per entity |
| 4 | **physics** | runtime | staged moves | the port world; validated `CharacterMoveResult` |
| 5 | **transform** | runtime, then phase modules | staged results | `curr.position.x/y` of the controller entity (runtime), then declared owners in registration order |
| 6 | **gameplay** | `gameplay`-phase modules | `ctx.gameplay` (§3.3): frozen `GameContent`, `run()`, `lastMotionSegment(entityId)`, the sampled frame, `intents`, read-only `curr`/`prev` | run state, counters and bounded events through the validated `ctx.gameplay` calls; private module state (the session module is **stateless** and holds none) |
| 7 | **camera** | `camera`-phase module | `curr` of the controller entity (read-only), `GameContent.camera`, the viewport record, `settings` | `curr.position.x/y` of the **camera entity only** (its declared owner) |
| 8 | **commit** | runtime | all of the above | `lastCommitted := curr`; validate the pending run changes; freeze and publish the `GameView`; `stepIndex := n+1`; `simTime = stepIndex / fixedStepHz` (single division); the boundary queues are untouched until the next boundary |

Rules:

- Each phase runs **at most once per executed step**; phases never interleave
  across steps; `stepIndex`/`simTime` advance only in phase 8 after every phase
  completed (§12.1.1, unchanged).
- Phase 0 promotes `prev := curr` **before** the reset's own writes are applied
  where a reset is due, in this order: (a) run the reset transaction, which
  writes the character's reset pose and, through the module hook, the camera's
  reset pose into `curr`; (b) `prev := curr` for every entity. A reset therefore
  produces `prev == curr` for the reset entities **by construction**, which is
  the whole mechanism behind "no teleport sweep" (§4.6) and "no render streak".
- A failure in any phase is the accepted fail-stop (§13): the step is abandoned,
  `stepIndex` does not advance and the last committed view is retained. A
  failure **after** a partial reset leaves the private world half-mutated by
  design: the contract claims no rollback (§5.4).

### 3.3 `StepContext` additions (M3-only, additive)

```ts
interface MotionSegment { readonly from: Vec2; readonly to: Vec2; }

interface RunSnapshot {                       // committed run data, read-only
  readonly state: RunState;
  readonly stepIndex: number;                 // the runtime step counter (see GameView)
  readonly checkpointId: string | null;
  readonly goalReached: boolean;
  readonly deathCount: number;
  readonly replayEpoch: number;
  readonly respawnAtStep: number | null;
  readonly runId: string;                     // `${snapshotId}#${replayEpoch}`
}

interface GameSessionPort {                   // `StepContext.gameplay`
  readonly content: Readonly<GameContent>;    // deep-frozen at instantiate
  run(): Readonly<RunSnapshot>;
  /** The last completed motion segment of `entityId`, or `undefined`. */
  lastMotionSegment(entityId: string): Readonly<MotionSegment> | undefined;
  viewport(): Readonly<ViewportInfo>;         // { width, height, aspect }
  // The three commit calls below are callable in the gameplay phase only;
  // from any other phase they throw module_error (reason: 'phase_violation').
  beginRespawn(cause: 'hazard' | 'fall', zoneId?: string): void;
  activateCheckpoint(zoneEntityId: string): void;
  reachGoal(zoneEntityId: string): void;
}
```

`StepContext` gains `readonly gameplay?: GameSessionPort` (frozen; present iff
M3-enabled). `SimulationPhaseModule` gains an optional lifecycle hook, callable
by the runtime only at the reset barrier:

```ts
interface ModuleResetContext {
  readonly reason: 'start' | 'spawn' | 'replay';
  readonly stepIndex: number;                 // the upcoming step index
  readonly playerCenter: Readonly<Vec2>;      // the reset character centre
  readonly viewport: Readonly<ViewportInfo>;
  readonly state: SimState;                   // `curr` writable for the module's declared owners only
}
interface SimulationPhaseModule {
  // ... accepted fields ...
  reset?(ctx: ModuleResetContext): void;
}
```

**`lastMotionSegment`, not `state.prev` (normative precision).** During step `n`
the accepted commit order leaves `state.prev` holding the end of step `n−2`
(the promotion `prev := curr` happens at the end of the step, `runtime` §4/§5).
A module therefore **must not** derive the gameplay segment from `state.prev`:
it must call `lastMotionSegment(entityId)`, which the runtime answers from its
own `lastCommitted[entityId]` and the live `curr[entityId]`. `lastCommitted` is
rewritten at every commit and by the reset transaction (§5.1 step R7). Fixture
`segment-source` asserts the runtime-provided segment differs from
`(state.prev, state.curr)` on the step after a commit.

### 3.4 Exactly one transform owner (M3 owner table)

| Entity | Phase | Owner | Axes |
|---|---|---|---|
| controller entity | `transform` (runtime commit + declared `transform` modules) | `thirdlight.platformer:controller` | `position.x/y` |
| behavior-owned entities | `transform` | accepted behavior modules (§14.6) | `position.x/y/z` |
| **camera entity** | **`camera`** | the single `camera`-phase module | `position.x/y` |
| every other entity | never | — | — |

Write guard (M3 extension of accepted §12.2): `curr` is writable only for a
**declared owner** of the writing module, and only in
`transform` (accepted rule, unchanged) or `camera` (camera-phase modules, and
then only for declared owners that are the camera entity). Writing any other
entity, or writing in `intent`/`controller`/`physics`/`gameplay`, throws
`module_error` (`reason: 'phase_violation'`) → fail-stop. `position.z`,
`rotation` and `scale` of the camera entity are never written by any module
(`position.z` stays the authored depth, §7.1).

Instantiate-time validation (M3-enabled sets; failures create nothing):

| Condition | Code / reason |
|---|---|
| no module declares `camera` | `config_invalid` (`reason: 'camera_owner'`, `detail: 'missing'`) |
| two or more modules declare `camera` | `config_invalid` (`reason: 'camera_owner'`, `detail: 'multiple'`) |
| the camera module's `transformOwners` is not exactly `[cameraId]` | `config_invalid` (`reason: 'camera_owner'`, `detail: 'owner_mismatch'`) |
| two or more modules declare `gameplay` | `config_invalid` (`reason: 'gameplay_module'`) |
| an M3 module is selected with a `schemaVersion !== 3` snapshot | `config_invalid` (`reason: 'scene_version'`, accepted code) |
| the M3 snapshot carries `game === null` | `config_invalid` (`reason: 'game_config'`) |
| the camera entity carries no `cameraFollow` | `config_invalid` (`reason: 'camera_follow'`) |

Accepted §12.4's row "a module claims the camera entity →
`transform_owner_forbidden`" is **superseded for M3-enabled sets only** and
replaced by the rows above; for M1/M2 sets the accepted row is unchanged.

### 3.5 M1/M2 invariance

For a runtime that is not M3-enabled: there is no boundary hook, no `gameplay`
or `camera` module, no run state, no viewport record and no run surface
(`getGameView`/`gameCommand`/`setViewport` return `game_session_unavailable`,
`reason: 'schedule'`). The accepted per-step math, `prev := curr` timing,
`ActionFrame` semantics, `IntentSet` rules, settle pre-roll, catch-up arithmetic
and fail-stop effects are byte-for-byte the accepted text.

Fixtures that must stay **byte-identical** (asserted by the existing M1/M2
checkers and `npm test`):

- `fixtures/m2/contracts/platformer/traces.json` (the 178 pinned rows);
- `fixtures/m2/runtime/{scheduler-traces,demo-traces,failstop}.json`;
- `fixtures/m2/input/*`, `fixtures/m2/course/*`, `fixtures/m2/physics/*`;
- `fixtures/project-model/**` and `fixtures/commands/**` (M1).

---

## 4. Gameplay zones

### 4.1 Data and geometry (39's data, consumed not redefined)

A zone is a `components.gameZone` entity (`project-model.md`
§23.3.1): `role` ∈
`hazard`/`checkpoint`/`goal`, `size` = **full** extents `[widthX, heightY]`,
root, unit scale, identity rotation, centred on the entity's world position.
Half-extents are `size / 2`. Zone meshes/surfaces are authoring overlays and are
never queried.

The runtime freezes a projection at instantiate:

```ts
interface GameZoneSpec {
  readonly entityId: string;
  readonly role: GameZoneRole;
  readonly center: Vec2;      // frozen snapshot transform x/y
  readonly half: Vec2;        // size / 2
  readonly safeSpawnId?: string;
  readonly activation?: Readonly<CheckpointActivationAppearance>;
}
interface GameContent {
  readonly game: Readonly<GameConfig>;         // project-model.md §23.4
  readonly zones: readonly GameZoneSpec[];     // ascending `entityId` codepoint order
  readonly spawns: readonly { entityId: string; center: Vec2 }[];
  readonly player: { entityId: string };
  readonly camera: { entityId: string; deadZone: Vec2; smoothing: number; bounds: Bounds };
}
interface ViewportInfo { readonly width: number; readonly height: number; readonly aspect: number }
```

Zone iteration order is ascending `entityId` codepoint order — that is the
"stable ID order" of the tie rules below; document order is explicitly not used.

### 4.2 The swept upright-capsule vs AABB predicate (normative, closed form)

Contract constants (`project-model.md` §21.6 style; the M2 capsule):

```ts
const CAPSULE_RADIUS = 0.3;        // m
const CAPSULE_HALF_HEIGHT = 0.6;   // m (centre-line half length)
const ZONE_OVERLAP_EPS = 1e-9;     // m
```

Inputs: the **last completed motion segment** `from = (x0,y0)`, `to = (x1,y1)`
(capsule *centres*, runtime-provided) and a zone `(cx,cy,hx,hy)`.

```
rx0 = min(x0,x1);  rx1 = max(x0,x1)
ry0 = min(y0,y1) - CAPSULE_HALF_HEIGHT
ry1 = max(y0,y1) + CAPSULE_HALF_HEIGHT
zx0 = cx - hx;  zx1 = cx + hx;  zy0 = cy - hy;  zy1 = cy + hy
dx  = max(0, rx0 - zx1, zx0 - rx1)
dy  = max(0, ry0 - zy1, zy0 - ry1)
d   = sqrt(dx*dx + dy*dy)
overlap  ⟺ d < CAPSULE_RADIUS - ZONE_OVERLAP_EPS
tangent  ⟺ |d - CAPSULE_RADIUS| ≤ ZONE_OVERLAP_EPS          (⇒ not overlap)
separate ⟺ d > CAPSULE_RADIUS + ZONE_OVERLAP_EPS
```

Derivation (why this is the swept capsule and not an approximation): sweeping an
upright capsule whose centre travels along the segment produces the set of all
points within `CAPSULE_RADIUS` of
`S = { (x(t), y(t) + v) : t ∈ [0,1], v ∈ [−HH, HH] }`. Because `y(t)` is
continuous, `S` is exactly the rectangle
`[rx0, rx1] × [ry0, ry1]`; the swept capsule is therefore the Minkowski sum of
that rectangle with a disc of radius `r`, and
`(S ⊕ D_r) ∩ Z ≠ ∅ ⟺ dist(S, Z) ≤ r`. `dist` between two axis-aligned
rectangles is `hypot(dx, dy)` with the `dx`/`dy` above — a closed form with no
iteration, no broadphase and no tolerance accumulation. `d²` may be compared
against `r²` (avoiding `sqrt`): the implementation computes `d` for the fixture
report and compares `dx*dx + dy*dy < (r − EPS)²` in the hot path.

Tolerances (exact numbers, fixture-verified):

- `ZONE_OVERLAP_EPS = 1e-9` m. Below the 1e-4 input quantum by 5 orders and
  below the 0.0333 m motion of one step at 4 m/s and 120 Hz by 7 orders; float64
  error near `d = 0.3` is ≤ 7e-16, so the tangency bucket is decided robustly.
  A `d` inside the bucket is reported as `tangent: true` and is **not** an
  overlap: touching a zone edge never triggers anything.
- The capsule radius used is the geometric `CAPSULE_RADIUS`; the solver's
  `offsetSkin = 0.01` is deliberately **not** added (a gameplay zone must not
  depend on a solver offset).
- The fall threshold is a separate authored bound and uses no epsilon:
  `fall ⟺ currY < content.game.killY` (strict).

### 4.3 Per-step decision and same-step precedence

Evaluated in the **gameplay phase** of step `n`, over the committed segment, in
this exhaustive order (first match wins):

1. **death by hazard** — any `hazard` zone with `overlap` ⇒ `beginRespawn`
   (`cause: 'hazard'`, `zoneId` = lowest `entityId` among overlapping hazards);
2. **death by fall** — `to.y < killY` ⇒ `beginRespawn` (`cause: 'fall'`, no
   `zoneId`);
3. **checkpoint** — `checkpointId === null` and the single checkpoint zone
   `overlap` ⇒ `activateCheckpoint(zone.entityId)`;
4. **goal** — the goal zone with the lowest `entityId` that overlaps ⇒
   `reachGoal(zone.entityId)`;
5. otherwise nothing.

Consequences (normative): **death beats checkpoint and goal in the same step**;
**checkpoint beats goal in the same step** (the goal then fires on the next step
if it still overlaps, because a degenerate segment at rest still overlaps);
ties *within* a role are broken by ascending `entityId`. Exactly one decision is
committed per step: after `beginRespawn` or `reachGoal` the remaining rules are
not evaluated.

While `respawning`, `awaitingStart` or `won`, **no** zone is evaluated.

### 4.4 Edge, crossing and spawn semantics

- **enter** — `overlap` on the segment and the previous committed pose not
  overlapping. **exit** — the previous pose overlapped and the current segment
  does not. Enter/exit are **derived predicates of the committed segment**; the
  runtime stores **no** per-zone edge latch. The only durable trigger state is
  `checkpointId` (§4.5).
- **touching edge** — `tangent` ⇒ no overlap and no event (fixture
  `zone-touch-edge`).
- **fast crossing** — the predicate is swept over the whole segment, so a hazard
  crossed in one step is caught at any speed reachable by the controller; an
  endpoint-only test would miss it (fixture `zone-fast-crossing` records both
  outcomes). This is a *predicate*, not a substitute for collision: the character
  never collides with a zone.
- **spawn inside a checkpoint** — `checkpointId` is already set ⇒ no event
  (single activation, §4.5). Spawn inside a **hazard** zone or outside
  `content.game.level` is refused by the reset transaction (`game_spawn_blocked`
  / `game_spawn_invalid`, §5.4) — never an endless death loop, never a fallback
  coordinate.
- **goal from respawn** — the goal is evaluated normally on the first post-reset
  step; a spawn inside the goal zone wins immediately at that step. Legal,
  deterministic, and flagged for authoring review by packet 43/61 (a level
  authoring both is almost certainly a mistake).
- **teleport** — the contract has exactly one discontinuity: the reset. Because
  the reset rebases `prev := curr` (§3.2 rule, §5.1 R7), the gameplay phase can
  never see a segment spanning the discontinuity, so no intervening zone is
  touched and there is no separate teleport flag, no suppression list and no
  "ignore the first step after respawn" hack. Fixture `zone-teleport` asserts the
  real segment and, as a labelled counterfactual only, that an unrebased
  `(30 → 3)` segment *would* have crossed a hazard (proving the rebase is
  load-bearing).

### 4.5 Single activation per run

- A checkpoint activates at most once per run: after `activateCheckpoint` the
  rule 3 guard (`checkpointId === null`) makes every later overlap a no-op, so
  backtracking and re-entering cannot fire it again (fixture
  `zone-single-activation`). 39 guarantees ≤ 1 checkpoint zone per scene.
- The goal fires at most once: T4 sets `won`, which freezes all evaluation.
- Replay (T6) clears `checkpointId` and `deathCount`, so a fresh run re-arms the
  checkpoint. Nothing else re-arms it — not death, not respawn, not reload of
  the page (a reload creates a new runtime and a fresh epoch 0 run).
- The run stores no "already counted" hazard set: a hazard overlap is a decision,
  not a latch, and it cannot fire during `respawning`.

### 4.6 Why this is not a second movement solver

The service **must not**: produce, alter, clamp or veto motion; write any
transform; step the port; read or query the physics world; hold a dynamic body,
a broadphase, a ray query or a sensor; run an iteration loop; or be used as a
collision response. It is a **pure predicate** over the committed segment plus
≤ 64 frozen axis-aligned rectangles with one closed-form distance, invoked once
per executed step in the gameplay phase. Movement remains owned by the accepted
`platformer` controller plus the injected Rapier port; the transform phase
commits the port's result before the gameplay phase ever reads it. The rejected
alternative (a Rapier sensor per zone) is rejected because it would add a second
mutation path into the same world and put gameplay timing inside the solver.

---

## 5. Respawn: one runtime-owned discontinuity

### 5.1 The reset transaction (exact order)

Executed by the runtime at a step boundary (§3.2 item 0) for T1 (reason
`start`), T5 (`spawn`) and T6 (`replay`). Steps R1–R3 are pure reads; the first
mutation is R4.

| # | Step | Owner | Detail |
|---|---|---|---|
| R1 | resolve destination | runtime | `reason: 'spawn'` ⇒ the activated checkpoint's `safeSpawnId` when `checkpointId !== null`, else `content.game.spawnId`; `reason: 'replay'`/`'start'` ⇒ `content.game.spawnId`. Resolve to `target = spawns[entityId].center` from the frozen projection. Unresolvable ⇒ `game_spawn_invalid` (`reason: 'reference'`). |
| R2 | verify destination | runtime | `target` inside `content.game.level` and `target.y ≥ killY` and the capsule at `target` does not overlap a hazard zone. Violation ⇒ `game_spawn_invalid` (`reason: 'outside_level'`) or `game_spawn_blocked` (`reason: 'hazard'`). **No mutation yet.** |
| R3 | clearance probe | port | `characterClearance(target)` → `blocked` / `no_support` / `query_failed` ⇒ `game_spawn_blocked` (fail-stop). No mutation yet. |
| R4 | physics reset | port | `clearCharacterMotion()` then `placeCharacter(target)`; both are the restricted operations of §5.2. A throw ⇒ `physics_port_error` (fail-stop). |
| R5 | stage the character | runtime | stage `curr[playerId] = target` (XY; Z/rotation/scale untouched). |
| R6 | module state reset | runtime → modules | for each selected module in registration order that declares `reset`, call `reset(ctx)` with `ModuleResetContext` (`reason`, upcoming `stepIndex`, `playerCenter = target`, `viewport`, phase-scoped `state` whose `curr` is writable **only** for that module's declared owners). The controller clears its windows; the camera writes the snapped camera XY. A throw ⇒ `module_error` (fail-stop). |
| R7 | apply + rebase | runtime | apply the staged character pose to `curr`; `lastCommitted[playerId] := target`; for every entity the camera hook wrote: `lastCommitted[id] := curr[id]`; then the standard `prev := curr` promotion (§3.2) makes `prev == curr` for both reset entities. |
| R8 | run bookkeeping + publish | runtime | the T1/T5/T6 run-state and counter updates and the boundary event; freeze and publish the new `GameView`. |

### 5.2 Restricted reset/clearance operations (owners)

The accepted `PhysicsPort.reset(character)` stays **tests/diagnostics-only**
(accepted §12.6) and is **never** called by the runtime, a module, the session,
the camera, a behavior, the HUD or the editor. M3 adds three operations to the
concrete port, callable only by the runtime at the reset barrier:

```ts
interface CharacterClearanceResult {
  ok: boolean;
  reason?: 'blocked' | 'no_support' | 'out_of_bounds' | 'hazard' | 'query_failed';
  supportNormal?: Vec2;
  penetration?: number;      // m, deepest overlap with a static collider
}
interface PhysicsResetPort extends PhysicsPort {
  /** Zero every cached/kinematic motion (velocity, pending correction) of the character. */
  clearCharacterMotion(): void;
  /** Re-place the capsule centre and return the resulting clearance. */
  placeCharacter(center: Vec2): CharacterClearanceResult;
  /** Query only: clearance of the capsule if placed at `center`. No mutation. */
  characterClearance(center: Vec2): CharacterClearanceResult;
}
```

`clearCharacterMotion`/`placeCharacter`/`characterClearance` are **not** exposed
on `PhysicsStepClient` and not on `GameSessionPort`: game code never receives a
physics handle (accepted §12.6's one-mutation-path rule). The port implementation
owns the WASM-world details (`setTranslation`, zeroed kinematic velocity,
`penetration`); the runtime owns the ordering and the decision to fail-stop.

### 5.3 The coherence table (one reset covers every piece of state)

| State | Owner | Reset action | Where |
|---|---|---|---|
| Rapier capsule pose | port (private WASM) | `placeCharacter(target)` | R4 |
| Rapier cached/kinematic motion | port (private) | `clearCharacterMotion()` | R4 |
| controller velocity (`vx`,`vy`) | `platformer` (private) | zeroed | R6 |
| controller grounding (`grounded`, `groundedPrev`, support normal) | `platformer` | cleared; the next physics phase re-derives it | R6 |
| coyote counter (6) | `platformer` | `0` | R6 |
| jump buffer counter (8) | `platformer` | `0` | R6 |
| jump-release flag (variable height) | `platformer` | `false` | R6 |
| effective move/jump of the reset step | runtime | neutral for the delay steps; jump gated at the first live step | §2.5 |
| `IntentSet` | runtime | already cleared at every step start (accepted §14.5); no reset needed | §3.2 |
| per-zone edge latches | — | do not exist (§4.4) | — |
| `checkpointId` | runtime | **preserved** (T5), cleared (T6) | R8 |
| `deathCount`, `goalReached`, `replayEpoch` | runtime | T5: preserved; T6: reset | R8 |
| `respawnAtStep` | runtime | `null` | R8 |
| `prev`/`curr` of the player and camera | runtime | rebased `prev := curr` after the reset writes | R7 |
| `lastCommitted` (segment source) | runtime | rewritten to the reset poses | R7 |
| camera private state (if any) | camera module | `reset(ctx)` writes the snapped pose; smoothing has no accumulator by construction (§7.2) | R6/R7 |
| render interpolation | runtime | `prev == curr` ⇒ no streak, `alpha` irrelevant | R7 |
| input press latch | `input` binding | not touched; the delay/first-live-step rules of §2.5 make it irrelevant | — |

No row is missing by design: the reset transaction has no "restart the module"
escape hatch, no module re-`create`, and no authoring write. Everything a step
can leave behind is either in this table or is a pure function of the committed
state (the session module is stateless).

### 5.4 Partial failure, blocked spawn, and no rollback

- A failure in **R1/R2** mutates nothing: the run fails cleanly (fail-stop) with
  the last committed view retained and the run state frozen.
- A failure in **R3** mutates nothing (the probe is a query) — same outcome,
  `reason` `blocked`/`no_support`/`query_failed`.
- A failure in **R4/R6 after `clearCharacterMotion()` or `placeCharacter()`
  succeeded** leaves the private world half-mutated. The contract claims **no
  rollback**: there is no attempt to reconstruct the WASM world from `prev`/
  `curr`, and the runtime does not continue. It records one bounded
  `physics_port_error` (`reason: 'reset'`) or `module_error` entry, enters the
  accepted `failed` state, stops the frame driver, and keeps serving
  `getInterpolatedState()`/`getCamera()`/`getGameView()` from the last committed
  value with `alpha = 0`. Recovery is the accepted one: `dispose()` and
  instantiate fresh from the same immutable snapshot.
- The **failure is not a death**: `deathCount` is not incremented, no `died`
  event is emitted, and `GameView.failed` becomes `true` with
  `failure: { code, reason?, stepIndex }`. A failed runtime never resumes (§13).
- A **blocked/invalid spawn is a structured failure, never a loop**: the runtime
  does not retry, does not pick a neighbouring coordinate, does not fall back to
  the start spawn and does not respawn forever. Packet 49/50's acceptance
  evidence includes a real Rapier blocked-destination case.

### 5.5 Held or tapped jump through start/respawn

Guaranteed by construction, with three independent mechanisms, each separately
tested: the neutral effective frames during `awaitingStart`/`respawning` (§2.5
item 1) consume any edge at its own step; the first-live-step gate (§2.5 item 2)
ignores a `pressed` sampled exactly at the first `playing` step; and the
controller's buffer/coyote/velocity state is zeroed at R6, so no pre-death press
survives. `fixtures/m3/gameplay/run/held-jump.json` pins one positive control
(a press **after** the first live step does jump: `pressed-after-first-live`) and
three negatives (`pressed-at-first-live`, `held-during-awaitingStart`,
`pressed-during-respawning`).

---

## 6. The committed read-only game view

```ts
type GameEventKind =
  | 'runStarted' | 'died' | 'respawned' | 'checkpointActivated' | 'goalReached' | 'replayed';

interface GameEvent {
  readonly id: string;        // `${runId}/${kind}/${stepIndex}`
  readonly kind: GameEventKind;
  readonly stepIndex: number;
  readonly boundary: boolean; // true for runStarted/respawned/replayed
  readonly zoneId?: string;
  readonly cause?: 'hazard' | 'fall';
  readonly deathCount: number; // the counter after this event
}

interface PlayerMotion {
  readonly speed: number;      // |Δ| over the last completed motion segment × fixedStepHz, m/s, finite ≥ 0
  readonly grounded: boolean;  // the controller's committed grounding after that step
}

interface GameView {
  readonly viewVersion: 1;
  readonly runId: string;       // `${snapshotId}#${replayEpoch}`
  readonly snapshotId: string;  // `<projectId>@r<revision>` (accepted §2)
  readonly replayEpoch: number;
  readonly state: RunState;
  readonly stepIndex: number;   // the runtime step counter at publication: completed
                                // steps after a commit, the upcoming index at a boundary
  readonly simTime: number;
  readonly playerId: string;
  readonly cameraId: string;
  readonly activeSpawnId: string;    // spawnId or the activated checkpoint's safeSpawnId
  readonly checkpointId: string | null;
  readonly checkpointActive: boolean; // the read-only presentation bit the adapter consumes (PR-1)
  readonly playerMotion: PlayerMotion; // the committed motion the role selector consumes (C41-1)
  readonly goalReached: boolean;
  readonly deathCount: number;
  readonly respawnAtStep: number | null;
  readonly events: readonly GameEvent[];  // oldest first, ≤ MAX_GAME_EVENTS
  readonly eventCount: number;            // cumulative
  readonly eventDropped: number;          // evicted from the front
  readonly failed: boolean;
  readonly failure?: { readonly code: string; readonly reason?: string; readonly stepIndex: number };
}
```

Rules (normative):

- **Publication.** Exactly one frozen `GameView` exists per runtime instance: the
  last committed one. It is replaced at every commit (phase 8) and at every reset
  boundary (R8), and read by `Runtime.getGameView()`. The runtime never reads a
  published view back: the view is derived from the run state and never feeds it
  back (no write-back; the snapshot stays frozen and byte-identical).
- **Freshness.** `getGameView()` returns a **new deep-frozen object per call**
  (the events array is copied), exactly like `getInterpolatedState()`; mutating a
  returned object cannot affect the runtime and a held copy cannot be re-published.
- **Player motion is derived, never stored twice.** `playerMotion` is the
  committed projection of the controller's last completed result, computed at the
  same commit as the rest of the view (phase 8) and at every reset boundary (R8):
  `speed = |lastMotionSegment(playerId)| × fixedStepHz` over the last **completed**
  step (the `lastCommitted → curr` segment of §3.3 item 0) and `grounded` is the
  controller's committed grounding after that step. It adds **no new runtime
  state, no counter, no second writer and no second simulation**: both facts
  already exist in the run state, are read once when the view is built, and are
  never written back (the view never feeds the run). With no completed step —
  `awaitingStart` and `won` — it is exactly `{ speed: 0, grounded: true }`.
  `speed` is finite and ≥ 0. This is packet 41's C41-1 input: the role selector
  (`presentation.md` §41.3.6) is the only committed consumer and it reads the
  view, never the runtime-private motion segment.
- **Identity and staleness.** `(runId, replayEpoch, stepIndex)` identify a view.
  A consumer holding an older view detects staleness by `view.stepIndex <
  current.stepIndex` or `view.runId !== current.runId`. `runId` is unique within
  one runtime instance's lifetime (epoch strictly increases across replays) but
  **not** across instances: a fresh runtime for the same snapshot starts again at
  epoch 0, so a host must never mix views from two runtime instances (the
  adapter/adapter-owned objects are disposed with the instance). Stale events are
  never re-published: each event is appended once, at the commit that decided it.
- **The run identity is not the build identity.** `snapshotId` carries the
  project ID and the authoring revision the run was built from; a Play session
  follows a later authoring revision only by starting a new runtime/snapshot
  (accepted §2's snapshot rule, unchanged). Gameplay never writes the revision.
- **Bound.** `MAX_GAME_EVENTS = 32` retained; the cumulative `eventCount` and the
  `eventDropped` counter are unbounded-in-practice integers. The whole view is a
  fixed-size record plus ≤ 32 small events: a death/goal flood cannot grow it
  (the same boundedness argument as the accepted 32-entry diagnostics ring).
- **In `failed`.** The last committed view is retained with `failed: true`; no
  further event is appended (the run is frozen, not continuing). `deathCount`
  and `checkpointActive` keep their last committed values.
- **Presentation ownership.** The view exposes only the *bit*
  `checkpointActive` (+ `checkpointId`) and `goalReached`; the activated
  checkpoint's material/emissive/cue values stay packet 41's
  (`CheckpointActivationAppearance`). The HUD text is packet 42/55's.
- **The view is not a HUD API.** Objective/title/instructions are content
  (`content.game`, 39 §23.4), read from the frozen content, not from the view;
  audio cues consume the events (packet 54 dedupes by event `id`).

### 6.1 Runtime surface additions (M3-enabled runtime only)

```ts
interface Runtime {
  // ... accepted calls unchanged ...
  getGameView(): { ok: true; view: GameView } | { ok: false; error: RuntimeError };
  gameCommand(cmd: 'start' | 'replay'): { ok: true } | { ok: false; error: RuntimeError };
  setViewport(width: number, height: number): { ok: true } | { ok: false; error: RuntimeError };
}
```

- `gameCommand` is callable between frame updates (never during a step; a
  re-entrant call from inside a phase is `module_error`, `reason:
  'phase_violation'`). It queues per §2.3 and returns `ok: true` for an accepted
  *submission*, not for a completed transition; a command invalid for the current
  run state is rejected immediately with `game_command_invalid`
  (`reason: 'state'`).
- `setViewport` writes the runtime's viewport record only (presentation). It is
  rejected with `camera_viewport_invalid` for a non-finite, non-positive or
  oversized dimension; the previous record is retained.
- The three calls return `game_session_unavailable` (`reason: 'schedule'`) on a
  runtime that is not M3-enabled, and `runtime_disposed` after `dispose()`.

---

## 7. The gameplay camera

### 7.1 Projection and view convention (fixed)

- One perspective camera: the scene's single `camera` entity (accepted), carrying
  `cameraFollow` (39 §23.3.3). `camera.fovY`, `near`, `far` are the scene's
  validated values (sample: `fovY 45`, `near 0.1`, `far 100`; `getCamera()`
  unchanged).
- The camera looks along **−Z** with **+Y up**: its rotation stays the identity
  quaternion and its scale `[1,1,1]`; only `position.x/y` are ever written, and
  the authored `position.z` (`CAMERA_Z` convention) is never written by any
  module. No depth lanes, orbit, roll, shake, look-ahead, zoom or FOV animation.
- Contract constants:

```ts
const CAMERA_Z = 12;              // m — fixed view depth (the sample's candidate, fixed here)
const CAMERA_MAX_STEP = 4;        // m — per-axis per-step displacement cap (safety bound)
const DEFAULT_ASPECT = 16 / 9;    // used until setViewport is called
const CAMERA_SNAP_EPS = 1e-9;     // m — below this a write is skipped (no jitter)
```

### 7.2 Follow, dead zone and bounded fixed-step smoothing (exact math)

Inputs at the camera phase of step `n`: `P` = the committed `curr` XY of the
controller entity (the capsule centre, including any ground-snap correction);
`C` = the camera entity's `curr` XY at that moment (= `prev` after the boundary
promotion, i.e. the last committed camera pose); `dz = (dz.x, dz.y)` half-extents
and `k = smoothing` from `cameraFollow`; the viewport record.

```
overflow(v, h) = v > h ? v - h : (v < -h ? v + h : 0)
T.x = C.x + overflow(P.x - C.x, dz.x)
T.y = C.y + overflow(P.y - C.y, dz.y)
S.x = C.x + (k === 0 ? (T.x - C.x) : k * (T.x - C.x))
S.y = C.y + (k === 0 ? (T.y - C.y) : k * (T.y - C.y))
// per-axis cap, then authored bounds, then the frustum clamp:
S' = C + clampPerAxis(S - C, -CAMERA_MAX_STEP, +CAMERA_MAX_STEP)
A  = clamp(S', bounds.min, bounds.max)                      // component-wise
C' = clampFrustum(A, halfW, halfH, content.game.level)
```

- The smoothing coefficient is applied **once per executed step** and is a pure
  function of the current values: there is no accumulator, no dt, no exponential
  time constant. `k = 0` is an exact hard target (`S = T`); `k = 1` is an
  instantaneous target too; `0 < k < 1` is geometric decay
  `|C_m − T| = |C_0 − T| · (1 − k)^m` (closed form used by the fixtures).
- The per-axis cap prevents a pathological single-step view jump; it is
  unreachable in ordinary play (`4 m` per 8.3 ms vs 0.033 m of player motion per
  step at `run_speed = 4`), so it never affects framing. It applies only while
  smoothing is active (`0 < k < 1`): `k = 0` (39's documented "hard snap") and
  the reset snap (§7.4) are exact targets and bypass the cap, because the only
  legitimate large moves are snaps.
- If `|C' − C| ≤ CAMERA_SNAP_EPS` on **both** axes the module writes nothing and
  the camera keeps its pose exactly; this is the no-oscillation rule (a camera
  already inside the dead zone is bit-stable).
- The camera module writes `curr.position.x/y` of the camera entity. Order of
  operations is normative: dead zone → smoothing → cap → authored bounds →
  frustum clamp. Applying bounds last would let the authored bound push the
  frustum outside the level, which the frustum clamp must be able to correct.

### 7.3 Frustum-aware clamping (exact, at two desktop aspects)

```
halfH = CAMERA_Z * tan(fovY * PI / 180 / 2)
halfW = halfH * aspect                     // vertical FOV is fixed; aspect widens X
aspect = width / height                    // setViewport; DEFAULT_ASPECT until then

clampFrustum(v, min, max, half) =
  (max - min >= 2 * half) ? clamp(v, min + half, max - half)
                          : (min + max) / 2      // level smaller than the frustum: centre it
```

applied per axis against `content.game.level`. Rationale: the visible window
`[C'−half, C'+half]` is kept inside the level whenever the level is at least as
large as the frustum, so a level bound can never expose a void; when the level is
smaller than the frustum on an axis the camera **centres** on the level — a
constant, so there is no oscillation and no void-or-flicker fallback, and the
area outside the level shows the background, never a second rule.

Worked numbers used by the fixtures (fovY 45°, `CAMERA_Z = 12`, level
`X [0,48] Y [-4,8]`; arithmetic in `fixtures/m3/camera/verification.md`):

| Viewport | aspect | `halfW` | `halfH` | clamped X | clamped Y |
|---|---|---|---|---|---|
| 1280×720 (16:9) | 1.7777777777777777 | 8.836555997292695 | 4.970562748477141 | `[8.836555997292695, 39.16344400270731]` | `[0.9705627484771409, 3.029437251522859]` |
| 1024×768 (4:3) | 1.3333333333333333 | 6.6274169979695206 | 4.970562748477141 | `[6.6274169979695206, 41.37258300203048]` | `[0.9705627484771409, 3.029437251522859]` |

`halfH = 12·tan(22.5°) = 12(√2 − 1) = 4.970562748477141` (closed form and the
float64 value agree to the last bit).

### 7.4 Hard snap (start / respawn / replay)

At the reset barrier (§5.1 R6) the camera module runs the §7.2 pipeline with the
smoothing coefficient forced to `1` (`S = T`), i.e. it adopts the dead-zone
target for the reset player centre, then the cap is skipped, then the authored
bounds and frustum clamp apply; the runtime also makes `prev == curr` (§5.1 R7).
Consequences (normative): the snap is instantaneous, the camera never streaks
across the map, and the player may sit at the dead-zone *edge* after a snap
because the dead-zone box semantics are unchanged by the snap (fixture
`camera-snap-edge`). `reason: 'start'` snaps to the start spawn; `'replay'` snaps
to the start spawn; `'spawn'` snaps to the active (checkpoint) spawn.

### 7.5 Resize: presentation-only

`setViewport(width, height)` updates the runtime's viewport record; the camera
module reads it in the camera phase and, on the next executed step, re-clamps.
Resize **never** writes physics or any authoritative gameplay state: no port
call, no `prev`/`curr` write outside the camera entity, no run event, no counter.
Fixture `camera-resize-physics-identity` asserts that the committed player trace
is byte-identical with and without an intervening resize. The adapter's viewport
is a rendering concern and is not part of the contract.

Non-finite handling (normative):
`setViewport` rejects `NaN`, `±Infinity`, `width ≤ 0`, `height ≤ 0`,
`width > 16384` or `height > 16384` with `camera_viewport_invalid` and leaves the
previous record untouched, so the camera keeps its last committed pose and the
simulation continues. If a non-finite value nevertheless reaches the camera
module (defensive), it must not write a transform: it treats the step as
`CAMERA_SNAP_EPS`-no-op and records one bounded `camera_viewport_invalid`
diagnostic entry (never a fail-stop — a presentation input cannot fail-stop
gameplay). Fixture `camera-nonfinite`.

### 7.6 Single camera owner; editor navigation is independent

- Exactly one module writes the runtime camera pose (the `camera`-phase module,
  §3.4). No behavior, session, controller, HUD, editor or exporter module may
  claim the camera entity (accepted §12.4 row, kept outside M3).
- The editor's viewport navigation camera is a **different object** owned by the
  editor/three-adapter: it reads no runtime state and writes no runtime state,
  and the runtime camera entity's `curr` transform is not used as an editor
  navigation transform. Editor navigation therefore stays independent; a
  combined "game camera == editor camera" mode is not part of M3. Fixture
  `camera-owner` pins the instantiate-time failures of §3.4.
- No rotation/shake: the camera quaternion is never written by M3; there is no
  shake amplitude, no trauma accumulator and no per-frame noise source.

---

## 8. Limits, errors and defaults

### 8.1 New error codes (§5.4-style table)

| Code | cls | Carries | Raised when | Destination |
|---|---|---|---|---|
| `game_command_invalid` | `validation` | `command`, `state`, `reason` (`state`/`pending`/`unknown`) | a run command is rejected for the current run state or conflicts with a pending command | `runtime.md` §8 (runtime `ERROR_CODES`) |
| `game_spawn_invalid` | `validation` | `spawnEntityId`, `reason` (`reference`/`outside_level`), `stepIndex` | the reset destination does not resolve in the frozen projection, lies outside `content.game.level`, or is at/below `killY` (fail-stop) | `runtime.md` §8/§13 |
| `game_spawn_blocked` | `unavailable` | `spawnEntityId`, `reason` (`blocked`/`no_support`/`hazard`/`query_failed`), `penetration?`, `stepIndex` | the clearance/overlap probe rejects the destination (fail-stop; no retry, no fallback) | `runtime.md` §8/§13 |
| `camera_viewport_invalid` | `validation` | `width`, `height` | `setViewport` receives a non-finite, non-positive or oversized dimension; also the defensive camera-module path (§7.5) | `runtime.md` §8 |
| `game_session_unavailable` | `validation` | `reason: 'schedule'` | `getGameView`/`gameCommand`/`setViewport` on a runtime that is not M3-enabled | `runtime.md` §8 |

**New reason strings on accepted codes** (additive to the accepted reason sets,
no accepted meaning changes): `module_error` + `gameplay_invalid` (a session
commit call violates a run-state rule, e.g. `beginRespawn` while `respawning`);
`module_error` + `input_source_threw`/`phase_violation` (accepted);
`physics_port_error` + `reset` (a reset-barrier port failure).
**No accepted code changes meaning or carries-shape.** Run-command failures are
**not** authoring-command failures: `commands.md` §5.4 gains no row, and the game
control surface (packet 42/59) reports the runtime codes above unchanged. This
is recorded as a cross-file request in `runtime.md` §15.

### 8.2 Finite limits and defaults

| Bound | Value | Behaviour on exceed |
|---|---|---|
| `RESPAWN_DELAY_STEPS` | 30 (0.25 s at 120 Hz) | constant, not authorable |
| `ZONE_OVERLAP_EPS` | 1e-9 m | tangency bucket ⇒ not an overlap |
| `CAPSULE_RADIUS` / `CAPSULE_HALF_HEIGHT` | 0.3 / 0.6 m | accepted M2 constants (not settings) |
| `MAX_GAME_EVENTS` | 32 retained | `eventDropped` counts evictions; no fail-stop |
| pending run commands | 1 per kind (coalesced) | extra conflicting submission ⇒ `game_command_invalid` (`pending`) |
| `CAMERA_Z` | 12 m | constant |
| `CAMERA_MAX_STEP` | 4 m per axis per step | displacement clamped to the bound |
| `CAMERA_SNAP_EPS` | 1e-9 m | below it the camera does not write |
| `DEFAULT_ASPECT` | 16/9 | until the first accepted `setViewport` |
| viewport dimension | `1 ≤ v ≤ 16384`, finite | `camera_viewport_invalid` |
| spawn clearance `penetration` | `≤ 1e-6` m | ⇒ `game_spawn_blocked` (`blocked`) |
| spawn support probe depth | 0.5 m below the target | no support normal found ⇒ `game_spawn_blocked` (`no_support`) |
| zones per scene | 64 (39 §23.10) | model `limits_exceeded` (`zones`) |
| `deathCount` | integer, no overflow check | `120 Hz × 10 years ≈ 3.8e10 ≪ 2^53`; no code is invented for an unreachable bound |

---

## 9. Fixtures and independent derivation

Numeric, state and camera fixtures live in
`fixtures/m3/gameplay/**` (`index.json`) and `fixtures/m3/camera/**`
(`index.json`), replayed by the self-contained plain-Node checker
`fixtures/m3/gameplay/tools/check-fixtures.mjs` (no dependency). The checker is a
**contract-consistency replay**, not an implementation: it re-derives the state
machine, the sweep predicate, the delay arithmetic, the observation bound and the
camera math from the rules in this document and compares them with the committed
expectations. The closed-form derivations (not the checker) are the independent
arithmetic and are recorded in `fixtures/m3/gameplay/verification.md` §3 and
`fixtures/m3/camera/verification.md` §2, e.g.:

- `RESPAWN_DELAY_STEPS`: death at step 100 ⇒ neutral steps `101…130` (30 steps)
  ⇒ reset boundary before `131 = 100 + 1 + 30`;
- `halfH = 12·tan(π/8) = 12(√2 − 1) = 4.970562748477141`;
- trigger threshold for a standing capsule at `y = 0.91` against a zone with
  `y ∈ [0, 0.25]`: `dy = 0.31 − 0.25 = 0.06` ⇒
  `dx_max = sqrt(0.3² − 0.06²) = sqrt(0.0864) = 0.29393876913398137`;
- smoothing at `k = 0.25` from `C = 0` toward `T = 8`:
  `C_m = 8(1 − (3/4)^m)`, `C_10 = 7.549491882324219`.

Fixture groups (ids are the fixture object ids):

| Group | Fixture | Proves |
|---|---|---|
| state | `run-states-*` | every transition of §2.2, the queued-visibility rule, `replay`, failure-is-not-death, stop/dispose |
| state | `run-respawn-timing` | the exact 30-step delay timeline and event step indices |
| state | `run/held-jump.json` (`held-during-awaitingStart`, `pressed-at-first-live`, `pressed-during-respawning`, `pressed-after-first-live`) | §5.5: three negatives + one positive control |
| state | `run/events-bound.json` (`events-bound-40-deaths`) | `MAX_GAME_EVENTS`, `eventCount`, `eventDropped` |
| state | `run/segment-source.json` | `lastMotionSegment` ≠ `(state.prev, state.curr)` on the step after a commit |
| state | `run/failure-phases.json` | a last-committed-state assertion for **every** failure phase (intent/controller/physics/transform/gameplay/camera/commit/R1–R8) |
| state | `run/game-view.json` | view identity, staleness, fresh-copy and frozen rules |
| zone | `zones/sweep.json` (`sweep-*`) | enter/exit/tangent/fast-crossing/drop-through/jump-over, `dx`/`dy`/`d`/classification |
| zone | `zones/precedence.json` (`prec-*`) | death > checkpoint > goal, stable-ID ties, exactly one decision |
| zone | `zones/run-semantics.json` (`zone-single-activation-reentry`) | one activation per run; exit and re-entry are no-ops |
| zone | `zones/spawn.json`, `zones/run-semantics.json` (`zone-teleport-no-sweep`, `zone-goal-from-respawn`) | reset-destination refusal, goal-from-respawn, teleport non-sweep + labelled counterfactual |
| zone | `run/states.json` (`run-fall-threshold-*`) | strict `y < killY`, `y == killY` alive |
| errors | `errors/codes.json` | the §8.1 registry and the accepted-code reasons |
| camera | `camera-follow-*` | dead zone, `k = 0`, `k = 0.25` (closed-form sequence), `k = 0.2`, cap, no-op band |
| camera | `camera-bounds-*` | authored bounds, 16:9 and 4:3 frustum clamps, level-smaller-than-frustum centring, order of operations |
| camera | `camera-snap-*` | start/spawn/replay snap, snap-edge framing, no interpolation (prev == curr) |
| camera | `camera-resize-*` | aspect change, physics identity across resize, non-finite rejection |
| camera | `camera-owner` | missing/multiple/owner-mismatch instantiate failures |

---

## 10. Evidence required at review

1. **State transitions** — `run-states-*` replays every transition including the
   queue semantics, with event objects re-derived (id, kind, stepIndex, boundary,
   counters).
2. **Last committed state per failure phase** — `run/failure-phases.json` declares, for
   each of the accepted fail-stop triggers *and* each reset step R1–R8, the exact
   retained `(state, stepIndex, simTime, checkpointId, deathCount, eventCount,
   lastCommitted player pose, camera pose)` and asserts no advance and no event.
3. **Coherence** — §5.3's table is the claim. `run/respawn-timing.json` and
   `run/states.json` assert the delay/reset timeline, the preserved
   `checkpointId`, the counters and the boundary events;
   `run/segment-source.json` asserts the `prev`/`lastCommitted` rebase that the
   reset relies on; `zones/run-semantics.json` asserts the teleport non-sweep and
   the goal-from-respawn consequence. The private controller windows and the real
   Rapier clearance calls are packet 50's evidence, not a fixture here.
4. **No gameplay reset, no second writer, no rollback fiction** — stated
   normatively in §5.2/§5.4 and asserted by: `error-codes` (the accepted
   diagnostic `reset` never appears in any gameplay path), `camera-owner` and the
   §3.4 owner table (one writer per entity), and `run-failure-phases` (a failed
   reset retains the last committed view and never resumes). Packet 50's
   implementation evidence adds a real Rapier blocked-destination case and an
   injected failure at each reset phase (packet 50's scope, not this packet's).

This document and its fixtures are the accepted contract text for packets 49–51:
they are contract-consistency evidence, not implementation results, and every
implementation claim belongs to those packets.

---

## 11. Public exports (implemented by 49–51)

| Unit | Additions |
|---|---|
| `runtime` | `RunState`, `GameEvent`, `GameEventKind`, `GameView`, `RunSnapshot`, `MotionSegment`, `GameSessionPort`, `GameContent`, `GameZoneSpec`, `ViewportInfo`, `ModuleResetContext`, `PhysicsResetPort`, `CharacterClearanceResult`, `SIMULATION_PHASE_ORDER` (extended), `RESPAWN_DELAY_STEPS`, `MAX_GAME_EVENTS`, `CAMERA_Z`, `CAMERA_MAX_STEP`, `DEFAULT_ASPECT`, `Runtime.getGameView`/`gameCommand`/`setViewport`, `RuntimeSnapshot.game` (v3 only), `ModuleConfig.game` |
| `platformer-game` (new) | `platformerGameSessionSpec`, `platformerGameCameraSpec`, `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`, `CAMERA_CONSTANTS`, `RUN_LIMITS`, `clampFrustum` (the pure math is exported so fixtures and 49–51 share one implementation). The two module specs carry the `platformerGame` prefix so they cannot be confused with `@thirdlight/platformer`'s accepted `platformerSpec` in the shared composition (Gate K **K-3**, coordinator-adjudicated; `fixtures/m3/delivery/deps/dependency-rows.json` is the authority) |
| `platformer` | the `reset(ctx)` hook implementation; `CONTROLLER_CONSTANTS` unchanged |
| `physics-rapier` | `PhysicsResetPort` implementation: `clearCharacterMotion`, `placeCharacter`, `characterClearance` |

---

## 12. Compatibility, change rules and non-goals

- **Additive only.** No accepted field, code, reason, order or default changes
  meaning. `RuntimeSnapshot.game`, `ModuleConfig.game`, `StepContext.gameplay`
  and `SimulationPhaseModule.reset` are optional and absent for v1/v2 sets.
- **M1/M2 untouched.** §3.5's byte-identical fixture list is the acceptance
  condition; a difference there is a bug in packet 49, not a contract option.
- **Non-goals.** No second camera, no camera rotation/shake/zoom/look-ahead, no
  second transform or frame-driver owner, no Rapier sensors for zones, no
  teleport/`setTransform` runtime API, no wall-clock gameplay timer, no lives/
  score/save economy, no generic event bus, no scripted zones, no gameplay
  write-back to authoring state, no new `content.settings` key, no per-checkpoint
  activation appearance (packet 41), no HUD layout (packet 42/55), no
  performance promise.
- **Change rule.** Any change to a number in §8.2, to the precedence order of
  §4.3, to the phase order of §3.2 or to the reset transaction of §5.1 invalidates
  the corresponding fixtures and reopens this contract (the fixtures are the
  reviewable form of these numbers).
