/**
 * Phase 21.0/21.1 (always on, fast): the benchmark generator and the
 * harness's pure plumbing. Every class generates exactly its entity count
 * within the model's limits, deterministically; pastes stay under the command
 * size cap; percentiles, the metric extraction and the baseline comparison
 * behave; the checked-in baseline is well formed and matches the generator.
 * (tests/e2e/perf-harness.e2e.ts drives the whole harness on the small
 * benchmark; tests/perf/regression.test.ts is the opt-in comparison.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { splitBySize } from '../../tools/perf/build';
import { BENCH_CLASSES, BUDGETS, CLASS_SPECS } from '../../tools/perf/classes';
import { GENERATOR_VERSION, generate, prng } from '../../tools/perf/generate';
import { metricsOf, parseArgs } from '../../tools/perf/harness';
import { compare, summarize, type Metric } from '../../tools/perf/stats';

describe('benchmark generator', () => {
  for (const cls of BENCH_CLASSES) {
    it(`${cls}: exact counts inside the model's limits`, () => {
      const plan = generate(cls);
      const spec = CLASS_SPECS[cls];
      const all = plan.scenes.flatMap((s) => s.batches.flat());
      expect(all.length + 6).toBe(spec.entities);
      expect(plan.counts['total']).toBe(spec.entities);
      expect(plan.scenes).toHaveLength(spec.scenes);
      expect(plan.materials).toHaveLength(spec.materials);
      expect(plan.effects).toHaveLength(spec.effects);
      expect(all.filter((e) => e.components['behavior'] !== undefined)).toHaveLength(spec.scriptInstances);
      expect(all.filter((e) => e.components['model'] !== undefined)).toHaveLength(spec.models);
      expect(all.filter((e) => e.components['effect'] !== undefined)).toHaveLength(spec.effects);
      const sets = all.filter((e) => e.components['instances'] !== undefined);
      expect(sets).toHaveLength(spec.instanceSets);
      expect(plan.buffers.map((b) => b.floats.length)).toEqual(Array(spec.instanceSets).fill(spec.copiesPerSet * 10));
      // Particle capacity: rate × lifetime fills each system.
      const particles = plan.effects.reduce((a, fx) => a + ((fx['systems'] as { maxParticles: number }[])[0]!.maxParticles), 0);
      expect(particles).toBe(spec.effects * spec.particlesPerEffect);
      // References resolve.
      const materials = new Set(plan.materials.map((m) => m['materialId']));
      const effects = new Set(plan.effects.map((f) => f['effectId']));
      const behaviors = new Set(plan.behaviors.map((b) => b.behaviorId));
      for (const e of all) {
        const mat = (e.components['materials'] as Record<string, string> | undefined)?.['*'];
        if (mat !== undefined) expect(materials.has(mat)).toBe(true);
        const fx = (e.components['effect'] as { effectId: string } | undefined)?.effectId;
        if (fx !== undefined) expect(effects.has(fx)).toBe(true);
        const b = (e.components['behavior'] as { behaviorId: string } | undefined)?.behaviorId;
        if (b !== undefined) expect(behaviors.has(b)).toBe(true);
      }
      for (const scene of plan.scenes) {
        const entities = scene.batches.flat();
        // Physics-bearing objects are roots; at most 256 colliders and 16 local lights per scene.
        for (const e of entities) if (e.components['collider'] !== undefined) expect(e.parentId).toBeUndefined();
        expect(entities.filter((e) => e.components['collider'] !== undefined).length).toBeLessThanOrEqual(256);
        expect(entities.filter((e) => (e.components['light'] as { type?: string } | undefined)?.type === 'point').length).toBeLessThanOrEqual(16);
        for (const batch of scene.batches) {
          expect(batch.length).toBeLessThanOrEqual(256);
          // A child is always pasted with its parent.
          const ids = new Set(batch.map((e) => e.id));
          for (const e of batch) if (e.parentId !== undefined) expect(ids.has(e.parentId)).toBe(true);
          for (const part of splitBySize(batch)) expect(JSON.stringify(part).length).toBeLessThan(60_000);
        }
      }
      // Loaded together the start scenes hold at most 256 colliders and 16 point lights.
      expect(all.filter((e) => e.components['collider'] !== undefined).length).toBeLessThanOrEqual(256);
      expect(all.filter((e) => (e.components['light'] as { type?: string } | undefined)?.type === 'point').length).toBeLessThanOrEqual(16);
      // Unit quaternions (the model checks within 1e-4).
      for (const e of all) {
        const q = (e.components['transform'] as { rotation: number[] }).rotation;
        expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(1e-4);
      }
    });
  }

  it('is deterministic per seed, and the seed matters', () => {
    const a = generate('medium');
    const b = generate('medium');
    expect(JSON.stringify(a.scenes)).toBe(JSON.stringify(b.scenes));
    expect(Buffer.from(a.buffers[0]!.floats.buffer).equals(Buffer.from(b.buffers[0]!.floats.buffer))).toBe(true);
    expect(JSON.stringify(generate('medium', 7).scenes)).not.toBe(JSON.stringify(a.scenes));
    const r1 = prng(5);
    const r2 = prng(5);
    for (let i = 0; i < 100; i += 1) expect(r1()).toBe(r2());
  });

  it('splits a paste at group boundaries', () => {
    const big = 'x'.repeat(4000);
    const batch = Array.from({ length: 20 }, (_, g) => [
      { id: `p${g}`, name: big, components: {} },
      { id: `c${g}`, name: big, parentId: `p${g}`, components: {} },
    ]).flat();
    const parts = splitBySize(batch);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toEqual(batch);
    for (const part of parts) {
      expect(part[0]!.parentId).toBeUndefined();
      expect(JSON.stringify(part).length).toBeLessThan(60_000);
    }
  });
});

describe('harness plumbing', () => {
  it('summarizes with nearest-rank percentiles', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toMatchObject({ n: 100, p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
    expect(summarize([])).toMatchObject({ n: 0, p50: 0 });
  });

  it('compares against a baseline: regressions beyond the tolerance, improvements, missing keys', () => {
    const base: Record<string, Metric> = {
      'a.drawCalls': { value: 100, kind: 'count' },
      'a.heapMiB': { value: 40, kind: 'memory' },
      'a.frameMean/cal': { value: 1, kind: 'ratio' },
      'b.drawCalls': { value: 10, kind: 'count' },
    };
    const same = compare(base, { 'a.drawCalls': { value: 105, kind: 'count' }, 'a.heapMiB': { value: 45, kind: 'memory' }, 'a.frameMean/cal': { value: 1.5, kind: 'ratio' } });
    expect(same.regressions).toEqual([]);
    expect(same.missing).toEqual(['b.drawCalls']);
    const worse = compare(base, { 'a.drawCalls': { value: 130, kind: 'count' }, 'a.heapMiB': { value: 60, kind: 'memory' }, 'a.frameMean/cal': { value: 2.5, kind: 'ratio' }, 'b.drawCalls': { value: 3, kind: 'count' } });
    expect(worse.regressions.map((r) => r.key).sort()).toEqual(['a.drawCalls', 'a.frameMean/cal', 'a.heapMiB']);
    expect(worse.improvements.map((r) => r.key)).toEqual(['b.drawCalls']);
  });

  it('extracts relative metrics from a report', () => {
    const frame = summarize([20, 20, 30]);
    const m = metricsOf({
      calibration: { cpuMs: 10, cpuMsEnd: 10, browser: { legacy: { frameMs: summarize([10, 10]), drawCalls: summarize([100]) } } },
      benchmarks: {
        small: {
          cpuMs: 10,
          calibration: {},
          build: { projectId: 'bench', ms: 1000, commands: 10, revision: 10, entities: 100 },
          counts: {},
          surfaces: [{ surface: 'play', renderer: 'legacy', rendererChoice: null, apis: ['webgl2'], load: { firstFrameMs: 500 }, frameMs: frame, drawCalls: summarize([40]), triangles: summarize([1000]), live: { programs: 4, pipelines: 0, textures: 3, buffers: 50, vaos: 10 }, gpuMiBEstimate: 2, heapMiB: 30, heapSource: 'x', uasm: 'x', notes: [], loadavg: [1] }],
          commandMs: summarize([5, 6, 7]),
          sim: { ok: true, entities: 100, colliders: 20, scriptInstances: 4, bootMs: 100, stepMs: { p50: 1, p95: 2, p99: 3, max: 4, mean: 1 }, steps: 10, bytesPerStep: { median: 2048, min: 1024, windows: 5, windowSteps: 60, discarded: 0 }, calibrationMs: 10, heapUsedMiB: 12, state: 'playing', counters: null },
          errors: [],
        },
      },
    });
    expect(m['small.entities']).toEqual({ value: 100, kind: 'count' });
    expect(m['small.play.legacy.frameMean/cal']).toEqual({ value: 2.333, kind: 'ratio' });
    expect(m['small.play.legacy.drawCalls']).toEqual({ value: 40, kind: 'count' });
    expect(m['small.play.legacy.firstFrame/cpu']).toEqual({ value: 50, kind: 'ratio' });
    expect(m['small.command.p95/cpu']).toEqual({ value: 0.7, kind: 'ratio' });
    expect(m['small.sim.stepP50/cpu']).toEqual({ value: 0.1, kind: 'ratio' });
    expect(m['small.sim.KiBPerStep']).toEqual({ value: 2, kind: 'memory' });
  });

  it('parses the runner options (defaults: every class, legacy + webgl2, every surface)', () => {
    const d = parseArgs([]);
    expect(d.classes).toEqual([...BENCH_CLASSES]);
    expect(d.renderers).toEqual(['legacy', 'webgl2']);
    expect(d.surfaces).toEqual(['play', 'export', 'editor', 'sim']);
    const q = parseArgs(['--classes', 'small,large', '--renderers', 'webgpu', '--quick', '--viewport', '800x600']);
    expect(q).toMatchObject({ classes: ['small', 'large'], renderers: ['webgpu'], viewport: { width: 800, height: 600 }, recordMs: 1500 });
    expect(() => parseArgs(['--classes', 'huge'])).toThrow(/unknown huge/);
  });

  it('every class has a budget; the checked-in baseline is well formed and matches the generator', () => {
    for (const cls of BENCH_CLASSES) expect(BUDGETS[cls].playFrameP95Ms).toBe(16.6);
    const baseline = JSON.parse(readFileSync(join(import.meta.dirname, 'baseline.json'), 'utf8')) as { generatorVersion: number; metrics: Record<string, Metric>; classes: string[] };
    expect(baseline.generatorVersion).toBe(GENERATOR_VERSION);
    expect(Object.keys(baseline.metrics).length).toBeGreaterThan(20);
    for (const [key, m] of Object.entries(baseline.metrics)) {
      expect(['count', 'memory', 'ratio'], key).toContain(m.kind);
      expect(Number.isFinite(m.value), key).toBe(true);
      expect(baseline.classes).toContain(key.split('.')[0]);
    }
  });
});
