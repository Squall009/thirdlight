/**
 * Public types — commands.md §2–§9 (M1).
 *
 * These are the command-layer wire shapes: the mutation request envelope
 * (§3), the mutation success/failure results (§5.1/§5.2), the structured
 * error model (§5.4), the change data (§5.3), the inverse specs and the
 * in-memory history model (§9.1), and the per-project command state the
 * pure apply function works on.
 *
 * Ownership (commands.md §1, workspace.md §1): this package owns command
 * semantics only. Request canonicalization/digests (§6.6), durable retry
 * records (§7.1), the revision's durable storage, and project resolution
 * belong to the workspace package (packet 07). Nothing here touches the
 * filesystem, transport, UI, or three.js (dependencies.md §4.1: the only
 * allowed edge is project-model).
 *
 * Runtime inputs to the public entry points are `unknown` where marked:
 * the strict validators re-check every rule (contract strictness, §3);
 * TypeScript types alone never make a value safe.
 */

import type {
  Entity,
  ModelError,
  Scene,
  TransformComponent,
} from '@thirdlight/project-model';

// ---- ops and origins --------------------------------------------------------

/** The five M1 mutation ops (commands.md §2). Queries are workspace-served (packet 07). */
export type MutationOp =
  | 'createEntity'
  | 'setTransform'
  | 'deleteEntity'
  | 'undo'
  | 'redo';

/** The forward ops that create history entries (undo/redo never do, §9.1). */
export type ForwardOp = 'createEntity' | 'setTransform' | 'deleteEntity';

/** Request origin (§3): absent ⇒ recorded as `null` in the history entry. */
export interface Origin {
  kind: 'browser' | 'mcp' | 'admin';
  /** 1–128 chars, no control characters. */
  clientId: string;
}

// ---- error model (§5.2/§5.4) --------------------------------------------------

/** Client policy classes (§5.5). */
export type ErrorClass =
  | 'conflict'
  | 'validation'
  | 'unavailable'
  | 'not_found'
  | 'internal';

/**
 * One structured error (§5.2/§5.4).
 *
 * Key order in emitted payloads: `code`, `cls`, then the code-specific
 * fields in §5.4 table order, then (result-scene failures)
 * `detailDocument`, `details`, `detailCount`, `detailsTruncated`, then
 * `message`, `hint` — the byte-exact scenario fixtures pin this order.
 *
 * Code-specific fields (present only per the §5.4 "Carries" column):
 * - `invalid_request`, `field_missing`/`field_unexpected`/`field_type`/
 *   `field_value`: `path` (JSON Pointer into the request), `found`
 *   (bounded), `expected`.
 * - `revision_conflict`: `expectedRevision`, `currentRevision`.
 * - `request_id_reused`, `revision_exhausted`: `currentRevision`.
 * - `entity_not_found`: `entityId`.
 * - `reference_missing`: `found`, `expected`.
 * - `camera_count_invalid`: `cameraId`.
 * - `limits_exceeded`: `limit` ("entities" | "depth"), `current`, `max`.
 * - `id_exhaustion`: `kind`.
 * - `history_empty`: `which` ("undo" | "redo").
 * - `history_invalid`: `requestId` (of the history entry).
 * - result-scene validation failure: `detailDocument: "result-scene"`,
 *   `details` (project-model §12.5 error objects in document order, capped
 *   at 32), `detailCount` (true total), `detailsTruncated` (when capped).
 *
 * The workspace-level codes (`project_not_found`, `project_unavailable`,
 * `workspace_closed`, `request_id_reused`, `external_change_unresolved`,
 * `write_failed`, …) are in `ERROR_CODES` but are constructed by the
 * workspace package (packet 07), never by this pure layer.
 */
export interface CommandError {
  code: string;
  cls: ErrorClass;
  /** One actionable sentence, safe for logs, no secrets. */
  message: string;
  hint?: string;
  path?: string;
  found?: unknown;
  expected?: string;
  detailDocument?: 'result-scene';
  details?: readonly ModelError[];
  detailCount?: number;
  detailsTruncated?: boolean;
  expectedRevision?: number;
  currentRevision?: number;
  entityId?: string;
  cameraId?: string;
  limit?: 'entities' | 'depth';
  current?: number;
  max?: number;
  kind?: string;
  which?: 'undo' | 'redo';
  /** `history_invalid` only: the requestId of the failed history entry. */
  requestId?: string;
  // workspace-level only (not emitted by the pure layer):
  projectId?: string;
  reason?: string;
  holder?: unknown;
  pendingChange?: unknown;
  onDiskState?: 'previous' | 'new-undurable';
  errno?: unknown;
}

// ---- change data (§5.3) --------------------------------------------------------

/** `position`/`rotation`/`scale` in canonical order. */
export type ChangedField = 'position' | 'rotation' | 'scale';

export interface CreateEntityChange {
  type: 'createEntity';
  id: string;
  /** The full created entity value (canonical, defaults filled). */
  entity: Entity;
}

export interface SetTransformChange {
  type: 'setTransform';
  id: string;
  /** Full transforms (all three fields), in the direction actually applied. */
  previous: TransformComponent;
  next: TransformComponent;
  /** Replaced field names, order position, rotation, scale. */
  changedFields: readonly ChangedField[];
}

export interface DeleteEntityChange {
  type: 'deleteEntity';
  rootId: string;
  /** Full subtree closure in pre-deletion array order. */
  deletedIds: readonly string[];
}

export interface RestoreSubtreeChange {
  type: 'restoreSubtree';
  rootId: string;
  /** Restored entity values in pre-deletion array order, root first. */
  entities: readonly Entity[];
}

/** Structured change data (§5.3). A client projection updates from this alone. */
export type ChangeData =
  | CreateEntityChange
  | SetTransformChange
  | DeleteEntityChange
  | RestoreSubtreeChange;

/** The change types a forward (non-undo/redo) command can produce. */
export type ForwardChange =
  | CreateEntityChange
  | SetTransformChange
  | DeleteEntityChange;

// ---- inverse specs (§9.1) --------------------------------------------------------

export interface DeleteInverse {
  kind: 'delete';
  rootId: string;
}

export interface SetTransformInverse {
  kind: 'setTransform';
  id: string;
  /** The full previous transform (all three fields). */
  restore: TransformComponent;
}

export interface RestoreSubtreeEntry {
  /** The entity's pre-deletion array index. */
  index: number;
  /** The full entity value. */
  entity: Entity;
}

export interface RestoreSubtreeInverse {
  kind: 'restoreSubtree';
  /** Pre-deletion array order (ascending index); root first. */
  entries: readonly RestoreSubtreeEntry[];
  /** The root's parent (or null); the parent always survives subtree deletion. */
  restoredParentId: string | null;
}

/** The inverse of a forward entry (§9.1). */
export type InverseSpec = DeleteInverse | SetTransformInverse | RestoreSubtreeInverse;

// ---- history model (§9.1) --------------------------------------------------------

/**
 * One history entry. Per project, in memory only (M1, §9.1/§9.2); `seq` is a
 * per-session diagnostic counter, not part of any durable record.
 */
export interface HistoryEntry {
  seq: number;
  requestId: string;
  /** The forward op that created the entry. */
  op: ForwardOp;
  /** The origin of the original command (or null). */
  origin: Origin | null;
  /** The revision this forward command produced. */
  appliedRevision: number;
  /** Forward change data (§5.3). */
  change: ForwardChange;
  /** Inverse spec (§9.1). */
  inverse: InverseSpec;
}

/**
 * The history stack (§9.1): `entries[0..n-1]` with cursor `c`;
 * entries below `c` are applied, entries at or above `c` are undone (the
 * redo tail). Fresh edits truncate `entries[c..n-1]`.
 */
export interface HistoryState {
  entries: readonly HistoryEntry[];
  /** 0 ≤ cursor ≤ entries.length. */
  cursor: number;
  /** Next per-session diagnostic seq value. */
  seq: number;
}

/** Depths reported in results and queries (§5.1, §5.6). */
export interface HistoryDepths {
  undoDepth: number;
  redoDepth: number;
}

// ---- command state --------------------------------------------------------------

/**
 * The per-project in-memory state the pure apply function operates on.
 * `scene` must be a VALID canonical scene (project-model §12.2) — the
 * workspace service (packet 07) guarantees this at load and after every
 * published mutation; the command layer re-validates only RESULT documents.
 */
export interface CommandState {
  scene: Scene;
  history: HistoryState;
}

// ---- mutation request envelopes (§3) ----------------------------------------------

/**
 * Partial transform args (§3.1): any non-empty subset; a present field
 * replaces the whole field (arrays are never merged component-wise).
 * Element values (length, finiteness, ranges, quaternion norm) are
 * re-checked by the project-model validation of the resulting scene.
 */
export interface PartialTransformArgs {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

/** Box args for createEntity (§3.1): only when `kind` is `"box"`. */
export interface BoxArgs {
  size?: readonly number[];
  material?: { color?: string };
}

export interface CreateEntityArgs {
  kind: 'group' | 'box';
  parentId?: string | null;
  name?: string;
  transform?: PartialTransformArgs;
  /** Only when `kind` is `"box"`. */
  box?: BoxArgs;
}

export interface SetTransformArgs {
  entityId: string;
  transform: PartialTransformArgs;
}

export interface DeleteEntityArgs {
  entityId: string;
}

/** undo/redo args: exactly the empty object (strictly enforced at runtime). */
export interface EmptyArgs {
  // intentionally empty — any field is rejected (field_unexpected)
}

export type MutationArgs =
  | CreateEntityArgs
  | SetTransformArgs
  | DeleteEntityArgs
  | EmptyArgs;

/**
 * The M1 mutation request envelope (§3). This type documents the wire
 * shape; `applyMutation` accepts `unknown` and validates strictly.
 */
export interface MutationRequest {
  op: MutationOp;
  projectId: string;
  expectedRevision: number;
  /** `req-` + 32 lowercase hex chars (client-generated CSPRNG). */
  requestId: string;
  origin?: Origin;
  args: MutationArgs;
}

// ---- results (§5.1/§5.2) ----------------------------------------------------------

/** Mutation success (§5.1); canonical key order in emitted payloads. */
export interface MutationSuccess {
  ok: true;
  op: MutationOp;
  projectId: string;
  requestId: string;
  /** expectedRevision + 1 (every successful M1 mutation advances by exactly 1). */
  revision: number;
  /** Always `false` from the pure layer; workspace replays set `true` (§6.3). */
  duplicated: false;
  /** createEntity only. */
  createdId?: string;
  change: ChangeData;
  /** undo/redo only: the requestId of the original forward command. */
  appliedOf?: string;
  /** undo/redo only: the origin of that original command (or null). */
  originOfApplied?: Origin | null;
  history: HistoryDepths;
}

/**
 * Mutation failure (§5.2). `op`/`projectId`/`requestId` are echoed only
 * when parseable (strings; `op` capped at 32 chars, `requestId` at 64).
 */
export interface MutationFailure {
  ok: false;
  op?: string;
  projectId?: string;
  requestId?: string;
  error: CommandError;
}

export type MutationResult = MutationSuccess | MutationFailure;

/**
 * Outcome of `applyMutation`: on success the NEW state (the input state is
 * never mutated); on failure the input state is left unchanged and no new
 * state is returned.
 */
export type ApplyOutcome =
  | { ok: true; result: MutationSuccess; state: CommandState }
  | { ok: false; result: MutationFailure };