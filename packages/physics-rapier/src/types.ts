/**
 * Adapter-local input/result shapes.
 *
 * `@thirdlight/physics-rapier` imports `@thirdlight/runtime` **types** and the
 * approved Rapier pin only (dependencies.md §4.1/§4.3). The runtime's
 * `StaticColliderSpec.shape` is deliberately opaque to the runtime core
 * (`unknown`), so this adapter validates the shape vocabulary itself and
 * defines its own accepted shape/config types.
 *
 * The config types are structural supersets of the accepted runtime.md §12.6
 * `PhysicsInitConfig`: every `PhysicsInitConfig` value is assignable, and the
 * additive optional fields carry the authored-transform facts the project
 * model already validated (`parentId`/`scale`/`rotation`) so the adapter can
 * refuse an unsupported transform instead of silently flattening it
 * (physics.md §4).
 */
import type { CharacterClearanceResult, CharacterMoveResult, OverlapShape, PhysicsResetPort, StaticColliderSpec, Vec2 } from '@thirdlight/runtime';

/** Validated collider shape vocabulary (project-model §10.7/§21.3). */
export interface ColliderShapeBox {
  type: 'box';
  hx: number;
  hy: number;
}

export interface ColliderShapePolygon {
  type: 'polygon';
  vertices: readonly (readonly [number, number])[];
}

export type RapierColliderShape = ColliderShapeBox | ColliderShapePolygon;

/**
 * One static collider: the accepted runtime.md §12.6 `StaticColliderSpec`
 * plus optional authored-transform facts. When a field is present it is
 * checked and an unsupported value is a `physics_init_failed` with the
 * project-model §21.2 reason — never flattened to a supported transform.
 */
export interface RapierStaticColliderSpec {
  entityId: string;
  /** Validated `components.collider.shape` value; re-validated here. */
  shape: unknown;
  /** World XY (root + unit scale). */
  position: Vec2;
  /** Radians, derived from the normalized `z, w` quaternion copy. */
  rotationZ: number;
  /** Authored parent when known: only absent/`null` (root) is supported. */
  parentId?: string | null;
  /** Authored scale when known: must be exactly unit scale. */
  scale?: readonly [number, number, number];
  /** Phase 9.9: on a kinematic body (a mover), posed each step. */
  kinematic?: boolean;
  /** Phase 9.9: a one-way platform (landed on from above only). */
  oneWay?: boolean;
  /** Authored quaternion when known: rotation about Z only. */
  rotation?: readonly [number, number, number, number];
}

export interface RapierSolverConfig {
  /** Phase 15.3: the project's `fixed_step_hz` setting — 60, 120 (the default) or 240. */
  hz: number;
  gravityY: number;
}

/**
 * Phase 15.3: the character controller's tuning is the player's data
 * (`controller.skin`, `groundSnap`, `autostep`, `autostepHeight`); the
 * defaults (0.01, 0.1, off) are the values the frozen traces were made with.
 */
export interface RapierControllerConfig {
  /** The gap kept from the world (m), 0.001–0.1. */
  offsetSkin: number;
  /** The maximum ground snap per step (m), 0–1. */
  groundSnap: number;
  /** Radians, from settings `max_slope_climb_deg`. */
  maxSlopeClimbRad: number;
  /** Radians, from settings `min_slope_slide_deg`. */
  minSlopeSlideRad: number;
  /** Climb steps up to `autostepHeight` without jumping. */
  autostep: boolean;
  /** The highest step autostep climbs (m, 0.01–2); required with `autostep`. */
  autostepHeight?: number;
  /** The free width a step's top needs (m; absent: the capsule radius). */
  autostepMinWidth?: number;
}

/**
 * The controller entity's authored facts. `character: { x, y }` from the
 * accepted `PhysicsInitConfig` is assignable; the optional fields carry the
 * authored transform when the host has it, so an unsupported character
 * transform (parented, scaled, tilted) is refused rather than flattened.
 */
export interface RapierCharacterSpec extends Vec2 {
  /**
   * Phase 14.0: the player's capsule (its `controller.capsule`): radius, the
   * centre-line half-height (total height = 2 × (halfHeight + radius)) and
   * the centre's offset from the entity origin. Absent = the default shape
   * (radius 0.3, half-height 0.6, no offset).
   */
  radius?: number;
  halfHeight?: number;
  offset?: Vec2;
  parentId?: string | null;
  scale?: readonly [number, number, number];
  rotation?: readonly [number, number, number, number];
}

export interface RapierPhysicsInitConfig {
  /** Authored world XY center of the controller entity (root, unit scale, upright). */
  character: RapierCharacterSpec;
  /** Snapshot document order. */
  statics: readonly RapierStaticColliderSpec[];
  solver: RapierSolverConfig;
  controller: RapierControllerConfig;
}

/**
 * The ready adapter: the M3 `PhysicsResetPort` surface (the accepted
 * `PhysicsPort` plus the §5.2 restricted reset/clearance operations, so it
 * drops into an M3 `instantiateRuntime` unchanged) with the adapter's richer
 * diagnostics and the contracted optional methods made required.
 */
export interface RapierPhysicsPort extends PhysicsResetPort {
  readonly implementation: string;
  stageCharacterMove(delta: Vec2): void;
  step(): CharacterMoveResult;
  reset(character: Vec2): void;
  /** M3 (gameplay.md §5.2): zero every cached/kinematic motion of the character. */
  clearCharacterMotion(): void;
  /** M3 (gameplay.md §5.2): re-place the capsule centre and return the resulting clearance. */
  placeCharacter(center: Vec2): CharacterClearanceResult;
  /** M3 (gameplay.md §5.2): query-only clearance of the capsule if placed at `center`. */
  characterClearance(center: Vec2): CharacterClearanceResult;
  /** Phase 12 (c): the static colliders of a loaded / unloaded scene. */
  addStaticColliders(specs: readonly StaticColliderSpec[]): void;
  removeStaticColliders(entityIds: readonly string[]): void;
  /** Phase 9.9: the entities whose colliders overlap a box or circle (the character excluded), sorted, at most 64. */
  overlap(shape: OverlapShape, center: Vec2): string[];
  diagnostics(): RapierPhysicsDiagnostics;
  dispose(): void;
}

/** Project-model §21.2 reasons an authored transform is refused. */
export type PhysicsTransformReason = 'parented' | 'scale' | 'rotation' | 'upright';

/** `createPhysicsPort` failure reasons (the codes are contract-fixed). */
export type PhysicsInitFailureReason =
  | 'invalid_config'
  | 'invalid_shape'
  | 'invalid_transform'
  | 'wasm_unavailable'
  | PhysicsTransformReason;

export interface PhysicsInitFailure {
  code: 'physics_init_failed' | 'physics_init_cancelled';
  reason?: PhysicsInitFailureReason;
  message: string;
}

export type PhysicsPortInitResult =
  | { ok: true; port: RapierPhysicsPort }
  | { ok: false; error: PhysicsInitFailure };

/**
 * Diagnostics (runtime `PhysicsDiagnostics` plus adapter counters). The two
 * runtime-read counters keep their contracted names; the rest is bounded
 * adapter state with no gameplay meaning (physics.md §7: the stall count is a
 * diagnostic, never input to gameplay).
 */
export interface RapierPhysicsDiagnostics {
  /** Packet-14 one-step horizontal stalls (passed through, never smoothed). */
  stallSteps: number;
  /** Steps whose requested movement was clamped by a contact. */
  penetrationCorrectedCount: number;
  implementation: string;
  /** Live `World` collider count (statics + the character capsule). */
  worldColliderCount: number;
  /** Live `World` rigid-body count (one fixed body per static collider). */
  worldBodyCount: number;
  staticColliderCount: number;
  characterColliderCount: number;
  steps: number;
  snapSteps: number;
  /** Steps whose downward delta was zeroed by the grounded guard. */
  groundedDownwardClampedCount: number;
  maxCorrection: number;
  /** `false` once `dispose()` has released the world. */
  live: boolean;
}
