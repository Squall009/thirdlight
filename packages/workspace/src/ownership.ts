/**
 * Project ownership — workspace.md §6.
 *
 * The ownership record (`.thirdlight/ownership.json`), the open-time
 * evaluation table (§6.2) with the conservative liveness rules (any `/proc`
 * ambiguity resolves to "live" — reject), the claim primitive (§6.3: the
 * only ownership write — the epoch-scoped claim file `claim-<e>` is the
 * exclusive gate, created with O_CREAT|O_EXCL and serialized by the
 * kernel per path; the record is the identity/audit layer — no read or
 * re-read of it can arbitrate a claim), and the explicit stale-owner
 * takeover procedure (§6.4 — no automatic takeover, ever).
 *
 * The record is canonical JSON (2-space, LF, trailing newline) in the key
 * order `storageVersion, state, backendId, pid, openedAt, lockEpoch`. The
 * file is never deleted (deletion would reintroduce the absent-record
 * race); release rewrites it with `state: "released"`. The claim file is
 * a file, not an fd (its existence with its content is the token, held
 * for the session lifetime, §6.5); a successful claim at epoch e+1
 * unlinks `claim-e` (the superseded-epoch cleanup, §6.3).
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { parseDocumentBytes } from '@thirdlight/project-model';

import { generateBackendId, sha256Hex } from './digest';
import { isPlainObject, isSafeInt, type Holder } from './errors';
import { errnoOf, writeAtomic, type WriteOps } from './write';

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

// ---- the claim-file primitives (workspace.md §6.3) ------------------------------

/**
 * The epoch-scoped claim file name (workspace.md §6.3): `claim-<e>` in the
 * project's `.thirdlight` directory, one per `lockEpoch` e. The exclusive
 * gate: it is created with O_CREAT|O_EXCL and is serialized by the kernel
 * per path — the ONLY exclusion gate (liveness is reporting and
 * classification only, §6.2; the record is the identity/audit layer and
 * no read or re-read of it can arbitrate a claim).
 */
export function claimFileName(lockEpoch: number): string {
  return `claim-${lockEpoch}`;
}

/** The claim file's identity stamp (workspace.md §6.3 step 2). */
export interface ClaimStamp {
  backendId: string;
  pid: number;
  /** The UTC second at which the stamp was written (the record's style). */
  openedAt: string;
}

/** Canonical claim-stamp bytes (2-space, LF, trailing newline — the record's style). */
export function buildClaimStampBytes(stamp: ClaimStamp): Uint8Array {
  const doc = { backendId: stamp.backendId, pid: stamp.pid, openedAt: stamp.openedAt };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}

/**
 * Strict parse of a claim-file stamp. `null` for anything that is not a
 * well-formed stamp (empty/partial file, duplicate keys, wrong types,
 * unknown fields) — the caller treats that as unparseable (the
 * orphan-recovery rule refuses to reclaim; the verification steps fail
 * the claim). The holder content carried by `claim_inconsistent` is this
 * parsed shape ("the holder content if parseable", §11).
 */
export function parseClaimStamp(bytes: Uint8Array): ClaimStamp | null {
  const p = parseDocumentBytes(bytes);
  if (!p.ok) return null;
  const root = p.value;
  if (!isPlainObject(root)) return null;
  for (const k of Object.keys(root)) {
    if (!['backendId', 'pid', 'openedAt'].includes(k)) return null;
  }
  const backendId = root['backendId'];
  if (typeof backendId !== 'string' || !/^tb-[0-9a-f]{32}$/.test(backendId)) return null;
  const pid = root['pid'];
  if (!isSafeInt(pid) || pid < 1) return null;
  const openedAt = root['openedAt'];
  if (typeof openedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(openedAt)) {
    return null;
  }
  if (Number.isNaN(Date.parse(openedAt))) return null;
  return { backendId, pid, openedAt };
}

/** Read + strict-parse a claim file by path (null: missing/unreadable/unparseable). */
function readClaimStamp(path: string, ops: WriteOps): ClaimStamp | null {
  try {
    return parseClaimStamp(ops.readFile(path));
  } catch {
    return null;
  }
}

/**
 * Read the ownership record discriminating ABSENCE (ENOENT — the only
 * read result that means absence) from an unreadable record (a non-ENOENT
 * read failure: the on-disk bytes are UNKNOWN, never absent —
 * workspace.md §6.2/§6.3). The §6.3 step-1 EEXIST re-read must never
 * treat an unreadable record as absent.
 */
type RecordRead =
  | { kind: 'absent' }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'unreadable'; errno?: string };

function readRecord(thirdlightDir: string, ops: WriteOps): RecordRead {
  try {
    return { kind: 'bytes', bytes: ops.readFile(join(thirdlightDir, 'ownership.json')) };
  } catch (e) {
    const en = errnoOf(e);
    return en === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable', ...(en === undefined ? {} : { errno: en }) };
  }
}

export interface SelfIdentity {
  backendId: string;
  pid: number;
}

/**
 * The claim failure the orphan-recovery rule cannot resolve
 * (workspace.md §6.3/§11): the claim file exists at the target epoch but
 * cannot be reclaimed — its content is unparseable/unreadable, or its
 * holder's pid is not proven dead under the §6.2 liveness rules (unknown
 * ⇒ live ⇒ refuse). `holderContent` is the parsed stamp (null when the
 * content is unparseable/unreadable); `liveness` is the holder's §6.2
 * liveness outcome (null when the content is unparseable/unreadable).
 * Nothing is claimed; the operator confirms the holder is dead, removes
 * the orphan claim file, and re-issues the open (an operator file
 * operation — no backend command).
 */
export interface ClaimInconsistentInfo {
  /** The absolute path of the stuck claim file. */
  claimFile: string;
  holderContent: ClaimStamp | null;
  liveness: Liveness | null;
}

export type ClaimOutcome =
  | { ok: true; record: OwnershipRecord }
  | { ok: false; eval: OwnershipEval }
  | { ok: false; inconsistent: ClaimInconsistentInfo };

export interface ClaimOptions {
  /** The project's VERIFIED `.thirdlight` directory. */
  thirdlightDir: string;
  self: SelfIdentity;
  /** The target `lockEpoch` e: the claim file `claim-e` gates this claim. */
  lockEpoch: number;
  liveness: (pid: number, openedAt: string) => Liveness;
  ops: WriteOps;
  /**
   * The record bytes the caller evaluated to authorize this claim at
   * `lockEpoch` (null when the record was absent): the record W's
   * `previousHash` classification target (workspace.md §6.3 step 4 — the
   * absent-record and stale-record cases: "previous" is the state the
   * claim was evaluated against, never fabricated).
   */
  previousRecord?: Uint8Array | null;
  openedAt?: () => string;
  /**
   * Test seam: the exclusive claim-file open (workspace.md §6.3 step 1 —
   * `O_CREAT|O_EXCL`; on Node `fs.open(path, 'wx', 0o644)` — the same
   * primitive `openTempFile` uses). Default: the real open through the
   * `ops.openTempFile` primitive. Documented as a test seam exactly like
   * `beforeVerifyRead`: the interleaving tests gate it (here, or through
   * an `ops.openTempFile` override) to drive deterministic claimant
   * schedules.
   */
  openClaimFile?: (path: string) => number;
}

/**
 * The orphan-recovery rule (workspace.md §6.3 — the ONLY
 * liveness-referenced path, normative): step 1 failed EEXIST and the
 * record is absent/released/older-epoch — or unreadable (never treated as
 * absence). The existing claim-e's content is read: the claimant may
 * proceed (**reclaim**: rewrite claim-e with its own step-2 identity,
 * fsync, and continue at step 4 — steps 5–6 then apply unchanged) **only**
 * if the content is parseable and its holder pid is proven dead under the
 * §6.2 liveness rules (unknown ⇒ live ⇒ refuse). Otherwise the claim fails
 * with `claim_inconsistent` (holder null; carries the claim file path, the
 * holder content if parseable, and the liveness outcome). This path
 * consults liveness to reclaim a *crashed* claimant's file; it is not a
 * safety gate: concurrent claimers are serialized by `O_EXCL` alone, and a
 * live holder's file is never removed or rewritten by any backend path.
 */
type OrphanRecovery = { kind: 'reclaim' } | { kind: 'outcome'; outcome: ClaimOutcome };

function orphanRecovery(
  claimPath: string,
  liveness: (pid: number, openedAt: string) => Liveness,
  ops: WriteOps,
): OrphanRecovery {
  let bytes: Uint8Array | null = null;
  let readOk = false;
  try {
    bytes = ops.readFile(claimPath);
    readOk = true;
  } catch {
    // A non-ENOENT read failure (EACCES, …) or a vanished file: the
    // content is unknown — never treated as absence.
  }
  if (!readOk || bytes === null) {
    return {
      kind: 'outcome',
      outcome: { ok: false, inconsistent: { claimFile: claimPath, holderContent: null, liveness: null } },
    };
  }
  const stamp = parseClaimStamp(bytes);
  if (stamp === null) {
    return {
      kind: 'outcome',
      outcome: { ok: false, inconsistent: { claimFile: claimPath, holderContent: null, liveness: null } },
    };
  }
  const lv = liveness(stamp.pid, stamp.openedAt);
  if (lv !== 'dead') {
    // live/unknown ⇒ refuse (a false "live" can only delay or block a
    // reclaim — operator-visible via claim_inconsistent — never create a
    // second active writer).
    return {
      kind: 'outcome',
      outcome: { ok: false, inconsistent: { claimFile: claimPath, holderContent: stamp, liveness: lv } },
    };
  }
  return { kind: 'reclaim' };
}

/**
 * Steps 5–6 of the claim primitive (workspace.md §6.3): the on-disk record
 * must contain our `backendId`, `pid`, and `lockEpoch` (consistency: the
 * re-read record's epoch must be e — any other epoch ⇒ the record was
 * changed outside the protocol), and the on-disk claim-e must contain our
 * step-2 identity (`backendId` + `pid` + timestamp match). Returns the
 * re-read record on success, `null` on any mismatch (a foreign actor
 * unlinked/recreated or overwrote one of the files between our `O_EXCL` and
 * this read).
 */
function verifyClaimedFiles(
  thirdlightDir: string,
  claimPath: string,
  self: SelfIdentity,
  stampTs: string,
  lockEpoch: number,
  ops: WriteOps,
): OwnershipRecord | null {
  const r = readRecord(thirdlightDir, ops);
  if (r.kind !== 'bytes') return null; // absent/unreadable: a mismatch
  const rec = parseOwnershipRecord(r.bytes);
  if (rec === null) return null;
  if (rec.backendId !== self.backendId || rec.pid !== self.pid || rec.lockEpoch !== lockEpoch) {
    return null;
  }
  const stamp = readClaimStamp(claimPath, ops);
  if (
    stamp === null ||
    stamp.backendId !== self.backendId ||
    stamp.pid !== self.pid ||
    stamp.openedAt !== stampTs
  ) {
    return null;
  }
  return rec;
}

/**
 * The claim primitive (workspace.md §6.3 — the only ownership write): the
 * exclusive gate is the epoch-scoped claim file `claim-e`, created with
 * `O_CREAT|O_EXCL` (step 1 — serialized by the kernel per path; at most
 * one caller succeeds; liveness never arbitrates). The six-step sequence:
 *
 *   1. acquire the claim file; on failure (EEXIST or any open failure) —
 *      no retry loop — re-read the record and re-evaluate per the §6.2
 *      table rows: owned+live ⇒ `ownership_conflict` (the holder); owned+
 *      dead ⇒ `stale_ownership` (the holder; the §6.4 takeover path —
 *      explicit only); absent/released/older-epoch/unreadable ⇒ the
 *      orphan-recovery rule (reclaim a proven-dead holder's file, or
 *      `claim_inconsistent`); a non-ENOENT record read failure is never
 *      treated as absence;
 *   2. stamp the claim file durably (our identity + fsync);
 *   3. pre-record verification — the claim file by path (foreign/
 *      unparseable/missing ⇒ `ownership_conflict`, holder null, NO record
 *      is written — the session does not serve);
 *   4. write the record (state `owned`, our `backendId`/`pid`/`openedAt`,
 *      `lockEpoch` e) via the durable `W`;
 *   5. verification re-read — the record AND the claim file (any foreign
 *      content ⇒ `ownership_conflict` — the claim aborts; the session does
 *      not serve);
 *   6. consistency (the re-read record's `lockEpoch` must be e).
 *
 * **Self-reclaim (§6.2 row, normative):** if the on-disk record is already
 * exactly ours (state `owned`, same `backendId` + `pid`, same epoch) ⇒ do
 * NOT re-run `O_CREAT|O_EXCL` against our own claim file (it would fail
 * EEXIST against ourselves); re-verify the claim file content matches our
 * identity (`backendId` + `pid`); matching ⇒ proceed to serve (the record
 * is byte-identical, no write); missing/foreign ⇒ `ownership_conflict`
 * (holder `null`), refuse to serve.
 *
 * **Superseded-epoch cleanup (§6.3, normative):** a successful claim at
 * epoch e+1 unlinks `claim-e` best-effort AFTER its own record W is
 * durable; a failed/unproven claim never unlinks a file that is not its
 * own. The safety argument: a claim at e+1 occurs only against a record at
 * e that is `released` or stale (dead holder) — in both cases the session
 * that created `claim-e` is no longer an active writer (a released session
 * must not serve; a dead pid cannot), so its deletion excludes no live
 * writer. A failed unlink leaves inert residue: the epoch is monotonic, so
 * no future claim ever targets `claim-e` again.
 */
export function claimOwnership(opts: ClaimOptions): ClaimOutcome {
  const { thirdlightDir, self, lockEpoch, liveness, ops } = opts;
  const now = opts.openedAt ?? utcSecond;
  const openClaim = opts.openClaimFile ?? ((p: string): number => ops.openTempFile(p));
  const recPath = join(thirdlightDir, 'ownership.json');
  const claimPath = join(thirdlightDir, claimFileName(lockEpoch));

  // ---- self-reclaim (workspace.md §6.2 row, normative) ----------------
  // The on-disk record is already exactly ours (owned, same backendId +
  // pid, same epoch): do NOT re-run O_CREAT|O_EXCL against our own claim
  // file (it would EEXIST against ourselves). Re-verify the claim file
  // content matches our identity; matching ⇒ proceed to serve (the record
  // is byte-identical, no write); missing/foreign ⇒ ownership_conflict
  // (holder null), refuse to serve.
  const selfRead = readRecord(thirdlightDir, ops);
  if (selfRead.kind === 'bytes') {
    const selfRec = parseOwnershipRecord(selfRead.bytes);
    if (
      selfRec !== null &&
      selfRec.state === 'owned' &&
      selfRec.backendId === self.backendId &&
      selfRec.pid === self.pid &&
      selfRec.lockEpoch === lockEpoch
    ) {
      const stamp = readClaimStamp(claimPath, ops);
      if (stamp !== null && stamp.backendId === self.backendId && stamp.pid === self.pid) {
        return { ok: true, record: selfRec };
      }
      return { ok: false, eval: { action: 'conflict', holder: null } };
    }
  }

  // ---- step 1: acquire the claim file (O_CREAT|O_EXCL) ----------------
  const stampTs = now();
  const stampBytes = buildClaimStampBytes({ backendId: self.backendId, pid: self.pid, openedAt: stampTs });
  let reclaimed = false;
  let fd: number | null = null;
  try {
    fd = openClaim(claimPath);
  } catch {
    // EEXIST (or any open failure): a different claimer holds epoch e.
    // Re-read the record and re-evaluate per the §6.2 table rows. There
    // is no retry loop.
    const r = readRecord(thirdlightDir, ops);
    if (r.kind === 'bytes') {
      const rec = parseOwnershipRecord(r.bytes);
      if (rec !== null) {
        if (rec.state === 'owned') {
          if (rec.backendId === self.backendId && rec.pid === self.pid) {
            if (rec.lockEpoch === lockEpoch) {
              // The self-reclaim row applies (the record is exactly ours
              // at our target epoch): re-verify the claim file content.
              const stamp = readClaimStamp(claimPath, ops);
              if (stamp !== null && stamp.backendId === self.backendId && stamp.pid === self.pid) {
                return { ok: true, record: rec };
              }
              return { ok: false, eval: { action: 'conflict', holder: null } };
            }
            // Ours but at a different epoch: the state moved under our
            // target — re-evaluate from scratch (the caller's bounded
            // loop re-claims at the record's epoch).
            return { ok: false, eval: { action: 'claim', lockEpoch: rec.lockEpoch, reason: 'own-record' } };
          }
          const holder: Holder = {
            backendId: rec.backendId,
            pid: rec.pid,
            openedAt: rec.openedAt,
            lockEpoch: rec.lockEpoch,
            state: 'owned',
          };
          // owned + live ⇒ ownership_conflict; owned + dead ⇒
          // stale_ownership (the §6.4 takeover path — explicit only, no
          // automatic takeover, ever); unknown ⇒ treated as live (reject;
          // the operator investigates).
          const lv = liveness(rec.pid, rec.openedAt);
          return { ok: false, eval: { action: lv === 'dead' ? 'stale' : 'conflict', holder } };
        }
        // released@k:
        if (rec.lockEpoch + 1 === lockEpoch) {
          // The record supports our target epoch: the EEXIST means a rival
          // holds claim-(k+1) — the orphan-recovery rule decides (reclaim
          // a proven-dead holder's file, or claim_inconsistent).
          const orphan = orphanRecovery(claimPath, liveness, ops);
          if (orphan.kind === 'reclaim') {
            reclaimed = true;
          } else {
            return orphan.outcome;
          }
        } else {
          // The record moved (released at a different epoch): re-evaluate
          // from scratch.
          return { ok: false, eval: { action: 'claim', lockEpoch: rec.lockEpoch + 1, reason: 'released' } };
        }
      }
    }
    // absent / unreadable / corrupt: the record's state is unknown or
    // supports a fresh claim at our target — a non-ENOENT record read
    // failure is NEVER treated as absence. The §6.3 orphan-recovery rule
    // (which requires parseable claim-file content and a proven-dead
    // holder) applies, or the claim fails claim_inconsistent.
    const orphan = orphanRecovery(claimPath, liveness, ops);
    if (orphan.kind === 'reclaim') {
      reclaimed = true;
    } else {
      return orphan.outcome;
    }
  }

  if (fd !== null) {
    // ---- step 2: stamp the claim file (durable) -----------------------
    // A crash before this step leaves an empty claim file (orphan, §6.3).
    let seqError: unknown = null;
    try {
      ops.writeAll(fd, stampBytes);
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
    if (seqError !== null) {
      // Step-2 failure: the claim fails (the claimant holds no ownership;
      // the claim file may hold a partial/empty stamp — the next open
      // re-enters via the orphan-recovery rule: unparseable ⇒
      // claim_inconsistent until the operator removes the file).
      return { ok: false, eval: { action: 'conflict', holder: null } };
    }
    // ---- step 3: pre-record verification — claim file, by path --------
    const check = readClaimStamp(claimPath, ops);
    if (
      check === null ||
      check.backendId !== self.backendId ||
      check.pid !== self.pid ||
      check.openedAt !== stampTs
    ) {
      // Foreign / unparseable / missing content ⇒ the claim fails with
      // ownership_conflict and NO record is written (abort; the session
      // does not serve).
      return { ok: false, eval: { action: 'conflict', holder: null } };
    }
  } else {
    // Reclaim (the orphan-recovery rule): rewrite claim-e with our step-2
    // identity, fsync, and continue at step 4 (workspace.md §6.3 — steps
    // 5–6 then apply unchanged). The rewrite uses the real node:fs: the
    // WriteOps seam exposes no truncate-open primitive, and the claim-file
    // read/absence paths (fileExists/readFile) still go through `ops`.
    try {
      const rfd = openSync(claimPath, 'w', 0o644);
      try {
        let off = 0;
        while (off < stampBytes.length) {
          off += writeSync(rfd, stampBytes.subarray(off));
        }
        fsyncSync(rfd);
      } finally {
        closeSync(rfd);
      }
    } catch {
      // The rewrite failed: the claim fails (the claimant holds no
      // ownership; the dead holder's file remains on disk and is
      // re-evaluated at the next open).
      return { ok: false, eval: { action: 'conflict', holder: null } };
    }
  }

  // ---- step 4: write the record ----------------------------------------
  const record: OwnershipRecord = {
    storageVersion: OWNERSHIP_STORAGE_VERSION,
    state: 'owned',
    backendId: self.backendId,
    pid: self.pid,
    openedAt: stampTs,
    lockEpoch,
  };
  const res = writeAtomic({
    dir: thirdlightDir,
    target: recPath,
    bytes: buildOwnershipRecordBytes(record),
    allowedPreHashes: [], // no pre-write check: the O_EXCL claim file is the gate; the verification re-read arbitrates (§6.3)
    previousHash:
      opts.previousRecord === null || opts.previousRecord === undefined
        ? null
        : sha256Hex(opts.previousRecord),
    ops,
  });

  if (res.ok || (res.failed !== undefined && res.failed.onDiskState === 'new-undurable')) {
    // The rename took effect (durability proven by `ok`, or unproven by
    // `new-undurable` — the step-5 re-read decides both):
    // ---- steps 5–6: verification re-read (both files) + consistency ----
    const v = verifyClaimedFiles(thirdlightDir, claimPath, self, stampTs, lockEpoch, ops);
    if (v !== null) {
      // Superseded-epoch cleanup (workspace.md §6.3, normative): a
      // successful claim at epoch e unlinks claim-(e-1) best-effort AFTER
      // its own record W is durable. Safe: the session that created
      // claim-(e-1) is no longer an active writer (a released session
      // must not serve; a dead pid cannot), so its deletion excludes no
      // live writer. A failed unlink leaves inert residue (the epoch is
      // monotonic — no future claim ever targets it). A failed/unproven
      // claim never unlinks a file that is not its own (only this
      // successful path unlinks).
      if (lockEpoch > 0) {
        ops.removeFile(join(thirdlightDir, claimFileName(lockEpoch - 1)));
      }
      return { ok: true, record: v };
    }
    // A foreign actor unlinked/recreated or overwrote one of the files
    // between our O_EXCL and this read ⇒ the claim fails with
    // ownership_conflict (holder null) and the session does not serve.
    // The claim file is left on disk — recovered by the orphan-recovery
    // rule or the next epoch's superseded-epoch cleanup (the residual
    // `record@e` + foreign `claim-e` state resolves via the §6.2 liveness
    // path; the envelope is untouched).
    return { ok: false, eval: { action: 'conflict', holder: null } };
  }
  if (res.unreadable !== undefined) {
    // A non-ENOENT read failure: the on-disk record bytes are UNKNOWN,
    // never absent — fail closed (no claim, no serving; a live foreign
    // owner may hold the project). No retry would overwrite unknown
    // bytes.
    return { ok: false, eval: { action: 'conflict', holder: null } };
  }
  if (res.external !== undefined) {
    // A foreign writer won (the on-disk value differs from our record):
    // re-read and re-evaluate per the §6.2 table rows (the winner's record
    // is owned+live ⇒ conflict, owned+dead ⇒ stale, or a moved state the
    // caller's bounded loop re-claims).
    return { ok: false, eval: evaluateOwnership(res.external.bytes, self, liveness) };
  }
  // res.failed 'previous': the on-disk state is the previous (unchanged):
  // re-read and re-evaluate; the caller's bounded loop retries while the
  // record still supports this claim at this epoch.
  const prev = readRecord(thirdlightDir, ops);
  if (prev.kind === 'bytes') {
    return { ok: false, eval: evaluateOwnership(prev.bytes, self, liveness) };
  }
  // The record is absent/unreadable after a failed W: the state is unknown
  // — fail closed.
  return { ok: false, eval: { action: 'conflict', holder: null } };
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
