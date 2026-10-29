/**
 * Point, spot and hemisphere lights. A red point light next to a
 * box tints it in the Scene view (game lighting) and in Play; the light is
 * edited in the Inspector (its light mask and the box's light layers as
 * checkboxes named in Project Settings, the box's local-light mode — per
 * pixel or none, which unlights it — as a select); the Scene view
 * toggles between the editor rig and the scene's own lights; the View
 * menu's light clusters heat map lists the light where it reaches. A room
 * of lamps drawn by the light clusters lights more than 16 lamps at once, on
 * both renderers; its spot and point lights' shadows and a spot's cookie,
 * drawn from the shared shadow atlas and cookie atlas, match three's own maps
 * (measured before the atlases); area lights light the moving floor too,
 * more than four of them a pixel.
 *
 * Runs on the product's own renderer (renderer-variants.ts
 * PRODUCT_RENDERER_VARIANTS): scene-lights covers lights and cookies on both.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { publishBytes, startBackend, type E2EBackend, withoutSky } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS } from './renderer-variants';
import { closeProjectSettings, inspector, menu, openProjectSettings, settingsWindow, showView } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
  await withoutSky(be);
});
test.afterEach(async () => {
  await be.stop();
});

const isReddish = ([r, g, b]: readonly number[]): boolean => r! > 60 && r! > 1.8 * g! && r! > 1.8 * b!;
function reddish(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (isReddish(img.pixel(x, y))) n += 1;
  return n;
}
/** The heat map's colour for a cell listing one light (blue). */
const isOneLight = ([r, g, b]: readonly number[]): boolean => b! > 60 && b! > 2 * r! && b! > 1.3 * g!;

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`a red point light tints a box in the Scene view and in Play; lights are edited in the Inspector (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(120_000);
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The new project has a sun and an ambient light: the Scene view uses them.
  await expect(page.getByRole('button', { name: 'light: game' })).toBeVisible();
  await menu(page, 'GameObject', 'Box');
  await menu(page, 'GameObject', 'Light', 'Point light');
  const lightRow = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(lightRow).toContainText('Point light');
  const lightId = (await lightRow.getAttribute('data-entity-id'))!;
  // Red, strong, close to the box (the box sits at the view focus; the light 1 m above it).
  await expect(page.locator('[aria-label="light component"]')).toBeVisible();
  const colour = page.getByLabel('light color', { exact: true });
  await colour.focus();
  await colour.evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, '#ff0000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await colour.blur();
  await page.getByRole('slider', { name: 'light intensity' }).focus();
  await page.keyboard.press('End');
  // The slider's edit is a command of its own: wait for it before the next one reads the revision.
  await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: { intensity: number } } }).components.light.intensity, { timeout: 10_000 }).toBe(1000);
  const box = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['entities'] as { id: string; components: { box?: object; transform: { position: number[] } } }[];
  const boxPos = box.find((e) => e.components.box !== undefined)!.components.transform.position;
  const q = await be.command({ op: 'queryProject', projectId: be.projectId });
  const moved = await be.command({ op: 'setTransform', projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${'b'.repeat(31)}1`, args: { entityId: lightId, transform: { position: [boxPos[0]!, boxPos[1]! + 1.2, boxPos[2]! + 1.2] } } });
  expect(moved['ok'], JSON.stringify(moved)).toBe(true);
  const light = (await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: { color: string; intensity: number } } };
  expect(light.components.light).toMatchObject({ color: '#ff0000', intensity: 1000 });

  const viewport = page.locator('canvas.tl-viewport');
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => reddish(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeGreaterThan(300);
  // The editor rig ignores the scene's lights.
  await page.getByRole('button', { name: 'light: game' }).click();
  await expect(page.getByRole('button', { name: 'light: editor' })).toBeVisible();
  await expect.poll(async () => reddish(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeLessThan(100);
  await page.getByRole('button', { name: 'light: editor' }).click();

  // Light layers: layer 2 named in Project Settings labels the masks' checkboxes in the Inspector.
  await openProjectSettings(page, 'Light layers');
  const layer2 = settingsWindow(page).getByLabel('Layer 2 name', { exact: true });
  await layer2.fill('characters');
  await layer2.press('Enter');
  await expect.poll(async () => (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['lightLayers']).toEqual(['', 'characters']);
  await closeProjectSettings(page);
  const stored = async (id: string, component: string, key: string): Promise<unknown> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } }))['entity'] as { components: Record<string, Record<string, unknown>> }).components[component]![key];
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await expect(inspector(page).getByLabel('light lightMask characters', { exact: true })).toBeChecked();
  // A click is one command; the checkbox shows the stored mask once it is applied.
  await inspector(page).getByLabel('light lightMask Layer 1', { exact: true }).click();
  await expect.poll(() => stored(lightId, 'light', 'lightMask')).toBe(254);
  // The box leaves every layer but "characters" (its last layer cannot be unchecked), then joins them all again: stored as absent.
  const boxId = box.find((e) => e.components.box !== undefined)!.id;
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${boxId}"]`).click();
  const boxLayer = (bit: number) => inspector(page).getByLabel(`box lightLayers ${bit === 1 ? 'characters' : `Layer ${bit + 1}`}`, { exact: true });
  for (const bit of [0, 2, 3, 4, 5, 6, 7]) {
    await boxLayer(bit).click();
    await expect(boxLayer(bit)).not.toBeChecked();
  }
  await expect.poll(() => stored(boxId, 'box', 'lightLayers')).toBe(2);
  await expect(boxLayer(1)).toBeDisabled();
  for (const bit of [0, 2, 3, 4, 5, 6, 7]) {
    await boxLayer(bit).click();
    await expect(boxLayer(bit)).toBeChecked();
  }
  await expect.poll(() => stored(boxId, 'box', 'lightLayers')).toBeUndefined();

  // Local lights: the box set to none loses the red light in the Scene view (the ground around it stays red); cleared
  // (— : per pixel), it is red again.
  const redNow = async (): Promise<number> => reddish(decodePng(await viewport.screenshot()));
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  const litBox = await redNow();
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${boxId}"]`).click();
  await inspector(page).getByLabel('box localLights', { exact: true }).selectOption('none');
  await expect.poll(() => stored(boxId, 'box', 'localLights')).toBe('none');
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  await expect.poll(redNow, { timeout: 20_000 }).toBeLessThan(litBox - 500);
  console.log(`[lights] reddish samples: box lit ${litBox}, box without local lights ${await redNow()}`);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${boxId}"]`).click();
  // Local lights reach an object per pixel or not at all (as its material says when unset).
  const modes = await inspector(page).getByLabel('box localLights', { exact: true }).locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(modes).toEqual(['', 'pixel', 'none']);
  await inspector(page).getByLabel('box localLights', { exact: true }).selectOption('');
  await expect.poll(() => stored(boxId, 'box', 'localLights')).toBeUndefined();
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  await expect.poll(redNow, { timeout: 20_000 }).toBeGreaterThan(litBox - 200);
  // A light has no importance to choose (every local light is shaded per pixel).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await expect(inspector(page).getByLabel('light color', { exact: true })).toBeVisible();
  await expect(inspector(page).getByLabel('light importance', { exact: true })).toHaveCount(0);

  // Play shows the same light.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => reddish(decodePng(await frame.screenshot())), { timeout: 20_000 }).toBeGreaterThan(200);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();
  await showView(page, 'Scene');

  // The light clusters' heat map (View menu), on this renderer and (once, from the auto pass) on WebGL 2: every lit
  // pixel in the colour of how many local lights its cell lists. With the light's reach cut to 2.5 m, the pixels it
  // reddens all list it (blue, one light) and the ground out of its reach lists none (black); its red tint is gone.
  const lightNow = ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: Record<string, unknown> } }).components.light;
  const r = await be.command({ op: 'setComponent', projectId: be.projectId, expectedRevision: (await be.command({ op: 'queryProject', projectId: be.projectId }))['revision'], requestId: `req-${randomBytes(16).toString('hex')}`, args: { entityId: lightId, component: 'light', value: { ...lightNow, range: 2.5 } } });
  expect(r['ok'], JSON.stringify(r)).toBe(true);
  for (const pass of variant === 'auto' ? (['auto', 'webgl2'] as const) : ([variant] as const)) {
    if (pass === 'webgl2') {
      await page.goto(editorUrlFor(be.editorUrl, 'webgl2'));
      await expect(page.locator('.tl-statusbar')).toContainText('connected');
      await expectRendererBackend(viewport, 'webgl2');
    }
    await viewport.click({ position: { x: 5, y: 5 } });
    await expect.poll(redNow, { timeout: 20_000 }).toBeGreaterThan(300);
    const tinted = decodePng(await viewport.screenshot());
    await menu(page, 'View', 'Light clusters: off');
    const ones = (img: Image): number => {
      let n = 0;
      for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (isOneLight(img.pixel(x, y))) n += 1;
      return n;
    };
    await expect.poll(async () => ones(decodePng(await viewport.screenshot())), { timeout: 30_000 }).toBeGreaterThan(300);
    const heat = decodePng(await viewport.screenshot());
    let red = 0;
    let redListed = 0;
    let dark = 0;
    for (let y = 0; y < heat.height; y += 2) for (let x = 0; x < heat.width; x += 2) {
      const h = heat.pixel(x, y);
      if (h[0]! + h[1]! + h[2]! < 30) dark += 1;
      if (!isReddish(tinted.pixel(x, y))) continue;
      red += 1;
      if (isOneLight(h)) redListed += 1;
    }
    console.log(`[lights] heat map (${pass}): ${redListed} of ${red} reddened samples list the light; ${ones(heat)} listed, ${dark} dark; red left ${reddish(heat)}`);
    expect(redListed).toBeGreaterThan(red * 0.95);
    expect(dark).toBeGreaterThan(ones(heat) * 0.2);
    expect(reddish(heat)).toBeLessThan(50);
    await menu(page, 'View', 'Light clusters: on');
    await expect.poll(redNow, { timeout: 20_000 }).toBeGreaterThan(300);
  }
});

/** Separate runs of bright pixels along row y (at least `minRun` long: the gizmo lines and icons are shorter). */
function brightRuns(img: Image, y: number, minRun = 12): number {
  let n = 0;
  let len = 0;
  for (let x = 0; x <= img.width; x += 1) {
    const on = x < img.width && (([r, g, b]) => r + g + b > 300)(img.pixel(x, y));
    if (on) len += 1;
    else {
      if (len >= minRun) n += 1;
      len = 0;
    }
  }
  return n;
}
function mostBrightRuns(img: Image): number {
  let best = 0;
  for (let y = 0; y < img.height; y += 1) best = Math.max(best, brightRuns(img, y));
  return best;
}

/**
 * A spot light's cookie (three's SpotLight.map) is set in the
 * Inspector (a texture field on spot lights only) and shows in the Scene
 * view: the spot's patch on a dark floor is one bright disc before and
 * striped after. Play draws it too (scene-lights.e2e.ts checks its pixels).
 */
for (const variant of PRODUCT_RENDERER_VARIANTS) test(`a spot light's cookie is set in the Inspector and shows in the Scene view (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(120_000);
  await publishBytes(be, makePng(64, 64, (x) => (Math.floor(x / 8) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 'texture', 'tex-stripes');
  // A cookie no flip leaves alike: its lower right quarter dark, stripes across its left half.
  await publishBytes(be, makePng(64, 64, (x, y) => ((x >= 32 && y >= 32) || (x < 32 && Math.floor(y / 8) % 2 === 1) ? [0, 0, 0, 255] : [255, 255, 255, 255])), 'texture', 'tex-cookie');
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await menu(page, 'GameObject', 'Box');
  await menu(page, 'GameObject', 'Light', 'Spot light');
  const lightRow = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(lightRow).toContainText('Spot light');
  const lightId = (await lightRow.getAttribute('data-entity-id'))!;
  // Directional lights have no cookie field; spot lights do.
  const cookie = page.locator('.tl-inspector').getByLabel('light cookie', { exact: true });
  await expect(cookie).toBeVisible();

  // A dark floor under the spot, the spot 4 m above it pointing down (the default direction).
  const entities = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['entities'] as { id: string; components: { box?: object; transform: { position: number[] } } }[];
  const box = entities.find((e) => e.components.box !== undefined)!;
  const at = box.components.transform.position;
  const send = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const q = await be.command({ op: 'queryProject', projectId: be.projectId });
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${randomBytes(16).toString('hex')}`, args });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
  };
  await send('setComponent', { entityId: box.id, component: 'box', value: { size: [12, 0.2, 12], material: { color: '#202020' } } });
  await send('setTransform', { entityId: lightId, transform: { position: [at[0]!, at[1]! + 4, at[2]!] } });
  await send('setComponent', { entityId: lightId, component: 'light', value: { type: 'spot', color: '#ffffff', intensity: 1000, range: 0, decay: 2, angle: 30, penumbra: 0, direction: [0, -1, 0] } });

  const viewport = page.locator('canvas.tl-viewport');
  // Only the lit floor is measured: no light icons or cone outlines over it.
  await menu(page, 'Gizmos', 'Icons: on');
  await menu(page, 'Gizmos', 'Light ranges: on');
  await viewport.click({ position: { x: 5, y: 5 } }); // nothing selected: no transform gizmo either
  await expect.poll(async () => mostBrightRuns(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const plain = mostBrightRuns(decodePng(await viewport.screenshot()));
  expect(plain).toBe(1); // one disc

  // The cookie, picked in the Inspector.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await cookie.selectOption({ label: 'tex-stripes' });
  const stored = async (): Promise<unknown> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: { cookie?: string } } }).components.light.cookie;
  await expect.poll(stored).toBe('tex-stripes');
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => mostBrightRuns(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  console.log(`scene view bright runs (${variant}): plain ${plain}, cookie ${mostBrightRuns(decodePng(await viewport.screenshot()))}`);

  // Cleared again in the Inspector: one disc.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await cookie.selectOption({ label: 'none' });
  await expect.poll(stored).toBeUndefined();
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => mostBrightRuns(decodePng(await viewport.screenshot())), { timeout: 20_000 }).toBe(plain);

  // Turned into an area light in the Inspector: the cone fields go, the panel's shape, size and sides come,
  // and a new width reaches the project.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lightId}"]`).click();
  await page.locator('.tl-inspector').getByLabel('light type', { exact: true }).selectOption('area');
  const light = async (): Promise<Record<string, unknown>> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: Record<string, unknown> } }).components.light;
  await expect.poll(async () => (await light())['type']).toBe('area');
  for (const key of ['shape', 'width', 'height', 'twoSided']) await expect(page.locator('.tl-inspector').getByLabel(`light ${key}`, { exact: true })).toBeVisible();
  await expect(cookie).toHaveCount(0);
  const width = page.locator('.tl-inspector').getByLabel('light width', { exact: true });
  await width.fill('2.5');
  await width.press('Enter');
  await expect.poll(light).toMatchObject({ type: 'area', shape: 'rect', width: 2.5, height: 0.5, twoSided: false });
  await expect(page.locator('.tl-notice')).toHaveCount(0);

  // Many lamps, drawn by the light clusters, on this renderer and (once, from the auto pass) on WebGL 2.
  await send('deleteEntity', { entityId: lightId });
  for (const pass of variant === 'auto' ? (['auto', 'webgl2'] as const) : ([variant] as const)) await lampRoom(page, pass, send, box.id, pass === 'auto' || pass === variant);
});

/** Dark blobs: 4-connected runs of samples (every other pixel) where `a` is darker than `b` by more than `delta` (luminance), at least `minArea` samples, largest last. */
function darkBlobs(a: Image, b: Image, delta = 12, minArea = 4): { area: number; x: number; y: number; mean: number; cells: Set<number> }[] {
  const w = Math.floor(a.width / 2);
  const h = Math.floor(a.height / 2);
  const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
  const dark = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) dark[i] = lum(b.pixel((i % w) * 2, Math.floor(i / w) * 2)) - lum(a.pixel((i % w) * 2, Math.floor(i / w) * 2));
  const seen = new Uint8Array(w * h);
  const out: { area: number; x: number; y: number; mean: number; cells: Set<number> }[] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (seen[i] === 1 || dark[i]! <= delta) continue;
    const stack = [i];
    seen[i] = 1;
    const cells = new Set<number>();
    let xs = 0;
    let ys = 0;
    let sum = 0;
    while (stack.length > 0) {
      const j = stack.pop()!;
      cells.add(j);
      xs += (j % w) * 2;
      ys += Math.floor(j / w) * 2;
      sum += dark[j]!;
      const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] === 1 || dark[k]! <= delta) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (cells.size >= minArea) out.push({ area: cells.size, x: xs / cells.size, y: ys / cells.size, mean: sum / cells.size, cells });
  }
  return out.sort((p, q) => p.area - q.area);
}

/** Samples where `a` is darker than `b` by more than `delta` and that are not within `pad` samples of `mask`'s cells (sample indices on the 2-pixel grid). */
function darkOutside(a: Image, b: Image, mask: ReadonlySet<number>, delta = 12, pad = 2): number {
  const w = Math.floor(a.width / 2);
  const h = Math.floor(a.height / 2);
  const near = new Uint8Array(w * h);
  for (const c of mask) {
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (let dy = -pad; dy <= pad; dy += 1) for (let dx = -pad; dx <= pad; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && y >= 0 && x < w && y < h) near[x + y * w] = 1;
    }
  }
  const lum = (p: readonly number[]): number => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
  let n = 0;
  for (let i = 0; i < w * h; i += 1) if (near[i] === 0 && lum(b.pixel((i % w) * 2, Math.floor(i / w) * 2)) - lum(a.pixel((i % w) * 2, Math.floor(i / w) * 2)) > delta) n += 1;
  return n;
}

type Blob = ReturnType<typeof darkBlobs>[number];

/**
 * Today's shadows (three's own map per light, before the shadow atlas: a spot's 1,024², a point light's 512² cube;
 * measured on the Iris Xe host with this step, the spots' at a63ac2c1 twice, the point light's at ea6c5891): the
 * cubes' shadow blobs (samples on the 2-pixel grid darker by > 12) and their mean darkening, per renderer (the
 * WebGL 2 page frames the room from farther). The atlas's must match within {@link SHADOW_MATCH} of the area and
 * the darkening.
 */
const TODAY_SHADOWS: Record<'webgpu' | 'webgl2', Record<'far' | 'near' | 'point', { area: number; mean: number }>> = {
  webgpu: { far: { area: 765, mean: 175.0 }, near: { area: 2552, mean: 180.0 }, point: { area: 854, mean: 114.8 } },
  webgl2: { far: { area: 121, mean: 175.5 }, near: { area: 169, mean: 176.7 }, point: { area: 155, mean: 114.0 } },
};
/** Shadowed lights holding an atlas tile in the shadows' view: the two spots and the point light. */
const ATLAS_LIGHTS = 3;
/**
 * Today's cookie (three's `SpotLight.map` on its own light node; measured at ea6c5891): the samples the cookie's
 * dark parts darken in the near spot's patch, their mean darkening and their middle (pixels), per renderer. three's
 * two backends projected the image mirrored from each other (WebGL 2's middle was 681.0, 354.6); the cookie atlas
 * draws WebGPU's on both, so WebGL 2's middle is the atlas's own (looked at: the WebGPU orientation).
 */
const TODAY_COOKIE: Record<'webgpu' | 'webgl2', { area: number; mean: number; x: number; y: number }> = {
  webgpu: { area: 17836, mean: 137.0, x: 684.1, y: 538.8 },
  webgl2: { area: 801, mean: 126.5, x: 661.2, y: 366.0 },
};
/** How far the cookie's middle may be from today's (pixels; a flip moves it by about a quarter of the patch). */
const COOKIE_MIDDLE_PX = 4;

/** The samples `a` is darker than `b` (by > 12) in all: their count, mean darkening and middle. */
function cookieDark(a: Image, b: Image): { area: number; mean: number; x: number; y: number } {
  const blobs = darkBlobs(a, b, 12, 1);
  const area = blobs.reduce((n, p) => n + p.area, 0);
  const sum = (f: (p: Blob) => number): number => blobs.reduce((n, p) => n + f(p) * p.area, 0) / Math.max(1, area);
  return { area, mean: sum((p) => p.mean), x: sum((p) => p.x), y: sum((p) => p.y) };
}
/** Wheel notches the spot-shadow view comes closer by from the whole room. */
const VIEW_NOTCHES = 36;
/** The tolerance against today's shadows: a share of the area and of the mean darkening. */
const SHADOW_MATCH = 0.2;

/**
 * Shadows and a cookie through the shared atlases, in the Scene view: two of the room's spot lamps and a point
 * lamp (six faces) cast the shadows of small cubes floating beside them. Their shadows match today's (three's own
 * map per light) within a stated tolerance; a cube moved by an edit moves its shadow (the tile is drawn again).
 * A cookie on a spot draws today's pattern, unflipped (from the light tables' texture). With a quality level whose atlas
 * is 512 texels, one spot takes it whole and the other lights its patch unshadowed; raising that one's range
 * outranks the first, which gives its tile away: no frame on the way shows a shadow where no cube casts one, and
 * then the other spot's shadow is the one drawn.
 */
async function spotShadows(page: Page, pass: 'auto' | 'webgl2' | 'webgpu', send: (op: string, args: Record<string, unknown>) => Promise<void>, idOf: (name: string) => string, build: boolean): Promise<void> {
  const viewport = page.locator('canvas.tl-viewport');
  const backend = pass === 'webgl2' ? 'webgl2' : 'webgpu';
  const shot = async (): Promise<Image> => decodePng(await viewport.screenshot());
  const settled = async (label: string): Promise<Image> => {
    let last = '';
    await expect.poll(async () => {
      const png = (await viewport.screenshot()).toString('base64');
      const same = png === last;
      last = png;
      return same;
    }, { timeout: 30_000, intervals: [500] }).toBe(true);
    const out = test.info().outputPath();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `spot-${label}-${pass}.png`), Buffer.from(last, 'base64'));
    return decodePng(Buffer.from(last, 'base64'));
  };
  // The spot lamps 2 (far, z −2.4) and 8 (near, z −0.8), and a 25 cm cube 0.2 m beside each axis (toward the view), 0.3 m over the floor.
  const lamps = [{ name: 'far', i: 2, x: -1, z: -2.4 }, { name: 'near', i: 8, x: -1, z: -0.8 }] as const;
  const lampLight = (i: number, x: number, z: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...(patchLamp(`lamp-${i}`, x, z, i, true)['components'] as { light: Record<string, unknown> }).light, ...extra });
  for (const l of lamps) await send('setComponent', { entityId: idOf(`Lamp lamp-${l.i}`), component: 'light', value: lampLight(l.i, l.x, l.z) });
  // The point lamp 6 brought to their left, between them (0.8 m over the floor, 1.2 m reach, its patch clear of the
  // spots'), a cube 0.2 m on its right.
  const point = { name: 'point', i: 6, x: -2.6, z: -1.6, y: 0.8 } as const;
  const pointLight = (castShadow: boolean): Record<string, unknown> => ({ ...lampLight(point.i, point.x, point.z), range: 1.2, castShadow });
  await send('setTransform', { entityId: idOf(`Lamp lamp-${point.i}`), transform: { position: [point.x, point.y, point.z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  await send('setComponent', { entityId: idOf(`Lamp lamp-${point.i}`), component: 'light', value: pointLight(true) });
  const casters = [...lamps.map((l) => ({ name: l.name, at: [l.x - 0.2, 0.3, l.z] })), { name: point.name, at: [point.x + 0.2, 0.3, point.z] }];
  const cube = (castShadow: boolean): Record<string, unknown> => ({ size: [0.25, 0.25, 0.25], material: { color: '#808080' }, castShadow });
  if (build) {
    await send('pasteEntities', { sceneId: 'scene-main', entities: casters.map((c) => ({ id: `caster-${c.name}`, name: `Caster ${c.name}`, static: false, components: { transform: { position: c.at, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: cube(true) } })) });
  }
  const all = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as { id: string; name: string }[];
  const caster = (name: string): string => all.find((e) => e.name === `Caster ${name}`)!.id;
  // (The first pass makes the cubes casting; a later one finds them where the last left them: out of sight, not casting.)
  let cast = build;
  const casting = async (on: boolean): Promise<void> => {
    if (cast === on) return;
    cast = on;
    for (const c of casters) await send('setComponent', { entityId: caster(c.name), component: 'box', value: cube(on) });
  };
  if (!build) for (const c of casters) await send('setTransform', { entityId: caster(c.name), transform: { position: c.at, rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  // The three shadows of a pair of pictures: the two spots' (the far one higher in the picture) and the point's (leftmost).
  const shadowsOf = (a: Image, b: Image): { far: Blob; near: Blob; point: Blob } | null => {
    const top = darkBlobs(a, b).slice(-3);
    if (top.length < 3) return null;
    const byX = [...top].sort((p, q) => p.x - q.x);
    const [far, near] = byX.slice(1).sort((p, q) => p.y - q.y);
    return { far: far!, near: near!, point: byX[0]! };
  };
  const atlas = async (): Promise<string[]> => ((await viewport.getAttribute('data-tl-shadow-atlas')) ?? '').split('|');
  // The same view on each renderer: a new page frames the whole room, then the view orbits the near cube (F) and
  // comes closer (the wheel: 5 % a notch), the two spots' patches large in it.
  await page.goto(editorUrlFor(be.editorUrl, pass));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(viewport, pass);
  // (Gizmos off: a page keeps what the last one set.)
  for (const item of ['Icons: on', 'Light ranges: on']) {
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Gizmos', exact: true }).click();
    const on = page.getByRole('menu').getByRole('menuitem', { name: item, exact: true });
    if ((await on.count()) > 0) await on.click();
    else await page.keyboard.press('Escape');
  }
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Caster near' }).click();
  await viewport.hover();
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  for (let n = 0; n < VIEW_NOTCHES; n += 1) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(20);
  }
  await page.keyboard.press('Escape');
  // The two spots and the point light hold tiles (none waiting).
  await casting(true);
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await atlas()).slice(1, 3).join('|'), { timeout: 30_000 }).toBe(`${ATLAS_LIGHTS}|0`);
  const on = await settled('on');
  await casting(false);
  const off = await settled('off');
  const found = shadowsOf(on, off);
  const today = TODAY_SHADOWS[backend];
  const line = (b: Blob | undefined): string => `${b?.area} samples, mean ${b?.mean.toFixed(1)} at ${b?.x.toFixed(0)},${b?.y.toFixed(0)}`;
  console.log(`[lights] shadows (${pass}): far ${line(found?.far)}; near ${line(found?.near)}; point ${line(found?.point)} (today: ${JSON.stringify(today)})`);
  expect(found).not.toBeNull();
  const blobs = [found!.far, found!.near];
  for (const k of ['far', 'near', 'point'] as const) {
    const b = found![k];
    expect(Math.abs(b.area - today[k].area), `${k} shadow area vs today's`).toBeLessThanOrEqual(today[k].area * SHADOW_MATCH);
    expect(Math.abs(b.mean - today[k].mean), `${k} shadow darkening vs today's`).toBeLessThanOrEqual(today[k].mean * SHADOW_MATCH);
  }
  // The far cube moved by an edit: its shadow follows (its tile drawn again), the near one stays.
  const far = lamps[0];
  await casting(true);
  await send('setTransform', { entityId: caster('far'), transform: { position: [far.x - 0.2, 0.3, far.z + 0.15], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  await viewport.click({ position: { x: 5, y: 5 } });
  const movedOn = await settled('moved-on');
  await casting(false);
  const movedOff = await settled('moved-off');
  const movedFound = shadowsOf(movedOn, movedOff);
  const moved = movedFound === null ? [] : [movedFound.far, movedFound.near];
  console.log(`[lights] moved cube (${pass}): far shadow ${blobs[0]!.x.toFixed(0)},${blobs[0]!.y.toFixed(0)} → ${moved[0]?.x.toFixed(0)},${moved[0]?.y.toFixed(0)}; near ${blobs[1]!.x.toFixed(0)},${blobs[1]!.y.toFixed(0)} → ${moved[1]?.x.toFixed(0)},${moved[1]?.y.toFixed(0)}`);
  expect(moved.length).toBe(2);
  expect(Math.hypot(moved[0]!.x - blobs[0]!.x, moved[0]!.y - blobs[0]!.y)).toBeGreaterThan(2);
  expect(Math.hypot(moved[1]!.x - blobs[1]!.x, moved[1]!.y - blobs[1]!.y)).toBeLessThan(1.5);
  // A cookie on the near spot (unshadowed now): the pattern its dark parts cast on the patch matches today's (their
  // samples, darkening and middle: a flip in either axis moves the middle).
  const near = lamps[1];
  await send('setComponent', { entityId: idOf(`Lamp lamp-${near.i}`), component: 'light', value: lampLight(near.i, near.x, near.z, { castShadow: false, cookie: 'tex-cookie' }) });
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => darkBlobs(await shot(), movedOff, 12, 1).reduce((n, b) => n + b.area, 0), { timeout: 30_000 }).toBeGreaterThan(50);
  const cookie = cookieDark(await settled('cookie'), movedOff);
  const todayCookie = TODAY_COOKIE[backend];
  console.log(`[lights] cookie (${pass}): ${cookie.area} samples, mean ${cookie.mean.toFixed(1)}, middle ${cookie.x.toFixed(1)},${cookie.y.toFixed(1)} (today: ${JSON.stringify(todayCookie)})`);
  expect(Math.abs(cookie.area - todayCookie.area), 'cookie samples vs today').toBeLessThanOrEqual(todayCookie.area * SHADOW_MATCH);
  expect(Math.abs(cookie.mean - todayCookie.mean), 'cookie darkening vs today').toBeLessThanOrEqual(todayCookie.mean * SHADOW_MATCH);
  expect(Math.hypot(cookie.x - todayCookie.x, cookie.y - todayCookie.y), 'cookie middle vs today').toBeLessThanOrEqual(COOKIE_MIDDLE_PX);
  // (A component write merges its fields: `null` takes the cookie away.)
  await send('setComponent', { entityId: idOf(`Lamp lamp-${near.i}`), component: 'light', value: lampLight(near.i, near.x, near.z, { cookie: null }) });
  await send('setTransform', { entityId: caster('far'), transform: { position: [far.x - 0.2, 0.3, far.z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  // The 512 atlas below is the two spots' alone.
  await send('setComponent', { entityId: idOf(`Lamp lamp-${point.i}`), component: 'light', value: pointLight(false) });

  // A 512-texel atlas: one spot takes it whole, the other lights its patch unshadowed (the level draws its own look:
  // its pictures are compared with each other).
  const before = (JSON.parse(readFileSync(join(be.projectDir, 'content.json'), 'utf8')) as { content: { environment?: Record<string, unknown> } }).content.environment ?? {};
  // An 8 m reach first: large enough on screen, from either page's view, to ask for the whole atlas once it is
  // 512 texels (a light already holding a smaller tile there keeps it while nothing larger is free).
  for (const l of lamps) await send('setComponent', { entityId: idOf(`Lamp lamp-${l.i}`), component: 'light', value: lampLight(l.i, l.x, l.z, { range: 8 }) });
  await send('setEnvironment', { environment: { ...before, qualityLevels: [{ id: 'tight', shadowAtlas: 512 }], quality: 'tight' } });
  await viewport.click({ position: { x: 5, y: 5 } });
  const tightOff = await settled('512-off');
  await casting(true);
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await atlas()).slice(0, 3).join('|'), { timeout: 30_000 }).toBe('512|1|1');
  const tightOn = await settled('512');
  const big = Math.min(blobs[0]!.area, blobs[1]!.area) / 3;
  const tight = darkBlobs(tightOn, tightOff).filter((b) => b.area >= big);
  console.log(`[lights] 512 atlas (${pass}): ${tight.length} shadow(s) at ${tight.map((b) => `${b.x.toFixed(0)},${b.y.toFixed(0)} (${b.area})`).join('; ')}`);
  expect(tight.length).toBe(1);
  const keptFar = Math.abs(tight[0]!.y - blobs[0]!.y) < Math.abs(tight[0]!.y - blobs[1]!.y);
  const kept = tight[0]!;
  // The other spot lights its patch as without the cube's shadow: nothing darker there but the kept shadow.
  expect(darkOutside(tightOn, tightOff, kept.cells)).toBeLessThan(20);
  // The unshadowed one's reach made four times the other's: it outranks it from any view, and the other gives its tile away. On the way, the kept
  // light's patch (round its shadow) never shows a shadow other than its own cube's.
  const swap = keptFar ? lamps[1] : lamps[0];
  await send('setComponent', { entityId: idOf(`Lamp lamp-${swap.i}`), component: 'light', value: lampLight(swap.i, swap.x, swap.z, { range: 32 }) });
  await viewport.click({ position: { x: 5, y: 5 } });
  const frames: Image[] = [];
  for (let f = 0; f < 8; f += 1) frames.push(await shot());
  const swapped = await settled('swapped');
  await casting(false);
  const swappedOff = await settled('swapped-off');
  const w = Math.floor(swapped.width / 2);
  const reach = 2 * Math.sqrt(kept.area / Math.PI);
  const patch = (c: number): boolean => Math.hypot((c % w) - kept.x / 2, Math.floor(c / w) - kept.y / 2) <= reach;
  const wrong = frames.map((f) => darkBlobs(f, swappedOff, 12, 1).reduce((n, b) => n + [...b.cells].filter((c) => patch(c) && !kept.cells.has(c)).length, 0));
  const after = darkBlobs(swapped, swappedOff).filter((b) => b.area >= big);
  console.log(`[lights] rank swap (${pass}): samples darkened in the kept light's patch outside its shadow, per frame ${wrong.join(', ')}; after: ${after.map((b) => `${b.x.toFixed(0)},${b.y.toFixed(0)} (${b.area})`).join('; ')}`);
  for (const n of wrong) expect(n).toBeLessThan(20);
  expect(after.length).toBe(1);
  const nowFar = Math.abs(after[0]!.y - blobs[0]!.y) < Math.abs(after[0]!.y - blobs[1]!.y);
  expect(nowFar).toBe(!keptFar);
  // Back: the project's levels, the lamps as they were, no casters.
  await send('setEnvironment', { environment: before });
  for (const l of [...lamps, { i: point.i, x: -5, z: -0.8 }]) await send('setComponent', { entityId: idOf(`Lamp lamp-${l.i}`), component: 'light', value: (patchLamp(`lamp-${l.i}`, l.x, l.z, l.i)['components'] as { light: Record<string, unknown> }).light });
  await send('setTransform', { entityId: idOf(`Lamp lamp-${point.i}`), transform: (patchLamp(`lamp-${point.i}`, -5, -0.8, point.i)['components'] as { transform: Record<string, unknown> }).transform });
  for (const c of casters) await send('setTransform', { entityId: caster(c.name), transform: { position: [c.at[0]!, -5, c.at[2]!], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
}

/** Bright samples (every other pixel): r + g + b over `floor`. */
const brightAt = (img: Image, x: number, y: number, floor: number): boolean => (([r, g, b]) => r + g + b > floor)(img.pixel(x, y));

/** The bright patches of a picture (4-connected runs of bright samples on a 2-pixel grid, at least `minArea` samples), largest last. */
function patches(img: Image, floor: number, minArea = 6): { area: number; peak: number; x: number; y: number }[] {
  const w = Math.floor(img.width / 2);
  const h = Math.floor(img.height / 2);
  const seen = new Uint8Array(w * h);
  const out: { area: number; peak: number; x: number; y: number }[] = [];
  for (let i = 0; i < w * h; i += 1) {
    if (seen[i] === 1 || !brightAt(img, (i % w) * 2, Math.floor(i / w) * 2, floor)) continue;
    const stack = [i];
    seen[i] = 1;
    const sums: number[] = [];
    let xs = 0;
    let ys = 0;
    while (stack.length > 0) {
      const j = stack.pop()!;
      xs += (j % w) * 2;
      ys += Math.floor(j / w) * 2;
      const [r, g, b] = img.pixel((j % w) * 2, Math.floor(j / w) * 2);
      sums.push(r! + g! + b!);
      const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] === 1 || !brightAt(img, (k % w) * 2, Math.floor(k / w) * 2, floor)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    // The patch's brightness: the mean of its brightest tenth (its middle).
    sums.sort((a, b) => b - a);
    const top = sums.slice(0, Math.max(1, Math.round(sums.length / 10)));
    if (sums.length >= minArea) out.push({ area: sums.length, peak: top.reduce((a, b) => a + b, 0) / top.length, x: xs / sums.length, y: ys / sums.length });
  }
  return out.sort((a, b) => a.area - b.area);
}

/** Mean absolute difference (0–255, over r, g, b) and the share of pixels any channel of which differs by more than `bad`. */
function pictureDiff(a: Image, b: Image, bad = 16): { mean: number; bad: number } {
  let sum = 0;
  let off = 0;
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    const d = [Math.abs(p[0]! - q[0]!), Math.abs(p[1]! - q[1]!), Math.abs(p[2]! - q[2]!)];
    sum += d[0]! + d[1]! + d[2]!;
    if (Math.max(...d) > bad) off += 1;
  }
  const n = a.width * a.height;
  return { mean: sum / (3 * n), bad: off / n };
}

/** Lamps of one kind of patch: a point light (windowed, or without a range) or a spot shining down. */
function patchLamp(id: string, x: number, z: number, i: number, castShadow = false): Record<string, unknown> {
  const light =
    i % 3 === 2
      ? { type: 'spot', color: '#ffe0c0', intensity: 40, range: 1.1, decay: 2, angle: 40, penumbra: 0.3, direction: [0, -1, 0], castShadow }
      : { type: 'point', color: i % 3 === 0 ? '#c0e0ff' : '#ffffff', intensity: i % 3 === 0 ? 25 : 4, range: i % 3 === 0 ? 0.8 : 0, decay: i % 3 === 0 ? 2 : 2.5, castShadow };
  return { id, name: `Lamp ${id}`, components: { transform: { position: [x, i % 3 === 2 ? 0.7 : 0.55, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, light } };
}

/**
 * A room of lamps on a dark floor (the floor casts no shadow). In the Scene view (one scene): twelve lamps each
 * light their own patch, and six of them casting shadows nothing is there to cast (atlas tiles, a point light's
 * six faces) look as they did unshadowed, within a stated tolerance. In Play, five scenes loaded at once:
 * 24 lamps light 24 patches (more than the 16 a scene holds), and the middle of a ring of 20 lamps, every one
 * reaching it, is brighter than that of a ring of 16 (more than 16 lights reach a pixel). Two rings of area lights
 * (rectangles facing down) at the floor's far left and right light it too, though it moves: the middle of the
 * ring of six is brighter than that of the ring of four (more than four area lights reach a pixel).
 */
async function lampRoom(page: Page, pass: 'auto' | 'webgl2' | 'webgpu', send: (op: string, args: Record<string, unknown>) => Promise<void>, floorId: string, build: boolean): Promise<void> {
  const viewport = page.locator('canvas.tl-viewport');
  // The grid: 6 × 4 lamps 2 m apart; the even ones in the main scene, the odd ones in the second.
  const grid = Array.from({ length: 24 }, (_, i) => ({ x: -5 + 2 * (i % 6), z: -2.4 + 1.6 * Math.floor(i / 6), i }));
  const main = grid.filter((g) => g.i % 2 === 0).map((g) => patchLamp(`lamp-${g.i}`, g.x, g.z, g.i));
  const ring = (prefix: string, n: number, cx: number): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, k) => ({ id: `${prefix}-${k}`, name: `${prefix} ${k}`, components: { transform: { position: [cx + 1.5 * Math.cos((2 * Math.PI * k) / n), 3, 8.5 + 1.5 * Math.sin((2 * Math.PI * k) / n)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { type: 'point', color: '#ffffff', intensity: 15, range: 5, decay: 2 } } }));
  // Area lights 1 m round a middle, 1.5 m over the floor, facing down (an area light shines along its local −Y).
  const areaRing = (prefix: string, n: number, cx: number): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, k) => ({ id: `${prefix}-${k}`, name: `${prefix} ${k}`, components: { transform: { position: [cx + Math.cos((2 * Math.PI * k) / n), 1.5, -3 + Math.sin((2 * Math.PI * k) / n)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { type: 'area', shape: 'rect', width: 0.4, height: 0.4, color: '#ffffff', intensity: 25, range: 3 } } }));
  if (build) {
    const all = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['entities'] as { id: string; components: { light?: Record<string, unknown> } }[];
    // A dim sun and ambient light: the lamps' patches stand out.
    for (const e of all) if (e.components.light !== undefined) await send('setComponent', { entityId: e.id, component: 'light', value: { ...e.components.light, intensity: 0.02 } });
    // The floor moves (not static): the lamps light it per pixel, not through the static surfaces' light.
    await send('deleteEntity', { entityId: floorId });
    const floor = { id: 'lamp-floor', name: 'Lamp floor', static: false, components: { transform: { position: [0, -0.1, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [22, 0.2, 24], material: { color: '#404040' }, castShadow: false } } };
    await send('pasteEntities', { sceneId: 'scene-main', entities: [floor, ...main] });
    // More scenes: the other twelve lamps, and the two rings (20 lamps round one middle, 16 round the other).
    await send('createScene', { sceneId: 'lamps-b', name: 'Lamps B' });
    await send('pasteEntities', { sceneId: 'lamps-b', entities: grid.filter((g) => g.i % 2 === 1).map((g) => patchLamp(`lamp-${g.i}`, g.x, g.z, g.i)) });
    // (A scene holds 16 point and spot lights: the ring of 20 is two scenes' halves.)
    const ring20 = ring('ring20', 20, -4.5);
    for (const [id, part] of [['ring-20a', ring20.slice(0, 10)], ['ring-20b', ring20.slice(10)], ['ring-16', ring('ring16', 16, 4.5)], ['area-6', areaRing('area6', 6, -8.5)], ['area-4', areaRing('area4', 4, 8.5)]] as const) {
      await send('createScene', { sceneId: id, name: id });
      await send('pasteEntities', { sceneId: id, entities: part });
    }
    await send('setStartScenes', { sceneIds: ['scene-main', 'lamps-b', 'ring-20a', 'ring-20b', 'ring-16', 'area-6', 'area-4'] });
    // Play looks straight down on the room.
    await send('setTransform', { entityId: 'cam-main', transform: { position: [0, 19, 3], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [1, 1, 1] } });
  } else {
    await page.goto(editorUrlFor(be.editorUrl, pass));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    await expectRendererBackend(viewport, pass);
    // A new page: its gizmos (drawn over the patches) off again.
    await menu(page, 'Gizmos', 'Icons: on');
    await menu(page, 'Gizmos', 'Light ranges: on');
  }
  // Scene view: the main scene's twelve lamps through the clusters (the canvas lists them), then six of them casting a
  // shadow (four point lights, six faces each, and two spots in the shadow atlas) where nothing casts one: the
  // picture stays the same (no acne, no light lost at a face's seam), and every lamp stays listed.
  const listed = async (): Promise<number> => Number((await viewport.getAttribute('data-tl-clusters'))?.split('|')[0] ?? -1);
  // (A paste gives the lamps ids of the project's own: found by name.)
  const pasted = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as { id: string; name: string }[];
  const idOf = (name: string): string => pasted.find((e) => e.name === name)!.id;
  const shadows = async (on: boolean, intensity?: number): Promise<void> => {
    for (const g of grid.filter((x) => x.i % 2 === 0).slice(0, 6)) {
      const light = (patchLamp(`lamp-${g.i}`, g.x, g.z, g.i, on)['components'] as { light: Record<string, unknown> }).light;
      await send('setComponent', { entityId: idOf(`Lamp lamp-${g.i}`), component: 'light', value: intensity === undefined ? light : { ...light, intensity } });
    }
  };
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(listed, { timeout: 30_000 }).toBe(12);
  const shot = async (): Promise<Image> => decodePng(await viewport.screenshot());
  await expect.poll(async () => patches(await shot(), 150).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(6);
  const clustered = await shot();
  await shadows(true);
  // The atlas holds the six (side|tiled|waiting|drawn|handed in); the WebGL 2 page frames the room from about 40 m,
  // where local shadows have faded out and hold no tile (`LOCAL_SHADOW_DISTANCE`).
  const atlasNow = async (): Promise<string[]> => ((await viewport.getAttribute('data-tl-shadow-atlas')) ?? '').split('|');
  await expect.poll(async () => (await atlasNow()).slice(2).join('|'), { timeout: 30_000 }).toBe('0|0|6');
  if (pass !== 'webgl2') expect((await atlasNow())[1]).toBe('6');
  expect(await listed()).toBe(12);
  // Tolerance: a mean of at most 1 level in 255 and at most 0.5 % of pixels off by more than 16 (the shadows darken
  // nothing; rounding and TAAU's frame-to-frame noise are what differs).
  let d = pictureDiff(clustered, await shot());
  await expect.poll(async () => ((d = pictureDiff(clustered, await shot())), d.mean <= 1 && d.bad <= 0.005), { timeout: 20_000 }).toBe(true);
  // The control: the six lamps dark are far off the picture (the comparison sees their light, however far the view).
  await shadows(false, 0);
  let dark = pictureDiff(clustered, await shot());
  const seen = (x: { mean: number; bad: number }): boolean => x.bad > 0.0005 && x.bad > 10 * d.bad && x.mean > 10 * d.mean;
  await expect.poll(async () => ((dark = pictureDiff(clustered, await shot())), seen(dark)), { timeout: 20_000 }).toBe(true);
  console.log(`[lights] six lamps shadowed, nothing casting (${pass}): mean ${d.mean.toFixed(3)}, ${(d.bad * 100).toFixed(3)} % off by > 16; six lamps dark: mean ${dark.mean.toFixed(3)}, ${(dark.bad * 100).toFixed(2)} %; ${patches(clustered, 150).length} patches`);
  await shadows(false);
  await expect.poll(async () => pictureDiff(clustered, await shot()).bad <= 0.005, { timeout: 20_000 }).toBe(true);
  await spotShadows(page, pass, send, idOf, build);

  // Play: seven scenes, 24 + 20 + 16 lamps and 6 + 4 area lights.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), pass);
  const playShot = async (): Promise<Image> => decodePng(await frame.screenshot());
  // (A higher floor than the Scene view's: Play's bloom joins the glow between neighbouring patches.)
  await expect.poll(async () => patches(await playShot(), 300).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(28);
  const picture = await playShot();
  const found = patches(picture, 300);
  // The area rings are the patches farthest out on each side; of the rest, the point rings are the largest on each
  // side: the left ones (20 lamps, 6 area lights) are the brighter, and none is clipped.
  const byX = [...found].sort((a, b) => a.x - b.x);
  const [area6, area4] = [byX[0]!, byX.at(-1)!];
  const largest = (left: boolean) => found.filter((p) => p !== area6 && p !== area4 && p.x < picture.width / 2 === left).at(-1)!;
  const [ring20, ring16] = [largest(true), largest(false)];
  console.log(`[lights] play (${pass}): ${found.length} patches; ring of 20: ${ring20.area} samples, peak ${ring20.peak.toFixed(0)}; ring of 16: ${ring16.area} samples, peak ${ring16.peak.toFixed(0)}; area 6: ${area6.area} samples, peak ${area6.peak.toFixed(0)} at ${area6.x.toFixed(0)},${area6.y.toFixed(0)}; area 4: ${area4.area} samples, peak ${area4.peak.toFixed(0)} at ${area4.x.toFixed(0)},${area4.y.toFixed(0)}`);
  expect(found.length).toBeGreaterThanOrEqual(28);
  expect(ring20.peak).toBeGreaterThan(1.05 * ring16.peak);
  expect(ring20.peak).toBeLessThan(700);
  expect(area6.peak).toBeGreaterThan(1.05 * area4.peak);
  expect(area6.peak).toBeLessThan(700);
  await page.getByTitle('Stop the play preview').click();
  await showView(page, 'Scene');
}
