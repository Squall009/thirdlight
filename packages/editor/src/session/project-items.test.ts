import { describe, expect, it } from 'vitest';

import { freeItemId, idFromName } from './project-items';

describe('a new item\'s id', () => {
  it('comes from its name in the id syntax, or the fallback when the name has none', () => {
    expect(idFromName('Main HUD', 'ui')).toBe('main-hud');
    expect(idFromName('  !!!  ', 'ui')).toBe('ui');
    expect(idFromName('Water_2 (copy)', 'material')).toBe('water_2-copy');
    expect(idFromName('x'.repeat(80), 'g')).toHaveLength(56);
  });

  it('is numbered past every id the index already has, asking in batches', async () => {
    const taken = new Set(['effect', ...Array.from({ length: 70 }, (_, i) => `effect-${i + 2}`)]);
    const asked: number[] = [];
    const id = await freeItemId('Effect', 'fx', async (ids) => {
      asked.push(ids.length);
      return new Set(ids.filter((x) => taken.has(x)));
    });
    expect(id).toBe('effect-72');
    // Two batches of candidates, never one lookup per candidate.
    expect(asked).toEqual([64, 64]);
    expect(await freeItemId('Fresh', 'fx', async () => new Set())).toBe('fresh');
  });
});
