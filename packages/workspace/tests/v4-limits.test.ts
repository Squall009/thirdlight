/**
 * Phase 9.3 step B follow-up: two v4 gaps found while porting the v1 tests,
 * pinned through the service on a real v4 project directory.
 *
 * - `instantiatePrefab` in a v4 scene is bounded by the v4 per-scene cap
 *   (16384 entities, as createEntity/pasteEntities), not the old 1024;
 * - a content.json without `behaviorTrust` reports the missing key once;
 * - block layers have no cell cap: two layers of 1,048,576 cells each (above
 *   any count the engine once capped a layer or a scene at) are filled,
 *   edited, undone, saved and opened again.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type WorkspaceService } from '@thirdlight/workspace';

import { makeRoot } from './helpers';

const PROJECT_ID = 'limits-0001';
const SELF = { backendId: 'tb-' + 'd'.repeat(32), pid: 6301 };

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => '2026-09-24T10:00:00Z', ...SELF });
}

let n = 0;
function send(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult {
  n += 1;
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number };
  return svc.runCommand({
    op,
    projectId: PROJECT_ID,
    expectedRevision: q.revision,
    requestId: `req-${(0xb5000 + n).toString(16).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'v4-limits' },
    args,
  }) as MutationResult;
}

describe('v4 limits through the service', () => {
  it('instantiatePrefab into a v4 scene of more than 1024 entities succeeds (the v4 cap is 16384)', () => {
    const root = makeRoot('v4-limits-prefab');
    const dir = join(root, 'projects', PROJECT_ID);
    const svc = open(root);
    expect(svc.createProject(PROJECT_ID, 'Limits').ok).toBe(true);
    const box = send(svc, 'createEntity', { sceneId: 'scene-main', kind: 'box', name: 'crate' }) as MutationResult & { ok: true; createdId?: string };
    expect(box.ok, JSON.stringify(box)).toBe(true);
    const prefab = send(svc, 'createPrefab', { prefabId: 'prefab-0001', displayName: 'Crate', sourceEntityId: box.createdId });
    expect(prefab.ok, JSON.stringify(prefab)).toBe(true);
    svc.dispose();

    // Pad the scene file to 1100 entities (a valid v4 scene), then reopen.
    const scenePath = join(dir, 'scenes', 'scene-main.json');
    const doc = JSON.parse(readFileSync(scenePath, 'utf8')) as { scene: { entities: unknown[] } };
    for (let i = doc.scene.entities.length; i < 1100; i++) {
      doc.scene.entities.push({ id: `pad-${i}`, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } });
    }
    writeFileSync(scenePath, JSON.stringify(doc, null, 2) + '\n');

    const svc2 = open(root);
    const q = svc2.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as { ok: boolean; scene: { entityCount: number } };
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.scene.entityCount).toBe(1100);
    const inst = send(svc2, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'prefab-0001' });
    expect(inst.ok, JSON.stringify(inst)).toBe(true);
    const after = svc2.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as { scene: { entityCount: number } };
    expect(after.scene.entityCount).toBe(1101);
    // The instance is on disk.
    const onDisk = JSON.parse(readFileSync(scenePath, 'utf8')) as { scene: { entities: unknown[] } };
    expect(onDisk.scene.entities).toHaveLength(1101);
    svc2.dispose();
  });

  it('a content.json without behaviorTrust blocks the project with the missing key reported once', () => {
    const root = makeRoot('v4-limits-trust');
    const dir = join(root, 'projects', PROJECT_ID);
    const svc = open(root);
    expect(svc.createProject(PROJECT_ID, 'Limits').ok).toBe(true);
    svc.dispose();

    const contentPath = join(dir, 'content.json');
    const doc = JSON.parse(readFileSync(contentPath, 'utf8')) as { content: Record<string, unknown> };
    delete doc.content['behaviorTrust'];
    writeFileSync(contentPath, JSON.stringify(doc, null, 2) + '\n');

    const svc2 = open(root);
    const q = svc2.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as {
      ok: boolean;
      error: { code: string; reason: string; details: { path: string; code: string }[] };
    };
    expect(q.ok).toBe(false);
    expect(q.error.code).toBe('project_unavailable');
    expect(q.error.reason).toBe('content_invalid');
    const trust = q.error.details.filter((d) => d.path.endsWith('/behaviorTrust'));
    expect(trust, JSON.stringify(q.error.details)).toHaveLength(1);
    expect(trust[0]!.code).toBe('field_missing');
    svc2.dispose();
  });

  it('block layers past the old cell caps fill, edit, undo, save and open again', () => {
    const root = makeRoot('v4-limits-blocks');
    const svc = open(root);
    expect(svc.createProject(PROJECT_ID, 'Limits').ok).toBe(true);
    expect(send(svc, 'setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' } }).ok).toBe(true);
    const ids: string[] = [];
    for (const name of ['North', 'South']) {
      const made = send(svc, 'createEntity', { sceneId: 'scene-main', kind: 'group', name }) as MutationResult & { ok: true; createdId: string };
      expect(made.ok, JSON.stringify(made)).toBe(true);
      ids.push(made.createdId);
      const comp = send(svc, 'setComponent', { entityId: made.createdId, component: 'blockLayer', value: { cellSize: [1, 0.25, 1], bounds: { min: [0, 0, 0], max: [64, 256, 64] } } });
      expect(comp.ok, JSON.stringify(comp)).toBe(true);
      // 1,048,576 cells: one command's most, and four times what a layer once held (a scene: once 1,048,576 in all).
      const fill = send(svc, 'editBlocks', { entityId: made.createdId, edits: [{ kind: 'fill', box: [0, 0, 0, 64, 256, 64], cell: { block: 'stone' } }] });
      expect(fill.ok, JSON.stringify(fill).slice(0, 400)).toBe(true);
    }
    const one = send(svc, 'editBlocks', { entityId: ids[0], edits: [{ kind: 'cells', at: [5, 255, 5], cell: null }] }) as MutationResult & { ok: true; change: { chunks: number[][] } };
    expect(one.ok, JSON.stringify(one).slice(0, 400)).toBe(true);
    expect(one.change.chunks).toEqual([[0, 0]]);
    expect(send(svc, 'undo', {}).ok).toBe(true);
    expect(send(svc, 'redo', {}).ok).toBe(true);
    svc.dispose();

    const svc2 = open(root);
    const layers = (svc2.query({ op: 'queryBlocks', projectId: PROJECT_ID, args: {} }) as unknown as { layers: { entityId: string; cells: number }[] }).layers;
    expect(Object.fromEntries(layers.map((l) => [l.entityId, l.cells]))).toEqual({ [ids[0]!]: 1_048_575, [ids[1]!]: 1_048_576 });
    expect(send(svc2, 'editBlocks', { entityId: ids[1], edits: [{ kind: 'cells', at: [63, 0, 63], cell: null }] }).ok).toBe(true);
    svc2.dispose();
  }, 120_000);
});
