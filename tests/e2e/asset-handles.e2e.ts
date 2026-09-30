/**
 * Scripts' asset handles (`ctx.assets`) against a real backend in a real
 * browser.
 *
 * A project with two models, three textures and a prefab (a crate: model M
 * wearing a material with texture T1) that no start scene uses. The label
 * `batch` is on M, N, T1, T2 and the crate; `keep` is on T3. A project
 * script's debug commands load a key (and spawn a prefab once its handle is
 * ready) and release it (and destroy what it spawned).
 *
 * - Loading `batch`: the handle turns ready with the five ids, its models
 *   and textures are resident, and the crate the script spawns once it saw
 *   ready draws with them: M is not read or parsed again for it.
 * - Releasing it: every kind's resident bytes are back at the baseline.
 * - A handle not released: listed as open in the observation; a restart
 *   ends the run with it open, so it is released then and reported as not
 *   released (observation and Play diagnostics), and the resident bytes go
 *   back to the baseline.
 * - A key that names nothing fails, with why.
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
  root = join(PERF_ROOT, 'e2e', `handles-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

type Resident = Partial<Record<string, { count: number; bytes: number }>>;
interface HandleReport {
  handle: number;
  key: string;
  state: string;
  assets: number;
}
interface Resources {
  resident: Resident;
  loading: number;
  loads: Partial<Record<string, number>>;
  frees: Partial<Record<string, number>>;
  waiting: number;
  handles: number;
  open?: HandleReport[];
  notReleased?: HandleReport[];
  notReleasedCount?: number;
}

/** The script: `load {key, spawn}` loads a key (and spawns `spawn` once ready); `release {key}` releases it and destroys what it spawned. */
const DRIVER = [
  'export default {',
  '  instantiate() { return { handles: {} as Record<string, number>, spawnWhenReady: {} as Record<string, string>, spawned: [] as string[] }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const c of ctx.debug.command('load', { description: 'Load assets by key', args: [{ name: 'key', type: 'string' }, { name: 'spawn', type: 'string' }] })) {",
  '      state.handles[String(c.key)] = ctx.assets.load(String(c.key));',
  '      state.spawnWhenReady[String(c.key)] = String(c.spawn);',
  '    }',
  "    for (const c of ctx.debug.command('release', { description: 'Release a key', args: [{ name: 'key', type: 'string' }] })) {",
  '      ctx.assets.release(state.handles[String(c.key)]);',
  '      delete state.handles[String(c.key)];',
  '      for (const id of state.spawned) ctx.destroy(id);',
  '      state.spawned = [];',
  '    }',
  '    for (const key of Object.keys(state.handles)) {',
  '      const prefab = state.spawnWhenReady[key];',
  '      if (prefab === undefined || prefab === "" || !ctx.assets.ready(state.handles[key])) continue;',
  '      const id = ctx.spawn(prefab, { position: [0, 0, 0] });',
  '      if (id !== null) state.spawned.push(id);',
  '      state.spawnWhenReady[key] = "";',
  '    }',
  '  },',
  '};',
].join('\n');

async function publish(pid: string, assetId: string, kind: 'model' | 'texture', bytes: Uint8Array): Promise<void> {
  const p = be.project(pid);
  const stageId = await be.stage(pid, bytes);
  const inspected = await be.post(`/api/v1/projects/${pid}/content/stages/${stageId}/inspect`, { kind });
  const proposal = inspected.json['proposal'] as Record<string, unknown>;
  expect(proposal, JSON.stringify(inspected.json).slice(0, 300)).toBeDefined();
  await p.command('publishAsset', { mode: 'create', assetId, kind, displayName: assetId, sourceDigest: proposal['sourceDigest'], sourceByteLength: proposal['sourceByteLength'], importRecipe: proposal['importRecipe'], metrics: proposal['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
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

/** Resident bytes per kind (kinds with nothing resident left out). */
const bytesByKind = (r: Resident): Record<string, number> => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v.count > 0).map(([k, v]) => [k, v!.bytes]));

test('a script loads by label, waits for ready, spawns with what it loaded and releases it: resident back at the baseline; an unreleased handle is reported', async ({ page }) => {
  test.setTimeout(300_000);
  const pid = 'handles';
  const created = await be.post('/api/v1/admin/projects', { projectId: pid, name: pid });
  expect([200, 201]).toContain(created.status);
  const p = be.project(pid);
  await publish(pid, 'model-m', 'model', sphereGlb(1, 16, 32));
  await publish(pid, 'model-n', 'model', sphereGlb(2, 24, 32));
  await publish(pid, 'tex-1', 'texture', makePng(64, 64, () => [200, 40, 40, 255]));
  await publish(pid, 'tex-2', 'texture', makePng(32, 32, () => [40, 200, 40, 255]));
  await publish(pid, 'tex-3', 'texture', makePng(16, 16, () => [40, 40, 200, 255]));
  await p.command('setMaterial', { material: { materialId: 'mat-1', name: 'One', shader: 'unlit', params: {}, textures: { map: 'tex-1' } } });
  // The crate prefab, made from an object in a scene the game never loads.
  await p.command('createScene', { sceneId: 'scene-src', name: 'Source' });
  const crate = String((await p.command('createEntity', { sceneId: 'scene-src', kind: 'model', name: 'Crate', transform: { position: [0, 0, 0] }, model: { asset: { assetId: 'model-m' } }, components: { materials: { '*': 'mat-1' } } }))['createdId']);
  await p.command('createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: crate });
  await p.command('setStartScenes', { sceneIds: ['scene-main'] });
  await p.command('setLabels', { items: [{ kind: 'asset', id: 'model-m' }, { kind: 'asset', id: 'model-n' }, { kind: 'asset', id: 'tex-1' }, { kind: 'asset', id: 'tex-2' }, { kind: 'prefab', id: 'crate' }], add: ['batch'] });
  await p.command('setLabels', { items: [{ kind: 'asset', id: 'tex-3' }], add: ['keep'] });
  const driver = String((await p.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Driver', transform: { position: [0, -10, 0] } }))['createdId']);
  await installDriver(pid, driver);

  const relay = (path: string, body: unknown = {}) => be.post(`/api/v1/projects/${pid}/play/${path}`, body);
  await page.goto(`${be.origin}/?project=${pid}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; spawned?: { count: number; ids: string[] }; resources?: Resources };
  const observe = async (): Promise<Obs> => {
    const r = await relay(`${psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : {};
  };
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  const res = async (): Promise<Resources> => (await observe()).resources!;
  const settled = async (): Promise<Resources> => {
    await expect.poll(async () => { const r = await res(); return r.loading + r.waiting; }, { timeout: 30_000 }).toBe(0);
    return res();
  };
  const command = async (name: string, args: Record<string, string>): Promise<void> => {
    const r = await relay(`${psid}/control`, { command: 'debugCommand', name, args });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  // The baseline: the start scene holds nothing from assets.
  const base = await settled();
  const baseline = bytesByKind(base.resident);
  expect(base.handles).toBe(0);

  // Load the label: ready with its five ids; the script saw ready and spawned the crate.
  await command('load', { key: 'batch', spawn: 'crate' });
  await expect.poll(async () => (await res()).open?.[0]?.state, { timeout: 60_000 }).toBe('ready');
  expect((await res()).open).toEqual([{ handle: 1, key: 'batch', state: 'ready', assets: 5 }]);
  await expect.poll(async () => (await observe()).spawned?.count ?? 0, { timeout: 30_000 }).toBe(1);
  const loaded = await settled();
  expect(loaded.handles).toBe(1);
  expect(loaded.resident['model']?.count).toBe(2);
  expect(loaded.resident['texture']?.count).toBe(2);
  // The crate drew with what the handle loaded: no model was parsed for it.
  expect(loaded.loads['model']).toBe(2);

  // Release: every kind back at the baseline.
  await command('release', { key: 'batch' });
  await expect.poll(async () => (await observe()).spawned?.count ?? 0, { timeout: 30_000 }).toBe(0);
  await expect.poll(async () => bytesByKind((await settled()).resident), { timeout: 30_000 }).toEqual(baseline);
  expect((await res()).handles).toBe(0);
  expect((await res()).open).toBeUndefined();

  // A key that names nothing fails, with why.
  await command('load', { key: 'no-such-thing', spawn: '' });
  await expect.poll(async () => (await res()).open?.find((h) => h.key === 'no-such-thing')?.state, { timeout: 30_000 }).toBe('failed');
  await command('release', { key: 'no-such-thing' });

  // A handle not released: open in the observation; a restart ends the run with it and reports it.
  await command('load', { key: 'keep', spawn: '' });
  await expect.poll(async () => (await res()).open?.find((h) => h.key === 'keep')?.state, { timeout: 30_000 }).toBe('ready');
  expect((await settled()).resident['texture']?.count).toBe(1);
  expect((await relay(`${psid}/control`, { command: 'replay' })).status).toBe(200);
  await expect.poll(async () => (await res()).notReleasedCount ?? 0, { timeout: 30_000 }).toBe(1);
  const after = await settled();
  expect(after.notReleased).toEqual([{ handle: 3, key: 'keep', state: 'ready', assets: 1 }]);
  expect(after.handles).toBe(0);
  expect(bytesByKind(after.resident)).toEqual(baseline);
  // Play's diagnostics carry the same report, and the script log says which handle it was.
  const diag = (await relay(`${psid}/diagnostics`)).json as { diagnostics?: { resources?: Resources; runtime?: unknown } };
  expect(diag.diagnostics?.resources?.notReleased).toEqual([{ handle: 3, key: 'keep', state: 'ready', assets: 1 }]);
  expect(JSON.stringify(diag.diagnostics)).toContain('not released when the run ended');
  await page.getByTitle('Stop the play preview').click();
});
