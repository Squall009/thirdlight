/**
 * Args-schema checks (`field_*` errors) of the core ops: entity create,
 * transform, update, delete and move, asset options, the scene index, tags,
 * and undo/redo. `validateOpArgs` dispatches here. The value rules of
 * transforms and boxes stay with the project-model check of the result scene.
 */

import {
  AUDIO_LOAD_TYPES,
  isValidSourcePath,
  MODEL_OCCLUDER_MODES,
  modelLodProblems,
  type ModelOccluderMode,
  DELETE_ENTITIES_MAX,
} from '@thirdlight/project-model';
import { ENTITY_FLAGS, MAX_TAGS, TAG_NAME_RE } from '@thirdlight/project-model';
import { fieldType, fieldMissing, fieldUnexpected, fieldValue, isPlainObjectStrict, isValidName } from './errors';
import { SURFACE_PRESET_NAMES } from '@thirdlight/project-model';
import { isSetComponentName, SET_COMPONENT_NAMES } from './validate-content-args';
import type {
  BoxArgs,
  CommandError,
  CreateEntityArgs,
  DeleteEntityArgs,
  EmptyArgs,
  PartialTransformArgs,
  SetTransformArgs,
  UpdateEntityArgs,
  MoveEntitiesArgs,
  SetTagsArgs,
  SetAssetOptionsArgs,
  SceneIndexArgs,
} from './types';
import { escapePointer as pointerSegment } from '@thirdlight/shared';

const TRANSFORM_FIELDS = ['position', 'rotation', 'scale'] as const;
type TransformField = (typeof TRANSFORM_FIELDS)[number];

/**
 * Components `createEntity` makes from its own arguments rather than from
 * `components`: `box` and `model` from `kind` (and its box/model argument).
 */
export const CREATE_MADE_BY_KIND: readonly string[] = ['box', 'model'];

/**
 * The add-capable `createEntity.components` key set: every component
 * `setComponent` adds, bar those `kind` makes. The values are checked as the
 * result scene is (the same rules as `setComponent`'s).
 */
export const CREATE_COMPONENTS: readonly string[] = SET_COMPONENT_NAMES.filter((c) => !CREATE_MADE_BY_KIND.includes(c));

// ---- args level (field_*) ----------------------------------------------------------

function validateTransformArgs(
  args: Record<string, unknown>,
  path: string,
): PartialTransformArgs | { error: CommandError } {
  for (const key of Object.keys(args)) {
    if (!(TRANSFORM_FIELDS as readonly string[]).includes(key)) {
      return {
        error: fieldUnexpected(
          `${path}/${pointerSegment(key)}`,
          key,
          'position, rotation, scale',
        ),
      };
    }
  }
  const out: PartialTransformArgs = {};
  for (const f of TRANSFORM_FIELDS) {
    const v = args[f];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      return {
        error: fieldType(
          `${path}/${f}`,
          v,
          f === 'rotation'
            ? 'array of 4 finite numbers'
            : 'array of 3 finite numbers',
        ),
      };
    }
    // Element values (type/finiteness/ranges/quaternion norm) are checked
    // by the project-model validation of the resulting scene; the args
    // layer guarantees only the array shape.
    if (f === 'position') out.position = v.slice() as readonly number[];
    else if (f === 'rotation') out.rotation = v.slice() as readonly number[];
    else out.scale = v.slice() as readonly number[];
  }
  return out;
}

function validateBoxArgs(
  box: unknown,
  path: string,
): BoxArgs | { error: CommandError } {
  if (!isPlainObjectStrict(box)) {
    return {
      error: fieldType(path, box, 'object with optional size and material'),
    };
  }
  for (const key of Object.keys(box)) {
    if (key !== 'size' && key !== 'material') {
      return { error: fieldUnexpected(`${path}/${pointerSegment(key)}`, key, 'size, material') };
    }
  }
  const out: BoxArgs = {};
  if (box['size'] !== undefined) {
    if (!Array.isArray(box['size'])) {
      return { error: fieldType(`${path}/size`, box['size'], 'array of 3 finite numbers') };
    }
    out.size = (box['size'] as unknown[]).slice() as readonly number[];
  }
  if (box['material'] !== undefined) {
    const m = box['material'];
    if (!isPlainObjectStrict(m)) {
      return { error: fieldType(`${path}/material`, m, 'object with optional color') };
    }
    for (const key of Object.keys(m)) {
      if (key !== 'color') {
        return { error: fieldUnexpected(`${path}/material/${pointerSegment(key)}`, key, 'color') };
      }
    }
    const material: { color?: string } = {};
    if (m['color'] !== undefined) {
      if (typeof m['color'] !== 'string') {
        return { error: fieldType(`${path}/material/color`, m['color'], 'string (#RRGGBB)') };
      }
      material.color = m['color'];
    }
    out.material = material;
  }
  return out;
}

export function validateCreateArgs(args: Record<string, unknown>):
  | { ok: true; args: CreateEntityArgs }
  | { ok: false; error: CommandError } {
  const KNOWN =
    'kind, parentId (optional), name (optional), active, visible, locked, static, keepLoaded, tags (optional), transform (optional), box (optional, box only), model (optional, model only), components (optional), surfacePreset (optional), children (optional, folder only)';
  for (const key of Object.keys(args)) {
    if (
      key !== 'kind' &&
      key !== 'parentId' &&
      key !== 'name' &&
      key !== 'active' &&
      key !== 'visible' &&
      key !== 'locked' &&
      key !== 'static' &&
      key !== 'keepLoaded' &&
      key !== 'tags' &&
      key !== 'transform' &&
      key !== 'box' &&
      key !== 'model' &&
      key !== 'components' &&
      key !== 'surfacePreset' &&
      key !== 'children'
    ) {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, KNOWN) };
    }
  }
  if (args['kind'] === undefined) {
    return { ok: false, error: fieldMissing('/args/kind', 'kind') };
  }
  if (typeof args['kind'] !== 'string') {
    return {
      ok: false,
      error: fieldType('/args/kind', args['kind'], '"group", "box", "model" or "folder"'),
    };
  }
  if (args['kind'] !== 'group' && args['kind'] !== 'box' && args['kind'] !== 'model' && args['kind'] !== 'folder') {
    return {
      ok: false,
      error: fieldValue(
        '/args/kind',
        args['kind'],
        '"group", "box", "model" or "folder"',
        'kind must be "group", "box", "model" or "folder" (camera creation is not a command)',
      ),
    };
  }
  if (args['kind'] === 'folder') {
    // A folder is organisation only.
    for (const key of ['transform', 'components', 'surfacePreset'] as const) {
      if (args[key] !== undefined) {
        return { ok: false, error: fieldUnexpected(`/args/${key}`, key, 'kind, parentId, name', 'a folder has no transform and no components') };
      }
    }
  }
  const out: CreateEntityArgs = { kind: args['kind'] };
  if (args['parentId'] !== undefined) {
    if (args['parentId'] !== null && typeof args['parentId'] !== 'string') {
      return {
        ok: false,
        error: fieldType('/args/parentId', args['parentId'], 'string (entity ID) or null'),
      };
    }
    out.parentId = args['parentId'];
  }
  if (args['name'] !== undefined) {
    if (typeof args['name'] !== 'string') {
      return { ok: false, error: fieldType('/args/name', args['name'], 'string') };
    }
    if (!isValidName(args['name'])) {
      return {
        ok: false,
        error: fieldValue(
          '/args/name',
          args['name'],
          'string, 1-128 chars, no control characters',
          'name must be 1-128 characters without control characters',
        ),
      };
    }
    out.name = args['name'];
  }
  // The hierarchy flags and tags, as updateEntity takes them.
  for (const flag of ENTITY_FLAGS) {
    const v = args[flag];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: fieldType(`/args/${flag}`, v, 'boolean') };
    out[flag] = v;
  }
  if (args['tags'] !== undefined) {
    const tags = args['tags'];
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) return { ok: false, error: fieldType('/args/tags', tags, `array of up to ${MAX_TAGS} tag names`) };
    for (let i = 0; i < tags.length; i++) {
      if (typeof tags[i] !== 'string') return { ok: false, error: fieldType(`/args/tags/${i}`, tags[i], 'string (tag name)') };
    }
    out.tags = [...(tags as string[])];
  }
  if (args['transform'] !== undefined) {
    const t = args['transform'];
    if (!isPlainObjectStrict(t)) {
      return {
        ok: false,
        error: fieldType(
          '/args/transform',
          t,
          'object with any non-empty subset of position, rotation, scale',
        ),
      };
    }
    const checked = validateTransformArgs(t, '/args/transform');
    if ('error' in checked) return { ok: false, error: checked.error };
    if (
      checked.position === undefined &&
      checked.rotation === undefined &&
      checked.scale === undefined
    ) {
      return {
        ok: false,
        error: fieldValue(
          '/args/transform',
          {},
          'non-empty object: at least one of position, rotation, scale',
          'transform must be a non-empty partial transform (defaults already apply)',
        ),
      };
    }
    out.transform = checked;
  }
  if (args['box'] !== undefined) {
    if (out.kind !== 'box') {
      return {
        ok: false,
        error: fieldUnexpected(
          '/args/box',
          'box',
          KNOWN,
          'box is not permitted unless kind is "box"',
        ),
      };
    }
    const checked = validateBoxArgs(args['box'], '/args/box');
    if ('error' in checked) return { ok: false, error: checked.error };
    out.box = checked;
  }
  if (args['kind'] === 'model') {
    if (args['model'] === undefined) {
      return { ok: false, error: fieldMissing('/args/model', 'model') };
    }
    const m = args['model'];
    if (!isPlainObjectStrict(m)) {
      return { ok: false, error: fieldType('/args/model', m, 'object { asset: { assetId } }') };
    }
    for (const key of Object.keys(m)) {
      if (key !== 'asset' && key !== 'piece') {
        return { ok: false, error: fieldUnexpected(`/args/model/${pointerSegment(key)}`, key, 'asset, piece') };
      }
    }
    const piece = m['piece'];
    if (piece !== undefined && (typeof piece !== 'string' || !isValidName(piece))) {
      return {
        ok: false,
        error: fieldValue('/args/model/piece', piece, 'string, 1-128 chars, no control characters', 'piece names one piece of the model file'),
      };
    }
    const asset = m['asset'];
    if (!isPlainObjectStrict(asset)) {
      return { ok: false, error: fieldType('/args/model/asset', asset, 'object { assetId }') };
    }
    for (const key of Object.keys(asset)) {
      if (key !== 'assetId') {
        return { ok: false, error: fieldUnexpected(`/args/model/asset/${pointerSegment(key)}`, key, 'assetId') };
      }
    }
    if (typeof asset['assetId'] !== 'string') {
      return { ok: false, error: fieldType('/args/model/asset/assetId', asset['assetId'], 'string (asset ID)') };
    }
    out.model = { asset: { assetId: asset['assetId'] }, ...(typeof piece === 'string' ? { piece } : {}) };
  } else if (args['model'] !== undefined) {
    return {
      ok: false,
      error: fieldUnexpected('/args/model', 'model', KNOWN, 'model is permitted only when kind is "model"'),
    };
  }
  // The add-capable components, created in the same transaction. Unknown
  // keys are `component_unknown`; the per-component VALUES are validated by
  // the op.
  if (args['components'] !== undefined) {
    const components = args['components'];
    if (!isPlainObjectStrict(components)) {
      return { ok: false, error: fieldType('/args/components', components, 'object of add-capable components') };
    }
    const keys = Object.keys(components);
    if (keys.length > 8) {
      return {
        ok: false,
        error: fieldValue(
          '/args/components',
          keys.length,
          'at most 8 add-capable component keys',
          'at most 8 components may be added in one createEntity',
        ),
      };
    }
    for (const key of keys) {
      if (!CREATE_COMPONENTS.includes(key)) {
        // A component setComponent takes is not unknown — say how to add it.
        const settable = isSetComponentName(key);
        const made = key === 'box' || key === 'model';
        return {
          ok: false,
          error: {
            code: 'component_unknown',
            cls: 'validation',
            path: `/args/components/${pointerSegment(key)}`,
            found: components[key],
            expected: CREATE_COMPONENTS.map((c) => `"${c}"`).join(', '),
            message: !settable
              ? 'unknown component name (the registry is closed)'
              : made
                ? `"${key}" is not added through components: createEntity makes it from kind "${key}" and its ${key} argument (or add it afterwards with setComponent)`
                : `"${key}" cannot be added by createEntity: create the entity, then add it with setComponent`,
          },
        };
      }
      if (components[key] === null) {
        return {
          ok: false,
          error: fieldValue(
            `/args/components/${pointerSegment(key)}`,
            null,
            'the component add value (never null)',
            'components values are add values; removal is setComponent with value: null',
          ),
        };
      }
    }
    out.components = components;
  }
  if (args['surfacePreset'] !== undefined) {
    const preset = args['surfacePreset'];
    if (out.kind !== 'box' && out.kind !== 'model') {
      return {
        ok: false,
        error: fieldUnexpected('/args/surfacePreset', 'surfacePreset', KNOWN, 'surfacePreset is permitted only when kind is "box" or "model"'),
      };
    }
    if (typeof preset !== 'string' || !(SURFACE_PRESET_NAMES as readonly string[]).includes(preset)) {
      return {
        ok: false,
        error: fieldValue('/args/surfacePreset', preset, '"matte-ground", "signal-red" or "emissive-accent"', `surfacePreset must be one of the three built-in presets`),
      };
    }
    if (out.components !== undefined && out.components['surface'] !== undefined) {
      return {
        ok: false,
        error: fieldValue('/args/surfacePreset', preset, 'absent when components.surface is present', 'surfacePreset and components.surface are mutually exclusive'),
      };
    }
    out.surfacePreset = preset as CreateEntityArgs['surfacePreset'];
  }
  if (args['children'] !== undefined) {
    const children = args['children'];
    if (out.kind !== 'folder') {
      return { ok: false, error: fieldUnexpected('/args/children', 'children', KNOWN, 'children are permitted only when kind is "folder"') };
    }
    if (!Array.isArray(children) || children.length < 1 || children.length > CREATE_CHILDREN_MAX) {
      return {
        ok: false,
        error: fieldValue('/args/children', Array.isArray(children) ? children.length : children, `array of 1-${CREATE_CHILDREN_MAX} createEntity args`, `a folder is created with 1 to ${CREATE_CHILDREN_MAX} children`),
      };
    }
    const checked: CreateEntityArgs[] = [];
    for (let i = 0; i < children.length; i += 1) {
      const c = children[i];
      const path = `/args/children/${i}`;
      if (!isPlainObjectStrict(c)) return { ok: false, error: fieldType(path, c, 'object (createEntity args)') };
      for (const key of ['parentId', 'children'] as const) {
        if (c[key] !== undefined) return { ok: false, error: fieldUnexpected(`${path}/${key}`, key, 'kind, name, transform, box, model, components, surfacePreset', 'a child is created inside the new folder') };
      }
      if (c['kind'] === 'folder') {
        return { ok: false, error: fieldValue(`${path}/kind`, 'folder', '"group", "box" or "model"', 'a child of a new folder is an object, not a folder') };
      }
      const r = validateCreateArgs(c);
      if (!r.ok) return { ok: false, error: { ...r.error, path: `${path}${(r.error.path ?? '').replace(/^\/args/, '')}` } };
      checked.push(r.args);
    }
    out.children = checked;
  }
  return { ok: true, args: out };
}

/** The most children one folder `createEntity` may create. */
export const CREATE_CHILDREN_MAX = 256;

export function validateSetAssetOptionsArgs(args: Record<string, unknown>):
  | { ok: true; args: SetAssetOptionsArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'assetId' && key !== 'vertexColors' && key !== 'materials' && key !== 'clipsFor' && key !== 'sourcePath' && key !== 'loadType' && key !== 'preload' && key !== 'streaming' && key !== 'lod' && key !== 'occluder') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'assetId, vertexColors, materials, clipsFor, sourcePath, loadType, preload, streaming, lod, occluder') };
    }
  }
  if (args['assetId'] === undefined) return { ok: false, error: fieldMissing('/args/assetId', 'assetId') };
  if (typeof args['assetId'] !== 'string') return { ok: false, error: fieldType('/args/assetId', args['assetId'], 'string (asset ID)') };
  if (args['vertexColors'] === undefined && args['materials'] === undefined && args['clipsFor'] === undefined && args['sourcePath'] === undefined && args['loadType'] === undefined && args['preload'] === undefined && args['streaming'] === undefined && args['lod'] === undefined && args['occluder'] === undefined) {
    return { ok: false, error: fieldMissing('/args/vertexColors', 'vertexColors, materials, clipsFor, sourcePath, loadType, preload, streaming, lod or occluder') };
  }
  // A model's LOD group settings (null: the defaults).
  const lod = args['lod'];
  if (lod !== undefined && lod !== null) {
    const problem = modelLodProblems(lod, '/args/lod')[0];
    if (problem !== undefined) return { ok: false, error: { ...(problem as unknown as CommandError), cls: 'validation' } };
  }
  // What of a model counts as an occluder (auto, the default, is stored as absence).
  const occluder = args['occluder'];
  if (occluder !== undefined && !(MODEL_OCCLUDER_MODES as readonly unknown[]).includes(occluder)) {
    return { ok: false, error: fieldValue('/args/occluder', occluder, '"auto", "occ" or "none"', 'occluder is auto (its _OCC nodes, else its opaque surfaces), occ (only its _OCC nodes) or none') };
  }
  // A texture's mip streaming (null: the default for its size).
  const streaming = args['streaming'];
  if (streaming !== undefined && streaming !== null && typeof streaming !== 'boolean') {
    return { ok: false, error: fieldType('/args/streaming', streaming, 'boolean (stream the texture\'s mips) or null (the default: on for a KTX2 texture over 1024 px)') };
  }
  // An audio file's load settings.
  const loadType = args['loadType'];
  if (loadType !== undefined && loadType !== null && !(AUDIO_LOAD_TYPES as readonly unknown[]).includes(loadType)) {
    return { ok: false, error: fieldValue('/args/loadType', loadType, '"decode-on-load", "decode-while-playing", "stream" or null', 'loadType is how the game holds an audio file (null: the default for its length)') };
  }
  const preload = args['preload'];
  if (preload !== undefined && typeof preload !== 'boolean') return { ok: false, error: fieldType('/args/preload', preload, 'boolean (true: read with its scene; false: only when played)') };
  // Where the asset's file is in the game folder (a moved file keeps its asset).
  const sourcePath = args['sourcePath'];
  if (sourcePath !== undefined && !isValidSourcePath(sourcePath)) {
    return { ok: false, error: fieldValue('/args/sourcePath', sourcePath, 'a relative path with forward slashes, no "..", "." or empty segments', 'sourcePath is the asset file\'s path inside the game folder') };
  }
  // The rig an animation-only file's clips are for (null clears it).
  const clipsFor = args['clipsFor'];
  if (clipsFor !== undefined && clipsFor !== null && typeof clipsFor !== 'string') {
    return { ok: false, error: fieldType('/args/clipsFor', clipsFor, 'string (the model assetId whose rig the clips are for) or null') };
  }
  if (args['vertexColors'] !== undefined && args['vertexColors'] !== 'data' && args['vertexColors'] !== 'tint' && args['vertexColors'] !== 'trim') {
    return {
      ok: false,
      error: fieldValue('/args/vertexColors', args['vertexColors'], '"data", "tint" or "trim"', 'vertexColors is "data" (COLOR_0 is shader data), "tint" (it multiplies the base colour) or "trim" (it is trim data: R occlusion, B wetness)'),
    };
  }
  const materials = args['materials'];
  if (materials !== undefined && materials !== null && !isPlainObjectStrict(materials)) {
    return { ok: false, error: fieldType('/args/materials', materials, 'object { <material name or "*">: materialId } or null') };
  }
  return {
    ok: true,
    args: {
      assetId: args['assetId'],
      ...(args['vertexColors'] !== undefined ? { vertexColors: args['vertexColors'] } : {}),
      ...(materials !== undefined ? { materials: materials as Record<string, string> | null } : {}),
      ...(clipsFor !== undefined ? { clipsFor: clipsFor as string | null } : {}),
      ...(sourcePath !== undefined ? { sourcePath: sourcePath as string } : {}),
      ...(loadType !== undefined ? { loadType: loadType as SetAssetOptionsArgs['loadType'] } : {}),
      ...(preload !== undefined ? { preload } : {}),
      ...(streaming !== undefined ? { streaming: streaming as boolean | null } : {}),
      ...(lod !== undefined ? { lod: lod as SetAssetOptionsArgs['lod'] } : {}),
      ...(occluder !== undefined ? { occluder: occluder as ModelOccluderMode } : {}),
    },
  };
}

export function validateSetTransformArgs(args: Record<string, unknown>):
  | { ok: true; args: SetTransformArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityId' && key !== 'transform') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'entityId, transform') };
    }
  }
  if (args['entityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  }
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  if (args['transform'] === undefined) {
    return { ok: false, error: fieldMissing('/args/transform', 'transform') };
  }
  const t = args['transform'];
  if (!isPlainObjectStrict(t)) {
    return {
      ok: false,
      error: fieldType(
        '/args/transform',
        t,
        'object with any non-empty subset of position, rotation, scale',
      ),
    };
  }
  const checked = validateTransformArgs(t, '/args/transform');
  if ('error' in checked) return { ok: false, error: checked.error };
  if (
    checked.position === undefined &&
    checked.rotation === undefined &&
    checked.scale === undefined
  ) {
    return {
      ok: false,
      error: fieldValue(
        '/args/transform',
        {},
        'non-empty object: at least one of position, rotation, scale',
        'transform must be a non-empty partial transform (empty object changes nothing)',
      ),
    };
  }
  return { ok: true, args: { entityId: args['entityId'], transform: checked } };
}

export function validateDeleteArgs(args: Record<string, unknown>):
  | { ok: true; args: DeleteEntityArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityId' && key !== 'entityIds') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'entityId, entityIds (optional)') };
    }
  }
  if (args['entityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  }
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  const more = args['entityIds'];
  if (more === undefined) return { ok: true, args: { entityId: args['entityId'] } };
  if (!Array.isArray(more)) return { ok: false, error: fieldType('/args/entityIds', more, `array of 1-${DELETE_ENTITIES_MAX} entity IDs`) };
  if (more.length < 1 || more.length > DELETE_ENTITIES_MAX) {
    return { ok: false, error: fieldValue('/args/entityIds', more.length, `1-${DELETE_ENTITIES_MAX} entity IDs`, `deleteEntity removes 1 to ${DELETE_ENTITIES_MAX} further entities`) };
  }
  for (let i = 0; i < more.length; i++) {
    if (typeof more[i] !== 'string') return { ok: false, error: fieldType(`/args/entityIds/${i}`, more[i], 'string (entity ID)') };
  }
  if (new Set(more).size !== more.length || more.includes(args['entityId'])) {
    return { ok: false, error: fieldValue('/args/entityIds', more, 'distinct entity IDs other than entityId', 'an entity is named twice') };
  }
  return { ok: true, args: { entityId: args['entityId'], entityIds: more as string[] } };
}

export function validateUpdateEntityArgs(args: Record<string, unknown>):
  | { ok: true; args: UpdateEntityArgs }
  | { ok: false; error: CommandError } {
  const KNOWN_UPDATE = ['entityId', 'name', 'parentId', ...ENTITY_FLAGS, 'tags'];
  for (const key of Object.keys(args)) {
    if (!KNOWN_UPDATE.includes(key)) {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, KNOWN_UPDATE.join(', ')) };
    }
  }
  if (args['entityId'] === undefined) return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  const out: UpdateEntityArgs = { entityId: args['entityId'] };
  if (args['name'] !== undefined) {
    if (typeof args['name'] !== 'string') return { ok: false, error: fieldType('/args/name', args['name'], 'string') };
    if (!isValidName(args['name'])) {
      return {
        ok: false,
        error: fieldValue('/args/name', args['name'], 'string, 1-128 chars, no control characters', 'name must be 1-128 characters without control characters'),
      };
    }
    out.name = args['name'];
  }
  if (args['parentId'] !== undefined) {
    if (args['parentId'] !== null && typeof args['parentId'] !== 'string') {
      return { ok: false, error: fieldType('/args/parentId', args['parentId'], 'string (entity ID) or null') };
    }
    out.parentId = args['parentId'];
  }
  for (const flag of ENTITY_FLAGS) {
    const v = args[flag];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: fieldType(`/args/${flag}`, v, 'boolean') };
    out[flag] = v;
  }
  const tags = args['tags'];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) return { ok: false, error: fieldType('/args/tags', tags, `array of up to ${MAX_TAGS} tag names`) };
    for (let i = 0; i < tags.length; i++) {
      if (typeof tags[i] !== 'string') return { ok: false, error: fieldType(`/args/tags/${i}`, tags[i], 'string (tag name)') };
    }
    out.tags = tags as string[];
  }
  if (out.name === undefined && out.parentId === undefined && ENTITY_FLAGS.every((f) => out[f] === undefined) && out.tags === undefined) {
    return { ok: false, error: fieldMissing('/args/name', `name, parentId, ${ENTITY_FLAGS.join(', ')} or tags`) };
  }
  return { ok: true, args: out };
}

/** The scene-index ops' args. */
export function validateSceneIndexArgs(op: 'createScene' | 'renameScene' | 'deleteScene' | 'setStartScenes', args: Record<string, unknown>):
  | { ok: true; args: SceneIndexArgs }
  | { ok: false; error: CommandError } {
  const allowed = op === 'createScene' ? ['sceneId', 'name', 'environmentFrom'] : op === 'renameScene' ? ['sceneId', 'name'] : op === 'deleteScene' ? ['sceneId'] : ['sceneIds'];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, allowed.join(', ')) };
  }
  const name = args['name'];
  if (op === 'createScene' || op === 'renameScene') {
    if (name === undefined) return { ok: false, error: fieldMissing('/args/name', 'name') };
    if (typeof name !== 'string' || !isValidName(name)) {
      return { ok: false, error: fieldValue('/args/name', name, 'string, 1-128 chars, no control characters', 'a scene name is 1-128 characters') };
    }
  }
  const sceneId = args['sceneId'];
  if (op !== 'setStartScenes' && !(op === 'createScene' && sceneId === undefined)) {
    if (sceneId === undefined) return { ok: false, error: fieldMissing('/args/sceneId', 'sceneId') };
    if (typeof sceneId !== 'string') return { ok: false, error: fieldType('/args/sceneId', sceneId, 'string (scene id)') };
  }
  const from = args['environmentFrom'];
  if (op === 'createScene' && from !== undefined && typeof from !== 'string') return { ok: false, error: fieldType('/args/environmentFrom', from, 'string (the scene whose look the new scene copies)') };
  if (op === 'createScene') return { ok: true, args: { op, name: name as string, ...(sceneId !== undefined ? { sceneId: sceneId as string } : {}), ...(from !== undefined ? { environmentFrom: from as string } : {}) } };
  if (op === 'renameScene') return { ok: true, args: { op, sceneId: sceneId as string, name: name as string } };
  if (op === 'deleteScene') return { ok: true, args: { op, sceneId: sceneId as string } };
  const ids = args['sceneIds'];
  if (ids === undefined) return { ok: false, error: fieldMissing('/args/sceneIds', 'sceneIds') };
  if (!Array.isArray(ids) || ids.length < 1 || ids.some((x) => typeof x !== 'string')) {
    return { ok: false, error: fieldType('/args/sceneIds', ids, 'array of at least 1 scene id') };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: fieldValue('/args/sceneIds', ids, 'distinct scene ids', 'a scene is listed twice') };
  return { ok: true, args: { op, sceneIds: ids as string[] } };
}

export function validateSetTagsArgs(args: Record<string, unknown>):
  | { ok: true; args: SetTagsArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'tags') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'tags') };
  }
  const tags = args['tags'];
  if (tags === undefined) return { ok: false, error: fieldMissing('/args/tags', 'tags') };
  if (!Array.isArray(tags)) return { ok: false, error: fieldType('/args/tags', tags, 'array of { bit?, name }') };
  if (tags.length > MAX_TAGS) return { ok: false, error: fieldValue('/args/tags', tags.length, `at most ${MAX_TAGS} tags`, `a project has at most ${MAX_TAGS} tags`) };
  const out: SetTagsArgs['tags'] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const p = `/args/tags/${i}`;
    if (!isPlainObjectStrict(t)) return { ok: false, error: fieldType(p, t, 'object { bit?, name }') };
    for (const key of Object.keys(t)) {
      if (key !== 'bit' && key !== 'name') return { ok: false, error: fieldUnexpected(`${p}/${pointerSegment(key)}`, key, 'bit (optional), name') };
    }
    const name = t['name'];
    if (typeof name !== 'string') return { ok: false, error: fieldType(`${p}/name`, name, 'string') };
    if (!TAG_NAME_RE.test(name)) {
      return { ok: false, error: fieldValue(`${p}/name`, name, 'a letter, then letters, digits, _ or -; 1-32 characters', 'tag names are short identifiers') };
    }
    const bit = t['bit'];
    if (bit !== undefined && (typeof bit !== 'number' || !Number.isInteger(bit) || bit < 0 || bit > 31)) {
      return { ok: false, error: fieldValue(`${p}/bit`, bit, 'integer 0-31', 'a tag bit is an integer from 0 to 31') };
    }
    out.push(bit === undefined ? { name } : { bit: bit as number, name });
  }
  return { ok: true, args: { tags: out } };
}

export function validateMoveEntitiesArgs(args: Record<string, unknown>):
  | { ok: true; args: MoveEntitiesArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityIds' && key !== 'parentId' && key !== 'beforeId' && key !== 'sceneId') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'entityIds, parentId, beforeId (optional), sceneId (optional)') };
    }
  }
  const ids = args['entityIds'];
  if (ids === undefined) return { ok: false, error: fieldMissing('/args/entityIds', 'entityIds') };
  if (!Array.isArray(ids)) return { ok: false, error: fieldType('/args/entityIds', ids, 'array of entity IDs') };
  // No count: a whole selection moves in one command (one undo step), bounded by the request's bytes.
  if (ids.length < 1) {
    return { ok: false, error: fieldValue('/args/entityIds', ids.length, 'at least 1 entity ID', 'moveEntities moves at least one entity') };
  }
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'string') return { ok: false, error: fieldType(`/args/entityIds/${i}`, ids[i], 'string (entity ID)') };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: fieldValue('/args/entityIds', ids, 'distinct entity IDs', 'an entity is named twice') };
  }
  if (!('parentId' in args)) return { ok: false, error: fieldMissing('/args/parentId', 'parentId') };
  const parentId = args['parentId'];
  if (parentId !== null && typeof parentId !== 'string') {
    return { ok: false, error: fieldType('/args/parentId', parentId, 'string (entity ID) or null') };
  }
  const out: MoveEntitiesArgs = { entityIds: ids as string[], parentId };
  const beforeId = args['beforeId'];
  if (beforeId !== undefined) {
    if (beforeId !== null && typeof beforeId !== 'string') {
      return { ok: false, error: fieldType('/args/beforeId', beforeId, 'string (entity ID) or null') };
    }
    out.beforeId = beforeId;
  }
  // Into another scene (ids and references kept).
  const sceneId = args['sceneId'];
  if (sceneId !== undefined) {
    if (typeof sceneId !== 'string') return { ok: false, error: fieldType('/args/sceneId', sceneId, 'string (scene ID)') };
    out.sceneId = sceneId;
  }
  return { ok: true, args: out };
}

export function validateUndoRedoArgs(op: 'undo' | 'redo', args: Record<string, unknown>):
  | { ok: true; args: EmptyArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    return {
      ok: false,
      error: fieldUnexpected(
        `/args/${pointerSegment(key)}`,
        key,
        '(none)',
        `${op} takes no arguments (args must be exactly {})`,
      ),
    };
  }
  return { ok: true, args: {} };
}
