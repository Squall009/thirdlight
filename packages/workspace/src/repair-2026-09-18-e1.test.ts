/**
 * 2026-09-18 review repair — group E1 (R9) regression tests: the amended
 * §6.3 exclusive claim-file primitive replaces the rename+verify claim.
 *
 * Finding (docs/reviews/2026-09-18-commits.md, R9, CONTRACT BLOCKER):
 * rename + verification does not establish exclusive ownership.
 * Deterministic interleaving through the public WriteOps seam: A pauses
 * before its ownership rename, B claims and verifies, A resumes and
 * overwrites B — BOTH opens succeed and both sessions remain open
 * (`CLAIM_RACE {a:true,b:true}`). The repaired mechanism (workspace.md
 * §6.2/§6.3, applied diff `dabfcff`): the exclusive gate is the
 * epoch-scoped claim file `.thirdlight/claim-<e>` created with
 * O_CREAT|O_EXCL (serialized by the kernel per path — the ONLY exclusion
 * gate); the record is the identity/audit layer. The claim is the
 * six-step sequence (acquire / durable stamp / pre-record verification /
 * record W / verification re-read of BOTH files / consistency), with the
 * §6.2 self-reclaim row, the §6.3 orphan-recovery rule (the only
 * liveness-referenced path: a parseable claim file whose holder pid is
 * proven dead may be reclaimed; anything else ⇒ `claim_inconsistent`),
 * and the superseded-epoch cleanup (a successful claim at e+1 unlinks
 * claim-e best-effort after its record W is durable).
 *
 * These are the single-process seam tests (mandatory tests T1, T4, T5,
 * T6 of docs/handoffs/2026-09-18-contract-request.md §5). The interleaving
 * is driven through the public `ops` (WriteOps) seam exactly like the
 * §1 probe's `openTempFile` hook: the claim-file open is the
 * O_CREAT|O_EXCL call of the same primitive (`openTempFile`), and the
 * post-stamp / post-record-rename windows are hooked through
 * `writeAll`/`renameFile`. Real filesystem, disposable `mkdtemp` roots.
 * The real two-process barrier tests (T2) and the real SIGKILL crash
 * tests (T3) live in tests/ownership-claim-2026-09-18.test.ts (node:
 * child_process is a forbidden package edge — dependencies.md §4.1).
 *
 * Contract-vs-§5 wording discrepancies (recorded; the §6.3 text wins):
 *  - Request doc §5.1(a) says B re-reads "the record (A's, live)" and
 *    fails `ownership_conflict` (holder A); in schedule (a) A has NOT
 *    written the record (it pauses before its content stamp) — the §6.3
 *    orphan-recovery rule applies instead: absent record + empty
 *    (unparseable) claim file ⇒ `claim_inconsistent` (holder null).
 *  - The task's T1(b) wording expects `ownership_conflict` (holder A) for
 *    "A stamped claim-0, record absent, B attempts"; the §6.2 absent row
 *    + §6.3 orphan-recovery rule prescribe `claim_inconsistent` (holder
 *    null) for a parseable claim file whose holder is NOT proven dead
 *    (A's pid is the live test process). The tests assert the §6.3
 *    outcome.
 */

import { mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService, type WriteOps } from '@thirdlight/workspace';
import { defaultOps } from './write';
import { sha256Hex } from './digest';

// ---- disposable roots (mkdtemp data roots; cleaned per test + backstop) ---

const PROJECT = 'demo-0001';

/** A syntactically valid requestId (commands.md §6: `req-` + 32 hex), unique per tag. */
function reqId(tag: string): string {
  return `req-${sha256Hex(new TextEncoder().encode(tag)).slice(0, 32)}`;
}

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `tl07e1-${tag}-`));
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

function seedProject(root: string): string {
  // A real project on disk (created through the operator API) with its
  // ownership state removed: the race starts from a fresh unclaimed
  // project (record absent, no claim file) — the same on-disk state the
  // root crash tests' fixture seed produces, without a fixture-path
  // dependency (node:url is not an allowed package edge, even for test
  // files — dependencies.md §4.1). The created project is at revision 0.
  const s = openWorkspaceService({ root });
  expect(s.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
  s.dispose();
  defaultOps.removeFile(recPath(root));
  defaultOps.removeFile(claimPath(root, 0));
  expect(fileExists(recPath(root))).toBe(false);
  expect(fileExists(claimPath(root, 0))).toBe(false);
  return root;
}

// ---- identities (the record format is strict: tb- + 32 lowercase hex) ---

const A_ID = 'tb-aaaa1111aaaa1111aaaa1111aaaa1111';
const B_ID = 'tb-bbbb2222bbbb2222bbbb2222bbbb2222';
const S_ID = 'tb-cccc3333cccc3333cccc3333cccc3333';

// ---- on-disk evidence helpers ------------------------------------------------

const recPath = (root: string): string =>
  join(root, 'projects', PROJECT, '.thirdlight', 'ownership.json');
const claimPath = (root: string, e: number): string =>
  join(root, 'projects', PROJECT, '.thirdlight', `claim-${e}`);

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
    return null; // absent (or unreadable — these tests only produce absence)
  }
}

function readStamp(root: string, e: number): { backendId: string; pid: number; openedAt: string } | null {
  try {
    return JSON.parse(readFileSync(claimPath(root, e), 'utf8')) as { backendId: string; pid: number; openedAt: string };
  } catch {
    return null;
  }
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

/** The seeded project is at revision 0 (the created default scene). */
function mutation(requestId: string, expectedRevision: number) {
  return {
    op: 'createEntity',
    projectId: PROJECT,
    expectedRevision,
    requestId,
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args: { kind: 'box', name: `Box ${requestId}` },
  };
}

function createEntityMutation(requestId: string, expectedRevision: number) {
  return {
    op: 'createEntity',
    projectId: PROJECT,
    expectedRevision,
    requestId,
    args: { kind: 'box', name: 'Box E1' },
  };
}

interface QueryOut {
  ok: boolean;
  revision?: number;
  error?: {
    code: string;
    reason?: string;
    holder?: { backendId: string; pid: number; state: string } | null;
    details?: { code: string; path: string; message: string; found?: unknown }[];
  };
}
interface MutOut {
  ok: boolean;
  revision?: number;
  duplicated?: boolean;
  error?: { code: string; reason?: string };
}

type Svc = ReturnType<typeof openWorkspaceService>;

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// =============================================================================
// T1 — deterministic seam interleaving (three schedules, single process, the
// claim-file open seam as the hook) ⇒ exactly one winner.
// =============================================================================

describe('T1: claim-file open seam interleaving (workspace.md §6.3 single-winner)', () => {
  it('T1(a): A acquires claim-0, B full-claims before A stamps ⇒ B claim_inconsistent (holder null); A owns; the loser is refused end-to-end', () => {
    const root = makeRoot('t1a');
    seedProject(root);
    const c0 = claimPath(root, 0);

    const svcB = openWorkspaceService({ root, backendId: B_ID });
    let bQuery: unknown = null;
    // A's ops seam: the claim-file open (O_CREAT|O_EXCL) succeeds, then B's
    // FULL claim runs before A writes its content stamp.
    const opsA: WriteOps = {
      ...defaultOps,
      openTempFile: (p: string): number => {
        if (p === c0) {
          const fd = openSync(p, 'wx', 0o644); // A acquires claim-0
          bQuery = svcB.query({ op: 'queryProject', projectId: PROJECT });
          return fd;
        }
        return defaultOps.openTempFile(p);
      },
    };
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: opsA });
    const a = svcA.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;

    // Exactly one winner — the old probe's CLAIM_RACE {a:true,b:true} is the
    // failing regression (expected {a:true,b:false}).
    expect(a.ok).toBe(true);
    const b = bQuery as QueryOut;
    expect(b.ok).toBe(false);
    // §6.3 orphan-recovery rule: the record is ABSENT and A's claim file is
    // empty (unstamped) ⇒ unparseable ⇒ claim_inconsistent (holder null).
    // (The request doc §5.1(a) wording — "the record (A's, live)" ⇒
    // ownership_conflict — disagrees with the §6.3 text for this schedule;
    // the §6.3 text wins, recorded in the handoff.)
    expect(b.error?.code).toBe('project_unavailable');
    expect(b.error?.reason).toBe('claim_inconsistent');
    expect(b.error?.holder ?? null).toBeNull();

    // On-disk record is A's; the claim file is A's durable stamp.
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(A_ID);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.lockEpoch).toBe(0);
    const stamp = readStamp(root, 0);
    expect(stamp?.backendId).toBe(A_ID);
    expect(stamp?.pid).toBe(process.pid);

    // The loser is not open: its mutation is refused end-to-end (the re-
    // open now sees A's live record ⇒ ownership_conflict, holder A).
    const bm = svcB.runCommand(mutation(reqId('e1-t1a-b'), 0)) as MutOut;
    expect(bm.ok).toBe(false);
    expect(bm.error?.code).toBe('project_unavailable');
    expect(bm.error?.reason).toBe('ownership_conflict');
    // The winner serves.
    const am = svcA.runCommand(mutation(reqId('e1-t1a-a'), 0)) as MutOut;
    expect(am.ok).toBe(true);
    expect(am.revision).toBe(1);
    svcA.dispose();
    svcB.dispose();
  }, 30000);

  it('T1(b): A acquires + stamps, pauses before the record W ⇒ B refuses (contract: claim_inconsistent — the holder is not proven dead); A owns', () => {
    const root = makeRoot('t1b');
    seedProject(root);
    const c0 = claimPath(root, 0);

    const svcB = openWorkspaceService({ root, backendId: B_ID });
    let bQuery: unknown = null;
    let claimFd: number | null = null;
    // A's ops seam: A acquires + stamps claim-0; B's full claim runs in
    // the post-stamp window, BEFORE A's record W.
    const opsA: WriteOps = {
      ...defaultOps,
      openTempFile: (p: string): number => {
        if (p === c0) {
          claimFd = openSync(p, 'wx', 0o644);
          return claimFd;
        }
        return defaultOps.openTempFile(p);
      },
      writeAll: (fd: number, bytes: Uint8Array): void => {
        defaultOps.writeAll(fd, bytes);
        if (fd === claimFd) {
          // The stamp is written (durable after the fsync that follows).
          bQuery = svcB.query({ op: 'queryProject', projectId: PROJECT });
        }
      },
    };
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: opsA });
    const a = svcA.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;

    expect(a.ok).toBe(true);
    const b = bQuery as QueryOut;
    expect(b.ok).toBe(false);
    expect(b.error?.code).toBe('project_unavailable');
    // §6.2 absent row + §6.3 orphan-recovery rule: the record is absent
    // and claim-0's content parses to A's identity — a LIVE pid (the test's
    // own process) — so the holder is NOT proven dead ⇒ refuse ⇒
    // claim_inconsistent (holder null; the liveness outcome is reported).
    // (The task's T1(b) wording expected ownership_conflict (holder A);
    // the §6.3 text prescribes claim_inconsistent for this schedule — the
    // discrepancy is recorded in the handoff.)
    expect(b.error?.reason).toBe('claim_inconsistent');
    expect(b.error?.holder ?? null).toBeNull();

    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(A_ID);
    expect(rec?.lockEpoch).toBe(0);

    const bm = svcB.runCommand(mutation(reqId('e1-t1b-b'), 0)) as MutOut;
    expect(bm.ok).toBe(false);
    expect(bm.error?.code).toBe('project_unavailable');
    expect(bm.error?.reason).toBe('ownership_conflict');
    const am = svcA.runCommand(mutation(reqId('e1-t1b-a'), 0)) as MutOut;
    expect(am.ok).toBe(true);
    svcA.dispose();
    svcB.dispose();
  }, 30000);

  it('T1(c): A completes fully before B attempts ⇒ B EEXISTs, the record is A (live) ⇒ ownership_conflict (holder A)', () => {
    const root = makeRoot('t1c');
    seedProject(root);

    const svcA = openWorkspaceService({ root, backendId: A_ID });
    const a = svcA.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;
    expect(a.ok).toBe(true);

    const svcB = openWorkspaceService({ root, backendId: B_ID });
    const b = svcB.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;
    expect(b.ok).toBe(false);
    expect(b.error?.code).toBe('project_unavailable');
    expect(b.error?.reason).toBe('ownership_conflict');
    expect(b.error?.holder?.backendId).toBe(A_ID);
    expect(b.error?.holder?.pid).toBe(process.pid);
    expect(b.error?.holder?.state).toBe('owned');

    // The loser is refused end-to-end; the winner serves.
    const bm = svcB.runCommand(mutation(reqId('e1-t1c-b'), 0)) as MutOut;
    expect(bm.ok).toBe(false);
    expect(bm.error?.code).toBe('project_unavailable');
    expect(bm.error?.reason).toBe('ownership_conflict');
    const am = svcA.runCommand(mutation(reqId('e1-t1c-a'), 0)) as MutOut;
    expect(am.ok).toBe(true);
    expect(am.revision).toBe(1);

    const rec = readRec(root);
    expect(rec?.backendId).toBe(A_ID);
    expect(rec?.lockEpoch).toBe(0);
    svcA.dispose();
    svcB.dispose();
  }, 30000);
});

// =============================================================================
// T4 — release crash (claim side only): the on-disk residue released@e +
// claim-e ⇒ the next claim at e+1 succeeds and the superseded-epoch cleanup
// unlinks claim-e; exactly one active writer.
// =============================================================================

describe('T4: superseded-epoch cleanup over a released@e + claim-e residue (workspace.md §6.3/§6.5)', () => {
  it('a released record with its claim-file residue is claimed at e+1; claim-e is unlinked; the released session refuses', () => {
    const root = makeRoot('t4');
    const svcA = openWorkspaceService({ root, backendId: A_ID });
    expect(svcA.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    expect(svcA.releaseWorkspace(PROJECT)).toEqual({ ok: true, revision: 0, retryCleared: true });

    // The residue (the release-side claim-file unlink is group E2's scope —
    // the real release leaves it): released@0 + claim-0.
    const rec0 = readRec(root);
    expect(rec0?.state).toBe('released');
    expect(rec0?.lockEpoch).toBe(0);
    expect(rec0?.backendId).toBe(A_ID);
    expect(fileExists(claimPath(root, 0))).toBe(true);

    // The next claim at epoch 1 succeeds and unlinks the superseded claim-0.
    const svcB = openWorkspaceService({ root, backendId: B_ID });
    const b = svcB.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;
    expect(b.ok).toBe(true);

    const rec1 = readRec(root);
    expect(rec1?.state).toBe('owned');
    expect(rec1?.backendId).toBe(B_ID);
    expect(rec1?.lockEpoch).toBe(1);
    expect(fileExists(claimPath(root, 0))).toBe(false); // unlinked (cleanup)
    expect(fileExists(claimPath(root, 1))).toBe(true); // B's token
    expect(readStamp(root, 1)?.backendId).toBe(B_ID);
    expect(readStamp(root, 1)?.pid).toBe(process.pid);

    // Exactly one active writer: the released session refuses; the new
    // owner serves.
    const am = svcA.runCommand(createEntityMutation(reqId('e1-t4-a'), 0)) as MutOut;
    expect(am.ok).toBe(false);
    expect(am.error?.code).toBe('project_unavailable');
    expect(am.error?.reason).toBe('ownership_conflict');
    const bm = svcB.runCommand(createEntityMutation(reqId('e1-t4-b'), 0)) as MutOut;
    expect(bm.ok).toBe(true);
    expect(bm.revision).toBe(1);
    svcA.dispose();
    svcB.dispose();
  }, 30000);
});

// =============================================================================
// T5 — self-reclaim: a same-process reopen of its own owned record does not
// fail on its own claim file (no self-conflict; the record is unchanged; the
// session serves). Tampered/deleted claim-file content ⇒ ownership_conflict
// (holder null) and the session refuses to serve.
// =============================================================================

describe('T5: self-reclaim (workspace.md §6.2 row)', () => {
  it('same-process reopen serves with a byte-identical record; tampered or deleted claim file ⇒ conflict (holder null), refused end-to-end', () => {
    const root = makeRoot('t5');
    const s1 = openWorkspaceService({ root, backendId: S_ID });
    expect(s1.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    const frozen = readFileSync(recPath(root));
    expect(fileExists(claimPath(root, 0))).toBe(true);
    s1.dispose(); // discard the in-memory state (the record + claim file persist)

    // Self-reclaim: the session does NOT re-run O_CREAT|O_EXCL against its
    // own claim file (it would EEXIST against itself); it re-verifies the
    // claim content. No self-conflict; the record is byte-identical (no
    // write); the session serves.
    const s2 = openWorkspaceService({ root, backendId: S_ID });
    const q2 = s2.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;
    expect(q2.ok).toBe(true);
    expect(bytesEqual(readFileSync(recPath(root)), frozen)).toBe(true);
    const m2 = s2.runCommand(createEntityMutation(reqId('e1-t5-1'), 0)) as MutOut;
    expect(m2.ok).toBe(true);
    expect(m2.revision).toBe(1);
    s2.dispose();

    // Tamper: the claim file's content is foreign (a different
    // backendId/pid) ⇒ the reopen fails with ownership_conflict (holder
    // null); the session refuses to serve (mutation refused end-to-end).
    const c0 = claimPath(root, 0);
    writeFileSync(c0, JSON.stringify({ backendId: B_ID, pid: 4242, openedAt: '2026-09-17T09:00:00Z' }, null, 2) + '\n');
    const s3 = openWorkspaceService({ root, backendId: S_ID });
    const q3 = s3.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;
    expect(q3.ok).toBe(false);
    expect(q3.error?.code).toBe('project_unavailable');
    expect(q3.error?.reason).toBe('ownership_conflict');
    expect(q3.error?.holder ?? null).toBeNull();
    const m3 = s3.runCommand(mutation(reqId('e1-t5-3'), 1)) as MutOut;
    expect(m3.ok).toBe(false);
    expect(m3.error?.code).toBe('project_unavailable');
    expect(m3.error?.reason).toBe('ownership_conflict');
    s3.dispose();

    // Same for a deleted claim file (missing content ⇒ conflict, holder null).
    unlinkSync(c0);
    const s4 = openWorkspaceService({ root, backendId: S_ID });
    const q4 = s4.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;
    expect(q4.ok).toBe(false);
    expect(q4.error?.code).toBe('project_unavailable');
    expect(q4.error?.reason).toBe('ownership_conflict');
    expect(q4.error?.holder ?? null).toBeNull();
    const m4 = s4.runCommand(mutation(reqId('e1-t5-4'), 1)) as MutOut;
    expect(m4.ok).toBe(false);
    expect(m4.error?.code).toBe('project_unavailable');
    expect(m4.error?.reason).toBe('ownership_conflict');
    s4.dispose();
  }, 30000);
});

// =============================================================================
// T6 — hostile unlink-recreate: a foreign actor unlinks and recreates
// claim-e with foreign content between our O_EXCL and our record write ⇒
// the §6.3 step-3 pre-record verification (foreign content before the
// check) — or, if it lands after that check, the step-5 final verification
// re-read — finds the claim file is not ours ⇒ the claim aborts with
// ownership_conflict; no double writer (the hostile actor completed no
// claim; exactly zero active writers until a clean claim succeeds).
// =============================================================================

describe('T6: hostile unlink-recreate of the claim file (workspace.md §6.3 step 3/5)', () => {
  const foreignStamp = (): string =>
    JSON.stringify({ backendId: B_ID, pid: 4242, openedAt: '2026-09-17T09:00:01Z' }, null, 2) + '\n';

  it('variant 1 — foreign content lands before the step-3 check ⇒ the claim aborts and NO record is written', () => {
    const root = makeRoot('t6a');
    seedProject(root);
    const c0 = claimPath(root, 0);
    let claimFd: number | null = null;
    let hooked = false;
    const opsA: WriteOps = {
      ...defaultOps,
      openTempFile: (p: string): number => {
        if (p === c0) {
          claimFd = defaultOps.openTempFile(p);
          return claimFd;
        }
        return defaultOps.openTempFile(p);
      },
      writeAll: (fd: number, bytes: Uint8Array): void => {
        defaultOps.writeAll(fd, bytes);
        if (fd === claimFd) {
          // The hostile actor: unlink + recreate claim-0 with foreign
          // content (after A's stamp, before A's step-3 verification read).
          defaultOps.removeFile(c0);
          writeFileSync(c0, foreignStamp());
          hooked = true;
        }
      },
    };
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: opsA });
    const a = svcA.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;

    expect(hooked).toBe(true);
    expect(a.ok).toBe(false);
    expect(a.error?.code).toBe('project_unavailable');
    expect(a.error?.reason).toBe('ownership_conflict');
    expect(a.error?.holder ?? null).toBeNull();
    // §6.3 step 3: NO record is written.
    expect(readRec(root)).toBeNull();
    // The claim file holds the foreign content (the hostile actor's).
    expect(readStamp(root, 0)?.backendId).toBe(B_ID);
    expect(readStamp(root, 0)?.pid).toBe(4242);
    // A does not serve: its mutation is refused end-to-end.
    const am = svcA.runCommand(mutation(reqId('e1-t6a'), 0)) as MutOut;
    expect(am.ok).toBe(false);
    expect(am.error?.code).toBe('project_unavailable');
    svcA.dispose();
  }, 30000);

  it('variant 2 — foreign content lands after the step-3 check (during the record W window) ⇒ the step-5 re-read aborts the claim; the residual is record@e (A) + foreign claim-e', () => {
    const root = makeRoot('t6b');
    seedProject(root);
    const c0 = claimPath(root, 0);
    let claimFd: number | null = null;
    let hooked = false;
    const opsA: WriteOps = {
      ...defaultOps,
      openTempFile: (p: string): number => {
        if (p === c0) {
          claimFd = defaultOps.openTempFile(p);
          return claimFd;
        }
        return defaultOps.openTempFile(p);
      },
      renameFile: (from: string, to: string): void => {
        defaultOps.renameFile(from, to);
        if (to === recPath(root)) {
          // The hostile actor, AFTER A's record rename (A's step-3 check
          // already passed with A's own content): unlink + recreate
          // claim-0 with foreign content before A's step-5 re-read.
          defaultOps.removeFile(c0);
          writeFileSync(c0, foreignStamp());
          hooked = true;
        }
      },
    };
    const svcA = openWorkspaceService({ root, backendId: A_ID, ops: opsA });
    const a = svcA.query({ op: 'queryProject', projectId: PROJECT }) as QueryOut;

    expect(hooked).toBe(true);
    expect(a.ok).toBe(false);
    expect(a.error?.code).toBe('project_unavailable');
    expect(a.error?.reason).toBe('ownership_conflict');
    expect(a.error?.holder ?? null).toBeNull();
    // The documented residual state (§6.3 step 5): record@0 with A's
    // identity + the foreign claim-0. A holds no ownership.
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(A_ID);
    expect(rec?.lockEpoch).toBe(0);
    expect(readStamp(root, 0)?.backendId).toBe(B_ID);
    // A does not serve: its mutation is refused end-to-end (the re-open is
    // the self-reclaim row: the claim file's content is foreign ⇒
    // ownership_conflict, holder null).
    const am = svcA.runCommand(mutation(reqId('e1-t6b'), 0)) as MutOut;
    expect(am.ok).toBe(false);
    expect(am.error?.code).toBe('project_unavailable');
    expect(am.error?.reason).toBe('ownership_conflict');
    svcA.dispose();
  }, 30000);
});
