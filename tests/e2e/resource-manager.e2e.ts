/**
 * The resource manager against a real backend in a real browser.
 *
 * Play: a project whose start scene draws nothing loaded from assets, and
 * three scenes loaded on demand — A (model M, a box with texture T1), B
 * (models M and N, a box with texture T2) and C (model N). The relay loads
 * A, a project script moves from A to B in one step (a transition: A
 * unloaded as B comes in), and the walk goes on to C and back to A. The
 * observation's `resources` shows what is resident per kind: M is not read
 * or parsed again when the transition drops A and takes B (the same step),
 * and after each scene is unloaded the resident bytes of every kind are back
 * where they were before the walk.
 *
 * Play, a texture sky: the texture the sky shows is also a material's map;
 * it is decoded once and shared.
 *
 * Scene view: the editor opens scene A (two models), then opens scene B (one
 * of them) and closes A: the model only A used is freed (`data-resources` of
 * the view).
 */
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { sphereGlb } from '../../tools/perf/assets';
import { makePng } from './png-make';

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `resources-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

type Resident = Partial<Record<string, { count: number; bytes: number }>>;
interface Resources {
  resident: Resident;
  loading: number;
  loads: Partial<Record<string, number>>;
  frees: Partial<Record<string, number>>;
  waiting: number;
  handles: number;
}

/** A project script: the debug command `go {to, leave}` loads `to` and unloads `leave` in the same step (a transition). */
const DRIVER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const call of ctx.debug.command('go', { description: 'Move to a scene', args: [{ name: 'to', type: 'string' }, { name: 'leave', type: 'string' }] })) ctx.scenes.load(String(call.to), { unload: [String(call.leave)] });",
  '  },',
  '};',
].join('\n');

async function newProject(pid: string): Promise<ReturnType<PerfBackend['project']>> {
  const created = await be.post('/api/v1/admin/projects', { projectId: pid, name: pid });
  expect([200, 201]).toContain(created.status);
  return be.project(pid);
}

async function publish(pid: string, assetId: string, kind: 'model' | 'texture', bytes: Uint8Array): Promise<void> {
  const p = be.project(pid);
  const stageId = await be.stage(pid, bytes);
  const inspected = await be.post(`/api/v1/projects/${pid}/content/stages/${stageId}/inspect`, { kind });
  const proposal = inspected.json['proposal'] as Record<string, unknown>;
  expect(proposal, JSON.stringify(inspected.json).slice(0, 300)).toBeDefined();
  // A model keeps its image inside (extract textures off): the spec counts one file per model.
  await p.command('publishAsset', { mode: 'create', assetId, kind, displayName: assetId, sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...(kind === 'model' ? { extractTextures: false } : {}) });
  await be.discardStage(pid, stageId);
}

async function installDriver(pid: string, entityId: string): Promise<void> {
  const p = be.project(pid);
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: DRIVER }] }, null, 2)}\n`);
  const stageId = await be.stage(pid, bytes);
  const declaration = { properties: [] };
  await p.command('publishBehavior', { behaviorId: 'driver', displayName: 'Driver', mode: 'declaration-create', declaration });
  await p.command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await be.post(`/api/v1/projects/${pid}/content/behaviors/source`, { stageId, behaviorId: 'driver', displayName: 'Driver', declaration, expectedRevision: await p.revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json).slice(0, 300)).toBe(200);
  await p.revision();
  await p.command('setBehaviorProperties', { entityId, behaviorId: 'driver', values: {} });
}

/** Resident bytes per kind, for comparing against a baseline (kinds with nothing resident left out). */
const bytesByKind = (r: Resident): Record<string, number> => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v.count > 0).map(([k, v]) => [k, v!.bytes]));

test('Play: a transition keeps the model both scenes use; after the walk every kind is back at its baseline', async ({ page }) => {
  test.setTimeout(300_000);
  const pid = 'resources';
  const p = await newProject(pid);
  await publish(pid, 'model-m', 'model', sphereGlb(1, 16, 32));
  await publish(pid, 'model-n', 'model', sphereGlb(2, 24, 32));
  await publish(pid, 'tex-1', 'texture', makePng(64, 64, () => [200, 40, 40, 255]));
  await publish(pid, 'tex-2', 'texture', makePng(32, 32, () => [40, 200, 40, 255]));
  await p.command('setMaterial', { material: { materialId: 'mat-1', name: 'One', shader: 'unlit', params: {}, textures: { map: 'tex-1' } } });
  await p.command('setMaterial', { material: { materialId: 'mat-2', name: 'Two', shader: 'unlit', params: {}, textures: { map: 'tex-2' } } });
  for (const [sceneId, name] of [['scene-a', 'A'], ['scene-b', 'B'], ['scene-c', 'C']] as const) await p.command('createScene', { sceneId, name });
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  const model = (sceneId: string, name: string, assetId: string, x: number) => p.command('createEntity', { sceneId, kind: 'model', name, transform: { position: [x, 0, 0] }, model: { asset: { assetId } } });
  const box = (sceneId: string, name: string, materialId: string) => p.command('createEntity', { sceneId, kind: 'box', name, transform: { position: [0, -2, 0] }, box: { size: [2, 0.5, 2], material: { color: '#ffffff' } }, components: { materials: { '*': materialId } } });
  await model('scene-a', 'M in A', 'model-m', -2);
  await box('scene-a', 'Box A', 'mat-1');
  await model('scene-b', 'M in B', 'model-m', -2);
  await model('scene-b', 'N in B', 'model-n', 2);
  await box('scene-b', 'Box B', 'mat-2');
  await model('scene-c', 'N in C', 'model-n', 2);
  const driver = String((await p.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Driver', transform: { position: [0, -10, 0] } }))['createdId']);
  await installDriver(pid, driver);

  const relay = (path: string, body: unknown = {}) => be.post(`/api/v1/projects/${pid}/play/${path}`, body);
  await page.goto(`${be.origin}/?project=${pid}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; scenes?: { loaded?: string[] }; resources?: Resources };
  const observe = async (): Promise<Obs> => {
    const r = await relay(`${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  const res = async (): Promise<Resources> => (await observe()).resources!;
  // The baseline: the start held nothing from assets once its reads were let go (nothing waits, nothing loads).
  await expect.poll(async () => { const r = await res(); return r.loading + r.waiting; }, { timeout: 30_000 }).toBe(0);
  const baseline = bytesByKind((await res()).resident);
  const loaded = async (id: string, yes: boolean): Promise<void> => {
    await expect.poll(async () => (await observe()).scenes?.loaded?.includes(id) === yes, { timeout: 60_000 }).toBe(true);
  };
  const settledRes = async (): Promise<Resources> => {
    await expect.poll(async () => { const r = await res(); return r.loading + r.waiting; }, { timeout: 30_000 }).toBe(0);
    return res();
  };

  // A: M and T1 resident.
  expect((await relay(`${psid}/control`, { command: 'loadScene', sceneId: 'scene-a' })).status).toBe(200);
  await loaded('scene-a', true);
  await expect.poll(async () => (await res()).resident['model']?.count ?? 0, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await res()).resident['texture']?.count ?? 0, { timeout: 30_000 }).toBe(1);
  const inA = await settledRes();
  const modelLoads = inA.loads['model'] ?? 0;
  expect(modelLoads).toBe(1);

  // A → B in one step: M stays (not parsed again, never freed), N and T2 come, T1 goes.
  const go = await relay(`${psid}/control`, { command: 'debugCommand', name: 'go', args: { to: 'scene-b', leave: 'scene-a' } });
  expect(go.status, JSON.stringify(go.json)).toBe(200);
  await loaded('scene-b', true);
  await loaded('scene-a', false);
  await expect.poll(async () => (await res()).resident['model']?.count ?? 0, { timeout: 30_000 }).toBe(2);
  const inB = await settledRes();
  expect(inB.loads['model']).toBe(modelLoads + 1);
  // Nor were its bytes read again: only N's and T2's.
  expect(inB.loads['bytes']).toBe((inA.loads['bytes'] ?? 0) + 2);
  expect(inB.frees['model'] ?? 0).toBe(inA.frees['model'] ?? 0);
  expect(inB.resident['texture']?.count).toBe(1);
  expect(inB.frees['texture'] ?? 0).toBeGreaterThan(inA.frees['texture'] ?? 0);

  // Unload B: back to the baseline, kind by kind.
  expect((await relay(`${psid}/control`, { command: 'unloadScene', sceneId: 'scene-b' })).status).toBe(200);
  await loaded('scene-b', false);
  await expect.poll(async () => { const r = await settledRes(); return bytesByKind(r.resident); }, { timeout: 30_000 }).toEqual(baseline);

  // On to C and back to A, each unloaded again: the baseline each time.
  for (const id of ['scene-c', 'scene-a']) {
    expect((await relay(`${psid}/control`, { command: 'loadScene', sceneId: id })).status).toBe(200);
    await loaded(id, true);
    await expect.poll(async () => (await res()).resident['model']?.count ?? 0, { timeout: 30_000 }).toBe(1);
    expect((await relay(`${psid}/control`, { command: 'unloadScene', sceneId: id })).status).toBe(200);
    await loaded(id, false);
    await expect.poll(async () => { const r = await settledRes(); return bytesByKind(r.resident); }, { timeout: 30_000 }).toEqual(baseline);
  }
  const end = await res();
  expect(end.handles).toBe(0);
  // Play's diagnostics report the same manager.
  const diag = (await relay(`${psid}/diagnostics`)).json as { diagnostics?: { resources?: Resources } };
  expect(bytesByKind(diag.diagnostics?.resources?.resident ?? {})).toEqual(baseline);
  await page.getByTitle('Stop the play preview').click();
});

test('Play: a texture that is both the sky and a material\'s map is decoded once', async ({ page }) => {
  test.setTimeout(180_000);
  const pid = 'resources-sky';
  const p = await newProject(pid);
  await publish(pid, 'tex-sky', 'texture', makePng(64, 32, (_x, y) => (y < 16 ? [90, 150, 230, 255] : [60, 140, 60, 255])));
  await p.command('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'texture', texture: 'tex-sky' } } });
  await p.command('setMaterial', { material: { materialId: 'mat-sky', name: 'Sky map', shader: 'unlit', params: {}, textures: { map: 'tex-sky' } } });
  await p.command('createScene', { sceneId: 'scene-a', name: 'A' });
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  await p.command('createEntity', { sceneId: 'scene-a', kind: 'box', name: 'Box', transform: { position: [0, 0, 0] }, box: { size: [1, 1, 1], material: { color: '#ffffff' } }, components: { materials: { '*': 'mat-sky' } } });

  const relay = (path: string, body: unknown = {}) => be.post(`/api/v1/projects/${pid}/play/${path}`, body);
  await page.goto(`${be.origin}/?project=${pid}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; scenes?: { loaded?: string[] }; resources?: Resources };
  const observe = async (): Promise<Obs> => {
    const r = await relay(`${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  const settled = async (): Promise<Resources> => {
    await expect.poll(async () => { const r = (await observe()).resources!; return r.loading + r.waiting; }, { timeout: 30_000 }).toBe(0);
    return (await observe()).resources!;
  };
  // The sky decoded its texture for the environment.
  await expect.poll(async () => (await settled()).resident['texture']?.count ?? 0, { timeout: 30_000 }).toBe(1);
  const sky = await settled();
  expect(sky.loads['texture']).toBe(1);
  // The box wears the same texture: the sky's decode is shared, not repeated.
  expect((await relay(`${psid}/control`, { command: 'loadScene', sceneId: 'scene-a' })).status).toBe(200);
  await expect.poll(async () => (await observe()).scenes?.loaded?.includes('scene-a') === true, { timeout: 60_000 }).toBe(true);
  const both = await settled();
  expect(both.resident['texture']?.count).toBe(1);
  expect(both.loads['texture']).toBe(1);
  expect(Object.keys(both.resident)).not.toContain('environment');
  // Unloading the scene keeps it: the sky still holds it.
  expect((await relay(`${psid}/control`, { command: 'unloadScene', sceneId: 'scene-a' })).status).toBe(200);
  await expect.poll(async () => (await observe()).scenes?.loaded?.includes('scene-a') === false, { timeout: 60_000 }).toBe(true);
  const after = await settled();
  expect(after.resident['texture']?.count).toBe(1);
  expect(after.frees['texture'] ?? 0).toBe(0);
  await page.getByTitle('Stop the play preview').click();
});

test('Scene view: opening scene B frees the model only scene A showed', async ({ page }) => {
  test.setTimeout(180_000);
  const pid = 'resources-view';
  const p = await newProject(pid);
  await publish(pid, 'model-a', 'model', sphereGlb(3, 16, 32));
  await publish(pid, 'model-s', 'model', sphereGlb(4, 20, 32));
  await p.command('createScene', { sceneId: 'scene-a', name: 'Scene A' });
  await p.command('createScene', { sceneId: 'scene-b', name: 'Scene B' });
  await p.command('createEntity', { sceneId: 'scene-a', kind: 'model', name: 'Only A', transform: { position: [-2, 0, 0] }, model: { asset: { assetId: 'model-a' } } });
  await p.command('createEntity', { sceneId: 'scene-a', kind: 'model', name: 'Shared in A', transform: { position: [2, 0, 0] }, model: { asset: { assetId: 'model-s' } } });
  await p.command('createEntity', { sceneId: 'scene-b', kind: 'model', name: 'Shared in B', transform: { position: [2, 0, 0] }, model: { asset: { assetId: 'model-s' } } });

  await page.goto(`${be.origin}/?project=${pid}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const view = page.locator('.tl-viewport-host');
  const resident = async (): Promise<Resident> => JSON.parse((await view.getAttribute('data-resources')) ?? '{}') as Resident;
  await page.getByLabel('open scene', { exact: true }).selectOption({ label: 'Scene A' });
  await expect.poll(async () => (await resident())['model']?.count ?? 0, { timeout: 60_000 }).toBe(2);
  const both = (await resident())['model']!.bytes;
  // B opened and A closed: the view shows B's objects only.
  await page.getByLabel('open scene', { exact: true }).selectOption({ label: 'Scene B' });
  await page.getByLabel('close scene Scene A', { exact: true }).click();
  await expect.poll(async () => (await resident())['model']?.count ?? 0, { timeout: 60_000 }).toBe(1);
  expect((await resident())['model']!.bytes).toBeLessThan(both);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
