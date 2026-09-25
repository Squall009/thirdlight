/**
 * Phase 21.1 (opt-in: TL_PERF=1): a performance run compared against the
 * checked-in baseline (tests/perf/baseline.json, relative metrics only — see
 * tools/perf/stats.ts). Fails on a regression beyond the tolerance.
 *
 *   npm run build
 *   TL_PERF=1 npx vitest run tests/perf/regression.test.ts
 *
 * By default it runs the harness for the baseline's classes, renderers and
 * surfaces (long: tens of minutes with the large class on a CPU-rendered
 * host). TL_PERF_REPORT=<report.json> compares an existing report instead;
 * TL_PERF_CLASSES=small,medium limits the run (and the comparison) to those;
 * TL_PERF_KINDS=count,memory compares only counts and memory.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compare, type Metric } from '../../tools/perf/stats';

const REPO = resolve(import.meta.dirname, '..', '..');

describe.skipIf(process.env['TL_PERF'] === undefined)('performance regression against the baseline (opt-in)', () => {
  it('no metric regressed beyond its tolerance', () => {
    const baseline = JSON.parse(readFileSync(join(import.meta.dirname, 'baseline.json'), 'utf8')) as { classes: string[]; renderers: string[]; surfaces: string[]; metrics: Record<string, Metric> };
    const classes = process.env['TL_PERF_CLASSES']?.split(',') ?? baseline.classes;
    let reportPath = process.env['TL_PERF_REPORT'];
    if (reportPath === undefined) {
      const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'), 'reports');
      mkdirSync(dir, { recursive: true });
      reportPath = join(dir, `regression-${Date.now()}.json`);
      const run = spawnSync(process.execPath, [join(REPO, 'tools', 'perf', 'run.mjs'), '--classes', classes.join(','), '--renderers', baseline.renderers.join(','), '--surfaces', baseline.surfaces.join(','), '--out', reportPath], { stdio: 'inherit', timeout: 3 * 3600_000 });
      expect(run.status, 'the harness run failed').toBe(0);
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { metrics: Record<string, Metric>; machine: { loadavgStart: number[]; loadavgEnd: number[] } };
    // TL_PERF_KINDS=count,memory skips the calibrated times (the noisiest on a shared, CPU-rendered host).
    const kinds = process.env['TL_PERF_KINDS']?.split(',') ?? ['count', 'memory', 'ratio'];
    const wanted = Object.fromEntries(Object.entries(baseline.metrics).filter(([k, m]) => classes.includes(k.split('.')[0]!) && kinds.includes(m.kind)));
    const c = compare(wanted, report.metrics);
    for (const r of c.improvements) console.log(`perf: improved ${r.key}: ${r.value} (baseline ${r.baseline}) — consider updating the baseline`);
    console.log(`perf: compared ${c.compared} metrics (load ${report.machine.loadavgStart.join(' ')} → ${report.machine.loadavgEnd.join(' ')}); ${c.missing.length} not measured`);
    expect(c.compared).toBeGreaterThan(0);
    expect(c.regressions, c.regressions.map((r) => `${r.key}: ${r.value} > ${r.limit} (baseline ${r.baseline})`).join('\n')).toEqual([]);
  });
});
