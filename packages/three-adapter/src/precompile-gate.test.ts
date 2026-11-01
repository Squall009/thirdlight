import { describe, expect, it } from 'vitest';

import type { Precompile } from './environment-nodes';
import { PrecompileGate } from './precompile-gate';

/** A precompile settled by hand. */
function job(): { job: Precompile; settle(): void } {
  let settle: () => void = () => undefined;
  const done = new Promise<void>((r) => (settle = r));
  return { job: { done, lastProgressAt: () => performance.now(), aside: (draw) => draw(), release: () => undefined }, settle };
}

describe('the precompile gate', () => {
  it('holds the first present for start content that arrives while the start compile runs', async () => {
    const gate = new PrecompileGate(() => false);
    const j = job();
    let held = false;
    // No content to wait for yet: the start's compile begins and the frame waits for it.
    expect(gate.holds(() => held, () => j.job)).toBe(true);
    held = true;
    j.settle();
    await Promise.resolve();
    await Promise.resolve();
    // The compile settled, but content came meanwhile: the first present still waits for it.
    expect(gate.holds(() => held, () => job().job)).toBe(true);
    held = false;
    expect(gate.holds(() => held, () => job().job)).toBe(false);
    // Once presented, later content never holds a frame.
    held = true;
    expect(gate.holds(() => held, () => job().job)).toBe(false);
  });
});
