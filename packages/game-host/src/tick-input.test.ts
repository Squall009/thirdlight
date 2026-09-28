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
    src.push({ stepIndex: 0, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' }, fire: { v: 1, p: 'pressed' }, aim: { v: 0.5, x: 0.5, y: 0, p: 'held' } } });
    const a = src.sample(12);
    const b = src.sample(13);
    const c = src.sample(14);
    expect(a).toEqual({ stepIndex: 12, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' }, fire: { v: 1, p: 'pressed' }, aim: { v: 0.5, x: 0.5, y: 0, p: 'held' } } });
    expect(b).toEqual({ stepIndex: 13, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'held' }, fire: { v: 1, p: 'held' }, aim: { v: 0.5, x: 0.5, y: 0, p: 'held' } } });
    expect(c.actions?.['jump']?.p).toBe('held');
    // A release is seen once, then nothing is held.
    src.push({ stepIndex: 15, actions: { move: { v: 0, p: 'none' }, jump: { v: 0, p: 'released' } } });
    expect(src.sample(15).actions?.['jump']?.p).toBe('released');
    expect(src.sample(16).actions?.['jump']?.p).toBe('none');
  });

  it('a tick that ran no step keeps its edges: press then release between steps is still a press, then a release', () => {
    const src = new TickInputSource();
    src.push({ stepIndex: 0 });
    src.sample(0);
    src.push({ stepIndex: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } }); // this frame ran no step
    src.push({ stepIndex: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'released' } } });
    expect(src.sample(1).actions?.['jump']?.p).toBe('pressed');
    expect(src.sample(2).actions?.['jump']?.p).toBe('released');
    expect(src.sample(3).actions?.['jump']?.p).toBe('none');
  });

  it('merge rules keep every edge', () => {
    expect(mergePhase('pressed', 'held')).toEqual({ now: 'pressed', then: null });
    expect(mergePhase('pressed', 'released')).toEqual({ now: 'pressed', then: 'released' });
    expect(mergePhase('released', 'pressed')).toEqual({ now: 'released', then: 'pressed' });
    expect(mergePhase('held', 'released')).toEqual({ now: 'released', then: null });
    expect(mergePhase('none', 'pressed')).toEqual({ now: 'pressed', then: null });
    expect(continueFrame({ stepIndex: 1, actions: { move: { v: 0.5, p: 'none' }, jump: { v: 0, p: 'released' } } })).toEqual({ stepIndex: 1, actions: { move: { v: 0.5, p: 'none' }, jump: { v: 0, p: 'none' } } });
  });

  it('no sample yet: neutral; reset clears and tells the page', () => {
    const reasons: (string | undefined)[] = [];
    const src = new TickInputSource((r) => reasons.push(r));
    expect(src.sample(4)).toEqual({ stepIndex: 4 });
    src.push({ stepIndex: 5, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'held' } } });
    src.reset('exclusive-test');
    expect(src.sample(5)).toEqual({ stepIndex: 5 });
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

describe('phase 23.2: the worker\'s live input keeps the second move axis', () => {
  it('a frame\'s moveY reaches every step of its tick and survives a merge; frames without it stay without', () => {
    const src = new TickInputSource();
    src.push({ stepIndex: 0, actions: { move: { v: 0.5, x: 0.5, y: -1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    expect(src.sample(1)).toEqual({ stepIndex: 1, actions: { move: { v: 0.5, x: 0.5, y: -1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    expect(src.sample(2)).toEqual({ stepIndex: 2, actions: { move: { v: 0.5, x: 0.5, y: -1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    expect(continueFrame({ stepIndex: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } })).toEqual({ stepIndex: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 1, p: 'held' } } });
    const merged = new TickInputSource();
    merged.push({ stepIndex: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } });
    merged.push({ stepIndex: 1, actions: { move: { v: 0, x: 0, y: 0.5, p: 'none' }, jump: { v: 1, p: 'held' } } });
    expect(merged.sample(1)).toEqual({ stepIndex: 1, actions: { move: { v: 0, x: 0, y: 0.5, p: 'none' }, jump: { v: 1, p: 'pressed' } } });
    const old = new TickInputSource();
    old.push({ stepIndex: 0, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    expect('moveY' in old.sample(1)).toBe(false);
  });
});
