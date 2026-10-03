/**
 * `ctx.game`: the run's named counters, the character's health and object
 * visibility, over the gameplay blocks. A counter name the save loader would
 * refuse is refused here too (one rule, project-model's), so a counter a
 * script makes always survives a save and a load.
 */
import { COUNTER_NAME_RULE, isCounterName } from '@thirdlight/project-model';

import type { GameplayBlocks } from './blocks';
import type { BehaviorGameState } from './types';

export interface GameControlHost {
  /** The gameplay blocks now (null before the run has them). */
  blocks(): GameplayBlocks | null;
  /** Whether an entity is in the game now. */
  has(entityId: string): boolean;
  /** One Problems line. */
  warn(message: string): void;
}

export function createGameControl(host: GameControlHost): BehaviorGameState {
  // Each refused name is reported once a run: a script adding every step would flood the log.
  const reported = new Set<string>();
  return Object.freeze({
    counter: (name: string): number => host.blocks()?.counter(String(name)) ?? 0,
    add: (name: unknown, amount: number): boolean => {
      if (!isCounterName(name)) {
        const key = typeof name === 'string' ? name.slice(0, 64) : `(${typeof name})`;
        if (!reported.has(key)) {
          reported.add(key);
          host.warn(`ctx.game.add: counter ${JSON.stringify(key)} refused (${COUNTER_NAME_RULE}); a save could not bring it back`);
        }
        return false;
      }
      return host.blocks()?.addCounter(name, Number(amount)) ?? false;
    },
    health: (entityId?: string): { current: number; max: number } | null => (entityId === undefined || typeof entityId === 'string' ? (host.blocks()?.healthView(entityId) ?? null) : null),
    setVisible: (entityId: string, visible: boolean): void => {
      if (typeof entityId === 'string' && host.has(entityId)) host.blocks()?.setVisible(entityId, visible === true);
    },
  });
}
