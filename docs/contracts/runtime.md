# Thirdlight — Runtime Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 03 · 2026-09-17
Scope: M1 play/runtime core — the immutable snapshot input, the
instantiate/start/stop/dispose lifecycle, the separate mutable simulation
state, transform ownership, fixed-step scheduling with bounded catch-up, the
render interpolation policy, the built-in moving-box demonstration, and
structured diagnostics.

Companion documents (same milestone, review together):

- `docs/contracts/project-model.md` v0.2 — the snapshot source: scene shape,
  normalization, validation, and the runtime snapshot ID rule (§6 there).
- `docs/contracts/commands.md` v0.1 — the authoring revision the snapshot
  captures; play mode never mutates it.
- `docs/contracts/sessions.md` — how a snapshot reaches the preview frame,
  how play/screenshot are routed, and how the play revision is displayed.
- `docs/contracts/export.md` — reuses this runtime byte-for-byte.
- `docs/contracts/dependencies.md` — allowed imports and the module
  registration mechanism.

Inputs read: `AGENTS.md`, `docs/STATUS.md`,
`docs/architecture/charter.md` (§5 module architecture, §6 editing and
runtime state, §8 performance policy), `docs/decisions/0001-stack-and-deployment.md`,
`docs/environment.md`, planning packet 03.

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense. "The runtime" means the `runtime` package (packet 08);
"the adapter" means the `three-adapter` package (packet 08).

---

## 1. Scope and ownership

This contract owns:

- The **runtime snapshot** input document (its exact shape, derivation, and
  immutability rules).
- The **lifecycle API**: `instantiateRuntime`, `start`, `stop`, `dispose`,
  `tick`, `getInterpolatedState`, `getCamera`, `getDiagnostics` — exact
  states, transitions, and error codes.
- The **mutable simulation state** model and its separation from the
  snapshot.
- **Transform ownership**: who owns which transform at which time, and the
  no-write-back rule.
- **Fixed-step scheduling**: step rate, clock, bounded catch-up, and the
  drop-and-resync rule.
- The **render interpolation policy** (position/scale lerp, quaternion
  slerp, read-only derivation).
- The **built-in moving-box demonstration** — M1's only gameplay behavior —
  with its exact, deterministic math.
- The **M2 module phase model**: phase registration, the canonical phase order,
  transform ownership and the write guard (new §12).
- The **injected ports**: the input `ActionSource` and the physics `PhysicsPort`
  the runtime owns and the host constructs.
- The **M2 fail-stop lifecycle**: the `failed` state and what a failed
  simulation may still render (new §13).
- The **gameplay settings resolution** rule (values are validated by
  project-model; the runtime consumes the resolved, frozen object).
- The **behavior execution boundary**: trusted declaration-only and
  source-bearing behaviors, their static source rules and the digest-bound
  compilation/publication order (`behaviors.md` §2–§8). A behavior never
  mutates the snapshot, the authoring state or the physics world.
- The **`intent` phase commit point** and the `IntentSet`: the only channel by
  which a behavior influences the simulation (`behaviors.md` §9.4/§9.5).
- The **non-physics transform ownership** of behavior entities
  (`behaviors.md` §9.6) and its write-guard reasons.
- The **trust limitation** (no hard runtime timeout, no hostile-code sandbox)
  and the durable acknowledgment gate — an owner decision, not a runtime
  capability (`behaviors.md` §2/§2.3).
- The **structured diagnostics** shape and error codes.
- The **M3 run** and its schedule: the run state machine, the M3-only phases
  (`gameplay`, `camera`), the step-boundary reset transaction, the committed
  read-only game view and the gameplay camera's transform ownership (new §15;
  rule text in the sibling contract `gameplay.md`).
- The **gameplay zone service boundary**: a pure swept-capsule/zone predicate
  over the last completed motion segment, which never moves anything
  (`gameplay.md` §4).
- The **committed `GameView`** observation and its bound (`gameplay.md` §6).
- The **restricted physics reset/clearance operations** the runtime owns for
  respawn; the accepted diagnostic `PhysicsPort.reset` stays tests-only
  (`gameplay.md` §5.2).
- The explicit non-goals: no user scripts, no input, no physics (§10).

This contract does **not** own:

- three.js rendering, Object3D/material/GPU lifetimes, renderer selection —
  the three-adapter (packet 08 implements; §9 here fixes its inputs).
- Transport, sessions, auth, play routing, screenshots — `sessions.md`.
- Filesystem access of any kind, the workspace envelope, or the authoring
  revision — `workspace.md`.
- Export packaging — `export.md`.

**Normative environment boundary:** the runtime has **no** dependency on the
filesystem, the backend, the editor, MCP, or the network. It imports
`project-model` only (§9). It runs unmodified in the play-preview bundle, the
export bundle, and the Node test harness.

## 2. Runtime snapshot (the only input)

A runtime instance is created from exactly one input document, the
**runtime snapshot**:

```json
{
  "snapshotId": "demo-0001@r12",
  "projectId": "demo-0001",
  "revision": 12,
  "scene": {
    "schemaVersion": 1,
    "sceneId": "scene-main",
    "revision": 12,
    "entities": [ "…" ]
  },
  "game": null
}
```

| Field | Constraint |
|---|---|
| `snapshotId` | exactly `<projectId>@r<revision>` (project-model §6). Any other value ⇒ `snapshot_invalid` (`reason: "id_mismatch"`). |
| `projectId` | project-model ID syntax. |
| `revision` | integer, `0 ≤ v ≤ 2^53−1`; must equal `scene.revision` (else `snapshot_invalid`, `reason: "revision_mismatch"`). |
| `scene` | a complete **normalized** scene document (project-model §8/§12.2). Must pass `validateScene` — the runtime re-validates on receipt (the producer is not trusted; the session layer and the exporter both construct snapshots, and the runtime is the boundary). Validation failures ⇒ `snapshot_invalid` carrying the project-model error objects (≤ 10 reported, total count given). |
| `game` | **v3 snapshots only, required.** A deep-frozen copy of the validated `content.game` block (`project-model` §23.4) or `null`. Present iff `scene.schemaVersion === 3`; absent for v1/v2 (an unknown field on a v1/v2 snapshot is still `snapshot_invalid`, `reason: "shape"`). A v3 snapshot without it, or with a value that fails the §23.4 shape/level/`killY` rules, is `snapshot_invalid` (`reason: "shape"` / `reason: "scene_validation"`). |

Rules:

- **Immutable input, normatively.** On successful `instantiateRuntime`, the
  runtime deep-freezes the snapshot object (recursive `Object.freeze`) and
  never writes to it. All mutable data lives in the separate simulation
  state (§4). Packet 08 verifies: after a full run, the snapshot is
  deep-equal to the input and still frozen.
- **Provenance.** Snapshots are constructed only by (a) the backend from the
  workspace envelope's embedded scene at the current authoring revision
  (`sessions.md` §10) or (b) the exporter from the same source
  (`export.md` §2). The runtime never reads files, sockets, or process state
  to obtain or refresh a snapshot.
- **Bounded.** ≤ 1024 entities (project-model §10.4) — the snapshot is a
  bounded document; this bound makes the bridge relay and export metadata
  bounded as well.
- **The game block travels with the snapshot (M3).** The run's level bounds,
  `killY`, cue references and `spawnId`/`playerId`/`cameraId` are the frozen
  `content.game` block, which is envelope content rather than scene data. It is
  therefore carried **inside** the snapshot (never re-read from disk, never
  looked up through the runtime's host) so that one snapshot remains the
  runtime's only input (`gameplay.md` §3.3). The zone/`cameraFollow`/
  `playerSpawn` data it references is already scene data and needs no wrapper.
- Strict shape: unknown fields at any level ⇒ `snapshot_invalid`
  (`reason: "shape"`, path given). The snapshot carries no booleans in its
  `scene` (project-model §4); the wrapper fields above are the only extra
  fields.

## 3. Lifecycle: instantiate / start / stop / dispose

States: `instantiated → running ⇄ stopped → disposed` (`disposed` is
terminal; `running ⇄ stopped` may repeat), plus `running | stopped → failed →
disposed` for a runtime whose module set contains at least one M2 (stateful)
module (§13). A runtime with only the M1 demo module cannot reach `failed`.

API (public exports of `runtime`; strict types; every call returns a result
object and **never throws** on protocol misuse):

```text
instantiateRuntime(config) → { ok: true, runtime } | { ok: false, error }
runtime.start()            → { ok: true } | { ok: false, error }
runtime.stop()             → { ok: true } | { ok: false, error }
runtime.tick(nowSeconds)   → { ok: true } | { ok: false, error }   (manual driver only)
runtime.getDiagnostics()   → { ok: true, diagnostics } | { ok: false, error }
runtime.getInterpolatedState() → { ok: true, state } | { ok: false, error }
runtime.getCamera()        → { ok: true, camera } | { ok: false, error }
runtime.dispose()          → { ok: true, alreadyDisposed?: true } | { ok: false, error }
```

### 3.1 `instantiateRuntime(config)`

`config` (strict; unknown fields ⇒ `config_invalid`):

| Field | Constraint | Default |
|---|---|---|
| `snapshot` | the runtime snapshot (§2) | required |
| `registry` | a simulation-module registry (`createSimulationRegistry()`, dependencies.md §6) | required |
| `modules` | array of module IDs present in `registry`; unknown or duplicate ID ⇒ `config_invalid`; phase/ownership/exclusion validation per §12 | `["thirdlight.demo:box-motion"]` (M1 default) |
| `actions` | an `ActionSource` (§12.5): the per-step input port. Strict shape, not a raw DOM/Gamepad object | a built-in source that always returns the neutral frame (M1 behavior preserved exactly) |
| `physics` | an already-initialized `PhysicsPort` (`physics.md` §5). Required iff the selected module set contains a module whose spec requires one | absent (M1 sets require none) |
| `settings` | a (partial) gameplay-settings record, resolved through `project-model`'s `resolveGameplaySettings`; an invalid key/value ⇒ `config_invalid` (`reason: "settings"`) | absent ⇒ the six-key defaults (`project-model.md` §21.4). **C35-5 closed (packet 42):** the play and export wrappers pass the **resolved** settings object from the `manifestVersion 2` runtime-content manifest (`sessions.md` §17.1.1), captured from the envelope's `content.settings` through the same `resolveGameplaySettings`; the identical object configures the physics port (`gravity_y`), so the controller and physics never disagree (delivery.md §3.3). |
| `modules` entries `thirdlight.behavior:<behaviorId>` | valid only when the snapshot's content declares that behavior with a non-null `source` **and** the host has linked the compiled output for its `outputDigest`; the phase list is `["intent"]`, or `["intent","transform"]` when the container's `ownedTransforms` is non-empty | `config_invalid` (`reason: "behavior_source_unlinked"`) |
| behavior ownership validation (at instantiate, before any step) | every `ownedTransforms` entry must exist, carry `components.behavior` for the same `behaviorId`, and be neither the camera entity nor a `collider`/`controller` entity | `transform_owner_forbidden` (`reason: "behavior_ownership_forbidden"`, `detail: "camera" \| "physics_entity" \| "not_behavior_entity"`); packet 17's `transform_owner_conflict` for an entity claimed twice |
| behavior instance count | one instance per (behavior module, entity carrying that behavior) pair; ≤ 64 modules per runtime instance | `config_invalid` (`reason: "behavior_modules"`) |
| `source: null` behaviors | register **no** module and contribute nothing | — (authored data only) |

Normative: `instantiateRuntime` **must not** compile, import, fetch or otherwise
load behavior code. By the time it runs, the module set and its linked outputs
are fixed; the runtime is synchronous (`platformer.md` §6, `behaviors.md` §5.4).
| `clock` | `() => number` — monotonic seconds | `performance.now() / 1000` when `performance` exists; injected clock otherwise (tests) |
| `driver` | `{ kind: "raf" }` (requires `requestAnimationFrame`) or `{ kind: "manual" }` (no auto-loop; the host calls `tick`) | `"raf"` when available, else `"manual"` |
| `fixedStepHz` | integer `1 ≤ v ≤ 1000` | `120` (the M1 constant) |
| `onFrame` | `() => void` — called once per frame after the step update (§6) | absent |

Effect: validate the snapshot (§2), deep-freeze it, resolve the gameplay
settings from `snapshot.scene`/the envelope's content block (`platformer.md`
§10) and deep-freeze them, validate the module set's phases, exclusions and
transform ownership (§12) — a violation returns `config_invalid` and creates
nothing — then build the initial
mutable state (§4) with `prev = curr = snapshot transforms`, `stepIndex 0`,
`simTime 0`; create one module instance per `modules` entry (module
`create`, dependencies.md §6). State becomes `instantiated`. **No loop,
timer, listener, or renderer is installed** at instantiate.

> **C35-5 — where `content.settings` comes from (closed by packet 42).**
> If `config.settings` is supplied it wins; otherwise the runtime resolves the
> six-key defaults (`project-model.md` §21.4) and `sceneVersion` is read from
> the snapshot's `scene.schemaVersion`. **M3 wiring (normative):** the
> `manifestVersion 2` runtime-content manifest carries a resolved `settings`
> object plus its `settingsDigest` (`sessions.md` §17.1.1, delivery.md §2.3);
> the play and export wrappers pass that object as `config.settings` **and**
> configure the physics port from the same in-memory object (`gravity_y` is the
> configured gravity). One capture, one resolution, two consumers — there is no
> second read of `content.settings` and no hidden wiring. Authored non-default
> settings therefore reach the controller and the physics configuration in both
> hosts; the numeric acceptance comparison (defaults vs a changed `run_speed`
> and `gravity_y`) is delivery.md §3.3 item 5. A later authoring edit produces a
> new snapshot/build and never changes a pinned run's resolved values or bytes
> (delivery.md §3.3 item 6).

### 3.2 `start()`

- From `instantiated` or `stopped`: install the frame driver (a single
  `requestAnimationFrame` loop for `driver.kind: "raf"`; none for
  `"manual"`), set the wall anchor on the first frame (§5), state →
  `running`.
- **Settle pre-roll (M2 module sets).** Before the wall anchor is installed,
  the first frame after `start()` executes exactly `SETTLE_PREROLL_STEPS = 12`
  fixed steps with neutral action frames (`platformer.md` §6,
  `physics.md` §9). The pre-roll consumes no wall time and is part of
  initialization: `stepIndex` becomes 12, `simTime` becomes `0.1 s`, and the
  first sampled action frame is at `stepIndex 12`. A module or port error
  during the pre-roll is a normal fail-stop (§13). M1 module sets execute no
  pre-roll.
- **Run-start barrier (M3-enabled sets).** `start()` does not itself start a
  run: the run begins in `awaitingStart` and becomes `playing` only when the
  host's `start` run command is consumed at a step boundary (§15,
  `gameplay.md` §2.2 T1). The barrier makes `prev == curr` and snaps the
  gameplay camera (`gameplay.md` §5.1 R7, §7.4); it performs no physics reset,
  so the accepted settle pre-roll still owns capsule settling.
- From `running` ⇒ error `runtime_already_started`.
- From `disposed` ⇒ `runtime_disposed`.
- **Restart from `stopped` continues the retained state** (simTime and
  stepIndex keep counting; M1 defines no reset).
- **Exactly one driver at any time, normatively.** A start/stop/start cycle
  installs exactly one rAF; packet 08 proves no duplicate loop survives a
  cycle and that all owned listeners are removed on stop/dispose.

### 3.3 `stop()`

- `running` → `stopped`: cancel the driver (rAF cancelled — the owned
  listener is removed), state → `stopped`. The mutable state is **retained**
  (a restart continues; the last interpolated state remains readable).
- From `instantiated` ⇒ `runtime_not_running`.
- From `disposed` ⇒ `runtime_disposed`.

### 3.4 `dispose()`

- Any state → `disposed`: cancel the driver if running, release the mutable
  state, module instances (module `dispose?()`), and all references held by
  the runtime (so the heap is reclaimable). **Idempotent:** a second call
  returns `{ ok: true, alreadyDisposed: true }`.
- After dispose: `start`/`stop`/`tick`/`getInterpolatedState`/`getCamera`
  ⇒ `runtime_disposed`; `getDiagnostics` still works and reports
  `state: "disposed"`.
- Packet 08 verifies disposal is repeatable (start → stop → start → dispose
  twice) and releases all owned resources/listeners.

### 3.5 `tick(nowSeconds)`

Runs one frame update (§5) + `onFrame`. **Only for `driver.kind: "manual"`**
(test harness); with the rAF driver ⇒ `tick_not_allowed` (a second loop
source would double-step the simulation). On a `failed` runtime ⇒
`runtime_failed` (§13): a failed simulation is never ticked again.

## 4. Mutable simulation state (separate from the snapshot)

At instantiate the runtime builds an independent mutable state: a deep copy
of the snapshot's per-entity data, plus scheduling fields:

```text
state = {
  order:      [ entity IDs in snapshot document order ],
  entities:   Map<id, { id, parentId, name?, transform: { position[3], rotation[4], scale[3] },
                        box?: { size[3], material: { color } }, camera?: { type, fovY, near, far } }>,
  stepIndex:  0,
  simTime:    0,
  prev:       Map<id, transform>,   // transforms at the end of step n-1
  curr:       Map<id, transform>    // transforms at the end of step n
}
```

- `prev` and `curr` are initialized equal to the snapshot transforms (both
  deep copies — the snapshot itself is never aliased).
- **Every simulation mutation writes only to this state.** The snapshot
  remains frozen and byte-identical (canonical bytes, §2).
- M1 transitions are exactly the demo module's per-step position updates
  (§7). M1 adds/removes no entities and changes no other component value.
- **Phase-scoped mutability (M2).** `curr` is writable only during the
  `transform` phase; in the `intent`, `controller` and `physics` phases the
  runtime hands modules a throwing read-only view of `curr` (§12). Writing
  outside the `transform` phase is a fail-stop module error, so a
  half-mutated step cannot be committed.
- **Private state is not in `state`.** The physics world, the controller's
  velocity/window state and (packet 18) script state live inside their module
  or port instances. They are deliberately **not** derivable from
  `prev`/`curr`; that is why §13's failure path is safe restart, not rollback.
- **`lastCommitted` (M3, runtime-private).** The runtime keeps one additional
  map, `lastCommitted: Map<id, transform>`, holding the transforms committed at
  the end of the last completed step. It is updated at every commit and **by the
  reset transaction** (`gameplay.md` §5.1 R7). It exists because during step `n`
  the accepted commit order leaves `state.prev` holding the end of step `n−2`
  (the `prev := curr` promotion happens at the end of the step): a `gameplay`
  phase that needs "the last completed motion segment" must ask for it instead
  of reading `state.prev` (`gameplay.md` §3.3, fixture `segment-source`).
  `lastCommitted` is not exposed to modules as a map; it is readable only
  through `GameSessionPort.lastMotionSegment(entityId)`.
- **Physics-bearing entity policy.** A module may write only the components it
  owns: the controller writes the character's `position.x`/`position.y`; Z,
  rotation and scale are never written (`physics.md` §2, `platformer.md` §5).
- **Determinism, normatively:** one step is a pure function of
  `(state, stepIndex, snapshot, modules, fixedStepHz)`. The wall clock
  affects only *how many* steps run per frame (§5), never the per-step
  computation. Same inputs + same step sequence ⇒ identical state sequences.
  (Bit-exactness is claimed within the same JS engine; cross-engine last-ulp
  differences in `Math.sin`/`Math.atan2` are not claimed — §7.3.)
- `simTime` is always `stepIndex / fixedStepHz` (single division — no
  per-step floating accumulation, so no drift).

## 5. Fixed steps with bounded catch-up

Constants (M1, normative): `SIM_HZ = 120` default (`dt = 1/SIM_HZ`),
`MAX_CATCHUP_STEPS = 8`.

The runtime keeps a wall anchor `{ wallAtFrame, simTimeAtAnchor }`. On each
frame at wall time `t` (from `clock()`; the frame arrives via the rAF driver
or `tick`):

1. `elapsed = t − wallAtFrame` (clamp `elapsed ≥ 0` — a non-monotonic clock
   yields zero steps and one `clock_warning` diagnostic count, no error).
2. `targetSim = simTimeAtAnchor + elapsed`.
3. `rawN = floor((targetSim − simTime) / dt)`; execute `n = min(rawN, MAX_CATCHUP_STEPS)`
   steps. One step: `prev := curr; curr := step(curr, stepIndex)` (each
   module in registration order, §5.1); `stepIndex++`; `simTime = stepIndex / fixedStepHz`.
4. **Bounded catch-up (normative).** If `rawN > MAX_CATCHUP_STEPS`: after the
   capped steps, **drop the remainder and resync the anchor**:
   `wallAtFrame = t; simTimeAtAnchor = simTime`. Record
   `droppedSteps += rawN − MAX_CATCHUP_STEPS` (diagnostics, §8). No
   unbounded burst is ever executed after a stall (tab switch, debugger
   pause, GC hiccup) — charter §8 "cap catch-up work after stalls".
5. If `rawN == 0`: no step; the frame renders the current state
   (interpolation `alpha` per §6).
6. First frame after `start`: the anchor is initialized at that frame
   (`wallAtFrame = t, simTimeAtAnchor = simTime`) — time before `start` is
   never simulated.

**M2 additions (the arithmetic above is unchanged — 120 Hz and the eight-step
cap are kept):**

- **One action sample per executed step.** The runtime calls
  `actions.sample(n)` exactly once per executed step, before any module phase,
  and passes the returned `ActionFrame` to every phase of that step
  (§12.5.1). A step that is not executed is never sampled.
- **No phantom steps, no replayed edges.** A dropped wall-time interval
  executes no steps, samples no frames and calls no module or port method; the
  drop-and-resync in item 4 is the whole mechanism. Because `stepIndex` is
  contiguous and each index is executed at most once, a `pressed` edge is
  delivered at exactly one step even when a frame executes eight catch-up
  steps (`platformer.md` §2.1, fixtures `runtime/catchup.json`).
- **M3 step boundary (additive).** For an M3-enabled set, the step loop first
  consumes the runtime's boundary queues — a pending `replay`/`start` run
  command and a due scheduled reset — and only then performs `prev := curr` and
  samples. Consuming a reset therefore writes into `curr` **before** the
  promotion, which is what makes a reset produce `prev == curr` (no teleport
  sweep, no render streak; `gameplay.md` §3.2, §5.1). Non-M3 sets do not enter
  the hook at all: no branch, no state, no timing change.
- **Determinism with a port.** One step is a pure function of
  `(state, stepIndex, snapshot, resolved settings, actions.sample(stepIndex),
  modules, port state)`. The wall clock still affects only *how many* steps
  run; no module may read wall time, `Math.random`-derived values or any
  ambient device state during a step.
8. At the start of every executed step the runtime clears the **`IntentSet`**
   and freezes the sampled `ActionFrame`; behavior modules registered in the
   `intent` phase commit control intents into it in registration order
   (ascending `behaviorId` codepoint order, `behaviors.md` §9.1). The set is
   frozen at the end of the `intent` phase and read-only afterwards.
9. The controller phase's input is the **effective frame**
   `{ stepIndex, moveX: intents.move ?? action.moveX, jump: intents.jump ??
   action.jump }`; `ctx.action` remains the sampled frame in every phase
   (`platformer.md` §3). With an empty `IntentSet` the effective frame is the
   sampled frame, so packet 17's step algorithm and the 178 pinned trace rows
   are bit-identical (`behaviors.md` §9.5).
10. A dropped wall-time interval executes no steps and therefore commits no
   intents: catch-up can never multiply an intent or a jump edge (same argument
   as §12.5.1).
11. Intent/transform-write caps (`behaviors.md` §10) are enforced at commit
   time and are fail-stop (`module_error` + `behavior_intent_limit`); the step
   is abandoned exactly like a module throw (`platformer.md` §9).

### 5.1 Module step isolation

A module's `step` must either complete its phase consistently or throw.

- **M1 module sets (demo only).** Unchanged: the runtime copies `curr` before a
  step and **restores the copy if the module throws** (no partial
  application): the step is a no-op, `stepIndex`/`simTime` do not advance, a
  `module_error` diagnostic is recorded, and the step keeps no-opping on every
  subsequent step until disposed. This remains exactly as accepted because the
  demo is stateless.
- **M2 module sets (any stateful module selected).** A throw — or a write/phase
  violation, a duplicate staged move, or an invalid/undefined port result —
  **fail-stops the whole simulation** with no rollback attempt: the current
  step is abandoned (no transform copy is restored, because private physics
  and script state cannot be reconstructed from `prev`/`curr`), the driver is
  cancelled, and the runtime enters `failed` (new §13). The runtime never
  continues with a half-mutated world.
- **Phase isolation.** Modules run grouped by their declared phases in the
  canonical order `intent → controller → physics → transform`; within a phase,
  registration order. Phase-scoped write rules and port-call rules are in
  new §12. The M1 demo's `step` math is unchanged, with the phase argument and
  `StepContext` added (§7.2).
- **Fail-stop reasons.** A fail-stop records one bounded error entry with
  `code: 'module_error'`, `reason` ∈ packet 17's set (`phase_violation`,
  `duplicate_move`, `input_frame_invalid`, …) **or** the behavior set of
  `behaviors.md` §9.4/§10 (`behavior_intent_invalid`,
  `behavior_intent_conflict`, `behavior_intent_limit`,
  `behavior_transform_forbidden`, `behavior_step_async`, `behavior_state_shared`),
  with the API's `detail` field when the contract defines one (§8).

### 5.2 Why drops are safe in M1

The M1 demo is a pure function of `simTime` (§7.1): after a drop, the next
step computes the exact position for the new `stepIndex` — no drift, no
desync.

**M2 (recorded re-review, §11's precondition).** Drops stay safe for stateful
modules under three rules, all normative: (1) gameplay state advances only on
**executed** steps, never on wall time — the controller's velocity, coyote and
buffer windows are all integer-step counters (`platformer.md` §7); (2) dropped
steps are neither sampled nor simulated, so a drop shortens nothing
semantically: it is indistinguishable from those steps never existing; (3) the
physics port is stepped exactly once per executed step, so a drop cannot
produce a physics catch-up burst. The observable consequence is that a dropped
interval changes *when* the simulation continues, never *what* it computes —
which is why the acceptance traces replay recorded step-indexed frames rather
than wall-clock events (§12.7).

## 6. Render interpolation policy

The display state is read via `getInterpolatedState()`:

```json
{
  "stepIndex": 1481,
  "simTime": 12.3416667,
  "alpha": 0.42,
  "transforms": [
    { "id": "box-0001", "position": [x, y, z], "rotation": [x, y, z, w], "scale": [sx, sy, sz] }
  ]
}
```

- `alpha = (targetSim − simTime) / dt` for the current frame,
  `0 ≤ alpha < 1` (after a catch-up resync, `targetSim == simTime` ⇒
  `alpha = 0`). `transforms` are in snapshot document order.
- **Per-entity math (normative, read-only derivation):**
  - `position = prev.position + (curr.position − prev.position) · alpha`
    (component-wise lerp).
  - `scale = prev.scale + (curr.scale − prev.scale) · alpha` (component-wise).
  - `rotation = slerp(normalize(prev.rotation), normalize(curr.rotation), alpha)`:
    inputs are **derived copies** (project-model §10.1 — the accepted
    near-unit quaternions are normalized on copies only, never written
    back); sign-align first (if `dot < 0`, negate the second); when
    `dot > 1 − 1e-9` use the normalized linear lerp (avoids the zero-angle
    `atan2` singularity); otherwise the standard constant-rate slerp.
  - If `alpha == 0` or `prev == curr` (component-wise equal), the result is
    `curr` exactly.
- **Read-only, normatively.** The result is fresh derived values per call;
  `getInterpolatedState` never mutates `prev`, `curr`, the module state, or
  the snapshot. The three-adapter copies these values into Object3Ds and
  performs no other transform math.
- M1 notes: the demo changes only `position.x` (rotation/scale interpolation
  is the identity in M1); the camera entity is never moved by any M1 module
  (static play camera); M1 adds/removes no entities, so no
  spawn/despawn interpolation policy is needed (a future module that does
  must define one in a contract change).
- `getCamera()` returns the snapshot's camera projection parameters
  `{ id, fovY, near, far }` (stable for the session; `aspect` is a
  viewport property, not runtime data — project-model §10.3).

**Frame ordering (normative for the adapter, packet 08; extended for M2 and
M3):** the runtime owns the single frame driver. Each **executed step** runs the
phases of §12/§15 (`boundary → sample → intent → controller → physics →
transform → gameplay → camera → commit`; the last three are M3-only and absent
for M1/M2 sets), then the frame continues with (2) `onFrame()` — the adapter reads
`getInterpolatedState()`, copies values into Object3Ds, (3) renders. The
adapter never installs its own animation loop (no duplicate loops; one loop
owner = the runtime), never writes authoritative state, and never applies
gameplay smoothing: the interpolated values are derived read-only from the
authoritative `prev`/`curr` (`physics.md` §7's stall-jitter decision).

The M3 gameplay camera's pose needs **no extra adapter API and no new read
call**: the camera entity is a transform owner, so its pose is published through
`getInterpolatedState()` exactly like every other entity
(`gameplay.md` §3.4/§7.2). `getCamera()` keeps returning the projection
parameters only (unchanged). A viewport resize reaches the camera through the
runtime's viewport record (`Runtime.setViewport`, §15); the adapter never
computes a gameplay camera pose.

## 7. Built-in moving-box demonstration (M1 behavior)

- Module ID: **`thirdlight.demo:box-motion`** — the only M1 built-in
  simulation module (dependencies.md §6 records the M1 registry contents).
  Registered and selected by default (§3.1); disabled via `modules: []`.

### 7.1 Exact behavior (normative math)

For every entity with a `box` component, at each step the module sets, in
the mutable state only:

```text
x(stepIndex) = x0 + A · sin(2 · π · (stepIndex + 1) / (SIM_HZ · T))
```

| Constant | Value | Meaning |
|---|---|---|
| `A` | `0.5` (meters) | half-amplitude of the X oscillation |
| `T` | `4.0` (seconds) | period |
| `SIM_HZ` | `120` | step rate (§3.1 default) |
| `x0` | the snapshot's `position.x` for that entity | the oscillation center |

- `position.y`, `position.z` remain the snapshot values; `rotation` and
  `scale` are unchanged. All boxes oscillate with the same phase (M1
  constant; per-entity phase is a future option).
- Non-box entities (groups, the camera) are never moved: the M1 play camera
  is static.
- Bounded: `|x − x0| ≤ A` — the demo never leaves a ±0.5 m band around the
  authored position (with the default camera at `[0, 0.5, 4]`, fovY 60, the
  box stays well inside view — project-model §15).
- **Pure function of (snapshot, stepIndex):** no randomness, no wall-clock
  input, no cross-step memory. Catch-up drops are exact (§5.2).
- **7.3 Determinism bound:** bit-exact within the same JS engine (IEEE-754
  doubles, fixed operation order); cross-engine last-ulp differences in
  libm are permitted and not a defect.

### 7.2 Module shape

```text
SimulationModuleSpec = {
  id: string,
  phases: readonly SimulationPhase[],        // §12; canonical order, non-empty, unique
  excludes?: readonly string[],              // module IDs that cannot be selected together
  create(snapshot, cfg) → SimulationModule
}
SimulationModule = {
  transformOwners: readonly string[],        // entity IDs this instance writes, declared at create
  step(phase: SimulationPhase, ctx: StepContext) → void,
  dispose?() → void
}
```

(This is a **breaking type change** to the package's public module interface:
packet 29 implements it and updates the runtime's own tests. M1 observable
behavior — demo math, lifecycle, interpolation, diagnostics — is unchanged.)

One instance per runtime instance (`create` at instantiate). The demo's
`create` closes over the snapshot's box entities (their `x0` and document
order); `step` writes positions per §7.1.

Behavior modules use the same `SimulationModuleSpec`/`SimulationModule` shape
with the fields above (`behaviors.md` §9.1/§9.2): `id` is
`thirdlight.behavior:<behaviorId>`, `phases` is `["intent"]` or
`["intent","transform"]`, `transformOwners` is the container's
`ownedTransforms` (empty in the intent-only case), and `create` returns an
instance whose `step(phase, ctx)` calls the authored `step(state, ctx)` **and
nothing else**. The spec's `prepare`/`instantiate`/`dispose` stages map exactly
as `behaviors.md` §9.3 states; `dispose` is called once per created instance,
including from `failed` (packet 17 §9).

### 7.3 User scripts (M1 non-goal; M2 scope split)

M1 provides **no** mechanism to load, compile, or execute project-provided or
user-provided code, and that statement stays true for the M1 runtime module set.
M2 adds **declaration-only behaviors** (a validated declaration with
`source: null`), which execute nothing and register no module, and specifies —
but does not yet enable — **source-bearing behaviors** under
`behaviors.md` §2–§8. Source publication stays unavailable until packet 33
implements the preparation path (`behaviors.md` §8.3); execution is
trusted-main-thread with **no hard timeout and no hostile-code sandbox**
(`behaviors.md` §2.2). Arbitrary user-script loading from a URL, an npm
dependency or a build hook remains a non-goal in M2.

## 8. Structured diagnostics

`getDiagnostics()` works in every state, including `disposed`. The example
below is an **M2 module set**; an M1 default set (no M2 module selected)
carries the accepted M1 key set only and omits every field the table marks
M2-only (`failed`, `failedModuleId`/`failedPhase`/`failedStepIndex`,
`settleSteps`, `inputSamples`, `physicsSteps`, `droppedInputSteps`, the input
lifecycle counters and the physics counters).

```json
{
  "state": "instantiated",
  "snapshotId": "demo-0001@r12",
  "revision": 12,
  "simTime": 12.3416667,
  "stepIndex": 1481,
  "fixedStepHz": 120,
  "droppedSteps": 3,
  "frameCount": 180,
  "entityCount": 4,
  "modules": ["thirdlight.platformer:controller"],
  "clock": "performance",
  "clockWarningCount": 0,
  "failed": false,
  "settleSteps": 12,
  "inputSamples": 1469,
  "physicsSteps": 1481,
  "droppedInputSteps": 3,
  "errors": [ { "code": "module_error", "message": "module step threw (clipped)", "stepIndex": 1481 } ],
  "errorCount": 1
}
```

| Field | Meaning |
|---|---|
| `state` | `instantiated` \| `running` \| `stopped` \| `disposed` |
| `simTime` / `stepIndex` / `frameCount` | scheduling counters (`frameCount` counts §5 frame updates, including zero-step frames) |
| `droppedSteps` | cumulative catch-up drops (§5.4) |
| `modules` | the selected module IDs (registration order) |
| `clock` | `"performance"` (default) or `"injected"` |
| `clockWarningCount` | non-monotonic `clock()` observations (no step, no error) |
| `failed` | `boolean` — sticky; `true` iff the runtime entered the §13 failed state |
| `runState` / `runId` / `deathCount` / `checkpointId` / `gameEventCount` | M3-only run counters (`gameplay.md` §6). Present exactly when the set is M3-enabled; absent for M1/M2 sets (frozen field set preserved). `gameEventCount` is cumulative; the retained list is bounded at `MAX_GAME_EVENTS = 32`. |
| `failedModuleId` / `failedPhase` / `failedStepIndex` | sticky diagnostic fields describing the fail-stop (absent while healthy) |
| `inputSamples` | executed-step action samples = `stepIndex − settleSteps` (the 12-step settle pre-roll is not sampled; 0 for M1 default sets) |
| `inputSuspendCount` / `inputActivateCount` / `inputDisconnectCount` / `inputMappingUnsupportedCount` | input lifecycle counters (§12.5.5–§12.5.8); diagnostics only |
| `physicsSteps` / `physicsStallSteps` / `physicsPenetrationCorrectedCount` | port counters; `physicsStallSteps` records the packet-14 one-step horizontal stall (passed through, never smoothed) |
| `droppedInputSteps` | dropped steps that consequently had no sample (equals `droppedSteps` for M2 sets) |
| `settleSteps` | `12` for M2 module sets after the pre-roll, else `0` |
| `errors` / `errorCount` | the last **32** error entries (bounded ring; `errorCount` is cumulative — unbounded error floods cannot grow the payload) |

Error entry: `{ "code", "message" (≤ 256 chars, log-safe, no secrets/paths),
"stepIndex"? }`. Stable codes:

| Code | Raised when |
|---|---|
| `config_invalid` | `instantiateRuntime` config is malformed (strict shape, unknown module ID, duplicate module ID) |
| `snapshot_invalid` | snapshot fails §2 (carries `reason` + ≤ 10 project-model error objects + total count) |
| `runtime_already_started` | `start` while `running` |
| `runtime_not_running` | `stop` (or `tick`) while not `running` |
| `runtime_disposed` | any lifecycle method after `dispose` |
| `tick_not_allowed` | `tick` with the rAF driver |
| `module_error` | a module step threw (§5.1) |
| `runtime_failed` | `start`/`tick` after the runtime entered the §13 failed state |
| `module_combination_unsupported` | two selected modules exclude each other (`platformer.md` §2.3) |
| `transform_owner_conflict` | two selected modules claim the same entity transform, or a claim names a missing entity |
| `transform_owner_forbidden` | a module claims the camera entity or a physics-bearing entity it does not own |
| `physics_port_error` | the injected port threw during `step()` or returned a malformed result (§13) |
| `game_command_invalid` | a run command is rejected for the current run state or conflicts with a pending command (M3) |
| `game_spawn_invalid` | the reset destination does not resolve, is outside `content.game.level`, or is at/below `killY` (M3; fail-stop) |
| `game_spawn_blocked` | the reset destination's clearance/overlap probe failed: `blocked` / `no_support` / `hazard` / `query_failed` (M3; fail-stop) |
| `camera_viewport_invalid` | `setViewport` received a non-finite, non-positive or oversized dimension (M3; presentation-only) |
| `game_session_unavailable` | a run/view/viewport call on a runtime that is not M3-enabled (`reason: "schedule"`) |
| `input_frame_invalid` | an action frame is malformed (`input.md` §2), raised via `config_invalid` at construction or as a `module_error` at sample time |

`module_error` keeps its code and gains `moduleId`, `phase` and a `reason`
(`phase_violation` | `input_frame_invalid` | `input_source_threw` |
`duplicate_move` | `module_threw`) in its entry. `config_invalid` gains the
reasons listed above plus `physics_port`, `controller_target`, `scene_version`.
**M3 additions.** `module_error` additionally accepts the reason
`gameplay_invalid` (a session commit call violates a run-state rule);
`physics_port_error` additionally accepts the reason `reset` (a reset-barrier
port failure). No accepted code, reason or carries-shape changes meaning.

**Behavior additions (packet 18).** The error-entry reason set additionally
accepts `behavior_intent_invalid`, `behavior_intent_conflict`,
`behavior_intent_limit`, `behavior_transform_forbidden`, `behavior_step_async`
and `behavior_state_shared` (`behaviors.md` §9.4/§10); `behavior_log` entries
(`{ code, reason: 'info'|'warn'|'error', moduleId, message }`) are stored in the
same 32-entry ring and do **not** increment `errorCount`. Additional fields:
`intentCommitCount` (cumulative accepted intents) and `logCount` / `logDropped`
(cumulative `ctx.log` calls / calls dropped by the per-instance ring and rate
caps, `behaviors.md` §10).

**Adapter diagnostics (three-adapter, packet 08; separate block, composed by
the session layer for the `play.diagnostics` relay — `sessions.md`
§12):** `{ "renderBackend": "webgl2", "rendererInfo": string ≤ 128,
"canvasSize": [w, h], "pixelRatio": number }`. The adapter reports the
**selected** render backend (WebGL 2 first; the WebGPU path only after
feature coverage is proved — decision 0001 §3/§2). The runtime core's
diagnostics never touch the renderer (the core is three-free).

## 9. Dependencies and environment (normative)

- **Imports:** `project-model` only (types + `validateScene`). No three.js,
  no Node built-ins, no `fetch`/`XHR`/`WebSocket`, no filesystem.
- **Injected ports, not imports.** The M2 `ActionSource` and `PhysicsPort` are
  interfaces owned by this contract and implemented by other packages
  (`input`, `physics-rapier`). The runtime receives instances in its config;
  it never imports those packages, never constructs a concrete engine, and
  never touches the DOM beyond §9's two guarded globals. A runtime without a
  port keeps working exactly as M1 (`actions` defaults to neutral frames; no
  port is required for an M1 module set).
- **Behavior bundles are browser-safe and synchronous.** Behavior code receives
  the injected `ctx` only; it must not import `three`, `three-adapter`,
  `editor`, `react`, `backend`, `workspace`, `commands`, `protocol` or any Node
  builtin, must not use `fetch`/`XMLHttpRequest`/`WebSocket`, and must not be
  async (`behaviors.md` §9.7, `dependencies.md`). This is a *compile-time*
  rule (static import/dynamic-code checks and the output-content scan,
  `behaviors.md` §4/§5.5) plus a runtime check (a thenable `step` return is
  fail-stop) — **not** a sandbox (`behaviors.md` §2.2).
- **No compilation at runtime.** The runtime never parses, compiles, evaluates,
  fetches or imports behavior source. A module set with a `source`-bearing
  behavior only exists after the host linked a prepared output
  (`behaviors.md` §8.4/§8.7).
- **DOM surface:** `performance.now` (default clock) and
  `requestAnimationFrame` (default driver) — both guarded behind the
  injectable `clock`/`driver` config, so the Node test harness runs the same
  code with injected fakes.
- **Presentation resources are host-owned.** Lights, shadow maps, primitive
  materials, rigid animation mixers/actions and the audio owner are created and
  disposed by the host and the `three-adapter`/`game-host` units
  (`presentation.md` §41.6). The runtime never constructs a `WebGLRenderer`, a
  `THREE.AnimationMixer`, an `AudioContext`, an `HTMLAudioElement` or a voice
  node; it never decodes or plays audio, never fetches bytes and never receives
  a URL, token or media byte. It publishes only the committed read-only
  `GameView` (including `checkpointActive` and the committed derived
  `playerMotion` field of §15.5, C41-1) and its read-only interpolated
  transforms. No presentation
  resource is part of the snapshot, the mutable state or the diagnostics ring.
- **No hidden globals:** no module-level mutable singletons; every instance
  is an explicit object; cross-instance sharing only via returned values.
- **Runs in:** the play-preview bundle (bridge-fed snapshot), the export
  bundle (embedded snapshot), and the vitest Node harness (manual driver +
  injected clock). Same code, same versions, in all three (`export.md` §5:
  the export uses this runtime, not a separate implementation).

## 10. What is deliberately not in M1 (normative non-goals)

- **No input in M1** (keyboard/controller/gamepad): the M1 runtime consumes no
  input events and the M1 module set still does not. M2 adds the step-indexed
  `ActionFrame` port (§12) and the controller (`platformer.md`); M2 input is
  still not a promise of any M1 packet (m1-acceptance §3).
- **No physics in M1**: no collision, gravity or integration beyond the
  prescribed demo math. M2 adds exactly the 2.5D feature set of
  `physics.md` §3 through an injected port — still no dynamic bodies, joints,
  sensors, moving/one-way platforms, mesh-derived colliders or 3D physics.
- **No graphs**: no node/curve/graph authoring or data in the runtime
  (charter §3 defers graphs; material/shader graphs likewise).
- No entity add/remove/reparent during play; no component edits during
  play; **no play → authoring write-back of any kind** (charter §6:
  applying play-mode changes is a later explicit operation; M1 has none).
- No user-script loading in M1 (§7.3). M2 adds declaration-only behaviors and
  (from packet 33) trusted source-bearing behaviors in the **main thread**,
  with no worker, no watchdog, no hard timeout and no hostile-code sandbox
  (`behaviors.md` §2.2/§2.4). No workers; no audio; no network access from the
  runtime; no persistence of any kind.
- No state-preserving hot reload: a code change requires a new publication and
  a fresh play instance (`behaviors.md` §8.6). Editing source, publishing, or
  staging while a play instance runs changes nothing in it — there is no
  watcher and no implicit snapshot change.
- No multiplayer/synchronization: a runtime instance is single-context.
- No render-quality management, LOD, or asset handling (the adapter owns
  rendering; the runtime owns scheduling and state only).

## 11. Change rules

- After Gate A acceptance, any change to the snapshot shape, lifecycle
  states, step math, interpolation policy, demo constants, diagnostics
  fields, or error codes is a reviewed contract diff (AGENTS.md: accepted
  contracts are binding).
- New simulation modules (M2 input/physics) enter only through the
  registry (dependencies.md §6) with their own reviewed step/drop semantics;
  this document's §5.2 note is the recorded precondition.
- `simTime = stepIndex / fixedStepHz` (no accumulation) and the deep-freeze
  of the snapshot are load-bearing invariants for determinism and
  snapshot-integrity tests; weakening either requires review.
- The M2 phase model, transform-ownership rule, port surfaces, fail-stop
  behavior, diagnostics fields and error codes (new §§12–13) are contract
  material: reordering phases, adding a second writer for one transform,
  continuing after a module error, or changing `SIM_HZ`/`MAX_CATCHUP_STEPS`
  requires a reviewed change, not a local implementation choice.
- M2's controller constants, jump windows and gameplay settings registry
  (`platformer.md` §§7/10) follow the same rule: committed fixtures and
  acceptance A12/A13 reference their exact values.
- The `intent` phase, the `IntentSet`, the effective-input rule, the
  intent/transform write rules and the §10 caps (`behaviors.md` §9/§10) are
  contract material: fixtures and acceptance reference their exact values.
  Changing the effective-input rule or a conflict rule requires a reviewed
  diff, and a new intent kind also requires a consumer in `platformer.md`.
- The trust disposition (`behaviors.md` §2) is an owner decision: no packet may
  weaken a §2.2 limitation, drop the §2.3 acknowledgment gate or claim
  preemption. If a hard boundary is required, a **separate execution-boundary
  design packet** is the recorded path (§2.4).
- Behavior source publication may be enabled only by packet 33's preparation
  path plus a reviewed contract diff (`behaviors.md` §8.3); a change that makes
  `publishBehavior{mode:"source"}` succeed without the prepare step is a
  contract violation, not a feature.
- **The M3 game session is contract material.** Any change to a number in
  `gameplay.md` §8.2, to the zone precedence order of `gameplay.md` §4.3, to the
  phase order of `gameplay.md` §3.2 or to the reset transaction of `gameplay.md`
  §5.1 invalidates the corresponding fixtures (`fixtures/m3/gameplay/**`,
  `fixtures/m3/camera/**`) and reopens this contract; the fixtures are the
  reviewable form of those numbers. Reordering the M3 phases, adding a second
  transform writer, continuing after a module error or changing
  `RESPAWN_DELAY_STEPS`/`CAMERA_Z`/`CAMERA_MAX_STEP` requires a reviewed change,
  not a local implementation choice.
- **The committed `GameView` is read-only contract material.** Its fields
  (including the derived `playerMotion` of §15.5), the single-publication rule,
  the `MAX_GAME_EVENTS` bound and the run identity tuple may not be extended or
  reinterpreted without a reviewed diff; an implementation may not add a second
  view, a second run-state owner or a second mutation path.
- **M3 is additive over M2.** The M3 additions are optional and go through
  `ModuleConfig`/`StepContext` exactly as `gameplay.md` describes; no accepted
  M1/M2 field, code, order or default changes meaning and the M1/M2 fixtures
  stay byte-identical (`gameplay.md` §3.5).


## 12. M2 module phases, ports and transform ownership

### 12.0 M2 module sets (M1 unchanged)


This contract owns:

- The **fixed-step ordering** and the **module phase registration** model:
  `intent → controller → physics → transform → render`, with the write guard.
- The **authoritative transform policy**: one owner per entity, the ownership
  declaration, duplicate-writer rejection and the camera/character protections.
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
| `input` (new) | the device binding producing `ActionFrame` (§12.5) |
| `editor` / `exporter` | host bootstraps that compose the modules and inject the port; no gameplay math |

### 12.1 Phase registration and the canonical phase order


The accepted registry mechanism (`dependencies.md` §6) is extended, not
replaced: registration stays compile-time code, IDs keep the
`^thirdlight\.[a-z0-9]+:[a-z0-9-]+$` syntax, and there is still no
string-to-code resolution or content-loaded module.

```ts
type SimulationPhase = 'intent' | 'controller' | 'transform'    // accepted M2 order
                     | 'gameplay' | 'camera';                   // M3 additions, appended

interface SimulationModuleSpec {
  id: string;
  phases?: readonly SimulationPhase[];   // M2: non-empty, no duplicates, canonical order;
                                          // absent ⇒ an M1 module with an implicit `["transform"]` phase
  excludes?: readonly string[];           // module IDs this spec cannot coexist with
  requiresPhysicsPort?: boolean;          // the selected set requires an injected PhysicsPort (C29-1)
  create(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationModule | SimulationPhaseModule;
}

interface SimulationModule {              // accepted M1 module shape
  step(state: SimState, stepIndex: number): void;
  dispose?(): void;
}

interface SimulationPhaseModule {         // the M2 phased module interface (C29-4)
  readonly transformOwners: readonly string[];   // declared once, at create
  step(phase: SimulationPhase, ctx: StepContext): void;
  /** M3 only: runtime-called reset-barrier hook (`gameplay.md` §5.1 R6). */
  reset?(ctx: ModuleResetContext): void;
  dispose?(): void;
}

interface ModuleConfig {                    // `cfg`, passed to `create`
  fixedStepHz: number;                      // §3.1
  settings: Readonly<GameplaySettings>;     // resolved at instantiate (§8)
  sceneVersion: 1 | 2 | 3;                  // the snapshot's schemaVersion
  game?: Readonly<GameConfig>;              // v3 only: the frozen content.game block
  behaviorLog?(level: BehaviorLogLevel, message: string): void;  // C34-2
}
```

`SIMULATION_PHASE_ORDER` becomes
`['intent','controller','transform','gameplay','camera']`. Every accepted M2
phase list is a **prefix** of the new order and stays valid unchanged; a phase
list that skips or reorders a phase is still rejected. A set is **M3-enabled**
iff at least one selected module declares `gameplay` or `camera`
(`gameplay.md` §3.1).
> **C34-2 (accepted with diff, Gate I):** `ModuleConfig` additionally carries
the optional bounded `behaviorLog(level, message)` sink. The runtime owns the
32-entry diagnostics ring (§14.8.1); the behavior module owns its per-instance
ring and counters. Absent ⇒ log entries are counted and dropped as before.

**M2 module inventory (registered by the host bootstrap at build time):**

| Module ID | Phases | Transform owners | Notes |
|---|---|---|---|
| `thirdlight.demo:box-motion` | `["transform"]` | every entity carrying `box` | unchanged M1 math (runtime.md §7.1) |
| `thirdlight.platformer:controller` | `["controller", "transform"]` | the single `components.controller` entity | excludes `thirdlight.demo:box-motion` |
| behavior modules (packets 18/34) | `["intent","transform"]` when the container's `ownedTransforms` is non-empty, else `["intent"]` | the declared `ownedTransforms` IDs (none in the intent-only case) | packet 18 owns their spec. **C34-5 (accepted with diff, Gate I):** the earlier `["intent"]`/“none” row contradicted §14.4/§14.6 (a `transform` intent is valid only in the transform phase and writes an owned entity); the corrected row matches `createBehaviorModuleSpec`. |
| `thirdlight.platformer-game:session` (M3) | `["gameplay"]` | none (`[]`) | the pure run/zone module; stateless (`gameplay.md` §3.3/§4) |
| `thirdlight.platformer-game:camera` (M3) | `["camera"]` | exactly the scene's single `camera` entity | the only camera writer (`gameplay.md` §3.4/§7) |

The `physics-rapier` adapter is **not** a module: it is the injected
`PhysicsPort` owned by the runtime (physics.md §5). This is what keeps one
mutation path for collision state.

#### 12.1.1 Fixed-step ordering (normative, replacing nothing in M1's per-step math)

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

### 12.2 Write guard and phase violations


- The runtime passes a **write-only** `state.curr` during the `transform` phase
  and a **throwing read-only view** of `curr` during `intent`, `controller` and
  `physics`. A module that writes `curr` outside the `transform` phase throws a
  `module_error` (`reason: "phase_violation"`) → fail-stop (§9).
- `ctx.physics.stageCharacterMove` is callable only in the `controller` phase;
  any other phase throws `module_error` (`reason: "phase_violation"`).
- `state.prev`, `state.order`, `state.entities` component data and the snapshot
  are read-only in every phase.
- **M3 phase scoping.** In the `camera` phase, a phased module may write `curr`
  only for declared owners that are the camera entity, and only
  `position.x`/`position.y`. In the `gameplay` phase `curr` is read-only
  (throwing). Writing outside these rules is `module_error`
  (`reason: "phase_violation"`) → fail-stop. The accepted `transform` rule is
  unchanged (`gameplay.md` §3.4).



```ts
interface GameplaySettings {                    // resolved at instantiate (§8)
  gravity_y: number; run_speed: number; jump_velocity: number; max_fall_speed: number;
  max_slope_climb_deg: number; min_slope_slide_deg: number;
}

interface StepContext {
  readonly stepIndex: number;
  readonly phase: SimulationPhase;
  readonly action: ActionFrame;                 // the SAMPLED frame — identical for every phase of this step (§14.5)
  readonly settings: Readonly<GameplaySettings>; // deep-frozen
  readonly physics: PhysicsStepClient;          // physics.md §5
  readonly state: SimState;                     // phase-scoped view: `curr` writable only for owned entities in `transform` (C29-5)
  readonly intents: IntentSet;                  // committed-so-far intents (§14.5); any phase module may read it (C34-1)
  emit(intent: BehaviorIntent): void;           // commit one validated intent (§14.4); any phase module may call it (C34-1)
}
```

> **C34-1 (accepted with diff, Gate I):** `StepContext` additively carries
> `readonly intents: IntentSet` (the frozen committed-so-far view) and
> `emit(intent)`, which §14.3/§14.4/§14.5 require: behavior modules commit
> validated intents, and later phases (the controller reads `intents`, §14.5)
> consume them. Any phase module may read `intents`; `emit` is bound to the
> calling module and is rejected outside its registration and phase rules.

The context object is frozen; attempting to write a context field is a
`module_error` (`reason: "phase_violation"`).

### 12.3 Transform ownership and duplicate-writer rejection


- **One owner per character transform.** The character's `curr` transform is
  written only by `thirdlight.platformer:controller` in the `transform` phase,
  and only `position.x`/`position.y`; `position.z`, `rotation` and `scale` are
  never written (physics.md §2).
- The `intent` phase commits a **validated intent**; the `controller` phase
  commits a **movement request**; the `transform` phase commits the **result**
  the port returned for that step. The result is authoritative because it is
  what collided, and the runtime writes it before any phase-`transform` module
  runs — the character cannot be moved twice in one step.
- **Exactly one camera writer (M3).** The M3 gameplay camera entity's `curr`
  `position.x`/`position.y` is written only by the single `camera`-phase module
  in the `camera` phase; `position.z` (the authored view depth), `rotation` and
  `scale` are never written. The camera pose is published through §6's
  interpolation like any other transform. Editor navigation owns a different
  camera object and reads/writes no runtime state (`gameplay.md` §7.6).
- The read-only interpolation (runtime.md §6) is the only consumer-side math;
  the adapter copies interpolated values into `Object3D`s and performs no other
  transform computation.
- **Animation roles write no transform.** The rigid-role controller
  (`presentation.md` §41.3.6) writes only mixer time and action weights; it never
  writes an entity transform, never applies root-motion translation to the
  entity holder, and never calls the physics port. The single transform owner
  table of §12.3 is unchanged, and the checkpoint activation material change
  (`checkpointActive`) touches a material instance, never a transform.
- No play → authoring write-back (runtime.md §4, unchanged): the snapshot stays
  deep-frozen and canonical.

### 12.4 Unsupported module combinations


At instantiate the runtime validates the selected module set in registration
order and fails with the table's code (no instance created, no port used).
Module-validation failures are `config_invalid`; the ownership/combination
failures use their own codes:

| Condition | Code | Reason |
|---|---|---|
| two selected modules claim the same entity ID | `transform_owner_conflict` | `entityId` |
| a module claims an entity that does not exist | `transform_owner_conflict` | `entityId` |
| a module claims the camera entity, in a **non-M3** set | `transform_owner_forbidden` | `camera` |
| a module claims a `collider`/`controller` entity without being the controller module | `transform_owner_forbidden` | `physics_entity` |
| an ID listed in a selected module's `excludes` is also selected | `module_combination_unsupported` | both IDs |
| `thirdlight.platformer:controller` selected without an injected port | `config_invalid` | `physics_port` |
| `thirdlight.platformer:controller` selected with a scene whose `controller` count is 0 | `config_invalid` | `controller_target` |
| an M2 module selected with a `schemaVersion` 1 snapshot | `config_invalid` | `scene_version` |
**M3 supersession (scoped).** For an M3-enabled set the camera row above is
replaced by `gameplay.md` §3.4's validation: the set must contain exactly one
`camera`-phase module whose `transformOwners` is exactly `[cameraId]`
(`config_invalid`, `reason: "camera_owner"`, `detail` `missing` / `multiple` /
`owner_mismatch`); at most one `gameplay`-phase module
(`config_invalid`, `reason: "gameplay_module"`); a v3 requirement
(`config_invalid`, `reason: "scene_version"`); `game !== null`
(`config_invalid`, `reason: "game_config"`); and a `cameraFollow` component on
the camera entity (`config_invalid`, `reason: "camera_follow"`). Every other row
of this table is unchanged for M3 sets, including
"a module claims a `collider`/`controller` entity without being the controller
module".

A scene with **more than one** `controller` entity never reaches this table: it
fails snapshot validation first as `snapshot_invalid` (`reason:
"scene_validation"`, first project-model error `controller_count_invalid`,
project-model §21.1). Only the zero-controller case is a runtime
`config_invalid`/`controller_target`.

`thirdlight.demo:box-motion` + `thirdlight.platformer:controller` is therefore
**rejected**, which is the recorded form of "the M1 box-motion demo cannot also
control the character": M2 has no defined semantics for a scripted transform
driver and a physics-driven controller in one simulation.

### 12.5 The input port and per-step sampling


#### 12.5.1 One frame per executed fixed step

The runtime calls `ActionSource.sample(stepIndex)` **exactly once per executed
fixed step**, before any module phase of that step, and passes the returned
frame to every phase of that step (`diffs/runtime.md`, §5.1 phase order). Because
`stepIndex` advances only for executed steps (runtime.md §5.3) and each index is
executed at most once in a runtime instance:

- a frame is never sampled twice;
- a dropped wall-time interval produces **no** frames, no steps and no module
  calls — there is nothing to replay (see `fixtures/m2/contracts/runtime/catchup.json`);
- catch-up can therefore never multiply a jump edge.
- **Menu controls are not action frames (packet 42).** Host-level menu actions
  (`menuConfirm`, mute) are consumed by `game-host` as a separate bounded
  semantic channel (`delivery.md` §4.1); they never enter `ActionFrame` and never
  reach `ActionSource.sample`. A consumed menu press requires a release before it
  can become a jump (`delivery.md` §4.2), and the exclusive test-input mode
  suppresses the physical menu channel as well as the physical frames
  (`delivery.md` §4.4). The per-step sampling, press-latch and jump-phase rules of
  §12.5.1–§12.5.8 are otherwise unchanged.

#### 12.5.2 Press latch — exactly one edge per executed step

A physical tap can begin and end between two samples. The binding therefore
keeps one boolean `downLatch` per jump control source:

1. a keydown / button-down transition observed since the previous sample sets
   `downLatch = true` (a keyup does **not** clear it);
2. at `sample(n)` the observed down state is `downNow || downLatch`;
3. the latch is cleared **after** that sample is produced, in the same call.

Consequences (normative, and asserted by fixtures):

- a tap shorter than one fixed step produces exactly one `pressed` frame, at the
  first executed step after the tap;
- one physical press can never produce two `pressed` frames;
- the latch is not a queue: at most one pending edge per source exists, and a
  second tap before the next executed step coalesces into the same single
  `pressed`;
- a `pressed` frame received while the previous frame was also
  `pressed`/`held`-down cannot occur from the binding — the frame sequence from
  one source is always a valid phase chain (`none → pressed → held* → released
  → none`), and a malformed chain is rejected in replay (§6).

Keyboard auto-repeat (`event.repeat === true`) never creates a latch: repeat
events are ignored.

#### 12.5.3 Quantization

`moveX` is emitted as `Math.round(clamp(v, −1, 1) · 1e4) / 1e4`, so every
frame round-trips exactly through JSON and recorded traces compare bit-exactly.
`Math.round` rounds half toward `+∞` (the runtime's `quantizeMove`
implementation); it is **not** half-away-from-zero, and exact negative half-way
ties therefore resolve toward `+∞`. Negative zero is normalized to `0`.
Digital sources emit exactly `−1`, `0` or `1`.

#### 12.5.4 Device binding (package `input`)

**Mapping (M2 defaults, normative).** Only these mappings exist in M2:

| Source | Move left | Move right | Jump |
|---|---|---|---|
| Keyboard | `KeyA` or `ArrowLeft` | `KeyD` or `ArrowRight` | `Space` |
| Standard gamepad (`mapping === 'standard'`) | left stick axis 0 < 0, D-pad button 14 | axis 0 > 0, D-pad button 15 | primary face button (button 0) |

A gamepad whose `mapping` is not `'standard'` is **ignored** and reported once
as `input_mapping_unsupported` (device id clipped to 64 log-safe chars); there
is no remapping UI and no user mapping file in M2. Pointer, mouse, touch,
`Gamepad.hapticActuators` and non-standard axes are out of scope.

**Gamepad dead zone and rescaling.** Radial dead zone
`GAMEPAD_DEAD_ZONE = 0.2` applied to axis 0:

```text
a = |axis0|
if a <= 0.2:        stick = 0
else:               stick = sign(axis0) · (a − 0.2) / (1 − 0.2)
```

The result is clamped to `[−1, 1]` and quantized per §12.5.3. D-pad presses emit
exactly `±1` (no ramp). A trigger/axis below the dead zone contributes nothing.

**Simultaneous-source arbitration (deterministic, no summation).** Per step,
from the currently held sources:

1. **Digital first:** if exactly one keyboard move key is held, `moveX` is its
exact `−1`/`1`; if both `KeyA` and `KeyD` (or both arrows) are held, the two
keys **cancel each other and contribute nothing** (`+1` and `−1` are never
summed into `2`), so the D-pad and stick precedence below still apply.
2. Else if a D-pad button is held, `moveX` is its exact `±1` (both held ⇒ no
D-pad contribution).
3. Else `moveX` is the rescaled stick value of the active gamepad (§12.5.4).
4. Else `moveX = 0`.

Keyboard beats D-pad beats stick; that fixed precedence is the whole rule — the
binding never sums or averages sources, so `moveX` can never leave `[−1, 1]`.
Jump is the **logical OR** of the mapped controls across the active sources
(down if any is down); the phase chain is computed once, on that OR, so two
simultaneous sources still produce one edge.

**Active gamepad.** The active gamepad is the connected standard-mapped pad with
the **lowest `index`** that shows any control above the dead zone (or a pressed
button) during the polling window. While a pad is active it stays active until
it is disconnected (§12.5.7) or another lower-index standard pad becomes active.
Exactly one pad contributes to a frame. A change of the active pad is a fresh
activation (§12.5.6/§12.5.7): it must not produce a phantom `pressed`.

#### 12.5.5 Text-field suppression and default browser actions

**Text-field suppression (keyboard only).** While the runtime owns the input,
keyboard events whose target is an editable element (`input`, `textarea`,
`select`, or an element with `isContentEditable === true`) are ignored: no held
state, no latch, no diagnostic. Editable targets are detected per event from
`event.target` (the binding must not read `document.activeElement` inside a
`keydown` handler to decide suppression). While suppressed, the mapped keys must
not `preventDefault` typing. Gamepad input is **not** suppressed by text fields
(a gamepad cannot type); this is a recorded, deliberate M2 decision, not an
oversight.

**Ownership of default browser actions.** While attached and `running`, the
binding calls `preventDefault()` on the mapped jump keys so that `Space`/arrows
do not scroll the page. It never captures keys that are not mapped, and never
attaches a global `keydown` capture that swallows editor shortcuts (the
attachment is scoped to the play host element plus `window` for release events,
and the binding is detached on `stop`/`dispose`).

#### 12.5.6 Suspension and fresh activation

All four events — `window.blur`, `document.visibilityState !== 'visible'`,
`pagehide`, and `window` losing the play host — put the binding into
`suspended` state:

1. every held state is cleared, every latch is discarded, and the jump control
is forced up;
2. the next executed step receives a **neutral frame**;
3. every mapped control enters **`awaitingRelease`**: while a control is
`awaitingRelease`, a physically down control yields `held` — never `pressed` —
and the state returns to normal only after the control is observed up once;
4. a diagnostic counter is incremented (`inputSuspendCount`), and
`inputActivateCount` on resume; both are diagnostics-only (no error).

**Fresh activation after resume (normative).** No jump edge can be produced from
state that existed before a suspension. A new jump therefore requires a real
up→down transition observed after resume. This is the observable rule behind
"fresh activation after resume" and it is what the pre-resume `awaitingRelease`
state implements. A tap that begins and ends **entirely inside** an
`awaitingRelease` window is dropped: its latch is discarded and no later edge is
produced (the binding keeps no latent edge, C30-6).

#### 12.5.7 Hot disconnect and unavailable API

**Hot disconnect.** `gamepaddisconnected` for the active pad: its held state and
latch are cleared, its controls enter `awaitingRelease` (§12.5.6 item 3), the
next frame is neutral for that pad's contribution, and `inputDisconnectCount` is
incremented. Another connected standard pad may become active under §12.5.4,
subject to the same `awaitingRelease` rule (no phantom `pressed` from a button
that was already down). Connection and disconnection must work without
restarting play.

**Unavailable or denied API.** If `navigator.getGamepads` is missing, throws, or
returns an empty list because the context is not secure / the `gamepad`
Permissions-Policy is denied, the binding stays operational for keyboard and
reports `input_unavailable` (`reason: 'gamepad'`) once per attach. Keyboard-only
play remains available and no step is ever skipped; play must not fail because
no gamepad exists. The browser/secure-context/topology evidence is packet 14's
desktop procedure and packet 30/35's; this contract only fixes the
runtime-visible behavior.

#### 12.5.8 Attachment and disposal

`attachBrowserInput({ target, onDiagnostic })` returns an `ActionSource` whose
`dispose()` removes **every** listener and timer it installed and releases
retained `Gamepad` references; disposal is idempotent and safe before the first
sample and after suspension. The runtime never calls `dispose()` on a source it
does not own: the host that attached it disposes it (the runtime only reports
`tick`/lifecycle state). A source handed to `instantiateRuntime` must not have
been disposed; a disposed source is `input_source_invalid`.

### 12.6 The physics port and the physics-phase call


The concrete adapter implements this surface. The runtime owns the instance; a
module never receives it (`platformer.md` §4 uses the restricted client).

```ts
interface StaticColliderSpec {
  entityId: string;
  shape: ColliderShape;                  // validated component value
  position: { x: number; y: number };    // world XY (root + unit scale)
  rotationZ: number;                     // radians, derived from z,w (normalized copy)
}

interface PhysicsInitConfig {
  character: { x: number; y: number };   // authored world XY center of the controller entity
  statics: readonly StaticColliderSpec[]; // snapshot document order
  solver: { hz: 120; gravityY: number };  // gravityY from resolved settings
  controller: {
    offsetSkin: 0.01;
    groundSnap: 0.1;
    maxSlopeClimbRad: number;             // from settings
    minSlopeSlideRad: number;             // from settings
    autostep: false;
  };
}

interface CharacterMoveResult {
  requested: { x: number; y: number };    // meters, this step
  applied: { x: number; y: number };      // meters, this step
  position: { x: number; y: number };     // absolute world center after the move
  grounded: boolean;                      // from collision results / support normal (§8)
  supportNormal: { x: number; y: number };// unit; (0, 1) on flat ground
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;                       // any bounded ground-contact correction was applied this step (§12.6)
}

interface PhysicsPort {
  readonly implementation: string;        // exactly 'rapier2d-compat@0.20.0' for the M2 adapter
  stageCharacterMove(delta: { x: number; y: number }): void;
  step(): CharacterMoveResult;            // applies the staged move + world pipeline update
  reset(character: { x: number; y: number }): void;   // re-place the capsule (tests/diagnostics only)
  diagnostics(): PhysicsDiagnostics;
  dispose(): void;                        // idempotent; releases world + WASM instance
}

interface PhysicsStepClient {             // handed to modules in StepContext
  stageCharacterMove(entityId: string, delta: { x: number; y: number }): void;  // controller phase only
  characterResult(entityId: string): CharacterMoveResult | undefined;           // last completed step
}
```

/** M3 additions (`gameplay.md` §5.2). Callable by the runtime only, at the
 * reset barrier. Never exposed on `PhysicsStepClient` or `GameSessionPort`. */
interface CharacterClearanceResult {
  ok: boolean;
  reason?: 'blocked' | 'no_support' | 'out_of_bounds' | 'hazard' | 'query_failed';
  supportNormal?: Vec2;
  penetration?: number;              // m, deepest overlap with a static collider
}
interface PhysicsResetPort extends PhysicsPort {
  clearCharacterMotion(): void;                     // zero cached/kinematic motion
  placeCharacter(center: Vec2): CharacterClearanceResult;   // re-place + report
  characterClearance(center: Vec2): CharacterClearanceResult; // query only
}
Rules (normative):

- **One mutation path.** The runtime holds the `PhysicsPort`; modules get the
  `PhysicsStepClient`. `stageCharacterMove` is callable **only during the
  `controller` phase** of the current step; from any other phase it throws
  (fail-stop `module_error`, `reason: "phase_violation"`). The runtime clears
  the staged delta at the start of every step and calls `port.step()` **exactly
  once** per executed step in phase 3.
- **Result validation.** After `port.step()` the runtime validates the result
  strictly: all components finite; `supportNormal` unit within `1e-6`;
  `grounded ⇒ supportNormal.y > 0`; `applied == position − previousPosition`
  within `1e-9`; `|applied| ≤ |requested| + (snapped ? 0.11 : 0.001)` m. A
  violation is `physics_port_error` → fail-stop. A port that returns an
  undefined/invalid result is never partially applied. `snapped` is the flag
  for **any bounded ground-contact correction** the adapter applied this step,
  in either direction, up to `snap + skin` (`0.1 + 0.01 = 0.11` m) — not only
  a downward snap and not a 1 mm allowance. The real `0.20.0` adapter's
  one-time ~11.3 mm ground-offset push-out is such a correction (packet-31
  C31-2) and is accepted; a correction beyond `snap + skin` is refused by the
  adapter (`collision_correction_failed`) before the runtime ever sees it.
- **No Z.** No port method accepts or returns a Z value.
- **The diagnostic `reset()` is never a gameplay path (normative).** `reset`
  stays tests/diagnostics-only and **must not** be called by any module, the
  session, the camera, a behavior, the HUD, the editor or the exporter. Respawn
  uses the three restricted operations above under the runtime's reset
  transaction (`gameplay.md` §5); `characterClearance` mutates nothing, and the
  runtime performs R1–R3 of that transaction before the first mutation.
- **The character never moves while grounded by a downward command**
  (adapter guard kept from decision 0002 §1.2 item 3): the controller's
  grounded branch stages `y: 0`, so the adapter's degenerate-input path is not
  reachable through the contract; the adapter nevertheless keeps its guard
  (measured clean in packet 14 T12).

### 12.7 Determinism and replay tolerance with ports


`RecordedActionSource` (test/engine harness; `runtime` package):

```ts
createRecordedActionSource(frames: readonly ActionFrame[]): ActionSource
```

- construction validates every frame (§2), the strict ascent of `stepIndex`
  (strictly increasing; duplicates or regressions are
  `input_frame_invalid`), and the phase chain of the `jump` column (§3.2). The
  first frame may start at any index; every index without a frame yields the
  neutral frame (§2), which is exactly how the settle pre-roll (steps 0–11) is
  represented;
- `sample(n)` is a pure lookup; `reset(reason)` is a no-op for a recorded
  source (recorded sequences must not silently change on focus events);
- a recorded sequence is an **engine-level** fixture: it replays
  identically in the Node harness, the preview bundle and the export bundle.

**Replay tolerances (contract values, asserted by packet 29–36):**

| Comparison | Tolerance |
|---|---|
| same runtime build, same JS/WASM engine, same recorded frames | **exact** — every authoritative `position` component and controller state value bit-identical |
| same build, same engine, repeated process/browser session | ≤ `1e-6` m absolute per component (no cross-step drift accumulation allowed beyond this) |
| same pinned sources, different browser JS engine (preview vs export host, acceptance A22) | ≤ `1e-3` m absolute per component at every sampled step and on the final position |
| cross-platform bit-exactness | **not claimed** (WASM is deterministic per engine, not across engines) |

The tolerance applies to the *authoritative* step state, not to the read-only
interpolated render state (§6 of `runtime.md`, unchanged).


## 13. M2 fail-stop lifecycle


Runtime states become
`instantiated → running ⇄ stopped → disposed`, plus
`running | stopped → failed → disposed` (`failed` is terminal except for
`dispose`).

**Trigger.** Any of: a module `step` or `reset` throws (any phase); a
reset-barrier failure with the codes `game_spawn_invalid` / `game_spawn_blocked`
(`gameplay.md` §5.4); the injected port
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
4a. `getGameView()` keeps returning the last committed view with
   `failed: true` and `failure: { code, reason?, stepIndex }`; the run state is
   frozen at its last committed value, no run event is appended, and a death is
   never fabricated from a failure (`gameplay.md` §5.4/§6).
   completed step's authoritative state with `alpha = 0` — **the last completed
   render state is retained**;
- **Presentation survival across fail-stop.** A failed runtime's last committed
  state (including the retained `checkpointActive` bit) stays renderable; the
  host keeps its adapter resources until it disposes them itself. A runtime
  `dispose()`/`stop()` disposes **no** shared visual or audio resource and does
  not close a `PreparedVisualResource` or `AudioContext` it does not own. A new
  runtime for the same snapshot re-uses the host's resources; disposal ordering
  is the host's (`presentation.md` §41.6 rules 4–6).
5. `start()` and `tick()` return `{ ok: false, error: { code: 'runtime_failed' } }`;
   `stop()` from `failed` returns `{ ok: true }` (there is no driver);
6. `dispose()` from `failed` returns `{ ok: true }` and calls `dispose()`
   **exactly once** on every module instance (including the failed one) and on
   the port.

**No rollback (normative).** The runtime never attempts a transform-only
rollback of a half-mutated world (including a reset that failed after
`clearCharacterMotion()` or `placeCharacter()` mutated the private world: the
failed position is left as it is, unreported as a death and never resumed —
`gameplay.md` §5.4): physics/private module state (WASM world,
controller velocity/window state, script state) cannot be reconstructed from
`prev`/`curr`. `failed` exists precisely so the runtime does not continue with
a half-mutated world. **Safe restart is the only recovery:** `dispose()` the
failed instance, create fresh module instances and a fresh port, and
`instantiateRuntime` again from the same immutable snapshot.

**Scope of the rule.** M1 compatibility is preserved: a module set consisting
only of the M1 demo keeps the accepted runtime.md §5.1 no-op-on-throw behavior,
because that module has no private state. Fail-stop applies to every module set
that contains at least one M2 (stateful) module; the fixtures pin both.



| Class | Code / reason | Observable outcome | Durable effect |
|---|---|---|---|
| missing/undefined/invalid port at instantiate | `config_invalid` (`reason: "physics_port"`) | `instantiateRuntime` → `{ ok: false }`; no instance, no world | none |
| WASM/CSP/init failure | `physics_init_failed` from `createPhysicsPort` | host reports an actionable unavailable state; no fallback engine, no transform-only motion | none |
| init cancelled | `physics_init_cancelled` | allocator released; a later init succeeds; no port escapes | none |
| port throws during `step()` | `physics_port_error` → **fail-stop** | simulation fails at that step; last completed render state retained; private world state is **not** rolled back | none (snapshot untouched) |
| port returns a malformed result | `physics_port_error` (`reason: "result"`) → **fail-stop** | as above; the invalid result is never partially applied | none |
| `stageCharacterMove` outside the controller phase | `module_error` (`reason: "phase_violation"`) → **fail-stop** | as above | none |
| unsupported authored transform | model `physics_transform_unsupported` | play does not start: snapshot validation fails (`snapshot_invalid` → scene errors) | none |
| undetected tunnelling | cannot occur silently: `maxPenetration` is asserted by fixtures; a penetration beyond `0.005` m fails acceptance | — | — |


## 14. Behavior execution boundary, intent API and bounded diagnostics

### 14.1 The trust boundary and its limitations


Behaviors are **trusted personal project code**, in the same trust class as the
project owner's own editor. Execution happens:

- in the **separate-origin preview's main JavaScript context**
  (`sessions.md` §13.1) and in the **standalone game's main context**; and
- on the **same thread** as the renderer and the runtime's fixed-step loop
  (`runtime.md` §5, `platformer.md` §2.1) — there is no worker, no process
  boundary and no isolation frame.

The trust decision recorded here is: **the project owner is the author and the
only runtime operator of the code they publish.** It is a personal-project
boundary, exactly as `m2-plan.md` §3.5 and the packet-18 acceptance record.

#### 14.1.1 What the restrictions are, and what they are not

The API surface restrictions (§9), the static import/source checks (§4), the
output-content scan (§5.5) and the preview CSP are **defense in depth**: they
stop the *accidental* and *structural* mistakes this contract enumerates
(importing `node:fs`, fetching a URL, dynamic `eval`, a graph cycle, an
out-of-range property). They are **not** a hostile-JavaScript sandbox.

Normative limitations (no claim to the contrary may be made by any packet, UI
string, handoff or acceptance record):

1. **No hard runtime timeout exists.** A same-thread infinite loop
   (`while (true) {}`) cannot be reliably interrupted. No watchdog timer, no
   iframe removal, no renderer teardown, no Stop button and no `dispose()` call
   is claimed to preempt it. A hung behavior hangs the play tab until the user
   closes it; the backend record is unaffected (`sessions.md` §13.6's orphan
   bound).
2. **No hostile-code sandbox exists.** A behavior can reach any global
   available in its game origin (`window`, `document`, `fetch`,
   `XMLHttpRequest`, `WebSocket`, `Worker`, storage, `console`) and can call
   them directly. The output scan of §5.5 is a text check, trivially bypassable
   by design, and is specified as such.
3. **Scripts observe their origin's globals**, including anything the preview
   page itself exposes. The preview page must therefore expose nothing
   sensitive: **no authoring credentials, no authoring token, no `/api/v1`
   access, no project filesystem handle** ever enters the preview
   (`sessions.md` §13.2, packet 19's bounded read-only content locator).
4. **Static analysis is bounded and non-authoritative.** `compileBehavior`
   reads bytes and parses them; it never executes, requires, imports or
   evaluates them (§5.4). A behavior can construct a forbidden capability at
   runtime from strings; the contract does not claim otherwise.
5. **No state-preserving hot reload.** A code edit requires a new publication
   **and** a fresh play instance (§8.6); the runtime never swaps code into a
   running instance (`runtime.md` §10).

### 14.2 The acknowledgment gate and the separate-packet clause


Because §2.1 makes execution an explicit owner trust decision, **first execution
requires a durable, explicit acknowledgment of the exact source digest**:

1. The owner acknowledgment is project state: `content.behaviorTrust.entries[]`
   (§7), written only by the `acknowledgeBehaviorTrust` command — never by a
   direct write, never as a side effect of staging, compiling or playing.
2. The UI (packet 34) must present the normative notice text before offering the
   acknowledgment: it states §2.2's three limitations verbatim enough that a
   reader learns (a) no hard timeout, (b) no hostile-code sandbox, (c) scripts
   see their game origin's globals / credentials never enter the preview.
3. A `source`-bearing behavior whose exact `sourceDigest` is not acknowledged
   **cannot be published** (§8.4) and **cannot be compiled or linked for
   play/export** (§8.7) — `behavior_trust_unacknowledged` (`reason: "digest"`).
4. An acknowledgment binds one digest. A source change produces a new digest and
   therefore requires a new acknowledgment (no "trust this behavior forever").

#### 14.2.1 If a hard boundary is required

If hard preemption, worker isolation, memory/CPU quotas or hostile-code
containment are required, **stop here**: do not smuggle a worker scheduler,
an `eval`-based interpreter or a process supervisor into packets 33–36. Request a
separate **execution-boundary design packet** (a worker/process execution
contract with its own scheduling, transferable-state, determinism and failure
rules) and let this contract stay the trusted-main-thread boundary. Packet 18's
recorded disposition is exactly this: trusted main thread, limitations stated,
owner acceptance required.

---

### 14.3 The `BehaviorSpec` lifecycle and per-instance private state


The authored source's `export default` is the behavior program:

```ts
export default {
  prepare(cfg: BehaviorPrepareConfig): unknown;          // once per runtime instance
  instantiate(prepared: unknown, inst: BehaviorInstanceInfo): unknown; // once per instance
  step(state: unknown, ctx: BehaviorStepContext): void;  // once per instance per step
  dispose(prepared: unknown, state: unknown): void;      // once per instance, ≤ once
};
```

```ts
interface BehaviorPrepareConfig {
  readonly behaviorId: string;
  readonly sourceDigest: string;               // the binding this spec was loaded from
  readonly declaration: { readonly properties: readonly DeclaredProperty[] }; // frozen
  readonly enginePins: readonly PinnedModuleRef[]; // frozen, as compiled
}
interface BehaviorInstanceInfo {
  readonly entityId: string;                   // the entity carrying components.behavior
  readonly properties: Readonly<Record<string, PropertyValue>>; // frozen, declaration order
}
interface BehaviorStepContext {
  readonly behaviorId: string;
  readonly entityId: string;
  readonly stepIndex: number;
  readonly phase: 'intent' | 'transform';
  readonly properties: Readonly<Record<string, PropertyValue>>; // frozen, same object as instantiate
  readonly action: ActionFrame;                // the sampled frame — identical in every phase
  readonly intents: IntentSet;                 // read-only, committed so far (this step)
  readonly settings: Readonly<GameplaySettings>; // frozen, packet 17 §10
  readonly physics: PhysicsStepClient;         // packet 17's restricted client
  emit(intent: BehaviorIntent): void;          // §9.3/§9.4 — validated
  log(level: 'info' | 'warn' | 'error', message: string): void; // §10, bounded
}
```

No other global is provided; nothing in the API can persist an authoring edit,
call a workspace/backend service, mutate the physics world, spawn or delete an
entity, reparent, or read a file (§9.7).

#### 14.3.1 Lifecycle (exact)

| Stage | Called | May return/do | Bounds |
|---|---|---|---|
| **prepare** | once per runtime instance, during module `create`, before any step | initialize the program (module-level tables); must not read `ctx`, must not emit, must not log | pure with respect to runtime state; a throw is `config_invalid` (`reason: "behavior_prepare_failed"`), no instance created |
| **instantiate** | once per (behavior module, entity carrying that behavior) pair, after ownership validation | build per-instance private state from `inst.properties` | a throw is `config_invalid` (`reason: "behavior_instantiate_failed"`); **all** already-created instances are disposed and no runtime instance is created |
| **step** | exactly once per declared phase per executed fixed step, in registration order and snapshot document order | read `ctx`, `emit` intents, read `ctx.physics.characterResult` | must return `undefined` synchronously — a thenable/`Promise` return is `module_error` (`reason: "behavior_step_async"`) → fail-stop; a throw is `module_error` (`reason: "behavior_step_failed"`) → packet 17 §9's fail-stop (no rollback, safe restart only); `emit` caps per §10 |
| **dispose** | once per created instance, on `dispose()` of the runtime, including from `failed` | release private state | idempotent; the runtime calls it exactly once and ignores throws after recording one bounded diagnostic entry; a disposed instance is never stepped again |

- The runtime never calls `step` for a phase the module did not declare, and
  never calls a stage out of order.
- Private state is **per instance**: two entities carrying the same behavior have
  independent state; nothing is shared except what `prepare` returned, which the
  runtime treats as read-only and which implementations must not mutate during a
  step (mutation of `prepared` is a `module_error`, `reason:
  "behavior_state_shared"` — detected by the frozen preparation object).
- **No module-level mutable singleton** may carry state between runtime instances
  (`dependencies.md` §4.3): each runtime instance gets a fresh module instance
  from `create`, and `prepare` runs again. There is no persistence: a fresh play
  instance starts from step 0 with the authored properties.

### 14.4 Intent shapes, validation order and fail-stop reasons


```ts
type IntentKind = 'control_move' | 'control_jump' | 'transform';

interface ControlMoveIntent { kind: 'control_move'; value: number; }        // −1 ≤ v ≤ 1
interface ControlJumpIntent { kind: 'control_jump'; value: JumpPhase; }     // input.md §2
interface TransformIntent {
  kind: 'transform';
  entityId: string;                       // must be in this module's ownedTransforms
  position: { x?: number; y?: number; z?: number };  // ≥ 1 axis; finite; |v| ≤ 1e6
}
type BehaviorIntent = ControlMoveIntent | ControlJumpIntent | TransformIntent;
```

Canonical key order: `kind, value` / `kind, value` / `kind, entityId, position`;
`position` in `x, y, z` order (present axes only). Unknown fields are invalid.

**Validation order (exhaustive, each failure is fail-stop `module_error`):**

1. **shape** — a non-object, unknown `kind`, unknown field, wrong field type
   ⇒ `reason: "behavior_intent_invalid"`, `detail: "shape"`.
2. **phase** — `control_*` outside the `intent` phase, `transform` outside the
   `transform` phase ⇒ `reason: "behavior_intent_invalid"`, `detail: "phase"`.
   (The write guard, `platformer.md` §2.2, already makes a transform write
   outside its phase throw; this is the API's own check.)
3. **value** — `control_move` not finite or outside `[−1, 1]`; `control_jump`
   not one of the four `JumpPhase` values; `transform.position` empty, a
   non-finite value, `|v| > 1e6`, or an axis name outside `x|y|z`
   ⇒ `reason: "behavior_intent_invalid"`, `detail: "value"`.
4. **ownership** — `transform.entityId` not in the module's `ownedTransforms`
   ⇒ `reason: "behavior_transform_forbidden"`, `detail: "not_owner"`.
5. **duplicate** — this instance already committed the same channel
   (`control_move`, `control_jump`, or the same `(entityId, axis)`) **in this
   step** ⇒ `reason: "behavior_intent_conflict"`, `detail: "duplicate_intent"`.
6. **multiple writers** — another module already committed that control channel
   in this step ⇒ `reason: "behavior_intent_conflict"`, `detail:
   "duplicate_writer"`, and the fail-stop entry carries
   `writers: [committedBy, attemptedBy]` (the module ID that committed the
   channel first and the module ID that attempted the second write; **C34-7**
   accepted with diff, Gate I — the bounded message also names both IDs). No
   last-writer-wins: two writers of one control channel are a contract error,
   not a merge.
7. **caps** — per-instance or per-step bound exceeded (§10) ⇒ `reason:
   "behavior_intent_limit"`, `detail: "per_instance" | "per_step"`.

Quantization (matching §12.5.3): an accepted `control_move` value is
committed as `round(clamp(v, −1, 1) · 1e4)/1e4` with `−0 → 0`; the *stored*
intent is the quantized value, and a value already inside `[−1,1]` is otherwise
unmodified. `control_jump` is not quantized (a phase, not a number).

### 14.5 `IntentSet`, deterministic ordering and the effective-input rule


```ts
interface IntentSet {
  readonly stepIndex: number;
  readonly move: number | null;        // committed control_move (quantized) or null
  readonly jump: JumpPhase | null;     // committed control_jump or null
  readonly moveWriter: string | null;  // module ID that committed it
  readonly jumpWriter: string | null;
  readonly transformWrites: readonly { moduleId: string; entityId: string;
    position: { x?: number; y?: number; z?: number } }[]; // commit order
}
```

- The runtime clears the set at the start of every fixed step and freezes the
  committed entries; in the `intent` phase a module sees only what earlier
  modules committed (registration order), and in later phases the full set.
- **Effective input (normative):** for step `n`, the controller phase's input is
  `effective = { stepIndex: n, moveX: intents.move ?? action.moveX, jump:
  intents.jump ?? action.jump }`. Packet 17's `platformer.md` §7 step algorithm
  applies unchanged to `effective`. `ctx.action` stays the **sampled** frame in
  every phase (`platformer.md` §3's "identical for every phase" is preserved).
  **C34-3 (accepted with diff, Gate I):** the effective-input source is
  `StepContext.intents` (C34-1) — the platformer controller reads
  `ctx.intents.move ?? ctx.action.moveX` / `ctx.intents.jump ?? ctx.action.jump`
  in its `controller` phase. This is implemented in `@thirdlight/platformer`
  (packet 32) and is the rule packet 34 recorded as C34-3 and packet 35's
  composition relies on; no runtime-side substitution is performed, so
  `ctx.action` remains the sampled frame everywhere.
- **M3 effective-frame overrides (additive).** Two M3-only rules narrow the
  effective frame without touching `ActionFrame`, the sampling rule or the
  latch: (1) while the run is `awaitingStart`, `respawning` or `won` the
  effective frame is neutral (`moveX: 0`, `jump: 'none'`) even though the frame
  is still sampled exactly once; (2) the first `playing` step after a run-start,
  respawn or replay boundary forces the effective `jump` column to `'none'`.
  Both are pure functions of the committed run state and are replayed
  identically by a recorded source (`gameplay.md` §2.5).
- **With an empty `IntentSet` the packet-17 algorithm is bit-identical**, so the
  178 pinned trace rows (`platformer/traces.json`) remain the normative
  expectation for any module set that emits no intents. This is the recorded
  compatibility condition for the change (`diffs/runtime.md` R23/R30).

### 14.6 Non-physics transform ownership and its write-guard reasons


- A behavior's `ownedTransforms` is declared in the **source container** as
  `ownedTransforms: string[]` (ascending, unique, ≤ 16) — see
  `diffs/project-model.md` P18-A7 for the container field and packet 16 for the
  record.
- An owner must be an entity that (a) exists, (b) carries
  `components.behavior` for **this** `behaviorId`, (c) is **not** the single
  camera entity, and (d) carries **no** `components.collider`/`components.
  controller`. A violation is `transform_owner_forbidden`
  (`reason: "behavior_ownership_forbidden"`, `detail: "camera" |
  "physics_entity" | "not_behavior_entity"`); a collision with another module's
  owner keeps packet 17's `transform_owner_conflict`.
- A transform intent writes **only** `position.x|y|z` of an owned entity, in the
  `transform` phase, after the runtime committed any staged physics result
  (`platformer.md` §2.1 item 5). Rotation and scale are **not** writable in M2;
  `position.z` is writable because the 2.5D convention keeps Z authored-only
  for physics entities — a behavior-owned entity is never physics-bearing
  (`physics.md` §2).
- Two writes to the same `(entityId, axis)` in one step are rejected (§9.4 item
  5), so one step has at most one writer per axis: the transform is a pure
  function of (committed writes, order).

### 14.7 What a behavior cannot do


A behavior **cannot**: persist an authoring edit or call any authoring/workspace/
backend service; reach `runCommand` or a mutation path; mutate the physics world
or stage a character move (`stageCharacterMove` requires the `controller` phase
and no behavior declares it); add, remove or reparent an entity; change a
component, the camera, rotation or scale; read a file, the staging area or a
project path; make an engine fetch (the output scan forbids `fetch(`/
`XMLHttpRequest`/`WebSocket`, §5.5); depend on `three`, `three-adapter`, `editor`,
`react`, `mcp-adapter`, `backend`, `workspace`, `commands` or `protocol` (bundle
and node-side edges, `diffs/dependencies.md`); or create a second scene-mutation
path (charter §6, `dependencies.md` §4.3).

---

### 14.8 Intent/log bounds, the per-instance ring and diagnostics fields


Separate from the compiler bounds (§6). Exceeding an intent cap is a **fail-stop**
(`module_error` + `behavior_intent_limit`); the log caps bound payload growth and
never stop the simulation.

| Bound | Value | Behaviour on exceed |
|---|---|---|
| accepted intents per instance per step | 5 (the closed maximum: `control_move` + `control_jump` + one write per owned entity axis; the duplicate rules already forbid more, so this bound is retained as defense in depth) | fail-stop (`per_instance`) |
| accepted intents per step (all instances) | 64 | fail-stop (`per_step`) |
| transform writes per owned entity per step | 3 (one per axis) | fail-stop (`duplicate_intent`) |
| `ctx.log` calls per **step** per instance accepted into the ring | 16 (`logDropped` counts the rest) | excess calls increment `logDropped` (counted, not stored); no fail-stop |
| `ctx.log` entry message length | 256 chars | truncated to 256 with `…`; the entry is still stored and counted |
| `ctx.log` entries retained per instance | 32 (a per-instance ring, last-32) | older entries are evicted; `logCount` is cumulative and the payload cannot grow |
| diagnostics retained by the runtime | 32 entries (`runtime.md` §8, unchanged) | `errorCount`/`logCount` are cumulative counters; the payload cannot grow |
| behavior modules per runtime instance | 64 (one per published behavior ≤ `properties.md`'s 64) | `config_invalid` (`reason: "behavior_modules"`) |

Rules: counters are cumulative and exposed in diagnostics §10.1; a log flood
cannot grow a diagnostics frame beyond the 32-entry ring (the same boundedness
argument as `runtime.md` §8). `console.*` called by behavior code is **not**
captured: it goes to the browser devtools console, is not part of diagnostics and
is explicitly out of contract (a developer surface, §2.2 item 2). A `step` throw
is handled by `platformer.md` §9 (one bounded `module_error` entry, fail-stop,
no rollback, safe restart only) — a throw flood is bounded by construction,
because the first throw stops the instance.

#### 14.8.1 Diagnostics additions (proposed)

`runtime.md` §8's diagnostics object gains:

```json
{ "intentCommitCount": 118, "logCount": 12, "logDropped": 0,
  "failedModuleId": "thirdlight.behavior:behavior-0002" }
```

`failedModuleId`/`failedPhase`/`failedStepIndex` are packet 17's sticky fields;
`failedModuleId` may now name a behavior module. Log entries that the runtime
records are `{ code: 'behavior_log', reason: level, moduleId, message ≤ 256 }`
counted in the same ring.

---


## 15. M3 game session: schedule, reset barrier, view and camera

Additive to §12 and entered only by an **M3-enabled** runtime — a set with at
least one selected module declaring `gameplay` or `camera`
(`gameplay.md` §3.1). The rule text (run states and transitions, the zone
predicate and its precedence, the reset transaction, the camera math, every
number, error code and fixture) is the sibling contract
[`gameplay.md`](gameplay.md); this section carries the runtime-shaped
interfaces and the runtime-side mechanics, and cross-references `gameplay.md`
for every number, so no number is stated twice.

### 15.0 Scope: M3-enabled runtime, additive to §12

`gameplay.md` §§1/3.1 define the run's ownership and the M3-enabled condition;
`gameplay.md` §3.5 states the M1/M2 invariance that this section must preserve:
without an M3 module there is no boundary hook, no run state, no viewport record
and no run surface, and the accepted per-step math is byte-for-byte unchanged.

### 15.1 Run state machine, queued effects and bounded respawn delay

Normative text: `gameplay.md` §2 (`RunState`, transitions T1–T8, the boundary
queues and `RESPAWN_DELAY_STEPS`). The run state is runtime-private data,
published only through §15.5's `GameView`; a boundary event is visible to every
phase of the step that follows it.

### 15.2 The M3 phase order and the step boundary

Normative text: `gameplay.md` §3.2 (phase 0 **boundary** → sample → intent →
controller → physics → transform → **gameplay** → **camera** → phase 8
**commit**, per executed step). §12.1's `SIMULATION_PHASE_ORDER` gains
`gameplay`/`camera` as appended values, and the boundary hook consumes a due
reset **before** the standard `prev := curr` promotion, which is what makes a
reset produce `prev == curr` by construction.

### 15.3 `StepContext.gameplay`, `GameSessionPort` and `ModuleResetContext`

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
M3-enabled). The frozen projection the port exposes is `gameplay.md` §4.1:

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
  readonly game: Readonly<GameConfig>;         // packet 39 PROPOSED model.md §23.4
  readonly zones: readonly GameZoneSpec[];     // ascending `entityId` codepoint order
  readonly spawns: readonly { entityId: string; center: Vec2 }[];
  readonly player: { entityId: string };
  readonly camera: { entityId: string; deadZone: Vec2; smoothing: number; bounds: Bounds };
}
interface ViewportInfo { readonly width: number; readonly height: number; readonly aspect: number }
```

`SimulationPhaseModule` gains the optional runtime-called reset hook of
`gameplay.md` §5.1 R6:

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

### 15.4 The reset transaction and the restricted physics operations

Normative text: `gameplay.md` §5.1 (steps R1–R8; R1–R3 are pure reads, R4 is
the first mutation) and §5.3 (the coherence table). The concrete port gains the
three restricted operations of `gameplay.md` §5.2, callable by the runtime only
at the reset barrier:

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

### 15.5 The committed `GameView` and the run surface

Normative text: `gameplay.md` §6 (publication, freshness, identity/staleness,
the `MAX_GAME_EVENTS` bound and the presentation-ownership rules).

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

`playerMotion` is the Gate K repair **K-2/FU-4** (C41-1 resolved): it is derived
at phase 8 and at every reset boundary from the last **completed** step's
`lastMotionSegment(playerId)` (§3.3 item 0) and the controller's committed
grounding. It adds **no runtime state, no counter, no second writer and no
second simulation**, is never written back into the run, and is exactly
`{ speed: 0, grounded: true }` in `awaitingStart` and `won`. §2's snapshot
shape is unchanged: this is a `GameView` field, not a snapshot field. The role
selector (`presentation.md` §41.3.6) reads the view, never the runtime-private
motion segment.

The three runtime calls of `gameplay.md` §6.1:

```ts
interface Runtime {
  // ... accepted calls unchanged ...
  getGameView(): { ok: true; view: GameView } | { ok: false; error: RuntimeError };
  gameCommand(cmd: 'start' | 'replay'): { ok: true } | { ok: false; error: RuntimeError };
  setViewport(width: number, height: number): { ok: true } | { ok: false; error: RuntimeError };
}
```

### 15.6 Camera transform ownership and the viewport record

Normative text: `gameplay.md` §7 (projection convention, the follow/dead-zone/
smoothing math, the two-aspect frustum clamp, the hard snap and the
presentation-only resize). The camera entity's pose is published through §6's
interpolation like any other transform; the editor's navigation camera is a
different object that reads and writes no runtime state (`gameplay.md` §7.6).

### 15.7 Limits, error codes and diagnostics fields

Normative text: `gameplay.md` §8 (the five new runtime codes, the new reason
strings on accepted codes and the finite limits). The M3-only run counters
(`runState`/`runId`/`deathCount`/`checkpointId`/`gameEventCount`) are present
exactly when the set is M3-enabled and absent for M1/M2 sets (§8's frozen field
set is preserved).