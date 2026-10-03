/**
 * Collider shapes: the primitive shapes, where a shape sits in its object's
 * frame (`center`, `rotation`), compounds (a list of primitives, each placed
 * on its own) and `model` (every convex part of the object's model's `_COL`
 * node, resolved when a game is built). Validation, canonical form and the
 * limits the physics ports re-check.
 *
 * Pure and total: same input → same result, never throws, never reads files.
 */
import {
  checkFiniteNumber,
  checkQuaternion,
  fieldMissing,
  fieldType,
  fieldValue,
  isPlainObject,
  MAX_LEN,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2 } from './errors';
import type { ColliderPrimitiveShape, ColliderShape } from './types-v2';

/**
 * The points of one 2D polygon collider. A scene has no collider count of its
 * own: every entity may carry one (the scene's entity cap bounds them);
 * 16,384 static colliders cost Rapier about 3 ms a step (measured).
 */
export const MAX_POLYGON_VERTICES = 8;
export const MAX_COLLIDER_EXTENT = 64;
export const MIN_POLYGON_AREA = 1e-6;
export const CONVEX_TOL = 1e-9;

/**
 * The limits of the 3D collider shapes. A hull of 64 points and
 * a mesh of 1,024 vertices / 2,048 triangles are far beyond a collision
 * proxy (a `_COL` node is a handful of boxes' worth of triangles) and keep
 * one collider inside a command request (64 KiB); a scene holds at most
 * 1,048,576 hull/mesh points in all (a thousand full meshes: Rapier builds
 * them in about 2 s at load and steps them in under 1 ms, measured). Every
 * coordinate lies within the 64 m collider extent, like a polygon's. A
 * compound has no shape count of its own: its hulls' and meshes' points
 * count toward that scene budget, and the command request bounds one edit.
 */
export const COLLIDER_3D_LIMITS = Object.freeze({ convexPoints: 64, meshVertices: 1024, meshTriangles: 2048, pointsTotal: 1_048_576 });
/** The 3D collider shape types (a 3D project only; a 2D plane uses box and polygon). */
export const COLLIDER_3D_SHAPES = ['sphere', 'capsule', 'convex', 'mesh'] as const;
/** The shape types a compound lists (and a collider may be itself). */
export const COLLIDER_PRIMITIVE_TYPES = ['box', 'polygon', 'sphere', 'capsule', 'convex', 'mesh'] as const;
/** Every collider shape type: the primitives, a compound of them, or the model's `_COL` parts. */
export const COLLIDER_SHAPE_TYPES = [...COLLIDER_PRIMITIVE_TYPES, 'compound', 'model'] as const;
const PRIMITIVE_TYPES: readonly string[] = COLLIDER_PRIMITIVE_TYPES;

const KNOWN_BOX_SHAPE_FIELDS = new Set(['type', 'hx', 'hy', 'hz', 'center', 'rotation']);
const KNOWN_POLYGON_SHAPE_FIELDS = new Set(['type', 'vertices', 'center', 'rotation']);
const KNOWN_SPHERE_SHAPE_FIELDS = new Set(['type', 'radius', 'center', 'rotation']);
const KNOWN_CAPSULE_SHAPE_FIELDS = new Set(['type', 'radius', 'height', 'center', 'rotation']);
const KNOWN_CONVEX_SHAPE_FIELDS = new Set(['type', 'points', 'center', 'rotation']);
const KNOWN_MESH_SHAPE_FIELDS = new Set(['type', 'vertices', 'triangles', 'center', 'rotation']);

export function limitsError(
  path: string,
  limit: NonNullable<ModelErrorV2['limit']>,
  current: number,
  max: number,
  message: string,
): ModelErrorV2 {
  return withFound(
    {
      code: 'limits_exceeded',
      path,
      message,
      limit,
      current,
      max,
      expected: `<= ${max}`,
    },
    current,
  );
}

/**
 * A shape's place in its object's frame: `center` [x, y, z] in metres (a 2D
 * plane reads x and y), each within the collider extent, and
 * `rotation` a unit quaternion [x, y, z, w] (a 2D plane turns about Z only:
 * the project's dimension rule).
 */
function validateShapePose(shape: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  const center = shape['center'];
  if (center !== undefined) {
    const ok = Array.isArray(center) && center.length === 3 && center.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COLLIDER_EXTENT);
    if (!ok) errors.push(fieldValue(`${path}/center`, center, `[x, y, z], each within ±${MAX_COLLIDER_EXTENT} m`, "a shape's center is [x, y, z] in metres from its object's origin"));
  }
  if (shape['rotation'] !== undefined) checkQuaternion(shape['rotation'], `${path}/rotation`, errors);
}

/**
 * One collider shape: a primitive (with an optional center and rotation), a
 * `compound` of at least one primitive, or `model`. A compound's own shapes
 * are primitives (no compound inside a compound, no model).
 */
export function validateColliderShape(shape: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(shape)) {
    errors.push(fieldType(path, shape, 'object'));
    return;
  }
  const type = shape['type'];
  if (type === 'model') {
    for (const k of Object.keys(shape)) if (k !== 'type') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type'));
    return;
  }
  if (type === 'compound') {
    const list = shape['shapes'];
    if (list === undefined) errors.push(fieldMissing(`${path}/shapes`, 'shapes'));
    else if (!Array.isArray(list) || list.length === 0) errors.push(fieldValue(`${path}/shapes`, list, 'a list of at least one shape', 'a compound lists its shapes, each a box, polygon, sphere, capsule, convex or mesh'));
    else {
      list.forEach((part, i) => {
        const t = isPlainObject(part) ? part['type'] : undefined;
        if (t === 'compound' || t === 'model') errors.push(fieldValue(`${path}/shapes/${i}/type`, t, '"box" | "polygon" | "sphere" | "capsule" | "convex" | "mesh"', 'a compound lists primitive shapes (no compound or model inside it)'));
        else validatePrimitiveShape(part, `${path}/shapes/${i}`, errors);
      });
    }
    for (const k of Object.keys(shape)) if (k !== 'type' && k !== 'shapes') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, shapes'));
    return;
  }
  if (!PRIMITIVE_TYPES.includes(type as string)) {
    errors.push(fieldValue(`${path}/type`, type, '"box" | "polygon" | "sphere" | "capsule" | "convex" | "mesh" | "compound" | "model"', 'collider shape type must be "box", "polygon", "compound" or "model" (a 3D project also "sphere", "capsule", "convex" or "mesh")'));
    return;
  }
  validatePrimitiveShape(shape, path, errors);
}

function validatePrimitiveShape(shape: unknown, path: string, errors: ModelErrorV2[]): void {
  const bad = (message: string, found: unknown): void => {
    errors.push(withFound({ code: 'collider_shape_invalid', path, message, expected: 'a valid collider shape' }, found));
  };
  if (!isPlainObject(shape)) {
    errors.push(fieldType(path, shape, 'object'));
    return;
  }
  const type = shape['type'];
  if (PRIMITIVE_TYPES.includes(type as string)) validateShapePose(shape, path, errors);
  if (type === 'box') {
    if (shape['hx'] === undefined) errors.push(fieldMissing(`${path}/hx`, 'hx'));
    else checkFiniteNumber(shape['hx'], `${path}/hx`, { positive: true, absMax: MAX_LEN }, `0 < hx <= ${MAX_LEN}`, errors);
    if (shape['hy'] === undefined) errors.push(fieldMissing(`${path}/hy`, 'hy'));
    else checkFiniteNumber(shape['hy'], `${path}/hy`, { positive: true, absMax: MAX_LEN }, `0 < hy <= ${MAX_LEN}`, errors);
    // The half depth along Z (optional; a 3D project requires it, a 2D plane ignores it).
    if (shape['hz'] !== undefined) checkFiniteNumber(shape['hz'], `${path}/hz`, { positive: true, absMax: MAX_LEN }, `0 < hz <= ${MAX_LEN}`, errors);
    for (const k of Object.keys(shape)) {
      if (!KNOWN_BOX_SHAPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, hx, hy, hz, center, rotation'));
    }
    return;
  }
  if (type === 'polygon') {
    const verts = shape['vertices'];
    if (verts === undefined) {
      errors.push(fieldMissing(`${path}/vertices`, 'vertices'));
    } else if (!Array.isArray(verts)) {
      errors.push(fieldType(`${path}/vertices`, verts, 'array of [x, y] pairs'));
    } else {
      if (verts.length < 3 || verts.length > MAX_POLYGON_VERTICES) {
        errors.push(
          limitsError(
            `${path}/vertices`,
            'collider_vertices',
            verts.length,
            MAX_POLYGON_VERTICES,
            `a polygon collider must have 3-${MAX_POLYGON_VERTICES} vertices`,
          ),
        );
      } else {
        const pts: [number, number][] = [];
        let malformed = false;
        for (let i = 0; i < verts.length; i++) {
          const pair = verts[i];
          if (!Array.isArray(pair) || pair.length !== 2) {
            bad('each polygon vertex must be an [x, y] pair', pair);
            malformed = true;
            break;
          }
          const before = errors.length;
          checkFiniteNumber(pair[0], `${path}/vertices/${i}/0`, { absMax: MAX_LEN }, `|v| <= ${MAX_LEN}`, errors);
          checkFiniteNumber(pair[1], `${path}/vertices/${i}/1`, { absMax: MAX_LEN }, `|v| <= ${MAX_LEN}`, errors);
          if (errors.length !== before) {
            malformed = true;
            break;
          }
          pts.push([pair[0] as number, pair[1] as number]);
        }
        if (!malformed) {
          // duplicate adjacent vertices (including the closing edge)
          let duplicate = false;
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i] as [number, number];
            const b = pts[(i + 1) % pts.length] as [number, number];
            if (a[0] === b[0] && a[1] === b[1]) duplicate = true;
          }
          // counter-clockwise signed area (shoelace)
          let twiceArea = 0;
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i] as [number, number];
            const b = pts[(i + 1) % pts.length] as [number, number];
            twiceArea += a[0] * b[1] - b[0] * a[1];
          }
          const area = twiceArea / 2;
          let convex = true;
          if (area > 0) {
            for (let i = 0; i < pts.length; i++) {
              const a = pts[i] as [number, number];
              const b = pts[(i + 1) % pts.length] as [number, number];
              const c = pts[(i + 2) % pts.length] as [number, number];
              const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
              if (cross < -CONVEX_TOL) convex = false;
            }
          }
          if (duplicate) {
            bad('polygon vertices must not repeat an adjacent vertex', pts);
          } else if (area <= 0) {
            bad('polygon vertices must be in counter-clockwise order (positive signed area)', pts);
          } else if (area < MIN_POLYGON_AREA) {
            bad(`polygon area must be >= ${MIN_POLYGON_AREA} m^2`, area);
          } else if (!convex) {
            bad('polygon must be convex', pts);
          } else {
            for (const [x, y] of pts) {
              if (Math.max(Math.abs(x), Math.abs(y)) > MAX_COLLIDER_EXTENT) {
                bad(`bounding half-extent must be <= ${MAX_COLLIDER_EXTENT} m`, [x, y]);
                break;
              }
            }
          }
        }
      }
      for (const k of Object.keys(shape)) {
        if (!KNOWN_POLYGON_SHAPE_FIELDS.has(k)) {
          errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, vertices, center, rotation'));
        }
      }
    }
    return;
  }
  if (type === 'sphere' || type === 'capsule') {
    // 3D shapes (the project's physics dimension is checked with the content).
    if (shape['radius'] === undefined) errors.push(fieldMissing(`${path}/radius`, 'radius'));
    else checkFiniteNumber(shape['radius'], `${path}/radius`, { positive: true, absMax: MAX_COLLIDER_EXTENT }, `0 < radius <= ${MAX_COLLIDER_EXTENT}`, errors);
    if (type === 'capsule') {
      const h = shape['height'];
      if (h === undefined) errors.push(fieldMissing(`${path}/height`, 'height'));
      else {
        const before = errors.length;
        checkFiniteNumber(h, `${path}/height`, { positive: true, absMax: 2 * MAX_COLLIDER_EXTENT }, `0 < height <= ${2 * MAX_COLLIDER_EXTENT}`, errors);
        const r = shape['radius'];
        if (errors.length === before && typeof r === 'number' && Number.isFinite(r) && (h as number) < 2 * r) {
          bad('a capsule\'s height (end caps included) must be at least twice its radius', h);
        }
      }
    }
    const known = type === 'sphere' ? KNOWN_SPHERE_SHAPE_FIELDS : KNOWN_CAPSULE_SHAPE_FIELDS;
    for (const k of Object.keys(shape)) {
      if (!known.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, type === 'sphere' ? 'type, radius, center, rotation' : 'type, radius, height, center, rotation'));
    }
    return;
  }
  if (type === 'convex' || type === 'mesh') {
    const L = COLLIDER_3D_LIMITS;
    const key = type === 'convex' ? 'points' : 'vertices';
    const max = type === 'convex' ? L.convexPoints : L.meshVertices;
    const min = type === 'convex' ? 4 : 3;
    const list = shape[key];
    const pts = point3List(list, `${path}/${key}`, min, max, errors);
    if (pts !== null && type === 'convex' && !spansVolume(pts)) bad('the hull points must not all lie in one plane (a convex hull needs volume)', list);
    if (type === 'mesh') {
      const tris = shape['triangles'];
      if (tris === undefined) errors.push(fieldMissing(`${path}/triangles`, 'triangles'));
      else if (!Array.isArray(tris)) errors.push(fieldType(`${path}/triangles`, tris, 'array of [a, b, c] vertex indices'));
      else if (tris.length < 1 || tris.length > L.meshTriangles) {
        errors.push(limitsError(`${path}/triangles`, 'collider_vertices', tris.length, L.meshTriangles, `a mesh collider has 1-${L.meshTriangles} triangles`));
      } else {
        const n = Array.isArray(list) ? list.length : 0;
        for (let i = 0; i < tris.length; i++) {
          const t = tris[i];
          const ok = Array.isArray(t) && t.length === 3 && t.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < n) && t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2];
          if (!ok) {
            errors.push(withFound({ code: 'collider_shape_invalid', path: `${path}/triangles/${i}`, message: 'each triangle is three different vertex indices [a, b, c]', expected: `integers 0-${Math.max(0, n - 1)}` }, t));
            break;
          }
        }
      }
    }
    const known = type === 'convex' ? KNOWN_CONVEX_SHAPE_FIELDS : KNOWN_MESH_SHAPE_FIELDS;
    for (const k of Object.keys(shape)) {
      if (!known.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, type === 'convex' ? 'type, points, center, rotation' : 'type, vertices, triangles, center, rotation'));
    }
    return;
  }
  errors.push(
    fieldValue(
      `${path}/type`,
      type,
      '"box" | "polygon" | "sphere" | "capsule" | "convex" | "mesh"',
      'a shape is "box" or "polygon" (a 3D project also "sphere", "capsule", "convex" or "mesh")',
    ),
  );
}

/** A list of [x, y, z] points (each within the collider extent), or null after recording why not. */
function point3List(list: unknown, path: string, min: number, max: number, errors: ModelErrorV2[]): [number, number, number][] | null {
  if (list === undefined) {
    errors.push(fieldMissing(path, path.slice(path.lastIndexOf('/') + 1)));
    return null;
  }
  if (!Array.isArray(list)) {
    errors.push(fieldType(path, list, 'array of [x, y, z] points'));
    return null;
  }
  if (list.length < min || list.length > max) {
    errors.push(limitsError(path, 'collider_vertices', list.length, max, `this collider has ${min}-${max} points`));
    return null;
  }
  const out: [number, number, number][] = [];
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const ok = Array.isArray(q) && q.length === 3 && q.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_COLLIDER_EXTENT);
    if (!ok) {
      errors.push(withFound({ code: 'collider_shape_invalid', path: `${path}/${i}`, message: `each point is [x, y, z] in metres within ${MAX_COLLIDER_EXTENT} m of the entity`, expected: `[x, y, z], |v| <= ${MAX_COLLIDER_EXTENT}` }, q));
      return null;
    }
    out.push([q[0] as number, q[1] as number, q[2] as number]);
  }
  return out;
}

/** Whether points span a volume (not all on one plane, within 1 mm³ of tolerance). */
export function spansVolume(pts: readonly (readonly [number, number, number])[]): boolean {
  const a = pts[0]!;
  let b = a;
  let best = 0;
  for (const p of pts) {
    const d = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    if (d > best) [best, b] = [d, p];
  }
  if (best < 1e-6) return false;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  let c = a;
  let area = 0;
  for (const p of pts) {
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const cr = [ab[1]! * ap[2]! - ab[2]! * ap[1]!, ab[2]! * ap[0]! - ab[0]! * ap[2]!, ab[0]! * ap[1]! - ab[1]! * ap[0]!];
    const m = Math.hypot(cr[0]!, cr[1]!, cr[2]!);
    if (m > area) [area, c] = [m, p];
  }
  if (area < 1e-9) return false;
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
  let vol = 0;
  for (const p of pts) vol = Math.max(vol, Math.abs(n[0]! * (p[0] - a[0]) + n[1]! * (p[1] - a[1]) + n[2]! * (p[2] - a[2])));
  return vol > 1e-9;
}

/** The primitive shapes of a collider shape (a compound's list, a primitive alone; none for `model`, which a build resolves). */
export function colliderShapeParts(shape: unknown): readonly Record<string, unknown>[] {
  if (!isPlainObject(shape)) return [];
  if (shape['type'] === 'compound') return Array.isArray(shape['shapes']) ? (shape['shapes'] as unknown[]).filter(isPlainObject) : [];
  if (shape['type'] === 'model') return [];
  return [shape];
}

/** The hull points and mesh vertices a collider shape holds (the scene's 3D point budget counts them). */
export function colliderShapePoints(shape: unknown): number {
  let n = 0;
  for (const p of colliderShapeParts(shape)) {
    if (p['type'] === 'convex' && Array.isArray(p['points'])) n += p['points'].length;
    if (p['type'] === 'mesh' && Array.isArray(p['vertices'])) n += p['vertices'].length;
  }
  return n;
}

// ---- canonicalization -------------------------------------------------

function canonNum(v: unknown): number {
  const n = v as number;
  return n === 0 ? 0 : n;
}

export function canonicalCollider(c: unknown): ColliderShape {
  return canonicalShape((c as Record<string, unknown>)['shape']);
}

/** A validated shape with its numbers canonical (−0 → 0) and its pose kept. */
export function canonicalShape(value: unknown): ColliderShape {
  const shape = value as Record<string, unknown>;
  if (shape['type'] === 'model') return { type: 'model' };
  if (shape['type'] === 'compound') return { type: 'compound', shapes: (shape['shapes'] as unknown[]).map((p) => canonicalShape(p) as ColliderPrimitiveShape) };
  return withPose(canonicalPrimitive(shape), shape);
}

function withPose(base: ColliderPrimitiveShape, shape: Record<string, unknown>): ColliderPrimitiveShape {
  const center = shape['center'];
  const rotation = shape['rotation'];
  return {
    ...base,
    ...(Array.isArray(center) ? { center: (center as number[]).map(canonNum) as [number, number, number] } : {}),
    ...(Array.isArray(rotation) ? { rotation: (rotation as number[]).map(canonNum) as [number, number, number, number] } : {}),
  };
}

function canonicalPrimitive(shape: Record<string, unknown>): ColliderPrimitiveShape {  if (shape['type'] === 'box') {
    return { type: 'box', hx: canonNum(shape['hx']), hy: canonNum(shape['hy']), ...(shape['hz'] !== undefined ? { hz: canonNum(shape['hz']) } : {}) };
  }
  // The 3D shapes.
  const p3 = (q: unknown): [number, number, number] => {
    const a = q as unknown[];
    return [canonNum(a[0]), canonNum(a[1]), canonNum(a[2])];
  };
  if (shape['type'] === 'sphere') return { type: 'sphere', radius: canonNum(shape['radius']) };
  if (shape['type'] === 'capsule') return { type: 'capsule', radius: canonNum(shape['radius']), height: canonNum(shape['height']) };
  if (shape['type'] === 'convex') return { type: 'convex', points: (shape['points'] as unknown[]).map(p3) };
  if (shape['type'] === 'mesh') {
    return { type: 'mesh', vertices: (shape['vertices'] as unknown[]).map(p3), triangles: (shape['triangles'] as unknown[]).map((t) => [...(t as number[])] as [number, number, number]) };
  }
  const verts = shape['vertices'] as unknown[];
  return {
    type: 'polygon',
    vertices: verts.map((p) => {
      const pair = p as unknown[];
      return [canonNum(pair[0]), canonNum(pair[1])] as [number, number];
    }),
  };
}
