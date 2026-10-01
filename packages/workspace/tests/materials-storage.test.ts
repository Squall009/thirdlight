/**
 * Project materials, object material mappings and a scene's wind
 * on the real filesystem (storage v4): validation, references, undo/redo and
 * reload.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type WorkspaceService } from '@thirdlight/workspace';

import { makeRoot, seedV3DemoProject } from './helpers';

const PROJECT_ID = 'demo-0003';
const SELF = { backendId: 'tb-' + 'd'.repeat(32), pid: 6301 };

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => '2026-09-24T10:00:00Z', ...SELF });
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
    seedV3DemoProject(root, PROJECT_ID);
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
    // setComponent replaces the whole mapping (its keys are material names).
    ok(svc, 'setComponent', { entityId: box.createdId, component: 'materials', value: { bark: 'mat-foliage' } });
    expect(send(svc, 'setComponent', { entityId: box.createdId, component: 'materials', value: { bark: 'mat-nope' } }).ok).toBe(false);
    ok(svc, 'setComponent', { entityId: box.createdId, component: 'materials', value: null });
    ok(svc, 'deleteMaterial', { materialId: 'mat-foliage' });
    expect(gameConfig(svc).materials).toEqual([]);
    ok(svc, 'undo', {});
    expect(gameConfig(svc).materials.map((m) => m.materialId)).toEqual(['mat-foliage']);

    // Wind: a scene's (each scene has its own look, in its own file).
    const sceneId = (svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as unknown as { scenes: { sceneId: string }[] }).scenes[0]!.sceneId;
    const windOf = (s: WorkspaceService): number | undefined => (s.query({ op: 'queryProject', projectId: PROJECT_ID, args: { environments: true } }) as unknown as { scenes: { sceneId: string; environment?: { wind?: { strength: number } } }[] }).scenes.find((r) => r.sceneId === sceneId)?.environment?.wind?.strength;
    ok(svc, 'setEnvironment', { sceneId, environment: { wind: { direction: [1, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } });
    expect(send(svc, 'setEnvironment', { sceneId, environment: { wind: { direction: [0, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } }).ok).toBe(false);
    expect(send(svc, 'setEnvironment', { sceneId, environment: { fog: {} } }).ok).toBe(false);
    // Without a sceneId the look is refused: it is no longer the project's.
    expect(send(svc, 'setEnvironment', { environment: { wind: { direction: [1, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } }).ok).toBe(false);
    ok(svc, 'setEnvironment', { sceneId, environment: { wind: { direction: [0.5, 0.5], strength: 3, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } } });
    ok(svc, 'undo', {});
    expect(windOf(svc)).toBe(2);
    expect(gameConfig(svc).environment).toBeNull();

    // The material is its own file in the game folder (a data-root project is its own),
    // the wind in its scene's file; both survive a reopen.
    const onDisk = JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')) as { content: { materials?: unknown[]; environment?: unknown } };
    expect(onDisk.content.materials).toBeUndefined();
    expect(onDisk.content.environment).toBeUndefined();
    const file = JSON.parse(readFileSync(join(dir, 'assets', 'materials', 'mat-foliage.material.json'), 'utf8')) as { kind: string; id: string; data: { materialId: string } };
    expect([file.kind, file.id, file.data.materialId]).toEqual(['material', 'mat-foliage', 'mat-foliage']);
    const sceneFile = JSON.parse(readFileSync(join(dir, 'scenes', `${sceneId}.json`), 'utf8')) as { scene: { environment?: unknown } };
    expect(sceneFile.scene.environment).toEqual({ wind: { direction: [1, 0], strength: 2, gust: 1, gustFrequency: 0.5, turbulence: 0.4 } });
    svc.close();
    svc = open(root);
    expect(gameConfig(svc).materials[0]!.params).toEqual({ color: '#e0ffe0', windBend: 1.5 });
    expect(windOf(svc)).toBe(2);
    svc.close();
  });
});
