/**
 * An instance-brush stroke (`paintInstances`) through the real service and
 * filesystem: the host plans the copies from the set's buffer and the
 * stroke's surface, the new buffer is published with the command as one undo
 * step; the same stroke gives the same buffer again (the editor and MCP send
 * the same command); an erase takes copies out; a stroke past the bound is
 * refused saying so; a stroke refused after it was planned (a stale
 * revision) leaves no buffer behind, since nothing collects an unused blob.
 */
import { glbBytes } from '@thirdlight/shared';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const stubInspector: StageInspector = () => {
  throw new Error('not used');
};

/** A GLB of one node: three points (an instance set only needs a model to name). */
function pointsGlb(): Uint8Array {
  const floats = [0, 0, 0, 1, 0, 0, 0, 0, 1];
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Tuft', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: floats.length * 4 }], buffers: [{ byteLength: floats.length * 4 }] };
  return glbBytes(JSON.stringify(gltf), new Uint8Array(new Float32Array(floats).buffer));
}
const metrics = { nodes: 1, meshes: 1, primitives: 1, materials: 0, images: 0, textures: 0, vertices: 3, triangles: 0, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 36, decodedImageBytes: 0 };

let seq = 0;
type Result = { ok: boolean; createdId?: string; error?: { code: string; message: string } };
const revision = (service: WorkspaceService): number => (service.query({ op: 'queryEntities', projectId: 'game', args: { limit: 1, offset: 0 } }) as unknown as { revision: number }).revision;
function command(service: WorkspaceService, op: string, args: Record<string, unknown>, expectedRevision = revision(service)): Result {
  seq += 1;
  return service.runCommand({ op, projectId: 'game', expectedRevision, requestId: `req-${(0x4510000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'vitest' }, args }) as unknown as Result;
}
const ok = (service: WorkspaceService, op: string, args: Record<string, unknown>): Result => {
  const r = command(service, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
};
const set = (service: WorkspaceService, id: string): { buffer: string; count: number } =>
  (service.query({ op: 'queryEntity', projectId: 'game', args: { entityId: id } }) as unknown as { entity: { components: { instances: { buffer: string; count: number } } } }).entity.components.instances;

describe('paintInstances through the service', () => {
  it('one command and one undo a stroke; the same stroke the same buffer; erase; too large refused; a stale stroke leaves no blob', () => {
    // Disposable roots on disk, not the tmpfs /tmp (the suite's reaper knows the prefix).
    const base = join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(), `.tl07-tmp-istroke-${process.pid}-${Date.now().toString(36)}`);
    roots.push(base);
    mkdirSync(join(base, 'data'), { recursive: true });
    const service = openWorkspaceService({ root: join(base, 'data'), assetInspector: stubInspector });
    try {
      const game = join(base, 'game');
      expect(service.createProjectInFolder(game, 'game', 'Game').ok).toBe(true);
      mkdirSync(join(game, 'assets'), { recursive: true });
      const glb = pointsGlb();
      writeFileSync(join(game, 'assets', 'tuft.glb'), glb);
      ok(service, 'publishAsset', { mode: 'create', assetId: 'tuft', kind: 'model', displayName: 'Tuft', sourceDigest: sha(glb), sourceByteLength: glb.length, sourcePath: 'assets/tuft.glb', importRecipe: RECIPE, metrics, importedAt: '2026-10-11T10:00:00Z' });
      // One copy far off.
      const one = new Uint8Array(new Float32Array([100, 0, 100, 0, 0, 0, 1, 1, 1, 1]).buffer);
      expect(service.publishBlob('game', { digest: sha(one), byteLength: one.byteLength, source: { kind: 'bytes', bytes: one } }).ok).toBe(true);
      const id = ok(service, 'createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Grass' }).createdId!;
      ok(service, 'setComponent', { entityId: id, component: 'instances', value: { asset: { assetId: 'tuft' }, buffer: sha(one), count: 1 } });
      const original = set(service, id);

      const brush = { radius: 2, density: 1.5, spacing: 0.4, scale: [0.5, 0.7], yaw: 180, align: 1, seed: 3 };
      const dabs = [[-20, 2, -16], [-17, 2, -15]];
      // The surface is the stroke's own (the editor's): one entry a candidate, flat ground at y = 2.
      const probe = command(service, 'paintInstances', { entityId: id, mode: 'paint', dabs, brush, surface: [] });
      const candidates = Number(/the stroke has (\d+)/.exec(probe.error?.message ?? '')?.[1]);
      expect(candidates).toBeGreaterThan(5);
      const surface = Array.from({ length: candidates }, () => [2, 0, 0]);
      const stroke = { entityId: id, mode: 'paint', dabs, brush, surface };

      ok(service, 'paintInstances', stroke);
      const painted = set(service, id);
      expect(painted.count).toBeGreaterThan(5);
      expect(painted.buffer).not.toBe(original.buffer);
      ok(service, 'undo', {});
      expect(set(service, id)).toEqual(original);
      ok(service, 'redo', {});
      expect(set(service, id)).toEqual(painted);
      // The same stroke again (undone first): the same copies, the same bytes.
      ok(service, 'undo', {});
      ok(service, 'paintInstances', stroke);
      expect(set(service, id)).toEqual(painted);

      // Erase around the first dab: fewer copies; one undo brings the stroke's buffer back.
      ok(service, 'paintInstances', { entityId: id, mode: 'erase', dabs: [dabs[0]], brush: { ...brush, radius: 1 } });
      expect(set(service, id).count).toBeLessThan(painted.count);
      ok(service, 'undo', {});
      expect(set(service, id)).toEqual(painted);

      // More places than one stroke may carry: refused, saying so, nothing changed.
      const big = command(service, 'paintInstances', { entityId: id, mode: 'paint', dabs: [[-18, 2, -16]], brush: { ...brush, radius: 40, density: 50 } });
      expect(big.ok).toBe(false);
      expect(big.error?.message).toMatch(/more than 1536 places/);
      expect(set(service, id)).toEqual(painted);

      // A stroke refused after it was planned: no blob published for it.
      const blobDir = [join(game, 'thirdlight', 'sources', 'sha256'), join(game, 'sources', 'sha256')].find((d) => existsSync(d))!;
      const before = readdirSync(blobDir).length;
      expect(before).toBeGreaterThan(0);
      const staleDabs = [[-14, 2, -14]];
      const staleProbe = command(service, 'paintInstances', { entityId: id, mode: 'paint', dabs: staleDabs, brush, surface: [] });
      const staleSurface = Array.from({ length: Number(/the stroke has (\d+)/.exec(staleProbe.error?.message ?? '')?.[1]) }, () => [2, 0, 0]);
      expect(staleSurface.length).toBeGreaterThan(0);
      const stale = command(service, 'paintInstances', { ...stroke, dabs: staleDabs, surface: staleSurface }, revision(service) - 1);
      expect(stale.ok).toBe(false);
      expect(stale.error?.code).toBe('revision_conflict');
      expect(readdirSync(blobDir).length).toBe(before);
    } finally {
      service.dispose();
    }
  });
});
