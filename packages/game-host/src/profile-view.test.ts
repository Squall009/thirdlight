import { describe, expect, it } from 'vitest';

import { SpanRecorder, threadProfiler, wallClock } from '@thirdlight/shared';
import { PageProfile } from './page-profile';
import { makeProfileCapture, parseProfileCapture, profileCaptureFileName, profileCaptureText, ProfileAccumulator, PROFILE_CAPTURE_VERSION } from './profile-capture';
import { profileBar, profileBreakdown, profileColumnAt, profileColumns, profileDigest, profileOverlayLines, PROFILE_DIGEST_MAX_BYTES } from './profile-view';
import { createStatsOverlay } from './stats-overlay';

const RENDER = threadProfiler.span('render frame', 'render');
const PROPS = threadProfiler.span('props test', 'props');

/** A page frame at `at` (wall ms): a render span of `ms` with a props span of 0.5 ms inside it. */
function pageFrame(p: PageProfile, at: number, ms = 4): void {
  p.frameStart(at);
  threadProfiler.add(RENDER, at, ms);
  threadProfiler.add(PROPS, at + 0.1, 0.5);
  p.frameEnd(12, 3400, at + ms + 0.2);
}

/** A simulation tick at `at` as the worker posts it (a step of `ms`, and a 6 ms job on worker 1). */
function simTick(p: PageProfile, worker: SpanRecorder, tick: number, at: number, ms = 2): void {
  worker.beginFrame(at);
  worker.tick(tick);
  worker.add(worker.span('step', 'scripts'), at + 0.1, ms);
  worker.job(worker.span('job derive', 'voxelMesh'), 1, at + 0.2, 6);
  worker.endFrame(at + ms + 0.5);
  p.simFrames(worker.pack()!, { pools: 1, workers: 2, queued: 0, backgroundQueued: 0, inFlight: 1 });
}

/** Where the next profile starts (the page's ring is the module's: each test's frames come after the last test's). */
let clock = wallClock() - 60_000;

/** A profile of `n` frames at 30 Hz with a tick in each, the 10th frame 120 ms late. */
function profile(n = 20): { p: PageProfile; worker: SpanRecorder; t0: number; t: number } {
  const p = new PageProfile();
  p.follow(30, 'low');
  const worker = new SpanRecorder('sim');
  const t0 = clock + 1000;
  let t = t0;
  for (let i = 0; i < n; i++) {
    pageFrame(p, t);
    simTick(p, worker, i, t + 5);
    t += i === 9 ? 120 : 33.3;
  }
  clock = t + 2000;
  return { p, worker, t0, t };
}

describe('the profile views', () => {
  it('lays every thread\'s frames into the page frame they started in, by category, and marks the long one', () => {
    const { p } = profile();
    const r = p.read();
    const cols = profileColumns(r).slice(-20);
    expect(cols.length).toBe(20);
    const c = cols[3]!;
    expect(c.lanes.page.byCategory.map(([k]) => k)).toEqual(['render', 'props']);
    // Both spans were added whole beside each other (not nested): 4 + 0.5 ms own time.
    expect(c.lanes.page.ms).toBeCloseTo(4.5, 3);
    expect(c.lanes.sim.byCategory).toEqual([['scripts', 2]]);
    // The job's 6 ms over the pools' 2 workers: what one worker spent, as the budget counts it.
    expect(c.lanes.jobs.byCategory).toEqual([['voxelMesh', 3]]);
    expect(cols.filter((x) => x.long).map((x) => x.index - cols[0]!.index)).toEqual([9]);
    expect(cols[9]!.intervalMs).toBeCloseTo(120, 6);
    // The newest has no next frame: its column ends a frame interval on.
    expect(cols.at(-1)!.intervalMs).toBeNull();
  });

  it('stacks a bar from the lane\'s bottom, a frame interval half way up, cut at the top', () => {
    const work = { ms: 30, byCategory: [['render', 10], ['props', 20]] as const };
    const bar = profileBar(work, 40, 40);
    expect(bar).toEqual([
      { category: 'render', y: 30, h: 10 },
      { category: 'props', y: 10, h: 20 },
    ]);
    expect(profileBar({ ms: 90, byCategory: [['render', 60], ['props', 30]] }, 40, 40)).toEqual([{ category: 'render', y: 0, h: 40 }]);
    expect(profileColumnAt(0, 600, 120)).toBe(0);
    expect(profileColumnAt(599, 600, 120)).toBe(119);
    expect(profileColumnAt(600, 600, 120)).toBeNull();
    expect(profileColumnAt(10, 600, 0)).toBeNull();
  });

  it('breaks a frame down per thread: the page\'s spans, each tick under its own row, each job by worker', () => {
    const { p } = profile();
    const r = p.read();
    const cols = profileColumns(r);
    const b = profileBreakdown(r, cols.at(-3)!);
    expect(b.threads.page.map((x) => x.name)).toEqual(['render frame', 'props test']);
    expect(b.threads.sim.map((x) => [x.name, x.depth])).toEqual([[`tick ${b.ticks[0]}`, 0], ['step', 1]]);
    expect(b.threads.jobs.map((x) => [x.name, x.lane])).toEqual([['job derive', 1]]);
  });

  it('digests a profile for MCP within its bound: every thread against the budget, counters, the worst spike\'s spans', () => {
    const { p } = profile();
    const r = p.read();
    const d = profileDigest(r);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(PROFILE_DIGEST_MAX_BYTES);
    expect(d.tier).toBe('low');
    expect(d.threads.page.categories.find((x) => x.category === 'render')?.budgetMs).toBeCloseTo(0.25 * (1000 / 30), 2);
    expect(d.threads.sim.meanMs).toBeGreaterThan(0);
    expect(d.counters.drawCalls).toBe(12);
    expect(d.spikes.kept).toBeGreaterThan(0);
    expect(d.spikes.worst?.top.page.length).toBeGreaterThan(0);
    // A tight bound drops the spans and the quiet categories first, never the shape.
    const small = profileDigest(r, r.at, 400);
    expect(small.spikes.worst?.top.page.length).toBe(0);
    expect(small.threads.page.categories.every((x) => x.meanMs > 0)).toBe(true);
    expect(Object.keys(small.threads)).toEqual(['page', 'sim', 'jobs']);
  });

  it('gives the overlay a line a thread and the last spike', () => {
    const { p } = profile();
    const lines = profileOverlayLines(p.read());
    expect(lines[0]).toMatch(/^profile +low tier, cap 30 fps, frame 33\.3 ms$/);
    expect(lines.find((l) => l.startsWith('page'))).toMatch(/page +\d+\.\d\d ms +render \d+\.\d\d\/8\.3/);
    expect(lines.find((l) => l.startsWith('sim'))).toMatch(/scripts 2\.00\//);
    expect(lines.find((l) => l.startsWith('jobs'))).toMatch(/voxel meshing/);
    expect(lines.find((l) => l.startsWith('gpu '))).toMatch(/no timestamps/);
    expect(lines.find((l) => l.startsWith('gpu ms'))).toMatch(/not measured/);
    expect(lines.at(-1)).toMatch(/^spike +\d+\.\d ms \(interval\)/);
  });
});

describe('reads since a cursor and their sum', () => {
  it('a read after a cursor carries only what arrived since; adding the reads up gives the whole read', () => {
    const { p, worker, t } = profile(30);
    const acc = new ProfileAccumulator();
    acc.add(p.read());
    const first = acc.cursor!;
    let at = t;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) {
        pageFrame(p, at);
        at += round === 1 && i === 2 ? 150 : 33.3;
      }
      // The ticks of those frames arrive after the page frames they belong with.
      for (let i = 0; i < 5; i++) simTick(p, worker, 100 + round * 5 + i, at - 5 * 33.3 + i * 33.3 + 2);
      const cut = p.read(acc.cursor!);
      expect(cut.threads.page.length).toBe(5);
      expect(cut.threads.sim.length).toBe(5);
      expect(cut.counters.frames.length).toBe(5);
      acc.add(cut);
    }
    clock = at + 2000;
    const whole = p.read();
    const summed = acc.report()!;
    const key = (f: { thread: string; frame: number; start: number }): string => `${f.thread}:${f.frame}:${f.start}`;
    expect(summed.threads.page.map(key)).toEqual(whole.threads.page.map(key));
    expect(summed.threads.sim.map(key)).toEqual(whole.threads.sim.map(key));
    expect(summed.threads.jobs.map(key)).toEqual(whole.threads.jobs.map(key));
    expect(summed.spikes.map((s) => s.at)).toEqual(whole.spikes.map((s) => s.at));
    expect(summed.seq).toEqual(whole.seq);
    expect(whole.seq.page - first.page).toBe(15);
    // Nothing new: an empty cut.
    const none = p.read(whole.seq);
    expect([none.threads.page.length, none.threads.sim.length, none.threads.jobs.length, none.spikes.length]).toEqual([0, 0, 0, 0]);
  });

  it('a capture file round trips with its header and version; another version or kind is refused with the reason', () => {
    const { p } = profile();
    const c = makeProfileCapture(p.read(), { build: 'b'.repeat(64), renderer: 'webgpu', source: 'export', date: new Date('2026-11-13T18:01:02.345Z') });
    expect(c.version).toBe(PROFILE_CAPTURE_VERSION);
    expect(c.header).toMatchObject({ tier: 'low', frameRateCap: 30, renderer: 'webgpu', source: 'export', date: '2026-11-13T18:01:02.345Z' });
    expect(profileCaptureFileName(c)).toBe('thirdlight-profile-2026-11-13T18-01-02Z.json');
    const back = parseProfileCapture(profileCaptureText(c));
    expect(back.ok && back.capture).toEqual(JSON.parse(JSON.stringify(c)));
    expect(parseProfileCapture(JSON.stringify({ ...c, version: 2 }))).toEqual({ ok: false, error: 'capture version 2; this engine reads version 1' });
    expect(parseProfileCapture('{"kind":"something else"}').ok).toBe(false);
    expect(parseProfileCapture('not json').ok).toBe(false);
    expect(parseProfileCapture(JSON.stringify({ ...c, report: { ...c.report, threads: { page: [{}], sim: [], jobs: [] } } })).ok).toBe(false);
  });
});

/** A DOM just big enough for the overlay (elements with attributes, children and click handlers). */
function fakeDom(): { dom: { createElement(tag: string): FakeNode }; root: FakeNode } {
  const make = (tag: string): FakeNode => new FakeNode(tag);
  return { dom: { createElement: make }, root: make('div') };
}
class FakeNode {
  textContent = '';
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly handlers = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  appendChild(c: FakeNode): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  addEventListener(t: string, h: () => void): void {
    this.handlers.set(t, h);
  }
  find(attr: string): FakeNode | null {
    if (this.attrs.has(attr)) return this;
    for (const c of this.children) {
      const f = c.find(attr);
      if (f !== null) return f;
    }
    return null;
  }
}

describe('the overlay\'s profiler view', () => {
  it('reads the profile only while it shows', () => {
    const { p } = profile();
    let reads = 0;
    const { dom, root } = fakeDom();
    const o = createStatsOverlay({ dom, container: root, shown: true, profile: { read: () => (reads++, p.read()), capture: () => makeProfileCapture(p.read(), { build: null, renderer: null, source: 'export' }) } });
    const stats = { fps: 30, frameMs: { avg: 33, worst: 34 }, cpuMs: { avg: 4, worst: 5 }, gpuMs: null, drawCalls: 12, triangles: 3400, textureBytes: 0, textureBudgetBytes: 1, geometryBytes: 0, entities: 3, quality: 'low', frameRateCap: 30 } as unknown as Parameters<typeof o.update>[0];
    for (let i = 0; i < 3; i++) o.update(stats);
    expect(reads).toBe(0);
    expect(root.find('data-tl-profile')!.attrs.get('data-shown')).toBe('false');
    o.setProfileShown(true);
    o.update(stats);
    expect(reads).toBe(2);
    expect(o.lines().some((l) => l.startsWith('page'))).toBe(true);
    expect(o.lines().some((l) => l.startsWith('sim'))).toBe(true);
    // Hidden with the overlay: no reads.
    o.setShown(false);
    o.update(stats);
    expect(reads).toBe(2);
    o.dispose();
  });
});
