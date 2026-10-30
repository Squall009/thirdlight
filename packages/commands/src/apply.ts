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

import { withKeptPartIds } from './prefab-copy-edit';
import { routeLinkedEdit } from './prefab-stage-edit';
import type { Manifest } from '@thirdlight/project-model';
import { withMigrationMarksCleared } from '@thirdlight/project-model';

import {
  MAX_REVISION,
  revisionConflict,
  revisionExhausted,
  type CommandError,
} from './errors';
import type { OpInput } from './content-ops';
import { createHistory, executeRedo, executeUndo, recordForwardEdit } from './history';
import { withFootprintChunks, writeSceneFootprints } from './footprint-ops';
import { withFollowChange } from './follow-ops';
import type { OpSuccess } from './ops';
import { OP_ENTRIES } from './op-table';
import type { ArgsOf, OpEntry } from './op-table-types';
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
  MUTATION_OPS_EXPECTED,
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
  const fp = applied.otherScene === undefined ? writeSceneFootprints(state.scene, applied.scene, state.content, applied.content ?? state.content, state.manifest) : null;
  if (fp !== null && !fp.ok) return { ok: false, result: failure({ op, projectId, requestId }, fp.error) };
  if (fp !== null && fp.scene !== null) applied = { ...applied, scene: fp.scene, change: withFootprintChunks(applied.change, fp.layers) };
  // An upgrade note (a former 2D project's) goes once the edit saved its component in the new form.
  const settled = withMigrationMarksCleared(state.scene as Parameters<typeof withMigrationMarksCleared>[0], applied.scene as Parameters<typeof withMigrationMarksCleared>[1]);
  if (settled !== applied.scene) applied = { ...applied, scene: settled as typeof applied.scene };
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
  // Components the op wrote besides its own change: the entry undoes and redoes them with it, and clients take them from the change.
  if (applied.follows !== undefined && applied.follows.length > 0) {
    entry.follows = applied.follows;
    applied = { ...applied, change: withFollowChange(applied.change, applied.follows) };
  }
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
  // A linked copy's kept part ids are no stored object's, yet no new object may take one.
  const reserved = withKeptPartIds(scene, state.reservedIds);
  if (reserved !== undefined) input.reservedIds = reserved;
  if (state.scriptLibraryStages !== undefined) input.scriptLibraryStages = state.scriptLibraryStages;

  // Naming a linked copy's part: stored as overrides (assembled first); naming a prefab stage's objects: the prefab changes.
  const routed = routeLinkedEdit(state, request, va.validated.op, env.args, (s, r) => applyMutation(s, r));
  if (routed !== null) {
    if (!routed.ok) return { ok: false, result: failure(request, routed.error) };
    return completeForward(state, va.validated.op as ForwardOp, envelope.projectId, envelope.requestId, revision, envelope.origin, routed.op);
  }

  // Every forward op's step comes from the op table, beside the undo and redo of what it records.
  const v = va.validated;
  if (v.op !== 'undo' && v.op !== 'redo') {
    const entry = OP_ENTRIES[v.op] as OpEntry<ForwardOp> | undefined;
    if (entry !== undefined) {
      const r = entry.apply(input, v.args as ArgsOf<ForwardOp>, state as CommandState<SceneDocument>);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      return completeForward(state, v.op, envelope.projectId, envelope.requestId, revision, envelope.origin, r.op);
    }
  }
  switch (v.op) {
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
            MUTATION_OPS_EXPECTED,
        }),
      };
    }
  }
}
