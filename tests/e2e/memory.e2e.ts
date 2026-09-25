/**
 * Phase 21.5: leak tests against the real backend in a real browser. Each
 * test repeats one open/close (or load/unload) many times on small neutral
 * fixtures and checks that the page comes back to its baseline (taken after
 * two warm-up cycles): the JS heap after a garbage collection (CDP), the
 * graphics API counts per live WebGL context / WebGPU device (the perf
 * harness's instrumentation, which also counts live contexts, devices and
 * workers) and the renderer's own `info.memory` counts (the Scene view's
 * `data-memory`, Play's diagnostics). See memory-probe.ts.
 *
 * - every centre document tab kind (Animator, Script, Graph, Material,
 *   Visual script, Effect) opened and closed 50× — the material and effect
 *   tabs carry a preview renderer each;
 * - the preview panes 50×: the asset browser's model preview and the
 *   Animator's live preview (the material and effect previews are their
 *   tabs above), and the material preview's shapes;
 * - the Scene view: an editor scene closed/opened 50× (its objects leave and
 *   come back), instancing groups formed and dissolved 50×, the renderer
 *   backend swapped 10× (a new canvas each time);
 * - Play started and stopped 20× (iframe, simulation worker, renderer);
 * - in one Play session: an additive scene loaded/unloaded 50×, a level
 *   restarted 20× (`replay`), and scripts spawning and destroying copies.
 *
 * Renderer-specific tests run in both projects (`default`: WebGL 2,
 * `webgpu`: WebGPU); the rest only in `default`. Numbers go to the log
 * (`[memory] …` lines) and docs/plan-phase-21.md §4.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Frame, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { cycles, describe as summary, expectBack, installProbe, MemoryProbe, TOLERANCE, type MemorySample, type Tolerance } from './memory-probe';
import { skinnedGlb } from './skinned-glb';

// Small scenes, a smaller page: the CPU renderer draws each frame faster (the counts do not depend on the size).
test.use({ viewport: { width: 1280, height: 720 } });

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

const webgpuProject = (): boolean => test.info().project.name === 'webgpu';
/** The editor URL for this project's backend (`webgpu`: forced, so a fallback cannot pass silently). */
const editorUrl = (): string => (webgpuProject() ? be.editorUrl.replace('#', '&renderer=webgpu#') : be.editorUrl);
const load = (): string => loadavg().map((x) => x.toFixed(1)).join(' / ');

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject'))['revision']),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-memory' },
    args,
  });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function openEditor(page: Page, url = editorUrl()): Promise<MemoryProbe> {
  await installProbe(page.context());
  await page.goto(url);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect(page.locator('canvas.tl-viewport')).toHaveAttribute('data-memory', /geometries/, { timeout: 30_000 });
  return MemoryProbe.attach(page);
}

/** Run `once` twice (warm-up: caches, programs, lazily made workers), take the baseline, run it `n` times, settle, check. */
async function leakCheck(page: Page, probe: MemoryProbe, label: string, n: number, once: (i: number) => Promise<void>, frame?: () => Frame, tol: Tolerance = TOLERANCE): Promise<{ base: MemorySample; after: MemorySample }> {
  for (let i = 0; i < 2; i++) await once(-1 - i);
  const base = await probe.sample(frame?.());
  const t0 = Date.now();
  for (let i = 0; i < n; i++) await once(i);
  const after = await probe.settle(base, tol, frame?.());
  console.log(`${summary(`${label} [${test.info().project.name}]`, base, after, n)} | ${((Date.now() - t0) / 1000).toFixed(1)} s | load ${load()}`);
  expectBack(label, base, after, tol);
  return { base, after };
}

/** Upload the skinned test model (clips idle/bend) through the asset browser; its asset id. */
async function importModel(page: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tl-memory-'));
  writeFileSync(join(dir, 'column.glb'), skinnedGlb());
  await page.getByRole('tab', { name: 'Assets', exact: true }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(join(dir, 'column.glb'));
  rmSync(dir, { recursive: true, force: true });
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__status')).toContainText('committed', { timeout: 15_000 });
  const assets = (await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string }[];
  return assets[0]!.assetId;
}

const tab = (page: Page, name: string): Locator => page.getByRole('tab', { name, exact: true });

/** A looping stream of billboards (neutral fixture, as in effect-editor.e2e). */
function streamEffect(): Record<string, unknown> {
  const nodes = [
    ...['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] })),
    { id: 'rate', type: 'spawn.rate', position: [250, 0], data: { rate: 40 } },
    { id: 'life', type: 'init.lifetime', position: [250, 200], data: { min: 1, max: 1 } },
    { id: 'size', type: 'init.size', position: [500, 200], data: { min: 0.2, max: 0.2 } },
    { id: 'board', type: 'output.billboard', position: [250, 600], data: { blend: 'additive' } },
  ];
  const edges = [
    { id: 'e0', from: { node: 'spawn', port: 'then' }, to: { node: 'rate', port: 'in' } },
    { id: 'e1', from: { node: 'initialize', port: 'then' }, to: { node: 'life', port: 'in' } },
    { id: 'e2', from: { node: 'life', port: 'then' }, to: { node: 'size', port: 'in' } },
    { id: 'e3', from: { node: 'output', port: 'then' }, to: { node: 'board', port: 'in' } },
  ];
  return { effectId: 'fx-stream', name: 'Stream', duration: 2, loop: true, seed: 5, bounds: { center: [0, 1, 0], size: [4, 4, 4] }, systems: [{ systemId: 'motes', name: 'Motes', maxParticles: 500, space: 'local', graph: { nodes, edges } }] };
}

/** A graph material (colour → PBR output; neutral fixture). */
const GRAPH_MATERIAL = {
  materialId: 'mat-graph',
  name: 'Graph',
  shader: 'standard',
  params: {},
  textures: {},
  graph: {
    nodes: [
      { id: 'output', type: 'pbr', position: [400, 0] },
      { id: 'tint', type: 'color', position: [0, 0], data: { color: '#3080ff' } },
    ],
    edges: [{ id: 'w1', from: { node: 'tint', port: 'rgb' }, to: { node: 'output', port: 'baseColor' } }],
  },
};

test('document tabs: every kind opened and closed 50× returns heap and GPU counts to the baseline', async ({ page }) => {
  test.setTimeout(900_000);
  be = await startBackend('memory-tabs');
  await cmd('publishBehavior', { behaviorId: 'mover', displayName: 'Mover', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 2 }] } });
  await cmd('setMaterial', { material: GRAPH_MATERIAL });
  await cmd('setEffect', { effect: streamEffect() });
  const probe = await openEditor(page);
  const asset = await importModel(page);
  await cmd('setAnimator', {
    controller: {
      controllerId: 'animator-01',
      name: 'Walker',
      parameters: [{ name: 'speed', type: 'float', default: 0 }],
      states: [{ id: 'state-01', name: 'Idle', motion: { kind: 'clip', clip: { assetId: asset, clip: 'idle', duration: 1 } }, speed: 1, loop: true, position: [180, 40] }],
      transitions: [],
      entry: 'state-01',
      events: [],
    },
  });
  // A standalone graph and a visual script, made in the editor (their tabs open once; closed here).
  await tab(page, 'Graphs').click();
  await page.getByLabel('Graph kind').selectOption('test');
  await page.getByLabel('New graph name').fill('Maths');
  await page.getByRole('button', { name: 'Create graph' }).click();
  await expect(tab(page, 'Graph: Maths')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Close Graph: Maths', exact: true }).click();
  await tab(page, 'Behaviors').click();
  await page.getByLabel('New visual script name').fill('Gift giver');
  await page.getByRole('button', { name: '+ Visual script' }).click();
  await expect(tab(page, 'Graph: Gift giver')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Close Graph: Gift giver', exact: true }).click();

  const n = cycles(50);
  const kinds: { label: string; dock: string; open: () => Promise<void>; title: string; ready: (view: Locator) => Promise<void> }[] = [
    {
      label: 'Animator tab',
      dock: 'Animator',
      title: 'Animator: Walker',
      open: () => page.getByLabel('animator controllers').getByRole('button', { name: 'Walker' }).dblclick(),
      ready: (v) => expect(v.getByLabel('animator graph').getByRole('group', { name: 'State Idle node state-01' })).toBeVisible(),
    },
    {
      label: 'Script tab',
      dock: 'Behaviors',
      title: 'Script: Mover',
      open: () => page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Mover' }).dblclick(),
      ready: (v) => expect(v.locator('.cm-editor')).toBeVisible(),
    },
    {
      label: 'Graph tab',
      dock: 'Graphs',
      title: 'Graph: Maths',
      open: () => page.locator('[data-graph-id] .tl-graphs__meta').first().dblclick(),
      ready: (v) => expect(v.locator('.tl-graph__stage')).toBeVisible(),
    },
    {
      label: 'Material tab (with its preview)',
      dock: 'Materials',
      title: 'Material: Graph',
      open: () => page.locator('.tl-materials li[data-material-id="mat-graph"]').dblclick(),
      ready: async (v) => expect.poll(async () => Number((await v.getByLabel('material preview canvas').getAttribute('data-tl-preview-frames')) ?? 0), { timeout: 30_000 }).toBeGreaterThan(0),
    },
    {
      label: 'Visual script tab',
      dock: 'Behaviors',
      title: 'Graph: Gift giver',
      open: () => page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Gift giver' }).dblclick(),
      ready: (v) => expect(v.getByLabel('visual script', { exact: true })).toBeVisible(),
    },
    {
      label: 'Effect tab (with its preview)',
      dock: 'Effects',
      title: 'Effect: Stream',
      open: () => page.getByRole('button', { name: 'Open Stream' }).click(),
      ready: async (v) => expect.poll(async () => JSON.parse((await v.getByLabel('effect preview canvas').getAttribute('data-tl-effect-preview')) ?? '{}').executor ?? null, { timeout: 30_000 }).not.toBeNull(),
    },
  ];
  for (const k of kinds) {
    // Renderer-free tabs are the same on both backends: only the preview tabs run again in the webgpu project.
    if (webgpuProject() && !k.label.includes('preview')) continue;
    await tab(page, k.dock).click();
    await leakCheck(page, probe, k.label, n, async () => {
      await k.open();
      await expect(tab(page, k.title)).toHaveAttribute('aria-selected', 'true');
      await k.ready(page.getByRole('tabpanel', { name: k.title }));
      await page.getByRole('button', { name: `Close ${k.title}`, exact: true }).click();
      await expect(tab(page, k.title)).toHaveCount(0);
    });
  }
  await probe.detach();
});

test('preview panes: the asset preview, the Animator preview and the material preview shapes, 50× each', async ({ page }) => {
  test.setTimeout(600_000);
  be = await startBackend('memory-previews');
  await cmd('setMaterial', { material: GRAPH_MATERIAL });
  const probe = await openEditor(page);
  const asset = await importModel(page);
  await cmd('setAnimator', {
    controller: {
      controllerId: 'animator-01',
      name: 'Walker',
      parameters: [],
      states: [{ id: 'state-01', name: 'Idle', motion: { kind: 'clip', clip: { assetId: asset, clip: 'idle', duration: 1 } }, speed: 1, loop: true, position: [180, 40] }],
      transitions: [],
      entry: 'state-01',
      events: [],
    },
  });
  const n = cycles(50);

  // The asset browser's preview: a new canvas and renderer each time the Assets tab shows the selected model.
  await tab(page, 'Assets').click();
  await page.locator('.tl-assets__list .tl-tile').first().click();
  await leakCheck(page, probe, 'Asset preview (Assets tab shown/hidden, model loaded)', n, async () => {
    await tab(page, 'Assets').click();
    await expect(page.locator('.tl-assets__preview-canvas')).toHaveAttribute('data-tl-renderer-state', 'ready', { timeout: 30_000 });
    await page.getByRole('button', { name: 'load preview' }).click();
    await expect(page.locator('.tl-assets__preview-body')).toBeVisible();
    await tab(page, 'Problems').click();
    await expect(page.locator('.tl-assets__preview-canvas')).toHaveCount(0);
  });

  // The Animator's live preview in its tab: started and stopped.
  await tab(page, 'Animator').click();
  await page.getByLabel('animator controllers').getByRole('button', { name: 'Walker' }).dblclick();
  const view = page.getByRole('tabpanel', { name: 'Animator: Walker' });
  await leakCheck(page, probe, 'Animator preview', n, async () => {
    await view.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(view.getByLabel('animator preview', { exact: true })).toHaveAttribute('data-state', 'Idle', { timeout: 30_000 });
    await view.getByRole('button', { name: 'Stop preview' }).click();
    await expect(view.getByLabel('animator preview', { exact: true })).toHaveCount(0);
  });
  await page.getByRole('button', { name: 'Close Animator: Walker', exact: true }).click();

  // The material preview: its primitive shapes switched (a shape owns its geometry and material).
  await tab(page, 'Materials').click();
  await page.locator('.tl-materials li[data-material-id="mat-graph"]').dblclick();
  const mat = page.getByRole('tabpanel', { name: 'Material: Graph' });
  const canvas = mat.getByLabel('material preview canvas');
  const frames = async (): Promise<number> => Number((await canvas.getAttribute('data-tl-preview-frames')) ?? 0);
  await expect.poll(frames, { timeout: 30_000 }).toBeGreaterThan(0);
  await leakCheck(page, probe, 'Material preview shapes (sphere → cube → plane)', n, async () => {
    for (const shape of ['cube', 'plane', 'sphere']) {
      const before = await frames();
      await mat.getByLabel('preview shape').selectOption(shape);
      await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(before + 1);
    }
  });
  await probe.detach();
});

test('Scene view: an editor scene closed and opened 50×, instancing groups re-formed 50×, the backend swapped 10×', async ({ page }) => {
  test.setTimeout(600_000);
  be = await startBackend('memory-scene-view');
  // A second scene with boxes of two colours and a light (neutral fixture).
  await cmd('createScene', { sceneId: 'scene-side', name: 'Side' });
  for (let i = 0; i < 6; i++) await cmd('createEntity', { sceneId: 'scene-side', kind: 'box', name: `Side box ${i}`, transform: { position: [i * 1.5 - 4, 0.5, -3] }, box: { size: [1, 1, 1], material: { color: i % 2 === 0 ? '#c05050' : '#50c050' } } });
  await cmd('createEntity', { sceneId: 'scene-side', kind: 'group', name: 'Side lamp', transform: { position: [0, 3, -3] }, components: { light: { type: 'point', color: '#ffffff', intensity: 2, range: 8 } } });
  // Four equal boxes in the main scene: one instancing group (≥ 4 members).
  const boxes: string[] = [];
  for (let i = 0; i < 4; i++) boxes.push(String((await cmd('createEntity', { kind: 'box', name: `Row box ${i}`, transform: { position: [i * 1.5 - 2, 0.5, 2] }, box: { size: [1, 1, 1], material: { color: '#8080ff' } } }))['createdId']));
  const probe = await openEditor(page);
  const view = page.locator('canvas.tl-viewport');
  const frames = async (): Promise<number> => Number((await view.getAttribute('data-frames')) ?? 0);
  const header = page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: /^Side$/ }) });
  if ((await header.count()) === 0) await page.getByLabel('open scene').selectOption({ label: 'Side' });
  await expect(header).toHaveCount(1);
  const n = cycles(50);

  if (!webgpuProject()) {
    await leakCheck(page, probe, 'Editor scene closed/opened', n, async () => {
      await header.getByRole('button', { name: 'close scene Side' }).click();
      await expect(header).toHaveCount(0);
      const f = await frames();
      await page.getByLabel('open scene').selectOption({ label: 'Side' });
      await expect(header).toHaveCount(1);
      await expect.poll(frames).toBeGreaterThan(f);
    });

    // Instancing: hiding one of the four boxes dissolves the group (3 < 4), showing it forms it again.
    const batches = async (): Promise<string> => (await view.getAttribute('data-batches')) ?? '';
    await expect.poll(batches, { timeout: 15_000 }).toMatch(/^[1-9]/);
    const grouped = await batches();
    await leakCheck(page, probe, 'Instancing group dissolved/formed', n, async () => {
      await cmd('updateEntity', { entityId: boxes[0]!, active: false });
      await expect.poll(batches).not.toBe(grouped);
      await cmd('updateEntity', { entityId: boxes[0]!, active: true });
      await expect.poll(batches).toBe(grouped);
    });
  }

  // The renderer backend swapped by the project setting: a new canvas and renderer each time.
  // default project: `webgpu` falls back to WebGL 2 on a fresh canvas; webgpu project: WebGPU ↔ WebGL 2.
  // (The URL flag would pin the backend: this page is opened without it.)
  if (webgpuProject()) {
    await page.goto(be.editorUrl);
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    await expect(view).toHaveAttribute('data-memory', /geometries/, { timeout: 30_000 });
  }
  const setting = async (value: number, backend: string): Promise<void> => {
    await cmd('setSettings', { settings: { render_backend: value } });
    await expect.poll(async () => `${await view.getAttribute('data-tl-renderer-state')}/${await view.getAttribute('data-tl-renderer')}/${await view.getAttribute('data-tl-renderer-reason')}`, { timeout: 30_000 }).toMatch(new RegExp(`^ready/${backend}/.*setting ${value === 2 ? 'webgpu' : 'webgl2'}`));
    // A frame on the new renderer (the new canvas copied the old one's data-* attributes).
    const f = await frames();
    const box = (await view.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => {
      await page.mouse.wheel(0, -20);
      return frames();
    }, { timeout: 30_000 }).toBeGreaterThan(f);
  };
  await setting(3, 'webgl2');
  await leakCheck(page, probe, 'Renderer backend swapped (setting webgpu ↔ webgl2)', cycles(10), async () => {
    await setting(2, webgpuProject() ? 'webgpu' : 'webgl2');
    await setting(3, 'webgl2');
  });
  await probe.detach();
});

/** Start Play from the editor: the play session id, the relay and the preview frame. */
async function startPlay(page: Page): Promise<{ psid: string; relay: (path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>; frame: () => Frame }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const relay = (path: string, body: unknown = {}) => api(`play/${psid}/${path}`, body);
  await expect.poll(async () => (await relay('observe')).json['state'], { timeout: 60_000 }).toMatch(/awaitingStart|playing/);
  const frame = (): Frame => {
    const f = page.frames().find((x) => x !== page.mainFrame() && x.url().includes('/play'));
    if (f === undefined) throw new Error('no preview frame');
    return f;
  };
  return { psid, relay, frame };
}

async function stopPlay(page: Page): Promise<void> {
  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('iframe')).toHaveCount(0, { timeout: 30_000 });
}

test('Play started and stopped 20× returns the editor page to its baseline (iframe, worker, renderer)', async ({ page }) => {
  test.setTimeout(600_000);
  be = await startBackend('memory-play', 'beacon-reach');
  const probe = await openEditor(page);
  await leakCheck(page, probe, 'Play start/stop', cycles(20), async () => {
    const { relay } = await startPlay(page);
    expect((await relay('control', { command: 'start' })).status).toBe(200);
    await expect.poll(async () => (await relay('observe')).json['state'], { timeout: 30_000 }).toBe('playing');
    await stopPlay(page);
  });
  expect(page.frames()).toHaveLength(1);
  await probe.detach();
});

/** Publish a behavior with this source and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string, ownedTransforms: string[] = []): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms, files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json['stageId']);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'every', label: 'Steps between spawns', type: 'number', default: 12, min: 1, max: 1000, step: 1 }] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject'))['revision']), requestId: `req-${createHash('sha256').update(behaviorId).digest('hex').slice(0, 32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: { every: 12 } });
}

/**
 * A spawner: every `every` steps one box copy and one skinned-model copy
 * beside itself; the last three pairs stay, older ones are destroyed — so
 * three of each are alive at any time once it has run four times.
 */
const SPAWNER = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return { shots: [] as string[][] }; },',
  '  step(state: { shots: string[][] }, ctx: any) {',
  '    if (ctx.stepIndex % Math.max(1, Math.round(ctx.properties.every)) !== 0) return;',
  '    const me = ctx.world.transform(ctx.entityId);',
  '    if (me === undefined) return;',
  "    const a = ctx.spawn('projectile', { position: [me.position[0] + 1, me.position[1] + 1] });",
  "    const b = ctx.spawn('statue', { position: [me.position[0] + 2, me.position[1]] });",
  '    if (a === null || b === null) return;',
  "    ctx.game.add('shots', 1);",
  '    state.shots.push([a, b]);',
  '    if (state.shots.length > 3) for (const id of state.shots.shift()!) ctx.destroy(id);',
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

for (const threads of ['off', 'worker'] as const) {
  test(`one Play session (${threads === 'off' ? 'simulation in the page' : 'simulation worker'}): an additive scene loaded/unloaded 50×, the level restarted 20×, copies spawned and destroyed`, async ({ page }) => {
    test.setTimeout(900_000);
    // The webgpu project runs the default mode (the worker) only: the page-thread composition is the same adapter.
    test.skip(webgpuProject() && threads === 'off', 'the webgpu project runs the worker mode');
    be = await startBackend(`memory-play-scenes-${threads}`, 'beacon-reach');
    // The side scene: a backdrop, crates, an effect emitter and (below, once uploaded) a model — behind the
    // player's start, in view (objects out of view are never uploaded, so their release would not show).
    await cmd('createScene', { sceneId: 'scene-side', name: 'Side' });
    await cmd('createEntity', { sceneId: 'scene-side', kind: 'box', name: 'Side backdrop', transform: { position: [2, 1, -4] }, box: { size: [10, 4, 0.4], material: { color: '#4a3f5c' } } });
    for (let i = 0; i < 5; i++) await cmd('createEntity', { sceneId: 'scene-side', kind: 'box', name: `Side crate ${i}`, transform: { position: [-1 + i * 1.2, 0.5, -2.5] }, box: { size: [1, 1, 1], material: { color: '#b08040' } } });
    await cmd('setEffect', { effect: streamEffect() });
    const emitter = String((await cmd('createEntity', { sceneId: 'scene-side', kind: 'group', name: 'Side emitter', transform: { position: [1, 1.5, -2] } }))['createdId']);
    await cmd('setComponent', { entityId: emitter, component: 'effect', value: { effectId: 'fx-stream' } });
    // The spawned copy: a small box prefab made from a scene box (then removed from the scene).
    const bolt = String((await cmd('createEntity', { kind: 'box', name: 'Bolt', transform: { position: [0, 30, 0] }, box: { size: [0.3, 0.3, 0.3], material: { color: '#ff00ff' } } }))['createdId']);
    await cmd('createPrefab', { prefabId: 'projectile', displayName: 'Projectile', sourceEntityId: bolt });
    await cmd('deleteEntity', { entityId: bolt });
    // The spawner sits in its own scene, loaded for the spawn phase only (near the player's start, in view).
    await cmd('createScene', { sceneId: 'scene-spawn', name: 'Spawn' });
    const spawner = String((await cmd('createEntity', { sceneId: 'scene-spawn', kind: 'box', name: 'Spawner', transform: { position: [3, 0.5, -1] }, box: { size: [0.4, 0.4, 0.4], material: { color: '#40c0c0' } } }))['createdId']);
    await script('spawner', SPAWNER, spawner);

    const probe = await openEditor(page, `${editorUrl().replace('#', `&threads=${threads}#`)}`);
    // The second spawned copy: the skinned test model (its own geometry, skeleton and animation mixer).
    const assetId = await importModel(page);
    const statue = String((await cmd('createEntity', { kind: 'model', name: 'Statue', model: { asset: { assetId } }, transform: { position: [0, 30, 0], scale: [0.4, 0.4, 0.4] } }))['createdId']);
    await cmd('createPrefab', { prefabId: 'statue', displayName: 'Statue', sourceEntityId: statue });
    await cmd('deleteEntity', { entityId: statue });
    await cmd('createEntity', { sceneId: 'scene-side', kind: 'model', name: 'Side statue', model: { asset: { assetId } }, transform: { position: [5, 0, -2.5], scale: [0.5, 0.5, 0.5] } });
    const { relay, frame } = await startPlay(page);
    expect((await relay('control', { command: 'start' })).status).toBe(200);
    await expect.poll(async () => (await relay('observe')).json['state'], { timeout: 30_000 }).toBe('playing');
    const observe = async (): Promise<{ scenes?: { loaded: string[] }; counters?: Record<string, number>; spawned?: unknown[] }> => (await relay('observe')).json as never;
    const gpu = async (): Promise<Record<string, number>> => ((await relay('diagnostics')).json['diagnostics'] as { renderer: { gpu: Record<string, number> } }).renderer.gpu;
    const loaded = async (): Promise<string[]> => (await observe()).scenes?.loaded ?? [];

    // Renderer counts are compared with the spawner paused (a pause keeps the scene set and the copies still).
    const pausedGpu = async (): Promise<Record<string, number>> => {
      expect((await relay('control', { command: 'debugPause' })).status).toBe(200);
      await page.waitForTimeout(300);
      const g = await gpu();
      expect((await relay('control', { command: 'debugResume' })).status).toBe(200);
      return g;
    };
    const checkGpu = async (label: string, base: Record<string, number>): Promise<void> => {
      let now = await pausedGpu();
      const until = Date.now() + 15_000;
      const grown = (): string[] => Object.keys(now).filter((k) => (now[k] ?? 0) > (base[k] ?? 0) + 2);
      while (grown().length > 0 && Date.now() < until) {
        await page.waitForTimeout(500);
        now = await pausedGpu();
      }
      console.log(`[memory] ${label} [${test.info().project.name}, threads ${threads}] Play renderer ${JSON.stringify(base)} → ${JSON.stringify(now)}`);
      expect.soft(grown().map((k) => `${k} ${base[k]} → ${now[k]}`), `${label}: Play renderer counts not back`).toEqual([]);
    };

    // While the game keeps running V8 keeps compiling and optimising its code: a heap snapshot of this loop
    // (20 cycles) grew 1.3 MiB, 1.0 MiB of it compiled code and the performance timeline's entries, ~90 KiB
    // objects (three's node caches). The heap bound here is 4 MiB; objects leaking per cycle show in the
    // GPU counts and in the renderer's own counts, which stay exact.
    const playTol: Tolerance = { ...TOLERANCE, heapMiB: 4 };
    let base = await pausedGpu();
    const scenes = await leakCheck(page, probe, `Play: additive scene loaded/unloaded (threads ${threads})`, cycles(50), async () => {
      const lr = await relay('control', { command: 'loadScene', sceneId: 'scene-side' });
      expect(lr.status).toBe(200);
      await expect.poll(loaded, { timeout: 30_000 }).toContain('scene-side');
      expect((await relay('control', { command: 'unloadScene', sceneId: 'scene-side' })).status).toBe(200);
      await expect.poll(loaded, { timeout: 30_000 }).not.toContain('scene-side');
    }, frame, playTol);
    await checkGpu('Play: additive scene loaded/unloaded', base);

    base = await pausedGpu();
    // A level restart (`replay`: the start scenes only again) with the side scene loaded each time.
    await leakCheck(page, probe, `Play: level restarted with a scene loaded (threads ${threads})`, cycles(20), async () => {
      expect((await relay('control', { command: 'loadScene', sceneId: 'scene-side' })).status).toBe(200);
      await expect.poll(loaded, { timeout: 30_000 }).toContain('scene-side');
      const run = String((await relay('observe')).json['runId']);
      const r = await relay('control', { command: 'replay' });
      expect(r.json['ok'], JSON.stringify(r.json)).toBe(true);
      await expect.poll(async () => { const o = (await relay('observe')).json; return `${o['runId'] !== run}/${o['state']}`; }, { timeout: 30_000 }).toBe('true/playing');
      await expect.poll(loaded, { timeout: 30_000 }).not.toContain('scene-side');
    }, frame, playTol);
    await checkGpu('Play: level restarted with a scene loaded', base);

    // Spawn/destroy: the spawner's scene loaded; after a warm-up (three pairs alive from then on), over
    // 100 more pairs (one per 12 steps at 120 Hz) the counts stay where they were.
    expect((await relay('control', { command: 'loadScene', sceneId: 'scene-spawn' })).status).toBe(200);
    await expect.poll(loaded, { timeout: 30_000 }).toContain('scene-spawn');
    await expect.poll(async () => (await observe()).counters?.['shots'] ?? 0, { timeout: 60_000 }).toBeGreaterThan(5);
    base = await pausedGpu();
    const heapBase = await probe.sample(frame());
    const shots0 = (await observe()).counters?.['shots'] ?? 0;
    await expect.poll(async () => (await observe()).counters?.['shots'] ?? 0, { timeout: 300_000, intervals: [2000] }).toBeGreaterThan(shots0 + cycles(100));
    // Held still while the page settles (the spawner would keep adding garbage).
    expect((await relay('control', { command: 'debugPause' })).status).toBe(200);
    const pairs = ((await observe()).counters?.['shots'] ?? 0) - shots0;
    const heapAfter = await probe.settle(heapBase, playTol, frame());
    console.log(`${summary(`Play: copies spawned/destroyed, pairs (threads ${threads}) [${test.info().project.name}]`, heapBase, heapAfter, pairs)} | load ${load()}`);
    expect((await relay('control', { command: 'debugResume' })).status).toBe(200);
    await checkGpu('Play: copies spawned/destroyed', base);
    expectBack('Play: copies spawned/destroyed', heapBase, heapAfter, playTol);
    expect(scenes.after.gpu.webglContexts + scenes.after.gpu.webgpuDevices).toBe(1);
    await stopPlay(page);
    await probe.detach();
  });
}
