/**
 * schemaVersion 3 logical scene validation and canonicalization —
 * project-model.md §23.3–§23.8/§23.10, extending the accepted §12.2/§12.3
 * scene rules with the six appended components.
 *
 * `validateSceneV3`/`normalizeSceneV3` are the explicitly versioned v3 scene
 * entry points (`workspace.md` §16.9; `project-model.md` §12.1). They perform
 * the SCENE-LOCAL rules only: registry and combinations, per-component field
 * values, the `modelAnimation` container, counts/limits, the `gameZone`/
 * `playerSpawn` transform rules and checkpoint `safeSpawnId` resolution.
 * Rules that need `content.game` or `content.assets` — the goal count, the
 * `game.*Id` naming rules, cue/animation asset resolution and the accepted
 * v2 cross-block checks — run in `validateProjectV3`/`validateEnvelopeV3`
 * (§23.8 steps 5–6).
 *
 * The accepted v2 component validators are reused verbatim (no v2 component
 * is renumbered or reinterpreted; §23.3). Pure and total: same input → same
 * result, never throws, never reads files.
 */

import {
  canonicalBox,
  canonicalCamera,
  canonicalTransform,
  canonNum,
  checkDepthLimit,
  checkFiniteNumber,
  checkHierarchyCycles,
  fail,
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isKnownVersion,
  isPlainObject,
  isValidName,
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
  type ModelErrorV3,
  type ModelResultV3,
} from './errors';
import {
  canonicalCollider,
  ID_RE_V2,
  MAX_COLLIDERS,
  MAX_ENTITIES_V2,
  MAX_POLYGON_VERTICES_TOTAL,
  validateBehaviorComponent,
  validateBoxV2,
  validateCameraV2,
  validateColliderComponent,
  validateControllerComponent,
  validateModelComponent,
  validatePhysicsTransform,
  validatePrefabProvenance,
  validateTransformV2,
} from './scene-v2';
import type {
  BoxComponent,
  CameraComponent,
  ModelComponent,
  PrefabProvenanceComponent,
  PropertyValue,
} from './types-v2';
import {
  GAME_ZONE_LIMITS,
  GAME_ZONE_ROLES,
  V3_REGISTRY,
  type CameraFollowComponent,
  type CheckpointActivationAppearance,
  type EntityComponentsV3,
  type EntityV3,
  type GameZoneComponent,
  type GameZoneRole,
  type LightComponent,
  type ModelAnimationComponent,
  type SceneV3,
  type SurfaceComponent,
  type SceneEntityV3,
  type SceneV4,
  isFolderEntity,
  GAME_ZONE_ROLES_V4,
  MAX_INSTANCES,
} from './types-v3';
import { effectiveEntityFlags, nearestObjectAncestor } from './hierarchy-v3';

export const COLOR_RE_V3 = /^#[0-9a-fA-F]{6}$/; // §23.3.1a/§23.3.4/§23.3.5
export const MAX_ABS_V3 = 1e6; // §23.10 numbers bound
export const MAX_INTENSITY = 8; // §23.3.4
export const MAX_EMISSIVE_INTENSITY = 4; // §23.3.1a/§23.3.5
export const MAX_ZONE_SPAN = 1e6; // §23.3.1 size bound
export const MIN_BOUND_SPAN = 1e-6; // §23.3.3 bounds span
export const MIN_DIRECTION_NORM = 1e-6; // §23.3.4
export const SURFACE_DEFAULTS = Object.freeze({
  color: '#b0b0b0',
  roughness: 0.9,
  metalness: 0,
  emissive: '#000000',
  emissiveIntensity: 0,
});

const KNOWN_SCENE_FIELDS = new Set(['schemaVersion', 'sceneId', 'revision', 'entities']);
const KNOWN_SCENE_FIELDS_V4 = new Set(['schemaVersion', 'sceneId', 'name', 'revision', 'entities']);
/** Phase 12 (c): the v4 per-scene entity cap (instance sets hold dense detail). */
export const MAX_ENTITIES_V4 = 16_384;
const KNOWN_ENTITY_FIELDS = new Set(['id', 'name', 'parentId', 'active', 'locked', 'static', 'tags', 'components']);
const ENTITY_FLAGS = ['active', 'locked', 'static'] as const;
const KNOWN_GAMEZONE_FIELDS = new Set(['role', 'size', 'safeSpawnId', 'activation']);
const KNOWN_GAMEZONE_FIELDS_V4 = new Set(['role', 'size', 'safeSpawnId', 'activation', 'load', 'unload', 'spawnId']);
/** Phase 12 (c): at most this many scene ids in one exit's load or unload list. */
export const MAX_EXIT_SCENES = 16;
/** Phase 12 (c): the v4 component registry (v3's plus `instances`). */
export const V4_REGISTRY: readonly string[] = [...V3_REGISTRY, 'instances'];
const KNOWN_ACTIVATION_FIELDS = new Set(['emissive', 'emissiveIntensity', 'cueAssetId']);
const KNOWN_CAMERA_FOLLOW_FIELDS = new Set(['deadZone', 'smoothing', 'bounds']);
const KNOWN_DEADZONE_FIELDS = new Set(['x', 'y']);
const KNOWN_BOUNDS_FIELDS = new Set(['minX', 'maxX', 'minY', 'maxY']);
const KNOWN_LIGHT_FIELDS = new Set(['type', 'color', 'intensity', 'direction', 'castShadow']);
const KNOWN_SURFACE_FIELDS = new Set(['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity']);
const KNOWN_MODEL_ANIMATION_FIELDS = new Set(['assetId', 'version', 'roles']);
const ROLE_KEYS = ['idle', 'run', 'airborne'] as const;

// ---- small helpers -----------------------------------------------------------

function v3ComponentUnknown(path: string, key: string): ModelErrorV3 {
  return withFound(
    {
      code: 'component_unknown',
      path,
      message: 'component is not in the schemaVersion 3 registry',
      expected: `known component types: ${V3_REGISTRY.join(', ')}`,
      hint: 'adding a component type requires a new schemaVersion (project-model.md §23.3)',
    },
    key,
  );
}

function collisionConflict(path: string, message: string, found: unknown): ModelErrorV3 {
  return withFound(
    { code: 'component_conflict', path, message, expected: 'at most one of the conflicting components' },
    found,
  );
}

function limitsError(
  path: string,
  limit: NonNullable<ModelErrorV3['limit']>,
  current: number,
  max: number,
  message: string,
): ModelErrorV3 {
  return withFound(
    { code: 'limits_exceeded', path, message, limit, current, max, expected: `<= ${max}` },
    current,
  );
}

function componentMissing(path: string, expected: string, message: string): ModelErrorV3 {
  return { code: 'component_missing', path, message, expected };
}

function optionalColor(v: unknown, path: string, dflt: string, errors: ModelErrorV3[]): void {
  if (v === undefined) return; // defaulted on normalize (§23.7)
  if (typeof v !== 'string') {
    errors.push(fieldType(path, v, 'string'));
    return;
  }
  if (!COLOR_RE_V3.test(v)) {
    errors.push(
      fieldValue(path, v, '#rrggbb (6 hex digits)', 'color must be #rrggbb (case-insensitive; canonical form is lowercase)'),
    );
  }
}

// ---- the six v3 components ---------------------------------------------------

export function validateActivationAppearance(a: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(a)) {
    errors.push(fieldType(path, a, 'object'));
    return;
  }
  const emissive = a['emissive'];
  if (emissive === undefined) errors.push(fieldMissing(`${path}/emissive`, 'emissive'));
  else if (typeof emissive !== 'string') errors.push(fieldType(`${path}/emissive`, emissive, 'string'));
  else if (!COLOR_RE_V3.test(emissive)) {
    errors.push(fieldValue(`${path}/emissive`, emissive, '#rrggbb (6 hex digits)', 'activation emissive must be #rrggbb'));
  }
  if (a['emissiveIntensity'] === undefined) errors.push(fieldMissing(`${path}/emissiveIntensity`, 'emissiveIntensity'));
  else {
    checkFiniteNumber(
      a['emissiveIntensity'],
      `${path}/emissiveIntensity`,
      { absMax: MAX_EMISSIVE_INTENSITY },
      `0 <= v <= ${MAX_EMISSIVE_INTENSITY}`,
      errors,
    );
  }
  const cue = a['cueAssetId'];
  if (cue === undefined) errors.push(fieldMissing(`${path}/cueAssetId`, 'cueAssetId'));
  else if (cue !== null) {
    if (typeof cue !== 'string') errors.push(fieldType(`${path}/cueAssetId`, cue, 'string or null'));
    else if (!ID_RE_V2.test(cue)) errors.push(idInvalid(`${path}/cueAssetId`, cue));
  }
  for (const k of Object.keys(a)) {
    if (!KNOWN_ACTIVATION_FIELDS.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'emissive, emissiveIntensity, cueAssetId'));
    }
  }
}

export function validateGameZoneComponent(c: unknown, path: string, errors: ModelErrorV3[], version: 3 | 4 = 3): GameZoneRole | null {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return null;
  }
  let role: GameZoneRole | null = null;
  const roles: readonly string[] = version === 4 ? GAME_ZONE_ROLES_V4 : GAME_ZONE_ROLES;
  const rawRole = c['role'];
  if (rawRole === undefined) errors.push(fieldMissing(`${path}/role`, 'role'));
  else if (typeof rawRole !== 'string') errors.push(fieldType(`${path}/role`, rawRole, 'string'));
  else if (!roles.includes(rawRole)) {
    errors.push(
      fieldValue(`${path}/role`, rawRole, roles.map((r) => `"${r}"`).join(' | '), `gameZone role must be one of ${roles.join(', ')}`),
    );
  } else {
    role = rawRole as GameZoneRole;
  }
  const size = c['size'];
  if (size === undefined) errors.push(fieldMissing(`${path}/size`, 'size'));
  else if (!Array.isArray(size)) errors.push(fieldType(`${path}/size`, size, 'array of 2 finite numbers'));
  else if (size.length !== 2) {
    errors.push(fieldValue(`${path}/size`, size.length, 'array of exactly 2 numbers', 'zone size is [widthX, heightY]'));
  } else {
    for (let j = 0; j < 2; j++) {
      checkFiniteNumber(size[j], `${path}/size/${j}`, { positive: true, absMax: MAX_ZONE_SPAN }, `each 0 < v <= ${MAX_ZONE_SPAN} meters`, errors);
    }
  }
  if (role === 'checkpoint') {
    const safe = c['safeSpawnId'];
    if (safe === undefined) errors.push(fieldMissing(`${path}/safeSpawnId`, 'safeSpawnId'));
    else if (typeof safe !== 'string') errors.push(fieldType(`${path}/safeSpawnId`, safe, 'string'));
    else if (!ID_RE_V2.test(safe)) errors.push(idInvalid(`${path}/safeSpawnId`, safe));
    if (c['activation'] === undefined) errors.push(fieldMissing(`${path}/activation`, 'activation'));
    else validateActivationAppearance(c['activation'], `${path}/activation`, errors);
  } else {
    if (c['safeSpawnId'] !== undefined) {
      errors.push(unexpectedField(`${path}/safeSpawnId`, 'safeSpawnId', 'nothing (only a checkpoint carries safeSpawnId)'));
    }
    if (c['activation'] !== undefined) {
      errors.push(unexpectedField(`${path}/activation`, 'activation', 'nothing (only a checkpoint carries activation)'));
    }
  }
  if (role === 'exit') {
    // Phase 12 (c): the scenes to load / unload (ids resolve at project level).
    let listed = 0;
    for (const key of ['load', 'unload'] as const) {
      const list = c[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        errors.push(fieldType(`${path}/${key}`, list, 'array of scene ids'));
        continue;
      }
      if (list.length > MAX_EXIT_SCENES) errors.push(fieldValue(`${path}/${key}`, list.length, `at most ${MAX_EXIT_SCENES} scene ids`, 'too many scenes in one exit'));
      list.forEach((id, i) => {
        if (typeof id !== 'string') errors.push(fieldType(`${path}/${key}/${i}`, id, 'string (scene id)'));
        else if (!ID_RE_V2.test(id)) errors.push(idInvalid(`${path}/${key}/${i}`, id));
      });
      if (new Set(list).size !== list.length) errors.push(fieldValue(`${path}/${key}`, list, 'distinct scene ids', 'a scene is listed twice'));
      listed += list.length;
    }
    if (listed === 0) {
      errors.push(fieldMissing(`${path}/load`, 'load or unload (an exit loads or unloads at least one scene)'));
    }
    const spawn = c['spawnId'];
    if (spawn !== undefined) {
      if (typeof spawn !== 'string') errors.push(fieldType(`${path}/spawnId`, spawn, 'string'));
      else if (!ID_RE_V2.test(spawn)) errors.push(idInvalid(`${path}/spawnId`, spawn));
    }
  } else {
    for (const key of ['load', 'unload', 'spawnId'] as const) {
      if (c[key] !== undefined) errors.push(unexpectedField(`${path}/${key}`, key, 'nothing (only an exit zone carries load, unload, spawnId)'));
    }
  }
  const known = version === 4 ? KNOWN_GAMEZONE_FIELDS_V4 : KNOWN_GAMEZONE_FIELDS;
  for (const k of Object.keys(c)) {
    if (!known.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...known].join(', ')));
    }
  }
  return role;
}

/**
 * Phase 12 (c): an instance set — one model, `count` placements in a binary
 * buffer stored by SHA-256 (asset and buffer existence are checked against
 * the content block and the blob store elsewhere).
 */
export function validateInstancesComponent(c: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const asset = c['asset'];
  if (asset === undefined) errors.push(fieldMissing(`${path}/asset`, 'asset'));
  else if (!isPlainObject(asset)) errors.push(fieldType(`${path}/asset`, asset, 'object { assetId }'));
  else {
    const id = asset['assetId'];
    if (typeof id !== 'string') errors.push(fieldType(`${path}/asset/assetId`, id, 'string'));
    else if (!ID_RE_V2.test(id)) errors.push(idInvalid(`${path}/asset/assetId`, id));
    for (const k of Object.keys(asset)) if (k !== 'assetId') errors.push(unexpectedField(`${path}/asset/${pointerSegment(k)}`, k, 'assetId'));
  }
  const buffer = c['buffer'];
  if (buffer === undefined) errors.push(fieldMissing(`${path}/buffer`, 'buffer'));
  else if (typeof buffer !== 'string' || !/^[0-9a-f]{64}$/.test(buffer)) {
    errors.push(fieldValue(`${path}/buffer`, buffer, 'SHA-256 of the buffer (64 lowercase hex)', 'buffer is the digest of the instance transforms'));
  }
  const count = c['count'];
  if (count === undefined) errors.push(fieldMissing(`${path}/count`, 'count'));
  else if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_INSTANCES) {
    errors.push(fieldValue(`${path}/count`, count, `integer 1-${MAX_INSTANCES}`, 'an instance set holds 1 to 65536 copies'));
  }
  for (const k of Object.keys(c)) {
    if (k !== 'asset' && k !== 'buffer' && k !== 'count') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'asset, buffer, count'));
  }
}

export function validatePlayerSpawnComponent(c: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const k of Object.keys(c)) {
    errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, '{} (no fields)'));
  }
}

export function validateCameraFollowComponent(c: unknown, path: string, errors: ModelErrorV3[], version: 3 | 4 = 3): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const dz = c['deadZone'];
  if (dz === undefined) errors.push(fieldMissing(`${path}/deadZone`, 'deadZone'));
  else if (!isPlainObject(dz)) errors.push(fieldType(`${path}/deadZone`, dz, 'object'));
  else {
    for (const k of ['x', 'y'] as const) {
      if (dz[k] === undefined) errors.push(fieldMissing(`${path}/deadZone/${k}`, k));
      else checkFiniteNumber(dz[k], `${path}/deadZone/${k}`, { absMax: MAX_ABS_V3 }, `0 <= v <= ${MAX_ABS_V3}`, errors);
    }
    for (const k of Object.keys(dz)) {
      if (!KNOWN_DEADZONE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/deadZone/${pointerSegment(k)}`, k, 'x, y'));
    }
  }
  if (c['smoothing'] === undefined) errors.push(fieldMissing(`${path}/smoothing`, 'smoothing'));
  else checkFiniteNumber(c['smoothing'], `${path}/smoothing`, { absMax: 1 }, '0 <= v <= 1', errors);
  const bounds = c['bounds'];
  // v4: bounds are optional (without them the camera follows anywhere).
  if (bounds === undefined) {
    if (version === 3) errors.push(fieldMissing(`${path}/bounds`, 'bounds'));
  }
  else if (!isPlainObject(bounds)) errors.push(fieldType(`${path}/bounds`, bounds, 'object'));
  else {
    for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) {
      if (bounds[k] === undefined) errors.push(fieldMissing(`${path}/bounds/${k}`, k));
      else checkFiniteNumber(bounds[k], `${path}/bounds/${k}`, { absMax: MAX_ABS_V3 }, `|v| <= ${MAX_ABS_V3}`, errors);
    }
    const minX = bounds['minX'];
    const maxX = bounds['maxX'];
    const minY = bounds['minY'];
    const maxY = bounds['maxY'];
    if (typeof minX === 'number' && typeof maxX === 'number' && Number.isFinite(minX) && Number.isFinite(maxX)) {
      if (!(minX < maxX) || !(maxX - minX >= MIN_BOUND_SPAN)) {
        errors.push(
          fieldValue(`${path}/bounds`, [minX, maxX], `minX < maxX and maxX - minX >= ${MIN_BOUND_SPAN}`, 'cameraFollow bounds must span X'),
        );
      }
    }
    if (typeof minY === 'number' && typeof maxY === 'number' && Number.isFinite(minY) && Number.isFinite(maxY)) {
      if (!(minY < maxY) || !(maxY - minY >= MIN_BOUND_SPAN)) {
        errors.push(
          fieldValue(`${path}/bounds`, [minY, maxY], `minY < maxY and maxY - minY >= ${MIN_BOUND_SPAN}`, 'cameraFollow bounds must span Y'),
        );
      }
    }
    for (const k of Object.keys(bounds)) {
      if (!KNOWN_BOUNDS_FIELDS.has(k)) errors.push(unexpectedField(`${path}/bounds/${pointerSegment(k)}`, k, 'minX, maxX, minY, maxY'));
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_CAMERA_FOLLOW_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'deadZone, smoothing, bounds'));
  }
}

export function validateLightComponent(c: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const type = c['type'];
  let directional = false;
  if (type === undefined) errors.push(fieldMissing(`${path}/type`, 'type'));
  else if (typeof type !== 'string') errors.push(fieldType(`${path}/type`, type, 'string'));
  else if (type !== 'directional' && type !== 'ambient') {
    errors.push(fieldValue(`${path}/type`, type, '"directional" | "ambient"', 'light type must be directional or ambient'));
  } else {
    directional = type === 'directional';
  }
  optionalColor(c['color'], `${path}/color`, 'required', errors);
  if (c['color'] === undefined) errors.push(fieldMissing(`${path}/color`, 'color'));
  if (c['intensity'] === undefined) errors.push(fieldMissing(`${path}/intensity`, 'intensity'));
  else checkFiniteNumber(c['intensity'], `${path}/intensity`, { absMax: MAX_INTENSITY }, `0 <= v <= ${MAX_INTENSITY}`, errors);

  if (type === 'directional') {
    const dir = c['direction'];
    if (dir === undefined) errors.push(fieldMissing(`${path}/direction`, 'direction'));
    else if (!Array.isArray(dir)) errors.push(fieldType(`${path}/direction`, dir, 'array of 3 finite numbers'));
    else if (dir.length !== 3) {
      errors.push(fieldValue(`${path}/direction`, dir.length, 'array of exactly 3 numbers', 'light direction is [x, y, z]'));
    } else {
      for (let j = 0; j < 3; j++) {
        checkFiniteNumber(dir[j], `${path}/direction/${j}`, { absMax: 1 }, `|v| <= 1`, errors);
      }
      if (dir.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        const norm = Math.hypot(dir[0] as number, dir[1] as number, dir[2] as number);
        if (!(norm >= MIN_DIRECTION_NORM)) {
          errors.push(
            withFound(
              { code: 'number_out_of_range', path: `${path}/direction`, message: `direction norm must be >= ${MIN_DIRECTION_NORM}`, expected: `||v|| >= ${MIN_DIRECTION_NORM}` },
              dir,
            ),
          );
        }
      }
    }
    if (c['castShadow'] !== undefined && typeof c['castShadow'] !== 'boolean') {
      errors.push(fieldType(`${path}/castShadow`, c['castShadow'], 'boolean'));
    }
  } else {
    if (c['direction'] !== undefined) {
      errors.push(fieldValue(`${path}/direction`, c['direction'], 'absent on an ambient light', 'only a directional light carries a direction'));
    }
    if (c['castShadow'] !== undefined) {
      errors.push(fieldValue(`${path}/castShadow`, c['castShadow'], 'absent on an ambient light', 'only a directional light casts shadows'));
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_LIGHT_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, color, intensity, direction, castShadow'));
  }
}

export function validateSurfaceComponent(c: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  optionalColor(c['color'], `${path}/color`, SURFACE_DEFAULTS.color, errors);
  for (const k of ['roughness', 'metalness'] as const) {
    if (c[k] === undefined) continue; // §23.7 fills the default
    checkFiniteNumber(c[k], `${path}/${k}`, { absMax: 1 }, '0 <= v <= 1', errors);
  }
  optionalColor(c['emissive'], `${path}/emissive`, SURFACE_DEFAULTS.emissive, errors);
  if (c['emissiveIntensity'] !== undefined) {
    checkFiniteNumber(
      c['emissiveIntensity'],
      `${path}/emissiveIntensity`,
      { absMax: MAX_EMISSIVE_INTENSITY },
      `0 <= v <= ${MAX_EMISSIVE_INTENSITY}`,
      errors,
    );
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_SURFACE_FIELDS.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'color, roughness, metalness, emissive, emissiveIntensity'));
    }
  }
}

export function validateModelAnimationComponent(c: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const assetId = c['assetId'];
  if (assetId === undefined) errors.push(fieldMissing(`${path}/assetId`, 'assetId'));
  else if (typeof assetId !== 'string') errors.push(fieldType(`${path}/assetId`, assetId, 'string'));
  else if (!ID_RE_V2.test(assetId)) errors.push(idInvalid(`${path}/assetId`, assetId));
  const version = c['version'];
  if (version === undefined) errors.push(fieldMissing(`${path}/version`, 'version'));
  else if (typeof version !== 'number') errors.push(fieldType(`${path}/version`, version, 'integer'));
  else if (!Number.isSafeInteger(version) || version < 1) {
    errors.push(
      withFound(
        { code: 'number_out_of_range', path: `${path}/version`, message: 'animation version must be an integer >= 1', expected: 'integer >= 1' },
        version,
      ),
    );
  }
  const roles = c['roles'];
  if (roles === undefined) errors.push(fieldMissing(`${path}/roles`, 'roles'));
  else if (!isPlainObject(roles)) errors.push(fieldType(`${path}/roles`, roles, 'object'));
  else {
    for (const key of ROLE_KEYS) {
      const binding = roles[key];
      if (binding === undefined) {
        errors.push(fieldMissing(`${path}/roles/${key}`, key));
        continue;
      }
      if (!isPlainObject(binding) || Object.keys(binding).length === 0) {
        errors.push(
          withFound(
            { code: 'field_value', path: `${path}/roles/${key}`, message: 'each role binding must be a non-empty JSON object owned by the version', expected: 'non-empty object' },
            binding,
          ),
        );
      }
    }
    for (const k of Object.keys(roles)) {
      if (!(ROLE_KEYS as readonly string[]).includes(k)) {
        errors.push(unexpectedField(`${path}/roles/${pointerSegment(k)}`, k, ROLE_KEYS.join(', ')));
      }
    }
    const bytes = utf8Length(JSON.stringify(roles) ?? '');
    if (bytes > GAME_ZONE_LIMITS.animationProfileBytes) {
      errors.push(
        limitsError(
          `${path}/roles`,
          'animation_profile_bytes',
          bytes,
          GAME_ZONE_LIMITS.animationProfileBytes,
          'canonical role-binding bytes exceed the cap',
        ),
      );
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_MODEL_ANIMATION_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'assetId, version, roles'));
  }
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

// ---- components, conflicts and transforms -----------------------------------

interface EntityV3Counts {
  zones: number;
  checkpointZoneIds: string[];
  spawns: number;
  directional: number;
  ambient: number;
  cameras: number;
  controllers: number;
  colliders: number;
  polygonVertices: number;
}

const EMPTY_COUNTS: EntityV3Counts = {
  zones: 0,
  checkpointZoneIds: [],
  spawns: 0,
  directional: 0,
  ambient: 0,
  cameras: 0,
  controllers: 0,
  colliders: 0,
  polygonVertices: 0,
};

/** §23.3.1/§23.3.2 zone and spawn transform rules (distinct codes). */
function validateZoneSpawnTransform(
  comps: Record<string, unknown>,
  parentId: unknown,
  path: string,
  errors: ModelErrorV3[],
): void {
  const isZone = comps['gameZone'] !== undefined;
  const isSpawn = comps['playerSpawn'] !== undefined;
  if (!isZone && !isSpawn) return;
  const code = isZone ? 'zone_transform_unsupported' : 'spawn_transform_unsupported';
  const bearer = isZone ? 'gameZone' : 'playerSpawn';
  const t = canonicalTransform(comps['transform']);
  if (parentId !== undefined && parentId !== null) {
    errors.push(
      withFound(
        {
          code,
          path: `${path}/parentId`,
          message: `a ${bearer} entity must be a root (parentId absent or null)`,
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
          code,
          path: `${path}/components/transform/scale`,
          message: `a ${bearer} entity must be at unit scale [1, 1, 1]`,
          reason: 'scale',
          expected: '[1, 1, 1]',
        },
        t.scale,
      ),
    );
  }
  if (!(t.rotation[0] === 0 && t.rotation[1] === 0 && t.rotation[2] === 0 && t.rotation[3] === 1)) {
    errors.push(
      withFound(
        {
          code,
          path: `${path}/components/transform/rotation`,
          message: `a ${bearer} entity must have the identity rotation [0, 0, 0, 1]`,
          reason: 'rotation',
          expected: '[0, 0, 0, 1]',
        },
        t.rotation,
      ),
    );
  }
}

/**
 * §23.3 component registry, combinations and per-component values for one
 * entity. Pass 1 (registry + `transform` presence + zone/spawn transforms)
 * and pass 2 (field values) are run together in the accepted order.
 */
function validateEntityComponentsV3(
  comps: Record<string, unknown>,
  parentId: unknown,
  ePath: string,
  errors: ModelErrorV3[],
  version: 3 | 4 = 3,
): EntityV3Counts {
  const path = `${ePath}/components`;
  const registry: readonly string[] = version === 4 ? V4_REGISTRY : V3_REGISTRY;
  for (const k of Object.keys(comps)) {
    if (!registry.includes(k)) {
      errors.push(v3ComponentUnknown(`${path}/${pointerSegment(k)}`, k));
    }
  }
  if (comps['folder'] !== undefined) {
    // Phase 12: a folder is organisation only — no transform, nothing else.
    const folder = comps['folder'];
    if (!isPlainObject(folder)) errors.push(fieldType(`${path}/folder`, folder, 'object'));
    else {
      for (const k of Object.keys(folder)) errors.push(unexpectedField(`${path}/folder/${pointerSegment(k)}`, k, '{} (no fields)'));
    }
    for (const k of Object.keys(comps)) {
      if (k === 'folder' || !registry.includes(k)) continue;
      errors.push(
        withFound(
          {
            code: 'component_conflict',
            path: `${path}/${pointerSegment(k)}`,
            message: 'a folder is organisation only: it carries no transform and no other component',
            reason: 'folder',
            expected: 'components exactly { "folder": {} }',
          },
          k,
        ),
      );
    }
    return { ...EMPTY_COUNTS, checkpointZoneIds: [] };
  }
  if (comps['transform'] === undefined) {
    errors.push({
      code: 'component_missing',
      path: `${path}/transform`,
      message: 'every entity requires the transform component',
      expected: 'transform present',
    });
  }
  // §23.8 step 1: the zone/spawn transform rules (distinct codes per §23.9).
  validateZoneSpawnTransform(comps, parentId, ePath, errors);

  // accepted v2 structural conflicts (+ the v3 conflicts §23.3 adds)
  const structural = (['model', 'box', 'camera'] as const).filter((k) => comps[k] !== undefined);
  for (let i = 0; i < structural.length; i++) {
    for (let j = i + 1; j < structural.length; j++) {
      errors.push(
        collisionConflict(path, `${structural[i]} and ${structural[j]} are mutually exclusive on one entity`, [
          structural[i],
          structural[j],
        ]),
      );
    }
  }
  if (comps['collider'] !== undefined && comps['controller'] !== undefined) {
    errors.push(collisionConflict(path, 'collider and controller are mutually exclusive on one entity', ['collider', 'controller']));
  }

  // accepted v2 registry component values (verbatim rules)
  if (comps['transform'] !== undefined) validateTransformV2(comps['transform'], `${path}/transform`, errors);
  if (comps['model'] !== undefined) validateModelComponent(comps['model'], `${path}/model`, errors);
  if (comps['box'] !== undefined) validateBoxV2(comps['box'], `${path}/box`, errors);
  if (comps['camera'] !== undefined) validateCameraV2(comps['camera'], `${path}/camera`, errors);
  if (comps['behavior'] !== undefined) validateBehaviorComponent(comps['behavior'], `${path}/behavior`, errors);
  if (comps['prefab'] !== undefined) validatePrefabProvenance(comps['prefab'], `${path}/prefab`, errors);
  if (comps['collider'] !== undefined) validateColliderComponent(comps['collider'], `${path}/collider`, errors);
  if (comps['controller'] !== undefined) validateControllerComponent(comps['controller'], `${path}/controller`, errors);

  // v3 components (field values, §23.3.1–§23.3.6)
  let zoneRole: GameZoneRole | null = null;
  if (comps['gameZone'] !== undefined) zoneRole = validateGameZoneComponent(comps['gameZone'], `${path}/gameZone`, errors, version);
  if (comps['playerSpawn'] !== undefined) validatePlayerSpawnComponent(comps['playerSpawn'], `${path}/playerSpawn`, errors);
  if (comps['cameraFollow'] !== undefined) validateCameraFollowComponent(comps['cameraFollow'], `${path}/cameraFollow`, errors, version);
  if (comps['instances'] !== undefined) {
    validateInstancesComponent(comps['instances'], `${path}/instances`, errors);
    // An instance set is a model placed many times: it carries no box, camera,
    // model, collider or controller of its own.
    for (const other of ['box', 'camera', 'model', 'collider', 'controller', 'modelAnimation', 'gameZone', 'playerSpawn', 'light'] as const) {
      if (comps[other] !== undefined) errors.push(collisionConflict(path, `instances and ${other} are mutually exclusive on one entity`, ['instances', other]));
    }
  }
  if (comps['light'] !== undefined) validateLightComponent(comps['light'], `${path}/light`, errors);
  if (comps['surface'] !== undefined) validateSurfaceComponent(comps['surface'], `${path}/surface`, errors);
  if (comps['modelAnimation'] !== undefined) validateModelAnimationComponent(comps['modelAnimation'], `${path}/modelAnimation`, errors);

  // §23.8 step 5 scene-local target rules
  if (comps['surface'] !== undefined && comps['box'] === undefined && comps['model'] === undefined) {
    errors.push(
      componentMissing(`${path}/surface`, 'box|model', 'a surface component sits only on an entity carrying box or model'),
    );
  }
  if (comps['modelAnimation'] !== undefined) {
    if (comps['model'] === undefined) {
      errors.push(componentMissing(`${path}/modelAnimation`, 'model', 'a modelAnimation component sits only on an entity carrying model'));
    } else if (isPlainObject(comps['model'])) {
      const asset = comps['model']['asset'];
      const modelAssetId = isPlainObject(asset) ? asset['assetId'] : undefined;
      const anim = comps['modelAnimation'];
      const animAssetId = isPlainObject(anim) ? anim['assetId'] : undefined;
      if (typeof modelAssetId === 'string' && typeof animAssetId === 'string' && modelAssetId !== animAssetId) {
        errors.push(
          withFound(
            {
              code: 'component_conflict',
              path: `${path}/modelAnimation/assetId`,
              message: 'modelAnimation.assetId must equal the entity model asset id',
              reason: 'animation_asset',
              expected: 'the entity components.model.asset.assetId',
            },
            animAssetId,
          ),
        );
      }
    }
  }
  if (comps['cameraFollow'] !== undefined && comps['camera'] === undefined) {
    errors.push(
      withFound(
        {
          code: 'component_conflict',
          path: `${path}/cameraFollow`,
          message: 'cameraFollow appears only on the entity carrying camera (there is no parented or secondary camera in v3)',
          reason: 'camera_target',
          expected: 'components.camera on the same entity',
        },
        'cameraFollow',
      ),
    );
  }
  if (comps['gameZone'] !== undefined && (comps['collider'] !== undefined || comps['controller'] !== undefined)) {
    errors.push(
      withFound(
        {
          code: 'component_conflict',
          path: `${path}/gameZone`,
          message: 'a gameZone never blocks movement and is never a physics body',
          reason: 'zone_physics',
          expected: 'no collider or controller on a gameZone entity',
        },
        'gameZone',
      ),
    );
  }
  if (comps['playerSpawn'] !== undefined && (comps['gameZone'] !== undefined || comps['collider'] !== undefined || comps['controller'] !== undefined)) {
    errors.push(
      withFound(
        {
          code: 'component_conflict',
          path: `${path}/playerSpawn`,
          message: 'a playerSpawn is a field-less marker and conflicts with gameZone, collider and controller',
          reason: 'spawn_target',
          expected: 'no gameZone, collider or controller on a playerSpawn entity',
        },
        'playerSpawn',
      ),
    );
  }

  const physicsBearing = comps['collider'] !== undefined || comps['controller'] !== undefined;
  if (physicsBearing) {
    validatePhysicsTransform(comps, parentId, ePath, comps['controller'] !== undefined, errors);
  }

  let polygonVertices = 0;
  if (comps['collider'] !== undefined) {
    const shape = isPlainObject(comps['collider']) ? comps['collider']['shape'] : undefined;
    if (isPlainObject(shape) && shape['type'] === 'polygon' && Array.isArray(shape['vertices'])) {
      polygonVertices = shape['vertices'].length;
    }
  }
  const light = comps['light'];
  const lightType = isPlainObject(light) ? light['type'] : undefined;
  return {
    zones: comps['gameZone'] !== undefined ? 1 : 0,
    checkpointZoneIds: zoneRole === 'checkpoint' ? [''] : [],
    spawns: comps['playerSpawn'] !== undefined ? 1 : 0,
    directional: lightType === 'directional' ? 1 : 0,
    ambient: lightType === 'ambient' ? 1 : 0,
    cameras: comps['camera'] !== undefined ? 1 : 0,
    controllers: comps['controller'] !== undefined ? 1 : 0,
    colliders: comps['collider'] !== undefined ? 1 : 0,
    polygonVertices,
  };
}

// ---- canonicalization (§12.2 + §23.7) ---------------------------------------

function canonicalActivation(a: unknown): CheckpointActivationAppearance {
  const o = a as Record<string, unknown>;
  return {
    emissive: (o['emissive'] as string).toLowerCase(),
    emissiveIntensity: canonNum(o['emissiveIntensity']),
    cueAssetId: (o['cueAssetId'] ?? null) as string | null,
  };
}

function canonicalGameZone(c: unknown): GameZoneComponent {
  const o = c as Record<string, unknown>;
  const size = o['size'] as unknown[];
  const out: GameZoneComponent = {
    role: o['role'] as GameZoneRole,
    size: [canonNum(size[0]), canonNum(size[1])],
  };
  if (o['safeSpawnId'] !== undefined) out.safeSpawnId = o['safeSpawnId'] as string;
  if (o['activation'] !== undefined) out.activation = canonicalActivation(o['activation']);
  if (o['load'] !== undefined) out.load = [...(o['load'] as string[])];
  if (o['unload'] !== undefined) out.unload = [...(o['unload'] as string[])];
  if (o['spawnId'] !== undefined) out.spawnId = o['spawnId'] as string;
  return out;
}

function canonicalCameraFollow(c: unknown): CameraFollowComponent {
  const o = c as Record<string, unknown>;
  const dz = o['deadZone'] as Record<string, unknown>;
  const b = o['bounds'] as Record<string, unknown> | undefined;
  return {
    deadZone: { x: canonNum(dz['x']), y: canonNum(dz['y']) },
    smoothing: canonNum(o['smoothing']),
    // v4: optional.
    ...(b !== undefined
      ? {
          bounds: {
            minX: canonNum(b['minX']),
            maxX: canonNum(b['maxX']),
            minY: canonNum(b['minY']),
            maxY: canonNum(b['maxY']),
          },
        }
      : {}),
  };
}

function canonicalLight(c: unknown): LightComponent {
  const o = c as Record<string, unknown>;
  const out: LightComponent = {
    type: o['type'] as 'directional' | 'ambient',
    color: (o['color'] as string).toLowerCase(),
    intensity: canonNum(o['intensity']),
  };
  if (out.type === 'directional') {
    const dir = o['direction'] as unknown[];
    out.direction = [canonNum(dir[0]), canonNum(dir[1]), canonNum(dir[2])];
    out.castShadow = typeof o['castShadow'] === 'boolean' ? o['castShadow'] : false;
  }
  return out;
}

function canonicalSurface(c: unknown): SurfaceComponent {
  const o = c as Record<string, unknown>;
  return {
    color: typeof o['color'] === 'string' ? o['color'].toLowerCase() : SURFACE_DEFAULTS.color,
    roughness: typeof o['roughness'] === 'number' ? canonNum(o['roughness']) : SURFACE_DEFAULTS.roughness,
    metalness: typeof o['metalness'] === 'number' ? canonNum(o['metalness']) : SURFACE_DEFAULTS.metalness,
    emissive: typeof o['emissive'] === 'string' ? o['emissive'].toLowerCase() : SURFACE_DEFAULTS.emissive,
    emissiveIntensity:
      typeof o['emissiveIntensity'] === 'number' ? canonNum(o['emissiveIntensity']) : SURFACE_DEFAULTS.emissiveIntensity,
  };
}

function canonicalModelAnimation(c: unknown): ModelAnimationComponent {
  const o = c as Record<string, unknown>;
  const roles = o['roles'] as Record<string, unknown>;
  return {
    assetId: o['assetId'] as string,
    version: canonNum(o['version']),
    roles: {
      idle: roles['idle'] as Record<string, unknown>,
      run: roles['run'] as Record<string, unknown>,
      airborne: roles['airborne'] as Record<string, unknown>,
    },
  };
}

function canonicalFlags(e: Record<string, unknown>): Pick<EntityV3, 'active' | 'locked' | 'static' | 'tags'> {
  return {
    ...(e['active'] === false ? { active: false as const } : {}),
    ...(e['locked'] === true ? { locked: true as const } : {}),
    ...(e['static'] === true ? { static: true as const } : {}),
    ...(typeof e['tags'] === 'number' && e['tags'] !== 0 ? { tags: e['tags'] } : {}),
  };
}

function canonicalEntityV3(e: Record<string, unknown>): SceneEntityV3 {
  const comps = e['components'] as Record<string, unknown>;
  if (comps['folder'] !== undefined) {
    const name = e['name'];
    const pid = e['parentId'];
    return {
      id: e['id'] as string,
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof pid === 'string' ? { parentId: pid } : {}),
      ...canonicalFlags(e),
      components: { folder: {} },
    };
  }
  const components: EntityComponentsV3 = {
    transform: canonicalTransform(comps['transform']),
  };
  if (comps['model'] !== undefined) components.model = comps['model'] as ModelComponent;
  if (comps['box'] !== undefined) components.box = canonicalBox(comps['box']) as BoxComponent;
  if (comps['camera'] !== undefined) components.camera = canonicalCamera(comps['camera']) as CameraComponent;
  if (comps['behavior'] !== undefined) {
    const b = comps['behavior'] as { behaviorId: string; values: Record<string, PropertyValue> };
    components.behavior = { behaviorId: b.behaviorId, values: b.values };
  }
  if (comps['prefab'] !== undefined) components.prefab = comps['prefab'] as PrefabProvenanceComponent;
  if (comps['collider'] !== undefined) components.collider = { shape: canonicalCollider(comps['collider']) };
  if (comps['controller'] !== undefined) components.controller = {};
  if (comps['gameZone'] !== undefined) components.gameZone = canonicalGameZone(comps['gameZone']);
  if (comps['playerSpawn'] !== undefined) components.playerSpawn = {};
  if (comps['cameraFollow'] !== undefined) components.cameraFollow = canonicalCameraFollow(comps['cameraFollow']);
  if (comps['light'] !== undefined) components.light = canonicalLight(comps['light']);
  if (comps['surface'] !== undefined) components.surface = canonicalSurface(comps['surface']);
  if (comps['modelAnimation'] !== undefined) components.modelAnimation = canonicalModelAnimation(comps['modelAnimation']);
  if (comps['instances'] !== undefined) {
    const i = comps['instances'] as { asset: { assetId: string }; buffer: string; count: number };
    components.instances = { asset: { assetId: i.asset.assetId }, buffer: i.buffer, count: i.count };
  }
  const name = e['name'];
  const pid = e['parentId'];
  return {
    id: e['id'] as string,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof pid === 'string' ? { parentId: pid } : {}),
    ...canonicalFlags(e),
    components,
  };
}

// ---- scene value validation --------------------------------------------------

interface SceneV3ValueResult {
  errors: ModelErrorV3[];
  doc?: SceneV3;
}

export function validateSceneV3Value(doc: Record<string, unknown>, version: 3 | 4 = 3): SceneV3ValueResult {
  const errors: ModelErrorV3[] = [];
  if (version === 4) {
    // Phase 12 (c): a v4 scene has a display name.
    const name = doc['name'];
    if (name === undefined) errors.push(fieldMissing('/name', 'name'));
    else if (typeof name !== 'string') errors.push(fieldType('/name', name, 'string'));
    else if (!isValidName(name)) errors.push(fieldValue('/name', name, `string, ${NAME_MIN}-${NAME_MAX} chars, no control characters`, 'scene name must be 1-128 characters without control characters'));
  }
  const maxEntities = version === 4 ? MAX_ENTITIES_V4 : MAX_ENTITIES_V2;
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
        { code: 'revision_invalid', path: '/revision', message: 'revision must be an integer in [0, 2^53-1]', expected: `integer in [0, ${MAX_REVISION}]` },
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
    if (ents.length > maxEntities) {
      errors.push(limitsError('/entities', 'entities', ents.length, maxEntities, `scene exceeds the entity limit of ${maxEntities}`));
    }
  }

  if (entities !== null) {
    const idFirstIndex = new Map<string, number>();
    const counts: EntityV3Counts = { ...EMPTY_COUNTS, checkpointZoneIds: [] };
    // Phase 12: folders have no transform, so the "must be a root" rules
    // (zones, spawns, physics) look at the nearest non-folder ancestor.
    const rawParent = new Map<string, string>();
    const rawFolders = new Set<string>();
    for (const e of entities) {
      if (!isPlainObject(e) || typeof e['id'] !== 'string') continue;
      if (typeof e['parentId'] === 'string' && !rawParent.has(e['id'])) rawParent.set(e['id'], e['parentId']);
      if (isPlainObject(e['components']) && e['components']['folder'] !== undefined) rawFolders.add(e['id']);
    }
    const objectParent = (pid: unknown): string | null =>
      typeof pid === 'string' ? nearestObjectAncestor(pid, (id) => rawParent.get(id), (id) => rawFolders.has(id)) : null;
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      const base = `/entities/${idx}`;
      if (!isPlainObject(e)) {
        errors.push(fieldType(base, e, 'object'));
        continue;
      }
      const id = e['id'];
      let entityId = '';
      if (id === undefined) errors.push(fieldMissing(`${base}/id`, 'id'));
      else if (typeof id !== 'string') errors.push(fieldType(`${base}/id`, id, 'string'));
      else {
        entityId = id;
        if (!ID_RE_V2.test(id)) errors.push(idInvalid(`${base}/id`, id));
        const first = idFirstIndex.get(id);
        if (first === undefined) idFirstIndex.set(id, idx);
        else {
          errors.push(
            withFound(
              { code: 'id_duplicate', path: `${base}/id`, message: 'entity id is already used by an earlier entity (first occurrence wins)', expected: 'a unique entity id within the scene' },
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
      for (const flag of ENTITY_FLAGS) {
        const v = e[flag];
        if (v !== undefined && typeof v !== 'boolean') errors.push(fieldType(`${base}/${flag}`, v, 'boolean'));
      }
      const tags = e['tags'];
      if (tags !== undefined && (typeof tags !== 'number' || !Number.isInteger(tags) || tags < 0 || tags > 0xffffffff)) {
        errors.push(fieldValue(`${base}/tags`, tags, 'integer 0 to 4294967295 (a 32-bit tag mask)', 'tags is the unsigned 32-bit mask of the tag bits'));
      }
      const comps = e['components'];
      if (comps === undefined) {
        errors.push(fieldMissing(`${base}/components`, 'components'));
      } else if (!isPlainObject(comps)) {
        errors.push(fieldType(`${base}/components`, comps, 'object'));
      } else {
        const c = validateEntityComponentsV3(comps, objectParent(pid) ?? undefined, base, errors, version);
        counts.zones += c.zones;
        counts.spawns += c.spawns;
        counts.directional += c.directional;
        counts.ambient += c.ambient;
        counts.cameras += c.cameras;
        counts.controllers += c.controllers;
        counts.colliders += c.colliders;
        counts.polygonVertices += c.polygonVertices;
        if (c.checkpointZoneIds.length > 0) counts.checkpointZoneIds.push(entityId);
      }
      for (const k of Object.keys(e)) {
        if (!KNOWN_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${base}/${pointerSegment(k)}`, k, 'id, name, parentId, active, locked, static, tags, components'));
      }
    }

    // hierarchy: reference, cycle, order (accepted §11.2 rules)
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!isPlainObject(e)) continue;
      const pid = e['parentId'];
      if (typeof pid === 'string' && !idFirstIndex.has(pid)) {
        errors.push(
          withFound(
            { code: 'reference_missing', path: `/entities/${idx}/parentId`, message: 'parentId does not reference an existing entity in this scene', expected: 'an existing entity id, or null/absent (root)' },
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
            { code: 'order_parent_before_child', path: `/entities/${idx}/parentId`, message: 'an entity must appear before its parent in the entities array', expected: 'parent index < child index (parent-before-child order)' },
            pid,
          ),
        );
      }
    }

    // v3: exactly one camera per scene. v4: at most one (the start scenes
    // together hold exactly one — a project-level rule).
    if (version === 3 ? counts.cameras !== 1 : counts.cameras > 1) {
      errors.push(
        withFound(
          version === 3
            ? { code: 'camera_count_invalid', path: '', message: 'the scene must contain exactly one entity carrying the camera component', expected: 'exactly 1 camera' }
            : { code: 'camera_count_invalid', path: '', message: 'a scene may contain at most one entity carrying the camera component', expected: 'at most 1 camera' },
          counts.cameras,
        ),
      );
    }
    if (counts.controllers > 1) {
      errors.push(
        withFound(
          { code: 'controller_count_invalid', path: '', message: 'a scene must not contain more than one entity carrying the controller component', expected: 'at most 1 controller' },
          counts.controllers,
        ),
      );
    }
    if (counts.colliders > MAX_COLLIDERS) {
      errors.push(limitsError('/entities', 'colliders', counts.colliders, MAX_COLLIDERS, `scene exceeds the collider limit of ${MAX_COLLIDERS}`));
    }
    if (counts.polygonVertices > MAX_POLYGON_VERTICES_TOTAL) {
      errors.push(
        limitsError('/entities', 'collider_vertices_total', counts.polygonVertices, MAX_POLYGON_VERTICES_TOTAL, `scene exceeds the total polygon-vertex limit of ${MAX_POLYGON_VERTICES_TOTAL}`),
      );
    }
    // §23.10 v3 scene limits
    if (counts.zones > GAME_ZONE_LIMITS.zones) {
      errors.push(limitsError('/entities', 'zones', counts.zones, GAME_ZONE_LIMITS.zones, `scene exceeds the game-zone limit of ${GAME_ZONE_LIMITS.zones}`));
    }
    if (counts.spawns > GAME_ZONE_LIMITS.playerSpawns) {
      errors.push(
        limitsError('/entities', 'player_spawns', counts.spawns, GAME_ZONE_LIMITS.playerSpawns, `scene exceeds the player-spawn limit of ${GAME_ZONE_LIMITS.playerSpawns}`),
      );
    }
    if (counts.directional > GAME_ZONE_LIMITS.lightsDirectional) {
      errors.push(
        limitsError('/entities', 'lights_directional', counts.directional, GAME_ZONE_LIMITS.lightsDirectional, 'scene exceeds the directional-light limit'),
      );
    }
    if (counts.ambient > GAME_ZONE_LIMITS.lightsAmbient) {
      errors.push(limitsError('/entities', 'lights_ambient', counts.ambient, GAME_ZONE_LIMITS.lightsAmbient, 'scene exceeds the ambient-light limit'));
    }
    if (counts.checkpointZoneIds.length > GAME_ZONE_LIMITS.checkpointZones) {
      errors.push(
        withFound(
          {
            code: 'zone_checkpoint_count_invalid',
            path: '/entities',
            message: 'a scene may contain at most one checkpoint zone',
            expected: '<= 1 checkpoint zone',
            zoneIds: [...counts.checkpointZoneIds],
          },
          counts.checkpointZoneIds.length,
        ),
      );
    }
    // §23.5 rule 4: every checkpoint safeSpawnId resolves to a playerSpawn.
    for (let idx = 0; idx < entities.length; idx++) {
      const e = entities[idx];
      if (!isPlainObject(e)) continue;
      const comps = e['components'];
      if (!isPlainObject(comps)) continue;
      const zone = comps['gameZone'];
      if (!isPlainObject(zone) || zone['role'] !== 'checkpoint') continue;
      const safe = zone['safeSpawnId'];
      if (typeof safe !== 'string') continue;
      const targetIdx = idFirstIndex.get(safe);
      const target = targetIdx === undefined ? undefined : entities[targetIdx];
      const targetComps = isPlainObject(target) ? target['components'] : undefined;
      const resolves = isPlainObject(targetComps) && targetComps['playerSpawn'] !== undefined;
      if (!resolves) {
        errors.push(
          withFound(
            {
              code: 'game_reference_missing',
              path: `/entities/${idx}/components/gameZone/safeSpawnId`,
              message: 'a checkpoint safeSpawnId must resolve to an entity carrying playerSpawn',
              reason: 'safe_spawn',
              expected: 'an existing playerSpawn entity id',
            },
            safe,
          ),
        );
      }
    }
    checkDepthLimit(entities, idFirstIndex, errors);
  }

  const knownScene = version === 4 ? KNOWN_SCENE_FIELDS_V4 : KNOWN_SCENE_FIELDS;
  for (const k of Object.keys(doc)) {
    if (!knownScene.has(k)) errors.push(unexpectedField(`/${pointerSegment(k)}`, k, [...knownScene].join(', ')));
  }
  if (errors.length > 0) return { errors };
  const canonical = canonicalSceneV3(doc, entities as unknown[], version);
  checkFolderHierarchy(canonical, errors);
  if (errors.length > 0) return { errors };
  return { errors, doc: canonical };
}

/**
 * Phase 12 rules over a structurally valid scene: a folder sits at the root
 * or in another folder; the camera and every checkpoint's safe spawn are
 * active (an inactive entity is not in the game).
 */
function checkFolderHierarchy(scene: SceneV3, errors: ModelErrorV3[]): void {
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  scene.entities.forEach((e, idx) => {
    if (!isFolderEntity(e) || e.parentId === undefined) return;
    const parent = byId.get(e.parentId);
    if (parent !== undefined && !isFolderEntity(parent)) {
      errors.push(
        withFound(
          {
            code: 'field_value',
            path: `/entities/${idx}/parentId`,
            message: 'a folder sits at the root or inside another folder, never under an object',
            reason: 'folder_parent',
            expected: 'absent/null, or the id of a folder',
          },
          e.parentId,
        ),
      );
    }
  });
  const flags = effectiveEntityFlags(scene.entities);
  scene.entities.forEach((e, idx) => {
    if (isFolderEntity(e)) return;
    if (e.components.camera !== undefined && flags.get(e.id)?.active === false) {
      errors.push(
        withFound(
          { code: 'camera_count_invalid', path: `/entities/${idx}`, message: 'the scene camera must be active', reason: 'inactive', expected: 'exactly 1 active camera' },
          e.id,
        ),
      );
    }
    const zone = e.components.gameZone;
    if (zone?.safeSpawnId !== undefined && flags.get(e.id)?.active !== false && flags.get(zone.safeSpawnId)?.active === false) {
      errors.push(
        withFound(
          {
            code: 'game_reference_missing',
            path: `/entities/${idx}/components/gameZone/safeSpawnId`,
            message: "an active checkpoint's safe spawn must be active",
            reason: 'safe_spawn',
            expected: 'an active playerSpawn entity id',
          },
          zone.safeSpawnId,
        ),
      );
    }
  });
}

function canonicalSceneV3(doc: Record<string, unknown>, ents: unknown[], version: 3 | 4 = 3): SceneV3 {
  if (version === 4) {
    return {
      schemaVersion: 4,
      sceneId: doc['sceneId'] as string,
      name: doc['name'] as string,
      revision: canonNum(doc['revision']),
      entities: (ents as Record<string, unknown>[]).map(canonicalEntityV3),
    } as unknown as SceneV3;
  }
  return {
    schemaVersion: 3,
    sceneId: doc['sceneId'] as string,
    revision: canonNum(doc['revision']),
    entities: (ents as Record<string, unknown>[]).map(canonicalEntityV3),
  };
}

// ---- public entry points -----------------------------------------------------

/** §12.1/§23.11: the explicit `schemaVersion` 3 scene validator. */
export function validateSceneV3(doc: unknown): ModelResultV3<SceneV3> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  if (!isKnownVersion(doc['schemaVersion'], SCHEMA_VERSIONS_BY_DOCUMENT.scene)) {
    return fail([schemaVersionUnsupported(doc['schemaVersion'], SCHEMA_VERSIONS_BY_DOCUMENT.scene)]);
  }
  if (doc['schemaVersion'] !== 3) {
    return fail([
      fieldValue('/schemaVersion', doc['schemaVersion'], '3', 'validateSceneV3 accepts an embedded schemaVersion 3 scene'),
    ]);
  }
  const { errors, doc: canonical } = validateSceneV3Value(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as SceneV3 };
}

/** §12.1: validate, then return the new canonical v3 document (§12.2/§23.7). */
export function normalizeSceneV3(doc: unknown): ModelResultV3<SceneV3> {
  return validateSceneV3(doc);
}

/**
 * Phase 12 (c): the `schemaVersion` 4 scene validator — the v3 rules plus a
 * scene name, instance sets, exit zones, optional camera-follow bounds and at
 * most (not exactly) one camera. Rules that span scenes (unique ids across the
 * project, the start set, exit targets) are `validateProjectV4`'s.
 */
export function validateSceneV4(doc: unknown): ModelResultV3<SceneV4> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  if (doc['schemaVersion'] !== 4) {
    return fail([fieldValue('/schemaVersion', doc['schemaVersion'], '4', 'validateSceneV4 accepts a schemaVersion 4 scene')]);
  }
  const { errors, doc: canonical } = validateSceneV3Value(doc, 4);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as unknown as SceneV4 };
}
