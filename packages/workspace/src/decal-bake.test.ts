/**
 * "Bake to model" through the real service and filesystem: one
 * `publishAsset` with `bakeDecal` on an object in a scene other than the
 * first publishes the model with its material map and turns the object's
 * clipped decal into a model of it, in that scene's file, as one undo step;
 * a refused bake leaves no asset and the decal as it was.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import type { StageInspector, WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 36, decodedImageBytes: 0 };
const stubInspector: StageInspector = () => {
  throw new Error('not used');
};

/** Any bytes stand in for the baked GLB: the command checks the file's digest, not its contents. */
const GLB = new TextEncoder().encode('glTF stand-in for a baked clipped decal');

let seq = 0;
type Result = { ok: boolean; createdId?: string; history?: { undoDepth: number }; error?: { code: string; message: string } };
function command(service: WorkspaceService, op: string, args: Record<string, unknown>): Result {
  const q = service.query({ op: 'queryEntities', projectId: 'game', args: { limit: 1, offset: 0 } }) as unknown as { revision: number };
  seq += 1;
  return service.runCommand({ op, projectId: 'game', expectedRevision: q.revision, requestId: `req-${(0x5b10000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'vitest' }, args }) as unknown as Result;
}
const ok = (service: WorkspaceService, op: string, args: Record<string, unknown>): Result => {
  const r = command(service, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
};
const components = (service: WorkspaceService, id: string): Record<string, unknown> => (service.query({ op: 'queryEntity', projectId: 'game', args: { entityId: id } }) as unknown as { entity: { components: Record<string, unknown> } }).entity.components;
const assets = (service: WorkspaceService): { assetId: string; materials?: Record<string, string> }[] => (service.query({ op: 'queryAssets', projectId: 'game', args: { limit: 50, offset: 0 } }) as unknown as { assets: { assetId: string; materials?: Record<string, string> }[] }).assets;

function setup(): { service: WorkspaceService; game: string } {
  // Disposable roots on disk, not the tmpfs /tmp (the suite's reaper knows the prefix).
  const base = join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(), `.tl07-tmp-decalbake-${process.pid}-${Date.now().toString(36)}`);
  roots.push(base);
  mkdirSync(join(base, 'data'), { recursive: true });
  const service = openWorkspaceService({ root: join(base, 'data'), assetInspector: stubInspector });
  const game = join(base, 'game');
  expect(service.createProjectInFolder(game, 'game', 'Game').ok).toBe(true);
  mkdirSync(join(game, 'assets'), { recursive: true });
  writeFileSync(join(game, 'assets', 'crack-baked.glb'), GLB);
  return { service, game };
}

const bakeArgs = (assetId: string, entityId: string): Record<string, unknown> => ({
  mode: 'create',
  assetId,
  kind: 'model',
  displayName: 'Crack (baked decal)',
  sourceDigest: sha(GLB),
  sourceByteLength: GLB.length,
  sourcePath: 'assets/crack-baked.glb',
  importRecipe: RECIPE,
  metrics: METRICS,
  importedAt: '2026-10-11T10:00:00Z',
  bakeDecal: { entityId },
});

/** The components of `id` in the scene file of `sceneId`, read from the disk (null: no such file holds it). */
function onDisk(root: string, sceneId: string, id: string): Record<string, unknown> | null {
  const walk = (dir: string): Record<string, unknown> | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const found = e.isDirectory() ? walk(p) : e.name.endsWith('.json') ? sceneEntity(readFileSync(p, 'utf8')) : null;
      if (found !== null) return found;
    }
    return null;
  };
  const sceneEntity = (text: string): Record<string, unknown> | null => {
    let doc: { sceneId?: unknown; entities?: unknown } | null = null;
    try {
      // A scene file holds its scene document under `scene`, beside the retry records.
      doc = (JSON.parse(text) as { type?: unknown; scene?: { sceneId?: unknown; entities?: unknown } }).scene ?? null;
    } catch {
      return null;
    }
    if (doc === null || doc.sceneId !== sceneId || !Array.isArray(doc.entities)) return null;
    const e = (doc.entities as { id: string; components: Record<string, unknown> }[]).find((x) => x.id === id);
    return e === undefined ? null : e.components;
  };
  return walk(root);
}

describe('bake a clipped decal to a model', () => {
  it('is one command and one undo step, in the scene of the object', () => {
    const { service, game } = setup();
    ok(service, 'setMaterial', { material: { materialId: 'mat-crack', name: 'Crack', shader: 'decal', params: { blend: 'multiply' }, textures: {} } });
    ok(service, 'createScene', { name: 'Cave', sceneId: 'cave' });
    const id = ok(service, 'createEntity', { sceneId: 'cave', kind: 'group', name: 'crack' }).createdId!;
    const decal = { size: [2, 1, 0.5], material: 'mat-crack', mode: 'clipped' };
    ok(service, 'setComponent', { entityId: id, component: 'decal', value: decal });
    const projected = ok(service, 'createEntity', { sceneId: 'cave', kind: 'group', name: 'stain' }).createdId!;
    ok(service, 'setComponent', { entityId: projected, component: 'decal', value: { size: [1, 1, 1], material: 'mat-crack' } });
    const before = assets(service).length;

    // A projected decal has no mesh to bake: refused, nothing written.
    const refused = command(service, 'publishAsset', bakeArgs('crack-baked', projected));
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('component_conflict');
    expect(assets(service)).toHaveLength(before);
    expect(components(service, projected)['decal']).toEqual({ size: [1, 1, 1], material: 'mat-crack' });

    const r = ok(service, 'publishAsset', bakeArgs('crack-baked', id));
    expect(assets(service).find((a) => a.assetId === 'crack-baked')?.materials).toEqual({ 'mat-crack_decal': 'mat-crack' });
    expect(components(service, id)['decal']).toBeUndefined();
    expect(components(service, id)['model']).toEqual({ asset: { assetId: 'crack-baked' } });
    // The swap is in the object's own scene file.
    const written = onDisk(join(game, '..'), 'cave', id);
    expect(written?.['model']).toEqual({ asset: { assetId: 'crack-baked' } });
    expect(written?.['decal']).toBeUndefined();

    const depth = r.history!.undoDepth;
    const u = ok(service, 'undo', {});
    expect(u.history!.undoDepth).toBe(depth - 1);
    expect(assets(service).find((a) => a.assetId === 'crack-baked')).toBeUndefined();
    expect(components(service, id)['decal']).toEqual(decal);
    expect(components(service, id)['model']).toBeUndefined();
    ok(service, 'redo', {});
    expect(components(service, id)['model']).toEqual({ asset: { assetId: 'crack-baked' } });
    expect(components(service, id)['decal']).toBeUndefined();
  });
});
