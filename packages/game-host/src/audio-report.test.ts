/**
 * The audio report (Play diagnostics' audio block) over a fake Web Audio
 * graph: the unlock state before and after the player's first gesture (and
 * the browser refusing it), what plays by bus, and the sounds that did not
 * play — muted, before the unlock, too late, over the voice cap — each
 * counted by why with the newest notes saying which sound.
 */
import { describe, expect, it } from 'vitest';

import { AUDIO_REPORT_LISTED, AUDIO_REPORT_NOTES, createGameAudioOwner, type AudioCommandLike } from './audio';

type Any = any;

function fakeContext(): Any {
  const ctx: Any = {
    state: 'suspended',
    currentTime: 0,
    resume: async () => {
      if (ctx.refuse === true) throw new Error('NotAllowedError');
      ctx.state = 'running';
    },
    suspend: async () => {
      ctx.state = 'suspended';
    },
    close: async () => {
      ctx.state = 'closed';
    },
    decodeAudioData: async () => ({ duration: 2, sampleRate: 48000, length: 96000 }),
    createBufferSource: () => ({ buffer: null, onended: null, loop: false, playbackRate: { value: 1 }, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    destination: { connect() {} },
  };
  return ctx;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const play = (handle: number, assetId: string, extra: Partial<Extract<AudioCommandLike, { op: 'play' }>> = {}): AudioCommandLike => ({ op: 'play', stepIndex: 0, handle, assetId, bus: 'sfx', volume: 1, loop: false, pitch: 1, fadeIn: 0, ...extra });

describe('the audio report', () => {
  it('before the first gesture: locked, nothing plays, a sound that cannot wait is dropped as locked; after: unlocked, music and sounds by bus', async () => {
    let clock = 0;
    const ctx = fakeContext();
    const owner = createGameAudioOwner({ contextFactory: () => ctx, now: () => clock });
    owner.registerCue('step', new Uint8Array([1]));
    owner.registerCue('line', new Uint8Array([2]));
    owner.registerMusic!('theme', new Uint8Array([3]));

    let r = owner.report!();
    expect(r.unlock).toEqual({ state: 'locked', reason: 'waiting_for_gesture', context: 'none', muted: false, hidden: false });
    // The music and a sound asked for before the gesture wait; a sound with no wait allowed is dropped.
    owner.command!({ op: 'music', stepIndex: 0, assetId: 'theme', fade: 0 } as AudioCommandLike);
    owner.command!(play(1, 'step', { maxLateMs: 0 }));
    owner.command!(play(2, 'step', { maxLateMs: 500 }));
    r = owner.report!();
    expect(r.playing.music).toEqual({ assetId: 'theme', playing: false, waitingFor: 'unlock' });
    expect(r.playing).toMatchObject({ voices: 0, pending: 1, loops: 0 });
    expect(r.playing.list).toEqual([{ assetId: 'step', bus: 'sfx', kind: 'sound', state: 'pending' }]);
    expect(r.skipped).toEqual({ locked: 1 });
    expect(r.late).toMatchObject({ started: 0, dropped: 1 });
    expect(r.late.recent[0]).toMatchObject({ assetId: 'step', outcome: 'dropped', waitedFor: 'unlock' });
    expect(r.notes.at(-1)).toContain('sound 1 (step) dropped');

    // The player's first key press or click.
    clock = 100;
    await owner.unlock();
    await flush();
    owner.spatialFrame?.(null, () => null);
    owner.command!(play(3, 'line', { bus: 'voice' }));
    r = owner.report!();
    expect(r.unlock).toEqual({ state: 'unlocked', context: 'running', muted: false, hidden: false });
    expect(r.playing.music).toEqual({ assetId: 'theme', playing: true });
    // The waiting sound started late; the voice line at once.
    expect(r.playing.byBus).toEqual({ sfx: 1, ui: 0, voice: 1, music: 1 });
    expect(r.playing).toMatchObject({ voices: 2, pending: 0 });
    expect(r.started).toEqual({ sfx: 1, ui: 0, voice: 1, music: 1 });
    expect(r.late).toMatchObject({ started: 1, dropped: 1 });

    // Muted: a play is skipped as muted.
    owner.setMuted(true);
    owner.command!(play(4, 'step'));
    r = owner.report!();
    expect(r.unlock.muted).toBe(true);
    expect(r.skipped).toEqual({ locked: 1, muted: 1 });
    expect(r.notes.at(-1)).toContain('sound 4 (step) skipped: muted');
    owner.dispose();
    expect(owner.report!().unlock.state).toBe('disposed');
  });

  it('the browser refusing the gesture is blocked (autoplay_denied); no Web Audio is unsupported', async () => {
    const ctx = fakeContext();
    ctx.refuse = true;
    const owner = createGameAudioOwner({ contextFactory: () => ctx });
    await owner.unlock();
    expect(owner.report!().unlock).toEqual({ state: 'blocked', reason: 'autoplay_denied', context: 'suspended', muted: false, hidden: false });
    const none = createGameAudioOwner({ contextFactory: () => null });
    await none.unlock();
    expect(none.report!().unlock).toMatchObject({ state: 'unsupported', reason: 'no_audio_context', context: 'none' });
    expect(createGameAudioOwner({}).report!().unlock.state).toBe('unsupported');
  });

  it('cues over the voice cap and of unknown files are counted by why; the list and notes stay bounded', async () => {
    const owner = createGameAudioOwner({ contextFactory: () => fakeContext(), maxVoices: 2 });
    owner.registerCue('hit', new Uint8Array([1]));
    await owner.unlock();
    await flush();
    const ev = (i: number, assetId = 'hit') => ({ id: `r/hit/${i}`, kind: 'hit', assetId, runId: 'r', stepIndex: i });
    for (let i = 0; i < 12; i += 1) owner.submit([ev(i)]);
    owner.submit([ev(99, 'nothing')]);
    const r = owner.report!();
    expect(r.playing.voices).toBe(2);
    expect(r.started.sfx).toBe(2);
    expect(r.skipped).toEqual({ voice_cap: 10, not_registered: 1 });
    expect(r.notes).toHaveLength(AUDIO_REPORT_NOTES);
    expect(r.notes.at(-1)).toContain('nothing');
    for (let h = 1; h <= 20; h += 1) owner.command!(play(h, 'hit', { loop: true }));
    expect(owner.report!().playing.list.length).toBeLessThanOrEqual(AUDIO_REPORT_LISTED);
    expect(JSON.stringify(owner.report!()).length).toBeLessThan(4096);
  });
});
