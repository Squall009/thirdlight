/**
 * One audio kind in the model: an audio record of any format, channel count,
 * rate and length validates; its load settings are optional (the defaults
 * follow its length); the older `music` records and the fixed short-sound
 * profile's records upgrade to it with their ids kept; the browser-support
 * rules name what Safari does not play.
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIO_DECODE_ON_LOAD_BELOW_MS,
  AUDIO_STREAM_ABOVE_MS,
  audioLoadOf,
  audioPlaybackGaps,
  audioSummaryOf,
  defaultAudioLoadType,
  upgradeAudioAssets,
  upgradeAudioRecord,
} from './audio-assets';
import { validateContentV4 } from './index';

const RECIPE = { profile: 'audio', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } };
const record = (metrics: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  assetId: 'clip',
  kind: 'audio',
  displayName: 'Clip',
  currentVersion: 1,
  versions: [{ version: 1, sourceDigest: 'a'.repeat(64), sourceByteLength: 1000, sourcePath: 'assets/clip.ogg', importRecipe: RECIPE, metrics, importedAt: '2026-09-30T00:00:00Z', publishedRevision: 1 }],
  ...extra,
});
const content = (assets: unknown[]) => ({ assets, prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'] });
const valid = (r: unknown): boolean => validateContentV4(content([r])).ok;

describe('the audio record', () => {
  it('takes every format at any channel count, rate, bit depth and length', () => {
    expect(valid(record({ format: 'ogg-opus', channels: 2, sampleRate: 48000, durationMs: 7_200_000 }))).toBe(true);
    expect(valid(record({ format: 'ogg-vorbis', channels: 6, sampleRate: 44100, durationMs: 500 }))).toBe(true);
    expect(valid(record({ format: 'mp3', channels: 1, sampleRate: 22050, durationMs: 1 }))).toBe(true);
    expect(valid(record({ format: 'flac', channels: 8, sampleRate: 192000, bitsPerSample: 24, durationMs: 60_000 }))).toBe(true);
    expect(valid(record({ format: 'wav', channels: 2, sampleRate: 96000, bitsPerSample: 32, float: true, durationMs: 3 }))).toBe(true);
  });

  it('refuses facts that do not fit the format', () => {
    expect(valid(record({ format: 'aac', channels: 2, sampleRate: 48000, durationMs: 10 }))).toBe(false);
    expect(valid(record({ format: 'wav', channels: 2, sampleRate: 48000, durationMs: 10 }))).toBe(false); // a WAV states its bits
    expect(valid(record({ format: 'mp3', channels: 2, sampleRate: 48000, bitsPerSample: 16, durationMs: 10 }))).toBe(false);
    expect(valid(record({ format: 'flac', channels: 2, sampleRate: 48000, bitsPerSample: 16, float: true, durationMs: 10 }))).toBe(false);
    expect(valid(record({ format: 'ogg-opus', channels: 0, sampleRate: 48000, durationMs: 10 }))).toBe(false);
    expect(valid(record({ format: 'ogg-opus', channels: 2, sampleRate: 48000, durationMs: 0 }))).toBe(false);
    // The older recipe is upgraded on open, never taken as it is.
    expect(valid({ ...record({ format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 10 }), versions: [{ ...record({}).versions[0]!, importRecipe: { ...RECIPE, profile: 'pcm-wav' }, metrics: { format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 10 } }] })).toBe(false);
    expect(valid({ ...record({ format: 'mp3', channels: 1, sampleRate: 48000, durationMs: 10 }), kind: 'music' })).toBe(false);
  });

  it('stores only a changed load setting, and only on audio', () => {
    const m = { format: 'ogg-opus', channels: 1, sampleRate: 48000, durationMs: 3000 };
    expect(valid(record(m, { loadType: 'stream', preload: false }))).toBe(true);
    expect(valid(record(m, { loadType: 'compressed-in-memory' }))).toBe(false);
    expect(valid(record(m, { preload: true }))).toBe(false); // true is the default, stored as absence
    const r = validateContentV4(content([record(m, { loadType: 'decode-while-playing', preload: false })]));
    expect(r.ok && r.normalized.assets[0]).toMatchObject({ loadType: 'decode-while-playing', preload: false });
  });
});

describe('the load settings', () => {
  it('default by length: decoded on load under 5 s, streamed over 60 s, decoded while playing between', () => {
    expect([AUDIO_DECODE_ON_LOAD_BELOW_MS, AUDIO_STREAM_ABOVE_MS]).toEqual([5_000, 60_000]);
    expect(defaultAudioLoadType(1)).toBe('decode-on-load');
    expect(defaultAudioLoadType(4_999)).toBe('decode-on-load');
    expect(defaultAudioLoadType(5_000)).toBe('decode-while-playing');
    expect(defaultAudioLoadType(60_000)).toBe('decode-while-playing');
    expect(defaultAudioLoadType(60_001)).toBe('stream');
  });

  it("an asset's own settings win; preload is on unless turned off", () => {
    const long = record({ format: 'mp3', channels: 2, sampleRate: 44100, durationMs: 180_000 });
    expect(audioLoadOf(long)).toEqual({ loadType: 'stream', preload: true });
    expect(audioLoadOf({ ...long, loadType: 'decode-on-load', preload: false })).toEqual({ loadType: 'decode-on-load', preload: false });
    expect(audioSummaryOf({ ...long, preload: false })).toEqual({ format: 'mp3', channels: 2, sampleRate: 44100, durationMs: 180_000, loadType: 'stream', loadTypeSet: false, preload: false });
    expect(audioSummaryOf({ ...long, kind: 'model' })).toBeUndefined();
  });

  it('names what a browser does not play: Ogg in older Safari, past 32 channels, outside 8-96 kHz', () => {
    expect(audioPlaybackGaps({ format: 'mp3', channels: 2, sampleRate: 44100 })).toEqual([]);
    expect(audioPlaybackGaps({ format: 'flac', channels: 2, sampleRate: 96000 })).toEqual([]);
    expect(audioPlaybackGaps({ format: 'ogg-opus', channels: 2, sampleRate: 48000 })).toEqual(['Safari older than 18.4 (macOS 15.4, iOS 18.4) does not play Ogg Opus']);
    expect(audioPlaybackGaps({ format: 'ogg-vorbis', channels: 2, sampleRate: 48000 })[0]).toContain('Ogg Vorbis');
    expect(audioPlaybackGaps({ format: 'wav', channels: 64, sampleRate: 192000 })).toHaveLength(2);
  });
});

describe('the upgrade to one audio kind', () => {
  const music = {
    assetId: 'theme',
    kind: 'music',
    displayName: 'Theme',
    currentVersion: 1,
    versions: [{ version: 1, sourceDigest: 'b'.repeat(64), sourceByteLength: 12939, sourcePath: 'assets/Theme.ogg', importRecipe: { profile: 'music', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } }, metrics: { format: 'ogg-vorbis', channels: 2, sampleRate: 44100, durationMs: 3000 }, importedAt: '2026-09-30T00:00:00Z', publishedRevision: 1 }],
    labels: ['music'],
  };
  const shortSound = {
    assetId: 'beep',
    kind: 'audio',
    displayName: 'Beep',
    currentVersion: 1,
    versions: [{ version: 1, sourceDigest: 'c'.repeat(64), sourceByteLength: 9644, importRecipe: { profile: 'pcm-wav', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } }, metrics: { container: 'riff-wave', encoding: 'pcm-s16le', channels: 1, sampleRate: 48000, bitsPerSample: 16, frames: 4800, durationMs: 100, pcmBytes: 9600, dataChunkBytes: 9600, riffChunkBytes: 9636 }, importedAt: '2026-09-30T00:00:00Z', publishedRevision: 1 }],
  };

  it('turns a music record into audio, id, file, labels and facts kept', () => {
    const u = upgradeAudioRecord(music)!;
    expect(u).toMatchObject({ assetId: 'theme', kind: 'audio', labels: ['music'], versions: [{ sourcePath: 'assets/Theme.ogg', importRecipe: { profile: 'audio' }, metrics: { format: 'ogg-vorbis', channels: 2, sampleRate: 44100, durationMs: 3000 } }] });
    expect(valid(u)).toBe(true);
  });

  it("keeps the short-sound profile's header facts and drops its PCM arithmetic", () => {
    const u = upgradeAudioRecord(shortSound)!;
    expect(u['versions']).toMatchObject([{ importRecipe: RECIPE, metrics: { format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 100 } }]);
    expect(Object.keys((u['versions'] as { metrics: object }[])[0]!.metrics)).toEqual(['format', 'channels', 'sampleRate', 'bitsPerSample', 'durationMs']);
    expect(valid(u)).toBe(true);
  });

  it('leaves an upgraded record and every other kind alone, and names what it changed', () => {
    expect(upgradeAudioRecord(upgradeAudioRecord(music))).toBeNull();
    expect(upgradeAudioRecord({ assetId: 'm', kind: 'model', versions: [] })).toBeNull();
    const doc = { assets: [music, shortSound, { assetId: 'm', kind: 'model', versions: [] }], prefabs: [] };
    const r = upgradeAudioAssets(doc);
    expect(r.upgraded).toEqual(['theme', 'beep']);
    expect((r.content as { assets: { kind: string }[] }).assets.map((a) => a.kind)).toEqual(['audio', 'audio', 'model']);
    expect(upgradeAudioAssets(r.content)).toEqual({ content: r.content, upgraded: [] });
  });
});
