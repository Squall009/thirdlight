/**
 * A streamed block layer on the 2D plane: its collision ring is measured on
 * the play plane (x and y), where the game is played, not across the ground
 * (x and z) as in 3D. A tall layer's chunks collide round a source within
 * the layer's height and not round one far above it, a source off the plane
 * in z (a side view's camera) still counts, and moving only in y looks at
 * the ring again.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, type BlockLayerComponent, type BlockType, type EntityV3 } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';
import type { PhysicsPort, StaticColliderSpec } from './ports';
import { STREAM_RECHECK_METRES } from './world-stream';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const TYPES: BlockType[] = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];
/** 8 chunks of 1 m cells along x, 64 m tall, two rows deep round the plane z = 1; collision 20 m, hysteresis 4 m. */
const COMP: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [128, 64, 2] }, planeZ: 1, streaming: { render: 64, collision: 20, hysteresis: 4 } };

function layer(id: string): EntityV3 {
  const g = new BlockGrid(COMP);
  // Ground along the whole layer and a ledge near its top.
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 128, 1, 2], cell: { block: 'stone' } }, { kind: 'fill', box: [0, 60, 0, 128, 61, 2], cell: { block: 'stone' } }] as never, { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
  const data = g.toData(id, null, g.takeDirty().chunks);
  return { id, components: { transform: T, blockLayer: { ...COMP, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}

function port(): PhysicsPort & { live: Set<string> } {
  const live = new Set<string>();
  return {
    live,
    addStaticColliders: (specs: readonly StaticColliderSpec[]) => {
      for (const s of specs) live.add(s.entityId);
    },
    removeStaticColliders: (ids: readonly string[]) => {
      for (const id of ids) live.delete(id);
    },
  } as unknown as PhysicsPort & { live: Set<string> };
}

const chunksOf = (p: { live: Set<string> }): string[] => [...new Set([...p.live].map((c) => c.split(':')[1]!))].sort();

describe('a streamed block layer on the 2D plane', () => {
  it('measures its collision ring on the plane: x and y, not z', () => {
    // A 2D project: no 3D collision, the 2D port takes the cut.
    const at = [[6, 200, 1]];
    const grid = new RuntimeGrid(TYPES, [], false, 45, undefined, undefined, undefined, () => at);
    const p = port();
    grid.addLayers([layer('g')]);
    // As the runtime does at the load: the first flush, before any step.
    grid.flushCollision(undefined, p);
    grid.beginStep(1);
    grid.flushCollision(undefined, p);
    // 136 m above the layer's top (64 m): nothing, though the source is over chunk 0 along x.
    expect(chunksOf(p)).toEqual([]);
    // Falling to y 30 inside the layer's height (a move in y alone): chunks within 24 m along x, 0 and 1.
    at[0] = [6, 30, 1];
    grid.beginStep(2);
    grid.flushCollision(undefined, p);
    expect(chunksOf(p)).toEqual(['0,0', '1,0']);
    // A source 39 m in front of the layer (a side view's camera), further than the ring reaches, is as near as one on it.
    at[0] = [50, 30, 41];
    expect(41 - 2).toBeGreaterThan(20 + STREAM_RECHECK_METRES + 4);
    for (let s = 3; s < 8; s++) {
      grid.beginStep(s);
      grid.flushCollision(undefined, p);
    }
    expect(chunksOf(p)).toEqual(['1,0', '2,0', '3,0', '4,0']);
  });
});
