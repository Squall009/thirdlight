/**
 * Queries (commands.md §5.6 / §10): served from the published in-memory
 * state at one acknowledged revision; LKG while paused; the strict
 * envelope/args validation; and the availability failures.
 */

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type QueryResult } from '@thirdlight/workspace';

import { FIXTURES, makeRoot, seedProject } from './helpers';

function seedRev5(root: string): string {
  const dir = seedProject(root, join(FIXTURES, 'scenarios', '01-retry-lost-ack', 'disk-before'), 'demo-0001');
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'scenes', 'main.json'), readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev5.json')));
  return dir;
}

function q(svc: ReturnType<typeof openWorkspaceService>, req: Record<string, unknown>): QueryResult {
  return svc.query(req) as QueryResult;
}

describe('queries (§5.6)', () => {
  it('queryProject serves the published state (manifest, scene, workspace block)', () => {
    const root = makeRoot('q-1');
    seedRev5(root);
    const svc = openWorkspaceService({ root });
    const r = q(svc, { op: 'queryProject', projectId: 'demo-0001' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('query failed');
    const p = r as {
      projectId: string;
      revision: number;
      manifest: { id: string; name: string };
      scene: { revision: number; entities: { id: string }[] };
      workspace: { writePaused: boolean };
    };
    expect(p.projectId).toBe('demo-0001');
    expect(p.revision).toBe(5);
    expect(p.manifest.id).toBe('demo-0001');
    expect(p.scene).toEqual({ sceneId: 'scene-main', entityCount: 4, cameraId: 'cam-main' });
    expect(p.workspace).toEqual({ writePaused: false });
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('queryEntity / queryEntities return the entity values', () => {
    const root = makeRoot('q-2');
    seedRev5(root);
    const svc = openWorkspaceService({ root });
    const one = q(svc, { op: 'queryEntity', projectId: 'demo-0001', args: { entityId: 'box-0001' } });
    expect(one.ok).toBe(true);
    if (!one.ok) throw new Error('queryEntity failed');
    const e = (one as {
      entity: { id: string; components: { box: { size: number[] } } };
      parentChain: string[];
      childIds: string[];
    }) as { entity: { id: string; components: { box: { size: number[] } } }; parentChain: string[]; childIds: string[] };
    expect(e.entity.id).toBe('box-0001');
    expect(e.entity.components.box.size).toEqual([1, 1, 1]);
    expect(e.parentChain).toEqual([]);
    expect(e.childIds).toEqual([]);

    const many = q(svc, { op: 'queryEntities', projectId: 'demo-0001' });
    if (!many.ok) throw new Error(`queryEntities failed: ${JSON.stringify(many)}`);
    expect(many.ok).toBe(true);
    const list = many as { entities: { id: string }[]; total: number };
    expect(list.entities.map((x) => x.id)).toEqual(['cam-main', 'box-0001', 'box-0002', 'group-0001']);
    expect(list.total).toBe(4);

    const missing = q(svc, { op: 'queryEntity', projectId: 'demo-0001', args: { entityId: 'nope' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect((missing.error as { code: string }).code).toBe('entity_not_found');
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('request-level failures: invalid envelope and args', () => {
    const root = makeRoot('q-3');
    seedRev5(root);
    const svc = openWorkspaceService({ root });
    const badOp = q(svc, { op: 'queryEverything', projectId: 'demo-0001' });
    expect(badOp.ok).toBe(false);
    if (!badOp.ok) expect((badOp.error as { code: string }).code).toBe('invalid_request');

    const unknownField = q(svc, { op: 'queryProject', projectId: 'demo-0001', extra: 1 });
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect((unknownField.error as { code: string }).code).toBe('invalid_request');

    const noEntity = q(svc, { op: 'queryEntity', projectId: 'demo-0001' });
    expect(noEntity.ok).toBe(false);
    if (!noEntity.ok) expect((noEntity.error as { code: string }).code).toMatch(/^field_/);

    const badId = q(svc, { op: 'queryProject', projectId: 'Bad ID' });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect((badId.error as { code: string }).code).toBe('invalid_request');

    const missing = q(svc, { op: 'queryProject', projectId: 'ghost' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      const e = missing.error as { code: string };
      expect(e.code).toBe('project_not_found');
    }
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('a blocked project (corrupt envelope, no LKG) fails queries with the blocked reason', () => {
    const root = makeRoot('q-4');
    const dir = seedProject(root, join(FIXTURES, 'scenarios', '01-retry-lost-ack', 'disk-before'), 'demo-0001');
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(join(dir, 'scenes', 'main.json'), 'not json');
    const svc = openWorkspaceService({ root });
    const r = q(svc, { op: 'queryProject', projectId: 'demo-0001' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.error as { code: string; reason?: string };
      expect(e.code).toBe('project_unavailable');
      expect(e.reason).toBe('json_parse_error');
    }
    // The bytes are retained untouched (no destructive action).
    expect(readFileSync(join(dir, 'scenes', 'main.json'), 'utf8')).toBe('not json');
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('project IDs cannot escape the data root (traversal and symlink escapes)', () => {
    const root = makeRoot('q-5');
    seedProject(root, join(FIXTURES, 'scenarios', '01-retry-lost-ack', 'disk-before'), 'demo-0001');
    // A real project OUTSIDE the root, reachable only through a symlink
    // inside it.
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, 'projects', 'linked'));

    const svc = openWorkspaceService({ root });
    // Syntactically invalid IDs are rejected at the request layer
    // (traversal cannot reach the filesystem at all).
    for (const bad of ['../outside', '..', './x', 'a/b', '/etc', 'demo-0001/..', 'UPPER', 'x'.repeat(65)]) {
      const r = q(svc, { op: 'queryProject', projectId: bad }) as { ok: boolean; error?: { code: string } };
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('invalid_request');
    }
    // The symlinked directory exists but is not contained in the data
    // root ⇒ not a project of this root.
    const linked = q(svc, { op: 'queryProject', projectId: 'linked' }) as { ok: boolean; error?: { code: string } };
    expect(linked.ok).toBe(false);
    expect(linked.error?.code).toBe('project_not_found');
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});