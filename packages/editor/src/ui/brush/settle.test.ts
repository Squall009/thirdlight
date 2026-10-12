import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettledEdits, SLIDER_SETTLE_MS } from './settle';

interface Doc {
  a: number;
  b: number;
}

/** A project that stores a save after a round trip (`arrive`), as the backend shows a command back. */
function project(start: Doc): { q: SettledEdits<Doc>; saves: Doc[]; arrive: () => void; set: (d: Doc) => void; stored: () => Doc } {
  let stored = start;
  const saves: Doc[] = [];
  const q: SettledEdits<Doc> = new SettledEdits<Doc>(stored, (next) => {
    saves.push(next);
    return true;
  });
  return {
    q,
    saves,
    arrive: () => {
      stored = saves[saves.length - 1]!;
      q.setStored(stored);
    },
    set: (d) => {
      stored = d;
      q.setStored(d);
    },
    stored: () => stored,
  };
}

describe('settled edits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores a drag once, when it rests, and shows each move meanwhile', () => {
    const p = project({ a: 0, b: 0 });
    for (const v of [1, 2, 3]) {
      p.q.edit('a', 'A', (d) => ({ ...d, a: v }));
      vi.advanceTimersByTime(SLIDER_SETTLE_MS - 1);
      expect(p.q.value.a).toBe(v);
    }
    expect(p.saves).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(p.saves).toEqual([{ a: 3, b: 0 }]);
  });

  it('two sliders moved within the wait both stick', () => {
    const p = project({ a: 0, b: 0 });
    p.q.edit('a', 'A', (d) => ({ ...d, a: 5 }));
    vi.advanceTimersByTime(SLIDER_SETTLE_MS / 2);
    p.q.edit('b', 'B', (d) => ({ ...d, b: 7 }));
    vi.advanceTimersByTime(SLIDER_SETTLE_MS);
    expect(p.saves).toEqual([{ a: 5, b: 7 }]);
  });

  it('a slider resting before the project shows the last save back builds on that save', () => {
    const p = project({ a: 0, b: 0 });
    p.q.edit('a', 'A', (d) => ({ ...d, a: 5 }));
    vi.advanceTimersByTime(SLIDER_SETTLE_MS);
    // The first save is on its way; the second slider rests before it arrives.
    p.q.edit('b', 'B', (d) => ({ ...d, b: 7 }));
    vi.advanceTimersByTime(SLIDER_SETTLE_MS);
    expect(p.saves).toEqual([{ a: 5, b: 0 }, { a: 5, b: 7 }]);
    p.arrive();
    expect(p.q.value).toEqual({ a: 5, b: 7 });
  });

  it('an undo inside the wait is built on, not reverted', () => {
    const p = project({ a: 1, b: 1 });
    p.q.edit('a', 'A', (d) => ({ ...d, a: 9 }));
    vi.advanceTimersByTime(SLIDER_SETTLE_MS / 2);
    // An undo (or an MCP edit) changes the other setting meanwhile.
    p.set({ a: 1, b: 0 });
    vi.advanceTimersByTime(SLIDER_SETTLE_MS);
    expect(p.saves).toEqual([{ a: 9, b: 0 }]);
  });

  it('a refused save is not drawn on; a click stores at once with what waits', async () => {
    let answer = false;
    const saves: Doc[] = [];
    const q = new SettledEdits<Doc>({ a: 0, b: 0 }, (next) => {
      saves.push(next);
      return Promise.resolve(answer);
    });
    q.edit('a', 'A', (d) => ({ ...d, a: 4 }));
    vi.advanceTimersByTime(SLIDER_SETTLE_MS);
    expect(q.value.a).toBe(4);
    await Promise.resolve();
    await Promise.resolve();
    expect(q.value.a).toBe(0);
    answer = true;
    q.edit('a', 'A', (d) => ({ ...d, a: 2 }));
    q.edit('b', 'B', (d) => ({ ...d, b: 3 }), true);
    expect(saves[saves.length - 1]).toEqual({ a: 2, b: 3 });
    vi.advanceTimersByTime(SLIDER_SETTLE_MS * 2);
    expect(saves).toHaveLength(2);
  });
});
