PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — Fixed-step controller, phases and fail-stop lifecycle (M2)

**PROPOSED — pending Gate E.** Packet 17 output (`docs/planning/m2-packets.md` §17).
Companion documents of the same packet:

- [`input.md`](input.md) — `ActionFrame`, sampling, device binding.
- [`physics.md`](physics.md) — the injected `PhysicsPort`, shapes, tolerances.
- [`diffs/runtime.md`](diffs/runtime.md) — the exact section-level changes to
  `docs/contracts/runtime.md` (lifecycle state `failed`, phases, transform
  ownership, diagnostics, dependency edges).
- [`diffs/project-model.md`](diffs/project-model.md) §"Packet 17 additions" —
  new §21 (controller/collider components + gameplay settings registry).

Nothing in `docs/contracts/` or `docs/decisions/` changes until the Gate E
promotion step (docs-only).

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

**Physics selection: `@dimforge/rapier2d-compat` at exactly 0.20.0, kinematic
character controller — selection per decision 0002 §1, owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending.**
Selection PROVISIONAL until packet 14's desktop evidence and Gate E accept it;
the pin enters the lockfile only at packet 31.

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The **fixed-step ordering** and the **module phase registration** model:
  `intent → controller → physics → transform → render`, with the write guard.
- The **authoritative transform policy**: one owner per entity, the ownership
  declaration, duplicate-writer rejection and the camera/character protections.
- The **platformer controller algorithm** (exact normative order), the jump
  windows in integer steps, and the stateful semantics that survive catch-up.
- The **fail-stop lifecycle** for M2 module sets: the `failed` state, retained
  render state, diagnostics, disposal and fresh-restart-only recovery.
- The **gameplay settings registry** (`M2_SETTINGS_KEYS`) that fills packet 16's
  empty registry, and the **static camera convention**.
- The **step-indexed replay** rules shared with the acceptance traces.

| Unit | Proposed ownership |
|---|---|
| `runtime` | phases, ownership validation, write guard, `failed` state, diagnostics, recorded source |
| `platformer` (new) | the controller module `thirdlight.platformer:controller` |
| `physics-rapier` (new) | the port implementation (physics.md) |
| `input` (new) | the device binding producing `ActionFrame` (input.md) |
| `editor` / `exporter` | host bootstraps that compose the modules and inject the port; no gameplay math |

## 2. Module registration and phases

The accepted registry mechanism (`dependencies.md` §6) is extended, not
replaced: registration stays compile-time code, IDs keep the
`^thirdlight\.[a-z0-9]+:[a-z0-9-]+$` syntax, and there is still no
string-to-code resolution or content-loaded module.

```ts
type SimulationPhase = 'intent' | 'controller' | 'transform';   // canonical order

interface SimulationModuleSpec {
  id: string;
  phases: readonly SimulationPhase[];   // non-empty, no duplicates, canonical order
  excludes?: readonly string[];          // module IDs this spec cannot coexist with
  create(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationModule;
}

interface SimulationModule {
  readonly transformOwners: readonly string[];   // declared once, at create
  step(phase: SimulationPhase, ctx: StepContext): void;
  dispose?(): void;
}
```

**M2 module inventory (registered by the host bootstrap at build time):**

| Module ID | Phases | Transform owners | Notes |
|---|---|---|---|
| `thirdlight.demo:box-motion` | `["transform"]` | every entity carrying `box` | unchanged M1 math (runtime.md §7.1) |
| `thirdlight.platformer:controller` | `["controller", "transform"]` | the single `components.controller` entity | excludes `thirdlight.demo:box-motion` |
| behavior modules (packet 18) | `["intent"]` | none | packet 18 owns their spec |

The `physics-rapier` adapter is **not** a module: it is the injected
`PhysicsPort` owned by the runtime (physics.md §5). This is what keeps one
mutation path for collision state.

### 2.1 Fixed-step ordering (normative, replacing nothing in M1's per-step math)

For every executed fixed step `n`:

1. **sample** — `frame_n = actions.sample(n)` (exactly once; `input.md` §3);
2. **`intent` phase** — modules in registration order; they may read the frame,
   state, settings and last physics result, and produce validated intents
   (packet 18). They must not write transforms (write guard, §2.2);
3. **`controller` phase** — modules in registration order; the controller
   computes the movement intent and calls
   `ctx.physics.stageCharacterMove(entityId, delta)`; each entity may have at
   most one staged move per step (a second stage for the same entity is a
   `module_error`, `reason: "duplicate_move"`);
4. **`physics` phase (runtime, not a module)** — the runtime calls
   `port.step()` exactly once and validates the result (physics.md §5);
5. **`transform` phase** — the runtime first commits each staged move result to
   the owning entity's `curr` transform (`position.x`/`position.y` only), then
   runs modules in registration order; only phase-`transform` modules may write
   `curr`, and only for entities they declared;
6. **render (read-only)** — `onFrame()` then the adapter reads
   `getInterpolatedState()` (runtime.md §6, unchanged).

Phases 2–5 each run at most once per executed step. The phases of one step are
never interleaved across steps, and `stepIndex`/`simTime` advance only after
phase 5 completed successfully.

### 2.2 Write guard and phase violations (normative)

- The runtime passes a **write-only** `state.curr` during the `transform` phase
  and a **throwing read-only view** of `curr` during `intent`, `controller` and
  `physics`. A module that writes `curr` outside the `transform` phase throws a
  `module_error` (`reason: "phase_violation"`) → fail-stop (§9).
- `ctx.physics.stageCharacterMove` is callable only in the `controller` phase;
  any other phase throws `module_error` (`reason: "phase_violation"`).
- `state.prev`, `state.order`, `state.entities` component data and the snapshot
  are read-only in every phase.

### 2.3 Unsupported module combinations

At instantiate the runtime validates the selected module set in registration
order and fails with `config_invalid` (no instance created, no port used):

| Condition | Code | Reason |
|---|---|---|
| two selected modules claim the same entity ID | `transform_owner_conflict` | `entityId` |
| a module claims an entity that does not exist | `transform_owner_conflict` | `entityId` |
| a module claims the camera entity | `transform_owner_forbidden` | `camera` |
| a module claims a `collider`/`controller` entity without being the controller module | `transform_owner_forbidden` | `physics_entity` |
| an ID listed in a selected module's `excludes` is also selected | `module_combination_unsupported` | both IDs |
| `thirdlight.platformer:controller` selected without an injected port | `config_invalid` | `physics_port` |
| `thirdlight.platformer:controller` selected with a scene whose `controller` count ≠ 1 | `config_invalid` | `controller_target` |
| an M2 module selected with a `schemaVersion` 1 snapshot | `config_invalid` | `scene_version` |

`thirdlight.demo:box-motion` + `thirdlight.platformer:controller` is therefore
**rejected**, which is the recorded form of "the M1 box-motion demo cannot also
control the character": M2 has no defined semantics for a scripted transform
driver and a physics-driven controller in one simulation.

## 3. `StepContext` (strict shape)

```ts
interface GameplaySettings {                    // resolved at instantiate (§8)
  gravity_y: number; run_speed: number; jump_velocity: number; max_fall_speed: number;
  max_slope_climb_deg: number; min_slope_slide_deg: number;
}

interface StepContext {
  readonly stepIndex: number;
  readonly phase: SimulationPhase;
  readonly action: ActionFrame;                 // identical for every phase of this step
  readonly settings: Readonly<GameplaySettings>; // deep-frozen
  readonly physics: PhysicsStepClient;          // physics.md §5
}
```

The context object is frozen; attempting to write a context field is a
`module_error` (`reason: "phase_violation"`).

## 4. Controller module

Module ID `thirdlight.platformer:controller`; package `platformer`; phases
`["controller", "transform"]`; owner: the single `components.controller`
entity (the *character*). The module holds no reference to the port, the DOM,
the clock, the workspace or any storage: it reads `ctx` and writes only the
character's `position.x`/`position.y` in the `transform` phase.

Per-step state (private to the module instance, created at `create`):
`vx`, `vy`, `airborne`, `coyote`, `buffer`, `jumpStarted`, `prevResult`,
`charX`, `charY`. The state starts at the authored transform with
`vy = 0`, `vx = 0`, `airborne = false`, `coyote = COYOTE_STEPS`, `buffer = 0`
(§6 pre-roll).

## 5. Authoritative transform policy

- **One owner per character transform.** The character's `curr` transform is
  written only by `thirdlight.platformer:controller` in the `transform` phase,
  and only `position.x`/`position.y`; `position.z`, `rotation` and `scale` are
  never written (physics.md §2).
- The `intent` phase commits a **validated intent**; the `controller` phase
  commits a **movement request**; the `transform` phase commits the **result**
  the port returned for that step. The result is authoritative because it is
  what collided, and the runtime writes it before any phase-`transform` module
  runs — the character cannot be moved twice in one step.
- The read-only interpolation (runtime.md §6) is the only consumer-side math;
  the adapter copies interpolated values into `Object3D`s and performs no other
  transform computation.
- No play → authoring write-back (runtime.md §4, unchanged): the snapshot stays
  deep-frozen and canonical.

## 6. Step indexing, settle pre-roll and initialization

- `stepIndex` starts at `0`; `simTime = stepIndex / fixedStepHz` (single
  division, unchanged).
- Steps `0..11` are the **settle pre-roll** (`SETTLE_PREROLL_STEPS = 12`,
  physics.md §9): neutral frames, normal phases, no input sampling, no
  wall-clock time. The first sampled frame is at `stepIndex = 12`.
- The pre-roll runs on the **first frame after `start()`**, before the wall
  anchor is installed (`wallAtFrame = t`, `simTimeAtAnchor = 0.1 s`), so no
  wall time is consumed and no phantom steps are produced
  (`diffs/runtime.md` §3.2/§5).
- `stop()`/`start()` retain the controller's private state (M1 semantics: a
  restart continues); only `dispose()` (or a fresh instance after fail-stop,
  §9) resets it.
- `reset()` on the port re-places the capsule (tests/diagnostics only) and is
  never called by the controller.

## 7. The step algorithm (normative, exact order)

Per executed step `n`, with `frame = frame_n`, `s = ctx.settings`,
`dt = 1 / fixedStepHz`, `p = prevResult` (the result of step `n−1`; `undefined`
only at pre-roll step 0, treated as `{ grounded: false }`):

```text
groundedPrev = (p !== undefined) && p.grounded === true

A. if (frame.jump === 'pressed') buffer = JUMP_BUFFER_STEPS
B. if (groundedPrev) coyote = COYOTE_STEPS
C. if (buffer > 0 && (groundedPrev || coyote > 0) && !airborne) {
     vy = s.jump_velocity; airborne = true; buffer = 0; coyote = 0; jumpStarted = true
   } else jumpStarted = false
D. if (groundedPrev && !airborne) vy = 0
   else vy = max(vy + s.gravity_y * dt, s.max_fall_speed)
E. if (p !== undefined && p.contacts.head === true && vy > 0) vy = 0
F. if (frame.jump === 'released' && airborne) { if (vy > 0) vy = vy * JUMP_RELEASE_FACTOR; airborne = false }
G. if (airborne && groundedPrev && vy <= 0) airborne = false
H. target = frame.moveX * s.run_speed
   if (frame.moveX === 0 && groundedPrev && !airborne) {
     slide = slideDirection(p, cos(min_slope_slide), tan(min_slope_slide))   // §7.4
     if (slide !== 0) target = slide * s.run_speed
   }
   vx = approach(vx, target, MOVE_ACCEL * dt, MOVE_DECEL * dt)   // per step, no smoothing, clamp at target
I. ctx.physics.stageCharacterMove(charId, { x: vx * dt, y: vy * dt })
J. if (!groundedPrev) coyote = max(0, coyote - 1)
K. if (!jumpStarted) buffer = max(0, buffer - 1)
```

The order is deliberately the order the packet-14 probe verified (jump edge and
coyote bookkeeping **before** the gravity integration of the same step, then
landing/head handling, then the move), so the contract model reproduces the
measured jump trajectory instead of merely approximating it: the contract-order
model's discrete apex gain from the settled rest center (`0.910 m`) is
`1.2196625 m`, and the probe's reported `1.2297 m` is that same trajectory
measured from the *nominal* `0.900 m` center over a settled start of
`0.9099987 m` — the two agree to `3e-7 m` (fixture
`jump-hold-full-height`; `physics.md` §7).

`approach(v, target, up, down)`:

```text
if (|target − v| ≤ 1e-9) → target                       // exact arrival, no FP residue
if (v < target)         → min(target, v + up)
if (v > target)         → max(target, v − down)
```

(never overshoots and arrives exactly — the `1e-9` snap is normative because the
fixture tables assert exact `run_speed` values; `|vx| ≤ run_speed` always).
All arithmetic is IEEE-754 double arithmetic in this exact order; no
wall-clock, random or locale-dependent value enters the step (runtime.md §4
determinism rule).

### 7.1 Windows (integer steps) and edges

| Rule | Value | Exact observable |
|---|---|---|
| coyote window | `COYOTE_STEPS = 6` | a jump may start at any of the **7 executed steps** after the last step `m` whose result was grounded (`m+1 .. m+7`); `COYOTE_STEPS = 6` is the counter's step budget, and the refresh step `m+1` is itself permitted because the jump check precedes the decrement, so `m+8` cannot jump (C32-3) |
| jump buffer window | `JUMP_BUFFER_STEPS = 8` | a `pressed` at step `k` permits a jump at steps `k .. k+7`; a new press refreshes it |
| variable height | `JUMP_RELEASE_FACTOR = 0.5` | `released` while airborne and `vy > 0` halves `vy` once; a further `released`/`none` does nothing |
| single jump | — | a jump start requires `groundedPrev || coyote > 0` **and** `!airborne`; `coyote` is zeroed at the start, so a second press while airborne cannot jump (no air jump, no wall jump, no double jump) |
| buffered jump | — | a jump start consumes the buffer (`buffer = 0`), so one press starts at most one jump |
| head contact | — | the controller does not add upward movement while `contacts.head` is reported and clamps `vy` to ≤ 0 (step E); no ceiling hover |
| stair climbing | — | autostep is disabled (physics.md §6) and the controller never raises the character outside the port result; a `≤ 0.4 m` step is blocked while walking (fixtures `traces.json` `ledge-block-and-jump-on`) |
| wall contact | — | the controller keeps its horizontal intent; the port clamps the applied delta; there is no wall slide, wall stick or wall jump |

### 7.2 Exact integer-step derivations used by the fixtures

- `0 → run_speed` with `moveX = 1`: `12` steps (`4.0 / (40 / 120) = 12`).
- `run_speed → 0` with `moveX = 0`: `8` steps (`4.0 / (60 / 120) = 8`).
- jump edge: `vy = 7.0` on the jump step, then `vy += −19.62/120` **in the same
  step** (the probe's order), so the discrete trajectory reproduces the measured
  packet-14 numbers; the discrete apex gain, apex/landing step indices and window
  step indices are computed by the contract model and committed in
  `fixtures/m2/contracts/platformer/traces.json`. The packet-14 probe measured a
  discrete apex gain of `1.2297 m` against the continuous-theory `1.249 m`, and
  the contract-order model matches the measured value exactly; the contract
  tolerance remains `±0.05 m` around the theoretical value.

### 7.4 Slide policy (normative; C32-1)

With `moveX === 0`, the character grounded (`groundedPrev` and not `airborne`),
the controller may override the horizontal target with a downhill slide at
`run_speed`. `slideDirection(result, cosMinSlopeSlide, tanMinSlopeSlide)` returns
`-1 | 0 | 1` (left/right/none) from the previous step's completed port result:

```text
if result is undefined or !result.grounded: return 0
steepNormal = result.supportNormal.y < cosMinSlopeSlide + 1e-6
drop        = result.requested.y - result.applied.y
descending  = result.snapped === true
              && drop > 1e-6
              && |result.applied.x| > 1e-9
              && drop >= |result.applied.x| * tanMinSlopeSlide - 1e-6
if !steepNormal && !descending: return 0
direction = sign(result.supportNormal.x) || sign(result.applied.x) || 0
```

The **ratio guard** (`drop >= |applied.x| · tan(min_slide)`) is required: without
it, flat-ground snap noise drives a resting character, which was measured and
fixed before the packet-32 fixture was frozen. The steep-normal branch is the
direct `min_slope_slide_deg` threshold check; the descending branch carries
steady-state sliding when the adapter reports the support normal as `(0, 1)` on
resting/snapped steps (the real `0.20.0` behaviour, C31-2). The downhill
direction comes from the support normal when the adapter reports it, else from
the direction of the applied correction. Sliding is a controller policy, **not**
an adapter behaviour: packet 31 measured no autonomous adapter sliding at `30°`
(C31-4).

## 8. Fixed static camera convention

- The play camera is the scene's single perspective camera
  (project-model §10.3): identity rotation `[0, 0, 0, 1]`, therefore looking
  along **−Z** with **+Y up**; the default position `[0, 0.5, 4]` looks at the
  XY plane with +X right and +Y up (project-model §2).
- `getCamera()` returns `{ id, fovY, near, far }` exactly as in M1; `aspect`
  remains a viewport property.
- **M2 has no follow camera, no camera shake, no position/rotation write by any
  module, and no camera component on the character.** The camera entity is in no
  module's `transformOwners` (a claim is `transform_owner_forbidden`,
  §2.3); it is never moved by the settle pre-roll, gameplay or interpolation.
  A follow camera is M3.

## 9. Fail-stop lifecycle (M2 module sets)

Runtime states become
`instantiated → running ⇄ stopped → disposed`, plus
`running | stopped → failed → disposed` (`failed` is terminal except for
`dispose`).

**Trigger.** Any of: a module `step` throws (any phase); the injected port
throws in `step()` or returns a malformed result (physics.md §5); a write-guard
or phase violation (§2.2); a duplicate staged move (§2.1 item 3); an input
source throws in `sample()`.

**Effect (normative, deterministic):**

1. the current step is **abandoned**: `prev`/`curr` keep the values committed at
   the end of the last fully completed step, and `stepIndex`/`simTime` do not
   advance;
2. the frame driver is cancelled (no further frame, no further `onFrame`);
3. state becomes `failed`; diagnostics record one bounded error entry
   `{ code: 'module_error' | 'physics_port_error', moduleId?, phase?, stepIndex,
   reason, message }` and increment `errorCount`; `failedStepIndex`,
   `failedModuleId`, `failedPhase` become sticky diagnostic fields;
4. `getInterpolatedState()` and `getCamera()` keep working and return the last
   completed step's authoritative state with `alpha = 0` — **the last completed
   render state is retained**;
5. `start()` and `tick()` return `{ ok: false, error: { code: 'runtime_failed' } }`;
   `stop()` from `failed` returns `{ ok: true }` (there is no driver);
6. `dispose()` from `failed` returns `{ ok: true }` and calls `dispose()`
   **exactly once** on every module instance (including the failed one) and on
   the port.

**No rollback (normative).** The runtime never attempts a transform-only
rollback of a half-mutated world: physics/private module state (WASM world,
controller velocity/window state, script state) cannot be reconstructed from
`prev`/`curr`. `failed` exists precisely so the runtime does not continue with
a half-mutated world. **Safe restart is the only recovery:** `dispose()` the
failed instance, create fresh module instances and a fresh port, and
`instantiateRuntime` again from the same immutable snapshot.

**Scope of the rule.** M1 compatibility is preserved: a module set consisting
only of the M1 demo keeps the accepted runtime.md §5.1 no-op-on-throw behavior,
because that module has no private state. Fail-stop applies to every module set
that contains at least one M2 (stateful) module; the fixtures pin both.

## 10. Gameplay settings registry (fills packet 16's empty registry)

`content.settings` (packet 16's container, values `number | boolean | string`)
is bounded to exactly these keys in M2. The registry is the packet-17 diff that
supersedes packet 16's "empty until packet 17" placeholder
(`diffs/project-model.md` §"Packet 17 additions", P17-A6).

| Key | Type | Default | Range | Unit |
|---|---|---|---|---|
| `gravity_y` | number | `-19.62` | `[-100, -1]` | m/s² |
| `run_speed` | number | `4` | `(0, 50]` | m/s |
| `jump_velocity` | number | `7` | `[0, 50]` | m/s |
| `max_fall_speed` | number | `-30` | `[-100, 0)` | m/s |
| `max_slope_climb_deg` | number | `45` | `[0, 89.9]` | degrees |
| `min_slope_slide_deg` | number | `30` | `[0, 89.9]` | degrees |

Rules:

- Resolution at `instantiateRuntime`: `settings = defaults ⊕ content.settings`
  (a present key wins); the resolved object is deep-frozen and becomes
  `StepContext.settings`. An unlisted key is `setting_unknown` (packet 16);
  a value outside its range or of the wrong type is `field_value` with the key's
  path (same code as packet 16's container rule);
  `min_slope_slide_deg > max_slope_climb_deg` is `field_value`
  (`path: /settings/min_slope_slide_deg`).
- The registry is a **fixed M2 table**: adding a key is a reviewed contract
  change (packet 16 §14) and no key exists for anything outside physics/movement
  tuning. Capsule dimensions, skin, snap, autostep, jump windows, acceleration
  and deceleration are **contract constants, not settings** — changing them
  changes replay semantics and the frozen-course evidence.
- The registry is exported as `M2_SETTINGS_KEYS` (packet 16's placeholder
  becomes the six keys above) and resolved by
  `resolveGameplaySettings(content) → ModelResult<GameplaySettings>`.

## 11. Replay and acceptance fixtures

`fixtures/m2/contracts/` (packet-17 additions, all replayed by the checker):

| Fixture | Pins |
|---|---|
| `input/action-sequences.json` | frame shape/phase chains, press latch exactly-once, dead zone/rescale, arbitration precedence, suppression/`awaitingRelease`, disconnect takeover |
| `physics/numerics.json` | every constant/tolerance of physics.md §7 with its source label, slope-threshold classification table, validation cases for `collider`/`controller` |
| `platformer/traces.json` | step-indexed action frames + expected per-step traces: flat accel/decel, full jump, release cut, buffer (in-window/expired), coyote (last step/one-late), no air jump, wall stop, head bump, ledge block + jump-on, 12 m/s high speed, no Z drift, seam crossing (2 cm gap), ground snap within (0.06 m) and beyond (0.15 m) the snap distance |
| `platformer/failures.json` | focus loss, disconnect, hidden tab, invalid parenting/scale, duplicate writer, unsupported module combination, module throw after physics mutation, init cancellation, repeated jump edges during catch-up, dropped wall time |
| `runtime/catchup.json` | frame grouping, ≤ 8-step catch-up, drop-and-resync, one sample per executed step, pre-roll, phase order and ownership cases |

The checker holds an **independent reference implementation** of §7 plus the
scripted analytic port (flat ground and axis-aligned statics) and re-derives
every committed expectation. Replay tolerances are `input.md` §6; a
cross-engine `1e-3 m` bound is the only non-exact comparison M2 claims.

## 12. Public exports (proposed)

`@thirdlight/runtime` (added to the existing surface):

```ts
export type { SimulationPhase, StepContext, GameplaySettings, TransformOwnerReport } from './types';
export { createRecordedActionSource } from './actions';        // input.md §6
export { SETTLE_PREROLL_STEPS, JUMP_BUFFER_STEPS, COYOTE_STEPS, JUMP_RELEASE_FACTOR,
         MOVE_ACCEL, MOVE_DECEL } from './controller-constants';
```

`@thirdlight/platformer` (new package):

```ts
export const PLATFORMER_MODULE_ID: 'thirdlight.platformer:controller';
export const platformerSpec: SimulationModuleSpec;
export const CONTROLLER_CONSTANTS: Readonly<{
  capsuleRadius: 0.3; capsuleHalfHeight: 0.6; offsetSkin: 0.01; groundSnap: 0.1;
  autostep: false; moveAccel: 40; moveDecel: 60; coyoteSteps: 6; jumpBufferSteps: 8;
  jumpReleaseFactor: 0.5; settlePreRollSteps: 12;
}>;
```

`@thirdlight/project-model` (proposed): `M2_SETTINGS_KEYS`,
`resolveGameplaySettings`, `validateCollider`, `validateController`,
`CONTROLLER_CAPSULE`.

`@thirdlight/editor` / `@thirdlight/exporter` bootstraps compose:
`attachBrowserInput(...)` (or a recorded source) + the core registry +
`createPhysicsPort(...)` → `instantiateRuntime({ ..., actions, physics })`.

## 13. Compatibility and change rules

- M1 default behavior is unchanged when `actions`/`physics` are absent and only
  the demo module is selected (`diffs/runtime.md` §3.1 default source = neutral
  frames; no port required). The M1 module `step` signature changes (phase
  parameter + `StepContext`) — a **breaking type change** recorded in the diff
  and implemented by packet 29 with the runtime's own tests updated; M1
  observable behavior (demo math, lifecycle, interpolation, diagnostics) stays
  identical.
- Adding a phase, changing the canonical phase order, adding a settings key,
  changing a window/constant, or changing the fail-stop rule is a reviewed
  contract change. The windows and constants are part of the contract because
  committed fixtures and acceptance A12/A13 depend on their exact values.
- No implementation may reorder phases, add a second transform writer, or
  continue stepping after a module error to "keep the demo alive": those are
  contract violations even if they look more forgiving.

## 14. Deliberately not in M2

- No follow camera, camera shake, cutscenes or camera-authoring commands.
- No behavior source execution or scheduling (packet 18/33/34); M2's `intent`
  phase exists and is validated, with the reference module set containing no
  behavior modules yet.
- No animation-driven movement, root motion, input-driven animation, HUD, win
  conditions, hazards, respawn, checkpoints, audio, or M3 sample-game systems.
- No coyote/buffer authoring in the UI, no per-entity controller tuning, no
  multiple players or AI agents, no networking/rollback, no hot reload of
  module code (a module change restarts play).
