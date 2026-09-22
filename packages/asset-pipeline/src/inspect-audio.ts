/**
 * `inspectAudio` — the bounded PCM-WAV inspector (presentation.md §41.4,
 * project-model.md §18.5/§18.6 for the `pcm-wav` recipe and `PcmWavMetrics`
 * member).
 *
 * A pure leaf: bytes in, a non-authoritative proposal out. No I/O, no Node
 * built-in, no decoder/codec library, no `three`, no network, no cache write,
 * no asset-ID decision, no source execution and no state mutation
 * (`dependencies.md` §4.1). The 12 stages of §41.4.4 run in order and stop at
 * the first failing stage; every number in `metrics` is re-derived from the
 * exact header bytes, never read from a caller-supplied declaration.
 *
 * Rejection is never driven by a file extension, a caller MIME type or a
 * declared `kind`: the bytes alone decide (§41.4.4). `kind`/profile mismatch is
 * a publication error (`asset_kind_mismatch`), not an inspection outcome.
 */

import { resolveImportJob, type ResolvedJob } from './inspect';
import {
  AUDIO_PCM_WAV_BITS_PER_SAMPLE,
  AUDIO_PCM_WAV_BLOCK_ALIGN,
  AUDIO_PCM_WAV_BYTE_RATE,
  AUDIO_PCM_WAV_CHANNELS,
  AUDIO_PCM_WAV_HEADER_BYTES,
  AUDIO_PCM_WAV_LIMITS,
  AUDIO_PCM_WAV_MAX_PCM_BYTES,
  AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES,
  AUDIO_PCM_WAV_SAMPLE_RATE,
  AUDIO_PIPELINE_NAME,
  AUDIO_PIPELINE_VERSION,
  M2_GLTF_MAX_DIAGNOSTICS,
} from './limits';
import { sha256Hex } from './sha256';
import type {
  AudioImportInspection,
  AudioImportLimits,
  AudioImportOptions,
  AudioImportProposal,
  ImportDiagnostic,
  ImportDiagnosticCode,
  ImportJobPort,
  ImportLimitName,
  PcmWavMetrics,
  PcmWavRecipe,
} from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(value) as T;
}

/** One container-level audio diagnostic (`path` is always `""` for a WAV). */
function audioDiag(
  code: ImportDiagnosticCode,
  message: string,
  extra: { found?: unknown; expected?: string; limit?: ImportLimitName } = {},
): ImportDiagnostic {
  const out: {
    code: ImportDiagnosticCode;
    path: string;
    message: string;
    found?: unknown;
    expected?: string;
    limit?: ImportLimitName;
  } = {
    code,
    path: '',
    message,
  };
  if (extra.found !== undefined) out.found = extra.found;
  if (extra.expected !== undefined) out.expected = extra.expected;
  if (extra.limit !== undefined) out.limit = extra.limit;
  return out;
}

const ASCII_RIFF = 'RIFF';
const ASCII_WAVE = 'WAVE';
const ASCII_FMT = 'fmt ';
const ASCII_DATA = 'data';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) | ((bytes[offset + 1] as number) << 8)) >>> 0;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
    0
  );
}

/**
 * Validate the caller's `pcm-wav` options. A wrong profile/recipe version or a
 * toolchain that is not exactly the pinned `asset-pipeline` entry is a caller
 * programming error (`TypeError`), exactly as for `inspectGlb`; the bytes are
 * never consulted for it.
 */
function resolveAudioOptions(options: AudioImportOptions): void {
  if (!isPlainObject(options)) throw new TypeError('inspectAudio: options must be an object');
  if (options.profile !== 'pcm-wav') {
    throw new TypeError("inspectAudio: unsupported profile (expected 'pcm-wav')");
  }
  if (options.recipeVersion !== 1) {
    throw new TypeError('inspectAudio: unsupported recipeVersion (expected 1)');
  }
  const toolchain = options.toolchain;
  if (!isPlainObject(toolchain)) throw new TypeError('inspectAudio: toolchain must be an object');
  const names = Object.keys(toolchain).sort();
  if (names.length !== 1 || names[0] !== AUDIO_PIPELINE_NAME) {
    throw new TypeError(
      `inspectAudio: the pcm-wav toolchain must name exactly the pinned inspector ('${AUDIO_PIPELINE_NAME}')`,
    );
  }
  if (toolchain[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
    throw new TypeError(
      `inspectAudio: toolchain['${AUDIO_PIPELINE_NAME}'] must be the pinned value '${AUDIO_PIPELINE_VERSION}'`,
    );
  }
}

/**
 * The 12 stages of presentation.md §41.4.4, in order. Returns the rejection
 * diagnostics or the accepted `{ metrics, inspection }`. The injected job's
 * cancellation/deadline is the accepted cancellation path (the same
 * `ImportJobPort` contract the GLB inspector and the workspace use): a
 * cancelled or over-budget job reports the accepted `asset_timeout` rejection
 * and inspects nothing further.
 */
function inspectStages(
  bytes: Uint8Array,
  job: ResolvedJob,
): { metrics: PcmWavMetrics; inspection: AudioImportInspection } | ImportDiagnostic[] {
  const length = bytes.length;
  const startedAt = job.now();
  const guard = (): ImportDiagnostic[] | null => {
    if (job.isCancelled()) {
      return [
        audioDiag('asset_timeout', 'inspection cancelled by the caller', {
          expected: 'inspection to finish within the job budget',
        }),
      ];
    }
    if (job.now() - startedAt > job.timeoutMs) {
      return [
        audioDiag('asset_timeout', `inspection exceeded the ${job.timeoutMs} ms job limit`, {
          expected: 'inspection to finish within the job budget',
        }),
      ];
    }
    return null;
  };

  // 1 — size (the hard source-file bound, before any profile cap).
  let gate = guard();
  if (gate !== null) return gate;
  if (length < AUDIO_PCM_WAV_HEADER_BYTES || length > AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES) {
    return [
      audioDiag(
        'audio_source_bytes_exceeded',
        `source must be ${AUDIO_PCM_WAV_HEADER_BYTES}-${AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES} bytes`,
        {
          found: length,
          expected: `${AUDIO_PCM_WAV_HEADER_BYTES} .. ${AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES}`,
        },
      ),
    ];
  }

  // 2 — container: RIFF/WAVE magic and the declared riffSize.
  gate = guard();
  if (gate !== null) return gate;
  if (ascii(bytes, 0, 4) !== ASCII_RIFF) {
    return [
      audioDiag('audio_container_invalid', 'the container magic must be ASCII "RIFF"', {
        found: ascii(bytes, 0, 4),
        expected: '"RIFF"',
      }),
    ];
  }
  if (ascii(bytes, 8, 4) !== ASCII_WAVE) {
    return [
      audioDiag('audio_container_invalid', 'the RIFF form must be ASCII "WAVE"', {
        found: ascii(bytes, 8, 4),
        expected: '"WAVE"',
      }),
    ];
  }
  if (u32(bytes, 4) !== length - 8) {
    return [
      audioDiag('audio_container_invalid', 'riffSize must equal bytes.length - 8', {
        found: u32(bytes, 4),
        expected: String(length - 8),
      }),
    ];
  }

  // 3 — chunk framing: exactly `fmt ` (size 16) then `data`, filling the file.
  gate = guard();
  if (gate !== null) return gate;
  if (ascii(bytes, 12, 4) !== ASCII_FMT) {
    return [
      audioDiag('audio_chunk_invalid', 'the first chunk id must be ASCII "fmt "', {
        found: ascii(bytes, 12, 4),
        expected: '"fmt "',
      }),
    ];
  }
  if (u32(bytes, 16) !== 16) {
    return [
      audioDiag('audio_chunk_invalid', 'the fmt chunk size must be exactly 16 (no cbSize)', {
        found: u32(bytes, 16),
        expected: '16',
      }),
    ];
  }
  if (ascii(bytes, 36, 4) !== ASCII_DATA) {
    return [
      audioDiag('audio_chunk_invalid', 'the second chunk id must be ASCII "data" (two chunks, no trailing chunk)', {
        found: ascii(bytes, 36, 4),
        expected: '"data"',
      }),
    ];
  }
  const declaredDataBytes = u32(bytes, 40);
  if (AUDIO_PCM_WAV_HEADER_BYTES + declaredDataBytes !== length) {
    return [
      audioDiag('audio_chunk_invalid', 'the declared chunk bytes must exactly fill the file (no trailing byte)', {
        found: AUDIO_PCM_WAV_HEADER_BYTES + declaredDataBytes,
        expected: String(length),
      }),
    ];
  }

  // 4 — format tag.
  gate = guard();
  if (gate !== null) return gate;
  if (u16(bytes, 20) !== 1) {
    return [
      audioDiag('audio_format_unsupported', 'only linear PCM (format tag 1) is accepted; compressed/float forms are rejected', {
        found: u16(bytes, 20),
        expected: '1 (linear PCM)',
      }),
    ];
  }

  // 5 — channels.
  gate = guard();
  if (gate !== null) return gate;
  if (u16(bytes, 22) !== AUDIO_PCM_WAV_CHANNELS) {
    return [
      audioDiag('audio_channel_unsupported', 'the pcm-wav profile is mono', {
        found: u16(bytes, 22),
        expected: String(AUDIO_PCM_WAV_CHANNELS),
      }),
    ];
  }

  // 6 — sample rate.
  gate = guard();
  if (gate !== null) return gate;
  if (u32(bytes, 24) !== AUDIO_PCM_WAV_SAMPLE_RATE) {
    return [
      audioDiag('audio_sample_rate_unsupported', `the pcm-wav profile is ${AUDIO_PCM_WAV_SAMPLE_RATE} Hz`, {
        found: u32(bytes, 24),
        expected: String(AUDIO_PCM_WAV_SAMPLE_RATE),
      }),
    ];
  }

  // 7 — bit depth.
  gate = guard();
  if (gate !== null) return gate;
  if (u16(bytes, 34) !== AUDIO_PCM_WAV_BITS_PER_SAMPLE) {
    return [
      audioDiag('audio_bit_depth_unsupported', `the pcm-wav profile is signed ${AUDIO_PCM_WAV_BITS_PER_SAMPLE}-bit`, {
        found: u16(bytes, 34),
        expected: String(AUDIO_PCM_WAV_BITS_PER_SAMPLE),
      }),
    ];
  }

  // 8 — derived header arithmetic.
  gate = guard();
  if (gate !== null) return gate;
  if (u32(bytes, 28) !== AUDIO_PCM_WAV_BYTE_RATE || u16(bytes, 32) !== AUDIO_PCM_WAV_BLOCK_ALIGN) {
    return [
      audioDiag('audio_chunk_invalid', 'byteRate must be 96000 and blockAlign 2 for mono 16-bit at 48000 Hz', {
        found: { byteRate: u32(bytes, 28), blockAlign: u16(bytes, 32) },
        expected: `byteRate ${AUDIO_PCM_WAV_BYTE_RATE}, blockAlign ${AUDIO_PCM_WAV_BLOCK_ALIGN}`,
      }),
    ];
  }

  // 9 — data size agreement and evenness.
  gate = guard();
  if (gate !== null) return gate;
  const dataBytes = length - AUDIO_PCM_WAV_HEADER_BYTES;
  if (declaredDataBytes !== dataBytes || dataBytes % 2 !== 0) {
    return [
      audioDiag(
        'audio_data_size_invalid',
        'the data chunk must hold exactly the remaining bytes, and the byte count must be even',
        {
          found: { declared: declaredDataBytes, actual: dataBytes },
          expected: 'declared === dataBytes, dataBytes even',
        },
      ),
    ];
  }

  // 10 — non-empty.
  gate = guard();
  if (gate !== null) return gate;
  if (dataBytes < 2) {
    return [
      audioDiag('audio_empty', 'a pcm-wav cue must carry at least one frame', {
        found: dataBytes,
        expected: '>= 2 data bytes (1 frame)',
      }),
    ];
  }

  // 11 — the single normative PCM byte cap.
  gate = guard();
  if (gate !== null) return gate;
  if (dataBytes > AUDIO_PCM_WAV_MAX_PCM_BYTES) {
    return [
      audioDiag('asset_limits_exceeded', 'PCM bytes exceed the pcm-wav profile cap', {
        found: dataBytes,
        expected: `<= ${AUDIO_PCM_WAV_MAX_PCM_BYTES}`,
        limit: 'audio_pcm_bytes',
      }),
    ];
  }

  // 12 — accept: exact metrics, the recipe and a bounded summary (no samples).
  gate = guard();
  if (gate !== null) return gate;
  const frames = dataBytes / 2;
  const metrics: PcmWavMetrics = {
    container: 'riff-wave',
    encoding: 'pcm-s16le',
    channels: 1,
    sampleRate: 48_000,
    bitsPerSample: 16,
    frames,
    durationMs: Math.floor(frames / 48),
    pcmBytes: dataBytes,
    dataChunkBytes: dataBytes,
    riffChunkBytes: 36 + dataBytes,
  };
  const inspection: AudioImportInspection = {
    container: 'riff-wave',
    encoding: 'pcm-s16le',
    chunkIds: [ASCII_FMT, ASCII_DATA],
    frames,
    durationMs: metrics.durationMs,
  };
  return { metrics, inspection };
}

/**
 * Bounded PCM-WAV inspection (presentation.md §41.4.4). Deterministic, pure and
 * total over hostile bytes: malformed input yields a `rejected` proposal with
 * the first failing stage's diagnostics, never an exception. Invalid *options*
 * throw `TypeError` (a caller programming error).
 */
export function inspectAudio(bytes: Uint8Array, options: AudioImportOptions): AudioImportProposal {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('inspectAudio: bytes must be a Uint8Array');
  }
  resolveAudioOptions(options);

  const recipe: PcmWavRecipe = {
    profile: 'pcm-wav',
    recipeVersion: 1,
    toolchain: { [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION },
  };
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job as ImportJobPort | undefined, options, sourceDigest);
  const result = inspectStages(bytes, job);

  const limits: AudioImportLimits = deepFreeze({
    profile: 'pcm-wav' as const,
    recipeVersion: 1 as const,
    sourceFileBytes: AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES,
    pcmBytes: AUDIO_PCM_WAV_MAX_PCM_BYTES,
    timeoutMs: job.timeoutMs,
    caps: AUDIO_PCM_WAV_LIMITS,
  });
  const base = {
    proposalId: job.proposalId,
    stageId: job.stageId,
    sourceDigest,
    sourceByteLength: bytes.length,
    importRecipe: recipe,
    suggestedDisplayName: job.suggestedDisplayName,
    limits,
    expiresAt: job.expiresAt,
  };
  if (Array.isArray(result)) {
    return deepFreeze({
      ...base,
      status: 'rejected' as const,
      inspection: {
        container: 'riff-wave' as const,
        encoding: 'pcm-s16le' as const,
        chunkIds: [] as readonly string[],
        frames: 0,
        durationMs: 0,
      },
      diagnostics: result.slice(0, M2_GLTF_MAX_DIAGNOSTICS),
      diagnosticCount: result.length,
    });
  }
  return deepFreeze({
    ...base,
    status: 'ok' as const,
    kind: 'audio' as const,
    metrics: result.metrics,
    inspection: result.inspection,
    diagnostics: [] as readonly ImportDiagnostic[],
    diagnosticCount: 0,
  });
}
