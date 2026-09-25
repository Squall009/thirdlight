/**
 * Phase 21.5: the leak tests' probe. After a garbage collection through CDP
 * (`HeapProfiler.collectGarbage`) it reads:
 *
 * - the JS heap of the page's renderer process (`Runtime.getHeapUsage`:
 *   V8's used size plus the array-buffer backing stores, where reported) —
 *   the editor and its same-site Play iframe share one process;
 * - the graphics API counts of the perf harness's instrumentation
 *   (tools/perf/instrument.ts), per live WebGL context / WebGPU device:
 *   programs, textures, buffers, vertex arrays, and how many contexts and
 *   devices are alive — a context that was lost or collected and a
 *   destroyed device freed their resources and drop out;
 * - the Scene view renderer's own `info.memory` counts (`data-memory` on the
 *   Scene view canvas, written after each frame).
 *
 * `settle` polls until a sample is back within the tolerance of a baseline
 * (releases finish asynchronously: a renderer's dispose promise, a device
 * destroy, the collector) and returns the last sample either way, so the
 * test's assertion prints the numbers.
 */
import { expect, type BrowserContext, type CDPSession, type Frame, type Page } from '@playwright/test';

import { installPerfInstrumentation, readGpuLive, type GpuLive } from '../../tools/perf/instrument';

export type Counts = Record<string, number>;

export interface MemorySample {
  heapMiB: number;
  /** Array-buffer backing stores and external strings (MiB; 0 where CDP does not report them). */
  backingMiB: number;
  gpu: GpuLive;
  /** The Scene view renderer's `info.memory` counts (absent: no Scene view on this page). */
  sceneView: Counts | null;
}

export interface Tolerance {
  /** Allowed heap growth (MiB). */
  heapMiB: number;
  /** Allowed growth of every GPU count (programs, textures, buffers, vertex arrays, renderer counts). */
  counts: number;
}

/**
 * Default tolerance. Counts: one object per cycle over 50 cycles is far
 * outside it. Heap: the leaks fixed in 21.5 retained 55–110 KiB per cycle
 * (3–5.5 MiB over 50 cycles); after the fixes the editor surfaces still grow
 * 0.2–1.9 MiB over 50 cycles on this shared host (V8's compiled code and the
 * performance timeline grow while the page runs — a Play heap snapshot put
 * ~80 % of its growth there), so 3 MiB keeps a real per-cycle leak out
 * without failing on warm-up.
 */
export const TOLERANCE: Tolerance = { heapMiB: 3, counts: 2 };

export async function installProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(installPerfInstrumentation);
}

export class MemoryProbe {
  private constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async attach(page: Page): Promise<MemoryProbe> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Runtime.enable');
    return new MemoryProbe(page, cdp);
  }

  /** One sample after a full collection (`frame`: whose GPU counts; default the page). */
  async sample(frame?: Frame): Promise<MemorySample> {
    // Several passes: finalizers and weak callbacks free more on the next one.
    for (let i = 0; i < 3; i++) await this.cdp.send('HeapProfiler.collectGarbage');
    const heap = (await this.cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number };
    const gpu = await (frame ?? this.page.mainFrame()).evaluate(readGpuLive);
    const raw = frame === undefined ? await this.page.locator('canvas.tl-viewport').first().getAttribute('data-memory', { timeout: 2_000 }).catch(() => null) : null;
    return {
      heapMiB: round(heap.usedSize / 1048576),
      backingMiB: round((heap.backingStorageSize ?? 0) / 1048576),
      gpu,
      sceneView: raw !== null ? (JSON.parse(raw) as Counts) : null,
    };
  }

  /** Poll until `now` is within `tol` of `base` (or the time is up); the last sample. */
  async settle(base: MemorySample, tol: Tolerance = TOLERANCE, frame?: Frame, timeoutMs = 20_000): Promise<MemorySample> {
    const until = Date.now() + timeoutMs;
    let now = await this.sample(frame);
    while (overBy(base, now, tol).length > 0 && Date.now() < until) {
      await this.page.waitForTimeout(500);
      now = await this.sample(frame);
    }
    return now;
  }

  async detach(): Promise<void> {
    await this.cdp.detach().catch(() => undefined);
  }
}

const round = (x: number): number => Math.round(x * 100) / 100;

const GPU_KEYS = ['webglContexts', 'webgpuDevices', 'programs', 'textures', 'buffers', 'vaos'] as const;

/** What grew beyond the tolerance (empty: back to the baseline). */
export function overBy(base: MemorySample, now: MemorySample, tol: Tolerance = TOLERANCE): string[] {
  const out: string[] = [];
  if (now.heapMiB > base.heapMiB + tol.heapMiB) out.push(`heap ${base.heapMiB} → ${now.heapMiB} MiB`);
  for (const k of GPU_KEYS) {
    // Contexts and devices must be back exactly: one left behind is a leak whatever it holds.
    const slack = k === 'webglContexts' || k === 'webgpuDevices' ? 0 : tol.counts;
    if (now.gpu[k] > base.gpu[k] + slack) out.push(`gpu.${k} ${base.gpu[k]} → ${now.gpu[k]}`);
  }
  // Workers this frame started and did not terminate (a worker per job must end with its job).
  const live = (s: MemorySample): number => s.gpu.workers.created - s.gpu.workers.terminated;
  if (live(now) > live(base)) out.push(`workers alive ${live(base)} → ${live(now)}`);
  if (base.sceneView !== null && now.sceneView !== null) {
    for (const [k, v] of Object.entries(now.sceneView)) {
      // three 0.186 counts a node-made attribute again whenever a render object is rebuilt (a light
      // entering the view rebuilds an instanced batch's: four new attribute objects on the same GPU
      // buffer) and never counts the old ones out; the GPU buffers are the API counts above.
      if (k === 'attributes') continue;
      const b = base.sceneView[k] ?? 0;
      if (v > b + tol.counts) out.push(`sceneView.${k} ${b} → ${v}`);
    }
  }
  return out;
}

/** A one-line summary for the log and the plan's results table. */
export function describe(label: string, base: MemorySample, now: MemorySample, cycles: number): string {
  const g = (s: MemorySample): string => `ctx ${s.gpu.webglContexts}+${s.gpu.webgpuDevices} prog ${s.gpu.programs} tex ${s.gpu.textures} buf ${s.gpu.buffers} vao ${s.gpu.vaos}`;
  const sv = (s: MemorySample): string => (s.sceneView === null ? '' : ` | view geo ${s.sceneView['geometries']} tex ${s.sceneView['textures']} attr ${s.sceneView['attributes']} rt ${s.sceneView['renderTargets']}`);
  return `[memory] ${label} ×${cycles}: heap ${base.heapMiB} → ${now.heapMiB} MiB (backing ${base.backingMiB} → ${now.backingMiB}) | ${g(base)} → ${g(now)}${sv(base)} →${sv(now)} | workers +${now.gpu.workers.created - base.gpu.workers.created}/-${now.gpu.workers.terminated - base.gpu.workers.terminated}`;
}

/** Assert (softly: the next scenario still runs and reports) that `now` is back within the tolerance of `base`. */
export function expectBack(label: string, base: MemorySample, now: MemorySample, tol: Tolerance = TOLERANCE): void {
  expect.soft(overBy(base, now, tol), `${label}: not back to the baseline`).toEqual([]);
}

/** Cycles per scenario (TL_MEMORY_CYCLES overrides for quick local runs). */
export function cycles(n: number): number {
  const env = Number(process.env['TL_MEMORY_CYCLES']);
  return Number.isFinite(env) && env > 0 ? Math.min(n, env) : n;
}
