/**
 * Texture mip streaming: which textures stream, and the page's texture
 * budget (Unity's mipmap streaming budget, Unreal's streaming pool, Godot
 * 4.8's streamed textures).
 *
 * A texture streams when it has a mip chain to stream: a KTX2 (a KTX2 file,
 * or a PNG/JPEG with a KTX2 encode, which makes the chain) with levels
 * larger than the mip tail, not a texture array. The import setting
 * `streaming` on the asset's record turns it on or off; absent, it is on for
 * textures over {@link TEXTURE_STREAMING_DEFAULT_ABOVE_PX} on their longer
 * edge. A PNG, JPEG or WebP without a KTX2 encode never streams: it has no
 * stored mip chain to read level by level (the GPU makes its mips after
 * the whole image is uploaded).
 */

import type { ModelErrorV2 } from './errors';
import { fieldType, isPlainObject, unexpectedField } from './validate';

/**
 * Streaming is on by default above this longer edge: a 1024² texture's whole
 * chain is 1.3 MiB as BC7 (0.7 as BC1), too little to be worth the requests.
 */
export const TEXTURE_STREAMING_DEFAULT_ABOVE_PX = 1024;

/**
 * The levels at most this many texels on their longer edge are the mip
 * tail: read in one request with the file's metadata when the texture first
 * loads, and always resident while it is (21 KiB as BC7). A far object
 * rarely needs more than 128 texels across.
 */
export const TEXTURE_STREAM_TAIL_PX = 128;

/**
 * The texture budget a project gets unless its settings name one (MiB).
 * Unity's default streaming budget is 512 MB; a mid-range laptop (an
 * integrated GPU sharing 8–16 GiB with the system, as the Iris Xe this
 * engine is measured on) holds that beside the browser, the page and the
 * game's geometry with room to spare.
 */
export const TEXTURE_BUDGET_DEFAULT_MB = 512;
/** The smallest budget a project may set (a test of the budget, a tiny page); the tails always stay. */
export const TEXTURE_BUDGET_MIN_MB = 1;
/** The largest: more than any browser GPU process holds. */
export const TEXTURE_BUDGET_MAX_MB = 65_536;

/** Whether a texture version's facts allow streaming (a KTX2 plain texture with a chain past the tail). */
export function textureHasStreamableChain(metrics: unknown): boolean {
  if (!isPlainObject(metrics) || metrics['format'] !== 'ktx2' || metrics['layers'] !== undefined) return false;
  const w = metrics['width'];
  const h = metrics['height'];
  const levels = metrics['levels'];
  if (typeof w !== 'number' || typeof h !== 'number' || typeof levels !== 'number' || levels < 2) return false;
  return Math.max(w, h) > TEXTURE_STREAM_TAIL_PX;
}

/** A texture record's streaming as the game uses it: its own setting, else on above the default size. */
export function textureStreamingOf(record: { kind?: unknown; currentVersion?: unknown; versions?: readonly unknown[]; streaming?: unknown }): boolean {
  if (record.kind !== 'texture') return false;
  const versions = Array.isArray(record.versions) ? record.versions : [];
  const current = versions.find((v) => isPlainObject(v) && v['version'] === record.currentVersion) ?? versions[versions.length - 1];
  const metrics = isPlainObject(current) ? current['metrics'] : undefined;
  if (!textureHasStreamableChain(metrics)) return false;
  if (typeof record.streaming === 'boolean') return record.streaming;
  const m = metrics as Record<string, number>;
  return Math.max(m['width']!, m['height']!) > TEXTURE_STREAMING_DEFAULT_ABOVE_PX;
}

/** The record-level `streaming` setting: a boolean, textures only (absent: by size). */
export function validateTextureStreamingField(a: Record<string, unknown>, path: string, errors: ModelErrorV2[], isTexture: boolean): void {
  const v = a['streaming'];
  if (v === undefined) return;
  if (!isTexture) errors.push(unexpectedField(`${path}/streaming`, 'streaming', 'only a texture asset streams its mips'));
  else if (typeof v !== 'boolean') errors.push(fieldType(`${path}/streaming`, v, 'boolean'));
}

/** A budget setting in MiB as bytes (the default when absent or not a number). */
export function textureBudgetBytesOf(settings: Readonly<Record<string, unknown>> | undefined): number {
  const v = settings?.['texture_budget_mb'];
  const mb = typeof v === 'number' && Number.isFinite(v) ? Math.min(TEXTURE_BUDGET_MAX_MB, Math.max(TEXTURE_BUDGET_MIN_MB, v)) : TEXTURE_BUDGET_DEFAULT_MB;
  return Math.round(mb * 1024 * 1024);
}
