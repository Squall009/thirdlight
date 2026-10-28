/**
 * The harness command line (bundled and started by run.mjs).
 *
 *   --classes small,medium,...     benchmark classes (default: all six)
 *   --renderers webgl2,webgpu      renderer backends (default: webgl2; webgpu/auto add the WebGPU flags; legacy = webgl2)
 *   --surfaces play,export,editor,sim
 *   --quick                        short windows (a smoke run)
 *   --record-ms N --warmup-ms N --commands N --sim-steps N --viewport WxH --seed N
 *   --plays N                      Plays per class (each start split into stages; later ones reuse the editor page)
 *   --gpu                          draw on the host's GPU (ANGLE on Vulkan, real WebGPU) instead of SwiftShader
 *   --keep                         keep the generated projects and exports under ~/.cache/thirdlight-perf/runs/
 *   --out FILE                     report path (default ~/.cache/thirdlight-perf/reports/<time>.json)
 *   --write-baseline FILE          also write the run's relative metrics as a baseline (tests/perf/baseline.json)
 *   --compare FILE                 compare the run against a baseline; exit 1 on a regression
 *
 *   scale [options]                the scale bench instead (tools/perf/scale-run.ts lists its options)
 *   ports [options]                parallel backend starts (tools/perf/port-stress.ts lists its options)
 *   village [options]              the village class's export against plain three.js (tools/perf/village-run.ts lists its options)
 *   level [options]                the level-building classes, block area and landscape (tools/perf/level-run.ts lists its options)
 *   blocks [options]               block meshing hitches on the blocks class (tools/perf/blocks-run.ts lists its options)
 *   bake [options]                 the editor's "Bake lighting" on the village or blocks class (tools/perf/bake-run.ts)
 *   export-size [options]          what an export downloads, raw/gzip/brotli (tools/perf/export-size.ts lists its options)
 *   trim [options]                 the trim material's GPU cost against the standard material on one mesh (tools/perf/trim-run.ts)
 *   meadow [options]               the meadow class (1 km² of terrain under grass cover) at the 60 Hz cap, and the GPU grass density sweep (tools/perf/meadow-run.ts)
 *   pipe [options]                 the pipe scene played with real input at the 60 Hz cap: the frames round the switches into a side-view plane and back (tools/perf/pipe-run.ts)
 *   gpu-features [--out FILE]      the host's WebGPU adapter: features, limits, WGSL language features, storage-texture formats per access (tools/perf/gpu-features.ts)
 *   cache-spike [options]          the surface-cache spike: one block room's cache re-lit by traced rays at the 60 Hz cap (tools/perf/cache-spike-run.ts)
 *   relight [options]              the surface cache's change tracking on the GPU at the 60 Hz cap: a lamp switched in the door room, the sun stepped on the village, time to settled at the per-frame budget (tools/perf/relight-run.ts)
 *   tracer [options]               the lighting tracer per geometry kind on the GPU at the 60 Hz cap: cost per ray in random order and grouped, GPU hits against the CPU twin (tools/perf/tracer-run.ts)
 *   look [options]                 the look-reference scenes (a room lit through a door, a building at sunset, a corridor of rect and line lights, a sign at night) baked, measured at the 60 Hz cap and photographed on both renderers (tools/perf/look-run.ts)
 *   lights [options]               the many-lights class: 64, 256 and 1,000 point and spot lights (some shadowed, a few area lights) over a floor and pillars, at the 60 Hz cap on both renderers (tools/perf/lights-run.ts)
 *   look-accept [options]          the look scenes played: the starter character walking, a block dug, the sun run through the day, a lamp switched behind a shut door; frame windows and re-light times at the 60 Hz cap, shots and a webm per scene (tools/perf/look-accept.ts)
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { baselineOf, parseArgs, runHarness } from './harness';
import { compare, type Metric } from './stats';

const argv = process.argv.slice(2);
if (argv[0] === 'scale') {
  const { runScaleCli } = await import('./scale-run');
  await runScaleCli(argv.slice(1));
  process.exit(0);
}
if (argv[0] === 'village') {
  const { runVillageCli } = await import('./village-run');
  await runVillageCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'level') {
  const { runLevelCli } = await import('./level-run');
  await runLevelCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'bake') {
  const { runBakeCli } = await import('./bake-run');
  await runBakeCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'blocks') {
  const { runBlocksCli } = await import('./blocks-run');
  await runBlocksCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'trim') {
  const { runTrimCli } = await import('./trim-run');
  await runTrimCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'meadow') {
  const { runMeadowCli } = await import('./meadow-run');
  await runMeadowCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'pipe') {
  const { runPipeCli } = await import('./pipe-run');
  await runPipeCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'gpu-features') {
  const { runGpuFeaturesCli } = await import('./gpu-features');
  await runGpuFeaturesCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'cache-spike') {
  const { runCacheSpikeCli } = await import('./cache-spike-run');
  await runCacheSpikeCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'relight') {
  const { runRelightCli } = await import('./relight-run');
  await runRelightCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'tracer') {
  const { runTracerCli } = await import('./tracer-run');
  await runTracerCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'look') {
  const { runLookCli } = await import('./look-run');
  await runLookCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'lights') {
  const { runLightsCli } = await import('./lights-run');
  await runLightsCli(argv.slice(1));
  process.exit(0);
}
if (argv[0] === 'look-accept') {
  const { runLookAcceptCli } = await import('./look-accept');
  await runLookAcceptCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'export-size') {
  const { runExportSizeCli } = await import('./export-size');
  await runExportSizeCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'plane-step') {
  const { runPlaneStepCli } = await import('./plane-step-run');
  await runPlaneStepCli(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
if (argv[0] === 'ports') {
  const { runPortStress } = await import('./port-stress');
  await runPortStress(argv.slice(1));
  process.exit(process.exitCode ?? 0);
}
const opts = parseArgs(argv);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const { report, path } = await runHarness({ ...opts, log: (s) => console.log(s) });
console.log(`perf: report ${path}`);
for (const o of report.overBudget) console.log(`perf: over budget ${o.key} = ${o.value} (budget ${o.budget}; ${o.note})`);
for (const [cls, b] of Object.entries(report.benchmarks)) for (const e of b?.errors ?? []) console.log(`perf: ${cls} error: ${e}`);

const baselineOut = flag('write-baseline');
if (baselineOut !== undefined) {
  // Compact: one metric per line (the file is checked in and diffed).
  const { metrics, ...head } = baselineOf(report, flag('note') ?? 'relative metrics; CPU-rendered host') as { metrics: Record<string, Metric> };
  const lines = Object.entries(metrics).map(([k, m]) => `  ${JSON.stringify(k)}: ${JSON.stringify(m)}`);
  writeFileSync(baselineOut, `${JSON.stringify(head).slice(0, -1)},\n "metrics": {\n${lines.join(',\n')}\n }\n}\n`);
  console.log(`perf: baseline written to ${baselineOut}`);
}
const against = flag('compare');
if (against !== undefined) {
  const base = JSON.parse(readFileSync(against, 'utf8')) as { metrics: Record<string, Metric> };
  const c = compare(base.metrics, report.metrics);
  for (const r of c.regressions) console.log(`perf: REGRESSION ${r.key}: ${r.value} > ${r.limit} (baseline ${r.baseline})`);
  for (const r of c.improvements) console.log(`perf: improved ${r.key}: ${r.value} (baseline ${r.baseline}) — update the baseline`);
  console.log(`perf: compared ${c.compared} metrics, ${c.regressions.length} regressions, ${c.missing.length} not measured`);
  if (c.regressions.length > 0) process.exitCode = 1;
}
