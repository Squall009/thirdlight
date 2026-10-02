/**
 * The engine owns the view. The starter's camera is a shot (a fixed virtual
 * camera at the lowest priority): Play and the export draw through it, from
 * where it is placed, with the project's lens. With no camera left Play
 * starts anyway — one Problems line says no camera is live — and the view
 * holds the engine's default pose (1.6 m up, 6 m back, looking down −Z);
 * the export of that project reports the same warning and draws the same.
 *
 * Judged by pixels at the canvas centre: a red panel only the placed camera
 * sees (20 m to the side), a blue one only the default pose sees. Per
 * renderer: `auto` in `default`, `webgl2` with TL_E2E_ALL_VARIANTS=1,
 * `webgpu` in `webgpu`.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { serveDir, startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, type RendererVariant } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} });
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-engine-view' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

const problems = async (): Promise<{ code: string; message: string }[]> => {
  const res = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/problems`, { headers: { authorization: `Bearer ${be!.adminToken}` } });
  return ((await res.json()) as { problems: { code: string; message: string }[] }).problems;
};

/** The colour at the canvas centre is mostly red (r) or blue (b). */
async function centre(canvas: Locator): Promise<'red' | 'blue' | 'other'> {
  const img = decodePng(await canvas.screenshot());
  let red = 0;
  let blue = 0;
  for (let dy = -4; dy <= 4; dy += 4) {
    for (let dx = -4; dx <= 4; dx += 4) {
      const [r, g, b] = img.pixel(Math.floor(img.width / 2) + dx, Math.floor(img.height / 2) + dy);
      if (r > 2 * Math.max(g, b) && r > 60) red += 1;
      if (b > 2 * Math.max(r, g) && b > 60) blue += 1;
    }
  }
  return red >= 7 ? 'red' : blue >= 7 ? 'blue' : 'other';
}

async function play(page: Page, variant: RendererVariant): Promise<Locator> {
  await page.getByTitle('Start an isolated play preview').click();
  await expect(page.locator('iframe.tl-app__preview-frame')).toBeVisible();
  const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expectRendererBackend(canvas, variant);
  return canvas;
}

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgl2', 'webgpu'];

for (const variant of VARIANTS) test(`the view is the live camera's, else the default pose with a Problems line, in Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend('engine-view-e2e');
  // The starter's camera, 20 m to the side, looking at a red panel nothing else sees; a blue panel in front of the default pose.
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [20, 1.6, 6], rotation: [0, 0, 0, 1] } });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Red', transform: { position: [20, 1.6, 0] }, box: { size: [6, 6, 0.2], material: { color: '#ff0000' } } });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Blue', transform: { position: [0, 1.6, -1] }, box: { size: [6, 6, 0.2], material: { color: '#0000ff' } } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The camera is live: Play draws from where it is placed; no view warning.
  let canvas = await play(page, variant);
  await expect.poll(() => centre(canvas), { timeout: 60_000 }).toBe('red');
  expect((await problems()).filter((p) => p.code === 'view_missing')).toEqual([]);
  await page.getByTitle('Stop the play preview').click();

  // No camera: Play starts, warns once, and holds the default pose.
  await cmd('deleteEntity', { entityId: 'cam-main' });
  canvas = await play(page, variant);
  await expect.poll(() => centre(canvas), { timeout: 60_000 }).toBe('blue');
  const warned = (await problems()).filter((p) => p.code === 'view_missing');
  expect(warned).toHaveLength(1);
  expect(warned[0]!.message).toContain('no camera is live when the game starts');
  await page.getByTitle('Stop the play preview').click();

  // The export of the camera-less project: the same warning, the same view (served with the backend stopped).
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect((res.json as { warnings?: { code: string }[] }).warnings?.map((w) => w.code)).toEqual(['view_missing']);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    const c = exported.locator('canvas').first();
    await expectRendererBackend(c, variant);
    await expect.poll(() => centre(c), { timeout: 60_000 }).toBe('blue');
    expect(errors).toEqual([]);
  } finally {
    await exported.close();
    await site.close();
  }
});
