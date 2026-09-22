# Packet 29 — contracted state traces (actual run output)

Source: `npx vitest run packages/runtime tests/m2-runtime` (see
`m2-tests.txt`) and the fixture replay in `tests/m2-runtime`. All values below
are asserted by the committed suites; the `fixtures/m2/runtime/*.json` files
carry the same numbers and are re-derived by
`fixtures/m2/runtime/tools/check-runtime-fixtures.mjs`.

## 1. Canonical phase order per executed step (`runtime.md` §12.1.1)

Synthetic probe module declaring `["intent","controller","transform"]` +
injected port; manual clock; 120 Hz.

| Observation | Value |
|---|---|
| Frame 1 (settle pre-roll) | 12 steps, `settleSteps = 12`, `inputSamples = 0`, `action` = neutral at steps 0…11 |
| Pre-roll call order (step 0) | `intent → controller → physics → transform` |
| Post-pre-roll tick (`elapsed = dt`) | samples `[12]`, `stepIndex 12 → 13`, calls `intent → controller → physics → transform → render` |
| `ctx.action` in every phase of step 12 | `{stepIndex:12, moveX:1, jump:"pressed"}` (identical object contents) |
| Write guard | `ctx.state.curr.set` / `curr.get(id).position[0] = v` / `ctx.stepIndex = v` all throw → fail-stop `module_error` `phase_violation` |

## 2. Fixed-step / sampling traces (`fixtures/m2/runtime/scheduler-traces.json`)

`preRoll = 12`, `dt = 1/120`, `MAX_CATCHUP_STEPS = 8`. `elapsed` is per frame.

| Case | Frames (elapsed) | stepIndex | droppedSteps | droppedInputSteps | sampled indices | pressed |
|---|---|---|---|---|---|---|
| S1-pre-roll-then-60hz | 0.0167 | 14 | 0 | 0 | 12,13 | – |
| S2-stall-drop-and-resync | 1.0; 0.0167 | 22 | 112 | 112 | 12…21 | – |
| S3-pressed-edge-once | 0.0668 | 20 | 0 | 0 | 12…19 | 1 @ 12 |
| S4-drop-does-not-replay | 0.5; 0.0167 | 22 | 52 | 52 | 12…21 | – |
| S5-zero-step-frame | 0.001; 0.0167 | 14 | 0 | 0 | 12,13 | – |

Invariants asserted in every case: `sampled` is contiguous and strictly
ascending (one sample per executed step, no duplicates), no dropped step is
sampled, and `droppedInputSteps == droppedSteps`.

The accepted packet-17 scheduler fixture
(`fixtures/m2/contracts/runtime/catchup.json`, C1–C7) is replayed unchanged
and reproduces every `stepsExecuted` / `droppedSteps` / `sampledStepIndices` /
`pressedCount` expectation.

## 3. Frozen M1 demo points (`fixtures/m2/runtime/demo-traces.json`)

`x(completedSteps) = x0 + A·sin(2π(completedSteps+1)/(hz·T))`, `x0 = 0.5`,
`A = 0.5`, `hz = 120`, `T = 4 s`; the authored `x0` holds at
`completedSteps = 0` (no step executed). Replayed bit-exactly through the
runtime (default M1 module set):

| completedSteps | x |
|---|---|
| 1 | 0.5130884741539365 |
| 59 | 0.8535533905932737 |
| 119 | 1 |
| 120 | 0.9999571637870035 |
| 239 | 0.5000000000000003 |
| 240 | 0.4934552022143278 |
| 479 | 0.49999999999999944 |

## 4. Transform ownership / combination table (accepted `catchup.json` O1–O8)

| Case | Outcome |
|---|---|
| O1-single-owner | instantiate ok |
| O2-duplicate-writer | `transform_owner_conflict`, reason `char-0001` |
| O3-missing-entity | `transform_owner_conflict`, reason `char-9999` |
| O4-camera-claim | `transform_owner_forbidden`, reason `camera` |
| O5-physics-entity-claim-by-demo | `transform_owner_forbidden`, reason `physics_entity` |
| O6-module-combination | `module_combination_unsupported` |
| O7-controller-count (0 controller entities) | `config_invalid`, reason `controller_target` |
| O8-m2-module-on-v1-scene | `config_invalid`, reason `scene_version` |

Contract note: the accepted O7 fixture encodes `controllerCount: 2`, but
`project-model` `validateSceneV2` already rejects >1 controller with
`controller_count_invalid`, so the runtime's reachable case is 0 controllers
(the scene contract text: "Zero controllers is allowed; the runtime config
layer reports `config_invalid`/`controller_target`"). The suite exercises the
reachable case.
