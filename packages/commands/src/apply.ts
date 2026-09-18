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
 */

import type { Scene } from '@thirdlight/project-model';

import {
  MAX_REVISION,
  revisionConflict,
  revisionExhausted,
  type CommandError,
} from './errors';
import {
  createHistory,
  executeRedo,
  executeUndo,
  recordForwardEdit,
} from './history';
import {
  applyCreateEntity,
  applyDeleteEntity,
  applySetTransform,
} from './ops';
import type {
  ApplyOutcome,
  CommandState,
  HistoryEntry,
  MutationFailure,
  MutationOp,
  MutationSuccess,
} from './types';
import { echoField, validateOpArgs, validateRequestEnvelope } from './validate-request';

/** Fresh per-project command state (empty history, §9.2: a restart starts here). */
export function createCommandState(scene: Scene): CommandState {
  return { scene, history: createHistory() };
}

/** §5.2 failure payload with the parseable echo fields, canonical key order. */
function failure(
  raw: unknown,
  error: CommandError,
): MutationFailure {
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
  // Canonical key order (fixture-pinned): ok, op, projectId, requestId,
  // revision, duplicated, createdId?, change, appliedOf?/originOfApplied?,
  // history.
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
 * - per-op `args` schema validation (§3.1 — `field_*`);
 * - per-op preconditions and pure application on an in-memory copy, with
 *   project-model re-validation of the resulting scene (step 5);
 * - the uniform `no_change` check (step 6).
 *
 * Total: malformed requests and state never throw; every failure leaves
 * the input state unchanged. Pure: the input state object is never
 * mutated; the success outcome carries the new state.
 */
export function applyMutation(state: CommandState, request: unknown): ApplyOutcome {
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

  // Step 5, args schema (commands.md §3.1): per-op `field_*` validation —
  // AFTER the revision check, before op application.
  const va = validateOpArgs(envelope.op, env.args);
  if (!va.ok) return { ok: false, result: failure(request, va.error) };

  const revision = envelope.expectedRevision + 1;

  switch (va.validated.op) {
    case 'createEntity': {
      const r = applyCreateEntity(scene, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      const entry: HistoryEntry = {
        seq: state.history.seq,
        requestId: envelope.requestId,
        op: 'createEntity',
        origin: envelope.origin,
        appliedRevision: revision,
        change: r.op.change,
        inverse: r.op.inverse,
      };
      const history = recordForwardEdit(state.history, entry);
      return {
        ok: true,
        state: { scene: r.op.scene, history },
        result: success(
          'createEntity',
          envelope.projectId,
          envelope.requestId,
          revision,
          r.op.change,
          {
            createdId: r.op.createdId,
            undoDepth: history.cursor,
            redoDepth: history.entries.length - history.cursor,
          },
        ),
      };
    }
    case 'setTransform': {
      const r = applySetTransform(scene, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      const entry: HistoryEntry = {
        seq: state.history.seq,
        requestId: envelope.requestId,
        op: 'setTransform',
        origin: envelope.origin,
        appliedRevision: revision,
        change: r.op.change,
        inverse: r.op.inverse,
      };
      const history = recordForwardEdit(state.history, entry);
      return {
        ok: true,
        state: { scene: r.op.scene, history },
        result: success(
          'setTransform',
          envelope.projectId,
          envelope.requestId,
          revision,
          r.op.change,
          {
            undoDepth: history.cursor,
            redoDepth: history.entries.length - history.cursor,
          },
        ),
      };
    }
    case 'deleteEntity': {
      const r = applyDeleteEntity(scene, va.validated.args);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      const entry: HistoryEntry = {
        seq: state.history.seq,
        requestId: envelope.requestId,
        op: 'deleteEntity',
        origin: envelope.origin,
        appliedRevision: revision,
        change: r.op.change,
        inverse: r.op.inverse,
      };
      const history = recordForwardEdit(state.history, entry);
      return {
        ok: true,
        state: { scene: r.op.scene, history },
        result: success(
          'deleteEntity',
          envelope.projectId,
          envelope.requestId,
          revision,
          r.op.change,
          {
            undoDepth: history.cursor,
            redoDepth: history.entries.length - history.cursor,
          },
        ),
      };
    }
    case 'undo':
    case 'redo': {
      const r =
        va.validated.op === 'undo'
          ? executeUndo(state.history, scene)
          : executeRedo(state.history, scene);
      if (!r.ok) return { ok: false, result: failure(request, r.error) };
      const depths = {
        undoDepth: r.history.cursor,
        redoDepth: r.history.entries.length - r.history.cursor,
      };
      return {
        ok: true,
        state: { scene: r.scene, history: r.history },
        result: success(
          va.validated.op,
          envelope.projectId,
          envelope.requestId,
          revision,
          r.change,
          {
            appliedOf: r.appliedOf,
            originOfApplied: r.originOfApplied,
            ...depths,
          },
        ),
      };
    }
    default:
      // Unreachable: the envelope pass validated `op` against the five
      // ops and `validateOpArgs` dispatched on the same value; keep a
      // safe, contract-shaped fallback.
      return {
        ok: false,
        result: failure(
          request,
          {
            code: 'invalid_request',
            cls: 'validation',
            path: '/op',
            message: 'op is not one of the five M1 mutation ops',
            expected: 'one of: createEntity, setTransform, deleteEntity, undo, redo',
          },
        ),
      };
  }
}
