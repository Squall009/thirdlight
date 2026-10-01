/**
 * A Play start reads only its start scenes' assets; a scene
 * loaded later reads its own when it loads, checked the same way, and shows
 * them. A two-scene project built through the real API: the start scene has
 * one model file; the other scene (not a start scene) a second model file
 * and a large box whose unlit material is a solid green texture, in front of
 * the camera. Before the load the start split names one asset read and the
 * view has no green; after the relay loads the scene, the model and the
 * texture have been read and the green box is in the relay's screenshot.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { sphereGlb } from '../../tools/perf/assets';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `start-assets-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

function greenPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 120 && g > 2 * r && g > 2 * b) n += 1;
    }
  }
  return n;
}

test('Play reads only the start scene’s assets; a scene loaded later reads and shows its own', async ({ page }) => {
  test.setTimeout(240_000);
  const created = await be.post('/api/v1/admin/projects', { projectId: 'lazy', name: 'Lazy assets' });
  expect([200, 201]).toContain(created.status);
  const p = be.project('lazy');
  const publish = async (assetId: string, kind: 'model' | 'texture', bytes: Uint8Array): Promise<void> => {
    const stageId = await be.stage('lazy', bytes);
    const inspected = await be.post(`/api/v1/projects/lazy/content/stages/${stageId}/inspect`, { kind });
    const proposal = inspected.json['proposal'] as Record<string, unknown>;
    expect(proposal, JSON.stringify(inspected.json).slice(0, 300)).toBeDefined();
    // A model keeps its image inside (extract textures off): the spec counts one file per model.
  await p.command('publishAsset', { mode: 'create', assetId, kind, displayName: assetId, sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...(kind === 'model' ? { extractTextures: false } : {}) });
    await be.discardStage('lazy', stageId);
  };
  await publish('model-start', 'model', sphereGlb(1, 16, 32));
  await publish('model-later', 'model', sphereGlb(2, 16, 32));
  await publish('tex-green', 'texture', makePng(32, 32, () => [30, 220, 40, 255]));
  await p.command('setMaterial', { material: { materialId: 'mat-green', name: 'Green', shader: 'unlit', params: {}, textures: { map: 'tex-green' } } });
  await p.command('createScene', { sceneId: 'scene-later', name: 'Later' });
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  await p.command('setTransform', { entityId: 'cam-main', transform: { position: [0, 0, 10] } });
  await p.command('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Start prop', transform: { position: [40, 0, 0] }, model: { asset: { assetId: 'model-start' } } });
  await p.command('createEntity', { sceneId: 'scene-later', kind: 'model', name: 'Later prop', transform: { position: [-40, 0, 0] }, model: { asset: { assetId: 'model-later' } } });
  await p.command('createEntity', { sceneId: 'scene-later', kind: 'box', name: 'Green wall', transform: { position: [0, 0, 0] }, box: { size: [40, 40, 1], material: { color: '#ffffff' } }, components: { materials: { '*': 'mat-green' } } });

  const relay = (path: string, body: unknown = {}) => be.post(`/api/v1/projects/lazy/play/${path}`, body);
  await page.goto(`${be.origin}/?project=lazy#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Diag = { diagnostics?: { startTimings?: { counts: Record<string, number>; sceneLoads: { sceneId: string; readMs: number | null; attachedMs: number | null }[] }; assetReads?: { reads: number; bytes: number }; renderer?: { models?: { instances: number } } } };
  const diag = async (): Promise<NonNullable<Diag['diagnostics']>> => ((await relay(`${psid}/diagnostics`)).json as Diag).diagnostics ?? {};
  await expect.poll(async () => (await diag()).renderer?.models?.instances, { timeout: 60_000 }).toBe(1);
  const before = await diag();
  // Only the start scene's model was read before the play was ready.
  expect(before.startTimings?.counts['startAssetReads']).toBe(1);
  expect(before.assetReads?.reads).toBe(1);
  const shot = async (): Promise<Image> => {
    const r = await relay(`${psid}/screenshot`, { maxWidth: 256 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  expect(greenPixels(await shot())).toBe(0);

  // The later scene: loaded like a script's ctx.scenes.load; its model and texture are read now.
  const asked = await relay(`${psid}/control`, { command: 'loadScene', sceneId: 'scene-later' });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  await expect.poll(async () => (await diag()).renderer?.models?.instances, { timeout: 60_000 }).toBe(2);
  await expect.poll(async () => greenPixels(await shot()), { timeout: 30_000 }).toBeGreaterThan(500);
  const after = await diag();
  expect(after.assetReads?.reads).toBe(3);
  const load = after.startTimings?.sceneLoads.find((l) => l.sceneId === 'scene-later');
  expect(load?.readMs).not.toBeNull();
  expect(load?.attachedMs).not.toBeNull();
});
