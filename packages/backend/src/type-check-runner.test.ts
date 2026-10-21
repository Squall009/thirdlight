/**
 * The script type check off the event loop: the worker the build puts next
 * to the backend bundle checks a script with the real pinned compiler while
 * this thread keeps answering timers. The same first check in this thread
 * (the run from source) holds the loop for the compiler's whole cold start.
 */
import { describe, expect, it } from 'vitest';

import { canonicalContainerText, createBehaviorCompiler } from '@thirdlight/behavior-build';
import { createTypeCheckRunner } from './type-check-runner';

const MISTYPED = ['export default {', '  step(state, ctx) {', "    ctx.camera.activate('cam', { blendTime: 0.5 });", '  },', '};', ''].join('\n');
const input = {
  behaviorId: 'probe',
  containerBytes: new TextEncoder().encode(canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: MISTYPED }] })),
};

/** The longest the event loop went without running a 2 ms interval while `work` ran (ms), and the work's result. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ stall: number; result: T; ms: number }> {
  let last = performance.now();
  let stall = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 2);
  const t0 = performance.now();
  try {
    const result = await work();
    const ms = performance.now() - t0;
    stall = Math.max(stall, performance.now() - last);
    return { stall, result, ms };
  } finally {
    clearInterval(tick);
  }
}

describe('the script type check worker', () => {
  // The worker script the build makes next to the backend bundle (the deployment's checker).
  const workerUrl = new URL('../../../dist/backend/type-check-worker.mjs', import.meta.url);

  it('checks on its thread: a cold first check stalls this one far less than checking here does', async () => {
    const compiler = createBehaviorCompiler({ now: () => performance.now() });
    const runner = createTypeCheckRunner(workerUrl, compiler.typeCheck!.bind(compiler), { idleMs: 200 });
    const cold = await longestStall(() => runner.check(input));
    const warm = await longestStall(() => runner.check(input));
    // The same cold check in this thread (as from source, before the worker existed).
    const here = await longestStall(() => compiler.typeCheck!(input));
    const hereWarm = await longestStall(() => compiler.typeCheck!(input));
    console.log(`type check: worker cold ${cold.ms.toFixed(0)} ms (loop stall ${cold.stall.toFixed(0)} ms), warm ${warm.ms.toFixed(0)} ms (stall ${warm.stall.toFixed(0)} ms); in this thread cold ${here.ms.toFixed(0)} ms (stall ${here.stall.toFixed(0)} ms), warm ${hereWarm.ms.toFixed(0)} ms (stall ${hereWarm.stall.toFixed(0)} ms)`);
    for (const r of [cold.result, warm.result, here.result]) expect(r.diagnostics[0]).toMatchObject({ code: 'behavior_type_error', reason: 'ts2353', line: 3, column: 34 });
    expect(cold.stall).toBeLessThan(here.stall / 2);
    // Idle, the worker ends (its memory back); the next check starts another.
    expect(runner.workerRunning).toBe(true);
    await expect.poll(() => runner.workerRunning, { timeout: 5_000 }).toBe(false);
    expect((await runner.check(input)).diagnostics).toHaveLength(1);
  }, 60_000);
});
