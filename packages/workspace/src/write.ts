/**
 * The atomic write procedure `W(bytes, target, dir)` — workspace.md §5.1 —
 * plus the pre-write external-change check (§5.2) and the bounded-retry
 * failure classification.
 *
 *   1. tmp = `<dir>/.<basename(target)>.tmp-<pid>-<nonce>` (nonce: a
 *      process-unique counter); `open(tmp, O_WRONLY|O_CREAT|O_EXCL, 0644)`
 *      — EEXIST ⇒ new nonce (≤ 3 attempts);
 *   2. write all bytes; `fsync(fd)`; `close(fd)`;
 *   3. `rename(tmp, target)` — atomic same-filesystem replacement;
 *   4. directory flush: `open(dir, O_RDONLY)`, `fsync(dirfd)`, `close`;
 *   5. verification read: read `target`; SHA-256 must equal SHA-256(bytes).
 *      Mismatch ⇒ a foreign writer won a race ⇒ external-change protocol
 *      (the write is NOT retried; the command fails
 *      `external_change_unresolved`).
 *
 * Steps 1–5 are retried as a whole on I/O error, up to 3 attempts total
 * with a fresh nonce. If the sequence still fails, `target` is read and
 * classified: `previous` (== the state this backend last wrote/loaded —
 * in-memory state unchanged), `new-undurable` (== the intended bytes —
 * the rename took effect but the directory flush failed; the in-memory
 * state is advanced so the running system is self-consistent), or
 * `foreign` (neither — the external-change protocol).
 *
 * `WriteOps` is a seam for controlled fault injection in tests (the
 * packet-07 persistence tests inject EACCES/EIO at specific steps); the
 * default implementation is the real filesystem. Nothing here is part of
 * the public surface (index.ts) — the service owns the protocol decisions.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { sha256Hex } from './digest';

/** The empty snapshot (a deletion is foreign bytes = empty content). */
export const EMPTY_BYTES = new Uint8Array(0);
export const EMPTY_HASH = sha256Hex(EMPTY_BYTES);

/** Max attempts of the whole W sequence (workspace.md §5.1). */
export const WRITE_MAX_ATTEMPTS = 3;

/**
 * The primitive filesystem operations W performs. The defaults are the
 * real node:fs calls; tests may substitute faulted implementations to
 * drive specific I/O errors at specific steps (controlled fault
 * injection — the rest of the sequence still runs on the real filesystem).
 */
export interface WriteOps {
  /** O_WRONLY|O_CREAT|O_EXCL at mode 0644; throws on EEXIST/EACCES/…. */
  openTempFile(path: string): number;
  /** Write all of `bytes` (handles partial writes). */
  writeAll(fd: number, bytes: Uint8Array): void;
  fsyncFile(fd: number): void;
  closeFile(fd: number): void;
  renameFile(from: string, to: string): void;
  /** open(dir, O_RDONLY) + fsync + close (the directory flush). */
  fsyncDir(dir: string): void;
  readFile(path: string): Uint8Array;
  /** Best-effort remove (never throws). */
  removeFile(path: string): void;
  fileExists(path: string): boolean;
  dirExists(path: string): boolean;
  /** List directory names (empty when absent). */
  listDir(path: string): string[];
}

const realOps: WriteOps = {
  openTempFile: (p) => openSync(p, 'wx', 0o644),
  writeAll(fd, bytes) {
    let off = 0;
    while (off < bytes.length) {
      const n = writeSync(fd, bytes.subarray(off));
      off += n;
    }
  },
  fsyncFile: (fd) => fsyncSync(fd),
  closeFile: (fd) => closeSync(fd),
  renameFile: (from, to) => renameSync(from, to),
  fsyncDir(dir) {
    const d = openSync(dir, 'r');
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  },
  readFile: (p) => readFileSync(p),
  removeFile(p) {
    try {
      unlinkSync(p);
    } catch {
      // best effort (workspace.md §5.1: residue is cleaned at the next open)
    }
  },
  fileExists(p) {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  dirExists(p) {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  listDir(p) {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

export const defaultOps: WriteOps = realOps;

/**
 * Pre-write expectation (workspace.md §5.2):
 * - `null`          — the target must not exist yet (creation's first
 *                      envelope write); an unexpected appearance is an
 *                      unexpected external modification;
 * - `[]`            — no pre-write check (ownership claim writes and
 *                      manifest writes: races are handled by the
 *                      verification re-read / reload, §6.3/§8.3);
 * - `[hash]`        — established write: the on-disk hash must equal the
 *                      last written/loaded hash;
 * - `[h1, h2]`      — resolution write (accept/discard): the on-disk hash
 *                      may equal the last known good hash OR the pending
 *                      externalHash; any other value re-fires the protocol.
 * `allowAbsent` additionally passes the check while the target is absent
 * (resolution writes over a deleted file whose external snapshot is empty).
 */
export interface WriteAtomicOptions {
  dir: string;
  target: string;
  bytes: Uint8Array;
  allowedPreHashes: string[] | null;
  /**
   * The hash of the state this backend last wrote/loaded — the
   * `previous` classification target. `null` = "previous" is "absent"
   * (the target did not exist before this write).
   */
  previousHash: string | null;
  allowAbsent?: boolean;
  ops?: WriteOps;
  /**
   * Test seam: invoked after the directory flush and before the
   * verification read (the race window where a foreign writer can replace
   * the file during this backend's own write sequence).
   */
  beforeVerifyRead?: () => void;
}

export interface WriteOutcome {
  /** Exactly one of `ok: true` / `failed` / `external` is set (a W outcome). */
  ok: boolean;
  /** The write failed before or at the durability point. */
  failed?: { onDiskState: 'previous' | 'new-undurable'; errno?: string };
  /** A foreign writer won (the on-disk value differs from the LKG). */
  external?: { bytes: Uint8Array; hash: string };
}

/** Process-unique nonce counter (workspace.md §5.1 step 1). */
let nonceCounter = 0;

function nextNonce(): number {
  nonceCounter += 1;
  return nonceCounter;
}

function errnoOf(e: unknown): string | undefined {
  const v = (e as { errno?: unknown })?.errno;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Run the full W procedure (pre-write check, up to 3 attempts of
 * temp/flush/replace/directory-flush/verify, then the failure
 * classification). Total: never throws; every outcome is classified.
 */
export function writeAtomic(opts: WriteAtomicOptions): WriteOutcome {
  const ops = opts.ops ?? defaultOps;
  const intendedHash = sha256Hex(opts.bytes);
  const target = join(opts.dir, basename(opts.target));

  // §5.2 pre-write check — immediately before step 1, before any temp file.
  //   `allowedPreHashes === null`  → the target must stay absent
  //     (creation's first envelope write); an unexpected appearance is an
  //     unexpected external modification;
  //   `allowedPreHashes.length > 0` → the on-disk hash must equal one of
  //     the allowed states (established: last written/loaded; resolution:
  //     last known good or the pending externalHash). `allowAbsent` also
  //     passes while the target is absent (a resolution write over a file
  //     a foreign writer deleted, whose snapshot is empty).
  //   `allowedPreHashes.length === 0` → no pre-write check (ownership and
  //     manifest writes: races are handled by the verification re-read /
  //     reload, §6.3/§8.3).
  let pre: Uint8Array | null = null;
  try {
    pre = ops.readFile(target);
  } catch {
    pre = null;
  }
  if (opts.allowedPreHashes === null) {
    if (pre !== null) {
      return { ok: false, external: { bytes: pre, hash: sha256Hex(pre) } };
    }
  } else if (opts.allowedPreHashes.length > 0) {
    let ok: boolean;
    if (pre === null) {
      ok = opts.allowAbsent === true;
    } else {
      const preHash = sha256Hex(pre);
      ok = opts.allowedPreHashes.includes(preHash);
    }
    if (!ok) {
      // Mismatch (or an unexpected deletion) — an unexpected external
      // modification. No temp file is written, no state changes.
      const b = pre ?? EMPTY_BYTES;
      return { ok: false, external: { bytes: b, hash: sha256Hex(b) } };
    }
  }

  let lastErrno: string | undefined;
  for (let attempt = 0; attempt < WRITE_MAX_ATTEMPTS; attempt++) {
    const nonce = nextNonce();
    const tmp = join(opts.dir, `.${basename(target)}.tmp-${process.pid}-${nonce}`);
    let fd: number | null = null;
    try {
      fd = ops.openTempFile(tmp);
      try {
        ops.writeAll(fd, opts.bytes);
        ops.fsyncFile(fd);
      } finally {
        try {
          if (fd !== null) ops.closeFile(fd);
        } catch {
          // close failure is an I/O error for the sequence below
        }
        fd = null;
      }
      ops.renameFile(tmp, target);
      ops.fsyncDir(opts.dir);
      opts.beforeVerifyRead?.();
      // Step 5 — verification read (strict: accepts only the intended bytes).
      let vbytes: Uint8Array;
      try {
        vbytes = ops.readFile(target);
      } catch (e) {
        lastErrno = errnoOf(e);
        continue; // the read failed as an I/O error — retry the sequence
      }
      const vh = sha256Hex(vbytes);
      if (vh === intendedHash) return { ok: true };
      // A foreign writer won the race (or a mid-sequence replacement).
      // NOT retried — the external-change protocol.
      return { ok: false, external: { bytes: vbytes, hash: vh } };
    } catch (e) {
      lastErrno = errnoOf(e);
      ops.removeFile(tmp); // best-effort leftover removal
    }
  }

  // Bounded retries exhausted — classify the on-disk state (workspace.md §5.1).
  let onDisk: Uint8Array | null = null;
  try {
    onDisk = ops.readFile(target);
  } catch {
    onDisk = null;
  }
  if (onDisk !== null) {
    const h = sha256Hex(onDisk);
    if (h === intendedHash) {
      // The rename took effect but step 4 failed — durability unproven.
      return { ok: false, failed: { onDiskState: 'new-undurable', errno: lastErrno } };
    }
    if (opts.previousHash !== null && h === opts.previousHash) {
      return { ok: false, failed: { onDiskState: 'previous', errno: lastErrno } };
    }
    return { ok: false, external: { bytes: onDisk, hash: h } };
  }
  // Target absent after failed attempts.
  if (opts.previousHash === null) {
    // It was absent before the write and still is — nothing changed.
    return { ok: false, failed: { onDiskState: 'previous', errno: lastErrno } };
  }
  // It existed before (the pre-check saw it) and is now gone — a foreign
  // deletion during the write: surface it as foreign bytes (empty).
  return { ok: false, external: { bytes: EMPTY_BYTES, hash: EMPTY_HASH } };
}

/** Leftover temp files of one target file (§5.4: `.main.json.tmp-*` etc.). */
export function listLeftoverTemps(dir: string, targetBase: string, ops: WriteOps = defaultOps): string[] {
  const prefix = `.${targetBase}.tmp-`;
  return ops
    .listDir(dir)
    .filter((n) => n.startsWith(prefix))
    .sort();
}

/** §5.4: delete every leftover temp file for `target` (owner only). */
export function cleanLeftoverTemps(dir: string, targetBase: string, ops: WriteOps = defaultOps): number {
  let n = 0;
  for (const name of listLeftoverTemps(dir, targetBase, ops)) {
    ops.removeFile(join(dir, name));
    n += 1;
  }
  return n;
}