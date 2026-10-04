/**
 * The page-side mirror of the simulation worker keeps its queued
 * sound and effect requests bounded like the runtime's own queues, so a page
 * that does not take them (scene mode, headless) never grows.
 */
import { describe, expect, it } from 'vitest';

import { FrameEncoder, FrameMirror, MIRROR_AUDIO_LIMIT, MIRROR_EFFECT_LIMIT } from './sim-state';

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
      expect(m.xf[17 * 10]).toBe(19);
      // Most of them move (a full transform buffer goes): still only those.
      s.moving = new Set(Array.from({ length: 30 }, (_, i) => i));
      s.t = 3;
      m.apply(enc.encode(rt as never, 5, {}).state);
      expect(taken(m, 40)).toHaveLength(30);
      expect(m.xf[29 * 10]).toBe(32);
    });
  }
});
