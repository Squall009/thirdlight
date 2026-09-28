/**
 * Phase 25.24c/d: what a Play start no longer does twice.
 *
 * (d) Many groups of one repeated model (a detailed sphere in ten world
 * cells: ten automatic batches of one material) are drawn with shared node
 * programs, not one per batch; the first present waits for a precompile
 * (`renderer.compileAsync`), and so does a scene loaded later; the picture
 * shows the spheres.
 *
 * (c) The second Play in the same editor page takes its game bundle and its
 * model file from the browser's cache: both are at URLs that stay the same
 * from Play to Play (the play build's, the project's cache root), and the
 * preview still checks the model's bytes against the manifest (it reads
 * through the same checked reader; `assetReads` counts the read).
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Frame, type Page } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { sphereGlb } from '../../tools/perf/assets';
import { decodePng, type Image } from './png';
import { backendOf, editorUrlFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `start-cache-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

type Diag = {
  diagnostics?: {
    startTimings?: { stages: { name: string; startMs: number; endMs: number | null }[]; sceneLoads: { sceneId: string; attachedMs: number | null; precompileMs?: number | null }[] };
    assetReads?: { reads: number; bytes: number };
    renderer?: { renderBackend?: string | null; batching?: { groups: number; batched: number; programs?: number }; precompile?: { runs: number; failed: number; gaveUp: number; running: boolean }; models?: { instances: number } };
  };
};

/** A project whose start scene holds `perCell` spheres in each of `cells` world cells (64 m apart), in front of the camera. */
async function sphereProject(projectId: string, cells: number, perCell: number): Promise<void> {
  const created = await be.post('/api/v1/admin/projects', { projectId, name: 'Start cache' });
  expect([200, 201]).toContain(created.status);
  const p = be.project(projectId);
  const stageId = await be.stage(projectId, sphereGlb(3, 16, 16));
  const inspected = await be.post(`/api/v1/projects/${projectId}/content/stages/${stageId}/inspect`, { kind: 'model' });
  const proposal = inspected.json['proposal'] as Record<string, unknown>;
  expect(proposal, JSON.stringify(inspected.json).slice(0, 300)).toBeDefined();
  await p.command('publishAsset', { mode: 'create', assetId: 'sphere', kind: 'model', displayName: 'Sphere', sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  await be.discardStage(projectId, stageId);
  await p.command('setTransform', { entityId: 'cam-main', transform: { position: [0, 0, 330] } });
  await p.command('setComponent', { entityId: 'cam-main', component: 'camera', value: { type: 'perspective', fovY: 60, near: 0.5, far: 2000 } });
  for (let c = 0; c < cells; c += 1) {
    for (let i = 0; i < perCell; i += 1) {
      const x = (c - (cells - 1) / 2) * 64 + i * 6 - 9;
      await p.command('createEntity', { sceneId: 'scene-main', kind: 'model', name: `Sphere ${c}-${i}`, transform: { position: [x, 0, 0], scale: [14, 14, 14] }, model: { asset: { assetId: 'sphere' } } });
    }
  }
}

async function openEditor(page: Page, projectId: string, url = (u: string): string => u): Promise<void> {
  await page.goto(url(`${be.origin}/?project=${projectId}#token=${be.token}`));
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
}

/** Click Play; the play id and its preview frame once it runs. */
async function play(page: Page, projectId: string): Promise<{ psid: string; frame: Frame }> {
  const before = new Set(page.frames());
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await be.post(`/api/v1/projects/${projectId}/play/${psid}/observe`, {})).json['state'], { timeout: 90_000 }).toBe('running');
  const frame = page.frames().find((f) => !before.has(f) && f.url().startsWith(be.previewOrigin));
  expect(frame, 'the preview frame').toBeDefined();
  return { psid, frame: frame! };
}

async function stop(page: Page, projectId: string, psid: string): Promise<void> {
  await page.getByTitle('Stop the play preview').click();
  await expect.poll(async () => (await be.post(`/api/v1/projects/${projectId}/play/${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(404);
}

for (const variant of RENDERER_VARIANTS) test(`25.24d (${variant}): batches of one model share their node programs; the first present and a scene load wait for a precompile; the spheres are drawn`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  await sphereProject('shared', 10, 4);
  const p = be.project('shared');
  await p.command('createScene', { sceneId: 'scene-more', name: 'More' });
  for (let i = 0; i < 4; i += 1) await p.command('createEntity', { sceneId: 'scene-more', kind: 'model', name: `More ${i}`, transform: { position: [i * 6 - 9, 40, 0], scale: [14, 14, 14] }, model: { asset: { assetId: 'sphere' } } });
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  await openEditor(page, 'shared', (u) => editorUrlFor(u, variant));
  const { psid } = await play(page, 'shared');
  const relay = (path: string, body: unknown = {}) => be.post(`/api/v1/projects/shared/play/${psid}/${path}`, body);
  const diag = async (): Promise<NonNullable<Diag['diagnostics']>> => ((await relay('diagnostics')).json as Diag).diagnostics ?? {};
  await expect.poll(async () => (await diag()).renderer?.batching?.groups ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(10);
  const d = await diag();
  expect(d.renderer!.renderBackend).toBe(backendOf(variant));
  // Ten batches (a cell each); their render objects share a program per pass (the main pass, the shadow pass).
  expect(d.renderer!.batching!.batched).toBe(40);
  expect(d.renderer!.batching!.programs, JSON.stringify(d.renderer!.batching)).toBeGreaterThanOrEqual(1);
  expect(d.renderer!.batching!.programs!).toBeLessThanOrEqual(3);
  // The first present waited for the precompile.
  expect(d.renderer!.precompile).toMatchObject({ failed: 0, gaveUp: 0 });
  expect(d.renderer!.precompile!.runs).toBeGreaterThanOrEqual(1);
  const stage = d.startTimings!.stages.find((s) => s.name === 'precompile');
  expect(stage?.endMs, JSON.stringify(d.startTimings!.stages)).not.toBeNull();
  // Drawn: pixels that are not the background.
  const shot = async (): Promise<Image> => {
    const r = await relay('screenshot', { maxWidth: 320 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  const img = await shot();
  const bg = img.pixel(1, 1);
  let differ = 0;
  for (let y = 0; y < img.height; y += 1) for (let x = 0; x < img.width; x += 1) {
    const px = img.pixel(x, y);
    if (Math.abs(px[0] - bg[0]) + Math.abs(px[1] - bg[1]) + Math.abs(px[2] - bg[2]) > 60) differ += 1;
  }
  expect(differ).toBeGreaterThan(200);
  // A scene loaded later: its programs are built before it is presented too.
  const runs = d.renderer!.precompile!.runs;
  const asked = await relay('control', { command: 'loadScene', sceneId: 'scene-more' });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  await expect.poll(async () => (await diag()).startTimings?.sceneLoads.find((l) => l.sceneId === 'scene-more')?.attachedMs ?? null, { timeout: 60_000 }).not.toBeNull();
  const after = await diag();
  expect(after.renderer!.precompile!.runs).toBeGreaterThan(runs);
  expect(after.startTimings!.sceneLoads.find((l) => l.sceneId === 'scene-more')!.precompileMs).not.toBeNull();
  await stop(page, 'shared', psid);
});

test('25.24c: the second Play takes its bundle and its model file from the browser cache (stable URLs); the model is still checked', async ({ page }) => {
  test.setTimeout(300_000);
  await sphereProject('cached', 1, 2);
  await openEditor(page, 'cached');
  type Entry = { name: string; transferSize: number; decodedBodySize: number };
  const resources = async (frame: Frame): Promise<Entry[]> =>
    frame.evaluate(() => performance.getEntriesByType('resource').map((e) => ({ name: e.name, transferSize: (e as PerformanceResourceTiming).transferSize, decodedBodySize: (e as PerformanceResourceTiming).decodedBodySize })));
  const pick = (entries: Entry[], re: RegExp): Entry => {
    const e = entries.find((x) => re.test(new URL(x.name).pathname));
    expect(e, `${String(re)} in ${entries.map((x) => new URL(x.name).pathname).join(', ')}`).toBeDefined();
    return e!;
  };
  const bundleRe = /^\/play-build\/[0-9a-f]{64}\/game\.js$/;
  const modelRe = /^\/play-content\/[A-Za-z0-9_-]{43}\/content\/sha256\/[0-9a-f]{64}$/;
  const first = await play(page, 'cached');
  const e1 = await resources(first.frame);
  const bundle1 = pick(e1, bundleRe);
  const model1 = pick(e1, modelRe);
  expect(bundle1.transferSize).toBeGreaterThan(0);
  await stop(page, 'cached', first.psid);

  const second = await play(page, 'cached');
  const e2 = await resources(second.frame);
  const bundle2 = pick(e2, bundleRe);
  const model2 = pick(e2, modelRe);
  // The same URLs, and nothing came over the wire for them (the browser's cache answered).
  expect(bundle2.name).toBe(bundle1.name);
  expect(model2.name).toBe(model1.name);
  expect(bundle2.transferSize).toBe(0);
  expect(bundle2.decodedBodySize).toBeGreaterThan(0);
  expect(model2.transferSize).toBe(0);
  // The model was still read through the checked reader (length and digest against the manifest).
  const d = ((await be.post(`/api/v1/projects/cached/play/${second.psid}/diagnostics`, {})).json as Diag).diagnostics ?? {};
  expect(d.assetReads?.reads).toBe(1);
  await expect.poll(async () => (((await be.post(`/api/v1/projects/cached/play/${second.psid}/diagnostics`, {})).json as Diag).diagnostics?.renderer?.models?.instances ?? 0), { timeout: 30_000 }).toBe(2);
  await stop(page, 'cached', second.psid);
});
