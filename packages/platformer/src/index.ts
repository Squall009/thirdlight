/**
 * `@thirdlight/platformer` — public surface (dependencies.md §3 `platformer`
 * row: `platformerSpec`, `PLATFORMER_MODULE_ID`, `CONTROLLER_CONSTANTS`).
 *
 * Packet 32 (`docs/contracts/runtime.md` §12, promoted from `platformer.md`
 * and `physics.md`): the pure fixed-step controller module
 * `thirdlight.platformer:controller` for the M2 2.5D character.
 *
 * - **Algorithm** — `platformer.md` §7's exact order A–K: one jump per press,
 *   variable height on release, the integer-step coyote (6) and jump-buffer
 *   (8) windows, no air/wall jump, no automatic stair climbing and the
 *   horizontal `approach()` arrival rule.
 * - **Grounding** — `physics.md` §8: from the port's collision result and
 *   support normal, never from `position.y` or `vy`; a support below the
 *   maximum climb angle is `steepSlope` and treated as not grounded.
 * - **Ports** — the module reads the frozen `StepContext` and stages exactly
 *   one character move in the `controller` phase; the runtime owns the
 *   concrete physics port and commits its result (`runtime.md` §12.1.1).
 *   The module writes no transform, holds no private world and has no
 *   timers/listeners; the runtime's 12-step settle pre-roll runs the normal
 *   phases before gameplay and the step counters on the state are integer
 *   steps (never wall time), so dropped wall time cannot replay an edge.
 *
 * Module ownership (dependencies.md §4.1/§4.3): imports `@thirdlight/runtime`
 * **types only** — no concrete physics (`physics-rapier`), no `input`, no
 * three.js, no authoring/editor/backend/workspace/protocol edge, no Node
 * built-ins and no I/O. The package is safe in the play-preview/export
 * bundles and works unchanged in the Node harness, where the injected ports
 * are the real packet-31 adapter and the real packet-30 binding.
 */
export { CONTROLLER_CONSTANTS, PLATFORMER_MODULE_ID } from './constants';
export { platformerSpec } from './controller';
