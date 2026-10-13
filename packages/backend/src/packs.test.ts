/**
 * The engine's Basic Kit pack, as files and over HTTP:
 *
 * - the pack resolves: `pack.json` reads, every file matches its digest;
 * - its trim sheet is made to the trim sheet spec: 2048² at 512 px/m, 8 px
 *   gutters, the spec's slots at the spec's pixel bounds (rows at their real
 *   height), a safe mip level of 4, KTX2 maps of the sheet's size (albedo in
 *   sRGB, normal and ORM linear), the albedo's gutters repeating its rows
 *   (within the compression's tolerance), a real height in A;
 * - the door and window GLBs have `<piece>_LOD0..2` and `<piece>_COL` at the
 *   file origin, collision parts, every level's trim UVs inside one row
 *   (u = metres ÷ 4, v within a row's inset bounds), origins at the bottom
 *   centre, and triangle budgets kept;
 * - `POST …/packs/basic-kit` adds it to a project as ordinary items (the
 *   assets published and inspected, the material, presets, block types and
 *   the kit), the kit's references all resolve, and a second add is refused.
 */
import { resolve } from 'node:path';

import type { MaterialDef } from '@thirdlight/project-model';
import { kitProblems } from '@thirdlight/project-model/kits';
import { TRIM_STARTER_ROWS, trimPaddingProblems, trimRowV, trimSheetSafeMipLevel, type TrimSheet } from '@thirdlight/project-model/trim-sheet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KTX2_TRANSFER_SRGB, readKtx2 } from './ktx2-container';
import { listPacks, loadPack, type Pack } from './packs';
import { api, startBackend, type TestBackend } from './test-helpers';
import { decodeTextureRgba } from './texture-encode';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const loaded = loadPack(REPO, 'basic-kit');
if (!loaded.ok) throw new Error(loaded.message);
const PACK: Pack = loaded.pack;
const FILES = loaded.files;
const fileOf = (assetId: string): Uint8Array => FILES.get(PACK.assets.find((a) => a.assetId === assetId)!.file)!;
const MATERIAL = (PACK.commands.find((c) => c.op === 'setMaterial')!.args['material'] as MaterialDef);
const SHEET = MATERIAL.trim as TrimSheet;

/** The JSON chunk and the binary chunk of a GLB. */
function glbParts(bytes: Uint8Array): { json: Record<string, any>; bin: DataView } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as Record<string, any>;
  const binStart = 20 + jsonLen + 8;
  return { json, bin: new DataView(bytes.buffer, bytes.byteOffset + binStart, dv.getUint32(20 + jsonLen, true)) };
}
function accessorFloats(g: { json: Record<string, any>; bin: DataView }, index: number): number[] {
  const a = g.json['accessors'][index];
  const view = g.json['bufferViews'][a.bufferView];
  const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3 } as Record<string, number>)[a.type]!;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a.componentType === 5126 ? g.bin.getFloat32(view.byteOffset + i * 4, true) : g.bin.getUint16(view.byteOffset + i * 2, true));
  return out;
}

describe('the Basic Kit pack', () => {
  it('resolves: listed, every file present with its digest, inside the download target', () => {
    expect(listPacks(REPO).map((p) => p.packId)).toContain('basic-kit');
    const total = PACK.assets.reduce((n, a) => n + a.bytes, 0);
    // The kit's sheet and pieces download in at most 4 MB.
    expect(total).toBeLessThanOrEqual(4_000_000);
    expect(PACK.commands.map((c) => c.op)).toEqual(['setMaterial', ...Array(6).fill('setGraph'), ...Array(7).fill('setBlockType'), 'setKit']);
  });

  it('has a trim sheet made to the spec', async () => {
    expect(SHEET.size).toEqual([2048, 2048]);
    expect(SHEET.texelDensity).toBe(512);
    expect(SHEET.padding).toBe(8);
    expect(SHEET.realHeight).toBe(true);
    // The spec's slots at the spec's pixel bounds (the engine's starter rows are the spec's table).
    for (const r of TRIM_STARTER_ROWS) expect(SHEET.rows.find((x) => x.slot === r.slot), r.slot).toEqual(r);
    for (const r of SHEET.rows) {
      expect((r.bottom - r.top) % 16, r.slot).toBe(0);
      expect((r.top - 8) % 16, r.slot).toBe(0);
    }
    expect(trimSheetSafeMipLevel(SHEET)).toBe(4);
    for (const id of [MATERIAL.textures['map']!, MATERIAL.textures['normalMap']!, MATERIAL.textures['ormMap']!]) {
      const k = readKtx2(fileOf(id))!;
      expect([k.width, k.height], id).toEqual([2048, 2048]);
      expect(k.levels.length, id).toBe(12);
      expect(k.transfer === KTX2_TRANSFER_SRGB, id).toBe(id === MATERIAL.textures['map']);
    }
    const albedo = await decodeTextureRgba(fileOf(MATERIAL.textures['map']!), 2048 * 2048);
    if (!albedo.ok) throw new Error(albedo.message);
    // Gutters repeat the rows (or a field's wrap) within what ETC1S moves.
    expect(trimPaddingProblems(albedo.data, albedo.width, albedo.height, SHEET, 24)).toEqual([]);
    // A real height in A per row: not opaque, not one value.
    for (const r of SHEET.rows) {
      let lo = 255;
      let hi = 0;
      for (let y = r.top; y < r.bottom; y += 4) for (let x = 0; x < 2048; x += 16) {
        const a = albedo.data[(y * 2048 + x) * 4 + 3]!;
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      expect(hi - lo, `${r.slot} height range`).toBeGreaterThan(20);
      expect(lo, `${r.slot} is not opaque`).toBeLessThan(255);
    }
  });

  for (const [assetId, piece, budget] of [['basic-door', 'door', 500], ['basic-window', 'window', 400]] as const) {
    it(`${piece}: levels, collision, UVs in the rows, origin at the bottom centre`, () => {
      const bytes = fileOf(assetId);
      const g = glbParts(bytes);
      const names = (g.json['nodes'] as { name: string; translation?: number[]; rotation?: number[]; scale?: number[] }[]).map((n) => n.name);
      expect(names).toEqual([`${piece}_LOD0`, `${piece}_LOD1`, `${piece}_LOD2`, `${piece}_COL`]);
      for (const n of g.json['nodes']) expect(n.translation ?? n.rotation ?? n.scale, n.name).toBeUndefined();
      // The collision mesh: closed boxes, one primitive (one convex part) each.
      const col = g.json['meshes'][g.json['nodes'][3].mesh] as { primitives: { indices: number }[] };
      expect(col.primitives.length).toBeGreaterThan(0);
      for (const p of col.primitives) expect(g.json['accessors'][p.indices].count).toBe(36);
      const rows = SHEET.rows.map((r) => trimRowV(SHEET, r));
      const tris: number[] = [];
      for (const [level, mesh] of (g.json['meshes'] as { primitives: { attributes: Record<string, number>; indices: number; material?: number }[] }[]).slice(0, 3).entries()) {
        let n = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        for (const p of mesh.primitives) {
          const idx = accessorFloats(g, p.indices);
          n += idx.length / 3;
          const pos = accessorFloats(g, p.attributes['POSITION']!);
          for (let i = 0; i < pos.length; i += 3) {
            minX = Math.min(minX, pos[i]!);
            maxX = Math.max(maxX, pos[i]!);
            minY = Math.min(minY, pos[i + 1]!);
          }
          if (g.json['materials'][p.material!].name !== 'trim') continue;
          // Every triangle's v inside one row's inset bounds.
          const uv = accessorFloats(g, p.attributes['TEXCOORD_0']!);
          for (let t = 0; t < idx.length; t += 3) {
            const vs = [0, 1, 2].map((k) => uv[idx[t + k]! * 2 + 1]!);
            const inRow = rows.some(([a, b]) => vs.every((v) => v >= a - 1e-6 && v <= b + 1e-6));
            expect(inRow, `${piece} LOD${level} triangle ${t / 3}: v ${vs.join(', ')}`).toBe(true);
          }
        }
        tris.push(n);
        // Bottom centre: one cell wide, centred on x, standing on y = 0.
        expect(minX, `LOD${level}`).toBeCloseTo(-0.5, 5);
        expect(maxX, `LOD${level}`).toBeCloseTo(0.5, 5);
        expect(minY, `LOD${level}`).toBeCloseTo(0, 5);
      }
      expect(tris[0]).toBeLessThanOrEqual(budget);
      expect(tris[1]).toBeLessThan(tris[0]!);
      expect(tris[2]).toBeLessThanOrEqual(tris[1]!);
    });
  }
});

describe('adding the Basic Kit to a project over HTTP', () => {
  let tb: TestBackend;
  const P = 'demo-0001';
  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO });
  });
  afterAll(async () => {
    await tb.teardown();
  });
  const post = async (path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, any> }> => {
    const r = await api(`${tb.authUrl}${path}`, { body, token: tb.authToken, origin: null });
    return { status: r.status, json: r.json as Record<string, any> };
  };

  it('adds every item once, the kit resolving; a second add is refused', async () => {
    const listed = await api(`${tb.authUrl}/api/v1/packs`, { method: 'GET', token: tb.authToken, origin: null });
    expect((listed.json as { packs: { packId: string }[] }).packs.map((p) => p.packId)).toContain('basic-kit');
    const r = await post(`/api/v1/projects/${P}/packs/basic-kit`, { origin: { kind: 'mcp', clientId: 'packs-test' } });
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    expect(r.json['added'].length).toBe(PACK.assets.length + 2 + PACK.commands.length);
    const q = await post(`/api/v1/projects/${P}/commands`, { op: 'queryProject', projectId: P, args: {} });
    const content = await api(`${tb.authUrl}/api/v1/projects/${P}/content/assets`, { method: 'GET', token: tb.authToken, origin: null });
    const assets = (content.json as { assets?: { assetId: string; materials?: Record<string, string> }[]; entries?: { assetId: string }[] });
    const ids = (assets.assets ?? assets.entries ?? []).map((a) => a.assetId);
    for (const a of PACK.assets) expect(ids, a.assetId).toContain(a.assetId);
    expect(Number(q.json['revision'])).toBe(r.json['revision']);
    const captured = tb.backend._test.service.readCapturedV3(P);
    if (!captured.ok) throw new Error('no project');
    const c = captured.read.content as unknown as Record<string, any>;
    expect(c['kits'].map((k: { kitId: string }) => k.kitId)).toEqual(['basic-kit']);
    expect(c['blockTypes'].length).toBe(7);
    expect(c['assets'].find((a: { assetId: string }) => a.assetId === 'basic-door').materials).toEqual({ trim: 'basic-trim' });
    expect(kitProblems(c as never)).toEqual([]);
    const again = await post(`/api/v1/projects/${P}/packs/basic-kit`);
    expect(again.status).toBe(409);
    expect(again.json['error'].code).toBe('pack_present');
  });
});
