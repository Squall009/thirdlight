/**
 * A scene transition never shows an empty world — driven
 * through the editor and measured in a real browser against a real backend.
 *
 * The starter template plus two scenes that do not start: "A" (a red wall
 * behind the character and a door around it whose scene transition loads "B"
 * and unloads "A") and "B" (a green-textured wall and a model file). The
 * door's fade is set in the Inspector. In Play the relay loads "A" (a plain
 * load, as a script's `ctx.scenes.load`); the door fires at once, the view
 * fades out (the host's overlay, `scenes.transition` in the observation),
 * "B" is read and prepared, and "A" leaves in the step "B" arrives.
 *
 * Measured per drawn frame (the page's scene-load timings, from the
 * renderer's frame hook): no frame from the transition's request to 10 s
 * after "B" attached drew fewer calls than the start scene alone plus one
 * wall — an empty world would draw only the start scene; the frame that
 * attached "B" drew as many calls as "B" draws later (its model and texture
 * were prepared before, not streamed in after); "B" was prepared before it
 * attached. The final picture is green (pixels). The editor
 * sends the preview's load progress to the backend before it is ready (the
 * present timeout counts from the last). Runs on the product's own renderer
 * (renderer-variants.ts PRODUCT_RENDERER_VARIANTS): a scene load waiting for
 * its precompile on WebGL 2 is play-start-cache.e2e's.
 *
 * With ambient occlusion on (the scene pass draws colour and normals), a
 * scene loaded at run time is not held back by its precompile: the
 * precompile builds its materials for both outputs (no pipeline fails), it
 * settles without the adapter giving up on it, and the frame that attached
 * the scene came within the stall bound.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { PRECOMPILE_STALL_MS } from '../../packages/three-adapter/src/adapter-types';
import { sphereGlb } from '../../tools/perf/assets';
import { publishBytes, STARTER, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, PRODUCT_RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-scene-loads' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}

function share(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  let all = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      all += 1;
      if (test(r, g, b)) n += 1;
    }
  }
  return n / all;
}
const green = (r: number, g: number, b: number): boolean => g > 100 && g > 1.8 * r && g > 1.8 * b;

interface SceneLoad {
  sceneId: string;
  requestedMs: number;
  readMs: number | null;
  preparedMs?: number | null;
  attachedMs: number | null;
  attachFrameMs: number | null;
  preloaded?: boolean;
  drawsBefore?: number | null;
  attachDraws?: number | null;
  drawsMin?: number | null;
  loadingFrames?: number;
  loadingWorstMs?: number;
  after: { frames: number; over250: number };
}

const VARIANTS: readonly RendererVariant[] = PRODUCT_RENDERER_VARIANTS;

for (const variant of VARIANTS) test(`a scene transition shows no empty frame: the old scene stays until the new one is drawn whole, with a fade set in the Inspector (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, VARIANTS);
  test.setTimeout(300_000);
  be = await startBackend('scene-loads-e2e', 'starter');

  // B's model and texture (read and prepared before B attaches).
  await publishBytes(be, sphereGlb(3, 24, 64), 'model', 'model-orb');
  await publishBytes(be, makePng(64, 64, () => [40, 210, 60, 255]), 'texture', 'tex-green');
  await cmd('setMaterial', { material: { materialId: 'mat-green', name: 'Green', shader: 'unlit', params: {}, textures: { map: 'tex-green' } } });
  await cmd('createScene', { sceneId: 'scene-a', name: 'A' });
  await cmd('createScene', { sceneId: 'scene-b', name: 'B' });
  // The camera looks down -z at the character (4, 3, 12): each scene's wall fills the view behind it.
  await cmd('createEntity', { sceneId: 'scene-a', parentId: null, kind: 'box', name: 'Red wall', transform: { position: [4, 3, -4] }, box: { size: [60, 40, 1], material: { color: '#d02020' } } });
  const door = String((await cmd('createEntity', { sceneId: 'scene-a', parentId: null, kind: 'group', name: 'Door', transform: { position: [3, 1, 0] }, components: { trigger: { size: [4, 4], signal: 'door', sceneTransition: { scene: 'scene-b', unload: ['scene-a'] } } } }))['createdId']);
  await cmd('createEntity', { sceneId: 'scene-b', parentId: null, kind: 'box', name: 'Green wall', transform: { position: [4, 3, -4] }, box: { size: [60, 40, 1], material: { color: '#ffffff' } }, components: { materials: { '*': 'mat-green' } } });
  await cmd('createEntity', { sceneId: 'scene-b', parentId: null, kind: 'model', name: 'Orb', transform: { position: [6, 3, 0] }, model: { asset: { assetId: 'model-orb' } } });

  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message}`));
  // The editor passes the preview's load progress on to the backend (its present timeout counts from the last).
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const t = /"type":"(play\.preview\.[a-z]+)"/.exec(String(f.payload))?.[1];
    if (t !== undefined) sent.push(t);
  }));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The door's fade, set in the Inspector (the scene opened in the Hierarchy).
  await page.getByLabel('open scene', { exact: true }).selectOption({ label: 'A' });
  await select(page, door);
  const fade = page.locator('.tl-inspector').getByLabel('trigger sceneTransition fade', { exact: true });
  await fade.fill('0.4');
  await fade.press('Enter');
  const transition = async (): Promise<unknown> => ((await query('queryEntity', { entityId: door }))['entity'] as { components: { trigger: { sceneTransition: unknown } } }).components.trigger.sceneTransition;
  await expect.poll(transition).toEqual({ scene: 'scene-b', unload: ['scene-a'], fade: 0.4 });

  // Play: the start scene only.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  type Obs = { state?: string; scenes?: { loaded: string[]; loading: string[]; transition?: { scene: string; phase: string; fade: number } } };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  type Diag = { diagnostics?: { startTimings?: { firstFrameMs: number | null; firstFrameDraws?: number | null; sceneLoads: SceneLoad[] } } };
  const diag = async (): Promise<NonNullable<NonNullable<Diag['diagnostics']>['startTimings']>> => {
    const r = await api(`play/${psid}/diagnostics`);
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    return ((r.json as Diag).diagnostics?.startTimings) ?? { firstFrameMs: null, sceneLoads: [] };
  };
  await expect.poll(async () => (await diag()).firstFrameMs, { timeout: 60_000 }).not.toBeNull();
  expect(sent[0], JSON.stringify(sent)).toBe('play.preview.progress');
  expect(sent).toContain('play.preview.ready');
  expect(sent.indexOf('play.preview.ready')).toBe(sent.length - 1); // nothing after ready
  const shot = async (): Promise<Image> => {
    const r = await api(`play/${psid}/screenshot`, { maxWidth: 256 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  await page.waitForTimeout(1_000); // frames settle

  // Watch the fade overlay the host draws in the Play frame.
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  const fades: number[] = [];
  let watching = true;
  const watchFade = (async () => {
    while (watching) {
      const v = await frame.locator('[data-tl-fade]').first().getAttribute('data-tl-fade', { timeout: 200 }).catch(() => null);
      if (v !== null) fades.push(Number(v));
      await page.waitForTimeout(30);
    }
  })();

  // Load A (a plain load); its door sends the character to B at once.
  const asked = await api(`play/${psid}/control`, { command: 'loadScene', sceneId: 'scene-a' });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  // The observation shows the transition while it waits (fading out or loading).
  await expect.poll(async () => (await observe()).scenes?.transition?.scene ?? (await observe()).scenes?.loaded.includes('scene-b'), { timeout: 30_000 }).toBeTruthy();
  await expect.poll(async () => (await observe()).scenes?.loaded ?? [], { timeout: 30_000 }).toEqual(['scene-main', 'scene-b']);
  // 10 s of frames after B attached are watched; the fade has come back in by then.
  await page.waitForTimeout(11_000);
  watching = false;
  await watchFade;

  const loads = (await diag()).sceneLoads;
  const a = loads.find((l) => l.sceneId === 'scene-a');
  const b = loads.find((l) => l.sceneId === 'scene-b');
  console.log(`scene loads (${variant}): ${JSON.stringify(loads)}`);
  console.log(`fade samples (${variant}): ${JSON.stringify(fades.slice(0, 80))}`);
  expect(a?.attachedMs).not.toBeNull();
  expect(b?.attachedMs).not.toBeNull();
  const startOnly = a!.drawsBefore!;
  expect(startOnly).toBeGreaterThan(0);
  // The first picture already had the start scene's models (it waited for them).
  expect((await diag()).firstFrameDraws).toBe(startOnly);
  // A draws its wall over the start scene.
  expect(a!.attachDraws!).toBeGreaterThan(startOnly);
  // No empty frame: from B's request to 10 s after it attached, every frame drew more than the start scene alone.
  expect(b!.drawsMin!, 'the fewest draws of any frame during the transition').toBeGreaterThan(startOnly);
  // B was prepared before it attached, and the frame that attached it drew it whole (its model and textured wall).
  expect(b!.preparedMs).not.toBeNull();
  expect(b!.preparedMs!).toBeLessThanOrEqual(b!.attachedMs!);
  const steady = await frame.locator('canvas').first().getAttribute('data-tl-draws');
  expect(b!.attachDraws, 'the attach frame drew what B draws once settled').toBe(Number(steady));
  expect(b!.after.over250).toBe(0);
  // The fade went out and came back in (0.4 s each way).
  expect(Math.max(...fades)).toBeGreaterThan(0.5);
  expect(fades.some((f) => f > 0 && f < 1)).toBe(true);
  expect(fades[fades.length - 1]).toBe(0);
  // B is on screen: the green wall.
  expect(share(await shot(), green)).toBeGreaterThan(0.3);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  expect(STARTER.cameraId).toBe('cam-main');
});

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`with ambient occlusion on, a scene loaded in Play is drawn without waiting out its precompile (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(240_000);
  be = await startBackend('scene-loads-ao-e2e', 'starter');
  await publishBytes(be, sphereGlb(3, 24, 64), 'model', 'model-orb');
  await publishBytes(be, makePng(64, 64, () => [40, 210, 60, 255]), 'texture', 'tex-green');
  await cmd('setMaterial', { material: { materialId: 'mat-lit-green', name: 'Lit green', shader: 'standard', params: { roughness: 0.8, metalness: 0 }, textures: { map: 'tex-green' } } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { post: { antialias: 'smaa', ssao: { enabled: true, radius: 0.5, intensity: 1 } } } });
  await cmd('createScene', { sceneId: 'scene-b', name: 'B' });
  await cmd('createEntity', { sceneId: 'scene-b', parentId: null, kind: 'box', name: 'Green wall', transform: { position: [4, 3, -4] }, box: { size: [60, 40, 1], material: { color: '#ffffff' } }, components: { materials: { '*': 'mat-lit-green' } } });
  await cmd('createEntity', { sceneId: 'scene-b', parentId: null, kind: 'model', name: 'Orb', transform: { position: [6, 3, 0] }, model: { asset: { assetId: 'model-orb' } } });

  const failures: string[] = [];
  page.on('console', (m) => {
    if (/pipeline creation failed|GPUValidationError/i.test(m.text())) failures.push(m.text().slice(0, 300));
  });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  type Diag = { diagnostics?: { renderer?: { precompile?: { runs: number; gaveUp: number; running: boolean } }; startTimings?: { firstFrameMs: number | null; sceneLoads: SceneLoad[] } } };
  const diag = async (): Promise<NonNullable<Diag['diagnostics']>> => {
    const r = await api(`play/${psid}/diagnostics`);
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    return (r.json as Diag).diagnostics ?? {};
  };
  await expect.poll(async () => (await diag()).startTimings?.firstFrameMs ?? null, { timeout: 60_000 }).not.toBeNull();

  const asked = await api(`play/${psid}/control`, { command: 'loadScene', sceneId: 'scene-b' });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  await expect.poll(async () => (await diag()).startTimings?.sceneLoads.find((l) => l.sceneId === 'scene-b')?.attachedMs ?? null, { timeout: 60_000 }).not.toBeNull();
  await expect.poll(async () => (await diag()).renderer?.precompile?.running, { timeout: 30_000 }).toBe(false);
  const d = await diag();
  const b = d.startTimings!.sceneLoads.find((l) => l.sceneId === 'scene-b')!;
  console.log(`scene load with AO (${variant}): ${JSON.stringify(b)} precompile ${JSON.stringify(d.renderer?.precompile)}`);
  expect(failures, 'no pipeline fails to build').toEqual([]);
  expect(d.renderer?.precompile?.gaveUp, 'the adapter never gave up on a precompile').toBe(0);
  expect(b.attachFrameMs!, 'the frame that attached B was not held').toBeLessThan(PRECOMPILE_STALL_MS);
  // B is on screen: the lit green wall.
  const shot = await api(`play/${psid}/screenshot`, { maxWidth: 256 });
  expect(shot.status).toBe(200);
  const lit = (r: number, g: number, b2: number): boolean => g > 60 && g > 1.5 * r && g > 1.5 * b2;
  expect(share(decodePng(Buffer.from(String(shot.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64')), lit)).toBeGreaterThan(0.3);
});
