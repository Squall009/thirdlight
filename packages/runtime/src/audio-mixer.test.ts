/**
 * The audio intent log — handle commands, fade maths, finished
 * events (seen the step after), music ownership, duck priorities, stingers,
 * the bus mix, reset and the positional maths the host shares.
 */
import { describe, expect, it } from 'vitest';

import { AUDIO_MAX_PLAYS_PER_STEP, AudioMixer, distanceGain, listenerRelative, type AudioCommand } from './audio-mixer';

const HZ = 120;

/** A mixer driven like the runtime: calls during step `s`, then endStep, then s + 1. */
function rig(durations: Record<string, number> = {}): { mix: AudioMixer; step: () => void; now: () => number } {
  let s = 0;
  const mix = new AudioMixer(HZ, durations, () => s);
  return {
    mix,
    step: () => {
      mix.endStep();
      s += 1;
    },
    now: () => s,
  };
}

describe('audio intent log', () => {
  it('a play gets a handle and one command; stop, fade, pitch, loop and volume each add one, in order', () => {
    const { mix } = rig();
    const h = mix.play('loop-a', { loop: true, volume: 0.8, pitch: 1.25 });
    expect(h).toBe(1);
    mix.setPitch(h, 1.5);
    mix.setLoop(h, false);
    mix.setVolume(h, 0.5);
    mix.fade(h, 0.2, 1);
    mix.stop(h, 0.25);
    const cmds = mix.take();
    expect(cmds.map((c) => c.op)).toEqual(['play', 'set', 'set', 'set', 'fade', 'stop']);
    expect(cmds[0]).toMatchObject({ op: 'play', handle: 1, assetId: 'loop-a', bus: 'sfx', volume: 0.8, loop: true, pitch: 1.25, fadeIn: 0, stepIndex: 0 });
    expect(cmds[1]).toMatchObject({ op: 'set', handle: 1, pitch: 1.5 });
    expect(cmds[2]).toMatchObject({ op: 'set', handle: 1, loop: false });
    expect(cmds[4]).toMatchObject({ op: 'fade', handle: 1, to: 0.2, seconds: 1 });
    expect(cmds[5]).toMatchObject({ op: 'stop', handle: 1, fade: 0.25 });
    // Values are clamped; handles keep counting.
    expect(mix.play('b', { volume: 7, pitch: 99 })).toBe(2);
    expect(mix.take()[0]).toMatchObject({ volume: 1, pitch: 4 });
    expect(mix.play('')).toBe(0);
    expect(mix.take()).toEqual([]);
  });

  it('fade maths: linear over round(seconds · hz) whole steps; a fade from the value now', () => {
    const { mix, step } = rig();
    const h = mix.play('a', { loop: true, volume: 1 });
    mix.fade(h, 0, 0.5); // 60 steps
    expect(mix.volumeOf(h)).toBe(1);
    for (let k = 1; k <= 30; k += 1) step();
    expect(mix.volumeOf(h)).toBeCloseTo(0.5, 12);
    mix.fade(h, 1, 0.25); // from 0.5 to 1 over 30 steps
    for (let k = 1; k <= 15; k += 1) step();
    expect(mix.volumeOf(h)).toBeCloseTo(0.75, 12);
    for (let k = 1; k <= 20; k += 1) step();
    expect(mix.volumeOf(h)).toBe(1);
    // A fade-in starts from silence.
    const g = mix.play('b', { loop: true, volume: 0.6, fadeIn: 0.1 }); // 12 steps
    expect(mix.volumeOf(g)).toBe(0);
    for (let k = 1; k <= 6; k += 1) step();
    expect(mix.volumeOf(g)).toBeCloseTo(0.3, 12);
  });

  it('a clip finishes when it reaches its recorded length (pitch speeds it up); the event is seen in the next step only', () => {
    const { mix, step, now } = rig({ bark: 250 }); // 30 steps at pitch 1
    const a = mix.play('bark');
    const b = mix.play('bark', { pitch: 2 }); // 15 steps
    const ends: Record<number, number> = {};
    for (let k = 0; k < 40; k += 1) {
      for (const e of mix.events()) ends[e.handle] = now();
      step();
    }
    // Played in step 0: b reaches 0.25 s at the end of step 14, seen in step 15; a at the end of 29, seen in 30.
    expect(ends).toEqual({ [b]: 15, [a]: 30 });
    expect(mix.playing(a)).toBe(false);
  });

  it('stop: without a fade it finishes at this step end; with a fade when the fade ends (reason stopped); an unknown length never ends by itself', () => {
    const { mix, step } = rig();
    const a = mix.play('x', { loop: false });
    const b = mix.play('y', { loop: true });
    for (let k = 0; k < 500; k += 1) step();
    expect(mix.playing(a)).toBe(true); // no recorded duration: plays until stopped
    mix.stop(a);
    mix.stop(b, 0.1); // 12 steps
    expect(mix.playing(a)).toBe(true);
    step();
    expect(mix.events()).toEqual([{ kind: 'finished', handle: a, assetId: 'x', reason: 'stopped' }]);
    expect(mix.finished(a)).toBe(true);
    step();
    expect(mix.finished(a)).toBe(false); // one step only
    for (let k = 0; k < 10; k += 1) step();
    expect(mix.finished(b)).toBe(true);
    expect(mix.events()[0]!.reason).toBe('stopped');
    // Calls on a finished handle do nothing.
    mix.take();
    mix.fade(b, 1, 1);
    mix.setPitch(a, 2);
    expect(mix.take()).toEqual([]);
  });

  it('a loop turned off ends at the end of its current pass', () => {
    const { mix, step, now } = rig({ loop: 100 }); // 12 steps per pass
    const h = mix.play('loop', { loop: true });
    for (let k = 0; k < 30; k += 1) step(); // 2.5 passes
    mix.setLoop(h, false);
    let seen = -1;
    for (let k = 0; k < 20 && seen < 0; k += 1) {
      step();
      if (mix.finished(h)) seen = now();
    }
    expect(seen).toBe(36); // 30 steps played = 6 steps into the third pass; 6 more end it (end of step 35)
  });

  it('music: a script track owns the music until released; the flow owns it otherwise', () => {
    const { mix } = rig();
    expect(mix.musicState()).toEqual({ owner: 'flow', track: null, duck: 1 });
    mix.music('battle', 2);
    expect(mix.musicState()).toEqual({ owner: 'script', track: 'battle', duck: 1 });
    mix.music(null);
    expect(mix.musicState()).toEqual({ owner: 'script', track: null, duck: 1 });
    mix.releaseMusic(0.5);
    expect(mix.musicState().owner).toBe('flow');
    expect(mix.take()).toEqual([
      { op: 'music', stepIndex: 0, assetId: 'battle', fade: 2 },
      { op: 'music', stepIndex: 0, assetId: null, fade: 1 },
      { op: 'music', stepIndex: 0, assetId: null, fade: 0.5, release: true },
    ]);
  });

  it('duck priorities: the deepest request alive wins; ending it restores the next deepest; a stinger ducks while it plays', () => {
    const { mix, step } = rig({ sting: 500 }); // 60 steps
    mix.duck(0.5, 0.2);
    expect(mix.musicState().duck).toBe(0.5);
    const s = mix.stinger('sting', { duck: 0.2, fade: 0.1 });
    expect(mix.musicState().duck).toBe(0.2);
    mix.unduck(); // the script's duck ends; the stinger's (deeper) still holds
    expect(mix.musicState().duck).toBe(0.2);
    mix.duck(0.1);
    expect(mix.musicState().duck).toBe(0.1);
    mix.unduck();
    for (let k = 0; k < 60; k += 1) step();
    expect(mix.finished(s)).toBe(true);
    expect(mix.musicState().duck).toBe(1);
    const ducks = mix.take().filter((c): c is Extract<AudioCommand, { op: 'duck' }> => c.op === 'duck');
    expect(ducks.map((d) => [d.level, d.seconds, d.stepIndex])).toEqual([
      [0.5, 0.2, 0],
      [0.2, 0.1, 0],
      [0.1, 0.25, 0],
      [0.2, 0.25, 0],
      [1, 0.1, 59],
    ]);
    const play = mix.take();
    expect(play).toEqual([]);
  });

  it('a stinger plays once on the music bus; the bus mix ramps like a fade', () => {
    const { mix, step } = rig();
    mix.stinger('sting');
    const [c] = mix.take();
    expect(c).toMatchObject({ op: 'play', bus: 'music', stinger: true, loop: false });
    mix.setBusVolume('sfx', 0.5, 0.5);
    for (let k = 0; k < 30; k += 1) step();
    expect(mix.busVolume('sfx')).toBeCloseTo(0.75, 12);
    expect(mix.busVolume('voice')).toBe(1);
    expect(mix.take().find((x) => x.op === 'bus')).toMatchObject({ bus: 'sfx', volume: 0.5, seconds: 0.5 });
  });

  it('positional plays carry their place and distance model; limits refuse with 0', () => {
    const { mix } = rig();
    mix.play('p', { entityId: 'box-1', position: [0, 1, 0], distanceModel: 'inverse', refDistance: 1, maxDistance: 50, rolloff: 2 });
    mix.play('q', { position: [3, 0, 0] });
    const [a, b] = mix.take();
    expect(a).toMatchObject({ entityId: 'box-1', position: [0, 1, 0], spatial: { distanceModel: 'inverse', refDistance: 1, maxDistance: 50, rolloff: 2 } });
    expect(b).toMatchObject({ position: [3, 0, 0], spatial: { distanceModel: 'linear', refDistance: 2, maxDistance: 30, rolloff: 1 } });
    expect((b as { entityId?: string }).entityId).toBeUndefined();
    for (let k = 2; k < AUDIO_MAX_PLAYS_PER_STEP; k += 1) mix.play('z');
    expect(mix.play('z')).toBe(0);
  });

  it('reset: script voices go without events, the music back to the flow, duck and mix to 1; the state is null until scripts use audio', () => {
    const { mix, step } = rig();
    expect(mix.state()).toBeNull();
    mix.reset();
    expect(mix.take()).toEqual([]); // nothing to reset: no command
    const h = mix.play('a', { loop: true });
    mix.music('m');
    mix.duck(0.3);
    mix.setBusVolume('music', 0.2);
    step();
    mix.reset();
    expect(mix.playing(h)).toBe(false);
    expect(mix.events()).toEqual([]);
    expect(mix.musicState()).toEqual({ owner: 'flow', track: null, duck: 1 });
    expect(mix.busVolume('music')).toBe(1);
    expect(mix.take().at(-1)).toEqual({ op: 'reset', stepIndex: 1 });
    expect(mix.play('b')).toBe(2); // handles stay unique across runs
  });
});

describe('positional maths', () => {
  it('distance gain: the Web Audio PannerNode formulas', () => {
    const lin = { distanceModel: 'linear' as const, refDistance: 2, maxDistance: 12, rolloff: 1 };
    expect(distanceGain(lin, 1)).toBe(1);
    expect(distanceGain(lin, 7)).toBeCloseTo(0.5, 12);
    expect(distanceGain(lin, 40)).toBe(0);
    const inv = { distanceModel: 'inverse' as const, refDistance: 1, maxDistance: 100, rolloff: 1 };
    expect(distanceGain(inv, 4)).toBeCloseTo(0.25, 12);
    const exp = { distanceModel: 'exponential' as const, refDistance: 1, maxDistance: 100, rolloff: 2 };
    expect(distanceGain(exp, 2)).toBeCloseTo(0.25, 12);
  });

  it('a source to the listener camera\'s right pans right; the camera\'s turn is followed', () => {
    const identity = [0, 0, 0, 1];
    expect(listenerRelative([0, 0, 10], identity, [3, 0, 10]).pan).toBeCloseTo(1, 12);
    expect(listenerRelative([0, 0, 10], identity, [-3, 0, 0]).pan).toBeLessThan(0);
    expect(listenerRelative([0, 0, 10], identity, [0, 0, 0]).pan).toBeCloseTo(0, 12);
    // Turned 90° left (yaw +90° about +Y): what was ahead (−Z) is now on the right... a source at −X is ahead.
    const s = Math.SQRT1_2;
    const yawLeft = [0, s, 0, s];
    expect(listenerRelative([0, 0, 0], yawLeft, [-5, 0, 0]).pan).toBeCloseTo(0, 12);
    expect(listenerRelative([0, 0, 0], yawLeft, [0, 0, -5]).pan).toBeCloseTo(1, 12);
    expect(listenerRelative([0, 0, 0], yawLeft, [0, 0, -5]).distance).toBeCloseTo(5, 12);
  });
});
