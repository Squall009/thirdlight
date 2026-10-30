/**
 * History model, for the entity and the content ops.
 *
 * Per project, in memory only. `entries[0..n-1]` with cursor `c`:
 * entries below `c` are applied, entries at or above `c` are the
 * redo tail. Fresh edits truncate `entries[c..n-1]` and append; undo
 * applies `entries[c-1].inverse`; redo re-applies `entries[c].change`
 * forward using the recorded values (no ID re-scan).
 *
 * Every entry carries a `change` and an `inverse` in the same vocabulary.
 * The entity kinds (`createEntity`/`setTransform`/`deleteEntity`) touch
 * only the scene.
 * The content/component/property/settings/trust kinds touch the scene and/or
 * the envelope's `content` block; a `restore: null` value means the record or
 * component did not exist, so the inverse removes it.
 *
 * Inverse/forward application passes through the same pure pipeline as
 * forward ops (result-state re-validation, uniform no-change check): it
 * is normally valid (the state is exactly the state the entry was applied
 * from, by LIFO), but if validation ever fails the command returns
 * `history_invalid`, changes nothing, and leaves the stacks untouched
 * (defensive).
 */

import { withFootprintChunks, withFootprintLayers } from './footprint-ops';
import { withFollowChange, withFollows, type ComponentFollow } from './follow-ops';
import { historyEmpty, historyInvalid, type CommandError } from './errors';
import { REDO, UNDO } from './op-table';
import type { ApplyResult } from './op-table-types';
import type {
  ChangeData,
  CommandState,
  ContentDocument,
  ForwardChange,
  HistoryEntry,
  HistoryState,
  InverseSpec,
  SceneDocument,
} from './types';

type Replay<T> = (state: CommandState<SceneDocument>, entry: HistoryEntry, recorded: T) => ApplyResult;

/**
 * Apply a history entry's INVERSE (undo). `state` must be the
 * state AFTER the entry's forward command (the LIFO invariant). Returns the
 * applied result state + the change data in the applied (inverse) direction,
 * or a `history_invalid` error on defensive failure.
 */
function applyInverse(state: CommandState<SceneDocument>, entry: HistoryEntry): ApplyResult {
  const undo = UNDO[entry.inverse.kind] as Replay<InverseSpec> | undefined;
  return undo === undefined ? { ok: false, error: historyInvalid(entry.requestId) } : undo(state, entry, entry.inverse);
}

/**
 * Re-apply a history entry's FORWARD change (redo) using the recorded
 * values: a redo of a create re-inserts the recorded entity value at the end
 * of the array with its original ID (no ID re-scan); a redo of a setTransform
 * replaces the recorded fields with the recorded `next` values; a redo of a
 * delete removes the recorded `deletedIds`; content entries re-apply their
 * recorded `next`/added values.
 */
function applyForward(state: CommandState<SceneDocument>, entry: HistoryEntry): ApplyResult {
  const redo = REDO[entry.change.type] as Replay<ForwardChange> | undefined;
  return redo === undefined ? { ok: false, error: historyInvalid(entry.requestId) } : redo(state, entry, entry.change);
}

/** Undo/redo outcome: the new state pieces plus the applied-direction change. */
export interface HistoryOutcome {
  scene: SceneDocument;
  content?: ContentDocument;
  /** A cross-scene move's second scene as it now is. */
  otherScene?: { sceneId: string; scene: SceneDocument };
  history: HistoryState;
  change: ChangeData;
  appliedOf: string;
  originOfApplied: HistoryEntry['origin'];
}

/**
 * Execute `undo` on the command state: requires `c > 0`,
 * applies `entries[c-1].inverse`, `c--`. Returns the new state + the
 * applied-direction change data, or a structured error.
 */
export function executeUndo(
  state: CommandState<SceneDocument>,
): { ok: true; outcome: HistoryOutcome } | { ok: false; error: CommandError } {
  const history = state.history;
  if (history.cursor === 0) return { ok: false, error: { ...historyEmpty('undo') } };
  const entry = history.entries[history.cursor - 1] as HistoryEntry;
  // The host's follow-ups and the footprint writes came after the command, so they go back first (in reverse).
  const fp = entry.footprints;
  const fl = entry.follows;
  const unfollowed = fl !== undefined ? { ...state, scene: withFollows(state.scene, fl, 'restore') } : state;
  const applied = applyInverse(fp !== undefined ? { ...unfollowed, scene: withFootprintLayers(unfollowed.scene, fp, 'restore') } : unfollowed, entry);
  if (!applied.ok) return applied;
  return {
    ok: true,
    outcome: {
      scene: applied.applied.scene,
      content: applied.applied.content,
      ...(applied.applied.otherScene !== undefined ? { otherScene: applied.applied.otherScene } : {}),
      history: { ...history, cursor: history.cursor - 1 },
      change: followed(fp !== undefined ? withFootprintChunks(applied.applied.change, fp) : applied.applied.change, fl, 'restore'),
      appliedOf: entry.requestId,
      originOfApplied: entry.origin,
    },
  };
}

/**
 * Execute `redo` on the command state: requires `c < n`,
 * re-applies `entries[c].change` forward (recorded values), `c++`.
 */
export function executeRedo(
  state: CommandState<SceneDocument>,
): { ok: true; outcome: HistoryOutcome } | { ok: false; error: CommandError } {
  const history = state.history;
  if (history.cursor >= history.entries.length) {
    return { ok: false, error: { ...historyEmpty('redo') } };
  }
  const entry = history.entries[history.cursor] as HistoryEntry;
  const applied = applyForward(state, entry);
  if (!applied.ok) return applied;
  const fp = entry.footprints;
  const fl = entry.follows;
  const stepped = fp !== undefined ? withFootprintLayers(applied.applied.scene, fp, 'next') : applied.applied.scene;
  return {
    ok: true,
    outcome: {
      scene: fl !== undefined ? withFollows(stepped, fl, 'next') : stepped,
      content: applied.applied.content,
      ...(applied.applied.otherScene !== undefined ? { otherScene: applied.applied.otherScene } : {}),
      history: { ...history, cursor: history.cursor + 1 },
      change: followed(fp !== undefined ? withFootprintChunks(applied.applied.change, fp) : applied.applied.change, fl, 'next'),
      appliedOf: entry.requestId,
      originOfApplied: entry.origin,
    },
  };
}

/** The change naming the follow-ups' values on the side just applied (clients take them). */
function followed<C>(change: C, follows: readonly ComponentFollow[] | undefined, side: 'restore' | 'next'): C {
  return follows === undefined ? change : withFollowChange(change, follows.map((f) => ({ ...f, next: f[side] })));
}

/**
 * Record a fresh forward edit: truncate the redo tail
 * `entries[c..n-1]` (fresh edits invalidate redo), append the entry, `c++`,
 * assign the next diagnostic seq.
 */
export function recordForwardEdit(
  history: HistoryState,
  entry: HistoryEntry,
): HistoryState {
  const kept = history.entries.slice(0, history.cursor);
  return {
    entries: [...kept, entry],
    cursor: history.cursor + 1,
    seq: history.seq + 1,
  };
}

/** Empty initial history (a fresh process starts here). */
export function createHistory(): HistoryState {
  return { entries: [], cursor: 0, seq: 1 };
}
