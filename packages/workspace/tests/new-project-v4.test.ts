/**
 * Phase 9.3: a new project is written as storage v4 directly (no longer an M1
 * default scene carried to v3 and upgraded on open). It must be byte for byte
 * the project the old path produced — the `fixtures/commands` rev-0 project
 * (camera + two starter lights, one scene "Main", an empty catalog) — and it
 * leaves no `.thirdlight/migrated-v3` upgrade copy behind.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { openWorkspaceService } from '@thirdlight/workspace';

import { makeRoot, projectFixture } from './helpers';

describe('phase 9.3 — createProject writes storage v4 directly', () => {
  it('is byte-identical to the corpus rev-0 project and opens at revision 0', () => {
    const root = makeRoot('new-project-v4');
    const svc = openWorkspaceService({ root, utcNow: () => '2026-09-16T23:40:00Z' });
    const res = svc.createProject('demo-0001', 'Demo Project');
    expect(res).toEqual({ ok: true, created: true, revision: 0 });
    const dir = join(root, 'projects', 'demo-0001');
    for (const rel of ['project.json', 'content.json', join('scenes', 'scene-main.json')]) {
      expect(readFileSync(join(dir, rel), 'utf8'), rel).toBe(readFileSync(join(projectFixture('demo-0001-rev0'), rel), 'utf8'));
    }
    expect(readdirSync(join(dir, 'scenes'))).toEqual(['scene-main.json']);
    expect(existsSync(join(dir, '.thirdlight', 'migrated-v3'))).toBe(false);
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as {
      ok: boolean;
      revision: number;
      scene: { schemaVersion: number; entityCount: number; cameraId: string };
      scenes: { sceneId: string; name: string }[];
    };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(0);
    expect(q.scene).toMatchObject({ schemaVersion: 4, entityCount: 3, cameraId: 'cam-main' });
    expect(q.scenes.map((s) => [s.sceneId, s.name])).toEqual([['scene-main', 'Main']]);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});
