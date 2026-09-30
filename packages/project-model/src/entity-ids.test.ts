/** The assigned entity ids (six digits; no project bound on N). */
import { describe, expect, it } from 'vitest';
import { ENTITY_ID_DIGITS, ENTITY_ID_MAX, entityIdAt, nextFreeEntityIdOf } from './entity-ids';

describe('entity ids', () => {
  it('are written with at least six digits and more past a million', () => {
    expect(ENTITY_ID_DIGITS).toBe(6);
    expect(entityIdAt('box', 1)).toBe('box-000001');
    expect(entityIdAt('box', 999_999)).toBe('box-999999');
    expect(entityIdAt('box', 1_000_000)).toBe('box-1000000');
    expect(ENTITY_ID_MAX).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('pick the smallest free number; old four-digit ids are other strings', () => {
    expect(nextFreeEntityIdOf(new Set(['box-0001', 'box-0002']), 'box')).toBe('box-000001');
    expect(nextFreeEntityIdOf(new Set(['box-000001', 'box-000003']), 'box')).toBe('box-000002');
  });

  it('find a free number past what 64 scenes of 16,384 entities used to allow', () => {
    const taken = 1_100_000;
    const all = { has: (id: string): boolean => Number(id.slice(4)) <= taken };
    expect(nextFreeEntityIdOf(all, 'box')).toBe('box-1100001');
  });
});
