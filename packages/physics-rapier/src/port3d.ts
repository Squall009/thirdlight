/**
 * The Rapier physics port (`@dimforge/rapier3d-compat@0.20.0`): the one
 * backend every game runs on; a side view is a plane lock on its bodies.
 *
 * One `World` per port; static box colliders
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
 * the character's sweep; raycasts, overlap queries (box,
 * sphere, capsule, cylinder) and the character's clearance/placement.
 */
import { quatMultiply } from '@thirdlight/shared';
import { COLLIDER_3D_LIMITS } from '@thirdlight/project-model/limits';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { AddedCharacter3D, BodyPlaneChange, CharacterClearanceResult3D, CharacterMoveResult3D, KinematicPose3D, OverlapShape3D, PhysicsDiagnostics, PhysicsInitConfig3D, PhysicsPlane, PhysicsPort3D, PhysicsQuat, PhysicsQueryFilter3D, PhysicsVec3, RaycastHit3D, StaticColliderSpec3D } from '@thirdlight/runtime';

import { inPlane, isPlane, lockBody, onPlane, planePose } from './plane3d';
import { capsuleLowAlong, holds, markOneWay, OneWaySweeps, upOf, type OneWayShape } from './oneway3d';
import { createStepUp } from './step-up3d';
import { groundContacts3D, type InternalEdgeWorld } from './internal-edges3d';
import { offWallSweep, settleDrop, skinLift, sweepFrom, type SettleWorld } from './settle3d';
import { moversNear, restoreMovers, stillMovers, type StilledBody } from './kinematic-still3d';
import { CLEARANCE_PENETRATION_EPS, CLEARANCE_RAY_EPS, CLEARANCE_SUPPORT_PROBE, FIXED_HZ_CHOICES, FOOTPRINT_BALL, GROUND_NORMAL_TOLERANCE, MAX_DROP_THROUGH_STEPS, MAX_SHAPE_VALUE } from './constants';

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
 * length, Rapier's convention), a cylinder (along its local Y, `halfHeight`
 * half its full height), the convex hull of points, or a triangle
 * mesh (a static collider only). Point lists are flat `[x, y, z, ...]`.
 */
export type ColliderPrimitive3D =
  | ColliderShapeBox3D
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; halfHeight: number }
  | { type: 'cylinder'; radius: number; halfHeight: number }
  | { type: 'convex'; points: readonly number[] }
  | { type: 'mesh'; vertices: readonly number[]; indices: readonly number[]; oriented?: boolean }
  | { type: 'heightfield'; cellsX: number; cellsZ: number; cellX: number; cellZ: number; heights: Float32Array };

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
export const MAX_HEIGHTFIELD_CELLS_3D = COLLIDER_3D_LIMITS.heightfieldCells;
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
  suspendCharacter(suspended: boolean, characterId?: string): void;
  lastResultOf(characterId: string): CharacterMoveResult3D | undefined;
  restartWorld(origins?: readonly { characterId?: string; position: PhysicsVec3 }[]): void;
  addCharacter(spec: AddedCharacter3D): void;
  /** Take an added character out of the world (its player left the game for good); an unknown id is ignored. */
  removeCharacter(id: string): void;
  /** Let a character (absent id: the first) pass every one-way collider for the next `steps` steps (at most `MAX_DROP_THROUGH_STEPS`). */
  dropThrough(steps: number, characterId?: string): void;
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
  if (type === 'cylinder') {
    if (!positive(v['radius'])) return { ok: false, detail: `cylinder radius must satisfy 0 < radius <= ${MAX_SHAPE_VALUE}` };
    if (!positive(v['halfHeight'])) return { ok: false, detail: `cylinder halfHeight must satisfy 0 < halfHeight <= ${MAX_SHAPE_VALUE}` };
    const extra = onlyKeys(v, ['type', 'radius', 'halfHeight'], 'cylinder');
    if (extra !== null) return { ok: false, detail: extra };
    return { ok: true, shape: { type: 'cylinder', radius: v['radius'] as number, halfHeight: v['halfHeight'] as number } };
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
    const extra = onlyKeys(v, ['type', 'vertices', 'indices', 'oriented'], 'mesh');
    if (extra !== null) return { ok: false, detail: extra };
    if (v['oriented'] !== undefined && typeof v['oriented'] !== 'boolean') return { ok: false, detail: 'mesh oriented must be true or false' };
    return { ok: true, shape: { type: 'mesh', vertices, indices, ...(v['oriented'] === true ? { oriented: true } : {}) } };
  }
  if (type === 'heightfield') {
    const extra = onlyKeys(v, ['type', 'cellsX', 'cellsZ', 'cellX', 'cellZ', 'heights'], 'heightfield');
    if (extra !== null) return { ok: false, detail: extra };
    const cx = v['cellsX'];
    const cz = v['cellsZ'];
    for (const [k, n] of [['cellsX', cx], ['cellsZ', cz]] as const) {
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_HEIGHTFIELD_CELLS_3D) return { ok: false, detail: `heightfield ${k} must be a whole number of cells, 1-${MAX_HEIGHTFIELD_CELLS_3D}` };
    }
    for (const k of ['cellX', 'cellZ'] as const) if (!positive(v[k])) return { ok: false, detail: `heightfield ${k} must satisfy 0 < ${k} <= ${MAX_SHAPE_VALUE}` };
    const h = v['heights'];
    const count = ((cx as number) + 1) * ((cz as number) + 1);
    if (!(Array.isArray(h) || h instanceof Float32Array) || (h as ArrayLike<number>).length !== count) return { ok: false, detail: `heightfield heights must be (cellsX + 1) × (cellsZ + 1) = ${count} numbers` };
    const heights = h instanceof Float32Array ? h : Float32Array.from(h as number[]);
    // A tile's million heights: one plain loop over a local bound.
    const lim = MAX_SHAPE_VALUE;
    for (let i = 0; i < heights.length; i++) {
      const y = heights[i]!;
      if (!(y >= -lim && y <= lim)) return { ok: false, detail: `heightfield height ${i} must be finite, within ±${lim}` };
    }
    return { ok: true, shape: { type: 'heightfield', cellsX: cx as number, cellsZ: cz as number, cellX: v['cellX'] as number, cellZ: v['cellZ'] as number, heights } };
  }
  return { ok: false, detail: 'a 3D collider is a box, sphere, capsule, cylinder, convex hull, mesh or heightfield (a flat box, polygon or circle takes its solid form first)' };
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
  if (spec.kinematic === true && partsOf(shape.shape).some((p) => p.shape.type === 'mesh' || p.shape.type === 'heightfield')) return { reason: 'invalid_shape', message: `${label}: a mesh collider is static, a heightfield too (a moving collider uses box, sphere, capsule or convex)` };
  if (spec.maxSlope !== undefined && (!finite(spec.maxSlope) || spec.maxSlope <= 0 || spec.maxSlope >= Math.PI / 2)) return { reason: 'invalid_config', message: `${label}: maxSlope must be a finite angle in (0, pi/2) or absent` };
  if (spec.plane !== undefined && !isPlane(spec.plane)) return { reason: 'invalid_config', message: `${label}: plane must be { axis: 'x' | 'z', origin } or absent` };
  if (spec.oneWay !== undefined && typeof spec.oneWay !== 'boolean') return { reason: 'invalid_config', message: `${label}: oneWay must be a boolean or absent` };
  return null;
}

type ConfigProblem3D = { reason: 'invalid_config' | 'invalid_shape' | 'invalid_transform'; message: string };

/** A character's problem (its origin and capsule), or null; `label` names it in the message. */
function characterProblem3D(ch: PhysicsInitConfig3D['character'], label: string): ConfigProblem3D | null {
  if (typeof ch !== 'object' || ch === null || !isVec3(ch.position)) return { reason: 'invalid_transform', message: `${label}.position must be a finite { x, y, z }` };
  if (!finite(ch.radius) || ch.radius <= 0 || ch.radius > 1e3) return { reason: 'invalid_config', message: `${label}.radius must be a finite number in (0, 1000]` };
  if (!finite(ch.halfHeight) || ch.halfHeight < 0 || ch.halfHeight > 1e3) return { reason: 'invalid_config', message: `${label}.halfHeight must be a finite number in [0, 1000]` };
  if (!isVec3(ch.offset)) return { reason: 'invalid_config', message: `${label}.offset must be a finite { x, y, z }` };
  if (ch.plane !== undefined && !isPlane(ch.plane)) return { reason: 'invalid_config', message: `${label}.plane must be { axis: 'x' | 'z', origin } or absent` };
  return null;
}

/** A character controller config's problem, or null; `label` names it in the message. */
function controllerProblem3D(cc: PhysicsInitConfig3D['controller'], label: string): ConfigProblem3D | null {
  if (typeof cc !== 'object' || cc === null) return { reason: 'invalid_config', message: `${label} config is required` };
  if (!finite(cc.offsetSkin) || cc.offsetSkin < 0.001 || cc.offsetSkin > 0.1) return { reason: 'invalid_config', message: `${label}.offsetSkin must be a finite number in [0.001, 0.1] m` };
  if (!finite(cc.groundSnap) || cc.groundSnap < 0 || cc.groundSnap > 1) return { reason: 'invalid_config', message: `${label}.groundSnap must be a finite number in [0, 1] m` };
  if (typeof cc.autostep !== 'boolean') return { reason: 'invalid_config', message: `${label}.autostep must be true or false` };
  if (cc.autostep && (!finite(cc.autostepHeight) || cc.autostepHeight < 0.01 || cc.autostepHeight > 2)) return { reason: 'invalid_config', message: `${label}.autostep needs autostepHeight, a finite number in [0.01, 2] m` };
  if (cc.autostepRide !== undefined && typeof cc.autostepRide !== 'boolean') return { reason: 'invalid_config', message: `${label}.autostepRide must be true, false or absent` };
  if (!finite(cc.maxSlopeClimbRad) || cc.maxSlopeClimbRad <= 0 || cc.maxSlopeClimbRad >= Math.PI / 2) return { reason: 'invalid_config', message: `${label}.maxSlopeClimbRad must be a finite angle in (0, pi/2)` };
  if (!finite(cc.minSlopeSlideRad) || cc.minSlopeSlideRad < 0 || cc.minSlopeSlideRad >= Math.PI / 2) return { reason: 'invalid_config', message: `${label}.minSlopeSlideRad must be a finite angle in [0, pi/2)` };
  return null;
}

/** A further character's problem (its id new among `taken`, its capsule and tuning), or null. */
function furtherProblem3D(c: AddedCharacter3D, label: string, taken: { has(id: string): boolean }): ConfigProblem3D | null {
  if (typeof c !== 'object' || c === null || typeof c.id !== 'string' || c.id.length === 0 || taken.has(c.id)) return { reason: 'invalid_config', message: `${label}.id must be a non-empty string, once` };
  return characterProblem3D(c, label) ?? (c.controller !== undefined ? controllerProblem3D(c.controller, `${label}.controller`) : null);
}

/** Validate the whole init config before any WASM or world work (nothing is silently defaulted). */
function validateConfig(config: PhysicsInitConfig3D): ConfigProblem3D | null {
  if (typeof config !== 'object' || config === null) return { reason: 'invalid_config', message: 'physics init config must be an object' };
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
  if (config.buildAtRunStart !== undefined && config.buildAtRunStart !== true) return { reason: 'invalid_config', message: 'buildAtRunStart must be true or absent' };
  // Further characters (several player controllers): each its own object, origin, capsule and tuning.
  if (config.characters !== undefined) {
    if (!Array.isArray(config.characters) || config.noCharacter === true) return { reason: 'invalid_config', message: 'characters must be an array, in a world with a character' };
    const ids = new Set<string>();
    for (let i = 0; i < config.characters.length; i += 1) {
      const c = config.characters[i]!;
      const label = `characters[${i}]`;
      const problem = furtherProblem3D(c, label, ids);
      if (problem !== null) return problem;
      ids.add(c.id);
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

// ---- WASM initialization and memory ----

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
  /** A one-way collider's top and reach (absent: it holds from every side). */
  oneWay?: OneWayShape;
  /** A triangle mesh of unknown winding: it has no inside, so the between-collider internal-edge rule leaves it out. */
  unoriented?: true;
}

/** Whether a collider counts as a solid static for the internal-edge rule (not one-way, of a known inside). */
const solidStaticInfo = (info: Collider3DInfo | undefined): boolean => info?.oneWay === undefined && info?.unoriented !== true;

/** `a · b` of quaternions as the physics port holds them. */
function turned(a: PhysicsQuat, b: PhysicsQuat): PhysicsQuat {
  const [x, y, z, w] = quatMultiply([a.x, a.y, a.z, a.w], [b.x, b.y, b.z, b.w]);
  return { x, y, z, w };
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
    case 'cylinder':
      return RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    case 'convex':
      return RAPIER.ColliderDesc.convexHull(new Float32Array(shape.points));
    case 'mesh': {
      // Duplicate vertices (a model's seams) are merged and degenerate triangles dropped. On an oriented mesh,
      // contacts on an edge between two triangles take the faces' normals: a block layer's wall is cut into a
      // quad per cell, and without it a capsule sliding down the wall was grounded on an edge between them and
      // hung there. The fix makes the mesh one-sided by its winding, so a mesh of unknown winding (an imported
      // model's, perhaps open or used from inside) is left two-sided.
      const flags = RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES | (shape.oriented === true ? RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES : 0);
      return RAPIER.ColliderDesc.trimesh(new Float32Array(shape.vertices), new Uint32Array(shape.indices), flags);
    }
    case 'heightfield': {
      // Rapier's matrix: rows along z, columns along x, column-major (the shape's order), centred on the collider; its cells split the same diagonal.
      return RAPIER.ColliderDesc.heightfield(shape.cellsZ, shape.cellsX, shape.heights, { x: shape.cellsX * shape.cellX, y: 1, z: shape.cellsZ * shape.cellZ });
    }
  }
}

/** Where a shape's own frame sits from its collider's origin: a heightfield's origin is its min corner, Rapier's its centre. */
function shapeOffset(shape: ColliderPrimitive3D): [number, number, number] {
  return shape.type === 'heightfield' ? [(shape.cellsX * shape.cellX) / 2, 0, (shape.cellsZ * shape.cellZ) / 2] : [0, 0, 0];
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
    case 'cylinder': {
      // Its axis's reach up plus the radius of the end disc across it.
      const a = rotate(q, [0, 1, 0])[1];
      return Math.abs(a) * shape.halfHeight + shape.radius * Math.sqrt(Math.max(0, 1 - a * a));
    }
    case 'heightfield': {
      let top = -Infinity;
      for (let i = 0; i < shape.heights.length; i++) top = Math.max(top, shape.heights[i]!);
      return rotate(q, [0, top, 0])[1];
    }
    case 'convex':
    case 'mesh': {
      const pts = shape.type === 'convex' ? shape.points : shape.vertices;
      let top = -Infinity;
      for (let i = 0; i < pts.length; i += 3) top = Math.max(top, rotate(q, [pts[i]!, pts[i + 1]!, pts[i + 2]!])[1]);
      return top;
    }
  }
}

/** The radius around its own origin that holds a shape (a one-way collider's reach). */
function reachOf(shape: ColliderPrimitive3D): number {
  switch (shape.type) {
    case 'box':
      return Math.hypot(shape.hx, shape.hy, shape.hz);
    case 'sphere':
      return shape.radius;
    case 'capsule':
      return shape.halfHeight + shape.radius;
    case 'cylinder':
      return Math.hypot(shape.halfHeight, shape.radius);
    case 'heightfield':
      return Math.hypot(shape.cellsX * shape.cellX, shape.cellsZ * shape.cellZ) + Math.max(...Array.from(shape.heights, Math.abs), 0);
    case 'convex':
    case 'mesh': {
      const pts = shape.type === 'convex' ? shape.points : shape.vertices;
      let r = 0;
      for (let i = 0; i < pts.length; i += 3) r = Math.max(r, Math.hypot(pts[i]!, pts[i + 1]!, pts[i + 2]!));
      return r;
    }
  }
}

/** A one-way collider's top along its body's local +Y and its reach, over all its placed shapes (in the body's frame). */
function oneWayShapeOf(parts: readonly ColliderPart3D[]): OneWayShape {
  let localTop = -Infinity;
  let reach = 0;
  for (const p of parts) {
    localTop = Math.max(localTop, p.position.y + topOf(p.shape, p.rotation));
    reach = Math.max(reach, Math.hypot(p.position.x, p.position.y, p.position.z) + reachOf(p.shape));
  }
  return { localTop, reach };
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

/**
 * One fixed (or kinematic) body for a collider spec with a collider per
 * placed shape (a compound's parts, each at its position and rotation in the
 * body's frame); every collider answers for the spec's entity.
 */
function addStaticBody(world: RAPIER.World, spec: StaticColliderSpec3D, bits: LayerBits, checked = false): { body: RAPIER.RigidBody; colliders: { collider: RAPIER.Collider; info: Collider3DInfo }[] } {
  // A spec read back from a world's colliders was checked when first added (a rebuild skips the per-triangle check).
  const shape = checked ? ({ ok: true, shape: spec.shape as ColliderShape3D } as const) : validateColliderShape3D(spec.shape);
  if (!shape.ok) throw new Error(`statics(${spec.entityId}): ${shape.detail}`);
  const parts = partsOf(shape.shape);
  const descs = parts.map((p) => colliderDescOf(p.shape));
  if (descs.some((d) => d === null)) throw new Error(`statics(${spec.entityId}): the convex points span no hull (they lie on one plane)`);
  const kinematic = spec.kinematic === true;
  // A body locked to a plane is made on it.
  const pose = spec.plane !== undefined ? planePose(spec.position, spec.rotation, spec.plane) : { position: spec.position, rotation: spec.rotation };
  const rotation = { x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w };
  const bodyDesc = kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc.setTranslation(pose.position.x, pose.position.y, pose.position.z).setRotation(rotation));
  const groups = colliderGroups(bits, spec.layers);
  // The body's highest point over all its shapes (the kinematic-drag rule reads it).
  let top = -Infinity;
  for (const p of parts) top = Math.max(top, rotate(rotation, [p.position.x, p.position.y, p.position.z])[1] + topOf(p.shape, turned(rotation, p.rotation)));
  const oneWay = spec.oneWay === true ? oneWayShapeOf(parts) : undefined;
  const colliders = parts.map((p, i) => {
    const off = rotate(p.rotation, shapeOffset(p.shape));
    const desc = descs[i]!.setTranslation(p.position.x + off[0], p.position.y + off[1], p.position.z + off[2]).setRotation({ x: p.rotation.x, y: p.rotation.y, z: p.rotation.z, w: p.rotation.w });
    const collider = world.createCollider((oneWay !== undefined ? markOneWay(desc) : desc).setCollisionGroups(groups), body);
    const unoriented = p.shape.type === 'mesh' && p.shape.oriented !== true;
    return { collider, info: { entityId: spec.entityId, body, kinematic, top, ...(spec.maxSlope !== undefined ? { climbCos: Math.cos(spec.maxSlope) } : {}), ...(oneWay !== undefined ? { oneWay } : {}), ...(unoriented ? { unoriented: true as const } : {}) } };
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
  /** The capsule and its controller (a rebuilt world makes both anew). */
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
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
  /** The plane it is locked to (null: free); its moves keep to it. */
  plane: PhysicsPlane | null;
  /** Steps left passing every one-way collider (a drop through). */
  dropSteps: number;
  /** Held still by the runtime (`suspendCharacter`): not swept, its last result kept. */
  suspended: boolean;
}

/** A character's capsule collider (parentless, at its origin + offset) and its controller. */
function makeCharacterBody3D(world: RAPIER.World, given: PhysicsInitConfig3D['character'], tuning: PhysicsInitConfig3D['controller']): CharacterBody3D {
  // A character locked to a plane starts on it.
  const plane = given.plane ?? null;
  const ch = plane !== null ? { ...given, position: onPlane(given.position, plane) } : given;
  const { collider, controller } = makeCapsule3D(world, ch, tuning);
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
    plane,
    dropSteps: 0,
    suspended: false,
  };
}

/**
 * Further characters added while the world runs (a player arrives) and taken
 * out for good (a spawned player destroyed). `world` reads the world in use
 * (a rebuild makes a new one, with the characters it holds); `listed` lists
 * the characters again.
 */
function furtherCharacters3D(world: () => RAPIER.World, further: Map<string, CharacterBody3D>, tuning: PhysicsInitConfig3D['controller'], assertLive: (op: string) => void, listed: () => void): Pick<RapierPhysicsPort3D, 'addCharacter' | 'removeCharacter'> {
  return {
    addCharacter(spec: AddedCharacter3D): void {
      assertLive('addCharacter');
      const problem = furtherProblem3D(spec, 'addCharacter', { has: (id) => further.has(id) });
      if (problem !== null) throw new Error(problem.message);
      further.set(spec.id, makeCharacterBody3D(world(), spec, spec.controller ?? tuning));
      listed();
    },
    removeCharacter(id: string): void {
      assertLive('removeCharacter');
      const b = further.get(id);
      if (b === undefined) return;
      world().removeCharacterController(b.controller);
      world().removeCollider(b.collider, false);
      further.delete(id);
      listed();
    },
  };
}

/**
 * The movers' next poses (each mover locked to a plane posed on it: a
 * kinematic body ignores Rapier's locks), where each was posed kept; the
 * largest move from where it was posed last.
 */
function poseKinematics(poses: readonly KinematicPose3D[], bodies: ReadonlyMap<string, RAPIER.RigidBody>, staticSpecs: ReadonlyMap<string, StaticColliderSpec3D>, kinematicAt: Map<string, PhysicsVec3>): number {
  let moved = 0;
  for (const given of poses) {
    const body = bodies.get(given.entityId);
    if (body === undefined || !body.isKinematic()) continue;
    const plane = staticSpecs.get(given.entityId)?.plane;
    const pose = plane !== undefined ? planePose(given.position, given.rotation, plane) : given;
    const was = kinematicAt.get(given.entityId);
    if (was !== undefined) moved = Math.max(moved, Math.hypot(pose.position.x - was.x, pose.position.y - was.y, pose.position.z - was.z));
    kinematicAt.set(given.entityId, { x: pose.position.x, y: pose.position.y, z: pose.position.z });
    body.setNextKinematicTranslation({ x: pose.position.x, y: pose.position.y, z: pose.position.z });
    body.setNextKinematicRotation({ x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w });
  }
  return moved;
}

/** What the plane locks of a port reach in it (`world` and `deferred` read the port's current ones). */
interface PlaneLockParts {
  world: () => RAPIER.World;
  staticSpecs: Map<string, StaticColliderSpec3D>;
  bodies: ReadonlyMap<string, RAPIER.RigidBody>;
  kinematicAt: Map<string, PhysicsVec3>;
  deferred: () => boolean;
  bodyOf: (characterId: string | undefined, op: string) => CharacterBody3D;
  at: (b: CharacterBody3D, p: PhysicsVec3) => PhysicsVec3;
  assertLive: (op: string) => void;
}

/** A pipeline update (broad phase, contacts, scene queries) in which no time passes: nothing integrates. */
function refreshWithoutTime(world: RAPIER.World): void {
  const dt = world.timestep;
  world.timestep = 0;
  try {
    world.step();
  } finally {
    world.timestep = dt;
  }
}

/** Locking colliders' bodies or a character to a plane, and freeing them, at a step boundary. */
function planeLocks3D(d: PlaneLockParts): Pick<RapierPhysicsPort3D, 'setBodyPlane' | 'setBodyPlanes' | 'setCharacterPlane'> {
  return {
    setBodyPlane(entityId: string, plane: PhysicsPlane | null): boolean {
      return this.setBodyPlanes!([{ entityId, plane }])[0] === true;
    },

    setBodyPlanes(changes: readonly BodyPlaneChange[]): boolean[] {
      d.assertLive('setBodyPlanes');
      for (const c of changes) if (c.plane !== null && !isPlane(c.plane)) throw new Error(`setBodyPlane("${c.entityId}"): plane must be { axis: 'x' | 'z', origin } or null`);
      let moved = false;
      const done = changes.map(({ entityId, plane }) => {
        const spec = d.staticSpecs.get(entityId);
        if (spec === undefined) return false;
        // The kept spec carries the plane, so a rebuilt world makes the body on it again.
        const { plane: _was, ...free } = spec;
        d.staticSpecs.set(entityId, plane !== null ? { ...free, plane: { axis: plane.axis, origin: plane.origin } } : free);
        const body = d.bodies.get(entityId);
        if (d.deferred() || body === undefined) return true;
        lockBody(body, plane);
        moved = true;
        if (plane !== null && body.isKinematic()) {
          const t = body.translation();
          d.kinematicAt.set(entityId, { x: t.x, y: t.y, z: t.z });
        }
        return true;
      });
      // The scene queries and the next sweep see them where they are now: one
      // pipeline update for the whole batch, with no time passing (a step of
      // the run's length would move dynamic bodies on by a step).
      if (moved) refreshWithoutTime(d.world());
      return done;
    },

    setCharacterPlane(plane: PhysicsPlane | null, characterId?: string): PhysicsVec3 {
      d.assertLive('setCharacterPlane');
      if (plane !== null && !isPlane(plane)) throw new Error('setCharacterPlane: plane must be { axis: \'x\' | \'z\', origin } or null');
      const b = d.bodyOf(characterId, 'setCharacterPlane');
      b.plane = plane !== null ? { axis: plane.axis, origin: plane.origin } : null;
      if (plane !== null) {
        b.position = onPlane(b.position, plane);
        b.collider.setTranslation(d.at(b, b.position));
        // A step-up under way was along the old way; it starts again from the plane.
        b.stepping = null;
      }
      return { x: b.position.x, y: b.position.y, z: b.position.z };
    },
  };
}

/** A character's capsule collider at its origin + offset and its own Rapier controller, in `world`. */
function makeCapsule3D(world: RAPIER.World, ch: PhysicsInitConfig3D['character'], tuning: PhysicsInitConfig3D['controller']): { collider: RAPIER.Collider; controller: RAPIER.KinematicCharacterController } {
  // PARENTLESS character collider: moved with setTranslation only (the position is the double kept here).
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(ch.halfHeight, ch.radius).setTranslation(ch.position.x + ch.offset.x, ch.position.y + ch.offset.y, ch.position.z + ch.offset.z));
  const controller = world.createCharacterController(tuning.offsetSkin);
  // Up is +Y (gravity along −Y).
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.setMaxSlopeClimbAngle(tuning.maxSlopeClimbRad);
  controller.setMinSlopeSlideAngle(tuning.minSlopeSlideRad);
  controller.enableSnapToGround(tuning.groundSnap);
  // Stepping up is the port's own (`stepProbe` / `stepping` in `step()`), not Rapier's
  // autostep, which missed risers above about 0.15 m with a capsule.
  return { collider, controller };
}

/** Both predicates (either may be absent). */
function bothPredicates(a: ((c: RAPIER.Collider) => boolean) | undefined, b: ((c: RAPIER.Collider) => boolean) | undefined): ((c: RAPIER.Collider) => boolean) | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (c) => a(c) && b(c);
}

const heavyShape = (s: ColliderPrimitive3D): boolean => s.type === 'mesh' || s.type === 'heightfield';
const NO_HEIGHTS = new Float32Array(0);

/**
 * What the port keeps of a static once its colliders are built: the spec
 * without a mesh's vertices and indices or a heightfield's heights, which the
 * world's colliders hold already (a rebuild reads them back: `wholeSpec`).
 * A streamed world's chunk meshes and terrain tiles stay in memory once.
 */
function keptSpec(spec: StaticColliderSpec3D): StaticColliderSpec3D {
  const empty = (s: ColliderPrimitive3D): ColliderPrimitive3D => (s.type === 'mesh' ? { type: 'mesh', vertices: [], indices: [] } : s.type === 'heightfield' ? { ...s, heights: NO_HEIGHTS } : s);
  const shape = spec.shape as ColliderShape3D;
  if (shape.type === 'compound') return shape.parts.some((p) => heavyShape(p.shape)) ? { ...spec, shape: { type: 'compound', parts: shape.parts.map((p) => (heavyShape(p.shape) ? { ...p, shape: empty(p.shape) } : p)) } } : spec;
  return heavyShape(shape) ? { ...spec, shape: empty(shape) } : spec;
}

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The clearance of a character's capsule if its centre were at `c` (query
 * only): blocked by the deepest overlap with a collider
 * (a narrow-phase contact deeper than the penetration epsilon), else
 * supported by the nearest collider straight below the capsule's lowest
 * point, else `no_support`. Characters are never in the way. A one-way
 * collider never blocks (the character passes through it from below and the
 * sides) and supports only a capsule whose lowest point along its up is on
 * or above its top.
 */
function clearanceAt(world: RAPIER.World, characterHandles: ReadonlySet<number>, infoByHandle: ReadonlyMap<number, Collider3DInfo>, shape: CharacterBody3D['shape'], c: PhysicsVec3): CharacterClearanceResult3D {
  const capsule = new RAPIER.Capsule(shape.halfHeight, shape.radius);
  const ignoredOneWay = (collider: RAPIER.Collider, forSupport: boolean): boolean => {
    const oneWay = infoByHandle.get(collider.handle)?.oneWay;
    if (oneWay === undefined) return false;
    if (!forSupport) return true;
    const body = collider.parent();
    if (body === null) return true;
    const u = upOf(body);
    const t = body.translation();
    return !holds(capsuleLowAlong(c, shape.halfHeight, shape.radius, u), t.x * u.x + t.y * u.y + t.z * u.z + oneWay.localTop, 0);
  };
  let maxPenetration = 0;
  world.colliders.forEach((collider) => {
    if (characterHandles.has(collider.handle) || ignoredOneWay(collider, false)) return;
    const contact = collider.contactShape(capsule, c, IDENTITY_Q, 0);
    if (contact !== null && contact.distance < -CLEARANCE_PENETRATION_EPS) maxPenetration = Math.max(maxPenetration, -contact.distance);
  });
  if (maxPenetration > 0) return { ok: false, reason: 'blocked', penetration: maxPenetration };
  const ray = new RAPIER.Ray({ x: c.x, y: c.y - (shape.halfHeight + shape.radius) + CLEARANCE_RAY_EPS, z: c.z }, { x: 0, y: -1, z: 0 });
  let support: PhysicsVec3 | null = null;
  let best = Infinity;
  world.colliders.forEach((collider) => {
    if (characterHandles.has(collider.handle) || ignoredOneWay(collider, true)) return;
    const hit = collider.castRayAndGetNormal(ray, CLEARANCE_SUPPORT_PROBE, true);
    if (hit !== null && hit.timeOfImpact < best) {
      best = hit.timeOfImpact;
      support = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
    }
  });
  if (support === null) return { ok: false, reason: 'no_support' };
  return { ok: true, supportNormal: support, penetration: 0 };
}

/**
 * The strictest climb cosine among a character's last sweep contacts that it
 * would walk up but their collider forbids (a slope steeper than a block
 * layer's maxSlope, gentler than the character's own limit); null: none.
 */
function stricterClimb(b: CharacterBody3D, infoByHandle: ReadonlyMap<number, Collider3DInfo>): number | null {
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
}

/**
 * The deepest overlap of a character's capsule centred at `c` with a
 * collider (deeper than the clearance probe's epsilon), or null. A sweep
 * that starts in one moves the character out of it — a real depenetration.
 * A grounded character's sweep stopped by the floor starts in none (the
 * controller keeps its skin above it), so standing never counts.
 */
function overlapOf(world: RAPIER.World, b: CharacterBody3D, c: PhysicsVec3, infoByHandle: ReadonlyMap<number, Collider3DInfo>, filter: ((c: RAPIER.Collider) => boolean) | undefined): { entityId: string; depth: number } | null {
  let best: { entityId: string; depth: number } | null = null;
  world.intersectionsWithShape(c, IDENTITY_Q, b.overlapCapsule, (collider) => {
    const contact = collider.contactShape(b.overlapCapsule, c, IDENTITY_Q, 0);
    const depth = contact === null ? 0 : -contact.distance;
    const entityId = infoByHandle.get(collider.handle)?.entityId;
    if (entityId !== undefined && depth > CLEARANCE_PENETRATION_EPS && (best === null || depth > best.depth)) best = { entityId, depth };
    return true;
  }, undefined, undefined, b.collider, undefined, filter);
  return best;
}

/**
 * A kept spec whole again, its arrays read back from the colliders it was
 * built as (one per part, in order). Rapier holds a mesh as merged (its
 * duplicate vertices and degenerate triangles gone), so building again from
 * what it holds gives the same mesh, every time.
 */
function wholeSpec(kept: StaticColliderSpec3D, colliders: readonly RAPIER.Collider[]): StaticColliderSpec3D {
  const fill = (s: ColliderPrimitive3D, c: RAPIER.Collider): ColliderPrimitive3D => {
    if (s.type === 'mesh') return { type: 'mesh', vertices: c.vertices() as unknown as number[], indices: (c.indices() ?? new Uint32Array(0)) as unknown as number[], ...(s.oriented === true ? { oriented: true } : {}) };
    if (s.type === 'heightfield') return { ...s, heights: c.heightfieldHeights() };
    return s;
  };
  const shape = kept.shape as ColliderShape3D;
  if (shape.type === 'compound') return { ...kept, shape: { type: 'compound', parts: shape.parts.map((p, i) => (heavyShape(p.shape) ? { ...p, shape: fill(p.shape, colliders[i]!) } : p)) } };
  return heavyShape(shape) ? { ...kept, shape: fill(shape, colliders[0]!) } : kept;
}

/** An overlap query's Rapier shape (each extent at most 500 m), or null for a bad one. */
function overlapShapeOf(shape: OverlapShape3D): RAPIER.Shape | null {
  const ok = (v: unknown): v is number => finite(v) && v > 0;
  if (shape?.type === 'box' && ok(shape.hx) && ok(shape.hy) && ok(shape.hz)) return new RAPIER.Cuboid(Math.min(shape.hx, 500), Math.min(shape.hy, 500), Math.min(shape.hz, 500));
  if (shape?.type === 'sphere' && ok(shape.radius)) return new RAPIER.Ball(Math.min(shape.radius, 500));
  if (shape?.type === 'capsule' && ok(shape.radius) && finite(shape.halfHeight) && shape.halfHeight >= 0) return new RAPIER.Capsule(Math.min(shape.halfHeight, 500), Math.min(shape.radius, 500));
  if (shape?.type === 'cylinder' && ok(shape.radius) && ok(shape.halfHeight)) return new RAPIER.Cylinder(Math.min(shape.halfHeight, 500), Math.min(shape.radius, 500));
  return null;
}

/** A character's result standing still at `p` (the placeholder of a world without one, which never moves). */
function restingAt(p: PhysicsVec3): CharacterMoveResult3D {
  const zero = { x: 0, y: 0, z: 0 };
  return { requested: zero, applied: { ...zero }, position: { x: p.x, y: p.y, z: p.z }, grounded: false, supportNormal: { x: 0, y: 1, z: 0 }, contacts: { ground: false, wall: false, head: false, steepSlope: false }, snapped: false, groundEntityId: null };
}

/** Held still (`suspendCharacter`): not swept this step; a move staged meanwhile is dropped. */
function heldStill(b: CharacterBody3D): null {
  b.staged = null;
  return null;
}

/** Holding characters still while the runtime has them outside the loaded collision. */
function suspension3D(bodyOf: (characterId: string | undefined, op: string) => CharacterBody3D, assertLive: (op: string) => void): Pick<RapierPhysicsPort3D, 'suspendCharacter'> {
  return {
    suspendCharacter(suspended: boolean, characterId?: string): void {
      assertLive('suspendCharacter');
      bodyOf(characterId, 'suspendCharacter').suspended = suspended === true;
    },
  };
}

function createAdapter(initialWorld: RAPIER.World, primary: CharacterBody3D, further: Map<string, CharacterBody3D>, config: PhysicsInitConfig3D, staticSpecs: Map<string, StaticColliderSpec3D>, bodies: Map<string, RAPIER.RigidBody>, infoByHandle: Map<number, Collider3DInfo>, bits: LayerBits, collidersOf: Map<string, RAPIER.Collider[]>): RapierPhysicsPort3D {
  /** The world (`restartWorld` replaces it). */
  let world = initialWorld;
  /**
   * A world made for a run (`buildAtRunStart`) holds its statics as specs
   * only until they are first needed: the run's start (`restartWorld`) builds
   * them once, where building them at creation too would build every static
   * twice before the first step. A step or a query before that builds them.
   */
  let deferred = config.buildAtRunStart === true;
  const noCharacter = config.noCharacter === true;
  /** Every character, the init config's first, then the further ones in their order (the step sweeps them in this order). */
  let chars: readonly CharacterBody3D[] = [];
  const characterHandles = new Set<number>();
  /**
   * With several characters, the predicate that leaves the other characters
   * out of a sweep or a query (each already leaves its own character out);
   * with one, none (the queries are exactly as they were).
   */
  let othersOut: ((c: RAPIER.Collider) => boolean) | undefined;
  /** The character list after one was added or the world was rebuilt (a world without a character sweeps only the added ones). */
  const listCharacters = (): void => {
    chars = noCharacter ? [...further.values()] : [primary, ...further.values()];
    characterHandles.clear();
    for (const b of [primary, ...further.values()]) characterHandles.add(b.collider.handle);
    othersOut = characterHandles.size > 1 ? (c) => !characterHandles.has(c.handle) : undefined;
  };
  listCharacters();
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
  const oneWays = new OneWaySweeps(); // listed again whenever colliders come or go
  /** Whether any collider sets a stricter climb limit than a character's own (a block layer's maxSlope). */
  let climbLimits = false;
  const relistOneWay = (): void => {
    oneWays.relist(infoByHandle);
    climbLimits = [...infoByHandle.values()].some((i) => i.climbCos !== undefined);
  };
  relistOneWay();
  /** `run` with the one-way colliders that do not hold the character now out of every sweep and probe it makes (`moving`: its move this step; null: where it is only). */
  function withOneWay<T>(b: CharacterBody3D, moving: PhysicsVec3 | null, run: () => T): T {
    const keep = oneWays.filterFor(at(b, b.position), b.shape, b.tuning, moving, b.dropSteps > 0);
    if (keep === null) return run();
    const kept = othersOut;
    othersOut = bothPredicates(kept, keep);
    try {
      return run();
    } finally {
      othersOut = kept;
    }
  }
  const edges: InternalEdgeWorld & SettleWorld = {
    get world() {
      return world;
    },
    sees: (c) => !characterHandles.has(c.handle) && (othersOut === undefined || othersOut(c)),
    solidStatic: (c) => solidStaticInfo(infoByHandle.get(c.handle)) && edges.fixed(c),
    fixed: (c) => infoByHandle.get(c.handle)?.kinematic === false,
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
  /** The bodies at rest for the current sweep, with the velocities they get back after it. */
  const stilled: StilledBody[] = [];
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
  const at = (b: CharacterBody3D, p: PhysicsVec3): PhysicsVec3 => ({ x: p.x + b.shape.offset.x, y: p.y + b.shape.offset.y, z: p.z + b.shape.offset.z });
  const probeFrom = (b: CharacterBody3D, p: PhysicsVec3): PhysicsVec3 => ({ x: p.x + b.shape.offset.x, y: p.y + b.shape.offset.y - (b.shape.halfHeight + b.shape.radius) + 0.05, z: p.z + b.shape.offset.z });
  /**
   * What the character stands on: under its centre, else under its
   * footprint (a capsule on a rim, its centre past the edge, still rests on
   * it). A ball a little narrower than the capsule, at its bottom sphere,
   * is cast down the same 0.2 m as the centre ray, so a wall it touches at
   * its side is never taken for its ground. The runtime's carry
   * (`groundEntityId`) and the sweep's stilling of what it stands on read
   * this one answer.
   */
  const supportUnder = (b: CharacterBody3D, p: PhysicsVec3): RAPIER.Collider | null => {
    const hit = world.castRay(new RAPIER.Ray(probeFrom(b, p), down), 0.2, true, undefined, undefined, b.collider, undefined, othersOut);
    if (hit !== null) return hit.collider;
    const c = at(b, p);
    const foot = new RAPIER.Ball(b.shape.radius * FOOTPRINT_BALL);
    const from = { x: c.x, y: c.y - b.shape.halfHeight + 0.05, z: c.z };
    return world.castShape(from, IDENTITY_Q, down, foot, 0, 0.2 + b.shape.radius * (1 - FOOTPRINT_BALL), true, undefined, undefined, b.collider, undefined, othersOut)?.collider ?? null;
  };
  const groundUnder = (b: CharacterBody3D, p: PhysicsVec3): string | null => {
    const collider = supportUnder(b, p);
    return collider === null ? null : (infoByHandle.get(collider.handle)?.entityId ?? null);
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
  const { stepProbe, rideStep } = createStepUp<CharacterBody3D>({ at, filter: () => othersOut, walkableFloorUnder });
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
   * The movers are posed for the world update (`measure`: the largest move
   * is kept for the characters' next sweep). A mover locked to a plane is
   * posed on it: a kinematic body ignores Rapier's locks.
   */
  function poseMovers(measure: boolean): void {
    const moved = poseKinematics(kinematicPoses, bodies, staticSpecs, kinematicAt);
    if (measure) kinematicMoved = moved;
    kinematicPoses = [];
  }

  /** The movers are posed (after every character's sweep) and the world updates once. */
  function poseMoversAndStep(): void {
    poseMovers(true);
    world.step();
    steps += 1;
  }

  /** The step of a world without a character — the movers are posed and the world updates; nothing is swept. */
  function stepWithoutCharacter(): CharacterMoveResult3D {
    primary.staged = null;
    poseMovers(false);
    world.step();
    steps += 1;
    return restingAt(primary.position);
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
    // included (dropping it made Rapier's grounded status flicker every other step on flat ground — measured with a walking character; the sweep
    // stops it on the ground and keeps it grounded).
    // A character on a plane moves in it only.
    const commanded: PhysicsVec3 = b.plane !== null ? inPlane(requested, b.plane) : { x: requested.x, y: requested.y, z: requested.z };
    const across = Math.hypot(commanded.x, commanded.z);
    // A step-up goes on while the character keeps pushing the way it went (not up).
    const st = b.stepping;
    if (st !== null && (commanded.y > 0 || across < 1e-9 || commanded.x * st.x + commanded.z * st.z <= 0 || st.steps >= maxSteppingSteps)) b.stepping = null;
    const midStep = b.stepping !== null;
    const before = b.position;
    const startGround = midStep || b.grounded ? 1 : groundContacts3D(edges, b.overlapCapsule, at(b, before), b.tuning, false);
    // A step that begins inside a collider is a real depenetration (counted; the deepest is kept for diagnostics).
    const overlap = overlapOf(world, b, at(b, before), infoByHandle, othersOut);
    if (overlap !== null) {
      penetrationCorrectedCount += 1;
      if (deepestOverlap === null || overlap.depth > deepestOverlap.depth) deepestOverlap = { ...overlap, step: steps };
    }
    // Movers within its reach that the carry moves the character with, or that rise or sink past it, are at rest for its sweep.
    stillMovers(moversNear(world, infoByHandle, at(b, before), b.shape.halfHeight + b.shape.radius + Math.hypot(commanded.x, commanded.y, commanded.z) + stepLift + snapDistance + 2 * skin + 0.5), () => {
      const under = supportUnder(b, before);
      return under === null ? null : (infoByHandle.get(under.handle)?.body ?? null);
    }, stilled);
    if (midStep) {
      // On the riser's height: across only, without the snap (which would pull it back down the riser).
      controller.disableSnapToGround();
      controller.computeColliderMovement(characterCollider, { x: commanded.x, y: 0, z: commanded.z }, undefined, undefined, othersOut);
      controller.enableSnapToGround(snapDistance);
    } else {
      // Rapier also grounds (and snaps down) from where the sweep starts: an airborne character whose
      // only ground-like contacts there are internal edges (sliding down a stacked wall past a seam)
      // sweeps without the snap, so the seam neither catches nor pulls it.
      if (startGround === -1) controller.disableSnapToGround();
      controller.computeColliderMovement(characterCollider, commanded, undefined, undefined, othersOut);
      // A slope the character could climb but whose collider sets a stricter limit (a block layer's maxSlope):
      // swept again with that limit, so the slope is a wall to it. Colliders without a limit never get here.
      const stricter = climbLimits ? stricterClimb(b, infoByHandle) : null;
      if (stricter !== null) {
        controller.setMaxSlopeClimbAngle(Math.acos(stricter));
        controller.computeColliderMovement(characterCollider, commanded, undefined, undefined, othersOut);
        controller.setMaxSlopeClimbAngle(b.tuning.maxSlopeClimbRad);
      }
      if (startGround === -1) controller.enableSnapToGround(snapDistance);
    }
    let swept = { x: controller.computedMovement().x, y: controller.computedMovement().y, z: controller.computedMovement().z };
    // The support normal comes from the collision results (the obstacle's outward normal), never from a floor constant.
    let best: PhysicsVec3 | null = null;
    let wall = false;
    let wallNormal: PhysicsVec3 | null = null;
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
        if (Math.hypot(u.x, u.z) > climbCos) {
          wall = true;
          wallNormal ??= u;
        }
        if (u.y < -climbCos) head = true;
        if (u.y < climbCos) groundOnly = false;
      }
    };
    readCollisions();
    // Refused when the capsule has no real ground-like contact where the sweep ended, and an internal one there or where it started.
    const groundedAt = (end: PhysicsVec3, there = controller.computedGrounded() ? groundContacts3D(edges, b.overlapCapsule, at(b, { x: before.x + end.x, y: before.y + end.y, z: before.z + end.z }), b.tuning, startGround === -1) : -1): boolean => there === 1 || (there === 0 && startGround !== -1);
    let rawGrounded = midStep ? true : groundedAt(swept);
    if (b.stepping !== null) {
      b.stepping.steps += 1;
      // On top: the ground under its centre is walkable (the step's top) — the step-up ends.
      if (walkableFloorUnder(b, { x: before.x + swept.x, y: before.y + swept.y, z: before.z + swept.z })) b.stepping = null;
    }
    // Riding a kinematic body (a mover, a collider a script drives) Rapier's sweep sometimes reads the
    // support's normal numerically tilted within its skin and takes it for a block — measured on a
    // sliding lift: no motion at all, 20 iterations, about one step in three; stepped off a mover onto
    // fixed ground it can stand inside its skin (0.28 mm), where every cast stops at once. When a grounded
    // character's horizontal move is stopped by nothing but ground-like contacts, the horizontal part is
    // swept again without the kinematic body it stands on, or lifted to its skin (walls and everything
    // else still block it); the vertical result and the grounding stay the first sweep's.
    if (!midStep && b.grounded && rawGrounded && groundOnly && Math.hypot(commanded.x, commanded.z) > 1e-9 && Math.hypot(swept.x, swept.z) < 1e-9) {
      const support = supportUnder(b, before);
      const supportHandle = support !== null && infoByHandle.get(support.handle)?.kinematic === true ? support.handle : null;
      const lift = supportHandle !== null ? 0 : skinLift(edges, b.overlapCapsule, at(b, { x: before.x, y: before.y + swept.y, z: before.z }), skin);
      if (supportHandle !== null || lift > 0) {
        characterCollider.setTranslation(at(b, { x: before.x, y: before.y + swept.y + lift, z: before.z }));
        controller.computeColliderMovement(characterCollider, { x: commanded.x, y: 0, z: commanded.z }, undefined, undefined, bothPredicates(othersOut, (c) => c.handle !== supportHandle));
        swept = { x: controller.computedMovement().x, y: swept.y + lift, z: controller.computedMovement().z };
        readCollisions();
      }
    }
    // Against a wall in the air, pushing into it (Rapier may call it grounded by the wall alone): see `offWallSweep`.
    const off = !midStep && (!rawGrounded || commanded.y > 0 || best === null || (best as PhysicsVec3).y < climbCos) && !head && wallNormal !== null ? offWallSweep(edges, controller, characterCollider, b.overlapCapsule, before, (p) => at(b, p), commanded, swept, wallNormal, skin, othersOut) : null;
    if (off !== null) {
      swept = off;
      readCollisions();
      rawGrounded = groundedAt(swept);
    }
    // Standing still on something that does not move: at rest exactly at its skin (settle3d.ts says why).
    if (!midStep && b.grounded && rawGrounded && across < 1e-12 && commanded.y <= 0 && Math.hypot(swept.x, swept.y, swept.z) < skin) {
      const under = supportUnder(b, before);
      if (under !== null && infoByHandle.get(under.handle)?.kinematic !== true) swept = { x: 0, y: -settleDrop(edges, b.overlapCapsule, at(b, before), skin, snapDistance + skin), z: 0 };
    }
    // Stepping up. Rapier's own autostep missed risers above about 0.15 m with a
    // capsule (measured with rapier3d 0.20.0: a 0.2 m riser blocked a walking capsule of radius
    // 0.3 m whatever its minimum width), so a grounded character whose move across is cut to
    // less than half probes the riser (`stepProbe`): when it can stand on top, it is lifted by
    // the rise this step (and moves across at that height), then goes on at that height until
    // its centre is over the top (`stepping`) — the rounded bottom of a capsule would otherwise
    // slide back off the riser's edge. A taller block or a wall is not climbed.
    const ridden = !midStep && stepLift > 0 && b.tuning.autostepRide === true && b.grounded && commanded.y <= 0 && across > 1e-9 ? rideStep(b, before, commanded, swept) : null;
    if (ridden !== null) {
      swept = ridden;
      best = null;
      wall = false;
      head = false;
      readCollisions();
      rawGrounded = controller.computedGrounded();
    } else if (!midStep && stepLift > 0 && b.tuning.autostepRide !== true && b.grounded && rawGrounded && commanded.y <= 0 && across > 1e-9 && Math.hypot(swept.x, swept.z) < across * 0.5) {
      const dx = commanded.x / across;
      const dz = commanded.z / across;
      const rise = stepProbe(b, before, dx, dz);
      if (rise !== null) {
        const on = sweepFrom(controller, characterCollider, at(b, { x: before.x, y: before.y + rise, z: before.z }), at(b, before), { x: commanded.x, y: 0, z: commanded.z }, othersOut, snapDistance);
        swept = { x: on.x, y: rise + on.y, z: on.z };
        best = null;
        wall = false;
        head = false;
        readCollisions();
        rawGrounded = true;
        b.stepping = walkableFloorUnder(b, { x: before.x + swept.x, y: before.y + swept.y, z: before.z + swept.z }) ? null : { x: dx, z: dz, steps: 0 };
      }
    }
    restoreMovers(stilled);
    // The plane's depth is held exactly: whatever the sweep slid it along the normal (a tilted
    // contact) is taken back, so a character on a plane ends every step on it.
    const movement = b.plane !== null ? (b.plane.axis === 'x' ? { x: b.plane.origin - before.x, y: swept.y, z: swept.z } : { x: swept.x, y: swept.y, z: b.plane.origin - before.z }) : swept;
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
    // A mover that moved into the character in the last world step may push it by up to that move (the arcade rule).
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

  /**
   * A fresh world from the statics (by id) and then the characters where
   * they are, from rest; it replaces the old one, and one pipeline update
   * lets the first sweep and any ray see every collider. The world then
   * depends on what it holds only: its query structures keep the history of
   * what was added and moved, and that history decides ties in a sweep.
   */
  const rebuild = (): void => {
    const next = newWorld(config);
    try {
      const nextBodies = new Map<string, RAPIER.RigidBody>();
      const nextInfo = new Map<number, Collider3DInfo>();
      const nextColliders = new Map<string, RAPIER.Collider[]>();
      const nextKept: [string, StaticColliderSpec3D][] = [];
      for (const id of [...staticSpecs.keys()].sort()) {
        const kept = staticSpecs.get(id)!;
        const built = collidersOf.get(id);
        const a = built === undefined ? addStaticBody(next, kept, bits) : addStaticBody(next, wholeSpec(kept, built), bits, true);
        nextBodies.set(id, a.body);
        nextColliders.set(id, a.colliders.map((c) => c.collider));
        if (built === undefined) nextKept.push([id, keptSpec(kept)]);
        for (const c of a.colliders) nextInfo.set(c.collider.handle, c.info);
      }
      const all = [primary, ...further.values()];
      const capsules = all.map((b) => makeCapsule3D(next, { position: b.position, radius: b.shape.radius, halfHeight: b.shape.halfHeight, offset: b.shape.offset }, b.tuning));
      // Nothing failed: the new world replaces the old one.
      for (const b of all) world.removeCharacterController(b.controller);
      world.free();
      world = next;
      bodies.clear();
      for (const [id, body] of nextBodies) bodies.set(id, body);
      infoByHandle.clear();
      for (const [handle, info] of nextInfo) infoByHandle.set(handle, info);
      collidersOf.clear();
      for (const [id, list] of nextColliders) collidersOf.set(id, list);
      for (const [id, kept] of nextKept) staticSpecs.set(id, kept);
      all.forEach((b, i) => {
        b.collider = capsules[i]!.collider;
        b.controller = capsules[i]!.controller;
        b.staged = null;
        b.grounded = false;
        b.retainedSupport = { x: 0, y: 1, z: 0 };
        b.stepping = null;
        b.dropSteps = 0;
        b.last = undefined;
      });
      listCharacters();
      relistOneWay();
      if (noCharacter) primary.collider.setEnabled(false);
    } catch (e) {
      if (world !== next) next.free();
      throw e;
    }
    deferred = false;
    world.step();
  };
  /** The statics in the world before anything reads it (a deferred world's first use). */
  const ensureBuilt = (): void => {
    if (deferred) rebuild();
  };

  return {
    implementation: PHYSICS_3D_IMPLEMENTATION,

    stageCharacterMove(delta: PhysicsVec3, characterId?: string): void {
      assertLive('stageCharacterMove');
      bodyOf(characterId, 'stageCharacterMove').staged = { x: delta.x, y: delta.y, z: delta.z };
    },

    step(): CharacterMoveResult3D {
      assertLive('step');
      ensureBuilt();
      if (chars.length === 0) return stepWithoutCharacter();
      // Every character's sweep (the first, then the further ones); the movers move after them
      // (the runtime already added a carrying platform's motion to each request).
      // A one-way collider that does not hold a character is out of its sweep (a drop through counts down first).
      const swept = chars.map((b) => {
        if (b.suspended) return heldStill(b);
        if (b.dropSteps > 0) b.dropSteps -= 1;
        const staged = b.staged;
        return withOneWay(b, staged !== null && isVec3(staged) ? (b.plane !== null ? inPlane(staged, b.plane) : staged) : null, () => sweep(b));
      });
      poseMoversAndStep();
      for (let i = 0; i < chars.length; i += 1) {
        const b = chars[i]!;
        const s = swept[i];
        if (s === null || s === undefined) continue;
        b.position = s.next;
        b.grounded = s.grounded;
        b.last = { ...s.result, groundEntityId: s.grounded ? withOneWay(b, null, () => groundUnder(b, s.next)) : null };
      }
      if (noCharacter) {
        primary.staged = null;
        return restingAt(primary.position);
      }
      return primary.last ?? restingAt(primary.position);
    },

    ...suspension3D(bodyOf, assertLive),

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
      ensureBuilt();
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
      ensureBuilt();
      if (!isVec3(center) || (rotation !== undefined && !isQuat(rotation))) return [];
      const s = overlapShapeOf(shape);
      if (s === null) return [];
      const ids = new Set<string>();
      world.intersectionsWithShape({ x: center.x, y: center.y, z: center.z }, rotation ?? IDENTITY_Q, s, (c) => {
        const id = infoByHandle.get(c.handle)?.entityId;
        if (id !== undefined) ids.add(id);
        return ids.size < 64;
      }, undefined, groupsOf(filter), primary.collider, undefined, predicateOf(filter));
      return [...ids].sort();
    },

    characterClearance(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D {
      assertLive('characterClearance');
      ensureBuilt();
      if (!isVec3(origin)) throw new Error('characterClearance origin must be a finite { x, y, z }');
      const b = bodyOf(characterId, 'characterClearance');
      return clearanceAt(world, characterHandles, infoByHandle, b.shape, at(b, origin));
    },

    placeCharacter(origin: PhysicsVec3, characterId?: string): CharacterClearanceResult3D {
      assertLive('placeCharacter');
      ensureBuilt();
      if (!isVec3(origin)) throw new Error('placeCharacter origin must be a finite { x, y, z }');
      const b = bodyOf(characterId, 'placeCharacter');
      // A character on a plane is placed on it.
      b.position = b.plane !== null ? onPlane(origin, b.plane) : { x: origin.x, y: origin.y, z: origin.z };
      b.collider.setTranslation(at(b, b.position));
      b.staged = null;
      b.grounded = false;
      b.retainedSupport = { x: 0, y: 1, z: 0 };
      b.stepping = null;
      // From rest, as the body was made: no drop through left.
      b.dropSteps = 0;
      b.last = undefined;
      world.step();
      return clearanceAt(world, characterHandles, infoByHandle, b.shape, at(b, b.position));
    },

    addStaticColliders(specs: readonly StaticColliderSpec3D[]): void {
      assertLive('addStaticColliders');
      // A refused batch adds nothing: every spec is checked first (a hull that spans no volume too).
      specs.forEach((spec, i) => {
        const problem = validateSpec(spec, `statics(${String(spec?.entityId ?? i)})`);
        if (problem !== null) throw new Error(problem.message);
        if (staticSpecs.has(spec.entityId)) throw new Error(`static collider "${spec.entityId}" already exists`);
      });
      // Not built yet: kept as they are, for the first build.
      if (deferred) {
        for (const spec of specs) staticSpecs.set(spec.entityId, spec);
        return;
      }
      const added: { id: string; body: RAPIER.RigidBody }[] = [];
      try {
        for (const spec of specs) {
          const a = addStaticBody(world, spec, bits);
          bodies.set(spec.entityId, a.body);
          staticSpecs.set(spec.entityId, keptSpec(spec));
          collidersOf.set(spec.entityId, a.colliders.map((c) => c.collider));
          for (const c of a.colliders) infoByHandle.set(c.collider.handle, c.info);
          added.push({ id: spec.entityId, body: a.body });
        }
      } catch (e) {
        for (const a of added) {
          for (const [handle, info] of [...infoByHandle]) if (info.body === a.body) infoByHandle.delete(handle);
          world.removeRigidBody(a.body);
          bodies.delete(a.id);
          staticSpecs.delete(a.id);
          collidersOf.delete(a.id);
        }
        relistOneWay();
        throw e;
      }
      relistOneWay();
      // The scene queries (sweeps, rays) see a collider after a pipeline update (no dynamic bodies: nothing else moves).
      world.step();
    },

    removeStaticColliders(entityIds: readonly string[]): void {
      assertLive('removeStaticColliders');
      if (deferred) {
        for (const id of entityIds) staticSpecs.delete(id);
        return;
      }
      // One pass over the collider records for the whole batch.
      const gone = new Set<unknown>();
      for (const id of entityIds) {
        const body = bodies.get(id);
        if (body === undefined) continue;
        gone.add(body);
        world.removeRigidBody(body);
        bodies.delete(id);
        staticSpecs.delete(id);
        collidersOf.delete(id);
        kinematicAt.delete(id);
      }
      if (gone.size > 0) for (const [handle, info] of [...infoByHandle]) if (gone.has(info.body)) infoByHandle.delete(handle);
      relistOneWay();
      world.step();
    },

    dropThrough(steps: number, characterId?: string): void {
      assertLive('dropThrough');
      bodyOf(characterId, 'dropThrough').dropSteps = Math.max(0, Math.min(MAX_DROP_THROUGH_STEPS, Math.floor(steps)));
    },

    restartWorld(origins?: readonly { characterId?: string; position: PhysicsVec3 }[]): void {
      assertLive('restartWorld');
      for (const o of origins ?? []) if (!isVec3(o?.position)) throw new Error('restartWorld origins must be finite { x, y, z } positions');
      // The characters where the run starts them (the rebuilt world makes their capsules there, from rest).
      for (const o of origins ?? []) {
        const b = bodyOf(o.characterId, 'restartWorld');
        b.position = b.plane !== null ? onPlane(o.position, b.plane) : { x: o.position.x, y: o.position.y, z: o.position.z };
      }
      rebuild();
      // The movers as made (no last pose to measure a move from).
      kinematicPoses = [];
      kinematicAt.clear();
      kinematicMoved = 0;
      stilled.length = 0;
    },

    ...furtherCharacters3D(() => world, further, config.controller, assertLive, listCharacters),

    ...planeLocks3D({ world: () => world, staticSpecs, bodies, kinematicAt, deferred: () => deferred, bodyOf, at, assertLive }),

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

/** An empty world with the config's gravity and step. */
function newWorld(config: PhysicsInitConfig3D): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: config.solver.gravityY, z: 0 });
  world.timestep = 1 / config.solver.hz;
  return world;
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
    world = newWorld(config);
    const bodies = new Map<string, RAPIER.RigidBody>();
    const staticSpecs = new Map<string, StaticColliderSpec3D>();
    const collidersOf = new Map<string, RAPIER.Collider[]>();
    const infoByHandle = new Map<number, Collider3DInfo>();
    const bits = layerBitsOf(config.layers);
    for (const spec of config.statics) {
      // A world made for a run builds its statics at the run's start (see `createAdapter`).
      if (config.buildAtRunStart === true) {
        staticSpecs.set(spec.entityId, spec);
        continue;
      }
      const added = addStaticBody(world, spec, bits);
      bodies.set(spec.entityId, added.body);
      staticSpecs.set(spec.entityId, keptSpec(spec));
      collidersOf.set(spec.entityId, added.colliders.map((c) => c.collider));
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
    // The adapter keeps the config without its statics: the specs it keeps are its own (arrays the world holds dropped).
    return { ok: true, port: createAdapter(world, primary, further, { ...config, statics: [] }, staticSpecs, bodies, infoByHandle, bits, collidersOf) };
  } catch (error) {
    world?.free();
    return { ok: false, error: { code: 'physics_init_failed', reason: 'wasm_unavailable', message: `Rapier 3D world construction failed: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
