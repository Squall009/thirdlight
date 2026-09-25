/**
 * Phase 21.1 (always on, short): the performance harness end to end on the
 * small benchmark — generated and built through the real backend's command
 * API, measured in Play (preview iframe), in the export (served statically)
 * and in the editor's Scene view while orbiting, with command round trips,
 * and simulated headlessly in Node. Checks the plumbing (every number is
 * there and plausible), not speed: the opt-in comparison is
 * tests/perf/regression.test.ts.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { measureEditor, measureExport, measurePlay, type SurfaceOptions } from '../../tools/perf/browser';
import { buildBenchmark } from '../../tools/perf/build';
import { generate } from '../../tools/perf/generate';
import { metricsOf } from '../../tools/perf/harness';
import { runSimChild } from '../../tools/perf/sim-run';

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `plumbing-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

test('the harness measures the small benchmark in Play, the export, the editor and the headless simulation', async ({ browser }) => {
  test.setTimeout(300_000);
  const plan = generate('small');
  const built = await buildBenchmark(be, plan, 'bench');
  expect(built.entities).toBe(100);
  const project = await be.project('bench').query('queryProject');
  expect((project['scenes'] as { entityCount: number }[])[0]!.entityCount).toBe(100);

  const opts: SurfaceOptions = { warmupMs: 300, recordMs: 1500, viewport: { width: 960, height: 540 } };
  const play = await measurePlay(browser, be, 'bench', 'webgl2', opts);
  expect(play.state).toBe('playing');
  expect(play.rendererChoice?.backend).toBe('webgl2');
  expect(play.apis).toContain('webgl2');
  expect(play.load['firstFrameMs']).toBeGreaterThan(0);
  expect(play.drawCalls.p50).toBeGreaterThan(0);
  expect(play.triangles.p50).toBeGreaterThan(0);
  expect(play.live.programs).toBeGreaterThan(0);
  expect(play.gpuMiBEstimate).toBeGreaterThan(0);
  expect(play.three?.programs).toBeGreaterThan(0);
  expect(play.heapMiB).toBeGreaterThan(1);

  const exported = await be.post('/api/v1/admin/projects/bench/export', {});
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const exp = await measureExport(browser, join(be.exportRoot, String(exported.json['outputDir'])), 'webgl2', opts);
  expect(exp.notes.filter((n) => n.startsWith('page errors'))).toEqual([]);
  expect(exp.load['firstFrameMs']).toBeGreaterThan(0);
  expect(exp.frameMs.n).toBeGreaterThan(0);
  expect(exp.drawCalls.p50).toBeGreaterThan(0);

  const probe = ((await be.project('bench').query('queryEntities', { limit: 200, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[]).find((e) => e.components['box'] !== undefined && e.components['collider'] === undefined && e.components['controller'] === undefined)!.id;
  const ed = await measureEditor(browser, be, 'bench', 'webgl2', { ...opts, commands: 5, entityId: probe });
  // Orbiting redraws the Scene view: several frames drew the scene.
  expect(ed.surface.frameMs.n).toBeGreaterThan(2);
  expect(ed.surface.drawCalls.p50).toBeGreaterThan(0);
  expect(ed.commandMs.n).toBe(5);
  expect(ed.commandMs.p95).toBeGreaterThan(0);
  // Phase 21.4: the editor-side costs — Hierarchy, change application, bytes on the wire and on disk.
  const ops = ed.ops!;
  expect(ops.hierarchy.domRows).toBe(100);
  expect(ops.hierarchy.selectMs.n).toBe(5);
  expect(ops.hierarchy.renameMs.n).toBe(3);
  expect(ops.command.applyFrameMs.n).toBe(5);
  expect(ops.command.wsBytesPerCommand).toBeGreaterThan(0);
  // A transform edit writes only the one scene file it touched.
  expect(ops.command.filesWrittenPerCommand).toBe(1);
  expect(ops.command.bytesWrittenPerCommand).toBeGreaterThan(0);
  expect(ops.material?.wsBytes).toBeGreaterThan(0);

  await be.stop();
  const sim = await runSimChild(join(root, 'data', 'projects', 'bench'), { warmup: 30, steps: 60, window: 20, windows: 3 });
  if (!sim.ok) throw new Error(sim.error);
  expect(sim.entities).toBe(100);
  expect(sim.scriptInstances).toBe(4);
  expect(sim.state).toBe('playing');
  expect(sim.stepMs.p50).toBeGreaterThan(0);
  expect(sim.bytesPerStep.windows + sim.bytesPerStep.discarded).toBeGreaterThan(0);

  const metrics = metricsOf({
    calibration: { cpuMs: 10, cpuMsEnd: 10, browser: { webgl2: { frameMs: { n: 1, p50: 10, p95: 10, p99: 10, max: 10, mean: 10 }, drawCalls: { n: 1, p50: 1, p95: 1, p99: 1, max: 1, mean: 1 } } } },
    benchmarks: { small: { cpuMs: 10, calibration: {}, build: built, counts: plan.counts, surfaces: [play, exp, ed.surface], commandMs: ed.commandMs, sim, errors: [] } },
  });
  for (const key of ['small.play.webgl2.drawCalls', 'small.export.webgl2.frameMean/cal', 'small.editor.webgl2.heapMiB', 'small.command.p95/cpu', 'small.sim.KiBPerStep']) expect(metrics[key], key).toBeDefined();
});
