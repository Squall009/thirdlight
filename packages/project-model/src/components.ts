/**
 * Component-level validators shared by the v3/v4 scene and content models —
 * project-model.md §10.5–§10.8, §12.2/§12.3, §21 (model, behavior, prefab
 * provenance, collider/controller and their physics transform rules; the
 * transform/box/camera field rules).
 *
 * These were the schemaVersion 2 scene's component rules; the v2 scene
 * validator itself was removed in phase 9.3 (only v4 projects load, v3 ones
 * upgrade on open), and what the v3/v4 validators reuse lives here.
 *
 * Pure and total: same input → same result, never throws, never reads files.
 */

import {
  checkFiniteNumber,
  checkQuaternion,
  checkVector,
  canonicalTransform,
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isPlainObject,
  isValidName,
  MAX_LEN,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2 } from './errors';
import type { ColliderShape, ControllerComponent, TransformComponent } from './types-v2';

export const ID_RE_V2 = /^[a-z0-9][a-z0-9_-]{0,63}$/; // §5.1
export const PROPERTY_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/; // §20.5

export const MAX_ENTITIES_V2 = 1024; // §10.4
export const MAX_COLLIDERS = 256; // §10.7
export const MAX_POLYGON_VERTICES = 8; // §10.7
export const MAX_POLYGON_VERTICES_TOTAL = 1024; // §10.7
export const MAX_COLLIDER_EXTENT = 64; // §10.7
export const MIN_POLYGON_AREA = 1e-6; // §10.7
export const CONVEX_TOL = 1e-9; // §10.7

const KNOWN_MODEL_FIELDS = new Set(['asset', 'piece', 'castShadow', 'receiveShadow']);
const KNOWN_MODEL_ASSET_FIELDS = new Set(['assetId']);
const KNOWN_BEHAVIOR_FIELDS = new Set(['behaviorId', 'values']);
const KNOWN_PREFAB_FIELDS = new Set(['prefabId', 'localId']);
const KNOWN_COLLIDER_FIELDS = new Set(['shape']);
const KNOWN_BOX_SHAPE_FIELDS = new Set(['type', 'hx', 'hy', 'hz']);
const KNOWN_POLYGON_SHAPE_FIELDS = new Set(['type', 'vertices']);
const KNOWN_SPHERE_SHAPE_FIELDS = new Set(['type', 'radius']);
const KNOWN_CAPSULE_SHAPE_FIELDS = new Set(['type', 'radius', 'height']);
const KNOWN_CONVEX_SHAPE_FIELDS = new Set(['type', 'points']);
const KNOWN_MESH_SHAPE_FIELDS = new Set(['type', 'vertices', 'triangles']);

/**
 * Phase 23.1: the limits of the 3D collider shapes. A hull of 64 points and
 * a mesh of 1,024 vertices / 2,048 triangles are far beyond a collision
 * proxy (a `_COL` node is a handful of boxes' worth of triangles) and keep
 * one collider inside a command request (64 KiB); a scene holds at most
 * 32,768 hull/mesh points in all. Every coordinate lies within the 64 m
 * collider extent, like a polygon's.
 */
export const COLLIDER_3D_LIMITS = Object.freeze({ convexPoints: 64, meshVertices: 1024, meshTriangles: 2048, pointsTotal: 32768 });
/** Phase 23.1: the 3D collider shape types (a 3D project only; a 2D plane uses box and polygon). */
export const COLLIDER_3D_SHAPES = ['sphere', 'capsule', 'convex', 'mesh'] as const;
const KNOWN_TRANSFORM_FIELDS = new Set(['position', 'rotation', 'scale']);
const KNOWN_BOX_FIELDS = new Set(['size', 'material', 'castShadow', 'receiveShadow']);
const KNOWN_MATERIAL_FIELDS = new Set(['color']);
const KNOWN_CAMERA_FIELDS = new Set(['type', 'fovY', 'near', 'far']);

// ---- small helpers -----------------------------------------------------------

function limitsError(
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

function isPropertyValueShape(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean' || typeof v === 'string') return true;
  if (Array.isArray(v)) {
    return v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
  return false;
}

// ---- components --------------------------------------------------------------

export function validateModelComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const asset = c['asset'];
  if (asset === undefined) {
    errors.push(fieldMissing(`${path}/asset`, 'asset'));
  } else if (!isPlainObject(asset)) {
    errors.push(fieldType(`${path}/asset`, asset, 'object'));
  } else {
    const assetId = asset['assetId'];
    if (assetId === undefined) {
      errors.push(fieldMissing(`${path}/asset/assetId`, 'assetId'));
    } else if (typeof assetId !== 'string') {
      errors.push(fieldType(`${path}/asset/assetId`, assetId, 'string'));
    } else if (!ID_RE_V2.test(assetId)) {
      errors.push(idInvalid(`${path}/asset/assetId`, assetId));
    }
    for (const k of Object.keys(asset)) {
      if (!KNOWN_MODEL_ASSET_FIELDS.has(k)) {
        errors.push(unexpectedField(`${path}/asset/${pointerSegment(k)}`, k, 'assetId'));
      }
    }
  }
  validateModelPiece(c['piece'], `${path}/piece`, errors);
  validateShadowFlags(c, path, errors);
  for (const k of Object.keys(c)) {
    if (!KNOWN_MODEL_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'asset, piece, castShadow, receiveShadow'));
  }
}

/**
 * Phase 17.4: optional `castShadow` / `receiveShadow` booleans of a visible
 * object (box, model, instance set). Absent = true: solid geometry blocks the
 * light and shows the shadows falling on it in any genre; a decal, a glow or a
 * distant backdrop turns them off.
 */
export function validateShadowFlags(c: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  for (const k of ['castShadow', 'receiveShadow'] as const) {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') errors.push(fieldType(`${path}/${k}`, c[k], 'boolean'));
  }
}

/**
 * Optional `piece`: one named piece of a multi-piece GLB (the base name of its
 * `<piece>_LOD<n>`/`<piece>_COL` nodes, or a top-level node name). Absent =
 * the whole file.
 */
export function validateModelPiece(piece: unknown, path: string, errors: ModelErrorV2[]): void {
  if (piece === undefined) return;
  if (typeof piece !== 'string') errors.push(fieldType(path, piece, 'string'));
  else if (!isValidName(piece)) {
    errors.push(fieldValue(path, piece, 'string, 1-128 chars, no control characters', 'piece must be 1-128 characters without control characters'));
  }
}

export function validateBehaviorComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const behaviorId = c['behaviorId'];
  if (behaviorId === undefined) {
    errors.push(fieldMissing(`${path}/behaviorId`, 'behaviorId'));
  } else if (typeof behaviorId !== 'string') {
    errors.push(fieldType(`${path}/behaviorId`, behaviorId, 'string'));
  } else if (!ID_RE_V2.test(behaviorId)) {
    errors.push(idInvalid(`${path}/behaviorId`, behaviorId));
  }
  const values = c['values'];
  if (values === undefined) {
    errors.push(fieldMissing(`${path}/values`, 'values'));
  } else if (!isPlainObject(values)) {
    errors.push(fieldType(`${path}/values`, values, 'object'));
  } else {
    for (const k of Object.keys(values)) {
      if (!PROPERTY_KEY_RE.test(k)) {
        errors.push(
          fieldValue(
            `${path}/values/${pointerSegment(k)}`,
            k,
            'property key ^[a-z][a-z0-9_]{0,63}$',
            'behavior property keys must match the declared key syntax',
          ),
        );
      }
      const v = values[k];
      if (!isPropertyValueShape(v)) {
        errors.push(
          fieldValue(
            `${path}/values/${pointerSegment(k)}`,
            v,
            'number | boolean | string | [number, number, number] | null',
            'behavior property value does not match the seven-type value vocabulary',
          ),
        );
      }
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_BEHAVIOR_FIELDS.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'behaviorId, values'));
    }
  }
}

export function validatePrefabProvenance(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const field of ['prefabId', 'localId'] as const) {
    const v = c[field];
    if (v === undefined) {
      errors.push(fieldMissing(`${path}/${field}`, field));
    } else if (typeof v !== 'string') {
      errors.push(fieldType(`${path}/${field}`, v, 'string'));
    } else if (!ID_RE_V2.test(v)) {
      errors.push(idInvalid(`${path}/${field}`, v));
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_PREFAB_FIELDS.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'prefabId, localId'));
    }
  }
}

function validateColliderShape(shape: unknown, path: string, errors: ModelErrorV2[]): void {
  const bad = (message: string, found: unknown): void => {
    errors.push(withFound({ code: 'collider_shape_invalid', path, message, expected: 'a valid collider shape' }, found));
  };
  if (!isPlainObject(shape)) {
    errors.push(fieldType(path, shape, 'object'));
    return;
  }
  const type = shape['type'];
  if (type === 'box') {
    if (shape['hx'] === undefined) errors.push(fieldMissing(`${path}/hx`, 'hx'));
    else checkFiniteNumber(shape['hx'], `${path}/hx`, { positive: true, absMax: MAX_LEN }, `0 < hx <= ${MAX_LEN}`, errors);
    if (shape['hy'] === undefined) errors.push(fieldMissing(`${path}/hy`, 'hy'));
    else checkFiniteNumber(shape['hy'], `${path}/hy`, { positive: true, absMax: MAX_LEN }, `0 < hy <= ${MAX_LEN}`, errors);
    // Phase 23.0: the half depth along Z (optional; a 3D project requires it, a 2D plane ignores it).
    if (shape['hz'] !== undefined) checkFiniteNumber(shape['hz'], `${path}/hz`, { positive: true, absMax: MAX_LEN }, `0 < hz <= ${MAX_LEN}`, errors);
    for (const k of Object.keys(shape)) {
      if (!KNOWN_BOX_SHAPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, hx, hy, hz'));
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
          errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, vertices'));
        }
      }
    }
    return;
  }
  if (type === 'sphere' || type === 'capsule') {
    // Phase 23.1: 3D shapes (the project's physics dimension is checked with the content).
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
      if (!known.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, type === 'sphere' ? 'type, radius' : 'type, radius, height'));
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
    if (pts !== null && type === 'convex' && !hasVolume(pts)) bad('the hull points must not all lie in one plane (a convex hull needs volume)', list);
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
      if (!known.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, type === 'convex' ? 'type, points' : 'type, vertices, triangles'));
    }
    return;
  }
  errors.push(
    fieldValue(
      `${path}/type`,
      type,
      '"box" | "polygon" | "sphere" | "capsule" | "convex" | "mesh"',
      'collider shape type must be "box" or "polygon" (a 3D project also "sphere", "capsule", "convex" or "mesh")',
    ),
  );
}

/** Phase 23.1: a list of [x, y, z] points (each within the collider extent), or null after recording why not. */
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

/** Phase 23.1: whether points span a volume (not all on one plane, within 1 mm³ of tolerance). */
function hasVolume(pts: readonly (readonly [number, number, number])[]): boolean {
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

export function validateColliderComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const shape = c['shape'];
  if (shape === undefined) {
    errors.push(fieldMissing(`${path}/shape`, 'shape'));
  } else {
    validateColliderShape(shape, `${path}/shape`, errors);
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_COLLIDER_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'shape'));
  }
}

/**
 * Phase 14.0: the default character capsule when a controller carries none —
 * 0.3 m radius and 1.8 m total height (an adult human standing: about 0.6 m
 * across the shoulders, 1.8 m tall), centred on the entity. Every project
 * made before the capsule became data plays with exactly this shape.
 */
export const DEFAULT_CONTROLLER_CAPSULE: Readonly<{ radius: number; height: number; offset: readonly [number, number] }> = Object.freeze({
  radius: 0.3,
  height: 1.8,
  offset: Object.freeze([0, 0]) as readonly [number, number],
});

/** Phase 14.0: the capsule ranges (m) — far beyond any character, small enough to keep the solver sane. */
export const CAPSULE_LIMITS = Object.freeze({ minRadius: 0.05, maxRadius: 5, minHeight: 0.1, maxHeight: 20, maxOffset: 5 });

/** Phase 23.0: the capsule centre's offset along Z (a 3D project; the offset's optional third component, else 0). */
export function controllerCapsuleOffsetZ(controller: unknown): number {
  const c = isPlainObject(controller) ? controller['capsule'] : undefined;
  const o = isPlainObject(c) && Array.isArray(c['offset']) ? (c['offset'] as unknown[]) : [];
  return typeof o[2] === 'number' && Number.isFinite(o[2]) ? o[2] : 0;
}

/** Phase 14.0: the capsule a controller component describes (the default when it has none). */
export function controllerCapsuleOf(controller: unknown): { radius: number; height: number; offset: [number, number] } {
  const c = isPlainObject(controller) ? controller['capsule'] : undefined;
  if (!isPlainObject(c)) return { radius: DEFAULT_CONTROLLER_CAPSULE.radius, height: DEFAULT_CONTROLLER_CAPSULE.height, offset: [0, 0] };
  const o = Array.isArray(c['offset']) ? (c['offset'] as unknown[]) : [0, 0];
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    radius: num(c['radius'], DEFAULT_CONTROLLER_CAPSULE.radius),
    height: num(c['height'], DEFAULT_CONTROLLER_CAPSULE.height),
    offset: [num(o[0], 0), num(o[1], 0)],
  };
}

/**
 * Phase 15.3: the character's movement tuning when a controller carries none —
 * exactly the values every project played with before they became data (the
 * packet-32 contract constants; recorded replays stay valid). Generic
 * reasons: 40 / 60 m/s² reach a 4 m/s run in 0.1 s and stop in under 0.07 s
 * (responsive but not instant, any walking character); 0.05 s coyote time
 * and a 1/15 s (8 steps at 120 Hz) jump buffer are the usual few-frame
 * forgiveness windows; releasing jump early keeps half the upward speed
 * (variable jump height); a 0.1 m ground snap holds a walker on gentle
 * slopes and small bumps; the 0.01 m skin is the physics gap that keeps the
 * character from resting exactly on surfaces; autostep is off (a platformer
 * climbs by jumping) and climbs 0.25 m (above a 0.18 m stair step) when on.
 */
export const DEFAULT_CONTROLLER_TUNING: Readonly<{
  acceleration: number;
  deceleration: number;
  coyoteTime: number;
  jumpBuffer: number;
  jumpRelease: number;
  groundSnap: number;
  skin: number;
  autostep: boolean;
  autostepHeight: number;
}> = Object.freeze({
  acceleration: 40,
  deceleration: 60,
  coyoteTime: 0.05,
  jumpBuffer: 8 / 120,
  jumpRelease: 0.5,
  groundSnap: 0.1,
  skin: 0.01,
  autostep: false,
  autostepHeight: 0.25,
});

type TuningNumberKey = 'acceleration' | 'deceleration' | 'coyoteTime' | 'jumpBuffer' | 'jumpRelease' | 'groundSnap' | 'skin' | 'autostepHeight';

/** Phase 15.3: the tuning ranges — wide enough for any character, narrow enough to keep the solver and the step counters sane. */
export const CONTROLLER_TUNING_LIMITS: Readonly<Record<TuningNumberKey, { readonly min: number; readonly max: number }>> = Object.freeze({
  acceleration: { min: 0.1, max: 1000 },
  deceleration: { min: 0.1, max: 1000 },
  coyoteTime: { min: 0, max: 1 },
  jumpBuffer: { min: 0, max: 1 },
  jumpRelease: { min: 0, max: 1 },
  groundSnap: { min: 0, max: 1 },
  skin: { min: 0.001, max: 0.1 },
  autostepHeight: { min: 0.01, max: 2 },
});

/** Phase 15.3: the controller's tuning fields, in canonical order. */
export const CONTROLLER_TUNING_FIELDS = ['acceleration', 'deceleration', 'coyoteTime', 'jumpBuffer', 'jumpRelease', 'groundSnap', 'skin', 'autostep', 'autostepHeight'] as const;
/** Every v4 controller field, in canonical order. */
export const CONTROLLER_FIELDS: readonly string[] = ['capsule', ...CONTROLLER_TUNING_FIELDS];

/** Phase 15.3: the tuning a controller component describes (each absent field at its default). */
export function controllerTuningOf(controller: unknown): { -readonly [K in keyof typeof DEFAULT_CONTROLLER_TUNING]: (typeof DEFAULT_CONTROLLER_TUNING)[K] } {
  const c = isPlainObject(controller) ? controller : {};
  const d = DEFAULT_CONTROLLER_TUNING;
  const num = (k: TuningNumberKey): number => {
    const v = c[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d[k];
  };
  return {
    acceleration: num('acceleration'),
    deceleration: num('deceleration'),
    coyoteTime: num('coyoteTime'),
    jumpBuffer: num('jumpBuffer'),
    jumpRelease: num('jumpRelease'),
    groundSnap: num('groundSnap'),
    skin: num('skin'),
    autostep: typeof c['autostep'] === 'boolean' ? (c['autostep'] as boolean) : d.autostep,
    autostepHeight: num('autostepHeight'),
  };
}

/** Phase 14.0/15.3: the canonical controller, rebuilt field by field (the capsule's radius, height and optional offset, then the tuning fields present). */
export function canonicalController(controller: unknown): ControllerComponent {
  const src = isPlainObject(controller) ? controller : {};
  const c = src['capsule'];
  const out: Record<string, unknown> = {};
  if (isPlainObject(c)) {
    const o = c['offset'];
    out['capsule'] = {
      radius: c['radius'] as number,
      height: c['height'] as number,
      ...(Array.isArray(o) ? { offset: (o.length === 3 ? [o[0] as number, o[1] as number, o[2] as number] : [o[0] as number, o[1] as number]) as [number, number] } : {}),
    };
  }
  for (const k of CONTROLLER_TUNING_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  return out as ControllerComponent;
}

export function validateControllerComponent(c: unknown, path: string, errors: ModelErrorV2[], version: 2 | 3 | 4 = 2): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const k of Object.keys(c)) {
    if (CONTROLLER_FIELDS.includes(k) && version === 4) continue;
    errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, version === 4 ? CONTROLLER_FIELDS.join(', ') : '{} (no fields before v4)'));
  }
  if (version !== 4) return;
  // Phase 15.3: the movement tuning.
  for (const [key, lim] of Object.entries(CONTROLLER_TUNING_LIMITS)) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max) {
      errors.push(fieldValue(`${path}/${key}`, v, `a number ${lim.min}-${lim.max}`, `controller ${key} must be ${lim.min}-${lim.max}`));
    }
  }
  if (c['autostep'] !== undefined && typeof c['autostep'] !== 'boolean') errors.push(fieldType(`${path}/autostep`, c['autostep'], 'boolean'));
  const capsule = c['capsule'];
  if (capsule === undefined) return;
  const cp = `${path}/capsule`;
  if (!isPlainObject(capsule)) {
    errors.push(fieldType(cp, capsule, 'object { radius, height, offset? }'));
    return;
  }
  for (const k of Object.keys(capsule)) {
    if (k !== 'radius' && k !== 'height' && k !== 'offset') errors.push(unexpectedField(`${cp}/${pointerSegment(k)}`, k, 'radius, height, offset'));
  }
  const L = CAPSULE_LIMITS;
  const range = (key: 'radius' | 'height', min: number, max: number): number | null => {
    const v = capsule[key];
    if (v === undefined) {
      errors.push(fieldMissing(`${cp}/${key}`, key));
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      errors.push(fieldValue(`${cp}/${key}`, v, `a number ${min}-${max} (m)`, `capsule ${key} must be ${min}-${max} m`));
      return null;
    }
    return v;
  };
  const radius = range('radius', L.minRadius, L.maxRadius);
  const height = range('height', L.minHeight, L.maxHeight);
  if (radius !== null && height !== null && height < 2 * radius) {
    errors.push(fieldValue(`${cp}/height`, height, `>= 2 x radius (${2 * radius})`, 'the capsule height includes both end caps, so it is at least twice the radius'));
  }
  const offset = capsule['offset'];
  if (offset !== undefined) {
    // Phase 23.0: an optional third component (z) for a 3D project; a 2D plane ignores it.
    const ok = Array.isArray(offset) && (offset.length === 2 || offset.length === 3) && offset.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= L.maxOffset);
    if (!ok) errors.push(fieldValue(`${cp}/offset`, offset, `[x, y] or [x, y, z], each within ±${L.maxOffset} m`, 'capsule offset is [x, y] (or [x, y, z]) in metres from the entity origin'));
  }
}

// ---- component registry, conflicts, physics transforms -----------------------

function effectiveTransform(comps: Record<string, unknown>): TransformComponent {
  return canonicalTransform(comps['transform']);
}

export function validatePhysicsTransform(
  comps: Record<string, unknown>,
  parentId: unknown,
  path: string,
  hasController: boolean,
  errors: ModelErrorV2[],
  /**
   * Phase 23.0: `false` defers the rotation rules to the project level
   * (`physicsRotationErrors` with the project's `physics_dimension`), so a v4
   * scene's collider may turn freely in a 3D project. v2/v3 documents (2D
   * only) keep the rules here.
   */
  checkRotation = true,
  /**
   * Phase 23.1: `false` defers the scale rule to the project level too
   * (`physicsScaleErrors`): a 3D collider may be scaled where its shape can
   * take it. Defaults to `checkRotation` (v4 defers both).
   */
  checkScale = checkRotation,
): void {
  const t = effectiveTransform(comps);
  if (typeof parentId === 'string') {
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}`,
          message: 'a physics-bearing entity must be a root (parentId absent or null)',
          reason: 'parented',
          expected: 'parentId absent or null',
        },
        parentId,
      ),
    );
  }
  if (checkScale) physicsScaleErrors(comps, path, hasController, 2, errors);
  if (checkRotation) physicsRotationErrors(comps, path, hasController, 2, errors);
}

/**
 * Phase 23.1: the scale rule of a physics-bearing entity for the project's
 * physics dimension. A 2D plane (and every controller): unit scale, as
 * before. 3D: a box, hull or mesh collider takes any positive scale per axis
 * (applied to its shape along the entity's axes), a sphere or capsule a
 * positive uniform one (a non-uniformly scaled sphere is no sphere).
 */
export function physicsScaleErrors(comps: Record<string, unknown>, path: string, hasController: boolean, dimension: 2 | 3, errors: ModelErrorV2[]): void {
  const t = effectiveTransform(comps);
  const [sx, sy, sz] = t.scale;
  if (sx === 1 && sy === 1 && sz === 1) return;
  const shape = isPlainObject(comps['collider']) ? (comps['collider'] as Record<string, unknown>)['shape'] : undefined;
  const type = isPlainObject(shape) ? shape['type'] : undefined;
  if (dimension === 3 && !hasController) {
    const round = type === 'sphere' || type === 'capsule';
    const positive = sx > 0 && sy > 0 && sz > 0;
    if (positive && (!round || (sx === sy && sy === sz))) return;
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}/transform/scale`,
          message: round ? `a ${String(type)} collider takes a positive uniform scale [s, s, s]` : 'a collider takes a positive scale on every axis',
          reason: 'scale',
          expected: round ? '[s, s, s], s > 0' : '[x, y, z], each > 0',
        },
        t.scale,
      ),
    );
    return;
  }
  errors.push(
    withFound(
      {
        code: 'physics_transform_unsupported',
        path: `${path}/transform/scale`,
        message: 'a physics-bearing entity must be at unit scale [1, 1, 1]',
        reason: 'scale',
        expected: '[1, 1, 1]',
      },
      t.scale,
    ),
  );
}

/**
 * Phase 23.0: the rotation rules of a physics-bearing entity for the
 * project's physics dimension. A 2D-plane project (2): rotated about Z only
 * and the controller upright (identity) — the rules every project had
 * before. A 3D project (3): a collider takes any rotation; the controller
 * stays upright (identity: the capsule stands along Y; turning the
 * character is phase 23.2).
 */
export function physicsRotationErrors(comps: Record<string, unknown>, path: string, hasController: boolean, dimension: 2 | 3, errors: ModelErrorV2[]): void {
  const t = effectiveTransform(comps);
  const [qx, qy, qz, qw] = t.rotation;
  if (dimension === 3) {
    if (hasController && !(qx === 0 && qy === 0 && qz === 0 && qw === 1)) {
      errors.push(
        withFound(
          {
            code: 'physics_transform_unsupported',
            path: `${path}/transform/rotation`,
            message: 'the controller entity must be upright (identity rotation)',
            reason: 'upright',
            expected: '[0, 0, 0, 1]',
          },
          t.rotation,
        ),
      );
    }
    return;
  }
  const zOnly = Math.abs(qx) <= 1e-6 && Math.abs(qy) <= 1e-6;
  if (!zOnly) {
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}/transform/rotation`,
          message: 'a physics-bearing entity may be rotated about the Z axis only',
          reason: 'rotation',
          expected: '[x, y, z, w] with |x| <= 1e-6 and |y| <= 1e-6',
        },
        t.rotation,
      ),
    );
  } else if (hasController && !(qz === 0 && qw === 1)) {
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}/transform/rotation`,
          message: 'the controller entity must be upright (identity rotation)',
          reason: 'upright',
          expected: '[0, 0, 0, 1]',
        },
        t.rotation,
      ),
    );
  }
}

/** `transform` field validation for the v2 registry (identical rules to §10.1). */
export function validateTransformV2(t: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(t)) {
    errors.push(fieldType(path, t, 'object'));
    return;
  }
  checkVector(t['position'], `${path}/position`, 3, { absMax: MAX_LEN }, `each |v| <= ${MAX_LEN} meters`, errors);
  checkQuaternion(t['rotation'], `${path}/rotation`, errors);
  checkVector(t['scale'], `${path}/scale`, 3, { positive: true, absMax: MAX_LEN }, `each 0 < v <= ${MAX_LEN}`, errors);
  for (const k of Object.keys(t)) {
    if (!KNOWN_TRANSFORM_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'position, rotation, scale'));
  }
}

export function validateBoxV2(b: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(b)) {
    errors.push(fieldType(path, b, 'object'));
    return;
  }
  checkVector(b['size'], `${path}/size`, 3, { positive: true, absMax: MAX_LEN }, `each 0 < v <= ${MAX_LEN} meters`, errors);
  const mat = b['material'];
  if (mat !== undefined) {
    if (!isPlainObject(mat)) {
      errors.push(fieldType(`${path}/material`, mat, 'object'));
    } else {
      const color = mat['color'];
      if (color !== undefined) {
        if (typeof color !== 'string') errors.push(fieldType(`${path}/material/color`, color, 'string'));
        else if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          errors.push(
            fieldValue(`${path}/material/color`, color, '#rrggbb (6 hex digits)', 'material color must be #rrggbb (case-insensitive; canonical form is lowercase)'),
          );
        }
      }
      for (const k of Object.keys(mat)) {
        if (!KNOWN_MATERIAL_FIELDS.has(k)) errors.push(unexpectedField(`${path}/material/${pointerSegment(k)}`, k, 'color'));
      }
    }
  }
  validateShadowFlags(b, path, errors);
  for (const k of Object.keys(b)) {
    if (!KNOWN_BOX_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'size, material, castShadow, receiveShadow'));
  }
}

export function validateCameraV2(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const type = c['type'];
  if (type !== undefined) {
    if (typeof type !== 'string') errors.push(fieldType(`${path}/type`, type, 'string'));
    else if (type !== 'perspective') errors.push(fieldValue(`${path}/type`, type, '"perspective" (only M1 value)', 'camera type must be "perspective"'));
  }
  if (c['fovY'] !== undefined) checkFiniteNumber(c['fovY'], `${path}/fovY`, { positive: true, maxExcl: 180 }, '0 < v < 180 degrees', errors);
  const near = c['near'];
  if (near !== undefined) checkFiniteNumber(near, `${path}/near`, { positive: true, absMax: MAX_LEN }, `0 < v <= ${MAX_LEN} meters`, errors);
  const effectiveNear = typeof near === 'number' && Number.isFinite(near) ? (near as number) : 0.1;
  if (c['far'] !== undefined) checkFiniteNumber(c['far'], `${path}/far`, { minExcl: effectiveNear, absMax: MAX_LEN }, `near < v <= ${MAX_LEN} meters`, errors);
  for (const k of Object.keys(c)) {
    if (!KNOWN_CAMERA_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, fovY, near, far'));
  }
}

// ---- canonicalization (§12.2) -------------------------------------------------

function canonNum(v: unknown): number {
  const n = v as number;
  return n === 0 ? 0 : n;
}

export function canonicalCollider(c: unknown): ColliderShape {
  const o = c as Record<string, unknown>;
  const shape = o['shape'] as Record<string, unknown>;
  if (shape['type'] === 'box') {
    return { type: 'box', hx: canonNum(shape['hx']), hy: canonNum(shape['hy']), ...(shape['hz'] !== undefined ? { hz: canonNum(shape['hz']) } : {}) };
  }
  // Phase 23.1: the 3D shapes.
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
