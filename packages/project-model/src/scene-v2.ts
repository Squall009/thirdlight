/**
 * schemaVersion 2 logical scene validation — project-model.md §10.5–§10.8,
 * §12.2/§12.3, §21 (physics components and transform rules).
 *
 * `validateSceneV2` is the explicitly versioned M2 scene validator used by
 * `validateProjectV2` (the v2 active-workspace composition). The M1
 * standalone interchange entry points (`validateScene`/`parseScene`) stay
 * pinned to schemaVersion 1 (§8); see errors.ts for the recorded
 * contract/packet tension (handoff 20, C20-1).
 *
 * Pure and total: same input → same result, never throws, never reads files.
 */

import {
  checkFiniteNumber,
  checkHierarchyCycles,
  checkDepthLimit,
  checkQuaternion,
  checkVector,
  canonicalBox,
  canonicalCamera,
  canonicalTransform,
  fail,
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isKnownVersion,
  isPlainObject,
  isValidName,
  MAX_LEN,
  MAX_REVISION,
  NAME_MAX,
  NAME_MIN,
  pointerSegment,
  schemaVersionUnsupported,
  unexpectedField,
  withFound,
} from './validate';
import {
  SCHEMA_VERSIONS_BY_DOCUMENT,
  type ModelError,
  type ModelErrorV2,
  type ModelResultV2,
} from './errors';
import type {
  BoxComponent,
  CameraComponent,
  ColliderShape,
  EntityComponentsV2,
  EntityV2,
  ModelComponent,
  PrefabProvenanceComponent,
  PropertyValue,
  SceneV2,
  TransformComponent,
} from './types-v2';

export const ID_RE_V2 = /^[a-z0-9][a-z0-9_-]{0,63}$/; // §5.1
export const PROPERTY_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/; // §20.5

export const MAX_ENTITIES_V2 = 1024; // §10.4
export const MAX_DEPTH_V2 = 32; // §10.4
export const MAX_COLLIDERS = 256; // §10.7
export const MAX_POLYGON_VERTICES = 8; // §10.7
export const MAX_POLYGON_VERTICES_TOTAL = 1024; // §10.7
export const MAX_COLLIDER_EXTENT = 64; // §10.7
export const MIN_POLYGON_AREA = 1e-6; // §10.7
export const CONVEX_TOL = 1e-9; // §10.7

/** The v2 component registry in canonical order (§21.1). */
export const V2_REGISTRY = [
  'transform',
  'model',
  'box',
  'camera',
  'behavior',
  'prefab',
  'collider',
  'controller',
] as const;
export type ComponentV2 = (typeof V2_REGISTRY)[number];

const KNOWN_SCENE_FIELDS = new Set(['schemaVersion', 'sceneId', 'revision', 'entities']);
const KNOWN_ENTITY_FIELDS = new Set(['id', 'name', 'parentId', 'components']);
const KNOWN_MODEL_FIELDS = new Set(['asset']);
const KNOWN_MODEL_ASSET_FIELDS = new Set(['assetId']);
const KNOWN_BEHAVIOR_FIELDS = new Set(['behaviorId', 'values']);
const KNOWN_PREFAB_FIELDS = new Set(['prefabId', 'localId']);
const KNOWN_COLLIDER_FIELDS = new Set(['shape']);
const KNOWN_BOX_SHAPE_FIELDS = new Set(['type', 'hx', 'hy']);
const KNOWN_POLYGON_SHAPE_FIELDS = new Set(['type', 'vertices']);
const KNOWN_TRANSFORM_FIELDS = new Set(['position', 'rotation', 'scale']);
const KNOWN_BOX_FIELDS = new Set(['size', 'material']);
const KNOWN_MATERIAL_FIELDS = new Set(['color']);
const KNOWN_CAMERA_FIELDS = new Set(['type', 'fovY', 'near', 'far']);

// ---- small helpers -----------------------------------------------------------

function v2ComponentUnknown(path: string, key: string): ModelErrorV2 {
  return withFound(
    {
      code: 'component_unknown',
      path,
      message: 'component is not in the schemaVersion 2 registry',
      expected: `known component types: ${V2_REGISTRY.join(', ')}`,
      hint: 'adding a component type requires a new schemaVersion (project-model.md §10)',
    },
    key,
  );
}

function collisionConflict(path: string, message: string, found: unknown): ModelErrorV2 {
  return withFound(
    { code: 'component_conflict', path, message, expected: 'at most one of the conflicting components' },
    found,
  );
}

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
  for (const k of Object.keys(c)) {
    if (!KNOWN_MODEL_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'asset'));
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

export function validateControllerComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const k of Object.keys(c)) {
    errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, '{} (no fields in M2)'));
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

export function validateComponentsV2(
  comps: Record<string, unknown>,
  parentId: unknown,
  path: string,
  errors: ModelErrorV2[],
): { colliders: number; polygonVertices: number } {
  for (const k of Object.keys(comps)) {
    if (!(V2_REGISTRY as readonly string[]).includes(k)) {
      errors.push(v2ComponentUnknown(`${path}/${pointerSegment(k)}`, k));
    }
  }
  if (comps['transform'] === undefined) {
    errors.push({
      code: 'component_missing',
      path: `${path}/transform`,
      message: 'every entity requires the transform component',
      expected: 'transform present',
    });
  }
  const structural = (['model', 'box', 'camera'] as const).filter((k) => comps[k] !== undefined);
  for (let i = 0; i < structural.length; i++) {
    for (let j = i + 1; j < structural.length; j++) {
      errors.push(
        collisionConflict(
          path,
          `${structural[i]} and ${structural[j]} are mutually exclusive on one entity`,
          [structural[i], structural[j]],
        ),
      );
    }
  }
  if (comps['collider'] !== undefined && comps['controller'] !== undefined) {
    errors.push(
      collisionConflict(path, 'collider and controller are mutually exclusive on one entity', [
        'collider',
        'controller',
      ]),
    );
  }

  if (comps['transform'] !== undefined) validateTransformV2(comps['transform'], `${path}/transform`, errors);
  if (comps['model'] !== undefined) validateModelComponent(comps['model'], `${path}/model`, errors);
  if (comps['box'] !== undefined) validateBoxV2(comps['box'], `${path}/box`, errors);
  if (comps['camera'] !== undefined) validateCameraV2(comps['camera'], `${path}/camera`, errors);
  if (comps['behavior'] !== undefined) validateBehaviorComponent(comps['behavior'], `${path}/behavior`, errors);
  if (comps['prefab'] !== undefined) {
    validatePrefabProvenance(comps['prefab'], `${path}/prefab`, errors);
  }
  if (comps['collider'] !== undefined) {
    validateColliderComponent(comps['collider'], `${path}/collider`, errors);
  }
  if (comps['controller'] !== undefined) validateControllerComponent(comps['controller'], `${path}/controller`, errors);

  const physicsBearing = comps['collider'] !== undefined || comps['controller'] !== undefined;
  if (physicsBearing) {
    validatePhysicsTransform(comps, parentId, path, comps['controller'] !== undefined, errors);
  }

  let colliders = 0;
  let polygonVertices = 0;
  if (comps['collider'] !== undefined) {
    colliders = 1;
    const shape = isPlainObject(comps['collider']) ? comps['collider']['shape'] : undefined;
    if (isPlainObject(shape) && shape['type'] === 'polygon' && Array.isArray(shape['vertices'])) {
      polygonVertices = shape['vertices'].length;
    }
  }
  return { colliders, polygonVertices };
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
  for (const k of Object.keys(b)) {
    if (!KNOWN_BOX_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'size, material'));
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

// ---- entities and scene -------------------------------------------------------

function validateEntityV2(
  e: unknown,
  idx: number,
  errors: ModelErrorV2[],
  idFirstIndex: Map<string, number>,
): { colliders: number; polygonVertices: number; isController: boolean; isCamera: boolean } {
  const base = `/entities/${idx}`;
  const none = { colliders: 0, polygonVertices: 0, isController: false, isCamera: false };
  if (!isPlainObject(e)) {
    errors.push(fieldType(base, e, 'object'));
    return none;
  }
  const id = e['id'];
  if (id === undefined) {
    errors.push(fieldMissing(`${base}/id`, 'id'));
  } else if (typeof id !== 'string') {
    errors.push(fieldType(`${base}/id`, id, 'string'));
  } else {
    if (!ID_RE_V2.test(id)) errors.push(idInvalid(`${base}/id`, id));
    const first = idFirstIndex.get(id);
    if (first === undefined) idFirstIndex.set(id, idx);
    else {
      errors.push(
        withFound(
          {
            code: 'id_duplicate',
            path: `${base}/id`,
            message: 'entity id is already used by an earlier entity (first occurrence wins)',
            expected: 'a unique entity id within the scene',
          },
          id,
        ),
      );
    }
  }
  const name = e['name'];
  if (name !== undefined) {
    if (typeof name !== 'string') errors.push(fieldType(`${base}/name`, name, 'string'));
    else if (!isValidName(name)) {
      errors.push(
        fieldValue(`${base}/name`, name, `string, ${NAME_MIN}-${NAME_MAX} chars, no control characters`, 'entity name must be 1-128 characters without control characters'),
      );
    }
  }
  const pid = e['parentId'];
  if (pid !== undefined && pid !== null && typeof pid !== 'string') {
    errors.push(fieldType(`${base}/parentId`, pid, 'string or null'));
  }
  const comps = e['components'];
  let counts = none;
  if (comps === undefined) {
    errors.push(fieldMissing(`${base}/components`, 'components'));
  } else if (!isPlainObject(comps)) {
    errors.push(fieldType(`${base}/components`, comps, 'object'));
  } else {
    const r = validateComponentsV2(comps, pid, `${base}/components`, errors);
    counts = {
      colliders: r.colliders,
      polygonVertices: r.polygonVertices,
      isController: comps['controller'] !== undefined,
      isCamera: comps['camera'] !== undefined,
    };
  }
  for (const k of Object.keys(e)) {
    if (!KNOWN_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${base}/${pointerSegment(k)}`, k, 'id, name, parentId, components'));
  }
  return counts;
}

function validateSceneV2Value(doc: Record<string, unknown>): { errors: ModelErrorV2[]; doc?: SceneV2 } {
  const errors: ModelErrorV2[] = [];
  const sceneId = doc['sceneId'];
  if (sceneId === undefined) errors.push(fieldMissing('/sceneId', 'sceneId'));
  else if (typeof sceneId !== 'string') errors.push(fieldType('/sceneId', sceneId, 'string'));
  else if (!ID_RE_V2.test(sceneId)) errors.push(idInvalid('/sceneId', sceneId));

  const revision = doc['revision'];
  if (revision === undefined) errors.push(fieldMissing('/revision', 'revision'));
  else if (typeof revision !== 'number') errors.push(fieldType('/revision', revision, 'integer'));
  else if (!Number.isSafeInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    errors.push(
      withFound(
        {
          code: 'revision_invalid',
          path: '/revision',
          message: 'revision must be an integer in [0, 2^53-1]',
          expected: `integer in [0, ${MAX_REVISION}]`,
        },
        revision,
      ),
    );
  }

  const ents = doc['entities'];
  let entities: unknown[] | null = null;
  if (ents === undefined) errors.push(fieldMissing('/entities', 'entities'));
  else if (!Array.isArray(ents)) errors.push(fieldType('/entities', ents, 'array'));
  else {
    entities = ents;
    if (ents.length > MAX_ENTITIES_V2) {
      errors.push(limitsError('/entities', 'entities', ents.length, MAX_ENTITIES_V2, `scene exceeds the entity limit of ${MAX_ENTITIES_V2}`));
    }
  }

  if (entities !== null) {
    const idFirstIndex = new Map<string, number>();
    let colliders = 0;
    let polygonVerticesTotal = 0;
    let cameras = 0;
    let controllers = 0;
    for (let idx = 0; idx < entities.length; idx++) {
      const r = validateEntityV2(entities[idx], idx, errors, idFirstIndex);
      colliders += r.colliders;
      polygonVerticesTotal += r.polygonVertices;
      if (r.isCamera) cameras += 1;
      if (r.isController) controllers += 1;
    }
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!isPlainObject(e)) continue;
      const pid = e['parentId'];
      if (typeof pid === 'string' && !idFirstIndex.has(pid)) {
        errors.push(
          withFound(
            {
              code: 'reference_missing',
              path: `/entities/${idx}/parentId`,
              message: 'parentId does not reference an existing entity in this scene',
              expected: 'an existing entity id, or null/absent (root)',
            },
            pid,
          ),
        );
      }
    }
    checkHierarchyCycles(entities, idFirstIndex, errors);
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!isPlainObject(e)) continue;
      const pid = e['parentId'];
      if (typeof pid !== 'string') continue;
      const pidx = idFirstIndex.get(pid);
      if (pidx === undefined) continue;
      if (pidx >= idx) {
        errors.push(
          withFound(
            {
              code: 'order_parent_before_child',
              path: `/entities/${idx}/parentId`,
              message: 'an entity must appear before its parent in the entities array',
              expected: 'parent index < child index (parent-before-child order)',
            },
            pid,
          ),
        );
      }
    }
    if (cameras !== 1) {
      errors.push(
        withFound(
          {
            code: 'camera_count_invalid',
            path: '',
            message: 'the scene must contain exactly one entity carrying the camera component',
            expected: 'exactly 1 camera',
          },
          cameras,
        ),
      );
    }
    // §10.8/§21.1: at most one entity carries `controller`. Zero controllers is
    // a document-valid scene (the packet-15/16 v2 scene has none — §17); the
    // runtime config layer reports `config_invalid`/`controller_target` when a
    // character is instantiated without one (physics fixture V19).
    if (controllers > 1) {
      errors.push(
        withFound(
          {
            code: 'controller_count_invalid',
            path: '',
            message: 'a scene must not contain more than one entity carrying the controller component',
            expected: 'at most 1 controller',
          },
          controllers,
        ),
      );
    }
    if (colliders > MAX_COLLIDERS) {
      errors.push(limitsError('/entities', 'colliders', colliders, MAX_COLLIDERS, `scene exceeds the collider limit of ${MAX_COLLIDERS}`));
    }
    if (polygonVerticesTotal > MAX_POLYGON_VERTICES_TOTAL) {
      errors.push(
        limitsError(
          '/entities',
          'collider_vertices_total',
          polygonVerticesTotal,
          MAX_POLYGON_VERTICES_TOTAL,
          `scene exceeds the total polygon-vertex limit of ${MAX_POLYGON_VERTICES_TOTAL}`,
        ),
      );
    }
    checkDepthLimit(entities, idFirstIndex, errors);
  }

  for (const k of Object.keys(doc)) {
    if (!KNOWN_SCENE_FIELDS.has(k)) errors.push(unexpectedField(`/${pointerSegment(k)}`, k, 'schemaVersion, sceneId, revision, entities'));
  }
  if (errors.length > 0) return { errors };
  return { errors, doc: canonicalSceneV2(doc, entities as unknown[]) };
}

// ---- canonicalization (§12.2) -------------------------------------------------

function canonNum(v: unknown): number {
  const n = v as number;
  return n === 0 ? 0 : n;
}

function canonicalModel(c: unknown): ModelComponent {
  const o = c as Record<string, unknown>;
  const asset = o['asset'] as Record<string, unknown>;
  return { asset: { assetId: asset['assetId'] as string } };
}

function canonicalBehaviorComponent(c: unknown): { behaviorId: string; values: Record<string, PropertyValue> } {
  const o = c as Record<string, unknown>;
  const values = o['values'] as Record<string, unknown>;
  const out: Record<string, PropertyValue> = {};
  for (const k of Object.keys(values)) {
    const v = values[k];
    out[k] = (Array.isArray(v)
      ? [canonNum(v[0]), canonNum(v[1]), canonNum(v[2])]
      : canonNumIfNumber(v)) as PropertyValue;
  }
  return { behaviorId: o['behaviorId'] as string, values: out };
}

function canonNumIfNumber(v: unknown): unknown {
  return typeof v === 'number' ? canonNum(v) : v;
}

function canonicalPrefabProvenance(c: unknown): PrefabProvenanceComponent {
  const o = c as Record<string, unknown>;
  return { prefabId: o['prefabId'] as string, localId: o['localId'] as string };
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

// Keep the M1 canonical helpers imported (transform/box/camera) referenced.

function canonicalEntityV2(e: Record<string, unknown>): EntityV2 {
  const comps = e['components'] as Record<string, unknown>;
  const components: EntityComponentsV2 = {
    transform: canonicalTransform(comps['transform']),
  };
  if (comps['model'] !== undefined) components.model = canonicalModel(comps['model']);
  if (comps['box'] !== undefined) components.box = canonicalBox(comps['box']) as BoxComponent;
  if (comps['camera'] !== undefined) components.camera = canonicalCamera(comps['camera']) as CameraComponent;
  if (comps['behavior'] !== undefined) {
    const b = canonicalBehaviorComponent(comps['behavior']);
    components.behavior = { behaviorId: b.behaviorId, values: b.values };
  }
  if (comps['prefab'] !== undefined) components.prefab = canonicalPrefabProvenance(comps['prefab']);
  if (comps['collider'] !== undefined) components.collider = { shape: canonicalCollider(comps['collider']) };
  if (comps['controller'] !== undefined) components.controller = {};
  const name = e['name'];
  const pid = e['parentId'];
  return {
    id: e['id'] as string,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof pid === 'string' ? { parentId: pid } : {}),
    components,
  };
}

function canonicalSceneV2(doc: Record<string, unknown>, ents: unknown[]): SceneV2 {
  return {
    schemaVersion: 2,
    sceneId: doc['sceneId'] as string,
    revision: canonNum(doc['revision']),
    entities: (ents as Record<string, unknown>[]).map(canonicalEntityV2),
  };
}

// ---- public entry points ------------------------------------------------------

export function validateSceneV2(doc: unknown): ModelResultV2<SceneV2> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  if (!isKnownVersion(doc['schemaVersion'], SCHEMA_VERSIONS_BY_DOCUMENT.scene)) {
    return fail([schemaVersionUnsupported(doc['schemaVersion'], SCHEMA_VERSIONS_BY_DOCUMENT.scene)]);
  }
  if (doc['schemaVersion'] !== 2) {
    // validateSceneV2 is the embedded v2 validator; a schemaVersion-1 value is
    // not a valid v2 document for this entry point.
    return fail([
      fieldValue('/schemaVersion', doc['schemaVersion'], '2', 'validateSceneV2 accepts an embedded schemaVersion 2 scene'),
    ]);
  }
  const { errors, doc: canonical } = validateSceneV2Value(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as SceneV2 };
}

/** §12.1: validate, then return the new canonical v2 document (§12.2). */
export function normalizeSceneV2(doc: unknown): ModelResultV2<SceneV2> {
  return validateSceneV2(doc);
}
