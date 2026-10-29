import { describe, expect, it } from 'vitest';

import { selectSceneLights, type SceneLightEntry } from './scene-lights';

const e = (id: string, kind: SceneLightEntry['kind'], rank: number, order: number): SceneLightEntry => ({ id, kind, rank, order });

describe('selectSceneLights', () => {
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
  it('every point and spot light of the loaded scenes is on, however many', () => {
    const entries: SceneLightEntry[] = [];
    let order = 0;
    for (let i = 0; i < 100; i++) entries.push(e(`a${i}`, 'point', 0, order++));
    for (let i = 0; i < 100; i++) entries.push(e(`b${i}`, i % 2 === 0 ? 'point' : 'spot', 1, order++));
    const sel = selectSceneLights(entries);
    expect(sel.localTotal).toBe(200);
    expect(entries.every((x) => sel.active.has(x.id))).toBe(true);
  });
});
