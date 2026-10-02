/**
 * "Extract textures" at the HTTP boundary, on a project in the data root (its
 * own folder is its game folder):
 *
 * - a new model's images become texture assets in `<model>_textures/`: a PNG
 *   encoded to KTX2 with mips as what its material samples it as (colour,
 *   normal map, data); the model is published converted from its GLB, its
 *   stored bytes without the images, its `textures` naming the assets;
 * - an image another model already brought in is that texture asset;
 * - `extractTextures: false` keeps the images inside; a texture a model
 *   names cannot be deleted;
 * - the file check makes the stripped GLB again from the file when the cache
 *   lost it, and extracts again when the file changed;
 * - a folder import extracts its new models in the same command.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readGlbImages, stripGlbImages } from './glb-images';
import { encodeRgbaPng } from './image-thumbnail';
import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const PID = 'demo-0001';

/** A `size`² PNG, two colours in 8 px checks. */
function checker(size: number, a: [number, number, number], b: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? a : b;
      rgba.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
    }
  }
  return encodeRgbaPng(rgba, size, size);
}

/**
 * A quad GLB whose material samples `images` (base colour, normal, metal/roughness
 * in that order; a missing one is not sampled); `tag` makes files with the same images differ.
 */
function quadGlb(images: { base?: Uint8Array; normal?: Uint8Array; orm?: Uint8Array }, tag: string): Uint8Array {
  const parts: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (data: Uint8Array, target?: number): number => {
    const pad = (4 - (data.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target !== undefined ? { target } : {}) });
    parts.push(data, new Uint8Array(pad));
    offset += data.length + pad;
    return views.length - 1;
  };
  const f32 = (v: number[]): Uint8Array => new Uint8Array(new Float32Array(v).buffer);
  const vPos = view(f32([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 34962);
  const vNrm = view(f32([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 34962);
  const vUv = view(f32([0, 0, 1, 0, 1, 1, 0, 1]), 34962);
  const vIdx = view(new Uint8Array(new Uint16Array([0, 2, 1, 0, 3, 2]).buffer), 34963);
  const jsonImages: Record<string, unknown>[] = [];
  const textures: Record<string, unknown>[] = [];
  const slot = (bytes: Uint8Array | undefined, name: string): { index: number } | undefined => {
    if (bytes === undefined) return undefined;
    jsonImages.push({ name, bufferView: view(bytes), mimeType: 'image/png' });
    textures.push({ source: jsonImages.length - 1, sampler: 0 });
    return { index: textures.length - 1 };
  };
  const base = slot(images.base, 'albedo');
  const normal = slot(images.normal, 'normal');
  const orm = slot(images.orm, 'orm');
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bin = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bin.set(p, at);
    at += p.length;
  }
  const json = {
    asset: { version: '2.0', extras: { tag } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'quad', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [
      {
        name: 'surface',
        pbrMetallicRoughness: { ...(base !== undefined ? { baseColorTexture: base } : {}), ...(orm !== undefined ? { metallicRoughnessTexture: orm } : {}), metallicFactor: 0, roughnessFactor: 0.8 },
        ...(normal !== undefined ? { normalTexture: normal } : {}),
        ...(orm !== undefined ? { occlusionTexture: orm } : {}),
      },
    ],
    images: jsonImages,
    samplers: [{ magFilter: 9729, minFilter: 9987 }],
    textures,
    accessors: [
      { bufferView: vPos, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, -1], max: [1, 0, 1] },
      { bufferView: vNrm, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: vUv, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: vIdx, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(text.length + ((4 - (text.length % 4)) % 4)).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(12 + 8 + text.length + 8 + bin.length);
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

const ALBEDO = checker(64, [200, 120, 60], [40, 90, 160]);
const NORMAL = checker(64, [128, 128, 255], [150, 128, 240]);
const ORM = checker(64, [255, 200, 0], [255, 120, 0]);

describe('the GLB image reader and stripper', () => {
  it('lists the images with what the material samples them as, and takes them out', () => {
    const glb = quadGlb({ base: ALBEDO, normal: NORMAL, orm: ORM }, 'a');
    const read = readGlbImages(glb);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.images.map((i) => [i.index, i.name, i.mime, [...i.roles]])).toEqual([
      [0, 'albedo', 'image/png', ['color']],
      [1, 'normal', 'image/png', ['normal']],
      [2, 'orm', 'image/png', ['data']],
    ]);
    const stripped = stripGlbImages(glb, read.images, new Set([0, 1, 2]))!;
    expect(stripped.length).toBeLessThan(glb.length - ALBEDO.length - NORMAL.length);
    const again = readGlbImages(stripped);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // One-pixel stand-ins: white, and a flat normal for the normal map.
    expect(again.images.map((i) => i.bytes.length < 100)).toEqual([true, true, true]);
    // The geometry is kept byte for byte.
    const geometry = (b: Uint8Array): string => {
      const dv = new DataView(b.buffer, b.byteOffset);
      const jl = dv.getUint32(12, true);
      return createHash('sha256').update(b.subarray(28 + jl, 28 + jl + 4 * 12 * 2 + 4 * 8 + 12)).digest('hex');
    };
    expect(geometry(stripped)).toBe(geometry(glb));
  });
});

type AssetRow = { assetId: string; kind: string; extractTextures?: true; textures?: Record<string, string>; versions: { sourcePath?: string; sourceByteLength: number; convertedFrom?: { format: string; sourcePath?: string; encoding?: string }; metrics: { format?: string; levels?: number } }[] };

describe('extract textures over HTTP (a project in the data root)', () => {
  let tb: TestBackend;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const put = (rel: string, bytes: Uint8Array): void => {
    mkdirSync(join(dir(), ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir(), ...rel.split('/')), bytes);
  };
  const content = (): { assets: AssetRow[] } => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.content as { assets: AssetRow[] };
  };
  const asset = (id: string): AssetRow | undefined => content().assets.find((a) => a.assetId === id);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'extract-test' }, args }, token: tb.adminToken, origin: null });
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
  const publish = async (assetId: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) => {
    const p = await upload(bytes);
    return command('publishAsset', { mode: 'create', assetId, kind: 'model', displayName: assetId, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-10-01T00:00:00Z', folder: 'assets/props', extractTextures: true, ...extra });
  };
  const check = async () => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return (r.json as { check: { reimported: { assetId: string }[]; rebuilt: { assetId: string }[]; failed: unknown[] } }).check;
  };

  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('makes a new model\'s images KTX2 texture assets the model names; the stored model holds none of them', async () => {
    const glb = quadGlb({ base: ALBEDO, normal: NORMAL, orm: ORM }, 'crate');
    const r = await publish('crate', glb);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const report = (r.json as { textureExtraction: { images: { image: number; file?: string; encoding?: string; reused?: boolean }[]; created: string[] } }).textureExtraction;
    expect(report.images.map((i) => [i.image, i.file, i.encoding])).toEqual([
      [0, 'assets/props/crate_textures/albedo.png', 'color'],
      [1, 'assets/props/crate_textures/normal.png', 'normal'],
      [2, 'assets/props/crate_textures/orm.png', 'data'],
    ]);
    expect(report.created.length).toBe(3);
    const model = asset('crate')!;
    expect(model.extractTextures).toBe(true);
    expect(Object.keys(model.textures!)).toEqual(['0', '1', '2']);
    const v = model.versions[0]!;
    expect(v.convertedFrom).toMatchObject({ format: 'glb', sourcePath: 'assets/props/crate.glb' });
    // The stored model is the file without its images.
    expect(v.sourceByteLength).toBeLessThan(glb.length - ALBEDO.length);
    for (const [image, id] of Object.entries(model.textures!)) {
      const t = asset(id)!;
      expect(t.kind).toBe('texture');
      expect(t.versions[0]!.metrics.format).toBe('ktx2');
      expect(t.versions[0]!.metrics.levels).toBeGreaterThan(1);
      expect(t.versions[0]!.convertedFrom?.encoding).toBe(['color', 'normal', 'data'][Number(image)]);
    }
    // The original file and the texture files are in the game folder.
    expect(createHash('sha256').update(readFileSync(join(dir(), 'assets', 'props', 'crate.glb'))).digest('hex')).toBe(createHash('sha256').update(glb).digest('hex'));
    expect(readdirSync(join(dir(), 'assets', 'props', 'crate_textures')).filter((n) => !n.endsWith('.tlasset')).sort()).toEqual(['albedo.png', 'normal.png', 'orm.png']);
  });

  it('uses the texture asset an image already is, and keeps the images inside with extractTextures: false', async () => {
    const before = content().assets.length;
    const r = await publish('barrel', quadGlb({ base: ALBEDO }, 'barrel'));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const report = (r.json as { textureExtraction: { images: { reused?: boolean }[]; created: string[] } }).textureExtraction;
    expect(report.images[0]!.reused).toBe(true);
    expect(report.created).toEqual([]);
    expect(asset('barrel')!.textures).toEqual({ '0': asset('crate')!.textures!['0'] });
    expect(content().assets.length).toBe(before + 1);
    const kept = await publish('keg', quadGlb({ base: checker(32, [1, 2, 3], [4, 5, 6]) }, 'keg'), { extractTextures: false });
    expect(kept.status, JSON.stringify(kept.json)).toBe(200);
    expect(asset('keg')!.extractTextures).toBeUndefined();
    expect(asset('keg')!.textures).toBeUndefined();
    expect(asset('keg')!.versions[0]!.convertedFrom).toBeUndefined();
  });

  it('answers a retried extracting publish from its record (the same request, nothing extracted again)', async () => {
    const p = await upload(quadGlb({ base: checker(64, [7, 70, 140], [140, 70, 7]) }, 'retry'));
    const body = { op: 'publishAsset', projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'extract-test' }, args: { mode: 'create', assetId: 'crate-retry', kind: 'model', displayName: 'retry', sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-10-01T00:00:00Z', folder: 'assets/props' } };
    const send = () => api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body, token: tb.adminToken, origin: null });
    const first = await send();
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const count = content().assets.length;
    const again = await send();
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect((again.json as { duplicated: boolean }).duplicated).toBe(true);
    expect(content().assets.length).toBe(count);
    expect(asset('crate-retry')!.textures!['0']).toBeDefined();
  });

  it('refuses to delete a texture a model draws with', async () => {
    const id = asset('crate')!.textures!['1']!;
    const r = await command('deleteAsset', { assetId: id });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('reference_in_use');
  });

  it('makes the stripped model again from its file, and extracts again when the file changed', async () => {
    // A cleared import cache: made again from the file, the same bytes.
    rmSync(join(dir(), 'cache', 'imported'), { recursive: true, force: true });
    const rebuilt = await check();
    expect(rebuilt.failed).toEqual([]);
    expect(rebuilt.rebuilt.map((x) => x.assetId)).toContain('crate');
    // The file changes: a new base colour image becomes a new texture; the others are the assets they were.
    const before = asset('crate')!.textures!;
    put('assets/props/crate.glb', quadGlb({ base: checker(64, [10, 200, 10], [200, 10, 10]), normal: NORMAL, orm: ORM }, 'crate'));
    const again = await check();
    expect(again.failed).toEqual([]);
    expect(again.reimported.map((x) => x.assetId)).toEqual(['crate']);
    const after = asset('crate')!.textures!;
    expect(after['1']).toBe(before['1']);
    expect(after['2']).toBe(before['2']);
    expect(after['0']).not.toBe(before['0']);
    expect(existsSync(join(dir(), 'assets', 'props', 'crate_textures', 'albedo-2.png'))).toBe(true);
  });

  it('extracts a folder\'s new models in the folder import\'s one command', async () => {
    put('assets/kit/door.glb', quadGlb({ base: checker(64, [90, 90, 90], [20, 20, 20]), normal: NORMAL }, 'door'));
    const r = await command('importAssets', { folder: 'assets/kit', extractTextures: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const added = (r.json as { change: { added: AssetRow[] } }).change.added;
    const door = added.find((a) => a.assetId === 'door')!;
    expect(door.extractTextures).toBe(true);
    expect(Object.keys(door.textures!)).toEqual(['0', '1']);
    // The normal map is the one the crate brought in; the base colour is new.
    expect(door.textures!['1']).toBe(asset('crate')!.textures!['1']);
    expect(added.some((a) => a.assetId === door.textures!['0'] && a.kind === 'texture')).toBe(true);
    expect(added.length).toBe(2);
  });

  it('lists an extracted model whose file went missing as drawn from the import cache in Play and refused by an export', async () => {
    const glb = readFileSync(join(dir(), 'assets', 'kit', 'door.glb'));
    rmSync(join(dir(), 'assets', 'kit', 'door.glb'));
    await check();
    const problems = (await api(`${tb.authUrl}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as { missingFiles: { files: { assetId: string; fromCache?: boolean }[] }; problems: { code: string; message: string }[] };
    expect(problems.missingFiles.files.find((f) => f.assetId === 'door')).toMatchObject({ fromCache: true });
    const line = problems.problems.filter((p) => p.code === 'asset_files_missing').at(-1)!.message;
    expect(line).toContain('assets/kit/door.glb');
    expect(line).toContain('Play draws it from the cache, an export refuses it until the file is back');
    put('assets/kit/door.glb', glb);
    await check();
  });
});
