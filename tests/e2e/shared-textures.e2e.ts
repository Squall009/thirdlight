/**
 * Standard-shader project materials share their textures across model files,
 * against a real backend in a real browser, per renderer variant
 * (renderer-variants.ts).
 *
 * Fourteen model files (UV spheres, each its own GLB with its own material)
 * all wear one project material `trim` (the standard shader, a base colour
 * map: a 2048² KTX2 checker, which streams by default). A built material is
 * made per model file (the file's material is its base), but the texture it
 * draws with is one object per (asset, colour space, wrap, tiling): the
 * streamed texture has one copy, and the renderer holds no more textures with
 * fourteen models than with one. The spheres show the checker's two colours.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { sphereGlbWith } from '../../tools/perf/assets';
import { publishBytes, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-shared-textures' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 400)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

interface Streamed {
  id: string;
  copies: number;
  resident: number;
}
interface PlayView {
  trim: () => Promise<Streamed | undefined>;
  gpuTextures: () => Promise<number | undefined>;
}

async function startPlay(page: Page, variant: (typeof RENDERER_VARIANTS)[number]): Promise<PlayView> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(page.locator('iframe.tl-app__preview-frame')).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => (await api(`play/${psid}/observe`, {})).json['state'], { timeout: 60_000 }).toBe('running');
  return {
    trim: async () => {
      const r = await api(`play/${psid}/observe`, {});
      return ((r.json['resources'] as { textures?: { textures: Streamed[] } } | undefined)?.textures?.textures ?? []).find((t) => t.id === 'trim');
    },
    gpuTextures: async () => {
      const r = await api(`play/${psid}/diagnostics`, {});
      return r.status === 200 ? (r.json['diagnostics'] as { renderer?: { gpu?: { textures: number } } } | undefined)?.renderer?.gpu?.textures : undefined;
    },
  };
}

/** Pixels of the checker's red and of its blue (lit: a clear lead of the channel over the others). */
function checkerPixels(img: Image): { red: number; blue: number } {
  let red = 0;
  let blue = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > g + 50 && r > b + 50) red += 1;
      else if (b > r + 50 && b > g + 30) blue += 1;
    }
  }
  return { red, blue };
}
const shot = async (t: Locator): Promise<Image> => decodePng(await t.screenshot());

for (const variant of RENDERER_VARIANTS) test(`one standard material on 14 model files holds one copy of its texture (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend(`shared-tex-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The texture: a 2048² checker of 256-texel squares, red and blue, KTX2 colour (streams by default).
  await publishBytes(be, new Uint8Array(makePng(2048, 2048, (x, y) => (((x >> 8) + (y >> 8)) % 2 === 0 ? [230, 30, 30, 255] : [30, 60, 230, 255]))), 'texture', 'trim', 'trim', { ktx2: 'color' });
  await cmd('setMaterial', { material: { materialId: 'trim-mat', name: 'Trim', shader: 'standard', params: { roughness: 1, metalness: 0, tiling: [1, 1] }, textures: { map: 'trim' } } });
  // Fourteen model files in the game folder: the same sphere, each file distinct (and its own material inside), one folder import.
  const tiny = new Uint8Array(makePng(4, 4, () => [255, 255, 255, 255]));
  mkdirSync(join(be.projectDir, 'assets', 'balls'), { recursive: true });
  for (let i = 1; i <= 14; i++) {
    const id = `ball-${String(i).padStart(2, '0')}`;
    writeFileSync(join(be.projectDir, 'assets', 'balls', `${id}.glb`), sphereGlbWith(12, { bytes: tiny, format: 'png' }, id));
  }
  const imported = (await cmd('importAssets', { folder: 'assets/balls' })) as { change: { added: { assetId: string; kind: string }[] } };
  expect(imported.change.added.filter((a) => a.kind === 'model').map((a) => a.assetId).sort()).toEqual(Array.from({ length: 14 }, (_, i) => `ball-${String(i + 1).padStart(2, '0')}`));

  // The scene: a grey sky, the camera at z 7 looking along −Z, the spheres in two rows of seven.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 0.5, 7], rotation: [0, 0, 0, 1] } });
  for (const e of ents) if (e.components['box'] !== undefined || e.components['model'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const balls: string[] = [];
  for (let i = 0; i < 14; i++) {
    const assetId = `ball-${String(i + 1).padStart(2, '0')}`;
    const at = [(i % 7) * 1.1 - 3.3, i < 7 ? 1 : -0.3, 0];
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'model', name: assetId, model: { asset: { assetId } }, transform: { position: at }, components: { materials: { '*': 'trim-mat' } } }))['createdId']);
    balls.push(id);
  }

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const frame = page.locator('iframe.tl-app__preview-frame');

  // ---- Fourteen files: the streamed texture has one copy; the spheres show the checker.
  const many = await startPlay(page, variant);
  await expect.poll(async () => (await many.trim())?.copies ?? -1, { timeout: 60_000 }).toBe(1);
  let picture = checkerPixels(await shot(frame));
  await expect.poll(async () => (picture = checkerPixels(await shot(frame))).red, { timeout: 30_000 }).toBeGreaterThan(200);
  expect(picture.blue).toBeGreaterThan(200);
  // Settled: what the renderer holds with fourteen.
  let gpuMany = -1;
  await expect.poll(async () => {
    const a = await many.gpuTextures();
    await page.waitForTimeout(500);
    const b = await many.gpuTextures();
    gpuMany = b ?? -1;
    return a !== undefined && a === b;
  }, { timeout: 30_000 }).toBe(true);
  expect((await many.trim())!.copies).toBe(1);
  await page.getByTitle('Stop the play preview').click();

  // ---- One file: the renderer holds as many textures as with fourteen.
  for (const id of balls.slice(1)) await cmd('deleteEntity', { entityId: id });
  const one = await startPlay(page, variant);
  await expect.poll(async () => (await one.trim())?.copies ?? -1, { timeout: 60_000 }).toBe(1);
  await expect.poll(async () => checkerPixels(await shot(frame)).red, { timeout: 30_000 }).toBeGreaterThan(20);
  let gpuOne = -1;
  await expect.poll(async () => {
    const a = await one.gpuTextures();
    await page.waitForTimeout(500);
    const b = await one.gpuTextures();
    gpuOne = b ?? -1;
    return a !== undefined && a === b;
  }, { timeout: 30_000 }).toBe(true);
  await page.getByTitle('Stop the play preview').click();
  test.info().annotations.push({ type: 'gpu-textures', description: JSON.stringify({ variant, gpuMany, gpuOne, red: picture.red, blue: picture.blue }) });
  console.log(`[shared-textures] ${variant}: gpu textures with 14 files ${gpuMany}, with 1 ${gpuOne}`);
  // (Not equal to the texture: what else is resident at the moment differs by one either way.)
  expect(gpuMany).toBeLessThanOrEqual(gpuOne);
  expect(errors).toEqual([]);
});
