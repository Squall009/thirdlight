/**
 * Realtime shadows of boxes (and, by the same rule, models and
 * instance sets). A box above a floor box casts the sun's shadow onto it in
 * Play; with the box's `castShadow` off (the Inspector's "Casts shadows"
 * checkbox, a component field) the shadow is gone. The difference between the
 * two Play frames is the shadow: a patch of the floor clearly darker, and only
 * a patch (shadow acne or a self-shadowed floor would darken far more).
 *
 * Then the cached static shadow map (`cached-shadow.ts`): static boxes cast
 * into a map drawn only when they change, the rest into a dynamic map drawn
 * every frame. An idle Play draws the static map no more; moving a moving box
 * leaves it as it is; a script moving a static box's parent, a script hiding a
 * static box and the camera walking along Z (the shadow square follows the
 * camera on X and Z: a caster 80 m down Z still casts) draw it again. The
 * pictures match the same scene drawn with one map of every caster
 * (`?shadowcache=off`), in Play after those steps and in the Scene view after a
 * static box is moved by an edit and a static cutout fence's alpha texture
 * arrived late (held back until the map was drawn with the fence solid: its
 * material changes in place, which reports nothing else).
 *
 * The first test runs on the product's own renderer (renderer-variants.ts
 * PRODUCT_RENDERER_VARIANTS): env-parity compares shadow maps on both
 * backends; the cache's pixel comparison runs on both.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { publishBytes, publishScript, startBackend, type E2EBackend } from './backend';
import { diff, diffPng, show, STRICT, within } from './parity';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';
import { menu, showView } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('shadows-e2e');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q['revision'],
    requestId: `req-${String(seq).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'e2e-shadows' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

/** Pixels where `a` is darker than `b` by more than `delta` (luminance, 0–255). */
function darkerPixels(a: Image, b: Image, delta = 40): number {
  const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
  let n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (lum(b.pixel(x, y)) - lum(a.pixel(x, y)) > delta) n += 1;
  return n;
}

/** How far apart two equal shots must be for a picture to count as settled. */
const SETTLE_MS = 500;

async function playFrame(page: Page, variant: RendererVariant, label: string): Promise<Image> {
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  // Two equal frames half a second apart: the scene has settled (shaders compiled, shadow map drawn).
  let last = '';
  let img: Image | null = null;
  await expect
    .poll(
      async () => {
        const png = await frame.screenshot();
        img = decodePng(png);
        const same = png.toString('base64') === last;
        last = png.toString('base64');
        return same;
      },
      { timeout: 60_000, intervals: [SETTLE_MS] },
    )
    .toBe(true);
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.png`), Buffer.from(last, 'base64'));
  await page.getByTitle('Stop the play preview').click();
  // Stop is a backend round trip plus the preview's teardown: seconds on a loaded CPU-rendered host.
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  return img!;
}

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`a box casts the sun's shadow on a floor box in Play; "Casts shadows" off removes it (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(240_000);
  // The new project's camera stands at (0, 0.5, 4) looking along −Z; its sun casts shadows.
  // The floor ends 2 m in front of the camera (a floor edge through the camera's own
  // plane breaks depth testing on SwiftShader, both backends).
  await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'floor', transform: { position: [0, -1, -1] }, box: { size: [8, 0.2, 6], material: { color: '#c8c8c8' } } });
  const cube = await command('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'cube', transform: { position: [0, -0.3, 0] }, box: { size: [1, 1, 1], material: { color: '#c05030' } } });
  const cubeId = String(cube['createdId']);
  // The sun from behind-left-above: the shadow falls right and towards the camera (in view).
  await command('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.5, -1, 0.6], castShadow: true } });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The Inspector shows the box's shadow fields (checked by default).
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'cube' }).click();
  const casts = page.getByLabel('box castShadow', { exact: true });
  await expect(casts).toBeChecked();

  const withShadow = await playFrame(page, variant, 'with-shadow');
  // Off in the Inspector (a controlled checkbox: click, then poll the stored value).
  await casts.click();
  await expect
    .poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: cubeId } }))['entity'] as { components: { box: { castShadow?: boolean } } }).components.box.castShadow)
    .toBe(false);
  const without = await playFrame(page, variant, 'without-shadow');

  expect(withShadow.width).toBe(without.width);
  const shadow = darkerPixels(withShadow, without);
  const total = withShadow.width * withShadow.height;
  console.log(`[shadows] ${variant}: ${shadow} of ${total} pixels darker by > 40 with the cube's shadow`);
  // A visible patch (the cube's 1 m shadow is thousands of pixels here)…
  expect(shadow).toBeGreaterThan(1500);
  // …and only a patch: no acne or self-shadowing over the whole floor.
  expect(shadow).toBeLessThan(total * 0.15);
  // Nothing got brighter (the shadow only takes light away).
  expect(darkerPixels(without, withShadow)).toBeLessThan(200);
});

/** The project script: `place {id, x, y, z}` moves an object, `hide {id}` hides it, `walk {z}` puts the camera at z. */
const DRIVER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const c of ctx.debug.command('place', { description: 'Move an object', args: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) {",
  "      ctx.entity(String(c.id))?.set('transform', { position: [Number(c.x), Number(c.y), Number(c.z)] });",
  '    }',
  "    for (const c of ctx.debug.command('hide', { description: 'Hide an object', args: [{ name: 'id', type: 'string' }] })) ctx.game.setVisible(String(c.id), false);",
  "    for (const c of ctx.debug.command('walk', { description: 'Put the camera at z', args: [{ name: 'z', type: 'number' }] })) {",
  "      ctx.entity('cam-main')?.set('transform', { position: [0, 3, Number(c.z)], rotation: [-0.130526, 0, 0, 0.991445] });",
  '    }',
  '  },',
  '};',
].join('\n');

/** The cached shadow's draws in Play's diagnostics. */
interface ShadowMaps {
  static: number;
  dynamic: number;
  staticTotal: number;
  dynamicTotal: number;
}

/** A canvas's picture once two shots in a row are the same. */
async function settledShot(target: Locator, label: string): Promise<{ img: Image; png: Buffer }> {
  let last = '';
  await expect
    .poll(
      async () => {
        const png = (await target.screenshot()).toString('base64');
        const same = png === last;
        last = png;
        return same;
      },
      { timeout: 90_000, intervals: [SETTLE_MS] },
    )
    .toBe(true);
  const png = Buffer.from(last, 'base64');
  const out = test.info().outputPath();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.png`), png);
  return { img: decodePng(png), png };
}

/** Grey pixels of the lower part of the view clearly darker than the lit floor there (the floor's shadow). */
function floorShadowPixels(img: Image): number {
  const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
  const grey: number[] = [];
  const y0 = Math.floor(img.height * 0.55);
  for (let y = y0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const p = img.pixel(x, y);
      if (Math.max(p[0]!, p[1]!, p[2]!) - Math.min(p[0]!, p[1]!, p[2]!) < 25) grey.push(lum(p));
    }
  }
  if (grey.length === 0) return 0;
  const sorted = [...grey].sort((a, b) => a - b);
  const lit = sorted[Math.floor(sorted.length * 0.75)]!;
  return grey.filter((l) => l < lit * 0.6).length;
}

/**
 * Cached and single maps draw the same texels: no pixel may differ by more than the strict delta (a stale
 * static map shows as a few shadow pixels in the wrong place, a fraction STRICT's share would let through).
 */
const SAME_SHADOWS = { ...STRICT, bad: 0 };

function compare(a: { img: Image; png: Buffer }, b: { img: Image; png: Buffer }, label: string): void {
  const d = diff(a.img, b.img, SAME_SHADOWS);
  console.log(`[shadows] ${label}, cached vs one map of every caster: ${show(d, SAME_SHADOWS)}`);
  if (!within(d, SAME_SHADOWS)) writeFileSync(join(test.info().outputPath(), `diff-${label}.png`), diffPng(a.img, b.img));
  expect(within(d, SAME_SHADOWS), `${label}: ${show(d, SAME_SHADOWS)}`).toBe(true);
}

for (const variant of RENDERER_VARIANTS) test(`static casters cast from a cached map, the rest every frame; the square follows the camera along Z; pictures match one map of every caster (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  const make = async (args: Record<string, unknown>): Promise<string> => String((await command('createEntity', { sceneId: 'scene-main', ...args }))['createdId']);
  // A static floor, static boxes (one under a moving parent), one moving box; the floor going on down -Z and a
  // box far down it come after the Scene view's part (the view frames what is there when it opens).
  await make({ kind: 'box', name: 'floor', static: true, transform: { position: [0, -0.12, -5] }, box: { size: [16, 0.2, 20], material: { color: '#c8c8c8' } } });
  const pillar = await make({ kind: 'box', name: 'pillar', static: true, transform: { position: [-3, 1.5, -6] }, box: { size: [1, 3, 1], material: { color: '#3060c0' } } });
  const rig = await make({ kind: 'group', name: 'rig', transform: { position: [3, 0, -8] } });
  await make({ kind: 'box', name: 'post', static: true, parentId: rig, transform: { position: [0, 1.25, 0] }, box: { size: [0.6, 2.5, 0.6], material: { color: '#c0a030' } } });
  const mover = await make({ kind: 'box', name: 'mover', transform: { position: [0, 0.9, -4] }, box: { size: [0.8, 1.8, 0.8], material: { color: '#c05030' } } });
  await command('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.5, -1, 0.4], castShadow: true } });
  await command('setTransform', { entityId: 'cam-main', transform: { position: [0, 3, 4], rotation: [-0.130526, 0, 0, 0.991445], scale: [1, 1, 1] } });
  // A static cutout fence: vertical slats (every other 8 texels of its alpha map transparent).
  const slats = makePng(64, 64, (x) => [235, 235, 235, x % 16 < 8 ? 255 : 0]);
  const slatsDigest = createHash('sha256').update(slats).digest('hex');
  await publishBytes(be, slats, 'texture', 'tex-slats');
  await command('setMaterial', { material: { materialId: 'mat-fence', name: 'Fence', shader: 'standard', params: { color: '#ffffff', alphaMode: 'cutout', alphaCutoff: 0.5 }, textures: { map: 'tex-slats' } } });
  const fence = await make({ kind: 'box', name: 'fence', static: true, transform: { position: [-1.5, 1.2, -9] }, box: { size: [2.5, 2.4, 0.1], material: { color: '#ffffff' } } });
  await command('setComponent', { entityId: fence, component: 'materials', value: { '*': 'mat-fence' } });
  const driver = await make({ parentId: null, kind: 'group', name: 'Driver', transform: { position: [0, 0, 2] } });
  await publishScript(be, 'driver', DRIVER, driver);

  const api = async (path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const urlOf = (cached: boolean): string => editorUrlFor(cached ? be.editorUrl : be.editorUrl.replace('#', '&shadowcache=off#'), variant);

  // ---- The Scene view: a static box moved by an edit after the static map was drawn ----
  const sceneView = async (cached: boolean): Promise<{ img: Image; png: Buffer }> => {
    // The cached view gets the fence's texture only after the edit redrew its static map with the fence solid.
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => (release = r));
    if (cached) {
      await page.context().route((url) => url.href.includes(slatsDigest) || url.href.includes('tex-slats'), async (route) => {
        await released;
        await route.continue();
      });
    }
    await page.goto(urlOf(cached));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const view = page.locator('canvas.tl-viewport');
    await expectRendererBackend(view, variant);
    await showView(page, 'Scene');
    // The scene's own lights (the scene has a sun), and no grid over the floor: its shadows show.
    await expect(page.getByText('light: game')).toBeVisible();
    await menu(page, 'Gizmos', 'Grid: on');
    await expect(view).toHaveAttribute('data-grid', 'false');
    if (cached) {
      await settledShot(view, `scene-view-before-${variant}`);
      await command('setTransform', { entityId: pillar, transform: { position: [-2, 1.5, -4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
      await settledShot(view, `scene-view-fence-solid-${variant}`);
      release();
    }
    const shot = await settledShot(view, `scene-view-${cached ? 'cached' : 'single'}-${variant}`);
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    return shot;
  };
  const viewCached = await sceneView(true);
  const viewSingle = await sceneView(false);
  compare(viewCached, viewSingle, `Scene view after an edit (${variant})`);
  await make({ kind: 'box', name: 'far floor', static: true, transform: { position: [0, -0.12, -70] }, box: { size: [40, 0.2, 110], material: { color: '#c8c8c8' } } });
  await make({ kind: 'box', name: 'far', static: true, transform: { position: [0, 1.5, -80] }, box: { size: [1.5, 3, 1.5], material: { color: '#30a040' } } });

  // ---- Play: the steps, the cache's draws, the far caster's shadow ----
  const play = async (cached: boolean): Promise<{ img: Image; png: Buffer }> => {
    await page.goto(urlOf(cached));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect.poll(async () => (await api(`play/${psid}/observe`)).json['state'], { timeout: 60_000 }).toBe('running');
    const maps = async (): Promise<ShadowMaps | undefined> => ((await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { renderer?: { shadowMaps?: ShadowMaps } } }).diagnostics?.renderer?.shadowMaps;
    const send = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const r = await api(`play/${psid}/control`, { command: 'debugCommand', name, args });
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    };
    if (!cached) expect(await maps(), 'one map of every caster: no cache counts').toBeUndefined();
    /** Wait until the dynamic map (drawn every frame) has been drawn `n` more times: a command sent before has been stepped and drawn. */
    const frames = async (n: number): Promise<void> => {
      const from = (await maps())!.dynamicTotal;
      await expect.poll(async () => (await maps())!.dynamicTotal - from, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
    };
    /** Static map draws during `what` (its effect stepped and drawn over the next 30 frames). */
    const staticDraws = async (what: () => Promise<void>): Promise<number> => {
      const before = (await maps())!;
      await what();
      await frames(30);
      return (await maps())!.staticTotal - before.staticTotal;
    };
    if (cached) {
      await expect.poll(async () => (await maps())?.dynamicTotal ?? 0, { timeout: 30_000, message: 'the cached shadow draws' }).toBeGreaterThan(10);
      await settledShot(canvas, `play-start-${variant}`);
      const a = (await maps())!;
      await page.waitForTimeout(1000);
      const b = (await maps())!;
      console.log(`[shadows] ${variant} idle 1 s: static ${b.staticTotal - a.staticTotal}, dynamic ${b.dynamicTotal - a.dynamicTotal} map draws (last frame ${b.static}/${b.dynamic})`);
      expect(b.staticTotal - a.staticTotal, 'an idle scene draws the static map no more').toBe(0);
      expect(b.dynamicTotal - a.dynamicTotal, 'the dynamic map is drawn every frame').toBeGreaterThan(10);
      expect(b.static).toBe(0);
      expect(await staticDraws(() => send('place', { id: mover, x: 1, y: 0.9, z: -3 })), 'a moving box leaves the static map as it is').toBe(0);
      expect(await staticDraws(() => send('place', { id: rig, x: 4, y: 0, z: -6 })), "a script moving a static box's parent draws it again").toBeGreaterThan(0);
      expect(await staticDraws(() => send('hide', { id: pillar })), 'a script hiding a static box draws it again').toBeGreaterThan(0);
      expect(await staticDraws(async () => { for (const z of [-15, -30, -45, -60, -70]) { await send('walk', { z }); await frames(10); } }), 'the static square steps along with the camera').toBeGreaterThan(0);
    } else {
      await send('place', { id: mover, x: 1, y: 0.9, z: -3 });
      await send('place', { id: rig, x: 4, y: 0, z: -6 });
      await send('hide', { id: pillar });
      for (const z of [-15, -30, -45, -60, -70]) await send('walk', { z });
    }
    const shot = await settledShot(canvas, `play-${cached ? 'cached' : 'single'}-${variant}`);
    await page.getByTitle('Stop the play preview').click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
    return shot;
  };
  const playCached = await play(true);
  // 70 m down Z, the far box's shadow lies on the floor in view.
  const shadowed = floorShadowPixels(playCached.img);
  console.log(`[shadows] ${variant}: ${shadowed} floor pixels in shadow 70 m down Z`);
  expect(shadowed, 'the shadow square walked along Z with the camera').toBeGreaterThan(300);
  const playSingle = await play(false);
  compare(playCached, playSingle, `Play after the steps (${variant})`);
});
