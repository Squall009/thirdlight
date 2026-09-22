# Packet 29 — fail-stop and lifecycle transcripts (actual run output)

All transcripts are asserted by `packages/runtime/src/m2-failstop.test.ts` and
replayed from `fixtures/m2/runtime/failstop.json` by
`tests/m2-runtime/runtime-fixtures.test.ts` (`npx vitest run packages/runtime
tests/m2-runtime`).

## F1 — throw after private-state mutation

A controller module mutates its private counter and writes `curr` in the
`transform` phase, then throws:

| Field | Observed |
|---|---|
| `state` | `failed` |
| `errors[0]` | `{ code: "module_error", reason: "module_threw", moduleId: "thirdlight.test:char-controller", phase: "transform", stepIndex: 13 }` |
| `failed` / `failedModuleId` / `failedPhase` / `failedStepIndex` | `true` / the module / `transform` / `13` |
| `stepIndex` | unchanged (last committed step) |
| `getInterpolatedState()` | equals the last committed state, `alpha = 0`; the half-written `position.x = 9` is not observable |
| `start()` / `tick()` | `{ ok: false, code: "runtime_failed" }` |
| `stop()` | `{ ok: true }` (no driver) |
| Rollback | none attempted (no transform rollback claim) |

## F2/F3 — port malformed / port throw

| Case | `errors[0]` |
|---|---|
| `port_malformed` (identity applied `≠` position − previous) | `physics_port_error`, reason `result`; the invalid result is never applied (character stays at the authored Y) |
| `port_throw` | `physics_port_error`, reason `threw` |

## F4 — phase violations

| Case | `errors[0]` |
|---|---|
| `stage_outside_controller` (staging during `transform`) | `module_error`, reason `phase_violation`, phase `transform` |
| `write_curr_in_intent` (`curr` write during `intent`) | `module_error`, reason `phase_violation`, phase `intent` |

## F5–F10 — instantiate-time rejections (no runtime instance created)

| Case | Result |
|---|---|
| duplicate_writer_registration | `transform_owner_conflict` |
| module_order_mismatch (`["transform","intent"]`) | registration `config_invalid`, reason `module_phases` |
| unsupported_combination (demo + platformer) | `module_combination_unsupported` |
| missing_physics_port | `config_invalid`, reason `physics_port` |
| controller_target (0 controller entities) | `config_invalid`, reason `controller_target` |
| scene_version (M2 module + v1 scene) | `config_invalid`, reason `scene_version` |

## F11 — idempotent teardown

| Observation | Value |
|---|---|
| module `dispose()` calls after `dispose()` + repeat `dispose()` | 1 |
| port `dispose()` calls | 1 |
| second `dispose()` | `{ ok: true, alreadyDisposed: true }` |
| live rAF callbacks after `dispose()` (rAF driver) | 0 |
| `start → stop → start → dispose ×2` | exactly one live callback per running cycle, 0 after teardown |

## F12 — safe restart after failure

| Observation | Value |
|---|---|
| snapshot after the failed run | byte-identical to the input (deep-equal JSON) |
| fresh instance from the same snapshot | runs, `errorCount = 0`, expected transform trace |
| initialize cancellation | `start()` then `stop()` before the first frame: `stepIndex 0`, `settleSteps 0`, no module call; restart runs the 12-step pre-roll exactly once |
| initialize/dispose race | `start()` then `dispose()` before the first frame: 0 live callbacks, no step, `state: "disposed"`, repeat dispose idempotent |
