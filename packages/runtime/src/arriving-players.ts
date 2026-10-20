/**
 * Player controllers that arrive while the game runs. A game needs no player
 * at its start: a scene loaded later may bring one. A new
 * player gets its physics character, its placement and its place among the
 * characters movers carry and triggers test, all where its object is; the
 * character modules then add it themselves (`sceneLoaded`). A player that
 * comes back with its scene (it was unloaded with it) is placed again where
 * the scene puts it, from rest, as a respawn would.
 */
import type { EntityV3 } from '@thirdlight/project-model';

import { blocksCharacterOf, type GameplayBlocks } from './blocks';
import type { ControllerPlacements } from './character-placement';
import type { PhysicsPort, PhysicsPort3D } from './ports';
import type { PlayerControllers } from './player-controllers';
import type { TransformState } from './types-simulation';

export interface ArrivingPlayersHost {
  readonly controllers: PlayerControllers;
  readonly placement: ControllerPlacements;
  readonly blocks: GameplayBlocks | null;
  readonly threeD: boolean;
  /** An object's transform this step. */
  transform(id: string): TransformState | undefined;
}

/**
 * Why entities cannot come into the game for the players they bring (a new
 * player needs a port that adds characters), or null. The load is refused
 * then, as a scene whose colliders the port cannot take.
 */
export function arrivalProblem(entities: readonly EntityV3[], controllers: PlayerControllers, port: PhysicsPort | PhysicsPort3D | undefined): string | null {
  const player = entities.find((e) => (e.components as { controller?: unknown }).controller !== undefined && !controllers.has(e.id));
  if (player === undefined || typeof port?.addCharacter === 'function') return null;
  return `entity "${player.id}" is a player controller and ${port === undefined ? 'the game has no physics port' : 'the physics port cannot add a character'}`;
}

/**
 * The player controllers among attached entities. `placeReturning`: one
 * that is a player already is placed where its object now is (a start
 * scene's reload keeps its own rules, so it passes false). Throws a port
 * failure.
 */
export function playersArrive(entities: readonly EntityV3[], host: ArrivingPlayersHost, placeReturning: boolean): void {
  for (const e of entities) {
    if ((e.components as { controller?: unknown }).controller === undefined) continue;
    if (host.controllers.add(e)) {
      host.placement.add(e.id);
      host.blocks?.addCharacter(blocksCharacterOf(e, host.threeD));
      continue;
    }
    const t = placeReturning ? host.transform(e.id) : undefined;
    if (t !== undefined) host.placement.of(e.id)?.requestRespawn([t.position[0], t.position[1], t.position[2]]);
  }
}
