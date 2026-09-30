/**
 * What each file of a project hashed to, and the stamp the file had then
 * (size, modification and change times, inode). A file whose stamp is the
 * same is not read again: the file check, a Play or an export build and the
 * integrity report hash a file once per change instead of once per use (Git's
 * index and Unity's asset database skip unchanged files the same way).
 *
 * The stamps are kept in memory per open project and written to the import
 * cache (`cache/imported/file-stamps.json`, git-ignored, rebuilt by hashing
 * when missing), so a restart does not hash every file again.
 *
 * A stamp is trusted only when the file was last modified well before it was
 * hashed: a write in the same clock tick as the hash would leave the stamp
 * unchanged (Git's "racily clean" rule), so such a file is hashed again the
 * next time it is asked about.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

/** The file-system facts that change whenever a file's bytes can have changed. */
export interface Stamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

interface Entry extends Stamp {
  readonly digest: string;
  /** When the file was hashed (the racy-stamp rule compares the modification time with it). */
  readonly checkedAtMs: number;
}

/** How long after a file's last modification a hash of it is trusted (the coarsest common file-time resolution). */
export const STAMP_RACY_MS = 2_000;
/** The size of one read while hashing (a file is never held whole to be hashed). */
export const HASH_CHUNK_BYTES = 1_048_576;
/** The stamps' file in the import cache. */
export const FILE_STAMPS_NAME = 'file-stamps.json';
/** The persisted stamps' format. */
const STAMPS_FORMAT = 1;

export function stampOf(st: Stats): Stamp {
  return { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino };
}

export function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

/** SHA-256 of an open file, read in chunks (the fd stays open; the caller closes it). */
export function hashFd(fd: number, size: number): { digest: string; read: number } {
  const h = createHash('sha256');
  const buf = new Uint8Array(Math.min(HASH_CHUNK_BYTES, Math.max(1, size)));
  let off = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, off);
    if (n <= 0) break;
    h.update(buf.subarray(0, n));
    off += n;
  }
  return { digest: h.digest('hex'), read: off };
}

export class FileStamps {
  private readonly entries = new Map<string, Entry>();
  private loaded = false;
  private dirty = false;
  /** Files hashed (tests and the bench read it). */
  hashes = 0;

  /** `file`: where the stamps are kept between runs (null: memory only). */
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.file === null) return;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    const d = doc as { format?: unknown; files?: unknown };
    if (d.format !== STAMPS_FORMAT || typeof d.files !== 'object' || d.files === null) return;
    for (const [path, v] of Object.entries(d.files as Record<string, unknown>)) {
      if (!Array.isArray(v) || v.length !== 6) continue;
      const [size, mtimeMs, ctimeMs, ino, digest, checkedAtMs] = v as unknown[];
      if (typeof size !== 'number' || typeof mtimeMs !== 'number' || typeof ctimeMs !== 'number' || typeof ino !== 'number' || typeof checkedAtMs !== 'number') continue;
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) continue;
      this.entries.set(path, { size, mtimeMs, ctimeMs, ino, digest, checkedAtMs });
    }
  }

  /** The digest remembered for a file with this stamp, or null (never hashed, changed since, or hashed too soon after a write). */
  known(real: string, stamp: Stamp): string | null {
    this.load();
    const e = this.entries.get(real);
    if (e === undefined || !sameStamp(e, stamp)) return null;
    if (e.mtimeMs > e.checkedAtMs - STAMP_RACY_MS) return null;
    return e.digest;
  }

  /** Remember what a file with this stamp hashed to (the hash was made now). */
  remember(real: string, stamp: Stamp, digest: string): void {
    this.load();
    this.entries.set(real, { ...stamp, digest, checkedAtMs: this.now() });
    this.dirty = true;
  }

  /** The file's current digest and stamp: the remembered one when its stamp is unchanged, else hashed now. Null: it cannot be read. */
  digestOf(real: string): { digest: string; stamp: Stamp; hashed: boolean } | null {
    let fd: number;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const stamp = stampOf(fstatSync(fd));
      const seen = this.known(real, stamp);
      if (seen !== null) return { digest: seen, stamp, hashed: false };
      const { digest, read } = hashFd(fd, stamp.size);
      this.hashes += 1;
      // A file that changed while it was read: its new stamp is the one to keep (next time it is hashed again).
      const after = stampOf(fstatSync(fd));
      if (read !== stamp.size || !sameStamp(stamp, after)) return { digest, stamp: after, hashed: true };
      this.remember(real, stamp, digest);
      return { digest, stamp, hashed: true };
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** The stat of a file as a stamp (null: it is not there). */
  static stat(real: string): Stamp | null {
    try {
      return stampOf(statSync(real));
    } catch {
      return null;
    }
  }

  /** Forget files not in `keep` that `prunable` names (after a pass over every asset file: renamed and deleted files drop out). */
  retainOnly(keep: ReadonlySet<string>, prunable: (path: string) => boolean): void {
    this.load();
    for (const k of [...this.entries.keys()]) {
      if (!keep.has(k) && prunable(k)) {
        this.entries.delete(k);
        this.dirty = true;
      }
    }
  }

  get size(): number {
    this.load();
    return this.entries.size;
  }

  /** Write the stamps when they changed (written then renamed, not flushed: a lost file only means hashing again). */
  save(): void {
    if (!this.dirty || this.file === null) return;
    this.dirty = false;
    const files: Record<string, unknown[]> = {};
    for (const [k, e] of this.entries) files[k] = [e.size, e.mtimeMs, e.ctimeMs, e.ino, e.digest, e.checkedAtMs];
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ format: STAMPS_FORMAT, files }));
      renameSync(tmp, this.file);
    } catch {
      // The cache is optional: the next run hashes what it cannot find.
      this.dirty = true;
    }
  }
}
