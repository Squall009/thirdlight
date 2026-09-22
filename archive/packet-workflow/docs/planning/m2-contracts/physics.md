PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — 2.5D physics port and collision contract (M2)

**PROPOSED — pending Gate E.** Packet 17 output (`docs/planning/m2-packets.md` §17).
Companion documents of the same packet:

- [`platformer.md`](platformer.md) — the controller that drives this port.
- [`input.md`](input.md) — the step-indexed action frames.
- [`diffs/runtime.md`](diffs/runtime.md) — runtime phases, injected ports,
  transform ownership, fail-stop.
- [`diffs/project-model.md`](diffs/project-model.md) §"Packet 17 additions" —
  `components.collider` / `components.controller` and their validation.

Nothing in `docs/contracts/` or `docs/decisions/` changes until the Gate E
promotion step (docs-only).

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

**Physics selection: `@dimforge/rapier2d-compat` at exactly 0.20.0, kinematic
character controller — selection per decision 0002 §1, owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending.**
The selection remains **PROVISIONAL** until the packet-14 desktop evidence is
recorded and Gate E accepts it (decision 0002 §1.2/§1.4): dependent
implementation (packet 31) is blocked until then. The pin enters the repo
lockfile only at Gate E / packet 31 — packet 17 installs nothing.

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The **2.5D collision convention**: the XY gameplay plane, Z as visual depth,
  and the shape/feature set M2 supports.
- The **physics-bearing entity rules** (`components.collider`,
  `components.controller`): which transforms are valid and why unsupported
  transforms are validation errors instead of silently flattened geometry.
- The **injected `PhysicsPort`** surface: strict shapes, phase rules, init
  lifecycle (including cancellation), one mutation path, disposal.
- The **numeric defaults and tolerances** the controller, adapter and acceptance
  tests share, taken from packet 14's frozen course where measured and labelled
  where contract-selected.
- The **grounding rule** (collision results/support normals, never a floor
  constant) and the settle pre-roll.

| Unit | Proposed ownership |
|---|---|
| `runtime` | the port/client types, the phase-3 call, the write guard, result validation, fail-stop |
| `physics-rapier` (new) | the concrete Rapier 2D adapter: one `World`, static colliders, the parentless kinematic capsule, `createCharacterController` + `computeColliderMovement`, `enableSnapToGround`, disposal |
| `platformer` (new) | computes the requested delta; never touches the world directly |
| `three-adapter` | maps the authoritative XY transform to the scene (Z visual), no collision |
| `project-model` | validates `components.collider`/`components.controller` and the gameplay settings |

## 2. 2.5D convention (normative)

- **Gameplay movement happens on the XY plane** (X horizontal, Y up); coordinates
  follow project-model §2 (Y-up, right-handed, meters, camera at +Z looking
  toward −Z).
- **Z is visual depth only.** No collider, port call, tolerance or movement
  intent in M2 uses Z. The port's API has no Z parameter.
- **The character's Z, rotation and scale are authored and locked.** No M2
  module writes them; the controller writes only the character's
  `position.x`/`position.y` (see `platformer.md` §5). Mesh children of the
  character may carry authored visual offsets; those are ordinary child
  transforms and are never physics inputs.
- **No Z drift is possible by construction**, and the assertion is explicit
  because it is what proves the convention: after any number of steps,
  `curr.position.z`, `curr.rotation` and `curr.scale` of every physics-bearing
  entity are **bit-identical** to the snapshot values
  (`fixtures/m2/contracts/platformer/traces.json` trace `no-z-drift`).
- The visual scene may render the XY plane with any authored camera; M2's play
  camera is the static perspective camera of project-model §2/§10.3 (see
  `platformer.md` §8).

## 3. Supported collision features (M2, exhaustive)

| Allowed | Detail |
|---|---|
| Static **boxes** | authored `components.collider.shape.type === 'box'`, local half-extents `hx`, `hy` |
| Static **bounded convex polygons** (ramps) | authored `shape.type === 'polygon'`, 3–8 vertices, strictly convex, local coordinates |
| Exactly **one** upright kinematic capsule character | `components.controller`; radius `0.3`, half-height `0.6` (contract constants, §7); upright = no tilt, translation-only movement |
| One `World` per runtime instance | `world.step()` once per executed fixed step (no dynamic bodies; this is the pipeline update) |

**Not in M2 (normative non-goals): no dynamic bodies, no joints, no sensors, no
moving platforms, no one-way surfaces, no mesh-derived colliders, no
arbitrary parenting, no character rotation/tilt, no autostep / automatic stair
climbing, no friction-sensitive behavior, no restitution, no CCD beyond the
character controller's own sweep, no multiple characters, no Z collisions, no
3D physics and no Rapier 3D.**

## 4. Physics-bearing entities (`components.collider`, `components.controller`)

Shapes (proposed `schemaVersion` 2 components; exact validation in
`diffs/project-model.md` §"Packet 17 additions", new §21):

```ts
type ColliderShape =
  | { type: 'box'; hx: number; hy: number }                  // 0 < v ≤ 1e6
  | { type: 'polygon'; vertices: [number, number][] };       // 3–8 strict-convex vertices, |v| ≤ 1e6

interface ColliderComponent { shape: ColliderShape }
interface ControllerComponent { }                            // marker; no fields in M2
```

Canonical component key order: `transform`, `model`, `box`, `camera`,
`behavior`, `prefab`, `collider`, `controller` (the two packet-17 components are
appended last; packet 20 owns the final v2 registry order — `diffs/project-model.md`).

An entity is **physics-bearing** iff it carries `collider` or `controller`.
Exactly one entity in the scene carries `controller` (`controller_count_invalid`
otherwise); 0–256 entities may carry `collider` (`limits_exceeded` limit
`colliders`).

**Transform rules (validation errors, never silent flattening).** Every
physics-bearing entity must be:

1. a **root** — `parentId` absent or `null`; a parented collider is
   `physics_transform_unsupported` (`reason: "parented"`), because the solver
   re-syncs a parented collider toward its body and the character loop is only
   defined for the parentless pattern (§6). A parent *group* may exist in the
   scene; the physics-bearing entity simply cannot be inside it;
2. at **unit scale** — `scale === [1, 1, 1]` exactly; any other scale is
   `physics_transform_unsupported` (`reason: "scale"`). M2 does not shrink or
   stretch colliders by an authored scale factor: the geometry is authored in
   meters in the collider shape itself. Flattening a non-unit scale into the
   shape would silently change collision meaning and is forbidden;
3. **rotated about Z only** — quaternion `[x, y, z, w]` with `|x| ≤ 1e-6` and
   `|y| ≤ 1e-6` (the project-model near-unit tolerance applies to `z, w`);
   anything else is `physics_transform_unsupported` (`reason: "rotation"`). The
   character must in addition be upright in the sense of §3: **any** authored
   rotation on the `controller` entity other than the identity quaternion is
   `physics_transform_unsupported` (`reason: "upright"`) — the capsule is never
   tilted in M2.

`collider` may coexist with `box` (an authored box that renders and collides)
or `model` (a GLB visual with an authored collider); `controller` may coexist
with `box`/`model`. `collider` and `controller` on one entity is
`component_conflict`. Polygon validation: vertices in counter-clockwise order,
finite, no duplicate adjacent vertices, convex within `1e-9` (collinear triples
allowed), area ≥ `1e-6` m², bounding half-extent ≤ `64` m; a violation is
`collider_shape_invalid`. M2 caps: 8 vertices per polygon and 1024 polygon
vertices per scene (`limits_exceeded` limits `collider_vertices`,
`collider_vertices_total`).

## 5. The injected port

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
  snapped: boolean;                       // ground snap was applied this step
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
  undefined/invalid result is never partially applied.
- **No Z.** No port method accepts or returns a Z value.
- **The character never moves while grounded by a downward command**
  (adapter guard kept from decision 0002 §1.2 item 3): the controller's
  grounded branch stages `y: 0`, so the adapter's degenerate-input path is not
  reachable through the contract; the adapter nevertheless keeps its guard
  (measured clean in packet 14 T12).

## 6. Adapter lifecycle: init, cancellation, parentless collider, disposal

- **Async init.** `createPhysicsPort(config, signal?) → Promise<{ ok: true; port } | { ok: false; error }>`
  (WASM initialization is asynchronous; measured cold init 73–77 ms in the
  container — **directional, BR-2, not a reference-desktop claim**). The runtime
  itself stays synchronous: `instantiateRuntime` requires an already-created,
  ready port (§ "physics_port" config error otherwise).
- **Initialization cancellation.** The caller may pass an `AbortSignal`. On
  abort the adapter must release everything it allocated and resolve
  `{ ok: false, error: { code: 'physics_init_cancelled' } }`; a `PhysicsPort`
  object must **never** be observable before initialization has completed (no
  partially built `World`, no half-constructed collider set, no global WASM
  singleton). A cancelled init followed by a new init must succeed — the adapter
  holds no module-level state.
- **Init failure.** WASM/CSP/denied-init failure resolves
  `{ ok: false, error: { code: 'physics_init_failed', reason, message } }`
  (the `-compat` distribution embeds the WASM, so no separate WASM fetch is
  involved; the browser path remains UNVERIFIED until packet 14's desktop
  procedure runs). Play must report an actionable unavailable state; it must
  never silently fall back to a different engine or to transform-only motion.
- **Parentless collider (normative trap).** The character collider is created
  **without** a parent rigid body and positioned with
  `collider.setTranslation(...)`; movement is
  `controller.computeColliderMovement(collider, delta)` →
  `controller.computedMovement()` → `collider.setTranslation(position +
  movement)`. Static colliders are attached to fixed bodies. **Parenting the
  character collider to a rigid body breaks the loop** (the solver re-syncs the
  collider toward the body): the adapter must use the parentless pattern and
  this trap is part of the adapter's documentation and tests (packet 31).
- **Controller configuration** (exact 0.20.0 API, pinned from the `.d.ts`):
  `world.createCharacterController(offset)` with `offset = 0.01`;
  `setMaxSlopeClimbAngle(rad)`; `setMinSlopeSlideAngle(rad)`;
  `enableSnapToGround(0.1)`; `computedGrounded()` is the grounding signal;
  autostep is **not** enabled.
- **Disposal.** `dispose()` frees the `World` and the adapter instance, is
  idempotent, and must be called exactly once by the host on
  `runtime.dispose()` (including from the `failed` state). No timers, listeners
  or globals survive disposal; a disposed port handed to the runtime is
  `config_invalid` (`reason: "physics_port"`).

## 7. Numeric constants, defaults and tolerances

**From packet 14's frozen course (measured; `tests/evaluations/m2-physics/course-spec.json`,
evidence `docs/acceptance/evidence-m2/14/`):**

| Quantity | Value | Note |
|---|---|---|
| fixed step | 120 Hz, `dt = 1/120` s | runtime.md §5 (unchanged) |
| gravity `y` | `−19.62` m/s² | settings key `gravity_y` |
| character run speed | `4.0` m/s | settings key `run_speed` |
| jump edge velocity | `7.0` m/s | settings key `jump_velocity` |
| maximum fall speed | `−30.0` m/s | settings key `max_fall_speed` |
| capsule radius `r` | `0.3` m | contract constant |
| capsule half-height `hh` | `0.6` m | contract constant (total height 1.8) |
| character reach `hh + r` | `0.9` m | derived |
| controller offset (skin) | `0.01` m | contract constant |
| ground snap distance | `0.1` m | contract constant |
| maximum climb angle | `45°` | settings key `max_slope_climb_deg`; measured 43° climbs, 47° refused |
| minimum slide angle | `30°` | settings key `min_slope_slide_deg` |
| autostep | disabled | contract constant |
| settled rest center on flat ground | `0.910` m ± `0.0005` (measured `0.9099987`) | pre-roll result |
| jump apex gain | `1.249` m ± `0.05` theoretical; probe reported `1.2297` from the nominal `0.900 m` center, i.e. `1.2196625` from the settled `0.910 m` rest center — the contract-order model (`platformer.md` §7) reproduces that trajectory to `3e-7` m | acceptance T11 |
| seam: ungrounded steps | ≤ `2` (measured `0`) | acceptance T3 |
| ramp climb grounded fraction | ≥ `0.95` (measured `1.0`) | acceptance T4 |
| too-steep 1 s height gain | ≤ `0.3` m (measured `0.0067`) | acceptance T5 |
| wall stop band | `0.05` m; measured max post-contact `dx` `0.0003` m/step | acceptance T6 |
| static penetration | ≤ `0.005` m (measured `0`) | acceptance T6/T9 |
| head contact: max realized rise after the contact step | ≤ `5e-4` m/step | acceptance T7 |
| ledge overhang block | max `dx` `0.02` m/step while blocked (measured `7.3e-9`) | acceptance T8 |
| high-speed approach | `12.0` m/s, no penetration beyond `0.005` m, contact within `10` steps (measured `8`) | acceptance T9 |

**Contract-selected here (not packet-14 measured — the probe commanded
instantaneous velocity and had no jump windows):**

| Quantity | Value | Rationale |
|---|---|---|
| move acceleration | `40` m/s² | `0 → 4 m/s` in exactly 12 steps; `0.3333` m/s per step |
| move deceleration | `60` m/s² | `4 → 0 m/s` in exactly 8 steps; `0.5` m/s per step |
| jump release factor | `0.5` | on release while ascending, `vy ← vy · 0.5` |
| coyote window | `6` executed steps | `platformer.md` §7 |
| jump buffer window | `8` executed steps | `platformer.md` §7 |
| ground-contact tolerance for classification | `1e-6` | compares `supportNormal.y` with `cos(maxClimb)` |
| replay tolerances | see `input.md` §6 | exact same-engine; `1e-3` m cross-engine |

**Directional, not a reference-desktop claim (BR-2):** fixed-step cost p99 ≤
`0.031` ms and cold init `73–77` ms were measured in this container under Node
v22.22.1, not on the reference desktop. The 8.333 ms value is the *whole* 120 Hz
tick, not a physics-only budget. No browser CPU, GPU or memory claim is made.

**The 1-step horizontal stall jitter is passed through, not smoothed
(decision).** Packet 14 recorded occasional one-step horizontal stalls at
existing floor contact (average speed unaffected). The runtime **must not**
smooth, extrapolate or re-time the character transform: the authoritative
per-step trace is the acceptance evidence (A12/A13), and a render-side
correction would decouple the rendered motion from the replayable trace. The
read-only interpolation of `runtime.md` §6 is applied to the *authoritative*
`prev`/`curr` values and therefore cannot hide or amplify the stall. The
recorded stall count is a diagnostic (`physicsStallSteps`), never input to
gameplay.

## 8. Grounding rule (normative)

`grounded` comes from the **collision result of the completed move**, never from
`position.y === floorHeight`, never from `vy === 0`, and never from a
hard-coded level constant:

1. the adapter reports `computedGrounded()` plus the support normal of the
   contact that produced it;
2. the controller treats the character as grounded iff
   `result.grounded === true` and `result.supportNormal.y ≥ cos(maxSlopeClimbRad) − 1e-6`
   (with `maxSlopeClimbRad = 45°`, `cos = 0.70710678`, so the classification
   threshold is `0.70710578`);
3. zero vertical speed alone is **not** grounding: a character at the apex of a
   jump has `vy = 0` and `grounded = false`;
4. a normal-flagged `grounded` with `supportNormal.y < cos(maxClimb)` is
   treated as not-grounded by the controller and is `steepSlope`. Rapier 0.20.0
   **does** produce this case: at `45.1°` the library still reports
   `computedGrounded()` with the raw normal `supportNormal.y = 0.70587157`, and
   the controller classifies it as not-grounded (`steepSlope`); the earlier
   "informational only" parenthetical was wrong (packet-31 C31-5);
5. ground snap is only meaningful when the character is already grounded and the
   requested delta is downward or zero; enabling snap never grounds an airborne
   character (`snapped` is reported and asserted). `snapped` is the flag for
   **any bounded ground-contact correction** the adapter applied this step, in
   either direction, up to `snap + skin` (`0.1 + 0.01 = 0.11` m) — it is not
   limited to a downward snap and not to the 1 mm non-snapped allowance. The
   `0.20.0` one-time ~11.3 mm ground-offset push-out is such a correction
   (packet-31 C31-2); a correction beyond `snap + skin` is refused by the
   adapter (`collision_correction_failed`).

The just-below/just-above slope table (`fixtures/m2/contracts/physics/numerics.json`):
`44.9°` → `supportNormal.y = 0.70833984` → grounded; `45.0°` →
`0.70710678` → grounded (inclusive); `45.1°` → `0.70587157` → raw-grounded per
library but `steepSlope` ⇒ not grounded by the controller; `29.9°` → no
controller slide; `30.0°` and above → the controller's `min_slope_slide_deg`
slide policy applies (`platformer.md` §7.4). Sliding is **not** produced by the
adapter's `setMinSlopeSlideAngle`: packet 31 measured no autonomous adapter
sliding at `30°` (C31-4); the adapter reports the raw normal/grounded flags and
the controller policy owns the observable slide.

## 9. Settle pre-roll (initialization)

The first-step state initialization produces a measured **~1.4 mm dip**
(`1.36` mm recorded on step 0 when the grounded flag starts `false`). The
contract therefore declares a **settle pre-roll of exactly 12 executed fixed
steps** before gameplay: `stepIndex` 0–11, the neutral action frame, the normal
controller/physics phases, no input sampling. The pre-roll runs on the first
frame after `start()` (before the wall anchor is set), so it consumes no wall
time and cannot produce phantom steps (`platformer.md` §6,
`diffs/runtime.md` §3.2/§5). After the pre-roll the character is grounded on the
frozen flat course at the settled rest center height (§7). A module or port
error during the pre-roll is a normal fail-stop (§10) and the runtime never
reaches gameplay.

## 10. Observable failure outcomes

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

## 11. Public exports (proposed)

`@thirdlight/runtime` (types only): `PhysicsPort`, `PhysicsStepClient`,
`PhysicsInitConfig`, `StaticColliderSpec`, `CharacterMoveResult`,
`PhysicsDiagnostics`, `ColliderShape`, `ColliderComponent`, `ControllerComponent`.

`@thirdlight/physics-rapier` (new package, Rapier-only adapter):

```ts
export function createPhysicsPort(config: PhysicsInitConfig, signal?: AbortSignal): Promise<
  { ok: true; port: PhysicsPort } | { ok: false; error: { code: 'physics_init_failed' | 'physics_init_cancelled'; reason?: string; message: string } }
>;
export const RAPIER_PIN: '0.20.0';
export const PHYSICS_IMPLEMENTATION: 'rapier2d-compat@0.20.0';
```

`@thirdlight/project-model` (proposed, §21 of the diff): `validateCollider`,
`validateController`, `CONTROLLER_CAPSULE` (`{ radius: 0.3, halfHeight: 0.6 }`),
`M2_SETTINGS_KEYS` (filled registry) and
`resolveGameplaySettings(content) → { ok, settings }`.

## 12. Compatibility and change rules

- M2 adds the port and two v2 components; no accepted M1 behavior changes. M1
  scenes (no collider/controller, `schemaVersion` 1) are unaffected and the M1
  runtime module set never receives a port.
- Installing the Rapier pin, adding any physics feature to §3, changing
  `RAPIER_PIN`, or changing a §7 value that fixtures reference is a reviewed
  contract change. The pin lands in the lockfile only at packet 31 after Gate E.
- The `-compat` distribution embeds WASM in the JS bundle (no separate WASM
  fetch); switching to the non-compat distribution would change the export
  fetch policy (`export.md` §5.3/§5.4.1) and requires that contract change, not
  a config flag.
- Browser/CSP/gamepad evidence stays with packets 14/30/35/37; this contract
  fixes only what the runtime observes.

## 13. Deliberately not in M2

- Dynamic/rigid bodies, joints, sensors, kinematic moving platforms, one-way
  platforms, destructibles, triggers, areas, raycast gameplay APIs.
- Mesh-derived or prefab-derived colliders, per-bone colliders, rotated
  capsules, multiple colliders per entity, capsule scaling, character tilt.
- Fixed/variable timestep options, substepping, multithreaded/GPU physics,
  Rapier 3D, box2d/planck/cannon fallbacks at runtime.
- Friction/restitution/mass/density authoring; contact material presets.
- Any physics or collision data in M1 documents or in the M1 runtime module set.
