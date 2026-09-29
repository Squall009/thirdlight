/**
 * The Rapier 2D physics port.
 *
 * One `World` per port (one per runtime instance). Static colliders are boxes
 * or convex polygons on fixed bodies; the single character is a **parentless**
 * capsule collider driven by `world.createCharacterController(offset)` +
 * `computeColliderMovement` → `computedMovement()` → `setTranslation(...)`.
 * The parentless pattern is normative: parenting the capsule to a rigid body
 * makes the solver re-sync it toward the body and breaks the correction loop.
 *
 * The adapter owns no frame driver and no timers: the runtime calls `step()`
 * exactly once per executed fixed step. `step()`
 * applies the staged delta, runs the world pipeline update once
 * (`world.step()`, no dynamic bodies), derives grounding/support normals from
 * the collision results (never from `position.y` or `vy`) and returns the
 * correction/support result.
 */
import * as RAPIER from '@dimforge/rapier2d-compat';
import type { CharacterClearanceResult, CharacterMoveResult, OverlapShape, StaticColliderSpec, Vec2 } from '@thirdlight/runtime';

import {
  CLEARANCE_PENETRATION_EPS,
  CLEARANCE_RAY_EPS,
  CLEARANCE_SUPPORT_PROBE,
  FIXED_HZ_CHOICES,
  GROUND_NORMAL_TOLERANCE,
  DEFAULT_CAPSULE_HALF_HEIGHT,
  DEFAULT_CAPSULE_RADIUS,
  ONE_WAY_LANDING_TOLERANCE,
  PHYSICS_IMPLEMENTATION,
  INTERNAL_EDGE_PREDICTION_SLACK,
  GROUND_UP_EPS,
  INTERNAL_EDGE_TOUCH_EPS,
  INTERNAL_EDGE_PROBE,
  INTERNAL_EDGE_CONE_EPS,
  WALL_NORMAL_EPS,
} from './constants';
import { correctionError, disposedError, resetError } from './errors';
import { polygonVertexBuffer, validateColliderShape } from './shape';
import { validateControllerTransform, validateStaticTransform } from './transform';
import type {
  PhysicsInitFailure,
  PhysicsPortInitResult,
  RapierPhysicsDiagnostics,
  RapierPhysicsInitConfig,
  RapierPhysicsPort,
  RapierStaticColliderSpec,
} from './types';

/** A validated config problem, mapped to a `physics_init_failed` result. */
interface ConfigProblem {
  reason: PhysicsInitFailure['reason'];
  message: string;
}

function isFinite2(v: unknown): v is Vec2 {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Vec2).x === 'number' &&
    Number.isFinite((v as Vec2).x) &&
    typeof (v as Vec2).y === 'number' &&
    Number.isFinite((v as Vec2).y)
  );
}

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The character capsule of an init config — the player's own
 * (`character.radius`/`halfHeight`/`offset`), else the default shape.
 * `offset` is where the capsule's centre sits relative to the character
 * position the runtime works with (the entity origin): every position the
 * port takes or reports stays the entity origin, the collider sits at
 * origin + offset.
 */
interface CapsuleShape {
  radius: number;
  halfHeight: number;
  offset: Vec2;
}

function capsuleOf(config: RapierPhysicsInitConfig): CapsuleShape {
  const c = config.character;
  return {
    radius: c.radius ?? DEFAULT_CAPSULE_RADIUS,
    halfHeight: c.halfHeight ?? DEFAULT_CAPSULE_HALF_HEIGHT,
    offset: c.offset !== undefined ? { x: c.offset.x, y: c.offset.y } : { x: 0, y: 0 },
  };
}

/**
 * Validate the whole init config before any WASM/world work. Nothing is
 * silently defaulted: `hz` is one of the project step rates (60/120/240),
 * the skin, ground snap and autostep (the player's data) are in
 * their ranges, and the slope angles from the resolved settings are finite.
 */
function validateConfig(config: RapierPhysicsInitConfig): ConfigProblem | null {
  if (typeof config !== 'object' || config === null) {
    return { reason: 'invalid_config', message: 'physics init config must be an object' };
  }
  if (!isFinite2(config.character)) {
    return { reason: 'invalid_transform', message: 'character must be a finite { x, y } world position' };
  }
  const characterCheck = validateControllerTransform(config.character);
  if (!characterCheck.ok) {
    return { reason: characterCheck.reason, message: characterCheck.detail };
  }
  // The character's capsule (optional; the default when absent).
  const ch = config.character;
  if (ch.radius !== undefined && (!finiteNumber(ch.radius) || ch.radius <= 0 || ch.radius > 1e3)) {
    return { reason: 'invalid_config', message: 'character.radius must be a finite number in (0, 1000]' };
  }
  if (ch.halfHeight !== undefined && (!finiteNumber(ch.halfHeight) || ch.halfHeight < 0 || ch.halfHeight > 1e3)) {
    return { reason: 'invalid_config', message: 'character.halfHeight must be a finite number in [0, 1000]' };
  }
  if (ch.offset !== undefined && !isFinite2(ch.offset)) {
    return { reason: 'invalid_config', message: 'character.offset must be a finite { x, y }' };
  }
  const solver = config.solver;
  if (typeof solver !== 'object' || solver === null) {
    return { reason: 'invalid_config', message: 'solver config is required' };
  }
  if (!FIXED_HZ_CHOICES.includes(solver.hz)) {
    return { reason: 'invalid_config', message: `solver.hz must be one of ${FIXED_HZ_CHOICES.join(', ')}` };
  }
  if (!finiteNumber(solver.gravityY)) {
    return { reason: 'invalid_config', message: 'solver.gravityY must be a finite number' };
  }
  const cc = config.controller;
  if (typeof cc !== 'object' || cc === null) {
    return { reason: 'invalid_config', message: 'controller config is required' };
  }
  if (!finiteNumber(cc.offsetSkin) || cc.offsetSkin < 0.001 || cc.offsetSkin > 0.1) {
    return { reason: 'invalid_config', message: 'controller.offsetSkin must be a finite number in [0.001, 0.1] m' };
  }
  if (!finiteNumber(cc.groundSnap) || cc.groundSnap < 0 || cc.groundSnap > 1) {
    return { reason: 'invalid_config', message: 'controller.groundSnap must be a finite number in [0, 1] m' };
  }
  if (typeof cc.autostep !== 'boolean') {
    return { reason: 'invalid_config', message: 'controller.autostep must be true or false' };
  }
  if (cc.autostep && (!finiteNumber(cc.autostepHeight) || cc.autostepHeight < 0.01 || cc.autostepHeight > 2)) {
    return { reason: 'invalid_config', message: 'controller.autostep needs autostepHeight, a finite number in [0.01, 2] m' };
  }
  if (cc.autostepMinWidth !== undefined && (!finiteNumber(cc.autostepMinWidth) || cc.autostepMinWidth <= 0 || cc.autostepMinWidth > 10)) {
    return { reason: 'invalid_config', message: 'controller.autostepMinWidth must be a finite number in (0, 10] m' };
  }
  if (
    !finiteNumber(cc.maxSlopeClimbRad) ||
    cc.maxSlopeClimbRad <= 0 ||
    cc.maxSlopeClimbRad >= Math.PI / 2
  ) {
    return {
      reason: 'invalid_config',
      message: 'controller.maxSlopeClimbRad must be a finite angle in (0, pi/2)',
    };
  }
  if (
    !finiteNumber(cc.minSlopeSlideRad) ||
    cc.minSlopeSlideRad < 0 ||
    cc.minSlopeSlideRad >= Math.PI / 2
  ) {
    return {
      reason: 'invalid_config',
      message: 'controller.minSlopeSlideRad must be a finite angle in [0, pi/2)',
    };
  }
  if (!Array.isArray(config.statics)) {
    return { reason: 'invalid_config', message: 'statics must be an array of static collider specs' };
  }
  for (let i = 0; i < config.statics.length; i += 1) {
    const spec = config.statics[i] as RapierStaticColliderSpec;
    if (typeof spec !== 'object' || spec === null) {
      return { reason: 'invalid_config', message: `statics[${i}] must be an object` };
    }
    const label = `statics[${i}](${String(spec.entityId)})`;
    if (typeof spec.entityId !== 'string' || spec.entityId.length === 0) {
      return { reason: 'invalid_config', message: `${label}: entityId must be a non-empty string` };
    }
    const transform = validateStaticTransform(spec, label);
    if (!transform.ok) return { reason: transform.reason, message: transform.detail };
    const shape = validateColliderShape(spec.shape);
    if (!shape.ok) return { reason: 'invalid_shape', message: `${label}: ${shape.detail}` };
  }
  return null;
}

/** Rejection used to unwind a cancelled initialization. */
const CANCELLED = Symbol('physics-init-cancelled');

/**
 * The Rapier module's WebAssembly memory, noted when the library
 * instantiates it (its only allocation arena: every world, body and collider
 * is there). The library does not expose it, so the first init watches
 * `WebAssembly.instantiate` for the instance it creates and restores the
 * function right after.
 */
let wasmMemory: { buffer: ArrayBuffer } | null = null;
let memoryWatched = false;

function watchInstantiate(): () => void {
  const wasm = (globalThis as { WebAssembly?: { instantiate: (...a: unknown[]) => Promise<unknown> } }).WebAssembly;
  if (memoryWatched || wasm === undefined || typeof wasm.instantiate !== 'function') return () => undefined;
  memoryWatched = true;
  const original = wasm.instantiate;
  wasm.instantiate = function (this: unknown, ...a: unknown[]) {
    return original.apply(this, a).then((r) => {
      const inst = (r as { instance?: { exports?: Record<string, unknown> } }).instance ?? (r as { exports?: Record<string, unknown> });
      const mem = inst?.exports?.['memory'] as { buffer?: unknown } | undefined;
      if (mem !== undefined && wasmMemory === null && mem.buffer instanceof ArrayBuffer) wasmMemory = mem as { buffer: ArrayBuffer };
      return r;
    });
  };
  return () => {
    if (wasm.instantiate !== original) wasm.instantiate = original;
  };
}

/** The physics engine's WebAssembly memory in bytes (null before the first init, or when it could not be seen). */
export function physicsMemoryBytes(): number | null {
  return wasmMemory !== null ? wasmMemory.buffer.byteLength : null;
}

function awaitInit(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(CANCELLED);
      return;
    }
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(CANCELLED);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // No module-level adapter state: the library's own `init()` is idempotent
    // and safe to call concurrently (verified), so a cancelled init leaves
    // nothing behind and a later init succeeds.
    const unwatch = watchInstantiate();
    RAPIER.init().then(
      () => {
        unwatch();
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        unwatch();
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function cancelledResult(): PhysicsPortInitResult {
  return {
    ok: false,
    error: {
      code: 'physics_init_cancelled',
      message:
        'physics initialization was cancelled before completion; nothing was allocated ' +
        '(no partial world and no adapter module state) — a later init is unaffected',
    },
  };
}

function failedResult(
  reason: PhysicsInitFailure['reason'],
  message: string,
): PhysicsPortInitResult {
  return { ok: false, error: { code: 'physics_init_failed', reason, message } };
}

/** What the port knows about a level collider. */
interface ColliderInfo {
  entityId: string;
  oneWay: boolean;
  body: RAPIER.RigidBody;
  /** Height of the collider's top above its body origin (for one-way tests). */
  top: number;
  /** A mover's kinematic body (fixed at creation). */
  kinematic: boolean;
  /** A one-way collider's world top for the current sweep. */
  topNow: number;
  /** The body's position for the current sweep, and the shape's reach from it. */
  xNow: number;
  yNow: number;
  reach: number;
}

/** One fixed (or, for a mover, kinematic) body + collider for a collider spec (the body is what removal frees). */
function addStaticBody(
  world: RAPIER.World,
  spec: RapierStaticColliderSpec,
): { ok: true; body: RAPIER.RigidBody; collider: RAPIER.Collider; top: number; reach: number } | { ok: false; detail: string } {
  const shape = validateColliderShape(spec.shape);
  if (!shape.ok) return { ok: false, detail: shape.detail };
  let desc: RAPIER.ColliderDesc | null;
  const sin = Math.sin(spec.rotationZ);
  const cos = Math.cos(spec.rotationZ);
  let top: number;
  // The farthest point of the shape from the body origin.
  let reach: number;
  if (shape.shape.type === 'box') {
    desc = RAPIER.ColliderDesc.cuboid(shape.shape.hx, shape.shape.hy);
    top = Math.abs(shape.shape.hx * sin) + Math.abs(shape.shape.hy * cos);
    reach = Math.hypot(shape.shape.hx, shape.shape.hy);
  } else {
    const buffer = polygonVertexBuffer(shape.shape);
    desc = buffer ? RAPIER.ColliderDesc.convexHull(buffer) : null;
    if (!desc) return { ok: false, detail: 'polygon vertices do not form a convex hull' };
    top = -Infinity;
    reach = 0;
    for (const v of (shape.shape as { vertices: readonly (readonly number[])[] }).vertices) reach = Math.max(reach, Math.hypot(v[0] ?? 0, v[1] ?? 0));
    for (const v of (shape.shape as { vertices: readonly (readonly number[])[] }).vertices) top = Math.max(top, (v[0] ?? 0) * sin + (v[1] ?? 0) * cos);
  }
  const bodyDesc = spec.kinematic === true ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc.setTranslation(spec.position.x, spec.position.y));
  const collider = world.createCollider(desc.setRotation(spec.rotationZ), body);
  return { ok: true, body, collider, top, reach };
}

function createAdapter(
  world: RAPIER.World,
  characterCollider: RAPIER.Collider,
  controller: RAPIER.KinematicCharacterController,
  config: RapierPhysicsInitConfig,
  staticBodies: Map<string, RAPIER.RigidBody>,
  colliderInfo: Map<number, ColliderInfo>,
): RapierPhysicsPort {
  // Mover poses for this step, one-way drop-through, the ground entity.
  let kinematicPoses: readonly { entityId: string; position: Vec2; rotationZ: number }[] = [];
  /** Where each kinematic body was posed last, and the largest move of the last world step. */
  const kinematicAt = new Map<string, Vec2>();
  let kinematicMoved = 0;
  let dropSteps = 0;
  // The one-way and the kinematic colliders, listed when colliders
  // come or go, so a step visits only those (not every level collider through
  // WASM) and makes no per-step collections.
  const oneWayList: ColliderInfo[] = [];
  const kinematicList: ColliderInfo[] = [];
  const stilled: RAPIER.RigidBody[] = [];
  // The one-way predicate of the current sweep (one function; the sweep's feet and rising flag in these).
  let sweepFeet = 0;
  let sweepRising = false;
  const oneWayPredicate = (collider: RAPIER.Collider): boolean => {
    const info = colliderInfo.get(collider.handle);
    if (info === undefined || !info.oneWay) return true;
    if (dropSteps > 0 || sweepRising) return false;
    return sweepFeet >= info.topNow - ONE_WAY_LANDING_TOLERANCE;
  };
  const relist = (): void => {
    oneWayList.length = 0;
    kinematicList.length = 0;
    for (const info of colliderInfo.values()) {
      if (info.oneWay) oneWayList.push(info);
      if (info.kinematic) kinematicList.push(info);
    }
  };
  relist();
  // The player's capsule; the collider sits at the character position + offset.
  const cap = capsuleOf(config);
  const off = cap.offset;
  const feetOffset = cap.halfHeight + cap.radius;
  const at2 = (p: Vec2): Vec2 => ({ x: p.x + off.x, y: p.y + off.y });
  const groundUnder = (at: Vec2): string | null => {
    const hit = world.castRay(new RAPIER.Ray({ x: at.x + off.x, y: at.y + off.y - feetOffset + 0.05 }, { x: 0, y: -1 }), 0.2, true, undefined, undefined, characterCollider);
    return hit === null ? null : (colliderInfo.get(hit.collider.handle)?.entityId ?? null);
  };
  const floorNormalUnder = (at: Vec2): Vec2 | null => {
    const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: at.x + off.x, y: at.y + off.y - feetOffset + 0.05 }, { x: 0, y: -1 }), 0.2, true, undefined, undefined, characterCollider);
    if (hit === null) return null;
    const len = Math.hypot(hit.normal.x, hit.normal.y);
    return len > 0 ? { x: hit.normal.x / len, y: hit.normal.y / len } : null;
  };
  // Internal edges. Rapier grounds the character on any contact
  // within its ground prediction whose normal points up at all, collider by
  // collider. Where static colliders share a face (tiles in a row, boxes
  // stacked into a wall) a collider's corner on that shared face is not on
  // the surface of the union, yet its contact normal tilts up: a character
  // sliding down a stacked wall is "grounded" at every seam and hangs there.
  // A contact is internal when its point on collider A lies inside another
  // static collider B, or on B's boundary with a normal outside B's normal
  // cone there (B is convex, so the point pushed out along the normal then
  // projects back onto B somewhere else). The union's real surface near that
  // point belongs to B, and B's own contact speaks for it. Rapier's grounding
  // is refused only when an internal contact is found and no real one is, so
  // a level without shared faces moves exactly as before.
  const edgeCapsule = new RAPIER.Capsule(cap.halfHeight, cap.radius);
  const groundPrediction = config.controller.offsetSkin + config.controller.groundSnap + INTERNAL_EDGE_PREDICTION_SLACK;
  const edgeCandidates: RAPIER.Collider[] = [];
  const solidStatic = (collider: RAPIER.Collider): boolean => {
    const info = colliderInfo.get(collider.handle);
    return info !== undefined && !info.oneWay && !info.kinematic;
  };
  const isInternalPoint = (a: RAPIER.Collider, p: Vec2, n: Vec2): boolean => {
    const tol = Math.max(INTERNAL_EDGE_TOUCH_EPS, 4e-7 * Math.max(Math.abs(p.x), Math.abs(p.y)));
    for (let j = 0; j < edgeCandidates.length; j += 1) {
      const b = edgeCandidates[j]!;
      if (b === a || !solidStatic(b)) continue;
      const touch = b.projectPoint(p, false);
      if (touch === null) continue;
      const off = Math.hypot(touch.point.x - p.x, touch.point.y - p.y);
      if (touch.isInside && off > tol) return true; // buried inside B: overlapping colliders
      if (off > tol) continue; // B does not touch p
      // p is on B's boundary (or inside it): is n in B's normal cone at p?
      const q = { x: p.x + n.x * INTERNAL_EDGE_PROBE, y: p.y + n.y * INTERNAL_EDGE_PROBE };
      const back = b.projectPoint(q, true);
      if (back === null) continue;
      if (back.isInside) return true;
      if (Math.hypot(back.point.x - p.x, back.point.y - p.y) > INTERNAL_EDGE_CONE_EPS) return true;
    }
    return false;
  };
  /**
   * The ground-like contacts (normal up, within the ground prediction) of the
   * capsule centred at `center`: 1 when one is real, -1 when all are
   * internal (and there is one), 0 when there is none.
   */
  const groundContacts = (center: Vec2): -1 | 0 | 1 => {
    const c = at2(center);
    edgeCandidates.length = 0;
    const half = { x: cap.radius + groundPrediction + 0.01, y: cap.halfHeight + cap.radius + groundPrediction + 0.01 };
    world.collidersWithAabbIntersectingAabb(c, half, (collider) => {
      if (collider !== characterCollider) edgeCandidates.push(collider);
      return true;
    });
    let internal = false;
    for (let i = 0; i < edgeCandidates.length; i += 1) {
      const a = edgeCandidates[i]!;
      const k = a.contactShape(edgeCapsule, c, 0, groundPrediction);
      if (k === null || k.distance > groundPrediction) continue;
      const len = Math.hypot(k.normal1.x, k.normal1.y);
      if (!(len > 0) || !(k.normal1.y / len > GROUND_UP_EPS)) continue;
      const n = { x: k.normal1.x / len, y: k.normal1.y / len };
      if (solidStatic(a) && isInternalPoint(a, { x: k.point1.x, y: k.point1.y }, n)) internal = true;
      else return 1;
    }
    return internal ? -1 : 0;
  };
  /**
   * The move to sweep again when Rapier held a falling
   * character against a wall (see the step), or null. Reads the result of
   * the `computeColliderMovement` just run for (`requestedX`, `commandedY`).
   */
  const wallSlideRetry = (requestedX: number, commandedY: number): Vec2 | null => {
    if (!(commandedY < -1e-6)) return null;
    const moved = controller.computedMovement();
    if (moved.y < commandedY * 0.5) return null;
    const n = controller.numComputedCollisions();
    if (n === 0) return null;
    let x = requestedX;
    for (let i = 0; i < n; i += 1) {
      const hit = controller.computedCollision(i);
      // Only fixed level colliders: a mover's side keeps Rapier's own response (the carry rules decide what it may carry).
      if (!hit || hit.collider === null || !solidStatic(hit.collider)) return null;
      const len = Math.hypot(hit.normal1.x, hit.normal1.y);
      if (!(len > 0) || Math.abs(hit.normal1.y / len) > WALL_NORMAL_EPS) return null;
      const nx = hit.normal1.x / len;
      if (x * nx < 0) x = 0; // the part into this wall
    }
    return x === requestedX ? null : { x, y: commandedY };
  };
  const climbCos = Math.cos(config.controller.maxSlopeClimbRad);
  const snapDistance = config.controller.groundSnap;
  // The skin (the correction bound's ground-offset part) and the autostep lift.
  const skin = config.controller.offsetSkin;
  const stepLift = config.controller.autostep ? (config.controller.autostepHeight ?? 0.25) : 0;
  // The authoritative character position is kept as a double here. Rapier
  // WASM stores collider translations as 32-bit floats, so the reported
  // `position`/`applied` are derived from this double (never from
  // `collider.translation()`): the f32 quantization stays a collision-proxy
  // detail, cannot leak into the runtime's `applied == position -
  // previousPosition` (1e-9) rule, and does not accumulate over steps.
  let position: Vec2 = { x: config.character.x, y: config.character.y };
  let staged: Vec2 | null = null;
  let grounded = false;
  let retainedSupport: Vec2 = { x: 0, y: 1 };
  let disposed = false;
  let released: RapierPhysicsDiagnostics | null = null;

  let steps = 0;
  let stallSteps = 0;
  let snapSteps = 0;
  let groundedDownwardClampedCount = 0;
  let penetrationCorrectedCount = 0;
  let maxCorrection = 0;

  const assertLive = (operation: string): void => {
    if (disposed) throw disposedError(operation);
  };

  function counters(): RapierPhysicsDiagnostics {
    // The live counts come from the library's own sets (`world.colliders` /
    // `world.bodies`), never from an adapter-side tally: that is what makes
    // the resource-release evidence about the real world.
    return {
      stallSteps,
      penetrationCorrectedCount,
      implementation: PHYSICS_IMPLEMENTATION,
      worldColliderCount: world.colliders.len(),
      worldBodyCount: world.bodies.len(),
      staticColliderCount: config.statics.length,
      characterColliderCount: 1,
      steps,
      snapSteps,
      groundedDownwardClampedCount,
      maxCorrection,
      live: true,
    };
  }

  /**
   * The clearance probe (query-only, no mutation): the clearance of the
   * capsule if its centre were placed at `center`.
   *
   * - **blocked** — the capsule body overlaps a static collider. Detected with
   *   a per-collider `contactShape` (narrow-phase only, so it is independent of
   *   the broadphase state): a `distance` more negative than
   *   `CLEARANCE_PENETRATION_EPS` is a real overlap (a touch at distance ≈ 0 is
   *   not a block). `penetration` is the deepest overlap (the minimum escape
   *   distance, `-distance`).
   * - **no_support** — nothing to stand on: a per-collider downward ray from
   *   the capsule's lowest point (`centre.y − (halfHeight + radius)`) finds no
   *   static collider within `CLEARANCE_SUPPORT_PROBE`. Per-collider ray casts
   *   are narrow-phase only (no broadphase), so the probe is valid even before
   *   the first `world.step()`.
   * - otherwise **ok** with the support normal of the nearest ground hit.
   *
   * The probe only ever inspects the static colliders (the character collider
   * is skipped by identity) — it never reads or moves the live character.
   */
  function computeClearance(center: Vec2): CharacterClearanceResult {
    const capsule = new RAPIER.Capsule(cap.halfHeight, cap.radius);
    const c = at2(center);
    // 1. blocked: the deepest capsule-vs-static overlap.
    let blocked = false;
    let maxPenetration = 0;
    // A one-way platform never blocks a spawn — the character
    // passes up through it (the sweep ignores it while the feet are below its
    // top), so a spawn inside one is free; it only supports feet on its top.
    const feet = c.y - feetOffset;
    const ignoredOneWay = (collider: RAPIER.Collider, forSupport: boolean): boolean => {
      const info = colliderInfo.get(collider.handle);
      if (info === undefined || !info.oneWay) return false;
      return !forSupport || feet < info.body.translation().y + info.top - ONE_WAY_LANDING_TOLERANCE;
    };
    world.colliders.forEach((collider) => {
      if (collider === characterCollider) return; // the probe is against statics only
      if (ignoredOneWay(collider, false)) return;
      const contact = collider.contactShape(capsule, { x: c.x, y: c.y }, 0, 0);
      if (contact !== null && contact.distance < -CLEARANCE_PENETRATION_EPS) {
        blocked = true;
        const pen = -contact.distance;
        if (pen > maxPenetration) maxPenetration = pen;
      }
    });
    if (blocked) {
      return { ok: false, reason: 'blocked', penetration: maxPenetration };
    }
    // 2. no_support: a downward ray from the capsule's lowest point.
    const ray = new RAPIER.Ray(
      { x: c.x, y: c.y - feetOffset + CLEARANCE_RAY_EPS },
      { x: 0, y: -1 },
    );
    let supportNormal: Vec2 | null = null;
    let bestToi = Infinity;
    world.colliders.forEach((collider) => {
      if (collider === characterCollider) return;
      if (ignoredOneWay(collider, true)) return;
      const hit = collider.castRayAndGetNormal(ray, CLEARANCE_SUPPORT_PROBE, true);
      if (hit !== null && hit.timeOfImpact < bestToi) {
        bestToi = hit.timeOfImpact;
        supportNormal = { x: hit.normal.x, y: hit.normal.y };
      }
    });
    if (supportNormal === null) {
      return { ok: false, reason: 'no_support' };
    }
    return { ok: true, supportNormal, penetration: 0 };
  }

  return {
    implementation: PHYSICS_IMPLEMENTATION,

    stageCharacterMove(delta: Vec2): void {
      assertLive('stageCharacterMove');
      staged = { x: delta.x, y: delta.y };
    },

    step(): CharacterMoveResult {
      assertLive('step');
      const requested: Vec2 = staged ?? { x: 0, y: 0 };
      staged = null;
      // Collision-correction guard: a non-finite delta can never be swept.
      // Rapier silently returns a zero movement for NaN input, which would
      // hide a missing correction — refuse it instead and leave the capsule
      // where it was (the runtime fail-stops on the thrown error).
      if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) {
        throw correctionError(
          `staged movement must be a finite { x, y } (got { x: ${String(requested.x)}, y: ${String(requested.y)} })`,
        );
      }
      // Contract guard: never command a downward
      // delta while grounded — the degenerate path is unreachable through the
      // accepted controller, and this keeps it clean if it is ever reached.
      let commandedY = requested.y;
      if (grounded && commandedY < 0) {
        commandedY = 0;
        groundedDownwardClampedCount += 1;
      }
      // The sweep starts from the collider's current position (the f32
      // rounding of the authoritative double) and the collider is written
      // only once per step, after the move — exactly the documented
      // `computeColliderMovement` → `computedMovement` → `setTranslation`
      // pattern. `before` is the authoritative double.
      const before = position;
      // A one-way collider only counts when the feet are on or above
      // its top and the character is not rising (and not while dropping through).
      const rising = commandedY > 1e-9;
      const feet = before.y + off.y - feetOffset;
      // The predicate runs inside Rapier's query (a callback from WASM): it
      // must not call back into the world, so the platform tops are read first.
      for (let i = 0; i < oneWayList.length; i += 1) {
        const info = oneWayList[i]!;
        const t = info.body.translation();
        info.xNow = t.x;
        info.yNow = t.y;
        info.topNow = t.y + info.top;
      }
      sweepFeet = feet;
      sweepRising = rising;
      if (dropSteps > 0) dropSteps -= 1;
      // The predicate (a call from WASM per candidate collider) is
      // passed only when it could refuse a collider the sweep can reach — a
      // one-way collider near the capsule's swept box while rising, dropping
      // through or with its top above the feet. Otherwise it would accept every
      // candidate, which is the same as no predicate. "Near" is generous: the
      // shape's reach plus the capsule, the move, the skin, the snap and step
      // distances and a metre, beyond any box Rapier's query can test.
      let excludes = false;
      if (oneWayList.length > 0) {
        const cx = before.x + off.x;
        const cy = before.y + off.y;
        const margin = cap.radius + cap.halfHeight + Math.abs(requested.x) + Math.abs(commandedY) + skin + snapDistance + stepLift + 1;
        const refuseAll = dropSteps > 0 || rising;
        for (let i = 0; i < oneWayList.length; i += 1) {
          const info = oneWayList[i]!;
          const near = info.reach + margin;
          if (!(Math.abs(info.xNow - cx) <= near && Math.abs(info.yNow - cy) <= near)) continue;
          if (refuseAll || !(feet >= info.topNow - ONE_WAY_LANDING_TOLERANCE)) {
            excludes = true;
            break;
          }
        }
      }
      const oneWayFilter = excludes ? oneWayPredicate : undefined;
      // Rapier's character controller drags the character along
      // with a kinematic body it touches (the body's velocity along the
      // contact, "kinematic friction"). Against the side of a mover that
      // rises past the character — a gate opening, a pillar rising — that
      // lifts the character up the wall and wedges it. A mover moving mostly
      // upward only carries a character that is above it (the capsule's
      // centre over the mover's top: standing on it, or scooped at its edge,
      // which the runtime's carry and push already move); beside or under it,
      // its velocity is hidden from this sweep, so it can only push the
      // character sideways (the runtime's mover push) and never up.
      // A position-based kinematic body keeps the velocity of its last move
      // and ignores `setLinvel`, so for the sweep it is made velocity-based at
      // rest and turned back right after; its next pose is set below, and the
      // world step derives its velocity from that pose as always.
      const centreY = before.y + off.y;
      stilled.length = 0;
      for (let i = 0; i < kinematicList.length; i += 1) {
        const info = kinematicList[i]!;
        const body = info.body;
        if (body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) continue;
        const v = body.linvel();
        if (!(v.y > 0 && v.y >= Math.abs(v.x))) continue;
        if (centreY >= body.translation().y + info.top) continue;
        body.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, false);
        body.setLinvel({ x: 0, y: 0 }, false);
        body.setAngvel(0, false);
        stilled.push(body);
      }
      // Rapier also grounds (and snaps down) from where the sweep
      // starts. An airborne character whose only ground-like contacts there
      // are internal edges (sliding down a stacked wall past a seam) sweeps
      // without the snap, so the seam neither catches nor pulls it.
      const startGround = grounded ? 1 : groundContacts(before);
      if (startGround === -1) controller.disableSnapToGround();
      controller.computeColliderMovement(characterCollider, { x: requested.x, y: commandedY }, undefined, undefined, oneWayFilter);
      // A falling character pressed against a wall on its
      // left is held there by Rapier 0.20.0: the sweep hits the wall and
      // keeps almost none of the fall (on the right the same wall lets it
      // slide). When a falling sweep keeps less than half its fall and every
      // contact is a fixed vertical wall the move presses into, the move is swept
      // again with the part into the wall taken out: the slide along it the
      // wall allows. Nothing else changes, so every other sweep is as before.
      const wallSlide = wallSlideRetry(requested.x, commandedY);
      if (wallSlide !== null) {
        // The slide is swept with the capsule narrowed by half the skin (and
        // as tall), so it cannot graze the wall it slides along (Rapier's
        // larger normal nudge helps less and pushes the capsule off the wall);
        // the capsule is restored right after.
        const narrow = Math.min(skin / 2, cap.radius / 4);
        characterCollider.setRadius(cap.radius - narrow);
        characterCollider.setHalfHeight(cap.halfHeight + narrow);
        controller.computeColliderMovement(characterCollider, wallSlide, undefined, undefined, oneWayFilter);
        characterCollider.setRadius(cap.radius);
        characterCollider.setHalfHeight(cap.halfHeight);
      }
      if (startGround === -1) controller.enableSnapToGround(snapDistance);
      for (let i = 0; i < stilled.length; i += 1) stilled[i]!.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
      const movement = controller.computedMovement();
      const next = { x: before.x + movement.x, y: before.y + movement.y };
      if (
        !Number.isFinite(movement.x) ||
        !Number.isFinite(movement.y) ||
        !Number.isFinite(next.x) ||
        !Number.isFinite(next.y)
      ) {
        throw correctionError(
          `character controller produced a non-finite correction ` +
            `(movement { x: ${String(movement.x)}, y: ${String(movement.y)} })`,
        );
      }

      // Collect contact normals from this step's collision results. The
      // obstacle's outward normal (`normal1`) is the support normal: (0, 1)
      // on flat ground. Grounding is never derived from `position.y` or `vy`.
      let bestNormal: Vec2 | null = null;
      let wall = wallSlide !== null; // the held sweep's wall (the retry slides along it without touching)
      let head = false;
      const collisions = controller.numComputedCollisions();
      for (let i = 0; i < collisions; i += 1) {
        const hit = controller.computedCollision(i);
        if (!hit) continue;
        const len = Math.hypot(hit.normal1.x, hit.normal1.y);
        if (!(len > 0)) continue;
        const unit = { x: hit.normal1.x / len, y: hit.normal1.y / len };
        if (!bestNormal || unit.y > bestNormal.y) bestNormal = unit;
        if (Math.abs(unit.x) > climbCos) wall = true;
        if (unit.y < -climbCos) head = true;
      }
      // Rapier's ground flag (its snap correction is what `snapped` describes),
      // then the same flag with internal-edge contacts removed.
      const rapierGrounded = controller.computedGrounded();
      // Refused when the capsule has no real ground-like contact where the
      // sweep ended, and an internal one there or where it started.
      let rawGrounded = rapierGrounded;
      if (rawGrounded) {
        const endGround = groundContacts(next);
        if (endGround === -1 || (endGround === 0 && startGround === -1)) rawGrounded = false;
      }
      // The measured 0.20.0 behavior: the one-time ground-offset/penetration
      // push-out is NOT reported in `numComputedCollisions()` (it is not a
      // sweep collision), but its direction is the surface normal. Recover it
      // from the correction, so the support normal still comes from the
      // collision response rather than from a floor constant. The last
      // observed support is retained while the controller reports ground with
      // no new contact information (a resting character).
      if (!bestNormal && rawGrounded) {
        const extraX = movement.x - requested.x;
        const extraY = movement.y - commandedY;
        const extraLength = Math.hypot(extraX, extraY);
        if (extraLength > 1e-9) {
          bestNormal = { x: extraX / extraLength, y: extraY / extraLength };
        }
      }
      if (bestNormal && rawGrounded) retainedSupport = bestNormal;
      let supportNormal: Vec2 = rawGrounded
        ? retainedSupport
        : (bestNormal ?? { x: 0, y: 1 });
      // Contract invariant: `grounded => supportNormal.y > 0`. A downward
      // normal observed together with a ground flag (a stale/character-side
      // contact entry) must never be reported as the support.
      if (rawGrounded && !(supportNormal.y > 0)) supportNormal = { x: 0, y: 1 };
      // A sweep that moves the character up (a lift carrying it)
      // never touches the floor, so its only contact can be a corner or a
      // wall beside it — never the support. While grounded, the surface
      // right under the feet (when there is one) is the support.
      if (rawGrounded) {
        const floor = floorNormalUnder(next);
        if (floor !== null && floor.y > 0) {
          supportNormal = floor;
          retainedSupport = floor;
        }
      }
      const climbable = supportNormal.y >= climbCos - GROUND_NORMAL_TOLERANCE;
      // Per physics.md, the adapter reports Rapier's
      // `computedGrounded()`; the climbable/steep classification is carried
      // by `contacts.ground`/`contacts.steepSlope` and applied by the
      // controller, which requires `supportNormal.y >= cos(maxClimb)`.
      const isGrounded = rawGrounded;

      // Ground-contact correction ("snapped"): the controller changed the
      // capsule's vertical position beyond the command while it is in ground
      // contact — the down-snap of `enableSnapToGround`, the slope-following
      // correction, and the one-time ground-offset/penetration push-out that
      // establishes the controller's 0.01 m skin gap. The magnitude is bounded
      // by the snap distance plus the skin, which is exactly the allowance the
      // runtime gives a `snapped` result (0.11 m). An airborne character can
      // never report it.
      const verticalExtra = movement.y - commandedY;
      const bound = snapDistance + skin + 1e-6;
      const snapped =
        rapierGrounded && Math.abs(verticalExtra) > 1e-6 && Math.abs(verticalExtra) <= bound;

      const correction = Math.max(
        Math.abs(movement.x - requested.x),
        Math.abs(movement.y - commandedY),
      );
      if (correction > maxCorrection) maxCorrection = correction;
      const blocked =
        Math.abs(movement.x - requested.x) > 1e-9 || movement.y > commandedY + 1e-9;
      if (blocked) penetrationCorrectedCount += 1;
      if (Math.abs(requested.x) > 1e-9 && Math.abs(movement.x) < 1e-9) stallSteps += 1;
      if (snapped) snapSteps += 1;

      // The adapter never returns a result the runtime's accepted rule must
      // reject: a correction outside the bounded ground-contact family is a
      // collision-correction failure (fail-stop with an actionable reason),
      // and the capsule is left where it was.
      const appliedLength = Math.hypot(movement.x, movement.y);
      const requestedLength = Math.hypot(requested.x, requested.y);
      // A moving platform or door that moved into the character in the last
      // world step may push it by up to that move.
      const kinematicSlack = Math.min(0.5, kinematicMoved);
      // An autostep lifts the character by up to the step height.
      const allowance = (snapped ? snapDistance + skin : 0.001) + kinematicSlack + stepLift;
      if (appliedLength > requestedLength + allowance + 1e-12) {
        throw correctionError(
          `collision correction out of the contracted bound: requested ` +
            `(${requested.x}, ${requested.y}), applied (${movement.x}, ${movement.y}), ` +
            `snapped=${String(snapped)} — |applied| must be <= |requested| + ${allowance}`,
        );
      }

      // Apply the correction and run the pipeline update exactly once (no
      // dynamic bodies: this is the broad/narrow-phase update).
      characterCollider.setTranslation(at2(next));
      // The movers move after the character's sweep (the runtime
      // already added the carried platform's motion to the requested move).
      kinematicMoved = 0;
      for (const pose of kinematicPoses) {
        const body = staticBodies.get(pose.entityId);
        if (body === undefined || !body.isKinematic()) continue;
        const before = kinematicAt.get(pose.entityId);
        if (before !== undefined) kinematicMoved = Math.max(kinematicMoved, Math.hypot(pose.position.x - before.x, pose.position.y - before.y));
        kinematicAt.set(pose.entityId, { x: pose.position.x, y: pose.position.y });
        body.setNextKinematicTranslation({ x: pose.position.x, y: pose.position.y });
        body.setNextKinematicRotation(pose.rotationZ);
      }
      kinematicPoses = [];
      world.step();
      position = next;
      grounded = isGrounded;
      steps += 1;
      const groundEntityId = isGrounded ? groundUnder(next) : null;

      return {
        requested: { x: requested.x, y: requested.y },
        applied: { x: movement.x, y: movement.y },
        position: { x: next.x, y: next.y },
        grounded: isGrounded,
        supportNormal: { x: supportNormal.x, y: supportNormal.y },
        contacts: {
          ground: rawGrounded,
          wall,
          head,
          steepSlope: rawGrounded && !climbable,
        },
        snapped,
        groundEntityId,
        ...(kinematicSlack > 0 ? { kinematicSlack } : {}),
      };
    },

    setKinematicPositions(poses) {
      assertLive('setKinematicPositions');
      kinematicPoses = poses.map((p) => ({ entityId: p.entityId, position: { x: p.position.x, y: p.position.y }, rotationZ: p.rotationZ }));
    },

    dropThrough(steps: number): void {
      assertLive('dropThrough');
      dropSteps = Math.max(0, Math.min(120, Math.floor(steps)));
    },

    raycast(origin: Vec2, direction: Vec2, maxDistance: number) {
      assertLive('raycast');
      const len = Math.hypot(direction.x, direction.y);
      if (!(len > 0) || !Number.isFinite(maxDistance) || maxDistance <= 0 || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
      const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: origin.x, y: origin.y }, { x: direction.x / len, y: direction.y / len }), Math.min(maxDistance, 1000), true, undefined, undefined, characterCollider);
      if (hit === null) return null;
      const entityId = colliderInfo.get(hit.collider.handle)?.entityId;
      return entityId === undefined ? null : { entityId, distance: hit.timeOfImpact, normal: { x: hit.normal.x, y: hit.normal.y } };
    },

    overlap(shape: OverlapShape, center: Vec2): string[] {
      assertLive('overlap');
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return [];
      const s =
        shape.type === 'box'
          ? Number.isFinite(shape.hx) && Number.isFinite(shape.hy) && shape.hx > 0 && shape.hy > 0
            ? new RAPIER.Cuboid(Math.min(shape.hx, 500), Math.min(shape.hy, 500))
            : null
          : Number.isFinite(shape.radius) && shape.radius > 0
            ? new RAPIER.Ball(Math.min(shape.radius, 500))
            : null;
      if (s === null) return [];
      const ids = new Set<string>();
      world.intersectionsWithShape({ x: center.x, y: center.y }, 0, s, (c) => {
        const id = colliderInfo.get(c.handle)?.entityId;
        if (id !== undefined) ids.add(id);
        return ids.size < 64;
      }, undefined, undefined, characterCollider);
      return [...ids].sort();
    },

    reset(next: Vec2): void {
      assertLive('reset');
      if (!isFinite2(next)) throw resetError('reset position must be a finite { x, y }');
      position = { x: next.x, y: next.y };
      characterCollider.setTranslation(at2(position));
      world.step();
      staged = null;
      grounded = false;
      retainedSupport = { x: 0, y: 1 };
    },

    /**
     * Reset step (gameplay.md): zero every cached/kinematic motion of the
     * character — the pending staged delta and the grounding/support caches.
     * This is a restricted runtime-only operation (never on `PhysicsStepClient`):
     * the adapter has no dynamic velocity of its own
     * (the capsule is a parentless kinematic collider), so "motion" is exactly
     * the staged delta plus the cached ground state.
     */
    clearCharacterMotion(): void {
      assertLive('clearCharacterMotion');
      staged = null;
      grounded = false;
      retainedSupport = { x: 0, y: 1 };
    },

    /**
     * Reset step (gameplay.md): re-place the capsule centre and return the
     * resulting clearance. The authoritative double and the collider are both
     * written to `center`, the world pipeline is advanced once, and the motion
     * caches are cleared (idempotent with a prior `clearCharacterMotion`). The
     * returned clearance is the query-only probe at `center`.
     */
    placeCharacter(center: Vec2): CharacterClearanceResult {
      assertLive('placeCharacter');
      if (!isFinite2(center)) {
        throw resetError('placeCharacter position must be a finite { x, y }');
      }
      const clearance = computeClearance(center);
      staged = null;
      position = { x: center.x, y: center.y };
      characterCollider.setTranslation(at2(position));
      world.step();
      grounded = false;
      retainedSupport = { x: 0, y: 1 };
      return clearance;
    },

    /**
     * Reset check (gameplay.md): query-only clearance of the capsule if placed
     * at `center` (no mutation). A non-finite centre is a `query_failed`;
     * a WASM throw during the probe is likewise `query_failed`. The runtime
     * maps `blocked`/`no_support`/`query_failed` to a refused placement
     * (fail-stop, nothing mutated yet).
     */
    characterClearance(center: Vec2): CharacterClearanceResult {
      assertLive('characterClearance');
      if (!isFinite2(center)) return { ok: false, reason: 'query_failed' };
      try {
        return computeClearance(center);
      } catch {
        return { ok: false, reason: 'query_failed' };
      }
    },

    diagnostics(): RapierPhysicsDiagnostics {
      // After disposal this returns the frozen snapshot taken just before the
      // world was released: reading the freed world would be a stale-handle
      // use. `step()`/`stageCharacterMove()`/`reset()` still throw.
      return released ?? counters();
    },

    addStaticColliders(specs: readonly StaticColliderSpec[]): void {
      assertLive('addStaticColliders');
      // Validate every spec first: a refused batch adds nothing.
      for (const spec of specs) {
        if (staticBodies.has(spec.entityId)) throw new Error(`static collider "${spec.entityId}" already exists`);
        const shape = validateColliderShape(spec.shape);
        if (!shape.ok) throw new Error(`statics(${spec.entityId}): ${shape.detail}`);
      }
      for (const spec of specs) {
        const added = addStaticBody(world, spec as RapierStaticColliderSpec);
        if (!added.ok) throw new Error(`statics(${spec.entityId}): ${added.detail}`);
        staticBodies.set(spec.entityId, added.body);
        colliderInfo.set(added.collider.handle, { entityId: spec.entityId, oneWay: (spec as RapierStaticColliderSpec).oneWay === true, body: added.body, top: added.top, reach: added.reach, kinematic: spec.kinematic === true, topNow: 0, xNow: 0, yNow: 0 });
      }
      relist();
    },
    removeStaticColliders(entityIds: readonly string[]): void {
      assertLive('removeStaticColliders');
      // One pass over the collider records for the whole batch (a scene's unload removed
      // them per entity, over every record: 28 ms for 1 700 of 16 000).
      const gone = new Set<unknown>();
      for (const id of entityIds) {
        const body = staticBodies.get(id);
        if (body === undefined) continue;
        gone.add(body);
        // Removing the body frees its collider too.
        world.removeRigidBody(body);
        staticBodies.delete(id);
      }
      if (gone.size > 0) for (const [handle, info] of [...colliderInfo]) if (gone.has(info.body)) colliderInfo.delete(handle);
      relist();
    },
    dispose(): void {
      if (disposed) return;
      // Capture the live counts, then release everything: `World.free()` frees
      // the collider/body sets, the character controller and the pipeline.
      released = { ...counters(), live: false };
      disposed = true;
      world.free();
    },
  };
}

/**
 * Create and initialize the physics port. Must be awaited **before**
 * `instantiateRuntime` (the runtime requires an already-initialized port).
 *
 * Cancellation: an `AbortSignal` aborts initialization; the port releases
 * everything it allocated, returns `physics_init_cancelled`, and never exposes
 * a partially built world. `RAPIER.init()` itself is idempotent and shared, so
 * a cancelled init leaves no adapter state and a later init succeeds.
 */
export async function createPhysicsPort(
  config: RapierPhysicsInitConfig,
  signal?: AbortSignal,
): Promise<PhysicsPortInitResult> {
  if (signal?.aborted) return cancelledResult();
  const problem = validateConfig(config);
  if (problem) return failedResult(problem.reason, problem.message);
  try {
    await awaitInit(signal);
  } catch (error) {
    if (error === CANCELLED) return cancelledResult();
    return failedResult(
      'wasm_unavailable',
      `Rapier WASM initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (signal?.aborted) return cancelledResult();

  let world: RAPIER.World | null = null;
  try {
    world = new RAPIER.World({ x: 0, y: config.solver.gravityY });
    world.timestep = 1 / config.solver.hz;
    const staticBodies = new Map<string, RAPIER.RigidBody>();
    const colliderInfo = new Map<number, ColliderInfo>();
    for (const spec of config.statics) {
      const added = addStaticBody(world, spec);
      if (!added.ok) {
        // A shape error is unreachable after validateConfig; kept so a future
        // caller cannot reach the library with an unvalidated shape.
        world.free();
        return failedResult('invalid_shape', `statics(${spec.entityId}): ${added.detail}`);
      }
      staticBodies.set(spec.entityId, added.body);
      colliderInfo.set(added.collider.handle, { entityId: spec.entityId, oneWay: spec.oneWay === true, body: added.body, top: added.top, reach: added.reach, kinematic: spec.kinematic === true, topNow: 0, xNow: 0, yNow: 0 });
    }
    if (signal?.aborted) {
      world.free();
      return cancelledResult();
    }
    // PARENTLESS character collider (normative trap): created with no parent
    // rigid body and moved with `setTranslation`. Parenting it would make the
    // solver re-sync the collider toward the body and break this loop.
    // The player's capsule, centred at the character position + offset.
    const cap = capsuleOf(config);
    const characterCollider = world.createCollider(
      RAPIER.ColliderDesc.capsule(cap.halfHeight, cap.radius).setTranslation(
        config.character.x + cap.offset.x,
        config.character.y + cap.offset.y,
      ),
    );
    // The skin, ground snap and autostep are the player's data (defaults 0.01 m, 0.1 m, off).
    const controller = world.createCharacterController(config.controller.offsetSkin);
    controller.setMaxSlopeClimbAngle(config.controller.maxSlopeClimbRad);
    controller.setMinSlopeSlideAngle(config.controller.minSlopeSlideRad);
    controller.enableSnapToGround(config.controller.groundSnap);
    if (config.controller.autostep) {
      // The step's top must leave room for the character (default: its radius); static bodies only.
      controller.enableAutostep(config.controller.autostepHeight ?? 0.25, config.controller.autostepMinWidth ?? cap.radius, false);
    }
    return { ok: true, port: createAdapter(world, characterCollider, controller, config, staticBodies, colliderInfo) };
  } catch (error) {
    world?.free();
    return failedResult(
      'wasm_unavailable',
      `Rapier world construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
