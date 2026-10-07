/**
 * Generated levels of detail ("generate LODs", an import setting):
 *
 * - in the file: a mesh node becomes `<name>_LOD0` with coarser siblings that
 *   share its vertex data; a node that cannot get simpler and a model with
 *   authored levels are left as they are; the importer accepts the result;
 * - over HTTP: a model published with `generateLods: true` is stored with its
 *   levels (`convertedFrom.lods`), one published without is stored as it was
 *   (an absent setting keeps the old behaviour), a re-import keeps the
 *   levels, the file check makes the same bytes again when the cache lost
 *   them, and a folder import generates them when asked.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadMeshSimplifier } from '@thirdlight/asset-pipeline';
import { MESH_LOD_RATIOS_DEFAULT } from '@thirdlight/project-model/limits';

import { createAssetInspector } from './content';
import { readGlb, writeGlb } from './glb-images';
import { generateGlbLods, type GlbLodReport } from './glb-lods';
import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const PID = 'demo-0001';

/** A welded UV sphere (radius 1). */
function sphere(seg: number, rings: number): { positions: number[]; indices: number[] } {
  const p: number[] = [0, 1, 0];
  for (let j = 1; j < rings; j++) {
    const v = (j / rings) * Math.PI;
    for (let i = 0; i < seg; i++) {
      const u = (i / seg) * Math.PI * 2;
      p.push(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u));
    }
  }
  p.push(0, -1, 0);
  const bottom = p.length / 3 - 1;
  const at = (j: number, i: number): number => 1 + (j - 1) * seg + (i % seg);
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) idx.push(0, at(1, i + 1), at(1, i));
  for (let j = 1; j < rings - 1; j++) for (let i = 0; i < seg; i++) idx.push(at(j, i), at(j, i + 1), at(j + 1, i), at(j, i + 1), at(j + 1, i + 1), at(j + 1, i));
  for (let i = 0; i < seg; i++) idx.push(bottom, at(rings - 1, i), at(rings - 1, i + 1));
  return { positions: p, indices: idx };
}
const QUAD = { positions: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], indices: [0, 2, 1, 0, 3, 2] };

/** A GLB of mesh nodes (each its own mesh, a root of the scene); `names` of `extraNodes` are plain empties. */
function meshGlb(nodes: { name: string; mesh: { positions: number[]; indices: number[] } }[], tag: string, extraNodes: string[] = []): Uint8Array {
  const parts: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (data: Uint8Array, target: number): number => {
    const pad = (4 - (data.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
    parts.push(data, new Uint8Array(pad));
    offset += data.length + pad;
    return views.length - 1;
  };
  const meshes = nodes.map((n) => {
    const pos = new Float32Array(n.mesh.positions);
    const min = [0, 1, 2].map((c) => Math.min(...n.mesh.positions.filter((_, i) => i % 3 === c)));
    const max = [0, 1, 2].map((c) => Math.max(...n.mesh.positions.filter((_, i) => i % 3 === c)));
    accessors.push({ bufferView: view(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    const p = accessors.length - 1;
    accessors.push({ bufferView: view(new Uint8Array(new Uint16Array(n.mesh.indices).buffer), 34963), componentType: 5123, count: n.mesh.indices.length, type: 'SCALAR' });
    return { name: n.name, primitives: [{ attributes: { POSITION: p }, indices: accessors.length - 1 }] };
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    bin.set(part, at);
    at += part.length;
  }
  const allNodes = [...nodes.map((n, i) => ({ name: n.name, mesh: i, translation: [i * 3, 0, 0] })), ...extraNodes.map((name) => ({ name }))];
  const json = { asset: { version: '2.0', extras: { tag } }, scene: 0, scenes: [{ nodes: allNodes.map((_, i) => i) }], nodes: allNodes, meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(text.length + ((4 - (text.length % 4)) % 4)).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(28 + text.length + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  dv.setUint32(20 + text.length, bin.length, true);
  dv.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}

type Json = Record<string, any>;
const jsonOf = (glb: Uint8Array): Json => {
  const parts = readGlb(glb);
  if (typeof parts === 'string') throw new Error(parts);
  return parts.json as Json;
};
const inspect = (bytes: Uint8Array): { status: string; metrics?: { triangles: number } } => createAssetInspector()(bytes, { now: () => 0, isCancelled: () => false, proposalId: () => `p-${'0'.repeat(32)}`, stageId: () => 'extract', expiresAt: () => '2030-01-01T00:00:00Z' }, { kind: 'model' }) as never;

describe('generated levels in a GLB', () => {
  it('turns each mesh node that can get simpler into levels beside it, sharing its vertices; the importer accepts the file', async () => {
    const s = await loadMeshSimplifier();
    const ball = sphere(48, 24);
    const glb = meshGlb([{ name: 'rock', mesh: ball }, { name: 'plank', mesh: QUAD }], 'a', ['marker']);
    const made = generateGlbLods(glb, s);
    expect(made.glb).not.toBeNull();
    const report = made.report as GlbLodReport;
    expect(report.nodes).toBe(1);
    expect(report.skipped).toEqual([{ node: 'plank', reason: 'it cannot get simpler within the error bound' }]);
    const tris = ball.indices.length / 3;
    expect(report.triangles[0]).toBe(tris);
    expect(report.triangles).toHaveLength(1 + MESH_LOD_RATIOS_DEFAULT.length);
    report.triangles.slice(1).forEach((t, i) => expect(t).toBeLessThanOrEqual(Math.ceil(tris * MESH_LOD_RATIOS_DEFAULT[i]!) + 1));
    const json = jsonOf(made.glb!);
    expect(json['nodes'].map((n: Json) => n.name)).toEqual(['rock_LOD0', 'plank', 'marker', 'rock_LOD1', 'rock_LOD2', 'rock_LOD3']);
    // The levels stand where the node stands, in the scene's roots, and draw its vertex data with their own indices.
    expect(json['scenes'][0].nodes).toEqual([0, 1, 2, 3, 4, 5]);
    const levelMeshes = json['nodes'].slice(3).map((n: Json) => json['meshes'][n.mesh]);
    for (const n of json['nodes'].slice(3)) expect(n.translation).toEqual([0, 0, 0]);
    for (const m of levelMeshes) expect(m.primitives[0].attributes.POSITION).toBe(json['meshes'][0].primitives[0].attributes.POSITION);
    expect(levelMeshes.map((m: Json) => json['accessors'][m.primitives[0].indices].count / 3)).toEqual(report.triangles.slice(1));
    // Everything that was in the file is kept byte for byte at the start of the binary chunk.
    const before = readGlb(glb) as { bin: Uint8Array };
    const after = readGlb(made.glb!) as { bin: Uint8Array };
    expect(Buffer.from(after.bin.subarray(0, before.bin.length)).equals(Buffer.from(before.bin))).toBe(true);
    const inspected = inspect(made.glb!);
    expect(inspected.status).toBe('ok');
    expect(inspected.metrics!.triangles).toBe(report.triangles.reduce((a, b) => a + b, 0) + 2);
  });

  it('leaves a model with authored levels as it is, an animated node as it is, and says why nothing was made', async () => {
    const s = await loadMeshSimplifier();
    // A node an animation moves keeps its single level (a level beside it would stand still).
    const parts = readGlb(meshGlb([{ name: 'fan', mesh: sphere(32, 16) }], 'c')) as { json: Json; bin: Uint8Array };
    const animatedJson = { ...parts.json, animations: [{ channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 0, output: 0 }] }] };
    const animated = generateGlbLods(writeGlb(animatedJson, parts.bin), s);
    expect(animated.glb).toBeNull();
    expect((animated.report as GlbLodReport).skipped).toEqual([{ node: 'fan', reason: 'an animation moves it' }]);
    const authored = generateGlbLods(meshGlb([{ name: 'tree_LOD0', mesh: sphere(16, 8) }, { name: 'tree_LOD1', mesh: QUAD }], 'b'), s);
    expect(authored.glb).toBeNull();
    expect((authored.report as GlbLodReport).authored).toBe(true);
    expect(generateGlbLods(new Uint8Array([1, 2, 3]), s)).toEqual({ glb: null, report: { error: 'the file is shorter than a GLB header' } });
  });
});

type AssetRow = { assetId: string; extractTextures?: true; versions: { version: number; sourceDigest: string; sourceByteLength: number; convertedFrom?: { format: string; lods?: number[]; sourcePath?: string } }[] };

describe('generate LODs over HTTP (a project in the data root)', () => {
  let tb: TestBackend;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const content = (): { assets: AssetRow[] } => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.content as { assets: AssetRow[] };
  };
  const asset = (id: string): AssetRow => content().assets.find((a) => a.assetId === id)!;
  const current = (id: string): AssetRow['versions'][number] => asset(id).versions.at(-1)!;
  const stored = (id: string): Uint8Array => {
    const r = tb.backend._test.service.readBlob(PID, { assetId: id, version: current(id).version });
    if (!r.ok) throw new Error(r.error.code);
    return r.bytes;
  };
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'lods-test' }, args }, token: tb.adminToken, origin: null });
  const upload = async (bytes: Uint8Array): Promise<{ sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown }> => {
    const created = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null });
    const stageId = (created.json as { stageId: string }).stageId;
    const res = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
      body: new Uint8Array(bytes),
    });
    expect(res.status).toBe(200);
    const inspected = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/inspect`, { body: {}, token: tb.adminToken, origin: null });
    expect(inspected.status, JSON.stringify(inspected.json)).toBe(200);
    return (inspected.json as { proposal: { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown } }).proposal;
  };
  const publish = async (assetId: string, bytes: Uint8Array, extra: Record<string, unknown>) => {
    const p = await upload(bytes);
    return command('publishAsset', { mode: 'create', assetId, kind: 'model', displayName: assetId, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-10-01T00:00:00Z', folder: 'assets/props', ...extra });
  };
  const levelNames = (bytes: Uint8Array): string[] => jsonOf(bytes)['nodes'].map((n: Json) => n.name).filter((n: string) => /_LOD\d$/.test(n));

  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('a model published with generateLods is stored with its levels; one published without is stored as it was', async () => {
    const glb = meshGlb([{ name: 'boulder', mesh: sphere(48, 24) }], 'boulder');
    const r = await publish('boulder', glb, { generateLods: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const report = (r.json as { textureExtraction: { lods: GlbLodReport } }).textureExtraction.lods;
    expect(report.nodes).toBe(1);
    expect(current('boulder').convertedFrom).toMatchObject({ format: 'glb', sourcePath: 'assets/props/boulder.glb', lods: [...MESH_LOD_RATIOS_DEFAULT] });
    expect(levelNames(stored('boulder'))).toEqual(['boulder_LOD0', 'boulder_LOD1', 'boulder_LOD2', 'boulder_LOD3']);
    // Without the setting a model is stored as it was before the setting existed.
    const plain = await publish('pebble', meshGlb([{ name: 'pebble', mesh: sphere(48, 24) }], 'pebble'), {});
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    expect(current('pebble').convertedFrom).toBeUndefined();
    expect(levelNames(stored('pebble'))).toEqual([]);
  });

  it('a re-import keeps the levels; the file check makes the same bytes again when the import cache lost them', async () => {
    const changed = meshGlb([{ name: 'boulder', mesh: sphere(40, 20) }], 'boulder-2');
    writeFileSync(join(dir(), 'assets', 'props', 'boulder.glb'), changed);
    const check = async () => {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return (r.json as { check: { reimported: { assetId: string }[]; rebuilt: { assetId: string }[]; failed: unknown[] } }).check;
    };
    const first = await check();
    expect(first.failed).toEqual([]);
    expect(first.reimported.map((x) => x.assetId)).toEqual(['boulder']);
    expect(current('boulder').version).toBe(2);
    expect(current('boulder').convertedFrom?.lods).toEqual([...MESH_LOD_RATIOS_DEFAULT]);
    const bytes = stored('boulder');
    expect(levelNames(bytes)).toHaveLength(4);
    // The cache loses the converted file: the check makes it again from the file, byte for byte.
    rmSync(join(dir(), 'cache', 'imported'), { recursive: true, force: true });
    const second = await check();
    expect(second.failed).toEqual([]);
    expect(second.rebuilt.map((x) => x.assetId)).toEqual(['boulder']);
    expect(current('boulder').version).toBe(2);
    expect(Buffer.from(stored('boulder')).equals(Buffer.from(bytes))).toBe(true);
  });

  it('a folder import generates the levels of its new models when asked', async () => {
    mkdirSync(join(dir(), 'assets', 'rocks'), { recursive: true });
    writeFileSync(join(dir(), 'assets', 'rocks', 'stone.glb'), meshGlb([{ name: 'stone', mesh: sphere(48, 24) }], 'stone'));
    const r = await command('importAssets', { folder: 'assets/rocks', generateLods: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const added = content().assets.find((a) => a.versions[0]!.convertedFrom?.sourcePath === 'assets/rocks/stone.glb')!;
    expect(added.versions[0]!.convertedFrom?.lods).toEqual([...MESH_LOD_RATIOS_DEFAULT]);
    expect(levelNames(stored(added.assetId))).toHaveLength(4);
  });
});
