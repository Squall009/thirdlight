import { describe, expect, it, vi } from 'vitest';
import { FarFollow } from './voxel-far-follow';

const c = (cx: number) => ({ cx, cy: 0, cz: 0 });

describe('far changes gathered after commands', () => {
  it('builds a burst of changes once, after the last; a read settles at once; nothing gathered is lost', async () => {
    const runs: Array<{ before: number; chunks: number[] }> = [];
    const f = new FarFollow<{ n: number }>(async (_key, before, chunks) => {
      runs.push({ before, chunks: chunks.map((x) => x.cx).sort((a, b) => a - b) });
      return { n: chunks.length };
    }, 40);
    // Ten moves 5 ms apart (the clock the test's): one rebuild of every chunk they touched, from the revision the
    // first found, once 40 ms passed after the last.
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) {
      expect(f.add('w', i === 0 ? 7 : (f.before('w') ?? -1), [c(i), c(i + 1)])).toBe(i + 2);
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(30);
    expect(runs.length).toBe(0);
    expect(f.pending('w')).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    expect(runs).toEqual([{ before: 7, chunks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }]);
    expect(f.last.get('w')).toMatchObject({ commands: 10, chunks: 11, result: { n: 11 } });
    expect(f.pending('w')).toBe(false);
    // A reader settles what waits now, without the wait.
    f.add('w', 9, [c(3)]);
    expect(await f.settle('w')).toEqual({ n: 1 });
    expect(runs.length).toBe(2);
    expect(await f.settle('w')).toBeNull();
    // Another world's changes are its own.
    f.add('v', 1, [c(1)]);
    f.add('w', 9, [c(2)]);
    expect([await f.settle('v'), await f.settle('w')]).toEqual([{ n: 1 }, { n: 1 }]);
    // Dropped (the world read again): nothing built, a waiting reader answered null.
    f.add('w', 9, [c(5)]);
    const waiting = f.settle('w');
    f.drop('w');
    expect(await waiting).toEqual({ n: 1 });
    f.add('w', 9, [c(6)]);
    f.drop('w');
    expect(f.pending('w')).toBe(false);
    expect(runs.length).toBe(5);
  });
});
