/**
 * History model — commands.md §8.4/§9.
 *
 * Per project, in memory only (M1). `entries[0..n-1]` with cursor `c`
 * (§9.1): entries below `c` are applied, entries at or above `c` are the
 * redo tail. Fresh edits truncate `entries[c..n-1]` and append; undo
 * applies `entries[c-1].inverse`; redo re-applies `entries[c].change`
 * forward using the recorded values (no ID re-scan, §8.4).
 *
 * Inverse/forward application passes through the same pure pipeline as
 * forward ops (result-scene re-validation, uniform no-change check): in M1
 * it is provably valid (the state is exactly the state the entry was
 * applied from, by LIFO), but if validation ever fails the command returns
 * `history_invalid`, changes nothing, and leaves the stacks untouched
 * (§9.4, defensive).
 */

import type {
  Entity,
  Scene,
  TransformComponent,
} from '@thirdlight/project-model';

import {
  historyEmpty,
  historyInvalid,
  type CommandError,
} from './errors';
import {
  deepClone,
  gateResultScene,
  subtreeClosure,
  type OpSuccess,
} from './ops';
import type {
  ChangeData,
  DeleteEntityChange,
  ForwardChange,
  HistoryEntry,
  HistoryState,
  RestoreSubtreeChange,
  SetTransformChange,
} from './types';

/**
 * Apply a history entry's INVERSE (undo, §8.4/§9.1). `state` must be the
 * state AFTER the entry's forward command (the LIFO invariant). Returns
 * the applied result scene + the change data in the applied (inverse)
 * direction, or a `history_invalid` error on defensive failure.
 */
function applyInverse(
  scene: Scene,
  entry: HistoryEntry,
): { ok: true; scene: Scene; change: ChangeData } | { ok: false; error: CommandError } {
  const inv = entry.inverse;
  let nextEntities: Entity[] | null = null;
  let change: ChangeData;

  if (inv.kind === 'delete') {
    // Undo of a createEntity: subtree deletion at undo time. By LIFO no
    // later command exists when this entry is undone, so the closure is
    // exactly the created entity itself (the subtree form is normative
    // anyway, for uniformity).
    const closure = subtreeClosure(scene, inv.rootId);
    if (closure === null) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const closureSet = new Set(closure);
    nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
    const index = new Map(scene.entities.map((e, i) => [e.id, i]));
    const deletedIds = [...closure].sort(
      (a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0),
    );
    const c: DeleteEntityChange = { type: 'deleteEntity', rootId: inv.rootId, deletedIds };
    change = c;
  } else if (inv.kind === 'setTransform') {
    // Undo of a setTransform: restore the FULL previous transform (all
    // three fields — hence changedFields lists all three in canonical
    // order; pinned by scenarios/05 step 9).
    const index = scene.entities.findIndex((e) => e.id === inv.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as Entity;
    const restore: TransformComponent = {
      position: [...inv.restore.position],
      rotation: [...inv.restore.rotation],
      scale: [...inv.restore.scale],
    };
    const cloned = deepClone(current);
    const newEntity: Entity = {
      ...cloned,
      components: { ...cloned.components, transform: restore },
    };
    nextEntities = [...scene.entities];
    nextEntities[index] = newEntity;
    change = {
      type: 'setTransform',
      id: inv.id,
      previous: deepClone(current.components.transform),
      next: deepClone(restore),
      changedFields: ['position', 'rotation', 'scale'],
    };
  } else {
    // Undo of a deleteEntity: restore the subtree at the recorded
    // pre-deletion array indices (ascending ⇒ each index is still a valid
    // slot in the growing array; exactly reconstructs the pre-deletion
    // array, in particular the parent-before-child order).
    let ents: Entity[] = deepClone(scene.entities);
    for (const e of inv.entries) {
      if (
        typeof e.index !== 'number' ||
        !Number.isInteger(e.index) ||
        e.index < 0 ||
        e.index > ents.length
      ) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
      ents.splice(e.index, 0, deepClone(e.entity));
    }
    nextEntities = ents;
    const rootEntry = inv.entries[0];
    if (rootEntry === undefined) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    // Defensive consistency: the root's own parentId must match the
    // recorded restored parent (corruption ⇒ history_invalid).
    if ((rootEntry.entity.parentId ?? null) !== inv.restoredParentId) {
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    const c: RestoreSubtreeChange = {
      type: 'restoreSubtree',
      rootId: rootEntry.entity.id,
      entities: inv.entries.map((e) => deepClone(e.entity)),
    };
    change = c;
  }

  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  const gate = gateResultScene(scene, result);
  if (!gate.ok) return { ok: false, error: historyInvalid(entry.requestId) };
  return { ok: true, scene: gate.normalized, change };
}

/**
 * Re-apply a history entry's FORWARD change (redo, §8.4) using the
 * recorded values: a redo of a create re-inserts the recorded entity value
 * at the end of the array with its original ID (no ID re-scan); a redo of
 * a setTransform replaces the recorded fields with the recorded `next`
 * values; a redo of a delete removes the recorded `deletedIds`.
 */
function applyForward(
  scene: Scene,
  entry: HistoryEntry,
): { ok: true; scene: Scene; change: ChangeData } | { ok: false; error: CommandError } {
  const f = entry.change;
  const byId = new Map(scene.entities.map((e) => [e.id, e]));
  let nextEntities: Entity[];
  let change: ChangeData;

  if (f.type === 'createEntity') {
    if (byId.has(f.id)) {
      // The pre-state (LIFO) cannot already contain the created ID.
      return { ok: false, error: historyInvalid(entry.requestId) };
    }
    nextEntities = [...scene.entities, deepClone(f.entity)];
    change = { type: 'createEntity', id: f.id, entity: deepClone(f.entity) };
  } else if (f.type === 'setTransform') {
    const index = scene.entities.findIndex((e) => e.id === f.id);
    if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
    const current = scene.entities[index] as Entity;
    const next: TransformComponent = {
      position: [...f.next.position],
      rotation: [...f.next.rotation],
      scale: [...f.next.scale],
    };
    const cloned = deepClone(current);
    const newEntity: Entity = {
      ...cloned,
      components: { ...cloned.components, transform: next },
    };
    nextEntities = [...scene.entities];
    nextEntities[index] = newEntity;
    change = {
      type: 'setTransform',
      id: f.id,
      previous: deepClone(current.components.transform),
      next: deepClone(next),
      changedFields: [...f.changedFields],
    };
  } else {
    for (const id of f.deletedIds) {
      if (!byId.has(id)) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
    }
    const gone = new Set(f.deletedIds);
    nextEntities = scene.entities.filter((e) => !gone.has(e.id));
    change = { type: 'deleteEntity', rootId: f.rootId, deletedIds: [...f.deletedIds] };
  }

  const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
  const gate = gateResultScene(scene, result);
  if (!gate.ok) return { ok: false, error: historyInvalid(entry.requestId) };
  return { ok: true, scene: gate.normalized, change };
}

/**
 * Execute `undo` on the command state (§8.4/§9.1): requires `c > 0`,
 * applies `entries[c-1].inverse`, `c--`. Returns the new state + the
 * applied-direction change data, or a structured error.
 */
export function executeUndo(
  history: HistoryState,
  scene: Scene,
):
  | {
      ok: true;
      scene: Scene;
      history: HistoryState;
      change: ChangeData;
      appliedOf: string;
      originOfApplied: HistoryEntry['origin'];
    }
  | { ok: false; error: CommandError } {
  if (history.cursor === 0) {
    return { ok: false, error: { ...historyEmpty('undo') } };
  }
  const entry = history.entries[history.cursor - 1] as HistoryEntry;
  const applied = applyInverse(scene, entry);
  if (!applied.ok) return applied;
  return {
    ok: true,
    scene: applied.scene,
    history: {
      ...history,
      cursor: history.cursor - 1,
    },
    change: applied.change,
    appliedOf: entry.requestId,
    originOfApplied: entry.origin,
  };
}

/**
 * Execute `redo` on the command state (§8.4/§9.1): requires `c < n`,
 * re-applies `entries[c].change` forward (recorded values), `c++`.
 */
export function executeRedo(
  history: HistoryState,
  scene: Scene,
):
  | {
      ok: true;
      scene: Scene;
      history: HistoryState;
      change: ChangeData;
      appliedOf: string;
      originOfApplied: HistoryEntry['origin'];
    }
  | { ok: false; error: CommandError } {
  if (history.cursor >= history.entries.length) {
    return { ok: false, error: { ...historyEmpty('redo') } };
  }
  const entry = history.entries[history.cursor] as HistoryEntry;
  const applied = applyForward(scene, entry);
  if (!applied.ok) return applied;
  return {
    ok: true,
    scene: applied.scene,
    history: {
      ...history,
      cursor: history.cursor + 1,
    },
    change: applied.change,
    appliedOf: entry.requestId,
    originOfApplied: entry.origin,
  };
}

/**
 * Record a fresh forward edit (§9.1 table): truncate the redo tail
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

/** Empty initial history (a fresh process starts here, §9.2). */
export function createHistory(): HistoryState {
  return { entries: [], cursor: 0, seq: 1 };
}

