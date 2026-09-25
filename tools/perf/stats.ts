/**
 * Phase 21.1: percentiles, the relative metrics a report is judged by, the
 * budget check and the comparison against a stored baseline.
 *
 * This server renders on the CPU and shares its cores with other work, so
 * absolute times say little. A baseline therefore stores only
 * machine-independent numbers: counts (draw calls, programs, textures,
 * buffers, entities), memory (heap MiB, GPU MiB estimate, bytes per step) and
 * times divided by a calibration measured in the same run (browser frame
 * times by the raw-WebGL calibration page's frame time, Node times by the CPU
 * calibration workload). Real-GPU absolute numbers are owner look.
 */

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Nearest-rank percentiles (0 for an empty sample). */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
  return { n: s.length, p50: r3(at(0.5)), p95: r3(at(0.95)), p99: r3(at(0.99)), max: r3(s[s.length - 1]!), mean: r3(s.reduce((a, b) => a + b, 0) / s.length) };
}

/** How a metric is compared: counts and memory absolutely, times relative to a calibration. */
export type MetricKind = 'count' | 'memory' | 'ratio';

export interface Metric {
  value: number;
  kind: MetricKind;
}

/** Tolerances: a regression is `value > baseline × (1 + rel) + abs`. */
export const TOLERANCE: Readonly<Record<MetricKind, { rel: number; abs: number }>> = {
  // Counts are deterministic for a given build: a small slack for frame-to-frame culling.
  count: { rel: 0.1, abs: 2 },
  // Heap and GPU estimates move with GC timing and driver pools.
  memory: { rel: 0.25, abs: 2 },
  // Calibrated times still move with load on a shared CPU: generous.
  ratio: { rel: 0.75, abs: 0.25 },
};

export interface Regression {
  key: string;
  kind: MetricKind;
  baseline: number;
  value: number;
  limit: number;
}

export interface Comparison {
  regressions: Regression[];
  improvements: Regression[];
  missing: string[];
  compared: number;
}

/**
 * Compare a run's metrics against a baseline: worse beyond the tolerance is a
 * regression; better beyond it is listed (update the baseline); keys absent
 * from the run are listed as missing (a class or surface that was not run).
 */
export function compare(baseline: Readonly<Record<string, Metric>>, run: Readonly<Record<string, Metric>>, tolerance = TOLERANCE): Comparison {
  const regressions: Regression[] = [];
  const improvements: Regression[] = [];
  const missing: string[] = [];
  let compared = 0;
  for (const [key, base] of Object.entries(baseline)) {
    const got = run[key];
    if (got === undefined) {
      missing.push(key);
      continue;
    }
    compared += 1;
    const t = tolerance[base.kind];
    const limit = base.value * (1 + t.rel) + t.abs;
    if (got.value > limit) regressions.push({ key, kind: base.kind, baseline: base.value, value: got.value, limit: r3(limit) });
    else if (got.value < (base.value - t.abs) / (1 + t.rel)) improvements.push({ key, kind: base.kind, baseline: base.value, value: got.value, limit: r3(limit) });
  }
  return { regressions, improvements, missing, compared };
}

/** A fixed arithmetic workload (xorshift + float math); its median time scales with the CPU speed and the load. */
export function cpuCalibration(rounds = 5): number {
  const times: number[] = [];
  let sink = 0;
  for (let r = 0; r < rounds; r += 1) {
    const t0 = performance.now();
    let x = 2463534242;
    let acc = 0;
    for (let i = 0; i < 3_000_000; i += 1) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      acc += Math.sqrt((x >>> 0) % 1000) * 0.5;
    }
    sink += acc;
    times.push(performance.now() - t0);
  }
  // Keep the loop observable (never true).
  if (sink === -1) throw new Error('unreachable');
  times.sort((a, b) => a - b);
  return r3(times[Math.floor(times.length / 2)]!);
}
