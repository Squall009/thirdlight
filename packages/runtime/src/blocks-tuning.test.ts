/**
 * The gameplay blocks read their tuning from the components, each
 * absent field at its default (`BLOCK_DEFAULTS`), including the mover push
 * tuning.
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { GameplayBlocks, type BlocksHost } from './blocks';
import type { TransformState } from './types';

const HZ = 120;
const T = (x: number, y: number, scale: [number, number, number] = [1, 1, 1]) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale });
const ent = (id: string, components: Record<string, unknown>, parentId?: string): EntityV3 => ({ id, ...(parentId !== undefined ? { parentId } : {}), components: { transform: T(0, 0), ...components } }) as unknown as EntityV3;

interface Harness {
  blocks: GameplayBlocks;
  character: { x: number; y: number };
}

function harness(entities: EntityV3[], o: { character?: { x: number; y: number }; skin?: number } = {}): Harness {
  const curr = new Map<string, TransformState>();
  for (const e of entities) {
    const t = e.components.transform;
    curr.set(e.id, { position: [...t.position] as [number, number, number], rotation: [...t.rotation] as [number, number, number, number], scale: [...t.scale] as [number, number, number] });
  }
  const h: Harness = { blocks: undefined as unknown as GameplayBlocks, character: o.character ?? { x: 100, y: 100 } };
  const host: BlocksHost = {
    hz: HZ,
    physics: undefined,
    curr,
    characterId: 'player-0001',
    characterCapsule: { radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0 } },
    character: () => h.character,
    groundEntityId: () => null,
    ...(o.skin !== undefined ? { characterSkin: o.skin } : {}),
  };
  h.blocks = new GameplayBlocks(host, entities);
  return h;
}

describe('mover push tuning', () => {
  /** A wide block rising into the player beside it (a sideways push), with its maxPush. */
  const push = (maxPush: number | undefined, skin?: number) => {
    const mover = ent('block-0001', { collider: { shape: { type: 'box', hx: 2, hy: 0.5 } }, mover: { waypoints: [[0, 2, 0]], speed: 2.4, mode: 'once', ...(maxPush !== undefined ? { maxPush } : {}) } });
    const h = harness([mover], { character: { x: -1, y: 0.2 }, ...(skin !== undefined ? { skin } : {}) });
    h.blocks.beforeStep(1);
    return h.blocks.carryDelta();
  };
  it('the push per step is maxPush over the step rate (default 60 m/s: 0.5 m at 120 Hz)', () => {
    expect(push(undefined).x).toBeCloseTo(-0.5, 12);
    expect(push(30).x).toBeCloseTo(-0.25, 12);
  });
  it('the gap it keeps is the character controller skin plus 1 mm', () => {
    // A player just outside the block's left edge (gap 0.02 m): no push with the default 0.011 m gap, a push with a 0.05 m skin.
    const edge = (skin?: number) => {
      const mover = ent('block-0001', { collider: { shape: { type: 'box', hx: 2, hy: 0.5 } }, mover: { waypoints: [[0, 2, 0]], speed: 2.4, mode: 'once' } });
      const h = harness([mover], { character: { x: -2 - 0.3 - 0.02, y: 0.2 }, ...(skin !== undefined ? { skin } : {}) });
      h.blocks.beforeStep(1);
      return h.blocks.carryDelta().x;
    };
    expect(edge()).toBe(0);
    expect(edge(0.05)).toBeLessThan(0);
  });
});
