/**
 * The Rapier 3D physics port (`@dimforge/rapier3d-compat`, the
 * same 0.20.0 pin as the 2D backend) for a project whose
 * `physics_dimension` is 3. It sits beside the 2D adapter (`../port.ts`,
 * untouched) behind the package's `./3d` subpath, so a 2D bundle never
 * carries the 3D WASM.
 *
 * The pattern is the 2D port's: one `World` per port; static box colliders
 * (half extents `hx`/`hy`/`hz`, the entity's full rotation) on fixed bodies;
 * each player character (one per player controller) a PARENTLESS capsule
 * collider (standing along Y) swept by its own
 * `world.createCharacterController(skin)` → `computeColliderMovement` →
 * `computedMovement()` → `setTranslation(...)`, with the player's tuning
 * (slope limits, ground snap, autostep); `step()` applies the staged delta,
 * runs the world pipeline once and reports grounding and the support normal
 * from the collision results. The authoritative position is a double kept
 * here (Rapier stores f32), so `applied == position − previous` holds exactly
 * and the rounding never accumulates.
 *
 * The runtime owns stepping (no frame driver here) and applies gravity
 * itself (it stages the fall). Sphere, capsule, convex-hull and
 * (static) triangle-mesh colliders; kinematic bodies for movers, posed after
 * the character's sweep like the 2D port's; raycasts, overlap queries (box,
 * sphere, capsule) and the character's clearance/placement.
 */
import { COLLIDER_3D_LIMITS } from '@thirdlight/project-model/limits';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { CharacterClearanceResult3D, CharacterMoveResult3D, KinematicPose3D, OverlapShape3D, PhysicsDiagnostics, PhysicsInitConfig3D, PhysicsPort3D, PhysicsQuat, PhysicsQueryFilter3D, PhysicsVec3, RaycastHit3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { CLEARANCE_PENETRATION_EPS, CLEARANCE_RAY_EPS, CLEARANCE_SUPPORT_PROBE, FIXED_HZ_CHOICES, GROUND_NORMAL_TOLERANCE, MAX_SHAPE_VALUE } from '../constants';

/** The value of `PhysicsPort3D.implementation` for this adapter. */
export const PHYSICS_3D_IMPLEMENTATION = 'rapier3d-compat@0.20.0' as const;

/** A validated 3D box shape. */
export interface ColliderShapeBox3D {
  type: 'box';
  hx: number;
  hy: number;
  hz: number;
}

/**
 * A validated 3D collider shape — a box, a sphere, a capsule
 * (standing along its local Y; `halfHeight` is its centre segment's half
 * length, Rapier's convention), the convex hull of points, or a triangle
 * mesh (a static collider only). Point lists are flat `[x, y, z, ...]`.
 */
export type ColliderPrimitive3D =
  | ColliderShapeBox3D
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'convex'; points: readonly number[] }
  | { type: 'mesh'; vertices: readonly number[]; indices: readonly number[] };

/** One shape of a compound, placed in its body's frame. */
export interface ColliderPart3D {
  shape: ColliderPrimitive3D;
  position: PhysicsVec3;
  rotation: PhysicsQuat;
}

/** A primitive, or several placed on one body (`compound`: one collider each, all the entity's). */
export type ColliderShape3D = ColliderPrimitive3D | { type: 'compound'; parts: readonly ColliderPart3D[] };

/** The port's limits for a hull and a mesh: the model's (which also keeps a scene's total). */
export const MAX_CONVEX_POINTS_3D = COLLIDER_3D_LIMITS.convexPoints;
export const MAX_MESH_VERTICES_3D = COLLIDER_3D_LIMITS.meshVertices;
export const MAX_MESH_TRIANGLES_3D = COLLIDER_3D_LIMITS.meshTriangles;

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
  raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number, filter?: PhysicsQueryFilter3D): RaycastHit3D | null;
  setKinematicPoses(poses: readonly KinematicPose3D[]): void;
  overlap(shape: OverlapShape3D, center: PhysicsVec3, rotation?: PhysicsQuat, filter?: PhysicsQueryFilter3D): string[];
  characterClearance(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D;
  placeCharacter(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D;
  lastResultOf(characterId: string): CharacterMoveResult3D | undefined;
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

/** Whether flat [x, y, z, ...] points span a volume (the project model's rule, 1e-9 tolerance). */
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
 * The 3D shape vocabulary: box (three positive half extents),
 * sphere, capsule (radius and centre-segment half height, >= 0), convex hull
 * (4–64 points) and triangle mesh (3–1,024 vertices, 1–2,048 triangles of
 * three distinct in-range indices). Nothing is defaulted.
 */
function validatePrimitive3D(value: unknown): { ok: true; shape: ColliderPrimitive3D } | { ok: false; detail: string } {
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

/**
 * The 3D shape vocabulary: a primitive, or a compound of at least one placed
 * primitive (a finite position and a unit rotation each, in the body's frame).
 */
export function validateColliderShape3D(value: unknown): { ok: true; shape: ColliderShape3D } | { ok: false; detail: string } {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'compound') {
    const v = value as Record<string, unknown>;
    const extra = onlyKeys(v, ['type', 'parts'], 'compound');
    if (extra !== null) return { ok: false, detail: extra };
    const parts = v['parts'];
    if (!Array.isArray(parts) || parts.length === 0) return { ok: false, detail: 'a compound shape has at least one part' };
    const out: ColliderPart3D[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as Record<string, unknown> | null;
      if (typeof part !== 'object' || part === null) return { ok: false, detail: `compound part ${i} must be an object` };
      if (!isVec3(part['position'])) return { ok: false, detail: `compound part ${i}: position must be a finite { x, y, z }` };
      if (!isQuat(part['rotation'])) return { ok: false, detail: `compound part ${i}: rotation must be a finite unit quaternion { x, y, z, w }` };
      const shape = validatePrimitive3D(part['shape']);
      if (!shape.ok) return { ok: false, detail: `compound part ${i}: ${shape.detail}` };
      out.push({ shape: shape.shape, position: part['position'], rotation: part['rotation'] });
    }
    return { ok: true, shape: { type: 'compound', parts: out } };
  }
  return validatePrimitive3D(value);
}

/** The placed primitives of a shape (a primitive alone sits at its body's origin). */
function partsOf(shape: ColliderShape3D): readonly ColliderPart3D[] {
  return shape.type === 'compound' ? shape.parts : [{ shape, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }];
}

function validateSpec(spec: StaticColliderSpec3D, label: string): { reason: 'invalid_config' | 'invalid_shape' | 'invalid_transform'; message: string } | null {
  if (typeof spec !== 'object' || spec === null) return { reason: 'invalid_config', message: `${label} must be an object` };
  if (typeof spec.entityId !== 'string' || spec.entityId.length === 0) return { reason: 'invalid_config', message: `${label}: entityId must be a non-empty string` };
  if (!isVec3(spec.position)) return { reason: 'invalid_transform', message: `${label}: position must be a finite { x, y, z }` };
  if (!isQuat(spec.rotation)) return { reason: 'invalid_transform', message: `${label}: rotation must be a finite unit quaternion { x, y, z, w }` };
  const shape = validateColliderShape3D(spec.shape);
  if (!shape.ok) return { reason: 'invalid_shape', message: `${label}: ${shape.detail}` };
  if (spec.kinematic !== undefined && typeof spec.kinematic !== 'boolean') return { reason: 'invalid_config', message: `${label}: kinematic must be true, false or absent` };
  if (spec.layers !== undefined && !(Array.isArray(spec.layers) && spec.layers.length >= 1 && spec.layers.length <= 16 && spec.layers.every((n) => typeof n === 'string'))) return { reason: 'invalid_config', message: `${label}: layers must be 1-16 layer names or absent` };
  if (spec.kinematic === true && partsOf(shape.shape).some((p) => p.shape.type === 'mesh')) return { reason: 'invalid_shape', message: `${label}: a mesh collider is static (a moving collider uses box, sphere, capsule or convex)` };
  if (spec.maxSlope !== undefined && (!finite(spec.maxSlope) || spec.maxSlope <= 0 || spec.maxSlope >= Math.PI / 2)) return { reason: 'invalid_config', message: `${label}: maxSlope must be a finite angle in (0, pi/2) or absent` };
  return null;
}

type ConfigProblem3D = { reason: 'invalid_config' | 'invalid_shape' | 'invalid_transform'; message: string };

/** A character's problem (its origin and capsule), or null; `label` names it in the message. */
function characterProblem3D(ch: PhysicsInitConfig3D['character'], label: string): ConfigProblem3D | null {
  if (typeof ch !== 'object' || ch === null || !isVec3(ch.position)) return { reason: 'invalid_transform', message: `${label}.position must be a finite { x, y, z }` };
  if (!finite(ch.radius) || ch.radius <= 0 || ch.radius > 1e3) return { reason: 'invalid_config', message: `${label}.radius must be a finite number in (0, 1000]` };
  if (!finite(ch.halfHeight) || ch.halfHeight < 0 || ch.halfHeight > 1e3) return { reason: 'invalid_config', message: `${label}.halfHeight must be a finite number in [0, 1000]` };
  if (!isVec3(ch.offset)) return { reason: 'invalid_config', message: `${label}.offset must be a finite { x, y, z }` };
  return null;
}

/** A character controller config's problem, or null; `label` names it in the message. */
function controllerProblem3D(cc: PhysicsInitConfig3D['controller'], label: string): ConfigProblem3D | null {
  if (typeof cc !== 'object' || cc === null) return { reason: 'invalid_config', message: `${label} config is required` };
  if (!finite(cc.offsetSkin) || cc.offsetSkin < 0.001 || cc.offsetSkin > 0.1) return { reason: 'invalid_config', message: `${label}.offsetSkin must be a finite number in [0.001, 0.1] m` };
  if (!finite(cc.groundSnap) || cc.groundSnap < 0 || cc.groundSnap > 1) return { reason: 'invalid_config', message: `${label}.groundSnap must be a finite number in [0, 1] m` };
  if (typeof cc.autostep !== 'boolean') return { reason: 'invalid_config', message: `${label}.autostep must be true or false` };
  if (cc.autostep && (!finite(cc.autostepHeight) || cc.autostepHeight < 0.01 || cc.autostepHeight > 2)) return { reason: 'invalid_config', message: `${label}.autostep needs autostepHeight, a finite number in [0.01, 2] m` };
  if (!finite(cc.maxSlopeClimbRad) || cc.maxSlopeClimbRad <= 0 || cc.maxSlopeClimbRad >= Math.PI / 2) return { reason: 'invalid_config', message: `${label}.maxSlopeClimbRad must be a finite angle in (0, pi/2)` };
  if (!finite(cc.minSlopeSlideRad) || cc.minSlopeSlideRad < 0 || cc.minSlopeSlideRad >= Math.PI / 2) return { reason: 'invalid_config', message: `${label}.minSlopeSlideRad must be a finite angle in [0, pi/2)` };
  return null;
}

/** Validate the whole init config before any WASM or world work (nothing is silently defaulted). */
function validateConfig(config: PhysicsInitConfig3D): ConfigProblem3D | null {
  if (typeof config !== 'object' || config === null) return { reason: 'invalid_config', message: 'physics init config must be an object' };
  if (config.dimension !== 3) return { reason: 'invalid_config', message: 'a 3D port needs a config with dimension 3' };
  const first = characterProblem3D(config.character, 'character');
  if (first !== null) return first;
  const solver = config.solver;
  if (typeof solver !== 'object' || solver === null || !FIXED_HZ_CHOICES.includes(solver.hz)) return { reason: 'invalid_config', message: `solver.hz must be one of ${FIXED_HZ_CHOICES.join(', ')}` };
  if (!finite(solver.gravityY)) return { reason: 'invalid_config', message: 'solver.gravityY must be a finite number' };
  const cc = controllerProblem3D(config.controller, 'controller');
  if (cc !== null) return cc;
  if (!Array.isArray(config.statics)) return { reason: 'invalid_config', message: 'statics must be an array of static collider specs' };
  // The named collision layers (bit 1 + index; "default" is bit 0 and never listed) and a world without a character.
  if (config.layers !== undefined && !(Array.isArray(config.layers) && config.layers.length <= 15 && config.layers.every((n) => typeof n === 'string' && n !== 'default') && new Set(config.layers).size === config.layers.length)) return { reason: 'invalid_config', message: 'layers must be up to 15 unique layer names (not "default")' };
  if (config.noCharacter !== undefined && config.noCharacter !== true) return { reason: 'invalid_config', message: 'noCharacter must be true or absent' };
  // Further characters (several player controllers): each its own object, origin, capsule and tuning.
  if (config.characters !== undefined) {
    if (!Array.isArray(config.characters) || config.noCharacter === true) return { reason: 'invalid_config', message: 'characters must be an array, in a world with a character' };
    const ids = new Set<string>();
    for (let i = 0; i < config.characters.length; i += 1) {
      const c = config.characters[i]!;
      const label = `characters[${i}]`;
      if (typeof c !== 'object' || c === null || typeof c.id !== 'string' || c.id.length === 0 || ids.has(c.id)) return { reason: 'invalid_config', message: `${label}.id must be a non-empty string, once` };
      ids.add(c.id);
      const problem = characterProblem3D(c, label) ?? (c.controller !== undefined ? controllerProblem3D(c.controller, `${label}.controller`) : null);
      if (problem !== null) return problem;
    }
  }
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
  /** A mover's (or a script-driven collider's) kinematic body. */
  kinematic: boolean;
  /** The shape's highest point above its body origin (for the kinematic-drag rule). */
  top: number;
  /** The cosine of the steepest slope of this collider a character walks up, when its spec sets one (a block layer's maxSlope). */
  climbCos?: number;
}

/** Rotate `p` by the unit quaternion `q`. */
function rotate(q: PhysicsQuat, p: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}

/** The collider description of a validated shape (null: the points span no hull). */
function colliderDescOf(shape: ColliderPrimitive3D): RAPIER.ColliderDesc | null {
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

/** The shape's highest point above its body origin with the body's rotation. */
function topOf(shape: ColliderPrimitive3D, q: PhysicsQuat): number {
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

/**
 * Collision layers as Rapier interaction groups. Bit 0 is
 * "default" (a collider without layers), bit 1 + i the config's i-th named
 * layer. A collider is a member of its layers and filters nothing (the upper
 * 16 bits are memberships, the lower 16 the filter), so contacts and the
 * character's sweep are unchanged; a query's groups are every membership with
 * the filter = the layers it names. Unknown names add no bit.
 */
export type LayerBits = ReadonlyMap<string, number>;
export function layerBitsOf(layers: readonly string[] | undefined): LayerBits {
  const out = new Map<string, number>([['default', 0]]);
  (layers ?? []).forEach((name, i) => out.set(name, i + 1));
  return out;
}
function layerMask(bits: LayerBits, names: readonly string[] | undefined, fallback: number): number {
  if (names === undefined) return fallback;
  let m = 0;
  for (const n of names) {
    const b = bits.get(n);
    if (b !== undefined) m |= 1 << b;
  }
  return m;
}
/** A collider's groups: member of its layers ("default" when it lists none), filtering nothing. */
export function colliderGroups(bits: LayerBits, layers: readonly string[] | undefined): number {
  return ((layerMask(bits, layers, 1) << 16) | 0xffff) >>> 0;
}
/** A query's groups: every membership, filtering to the named layers. */
export function queryGroups(bits: LayerBits, layers: readonly string[]): number {
  return ((0xffff << 16) | layerMask(bits, layers, 0)) >>> 0;
}

/** `a · b` of unit quaternions. */
function mulQuat(a: PhysicsQuat, b: PhysicsQuat): PhysicsQuat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * One fixed (or kinematic) body for a collider spec with a collider per
 * placed shape (a compound's parts, each at its position and rotation in the
 * body's frame); every collider answers for the spec's entity.
 */
function addStaticBody(world: RAPIER.World, spec: StaticColliderSpec3D, bits: LayerBits): { body: RAPIER.RigidBody; colliders: { collider: RAPIER.Collider; info: Collider3DInfo }[] } {
  const shape = validateColliderShape3D(spec.shape);
  if (!shape.ok) throw new Error(`statics(${spec.entityId}): ${shape.detail}`);
  const parts = partsOf(shape.shape);
  const descs = parts.map((p) => colliderDescOf(p.shape));
  if (descs.some((d) => d === null)) throw new Error(`statics(${spec.entityId}): the convex points span no hull (they lie on one plane)`);
  const kinematic = spec.kinematic === true;
  const rotation = { x: spec.rotation.x, y: spec.rotation.y, z: spec.rotation.z, w: spec.rotation.w };
  const bodyDesc = kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc.setTranslation(spec.position.x, spec.position.y, spec.position.z).setRotation(rotation));
  const groups = colliderGroups(bits, spec.layers);
  // The body's highest point over all its shapes (the kinematic-drag rule reads it).
  let top = -Infinity;
  for (const p of parts) top = Math.max(top, rotate(rotation, [p.position.x, p.position.y, p.position.z])[1] + topOf(p.shape, mulQuat(rotation, p.rotation)));
  const colliders = parts.map((p, i) => {
    const desc = descs[i]!.setTranslation(p.position.x, p.position.y, p.position.z).setRotation({ x: p.rotation.x, y: p.rotation.y, z: p.rotation.z, w: p.rotation.w });
    const collider = world.createCollider(desc.setCollisionGroups(groups), body);
    return { collider, info: { entityId: spec.entityId, body, kinematic, top, ...(spec.maxSlope !== undefined ? { climbCos: Math.cos(spec.maxSlope) } : {}) } };
  });
  return { body, colliders };
}

/**
 * One player character in the 3D world: its parentless capsule collider,
 * its own Rapier character controller (the player's skin, snap, slope limits
 * and step height) and the motion it carries from step to step. A world
 * with several player controllers (local co-op) holds one per controller;
 * they never collide with each other (each sweep and query leaves every
 * character out).
 */
interface CharacterBody3D {
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  readonly shape: { readonly radius: number; readonly halfHeight: number; readonly offset: PhysicsVec3 };
  readonly tuning: PhysicsInitConfig3D['controller'];
  readonly overlapCapsule: RAPIER.Capsule;
  /** The authoritative position (a double; the collider holds its f32 rounding). */
  position: PhysicsVec3;
  staged: PhysicsVec3 | null;
  grounded: boolean;
  retainedSupport: PhysicsVec3;
  /**
   * A step-up in progress — the character was lifted onto a riser
   * it pushes against and moves on at that height (no snap, no fall) until
   * the ground under its centre is the step's top; the way it went, and how
   * many steps it has taken so far.
   */
  stepping: { x: number; z: number; steps: number } | null;
  /** The result of the last step (further characters read it with `lastResultOf`). */
  last: CharacterMoveResult3D | undefined;
}

/** A character's capsule collider (parentless, at its origin + offset) and its controller. */
function makeCharacterBody3D(world: RAPIER.World, ch: PhysicsInitConfig3D['character'], tuning: PhysicsInitConfig3D['controller']): CharacterBody3D {
  // PARENTLESS character collider (the 2D port's normative pattern): moved with setTranslation only.
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(ch.halfHeight, ch.radius).setTranslation(ch.position.x + ch.offset.x, ch.position.y + ch.offset.y, ch.position.z + ch.offset.z));
  const controller = world.createCharacterController(tuning.offsetSkin);
  // Up is +Y (gravity along −Y), as in the 2D plane.
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.setMaxSlopeClimbAngle(tuning.maxSlopeClimbRad);
  controller.setMinSlopeSlideAngle(tuning.minSlopeSlideRad);
  controller.enableSnapToGround(tuning.groundSnap);
  // Stepping up is the port's own (`stepProbe` / `stepping` in `step()`), not Rapier's
  // autostep, which missed risers above about 0.15 m with a capsule.
  return {
    collider,
    controller,
    shape: { radius: ch.radius, halfHeight: ch.halfHeight, offset: { x: ch.offset.x, y: ch.offset.y, z: ch.offset.z } },
    tuning,
    overlapCapsule: new RAPIER.Capsule(ch.halfHeight, ch.radius),
    position: { x: ch.position.x, y: ch.position.y, z: ch.position.z },
    staged: null,
    grounded: false,
    retainedSupport: { x: 0, y: 1, z: 0 },
    stepping: null,
    last: undefined,
  };
}

/** Both predicates (either may be absent). */
function bothPredicates(a: ((c: RAPIER.Collider) => boolean) | undefined, b: ((c: RAPIER.Collider) => boolean) | undefined): ((c: RAPIER.Collider) => boolean) | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (c) => a(c) && b(c);
}

function createAdapter(world: RAPIER.World, primary: CharacterBody3D, further: ReadonlyMap<string, CharacterBody3D>, config: PhysicsInitConfig3D, bodies: Map<string, RAPIER.RigidBody>, infoByHandle: Map<number, Collider3DInfo>, bits: LayerBits): RapierPhysicsPort3D {
  const noCharacter = config.noCharacter === true;
  /** Every character, the init config's first, then the further ones in their order (the step sweeps them in this order). */
  const chars: readonly CharacterBody3D[] = noCharacter ? [] : [primary, ...further.values()];
  const characterHandles = new Set([primary, ...further.values()].map((b) => b.collider.handle));
  /**
   * With several characters, the predicate that leaves the other characters
   * out of a sweep or a query (each already leaves its own character out);
   * with one, none (the queries are exactly as they were).
   */
  const othersOut: ((c: RAPIER.Collider) => boolean) | undefined = characterHandles.size > 1 ? (c) => !characterHandles.has(c.handle) : undefined;
  /** A query filter as Rapier's groups and predicate. */
  const groupsOf = (filter: PhysicsQueryFilter3D | undefined): number | undefined => (filter?.layers !== undefined ? queryGroups(bits, filter.layers) : undefined);
  const predicateOf = (filter: PhysicsQueryFilter3D | undefined): ((c: RAPIER.Collider) => boolean) | undefined => {
    const accept = filter?.accept;
    if (accept === undefined) return othersOut;
    return bothPredicates(othersOut, (c) => {
      const id = infoByHandle.get(c.handle)?.entityId;
      return id !== undefined && accept(id) === true;
    });
  };
  /** A step-up that has not reached the top after a second ends (the character falls as usual). */
  const maxSteppingSteps = config.solver.hz;
  let disposed = false;
  let steps = 0;
  let stallSteps = 0;
  let penetrationCorrectedCount = 0;
  /** The deepest overlap a step began in so far (the collider's entity, how deep, which port step). */
  let deepestOverlap: { entityId: string; depth: number; step: number } | null = null;
  let released: Rapier3DDiagnostics | null = null;
  // The kinematic (mover) poses for this step, where each was posed last, and the largest move of the last world step.
  let kinematicPoses: readonly KinematicPose3D[] = [];
  const kinematicAt = new Map<string, PhysicsVec3>();
  let kinematicMoved = 0;
  const stilled: RAPIER.RigidBody[] = [];
  const assertLive = (op: string): void => {
    if (disposed) throw new Error(`physics port is disposed (${op})`);
  };
  /** The character a call names (absent: the first); an unknown id is an error. */
  const bodyOf = (characterId: string | undefined, op: string): CharacterBody3D => {
    if (characterId === undefined) return primary;
    const b = further.get(characterId);
    if (b === undefined) throw new Error(`${op}: no character "${String(characterId)}" in this world`);
    return b;
  };
  const down = { x: 0, y: -1, z: 0 };
  const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
  const at = (b: CharacterBody3D, p: PhysicsVec3): PhysicsVec3 => ({ x: p.x + b.shape.offset.x, y: p.y + b.shape.offset.y, z: p.z + b.shape.offset.z });
  const probeFrom = (b: CharacterBody3D, p: PhysicsVec3): PhysicsVec3 => ({ x: p.x + b.shape.offset.x, y: p.y + b.shape.offset.y - (b.shape.halfHeight + b.shape.radius) + 0.05, z: p.z + b.shape.offset.z });
  const groundUnder = (b: CharacterBody3D, p: PhysicsVec3): string | null => {
    const hit = world.castRay(new RAPIER.Ray(probeFrom(b, p), down), 0.2, true, undefined, undefined, b.collider, undefined, othersOut);
    return hit === null ? null : (infoByHandle.get(hit.collider.handle)?.entityId ?? null);
  };
  /** The cosine of the steepest slope the character walks up on a collider: its own, or the collider's stricter one (a block layer's maxSlope). */
  const climbCosOf = (b: CharacterBody3D, collider: RAPIER.Collider | null | undefined): number => {
    const climbCos = Math.cos(b.tuning.maxSlopeClimbRad);
    const own = collider === null || collider === undefined ? undefined : infoByHandle.get(collider.handle)?.climbCos;
    return own !== undefined && own > climbCos ? own : climbCos;
  };
  const floorUnder = (b: CharacterBody3D, p: PhysicsVec3): { normal: PhysicsVec3; climbCos: number } | null => {
    const hit = world.castRayAndGetNormal(new RAPIER.Ray(probeFrom(b, p), down), 0.2, true, undefined, undefined, b.collider, undefined, othersOut);
    if (hit === null) return null;
    const len = Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z);
    return len > 0 ? { normal: { x: hit.normal.x / len, y: hit.normal.y / len, z: hit.normal.z / len }, climbCos: climbCosOf(b, hit.collider) } : null;
  };
  const walkableFloorUnder = (b: CharacterBody3D, p: PhysicsVec3): boolean => {
    const f = floorUnder(b, p);
    return f !== null && f.normal.y >= f.climbCos - GROUND_NORMAL_TOLERANCE;
  };
  /**
   * The strictest climb cosine among the sweep's contacts that the character
   * would walk up but their collider forbids (a slope steeper than a block
   * layer's maxSlope, gentler than the character's own limit); null: none.
   */
  const stricterClimb = (b: CharacterBody3D): number | null => {
    const climbCos = Math.cos(b.tuning.maxSlopeClimbRad);
    let out: number | null = null;
    const collisions = b.controller.numComputedCollisions();
    for (let i = 0; i < collisions; i += 1) {
      const hit = b.controller.computedCollision(i);
      const limit = hit?.collider?.handle !== undefined ? infoByHandle.get(hit.collider.handle)?.climbCos : undefined;
      if (hit === null || limit === undefined || limit <= climbCos) continue;
      const n = hit.normal1;
      const len = Math.hypot(n.x, n.y, n.z);
      if (!(len > 0)) continue;
      const y = n.y / len;
      if (y >= climbCos - GROUND_NORMAL_TOLERANCE && y < limit - GROUND_NORMAL_TOLERANCE && (out === null || limit > out)) out = limit;
    }
    return out;
  };
  /**
   * Whether the character at `from`, pushing along the unit
   * horizontal direction (dx, dz), can step up — three sweeps without the
   * snap: up by the step height (plus two skins), across by its radius (plus
   * two skins, so its centre would be over what is there), down onto it. The
   * rise when it lands grounded on walkable ground higher than it stands and
   * at most the step height (plus a skin) up, else null (a taller block or a
   * wall keeps the across sweep blocked; a ceiling stops the lift). The
   * capsule is back at `from` afterwards.
   */
  const stepProbe = (b: CharacterBody3D, from: PhysicsVec3, dx: number, dz: number): number | null => {
    const { controller, collider: characterCollider } = b;
    const skin = b.tuning.offsetSkin;
    const stepLift = b.tuning.autostep ? (b.tuning.autostepHeight ?? 0.25) : 0;
    const lift = stepLift + 2 * skin;
    const reach = b.shape.radius + 2 * skin;
    controller.disableSnapToGround();
    try {
      characterCollider.setTranslation(at(b, from));
      controller.computeColliderMovement(characterCollider, { x: 0, y: lift, z: 0 }, undefined, undefined, othersOut);
      const up = controller.computedMovement().y;
      if (!(up > 1e-3)) return null;
      const p1 = { x: from.x, y: from.y + up, z: from.z };
      characterCollider.setTranslation(at(b, p1));
      controller.computeColliderMovement(characterCollider, { x: dx * reach, y: 0, z: dz * reach }, undefined, undefined, othersOut);
      const across = controller.computedMovement();
      if (Math.hypot(across.x, across.z) < reach * 0.9) return null;
      const p2 = { x: p1.x + across.x, y: p1.y + across.y, z: p1.z + across.z };
      characterCollider.setTranslation(at(b, p2));
      controller.computeColliderMovement(characterCollider, { x: 0, y: -(up + skin), z: 0 }, undefined, undefined, othersOut);
      const drop = controller.computedMovement();
      if (!controller.computedGrounded()) return null;
      const p3 = { x: p2.x + drop.x, y: p2.y + drop.y, z: p2.z + drop.z };
      const rise = p3.y - from.y;
      if (!(rise > 1e-3) || rise > stepLift + skin + 1e-6) return null;
      return walkableFloorUnder(b, p3) ? rise : null;
    } finally {
      characterCollider.setTranslation(at(b, from));
      controller.enableSnapToGround(b.tuning.groundSnap);
    }
  };
  /**
   * The deepest overlap of the character capsule at `p` with a collider
   * (deeper than the clearance probe's epsilon), or null. A sweep that starts
   * in one moves the character out of it — a real depenetration. A grounded
   * character's sweep stopped by the floor starts in none (the controller
   * keeps its skin above it), so standing never counts.
   */
  const overlapAt = (b: CharacterBody3D, p: PhysicsVec3): { entityId: string; depth: number } | null => {
    const c = at(b, p);
    let best: { entityId: string; depth: number } | null = null;
    world.intersectionsWithShape(c, IDENTITY, b.overlapCapsule, (collider) => {
      const contact = collider.contactShape(b.overlapCapsule, c, IDENTITY, 0);
      const depth = contact === null ? 0 : -contact.distance;
      const entityId = infoByHandle.get(collider.handle)?.entityId;
      if (entityId !== undefined && depth > CLEARANCE_PENETRATION_EPS && (best === null || depth > best.depth)) best = { entityId, depth };
      return true;
    }, undefined, undefined, b.collider, undefined, othersOut);
    return best;
  };
  const counters = (): Rapier3DDiagnostics => ({
    stallSteps,
    penetrationCorrectedCount,
    ...(deepestOverlap !== null ? { deepestOverlap: { ...deepestOverlap } } : {}),
    implementation: PHYSICS_3D_IMPLEMENTATION,
    worldColliderCount: world.colliders.len(),
    worldBodyCount: world.bodies.len(),
    steps,
    live: true,
  });

  /**
   * The clearance of the character capsule if its origin were at
   * `origin` (query only; the 2D probe's rules): blocked by the deepest
   * overlap with a collider (a narrow-phase contact deeper than the
   * penetration epsilon), else supported by the nearest collider straight
   * below the capsule's lowest point, else `no_support`. Characters are never
   * in the way.
   */
  function computeClearance(b: CharacterBody3D, origin: PhysicsVec3): CharacterClearanceResult3D {
    const capsule = new RAPIER.Capsule(b.shape.halfHeight, b.shape.radius);
    const c = at(b, origin);
    let maxPenetration = 0;
    world.colliders.forEach((collider) => {
      if (characterHandles.has(collider.handle)) return;
      const contact = collider.contactShape(capsule, c, IDENTITY, 0);
      if (contact !== null && contact.distance < -CLEARANCE_PENETRATION_EPS) maxPenetration = Math.max(maxPenetration, -contact.distance);
    });
    if (maxPenetration > 0) return { ok: false, reason: 'blocked', penetration: maxPenetration };
    const ray = new RAPIER.Ray({ x: c.x, y: c.y - (b.shape.halfHeight + b.shape.radius) + CLEARANCE_RAY_EPS, z: c.z }, down);
    let support: PhysicsVec3 | null = null;
    let best = Infinity;
    world.colliders.forEach((collider) => {
      if (characterHandles.has(collider.handle)) return;
      const hit = collider.castRayAndGetNormal(ray, CLEARANCE_SUPPORT_PROBE, true);
      if (hit !== null && hit.timeOfImpact < best) {
        best = hit.timeOfImpact;
        support = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
      }
    });
    if (support === null) return { ok: false, reason: 'no_support' };
    return { ok: true, supportNormal: support, penetration: 0 };
  }

  /** The movers are posed (after every character's sweep) and the world updates once. */
  function poseMoversAndStep(): void {
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
    steps += 1;
  }

  /** The step of a world without a character — the movers are posed and the world updates; nothing is swept. */
  function stepWithoutCharacter(): CharacterMoveResult3D {
    primary.staged = null;
    for (const pose of kinematicPoses) {
      const body = bodies.get(pose.entityId);
      if (body === undefined || !body.isKinematic()) continue;
      kinematicAt.set(pose.entityId, { x: pose.position.x, y: pose.position.y, z: pose.position.z });
      body.setNextKinematicTranslation({ x: pose.position.x, y: pose.position.y, z: pose.position.z });
      body.setNextKinematicRotation({ x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w });
    }
    kinematicPoses = [];
    world.step();
    steps += 1;
    const zero = { x: 0, y: 0, z: 0 };
    const p = primary.position;
    return { requested: zero, applied: { ...zero }, position: { x: p.x, y: p.y, z: p.z }, grounded: false, supportNormal: { x: 0, y: 1, z: 0 }, contacts: { ground: false, wall: false, head: false, steepSlope: false }, snapped: false, groundEntityId: null };
  }

  /**
   * One character's sweep of its staged move, up to the collider written at
   * its new place: the result (without the ground entity, read after the
   * world step) and where it ends. Throws and leaves the capsule where it was.
   */
  function sweep(b: CharacterBody3D): { result: CharacterMoveResult3D; next: PhysicsVec3; grounded: boolean } {
    const { controller, collider: characterCollider } = b;
    const climbCos = Math.cos(b.tuning.maxSlopeClimbRad);
    const snapDistance = b.tuning.groundSnap;
    const skin = b.tuning.offsetSkin;
    const stepLift = b.tuning.autostep ? (b.tuning.autostepHeight ?? 0.25) : 0;
    const requested: PhysicsVec3 = b.staged ?? { x: 0, y: 0, z: 0 };
    b.staged = null;
    if (!isVec3(requested)) throw new Error(`staged movement must be a finite { x, y, z } (got ${JSON.stringify(requested)})`);
    // The request is swept as it is, a grounded character's small downward part
    // included (dropping it, as the 2D port does, which made Rapier's grounded status
    // flicker every other step on flat ground — measured with a walking character; the sweep
    // stops it on the ground and keeps it grounded).
    const commanded: PhysicsVec3 = { x: requested.x, y: requested.y, z: requested.z };
    const across = Math.hypot(commanded.x, commanded.z);
    // A step-up goes on while the character keeps pushing the way it went (not up).
    const st = b.stepping;
    if (st !== null && (commanded.y > 0 || across < 1e-9 || commanded.x * st.x + commanded.z * st.z <= 0 || st.steps >= maxSteppingSteps)) b.stepping = null;
    const midStep = b.stepping !== null;
    const before = b.position;
    // A step that begins inside a collider is a real depenetration (counted; the deepest is kept for diagnostics).
    const overlap = overlapAt(b, before);
    if (overlap !== null) {
      penetrationCorrectedCount += 1;
      if (deepestOverlap === null || overlap.depth > deepestOverlap.depth) deepestOverlap = { ...overlap, step: steps };
    }
    // Rapier's controller takes a touched kinematic body's velocity into its sweep
    // ("kinematic friction"). In 3D that fights the runtime's own carry: a character riding a
    // mover sideways (its move equal to the mover's) sticks in the mover's offset margin and
    // stalls (measured: 20 iterations, no motion, about one step in three on a sliding lift).
    // The runtime moves the character with what it stands on (the carry) and pushes it out of a
    // mover's way (the 2D rules), so every kinematic body is at rest for the sweep — made
    // velocity-based with zero velocity and turned back right after; its next pose is set below
    // and the world step derives its velocity from it as always. (The 2D port does the same for
    // a mover rising past the character.)
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
    if (midStep) {
      // On the riser's height: across only, without the snap (which would pull it back down the riser).
      controller.disableSnapToGround();
      controller.computeColliderMovement(characterCollider, { x: commanded.x, y: 0, z: commanded.z }, undefined, undefined, othersOut);
      controller.enableSnapToGround(snapDistance);
    } else {
      controller.computeColliderMovement(characterCollider, commanded, undefined, undefined, othersOut);
      // A slope the character could climb but whose collider sets a stricter limit (a block layer's maxSlope):
      // swept again with that limit, so the slope is a wall to it. Colliders without a limit never get here.
      const stricter = stricterClimb(b);
      if (stricter !== null) {
        controller.setMaxSlopeClimbAngle(Math.acos(stricter));
        controller.computeColliderMovement(characterCollider, commanded, undefined, undefined, othersOut);
        controller.setMaxSlopeClimbAngle(b.tuning.maxSlopeClimbRad);
      }
    }
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
    let rawGrounded = midStep ? true : controller.computedGrounded();
    if (b.stepping !== null) {
      b.stepping.steps += 1;
      // On top: the ground under its centre is walkable (the step's top) — the step-up ends.
      if (walkableFloorUnder(b, { x: before.x + swept.x, y: before.y + swept.y, z: before.z + swept.z })) b.stepping = null;
    }
    // Riding a kinematic body (a mover, a collider a script drives) Rapier's sweep
    // sometimes reads the support's normal numerically tilted within its skin and takes it for a
    // block — measured on a sliding lift: no motion at all, 20 iterations, about one step in
    // three. When a grounded character's horizontal move is stopped by nothing but ground-like
    // contacts while it stands on a kinematic body, the horizontal part is swept again without
    // that one body (walls and everything else still block it); the vertical result and the
    // grounding stay the first sweep's.
    if (!midStep && b.grounded && rawGrounded && groundOnly && Math.hypot(commanded.x, commanded.z) > 1e-9 && Math.hypot(swept.x, swept.z) < 1e-9) {
      const hit = world.castRay(new RAPIER.Ray(probeFrom(b, before), down), 0.2, true, undefined, undefined, characterCollider, undefined, othersOut);
      const supportHandle = hit !== null && infoByHandle.get(hit.collider.handle)?.kinematic === true ? hit.collider.handle : null;
      if (supportHandle !== null) {
        characterCollider.setTranslation(at(b, { x: before.x, y: before.y + swept.y, z: before.z }));
        controller.computeColliderMovement(characterCollider, { x: commanded.x, y: 0, z: commanded.z }, undefined, undefined, bothPredicates(othersOut, (c) => c.handle !== supportHandle));
        const again = controller.computedMovement();
        swept = { x: again.x, y: swept.y, z: again.z };
        readCollisions();
      }
    }
    // Standing still. A grounded character asked for nothing across and at most a
    // fall, whose sweep moved it less than its skin, on something that does not move (not a
    // mover or a collider a script drives), stays exactly where it is — Rapier's sweep and
    // ground snap otherwise alternate it by about 0.1 mm every step (measured), so it never
    // comes to rest.
    if (!midStep && b.grounded && rawGrounded && across < 1e-12 && commanded.y <= 0 && Math.hypot(swept.x, swept.y, swept.z) < skin) {
      const under = world.castRay(new RAPIER.Ray(probeFrom(b, before), down), 0.2, true, undefined, undefined, characterCollider, undefined, othersOut);
      if (under !== null && infoByHandle.get(under.collider.handle)?.kinematic !== true) swept = { x: 0, y: 0, z: 0 };
    }
    // Stepping up. Rapier's own autostep missed risers above about 0.15 m with a
    // capsule (measured with rapier3d 0.20.0: a 0.2 m riser blocked a walking capsule of radius
    // 0.3 m whatever its minimum width), so a grounded character whose move across is cut to
    // less than half probes the riser (`stepProbe`): when it can stand on top, it is lifted by
    // the rise this step (and moves across at that height), then goes on at that height until
    // its centre is over the top (`stepping`) — the rounded bottom of a capsule would otherwise
    // slide back off the riser's edge. A taller block or a wall is not climbed.
    if (!midStep && stepLift > 0 && b.grounded && rawGrounded && commanded.y <= 0 && across > 1e-9 && Math.hypot(swept.x, swept.z) < across * 0.5) {
      const dx = commanded.x / across;
      const dz = commanded.z / across;
      const rise = stepProbe(b, before, dx, dz);
      if (rise !== null) {
        const lifted = { x: before.x, y: before.y + rise, z: before.z };
        characterCollider.setTranslation(at(b, lifted));
        controller.disableSnapToGround();
        controller.computeColliderMovement(characterCollider, { x: commanded.x, y: 0, z: commanded.z }, undefined, undefined, othersOut);
        controller.enableSnapToGround(snapDistance);
        const on = controller.computedMovement();
        characterCollider.setTranslation(at(b, before));
        swept = { x: on.x, y: rise + on.y, z: on.z };
        best = null;
        wall = false;
        head = false;
        readCollisions();
        rawGrounded = true;
        b.stepping = walkableFloorUnder(b, { x: before.x + swept.x, y: before.y + swept.y, z: before.z + swept.z }) ? null : { x: dx, z: dz, steps: 0 };
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
    if (best !== null && rawGrounded) b.retainedSupport = best;
    let support: PhysicsVec3 = rawGrounded ? b.retainedSupport : (best ?? { x: 0, y: 1, z: 0 });
    let supportClimbCos = climbCos;
    if (rawGrounded) {
      const floor = floorUnder(b, next);
      if (floor !== null && floor.normal.y > 0) {
        support = floor.normal;
        b.retainedSupport = floor.normal;
        supportClimbCos = floor.climbCos;
      }
      if (!(support.y > 0)) support = { x: 0, y: 1, z: 0 };
    }
    const climbable = support.y >= supportClimbCos - GROUND_NORMAL_TOLERANCE;
    const verticalExtra = movement.y - commanded.y;
    const snapped = rawGrounded && Math.abs(verticalExtra) > 1e-6 && Math.abs(verticalExtra) <= snapDistance + skin + 1e-6;
    if (Math.hypot(requested.x, requested.z) > 1e-9 && Math.hypot(movement.x, movement.z) < 1e-9) stallSteps += 1;
    // A mover that moved into the character in the last world step may push it by up to that move (the 2D rule).
    const kinematicSlack = Math.min(0.5, kinematicMoved);
    const allowance = (snapped ? snapDistance + skin : 0.001) + (stepLift > 0 ? stepLift + skin : 0) + kinematicSlack;
    if (Math.hypot(movement.x, movement.y, movement.z) > Math.hypot(requested.x, requested.y, requested.z) + allowance + 1e-12) {
      throw new Error(`collision correction out of the contracted bound: requested (${requested.x}, ${requested.y}, ${requested.z}), applied (${movement.x}, ${movement.y}, ${movement.z})`);
    }
    characterCollider.setTranslation(at(b, next));
    return {
      next,
      grounded: rawGrounded,
      result: {
        requested: { x: requested.x, y: requested.y, z: requested.z },
        applied: { x: movement.x, y: movement.y, z: movement.z },
        position: { x: next.x, y: next.y, z: next.z },
        grounded: rawGrounded,
        supportNormal: support,
        contacts: { ground: rawGrounded, wall, head, steepSlope: rawGrounded && !climbable },
        snapped,
        groundEntityId: null,
        ...(kinematicSlack > 0 ? { kinematicSlack } : {}),
      },
    };
  }

  return {
    dimension: 3,
    implementation: PHYSICS_3D_IMPLEMENTATION,

    stageCharacterMove(delta: PhysicsVec3, characterId?: string): void {
      assertLive('stageCharacterMove');
      bodyOf(characterId, 'stageCharacterMove').staged = { x: delta.x, y: delta.y, z: delta.z };
    },

    step(): CharacterMoveResult3D {
      assertLive('step');
      if (noCharacter) return stepWithoutCharacter();
      // Every character's sweep (the first, then the further ones); the movers move after them
      // (the runtime already added a carrying platform's motion to each request).
      const swept = chars.map((b) => sweep(b));
      poseMoversAndStep();
      for (let i = 0; i < chars.length; i += 1) {
        const b = chars[i]!;
        const s = swept[i]!;
        b.position = s.next;
        b.grounded = s.grounded;
        b.last = { ...s.result, groundEntityId: s.grounded ? groundUnder(b, s.next) : null };
      }
      return primary.last!;
    },

    lastResultOf(characterId: string): CharacterMoveResult3D | undefined {
      assertLive('lastResultOf');
      return further.get(characterId)?.last;
    },

    setKinematicPoses(poses: readonly KinematicPose3D[]): void {
      assertLive('setKinematicPoses');
      for (const p of poses) {
        if (!isVec3(p?.position) || !isQuat(p?.rotation)) throw new Error(`kinematic pose of "${String(p?.entityId)}" must be a finite position and a unit quaternion`);
      }
      kinematicPoses = poses.map((p) => ({ entityId: p.entityId, position: { x: p.position.x, y: p.position.y, z: p.position.z }, rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z, w: p.rotation.w } }));
    },

    raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number, filter?: PhysicsQueryFilter3D): RaycastHit3D | null {
      assertLive('raycast');
      const len = Math.hypot(direction.x, direction.y, direction.z);
      if (!(len > 0) || !finite(maxDistance) || maxDistance <= 0 || !isVec3(origin)) return null;
      const u = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
      // A script's filter (collision layers as groups; tags and exclusions as the predicate); a ray reaches 10 km.
      const reach = Math.min(maxDistance, 10000);
      const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, u), reach, true, undefined, groupsOf(filter), primary.collider, undefined, predicateOf(filter));
      if (hit === null) return null;
      const entityId = infoByHandle.get(hit.collider.handle)?.entityId;
      const t = hit.timeOfImpact;
      return entityId === undefined ? null : { entityId, distance: t, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z }, point: { x: origin.x + u.x * t, y: origin.y + u.y * t, z: origin.z + u.z * t } };
    },

    overlap(shape: OverlapShape3D, center: PhysicsVec3, rotation?: PhysicsQuat, filter?: PhysicsQueryFilter3D): string[] {
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
      }, undefined, groupsOf(filter), primary.collider, undefined, predicateOf(filter));
      return [...ids].sort();
    },

    characterClearance(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D {
      assertLive('characterClearance');
      if (!isVec3(origin)) throw new Error('characterClearance origin must be a finite { x, y, z }');
      return computeClearance(bodyOf(characterId, 'characterClearance'), origin);
    },

    placeCharacter(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D {
      assertLive('placeCharacter');
      if (!isVec3(origin)) throw new Error('placeCharacter origin must be a finite { x, y, z }');
      const b = bodyOf(characterId, 'placeCharacter');
      b.position = { x: origin.x, y: origin.y, z: origin.z };
      b.collider.setTranslation(at(b, b.position));
      b.staged = null;
      b.grounded = false;
      b.retainedSupport = { x: 0, y: 1, z: 0 };
      b.stepping = null;
      world.step();
      return computeClearance(b, origin);
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
          const a = addStaticBody(world, spec, bits);
          bodies.set(spec.entityId, a.body);
          for (const c of a.colliders) infoByHandle.set(c.collider.handle, c.info);
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
      // One pass over the collider records for the whole batch.
      const gone = new Set<unknown>();
      for (const id of entityIds) {
        const body = bodies.get(id);
        if (body === undefined) continue;
        gone.add(body);
        world.removeRigidBody(body);
        bodies.delete(id);
        kinematicAt.delete(id);
      }
      if (gone.size > 0) for (const [handle, info] of [...infoByHandle]) if (gone.has(info.body)) infoByHandle.delete(handle);
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
    const bits = layerBitsOf(config.layers);
    for (const spec of config.statics) {
      const added = addStaticBody(world, spec, bits);
      bodies.set(spec.entityId, added.body);
      for (const c of added.colliders) infoByHandle.set(c.collider.handle, c.info);
    }
    // The first character, then each further one (several player controllers), each with its own tuning.
    const primary = makeCharacterBody3D(world, config.character, config.controller);
    // A world without a character keeps its placeholder capsule disabled (no contacts, no query sees it).
    if (config.noCharacter === true) primary.collider.setEnabled(false);
    const further = new Map<string, CharacterBody3D>();
    for (const c of config.characters ?? []) further.set(c.id, makeCharacterBody3D(world, c, c.controller ?? config.controller));
    // One pipeline update so the first sweep and any ray see every collider (no dynamic bodies: nothing moves).
    world.step();
    return { ok: true, port: createAdapter(world, primary, further, config, bodies, infoByHandle, bits) };
  } catch (error) {
    world?.free();
    return { ok: false, error: { code: 'physics_init_failed', reason: 'wasm_unavailable', message: `Rapier 3D world construction failed: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
