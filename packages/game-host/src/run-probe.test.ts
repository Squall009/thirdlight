/**
 * Phase 25.16: the run digest — steps counted from the run's start, spawned
 * copies named by their number in the run, loaded scenes instead of the
 * scene set's revision — and the probe that takes it right after an input
 * exercise's last step; the relay's restart (the replay) asks for it on the
 * step before the frames begin.
 */
import { describe, expect, it } from 'vitest';

import type { Runtime } from '@thirdlight/runtime';

import { RelayActionSource } from './relay-input';
import { RunProbe } from './run-probe';
import { runDigest } from './step-digest';

/** A runtime as the digest reads it: a step count, a run start, transforms, loaded scenes and spawned copies. */
function fakeRuntime(state: { step: number; start: number; spawnBase: number; revision: number; objects: Record<string, number>; spawned: string[] }): Runtime & { step(): void } {
  let observer: ((s: number) => void) | null = null;
  return {
    getDiagnostics: () => ({ ok: true, diagnostics: { stepIndex: state.step } }),
    runStart: () => ({ step: state.start, spawnBase: state.spawnBase }),
    forEachInterpolated: (fn: (id: string, p: number[], r: number[], s: number[]) => void) => {
      for (const [id, x] of Object.entries(state.objects)) fn(id, [x, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    },
    sceneSet: () => ({ revision: state.revision, status: { 'scene-main': 'loaded' }, spawned: state.spawned.map((id) => ({ id })) }),
    setStepObserver: (o: ((s: number) => void) | null) => {
      observer = o;
    },
    step() {
      state.step += 1;
      observer?.(state.step);
    },
  } as unknown as Runtime & { step(): void };
}

describe('run digest (phase 25.16)', () => {
  it('a run and its replay: equal at the same run step, whatever the absolute step, the copies\' ids and the scene revision', () => {
    const run = fakeRuntime({ step: 40, start: 0, spawnBase: 0, revision: 3, objects: { 'box-000001': 1.5, 'spawn-1': 2 }, spawned: ['spawn-1'] });
    const replay = fakeRuntime({ step: 940, start: 900, spawnBase: 7, revision: 12, objects: { 'spawn-8': 2, 'box-000001': 1.5 }, spawned: ['spawn-8'] });
    const a = runDigest(run);
    const b = runDigest(replay);
    expect(a.runStep).toBe(40);
    expect(b.runStep).toBe(40);
    expect(b.stepIndex).toBe(940);
    expect(a.digest).toBe(b.digest);
    // A different world differs.
    const moved = fakeRuntime({ step: 940, start: 900, spawnBase: 7, revision: 12, objects: { 'spawn-8': 2.001, 'box-000001': 1.5 }, spawned: ['spawn-8'] });
    expect(runDigest(moved).digest).not.toBe(a.digest);
    // So does the same world at another run step.
    const later = fakeRuntime({ step: 941, start: 900, spawnBase: 7, revision: 12, objects: { 'spawn-8': 2, 'box-000001': 1.5 }, spawned: ['spawn-8'] });
    expect(runDigest(later).digest).not.toBe(a.digest);
  });

  it('the probe takes the digest right after the exercise\'s last step, not later', () => {
    const state = { step: 10, start: 0, spawnBase: 0, revision: 1, objects: { 'box-000001': 0 }, spawned: [] as string[] };
    const rt = fakeRuntime(state);
    const probe = new RunProbe(rt);
    expect(probe.read().input).toBeNull();
    probe.exerciseDone(8, 10, true); // the last applied step samples as 10; its state is there once it ran
    state.objects['box-000001'] = 5;
    rt.step(); // step 10 runs: the count is 11
    state.objects['box-000001'] = 6;
    rt.step();
    const read = probe.read();
    expect(read.input).toMatchObject({ fromStep: 8, toStep: 10, stepIndex: 11, runStep: 11, restarted: true });
    const at5 = fakeRuntime({ ...state, step: 11, objects: { 'box-000001': 5 } });
    expect(read.input!.digest).toBe(runDigest(at5).digest);
    expect(read.now.digest).not.toBe(read.input!.digest);
  });

  it('the relay\'s restart: the first step asks for it, the frames begin at the next (the new run\'s first step)', () => {
    const src = new RelayActionSource({ sample: (i) => ({ stepIndex: i }) });
    let done: [number, number] | null = null;
    src.beginTest([{ stepOffset: 0, actions: { go: { v: 1, p: 'pressed' } } }], 21, (a, b) => (done = [a, b]), true);
    expect(src.sample(20)).toEqual({ stepIndex: 20, ui: [{ kind: 'restart', doc: '', widget: '', name: '' }] });
    expect(src.sample(21).actions).toEqual({ go: { v: 1, p: 'pressed' } });
    expect(done).toEqual([21, 21]);
  });
});
