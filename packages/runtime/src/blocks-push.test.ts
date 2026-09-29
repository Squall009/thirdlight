/**
 * A mover that moves into the player pushes it out. A mover moving
 * mostly upward pushes a player beside or under it (the capsule's centre below
 * the mover's top) sideways, away from the mover — never up; only a player
 * above it is scooped up. Other movers keep the shallower-axis push.
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { GameplayBlocks, type BlocksHost } from './blocks';
import type { TransformState } from './types';

const HZ = 120;

/** One step of a wide block (half 2 × 0.5) moving by `move` per step, the player (default capsule) at `player`. */
function pushOf(move: [number, number], player: { x: number; y: number }, shape: Record<string, unknown> = { type: 'box', hx: 2, hy: 0.5 }): { x: number; y: number } {
  const speed = Math.hypot(move[0], move[1]) * HZ;
  const entity = {
    id: 'block-0001',
    components: {
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      collider: { shape },
      mover: { waypoints: [[move[0] * 100, move[1] * 100, 0]], speed, mode: 'once' },
    },
  } as unknown as EntityV3;
  const curr = new Map<string, TransformState>([['block-0001', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]]);
  const host: BlocksHost = {
    hz: HZ,
    physics: undefined,
    curr,
    characterId: 'player-0001',
    characterCapsule: { radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0 } },
    character: () => player,
    groundEntityId: () => null,
  };
  const blocks = new GameplayBlocks(host, [entity]);
  blocks.beforeStep(1);
  return blocks.carryDelta();
}

describe('a moving block pushes the player out of it', () => {
  // The player's capsule box (half 0.3 × 0.9) sits 1 m inside the block's
  // left end, its centre 0.3 m under the block's top: the vertical overlap
  // (1.1 m) is shallower than the horizontal one (1.3 m).
  const inside = { x: -1, y: 0.2 };

  it('rising: sideways, away from the block, never up (the centre is below its top)', () => {
    const p = pushOf([0, 0.02], inside);
    expect(p.y).toBe(0);
    expect(p.x).toBeCloseTo(-0.5, 9); // capped at 0.5 m per step, to the left (the player is left of the centre)
  });

  it('rising with a player above its top: scooped up', () => {
    // Centre 0.1 m over the top after the move; the feet 0.8 m inside.
    const p = pushOf([0, 0.02], { x: -1, y: 0.62 });
    expect(p.x).toBe(0);
    expect(p.y).toBeGreaterThan(0);
  });

  it('moving mostly sideways: the shallower axis, as before', () => {
    const p = pushOf([0.02, 0.01], inside);
    expect(p.x).toBe(0);
    expect(p.y).toBeCloseTo(0.5, 9); // the capped push along the shallower (vertical) axis
  });
});

describe('phase 25.4: a polygon mover pushes by the same rule', () => {
  const rect = { type: 'polygon', vertices: [[-2, -0.5], [2, -0.5], [2, 0.5], [-2, 0.5]] };
  it('the same rectangle as a polygon pushes exactly as the box', () => {
    for (const [move, player] of [[[0, 0.02], { x: -1, y: 0.2 }], [[0, 0.02], { x: -1, y: 0.62 }], [[0.02, 0.01], { x: -1, y: 0.2 }], [[-0.02, 0], { x: -2.2, y: 0.5 }]] as const) {
      const box = pushOf([move[0], move[1]], player);
      const poly = pushOf([move[0], move[1]], player, rect);
      expect(poly.x).toBeCloseTo(box.x, 9);
      expect(poly.y).toBeCloseTo(box.y, 9);
    }
  });

  it('a ramp pushes only where it is: its exact extent beside the character, not its bounding box', () => {
    // A right triangle rising to the right (0,0)-(4,0)-(4,2) moving left 0.02; the character's box beside the low end.
    const ramp = { type: 'polygon', vertices: [[0, 0], [4, 0], [4, 2]] };
    // Centre at (0.5, 1.4): its box (x 0.19..0.81, y from 0.49) is above the slope there (height ≤ 0.41 at x ≤ 0.81), inside the bounding box: no push.
    expect(pushOf([-0.02, 0], { x: 0.5, y: 1.4 }, ramp)).toEqual({ x: 0, y: 0 });
    // Centre at (3.9, 1.0): deep in the ramp's tall end: pushed.
    const p = pushOf([-0.02, 0], { x: 3.9, y: 1.0 }, ramp);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0);
  });
});
