/**
 * Phase 22.1: heavy editor jobs off the main thread, in a real browser
 * against the real backend.
 *
 * Long tasks (PerformanceObserver 'longtask', > 50 ms on the main thread) are
 * recorded over each job's window: a scatter of N copies into an instance
 * set, a preview bake, the asset tiles' thumbnails, graph diagnostics after
 * an edit of a 2000-node graph, and the projection of a change in a project
 * with a few thousand objects. Each window logs a `[editor-workers]` line
 * (count, longest, total) with the load average. The scatter and the preview
 * bake assert a bound on the longest task (relative and generous: this host
 * renders on the CPU and is shared with other test runs — see
 * docs/plan-phase-22.md §5 for the numbers and the bound).
 *
 * `TL_EDITOR_DIR=<dir>` serves another editor build (the "before" numbers
 * came from the pre-22.1 bundle); `TL_WORKERS_MEASURE_ONLY=1` logs without
 * asserting the bounds. `?workers=off` (the editor's own flag) runs every job
 * inline — the test checks both paths give the same result.
 */
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { editorUrlFor, expectRendererBackend } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

const extraEnv = (): Record<string, string> => (process.env['TL_EDITOR_DIR'] !== undefined ? { THIRDLIGHT_EDITOR_DIR: process.env['TL_EDITOR_DIR'] } : {});
const measureOnly = process.env['TL_WORKERS_MEASURE_ONLY'] === '1';
const label = process.env['TL_EDITOR_DIR'] !== undefined ? 'before' : 'after';

/**
 * The bound on the longest main-thread task during a scatter and a preview
 * bake. Before 22.1 these jobs blocked the main thread for 0.3–2 s here
 * (CPU renderer, shared host); after, what is left is the editor's own
 * frames and React commits. 400 ms is generous on purpose: this host's load
 * average swings between 8 and 25 while other suites run, which stretches
 * every task several times over.
 */
const LONGEST_TASK_BOUND_MS = 400;

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __tlLong: { start: number; duration: number }[] };
    w.__tlLong = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__tlLong.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* long tasks not observable */
    }
  });
}

/**
 * `TL_WORKERS_PROFILE=1`: a CDP CPU profile of the window, the top self-time
 * functions logged (which code the long tasks are).
 */
async function startProfile(page: Page): Promise<{ stop(what: string): Promise<void> }> {
  if (process.env['TL_WORKERS_PROFILE'] !== '1') return { stop: async () => undefined };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  return {
    async stop(what: string): Promise<void> {
      const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; samples: number[]; timeDeltas: number[] } };
      const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
      const self = new Map<string, number>();
      profile.samples.forEach((id, i) => {
        const n = byNode.get(id)!;
        const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
        self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
      });
      const top = [...self.entries()].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((a, b) => b[1] - a[1]).slice(0, 14);
      console.log(`[editor-workers] ${label} profile ${what}: ${top.map(([k, ms]) => `${k} ${ms.toFixed(0)}ms`).join(' | ')}`);
      await cdp.detach();
    },
  };
}

/** The measurements run in the `default` project; the thumbnail test also runs in `webgpu` (the snapshot of a WebGPU canvas). */
const defaultProjectOnly = (): void => test.skip(test.info().project.name === 'webgpu', 'measured in the default project');

const now = (page: Page): Promise<number> => page.evaluate(() => performance.now());

interface LongTasks {
  count: number;
  longestMs: number;
  totalMs: number;
  windowMs: number;
}

async function longTasksSince(page: Page, t0: number): Promise<LongTasks> {
  return page.evaluate((since) => {
    const list = (window as unknown as { __tlLong: { start: number; duration: number }[] }).__tlLong.filter((e) => e.start + e.duration >= since);
    return {
      count: list.length,
      longestMs: Math.round(list.reduce((m, e) => Math.max(m, e.duration), 0)),
      totalMs: Math.round(list.reduce((s, e) => s + e.duration, 0)),
      windowMs: Math.round(performance.now() - since),
    };
  }, t0);
}

function report(what: string, lt: LongTasks, extra: Record<string, unknown> = {}): void {
  const load = loadavg().map((v) => v.toFixed(1)).join(' ');
  console.log(`[editor-workers] ${label} ${what}: long tasks ${lt.count}, longest ${lt.longestMs} ms, total ${lt.totalMs} ms over ${lt.windowMs} ms; load ${load} ${JSON.stringify(extra)}`);
}

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${seq}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-editor-workers' },
    args,
  });
  expect(res.ok, JSON.stringify(res).slice(0, 400)).toBe(true);
  return res;
}

/** Settle: wait until a whole second passes without a long task (bounded), so a window starts quiet. */
async function settle(page: Page, maxMs = 20_000): Promise<void> {
  const until = Date.now() + maxMs;
  for (;;) {
    const t = await now(page);
    await page.waitForTimeout(1000);
    if ((await longTasksSince(page, t)).count === 0 || Date.now() > until) return;
  }
}

async function scatter(page: Page, copies: number, seed: number, rowsAfter = 1): Promise<string[]> {
  await menu(page, 'GameObject', 'Instance set…');
  const dialog = page.getByRole('dialog', { name: 'Instance set' });
  await dialog.getByLabel('instance model').selectOption({ label: 'Beacon pillar' });
  await dialog.getByLabel('Copies').fill(String(copies));
  await dialog.getByLabel('Width (X, m)').fill('200');
  await dialog.getByLabel('Depth (Z, m)').fill('200');
  await dialog.getByLabel('Seed').fill(String(seed));
  await dialog.getByRole('button', { name: 'Create instance set' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  const rows = page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: `Beacon pillar ×${copies}` });
  await expect(rows).toHaveCount(rowsAfter, { timeout: 60_000 });
  // Every set of this size (the newest last): their buffers.
  const ids = await rows.evaluateAll((els) => els.map((e) => String(e.getAttribute('data-entity-id'))));
  const buffers: string[] = [];
  for (const id of ids) {
    const entity = (await query('queryEntity', { entityId: id })).entity as { components: { instances: { buffer: string; count: number } } };
    expect(entity.components.instances.count).toBe(copies);
    buffers.push(entity.components.instances.buffer);
  }
  return buffers;
}

test('a scatter of 50 000 copies: the same buffer with and without workers; no long main-thread task above the bound', async ({ page }) => {
  defaultProjectOnly();
  test.setTimeout(300_000);
  be = await startBackend('workers-scatter', 'beacon-reach', extraEnv());
  await installLongTaskObserver(page);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await settle(page);
  const N = 50_000;
  const prof = await startProfile(page);
  const t0 = await now(page);
  const [digest] = await scatter(page, N, 7);
  // The Scene view builds the set once the buffer is fetched: give it time to draw.
  await page.waitForTimeout(3000);
  const lt = await longTasksSince(page, t0);
  report(`scatter ${N} copies`, lt);
  await prof.stop('scatter');

  // The buffer is stored by content: the same seed scattered inline (?workers=off) gives the same digest.
  if (label === 'after') {
    await page.goto(be.editorUrl.replace('#', '&workers=off#'));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    // Two sets of the same copies and seed now: one scattered in the worker, one inline — one buffer.
    const both = await scatter(page, N, 7, 2);
    expect(both).toEqual([digest, digest]);
  }
  if (!measureOnly) expect(lt.longestMs).toBeLessThan(LONGEST_TASK_BOUND_MS);
});

async function bakeScene(page: Page): Promise<void> {
  const ground = String((await cmd('createEntity', { kind: 'box', name: 'ground', box: { size: [40, 0.5, 40], material: { color: '#b0b0b0' } }, transform: { position: [0, -0.25, 0] } })).createdId);
  await cmd('updateEntity', { entityId: ground, static: true });
  // A 40 m ground (a large lightmap: the CPU-side work grows with its texels) and a row of static boxes.
  for (let i = 0; i < 12; i += 1) {
    const id = String((await cmd('createEntity', { kind: 'box', name: `crate ${i}`, box: { size: [0.8, 1 + (i % 3) * 0.5, 0.8], material: { color: '#b0b0b0' } }, transform: { position: [-5 + (i % 6) * 2, 0.6, i < 6 ? -2 : 2] } })).createdId);
    await cmd('updateEntity', { entityId: id, static: true });
  }
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: false, mode: 'baked' } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6, mode: 'baked' } });
}

async function bakedAtlas(): Promise<string> {
  const config = await query('queryGameConfig');
  const bake = Object.values(config['lighting'] as Record<string, { atlases: string[] }>)[0]!;
  const assets = (await query('queryAssets', { limit: 50, offset: 0 })).assets as { assetId: string; currentVersion: number }[];
  const a = assets.find((x) => x.assetId === bake.atlases[0])!;
  const bytes = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/assets/${a.assetId}/versions/${a.currentVersion}/bytes`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(bytes.status).toBe(200);
  return createHash('sha256').update(Buffer.from(await bytes.arrayBuffer())).digest('hex');
}

test('a preview bake: no long main-thread task above the bound; the lightmap is the same with and without workers', async ({ page }) => {
  defaultProjectOnly();
  test.setTimeout(300_000);
  be = await startBackend('workers-bake', undefined, extraEnv());
  await installLongTaskObserver(page);
  await bakeScene(page);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Lighting' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('No bake for this scene');
  await settle(page);
  const prof = await startProfile(page);
  const t0 = await now(page);
  await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
  await expect(page.locator('[aria-label="bake status"]')).toContainText('Preview (browser) bake', { timeout: 180_000 });
  const lt = await longTasksSince(page, t0);
  await prof.stop('bake');
  const where = await page.getByRole('status').textContent();
  // The bake itself (render, read-back, dilation, encoding) ends at the 'tl:bake:rendered' mark; publishing and the
  // Scene view loading the new lightmap follow.
  const rendered = await page.evaluate(() => performance.getEntriesByName('tl:bake:rendered').at(-1)?.startTime ?? null);
  expect(rendered).not.toBeNull();
  const bakeOnly = await page.evaluate(([since, until]) => {
    const list = (window as unknown as { __tlLong: { start: number; duration: number }[] }).__tlLong.filter((e) => e.start + e.duration >= since! && e.start <= until!);
    return { count: list.length, longestMs: Math.round(list.reduce((m, e) => Math.max(m, e.duration), 0)), totalMs: Math.round(list.reduce((s, e) => s + e.duration, 0)), windowMs: Math.round(until! - since!) };
  }, [t0, rendered]);
  report('preview bake (13 objects, 64 samples), click to baked', bakeOnly, { status: where });
  report('preview bake, click to the Scene view showing it', lt);
  await expect(page.getByRole('status')).toContainText('Baked 13 objects');

  if (label === 'after') {
    // The same bake inline gives the same lightmap bytes (the PNG of the same pixels).
    const worker = await bakedAtlas();
    await page.goto(be.editorUrl.replace('#', '&workers=off#'));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    await page.getByRole('tab', { name: 'Lighting' }).click();
    await page.getByRole('button', { name: 'Bake preview (browser)' }).click();
    await expect(page.getByRole('status')).toContainText('Baked 13 objects', { timeout: 180_000 });
    await expect.poll(async () => bakedAtlas(), { timeout: 30_000 }).not.toBe('');
    const inline = await bakedAtlas();
    console.log(`[editor-workers] worker atlas ${worker.slice(0, 12)} inline atlas ${inline.slice(0, 12)}`);
    expect(inline).toBe(worker);
  }
  if (!measureOnly) expect(bakeOnly.longestMs).toBeLessThan(LONGEST_TASK_BOUND_MS);
});

/** Each model tile's thumbnail PNG (by the tile's name), once every model tile shows one. */
async function thumbnails(page: Page): Promise<Record<string, Buffer>> {
  const models = page.locator('.tl-assets__list li.tl-tile').filter({ hasText: 'model ·' });
  const total = await models.count();
  expect(total).toBeGreaterThan(0);
  await expect.poll(async () => page.locator('.tl-assets__list li.tl-tile img.tl-tile__img--thumb').count(), { timeout: 180_000 }).toBeGreaterThanOrEqual(total);
  const pngs = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const li of document.querySelectorAll('.tl-assets__list li.tl-tile')) {
      const img = li.querySelector('img.tl-tile__img--thumb') as HTMLImageElement | null;
      const name = li.querySelector('.tl-tile__name')?.textContent ?? '';
      if (img === null || !/model ·/.test(li.textContent ?? '')) continue;
      const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      out[name] = btoa(bin);
    }
    return out;
  });
  return Object.fromEntries(Object.entries(pngs).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}

test('asset tile thumbnails render and are the same with and without workers (long tasks logged)', async ({ page }) => {
  test.setTimeout(300_000);
  // WebGL 2 in the default project, WebGPU in the webgpu project (a snapshot of either canvas).
  const variant = test.info().project.name === 'webgpu' ? 'webgpu' : 'auto';
  be = await startBackend('workers-thumbs', 'beacon-reach', extraEnv());
  await installLongTaskObserver(page);
  await page.goto(editorUrlFor(be.editorUrl, variant));
  const prof = await startProfile(page);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  const t0 = await now(page);
  const worker = await thumbnails(page);
  const lt = await longTasksSince(page, t0);
  report(`${Object.keys(worker).length} model thumbnails (from connected, ${variant})`, lt);
  await prof.stop('thumbnails (from navigation)');
  // Observed in pixels: each thumbnail shows the model (opaque pixels on the transparent background).
  for (const [name, png] of Object.entries(worker)) {
    const img = decodePng(png);
    let opaque = 0;
    for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (img.pixel(x, y)[3] > 200) opaque += 1;
    console.log(`[editor-workers] ${label} thumbnail ${name}: ${img.width}x${img.height}, ${opaque} opaque samples of ${(img.width * img.height) / 4}`);
    expect(opaque, name).toBeGreaterThan(50);
  }
  if (label === 'after') {
    // A fresh project (no cached thumbnails) with every job inline: the same PNGs.
    await be.stop();
    be = await startBackend('workers-thumbs-inline', 'beacon-reach');
    await page.goto(editorUrlFor(be.editorUrl, variant).replace('#', '&workers=off#'));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const inline = await thumbnails(page);
    expect(Object.keys(inline).sort()).toEqual(Object.keys(worker).sort());
    for (const k of Object.keys(worker)) expect(inline[k]!.equals(worker[k]!), `thumbnail ${k}`).toBe(true);
  }
});

test('graph diagnostics after an edit of a 2000-node graph (long tasks logged)', async ({ page }) => {
  defaultProjectOnly();
  test.setTimeout(240_000);
  be = await startBackend('workers-graph', undefined, extraEnv());
  await installLongTaskObserver(page);
  await cmd('setGraph', { graph: { graphId: 'big', kind: 'test', name: 'Big', graph: { nodes: [], edges: [] } } });
  const N = 2000;
  const per = 400;
  for (let k = 0; k < N / per; k++) {
    const nodes = Array.from({ length: per }, (_, j) => {
      const i = k * per + j;
      return { id: `n${i}`, type: 'label', position: [(i % 50) * 220, Math.floor(i / 50) * 120] };
    });
    const edges = nodes.map((n) => Number(n.id.slice(1))).filter((i) => i > 0).map((i) => ({ id: `e${i}`, from: { node: `n${i - 1}`, port: 'out' }, to: { node: `n${i}`, port: 'in' } }));
    await cmd('graphEdit', { owner: { kind: 'graph', id: 'big' }, ops: [{ op: 'addNodes', nodes }, { op: 'connect', edges }] });
  }
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Graphs' }).click();
  await expect(page.locator('[data-graph-id="big"]')).toContainText('2000 nodes', { timeout: 30_000 });
  await settle(page);
  const results: LongTasks[] = [];
  const prof = await startProfile(page);
  for (let i = 0; i < 5; i += 1) {
    const t0 = await now(page);
    await cmd('graphEdit', { owner: { kind: 'graph', id: 'big' }, ops: [{ op: 'addNodes', nodes: [{ id: `x${i}`, type: 'label', position: [-300, i * 100] }] }] });
    await expect(page.locator('[data-graph-id="big"]')).toContainText(`${2001 + i} nodes`, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    results.push(await longTasksSince(page, t0));
  }
  const sum = results.reduce((a, r) => ({ count: a.count + r.count, longestMs: Math.max(a.longestMs, r.longestMs), totalMs: a.totalMs + r.totalMs, windowMs: a.windowMs + r.windowMs }), { count: 0, longestMs: 0, totalMs: 0, windowMs: 0 });
  report('graph edit x5 (2000-node graph, Graphs list open, graph tab closed)', sum, { perEdit: results.map((r) => r.totalMs) });
  await prof.stop('graph edit x5');
  // The Problems tab counts the graph's diagnostics: the worker's count, then the same inline.
  const count = page.locator('.tl-tab__count').first();
  await expect(count).toHaveText(/^\d+$/);
  const inWorker = await count.textContent();
  console.log(`[editor-workers] ${label} Problems count ${inWorker}`);
  if (label === 'after') {
    await page.goto(be.editorUrl.replace('#', '&workers=off#'));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    await expect(count).toHaveText(inWorker!, { timeout: 30_000 });
  }
});

test('projection of changes in a project with 3000 objects (long tasks logged)', async ({ page }) => {
  defaultProjectOnly();
  test.setTimeout(300_000);
  be = await startBackend('workers-proj', undefined, extraEnv());
  await installLongTaskObserver(page);
  for (let b = 0; b < 12; b += 1) {
    const entities = Array.from({ length: 250 }, (_, i) => ({ id: `box-${5000 + b * 250 + i}`, name: `Extra ${b * 250 + i}`, components: { transform: { position: [(i % 50) * 0.6, 0, -5 - b - Math.floor(i / 50)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [0.4, 0.4, 0.4], material: { color: '#7a8088' } } } }));
    await cmd('pasteEntities', { entities, sceneId: 'scene-main' });
  }
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  await settle(page);
  const listed = ((await query('queryEntities', { limit: 50, offset: 0 })).entities as { entityId?: string; id?: string; name?: string }[] | undefined) ?? [];
  const pick = listed.filter((e) => (e.name ?? '').startsWith('Extra')).map((e) => String(e.entityId ?? e.id)).slice(0, 5);
  expect(pick).toHaveLength(5);
  const results: LongTasks[] = [];
  const prof = await startProfile(page);
  for (let i = 0; i < 5; i += 1) {
    const t0 = await now(page);
    await cmd('setTransform', { entityId: pick[i]!, transform: { position: [i, 2, 0] } });
    await page.waitForTimeout(1500);
    results.push(await longTasksSince(page, t0));
  }
  const sum = results.reduce((a, r) => ({ count: a.count + r.count, longestMs: Math.max(a.longestMs, r.longestMs), totalMs: a.totalMs + r.totalMs, windowMs: a.windowMs + r.windowMs }), { count: 0, longestMs: 0, totalMs: 0, windowMs: 0 });
  report('setTransform x5 (3000 objects)', sum, { perChange: results.map((r) => r.totalMs) });
  await prof.stop('setTransform x5');
});
