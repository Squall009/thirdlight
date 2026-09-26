/**
 * The injected physics port — runtime.md §12.6 (promoted from `physics.md`
 * §5). The concrete adapter (`physics-rapier`, packet 31) implements this
 * surface; the runtime core never imports it. The runtime owns the instance
 * and hands modules only the restricted `PhysicsStepClient`.
 *
 * These are pure types plus the runtime's strict result validation: no
 * concrete physics library, no Node built-ins, no I/O.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** One static collider the runtime derives from the snapshot (physics.md §5). */
export interface StaticColliderSpec {
  entityId: string;
  /** Validated `components.collider.shape` value (opaque to the runtime core). */
  shape: unknown;
  /** World XY (root + unit scale). */
  position: Vec2;
  /** Radians, derived from the normalized z/w quaternion copy. */
  rotationZ: number;
  /** Phase 9.9: a mover's collider (posed every step with `setKinematicPositions`). */
  kinematic?: boolean;
  /** Phase 9.9: the character passes from below and the sides and lands from above. */
  oneWay?: boolean;
}

/** Phase 9.9: a ray hit (`raycast`). */
export interface RaycastHit {
  entityId: string;
  distance: number;
  normal: Vec2;
}

/** Phase 9.9: a shape for overlap queries (half extents / radius, meters). */
export type OverlapShape = { type: 'box'; hx: number; hy: number } | { type: 'circle'; radius: number };

/** The port's per-step character result (physics.md §5). */
export interface CharacterMoveResult {
  requested: Vec2;
  applied: Vec2;
  position: Vec2;
  grounded: boolean;
  supportNormal: Vec2;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  /** Phase 9.9: the collider entity the character stands on (grounded), when the port knows it. */
  groundEntityId?: string | null;
  /** Phase 9.13: how far a moving (kinematic) body moved into the character this step; the correction may exceed the request by this much. */
  kinematicSlack?: number;
}

/** Counters a port may expose (physics.md §10). */
export interface PhysicsDiagnostics {
  stallSteps?: number;
  penetrationCorrectedCount?: number;
}

/**
 * The injected physics port (physics.md §5). Initialization happens before
 * `instantiateRuntime` — the runtime only ever receives an already-initialized
 * port (`createPhysicsPort(config, signal?)` lives in the concrete adapter).
 */
export interface PhysicsPort {
  readonly implementation?: string;
  stageCharacterMove(delta: Vec2): void;
  step(): CharacterMoveResult;
  reset?(character: Vec2): void;
  diagnostics?(): PhysicsDiagnostics;
  /**
   * Phase 12 (c): add the static colliders of a loaded scene / remove those
   * of an unloaded one. Called by the runtime at a step boundary only. A port
   * without them cannot run a game whose loaded scenes carry colliders.
   */
  addStaticColliders?(specs: readonly StaticColliderSpec[]): void;
  removeStaticColliders?(entityIds: readonly string[]): void;
  /** Phase 9.9: where the kinematic (mover) colliders are after this step's move. */
  setKinematicPositions?(poses: readonly { entityId: string; position: Vec2; rotationZ: number }[]): void;
  /** Phase 9.9: ignore one-way colliders for the next `steps` steps (drop through). */
  dropThrough?(steps: number): void;
  /** Phase 9.9: the nearest collider hit by a ray (the character excluded). */
  raycast?(origin: Vec2, direction: Vec2, maxDistance: number): RaycastHit | null;
  /** Phase 9.9: the entities whose colliders overlap `shape` at `center` (the character excluded), sorted, at most 64. */
  overlap?(shape: OverlapShape, center: Vec2): string[];
  dispose(): void;
}

/** The restricted view handed to modules in `StepContext` (physics.md §5). */
export interface PhysicsStepClient {
  /**
   * Controller phase only; a second stage for one entity is `duplicate_move`.
   * @graphNode skip scripts never run in the controller phase
   */
  stageCharacterMove(entityId: string, delta: Vec2): void;
  /**
   * The last completed step's result, or `undefined` before the first step.
   * @graphPure
   * @graphNode Character result
   */
  characterResult(entityId: string): CharacterMoveResult | undefined;
  /**
   * Phase 9.9: a ray against the level's colliders (bounded per step; null when nothing is hit).
   * @graphNode Raycast
   * @graphDefault direction [1, 0, 0]
   * @graphDefault maxDistance 10
   */
  raycast?(origin: Vec2, direction: Vec2, maxDistance: number): RaycastHit | null;
  /**
   * Phase 9.9: the entities whose colliders overlap a box (center, half extents) — counted with the rays.
   * @graphNode Overlap box
   * @graphDefault half [0.5, 0.5, 0]
   */
  overlapBox?(center: Vec2, half: Vec2): string[];
  /**
   * Phase 9.9: the entities whose colliders overlap a circle — counted with the rays.
   * @graphNode Overlap circle
   * @graphDefault radius 0.5
   */
  overlapCircle?(center: Vec2, radius: number): string[];
}

/** The result of a spawn clearance probe/reset placement (gameplay.md §5.2). */
export interface CharacterClearanceResult {
  ok: boolean;
  reason?: 'blocked' | 'no_support' | 'out_of_bounds' | 'hazard' | 'query_failed';
  supportNormal?: Vec2;
  /** m, deepest overlap with a static collider. */
  penetration?: number;
}

/**
 * The M3 restricted reset/clearance port (gameplay.md §5.2 / runtime.md
 * §15.4). The accepted `PhysicsPort.reset(character)` stays
 * tests/diagnostics-only and is never called by the runtime, a module, the
 * session, the camera, a behavior, the HUD or the editor. The three
 * operations below are callable by the runtime only at the reset barrier —
 * they are NOT on `PhysicsStepClient` and NOT on `GameSessionPort` (game
 * code never receives a physics handle, physics.md §5 one-mutation-path).
 * The concrete implementation is `physics-rapier` (packet 50); the runtime
 * core carries the type only.
 */
export interface PhysicsResetPort extends PhysicsPort {
  /** Zero every cached/kinematic motion (velocity, pending correction) of the character. */
  clearCharacterMotion(): void;
  /** Re-place the capsule centre and return the resulting clearance. */
  placeCharacter(center: Vec2): CharacterClearanceResult;
  /** Query only: clearance of the capsule if placed at `center`. No mutation. */
  characterClearance(center: Vec2): CharacterClearanceResult;
}

export type CharacterMoveResultFailure = {
  reason: 'result';
  detail: string;
};

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function vec2(v: unknown): v is Vec2 {
  return (
    typeof v === 'object' &&
    v !== null &&
    finite((v as Vec2).x) &&
    finite((v as Vec2).y)
  );
}

/**
 * Strict result validation (runtime.md §12.6). Returns a failure describing
 * the first violation instead of throwing; an invalid result is never
 * partially applied.
 */
export function validateCharacterMoveResult(
  value: unknown,
  previousPosition: Vec2,
  requested: Vec2,
): { ok: true; result: CharacterMoveResult } | { ok: false; failure: CharacterMoveResultFailure } {
  const bad = (detail: string): { ok: false; failure: CharacterMoveResultFailure } => ({
    ok: false,
    failure: { reason: 'result', detail },
  });
  if (typeof value !== 'object' || value === null) return bad('result must be an object');
  const r = value as Partial<CharacterMoveResult>;
  if (!vec2(r.requested)) return bad('requested must be a finite { x, y }');
  if (!vec2(r.applied)) return bad('applied must be a finite { x, y }');
  if (!vec2(r.position)) return bad('position must be a finite { x, y }');
  if (!vec2(r.supportNormal)) return bad('supportNormal must be a finite { x, y }');
  if (typeof r.grounded !== 'boolean') return bad('grounded must be a boolean');
  if (typeof r.snapped !== 'boolean') return bad('snapped must be a boolean');
  const contacts = r.contacts;
  if (
    typeof contacts !== 'object' ||
    contacts === null ||
    typeof contacts.ground !== 'boolean' ||
    typeof contacts.wall !== 'boolean' ||
    typeof contacts.head !== 'boolean' ||
    typeof contacts.steepSlope !== 'boolean'
  ) {
    return bad('contacts must be { ground, wall, head, steepSlope } booleans');
  }
  const result = r as CharacterMoveResult;
  const normalLength = Math.hypot(result.supportNormal.x, result.supportNormal.y);
  if (Math.abs(normalLength - 1) > 1e-6) return bad('supportNormal must be unit within 1e-6');
  if (result.grounded && !(result.supportNormal.y > 0)) {
    return bad('grounded requires supportNormal.y > 0');
  }
  const dx = result.applied.x - (result.position.x - previousPosition.x);
  const dy = result.applied.y - (result.position.y - previousPosition.y);
  if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
    return bad('applied != position - previousPosition within 1e-9');
  }
  const slack = typeof (result as { kinematicSlack?: unknown }).kinematicSlack === 'number' ? Math.min(0.5, Math.max(0, (result as { kinematicSlack: number }).kinematicSlack)) : 0;
  const allowance = (result.snapped ? 0.11 : 0.001) + slack;
  const appliedLen = Math.hypot(result.applied.x, result.applied.y);
  const requestedLen = Math.hypot(requested.x, requested.y);
  if (appliedLen > requestedLen + allowance + 1e-12) {
    return bad('|applied| exceeds |requested| + allowance');
  }
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Phase 23.0: the 3D physics port. A project whose `physics_dimension` is 3
// runs on a separate 3D backend (physics-rapier's `./3d` subpath, rapier3d);
// the runtime holds this port instead of the 2D `PhysicsPort` above, which —
// with its fakes, the platformer controller and the graph codegen — stays
// exactly as it was. Positions are PhysicsVec3, rotations unit quaternions.
// ---------------------------------------------------------------------------

/** Phase 23.0: a 3D vector (m). */
export interface PhysicsVec3 {
  x: number;
  y: number;
  z: number;
}

/** Phase 23.0: a unit quaternion. */
export interface PhysicsQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Phase 23.0: one static collider of a 3D world (the entity's full transform; root, unit scale). */
export interface StaticColliderSpec3D {
  entityId: string;
  /** The validated `components.collider.shape` (a box with `hz`; opaque to the runtime core). */
  shape: unknown;
  position: PhysicsVec3;
  rotation: PhysicsQuat;
}

/** Phase 23.0: the 3D port's per-step character result (the 2D result's fields in 3D). */
export interface CharacterMoveResult3D {
  requested: PhysicsVec3;
  applied: PhysicsVec3;
  position: PhysicsVec3;
  grounded: boolean;
  supportNormal: PhysicsVec3;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  groundEntityId?: string | null;
}

/** Phase 23.0: a ray hit in 3D. */
export interface RaycastHit3D {
  entityId: string;
  distance: number;
  normal: PhysicsVec3;
}

/**
 * Phase 23.0: what a 3D port is created from (built by the hosts from the
 * snapshot and settings — game-host `physics3DConfigOf`). `dimension: 3`
 * tells a host (and the simulation worker) which backend to load.
 */
export interface PhysicsInitConfig3D {
  readonly dimension: 3;
  /** The controller entity: its origin, and its capsule (radius, centre-line half height, centre offset from the origin). */
  character: { position: PhysicsVec3; radius: number; halfHeight: number; offset: PhysicsVec3 };
  statics: readonly StaticColliderSpec3D[];
  /** The project's step rate and gravity along Y (−Y is down). */
  solver: { hz: number; gravityY: number };
  /** The character controller's tuning (the 2D controller's fields: skin, snap, slope angles, autostep). */
  controller: { offsetSkin: number; groundSnap: number; maxSlopeClimbRad: number; minSlopeSlideRad: number; autostep: boolean; autostepHeight?: number };
}

/**
 * Phase 23.0: the injected 3D physics port — initialized before
 * `instantiateRuntime` like the 2D one, stepped once per fixed step by the
 * runtime. The character is a kinematic capsule swept by the backend's
 * character controller.
 */
export interface PhysicsPort3D {
  /** The discriminant: a 3D port (the 2D `PhysicsPort` has none). */
  readonly dimension: 3;
  readonly implementation?: string;
  stageCharacterMove(delta: PhysicsVec3): void;
  step(): CharacterMoveResult3D;
  diagnostics?(): PhysicsDiagnostics;
  /** A loaded / unloaded scene's static colliders (at a step boundary). */
  addStaticColliders?(specs: readonly StaticColliderSpec3D[]): void;
  removeStaticColliders?(entityIds: readonly string[]): void;
  /** The nearest collider hit by a ray (the character excluded). */
  raycast?(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number): RaycastHit3D | null;
  dispose(): void;
}

function isVec3(v: unknown): v is PhysicsVec3 {
  return typeof v === 'object' && v !== null && finite((v as PhysicsVec3).x) && finite((v as PhysicsVec3).y) && finite((v as PhysicsVec3).z);
}

/**
 * Phase 23.0: the 3D counterpart of `validateCharacterMoveResult` — the same
 * rules on three axes (finite vectors, a unit support normal pointing up
 * while grounded, `applied == position − previousPosition` within 1e-9, the
 * correction bounded by the request plus the snap allowance).
 */
export function validateCharacterMoveResult3D(
  value: unknown,
  previousPosition: PhysicsVec3,
  requested: PhysicsVec3,
): { ok: true; result: CharacterMoveResult3D } | { ok: false; failure: CharacterMoveResultFailure } {
  const bad = (detail: string): { ok: false; failure: CharacterMoveResultFailure } => ({ ok: false, failure: { reason: 'result', detail } });
  if (typeof value !== 'object' || value === null) return bad('result must be an object');
  const r = value as Partial<CharacterMoveResult3D>;
  if (!isVec3(r.requested)) return bad('requested must be a finite { x, y, z }');
  if (!isVec3(r.applied)) return bad('applied must be a finite { x, y, z }');
  if (!isVec3(r.position)) return bad('position must be a finite { x, y, z }');
  if (!isVec3(r.supportNormal)) return bad('supportNormal must be a finite { x, y, z }');
  if (typeof r.grounded !== 'boolean') return bad('grounded must be a boolean');
  if (typeof r.snapped !== 'boolean') return bad('snapped must be a boolean');
  const c = r.contacts;
  if (typeof c !== 'object' || c === null || typeof c.ground !== 'boolean' || typeof c.wall !== 'boolean' || typeof c.head !== 'boolean' || typeof c.steepSlope !== 'boolean') {
    return bad('contacts must be { ground, wall, head, steepSlope } booleans');
  }
  const result = r as CharacterMoveResult3D;
  const n = result.supportNormal;
  if (Math.abs(Math.hypot(n.x, n.y, n.z) - 1) > 1e-6) return bad('supportNormal must be unit within 1e-6');
  if (result.grounded && !(n.y > 0)) return bad('grounded requires supportNormal.y > 0');
  const a = result.applied;
  const p = result.position;
  if (Math.abs(a.x - (p.x - previousPosition.x)) > 1e-9 || Math.abs(a.y - (p.y - previousPosition.y)) > 1e-9 || Math.abs(a.z - (p.z - previousPosition.z)) > 1e-9) {
    return bad('applied != position - previousPosition within 1e-9');
  }
  const allowance = result.snapped ? 0.11 : 0.001;
  if (Math.hypot(a.x, a.y, a.z) > Math.hypot(requested.x, requested.y, requested.z) + allowance + 1e-12) {
    return bad('|applied| exceeds |requested| + allowance');
  }
  return { ok: true, result };
}
