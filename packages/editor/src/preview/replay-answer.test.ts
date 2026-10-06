import { describe, expect, it } from 'vitest';

import { awaitRestart } from './replay-answer';

describe('awaitRestart', () => {
  it('answers applied only once the page shows a step of the new run', async () => {
    // The worker restarted (run 1 from step 10) before the page applied that frame.
    let shown = 10;
    let reads = 0;
    const reader = {
      runNow: async () => {
        reads += 1;
        if (reads === 3) shown = 11;
        return { run: 1, startStep: 10 };
      },
      shownStep: () => shown,
    };
    const r = await awaitRestart(reader, 0, 5_000, () => true);
    expect(r).toEqual({ state: 'applied', run: 1, atStep: 10 });
    expect(reads).toBe(3);
  });

  it('answers pending when the page never shows the new run within the wait', async () => {
    const reader = { runNow: async () => ({ run: 1, startStep: 10 }), shownStep: () => 10 };
    expect(await awaitRestart(reader, 0, 40, () => true)).toEqual({ state: 'pending', run: 1 });
  });

  it('answers pending while the simulation is still in the old run', async () => {
    const reader = { runNow: async () => ({ run: 0, startStep: 0 }), shownStep: () => 50 };
    expect(await awaitRestart(reader, 0, 40, () => true)).toEqual({ state: 'pending', run: 1 });
  });
});
