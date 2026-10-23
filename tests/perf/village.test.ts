/**
 * The village perf class's plan and the checks its measurement makes,
 * without a browser: the plan is deterministic and has the class's shape,
 * the gate's check at the cap fails only beyond its margins (and when a
 * renderer was not measured), the ablation's per-draw cost is the added
 * frame time over the plain page's draws, and a profile sample is
 * attributed to the package its bundle line belongs to.
 */
import { describe, expect, it } from 'vitest';

import { build } from 'esbuild';

import { moduleIndex, packageOf, sourceAt, sourceMapIndex } from '../../tools/perf/profile';
import { propGlb, figureGlb } from '../../tools/perf/village-assets';
import { villagePlan, VILLAGE_SPEC } from '../../tools/perf/village';
import { ablationRows, CAP_HZ, CAP_MAIN_REGRESSION, CAP_MISSED_SHARE, frameRegressions, plainPageRows, type FrameBaseline, type VillageReport } from '../../tools/perf/village-run';
import type { FrameRunResult } from '../../tools/perf/frame-run';

const run = (mean: number, draws = 500, p95 = mean): FrameRunResult =>
  ({ frames: { n: 100, fps: 1000 / mean, p50: mean, p95, p99: p95, mean }, draws: { n: 100, p50: draws, p95: draws, p99: draws, max: draws, mean: draws }, gpu: null }) as unknown as FrameRunResult;

describe('the class against the plain three.js page (reported by the perf check, not gated)', () => {
  it('reports per renderer how far the class is ahead of (or behind) the plain page by median frame time', () => {
    const rows = plainPageRows({ export: { webgpu: run(6), webgl2: run(5) }, bare: { bare: { webgpu: run(6.5), webgl2: run(4) } } } as unknown as Pick<VillageReport, 'export' | 'bare'>);
    expect(rows).toEqual([
      expect.objectContaining({ renderer: 'webgpu', classP50Ms: 6, plainP50Ms: 6.5, aheadPercent: 7.7 }),
      expect.objectContaining({ renderer: 'webgl2', classP50Ms: 5, plainP50Ms: 4, aheadPercent: -25 }),
    ]);
    // No plain page measured (no dump): nothing to report.
    expect(plainPageRows({ export: { webgpu: run(6) }, bare: {} } as unknown as Pick<VillageReport, 'export' | 'bare'>)).toEqual([]);
  });
});

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

describe('the frame check at the cap', () => {
  const base: FrameBaseline = { note: '', recordedAt: '', commit: '', machine: { cpu: '', cores: 1, gpu: '' }, subject: 'village', version: 1, capHz: CAP_HZ, mainCpuMsPerFrame: { webgpu: 5, webgl2: 4 } };
  const at = (cpuMs: number, missed = 0, n = 360): FrameRunResult => ({ ...run(16.7), frames: { n, fps: 60, p50: 16.7, p95: 16.8, p99: 16.8, mean: 16.7, missed }, mainThread: { taskMsPerFrame: cpuMs, cpuMsPerFrame: cpuMs, busyShare: 0.3 } }) as FrameRunResult;
  it('passes a busy host: main thread CPU within its margin, a few refreshes missed', () => {
    expect(frameRegressions(base, { export: { webgpu: at(5 * (1 + CAP_MAIN_REGRESSION) - 0.01, Math.floor(360 * CAP_MISSED_SHARE)), webgl2: at(4) } })).toEqual([]);
  });
  it('fails a frame whose main-thread work grew past the margin', () => {
    const bad = frameRegressions(base, { export: { webgpu: at(5), webgl2: at(6.5) } });
    expect(bad.map((b) => [b.renderer, b.metric, b.limit])).toEqual([['webgl2', 'main', 6.4]]);
  });
  it('fails a frame over budget: more than the missed share of refreshes missed', () => {
    const bad = frameRegressions(base, { export: { webgpu: at(5, 180), webgl2: at(4) } });
    expect(bad.map((b) => [b.renderer, b.metric, b.value, b.limit])).toEqual([['webgpu', 'missed', 180, 36]]);
  });
  it('fails a renderer the run did not measure, and refuses a baseline recorded uncapped', () => {
    expect(frameRegressions(base, { export: { webgpu: at(5) } }).map((b) => b.renderer)).toEqual(['webgl2', 'webgl2']);
    const { capHz: _cap, ...uncapped } = base;
    expect(() => frameRegressions(uncapped, { export: { webgpu: at(5), webgl2: at(4) } })).toThrow(/uncapped/);
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

  it('attributes a minified bundle position to its module through the source map', async () => {
    // Two modules in one minified bundle with a linked map, as an export builds them.
    const files: Record<string, string> = {
      'entry.ts': "import { a } from './packages/one/src/a';\nimport { b } from './packages/two/src/b';\nconsole.log(a(), b());\n",
      'packages/one/src/a.ts': "export function a(): string {\n  return 'marker-in-a';\n}\n",
      'packages/two/src/b.ts': "export function b(): string {\n  return 'marker-in-b';\n}\n",
    };
    const r = await build({
      entryPoints: ['entry.ts'],
      bundle: true,
      minify: true,
      format: 'iife',
      sourcemap: 'linked',
      sourcesContent: false,
      outfile: '/virtual/main.js',
      write: false,
      plugins: [{ name: 'virtual', setup: (b) => {
        b.onResolve({ filter: /.*/ }, (a) => ({ path: a.path.replace(/^\.\//, '').replace(/(\.ts)?$/, '.ts'), namespace: 'v' }));
        b.onLoad({ filter: /.*/, namespace: 'v' }, (a) => ({ contents: files[a.path]!, loader: 'ts' }));
      } }],
    });
    const js = r.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    const map = sourceMapIndex(JSON.parse(r.outputFiles.find((f) => f.path.endsWith('.map'))!.text) as { sources: string[]; mappings: string });
    const at = (needle: string): string | null => {
      const offset = js.indexOf(needle);
      const before = js.slice(0, offset).split('\n');
      return sourceAt(map, before.length - 1, before[before.length - 1]!.length);
    };
    expect(at('"marker-in-a"')).toBe('v:packages/one/src/a.ts');
    expect(at('"marker-in-b"')).toBe('v:packages/two/src/b.ts');
  });
});
