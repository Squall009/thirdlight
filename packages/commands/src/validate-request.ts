/**
 * Strict mutation-request validation — commands.md §3/§3.1.
 *
 * The input is the transport-parsed request value (`unknown`). Validation
 * is total: any malformed input yields a structured error, never a thrown
 * exception. Strictness mirrors the data contract: unknown fields at any
 * level of the request or of `args` fail (nothing is silently dropped),
 * missing required fields fail with `field_missing`, wrong JSON types with
 * `field_type`, right type / wrong value with `field_value`.
 *
 * Code assignment (commands.md §5.4): envelope-level schema failures
 * (top-level fields: `op`, `projectId`, `expectedRevision`, `requestId`,
 * `origin`, and `args` itself missing or not an object) are
 * `invalid_request`; failures inside `args` are the `field_*` codes, with
 * `path` a JSON Pointer into the request.
 *
 * Two passes, orchestrated by `applyMutation` (commands.md §6.1 step 4 —
 * "revision checking precedes argument validation"): the ENVELOPE pass
 * (`validateRequestEnvelope`: op/projectId/expectedRevision/requestId/
 * origin and `args`-is-an-object → `invalid_request`) runs BEFORE the
 * revision check; the per-op ARGS-SCHEMA pass (`validateOpArgs`: `field_*`)
 * runs AFTER the revision check (`revision_conflict`) and the
 * `revision_exhausted` check. `validateMutationRequest` composes both
 * (envelope, then args) for callers that want full validation in one
 * call; it does not itself implement the pipeline order.
 *
 * Value constraints on transform/box numbers (vector length, finiteness,
 * ranges, quaternion norm, color syntax) are deliberately NOT re-implemented
 * here: they are enforced by the project-model validation of the RESULTING
 * scene (pipeline step 5, commands.md §6.1) and surface as `result-scene`
 * details — exactly the pinned behavior of the
 * `scenarios/04-invalid-no-partial` quaternion_invalid case. The model
 * stays the single authority for document value rules.
 */

import { validateGraphOps, type GraphDocument, type GraphOp, type ModelErrorV2 } from '@thirdlight/project-model';
import { M2_SETTINGS_KEYS, TAG_NAME_RE, type AnimatorController, type GameFlow, type InputConfig, type EnvironmentConfig, type LightingBake, type MaterialDef } from '@thirdlight/project-model';

import {
  ID_RE,
  MAX_REQUEST_BYTES,
  REQUEST_ID_RE,
  fieldType,
  fieldMissing,
  fieldUnexpected,
  fieldValue,
  invalidRequest,
  isPlainObject,
  isValidName,
  jsonType,
  limitsExceeded,
} from './errors';
import { SURFACE_PRESET_NAMES } from './v3';
import { validatePasteArgs } from './paste-ops';
import {
  validateAcknowledgeBehaviorTrustArgs,
  validateApplySurfacePresetArgs,
  validatePublishAssetArgs,
  validatePublishBehaviorArgs,
  validateSetBehaviorPropertiesArgs,
  validateSetComponentArgs,
  validateSetGameConfigArgs,
  validateSetSettingsArgs,
} from './validate-content-args';
import {
  validateCreatePrefabArgs,
  validateInstantiatePrefabArgs,
} from './validate-prefab-args';
import type {
  AcknowledgeBehaviorTrustArgs,
  ApplySurfacePresetArgs,
  BoxArgs,
  CommandError,
  CreateEntityArgs,
  CreatePrefabArgs,
  DeleteEntityArgs,
  EmptyArgs,
  InstantiatePrefabArgs,
  MutationArgs,
  MutationOp,
  Origin,
  PartialTransformArgs,
  PublishAssetArgs,
  PublishBehaviorArgs,
  SetBehaviorPropertiesArgs,
  SetComponentArgs,
  SetGameConfigArgs,
  SetSettingsArgs,
  SetTransformArgs,
  UpdateEntityArgs,
  MoveEntitiesArgs,
  SetTagsArgs,
  SetAssetOptionsArgs,
  PasteEntitiesArgs,
  SceneIndexArgs,
} from './types';

const TOP_FIELDS = [
  'op',
  'projectId',
  'expectedRevision',
  'requestId',
  'origin',
  'args',
] as const;

const OPS: readonly MutationOp[] = [
  'createEntity',
  'setTransform',
  'deleteEntity',
  'undo',
  'redo',
  // non-prefab M2 content/property ops (packet 21):
  'publishAsset',
  'publishBehavior',
  'setBehaviorProperties',
  'setComponent',
  'setSettings',
  'acknowledgeBehaviorTrust',
  // prefab M2 ops (packet 22):
  'createPrefab',
  'instantiatePrefab',
  // v3 game/presentation ops (packet 45):
  'applySurfacePreset',
  'setGameConfig',
  'updateEntity',
  // phase 12 hierarchy + tags:
  'moveEntities',
  'setTags',
  'setAssetOptions',
  'pasteEntities',
  'setMaterial',
  'deleteMaterial',
  'setEnvironment',
  'setLighting',
  'setAnimator',
  'deleteAnimator',
  'setInput',
  'setFlow',
  'createScene',
  'renameScene',
  'deleteScene',
  'setStartScenes',
  // phase 16.1: graphs
  'setGraph',
  'deleteGraph',
  'graphEdit',
];

const ORIGIN_KINDS = ['browser', 'mcp', 'admin'] as const;

/** The most entities one `moveEntities` may name (phase 12). */
export const MOVE_ENTITIES_MAX = 64;

const TRANSFORM_FIELDS = ['position', 'rotation', 'scale'] as const;
type TransformField = (typeof TRANSFORM_FIELDS)[number];

/** §3.1: the add-capable `createEntity.components` key set (closed). */
const CREATE_COMPONENTS: readonly string[] = [
  'collider',
  'controller',
  'gameZone',
  'playerSpawn',
  'cameraFollow',
  'light',
  'surface',
  'modelAnimation',
  // Phase 12 (c): v4 scenes only.
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

/** Expected-text constants (the `expected` strings are log-safe, stable). */
const EXPECT = {
  op: 'one of: createEntity, setTransform, deleteEntity, undo, redo, publishAsset, publishBehavior, setBehaviorProperties, setComponent, setSettings, acknowledgeBehaviorTrust, createPrefab, instantiatePrefab, applySurfacePreset, setGameConfig, updateEntity, moveEntities, setTags, setAssetOptions, pasteEntities, setMaterial, deleteMaterial, setEnvironment, setLighting, setAnimator, deleteAnimator, setInput, setFlow, createScene, renameScene, deleteScene, setStartScenes, setGraph, deleteGraph, graphEdit',
  projectId: 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}',
  expectedRevision: 'integer, 0 <= v <= 2^53-1',
  requestId: 'req- + 32 lowercase hex chars: ^req-[0-9a-f]{32}$',
  origin: 'object { kind: browser | mcp | admin, clientId: string 1-128, no control chars }',
  args: 'object (op-specific, strict)',
} as const;

export const TOP_FIELDS_EXPECTED = 'known fields: op, projectId, expectedRevision, requestId, origin (optional), args';

/**
 * RFC 6901 escaping of one JSON Pointer reference token (commands.md §3:
 * every field error carries `path` — "a JSON Pointer into the request";
 * RFC 6901 is the JSON Pointer standard). DYNAMIC keys (unknown fields at
 * any nesting level) are interpolated into `path` ONLY through this helper:
 * `~` → `~0` FIRST, then `/` → `~1`. Static segment names (`op`, `args`,
 * `position`, …) and numeric indices never need escaping.
 */
function pointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export type ValidatedMutationRequest = {
  op: MutationOp;
  projectId: string;
  expectedRevision: number;
  requestId: string;
  origin: Origin | null;
  args: MutationArgs;
};

export type RequestValidation =
  | { ok: true; request: ValidatedMutationRequest }
  | { ok: false; error: CommandError };

/**
 * Byte length of the §6.6 canonical request form (keys sorted, no
 * whitespace, `JSON.stringify` number semantics) without recursion, so a
 * deeply nested malformed request cannot exhaust the stack: the public entry
 * points are total (commands.md §3; the O1 repair contract).
 */
export function canonicalRequestByteLength(request: unknown): number {
  let bytes = 0;
  const stack: ({ v: unknown } | { text: string })[] = [{ v: request }];
  while (stack.length > 0) {
    const frame = stack.pop() as { v: unknown } | { text: string };
    if ('text' in frame) {
      bytes += utf8ByteLength(frame.text);
      continue;
    }
    const val = frame.v;
    if (val === null) {
      bytes += 4;
      continue;
    }
    const t = typeof val;
    if (t === 'number') {
      bytes += (JSON.stringify(val) ?? 'null').length;
      continue;
    }
    if (t === 'boolean') {
      bytes += val ? 4 : 5;
      continue;
    }
    if (t === 'string') {
      bytes += utf8ByteLength(JSON.stringify(val));
      continue;
    }
    if (Array.isArray(val)) {
      bytes += 2 + Math.max(0, val.length - 1);
      for (let i = val.length - 1; i >= 0; i--) stack.push({ v: val[i] });
      continue;
    }
    if (t === 'object') {
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
      bytes += 2 + Math.max(0, keys.length - 1);
      const sorted = keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (let i = sorted.length - 1; i >= 0; i--) {
        const k = sorted[i] as string;
        stack.push({ v: obj[k] });
        stack.push({ text: `${JSON.stringify(k)}:` });
      }
      continue;
    }
    // undefined / function / symbol emit no token in the canonical form.
  }
  return bytes;
}

/** UTF-8 byte length of a string (no TextEncoder allocation). */
function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * §3.1 convention: the request's canonical bytes must be ≤ 65 536
 * (`limits_exceeded` `request_bytes`), checked before argument validation and
 * after the revision check. Returns the limit error, or null.
 */
export function checkRequestBytes(request: unknown): CommandError | null {
  const bytes = canonicalRequestByteLength(request);
  if (bytes > MAX_REQUEST_BYTES) {
    return limitsExceeded(
      'request_bytes',
      bytes,
      MAX_REQUEST_BYTES,
      `the canonical request exceeds the ${MAX_REQUEST_BYTES}-byte cap (${bytes})`,
    );
  }
  return null;
}

// ---- envelope level (invalid_request) ------------------------------------------

export interface EnvelopeOk {
  ok: true;
  envelope: Omit<ValidatedMutationRequest, 'args'>;
  /** The raw `args` object (validated to be a plain object by the envelope pass). */
  args: Record<string, unknown>;
}

function validateEnvelope(
  req: Record<string, unknown>,
): { ok: false; error: CommandError } | EnvelopeOk {
  // Strict top-level fields first (commands.md §3: nothing silently
  // dropped). Unknown TOP-level fields are envelope-level ⇒
  // `invalid_request` (commands.md §5.4: "envelope-level schema failure of
  // the request itself (… unknown fields, etc.)").
  for (const key of Object.keys(req)) {
    if (!(TOP_FIELDS as readonly string[]).includes(key)) {
      return {
        ok: false,
        error: invalidRequest(
          `/${pointerSegment(key)}`,
          key,
          TOP_FIELDS_EXPECTED,
          'unknown field is not permitted (strict M1 request drops nothing)',
        ),
      };
    }
  }

  if (req['op'] === undefined) {
    return {
      ok: false,
      error: invalidRequest('/op', undefined, EXPECT.op, 'required field \'op\' is missing'),
    };
  }
  if (typeof req['op'] !== 'string' || !OPS.includes(req['op'] as MutationOp)) {
    return {
      ok: false,
      error: invalidRequest(
        '/op',
        req['op'],
        EXPECT.op,
        typeof req['op'] !== 'string'
          ? 'op must be a string, one of the five M1 mutation ops'
          : 'op is not one of the five M1 mutation ops',
      ),
    };
  }
  if (req['projectId'] === undefined) {
    return {
      ok: false,
      error: invalidRequest(
        '/projectId',
        undefined,
        EXPECT.projectId,
        'required field \'projectId\' is missing',
      ),
    };
  }
  if (typeof req['projectId'] !== 'string' || !ID_RE.test(req['projectId'])) {
    return {
      ok: false,
      error: invalidRequest(
        '/projectId',
        req['projectId'],
        EXPECT.projectId,
        'projectId must use the project-model ID syntax',
      ),
    };
  }
  if (req['expectedRevision'] === undefined) {
    return {
      ok: false,
      error: invalidRequest(
        '/expectedRevision',
        undefined,
        EXPECT.expectedRevision,
        'required field \'expectedRevision\' is missing',
      ),
    };
  }
  const er = req['expectedRevision'];
  if (typeof er !== 'number' || !Number.isSafeInteger(er) || er < 0) {
    return {
      ok: false,
      error: invalidRequest(
        '/expectedRevision',
        er,
        EXPECT.expectedRevision,
        'expectedRevision must be an integer with 0 <= v <= 2^53-1',
      ),
    };
  }
  if (req['requestId'] === undefined) {
    return {
      ok: false,
      error: invalidRequest(
        '/requestId',
        undefined,
        EXPECT.requestId,
        'required field \'requestId\' is missing',
      ),
    };
  }
  if (typeof req['requestId'] !== 'string' || !REQUEST_ID_RE.test(req['requestId'])) {
    return {
      ok: false,
      error: invalidRequest(
        '/requestId',
        req['requestId'],
        EXPECT.requestId,
        'requestId must match req- + 32 lowercase hex chars',
      ),
    };
  }
  let origin: Origin | null = null;
  if (req['origin'] !== undefined) {
    const o = req['origin'];
    if (!isPlainObject(o)) {
      return {
        ok: false,
        error: invalidRequest('/origin', o, EXPECT.origin, 'origin must be an object { kind, clientId }'),
      };
    }
    for (const key of Object.keys(o)) {
      if (key !== 'kind' && key !== 'clientId') {
        return {
          ok: false,
          error: invalidRequest(
            `/origin/${pointerSegment(key)}`,
            key,
            'known fields: kind, clientId',
            'unknown field is not permitted (strict M1 origin)',
          ),
        };
      }
    }
    if (typeof o['kind'] !== 'string' || !(ORIGIN_KINDS as readonly string[]).includes(o['kind'])) {
      return {
        ok: false,
        error: invalidRequest(
          '/origin/kind',
          o['kind'],
          'one of: browser, mcp, admin',
          'origin.kind must be one of browser, mcp, admin',
        ),
      };
    }
    if (typeof o['clientId'] !== 'string' || !isValidName(o['clientId'])) {
      return {
        ok: false,
        error: invalidRequest(
          '/origin/clientId',
          o['clientId'],
          'string, 1-128 chars, no control characters',
          'origin.clientId must be 1-128 characters without control characters',
        ),
      };
    }
    origin = { kind: o['kind'] as Origin['kind'], clientId: o['clientId'] };
  }
  if (req['args'] === undefined) {
    return {
      ok: false,
      error: invalidRequest('/args', undefined, EXPECT.args, 'required field \'args\' is missing'),
    };
  }
  if (!isPlainObject(req['args'])) {
    return {
      ok: false,
      error: invalidRequest('/args', req['args'], EXPECT.args, 'args must be an object (op-specific, strict)'),
    };
  }
  return {
    ok: true,
    envelope: {
      op: req['op'] as MutationOp,
      projectId: req['projectId'] as string,
      expectedRevision: er,
      requestId: req['requestId'] as string,
      origin,
    },
    args: req['args'] as Record<string, unknown>,
  };
}

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
    // layer guarantees only the array shape (commands.md §3.1 strictness).
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
  if (!isPlainObject(box)) {
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
    if (!isPlainObject(m)) {
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

function validateCreateArgs(args: Record<string, unknown>):
  | { ok: true; args: CreateEntityArgs }
  | { ok: false; error: CommandError } {
  const KNOWN =
    'kind, parentId (optional), name (optional), transform (optional), box (optional, box only), model (optional, model only), components (optional), surfacePreset (optional), children (optional, folder only)';
  for (const key of Object.keys(args)) {
    if (
      key !== 'kind' &&
      key !== 'parentId' &&
      key !== 'name' &&
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
    // Phase 12: a folder is organisation only.
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
  if (args['transform'] !== undefined) {
    const t = args['transform'];
    if (!isPlainObject(t)) {
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
    if (!isPlainObject(m)) {
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
    if (!isPlainObject(asset)) {
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
  // §3.1/authoring §A3.1: the add-capable components, created in the same
  // transaction. Unknown keys are `component_unknown`; the per-component
  // VALUES are validated by the op (project-model §23.3).
  if (args['components'] !== undefined) {
    const components = args['components'];
    if (!isPlainObject(components)) {
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
        return {
          ok: false,
          error: {
            code: 'component_unknown',
            cls: 'validation',
            path: `/args/components/${pointerSegment(key)}`,
            found: components[key],
            expected: CREATE_COMPONENTS.map((c) => `"${c}"`).join(', '),
            message: 'unknown component name (the registry is closed)',
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
        error: fieldValue('/args/surfacePreset', preset, '"matte-ground", "hazard" or "beacon"', 'surfacePreset must be one of the three built-in presets'),
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
      if (!isPlainObject(c)) return { ok: false, error: fieldType(path, c, 'object (createEntity args)') };
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

function validateSetAssetOptionsArgs(args: Record<string, unknown>):
  | { ok: true; args: SetAssetOptionsArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'assetId' && key !== 'vertexColors' && key !== 'materials' && key !== 'clipsFor') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'assetId, vertexColors, materials, clipsFor') };
    }
  }
  if (args['assetId'] === undefined) return { ok: false, error: fieldMissing('/args/assetId', 'assetId') };
  if (typeof args['assetId'] !== 'string') return { ok: false, error: fieldType('/args/assetId', args['assetId'], 'string (asset ID)') };
  if (args['vertexColors'] === undefined && args['materials'] === undefined && args['clipsFor'] === undefined) return { ok: false, error: fieldMissing('/args/vertexColors', 'vertexColors, materials or clipsFor') };
  // Phase 14.6: the rig an animation-only file's clips are for (null clears it).
  const clipsFor = args['clipsFor'];
  if (clipsFor !== undefined && clipsFor !== null && typeof clipsFor !== 'string') {
    return { ok: false, error: fieldType('/args/clipsFor', clipsFor, 'string (the model assetId whose rig the clips are for) or null') };
  }
  if (args['vertexColors'] !== undefined && args['vertexColors'] !== 'data' && args['vertexColors'] !== 'tint') {
    return {
      ok: false,
      error: fieldValue('/args/vertexColors', args['vertexColors'], '"data" or "tint"', 'vertexColors is "data" (COLOR_0 is shader data) or "tint" (it multiplies the base colour)'),
    };
  }
  const materials = args['materials'];
  if (materials !== undefined && materials !== null && !isPlainObject(materials)) {
    return { ok: false, error: fieldType('/args/materials', materials, 'object { <material name or "*">: materialId } or null') };
  }
  return {
    ok: true,
    args: {
      assetId: args['assetId'],
      ...(args['vertexColors'] !== undefined ? { vertexColors: args['vertexColors'] } : {}),
      ...(materials !== undefined ? { materials: materials as Record<string, string> | null } : {}),
      ...(clipsFor !== undefined ? { clipsFor: clipsFor as string | null } : {}),
    },
  };
}

function validateSetTransformArgs(args: Record<string, unknown>):
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
  if (!isPlainObject(t)) {
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

function validateDeleteArgs(args: Record<string, unknown>):
  | { ok: true; args: DeleteEntityArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityId') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'entityId') };
    }
  }
  if (args['entityId'] === undefined) {
    return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  }
  if (typeof args['entityId'] !== 'string') {
    return { ok: false, error: fieldType('/args/entityId', args['entityId'], 'string (entity ID)') };
  }
  return { ok: true, args: { entityId: args['entityId'] } };
}

function validateUpdateEntityArgs(args: Record<string, unknown>):
  | { ok: true; args: UpdateEntityArgs }
  | { ok: false; error: CommandError } {
  const KNOWN_UPDATE = ['entityId', 'name', 'parentId', 'active', 'locked', 'static', 'tags'];
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
  for (const flag of ['active', 'locked', 'static'] as const) {
    const v = args[flag];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: fieldType(`/args/${flag}`, v, 'boolean') };
    out[flag] = v;
  }
  const tags = args['tags'];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > 32) return { ok: false, error: fieldType('/args/tags', tags, 'array of up to 32 tag names') };
    for (let i = 0; i < tags.length; i++) {
      if (typeof tags[i] !== 'string') return { ok: false, error: fieldType(`/args/tags/${i}`, tags[i], 'string (tag name)') };
    }
    out.tags = tags as string[];
  }
  if (out.name === undefined && out.parentId === undefined && out.active === undefined && out.locked === undefined && out.static === undefined && out.tags === undefined) {
    return { ok: false, error: fieldMissing('/args/name', 'name, parentId, active, locked, static or tags') };
  }
  return { ok: true, args: out };
}

/** Phase 12 (c): the scene-index ops' args. */
function validateSceneIndexArgs(op: 'createScene' | 'renameScene' | 'deleteScene' | 'setStartScenes', args: Record<string, unknown>):
  | { ok: true; args: SceneIndexArgs }
  | { ok: false; error: CommandError } {
  const allowed = op === 'createScene' ? ['sceneId', 'name'] : op === 'renameScene' ? ['sceneId', 'name'] : op === 'deleteScene' ? ['sceneId'] : ['sceneIds'];
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
  if (op === 'createScene') return { ok: true, args: { op, name: name as string, ...(sceneId !== undefined ? { sceneId: sceneId as string } : {}) } };
  if (op === 'renameScene') return { ok: true, args: { op, sceneId: sceneId as string, name: name as string } };
  if (op === 'deleteScene') return { ok: true, args: { op, sceneId: sceneId as string } };
  const ids = args['sceneIds'];
  if (ids === undefined) return { ok: false, error: fieldMissing('/args/sceneIds', 'sceneIds') };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || ids.some((x) => typeof x !== 'string')) {
    return { ok: false, error: fieldType('/args/sceneIds', ids, 'array of 1-64 scene ids') };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: fieldValue('/args/sceneIds', ids, 'distinct scene ids', 'a scene is listed twice') };
  return { ok: true, args: { op, sceneIds: ids as string[] } };
}

function validateSetTagsArgs(args: Record<string, unknown>):
  | { ok: true; args: SetTagsArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'tags') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'tags') };
  }
  const tags = args['tags'];
  if (tags === undefined) return { ok: false, error: fieldMissing('/args/tags', 'tags') };
  if (!Array.isArray(tags)) return { ok: false, error: fieldType('/args/tags', tags, 'array of { bit?, name }') };
  if (tags.length > 32) return { ok: false, error: fieldValue('/args/tags', tags.length, 'at most 32 tags', 'a project has at most 32 tags') };
  const out: SetTagsArgs['tags'] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const p = `/args/tags/${i}`;
    if (!isPlainObject(t)) return { ok: false, error: fieldType(p, t, 'object { bit?, name }') };
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

function validateMoveEntitiesArgs(args: Record<string, unknown>):
  | { ok: true; args: MoveEntitiesArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entityIds' && key !== 'parentId' && key !== 'beforeId') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(key)}`, key, 'entityIds, parentId, beforeId (optional)') };
    }
  }
  const ids = args['entityIds'];
  if (ids === undefined) return { ok: false, error: fieldMissing('/args/entityIds', 'entityIds') };
  if (!Array.isArray(ids)) return { ok: false, error: fieldType('/args/entityIds', ids, `array of 1-${MOVE_ENTITIES_MAX} entity IDs`) };
  if (ids.length < 1 || ids.length > MOVE_ENTITIES_MAX) {
    return { ok: false, error: fieldValue('/args/entityIds', ids.length, `1-${MOVE_ENTITIES_MAX} entity IDs`, `moveEntities moves 1 to ${MOVE_ENTITIES_MAX} entities`) };
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
  return { ok: true, args: out };
}

function validateUndoRedoArgs(op: 'undo' | 'redo', args: Record<string, unknown>):
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

// ---- entry points ------------------------------------------------------------------

/**
 * Envelope-only pass (commands.md §3): op/projectId/expectedRevision/
 * requestId/origin and `args`-is-an-object. Failures are `invalid_request`.
 * In `applyMutation` this runs BEFORE the revision check: a malformed
 * envelope is `invalid_request` even when stale, and the revision check
 * needs a parseable `expectedRevision`. Total: never throws.
 */
export function validateRequestEnvelope(
  request: unknown,
): { ok: false; error: CommandError } | EnvelopeOk {
  if (!isPlainObject(request)) {
    return {
      ok: false,
      error: invalidRequest(
        '',
        jsonType(request),
        'mutation request object { op, projectId, expectedRevision, requestId, origin?, args }',
        'request must be a JSON object',
      ),
    };
  }
  return validateEnvelope(request);
}

/** Per-op validated `args`, discriminated by `op`. */
export type ValidatedOpArgs =
  | { op: 'createEntity'; args: CreateEntityArgs }
  | { op: 'setTransform'; args: SetTransformArgs }
  | { op: 'deleteEntity'; args: DeleteEntityArgs }
  | { op: 'undo'; args: EmptyArgs }
  | { op: 'redo'; args: EmptyArgs }
  | { op: 'publishAsset'; args: PublishAssetArgs }
  | { op: 'publishBehavior'; args: PublishBehaviorArgs }
  | { op: 'setBehaviorProperties'; args: SetBehaviorPropertiesArgs }
  | { op: 'setComponent'; args: SetComponentArgs }
  | { op: 'setSettings'; args: SetSettingsArgs }
  | { op: 'acknowledgeBehaviorTrust'; args: AcknowledgeBehaviorTrustArgs }
  | { op: 'createPrefab'; args: CreatePrefabArgs }
  | { op: 'instantiatePrefab'; args: InstantiatePrefabArgs }
  | { op: 'applySurfacePreset'; args: ApplySurfacePresetArgs }
  | { op: 'setGameConfig'; args: SetGameConfigArgs }
  | { op: 'updateEntity'; args: UpdateEntityArgs }
  | { op: 'moveEntities'; args: MoveEntitiesArgs }
  | { op: 'setTags'; args: SetTagsArgs }
  | { op: 'setAssetOptions'; args: SetAssetOptionsArgs }
  | { op: 'pasteEntities'; args: PasteEntitiesArgs }
  | { op: 'setMaterial'; args: { material: MaterialDef } }
  | { op: 'deleteMaterial'; args: { materialId: string } }
  | { op: 'setEnvironment'; args: { environment: EnvironmentConfig } }
  | { op: 'setLighting'; args: { sceneId: string; lighting: LightingBake | null } }
  | { op: 'setAnimator'; args: { controller: AnimatorController } }
  | { op: 'deleteAnimator'; args: { controllerId: string } }
  | { op: 'setInput'; args: { input: InputConfig | null } }
  | { op: 'setFlow'; args: { flow: GameFlow | null } }
  | { op: 'createScene' | 'renameScene' | 'deleteScene' | 'setStartScenes'; args: SceneIndexArgs }
  | { op: 'setGraph'; args: { graph: GraphDocument } }
  | { op: 'deleteGraph'; args: { graphId: string } }
  | { op: 'graphEdit'; args: { owner: { kind: string; id: string }; ops: GraphOp[] } };

export type ArgsValidation =
  | { ok: true; validated: ValidatedOpArgs }
  | { ok: false; error: CommandError };

/**
 * Per-op `args` schema pass (commands.md §3.1): failures are the `field_*`
 * codes. In `applyMutation` this runs AFTER the revision check and the
 * `revision_exhausted` check (commands.md §6.1 step 4: a stale request is
 * reported as stale, not validated). Total: never throws.
 */
export function validateOpArgs(
  op: MutationOp,
  args: Record<string, unknown>,
): ArgsValidation {
  switch (op) {
    case 'createEntity': {
      const r = validateCreateArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'createEntity', args: r.args } };
    }
    case 'setTransform': {
      const r = validateSetTransformArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setTransform', args: r.args } };
    }
    case 'deleteEntity': {
      const r = validateDeleteArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'deleteEntity', args: r.args } };
    }
    case 'updateEntity': {
      const r = validateUpdateEntityArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'updateEntity', args: r.args } };
    }
    case 'createScene':
    case 'renameScene':
    case 'deleteScene':
    case 'setStartScenes': {
      const r = validateSceneIndexArgs(op, args);
      if (!r.ok) return r;
      return { ok: true, validated: { op, args: r.args } };
    }
    case 'setTags': {
      const r = validateSetTagsArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setTags', args: r.args } };
    }
    case 'setMaterial':
    case 'deleteMaterial':
    case 'setEnvironment': {
      const key = op === 'setMaterial' ? 'material' : op === 'deleteMaterial' ? 'materialId' : 'environment';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'deleteMaterial' ? typeof args[key] !== 'string' : !isPlainObject(args[key])) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'deleteMaterial' ? 'string (materialId)' : 'object') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setInput': {
      for (const k of Object.keys(args)) if (k !== 'input') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'input') };
      if (args['input'] === undefined) return { ok: false, error: fieldMissing('/args/input', 'input') };
      if (args['input'] !== null && !isPlainObject(args['input'])) return { ok: false, error: fieldType('/args/input', args['input'], 'object ({ actions }) or null (the defaults)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setFlow': {
      for (const k of Object.keys(args)) if (k !== 'flow') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'flow') };
      if (args['flow'] === undefined) return { ok: false, error: fieldMissing('/args/flow', 'flow') };
      if (args['flow'] !== null && !isPlainObject(args['flow'])) return { ok: false, error: fieldType('/args/flow', args['flow'], 'object ({ levels, lives?, title?, hud?, ui?, texts?, volumes?, score? }) or null (no flow)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setAnimator':
    case 'deleteAnimator': {
      const key = op === 'setAnimator' ? 'controller' : 'controllerId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'deleteAnimator' ? typeof args[key] !== 'string' : !isPlainObject(args[key])) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'deleteAnimator' ? 'string (controllerId)' : 'object (a controller)') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setGraph':
    case 'deleteGraph': {
      const key = op === 'setGraph' ? 'graph' : 'graphId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'deleteGraph' ? typeof args[key] !== 'string' : !isPlainObject(args[key])) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'deleteGraph' ? 'string (graphId)' : 'object ({ graphId, kind, name, graph })') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'graphEdit': {
      for (const k of Object.keys(args)) if (k !== 'owner' && k !== 'ops') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'owner, ops') };
      const owner = args['owner'];
      if (owner === undefined) return { ok: false, error: fieldMissing('/args/owner', 'owner') };
      if (!isPlainObject(owner) || typeof owner['kind'] !== 'string' || typeof owner['id'] !== 'string' || Object.keys(owner).length !== 2) {
        return { ok: false, error: fieldType('/args/owner', owner, 'object { kind, id } (the document that owns the graph)') };
      }
      if (args['ops'] === undefined) return { ok: false, error: fieldMissing('/args/ops', 'ops') };
      const errors: ModelErrorV2[] = [];
      if (!validateGraphOps(args['ops'], '/args/ops', errors)) {
        const e = errors[0]!;
        return { ok: false, error: { ...fieldValue(e.path ?? '/args/ops', e.found, e.expected ?? 'a graph op', e.message), code: e.code === 'field_missing' ? 'field_missing' : e.code === 'field_unexpected' ? 'field_unexpected' : 'field_value' } };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setLighting': {
      for (const k of Object.keys(args)) if (k !== 'sceneId' && k !== 'lighting') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'sceneId, lighting') };
      if (args['sceneId'] === undefined) return { ok: false, error: fieldMissing('/args/sceneId', 'sceneId') };
      if (typeof args['sceneId'] !== 'string') return { ok: false, error: fieldType('/args/sceneId', args['sceneId'], 'string (sceneId)') };
      if (args['lighting'] === undefined) return { ok: false, error: fieldMissing('/args/lighting', 'lighting') };
      if (args['lighting'] !== null && !isPlainObject(args['lighting'])) return { ok: false, error: fieldType('/args/lighting', args['lighting'], 'object (a bake) or null') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'pasteEntities': {
      const r = validatePasteArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'pasteEntities', args: r.args } };
    }
    case 'setAssetOptions': {
      const r = validateSetAssetOptionsArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setAssetOptions', args: r.args } };
    }
    case 'moveEntities': {
      const r = validateMoveEntitiesArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'moveEntities', args: r.args } };
    }
    case 'undo':
    case 'redo': {
      const r = validateUndoRedoArgs(op, args);
      if (!r.ok) return r;
      return { ok: true, validated: { op, args: r.args } };
    }
    case 'publishAsset': {
      const r = validatePublishAssetArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'publishAsset', args: r.args } };
    }
    case 'publishBehavior': {
      const r = validatePublishBehaviorArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'publishBehavior', args: r.args } };
    }
    case 'setBehaviorProperties': {
      const r = validateSetBehaviorPropertiesArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setBehaviorProperties', args: r.args } };
    }
    case 'setComponent': {
      const r = validateSetComponentArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setComponent', args: r.args } };
    }
    case 'setSettings': {
      const r = validateSetSettingsArgs(args, M2_SETTINGS_KEYS);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setSettings', args: r.args } };
    }
    case 'acknowledgeBehaviorTrust': {
      const r = validateAcknowledgeBehaviorTrustArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'acknowledgeBehaviorTrust', args: r.args } };
    }
    case 'createPrefab': {
      const r = validateCreatePrefabArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'createPrefab', args: r.args } };
    }
    case 'instantiatePrefab': {
      const r = validateInstantiatePrefabArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'instantiatePrefab', args: r.args } };
    }
    case 'applySurfacePreset': {
      const r = validateApplySurfacePresetArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'applySurfacePreset', args: r.args } };
    }
    case 'setGameConfig': {
      const r = validateSetGameConfigArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setGameConfig', args: r.args } };
    }
    default: {
      // Unreachable: `op` was validated against the five ops by the
      // envelope pass; keep a safe, contract-shaped fallback.
      return {
        ok: false,
        error: invalidRequest(
          '/op',
          op,
          EXPECT.op,
          'op is not one of the five M1 mutation ops',
        ),
      };
    }
  }
}

/**
 * Validate a raw mutation request (commands.md §3/§3.1) in full: envelope
 * pass, then per-op `args` pass. Envelope-level failures are
 * `invalid_request`; `args`-level failures are `field_*`. The pipeline
 * order (the revision check between the two passes) is owned by
 * `applyMutation`, not by this function. Total: never throws.
 */
export function validateMutationRequest(req: unknown): RequestValidation {
  const envResult = validateRequestEnvelope(req);
  if (!envResult.ok) return envResult;
  const env = envResult.envelope;
  const va = validateOpArgs(env.op, envResult.args);
  if (!va.ok) return va;
  return { ok: true, request: { ...env, args: va.validated.args } };
}

/**
 * Echo helpers for the §5.2 failure payload: `op` (first 32 chars if the
 * raw value is longer), `projectId`, `requestId` (first 64 chars if longer;
 * omitted when not a string) — each present only when parseable.
 */
export function echoField(
  raw: unknown,
  cap: number,
): { present: true; value: string } | { present: false } {
  if (typeof raw !== 'string') return { present: false };
  return { present: true, value: raw.length > cap ? raw.slice(0, cap) : raw };
}
