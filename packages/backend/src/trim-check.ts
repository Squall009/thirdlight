/**
 * A trim sheet's image checked against its row table (the Inspector's
 * "Check padding"): every row's padding should repeat its edge, or continue
 * its wrap for a row that tiles in v (`trimPaddingProblems`), and the image
 * should be the size the table says.
 *
 * The pixels are the texture's current version: a PNG, JPEG or WebP as
 * imported, a KTX2's lossless original when the backend has it, else the
 * KTX2 transcoded. A UASTC KTX2 keeps pixels within a few levels, so its
 * differences are allowed a little more. An ETC1S KTX2 cannot be judged
 * pixel by pixel: its 4 × 4 blocks share a colour and pick each pixel's
 * shade from a codebook, so where a row meets its gutter a block holding
 * both moves the repeated rows apart by as much as a real fault (measured on
 * a padded sheet from the pinned encoder: up to 77 levels on smooth content,
 * 186 on noise; an unpadded gutter: 38–78). Gutters that still repeat
 * within the tolerance pass; differences are reported as not judged rather
 * than as faults (the PNG they came from may repeat exactly). Decoding runs on the texture encoder's worker,
 * never on the backend's event loop.
 */
import { isEtc1sKtx2, readKtx2 } from './ktx2-container';
import type { TextureEncoder } from './texture-encode';
import { losslessOriginal, textureVersionsOf } from './texture-originals';
import type { WorkspaceService } from '@thirdlight/workspace';
import { trimPaddingProblems, type TrimPaddingProblem, type TrimSheet } from '@thirdlight/project-model/trim-sheet';

/** The largest sheet the check decodes (a 4096² sheet: the Texture Designer's largest). */
export const TRIM_CHECK_PIXELS_MAX = 4096 * 4096;
/** A channel difference (0–255) padding may show and still pass: lossless images, then a transcoded UASTC KTX2. */
export const TRIM_CHECK_TOLERANCE = 8;
export const TRIM_CHECK_TOLERANCE_TRANSCODED = 24;

export type TrimCheckResult =
  | { ok: true; width: number; height: number; sizeMatches: boolean; transcoded: boolean; paddingRead: boolean; problems: TrimPaddingProblem[] }
  | { ok: false; code: 'asset_not_found' | 'converter_unavailable' | 'conversion_failed'; message: string };

/** A trim sheet texture's pixels as the checks read them (see the module's note on KTX2 originals). */
export type TrimSheetImageRead =
  | { ok: true; rgba: Uint8Array; width: number; height: number; transcoded: boolean; lossy: boolean; digest: string }
  | { ok: false; code: 'asset_not_found' | 'converter_unavailable' | 'conversion_failed'; message: string };

/** The current version's identity of a texture asset (null: no such texture). */
export function textureVersionOf(service: WorkspaceService, projectId: string, textureId: string): { version: number; digest: string } | null {
  const q = service.query({ op: 'queryAssets', projectId, args: { assetId: textureId, includeVersions: true, limit: 1, offset: 0 } }) as { ok: boolean; assets?: { kind: string; currentVersion: number; versions?: { version: number; sourceDigest: string }[] }[] };
  const a = q.assets?.[0];
  if (!q.ok || a === undefined || a.kind !== 'texture') return null;
  return { version: a.currentVersion, digest: a.versions?.find((v) => v.version === a.currentVersion)?.sourceDigest ?? '' };
}

export async function readTrimSheetImage(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined }, projectId: string, textureId: string): Promise<TrimSheetImageRead> {
  if (deps.encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'image decoding is not available on this server' };
  const a = textureVersionOf(deps.service, projectId, textureId);
  if (a === null) return { ok: false, code: 'asset_not_found', message: `no texture asset "${textureId}" in this project` };
  const read = deps.service.readBlob(projectId, { assetId: textureId, version: a.version });
  if (!read.ok) return { ok: false, code: 'asset_not_found', message: `texture "${textureId}": ${read.error.message}` };
  let bytes = read.bytes;
  const head = readKtx2(bytes);
  let lossy = false;
  if (head !== null) {
    if (head.layerCount >= 2) return { ok: false, code: 'conversion_failed', message: `texture "${textureId}" is a texture array: a trim sheet is one image` };
    const v = textureVersionsOf(deps.service, projectId).get(textureId);
    const original = v !== undefined && v.version === a.version ? losslessOriginal(deps.service, projectId, v, bytes, head.width, head.height) : null;
    if (original !== null) bytes = original.bytes;
    else lossy = isEtc1sKtx2(head);
  }
  const img = await deps.encoder.decode(bytes, TRIM_CHECK_PIXELS_MAX);
  if (!img.ok) return { ok: false, code: 'conversion_failed', message: `texture "${textureId}" could not be read: ${img.message}` };
  return { ok: true, rgba: img.data, width: img.width, height: img.height, transcoded: img.transcoded, lossy, digest: a.digest };
}

export async function checkTrimSheetTexture(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined }, projectId: string, textureId: string, sheet: TrimSheet): Promise<TrimCheckResult> {
  const img = await readTrimSheetImage(deps, projectId, textureId);
  if (!img.ok) return img;
  const sizeMatches = img.width === sheet.size[0] && img.height === sheet.size[1];
  const found = sizeMatches ? trimPaddingProblems(img.rgba, img.width, img.height, sheet, img.transcoded ? TRIM_CHECK_TOLERANCE_TRANSCODED : TRIM_CHECK_TOLERANCE) : [];
  // An ETC1S sheet's differences are the codec's as much as the gutters' (see the module comment): not judged.
  const paddingRead = !(img.lossy && found.length > 0);
  return { ok: true, width: img.width, height: img.height, sizeMatches, transcoded: img.transcoded, paddingRead, problems: paddingRead ? found : [] };
}
