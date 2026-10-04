/**
 * The village perf class's plan and the checks its measurement makes,
 * without a browser: the plan is deterministic and has the class's shape,
 * the gate's frame-time comparison fails only beyond its tolerance (and when
 * a renderer was not measured), the ablation's per-draw cost is the added
 * frame time over the plain page's draws, and a profile sample is
 * attributed to the package its bundle line belongs to.
 */
import { describe, expect, it } from 'vitest';

import { moduleIndex, packageOf } from '../../tools/perf/profile';
import { propGlb, figureGlb } from '../../tools/perf/village-assets';
import { villagePlan, VILLAGE_SPEC } from '../../tools/perf/village';
import { ablationRows, frameRegressions, FRAME_REGRESSION, type FrameBaseline, type VillageReport } from '../../tools/perf/village-run';
import type { FrameRunResult } from '../../tools/perf/frame-run';

const run = (mean: number, draws = 500): FrameRunResult =>
  ({ frames: { n: 100, fps: 1000 / mean, p50: mean, p95: mean, p99: mean, mean }, draws: { n: 100, p50: draws, p95: draws, p99: draws, max: draws, mean: draws }, gpu: null }) as unknown as FrameRunResult;

describe('the village class', () => {
  it('is the same plan every time, with the class shape', () => {
    const a = villagePlan();
    const b = villagePlan();
    expect(JSON.stringify(a.batches)).toBe(JSON.stringify(b.batches));
    expect(a.counts['total']).toBe(VILLAGE_SPEC.entities);
    expect(a.counts['props']).toBe(VILLAGE_SPEC.props);
    expect(a.counts['instanceSets']).toBe(VILLAGE_SPEC.instanceSets);
    expect(a.counts['figures']).toBe(VILLAGE_SPEC.figures);
    expect(a.counts['fires']).toBe(VILLAGE_SPEC.fires);
    expect(a.counts['recoloured']).toBe(VILLAGE_SPEC.recoloured);
    expect(a.props).toHaveLength(VILLAGE_SPEC.propFiles);
    // Every entity is pasted once, folders with their children.
    const all = a.batches.flat();
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(all.length + 3).toBe(VILLAGE_SPEC.entities);
  });

  it('makes valid GLBs: props with three LOD levels per part, a skinned figure with an idle clip', () => {
    const json = (glb: Buffer): Record<string, unknown> => JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as Record<string, unknown>;
    const prop = json(propGlb(7, { parts: 2, rings: 6, sides: 10, textureSize: 0 }));
    const names = (prop['nodes'] as { name: string }[]).map((n) => n.name);
    expect(names.filter((n) => /_LOD\d$/.test(n))).toEqual(['part0_LOD0', 'part0_LOD1', 'part0_LOD2', 'part1_LOD0', 'part1_LOD1', 'part1_LOD2']);
    const fig = json(figureGlb(7));
    expect((fig['skins'] as { joints: number[] }[])[0]!.joints).toHaveLength(22);
    expect((fig['animations'] as { name: string }[]).map((x) => x.name)).toEqual(['idle']);
  });
});

describe('the frame-time check', () => {
  const base: FrameBaseline = { note: '', recordedAt: '', commit: '', machine: { cpu: '', cores: 1, gpu: '' }, subject: 'village', version: 1, frameMeanMs: { webgpu: 18, webgl2: 17 } };
  it('passes within the tolerance and fails beyond it', () => {
    expect(frameRegressions(base, { export: { webgpu: run(18 * (1 + FRAME_REGRESSION) - 0.01), webgl2: run(10) } })).toEqual([]);
    const bad = frameRegressions(base, { export: { webgpu: run(20), webgl2: run(17) } });
    expect(bad.map((b) => b.renderer)).toEqual(['webgpu']);
    expect(bad[0]!.limit).toBe(19.8);
  });
  it('fails a renderer the run did not measure', () => {
    expect(frameRegressions(base, { export: { webgpu: run(18) } }).map((b) => b.renderer)).toEqual(['webgl2']);
  });
});

describe('the per-draw ablation', () => {
  it('spreads the added frame time over the plain page draws', () => {
    const report: Pick<VillageReport, 'bare'> = { bare: { bare: { webgpu: run(6, 1000) }, 'dark-lights': { webgpu: run(10, 1000) }, 'material-copies': { webgpu: run(6.1, 1000) } } };
    const rows = ablationRows(report);
    expect(rows.find((r) => r.variant === 'dark-lights')).toMatchObject({ deltaMs: 4, usPerDraw: 4 });
    expect(rows.find((r) => r.variant === 'material-copies')?.usPerDraw).toBeCloseTo(0.1, 5);
  });
});

describe('the main-thread split', () => {
  it('attributes a bundle line to its module and package', () => {
    const src = ['// header', '  // node_modules/three/build/three.core.js', 'a();', '  // packages/three-adapter/src/batching.ts', 'b();'].join('\n');
    const idx = moduleIndex(src);
    expect(idx.lines).toEqual([2, 4]);
    expect(packageOf(idx.paths[0]!)).toBe('three');
    expect(packageOf(idx.paths[1]!)).toBe('@thirdlight/three-adapter');
    expect(packageOf('http://127.0.0.1:1/three/build/three.webgpu.js')).toBe('three');
    expect(packageOf('(native)')).toBe('native');
  });
});
