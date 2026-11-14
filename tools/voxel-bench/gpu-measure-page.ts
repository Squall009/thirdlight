/**
 * A bench's call of the page's GPU measurement (game-host gpu-measure.ts, the
 * Profiler's "Measure GPU"): started through the profile's global
 * (`__tlProfiler.gpu`), polled once a second until it ends.
 */
import type { GpuMeasureState, GpuMeasurement } from '@thirdlight/game-host';

/** Runs `start` (with the options) or `state` on the page and answers its state (a Frame's or a Locator's evaluate, wrapped). */
export type GpuMeasureCall = (call: 'start' | 'state', options?: { repeats?: number; windowS?: number }) => Promise<GpuMeasureState>;

/** What a page evaluates for {@link GpuMeasureCall}. */
export function gpuMeasureOnPage(arg: { call: 'start' | 'state'; options?: unknown }): GpuMeasureState {
  const g = (window as unknown as { __tlProfiler?: { gpu?: { start(o: unknown): GpuMeasureState; state(): GpuMeasureState } } }).__tlProfiler?.gpu;
  if (g === undefined) return { state: 'unavailable', reason: 'the page has no profile global' };
  return arg.call === 'start' ? g.start(arg.options ?? {}) : g.state();
}

export async function measureGpuOnPage(call: GpuMeasureCall, wait: (ms: number) => Promise<void>, options: { repeats?: number; windowS?: number } = {}, timeoutMs = 600_000): Promise<GpuMeasurement> {
  const started = await call('start', options);
  if (started.state === 'unavailable') throw new Error(`GPU measurement: ${started.reason}`);
  const t0 = Date.now();
  for (;;) {
    await wait(1000);
    const st = await call('state');
    if (st.state === 'done') return st.result;
    if (st.state === 'failed') throw new Error(`GPU measurement failed: ${st.error}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`GPU measurement did not end in ${timeoutMs / 1000} s`);
  }
}

/** One line of a measurement for a bench's log. */
export function gpuMeasureSummary(g: GpuMeasurement): string {
  return [
    `GPU measurement (${g.seconds} s): ballast ${g.ballast.n} × ${String(g.ballast.msPerUnit)} ms, frame ${g.ballast.frameMs} ms past the cap; frame GPU ${String(g.frameMs)} ms; resolution ${g.resolutionMs} ms (control ${g.noise.medianMs} ± ${g.noise.spreadMs}; ${g.noise.samples.join(' ')})`,
    ...g.categories.map((c) => `  ${c.category}: ${c.ms === null ? 'below resolution' : `${c.lowerBound ? '≥ ' : ''}${c.ms} ms`} (median ${c.medianMs}, spread ${c.spreadMs}; ${c.samples.join(' ')})`),
    `  absent: ${g.absent.join(', ') || 'none'}; budget ${g.budget.rows.map((b) => `${b.budget} ${String(b.ms)}/${b.budgetMs}`).join(', ')}`,
  ].join('\n');
}
