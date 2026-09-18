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
 * Snapshot foreign bytes (byte-for-byte) and prune to the newest 16.
 * Returns the snapshot file name (basename) actually written, or `null`
 * when the snapshot could not be written (the pause still proceeds — the
 * contract's guarantee is "snapshotted before the project pauses" for the
 * bytes the backend can write; a write failure here is reported by the
 * caller via the write_failed/external outcomes of the triggering command).
 */
export function snapshotForeignBytes(
  projectDir: string,
  bytes: Uint8Array,
  ops: WriteOps,
  stamp: () => string = utcStamp,
): string | null {
  const recoveryDir = join(projectDir, '.thirdlight', 'recovery');
  try {
    ensureDir(join(projectDir, '.thirdlight'), ops);
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
  pruneSnapshots(recoveryDir, ops);
  return name;
}

/** Keep the newest 16 snapshots (by name order: the UTCstamp is fixed-width, so lexicographic = chronological). */
export function pruneSnapshots(recoveryDir: string, ops: WriteOps): number {
  const names = ops
    .listDir(recoveryDir)
    .filter((n) => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json'))
    .sort()
    .reverse(); // newest first
  let pruned = 0;
  for (const n of names.slice(RECOVERY_MAX)) {
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
