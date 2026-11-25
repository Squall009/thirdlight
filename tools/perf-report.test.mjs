import { describe, expect, it } from 'vitest';

import { perfNumbers, perfReport } from './perf-report.mjs';

/** A headroom result trimmed to the fields the report reads. */
const headroom = (meanMs, gpuMs) => ({
  quality: 'low',
  viewport: { width: 1280, height: 720 },
  cap: { fps: 30 },
  start: { load: [1.2, 1.1, 1.0] },
  fillS: 9,
  memory: { pageHeapMiB: 553, gpuMiB: 978 },
  rounds: [{ noLoad: { frames: 89, missed: 0, meanMs, p50: 33.2, p95: 38.3 }, gpu: { frameMs: gpuMs, categories: [{ category: 'near', medianMs: 3.1 }, { category: 'shadows', medianMs: 0.6 }] } }],
});

describe('the phase performance report', () => {
  it('reads frame rate, frame time, GPU time and memory from a headroom run', () => {
    const n = perfNumbers(headroom(33.42, 9.14));
    expect(n).toMatchObject({ fps: 29.9, missed: 0, frames: 89, frameP50Ms: 33.2, frameP95Ms: 38.3, gpuFrameMs: 9.14, pageHeapMiB: 553, gpuMiB: 978, capFps: 30 });
    expect(n.gpuMs).toEqual({ near: 3.1, far: null, shadows: 0.6, lighting: null, post: null, effects: null });
  });

  it('shows the previous run beside this one, and dashes where a number is missing', () => {
    const md = perfReport(perfNumbers(headroom(33.42, 9.14)), perfNumbers(headroom(40, 11)), { previous: 'last phase' });
    expect(md).toContain('| GPU frame | 9.14 ms | 11 ms |');
    expect(md).toContain('| GPU far | — | — |');
    expect(md).toContain('never a gate');
    expect(perfReport(perfNumbers({ error: 'world not settled' }), null)).toContain('The bench reported an error: world not settled');
  });
});
