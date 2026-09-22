PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/runtime.md`

**PROPOSED — pending Gate E.** Packet 17 (`docs/planning/m2-packets.md` §17)
output. This file contains *no* accepted text: it names the exact destination
sections of `docs/contracts/runtime.md`, gives `OLD → NEW` text for every
existing section that changes, and gives insertion instructions (anchor +
normative text source) for new material.

Read with: [`../platformer.md`](../platformer.md) (phases, controller, fail-stop),
[`../input.md`](../input.md) (ActionFrame, sampling, replay),
[`../physics.md`](../physics.md) (port, shapes, tolerances), and
[`project-model.md`](project-model.md) §"Packet 17 additions" (components,
settings). Promotion is docs-only, per diff, at Gate E; nothing here is applied
by packet 17.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

**Physics selection: `@dimforge/rapier2d-compat` at exactly 0.20.0, kinematic
character controller — selection per decision 0002 §1, owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending.**
PROVISIONAL until packet 14's desktop evidence and Gate E accept it; the pin
enters the lockfile only at packet 31.

Convention: `OLD` is the accepted text exactly as it reads today (shortest
unique quote); `NEW` is the replacement. `+` blocks are pure insertions at the
stated anchor. Accepted section numbers are **never renumbered**: new material
is appended as §12/§13 where a whole new section is needed. Cross-references
written `§n` inside promoted text refer to the new numbering.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| R1 | §1 "Scope and ownership" | insert bullets | this file |
| R2 | §3 "Lifecycle" (state line) | reword | this file |
| R3 | §3.1 "`instantiateRuntime(config)`" | insert config rows + validation + effect | [`../input.md`](../input.md) §1/§5.6, [`../physics.md`](../physics.md) §5, [`../platformer.md`](../platformer.md) §2.3/§3 |
| R4 | §3.2 "`start()`" | insert pre-roll bullet | [`../platformer.md`](../platformer.md) §6 |
| R5 | §3.5 "`tick(nowSeconds)`" | reword | this file |
| R6 | §4 "Mutable simulation state" | insert rules | [`../platformer.md`](../platformer.md) §2.2/§5 |
| R7 | §5 "Fixed steps with bounded catch-up" | insert rules | [`../input.md`](../input.md) §3, [`../platformer.md`](../platformer.md) §6 |
| R8 | §5.1 "Module step isolation" | reword (phases, ownership, fail-stop) | [`../platformer.md`](../platformer.md) §2/§9 |
| R9 | §5.2 "Why drops are safe in M1" | reword (M2 stateful rule) | this file |
| R10 | §6 "Render interpolation policy" | reword frame ordering | [`../platformer.md`](../platformer.md) §2.1/§8 |
| R11 | §7.2 "Module shape" | reword | [`../platformer.md`](../platformer.md) §2/§3 |
| R12 | §8 "Structured diagnostics" | insert fields + codes | this file, [`../input.md`](../input.md) §7, [`../physics.md`](../physics.md) §10 |
| R13 | §9 "Dependencies and environment" | insert port rule | [`../physics.md`](../physics.md) §5 |
| R14 | §10 "What is deliberately not in M1" | reword two bullets | this file |
| R15 | §11 "Change rules" | insert bullets | this file |
| R16 | §12 **(new)** "M2 module phases, ports and transform ownership" | insert section | [`../platformer.md`](../platformer.md) §§2–5, [`../input.md`](../input.md) §3, [`../physics.md`](../physics.md) §5 |
| R17 | §13 **(new)** "M2 fail-stop lifecycle" | insert section | [`../platformer.md`](../platformer.md) §9, [`../physics.md`](../physics.md) §10 |
| R18 | **cross-file** `dependencies.md` §3/§4.1/§4.2/§6 | change request (not applied here) | §D below |

Not changed: §2 (snapshot shape, immutability, provenance), §3.3 (`stop`),
§3.4 (`dispose`, extended only by R17's dispose-from-`failed`), §4's
`prev`/`curr` structure, §5's constants and arithmetic (`SIM_HZ = 120`,
`MAX_CATCHUP_STEPS = 8`, drop-and-resync), §6's interpolation math, §7's demo
math (§7.1 constants), §7.3, §8's error-entry shape, §10's other non-goals.

---

## B. Existing sections

### R1 — §1 "Scope and ownership": insert bullets

Anchor: after the bullet ending `- The **built-in moving-box demonstration** —
M1's only gameplay behavior — with its exact, deterministic math.`

```diff
+- The **M2 module phase model**: phase registration, the canonical phase order,
+  transform ownership and the write guard (new §12).
+- The **injected ports**: the input `ActionSource` and the physics `PhysicsPort`
+  the runtime owns and the host constructs.
+- The **M2 fail-stop lifecycle**: the `failed` state and what a failed
+  simulation may still render (new §13).
+- The **gameplay settings resolution** rule (values are validated by
+  project-model; the runtime consumes the resolved, frozen object).
```

### R2 — §3 "Lifecycle: instantiate / start / stop / dispose"

```diff
-States: `instantiated → running ⇄ stopped → disposed` (`disposed` is
-terminal; `running ⇄ stopped` may repeat).
+States: `instantiated → running ⇄ stopped → disposed` (`disposed` is
+terminal; `running ⇄ stopped` may repeat), plus `running | stopped → failed →
+disposed` for a runtime whose module set contains at least one M2 (stateful)
+module (§13). A runtime with only the M1 demo module cannot reach `failed`.
```

### R3 — §3.1 "`instantiateRuntime(config)`"

**(a) config table — insert rows after the `modules` row:**

```diff
+| `actions` | an `ActionSource` (`input.md` §1): the per-step input port. Strict shape, not a raw DOM/Gamepad object | a built-in source that always returns the neutral frame (M1 behavior preserved exactly) |
+| `physics` | an already-initialized `PhysicsPort` (`physics.md` §5). Required iff the selected module set contains a module whose spec requires one | absent (M1 sets require none) |
```

and reword the `modules` row:

```diff
-| `modules` | array of module IDs present in `registry`; unknown ID ⇒ `config_invalid` | `["thirdlight.demo:box-motion"]` (M1 default) |
+| `modules` | array of module IDs present in `registry`; unknown or duplicate ID ⇒ `config_invalid`; phase/ownership/exclusion validation per §12 | `["thirdlight.demo:box-motion"]` (M1 default) |
```

**(b) Effect — extend:**

```diff
-Effect: validate the snapshot (§2), deep-freeze it, build the initial
+Effect: validate the snapshot (§2), deep-freeze it, resolve the gameplay
+settings from `snapshot.scene`/the envelope's content block (`platformer.md`
+§10) and deep-freeze them, validate the module set's phases, exclusions and
+transform ownership (§12) — a violation returns `config_invalid` and creates
+nothing — then build the initial
 mutable state (§4) with `prev = curr = snapshot transforms`, `stepIndex 0`,
 `simTime 0`; create one module instance per `modules` entry (module
 `create`, dependencies.md §6). State becomes `instantiated`. **No loop,
 timer, listener, or renderer is installed** at instantiate.
```

### R4 — §3.2 "`start()`": insert one bullet

Anchor: after the bullet ending `...set the wall anchor on the first frame
(§5), state → \`running\`.`

```diff
+- **Settle pre-roll (M2 module sets).** Before the wall anchor is installed,
+  the first frame after `start()` executes exactly `SETTLE_PREROLL_STEPS = 12`
+  fixed steps with neutral action frames (`platformer.md` §6,
+  `physics.md` §9). The pre-roll consumes no wall time and is part of
+  initialization: `stepIndex` becomes 12, `simTime` becomes `0.1 s`, and the
+  first sampled action frame is at `stepIndex 12`. A module or port error
+  during the pre-roll is a normal fail-stop (§13). M1 module sets execute no
+  pre-roll.
```

### R5 — §3.5 "`tick(nowSeconds)`"

```diff
-Runs one frame update (§5) + `onFrame`. **Only for `driver.kind: "manual"`**
-(test harness); with the rAF driver ⇒ `tick_not_allowed` (a second loop
-source would double-step the simulation).
+Runs one frame update (§5) + `onFrame`. **Only for `driver.kind: "manual"`**
+(test harness); with the rAF driver ⇒ `tick_not_allowed` (a second loop
+source would double-step the simulation). On a `failed` runtime ⇒
+`runtime_failed` (§13): a failed simulation is never ticked again.
```

### R6 — §4 "Mutable simulation state (separate from the snapshot)"

Anchor: after the bullet ending `...M1 adds/removes no entities and changes no
other component value.`

```diff
+- **Phase-scoped mutability (M2).** `curr` is writable only during the
+  `transform` phase; in the `intent`, `controller` and `physics` phases the
+  runtime hands modules a throwing read-only view of `curr` (§12). Writing
+  outside the `transform` phase is a fail-stop module error, so a
+  half-mutated step cannot be committed.
+- **Private state is not in `state`.** The physics world, the controller's
+  velocity/window state and (packet 18) script state live inside their module
+  or port instances. They are deliberately **not** derivable from
+  `prev`/`curr`; that is why §13's failure path is safe restart, not rollback.
+- **Physics-bearing entity policy.** A module may write only the components it
+  owns: the controller writes the character's `position.x`/`position.y`; Z,
+  rotation and scale are never written (`physics.md` §2, `platformer.md` §5).
```

### R7 — §5 "Fixed steps with bounded catch-up"

Anchor: after the numbered list item 6 (`First frame after `start`: ...`).

```diff
+**M2 additions (the arithmetic above is unchanged — 120 Hz and the eight-step
+cap are kept):**
+
+- **One action sample per executed step.** The runtime calls
+  `actions.sample(n)` exactly once per executed step, before any module phase,
+  and passes the returned `ActionFrame` to every phase of that step
+  (`input.md` §3). A step that is not executed is never sampled.
+- **No phantom steps, no replayed edges.** A dropped wall-time interval
+  executes no steps, samples no frames and calls no module or port method; the
+  drop-and-resync in item 4 is the whole mechanism. Because `stepIndex` is
+  contiguous and each index is executed at most once, a `pressed` edge is
+  delivered at exactly one step even when a frame executes eight catch-up
+  steps (`platformer.md` §2.1, fixtures `runtime/catchup.json`).
+- **Determinism with a port.** One step is a pure function of
+  `(state, stepIndex, snapshot, resolved settings, actions.sample(stepIndex),
+  modules, port state)`. The wall clock still affects only *how many* steps
+  run; no module may read wall time, `Math.random`-derived values or any
+  ambient device state during a step.
```

### R8 — §5.1 "Module step isolation"

```diff
-A module's `step` must either mutate `curr` consistently or throw. The
-runtime copies `curr` before a step and **restores the copy if any module
-throws** (no partial module application): the step is a no-op, `stepIndex`
-and `simTime` do not advance, and a `module_error` diagnostic is recorded
-(§8; the step keeps no-opping on every subsequent step until disposed — the
-module is failed, not retried). The M1 demo module cannot throw; this rule
-is the defensive bound.
+A module's `step` must either complete its phase consistently or throw.
+
+- **M1 module sets (demo only).** Unchanged: the runtime copies `curr` before a
+  step and **restores the copy if the module throws** (no partial
+  application): the step is a no-op, `stepIndex`/`simTime` do not advance, a
+  `module_error` diagnostic is recorded, and the step keeps no-opping on every
+  subsequent step until disposed. This remains exactly as accepted because the
+  demo is stateless.
+- **M2 module sets (any stateful module selected).** A throw — or a write/phase
+  violation, a duplicate staged move, or an invalid/undefined port result —
+  **fail-stops the whole simulation** with no rollback attempt: the current
+  step is abandoned (no transform copy is restored, because private physics
+  and script state cannot be reconstructed from `prev`/`curr`), the driver is
+  cancelled, and the runtime enters `failed` (new §13). The runtime never
+  continues with a half-mutated world.
+- **Phase isolation.** Modules run grouped by their declared phases in the
+  canonical order `intent → controller → physics → transform`; within a phase,
+  registration order. Phase-scoped write rules and port-call rules are in
+  new §12. The M1 demo's `step` math is unchanged, with the phase argument and
+  `StepContext` added (§7.2).
```

### R9 — §5.2 "Why drops are safe in M1"

```diff
-The M1 demo is a pure function of `simTime` (§7.1): after a drop, the next
-step computes the exact position for the new `stepIndex` — no drift, no
-desync. For future *stateful* modules (M2+), drop semantics require
-re-review in that module's contract change.
+The M1 demo is a pure function of `simTime` (§7.1): after a drop, the next
+step computes the exact position for the new `stepIndex` — no drift, no
+desync.
+
+**M2 (recorded re-review, §11's precondition).** Drops stay safe for stateful
+modules under three rules, all normative: (1) gameplay state advances only on
+**executed** steps, never on wall time — the controller's velocity, coyote and
+buffer windows are all integer-step counters (`platformer.md` §7); (2) dropped
+steps are neither sampled nor simulated, so a drop shortens nothing
+semantically: it is indistinguishable from those steps never existing; (3) the
+physics port is stepped exactly once per executed step, so a drop cannot
+produce a physics catch-up burst. The observable consequence is that a dropped
+interval changes *when* the simulation continues, never *what* it computes —
+which is why the acceptance traces replay recorded step-indexed frames rather
+than wall-clock events (`input.md` §6).
```

### R10 — §6 frame ordering

```diff
-**Frame ordering (normative for the adapter, packet 08):** the runtime owns
-the single frame driver. Each frame: (1) the §5 step update, (2) `onFrame()`
-— the adapter reads `getInterpolatedState()`, copies values into Object3Ds,
-(3) renders. The adapter never installs its own animation loop
-(no duplicate loops; one loop owner = the runtime).
+**Frame ordering (normative for the adapter, packet 08; extended for M2):**
+the runtime owns the single frame driver. Each **executed step** runs the six
+phases of §12 (`sample → intent → controller → physics → transform`), then the
+frame continues with (2) `onFrame()` — the adapter reads
+`getInterpolatedState()`, copies values into Object3Ds, (3) renders. The
+adapter never installs its own animation loop (no duplicate loops; one loop
+owner = the runtime), never writes authoritative state, and never applies
+gameplay smoothing: the interpolated values are derived read-only from the
+authoritative `prev`/`curr` (`physics.md` §7's stall-jitter decision).
```

### R11 — §7.2 "Module shape"

```diff
-SimulationModuleSpec = { id: string, create(snapshot, cfg) → SimulationModule }
-SimulationModule     = { step(state, stepIndex) → void, dispose?() → void }
+SimulationModuleSpec = {
+  id: string,
+  phases: readonly SimulationPhase[],        // §12; canonical order, non-empty, unique
+  excludes?: readonly string[],              // module IDs that cannot be selected together
+  create(snapshot, cfg) → SimulationModule
+}
+SimulationModule = {
+  transformOwners: readonly string[],        // entity IDs this instance writes, declared at create
+  step(phase: SimulationPhase, ctx: StepContext) → void,
+  dispose?() → void
+}
```

(This is a **breaking type change** to the package's public module interface:
packet 29 implements it and updates the runtime's own tests. M1 observable
behavior — demo math, lifecycle, interpolation, diagnostics — is unchanged.)

### R12 — §8 "Structured diagnostics"

**(a) new fields** (insert rows into the field table, after `clockWarningCount`):

```diff
+| `failed` | `boolean` — sticky; `true` iff the runtime entered the §13 failed state |
+| `failedModuleId` / `failedPhase` / `failedStepIndex` | sticky diagnostic fields describing the fail-stop (absent while healthy) |
+| `inputSamples` | executed-step action samples (equals `stepIndex` for M2 sets; 0 for M1 default sets) |
+| `inputSuspendCount` / `inputActivateCount` / `inputDisconnectCount` / `inputMappingUnsupportedCount` | input lifecycle counters (`input.md` §5); diagnostics only |
+| `physicsSteps` / `physicsStallSteps` / `physicsPenetrationCorrectedCount` | port counters; `physicsStallSteps` records the packet-14 one-step horizontal stall (passed through, never smoothed) |
+| `droppedInputSteps` | dropped steps that consequently had no sample (equals `droppedSteps` for M2 sets) |
+| `settleSteps` | `12` for M2 module sets after the pre-roll, else `0` |
```

**(b) new/deprecated codes** (insert rows into the stable-code table):

```diff
+| `runtime_failed` | `start`/`tick` after the runtime entered the §13 failed state |
+| `module_combination_unsupported` | two selected modules exclude each other (`platformer.md` §2.3) |
+| `transform_owner_conflict` | two selected modules claim the same entity transform, or a claim names a missing entity |
+| `transform_owner_forbidden` | a module claims the camera entity or a physics-bearing entity it does not own |
+| `physics_port_error` | the injected port threw during `step()` or returned a malformed result (§13) |
+| `input_frame_invalid` | an action frame is malformed (`input.md` §2), raised via `config_invalid` at construction or as a `module_error` at sample time |
```

`module_error` keeps its code and gains `moduleId`, `phase` and a `reason`
(`phase_violation` | `input_frame_invalid` | `input_source_threw` |
`duplicate_move` | `module_threw`) in its entry. `config_invalid` gains the
reasons listed in R3 plus `physics_port`, `controller_target`, `scene_version`.

**(c) diagnostics example** — add to the JSON example in §8:

```diff
   "clockWarningCount": 0,
+  "failed": false,
+  "settleSteps": 12,
+  "inputSamples": 1481,
+  "physicsSteps": 1481,
+  "droppedInputSteps": 3,
```

### R13 — §9 "Dependencies and environment (normative)"

Anchor: after the `- **Imports:**` bullet.

```diff
+- **Injected ports, not imports.** The M2 `ActionSource` and `PhysicsPort` are
+  interfaces owned by this contract and implemented by other packages
+  (`input`, `physics-rapier`). The runtime receives instances in its config;
+  it never imports those packages, never constructs a concrete engine, and
+  never touches the DOM beyond §9's two guarded globals. A runtime without a
+  port keeps working exactly as M1 (`actions` defaults to neutral frames; no
+  port is required for an M1 module set).
```

### R14 — §10 "What is deliberately not in M1 (normative non-goals)"

```diff
-- **No input** (keyboard/controller/gamepad): the M1 runtime consumes no
-  input events; the platformer controller is M2. Input simulation is not an
-  M1 promise (m1-acceptance §3).
-- **No physics**: no collision, gravity, or integration beyond the
-  prescribed demo math; the physics evaluation is M2.
+- **No input in M1** (keyboard/controller/gamepad): the M1 runtime consumes no
+  input events and the M1 module set still does not. M2 adds the step-indexed
+  `ActionFrame` port (§12) and the controller (`platformer.md`); M2 input is
+  still not a promise of any M1 packet (m1-acceptance §3).
+- **No physics in M1**: no collision, gravity or integration beyond the
+  prescribed demo math. M2 adds exactly the 2.5D feature set of
+  `physics.md` §3 through an injected port — still no dynamic bodies, joints,
+  sensors, moving/one-way platforms, mesh-derived colliders or 3D physics.
```

### R15 — §11 "Change rules": insert bullets

```diff
+- The M2 phase model, transform-ownership rule, port surfaces, fail-stop
+  behavior, diagnostics fields and error codes (new §§12–13) are contract
+  material: reordering phases, adding a second writer for one transform,
+  continuing after a module error, or changing `SIM_HZ`/`MAX_CATCHUP_STEPS`
+  requires a reviewed change, not a local implementation choice.
+- M2's controller constants, jump windows and gameplay settings registry
+  (`platformer.md` §§7/10) follow the same rule: committed fixtures and
+  acceptance A12/A13 reference their exact values.
```

---

## C. New sections

### R16 — new §12 "M2 module phases, ports and transform ownership"

Insert **after** §11 (end of document). Normative text, verbatim:

| New subsection | Text source |
|---|---|
| §12.0 intro (M2 module sets; M1 unchanged) | `../platformer.md` §1/§2 |
| §12.1 Phase registration and the canonical phase order | `../platformer.md` §2/§2.1 |
| §12.2 Write guard and phase violations | `../platformer.md` §2.2/§3 |
| §12.3 Transform ownership and duplicate-writer rejection | `../platformer.md` §5 |
| §12.4 Unsupported module combinations | `../platformer.md` §2.3 |
| §12.5 The input port and per-step sampling | `../input.md` §3 |
| §12.6 The physics port and phase-3 call | `../physics.md` §5 |
| §12.7 Determinism and replay tolerance with ports | `../input.md` §6 |

### R17 — new §13 "M2 fail-stop lifecycle"

Insert **after** §12. Normative text: `../platformer.md` §9 (trigger, the six
effects, the no-rollback rule, safe-restart-only recovery, and the M1
compatibility scope), plus `../physics.md` §10 (port failure outcomes and
initialization cancellation). New lifecycle state `failed`; sticky diagnostics;
`dispose()` from `failed` releases modules and the port exactly once.

---

## D. Cross-file items (change requests; NOT applied here)

These belong to other accepted contracts and are recorded here so packet 19's
consolidated inventory carries them. Packet 17 changes none of them.

### R18 — `docs/contracts/dependencies.md`

| Destination | Change | Source |
|---|---|---|
| §3 "Public export surface per unit" | add rows for the new units `input`, `platformer`, `physics-rapier`; add `runtime`'s new exports (`ActionSource`, `PhysicsPort`, `SimulationPhase`, `StepContext`, `createRecordedActionSource`, controller constants); add `project-model`'s `M2_SETTINGS_KEYS`/`resolveGameplaySettings`/`validateCollider`/`validateController` | `../input.md` §8, `../physics.md` §11, `../platformer.md` §12 |
| §4.1 "Node-side" | `input → runtime` (types); `platformer → runtime` (types); `physics-rapier → runtime` (types) + the approved Rapier pin; `runtime → project-model` **unchanged** (no new edge) | `../platformer.md` §12 |
| §4.2 "Browser-bundle graphs" | play-preview and export bundles gain `input`, `platformer`, `physics-rapier` (and, at packet 33, `behavior-build` output); the editor bundle composes them; `runtime` still must not appear as an importer of any of them | `../platformer.md` §12 |
| §6 "Module registration mechanism" | record the M2 registry contents (the table in `../platformer.md` §2), the phase/ownership/exclusion spec fields, and that `physics-rapier` is an injected port rather than a module | `../platformer.md` §2 |
| §5 "Enforceable boundary checks" | add a negative probe so `runtime` importing `input`/`platformer`/`physics-rapier`/a DOM global fails the boundary check | `../platformer.md` §12 |

The Rapier pin (`@dimforge/rapier2d-compat@0.20.0`, integrity
`sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`)
enters `package.json`/the lockfile **only at Gate E / packet 31**
(decision 0002 §1.2/§1.4); packet 17 installs nothing.

---

## E. Explicitly not changed

- §2 snapshot document shape, immutability, provenance, bounds and strictness.
- §3.3 `stop()` semantics (retained state; one driver).
- §3.4 `dispose()` other than the added `failed` → `disposed` transition (§13).
- §4's `order`/`entities`/`stepIndex`/`simTime`/`prev`/`curr` structure and the
  "every mutation writes only to this state" rule.
- §5's constants (`SIM_HZ = 120`, `MAX_CATCHUP_STEPS = 8`), the `rawN` formula
  and drop-and-resync; §6's interpolation math and read-only rule.
- §7.1's demo constants and §7.3's no-user-scripts statement.
- §8's error-entry shape and ring bound; §9's import list and DOM guards;
  §10's other non-goals (no graphs, no add/remove/reparent, no write-back, no
  workers/audio/network/persistence, no hot reload, no multiplayer).

---

# Packet 18 additions — the behavior execution boundary and the intent phase

**PROPOSED — pending Gate E.** Appended by packet 18
(`docs/planning/m2-packets.md` §18) to the same diff file. **Packet 17's sections
A/R1–R18 and its §E list above are unchanged and remain in force**; every item
below applies *on top of* them. Normative text sources:
[`../behaviors.md`](../behaviors.md) §9/§10/§11 and
[`project-model.md`](project-model.md) §"Packet 18 additions".

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** (A pre-approval, not an independent
review.) The trusted-main-thread execution boundary is the explicit owner
decision of this packet (`../behaviors.md` §2/§2.4); if it is rejected, request a
separate execution-boundary design packet — do not add a worker/watchdog here.

## P18. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| R19 | §1 "Scope and ownership" | insert bullets | `../behaviors.md` §1 |
| R20 | §3.1 "`instantiateRuntime(config)`" (after R3) | insert rows + validation | `../behaviors.md` §3/§9.1/§9.6 |
| R21 | §5 "Fixed steps with bounded catch-up" (after R7) | insert the intent-phase commit | `../behaviors.md` §9.3/§9.5 |
| R22 | §5.1 "Module step isolation" (after R8) | reword: fail-stop reasons | `../behaviors.md` §9.4/§10 |
| R23 | §7.2 "Module shape" (after R11) | reword: behavior phases/ownership | `../behaviors.md` §9.1/§9.2 |
| R24 | §7.3 "No user scripts (normative non-goal)" | reword (M1 → M2 scope split) | `../behaviors.md` §8.3/§15 |
| R25 | §8 "Structured diagnostics" (after R12) | insert fields + reasons | `../behaviors.md` §10.1 |
| R26 | §9 "Dependencies and environment" (after R13) | insert behavior rules | `../behaviors.md` §9.7/§5.4 |
| R27 | §10 "What is deliberately not in M1" | reword two bullets | `../behaviors.md` §2.2/§15 |
| R28 | §11 "Change rules" | insert bullets | this file |
| R29 | **new §14** | insert section | `../behaviors.md` §9/§10 |
| R30 | cross-file (`platformer.md`, `properties.md`, `commands.md`, `export.md`, `dependencies.md`, `content-storage.md`) | change requests | §P18-D below |

Not changed by packet 18: §2 (snapshot shape/immutability/provenance — a behavior
never mutates it), §3.2–§3.5, §4's `prev`/`curr` structure, §5's constants and
arithmetic, §6's interpolation policy, §7.1's demo math, §8's error-entry shape
and 32-entry ring, §9's existing import list and DOM guards, §12/§13 (packet 17's
phases, ports, write guard and fail-stop).

## P18-B. Existing sections

### R19 — §1 "Scope and ownership": insert bullets

Anchor: after R1's last inserted bullet (the gameplay settings resolution rule).

```diff
+- The **behavior execution boundary**: trusted declaration-only and
+  source-bearing behaviors, their static source rules and the digest-bound
+  compilation/publication order (`behaviors.md` §2–§8). A behavior never
+  mutates the snapshot, the authoring state or the physics world.
+- The **`intent` phase commit point** and the `IntentSet`: the only channel by
+  which a behavior influences the simulation (`behaviors.md` §9.4/§9.5).
+- The **non-physics transform ownership** of behavior entities
+  (`behaviors.md` §9.6) and its write-guard reasons.
+- The **trust limitation** (no hard runtime timeout, no hostile-code sandbox)
+  and the durable acknowledgment gate — an owner decision, not a runtime
+  capability (`behaviors.md` §2/§2.3).
```

### R20 — §3.1 "`instantiateRuntime(config)`": insert config rows + validation

Insert after R3's rows. The `modules` selection already exists (packet 17); the
new rows describe how behavior modules enter it. No new config field is added to
`instantiateRuntime`: the host bootstrap builds the registry and the module
selection from the immutable snapshot's content and the **already-linked**
behavior outputs (`behaviors.md` §9.1).

```diff
+| `modules` entries `thirdlight.behavior:<behaviorId>` | valid only when the snapshot's content declares that behavior with a non-null `source` **and** the host has linked the compiled output for its `outputDigest`; the phase list is `["intent"]`, or `["intent","transform"]` when the container's `ownedTransforms` is non-empty | `config_invalid` (`reason: "behavior_source_unlinked"`) |
+| behavior ownership validation (at instantiate, before any step) | every `ownedTransforms` entry must exist, carry `components.behavior` for the same `behaviorId`, and be neither the camera entity nor a `collider`/`controller` entity | `transform_owner_forbidden` (`reason: "behavior_ownership_forbidden"`, `detail: "camera" \| "physics_entity" \| "not_behavior_entity"`); packet 17's `transform_owner_conflict` for an entity claimed twice |
+| behavior instance count | one instance per (behavior module, entity carrying that behavior) pair; ≤ 64 modules per runtime instance | `config_invalid` (`reason: "behavior_modules"`) |
+| `source: null` behaviors | register **no** module and contribute nothing | — (authored data only) |
```

Normative: `instantiateRuntime` **must not** compile, import, fetch or otherwise
load behavior code. By the time it runs, the module set and its linked outputs
are fixed; the runtime is synchronous (`platformer.md` §6, `behaviors.md` §5.4).

### R21 — §5 "Fixed steps with bounded catch-up": insert the intent-phase commit

Insert after R7's rules, as new numbered rules (the existing step numbering and
arithmetic are untouched):

```diff
+8. At the start of every executed step the runtime clears the **`IntentSet`**
+   and freezes the sampled `ActionFrame`; behavior modules registered in the
+   `intent` phase commit control intents into it in registration order
+   (ascending `behaviorId` codepoint order, `behaviors.md` §9.1). The set is
+   frozen at the end of the `intent` phase and read-only afterwards.
+9. The controller phase's input is the **effective frame**
+   `{ stepIndex, moveX: intents.move ?? action.moveX, jump: intents.jump ??
+   action.jump }`; `ctx.action` remains the sampled frame in every phase
+   (`platformer.md` §3). With an empty `IntentSet` the effective frame is the
+   sampled frame, so packet 17's step algorithm and the 178 pinned trace rows
+   are bit-identical (`behaviors.md` §9.5).
+10. A dropped wall-time interval executes no steps and therefore commits no
+   intents: catch-up can never multiply an intent or a jump edge (same argument
+   as `input.md` §3.1).
+11. Intent/transform-write caps (`behaviors.md` §10) are enforced at commit
+   time and are fail-stop (`module_error` + `behavior_intent_limit`); the step
+   is abandoned exactly like a module throw (`platformer.md` §9).
```

### R22 — §5.1 "Module step isolation" (after R8): reword fail-stop reasons

```diff
-…one bounded error entry with `code: 'module_error'`, `reason` …
+…one bounded error entry with `code: 'module_error'`, `reason` ∈ packet 17's
+set (`phase_violation`, `duplicate_move`, `input_frame_invalid`, …) **or** the
+behavior set of `behaviors.md` §9.4/§10 (`behavior_intent_invalid`,
+`behavior_intent_conflict`, `behavior_intent_limit`,
+`behavior_transform_forbidden`, `behavior_step_async`, `behavior_state_shared`),
+with the API's `detail` field when the contract defines one…
```

### R23 — §7.2 "Module shape" (after R11): reword

```diff
+Behavior modules use the same `SimulationModuleSpec`/`SimulationModule` shape
+with the fields above (`behaviors.md` §9.1/§9.2): `id` is
+`thirdlight.behavior:<behaviorId>`, `phases` is `["intent"]` or
+`["intent","transform"]`, `transformOwners` is the container's
+`ownedTransforms` (empty in the intent-only case), and `create` returns an
+instance whose `step(phase, ctx)` calls the authored `step(state, ctx)` **and
+nothing else**. The spec's `prepare`/`instantiate`/`dispose` stages map exactly
+as `behaviors.md` §9.3 states; `dispose` is called once per created instance,
+including from `failed` (packet 17 §9).
```

### R24 — §7.3 "No user scripts (normative non-goal)": reword

```diff
-## 7.3 No user scripts (normative non-goal)
+## 7.3 User scripts (M1 non-goal; M2 scope split)
 
-M1 provides **no** mechanism to load, compile, or execute project-provided
-or user-provided code: …
+M1 provides **no** mechanism to load, compile, or execute project-provided or
+user-provided code, and that statement stays true for the M1 runtime module set.
+M2 adds **declaration-only behaviors** (a validated declaration with
+`source: null`), which execute nothing and register no module, and specifies —
+but does not yet enable — **source-bearing behaviors** under
+`behaviors.md` §2–§8. Source publication stays unavailable until packet 33
+implements the preparation path (`behaviors.md` §8.3); execution is
+trusted-main-thread with **no hard timeout and no hostile-code sandbox**
+(`behaviors.md` §2.2). Arbitrary user-script loading from a URL, an npm
+dependency or a build hook remains a non-goal in M2.
```

### R25 — §8 "Structured diagnostics" (after R12): insert fields + reasons

Insert after R12's packet-17 fields:

```diff
+| `intentCommitCount` | cumulative accepted intents (all behavior instances) |
+| `logCount` / `logDropped` | cumulative `ctx.log` calls / calls dropped by the per-instance ring and rate caps (`behaviors.md` §10) |
+| `failedModuleId` | already sticky (packet 17); it may name a behavior module |
```

and extend the error-entry reason list once more:

```diff
+`behavior_log` entries (`{ code, reason: 'info'|'warn'|'error', moduleId, message }`) are stored in the same 32-entry ring and do **not** increment `errorCount`.
```

### R26 — §9 "Dependencies and environment" (after R13): insert behavior rules

```diff
+- **Behavior bundles are browser-safe and synchronous.** Behavior code receives
+  the injected `ctx` only; it must not import `three`, `three-adapter`,
+  `editor`, `react`, `backend`, `workspace`, `commands`, `protocol` or any Node
+  builtin, must not use `fetch`/`XMLHttpRequest`/`WebSocket`, and must not be
+  async (`behaviors.md` §9.7, `diffs/dependencies.md`). This is a *compile-time*
+  rule (static import/dynamic-code checks and the output-content scan,
+  `behaviors.md` §4/§5.5) plus a runtime check (a thenable `step` return is
+  fail-stop) — **not** a sandbox (`behaviors.md` §2.2).
+- **No compilation at runtime.** The runtime never parses, compiles, evaluates,
+  fetches or imports behavior source. A module set with a `source`-bearing
+  behavior only exists after the host linked a prepared output
+  (`behaviors.md` §8.4/§8.7).
```

### R27 — §10 "What is deliberately not in M1": reword two bullets

```diff
-- No user-script loading (§7.3); no workers; no audio; no network access
-  from the runtime; no persistence of any kind.
+- No user-script loading in M1 (§7.3). M2 adds declaration-only behaviors and
+  (from packet 33) trusted source-bearing behaviors in the **main thread**,
+  with no worker, no watchdog, no hard timeout and no hostile-code sandbox
+  (`behaviors.md` §2.2/§2.4). No workers; no audio; no network access from the
+  runtime; no persistence of any kind.
 
-- No state-preserving hot reload: a code change restarts play (a fresh
-  snapshot/instance).
+- No state-preserving hot reload: a code change requires a new publication and
+  a fresh play instance (`behaviors.md` §8.6). Editing source, publishing, or
+  staging while a play instance runs changes nothing in it — there is no
+  watcher and no implicit snapshot change.
```

### R28 — §11 "Change rules": insert bullets

```diff
+- The `intent` phase, the `IntentSet`, the effective-input rule, the
+  intent/transform write rules and the §10 caps (`behaviors.md` §9/§10) are
+  contract material: fixtures and acceptance reference their exact values.
+  Changing the effective-input rule or a conflict rule requires a reviewed
+  diff, and a new intent kind also requires a consumer in `platformer.md`.
+- The trust disposition (`behaviors.md` §2) is an owner decision: no packet may
+  weaken a §2.2 limitation, drop the §2.3 acknowledgment gate or claim
+  preemption. If a hard boundary is required, a **separate execution-boundary
+  design packet** is the recorded path (§2.4).
+- Behavior source publication may be enabled only by packet 33's preparation
+  path plus a reviewed contract diff (`behaviors.md` §8.3); a change that makes
+  `publishBehavior{mode:"source"}` succeed without the prepare step is a
+  contract violation, not a feature.
```

## P18-C. New section

### R29 — new §14 "Behavior execution boundary, intent API and bounded diagnostics"

Insert **after** packet 17's §13. Normative text, verbatim:

| New subsection | Text source |
|---|---|
| §14.1 The trust boundary and its limitations (no timeout, no sandbox, origin globals, no-credentials rule) | `../behaviors.md` §2.1/§2.2 |
| §14.2 The acknowledgment gate and the separate-packet clause | `../behaviors.md` §2.3/§2.4 |
| §14.3 The `BehaviorSpec` lifecycle (`prepare → instantiate → step → dispose`) and per-instance private state | `../behaviors.md` §9.2/§9.3 |
| §14.4 Intent shapes, the exhaustive validation order and fail-stop reasons | `../behaviors.md` §9.4 |
| §14.5 `IntentSet`, deterministic ordering and the effective-input rule | `../behaviors.md` §9.5 |
| §14.6 Non-physics transform ownership and its write-guard reasons | `../behaviors.md` §9.6 |
| §14.7 What a behavior cannot do (workspace, physics, entities, files, fetch, second mutation path) | `../behaviors.md` §9.7 |
| §14.8 Intent/log bounds, the per-instance ring and the diagnostics fields | `../behaviors.md` §10/§10.1 |

The runtime-side entry points (packet 29 implements them) are the `intent` phase
in the fixed-step order, the `IntentSet` and its commit point, the write-guard
reasons, the effective-input rule, the caps and the diagnostics fields. Packet 18
adds **no** runtime code, no dependency and no lockfile change.

## P18-D. Cross-file items (change requests; NOT applied here)

### R30 — other documents

| Destination | Change | Source |
|---|---|---|
| `platformer.md` §2/§2.1/§3/§7 | behavior-module inventory row (phases/owners), `readonly intents: IntentSet` in `StepContext`, the effective-input rule as the controller's input; §7's algorithm text is unchanged | `../behaviors.md` §9.1/§9.5 (change request C18-3) |
| `properties.md` §5.2/§15 | source-mode wording ("unavailable until packet 33's preparation path") and the §15 non-goal line | `../behaviors.md` §8.3 (C18-4) |
| `commands.md` (packet-16 additions) | `acknowledgeBehaviorTrust`; the `preparation_missing` reason and the trust validation step | `../behaviors.md` §7/§8.4 (C18-2) |
| `content-storage.md` §5/§6.1, `assets.md` §7 | the `behavior-source` preparation profile, the derived-cache class for prepared outputs, the trust-aware refusal | `../behaviors.md` §8.2/§8.4 (C18-1) |
| `../diffs/export.md`, `../diffs/dependencies.md` | the new files beside this one | packet 18 |
| `runtime.md` §7.3/§10 | R24/R27 above | `../behaviors.md` §8.3/§15 (C18-7) |

The two new units (`behavior-compiler`, `behaviors`), their edges and the bundle
graph rows are recorded in [`dependencies.md`](dependencies.md). **No dependency
pin changes**: the compiler uses the already-pinned `esbuild@0.28.2` and
`typescript@5.9.3`; packet 18 installs nothing and touches no lockfile.

## P18-E. Explicitly not changed by packet 18

- §2's snapshot document (`RuntimeSnapshot`) — behaviors read it and can never
  write it.
- §3's lifecycle states other than packet 17's `failed`; §3.1's existing config
  fields; §3.2–§3.5.
- §4's mutable-state structure and the one-mutation-path rule.
- §5's constants (`SIM_HZ`, `MAX_CATCHUP_STEPS`), `rawN`, drop-and-resync;
  §6's math; §7.1's demo constants and §7.2's `SimulationModule` shape.
- §8's error-entry shape and 32-entry ring; §9's existing import list and DOM
  guards; §10's other non-goals; §12/§13.
