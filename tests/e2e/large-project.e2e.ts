/**
 * Phase 21.4: the editor with a large project, against the real backend.
 *
 * - Play of a project whose runtime snapshot exceeds the 1 MiB WebSocket
 *   frame bound starts: `play.started` carries a reference, the editor
 *   fetches the snapshot from the play's snapshot route over HTTP and hands
 *   it to the preview, and the game runs. No frame over the bound is sent.
 * - The Hierarchy with a few thousand entities is windowed: only the rows in
 *   view are in the DOM, and it scrolls, selects and renames promptly.
 *
 * The project is the harness's generated neutral benchmark (tools/perf), not
 * the demo.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { buildBenchmark } from '../../tools/perf/build';
import { generate } from '../../tools/perf/generate';

const WS_OUT_FRAME_MAX = 1024 * 1024;

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `large-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined as T);
    if (v !== undefined && ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** More plain boxes (neutral, named "Extra N"), in pastes under the request cap. */
async function addBoxes(backend: PerfBackend, sceneId: string, count: number): Promise<void> {
  const p = backend.project('bench');
  for (let b = 0; b * 250 < count; b += 1) {
    const entities = Array.from({ length: Math.min(250, count - b * 250) }, (_, i) => ({ id: `box-${4000 + b * 250 + i}`, name: `Extra ${b * 250 + i}`, components: { transform: { position: [i * 0.5, 0, -20 - b], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [0.4, 0.4, 0.4], material: { color: '#7a8088' } } } }));
    await p.command('pasteEntities', { entities, sceneId });
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(`${be.origin}/?project=bench#token=${be.token}`);
  await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 120_000 });
}

test('Play of a project whose snapshot exceeds the 1 MiB frame bound starts (the snapshot goes by reference)', async ({ page }) => {
  test.setTimeout(420_000);
  const plan = generate('medium');
  await buildBenchmark(be, plan, 'bench');
  await addBoxes(be, plan.scenes[0]!.sceneId, 5000);
  const frames: { type: string; bytes: number; payload: string }[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const payload = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
      const type = /^\{"type":"([^"]+)"/.exec(payload)?.[1] ?? 'other';
      frames.push({ type, bytes: Buffer.byteLength(payload), payload: type === 'play.started' || payload.length < 4096 ? payload : '' });
    });
  });
  await openEditor(page);
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 120_000 });
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);

  // The play.started message carried a reference, not the snapshot, and fit one frame.
  const msg = await poll(async () => frames.find((f) => f.type === 'play.started'), (f) => f !== undefined, 60_000, 'play.started');
  const body = JSON.parse(msg!.payload) as { snapshot?: unknown; snapshotRef?: { path: string; bytes: number } };
  console.log(`play.started: ${msg!.bytes} bytes on the socket; snapshot ${body.snapshotRef !== undefined ? `by reference, ${body.snapshotRef.bytes} bytes` : 'inline'}`);
  expect(body.snapshot).toBeUndefined();
  expect(body.snapshotRef?.path).toBe(`/api/v1/projects/bench/play/${psid}/snapshot`);
  expect(body.snapshotRef!.bytes).toBeGreaterThan(WS_OUT_FRAME_MAX);
  // The route serves it (owner token) — the same bytes the editor handed to the preview.
  const snap = await be.get(body.snapshotRef!.path);
  expect(snap.status).toBe(200);
  expect(snap.body.length).toBe(body.snapshotRef!.bytes);
  expect((JSON.parse(snap.body.toString('utf8')) as { snapshotId: string }).snapshotId).toMatch(/^bench@r\d+$/);
  expect((await fetch(`${be.origin}${body.snapshotRef!.path}`)).status).toBe(401);

  // The preview loads and the game runs.
  const relay = async (path: string, b: unknown = {}) => be.post(`/api/v1/projects/bench/play/${psid}/${path}`, b);
  await poll(async () => (await relay('observe')).json['state'], (s) => s === 'awaitingStart' || s === 'playing', 300_000, 'the play preview');
  await relay('control', { command: 'start' });
  await poll(async () => (await relay('observe')).json['state'], (s) => s === 'playing', 60_000, 'playing');
  const frame = page.frames().find((f) => f.url().startsWith(be.previewOrigin));
  expect(frame).toBeDefined();
  // No error was shown and nothing over the frame bound crossed the socket.
  await expect(page.locator('.tl-statusbar')).not.toContainText('play_snapshot_unavailable');
  for (const f of frames) expect(f.bytes, f.type).toBeLessThanOrEqual(WS_OUT_FRAME_MAX);
  await page.getByTitle('Stop the play preview').click();
});

test('the Hierarchy with a few thousand entities is windowed and scrolls, selects and renames promptly', async ({ page }) => {
  test.setTimeout(420_000);
  const plan = generate('medium');
  await buildBenchmark(be, plan, 'bench');
  const p = be.project('bench');
  await addBoxes(be, plan.scenes[0]!.sceneId, 1000);
  const total = Number(((await p.query('queryProject'))['scenes'] as { entityCount: number }[]).reduce((a, s) => a + s.entityCount, 0));
  expect(total).toBe(3000);

  await openEditor(page);
  const list = page.locator('ul.tl-hierarchy__list');
  await expect(list).toHaveClass(/is-windowed/, { timeout: 60_000 });
  await expect(list).toHaveAttribute('data-rows', '3000');
  const domRows = await list.locator('li[data-entity-id]').count();
  expect(domRows).toBeGreaterThan(10);
  expect(domRows).toBeLessThan(300);

  // Scroll to the end: the last rows are rendered (the list is as tall as all rows).
  const t0 = Date.now();
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // (Pasted entities get backend ids: rows are found by name.)
  const row = (name: string) => list.locator('li[data-entity-id]').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('Extra 999')).toBeVisible({ timeout: 10_000 });
  const scrollMs = Date.now() - t0;
  expect(await list.locator('li[data-entity-id]').count()).toBeLessThan(300);

  // Select a row there: the Inspector shows it.
  const id = (await row('Extra 990').getAttribute('data-entity-id'))!;
  const byId = list.locator(`li[data-entity-id="${id}"]`);
  const t1 = Date.now();
  await byId.click();
  await expect(byId).toHaveClass(/is-selected/);
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Extra 990', { timeout: 10_000 });
  const selectMs = Date.now() - t1;

  // Rename it in the Hierarchy: the backend stores it and the row shows it.
  const t2 = Date.now();
  await byId.locator('.tl-row__name').dblclick();
  const field = byId.locator('input.tl-row__rename');
  await field.fill('Renamed far down');
  await field.press('Enter');
  await expect(byId.locator('.tl-row__name')).toHaveText('Renamed far down', { timeout: 15_000 });
  const renameMs = Date.now() - t2;
  await poll(async () => ((await p.query('queryEntity', { entityId: id }))['entity'] as { name: string }).name, (n) => n === 'Renamed far down', 15_000, 'the stored name');

  // Back to the top, and a filter finds the renamed row again.
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(byId).toHaveCount(0);
  await page.locator('.tl-hierarchy__filter').fill('Renamed far');
  await expect(byId).toBeVisible({ timeout: 10_000 });
  await expect(list).not.toHaveClass(/is-windowed/);
  await page.locator('.tl-hierarchy__filter').fill('');
  await expect(list).toHaveClass(/is-windowed/);

  // Responsive on this shared CPU-rendered host: generous bounds, the times are logged.
  console.log(`hierarchy 3000 entities: ${domRows} rows in the DOM, scroll-to-end ${scrollMs} ms, select ${selectMs} ms, rename ${renameMs} ms`);
  expect(selectMs).toBeLessThan(10_000);
  expect(renameMs).toBeLessThan(15_000);
});
