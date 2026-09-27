/**
 * Strict `args` schema validation for the non-prefab M2 mutation ops
 * (commands.md §3.1.1/§3.1.4–§3.1.8, §8.5–§8.12) — packet 21.
 *
 * Same conventions as the M1 args pass (`validate-request.ts`): unknown
 * fields ⇒ `field_unexpected`; missing ⇒ `field_missing`; wrong JSON type ⇒
 * `field_type`; right type / wrong value ⇒ `field_value`. Structural checks
 * live here; the model remains the authority for document value rules, so
 * numeric ranges, recipe/metrics internals and timestamps are re-checked by
 * the resulting-document validation (step 5) unless the contract names an
 * op-level error (for example `setting_unknown` or `id_invalid`).
 *
 * Op-level precondition order (existence, reference resolution, compatibility)
 * is owned by the op implementations (`content-ops.ts`), not by this pass:
 * commands.md §6.1 step 4 checks the revision BEFORE any argument validation.
 */

import {
  ID_RE,
  digestInvalid,
  fieldMissing,
  fieldType,
  fieldUnexpected,
  fieldValue,
  idInvalid,
  isPlainObject,
  isValidName,
  limitsExceeded,
  settingUnknown,
} from './errors';
import { CAMERA_PATH_FIELDS, VIRTUAL_CAMERA_FIELDS, isValidSourcePath, type PropertyValue, type SettingsKeySpec } from '@thirdlight/project-model';
import { SURFACE_PRESET_NAMES } from './v3';
import type {
  AcknowledgeBehaviorTrustArgs,
  ApplySurfacePresetArgs,
  CommandError,
  OwnedComponent,
  PublishAssetArgs,
  PublishBehaviorArgs,
  SetBehaviorPropertiesArgs,
  SetComponentArgs,
  SetGameConfigArgs,
  SetSettingsArgs,
} from './types';

/** 64 lowercase hex characters (project-model §18.3/§22.2). */
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** `^[a-z][a-z0-9_]{0,63}$` — property/settings key syntax (project-model §20.5). */
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

const ASSET_ID_EXPECTED = 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}';

export interface ArgsOk<T> {
  ok: true;
  args: T;
}

export function validatePublishAssetArgs(
  args: Record<string, unknown>,
): ArgsOk<PublishAssetArgs> | { ok: false; error: CommandError } {
  const KNOWN =
    'mode, assetId, kind (required on create), displayName (optional), sourceDigest, sourceByteLength, sourcePath (optional), convertedFrom (optional), importRecipe, metrics, importedAt, animation (reimport only)';
  for (const key of Object.keys(args)) {
    if (!['mode', 'assetId', 'kind', 'displayName', 'sourceDigest', 'sourceByteLength', 'sourcePath', 'convertedFrom', 'importRecipe', 'metrics', 'importedAt', 'animation'].includes(key)) {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, KNOWN) };
    }
  }
  if (args['mode'] === undefined) return { ok: false, error: fieldMissing('/args/mode', 'mode') };
  if (typeof args['mode'] !== 'string' || (args['mode'] !== 'create' && args['mode'] !== 'reimport')) {
    return {
      ok: false,
      error: fieldValue(
        '/args/mode',
        args['mode'],
        '"create" or "reimport"',
        'mode must be "create" or "reimport"',
      ),
    };
  }
  // §3.1.1/§23.3.7: `kind` is required on create for a v3 state and optional
  // on reimport (where it must equal the record's kind). The state-aware
  // requirement lives in the op — the accepted v2 fixtures create model
  // records without it (handoff 45 CC-45-4).
  if (args['kind'] !== undefined && args['kind'] !== 'model' && args['kind'] !== 'audio' && args['kind'] !== 'texture' && args['kind'] !== 'music') {
    return {
      ok: false,
      error: fieldValue('/args/kind', args['kind'], '"model", "audio", "texture" or "music"', 'kind must be "model", "audio", "texture" or "music"'),
    };
  }
  if (args['assetId'] === undefined) return { ok: false, error: fieldMissing('/args/assetId', 'assetId') };
  if (typeof args['assetId'] !== 'string') {
    return { ok: false, error: fieldType('/args/assetId', args['assetId'], 'string (asset ID)') };
  }
  if (!ID_RE.test(args['assetId'])) {
    return { ok: false, error: idInvalid('/args/assetId', args['assetId'], ASSET_ID_EXPECTED) };
  }
  const out: PublishAssetArgs = {
    mode: args['mode'],
    assetId: args['assetId'],
    sourceDigest: '',
    sourceByteLength: 0,
    importRecipe: {} as PublishAssetArgs['importRecipe'],
    metrics: {} as PublishAssetArgs['metrics'],
    importedAt: '',
  };
  if (args['kind'] !== undefined) out.kind = args['kind'] as PublishAssetArgs['kind'];
  if (args['displayName'] !== undefined) {
    if (typeof args['displayName'] !== 'string') {
      return { ok: false, error: fieldType('/args/displayName', args['displayName'], 'string') };
    }
    if (!isValidName(args['displayName'])) {
      return {
        ok: false,
        error: fieldValue(
          '/args/displayName',
          args['displayName'],
          'string, 1-128 chars, no control characters',
          'displayName must be 1-128 characters without control characters',
        ),
      };
    }
    out.displayName = args['displayName'];
  }
  if (args['sourceDigest'] === undefined) {
    return { ok: false, error: fieldMissing('/args/sourceDigest', 'sourceDigest') };
  }
  if (typeof args['sourceDigest'] !== 'string') {
    return { ok: false, error: fieldType('/args/sourceDigest', args['sourceDigest'], 'string (64 hex)') };
  }
  if (!DIGEST_RE.test(args['sourceDigest'])) {
    return { ok: false, error: digestInvalid('/args/sourceDigest', args['sourceDigest']) };
  }
  out.sourceDigest = args['sourceDigest'];
  if (args['sourceByteLength'] === undefined) {
    return { ok: false, error: fieldMissing('/args/sourceByteLength', 'sourceByteLength') };
  }
  const len = args['sourceByteLength'];
  if (typeof len !== 'number' || !Number.isInteger(len)) {
    return { ok: false, error: fieldType('/args/sourceByteLength', len, 'integer') };
  }
  if (len < 1 || len > 33_554_432) {
    return {
      ok: false,
      error: fieldValue(
        '/args/sourceByteLength',
        len,
        'integer in [1, 33554432]',
        'sourceByteLength must be a positive integer within the source-byte cap',
      ),
    };
  }
  out.sourceByteLength = len;
  // A file referenced in place in the game folder; the workspace checks at
  // commit that it exists inside the folder and has exactly these bytes.
  if (args['sourcePath'] !== undefined) {
    if (typeof args['sourcePath'] !== 'string') {
      return { ok: false, error: fieldType('/args/sourcePath', args['sourcePath'], 'string (path inside the game folder)') };
    }
    if (!isValidSourcePath(args['sourcePath'])) {
      return {
        ok: false,
        error: fieldValue(
          '/args/sourcePath',
          args['sourcePath'],
          'a relative path with forward slashes, no "..", "." or empty segments, no ":" or backslash',
          'sourcePath must be a relative path inside the game folder',
        ),
      };
    }
    out.sourcePath = args['sourcePath'];
  }
  // The original of a converted model (FBX); its fields are the model's to
  // validate (the resulting-content gate), the workspace re-verifies the file.
  if (args['convertedFrom'] !== undefined) {
    if (!isPlainObject(args['convertedFrom'])) {
      return { ok: false, error: fieldType('/args/convertedFrom', args['convertedFrom'], 'object { format, sourceDigest, sourceByteLength, sourcePath?, converter }') };
    }
    if (out.sourcePath !== undefined) {
      return { ok: false, error: fieldUnexpected('/args/convertedFrom', 'convertedFrom', KNOWN, 'a converted version is stored; it cannot also have a sourcePath') };
    }
    out.convertedFrom = args['convertedFrom'] as unknown as PublishAssetArgs['convertedFrom'];
  }
  if (args['importRecipe'] === undefined) {
    return { ok: false, error: fieldMissing('/args/importRecipe', 'importRecipe') };
  }
  if (!isPlainObject(args['importRecipe'])) {
    return { ok: false, error: fieldType('/args/importRecipe', args['importRecipe'], 'object (ImportRecipe)') };
  }
  // Structural only; profile/recipeVersion/toolchain/extensions value rules are
  // the model's (§18.5, re-checked by the resulting-content validation).
  out.importRecipe = args['importRecipe'] as unknown as PublishAssetArgs['importRecipe'];
  if (args['metrics'] === undefined) {
    return { ok: false, error: fieldMissing('/args/metrics', 'metrics') };
  }
  if (!isPlainObject(args['metrics'])) {
    return { ok: false, error: fieldType('/args/metrics', args['metrics'], 'object (AssetMetrics)') };
  }
  out.metrics = args['metrics'] as unknown as PublishAssetArgs['metrics'];
  if (args['importedAt'] === undefined) {
    return { ok: false, error: fieldMissing('/args/importedAt', 'importedAt') };
  }
  if (typeof args['importedAt'] !== 'string') {
    return { ok: false, error: fieldType('/args/importedAt', args['importedAt'], 'string (timestamp)') };
  }
  out.importedAt = args['importedAt'];
  // §8.5.1: `animation` is permitted only on a model reimport; its presence
  // rule and binding are the op's.
  if (args['animation'] !== undefined) {
    if (args['mode'] !== 'reimport' || args['kind'] === 'audio' || args['kind'] === 'texture' || args['kind'] === 'music') {
      return {
        ok: false,
        error: fieldUnexpected(
          '/args/animation',
          'animation',
          KNOWN,
          'animation is permitted only on a model reimport',
        ),
      };
    }
    const animation = args['animation'];
    if (!isPlainObject(animation)) {
      return { ok: false, error: fieldType('/args/animation', animation, 'object { entityId, roles }') };
    }
    for (const key of Object.keys(animation)) {
      if (key !== 'entityId' && key !== 'roles') {
        return { ok: false, error: fieldUnexpected(`/args/animation/${key}`, key, 'entityId, roles') };
      }
    }
    if (animation['entityId'] === undefined) {
      return { ok: false, error: fieldMissing('/args/animation/entityId', 'entityId') };
    }
    if (typeof animation['entityId'] !== 'string') {
      return { ok: false, error: fieldType('/args/animation/entityId', animation['entityId'], 'string (entity ID)') };
    }
    if (animation['roles'] === undefined) {
      return { ok: false, error: fieldMissing('/args/animation/roles', 'roles') };
    }
    if (!isPlainObject(animation['roles'])) {
      return { ok: false, error: fieldType('/args/animation/roles', animation['roles'], 'object { idle, run, airborne }') };
    }
    out.animation = animation as unknown as PublishAssetArgs['animation'];
  }
  return { ok: true, args: out };
}

/** `applySurfacePreset` args (commands.md §3.1.9/§8.13). */
export function validateApplySurfacePresetArgs(
  args: Record<string, unknown>,
): ArgsOk<ApplySurfacePresetArgs> | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityId' && key !== 'preset') {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'entityId, preset') };
    }
  }
  if (args['entityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  }
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  if (args['preset'] === undefined) {
    return { ok: false, error: fieldMissing('/args/preset', 'preset') };
  }
  const preset = args['preset'];
  if (typeof preset !== 'string' || !(SURFACE_PRESET_NAMES as readonly string[]).includes(preset)) {
    return {
      ok: false,
      error: fieldValue(
        '/args/preset',
        preset,
        '"matte-ground", "hazard" or "beacon"',
        'preset must be one of the three built-in surface presets',
      ),
    };
  }
  return { ok: true, args: { entityId: args['entityId'], preset: preset as ApplySurfacePresetArgs['preset'] } };
}

/**
 * `setGameConfig` args (commands.md §3.1.10/§8.14): `null` (remove), a
 * complete block (create) or a non-empty partial object (edit). The
 * create-completeness and field rules are the model block validator's, mapped
 * by the op to the §5.4 `field_*` codes.
 */
export function validateSetGameConfigArgs(
  args: Record<string, unknown>,
): ArgsOk<SetGameConfigArgs> | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'game') {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'game') };
    }
  }
  if (args['game'] === undefined) {
    return { ok: false, error: fieldMissing('/args/game', 'game') };
  }
  const game = args['game'];
  if (game !== null && !isPlainObject(game)) {
    return { ok: false, error: fieldType('/args/game', game, 'object (GameConfig) or null') };
  }
  return { ok: true, args: { game: game as SetGameConfigArgs['game'] } };
}

export function validatePublishBehaviorArgs(
  args: Record<string, unknown>,
): ArgsOk<PublishBehaviorArgs> | { ok: false; error: CommandError } {
  const KNOWN = 'behaviorId, displayName, mode, declaration, source (source mode only), graph (declaration-create only)';
  for (const key of Object.keys(args)) {
    if (!['behaviorId', 'displayName', 'mode', 'declaration', 'source', 'graph'].includes(key)) {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, KNOWN) };
    }
  }
  if (args['behaviorId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/behaviorId', 'behaviorId') };
  }
  if (typeof args['behaviorId'] !== 'string') {
    return { ok: false, error: fieldType('/args/behaviorId', args['behaviorId'], 'string (behavior ID)') };
  }
  if (args['displayName'] === undefined) {
    return { ok: false, error: fieldMissing('/args/displayName', 'displayName') };
  }
  if (typeof args['displayName'] !== 'string') {
    return { ok: false, error: fieldType('/args/displayName', args['displayName'], 'string') };
  }
  if (args['mode'] === undefined) return { ok: false, error: fieldMissing('/args/mode', 'mode') };
  const mode = args['mode'];
  if (
    typeof mode !== 'string' ||
    (mode !== 'declaration-create' && mode !== 'declaration-update' && mode !== 'source')
  ) {
    return {
      ok: false,
      error: fieldValue(
        '/args/mode',
        mode,
        '"declaration-create", "declaration-update" or "source"',
        'mode must be one of the three behavior publication modes',
      ),
    };
  }
  if (args['source'] !== undefined && mode !== 'source') {
    return {
      ok: false,
      error: fieldUnexpected('/args/source', 'source', KNOWN, 'source is only permitted with mode "source"'),
    };
  }
  if (mode === 'source' && args['source'] === undefined) {
    return { ok: false, error: fieldMissing('/args/source', 'source') };
  }
  // Phase 19.0: a new behavior may start as a visual script (its graph; validated by the op).
  if (args['graph'] !== undefined && mode !== 'declaration-create') {
    return { ok: false, error: fieldUnexpected('/args/graph', 'graph', KNOWN, 'graph is only permitted with mode "declaration-create" (edit a visual script with graphEdit)') };
  }
  if (args['graph'] !== undefined && !isPlainObject(args['graph'])) {
    return { ok: false, error: fieldType('/args/graph', args['graph'], 'object { nodes, edges }') };
  }
  if (args['declaration'] === undefined) {
    return { ok: false, error: fieldMissing('/args/declaration', 'declaration') };
  }
  const declaration = args['declaration'];
  if (!isPlainObject(declaration)) {
    return { ok: false, error: fieldType('/args/declaration', declaration, 'object { properties: [...] }') };
  }
  for (const key of Object.keys(declaration)) {
    if (key !== 'properties') {
      return {
        ok: false,
        error: fieldUnexpected(`/args/declaration/${key}`, key, 'properties'),
      };
    }
  }
  if (declaration['properties'] === undefined) {
    return { ok: false, error: fieldMissing('/args/declaration/properties', 'properties') };
  }
  if (!Array.isArray(declaration['properties'])) {
    return {
      ok: false,
      error: fieldType('/args/declaration/properties', declaration['properties'], 'array of DeclaredProperty'),
    };
  }
  const out: PublishBehaviorArgs = {
    behaviorId: args['behaviorId'],
    displayName: args['displayName'],
    mode,
    declaration: declaration as unknown as PublishBehaviorArgs['declaration'],
    ...(args['graph'] !== undefined ? { graph: args['graph'] as unknown as NonNullable<PublishBehaviorArgs['graph']> } : {}),
  };
  if (args['source'] !== undefined) {
    if (!isPlainObject(args['source'])) {
      return { ok: false, error: fieldType('/args/source', args['source'], 'object { sourceDigest, sourceByteLength }') };
    }
    const s = args['source'];
    for (const key of Object.keys(s)) {
      if (key !== 'sourceDigest' && key !== 'sourceByteLength') {
        return { ok: false, error: fieldUnexpected(`/args/source/${key}`, key, 'sourceDigest, sourceByteLength') };
      }
    }
    const digest = s['sourceDigest'];
    if (digest === undefined) return { ok: false, error: fieldMissing('/args/source/sourceDigest', 'sourceDigest') };
    if (typeof digest !== 'string') {
      return { ok: false, error: fieldType('/args/source/sourceDigest', digest, '64 lowercase hex characters') };
    }
    if (!/^[0-9a-f]{64}$/.test(digest)) return { ok: false, error: digestInvalid('/args/source/sourceDigest', digest) };
    const byteLength = s['sourceByteLength'];
    if (byteLength === undefined) {
      return { ok: false, error: fieldMissing('/args/source/sourceByteLength', 'sourceByteLength') };
    }
    if (typeof byteLength !== 'number' || !Number.isInteger(byteLength)) {
      return { ok: false, error: fieldType('/args/source/sourceByteLength', byteLength, 'integer 1..262144') };
    }
    if (byteLength < 1 || byteLength > 262_144) {
      return { ok: false, error: limitsExceeded('graph_bytes', byteLength, 262_144) };
    }
    out.source = s as unknown as { sourceDigest: string; sourceByteLength: number };
  }
  return { ok: true, args: out };
}

export function validateSetBehaviorPropertiesArgs(
  args: Record<string, unknown>,
): ArgsOk<SetBehaviorPropertiesArgs> | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityId' && key !== 'behaviorId' && key !== 'values') {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'entityId, behaviorId, values (optional)') };
    }
  }
  if (args['entityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  }
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  if (args['behaviorId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/behaviorId', 'behaviorId') };
  }
  const behaviorId = args['behaviorId'];
  if (behaviorId !== null && typeof behaviorId !== 'string') {
    return { ok: false, error: fieldType('/args/behaviorId', behaviorId, 'string (behavior ID) or null') };
  }
  const out: SetBehaviorPropertiesArgs = { entityId: args['entityId'], behaviorId };
  if (args['values'] !== undefined) {
    if (!isPlainObject(args['values'])) {
      return { ok: false, error: fieldType('/args/values', args['values'], 'object (declared-property map)') };
    }
    if (behaviorId === null && Object.keys(args['values']).length > 0) {
      return {
        ok: false,
        error: fieldValue(
          '/args/values',
          args['values'],
          'absent or empty when behaviorId is null',
          'removing the behavior component does not accept values',
        ),
      };
    }
    out.values = args['values'] as Record<string, PropertyValue>;
  }
  return { ok: true, args: out };
}

/** Component field sets (commands.md §8.10). */
const COMPONENT_FIELDS: Record<string, readonly string[]> = {
  box: ['size', 'material', 'castShadow', 'receiveShadow'],
  camera: ['type', 'fovY', 'near', 'far'],
  // Phase 15.1: the piece of a multi-piece file is an Inspector field too.
  model: ['asset', 'piece', 'castShadow', 'receiveShadow'],
  collider: ['shape', 'oneWay'],
  controller: ['capsule', 'acceleration', 'deceleration', 'coyoteTime', 'jumpBuffer', 'jumpRelease', 'groundSnap', 'skin', 'autostep', 'autostepHeight'],
  // Phase 15.1: an exit zone's scenes and arrival spawn are edited like every other field.
  gameZone: ['role', 'size', 'safeSpawnId', 'activation', 'load', 'unload', 'spawnId', 'damage', 'effect'],
  // Phase 15.2: which way the player faces at this spawn (v4).
  playerSpawn: ['facing'],
  cameraFollow: ['deadZone', 'smoothing', 'bounds', 'distance', 'maxSpeed'],
  light: ['type', 'color', 'intensity', 'direction', 'castShadow', 'range', 'decay', 'angle', 'penumbra', 'groundColor', 'mode', 'shadowMapSize', 'shadowBias', 'shadowNormalBias', 'shadowExtent'],
  surface: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
  modelAnimation: ['assetId', 'version', 'roles'],
  // Phase 12 (c) / 9.4 (v4 scenes).
  instances: ['asset', 'buffer', 'count', 'castShadow', 'receiveShadow'],
  fogVolume: ['size', 'density', 'color', 'falloff', 'heightFalloff'],
  animator: ['controller', 'parameters'],
  mover: ['waypoints', 'speed', 'mode', 'wait', 'easing', 'startOn', 'maxPush'],
  audioSource: ['assetId', 'volume', 'range'],
  faceMovement: ['yawRight', 'yawLeft', 'turnSeconds'],
  trigger: ['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode', 'height'],
  switch: ['mode', 'signal', 'size', 'once'],
  health: ['max', 'start', 'invulnerableSeconds', 'knockback', 'hitBounce', 'knockbackTime', 'hitEffect'],
  pickup: ['kind', 'value', 'counter', 'size', 'respawn', 'cue', 'effect'],
  enemy: ['patrol', 'range', 'speed', 'size', 'contactDamage', 'stompable', 'health', 'chase', 'chaseHeight', 'chaseSpeed', 'chaseSight', 'chaseFacing', 'chaseMemory', 'chaseBeyondPatrol', 'stompBounce', 'stompTolerance', 'defeat', 'defeatTime', 'wallProbe', 'ledgeProbe', 'hitEffect', 'defeatEffect'],
  // Phase 20.0: the effect played from the entity.
  effect: ['effectId', 'playOnStart', 'params', 'signal', 'stopSignal'],
  // Phase 23.4: the camera framework.
  virtualCamera: VIRTUAL_CAMERA_FIELDS,
  cameraPath: CAMERA_PATH_FIELDS,
};

const OWNED: readonly OwnedComponent[] = [
  'box',
  'camera',
  'model',
  'collider',
  'controller',
  'gameZone',
  'playerSpawn',
  'cameraFollow',
  'light',
  'surface',
  'modelAnimation',
  'instances',
  'materials',
  'fogVolume',
  'animator',
  'mover',
  'trigger',
  'switch',
  'health',
  'pickup',
  'enemy',
  'audioSource',
  'faceMovement',
  'materialParams',
  'effect',
  'virtualCamera',
  'cameraPath',
];
// Phase 15.1: box, camera and model are added (a complete value) and removed
// like every other component (the Inspector's "+ Add component").
const REMOVABLE: readonly OwnedComponent[] = [
  'box',
  'camera',
  'model',
  'collider',
  'controller',
  'gameZone',
  'playerSpawn',
  'cameraFollow',
  'light',
  'surface',
  'modelAnimation',
  'instances',
  'materials',
  'fogVolume',
  'animator',
  'mover',
  'trigger',
  'switch',
  'health',
  'pickup',
  'enemy',
  'audioSource',
  'faceMovement',
  'materialParams',
  'effect',
  'virtualCamera',
  'cameraPath',
];
/** The components whose ADD value may be `{}` (playerSpawn has no fields; the controller's capsule is optional). */
const MARKER_COMPONENTS: readonly string[] = ['controller', 'playerSpawn'];
const UNOWNED = ['transform', 'behavior', 'prefab'];
const COMPONENT_EXPECTED =
  'one of "box", "camera", "model", "collider", "controller", "gameZone", "playerSpawn", "cameraFollow", "light", "surface", "modelAnimation", "instances", "materials", "materialParams", "effect"';

export function validateSetComponentArgs(
  args: Record<string, unknown>,
): ArgsOk<SetComponentArgs> | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityId' && key !== 'component' && key !== 'value') {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'entityId, component, value') };
    }
  }
  if (args['entityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  }
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  if (args['component'] === undefined) {
    return { ok: false, error: fieldMissing('/args/component', 'component') };
  }
  const component = args['component'];
  if (typeof component !== 'string') {
    return { ok: false, error: fieldType('/args/component', component, COMPONENT_EXPECTED) };
  }
  if (!(OWNED as readonly string[]).includes(component)) {
    // `transform`/`behavior`/`prefab` are owned elsewhere; anything else is
    // not a component name at all. Both are `field_value` at /args/component.
    return {
      ok: false,
      error: fieldValue(
        '/args/component',
        component,
        // The committed packet-16 failure fixture pins this string for the
        // unowned names (`transform`/`behavior`/`prefab`); genuinely unknown
        // names report the full v3 union (handoff 45 CC-45-5).
        UNOWNED.includes(component)
          ? 'one of "box", "camera", "model", "collider", "controller"'
          : COMPONENT_EXPECTED,
        UNOWNED.includes(component)
          ? 'component is owned by another operation'
          : 'component must be one of the three owned component names',
      ),
    };
  }
  if (args['value'] === undefined) {
    return { ok: false, error: fieldMissing('/args/value', 'value') };
  }
  const value = args['value'];
  // `null` removes an add-capable component (every owned component since
  // phase 15.1, box/camera/model included).
  if (value === null) {
    if (!(REMOVABLE as readonly string[]).includes(component)) {
      return {
        ok: false,
        error: fieldValue(
          '/args/value',
          null,
          `object (non-empty partial ${component})`,
          'value: null is a removal only for an add-capable component; box/camera/model are field edits',
        ),
      };
    }
    return { ok: true, args: { entityId: args['entityId'], component: component as OwnedComponent, value: null } };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: fieldType('/args/value', value, 'object (non-empty partial component)') };
  }
  const fields = COMPONENT_FIELDS[component] ?? [];
  const keys = Object.keys(value);
  // The `controller`/`playerSpawn` markers have no fields, so their ADD value
  // is exactly `{}`; every other component requires a non-empty partial object.
  if (keys.length === 0 && !MARKER_COMPONENTS.includes(component)) {
    return {
      ok: false,
      error: fieldValue(
        '/args/value',
        {},
        `non-empty object: at least one of ${fields.join(', ')}`,
        'value must be a non-empty partial component (absent fields are unchanged)',
      ),
    };
  }
  for (const key of keys) {
    // A material mapping's keys are material names (the model validates them).
    if (component === 'materials' || component === 'materialParams') break;
    if (!fields.includes(key)) {
      return {
        ok: false,
        error: {
          code: 'field_unexpected',
          cls: 'validation',
          path: `/args/value/${key}`,
          found: value[key],
          expected: `one of ${fields.map((f) => `"${f}"`).join(', ')}`,
          message: 'unknown component field',
        },
      };
    }
  }
  // Structural field checks; value rules (ranges, color syntax, camera
  // constraints, box/camera exclusivity) are the model's, re-checked by the
  // resulting-document validation.
  if (component === 'box') {
    if (value['size'] !== undefined && !Array.isArray(value['size'])) {
      return { ok: false, error: fieldType('/args/value/size', value['size'], 'array of 3 finite numbers') };
    }
    if (value['material'] !== undefined) {
      if (!isPlainObject(value['material'])) {
        return { ok: false, error: fieldType('/args/value/material', value['material'], 'object { color }') };
      }
      for (const mk of Object.keys(value['material'])) {
        if (mk !== 'color') {
          return { ok: false, error: fieldUnexpected(`/args/value/material/${mk}`, mk, 'color') };
        }
      }
    }
  } else if (component === 'camera') {
    for (const f of ['type', 'fovY', 'near', 'far']) {
      const v = value[f];
      if (v === undefined) continue;
      const expected = f === 'type' ? 'string ("perspective")' : 'number';
      if (f === 'type' ? typeof v !== 'string' : typeof v !== 'number') {
        return { ok: false, error: fieldType(`/args/value/${f}`, v, expected) };
      }
    }
  } else if (component === 'collider') {
    const shape = value['shape'];
    // Phase 15.1: `oneWay` alone edits the flag (the shape stays).
    if (shape === undefined && value['oneWay'] !== undefined) return { ok: true, args: { entityId: args['entityId'], component: component as OwnedComponent, value } };
    if (!isPlainObject(shape)) {
      return { ok: false, error: fieldType('/args/value/shape', shape, 'object ({ type: "box"|"polygon"|"sphere"|"capsule"|"convex"|"mesh", ... })') };
    }
    // Phase 23.1: the 3D shapes (the project's physics dimension is the model's rule).
    if (!['box', 'polygon', 'sphere', 'capsule', 'convex', 'mesh'].includes(shape['type'] as string)) {
      return {
        ok: false,
        error: fieldValue(
          '/args/value/shape/type',
          shape['type'],
          '"box", "polygon", "sphere", "capsule", "convex" or "mesh"',
          'collider.shape.type must be "box" or "polygon" (a 3D project also "sphere", "capsule", "convex" or "mesh")',
        ),
      };
    }
    // Deeper shape rules (ranges, convexity, vertex caps) are the model's,
    // re-checked by the resulting-document validation (`collider_shape_invalid`).
  } else if (component === 'controller') {
    // Phase 14.0: `capsule` (an object, or null to go back to the default);
    // its values are the model's (re-checked by the resulting-document validation).
    const capsule = value['capsule'];
    if (capsule !== undefined && capsule !== null && !isPlainObject(capsule)) {
      return { ok: false, error: fieldType('/args/value/capsule', capsule, 'object { radius, height, offset? } or null') };
    }
  } else if (component === 'playerSpawn') {
    // Phase 15.2: `facing` (a string, or null for none); its values are the model's.
    const facing = value['facing'];
    if (facing !== undefined && facing !== null && typeof facing !== 'string') {
      return { ok: false, error: fieldType('/args/value/facing', facing, 'string ("none", "left", "right") or null') };
    }
  } else if (
    component === 'gameZone' ||
    component === 'cameraFollow' ||
    component === 'light' ||
    component === 'surface' ||
    component === 'modelAnimation' ||
    component === 'instances' ||
    component === 'materials' ||
    component === 'materialParams' ||
    component === 'effect' ||
    component === 'virtualCamera' ||
    component === 'cameraPath' ||
    component === 'fogVolume' ||
    component === 'animator' ||
    component === 'mover' ||
    component === 'trigger' ||
    component === 'switch' ||
    component === 'health' ||
    component === 'pickup' ||
    component === 'enemy' ||
    component === 'audioSource' ||
    component === 'faceMovement'
  ) {
    // The v3 field values (types, ranges, requiredness, the role-binding
    // stages) are the model's and the §41.3.2 helper's; nothing structural is
    // re-implemented here.
  } else {
    // Phase 15.1: `piece` alone (a string, or null for the whole file) edits the piece.
    const piece = value['piece'];
    if (piece !== undefined && piece !== null && typeof piece !== 'string') {
      return { ok: false, error: fieldType('/args/value/piece', piece, 'string (piece name) or null') };
    }
    const asset = value['asset'];
    if (asset === undefined && piece !== undefined) return { ok: true, args: { entityId: args['entityId'], component: component as OwnedComponent, value } };
    if (!isPlainObject(asset)) {
      return { ok: false, error: fieldType('/args/value/asset', asset, 'object { assetId }') };
    }
    for (const ak of Object.keys(asset)) {
      if (ak !== 'assetId') {
        return { ok: false, error: fieldUnexpected(`/args/value/asset/${ak}`, ak, 'assetId') };
      }
    }
    if (typeof asset['assetId'] !== 'string') {
      return { ok: false, error: fieldType('/args/value/asset/assetId', asset['assetId'], 'string (asset ID)') };
    }
  }
  return { ok: true, args: { entityId: args['entityId'], component: component as OwnedComponent, value } };
}

export function validateSetSettingsArgs(
  args: Record<string, unknown>,
  registry: readonly SettingsKeySpec[],
): ArgsOk<SetSettingsArgs> | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'settings') {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'settings') };
    }
  }
  if (args['settings'] === undefined) {
    return { ok: false, error: fieldMissing('/args/settings', 'settings') };
  }
  const settings = args['settings'];
  if (!isPlainObject(settings)) {
    return { ok: false, error: fieldType('/args/settings', settings, 'object (SettingsMap)') };
  }
  if (Object.keys(settings).length === 0) {
    return {
      ok: false,
      error: fieldValue(
        '/args/settings',
        {},
        'non-empty object of declared settings keys',
        'settings must be a non-empty partial map (there is no removal in M2)',
      ),
    };
  }
  for (const key of Object.keys(settings)) {
    if (!KEY_RE.test(key)) {
      return {
        ok: false,
        error: fieldValue(
          `/args/settings/${key}`,
          key,
          'key syntax ^[a-z][a-z0-9_]{0,63}$',
          'settings key does not use the declared key syntax',
        ),
      };
    }
    const spec = registry.find((s) => s.key === key);
    if (spec === undefined) return { ok: false, error: settingUnknown(key) };
    const v = settings[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        ok: false,
        error: {
          code: 'field_type',
          cls: 'validation',
          path: `/args/settings/${key}`,
          key,
          found: v,
          expected: 'number',
          message: `setting '${key}' must be a number`,
        },
      };
    }
    const expected = settingsRangeText(spec);
    const belowMin =
      spec.min !== undefined && (spec.minExclusive === true ? v <= spec.min : v < spec.min);
    const aboveMax =
      spec.max !== undefined && (spec.maxExclusive === true ? v >= spec.max : v > spec.max);
    // Phase 15.3: whole numbers / a choice of values (the step rate, the voice count).
    const notAllowed = (spec.integer === true && !Number.isInteger(v)) || (spec.values !== undefined && !spec.values.includes(v));
    if (belowMin || aboveMax || notAllowed) {
      return {
        ok: false,
        error: {
          code: 'field_value',
          cls: 'validation',
          path: `/args/settings/${key}`,
          key,
          found: v,
          expected,
          message: notAllowed ? `setting '${key}' is not one of its allowed values` : `setting '${key}' is outside its declared range`,
        },
      };
    }
  }
  return { ok: true, args: { settings: settings as SetSettingsArgs['settings'] } };
}

/** Human-readable range text for a settings spec (used in `field_value.expected`). */
export function settingsRangeText(spec: SettingsKeySpec): string {
  if (spec.values !== undefined) return `one of ${spec.values.join(', ')}`;
  const lo = spec.min === undefined ? '' : `${spec.minExclusive === true ? '(' : '['}${spec.min}, `;
  const hi = spec.max === undefined ? '' : `${spec.max}${spec.maxExclusive === true ? ')' : ']'}`;
  return `${spec.integer === true ? 'integer' : 'number'} in ${lo}${hi}`;
}

export function validateAcknowledgeBehaviorTrustArgs(
  args: Record<string, unknown>,
): ArgsOk<AcknowledgeBehaviorTrustArgs> | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'sourceDigest') {
      return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'sourceDigest') };
    }
  }
  if (args['sourceDigest'] === undefined) {
    return { ok: false, error: fieldMissing('/args/sourceDigest', 'sourceDigest') };
  }
  if (typeof args['sourceDigest'] !== 'string') {
    return { ok: false, error: fieldType('/args/sourceDigest', args['sourceDigest'], 'string (64 hex)') };
  }
  if (!DIGEST_RE.test(args['sourceDigest'])) {
    return { ok: false, error: digestInvalid('/args/sourceDigest', args['sourceDigest']) };
  }
  return { ok: true, args: { sourceDigest: args['sourceDigest'] } };
}
