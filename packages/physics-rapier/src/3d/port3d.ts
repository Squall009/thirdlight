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
 * itself (it stages the fall). Phase 23.1: sphere, capsule, convex-hull and
 * (static) triangle-mesh colliders; kinematic bodies for movers, posed after
 * the character's sweep like the 2D port's; overlap queries (box, sphere,
 * capsule) and the character's clearance/placement. Walking and jumping are
 * phase 23.2; scripts' rays and overlaps are wired in 23.3.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { CharacterClearanceResult3D, CharacterMoveResult3D, KinematicPose3D, OverlapShape3D, PhysicsDiagnostics, PhysicsInitConfig3D, PhysicsPort3D, PhysicsQuat, PhysicsVec3, RaycastHit3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { CLEARANCE_PENETRATION_EPS, CLEARANCE_RAY_EPS, CLEARANCE_SUPPORT_PROBE, FIXED_HZ_CHOICES, GROUND_NORMAL_TOLERANCE, MAX_SHAPE_VALUE } from '../constants';

/** The value of `PhysicsPort3D.implementation` for this adapter. */
export const PHYSICS_3D_IMPLEMENTATION = 'rapier3d-compat@0.20.0' as const;

/** Phase 23.0: a validated 3D box shape. */
export interface ColliderShapeBox3D {
  type: 'box';
  hx: number;
  hy: number;
  hz: number;
}

/**
 * Phase 23.1: a validated 3D collider shape — a box, a sphere, a capsule
 * (standing along its local Y; `halfHeight` is its centre segment's half
 * length, Rapier's convention), the convex hull of points, or a triangle
 * mesh (a static collider only). Point lists are flat `[x, y, z, ...]`.
 */
export type ColliderShape3D =
  | ColliderShapeBox3D
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'convex'; points: readonly number[] }
  | { type: 'mesh'; vertices: readonly number[]; indices: readonly number[] };

/** Phase 23.1: the port's limits for a hull and a mesh (the project model's, which also keep a scene's total). */
export const MAX_CONVEX_POINTS_3D = 64;
export const MAX_MESH_VERTICES_3D = 1024;
export const MAX_MESH_TRIANGLES_3D = 2048;

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
  setKinematicPoses(poses: readonly KinematicPose3D[]): void;
  overlap(shape: OverlapShape3D, center: PhysicsVec3, rotation?: PhysicsQuat): string[];
  characterClearance(origin: PhysicsVec3): CharacterClearanceResult3D;
  placeCharacter(origin: PhysicsVec3): CharacterClearanceResult3D;
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

const positive = (v: unknown): v is number => finite(v) && v > 0 && v <= MAX_SHAPE_VALUE;
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[], what: string): string | null => {
  for (const k of Object.keys(v)) if (!keys.includes(k)) return `${what} shape has an unexpected field '${k}'`;
  return null;
};
const flatList = (v: unknown, minItems: number, maxItems: number): number[] | null => {
  if (!Array.isArray(v) && !(v instanceof Float32Array)) return null;
  const a = v as ArrayLike<number>;
  if (a.length % 3 !== 0 || a.length / 3 < minItems || a.length / 3 > maxItems) return null;
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 1) {
    if (!finite(a[i]) || Math.abs(a[i]!) > MAX_SHAPE_VALUE) return null;
    out.push(a[i]!);
  }
  return out;
};

/** Phase 23.1: whether flat [x, y, z, ...] points span a volume (the project model's rule, 1e-9 tolerance). */
function spansVolume(p: readonly number[]): boolean {
  const n = p.length / 3;
  const P = (i: number): [number, number, number] => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
  const a = P(0);
  let b = a;
  let best = 0;
  for (let i = 0; i < n; i += 1) {
    const q = P(i);
    const d = Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2]);
    if (d > best) [best, b] = [d, q];
  }
  if (best < 1e-6) return false;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const cross = (u: readonly number[], v: readonly number[]): [number, number, number] => [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  let c = a;
  let area = 0;
  for (let i = 0; i < n; i += 1) {
    const q = P(i);
    const m = Math.hypot(...cross(ab, [q[0] - a[0], q[1] - a[1], q[2] - a[2]]));
    if (m > area) [area, c] = [m, q];
  }
  if (area < 1e-9) return false;
  const nrm = cross(ab, [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
  let vol = 0;
  for (let i = 0; i < n; i += 1) {
    const q = P(i);
    vol = Math.max(vol, Math.abs(nrm[0] * (q[0] - a[0]) + nrm[1] * (q[1] - a[1]) + nrm[2] * (q[2] - a[2])));
  }
  return vol > 1e-9;
}

/**
 * The 3D shape vocabulary (phase 23.1): box (three positive half extents),
 * sphere, capsule (radius and centre-segment half height, >= 0), convex hull
 * (4–64 points) and triangle mesh (3–1,024 vertices, 1–2,048 triangles of
 * three distinct in-range indices). Nothing is defaulted.
 */
export function validateColliderShape3D(value: unknown): { ok: true; shape: ColliderShape3D } | { ok: false; detail: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, detail: 'shape must be an object' };
  const v = value as Record<string, unknown>;
  const type = v['type'];
  if (type === 'box') {
    for (const k of ['hx', 'hy', 'hz'] as const) {
      if (!positive(v[k])) return { ok: false, detail: `box ${k} must satisfy 0 < ${k} <= ${MAX_SHAPE_VALUE}${k === 'hz' ? ' (a 3D box needs its half depth)' : ''}` };
    }
    const extra = onlyKeys(v, ['type', 'hx', 'hy', 'hz'], 'box');
    if (extra !== null) return { ok: false, detail: extra };
    return { ok: true, shape: { type: 'box', hx: v['hx'] as number, hy: v['hy'] as number, hz: v['hz'] as number } };
  }
  if (type === 'sphere') {
    if (!positive(v['radius'])) return { ok: false, detail: `sphere radius must satisfy 0 < radius <= ${MAX_SHAPE_VALUE}` };
    const extra = onlyKeys(v, ['type', 'radius'], 'sphere');
    if (extra !== null) return { ok: false, detail: extra };
    return { ok: true, shape: { type: 'sphere', radius: v['radius'] as number } };
  }
  if (type === 'capsule') {
    if (!positive(v['radius'])) return { ok: false, detail: `capsule radius must satisfy 0 < radius <= ${MAX_SHAPE_VALUE}` };
    const hh = v['halfHeight'];
    if (!finite(hh) || hh < 0 || hh > MAX_SHAPE_VALUE) return { ok: false, detail: `capsule halfHeight must satisfy 0 <= halfHeight <= ${MAX_SHAPE_VALUE}` };
    const extra = onlyKeys(v, ['type', 'radius', 'halfHeight'], 'capsule');
    if (extra !== null) return { ok: false, detail: extra };
    return { ok: true, shape: { type: 'capsule', radius: v['radius'] as number, halfHeight: hh } };
  }
  if (type === 'convex') {
    const points = flatList(v['points'], 4, MAX_CONVEX_POINTS_3D);
    if (points === null) return { ok: false, detail: `convex points must be a flat list of 4-${MAX_CONVEX_POINTS_3D} finite [x, y, z] points` };
    if (!spansVolume(points)) return { ok: false, detail: 'convex points must span a volume (not all on one plane)' };
    const extra = onlyKeys(v, ['type', 'points'], 'convex');
    if (extra !== null) return { ok: false, detail: extra };
    return { ok: true, shape: { type: 'convex', points } };
  }
  if (type === 'mesh') {
    const vertices = flatList(v['vertices'], 3, MAX_MESH_VERTICES_3D);
    if (vertices === null) return { ok: false, detail: `mesh vertices must be a flat list of 3-${MAX_MESH_VERTICES_3D} finite [x, y, z] points` };
    const idx = v['indices'];
    const n = vertices.length / 3;
    if (!(Array.isArray(idx) || idx instanceof Uint32Array) || (idx as ArrayLike<number>).length % 3 !== 0 || (idx as ArrayLike<number>).length < 3 || (idx as ArrayLike<number>).length / 3 > MAX_MESH_TRIANGLES_3D) {
      return { ok: false, detail: `mesh indices must be a flat list of 1-${MAX_MESH_TRIANGLES_3D} triangles` };
    }
    const indices: number[] = [];
    const a = idx as ArrayLike<number>;
    for (let i = 0; i < a.length; i += 3) {
      const t = [a[i], a[i + 1], a[i + 2]];
      if (!t.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n) || t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) {
        return { ok: false, detail: `mesh triangle ${i / 3} must be three distinct vertex indices below ${n}` };
      }
      indices.push(t[0]!, t[1]!, t[2]!);
    }
    const extra = onlyKeys(v, ['type', 'vertices', 'indices'], 'mesh');
    if (extra !== null) return { ok: false, detail: extra };
    return { ok: true, shape: { type: 'mesh', vertices, indices } };
  }
  return { ok: false, detail: 'a 3D collider is a box, sphere, capsule, convex hull or mesh (polygons are 2D-plane shapes)' };
}

function validateSpec(spec: StaticColliderSpec3D, label: string): { reason: 'invalid_config' | 'invalid_shape' | 'invalid_transform'; message: string } | null {
  if (typeof spec !== 'object' || spec === null) return { reason: 'invalid_config', message: `${label} must be an object` };
  if (typeof spec.entityId !== 'string' || spec.entityId.length === 0) return { reason: 'invalid_config', message: `${label}: entityId must be a non-empty string` };
  if (!isVec3(spec.position)) return { reason: 'invalid_transform', message: `${label}: position must be a finite { x, y, z }` };
  if (!isQuat(spec.rotation)) return { reason: 'invalid_transform', message: `${label}: rotation must be a finite unit quaternion { x, y, z, w }` };
  const shape = validateColliderShape3D(spec.shape);
  if (!shape.ok) return { reason: 'invalid_shape', message: `${label}: ${shape.detail}` };
  if (spec.kinematic !== undefined && typeof spec.kinematic !== 'boolean') return { reason: 'invalid_config', message: `${label}: kinematic must be true, false or absent` };
  if (spec.kinematic === true && shape.shape.type === 'mesh') return { reason: 'invalid_shape', message: `${label}: a mesh collider is static (a moving collider uses box, sphere, capsule or convex)` };
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
  /** Phase 23.1: a mover's (or a script-driven collider's) kinematic body. */
  kinematic: boolean;
  /** Phase 23.1: the shape's highest point above its body origin (for the kinematic-drag rule). */
  top: number;
}

/** Rotate `p` by the unit quaternion `q`. */
function rotate(q: PhysicsQuat, p: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}

/** Phase 23.1: the collider description of a validated shape (null: the points span no hull). */
function colliderDescOf(shape: ColliderShape3D): RAPIER.ColliderDesc | null {
  switch (shape.type) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
    case 'sphere':
      return RAPIER.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'convex':
      return RAPIER.ColliderDesc.convexHull(new Float32Array(shape.points));
    case 'mesh':
      // Duplicate vertices (a model's seams) are merged and degenerate triangles dropped.
      return RAPIER.ColliderDesc.trimesh(new Float32Array(shape.vertices), new Uint32Array(shape.indices), RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES);
  }
}

/** Phase 23.1: the shape's highest point above its body origin with the body's rotation. */
function topOf(shape: ColliderShape3D, q: PhysicsQuat): number {
  switch (shape.type) {
    case 'box': {
      let top = -Infinity;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) top = Math.max(top, rotate(q, [sx * shape.hx, sy * shape.hy, sz * shape.hz])[1]);
      return top;
    }
    case 'sphere':
      return shape.radius;
    case 'capsule':
      return Math.abs(rotate(q, [0, shape.halfHeight, 0])[1]) + shape.radius;
    case 'convex':
    case 'mesh': {
      const pts = shape.type === 'convex' ? shape.points : shape.vertices;
      let top = -Infinity;
      for (let i = 0; i < pts.length; i += 3) top = Math.max(top, rotate(q, [pts[i]!, pts[i + 1]!, pts[i + 2]!])[1]);
      return top;
    }
  }
}

function addStaticBody(world: RAPIER.World, spec: StaticColliderSpec3D): { body: RAPIER.RigidBody; collider: RAPIER.Collider; info: Collider3DInfo } {
  const shape = validateColliderShape3D(spec.shape);
  if (!shape.ok) throw new Error(`statics(${spec.entityId}): ${shape.detail}`);
  const desc = colliderDescOf(shape.shape);
  if (desc === null) throw new Error(`statics(${spec.entityId}): the convex points span no hull (they lie on one plane)`);
  const kinematic = spec.kinematic === true;
  const rotation = { x: spec.rotation.x, y: spec.rotation.y, z: spec.rotation.z, w: spec.rotation.w };
  const bodyDesc = kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc.setTranslation(spec.position.x, spec.position.y, spec.position.z).setRotation(rotation));
  const collider = world.createCollider(desc, body);
  return { body, collider, info: { entityId: spec.entityId, body, kinematic, top: topOf(shape.shape, rotation) } };
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
  // Phase 23.1: the kinematic (mover) poses for this step, where each was posed last, and the largest move of the last world step.
  let kinematicPoses: readonly KinematicPose3D[] = [];
  const kinematicAt = new Map<string, PhysicsVec3>();
  let kinematicMoved = 0;
  const stilled: RAPIER.RigidBody[] = [];
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
  const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

  /**
   * Phase 23.1: the clearance of the character capsule if its origin were at
   * `origin` (query only; the 2D probe's rules): blocked by the deepest
   * overlap with a collider (a narrow-phase contact deeper than the
   * penetration epsilon), else supported by the nearest collider straight
   * below the capsule's lowest point, else `no_support`.
   */
  function computeClearance(origin: PhysicsVec3): CharacterClearanceResult3D {
    const capsule = new RAPIER.Capsule(ch.halfHeight, ch.radius);
    const c = at(origin);
    let maxPenetration = 0;
    world.colliders.forEach((collider) => {
      if (collider === characterCollider) return;
      const contact = collider.contactShape(capsule, c, IDENTITY, 0);
      if (contact !== null && contact.distance < -CLEARANCE_PENETRATION_EPS) maxPenetration = Math.max(maxPenetration, -contact.distance);
    });
    if (maxPenetration > 0) return { ok: false, reason: 'blocked', penetration: maxPenetration };
    const ray = new RAPIER.Ray({ x: c.x, y: c.y - feetOffset + CLEARANCE_RAY_EPS, z: c.z }, down);
    let support: PhysicsVec3 | null = null;
    let best = Infinity;
    world.colliders.forEach((collider) => {
      if (collider === characterCollider) return;
      const hit = collider.castRayAndGetNormal(ray, CLEARANCE_SUPPORT_PROBE, true);
      if (hit !== null && hit.timeOfImpact < best) {
        best = hit.timeOfImpact;
        support = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
      }
    });
    if (support === null) return { ok: false, reason: 'no_support' };
    return { ok: true, supportNormal: support, penetration: 0 };
  }

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
      // Phase 23.1: Rapier's controller takes a touched kinematic body's velocity into its sweep
      // ("kinematic friction"). In 3D that fights the runtime's own carry: a character riding a
      // mover sideways (its move equal to the mover's) sticks in the mover's offset margin and
      // stalls (measured: 20 iterations, no motion, about one step in three on a sliding lift).
      // The runtime moves the character with what it stands on (the carry) and pushes it out of a
      // mover's way (the 2D rules), so every kinematic body is at rest for the sweep — made
      // velocity-based with zero velocity and turned back right after; its next pose is set below
      // and the world step derives its velocity from it as always. (The 2D port does the same for
      // a mover rising past the character, phase 14.7.)
      stilled.length = 0;
      for (const info of infoByHandle.values()) {
        if (!info.kinematic) continue;
        const body = info.body;
        if (body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) continue;
        body.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, false);
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        stilled.push(body);
      }
      controller.computeColliderMovement(characterCollider, commanded);
      let swept = { x: controller.computedMovement().x, y: controller.computedMovement().y, z: controller.computedMovement().z };
      // The support normal comes from the collision results (the obstacle's outward normal), never from a floor constant.
      let best: PhysicsVec3 | null = null;
      let wall = false;
      let head = false;
      let groundOnly = true;
      const readCollisions = (): void => {
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
          if (u.y < climbCos) groundOnly = false;
        }
      };
      readCollisions();
      const rawGrounded = controller.computedGrounded();
      // Phase 23.1: riding a kinematic body (a mover, a collider a script drives) Rapier's sweep
      // sometimes reads the support's normal numerically tilted within its skin and takes it for a
      // block — measured on a sliding lift: no motion at all, 20 iterations, about one step in
      // three. When a grounded character's horizontal move is stopped by nothing but ground-like
      // contacts while it stands on a kinematic body, the horizontal part is swept again without
      // that one body (walls and everything else still block it); the vertical result and the
      // grounding stay the first sweep's.
      if (grounded && rawGrounded && groundOnly && Math.hypot(commanded.x, commanded.z) > 1e-9 && Math.hypot(swept.x, swept.z) < 1e-9) {
        const hit = world.castRay(new RAPIER.Ray(probeFrom(before), down), 0.2, true, undefined, undefined, characterCollider);
        const supportHandle = hit !== null && infoByHandle.get(hit.collider.handle)?.kinematic === true ? hit.collider.handle : null;
        if (supportHandle !== null) {
          characterCollider.setTranslation(at({ x: before.x, y: before.y + swept.y, z: before.z }));
          controller.computeColliderMovement(characterCollider, { x: commanded.x, y: 0, z: commanded.z }, undefined, undefined, (c) => c.handle !== supportHandle);
          const again = controller.computedMovement();
          swept = { x: again.x, y: swept.y, z: again.z };
          readCollisions();
        }
      }
      for (const body of stilled) body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
      const movement = swept;
      const next = { x: before.x + movement.x, y: before.y + movement.y, z: before.z + movement.z };
      if (!isVec3(next)) throw new Error('the character controller produced a non-finite correction');
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
      // A mover that moved into the character in the last world step may push it by up to that move (the 2D rule).
      const kinematicSlack = Math.min(0.5, kinematicMoved);
      const allowance = (snapped ? snapDistance + skin : 0.001) + stepLift + kinematicSlack;
      if (Math.hypot(movement.x, movement.y, movement.z) > Math.hypot(requested.x, requested.y, requested.z) + allowance + 1e-12) {
        throw new Error(`collision correction out of the contracted bound: requested (${requested.x}, ${requested.y}, ${requested.z}), applied (${movement.x}, ${movement.y}, ${movement.z})`);
      }
      characterCollider.setTranslation(at(next));
      // Phase 23.1: the movers move after the character's sweep (the runtime already added a carrying platform's motion).
      kinematicMoved = 0;
      for (const pose of kinematicPoses) {
        const body = bodies.get(pose.entityId);
        if (body === undefined || !body.isKinematic()) continue;
        const was = kinematicAt.get(pose.entityId);
        if (was !== undefined) kinematicMoved = Math.max(kinematicMoved, Math.hypot(pose.position.x - was.x, pose.position.y - was.y, pose.position.z - was.z));
        kinematicAt.set(pose.entityId, { x: pose.position.x, y: pose.position.y, z: pose.position.z });
        body.setNextKinematicTranslation({ x: pose.position.x, y: pose.position.y, z: pose.position.z });
        body.setNextKinematicRotation({ x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w });
      }
      kinematicPoses = [];
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
        ...(kinematicSlack > 0 ? { kinematicSlack } : {}),
      };
    },

    setKinematicPoses(poses: readonly KinematicPose3D[]): void {
      assertLive('setKinematicPoses');
      for (const p of poses) {
        if (!isVec3(p?.position) || !isQuat(p?.rotation)) throw new Error(`kinematic pose of "${String(p?.entityId)}" must be a finite position and a unit quaternion`);
      }
      kinematicPoses = poses.map((p) => ({ entityId: p.entityId, position: { x: p.position.x, y: p.position.y, z: p.position.z }, rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z, w: p.rotation.w } }));
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

    overlap(shape: OverlapShape3D, center: PhysicsVec3, rotation?: PhysicsQuat): string[] {
      assertLive('overlap');
      if (!isVec3(center) || (rotation !== undefined && !isQuat(rotation))) return [];
      const ok = (v: unknown): v is number => finite(v) && v > 0;
      let s: RAPIER.Shape | null = null;
      if (shape?.type === 'box' && ok(shape.hx) && ok(shape.hy) && ok(shape.hz)) s = new RAPIER.Cuboid(Math.min(shape.hx, 500), Math.min(shape.hy, 500), Math.min(shape.hz, 500));
      else if (shape?.type === 'sphere' && ok(shape.radius)) s = new RAPIER.Ball(Math.min(shape.radius, 500));
      else if (shape?.type === 'capsule' && ok(shape.radius) && finite(shape.halfHeight) && shape.halfHeight >= 0) s = new RAPIER.Capsule(Math.min(shape.halfHeight, 500), Math.min(shape.radius, 500));
      if (s === null) return [];
      const ids = new Set<string>();
      world.intersectionsWithShape({ x: center.x, y: center.y, z: center.z }, rotation ?? IDENTITY, s, (c) => {
        const id = infoByHandle.get(c.handle)?.entityId;
        if (id !== undefined) ids.add(id);
        return ids.size < 64;
      }, undefined, undefined, characterCollider);
      return [...ids].sort();
    },

    characterClearance(origin: PhysicsVec3): CharacterClearanceResult3D {
      assertLive('characterClearance');
      if (!isVec3(origin)) throw new Error('characterClearance origin must be a finite { x, y, z }');
      return computeClearance(origin);
    },

    placeCharacter(origin: PhysicsVec3): CharacterClearanceResult3D {
      assertLive('placeCharacter');
      if (!isVec3(origin)) throw new Error('placeCharacter origin must be a finite { x, y, z }');
      position = { x: origin.x, y: origin.y, z: origin.z };
      characterCollider.setTranslation(at(position));
      staged = null;
      grounded = false;
      retainedSupport = { x: 0, y: 1, z: 0 };
      world.step();
      return computeClearance(origin);
    },

    addStaticColliders(specs: readonly StaticColliderSpec3D[]): void {
      assertLive('addStaticColliders');
      // A refused batch adds nothing: every spec is checked first (a hull that spans no volume too).
      specs.forEach((spec, i) => {
        const problem = validateSpec(spec, `statics(${String(spec?.entityId ?? i)})`);
        if (problem !== null) throw new Error(problem.message);
        if (bodies.has(spec.entityId)) throw new Error(`static collider "${spec.entityId}" already exists`);
      });
      const added: { id: string; body: RAPIER.RigidBody }[] = [];
      try {
        for (const spec of specs) {
          const a = addStaticBody(world, spec);
          bodies.set(spec.entityId, a.body);
          infoByHandle.set(a.collider.handle, a.info);
          added.push({ id: spec.entityId, body: a.body });
        }
      } catch (e) {
        for (const a of added) {
          for (const [handle, info] of [...infoByHandle]) if (info.body === a.body) infoByHandle.delete(handle);
          world.removeRigidBody(a.body);
          bodies.delete(a.id);
        }
        throw e;
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
        kinematicAt.delete(id);
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
      infoByHandle.set(added.collider.handle, added.info);
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
