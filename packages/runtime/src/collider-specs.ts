/**
 * What the physics ports build for an object's `collider`: its shape
 * resolved (each shape at its `center` and `rotation` in the object's frame,
 * a compound's shapes on one body, `{type: 'model'}` from the build's table
 * of the model's `_COL` parts, the object's scale applied) and placed where
 * the object is in the world — a collider on a child follows its parents'
 * transforms, as the renderer composes them.
 *
 * The one place the runtime, the Play preview, the export and the tests
 * derive collider specs. Pure: no I/O, no three.js.
 */
import { collisionPartPolygons, type ModelColliderTable } from '@thirdlight/project-model';

import type { ColliderPrimitive3D, ColliderShape3D, PhysicsQuat, PhysicsVec3, StaticColliderSpec, StaticColliderSpec3D } from './ports';
import type { TransformState } from './types-simulation';
import { rotate3 } from './geometry3';
import { worldTransformOf, type WorldTransform } from './world-transform';

/** What resolving a collider may need besides the object itself. */
export interface ColliderContext {
  /** The model `_COL` parts by asset and piece (a build's table; absent: a `model` shape has none). */
  readonly modelColliders?: ModelColliderTable;
  /** Objects outside the list being resolved (a child's parent already in the game): their transform and parent. */
  readonly outside?: {
    transform(id: string): TransformState | undefined;
    parentOf(id: string): string | null | undefined;
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const IDENTITY: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const ORIGIN: PhysicsVec3 = { x: 0, y: 0, z: 0 };

/**
 * The angle about Z (radians) of a transform's `[x, y, z, w]`
 * quaternion — the one rotation a 2D-plane collider takes (the project model
 * keeps a physics entity's rotation about Z only). Exactly 0 for the
 * identity (either sign of `w`), so an unrotated collider gets rotationZ 0.
 */
export function colliderRotationZ(rotation: readonly number[] | undefined): number {
  if (rotation === undefined) return 0;
  const z = rotation[2] ?? 0;
  const w = rotation[3] ?? 1;
  return z === 0 ? 0 : 2 * Math.atan2(z, w);
}

/** The table key of a model component (its asset, and its piece or '' for the whole file). */
export function modelColliderKey(model: unknown): { assetId: string; piece: string } | null {
  if (!isObj(model) || !isObj(model['asset']) || typeof model['asset']['assetId'] !== 'string') return null;
  return { assetId: model['asset']['assetId'], piece: typeof model['piece'] === 'string' ? model['piece'] : '' };
}

/** The `_COL` parts a `model` shape stands for (empty: the table has none for this model). */
function modelParts(components: Readonly<Obj>, ctx: ColliderContext | undefined): readonly (readonly (readonly number[])[])[] {
  const key = modelColliderKey(components['model']);
  if (key === null) return [];
  return ctx?.modelColliders?.[key.assetId]?.[key.piece] ?? [];
}

/** A shape's own pose (center, rotation), or null when it has none. */
function poseOf(s: Obj): { center: readonly number[]; rotation: readonly number[] } | null {
  const c = Array.isArray(s['center']) ? (s['center'] as number[]) : null;
  const q = Array.isArray(s['rotation']) ? (s['rotation'] as number[]) : null;
  if (c === null && q === null) return null;
  return { center: c ?? [0, 0, 0], rotation: q ?? [0, 0, 0, 1] };
}

const isIdentity = (q: readonly number[]): boolean => (q[0] ?? 0) === 0 && (q[1] ?? 0) === 0 && (q[2] ?? 0) === 0;

/**
 * The shape a 3D port builds from one authored primitive and a scale along
 * its own axes (the project model allows a positive scale per axis for a
 * box, hull or mesh and a uniform one for a sphere or capsule): a box's
 * half extents and a hull's or mesh's points scale; a capsule's authored
 * total `height` (end caps included) becomes the port's centre-segment
 * `halfHeight`; point lists are flattened. Null for a shape a 3D port does
 * not take (a polygon — the model refuses it in 3D).
 */
function primitive3D(s: Obj, scale: readonly number[]): ColliderPrimitive3D | null {
  const sx = scale[0] ?? 1;
  const sy = scale[1] ?? 1;
  const sz = scale[2] ?? 1;
  const flat = (list: unknown): number[] => {
    const out: number[] = [];
    if (Array.isArray(list)) for (const q of list as unknown[][]) out.push(num(q[0]) * sx, num(q[1]) * sy, num(q[2]) * sz);
    return out;
  };
  switch (s['type']) {
    case 'box':
      return { type: 'box', hx: num(s['hx']) * sx, hy: num(s['hy']) * sy, hz: num(s['hz']) * sz };
    case 'sphere':
      return { type: 'sphere', radius: num(s['radius']) * sx };
    case 'capsule': {
      const r = num(s['radius']);
      return { type: 'capsule', radius: r * sx, halfHeight: Math.max(0, num(s['height']) / 2 - r) * sx };
    }
    case 'convex':
      return { type: 'convex', points: flat(s['points']) };
    case 'mesh': {
      const indices: number[] = [];
      if (Array.isArray(s['triangles'])) for (const t of s['triangles'] as unknown[][]) indices.push(num(t[0]), num(t[1]), num(t[2]));
      return { type: 'mesh', vertices: flat(s['vertices']), indices };
    }
    default:
      return null;
  }
}

/** A primitive's points (a box's corners, a hull's points, a mesh's vertices), each moved by `f`. */
function bakedPrimitive(s: Obj, f: (p: readonly number[]) => [number, number, number]): ColliderPrimitive3D | null {
  const flat = (pts: readonly (readonly number[])[]): number[] => pts.flatMap((p) => f(p));
  switch (s['type']) {
    case 'box': {
      const hx = num(s['hx']), hy = num(s['hy']), hz = num(s['hz']);
      const corners: number[][] = [];
      for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) corners.push([x, y, z]);
      return { type: 'convex', points: flat(corners) };
    }
    case 'convex':
      return { type: 'convex', points: flat((s['points'] as number[][]) ?? []) };
    case 'mesh': {
      const indices: number[] = [];
      if (Array.isArray(s['triangles'])) for (const t of s['triangles'] as unknown[][]) indices.push(num(t[0]), num(t[1]), num(t[2]));
      return { type: 'mesh', vertices: flat((s['vertices'] as number[][]) ?? []), indices };
    }
    default:
      return null;
  }
}

/**
 * One placed primitive on its body: its center scaled with the object, its
 * rotation kept. A turned shape under an uneven scale is no longer its own
 * kind of shape (a box shears), so its points are moved into the body's
 * frame instead (a box becomes the hull of its 8 corners).
 */
function placedPart3D(s: Obj, scale: readonly number[]): { shape: ColliderPrimitive3D; position: PhysicsVec3; rotation: PhysicsQuat } | null {
  const sx = scale[0] ?? 1, sy = scale[1] ?? 1, sz = scale[2] ?? 1;
  const pose = poseOf(s) ?? { center: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const c = pose.center;
  const q = pose.rotation;
  const position = { x: (c[0] ?? 0) * sx, y: (c[1] ?? 0) * sy, z: (c[2] ?? 0) * sz };
  const uniform = sx === sy && sy === sz;
  if (isIdentity(q) || uniform || s['type'] === 'sphere' || s['type'] === 'capsule') {
    const shape = primitive3D(s, scale);
    return shape === null ? null : { shape, position, rotation: { x: q[0] ?? 0, y: q[1] ?? 0, z: q[2] ?? 0, w: q[3] ?? 1 } };
  }
  const shape = bakedPrimitive(s, (p) => {
    const r = rotate3(q, [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
    return [(r[0] + (c[0] ?? 0)) * sx, (r[1] + (c[1] ?? 0)) * sy, (r[2] + (c[2] ?? 0)) * sz];
  });
  return shape === null ? null : { shape, position: ORIGIN, rotation: IDENTITY };
}

/**
 * The shape a 3D port builds for a collider shape on an object of this
 * scale: a primitive without a pose as it was; a placed primitive or a
 * compound as a compound of placed parts; `model` as a compound of the
 * build's `_COL` hulls (null when the table has none, or no part could be
 * made). `components` is the object's (a `model` shape reads its model).
 */
export function colliderShape3DOf(shape: unknown, scale: readonly number[] = [1, 1, 1], components: Readonly<Obj> = {}, ctx?: ColliderContext): ColliderShape3D | null {
  if (!isObj(shape)) return null;
  if (shape['type'] === 'model') {
    const parts = modelParts(components, ctx).map((points) => placedPart3D({ type: 'convex', points }, scale)).filter((p): p is NonNullable<typeof p> => p !== null);
    return parts.length === 0 ? null : { type: 'compound', parts };
  }
  const list = shape['type'] === 'compound' ? (Array.isArray(shape['shapes']) ? (shape['shapes'] as unknown[]).filter(isObj) : []) : [shape];
  if (shape['type'] !== 'compound' && poseOf(shape) === null) return primitive3D(shape, scale);
  const parts = list.map((p) => placedPart3D(p, scale)).filter((p): p is NonNullable<typeof p> => p !== null);
  return parts.length === 0 ? null : { type: 'compound', parts };
}

/** A 2D-plane primitive (a box's depth is not part of it). */
function primitive2D(s: Obj): Obj | null {
  if (s['type'] === 'box') return { type: 'box', hx: s['hx'], hy: s['hy'] };
  if (s['type'] === 'polygon') return { type: 'polygon', vertices: s['vertices'] };
  return null;
}

/**
 * The shape the 2D port builds: a primitive without a pose as it was; a
 * placed primitive or a compound as a compound of parts at their center's
 * x, y and their turn about Z; `model` as a compound of the `_COL` parts'
 * polygons on the plane. Null when nothing is left to build.
 */
export function colliderShape2DOf(shape: unknown, components: Readonly<Obj> = {}, ctx?: ColliderContext): unknown {
  if (!isObj(shape)) return null;
  if (shape['type'] === 'model') {
    const polys = collisionPartPolygons(modelParts(components, ctx).map((points) => ({ points: points.map((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0] as [number, number, number]) })));
    return polys.length === 0 ? null : { type: 'compound', parts: polys.map((vertices) => ({ shape: { type: 'polygon', vertices }, x: 0, y: 0, angle: 0 })) };
  }
  if (shape['type'] !== 'compound' && poseOf(shape) === null) return primitive2D(shape) ?? shape;
  const list = shape['type'] === 'compound' ? (Array.isArray(shape['shapes']) ? (shape['shapes'] as unknown[]).filter(isObj) : []) : [shape];
  const parts: Obj[] = [];
  for (const p of list) {
    const prim = primitive2D(p);
    if (prim === null) continue;
    const pose = poseOf(p) ?? { center: [0, 0, 0], rotation: [0, 0, 0, 1] };
    parts.push({ shape: prim, x: pose.center[0] ?? 0, y: pose.center[1] ?? 0, angle: colliderRotationZ(pose.rotation) });
  }
  return parts.length === 0 ? null : { type: 'compound', parts };
}

/** An object's own transform as its world transform (a root object). */
function ownTransform(components: Readonly<Obj>): WorldTransform {
  const t = components['transform'] as { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] } | undefined;
  const p = t?.position ?? [0, 0, 0];
  const q = t?.rotation ?? [0, 0, 0, 1];
  const s = t?.scale ?? [1, 1, 1];
  return { position: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], rotation: [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1], scale: [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1] };
}

/**
 * The static collider spec of one entity's `collider` on the 2D plane
 * (null without one, or when its shape resolves to nothing) — at `world`
 * (default: its own transform, a root object), turned about Z with it (the
 * editor draws the collider rotated with the entity, so physics must too),
 * kinematic for a mover, one-way when set.
 */
export function staticColliderOf(entityId: string, components: Readonly<Obj>, world?: WorldTransform, ctx?: ColliderContext): StaticColliderSpec | null {
  const collider = components['collider'] as { shape?: unknown; oneWay?: boolean } | undefined;
  if (collider === undefined) return null;
  const shape = colliderShape2DOf(collider.shape, components, ctx);
  if (shape === null) return null;
  const w = world ?? ownTransform(components);
  return {
    entityId,
    shape,
    position: { x: w.position[0], y: w.position[1] },
    rotationZ: colliderRotationZ(w.rotation),
    ...(components['mover'] !== undefined ? { kinematic: true } : {}),
    ...(collider.oneWay === true ? { oneWay: true } : {}),
  };
}

/**
 * The 3D static collider spec of one entity's `collider` (null without one,
 * or when its shape resolves to nothing): at `world` (default: its own
 * transform, a root object) with its full rotation, the shape resolved for
 * the world scale (`colliderShape3DOf`); a mover's collider is kinematic, as
 * is one a script or a timeline drives (`kinematic`).
 */
export function staticColliderOf3D(entityId: string, components: Readonly<Obj>, kinematic = false, world?: WorldTransform, ctx?: ColliderContext): StaticColliderSpec3D | null {
  const collider = components['collider'] as { shape?: unknown; layers?: unknown } | undefined;
  if (collider === undefined) return null;
  const w = world ?? ownTransform(components);
  const resolved = colliderShape3DOf(collider.shape, w.scale, components, ctx);
  if (resolved === null && isObj(collider.shape) && collider.shape['type'] === 'model') return null;
  const [qx, qy, qz, qw] = w.rotation;
  return {
    entityId,
    shape: resolved ?? collider.shape,
    position: { x: w.position[0], y: w.position[1], z: w.position[2] },
    rotation: { x: qx, y: qy, z: qz, w: qw },
    ...(kinematic || components['mover'] !== undefined ? { kinematic: true } : {}),
    // The collision layers it is in (absent: "default").
    ...(Array.isArray(collider.layers) ? { layers: [...(collider.layers as string[])] } : {}),
  };
}

/**
 * The world transform of each listed entity, its parents composed — within
 * the list first (a scene or a spawned copy brings its own parents), then
 * `ctx.outside` (a parent already in the game).
 */
export function worldTransformsOf(entities: readonly { id: string; parentId?: string | null; components?: unknown }[], ctx?: ColliderContext): (id: string) => WorldTransform | undefined {
  const local = new Map<string, TransformState>();
  const parents = new Map<string, string | null>();
  for (const e of entities) {
    const t = ownTransform((e.components ?? {}) as Obj);
    local.set(e.id, { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] } as TransformState);
    parents.set(e.id, e.parentId ?? null);
  }
  const lookup = { get: (id: string): TransformState | undefined => local.get(id) ?? ctx?.outside?.transform(id) } as ReadonlyMap<string, TransformState>;
  const parentOf = (id: string): string | null | undefined => (parents.has(id) ? parents.get(id) : ctx?.outside?.parentOf(id));
  return (id) => worldTransformOf(id, lookup, parentOf);
}

/** The 2D static colliders of a list of (resolved) entities, the player's excluded, each where it is in the world. */
export function colliderSpecs2D(entities: readonly { id: string; parentId?: string | null; components?: unknown }[], ctx?: ColliderContext): StaticColliderSpec[] {
  const worldOf = worldTransformsOf(entities, ctx);
  const out: StaticColliderSpec[] = [];
  for (const e of entities) {
    const c = (e.components ?? {}) as Obj;
    if (c['collider'] === undefined || c['controller'] !== undefined) continue;
    const spec = staticColliderOf(e.id, c, worldOf(e.id), ctx);
    if (spec !== null) out.push(spec);
  }
  return out;
}

/** The 3D static colliders of a list of (resolved) entities, the player's excluded, each where it is in the world (`kinematic`: the ones a script or timeline drives). */
export function colliderSpecs3D(entities: readonly { id: string; parentId?: string | null; components?: unknown }[], ctx?: ColliderContext, kinematic?: (id: string) => boolean): StaticColliderSpec3D[] {
  const worldOf = worldTransformsOf(entities, ctx);
  const out: StaticColliderSpec3D[] = [];
  for (const e of entities) {
    const c = (e.components ?? {}) as Obj;
    if (c['collider'] === undefined || c['controller'] !== undefined) continue;
    const spec = staticColliderOf3D(e.id, c, kinematic?.(e.id) === true, worldOf(e.id), ctx);
    if (spec !== null) out.push(spec);
  }
  return out;
}

/** `a · b` of [x, y, z, w] quaternions. */
function mulQuat(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1];
  const [bx, by, bz, bw] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 1];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/**
 * The axis-aligned box around a 3D shape turned by `q`, relative to its
 * body's origin (a compound's parts at their places and turns) — what a
 * moving collider pushes the player out of.
 */
export function shapeAabb3(shape: ColliderShape3D, q: readonly number[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const take = (lo: readonly number[], hi: readonly number[], off: readonly number[] = [0, 0, 0]): void => {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, lo[i]! + off[i]!);
      max[i] = Math.max(max[i]!, hi[i]! + off[i]!);
    }
  };
  if (shape.type === 'compound') {
    for (const part of shape.parts) {
      const a = shapeAabb3(part.shape, mulQuat(q, [part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w]));
      take(a.min, a.max, rotate3(q, [part.position.x, part.position.y, part.position.z]));
    }
    return min[0] === Infinity ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
  }
  const pts: [number, number, number][] = [];
  switch (shape.type) {
    case 'box':
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push([sx * shape.hx, sy * shape.hy, sz * shape.hz]);
      break;
    case 'sphere':
      return { min: [-shape.radius, -shape.radius, -shape.radius], max: [shape.radius, shape.radius, shape.radius] };
    case 'capsule': {
      const e = rotate3(q, [0, shape.halfHeight, 0]);
      const r = shape.radius;
      return { min: [-Math.abs(e[0]) - r, -Math.abs(e[1]) - r, -Math.abs(e[2]) - r], max: [Math.abs(e[0]) + r, Math.abs(e[1]) + r, Math.abs(e[2]) + r] };
    }
    case 'convex':
    case 'mesh': {
      const list = shape.type === 'convex' ? shape.points : shape.vertices;
      for (let i = 0; i + 2 < list.length; i += 3) pts.push([list[i]!, list[i + 1]!, list[i + 2]!]);
      break;
    }
    case 'heightfield': {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < shape.heights.length; i++) {
        lo = Math.min(lo, shape.heights[i]!);
        hi = Math.max(hi, shape.heights[i]!);
      }
      const sx = shape.cellsX * shape.cellX;
      const sz = shape.cellsZ * shape.cellZ;
      for (const x of [0, sx]) for (const y of [lo, hi]) for (const z of [0, sz]) pts.push([x, y, z]);
      break;
    }
  }
  for (const p of pts) {
    const r = rotate3(q, p);
    take(r, r);
  }
  return { min, max };
}
