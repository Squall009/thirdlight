/**
 * Ownership (workspace.md §6): open-time evaluation, the claim primitive,
 * the explicit takeover, release/re-claim, and own-record re-open.
 * Liveness is exercised against a controlled /proc tree (conservative
 * rules: absent ⇒ dead; pid reuse ⇒ dead; marker match ⇒ live; unknown ⇒
 * live ⇒ reject).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type QueryResult } from '@thirdlight/workspace';

import { FIXTURES, buildFakeProc, makeRoot, seedProject } from './helpers';

function seedT7(root: string): string {
  const base = '09-second-backend-ownership';
  return seedProject(root, join(FIXTURES, 'scenarios', base, 'disk-before'), 'demo-0001');
}

const QUERY = { op: 'queryProject', projectId: 'demo-0001' };

function queryErr(svc: ReturnType<typeof openWorkspaceService>): { code: string; reason?: string; holder?: { backendId: string; pid: number; lockEpoch: number } } | null {
  const q = svc.query(QUERY) as QueryResult;
  if (q.ok) return null;
  const e = q.error as { code: string; reason?: string; holder?: { backendId: string; pid: number; lockEpoch: number } };
  return e;
}

describe('ownership (workspace.md §6)', () => {
  it('two live backends: the second is rejected with the disk holder (no automatic takeover)', () => {
    const root = makeRoot('own-live');
    const dir = seedT7(root);
    const procRoot = buildFakeProc(root, { 5000: 'live' });

    const b = openWorkspaceService({
      root,
      storageV4: true,
      backendId: 'tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pid: 5150,
      procRoot,
    });
    const e = queryErr(b);
    expect(e?.code).toBe('project_unavailable');
    expect(e?.reason).toBe('ownership_conflict');
    expect(e?.holder).toEqual({
      backendId: 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      pid: 5000,
      openedAt: '2026-09-17T09:00:00Z',
      lockEpoch: 0,
      state: 'owned',
    });
    // Takeover of a LIVE owner is rejected even explicitly.
    const to = b.takeoverWorkspace('demo-0001');
    expect(to.ok).toBe(false);
    if (!to.ok) expect(to.error.code).toBe('ownership_conflict');
    // The record is untouched.
    const rec = JSON.parse(readFileSync(join(dir, '.thirdlight', 'ownership.json'), 'utf8'));
    expect(rec.lockEpoch).toBe(0);
    expect(rec.pid).toBe(5000);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('owner death ⇒ the next open reclaims automatically at epoch+1 with a byte-pinned record', () => {
    const root = makeRoot('own-stale');
    const dir = seedT7(root);
    const procRoot = buildFakeProc(root, { 5000: 'dead' }); // absent ⇒ dead

    const b = openWorkspaceService({
      root,
      storageV4: true,
      backendId: 'tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pid: 5150,
      procRoot,
      utcNow: () => '2026-09-17T10:30:00Z',
    });

    // The project is now usable by B.
    const q = b.query(QUERY) as QueryResult;
    expect(q.ok).toBe(true);
    // The new record is canonical (byte-pinned shape and values).
    const recPath = join(dir, '.thirdlight', 'ownership.json');
    const rec = JSON.parse(readFileSync(recPath, 'utf8'));
    expect(rec).toEqual({
      storageVersion: 1,
      state: 'owned',
      backendId: 'tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      pid: 5150,
      openedAt: '2026-09-17T10:30:00Z',
      lockEpoch: 1,
    });
    const raw = readFileSync(recPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(JSON.stringify(rec, null, 2) + '\n');
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('pid reuse is dead: a process that started AFTER openedAt cannot own (reclaimed)', () => {
    const root = makeRoot('own-reuse');
    const dir = seedT7(root);
    // pid 5000 exists but started recently ⇒ pid reuse ⇒ dead.
    const procRoot = buildFakeProc(root, { 5000: 'reused' });
    const b = openWorkspaceService({ root, storageV4: true, backendId: 'tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', pid: 5150, procRoot });
    const q = b.query(QUERY) as QueryResult;
    expect(q.ok).toBe(true);
    const rec = JSON.parse(readFileSync(join(dir, '.thirdlight', 'ownership.json'), 'utf8'));
    expect(rec.pid).toBe(5150);
    expect(rec.lockEpoch).toBe(1);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('release keeps the record (state released); the next open re-claims it', () => {
    const root = makeRoot('own-release');
    const dir = seedT7(root);
    const procRoot = buildFakeProc(root, {});
    const a = openWorkspaceService({ root, storageV4: true, backendId: 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pid: 5000, procRoot });
    // The fixture record is our own (pid 5000 + tb-aaaa): re-open keeps it.
    const q1 = a.query(QUERY) as QueryResult;
    expect(q1.ok).toBe(true);
    const recPath = join(dir, '.thirdlight', 'ownership.json');
    const before = readFileSync(recPath);

    const rel = a.releaseWorkspace('demo-0001');
    expect(rel.ok).toBe(true);
    if (!rel.ok) throw new Error('release failed');
    const recReleased = JSON.parse(readFileSync(recPath, 'utf8'));
    expect(recReleased.state).toBe('released');
    expect(recReleased.lockEpoch).toBe(0); // release does not advance the epoch

    // While released, queries fail workspace_closed (queries never
    // trigger the re-open). The next COMMAND is the on-demand re-open
    // (workspace.md §9.3): it re-validates the (edited) disk state and
    // re-claims the released record (epoch + 1).
    const q2 = a.query(QUERY) as QueryResult;
    expect(q2.ok).toBe(false);
    if (!q2.ok) {
      const e = q2.error as { code: string; reason?: string };
      expect(e.code).toBe('project_unavailable');
      expect(e.reason).toBe('workspace_closed');
    }
    const mut = a.runCommand({
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 7,
      requestId: 'req-60000000000000000000000000000098',
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0004', transform: { position: [0, 1, 0] } },
    }) as MutationResult;
    // The re-open re-claimed and applied (the disk state is the released
    // one: revision 7, records cleared).
    expect(mut.ok).toBe(true);
    const recAfter = JSON.parse(readFileSync(recPath, 'utf8'));
    expect(recAfter.state).toBe('owned');
    expect(recAfter.lockEpoch).toBe(1);
    void before;
    a.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('own-record re-open leaves the ownership record byte-identical (no epoch advance)', () => {
    const root = makeRoot('own-own');
    const dir = seedT7(root);
    const procRoot = buildFakeProc(root, {});
    const recPath = join(dir, '.thirdlight', 'ownership.json');
    const original = readFileSync(recPath);
    const a = openWorkspaceService({ root, storageV4: true, backendId: 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pid: 5000, procRoot });
    const q = a.query(QUERY) as QueryResult;
    expect(q.ok).toBe(true);
    // The record is untouched (we already owned it).
    expect(readFileSync(recPath).equals(original)).toBe(true);
    a.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('a fresh claim writes the record at epoch 0 (canonical bytes)', () => {
    const root = makeRoot('own-fresh');
    // An empty project created by the service itself.
    const svc = openWorkspaceService({ root, storageV4: true });
    const created = svc.createProject('proj-fresh', 'Fresh');
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');
    const rec = JSON.parse(readFileSync(join(root, 'projects', 'proj-fresh', '.thirdlight', 'ownership.json'), 'utf8'));
    expect(rec.state).toBe('owned');
    expect(rec.lockEpoch).toBe(0);
    expect(rec.pid).toBe(process.pid);
    expect(/^tb-[0-9a-f]{32}$/.test(rec.backendId)).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});