/**
 * `applyMutation` — the pure core of the mutation pipeline (steps 4–6).
 *
 * The workspace service runs the FULL pipeline: project
 * resolution (1), deduplication (2), pause check (3), then THIS function
 * (4 revision check → 5 validation + pure application → 6 no-change
 * check), then durability write (7), publish (8), and acknowledge (9).
 * This function owns nothing durable: it takes the current in-memory
 * state + the raw request value and returns either the success payload
 *  with the NEW state, or the failure payload with the input
 * state left untouched. No filesystem, transport, digests, or records.
 *
 * The content/property ops run the SAME pipeline and the same history
 * engine — only the state they mutate (the envelope's `content` block as
 * well as the scene) differs.
 */

import { applyMoveEntitiesScene } from './move-scene-ops';
import type { Manifest } from '@thirdlight/project-model';

import {
  MAX_REVISION,
  revisionConflict,
  revisionExhausted,
  type CommandError,
} from './errors';
import {
  applyAcknowledgeBehaviorTrust,
  applyPublishAsset,
  applyPublishBehavior,
  applySetBehaviorProperties,
  applySetComponent,
  applySetSettings,
  type OpInput,
} from './content-ops';
import { createHistory, executeRedo, executeUndo, recordForwardEdit } from './history';
import { withFootprintChunks, writeFootprints } from './footprint-ops';
import {
  applyCreateEntities,
  applyCreateEntity,
  applyDeleteEntity,
  applyMoveEntities,
  applySetTransform,
  applyUpdateEntity,
  type OpSuccess,
} from './ops';
import { applyCreatePrefab, applyInstantiatePrefab } from './prefab-ops';
import { applyApplySurfacePreset } from './v3-ops';
import { applySetTags } from './tag-ops';
import { applySetAssetOptions } from './asset-options-ops';
import { applyPasteEntities } from './paste-ops';
import { applySetCollisionLayers, applySetLightLayers } from './layer-ops';
import { applySetSaveSchema } from './save-schema-ops';
import { applyDeleteAnimator, applyDeleteMaterial, applySetAnimator, applySetEnvironment, applySetInput, applySetLighting, applySetMaterial } from './material-ops';
import type { AnimatorController, EffectDef, EnvironmentConfig, InputConfig, LightingBake, MaterialDef, SceneEnvironment } from '@thirdlight/project-model';
import { applySceneIndexOp } from './scene-ops';
import { applyDeleteGraph, applyGraphEdit, applySetGraph } from './graph-ops';
import { applyDeleteEffect, applyRenameEffect, applySetEffect } from './effect-ops';
import { applyCommitScriptLibraryStage, applyDeleteScriptLibrary, applySetScriptLibrary } from './script-library-ops';
import { applyDeleteBlockStamp, applyDeleteBlockType, applyEditBlocks, applySetBlockStamp, applySetBlockType, applySetCellFields } from './block-ops';
import type { BlockEdit, BlockType, CellField } from '@thirdlight/project-model';
import { applyDeleteUi, applySetUiDocument, applySetUiTheme } from './ui-ops';
import { applyDeleteDialogueValue, applySetDialogue, applySetDialogueSettings, applySetSpeaker } from './dialogue-ops';
import { applySetBehaviorGroups, applySetEventCues, applySetModes, applySetShell } from './mode-ops';
import { applyDeleteTimeline, applySetTimeline } from './timeline-ops';
import { applyDeleteAsset, applyDeletePrefab } from './delete-content-ops';
import { applyImportAssets } from './import-assets';
import { applySetAddress, applySetLabels } from './loadable-ops';
import { applyImportResources } from './import-resources';
import { applyMoveResources } from './move-ops';
import { applyPaintInstances } from './instance-stroke-ops';
import { applyColliderFromModel } from './collider-model-ops';
import { applyEditTerrain } from './terrain-ops';
import type { GraphDocument, GraphOp } from '@thirdlight/project-model';
import type {
  ApplyOutcome,
  CommandState,
  ContentDocument,
  ForwardOp,
  HistoryEntry,
  MutationFailure,
  MutationOp,
  MutationSuccess,
  SceneDocument,
} from './types';
import {
  checkRequestBytes,
  echoField,
  validateOpArgs,
  validateRequestEnvelope,
} from './validate-request';

/**
 * Fresh per-project command state (empty history: a restart starts
 * here) over a v3 or v4 scene and its content block (an omitted block is
 * treated as the empty v3 catalog). `manifest` is supplied when the caller
 * has one so v3 results get the three-block `validateProjectV3` validation.
 */
export function createCommandState<S extends SceneDocument>(
  scene: S,
  content?: ContentDocument,
  manifest?: Manifest,
): CommandState<S> {
  const state: CommandState<S> = { scene, history: createHistory() };
  if (content !== undefined) state.content = content;
  if (manifest !== undefined) state.manifest = manifest;
  return state;
}

/** The failure payload with the parseable echo fields, canonical key order. */
function failure(raw: unknown, error: CommandError): MutationFailure {
  const out = { ok: false } as MutationFailure;
  const req =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const op = echoField(req['op'], 32);
  if (op.present) out.op = op.value;
  // projectId is echoed when parseable (no truncation pinned).
  if (typeof req['projectId'] === 'string') out.projectId = req['projectId'];
  const rid = echoField(req['requestId'], 64);
  if (rid.present) out.requestId = rid.value;
  out.error = error;
  return out;
}

/**
 * Build the success payload in canonical key order:
 * `ok, op, projectId, requestId, revision, duplicated, createdId? (create
 * only), change, appliedOf?/originOfApplied? (undo/redo only), history`.
 */
function success(
  op: MutationOp,
  projectId: string,
  requestId: string,
  revision: number,
  change: MutationSuccess['change'],
  opts: {
    createdId?: string;
    appliedOf?: string;
    originOfApplied?: HistoryEntry['origin'];
    undoDepth: number;
    redoDepth: number;
  },
): MutationSuccess {
  const out = {
    ok: true,
    op,
    projectId,
    requestId,
    revision,
    duplicated: false,
  } as MutationSuccess;
  if (opts.createdId !== undefined) out.createdId = opts.createdId;
  out.change = change;
  if (opts.appliedOf !== undefined) {
    out.appliedOf = opts.appliedOf;
    out.originOfApplied = opts.originOfApplied ?? null;
  }
  out.history = { undoDepth: opts.undoDepth, redoDepth: opts.redoDepth };
  return out;
}

/** Record one forward entry and build the success outcome. */
function completeForward<S extends SceneDocument>(
  state: CommandState<S>,
  op: ForwardOp,
  projectId: string,
  requestId: string,
  revision: number,
  origin: HistoryEntry['origin'],
  applied: OpSuccess,
): ApplyOutcome<S> {
  // Props' block footprints follow them in the same transaction (a cross-scene move leaves its cells).
  const fp = applied.otherScene === undefined ? writeFootprints(state.scene, applied.scene, applied.content ?? state.content, state.manifest) : null;
  if (fp !== null && !fp.ok) return { ok: false, result: failure({ op, projectId, requestId }, fp.error) };
  if (fp !== null && fp.scene !== null) applied = { ...applied, scene: fp.scene, change: withFootprintChunks(applied.change, fp.layers) };
  const entry: HistoryEntry = {
    seq: state.history.seq,
    requestId,
    op,
    origin,
    appliedRevision: revision,
    change: applied.change,
    inverse: applied.inverse,
  };
  if (fp !== null && fp.ok && fp.scene !== null) entry.footprints = fp.layers;
  const history = recordForwardEdit(state.history, entry);
  const nextState = { ...state, scene: applied.scene, history } as CommandState<S>;
  if (applied.content !== undefined) nextState.content = applied.content;
  if (applied.otherScene !== undefined) nextState.otherScene = applied.otherScene as CommandState<S>['otherScene'];
  return {
    ok: true,
    state: nextState,
    result: success(op, projectId, requestId, revision, applied.change, {
      createdId: applied.createdId,
      undoDepth: history.cursor,
      redoDepth: history.entries.length - history.cursor,
    }),
  };
}

/**
 * Execute one mutation request against the current per-project state.
 *
 * Pipeline (the pure steps):
 * - envelope validation (`invalid_request`; op/projectId/
 *   expectedRevision/requestId/origin and `args`-is-an-object). Runs
 *   FIRST: a malformed envelope is `invalid_request` even when stale;
 * - revision check BEFORE argument validation (a stale request is
 *   reported as stale, not validated) ⇒ `revision_conflict`;
 * - `revision_exhausted` when the current revision is 2^53−1 (state-level,
 *   so it also precedes argument validation);
 * - the canonical request byte bound (`limits_exceeded` `request_bytes`,
 *   before argument validation);
 * - per-op `args` schema validation (`field_*`);
 * - per-op preconditions and pure application on an in-memory copy, with
 *   project-model re-validation of the resulting state (step 5);
 * - the uniform `no_change` check (step 6).
 *
 * Total: malformed requests and state never throw; every failure leaves
 * the input state unchanged. Pure: the input state object is never
 * mutated; the success outcome carries the new state.
 */
export function applyMutation<S extends SceneDocument>(
  state: CommandState<S>,
  request: unknown,
): ApplyOutcome<S> {
  // Envelope pass: op/projectId/expectedRevision/
  // requestId/origin and `args`-is-an-object → `invalid_request`. Runs
  // FIRST — a malformed envelope is `invalid_request` even when stale, and
  // the revision check needs a parseable `expectedRevision`.
  const env = validateRequestEnvelope(request);
  if (!env.ok) return { ok: false, result: failure(request, env.error) };
  const envelope = env.envelope;
  const { scene } = state;

  // Step 4: revision check — precedes argument validation (a stale
  // request is reported as stale, not validated).
  if (envelope.expectedRevision !== scene.revision) {
    return {
      ok: false,
      result: failure(request, revisionConflict(envelope.expectedRevision, scene.revision)),
    };
  }
  // Revision exhaustion: the matching revision is the
  // maximum — +1 would overflow the safe-integer bound. A state-level
  // condition, so it precedes argument validation as well.
  if (scene.revision >= MAX_REVISION) {
    return {
      ok: false,
      result: failure(request, revisionExhausted(scene.revision)),
    };
  }

  // Request-byte bound: canonical request bytes ≤ 65 536, checked
  // before argument validation (pipeline step 5's first clause).
  const tooBig = checkRequestBytes(request);
  if (tooBig !== null) return { ok: false, result: failure(request, tooBig) };

  // Step 5, args schema: per-op `field_*` validation —
  // AFTER the revision check, before op application.
  const va = validateOpArgs(envelope.op, env.args);
  if (!va.ok) return { ok: false, result: failure(request, va.error) };

  const revision = envelope.expectedRevision + 1;
  const input: OpInput = {
    scene,
    content: state.content,
    manifest: state.manifest,
    revision,
  };
  if (state.behaviorPreparerRegistered !== undefined) {
    input.behaviorPreparerRegistered = state.behaviorPreparerRegistered;
  }
  if (state.preparedBehaviorSources !== undefined) {
    input.preparedBehaviorSources = state.preparedBehaviorSources;
  }
  if (state.reservedIds !== undefined) input.reservedIds = state.reservedIds;
  if (state.scriptLibraryStages !== undefined) input.scriptLibraryStages = state.scriptLibraryStages;

  switch (va.validated.op) {
    case 'createEntities': {
      // Several creates, one transaction (one revision, one undo).
      const r = applyCreateEntities(scene, va.validated.args, state.content, state.reservedIds);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'createEntities', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setLabels':
    case 'setAddress': {
      // Many items' labels, or one item's address, in one transaction (one undo).
      const v = va.validated;
      const r = v.op === 'setLabels' ? applySetLabels(input, v.args) : applySetAddress(input, v.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, v.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'importAssets': {
      // A folder's files, prepared by the host, as assets in one transaction.
      const r = applyImportAssets(input, va.validated.args, state.preparedAssetImport);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'importAssets', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'moveResources':
    case 'renameFolder':
    case 'createFolder': {
      // Files and folders moved as the host prepared them, in one transaction (one undo).
      const op = va.validated.op;
      const r = applyMoveResources(input, state.preparedMoves);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'paintInstances': {
      // One brush stroke: the set's buffer the host planned and published, stored in one change (one undo).
      const r = applyPaintInstances(input, va.validated.args, state.preparedInstanceStroke);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'paintInstances', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'colliderFromModel': {
      // The collider the host made from the object's model file, stored as one setComponent change (one undo).
      const r = applyColliderFromModel(input, va.validated.args, state.preparedModelCollider);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'colliderFromModel', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'editTerrain': {
      // The tiles the host planned and published, stored as one setComponent change (one undo points back at the old tiles).
      const r = applyEditTerrain(input, va.validated.args, state.preparedTerrainEdit);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'editTerrain', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'importResources': {
      // Resource and scene files the file check read, into the project in one transaction.
      const r = applyImportResources(input, state.preparedResourceImport);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'importResources', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'deleteAsset':
    case 'deletePrefab': {
      // Remove a catalog record (refused while anything references it).
      const r = va.validated.op === 'deleteAsset' ? applyDeleteAsset(input, va.validated.args) : applyDeletePrefab(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'createEntity': {
      const r = applyCreateEntity(scene, va.validated.args, state.content, state.reservedIds);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'createEntity',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'setTransform': {
      const r = applySetTransform(scene, va.validated.args, state.content);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'setTransform',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'updateEntity': {
      const r = applyUpdateEntity(scene, va.validated.args, state.content);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'updateEntity',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'createScene':
    case 'renameScene':
    case 'deleteScene':
    case 'setStartScenes': {
      const r = applySceneIndexOp(input, va.validated.args, state.sceneEnvironments);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setTags': {
      const r = applySetTags(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setTags', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setMaterial':
    case 'deleteMaterial':
    case 'setEnvironment': {
      const a = va.validated.args as Record<string, unknown>;
      const r =
        va.validated.op === 'setMaterial'
          ? applySetMaterial(input, a as { material: MaterialDef })
          : va.validated.op === 'deleteMaterial'
            ? applyDeleteMaterial(input, a as { materialId: string })
            : applySetEnvironment(input, a as { environment: EnvironmentConfig | SceneEnvironment; sceneId?: string });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setInput': {
      const r = applySetInput(input, va.validated.args as { input: InputConfig | null });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setInput', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setModes': {
      // The game modes (the whole list).
      const r = applySetModes(input, va.validated.args as { modes: import('@thirdlight/project-model').GameMode[] });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setModes', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setBehaviorGroups': {
      const r = applySetBehaviorGroups(input, va.validated.args as { groups: string[] });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setBehaviorGroups', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setShell': {
      // The game shell (the whole block; null removes it).
      const r = applySetShell(input, va.validated.args as { shell: import('@thirdlight/project-model').GameShell | null });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setShell', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setEventCues': {
      // The event → cue table (the whole list).
      const r = applySetEventCues(input, va.validated.args as { cues: import('@thirdlight/project-model').EventCue[] });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setEventCues', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setCollisionLayers': {
      const r = applySetCollisionLayers(input, va.validated.args as { layers: string[] });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setCollisionLayers', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setLightLayers': {
      const r = applySetLightLayers(input, va.validated.args as { layers: string[] });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setLightLayers', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setSaveSchema': {
      const r = applySetSaveSchema(input, va.validated.args as { schema: import('@thirdlight/project-model').SaveSchema | null });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setSaveSchema', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setAnimator':
    case 'deleteAnimator': {
      const a = va.validated.args as Record<string, unknown>;
      const r = va.validated.op === 'setAnimator' ? applySetAnimator(input, a as { controller: AnimatorController }) : applyDeleteAnimator(input, a as { controllerId: string });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setGraph':
    case 'deleteGraph':
    case 'graphEdit': {
      const a = va.validated.args as Record<string, unknown>;
      const r =
        va.validated.op === 'setGraph'
          ? applySetGraph(input, a as { graph: GraphDocument })
          : va.validated.op === 'deleteGraph'
            ? applyDeleteGraph(input, a as { graphId: string })
            : applyGraphEdit(input, a as { owner: { kind: string; id: string }; ops: GraphOp[] });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setEffect':
    case 'deleteEffect':
    case 'renameEffect': {
      const a = va.validated.args as Record<string, unknown>;
      const r =
        va.validated.op === 'setEffect'
          ? applySetEffect(input, a as { effect: EffectDef })
          : va.validated.op === 'deleteEffect'
            ? applyDeleteEffect(input, a as { effectId: string })
            : applyRenameEffect(input, a as { effectId: string; name: string });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setUiDocument':
    case 'deleteUiDocument':
    case 'setUiTheme':
    case 'deleteUiTheme': {
      // Project UI documents and themes.
      const a = va.validated.args as Record<string, unknown>;
      const op = va.validated.op;
      const r =
        op === 'setUiDocument'
          ? applySetUiDocument(input, a as { document: import('@thirdlight/project-model').UiDocument })
          : op === 'setUiTheme'
            ? applySetUiTheme(input, a as { theme: import('@thirdlight/project-model').UiTheme })
            : applyDeleteUi(input, op === 'deleteUiDocument' ? 'document' : 'theme', String(op === 'deleteUiDocument' ? a['uiDocumentId'] : a['uiThemeId']));
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setDialogue':
    case 'deleteDialogue':
    case 'setSpeaker':
    case 'deleteSpeaker':
    case 'setDialogueSettings': {
      // Conversations, the speaker registry, the dialogue settings.
      const a = va.validated.args as Record<string, unknown>;
      const op = va.validated.op;
      const r =
        op === 'setDialogue'
          ? applySetDialogue(input, a as unknown as import('./types').SetDialogueArgs)
          : op === 'setSpeaker'
            ? applySetSpeaker(input, a as { speaker: import('@thirdlight/project-model').DialogueSpeaker })
            : op === 'setDialogueSettings'
              ? applySetDialogueSettings(input, a as { settings: import('@thirdlight/project-model').DialogueSettings | null })
              : applyDeleteDialogueValue(input, op === 'deleteDialogue' ? 'dialogue' : 'speaker', String(op === 'deleteDialogue' ? a['dialogueId'] : a['speakerId']));
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setTimeline':
    case 'deleteTimeline': {
      // Timelines (one whole timeline per command; one undo each).
      const a = va.validated.args as Record<string, unknown>;
      const op = va.validated.op;
      const r = op === 'setTimeline' ? applySetTimeline(input, a as { timeline: import('@thirdlight/project-model').TimelineAsset }) : applyDeleteTimeline(input, String(a['timelineId']));
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setScriptLibrary':
    case 'deleteScriptLibrary': {
      // Shared script libraries (a change republishes the dependents from prepared facts).
      const a = va.validated.args as Record<string, unknown>;
      const r =
        va.validated.op === 'setScriptLibrary'
          ? applySetScriptLibrary(input, a as unknown as import('@thirdlight/project-model').ScriptLibraryPatch)
          : applyDeleteScriptLibrary(input, a as { libraryId: string });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'commitScriptLibraryStage': {
      // A staged set of library edits, one change (the dependents from facts prepared once).
      const r = applyCommitScriptLibraryStage(input, va.validated.args as { stageId: string });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, va.validated.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'editBlocks':
    case 'setBlockType':
    case 'deleteBlockType':
    case 'setCellFields':
    case 'setBlockStamp':
    case 'deleteBlockStamp': {
      // Block layers (cells as one undo step per command; block types, cell fields, stamps).
      const a = va.validated.args as Record<string, unknown>;
      const op = va.validated.op;
      const r =
        op === 'editBlocks'
          ? applyEditBlocks(input, a as { entityId: string; edits: BlockEdit[] })
          : op === 'setBlockType'
            ? applySetBlockType(input, a as { block: BlockType })
            : op === 'deleteBlockType'
              ? applyDeleteBlockType(input, a as { blockId: string })
              : op === 'setCellFields'
                ? applySetCellFields(input, a as { fields: CellField[] })
                : op === 'setBlockStamp'
                  ? applySetBlockStamp(input, a)
                  : applyDeleteBlockStamp(input, a as { stampId: string });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setLighting': {
      const r = applySetLighting(input, va.validated.args as { sceneId: string; lighting: LightingBake | null });
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setLighting', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'pasteEntities': {
      const r = applyPasteEntities(scene, va.validated.args, state.content, state.reservedIds);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'pasteEntities', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'setAssetOptions': {
      const r = applySetAssetOptions(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setAssetOptions', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'moveEntities': {
      // Into another scene: the host gave the command that scene.
      if (va.validated.args.sceneId !== undefined) {
        const other = state.otherScene;
        if (other === undefined || other.sceneId !== va.validated.args.sceneId) return { ok: false, result: failure(request, { code: 'reference_missing', cls: 'validation', path: '/args/sceneId', reason: 'scene', found: va.validated.args.sceneId, message: 'no such scene in this project' } as CommandError) };
        const m = applyMoveEntitiesScene(scene, other, va.validated.args, state.content);
        if (!m.ok) return { ok: false, result: failure(request, m.error) };
        return completeForward(state, 'moveEntities', envelope.projectId, envelope.requestId, revision, envelope.origin, { scene: m.result.scene, change: m.result.change, inverse: m.inverse, otherScene: m.result.otherScene });
      }
      const r = applyMoveEntities(scene, va.validated.args, state.content);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'moveEntities',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'deleteEntity': {
      const r = applyDeleteEntity(scene, va.validated.args, state.content);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'deleteEntity',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'publishAsset':
    case 'publishBehavior':
    case 'setBehaviorProperties':
    case 'setComponent':
    case 'setSettings':
    case 'acknowledgeBehaviorTrust': {
      const op = va.validated.op;
      const r =
        op === 'publishAsset'
          ? applyPublishAsset(input, va.validated.args)
          : op === 'publishBehavior'
            ? applyPublishBehavior(input, va.validated.args)
            : op === 'setBehaviorProperties'
              ? applySetBehaviorProperties(input, va.validated.args)
              : op === 'setComponent'
                ? applySetComponent(input, va.validated.args)
                : op === 'setSettings'
                  ? applySetSettings(input, va.validated.args)
                  : applyAcknowledgeBehaviorTrust(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        op,
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'createPrefab': {
      const r = applyCreatePrefab(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'createPrefab',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'instantiatePrefab': {
      const r = applyInstantiatePrefab(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'instantiatePrefab',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'applySurfacePreset': {
      const r = applyApplySurfacePreset(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'applySurfacePreset',
        envelope.projectId,
        envelope.requestId,
        revision,
        envelope.origin,
        r.op,
      );
    }
    case 'undo':
    case 'redo': {
      const r =
        va.validated.op === 'undo' ? executeUndo(state) : executeRedo(state);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      const { outcome } = r;
      const nextState = { ...state, scene: outcome.scene, history: outcome.history } as CommandState<S>;
      if (outcome.content !== undefined) nextState.content = outcome.content;
      if (outcome.otherScene !== undefined) nextState.otherScene = outcome.otherScene as CommandState<S>['otherScene'];
      return {
        ok: true,
        state: nextState,
        result: success(
          va.validated.op,
          envelope.projectId,
          envelope.requestId,
          revision,
          outcome.change,
          {
            appliedOf: outcome.appliedOf,
            originOfApplied: outcome.originOfApplied,
            undoDepth: outcome.history.cursor,
            redoDepth: outcome.history.entries.length - outcome.history.cursor,
          },
        ),
      };
    }
    default: {
      // Unreachable: the envelope pass validated `op` against the implemented
      // ops and `validateOpArgs` dispatched on the same value; keep a safe,
      // contract-shaped fallback.
      return {
        ok: false,
        result: failure(request, {
          code: 'invalid_request',
          cls: 'validation',
          path: '/op',
          message: 'op is not one of the implemented mutation ops',
          expected:
            'one of: createEntity, setTransform, deleteEntity, undo, redo, publishAsset, publishBehavior, setBehaviorProperties, setComponent, setSettings, acknowledgeBehaviorTrust, createPrefab, instantiatePrefab, applySurfacePreset, updateEntity, moveEntities, setTags, setAssetOptions, pasteEntities, setMaterial, deleteMaterial, setEnvironment, setLighting, setAnimator, deleteAnimator, setInput, setCollisionLayers, setLightLayers, setSaveSchema, createScene, renameScene, deleteScene, setStartScenes, setGraph, deleteGraph, graphEdit, setEffect, deleteEffect, renameEffect, setScriptLibrary, deleteScriptLibrary, editBlocks, setBlockType, deleteBlockType, setCellFields, setBlockStamp, deleteBlockStamp, setUiDocument, deleteUiDocument, setUiTheme, deleteUiTheme, setTimeline, deleteTimeline, setModes, setBehaviorGroups, setEventCues, setShell, setDialogue, deleteDialogue, setSpeaker, deleteSpeaker, setDialogueSettings, deleteAsset, deletePrefab, importAssets, importResources, createEntities, commitScriptLibraryStage, setLabels, setAddress, moveResources, renameFolder, createFolder, paintInstances, colliderFromModel, editTerrain',
        }),
      };
    }
  }
}
