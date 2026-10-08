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
 *   probe-bake [options]           the editor's probe bake on the village or blocks class (tools/perf/probe-bake-run.ts)
 *   export-size [options]          what an export downloads, raw/gzip/brotli (tools/perf/export-size.ts lists its options)
 *   trim [options]                 the trim material's GPU cost against the standard material on one mesh (tools/perf/trim-run.ts)
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
if (argv[0] === 'probe-bake') {
  const { runProbeBakeCli } = await import('./probe-bake-run');
  await runProbeBakeCli(argv.slice(1));
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
if (argv[0] === 'export-size') {
  const { runExportSizeCli } = await import('./export-size');
  await runExportSizeCli(argv.slice(1));
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
