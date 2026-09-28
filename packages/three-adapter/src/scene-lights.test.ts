import { describe, expect, it } from 'vitest';

import { LOCAL_LIGHT_BUDGET, selectSceneLights, type SceneLightEntry } from './scene-lights';

const e = (id: string, kind: SceneLightEntry['kind'], rank: number, order: number): SceneLightEntry => ({ id, kind, rank, order });

describe('selectSceneLights (phase 25.8)', () => {
  it('the most recently loaded scene holding a kind has its light on, each kind on its own', () => {
    const sel = selectSceneLights([
      e('sun-a', 'directional', 0, 0),
      e('fill-a', 'ambient', 0, 1),
      e('sun-b', 'directional', 1, 2),
      e('sky-b', 'hemisphere', 1, 3),
    ]);
    expect(sel.directional).toBe('sun-b');
    expect(sel.ambient).toBe('fill-a'); // b holds no ambient light: a's stays on
    expect(sel.hemisphere).toBe('sky-b');
    expect([...sel.active].sort()).toEqual(['fill-a', 'sky-b', 'sun-b']);
  });
  it('the previous scene comes back when the newer one is gone', () => {
    const sel = selectSceneLights([e('sun-a', 'directional', 0, 0), e('fill-a', 'ambient', 0, 1)]);
    expect(sel.directional).toBe('sun-a');
    expect(sel.active.has('sun-a')).toBe(true);
  });
  it('lights in no known scene rank below every loaded scene; ties keep document order', () => {
    expect(selectSceneLights([e('x', 'directional', -1, 0), e('y', 'directional', 0, 1)]).directional).toBe('y');
    expect(selectSceneLights([e('x', 'directional', 2, 0), e('y', 'directional', 2, 1)]).directional).toBe('x');
    expect(selectSceneLights([]).directional).toBeNull();
  });
  it('point and spot lights of all loaded scenes share the budget; the most recent scenes win', () => {
    const entries: SceneLightEntry[] = [];
    let order = 0;
    for (let i = 0; i < 10; i++) entries.push(e(`a${i}`, 'point', 0, order++));
    for (let i = 0; i < 12; i++) entries.push(e(`b${i}`, i % 2 === 0 ? 'point' : 'spot', 1, order++));
    const sel = selectSceneLights(entries);
    expect(sel.localTotal).toBe(22);
    expect(sel.localOn).toBe(LOCAL_LIGHT_BUDGET);
    for (let i = 0; i < 12; i++) expect(sel.active.has(`b${i}`)).toBe(true);
    expect([0, 1, 2, 3].every((i) => sel.active.has(`a${i}`))).toBe(true);
    expect([4, 5, 6, 7, 8, 9].some((i) => sel.active.has(`a${i}`))).toBe(false);
  });
});
