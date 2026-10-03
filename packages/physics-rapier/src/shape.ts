/**
 * Collider-shape validation — the adapter's own copy of the accepted
 * vocabulary (project-model's `validateColliderShape`).
 *
 * The runtime hands the adapter an opaque `shape: unknown`
 * (`StaticColliderSpec`), and `physics-rapier` has no `project-model` edge,
 * so the adapter re-validates before creating a
 * Rapier collider: a shape the model would reject must fail init as
 * `physics_init_failed` (`reason: "invalid_shape"`) rather than reach the
 * library. The check order and limits mirror project-model's
 * `validateColliderShape` exactly (box bounds; polygon vertex count, per-vertex
 * finiteness/`|v| ≤ 1e6`, duplicate adjacent vertex, counter-clockwise area,
 * minimum area, convexity within `1e-9`, bounding half-extent `≤ 64 m`).
 */
import {
  CONVEX_TOLERANCE,
  MAX_COLLIDER_HALF_EXTENT,
  MAX_POLYGON_VERTICES,
  MAX_SHAPE_VALUE,
  MIN_POLYGON_AREA,
} from './constants';
import type { ColliderPart2D, RapierColliderPrimitive, RapierColliderShape } from './types';

export type ShapeValidation =
  | { ok: true; shape: RapierColliderShape }
  | { ok: false; detail: string };

type PrimitiveValidation =
  | { ok: true; shape: RapierColliderPrimitive }
  | { ok: false; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInRange(value: unknown, absMax: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= absMax;
}

/**
 * A box or polygon, or a compound of at least one placed box or polygon
 * (finite `x`, `y` and `angle` each, in the body's frame).
 */
export function validateColliderShape(value: unknown): ShapeValidation {
  if (isPlainObject(value) && value['type'] === 'compound') {
    for (const key of Object.keys(value)) if (key !== 'type' && key !== 'parts') return { ok: false, detail: `compound shape has an unexpected field '${key}'` };
    const parts = value['parts'];
    if (!Array.isArray(parts) || parts.length === 0) return { ok: false, detail: 'a compound shape has at least one part' };
    const out: ColliderPart2D[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as unknown;
      if (!isPlainObject(part)) return { ok: false, detail: `compound part ${i} must be an object` };
      const { x, y, angle } = part;
      if (!finiteInRange(x, MAX_SHAPE_VALUE) || !finiteInRange(y, MAX_SHAPE_VALUE) || !finiteInRange(angle, MAX_SHAPE_VALUE)) return { ok: false, detail: `compound part ${i}: x, y and angle must be finite` };
      const shape = validatePrimitive(part['shape']);
      if (!shape.ok) return { ok: false, detail: `compound part ${i}: ${shape.detail}` };
      out.push({ shape: shape.shape, x, y, angle });
    }
    return { ok: true, shape: { type: 'compound', parts: out } };
  }
  return validatePrimitive(value);
}

function validatePrimitive(value: unknown): PrimitiveValidation {
  if (!isPlainObject(value)) return { ok: false, detail: 'shape must be an object' };
  const type = value['type'];
  if (type === 'box') {
    const hx = value['hx'];
    const hy = value['hy'];
    if (!finiteInRange(hx, MAX_SHAPE_VALUE) || hx <= 0) {
      return { ok: false, detail: `box hx must satisfy 0 < hx <= ${MAX_SHAPE_VALUE}` };
    }
    if (!finiteInRange(hy, MAX_SHAPE_VALUE) || hy <= 0) {
      return { ok: false, detail: `box hy must satisfy 0 < hy <= ${MAX_SHAPE_VALUE}` };
    }
    for (const key of Object.keys(value)) {
      if (key !== 'type' && key !== 'hx' && key !== 'hy') {
        return { ok: false, detail: `box shape has an unexpected field '${key}'` };
      }
    }
    return { ok: true, shape: { type: 'box', hx, hy } };
  }
  if (type === 'polygon') {
    const verts = value['vertices'];
    if (!Array.isArray(verts)) {
      return { ok: false, detail: 'polygon vertices must be an array of [x, y] pairs' };
    }
    if (verts.length < 3 || verts.length > MAX_POLYGON_VERTICES) {
      return {
        ok: false,
        detail: `a polygon collider must have 3-${MAX_POLYGON_VERTICES} vertices (limit collider_vertices)`,
      };
    }
    const pts: [number, number][] = [];
    for (let i = 0; i < verts.length; i += 1) {
      const pair = verts[i];
      if (!Array.isArray(pair) || pair.length !== 2) {
        return { ok: false, detail: `polygon vertex ${i} must be an [x, y] pair` };
      }
      const x = pair[0];
      const y = pair[1];
      if (!finiteInRange(x, MAX_SHAPE_VALUE) || !finiteInRange(y, MAX_SHAPE_VALUE)) {
        return { ok: false, detail: `polygon vertex ${i} must satisfy |v| <= ${MAX_SHAPE_VALUE}` };
      }
      pts.push([x, y]);
    }
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if (a[0] === b[0] && a[1] === b[1]) {
        return { ok: false, detail: 'polygon vertices must not repeat an adjacent vertex' };
      }
    }
    let twiceArea = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    const area = twiceArea / 2;
    if (area <= 0) {
      return {
        ok: false,
        detail: 'polygon vertices must be in counter-clockwise order (positive signed area)',
      };
    }
    if (area < MIN_POLYGON_AREA) {
      return { ok: false, detail: `polygon area must be >= ${MIN_POLYGON_AREA} m^2` };
    }
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const c = pts[(i + 2) % pts.length]!;
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cross < -CONVEX_TOLERANCE) return { ok: false, detail: 'polygon must be convex' };
    }
    for (const [x, y] of pts) {
      if (Math.max(Math.abs(x), Math.abs(y)) > MAX_COLLIDER_HALF_EXTENT) {
        return {
          ok: false,
          detail: `bounding half-extent must be <= ${MAX_COLLIDER_HALF_EXTENT} m`,
        };
      }
    }
    for (const key of Object.keys(value)) {
      if (key !== 'type' && key !== 'vertices') {
        return { ok: false, detail: `polygon shape has an unexpected field '${key}'` };
      }
    }
    return { ok: true, shape: { type: 'polygon', vertices: pts } };
  }
  return { ok: false, detail: 'collider shape type must be "box", "polygon" or "compound"' };
}

/** Row-major `Float32Array` vertex buffer for `ColliderDesc.convexHull`. */
export function polygonVertexBuffer(shape: RapierColliderPrimitive): Float32Array | null {
  if (shape.type !== 'polygon') return null;
  const out = new Float32Array(shape.vertices.length * 2);
  for (let i = 0; i < shape.vertices.length; i += 1) {
    const v = shape.vertices[i]!;
    out[i * 2] = v[0];
    out[i * 2 + 1] = v[1];
  }
  return out;
}
