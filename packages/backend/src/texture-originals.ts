/**
 * The lossless original of a KTX2 texture asset, for packing: when layers
 * have to be encoded again (ETC1S sources, a size or mip mismatch, a channel
 * repack), reading the PNG the KTX2 was made from avoids a second lossy
 * generation.
 *
 * Two places, in order: the PNG the asset was encoded from on import
 * (`convertedFrom.sourcePath`, still holding the bytes recorded then), and a
 * PNG of the same name and size beside the KTX2 file (a KTX2 exported by an
 * asset tool next to its PNG). A PNG beside the file counts only when its
 * digest is one recorded for this KTX2 — the import's `convertedFrom`
 * digest, or the KTX2's own `KTX2_SOURCE_DIGEST_KEY` entry: name and size
 * alone would also match a PNG left over from before the KTX2 was exported
 * again, and packing would then encode the old image without saying so.
 * Without a proven original the KTX2 itself is the source (transcoded, and
 * the layer reported as re-encoded).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { imageDimensions } from '@thirdlight/asset-pipeline';
import type { WorkspaceService } from '@thirdlight/workspace';

import { ktx2KeyValues, readKtx2 } from './ktx2-container';

/**
 * The KTX2 key/value entry an asset tool writes to tie the file to the PNG
 * it was encoded from: the PNG's sha-256 as lowercase hex (a NUL-terminated
 * string, as KTX2 string values are).
 */
export const KTX2_SOURCE_DIGEST_KEY = 'thirdlight.sourceSha256';

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

/** The PNG sha-256 a KTX2 records of its source (`KTX2_SOURCE_DIGEST_KEY`); null when it records none. */
export function ktx2RecordedSourceDigest(ktx2: Uint8Array): string | null {
  const c = readKtx2(ktx2);
  const v = c === null ? undefined : ktx2KeyValues(c.kvd).get(KTX2_SOURCE_DIGEST_KEY);
  if (v === undefined) return null;
  const hex = Buffer.from(v).toString('latin1').replace(/\0+$/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * The lossless PNG behind a KTX2 texture version of `width` × `height`
 * (`ktx2`: the version's bytes), with its game-folder path and digest; null
 * when there is none (the KTX2 is transcoded).
 */
export function losslessOriginal(service: WorkspaceService, projectId: string, version: TextureVersionLike, ktx2: Uint8Array, width: number, height: number): { path: string; bytes: Uint8Array; digest: string } | null {
  const sameSize = (bytes: Uint8Array): boolean => {
    const d = imageDimensions(bytes, 'image/png');
    return d !== null && d.width === width && d.height === height;
  };
  const c = version.convertedFrom;
  const fromPng = c?.format === 'png' ? c.sourceDigest : undefined;
  if (fromPng !== undefined && c?.sourcePath !== undefined) {
    const r = readVerified(service, projectId, c.sourcePath);
    // The recorded bytes only: a PNG edited since the import is not what the KTX2 holds.
    if (r !== null && r.digest === fromPng && sameSize(r.bytes)) return { path: c.sourcePath, ...r };
  }
  const own = version.sourcePath;
  if (own !== undefined && /\.ktx2$/i.test(own)) {
    const recorded = new Set([fromPng, ktx2RecordedSourceDigest(ktx2)].filter((d): d is string => d !== undefined && d !== null));
    if (recorded.size === 0) return null;
    const path = own.replace(/\.ktx2$/i, '.png');
    const r = readVerified(service, projectId, path);
    if (r !== null && recorded.has(r.digest) && sameSize(r.bytes)) return { path, ...r };
  }
  return null;
}
