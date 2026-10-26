/**
 * The surface cache's change tracking, measured (`node tools/perf/run.mjs relight …`):
 * how long a change takes to re-light at the per-frame GPU budget on this
 * host's GPU, at the display's 60 Hz cap, and what a settled scene costs.
 *
 * - `door`: the look scene's block room (rock walls, a ceiling, a 2 × 2 m
 *   door, a pillar) on a soil slab in 128 m of hills, the sun through the
 *   door and a lamp under the ceiling switched on and off.
 * - `village`: the village perf class's block ground and its 650 static
 *   props (their distance-field files made here from the class's own model
 *   files), its sun stepped by 1° a round.
 *
 * The page (relight-page.ts) runs the product's host and light pass; every
 * update is timestamped and the GPU's clock sampled (ms × clock ÷ max clock
 * is the time at full clock). The GPU resolve is held to its CPU twin.
 *
 *   --scenes a,b   door, village (default both)
 *   --rounds N     changes per scene (default 3)
 *   --budget MS    the frame's GPU budget (default the medium tier's)
 *   --no-models    the village without its props (its block ground alone)
 *   --load MS      a stand-in game frame of about MS ms GPU time before each update (default 6: the
 *                  village's frame at the cap; an idle page leaves the GPU at its floor clock), 0 for none
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/relight-<time>.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDistanceBricks, encodeDistanceBricks, readModelGeometry } from '@thirdlight/project-model';
import { DEFAULT_SURFACE_CACHE_MIB, DEFAULT_SURFACE_LIGHT_MS } from '@thirdlight/runtime';

import type { CacheLight } from '../../packages/three-adapter/src/surface-changes';
import { PERF_ROOT, REPO } from './backend';
import { gpuClockSampler, gpuMaxMhz, launchGpuBrowser, serveStatic } from './frame-run';
import type { RelightInput } from './relight-page';
import { villagePlan } from './village';
import { propGlb } from './village-assets';

type V3 = [number, number, number];

const unit = (v: number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const hexColour = (hex: string, k: number): V3 => [0, 2, 4].map((i) => (parseInt(hex.slice(1 + i, 3 + i), 16) / 255) ** 2.2 * k) as V3;
const sunLight = (travel: number[], colour: V3): CacheLight => ({ id: 'sun', kind: 'directional', on: true, position: [0, 0, 0], direction: unit(travel.map((v) => -v)), color: colour, range: 0, cone: 0, penumbra: 0 });

function doorInput(rounds: number, budgetMs: number, loadMs: number): RelightInput {
  const fill = (box: number[], block: string): { box: number[]; block: string } => ({ box, block });
  return {
    scene: 'door',
    grid: { min: [0, 0, 0], max: [24, 8, 24], cellSize: [1, 1, 1], origin: [0, 0, 0] },
    fills: [fill([0, 0, 0, 24, 1, 24], 'soil'), fill([8, 1, 8, 17, 5, 17], 'rock'), fill([9, 1, 9, 16, 4, 16], ''), fill([12, 1, 16, 14, 3, 17], ''), fill([14, 1, 12, 15, 3, 13], 'rock')],
    terrain: { origin: [-52, 0, -52], samples: 65, spacing: 1, range: [-16, 48], tiles: [[0, 0], [1, 0], [0, 1], [1, 1]], bumps: [[64, 112, 12], [24, 40, 9], [108, 76, 10], [36, 104, 8], [100, 20, 7]], flat: [64, 64, 24] },
    models: [],
    files: {},
    eye: [10, 2.6, 9.6],
    lights: [sunLight([0.15, -0.55, -0.82], hexColour('#fff0dc', 3)), { id: 'lamp', kind: 'point', on: false, position: [12.5, 3.7, 12.5], direction: [0, -1, 0], color: hexColour('#fff0d8', 12), range: 10, cone: 0, penumbra: 0 }],
    event: 'lamp',
    rounds,
    budgetMs,
    cacheMiB: DEFAULT_SURFACE_CACHE_MIB,
    // The room's inside: its floor, walls, ceiling and pillar.
    room: { min: [9, 1, 9], max: [16, 4, 16] },
    loadMs,
  };
}

function villageInput(rounds: number, budgetMs: number, loadMs: number): RelightInput {
  const plan = villagePlan();
  const files: Record<string, string> = {};
  for (const p of plan.props) {
    const g = readModelGeometry(new Uint8Array(propGlb(p.seed, p.spec)));
    if (!g.ok) throw new Error(`relight: ${p.assetId}: ${g.message}`);
    files[p.assetId] = Buffer.from(encodeDistanceBricks(buildDistanceBricks(g.geometry))).toString('base64');
  }
  const models: RelightInput['models'] = [];
  let ground: { cellSize: V3; bounds: { min: V3; max: V3 }; at: V3 } | null = null;
  for (const e of plan.batches.flat()) {
    const c = e.components as Record<string, Record<string, unknown>>;
    const t = c['transform'] as { position: V3; rotation: [number, number, number, number]; scale: V3 } | undefined;
    if (c['blockLayer'] !== undefined && t !== undefined) {
      const b = c['blockLayer'] as { cellSize: V3; bounds: { min: V3; max: V3 } };
      ground = { cellSize: b.cellSize, bounds: b.bounds, at: t.position };
    }
    const m = c['model'] as { asset: { assetId: string } } | undefined;
    if (m === undefined || t === undefined || (e as { static?: boolean }).static !== true || files[m.asset.assetId] === undefined) continue;
    const [x, y, z, w] = t.rotation;
    const s = t.scale;
    // Column-major 4 × 4 of position, rotation and scale (three's compose).
    models.push({
      assetId: m.asset.assetId,
      world: [
        (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
        2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
        2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
        t.position[0], t.position[1], t.position[2], 1,
      ],
    });
  }
  if (ground === null) throw new Error('relight: the village has no block ground');
  return {
    scene: 'village',
    grid: { min: ground.bounds.min, max: ground.bounds.max, cellSize: ground.cellSize, origin: ground.at },
    fills: plan.groundEdits.map((ed) => ({ box: ed['box'] as number[], block: String((ed['cell'] as { block: string }).block) })),
    terrain: null,
    models,
    files,
    eye: plan.camera.position,
    lights: [sunLight([0.55, -0.45, -0.7], hexColour('#ffd9a8', 2))],
    event: 'sun',
    rounds,
    budgetMs,
    cacheMiB: DEFAULT_SURFACE_CACHE_MIB,
    room: null,
    loadMs,
  };
}

interface LoopResult {
  frames: number;
  wallMs: number;
  settled: boolean;
  texels: number;
  gpuMsMax: number | null;
  gpuMsMedian: number | null;
  cpuMsMax: number;
  cpuMsMedian: number;
  missed: number;
  roomMs: number | null;
  roomFrames: number | null;
  loadMs: number | null;
  passMsMedian: (number | null)[];
  nsPerTexelMedian: number | null;
  relight: Record<string, unknown>;
  cache: Record<string, unknown>;
  change?: string;
}

export async function runRelightCli(argv: readonly string[]): Promise<void> {
  const arg = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1]! : d;
  };
  const scenes = arg('--scenes', 'door,village').split(',');
  const rounds = Number(arg('--rounds', '3'));
  const budgetMs = Number(arg('--budget', String(DEFAULT_SURFACE_LIGHT_MS)));
  const loadMs = Number(arg('--load', '6'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = join(PERF_ROOT, 'runs', `relight-${stamp}`);
  mkdirSync(root, { recursive: true });
  const esbuild = await import('esbuild');
  await esbuild.build({ entryPoints: [join(REPO, 'tools', 'perf', 'relight-page.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: join(root, 'relight.js'), logLevel: 'warning' });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>relight</title><script src="relight.js"></script>');
  const site = await serveStatic(root);
  const browser = await launchGpuBrowser({ vsync: true });
  const maxMhz = gpuMaxMhz();
  const out: Record<string, unknown> = {};
  try {
    const p = await (await browser.newContext()).newPage();
    p.on('console', (m) => {
      if (m.type() === 'error') console.log(`relight page: ${m.text()}`);
    });
    await p.goto(`${site.url}/index.html`);
    for (const name of scenes) {
      const input = name === 'door' ? doorInput(rounds, budgetMs, loadMs) : villageInput(rounds, budgetMs, loadMs);
      if (argv.includes('--no-models')) input.models = [];
      const clock = gpuClockSampler();
      const got = (await p.evaluate((i) => (window as unknown as { __tlRelight: { run(i: unknown): Promise<Record<string, unknown>> } }).__tlRelight.run(i), input)) as Record<string, unknown>;
      const mhz = clock?.stop() ?? null;
      if (got['error'] !== undefined) throw new Error(`relight: ${String(got['error'])}`);
      out[name] = { ...got, gpuMhz: mhz };
      const line = (label: string, r: LoopResult): string => {
        const full = r.gpuMsMax !== null && mhz !== null && maxMhz !== null ? ` (${((r.gpuMsMax * mhz) / maxMhz).toFixed(2)} at full clock)` : '';
        const room = r.roomMs !== null ? ` (the room's texels in ${r.roomMs.toFixed(0)} ms, ${r.roomFrames} frames)` : '';
        return `${name.padEnd(8)} ${label.padEnd(12)} ${r.settled ? 'settled' : 'NOT settled'} in ${r.wallMs.toFixed(0)} ms${room}, ${r.frames} frames, ${r.texels} texels; GPU ms/frame max ${r.gpuMsMax?.toFixed(2) ?? '-'}${full} median ${r.gpuMsMedian?.toFixed(2) ?? '-'}; main ${r.cpuMsMedian.toFixed(2)} / ${r.cpuMsMax.toFixed(2)} ms; missed ${r.missed}; texels/frame ${String((r.relight as { texelsPerFrame?: number }).texelsPerFrame)}; load ${r.loadMs?.toFixed(2) ?? '-'} ms; passes ${r.passMsMedian.map((v) => v?.toFixed(2) ?? '-').join('/')} ms, ${r.nsPerTexelMedian?.toFixed(0) ?? '-'} ns/texel`;
      };
      console.log(line('cold', got['cold'] as LoopResult));
      console.log(`${name.padEnd(8)} still        frames with work in 30: ${(got['still'] as { framesWithWork: number }).framesWithWork}`);
      for (const e of got['events'] as LoopResult[]) console.log(line(e.change ?? '', e));
      const r = got['resolve'] as { rays: number; resolved: number; mismatches: number; tableBytes: number };
      console.log(`${name.padEnd(8)} resolve      ${r.resolved} of ${r.rays} hits resolved, GPU≠CPU ${r.mismatches}, table ${r.tableBytes} B; GPU ${mhz ?? '-'} MHz of ${maxMhz ?? '-'}`);
    }
  } finally {
    await browser.close();
    await site.close();
  }
  rmSync(root, { recursive: true, force: true });
  const report = join(PERF_ROOT, 'reports', `relight-${stamp}.json`);
  mkdirSync(join(report, '..'), { recursive: true });
  writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), gpuMaxMhz: maxMhz, budgetMs, rounds, scenes: out }, null, 2));
  console.log(`relight: report ${report}`);
}
