/**
 * Asset thumbnails: small PNG previews the editor renders for the asset tiles.
 *
 * Part of the project's import cache, not project state: files live under
 * `<project>/cache/imported/<sourceDigest>/thumbnails/<key>.png`, keyed by
 * the asset version's content digest (new bytes get new thumbnails) and by
 * piece (`file` for the whole model, else a hash of the piece name). The
 * cache is git-ignored; a missing file is simply rendered again by the next
 * editor that needs it.
 */
import { ID_RE } from '@thirdlight/project-model/limits';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Largest thumbnail accepted (bytes). */
export const THUMBNAIL_BYTES_MAX = 262_144;
/** Largest thumbnail edge (pixels). */
export const THUMBNAIL_EDGE_MAX = 512;

const PROJECT_RE = ID_RE;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ThumbnailCache {
  read(projectId: string, digest: string, piece: string | null): Uint8Array | null;
  /**
   * A validator for one cached thumbnail (changes when the file is
   * rewritten), for HTTP revalidation (`ETag` / `If-None-Match` → 304); null
   * when none is cached.
   */
  etag(projectId: string, digest: string, piece: string | null): string | null;
  /** Store one PNG; returns an error message when the bytes are refused. */
  write(projectId: string, digest: string, piece: string | null, png: Uint8Array): string | null;
}

/** The file key of a piece (`file` for the whole model). */
export function thumbnailKey(piece: string | null): string {
  return piece === null ? 'file' : `p-${createHash('sha256').update(piece, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Check a PNG's signature and IHDR size; returns an error message or null. */
export function checkThumbnailPng(png: Uint8Array): string | null {
  if (png.byteLength > THUMBNAIL_BYTES_MAX) return `a thumbnail is at most ${THUMBNAIL_BYTES_MAX} bytes`;
  if (png.byteLength < 33 || !PNG_SIGNATURE.every((b, i) => png[i] === b)) return 'a thumbnail must be a PNG image';
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdr = String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!);
  if (ihdr !== 'IHDR') return 'the PNG has no IHDR chunk';
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > THUMBNAIL_EDGE_MAX || height > THUMBNAIL_EDGE_MAX) {
    return `a thumbnail is 1-${THUMBNAIL_EDGE_MAX} pixels on each edge`;
  }
  return null;
}

/** `cacheDirOf` answers a project's import cache folder (null: no such project). */
export function createThumbnailCache(cacheDirOf: (projectId: string) => string | null): ThumbnailCache {
  const dirOf = (projectId: string, digest: string): string | null => {
    if (!PROJECT_RE.test(projectId) || !DIGEST_RE.test(digest)) return null;
    const root = cacheDirOf(projectId);
    return root === null ? null : join(root, digest, 'thumbnails');
  };
  return {
    etag(projectId, digest, piece) {
      const dir = dirOf(projectId, digest);
      if (dir === null) return null;
      try {
        const st = statSync(join(dir, `${thumbnailKey(piece)}.png`));
        return `"t-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      } catch {
        return null;
      }
    },
    read(projectId, digest, piece) {
      const dir = dirOf(projectId, digest);
      if (dir === null) return null;
      const path = join(dir, `${thumbnailKey(piece)}.png`);
      try {
        if (statSync(path).size > THUMBNAIL_BYTES_MAX) return null;
        return new Uint8Array(readFileSync(path));
      } catch {
        return null;
      }
    },
    write(projectId, digest, piece, png) {
      const dir = dirOf(projectId, digest);
      if (dir === null) return 'invalid project or digest';
      const bad = checkThumbnailPng(png);
      if (bad !== null) return bad;
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${thumbnailKey(piece)}.png`);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, png);
      renameSync(tmp, path);
      return null;
    },
  };
}
