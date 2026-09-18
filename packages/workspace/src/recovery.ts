/**
 * Recovery snapshots of external/foreign bytes — workspace.md §7.2/§7.4.
 *
 * Any on-disk content the backend did not write is SHA-256-snapshotted
 * byte-for-byte to `.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json`
 * (`UTCstamp = YYYYMMDDTHHMMSSZ`, `sha8` = first 8 hex of the hash) BEFORE
 * the project pauses. Snapshots are evidence + a repair aid, never a
 * backup: never read automatically, never deleted except by the 16-oldest
 * pruning. The original file is left in place until an operator resolves.
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { utcStamp } from './ownership';
import { sha256Hex } from './digest';
import { defaultOps, writeAtomic, type WriteOps } from './write';

/** At most 16 recovery snapshots are kept; the oldest are pruned. */
export const RECOVERY_MAX = 16;
const SNAPSHOT_PREFIX = 'scene-';

function ensureDir(dir: string, ops: WriteOps): void {
  if (!ops.dirExists(dir)) {
    try {
      mkdirSync(dir, { mode: 0o755 });
    } catch (e) {
      // EEXIST (concurrent creation) is fine; anything else re-raises so
      // the caller's bounded-retry logic sees a real I/O error.
      if ((e as { errno?: unknown })?.errno !== 'EEXIST') throw e;
    }
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best effort (umask may have already produced the intended mode)
    }
  }
}

/**
 * Snapshot foreign bytes (byte-for-byte) and prune to the newest 16 (the
 * just-written snapshot is the §7.4 exempt one). Returns the snapshot file
 * name (basename) actually written, or `null` when the snapshot could not
 * be durably written. A `null` result is the §7.2 step-2 failure state —
 * it is NEVER silent: the caller (`detectExternalChange`) records the
 * pending change with `snapshotState: "snapshot_failed"` (the fail-closed
 * `paused-snapshot-failed` pause: the triggering command fails
 * `external_change_unresolved` with that state, and the operator
 * resolutions are refused with `external_change_evidence_missing` until a
 * durable snapshot exists, workspace.md §7.2/§7.3/§11).
 */
export function snapshotForeignBytes(
  thirdlightDir: string,
  bytes: Uint8Array,
  ops: WriteOps,
  stamp: () => string = utcStamp,
): string | null {
  // R7: the caller passes the project's VERIFIED `.thirdlight` directory
  // (containment-checked at open) — no re-join from the raw project id.
  const recoveryDir = join(thirdlightDir, 'recovery');
  try {
    ensureDir(thirdlightDir, ops);
    ensureDir(recoveryDir, ops);
  } catch {
    return null;
  }
  const hash = sha256Hex(bytes);
  const st = stamp();
  const base = `${SNAPSHOT_PREFIX}${st}-${hash.slice(0, 8)}.json`;
  // A same-second, same-content snapshot is identical — reuse the name.
  // A same-second name collision with DIFFERENT content (first-8-hex
  // collision; astronomically rare) gets a numeric suffix: evidence is
  // never overwritten.
  let name = base;
  let suffix = 2;
  for (;;) {
    const path = join(recoveryDir, name);
    if (!ops.fileExists(path)) break;
    let existing: Uint8Array | null = null;
    try {
      existing = ops.readFile(path);
    } catch {
      existing = null;
    }
    if (existing !== null && existing.length === bytes.length) {
      let same = true;
      for (let i = 0; i < existing.length; i++) {
        if (existing[i] !== bytes[i]) {
          same = false;
          break;
        }
      }
      if (same) break;
    }
    name = `${SNAPSHOT_PREFIX}${st}-${hash.slice(0, 8)}-${suffix++}.json`;
  }
  const res = writeAtomic({
    dir: recoveryDir,
    target: join(recoveryDir, name),
    bytes,
    allowedPreHashes: null, // must not exist (unique name computed above)
    previousHash: null,
    ops,
  });
  if (!res.ok) return null;
  // §7.4 exemption: the snapshot just written is the pending change's
  // evidence — it is exempt from its own pruning (its content hash equals
  // the pending externalHash; the original bytes are never re-read).
  pruneSnapshots(recoveryDir, ops, hash);
  return name;
}

/**
 * Prune the recovery snapshots to at most `RECOVERY_MAX` total — always
 * including the exempt one (workspace.md §7.4, normative).
 *
 * `exemptHash` is the content SHA-256 of the pending change's snapshot
 * (the pending `externalHash` — the bytes were snapshotted byte-for-byte
 * and never re-read). The exempt artifact is identified as the file whose
 * CONTENT hash equals it: only the candidates whose name carries the 8-hex
 * prefix `exemptHash.slice(0, 8)` are read (the name format is
 * `scene-<UTCstamp>-<sha8>[-n].json` and the UTCstamp contains no dashes,
 * so normally ≤ a handful of small reads; the content check disambiguates
 * suffix-collision siblings). This read is PRUNING BOOKKEEPING — it is not
 * the §7.4 "never read automatically" evidence path, which is about never
 * auto-LOADING recovery bytes as scene state (snapshots never re-establish
 * the running state; they are only compared by an operator).
 *
 * The NON-EXEMPT names are sorted lexicographically DESCENDING (newest
 * first — the UTCstamp is fixed-width, so lexicographic = chronological;
 * within one UTCstamp by full file name, and no older-UTCstamp snapshot is
 * pruned while a same-UTCstamp one survives) and the rest are removed:
 * keep the first 15 non-exempt (an exempt exists) or the first 16 (none).
 * Returns the number of snapshots removed. The exempt file is never
 * removed.
 */
export function pruneSnapshots(
  recoveryDir: string,
  ops: WriteOps,
  exemptHash: string | null = null,
): number {
  const names = ops
    .listDir(recoveryDir)
    .filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json'));
  let exemptName: string | null = null;
  if (exemptHash !== null) {
    // Candidate names carry the marker `-<sha8>` (followed by `.json` or a
    // numeric suffix `-<n>`); the UTCstamp has no dashes, so the marker is
    // unambiguous. A candidate whose content cannot be read is never
    // exempt (its content cannot be verified) — pruning may still remove
    // it as an ordinary non-exempt snapshot.
    const pfx = exemptHash.slice(0, 8);
    const candidates = names
      .filter((n) => n.includes(`-${pfx}.json`) || n.includes(`-${pfx}-`))
      .sort();
    for (const n of candidates) {
      let content: Uint8Array | null = null;
      try {
        content = ops.readFile(join(recoveryDir, n));
      } catch {
        content = null;
      }
      if (content !== null && sha256Hex(content) === exemptHash) {
        exemptName = n;
        break;
      }
    }
  }
  const nonExempt = names.filter((n) => n !== exemptName).sort().reverse(); // newest first
  const keep = exemptName === null ? RECOVERY_MAX : RECOVERY_MAX - 1;
  let pruned = 0;
  for (const n of nonExempt.slice(keep)) {
    ops.removeFile(join(recoveryDir, n));
    pruned += 1;
  }
  return pruned;
}

/** List snapshot names (newest last) — for tests/inspection. */
export function listSnapshots(recoveryDir: string, ops: WriteOps = defaultOps): string[] {
  return ops
    .listDir(recoveryDir)
    .filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json'))
    .sort();
}
