/**
 * Phase 23.0: the Rapier 3D physics port (`@dimforge/rapier3d-compat`, the
 * same 0.20.0 pin as the 2D backend) for a project whose
 * `physics_dimension` is 3. It sits beside the 2D adapter (`../port.ts`,
 * untouched) behind the package's `./3d` subpath, so a 2D bundle never
 * carries the 3D WASM.
 *
 * The pattern is the 2D port's: one `World` per port; static box colliders
 * (half extents `hx`/`hy`/`hz`, the entity's full rotation) on fixed bodies;
 * the character a PARENTLESS capsule collider (standing along Y) swept by
 * `world.createCharacterController(skin)` → `computeColliderMovement` →
 * `computedMovement()` → `setTranslation(...)`, with the player's tuning
 * (slope limits, ground snap, autostep); `step()` applies the staged delta,
 * runs the world pipeline once and reports grounding and the support normal
 * from the collision results. The authoritative position is a double kept
 * here (Rapier stores f32), so `applied == position − previous` holds exactly
 * and the rounding never accumulates.
 *
 * The runtime owns stepping (no frame driver here) and applies gravity
 * itself (it stages the fall); walking, jumping, kinematic movers, triggers,
 * overlap queries and more shapes are phases 23.1–23.3.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { CharacterMoveResult3D, PhysicsDiagnostics, PhysicsInitConfig3D, PhysicsPort3D, PhysicsQuat, PhysicsVec3, RaycastHit3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { FIXED_HZ_CHOICES, GROUND_NORMAL_TOLERANCE, MAX_SHAPE_VALUE } from '../constants';

/** The value of `PhysicsPort3D.implementation` for this adapter. */
export const PHYSICS_3D_IMPLEMENTATION = 'rapier3d-compat@0.20.0' as const;

/** Phase 23.0: a validated 3D collider shape (a box; more shapes are phase 23.1). */
export interface ColliderShapeBox3D {
  type: 'box';
  hx: number;
  hy: number;
  hz: number;
}

/** The 3D port's diagnostics (the runtime-read counters plus the library's own live counts). */
export interface Rapier3DDiagnostics extends PhysicsDiagnostics {
  implementation: string;
  worldColliderCount: number;
  worldBodyCount: number;
  steps: number;
  live: boolean;
}

export interface RapierPhysicsPort3D extends PhysicsPort3D {
  readonly implementation: string;
  addStaticColliders(specs: readonly StaticColliderSpec3D[]): void;
  removeStaticColliders(entityIds: readonly string[]): void;
  raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number): RaycastHit3D | null;
  diagnostics(): Rapier3DDiagnostics;
}

export type Physics3DInitResult =
  | { ok: true; port: RapierPhysicsPort3D }
  | { ok: false; error: { code: 'physics_init_failed' | 'physics_init_cancelled'; reason?: 'invalid_config' | 'invalid_shape' | 'invalid_transform' | 'wasm_unavailable'; message: string } };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is PhysicsVec3 => typeof v === 'object' && v !== null && finite((v as PhysicsVec3).x) && finite((v as PhysicsVec3).y) && finite((v as PhysicsVec3).z);
const isQuat = (v: unknown): v is PhysicsQuat =>
  typeof v === 'object' && v !== null && finite((v as PhysicsQuat).x) && finite((v as PhysicsQuat).y) && finite((v as PhysicsQuat).z) && finite((v as PhysicsQuat).w) &&
  Math.abs(Math.hypot((v as PhysicsQuat).x, (v as PhysicsQuat).y, (v as PhysicsQuat).z, (v as PhysicsQuat).w) - 1) <= 1e-3;

/** The 3D shape vocabulary: a box with three positive half extents (the project model's limits). */
export function validateColliderShape3D(value: unknown): { ok: true; shape: ColliderShapeBox3D } | { ok: false; detail: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, detail: 'shape must be an object' };
  const v = value as Record<string, unknown>;
  if (v['type'] !== 'box') return { ok: false, detail: 'a 3D collider is a box (polygons are 2D-plane shapes)' };
  for (const k of ['hx', 'hy', 'hz'] as const) {
    const n = v[k];
    if (!finite(n) || n <= 0 || n > MAX_SHAPE_VALUE) return { ok: false, detail: `box ${k} must satisfy 0 < ${k} <= ${MAX_SHAPE_VALUE}${k === 'hz' ? ' (a 3D box needs its half depth)' : ''}` };
  }
  for (const k of Object.keys(v)) if (k !== 'type' && k !== 'hx' && k !== 'hy' && k !== 'hz') return { ok: false, detail: `box shape has an unexpected field '${k}'` };
  return { ok: true, shape: { type: 'box', hx: v['hx'] as number, hy: v['hy'] as number, hz: v['hz'] as number } };
}

function validateSpec(spec: StaticColliderSpec3D, label: string): { reason: 'invalid_config' | 'invalid_shape' | 'invalid_transform'; message: string } | null {
  if (typeof spec !== 'object' || spec === null) return { reason: 'invalid_config', message: `${label} must be an object` };
  if (typeof spec.entityId !== 'string' || spec.entityId.length === 0) return { reason: 'invalid_config', message: `${label}: entityId must be a non-empty string` };
  if (!isVec3(spec.position)) return { reason: 'invalid_transform', message: `${label}: position must be a finite { x, y, z }` };
  if (!isQuat(spec.rotation)) return { reason: 'invalid_transform', message: `${label}: rotation must be a finite unit quaternion { x, y, z, w }` };
  const shape = validateColliderShape3D(spec.shape);
  if (!shape.ok) return { reason: 'invalid_shape', message: `${label}: ${shape.detail}` };
  return null;
}

/** Validate the whole init config before any WASM or world work (nothing is silently defaulted). */
function validateConfig(config: PhysicsInitConfig3D): { reason: 'invalid_config' | 'invalid_shape' | 'invalid_transform'; message: string } | null {
  if (typeof config !== 'object' || config === null) return { reason: 'invalid_config', message: 'physics init config must be an object' };
  if (config.dimension !== 3) return { reason: 'invalid_config', message: 'a 3D port needs a config with dimension 3' };
  const ch = config.character;
  if (typeof ch !== 'object' || ch === null || !isVec3(ch.position)) return { reason: 'invalid_transform', message: 'character.position must be a finite { x, y, z }' };
  if (!finite(ch.radius) || ch.radius <= 0 || ch.radius > 1e3) return { reason: 'invalid_config', message: 'character.radius must be a finite number in (0, 1000]' };
  if (!finite(ch.halfHeight) || ch.halfHeight < 0 || ch.halfHeight > 1e3) return { reason: 'invalid_config', message: 'character.halfHeight must be a finite number in [0, 1000]' };
  if (!isVec3(ch.offset)) return { reason: 'invalid_config', message: 'character.offset must be a finite { x, y, z }' };
  const solver = config.solver;
  if (typeof solver !== 'object' || solver === null || !FIXED_HZ_CHOICES.includes(solver.hz)) return { reason: 'invalid_config', message: `solver.hz must be one of ${FIXED_HZ_CHOICES.join(', ')}` };
  if (!finite(solver.gravityY)) return { reason: 'invalid_config', message: 'solver.gravityY must be a finite number' };
  const cc = config.controller;
  if (typeof cc !== 'object' || cc === null) return { reason: 'invalid_config', message: 'controller config is required' };
  if (!finite(cc.offsetSkin) || cc.offsetSkin < 0.001 || cc.offsetSkin > 0.1) return { reason: 'invalid_config', message: 'controller.offsetSkin must be a finite number in [0.001, 0.1] m' };
  if (!finite(cc.groundSnap) || cc.groundSnap < 0 || cc.groundSnap > 1) return { reason: 'invalid_config', message: 'controller.groundSnap must be a finite number in [0, 1] m' };
  if (typeof cc.autostep !== 'boolean') return { reason: 'invalid_config', message: 'controller.autostep must be true or false' };
  if (cc.autostep && (!finite(cc.autostepHeight) || cc.autostepHeight < 0.01 || cc.autostepHeight > 2)) return { reason: 'invalid_config', message: 'controller.autostep needs autostepHeight, a finite number in [0.01, 2] m' };
  if (!finite(cc.maxSlopeClimbRad) || cc.maxSlopeClimbRad <= 0 || cc.maxSlopeClimbRad >= Math.PI / 2) return { reason: 'invalid_config', message: 'controller.maxSlopeClimbRad must be a finite angle in (0, pi/2)' };
  if (!finite(cc.minSlopeSlideRad) || cc.minSlopeSlideRad < 0 || cc.minSlopeSlideRad >= Math.PI / 2) return { reason: 'invalid_config', message: 'controller.minSlopeSlideRad must be a finite angle in [0, pi/2)' };
  if (!Array.isArray(config.statics)) return { reason: 'invalid_config', message: 'statics must be an array of static collider specs' };
  const seen = new Set<string>();
  for (let i = 0; i < config.statics.length; i += 1) {
    const spec = config.statics[i]!;
    const problem = validateSpec(spec, `statics[${i}](${String(spec?.entityId)})`);
    if (problem !== null) return problem;
    if (seen.has(spec.entityId)) return { reason: 'invalid_config', message: `statics[${i}]: entity "${spec.entityId}" has two colliders` };
    seen.add(spec.entityId);
  }
  return null;
}

// ---- WASM initialization and memory (the 2D port's pattern, for the 3D module) ----

const CANCELLED = Symbol('physics3d-init-cancelled');
let wasmMemory: { buffer: ArrayBuffer } | null = null;
let memoryWatched = false;

/** Note the 3D module's WebAssembly memory when the library instantiates it (it does not expose it). */
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

/** The 3D physics engine's WebAssembly memory in bytes (null before the first init, or when it could not be seen). */
export function physicsMemoryBytes3D(): number | null {
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

// ---- the world ------------------------------------------------------------

interface Collider3DInfo {
  entityId: string;
  body: RAPIER.RigidBody;
}

function addStaticBody(world: RAPIER.World, spec: StaticColliderSpec3D): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
  const shape = validateColliderShape3D(spec.shape);
  if (!shape.ok) throw new Error(`statics(${spec.entityId}): ${shape.detail}`);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(spec.position.x, spec.position.y, spec.position.z).setRotation({ x: spec.rotation.x, y: spec.rotation.y, z: spec.rotation.z, w: spec.rotation.w }));
  const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(shape.shape.hx, shape.shape.hy, shape.shape.hz), body);
  return { body, collider };
}

function createAdapter(world: RAPIER.World, characterCollider: RAPIER.Collider, controller: RAPIER.KinematicCharacterController, config: PhysicsInitConfig3D, bodies: Map<string, RAPIER.RigidBody>, infoByHandle: Map<number, Collider3DInfo>): RapierPhysicsPort3D {
  const ch = config.character;
  const off = { x: ch.offset.x, y: ch.offset.y, z: ch.offset.z };
  const feetOffset = ch.halfHeight + ch.radius;
  const at = (p: PhysicsVec3): PhysicsVec3 => ({ x: p.x + off.x, y: p.y + off.y, z: p.z + off.z });
  const climbCos = Math.cos(config.controller.maxSlopeClimbRad);
  const snapDistance = config.controller.groundSnap;
  const skin = config.controller.offsetSkin;
  const stepLift = config.controller.autostep ? (config.controller.autostepHeight ?? 0.25) : 0;
  let position: PhysicsVec3 = { x: ch.position.x, y: ch.position.y, z: ch.position.z };
  let staged: PhysicsVec3 | null = null;
  let grounded = false;
  let retainedSupport: PhysicsVec3 = { x: 0, y: 1, z: 0 };
  let disposed = false;
  let steps = 0;
  let stallSteps = 0;
  let penetrationCorrectedCount = 0;
  let released: Rapier3DDiagnostics | null = null;
  const assertLive = (op: string): void => {
    if (disposed) throw new Error(`physics port is disposed (${op})`);
  };
  const down = { x: 0, y: -1, z: 0 };
  const probeFrom = (p: PhysicsVec3): PhysicsVec3 => ({ x: p.x + off.x, y: p.y + off.y - feetOffset + 0.05, z: p.z + off.z });
  const groundUnder = (p: PhysicsVec3): string | null => {
    const hit = world.castRay(new RAPIER.Ray(probeFrom(p), down), 0.2, true, undefined, undefined, characterCollider);
    return hit === null ? null : (infoByHandle.get(hit.collider.handle)?.entityId ?? null);
  };
  const floorNormalUnder = (p: PhysicsVec3): PhysicsVec3 | null => {
    const hit = world.castRayAndGetNormal(new RAPIER.Ray(probeFrom(p), down), 0.2, true, undefined, undefined, characterCollider);
    if (hit === null) return null;
    const len = Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z);
    return len > 0 ? { x: hit.normal.x / len, y: hit.normal.y / len, z: hit.normal.z / len } : null;
  };
  const counters = (): Rapier3DDiagnostics => ({
    stallSteps,
    penetrationCorrectedCount,
    implementation: PHYSICS_3D_IMPLEMENTATION,
    worldColliderCount: world.colliders.len(),
    worldBodyCount: world.bodies.len(),
    steps,
    live: true,
  });

  return {
    dimension: 3,
    implementation: PHYSICS_3D_IMPLEMENTATION,

    stageCharacterMove(delta: PhysicsVec3): void {
      assertLive('stageCharacterMove');
      staged = { x: delta.x, y: delta.y, z: delta.z };
    },

    step(): CharacterMoveResult3D {
      assertLive('step');
      const requested: PhysicsVec3 = staged ?? { x: 0, y: 0, z: 0 };
      staged = null;
      if (!isVec3(requested)) throw new Error(`staged movement must be a finite { x, y, z } (got ${JSON.stringify(requested)})`);
      // As in 2D: never command a downward delta while grounded (the snap holds the character).
      const commanded: PhysicsVec3 = { x: requested.x, y: grounded && requested.y < 0 ? 0 : requested.y, z: requested.z };
      const before = position;
      controller.computeColliderMovement(characterCollider, commanded);
      const movement = controller.computedMovement();
      const next = { x: before.x + movement.x, y: before.y + movement.y, z: before.z + movement.z };
      if (!isVec3(next)) throw new Error('the character controller produced a non-finite correction');
      // The support normal comes from the collision results (the obstacle's outward normal), never from a floor constant.
      let best: PhysicsVec3 | null = null;
      let wall = false;
      let head = false;
      const collisions = controller.numComputedCollisions();
      for (let i = 0; i < collisions; i += 1) {
        const hit = controller.computedCollision(i);
        if (!hit) continue;
        const n = hit.normal1;
        const len = Math.hypot(n.x, n.y, n.z);
        if (!(len > 0)) continue;
        const u = { x: n.x / len, y: n.y / len, z: n.z / len };
        if (best === null || u.y > best.y) best = u;
        if (Math.hypot(u.x, u.z) > climbCos) wall = true;
        if (u.y < -climbCos) head = true;
      }
      const rawGrounded = controller.computedGrounded();
      if (best === null && rawGrounded) {
        // The ground-offset push-out is not a sweep collision; its direction is the surface normal.
        const e = { x: movement.x - commanded.x, y: movement.y - commanded.y, z: movement.z - commanded.z };
        const len = Math.hypot(e.x, e.y, e.z);
        if (len > 1e-9) best = { x: e.x / len, y: e.y / len, z: e.z / len };
      }
      if (best !== null && rawGrounded) retainedSupport = best;
      let support: PhysicsVec3 = rawGrounded ? retainedSupport : (best ?? { x: 0, y: 1, z: 0 });
      if (rawGrounded) {
        const floor = floorNormalUnder(next);
        if (floor !== null && floor.y > 0) {
          support = floor;
          retainedSupport = floor;
        }
        if (!(support.y > 0)) support = { x: 0, y: 1, z: 0 };
      }
      const climbable = support.y >= climbCos - GROUND_NORMAL_TOLERANCE;
      const verticalExtra = movement.y - commanded.y;
      const snapped = rawGrounded && Math.abs(verticalExtra) > 1e-6 && Math.abs(verticalExtra) <= snapDistance + skin + 1e-6;
      const blocked = Math.abs(movement.x - commanded.x) > 1e-9 || Math.abs(movement.z - commanded.z) > 1e-9 || movement.y > commanded.y + 1e-9;
      if (blocked) penetrationCorrectedCount += 1;
      if (Math.hypot(requested.x, requested.z) > 1e-9 && Math.hypot(movement.x, movement.z) < 1e-9) stallSteps += 1;
      const allowance = (snapped ? snapDistance + skin : 0.001) + stepLift;
      if (Math.hypot(movement.x, movement.y, movement.z) > Math.hypot(requested.x, requested.y, requested.z) + allowance + 1e-12) {
        throw new Error(`collision correction out of the contracted bound: requested (${requested.x}, ${requested.y}, ${requested.z}), applied (${movement.x}, ${movement.y}, ${movement.z})`);
      }
      characterCollider.setTranslation(at(next));
      world.step();
      position = next;
      grounded = rawGrounded;
      steps += 1;
      return {
        requested: { x: requested.x, y: requested.y, z: requested.z },
        applied: { x: movement.x, y: movement.y, z: movement.z },
        position: { x: next.x, y: next.y, z: next.z },
        grounded: rawGrounded,
        supportNormal: support,
        contacts: { ground: rawGrounded, wall, head, steepSlope: rawGrounded && !climbable },
        snapped,
        groundEntityId: rawGrounded ? groundUnder(next) : null,
      };
    },

    raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number): RaycastHit3D | null {
      assertLive('raycast');
      const len = Math.hypot(direction.x, direction.y, direction.z);
      if (!(len > 0) || !finite(maxDistance) || maxDistance <= 0 || !isVec3(origin)) return null;
      const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: direction.x / len, y: direction.y / len, z: direction.z / len }), Math.min(maxDistance, 1000), true, undefined, undefined, characterCollider);
      if (hit === null) return null;
      const entityId = infoByHandle.get(hit.collider.handle)?.entityId;
      return entityId === undefined ? null : { entityId, distance: hit.timeOfImpact, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z } };
    },

    addStaticColliders(specs: readonly StaticColliderSpec3D[]): void {
      assertLive('addStaticColliders');
      // A refused batch adds nothing: every spec is checked first.
      specs.forEach((spec, i) => {
        const problem = validateSpec(spec, `statics(${String(spec?.entityId ?? i)})`);
        if (problem !== null) throw new Error(problem.message);
        if (bodies.has(spec.entityId)) throw new Error(`static collider "${spec.entityId}" already exists`);
      });
      for (const spec of specs) {
        const added = addStaticBody(world, spec);
        bodies.set(spec.entityId, added.body);
        infoByHandle.set(added.collider.handle, { entityId: spec.entityId, body: added.body });
      }
      // The scene queries (sweeps, rays) see a collider after a pipeline update (no dynamic bodies: nothing else moves).
      world.step();
    },

    removeStaticColliders(entityIds: readonly string[]): void {
      assertLive('removeStaticColliders');
      for (const id of entityIds) {
        const body = bodies.get(id);
        if (body === undefined) continue;
        for (const [handle, info] of [...infoByHandle]) if (info.body === body) infoByHandle.delete(handle);
        world.removeRigidBody(body);
        bodies.delete(id);
      }
      world.step();
    },

    diagnostics(): Rapier3DDiagnostics {
      return released ?? counters();
    },

    dispose(): void {
      if (disposed) return;
      released = { ...counters(), live: false };
      disposed = true;
      world.free();
    },
  };
}

/**
 * Create and initialize the 3D physics port (await it before
 * `instantiateRuntime`). An `AbortSignal` cancels initialization; nothing
 * partial escapes, and `RAPIER.init()` being idempotent a later init works.
 */
export async function createPhysicsPort3D(config: PhysicsInitConfig3D, signal?: AbortSignal): Promise<Physics3DInitResult> {
  const cancelled: Physics3DInitResult = { ok: false, error: { code: 'physics_init_cancelled', message: 'physics initialization was cancelled before completion; nothing was allocated' } };
  if (signal?.aborted) return cancelled;
  const problem = validateConfig(config);
  if (problem !== null) return { ok: false, error: { code: 'physics_init_failed', reason: problem.reason, message: problem.message } };
  try {
    await awaitInit(signal);
  } catch (error) {
    if (error === CANCELLED) return cancelled;
    return { ok: false, error: { code: 'physics_init_failed', reason: 'wasm_unavailable', message: `Rapier 3D WASM initialization failed: ${error instanceof Error ? error.message : String(error)}` } };
  }
  if (signal?.aborted) return cancelled;
  let world: RAPIER.World | null = null;
  try {
    world = new RAPIER.World({ x: 0, y: config.solver.gravityY, z: 0 });
    world.timestep = 1 / config.solver.hz;
    const bodies = new Map<string, RAPIER.RigidBody>();
    const infoByHandle = new Map<number, Collider3DInfo>();
    for (const spec of config.statics) {
      const added = addStaticBody(world, spec);
      bodies.set(spec.entityId, added.body);
      infoByHandle.set(added.collider.handle, { entityId: spec.entityId, body: added.body });
    }
    // PARENTLESS character collider (the 2D port's normative pattern): moved with setTranslation only.
    const ch = config.character;
    const characterCollider = world.createCollider(RAPIER.ColliderDesc.capsule(ch.halfHeight, ch.radius).setTranslation(ch.position.x + ch.offset.x, ch.position.y + ch.offset.y, ch.position.z + ch.offset.z));
    const controller = world.createCharacterController(config.controller.offsetSkin);
    // Up is +Y (gravity along −Y), as in the 2D plane.
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.setMaxSlopeClimbAngle(config.controller.maxSlopeClimbRad);
    controller.setMinSlopeSlideAngle(config.controller.minSlopeSlideRad);
    controller.enableSnapToGround(config.controller.groundSnap);
    if (config.controller.autostep) controller.enableAutostep(config.controller.autostepHeight ?? 0.25, ch.radius, false);
    // One pipeline update so the first sweep and any ray see every collider (no dynamic bodies: nothing moves).
    world.step();
    return { ok: true, port: createAdapter(world, characterCollider, controller, config, bodies, infoByHandle) };
  } catch (error) {
    world?.free();
    return { ok: false, error: { code: 'physics_init_failed', reason: 'wasm_unavailable', message: `Rapier 3D world construction failed: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
