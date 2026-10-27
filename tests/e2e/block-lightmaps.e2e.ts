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
 * chunk's lightmap, and a lit spot keeps about the realtime brightness.
 * Before the bake, on WebGPU, a small area light over the floor's front
 * corner lights a pool there that its mirror spot across the floor lacks:
 * an area light has no per-pixel light, so the pool is the blocks reading
 * the surface cache (no per-pixel light draws an area light). The floor
 * there is polished (a standard material): the lamp's highlight shows where
 * the camera sees its mirror image, brighter than the spot as far from the
 * lamp on its other side (the cache's diffuse light is the same at both).
 * A cell edit makes the bake stale. "Bake final" (Blender Cycles, when
 * Blender is there) bakes the chunks the same way, in the same session. The
 * static export, served with the backend stopped, shows the last bake's
 * shadow.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from './pw';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
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
/** Under the area light (its reach ends well short of the spots above), and the same spot mirrored across the floor. */
const lampSpot: [number, number, number] = [3.5, 0, 2];
const mirrorSpot: [number, number, number] = [-3.5, 0, 2];
/** How much brighter (of 255) the lamp's pool is than its mirror spot when the blocks read the cache. */
const LAMP_POOL = 25;
/**
 * Where the camera sees the lamp's mirror image in the floor (the line from the camera to the lamp's centre
 * mirrored under y = 0 meets the floor there), and the spot as far from the lamp straight across it.
 */
const highlightSpot: [number, number, number] = [3, 0, 2.571];
const acrossSpot: [number, number, number] = [4, 0, 1.429];
/** How much brighter (of 255) the highlight is than the spot across the lamp from it on WebGPU. */
const HIGHLIGHT = 12;

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

/** The cube's face toward the camera: the sun grazes it, so it is darker than the lit blocks once the scene is drawn. */
const cubeFront: [number, number, number] = [0, 0.5, 0.5];

/**
 * Before a bake: the scene drawn (the blocks lit, the cube's face darker than
 * them) and the same as the frame before (loaded and staying put). Whether
 * the shadow is absent is asserted on that frame, not waited for.
 */
function steadyLit(pool = false): (img: Image) => boolean {
  let last = -1;
  return (img) => {
    const lit = brightnessAt(img, litSpot);
    const steady = Math.abs(lit - last) < 1;
    last = lit;
    return lit > 60 && lit - brightnessAt(img, cubeFront) > 10 && steady && (!pool || (brightnessAt(img, lampSpot) - brightnessAt(img, mirrorSpot) > LAMP_POOL && brightnessAt(img, highlightSpot) - brightnessAt(img, acrossSpot) > HIGHLIGHT));
  };
}

/** After a bake: the shadow and the lit blocks' brightness the step asserts (the lightmaps load after the first frames). */
function bakedShadow(beforeLit: number, shadowShare: number, minRatio: number, maxRatio: number): (img: Image) => boolean {
  return (img) => {
    const lit = brightnessAt(img, litSpot);
    return brightnessAt(img, shadowSpot) < lit * shadowShare && lit / beforeLit > minRatio && lit / beforeLit < maxRatio;
  };
}

/** Play, the picture taken once it shows what the step waits for. */
async function play(page: Page, variant: RendererVariant, shows: (img: Image) => boolean): Promise<Image> {
  const frame = page.locator('iframe.tl-app__preview-frame');
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  const shot: { img?: Image } = {};
  await expect
    .poll(async () => {
      shot.img = decodePng(await frame.screenshot());
      return shows(shot.img);
    }, { timeout: 30_000, message: 'the Play frame the step waits for' })
    .toBe(true);
  await page.getByTitle('Stop the play preview').click();
  return shot.img!;
}

/** The scene: a static block-layer floor (polished at its front right), a static cube on it, the sun and ambient "baked"; the editor open on it. */
async function openScene(page: Page, variant: RendererVariant, env: Record<string, string> = {}): Promise<{ layer: string; cube: string }> {
  be = await startBackend('block-lightmaps-e2e', undefined, env);
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#b0b0b0' }], shape: 'full' } });
  await cmd('setMaterial', { material: { materialId: 'mat-polished', name: 'Polished', shader: 'standard', params: { color: '#b0b0b0', roughness: 0.25, metalness: 0 }, textures: {} } });
  await cmd('setBlockType', { block: { blockId: 'polished', name: 'Polished', variants: [{ color: '#b0b0b0' }], shape: 'full', materials: { '*': 'mat-polished' } } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Floor', transform: { position: [-6, -1, -4] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [12, 4, 8] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 12, 1, 8], cell: { block: 'stone' } }, { kind: 'fill', box: [8, 0, 4, 12, 1, 8], cell: { block: 'polished' } }] });
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

type BakeRecord = { source: string; bounces: number; entries: { entityId: string; chunk?: number[]; layout?: string }[] };
async function bakeRecord(): Promise<BakeRecord> {
  const config = await be!.command({ op: 'queryGameConfig', projectId: be!.projectId });
  return Object.values(config['lighting'] as Record<string, BakeRecord>)[0]!;
}
async function bakeEntries(): Promise<BakeRecord['entries']> {
  return (await bakeRecord()).entries;
}

/** The final bake runs Blender here (THIRDLIGHT_BLENDER / blender on PATH), or on TL_BAKE_HOST with TL_BAKE_BLENDER. */
const bakeBlender = process.env['TL_BAKE_BLENDER'] ?? process.env['THIRDLIGHT_BLENDER'] ?? 'blender';
const bakeHost = process.env['TL_BAKE_HOST'] ?? 'local';
const haveBlender = bakeHost !== 'local' || spawnSync(bakeBlender, ['--version'], { encoding: 'utf8' }).status === 0;

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`Bake preview bakes a static block layer's chunks: the cube's shadow on the blocks in Play and the export; Bake final (Blender Cycles) too where Blender is (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  // The final bake once, on the product's own renderer (the renderer variants are covered by the preview bake).
  const final = variant === 'auto' && haveBlender;
  test.setTimeout(final ? 1_000_000 : 300_000);
  const { layer, cube } = await openScene(page, variant, final ? { THIRDLIGHT_BAKE_HOST: bakeHost, THIRDLIGHT_BAKE_BLENDER: bakeBlender, THIRDLIGHT_BAKE_TIMEOUT_MINUTES: '12' } : {});

  // Before the bake: the sun is realtime without a shadow. A small area light, realtime, 0.5 m over the front corner
  // (the bake does not take area lights; a baked chunk draws its lightmap, so the lamp leaves the picture after it).
  const live = backendOf(variant) === 'webgpu';
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Lamp', transform: { position: [lampSpot[0], 0.5, lampSpot[2]] }, components: { light: { type: 'area', shape: 'rect', width: 0.6, height: 0.6, color: '#ffffff', intensity: 4, range: 1.5, castShadow: false, mode: 'realtime' } } });
  const before = await play(page, variant, steadyLit(live));
  const beforeLit = brightnessAt(before, litSpot);
  expect(Math.abs(brightnessAt(before, shadowSpot) - beforeLit)).toBeLessThan(15);
  const pool = brightnessAt(before, lampSpot) - brightnessAt(before, mirrorSpot);
  const highlight = brightnessAt(before, highlightSpot) - brightnessAt(before, acrossSpot);
  console.log(`[block-lightmaps] ${variant}: area light pool ${pool.toFixed(1)} over its mirror spot, highlight ${highlight.toFixed(1)} over the spot across the lamp (${live ? 'read from the surface cache' : 'no live cache'})`);
  // Where the cache is lit live the blocks draw its light and the lamp's highlight; WebGL 2 draws no area light before a bake.
  if (live) {
    expect(pool).toBeGreaterThan(LAMP_POOL);
    expect(highlight).toBeGreaterThan(HIGHLIGHT);
  } else {
    expect(Math.abs(pool)).toBeLessThan(LAMP_POOL);
    expect(Math.abs(highlight)).toBeLessThan(HIGHLIGHT);
  }

  // Bake in the Lighting window: the cube and the layer's chunk.
  await openWindow(page, 'Lighting');
  await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Preview (browser) bake', { timeout: 120_000 });
  const entries = await bakeEntries();
  expect(entries.map((e) => [e.entityId, e.chunk ?? null])).toEqual(expect.arrayContaining([[cube, null], [layer, [0, 0]]]));
  expect(entries.find((e) => e.entityId === layer)!.layout).toMatch(/^[0-9a-f]{16}$/);

  // Play: the shadow is in the chunk's lightmap; the lit blocks stay about as bright.
  const after = await play(page, variant, bakedShadow(beforeLit, 0.75, 0.6, 1.5));
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

  // Bake final: Blender Cycles bakes the cube and the layer's chunk; Play shows the shadow on the blocks.
  if (final) {
    await page.getByRole('button', { name: /settings/ }).click();
    await page.getByRole('spinbutton', { name: 'bake finalSamples' }).fill(bakeHost === 'local' ? '32' : '256');
    await page.getByRole('spinbutton', { name: 'bake texelsPerMeter' }).fill('8');
    await page.getByRole('button', { name: 'Bake final (Blender)' }).click();
    await expect(page.locator('[aria-label="bake status"]')).toContainText('Final (Blender) bake', { timeout: 840_000 });
    const bake = await bakeRecord();
    expect(bake.source).toBe('blender');
    expect(bake.bounces).toBe(3);
    expect(bake.entries.map((e) => [e.entityId, e.chunk ?? null])).toEqual(expect.arrayContaining([[cube, null], [layer, [0, 0]]]));
    const baked = await play(page, variant, bakedShadow(beforeLit, 0.8, 0.7, 1.7));
    const finalShadow = brightnessAt(baked, shadowSpot);
    const finalLit = brightnessAt(baked, litSpot);
    console.log(`[block-lightmaps] final: before lit ${beforeLit.toFixed(1)}; after lit ${finalLit.toFixed(1)} shadow ${finalShadow.toFixed(1)}`);
    expect(finalShadow).toBeLessThan(finalLit * 0.8);
    expect(finalLit / beforeLit).toBeGreaterThan(0.7);
    expect(finalLit / beforeLit).toBeLessThan(1.7);
  }

  // The static export with the backend stopped: the last bake's shadow.
  const share = final ? 0.8 : 0.75;
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
        return brightnessAt(img, shadowSpot) < lit * share && lit / beforeLit > 0.6;
      }, { timeout: 60_000, message: 'the baked shadow on the blocks in the export' })
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
