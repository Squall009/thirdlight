/**
 * Durable retry records across restarts (commands.md §7.2, workspace.md §4.1):
 * the record lives in the same file as the state it describes (storage v4:
 * the scene file a scene edit writes, in one atomic replacement), so a lost
 * acknowledgement is recoverable after a process restart — the retry is
 * answered from the durable record (replay, `duplicated: true`), never
 * double-applied.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult } from '@thirdlight/workspace';

import { SCENE_FILE, buildFakeProc, makeRoot, projectFixture, seedProject } from './helpers';

/** demo-0001 at mainline T5 (storage v4; 5 records in the scene file). */
function seedRev5(root: string): string {
  return seedProject(root, projectFixture('demo-0001-rev5'), 'demo-0001');
}

function req(n: number): string {
  return `req-${String(n).padStart(32, '0')}`;
}

describe('durable retry records', () => {
  it('replays an applied mutation after a restart (lost-ack recovery)', async () => {
    const root = makeRoot('dedup-restart');
    const dir = seedRev5(root);
    const envelopePath = join(dir, SCENE_FILE);

    // Backend A (pinned identity, fake /proc) applies a fresh mutation;
    // the success ack is "lost" (the service is disposed without the
    // client ever seeing it).
    const procRoot = buildFakeProc(root, { 6000: 'dead' });
    const a = openWorkspaceService({ root, backendId: 'tb-cccccccccccccccccccccccccccccccc', pid: 6000, procRoot });
    const request = {
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 5,
      requestId: req(7001),
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [2, 0, 0] } },
    };
    const first = a.runCommand(request) as MutationResult;
    expect(first.ok).toBe(true);
    if (first.ok !== true) throw new Error('first apply failed');
    expect(first.revision).toBe(6);
    expect(first.duplicated).toBe(false);
    a.dispose();

    // Backend B (a DIFFERENT identity, like a real restart) starts on the
    // same root. A's record is stale (pid 6000 absent), so
    // B reclaims it automatically, then the retry.
    const b = openWorkspaceService({ root, backendId: 'tb-dddddddddddddddddddddddddddddddd', pid: 6001, procRoot });
    const reopened = b.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean };
    expect(reopened.ok).toBe(true);
    // The retry (byte-identical request) is answered from the durable
    // record — even though the retried expectedRevision (5) is stale.
    const replay = b.runCommand(request) as MutationResult;
    expect(replay.ok).toBe(true);
    if (replay.ok !== true) throw new Error('replay failed');
    expect(replay.duplicated).toBe(true);
    expect(replay.revision).toBe(6);
    expect(replay.requestId).toBe(request.requestId);
    // No second application: the disk state is exactly what A wrote.
    const diskAfter = readFileSync(envelopePath, 'utf8');
    const parsed = JSON.parse(diskAfter) as { scene: { revision: number }; retry: { records: { requestId: string }[] } };
    expect(parsed.scene.revision).toBe(6);
    expect(parsed.retry.records.length).toBe(6); // 5 seeded + 1 new
    expect(parsed.retry.records.at(-1)?.requestId).toBe(request.requestId);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('evicts to 128 records; an evicted retry fails revision_conflict (never double-apply)', () => {
    const root = makeRoot('dedup-evict');
    const dir = seedRev5(root);
    const svc = openWorkspaceService({ root });
    const envelopePath = join(dir, SCENE_FILE);
    // 130 fresh mutations (records 6..135): retention evicts the oldest.
    const firstRequestId = req(8000);
    for (let i = 0; i < 130; i++) {
      const r = svc.runCommand({
        op: 'setTransform',
        projectId: 'demo-0001',
        expectedRevision: 5 + i,
        requestId: req(8000 + i),
        origin: { kind: 'mcp', clientId: 'pi-harness' },
        args: { entityId: 'box-0001', transform: { position: [i / 100, 0, 0] } },
      }) as MutationResult;
      if (r.ok !== true) throw new Error(`mutation ${i} failed: ${JSON.stringify(r).slice(0, 300)}`);
    }
    const parsed = JSON.parse(readFileSync(envelopePath, 'utf8')) as {
      scene: { revision: number };
      retry: { retention: number; records: { requestId: string }[] };
    };
    expect(parsed.scene.revision).toBe(135);
    expect(parsed.retry.retention).toBe(128);
    expect(parsed.retry.records.length).toBe(128);
    expect(parsed.retry.records[0].requestId).toBe(req(8002)); // seeded 5 + 8000/8001 evicted
    // Retrying an evicted requestId with its ORIGINAL (stale) revision:
    // the record is gone ⇒ the pipeline re-executes the revision check ⇒
    // revision_conflict. Never a double-apply.
    const retry = svc.runCommand({
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 5,
      requestId: firstRequestId,
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [0, 0, 0] } },
    }) as MutationResult;
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error('evicted retry must fail');
    expect(retry.error.code).toBe('revision_conflict');
    expect(retry.error.currentRevision).toBe(135);
    const after = JSON.parse(readFileSync(envelopePath, 'utf8')) as { scene: { revision: number } };
    expect(after.scene.revision).toBe(135); // unchanged
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('failed commands are never recorded (commands.md §7.1)', () => {
    const root = makeRoot('dedup-failed');
    const dir = seedRev5(root);
    const svc = openWorkspaceService({ root });
    const envelopePath = join(dir, SCENE_FILE);
    const before = readFileSync(envelopePath);
    const res = svc.runCommand({
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 99,
      requestId: req(9001),
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as MutationResult;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('must fail');
    expect(res.error.code).toBe('revision_conflict');
    // No write: the envelope bytes are untouched (no record, no revision).
    expect(readFileSync(envelopePath).equals(before)).toBe(true);
    // Re-issuing the SAME requestId at the right revision is allowed (the
    // failed attempt was never recorded).
    const ok = svc.runCommand({
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 5,
      requestId: req(9001),
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as MutationResult;
    expect(ok.ok).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});