/**
 * A script's walk options turned into the walk graph's: the walker's radius as its footprint's span, the default the
 * engine's default character's, which is the walker the graph's pieces are made for.
 */
import { DEFAULT_CONTROLLER_CAPSULE } from '@thirdlight/project-model';
import { DEFAULT_WALK_AGENT } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

import { DEFAULT_WALK_RADIUS_M, walkOptionsOf, walkPoints } from './voxel-paths';

describe('walk options', () => {
  it('takes the default character\'s radius by default, and it is the walker the levels are made for', () => {
    expect(DEFAULT_WALK_RADIUS_M).toBe(DEFAULT_CONTROLLER_CAPSULE.radius);
    expect(walkOptionsOf({})!.span).toBe(DEFAULT_WALK_AGENT.span);
  });

  it('turns a radius into the cells its disc fits in; refuses one past a metre or not positive', () => {
    expect([0.2, 0.25, 0.3, 0.4, 0.5, 0.7, 0.75, 1].map((r) => walkOptionsOf({ radius: r })!.span)).toEqual([1, 1, 2, 2, 2, 3, 3, 4]);
    for (const r of [0, -1, 1.2, Number.NaN]) expect(walkOptionsOf({ radius: r })).toBeNull();
  });

  it('puts an even span\'s waypoints on its cells\' corners', () => {
    const cells = Int32Array.from([0, 2, 0, 1, 2, 0, 2, 2, 0]);
    expect(walkPoints(cells)).toEqual([[0.25, 1, 0.25], [1.25, 1, 0.25]]);
    expect(walkPoints(cells, 0.5)).toEqual([[0.5, 1, 0.5], [1.5, 1, 0.5]]);
  });
});
