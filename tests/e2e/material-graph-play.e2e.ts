/**
 * Phase 18.3: a graph material renders in the Scene view, in Play and in the
 * static export (the graph compiles to TSL in each; the export carries the
 * graph in its manifest). The graph: a texture × a tint into the PBR base
 * colour and a fresnel-weighted colour into the emissive, calling a material
 * function for the tint (so the manifest carries the function too), with a
 * public tint parameter one object overrides.
 *
 * Runs per renderer: `auto` in `default` (WebGL 2 there), `webgpu` in `webgpu`.
 */
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, type RendererVariant } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-matgraph-play-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0x18f3e000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-material-graph-play' }, args });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  return r;
}
async function importFile(page: Page, file: string): Promise<void> {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__status')).toContainText('committed', { timeout: 10_000 });
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
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

/** Pixels of the tint on the texture's bright squares (green: the material's tint; blue: the object's override). */
function count(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
// Dim-light friendly (front faces get little of the key light): the hue, not the brightness.
const green = (r: number, g: number, b: number): boolean => g > 40 && g > 3 * r && g > 3 * b;
const blue = (r: number, g: number, b: number): boolean => b > 50 && b > 2.5 * r && b > 4 * g;
/** The fresnel rim: magenta light on faces seen at an angle. */
const magenta = (r: number, g: number, b: number): boolean => r > 60 && b > 60 && g < 0.4 * r && g < 0.4 * b;
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgpu'];

for (const variant of VARIANTS) test(`a graph material (texture × tint, fresnel emissive, a function call, an object override) draws in the Scene view, Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  const checker = join(dir, 'checker.png');
  writeFileSync(checker, makePng(64, 64, (x, y) => (((x >> 4) + (y >> 4)) % 2 === 0 ? [250, 250, 250, 255] : [10, 10, 10, 255])));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);
  await importFile(page, checker);
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string }[];
  const texture = assets[0]!.assetId;

  // A material function (tint = colour × 1) and the graph material, the same ops MCP uses.
  await cmd('setGraph', {
    graph: {
      graphId: 'tint-fn',
      kind: 'material-function',
      name: 'Tint',
      graph: {
        nodes: [
          { id: 'inColor', type: 'functionInput', position: [0, 0], data: { name: 'color', type: 'vec3', default: [1, 1, 1, 0] } },
          { id: 'inTex', type: 'functionInput', position: [0, 100], data: { name: 'albedo', type: 'vec3', default: [1, 1, 1, 0] } },
          { id: 'mul', type: 'multiply', position: [200, 0] },
          { id: 'result', type: 'functionOutput', position: [400, 0], data: { name: 'result', type: 'vec3' } },
        ],
        edges: [
          { id: 'e1', from: { node: 'inColor', port: 'value' }, to: { node: 'mul', port: 'a' } },
          { id: 'e2', from: { node: 'inTex', port: 'value' }, to: { node: 'mul', port: 'b' } },
          { id: 'e3', from: { node: 'mul', port: 'out' }, to: { node: 'result', port: 'value' } },
        ],
      },
    },
  });
  await cmd('setMaterial', {
    material: {
      materialId: 'mat-graph',
      name: 'Graph look',
      shader: 'standard',
      params: {},
      textures: {},
      parameters: [{ key: 'tint', type: 'color', default: '#00ff00' }],
      graph: {
        nodes: [
          { id: 'output', type: 'pbr', position: [600, 0], data: { castShadows: false } },
          { id: 'tex', type: 'sampleTexture', position: [0, 0], data: { texture } },
          { id: 'tint', type: 'parameter', position: [0, 150], data: { key: 'tint' } },
          { id: 'call', type: 'call', position: [250, 0], data: { function: 'tint-fn' } },
          { id: 'fresnel', type: 'fresnel', position: [250, 250] },
          { id: 'power', type: 'float', position: [0, 300], data: { value: 2 } },
          { id: 'rim', type: 'color', position: [250, 400], data: { color: '#c000c0' } },
          { id: 'glow', type: 'multiply', position: [450, 300] },
        ],
        edges: [
          { id: 'w1', from: { node: 'tint', port: 'value' }, to: { node: 'call', port: 'inColor' } },
          { id: 'w2', from: { node: 'tex', port: 'rgb' }, to: { node: 'call', port: 'inTex' } },
          { id: 'w3', from: { node: 'call', port: 'result' }, to: { node: 'output', port: 'baseColor' } },
          { id: 'w4', from: { node: 'power', port: 'value' }, to: { node: 'fresnel', port: 'power' } },
          { id: 'w5', from: { node: 'fresnel', port: 'out' }, to: { node: 'glow', port: 'a' } },
          { id: 'w6', from: { node: 'rim', port: 'rgb' }, to: { node: 'glow', port: 'b' } },
          { id: 'w7', from: { node: 'glow', port: 'out' }, to: { node: 'output', port: 'emissive' } },
        ],
      },
    },
  });

  // Two boxes (menu) wear it (the materials component, as MCP sets it); the second overrides the public tint with blue in the Inspector.
  const before = await shot(viewport);
  const boxes: string[] = [];
  for (const x of [-1.3, 1.3]) {
    await menu(page, 'GameObject', 'Box');
    await expect.poll(async () => (await page.locator('.tl-hierarchy__list li.tl-row.is-selected').getAttribute('data-entity-id')) ?? '').not.toBe(boxes[0] ?? '');
    const row = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
    await expect(row).toContainText('box');
    const id = (await row.getAttribute('data-entity-id'))!;
    boxes.push(id);
    const q = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
    const t = (q['entity'] as { components: { transform: { position: number[] } } }).components.transform;
    // Twice the size, turned 45° so two faces show (the fresnel rim is on faces seen at an angle).
    await cmd('setTransform', { entityId: id, transform: { position: [x, 1, t.position[2]], rotation: [0, 0.38268343, 0, 0.92387953], scale: [2, 2, 2] } });
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': 'mat-graph' } });
  }
  await page.locator(`.tl-hierarchy__list li.tl-row[data-entity-id="${boxes[1]}"]`).click();
  const overrides = page.locator('.tl-inspector').getByLabel('material parameter overrides');
  await overrides.getByLabel('Graph look tint', { exact: true }).fill('#0000ff');
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: boxes[1]! } }))['entity'])).toContain('#0000ff');
  // Nothing selected (the selection tint would add its own emissive).
  await page.keyboard.press('Escape');
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(0);

  // Scene view: green squares (the tint), blue squares (the override), the magenta fresnel rim.
  const g0 = count(before, green);
  const b0 = count(before, blue);
  const m0 = count(before, magenta);
  await expect.poll(async () => count(await shot(viewport), green), { timeout: 30_000 }).toBeGreaterThan(g0 + 150);
  await expect.poll(async () => count(await shot(viewport), blue), { timeout: 30_000 }).toBeGreaterThan(b0 + 150);
  await expect.poll(async () => count(await shot(viewport), magenta), { timeout: 30_000 }).toBeGreaterThan(m0 + 100);
  const sceneView = await shot(viewport);
  console.log(`[material-graph-play] ${variant} scene view: green ${count(sceneView, green)} (before ${g0}), blue ${count(sceneView, blue)} (${b0}), magenta ${count(sceneView, magenta)} (${m0})`);

  // Play: the same graph compiled in the preview.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => count(await shot(frame), green), { timeout: 45_000 }).toBeGreaterThan(150);
  await expect.poll(async () => count(await shot(frame), blue), { timeout: 20_000 }).toBeGreaterThan(150);
  await expect.poll(async () => count(await shot(frame), magenta), { timeout: 20_000 }).toBeGreaterThan(100);
  const play = await shot(frame);
  console.log(`[material-graph-play] ${variant} play: green ${count(play, green)}, blue ${count(play, blue)}, magenta ${count(play, magenta)}`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export: the manifest carries the graph and the function; served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { materials: { materialId: string; graph?: unknown }[]; materialFunctions?: { graphId: string }[] };
  expect(manifest.materials.find((m) => m.materialId === 'mat-graph')?.graph).toBeDefined();
  expect(manifest.materialFunctions?.map((f) => f.graphId)).toEqual(['tint-fn']);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => count(await shot(exported), green), { timeout: 45_000 }).toBeGreaterThan(150);
    await expect.poll(async () => count(await shot(exported), blue), { timeout: 20_000 }).toBeGreaterThan(150);
    await expect.poll(async () => count(await shot(exported), magenta), { timeout: 20_000 }).toBeGreaterThan(100);
    const ex = await shot(exported);
    console.log(`[material-graph-play] ${variant} export: green ${count(ex, green)}, blue ${count(ex, blue)}, magenta ${count(ex, magenta)}`);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
