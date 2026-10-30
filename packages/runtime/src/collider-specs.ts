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
import { quatMultiply } from '@thirdlight/shared';
import { colliderDepthOf, planeLockOf, shape2DTo3D, type ModelColliderTable } from '@thirdlight/project-model';

import type { ColliderPrimitive3D, ColliderShape3D, PhysicsPlane, PhysicsQuat, PhysicsVec3, StaticColliderSpec3D } from './ports';
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
  /** A plane a script set on an object, which replaces its collider's own (null: freed; undefined: the collider's own). */
  readonly planeOf?: (id: string) => PhysicsPlane | null | undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const IDENTITY: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const ORIGIN: PhysicsVec3 = { x: 0, y: 0, z: 0 };

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
 * `halfHeight`, a cylinder's full height half of it; point lists are
 * flattened. Null for a 2D shape (`shape2DTo3D` makes its 3D form first).
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
    case 'cylinder':
      return { type: 'cylinder', radius: num(s['radius']) * sx, halfHeight: (num(s['height']) / 2) * sx };
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
  if (isIdentity(q) || uniform || s['type'] === 'sphere' || s['type'] === 'capsule' || s['type'] === 'cylinder') {
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

/** An object's own transform as its world transform (a root object). */
function ownTransform(components: Readonly<Obj>): WorldTransform {
  const t = components['transform'] as { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] } | undefined;
  const p = t?.position ?? [0, 0, 0];
  const q = t?.rotation ?? [0, 0, 0, 1];
  const s = t?.scale ?? [1, 1, 1];
  return { position: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], rotation: [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1], scale: [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1] };
}

/**
 * A collider's shape with each 2D shape made solid along its plane's normal
 * (the collider's own authored plane, else Z: a plane a script sets later
 * moves the body, never reshapes it), its depth the collider's.
 */
export function solidShapeOf(collider: unknown): unknown {
  return shape2DTo3D(isObj(collider) ? collider['shape'] : undefined, { depth: colliderDepthOf(collider), plane: planeLockOf(collider)?.axis ?? null });
}

/**
 * The 3D static collider spec of one entity's `collider` (null without one,
 * or when its shape resolves to nothing): at `world` (default: its own
 * transform, a root object) with its full rotation, the shape resolved for
 * the world scale (`colliderShape3DOf`); a mover's collider is kinematic, as
 * is one a script or a timeline drives (`kinematic`).
 */
export function staticColliderOf3D(entityId: string, components: Readonly<Obj>, kinematic = false, world?: WorldTransform, ctx?: ColliderContext): StaticColliderSpec3D | null {
  const collider = components['collider'] as { shape?: unknown; layers?: unknown; oneWay?: boolean } | undefined;
  if (collider === undefined) return null;
  const w = world ?? ownTransform(components);
  const plane = planeSpec(ctx?.planeOf?.(entityId), collider);
  const solid = solidShapeOf(collider);
  if (solid === null) return null;
  const resolved = colliderShape3DOf(solid, w.scale, components, ctx);
  if (resolved === null && isObj(collider.shape) && collider.shape['type'] === 'model') return null;
  const [qx, qy, qz, qw] = w.rotation;
  return {
    entityId,
    shape: resolved ?? solid,
    position: { x: w.position[0], y: w.position[1], z: w.position[2] },
    rotation: { x: qx, y: qy, z: qz, w: qw },
    ...(kinematic || components['mover'] !== undefined ? { kinematic: true } : {}),
    // The collision layers it is in (absent: "default").
    ...(Array.isArray(collider.layers) ? { layers: [...(collider.layers as string[])] } : {}),
    ...(collider.oneWay === true ? { oneWay: true } : {}),
    ...plane,
  };
}

/** The plane of a spec: a script's (null: freed) over the collider's own; absent when free. */
function planeSpec(set: PhysicsPlane | null | undefined, collider: unknown): { plane?: PhysicsPlane } {
  const plane = set !== undefined ? set : planeLockOf(collider);
  return plane !== null ? { plane } : {};
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
      const a = shapeAabb3(part.shape, quatMultiply(q, [part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w]));
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
    case 'cylinder': {
      // The end discs' extent along each world axis: the axis's reach plus the radius across it.
      const e = rotate3(q, [0, shape.halfHeight, 0]);
      const len = Math.hypot(e[0], e[1], e[2]) || 1;
      const across = (i: number): number => shape.radius * Math.sqrt(Math.max(0, 1 - (e[i]! / len) ** 2));
      const h = [Math.abs(e[0]) + across(0), Math.abs(e[1]) + across(1), Math.abs(e[2]) + across(2)] as const;
      return { min: [-h[0], -h[1], -h[2]], max: [h[0], h[1], h[2]] };
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
