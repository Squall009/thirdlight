/**
 * `applyMutation` — the pure core of the mutation pipeline
 * (commands.md §6.1 steps 4–6).
 *
 * The workspace service (packet 07) runs the FULL pipeline: project
 * resolution (1), deduplication (2), pause check (3), then THIS function
 * (4 revision check → 5 validation + pure application → 6 no-change
 * check), then durability write (7), publish (8), and acknowledge (9).
 * This function owns nothing durable: it takes the current in-memory
 * state + the raw request value and returns either the success payload
 * (§5.1) with the NEW state, or the failure payload (§5.2) with the input
 * state left untouched. No filesystem, transport, digests, or records.
 *
 * Packet 21 adds the non-prefab M2 content/property ops (§8.5–§8.12); they run
 * the SAME pipeline and the same history engine — only the state they mutate
 * (the envelope's `content` block as well as the scene) differs.
 */

import type { ContentCatalog, Manifest } from '@thirdlight/project-model';

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
import {
  applyCreateEntity,
  applyDeleteEntity,
  applyMoveEntities,
  applySetTransform,
  applyUpdateEntity,
  type OpSuccess,
} from './ops';
import { applyCreatePrefab, applyInstantiatePrefab } from './prefab-ops';
import { applyApplySurfacePreset, applySetGameConfig } from './v3-ops';
import { applySetTags } from './tag-ops';
import type {
  ApplyOutcome,
  CommandState,
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
 * Fresh per-project command state (empty history, §9.2: a restart starts
 * here). `content` is the envelope's M2 content block for a v2 project; it is
 * omitted for an M1 state (treated as the empty catalog). `manifest` is
 * supplied when the caller has one so v2 results get the three-block
 * `validateProjectV2` validation (project-model §13.1).
 */
export function createCommandState<S extends SceneDocument>(
  scene: S,
  content?: ContentCatalog,
  manifest?: Manifest,
): CommandState<S> {
  const state: CommandState<S> = { scene, history: createHistory() };
  if (content !== undefined) state.content = content;
  if (manifest !== undefined) state.manifest = manifest;
  return state;
}

/** §5.2 failure payload with the parseable echo fields, canonical key order. */
function failure(raw: unknown, error: CommandError): MutationFailure {
  const out = { ok: false } as MutationFailure;
  const req =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const op = echoField(req['op'], 32);
  if (op.present) out.op = op.value;
  // projectId is echoed when parseable (no truncation pinned, §5.2).
  if (typeof req['projectId'] === 'string') out.projectId = req['projectId'];
  const rid = echoField(req['requestId'], 64);
  if (rid.present) out.requestId = rid.value;
  out.error = error;
  return out;
}

/**
 * Build the §5.1 success payload in canonical key order:
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
  const entry: HistoryEntry = {
    seq: state.history.seq,
    requestId,
    op,
    origin,
    appliedRevision: revision,
    change: applied.change,
    inverse: applied.inverse,
  };
  const history = recordForwardEdit(state.history, entry);
  const nextState = { ...state, scene: applied.scene, history } as CommandState<S>;
  if (applied.content !== undefined) nextState.content = applied.content;
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
 * Pipeline (commands.md §6.1, the pure steps):
 * - envelope validation (§3 — `invalid_request`; op/projectId/
 *   expectedRevision/requestId/origin and `args`-is-an-object). Runs
 *   FIRST: a malformed envelope is `invalid_request` even when stale;
 * - revision check BEFORE argument validation (§6.1 step 4: a stale
 *   request is reported as stale, not validated) ⇒ `revision_conflict`;
 * - `revision_exhausted` when the current revision is 2^53−1 (state-level,
 *   so it also precedes argument validation);
 * - the canonical request byte bound (`limits_exceeded` `request_bytes`,
 *   §3.1: before argument validation);
 * - per-op `args` schema validation (§3.1 — `field_*`);
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
  // Envelope pass (commands.md §3): op/projectId/expectedRevision/
  // requestId/origin and `args`-is-an-object → `invalid_request`. Runs
  // FIRST — a malformed envelope is `invalid_request` even when stale, and
  // the revision check needs a parseable `expectedRevision`.
  const env = validateRequestEnvelope(request);
  if (!env.ok) return { ok: false, result: failure(request, env.error) };
  const envelope = env.envelope;
  const { scene } = state;

  // Step 4: revision check — precedes argument validation (commands.md
  // §6.1 step 4: a stale request is reported as stale, not validated).
  if (envelope.expectedRevision !== scene.revision) {
    return {
      ok: false,
      result: failure(request, revisionConflict(envelope.expectedRevision, scene.revision)),
    };
  }
  // Revision exhaustion (commands.md §5.4): the matching revision is the
  // maximum — +1 would overflow the safe-integer bound. A state-level
  // condition, so it precedes argument validation as well.
  if (scene.revision >= MAX_REVISION) {
    return {
      ok: false,
      result: failure(request, revisionExhausted(scene.revision)),
    };
  }

  // §3.1 request-byte bound: canonical request bytes ≤ 65 536, checked
  // before argument validation (pipeline step 5's first clause).
  const tooBig = checkRequestBytes(request);
  if (tooBig !== null) return { ok: false, result: failure(request, tooBig) };

  // Step 5, args schema (commands.md §3.1): per-op `field_*` validation —
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

  switch (va.validated.op) {
    case 'createEntity': {
      const r = applyCreateEntity(scene, va.validated.args, state.content);
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
    case 'setTags': {
      const r = applySetTags(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, 'setTags', envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
    case 'moveEntities': {
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
    case 'setGameConfig': {
      const r = applySetGameConfig(input, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(
        state,
        'setGameConfig',
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
            'one of: createEntity, setTransform, deleteEntity, undo, redo, publishAsset, publishBehavior, setBehaviorProperties, setComponent, setSettings, acknowledgeBehaviorTrust, createPrefab, instantiatePrefab, applySurfacePreset, setGameConfig, updateEntity, moveEntities, setTags',
        }),
      };
    }
  }
}
