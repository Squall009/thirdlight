/**
 * Asset bytes found and served from disk without holding them.
 *
 * A Play build needs to know that every file it names still has the bytes its
 * record says, but not the bytes themselves: the page reads them later, one by
 * one. `locateBlob` answers where a version's bytes are (its game-folder file,
 * what the importer made from it in the import cache, or a stored blob) and
 * checks them by the file's stamp: a file whose stamp is unchanged since it
 * was hashed is not read again (file-stamps.ts), so a build costs one stat per
 * asset, not one read.
 *
 * `openBlobFile` is the serving side. A file is never served under a digest
 * it no longer has:
 *
 * - its stamp is checked when it is opened; a file whose stamp changed is
 *   hashed before a byte is sent, and refused (`asset_source_changed`) when
 *   its bytes are no longer the recorded ones;
 * - while it is sent it is hashed again, and its last chunk is held back
 *   until the whole file has matched: a file changed during the send ends the
 *   response short (the browser drops a response shorter than its
 *   `content-length`, and the page's reader checks the digest too).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, read as readCb, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

import type { CommandError } from '@thirdlight/commands';

import { assetRoot, importedArtifactPath, importKeyOfConverted } from './asset-files';
import { assetRecordOf } from './catalog-lookup';
import type { BlobReadRequest, ContentContext } from './content-store';
import { resolveProjectFile, verifyArtifactDir } from './content-store';
import { assetSourceChanged, assetSourceMissing, blobCorrupt, blobMissing, importedMissing, pathRejected } from './errors';
import { FileStamps, hashFd, sameStamp, stampOf, type Stamp } from './file-stamps';

/** Where one verified blob is on disk. `real` is a host path: backend-internal, never sent to a client. */
export interface BlobFile {
  readonly digest: string;
  readonly byteLength: number;
  readonly real: string;
}

export type LocateBlobResult = { ok: true; assetId: string; version: number; file: BlobFile } | { ok: false; error: CommandError };

/** The size of one chunk while a file is sent. */
export const SERVE_CHUNK_BYTES = 262_144;

interface VersionFacts {
  readonly version: number;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly sourcePath?: string;
  readonly convertedFrom?: Parameters<typeof importKeyOfConverted>[0];
}
interface RecordFacts {
  readonly assetId: string;
  readonly versions: readonly VersionFacts[];
}

function stampsOf(ctx: ContentContext): FileStamps {
  return ctx.stamps ?? new FileStamps(null);
}

/** A file's digest by its stamp (hashed when the stamp is new). Null: it cannot be read. */
function checkFile(ctx: ContentContext, real: string): { digest: string; stamp: Stamp } | null {
  return stampsOf(ctx).digestOf(real);
}

/** A stored blob (`sources/sha256/<digest>`), checked. */
function locateStored(ctx: ContentContext, digest: string, byteLength: number | null, assetId?: string, version?: number): { ok: true; file: BlobFile } | { ok: false; error: CommandError } {
  const dirRes = verifyArtifactDir(ctx.dir, ['sources', 'sha256'], false);
  if (!dirRes.ok) {
    try {
      lstatSync(join(ctx.dir, 'sources'));
      return { ok: false, error: dirRes.error };
    } catch {
      return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`, assetId, version) };
    }
  }
  const path = join(dirRes.dir, digest);
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, error: pathRejected(path, 'the blob path is a symlink (never followed)') };
  } catch {
    return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`, assetId, version) };
  }
  const real = realpathSync(path);
  const found = checkFile(ctx, real);
  if (found === null) return { ok: false, error: blobCorrupt(digest, path, undefined, assetId, version) };
  if (found.digest !== digest || (byteLength !== null && found.stamp.size !== byteLength)) return { ok: false, error: blobCorrupt(digest, path, found.digest, assetId, version) };
  return { ok: true, file: { digest, byteLength: found.stamp.size, real } };
}

/**
 * Where an asset version's verified bytes are: the game-folder file, what the
 * importer made in the import cache, or the stored blob. The same errors as a
 * read (`asset_source_changed`, `asset_source_missing`, `blob_missing`,
 * `blob_corrupt`); nothing is read when the file's stamp is unchanged.
 */
export function locateBlob(ctx: ContentContext, request: BlobReadRequest): LocateBlobResult {
  const list = ((ctx.content as unknown as { assets?: readonly RecordFacts[] } | null)?.assets ?? []) as readonly RecordFacts[];
  const record = assetRecordOf(list, request?.assetId);
  if (record === undefined) {
    return { ok: false, error: { code: 'asset_not_found', cls: 'validation', assetId: String(request?.assetId), message: `asset '${String(request?.assetId)}' does not exist in the catalog`, hint: 'query the catalog (queryAssets) for current IDs' } };
  }
  const v = record.versions.find((x) => x.version === request.version);
  if (v === undefined) {
    return { ok: false, error: { code: 'asset_version_not_found', cls: 'validation', assetId: record.assetId, assetVersion: Number(request.version), message: `version ${String(request.version)} does not exist for asset '${record.assetId}'`, hint: 'query the catalog for the current versions' } };
  }
  const { assetId } = record;
  const version = v.version;
  const digest = v.sourceDigest;
  if (v.convertedFrom !== undefined) {
    const cached = importedArtifactPath(ctx, importKeyOfConverted(v.convertedFrom), digest);
    if (cached !== null) {
      const found = checkFile(ctx, cached);
      if (found !== null && found.digest === digest) return { ok: true, assetId, version, file: { digest, byteLength: found.stamp.size, real: cached } };
    }
    // A project from before the import cache kept them in the blob store.
    const legacy = locateStored(ctx, digest, null, assetId, version);
    if (legacy.ok) return { ok: true, assetId, version, file: legacy.file };
    return { ok: false, error: importedMissing(digest, v.convertedFrom.sourcePath ?? v.convertedFrom.sourceDigest, assetId, version) };
  }
  if (v.sourcePath !== undefined) {
    const res = resolveProjectFile(ctx, v.sourcePath);
    if (!res.ok) return { ok: false, error: res.missing === true ? assetSourceMissing(digest, v.sourcePath, assetId, version) : res.error };
    const found = checkFile(ctx, res.real);
    if (found === null) return { ok: false, error: pathRejected(v.sourcePath, `${v.sourcePath} could not be read`) };
    if (found.digest !== digest || found.stamp.size !== v.sourceByteLength) return { ok: false, error: assetSourceChanged(digest, v.sourcePath, found.digest, assetId, version) };
    return { ok: true, assetId, version, file: { digest, byteLength: found.stamp.size, real: res.real } };
  }
  const stored = locateStored(ctx, digest, v.sourceByteLength, assetId, version);
  return stored.ok ? { ok: true, assetId, version, file: stored.file } : stored;
}

/** A stored blob by digest (instance buffers, behavior sources), checked by its stamp. */
export function locateSourceBlob(ctx: ContentContext, digest: string): { ok: true; file: BlobFile } | { ok: false; error: CommandError } {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, error: pathRejected(String(digest), 'a source-blob digest must be 64 lowercase hex') };
  return locateStored(ctx, digest, null);
}

/** A blob opened for sending: its chunks are hashed as they are read, the last one held until the whole file matched. */
export interface OpenedBlob {
  readonly byteLength: number;
  /** The file's chunks; throws `BlobChangedError` (before the last chunk) when the bytes are not the recorded ones. */
  chunks(): AsyncGenerator<Uint8Array, void, void>;
  /** Close without reading (a request that ended early). */
  close(): void;
}

/** The file changed while it was sent. */
export class BlobChangedError extends Error {
  constructor(readonly digest: string) {
    super(`the file of ${digest.slice(0, 12)}… changed while it was sent`);
  }
}

export type OpenBlobResult = { ok: true; blob: OpenedBlob } | { ok: false; error: CommandError; changed: boolean };

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function readAt(fd: number, buf: Uint8Array, position: number): Promise<number> {
  return new Promise((resolve, reject) => readCb(fd, buf, 0, buf.length, position, (err, n) => (err !== null ? reject(err) : resolve(n))));
}

/**
 * Open a located blob to serve it. The file must still be inside the project
 * (its game folder or its own folder). A stamp the file had when it was last
 * hashed lets the send start at once; any other stamp means the file is hashed
 * first, and refused when it no longer has the digest (`changed: true`: the
 * caller should have the files checked again).
 */
export function openBlobFile(ctx: ContentContext, file: BlobFile): OpenBlobResult {
  const changed = (found: string): OpenBlobResult => ({ ok: false, changed: true, error: assetSourceChanged(file.digest, file.digest, found) });
  let roots: string[];
  try {
    roots = [realpathSync(assetRoot(ctx)), realpathSync(ctx.dir)];
  } catch {
    return { ok: false, changed: false, error: pathRejected('', 'the game folder is unavailable') };
  }
  if (!roots.some((r) => within(r, file.real))) return { ok: false, changed: false, error: pathRejected('', 'the file is outside the project') };
  let fd: number;
  try {
    fd = openSync(file.real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, changed: true, error: blobMissing(file.digest, file.digest) };
  }
  let stamp: Stamp;
  try {
    stamp = stampOf(fstatSync(fd));
    if (stamp.size !== file.byteLength) {
      closeSync(fd);
      return changed('(another size)');
    }
    if (stampsOf(ctx).known(file.real, stamp) !== file.digest) {
      // Not hashed with this stamp: check the whole file before sending any of it.
      const { digest, read } = hashFd(fd, stamp.size);
      const after = stampOf(fstatSync(fd));
      if (digest !== file.digest || read !== file.byteLength) {
        closeSync(fd);
        return changed(digest);
      }
      if (sameStamp(stamp, after)) stampsOf(ctx).remember(file.real, stamp, digest);
    }
  } catch {
    closeSync(fd);
    return { ok: false, changed: true, error: blobMissing(file.digest, file.digest) };
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    try {
      const h = createHash('sha256');
      let off = 0;
      let held: Uint8Array | null = null;
      while (off < file.byteLength) {
        const buf = new Uint8Array(Math.min(SERVE_CHUNK_BYTES, file.byteLength - off));
        const n = await readAt(fd, buf, off);
        if (n <= 0) break;
        const chunk = n === buf.length ? buf : buf.subarray(0, n);
        h.update(chunk);
        off += n;
        if (held !== null) yield held;
        held = chunk;
      }
      if (off !== file.byteLength || h.digest('hex') !== file.digest) throw new BlobChangedError(file.digest);
      if (held !== null) yield held;
    } finally {
      close();
    }
  }
  return { ok: true, blob: { byteLength: file.byteLength, chunks, close } };
}
