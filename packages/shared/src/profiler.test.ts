import { describe, expect, it } from 'vitest';

import { FRAME_SLICE_DEFAULTS, FRAME_SLICE_IDS, FrameArbiter } from './frame-arbiter';
import { PROFILE_FRAMES, SPAN_CATEGORIES, SpanRecorder, type ProfileSpan } from './profiler';

describe('the span recorder', () => {
  it('keeps nested spans with their own time, and sums own time by category', () => {
    const r = new SpanRecorder('page', 4, 8);
    const frame = r.span('frame work', 'render');
    const inner = r.span('cull', 'render');
    const audio = r.span('sounds', 'audio');
    r.beginFrame(1000);
    r.begin(frame);
    r.begin(inner);
    r.end();
    r.begin(audio);
    r.end();
    r.end();
    r.endFrame();
    const [f] = r.read().own;
    expect(f!.thread).toBe('page');
    expect(f!.spans.map((s) => s.name)).toEqual(['frame work', 'cull', 'sounds']);
    const [outer, cull, sounds] = f!.spans as [ProfileSpan, ProfileSpan, ProfileSpan];
    // The outer span's own time leaves out what its children took.
    expect(outer.selfMs).toBeCloseTo(Math.max(0, outer.ms - cull.ms - sounds.ms), 3);
    expect(f!.byCategory.audio ?? 0).toBeCloseTo(sounds.ms, 3);
    expect(f!.byCategory.render ?? 0).toBeCloseTo(cull.ms + outer.selfMs, 3);
    expect(f!.spans.find((s) => s.name === 'cull')!.depth).toBe(1);
  });

  it('keeps the last frames of the ring, oldest first, and counts spans past a frame\'s room', () => {
    const r = new SpanRecorder('sim', 3, 2);
    const id = r.span('step', 'scripts');
    for (let f = 0; f < 5; f++) {
      r.beginFrame(f * 10);
      for (let k = 0; k < 3; k++) r.add(id, f * 10 + k, 1);
      r.endFrame(f * 10 + 5);
    }
    const own = r.read().own;
    expect(own.map((f) => f.frame)).toEqual([2, 3, 4]);
    // A frame opened (a span between frames) takes the oldest's slot: it is no longer read as kept.
    r.add(id, 60, 1);
    expect(r.read().own.map((f) => f.frame)).toEqual([3, 4]);
    expect(r.closedStart(1)).toBe(30);
    expect(r.closedStart(2)).toBeNaN();
    expect(own.every((f) => f.spans.length === 2 && f.dropped === 1)).toBe(true);
    // The dropped span's time is still in the sum.
    expect(own.every((f) => f.byCategory.scripts === 3)).toBe(true);
    expect(own[2]!.ms).toBe(5);
  });

  it('keeps job workers\' spans apart from the thread\'s own, as a jobs frame', () => {
    const r = new SpanRecorder('sim', 4, 16);
    const step = r.span('step', 'scripts');
    const derive = r.span('job derive', 'voxelMesh');
    r.beginFrame(0);
    r.add(step, 1, 4);
    r.job(derive, 0, 2, 6);
    r.job(derive, 1, 3, 5);
    r.endFrame(10);
    const { own, jobs } = r.read();
    expect(own[0]!.spans.map((s) => s.name)).toEqual(['step']);
    expect(own[0]!.byCategory).toEqual({ scripts: 4 });
    expect(jobs[0]!.thread).toBe('jobs');
    expect(jobs[0]!.byCategory).toEqual({ voxelMesh: 11 });
    expect(jobs[0]!.spans.map((s) => s.lane)).toEqual([0, 1]);
  });

  it('packs closed frames for another thread, which takes them in as they were (names sent once)', () => {
    const worker = new SpanRecorder('sim', 8, 8);
    const page = new SpanRecorder('sim', 8, 8);
    const a = worker.span('scripts', 'scripts');
    worker.beginFrame(100);
    worker.tick(7);
    worker.add(a, 101, 2);
    worker.endFrame(110);
    const first = worker.pack()!;
    expect(first.names).toEqual([['scripts', 'scripts']]);
    expect(page.ingest(first)).toBe(true);
    const b = worker.span('physics', 'physics');
    worker.beginFrame(120);
    worker.add(a, 121, 1);
    worker.add(b, 122, 3);
    worker.endFrame(130);
    const second = worker.pack()!;
    expect(second.firstName).toBe(1);
    expect(second.names).toEqual([['physics', 'physics']]);
    expect(page.ingest(second)).toBe(true);
    expect(worker.pack()).toBeNull();
    const taken = page.read().own;
    expect(taken).toEqual(worker.read().own);
    expect(taken[0]!.tick).toBe(7);
    expect(taken[1]!.byCategory).toEqual({ scripts: 1, physics: 3 });
    // A packet whose names do not follow on from the last is refused.
    expect(page.ingest(first)).toBe(false);
  });

  it('times a sequence of stages with laps, nesting what a stage opens itself, and ends a span left open by a throw', () => {
    const r = new SpanRecorder('page', 4, 16);
    const [a, b, inner, outer, left] = (['a', 'b', 'inner', 'outer', 'left'] as const).map((n) => r.span(n, 'ui'));
    r.beginFrame();
    r.lap(a!);
    r.lap(b!);
    r.begin(inner!);
    r.end();
    r.lapEnd();
    r.begin(outer!);
    r.begin(left!);
    // A throw skipped `left`'s end: ending `outer` by name ends it first.
    r.end(outer);
    r.endFrame();
    const spans = r.read().own[0]!.spans;
    expect(spans.map((s) => [s.name, s.depth])).toEqual([['a', 0], ['b', 0], ['inner', 1], ['outer', 0], ['left', 1]]);
  });

  it('costs no memory per frame: a long run keeps the same buffers and a bounded ring', () => {
    const r = new SpanRecorder('page');
    const ids = SPAN_CATEGORIES.map((c) => r.span(`span ${c}`, c));
    const buffers = Object.values(r as unknown as Record<string, unknown>).filter((v) => ArrayBuffer.isView(v));
    for (let f = 0; f < 10_000; f++) {
      r.beginFrame();
      for (const id of ids) {
        r.begin(id);
        r.end();
      }
      r.endFrame();
    }
    const after = Object.values(r as unknown as Record<string, unknown>).filter((v) => ArrayBuffer.isView(v));
    expect(after).toEqual(buffers);
    expect(after.every((b, i) => b === buffers[i])).toBe(true);
    expect(r.read().own.length).toBe(PROFILE_FRAMES);
    expect(r.frameCount).toBe(10_000);
  });
});

describe('the frame arbiter', () => {
  it('hands out every moved slice at its old value at the 30 and 60 Hz caps', () => {
    const a = new FrameArbiter();
    const at = (hz: number) => {
      a.setInterval(1000 / hz);
      return Object.fromEntries(FRAME_SLICE_IDS.map((id) => [id, a.sliceMs(id)]));
    };
    // voxelBatch: VOXEL_BATCH_FRAME_SHARE (0.25) of the interval; the rest were fixed constants.
    const old = { farSelect: 2, voxelDerive: 2, voxelEditDerive: 8, voxelCollisionAdd: 4, staticMerge: 4, decalClip: 4, surfacePrepare: 1, probePlace: 1, scenePrep: 4, scatterBuild: 4, farFinePack: 4 };
    expect(at(30)).toEqual({ voxelBatch: 0.25 * (1000 / 30), ...old });
    expect(at(60)).toEqual({ voxelBatch: 0.25 * (1000 / 60), ...old });
    expect(a.sliceMs('voxelBatch', 1000 / 30)).toBeCloseTo(8.333, 3);
  });

  it('refuses a share slice without an interval, and takes an installed table', () => {
    const a = new FrameArbiter();
    expect(() => a.sliceMs('voxelBatch')).toThrow(RangeError);
    expect(a.read().find((s) => s.id === 'voxelBatch')!.msNow).toBeNull();
    a.install({ ...FRAME_SLICE_DEFAULTS, staticMerge: { category: 'props', thread: 'page', ms: 6 } });
    expect(a.sliceMs('staticMerge')).toBe(6);
  });
});
