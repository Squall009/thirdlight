/**
 * Materials, textures and wind in the browser. A foliage material
 * (COLOR_0 as wind data) set as an asset's default makes its pieces move in
 * the Scene view (its wind preview on; off, they hold still there), in Play
 * and in the export (a standard material's texture
 * on a box, on every backend: textures.e2e.ts). Foliage bends round every
 * object with an interactor (more than the four view subjects it once took)
 * and round a script's view subject without one, and stands up again once
 * they leave, in an export served with the backend stopped (WebGPU: the
 * interaction field is a compute pass).
 *
 * Node materials on WebGPURenderer, on the product's own renderer
 * (renderer-variants.ts PRODUCT_RENDERER_VARIANTS): shader-parity compares
 * the foliage shader on both backends.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { publishScript, startBackend, type E2EBackend, withoutSky } from './backend';
import { KIT_PIECES, multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS } from './renderer-variants';
import { projectWindow, openWindow, createItem, inspector, menu } from './ui';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  await withoutSky(be);
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-mat-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Pixels that differ between two images (a coarse motion measure). */
function changed(a: Image, b: Image): number {
  let n = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y += 2) {
    for (let x = 0; x < Math.min(a.width, b.width); x += 2) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 40) n += 1;
    }
  }
  return n;
}
async function motion(target: Locator | Page): Promise<number> {
  const a = decodePng(await target.screenshot());
  await new Promise((r) => setTimeout(r, 700));
  const b = decodePng(await target.screenshot());
  return changed(a, b);
}
async function importFile(page: Page, file: string): Promise<void> {
  await projectWindow(page);
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

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`a foliage material moves in the wind (editor, Play, export) (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(240_000);
  const kit = join(dir, 'kit.glb');
  writeFileSync(kit, multiPieceGlb(KIT_PIECES));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await importFile(page, kit);
  const kitTile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').filter({ hasText: 'kit' });
  await kitTile.dragTo(page.locator('canvas.tl-viewport'));
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'flower' })).toHaveCount(1, { timeout: 10_000 });
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  const viewport = page.locator('canvas.tl-viewport');
  // Without a wind material nothing moves.
  expect(await motion(viewport)).toBeLessThan(20);

  // A foliage material, strong bend.
  await createItem(page, 'Material', 'Material 1');
  await inspector(page).getByRole('combobox', { name: 'shader' }).selectOption('foliage');
  await expect(inspector(page).getByRole('combobox', { name: 'shader' })).toHaveValue('foliage');
  // One step up, not the maximum: the fixture's pieces bend as a whole (full weight), and at
  // windBend 4 with wind strength 10 they swing ~5 m, out of the frame for ~2 s of every
  // ~3.7 s sway — two screenshots that both land there read "no motion" (the load-only flake).
  await page.getByRole('slider', { name: 'windBend slider' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tl-param[data-param="windBend"]')).toHaveClass(/is-set/);

  // Strong wind.
  await openWindow(page, 'Environment');
  await page.getByRole('slider', { name: 'wind strength' }).focus();
  await page.keyboard.press('End');
  // The wind is the scene's (each scene has its own look).
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryProject', projectId: be.projectId, args: { environments: true } }))['scenes'])).toContain('"strength":10');

  // The kit's default material: every placement bends in the wind.
  await projectWindow(page);
  await kitTile.click();
  await page.getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Material 1' });
  // The Scene view's wind preview (off by default: foliage holds still there) on.
  const windPreview = page.getByRole('button', { name: /^wind: (on|off)$/ });
  await expect(windPreview).toHaveAttribute('aria-pressed', 'false');
  await windPreview.click();
  await expect(windPreview).toHaveAttribute('aria-pressed', 'true');
  // Generous waits: the first frames with a new node material compile its pipeline (slow on the CPU renderer here).
  await expect.poll(() => motion(viewport), { timeout: 30_000 }).toBeGreaterThan(50);

  // The wind field: the gust pattern's size from the window (the scene's wind), then a wind zone over the kit
  // (made where the view looks, as the kit was dropped) with no strength and no gusts in its Inspector stills it.
  await openWindow(page, 'Environment');
  await page.getByRole('slider', { name: 'wind scale' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryProject', projectId: be.projectId, args: { environments: true } }))['scenes'])).toContain('"scale":20.5');
  await menu(page, 'GameObject', 'Light', 'Wind zone');
  await expect(page.locator('[aria-label="windZone component"]')).toBeVisible();
  const zone = async (): Promise<Record<string, unknown> | undefined> => ((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as { components: { windZone?: Record<string, unknown> } }[]).find((e) => e.components.windZone !== undefined)?.components.windZone;
  // An unset value's slider rests at its minimum: up to the top (stored) and back sets it to 0.
  for (const field of ['strength', 'gust']) {
    const slider = page.getByRole('slider', { name: `windZone ${field} slider` });
    await slider.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => (await zone())?.[field]).toBe(10);
    await slider.focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await zone())?.[field]).toBe(0);
  }
  expect(await zone()).toMatchObject({ shape: 'box', size: [20, 10, 20] });
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(() => motion(viewport), { timeout: 20_000 }).toBeLessThan(20);
  // Deleted, the scene's wind is back (Play shows it moving again below).
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Wind zone' }).click();
  await viewport.hover();
  await page.keyboard.press('Delete');
  await expect.poll(zone).toBeUndefined();
  // The wind preview off: the scene's wind is back, yet the Scene view's foliage holds still.
  await windPreview.click();
  await expect(windPreview).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => motion(viewport), { timeout: 10_000 }).toBeLessThan(20);

  // Play: the wind moves the pieces there too.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(() => motion(frame), { timeout: 45_000 }).toBeGreaterThan(30);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export: the same, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(() => motion(exported), { timeout: 20_000 }).toBeGreaterThan(30);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});

/** Where the pressing objects stand while P is held (x, z; between the posts), the last one a script's view subject without an interactor. */
const PRESS_AT: readonly (readonly [number, number])[] = [[-7.25, -2.25], [-2.25, -2.25], [2.75, -2.25], [7.25, -2.25], [-7.25, 2.75], [-2.25, 2.75], [2.75, 2.75], [7.25, 2.75]];
const SUBJECT = PRESS_AT.length - 1;
/**
 * On each pressing object: it stands among the posts while `press` is held and 40 m back (out of the view, past the
 * posts) otherwise; the object `subject` is named the view's subject.
 */
const pressScript = (subject: string): string => [
  'export default {',
  '  instantiate() { return { home: null as number[] | null, on: false, named: false }; },',
  '  step(state: { home: number[] | null; on: boolean; named: boolean }, ctx: any) {',
  "    if (ctx.phase === 'intent') {",
  `      if (!state.named && ctx.entityId === ${JSON.stringify(subject)}) ctx.camera.setSeeThrough({ enabled: false, subjects: [ctx.entityId] });`,
  '      state.named = true;',
  "      state.on = ctx.input.held('press');",
  '      return;',
  '    }',
  "    if (ctx.phase !== 'transform') return;",
  '    const t = ctx.world.transform(ctx.entityId);',
  '    if (t === undefined) return;',
  '    state.home ??= [t.position[0], t.position[1], t.position[2]];',
  '    const [x, y, z] = state.home;',
  "    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x, y, z: state.on ? z - 40 : z }, quaternion: [0, 0, 0, 1] });",
  '  },',
  '};',
  '',
].join('\n');

test('foliage bends round any number of interactors and a script\'s subject, and stands up again once they leave (editor, export with the backend stopped; WebGPU)', async ({ page }) => {
  test.skip(backendOf('auto') !== 'webgpu', 'the interaction field is a WebGPU compute pass; WebGL 2 draws no pressing');
  test.setTimeout(180_000);
  const cmd = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-press' }, args });
    expect(r['ok'], JSON.stringify(r).slice(0, 400)).toBe(true);
    return r;
  };
  // Still air (the posts move only when pressed), a dark sky and floor, the sun from above; the camera straight down.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#101418', environmentIntensity: 0 }, post: { antialias: 'smaa' }, wind: { direction: [1, 0], strength: 0, gust: 0, gustFrequency: 0.3, turbulence: 0 } } });
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.5, direction: [0.1, -1, 0.1], castShadow: false } });
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 20, 0], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] } });
  const lens = ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: 'cam-main' } }))['entity'] as { components: { virtualCamera?: Record<string, unknown> } }).components.virtualCamera;
  await cmd('setComponent', { entityId: 'cam-main', component: 'virtualCamera', value: { ...(lens ?? {}), rig: 'fixed', fovY: 50, near: 0.1, far: 200 } });
  await cmd('setInput', { input: { actions: [{ name: 'press', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyP' }] }] } });
  // Posts 2 m tall every 0.5 m round each place an object will stand and round an empty place (the control), in a foliage
  // material: no COLOR_0, so a post leans by its height above its middle.
  await cmd('setMaterial', { material: { materialId: 'mat-post', name: 'Post', shader: 'foliage', params: { color: '#f0f0f0', windDistance: 0 }, textures: {} } });
  const entities: Record<string, unknown>[] = [{ id: 'floor', name: 'floor', components: { transform: { position: [0, -0.1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [60, 0.2, 60], material: { color: '#202020' } } } }];
  const near = [...PRESS_AT, [0.25, 0.25] as const];
  for (let i = 0; i <= 36; i++) {
    for (let j = 0; j <= 20; j++) {
      const [x, z] = [-9 + i * 0.5, -5 + j * 0.5];
      if (!near.some(([px, pz]) => Math.hypot(x - px, z - pz) < 1.7)) continue;
      entities.push({ id: `post-${i}-${j}`, name: `post ${i} ${j}`, components: { transform: { position: [x, 1, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [0.08, 2, 0.08], material: { color: '#f0f0f0' } }, materials: { '*': 'mat-post' } } });
    }
  }
  // In parts: a request is held to 64 KiB.
  for (let k = 0; k < entities.length; k += 80) await cmd('pasteEntities', { sceneId: 'scene-main', entities: entities.slice(k, k + 80) });
  // Seven interactors (the old limit was four subjects) and one view subject without the component, out of the view until P is held.
  const ids: string[] = [];
  for (const [k, [x, z]] of PRESS_AT.entries()) {
    const size = k === SUBJECT ? [1, 1, 1] : [0.4, 1, 0.4];
    ids.push(String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: `press ${k}`, transform: { position: [x, 0.5, z + 40] }, box: { size, material: { color: '#e02020' } } }))['createdId']));
    if (k !== SUBJECT) await cmd('setComponent', { entityId: ids[k]!, component: 'interactor', value: { radius: 1.2, strength: 2, recovery: 0.5 } });
  }
  await publishScript(be, 'press-place', pressScript(ids[SUBJECT]!), ids[0]!, ['@self']);
  for (const id of ids.slice(1)) await cmd('setBehaviorProperties', { entityId: id, behaviorId: 'press-place', values: {} });

  // The Inspector shows the component from its descriptor.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'press 0' }).click();
  await expect(page.locator('[aria-label="interactor component"]')).toBeVisible();

  // The export, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.setViewportSize({ width: 960, height: 540 });
    await game.goto(site.url);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, 'webgpu');
    await expect.poll(async () => Number((await canvas.getAttribute('data-tl-draws')) ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    /** The canvas once two shots 300 ms apart agree (the posts still): its picture. */
    const settled = async (label: string): Promise<Image> => {
      let last: Image | null = null;
      let shot: Image | null = null;
      let png: Buffer | null = null;
      await expect.poll(async () => {
        png = await canvas.screenshot();
        shot = decodePng(png);
        const still = last !== null && changed(last, shot) < 15;
        last = shot;
        return still;
      }, { timeout: 30_000, intervals: [300] }).toBe(true);
      writeFileSync(test.info().outputPath(`press-${label}.png`), png!);
      return shot!;
    };
    // Where a ground point at height y shows (the camera 20 m up looking straight down, fovY 50, screen up = world −z).
    const box = await canvas.boundingBox();
    const [W, H] = [Math.round(box!.width), Math.round(box!.height)];
    const t = Math.tan((25 * Math.PI) / 180);
    const toPx = (x: number, z: number, y: number): [number, number] => [((1 + x / ((20 - y) * t * (W / H))) / 2) * W, ((1 + z / ((20 - y) * t)) / 2) * H];
    /** Pixels that differ between two pictures in a ring round a ground point (metres, at the posts' tops), the object's own square left out. */
    const ringChange = (a: Image, b: Image, x: number, z: number, inner: number, outer: number): number => {
      const [cx, cy] = toPx(x, z, 2);
      const m = toPx(1, 0, 2)[0] - toPx(0, 0, 2)[0];
      let n = 0;
      for (let py = Math.floor(cy - outer * m); py <= cy + outer * m; py++) {
        for (let px = Math.floor(cx - outer * m); px <= cx + outer * m; px++) {
          if (px < 0 || py < 0 || px >= a.width || py >= a.height) continue;
          const d = Math.hypot(px - cx, py - cy) / m;
          if (d < inner || d > outer) continue;
          const p = a.pixel(px, py);
          const q = b.pixel(px, py);
          if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) n += 1;
        }
      }
      return n;
    };
    const before = await settled('before');
    await canvas.click({ position: { x: 5, y: 5 } });
    await game.keyboard.down('KeyP');
    // Every pressing object stands among the posts (its red top seen where it should be), and the posts round it lean away.
    await expect.poll(async () => {
      const img = decodePng(await canvas.screenshot());
      return PRESS_AT.every(([x, z]) => {
        const [px, py] = toPx(x, z, 1).map(Math.round) as [number, number];
        const p = img.pixel(px, py);
        return p[0] > 150 && p[1] < 90;
      });
    }, { timeout: 20_000 }).toBe(true);
    const pressed = await settled('pressed');
    const far = ringChange(before, pressed, 0.25, 0.25, 0, 1.2);
    const rings = PRESS_AT.map(([x, z], k) => ringChange(before, pressed, x, z, k === SUBJECT ? 0.75 : 0.35, 1.2));
    console.log(`[interaction field] pressed: ring changes ${rings.join(', ')} px; a ring with nothing in it ${far} px`);
    for (const n of rings) expect(n).toBeGreaterThan(Math.max(40, far * 4));
    expect(far).toBeLessThan(20);
    // Released: they leave the view and the posts stand up again (recovery 0.5 s; the subject's 1 s, the default).
    await game.keyboard.up('KeyP');
    await expect.poll(async () => {
      const img = decodePng(await canvas.screenshot());
      return PRESS_AT.every(([x, z]) => {
        const [px, py] = toPx(x, z, 1).map(Math.round) as [number, number];
        return img.pixel(px, py)[0] < 150;
      });
    }, { timeout: 20_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await settled('after');
    const left = PRESS_AT.map(([x, z]) => ringChange(before, after, x, z, 0, 1.2));
    console.log(`[interaction field] recovered: ring changes against before ${left.join(', ')} px`);
    for (const n of left) expect(n).toBeLessThan(Math.max(20, far * 2));
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
