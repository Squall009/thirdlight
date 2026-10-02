/**
 * Scenes and resources as files at the HTTP boundary, on a project in the
 * data root (its own folder is its game folder):
 *
 * - a create names the folder its scene or resource goes into (`folder`);
 * - "check files" (`POST …/content/files/check`, what the editor sends on
 *   focus and MCP's integrity check) takes in a scene file and a material
 *   file added outside the editor as one `importResources` command on the
 *   change feed, reports a file it cannot read as a Problem, and one undo
 *   takes the added files out again;
 * - a sidecar deleted while the project is released is put back when it opens
 *   again, and the Problems log says so.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const GLB = readFileSync(join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb'));
const PID = 'demo-0001';

describe('scenes and resources as files over HTTP', () => {
  let tb: TestBackend;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'resource-files-test' }, args }, token: tb.adminToken, origin: null });
  const query = async (op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, ...(args !== undefined ? { args } : {}) }, token: tb.adminToken, origin: null })).json as Record<string, unknown>;
  const problems = async (): Promise<{ code: string; message: string }[]> =>
    ((await api(`${tb.authUrl}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as { problems: { code: string; message: string }[] }).problems;
  const json = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), ...rel.split('/')), 'utf8')) as Record<string, unknown>;

  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('creates a scene and a material in the folders named; check files takes in files added outside the editor as one undoable command', async () => {
    let r = await command('createScene', { name: 'Level 1', sceneId: 'level-1', folder: 'levels' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await command('setMaterial', { material: { materialId: 'stone', name: 'Stone', shader: 'standard', params: { color: '#808080' }, textures: {} }, folder: 'art/materials' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(json('levels/level-1.scene.json')).toMatchObject({ type: 'scene', scene: { sceneId: 'level-1' } });
    expect(json('art/materials/stone.material.json')).toMatchObject({ kind: 'material', id: 'stone' });
    r = await command('createScene', { name: 'Nowhere', folder: '.git' });
    expect((r.json as { error: { code: string } }).error.code).toBe('path_rejected');

    // Outside the editor: a copy of the scene, a new material, a file that is not one.
    copyFileSync(join(dir(), 'levels', 'level-1.scene.json'), join(dir(), 'levels', 'Level 2.scene.json'));
    writeFileSync(join(dir(), 'art', 'materials', 'sand.material.json'), JSON.stringify({ tlresource: 1, kind: 'material', id: 'sand', data: { materialId: 'sand', name: 'Sand', shader: 'standard', params: { color: '#c2b280' }, textures: {} } }));
    writeFileSync(join(dir(), 'art', 'materials', 'broken.material.json'), '{');
    const before = revision();
    const check = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    const res = (check.json as { check: { resources: { adopted: unknown[]; problems: { path: string }[]; paused: string | null } } }).check.resources;
    expect(res.adopted).toEqual([
      { kind: 'material', id: 'sand', path: 'art/materials/sand.material.json' },
      { kind: 'scene', id: 'level-2', path: 'levels/Level 2.scene.json', copyOf: 'level-1' },
    ]);
    expect(res.problems.map((p) => p.path)).toEqual(['art/materials/broken.material.json']);
    expect(res.paused).toBeNull();
    expect(revision()).toBe(before + 1);
    const project = await query('queryProject');
    expect((project['scenes'] as { sceneId: string; name: string }[]).map((e) => `${e.sceneId}:${e.name}`)).toEqual(['scene-main:Main', 'level-1:Level 1', 'level-2:Level 2']);
    const idx = await query('queryIndex', { kind: 'material' });
    expect((idx['entries'] as { id: string; path: string }[]).map((e) => `${e.id}@${e.path}`)).toEqual(['sand@art/materials/sand.material.json', 'stone@art/materials/stone.material.json']);
    expect((await problems()).some((p) => p.message.includes('art/materials/broken.material.json'))).toBe(true);

    // One undo takes both out (their files go with them).
    r = await command('undo', {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(existsSync(join(dir(), 'levels', 'Level 2.scene.json'))).toBe(false);
    expect(existsSync(join(dir(), 'art', 'materials', 'sand.material.json'))).toBe(false);
  });

  it('puts back a sidecar deleted while the project was released, and says so in Problems', async () => {
    const sha = createHash('sha256').update(GLB).digest('hex');
    const service = tb.backend._test.service;
    expect(service.holdAssetBytes(PID, GLB).ok).toBe(true);
    let r = await command('publishAsset', { mode: 'create', assetId: 'tiny', kind: 'model', displayName: 'Tiny', sourceDigest: sha, sourceByteLength: GLB.length, importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] }, metrics: { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 36, decodedImageBytes: 0 }, importedAt: '2026-09-30T10:00:00Z' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await command('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Tiny', model: { asset: { assetId: 'tiny' } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const sidecar = join(dir(), 'assets', 'Tiny.glb.tlasset');
    const bytes = readFileSync(sidecar);
    const rev = revision();
    expect(service.releaseWorkspace(PID).ok).toBe(true);
    unlinkSync(sidecar);
    // The next command re-opens the released project (the scene still uses the asset: before, this open was refused).
    const again = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'createEntity', projectId: PID, expectedRevision: rev, requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'resource-files-test' }, args: { sceneId: 'scene-main', kind: 'box', name: 'After' } }, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(readFileSync(sidecar).equals(bytes)).toBe(true);
    expect((await problems()).filter((p) => p.code === 'asset_sidecar_restored').map((p) => p.message)).toEqual([expect.stringContaining('assets/Tiny.glb.tlasset')]);
  });
});
