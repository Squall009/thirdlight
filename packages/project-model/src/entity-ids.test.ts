/** The assigned entity ids (six digits; the project's entity capacity bounds N). */
import { describe, expect, it } from 'vitest';
import { ENTITY_ID_DIGITS, ENTITY_ID_MAX, entityIdAt, nextFreeEntityIdOf } from './entity-ids';
import { MAX_SCENES } from './content';
import { MAX_ENTITIES_V4 } from './scene-v3';

describe('entity ids', () => {
  it('are written with at least six digits and run to the project entity capacity', () => {
    expect(ENTITY_ID_DIGITS).toBe(6);
    expect(entityIdAt('box', 1)).toBe('box-000001');
    expect(entityIdAt('box', 999_999)).toBe('box-999999');
    expect(entityIdAt('box', 1_000_000)).toBe('box-1000000');
    // Every entity a project can hold has an id of each prefix left for it.
    expect(ENTITY_ID_MAX).toBe(MAX_SCENES * MAX_ENTITIES_V4);
  });

  it('pick the smallest free number; old four-digit ids are other strings', () => {
    expect(nextFreeEntityIdOf(new Set(['box-0001', 'box-0002']), 'box')).toBe('box-000001');
    expect(nextFreeEntityIdOf(new Set(['box-000001', 'box-000003']), 'box')).toBe('box-000002');
  });

  it('say undefined only when every number up to the capacity is taken', () => {
    let asked = 0;
    const all = { has: (): boolean => ((asked += 1), true) };
    expect(nextFreeEntityIdOf(all, 'box')).toBeUndefined();
    expect(asked).toBe(ENTITY_ID_MAX);
  });
});
