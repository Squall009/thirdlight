/**
 * A project only accepts mutation ops its storage version can durably record.
 * Regression: an M2 op on a storageVersion-1 project used to be acknowledged
 * and written, after which the project could no longer be loaded.
 */

import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult } from '@thirdlight/workspace';

import { makeRoot } from './helpers';

describe('storage-version op gate', () => {
  it('refuses an M2 op on a v1 project without writing; the project still loads after restart', () => {
    const root = makeRoot('op-gate');
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
    if (!created.ok) throw new Error('create failed');
    const boxId = (created as unknown as { createdId: string }).createdId;

    const refused = a.runCommand({
      op: 'setComponent',
      projectId: 'gate-0001',
      expectedRevision: 1,
      requestId: 'req-00000000000000000000000000000002',
      origin: { kind: 'browser', clientId: 'test' },
      args: { entityId: boxId, component: 'box', value: { size: [2, 1, 1] } },
    }) as MutationResult;
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('must fail');
    expect(refused.error.code).toBe('invalid_request');
    a.close();

    const b = openWorkspaceService({ root });
    const q = b.query({ op: 'queryProject', projectId: 'gate-0001' }) as { ok: boolean; revision?: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(1);
    b.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});
