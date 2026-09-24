/**
 * The Rapier 2D physics port (physics.md §5/§6/§8; runtime.md §12.6).
 *
 * One `World` per port (one per runtime instance). Static colliders are boxes
 * or convex polygons on fixed bodies; the single character is a **parentless**
 * capsule collider driven by `world.createCharacterController(offset)` +
 * `computeColliderMovement` → `computedMovement()` → `setTranslation(...)`.
 * The parentless pattern is normative: parenting the capsule to a rigid body
 * makes the solver re-sync it toward the body and breaks the correction loop.
 *
 * The adapter owns no frame driver and no timers: the runtime calls `step()`
 * exactly once per executed fixed step (runtime.md §12.1.1 phase 4). `step()`
 * applies the staged delta, runs the world pipeline update once
 * (`world.step()`, no dynamic bodies), derives grounding/support normals from
 * the collision results (never from `position.y` or `vy`) and returns the
 * correction/support result.
 */
import * as RAPIER from '@dimforge/rapier2d-compat';
import type { CharacterClearanceResult, CharacterMoveResult, OverlapShape, StaticColliderSpec, Vec2 } from '@thirdlight/runtime';

import {
  AUTOSTEP_DISABLED,
  CLEARANCE_PENETRATION_EPS,
  CLEARANCE_RAY_EPS,
  CLEARANCE_SUPPORT_PROBE,
  CONTROLLER_OFFSET_SKIN,
  FIXED_HZ,
  GROUND_NORMAL_TOLERANCE,
  DEFAULT_CAPSULE_HALF_HEIGHT,
  DEFAULT_CAPSULE_RADIUS,
  GROUND_SNAP_DISTANCE,
  PHYSICS_IMPLEMENTATION,
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
 * Phase 14.0: the character capsule of an init config — the player's own
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
 * Validate the whole init config before any WASM/world work. Contract
 * constants (physics.md §7) are enforced, not silently defaulted: `hz` 120,
 * `offsetSkin` 0.01, `groundSnap` 0.1, autostep disabled, and finite slope
 * angles from the resolved settings.
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
  // Phase 14.0: the character's capsule (optional; the default when absent).
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
  if (solver.hz !== FIXED_HZ) {
    return { reason: 'invalid_config', message: `solver.hz must be ${FIXED_HZ} (contract constant)` };
  }
  if (!finiteNumber(solver.gravityY)) {
    return { reason: 'invalid_config', message: 'solver.gravityY must be a finite number' };
  }
  const cc = config.controller;
  if (typeof cc !== 'object' || cc === null) {
    return { reason: 'invalid_config', message: 'controller config is required' };
  }
  if (cc.offsetSkin !== CONTROLLER_OFFSET_SKIN) {
    return {
      reason: 'invalid_config',
      message: `controller.offsetSkin must be ${CONTROLLER_OFFSET_SKIN} (contract constant)`,
    };
  }
  if (cc.groundSnap !== GROUND_SNAP_DISTANCE) {
    return {
      reason: 'invalid_config',
      message: `controller.groundSnap must be ${GROUND_SNAP_DISTANCE} (contract constant)`,
    };
  }
  if (cc.autostep !== AUTOSTEP_DISABLED) {
    return { reason: 'invalid_config', message: 'controller.autostep must be false (contract constant)' };
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
    RAPIER.init().then(
      () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
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

/** Phase 9.9: what the port knows about a level collider. */
interface ColliderInfo {
  entityId: string;
  oneWay: boolean;
  body: RAPIER.RigidBody;
  /** Height of the collider's top above its body origin (for one-way tests). */
  top: number;
}

/** One fixed (or, for a mover, kinematic) body + collider for a collider spec (the body is what removal frees). */
function addStaticBody(
  world: RAPIER.World,
  spec: RapierStaticColliderSpec,
): { ok: true; body: RAPIER.RigidBody; collider: RAPIER.Collider; top: number } | { ok: false; detail: string } {
  const shape = validateColliderShape(spec.shape);
  if (!shape.ok) return { ok: false, detail: shape.detail };
  let desc: RAPIER.ColliderDesc | null;
  const sin = Math.sin(spec.rotationZ);
  const cos = Math.cos(spec.rotationZ);
  let top: number;
  if (shape.shape.type === 'box') {
    desc = RAPIER.ColliderDesc.cuboid(shape.shape.hx, shape.shape.hy);
    top = Math.abs(shape.shape.hx * sin) + Math.abs(shape.shape.hy * cos);
  } else {
    const buffer = polygonVertexBuffer(shape.shape);
    desc = buffer ? RAPIER.ColliderDesc.convexHull(buffer) : null;
    if (!desc) return { ok: false, detail: 'polygon vertices do not form a convex hull' };
    top = -Infinity;
    for (const v of (shape.shape as { vertices: readonly (readonly number[])[] }).vertices) top = Math.max(top, (v[0] ?? 0) * sin + (v[1] ?? 0) * cos);
  }
  const bodyDesc = spec.kinematic === true ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc.setTranslation(spec.position.x, spec.position.y));
  const collider = world.createCollider(desc.setRotation(spec.rotationZ), body);
  return { ok: true, body, collider, top };
}

function createAdapter(
  world: RAPIER.World,
  characterCollider: RAPIER.Collider,
  controller: RAPIER.KinematicCharacterController,
  config: RapierPhysicsInitConfig,
  staticBodies: Map<string, RAPIER.RigidBody>,
  colliderInfo: Map<number, ColliderInfo>,
): RapierPhysicsPort {
  // Phase 9.9: mover poses for this step, one-way drop-through, the ground entity.
  let kinematicPoses: readonly { entityId: string; position: Vec2; rotationZ: number }[] = [];
  /** Phase 9.13: where each kinematic body was posed last, and the largest move of the last world step. */
  const kinematicAt = new Map<string, Vec2>();
  let kinematicMoved = 0;
  let dropSteps = 0;
  // Phase 14.0: the player's capsule; the collider sits at the character position + offset.
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
  const climbCos = Math.cos(config.controller.maxSlopeClimbRad);
  const snapDistance = config.controller.groundSnap;
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
   * The §5.2 clearance probe (query-only, no mutation): the clearance of the
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
    world.colliders.forEach((collider) => {
      if (collider === characterCollider) return; // the probe is against statics only
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
      // Contract guard (decision 0002 §1.2 item 3): never command a downward
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
      // Phase 9.9: a one-way collider only counts when the feet are on or above
      // its top and the character is not rising (and not while dropping through).
      const rising = commandedY > 1e-9;
      const feet = before.y + off.y - feetOffset;
      // The predicate runs inside Rapier's query (a callback from WASM): it
      // must not call back into the world, so the platform tops are read first.
      const oneWayTops = new Map<number, number>();
      for (const [handle, info] of colliderInfo) if (info.oneWay) oneWayTops.set(handle, info.body.translation().y + info.top);
      const oneWayFilter = (collider: RAPIER.Collider): boolean => {
        const top = oneWayTops.get(collider.handle);
        if (top === undefined) return true;
        if (dropSteps > 0 || rising) return false;
        return feet >= top - 0.06;
      };
      if (dropSteps > 0) dropSteps -= 1;
      controller.computeColliderMovement(characterCollider, { x: requested.x, y: commandedY }, undefined, undefined, oneWayFilter);
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
      let wall = false;
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
      const rawGrounded = controller.computedGrounded();
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
      // Phase 9.9: a sweep that moves the character up (a lift carrying it)
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
      // physics.md §8 items 1 and 4: the adapter reports Rapier's
      // `computedGrounded()`; the climbable/steep classification is carried
      // by `contacts.ground`/`contacts.steepSlope` and applied by the
      // controller (packet 32), which requires `supportNormal.y >= cos(maxClimb)`.
      const isGrounded = rawGrounded;

      // Ground-contact correction ("snapped"): the controller changed the
      // capsule's vertical position beyond the command while it is in ground
      // contact — the down-snap of `enableSnapToGround`, the slope-following
      // correction, and the one-time ground-offset/penetration push-out that
      // establishes the controller's 0.01 m skin gap. The magnitude is bounded
      // by the snap distance plus the skin, which is exactly the allowance the
      // runtime gives a `snapped` result (0.11 m). An airborne character can
      // never report it. Recorded as contract-change request C31-2.
      const verticalExtra = movement.y - commandedY;
      const bound = snapDistance + CONTROLLER_OFFSET_SKIN + 1e-6;
      const snapped =
        rawGrounded && Math.abs(verticalExtra) > 1e-6 && Math.abs(verticalExtra) <= bound;

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
      // world step may push it by up to that move (Phase 9.13).
      const kinematicSlack = Math.min(0.5, kinematicMoved);
      const allowance = (snapped ? snapDistance + CONTROLLER_OFFSET_SKIN : 0.001) + kinematicSlack;
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
      // Phase 9.9: the movers move after the character's sweep (the runtime
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
     * M3 (gameplay.md §5.2 R4): zero every cached/kinematic motion of the
     * character — the pending staged delta and the grounding/support caches.
     * This is a restricted runtime-only operation (never on `PhysicsStepClient`
     * or `GameSessionPort`): the adapter has no dynamic velocity of its own
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
     * M3 (gameplay.md §5.2 R4): re-place the capsule centre and return the
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
     * M3 (gameplay.md §5.2 R3): query-only clearance of the capsule if placed
     * at `center` (no mutation). A non-finite centre is a `query_failed`;
     * a WASM throw during the probe is likewise `query_failed`. The runtime
     * maps `blocked`/`no_support`/`query_failed` to `game_spawn_blocked`
     * (fail-stop, no mutation yet at R3).
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
        colliderInfo.set(added.collider.handle, { entityId: spec.entityId, oneWay: (spec as RapierStaticColliderSpec).oneWay === true, body: added.body, top: added.top });
      }
    },
    removeStaticColliders(entityIds: readonly string[]): void {
      assertLive('removeStaticColliders');
      for (const id of entityIds) {
        const body = staticBodies.get(id);
        if (body === undefined) continue;
        for (const [handle, info] of [...colliderInfo]) if (info.body === body) colliderInfo.delete(handle);
        // Removing the body frees its collider too.
        world.removeRigidBody(body);
        staticBodies.delete(id);
      }
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
      colliderInfo.set(added.collider.handle, { entityId: spec.entityId, oneWay: spec.oneWay === true, body: added.body, top: added.top });
    }
    if (signal?.aborted) {
      world.free();
      return cancelledResult();
    }
    // PARENTLESS character collider (normative trap): created with no parent
    // rigid body and moved with `setTranslation`. Parenting it would make the
    // solver re-sync the collider toward the body and break this loop.
    // Phase 14.0: the player's capsule, centred at the character position + offset.
    const cap = capsuleOf(config);
    const characterCollider = world.createCollider(
      RAPIER.ColliderDesc.capsule(cap.halfHeight, cap.radius).setTranslation(
        config.character.x + cap.offset.x,
        config.character.y + cap.offset.y,
      ),
    );
    const controller = world.createCharacterController(CONTROLLER_OFFSET_SKIN);
    controller.setMaxSlopeClimbAngle(config.controller.maxSlopeClimbRad);
    controller.setMinSlopeSlideAngle(config.controller.minSlopeSlideRad);
    controller.enableSnapToGround(GROUND_SNAP_DISTANCE);
    // Autostep stays disabled (contract constant): never enabled.
    return { ok: true, port: createAdapter(world, characterCollider, controller, config, staticBodies, colliderInfo) };
  } catch (error) {
    world?.free();
    return failedResult(
      'wasm_unavailable',
      `Rapier world construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
