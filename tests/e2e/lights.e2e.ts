/**
 * Point, spot and hemisphere lights. A red point light next to a
 * box tints it in the Scene view (game lighting) and in Play; the light is
 * edited in the Inspector (its light mask and the box's light layers as
 * checkboxes named in Project Settings, the box's local-light mode — per
 * pixel or none, which unlights it — as a select); the Scene view
 * toggles between the editor rig and the scene's own lights; the View
 * menu's light clusters heat map lists the light where it reaches. A room
 * of lamps drawn by the light clusters looks as three's own light nodes draw
 * it, and lights more than 16 lamps at once, on both renderers; area lights
 * light the moving floor too, more than four of them a pixel.
 *
 * Runs on the product's own renderer (renderer-variants.ts
 * PRODUCT_RENDERER_VARIANTS): scene-lights covers lights and cookies on both.
 */
import { randomBytes } from 'node:crypto';

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
 * light their own patch, and six of them drawn by three's own light nodes (casting shadows nothing is there to
 * cast) look as they do through the clusters, within a stated tolerance. In Play, five scenes loaded at once:
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
  // shadow, so three's own light nodes draw those six (the clusters list six).
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
  await expect.poll(listed, { timeout: 30_000 }).toBe(6);
  // Tolerance: a mean of at most 1 level in 255 and at most 0.5 % of pixels off by more than 16 (the paths compute the
  // same light; rounding and TAAU's frame-to-frame noise are what differs).
  let d = pictureDiff(clustered, await shot());
  await expect.poll(async () => ((d = pictureDiff(clustered, await shot())), d.mean <= 1 && d.bad <= 0.005), { timeout: 20_000 }).toBe(true);
  // The control: the six lamps dark are far off the picture (the comparison sees their light, however far the view).
  await shadows(false, 0);
  let dark = pictureDiff(clustered, await shot());
  const seen = (x: { mean: number; bad: number }): boolean => x.bad > 0.0005 && x.bad > 10 * d.bad && x.mean > 10 * d.mean;
  await expect.poll(async () => ((dark = pictureDiff(clustered, await shot())), seen(dark)), { timeout: 20_000 }).toBe(true);
  console.log(`[lights] clusters vs three's lights (${pass}): mean ${d.mean.toFixed(3)}, ${(d.bad * 100).toFixed(3)} % off by > 16; six lamps dark: mean ${dark.mean.toFixed(3)}, ${(dark.bad * 100).toFixed(2)} %; ${patches(clustered, 150).length} patches`);
  await shadows(false);
  await expect.poll(async () => pictureDiff(clustered, await shot()).bad <= 0.005, { timeout: 20_000 }).toBe(true);

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
