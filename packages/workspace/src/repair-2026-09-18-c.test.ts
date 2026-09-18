/**
 * 2026-09-18 review repair — group C (R1 + R2 + R6) regression tests.
 *
 * Findings (docs/reviews/2026-09-18-commits.md, group C):
 *
 *   R1 (P1) — unreadable files are mistaken for deleted files, enabling
 *            loss of foreign bytes: `readFile` caught every error and
 *            treated it as ABSENCE. A chmod-000 `scenes/main.json`
 *            reported `external_change_unresolved` with a ZERO-BYTE
 *            snapshot (the SHA-256 of empty content), and
 *            `discardExternalState` then renamed over the unreadable
 *            foreign file. Reproduced with real permissions as the
 *            unprivileged host user (this file runs the same way).
 *   R2 (P1) — a write retry overwrote foreign content without another
 *            pre-write check: the §5.2 hash check ran once before the
 *            retry loop, so a second W attempt began without checking
 *            the target it was about to replace.
 *   R6 (P2) — temp-file close errors were swallowed in the attempt's
 *            `finally`; rename/verification continued and a success was
 *            acknowledged for a sequence whose close failed.
 *
 * Repairs pinned here (workspace.md §5.1/§5.2/§7.2/§7.3, the applied
 * contract diff `dabfcff`):
 *   - W distinguishes ENOENT (absence) from any other read failure in
 *     the pre-write check AND the final classification: non-ENOENT ⇒
 *     `unreadable` outcome (the bytes are UNKNOWN, never absent) — no
 *     zero-byte/fabricated snapshot, no `previous`/`new-undurable`
 *     misclassification;
 *   - the mutation records the unreadable pending state
 *     (`snapshotState: "unreadable"`, `externalHash: null`, no snapshot
 *     taken) and fails `external_change_unreadable` (§11);
 *   - the §7.3 refusal clause: while `snapshotState` is not "ok",
 *     accept/discard are refused — but the command RE-READS the file
 *     before answering: readable ⇒ (re)establish from the real bytes
 *     (durable snapshot) and proceed in the same call; ENOENT ⇒ the
 *     foreign state is gone (LKG durably restored via W, creation-style
 *     check); still unreadable ⇒ refused; other foreign bytes ⇒ the §7.2
 *     protocol re-fires;
 *   - the §5.2 pre-write check is the first statement of EVERY attempt
 *     (per-attempt allowed set = `allowedPreHashes` PLUS the intended
 *     hash — this W's own intermediate state is never "foreign");
 *   - a close failure ABORTS the attempt (no rename with a possibly
 *     reused fd; the first failure of the attempt records the errno — a
 *     close error never masks an earlier write/fsync errno; a retry uses
 *     a NEW temp file + nonce).
 *
 * Real filesystem, unprivileged (chmod 000 is a REAL EACCES — the
 * review's repro ran exactly this way). Data roots are disposable
 * `mkdtemp` directories, cleaned in finally (afterAll backstop). Fault
 * injection goes through the existing `ops` seam (`WriteOps`) and the
 * new `betweenAttempts` test seam of `writeAtomic` (called after a
 * failed attempt completes and before the next attempt's re-check —
 * documented in write.ts exactly like `beforeVerifyRead`).
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService, type WriteOps } from '@thirdlight/workspace';

import { sha256Hex } from './digest';
import { defaultOps, writeAtomic } from './write';

// ---- disposable roots (mkdtemp data roots; cleaned per test + backstop) ---

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `tl07c-${tag}-`));
  roots.push(root);
  return root;
}

function dropRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort — the afterAll backstop retries
  }
}

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// ---- helpers -----------------------------------------------------------------

const BACKEND_ID = 'tb-11112222333344445555666677778888';
/** Pinned UTC stamp (config seam): snapshot names are deterministic. */
const PINNED_STAMP = '20260918T000000Z';
const PROJECT = 'demo';
const SCENE_REL = join('projects', PROJECT, 'scenes', 'main.json');
const SCENE_DIR_REL = join('projects', PROJECT, 'scenes');

let sequence = 0;

/** A `createEntity` mutation request at the given revision. */
function request(expectedRevision: number) {
  sequence += 1;
  return {
    op: 'createEntity',
    projectId: PROJECT,
    expectedRevision,
    requestId: `req-${sequence.toString(16).padStart(32, '0')}`,
    args: { kind: 'box', name: `Box ${sequence}` },
  };
}

/** A fault with a real `errno` NAME (the seams' injection style). */
function errWith(errno: string, message: string): Error {
  return Object.assign(new Error(message), { errno });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const LKG = new TextEncoder().encode('last-known-good envelope bytes (group C)');
const FOREIGN = new TextEncoder().encode(
  '{"not":"a thirdlight envelope — foreign edit, must never be lost"}',
);
const FOREIGN_HASH = sha256Hex(FOREIGN);
/** The next-intended bytes for W-level tests (differ from LKG). */
const INTENDED = new TextEncoder().encode('intended next envelope bytes (group C)');

/** Open a service on a fresh root and create the project at revision 0. */
function openProject(root: string, ops?: WriteOps) {
  const s = openWorkspaceService({
    root,
    backendId: BACKEND_ID,
    stamp: () => PINNED_STAMP,
    ...(ops === undefined ? {} : { ops }),
  });
  expect(s.createProject(PROJECT, 'Demo')).toEqual({
    ok: true,
    created: true,
    revision: 0,
  });
  return s;
}

/** Snapshot names in the project's recovery dir (empty when absent). */
function recoverySnaps(root: string): string[] {
  try {
    return readdirSync(join(root, 'projects', PROJECT, '.thirdlight', 'recovery'))
      .filter((n) => n.startsWith('scene-'))
      .sort();
  } catch {
    return [];
  }
}

/** Is the file readable right now (real fs — 000-permission ⇒ false)? */
function isReadable(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Assert the query reports the project paused (with a pending change). */
function pausedQuery(s: { query: (r: unknown) => unknown }): void {
  const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
    ok: boolean;
    workspace: { writePaused: boolean };
  };
  expect(q.ok).toBe(true);
  expect(q.workspace.writePaused).toBe(true);
}

// ---- cases ---------------------------------------------------------------------

describe('2026-09-18 review group C (R1, R2, R6) regressions', () => {
  // -- R1: the review's exact repro (permission denied ≠ absent) ----------------

  it('1. R1 permission-denied: an unreadable foreign file pauses as unreadable (no zero-byte snapshot, bytes untouched)', () => {
    const root = makeRoot('r1a');
    try {
      const s = openProject(root);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = join(root, SCENE_REL);
      const lkgBytes = readFileSync(scene);

      // The review's repro: foreign bytes + chmod 000 (directory stays writable).
      writeFileSync(scene, FOREIGN);
      chmodSync(scene, 0o000);
      const before = recoverySnaps(root);

      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      const e = (m as unknown as { ok: false; error: Record<string, unknown> }).error;
      // §11 payload — same wrapper shape as external_change_unresolved
      // (code/cls/pendingChange/message/hint) plus the §11 additions.
      expect(e['code']).toBe('external_change_unreadable');
      expect(e['cls']).toBe('unavailable');
      expect(e['projectId']).toBe(PROJECT);
      expect(e['snapshotState']).toBe('unreadable');
      expect(e['pendingChange']).toEqual({
        externalHash: null,
        externalValid: null,
        externalErrorCount: null,
      });
      expect(typeof e['message']).toBe('string');
      expect(typeof e['hint']).toBe('string');
      // NO snapshot was taken (nothing was read) — the recovery dir gained
      // no artifact (in particular: no zero-byte fabricated snapshot).
      expect(recoverySnaps(root)).toEqual(before);

      // Query: paused with the unreadable pending state (snapshotState
      // surfaced; externalHash null — no fabricated hash).
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        workspace: {
          writePaused: boolean;
          pendingChange: { snapshotState: string; externalHash: string | null };
        };
      };
      expect(q.workspace.writePaused).toBe(true);
      expect(q.workspace.pendingChange.snapshotState).toBe('unreadable');
      expect(q.workspace.pendingChange.externalHash).toBe(null);

      // The foreign bytes are byte-identical after (restore 644, read,
      // compare) — the read failure neither deleted nor "fixed" them.
      chmodSync(scene, 0o644);
      expect(bytesEqual(readFileSync(scene), FOREIGN)).toBe(true);
      expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(false);
    } finally {
      dropRoot(root);
    }
  });

  it('2. R1 no resolution over unreadable bytes; the §7.3 re-read then re-establishes from the real bytes and proceeds in the same call', () => {
    const root = makeRoot('r1b');
    try {
      const s = openProject(root);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = join(root, SCENE_REL);
      const lkgBytes = readFileSync(scene);
      writeFileSync(scene, FOREIGN);
      chmodSync(scene, 0o000);
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      expect((m as { error: { code: string } }).error.code).toBe(
        'external_change_unreadable',
      );

      // Refused while unreadable: NOTHING is written — the file is still
      // 000 (unreadable), the bytes are untouched, still paused + pending.
      const d1 = s.discardExternalState(PROJECT);
      expect(d1.ok).toBe(false);
      expect((d1 as { ok: false; error: { code: string } }).error.code).toBe(
        'external_change_unreadable',
      );
      const a1 = s.acceptExternalState(PROJECT);
      expect(a1.ok).toBe(false);
      expect((a1 as { ok: false; error: { code: string } }).error.code).toBe(
        'external_change_unreadable',
      );
      expect(isReadable(scene)).toBe(false); // still 000
      pausedQuery(s); // still paused + pending
      expect(
        (s.query({ op: 'queryProject', projectId: PROJECT }) as { workspace: {
          pendingChange: { snapshotState: string; externalHash: string | null };
        } }).workspace.pendingChange.snapshotState,
      ).toBe('unreadable');

      // The same foreign bytes now readable (644): the §7.3 re-read
      // re-establishes the pending change from the REAL bytes (durable
      // snapshot) and proceeds with the discard in the SAME call.
      chmodSync(scene, 0o644);
      const d2 = s.discardExternalState(PROJECT);
      expect(d2).toEqual({ ok: true, revision: 1, historyReset: true });

      // The envelope is the LKG bytes EXACTLY; the project is unpaused.
      expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(true);
      expect(
        (s.query({ op: 'queryProject', projectId: PROJECT }) as {
          workspace: { writePaused: boolean };
        }).workspace.writePaused,
      ).toBe(false);

      // The recovery dir holds EXACTLY ONE snapshot: the real foreign
      // bytes, named with their sha8.
      const snaps = recoverySnaps(root);
      expect(snaps).toEqual([`scene-${PINNED_STAMP}-${FOREIGN_HASH.slice(0, 8)}.json`]);
      const recDir = join(root, 'projects', PROJECT, '.thirdlight', 'recovery');
      expect(bytesEqual(readFileSync(join(recDir, snaps[0]!)), FOREIGN)).toBe(true);

      // A subsequent mutation succeeds (the project is fully unblocked).
      const m3 = s.runCommand(request(1));
      expect(m3.ok).toBe(true);
      expect((m3 as { revision: number }).revision).toBe(2);
    } finally {
      dropRoot(root);
    }
  });

  it('3. R1 transient-read-error ≠ absence: a non-ENOENT pre-check read is `unreadable` (never `external` with EMPTY_HASH, never `failed`)', () => {
    // W level: the pre-check read throws { errno: 'EIO' }.
    const dir = makeRoot('r1c-w');
    try {
      const target = join(dir, 'main.json');
      writeFileSync(target, LKG);
      const prevHash = sha256Hex(LKG);
      const flag: { on: boolean } = { on: false };
      const ops: WriteOps = {
        ...defaultOps,
        readFile(p) {
          if (flag.on && p === target) throw { errno: 'EIO' };
          return defaultOps.readFile(p);
        },
      };
      flag.on = true;
      const res = writeAtomic({
        dir,
        target,
        bytes: INTENDED,
        allowedPreHashes: [prevHash],
        previousHash: prevHash,
        ops,
      });
      expect(res.ok).toBe(false);
      expect(res.unreadable).toEqual({ errno: 'EIO' });
      // NOT the pre-fix misclassification: no fabricated empty "foreign"
      // snapshot, no `previous`/`new-undurable`.
      expect(res.external).toBeUndefined();
      expect(res.failed).toBeUndefined();
      // The target is untouched (no temp file, no write).
      expect(bytesEqual(readFileSync(target), LKG)).toBe(true);
    } finally {
      dropRoot(dir);
    }

    // Session level: the same fault on the scene target ⇒ the mutation
    // fails external_change_unreadable (and takes NO snapshot).
    const root = makeRoot('r1c-s');
    try {
      const scene = join(root, SCENE_REL);
      const flag: { on: boolean } = { on: false };
      const ops: WriteOps = {
        ...defaultOps,
        readFile(p) {
          if (flag.on && p === scene) throw { errno: 'EIO' };
          return defaultOps.readFile(p);
        },
      };
      const s = openProject(root, ops);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const before = recoverySnaps(root);
      flag.on = true;
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      expect((m as { error: { code: string } }).error.code).toBe(
        'external_change_unreadable',
      );
      expect(recoverySnaps(root)).toEqual(before); // nothing was snapshotted
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        workspace: { writePaused: boolean; pendingChange: { snapshotState: string } };
      };
      expect(q.workspace.writePaused).toBe(true);
      expect(q.workspace.pendingChange.snapshotState).toBe('unreadable');
    } finally {
      dropRoot(root);
    }
  });

  it('4. R2 retry re-checks: a rename failure + intervening foreign write ⇒ attempt 2 flags the real foreign bytes (preserved, snapshotted, paused — not overwritten)', () => {
    // W level: renameFile throws on the FIRST call only; betweenAttempts
    // writes foreign bytes to the target after attempt 1.
    const dir = makeRoot('r2a-w');
    try {
      const target = join(dir, 'main.json');
      writeFileSync(target, LKG);
      const prevHash = sha256Hex(LKG);
      let renames = 0;
      let between: number[] = [];
      const ops: WriteOps = {
        ...defaultOps,
        renameFile(from, to) {
          if (renames++ === 0) throw errWith('EIO', 'injected rename failure');
          return defaultOps.renameFile(from, to);
        },
      };
      const res = writeAtomic({
        dir,
        target,
        bytes: INTENDED,
        allowedPreHashes: [prevHash],
        previousHash: prevHash,
        ops,
        betweenAttempts: (a) => {
          between.push(a);
          writeFileSync(target, FOREIGN); // the foreign write between attempts
        },
      });
      expect(res.ok).toBe(false);
      expect(res.external).toBeDefined();
      expect(res.external!.bytes).toBeDefined();
      expect(bytesEqual(res.external!.bytes, FOREIGN)).toBe(true);
      expect(res.external!.hash).toBe(FOREIGN_HASH);
      expect(between).toEqual([1]);
      // The target still holds the FOREIGN bytes (not overwritten).
      expect(bytesEqual(readFileSync(target), FOREIGN)).toBe(true);
    } finally {
      dropRoot(dir);
    }

    // Session level: the same fault via the ops seam ⇒ the project pauses
    // external_change_unresolved with a snapshot of EXACTLY the foreign
    // bytes; the mutation is not ok; the target is not overwritten.
    const root = makeRoot('r2a-s');
    try {
      const scene = join(root, SCENE_REL);
      const flag: { armed: boolean; fired: boolean } = { armed: false, fired: false };
      const ops: WriteOps = {
        ...defaultOps,
        renameFile(from, to) {
          if (flag.armed && to === scene && !flag.fired) {
            flag.fired = true;
            writeFileSync(to, FOREIGN); // the foreign write (attempt-1 window)
            throw errWith('EIO', 'injected rename failure');
          }
          return defaultOps.renameFile(from, to);
        },
      };
      const s = openProject(root, ops);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const lkgBytes = readFileSync(scene);
      flag.armed = true;
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      expect((m as { error: { code: string } }).error.code).toBe(
        'external_change_unresolved',
      );
      // The real foreign bytes were snapshotted (byte-for-byte) and the
      // target still holds them (NOT overwritten by the retry).
      const snaps = recoverySnaps(root);
      expect(snaps).toEqual([`scene-${PINNED_STAMP}-${FOREIGN_HASH.slice(0, 8)}.json`]);
      const recDir = join(root, 'projects', PROJECT, '.thirdlight', 'recovery');
      expect(bytesEqual(readFileSync(join(recDir, snaps[0]!)), FOREIGN)).toBe(true);
      expect(bytesEqual(readFileSync(scene), FOREIGN)).toBe(true);
      expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(false);
      // Paused, pending, on the foreign hash.
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        workspace: {
          writePaused: boolean;
          pendingChange: { snapshotState: string; externalHash: string | null };
        };
      };
      expect(q.workspace.writePaused).toBe(true);
      expect(q.workspace.pendingChange.snapshotState).toBe('ok');
      expect(q.workspace.pendingChange.externalHash).toBe(FOREIGN_HASH);
    } finally {
      dropRoot(root);
    }
  });

  it('5. R2 failure-after-rename with intervening foreign write: fsyncDir fails (rename succeeded), the foreign bytes arrive, and attempt 2 preserves them', () => {
    // W level: fsyncDir throws on attempt 1 (the rename took effect);
    // betweenAttempts writes foreign bytes over the intended ones.
    const dir = makeRoot('r2b-w');
    try {
      const target = join(dir, 'main.json');
      writeFileSync(target, LKG);
      const prevHash = sha256Hex(LKG);
      let dirFlushes = 0;
      const ops: WriteOps = {
        ...defaultOps,
        fsyncDir(d) {
          if (dirFlushes++ === 0) throw errWith('EIO', 'injected directory-flush failure');
          return defaultOps.fsyncDir(d);
        },
      };
      const res = writeAtomic({
        dir,
        target,
        bytes: INTENDED,
        allowedPreHashes: [prevHash],
        previousHash: prevHash,
        ops,
        betweenAttempts: () => {
          writeFileSync(target, FOREIGN); // the foreign write between attempts
        },
      });
      expect(res.ok).toBe(false);
      expect(res.external).toBeDefined();
      expect(bytesEqual(res.external!.bytes, FOREIGN)).toBe(true);
      expect(res.external!.hash).toBe(FOREIGN_HASH);
      // Preserved (not overwritten by the retry).
      expect(bytesEqual(readFileSync(target), FOREIGN)).toBe(true);
    } finally {
      dropRoot(dir);
    }

    // Session level: paused external_change_unresolved + snapshot of
    // EXACTLY the foreign bytes + target preserved + not ok.
    const root = makeRoot('r2b-s');
    try {
      const scene = join(root, SCENE_REL);
      const sceneDir = join(root, SCENE_DIR_REL);
      const flag: { armed: boolean; fired: boolean } = { armed: false, fired: false };
      const ops: WriteOps = {
        ...defaultOps,
        fsyncDir(d) {
          if (flag.armed && d === sceneDir && !flag.fired) {
            flag.fired = true;
            writeFileSync(scene, FOREIGN); // the foreign write (attempt-1 window)
            throw errWith('EIO', 'injected directory-flush failure');
          }
          return defaultOps.fsyncDir(d);
        },
      };
      const s = openProject(root, ops);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      flag.armed = true;
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      expect((m as { error: { code: string } }).error.code).toBe(
        'external_change_unresolved',
      );
      const snaps = recoverySnaps(root);
      expect(snaps).toEqual([`scene-${PINNED_STAMP}-${FOREIGN_HASH.slice(0, 8)}.json`]);
      const recDir = join(root, 'projects', PROJECT, '.thirdlight', 'recovery');
      expect(bytesEqual(readFileSync(join(recDir, snaps[0]!)), FOREIGN)).toBe(true);
      expect(bytesEqual(readFileSync(scene), FOREIGN)).toBe(true);
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        workspace: { writePaused: boolean };
      };
      expect(q.workspace.writePaused).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  it('6. R2 failure-after-rename with NO intervention: the intended hash at the target is this W\'s own intermediate state — allowed, and the sequence completes (guard against an over-tight re-check)', () => {
    // W level: fsyncDir throws on attempt 1 (rename succeeded); no
    // between-attempt intervention: attempt 2's re-check sees the
    // intended hash ⇒ allowed ⇒ the sequence completes.
    const dir = makeRoot('r2c-w');
    try {
      const target = join(dir, 'main.json');
      writeFileSync(target, LKG);
      const prevHash = sha256Hex(LKG);
      let dirFlushes = 0;
      const ops: WriteOps = {
        ...defaultOps,
        fsyncDir(d) {
          if (dirFlushes++ === 0) throw errWith('EIO', 'injected directory-flush failure');
          return defaultOps.fsyncDir(d);
        },
      };
      const res = writeAtomic({
        dir,
        target,
        bytes: INTENDED,
        allowedPreHashes: [prevHash],
        previousHash: prevHash,
        ops,
      });
      expect(res.ok).toBe(true);
      expect(bytesEqual(readFileSync(target), INTENDED)).toBe(true);
    } finally {
      dropRoot(dir);
    }

    // Session level: the same fault ⇒ the mutation IS acked (the retry
    // over its own intended bytes is not flagged as foreign).
    const root = makeRoot('r2c-s');
    try {
      const sceneDir = join(root, SCENE_DIR_REL);
      const flag: { armed: boolean; fired: boolean } = { armed: false, fired: false };
      const ops: WriteOps = {
        ...defaultOps,
        fsyncDir(d) {
          if (flag.armed && d === sceneDir && !flag.fired) {
            flag.fired = true;
            throw errWith('EIO', 'injected directory-flush failure');
          }
          return defaultOps.fsyncDir(d);
        },
      };
      const s = openProject(root, ops);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      flag.armed = true;
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(true);
      expect((m as { revision: number }).revision).toBe(2);
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        workspace: { writePaused: boolean };
      };
      expect(q.workspace.writePaused).toBe(false);
    } finally {
      dropRoot(root);
    }
  });

  it('7. R6 close-only failure never succeeds: every attempt fails at close ⇒ no rename is ever reached ⇒ after 3 attempts W returns failed { onDiskState: "previous" } (target byte-identical to the previous bytes)', () => {
    // W level: closeFile throws on EVERY attempt (after actually closing
    // the descriptor — the review's injection).
    const dir = makeRoot('r6a-w');
    try {
      const target = join(dir, 'main.json');
      writeFileSync(target, LKG);
      const prevHash = sha256Hex(LKG);
      let renames = 0;
      const ops: WriteOps = {
        ...defaultOps,
        closeFile(fd) {
          try {
            defaultOps.closeFile(fd);
          } finally {
            throw errWith('EIO', 'injected close failure');
          }
        },
        renameFile(from, to) {
          renames += 1;
          return defaultOps.renameFile(from, to);
        },
      };
      const res = writeAtomic({
        dir,
        target,
        bytes: INTENDED,
        allowedPreHashes: [prevHash],
        previousHash: prevHash,
        ops,
      });
      expect(res.ok).toBe(false); // NEVER ok from a sequence whose close failed
      expect(res.failed).toBeDefined();
      expect(res.failed!.onDiskState).toBe('previous');
      expect(res.failed!.errno).toBe('EIO');
      expect(res.unreadable).toBeUndefined();
      expect(res.external).toBeUndefined();
      expect(renames).toBe(0); // no attempt ever reached rename
      // The target is the previous bytes, byte-identical.
      expect(bytesEqual(readFileSync(target), LKG)).toBe(true);
    } finally {
      dropRoot(dir);
    }

    // Session level: the mutation is NOT acknowledged (write_failed,
    // previous); the on-disk LKG is untouched; the revision does not
    // advance.
    const root = makeRoot('r6a-s');
    try {
      const scene = join(root, SCENE_REL);
      const flag: { armed: boolean } = { armed: false };
      const ops: WriteOps = {
        ...defaultOps,
        closeFile(fd) {
          if (!flag.armed) return defaultOps.closeFile(fd);
          try {
            defaultOps.closeFile(fd);
          } finally {
            throw errWith('EIO', 'injected close failure');
          }
        },
      };
      const s = openProject(root, ops);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const lkgBytes = readFileSync(scene);
      flag.armed = true;
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      const e = (m as unknown as { ok: false; error: Record<string, unknown> }).error;
      expect(e['code']).toBe('write_failed');
      expect(e['onDiskState']).toBe('previous');
      expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(true);
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        revision: number;
      };
      expect(q.revision).toBe(1); // not advanced
    } finally {
      dropRoot(root);
    }
  });

  it('8. R6 no masking: a write failure and a close failure in the SAME attempt ⇒ the recorded errno is the WRITE failure\'s (first failure wins), not the close\'s', () => {
    const dir = makeRoot('r6b');
    try {
      const target = join(dir, 'main.json');
      writeFileSync(target, LKG);
      const prevHash = sha256Hex(LKG);
      const ops: WriteOps = {
        ...defaultOps,
        writeAll(fd, bytes) {
          throw errWith('EIO', 'injected write failure');
        },
        closeFile(fd) {
          try {
            defaultOps.closeFile(fd);
          } finally {
            throw errWith('EPERM', 'injected close failure');
          }
        },
      };
      const res = writeAtomic({
        dir,
        target,
        bytes: INTENDED,
        allowedPreHashes: [prevHash],
        previousHash: prevHash,
        ops,
      });
      expect(res.ok).toBe(false);
      expect(res.failed).toBeDefined();
      expect(res.failed!.onDiskState).toBe('previous');
      // FIRST failure of the attempt wins: the write's EIO — NOT the
      // close's EPERM (pre-fix, the close error in the finally replaced
      // the write error and its errno was recorded).
      expect(res.failed!.errno).toBe('EIO');
      expect(res.failed!.errno).not.toBe('EPERM');
      expect(bytesEqual(readFileSync(target), LKG)).toBe(true);
    } finally {
      dropRoot(dir);
    }
  });

  it('9. Guards (pre-existing behavior intact): a normal mutation advances; a READABLE foreign change is still the standard unresolved + real-byte snapshot + pause; creation\'s first-write check still flags a readable appearance as external', () => {
    // (a) Normal established mutation: ok + revision advance.
    const rootA = makeRoot('g9a');
    try {
      const s = openProject(rootA);
      const m1 = s.runCommand(request(0));
      expect(m1.ok).toBe(true);
      expect((m1 as { revision: number }).revision).toBe(1);
      const m2 = s.runCommand(request(1));
      expect(m2.ok).toBe(true);
      expect((m2 as { revision: number }).revision).toBe(2);
    } finally {
      dropRoot(rootA);
    }

    // (b) A READABLE foreign change: standard external_change_unresolved,
    // a snapshot of the REAL bytes, and the pause (the pre-fix detection
    // path — unchanged by the group C repair).
    const rootB = makeRoot('g9b');
    try {
      const s = openProject(rootB);
      const scene = join(rootB, SCENE_REL);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      writeFileSync(scene, FOREIGN); // readable foreign bytes
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      const e = (m as unknown as { ok: false; error: Record<string, unknown> }).error;
      expect(e['code']).toBe('external_change_unresolved');
      expect(e['pendingChange']).toEqual({
        externalHash: FOREIGN_HASH,
        externalValid: false,
        externalErrorCount: expect.any(Number),
      });
      const snaps = recoverySnaps(rootB);
      expect(snaps).toEqual([`scene-${PINNED_STAMP}-${FOREIGN_HASH.slice(0, 8)}.json`]);
      const recDir = join(rootB, 'projects', PROJECT, '.thirdlight', 'recovery');
      expect(bytesEqual(readFileSync(join(recDir, snaps[0]!)), FOREIGN)).toBe(true);
      const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
        workspace: { writePaused: boolean };
      };
      expect(q.workspace.writePaused).toBe(true);
      // The foreign bytes are still in place (not overwritten).
      expect(bytesEqual(readFileSync(scene), FOREIGN)).toBe(true);
    } finally {
      dropRoot(rootB);
    }

    // (c) Creation's first-write check (allowedPreHashes: null — must
    // stay absent): a readable appearance at the absent target ⇒ external
    // with the real bytes, exactly as before.
    const dirC = makeRoot('g9c');
    try {
      const target = join(dirC, 'main.json');
      writeFileSync(target, FOREIGN);
      const res = writeAtomic({
        dir: dirC,
        target,
        bytes: INTENDED,
        allowedPreHashes: null,
        previousHash: null,
      });
      expect(res.ok).toBe(false);
      expect(res.external).toBeDefined();
      expect(bytesEqual(res.external!.bytes, FOREIGN)).toBe(true);
      expect(res.external!.hash).toBe(FOREIGN_HASH);
      // And the absent case still passes (creation semantics unchanged).
      const dirC2 = makeRoot('g9c2');
      roots.push(dirC2);
      try {
        const res2 = writeAtomic({
          dir: dirC2,
          target: join(dirC2, 'main.json'),
          bytes: INTENDED,
          allowedPreHashes: null,
          previousHash: null,
        });
        expect(res2.ok).toBe(true);
      } finally {
        dropRoot(dirC2);
      }
    } finally {
      dropRoot(dirC);
    }
  });
});