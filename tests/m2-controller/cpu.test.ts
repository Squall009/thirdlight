/**
 * Packet 32 — CPU cost of the composed fixed step, measured on the packet-14
 * fixture/reference setup (`tests/evaluations/m2-physics/course-spec.json`,
 * 64 static colliders + 1 kinematic capsule at 120 Hz) with the packet-14
 * protocol: 3 runs × (5 s warmup + 30 s measure), `process.hrtime.bigint()`,
 * percentiles of the whole fixed step the runtime executes
 * (`controller → physics → transform`), i.e. `runtime.tick()` for one step.
 *
 * These numbers are **container/Node directional (BR-2)** — this is not the
 * reference desktop and not a browser; there is no GPU claim and no product
 * budget claim. The only assertion is the 8.333 ms whole-tick budget sanity
 * bound; the recorded percentiles are the evidence.
 */
import { describe, expect, it } from 'vitest';
import { createStepInputSource, type StepInputStep } from '@thirdlight/input';
import { fixture, startRun, DT, type CourseFile } from './helpers';

const course = fixture<CourseFile>('course.json');
const inputFile = fixture<{ atoms: Record<string, unknown>; sequences: { id: string; spans: { from: number; to: number; raw: string }[] }[] }>(
  'input-sequences.json',
);

function stepsOf(id: string): StepInputStep[] {
  const seq = inputFile.sequences.find((s) => s.id === id)!;
  const out: StepInputStep[] = [];
  for (const span of seq.spans) {
    for (let i = span.from; i <= span.to; i += 1) out.push({ stepIndex: i, raw: inputFile.atoms[span.raw] as never });
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

describe('directional container CPU cost (packet-14 protocol, BR-2)', () => {
  it('measures the composed fixed step over 3 runs of 5 s warmup + 30 s sample', async () => {
    const warmupSteps = 5 * 120;
    const measureSteps = 30 * 120;
    // The recorded sequence covers 240 steps; the input repeats the last atom
    // (right held) for the measurement window.
    const base = stepsOf('run-right-240');
    const actions: StepInputStep[] = [];
    for (let i = 12; i <= 12 + warmupSteps + measureSteps + 8; i += 1) {
      const from = base.find((s) => s.stepIndex === i);
      actions.push(from ?? { stepIndex: i, raw: inputFile.atoms['idle'] as never });
    }
    const runs: { run: number; samples: number; p50: number; p95: number; p99: number }[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = await startRun(course, { x: -10, y: 0.9 }, {
        actions: createStepInputSource(actions.map((s) => ({ stepIndex: s.stepIndex, raw: s.raw }))),
      });
      try {
        started.steps(warmupSteps);
        const timings: number[] = [];
        for (let i = 0; i < measureSteps; i += 1) {
          const t0 = process.hrtime.bigint();
          started.steps(1);
          const t1 = process.hrtime.bigint();
          timings.push(Number(t1 - t0) / 1e6);
        }
        timings.sort((a, b) => a - b);
        runs.push({
          run,
          samples: timings.length,
          p50: percentile(timings, 50),
          p95: percentile(timings, 95),
          p99: percentile(timings, 99),
        });
      } finally {
        started.dispose();
      }
    }
    const summary = {
      machine: 'container (NOT the reference desktop — directional only, plan-review BR-2)',
      node: process.version,
      fixture: '1 kinematic capsule + 64 static colliders (fixtures/m2/course/course.json)',
      warmupS: 5,
      measureS: 30,
      stepBudgetMs: 1 / DT / 120 === 0 ? 0 : 8.333333333333334,
      runs: runs.map((r) => ({ ...r, p50: Number(r.p50.toFixed(6)), p95: Number(r.p95.toFixed(6)), p99: Number(r.p99.toFixed(6)) })),
    };
    // eslint-disable-next-line no-console
    console.log(`[cpu] ${JSON.stringify(summary)}`);
    for (const r of runs) {
      expect(r.samples).toBe(measureSteps);
      // Sanity only: the whole 120 Hz tick budget is 8.333 ms (packet-14 §7).
      expect(r.p99).toBeLessThan(8.333333333333334);
    }
  }, 600_000);
});
