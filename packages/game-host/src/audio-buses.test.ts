/**
 * Phase 9.10: the audio owner's buses (master/music/sfx), looping music with
 * a crossfade target, one-shot sounds and looping emitters — over a fake
 * Web Audio graph that records connections and gains.
 */
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner } from './audio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fakeContext() {
  const sources: Any[] = [];
  const gains: Any[] = [];
  const ctx: Any = {
    state: 'running',
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
    decodeAudioData: async () => ({ duration: 2, sampleRate: 48000, length: 96000 }),
    createBufferSource: () => {
      const s: Any = { buffer: null, onended: null, loop: false, started: false, stopped: false, to: null, connect(t: Any) { s.to = t; }, start() { s.started = true; }, stop() { s.stopped = true; } };
      sources.push(s);
      return s;
    },
    createGain: () => {
      const g: Any = { gain: { value: 1 }, to: null, connect(t: Any) { g.to = t; }, disconnect() { g.to = null; } };
      gains.push(g);
      return g;
    },
    destination: { connect() {} },
  };
  return { ctx, sources, gains };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('audio buses, music, sounds and loops', () => {
  it('routes music and sounds through their buses; volumes set the bus gains; music loops and switches', async () => {
    const f = fakeContext();
    const owner = createGameAudioOwner({ contextFactory: () => f.ctx });
    owner.registerMusic!('m1', new Uint8Array([1, 2]));
    owner.registerMusic!('m2', new Uint8Array([3, 4]));
    owner.playMusic!('m1', 0);
    expect(owner.musicStatus!()).toEqual({ assetId: 'm1', playing: false, gain: 0.8 }); // waits for the gesture
    await owner.unlock();
    await flush();
    expect(owner.musicStatus!()).toMatchObject({ assetId: 'm1', playing: true });
    const [master, musicBus, sfx] = f.gains;
    expect(musicBus.to).toBe(master);
    expect(sfx.to).toBe(master);
    expect(master.to).toBe(f.ctx.destination);
    const track = f.sources.find((s) => s.loop === true);
    expect(track.started).toBe(true);
    owner.setVolume!('music', 0.3);
    expect(musicBus.gain.value).toBeCloseTo(0.3, 5);
    expect(owner.musicStatus!().gain).toBeCloseTo(0.3, 5);
    owner.playMusic!('m2', 0);
    await flush();
    expect(track.stopped).toBe(true);
    expect(owner.musicStatus!()).toMatchObject({ assetId: 'm2', playing: true });
    owner.setMuted(true);
    expect(master.gain.value).toBe(0);
    owner.setMuted(false);
    expect(master.gain.value).toBe(1);
    // A one-shot sound and a looping emitter through the sfx bus.
    owner.registerCue('beep', new Uint8Array([9]));
    await flush();
    expect(owner.playSound!('beep', 0.5)).toBe(true);
    const beep = f.sources[f.sources.length - 1];
    expect(beep.to.gain.value).toBe(0.5);
    expect(beep.to.to).toBe(sfx);
    owner.setLoop!('brook', 'beep', 0.2);
    owner.setLoop!('brook', 'beep', 0.6);
    expect(owner.loops!()).toEqual({ brook: 0.6 });
    const loop = f.sources[f.sources.length - 1];
    expect(loop.loop).toBe(true);
    owner.setLoop!('brook', null, 0);
    expect(loop.stopped).toBe(true);
    expect(owner.loops!()).toEqual({});
  });
});
