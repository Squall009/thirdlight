/**
 * Phase 22.0: the worker's per-frame input becomes one frame per step — the
 * sampled frame for the first step of a tick, its continuation for the rest,
 * and a tick without a step keeps its edges for the next one.
 */
import { describe, expect, it } from 'vitest';

import { continueFrame, mergePhase, TickInputSource } from './tick-input';
import { threadingFromUrl, resolveThreadingMode, resolveTransport, threadingLogLine } from './threading';

describe('TickInputSource (phase 22.0)', () => {
  it('the first step of a tick sees the sample, later steps its continuation (no new device events)', () => {
    const src = new TickInputSource();
    src.push({ stepIndex: 0, moveX: 1, jump: 'pressed', actions: { fire: { v: 1, p: 'pressed' }, aim: { v: 0.5, x: 0.5, y: 0, p: 'held' } } });
    const a = src.sample(12);
    const b = src.sample(13);
    const c = src.sample(14);
    expect(a).toEqual({ stepIndex: 12, moveX: 1, jump: 'pressed', actions: { fire: { v: 1, p: 'pressed' }, aim: { v: 0.5, x: 0.5, y: 0, p: 'held' } } });
    expect(b).toEqual({ stepIndex: 13, moveX: 1, jump: 'held', actions: { fire: { v: 1, p: 'held' }, aim: { v: 0.5, x: 0.5, y: 0, p: 'held' } } });
    expect(c.jump).toBe('held');
    // A release is seen once, then nothing is held.
    src.push({ stepIndex: 15, moveX: 0, jump: 'released' });
    expect(src.sample(15).jump).toBe('released');
    expect(src.sample(16).jump).toBe('none');
  });

  it('a tick that ran no step keeps its edges: press then release between steps is still a press, then a release', () => {
    const src = new TickInputSource();
    src.push({ stepIndex: 0, moveX: 0, jump: 'none' });
    src.sample(0);
    src.push({ stepIndex: 1, moveX: 1, jump: 'pressed' }); // this frame ran no step
    src.push({ stepIndex: 1, moveX: 1, jump: 'released' });
    expect(src.sample(1).jump).toBe('pressed');
    expect(src.sample(2).jump).toBe('released');
    expect(src.sample(3).jump).toBe('none');
  });

  it('merge rules keep every edge', () => {
    expect(mergePhase('pressed', 'held')).toEqual({ now: 'pressed', then: null });
    expect(mergePhase('pressed', 'released')).toEqual({ now: 'pressed', then: 'released' });
    expect(mergePhase('released', 'pressed')).toEqual({ now: 'released', then: 'pressed' });
    expect(mergePhase('held', 'released')).toEqual({ now: 'released', then: null });
    expect(mergePhase('none', 'pressed')).toEqual({ now: 'pressed', then: null });
    expect(continueFrame({ stepIndex: 1, moveX: 0.5, jump: 'released' })).toEqual({ stepIndex: 1, moveX: 0.5, jump: 'none' });
  });

  it('no sample yet: neutral; reset clears and tells the page', () => {
    const reasons: (string | undefined)[] = [];
    const src = new TickInputSource((r) => reasons.push(r));
    expect(src.sample(4)).toEqual({ stepIndex: 4, moveX: 0, jump: 'none' });
    src.push({ stepIndex: 5, moveX: 1, jump: 'held' });
    src.reset('exclusive-test');
    expect(src.sample(5)).toEqual({ stepIndex: 5, moveX: 0, jump: 'none' });
    expect(reasons).toEqual(['exclusive-test']);
  });
});

describe('threading mode (phase 22.0)', () => {
  it('the URL flag, then the project setting, then the worker default; no worker: single thread', () => {
    expect(threadingFromUrl('?threads=off')).toBe('single');
    expect(threadingFromUrl('?a=1&threads=worker')).toBe('worker');
    expect(threadingFromUrl('?threads=maybe')).toBeNull();
    expect(resolveThreadingMode({ url: '', workerAvailable: true })).toEqual({ mode: 'worker', reason: 'the default' });
    expect(resolveThreadingMode({ url: '', setting: 2, workerAvailable: true }).mode).toBe('single');
    expect(resolveThreadingMode({ url: '?threads=on', setting: 2, workerAvailable: true }).mode).toBe('worker');
    expect(resolveThreadingMode({ url: '?threads=off', setting: 1, workerAvailable: true }).mode).toBe('single');
    const fallback = resolveThreadingMode({ url: '', workerAvailable: false });
    expect(fallback.mode).toBe('single');
    expect(fallback.reason).toContain('cannot start one');
  });

  it('shared memory only when cross-origin isolated', () => {
    expect(resolveTransport({ crossOriginIsolated: true, SharedArrayBuffer })).toBe('shared');
    expect(resolveTransport({ crossOriginIsolated: false, SharedArrayBuffer })).toBe('message');
    expect(resolveTransport({ crossOriginIsolated: true })).toBe('message');
    expect(threadingLogLine('worker', 'the default', 'message', false)).toBe('[thirdlight] simulation: worker (the default); transforms by messages (cross-origin isolated: no)');
  });
});
