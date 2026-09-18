/**
 * Packet 07 group E1 (R9) — real two-process barriers (T2) and real
 * SIGKILL crash-point tests (T3) for the amended §6.3 exclusive claim-file
 * primitive (workspace.md §6.2/§6.3/§6.4, applied diff `dabfcff`).
 *
 * Mandatory tests per docs/handoffs/2026-09-18-contract-request.md §5:
 *  T2 — two REAL node processes, file-gated so both act after the gate,
 *       sharing a disposable root (not mocks), for each of:
 *       - the ABSENT claim (fresh project, record absent),
 *       - the RELEASED claim (the owner created + released first),
 *       - the STALE claim (the owner is SIGKILLed, then both processes
 *         issue takeoverWorkspace after the gate):
 *       exactly one active writer — the winner's claim/takeover succeeds
 *       and its mutations reach base+1 then base+2 (the second proves the
 *       claim did not flap); the loser's open fails and a mutation issued
 *       from the loser is refused end-to-end; the on-disk record and
 *       claim files are the winner's (asserted byte-for-byte).
 *  T3 — SIGKILL crash points (real processes, kill -9 at gated marker
 *       points inside the child's claim sequence):
 *       (a) between the acquire and the content stamp ⇒ an empty orphan
 *           claim-e ⇒ the next claim ⇒ claim_inconsistent (the documented
 *           stuck state); after the operator (the test) removes the
 *           orphan file, the re-issued open succeeds;
 *       (b) after the content stamp, before the record W ⇒ an orphan with
 *           a proven-dead pid ⇒ the next claim RECLAIMS and succeeds (no
 *           operator step);
 *       (c) mid-record-write ⇒ the record is absent ⇒ the normal claim
 *           path (reclaim) succeeds.
 *       After each crash: the on-disk evidence (record bytes, claim
 *       files) is asserted — nothing else.
 *
 * These live under the repo-root tests/ (not a package) because
 * node:child_process is a forbidden edge for package code
 * (dependencies.md §4.1). The child runner
 * (tests/crash/ownership-child.ts, esbuild-bundled) drives the crash
 * points through the public WriteOps seam and the barrier through a gate
 * file. Never run against repo/user paths — always disposable mkdtemp
 * roots on ext4 (/home/dadmin), cleaned in finally (afterAll backstop).
 *
 * Loser-code nuance (recorded in the handoff): for the absent/released
 * scenarios the loser's open may surface `claim_inconsistent` when the
 * winner's record W has not yet landed at the loser's EEXIST re-read
 * (record still absent/released + the winner's claim file is held by a
 * LIVE pid ⇒ the orphan-recovery rule refuses); once the winner's record
 * is stable the loser's open surfaces `ownership_conflict` (the winner's
 * live record). Both are the contract's exactly-one-writer outcomes; the
 * tests accept both for the loser's open AND for the loser's re-issued
 * mutation (which can still race the winner's record W). The binding
 * invariants are: exactly one ok open; the loser never serves (its
 * mutation is always refused); the on-disk record + claim files are the
 * winner's.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { openWorkspaceService } from '@thirdlight/workspace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO_ROOT, 'fixtures', 'commands');
const PROJECT = 'demo-0001';

const ROOT_BASE = join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir());
let scratch: string;
let childBundle: string;
const roots: string[] = [];

// Contender identities (the record format is strict: tb- + 32 hex).
const ID1 = 'tb-aa11bb22cc33dd44ee55ff6677889900';
const ID2 = 'tb-00998877665544332211ffeeddccbbaa';
const OWNER_ID = 'tb-cccccccccccccccccccccccccccccccc';
const CRASH_ID = 'tb-dddddddddddddddddddddddddddddddd';

function makeRoot(tag: string): string {
  const r = join(ROOT_BASE, `.tl07e1-crash-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(r, { recursive: true });
  roots.push(r);
  return r;
}

function seedProject(root: string, projectId: string): string {
  const dir = join(root, 'projects', projectId);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    readFileSync(join(FIXTURES, 'scenarios', '01-retry-lost-ack', 'disk-before', 'project.json')),
  );
  writeFileSync(
    join(dir, 'scenes', 'main.json'),
    readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev5.json')),
  );
  return dir;
}

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
    return null;
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

interface ChildResult {
  done: boolean;
  pid: number;
  openOk: boolean;
  openResult: {
    ok: boolean;
    lockEpoch?: number;
    backendId?: string;
    revision?: number;
    error?: { code: string; reason?: string; holder?: { backendId: string; pid: number } | null };
  };
  m1: { ok: boolean; revision?: number; error?: { code: string; reason?: string } };
  m2: { ok: boolean; revision?: number; error?: { code: string; reason?: string } } | null;
}

interface ChildHandle {
  pid: number;
  state: { out: string; done: boolean };
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  done: Promise<ChildResult>;
  terminate: () => void;
  kill: (s: NodeJS.Signals) => void;
}

function spawnChild(args: string[]): ChildHandle {
  const c = spawn(process.execPath, [childBundle, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', done: false };
  c.stdout!.on('data', (d: string) => {
    state.out += d;
  });
  c.stderr!.on('data', (d: string) => {
    state.out += `[stderr]${d}`;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    c.on('exit', (code, signal) => {
      state.done = true;
      resolve({ code, signal });
    });
  });
  const done = new Promise<ChildResult>((resolve, reject) => {
    const timer = setInterval(() => {
      const i = state.out.lastIndexOf('{"done":true');
      if (i !== -1) {
        clearInterval(timer);
        try {
          resolve(JSON.parse(state.out.slice(i)) as ChildResult);
        } catch (e) {
          reject(e);
        }
      } else if (state.done) {
        clearInterval(timer);
        reject(new Error(`child exited without a done line (got: ${state.out.slice(-500)})`));
      }
    }, 25);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`child timed out waiting for the done line (got: ${state.out.slice(-500)})`));
    }, 40000);
  });
  // `done` is rejected when the child exits without a done line (e.g. a
  // claim-hold owner SIGKILLed by the parent): the no-op catch marks the
  // promise handled so never-awaited handles do not raise unhandled
  // rejections; awaited handles still receive the rejection.
  void done.catch(() => {
    /* not awaited by design (claim-hold / crash handles) */
  });
  return {
    pid: c.pid!,
    state,
    exit,
    done,
    terminate: () => c.kill('SIGTERM'),
    kill: (s) => c.kill(s),
  };
}

async function waitReady(h: ChildHandle, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (h.state.out.includes('"ready":true')) return;
    if (h.state.done) throw new Error(`child exited before ready (got: ${h.state.out.slice(-500)})`);
    if (Date.now() > deadline) throw new Error(`child did not become ready (got: ${h.state.out.slice(-500)})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Spawn a crashing child and wait for its death (or its not-hooked report). */
async function runCrashChild(root: string, backendId: string, point: string): Promise<{ signal: NodeJS.Signals | null; code: number | null; stdout: string; pid: number }> {
  const c = spawn(process.execPath, [childBundle, 'crash-claim', root, PROJECT, backendId, point], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout!.on('data', (d: string) => {
    out += d;
  });
  c.stderr!.on('data', (d: string) => {
    out += `[stderr]${d}`;
  });
  const res = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      reject(new Error(`crash child ${point} timed out (stdout=${out.slice(-500)})`));
    }, 20000);
    c.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  return { ...res, stdout: out, pid: c.pid! };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(ROOT_BASE, '.tl07e1-bundle-'));
  childBundle = join(scratch, 'ownership-child.bundle.mjs');
  await build({
    entryPoints: [join(REPO_ROOT, 'tests', 'crash', 'ownership-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: childBundle,
    logLevel: 'silent',
  });
}, 60000);

afterAll(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// =============================================================================
// T2 — real two-process barriers (exactly one active writer).
// =============================================================================

describe('T2: two real processes race the claim-file gate (workspace.md §6.3 single-winner)', () => {
  it('absent claim: fresh project (record absent) ⇒ exactly one winner; the loser is refused; the on-disk record + claim file are the winner', async () => {
    const root = makeRoot('absent');
    seedProject(root, PROJECT);
    const gate = join(root, 'gate');

    const c1 = spawnChild(['contend-open', root, PROJECT, ID1, gate, '5']);
    const c2 = spawnChild(['contend-open', root, PROJECT, ID2, gate, '5']);
    await waitReady(c1);
    await waitReady(c2);
    writeFileSync(gate, ''); // both act now
    const [r1, r2] = [await c1.done, await c2.done];

    // Exactly one active writer — the old rename+verify claim let BOTH
    // open (the CLAIM_RACE double-claim is the failing regression).
    const oks = [r1.openOk, r2.openOk];
    expect(oks.filter(Boolean)).toHaveLength(1);
    const w = r1.openOk ? r1 : r2;
    const l = r1.openOk ? r2 : r1;
    const winnerId = r1.openOk ? ID1 : ID2;

    // The winner's mutations reach base+1 then base+2 (no flap).
    expect(w.m1.ok).toBe(true);
    expect(w.m1.revision).toBe(6);
    expect(w.m2.ok).toBe(true);
    expect(w.m2.revision).toBe(7);
    // The loser's open failed (a live winner now holds the project)…
    expect(l.openOk).toBe(false);
    expect(l.openResult.error?.code).toBe('project_unavailable');
    expect(['ownership_conflict', 'claim_inconsistent']).toContain(l.openResult.error?.reason);
    // …and a mutation issued from the loser is refused end-to-end. The
    // re-issued open sees the winner's stable live record ⇒ conflict — or,
    // if the winner's record W has not yet landed at the re-read, the
    // record is still absent with the winner holding claim-0 (live pid)
    // ⇒ the orphan-recovery refusal (claim_inconsistent). Both are the
    // contract's exactly-one-writer outcomes; the loser never serves.
    expect(l.m1.ok).toBe(false);
    expect(l.m1.error?.code).toBe('project_unavailable');
    expect(['ownership_conflict', 'claim_inconsistent']).toContain(l.m1.error?.reason);

    // On-disk record + claim file are the winner's (assert the bytes).
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(winnerId);
    expect(rec?.pid).toBe(w.pid);
    expect(rec?.lockEpoch).toBe(0);
    const stamp = readStamp(root, 0);
    expect(stamp?.backendId).toBe(winnerId);
    expect(stamp?.pid).toBe(w.pid);
    expect(stamp?.openedAt).toBe(rec?.openedAt);

    c1.terminate();
    c2.terminate();
    await c1.exit;
    await c2.exit;
  }, 60000);

  it('released claim: the owner created + released first ⇒ exactly one winner at epoch 1; the superseded claim-0 residue is unlinked', async () => {
    const root = makeRoot('released');
    // The owner (a real service in this process) creates + releases first.
    const owner = openWorkspaceService({ root, backendId: OWNER_ID });
    expect(owner.createProject(PROJECT, 'Demo')).toEqual({ ok: true, created: true, revision: 0 });
    expect(owner.releaseWorkspace(PROJECT)).toEqual({ ok: true, revision: 0, retryCleared: true });
    // The residue (the release-side claim-file unlink is group E2's
    // scope — the real release leaves it): released@0 + claim-0.
    expect(readRec(root)?.state).toBe('released');
    expect(fileExists(claimPath(root, 0))).toBe(true);
    owner.dispose();

    const gate = join(root, 'gate');
    // The created project's default scene has no box-0001: the contender
    // mutations target the default scene's cam-main entity instead.
    const c1 = spawnChild(['contend-open', root, PROJECT, ID1, gate, '0', 'cam-main']);
    const c2 = spawnChild(['contend-open', root, PROJECT, ID2, gate, '0', 'cam-main']);
    await waitReady(c1);
    await waitReady(c2);
    writeFileSync(gate, '');
    const [r1, r2] = [await c1.done, await c2.done];

    const oks = [r1.openOk, r2.openOk];
    expect(oks.filter(Boolean)).toHaveLength(1);
    const w = r1.openOk ? r1 : r2;
    const l = r1.openOk ? r2 : r1;
    const winnerId = r1.openOk ? ID1 : ID2;

    // The winner claims at epoch 1 (released@0 + 1) and serves (the
    // released envelope is at revision 0).
    expect(w.m1.ok).toBe(true);
    expect(w.m1.revision).toBe(1);
    expect(w.m2.ok).toBe(true);
    expect(w.m2.revision).toBe(2);
    expect(l.openOk).toBe(false);
    expect(['ownership_conflict', 'claim_inconsistent']).toContain(l.openResult.error?.reason);
    // The loser's re-issued mutation is refused end-to-end (same two
    // contract-valid outcomes as above — the loser never serves).
    expect(l.m1.ok).toBe(false);
    expect(l.m1.error?.code).toBe('project_unavailable');
    expect(['ownership_conflict', 'claim_inconsistent']).toContain(l.m1.error?.reason);

    // On-disk: the winner's record at epoch 1, the winner's claim-1, and
    // the superseded claim-0 residue is unlinked by the winner's
    // superseded-epoch cleanup.
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(winnerId);
    expect(rec?.pid).toBe(w.pid);
    expect(rec?.lockEpoch).toBe(1);
    expect(readStamp(root, 1)?.backendId).toBe(winnerId);
    expect(readStamp(root, 1)?.pid).toBe(w.pid);
    expect(fileExists(claimPath(root, 0))).toBe(false);

    c1.terminate();
    c2.terminate();
    await c1.exit;
    await c2.exit;
  }, 60000);

  it('stale claim: the owner is SIGKILLed; both processes takeover after the gate ⇒ exactly one winner at epoch 1; the stale claim-0 is unlinked', async () => {
    const root = makeRoot('stale');
    seedProject(root, PROJECT);
    // The owner claims (epoch 0) in a real process and holds; the
    // parent then SIGKILLs it (the record is owned@owner — a dead pid;
    // claim-0 is the owner's stamp).
    const owner = spawnChild(['claim-hold', root, PROJECT, OWNER_ID]);
    await waitReady(owner);
    owner.kill('SIGKILL');
    await owner.exit;
    const rec0 = readRec(root);
    expect(rec0?.state).toBe('owned');
    expect(rec0?.backendId).toBe(OWNER_ID);
    expect(rec0?.lockEpoch).toBe(0);
    expect(fileExists(claimPath(root, 0))).toBe(true);

    const gate = join(root, 'gate');
    const c1 = spawnChild(['contend-takeover', root, PROJECT, ID1, gate, '5']);
    const c2 = spawnChild(['contend-takeover', root, PROJECT, ID2, gate, '5']);
    await waitReady(c1);
    await waitReady(c2);
    writeFileSync(gate, '');
    const [r1, r2] = [await c1.done, await c2.done];

    const oks = [r1.openOk, r2.openOk];
    expect(oks.filter(Boolean)).toHaveLength(1);
    const w = r1.openOk ? r1 : r2;
    const l = r1.openOk ? r2 : r1;
    const winnerId = r1.openOk ? ID1 : ID2;

    // The winner's explicit takeover claims at epoch 1 and serves.
    expect(w.openResult.ok).toBe(true);
    expect(w.openResult.lockEpoch).toBe(1);
    expect(w.openResult.backendId).toBe(winnerId);
    expect(w.m1.ok).toBe(true);
    expect(w.m1.revision).toBe(6);
    expect(w.m2.ok).toBe(true);
    expect(w.m2.revision).toBe(7);
    // The loser's takeover failed. The takeover failure is a TOP-LEVEL
    // error code (ownership_conflict — the winner's live record or a held
    // claim file — or stale_ownership — the stale record re-evaluated),
    // not a project_unavailable reason.
    expect(l.openOk).toBe(false);
    expect(['ownership_conflict', 'stale_ownership']).toContain(l.openResult.error?.code);
    // …and a mutation issued from the loser is refused end-to-end (the
    // loser's re-open is a fresh open: the winner's live record ⇒
    // conflict; if the winner's record W has not yet landed, the stale
    // record re-evaluates ⇒ stale_ownership — both refuse).
    expect(l.m1.ok).toBe(false);
    expect(l.m1.error?.code).toBe('project_unavailable');
    expect(['ownership_conflict', 'stale_ownership']).toContain(l.m1.error?.reason);

    // On-disk: the winner's record at epoch 1, the winner's claim-1, and
    // the stale owner's claim-0 is unlinked by the winner's
    // superseded-epoch cleanup.
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(winnerId);
    expect(rec?.pid).toBe(w.pid);
    expect(rec?.lockEpoch).toBe(1);
    expect(readStamp(root, 1)?.backendId).toBe(winnerId);
    expect(readStamp(root, 1)?.pid).toBe(w.pid);
    expect(fileExists(claimPath(root, 0))).toBe(false);

    c1.terminate();
    c2.terminate();
    await c1.exit;
    await c2.exit;
  }, 60000);
});

// =============================================================================
// T3 — SIGKILL crash points inside the claim sequence.
// =============================================================================

describe('T3: SIGKILL at the claim-file crash points (workspace.md §6.3/§6.5)', () => {
  it('T3(a): kill between the acquire and the content stamp ⇒ empty orphan claim-0 ⇒ the next claim fails claim_inconsistent; the operator removes the orphan ⇒ the re-issued open succeeds', async () => {
    const root = makeRoot('crasha');
    seedProject(root, PROJECT);
    const ex = await runCrashChild(root, CRASH_ID, 'before-stamp');
    expect(ex.signal).toBe('SIGKILL');

    // On-disk evidence: an EMPTY orphan claim-0; the record is absent.
    expect(readRec(root)).toBeNull();
    expect(() => readFileSync(claimPath(root, 0))).not.toThrow();
    expect(readFileSync(claimPath(root, 0)).length).toBe(0);

    // The next claim ⇒ claim_inconsistent (the documented stuck state:
    // the orphan's content is unparseable; nothing is claimed).
    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: PROJECT }) as {
      ok: boolean;
      error?: { code: string; reason?: string; holder?: unknown; details?: { code: string; path: string }[] };
    };
    expect(q.ok).toBe(false);
    expect(q.error?.code).toBe('project_unavailable');
    expect(q.error?.reason).toBe('claim_inconsistent');
    expect(q.error?.holder ?? null).toBeNull();
    expect(q.error?.details?.[0]?.path).toBe(claimPath(root, 0));
    // The mutation is refused the same way.
    const m = svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT,
      expectedRevision: 5,
      requestId: 'req-3a000000000000000000000000000001',
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as { ok: boolean; error?: { code: string; reason?: string } };
    expect(m.ok).toBe(false);
    expect(m.error?.reason).toBe('claim_inconsistent');
    svc.dispose();

    // Operator step: remove the orphan claim file; the re-issued open
    // succeeds.
    unlinkSync(claimPath(root, 0));
    const svc2 = openWorkspaceService({ root });
    const q2 = svc2.query({ op: 'queryProject', projectId: PROJECT }) as { ok: boolean };
    expect(q2.ok).toBe(true);
    const m2 = svc2.runCommand({
      op: 'setTransform',
      projectId: PROJECT,
      expectedRevision: 5,
      requestId: 'req-3a000000000000000000000000000002',
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as { ok: boolean; revision?: number };
    expect(m2.ok).toBe(true);
    expect(m2.revision).toBe(6);
    svc2.dispose();
  }, 45000);

  it('T3(b): kill after the content stamp, before the record W ⇒ orphan with a proven-dead pid ⇒ the next claim RECLAIMS and succeeds (no operator step)', async () => {
    const root = makeRoot('crashb');
    seedProject(root, PROJECT);
    const ex = await runCrashChild(root, CRASH_ID, 'after-stamp');
    expect(ex.signal).toBe('SIGKILL');

    // On-disk evidence: the record is absent; claim-0 carries the child's
    // stamp (a dead pid).
    expect(readRec(root)).toBeNull();
    const stamp = readStamp(root, 0);
    expect(stamp?.backendId).toBe(CRASH_ID);
    expect(stamp?.pid).toBe(ex.pid);

    // The next claim reclaims (the holder is proven dead under the §6.2
    // rules — /proc/<pid> is gone) and succeeds without an operator step.
    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: PROJECT }) as { ok: boolean };
    expect(q.ok).toBe(true);
    // The claim file is now the reclaimer's stamp (rewritten + fsynced).
    expect(readStamp(root, 0)?.pid).toBe(process.pid);
    expect(readStamp(root, 0)?.backendId).toBe(svc.backendId);
    const rec = readRec(root);
    expect(rec?.state).toBe('owned');
    expect(rec?.backendId).toBe(svc.backendId);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.lockEpoch).toBe(0);
    const m = svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT,
      expectedRevision: 5,
      requestId: 'req-3b000000000000000000000000000001',
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as { ok: boolean; revision?: number };
    expect(m.ok).toBe(true);
    expect(m.revision).toBe(6);
    svc.dispose();
  }, 45000);

  it('T3(c): kill mid-record-write (temp written, rename never lands) ⇒ the record is absent ⇒ the normal claim path (reclaim) succeeds', async () => {
    const root = makeRoot('crashc');
    seedProject(root, PROJECT);
    const ex = await runCrashChild(root, CRASH_ID, 'mid-record');
    expect(ex.signal).toBe('SIGKILL');

    // On-disk evidence: the record is absent (the rename never landed), a
    // leftover record temp sits in .thirdlight, and claim-0 carries the
    // child's stamp (a dead pid).
    expect(readRec(root)).toBeNull();
    const thirdDir = join(root, 'projects', PROJECT, '.thirdlight');
    const temps = readdirSync(thirdDir).filter((n) => n.startsWith('.ownership.json.tmp-'));
    expect(temps.length).toBeGreaterThanOrEqual(1);
    const stamp = readStamp(root, 0);
    expect(stamp?.backendId).toBe(CRASH_ID);
    expect(stamp?.pid).toBe(ex.pid);

    // The next claim reclaims (the holder is proven dead) and succeeds.
    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: PROJECT }) as { ok: boolean };
    expect(q.ok).toBe(true);
    const rec = readRec(root);
    expect(rec?.backendId).toBe(svc.backendId);
    expect(rec?.lockEpoch).toBe(0);
    const m = svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT,
      expectedRevision: 5,
      requestId: 'req-3c000000000000000000000000000001',
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as { ok: boolean; revision?: number };
    expect(m.ok).toBe(true);
    expect(m.revision).toBe(6);
    svc.dispose();
  }, 45000);
});