/**
 * Controlled fault injection into the W procedure (workspace.md §5.1/§5.2):
 * the WriteOps seam drives EACCES/EIO at specific steps while the rest of
 * the sequence runs on the real filesystem. Pins the failure
 * classification (previous / new-undurable / external), the ack
 * semantics (no success ack for a failed write), and the retry behavior.
 *
 * Sequencing: a healthy service opens (claims) the project first; the
 * faulted service re-opens it as the SAME backend (own record — a no-op
 * claim, no write) so the fault can only hit the mutation's W.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultWriteOps, openWorkspaceService, type MutationResult, type WriteOps } from '@thirdlight/workspace';

import { FIXTURES, makeRoot, seedProject } from './helpers';

function seedRev5(root: string): string {
  const dir = seedProject(root, join(FIXTURES, 'scenarios', '01-retry-lost-ack', 'disk-before'), 'demo-0001');
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'scenes', 'main.json'), readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev5.json')));
  return dir;
}

function makeRequest(n: number, revision: number) {
  return {
    op: 'setTransform',
    projectId: 'demo-0001',
    expectedRevision: revision,
    requestId: `req-${String(n).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
  };
}

function err(errno: string, where: string): Error {
  const e = new Error(`injected ${errno} at ${where}`);
  (e as { errno?: string }).errno = errno;
  return e;
}

/** Persistent fault on one op (every call). */
function persistentFault(faultAt: keyof WriteOps, errno: string): WriteOps {
  const base = defaultWriteOps;
  const out: Record<string, unknown> = { ...base };
  out[faultAt] = () => {
    throw err(errno, String(faultAt));
  };
  return out as unknown as WriteOps;
}

const SHARED = { backendId: 'tb-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', pid: 7000 };

/** Open the project with a healthy service (claim), returning the dir.
 * The faulted service re-opens with the SAME identity (own record — a
 * no-op claim, no write), so the fault can only hit the mutation's W. */
function openHealthy(root: string): string {
  const svc = openWorkspaceService({ root, ...SHARED });
  const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean };
  expect(q.ok).toBe(true);
  svc.dispose();
  return join(root, 'projects', 'demo-0001');
}

describe('write fault injection (workspace.md §5)', () => {
  it('open failure ⇒ write_failed{previous}: state unchanged, retry re-executes fresh', () => {
    const root = makeRoot('wf-1');
    const dir = seedRev5(root);
    const envPath = join(dir, 'scenes', 'main.json');
    const before = readFileSync(envPath);
    openHealthy(root);
    const svc = openWorkspaceService({ root, ...SHARED, ops: persistentFault('openTempFile', 'EACCES') });
    const r = svc.runCommand(makeRequest(1001, 5)) as MutationResult;
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('must fail');
    expect(r.error.code).toBe('write_failed');
    expect(r.error.onDiskState).toBe('previous');
    // No state change: the envelope is byte-identical.
    expect(readFileSync(envPath).equals(before)).toBe(true);
    // The in-memory state is unchanged too (query serves rev 5).
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean; revision: number };
    expect(q.revision).toBe(5);
    // A retry with a fresh requestId re-executes (no record exists).
    const r2 = svc.runCommand(makeRequest(1002, 5)) as MutationResult;
    expect(r2.ok).toBe(false); // the fault persists
    if (r2.ok) throw new Error('must still fail');
    expect(r2.error.code).toBe('write_failed');
    expect(r2.error.onDiskState).toBe('previous');
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('directory-flush failure after rename ⇒ write_failed{new-undurable}: in-memory advances, ack still fails', () => {
    const root = makeRoot('wf-2');
    const dir = seedRev5(root);
    const envPath = join(dir, 'scenes', 'main.json');
    openHealthy(root);
    const svc = openWorkspaceService({ root, ...SHARED, ops: persistentFault('fsyncDir', 'EIO') });
    const r = svc.runCommand(makeRequest(2001, 5)) as MutationResult;
    expect(r.ok).toBe(false); // a success ack is never sent for a failed write
    if (r.ok) throw new Error('must fail');
    expect(r.error.code).toBe('write_failed');
    expect(r.error.onDiskState).toBe('new-undurable');
    // The rename took effect: the on-disk envelope is the NEW one (rev 6,
    // record present) — durability of the directory flush is unproven.
    const disk = JSON.parse(readFileSync(envPath, 'utf8')) as { scene: { revision: number }; retry: { records: { requestId: string }[] } };
    expect(disk.scene.revision).toBe(6);
    expect(disk.retry.records.at(-1)?.requestId).toBe(r.requestId);
    // The running system is self-consistent: in-memory advanced too.
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean; revision: number };
    expect(q.revision).toBe(6);
    // Retrying the SAME requestId replays from the record (present in
    // memory and on disk) — never a double-apply, no write attempted.
    const replay = svc.runCommand(makeRequest(2001, 5)) as MutationResult;
    expect(replay.ok).toBe(true);
    expect(replay.duplicated).toBe(true);
    const diskAfter = JSON.parse(readFileSync(envPath, 'utf8')) as { scene: { revision: number } };
    expect(diskAfter.scene.revision).toBe(6); // unchanged
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('a foreign replacement in the flush/verify window is detected (external) and snapshotted', () => {
    const root = makeRoot('wf-3');
    const dir = seedRev5(root);
    const envPath = join(dir, 'scenes', 'main.json');
    const lkg = readFileSync(envPath);
    openHealthy(root);
    const foreign = Buffer.concat([lkg, Buffer.from('\n// foreign edit\n')]);
    // Swap the foreign bytes in AFTER the directory flush and BEFORE the
    // verification read — the exact race window of workspace.md §5.1 step 5.
    const racy: WriteOps = {
      ...defaultWriteOps,
      fsyncDir: (d: string) => {
        defaultWriteOps.fsyncDir(d);
        if (d === join(dir, 'scenes')) writeFileSync(envPath, foreign);
      },
    };
    const svc = openWorkspaceService({ root, ...SHARED, ops: racy });
    const r = svc.runCommand(makeRequest(3001, 5)) as MutationResult;
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('must fail');
    expect(r.error.code).toBe('external_change_unresolved');
    // The foreign bytes were snapshotted BEFORE the pause, byte-identical.
    const recDir = join(dir, '.thirdlight', 'recovery');
    const snaps = readdirSync(recDir).filter((n) => n.startsWith('scene-'));
    expect(snaps.length).toBe(1);
    expect(readFileSync(join(recDir, snaps[0])).equals(foreign)).toBe(true);
    // Writes are paused from now on.
    const r2 = svc.runCommand(makeRequest(3002, 5)) as MutationResult;
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('must stay paused');
    expect(r2.error.code).toBe('external_change_unresolved');
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('bounded retries: a persistent rename failure leaves the previous state (temps cleaned)', () => {
    const root = makeRoot('wf-4');
    const dir = seedRev5(root);
    const envPath = join(dir, 'scenes', 'main.json');
    const before = readFileSync(envPath);
    openHealthy(root);
    const svc = openWorkspaceService({ root, ...SHARED, ops: persistentFault('renameFile', 'EIO') });
    const r = svc.runCommand(makeRequest(4001, 5)) as MutationResult;
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('must fail');
    expect(r.error.code).toBe('write_failed');
    expect(r.error.onDiskState).toBe('previous');
    expect(readFileSync(envPath).equals(before)).toBe(true);
    // Leftover temps are cleaned (the best-effort removal inside W).
    const temps = readdirSync(join(dir, 'scenes')).filter((n) => n.includes('.tmp-'));
    expect(temps).toEqual([]);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});