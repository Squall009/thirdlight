/**
 * Texture import (phase 9.4): a standalone PNG, JPEG or WebP image; phase
 * 25.19: or a Basis Universal KTX2 (ETC1S or UASTC, 2D, with its mip levels).
 *
 * Like the GLB and WAV inspectors: bytes in, a bounded non-authoritative
 * proposal out, no decoding. The magic bytes decide the format (never the
 * file name); the container header's declared size decides the pixel budget.
 */
import { resolveImportJob } from './inspect';
import { AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, M2_GLTF_MAX_DIAGNOSTICS } from './limits';
import { decodedImageBytes, detectImageMime, imageDimensions, ktx2Info } from './images';
import { sha256Hex } from './sha256';
import type { ImportDiagnostic, ImportJobPort } from './types';

/** Largest texture file accepted (bytes). */
export const TEXTURE_SOURCE_BYTES_MAX = 16_777_216;
/** Largest texture edge (pixels). */
export const TEXTURE_EDGE_MAX = 4096;

export type TextureFormat = 'png' | 'jpeg' | 'webp' | 'ktx2';

/** The `image` recipe (the toolchain names this inspector). */
export interface ImageRecipe {
  readonly profile: 'image';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
}

/** Facts about one texture (all re-derivable from the bytes). */
export interface ImageMetrics {
  readonly format: TextureFormat;
  readonly width: number;
  readonly height: number;
  /** width × height × 4. */
  readonly decodedBytes: number;
  /** Phase 25.19, KTX2 only: the Basis Universal codec. */
  readonly codec?: 'etc1s' | 'uastc';
  /** Phase 25.19, KTX2 only: the mip levels in the file. */
  readonly levels?: number;
}

export interface ImageImportOptions {
  readonly profile: 'image';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly job?: ImportJobPort;
}

export interface ImageImportProposal {
  readonly proposalId: string;
  readonly stageId: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly status: 'ok' | 'rejected';
  readonly kind?: 'texture';
  readonly importRecipe: ImageRecipe;
  readonly metrics?: ImageMetrics;
  readonly suggestedDisplayName: string;
  /** What the header says (shown by the import panel). */
  readonly inspection: { readonly format: TextureFormat | null; readonly width: number; readonly height: number };
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly diagnosticCount: number;
  readonly expiresAt: string;
}

export const IMAGE_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({ [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION });

function diag(code: ImportDiagnostic['code'], message: string, found?: unknown, expected?: string): ImportDiagnostic {
  return { code, path: '', message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) };
}

function inspectStages(bytes: Uint8Array): ImageMetrics | ImportDiagnostic[] {
  if (bytes.length > TEXTURE_SOURCE_BYTES_MAX) {
    return [diag('asset_size_exceeded', 'the texture file is too large', bytes.length, `<= ${TEXTURE_SOURCE_BYTES_MAX} bytes`)];
  }
  const mime = detectImageMime(bytes);
  if (mime === null) {
    return [diag('asset_image_invalid', 'not a PNG, JPEG, WebP or KTX2 image', undefined, 'PNG, JPEG, WebP or KTX2')];
  }
  if (mime === 'image/ktx2') {
    const info = ktx2Info(bytes);
    if (info === null) return [diag('asset_image_invalid', 'the KTX2 is not a 2D Basis Universal texture (ETC1S or UASTC) with its mip levels', undefined, 'a 2D Basis Universal KTX2 (e.g. encoded at import)')];
    if (info.width > TEXTURE_EDGE_MAX || info.height > TEXTURE_EDGE_MAX) {
      return [diag('asset_limits_exceeded', 'the texture is larger than the edge limit', `${info.width}x${info.height}`, `<= ${TEXTURE_EDGE_MAX} px per edge`)];
    }
    return { format: 'ktx2', width: info.width, height: info.height, decodedBytes: decodedImageBytes(info), codec: info.codec, levels: info.levels };
  }
  const dims = imageDimensions(bytes, mime);
  if (dims === null || dims.width < 1 || dims.height < 1) {
    return [diag('asset_image_invalid', 'the image header declares no readable size')];
  }
  if (dims.width > TEXTURE_EDGE_MAX || dims.height > TEXTURE_EDGE_MAX) {
    return [diag('asset_limits_exceeded', 'the texture is larger than the edge limit', `${dims.width}x${dims.height}`, `<= ${TEXTURE_EDGE_MAX} px per edge`)];
  }
  const format: TextureFormat = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : 'webp';
  return { format, width: dims.width, height: dims.height, decodedBytes: decodedImageBytes(dims) };
}

/** Bounded texture inspection; malformed bytes give a `rejected` proposal, never an exception. */
export function inspectImage(bytes: Uint8Array, options: ImageImportOptions): ImageImportProposal {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('inspectImage: bytes must be a Uint8Array');
  if (options.profile !== 'image' || options.recipeVersion !== 1) throw new TypeError("inspectImage: expected profile 'image', recipeVersion 1");
  const recipe: ImageRecipe = { profile: 'image', recipeVersion: 1, toolchain: { ...IMAGE_TOOLCHAIN } };
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job, options, sourceDigest);
  const result = inspectStages(bytes);
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
    return Object.freeze({ ...base, status: 'rejected' as const, inspection: { format: null, width: 0, height: 0 }, diagnostics: result.slice(0, M2_GLTF_MAX_DIAGNOSTICS), diagnosticCount: result.length });
  }
  return Object.freeze({ ...base, status: 'ok' as const, kind: 'texture' as const, metrics: result, inspection: { format: result.format, width: result.width, height: result.height }, diagnostics: [], diagnosticCount: 0 });
}
