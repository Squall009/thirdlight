/**
 * Phase 14.6: a project whose model entity carries the old `modelAnimation`
 * idle/run/airborne profile is moved to an animator controller when it is
 * opened (the clip lengths come from the model file), written as one new
 * revision; until then the old component is read as before.
 *
 * Real service, real filesystem (a folder project); the GLB is referenced in
 * place so its real bytes are read back through `readBlob`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const METRICS = { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 3, triangles: 1, animations: 3, animationChannels: 3, clipDurationMs: 2000, decodedGeometryBytes: 36, decodedImageBytes: 0 };
const stubInspector: StageInspector = () => {
  throw new Error('not used');
};

/** A GLB with one node and animations of the given lengths (one translation sampler each). */
function clipsGlb(clips: { name: string; length: number }[]): Uint8Array {
  const floats: number[] = [];
  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const animations: Record<string, unknown>[] = [];
  for (const c of clips) {
    bufferViews.push({ buffer: 0, byteOffset: floats.length * 4, byteLength: 8 });
    floats.push(0, c.length);
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [c.length] });
    bufferViews.push({ buffer: 0, byteOffset: floats.length * 4, byteLength: 24 });
    floats.push(0, 0, 0, 0, 1, 0);
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 2, type: 'VEC3' });
    animations.push({ name: c.name, samplers: [{ input: accessors.length - 2, output: accessors.length - 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] });
  }
  const bin = new Uint8Array(new Float32Array(floats).buffer);
  let json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'body' }], scenes: [{ nodes: [0] }], scene: 0, animations, accessors, bufferViews, buffers: [{ byteLength: bin.length }] }));
  json = new Uint8Array([...json, ...new Array((4 - (json.length % 4)) % 4).fill(0x20)]);
  const out = new Uint8Array(28 + json.length + bin.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  v.setUint32(20 + json.length, bin.length, true);
  v.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}

/** One backend identity for every open (a restart of the same backend). */
const BACKEND_ID = 'tb-146a146a146a146a146a146a146a146a';
let seq = 0;
function command(service: WorkspaceService, op: string, args: Record<string, unknown>) {
  const q = service.query({ op: 'queryEntities', projectId: 'game', args: { limit: 1, offset: 0 } }) as unknown as { revision: number };
  seq += 1;
  return service.runCommand({ op, projectId: 'game', expectedRevision: q.revision, requestId: `req-${(0x146000 + seq).toString(16).padStart(32, '0')}`, args }) as unknown as { ok: boolean; createdId?: string; revision?: number };
}

describe('the old modelAnimation profile moves to an animator on open', () => {
  it('writes a controller with the clips and their lengths, swaps the component, and plays the same clips', () => {
    const base = join('/home/dadmin', `.tl-anim-migrate-${process.pid}-${Date.now().toString(36)}`);
    roots.push(base);
    const root = join(base, 'data');
    const game = join(base, 'game');
    mkdirSync(root, { recursive: true });
    let service = openWorkspaceService({ root, backendId: BACKEND_ID, assetInspector: stubInspector });
    expect(service.createProjectInFolder(game, 'game', 'Game').ok).toBe(true);
    mkdirSync(join(game, 'assets'), { recursive: true });
    const glb = clipsGlb([
      { name: 'Idle', length: 2 },
      { name: 'Run', length: 0.5 },
      { name: 'Jump', length: 0.75 },
    ]);
    writeFileSync(join(game, 'assets', 'hero.glb'), glb);
    const pub = command(service, 'publishAsset', {
      mode: 'create',
      assetId: 'hero',
      kind: 'model',
      displayName: 'Hero',
      sourceDigest: sha(glb),
      sourceByteLength: glb.length,
      sourcePath: 'assets/hero.glb',
      importRecipe: RECIPE,
      metrics: METRICS,
      importedAt: '2026-09-24T10:00:00Z',
    });
    expect(pub.ok, JSON.stringify(pub)).toBe(true);
    const created = command(service, 'createEntity', { kind: 'model', name: 'hero', model: { asset: { assetId: 'hero' } } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const id = created.createdId!;
    const roles = { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Jump' } };
    const set = command(service, 'setComponent', { entityId: id, component: 'modelAnimation', value: { assetId: 'hero', version: 1, roles } });
    expect(set.ok, JSON.stringify(set)).toBe(true);
    // Until the project is opened again the old component is what is stored.
    const before = service.query({ op: 'queryEntity', projectId: 'game', args: { entityId: id } }) as unknown as { revision: number; entity: { components: Record<string, unknown> } };
    expect(before.entity.components['modelAnimation']).toBeDefined();
    service.dispose();

    // Open again: migrated.
    service = openWorkspaceService({ root, backendId: BACKEND_ID, assetInspector: stubInspector });
    try {
      const after = service.query({ op: 'queryEntity', projectId: 'game', args: { entityId: id } }) as unknown as { revision: number; entity: { components: Record<string, unknown> } };
      expect(after.entity.components['modelAnimation']).toBeUndefined();
      expect(after.entity.components['animator']).toEqual({ controller: 'idle-run-airborne-01' });
      expect(after.revision).toBe(before.revision + 1);
      const cfg = service.query({ op: 'queryGameConfig', projectId: 'game' }) as unknown as { animators: { controllerId: string; name: string; states: { id: string; motion: { clip: { assetId: string; clip: string; duration: number } } }[] }[] };
      expect(cfg.animators).toHaveLength(1);
      expect(cfg.animators[0]!.name).toBe('Idle/run/airborne (Hero)');
      expect(cfg.animators[0]!.states.map((s) => [s.id, s.motion.clip.clip, s.motion.clip.duration])).toEqual([
        ['idle', 'Idle', 2],
        ['run', 'Run', 0.5],
        ['airborne', 'Jump', 0.75],
      ]);
      // On disk too (the content file carries the controller).
      const onDisk = readFileSync(join(game, 'thirdlight', 'content.json'), 'utf8');
      expect(onDisk).toContain('idle-run-airborne-01');
    } finally {
      service.dispose();
    }

    // A third open changes nothing.
    service = openWorkspaceService({ root, backendId: BACKEND_ID, assetInspector: stubInspector });
    try {
      const again = service.query({ op: 'queryEntity', projectId: 'game', args: { entityId: id } }) as unknown as { revision: number };
      expect(again.revision).toBe(before.revision + 1);
    } finally {
      service.dispose();
    }
  });
});
