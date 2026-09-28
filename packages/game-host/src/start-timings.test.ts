/** Phase 25.24a: the start-timings recorder (stages, first frame, slow frames, scene loads). */
import { describe, expect, it } from 'vitest';

import { createStartTimings, FRAME_WATCH_MS } from './start-timings';

describe('start timings', () => {
  it('records stages that overlap, points, and recorded spans, in order of their start', () => {
    let t = 0;
    const tm = createStartTimings({ now: () => t, epochMs: 1_000 });
    tm.record('bundleFetch', 2, 40, '9 B');
    t = 50;
    tm.begin('worker');
    t = 60;
    tm.begin('assets');
    t = 90;
    tm.end('worker');
    t = 120;
    tm.end('assets');
    tm.end('ready');
    tm.count('startAssetReads', 3);
    tm.count('startAssetReads', 2);
    const r = tm.report();
    expect(r.epochMs).toBe(1_000);
    expect(r.stages).toEqual([
      { name: 'bundleFetch', startMs: 2, endMs: 40, note: '9 B' },
      { name: 'worker', startMs: 50, endMs: 90 },
      { name: 'assets', startMs: 60, endMs: 120 },
      { name: 'ready', startMs: 120, endMs: 120 },
    ]);
    expect(r.counts).toEqual({ startAssetReads: 5 });
  });

  it('keeps the first frame, and counts the slow frames after it within the watch window', () => {
    let t = 1_000;
    const tm = createStartTimings({ now: () => t, epochMs: 0 });
    tm.frame();
    for (const gap of [16, 16, 300, 16, 120, 60, 16]) {
      t += gap;
      tm.frame();
    }
    t += FRAME_WATCH_MS; // past the window: not counted
    tm.frame();
    const r = tm.report();
    expect(r.firstFrameMs).toBe(1_000);
    expect(r.afterFirstFrame).toMatchObject({ frames: 7, over50: 3, over100: 2, over250: 1 });
    expect(r.afterFirstFrame.worst.map((w) => w.ms)).toEqual([300, 120, 60]);
  });

  it('times a scene load: the request, the read, the frame that attached it and the frames after', () => {
    let t = 0;
    const tm = createStartTimings({ now: () => t, epochMs: 0 });
    tm.frame();
    t = 100;
    tm.sceneRequested('level-2');
    t = 140;
    tm.sceneRead('level-2', 250);
    t = 150;
    tm.frame({ realizedScenes: ['level-2'] });
    t = 400;
    tm.frame();
    t = 416;
    tm.frame();
    tm.sceneRequested('missing');
    tm.sceneFailed('missing', 'scene "missing" is not part of this build');
    const [load, failed] = tm.report().sceneLoads;
    expect(load).toMatchObject({ sceneId: 'level-2', requestedMs: 100, readMs: 140, entities: 250, attachedMs: 150, attachFrameMs: 150 });
    expect(load!.after).toMatchObject({ frames: 2, over50: 1, over250: 0 });
    expect(failed).toMatchObject({ sceneId: 'missing', readMs: null, error: 'scene "missing" is not part of this build' });
  });

  it('phase 25.24d: splits the wait for the first frame into renderer start, precompile and the first render; a scene load keeps its precompile', () => {
    let t = 500;
    const tm = createStartTimings({ now: () => t, epochMs: 0 });
    // First render call at 100, renderer ready and precompile from 160 to 400, the first drawn frame's call 400–430.
    t = 430;
    tm.frame({ renderMs: 30, firstCallAt: 100, precompile: { startedAt: 160, ms: 240 } });
    const r = tm.report();
    expect(r.stages).toEqual([
      { name: 'rendererInit', startMs: 100, endMs: 160 },
      { name: 'precompile', startMs: 160, endMs: 400 },
      { name: 'firstRender', startMs: 400, endMs: 430 },
    ]);
    tm.sceneRequested('level-2');
    t = 700;
    tm.frame({ realizedScenes: ['level-2'], precompile: { startedAt: 600, ms: 90 } });
    expect(tm.report().sceneLoads[0]).toMatchObject({ attachedMs: 700, precompileMs: 90 });
  });
});
