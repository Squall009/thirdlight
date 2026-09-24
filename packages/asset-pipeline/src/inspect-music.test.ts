/**
 * Phase 9.10: music import — real Ogg Vorbis, Ogg Opus and MP3 files made by
 * Blender's audaspace (fixtures/music/make-music.py) and a synthetic stereo
 * WAV give their format, channels, rate and duration; other bytes are refused.
 */
import { describe, expect, it } from 'vitest';

import { inspectMusic, MUSIC_TOOLCHAIN } from './inspect-music';
import { base64ToBytes } from './test-fixtures';

const RAW = import.meta.glob('../../../fixtures/music/bytes.base64.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const files = JSON.parse(Object.values(RAW)[0]!) as Record<string, string>;
const inspect = (bytes: Uint8Array) => inspectMusic(bytes, { profile: 'music', recipeVersion: 1, toolchain: MUSIC_TOOLCHAIN, displayName: 'chord' });

function wav(channels: number, rate: number, seconds: number, bits = 16): Uint8Array {
  const data = Math.round(rate * seconds) * channels * (bits / 8);
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * (bits / 8), true);
  v.setUint16(32, channels * (bits / 8), true);
  v.setUint16(34, bits, true);
  put(36, 'data');
  v.setUint32(40, data, true);
  return b;
}

describe('inspectMusic', () => {
  it('reads Ogg Vorbis, Ogg Opus and MP3 headers', () => {
    const vorbis = inspect(base64ToBytes(files['chord.ogg']!));
    expect(vorbis.status).toBe('ok');
    expect(vorbis.metrics).toMatchObject({ format: 'ogg-vorbis', channels: 2, sampleRate: 44100 });
    expect(Math.abs(vorbis.metrics!.durationMs - 3000)).toBeLessThan(30);
    const opus = inspect(base64ToBytes(files['chord-opus.ogg']!));
    expect(opus.metrics).toMatchObject({ format: 'ogg-opus', channels: 2, sampleRate: 48000 });
    expect(Math.abs(opus.metrics!.durationMs - 1000)).toBeLessThan(30);
    const mp3 = inspect(base64ToBytes(files['chord.mp3']!));
    expect(mp3.metrics).toMatchObject({ format: 'mp3', channels: 1, sampleRate: 44100 });
    expect(Math.abs(mp3.metrics!.durationMs - 1000)).toBeLessThan(80); // whole frames plus encoder padding
    expect(mp3.kind).toBe('music');
  });

  it('reads a stereo 44.1 kHz WAV and refuses 8-bit, surround, too long and unknown bytes', () => {
    expect(inspect(wav(2, 44100, 2)).metrics).toEqual({ format: 'wav', channels: 2, sampleRate: 44100, durationMs: 2000 });
    expect(inspect(wav(1, 22050, 1, 8)).diagnostics[0]!.code).toBe('audio_bit_depth_unsupported');
    expect(inspect(wav(6, 8000, 0.1)).diagnostics[0]!.code).toBe('audio_channel_unsupported');
    expect(inspect(wav(1, 8000, 601)).diagnostics[0]!.code).toBe('asset_limits_exceeded');
    const junk = inspect(new TextEncoder().encode('not music at all'));
    expect(junk.status).toBe('rejected');
    expect(junk.diagnostics[0]!.code).toBe('audio_container_invalid');
    const truncated = inspect(base64ToBytes(files['chord.ogg']!).subarray(0, 20));
    expect(truncated.status).toBe('rejected');
  });
});
