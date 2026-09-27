/**
 * Phase 23.15: a Custom-lit graph material in the editor against the real
 * backend — the Material tab's preview, the Scene view, Play and the static
 * export all draw the graph's own shading from the lights.
 *
 * The graph (neutral, a cel look in two bands): N·L of the main light,
 * stepped at 0, picks a blue (turned away from the light) or a yellow (turned
 * towards it) into a Custom-lit output. The preview's sphere under its key
 * light shows both bands; a box turned 45° under the project's default sun
 * shows one band per visible side face. A lighting input under a PBR output
 * is a compile error the preview reports.
 *
 * Runs per renderer: `webgl2` in `default`, `webgpu` in `webgpu`.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, type RendererVariant } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0x23f15000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-material-custom-lit' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}
function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => {
    // Keep-alive connections of the export page would hold close() open.
    server.close(() => d());
    server.closeAllConnections();
  }) })));
}

function count(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
// By hue (tone mapping and the environment may shift the brightness): the two bands.
const blue = (r: number, g: number, b: number): boolean => b > 90 && b > 2 * r && b > 1.6 * g;
const yellow = (r: number, g: number, b: number): boolean => r > 150 && g > 120 && b < 0.45 * g;
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

const n = (id: string, type: string, position: [number, number], data?: Record<string, unknown>) => ({ id, type, position, ...(data !== undefined ? { data } : {}) });
const e = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });
const BANDS = {
  nodes: [
    n('output', 'customLit', [800, 0]),
    n('main', 'mainLight', [0, 0]),
    n('step', 'step', [220, 0], { type: 'float' }),
    n('away', 'color', [220, 150], { color: '#1840c0' }),
    n('towards', 'color', [220, 300], { color: '#f0d020' }),
    n('pick', 'lerp', [500, 0]),
    n('zero', 'float', [0, 150], { value: 0 }),
  ],
  edges: [e('w0', 'zero', 'value', 'step', 'edge'), e('w1', 'main', 'ndotl', 'step', 'x'), e('w2', 'away', 'rgb', 'pick', 'a'), e('w3', 'towards', 'rgb', 'pick', 'b'), e('w4', 'step', 'out', 'pick', 't'), e('w5', 'pick', 'out', 'output', 'color')],
};

const VARIANTS: readonly RendererVariant[] = ['webgl2', 'webgpu'];

for (const variant of VARIANTS) test(`a Custom-lit graph (two N·L bands) shades from the lights in the Material preview, the Scene view, Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  await cmd('setMaterial', { material: { materialId: 'mat-cel', name: 'Cel', shader: 'standard', params: {}, textures: {}, graph: BANDS } });
  // The same inputs under a PBR output read no light: a compile error.
  await cmd('setMaterial', {
    material: { materialId: 'mat-wrong', name: 'Wrong', shader: 'standard', params: {}, textures: {}, graph: { nodes: [n('output', 'pbr', [400, 0]), n('main', 'mainLight', [0, 0])], edges: [e('w1', 'main', 'color', 'output', 'baseColor')] } },
  });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);

  // The Material tab: the catalogue has the Lighting inputs; the preview sphere shows both bands, without errors.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.locator('.tl-materials li[data-material-id="mat-cel"]').dblclick();
  await expect(page.getByRole('tab', { name: 'Material: Cel' })).toHaveAttribute('aria-selected', 'true');
  const stage = page.locator('.tl-graph__stage');
  const box = (await stage.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.8, { button: 'right' });
  const popup = page.getByRole('dialog', { name: 'Add node' });
  await expect(popup.getByRole('group', { name: 'Lighting' })).toBeVisible();
  for (const label of ['Main light', 'Shadow', 'Diffuse light', 'Ambient light']) await expect(popup.getByRole('option', { name: label, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const preview = page.getByLabel('material preview canvas');
  await expect.poll(() => preview.getAttribute('data-tl-renderer'), { timeout: 30_000 }).toBe(variant);
  const status = page.locator('.tl-material-preview__status');
  await expect(status).toContainText(variant);
  await expect.poll(async () => Number(await preview.getAttribute('data-tl-preview-frames')), { timeout: 30_000 }).toBeGreaterThan(5);
  await expect.poll(async () => count(await shot(preview), yellow), { timeout: 30_000 }).toBeGreaterThan(150);
  await expect.poll(async () => count(await shot(preview), blue), { timeout: 30_000 }).toBeGreaterThan(40);
  await expect(status).not.toContainText('error');
  const pv = await shot(preview);
  console.log(`[material-custom-lit] ${variant} preview: yellow ${count(pv, yellow)}, blue ${count(pv, blue)}`);
  // The wrong one: the preview counts its compile error.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.locator('.tl-materials li[data-material-id="mat-wrong"]').dblclick();
  await expect(page.getByRole('tab', { name: 'Material: Wrong' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tl-material-preview__status')).toContainText('1 error', { timeout: 30_000 });

  // A box (twice the size, turned 45° so two side faces show) wears it under the default sun.
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  const before = await shot(viewport);
  await menu(page, 'GameObject', 'Box');
  const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(row).toContainText('box');
  const id = (await row.getAttribute('data-entity-id'))!;
  const q = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  const t = (q['entity'] as { components: { transform: { position: number[] } } }).components.transform;
  await cmd('setTransform', { entityId: id, transform: { position: [t.position[0], 1, t.position[2]], rotation: [0, 0.38268343, 0, 0.92387953], scale: [2, 2, 2] } });
  await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': 'mat-cel' } });
  // Nothing selected (the selection tint adds its own emissive).
  await page.keyboard.press('Escape');
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(0);
  const y0 = count(before, yellow);
  const b0 = count(before, blue);
  await expect.poll(async () => count(await shot(viewport), yellow), { timeout: 30_000 }).toBeGreaterThan(y0 + 150);
  await expect.poll(async () => count(await shot(viewport), blue), { timeout: 30_000 }).toBeGreaterThan(b0 + 150);
  const sv = await shot(viewport);
  console.log(`[material-custom-lit] ${variant} scene view: yellow ${count(sv, yellow)} (before ${y0}), blue ${count(sv, blue)} (${b0})`);

  // Play: the same graph compiled in the preview frame.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => count(await shot(frame), yellow), { timeout: 45_000 }).toBeGreaterThan(150);
  await expect.poll(async () => count(await shot(frame), blue), { timeout: 20_000 }).toBeGreaterThan(150);
  const play = await shot(frame);
  console.log(`[material-custom-lit] ${variant} play: yellow ${count(play, yellow)}, blue ${count(play, blue)}`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { materials: { materialId: string; graph?: { nodes: { type: string }[] } }[] };
  expect(manifest.materials.find((m) => m.materialId === 'mat-cel')?.graph?.nodes.some((x) => x.type === 'customLit')).toBe(true);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (err) => errors.push(err.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => count(await shot(exported), yellow), { timeout: 45_000 }).toBeGreaterThan(150);
    await expect.poll(async () => count(await shot(exported), blue), { timeout: 20_000 }).toBeGreaterThan(150);
    const ex = await shot(exported);
    console.log(`[material-custom-lit] ${variant} export: yellow ${count(ex, yellow)}, blue ${count(ex, blue)}`);
    expect(errors).toEqual([]);
  } finally {
    await exported.close();
    await site.close();
  }
});
