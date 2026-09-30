/**
 * Audio import: any Ogg Vorbis, Ogg Opus, MP3, WAV (integer or float PCM) or
 * FLAC file, at any channel count, sample rate, bit depth and length — a
 * footstep, a voice line or an hour of ambience are the same kind of asset.
 *
 * Like the other inspectors: bytes in, a bounded non-authoritative proposal
 * out, no decoding (the browser decodes when the game plays). The container
 * headers decide the format (never the file name), the channel count, the
 * sample rate, the bit depth and the duration: Ogg from the identification
 * header and the last page's granule position, MP3 by walking the frame
 * headers (after an ID3v2 tag), WAV from its `fmt `/`data` chunks, FLAC from
 * its STREAMINFO block. A file no browser plays (a WAV of ADPCM or µ-law, an
 * MPEG layer other than III) is refused; one only some browsers play is
 * imported, and the backend reports the gap (`audioPlaybackGaps`).
 */
import { AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, MAX_SOURCE_BYTES } from '@thirdlight/project-model/limits';
import type { AudioFormat, AudioMetrics, AudioRecipe } from '@thirdlight/project-model';
import { resolveImportJob } from './inspect';
import { M2_GLTF_MAX_DIAGNOSTICS } from './limits';
import { sha256Hex } from './sha256';
import type { ImportDiagnostic, ImportJobPort } from './types';

export type { AudioFormat, AudioMetrics, AudioRecipe };

/** The `audio` recipe's toolchain (this inspector at its pin). */
export const AUDIO_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({ [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION });

export interface AudioImportOptions {
  readonly profile: 'audio';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly job?: ImportJobPort;
}

export interface AudioImportProposal {
  readonly proposalId: string;
  readonly stageId: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly status: 'ok' | 'rejected';
  readonly kind?: 'audio';
  readonly importRecipe: AudioRecipe;
  readonly metrics?: AudioMetrics;
  readonly suggestedDisplayName: string;
  readonly inspection: { readonly format: AudioFormat | null; readonly durationMs: number };
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly diagnosticCount: number;
  readonly expiresAt: string;
}

function diag(code: ImportDiagnostic['code'], message: string, found?: unknown, expected?: string): ImportDiagnostic {
  return { code, path: '', message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) };
}

const ascii = (b: Uint8Array, at: number, n: number): string => (at >= 0 && at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');

type Parsed = AudioMetrics | ImportDiagnostic;

const msOf = (frames: number, rate: number): number => Math.round((frames / rate) * 1000);

/** Ogg: the first page's identification header and the last page's granule position. */
function parseOgg(b: Uint8Array, view: DataView): Parsed {
  if (b.length < 28) return diag('audio_container_invalid', 'the Ogg file is truncated');
  const segments = b[26]!;
  const body = 27 + segments;
  if (body + 19 > b.length) return diag('audio_container_invalid', 'the first Ogg page is truncated');
  let format: AudioFormat;
  let channels: number;
  let sampleRate: number;
  let granuleRate: number;
  let preSkip = 0;
  if (b[body] === 1 && ascii(b, body + 1, 6) === 'vorbis') {
    format = 'ogg-vorbis';
    channels = b[body + 11]!;
    sampleRate = view.getUint32(body + 12, true);
    granuleRate = sampleRate;
  } else if (ascii(b, body, 8) === 'OpusHead') {
    format = 'ogg-opus';
    channels = b[body + 9]!;
    preSkip = view.getUint16(body + 10, true);
    // Opus always decodes at 48 kHz and counts its granules in 48 kHz samples
    // (the header's input rate is only what the source had before encoding).
    sampleRate = 48_000;
    granuleRate = 48_000;
  } else {
    return diag('audio_format_unsupported', 'the Ogg stream is neither Vorbis nor Opus', undefined, 'Vorbis or Opus');
  }
  if (sampleRate === 0) return diag('audio_container_invalid', 'the Ogg identification header states no sample rate');
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
  return { format, channels, sampleRate, durationMs: msOf(granule - preSkip, granuleRate) };
}

const MP3_BITRATES: Record<'v1' | 'v2', readonly number[]> = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The byte after an ID3v2 tag at `at` (or `at` when there is none). */
function skipId3(b: Uint8Array, at: number): number {
  if (ascii(b, at, 3) !== 'ID3' || at + 10 > b.length) return at;
  const size = ((b[at + 6]! & 0x7f) << 21) | ((b[at + 7]! & 0x7f) << 14) | ((b[at + 8]! & 0x7f) << 7) | (b[at + 9]! & 0x7f);
  return at + 10 + size + ((b[at + 5]! & 0x10) !== 0 ? 10 : 0);
}

/** MP3: walk MPEG layer III frame headers to the end. */
function parseMp3(b: Uint8Array, start: number): Parsed {
  let at = start;
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
      channels = b[at + 3]! >> 6 === 3 ? 1 : 2;
    } else if (rate !== sampleRate) {
      return diag('audio_container_invalid', 'the MP3 changes its sample rate between frames');
    }
    samples += version === 3 ? 1152 : 576;
    frames += 1;
    at += length;
  }
  if (frames === 0) return diag('audio_empty', 'the MP3 has no frames');
  return { format: 'mp3', channels, sampleRate, durationMs: msOf(samples, sampleRate) };
}

const WAV_PCM = 1;
const WAV_FLOAT = 3;
const WAV_EXTENSIBLE = 0xfffe;

/** WAV: integer PCM (any bit depth) or IEEE float, any channel count and rate. */
function parseWav(b: Uint8Array, view: DataView): Parsed {
  let at = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      if (size < 16 || at + 24 > b.length) return diag('audio_chunk_invalid', 'the fmt chunk is truncated');
      let tag = view.getUint16(at + 8, true);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format GUID's first two bytes.
      if (tag === WAV_EXTENSIBLE && size >= 40 && at + 34 <= b.length) tag = view.getUint16(at + 32, true);
      fmt = { tag, channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (id === 'data') {
      if (fmt === null) return diag('audio_chunk_invalid', 'the data chunk comes before the fmt chunk');
      // MDN: every browser plays linear PCM in WAV, none ADPCM, µ-law or MP3-in-WAV.
      if (fmt.tag !== WAV_PCM && fmt.tag !== WAV_FLOAT) return diag('audio_format_unsupported', 'the WAV is not linear PCM or float (no browser plays ADPCM, µ-law, A-law or MP3 in WAV)', fmt.tag, 'PCM (1) or IEEE float (3)');
      const float = fmt.tag === WAV_FLOAT;
      if (float ? fmt.bits !== 32 && fmt.bits !== 64 : fmt.bits < 8 || fmt.bits > 32 || fmt.bits % 8 !== 0) {
        return diag('audio_bit_depth_unsupported', `a ${float ? 'float' : 'PCM'} WAV of ${fmt.bits} bits per sample`, fmt.bits, float ? '32 or 64' : '8, 16, 24 or 32');
      }
      if (fmt.channels < 1) return diag('audio_channel_unsupported', 'the WAV has no channels', fmt.channels, 'at least 1');
      if (fmt.rate < 1) return diag('audio_sample_rate_unsupported', 'the WAV states no sample rate', fmt.rate, 'at least 1 Hz');
      // The frame size from the sample format (a header's block align may disagree; decoders use the format).
      const align = (fmt.bits / 8) * fmt.channels;
      // A streamed WAV may state 0 or 0xFFFFFFFF: the data then runs to the end of the file.
      const available = b.length - at - 8;
      const bytes = size === 0 || size > available ? available : size;
      const frames = Math.floor(bytes / align);
      if (frames === 0) return diag('audio_empty', 'the WAV has no samples');
      return { format: 'wav', channels: fmt.channels, sampleRate: fmt.rate, bitsPerSample: fmt.bits, ...(float ? { float: true as const } : {}), durationMs: Math.max(1, msOf(frames, fmt.rate)) };
    }
    at += 8 + size + (size & 1);
  }
  return diag('audio_chunk_invalid', 'the WAV has no data chunk');
}

/** FLAC: the STREAMINFO block, which states the rate, channels, bit depth and total samples. */
function parseFlac(b: Uint8Array, at: number): Parsed {
  const info = at + 4;
  if (info + 4 + 34 > b.length) return diag('audio_container_invalid', 'the FLAC is truncated');
  if ((b[info]! & 0x7f) !== 0) return diag('audio_container_invalid', 'the FLAC does not begin with its STREAMINFO block');
  const s = info + 4;
  // Bits 80..: sample rate (20), channels - 1 (3), bits per sample - 1 (5), total samples (36).
  const rate = (b[s + 10]! << 12) | (b[s + 11]! << 4) | (b[s + 12]! >> 4);
  const channels = ((b[s + 12]! >> 1) & 0x7) + 1;
  const bits = (((b[s + 12]! & 1) << 4) | (b[s + 13]! >> 4)) + 1;
  const total = (b[s + 13]! & 0x0f) * 2 ** 32 + ((b[s + 14]! << 24) >>> 0) + (b[s + 15]! << 16) + (b[s + 16]! << 8) + b[s + 17]!;
  if (rate === 0) return diag('audio_sample_rate_unsupported', 'the FLAC states no sample rate', rate, 'at least 1 Hz');
  if (total === 0) return diag('audio_empty', 'the FLAC does not state its length (an unknown total sample count)');
  return { format: 'flac', channels, sampleRate: rate, bitsPerSample: bits, durationMs: Math.max(1, msOf(total, rate)) };
}

function inspectStages(bytes: Uint8Array): AudioMetrics | ImportDiagnostic[] {
  if (bytes.length > MAX_SOURCE_BYTES) {
    return [diag('audio_source_bytes_exceeded', 'the audio file is too large', bytes.length, `<= ${MAX_SOURCE_BYTES} bytes`)];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let parsed: Parsed;
  const afterId3 = skipId3(bytes, 0);
  if (ascii(bytes, 0, 4) === 'OggS') parsed = parseOgg(bytes, view);
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') parsed = parseWav(bytes, view);
  else if (ascii(bytes, afterId3, 4) === 'fLaC') parsed = parseFlac(bytes, afterId3);
  else if (afterId3 > 0 || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) parsed = parseMp3(bytes, afterId3);
  else return [diag('audio_container_invalid', 'not an Ogg (Vorbis/Opus), MP3, WAV or FLAC file', undefined, 'Ogg, MP3, WAV or FLAC')];
  if ('code' in parsed) return [parsed];
  if (parsed.channels < 1) return [diag('audio_channel_unsupported', 'the file has no channels', parsed.channels, 'at least 1')];
  if (!(parsed.durationMs >= 1)) return [diag('audio_empty', 'the audio has no duration')];
  return parsed;
}

/** Bounded audio inspection; malformed bytes give a `rejected` proposal, never an exception. */
export function inspectAudio(bytes: Uint8Array, options: AudioImportOptions): AudioImportProposal {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('inspectAudio: bytes must be a Uint8Array');
  if (options.profile !== 'audio' || options.recipeVersion !== 1) throw new TypeError("inspectAudio: expected profile 'audio', recipeVersion 1");
  const t = options.toolchain;
  if (typeof t !== 'object' || t === null || Object.keys(t).length !== 1 || t[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
    throw new TypeError(`inspectAudio: the toolchain must be exactly { "${AUDIO_PIPELINE_NAME}": "${AUDIO_PIPELINE_VERSION}" }`);
  }
  const recipe: AudioRecipe = { profile: 'audio', recipeVersion: 1, toolchain: { ...AUDIO_TOOLCHAIN } };
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job, options, sourceDigest);
  let result: AudioMetrics | ImportDiagnostic[];
  const startedAt = job.now();
  try {
    result = inspectStages(bytes);
  } catch {
    result = [diag('audio_container_invalid', 'the audio file is malformed')];
  }
  // A cancelled or over-budget job reports the accepted timeout rejection (an MP3's frame walk is the long stage).
  if (job.isCancelled()) result = [diag('asset_timeout', 'inspection cancelled by the caller')];
  else if (job.now() - startedAt > job.timeoutMs) result = [diag('asset_timeout', `inspection exceeded the ${job.timeoutMs} ms job limit`)];
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
  return Object.freeze({ ...base, status: 'ok' as const, kind: 'audio' as const, metrics: result, inspection: { format: result.format, durationMs: result.durationMs }, diagnostics: [], diagnosticCount: 0 });
}
