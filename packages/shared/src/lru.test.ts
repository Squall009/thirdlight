import { describe, expect, it } from 'vitest';
import { LruCache } from './lru';

describe('LruCache', () => {
  it('drops the least recently used entry beyond its bound; get and set refresh, peek does not', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1).set('b', 2);
    expect(c.get('a')).toBe(1); // a is now the most recent
    c.set('c', 3);
    expect([c.has('a'), c.has('b'), c.has('c')]).toEqual([true, false, true]);
    expect(c.peek('a')).toBe(1); // a stays the least recent
    c.set('d', 4);
    expect([c.has('a'), c.has('c'), c.has('d'), c.size]).toEqual([false, true, true, 2]);
    c.set('c', 30); // re-set refreshes
    c.set('e', 5);
    expect([c.get('c'), c.has('d'), c.size]).toEqual([30, false, 2]);
  });
});
