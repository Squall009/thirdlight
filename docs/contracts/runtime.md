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
- The **structured diagnostics** shape and error codes.
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
  }
}
```

| Field | Constraint |
|---|---|
| `snapshotId` | exactly `<projectId>@r<revision>` (project-model §6). Any other value ⇒ `snapshot_invalid` (`reason: "id_mismatch"`). |
| `projectId` | project-model ID syntax. |
| `revision` | integer, `0 ≤ v ≤ 2^53−1`; must equal `scene.revision` (else `snapshot_invalid`, `reason: "revision_mismatch"`). |
| `scene` | a complete **normalized** scene document (project-model §8/§12.2). Must pass `validateScene` — the runtime re-validates on receipt (the producer is not trusted; the session layer and the exporter both construct snapshots, and the runtime is the boundary). Validation failures ⇒ `snapshot_invalid` carrying the project-model error objects (≤ 10 reported, total count given). |

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
- Strict shape: unknown fields at any level ⇒ `snapshot_invalid`
  (`reason: "shape"`, path given). The snapshot carries no booleans in its
  `scene` (project-model §4); the wrapper fields above are the only extra
  fields.

## 3. Lifecycle: instantiate / start / stop / dispose

States: `instantiated → running ⇄ stopped → disposed` (`disposed` is
terminal; `running ⇄ stopped` may repeat).

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
| `modules` | array of module IDs present in `registry`; unknown ID ⇒ `config_invalid` | `["thirdlight.demo:box-motion"]` (M1 default) |
| `clock` | `() => number` — monotonic seconds | `performance.now() / 1000` when `performance` exists; injected clock otherwise (tests) |
| `driver` | `{ kind: "raf" }` (requires `requestAnimationFrame`) or `{ kind: "manual" }` (no auto-loop; the host calls `tick`) | `"raf"` when available, else `"manual"` |
| `fixedStepHz` | integer `1 ≤ v ≤ 1000` | `120` (the M1 constant) |
| `onFrame` | `() => void` — called once per frame after the step update (§6) | absent |

Effect: validate the snapshot (§2), deep-freeze it, build the initial
mutable state (§4) with `prev = curr = snapshot transforms`, `stepIndex 0`,
`simTime 0`; create one module instance per `modules` entry (module
`create`, dependencies.md §6). State becomes `instantiated`. **No loop,
timer, listener, or renderer is installed** at instantiate.

### 3.2 `start()`

- From `instantiated` or `stopped`: install the frame driver (a single
  `requestAnimationFrame` loop for `driver.kind: "raf"`; none for
  `"manual"`), set the wall anchor on the first frame (§5), state →
  `running`.
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
source would double-step the simulation).

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

### 5.1 Module step isolation

A module's `step` must either mutate `curr` consistently or throw. The
runtime copies `curr` before a step and **restores the copy if any module
throws** (no partial module application): the step is a no-op, `stepIndex`
and `simTime` do not advance, and a `module_error` diagnostic is recorded
(§8; the step keeps no-opping on every subsequent step until disposed — the
module is failed, not retried). The M1 demo module cannot throw; this rule
is the defensive bound.

### 5.2 Why drops are safe in M1

The M1 demo is a pure function of `simTime` (§7.1): after a drop, the next
step computes the exact position for the new `stepIndex` — no drift, no
desync. For future *stateful* modules (M2+), drop semantics require
re-review in that module's contract change.

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

**Frame ordering (normative for the adapter, packet 08):** the runtime owns
the single frame driver. Each frame: (1) the §5 step update, (2) `onFrame()`
— the adapter reads `getInterpolatedState()`, copies values into Object3Ds,
(3) renders. The adapter never installs its own animation loop
(no duplicate loops; one loop owner = the runtime).

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
SimulationModuleSpec = { id: string, create(snapshot, cfg) → SimulationModule }
SimulationModule     = { step(state, stepIndex) → void, dispose?() → void }
```

One instance per runtime instance (`create` at instantiate). The demo's
`create` closes over the snapshot's box entities (their `x0` and document
order); `step` writes positions per §7.1.

### 7.3 No user scripts (normative non-goal)

M1 provides **no** mechanism to load, compile, or execute project-provided
or user-provided code: no `eval`, no dynamic `import` of project content,
no script components, no file- or URL-sourced behavior. The only runtime
behavior is the compile-time-linked built-in module through the narrow
registry (dependencies.md §6). **Arbitrary user-script loading is deferred
until the execution boundary is reviewed** as a separate contract (origin
isolation per `sessions.md` §13 is a necessary, not sufficient,
precondition; capability, timeout, and failure isolation are not designed
yet). M1 makes no claim about hosting untrusted code (decision 0001 §1:
trusted personal projects).

## 8. Structured diagnostics

`getDiagnostics()` works in every state, including `disposed`:

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
  "modules": ["thirdlight.demo:box-motion"],
  "clock": "performance",
  "clockWarningCount": 0,
  "errors": [ { "code": "module_error", "message": "demo step threw (clipped)", "stepIndex": 1481 } ],
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
- **DOM surface:** `performance.now` (default clock) and
  `requestAnimationFrame` (default driver) — both guarded behind the
  injectable `clock`/`driver` config, so the Node test harness runs the same
  code with injected fakes.
- **No hidden globals:** no module-level mutable singletons; every instance
  is an explicit object; cross-instance sharing only via returned values.
- **Runs in:** the play-preview bundle (bridge-fed snapshot), the export
  bundle (embedded snapshot), and the vitest Node harness (manual driver +
  injected clock). Same code, same versions, in all three (`export.md` §5:
  the export uses this runtime, not a separate implementation).

## 10. What is deliberately not in M1 (normative non-goals)

- **No input** (keyboard/controller/gamepad): the M1 runtime consumes no
  input events; the platformer controller is M2. Input simulation is not an
  M1 promise (m1-acceptance §3).
- **No physics**: no collision, gravity, or integration beyond the
  prescribed demo math; the physics evaluation is M2.
- **No graphs**: no node/curve/graph authoring or data in the runtime
  (charter §3 defers graphs; material/shader graphs likewise).
- No entity add/remove/reparent during play; no component edits during
  play; **no play → authoring write-back of any kind** (charter §6:
  applying play-mode changes is a later explicit operation; M1 has none).
- No user-script loading (§7.3); no workers; no audio; no network access
  from the runtime; no persistence of any kind.
- No state-preserving hot reload: a code change restarts play (a fresh
  snapshot/instance).
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