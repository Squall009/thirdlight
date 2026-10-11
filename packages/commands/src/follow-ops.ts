/**
 * Components written because of a command, in the same transaction: a
 * terrain shaped again by the splines the command added, moved, changed or
 * removed, a spline's made mesh and pieces (the project host's), and a baked
 * decal's object turning into a model of the baked file (the publish's own).
 *
 * The host plans its follow-ups after the command's own change (it reads and
 * publishes blobs, which the pure layer cannot), then hands them here; an op
 * that writes components besides its own change returns them with it. The
 * scene takes the new values, the history entry keeps each component's
 * value before and after, and the change names them so clients take the new
 * values. Undo puts the "before" values back ahead of the command's own
 * inverse; redo puts the "after" values back once the command is re-applied.
 * Neither re-plans: the values are what the command made.
 */
import { gateResultState } from './ops';
import type { CommandState, HistoryEntry, MutationSuccess, SceneDocument } from './types';

/** The components a follow-up can write. */
export type FollowedComponent = 'terrain' | 'spline' | 'decal' | 'model';

/** One component written with a command (null: absent). */
export interface ComponentFollow {
  entityId: string;
  component: FollowedComponent;
  restore: unknown;
  next: unknown;
}

/** What a change names of its follow-ups (clients take the values). */
export interface FollowChange {
  entityId: string;
  component: FollowedComponent;
  next: unknown;
}

type AnyEntity = { id: string; components: Record<string, unknown> };

/** The scene with each follow-up's `restore` (undo) or `next` (redo) value put in. */
export function withFollows<S extends SceneDocument>(scene: S, follows: readonly ComponentFollow[], side: 'restore' | 'next'): S {
  const byId = new Map(follows.map((f) => [f.entityId, f]));
  const list = side === 'restore' ? [...follows].reverse() : follows;
  if (list.length === 0) return scene;
  const entities = (scene.entities as unknown as AnyEntity[]).map((e) => {
    if (!byId.has(e.id)) return e;
    const components = { ...e.components };
    for (const f of list) {
      if (f.entityId !== e.id) continue;
      const v = f[side];
      if (v === null || v === undefined) delete components[f.component];
      else components[f.component] = structuredClone(v);
    }
    return { ...e, components };
  });
  return { ...scene, entities } as unknown as S;
}

/** The change with its follow-ups named (after any it names already: an op's own come before the host's). */
export function withFollowChange<C>(change: C, follows: readonly ComponentFollow[]): C {
  const named = (change as { follows?: readonly FollowChange[] }).follows ?? [];
  return { ...change, follows: [...named, ...follows.map((f): FollowChange => ({ entityId: f.entityId, component: f.component, next: f.next }))] };
}

/**
 * Put the host's follow-ups of the command just applied (the last history
 * entry) into its state and result. The resulting scene is validated as
 * a command's is.
 */
export function applyFollows<S extends SceneDocument>(state: CommandState<S>, result: MutationSuccess, follows: readonly ComponentFollow[]): { ok: true; state: CommandState<S>; result: MutationSuccess } | { ok: false; error: import('./errors').CommandError } {
  if (follows.length === 0) return { ok: true, state, result };
  const scene = withFollows(state.scene, follows, 'next');
  const gate = gateResultState({ scene: state.scene, ...(state.content !== undefined ? { content: state.content } : {}), ...(state.manifest !== undefined ? { manifest: state.manifest } : {}) }, scene, state.content);
  if (!gate.ok) return gate;
  const h = state.history;
  const last = h.entries[h.cursor - 1] as HistoryEntry | undefined;
  if (last === undefined) return { ok: true, state, result };
  const entry: HistoryEntry = { ...last, follows: [...(last.follows ?? []), ...follows] };
  const entries = [...h.entries];
  entries[h.cursor - 1] = entry;
  return {
    ok: true,
    state: { ...state, scene: gate.scene as S, history: { ...h, entries } },
    result: { ...result, change: withFollowChange(result.change, follows) },
  };
}
