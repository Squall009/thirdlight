/**
 * Phase 12 — folders, flags and `moveEntities` are durable on the real
 * filesystem: the folder and flags are stored on the entities in the scene
 * envelope (no side file), the retry records of every new change shape reload,
 * and a fresh open (a restart) sees the same scene. Undo after reload is not
 * promised (charter §6), so the reload check is the state and the records.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type WorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, makeRoot, seedProject } from './helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const PROJECT_ID = 'demo-0003';
const SELF = { backendId: 'tb-' + 'b'.repeat(32), pid: 6200 };

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => '2026-09-23T10:00:00Z', ...SELF });
}

let n = 0;
function run(svc: WorkspaceService, revision: number, op: string, args: Record<string, unknown>): MutationResult & { ok: true } {
  n += 1;
  const r = svc.runCommand({
    op,
    projectId: PROJECT_ID,
    expectedRevision: revision,
    requestId: `req-${(0xf000 + n).toString(16).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'hierarchy-test' },
    args,
  }) as MutationResult;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as MutationResult & { ok: true };
}

describe('phase 12 — hierarchy edits on disk', () => {
  it('stores folders and flags in the scene, and every record reloads after a restart', () => {
    const root = makeRoot('hierarchy-store');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
    const svc = open(root);
    let rev = (svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number }).revision;

    const folder = run(svc, rev, 'createEntity', { kind: 'folder', name: 'Props' });
    rev = folder.revision;
    const folderId = (folder as unknown as { createdId: string }).createdId;
    const box = run(svc, rev, 'createEntity', { kind: 'box', name: 'crate', transform: { position: [4, 1, 0] } });
    rev = box.revision;
    const boxId = (box as unknown as { createdId: string }).createdId;
    rev = run(svc, rev, 'moveEntities', { entityIds: [boxId], parentId: folderId }).revision;
    rev = run(svc, rev, 'updateEntity', { entityId: folderId, locked: true, static: true }).revision;
    rev = run(svc, rev, 'undo', {}).revision;
    rev = run(svc, rev, 'redo', {}).revision;
    // Deleting the folder takes its subtree; undo restores both (a
    // restoreSubtree record holding a folder and a filed object).
    rev = run(svc, rev, 'deleteEntity', { entityId: folderId }).revision;
    rev = run(svc, rev, 'undo', {}).revision;

    const projectDir = join(root, 'projects', PROJECT_ID);
    const env = JSON.parse(readFileSync(join(projectDir, 'scenes', 'main.json'), 'utf8')) as {
      scene: { entities: { id: string; parentId?: string; locked?: boolean; static?: boolean; components: Record<string, unknown> }[] };
    };
    const f = env.scene.entities.find((e) => e.id === folderId)!;
    expect(f).toEqual({ id: folderId, name: 'Props', locked: true, static: true, components: { folder: {} } });
    const b = env.scene.entities.find((e) => e.id === boxId)!;
    expect(b.parentId).toBe(folderId);
    expect((b.components['transform'] as { position: number[] }).position).toEqual([4, 1, 0]);
    // No side file: the scene envelope and the manifest are the only project files.
    expect(readdirSync(join(projectDir, 'scenes'))).toEqual(['main.json']);

    svc.dispose();
    const svc2 = open(root);
    const q = svc2.query({ op: 'queryEntity', projectId: PROJECT_ID, args: { entityId: boxId } }) as {
      ok: boolean;
      revision: number;
      parentChain: string[];
    };
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.revision).toBe(rev);
    expect(q.parentChain).toEqual([folderId]);
    // Editing continues after the reload.
    run(svc2, rev, 'moveEntities', { entityIds: [boxId], parentId: null });
    svc2.dispose();
  });
});
