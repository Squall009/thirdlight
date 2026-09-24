/**
 * v3 command helpers — commands.md §§3.1/5.4/8.5.1/8.10/8.13–8.14 and
 * project-model.md §§23.3–23.9 (packet 45).
 *
 * Pure helpers shared by the forward ops and the history engine:
 * - the canonical field order of every `setComponent` component and of
 *   `content.game`;
 * - the delegation of a v3 component VALUE to the project-model's
 *   per-component validators (one value authority, project-model §23.3) with
 *   the command-layer error shape (`CommandError`);
 * - the packet-41 `modelAnimation` role-binding stages 2–4 (shape, range,
 *   duplicates), which project-model §23.3.6 deliberately leaves to the
 *   command layer (`presentation.md` §41.3.2);
 * - the §23.6/§23.9 dangling-game-reference scan (one implementation for
 *   deletion, component removal and the game-config edit).
 *
 * No I/O, no transport, no renderer: values in, values out.
 */

import { BLOCK_COMPONENTS, validateAnimatorComponent, validateFogVolumeComponent, validateMaterialMapping } from '@thirdlight/project-model';
import {
  validateCameraFollowComponent,
  validateInstancesComponent,
  validateGameZoneComponent,
  validateLightComponent,
  validateModelAnimationComponent,
  validatePlayerSpawnComponent,
  validateSurfaceComponent,
  type GameConfig,
  type ModelErrorV3,
  type SceneV3,
} from '@thirdlight/project-model';

import { animationRoleDuplicate, animationRoleOutOfRange } from './errors';
import type {
  CommandAssetRecord,
  CommandError,
  ContentDocument,
  SurfacePresetName,
  V3OwnedComponent,
} from './types';

/** §23.3 registry field order for the components `setComponent` can edit. */
export const COMPONENT_FIELD_ORDER_V3: Record<V3OwnedComponent, readonly string[]> = {
  gameZone: ['role', 'size', 'safeSpawnId', 'activation', 'load', 'unload', 'spawnId', 'damage'],
  playerSpawn: [],
  cameraFollow: ['deadZone', 'smoothing', 'bounds', 'distance', 'maxSpeed'],
  light: ['type', 'color', 'intensity', 'direction', 'castShadow', 'range', 'decay', 'angle', 'penumbra', 'groundColor', 'mode'],
  surface: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
  modelAnimation: ['assetId', 'version', 'roles'],
  instances: ['asset', 'buffer', 'count'],
  // Phase 9.4: free-form keys (material names); a setComponent replaces the whole mapping.
  materials: [],
  fogVolume: ['size', 'density', 'color', 'falloff', 'heightFalloff'],
  animator: ['controller', 'parameters'],
  // Phase 9.9: gameplay building blocks.
  mover: ['waypoints', 'speed', 'mode', 'wait', 'easing', 'startOn', 'maxPush'],
  audioSource: ['assetId', 'volume', 'range'],
  faceMovement: ['yawRight', 'yawLeft', 'turnSeconds'],
  trigger: ['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode'],
  switch: ['mode', 'signal', 'size', 'once'],
  health: ['max', 'start', 'invulnerableSeconds', 'knockback', 'hitBounce', 'knockbackTime'],
  pickup: ['kind', 'value', 'counter', 'size', 'respawn', 'cue'],
  enemy: ['patrol', 'range', 'speed', 'size', 'contactDamage', 'stompable', 'health', 'chase', 'chaseHeight', 'stompBounce', 'stompTolerance', 'defeat', 'defeatTime', 'wallProbe', 'ledgeProbe'],
};

/** §8.13: `applySurfacePreset`'s `changedFields` (the surface field order). */
export const SURFACE_CHANGED_FIELDS: readonly string[] = COMPONENT_FIELD_ORDER_V3.surface;

/** §23.4 canonical top-level order of `content.game`. */
export const GAME_CONFIG_FIELDS = [
  'configVersion',
  'title',
  'objective',
  'instructions',
  'playerId',
  'cameraId',
  'spawnId',
  'level',
  'killY',
  'cues',
  // Phase 15.3 (v4): the session timing (optional; `null` in a partial edit goes back to the default).
  'respawnDelay',
  'dropThroughTime',
  'settleTime',
] as const;

/** §41.3.1 the three role keys, in canonical order. */
export const ANIMATION_ROLE_KEYS = ['idle', 'run', 'airborne'] as const;

/** All six v3 add-capable components, in §8.10 table order. */
export const V3_COMPONENTS: readonly V3OwnedComponent[] = [
  'gameZone',
  'playerSpawn',
  'cameraFollow',
  'light',
  'surface',
  'modelAnimation',
  // Phase 12 (c): v4 scenes only (a v3 scene's registry refuses it).
  'instances',
  // Phase 9.4: v4 scenes only.
  'materials',
  // Phase 9.5: v4 scenes only.
  'fogVolume',
  // Phase 9.7: v4 scenes only.
  'animator',
  // Phase 9.9: v4 scenes only.
  'mover',
  'trigger',
  'switch',
  'health',
  'pickup',
  'enemy',
  'audioSource',
  'faceMovement',
];

/** Every component `setComponent` may address (commands.md §8.10). */
export const ALL_OWNED_COMPONENTS = [
  'box',
  'camera',
  'model',
  'collider',
  'controller',
  ...V3_COMPONENTS,
] as const;

/** §8.10: components that support `add`/`remove` (never `box`/`camera`/`model`). */
export const REMOVABLE_COMPONENTS: readonly string[] = [
  'collider',
  'controller',
  ...V3_COMPONENTS,
];

/** The three built-in preset names (project-model §23.3.5). */
export const SURFACE_PRESET_NAMES: readonly SurfacePresetName[] = [
  'matte-ground',
  'hazard',
  'beacon',
];

/**
 * Map one project-model error into the command-layer error shape, keeping the
 * §5.2 key order (`code`, `cls`, code-specific fields, `message`).
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
 * §23.3: delegate one v3 component VALUE to the project-model's per-component
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
  /** The scene's schemaVersion: v4 adds exit zones, optional camera bounds and instance sets. */
  version: 3 | 4 = 3,
): ModelErrorV3[] {
  const errors: ModelErrorV3[] = [];
  switch (component) {
    case 'gameZone':
      validateGameZoneComponent(value, path, errors, version);
      break;
    case 'playerSpawn':
      validatePlayerSpawnComponent(value, path, errors);
      break;
    case 'cameraFollow':
      validateCameraFollowComponent(value, path, errors, version);
      break;
    case 'instances':
      validateInstancesComponent(value, path, errors);
      break;
    case 'materials':
      validateMaterialMapping(value, path, errors as unknown as Parameters<typeof validateMaterialMapping>[2]);
      break;
    case 'fogVolume':
      validateFogVolumeComponent(value, path, errors as unknown as Parameters<typeof validateFogVolumeComponent>[2]);
      break;
    case 'animator':
      validateAnimatorComponent(value, path, errors as unknown as Parameters<typeof validateAnimatorComponent>[2]);
      break;
    case 'mover':
    case 'trigger':
    case 'switch':
    case 'health':
    case 'pickup':
    case 'enemy':
    case 'audioSource':
    case 'faceMovement':
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

/** §41.3.2 stage 2: each binding is exactly `{ clipIndex, clipName }`. */
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
 * §41.3.2 stages 3–4 against the named immutable version's clip count
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

/** §23.3.7: the record's kind, defaulting a v2 record to `model`. */
export function assetKindOf(record: { kind?: unknown }): 'model' | 'audio' | 'texture' | 'music' {
  return record.kind === 'audio' ? 'audio' : record.kind === 'texture' ? 'texture' : record.kind === 'music' ? 'music' : 'model';
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

/**
 * `content.game`'s reference to a deleted/removed entity closure
 * (project-model §23.6): the envelope-document JSON Pointers that would
 * dangle, ascending codepoint order. `playerId`/`cameraId`/`spawnId` plus
 * every checkpoint's `safeSpawnId`.
 */
export function danglingGameReferences(
  scene: Pick<SceneV3, 'entities'>,
  game: GameConfig | null | undefined,
  closure: ReadonlySet<string>,
): string[] {
  const refs: string[] = [];
  if (game !== null && game !== undefined) {
    if (closure.has(game.playerId)) refs.push('/game/playerId');
    if (closure.has(game.cameraId)) refs.push('/game/cameraId');
    if (closure.has(game.spawnId)) refs.push('/game/spawnId');
  }
  scene.entities.forEach((e, i) => {
    // A checkpoint going away together with its safe spawn leaves nothing dangling.
    if (closure.has(e.id)) return;
    const zone = (e.components as { gameZone?: { safeSpawnId?: unknown } }).gameZone;
    if (zone !== undefined && typeof zone.safeSpawnId === 'string' && closure.has(zone.safeSpawnId)) {
      refs.push(`/entities/${i}/components/gameZone/safeSpawnId`);
    }
  });
  return refs.sort();
}

/** §5.6/§A6: an entity "carries" a component when the key is present. */
export function entityHasComponent(
  entity: { components: Record<string, unknown> },
  component: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(entity.components, component);
}

/** `content.game`, treating a v2 catalog (no `game` key) as `null`. */
export function gameOf(content: ContentDocument | undefined): GameConfig | null {
  if (content === undefined) return null;
  return content.game ?? null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 6901 escaping for one JSON Pointer segment. */
function pointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
