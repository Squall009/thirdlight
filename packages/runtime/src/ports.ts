/**
 * The injected physics port. The concrete adapter (`physics-rapier`)
 * implements this surface; the runtime core never imports it. The runtime owns the instance
 * and hands modules only the restricted `PhysicsStepClient`.
 *
 * These are pure types plus the runtime's strict result validation: no
 * concrete physics library, no Node built-ins, no I/O.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** One static collider the runtime derives from the snapshot. */
export interface StaticColliderSpec {
  entityId: string;
  /** Validated `components.collider.shape` value (opaque to the runtime core). */
  shape: unknown;
  /** World XY (root + unit scale). */
  position: Vec2;
  /** Radians, derived from the normalized z/w quaternion copy. */
  rotationZ: number;
  /** A mover's collider (posed every step with `setKinematicPositions`). */
  kinematic?: boolean;
  /** The character passes from below and the sides and lands from above. */
  oneWay?: boolean;
}

/** A ray hit (`raycast`). */
export interface RaycastHit {
  entityId: string;
  distance: number;
  normal: Vec2;
}

/** A shape for overlap queries (half extents / radius, meters). */
export type OverlapShape = { type: 'box'; hx: number; hy: number } | { type: 'circle'; radius: number };

/** The port's per-step character result. */
export interface CharacterMoveResult {
  requested: Vec2;
  applied: Vec2;
  position: Vec2;
  grounded: boolean;
  supportNormal: Vec2;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  /** The collider entity the character stands on (grounded), when the port knows it. */
  groundEntityId?: string | null;
  /** How far a moving (kinematic) body moved into the character this step; the correction may exceed the request by this much. */
  kinematicSlack?: number;
}

/** Counters a port may expose. */
export interface PhysicsDiagnostics {
  stallSteps?: number;
  /** Steps that began with the character inside a collider (moved out by the sweep). */
  penetrationCorrectedCount?: number;
  /** The deepest such overlap so far: the collider's entity, how deep (m), the port's step. */
  deepestOverlap?: { entityId: string; depth: number; step: number };
}

/**
 * The injected physics port. Initialization happens before
 * `instantiateRuntime` — the runtime only ever receives an already-initialized
 * port (`createPhysicsPort(config, signal?)` is in the concrete adapter).
 */
export interface PhysicsPort {
  readonly implementation?: string;
  /**
   * Stage a character's move for the next step. A world with several player
   * controllers names the further characters by their object (the init
   * config's `characters`); absent: the first character.
   */
  stageCharacterMove(delta: Vec2, characterId?: string): void;
  /** Step the world once: every character sweeps its staged move; returns the first character's result. */
  step(): CharacterMoveResult;
  /** A further character's result of the last step (undefined: no such character, or before the first step). */
  lastResultOf?(characterId: string): CharacterMoveResult | undefined;
  reset?(character: Vec2, characterId?: string): void;
  diagnostics?(): PhysicsDiagnostics;
  /**
   * Add the static colliders of a loaded scene / remove those
   * of an unloaded one. Called by the runtime at a step boundary only. A port
   * without them cannot run a game whose loaded scenes carry colliders.
   */
  addStaticColliders?(specs: readonly StaticColliderSpec[]): void;
  removeStaticColliders?(entityIds: readonly string[]): void;
  /** Where the kinematic (mover) colliders are after this step's move. */
  setKinematicPositions?(poses: readonly { entityId: string; position: Vec2; rotationZ: number }[]): void;
  /** Ignore one-way colliders for the next `steps` steps (drop through), for a character (absent: the first). */
  dropThrough?(steps: number, characterId?: string): void;
  /** The nearest collider hit by a ray (the characters excluded). */
  raycast?(origin: Vec2, direction: Vec2, maxDistance: number): RaycastHit | null;
  /** The entities whose colliders overlap `shape` at `center` (the characters excluded), sorted, at most 64. */
  overlap?(shape: OverlapShape, center: Vec2): string[];
  dispose(): void;
}

/** The restricted view handed to modules in `StepContext`. */
export interface PhysicsStepClient {
  /**
   * Controller phase only; a second stage for one entity is `duplicate_move`.
   * @graphNode skip scripts never run in the controller phase
   */
  stageCharacterMove(entityId: string, delta: Vec2): void;
  /**
   * A player controller's result of the last completed step (`entityId`, absent: the first player controller), or `undefined` before the first step.
   * @graphPure
   * @graphNode Character result
   * @graphLabel entityId player
   */
  characterResult(entityId?: string): CharacterMoveResult | undefined;
  /**
   * A ray against the level's colliders (bounded per step; null when nothing is hit).
   * @graphNode Raycast
   * @graphDefault direction [1, 0, 0]
   * @graphDefault maxDistance 10
   */
  raycast?(origin: Vec2, direction: Vec2, maxDistance: number): RaycastHit | null;
  /**
   * The entities whose colliders overlap a box (center, half extents) — counted with the rays.
   * @graphNode Overlap box
   * @graphDefault half [0.5, 0.5, 0]
   */
  overlapBox?(center: Vec2, half: Vec2): string[];
  /**
   * The entities whose colliders overlap a circle — counted with the rays.
   * @graphNode Overlap circle
   * @graphDefault radius 0.5
   */
  overlapCircle?(center: Vec2, radius: number): string[];
  /**
   * 3D projects: a player character's state after the last
   * completed step (`entityId`, absent: the first player controller) —
   * position, velocity, grounding, contacts, whether its controller is on
   * and whether it is climbing a ledge — or undefined (a 2D plane, before the
   * first step, or not a player controller).
   * @graphPure
   * @graphNode Character state
   * @graphLabel entityId player
   */
  characterState?(entityId?: string): CharacterState3D | undefined;
  /**
   * 3D projects: the nearest collider a ray from `origin` along `direction` hits within `maxDistance` metres (default 100), or null — its object, the point, the surface normal and the distance. Counted with the other queries (at most 64 a step).
   * @graphNode Raycast 3D
   * @graphDefault direction [0, -1, 0]
   * @graphDefault maxDistance 100
   */
  raycast3d?(origin: readonly number[], direction: readonly number[], maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * 3D projects: the objects whose colliders overlap a sphere (sorted ids, at most 64).
   * @graphNode Overlap sphere
   * @graphDefault radius 0.5
   */
  overlapSphere?(center: readonly number[], radius: number, filter?: PhysicsQueryFilter): string[];
  /**
   * 3D projects: the objects whose colliders overlap a box — centre, half extents [x, y, z] and an optional rotation quaternion [x, y, z, w].
   * @graphNode Overlap box 3D
   * @graphDefault half [0.5, 0.5, 0.5]
   */
  overlapBox3d?(center: readonly number[], half: readonly number[], rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * 3D projects: the objects whose colliders overlap an upright capsule (total height, end caps included), optionally turned by a quaternion [x, y, z, w].
   * @graphNode Overlap capsule
   * @graphDefault radius 0.3
   * @graphDefault height 1.8
   */
  overlapCapsule?(center: readonly number[], radius: number, height: number, rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * 3D projects: what is under a screen point (x, y 0–1 from the top left): the ray from the active camera (`ctx.camera.screenToRay`) cast into the colliders, within `maxDistance` (default 1000 m).
   * @graphNode Pick at screen point
   * @graphDefault x 0.5
   * @graphDefault y 0.5
   * @graphDefault maxDistance 1000
   */
  pickAt?(x: number, y: number, maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * 3D projects: what is under the pointer this step (null while the pointer is outside the view or never moved); with a locked cursor, what is at the view's centre.
   * @graphNode Pick at pointer
   * @graphDefault maxDistance 1000
   */
  pickAtPointer?(maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
}

/** The 3D player character's state (`ctx.physics.characterState`). */
export interface CharacterState3D {
  /** Its origin (m). */
  readonly position: PhysicsVec3;
  /** How fast it moved in the last step (m/s; its actual motion, collisions included). */
  readonly velocity: PhysicsVec3;
  /** Standing on something. */
  readonly grounded: boolean;
  /** What it touched: ground, a wall, its head, a slope too steep to walk. */
  readonly contacts: { readonly ground: boolean; readonly wall: boolean; readonly head: boolean; readonly steepSlope: boolean };
  /** The normal of what it stands on (up when in the air). */
  readonly supportNormal: PhysicsVec3;
  /** The object it stands on, or null. */
  readonly groundEntityId: string | null;
  /** Its controller is on (a script may switch it off). */
  readonly enabled: boolean;
  /** Climbing onto a ledge (input is ignored until it is up). */
  readonly climbing: boolean;
  /** The way it faces, in degrees about the up axis (0: +Z). */
  readonly facing: number;
}

/** Which objects a 3D query sees (every part optional; absent: all colliders). */
export interface PhysicsQueryFilter {
  /** Only objects carrying at least one of these tags. */
  tags?: readonly string[];
  /** Only colliders in at least one of these collision layers ("default": colliders that list no layers). */
  layers?: readonly string[];
  /** Objects to skip (their ids). */
  exclude?: readonly string[];
}

/** A 3D ray or pick hit. */
export interface PhysicsHit {
  /** The object whose collider was hit. */
  entityId: string;
  /** Where the ray hit [x, y, z]. */
  point: [number, number, number];
  /** The surface normal there [x, y, z] (unit). */
  normal: [number, number, number];
  /** Metres from the ray's origin. */
  distance: number;
  /**
   * A block layer's cell when the ray hit one (then `entityId` is the layer):
   * [x, y, z] in `ctx.grid` coordinates — the cell just inside the surface.
   */
  cell?: [number, number, number];
}

/** The result of a spawn clearance probe/reset placement. */
export interface CharacterClearanceResult {
  ok: boolean;
  reason?: 'blocked' | 'no_support' | 'out_of_bounds' | 'query_failed';
  supportNormal?: Vec2;
  /** m, deepest overlap with a static collider. */
  penetration?: number;
}

/**
 * The restricted reset/clearance port. `PhysicsPort.reset(character)` stays
 * tests/diagnostics-only and is never called by the runtime, a module, a
 * behavior or the editor. The three operations below are callable by the
 * runtime only at the reset barrier — they are NOT on `PhysicsStepClient`
 * (game code never receives a physics handle: one mutation path).
 * The concrete implementation is `physics-rapier`; the runtime
 * core carries the type only.
 */
export interface PhysicsResetPort extends PhysicsPort {
  /** Zero every cached/kinematic motion (velocity, pending correction) of a character (absent: the first). */
  clearCharacterMotion(characterId?: string): void;
  /** Re-place a character's capsule centre and return the resulting clearance. */
  placeCharacter(center: Vec2, characterId?: string): CharacterClearanceResult;
  /** Query only: clearance of a character's capsule if placed at `center`. No mutation. */
  characterClearance(center: Vec2, characterId?: string): CharacterClearanceResult;
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
 * Strict result validation. Returns a failure describing
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
// The 3D physics port. A project whose `physics_dimension` is 3
// runs on a separate 3D backend (physics-rapier's `./3d` subpath, rapier3d);
// the runtime holds this port instead of the 2D `PhysicsPort` above, which —
// with its fakes, the character controller and the graph codegen — stays
// exactly as it was. Positions are PhysicsVec3, rotations unit quaternions.
// ---------------------------------------------------------------------------

/** A 3D vector (m). */
export interface PhysicsVec3 {
  x: number;
  y: number;
  z: number;
}

/** A unit quaternion. */
export interface PhysicsQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** One static collider of a 3D world (the entity's full transform; root, unit scale). */
export interface StaticColliderSpec3D {
  entityId: string;
  /**
   * The collider's shape as the port takes it (a resolved
   * `ColliderShape3D` — the entity's scale applied, a model's collision
   * geometry turned into points or triangles; opaque to the runtime core).
   */
  shape: unknown;
  position: PhysicsVec3;
  rotation: PhysicsQuat;
  /** A mover's collider (a kinematic body posed every step with `setKinematicPoses`). */
  kinematic?: boolean;
  /** The collision layers the collider is in (absent: "default"); names the config's `layers` resolve. */
  layers?: readonly string[];
  /**
   * Radians: the steepest part of this collider the character walks up — a
   * block layer's `maxSlope`. Only stricter than the character's own limit
   * matters (absent: the character's own limit alone).
   */
  maxSlope?: number;
}

/**
 * What a 3D query sees. `layers`: only colliders in at least one
 * of these collision layers ("default" — colliders without layers; a name
 * the project does not have matches nothing); `accept`: called with each
 * candidate collider's entity, false skips it (tags, exclusions — the
 * runtime's filter). Absent: every collider (the character excluded).
 */
export interface PhysicsQueryFilter3D {
  layers?: readonly string[];
  accept?: (entityId: string) => boolean;
}

/**
 * The 3D shapes a port builds (metres, in the collider's own
 * frame; a capsule stands along its local Y). `convex` is the hull of its
 * points and `mesh` a triangle mesh (a static collider only), both flat
 * `[x, y, z, ...]` lists.
 */
export type ColliderPrimitive3D =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'convex'; points: readonly number[] }
  | { type: 'mesh'; vertices: readonly number[]; indices: readonly number[] };

/**
 * A primitive, or several placed on one body (`compound`: each part at its
 * position and rotation in the body's frame; a shape off its object's origin
 * is a compound of one part).
 */
export type ColliderShape3D =
  | ColliderPrimitive3D
  | { type: 'compound'; parts: readonly { shape: ColliderPrimitive3D; position: PhysicsVec3; rotation: PhysicsQuat }[] };

/** A shape for 3D overlap queries (half extents / radius / capsule half height, metres). */
export type OverlapShape3D =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number };

/** Where a kinematic (mover) collider is after this step's move. */
export interface KinematicPose3D {
  entityId: string;
  position: PhysicsVec3;
  rotation: PhysicsQuat;
}

/** The 3D clearance of the character capsule at a point (the 2D result's fields). */
export interface CharacterClearanceResult3D {
  ok: boolean;
  reason?: 'blocked' | 'no_support';
  supportNormal?: PhysicsVec3;
  /** m, the deepest overlap with a collider. */
  penetration?: number;
}

/** The 3D port's per-step character result (the 2D result's fields in 3D). */
export interface CharacterMoveResult3D {
  requested: PhysicsVec3;
  applied: PhysicsVec3;
  position: PhysicsVec3;
  grounded: boolean;
  supportNormal: PhysicsVec3;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  groundEntityId?: string | null;
  /** How far a moving (kinematic) body moved into the character this step; the correction may exceed the request by this much. */
  kinematicSlack?: number;
}

/** A ray hit in 3D. */
export interface RaycastHit3D {
  entityId: string;
  distance: number;
  normal: PhysicsVec3;
  /** Where the ray hit (origin + unit direction × distance). */
  point?: PhysicsVec3;
}

/**
 * What a 3D port is created from (built by the hosts from the
 * snapshot and settings — game-host `physics3DConfigOf`). `dimension: 3`
 * tells a host (and the simulation worker) which backend to load.
 */
export interface PhysicsInitConfig3D {
  readonly dimension: 3;
  /** The controller entity: its origin, and its capsule (radius, centre-line half height, centre offset from the origin); the first, when there are several. */
  character: { position: PhysicsVec3; radius: number; halfHeight: number; offset: PhysicsVec3 };
  /**
   * The further player characters (several player controllers, local co-op),
   * keyed by their object, each with its own tuning (absent: the first's).
   * Characters never collide with each other.
   */
  characters?: readonly ({ id: string; position: PhysicsVec3; radius: number; halfHeight: number; offset: PhysicsVec3; controller?: PhysicsInitConfig3D['controller'] })[];
  statics: readonly StaticColliderSpec3D[];
  /** The project's step rate and gravity along Y (−Y is down). */
  solver: { hz: number; gravityY: number };
  /** The character controller's tuning (the 2D controller's fields: skin, snap, slope angles, autostep). */
  controller: { offsetSkin: number; groundSnap: number; maxSlopeClimbRad: number; minSlopeSlideRad: number; autostep: boolean; autostepHeight?: number };
  /**
   * The project's named collision layers, in order (bit 1 + index;
   * bit 0 is "default"). Absent: only "default".
   */
  layers?: readonly string[];
  /**
   * The scene has no controller entity — the world holds colliders
   * for queries (picking, rays, overlaps) and movers, but no character capsule
   * (`character` is then a placeholder the port ignores; its step moves nothing).
   */
  noCharacter?: true;
}

/**
 * The injected 3D physics port — initialized before
 * `instantiateRuntime` like the 2D one, stepped once per fixed step by the
 * runtime. The character is a kinematic capsule swept by the backend's
 * character controller.
 */
export interface PhysicsPort3D {
  /** The discriminant: a 3D port (the 2D `PhysicsPort` has none). */
  readonly dimension: 3;
  readonly implementation?: string;
  /** Stage a character's move (absent id: the first character; see the 2D port). */
  stageCharacterMove(delta: PhysicsVec3, characterId?: string): void;
  /** Step the world once: every character sweeps its staged move; returns the first character's result. */
  step(): CharacterMoveResult3D;
  /** A further character's result of the last step (undefined: no such character, or before the first step). */
  lastResultOf?(characterId: string): CharacterMoveResult3D | undefined;
  diagnostics?(): PhysicsDiagnostics;
  /** A loaded / unloaded scene's static colliders (at a step boundary). */
  addStaticColliders?(specs: readonly StaticColliderSpec3D[]): void;
  removeStaticColliders?(entityIds: readonly string[]): void;
  /** The nearest collider hit by a ray (the characters excluded; only those the filter lets through). */
  raycast?(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number, filter?: PhysicsQueryFilter3D): RaycastHit3D | null;
  /** Where the kinematic (mover) colliders go with this step's world update (after the character's sweep). */
  setKinematicPoses?(poses: readonly KinematicPose3D[]): void;
  /** The entities whose colliders overlap `shape` at `center` turned by `rotation` (the character excluded), sorted, at most 64. */
  overlap?(shape: OverlapShape3D, center: PhysicsVec3, rotation?: PhysicsQuat, filter?: PhysicsQueryFilter3D): string[];
  /** Query only — the clearance of a character's capsule (absent id: the first) if its origin were at `origin`. */
  characterClearance?(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D;
  /** Re-place a character (its origin; absent id: the first) and return its clearance there; clears its motion caches. */
  placeCharacter?(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D;
  dispose(): void;
}

function isVec3(v: unknown): v is PhysicsVec3 {
  return typeof v === 'object' && v !== null && finite((v as PhysicsVec3).x) && finite((v as PhysicsVec3).y) && finite((v as PhysicsVec3).z);
}

/**
 * The 3D counterpart of `validateCharacterMoveResult` — the same
 * rules on three axes (finite vectors, a unit support normal pointing up
 * while grounded, `applied == position − previousPosition` within 1e-9, the
 * correction bounded by the request plus the snap allowance).
 */
export function validateCharacterMoveResult3D(
  value: unknown,
  previousPosition: PhysicsVec3,
  requested: PhysicsVec3,
  /**
   * The character's step-up height and ground snap (m) — a step
   * climbed or a snap down a stair may move it that much beyond the request
   * (absent: the fixed snap allowance only).
   */
  climb?: { stepHeight: number; groundSnap: number },
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
  // A mover that moved into the character may push it by up to that move (as in 2D).
  const ks = (result as { kinematicSlack?: unknown }).kinematicSlack;
  const slack = typeof ks === 'number' && Number.isFinite(ks) ? Math.min(0.5, Math.max(0, ks)) : 0;
  const step = climb !== undefined && Number.isFinite(climb.stepHeight) ? Math.min(2, Math.max(0, climb.stepHeight)) : 0;
  const snap = climb !== undefined && Number.isFinite(climb.groundSnap) ? Math.min(1, Math.max(0, climb.groundSnap)) : 0;
  const allowance = (result.snapped ? Math.max(0.11, snap + 0.11) : 0.001) + step + slack;
  if (Math.hypot(a.x, a.y, a.z) > Math.hypot(requested.x, requested.y, requested.z) + allowance + 1e-12) {
    return bad('|applied| exceeds |requested| + allowance');
  }
  return { ok: true, result };
}
