/**
 * Phase 23.13: the audio owner executes the simulation's audio commands over
 * a fake Web Audio graph — handle voices (loop, pitch, fade, stop), the
 * music held by scripts over the host's track, the duck node, the scripts'
 * bus mix, positional voices through an equal-power panner with the
 * listener on the camera, and the observation of the graph.
 */
import { describe, expect, it } from 'vitest';

import { AUDIO_PANNING_MODEL, createGameAudioOwner, type AudioCommandLike } from './audio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fakeContext() {
  const sources: Any[] = [];
  const gains: Any[] = [];
  const panners: Any[] = [];
  const param = (v: number): Any => ({ value: v });
  const ctx: Any = {
    state: 'running',
    currentTime: 10,
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
    decodeAudioData: async () => ({ duration: 2, sampleRate: 48000, length: 96000 }),
    createBufferSource: () => {
      const s: Any = { buffer: null, onended: null, loop: false, started: false, stoppedAt: null, playbackRate: param(1), to: null, connect(t: Any) { s.to = t; }, start() { s.started = true; }, stop(when?: number) { s.stoppedAt = when ?? 'now'; } };
      sources.push(s);
      return s;
    },
    createGain: () => {
      const g: Any = {
        gain: {
          value: 1,
          ramps: [] as number[][],
          setValueAtTime(v: number) { g.gain.value = v; },
          cancelScheduledValues() {},
          linearRampToValueAtTime(v: number, t: number) { g.gain.ramps.push([v, t]); g.gain.value = v; },
        },
        to: null,
        connect(t: Any) { g.to = t; },
        disconnect() { g.to = null; },
      };
      gains.push(g);
      return g;
    },
    createPanner: () => {
      const p: Any = { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, positionX: param(0), positionY: param(0), positionZ: param(0), to: null, connect(t: Any) { p.to = t; }, disconnect() { p.to = null; } };
      panners.push(p);
      return p;
    },
    listener: { positionX: param(0), positionY: param(0), positionZ: param(0), forwardX: param(0), forwardY: param(0), forwardZ: param(-1), upX: param(0), upY: param(1), upZ: param(0) },
    destination: { connect() {} },
  };
  return { ctx, sources, gains, panners };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const play = (handle: number, assetId: string, extra: Partial<Extract<AudioCommandLike, { op: 'play' }>> = {}): AudioCommandLike => ({ op: 'play', stepIndex: 0, handle, assetId, bus: 'sfx', volume: 1, loop: false, pitch: 1, fadeIn: 0, ...extra });

async function ready() {
  const f = fakeContext();
  const owner = createGameAudioOwner({ contextFactory: () => f.ctx });
  owner.registerCue('hum', new Uint8Array([1]));
  owner.registerCue('bark', new Uint8Array([2]));
  owner.registerMusic!('theme', new Uint8Array([3]));
  owner.registerMusic!('battle', new Uint8Array([4]));
  await owner.unlock();
  await flush();
  const [master, musicBus, sfx, ui, voice] = f.gains;
  return { f, owner, master, musicBus, sfx, ui, voice };
}

describe('audio owner: script sound handles', () => {
  it('a loop starts with its pitch, changes pitch, fades (a ramp on its gain) and stops after its fade', async () => {
    const { f, owner, sfx } = await ready();
    owner.command!(play(1, 'hum', { loop: true, volume: 0.8, pitch: 1.25 }));
    const src = f.sources.at(-1);
    expect(src.started).toBe(true);
    expect(src.loop).toBe(true);
    expect(src.playbackRate.value).toBe(1.25);
    expect(src.to.gain.value).toBe(0.8);
    expect(src.to.to).toBe(sfx);
    owner.command!({ op: 'set', stepIndex: 1, handle: 1, pitch: 1.5 });
    expect(src.playbackRate.value).toBe(1.5);
    owner.command!({ op: 'fade', stepIndex: 2, handle: 1, to: 0.2, seconds: 1 });
    expect(src.to.gain.ramps.at(-1)).toEqual([0.2, 11]);
    let obs = owner.observeAudio!()!;
    expect(obs.voices).toEqual([{ handle: 1, assetId: 'hum', bus: 'sfx', state: 'playing', loop: true, gain: 0.2, rate: 1.5 }]);
    owner.command!({ op: 'stop', stepIndex: 3, handle: 1, fade: 0.5 });
    expect(src.stoppedAt).toBe(10.5);
    expect(owner.observeAudio!()!.voices[0]!.state).toBe('stopping');
    src.onended?.();
    obs = owner.observeAudio!()!;
    expect(obs.voices).toEqual([]);
    expect(owner.liveVoices()).toBe(0);
    expect(owner.soundsPlayed!()).toEqual({ sfx: 1, ui: 0 });
  });

  it('a play waiting for its bytes starts on a later frame; a one-shot that cannot start in time is dropped', async () => {
    const f = fakeContext();
    const owner = createGameAudioOwner({ contextFactory: () => f.ctx });
    owner.command!(play(1, 'late', { loop: true })); // not registered yet, not unlocked
    owner.command!(play(2, 'late'));
    expect(owner.observeAudio!()!.voices.map((v) => v.state)).toEqual(['pending', 'pending']);
    await owner.unlock();
    owner.registerCue('late', new Uint8Array([5]));
    await flush();
    owner.spatialFrame!(null, () => null);
    expect(owner.observeAudio!()!.voices.map((v) => [v.handle, v.state])).toEqual([[1, 'playing'], [2, 'playing']]);
    // A one-shot for an asset that never arrives gives up.
    owner.command!(play(3, 'never'));
    for (let k = 0; k < 40; k += 1) owner.spatialFrame!(null, () => null);
    expect(owner.observeAudio!()!.voices.map((v) => v.handle)).toEqual([1, 2]);
  });

  it('music: the scripts hold a track over the host\'s; release gives it back; the duck node sits between the tracks and the music bus', async () => {
    const { f, owner, musicBus } = await ready();
    owner.playMusic!('theme', 0);
    await flush();
    expect(owner.musicStatus!()).toMatchObject({ assetId: 'theme', playing: true });
    const duck = f.gains[5];
    expect(duck.to).toBe(musicBus);
    expect(f.sources.find((s: Any) => s.loop === true).to.to).toBe(duck);
    owner.command!({ op: 'music', stepIndex: 5, assetId: 'battle', fade: 0 });
    await flush();
    expect(owner.musicStatus!()).toMatchObject({ assetId: 'battle', playing: true });
    // The host changes its track while the script holds the music: the script's track stays.
    owner.playMusic!('theme', 0);
    await flush();
    expect(owner.musicStatus!().assetId).toBe('battle');
    expect(owner.observeAudio!()!.music).toMatchObject({ owner: 'script', assetId: 'battle' });
    owner.command!({ op: 'duck', stepIndex: 6, level: 0.3, seconds: 0.25 });
    expect(duck.gain.ramps.at(-1)).toEqual([0.3, 10.25]);
    expect(owner.observeAudio!()!.music.duck).toBe(0.3);
    owner.command!({ op: 'music', stepIndex: 7, assetId: null, fade: 0, release: true });
    await flush();
    expect(owner.musicStatus!()).toMatchObject({ assetId: 'theme', playing: true });
    // A stinger plays on the music bus beside (not under) the duck.
    owner.command!(play(9, 'bark', { bus: 'music', stinger: true }));
    expect(f.sources.at(-1).to.to).toBe(musicBus);
  });

  it('the scripts\' bus mix multiplies the player\'s volume; a reset stops script voices and restores music, duck and mix', async () => {
    const { f, owner, sfx, voice } = await ready();
    owner.setVolume!('sfx', 0.5);
    owner.command!({ op: 'bus', stepIndex: 1, bus: 'sfx', volume: 0.5, seconds: 0 });
    expect(sfx.gain.value).toBeCloseTo(0.25, 12);
    owner.command!(play(1, 'hum', { bus: 'voice', loop: true }));
    const onVoice = f.sources.at(-1);
    expect(onVoice.to.to).toBe(voice);
    owner.command!({ op: 'music', stepIndex: 2, assetId: 'battle', fade: 0 });
    owner.command!({ op: 'reset', stepIndex: 3 });
    expect(onVoice.stoppedAt).toBe('now');
    const obs = owner.observeAudio!()!;
    expect(obs.voices).toEqual([]);
    expect(obs.music.owner).toBe('host');
    expect(obs.buses.sfx).toBeCloseTo(0.5, 12);
  });
});

describe('audio owner: positional sound', () => {
  it('a positional voice goes through an equal-power panner; the listener is the camera; right of it pans right, farther is quieter; it follows its entity', async () => {
    const { f, owner, sfx } = await ready();
    const spatial = { distanceModel: 'linear' as const, refDistance: 2, maxDistance: 30, rolloff: 1 };
    owner.command!(play(1, 'hum', { loop: true, position: [3, 0, 0], spatial }));
    owner.command!(play(2, 'hum', { loop: true, position: [12, 0, 0], spatial }));
    owner.command!(play(3, 'hum', { loop: true, entityId: 'cart', position: [0, 1, 0], spatial }));
    const [p1, p2, p3] = f.panners;
    expect(p1.panningModel).toBe(AUDIO_PANNING_MODEL);
    expect(p1.panningModel).toBe('equalpower');
    expect(p1.distanceModel).toBe('linear');
    expect(p1.maxDistance).toBe(30);
    expect(p1.to).toBe(sfx);
    // The camera 10 m back on +Z looking down −Z; the cart at x = −4.
    const carts: Record<string, number[]> = { cart: [-4, 0, 0] };
    owner.spatialFrame!({ position: [0, 0, 10], rotation: [0, 0, 0, 1] }, (id) => carts[id] ?? null);
    expect(f.ctx.listener.positionZ.value).toBe(10);
    expect(f.ctx.listener.forwardZ.value).toBe(-1);
    expect([p3.positionX.value, p3.positionY.value, p3.positionZ.value]).toEqual([-4, 1, 0]);
    const v = owner.observeAudio!()!.voices;
    expect(v[0]!.pan).toBeGreaterThan(0);
    expect(v[1]!.pan).toBeGreaterThan(v[0]!.pan!);
    expect(v[1]!.distanceGain).toBeLessThan(v[0]!.distanceGain!);
    expect(v[2]!.pan).toBeLessThan(0);
    // The cart moves right past the camera.
    carts['cart'] = [6, 0, 10];
    owner.spatialFrame!({ position: [0, 0, 10], rotation: [0, 0, 0, 1] }, (id) => carts[id] ?? null);
    expect(owner.observeAudio!()!.voices[2]!.pan).toBeGreaterThan(0.95);
    void p2;
  });

  it('an audio source in the panner model loops through a panner at its place; removing it stops it', async () => {
    const { f, owner } = await ready();
    owner.setSpatialLoop!('src-1', 'hum', 0.8, [5, 0, 0], { distanceModel: 'inverse', refDistance: 3, maxDistance: 12, rolloff: 1 });
    const p = f.panners.at(-1);
    expect(p.distanceModel).toBe('inverse');
    expect(p.positionX.value).toBe(5);
    owner.setSpatialLoop!('src-1', 'hum', 0.8, [6, 0, 0], { distanceModel: 'inverse', refDistance: 3, maxDistance: 12, rolloff: 1 });
    expect(p.positionX.value).toBe(6);
    expect(owner.loops!()).toEqual({ 'src-1': 0.8 });
    expect(owner.observeAudio!()!.voices).toMatchObject([{ handle: 0, key: 'src-1', gain: 0.8, pan: 1 }]);
    owner.setLoop!('src-1', null, 0);
    expect(owner.loops!()).toEqual({});
    expect(owner.observeAudio!()).toBeNull();
  });
});
