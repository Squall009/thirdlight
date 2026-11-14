import { describe, expect, it } from 'vitest';

import { GpuPassHides } from './gpu-pass-hides';

function pass(category: 'near' | 'far' | 'lighting', name: string, present = true) {
  const p = { category, name, hidden: false, calls: 0, present: () => present, hide: (h: boolean) => void ((p.hidden = h), (p.calls += 1)) };
  return p;
}

describe('GPU pass hides', () => {
  it('hides exactly the categories asked, shows the rest, and calls a pass only when its state changes', () => {
    const r = new GpuPassHides();
    const near = pass('near', 'near');
    const far = pass('far', 'far');
    const light = pass('lighting', 'surface light');
    for (const p of [near, far, light]) r.register(p);
    r.set(['lighting']);
    expect([near.hidden, far.hidden, light.hidden]).toEqual([false, false, true]);
    expect([near.calls, far.calls]).toEqual([0, 0]);
    r.set(['near', 'lighting']);
    expect([near.hidden, light.hidden, light.calls]).toEqual([true, true, 1]);
    expect(r.hidden().sort()).toEqual(['lighting', 'near']);
    r.set([]);
    expect([near.hidden, far.hidden, light.hidden]).toEqual([false, false, false]);
  });

  it('lists only present passes by category and hides a pass that registers while its category is hidden', () => {
    const r = new GpuPassHides();
    r.register(pass('near', 'chunks'));
    r.register(pass('far', 'bricks', false));
    expect(r.present()).toEqual({ near: ['chunks'] });
    r.set(['far']);
    const late = pass('far', 'late');
    const off = r.register(late);
    expect(late.hidden).toBe(true);
    off();
    r.set([]);
    // Taken out: not shown again by the registry, not listed.
    expect(late.hidden).toBe(true);
    expect(r.present()).toEqual({ near: ['chunks'] });
  });

  it('a hide that throws leaves nothing hidden and the error goes on', () => {
    const r = new GpuPassHides();
    const near = pass('near', 'near');
    const bad = { category: 'lighting' as const, name: 'bad', present: () => true, hide: (h: boolean) => { if (h) throw new Error('no'); } };
    r.register(near);
    r.register(bad);
    r.set(['near']);
    expect(near.hidden).toBe(true);
    expect(() => r.set(['near', 'lighting'])).toThrow('no');
    expect(near.hidden).toBe(false);
    expect(r.hidden()).toEqual([]);
    // A pass whose show throws does not stop the others being shown.
    const shy = { category: 'far' as const, name: 'shy', present: () => true, hide: (h: boolean) => { if (!h) throw new Error('stuck'); } };
    r.register(shy);
    r.set(['near', 'far']);
    r.showAll();
    expect(near.hidden).toBe(false);
  });
});
