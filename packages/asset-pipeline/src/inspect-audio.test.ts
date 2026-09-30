/**
 * Audio import reads each format's own headers. Real files made by Blender's
 * audaspace (fixtures/music/make-music.py: Ogg Vorbis stereo and 5.1, Ogg
 * Opus, MP3, FLAC 24-bit, a 24-bit stereo 44.1 kHz WAV) and headers built
 * here byte by byte (float and extensible WAV, a many-channel WAV, a FLAC
 * STREAMINFO, an MP3 frame run, an Ogg page) give their format, channels,
 * rate, bit depth and duration, at any length; bytes no browser plays are
 * refused with a reason.
 */
import { describe, expect, it } from 'vitest';

import { AUDIO_TOOLCHAIN, inspectAudio } from './inspect-audio';
import { base64ToBytes } from './test-fixtures';

const RAW = import.meta.glob('../../../fixtures/music/bytes.base64.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const files = JSON.parse(Object.values(RAW)[0]!) as Record<string, string>;
const inspect = (bytes: Uint8Array) => inspectAudio(bytes, { profile: 'audio', recipeVersion: 1, toolchain: AUDIO_TOOLCHAIN, displayName: 'clip' });
const put = (b: Uint8Array, at: number, s: string): void => [...s].forEach((c, i) => void (b[at + i] = c.charCodeAt(0)));

/** A WAV header and `frames` of silence: `tag` 1 PCM, 3 float, 0xfffe extensible (with `sub` as its format). */
function wav(o: { channels: number; rate: number; bits: number; frames: number; tag?: number; sub?: number; dataSize?: number }): Uint8Array {
  const ext = o.tag === 0xfffe;
  const fmtSize = ext ? 40 : 16;
  const data = o.frames * o.channels * (o.bits / 8);
  const b = new Uint8Array(20 + fmtSize + 8 + data);
  const v = new DataView(b.buffer);
  put(b, 0, 'RIFF');
  v.setUint32(4, b.length - 8, true);
  put(b, 8, 'WAVE');
  put(b, 12, 'fmt ');
  v.setUint32(16, fmtSize, true);
  v.setUint16(20, o.tag ?? 1, true);
  v.setUint16(22, o.channels, true);
  v.setUint32(24, o.rate, true);
  v.setUint32(28, o.rate * o.channels * (o.bits / 8), true);
  v.setUint16(32, o.channels * (o.bits / 8), true);
  v.setUint16(34, o.bits, true);
  if (ext) {
    v.setUint16(36, 22, true);
    v.setUint16(38, o.bits, true);
    v.setUint16(44, o.sub ?? 1, true);
  }
  put(b, 20 + fmtSize, 'data');
  v.setUint32(24 + fmtSize, o.dataSize ?? data, true);
  return b;
}

/** A FLAC stream marker and STREAMINFO block (no audio frames: the header states the length). */
function flac(rate: number, channels: number, bits: number, total: number): Uint8Array {
  const b = new Uint8Array(4 + 4 + 34);
  put(b, 0, 'fLaC');
  b[4] = 0x80; // last metadata block, type 0 (STREAMINFO)
  b[7] = 34;
  const s = 8;
  b[s + 10] = (rate >> 12) & 0xff;
  b[s + 11] = (rate >> 4) & 0xff;
  b[s + 12] = ((rate & 0x0f) << 4) | ((channels - 1) << 1) | (((bits - 1) >> 4) & 1);
  b[s + 13] = (((bits - 1) & 0x0f) << 4) | Math.floor(total / 2 ** 32);
  const low = total % 2 ** 32;
  b[s + 14] = (low >>> 24) & 0xff;
  b[s + 15] = (low >>> 16) & 0xff;
  b[s + 16] = (low >>> 8) & 0xff;
  b[s + 17] = low & 0xff;
  return b;
}

/** `n` MPEG-1 layer III frames at 128 kbit/s, 44.1 kHz, joint stereo (417 bytes each, no padding). */
function mp3(n: number): Uint8Array {
  const b = new Uint8Array(n * 417);
  for (let i = 0; i < n; i++) b.set([0xff, 0xfb, 0x90, 0x44], i * 417);
  return b;
}

describe('inspectAudio', () => {
  it('reads real Ogg Vorbis (stereo and 5.1), Ogg Opus, MP3, FLAC and 24-bit WAV files', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['chord.ogg', { format: 'ogg-vorbis', channels: 2, sampleRate: 44100, durationMs: 3000 }],
      ['chord-51.ogg', { format: 'ogg-vorbis', channels: 6, sampleRate: 48000, durationMs: 500 }],
      ['chord-opus.ogg', { format: 'ogg-opus', channels: 2, sampleRate: 48000, durationMs: 1000 }],
      ['chord.flac', { format: 'flac', channels: 2, sampleRate: 44100, bitsPerSample: 24, durationMs: 1000 }],
      ['chord-24.wav', { format: 'wav', channels: 2, sampleRate: 44100, bitsPerSample: 24 }],
    ];
    for (const [name, want] of cases) {
      const p = inspect(base64ToBytes(files[name]!));
      expect(p.status, name).toBe('ok');
      expect(p.kind).toBe('audio');
      expect(p.importRecipe).toEqual({ profile: 'audio', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } });
      expect(p.metrics, name).toMatchObject(want);
      expect(p.metrics!.bitsPerSample === undefined, name).toBe(!['wav', 'flac'].includes(want['format'] as string));
    }
    // An MP3 has no bit depth; its length is its frames' samples (Blender's encoder pads the last frame).
    const m = inspect(base64ToBytes(files['chord.mp3']!));
    expect(m.metrics).toMatchObject({ format: 'mp3', channels: 1, sampleRate: 44100 });
    expect(Math.abs(m.metrics!.durationMs - 1000)).toBeLessThan(100);
  });

  it('takes a WAV at any channel count, rate and bit depth, integer or float, plain or extensible', () => {
    expect(inspect(wav({ channels: 2, rate: 44100, bits: 16, frames: 44100 })).metrics).toEqual({ format: 'wav', channels: 2, sampleRate: 44100, bitsPerSample: 16, durationMs: 1000 });
    expect(inspect(wav({ channels: 1, rate: 8000, bits: 8, frames: 4000 })).metrics).toEqual({ format: 'wav', channels: 1, sampleRate: 8000, bitsPerSample: 8, durationMs: 500 });
    expect(inspect(wav({ channels: 2, rate: 96000, bits: 32, frames: 9600, tag: 3 })).metrics).toEqual({ format: 'wav', channels: 2, sampleRate: 96000, bitsPerSample: 32, float: true, durationMs: 100 });
    expect(inspect(wav({ channels: 8, rate: 48000, bits: 24, frames: 480, tag: 0xfffe, sub: 1 })).metrics).toMatchObject({ channels: 8, bitsPerSample: 24, durationMs: 10 });
    expect(inspect(wav({ channels: 2, rate: 48000, bits: 64, frames: 48, tag: 0xfffe, sub: 3 })).metrics).toMatchObject({ float: true, bitsPerSample: 64, durationMs: 1 });
    // A streamed WAV states no data size: the data runs to the end of the file.
    expect(inspect(wav({ channels: 1, rate: 48000, bits: 16, frames: 4800, dataSize: 0xffffffff })).metrics?.durationMs).toBe(100);
  });

  it('has no duration cap: an hour of FLAC and three hours of MP3 frames are one audio asset each', () => {
    expect(inspect(flac(48000, 2, 16, 48000 * 3600)).metrics).toEqual({ format: 'flac', channels: 2, sampleRate: 48000, bitsPerSample: 16, durationMs: 3_600_000 });
    expect(inspect(flac(192000, 8, 24, 2 ** 33)).metrics).toMatchObject({ channels: 8, sampleRate: 192000, bitsPerSample: 24, durationMs: Math.round((2 ** 33 / 192000) * 1000) });
    // 38.28 frames per second at 44.1 kHz: 10 minutes of frames (a 10 MB file).
    const long = inspect(mp3(22968));
    expect(long.metrics).toMatchObject({ format: 'mp3', channels: 2, sampleRate: 44100 });
    expect(long.metrics!.durationMs).toBe(Math.round(((22968 * 1152) / 44100) * 1000));
  });

  it('reads an ID3v2 tag before an MP3 or a FLAC', () => {
    const tag = new Uint8Array(10 + 20);
    put(tag, 0, 'ID3');
    tag[3] = 4;
    tag[9] = 20;
    const withTag = (body: Uint8Array): Uint8Array => {
      const b = new Uint8Array(tag.length + body.length);
      b.set(tag);
      b.set(body, tag.length);
      return b;
    };
    expect(inspect(withTag(mp3(10))).metrics?.format).toBe('mp3');
    expect(inspect(withTag(flac(44100, 1, 16, 44100))).metrics).toMatchObject({ format: 'flac', durationMs: 1000 });
  });

  it('refuses what no browser plays and what is not audio, saying why', () => {
    const code = (b: Uint8Array): string | undefined => {
      const p = inspect(b);
      expect(p.status).toBe('rejected');
      expect(p.metrics).toBeUndefined();
      return p.diagnostics[0]?.code;
    };
    // ADPCM (2), A-law (6), µ-law (7): MDN lists no browser that plays them in WAV.
    for (const tag of [2, 6, 7]) expect(code(wav({ channels: 1, rate: 8000, bits: 8, frames: 100, tag }))).toBe('audio_format_unsupported');
    expect(code(wav({ channels: 1, rate: 48000, bits: 12, frames: 100 }))).toBe('audio_bit_depth_unsupported');
    expect(code(wav({ channels: 1, rate: 48000, bits: 16, frames: 0 }))).toBe('audio_empty');
    expect(code(flac(44100, 2, 16, 0))).toBe('audio_empty');
    // An MPEG layer II stream is not MP3.
    expect(code(new Uint8Array([0xff, 0xfd, 0x90, 0x44, 0, 0, 0, 0]))).toBe('audio_format_unsupported');
    // An Ogg stream of another codec (Theora video here).
    const ogg = new Uint8Array(80);
    put(ogg, 0, 'OggS');
    ogg[26] = 1;
    ogg[27] = 42;
    put(ogg, 28, '\u0080theora');
    expect(code(ogg)).toBe('audio_format_unsupported');
    expect(code(new TextEncoder().encode('not audio at all'))).toBe('audio_container_invalid');
    expect(code(new Uint8Array(0))).toBe('audio_container_invalid');
  });

  it('is total over hostile bytes and refuses bad options', () => {
    for (let n = 0; n < 64; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      put(b, 0, 'OggS'.slice(0, Math.min(4, n)));
      expect(['ok', 'rejected']).toContain(inspect(b).status);
    }
    expect(() => inspectAudio(new Uint8Array(4), { profile: 'pcm-wav' as 'audio', recipeVersion: 1, toolchain: AUDIO_TOOLCHAIN })).toThrow(TypeError);
    expect(() => inspectAudio(new Uint8Array(4), { profile: 'audio', recipeVersion: 1, toolchain: { 'asset-pipeline': '9.9.9' } })).toThrow(TypeError);
  });
});
