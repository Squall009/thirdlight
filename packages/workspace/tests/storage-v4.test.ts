/**
 * Phase 12 (c) — storage v4 on the real filesystem: a project is several
 * files (project.json v2, content.json, scenes/<id>.json).
 *
 * - a v3 project is upgraded when it is opened (the v3 envelope kept under
 *   .thirdlight/migrated-v3/), and the result reloads;
 * - an edit writes only the files that changed; a scene created in the index
 *   gets its file in the same (journaled) transaction;
 * - entity ids are unique across scenes; a command spanning two scenes and
 *   deleting a non-empty scene are refused; undo returns to the right scene;
 * - an external edit of one scene file pauses the project;
 * - a journal left by a crash is completed at the next open.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type WorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, makeRoot, seedProject } from './helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const PROJECT_ID = 'demo-0003';
const SELF = { backendId: 'tb-' + 'c'.repeat(32), pid: 6300 };

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => '2026-09-23T10:00:00Z', storageV4: true, ...SELF });
}

let n = 0;
function send(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult {
  n += 1;
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number };
  return svc.runCommand({
    op,
    projectId: PROJECT_ID,
    expectedRevision: q.revision,
    requestId: `req-${(0xa4000 + n).toString(16).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'storage-v4' },
    args,
  }) as MutationResult;
}
function ok(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult & { ok: true; createdId?: string } {
  const r = send(svc, op, args);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as MutationResult & { ok: true; createdId?: string };
}

const hashOf = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('storage v4', () => {
  it('upgrades a v3 project on open, writes per scene, and keeps ids unique across scenes', () => {
    const root = makeRoot('storage-v4');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
    const dir = join(root, 'projects', PROJECT_ID);
    const svc = open(root);
    const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as { ok: boolean; scenes: { sceneId: string; name: string }[]; startScenes: string[]; scene: { schemaVersion: number } };
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.scene.schemaVersion).toBe(4);
    expect(q.scenes).toEqual([{ sceneId: 'scene-main', name: 'Main', entityCount: expect.any(Number) }]);
    expect(q.startScenes).toEqual(['scene-main']);
    // The files on disk: v2 manifest, content.json, scenes/scene-main.json; the v3 envelope kept aside.
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).schemaVersion).toBe(2);
    expect(existsSync(join(dir, 'content.json'))).toBe(true);
    expect(readdirSync(join(dir, 'scenes'))).toEqual(['scene-main.json']);
    expect(existsSync(join(dir, '.thirdlight', 'migrated-v3', 'main.json'))).toBe(true);
    const content = JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')) as { content: { game: Record<string, unknown> | null } };
    if (content.content.game !== null) {
      expect(content.content.game).not.toHaveProperty('killY');
      expect(content.content.game['configVersion']).toBe(2);
    }

    // An entity edit writes the scene file only.
    const contentHash = hashOf(join(dir, 'content.json'));
    const box = ok(svc, 'createEntity', { kind: 'box', name: 'crate' });
    expect(hashOf(join(dir, 'content.json'))).toBe(contentHash);

    // A new scene: index + empty file in one transaction; a box created in it.
    ok(svc, 'createScene', { sceneId: 'scene-cave', name: 'Cave' });
    expect(existsSync(join(dir, 'scenes', 'scene-cave.json'))).toBe(true);
    expect(existsSync(join(dir, '.thirdlight', 'journal.json'))).toBe(false);
    const caveBox = ok(svc, 'createEntity', { kind: 'box', name: 'rock', sceneId: 'scene-cave' });
    expect(caveBox.createdId).not.toBe(box.createdId); // ids unique across scenes
    const cave = JSON.parse(readFileSync(join(dir, 'scenes', 'scene-cave.json'), 'utf8')) as { scene: { entities: { id: string }[] } };
    expect(cave.scene.entities.map((e) => e.id)).toEqual([caveBox.createdId]);
    const byScene = svc.query({ op: 'queryEntities', projectId: PROJECT_ID, args: { sceneId: 'scene-cave' } }) as unknown as { entities: { id: string }[] };
    expect(byScene.entities.map((e) => e.id)).toEqual([caveBox.createdId]);
    const one = svc.query({ op: 'queryEntity', projectId: PROJECT_ID, args: { entityId: caveBox.createdId } }) as unknown as { sceneId: string };
    expect(one.sceneId).toBe('scene-cave');

    // One transaction touches one scene: a move across scenes is refused.
    const cross = send(svc, 'moveEntities', { entityIds: [caveBox.createdId], parentId: box.createdId });
    expect(cross.ok).toBe(false);
    // A camera does not belong in a scene that is not a start scene.
    const cam = send(svc, 'setComponent', { entityId: caveBox.createdId, component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 1 } });
    expect(cam.ok).toBe(false);
    // A non-empty scene cannot be deleted; undo of the create in the cave, then it can.
    expect(send(svc, 'deleteScene', { sceneId: 'scene-cave' }).ok).toBe(false);
    ok(svc, 'undo', {});
    const caveAfterUndo = JSON.parse(readFileSync(join(dir, 'scenes', 'scene-cave.json'), 'utf8')) as { scene: { entities: unknown[] } };
    expect(caveAfterUndo.scene.entities).toEqual([]);
    ok(svc, 'deleteScene', { sceneId: 'scene-cave' });
    expect(existsSync(join(dir, 'scenes', 'scene-cave.json'))).toBe(false);
    ok(svc, 'undo', {}); // the scene comes back (empty)
    expect(existsSync(join(dir, 'scenes', 'scene-cave.json'))).toBe(true);
    ok(svc, 'setStartScenes', { sceneIds: ['scene-main', 'scene-cave'] });

    // A restart reads the same project (revision and scenes).
    const rev = (svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number }).revision;
    svc.dispose();
    const svc2 = open(root);
    const q2 = svc2.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as { revision: number; scenes: { sceneId: string }[]; startScenes: string[] };
    expect(q2.revision).toBe(rev);
    expect(q2.scenes.map((x) => x.sceneId)).toEqual(['scene-main', 'scene-cave']);
    expect(q2.startScenes).toEqual(['scene-main', 'scene-cave']);
    svc2.dispose();
  });

  it('pauses on an external edit of one scene file, and completes a journal left by a crash', () => {
    const root = makeRoot('storage-v4-ext');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
    const dir = join(root, 'projects', PROJECT_ID);
    const svc = open(root);
    ok(svc, 'createScene', { sceneId: 'scene-b', name: 'B' });
    // Someone edits scene-b.json by hand.
    const p = join(dir, 'scenes', 'scene-b.json');
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { scene: { entities: unknown[] } };
    doc.scene.entities.push({ id: 'box-9001', components: { transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } });
    writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
    const r = send(svc, 'createEntity', { kind: 'box', sceneId: 'scene-b' });
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('external_change_unresolved');
    const accepted = svc.acceptExternalState(PROJECT_ID) as { ok: boolean };
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    const q = svc.query({ op: 'queryEntity', projectId: PROJECT_ID, args: { entityId: 'box-9001' } }) as unknown as { ok: boolean; sceneId: string };
    expect(q.sceneId).toBe('scene-b');
    svc.dispose();

    // A crash after the journal was written: the next open completes it.
    const contentPath = join(dir, 'content.json');
    const content = JSON.parse(readFileSync(contentPath, 'utf8')) as { revision: number; content: { scenes: { sceneId: string; name: string }[] } };
    content.content.scenes.push({ sceneId: 'scene-c', name: 'C' });
    content.revision += 1;
    const contentBytes = Buffer.from(`${JSON.stringify(content, null, 2)}\n`);
    const sceneBytes = Buffer.from(`${JSON.stringify({ storageVersion: 4, type: 'scene', projectId: PROJECT_ID, scene: { schemaVersion: 4, sceneId: 'scene-c', revision: content.revision, entities: [] }, retry: { retention: 128, records: [] } }, null, 2)}\n`);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    writeFileSync(
      join(dir, '.thirdlight', 'journal.json'),
      JSON.stringify({ journalVersion: 1, projectId: PROJECT_ID, writes: [
        { rel: 'content.json', bytes: contentBytes.toString('base64'), sha256: sha(contentBytes) },
        { rel: 'scenes/scene-c.json', bytes: sceneBytes.toString('base64'), sha256: sha(sceneBytes) },
      ] }),
    );
    const svc2 = open(root);
    const q2 = svc2.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as { ok: boolean; scenes: { sceneId: string }[] };
    expect(q2.ok, JSON.stringify(q2)).toBe(true);
    expect(q2.scenes.map((x) => x.sceneId)).toContain('scene-c');
    expect(existsSync(join(dir, '.thirdlight', 'journal.json'))).toBe(false);
    svc2.dispose();
  });
});
