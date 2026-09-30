/**
 * The one audio asset kind: any Ogg Vorbis, Ogg Opus, MP3, WAV or FLAC file,
 * at any channel count, sample rate, bit depth and length (Unity's
 * `AudioClip`, Godot's `AudioStream`). Sound effects, music, voice and UI
 * sounds are mixer buses, never kinds of asset.
 *
 * How a file is held in memory is an import setting of the asset (its
 * sidecar record): the load type (decode on load, decode while playing,
 * stream) and whether it is read with the scene that uses it (preload) or
 * only when played. Both default by the file's length; the record stores
 * only what the user changed.
 */

import type { ModelErrorV2 } from './errors';
import { fieldMissing, fieldType, fieldValue, isPlainObject, pointerSegment, unexpectedField, withFound } from './validate';

/** The container and codec of an audio file, read from its headers (never its name). */
export const AUDIO_FORMATS = ['ogg-vorbis', 'ogg-opus', 'mp3', 'wav', 'flac'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** How an audio file is held when the game plays it (Unity's Load Type). */
export const AUDIO_LOAD_TYPES = ['decode-on-load', 'decode-while-playing', 'stream'] as const;
export type AudioLoadType = (typeof AUDIO_LOAD_TYPES)[number];

/**
 * A sound shorter than this decodes when it loads: a decoded buffer of a few
 * seconds is small, and it starts with no decode wait (footsteps, hits, UI).
 */
export const AUDIO_DECODE_ON_LOAD_BELOW_MS = 5_000;
/**
 * A sound longer than this streams: a decoded minute of stereo 48 kHz is
 * about 23 MiB, so music and ambience are played from their compressed bytes.
 */
export const AUDIO_STREAM_ABOVE_MS = 60_000;

/** The recipe of an audio version: the header inspector of the asset pipeline at its pin. */
export const AUDIO_PIPELINE_NAME = 'asset-pipeline';
export const AUDIO_PIPELINE_VERSION = '0.1.0';

/** Facts of one audio version, all read from the file's headers. */
export interface AudioMetrics {
  format: AudioFormat;
  channels: number;
  sampleRate: number;
  /** WAV and FLAC: bits per sample (absent for the lossy codecs, which have none). */
  bitsPerSample?: number;
  /** WAV only: the samples are IEEE floats (absent: integers). */
  float?: true;
  durationMs: number;
}

export interface AudioRecipe {
  profile: 'audio';
  recipeVersion: 1;
  toolchain: Record<string, string>;
}

/** The load settings of an audio asset as the game uses them (defaults applied). */
export interface AudioLoadSettings {
  loadType: AudioLoadType;
  /** True: read with the scene that uses it; false: only when it is played. */
  preload: boolean;
}

/** The load type an audio file of this length gets unless its import settings say otherwise. */
export function defaultAudioLoadType(durationMs: number): AudioLoadType {
  if (durationMs < AUDIO_DECODE_ON_LOAD_BELOW_MS) return 'decode-on-load';
  if (durationMs > AUDIO_STREAM_ABOVE_MS) return 'stream';
  return 'decode-while-playing';
}

/** An audio record's load settings: its own, else the defaults for its current version's length. */
export function audioLoadOf(record: { currentVersion?: unknown; versions?: readonly unknown[]; loadType?: unknown; preload?: unknown }): AudioLoadSettings {
  const versions = Array.isArray(record.versions) ? record.versions : [];
  const current = versions.find((v) => isPlainObject(v) && v['version'] === record.currentVersion) ?? versions[versions.length - 1];
  const metrics = isPlainObject(current) && isPlainObject(current['metrics']) ? current['metrics'] : {};
  const ms = typeof metrics['durationMs'] === 'number' ? metrics['durationMs'] : 0;
  const loadType = (AUDIO_LOAD_TYPES as readonly unknown[]).includes(record.loadType) ? (record.loadType as AudioLoadType) : defaultAudioLoadType(ms);
  return { loadType, preload: record.preload !== false };
}

/**
 * What a browser the engine targets does not play of this file, checked
 * against MDN's codec and container tables: every one of Chromium, Firefox
 * and Safari plays MP3, FLAC and PCM WAV; only Safari's newer releases play
 * Ogg Vorbis and Ogg Opus (the message names them). Web Audio promises 32 channels
 * and 8–96 kHz; a file past those may not decode everywhere. Empty: every
 * browser plays it.
 */
export function audioPlaybackGaps(m: Pick<AudioMetrics, 'format' | 'channels' | 'sampleRate'>): string[] {
  const out: string[] = [];
  if (m.format === 'ogg-vorbis' || m.format === 'ogg-opus') out.push(`Safari before 18.4 (macOS 15.4, iOS 18.4) does not play Ogg ${m.format === 'ogg-opus' ? 'Opus' : 'Vorbis'}`);
  if (m.channels > 32) out.push(`${m.channels} channels: Web Audio promises 32, so some browsers may not decode it`);
  if (m.sampleRate < 8_000 || m.sampleRate > 96_000) out.push(`${m.sampleRate} Hz: Web Audio promises 8–96 kHz, so some browsers may not decode it`);
  return out;
}

/** What the asset list, the Inspector and MCP show of an audio asset. */
export interface AudioSummary {
  format: AudioFormat;
  channels: number;
  sampleRate: number;
  bitsPerSample?: number;
  durationMs: number;
  loadType: AudioLoadType;
  /** The user chose the load type (false: the default for its length). */
  loadTypeSet: boolean;
  preload: boolean;
  /** What a browser the engine targets does not play of it (absent: every one plays it). */
  playbackGaps?: string[];
}

/** An audio record's summary from its current version (undefined for another kind). */
export function audioSummaryOf(a: { kind?: unknown; currentVersion?: unknown; versions?: readonly unknown[]; loadType?: unknown; preload?: unknown }): AudioSummary | undefined {
  if (a.kind !== 'audio' || !Array.isArray(a.versions)) return undefined;
  const v = a.versions.find((x) => isPlainObject(x) && x['version'] === a.currentVersion);
  const m = isPlainObject(v) && isPlainObject(v['metrics']) ? (v['metrics'] as unknown as AudioMetrics) : undefined;
  if (m === undefined) return undefined;
  const load = audioLoadOf(a);
  const gaps = audioPlaybackGaps(m);
  return {
    format: m.format,
    channels: m.channels,
    sampleRate: m.sampleRate,
    ...(m.bitsPerSample !== undefined ? { bitsPerSample: m.bitsPerSample } : {}),
    durationMs: m.durationMs,
    loadType: load.loadType,
    loadTypeSet: a.loadType !== undefined,
    preload: load.preload,
    ...(gaps.length > 0 ? { playbackGaps: gaps } : {}),
  };
}

// ---- validation ------------------------------------------------------------

const RECIPE_FIELDS = ['profile', 'recipeVersion', 'toolchain'];
const METRIC_FIELDS = ['format', 'channels', 'sampleRate', 'bitsPerSample', 'float', 'durationMs'];

export function validateAudioRecipe(r: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  const bad = (message: string, found: unknown): void => void errors.push(withFound({ code: 'recipe_invalid', path, message, expected: 'a valid import recipe' }, found));
  if (r['profile'] !== 'audio') bad('an audio import recipe profile must be "audio"', r['profile']);
  if (r['recipeVersion'] !== 1) bad('an audio import recipe version must be exactly 1', r['recipeVersion']);
  const toolchain = r['toolchain'];
  if (!isPlainObject(toolchain) || Object.keys(toolchain).length !== 1 || toolchain[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
    bad(`the audio toolchain must name exactly "${AUDIO_PIPELINE_NAME}" at '${AUDIO_PIPELINE_VERSION}'`, toolchain);
  }
  for (const k of Object.keys(r)) if (!RECIPE_FIELDS.includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, RECIPE_FIELDS.join(', ')));
}

export function validateAudioMetrics(m: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  const format = m['format'];
  if (!(AUDIO_FORMATS as readonly unknown[]).includes(format)) {
    errors.push(fieldValue(`${path}/format`, format, AUDIO_FORMATS.map((f) => `"${f}"`).join(' | '), 'audio is Ogg Vorbis, Ogg Opus, MP3, WAV or FLAC'));
  }
  const int = (k: string, min: number, max: number, message: string): void => {
    const v = m[k];
    if (v === undefined) errors.push(fieldMissing(`${path}/${k}`, k));
    else if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) errors.push(fieldValue(`${path}/${k}`, v, `integer ${min}..${max}`, message));
  };
  int('channels', 1, 65_535, 'an audio file has at least one channel');
  int('sampleRate', 1, 4_294_967_295, 'the sample rate is a positive integer');
  int('durationMs', 1, Number.MAX_SAFE_INTEGER, 'an audio file lasts at least a millisecond');
  const lossless = format === 'wav' || format === 'flac';
  if (lossless) int('bitsPerSample', 1, 64, 'the bits per sample of a WAV or FLAC');
  else if (m['bitsPerSample'] !== undefined) errors.push(unexpectedField(`${path}/bitsPerSample`, 'bitsPerSample', 'only a WAV or FLAC records its bits per sample'));
  if (m['float'] !== undefined && (format !== 'wav' || m['float'] !== true)) errors.push(fieldValue(`${path}/float`, m['float'], 'true, on a WAV (absent: integer samples)', 'float marks a WAV of IEEE float samples'));
  for (const k of Object.keys(m)) if (!METRIC_FIELDS.includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, METRIC_FIELDS.join(', ')));
}

/** The record-level load settings (`loadType`, `preload`), audio only. */
export function validateAudioLoadFields(a: Record<string, unknown>, path: string, errors: ModelErrorV2[], isAudio: boolean): void {
  for (const k of ['loadType', 'preload'] as const) {
    if (a[k] === undefined) continue;
    if (!isAudio) errors.push(unexpectedField(`${path}/${k}`, k, 'only an audio asset has load settings'));
  }
  if (!isAudio) return;
  if (a['loadType'] !== undefined && !(AUDIO_LOAD_TYPES as readonly unknown[]).includes(a['loadType'])) {
    errors.push(fieldValue(`${path}/loadType`, a['loadType'], AUDIO_LOAD_TYPES.map((t) => `"${t}"`).join(' | '), 'the load type is decode-on-load, decode-while-playing or stream (absent: the default for its length)'));
  }
  if (a['preload'] !== undefined && a['preload'] !== false) {
    errors.push(a['preload'] === true ? fieldValue(`${path}/preload`, true, 'false (absent: true)', 'preload is stored only when off') : fieldType(`${path}/preload`, a['preload'], 'false'));
  }
}

/** The canonical metrics member (fixed key order). */
export function canonicalAudioMetrics(m: AudioMetrics): AudioMetrics {
  return {
    format: m.format,
    channels: m.channels,
    sampleRate: m.sampleRate,
    ...(m.bitsPerSample !== undefined ? { bitsPerSample: m.bitsPerSample } : {}),
    ...(m.float === true ? { float: true as const } : {}),
    durationMs: m.durationMs,
  };
}

// ---- the upgrade -------------------------------------------------------------

/**
 * One asset record in the one-kind shape: a `music` record becomes `audio`
 * (its id, file and facts kept), and the fixed short-sound profile's `audio`
 * record (a 48 kHz mono 16-bit WAV with its PCM arithmetic) keeps only the
 * facts every audio file has. Null when the record needs no change.
 */
export function upgradeAudioRecord(record: unknown): Record<string, unknown> | null {
  if (!isPlainObject(record) || (record['kind'] !== 'music' && record['kind'] !== 'audio') || !Array.isArray(record['versions'])) return null;
  let changed = record['kind'] === 'music';
  const versions = record['versions'].map((v) => {
    if (!isPlainObject(v)) return v;
    const recipe = v['importRecipe'];
    const metrics = v['metrics'];
    if (!isPlainObject(recipe) || !isPlainObject(metrics) || recipe['profile'] === 'audio') return v;
    changed = true;
    const toolchain = isPlainObject(recipe['toolchain']) ? { ...(recipe['toolchain'] as Record<string, string>) } : { [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION };
    const m: Record<string, unknown> = {
      format: recipe['profile'] === 'pcm-wav' ? 'wav' : metrics['format'],
      channels: metrics['channels'],
      sampleRate: metrics['sampleRate'],
    };
    // Both older importers took only 16-bit PCM WAV.
    if (m['format'] === 'wav') m['bitsPerSample'] = typeof metrics['bitsPerSample'] === 'number' ? metrics['bitsPerSample'] : 16;
    m['durationMs'] = metrics['durationMs'];
    return { ...v, importRecipe: { profile: 'audio', recipeVersion: 1, toolchain }, metrics: m };
  });
  if (!changed) return null;
  return { ...record, kind: 'audio', versions };
}

/** Every asset record of a content document in the one-kind shape; the ids that changed. */
export function upgradeAudioAssets(content: unknown): { content: unknown; upgraded: string[] } {
  if (!isPlainObject(content) || !Array.isArray(content['assets'])) return { content, upgraded: [] };
  const upgraded: string[] = [];
  const assets = content['assets'].map((a) => {
    const u = upgradeAudioRecord(a);
    if (u === null) return a;
    upgraded.push(String(u['assetId']));
    return u;
  });
  return upgraded.length === 0 ? { content, upgraded } : { content: { ...content, assets }, upgraded };
}
