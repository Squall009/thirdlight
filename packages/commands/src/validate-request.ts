/**
 * Strict mutation-request validation.
 *
 * The input is the transport-parsed request value (`unknown`). Validation
 * is total: any malformed input yields a structured error, never a thrown
 * exception. Strictness mirrors the data contract: unknown fields at any
 * level of the request or of `args` fail (nothing is silently dropped),
 * missing required fields fail with `field_missing`, wrong JSON types with
 * `field_type`, right type / wrong value with `field_value`.
 *
 * Code assignment: envelope-level schema failures
 * (top-level fields: `op`, `projectId`, `expectedRevision`, `requestId`,
 * `origin`, and `args` itself missing or not an object) are
 * `invalid_request`; failures inside `args` are the `field_*` codes, with
 * `path` a JSON Pointer into the request.
 *
 * Two passes, orchestrated by `applyMutation` (pipeline step 4 —
 * revision checking precedes argument validation): the ENVELOPE pass
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
 * scene (pipeline step 5) and surface as `result-scene`
 * details — exactly the pinned behavior of the
 * `scenarios/04-invalid-no-partial` quaternion_invalid case. The model
 * stays the single authority for document value rules.
 */

import {
  validateGraphOps,
  blockEditsShapeError,
  validateBlockType,
  validateCellFields,
  validateBlockStamp,
  BLOCK_LIMITS,
  type GraphDocument,
  type GraphOp,
  type ModelErrorV2,
  type PlaneLock,
  validatePlaneLock,
} from '@thirdlight/project-model';
import {
  M2_SETTINGS_KEYS,
  type AnimatorController,
  type InputConfig,
  type EnvironmentConfig,
  type SceneEnvironment,
  type LightingBake,
  type MaterialDef,
  type EffectDef,
} from '@thirdlight/project-model';

import {
  ID_RE,
  MAX_REQUEST_BYTES,
  REQUEST_ID_RE,
  fieldType,
  fieldMissing,
  fieldUnexpected,
  fieldValue,
  invalidRequest,
  isPlainObjectStrict,
  isValidName,
  jsonType,
  limitsExceeded,
} from './errors';
import { MUTATION_OPS } from './mutation-ops';
import { validatePasteArgs } from './paste-ops';
import {
  validateAcknowledgeBehaviorTrustArgs,
  validateApplySurfacePresetArgs,
  validatePublishAssetArgs,
  validatePublishBehaviorArgs,
  validateSetBehaviorPropertiesArgs,
  validateSetComponentArgs,
  validateSetSettingsArgs,
} from './validate-content-args';
import { validateImportAssetsArgs, type ImportAssetsArgs } from './import-assets';
import { validateSetAddressArgs, validateSetLabelsArgs, type SetAddressArgs, type SetLabelsArgs } from './loadable-ops';
import { validateImportResourcesArgs, type ImportResourcesArgs } from './import-resources';
import { validatePaintInstancesArgs, type PaintInstancesArgs } from './instance-stroke-ops';
import { validatePaintVerticesArgs, type PaintVerticesArgs } from './vertex-paint-ops';
import { validateColliderFromModelArgs, type ColliderFromModelArgs } from './collider-model-ops';
import { validateEditTerrainArgs, type EditTerrainArgs } from './terrain-ops';
import { validateCreateFolderArgs, validateMoveResourcesArgs, validateRenameFolderArgs, type CreateFolderArgs, type MoveResourcesArgs, type RenameFolderArgs } from './move-ops';
import {
  validateCreatePrefabArgs,
  validateCreatePrefabVariantArgs,
  validateInstantiatePrefabArgs,
  validatePrefabOverrideTargetArgs,
  validateUnpackPrefabArgs,
  validateUpdatePrefabArgs,
} from './validate-prefab-args';
import type { CreatePrefabVariantArgs, PrefabOverrideTargetArgs, UnpackPrefabArgs } from './prefab-link-types';
import type {
  AcknowledgeBehaviorTrustArgs,
  ApplySurfacePresetArgs,
  CommandError,
  CreateEntityArgs,
  CreatePrefabArgs,
  DeleteEntityArgs,
  EmptyArgs,
  InstantiatePrefabArgs,
  UpdatePrefabArgs,
  MutationArgs,
  MutationOp,
  Origin,
  PublishAssetArgs,
  PublishBehaviorArgs,
  SetBehaviorPropertiesArgs,
  SetComponentArgs,
  SetSettingsArgs,
  SetTransformArgs,
  UpdateEntityArgs,
  MoveEntitiesArgs,
  SetTagsArgs,
  SetAssetOptionsArgs,
  PasteEntitiesArgs,
  SceneIndexArgs,
} from './types';
import { escapePointer as pointerSegment, utf8Length } from '@thirdlight/shared';
import {
  validateCreateArgs,
  validateDeleteArgs,
  validateMoveEntitiesArgs,
  validateSceneIndexArgs,
  validateSetAssetOptionsArgs,
  validateSetTagsArgs,
  validateSetTransformArgs,
  validateUndoRedoArgs,
  validateUpdateEntityArgs,
} from './validate-core-args';
export { CREATE_CHILDREN_MAX, CREATE_COMPONENTS, CREATE_MADE_BY_KIND } from './validate-core-args';

const TOP_FIELDS = [
  'op',
  'projectId',
  'expectedRevision',
  'requestId',
  'origin',
  'args',
] as const;

/** The one id key of each op whose only argument names the record it removes. */
const SINGLE_ID_KEY = { deleteAsset: 'assetId', deletePrefab: 'prefabId', deleteBehavior: 'behaviorId', revokeBehaviorTrust: 'sourceDigest' } as const;

const ORIGIN_KINDS = ['browser', 'mcp', 'admin'] as const;

/** The `expected` text of an unknown op: the list itself, so a new op is named without a second copy. */
export const MUTATION_OPS_EXPECTED = `one of: ${MUTATION_OPS.join(', ')}`;

/** Expected-text constants (the `expected` strings are log-safe, stable). */
const EXPECT = {
  op: MUTATION_OPS_EXPECTED,
  projectId: 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}',
  expectedRevision: 'integer, 0 <= v <= 2^53-1',
  requestId: 'req- + 32 lowercase hex chars: ^req-[0-9a-f]{32}$',
  origin: 'object { kind: browser | mcp | admin, clientId: string 1-128, no control chars }',
  args: 'object (op-specific, strict)',
} as const;

export const TOP_FIELDS_EXPECTED = 'known fields: op, projectId, expectedRevision, requestId, origin (optional), args';

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
 * Byte length of the canonical request form (keys sorted, no
 * whitespace, `JSON.stringify` number semantics) without recursion, so a
 * deeply nested malformed request cannot exhaust the stack: the public entry
 * points are total.
 */
export function canonicalRequestByteLength(request: unknown): number {
  let bytes = 0;
  const stack: ({ v: unknown } | { text: string })[] = [{ v: request }];
  while (stack.length > 0) {
    const frame = stack.pop() as { v: unknown } | { text: string };
    if ('text' in frame) {
      bytes += utf8Length(frame.text);
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
      bytes += utf8Length(JSON.stringify(val));
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

/**
 * The request's canonical bytes must be ≤ 65 536
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
  // Strict top-level fields first (nothing silently dropped). Unknown
  // TOP-level fields are an envelope-level schema failure ⇒
  // `invalid_request`.
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
  if (typeof req['op'] !== 'string' || !MUTATION_OPS.includes(req['op'] as MutationOp)) {
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
    if (!isPlainObjectStrict(o)) {
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
  if (!isPlainObjectStrict(req['args'])) {
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

// ---- entry points ------------------------------------------------------------------

/**
 * Envelope-only pass: op/projectId/expectedRevision/
 * requestId/origin and `args`-is-an-object. Failures are `invalid_request`.
 * In `applyMutation` this runs BEFORE the revision check: a malformed
 * envelope is `invalid_request` even when stale, and the revision check
 * needs a parseable `expectedRevision`. Total: never throws.
 */
export function validateRequestEnvelope(
  request: unknown,
): { ok: false; error: CommandError } | EnvelopeOk {
  if (!isPlainObjectStrict(request)) {
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
  | { op: 'updateEntity'; args: UpdateEntityArgs }
  | { op: 'moveEntities'; args: MoveEntitiesArgs }
  | { op: 'setTags'; args: SetTagsArgs }
  | { op: 'setAssetOptions'; args: SetAssetOptionsArgs }
  | { op: 'pasteEntities'; args: PasteEntitiesArgs }
  | { op: 'setMaterial'; args: { material: MaterialDef } }
  | { op: 'deleteMaterial'; args: { materialId: string } }
  | { op: 'setEnvironment'; args: { environment: EnvironmentConfig | SceneEnvironment; sceneId?: string } }
  | { op: 'setScenePlane'; args: { sceneId: string; plane: PlaneLock | null } }
  | { op: 'setLighting'; args: { sceneId: string; lighting: LightingBake | null } }
  | { op: 'setAnimator'; args: { controller: AnimatorController } }
  | { op: 'deleteAnimator'; args: { controllerId: string } }
  | { op: 'setInput'; args: { input: InputConfig | null } }
  | { op: 'setCollisionLayers'; args: { layers: string[] } }
  | { op: 'setLightLayers'; args: { layers: string[] } }
  | { op: 'setSaveSchema'; args: { schema: import('@thirdlight/project-model').SaveSchema | null } }
  | { op: 'createScene' | 'renameScene' | 'deleteScene' | 'setStartScenes'; args: SceneIndexArgs }
  | { op: 'setGraph'; args: { graph: GraphDocument } }
  | { op: 'deleteGraph'; args: { graphId: string } }
  | { op: 'graphEdit'; args: { owner: { kind: string; id: string }; ops: GraphOp[] } }
  | { op: 'setEffect'; args: { effect: EffectDef } }
  | { op: 'deleteEffect'; args: { effectId: string } }
  | { op: 'renameEffect'; args: { effectId: string; name: string } }
  | { op: 'setScriptLibrary'; args: import('@thirdlight/project-model').ScriptLibraryPatch }
  | { op: 'deleteScriptLibrary'; args: { libraryId: string } }
  | { op: 'commitScriptLibraryStage'; args: { stageId: string } }
  | { op: 'editBlocks'; args: { entityId: string; edits: import('@thirdlight/project-model').BlockEdit[] } }
  | { op: 'setBlockType'; args: { block: import('@thirdlight/project-model').BlockType } }
  | { op: 'deleteBlockType'; args: { blockId: string } }
  | { op: 'setCellFields'; args: { fields: import('@thirdlight/project-model').CellField[] } }
  | { op: 'setBlockStamp'; args: { stamp?: import('@thirdlight/project-model').BlockStamp; stampId?: string; name?: string; entityId?: string; box?: number[] } }
  | { op: 'deleteBlockStamp'; args: { stampId: string } }
  | { op: 'setKit'; args: { kit: import('@thirdlight/project-model').KitDef } }
  | { op: 'deleteKit'; args: { kitId: string } }
  | { op: 'setUiDocument'; args: { document: import('@thirdlight/project-model').UiDocument } }
  | { op: 'deleteUiDocument'; args: { uiDocumentId: string } }
  | { op: 'setUiTheme'; args: { theme: import('@thirdlight/project-model').UiTheme } }
  | { op: 'deleteUiTheme'; args: { uiThemeId: string } }
  | { op: 'setDialogue'; args: { dialogue: { dialogueId: string; name: string; graph?: import('@thirdlight/project-model').GraphData } } }
  | { op: 'deleteDialogue'; args: { dialogueId: string } }
  | { op: 'setSpeaker'; args: { speaker: import('@thirdlight/project-model').DialogueSpeaker } }
  | { op: 'deleteSpeaker'; args: { speakerId: string } }
  | { op: 'setDialogueSettings'; args: { settings: import('@thirdlight/project-model').DialogueSettings | null } }
  | { op: 'setModes'; args: { modes: import('@thirdlight/project-model').GameMode[] } }
  | { op: 'setBehaviorGroups'; args: { groups: string[] } }
  | { op: 'setEventCues'; args: { cues: import('@thirdlight/project-model').EventCue[] } }
  | { op: 'setShell'; args: { shell: import('@thirdlight/project-model').GameShell | null } }
  | { op: 'deleteUiTheme'; args: { uiThemeId: string } }
  | { op: 'setTimeline'; args: { timeline: import('@thirdlight/project-model').TimelineAsset } }
  | { op: 'deleteTimeline'; args: { timelineId: string } }
  | { op: 'deleteAsset'; args: { assetId: string } }
  | { op: 'importAssets'; args: ImportAssetsArgs }
  | { op: 'importResources'; args: ImportResourcesArgs }
  | { op: 'deletePrefab'; args: { prefabId: string } }
  | { op: 'updatePrefab'; args: UpdatePrefabArgs }
  | { op: 'revertPrefabOverrides'; args: PrefabOverrideTargetArgs }
  | { op: 'applyPrefabOverrides'; args: PrefabOverrideTargetArgs }
  | { op: 'unpackPrefab'; args: UnpackPrefabArgs }
  | { op: 'createPrefabVariant'; args: CreatePrefabVariantArgs }
  | { op: 'deleteBehavior'; args: { behaviorId: string } }
  | { op: 'revokeBehaviorTrust'; args: { sourceDigest: string } }
  | { op: 'createEntities'; args: { entities: (CreateEntityArgs & { ref?: string })[] } }
  | { op: 'setLabels'; args: SetLabelsArgs }
  | { op: 'setAddress'; args: SetAddressArgs }
  | { op: 'moveResources'; args: MoveResourcesArgs }
  | { op: 'renameFolder'; args: RenameFolderArgs }
  | { op: 'createFolder'; args: CreateFolderArgs }
  | { op: 'paintInstances'; args: PaintInstancesArgs }
  | { op: 'paintVertices'; args: PaintVerticesArgs }
  | { op: 'colliderFromModel'; args: ColliderFromModelArgs }
  | { op: 'editTerrain'; args: EditTerrainArgs };

/** The argument shapes of the block-layer ops (null: valid). */
function blockArgsError(op: string, args: Record<string, unknown>): CommandError | null {
  const allowed: Record<string, string[]> = {
    editBlocks: ['entityId', 'edits'],
    setBlockType: ['block'],
    deleteBlockType: ['blockId'],
    setCellFields: ['fields'],
    setBlockStamp: ['stamp', 'stampId', 'name', 'entityId', 'box'],
    deleteBlockStamp: ['stampId'],
  };
  const keys = allowed[op]!;
  for (const k of Object.keys(args)) if (!keys.includes(k)) return fieldUnexpected(`/args/${pointerSegment(k)}`, k, keys.join(', '));
  const id = (k: string): CommandError | null => {
    if (args[k] === undefined) return fieldMissing(`/args/${k}`, k);
    if (typeof args[k] !== 'string' || !ID_RE.test(args[k] as string)) return fieldType(`/args/${k}`, args[k], `string (an id: [a-z0-9][a-z0-9_-]{0,63})`);
    return null;
  };
  const modelErr = (errors: ModelErrorV2[], prefix: string): CommandError | null => {
    const e = errors[0];
    if (e === undefined) return null;
    return { ...fieldValue(`${prefix}${e.path ?? ''}`, e.found, e.expected ?? 'a valid value', e.message), code: e.code === 'field_missing' ? 'field_missing' : e.code === 'field_unexpected' ? 'field_unexpected' : e.code === 'field_type' ? 'field_type' : 'field_value' } as CommandError;
  };
  switch (op) {
    case 'editBlocks': {
      const r = id('entityId');
      if (r !== null) return r;
      if (args['edits'] === undefined) return fieldMissing('/args/edits', 'edits');
      const shape = blockEditsShapeError(args['edits']);
      if (shape !== null) return { ...fieldValue(shape.path, undefined, 'a valid block edit', shape.message), code: shape.code } as CommandError;
      return null;
    }
    case 'setBlockType': {
      if (args['block'] === undefined) return fieldMissing('/args/block', 'block');
      const errors: ModelErrorV2[] = [];
      validateBlockType(args['block'], '', errors);
      return modelErr(errors, '/args/block');
    }
    case 'deleteBlockType':
      return id('blockId');
    case 'setCellFields': {
      if (args['fields'] === undefined) return fieldMissing('/args/fields', 'fields');
      const errors: ModelErrorV2[] = [];
      validateCellFields(args['fields'], '', errors);
      return modelErr(errors, '/args/fields');
    }
    case 'setBlockStamp': {
      if (args['stamp'] !== undefined) {
        for (const k of ['stampId', 'name', 'entityId', 'box']) if (args[k] !== undefined) return fieldUnexpected(`/args/${k}`, k, 'stamp alone (or stampId, name, entityId, box without stamp)');
        const errors: ModelErrorV2[] = [];
        validateBlockStamp(args['stamp'], '', errors);
        return modelErr(errors, '/args/stamp');
      }
      for (const k of ['stampId', 'entityId']) {
        const r = id(k);
        if (r !== null) return r;
      }
      if (typeof args['name'] !== 'string' || args['name'].length < 1 || args['name'].length > 128) return args['name'] === undefined ? fieldMissing('/args/name', 'name') : fieldType('/args/name', args['name'], 'string (1-128 characters)');
      const box = args['box'];
      if (box === undefined) return fieldMissing('/args/box', 'box');
      if (!Array.isArray(box) || box.length !== 6 || !box.every((v) => Number.isSafeInteger(v)) || !((box[3] as number) > (box[0] as number) && (box[4] as number) > (box[1] as number) && (box[5] as number) > (box[2] as number))) return fieldType('/args/box', box, '[x0, y0, z0, x1, y1, z1] integers with max > min');
      if ((box[3] as number) - (box[0] as number) > BLOCK_LIMITS.stampSize || (box[4] as number) - (box[1] as number) > BLOCK_LIMITS.stampSize || (box[5] as number) - (box[2] as number) > BLOCK_LIMITS.stampSize) return fieldValue('/args/box', box, `at most ${BLOCK_LIMITS.stampSize} cells per axis`, 'a stamp spans at most 64 cells per axis');
      return null;
    }
    case 'deleteBlockStamp':
      return id('stampId');
  }
  return null;
}

export type ArgsValidation =
  | { ok: true; validated: ValidatedOpArgs }
  | { ok: false; error: CommandError };

/** The prefab ops' args, one validator each (`validate-prefab-args.ts`). */
function validatePrefabOpArgs(op: 'createPrefab' | 'updatePrefab' | 'instantiatePrefab' | 'revertPrefabOverrides' | 'applyPrefabOverrides' | 'unpackPrefab' | 'createPrefabVariant', args: Record<string, unknown>): { ok: true; validated: ValidatedOpArgs } | { ok: false; error: CommandError } {
  const r =
    op === 'createPrefab' ? validateCreatePrefabArgs(args)
      : op === 'updatePrefab' ? validateUpdatePrefabArgs(args)
        : op === 'instantiatePrefab' ? validateInstantiatePrefabArgs(args)
          : op === 'unpackPrefab' ? validateUnpackPrefabArgs(args)
            : op === 'createPrefabVariant' ? validateCreatePrefabVariantArgs(args)
              : validatePrefabOverrideTargetArgs(args);
  if (!r.ok) return r;
  return { ok: true, validated: { op, args: r.args } as ValidatedOpArgs };
}

/** One scene's own field: `setLighting {sceneId, lighting}` (a bake or null) and `setScenePlane {sceneId, plane}` (a plane or null). */
function validateSceneFieldArgs(op: 'setLighting' | 'setScenePlane', args: Record<string, unknown>): ArgsValidation {
  const key = op === 'setLighting' ? 'lighting' : 'plane';
  for (const k of Object.keys(args)) if (k !== 'sceneId' && k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, `sceneId, ${key}`) };
  if (args['sceneId'] === undefined) return { ok: false, error: fieldMissing('/args/sceneId', 'sceneId') };
  if (typeof args['sceneId'] !== 'string') return { ok: false, error: fieldType('/args/sceneId', args['sceneId'], 'string (sceneId)') };
  if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
  if (op === 'setLighting') {
    if (args['lighting'] !== null && !isPlainObjectStrict(args['lighting'])) return { ok: false, error: fieldType('/args/lighting', args['lighting'], 'object (a bake) or null') };
  } else if (args['plane'] !== null) {
    const errors: ModelErrorV2[] = [];
    validatePlaneLock(args['plane'], '/args/plane', errors);
    const e = errors[0];
    if (e !== undefined) return { ok: false, error: fieldValue(e.path ?? '/args/plane', args['plane'], "{ axis: 'x' | 'z', origin } or null", e.message) };
  }
  return { ok: true, validated: { op, args } as ValidatedOpArgs };
}

/**
 * Per-op `args` schema pass: failures are the `field_*`
 * codes. In `applyMutation` this runs AFTER the revision check and the
 * `revision_exhausted` check (a stale request is reported as stale, not
 * validated). Total: never throws.
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
    case 'createEntities': {
      // createEntities {entities: [createEntity args + ref?]} (one transaction).
      for (const k of Object.keys(args)) if (k !== 'entities') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'entities') };
      const list = args['entities'];
      if (list === undefined) return { ok: false, error: fieldMissing('/args/entities', 'entities') };
      if (!Array.isArray(list)) return { ok: false, error: fieldType('/args/entities', list, 'array of createEntity args') };
      if (list.length < 1) {
        return { ok: false, error: fieldValue('/args/entities', list.length, 'at least 1 item', 'createEntities creates at least one entity') };
      }
      const refs = new Set<string>();
      const entities: (CreateEntityArgs & { ref?: string })[] = [];
      for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        const path = `/args/entities/${i}`;
        if (!isPlainObjectStrict(item)) return { ok: false, error: fieldType(path, item, 'object (createEntity args)') };
        const { ref, ...rest } = item;
        if (ref !== undefined) {
          if (typeof ref !== 'string' || !isValidName(ref)) return { ok: false, error: fieldValue(`${path}/ref`, ref, 'string, 1-128 chars, no control characters', 'ref names this item for a later parentId') };
          if (refs.has(ref)) return { ok: false, error: fieldValue(`${path}/ref`, ref, 'a ref unique in the batch', 'two items share a ref') };
        }
        const r = validateCreateArgs(rest);
        if (!r.ok) return { ok: false, error: { ...r.error, path: `${path}${(r.error.path ?? '').replace(/^\/args/, '')}` } as CommandError };
        if (typeof ref === 'string') refs.add(ref);
        entities.push(ref !== undefined ? { ...r.args, ref: ref as string } : r.args);
      }
      return { ok: true, validated: { op: 'createEntities', args: { entities } } };
    }
    case 'setLabels': {
      const r = validateSetLabelsArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setLabels', args: r.args } };
    }
    case 'setAddress': {
      const r = validateSetAddressArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'setAddress', args: r.args } };
    }
    case 'moveResources': {
      const r = validateMoveResourcesArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'moveResources', args: r.args } };
    }
    case 'renameFolder': {
      const r = validateRenameFolderArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'renameFolder', args: r.args } };
    }
    case 'createFolder': {
      const r = validateCreateFolderArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'createFolder', args: r.args } };
    }
    case 'paintInstances': {
      const r = validatePaintInstancesArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'paintInstances', args: r.args } };
    }
    case 'paintVertices': {
      const r = validatePaintVerticesArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'paintVertices', args: r.args } };
    }
    case 'colliderFromModel': {
      const r = validateColliderFromModelArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'colliderFromModel', args: r.args } };
    }
    case 'editTerrain': {
      const r = validateEditTerrainArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'editTerrain', args: r.args } };
    }
    case 'importAssets': {
      const r = validateImportAssetsArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'importAssets', args: r.args } };
    }
    case 'importResources': {
      const r = validateImportResourcesArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'importResources', args: r.args } };
    }
    case 'deleteAsset':
    case 'deletePrefab':
    case 'deleteBehavior':
    case 'revokeBehaviorTrust': {
      // deleteAsset {assetId}; deletePrefab {prefabId}; deleteBehavior {behaviorId}; revokeBehaviorTrust {sourceDigest}.
      const key = SINGLE_ID_KEY[op];
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (typeof args[key] !== 'string') return { ok: false, error: fieldType(`/args/${key}`, args[key], `string (${key})`) };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
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
      // setEnvironment {sceneId, environment}: that scene's look; without sceneId the project's quality and presets.
      for (const k of Object.keys(args)) if (k !== key && !(op === 'setEnvironment' && k === 'sceneId') && !(op === 'setMaterial' && k === 'assign')) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, op === 'setEnvironment' ? 'environment, sceneId' : op === 'setMaterial' ? 'material, assign' : key) };
      // setMaterial {material, assign: {entityId, slots?}}: the material also goes on that object (one undo step).
      if (op === 'setMaterial' && args['assign'] !== undefined) {
        const assign = args['assign'];
        if (!isPlainObjectStrict(assign)) return { ok: false, error: fieldType('/args/assign', assign, 'object ({ entityId, slots? })') };
        for (const k of Object.keys(assign)) if (k !== 'entityId' && k !== 'slots') return { ok: false, error: fieldUnexpected(`/args/assign/${pointerSegment(k)}`, k, 'entityId, slots') };
        if (typeof assign['entityId'] !== 'string') return { ok: false, error: fieldType('/args/assign/entityId', assign['entityId'], 'string (an object id)') };
        const slots = assign['slots'];
        if (slots !== undefined && (!Array.isArray(slots) || !slots.every((x) => typeof x === 'string' && x !== '' && x !== '*'))) return { ok: false, error: fieldType('/args/assign/slots', slots, 'array of named material slots (not "*")') };
        // Slot names are the object's own material names (a model's source materials, a wall's profile slots): an open set, so a name the
        // object does not draw with is stored like any mapping entry; a name given twice says the caller meant something else.
        if (slots !== undefined) {
          const twice = (slots as string[]).find((x, i) => (slots as string[]).indexOf(x) !== i);
          if (twice !== undefined) return { ok: false, error: fieldValue('/args/assign/slots', twice, 'each named slot once', `slot "${twice}" is named twice`) };
        }
      }
      if (op === 'setEnvironment' && args['sceneId'] !== undefined && typeof args['sceneId'] !== 'string') return { ok: false, error: fieldType('/args/sceneId', args['sceneId'], 'string (scene id)') };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'deleteMaterial' ? typeof args[key] !== 'string' : !isPlainObjectStrict(args[key])) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'deleteMaterial' ? 'string (materialId)' : 'object') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setInput': {
      for (const k of Object.keys(args)) if (k !== 'input') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'input') };
      if (args['input'] === undefined) return { ok: false, error: fieldMissing('/args/input', 'input') };
      if (args['input'] !== null && !isPlainObjectStrict(args['input'])) return { ok: false, error: fieldType('/args/input', args['input'], 'object ({ actions }) or null (the defaults)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setModes':
    case 'setBehaviorGroups':
    case 'setEventCues': {
      // setModes {modes: [...]}; setBehaviorGroups {groups: [...]} (whole lists; [] = none).
      // setEventCues {cues: [...]} (the whole table; [] = none).
      const key = op === 'setModes' ? 'modes' : op === 'setEventCues' ? 'cues' : 'groups';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (!Array.isArray(args[key])) return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'setModes' ? 'array of game modes ([] = none)' : op === 'setEventCues' ? 'array of event cues ([] = none)' : 'array of group names ([] = none)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setCollisionLayers': {
      for (const k of Object.keys(args)) if (k !== 'layers') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'layers') };
      if (args['layers'] === undefined) return { ok: false, error: fieldMissing('/args/layers', 'layers') };
      if (!Array.isArray(args['layers'])) return { ok: false, error: fieldType('/args/layers', args['layers'], 'array of layer names ([] = only "default")') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setLightLayers': {
      for (const k of Object.keys(args)) if (k !== 'layers') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'layers') };
      if (args['layers'] === undefined) return { ok: false, error: fieldMissing('/args/layers', 'layers') };
      if (!Array.isArray(args['layers'])) return { ok: false, error: fieldType('/args/layers', args['layers'], 'array of layer names by number ([] = none named)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setSaveSchema': {
      for (const k of Object.keys(args)) if (k !== 'schema') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'schema') };
      if (args['schema'] === undefined) return { ok: false, error: fieldMissing('/args/schema', 'schema') };
      if (args['schema'] !== null && !isPlainObjectStrict(args['schema'])) return { ok: false, error: fieldType('/args/schema', args['schema'], 'object ({ version, slots, migrations?, sections?, thumbnail?, settings? }) or null (no project saves)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setShell': {
      // setShell {shell} (the whole shell; null = none).
      for (const k of Object.keys(args)) if (k !== 'shell') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'shell') };
      if (args['shell'] === undefined) return { ok: false, error: fieldMissing('/args/shell', 'shell') };
      if (args['shell'] !== null && !isPlainObjectStrict(args['shell'])) return { ok: false, error: fieldType('/args/shell', args['shell'], 'object ({ screens?, hud?, scenes?, pause?, status? }) or null (no shell)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setAnimator':
    case 'deleteAnimator': {
      const key = op === 'setAnimator' ? 'controller' : 'controllerId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'deleteAnimator' ? typeof args[key] !== 'string' : !isPlainObjectStrict(args[key])) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'deleteAnimator' ? 'string (controllerId)' : 'object (a controller)') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setGraph':
    case 'deleteGraph': {
      const key = op === 'setGraph' ? 'graph' : 'graphId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'deleteGraph' ? typeof args[key] !== 'string' : !isPlainObjectStrict(args[key])) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'deleteGraph' ? 'string (graphId)' : 'object ({ graphId, kind, name, graph })') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setEffect':
    case 'deleteEffect':
    case 'renameEffect': {
      const keys = op === 'setEffect' ? ['effect'] : op === 'deleteEffect' ? ['effectId'] : ['effectId', 'name'];
      for (const k of Object.keys(args)) if (!keys.includes(k)) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, keys.join(', ')) };
      for (const k of keys) {
        if (args[k] === undefined) return { ok: false, error: fieldMissing(`/args/${k}`, k) };
        if (k === 'effect' ? !isPlainObjectStrict(args[k]) : typeof args[k] !== 'string') {
          return { ok: false, error: fieldType(`/args/${k}`, args[k], k === 'effect' ? 'object ({ effectId, name, duration, loop, seed, bounds, parameters?, systems })' : `string (${k})`) };
        }
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setKit':
    case 'deleteKit': {
      // setKit {kit}; deleteKit {kitId} (the kit's values are the model's; here the shapes).
      const key = op === 'setKit' ? 'kit' : 'kitId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'setKit' ? !isPlainObjectStrict(args[key]) : typeof args[key] !== 'string') {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'setKit' ? 'object ({ kitId, name, trimMaterial?, presets?, blockTypes?, pieces? })' : 'string (kitId)') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'editBlocks':
    case 'setBlockType':
    case 'deleteBlockType':
    case 'setCellFields':
    case 'setBlockStamp':
    case 'deleteBlockStamp': {
      // Block layers (the values are the model's; here the shapes).
      const r = blockArgsError(op, args);
      if (r !== null) return { ok: false, error: r };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setUiDocument':
    case 'deleteUiDocument':
    case 'setUiTheme':
    case 'deleteUiTheme': {
      // setUiDocument {document}; deleteUiDocument {uiDocumentId}; setUiTheme {theme}; deleteUiTheme {uiThemeId}.
      const key = op === 'setUiDocument' ? 'document' : op === 'deleteUiDocument' ? 'uiDocumentId' : op === 'setUiTheme' ? 'theme' : 'uiThemeId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      const isObjectArg = op === 'setUiDocument' || op === 'setUiTheme';
      if (isObjectArg ? !isPlainObjectStrict(args[key]) : typeof args[key] !== 'string') {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'setUiDocument' ? 'object ({ uiDocumentId, name, root, … })' : op === 'setUiTheme' ? 'object ({ uiThemeId, name, styles, icons? })' : `string (${key})`) };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setDialogue':
    case 'deleteDialogue':
    case 'setSpeaker':
    case 'deleteSpeaker':
    case 'setDialogueSettings': {
      // setDialogue {dialogue}; deleteDialogue {dialogueId}; setSpeaker {speaker}; deleteSpeaker {speakerId}; setDialogueSettings {settings | null}.
      const key = op === 'setDialogue' ? 'dialogue' : op === 'deleteDialogue' ? 'dialogueId' : op === 'setSpeaker' ? 'speaker' : op === 'deleteSpeaker' ? 'speakerId' : 'settings';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      const isObjectArg = op === 'setDialogue' || op === 'setSpeaker' || op === 'setDialogueSettings';
      const okShape = op === 'setDialogueSettings' ? args[key] === null || isPlainObjectStrict(args[key]) : isObjectArg ? isPlainObjectStrict(args[key]) : typeof args[key] === 'string';
      if (!okShape) {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'setDialogue' ? 'object ({ dialogueId, name, graph? })' : op === 'setSpeaker' ? 'object ({ speakerId, name, color?, portraits?, … })' : op === 'setDialogueSettings' ? 'object or null' : `string (${key})`) };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setTimeline':
    case 'deleteTimeline': {
      // setTimeline {timeline}; deleteTimeline {timelineId}.
      const key = op === 'setTimeline' ? 'timeline' : 'timelineId';
      for (const k of Object.keys(args)) if (k !== key) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, key) };
      if (args[key] === undefined) return { ok: false, error: fieldMissing(`/args/${key}`, key) };
      if (op === 'setTimeline' ? !isPlainObjectStrict(args[key]) : typeof args[key] !== 'string') {
        return { ok: false, error: fieldType(`/args/${key}`, args[key], op === 'setTimeline' ? 'object ({ timelineId, name, duration, tracks, … })' : 'string (timelineId)') };
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'setScriptLibrary':
    case 'deleteScriptLibrary': {
      // setScriptLibrary {libraryId, name?, files?: [{path, text: string|null}]}; deleteScriptLibrary {libraryId}.
      const keys = op === 'setScriptLibrary' ? ['libraryId', 'name', 'files'] : ['libraryId'];
      for (const k of Object.keys(args)) if (!keys.includes(k)) return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, keys.join(', ')) };
      if (args['libraryId'] === undefined) return { ok: false, error: fieldMissing('/args/libraryId', 'libraryId') };
      if (typeof args['libraryId'] !== 'string' || !ID_RE.test(args['libraryId'])) return { ok: false, error: fieldType('/args/libraryId', args['libraryId'], 'string (a library id: [a-z0-9][a-z0-9_-]{0,63})') };
      if (op === 'setScriptLibrary') {
        if (args['name'] === undefined && args['files'] === undefined) return { ok: false, error: fieldMissing('/args/files', 'files (or name)') };
        if (args['name'] !== undefined && typeof args['name'] !== 'string') return { ok: false, error: fieldType('/args/name', args['name'], 'string (1-64 characters)') };
        const files = args['files'];
        if (files !== undefined) {
          if (!Array.isArray(files) || files.length > 32) return { ok: false, error: fieldType('/args/files', files, 'array of up to 32 { path, text: string | null }') };
          for (let i = 0; i < files.length; i++) {
            const f = files[i] as unknown;
            if (!isPlainObjectStrict(f) || typeof f['path'] !== 'string' || !(typeof f['text'] === 'string' || f['text'] === null) || Object.keys(f).some((k) => k !== 'path' && k !== 'text')) {
              return { ok: false, error: fieldType(`/args/files/${i}`, f, '{ path, text: string | null } (null removes the file)') };
            }
          }
        }
      }
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'commitScriptLibraryStage': {
      // commitScriptLibraryStage {stageId} (the staged libraries are host facts, never args).
      for (const k of Object.keys(args)) if (k !== 'stageId') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'stageId') };
      if (args['stageId'] === undefined) return { ok: false, error: fieldMissing('/args/stageId', 'stageId') };
      if (typeof args['stageId'] !== 'string' || !/^lstage-[0-9]{1,12}$/.test(args['stageId'])) return { ok: false, error: fieldType('/args/stageId', args['stageId'], 'string (a stage id from the library stage route: lstage-<n>)') };
      return { ok: true, validated: { op, args } as ValidatedOpArgs };
    }
    case 'graphEdit': {
      for (const k of Object.keys(args)) if (k !== 'owner' && k !== 'ops') return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'owner, ops') };
      const owner = args['owner'];
      if (owner === undefined) return { ok: false, error: fieldMissing('/args/owner', 'owner') };
      if (!isPlainObjectStrict(owner) || typeof owner['kind'] !== 'string' || typeof owner['id'] !== 'string' || Object.keys(owner).length !== 2) {
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
    case 'setLighting':
    case 'setScenePlane':
      return validateSceneFieldArgs(op, args);
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
    case 'createPrefab':
    case 'updatePrefab':
    case 'instantiatePrefab':
    case 'revertPrefabOverrides':
    case 'applyPrefabOverrides':
    case 'unpackPrefab':
    case 'createPrefabVariant':
      return validatePrefabOpArgs(op, args);
    case 'applySurfacePreset': {
      const r = validateApplySurfacePresetArgs(args);
      if (!r.ok) return r;
      return { ok: true, validated: { op: 'applySurfacePreset', args: r.args } };
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
 * Validate a raw mutation request in full: envelope
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
 * Echo helpers for the failure payload: `op` (first 32 chars if the
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
