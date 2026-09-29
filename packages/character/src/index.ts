/**
 * `@thirdlight/character` — public surface (the `character` row of
 * dependencies.md: `characterControllerSpec`, `CHARACTER_MODULE_ID`,
 * `CONTROLLER_CONSTANTS`).
 *
 * The pure fixed-step controller module `thirdlight.character:controller`
 * (`docs/contracts/runtime.md`, with the controller contract and `physics.md`).
 *
 * - **Algorithm** — the controller contract's exact order A–K: one jump per press,
 *   variable height on release, the integer-step coyote (6) and jump-buffer
 *   (8) windows, no air jump (optional wall slide and wall jump,
 *   climbing in climb volumes), no automatic stair climbing and the
 *   horizontal `approach()` arrival rule.
 * - **Grounding** — `physics.md`: from the port's collision result and
 *   support normal, never from `position.y` or `vy`; a support below the
 *   maximum climb angle is `steepSlope` and treated as not grounded.
 * - **Ports** — the module reads the frozen `StepContext` and stages exactly
 *   one character move in the `controller` phase; the runtime owns the
 *   concrete physics port and commits its result.
 *   The module writes no transform, holds no private world and has no
 *   timers/listeners; the runtime's 12-step settle pre-roll runs the normal
 *   phases before gameplay and the step counters on the state are integer
 *   steps (never wall time), so dropped wall time cannot replay an edge.
 *
 * Module ownership: imports `@thirdlight/runtime`
 * **types only** — no concrete physics (`physics-rapier`), no `input`, no
 * three.js, no authoring/editor/backend/workspace/protocol edge, no Node
 * built-ins and no I/O. The package is safe in the play-preview/export
 * bundles and works unchanged in the Node harness, where the injected ports
 * are the real Rapier adapter and the real input binding.
 */
export { CONTROLLER_CONSTANTS, CHARACTER_MODULE_ID } from './constants';
export { characterControllerSpec, type ControllerInput } from './controller';
