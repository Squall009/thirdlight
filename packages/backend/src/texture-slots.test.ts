/**
 * Per-layer texture slots over HTTP against the real backend, its disk and
 * a real export: single-layer KTX2 textures (made by the backend's own
 * encoder) in the game folder, a graph material whose two texture
 * parameters name them per slot (a colour one from ETC1S textures: encoded
 * once; a data one from UASTC textures: joined as stored), and an A/B
 * instance changing one colour slot.
 *
 * - The export ships one assembled array per distinct list (three: the two
 *   colour lists and the shared data list), the materials name those arrays,
 *   the slot textures themselves are not shipped.
 * - The arrays are made once: the import cache holds one entry per array,
 *   and a second export assembles nothing (`stats`).
 * - The editor's route answers the same array's bytes.
 * - A layered surface's albedo is a height array: a layer whose texture has
 *   no height in A gets a brightness height, the export ships the very array
 *   the editor's route answers, and a texture with height keeps its own.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readRuntimeContentSync } from '@thirdlight/exporter';
import { LAYERED_TEXTURES, layeredMaterial } from '@thirdlight/project-model/layered-surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeRgbaPng } from './image-thumbnail';
import { readKtx2 } from './ktx2-container';
import { encodeKtx2, type Ktx2Mode } from './texture-encode';
import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';

async function ktx2(rgba: [number, number, number, number], mode: Ktx2Mode): Promise<Uint8Array> {
  const r = await encodeKtx2(encodeRgbaPng(new Uint8Array(16 * 16 * 4).map((_, i) => rgba[i % 4]!), 16, 16), mode);
  if (!r.ok) throw new Error(r.message);
  return r.ktx2;
}

const sampler = (key: string, linear: boolean, x: number): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } => ({
  nodes: [
    { id: `p-${key}`, type: 'parameter', position: [0, x], data: { key } },
    { id: `s-${key}`, type: 'sampleTexture', position: [200, x], ...(linear ? { data: { colorSpace: 'linear' } } : {}) },
  ],
  edges: [{ id: `e-${key}`, from: { node: `p-${key}`, port: 'value' }, to: { node: `s-${key}`, port: 'tex' } }],
});

describe('per-layer texture slots: Play and export arrays', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const ids: Record<string, string> = {};
  const game = (...rel: string[]): string => join(tb.root, 'data', 'projects', PID, ...rel);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'texture-slots-test' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    return r.json as Record<string, unknown>;
  };
  const exportNow = () => api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
  /** The import cache's assembled arrays (one folder each). */
  const cachedArrays = (): string[] => {
    const root = game('cache', 'imported');
    const out: string[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) for (const e of readdirSync(join(root, d.name))) if (e.startsWith('texture-slots-')) out.push(`${d.name}/${e}`);
    return out;
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-texture-slots-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    mkdirSync(game('assets', 'slots'), { recursive: true });
    // Colour layers (ETC1S, sRGB) and data layers (UASTC, linear), single images.
    const files: [string, [number, number, number, number], Ktx2Mode][] = [
      ['c-red', [220, 40, 40, 230], 'color'],
      ['c-green', [40, 200, 40, 20], 'color'],
      ['c-blue', [40, 60, 220, 128], 'color'],
      ['d-one', [255, 204, 0, 255], 'data'],
      ['d-two', [200, 100, 0, 255], 'data'],
    ];
    for (const [name, rgba, mode] of files) writeFileSync(game('assets', 'slots', `${name}.ktx2`), await ktx2(rgba, mode));
    // An albedo with a height in A (a ramp across the image).
    const ramp = new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? ((i >> 2) % 16) * 16 : 120));
    const rampKtx = await encodeKtx2(encodeRgbaPng(ramp, 16, 16), 'color');
    if (!rampKtx.ok) throw new Error(rampKtx.message);
    writeFileSync(game('assets', 'slots', 'c-height.ktx2'), rampKtx.ktx2);
    files.push(['c-height', [0, 0, 0, 0], 'color']);
    await command('importAssets', { folder: 'assets/slots' });
    const assets = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset: 0 } }) as unknown as { assets: { assetId: string; displayName: string }[] }).assets;
    for (const [name] of files) ids[name] = assets.find((a) => a.displayName === name)!.assetId;
    const c = sampler('albedo', false, 0);
    const d = sampler('orm', true, 120);
    await command('setMaterial', {
      material: {
        materialId: 'mat-a',
        name: 'A',
        shader: 'standard',
        params: {},
        textures: {},
        parameters: [
          { key: 'albedo', type: 'texture', default: [ids['c-red'], ids['c-green'], ''] },
          { key: 'orm', type: 'texture', default: [ids['d-one'], ids['d-two'], ids['d-one']] },
        ],
        graph: {
          nodes: [...c.nodes, ...d.nodes, { id: 'out', type: 'pbr', position: [400, 0] }],
          edges: [...c.edges, ...d.edges, { id: 'w1', from: { node: 's-albedo', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } }, { id: 'w2', from: { node: 's-orm', port: 'g' }, to: { node: 'out', port: 'roughness' } }],
        },
      },
    });
    // The B side of a trial: slot 2 of the colour list changed.
    await command('setMaterial', { material: { materialId: 'mat-b', name: 'B', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-a', values: { albedo: [ids['c-red'], ids['c-blue'], ''] } } });
    for (const [name, mat] of [['Box A', 'mat-a'], ['Box B', 'mat-b']] as const) {
      const made = await command('createEntity', { sceneId: 'scene-main', kind: 'box', name });
      await command('setComponent', { entityId: made['createdId'], component: 'materials', value: { '*': mat } });
    }
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('the export ships one array per distinct list, the materials name them, the slot textures stay home; a second export assembles nothing', async () => {
    const before = { ...tb.backend._test.textureSlots.stats };
    const r = await exportNow();
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (p) => {
      try {
        return new Uint8Array(readFileSync(join(out, p)));
      } catch {
        return null;
      }
    }) as unknown as { assets: { assetId: string; kind: string; sourceDigest: string }[]; materials: { materialId: string; parameters: { key: string; default: unknown }[] }[] };
    const arrays = content.assets.filter((a) => a.assetId.startsWith('slots-'));
    expect(arrays).toHaveLength(3);
    for (const id of Object.values(ids)) expect(content.assets.some((a) => a.assetId === id)).toBe(false);
    const param = (m: string, k: string): unknown => content.materials.find((x) => x.materialId === m)!.parameters.find((p) => p.key === k)!.default;
    expect(param('mat-a', 'orm')).toBe(param('mat-b', 'orm'));
    expect(param('mat-a', 'albedo')).not.toBe(param('mat-b', 'albedo'));
    for (const a of arrays) {
      const k = readKtx2(new Uint8Array(readFileSync(join(out, 'content', 'sha256', a.sourceDigest))))!;
      expect(k.layerCount).toBe(3);
      expect(k.width).toBe(16);
    }
    expect(tb.backend._test.textureSlots.stats.assembled - before.assembled).toBe(3);
    expect(cachedArrays()).toHaveLength(3);
    // Built again: every array from the cache.
    expect((await exportNow()).status).toBe(200);
    expect(tb.backend._test.textureSlots.stats.assembled - before.assembled).toBe(3);
    expect(cachedArrays()).toHaveLength(3);
  }, 180_000);

  it('the editor route answers the array of the slots\' current versions', async () => {
    const res = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/slots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ layers: [ids['d-one'], ids['d-two'], ids['d-one']], mode: 'data' }),
    });
    expect(res.status).toBe(200);
    const k = readKtx2(new Uint8Array(await res.arrayBuffer()))!;
    expect(k.layerCount).toBe(3);
    // An empty ORM slot's neutral (a constant layer, `#rrggbbaa`) beside textures: the textures' size, its own layer.
    const filled = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/slots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ layers: [ids['d-one'], '#ffcc0000', ids['d-two']], mode: 'data' }),
    });
    expect(filled.status).toBe(200);
    const f = readKtx2(new Uint8Array(await filled.arrayBuffer()))!;
    expect([f.layerCount, f.width]).toEqual([3, 16]);
    const constantOnly = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/slots`, { method: 'POST', headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ layers: ['#ffcc0000'], mode: 'data' }) });
    expect(constantOnly.status).toBe(400);
    const bad = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/slots`, { method: 'POST', headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ layers: ['nope'], mode: 'data' }) });
    expect(bad.status).toBe(400);
  });

  it('a layered surface\'s albedo: the layer without height gets one from brightness, in the export and the editor\'s array alike', async () => {
    const base = layeredMaterial('mat-layered', 'Layered');
    const albedo = [ids['c-red']!, ids['c-height']!];
    const material = { ...base, parameters: (base.parameters ?? []).map((p) => (p.key === LAYERED_TEXTURES.albedo ? { ...p, default: albedo } : p)) };
    await command('setMaterial', { material });
    const made = await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Box L' });
    await command('setComponent', { entityId: made['createdId'], component: 'materials', value: { '*': 'mat-layered' } });
    const slots = (height: boolean) => fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/slots`, { method: 'POST', headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ layers: albedo, mode: 'color', ...(height ? { height: true } : {}) }) });
    const viewed = await slots(true);
    expect(viewed.status).toBe(200);
    // Layer 1 (a constant A) got a brightness height; layer 2 keeps its own.
    expect(viewed.headers.get('x-thirdlight-derived-height')).toBe('0');
    const plain = await slots(false);
    expect(plain.headers.get('x-thirdlight-derived-height')).toBe('');
    expect(plain.headers.get('x-thirdlight-digest')).not.toBe(viewed.headers.get('x-thirdlight-digest'));
    const r = await exportNow();
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (p) => {
      try {
        return new Uint8Array(readFileSync(join(out, p)));
      } catch {
        return null;
      }
    }) as unknown as { assets: { assetId: string; sourceDigest: string }[]; materials: { materialId: string; parameters: { key: string; default: unknown }[] }[] };
    const arrayId = content.materials.find((m) => m.materialId === 'mat-layered')!.parameters.find((p) => p.key === LAYERED_TEXTURES.albedo)!.default;
    expect(content.assets.find((a) => a.assetId === arrayId)!.sourceDigest).toBe(viewed.headers.get('x-thirdlight-digest'));
    // The backend's check: the problem names the texture without height, and the route says which is which.
    const heights = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/height-alpha?ids=${albedo.join(',')}`, { method: 'GET', token: tb.adminToken, origin: null });
    expect(heights.json).toMatchObject({ textures: { [albedo[0]!]: 'flat', [albedo[1]!]: 'height' } });
  }, 180_000);
});
