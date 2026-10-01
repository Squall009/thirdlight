/**
 * A painted terrain material, against a real backend on a
 * blank project, in the Scene view, Play and the static export.
 *
 * - Three texture arrays of four layers: albedo + height (packed in the
 *   editor's Assets panel: "pack texture…", ETC1S colour), normal maps and
 *   occlusion/roughness/metalness (packed through the pack route as MCP does:
 *   UASTC normal map, UASTC data). Layer colours: 1 red (high), 2 green
 *   (low), 3 blue, 4 magenta.
 * - The Materials tab's "height-blended layers (painted terrain)" template
 *   reads them (its texture parameters set to the arrays).
 * - A block layer of plain full blocks mapped to the material ({"*": id}),
 *   painted with `paint` edits: a patch of layer 3 (blue), a patch of layers
 *   1 and 2 half and half (the height blend shows layer 1: red, never an
 *   olive cross-fade), a wet patch (darker red).
 * - A GLB whose vertex colours are all layer 4 (COLOR_0 = 0, 0, 0, 1) with
 *   the same material: magenta (the Height blend node takes any mesh's
 *   vertex colours as weights).
 *
 * Runs per renderer variant (renderer-variants.ts): auto, WebGL 2
 * (TL_E2E_ALL_VARIANTS=1 on a GPU), WebGPU in `webgpu`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { count, isBlue, isGreenish, isMagenta, materials, packNormalAndOrm, publishLayerSources, reds, useArrays } from './painted-layers';
import { decodePng, type Image } from './png';
import { menu, projectWindow, openWindow, closeEditor } from './ui';
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
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-painted-terrain' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

/** What a picture must show; returns a problem or null. */
function checkPicture(img: Image, glb = true): string | null {
  const blue = count(img, isBlue);
  if (blue < 60) return `the blue layer-3 patch is missing (${blue} pixels)`;
  const red = reds(img);
  if (red.length < 200) return `the red ground (layer 1) is missing (${red.length} pixels)`;
  // The height blend: layers 1 and 2 half and half show layer 1 (red); a cross-fade would be olive.
  const greenish = count(img, isGreenish);
  if (greenish > 12) return `${greenish} green/olive pixels: layers 1 and 2 were cross-faded, not height-blended`;
  // The wet patch: a darker red than the dry ground (the albedo × 0.55 in linear light: about 0.77 on screen).
  const median = red[Math.floor(red.length / 2)]!;
  const wet = red.filter((r) => r < 0.86 * median).length;
  if (wet < 60) return `no darker (wet) red: ${wet} pixels below 86 % of the median red ${median}`;
  if (glb) {
    const magenta = count(img, isMagenta);
    if (magenta < 40) return `the vertex-coloured GLB's layer 4 (magenta) is missing (${magenta} pixels)`;
  }
  return null;
}

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

/** World → client pixels through the Scene view's published view-projection matrix (null: behind the camera). */
async function onScreen(view: Locator, p: [number, number, number]): Promise<{ x: number; y: number } | null> {
  const m = JSON.parse((await view.getAttribute('data-view-proj'))!) as number[];
  const box = (await view.boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (w <= 0) return null;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}

/** The layer: 32 × 16 columns of 1 m, centred on the origin, its top at y = 0.5 (above the Scene view's floor grid at 0). */
const ORIGIN: [number, number, number] = [-16, -0.5, -8];

for (const variant of RENDERER_VARIANTS) test(`painted terrain: height-blended layers from texture arrays on a painted block layer and a vertex-coloured GLB (Scene view, Play, export; ${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend(`painted-terrain-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The layer sources (plain PNG textures) and two arrays through the route (as MCP).
  await publishLayerSources(be);
  await packNormalAndOrm(be);

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);

  // ---- Editor: pack the albedo + height array in the Assets panel.
  await projectWindow(page);
  await page.getByRole('button', { name: 'pack texture…' }).click();
  const form = page.getByLabel('pack texture');
  await form.getByLabel('packed texture name').fill('Terrain albedo');
  for (let i = 0; i < 4; i++) {
    if (i > 0) await form.getByRole('button', { name: 'add layer' }).click();
    await form.getByLabel(`layer ${i + 1} from`).selectOption(`alb-${i + 1}`);
    await form.getByLabel(`layer ${i + 1} A`).selectOption(`hgt-${i + 1}:r`);
  }
  await form.getByRole('button', { name: 'pack', exact: true }).click();
  await expect(form).toHaveCount(0, { timeout: 60_000 });
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'Terrain albedo' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await tile.click();
  await expect(page.getByTestId('texture-facts')).toContainText('KTX2 · ETC1S · 5 mip levels · 4 layers · 16×16');
  const assets = (await query('queryAssets', { limit: 50, offset: 0 }))['assets'] as { assetId: string; displayName: string; image?: unknown; packedFrom?: unknown }[];
  const albedo = assets.find((a) => a.displayName === 'Terrain albedo')!;
  expect(albedo.image).toEqual({ format: 'ktx2', width: 16, height: 16, codec: 'etc1s', levels: 5, layers: 4 });
  expect(albedo.packedFrom).toEqual({ encoding: 'color', sources: ['alb-1', 'alb-2', 'alb-3', 'alb-4', 'hgt-1', 'hgt-2', 'hgt-3', 'hgt-4'] });
  expect(assets.find((a) => a.assetId === 'terrain-orm')!.image).toEqual({ format: 'ktx2', width: 16, height: 16, codec: 'uastc', levels: 5, layers: 4 });

  // ---- Editor: the height-blended layers template, its texture parameters set to the arrays.
  await openWindow(page, 'Materials');
  await page.getByRole('combobox', { name: 'graph material template' }).selectOption('layers');
  await page.getByRole('button', { name: '+ new graph material' }).click();
  await expect.poll(async () => (await materials(be!)).filter((m) => JSON.stringify(m.graph ?? {}).includes('heightBlend')).length, { timeout: 15_000 }).toBe(1);
  const mat = (await materials(be)).find((m) => JSON.stringify(m.graph ?? {}).includes('heightBlend'))!.materialId;
  await useArrays(be, mat, { albedoHeight: albedo.assetId, normals: 'terrain-normals', orm: 'terrain-orm' });

  // ---- The scene: a dark sky, the camera straight down over the layer, the project's boxes out of the way.
  await cmd('setEnvironment', { environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['camera'] !== undefined)!.id;
  // −90° about X: looking down −Y, the screen's up is −Z.
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 21, 0.5], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] } });
  for (const e of ents) if (e.components['box'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -80, 0] } });
  await cmd('setBlockType', { block: { blockId: 'ground', name: 'Ground', variants: [{ color: '#808080' }], shape: 'full', materials: { '*': mat } } });
  const layer = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Terrain', transform: { position: ORIGIN } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [32, 4, 16] } } });
  await cmd('editBlocks', {
    entityId: layer,
    edits: [
      { kind: 'fill', box: [0, 0, 0, 32, 1, 16], cell: { block: 'ground' } },
      // Layer 3 (blue).
      { kind: 'paint', at: [6, 8], radius: 3, strength: 1, channel: 2, falloff: 'constant' },
      // Layers 1 and 2 half and half: the height blend shows layer 1.
      { kind: 'paint', at: [16, 8], radius: 3.5, strength: 0.5, channel: 1, falloff: 'constant' },
      // Wet ground (layer 1).
      { kind: 'paint', at: [26, 8], radius: 3, strength: 1, channel: 4, falloff: 'constant' },
    ],
  });
  const stored = ((await query('queryBlocks', { entityId: layer })) as { chunks: { chunk: { paint?: string } }[] }).chunks;
  expect(stored.filter((c) => typeof c.chunk.paint === 'string').length).toBe(2);
  // The GLB: all layer 4 by its vertex colours, beside the layer.
  const glb = multiPieceGlb([{ name: 'patch', lods: [[5, 0.3, 2.5]], vertexColor: [0, 0, 0, 1] }]);
  await publishBytes(be, new Uint8Array(glb), 'model', 'layered-patch');
  const patch = String((await cmd('createEntity', { kind: 'model', name: 'Patch', model: { asset: { assetId: 'layered-patch' } }, transform: { position: [-2.5, 0.2, 10] } }))['createdId']);
  await cmd('setComponent', { entityId: patch, component: 'materials', value: { '*': mat } });

  // ---- Scene view: zoom out until the layer and the patch are in view.
  await closeEditor(page);
  await page.keyboard.press('Escape');
  const box = (await viewport.boundingBox())!;
  const inView = async (): Promise<boolean> => {
    for (const p of [[-16, 0, -8], [16, 0, -8], [-16, 0, 8], [16, 0, 8], [0, 0, 12]] as [number, number, number][]) {
      const s = await onScreen(viewport, p);
      if (s === null || s.x < box.x + 4 || s.x > box.x + box.width - 4 || s.y < box.y + 4 || s.y > box.y + box.height - 4) return false;
    }
    return true;
  };
  // The Blocks tab publishes the view's projection (the block tools map cells to the screen); it is closed again for the pictures.
  await openWindow(page, 'Blocks');
  await expect(viewport).toHaveAttribute('data-view-proj', /\[/);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40 && !(await inView()); i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(80);
  }
  expect(await inView()).toBe(true);
  await projectWindow(page);
  // The editor's icons (the lights' yellow) stay out of the picture.
  await menu(page, 'Gizmos', 'Icons: on');
  let problem: string | null = 'not checked';
  await expect.poll(async () => (problem = checkPicture(await shot(viewport))), { timeout: 60_000, message: 'Scene view picture' }).toBeNull();

  // ---- Play.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => (problem = checkPicture(await shot(frame))), { timeout: 60_000, message: 'Play picture' }).toBeNull();
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();
  expect(errors).toEqual([]);

  // ---- The static export, served with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  expect(existsSync(join(out, 'decoders', 'basis', 'basis_transcoder.wasm'))).toBe(true);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const exportErrors: string[] = [];
  exported.on('pageerror', (e) => exportErrors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => (problem = checkPicture(await shot(exported))), { timeout: 60_000, message: 'export picture' }).toBeNull();
    expect(exportErrors).toEqual([]);
  } finally {
    await site.close();
  }
  void problem;
});
