/**
 * The injected physics port. The concrete adapter (`physics-rapier`)
 * implements this surface; the runtime core never imports it. The runtime owns the instance
 * and hands modules only the restricted `PhysicsStepClient`.
 *
 * These are pure types plus the runtime's strict result validation: no
 * concrete physics library, no Node built-ins, no I/O.
 */
import type { PlaneLock } from '@thirdlight/project-model';

export interface Vec2 {
  x: number;
  y: number;
}

/** A ray hit on the caller's plane (`raycast` with {x, y}): the object, the distance and the surface normal in the plane. */
export interface RaycastHit {
  entityId: string;
  distance: number;
  normal: Vec2;
}

/** Counters a port may expose. */
export interface PhysicsDiagnostics {
  stallSteps?: number;
  /** Steps that began with the character inside a collider (moved out by the sweep). */
  penetrationCorrectedCount?: number;
  /** The deepest such overlap so far: the collider's entity, how deep (m), the port's step. */
  deepestOverlap?: { entityId: string; depth: number; step: number };
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
  characterResult(entityId?: string): CharacterMoveResult3D | undefined;
  /**
   * Lock an object's body (its collider, or its player controller's character) to an axis-aligned plane — `{ axis: 'x' | 'z', origin }`, the plane's normal and where it lies along it (m) — or free it again (null), at the next step boundary. A locked body does not move along the normal and only turns about it: locking snaps it onto the plane and drops its speed along the normal; freeing leaves it where it is, free in all six degrees of freedom. A side-view stretch of a game (and back) at any moment, with no reload. Lasts until changed, the object leaves the game or the run restarts. False without a physics world, for a bad plane or an object with neither a collider nor a player controller.
   * @graphNode Set plane
   * @graphDefault axis z
   */
  setPlane?(entityId: string, plane: PhysicsPlane | null): boolean;
  /**
   * The plane an object's body or player character is locked to now (`{ axis, origin }`), or null when it is free (or has no body).
   * @graphPure
   * @graphNode Plane of
   */
  planeOf?(entityId: string): PhysicsPlane | null;
  /**
   * Whether an object's body is suspended this step. Streaming loads collision only round the camera, its target and the players: a player character, patrol or gravity body over streamed ground whose collision is not loaded stands still (no gravity, no movement, no contacts) with its state kept, and resumes in the step that ground's collision arrives. False for anything else.
   * @graphPure
   * @graphNode Is suspended
   */
  isSuspended?(entityId: string): boolean;
  /**
   * A ray on the caller's plane: `origin` and `direction` are 2D ({x, y}: x along the plane's right, y up), the ray runs in the plane the calling object is locked to (else z = 0) and hits the colliders that cross it — the nearest one's object, its distance and the surface normal in the plane, or null. `[x, y, z]` arrays make it a 3D ray (the next form). Counted with the other queries (at most 1,024 a step).
   * @graphNode Raycast
   * @graphDefault direction [1, 0, 0]
   * @graphDefault maxDistance 10
   */
  raycast?(origin: Vec2, direction: Vec2, maxDistance: number, filter?: PhysicsQueryFilter): RaycastHit | null;
  /** A 3D ray from `origin` along `direction` ([x, y, z]) within `maxDistance` metres (default 100): the nearest collider's object, the point, the surface normal and the distance, or null. */
  raycast?(origin: readonly number[], direction: readonly number[], maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * The objects whose colliders overlap a box on the caller's plane — 2D centre and half extents ({x, y}), the plane the calling object is locked to (else z = 0); sorted ids, at most 64. `[x, y, z]` arrays make it a 3D box (the next form). Counted with the rays.
   * @graphNode Overlap box
   * @graphDefault half [0.5, 0.5, 0]
   */
  overlapBox?(center: Vec2, half: Vec2, filter?: PhysicsQueryFilter): string[];
  /** The objects whose colliders overlap a 3D box — centre, half extents [x, y, z] and an optional rotation quaternion [x, y, z, w]. */
  overlapBox?(center: readonly number[], half: readonly number[], rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * The objects whose colliders overlap a circle on the caller's plane (2D centre {x, y}; the plane the calling object is locked to, else z = 0) — counted with the rays. A sphere is `overlapSphere`.
   * @graphNode Overlap circle
   * @graphDefault radius 0.5
   */
  overlapCircle?(center: Vec2, radius: number, filter?: PhysicsQueryFilter): string[];
  /**
   * A player character's state after the last completed step
   * (`entityId`, absent: the first player controller) — position, velocity,
   * grounding, contacts, whether its controller is on and whether it is
   * climbing a ledge — or undefined (before the first step, or not a player
   * controller).
   * @graphPure
   * @graphNode Character state
   * @graphLabel entityId player
   */
  characterState?(entityId?: string): CharacterState3D | undefined;
  /**
   * The 3D `raycast` under its former name (`raycast` takes [x, y, z] the same way).
   * @graphNode Raycast 3D
   * @graphDefault direction [0, -1, 0]
   * @graphDefault maxDistance 100
   */
  raycast3d?(origin: readonly number[], direction: readonly number[], maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * The objects whose colliders overlap a sphere (sorted ids, at most 64).
   * @graphNode Overlap sphere
   * @graphDefault radius 0.5
   */
  overlapSphere?(center: readonly number[], radius: number, filter?: PhysicsQueryFilter): string[];
  /**
   * The 3D `overlapBox` under its former name (`overlapBox` takes [x, y, z] the same way).
   * @graphNode Overlap box 3D
   * @graphDefault half [0.5, 0.5, 0.5]
   */
  overlapBox3d?(center: readonly number[], half: readonly number[], rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * The objects whose colliders overlap an upright capsule (total height, end caps included), optionally turned by a quaternion [x, y, z, w].
   * @graphNode Overlap capsule
   * @graphDefault radius 0.3
   * @graphDefault height 1.8
   */
  overlapCapsule?(center: readonly number[], radius: number, height: number, rotation?: readonly number[], filter?: PhysicsQueryFilter): string[];
  /**
   * What is under a screen point (x, y 0–1 from the top left): the ray from the active camera (`ctx.camera.screenToRay`) cast into the colliders, within `maxDistance` (default 1000 m).
   * @graphNode Pick at screen point
   * @graphDefault x 0.5
   * @graphDefault y 0.5
   * @graphDefault maxDistance 1000
   */
  pickAt?(x: number, y: number, maxDistance?: number, filter?: PhysicsQueryFilter): PhysicsHit | null;
  /**
   * What is under the pointer this step (null while the pointer is outside the view or never moved); with a locked cursor, what is at the view's centre.
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
  /** A scatter copy's address when the ray hit one (then `entityId` is the terrain or layer it stands on; `ctx.scatter` takes it). */
  scatter?: string;
}

export type CharacterMoveResultFailure = {
  reason: 'result';
  detail: string;
};

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The plane a body is locked to: its normal's world axis (X or Z) and where
 * it lies along that axis (m). The project model's `plane` field.
 */
export type PhysicsPlane = PlaneLock;

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
  /** The plane its body is locked to (absent: free); the body is made on it. */
  plane?: PhysicsPlane;
  /**
   * A one-way collider: it holds only what comes at it from the side its
   * local +Y faces (a platform landed on from above, passed from below and
   * the sides).
   */
  oneWay?: boolean;
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
 * frame; a capsule and a cylinder stand along their local Y). `convex` is the hull of its
 * points and `mesh` a triangle mesh (a static collider only), both flat
 * `[x, y, z, ...]` lists.
 */
export type ColliderPrimitive3D =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  /** A cylinder along its local Y; `halfHeight` is half its full height (Rapier's convention). */
  | { type: 'cylinder'; radius: number; halfHeight: number }
  | { type: 'convex'; points: readonly number[] }
  | { type: 'mesh'; vertices: readonly number[]; indices: readonly number[] }
  /**
   * A heightfield (a static collider only; a terrain tile's): `cellsX` ×
   * `cellsZ` cells of `cellX` × `cellZ` metres from the collider's origin
   * toward +x and +z, `heights` (metres) column by column from the min-x
   * column, each `cellsZ + 1` from min z (Rapier's own order: handed over
   * without a copy-and-turn). Each cell is two triangles split from its
   * (+x, min z) corner to its (min x, +z) corner.
   */
  | { type: 'heightfield'; cellsX: number; cellsZ: number; cellX: number; cellZ: number; heights: Float32Array | readonly number[] };

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
  | { type: 'capsule'; radius: number; halfHeight: number }
  /** A cylinder standing along its local Y (a disc when thin). */
  | { type: 'cylinder'; radius: number; halfHeight: number };

/** Where a kinematic (mover) collider is after this step's move. */
export interface KinematicPose3D {
  entityId: string;
  position: PhysicsVec3;
  rotation: PhysicsQuat;
}

/** The clearance of the character capsule at a point. */
export interface CharacterClearanceResult3D {
  ok: boolean;
  reason?: 'blocked' | 'no_support';
  supportNormal?: PhysicsVec3;
  /** m, the deepest overlap with a collider. */
  penetration?: number;
}

/** The port's per-step character result. */
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

/** The tuning of a player character's controller (skin, ground snap, slope angles, autostep). */
export interface CharacterControllerTuning {
  offsetSkin: number;
  groundSnap: number;
  maxSlopeClimbRad: number;
  minSlopeSlideRad: number;
  autostep: boolean;
  autostepHeight?: number;
  /**
   * How the port climbs a step. Absent or false: lifted onto it at once.
   * True: the arcade profile's rule — lifted to the step's
   * top and moved on by its radius, after which the rest of the move drops
   * it back onto the edge, so it rides up over the edge across several
   * steps and loses speed doing so.
   */
  autostepRide?: boolean;
}

/** A player character added while the world runs (the init config's further character, its tuning given). */
export type AddedCharacter3D = NonNullable<PhysicsInitConfig3D['characters']>[number];

/**
 * What a port is created from (built by the hosts from the snapshot and
 * settings — `physics3DConfigOf`).
 */
export interface PhysicsInitConfig3D {
  /** The controller entity: its origin, and its capsule (radius, centre-line half height, centre offset from the origin); the first, when there are several. */
  character: { position: PhysicsVec3; radius: number; halfHeight: number; offset: PhysicsVec3; plane?: PhysicsPlane };
  /**
   * The further player characters (several player controllers, local co-op),
   * keyed by their object, each with its own tuning (absent: the first's).
   * Characters never collide with each other.
   */
  characters?: readonly ({ id: string; position: PhysicsVec3; radius: number; halfHeight: number; offset: PhysicsVec3; controller?: PhysicsInitConfig3D['controller']; plane?: PhysicsPlane })[];
  statics: readonly StaticColliderSpec3D[];
  /** The project's step rate and gravity along Y (−Y is down). */
  solver: { hz: number; gravityY: number };
  /** The character controller's tuning (skin, snap, slope angles, autostep). */
  controller: CharacterControllerTuning;
  /**
   * The project's named collision layers, in order (bit 1 + index;
   * bit 0 is "default"). Absent: only "default".
   */
  layers?: readonly string[];
  /**
   * The scene has no controller entity — the world holds colliders
   * for queries (picking, rays, overlaps) and movers, but no character capsule
   * (`character` is then a placeholder the port ignores; its step moves nothing).
   * Characters added later (`addCharacter`) sweep as further characters.
   */
  noCharacter?: true;
  /**
   * The world is made for a run: its statics are built at the run's start
   * (`restartWorld`, which every run begins with) instead of at creation as
   * well, so a large world is built once before its first step. A step or a
   * query before then builds them.
   */
  buildAtRunStart?: true;
}

/**
 * The injected physics port. The concrete adapter (`physics-rapier`)
 * implements it; initialization happens before `instantiateRuntime` (the
 * runtime only ever receives an already-initialized port), which steps it
 * once per fixed step. The characters are kinematic capsules swept by the
 * backend's character controller.
 */
export interface PhysicsPort3D {
  readonly implementation?: string;
  /**
   * Stage a character's move for the next step. A world with several player
   * controllers names the further characters by their object (the init
   * config's `characters`); absent: the first character.
   */
  stageCharacterMove(delta: PhysicsVec3, characterId?: string): void;
  /** Step the world once: every character sweeps its staged move; returns the first character's result. */
  step(): CharacterMoveResult3D;
  /** A further character's result of the last step (undefined: no such character, or before the first step). */
  lastResultOf?(characterId: string): CharacterMoveResult3D | undefined;
  /**
   * Hold a character still (absent id: the first) until released: `step()`
   * does not sweep it (no gravity, no move, no contacts) and keeps its last
   * result; its staged move is dropped. The runtime holds a character whose
   * ground is outside the loaded collision.
   */
  suspendCharacter?(suspended: boolean, characterId?: string): void;
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
  /**
   * Rebuild the world from the colliders it holds now, as if made afresh in
   * one fixed order, each character at its origin in `origins` (absent id:
   * the first; a character not listed keeps its place), from rest. A run
   * starts on it: a world's query structures keep the history of what moved
   * and what was added in it, and that history decides ties in a sweep (a
   * capsule on the seam of two colliders), so only a rebuilt world makes
   * every run start alike. Throws a port failure.
   */
  restartWorld?(origins?: readonly { characterId?: string; position: PhysicsVec3 }[]): void;
  /**
   * Add a player character to the world while it runs (a scene brought a
   * player controller), named by its object from then on. A world made
   * without a character takes them too.
   */
  addCharacter?(spec: AddedCharacter3D): void;
  /** Take an added character out of the world for good (its object left the game: a destroyed spawned player). */
  removeCharacter?(id: string): void;
  /**
   * Lock a collider's body to a plane, or free it (null), at a step
   * boundary: locking snaps it onto the plane and turns it only about the
   * plane's normal; a moving one is posed on the plane from then on. False:
   * no collider of that object.
   */
  setBodyPlane?(entityId: string, plane: PhysicsPlane | null): boolean;
  /**
   * Lock a character (absent id: the first) to a plane, or free it (null),
   * at a step boundary: locking snaps it onto the plane and its moves keep
   * to the plane from then on. Returns where it is now.
   */
  setCharacterPlane?(plane: PhysicsPlane | null, characterId?: string): PhysicsVec3;
  /** Let a character (absent id: the first) pass every one-way collider for the next `steps` steps. */
  dropThrough?(steps: number, characterId?: string): void;
  dispose(): void;
}

function isVec3(v: unknown): v is PhysicsVec3 {
  return typeof v === 'object' && v !== null && finite((v as PhysicsVec3).x) && finite((v as PhysicsVec3).y) && finite((v as PhysicsVec3).z);
}

/**
 * Strict result validation (finite vectors, a unit support normal pointing
 * up while grounded, `applied == position − previousPosition` within 1e-9,
 * the correction bounded by the request plus the snap allowance). Returns a
 * failure describing the first violation instead of throwing; an invalid
 * result is never partially applied.
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
  // A mover that moved into the character may push it by up to that move.
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
