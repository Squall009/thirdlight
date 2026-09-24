/**
 * Music import (phase 9.10): a long sound — Ogg (Vorbis or Opus), MP3 or a
 * PCM WAV (mono or stereo, 8–48 kHz, 16-bit) — for level music, title music
 * and ambience loops.
 *
 * Like the other inspectors: bytes in, a bounded non-authoritative proposal
 * out, no decoding. The container headers decide the format (never the file
 * name), the channel count, the sample rate and the duration: Ogg from the
 * identification header and the last page's granule position, MP3 by walking
 * the frame headers (after an ID3v2 tag), WAV from its `fmt `/`data` chunks.
 */
import { resolveImportJob } from './inspect';
import { AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, M2_GLTF_MAX_DIAGNOSTICS } from './limits';
import { sha256Hex } from './sha256';
import type { ImportDiagnostic, ImportJobPort } from './types';

/** Largest music file accepted (bytes). */
export const MUSIC_SOURCE_BYTES_MAX = 16_777_216;
/** Longest music accepted (milliseconds). */
export const MUSIC_DURATION_MS_MAX = 600_000;

export type MusicFormat = 'ogg-vorbis' | 'ogg-opus' | 'mp3' | 'wav';

/** The `music` recipe (the toolchain names this inspector). */
export interface MusicRecipe {
  readonly profile: 'music';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
}

/** Facts about one music file (all re-derivable from the bytes). */
export interface MusicMetrics {
  readonly format: MusicFormat;
  readonly channels: 1 | 2;
  readonly sampleRate: number;
  readonly durationMs: number;
}

export interface MusicImportOptions {
  readonly profile: 'music';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly job?: ImportJobPort;
}

export interface MusicImportProposal {
  readonly proposalId: string;
  readonly stageId: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly status: 'ok' | 'rejected';
  readonly kind?: 'music';
  readonly importRecipe: MusicRecipe;
  readonly metrics?: MusicMetrics;
  readonly suggestedDisplayName: string;
  readonly inspection: { readonly format: MusicFormat | null; readonly durationMs: number };
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly diagnosticCount: number;
  readonly expiresAt: string;
}

export const MUSIC_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({ [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION });

function diag(code: ImportDiagnostic['code'], message: string, found?: unknown, expected?: string): ImportDiagnostic {
  return { code, path: '', message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) };
}

const ascii = (b: Uint8Array, at: number, n: number): string => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');

type Parsed = { format: MusicFormat; channels: number; sampleRate: number; durationMs: number } | ImportDiagnostic;

/** Ogg: the first page's identification header and the last page's granule position. */
function parseOgg(b: Uint8Array, view: DataView): Parsed {
  if (b.length < 28) return diag('audio_container_invalid', 'the Ogg file is truncated');
  const segments = b[26]!;
  const body = 27 + segments;
  if (body + 19 > b.length) return diag('audio_container_invalid', 'the first Ogg page is truncated');
  let format: MusicFormat;
  let channels: number;
  let sampleRate: number;
  let preSkip = 0;
  if (b[body] === 1 && ascii(b, body + 1, 6) === 'vorbis') {
    format = 'ogg-vorbis';
    channels = b[body + 11]!;
    sampleRate = view.getUint32(body + 12, true);
  } else if (ascii(b, body, 8) === 'OpusHead') {
    format = 'ogg-opus';
    channels = b[body + 9]!;
    preSkip = view.getUint16(body + 10, true);
    sampleRate = 48_000; // Opus granules always count 48 kHz samples
  } else {
    return diag('audio_format_unsupported', 'the Ogg stream is neither Vorbis nor Opus', undefined, 'Vorbis or Opus');
  }
  // The last page: scan back for its capture pattern.
  let last = -1;
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53 && b[i + 4] === 0) {
      last = i;
      break;
    }
  }
  if (last < 0) return diag('audio_container_invalid', 'no final Ogg page');
  const granule = Number(view.getBigInt64(last + 6, true));
  if (!(granule > preSkip)) return diag('audio_empty', 'the Ogg stream has no samples');
  return { format, channels, sampleRate, durationMs: Math.round(((granule - preSkip) / sampleRate) * 1000) };
}

const MP3_BITRATES: Record<'v1' | 'v2', readonly number[]> = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MP3: skip an ID3v2 tag, then walk MPEG layer III frame headers to the end. */
function parseMp3(b: Uint8Array): Parsed {
  let at = 0;
  if (ascii(b, 0, 3) === 'ID3' && b.length >= 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    at = 10 + size + ((b[5]! & 0x10) !== 0 ? 10 : 0);
  }
  let frames = 0;
  let samples = 0;
  let sampleRate = 0;
  let channels = 0;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) {
      if (frames > 0 && ascii(b, at, 3) === 'TAG') break; // ID3v1 at the end
      if (frames === 0) return diag('audio_container_invalid', 'no MPEG frame at the start of the file');
      break; // trailing junk after the last frame
    }
    const version = (b[at + 1]! >> 3) & 3; // 3: MPEG1, 2: MPEG2, 0: MPEG2.5
    const layer = (b[at + 1]! >> 1) & 3; // 1: layer III
    const bitrateIndex = b[at + 2]! >> 4;
    const rateIndex = (b[at + 2]! >> 2) & 3;
    const padding = (b[at + 2]! >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      if (frames === 0) return diag('audio_format_unsupported', 'not an MPEG layer III (MP3) stream', undefined, 'MP3');
      break;
    }
    const rate = MP3_RATES[version]![rateIndex]!;
    const kbps = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex]!;
    const length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + padding;
    if (frames === 0) {
      sampleRate = rate;
      channels = (b[at + 3]! >> 6) === 3 ? 1 : 2;
    } else if (rate !== sampleRate) {
      return diag('audio_container_invalid', 'the MP3 changes its sample rate between frames');
    }
    samples += version === 3 ? 1152 : 576;
    frames += 1;
    at += length;
  }
  if (frames === 0) return diag('audio_empty', 'the MP3 has no frames');
  return { format: 'mp3', channels, sampleRate, durationMs: Math.round((samples / sampleRate) * 1000) };
}

/** WAV: PCM 16-bit, mono or stereo. */
function parseWav(b: Uint8Array, view: DataView): Parsed {
  let at = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 24 <= b.length) {
      fmt = { format: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (id === 'data') {
      if (fmt === null) return diag('audio_chunk_invalid', 'the data chunk comes before the fmt chunk');
      if (fmt.format !== 1) return diag('audio_format_unsupported', 'only PCM WAV is accepted', fmt.format, 'PCM (1)');
      if (fmt.bits !== 16) return diag('audio_bit_depth_unsupported', 'only 16-bit WAV is accepted', fmt.bits, '16');
      const bytes = Math.min(size, b.length - at - 8);
      const frames = Math.floor(bytes / (2 * Math.max(1, fmt.channels)));
      if (frames === 0) return diag('audio_empty', 'the WAV has no samples');
      return { format: 'wav', channels: fmt.channels, sampleRate: fmt.rate, durationMs: Math.round((frames / fmt.rate) * 1000) };
    }
    at += 8 + size + (size & 1);
  }
  return diag('audio_chunk_invalid', 'the WAV has no data chunk');
}

function inspectStages(bytes: Uint8Array): MusicMetrics | ImportDiagnostic[] {
  if (bytes.length > MUSIC_SOURCE_BYTES_MAX) {
    return [diag('audio_source_bytes_exceeded', 'the music file is too large', bytes.length, `<= ${MUSIC_SOURCE_BYTES_MAX} bytes`)];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let parsed: Parsed;
  if (ascii(bytes, 0, 4) === 'OggS') parsed = parseOgg(bytes, view);
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') parsed = parseWav(bytes, view);
  else if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) parsed = parseMp3(bytes);
  else return [diag('audio_container_invalid', 'not an Ogg (Vorbis/Opus), MP3 or WAV file', undefined, 'Ogg, MP3 or WAV')];
  if ('code' in parsed) return [parsed];
  if (parsed.channels !== 1 && parsed.channels !== 2) return [diag('audio_channel_unsupported', 'music is mono or stereo', parsed.channels, '1 or 2')];
  if (!(parsed.sampleRate >= 8000 && parsed.sampleRate <= 48000)) return [diag('audio_sample_rate_unsupported', 'the sample rate is outside 8–48 kHz', parsed.sampleRate, '8000..48000')];
  if (!(parsed.durationMs >= 1)) return [diag('audio_empty', 'the music has no duration')];
  if (parsed.durationMs > MUSIC_DURATION_MS_MAX) return [diag('asset_limits_exceeded', 'the music is longer than 10 minutes', parsed.durationMs, `<= ${MUSIC_DURATION_MS_MAX} ms`)];
  return { format: parsed.format, channels: parsed.channels as 1 | 2, sampleRate: parsed.sampleRate, durationMs: parsed.durationMs };
}

/** Bounded music inspection; malformed bytes give a `rejected` proposal, never an exception. */
export function inspectMusic(bytes: Uint8Array, options: MusicImportOptions): MusicImportProposal {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('inspectMusic: bytes must be a Uint8Array');
  if (options.profile !== 'music' || options.recipeVersion !== 1) throw new TypeError("inspectMusic: expected profile 'music', recipeVersion 1");
  const recipe: MusicRecipe = { profile: 'music', recipeVersion: 1, toolchain: { ...MUSIC_TOOLCHAIN } };
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job, options, sourceDigest);
  let result: MusicMetrics | ImportDiagnostic[];
  try {
    result = inspectStages(bytes);
  } catch {
    result = [diag('audio_container_invalid', 'the music file is malformed')];
  }
  const base = {
    proposalId: job.proposalId,
    stageId: job.stageId,
    sourceDigest,
    sourceByteLength: bytes.length,
    importRecipe: recipe,
    suggestedDisplayName: job.suggestedDisplayName,
    expiresAt: job.expiresAt,
  };
  if (Array.isArray(result)) {
    return Object.freeze({ ...base, status: 'rejected' as const, inspection: { format: null, durationMs: 0 }, diagnostics: result.slice(0, M2_GLTF_MAX_DIAGNOSTICS), diagnosticCount: result.length });
  }
  return Object.freeze({ ...base, status: 'ok' as const, kind: 'music' as const, metrics: result, inspection: { format: result.format, durationMs: result.durationMs }, diagnostics: [], diagnosticCount: 0 });
}
