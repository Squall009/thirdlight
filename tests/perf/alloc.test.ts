/**
 * Phase 21.2 (always on; needs `dist/` — run `npm run build` first): the
 * steady simulation step loop stays allocation-light. The medium benchmark
 * (2000 entities, 20 scripts, 200 colliders; tools/perf/generate.ts) is built
 * through the real backend into a throwaway data root, then played headless
 * in a child process started with `--expose-gc` (tools/perf/sim.ts: the real
 * game host, platformer, Rapier and the compiled scripts). The bytes allocated
 * per steady step are the used-heap growth over windows of steps that saw no
 * collection.
 *
 * Before 21.2 the loop allocated ~1.4 KiB per entity per step (2.6 MiB per
 * step here); the bound — 64 KiB per step, 32 bytes per entity — fails as soon
 * as anything per entity comes back, while leaving room for the constant
 * remainder (Rapier's JS glue, physics results, script intents; ~30 KiB).
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PERF_ROOT, REPO, startPerfBackend } from '../../tools/perf/backend';
import { buildBenchmark } from '../../tools/perf/build';
import { CLASS_SPECS } from '../../tools/perf/classes';
import { generate } from '../../tools/perf/generate';
import { runSimChild } from '../../tools/perf/sim-run';

const BOUND_BYTES_PER_STEP = 64 * 1024;

describe('steady step allocations (phase 21.2)', () => {
  it(`the medium benchmark's steady step allocates under ${BOUND_BYTES_PER_STEP / 1024} KiB`, async () => {
    expect(existsSync(join(REPO, 'dist', 'backend', 'backend.mjs')), 'dist/ is missing: run `npm run build` first').toBe(true);
    const root = join(PERF_ROOT, 'alloc-test', `${process.pid}-${Date.now()}`);
    try {
      const be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
      try {
        await buildBenchmark(be, generate('medium'), 'bench');
      } finally {
        await be.stop();
      }
      const sim = await runSimChild(join(root, 'data', 'projects', 'bench'), { warmup: 240, steps: 120, window: 60, windows: 12 });
      if (!sim.ok) throw new Error(`the simulation failed: ${sim.error}`);
      expect(sim.entities).toBe(CLASS_SPECS.medium.entities);
      expect(sim.state).toBe('playing');
      expect(sim.bytesPerStep.windows).toBeGreaterThanOrEqual(6);
      console.log(`alloc: medium ${sim.bytesPerStep.median} B/step (min ${sim.bytesPerStep.min}, ${sim.bytesPerStep.windows} windows of ${sim.bytesPerStep.windowSteps} steps), step p50 ${sim.stepMs.p50} ms`);
      expect(sim.bytesPerStep.median).toBeLessThan(BOUND_BYTES_PER_STEP);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
