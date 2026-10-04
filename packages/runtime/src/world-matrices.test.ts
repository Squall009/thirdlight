import { describe, expect, it } from 'vitest';

import { WorldMatrices } from './world-matrices';
import { worldTransformOf } from './world-transform';

const near = (a: ArrayLike<number>, b: ArrayLike<number>): void => {
  for (let i = 0; i < b.length; i += 1) expect(a[i]).toBeCloseTo(b[i]!, 9);
};

describe('WorldMatrices', () => {
  it('composes children over parents in any row order, as the runtime composes a world transform', () => {
    const w = new WorldMatrices();
    // The child is added first: rows are not in parent order.
    w.add('child', 'parent');
    w.add('parent', null);
    const t = new Map([
      ['parent', { position: [1, 2, 3] as [number, number, number], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number], scale: [2, 2, 2] as [number, number, number] }],
      ['child', { position: [0, 0, 1] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }],
    ]);
    for (const [id, s] of t) w.setLocal(id, s.position, s.rotation, s.scale);
    w.update();
    const expected = worldTransformOf('child', t, (id) => (id === 'child' ? 'parent' : null))!;
    const p: number[] = [];
    expect(w.position('child', p)).toBe(true);
    near(p, expected.position);
    // A quarter turn about +Y moves the child's +Z to +X, twice as far.
    near(p, [3, 2, 3]);
  });

  it('reuses removed rows and treats a parent that left as a root', () => {
    const w = new WorldMatrices();
    w.add('a', null);
    const b = w.add('b', 'a');
    w.setLocal('a', [5, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    w.setLocal('b', [0, 1, 0], [0, 0, 0, 1], [1, 1, 1]);
    w.remove('a');
    w.update();
    const p: number[] = [];
    w.position('b', p);
    near(p, [0, 1, 0]);
    expect(w.add('c', null)).not.toBe(b);
    expect(w.indexOf('a')).toBeUndefined();
  });
});
