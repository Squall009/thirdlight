import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { RuntimeSplines } from './splines';

const road = (id: string, position: number[]): EntityV3 =>
  ({ id, components: { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, spline: { points: [{ at: [0, 0, 0] }, { at: [50, 0, 0], width: 10 }, { at: [100, 5, 0] }], width: 6 } } }) as unknown as EntityV3;

describe('ctx.splines', () => {
  it('reads loaded splines in the world: length, a pose along, the nearest place; unloaded ones are gone', () => {
    const s = new RuntimeSplines();
    s.add([road('road-1', [10, 2, 0])]);
    const api = s.api;
    expect(api.length('road-1')!).toBeGreaterThan(100);
    expect(api.length('nope')).toBeNull();
    const p = api.at('road-1', 0)!;
    expect(p.position).toEqual([10, 2, 0]);
    expect(p.width).toBe(6);
    expect(p.tangent[0]).toBeGreaterThan(0.9);
    // Going +x, right is +z.
    expect(p.right[2]).toBeCloseTo(1, 1);
    const n = api.nearest('road-1', [60, 30, 4], { level: true })!;
    expect(n.offset).toBeCloseTo(4, 0);
    expect(n.distance).toBeGreaterThan(49);
    expect(api.at('road-1', Number.NaN)).toBeNull();
    s.remove(new Set(['road-1']));
    expect(api.at('road-1', 1)).toBeNull();
  });
});
