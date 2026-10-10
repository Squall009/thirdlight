/**
 * Decal pages: the composed pixels byte for byte, and the arrays a real
 * export ships over HTTP.
 *
 * - Composing: a rectangle the size of its source region is copied pixel for
 *   pixel, its gutter repeats its edge pixels, the rest of the page is the
 *   fill; a region read at another size never reads past its own pixels; an
 *   emissive mask is the largest of R, G and B.
 * - The export: a trim sheet the page size whose textures are UASTC is a
 *   layer as it is (each array level's slice of it equals the sheet's own
 *   level: nothing copied or encoded), a loose decal smaller than the page
 *   is copied onto a composed page; each set ships as one array, every
 *   decal material names its rectangle, mip cap, arrays and layers; a second
 *   export composes nothing (the import cache).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { DecalPageRef } from '@thirdlight/project-model';
import { DECAL_PAGE_LIMITS } from '@thirdlight/project-model/limits';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composePageRgba, type ComposeLayer } from './decal-page-compose';
import { encodeRgbaPng } from './image-thumbnail';
import { ktx2LevelData, readKtx2 } from './ktx2-container';
import { composeKtx2, encodeKtx2, KTX2_SOURCE_PIXELS_MAX, type Ktx2Mode } from './texture-encode';
import { api, exportContentOf, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';

/** A test image: pixel (x, y) is (x, y, x + y, a). */
function pattern(w: number, h: number, a = 255): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set([x & 255, y & 255, (x + y) & 255, a], (y * w + x) * 4);
  return out;
}
const at = (img: Uint8Array, size: number, x: number, y: number): number[] => [...img.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

describe('decal page pixels', () => {
  const src = { width: 16, height: 8, data: pattern(16, 8) };
  const whole: ComposeLayer['place'][number]['channels'] = [
    { source: 0, channel: 0 },
    { source: 0, channel: 1 },
    { source: 0, channel: 2 },
    { source: 0, channel: 3 },
  ];

  it('copies a rectangle pixel for pixel, repeats its edges into the gutter, fills the rest', () => {
    const page = composePageRgba(32, { fill: [1, 2, 3, 4], place: [{ channels: whole, src: [0, 0, 1, 1], dst: [4, 4, 16, 8], pad: [0, 0, 24, 16] }] }, [src]);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) expect(at(page, 32, 4 + x, 4 + y)).toEqual([x, y, x + y, 255]);
    // The gutter: the nearest edge pixel (corners: the corner pixel).
    expect(at(page, 32, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(page, 32, 2, 7)).toEqual([0, 3, 3, 255]);
    expect(at(page, 32, 23, 15)).toEqual([15, 7, 22, 255]);
    expect(at(page, 32, 21, 2)).toEqual([15, 0, 15, 255]);
    // Outside the padded box: the fill.
    expect(at(page, 32, 24, 0)).toEqual([1, 2, 3, 4]);
    expect(at(page, 32, 0, 16)).toEqual([1, 2, 3, 4]);
    expect(at(page, 32, 31, 31)).toEqual([1, 2, 3, 4]);
  });

  it('reads a sub-region at its own size exactly, and scaled without reaching past it', () => {
    // Pixels 4-11 × 2-5 of the source (a sheet cell), copied 1:1.
    const cell: ComposeLayer['place'][number] = { channels: whole, src: [4 / 16, 2 / 8, 12 / 16, 6 / 8], dst: [0, 0, 8, 4], pad: [0, 0, 8, 4] };
    const page = composePageRgba(16, { fill: [0, 0, 0, 0], place: [cell] }, [src]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) expect(at(page, 16, x, y)).toEqual([4 + x, 2 + y, 6 + x + y, 255]);
    // The same region at twice the size: every value stays within the region's own (x 4-11, y 2-5).
    const big = composePageRgba(16, { fill: [0, 0, 0, 0], place: [{ ...cell, dst: [0, 0, 16, 8], pad: [0, 0, 16, 8] }] }, [src]);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const [r, g] = at(big, 16, x, y);
        expect(r! >= 4 && r! <= 11 && g! >= 2 && g! <= 5).toBe(true);
      }
    }
  });

  it('an emissive mask is the largest of R, G and B; constants are constants', () => {
    const page = composePageRgba(16, { fill: [0, 0, 0, 0], place: [{ channels: [{ value: 255 }, { value: 7.6 }, { value: 300 }, { source: 0, channel: 'max' }], src: [0, 0, 1, 1], dst: [0, 0, 16, 8], pad: [0, 0, 16, 8] }] }, [src]);
    expect(at(page, 16, 3, 5)).toEqual([255, 8, 255, 8]);
    expect(at(page, 16, 10, 1)).toEqual([255, 8, 255, 11]);
  });

  it('the largest composed page is within what the encoder takes', () => {
    expect(DECAL_PAGE_LIMITS.composeSizeMax ** 2).toBeLessThanOrEqual(KTX2_SOURCE_PIXELS_MAX);
  });
});

/** A UASTC KTX2 of an image (what a game's tools write; colour in sRGB). */
async function uastc(rgba: Uint8Array, size: number, mode: Ktx2Mode): Promise<Uint8Array> {
  const r = await composeKtx2([encodeRgbaPng(rgba, size, size)], { fill: [0, 0, 0, 0], place: [{ channels: [0, 1, 2, 3].map((channel) => ({ source: 0, channel })) as never, src: [0, 0, 1, 1], dst: [0, 0, size, size], pad: [0, 0, size, size] }] }, size, mode);
  if (!r.ok) throw new Error(r.message);
  return r.ktx2;
}

describe('decal pages in a real export', () => {
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
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'decal-pages-test' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    return r.json as Record<string, unknown>;
  };
  const exportNow = () => api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
  const sheetSide = 256;

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-decal-pages-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    mkdirSync(game('assets', 'decals'), { recursive: true });
    // A trim sheet's three textures, UASTC at the page size; a loose decal's colour and emissive images (PNG, 64²).
    writeFileSync(game('assets', 'decals', 'sheet-albedo.ktx2'), await uastc(pattern(sheetSide, sheetSide), sheetSide, 'color'));
    const flat = new Uint8Array(sheetSide * sheetSide * 4).map((_, i) => [128, 128, 255, 255][i % 4]!);
    const n = await encodeKtx2(encodeRgbaPng(flat, sheetSide, sheetSide), 'normal');
    if (!n.ok) throw new Error(n.message);
    writeFileSync(game('assets', 'decals', 'sheet-normal.ktx2'), n.ktx2);
    writeFileSync(game('assets', 'decals', 'sheet-orm.ktx2'), await uastc(pattern(sheetSide, sheetSide), sheetSide, 'data'));
    writeFileSync(game('assets', 'decals', 'mark.png'), encodeRgbaPng(pattern(64, 64, 200), 64, 64));
    writeFileSync(game('assets', 'decals', 'mark-glow.png'), encodeRgbaPng(new Uint8Array(64 * 64 * 4).map((_, i) => [10, 240, 30, 255][i % 4]!), 64, 64));
    await command('importAssets', { folder: 'assets/decals' });
    const assets = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset: 0 } }) as unknown as { assets: { assetId: string; displayName: string }[] }).assets;
    for (const name of ['sheet-albedo', 'sheet-normal', 'sheet-orm', 'mark', 'mark-glow']) ids[name] = assets.find((a) => a.displayName === name)!.assetId;
    const trim = { size: [sheetSide, sheetSide], texelDensity: 128, padding: 8, rows: [{ slot: 'floor', top: 8, bottom: 72 }], cells: [{ name: 'crack', rect: [8, 136, 64, 64] }] };
    await command('setMaterial', { material: { materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: {}, textures: { map: ids['sheet-albedo'], normalMap: ids['sheet-normal'], ormMap: ids['sheet-orm'] }, trim } });
    await command('setMaterial', { material: { materialId: 'mat-crack', name: 'Crack', shader: 'decal', params: {}, textures: {}, decal: { sheet: 'mat-sheet', cell: 'crack' } } });
    await command('setMaterial', { material: { materialId: 'mat-mark', name: 'Mark', shader: 'decal', params: { emissive: '#ffffff', emissiveIntensity: 2 }, textures: { map: ids['mark'], emissiveMap: ids['mark-glow'] } } });
    for (const material of ['mat-crack', 'mat-mark']) await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: material, components: { decal: { size: [1, 1, 0.5], material } } });
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('ships one array per set: the sheet as stored, the loose decal on a composed page; the materials name their places; a second export composes nothing', async () => {
    const t0 = performance.now();
    const r = await exportNow();
    const coldMs = performance.now() - t0;
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const content = exportContentOf(out) as unknown as { assets: { assetId: string; sourceDigest: string }[]; materials: { materialId: string; decalPage?: DecalPageRef; textures: Record<string, string>; decal?: unknown }[] };
    // A placed decal material draws from the pages only: no textures or sheet cell of its own reach the runtime.
    for (const id of ['mat-crack', 'mat-mark']) {
      const m = content.materials.find((x) => x.materialId === id)!;
      expect([m.textures, m.decal]).toEqual([{}, undefined]);
    }
    console.log(`decal pages export ships: ${content.assets.map((a) => a.assetId).sort().join(' ')}`);
    const arrays = content.assets.filter((a) => a.assetId.startsWith('decals-'));
    // Albedo (sheet + composed), normal (sheet), ORM (sheet + composed mask page).
    expect(arrays).toHaveLength(3);
    const file = (id: string): Uint8Array => new Uint8Array(readFileSync(join(out, 'content', 'sha256', content.assets.find((a) => a.assetId === id)!.sourceDigest)));
    const crack = content.materials.find((m) => m.materialId === 'mat-crack')!.decalPage!;
    const mark = content.materials.find((m) => m.materialId === 'mat-mark')!.decalPage!;
    expect(crack.rect).toEqual([8.5 / 256, 136.5 / 256, 71.5 / 256, 199.5 / 256]);
    expect(crack.albedo!.layer).toBe(0);
    expect(crack.normal!.layer).toBe(0);
    expect(crack.orm!.layer).toBe(0);
    expect(mark.albedo).toEqual({ texture: crack.albedo!.texture, layer: 1 });
    expect(mark.orm).toEqual({ texture: crack.orm!.texture, layer: 1 });
    expect(mark.normal).toBeUndefined();
    expect(mark.rect).toEqual([8.5 / 256, 8.5 / 256, 71.5 / 256, 71.5 / 256]);
    expect(mark.mip).toBeGreaterThanOrEqual(3);
    // The sheet's layer is its file's texels: each level's first slice is the sheet's level.
    const albedo = readKtx2(file(crack.albedo!.texture))!;
    const sheet = readKtx2(new Uint8Array(readFileSync(game('assets', 'decals', 'sheet-albedo.ktx2'))))!;
    expect([albedo.width, albedo.layerCount, albedo.levels.length]).toEqual([256, 2, sheet.levels.length]);
    for (let l = 0; l < sheet.levels.length; l++) {
      const own = ktx2LevelData(sheet, l);
      expect(Buffer.from(ktx2LevelData(albedo, l).subarray(0, own.length)).equals(Buffer.from(own))).toBe(true);
    }
    const normal = readKtx2(file(crack.normal!.texture))!;
    expect(normal.layerCount).toBe(0);
    // Built again: the composed pages and arrays come from the import cache.
    const stats = tb.backend._test.decalPages.stats;
    const composed = stats.composed;
    expect(composed).toBe(2);
    const t1 = performance.now();
    expect((await exportNow()).status).toBe(200);
    const warmMs = performance.now() - t1;
    expect(stats.composed).toBe(composed);
    expect(stats.cached).toBeGreaterThanOrEqual(2);
    console.log(`decal pages export: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`);
  }, 180_000);
});
