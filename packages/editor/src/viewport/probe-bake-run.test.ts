import { describe, expect, it } from 'vitest';

import { sameTurn, seamBounds } from './probe-bake-run';
import type { ProjectedEntity } from '../session/projection';

describe('probe staleness', () => {
  it('a sky turned by a whole turn (or to the same direction the other way round) leaves the probes fresh', () => {
    expect(sameTurn(0, 360)).toBe(true);
    expect(sameTurn(180, -180)).toBe(true);
    expect(sameTurn(-90, 270)).toBe(true);
    expect(sameTurn(10, 10)).toBe(true);
    expect(sameTurn(10, 11)).toBe(false);
    expect(sameTurn(0, 359.5)).toBe(false);
  });
});

describe('probe tiles over a block area on terrain', () => {
  const terrain = (layers: unknown[], active = true): ProjectedEntity => ({ id: 't', active, components: { terrain: { layers } } }) as unknown as ProjectedEntity;
  const box = { min: [0, 0, 0], max: [100, 10, 100] };
  it('grow past the area as far as the terrain blends its ground to it, and down as far', () => {
    expect(seamBounds(box, [terrain([{ id: 'b', kind: 'blocks', blend: 6 }])], 2)).toEqual({ min: [-8, -6, -8], max: [108, 10, 108] });
    // The default blend (8 m), the widest of several.
    expect(seamBounds(box, [terrain([{ id: 'b', kind: 'blocks' }]), terrain([{ id: 'c', kind: 'blocks', blend: 3 }])], 1)).toEqual({ min: [-9, -8, -9], max: [109, 10, 109] });
  });
  it('stay as they are without a blocks layer that applies', () => {
    expect(seamBounds(box, [terrain([{ id: 's', kind: 'stamps', stamps: [] }])], 2)).toBe(box);
    expect(seamBounds(box, [terrain([{ id: 'b', kind: 'blocks', enabled: false }])], 2)).toBe(box);
    expect(seamBounds(box, [terrain([{ id: 'b', kind: 'blocks' }], false)], 2)).toBe(box);
    expect(seamBounds(null, [terrain([{ id: 'b', kind: 'blocks' }])], 2)).toBeNull();
  });
});
