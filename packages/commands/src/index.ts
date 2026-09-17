/**
 * @thirdlight/commands — public surface (dependencies.md §3;
 * commands.md §2/§5/§8/§9): types (mutation envelopes, results, errors,
 * change/inverse data), the pure apply function (the forward/inverse
 * application core of the mutation pipeline), the history model, and
 * `ERROR_CODES`.
 *
 * The workspace package (packet 07) is the sole command executor
 * (dependencies.md §4.3): it runs the full commands.md §6.1 pipeline —
 * project resolution, deduplication, pause check, then `applyMutation`
 * (steps 4–6), then the durability write, publish, and acknowledge.
 *
 * Pure logic: no filesystem, no transport, no UI, no three.js, no Node
 * built-ins (dependencies.md §4.1: the only allowed edge is
 * `project-model`, used for scene re-validation of resulting documents,
 * the ID syntax, and canonical byte comparison).
 *
 * All entry points are total: malformed requests yield structured error
 * results, never thrown exceptions; the input state is never mutated.
 */

// Entry points (the ONLY mutation path into command state — the workspace
// service's runCommand calls `applyMutation` and nothing else; AGENTS.md:
// no duplicate scene mutation paths).
export { applyMutation, createCommandState } from './apply';

// Error model (§5.4) and constants.
export { ERROR_CODES, MAX_REVISION } from './errors';
export type { CommandErrorCode } from './errors';

// Types (envelopes, results, change/inverse data, history, state).
export type {
  ApplyOutcome,
  BoxArgs,
  ChangeData,
  ChangedField,
  CommandError,
  CommandState,
  CreateEntityArgs,
  CreateEntityChange,
  DeleteEntityArgs,
  DeleteEntityChange,
  DeleteInverse,
  EmptyArgs,
  ErrorClass,
  ForwardChange,
  ForwardOp,
  HistoryDepths,
  HistoryEntry,
  HistoryState,
  InverseSpec,
  MutationArgs,
  MutationFailure,
  MutationOp,
  MutationRequest,
  MutationResult,
  MutationSuccess,
  Origin,
  PartialTransformArgs,
  RestoreSubtreeChange,
  RestoreSubtreeEntry,
  RestoreSubtreeInverse,
  SetTransformArgs,
  SetTransformChange,
  SetTransformInverse,
} from './types';