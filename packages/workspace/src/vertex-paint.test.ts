/**
 * Vertex paint through the real service and filesystem: a `paintVertices`
 * stroke on a model stores one blob per mesh it reached (4 bytes a vertex,
 * published with the command) as one undo step; an instance copy's paint
 * goes in the set's copy table and slot pool and follows the copies when an
 * edit takes some out; a generated wall keeps its paint in path space; a
 * reimport that changes the mesh keeps the paint, reports it, and refuses
 * strokes over it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import { paintMismatches } from './paint-checks';
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

/** A GLB of one node "Plate": a grid of n × n vertices 1 m apart on the ground (+ `lift` m up). */
function plateGlb(n: number, lift = 0): Uint8Array {
  const floats: number[] = [];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) floats.push(x, lift, z);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Plate', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }], accessors: [{ bufferView: 0, componentType: 5126, count: n * n, type: 'VEC3' }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: floats.length * 4 }], buffers: [{ byteLength: floats.length * 4 }] };
  const bin = new Uint8Array(new Float32Array(floats).buffer);
  let json = new TextEncoder().encode(JSON.stringify(gltf));
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

const metrics = (n: number, bytes: number) => ({ nodes: 1, meshes: 1, primitives: 1, materials: 0, images: 0, textures: 0, vertices: n * n, triangles: 0, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: bytes, decodedImageBytes: 0 });

let seq = 0;
type Result = { ok: boolean; createdId?: string; error?: { code: string; message: string } };
function command(service: WorkspaceService, op: string, args: Record<string, unknown>): Result {
  const q = service.query({ op: 'queryEntities', projectId: 'game', args: { limit: 1, offset: 0 } }) as unknown as { revision: number };
  seq += 1;
  return service.runCommand({ op, projectId: 'game', expectedRevision: q.revision, requestId: `req-${(0x3210000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'vitest' }, args }) as unknown as Result;
}
const ok = (service: WorkspaceService, op: string, args: Record<string, unknown>): Result => {
  const r = command(service, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
};
const components = (service: WorkspaceService, id: string): Record<string, any> => (service.query({ op: 'queryEntity', projectId: 'game', args: { entityId: id } }) as unknown as { entity: { components: Record<string, any> } }).entity.components;
const blob = (service: WorkspaceService, digest: string): Uint8Array => {
  const r = service.readSourceBlob('game', { digest });
  if (!r.ok) throw new Error(r.error.message);
  return r.bytes;
};

function setup(tag: string): { service: WorkspaceService; game: string } {
  // Disposable roots on disk, not the tmpfs /tmp (the suite's reaper knows the prefix).
  const base = join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(), `.tl07-tmp-vpaint-${tag}-${process.pid}-${Date.now().toString(36)}`);
  roots.push(base);
  mkdirSync(join(base, 'data'), { recursive: true });
  const service = openWorkspaceService({ root: join(base, 'data'), assetInspector: stubInspector });
  const game = join(base, 'game');
  expect(service.createProjectInFolder(game, 'game', 'Game').ok).toBe(true);
  mkdirSync(join(game, 'assets'), { recursive: true });
  return { service, game };
}

function publishPlate(service: WorkspaceService, game: string, n: number, lift: number, mode: 'create' | 'reimport'): void {
  const glb = plateGlb(n, lift);
  const file = `plate-${n}-${lift}.glb`;
  writeFileSync(join(game, 'assets', file), glb);
  ok(service, 'publishAsset', { mode, assetId: 'plate', kind: 'model', displayName: 'Plate', sourceDigest: sha(glb), sourceByteLength: glb.length, sourcePath: `assets/${file}`, importRecipe: RECIPE, metrics: metrics(n, n * n * 12), importedAt: '2026-10-11T10:00:00Z' });
}

const BRUSH = { radius: 1, strength: 1, channel: 0, falloff: 'constant' };

describe('paintVertices', () => {
  it('paints a model\'s mesh in one undo step; a reimport keeps the paint, reports it and refuses strokes over it', () => {
    const { service, game } = setup('model');
    try {
      publishPlate(service, game, 4, 0, 'create');
      const id = ok(service, 'createEntity', { sceneId: 'scene-main', kind: 'model', name: 'plate', model: { asset: { assetId: 'plate' } } }).createdId!;
      ok(service, 'setTransform', { entityId: id, transform: { position: [10, 0, 0] } });
      // The object stands at x = 10: a dab at world (10, 0, 0) reaches the plate's corner vertex and its two neighbours.
      ok(service, 'paintVertices', { entityId: id, dabs: [[10, 0, 0]], brush: BRUSH });
      const first = components(service, id)['vertexPaint'];
      expect(first.meshes).toHaveLength(1);
      expect(first.meshes[0]).toMatchObject({ mesh: 'Plate#0', vertices: 16 });
      const bytes = blob(service, first.meshes[0].paint);
      expect(bytes.byteLength).toBe(16 * 4);
      const reds = [...bytes].filter((_, i) => i % 4 === 0);
      expect(reds).toEqual([255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      // A second stroke on G; then undo goes back to the first stroke's blob, and again to no component.
      ok(service, 'paintVertices', { entityId: id, dabs: [[13, 0, 3]], brush: { ...BRUSH, channel: 1 } });
      expect(components(service, id)['vertexPaint'].meshes[0].paint).not.toBe(first.meshes[0].paint);
      ok(service, 'undo', {});
      expect(components(service, id)['vertexPaint']).toEqual(first);
      ok(service, 'undo', {});
      expect(components(service, id)['vertexPaint']).toBeUndefined();
      ok(service, 'redo', {});
      expect(components(service, id)['vertexPaint']).toEqual(first);
      // Nothing under the stroke: no change. A bad brush: refused with its field.
      expect(command(service, 'paintVertices', { entityId: id, dabs: [[50, 0, 50]], brush: BRUSH }).error?.code).toBe('no_change');
      expect(command(service, 'paintVertices', { entityId: id, dabs: [[10, 0, 0]], brush: { ...BRUSH, channel: 7 } }).error?.code).toBe('field_value');
      expect(paintMismatches(service, 'game')).toEqual([]);

      // Reimported with its vertices moved: the paint stays as it was, is reported, and a stroke over it is refused.
      publishPlate(service, game, 4, 0.5, 'reimport');
      expect(components(service, id)['vertexPaint']).toEqual(first);
      const rows = paintMismatches(service, 'game')!;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toMatch(/Plate#0's vertices moved/);
      const refused = command(service, 'paintVertices', { entityId: id, dabs: [[10, 0.5, 0]], brush: BRUSH });
      expect(refused.error?.message).toMatch(/made for other vertices/);
      // By a code of its own and the mesh as found (the editor offers to remove that paint by these).
      expect(refused.error).toMatchObject({ code: 'vertex_paint_stale', path: '/args/entityId', found: 'Plate#0' });
      // Removed by hand, the mesh paints again (and fits).
      ok(service, 'setComponent', { entityId: id, component: 'vertexPaint', value: null });
      ok(service, 'paintVertices', { entityId: id, dabs: [[10, 0.5, 0]], brush: BRUSH });
      expect(paintMismatches(service, 'game')).toEqual([]);
      // A paint blob that is not stored is refused when set by hand.
      const bad = command(service, 'setComponent', { entityId: id, component: 'vertexPaint', value: { meshes: [{ ...first.meshes[0], paint: 'c'.repeat(64) }] } });
      expect(bad.ok).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it('paints one copy of an instance set into its slot; the table follows copies taken out', () => {
    const { service, game } = setup('copies');
    try {
      publishPlate(service, game, 3, 0, 'create');
      // Three copies at x = 0, 10, 20.
      const floats = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 10, 0, 0, 0, 0, 0, 1, 1, 1, 1, 20, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
      const buffer = new Uint8Array(floats.buffer);
      expect(service.publishBlob('game', { digest: sha(buffer), byteLength: buffer.byteLength, source: { kind: 'bytes', bytes: buffer } }).ok).toBe(true);
      const id = ok(service, 'createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Plates' }).createdId!;
      ok(service, 'setComponent', { entityId: id, component: 'instances', value: { asset: { assetId: 'plate' }, buffer: sha(buffer), count: 3 } });
      // A copy must be named; then copies 1 and 2 are painted (slots 0 and 1).
      expect(command(service, 'paintVertices', { entityId: id, dabs: [[10, 0, 0]], brush: BRUSH }).error?.message).toMatch(/one copy at a time/);
      ok(service, 'paintVertices', { entityId: id, copy: 1, dabs: [[10, 0, 0]], brush: BRUSH });
      ok(service, 'paintVertices', { entityId: id, copy: 2, dabs: [[22, 0, 2]], brush: { ...BRUSH, channel: 2 } });
      const paint = components(service, id)['instances'].paint;
      expect(paint).toMatchObject({ painted: 2, slots: 2, meshes: [{ mesh: 'Plate#0', vertices: 9 }] });
      expect([...new Uint32Array(blob(service, paint.copies).slice().buffer)]).toEqual([1, 0, 2, 1]);
      const pool = blob(service, paint.meshes[0].paint);
      expect(pool.byteLength).toBe(2 * 9 * 4);
      expect(pool[0]).toBe(255); // copy 1's corner, R
      expect(pool[9 * 4 + 8 * 4 + 2]).toBe(255); // copy 2's far corner, B

      // Copy 0 deleted (the editor's copy editing: setComponent with the new buffer): copies 1 and 2 are now 0 and 1, paint and all.
      const without = new Uint8Array(floats.slice(10).buffer);
      expect(service.publishBlob('game', { digest: sha(without), byteLength: without.byteLength, source: { kind: 'bytes', bytes: without } }).ok).toBe(true);
      ok(service, 'setComponent', { entityId: id, component: 'instances', value: { buffer: sha(without), count: 2 } });
      const moved = components(service, id)['instances'].paint;
      expect([...new Uint32Array(blob(service, moved.copies).slice().buffer)]).toEqual([0, 0, 1, 1]);
      expect(moved.meshes).toEqual(paint.meshes);
      ok(service, 'undo', {});
      expect(components(service, id)['instances'].paint).toEqual(paint);

      // Erasing all of copy 1's paint frees its slot; copy 2's stays.
      ok(service, 'paintVertices', { entityId: id, copy: 1, dabs: [[10, 0, 0]], brush: { ...BRUSH, erase: true } });
      const erased = components(service, id)['instances'].paint;
      expect(erased.painted).toBe(1);
      expect([...new Uint32Array(blob(service, erased.copies).slice().buffer)]).toEqual([2, 1]);
    } finally {
      service.dispose();
    }
  });

  it('follows the copies of every painted set one setComponent edits (entityIds)', () => {
    const { service, game } = setup('copies-many');
    try {
      publishPlate(service, game, 3, 0, 'create');
      const floats = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 10, 0, 0, 0, 0, 0, 1, 1, 1, 1, 20, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
      const buffer = new Uint8Array(floats.buffer);
      const without = new Uint8Array(floats.slice(10).buffer);
      for (const b of [buffer, without]) expect(service.publishBlob('game', { digest: sha(b), byteLength: b.byteLength, source: { kind: 'bytes', bytes: b } }).ok).toBe(true);
      const set = (name: string): string => {
        const id = ok(service, 'createEntity', { sceneId: 'scene-main', kind: 'group', name }).createdId!;
        ok(service, 'setComponent', { entityId: id, component: 'instances', value: { asset: { assetId: 'plate' }, buffer: sha(buffer), count: 3 } });
        return id;
      };
      const [a, b, c] = [set('A'), set('B'), set('C')];
      ok(service, 'paintVertices', { entityId: a, copy: 1, dabs: [[10, 0, 0]], brush: BRUSH });
      ok(service, 'paintVertices', { entityId: b, copy: 2, dabs: [[20, 0, 0]], brush: BRUSH });
      ok(service, 'paintVertices', { entityId: c, copy: 1, dabs: [[10, 0, 0]], brush: BRUSH });
      const table = (id: string): number[] => [...new Uint32Array(blob(service, components(service, id)['instances'].paint.copies).slice().buffer)];
      const before = { a: components(service, a)['instances'].paint, b: components(service, b)['instances'].paint };

      // Copy 0 of A and B taken out in one command with one shared value: each set's table follows its own copies.
      ok(service, 'setComponent', { entityId: a, component: 'instances', value: { buffer: sha(without), count: 2 }, entityIds: [b] });
      expect(table(a)).toEqual([0, 0]);
      expect(table(b)).toEqual([1, 0]);
      ok(service, 'undo', {});
      expect(components(service, a)['instances'].paint).toEqual(before.a);
      expect(components(service, b)['instances'].paint).toEqual(before.b);

      // With a value per set: the sets in entityIds follow too.
      ok(service, 'setComponent', { entityId: a, component: 'instances', value: { count: 3 }, entityIds: [b, c], values: [{ buffer: sha(without), count: 2 }, { buffer: sha(without), count: 2 }] });
      expect(table(a)).toEqual([...new Uint32Array(blob(service, before.a.copies).slice().buffer)]);
      expect(table(b)).toEqual([1, 0]);
      expect(table(c)).toEqual([0, 0]);
    } finally {
      service.dispose();
    }
  });

  it('keeps a generated wall\'s paint in path space', () => {
    const { service } = setup('wall');
    try {
      const id = ok(service, 'createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Wall' }).createdId!;
      ok(service, 'setComponent', { entityId: id, component: 'architecture', value: { elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [6, 0, 0]] }, profile: 'wall' }], profiles: { wall: { points: [[0, 0], [0, 3]], slots: ['lower_wall'] } } } });
      expect(command(service, 'paintVertices', { entityId: id, dabs: [[3, 1, 0]], brush: BRUSH }).error?.message).toMatch(/path and side/);
      expect(command(service, 'paintVertices', { entityId: id, path: 'element:door', side: 'right', dabs: [[3, 1, 0]], brush: BRUSH }).error?.message).toMatch(/no path/);
      ok(service, 'paintVertices', { entityId: id, path: 'element:wall', side: 'right', dabs: [[3, 1, 0]], brush: BRUSH });
      const [grid] = components(service, id)['vertexPaint'].paths;
      expect(grid).toMatchObject({ path: 'element:wall', side: 'right', origin: [8, 0], size: [9, 9] });
      expect(blob(service, grid.paint).byteLength).toBe(9 * 9 * 4);
      // Regenerating it (a taller profile) leaves the paint as it is: it is the path's, not the mesh's.
      ok(service, 'setComponent', { entityId: id, component: 'architecture', value: { profiles: { wall: { points: [[0, 0], [0, 4]], slots: ['lower_wall'] } } } });
      expect(components(service, id)['vertexPaint'].paths).toEqual([grid]);
      ok(service, 'undo', {});
      ok(service, 'undo', {});
      expect(components(service, id)['vertexPaint']).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
});
