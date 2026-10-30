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
 *   is copied onto a composed page; the sets ship as one linear array (a
 *   page's sets side by side, the albedo's sRGB texels kept), every decal
 *   material names its rectangle, mip cap, array and layers; a second
 *   export composes nothing (the import cache).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { testTempBase } from './testing';

import type { DecalPageRef, DecalPageReport } from '@thirdlight/project-model';
import { DECAL_PAGE_LIMITS } from '@thirdlight/project-model/limits';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeDecalAtlasRoutes } from './decal-atlas';
import { composePageRgba, type ComposeLayer } from './decal-page-compose';
import { encodeRgbaPng } from './image-thumbnail';
import { KTX2_TRANSFER_LINEAR, KTX2_TRANSFER_SRGB, ktx2LevelData, readKtx2 } from './ktx2-container';
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
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-decal-pages-'));
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

  it('ships one array for every set: the sheet as stored, the loose decal on a composed page; the materials name their places; a second export composes nothing', async () => {
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
    // The sheet's page (albedo, normal, ORM), then the composed page (albedo, ORM mask): one array of five layers.
    expect(arrays).toHaveLength(1);
    const file = (id: string): Uint8Array => new Uint8Array(readFileSync(join(out, 'content', 'sha256', content.assets.find((a) => a.assetId === id)!.sourceDigest)));
    const crack = content.materials.find((m) => m.materialId === 'mat-crack')!.decalPage!;
    const mark = content.materials.find((m) => m.materialId === 'mat-mark')!.decalPage!;
    expect(crack.rect).toEqual([8.5 / 256, 136.5 / 256, 71.5 / 256, 199.5 / 256]);
    expect(crack.albedo!.layer).toBe(0);
    expect(crack.normal).toEqual({ texture: crack.albedo!.texture, layer: 1 });
    expect(crack.orm).toEqual({ texture: crack.albedo!.texture, layer: 2 });
    expect(mark.albedo).toEqual({ texture: crack.albedo!.texture, layer: 3 });
    expect(mark.orm).toEqual({ texture: crack.albedo!.texture, layer: 4 });
    expect(mark.normal).toBeUndefined();
    expect(mark.rect).toEqual([8.5 / 256, 8.5 / 256, 71.5 / 256, 71.5 / 256]);
    expect(mark.mip).toBeGreaterThanOrEqual(3);
    // The sheet's layer is its file's texels: each level's first slice is the sheet's level; the array is linear (the
    // reader decodes the albedo layers' sRGB).
    const pages = readKtx2(file(crack.albedo!.texture))!;
    const sheet = readKtx2(new Uint8Array(readFileSync(game('assets', 'decals', 'sheet-albedo.ktx2'))))!;
    expect([pages.width, pages.layerCount, pages.levels.length, pages.transfer, sheet.transfer]).toEqual([256, 5, sheet.levels.length, KTX2_TRANSFER_LINEAR, KTX2_TRANSFER_SRGB]);
    for (let l = 0; l < sheet.levels.length; l++) {
      const own = ktx2LevelData(sheet, l);
      expect(Buffer.from(ktx2LevelData(pages, l).subarray(0, own.length)).equals(Buffer.from(own))).toBe(true);
    }
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

  it("the editor's decal atlas reads the build's pages, and Rebuild pages makes the export's arrays (from the cache)", async () => {
    const r = await exportNow();
    expect(r.status).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const content = exportContentOf(out) as unknown as { assets: { assetId: string; sourceDigest: string }[]; materials: { materialId: string; decalPage?: DecalPageRef }[] };
    const shipped = Object.fromEntries(content.materials.filter((m) => m.decalPage !== undefined).map((m) => [m.materialId, m.decalPage!]));
    type View = { ok: true; report: DecalPageReport; signature: string; composed: { signature: string; refs: Record<string, DecalPageRef>; ms: number } | null };
    const read = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages`, { method: 'GET', token: tb.adminToken, origin: null });
    expect(read.status, JSON.stringify(read.json).slice(0, 400)).toBe(200);
    const view = read.json as View;
    const report = view.report;
    // The build's numbers: the page side, its pages (two: the array's five layers are their sets), each material's rectangle.
    const pages = readKtx2(new Uint8Array(readFileSync(join(out, 'content', 'sha256', content.assets.find((a) => a.assetId === shipped['mat-crack']!.albedo!.texture)!.sourceDigest))))!;
    expect([report.size, report.pages.length, pages.layerCount]).toEqual([pages.width, 2, 5]);
    // Each page's albedo layer: the sheet's page first (three sets), then the composed one.
    const albedoLayerOf = [0, 3];
    expect(report.materials).toBe(Object.keys(shipped).length);
    for (const p of report.pages) {
      for (const rect of p.rects) {
        for (const id of rect.materials) {
          const [x, y, w, h] = rect.rect;
          const n = report.size;
          expect(shipped[id]!.rect, id).toEqual([(x + 0.5) / n, (y + 0.5) / n, (x + w - 0.5) / n, (y + h - 0.5) / n]);
          expect(shipped[id]!.albedo!.layer, id).toBe(albedoLayerOf[p.page]);
        }
      }
    }
    // The sheet page uses only its one cell; the GPU memory is the pages' block-compressed bytes.
    expect(report.pages[0]!.unused).toBeCloseTo(1 - (64 * 64) / (256 * 256), 6);
    // 16 bytes a 4 × 4 block, every level of 256² down to 1², for 2 albedo + 1 normal + 2 ORM pages.
    const chain = [256, 128, 64, 32, 16, 8, 4, 2, 1].reduce((n, side) => n + Math.ceil(side / 4) ** 2 * 16, 0);
    expect(report.gpuBytes).toBe(chain * 5);
    expect(report.offender).toBeNull();
    expect(view.composed).toBeNull();
    // Rebuild pages: the export's arrays (the same files, found in the cache), each material placed as the export placed it.
    const before = tb.backend._test.decalPages.stats.composed;
    const made = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages`, { method: 'POST', token: tb.adminToken, origin: null });
    expect(made.status, JSON.stringify(made.json).slice(0, 400)).toBe(200);
    const composed = (made.json as View).composed!;
    expect(composed.signature).toBe(view.signature);
    expect(composed.refs).toEqual(shipped);
    expect(tb.backend._test.decalPages.stats.composed).toBe(before);
    // Read again: still current; an array's bytes are the export's file.
    expect(((await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages`, { method: 'GET', token: tb.adminToken, origin: null })).json as View).composed?.signature).toBe(view.signature);
    const arrayId = composed.refs['mat-crack']!.albedo!.texture;
    const bytes = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages/arrays/${arrayId}`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    expect(bytes.status).toBe(200);
    expect(Buffer.from(await bytes.arrayBuffer()).equals(readFileSync(join(out, 'content', 'sha256', content.assets.find((a) => a.assetId === arrayId)!.sourceDigest)))).toBe(true);
    // Rebuild pages three times while a composition runs (the routes over the real project, the first held open): the
    // contents it read are the same, so they share it; none overlaps another.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    let inside = 0;
    let most = 0;
    const port = {
      decalPages: async (p: string, request: Parameters<NonNullable<typeof tb.backend._test.textureSlots.decalPages>>[1]) => {
        calls += 1;
        inside += 1;
        most = Math.max(most, inside);
        if (calls === 1) await held;
        try {
          return await tb.backend._test.textureSlots.decalPages!(p, request);
        } finally {
          inside -= 1;
        }
      },
    };
    const sent: { status: number; body: unknown }[] = [];
    const routes = makeDecalAtlasRoutes({ service: tb.backend._test.service, port, requireAuth: () => null, sendJson: (_res, status, body) => void sent.push({ status, body }), sendError: (_res, error, status) => void sent.push({ status: status ?? 400, body: error }) });
    const post = (): Promise<void> => routes({ method: 'POST' } as IncomingMessage, {} as ServerResponse, ['api', 'v1', 'projects', PID, 'content', 'decal-pages']);
    const first = post();
    await expect.poll(() => calls).toBe(1);
    const later = [post(), post(), post()];
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    release();
    await Promise.all([first, ...later]);
    expect([calls, most]).toEqual([1, 1]);
    expect(sent.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    for (const x of sent) expect((x.body as View).composed!.refs).toEqual(shipped);
    // A new decal material changes the pages: the composition is no longer current.
    await command('setMaterial', { material: { materialId: 'mat-mark-2', name: 'Mark 2', shader: 'decal', params: {}, textures: { map: ids['mark-glow'] } } });
    await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'mark 2', components: { decal: { size: [1, 1, 0.5], material: 'mat-mark-2' } } });
    const after = (await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages`, { method: 'GET', token: tb.adminToken, origin: null })).json as View;
    expect(after.signature).not.toBe(view.signature);
    expect(after.composed).toBeNull();
    expect(after.report.materials).toBe(3);
  }, 180_000);

  it('a cold atlas: Rebuild answers preview pages first, never stored, and composes the pages behind them; an export meanwhile ships the pages themselves', async () => {
    // The last test added a decal material: its page is not composed yet.
    type View = { ok: true; signature: string; composed: { refs: Record<string, DecalPageRef>; preview?: true } | null };
    const cachedSides = (): number[] => {
      const root = game('cache', 'imported');
      const out: number[] = [];
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const e of readdirSync(join(root, d.name))) {
          if (!e.startsWith('decal-pages-')) continue;
          for (const f of readdirSync(join(root, d.name, e))) {
            const k = readKtx2(new Uint8Array(readFileSync(join(root, d.name, e, f))));
            if (k !== null) out.push(k.width);
          }
        }
      }
      return out;
    };
    const before = tb.backend._test.decalPages.stats.composed;
    const previewed = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages?preview=1`, { method: 'POST', token: tb.adminToken, origin: null });
    expect(previewed.status, JSON.stringify(previewed.json).slice(0, 400)).toBe(200);
    const preview = (previewed.json as View).composed!;
    expect(preview.preview).toBe(true);
    const previewArray = preview.refs['mat-mark-2']!.albedo!.texture;
    const small = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages/arrays/${previewArray}`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    expect(small.status).toBe(200);
    expect(readKtx2(new Uint8Array(await small.arrayBuffer()))!.width).toBe(sheetSide / 4);
    // An export taken while the preview shows (the pages being composed behind it): it ships the pages themselves.
    const r = await exportNow();
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const content = exportContentOf(out) as unknown as { assets: { assetId: string; sourceDigest: string }[]; materials: { materialId: string; decalPage?: DecalPageRef }[] };
    const shipped = Object.fromEntries(content.materials.filter((m) => m.decalPage !== undefined).map((m) => [m.materialId, m.decalPage!]));
    expect(shipped['mat-mark-2']!.albedo!.texture).not.toBe(previewArray);
    for (const a of content.assets.filter((x) => x.assetId.startsWith('decals-'))) expect(readKtx2(new Uint8Array(readFileSync(join(out, 'content', 'sha256', a.sourceDigest))))!.width).toBe(sheetSide);
    // The pages themselves (the composition behind the preview): the export's places; the two pages the new decal changed
    // (the albedo page it joins and the mask page laid out with it) composed once each, the export and the atlas sharing them.
    const made = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages`, { method: 'POST', token: tb.adminToken, origin: null });
    expect(made.status).toBe(200);
    const final = (made.json as View).composed!;
    expect(final.preview).toBeUndefined();
    expect(final.refs).toEqual(shipped);
    expect(tb.backend._test.decalPages.stats.composed - before).toBe(2);
    // Nothing of the preview was stored: every page and array in the cache is at the page size.
    expect(cachedSides().every((side) => side === sheetSide)).toBe(true);
    // Made already: a preview asked now answers the pages themselves.
    expect(((await api(`${tb.authUrl}/api/v1/projects/${PID}/content/decal-pages?preview=1`, { method: 'POST', token: tb.adminToken, origin: null })).json as View).composed!.refs).toEqual(shipped);
  }, 180_000);

  it('the pages asked for right after a preview share the composition the preview started; a change meanwhile waits for one of its own', async () => {
    type View = { ok: true; composed: { preview?: true } | null };
    await command('setMaterial', { material: { materialId: 'mat-mark-3', name: 'Mark 3', shader: 'decal', params: {}, textures: { map: ids['mark'] } } });
    await command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'mark 3', components: { decal: { size: [1, 1, 0.5], material: 'mat-mark-3' } } });
    let finals = 0;
    const holds = new Map<number, Promise<void>>();
    const releases = new Map<number, () => void>();
    for (const n of [1, 2]) holds.set(n, new Promise<void>((r) => releases.set(n, r)));
    const port = {
      decalPages: async (p: string, request: Parameters<NonNullable<typeof tb.backend._test.textureSlots.decalPages>>[1], options?: { readonly preview?: boolean }) => {
        if (options?.preview !== true) await holds.get(++finals);
        return tb.backend._test.textureSlots.decalPages!(p, request, options);
      },
    };
    const sent: { status: number; body: unknown }[] = [];
    const routes = makeDecalAtlasRoutes({ service: tb.backend._test.service, port, requireAuth: () => null, sendJson: (_res, status, body) => void sent.push({ status, body }), sendError: (_res, error, status) => void sent.push({ status: status ?? 400, body: error }) });
    const post = (preview: boolean): Promise<void> => routes({ method: 'POST' } as IncomingMessage, {} as ServerResponse, ['api', 'v1', 'projects', PID, 'content', 'decal-pages'], new Map(preview ? [['preview', '1']] : []));
    // The preview, then the pages composing behind it (held); the editor's request for the pages shares that one.
    await post(true);
    expect((sent[0]!.body as View).composed!.preview).toBe(true);
    await expect.poll(() => finals).toBe(1);
    const pages = post(false);
    releases.get(1)!();
    await pages;
    expect(finals).toBe(1);
    // A composition running (held), the contents changed: a request now waits for a composition of its own after it.
    await command('setMaterial', { material: { materialId: 'mat-mark-3', name: 'Mark 3', shader: 'decal', params: {}, textures: { map: ids['mark-glow'] } } });
    const running = post(false);
    await expect.poll(() => finals).toBe(2);
    await command('setMaterial', { material: { materialId: 'mat-mark-3', name: 'Mark 3', shader: 'decal', params: {}, textures: { map: ids['mark'] } } });
    const changed = post(false);
    releases.get(2)!();
    await Promise.all([running, changed]);
    expect(finals).toBe(3);
    expect(sent.slice(1).map((x) => [x.status, (x.body as View).composed?.preview])).toEqual([[200, undefined], [200, undefined], [200, undefined]]);
  }, 180_000);
});
