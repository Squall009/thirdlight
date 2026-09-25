/**
 * Phase 21.1: the harness command line (bundled and started by run.mjs).
 *
 *   --classes small,medium,...     benchmark classes (default: all five)
 *   --renderers webgl2,webgpu      renderer backends (default: webgl2; webgpu/auto add the WebGPU flags; legacy = webgl2 since 17.4)
 *   --surfaces play,export,editor,sim
 *   --quick                        short windows (a smoke run)
 *   --record-ms N --warmup-ms N --commands N --sim-steps N --viewport WxH --seed N
 *   --keep                         keep the generated projects and exports under ~/.cache/thirdlight-perf/runs/
 *   --out FILE                     report path (default ~/.cache/thirdlight-perf/reports/<time>.json)
 *   --write-baseline FILE          also write the run's relative metrics as a baseline (tests/perf/baseline.json)
 *   --compare FILE                 compare the run against a baseline; exit 1 on a regression
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { baselineOf, parseArgs, runHarness } from './harness';
import { compare, type Metric } from './stats';

const argv = process.argv.slice(2);
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
