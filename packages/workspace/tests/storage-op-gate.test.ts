/**
 * A project only accepts mutation ops its storage version can durably record.
 * Regression: an M2 op on a storageVersion-1 project used to be acknowledged
 * and written, after which the project could no longer be loaded.
 */

import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult } from '@thirdlight/workspace';

import { makeRoot, seedV1Project } from './helpers';

describe('storage-version op gate', () => {
  it('refuses an M2 op on a v1 project without writing; the project still loads after restart', () => {
    const root = makeRoot('op-gate');
    // A storageVersion-1 project at revision 0 (the M1 default scene).
    seedV1Project(root, 'demo-0001');
    const a = openWorkspaceService({ root });

    const refused = a.runCommand({
      op: 'setComponent',
      projectId: 'demo-0001',
      expectedRevision: 0,
      requestId: 'req-00000000000000000000000000000abc',
      origin: { kind: 'browser', clientId: 'test' },
      args: { entityId: 'cam-main', component: 'box', value: { size: [2, 1, 1] } },
    }) as MutationResult;
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('must fail');
    expect(refused.error.code).toBe('invalid_request');
    a.close();

    const b = openWorkspaceService({ root });
    const q = b.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean; revision?: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(0);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('new projects accept M2/M3 ops from the first revision', () => {
    const root = makeRoot('op-gate-v3');
    const a = openWorkspaceService({ root });
    expect(a.createProject('gate-0001', 'Gate').ok).toBe(true);
    const created = a.runCommand({
      op: 'createEntity',
      projectId: 'gate-0001',
      expectedRevision: 0,
      requestId: 'req-00000000000000000000000000000001',
      origin: { kind: 'browser', clientId: 'test' },
      args: { kind: 'box', parentId: null, name: 'b' },
    }) as MutationResult;
    expect(created.ok).toBe(true);
    const boxId = (created as unknown as { createdId: string }).createdId;
    const moved = a.runCommand({
      op: 'setTransform',
      projectId: 'gate-0001',
      expectedRevision: 1,
      requestId: 'req-00000000000000000000000000000002',
      origin: { kind: 'browser', clientId: 'test' },
      args: { entityId: boxId, transform: { position: [1, 2, 3] } },
    }) as MutationResult;
    expect(moved.ok).toBe(true);
    const resized = a.runCommand({
      op: 'setComponent',
      projectId: 'gate-0001',
      expectedRevision: 2,
      requestId: 'req-00000000000000000000000000000003',
      origin: { kind: 'browser', clientId: 'test' },
      args: { entityId: boxId, component: 'box', value: { size: [2, 1, 1] } },
    }) as MutationResult;
    expect(resized.ok).toBe(true);
    a.close();

    const b = openWorkspaceService({ root });
    const q = b.query({ op: 'queryProject', projectId: 'gate-0001' }) as { ok: boolean; revision?: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});
