/**
 * Block-layer chunk levels of detail against a real backend, per renderer
 * variant (renderer-variants.ts).
 *
 * A kit model's piece has two levels (`crate_LOD0` red, `crate_LOD1` blue,
 * the same size, so the colour tells the level). A block type shows it; a
 * layer holds a row of crates near the game camera and another over 60 m
 * away (past the model's switch distance plus the chunk's radius).
 * In Play each chunk is one level-of-detail group: the near chunk draws its
 * detailed level (red pixels), the far chunk its coarse one (blue pixels);
 * the Play diagnostics count one chunk at each level. The static export,
 * served with the backend stopped, shows the same colours.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test } from '@playwright/test';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-lod' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

async function api(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin }, body: '{}' });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

function count(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
const red = (r: number, g: number, b: number): boolean => r > 110 && g < 70 && b < 70 && r > 2 * g;
const blue = (r: number, g: number, b: number): boolean => b > 60 && b > 2 * r && b > 1.5 * g;

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

for (const variant of RENDERER_VARIANTS) test(`block-layer chunks switch to the model's coarser level with distance: Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend('block-lod-e2e');
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  await publishBytes(be, multiPieceGlb([{ name: 'crate', lods: [[1, 1, 1], [1, 1, 1]], colors: [[1, 0.02, 0.02], [0.02, 0.05, 1]] }]), 'model', 'kit', 'Kit');
  await cmd('setBlockType', { block: { blockId: 'crate', name: 'Crate', variants: [{ model: { assetId: 'kit', piece: 'crate' } }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Crates', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 2, 96] } } });
  // A row of crates in the chunk at z 0-16 (near the camera) and one in the chunk at z 48-64 (over 60 m away).
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 4, 16, 1, 12], cell: { block: 'crate' } }, { kind: 'fill', box: [0, 0, 52, 16, 1, 60], cell: { block: 'crate' } }] });
  // South of the crates, 6 m up, looking along +z and 15° down.
  const cam = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [8, 6, -8], rotation: [0, 0.9914449, 0.1305262, 0] } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The Scene view builds the level-of-detail groups too (once the kit's geometry is in).
  await expect.poll(async () => (JSON.parse((await page.locator('.tl-viewport').getAttribute('data-block-layers')) ?? '{}') as { lods?: { chunks: number } }).lods?.chunks ?? 0, { timeout: 30_000 }).toBe(2);

  // Play: one chunk at each level; red (detailed) near, blue (coarse) far.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect
    .poll(async () => {
      const r = await api(`play/${psid}/diagnostics`);
      return JSON.stringify((r.json as { diagnostics?: { renderer?: { blocks?: { lods?: { shown: number[] } } } } }).diagnostics?.renderer?.blocks?.lods?.shown ?? null);
    }, { timeout: 60_000, message: 'Play diagnostics: one chunk at each level' })
    .toBe('[1,1]');
  await expect
    .poll(async () => {
      const shot = await api(`play/${psid}/screenshot`);
      if (shot.status !== 200) return 'no screenshot';
      const img = decodePng(Buffer.from(String(shot.json.dataUrl ?? '').split(',')[1] ?? '', 'base64'));
      return `red ${count(img, red) > 300} blue ${count(img, blue) > 40}`;
    }, { timeout: 60_000, message: 'the near crates red (detailed), the far ones blue (coarse) in Play' })
    .toBe('red true blue true');

  // The export with the backend stopped: the same two levels.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect
      .poll(async () => {
        const img = decodePng(await canvas.screenshot());
        return `red ${count(img, red) > 300} blue ${count(img, blue) > 40}`;
      }, { timeout: 60_000, message: 'the near crates red, the far ones blue in the export' })
      .toBe('red true blue true');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
