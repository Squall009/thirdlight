/**
 * Instance sets in a real browser against the real backend: the
 * scatter dialog publishes a buffer and creates one entity that draws many
 * copies of a model (editor viewport and Play), the buffer route refuses bad
 * buffers, and a set loaded with its scene is drawn in Play. Levels of
 * detail: a model's switch point and cull size set in its import settings
 * (the asset inspector) move where placed models and each instance copy
 * switch and stop being drawn, on both renderers, in Play and the export
 * (with the project's LOD bias); an instance set's density falloff is set in
 * the Inspector.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { exportedContent, publishBytes, serveDir, startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { chooseItem, menu } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  // (A renderer variant skipped in this project started none.)
  await (be as E2EBackend | undefined)?.stop();
  be = undefined as unknown as E2EBackend;
});

const status = (page: Page) => page.locator('.tl-statusbar');

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-instances' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** The Play preview's canvas (its renderer reports ready once it draws). */
const playCanvas = (page: Page) => page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();

test('the scatter dialog makes one entity that draws many copies; the buffer route refuses bad buffers; a set in a scene loaded during Play is drawn once the scene loads', async ({ page }) => {
  be = await startBackend('inst-e2e', 'starter');
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');

  await menu(page, 'GameObject', 'Instance set…');
  const dialog = page.getByRole('dialog', { name: 'Instance set' });
  await dialog.getByLabel('instance model').selectOption({ label: 'Pillar' });
  await dialog.getByLabel('Copies').fill('60');
  await dialog.getByLabel('Width (X, m)').fill('24');
  await dialog.getByLabel('Depth (Z, m)').fill('10');
  await dialog.getByRole('button', { name: 'Create instance set' }).click();
  await expect(dialog).toHaveCount(0);

  const row = page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Pillar ×60' });
  await expect(row).toHaveCount(1);
  const id = String(await row.getAttribute('data-entity-id'));
  const entity = (await query('queryEntity', { entityId: id })).entity as { components: { instances: { asset: { assetId: string }; buffer: string; count: number } } };
  expect(entity.components.instances.count).toBe(60);
  // The buffer is stored by its digest, 40 bytes per copy.
  const bytes = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/buffers/${entity.components.instances.buffer}`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(bytes.status).toBe(200);
  const buf = Buffer.from(await bytes.arrayBuffer());
  expect(buf.length).toBe(60 * 40);
  expect(createHash('sha256').update(buf).digest('hex')).toBe(entity.components.instances.buffer);
  await row.click();
  await expect(page.locator('[data-instances="60"]')).toContainText('60 copies');
  await page.screenshot({ path: 'test-results/instances-editor.png' });

  // Refused: a count that is not whole copies, a non-finite value, an unknown buffer.
  expect((await api('content/buffers', { transforms: [1, 2, 3] })).status).toBe(400);
  expect((await api('content/buffers', { transforms: [0, 0, 0, 0, 0, 0, 1, 1, 1, 'x'] })).status).toBe(400);
  const ghost = await be.command({
    op: 'setComponent',
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${'f'.repeat(32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-instances' },
    args: { entityId: id, component: 'instances', value: { buffer: 'a'.repeat(64), count: 60 } },
  });
  expect(ghost.ok).toBe(false);

  // A second set, in a scene that is not loaded at the start: a row of pillars along the start ground (x 2..14), published through the route MCP uses.
  const transforms: number[] = [];
  for (let i = 0; i < 25; i += 1) transforms.push(2 + i * 0.5, 0, -2 - (i % 3), 0, 0, 0, 1, 0.3, 0.3, 0.3);
  const published = await api('content/buffers', { transforms });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  expect(published.json.count).toBe(25);
  const assets = (await query('queryAssets', { limit: 50, offset: 0 })).assets as { assetId: string; displayName: string }[];
  const pillar = assets.find((a) => a.displayName === 'Pillar')!.assetId;
  await cmd('createScene', { sceneId: 'scene-grove', name: 'Grove' });
  await cmd('createEntity', { sceneId: 'scene-grove', kind: 'group', name: 'Grove', components: { instances: { asset: { assetId: pillar }, buffer: published.json.digest, count: 25 } } });

  // In Play the set is drawn too (the camera starts near the pillars).
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(playCanvas(page)).toHaveAttribute('data-tl-renderer-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/instances-play.png' });

  // The set in the scene loaded during Play is drawn once the scene loads.
  const observe = async () => (await api(`play/${psid}/observe`, {})).json as { state?: string; scenes?: { loaded: string[] } };
  await expect.poll(async () => (await observe()).state, { timeout: 15_000 }).toBe('running');
  await page.screenshot({ path: 'test-results/instances-before-load.png' });
  expect((await api(`play/${psid}/control`, { command: 'loadScene', sceneId: 'scene-grove' })).status).toBe(200);
  await expect.poll(async () => (await observe()).scenes?.loaded, { timeout: 10_000 }).toEqual(['scene-main', 'scene-grove']);
  await page.screenshot({ path: 'test-results/instances-after-load.png' });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});

test('a set is chunked by extent (the project default, overridden per set in the Inspector); it casts a shadow only when set', async ({ page }) => {
  test.setTimeout(150_000);
  be = await startBackend('inst-chunks', 'starter');
  // 200 copies in a 99.5 m row (x 0..99.5) near the ground.
  const transforms: number[] = [];
  for (let i = 0; i < 200; i += 1) transforms.push(i * 0.5, 0, -3 - (i % 2), 0, 0, 0, 1, 0.3, 0.3, 0.3);
  const published = await api('content/buffers', { transforms });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  const assets = (await query('queryAssets', { limit: 50, offset: 0 })).assets as { assetId: string; displayName: string }[];
  const pillar = assets.find((a) => a.displayName === 'Pillar')!.assetId;
  const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Row', components: { instances: { asset: { assetId: pillar }, buffer: published.json.digest, count: 200 } } });
  const id = String(made.createdId);

  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' }).click();
  const chunks = page.locator('.tl-inspector [data-chunks]');
  // The engine default, 32 m: a 99.5 m row is 4 chunks (by count alone it was one).
  await expect(chunks).toHaveAttribute('data-chunks', '4', { timeout: 15_000 });
  await expect(chunks).toContainText('at most 32 m');

  // The set's own size, in the Inspector: 10 m → 10 chunks, stored on the component.
  const f = page.locator('.tl-inspector').getByLabel('instances chunkSize', { exact: true });
  await f.fill('10');
  await f.press('Enter');
  await expect.poll(async () => ((await query('queryEntity', { entityId: id })).entity as { components: { instances: { chunkSize?: number } } }).components.instances.chunkSize).toBe(10);
  await expect(chunks).toHaveAttribute('data-chunks', '10');

  // Back to the project default, then the project's own size (setSettings instance_chunk_m) rebuilds it: 50 m → 2 chunks.
  const current = (await query('queryEntity', { entityId: id })).entity as { components: { instances: Record<string, unknown> } };
  await cmd('setComponent', { entityId: id, component: 'instances', value: { ...current.components.instances, chunkSize: null } });
  expect(((await query('queryEntity', { entityId: id })).entity as { components: { instances: Record<string, unknown> } }).components.instances.chunkSize).toBeUndefined();
  await expect(chunks).toHaveAttribute('data-chunks', '4');
  await cmd('setSettings', { settings: { instance_chunk_m: 50 } });
  await expect(chunks).toHaveAttribute('data-chunks', '2');

  // Play draws the set (with the project's chunk size) without a notice. The sun casts shadows; the set casts
  // none unless it says so (foliage and scatter): its chunks are not drawn into the shadow map.
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.5, -1, 0.6], castShadow: true } });
  const casts = page.locator('.tl-inspector').getByLabel('instances castShadow', { exact: true });
  await expect(casts).not.toBeChecked();
  const playDraws = async (shot: string): Promise<number> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    await expect(playCanvas(page)).toHaveAttribute('data-tl-renderer-state', 'ready', { timeout: 30_000 });
    await expect(page.locator('.tl-notice')).toHaveCount(0);
    const draws = async (): Promise<number> => ((await api(`play/${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: { frame?: { drawCalls: number } } } }).diagnostics?.renderer?.frame?.drawCalls ?? 0;
    await expect.poll(draws, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: `test-results/${shot}.png` });
    const n = await draws();
    await page.getByRole('button', { name: '■ stop' }).click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible();
    return n;
  };
  const without = await playDraws('instances-chunks-play');
  // "Casts shadows" on in the Inspector: stored on the set, and its chunks are drawn into the shadow map too.
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' }).click();
  await page.locator('.tl-inspector').getByLabel('instances castShadow', { exact: true }).click();
  await expect.poll(async () => ((await query('queryEntity', { entityId: id })).entity as { components: { instances: { castShadow?: boolean } } }).components.instances.castShadow).toBe(true);
  const withShadow = await playDraws('instances-chunks-play-casting');
  console.log(`[instances] draws a frame: ${without} casting none, ${withShadow} casting`);
  expect(withShadow).toBeGreaterThan(without);
});

const green = (r: number, g: number, b: number): boolean => g > 50 && g > 2 * r && g > 2 * b;
const magenta = (r: number, g: number, b: number): boolean => r > 50 && b > 50 && r > 1.5 * g && b > 1.5 * g;
/** Sampled pixels (every second one) of the columns `from`..`to` (fractions of the width) that pass `test`. */
function countIn(img: Image, from: number, to: number, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = Math.floor(img.width * from); x < Math.floor(img.width * to); x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}

// Which level a model or copy draws is picked on the CPU, but each draw leaves out the copies at other levels per
// pass (instance counts set right before each draw): a backend path, so both renderers.
for (const variant of RENDERER_VARIANTS) test(`a model's LOD switch point and cull size from its import settings, per placed model and per instance copy; density in the Inspector; the bias in the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  be = await startBackend('inst-lod-e2e');
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  // A 50° lens reaching 400 m (the bands below are worked out from it).
  await cmd('setSettings', { settings: { physics_dimension: 3, camera_fov_deg: 50, camera_far_m: 400 } });
  // A 3 m marker: LOD0 green, LOD1 magenta (the colour tells the level). Its LOD0 sphere (r 2.6 m) covers 10 % of a
  // 50° view at 55.7 m and 4 % at 139.3 m: the switch point and cull size set below.
  await publishBytes(be, multiPieceGlb([{ name: 'marker', lods: [[3, 3, 3], [3, 3, 3]], colors: [[0.02, 1, 0.02], [1, 0.02, 1]] }]), 'model', 'markers', 'Markers');
  const r = Math.hypot(3, 3, 3) / 2;
  const at = (size: number): number => r / (Math.tan((25 * Math.PI) / 180) * size);
  const switchAt = at(0.1);
  const cullAt = at(0.04);
  // The camera 6 m up at z -10, looking along +z 5° down.
  const eye = [0, 6, -10] as const;
  const cam = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [...eye], rotation: [0, 0.9990482, 0.0436194, 0] } });
  // On the ground at `distance` from the eye, `bearing` degrees right of the view.
  const ground = (distance: number, bearing: number): [number, number, number] => {
    const h = Math.sqrt(distance ** 2 - eye[1] ** 2);
    return [h * Math.sin((bearing * Math.PI) / 180), 0, eye[2] + h * Math.cos((bearing * Math.PI) / 180)];
  };
  // Placed markers (right to left on +x, so left to right on the screen): inside the switch point, past it (inside the
  // old default's 69.7 m), inside the cull size, past it.
  const bearings = [-24, -12, 12, 24];
  const distances = [switchAt - 4, switchAt + 4, cullAt - 6, cullAt + 6];
  for (let i = 0; i < 4; i += 1) await cmd('createEntity', { sceneId: 'scene-main', kind: 'model', name: `m${i}`, model: { asset: { assetId: 'markers' }, piece: 'marker' }, transform: { position: ground(distances[i]!, bearings[i]!) } });
  // A row of copies straight ahead, each picking its own level, 22 m to 142 m away every 6 m (none within 2.5 m of either threshold).
  const transforms: number[] = [];
  const copyDistances: number[] = [];
  for (let d = 22; d <= 142; d += 6) {
    copyDistances.push(d);
    transforms.push(...ground(d, 0), 0, 0, 0, 1, 1, 1, 1);
  }
  const published = await api('content/buffers', { transforms });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  const row = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Row', components: { instances: { asset: { assetId: 'markers', piece: 'marker' }, buffer: published.json.digest, count: copyDistances.length, lodPerCopy: true } } })).createdId);

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(status(page)).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  // The model's import settings in the asset inspector: switch at 10 %, cull below 4 % (one command each).
  await chooseItem(page, 'model', 'Markers');
  const lodOf = async (): Promise<unknown> => ((await query('queryAssets', { limit: 50, offset: 0 })).assets as { assetId: string; lod?: unknown }[]).find((a) => a.assetId === 'markers')?.lod;
  // Both fields, then Enter: one command.
  await page.getByLabel('lod switch points').fill('10');
  await page.getByLabel('lod cull size').fill('4');
  await page.getByLabel('lod cull size').press('Enter');
  await expect.poll(lodOf).toEqual({ screenSizes: [0.1], cullSize: 0.04 });
  // The set's density falloff in the Inspector: thinning from 3 % down to half the copies at 1.5 % (from ~186 m, past the row).
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Row' }).click();
  for (const [key, value] of [['densityStart', '0.03'], ['densityEnd', '0.015'], ['densityMin', '0.5']] as const) {
    const f = page.locator('.tl-inspector').getByLabel(`instances ${key}`, { exact: true });
    await f.fill(value);
    await f.press('Enter');
  }
  await expect.poll(async () => JSON.stringify(((await query('queryEntity', { entityId: row })).entity as { components: { instances: Record<string, unknown> } }).components.instances, ['densityStart', 'densityEnd', 'densityMin'])).toBe('{"densityStart":0.03,"densityEnd":0.015,"densityMin":0.5}');

  // Play: green, magenta, magenta, nothing from left to right; the copies near green, then magenta, the farthest culled.
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Lod = { switches: number; copySwitches: number; instances: { copies: number; inView: number; byLevel: number[]; culled: number; thinned: number } };
  const lod = async (): Promise<Lod | undefined> => ((await api(`play/${psid}/diagnostics`, {})).json as { diagnostics?: { renderer?: { lod?: Lod } } }).diagnostics?.renderer?.lod;
  const near = copyDistances.filter((d) => d < switchAt).length;
  const mid = copyDistances.filter((d) => d >= switchAt && d < cullAt).length;
  await expect.poll(async () => JSON.stringify((await lod())?.instances.byLevel.slice(0, 2) ?? null), { timeout: 60_000, message: 'Play diagnostics: the copies by level' }).toBe(JSON.stringify([near, mid]));
  const l = (await lod())!;
  console.log(`[instances-lod] ${variant} Play lod diagnostics: ${JSON.stringify(l)}`);
  expect(l.instances.copies).toBe(copyDistances.length);
  expect(l.instances.culled).toBe(copyDistances.length - near - mid);
  expect(l.instances.thinned).toBe(0);
  expect(l.instances.inView).toBe(near + mid);
  // Bands of the picture where each placed marker stands (its bearing on the screen: looking along +z, +x is to the
  // left) and the row in the middle.
  const bandOf = (img: Image, bearing: number): [number, number] => {
    const x = 0.5 - Math.tan((bearing * Math.PI) / 180) / (2 * Math.tan((25 * Math.PI) / 180) * (img.width / img.height));
    return [x - 0.03, x + 0.03];
  };
  const look = (img: Image): string => {
    const colour = (from: number, to: number): string => `${countIn(img, from, to, green) > 6 ? 'green' : ''}${countIn(img, from, to, magenta) > 6 ? 'magenta' : ''}` || 'none';
    return [...bearings.map((b) => colour(...bandOf(img, b))), colour(0.47, 0.53)].join(' ');
  };
  let shot = '';
  await expect
    .poll(async () => {
      const res = await api(`play/${psid}/screenshot`, {});
      if (res.status !== 200) return 'no screenshot';
      const buf = Buffer.from(String(res.json.dataUrl ?? '').split(',')[1] ?? '', 'base64');
      shot = look(decodePng(buf));
      return shot;
    }, { timeout: 60_000, message: 'Play: the markers by their levels, the row both' })
    .toBe('green magenta magenta none greenmagenta');
  await page.screenshot({ path: `test-results/instances-lod-${variant}.png` });
  await page.getByRole('button', { name: '■ stop' }).click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible();

  // The export carries the model's settings; with the project's LOD bias at 2 every switch point and cull size is
  // twice as far: the marker past the switch is detailed again and the one past the cull is drawn (coarse).
  await cmd('setSettings', { settings: { lod_bias: 2 } });
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const outDir = join(be.exportRoot, String(res.json.outputDir));
  expect(JSON.stringify(exportedContent(outDir))).toContain('"lod":{"screenSizes":[0.1],"cullSize":0.04}');
  await be.halt();
  const site = await serveDir(outDir);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    await expect.poll(async () => look(decodePng(await canvas.screenshot())), { timeout: 60_000, message: 'the export with LOD bias 2' }).toBe('green green magenta magenta greenmagenta');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
