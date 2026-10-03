/**
 * Light baking of block layers. The preview bake runs on the product's own
 * renderer (renderer-variants.ts PRODUCT_RENDERER_VARIANTS): lightmaps.e2e
 * bakes and shows a lightmap on both backends.
 *
 * The ground is a static block layer (a 12 × 8 floor of 1 m cells, top at
 * y = 0) with a static cube standing on it; the sun and the ambient light are
 * "baked". Before a bake Play shows no shadow (the sun casts no realtime
 * shadow). "Bake preview" in the Lighting window bakes the cube and each
 * chunk of the layer (a chunk entry: the layer, its chunk and the chunk's
 * lightmap layout); Play then shows the cube's shadow on the blocks from the
 * chunk's lightmap, and a lit spot keeps about the realtime brightness. The
 * static export, served with the backend stopped, shows the same. A cell
 * edit makes the bake stale. "Bake final" (Blender Cycles, when Blender is
 * there) bakes the chunks the same way.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { openWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-block-lightmaps' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

/** Mean brightness of a small square around a world point, as the game camera (0, 3, 6) looking down 30° sees it. */
function brightnessAt(img: Image, world: [number, number, number]): number {
  const camera = new THREE.PerspectiveCamera(60, img.width / img.height, 0.1, 100);
  camera.position.set(0, 3, 6);
  camera.quaternion.set(-0.2588190451, 0, 0, 0.9659258263);
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(...world).project(camera);
  const cx = Math.round(((p.x + 1) / 2) * img.width);
  const cy = Math.round(((1 - p.y) / 2) * img.height);
  let sum = 0;
  let n = 0;
  for (let y = cy - 3; y <= cy + 3; y++)
    for (let x = cx - 3; x <= cx + 3; x++) {
      const [r, g, b] = img.pixel(x, y);
      sum += (r + g + b) / 3;
      n += 1;
    }
  return sum / n;
}

const shadowSpot: [number, number, number] = [0.95, 0, -0.75];
const litSpot: [number, number, number] = [-0.95, 0, -0.75];

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
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

async function play(page: Page, variant: RendererVariant): Promise<Image> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await page.waitForTimeout(2500);
  const img = decodePng(await frame.screenshot());
  await page.getByTitle('Stop the play preview').click();
  return img;
}

/** The scene: a static block-layer floor, a static cube on it, the sun and ambient "baked"; the editor open on it. */
async function openScene(page: Page, variant: RendererVariant, env: Record<string, string> = {}): Promise<{ layer: string; cube: string }> {
  be = await startBackend('block-lightmaps-e2e', undefined, env);
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#b0b0b0' }], shape: 'full' } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Floor', transform: { position: [-6, -1, -4] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [12, 4, 8] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 1, 8], cell: { block: 'stone' } }] });
  const cube = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', box: { size: [1, 2, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 1, 0] } })).createdId);
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 3, 6], rotation: [-0.2588190451, 0, 0, 0.9659258263] } });
  await cmd('updateEntity', { entityId: layer, static: true });
  await cmd('updateEntity', { entityId: cube, static: true });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6, mode: 'baked' } });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await expect.poll(async () => JSON.parse((await page.locator('.tl-viewport').getAttribute('data-block-layers')) ?? '{"chunks":0}').chunks as number, { timeout: 30_000 }).toBe(1);
  return { layer, cube };
}

async function bakeEntries(): Promise<{ entityId: string; chunk?: number[]; layout?: string }[]> {
  const config = await be!.command({ op: 'queryGameConfig', projectId: be!.projectId });
  return Object.values(config['lighting'] as Record<string, { entries: { entityId: string; chunk?: number[]; layout?: string }[] }>)[0]!.entries;
}

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`Bake preview bakes a static block layer's chunks: the cube's shadow on the blocks in Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(300_000);
  const { layer, cube } = await openScene(page, variant);

  // Before the bake: the sun is realtime without a shadow.
  const before = await play(page, variant);
  const beforeLit = brightnessAt(before, litSpot);
  expect(Math.abs(brightnessAt(before, shadowSpot) - beforeLit)).toBeLessThan(15);

  // Bake in the Lighting window: the cube and the layer's chunk.
  await openWindow(page, 'Lighting');
  await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Preview (browser) bake', { timeout: 120_000 });
  const entries = await bakeEntries();
  expect(entries.map((e) => [e.entityId, e.chunk ?? null])).toEqual(expect.arrayContaining([[cube, null], [layer, [0, 0]]]));
  expect(entries.find((e) => e.entityId === layer)!.layout).toMatch(/^[0-9a-f]{16}$/);

  // Play: the shadow is in the chunk's lightmap; the lit blocks stay about as bright.
  const after = await play(page, variant);
  const afterShadow = brightnessAt(after, shadowSpot);
  const afterLit = brightnessAt(after, litSpot);
  console.log(`[block-lightmaps] ${variant}: before lit ${beforeLit.toFixed(1)}; after lit ${afterLit.toFixed(1)} shadow ${afterShadow.toFixed(1)}`);
  expect(afterShadow).toBeLessThan(afterLit * 0.75);
  expect(afterLit / beforeLit).toBeGreaterThan(0.6);
  expect(afterLit / beforeLit).toBeLessThan(1.5);

  // A cell edit makes the bake stale (it is still used).
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'cells', at: [11, 1, 7], cell: { block: 'stone' } }] });
  await expect(page.locator('[aria-label="bake status"]')).toContainText('stale');
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'cells', at: [11, 1, 7], cell: null }] });

  // The static export with the backend stopped: the same shadow.
  const res = await be!.admin(`projects/${be!.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be!.halt();
  const site = await serveDir(join(be!.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.setViewportSize({ width: 960, height: 540 });
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect
      .poll(async () => {
        const img = decodePng(await canvas.screenshot());
        const lit = brightnessAt(img, litSpot);
        return brightnessAt(img, shadowSpot) < lit * 0.75 && lit / beforeLit > 0.6;
      }, { timeout: 60_000, message: 'the baked shadow on the blocks in the export' })
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

/** The final bake runs Blender here (THIRDLIGHT_BLENDER / blender on PATH), or on TL_BAKE_HOST with TL_BAKE_BLENDER. */
const bakeBlender = process.env['TL_BAKE_BLENDER'] ?? process.env['THIRDLIGHT_BLENDER'] ?? 'blender';
const bakeHost = process.env['TL_BAKE_HOST'] ?? 'local';
const haveBlender = bakeHost !== 'local' || spawnSync(bakeBlender, ['--version'], { encoding: 'utf8' }).status === 0;

test('Bake final (Blender Cycles) bakes the block layer\'s chunks too; Play shows the shadow on the blocks', async ({ page }) => {
  test.skip(!haveBlender, 'no Blender for the final bake on this machine');
  test.skip(test.info().project.name === 'webgpu', 'the renderer variants are covered by the preview bake');
  test.setTimeout(900_000);
  const { layer } = await openScene(page, 'auto', { THIRDLIGHT_BAKE_HOST: bakeHost, THIRDLIGHT_BAKE_BLENDER: bakeBlender, THIRDLIGHT_BAKE_TIMEOUT_MINUTES: '12' });
  const beforeLit = brightnessAt(await play(page, 'auto'), litSpot);
  await openWindow(page, 'Lighting');
  await page.getByRole('button', { name: /settings/ }).click();
  await page.getByRole('spinbutton', { name: 'bake finalSamples' }).fill(bakeHost === 'local' ? '32' : '256');
  await page.getByRole('spinbutton', { name: 'bake texelsPerMeter' }).fill('8');
  await page.getByRole('button', { name: 'Bake final (Blender)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Final (Blender) bake', { timeout: 840_000 });
  expect((await bakeEntries()).some((e) => e.entityId === layer && e.chunk !== undefined)).toBe(true);
  const after = await play(page, 'auto');
  const afterShadow = brightnessAt(after, shadowSpot);
  const afterLit = brightnessAt(after, litSpot);
  console.log(`[block-lightmaps] final: before lit ${beforeLit.toFixed(1)}; after lit ${afterLit.toFixed(1)} shadow ${afterShadow.toFixed(1)}`);
  expect(afterShadow).toBeLessThan(afterLit * 0.8);
  expect(afterLit / beforeLit).toBeGreaterThan(0.7);
  expect(afterLit / beforeLit).toBeLessThan(1.7);
});
