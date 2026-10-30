/**
 * The perf harness without a GPU (structure, never timings): every benchmark
 * class and the village give the same plan for the same seed, and every paste,
 * material and effect they send is one the commands take within a request's
 * bytes; the command line parses as documented; and the small class builds
 * into a real backend (dist/) through the command API and runs the
 * simulation surface, so the paths a GPU run measures still work end to end.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validatePasteArgs } from '../../packages/commands/src/paste-ops';
import { validateOpArgs } from '../../packages/commands/src/validate-request';
import { MAX_REQUEST_BYTES } from '../../packages/project-model/src/limits';
import { REPO, startPerfBackend } from './backend';
import { buildBenchmark, splitBySize } from './build';
import { BENCH_CLASSES } from './classes';
import { generate, planKey } from './generate';
import { parseArgs, SURFACES } from './harness';
import { runSimChild } from './sim-run';
import { villagePlan } from './village';
import type { EntityValue } from './generate';

/** Every part a batch is pasted in passes the paste validator and fits one request. */
function expectPastable(batches: readonly EntityValue[][], what: string): number {
  let n = 0;
  for (const batch of batches) {
    for (const part of splitBySize(batch)) {
      const args = { entities: part };
      expect(JSON.stringify(args).length, what).toBeLessThan(MAX_REQUEST_BYTES);
      const r = validatePasteArgs(args);
      expect(r.ok, `${what}: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
      n += part.length;
    }
    expect(splitBySize(batch).flat(), what).toEqual(batch);
  }
  return n;
}

const valid = (op: string, args: Record<string, unknown>, what: string): void => {
  const r = validateOpArgs(op as Parameters<typeof validateOpArgs>[0], args);
  expect(r.ok, `${what} ${op}: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
};

describe('the perf generators', () => {
  for (const cls of BENCH_CLASSES) {
    it(`${cls}: the same plan for the same seed, every paste, material and effect one the commands take`, () => {
      const plan = generate(cls);
      expect(planKey(generate(cls))).toBe(planKey(plan));
      expect(JSON.stringify(generate(cls).scenes)).toBe(JSON.stringify(plan.scenes));
      const pasted = expectPastable(plan.scenes.flatMap((s) => s.batches), cls);
      expect(pasted).toBeGreaterThan(0);
      expect(pasted).toBeLessThanOrEqual(plan.spec.entities);
      expect(plan.scenes).toHaveLength(plan.spec.scenes);
      for (const material of plan.materials) valid('setMaterial', { material }, cls);
      for (const effect of plan.effects) valid('setEffect', { effect }, cls);
      expect(plan.behaviors.length).toBeGreaterThan(0);
    });
  }

  it('village: the same plan for the same seed, every paste and material one the commands take', () => {
    const plan = villagePlan();
    expect(JSON.stringify(villagePlan().batches)).toBe(JSON.stringify(plan.batches));
    const pasted = expectPastable(plan.batches, 'village');
    expect(pasted).toBeGreaterThan(0);
    expect(pasted).toBeLessThanOrEqual(plan.counts['total']!);
    for (const material of plan.materials) valid('setMaterial', { material }, 'village');
  });
});

describe('the perf command line', () => {
  it('reads its defaults, --quick and lists, and refuses an unknown class or surface', () => {
    const d = parseArgs([]);
    expect(d.classes).toEqual([...BENCH_CLASSES]);
    expect(d.surfaces).toEqual([...SURFACES]);
    expect(d.renderers).toEqual(['webgl2']);
    expect([d.recordMs, d.simSteps, d.gpu, d.viewport]).toEqual([5000, 1200, false, { width: 1280, height: 720 }]);
    const q = parseArgs(['--quick', '--classes', 'small, medium', '--surfaces', 'sim', '--gpu', '--viewport', '800x600', '--sim-steps', '60']);
    expect([q.classes, q.surfaces, q.recordMs, q.simSteps, q.gpu, q.viewport]).toEqual([['small', 'medium'], ['sim'], 1500, 60, true, { width: 800, height: 600 }]);
    expect(() => parseArgs(['--classes', 'huge'])).toThrow(/--classes: unknown huge/);
    expect(() => parseArgs(['--surfaces', 'gpu'])).toThrow(/--surfaces: unknown gpu/);
  });
});

const BUILT = existsSync(join(REPO, 'dist', 'backend', 'backend.mjs'));

describe('the small class end to end, without a GPU', () => {
  // The gate builds dist/ before its tests; a bare `vitest run` without a build says so here.
  it.skipIf(!BUILT)('builds into a real backend through the command API and steps in the simulation surface', { timeout: 180_000 }, async () => {
    const root = join(REPO, 'dist', 'perf', `test-run-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const plan = generate('small');
    const dataRoot = join(root, 'small');
    const be = await startPerfBackend(dataRoot, join(root, 'small-exports'));
    try {
      const build = await buildBenchmark(be, plan, 'bench');
      expect(build.entities).toBe(plan.spec.entities);
      // What the backend holds now, read back (the class has one scene and fewer objects than a page).
      const listed = (await be.project('bench').query('queryEntities', { limit: 1024, offset: 0 }))['entities'] as unknown[];
      expect(listed).toHaveLength(plan.spec.entities);
    } finally {
      await be.stop();
    }
    try {
      const sim = await runSimChild(join(dataRoot, 'projects', 'bench'), { warmup: 10, steps: 60, window: 10, windows: 3 });
      expect(sim.ok, JSON.stringify(sim).slice(0, 400)).toBe(true);
      if (sim.ok) {
        expect(sim.entities).toBeGreaterThan(0);
        expect(sim.scriptInstances).toBe(plan.spec.scriptInstances);
        expect(sim.steps).toBeGreaterThanOrEqual(60);
        expect(sim.stepMs.p50).toBeGreaterThan(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
