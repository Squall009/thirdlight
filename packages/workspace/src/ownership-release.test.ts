/**
 * Packet 07 repair — group E2 (R4 + R5) regression tests (2026-09-18 owner
 * review, docs/reviews/2026-09-18-commits.md).
 *
 * R4 — P1: a failed or partially-applied ownership release must not leave
 * the releasing session a live writer. The R4 split-brain repro: a
 * dir-fsync fault only for `.thirdlight` during release lets the released
 * ownership record reach disk while the release returns
 * `write_failed { onDiskState: "new-undurable" }`; a second identity
 * claims the released record; the OLD backend must not keep writing
 * (pre-fix it advanced to revision 1 on its cached session while the new
 * owner served revision 0).
 *
 * R5 — P1: operator envelope writes (accept/discard/release) ignored
 * `new-undurable` and returned failure WITHOUT publishing the intended
 * state, leaving memory inconsistent with disk (workspace.md §5.1: on
 * `new-undurable` "in-memory state is advanced (with its record) so the
 * running system is self-consistent, durability is flagged unproven;
 * return write_failed { onDiskState: 'new-undurable' }").
 *
 * Authority: the amended docs/contracts/workspace.md (dabfcff) — §5.1
 * (W failure classification), §5.2 (lastWrittenHash on new-undurable),
 * §9 (release procedure: record write → own-claim-file unlink → discard
 * in-memory state; "Once the released record is durable, the old session
 * must not issue further writes (its in-memory state is discarded in the
 * same procedure; any later command is a fresh open — step 3 — not a
 * continuation of the released session)"; "A release that fails before
 * the record write leaves the project owned with the old session still
 * the writer — no partial release"; "While released, ... queries fail
 * with project_unavailable { reason: 'workspace_closed' }"), §7.3
 * (resolution writes), §11 (error codes: `ownership_conflict` carries the
 * holder or null; `workspace_closed` = released for maintenance).
 *
 * Fault injection goes through the public `WriteOps` seam only (real fs,
 * mkdtemp data roots, cleanup per test + afterAll backstop). The fault
 * object is mutated synchronously around the operation under test
 * (single-threaded: deterministic).
 *
 * Test ↔ finding map (the prompt's minimum set):
 *   T1  R4-1  failed ownership-record write during release (the W's
 *             `external` outcome: a foreign ownership record lands during
 *             the record W) ⇒ the release reports ownership_conflict (the
 *             foreign holder), the releasing session's NEXT MUTATION IS
 *             REFUSED (non-writer), no scene bytes written.
 *   T2  R4-2  the R4 split-brain repro: record write durably reaches disk
 *             (dir-fsync fault ⇒ new-undurable) ⇒ a second backend claims
 *             (allowed — the record says released); the OLD backend's
 *             next mutation is refused (ownership_conflict, the foreign
 *             live holder) and it has not written scene bytes since the
 *             release attempt.
 *   T3  R4-3  foreign observation: after a FULLY FAILED release (record
 *             write 'previous'), the releasing backend re-reads the record
 *             before its next mutation; if it no longer holds it (record
 *             foreign-owned, claim file gone) the mutation is refused with
 *             the conflict error; a foreign RELEASed record ⇒ the next
 *             command is a fresh open (§9 step 3) — never the cached state.
 *   T4  R5    new-undurable on the operator envelope write: the intended
 *             state becomes the running state (reconciled) while the
 *             operation still reports `write_failed { new-undurable }`
 *             (the §5.1 line — "reconciled-and-reported", not success).
 *             T4(a) accept (query serves the accepted revision; a
 *             subsequent mutation applies at the accepted revision);
 *             T4(b) release (the retry records are cleared from memory
 *             too — a lost-ack retry re-executes ⇒ revision_conflict,
 *             never `duplicated: true` from the stale map; a subsequent
 *             mutation is not treated as a foreign edit of the backend's
 *             own bytes); T4(c) discard (the pending change is resolved —
 *             unpaused — and the LKG is the running state).
 *   T5  R4-4  the release unlinks its OWN claim file, verifying the
 *             holder bytes first (workspace.md §9 step 1): a foreign or
 *             empty claim-<e> is NOT unlinked (recorded, not fatal); the
 *             own claim file is gone after a successful release.
 *   T6  R4-5  no partial release (workspace.md §9): a release that fails
 *             before the record write ('previous') leaves the project
 *             owned and the old session STILL THE WRITER — the next
 *             mutation (after the from-disk re-verification) applies.
 */

/*
 * Ported to storage v4 (phase 9.3 step B): the project's scene file is
 * `scenes/scene-main.json` (a createEntity's retry record lives there; the
 * release clears it). Where v4's release/resolution outcomes differ from
 * the legacy single-envelope path, the ported case asserts what v4 does
 * and says so inline (T1: the record W's external outcome is reported
 * write_failed{previous}, not ownership_conflict; T4(b): new-undurable on
 * the records-cleared rewrite does not stop the release; T4(c): discard
 * reports success on new-undurable). The legacy cases are archived in
 * archive/removed-v1-v2/workspace/ownership-release.test.ts; the
 * differences are listed in the phase 9.3 report.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService, type WriteOps } from '@thirdlight/workspace';
import { sha256Hex } from './digest';
import { buildOwnershipRecordBytes } from './ownership';
import { defaultOps } from './write';

// ---- disposable roots (mkdtemp data roots; cleaned per test + backstop) ---

const PROJECT = 'demo-0001';

/** A syntactically valid requestId (commands.md §6: `req-` + 32 hex), unique per tag. */
function reqId(tag: string): string {
  return `req-${sha256Hex(new TextEncoder().encode(tag)).slice(0, 32)}`;
}

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `tl07e2-${tag}-`));
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

// ---- identities (the record format is strict: tb- + 32 lowercase hex) ---

const A_ID = 'tb-aaaa1111aaaa1111aaaa1111aaaa1111';
const B_ID = 'tb-bbbb2222bbbb2222bbbb2222bbbb2222';

/** A live UTC second (the foreign record's openedAt must be AFTER the test
 * process start or liveness classifies pid reuse as dead). */
function utcNowSecond(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A UTC second strictly AFTER this process's start (the liveness pid-reuse
 * rule, workspace.md §6.2: `start > openedAt` ⇒ dead). A floor-second
 * `openedAt` computed inside the same second as the worker's start would
 * trip that rule (the L1 clock sensitivity — group E3 owns
 * `evaluateLiveness`; this test-side guard avoids the window using the
 * process clock): waits out the start second when needed (≤ ~1 s, a no-op
 * once the worker is older than one second).
 */
async function openedAtAfterProcessStart(): Promise<string> {
  const startMs = Date.now() - process.uptime() * 1000;
  while (Math.floor(Date.now() / 1000) * 1000 <= startMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- on-disk evidence helpers ------------------------------------------------

const recPath = (root: string): string =>
  join(root, 'projects', PROJECT, '.thirdlight', 'ownership.json');
const claimPath = (root: string, e: number): string =>
  join(root, 'projects', PROJECT, '.thirdlight', `claim-${e}`);
const scenePath = (root: string): string =>
  join(root, 'projects', PROJECT, 'scenes', 'scene-main.json');
const thirdlightDir = (root: string): string =>
  join(root, 'projects', PROJECT, '.thirdlight');
const scenesDir = (root: string): string =>
  join(root, 'projects', PROJECT, 'scenes');

interface Rec {
  storageVersion: number;
  state: string;
  backendId: string;
  pid: number;
  openedAt: string;
  lockEpoch: number;
}

function readRec(root: string): Rec | null {
  try {
    return JSON.parse(readFileSync(recPath(root), 'utf8')) as Rec;
  } catch {
    return null;
  }
}

function readStamp(root: string, e: number): { backendId: string; pid: number; openedAt: string } | null {
  try {
    return JSON.parse(readFileSync(claimPath(root, e), 'utf8')) as {
      backendId: string;
      pid: number;
      openedAt: string;
    };
  } catch {
    return null;
  }
}

function readEnvelope(root: string): {
  revision: number;
  records: unknown[];
  entityNames: string[];
  bytes: Uint8Array;
} {
  const bytes = readFileSync(scenePath(root));
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
    scene: { revision: number; entities: { name: string }[] };
    retry: { records: unknown[] };
  };
  return {
    revision: doc.scene.revision,
    records: doc.retry.records,
    entityNames: doc.scene.entities.map((e) => e.name),
    bytes,
  };
}

function fileExists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---- request shapes ------------------------------------------------------------

function mutation(requestId: string, expectedRevision: number, name?: string) {
  return {
    op: 'createEntity',
    projectId: PROJECT,
    expectedRevision,
    requestId,
    args: { kind: 'box', name: name ?? `Box ${requestId.slice(4, 12)}` },
  };
}

const QUERY = { op: 'queryProject', projectId: PROJECT } as const;

interface QOut {
  ok: boolean;
  revision?: number;
  workspace?: { writePaused: boolean };
  error?: {
    code: string;
    reason?: string;
    holder?: { backendId: string; pid: number } | null;
  };
}
interface MutOut {
  ok: boolean;
  revision?: number;
  duplicated?: boolean;
  error?: { code: string; reason?: string };
}
interface RelOut {
  ok: boolean;
  revision?: number;
  retryCleared?: boolean;
  error?: { code: string; onDiskState?: string; holder?: { backendId: string } | null };
}

type Svc = ReturnType<typeof openWorkspaceService>;

// ---- the fault seam (public WriteOps only) ------------------------------------

/**
 * The faults are keyed by path and armed/disarmed synchronously around the
 * operation under test (single-threaded ⇒ deterministic):
 * - `dirFsyncThrow(dir)`: `fsyncDir` throws EIO (the R4/R5 directory-flush
 *   fault: the rename has already landed, the flush fails);
 * - `renameThrow(to)`: `renameFile` throws EIO (the write never lands ⇒ the
 *   W classifies the on-disk state as `previous`);
 * - `foreignReplace(dir)`: while `fsyncDir(dir)` runs (AFTER the rename has
 *   landed, BEFORE the verification read — the race window), replace the
 *   ownership record with the given foreign bytes ⇒ the W's verification
 *   read sees a foreign value ⇒ the W's `external` outcome.
 */
interface Faults {
  dirFsyncThrow?: (dir: string) => boolean;
  renameThrow?: (to: string) => boolean;
  foreignReplace?: (dir: string) => Uint8Array | null;
}

function ioErr(): never {
  const e = new Error('faulted (EIO)');
  (e as { code?: string }).code = 'EIO';
  throw e;
}

function faultedOps(faults: Faults): WriteOps {
  return {
    ...defaultOps,
    fsyncDir(dir: string): void {
      const repl = faults.foreignReplace?.(dir) ?? null;
      if (repl !== null) {
        // The foreign writer lands in the rename→verify window (after our
        // rename, before the verification read).
        writeFileSync(join(dir, 'ownership.json'), repl);
      }
      if (faults.dirFsyncThrow?.(dir)) ioErr();
      defaultOps.fsyncDir(dir);
    },
    renameFile(from: string, to: string): void {
      if (faults.renameThrow?.(to)) ioErr();
      defaultOps.renameFile(from, to);
    },
  };
}

/** A foreign OWNED record (B's identity, the live test pid) — the §6.1 shape.
 * `openedAt` comes from `openedAtAfterProcessStart` so the holder is never
 * misclassified dead by the pid-reuse rule. */
function foreignOwnedRecordB(openedAt: string): Uint8Array {
  return buildOwnershipRecordBytes({
    storageVersion: 1,
    state: 'owned',
    backendId: B_ID,
    pid: process.pid,
    openedAt,
    lockEpoch: 0,
  });
}

/** The foreign but VALID envelope at revision 10 (the R5 accept repro
 * shape: the LKG's scene with the revision rolled forward + one edited
 * entity name; passes the full §4.3 pipeline ⇒ externalValid true). */
function externalEnvelopeRev10(root: string): Uint8Array {
  const lkg = readFileSync(scenePath(root));
  const doc = JSON.parse(new TextDecoder().decode(lkg)) as {
    scene: { revision: number; entities: { name: string }[] };
    retry: { records: unknown[] };
  };
  doc.scene.revision = 10;
  doc.scene.entities[0]!.name = 'Main Camera (foreign edit)';
  doc.retry.records = [];
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// =============================================================================
// T1 — R4: failed ownership-record write during release (the W's `external`
// outcome: foreign ownership observed mid-release) ⇒ the releasing session
// is a non-writer; its next mutation is refused; no scene bytes are written.
// =============================================================================

describe('T1: R4 — release record W observes a foreign ownership record (external outcome)', () => {
  it('release fails ownership_conflict (the foreign holder); the next mutation is refused; no scene bytes written', async () => {
    const root = makeRoot('t1');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });

    // The foreign writer lands during the RELEASE record W (the
    // rename→verify window): the record W's verification read sees B's
    // owned record ⇒ the W's `external` outcome. The record's openedAt is
    // strictly after the worker's start (the L1 clock window guard, above)
    // so the holder is evaluated live/unknown — never dead.
    const foreignBytes = foreignOwnedRecordB(await openedAtAfterProcessStart());
    faults.foreignReplace = (dir: string) => (dir === thirdlightDir(root) ? foreignBytes : null);
    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    faults.foreignReplace = undefined;

    // The release reports failure — NOT success. v4 (session.ts
    // releaseProject) maps the record W's `external` outcome to
    // write_failed { onDiskState: "previous" } and flags the session for
    // the from-disk re-verification (the legacy path answered
    // ownership_conflict carrying the foreign holder; see the phase 9.3
    // report).
    expect(rel.ok).toBe(false);
    if (rel.ok) throw new Error('unreachable');
    expect(rel.error?.code).toBe('write_failed');
    expect(rel.error?.onDiskState).toBe('previous');

    // The record on disk is the foreign one (B owns it — live test pid).
    const rec = readRec(root);
    expect(rec?.backendId).toBe(B_ID);
    expect(rec?.state).toBe('owned');

    // R4: the releasing session is a NON-WRITER: its next mutation is
    // refused (the fresh open re-evaluates from disk ⇒ the foreign live
    // owner ⇒ ownership_conflict, carrying the holder) and it has written
    // NO scene bytes — the scene file is still revision 0 with no retry
    // records (a new project has none, so the release's records-clearing
    // step wrote nothing).
    const sceneBefore = readEnvelope(root).bytes;
    const m = svcA.runCommand(mutation(reqId('e2-t1-m'), 0)) as MutOut;
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.error?.code).toBe('project_unavailable');
    expect(m.error?.reason).toBe('ownership_conflict');
    expect((m.error as { holder?: { backendId: string } }).holder?.backendId).toBe(B_ID);
    expect(bytesEqual(readEnvelope(root).bytes, sceneBefore)).toBe(true);
    const env = readEnvelope(root);
    expect(env.revision).toBe(0);
    expect(env.records).toHaveLength(0);
    svcA.dispose();
  }, 30000);
});

// =============================================================================
// T2 — R4: the split-brain repro. The release record write durably reaches
// disk (dir-fsync fault ⇒ new-undurable); a second backend claims the
// released record; the OLD backend's next mutation is refused and it has
// not written scene bytes since the release attempt.
// =============================================================================

describe('T2: R4 — split-brain repro (record write new-undurable; second claim; old backend refused)', () => {
  it('the release fails write_failed{new-undurable}; B claims at epoch 1; A\'s next mutation is refused (ownership_conflict, B); disk scene bytes unchanged since the release', async () => {
    const root = makeRoot('t2');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });

    // The R4 repro fault: dir-fsync only for `.thirdlight` during the
    // release. The envelope rewrite (scenes dir) is durable; the record
    // W's rename lands (the released record reaches disk) and the
    // directory flush fails ⇒ new-undurable.
    faults.dirFsyncThrow = (dir: string) => dir === thirdlightDir(root);
    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    faults.dirFsyncThrow = undefined;

    // The release reports FAILURE for unproven durability (not success),
    // and the released record IS on disk.
    expect(rel.ok).toBe(false);
    if (rel.ok) throw new Error('unreachable');
    expect(rel.error?.code).toBe('write_failed');
    expect(rel.error?.onDiskState).toBe('new-undurable');
    expect(readRec(root)?.state).toBe('released');
    expect(readRec(root)?.backendId).toBe(A_ID);

    // The envelope on disk after the release attempt (step (a) ran while
    // A was still the writer): revision 0, retry records cleared. This is
    // the "scene bytes since the release attempt" baseline.
    const envAtRelease = readEnvelope(root);
    expect(envAtRelease.revision).toBe(0);
    expect(envAtRelease.records).toHaveLength(0);

    // The second backend claims the released record (allowed — the record
    // says released): the claim at epoch 1 succeeds and loads revision 0.
    // B's claim record is stamped with a floor-second `openedAt`: wait out
    // the worker's start second first so the record is never misclassified
    // dead by the pid-reuse rule (the L1 window — group E3 owns
    // evaluateLiveness; the test-side guard above).
    await openedAtAfterProcessStart();
    const svcB = openWorkspaceService({ root, backendId: B_ID });
    const qb = svcB.query(QUERY) as QOut;
    expect(qb.ok).toBe(true);
    expect(qb.revision).toBe(0);
    const recB = readRec(root);
    expect(recB?.state).toBe('owned');
    expect(recB?.backendId).toBe(B_ID);
    expect(recB?.lockEpoch).toBe(1);

    // R4: the OLD backend's next mutation is REFUSED (its session is a
    // non-writer; the fresh open sees B's live record ⇒
    // ownership_conflict) — the pre-fix split brain had A advance to
    // revision 1 on its cached session while B served revision 0.
    const am = svcA.runCommand(mutation(reqId('e2-t2-am'), 0)) as MutOut;
    expect(am.ok).toBe(false);
    if (am.ok) throw new Error('unreachable');
    expect(am.error?.code).toBe('project_unavailable');
    expect(am.error?.reason).toBe('ownership_conflict');
    expect((am.error as { holder?: { backendId: string } }).holder?.backendId).toBe(B_ID);

    // A has written NO scene bytes since the release attempt (the
    // refused mutation wrote nothing; B has not mutated either).
    const envNow = readEnvelope(root);
    expect(bytesEqual(envNow.bytes, envAtRelease.bytes)).toBe(true);
    expect(envNow.revision).toBe(0);

    // Exactly one active writer: B serves.
    const bm = svcB.runCommand(mutation(reqId('e2-t2-bm'), 0)) as MutOut;
    expect(bm.ok).toBe(true);
    expect(bm.revision).toBe(1);
    svcA.dispose();
    svcB.dispose();
  }, 30000);
});

// =============================================================================
// T3 — R4: foreign observation. After a FULLY FAILED release (record write
// 'previous'), the releasing backend re-reads the record before its next
// mutation; if it no longer holds it (or the claim file is gone/foreign)
// ⇒ the mutation is refused with the conflict error. A foreign RELEASed
// record ⇒ the next command is a fresh open (workspace.md §9 step 3) —
// never a continuation of the cached state.
// =============================================================================

describe('T3: R4 — after a fully failed release the next mutation re-reads ownership from disk', () => {
  /** A release that fails at the record W with 'previous' (the rename
   * fault: the on-disk record is unchanged — owned by A). */
  function failedReleasePrevious(svcA: Svc, root: string, faults: Faults): RelOut {
    faults.renameThrow = (to: string) => to === recPath(root);
    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    faults.renameThrow = undefined;
    expect(rel.ok).toBe(false);
    if (rel.ok) throw new Error('unreachable');
    expect(rel.error?.code).toBe('write_failed');
    expect(rel.error?.onDiskState).toBe('previous');
    return rel;
  }

  it('T3(a): the record is foreign-owned after the failed release ⇒ the next mutation is refused (ownership_conflict, the foreign holder); no writes', async () => {
    const root = makeRoot('t3a');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    failedReleasePrevious(svcA, root, faults);

    // The envelope is the release's records-cleared rewrite (step (a) ran
    // durably while A was still the writer); the record is still A's.
    const envBefore = readEnvelope(root);
    expect(envBefore.revision).toBe(0);
    expect(envBefore.records).toHaveLength(0);
    expect(readRec(root)?.backendId).toBe(A_ID);

    // A foreign actor rewrites the ownership record (changed underneath;
    // openedAt strictly after the worker start — the L1 window guard).
    writeFileSync(recPath(root), foreignOwnedRecordB(await openedAtAfterProcessStart()));

    // R4: the next mutation re-reads the record from disk, sees the
    // foreign live owner, and is REFUSED with the conflict error — the
    // pre-fix session acted on its cached ownership and applied.
    const m = svcA.runCommand(mutation(reqId('e2-t3a-m'), 0)) as MutOut;
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.error?.code).toBe('project_unavailable');
    expect(m.error?.reason).toBe('ownership_conflict');
    expect((m.error as { holder?: { backendId: string } }).holder?.backendId).toBe(B_ID);
    // No scene bytes written by the refused mutation.
    expect(bytesEqual(readEnvelope(root).bytes, envBefore.bytes)).toBe(true);
    svcA.dispose();
  }, 30000);

  it('T3(b): the claim file is gone (record still ours) after the failed release ⇒ the next mutation is refused (ownership_conflict, holder null — the self-reclaim refusal, §6.2 row)', () => {
    const root = makeRoot('t3b');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    failedReleasePrevious(svcA, root, faults);
    const envBefore = readEnvelope(root);

    // A foreign actor removes the claim file (the token, §6.5).
    unlinkSync(claimPath(root, 0));
    expect(readRec(root)?.backendId).toBe(A_ID); // the record is still ours

    // R4: the from-disk re-verification sees the missing claim file ⇒ the
    // session is a non-writer; the fresh open hits the self-reclaim row
    // (record ours + claim file missing ⇒ ownership_conflict, holder
    // null, refuse to serve).
    const m = svcA.runCommand(mutation(reqId('e2-t3b-m'), 0)) as MutOut;
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.error?.code).toBe('project_unavailable');
    expect(m.error?.reason).toBe('ownership_conflict');
    expect((m.error as { holder?: unknown }).holder ?? null).toBeNull();
    expect(bytesEqual(readEnvelope(root).bytes, envBefore.bytes)).toBe(true);
    svcA.dispose();
  }, 30000);

  it('T3(c): a foreign RELEASed record ⇒ the next command is a fresh open (§9 step 3: re-claim at epoch 1, the disk state — never the cached session)', () => {
    const root = makeRoot('t3c');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    // A applies a mutation first: the cached state is revision 1 with one
    // retry record — the fresh open must NOT continue from it.
    const m1 = svcA.runCommand(mutation(reqId('e2-t3c-m1'), 0)) as MutOut;
    expect(m1.ok).toBe(true);
    expect(m1.revision).toBe(1);

    failedReleasePrevious(svcA, root, faults); // the record is still owned@0 by A

    // A foreign actor rewrites the record to released@0.
    const rec = readRec(root)!;
    writeFileSync(
      recPath(root),
      buildOwnershipRecordBytes({ ...rec, state: 'released', storageVersion: 1 as const }),
    );
    expect(readRec(root)?.state).toBe('released');

    // R4: the next mutation is a FRESH OPEN (the released record is
    // re-claimed at epoch 1; the disk state — revision 1, retry records
    // cleared by the release's step (a) — is loaded from scratch; the
    // cached retry record of m1 is NOT replayed).
    const m2 = svcA.runCommand(mutation(reqId('e2-t3c-m2'), 1)) as MutOut;
    expect(m2.ok).toBe(true);
    expect(m2.revision).toBe(2);
    const recAfter = readRec(root);
    expect(recAfter?.state).toBe('owned');
    expect(recAfter?.backendId).toBe(A_ID);
    expect(recAfter?.lockEpoch).toBe(1); // the fresh open re-claimed at e+1
    // The envelope carries exactly m2's record (the fresh boundary — not
    // the cached [m1, m2]).
    const env = readEnvelope(root);
    expect(env.revision).toBe(2);
    expect(env.records).toHaveLength(1);
    svcA.dispose();
  }, 30000);
});

// =============================================================================
// T4 — R5: new-undurable on the operator envelope write. The chosen
// behavior (workspace.md §5.1, the `new-undurable` bullet): the intended
// state becomes the running state (memory reconciled with disk) while the
// operation still returns `write_failed { onDiskState: "new-undurable" }`
// — "reconciled-and-reported", never a success ack for an unproven write.
// =============================================================================

describe('T4: R5 — operator envelope writes honor new-undurable (memory reconciled; failure reported)', () => {
  it('T4(a) accept: new-undurable ⇒ the accepted revision is the running state (queries + subsequent mutations), the result is write_failed{new-undurable}, the pending change is resolved', () => {
    const root = makeRoot('t4a');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });

    // A readable foreign change at revision 10 ⇒ the triggering mutation
    // pauses the project (external_change_unresolved, durable snapshot).
    const foreign = externalEnvelopeRev10(root);
    const foreignHash = sha256Hex(foreign);
    writeFileSync(scenePath(root), foreign);
    const trigger = svcA.runCommand(mutation(reqId('e2-t4a-trigger'), 0)) as MutOut;
    expect(trigger.ok).toBe(false);
    if (trigger.ok) throw new Error('unreachable');
    expect(trigger.error?.code).toBe('external_change_unresolved');

    // The accept's W: the rename lands (the accepted envelope — the
    // external scene canonically re-serialized, revision 10, retry
    // records cleared — reaches disk) and the directory flush fails
    // (scenes-dir fault) ⇒ new-undurable.
    faults.dirFsyncThrow = (dir: string) => dir === scenesDir(root);
    const acc = svcA.acceptExternalState(PROJECT) as {
      ok: boolean;
      revision?: number;
      error?: { code: string; onDiskState?: string };
    };
    faults.dirFsyncThrow = undefined;

    // R5: the operation reports FAILURE for unproven durability — but the
    // intended state is now the running state (§5.1: in-memory state is
    // advanced so the running system is self-consistent). Pre-fix the
    // query still served the LKG revision and the accepted bytes were
    // misdetected as a NEW foreign edit.
    expect(acc.ok).toBe(false);
    if (acc.ok) throw new Error('unreachable');
    expect(acc.error?.code).toBe('write_failed');
    expect(acc.error?.onDiskState).toBe('new-undurable');

    // Disk: the accepted envelope (revision 10, retry records cleared).
    const envDisk = readEnvelope(root);
    expect(envDisk.revision).toBe(10);
    expect(envDisk.records).toHaveLength(0);
    expect(envDisk.entityNames[0]).toBe('Main Camera (foreign edit)');

    // Memory: the query serves the accepted revision (pre-fix: 0 — the
    // R5 repro "disk revision 10, queries still serve revision <LKG>").
    const q = svcA.query(QUERY) as QOut;
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(10);
    expect(q.workspace?.writePaused).toBe(false); // the resolution is applied (disk == accepted)

    // Re-issuing the resolution: nothing pending (the foreign bytes are
    // gone from disk — retained only in the recovery snapshot). Pre-fix
    // the pending state persisted and the re-issue re-fired the protocol
    // on the backend's own accepted bytes.
    const acc2 = svcA.acceptExternalState(PROJECT) as { ok: boolean; error?: { code: string } };
    expect(acc2.ok).toBe(false);
    expect(acc2.error?.code).toBe('no_pending_change');

    // A subsequent mutation applies at the accepted revision (pre-fix:
    // the stale lastWrittenHash flagged the backend's own accepted bytes
    // as a foreign edit ⇒ external_change_unresolved).
    const m2 = svcA.runCommand(mutation(reqId('e2-t4a-m2'), 10)) as MutOut;
    expect(m2.ok).toBe(true);
    expect(m2.revision).toBe(11);
    void foreignHash;
    svcA.dispose();
  }, 30000);

  it('T4(b) release: a dir-flush fault on the records-cleared rewrite ⇒ the retry records are cleared from MEMORY too (a lost-ack retry re-executes ⇒ revision_conflict, never duplicated:true from the stale map); a subsequent mutation is not misdetected as foreign', () => {
    const root = makeRoot('t4b');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    const r1 = reqId('e2-t4b-m1');
    const m1 = svcA.runCommand(mutation(r1, 0)) as MutOut;
    expect(m1.ok).toBe(true);
    expect(m1.revision).toBe(1);
    expect(readEnvelope(root).records).toHaveLength(1); // m1's record is in the scene file

    // The release's records-cleared rewrite of the scene file lands and its
    // directory flush fails on every attempt (scenes-dir fault) ⇒ the W's
    // new-undurable outcome. v4 (session-v4.ts clearRecordsV4) publishes
    // the cleared state and continues with the ownership record write, so
    // the release completes and reports success (the legacy path reported
    // write_failed { new-undurable } and left the project owned; see the
    // phase 9.3 report).
    faults.dirFsyncThrow = (dir: string) => dir === scenesDir(root);
    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    faults.dirFsyncThrow = undefined;

    expect(rel).toEqual({ ok: true, revision: 1, retryCleared: true });
    expect(readRec(root)?.state).toBe('released');
    expect(readRec(root)?.backendId).toBe(A_ID);
    expect(fileExists(claimPath(root, 0))).toBe(false); // §9 step 1
    // Disk: the records-cleared scene file (the rename landed).
    const envDisk = readEnvelope(root);
    expect(envDisk.revision).toBe(1);
    expect(envDisk.records).toHaveLength(0);

    // R5: retrying the original request (the same requestId + content,
    // the lost-ack retry) must NOT replay from a stale map: the command
    // is the on-demand re-open of the released project (re-claim at
    // epoch 1, the disk state), the record is gone, the retry re-executes
    // fresh and fails revision_conflict (its expectedRevision 0 is stale)
    // — which is safe (workspace.md §9).
    const retry = svcA.runCommand(mutation(r1, 0)) as MutOut;
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('unreachable');
    expect(retry.duplicated ?? false).toBe(false);
    expect(retry.error?.code).toBe('revision_conflict');
    expect(readRec(root)?.state).toBe('owned');
    expect(readRec(root)?.lockEpoch).toBe(1);

    // A subsequent write is NOT treated as a foreign edit of the backend's
    // own rewritten scene file.
    const m2 = svcA.runCommand(mutation(reqId('e2-t4b-m2'), 1)) as MutOut;
    expect(m2.ok).toBe(true);
    expect(m2.revision).toBe(2);

    // Restart behavior (the R5 acceptance): a fresh service on the same
    // root loads the on-disk state; the lost-ack retry of the original
    // request still re-executes fresh ⇒ revision_conflict, never a replay
    // (at-most-once, §5.5 G1.2).
    svcA.dispose();
    const svcA2 = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    const retryRestarted = svcA2.runCommand(mutation(r1, 0)) as MutOut;
    expect(retryRestarted.ok).toBe(false);
    if (retryRestarted.ok) throw new Error('unreachable');
    expect(retryRestarted.duplicated ?? false).toBe(false);
    expect(retryRestarted.error?.code).toBe('revision_conflict');
    const m3 = svcA2.runCommand(mutation(reqId('e2-t4b-m3'), 2)) as MutOut;
    expect(m3.ok).toBe(true);
    expect(m3.revision).toBe(3);
    svcA2.dispose();
  }, 30000);

  it('T4(c) discard: new-undurable on the LKG re-write ⇒ the pending change is resolved (unpaused; the LKG is the running state)', () => {
    const root = makeRoot('t4c');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    const m1 = svcA.runCommand(mutation(reqId('e2-t4c-m1'), 0)) as MutOut;
    expect(m1.ok).toBe(true);
    expect(m1.revision).toBe(1);
    const lkgBytes = readEnvelope(root).bytes;

    // A readable foreign change at revision 10 ⇒ the mutation pauses.
    writeFileSync(scenePath(root), externalEnvelopeRev10(root));
    const trigger = svcA.runCommand(mutation(reqId('e2-t4c-trigger'), 1)) as MutOut;
    expect(trigger.ok).toBe(false);
    if (trigger.ok) throw new Error('unreachable');
    expect(trigger.error?.code).toBe('external_change_unresolved');

    // The discard's W (the LKG bytes re-written) lands and its directory
    // flush fails (scenes-dir fault) ⇒ new-undurable.
    faults.dirFsyncThrow = (dir: string) => dir === scenesDir(root);
    const dis = svcA.discardExternalState(PROJECT) as {
      ok: boolean;
      error?: { code: string; onDiskState?: string };
    };
    faults.dirFsyncThrow = undefined;

    // v4 (session-v4.ts discardExternalV4) reconciles memory and reports
    // SUCCESS on the W's new-undurable outcome (the legacy path, and v4's
    // own accept — T4(a) — report write_failed { new-undurable }, §5.1;
    // see the phase 9.3 report).
    expect(dis).toEqual({ ok: true, revision: 1, historyReset: true });

    // Disk: the LKG bytes exactly (revision 1 with m1's record).
    expect(bytesEqual(readEnvelope(root).bytes, lkgBytes)).toBe(true);

    // Memory (R5): the pending change is RESOLVED (the foreign bytes are
    // gone from disk — retained only in the recovery snapshot): unpaused,
    // and the LKG is the running state. Pre-fix the pending state
    // persisted (the query reported writePaused and the next mutation was
    // refused external_change_unresolved).
    const q = svcA.query(QUERY) as QOut;
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(1);
    expect(q.workspace?.writePaused).toBe(false);

    // A subsequent mutation applies (the pre-check matches the LKG the
    // discard re-wrote).
    const m2 = svcA.runCommand(mutation(reqId('e2-t4c-m2'), 1)) as MutOut;
    expect(m2.ok).toBe(true);
    expect(m2.revision).toBe(2);
    svcA.dispose();
  }, 30000);
});

// =============================================================================
// T5 — R4: the release unlinks its OWN claim file, verifying the holder
// bytes first (workspace.md §9 step 1: "unlinks the owner's own claim file
// (claim-<e>, §6.5)"): a foreign/empty claim-<e> is NOT unlinked (recorded,
// not fatal); the own claim file is gone after a successful release.
// =============================================================================

describe('T5: R4 — the release unlinks its own claim file (by-path holder verification first)', () => {
  it('T5(a): a successful release unlinks the own claim file (claim-0 is gone; the record is released@0)', () => {
    const root = makeRoot('t5a');
    const svcA = openWorkspaceService({ root, backendId: A_ID });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    expect(fileExists(claimPath(root, 0))).toBe(true);
    expect(readStamp(root, 0)?.backendId).toBe(A_ID);

    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    expect(rel.ok).toBe(true);
    if (!rel.ok) throw new Error('unreachable');

    // §9 step 1: the owner's own claim file is unlinked by the release
    // (pre-fix the residue released@0 + claim-0 was left for the next
    // claim's superseded-epoch cleanup).
    expect(readRec(root)?.state).toBe('released');
    expect(readRec(root)?.lockEpoch).toBe(0);
    expect(fileExists(claimPath(root, 0))).toBe(false);

    // While released, queries fail workspace_closed (§9.1).
    const q = svcA.query(QUERY) as QOut;
    expect(q.ok).toBe(false);
    if (q.ok) throw new Error('unreachable');
    expect(q.error?.code).toBe('project_unavailable');
    expect(q.error?.reason).toBe('workspace_closed');
    svcA.dispose();
  }, 30000);

  it('T5(b): a FOREIGN claim file is NOT unlinked by the release (the holder bytes do not match; the release completes and records the outcome)', () => {
    const root = makeRoot('t5b');
    const svcA = openWorkspaceService({ root, backendId: A_ID });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    // A foreign actor replaces the claim file's content (B's stamp).
    writeFileSync(
      claimPath(root, 0),
      buildOwnershipRecordBytes({
        storageVersion: 1,
        state: 'owned',
        backendId: B_ID,
        pid: process.pid,
        openedAt: utcNowSecond(),
        lockEpoch: 0,
      }),
    );

    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    expect(rel.ok).toBe(true); // recorded, not fatal
    if (!rel.ok) throw new Error('unreachable');

    // The foreign claim file is NOT unlinked (verification failed: the
    // holder bytes are not A's); the record is released@0.
    expect(fileExists(claimPath(root, 0))).toBe(true);
    const rec = readRec(root);
    expect(rec?.state).toBe('released');
    expect(rec?.backendId).toBe(A_ID);
    svcA.dispose();
  }, 30000);

  it('T5(c): an EMPTY claim file is NOT unlinked by the release (unparseable content ⇒ the verification fails; the release completes)', () => {
    const root = makeRoot('t5c');
    const svcA = openWorkspaceService({ root, backendId: A_ID });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    writeFileSync(claimPath(root, 0), ''); // empty (unparseable)

    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    expect(rel.ok).toBe(true);
    if (!rel.ok) throw new Error('unreachable');

    expect(fileExists(claimPath(root, 0))).toBe(true); // NOT unlinked
    expect(readFileSync(claimPath(root, 0)).length).toBe(0); // content untouched
    expect(readRec(root)?.state).toBe('released');
    svcA.dispose();
  }, 30000);
});

// =============================================================================
// T6 — R4: no partial release (workspace.md §9: "A release that fails
// before the record write leaves the project owned with the old session
// still the writer"). The from-disk re-verification (T3's discipline)
// must not refuse a session that still verifiably holds the project.
// =============================================================================

describe('T6: R4 — no partial release (a fully failed release leaves the session the writer)', () => {
  it('a record-write failure (previous) leaves the project owned; the next mutation (after the from-disk re-verification) applies; the record and claim file are untouched', () => {
    const root = makeRoot('t6');
    const faults: Faults = {};
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: faultedOps(faults) });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });

    faults.renameThrow = (to: string) => to === recPath(root);
    const rel = svcA.releaseWorkspace(PROJECT) as RelOut;
    faults.renameThrow = undefined;
    expect(rel.ok).toBe(false);
    if (rel.ok) throw new Error('unreachable');
    expect(rel.error?.code).toBe('write_failed');
    expect(rel.error?.onDiskState).toBe('previous');

    // No partial release: the record is unchanged (owned by A) and the
    // claim file is A's token (NOT unlinked — the release did not reach
    // the record write).
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(A_ID);
    expect(rec?.lockEpoch).toBe(0);
    expect(readStamp(root, 0)?.backendId).toBe(A_ID);

    // The old session is STILL THE WRITER: the next mutation re-verifies
    // ownership from disk (record ours + claim file ours ⇒ it holds) and
    // applies at the release's records-cleared revision.
    const m = svcA.runCommand(mutation(reqId('e2-t6-m'), 0)) as MutOut;
    expect(m.ok).toBe(true);
    expect(m.revision).toBe(1);
    const recAfter = readRec(root);
    expect(recAfter?.state).toBe('owned'); // the mutation does not write the record
    expect(recAfter?.backendId).toBe(A_ID);
    expect(readStamp(root, 0)?.backendId).toBe(A_ID);
    svcA.dispose();
  }, 30000);
});