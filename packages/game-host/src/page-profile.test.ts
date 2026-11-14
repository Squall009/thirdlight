import { describe, expect, it } from 'vitest';

import { frameArbiter, SpanRecorder, threadProfiler, wallClock } from '@thirdlight/shared';
import { PageProfile, PROFILE_HOOK, PROFILE_SPIKE_FACTOR, PROFILE_SPIKES } from './page-profile';

/** A page frame from `at` (wall ms) with one span of `ms` in it, ended now. */
function frame(p: PageProfile, at: number, name = 'render frame', ms = 1): void {
  p.frameStart(at);
  threadProfiler.add(threadProfiler.span(name, 'render'), at, ms);
  p.frameEnd(10, 1000, at + ms + 1);
}

describe('the page profile', () => {
  it('keeps a long frame with what the page, the simulation and the job workers did over it', () => {
    const p = new PageProfile();
    p.follow(30, 'low');
    expect(frameArbiter.intervalMs).toBeCloseTo(1000 / 30, 6);
    const t0 = wallClock() - 2000;
    for (let i = 0; i < 5; i++) frame(p, t0 + i * 33.3);
    // The worker's tick and a job over the same stretch, posted as a worker posts them.
    const worker = new SpanRecorder('sim');
    const step = worker.span('step', 'other');
    const job = worker.span('job derive', 'voxelMesh');
    worker.beginFrame(t0 + 140);
    worker.tick(9);
    worker.add(step, t0 + 141, 3);
    worker.job(job, 1, t0 + 150, 20);
    worker.endFrame(t0 + 160);
    p.simFrames(worker.pack()!, { pools: 1, workers: 2, queued: 3, backgroundQueued: 0, inFlight: 2 });
    // The next frame starts 200 ms after the last: past the spike threshold at 30 Hz.
    frame(p, t0 + 4 * 33.3 + 200);
    const r = p.read();
    expect(r.spikes.length).toBe(1);
    const s = r.spikes[0]!;
    expect(s.reason).toBe('interval');
    expect(s.thresholdMs).toBeCloseTo(PROFILE_SPIKE_FACTOR * (1000 / 30), 6);
    expect(s.ms).toBeCloseTo(200, 0);
    expect(s.threads.page.length).toBe(2);
    expect(s.threads.sim.map((f) => f.tick)).toEqual([9]);
    expect(s.threads.jobs.flatMap((f) => f.spans.map((x) => [x.name, x.lane]))).toEqual([['job derive', 1]]);
    // The budget rows: the job workers' use is a frame's sum over the workers, against one worker's budget.
    const jobsRow = r.budget.rows.find((x) => x.thread === 'jobs' && x.category === 'voxelMesh')!;
    expect(jobsRow.worstMs).toBe(10);
    expect(jobsRow.budgetMs).toBeCloseTo(0.8 * (1000 / 30), 6);
    expect(r.budget.tier).toBe('low');
    expect(r.counters.queues?.queued).toBe(3);
    expect(r.counters.frames.at(-1)).toMatchObject({ drawCalls: 10, triangles: 1000 });
    expect(r.slices.find((x) => x.id === 'voxelBatch')!.msNow).toBeCloseTo(0.25 * (1000 / 30), 6);
    expect(r.gpu).toEqual({ timestamps: false, shares: null, room: 'not measurable here' });
    expect(r.cost.nsPerSpan).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('keeps only the newest spikes, and a frame within its interval is none', () => {
    const p = new PageProfile();
    p.follow(60, 'medium');
    const t0 = wallClock() - 5000;
    let t = t0;
    frame(p, t);
    for (let i = 0; i < PROFILE_SPIKES + 3; i++) {
      t += 100;
      frame(p, t);
      t += 16;
      frame(p, t);
    }
    expect(p.read().spikes.length).toBe(PROFILE_SPIKES);
    const q = new PageProfile();
    q.follow(60, 'medium');
    for (let i = 0; i < 10; i++) frame(q, wallClock() - 1000 + i * 16);
    expect(q.read().spikes.length).toBe(0);
  });

  it('passes a reader\'s cursor on through the page\'s global (only the spikes since come back)', () => {
    const g = globalThis as Record<string, unknown>;
    delete g[PROFILE_HOOK];
    const p = new PageProfile();
    p.attach({});
    p.follow(30, 'low');
    const hook = g[PROFILE_HOOK] as { read(after?: unknown): { spikes: unknown[]; seq: unknown } };
    const t0 = wallClock() - 3000;
    frame(p, t0);
    frame(p, t0 + 200);
    for (let i = 1; i < 6; i++) frame(p, t0 + 200 + i * 33.4);
    const first = hook.read();
    expect(first.spikes.length).toBe(1);
    expect(hook.read(first.seq).spikes.length).toBe(0);
    delete g[PROFILE_HOOK];
  });

  it('counts one missed frame under a 30 Hz cap on a 60 Hz display (50 ms between frames) as a spike, and 35 ms as none', () => {
    const p = new PageProfile();
    p.follow(30, 'low');
    const t0 = wallClock() - 2000;
    for (let i = 0; i < 4; i++) frame(p, t0 + i * 33.4);
    frame(p, t0 + 3 * 33.4 + 35);
    expect(p.read().spikes.length).toBe(0);
    frame(p, t0 + 3 * 33.4 + 35 + 50);
    const s = p.read().spikes;
    expect(s.map((x) => [x.reason, Math.round(x.ms)])).toEqual([['interval', 50]]);
  });

  it('shows the GPU as pass shares, never as milliseconds', () => {
    const p = new PageProfile();
    p.attach({ gpuPasses: () => ({ renderMs: 6, computeMs: 2 }), meter: () => true });
    expect(p.read().gpu).toEqual({ timestamps: true, shares: { render: 0.75, compute: 0.25 }, room: 'headroom meter' });
  });

  it('counts the interaction field from the adapter\'s diagnostics (none: null)', () => {
    const p = new PageProfile();
    let field: unknown = undefined;
    p.attach({ diagnostics: () => ({ ok: true, diagnostics: field === undefined ? {} : { interaction: { objects: [], field } } }) });
    expect(p.read().counters.interaction).toBeNull();
    field = { live: true, stamps: 9, passes: 4, centre: [0, 0], bytes: 2_098_944 };
    expect(p.read().counters.interaction).toEqual({ stamps: 9, live: true, bytes: 2_098_944 });
  });

  it('counts the stored copies drawn as table rows from the occlusion diagnostics (no table: null)', () => {
    const p = new PageProfile();
    let copies: unknown = null;
    p.attach({ diagnostics: () => ({ ok: true, diagnostics: { occlusion: { copies } } }) });
    expect(p.read().counters.copyRows).toBeNull();
    copies = { sets: 50, copies: 3000, rows: 50, lists: 50, inView: 900, listed: 1400, bytes: 4096, runs: 12, drawn: 860, triangles: 120_000 };
    expect(p.read().counters.copyRows).toEqual({ sets: 50, copies: 3000, rows: 50, lists: 50, inView: 900, listed: 1400, drawn: 860, triangles: 120_000, bytes: 4096 });
    // Ground cover's point sets as rows of the same table: counted apart.
    expect(p.read().counters.coverRows).toBeNull();
    copies = { ...(copies as object), cover: { sets: 2, copies: 131_072, rows: 6, lists: 4, inView: 13_000, drawn: 9_000, triangles: 160_000 } };
    expect(p.read().counters.coverRows).toEqual({ sets: 2, points: 131_072, rows: 6, lists: 4, inView: 13_000, drawn: 9_000, triangles: 160_000 });
  });
});
