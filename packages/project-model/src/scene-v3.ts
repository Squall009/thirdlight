/**
 * schemaVersion 3 logical scene validation and canonicalization, extending
 * the v2 scene rules with the six appended components.
 *
 * `validateSceneV3`/`normalizeSceneV3` are the explicitly versioned v3 scene
 * entry points. They perform
 * the SCENE-LOCAL rules only: registry and combinations, per-component field
 * values, the `modelAnimation` container, counts/limits and the
 * `playerSpawn` transform rules. Rules that need `content.assets` — animation
 * asset resolution and the accepted v2 cross-block checks — run in
 * `validateProjectV3`/`validateEnvelopeV3`.
 *
 * The v2 component validators are reused verbatim (no v2 component is
 * renumbered or reinterpreted). Pure and total: same input → same
 * result, never throws, never reads files.
 */
import { ID_RE } from './validate';

import { BLOCK_COMPONENT_NAMES, BLOCK_COMPONENTS } from './blocks';
import { canonicalEffectComponent, validateEffectComponent, type EffectComponent } from './effects';
import { canonicalSocketAttach, SOCKET_ATTACH_CONFLICTS, validateSocketAttachComponent, type SocketAttachComponent } from './sockets';
import { canonicalBehaviorGroup, validateBehaviorGroupComponent, type BehaviorGroupComponent } from './modes';
import { canonicalCameraPath, canonicalCameraRegion, canonicalVirtualCamera, validateCameraPathComponent, validateCameraRegionComponent, validateVirtualCameraComponent, type CameraPathComponent, type CameraRegionComponent, type VirtualCameraComponent } from './cameras';
import { canonicalAnimatorComponent, validateAnimatorComponent, type AnimatorComponent } from './animator';
import { canonicalFogVolume, canonicalMaterialMapping, canonicalMaterialParams, MAX_FOG_VOLUMES, validateFogVolumeComponent, validateMaterialMapping, validateMaterialParamsComponent, type FogVolumeComponent, type MaterialParamsComponent } from './materials';
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
  colliderCore,
  validateColliderLayers,
  ID_RE_V2,
  MAX_ENTITIES_V2,
  COLLIDER_3D_LIMITS,
  validateBehaviorComponent,
  validateBoxV2,
  validateCameraV2,
  validateColliderComponent,
  validateControllerComponent,
  canonicalController,
  validateModelComponent,
  validateModelPiece,
  validateShadowFlags,
  validatePhysicsTransform,
  validatePrefabProvenance,
  validateTransformV2,
} from './components';
import type {
  BoxComponent,
  CameraComponent,
  ModelComponent,
  PrefabProvenanceComponent,
  PropertyValue,
} from './types-v2';
import {
  SCENE_LIMITS_V3,
  V3_REGISTRY,
  type EntityComponentsV3,
  type EntityV3,
  type LightComponent,
  type ModelAnimationComponent,
  type SceneV3,
  type SurfaceComponent,
  type SceneEntityV3,
  type SceneV4,
  isFolderEntity,
  MAX_INSTANCES,
} from './types-v3';
import { isRemovedComponent, removedComponentMessage } from './upgrade-v24';
import { effectiveEntityFlags, nearestObjectAncestor } from './hierarchy-v3';
import { canonicalBlockFootprint, validateBlockFootprintComponent, type BlockFootprintComponent } from './block-layers';
import { canonicalBlockLayerComponent, canonicalSceneBlocks, validateBlockLayerComponent, validateSceneBlocks, type BlockLayerComponent, type BlockLayerData } from './block-layers';

export const COLOR_RE_V3 = /^#[0-9a-fA-F]{6}$/;
export const MAX_ABS_V3 = 1e6; // numbers bound
export const MAX_INTENSITY = 8;
export const MAX_EMISSIVE_INTENSITY = 4;
export const MAX_ZONE_SPAN = 1e6; // size bound
export const MIN_BOUND_SPAN = 1e-6; // bounds span
export const MIN_DIRECTION_NORM = 1e-6;
export const SURFACE_DEFAULTS = Object.freeze({
  color: '#b0b0b0',
  roughness: 0.9,
  metalness: 0,
  emissive: '#000000',
  emissiveIntensity: 0,
});

const KNOWN_SCENE_FIELDS = new Set(['schemaVersion', 'sceneId', 'revision', 'entities']);
// `blocks` — the scene's block-layer cells and regions (absent = none).
const KNOWN_SCENE_FIELDS_V4 = new Set(['schemaVersion', 'sceneId', 'revision', 'entities', 'blocks']);
/** The v4 per-scene entity cap: a scene is one load unit (a big world is several scenes loaded together; instance sets hold dense detail). */
export const MAX_ENTITIES_V4 = 16_384;
/** The boolean flags an entity may carry (only a non-default value is stored). */
export const ENTITY_FLAGS = ['active', 'visible', 'locked', 'static'] as const;
const KNOWN_ENTITY_FIELDS = new Set(['id', 'name', 'parentId', ...ENTITY_FLAGS, 'tags', 'components']);
/** The v4 component registry (v3's plus `instances`). */
// `materialParams` (per-object overrides of graph-material parameters) is appended last.
// `effect` (plays a visual effect from the entity) is appended after it.
export const V4_REGISTRY: readonly string[] = [...V3_REGISTRY, 'instances', 'materials', 'fogVolume', 'animator', ...BLOCK_COMPONENT_NAMES, 'materialParams', 'effect', 'virtualCamera', 'cameraPath', 'blockLayer', 'blockFootprint', 'socketAttach', 'behaviorGroup', 'cameraRegion'];
// `cameraRegion` (a track camera's dead zone, bounds and distance while its target is inside) last.
// `blockLayer` (a grid of blocks; its cells are the scene's `blocks`) is appended after it.
// `blockFootprint` (the metadata a prop writes into the block cells beneath it) after that.
// `socketAttach` (rides on a node of another entity's model) after that.
// `behaviorGroup` (the behavior group game modes tick) after that.
const KNOWN_LIGHT_FIELDS = new Set(['type', 'color', 'intensity', 'direction', 'castShadow', 'shadowMapSize', 'shadowBias', 'shadowNormalBias', 'shadowExtent']);

/**
 * The directional light's shadow settings (data; absent = the
 * defaults, three-adapter `DIRECTIONAL_SHADOW_DEFAULTS` holds the same values):
 * - map size 1024²: over the default 48 m square a texel is 4.7 cm, a crisp
 *   shadow for a person-size object in a side, top-down or third-person view,
 *   at a quarter of the memory of 2048²; WebGL 2 guarantees 2048, WebGPU 8192
 *   (4096 is the cap: the largest map worth its memory on common GPUs).
 * - bias -0.0005: half a thousandth of the shadow depth range removes acne on
 *   surfaces facing the light without lifting the shadow off its caster.
 * - normal bias 0.02 m: about half a texel at the defaults — removes the
 *   stripes on surfaces at a grazing angle (curved models, instance sets).
 * - extent 24 m (half the side of the square that follows the camera in a v4
 *   game): the previous engine constant, room for a screen of any common
 *   genre; a v3 game's level bounds decide its square instead.
 */
export const DIRECTIONAL_SHADOW_LIMITS = {
  mapSizes: [512, 1024, 2048, 4096],
  bias: { min: -0.01, max: 0.01 },
  normalBias: { min: 0, max: 1 },
  extent: { min: 1, max: 64 },
} as const;
export const DIRECTIONAL_SHADOW_DEFAULTS = { mapSize: 1024, bias: -0.0005, normalBias: 0.02, extent: 24 } as const;
/** v4: the local light fields. */
const KNOWN_LIGHT_FIELDS_V4 = new Set(['type', 'color', 'intensity', 'direction', 'castShadow', 'range', 'decay', 'angle', 'penumbra', 'groundColor', 'mode', 'cookie']);
/** A spot light's cookie names a texture asset (the id pattern of every asset). */
const COOKIE_ID_RE = ID_RE;
/** point/spot intensity is in candela (three's physical units). */
export const MAX_LOCAL_INTENSITY = 1000;
/** Most point + spot lights per scene, and hemisphere lights per scene (forward-lighting cost per drawn light; scalable lighting replaces it). */
export const MAX_LOCAL_LIGHTS = 16;
export const MAX_HEMISPHERE_LIGHTS = 1;
const KNOWN_SURFACE_FIELDS = new Set(['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity']);
const KNOWN_MODEL_ANIMATION_FIELDS = new Set(['assetId', 'version', 'roles']);
const ROLE_KEYS = ['idle', 'run', 'airborne'] as const;

// ---- small helpers -----------------------------------------------------------

function v3ComponentUnknown(path: string, key: string): ModelErrorV3 {
  // A removed game component names itself and says where it went.
  if (isRemovedComponent(key)) {
    return withFound({ code: 'component_unknown', path, message: removedComponentMessage(key), expected: `known component types: ${V3_REGISTRY.join(', ')}` }, key);
  }
  return withFound(
    {
      code: 'component_unknown',
      path,
      message: 'component is not in the schemaVersion 3 registry',
      expected: `known component types: ${V3_REGISTRY.join(', ')}`,
      hint: 'adding a component type requires a new schemaVersion',
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
  if (v === undefined) return; // defaulted on normalize
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

/**
 * An instance set — one model, `count` placements in a binary
 * buffer stored by SHA-256 (asset and buffer existence are checked against
 * the content block and the blob store elsewhere).
 */
/** The largest instance-set chunk size (m). */
export const MAX_INSTANCE_CHUNK_SIZE = 4096;

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
    validateModelPiece(asset['piece'], `${path}/asset/piece`, errors);
    for (const k of Object.keys(asset)) if (k !== 'assetId' && k !== 'piece') errors.push(unexpectedField(`${path}/asset/${pointerSegment(k)}`, k, 'assetId, piece'));
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
  validateShadowFlags(c, path, errors);
  // The set's own spatial chunk size (m).
  const chunkSize = c['chunkSize'];
  if (chunkSize !== undefined && (typeof chunkSize !== 'number' || !Number.isFinite(chunkSize) || chunkSize < 1 || chunkSize > MAX_INSTANCE_CHUNK_SIZE)) {
    errors.push(fieldValue(`${path}/chunkSize`, chunkSize, `a number 1-${MAX_INSTANCE_CHUNK_SIZE}`, 'chunkSize is the chunk width in metres'));
  }
  for (const k of Object.keys(c)) {
    if (k !== 'asset' && k !== 'buffer' && k !== 'count' && k !== 'castShadow' && k !== 'receiveShadow' && k !== 'chunkSize') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'asset, buffer, count, castShadow, receiveShadow, chunkSize'));
  }
}

export function validatePlayerSpawnComponent(c: unknown, path: string, errors: ModelErrorV3[], version: 3 | 4 = 3): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const k of Object.keys(c)) {
    // The way the character faces on arrival, a yaw in degrees about +Y (0: facing +Z; any direction, 3D too).
    if (k === 'yaw' && version === 4) {
      const v = c[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < -360 || v > 360) errors.push(fieldValue(`${path}/yaw`, v, 'a number −360–360', 'yaw is −360–360 degrees'));
      continue;
    }
    // The left/right `facing` became `yaw` (a schemaVersion 2 project is upgraded on load).
    if (k === 'facing' && version === 4) {
      errors.push(withFound({ code: 'field_unexpected', path: `${path}/facing`, message: 'playerSpawn.facing is replaced by yaw (left: -90, right: 90 degrees)', expected: 'yaw' }, c[k]));
      continue;
    }
    errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, version === 4 ? 'yaw' : '{} (no fields)'));
  }
}

export function validateLightComponent(c: unknown, path: string, errors: ModelErrorV3[], version: 3 | 4 = 3): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const type = c['type'];
  if (version === 4 && (type === 'point' || type === 'spot' || type === 'hemisphere')) {
    validateLocalLight(c, type, path, errors);
    return;
  }
  if (version === 4 && c['mode'] !== undefined && c['mode'] !== 'realtime' && c['mode'] !== 'baked' && c['mode'] !== 'mixed') {
    errors.push(fieldValue(`${path}/mode`, c['mode'], '"realtime" | "baked" | "mixed"', 'mode is realtime, baked or mixed'));
  }
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
  else checkFiniteNumber(c['intensity'], `${path}/intensity`, { min: 0, absMax: MAX_INTENSITY }, `0 <= v <= ${MAX_INTENSITY}`, errors);

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
    // The shadow map settings (optional).
    const lim = DIRECTIONAL_SHADOW_LIMITS;
    const size = c['shadowMapSize'];
    if (size !== undefined && !(lim.mapSizes as readonly unknown[]).includes(size)) {
      errors.push(fieldValue(`${path}/shadowMapSize`, size, `one of ${lim.mapSizes.join(', ')}`, 'the shadow map size is a power of two from 512 to 4096'));
    }
    const range = (k: string, r: { min: number; max: number }, unit: string): void => {
      const v = c[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < r.min || v > r.max)) {
        errors.push(fieldValue(`${path}/${k}`, v, `a number in [${r.min}, ${r.max}]${unit}`, `${k} must be in [${r.min}, ${r.max}]${unit}`));
      }
    };
    range('shadowBias', lim.bias, '');
    range('shadowNormalBias', lim.normalBias, ' m');
    range('shadowExtent', lim.extent, ' m');
  } else {
    for (const k of ['shadowMapSize', 'shadowBias', 'shadowNormalBias', 'shadowExtent']) {
      if (c[k] !== undefined) errors.push(fieldValue(`${path}/${k}`, c[k], 'absent on an ambient light', 'only a directional light casts shadows'));
    }
    if (c['direction'] !== undefined) {
      errors.push(fieldValue(`${path}/direction`, c['direction'], 'absent on an ambient light', 'only a directional light carries a direction'));
    }
    if (c['castShadow'] !== undefined) {
      errors.push(fieldValue(`${path}/castShadow`, c['castShadow'], 'absent on an ambient light', 'only a directional light casts shadows'));
    }
  }
  for (const k of Object.keys(c)) {
    if (version === 4 && k === 'mode') continue;
    if (!KNOWN_LIGHT_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, color, intensity, direction, castShadow, shadowMapSize, shadowBias, shadowNormalBias, shadowExtent'));
  }
}

/**
 * v4: a point light (at the entity, `range` 0 = unlimited,
 * `decay`), a spot light (also `direction`, `angle` in degrees, `penumbra`)
 * or a hemisphere light (`color` = sky, `groundColor`). Point and spot
 * intensity is in candela; any light may be `realtime`, `baked` or `mixed`.
 */
function validateLocalLight(c: Record<string, unknown>, type: 'point' | 'spot' | 'hemisphere', path: string, errors: ModelErrorV3[]): void {
  optionalColor(c['color'], `${path}/color`, 'required', errors);
  if (c['color'] === undefined) errors.push(fieldMissing(`${path}/color`, 'color'));
  if (c['intensity'] === undefined) errors.push(fieldMissing(`${path}/intensity`, 'intensity'));
  else checkFiniteNumber(c['intensity'], `${path}/intensity`, { min: 0, absMax: type === 'hemisphere' ? MAX_INTENSITY : MAX_LOCAL_INTENSITY }, `0 <= v <= ${type === 'hemisphere' ? MAX_INTENSITY : MAX_LOCAL_INTENSITY}`, errors);
  const allowed = type === 'hemisphere' ? ['type', 'color', 'intensity', 'groundColor', 'mode'] : type === 'point' ? ['type', 'color', 'intensity', 'range', 'decay', 'castShadow', 'mode'] : ['type', 'color', 'intensity', 'range', 'decay', 'castShadow', 'direction', 'angle', 'penumbra', 'mode', 'cookie'];
  for (const k of Object.keys(c)) {
    if (!allowed.includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, allowed.join(', ')));
  }
  const range = (k: string, lo: number, hi: number): void => {
    const v = c[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) errors.push(fieldValue(`${path}/${k}`, v, `a number in [${lo}, ${hi}]`, `${k} must be in [${lo}, ${hi}]`));
  };
  range('range', 0, 1000);
  range('decay', 0, 4);
  range('angle', 1, 89);
  range('penumbra', 0, 1);
  if (type === 'hemisphere') optionalColor(c['groundColor'], `${path}/groundColor`, '#444444', errors);
  if (c['castShadow'] !== undefined && typeof c['castShadow'] !== 'boolean') errors.push(fieldType(`${path}/castShadow`, c['castShadow'], 'boolean'));
  if (c['mode'] !== undefined && c['mode'] !== 'realtime' && c['mode'] !== 'baked' && c['mode'] !== 'mixed') {
    errors.push(fieldValue(`${path}/mode`, c['mode'], '"realtime" | "baked" | "mixed"', 'mode is realtime, baked or mixed'));
  }
  // A spot light's cookie (a texture projected through the cone; which texture: a project-level rule).
  if (type === 'spot' && c['cookie'] !== undefined && (typeof c['cookie'] !== 'string' || !COOKIE_ID_RE.test(c['cookie']))) {
    errors.push(fieldValue(`${path}/cookie`, c['cookie'], 'a texture assetId', 'a cookie names a texture asset'));
  }
  if (type === 'spot') {
    const dir = c['direction'];
    if (dir === undefined) errors.push(fieldMissing(`${path}/direction`, 'direction'));
    else if (!Array.isArray(dir) || dir.length !== 3 || !dir.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1) || Math.hypot(dir[0] as number, dir[1] as number, dir[2] as number) < MIN_DIRECTION_NORM) {
      errors.push(fieldValue(`${path}/direction`, dir, '[x, y, z], each |v| <= 1, not all 0', 'a spot light points in a direction'));
    }
  }
}

export function validateSurfaceComponent(c: unknown, path: string, errors: ModelErrorV3[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  optionalColor(c['color'], `${path}/color`, SURFACE_DEFAULTS.color, errors);
  for (const k of ['roughness', 'metalness'] as const) {
    if (c[k] === undefined) continue; // the normalizer fills the default
    checkFiniteNumber(c[k], `${path}/${k}`, { min: 0, absMax: 1 }, '0 <= v <= 1', errors);
  }
  optionalColor(c['emissive'], `${path}/emissive`, SURFACE_DEFAULTS.emissive, errors);
  if (c['emissiveIntensity'] !== undefined) {
    checkFiniteNumber(
      c['emissiveIntensity'],
      `${path}/emissiveIntensity`,
      { min: 0, absMax: MAX_EMISSIVE_INTENSITY },
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
    if (bytes > SCENE_LIMITS_V3.animationProfileBytes) {
      errors.push(
        limitsError(
          `${path}/roles`,
          'animation_profile_bytes',
          bytes,
          SCENE_LIMITS_V3.animationProfileBytes,
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
  spawns: number;
  directional: number;
  ambient: number;
  local: number;
  hemisphere: number;
  fogVolumes: number;
  cameras: number;
  controllers: number;
  /** Convex-hull points and mesh vertices (3D colliders). */
  points3d: number;
}

const EMPTY_COUNTS: EntityV3Counts = {
  spawns: 0,
  directional: 0,
  ambient: 0,
  local: 0,
  hemisphere: 0,
  fogVolumes: 0,
  cameras: 0,
  controllers: 0,
  points3d: 0,
};

/**
 * A block layer is axis-aligned level geometry — a root object
 * (its position is the layer origin) at identity rotation and unit scale
 * (the cell size carries the scale).
 */
function validateBlockLayerTransform(comps: Record<string, unknown>, parentId: unknown, path: string, errors: ModelErrorV3[]): void {
  const t = canonicalTransform(comps['transform']);
  if (parentId !== undefined && parentId !== null) {
    errors.push(withFound({ code: 'component_conflict', path: `${path}/parentId`, message: 'a block layer is a root object (in a folder at most): its position is the layer origin', reason: 'block_layer_parented', expected: 'parentId absent, or a folder' }, parentId));
  }
  if (!(t.scale[0] === 1 && t.scale[1] === 1 && t.scale[2] === 1)) {
    errors.push(withFound({ code: 'component_conflict', path: `${path}/components/transform/scale`, message: 'a block layer is at unit scale (its cellSize sets the size of the cells)', reason: 'block_layer_scale', expected: '[1, 1, 1]' }, t.scale));
  }
  if (!(t.rotation[0] === 0 && t.rotation[1] === 0 && t.rotation[2] === 0 && t.rotation[3] === 1)) {
    errors.push(withFound({ code: 'component_conflict', path: `${path}/components/transform/rotation`, message: 'a block layer is axis-aligned (identity rotation); turn blocks per cell instead', reason: 'block_layer_rotation', expected: '[0, 0, 0, 1]' }, t.rotation));
  }
}

/** Spawn transform rules. */
function validateSpawnTransform(
  comps: Record<string, unknown>,
  parentId: unknown,
  path: string,
  errors: ModelErrorV3[],
): void {
  if (comps['playerSpawn'] === undefined) return;
  const code = 'spawn_transform_unsupported';
  const bearer = 'playerSpawn';
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
 * The component registry, combinations and per-component values for one
 * entity. Pass 1 (registry + `transform` presence + zone/spawn transforms)
 * and pass 2 (field values) are run together in the accepted order.
 */
function validateEntityComponentsV3(
  comps: Record<string, unknown>,
  parentId: unknown,
  ePath: string,
  errors: ModelErrorV3[],
  version: 3 | 4 = 3,
  merged = false,
): EntityV3Counts {
  const path = `${ePath}/components`;
  const registry: readonly string[] = version === 4 ? V4_REGISTRY : V3_REGISTRY;
  for (const k of Object.keys(comps)) {
    if (!registry.includes(k)) {
      errors.push(v3ComponentUnknown(`${path}/${pointerSegment(k)}`, k));
    }
  }
  if (comps['folder'] !== undefined) {
    // A folder is organisation only — no transform, nothing else.
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
    return { ...EMPTY_COUNTS };
  }
  if (comps['transform'] === undefined) {
    errors.push({
      code: 'component_missing',
      path: `${path}/transform`,
      message: 'every entity requires the transform component',
      expected: 'transform present',
    });
  }
  // The zone/spawn transform rules (each with its own code).
  validateSpawnTransform(comps, parentId, ePath, errors);

  // v2 structural conflicts (+ the v3 ones)
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
  if (comps['collider'] !== undefined) {
    // v4: `oneWay: true` on a collider.
    const col = comps['collider'];
    const oneWay = isPlainObject(col) ? col['oneWay'] : undefined;
    if (oneWay !== undefined && (version !== 4 || oneWay !== true)) errors.push(fieldValue(`${path}/collider/oneWay`, oneWay, 'true (v4 scenes)', 'oneWay is true or absent'));
    // v4: the collision layers the collider is in.
    const layers = isPlainObject(col) ? col['layers'] : undefined;
    if (layers !== undefined) {
      if (version !== 4) errors.push(fieldValue(`${path}/collider/layers`, layers, 'absent (v4 scenes only)', 'collision layers are a v4 field'));
      else validateColliderLayers(layers, `${path}/collider/layers`, errors);
    }
    validateColliderComponent(colliderCore(col), `${path}/collider`, errors);
  }
  if (comps['controller'] !== undefined) validateControllerComponent(comps['controller'], `${path}/controller`, errors, version);

  // v3 components (field values)
  if (comps['playerSpawn'] !== undefined) validatePlayerSpawnComponent(comps['playerSpawn'], `${path}/playerSpawn`, errors, version);
  if (comps['instances'] !== undefined) {
    validateInstancesComponent(comps['instances'], `${path}/instances`, errors);
    // An instance set is a model placed many times: it carries no box, camera,
    // model, collider or controller of its own.
    for (const other of ['box', 'camera', 'model', 'collider', 'controller', 'modelAnimation', 'playerSpawn', 'light'] as const) {
      if (comps[other] !== undefined) errors.push(collisionConflict(path, `instances and ${other} are mutually exclusive on one entity`, ['instances', other]));
    }
  }
  if (comps['materials'] !== undefined) {
    // Which project material each of the object's materials uses.
    validateMaterialMapping(comps['materials'], `${path}/materials`, errors);
    if (comps['model'] === undefined && comps['box'] === undefined && comps['instances'] === undefined) {
      errors.push(componentMissing(`${path}/materials`, 'model|box|instances', 'a materials component sits only on an entity with a model, a box or an instance set'));
    }
  }
  if (comps['materialParams'] !== undefined) {
    // Overrides of the object's graph materials' public parameters.
    validateMaterialParamsComponent(comps['materialParams'], `${path}/materialParams`, errors);
    if (comps['model'] === undefined && comps['box'] === undefined && comps['instances'] === undefined) {
      errors.push(componentMissing(`${path}/materialParams`, 'model|box|instances', 'material parameter overrides sit only on an entity with a model, a box or an instance set'));
    }
  }
  // A visual effect played from the entity (any entity may carry one).
  if (comps['effect'] !== undefined) validateEffectComponent(comps['effect'], `${path}/effect`, errors);
  // A virtual camera shot and a path rail cameras ride (any entity may carry them).
  if (comps['virtualCamera'] !== undefined) validateVirtualCameraComponent(comps['virtualCamera'], `${path}/virtualCamera`, errors);
  if (comps['cameraPath'] !== undefined) validateCameraPathComponent(comps['cameraPath'], `${path}/cameraPath`, errors);
  // A camera region (any entity may carry one).
  if (comps['cameraRegion'] !== undefined) validateCameraRegionComponent(comps['cameraRegion'], `${path}/cameraRegion`, errors);
  // The entity rides on a node of another entity's model.
  if (comps['socketAttach'] !== undefined) validateSocketAttachComponent(comps['socketAttach'], `${path}/socketAttach`, errors);
  // The behavior group (whether the group exists is the project composition's check).
  if (comps['behaviorGroup'] !== undefined) validateBehaviorGroupComponent(comps['behaviorGroup'], `${path}/behaviorGroup`, errors);
  if (comps['light'] !== undefined) validateLightComponent(comps['light'], `${path}/light`, errors, version);
  if (comps['fogVolume'] !== undefined) validateFogVolumeComponent(comps['fogVolume'], `${path}/fogVolume`, errors);
  if (comps['blockLayer'] !== undefined) {
    // A block layer. A merged runtime scene carries the layer's
    // cells on the component (`data`, attached by resolveSceneHierarchy).
    const bl = comps['blockLayer'];
    const data = merged && isPlainObject(bl) ? bl['data'] : undefined;
    validateBlockLayerComponent(isPlainObject(bl) && data !== undefined ? Object.fromEntries(Object.entries(bl).filter(([k]) => k !== 'data')) : bl, `${path}/blockLayer`, errors);
    if (data !== undefined) validateSceneBlocks([data], [{ id: isPlainObject(data) ? data['entityId'] : undefined, components: { blockLayer: bl } }], errors, true);
    for (const other of ['model', 'box', 'camera', 'collider', 'controller', 'instances'] as const) {
      if (comps[other] !== undefined) errors.push(collisionConflict(path, `blockLayer and ${other} are mutually exclusive on one entity (a layer is its own level geometry)`, ['blockLayer', other]));
    }
    validateBlockLayerTransform(comps, parentId, ePath, errors);
  }
  // A prop's block footprint (any entity may carry one).
  if (comps['blockFootprint'] !== undefined) validateBlockFootprintComponent(comps['blockFootprint'], `${path}/blockFootprint`, errors);
  // Gameplay building blocks.
  for (const name of BLOCK_COMPONENT_NAMES) {
    if (comps[name] !== undefined) BLOCK_COMPONENTS[name].validate(comps[name], `${path}/${name}`, errors as unknown as Parameters<(typeof BLOCK_COMPONENTS)[typeof name]["validate"]>[2]);
  }
  if (comps['mover'] !== undefined && comps['controller'] !== undefined) errors.push(collisionConflict(path, 'a mover cannot carry the player controller', ['mover', 'controller']));
  // A patroller moves itself (not by input, a mover or physics); the character is never collected.
  if (comps['patrol'] !== undefined) {
    const clash = (['controller', 'mover', 'collider'] as const).filter((c) => comps[c] !== undefined);
    if (clash.length > 0) errors.push(collisionConflict(path, `a patrol moves the object by itself: it cannot also carry ${clash.join(', ')}`, ['patrol', ...clash]));
  }
  if (comps['collectible'] !== undefined && comps['controller'] !== undefined) errors.push(collisionConflict(path, 'the character collects; it is not collected', ['collectible', 'controller']));
  // A gravity body falls by itself (not a character, a mover or a physics body; a waypoint patrol sets its height itself).
  if (comps['gravity'] !== undefined) {
    const clash = (['controller', 'mover', 'collider'] as const).filter((c) => comps[c] !== undefined);
    if (clash.length > 0) errors.push(collisionConflict(path, `a gravity body falls by itself: it cannot also carry ${clash.join(', ')}`, ['gravity', ...clash]));
    const patrol = comps['patrol'];
    if (isPlainObject(patrol) && patrol['mode'] === 'waypoints') errors.push(collisionConflict(path, 'a waypoint patrol sets its own height: only an edge-to-edge patrol falls with gravity', ['gravity', 'patrol']));
  }
  if (comps['climbVolume'] !== undefined && comps['controller'] !== undefined) errors.push(collisionConflict(path, 'the character climbs in a climb volume; it is not one', ['climbVolume', 'controller']));
  if (comps['animator'] !== undefined) {
    validateAnimatorComponent(comps['animator'], `${path}/animator`, errors);
    if (comps['model'] === undefined) errors.push(componentMissing(`${path}/animator`, 'model', 'an animator sits only on an entity with a model'));
  }
  if (comps['surface'] !== undefined) validateSurfaceComponent(comps['surface'], `${path}/surface`, errors);
  if (comps['modelAnimation'] !== undefined) validateModelAnimationComponent(comps['modelAnimation'], `${path}/modelAnimation`, errors);

  // scene-local target rules
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
  // A virtual camera is a shot, not the scene camera (which draws whichever shot is live).
  if (comps['virtualCamera'] !== undefined && comps['camera'] !== undefined) {
    errors.push(
      withFound(
        {
          code: 'component_conflict',
          path: `${path}/virtualCamera`,
          message: 'a virtual camera is a separate shot: it does not sit on the scene camera',
          reason: 'camera_target',
          expected: 'no camera on a virtualCamera entity',
        },
        'virtualCamera',
      ),
    );
  }
  // A socket poses the entity every step — a physics body (posed by physics) or the scene camera (posed by its
  // camera module) cannot ride on one.
  if (comps['socketAttach'] !== undefined) {
    const clash = SOCKET_ATTACH_CONFLICTS.filter((c) => comps[c] !== undefined);
    if (clash.length > 0) {
      errors.push(
        withFound(
          {
            code: 'component_conflict',
            path: `${path}/socketAttach`,
            message: `an object on a socket is posed by the socket: it cannot also carry ${clash.join(', ')}`,
            reason: 'socket_attach',
            expected: `no ${SOCKET_ATTACH_CONFLICTS.join(', ')} on a socketAttach entity`,
          },
          'socketAttach',
        ),
      );
    }
  }
  if (comps['playerSpawn'] !== undefined && (comps['collider'] !== undefined || comps['controller'] !== undefined)) {
    errors.push(
      withFound(
        {
          code: 'component_conflict',
          path: `${path}/playerSpawn`,
          message: 'a playerSpawn is a marker and conflicts with collider and controller',
          reason: 'spawn_target',
          expected: 'no collider or controller on a playerSpawn entity',
        },
        'playerSpawn',
      ),
    );
  }

  const physicsBearing = comps['collider'] !== undefined || comps['controller'] !== undefined;
  if (physicsBearing) {
    // A v4 scene's rotation rules depend on the project's physics
    // dimension (content settings) and are checked with the content (composeSceneV4).
    validatePhysicsTransform(comps, parentId, ePath, comps['controller'] !== undefined, errors, version !== 4);
  }

  let points3d = 0;
  if (comps['collider'] !== undefined) {
    const shape = isPlainObject(comps['collider']) ? comps['collider']['shape'] : undefined;
    // A hull's points and a mesh's vertices count toward the scene's 3D point budget.
    if (isPlainObject(shape) && shape['type'] === 'convex' && Array.isArray(shape['points'])) points3d = shape['points'].length;
    if (isPlainObject(shape) && shape['type'] === 'mesh' && Array.isArray(shape['vertices'])) points3d = shape['vertices'].length;
  }
  const light = comps['light'];
  const lightType = isPlainObject(light) ? light['type'] : undefined;
  return {
    spawns: comps['playerSpawn'] !== undefined ? 1 : 0,
    directional: lightType === 'directional' ? 1 : 0,
    ambient: lightType === 'ambient' ? 1 : 0,
    local: lightType === 'point' || lightType === 'spot' ? 1 : 0,
    fogVolumes: comps['fogVolume'] !== undefined ? 1 : 0,
    hemisphere: lightType === 'hemisphere' ? 1 : 0,
    cameras: comps['camera'] !== undefined ? 1 : 0,
    controllers: comps['controller'] !== undefined ? 1 : 0,
    points3d,
  };
}

// ---- canonicalization ---------------------------------------




function canonicalLight(c: unknown): LightComponent {
  const o = c as Record<string, unknown>;
  const out: LightComponent = {
    type: o['type'] as LightComponent['type'],
    color: (o['color'] as string).toLowerCase(),
    intensity: canonNum(o['intensity']),
  };
  if (out.type === 'directional' || out.type === 'spot') {
    const dir = o['direction'] as unknown[];
    out.direction = [canonNum(dir[0]), canonNum(dir[1]), canonNum(dir[2])];
  }
  if (out.type === 'directional') out.castShadow = typeof o['castShadow'] === 'boolean' ? o['castShadow'] : false;
  // The directional shadow settings, kept when set.
  if (out.type === 'directional') for (const k of ['shadowMapSize', 'shadowBias', 'shadowNormalBias', 'shadowExtent'] as const) if (typeof o[k] === 'number') out[k] = canonNum(o[k]);
  if ((out.type === 'point' || out.type === 'spot') && typeof o['castShadow'] === 'boolean') out.castShadow = o['castShadow'];
  // Local-light fields, kept when set.
  for (const k of ['range', 'decay', 'angle', 'penumbra'] as const) if (typeof o[k] === 'number') out[k] = canonNum(o[k]);
  if (typeof o['groundColor'] === 'string') out.groundColor = o['groundColor'].toLowerCase();
  if (o['mode'] === 'baked' || o['mode'] === 'mixed') out.mode = o['mode'];
  if (out.type === 'spot' && typeof o['cookie'] === 'string') out.cookie = o['cookie'];
  return out;
}

export function canonicalSurface(c: unknown): SurfaceComponent {
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

function canonicalFlags(e: Record<string, unknown>): Pick<EntityV3, 'active' | 'visible' | 'locked' | 'static' | 'tags'> {
  return {
    ...(e['active'] === false ? { active: false as const } : {}),
    ...(e['visible'] === false ? { visible: false as const } : {}),
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
  if (comps['collider'] !== undefined) components.collider = { shape: canonicalCollider(comps['collider']), ...((comps['collider'] as { oneWay?: unknown }).oneWay === true ? { oneWay: true as const } : {}), ...(Array.isArray((comps['collider'] as { layers?: unknown }).layers) ? { layers: [...(comps['collider'] as { layers: string[] }).layers] } : {}) };
  if (comps['controller'] !== undefined) components.controller = canonicalController(comps['controller']);
  if (comps['playerSpawn'] !== undefined) {
    const { yaw } = comps['playerSpawn'] as { yaw?: number };
    components.playerSpawn = { ...(yaw !== undefined ? { yaw } : {}) };
  }
  if (comps['light'] !== undefined) components.light = canonicalLight(comps['light']);
  if (comps['surface'] !== undefined) components.surface = canonicalSurface(comps['surface']);
  if (comps['modelAnimation'] !== undefined) components.modelAnimation = canonicalModelAnimation(comps['modelAnimation']);
  if (comps['materials'] !== undefined) components.materials = canonicalMaterialMapping(comps['materials'] as Record<string, string>);
  if (comps['materialParams'] !== undefined) components.materialParams = canonicalMaterialParams(comps['materialParams'] as MaterialParamsComponent);
  if (comps['fogVolume'] !== undefined) components.fogVolume = canonicalFogVolume(comps['fogVolume'] as FogVolumeComponent);
  if (comps['animator'] !== undefined) components.animator = canonicalAnimatorComponent(comps['animator'] as AnimatorComponent);
  for (const name of BLOCK_COMPONENT_NAMES) {
    if (comps[name] !== undefined) (components as unknown as Record<string, unknown>)[name] = (BLOCK_COMPONENTS[name].canonical as (c: unknown) => unknown)(comps[name]);
  }
  if (comps['effect'] !== undefined) (components as { effect?: EffectComponent }).effect = canonicalEffectComponent(comps['effect'] as EffectComponent);
  // Last, so every existing entity keeps its exact canonical bytes.
  if (comps['virtualCamera'] !== undefined) (components as { virtualCamera?: VirtualCameraComponent }).virtualCamera = canonicalVirtualCamera(comps['virtualCamera'] as VirtualCameraComponent);
  if (comps['cameraPath'] !== undefined) (components as { cameraPath?: CameraPathComponent }).cameraPath = canonicalCameraPath(comps['cameraPath'] as CameraPathComponent);
  if (comps['blockLayer'] !== undefined) {
    // A merged runtime scene keeps the attached `data`.
    const bl = comps['blockLayer'] as BlockLayerComponent & { data?: BlockLayerData };
    (components as { blockLayer?: BlockLayerComponent }).blockLayer = { ...canonicalBlockLayerComponent(bl), ...(bl.data !== undefined ? { data: bl.data } : {}) } as BlockLayerComponent;
  }
  if (comps['blockFootprint'] !== undefined) (components as { blockFootprint?: BlockFootprintComponent }).blockFootprint = canonicalBlockFootprint(comps['blockFootprint'] as BlockFootprintComponent);
  // Last, so every existing entity keeps its exact canonical bytes.
  if (comps['socketAttach'] !== undefined) (components as { socketAttach?: SocketAttachComponent }).socketAttach = canonicalSocketAttach(comps['socketAttach'] as SocketAttachComponent);
  // After that (existing entities keep their bytes).
  if (comps['behaviorGroup'] !== undefined) (components as { behaviorGroup?: BehaviorGroupComponent }).behaviorGroup = canonicalBehaviorGroup(comps['behaviorGroup'] as BehaviorGroupComponent);
  // After that (existing entities keep their bytes).
  if (comps['cameraRegion'] !== undefined) (components as { cameraRegion?: CameraRegionComponent }).cameraRegion = canonicalCameraRegion(comps['cameraRegion'] as CameraRegionComponent);
  if (comps['instances'] !== undefined) {
    const i = comps['instances'] as { asset: { assetId: string; piece?: string }; buffer: string; count: number; castShadow?: boolean; receiveShadow?: boolean; chunkSize?: number };
    components.instances = {
      asset: { assetId: i.asset.assetId, ...(i.asset.piece !== undefined ? { piece: i.asset.piece } : {}) },
      buffer: i.buffer,
      count: i.count,
      // Kept only when set (an existing set keeps its exact canonical bytes).
      ...(typeof i.castShadow === 'boolean' ? { castShadow: i.castShadow } : {}),
      ...(typeof i.receiveShadow === 'boolean' ? { receiveShadow: i.receiveShadow } : {}),
      // Kept only when set.
      ...(typeof i.chunkSize === 'number' ? { chunkSize: i.chunkSize } : {}),
    };
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

export function validateSceneV3Value(doc: Record<string, unknown>, version: 3 | 4 = 3, merged = false): SceneV3ValueResult {
  const errors: ModelErrorV3[] = [];
  // A merged runtime scene (several scenes loaded together) is bounded by the project, not one scene.
  const maxEntities = merged ? MAX_ENTITIES_V4 * 64 : version === 4 ? MAX_ENTITIES_V4 : MAX_ENTITIES_V2;
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
    const counts: EntityV3Counts = { ...EMPTY_COUNTS };
    // Folders have no transform, so the "must be a root" rules
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
      // A folder is left out of the game, so hiding it would hide nothing.
      if (e['visible'] === false && isPlainObject(e['components']) && (e['components'] as Record<string, unknown>)['folder'] !== undefined) {
        errors.push(fieldValue(`${base}/visible`, false, 'true or absent on a folder', 'a folder is not in the game; hide the objects in it'));
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
        const c = validateEntityComponentsV3(comps, objectParent(pid) ?? undefined, base, errors, version, merged);
        counts.spawns += c.spawns;
        counts.directional += c.directional;
        counts.ambient += c.ambient;
        counts.local += c.local;
        counts.fogVolumes += c.fogVolumes;
        counts.hemisphere += c.hemisphere;
        counts.cameras += c.cameras;
        counts.controllers += c.controllers;
        counts.points3d += c.points3d;
      }
      for (const k of Object.keys(e)) {
        if (!KNOWN_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${base}/${pointerSegment(k)}`, k, ['id', 'name', 'parentId', ...ENTITY_FLAGS, 'tags', 'components'].join(', ')));
      }
    }

    // hierarchy: reference, cycle, order
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
    if (!merged && counts.points3d > COLLIDER_3D_LIMITS.pointsTotal) {
      errors.push(limitsError('/entities', 'collider_vertices_total', counts.points3d, COLLIDER_3D_LIMITS.pointsTotal, `scene exceeds the total 3D collider point limit of ${COLLIDER_3D_LIMITS.pointsTotal} (hull points and mesh vertices)`));
    }
    // v3 scene limits (per scene: a merged runtime scene holds several)
    if (!merged && counts.spawns > SCENE_LIMITS_V3.playerSpawns) {
      errors.push(
        limitsError('/entities', 'player_spawns', counts.spawns, SCENE_LIMITS_V3.playerSpawns, `scene exceeds the player-spawn limit of ${SCENE_LIMITS_V3.playerSpawns}`),
      );
    }
    // Light counts are per scene (a merged runtime scene holds several scenes' lights; the renderer picks).
    if (!merged && counts.directional > SCENE_LIMITS_V3.lightsDirectional) {
      errors.push(
        limitsError('/entities', 'lights_directional', counts.directional, SCENE_LIMITS_V3.lightsDirectional, 'scene exceeds the directional-light limit'),
      );
    }
    if (!merged && counts.ambient > SCENE_LIMITS_V3.lightsAmbient) {
      errors.push(limitsError('/entities', 'lights_ambient', counts.ambient, SCENE_LIMITS_V3.lightsAmbient, 'scene exceeds the ambient-light limit'));
    }
    if (!merged && counts.local > MAX_LOCAL_LIGHTS) {
      errors.push(limitsError('/entities', 'lights_local', counts.local, MAX_LOCAL_LIGHTS, `a scene holds at most ${MAX_LOCAL_LIGHTS} point and spot lights`));
    }
    if (counts.fogVolumes > MAX_FOG_VOLUMES) {
      errors.push(limitsError('/entities', 'zones', counts.fogVolumes, MAX_FOG_VOLUMES, `a scene holds at most ${MAX_FOG_VOLUMES} fog volumes`));
    }
    if (!merged && counts.hemisphere > MAX_HEMISPHERE_LIGHTS) {
      errors.push(limitsError('/entities', 'lights_ambient', counts.hemisphere, MAX_HEMISPHERE_LIGHTS, 'a scene holds at most one hemisphere light'));
    }
    checkDepthLimit(entities, idFirstIndex, errors);
  }

  const knownScene = version === 4 ? KNOWN_SCENE_FIELDS_V4 : KNOWN_SCENE_FIELDS;
  for (const k of Object.keys(doc)) {
    if (!knownScene.has(k)) errors.push(unexpectedField(`/${pointerSegment(k)}`, k, [...knownScene].join(', ')));
  }
  // The scene's block-layer cells and regions.
  if (version === 4 && doc['blocks'] !== undefined && entities !== null) validateSceneBlocks(doc['blocks'], entities, errors, merged);
  if (errors.length > 0) return { errors };
  const canonical = canonicalSceneV3(doc, entities as unknown[], version);
  checkFolderHierarchy(canonical, errors);
  if (errors.length > 0) return { errors };
  return { errors, doc: canonical };
}

/**
 * Hierarchy rules over a structurally valid scene: a folder sits at the root
 * or in another folder; the camera and the spawns the scene relies on are
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
  });
}

function canonicalSceneV3(doc: Record<string, unknown>, ents: unknown[], version: 3 | 4 = 3): SceneV3 {
  if (version === 4) {
    // `blocks` present only when a layer holds cells or regions.
    const blocks = Array.isArray(doc['blocks']) ? canonicalSceneBlocks(doc['blocks'] as BlockLayerData[]) : null;
    return {
      schemaVersion: 4,
      sceneId: doc['sceneId'] as string,
      revision: canonNum(doc['revision']),
      entities: (ents as Record<string, unknown>[]).map(canonicalEntityV3),
      ...(blocks !== null ? { blocks } : {}),
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

/** The explicit `schemaVersion` 3 scene validator. */
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

/** Validate, then return the new canonical v3 document. */
export function normalizeSceneV3(doc: unknown): ModelResultV3<SceneV3> {
  return validateSceneV3(doc);
}

/**
 * A runtime scene made of several v4 scenes loaded together
 * (the start set, merged by the host): the v4 rules without the per-scene
 * limits (spawn/collider counts, the entity cap).
 */
export function validateMergedSceneV4(doc: unknown): ModelResultV3<SceneV4> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  if (doc['schemaVersion'] !== 4) {
    return fail([fieldValue('/schemaVersion', doc['schemaVersion'], '4', 'a merged runtime scene is schemaVersion 4')]);
  }
  const { errors, doc: canonical } = validateSceneV3Value(doc, 4, true);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as unknown as SceneV4 };
}

/**
 * The `schemaVersion` 4 scene validator — the v3 rules plus
 * instance sets, exit zones, optional camera-follow bounds and at
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
