/**
 * Phase 9.4 — project materials, object material mappings and the environment
 * on the real filesystem (storage v4): validation, references, undo/redo and
 * reload.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type WorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, makeRoot, seedProject } from './helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const PROJECT_ID = 'demo-0003';
const SELF = { backendId: 'tb-' + 'd'.repeat(32), pid: 6301 };

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => '2026-09-24T10:00:00Z', storageV4: true, ...SELF });
}
let n = 0;
function send(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult {
  n += 1;
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { revision: number };
  return svc.runCommand({ op, projectId: PROJECT_ID, expectedRevision: q.revision, requestId: `req-${(0xb5000 + n).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'materials' }, args }) as MutationResult;
}
function ok(svc: WorkspaceService, op: string, args: Record<string, unknown>): MutationResult & { ok: true; createdId?: string } {
  const r = send(svc, op, args);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as MutationResult & { ok: true; createdId?: string };
}
const FOLIAGE = { materialId: 'mat-foliage', name: 'Foliage', shader: 'foliage', params: { windBend: 1.5, color: '#e0ffe0' }, textures: {} };
const gameConfig = (svc: WorkspaceService) => svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID }) as unknown as { materials: { materialId: string; params: Record<string, unknown> }[]; environment: { wind?: { strength: number } } | null };

describe('materials and environment (storage v4)', () => {
  it('creates, validates, assigns, protects, undoes and reloads materials and wind', () => {
    const root = makeRoot('materials-v4');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
    const dir = join(root, 'projects', PROJECT_ID);
    let svc = open(root);

    ok(svc, 'setMaterial', { material: FOLIAGE });
    expect(gameConfig(svc).materials.map((m) => m.materialId)).toEqual(['mat-foliage']);
    // Unknown params, out-of-range values, wrong slots and non-texture assets are refused.
    expect(send(svc, 'setMaterial', { material: { ...FOLIAGE, params: { windBend: 99 } } }).ok).toBe(false);
    expect(send(svc, 'setMaterial', { material: { ...FOLIAGE, params: { sparkle: 1 } } }).ok).toBe(false);
    expect(send(svc, 'setMaterial', { material: { ...FOLIAGE, shader: 'glass' } }).ok).toBe(false);
    expect(send(svc, 'setMaterial', { material: { ...FOLIAGE, textures: { macroNormalMap: 'asset-x' } } }).ok).toBe(false);
    expect(send(svc, 'setMaterial', { material: { ...FOLIAGE, textures: { map: 'no-such-texture' } } }).ok).toBe(false);

    // An object uses it; while it does, the material cannot be deleted.
    const box = ok(svc, 'createEntity', { kind: 'box', name: 'bush', components: { materials: { '*': 'mat-foliage' } } });
    expect(send(svc, 'createEntity', { kind: 'box', components: { materials: { '*': 'mat-nope' } } }).ok).toBe(false);
    expect(send(svc, 'deleteMaterial', { materialId: 'mat-foliage' }).ok).toBe(false);
    ok(svc, 'setComponent', { entityId: box.createdId, component: 'materials', value: null });
    ok(svc, 'deleteMaterial', { materialId: 'mat-foliage' });
    expect(gameConfig(svc).materials).toEqual([]);
    ok(svc, 'undo', {});
    expect(gameConfig(svc).materials.map((m) => m.materialId)).toEqual(['mat-foliage']);

    // Wind.
    ok(svc, 'setEnvironment', { environment: { wind: { direction: [1, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } });
    expect(send(svc, 'setEnvironment', { environment: { wind: { direction: [0, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } }).ok).toBe(false);
    expect(send(svc, 'setEnvironment', { environment: { fog: {} } }).ok).toBe(false);
    ok(svc, 'setEnvironment', { environment: { wind: { direction: [0.5, 0.5], strength: 3, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } });
    ok(svc, 'undo', {});
    expect(gameConfig(svc).environment?.wind?.strength).toBe(2);

    // It is all in content.json and survives a reopen.
    const onDisk = JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')) as { content: { materials: unknown[]; environment: unknown } };
    expect(onDisk.content.materials).toHaveLength(1);
    expect(onDisk.content.environment).toEqual({ wind: { direction: [1, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } });
    svc.close();
    svc = open(root);
    expect(gameConfig(svc).materials[0]!.params).toEqual({ color: '#e0ffe0', windBend: 1.5 });
    expect(gameConfig(svc).environment?.wind?.strength).toBe(2);
    svc.close();
  });
});
