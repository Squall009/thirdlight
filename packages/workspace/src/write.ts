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
 * The §5.2 pre-write check is the first statement of EVERY attempt (the
 * immediately-preceding-check guarantee is per attempt, not once before
 * the loop): a retry re-reads the target before touching it. The
 * per-attempt allowed set is `allowedPreHashes` PLUS the intended hash —
 * the known intermediate state where a previous attempt of this W already
 * installed its own intended bytes (its rename succeeded before its
 * directory flush/verification failed); retrying must not flag the
 * backend's own bytes as foreign.
 *
 * A read failure other than ENOENT means the bytes are UNKNOWN, never
 * absent (workspace.md §7.2 step 1): the pre-write check and the final
 * classification both fail closed with the `unreadable` outcome — never
 * a zero-byte/fabricated snapshot, never a `previous`/`new-undurable`
 * misclassification. A close failure aborts the attempt (the sequence
 * never reaches rename with a possibly-reused fd) and records its errno
 * only when no earlier failure of the same attempt was recorded (a close
 * error never masks an earlier write/fsync errno).
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
  /**
   * Test seam: invoked after a FAILED attempt completes (leftover temp
   * removed) and before the next attempt's re-check — the window where a
   * foreign writer can replace the target between this backend's own
   * failed attempts (documented as a test seam exactly like
   * `beforeVerifyRead`). `attempt` is the 1-based number of the failed
   * attempt.
   */
  betweenAttempts?: (attempt: number) => void;
}

export interface WriteOutcome {
  /** Exactly one of `ok: true` / `failed` / `external` / `unreadable` is set (a W outcome). */
  ok: boolean;
  /** The write failed before or at the durability point. */
  failed?: { onDiskState: 'previous' | 'new-undurable'; errno?: string };
  /** A foreign writer won (the on-disk value differs from the LKG). */
  external?: { bytes: Uint8Array; hash: string };
  /**
   * The on-disk bytes are UNKNOWN (a non-ENOENT read failure in the
   * pre-write check or the final classification): never absent, never
   * fabricated (workspace.md §7.2 step 1). No other outcome may be
   * produced from an unreadable read.
   */
  unreadable?: { errno?: string };
}

/** Process-unique nonce counter (workspace.md §5.1 step 1). */
let nonceCounter = 0;

function nextNonce(): number {
  nonceCounter += 1;
  return nonceCounter;
}

/**
 * The errno name of a thrown error, when determinable. Node's real fs
 * errors carry the string name on `code` and the NUMERIC errno on `errno`
 * (`-2` = ENOENT — `errno` is a number, not a string, on Node ≥ 20);
 * fault-injected seam errors may carry a string `errno` directly. The name
 * is the only thing the §5.2/§7.2 ENOENT-vs-unknown distinction keys on,
 * so it is resolved: `code` (string) → `errno` (string) → `errno`
 * (number, via the small table below) → undefined.
 */
const NUMERIC_ERRNO: Record<number, string> = {
  [-1]: 'EPERM',
  [-2]: 'ENOENT',
  [-4]: 'EINTR',
  [-5]: 'EIO',
  [-6]: 'ENXIO',
  [-7]: 'E2BIG',
  [-9]: 'EBADF',
  [-11]: 'EAGAIN',
  [-12]: 'ENOMEM',
  [-13]: 'EACCES',
  [-14]: 'EFAULT',
  [-16]: 'EBUSY',
  [-17]: 'EEXIST',
  [-20]: 'ENOTDIR',
  [-21]: 'EISDIR',
  [-22]: 'EINVAL',
  [-24]: 'EMFILE',
  [-27]: 'EFBIG',
  [-28]: 'ENOSPC',
  [-30]: 'EROFS',
  [-36]: 'ENAMETOOLONG',
  [-40]: 'EPIPE',
  [-62]: 'ELOOP',
  [-122]: 'EDQUOT',
};

export function errnoOf(e: unknown): string | undefined {
  const v = e as { code?: unknown; errno?: unknown } | null;
  const code = v?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  const errno = v?.errno;
  if (typeof errno === 'string' && errno.length > 0) return errno;
  if (typeof errno === 'number') return NUMERIC_ERRNO[errno];
  return undefined;
}

/** The outcome of one §5.2 pre-write check (per attempt). */
type PreCheck =
  | { kind: 'proceed' }
  | { kind: 'external'; bytes: Uint8Array; hash: string }
  | { kind: 'unreadable'; errno?: string };

/**
 * §5.2 pre-write check — the first statement of EVERY W attempt, before
 * any temp file (the immediately-preceding-check guarantee):
 * - `allowedPreHashes === null`  → creation semantics: the target must
 *   stay absent; an appearance is evaluated against the allowed set below
 *   (an unexpected appearance is an unexpected external modification);
 * - `allowedPreHashes.length > 0` → the on-disk hash must equal one of the
 *   allowed states (established: last written/loaded; resolution: last
 *   known good or the pending externalHash). `allowAbsent` also passes
 *   while the target is absent (a resolution write over a file a foreign
 *   writer deleted, whose snapshot is empty). Absence without `allowAbsent`
 *   is a foreign deletion — surfaced as empty foreign bytes (the existing
 *   semantics); ENOENT is the only read result that means absence;
 * - `allowedPreHashes.length === 0` → no pre-write check (ownership and
 *   manifest writes: races are handled by the verification re-read /
 *   reload, §6.3/§8.3) — the write proceeds unconditionally.
 *
 * Per-attempt allowed set: `allowedPreHashes` PLUS the intended hash —
 * the known intermediate state where a PREVIOUS attempt of this W already
 * installed its own intended bytes (its rename succeeded before its
 * directory flush/verification failed); retrying must not flag the
 * backend's own bytes as foreign. A read failure other than ENOENT means
 * the bytes are UNKNOWN, never absent (workspace.md §7.2 step 1) — the
 * check returns `unreadable` and no other outcome may be produced from
 * it (no zero-byte "foreign" snapshot, no absence assumption).
 */
function preWriteCheck(
  ops: WriteOps,
  target: string,
  opts: WriteAtomicOptions,
  intendedHash: string,
): PreCheck {
  // No pre-write check (ownership/manifest writes): proceed unconditionally.
  if (opts.allowedPreHashes !== null && opts.allowedPreHashes.length === 0) {
    return { kind: 'proceed' };
  }
  const allowed: readonly string[] =
    opts.allowedPreHashes === null
      ? [intendedHash]
      : opts.allowedPreHashes.includes(intendedHash)
        ? opts.allowedPreHashes
        : [...opts.allowedPreHashes, intendedHash];
  try {
    const b = ops.readFile(target);
    const preHash = sha256Hex(b);
    if (allowed.includes(preHash)) return { kind: 'proceed' };
    // Mismatch (or an unexpected appearance): an unexpected external
    // modification — the REAL bytes are surfaced (never fabricated).
    return { kind: 'external', bytes: b, hash: preHash };
  } catch (e) {
    const en = errnoOf(e);
    if (en !== 'ENOENT') {
      // A non-ENOENT read failure: the bytes are UNKNOWN, never absent.
      // Fail closed — no other outcome may be produced from this read.
      return { kind: 'unreadable', ...(en === undefined ? {} : { errno: en }) };
    }
    // ENOENT — absence (the only read result that means absence):
    // creation semantics are satisfied; established/resolution writes pass
    // only with `allowAbsent` — otherwise a foreign deletion is surfaced
    // as empty foreign bytes (the pre-existing semantics).
    if (opts.allowedPreHashes === null || opts.allowAbsent === true) {
      return { kind: 'proceed' };
    }
    return { kind: 'external', bytes: EMPTY_BYTES, hash: EMPTY_HASH };
  }
}

/**
 * Run the full W procedure (per-attempt pre-write check, up to 3 attempts
 * of temp/flush/replace/directory-flush/verify, then the failure
 * classification). Total: never throws; every outcome is classified.
 */
export function writeAtomic(opts: WriteAtomicOptions): WriteOutcome {
  const ops = opts.ops ?? defaultOps;
  const intendedHash = sha256Hex(opts.bytes);
  const target = join(opts.dir, basename(opts.target));

  let lastErrno: string | undefined;
  for (let attempt = 0; attempt < WRITE_MAX_ATTEMPTS; attempt++) {
    // §5.2 pre-write check — the first statement of EVERY attempt,
    // immediately before step 1 and before any temp file: the hash check
    // runs before every attempt, not once before the loop. A failed
    // attempt's retry re-reads the target it is about to overwrite.
    const pre = preWriteCheck(ops, target, opts, intendedHash);
    if (pre.kind === 'external') {
      // A readable foreign state (or a foreign deletion / appearance):
      // an unexpected external modification. No temp file is written, no
      // state changes; the real bytes are surfaced.
      return { ok: false, external: { bytes: pre.bytes, hash: pre.hash } };
    }
    if (pre.kind === 'unreadable') {
      // A non-ENOENT read failure: the bytes are UNKNOWN, never absent —
      // fail closed (workspace.md §7.2 step 1).
      return { ok: false, unreadable: pre.errno === undefined ? {} : { errno: pre.errno } };
    }

    const nonce = nextNonce();
    const tmp = join(opts.dir, `.${basename(target)}.tmp-${process.pid}-${nonce}`);
    let fd: number | null = null;
    try {
      fd = ops.openTempFile(tmp);
      // Step 2 — write all bytes; fsync; close. A CLOSE FAILURE ABORTS
      // THE ATTEMPT (workspace.md §5.1 step 2): the sequence never reaches
      // rename with a possibly-unclosed (or possibly-reused) fd. The FIRST
      // failure of the attempt wins: a close error never masks an earlier
      // write/fsync errno.
      let seqError: unknown = null;
      try {
        ops.writeAll(fd, opts.bytes);
        ops.fsyncFile(fd);
      } catch (e) {
        seqError = e;
      }
      try {
        ops.closeFile(fd);
      } catch (e) {
        if (seqError === null) seqError = e;
      }
      fd = null;
      if (seqError !== null) throw seqError;
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
    // Test seam: after a FAILED attempt completes (leftover removed) and
    // before the next attempt's re-check (a retry uses a NEW temp file +
    // nonce — never the possibly-reused fd of the failed attempt).
    if (attempt + 1 < WRITE_MAX_ATTEMPTS) opts.betweenAttempts?.(attempt + 1);
  }

  // Bounded retries exhausted — classify the on-disk state (workspace.md §5.1).
  let onDisk: Uint8Array | null = null;
  try {
    onDisk = ops.readFile(target);
  } catch (e) {
    const en = errnoOf(e);
    if (en !== 'ENOENT') {
      // A non-ENOENT read failure: the bytes are UNKNOWN, never absent —
      // never a `previous`/`new-undurable` misclassification (workspace.md
      // §7.2 step 1; nothing was read, so nothing is fabricated).
      return { ok: false, unreadable: en === undefined ? {} : { errno: en } };
    }
    // ENOENT: absence — the existing absent classification below.
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