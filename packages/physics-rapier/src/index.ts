/**
 * `@thirdlight/physics-rapier` — public surface (the `physics-rapier` row of
 * dependencies.md: `createPhysicsPort`, `RAPIER_PIN`,
 * `PHYSICS_IMPLEMENTATION`; the config/result types below are additive
 * type-only exports the host needs to construct an init config).
 *
 * The approved collision port (docs/contracts/runtime.md, with `physics.md`;
 * decision 0002) backed by the selected real
 * library, `@dimforge/rapier2d-compat@0.20.0`.
 *
 * - **Async initialization before runtime start** — `createPhysicsPort(config,
 *   signal?)` resolves to a ready port or a structured
 *   `physics_init_cancelled` / `physics_init_failed` result. Cancellation
 *   releases everything; no partial world and no adapter module state escapes.
 * - **Static collider creation** — one `World` per game; boxes and
 *   bounded convex polygons (validated to the project-model vocabulary)
 *   on fixed bodies, in snapshot document order.
 * - **Character movement correction/support results** — the parentless
 *   kinematic capsule (`createCharacterController(offset)` +
 *   `computeColliderMovement`/`computedMovement`/`setTranslation`) with ground
 *   snap; `grounded`/`supportNormal`/`contacts` come from the collision
 *   results, never from a floor constant.
 * - **Dispose and diagnostics** — idempotent `dispose()` frees the world;
 *   `diagnostics()` reports the library's own collider/body counts plus the
 *   bounded adapter counters.
 *
 * No second frame driver: the runtime owns stepping and calls `step()` once per
 * executed fixed step. XY only: no port method accepts or returns Z.
 *
 * Module ownership: imports `@thirdlight/runtime`
 * types and the approved Rapier pin only — no project-model internals, editor,
 * backend, protocol, workspace, commands, three or three-adapter edge.
 */
export { createPhysicsPort, physicsMemoryBytes } from './port';
export { PHYSICS_IMPLEMENTATION, RAPIER_PIN } from './constants';
export type {
  ColliderShapeBox,
  ColliderShapePolygon,
  PhysicsInitFailure,
  PhysicsInitFailureReason,
  PhysicsPortInitResult,
  PhysicsTransformReason,
  RapierCharacterSpec,
  RapierColliderShape,
  RapierControllerConfig,
  RapierFurtherCharacterSpec,
  RapierPhysicsDiagnostics,
  RapierPhysicsInitConfig,
  RapierPhysicsPort,
  RapierSolverConfig,
  RapierStaticColliderSpec,
} from './types';
export { PhysicsPortError, type PhysicsPortErrorCode } from './errors';
