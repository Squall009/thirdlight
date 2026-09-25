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
const KNOWN_BOX_SHAPE_FIELDS = new Set(['type', 'hx', 'hy']);
const KNOWN_POLYGON_SHAPE_FIELDS = new Set(['type', 'vertices']);
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
    for (const k of Object.keys(shape)) {
      if (!KNOWN_BOX_SHAPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, hx, hy'));
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
  errors.push(
    fieldValue(
      `${path}/type`,
      type,
      '"box" | "polygon"',
      'collider shape type must be "box" or "polygon"',
    ),
  );
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
      ...(Array.isArray(o) ? { offset: [o[0] as number, o[1] as number] as [number, number] } : {}),
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
    const ok = Array.isArray(offset) && offset.length === 2 && offset.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= L.maxOffset);
    if (!ok) errors.push(fieldValue(`${cp}/offset`, offset, `[x, y], each within ±${L.maxOffset} m`, 'capsule offset is [x, y] in metres from the entity origin'));
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
  if (!(t.scale[0] === 1 && t.scale[1] === 1 && t.scale[2] === 1)) {
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
  const [qx, qy, qz, qw] = t.rotation;
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
    return { type: 'box', hx: canonNum(shape['hx']), hy: canonNum(shape['hy']) };
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
