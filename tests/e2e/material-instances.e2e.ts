/**
 * Material instances, against a real backend on a blank project.
 *
 * - The parents (commands, as MCP makes them): a graph material "Glow" (unlit,
 *   colour = its `tint` parameter, green by default) and a shader material
 *   "Plain" (unlit, green).
 * - Editor: the Materials tab makes two instances of Glow ("+ new instance"),
 *   one red, one renamed "Yellow" and yellow (the instance inspector's
 *   parameter); box A's Inspector maps the red one, the model asset's
 *   "Default materials" (every placement) the yellow one.
 * - Commands: an instance of Plain with its colour blue on box B.
 * - Pixels, left to right red / blue / yellow and never the parents' green:
 *   the Scene view, Play and the static export (backend stopped). The export
 *   ships the used instances resolved (never an instance, never the unused
 *   parents).
 *
 * Runs per renderer variant (renderer-variants.ts): auto, WebGL 2 (TL_E2E_ALL_VARIANTS=1 on a GPU),
 * WebGPU in `webgpu`.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { exportedContent, publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { openWindow, projectWindow, closeEditor, chooseItem, inspector } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-material-instances' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

type Pred = (r: number, g: number, b: number) => boolean;
const red: Pred = (r, g, b) => r > 100 && r > g + 60 && r > b + 60;
const green: Pred = (r, g, b) => g > 100 && g > r + 60 && g > b + 60;
const blue: Pred = (r, g, b) => b > 100 && b > r + 60 && b > g + 60;
const yellow: Pred = (r, g, b) => r > 100 && g > 100 && r > b + 60 && g > b + 60;

function count(img: Image, test: Pred, x0: number, x1: number): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = x0; x < x1; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}

/**
 * Left, middle and right thirds (the game camera looks at them head on): red,
 * blue, yellow; no green anywhere. `anywhere` (the Scene view's own camera):
 * each colour somewhere. Returns a problem or null.
 */
function checkPicture(img: Image, anywhere = false): string | null {
  const t = Math.floor(img.width / 3);
  const thirds: [string, Pred, number, number][] = [
    ['left', red, 0, anywhere ? img.width : t],
    ['middle', blue, anywhere ? 0 : t, anywhere ? img.width : 2 * t],
    ['right', yellow, anywhere ? 0 : 2 * t, img.width],
  ];
  for (const [where, want, x0, x1] of thirds) {
    const n = count(img, want, x0, x1);
    if (n < 150) return `the ${where} object is not its instance's colour (${n} pixels)`;
  }
  const g = count(img, green, 0, img.width);
  return g > 40 ? `a parent's green shows (${g} pixels)` : null;
}

const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

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

const GLOW_GRAPH = {
  nodes: [
    { id: 'out', type: 'unlit', position: [400, 0], data: { castShadows: false } },
    { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
  ],
  edges: [{ id: 'e1', from: { node: 'tint', port: 'value' }, to: { node: 'out', port: 'color' } }],
};

const VARIANTS: readonly RendererVariant[] = RENDERER_VARIANTS;

for (const variant of VARIANTS) test(`material instances on an object, a model asset's default mapping and by command: Scene view, Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend('material-instances-e2e');

  await cmd('setMaterial', { material: { materialId: 'glow', name: 'Glow', shader: 'unlit', params: {}, textures: {}, parameters: [{ key: 'tint', type: 'color', default: '#00ff00' }], graph: GLOW_GRAPH } });
  await cmd('setMaterial', { material: { materialId: 'plain', name: 'Plain', shader: 'unlit', params: { color: '#00ff00' }, textures: {} } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['camera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 0, 6], rotation: [0, 0, 0, 1] } });
  for (const e of ents) if (e.components['box'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const box = async (name: string, x: number): Promise<string> =>
    String((await cmd('createEntity', { parentId: null, kind: 'box', name, transform: { position: [x, 0, 0] }, box: { size: [1.6, 1.6, 0.05], material: { color: '#ffffff' } } }))['createdId']);
  await box('Box A', -2.4);
  const boxB = await box('Box B', 0);
  const slab = await publishBytes(be, multiPieceGlb([{ name: 'slab', lods: [[1.6, 1.6, 0.05]] }]), 'model', 'slab', 'Slab');
  await cmd('createEntity', { kind: 'model', name: 'Slab', model: { asset: { assetId: slab } }, transform: { position: [1.6, -0.8, 0] } });
  // The command path (as MCP): an instance of the shader material, on box B.
  await cmd('setMaterial', { material: { materialId: 'plain-blue', name: 'Plain blue', shader: 'unlit', params: { color: '#0000ff' }, textures: {}, instanceOf: 'plain' } });
  await cmd('setComponent', { entityId: boxB, component: 'materials', value: { '*': 'plain-blue' } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);

  // Editor: two instances of Glow.
  const materialsNow = async (): Promise<{ materialId: string; name: string; instanceOf?: string; values?: Record<string, unknown> }[]> => (await query('queryGameConfig')).materials as never;
  // Glow chosen in the project window: "+ new instance" in its Inspector makes one, and the Inspector shows it.
  const newInstanceOfGlow = async (): Promise<string> => {
    await chooseItem(page, 'material', 'glow');
    const before = (await materialsNow()).length;
    await inspector(page).getByRole('button', { name: '+ new instance' }).click();
    await expect.poll(async () => (await materialsNow()).length).toBe(before + 1);
    const made = (await materialsNow()).filter((m) => m.instanceOf === 'glow').map((m) => m.materialId);
    const id = made[made.length - 1]!;
    await expect(inspector(page).locator(`.tl-material-item[data-material-id="${id}"]`)).toBeVisible();
    return id;
  };
  const redId = await newInstanceOfGlow();
  await expect(page.getByRole('combobox', { name: 'instance parent' })).toHaveValue('glow');
  await page.getByLabel('instance tint').fill('#ff0000');
  await expect.poll(async () => (await materialsNow()).find((m) => m.materialId === redId)?.values).toEqual({ tint: '#ff0000' });
  await expect(page.locator('.tl-param[data-param="tint"]')).toHaveClass(/is-set/);
  const yellowId = await newInstanceOfGlow();
  const name = page.getByRole('textbox', { name: 'material name' });
  await name.fill('Yellow');
  await name.press('Enter');
  await expect.poll(async () => (await materialsNow()).find((m) => m.materialId === yellowId)?.name).toBe('Yellow');
  await page.getByLabel('instance tint').fill('#ffff00');
  await expect.poll(async () => (await materialsNow()).find((m) => m.materialId === yellowId)?.values).toEqual({ tint: '#ffff00' });
  expect(await materialsNow()).toHaveLength(5);

  // Box A's Inspector maps the red instance; the Slab asset's default mapping the yellow one.
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Box A' }).click();
  await page.getByLabel('materials component').getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Glow instance' });
  await projectWindow(page);
  await page.locator('.tl-assets__list li[data-asset-id="slab"]:not([data-piece])').click();
  await page.getByLabel('Default materials (every placement)').getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Yellow' });
  await expect.poll(async () => JSON.stringify(((await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string; materials?: unknown }[]).find((a) => a.assetId === 'slab')?.materials)).toBe(JSON.stringify({ '*': yellowId }));

  // Scene view.
  await closeEditor(page);
  await page.keyboard.press('Escape');
  let problem: string | null = 'not checked';
  await expect.poll(async () => (problem = checkPicture(await shot(viewport), true)), { timeout: 30_000, message: 'Scene view picture' }).toBeNull();
  expect(problem).toBeNull();

  // Play.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => (problem = checkPicture(await shot(frame))), { timeout: 60_000, message: 'Play picture' }).toBeNull();
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // The static export, served with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  // The shipped materials: the three used instances, resolved (no instanceOf), and neither parent.
  const shipped = (exportedContent(out).materials ?? []) as unknown as { materialId: string; instanceOf?: string; graph?: unknown; parameters?: { key: string; default: unknown }[] }[];
  expect(shipped.map((m) => m.materialId).sort()).toEqual([redId, 'plain-blue', yellowId].sort());
  expect(shipped.some((m) => m.instanceOf !== undefined)).toBe(false);
  expect(shipped.find((m) => m.materialId === yellowId)?.parameters).toEqual([{ key: 'tint', type: 'color', default: '#ffff00' }]);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => (problem = checkPicture(await shot(exported))), { timeout: 60_000, message: 'export picture' }).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
