/**
 * Phase 24.8 (tests only): the character controls of a version 2 action
 * frame as the version 1 channels (`moveX`, `moveY`, `jump`) the input
 * tests assert — the inverse of `toActionFrame`. The `actions` map is kept
 * when it holds other actions too (then with `move` and `jump`), else dropped.
 */
import type { ActionFrame, ActionValue, JumpPhase } from '@thirdlight/runtime';

export type ChannelView = Omit<ActionFrame, 'actions'> & { moveX: number; moveY?: number; jump: JumpPhase; actions?: Readonly<Record<string, ActionValue>> };

export function channelView(frame: ActionFrame): ChannelView {
  const { actions, ...rest } = frame;
  const move = actions?.['move'];
  const jump = actions?.['jump'];
  const others: Record<string, ActionValue> = {};
  for (const [k, v] of Object.entries(actions ?? {})) if (k !== 'move' && k !== 'jump') others[k] = v;
  return {
    ...rest,
    moveX: move === undefined ? 0 : (move.x ?? move.v),
    ...(move?.y !== undefined ? { moveY: move.y } : {}),
    jump: jump?.p ?? 'none',
    ...(Object.keys(others).length > 0 && actions !== undefined ? { actions } : {}),
  };
}

/** A source whose `sample` returns the channel view (the other members are the source's own). */
export function viewSource<S extends { sample(stepIndex: number): ActionFrame }>(source: S): Omit<S, 'sample'> & { sample(stepIndex: number): ChannelView } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === 'sample') continue;
    // Live: a getter (`attached`) reads the source each time.
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => {
        const v = (source as unknown as Record<string, unknown>)[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(source) : v;
      },
    });
  }
  Object.defineProperty(out, 'sample', { enumerable: true, value: (n: number): ChannelView => channelView(source.sample(n)) });
  return out as unknown as Omit<S, 'sample'> & { sample(stepIndex: number): ChannelView };
}
