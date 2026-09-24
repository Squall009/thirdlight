/**
 * Durable retry records across restarts (commands.md §7.2, workspace.md §4.1):
 * the record lives in the same file as the state it describes (storage v4:
 * the scene file a scene edit writes, in one atomic replacement), so a lost
 * acknowledgement is recoverable after a process restart — the retry is
 * answered from the durable record (replay, `duplicated: true`), never
 * double-applied.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Phase 14.8: the retry record stores the live acknowledgement, `sceneId`
 * included (record version 2). A retry block written before (version 1, no
 * `recordVersion` key, records without `sceneId`) is still read.
 */
describe('retry records name the edited scene (record version 2)', () => {
  type FileDoc = { retry: { recordVersion?: number; retention: number; records: { requestId: string; result: Record<string, unknown> }[] } };
  const readDoc = (p: string): FileDoc => JSON.parse(readFileSync(p, 'utf8')) as FileDoc;
  const writeDoc = (p: string, doc: unknown): void => writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  /** Rewrite a project file as a pre-14.8 file: no recordVersion, records without sceneId. */
  const toRecordVersion1 = (p: string): void => {
    const doc = readDoc(p);
    delete doc.retry.recordVersion;
    for (const r of doc.retry.records) delete r.result['sceneId'];
    writeDoc(p, doc);
  };
  const A5 = {
    op: 'setTransform',
    projectId: 'demo-0001',
    expectedRevision: 4,
    requestId: 'req-10000000000000000000000000000005',
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args: { entityId: 'box-0002', transform: { rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] } },
  };

  it('a retry after a restart returns the acked sceneId (a second scene)', () => {
    const root = makeRoot('dedup-scene-id');
    const dir = seedRev5(root);
    const procRoot = buildFakeProc(root, { 6100: 'dead' });
    const a = openWorkspaceService({ root, backendId: 'tb-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', pid: 6100, procRoot });
    const sceneReq = { op: 'createScene', projectId: 'demo-0001', expectedRevision: 5, requestId: req(7101), origin: { kind: 'mcp', clientId: 'c1' }, args: { sceneId: 'level-two', name: 'Level two' } };
    const sceneAck = a.runCommand(sceneReq) as MutationResult;
    if (sceneAck.ok !== true) throw new Error(`createScene failed: ${JSON.stringify(sceneAck)}`);
    expect('sceneId' in sceneAck).toBe(false);
    const createReq = { op: 'createEntity', projectId: 'demo-0001', expectedRevision: 6, requestId: req(7102), origin: { kind: 'mcp', clientId: 'c1' }, args: { kind: 'box', parentId: null, sceneId: 'level-two' } };
    const createAck = a.runCommand(createReq) as MutationResult;
    if (createAck.ok !== true) throw new Error(`create failed: ${JSON.stringify(createAck)}`);
    expect(createAck.sceneId).toBe('level-two');
    a.dispose();

    // The record on disk is the live ack (sceneId last), in a version-2 block.
    const sceneFile = readDoc(join(dir, 'scenes', 'level-two.json'));
    expect(sceneFile.retry.recordVersion).toBe(2);
    expect(sceneFile.retry.records.at(-1)?.result).toEqual(createAck);
    expect(Object.keys(sceneFile.retry.records.at(-1)!.result).at(-1)).toBe('sceneId');
    const contentFile = readDoc(join(dir, 'content.json'));
    expect(contentFile.retry.records.at(-1)?.result).toEqual(sceneAck);

    const b = openWorkspaceService({ root, backendId: 'tb-ffffffffffffffffffffffffffffffff', pid: 6101, procRoot });
    const replay = b.runCommand(createReq) as MutationResult;
    expect(replay).toEqual({ ...createAck, duplicated: true });
    const sceneReplay = b.runCommand(sceneReq) as MutationResult;
    expect(sceneReplay).toEqual({ ...sceneAck, duplicated: true });
    expect('sceneId' in sceneReplay).toBe(false);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a record-version-1 file: old records replay without sceneId, new ones with it', () => {
    const root = makeRoot('dedup-record-v1');
    const dir = seedRev5(root);
    toRecordVersion1(join(dir, SCENE_FILE));
    toRecordVersion1(join(dir, 'content.json'));
    const procRoot = buildFakeProc(root, { 6200: 'dead' });
    const a = openWorkspaceService({ root, backendId: 'tb-abababababababababababababababab', pid: 6200, procRoot });
    const old = a.runCommand(A5) as MutationResult;
    if (old.ok !== true) throw new Error(`replay failed: ${JSON.stringify(old)}`);
    expect(old.duplicated).toBe(true);
    expect('sceneId' in old).toBe(false);
    const fresh = { ...A5, expectedRevision: 5, requestId: req(7201), args: { entityId: 'box-0001', transform: { position: [3, 0, 0] } } };
    const ack = a.runCommand(fresh) as MutationResult;
    if (ack.ok !== true) throw new Error(`fresh failed: ${JSON.stringify(ack)}`);
    expect(ack.sceneId).toBe('scene-main');
    a.dispose();

    // The rewritten file is version 2; the old records stay as they were.
    const doc = readDoc(join(dir, SCENE_FILE));
    expect(doc.retry.recordVersion).toBe(2);
    expect(doc.retry.records.length).toBe(6);
    expect(doc.retry.records.slice(0, 5).every((r) => !('sceneId' in r.result))).toBe(true);
    expect(doc.retry.records[5]?.result['sceneId']).toBe('scene-main');

    const b = openWorkspaceService({ root, backendId: 'tb-cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', pid: 6201, procRoot });
    expect(b.runCommand(fresh)).toEqual({ ...ack, duplicated: true });
    const oldAgain = b.runCommand(A5) as MutationResult;
    expect(oldAgain.ok).toBe(true);
    expect('sceneId' in oldAgain).toBe(false);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  /** Open demo-0001 at T5 with its scene file edited; the service's unavailable reason and first detail path. */
  function blocked(mutate: (sceneDoc: FileDoc) => void): { reason?: string; path?: string } {
    const root = makeRoot('dedup-record-bad');
    const dir = seedRev5(root);
    const p = join(dir, SCENE_FILE);
    const doc = readDoc(p);
    mutate(doc);
    writeDoc(p, doc);
    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean; error?: { code: string; reason?: string; details?: { path?: string }[] } };
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
    expect(q.ok).toBe(false);
    expect(q.error?.code).toBe('project_unavailable');
    return { reason: q.error?.reason, path: q.error?.details?.[0]?.path };
  }

  it('refuses a sceneId in a version-1 record, an unknown recordVersion, and a malformed sceneId', () => {
    // (A recorded-result detail path starts at `/result`, without the record
    // index — the existing convention, see json-pointer-escaping.test.ts.)
    // The corpus records carry sceneId: without the version key they are version 1.
    expect(blocked((d) => { delete d.retry.recordVersion; })).toEqual({
      reason: 'retry_records_invalid',
      path: '/scenes/scene-main.json/result/sceneId',
    });
    expect(blocked((d) => { d.retry.recordVersion = 3; })).toEqual({
      reason: 'retry_records_invalid',
      path: '/scenes/scene-main.json/retry/recordVersion',
    });
    expect(blocked((d) => { d.retry.records[0]!.result['sceneId'] = 'Not An Id'; })).toEqual({
      reason: 'retry_records_invalid',
      path: '/scenes/scene-main.json/result/sceneId',
    });
  });
});