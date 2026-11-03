/**
 * The shape a prop marked `affectsLighting` stamps into a voxel world's
 * lighting occupancy: its collider when it has one (each primitive exactly
 * at its place and turn; a hull or a mesh as the box around its points in
 * its own frame), else the model's recorded bounds as a box turned with the
 * object. Full rotation and the world scale are taken here, inside the
 * shape's own inside test, so the 4³-samples-a-cell voxelizer
 * (`propCoverageChunk`) is used as it is.
 *
 * Pure: no I/O, no three.js.
 */
import type { PropShape } from '@thirdlight/voxel';
import { staticColliderOf3D, type ColliderContext } from './collider-specs';
import type { ColliderPrimitive3D, ColliderShape3D } from './ports';
import type { ModelBounds } from './types-scene';
import type { WorldTransform } from './world-transform';

/** Where a prop's light shape came from (null: neither a collider nor recorded bounds). */
export type PropLightSource = 'collider' | 'bounds';

/** One solid of a prop: a test in its own frame, its box there, and the turn and place that lead there from the prop's. */
interface Solid {
  /** Prop frame (metres from the prop's position, world axes) → solid frame: rows of the inverse turn. */
  readonly m: readonly number[];
  /** The solid's origin in the prop frame. */
  readonly o: readonly [number, number, number];
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
  readonly test: (x: number, y: number, z: number) => boolean;
}

/** The rotation matrix of a quaternion, row-major. */
function quatBasis(x: number, y: number, z: number, w: number): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

const mul3 = (a: readonly number[], b: readonly number[]): number[] => {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return o;
};
const apply3 = (m: readonly number[], v: readonly number[]): [number, number, number] => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
  m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
  m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
];
const transpose3 = (m: readonly number[]): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];

/** The box around a list of points (x y z flat). */
function pointBox(points: readonly number[]): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, points[i + a]!);
      hi[a] = Math.max(hi[a]!, points[i + a]!);
    }
  }
  return { lo, hi };
}

/** A primitive's inside test and box in its own frame (null: a shape that holds nothing). */
function primitiveSolid(s: ColliderPrimitive3D): Pick<Solid, 'lo' | 'hi' | 'test'> | null {
  switch (s.type) {
    case 'box':
      return { lo: [-s.hx, -s.hy, -s.hz], hi: [s.hx, s.hy, s.hz], test: (x, y, z) => Math.abs(x) <= s.hx && Math.abs(y) <= s.hy && Math.abs(z) <= s.hz };
    case 'sphere': {
      const r2 = s.radius * s.radius;
      return { lo: [-s.radius, -s.radius, -s.radius], hi: [s.radius, s.radius, s.radius], test: (x, y, z) => x * x + y * y + z * z <= r2 };
    }
    case 'capsule': {
      const r2 = s.radius * s.radius;
      const h = s.halfHeight;
      return {
        lo: [-s.radius, -h - s.radius, -s.radius],
        hi: [s.radius, h + s.radius, s.radius],
        test: (x, y, z) => {
          const dy = y - Math.max(-h, Math.min(h, y));
          return x * x + dy * dy + z * z <= r2;
        },
      };
    }
    case 'cylinder': {
      const r2 = s.radius * s.radius;
      return { lo: [-s.radius, -s.halfHeight, -s.radius], hi: [s.radius, s.halfHeight, s.radius], test: (x, y, z) => Math.abs(y) <= s.halfHeight && x * x + z * z <= r2 };
    }
    case 'convex':
    case 'mesh': {
      // Hull faces and mesh insides are not known here: the box around the points stands for them.
      const pts = s.type === 'convex' ? s.points : s.vertices;
      if (pts.length < 3) return null;
      const { lo, hi } = pointBox(pts);
      return { lo, hi, test: (x, y, z) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2] };
    }
    default:
      return null;
  }
}

/** A prop's light shape from its solids, placed at `position` (world metres). */
function shapeOf(position: readonly number[], solids: readonly Solid[]): PropShape | null {
  if (solids.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    const back = transpose3(s.m);
    for (let k = 0; k < 8; k++) {
      const c = [k & 1 ? s.hi[0] : s.lo[0], k & 2 ? s.hi[1] : s.lo[1], k & 4 ? s.hi[2] : s.lo[2]];
      const p = apply3(back, c);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, p[a]! + s.o[a]!);
        max[a] = Math.max(max[a]!, p[a]! + s.o[a]!);
      }
    }
  }
  return Object.freeze({
    min,
    max,
    position: [position[0]!, position[1]!, position[2]!] as const,
    yaw: [1, 0] as const,
    scale: 1,
    inside(x: number, y: number, z: number): boolean {
      for (const s of solids) {
        const dx = x - s.o[0];
        const dy = y - s.o[1];
        const dz = z - s.o[2];
        const m = s.m;
        if (s.test(m[0]! * dx + m[1]! * dy + m[2]! * dz, m[3]! * dx + m[4]! * dy + m[5]! * dz, m[6]! * dx + m[7]! * dy + m[8]! * dz)) return true;
      }
      return false;
    },
  });
}

/**
 * The light shape of an object at its world transform: from its `collider`
 * (resolved as the physics port builds it, the world scale applied), else
 * from its model's recorded bounds; null with neither.
 */
export function propLightShape(
  entityId: string,
  components: Readonly<Record<string, unknown>>,
  world: WorldTransform,
  ctx: ColliderContext | undefined,
  modelBounds: Readonly<Record<string, ModelBounds>> | undefined,
): { shape: PropShape; source: PropLightSource } | null {
  const body = quatBasis(world.rotation[0], world.rotation[1], world.rotation[2], world.rotation[3]);
  const spec = components['collider'] !== undefined ? staticColliderOf3D(entityId, components, false, world, ctx) : null;
  if (spec !== null) {
    // A shape the resolver could not make its port form of stays raw; primitiveSolid holds nothing for it.
    const resolved = spec.shape as ColliderShape3D;
    const parts = resolved.type === 'compound' ? resolved.parts : [{ shape: resolved, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }];
    const solids: Solid[] = [];
    for (const part of parts) {
      const own = primitiveSolid(part.shape);
      if (own === null) continue;
      const turn = mul3(body, quatBasis(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w));
      solids.push({ ...own, m: transpose3(turn), o: apply3(body, [part.position.x, part.position.y, part.position.z]) });
    }
    const shape = shapeOf(world.position, solids);
    if (shape !== null) return { shape, source: 'collider' };
  }
  const model = components['model'] as { asset?: { assetId?: unknown }; piece?: unknown } | undefined;
  const assetId = model?.asset?.assetId;
  // A piece of a model file has no bounds of its own recorded; the file's would stamp the whole kit.
  if (typeof assetId !== 'string' || model?.piece !== undefined) return null;
  const b = modelBounds?.[assetId];
  if (b === undefined) return null;
  const sc = world.scale;
  const lo: [number, number, number] = [0, 1, 2].map((a) => Math.min(b.min[a]! * sc[a]!, b.max[a]! * sc[a]!)) as [number, number, number];
  const hi: [number, number, number] = [0, 1, 2].map((a) => Math.max(b.min[a]! * sc[a]!, b.max[a]! * sc[a]!)) as [number, number, number];
  const box: Solid = { m: transpose3(body), o: [0, 0, 0], lo, hi, test: (x, y, z) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2] };
  const shape = shapeOf(world.position, [box]);
  return shape === null ? null : { shape, source: 'bounds' };
}
