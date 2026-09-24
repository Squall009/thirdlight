/**
 * A new project accepts every current mutation op from its first revision
 * (storage v4). The v1 half of this file (an M2 op refused on a storage v1
 * project) is archived under archive/removed-v1-v2/workspace: v1/v2 projects
 * are no longer opened at all (storage-version-refusal.test.ts).
 */

import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult } from '@thirdlight/workspace';

import { makeRoot } from './helpers';

describe('storage-version op gate', () => {
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
