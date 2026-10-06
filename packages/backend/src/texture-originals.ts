/**
 * The lossless original of a KTX2 texture asset, for packing: when layers
 * have to be encoded again (ETC1S sources, a size or mip mismatch, a channel
 * repack), reading the PNG the KTX2 was made from avoids a second lossy
 * generation.
 *
 * Two places, in order: the PNG the asset was encoded from on import
 * (`convertedFrom.sourcePath`, still holding the bytes recorded then), and a
 * PNG of the same name and size beside the KTX2 file (a KTX2 exported by an
 * asset tool next to its PNG, as extracted model textures look for one).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { imageDimensions } from '@thirdlight/asset-pipeline';
import type { WorkspaceService } from '@thirdlight/workspace';

/** The version fields read here. */
interface TextureVersionLike {
  version: number;
  sourcePath?: string;
  convertedFrom?: { format?: string; sourceDigest: string; sourcePath?: string };
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The texture records of the project's content, by id (one read of the captured state). */
export function textureVersionsOf(service: WorkspaceService, projectId: string): Map<string, TextureVersionLike> {
  const out = new Map<string, TextureVersionLike>();
  const captured = service.readCapturedV3(projectId);
  if (!captured.ok) return out;
  const assets = ((captured.read as unknown as { content?: { assets?: { assetId: string; kind?: string; currentVersion: number; versions: TextureVersionLike[] }[] } }).content?.assets ?? []);
  for (const a of assets) {
    if (a.kind !== 'texture') continue;
    const v = a.versions.find((x) => x.version === a.currentVersion);
    if (v !== undefined) out.set(a.assetId, v);
  }
  return out;
}

/** A game-folder file's bytes when they still hash to what `conversionSource` saw; null otherwise. */
function readVerified(service: WorkspaceService, projectId: string, path: string): { bytes: Uint8Array; digest: string } | null {
  const src = service.conversionSource(projectId, path);
  if (!src.ok) return null;
  try {
    const bytes = new Uint8Array(readFileSync(src.real));
    return sha256(bytes) === src.digest ? { bytes, digest: src.digest } : null;
  } catch {
    return null;
  }
}

/**
 * The lossless PNG behind a KTX2 texture version of `width` × `height`, with
 * its game-folder path; null when there is none (the KTX2 is transcoded).
 */
export function losslessOriginal(service: WorkspaceService, projectId: string, version: TextureVersionLike, width: number, height: number): { path: string; bytes: Uint8Array } | null {
  const sameSize = (bytes: Uint8Array): boolean => {
    const d = imageDimensions(bytes, 'image/png');
    return d !== null && d.width === width && d.height === height;
  };
  const c = version.convertedFrom;
  if (c?.format === 'png' && c.sourcePath !== undefined) {
    const r = readVerified(service, projectId, c.sourcePath);
    // The recorded bytes only: a PNG edited since the import is not what the KTX2 holds.
    if (r !== null && r.digest === c.sourceDigest && sameSize(r.bytes)) return { path: c.sourcePath, bytes: r.bytes };
  }
  const own = version.sourcePath;
  if (own !== undefined && /\.ktx2$/i.test(own)) {
    const path = own.replace(/\.ktx2$/i, '.png');
    const r = readVerified(service, projectId, path);
    if (r !== null && sameSize(r.bytes)) return { path, bytes: r.bytes };
  }
  return null;
}
