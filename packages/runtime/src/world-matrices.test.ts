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

  it('composes a parent chain of any depth in full (a deep chain is not cut into a root), the same as the runtime', () => {
    const w = new WorldMatrices();
    const depth = 150;
    const t = new Map<string, { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }>();
    for (let k = 0; k < depth; k += 1) {
      // Children first: the table resolves parents whatever the row order.
      w.add(`n${depth - 1 - k}`, depth - 1 - k === 0 ? null : `n${depth - 2 - k}`);
    }
    for (let k = 0; k < depth; k += 1) t.set(`n${k}`, { position: [1, 0, 0.5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    for (const [id, s] of t) w.setLocal(id, s.position, s.rotation, s.scale);
    w.update();
    const p: number[] = [];
    w.position(`n${depth - 1}`, p);
    near(p, [depth, 0, depth * 0.5]);
    const parentOf = (id: string): string | null => (id === 'n0' ? null : `n${Number(id.slice(1)) - 1}`);
    near(worldTransformOf(`n${depth - 1}`, t, parentOf)!.position, [depth, 0, depth * 0.5]);
    expect(w.cycles).toBe(0);
  });

  it('a parent cycle (no valid scene has one) is cut where it closes and reported, never hangs', () => {
    const w = new WorldMatrices();
    w.add('a', 'c');
    w.add('b', 'a');
    w.add('c', 'b');
    for (const id of ['a', 'b', 'c']) w.setLocal(id, [1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const errors: unknown[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      w.update();
    } finally {
      console.error = was;
    }
    expect(w.cycles).toBe(1);
    expect(errors).toHaveLength(1);
    const t = new Map(['a', 'b', 'c'].map((id) => [id, { position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] }]));
    const parentOf = (id: string): string => ({ a: 'c', b: 'a', c: 'b' })[id]!;
    expect(() => worldTransformOf('a', t, parentOf)).toThrow(/loops/);
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

  it('composes only what moved: an idle table composes nothing, a moved parent its subtree', () => {
    const w = new WorldMatrices();
    w.add('root', null);
    w.add('kid', 'root');
    w.add('other', null);
    w.update();
    expect(w.changedCount).toBe(3);
    // The same values again: nothing to compose.
    for (const id of ['root', 'kid', 'other']) w.setLocal(id, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    w.update();
    expect(w.changedCount).toBe(0);
    w.setLocal('root', [1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    w.update();
    const changed = Array.from({ length: w.changedCount }, (_, k) => w.changedId(k)).sort();
    expect(changed).toEqual(['kid', 'root']);
    const p: number[] = [];
    w.position('kid', p);
    near(p, [1, 0, 0]);
    // Re-parenting moves the row's world too.
    w.add('kid', 'other');
    w.update();
    expect(Array.from({ length: w.changedCount }, (_, k) => w.changedId(k))).toEqual(['kid']);
    w.position('kid', p);
    near(p, [0, 0, 0]);
    w.update();
    expect(w.changedCount).toBe(0);
  });
});
