/**
 * A trim sheet's image checked against its row table (the Inspector's
 * "Check padding"): every row's padding should repeat its edge, or continue
 * its wrap for a row that tiles in v (`trimPaddingProblems`), and the image
 * should be the size the table says.
 *
 * The pixels are the texture's current version: a PNG, JPEG or WebP as
 * imported, a KTX2's lossless original when the backend has it, else the
 * KTX2 transcoded — lossy (ETC1S blocks move pixels a little), so its
 * differences are allowed more. Decoding runs on the texture encoder's
 * worker, never on the backend's event loop.
 */
import { readKtx2 } from './ktx2-container';
import type { TextureEncoder } from './texture-encode';
import { losslessOriginal, textureVersionsOf } from './texture-originals';
import type { WorkspaceService } from '@thirdlight/workspace';
import { trimPaddingProblems, type TrimPaddingProblem, type TrimSheet } from '@thirdlight/project-model/trim-sheet';

/** The largest sheet the check decodes (a 4096² sheet: the Texture Designer's largest). */
export const TRIM_CHECK_PIXELS_MAX = 4096 * 4096;
/** A channel difference (0–255) padding may show and still pass: lossless images, then transcoded KTX2 (block compression). */
export const TRIM_CHECK_TOLERANCE = 8;
export const TRIM_CHECK_TOLERANCE_TRANSCODED = 24;

export type TrimCheckResult =
  | { ok: true; width: number; height: number; sizeMatches: boolean; transcoded: boolean; problems: TrimPaddingProblem[] }
  | { ok: false; code: 'asset_not_found' | 'converter_unavailable' | 'conversion_failed'; message: string };

export async function checkTrimSheetTexture(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined }, projectId: string, textureId: string, sheet: TrimSheet): Promise<TrimCheckResult> {
  if (deps.encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'image decoding is not available on this server' };
  const q = deps.service.query({ op: 'queryAssets', projectId, args: { assetId: textureId, includeVersions: true, limit: 1, offset: 0 } }) as { ok: boolean; assets?: { kind: string; currentVersion: number }[] };
  const a = q.assets?.[0];
  if (!q.ok || a === undefined || a.kind !== 'texture') return { ok: false, code: 'asset_not_found', message: `no texture asset "${textureId}" in this project` };
  const read = deps.service.readBlob(projectId, { assetId: textureId, version: a.currentVersion });
  if (!read.ok) return { ok: false, code: 'asset_not_found', message: `texture "${textureId}": ${read.error.message}` };
  let bytes = read.bytes;
  const head = readKtx2(bytes);
  if (head !== null) {
    if (head.layerCount >= 2) return { ok: false, code: 'conversion_failed', message: `texture "${textureId}" is a texture array: a trim sheet is one image` };
    const v = textureVersionsOf(deps.service, projectId).get(textureId);
    const original = v !== undefined && v.version === a.currentVersion ? losslessOriginal(deps.service, projectId, v, bytes, head.width, head.height) : null;
    if (original !== null) bytes = original.bytes;
  }
  const img = await deps.encoder.decode(bytes, TRIM_CHECK_PIXELS_MAX);
  if (!img.ok) return { ok: false, code: 'conversion_failed', message: `texture "${textureId}" could not be read: ${img.message}` };
  const sizeMatches = img.width === sheet.size[0] && img.height === sheet.size[1];
  const problems = sizeMatches ? trimPaddingProblems(img.data, img.width, img.height, sheet, img.transcoded ? TRIM_CHECK_TOLERANCE_TRANSCODED : TRIM_CHECK_TOLERANCE) : [];
  return { ok: true, width: img.width, height: img.height, sizeMatches, transcoded: img.transcoded, problems };
}
