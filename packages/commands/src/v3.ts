/**
 * v3 command helpers.
 *
 * Pure helpers shared by the forward ops and the history engine:
 * - the canonical field order of every `setComponent` component;
 * - the delegation of a v3 component VALUE to the project-model's
 *   per-component validators (one value authority) with
 *   the command-layer error shape (`CommandError`);
 * - the `modelAnimation` role-binding stages 2–4 (shape, range,
 *   duplicates), which the project model deliberately leaves to the
 *   command layer.
 *
 * No I/O, no transport, no renderer: values in, values out.
 */

import { CAMERA_PATH_FIELDS, CAMERA_REGION_FIELDS, VIRTUAL_CAMERA_FIELDS, validateCameraPathComponent, validateCameraRegionComponent, validateVirtualCameraComponent } from '@thirdlight/project-model';
import { BLOCK_LAYER_FIELDS, validateBlockLayerComponent, validateBlockFootprintComponent } from '@thirdlight/project-model';
import { validateBehaviorGroupComponent } from '@thirdlight/project-model';
import { SOCKET_ATTACH_FIELDS, validateSocketAttachComponent } from '@thirdlight/project-model';
import { BLOCK_COMPONENTS, validateAnimatorComponent, validateFogVolumeComponent, validateMaterialMapping, validateMaterialParamsComponent, validateEffectComponent } from '@thirdlight/project-model';
import {
  validateInstancesComponent,
  validateLightComponent,
  validateModelAnimationComponent,
  validatePlayerSpawnComponent,
  validateSurfaceComponent,
  type ModelErrorV3,
} from '@thirdlight/project-model';

import { animationRoleDuplicate, animationRoleOutOfRange } from './errors';
import type {
  CommandAssetRecord,
  CommandError,
  ContentDocument,
  SurfacePresetName,
  V3OwnedComponent,
} from './types';

/** Registry field order for the components `setComponent` can edit. */
export const COMPONENT_FIELD_ORDER_V3: Record<V3OwnedComponent, readonly string[]> = {
  // A v4 spawn's yaw (optional; the left/right facing became it).
  playerSpawn: ['yaw'],
  light: ['type', 'color', 'intensity', 'direction', 'castShadow', 'range', 'decay', 'angle', 'penumbra', 'groundColor', 'mode', 'shadowMapSize', 'shadowBias', 'shadowNormalBias', 'shadowExtent', 'cookie'],
  surface: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
  modelAnimation: ['assetId', 'version', 'roles'],
  instances: ['asset', 'buffer', 'count', 'castShadow', 'receiveShadow', 'chunkSize'],
  // Free-form keys (material names); a setComponent replaces the whole mapping.
  materials: [],
  fogVolume: ['size', 'density', 'color', 'falloff', 'heightFalloff'],
  animator: ['controller', 'parameters', 'startTime', 'randomStart'],
  // Gameplay building blocks.
  mover: ['waypoints', 'speed', 'mode', 'wait', 'easing', 'startOn', 'maxPush', 'active', 'stopOn', 'toggleOn', 'reverseOn'],
  audioSource: ['assetId', 'volume', 'range', 'distanceModel', 'refDistance', 'rolloff'],
  faceMovement: ['yawRight', 'yawLeft', 'turnSeconds', 'mode', 'yawOffset'],
  trigger: ['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode', 'height', 'sceneTransition'],
  switch: ['mode', 'signal', 'size', 'once', 'action'],
  health: ['max', 'start'],
  // Free-form keys (materialIds); a setComponent replaces the whole value.
  materialParams: [],
  // The effect and its parameter overrides (`params` is replaced whole).
  effect: ['effectId', 'playOnStart', 'params', 'signal', 'stopSignal'],
  // The camera framework (project-model cameras.ts field order).
  virtualCamera: VIRTUAL_CAMERA_FIELDS,
  cameraPath: CAMERA_PATH_FIELDS,
  // Sockets (project-model sockets.ts field order).
  socketAttach: SOCKET_ATTACH_FIELDS,
  // A block layer's settings (its cells are editBlocks' data).
  blockLayer: BLOCK_LAYER_FIELDS,
  // A prop's block footprint (`set` is replaced whole).
  blockFootprint: ['layer', 'size', 'set'],
  // The behavior group an entity's behavior belongs to (game modes tick groups).
  behaviorGroup: ['group'],
  // The generic primitives (project-model blocks.ts field order).
  collectible: ['counter', 'amount', 'respawn', 'onCollect', 'size'],
  patrol: ['mode', 'waypoints', 'loop', 'speed', 'wait', 'direction', 'size', 'wallProbe', 'ledgeProbe'],
  hitbox: ['shape', 'size', 'radius', 'damage'],
  climbVolume: ['size'],
  gravity: ['scale', 'size'],
  // A camera region (project-model cameras.ts field order).
  cameraRegion: CAMERA_REGION_FIELDS,
};

/** `applySurfacePreset`'s `changedFields` (the surface field order). */
export const SURFACE_CHANGED_FIELDS: readonly string[] = COMPONENT_FIELD_ORDER_V3.surface;

/** The three role keys, in canonical order. */
export const ANIMATION_ROLE_KEYS = ['idle', 'run', 'airborne'] as const;

/** All six v3 add-capable components, in `setComponent` table order. */
export const V3_COMPONENTS: readonly V3OwnedComponent[] = [
  'playerSpawn',
  'light',
  'surface',
  'modelAnimation',
  // v4 scenes only (a v3 scene's registry refuses it).
  'instances',
  // v4 scenes only.
  'materials',
  // v4 scenes only.
  'fogVolume',
  // v4 scenes only.
  'animator',
  // v4 scenes only.
  'mover',
  'trigger',
  'switch',
  'health',
  'audioSource',
  'faceMovement',
  // v4 scenes only.
  'materialParams',
  // v4 scenes only.
  'effect',
  // v4 scenes only.
  'virtualCamera',
  'cameraPath',
  // v4 scenes only.
  'socketAttach',
  // v4 scenes only.
  'blockLayer',
  // v4 scenes only.
  'blockFootprint',
  // v4 scenes only.
  'behaviorGroup',
  // v4 scenes only.
  'collectible',
  'patrol',
  'hitbox',
  // v4 scenes only.
  'climbVolume',
  'gravity',
  // v4 scenes only.
  'cameraRegion',
];

/** Every component `setComponent` may address. */
export const ALL_OWNED_COMPONENTS = [
  'box',
  'model',
  'collider',
  'controller',
  ...V3_COMPONENTS,
] as const;

/** Components that support `add`/`remove` (`box`/`model` too). */
export const REMOVABLE_COMPONENTS: readonly string[] = [
  'box',
  'model',
  'collider',
  'controller',
  ...V3_COMPONENTS,
];

/** The built-in preset names (generic names). */
export const SURFACE_PRESET_NAMES: readonly SurfacePresetName[] = [
  'matte-ground',
  'signal-red',
  'emissive-accent',
];

/**
 * Map one project-model error into the command-layer error shape, keeping the
 * error key order (`code`, `cls`, code-specific fields, `message`).
 */
export function commandErrorFromModel(e: ModelErrorV3): CommandError {
  const out: Record<string, unknown> = { code: e.code, cls: 'validation' };
  if (e.path !== undefined) out['path'] = e.path;
  if (e.reason !== undefined) out['reason'] = e.reason;
  if (e.limit !== undefined) out['limit'] = e.limit;
  if (e.current !== undefined) out['current'] = e.current;
  if (e.max !== undefined) out['max'] = e.max;
  if (e.found !== undefined) out['found'] = e.found;
  if (e.expected !== undefined) out['expected'] = e.expected;
  out['message'] = e.message;
  if (e.hint !== undefined) out['hint'] = e.hint;
  return out as unknown as CommandError;
}

/**
 * Delegate one v3 component VALUE to the project-model's per-component
 * validator. `path` is the request path the diagnostics are reported against
 * (`/args/value` for `setComponent`, `/args/components/<name>` for
 * `createEntity`). Structural value rules only — scene-local target rules
 * (surface/modelAnimation placement, zone transforms, conflicts, counts,
 * references) run in the resulting-state gate.
 */
export function validateV3ComponentValue(
  component: V3OwnedComponent,
  value: unknown,
  path: string,
  /** The scene's schemaVersion: v4 adds instance sets and the v4 fields. */
  version: 3 | 4 = 3,
): ModelErrorV3[] {
  const errors: ModelErrorV3[] = [];
  switch (component) {
    case 'playerSpawn':
      validatePlayerSpawnComponent(value, path, errors, version);
      break;
    case 'instances':
      validateInstancesComponent(value, path, errors);
      break;
    case 'materials':
      validateMaterialMapping(value, path, errors as unknown as Parameters<typeof validateMaterialMapping>[2]);
      break;
    case 'materialParams':
      validateMaterialParamsComponent(value, path, errors as unknown as Parameters<typeof validateMaterialParamsComponent>[2]);
      break;
    case 'effect':
      validateEffectComponent(value, path, errors as unknown as Parameters<typeof validateEffectComponent>[2]);
      break;
    case 'virtualCamera':
      validateVirtualCameraComponent(value, path, errors as unknown as Parameters<typeof validateVirtualCameraComponent>[2]);
      break;
    case 'cameraPath':
      validateCameraPathComponent(value, path, errors as unknown as Parameters<typeof validateCameraPathComponent>[2]);
      break;
    case 'cameraRegion':
      validateCameraRegionComponent(value, path, errors as unknown as Parameters<typeof validateCameraRegionComponent>[2]);
      break;
    case 'socketAttach':
      validateSocketAttachComponent(value, path, errors as unknown as Parameters<typeof validateSocketAttachComponent>[2]);
      break;
    case 'fogVolume':
      validateFogVolumeComponent(value, path, errors as unknown as Parameters<typeof validateFogVolumeComponent>[2]);
      break;
    case 'blockLayer':
      validateBlockLayerComponent(value, path, errors as unknown as Parameters<typeof validateBlockLayerComponent>[2]);
      break;
    case 'blockFootprint':
      validateBlockFootprintComponent(value, path, errors as unknown as Parameters<typeof validateBlockFootprintComponent>[2]);
      break;
    case 'behaviorGroup':
      validateBehaviorGroupComponent(value, path, errors as unknown as Parameters<typeof validateBehaviorGroupComponent>[2]);
      break;
    case 'animator':
      validateAnimatorComponent(value, path, errors as unknown as Parameters<typeof validateAnimatorComponent>[2]);
      break;
    case 'mover':
    case 'trigger':
    case 'switch':
    case 'health':
    case 'audioSource':
    case 'faceMovement':
    case 'collectible':
    case 'patrol':
    case 'hitbox':
    case 'climbVolume':
    case 'gravity':
      BLOCK_COMPONENTS[component].validate(value, path, errors as unknown as Parameters<typeof validateAnimatorComponent>[2]);
      break;
    case 'light':
      validateLightComponent(value, path, errors, version);
      break;
    case 'surface':
      validateSurfaceComponent(value, path, errors);
      break;
    case 'modelAnimation':
      validateModelAnimationComponent(value, path, errors);
      validateAnimationRolesShape(value, path, errors);
      break;
  }
  return errors;
}

/** Role-binding stage 2: each binding is exactly `{ clipIndex, clipName }`. */
export function validateAnimationRolesShape(
  value: unknown,
  path: string,
  errors: ModelErrorV3[],
): void {
  if (!isPlainObject(value)) return;
  const roles = value['roles'];
  if (!isPlainObject(roles)) return; // the model reports the container type
  for (const key of ANIMATION_ROLE_KEYS) {
    const binding = roles[key];
    if (!isPlainObject(binding)) continue; // the model reports the container rule
    const bindingPath = `${path}/roles/${key}`;
    const index = binding['clipIndex'];
    if (index === undefined) {
      errors.push({ code: 'field_missing', path: `${bindingPath}/clipIndex`, message: "required field 'clipIndex' is missing", expected: 'present' });
    } else if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      errors.push({
        code: 'field_value',
        path: `${bindingPath}/clipIndex`,
        message: 'clipIndex must be a non-negative integer',
        expected: 'integer >= 0',
        found: index,
      });
    }
    const name = binding['clipName'];
    if (name === undefined) {
      errors.push({ code: 'field_missing', path: `${bindingPath}/clipName`, message: "required field 'clipName' is missing", expected: 'present' });
    } else if (typeof name !== 'string') {
      errors.push({ code: 'field_type', path: `${bindingPath}/clipName`, message: 'value must be of type string', expected: 'string', found: name });
    } else if (name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
      errors.push({
        code: 'field_value',
        path: `${bindingPath}/clipName`,
        message: 'clipName must be 1-128 characters without control characters',
        expected: 'string, 1-128 chars, no control characters',
        found: name,
      });
    }
    for (const k of Object.keys(binding)) {
      if (k !== 'clipIndex' && k !== 'clipName') {
        errors.push({
          code: 'field_unexpected',
          path: `${bindingPath}/${pointerSegment(k)}`,
          message: 'unknown field is not permitted (strict schema drops nothing)',
          expected: 'known fields: clipIndex, clipName',
          found: k,
        });
      }
    }
  }
}

/**
 * Role-binding stages 3–4 against the named immutable version's clip count
 * (`metrics.animations`): pure, no bytes needed. Returns the first failing
 * command error, or `null`.
 */
export function validateAnimationRoleRange(
  roles: unknown,
  clipCount: number,
  path: string,
): CommandError | null {
  if (!isPlainObject(roles)) return null;
  const seen = new Map<number, string>();
  for (const key of ANIMATION_ROLE_KEYS) {
    const binding = roles[key];
    if (!isPlainObject(binding)) continue;
    const index = binding['clipIndex'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    if (index >= clipCount) {
      return animationRoleOutOfRange(path, key, index, clipCount);
    }
    const first = seen.get(index);
    if (first !== undefined) return animationRoleDuplicate(path, index, [first, key]);
    seen.set(index, key);
  }
  return null;
}

/**
 * The v3 view of `content.assets` (the v2 catalog shape carries the same
 * values; only the `kind` discriminator and the `pcm-wav` recipe shape widen).
 */
export function assetsOf(content: ContentDocument): CommandAssetRecord[] {
  return content.assets as unknown as CommandAssetRecord[];
}

/** The record's kind, defaulting a v2 record to `model`. */
export function assetKindOf(record: { kind?: unknown }): 'model' | 'audio' | 'texture' | 'font' {
  return record.kind === 'audio' ? 'audio' : record.kind === 'texture' ? 'texture' : record.kind === 'font' ? 'font' : 'model';
}

/** The asset record's immutable version for `modelAnimation.version`, if resolvable. */
export function animationVersionOf(
  assets: readonly CommandAssetRecord[],
  assetId: unknown,
  version: unknown,
): CommandAssetRecord['versions'][number] | undefined {
  if (typeof assetId !== 'string' || typeof version !== 'number') return undefined;
  const record = assets.find((a) => a.assetId === assetId);
  if (record === undefined) return undefined;
  return record.versions.find((v) => v.version === version);
}

/** An entity "carries" a component when the key is present. */
export function entityHasComponent(
  entity: { components: Record<string, unknown> },
  component: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(entity.components, component);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 6901 escaping for one JSON Pointer segment. */
function pointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
