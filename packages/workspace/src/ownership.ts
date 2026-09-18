/**
 * Project ownership — workspace.md §6.
 *
 * The ownership record (`.thirdlight/ownership.json`), the open-time
 * evaluation table (§6.2) with the conservative liveness rules (any `/proc`
 * ambiguity resolves to "live" — reject), the claim primitive (§6.3: the
 * only ownership write — `W` + verification re-read, concurrent claimers
 * converge to exactly one winner), and the explicit stale-owner takeover
 * procedure (§6.4 — no automatic takeover, ever).
 *
 * The record is canonical JSON (2-space, LF, trailing newline) in the key
 * order `storageVersion, state, backendId, pid, openedAt, lockEpoch`. The
 * file is never deleted (deletion would reintroduce the absent-record
 * race); release rewrites it with `state: "released"`.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseDocumentBytes } from '@thirdlight/project-model';

import { generateBackendId, sha256Hex } from './digest';
import { isPlainObject, isSafeInt, type Holder } from './errors';
import { writeAtomic, type WriteOps } from './write';

/** The ownership record storageVersion (M1). */
export const OWNERSHIP_STORAGE_VERSION = 1;

/** The default process marker: argv[0] containing it ⇒ live (workspace.md §6.2). */
export const DEFAULT_PROCESS_MARKER = 'thirdlight';
/** The default process table root (same LXC ⇒ same /proc namespace). */
export const DEFAULT_PROC_ROOT = '/proc';
/** Linux clock ticks per second (standard CONFIG_HZ on the supported platform). */
const CLK_TCK = 100;

export interface OwnershipRecord {
  storageVersion: 1;
  state: 'owned' | 'released';
  backendId: string;
  pid: number;
  openedAt: string;
  lockEpoch: number;
}

/** Current UTC second, project-model §7.2 format (`YYYY-MM-DDTHH:mm:ssZ`). */
export function utcSecond(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Recovery snapshot stamp: `YYYYMMDDTHHMMSSZ` (workspace.md §7.2). */
export function utcStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Canonical ownership record bytes (§6.1 key order, §4.4 style). */
export function buildOwnershipRecordBytes(rec: OwnershipRecord): Uint8Array {
  const doc = {
    storageVersion: OWNERSHIP_STORAGE_VERSION,
    state: rec.state,
    backendId: rec.backendId,
    pid: rec.pid,
    openedAt: rec.openedAt,
    lockEpoch: rec.lockEpoch,
  };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}

/**
 * Strict parse of an ownership record. Returns `null` for anything that is
 * not a well-formed record (missing/corrupt file, duplicate keys, wrong
 * types, unknown fields) — the caller treats that as an unreadable record
 * (conservative: reject).
 */
export function parseOwnershipRecord(bytes: Uint8Array | null): OwnershipRecord | null {
  if (bytes === null) return null;
  const p = parseDocumentBytes(bytes);
  if (!p.ok) return null;
  const root = p.value;
  if (!isPlainObject(root)) return null;
  for (const k of Object.keys(root)) {
    if (!['storageVersion', 'state', 'backendId', 'pid', 'openedAt', 'lockEpoch'].includes(k)) {
      return null;
    }
  }
  const sv = root['storageVersion'];
  if (!isSafeInt(sv) || sv !== OWNERSHIP_STORAGE_VERSION) return null;
  if (root['state'] !== 'owned' && root['state'] !== 'released') return null;
  const backendId = root['backendId'];
  if (typeof backendId !== 'string' || !/^tb-[0-9a-f]{32}$/.test(backendId)) return null;
  const pid = root['pid'];
  if (!isSafeInt(pid) || pid < 1) return null;
  const openedAt = root['openedAt'];
  if (typeof openedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(openedAt)) {
    return null;
  }
  if (Number.isNaN(Date.parse(openedAt))) return null;
  const lockEpoch = root['lockEpoch'];
  if (!isSafeInt(lockEpoch) || lockEpoch < 0) return null;
  return {
    storageVersion: OWNERSHIP_STORAGE_VERSION,
    state: root['state'],
    backendId,
    pid,
    openedAt,
    lockEpoch,
  };
}

/** Read the ownership record bytes from the project's VERIFIED
 * `.thirdlight` directory (R7: callers pass the containment-checked
 * directory — null when absent or unreadable). */
export function readOwnershipRecordBytes(
  thirdlightDir: string,
  ops: WriteOps,
): Uint8Array | null {
  const p = join(thirdlightDir, 'ownership.json');
  if (!ops.fileExists(p)) return null;
  try {
    return ops.readFile(p);
  } catch {
    return null;
  }
}

export type Liveness = 'dead' | 'live' | 'unknown';

/**
 * Conservative liveness rules (workspace.md §6.2 — ambiguity resolves to
 * "live"; a false "dead" costs split-brain risk, a false "live" costs an
 * operator check):
 * - `/proc/<pid>` absent ⇒ dead;
 * - present, but the process start time (`/proc/<pid>/stat` field 22,
 *   clock ticks since boot) is AFTER `openedAt` ⇒ pid reuse ⇒ dead;
 * - present, started before `openedAt`, and `/proc/<pid>/cmdline` argv[0]
 *   contains the configured process marker ⇒ live;
 * - present, started before `openedAt`, but the cmdline is unreadable or
 *   mismatched, or any `/proc` read error ⇒ unknown (treated as live).
 */
export function evaluateLiveness(
  pid: number,
  openedAt: string,
  procRoot: string,
  marker: string,
): Liveness {
  const statPath = join(procRoot, String(pid), 'stat');
  if (!statPathExists(statPath)) {
    // /proc/<pid> (or its stat) absent ⇒ the process is gone.
    return 'dead';
  }
  const openedAtMs = Date.parse(openedAt);
  if (Number.isNaN(openedAtMs)) return 'unknown';
  try {
    const stat = readFileSync(statPath, 'utf8');
    // Fields 1–2 are `pid (comm)`; comm may contain spaces/parens, so
    // split after the LAST ')'. Field 22 (1-based) is the start time.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const starttime = Number(rest[22 - 3]);
    if (!Number.isFinite(starttime)) return 'unknown';
    // Boot wall time from `btime` in <procRoot>/stat (the host kernel's
    // epoch boot time) — the same clock the jiffies-based `starttime`
    // counts from. (/proc/uptime and os.uptime() can be masked in
    // containers and are NOT consistent with per-process jiffies.)
    let btime: number;
    try {
      const statTxt = readFileSync(join(procRoot, 'stat'), 'utf8');
      const line = statTxt.split('\n').find((l) => l.startsWith('btime '));
      btime = line === undefined ? NaN : Number(line.trim().split(/\s+/)[1]);
    } catch {
      btime = NaN;
    }
    if (!Number.isFinite(btime)) return 'unknown'; // cannot verify ⇒ live
    const startMs = btime * 1000 + (starttime / CLK_TCK) * 1000;
    if (startMs > openedAtMs) return 'dead'; // pid reuse
  } catch {
    return 'unknown'; // any /proc read error ⇒ unknown ⇒ live
  }
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'cmdline'));
    const argv0 = raw.subarray(0, raw.indexOf(0) === -1 ? raw.length : raw.indexOf(0));
    if (new TextDecoder('utf-8', { fatal: false }).decode(argv0).includes(marker)) {
      return 'live';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown'; // cmdline mismatch ⇒ unknown ⇒ treated as live
}

function statPathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open-time evaluation (workspace.md §6.2, normative table).
 * `self` is this backend process's identity (backendId + pid).
 */
export type OwnershipEval =
  | { action: 'claim'; lockEpoch: number; reason: 'absent' | 'released' | 'own-record' }
  | { action: 'conflict'; holder: Holder | null }
  | { action: 'stale'; holder: Holder | null };

export function evaluateOwnership(
  recordBytes: Uint8Array | null,
  self: { backendId: string; pid: number },
  liveness: (pid: number, openedAt: string) => Liveness,
): OwnershipEval {
  if (recordBytes === null) return { action: 'claim', lockEpoch: 0, reason: 'absent' };
  const rec = parseOwnershipRecord(recordBytes);
  if (rec === null) {
    // Unreadable record — conservative: reject (a live foreign owner may
    // hold the project). No holder shape is available.
    return { action: 'conflict', holder: null };
  }
  if (rec.state === 'released') {
    return { action: 'claim', lockEpoch: rec.lockEpoch + 1, reason: 'released' };
  }
  // state: "owned"
  if (rec.backendId === self.backendId && rec.pid === self.pid) {
    // The same process re-opening (in-memory state was discarded). The
    // record is already this backend's claim — re-claiming is a no-op
    // (same epoch, unchanged bytes; scenario 08 pins the record
    // "unchanged" for a continuously owning backend).
    return { action: 'claim', lockEpoch: rec.lockEpoch, reason: 'own-record' };
  }
  const holder: Holder = {
    backendId: rec.backendId,
    pid: rec.pid,
    openedAt: rec.openedAt,
    lockEpoch: rec.lockEpoch,
    state: rec.state,
  };
  const lv = liveness(rec.pid, rec.openedAt);
  if (lv === 'dead') return { action: 'stale', holder };
  // live OR unknown ⇒ reject (no automatic takeover, ever).
  return { action: 'conflict', holder };
}

export interface SelfIdentity {
  backendId: string;
  pid: number;
}

/**
 * The claim primitive (workspace.md §6.3): `W(our-record, ownership.json)`
 * followed by a verification re-read — the on-disk record must contain our
 * `backendId`, `pid`, and `lockEpoch`. If another claimer renamed over us,
 * we re-read and re-evaluate that record (a live foreign owner ⇒
 * `ownership_conflict`). Bounded rounds: a racing claimer loop terminates.
 */
export type ClaimOutcome =
  | { ok: true; record: OwnershipRecord }
  | { ok: false; eval: OwnershipEval };

export function claimOwnership(
  thirdlightDir: string,
  self: SelfIdentity,
  lockEpoch: number,
  liveness: (pid: number, openedAt: string) => Liveness,
  ops: WriteOps,
  openedAt: () => string = utcSecond,
  existingBytes?: Uint8Array | null,
): ClaimOutcome {
  // Own-record re-open: the on-disk record is already exactly this
  // backend's claim (state owned, same backendId/pid/epoch) — no write,
  // no epoch advance (the record stays byte-identical).
  if (existingBytes !== undefined && existingBytes !== null) {
    const rec = parseOwnershipRecord(existingBytes);
    if (
      rec !== null &&
      rec.state === 'owned' &&
      rec.backendId === self.backendId &&
      rec.pid === self.pid &&
      rec.lockEpoch === lockEpoch
    ) {
      return { ok: true, record: rec };
    }
  }
  const recPath = join(thirdlightDir, 'ownership.json');
  const recDir = thirdlightDir;
  for (let round = 0; round < 4; round++) {
    const record: OwnershipRecord = {
      storageVersion: OWNERSHIP_STORAGE_VERSION,
      state: 'owned',
      backendId: self.backendId,
      pid: self.pid,
      openedAt: openedAt(),
      lockEpoch,
    };
    const bytes = buildOwnershipRecordBytes(record);
    const res = writeAtomic({
      dir: recDir,
      target: recPath,
      bytes,
      allowedPreHashes: [], // no pre-hash check: the verify re-read arbitrates
      previousHash: null,
      ops,
    });
    if (res.ok) {
      // Verification re-read (§6.3).
      const reread = readOwnershipRecordBytes(thirdlightDir, ops);
      const rec2 = reread === null ? null : parseOwnershipRecord(reread);
      if (
        rec2 !== null &&
        rec2.backendId === self.backendId &&
        rec2.pid === self.pid &&
        rec2.lockEpoch === lockEpoch
      ) {
        return { ok: true, record: rec2 };
      }
      // Another claimer renamed over us (or the record is unreadable):
      // re-evaluate the record now on disk.
      return { ok: false, eval: evaluateOwnership(reread, self, liveness) };
    }
    if (res.external) {
      // A foreign writer won the verification read: evaluate its record.
      return {
        ok: false,
        eval: evaluateOwnership(res.external.bytes, self, liveness),
      };
    }
    if (res.unreadable) {
      // A non-ENOENT read failure in the final classification: the
      // on-disk record bytes are UNKNOWN, never absent. Retrying the
      // claim would overwrite unknown bytes (the R1 destructive path),
      // and they must never be classified `previous`/`new-undurable`
      // either: fail closed with the same conservative conflict refusal
      // the code applies to an unreadable record (a live foreign owner
      // may hold the project). No claim, no write.
      return { ok: false, eval: { action: 'conflict', holder: null } };
    }
    // Bounded retries exhausted (write_failed).
    if (res.failed && res.failed.onDiskState === 'new-undurable') {
      // Our bytes are on disk (the rename took effect); durability of the
      // directory flush is unproven. Read back: if we own it, the running
      // system is self-consistent and we continue as owner (the gap is
      // observable at the next open); otherwise evaluate the foreign state.
      const reread = readOwnershipRecordBytes(thirdlightDir, ops);
      const rec2 = reread === null ? null : parseOwnershipRecord(reread);
      if (
        rec2 !== null &&
        rec2.backendId === self.backendId &&
        rec2.pid === self.pid &&
        rec2.lockEpoch === lockEpoch
      ) {
        return { ok: true, record: rec2 };
      }
      return { ok: false, eval: evaluateOwnership(reread, self, liveness) };
    }
    // "previous": the prior record is untouched on disk. If it still
    // supports our claim (absent/released/own-record, same epoch), retry
    // the claim; otherwise return the evaluation.
    const reread = readOwnershipRecordBytes(thirdlightDir, ops);
    const ev = evaluateOwnership(reread, self, liveness);
    if (ev.action === 'claim' && ev.lockEpoch === lockEpoch) continue;
    return { ok: false, eval: ev };
  }
  // Unreachable: the bounded loop above always returns.
  const reread = readOwnershipRecordBytes(thirdlightDir, ops);
  return { ok: false, eval: evaluateOwnership(reread, self, liveness) };
}

/**
 * Rewrite the ownership record with `state: "released"` (workspace.md §9.1)
 * — the same W + verification re-read as a claim, keeping the record's
 * identity (backendId/pid/openedAt/lockEpoch; only `state` changes). The
 * file is never deleted.
 */
export function releaseOwnership(
  thirdlightDir: string,
  current: OwnershipRecord,
  ops: WriteOps,
):
  | { ok: true }
  | {
      ok: false;
      failed: {
        external?: true;
        /** The on-disk record bytes are UNKNOWN (a non-ENOENT read failure) — never classified. */
        unreadable?: true;
        onDiskState?: 'previous' | 'new-undurable';
        errno?: string;
      };
    } {
  const recPath = join(thirdlightDir, 'ownership.json');
  const released: OwnershipRecord = { ...current, state: 'released' };
  const res = writeAtomic({
    dir: thirdlightDir,
    target: recPath,
    bytes: buildOwnershipRecordBytes(released),
    allowedPreHashes: [],
    previousHash: sha256Hex(buildOwnershipRecordBytes(current)),
    ops,
  });
  if (res.ok) return { ok: true };
  if (res.external) return { ok: false, failed: { external: true } };
  if (res.unreadable) return { ok: false, failed: { unreadable: true } };
  return { ok: false, failed: { onDiskState: res.failed?.onDiskState, errno: res.failed?.errno } };
}

/** A fresh per-backend-process identity (workspace.md §6.1). */
export function newSelfIdentity(pid: number, backendId?: string): SelfIdentity {
  return { backendId: backendId ?? generateBackendId(), pid };
}
