/**
 * The page-side mirror of the simulation worker keeps its queued
 * sound and effect requests bounded like the runtime's own queues, so a page
 * that does not take them (scene mode, headless) never grows.
 */
import { describe, expect, it } from 'vitest';

import { createSimulationRegistry, instantiateRuntime, neutralFrame, type Runtime } from '@thirdlight/runtime';

import { FrameEncoder, FrameMirror, MIRROR_AUDIO_LIMIT, MIRROR_EFFECT_LIMIT } from './sim-state';
import { STEP_PAIR_STRIDE, TRANSFORM_STRIDE } from './sim-protocol';

const frame = (seq: number, audio: number, effects: number) => ({
  seq,
  stepIndex: seq,
  simTime: seq / 120,
  alpha: 0,
  frameCount: seq,
  state: 'running' as never,
  paused: false,
  debugHeld: false,
  audio: Array.from({ length: audio }, (_, i) => ({ assetId: `a${seq}-${i}`, volume: 1, stepIndex: seq })),
  effects: Array.from({ length: effects }, (_, i) => ({ id: `e${seq}-${i}` })),
});

describe('FrameMirror request queues', () => {
  it('stay bounded when nobody takes them (audio commands and effects: the newest 256)', () => {
    const m = new FrameMirror();
    for (let seq = 1; seq <= 100; seq += 1) m.apply(frame(seq, 5, 10) as never);
    expect(m.audio).toHaveLength(MIRROR_AUDIO_LIMIT);
    expect((m.audio[MIRROR_AUDIO_LIMIT - 1] as { assetId: string }).assetId).toBe('a100-4');
    expect(m.effects).toHaveLength(MIRROR_EFFECT_LIMIT);
    expect((m.effects[MIRROR_EFFECT_LIMIT - 1] as { id: string }).id).toBe('e100-9');
  });

  it('pass every request through when the page takes them each frame', () => {
    const m = new FrameMirror();
    let sounds = 0;
    let effects = 0;
    for (let seq = 1; seq <= 50; seq += 1) {
      m.apply(frame(seq, 3, 7) as never);
      sounds += m.audio.splice(0).length;
      effects += m.effects.splice(0).length;
    }
    expect(sounds).toBe(150);
    expect(effects).toBe(350);
  });
});

describe('FrameEncoder → FrameMirror: what moved', () => {
  /** A runtime of `n` entities at x = their index; `moving` ones are pushed along x by `t`. */
  const runtime = (n: number) => {
    const s = { t: 0, moving: new Set<number>() };
    const rt = {
      getDiagnostics: () => ({ ok: false }),
      interpolationAlpha: 0,
      forEachInterpolated: (visit: (id: string, p: number[], r: number[], sc: number[]) => void) => {
        for (let i = 0; i < n; i += 1) visit(`e${i}`, [i + (s.moving.has(i) ? s.t : 0), 0, 0], [0, 0, 0, 1], [1, 1, 1]);
        return true;
      },
    };
    return { s, rt };
  };
  const taken = (m: FrameMirror, n: number): number[] => {
    const out: number[] = [];
    m.takeMoved((i) => out.push(i), n);
    return out;
  };

  for (const shared of [false, true]) {
    it(`hands the presenter only the entities that moved (${shared ? 'shared memory' : 'messages'})`, () => {
      const { s, rt } = runtime(40);
      const enc = new FrameEncoder({ shared });
      const m = new FrameMirror();
      // The first frame: every entity.
      m.apply(enc.encode(rt as never, 1, {}).state);
      expect(taken(m, 40)).toHaveLength(40);
      // Nothing moves: nothing to place.
      m.apply(enc.encode(rt as never, 2, {}).state);
      expect(taken(m, 40)).toEqual([]);
      // Two move, over two frames before the presenter reads: both, once.
      s.moving = new Set([3, 17]);
      s.t = 1;
      m.apply(enc.encode(rt as never, 3, {}).state);
      s.t = 2;
      m.apply(enc.encode(rt as never, 4, {}).state);
      expect(taken(m, 40).sort((a, b) => a - b)).toEqual([3, 17]);
      expect(m.xf[17 * STEP_PAIR_STRIDE + TRANSFORM_STRIDE]).toBe(19);
      // Most of them move (a full transform buffer goes): still only those.
      s.moving = new Set(Array.from({ length: 30 }, (_, i) => i));
      s.t = 3;
      m.apply(enc.encode(rt as never, 5, {}).state);
      expect(taken(m, 40)).toHaveLength(30);
      expect(m.xf[29 * STEP_PAIR_STRIDE + TRANSFORM_STRIDE]).toBe(32);
    });
  }
});

describe('FrameMirror draws between the last two steps by the page clock', () => {
  const DT = 1 / 120;
  /** A runtime of 3 entities: e0 stands, e1 moves +1 per step along x, e2 moved only at the step before. */
  const runtime = () => {
    const s = { step: 0, alpha: 0.25, rate: 1 };
    const t = (x: number) => ({ position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
    const rt = {
      getDiagnostics: () => ({ ok: false }),
      get interpolationAlpha() {
        return s.alpha;
      },
      get interpolationRate() {
        return s.rate;
      },
      forEachStepPair: (visit: (id: string, p: unknown, c: unknown) => void) => {
        visit('e0', t(5), t(5));
        visit('e1', t(s.step - 1), t(s.step));
        visit('e2', t(s.step === 1 ? 0 : 7), t(7));
        return true;
      },
    };
    return { s, rt };
  };
  const xAt = (m: FrameMirror, i: number): number => {
    const p = [0, 0, 0];
    m.readRow(i, p, [0, 0, 0, 1], [1, 1, 1]);
    return p[0]!;
  };

  it("draws the worker's own alpha at the frame's time, then moves on by the clock and stops at the last step", () => {
    const { s, rt } = runtime();
    const enc = new FrameEncoder({ shared: false });
    const m = new FrameMirror();
    m.stepSeconds = DT;
    s.step = 4;
    const state = enc.encode(rt as never, 1, {}).state;
    expect(state.rate).toBe(1);
    m.apply(state, 10);
    m.present(10);
    expect(m.alpha).toBe(0.25);
    expect(xAt(m, 1)).toBeCloseTo(3.25, 12);
    // Half a step later (no new frame from the worker): half a step further.
    m.present(10 + DT / 2);
    expect(m.alpha).toBeCloseTo(0.75, 12);
    expect(xAt(m, 1)).toBeCloseTo(3.75, 12);
    // Past the last finished step it waits there (never ahead of the simulation), the alpha just below 1.
    m.present(10 + DT * 3);
    expect(m.alpha).toBeLessThan(1);
    expect(m.alpha).toBeGreaterThan(0.999999);
    expect(xAt(m, 1)).toBeCloseTo(4, 6);
    expect(xAt(m, 0)).toBe(5);
  });

  it('a paused or held simulation (rate 0) draws its frame as it is', () => {
    const { s, rt } = runtime();
    const enc = new FrameEncoder({ shared: false });
    const m = new FrameMirror();
    m.stepSeconds = DT;
    s.step = 2;
    s.alpha = 0;
    s.rate = 0;
    m.apply(enc.encode(rt as never, 1, {}).state, 10);
    m.present(11);
    expect(m.alpha).toBe(0);
    expect(xAt(m, 1)).toBe(2);
  });

  it('hands the presenter the rows between two different steps on every draw the alpha moved, the others once', () => {
    const { s, rt } = runtime();
    const enc = new FrameEncoder({ shared: false });
    const m = new FrameMirror();
    m.stepSeconds = DT;
    const taken = (): number[] => {
      const out: number[] = [];
      m.takeMoved((i) => out.push(i), m.rowCount());
      return out.sort((a, b) => a - b);
    };
    s.step = 1;
    m.apply(enc.encode(rt as never, 1, {}).state, 10);
    m.present(10);
    expect(taken()).toEqual([0, 1, 2]);
    // Next draw, no new frame: the moving rows again (e2's steps differ at step 1), the standing one not.
    m.present(10 + DT / 4);
    expect(taken()).toEqual([1, 2]);
    // The same alpha again: nothing.
    m.present(10 + DT / 4);
    expect(taken()).toEqual([]);
    // A new step where e2's two steps are equal: e2 is placed once more, then left alone.
    s.step = 2;
    m.apply(enc.encode(rt as never, 2, {}).state, 11);
    m.present(11);
    expect(taken()).toEqual([1, 2]);
    m.present(11 + DT / 4);
    expect(taken()).toEqual([1]);
  });
});

describe('FrameEncoder: the diagnostics a frame reads', () => {
  /** A real runtime of one camera, its full diagnostics builds counted. */
  const runtime = () => {
    const now = { t: 0 };
    const res = instantiateRuntime({
      snapshot: { snapshotId: 'diag@r1', projectId: 'diag', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [{ id: 'cam-main', components: { transform: { position: [0, 4, 12], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } }] } },
      registry: createSimulationRegistry(),
      modules: [],
      actions: { sample: (i: number) => neutralFrame(i) },
      settings: {},
      clock: () => now.t,
      driver: { kind: 'manual' },
    } as never);
    if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
    const rt: Runtime = res.runtime;
    const builds = { n: 0 };
    const real = rt.getDiagnostics.bind(rt);
    rt.getDiagnostics = () => {
      builds.n += 1;
      return real();
    };
    expect(rt.start().ok).toBe(true);
    return { rt, now, builds, real };
  };

  it('every frame carries the step, time and state; the full set (every voxel world walked) is built only on the frames that send it', () => {
    const { rt, now, builds, real } = runtime();
    const enc = new FrameEncoder({ shared: false });
    const sent: number[] = [];
    for (let seq = 1; seq <= 180; seq += 1) {
      now.t += 1 / 30;
      expect(rt.tick(now.t).ok).toBe(true);
      const { state } = enc.encode(rt, seq, {});
      const d = real();
      if (!d.ok) throw new Error('diagnostics failed');
      expect([state.stepIndex, state.simTime, state.frameCount, state.state]).toEqual([d.diagnostics.stepIndex, d.diagnostics.simTime, d.diagnostics.frameCount, d.diagnostics.state]);
      if (state.diag !== undefined) sent.push(seq);
    }
    // The first frame, then once every 60 frames.
    expect(sent).toEqual([1, 61, 121]);
    expect(builds.n).toBe(sent.length);
    // Asked for, and on a change of state: the next frame sends them (built for it).
    enc.wantDiagnostics();
    expect(enc.encode(rt, 181, {}).state.diag).toBeDefined();
    expect(rt.stop().ok).toBe(true);
    const stopped = enc.encode(rt, 182, {}).state;
    expect(stopped.diag?.state).toBe(stopped.state);
    expect(stopped.state).not.toBe('running');
    expect(enc.encode(rt, 183, {}).state.diag).toBeUndefined();
    expect(builds.n).toBe(sent.length + 2);
  });
});
